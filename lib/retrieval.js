/**
 * Retrieval for `dsh-context-rag`: embedding the query, pulling candidates
 * (conversation pairs and memories) from the vector store, scoring by cosine
 * similarity, and optionally reranking.
 *
 * `createRetriever` wires together the embeddings client, the candidate index,
 * and an optional reranker. It never throws to the caller; every failure is
 * recorded in status and returned as an empty result.
 *
 * @module retrieval
 */

import { rankCandidates } from "./ranking.js";

/**
 * Create a retriever.
 *
 * @param {object} deps
 * @param {object} deps.db - Candidate index exposing
 *   `candidates({scope,cwd,model,dim,limit,excludeSessionId})` and optionally
 *   `countCandidates({scope,cwd,model,dim,sessionId})`.
 * @param {{get:Function}} deps.configStore - Config store exposing `.get()`.
 * @param {{embed:Function}} deps.embeddings - Embedding client with `.embed(texts,{signal})`.
 * @param {{rerank:Function}|null} [deps.reranker] - Optional rerank client.
 * @param {object} [deps.recallState] - Optional recall-state store exposing
 *   `isEligible({sessionId,pairId,turn,gap})` for injection-mode turn dedupe.
 * @param {object} [deps.logger] - Logger with `warn`/`error` (and optionally
 *   `debug`, used to trace completed retrievals).
 * @returns {{retrieve:Function, status:Function}} The retriever.
 */
export function createRetriever({ db, configStore, embeddings, reranker, recallState, logger = console }) {
  let lastRetrieval = null;
  let lastError = null;

  /**
   * @returns {{lastRetrieval:object|null, lastError:string|null}} Status snapshot.
   */
  function status() {
    return {
      lastRetrieval: lastRetrieval ? { ...lastRetrieval } : null,
      lastError,
    };
  }

  /**
   * Retrieve related past turns and memories for a query.
   *
   * The candidate pool mixes conversation pairs and memories (the database
   * applies the scope/session filters); scoring, `minScore`, `candidateLimit`
   * (`top N` fed to the reranker), rerank, and `topK` apply uniformly to both
   * kinds. When `sessionId` is provided and `retrieval.allowSameSession` is
   * not enabled, candidates from that exact session are excluded up front —
   * that exclusion covers conversations only, since memories are
   * session-less. In injection mode, candidates previously injected into the
   * session within `retrieval.dedupeTurns` turns are filtered out before
   * scoring, keyed by `pairId` for pairs and memories alike.
   *
   * @param {object} options
   * @param {string} options.query - The query text.
   * @param {string} [options.cwd] - Current workspace path.
   * @param {AbortSignal} [options.signal] - Caller signal.
   * @param {string} [options.sessionId] - Current session id (used by the
   *   same-session and turn-dedupe filters).
   * @param {number} [options.turn] - Current session turn (integer >= 0) for
   *   injection-mode turn dedupe.
   * @param {string} [options.mode] - Recall mode; `"injection"` enables turn
   *   dedupe.
   * @returns {Promise<{pairs:Array<object>,stats:object}>} Pairs and stats.
   */
  async function retrieve({ query, cwd = "", signal, sessionId = "", turn = null, mode = "" } = {}) {
    const started = Date.now();
    const config = configStore.get();

    if (!config.enabled || !config.retrieval?.injectionEnabled) {
      return { pairs: [], stats: { skipped: "disabled" } };
    }

    const trimmed = String(query ?? "").trim();
    if (!trimmed) {
      return { pairs: [], stats: { skipped: "empty-query" } };
    }

    const model = config.embedding?.model;
    const baseUrl = config.embedding?.baseUrl;
    if (!model || !baseUrl) {
      return { pairs: [], stats: { skipped: "not-configured" } };
    }

    const timeoutMs = config.retrieval?.timeoutMs ?? 5000;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) {
      signals.unshift(signal);
    }
    const combined = AbortSignal.any(signals);

    try {
      const { vectors, model: embedModel, dimension } = await embeddings.embed(
        [trimmed],
        { signal: combined },
      );
      const queryVector = vectors[0];
      const dim = config.embedding?.dimensions || queryVector.length;

      const scope = config.retrieval?.scope;
      const scanLimit = config.retrieval?.scanLimit ?? 100;

      const hasSessionId = typeof sessionId === "string" && sessionId.length > 0;
      const allowSameSession = config.retrieval?.allowSameSession === true;
      const dedupeTurns = config.retrieval?.dedupeTurns ?? 5;
      const excludeSameSession = hasSessionId && !allowSameSession;

      const candidatesArgs = { scope, cwd, model, dim, limit: scanLimit };
      if (excludeSameSession) {
        candidatesArgs.excludeSessionId = sessionId;
      }
      const dbCandidates = await db.candidates(candidatesArgs);
      const candidateCount = (dbCandidates ?? []).length;
      let candidates = dbCandidates ?? [];

      let excludedSameSession = 0;
      if (excludeSameSession) {
        try {
          const count = await db.countCandidates?.({ scope, cwd, model, dim, sessionId });
          excludedSameSession = count ?? 0;
        } catch {
          excludedSameSession = 0;
        }
      }

      let excludedDedupe = 0;
      let dedupeApplied = false;
      const dedupeActive =
        mode === "injection" &&
        recallState &&
        dedupeTurns !== 0 &&
        hasSessionId &&
        Number.isInteger(turn) &&
        turn >= 0;
      if (dedupeActive) {
        const eligible = [];
        for (const candidate of candidates) {
          if (recallState.isEligible({ sessionId, pairId: candidate.pairId, turn, gap: dedupeTurns })) {
            eligible.push(candidate);
          } else {
            excludedDedupe += 1;
          }
        }
        candidates = eligible;
        dedupeApplied = true;
      }

      const minScore = config.retrieval?.minScore ?? 0;
      // The rerank relevance score is on a different scale than cosine
      // similarity, so it has its own threshold. Falling back to `minScore`
      // keeps older configurations (and test doubles) working unchanged.
      const rerankMinScore =
        config.retrieval?.rerankMinScore ?? minScore;
      const candidateLimit = config.retrieval?.candidateLimit ?? 5;
      const topK = config.retrieval?.topK ?? 3;

      const ranked = await rankCandidates({
        query: trimmed,
        queryVector,
        candidates,
        cosineMinScore: minScore,
        rerankEnabled: config.rerank?.enabled === true,
        reranker,
        rerankTopN: candidateLimit,
        rerankMinScore,
        finalLimit: topK,
        signal: combined,
        logger,
      });
      const pairs = ranked.top;
      const reranked = ranked.reranked;
      const latencyMs = Date.now() - started;
      logger?.debug?.(
        `[context-rag] retrieval: ${candidateCount} candidates, same-session excluded ${excludedSameSession}, dedupe excluded ${excludedDedupe}, topK ${topK}, rerank ${reranked ? "on" : "off"}, returned ${pairs.length} (${latencyMs}ms)`,
      );
      const stats = {
        scope,
        model: embedModel || model,
        dim,
        candidateCount,
        excludedSameSession,
        excludedDedupe,
        dedupeApplied,
        returned: pairs.length,
        reranked,
        latencyMs,
      };
      lastRetrieval = {
        at: new Date(),
        pairCount: pairs.length,
        scope,
        reranked,
        latencyMs,
        excludedSameSession,
        excludedDedupe,
        dedupeApplied,
        queryPreview: trimmed.slice(0, 60),
      };
      lastError = null;
      return { pairs, stats };
    } catch (err) {
      // A caller-initiated abort is not a failure: report it as skipped.
      if (signal?.aborted) {
        return { pairs: [], stats: { skipped: "aborted" } };
      }
      lastError = err.message;
      logger.error?.(`[context-rag] retrieval failed: ${err.message}`);
      return { pairs: [], stats: { error: err.message } };
    }
  }

  return { retrieve, status };
}
