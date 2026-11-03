/**
 * OpenAI-compatible embeddings client for `dsh-context-rag`.
 *
 * The client reads its configuration through a `getConfig()` callback on
 * every call (so unit tests can feed fake config objects and nothing here
 * imports the plugin's own config module) and speaks to any OpenAI-compatible
 * `/embeddings` endpoint using the global `fetch`.
 *
 * @module embeddings
 */

import { HttpError, joinUrl, requestJson } from "./http.js";

/**
 * Error thrown by the embeddings client. Carries a stable `code`, an optional
 * HTTP `status`, and a `details` object mirroring the underlying transport
 * failure.
 */
export class EmbeddingError extends Error {
  /**
   * @param {string} code - Stable error code (e.g. `EMBEDDING_NOT_CONFIGURED`,
   *   `EMBEDDING_REQUEST_FAILED`, `EMBEDDING_ABORTED`, `INVALID_EMBEDDING`,
   *   `INVALID_INPUT`).
   * @param {string} message - Human readable description.
   * @param {object} [options]
   * @param {number|null} [options.status] - HTTP status when the failure came
   *   from an HTTP response.
   * @param {boolean} [options.retryable] - Whether retrying may succeed.
   * @param {object|null} [options.details] - Extra structured context.
   */
  constructor(code, message, { status = null, retryable = false, details = null } = {}) {
    super(message);
    this.name = "EmbeddingError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

/**
 * Wrap a transport `HttpError` into an `EmbeddingError`, preserving status and
 * details. Caller aborts keep a dedicated stable code so callers can tell
 * cancellation apart from failures.
 *
 * @param {unknown} err
 * @returns {EmbeddingError}
 */
function mapTransportError(err) {
  if (err instanceof HttpError) {
    if (err.code === "ABORTED") {
      return new EmbeddingError(
        "EMBEDDING_ABORTED",
        err.message,
        { retryable: false, details: err.details },
      );
    }
    return new EmbeddingError(
      "EMBEDDING_REQUEST_FAILED",
      err.message,
      { status: err.status, retryable: err.retryable, details: err.details },
    );
  }
  return new EmbeddingError(
    "EMBEDDING_REQUEST_FAILED",
    err?.message ?? String(err),
    { retryable: true },
  );
}

/**
 * L2-normalize a vector. A zero-norm (all-zero) vector cannot be normalized
 * and is rejected with `INVALID_EMBEDDING`.
 *
 * @param {number[]} vector
 * @returns {number[]} Normalized copy of `vector`.
 * @throws {EmbeddingError} When the vector norm is zero or not finite.
 */
function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingError(
      "INVALID_EMBEDDING",
      "Embedding vector has zero norm and cannot be normalized",
      { retryable: false },
    );
  }
  return vector.map((x) => x / norm);
}

/**
 * Validate and extract embeddings from one `/embeddings` response body.
 *
 * Enforces: a `data` array whose length matches the request batch; every item
 * carrying a finite-number `embedding` array; one shared dimension across the
 * whole call; and, when configured, the configured dimension.
 *
 * @param {*} data - Parsed JSON response body.
 * @param {number} expectedCount - Number of inputs in the batch.
 * @param {number|null} configuredDimensions - `embedding.dimensions` if set.
 * @param {number|null} priorDimension - Dimension seen in an earlier batch, or
 *   null for the first batch.
 * @returns {{vectors: number[][], dimension: number}}
 * @throws {EmbeddingError} Code `INVALID_EMBEDDING` on any violation.
 */
function parseEmbeddings(data, expectedCount, configuredDimensions, priorDimension) {
  const items = data && Array.isArray(data.data) ? data.data : null;
  if (!items) {
    throw new EmbeddingError(
      "INVALID_EMBEDDING",
      "Embedding response is missing a data array",
      { retryable: false },
    );
  }
  if (items.length !== expectedCount) {
    throw new EmbeddingError(
      "INVALID_EMBEDDING",
      `Expected ${expectedCount} embeddings, got ${items.length}`,
      { retryable: false },
    );
  }
  const vectors = [];
  for (const item of items) {
    if (!item || !Array.isArray(item.embedding) || !item.embedding.every((n) => Number.isFinite(n))) {
      throw new EmbeddingError(
        "INVALID_EMBEDDING",
        "Embedding response contains an invalid embedding vector",
        { retryable: false },
      );
    }
    vectors.push(item.embedding.map((n) => Number(n)));
  }
  const dimension = vectors[0].length;
  if (vectors.some((v) => v.length !== dimension)) {
    throw new EmbeddingError(
      "INVALID_EMBEDDING",
      "Embedding vectors in one response do not share a common dimension",
      { retryable: false },
    );
  }
  if (priorDimension !== null && dimension !== priorDimension) {
    throw new EmbeddingError(
      "INVALID_EMBEDDING",
      `Embedding dimension changed between batches (${priorDimension} -> ${dimension})`,
      { retryable: false },
    );
  }
  if (configuredDimensions !== null && dimension !== configuredDimensions) {
    throw new EmbeddingError(
      "INVALID_EMBEDDING",
      `Embedding dimension ${dimension} does not match configured dimensions ${configuredDimensions}`,
      { retryable: false },
    );
  }
  return { vectors, dimension };
}

/**
 * Validate the `texts` argument accepted by `embed`.
 *
 * @param {unknown} texts
 * @throws {EmbeddingError} Code `INVALID_INPUT` when `texts` is not a nonempty
 *   array of strings.
 */
function validateInput(texts) {
  if (!Array.isArray(texts) || texts.length === 0 || texts.some((t) => typeof t !== "string")) {
    throw new EmbeddingError(
      "INVALID_INPUT",
      "texts must be a non-empty array of strings",
      { retryable: false },
    );
  }
}

/**
 * Validate the embedding config and throw `EMBEDDING_NOT_CONFIGURED` without
 * any network activity when embedding is disabled or incomplete.
 *
 * @param {object} cfg - `embedding` section of the config object.
 * @throws {EmbeddingError} Code `EMBEDDING_NOT_CONFIGURED`.
 */
function assertConfigured(cfg) {
  const problems = [];
  if (cfg.enabled === false) {
    problems.push("enabled is false");
  }
  if (!cfg.model) {
    problems.push("model is empty");
  }
  if (!cfg.baseUrl) {
    problems.push("baseUrl is empty");
  }
  if (problems.length > 0) {
    throw new EmbeddingError(
      "EMBEDDING_NOT_CONFIGURED",
      `Embedding is not configured: ${problems.join("; ")}`,
      { retryable: false, details: { problems } },
    );
  }
}

/**
 * Create an embeddings client.
 *
 * @param {object} [options]
 * @param {() => object} [options.getConfig] - Callback returning the plugin
 *   config object with an `embedding` section. Reads happen on every call.
 * @param {{warn?: (message: string) => void}} [options.logger] - Optional
 *   logger forwarded to the HTTP layer for retry notices.
 * @returns {{embed: Function, embedOne: Function, testConnection: Function}}
 *   The client with `embed`, `embedOne`, and `testConnection` methods.
 */
export function createEmbeddingClient({ getConfig, logger } = {}) {
  const readConfig = typeof getConfig === "function" ? getConfig : () => ({});

  /**
   * Embed an array of texts.
   *
   * Reads config through `getConfig()` on every call. Text is batched by
   * `embedding.batchSize` (inputs preserved in order), each batch sent as
   * `{ model, input, encoding_format: "float" }` plus `dimensions` when
   * configured. Every returned vector is L2-normalized; a zero vector, a
   * dimension mismatch, or a malformed response raises `INVALID_EMBEDDING`.
   *
   * @param {string[]} texts - Non-empty array of strings to embed.
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] - Caller abort signal.
   * @returns {Promise<{vectors: number[][], model: string, dimension: number}>}
   *   Normalized vectors (input order), the model name, and the shared
   *   vector dimension.
   * @throws {EmbeddingError}
   */
  async function embed(texts, { signal } = {}) {
    validateInput(texts);
    const cfg = readConfig().embedding ?? {};
    assertConfigured(cfg);

    const base = String(cfg.baseUrl).replace(/\/+$/, "");
    const url = /\/embeddings$/i.test(base)
      ? base
      : joinUrl(cfg.baseUrl, "embeddings");
    const headers = {};
    if (cfg.apiKey) {
      headers.authorization = `Bearer ${cfg.apiKey}`;
    }
    const batchSize = Number.isInteger(cfg.batchSize) && cfg.batchSize > 0
      ? cfg.batchSize
      : 16;
    const dimensions = Number.isFinite(cfg.dimensions) && cfg.dimensions > 0
      ? cfg.dimensions
      : null;
    const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
      ? cfg.timeoutMs
      : 3000;
    const maxRetries = Number.isInteger(cfg.maxRetries) && cfg.maxRetries >= 0
      ? cfg.maxRetries
      : 2;

    const vectors = [];
    let priorDimension = null;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const body = { model: cfg.model, input: batch, encoding_format: "float" };
      if (dimensions !== null) {
        body.dimensions = dimensions;
      }
      let response;
      try {
        response = await requestJson(url, {
          method: "POST",
          headers,
          body,
          signal,
          timeoutMs,
          maxRetries,
          logger,
        });
      } catch (err) {
        throw mapTransportError(err);
      }
      const parsed = parseEmbeddings(response.data, batch.length, dimensions, priorDimension);
      priorDimension = parsed.dimension;
      for (const vector of parsed.vectors) {
        vectors.push(normalizeVector(vector));
      }
    }
    return {
      vectors,
      model: cfg.model,
      dimension: vectors.length > 0 ? vectors[0].length : 0,
    };
  }

  /**
   * Embed a single text string; convenience wrapper over `embed`.
   *
   * @param {string} text - Non-empty string to embed.
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] - Caller abort signal.
   * @returns {Promise<{vector: number[], model: string, dimension: number}>}
   *   The normalized first vector plus model and dimension metadata.
   * @throws {EmbeddingError}
   */
  async function embedOne(text, { signal } = {}) {
    if (typeof text !== "string" || text.length === 0) {
      throw new EmbeddingError(
        "INVALID_INPUT",
        "text must be a non-empty string",
        { retryable: false },
      );
    }
    const { vectors, model, dimension } = await embed([text], { signal });
    return { vector: vectors[0], model, dimension };
  }

  /**
   * Verify that the embedding endpoint is reachable and returns usable
   * vectors.
   *
   * @returns {Promise<{ok: true, model: string, dimension: number, latencyMs: number}>}
   * @throws {EmbeddingError} On any configuration or transport failure.
   */
  async function testConnection() {
    const startedAt = Date.now();
    const { model, dimension } = await embed(
      ["dsh-context-rag embedding connection test"],
    );
    return {
      ok: true,
      model,
      dimension,
      latencyMs: Date.now() - startedAt,
    };
  }

  return { embed, embedOne, testConnection };
}
