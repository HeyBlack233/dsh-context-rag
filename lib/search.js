/**
 * Manual search service for `dsh-context-rag`.
 *
 * `createSearchService` exposes a reusable search engine that runs the same
 * cosine + optional rerank pipeline as retrieval against an arbitrary query
 * over a caller-chosen scope and kind set. Unlike `retrieve()`, it does not
 * swallow errors: callers (the Browse API, and later an agent tool) need
 * failures surfaced with stable codes so they can render them.
 *
 * @module search
 */

import { rankCandidates } from "./ranking.js";

/**
 * Normalize a caller-provided scope into the canonical `db.searchCandidates`
 * shape. A bare type string is wrapped; an object is passed through (the
 * database validates it); anything missing defaults to `{type: "all"}`.
 *
 * @param {unknown} scope - `{type, cwd?}` object, a type string, or `undefined`.
 * @returns {{type: string, cwd?: string}} Canonical scope.
 */
function canonicalScope(scope) {
  if (typeof scope === "string") return { type: scope };
  if (scope !== null && typeof scope === "object") return scope;
  return { type: "all" };
}

/**
 * Build an error carrying a stable code and HTTP status.
 *
 * @param {string} code - Stable error code.
 * @param {number} status - HTTP status.
 * @param {string} message - Human readable description (never query text).
 * @returns {Error} The error, with `code` and `status` attached.
 */
function codedError(code, status, message) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/**
 * Create a manual search service.
 *
 * @param {object} deps
 * @param {object} deps.db - Candidate index exposing
 *   `searchCandidates({scope,kinds,model,dim,limit})`.
 * @param {{get:Function}} deps.configStore - Config store exposing `.get()`.
 * @param {{embed:Function}} deps.embeddings - Embedding client with
 *   `.embed(texts,{signal})`.
 * @param {{rerank:Function}|null} [deps.reranker] - Optional rerank client.
 * @param {object} [deps.logger] - Logger with `debug`/`warn`; defaults to
 *   `console`.
 * @returns {{search: Function}} The service with a `search` method.
 */
export function createSearchService({ db, configStore, embeddings, reranker, logger = console }) {
  /**
   * Run the cosine + optional rerank pipeline for one query.
   *
   * The query is embedded with the configured embeddings client, candidates
   * are pulled through `db.searchCandidates`, and the shared
   * `rankCandidates` stage scores, filters, reranks (when enabled), and
   * slices to `limit`. Errors propagate to the caller; the query text never
   * appears in log lines or error messages.
   *
   * @param {object} [options]
   * @param {string} options.query - The query text.
   * @param {{type: "all"|"global"|"workspace", cwd?: string}} [options.scope] -
   *   Canonical scope; defaults to `{type: "all"}`.
   * @param {Array<"memory"|"pair">} [options.kinds] - Kinds to search;
   *   defaults to `["memory", "pair"]`.
   * @param {number} [options.limit] - Maximum results; defaults to 20, capped
   *   at 50.
   * @param {AbortSignal} [options.signal] - Caller abort signal, combined with
   *   a retrieval timeout.
   * @returns {Promise<{query: string, results: Array<object>, stats: object}>}
   *   The trimmed query, ranked results, and search stats.
   * @throws {Error} Code `INVALID_INPUT` (`status` 400) for an empty query;
   *   code `EMBEDDING_NOT_CONFIGURED` (`status` 409) when embedding is
   *   disabled or not configured; otherwise the embedding/rerank/db failure
   *   is propagated as-is.
   */
  async function search({ query, scope, kinds, limit, signal } = {}) {
    const started = Date.now();
    const config = configStore.get();

    const trimmed = String(query ?? "").trim();
    if (!trimmed) {
      throw codedError("INVALID_INPUT", 400, "query must be a non-empty string");
    }

    const embeddingCfg = config.embedding ?? {};
    const problems = [];
    if (embeddingCfg.enabled === false) {
      problems.push("enabled is false");
    }
    if (!embeddingCfg.model) {
      problems.push("model is empty");
    }
    if (!embeddingCfg.baseUrl) {
      problems.push("baseUrl is empty");
    }
    if (problems.length > 0) {
      throw codedError(
        "EMBEDDING_NOT_CONFIGURED",
        409,
        `Embedding is not configured: ${problems.join("; ")}`,
      );
    }

    const timeoutMs = config.retrieval?.timeoutMs ?? 5000;
    const signals = [];
    if (signal) {
      signals.push(signal);
    }
    signals.push(AbortSignal.timeout(timeoutMs));
    const combined = AbortSignal.any(signals);

    let embedResult;
    try {
      embedResult = await embeddings.embed([trimmed], { signal: combined });
    } catch (err) {
      // A client-side configuration/disabled failure must still surface as a
      // 409 so the API layer can render it; other errors pass through as-is.
      if (
        err &&
        err.code === "EMBEDDING_NOT_CONFIGURED" &&
        (err.status === null || err.status === undefined)
      ) {
        err.status = 409;
      }
      throw err;
    }

    const queryVector = embedResult.vectors[0];
    const embedModel = embedResult.model;
    const dim = embeddingCfg.dimensions || queryVector.length;
    const model = embeddingCfg.model;
    const scanLimit = config.retrieval?.scanLimit ?? 100;
    const scopeObj = canonicalScope(scope);
    const kindsArray = kinds === undefined ? ["memory", "pair"] : kinds;
    const finalLimit = Math.max(1, Math.min(limit ?? 20, 50));

    const dbCandidates = await db.searchCandidates({
      scope: scopeObj,
      kinds: kindsArray,
      model,
      dim,
      limit: scanLimit,
    });
    const candidateCount = (dbCandidates ?? []).length;

    const cosineMinScore = config.retrieval?.minScore ?? 0;
    const rerankMinScore = config.retrieval?.rerankMinScore ?? cosineMinScore;
    const rerankEnabled = config.rerank?.enabled === true;

    const ranked = await rankCandidates({
      query: trimmed,
      queryVector,
      candidates: dbCandidates ?? [],
      cosineMinScore,
      rerankEnabled,
      reranker: reranker ?? null,
      rerankTopN: finalLimit,
      rerankMinScore,
      finalLimit,
      signal: combined,
      logger,
    });

    const latencyMs = Date.now() - started;
    logger?.debug?.(
      `[context-rag] search: ${candidateCount} candidates, kinds ${kindsArray.join("+")}, rerank ${ranked.reranked ? "on" : "off"}, returned ${ranked.top.length} (${latencyMs}ms)`,
    );

    return {
      query: trimmed,
      results: ranked.top,
      stats: {
        scope: scopeObj,
        kinds: kindsArray,
        model: embedModel || model,
        dim,
        candidateCount,
        returned: ranked.top.length,
        reranked: ranked.reranked,
        rerankError: ranked.rerankError,
        latencyMs,
      },
    };
  }

  return { search };
}
