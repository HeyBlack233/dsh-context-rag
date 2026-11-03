/**
 * OpenAI-compatible rerank client for `dsh-context-rag`.
 *
 * Like the embeddings client, it reads configuration through a `getConfig()`
 * callback on every call and targets any OpenAI-compatible rerank endpoint
 * (Jina / Cohere / SiliconFlow style `relevance_score` payloads are accepted,
 * with a `score` fallback) using the global `fetch`.
 *
 * @module rerank
 */

import { HttpError, joinUrl, requestJson } from "./http.js";

/**
 * Error thrown by the rerank client. Carries a stable `code`, an optional HTTP
 * `status`, and a `details` object mirroring the underlying transport failure.
 */
export class RerankError extends Error {
  /**
   * @param {string} code - Stable error code (e.g. `RERANK_NOT_CONFIGURED`,
   *   `RERANK_REQUEST_FAILED`, `RERANK_ABORTED`, `INVALID_RERANK_RESPONSE`,
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
    this.name = "RerankError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

/**
 * Wrap a transport `HttpError` into a `RerankError`, preserving status and
 * details. Caller aborts keep a dedicated stable code.
 *
 * @param {unknown} err
 * @returns {RerankError}
 */
function mapTransportError(err) {
  if (err instanceof HttpError) {
    if (err.code === "ABORTED") {
      return new RerankError(
        "RERANK_ABORTED",
        err.message,
        { retryable: false, details: err.details },
      );
    }
    return new RerankError(
      "RERANK_REQUEST_FAILED",
      err.message,
      { status: err.status, retryable: err.retryable, details: err.details },
    );
  }
  return new RerankError(
    "RERANK_REQUEST_FAILED",
    err?.message ?? String(err),
    { retryable: true },
  );
}

/**
 * Pick the score for one rerank result entry: `relevance_score` when finite,
 * else `score` when finite, else null (entry is malformed).
 *
 * @param {object} item
 * @returns {number|null}
 */
function pickScore(item) {
  if (Number.isFinite(item.relevance_score)) {
    return item.relevance_score;
  }
  if (Number.isFinite(item.score)) {
    return item.score;
  }
  return null;
}

/**
 * Validate a rerank response body and produce ordered, bounded results.
 *
 * Malformed entries (non-integer or out-of-bounds `index`, non-finite score)
 * are skipped rather than failing the whole call — as long as at least one
 * valid entry remains. If none are valid, `INVALID_RERANK_RESPONSE` is thrown.
 *
 * @param {*} data - Parsed JSON response body.
 * @param {string[]} documents - The documents sent in the request; bounds for
 *   `index` and source for the returned `document` field.
 * @param {number} topN - Maximum number of results to keep.
 * @returns {Array<{index: number, document: string, score: number}>} Sorted by
 *   score descending, at most `topN` entries.
 * @throws {RerankError} Code `INVALID_RERANK_RESPONSE` when `results` is
 *   missing or contains no valid entry.
 */
function parseResults(data, documents, topN) {
  const items = data && Array.isArray(data.results) ? data.results : null;
  if (!items) {
    throw new RerankError(
      "INVALID_RERANK_RESPONSE",
      "Rerank response is missing a results array",
      { retryable: false },
    );
  }
  const valid = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const { index } = item;
    if (!Number.isInteger(index) || index < 0 || index >= documents.length) {
      continue;
    }
    const score = pickScore(item);
    if (score === null) {
      continue;
    }
    valid.push({ index, document: documents[index], score });
  }
  if (valid.length === 0) {
    throw new RerankError(
      "INVALID_RERANK_RESPONSE",
      "Rerank response contains no valid results",
      { retryable: false },
    );
  }
  valid.sort((a, b) => b.score - a.score);
  return valid.slice(0, topN);
}

/**
 * Create a rerank client.
 *
 * @param {object} [options]
 * @param {() => object} [options.getConfig] - Callback returning the plugin
 *   config object with `rerank` and `embedding` sections. Reads happen on
 *   every call.
 * @param {{warn?: (message: string) => void}} [options.logger] - Optional
 *   logger forwarded to the HTTP layer for retry notices.
 * @returns {{rerank: Function, testConnection: Function}} The client with
 *   `rerank` and `testConnection` methods.
 */
export function createRerankClient({ getConfig, logger } = {}) {
  const readConfig = typeof getConfig === "function" ? getConfig : () => ({});

  /**
   * Rerank documents against a query.
   *
   * Reads config through `getConfig()` on every call. The effective base URL
   * is `rerank.baseUrl` falling back to `embedding.baseUrl`; the effective API
   * key is `rerank.apiKey` falling back to `embedding.apiKey`. The request
   * body is `{ model, query, documents, top_n }` sent to
   * `joinUrl(base, rerank.path || "/rerank")`.
   *
   * @param {object} [params]
   * @param {string} params.query - Non-empty query string.
   * @param {string[]} params.documents - Documents to rerank.
   * @param {number} [params.topN] - Max results to return; defaults to the
   *   number of documents.
   * @param {AbortSignal} [params.signal] - Caller abort signal.
   * @returns {Promise<{results: Array<{index: number, document: string, score: number}>, model: string}>}
   *   Results sorted by score descending, at most `topN`.
   * @throws {RerankError}
   */
  async function rerank({ query, documents, topN, signal } = {}) {
    if (typeof query !== "string" || query.length === 0) {
      throw new RerankError(
        "INVALID_INPUT",
        "query must be a non-empty string",
        { retryable: false },
      );
    }
    if (!Array.isArray(documents) || documents.some((d) => typeof d !== "string")) {
      throw new RerankError(
        "INVALID_INPUT",
        "documents must be an array of strings",
        { retryable: false },
      );
    }

    const cfg = readConfig().rerank ?? {};
    const embeddingCfg = readConfig().embedding ?? {};
    const base = cfg.baseUrl || embeddingCfg.baseUrl || "";
    const apiKey = cfg.apiKey || embeddingCfg.apiKey || "";
    const model = cfg.model || "";

    if (documents.length === 0) {
      return { results: [], model };
    }

    const problems = [];
    if (cfg.enabled === false) {
      problems.push("enabled is false");
    }
    if (!model) {
      problems.push("model is empty");
    }
    if (!base) {
      problems.push("baseUrl is empty");
    }
    if (problems.length > 0) {
      throw new RerankError(
        "RERANK_NOT_CONFIGURED",
        `Rerank is not configured: ${problems.join("; ")}`,
        { retryable: false, details: { problems } },
      );
    }

    const url = joinUrl(base, cfg.path || "/rerank");
    const headers = {};
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    const topNValue = Number.isInteger(topN) && topN > 0 ? topN : documents.length;
    const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
      ? cfg.timeoutMs
      : 5000;
    const maxRetries = Number.isInteger(cfg.maxRetries) && cfg.maxRetries >= 0
      ? cfg.maxRetries
      : 1;

    let response;
    try {
      response = await requestJson(url, {
        method: "POST",
        headers,
        body: { model, query, documents, top_n: topNValue },
        signal,
        timeoutMs,
        maxRetries,
        logger,
      });
    } catch (err) {
      throw mapTransportError(err);
    }

    return {
      results: parseResults(response.data, documents, topNValue),
      model,
    };
  }

  /**
   * Verify that the rerank endpoint is reachable and returns usable results.
   *
   * @returns {Promise<{ok: true, model: string, topScore: number, latencyMs: number}>}
   * @throws {RerankError} On any configuration, transport, or response
   *   failure, including a response with no valid results.
   */
  async function testConnection() {
    const startedAt = Date.now();
    const { results, model } = await rerank({
      query: "dsh-context-rag rerank connection test",
      documents: ["first candidate", "second candidate"],
      topN: 2,
    });
    if (results.length === 0) {
      throw new RerankError(
        "RERANK_NO_RESULTS",
        "Rerank connection test returned no results",
        { retryable: false },
      );
    }
    return {
      ok: true,
      model,
      topScore: results[0].score,
      latencyMs: Date.now() - startedAt,
    };
  }

  return { rerank, testConnection };
}
