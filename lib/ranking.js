/**
 * Shared scoring stage for `dsh-context-rag`.
 *
 * Both the retrieval pipeline (`lib/retrieval.js`) and the manual search
 * service (`lib/search.js`) score candidate vectors against a query vector
 * by cosine similarity, optionally rerank the top cosine candidates, and
 * slice the result to a final limit. This module hosts that stage so the two
 * callers stay in lockstep.
 *
 * @module ranking
 */

/**
 * Cosine similarity of two equal-length L2-normalized vectors.
 *
 * @param {number[]|Float32Array} a - Query vector.
 * @param {number[]|Float32Array} b - Candidate vector.
 * @returns {number} Dot product over the shorter vector (equals cosine when
 *   both are normalized and equally long).
 */
export function cosine(a, b) {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Build the rerank document for a candidate.
 *
 * Memory candidates are reranked from their content alone. Conversation
 * pairs are reranked from their `User:/Assistant:` text. Both are sliced to
 * 4000 chars to bound the rerank payload.
 *
 * @param {object} candidate - A candidate record (pair or memory).
 * @returns {string} The rerank document, ≤ 4000 chars.
 */
export function buildDoc(candidate) {
  if (candidate.recordType === "memory") {
    const content = candidate.userText ?? candidate.content ?? "";
    return String(content).slice(0, 4000);
  }
  const user = candidate.userText ?? candidate.user ?? "";
  const assistant = candidate.assistantText ?? candidate.assistant ?? "";
  return `User:\n${user}\n\nAssistant:\n${assistant}`.slice(0, 4000);
}

/**
 * Score, filter, and optionally rerank candidates.
 *
 * Every candidate is scored against `queryVector` by cosine similarity;
 * candidates below `cosineMinScore` are dropped and the rest are sorted by
 * score descending. The first `rerankTopN` cosine candidates are then fed to
 * the reranker (when enabled and a reranker is present and at least one
 * candidate survived the cosine filter), with `topN` bounded to
 * `finalLimit`. Rerank results are mapped back through `entry.index`, sorted
 * by rerank score descending, filtered by `rerankMinScore`, and sliced to
 * `finalLimit`. A throwing reranker falls back to the cosine-filtered list
 * (sliced to `finalLimit`) and reports the failure in `rerankError`.
 *
 * Every returned candidate carries `cosineScore` (the original cosine) and
 * `score` (the rerank score when reranked, else the cosine).
 *
 * @param {object} params
 * @param {string} params.query - Trimmed query string, used only for rerank.
 * @param {number[]|Float32Array} params.queryVector - Query vector used for
 *   cosine scoring.
 * @param {Array<object>} [params.candidates] - Candidate records, each with
 *   a `.vector` (`number[]` or `Float32Array`).
 * @param {number} [params.cosineMinScore] - Cosine threshold; defaults to 0.
 * @param {boolean} [params.rerankEnabled] - Whether to rerank; defaults to
 *   `false`.
 * @param {{rerank: Function}|null} [params.reranker] - Rerank client with
 *   `.rerank({query, documents, topN, signal})`; defaults to `null`.
 * @param {number} [params.rerankTopN] - Number of cosine-filtered candidates
 *   fed to the reranker; defaults to 5.
 * @param {number} [params.rerankMinScore] - Rerank score threshold; defaults
 *   to `cosineMinScore`.
 * @param {number} [params.finalLimit] - Maximum results returned; defaults
 *   to 3.
 * @param {AbortSignal} [params.signal] - Caller abort signal forwarded to the
 *   reranker.
 * @param {object} [params.logger] - Logger with an optional `warn`; defaults
 *   to `console`.
 * @returns {Promise<{top: Array<object>, reranked: boolean, rerankError:
 *   string|null}>} The ranked list, whether rerank ran, and the rerank error
 *   message (or `null`).
 */
export async function rankCandidates({
  query,
  queryVector,
  candidates = [],
  cosineMinScore = 0,
  rerankEnabled = false,
  reranker = null,
  rerankTopN = 5,
  rerankMinScore = cosineMinScore,
  finalLimit = 3,
  signal,
  logger = console,
}) {
  const scored = candidates.map((candidate) => {
    const c = cosine(queryVector, candidate.vector);
    return { ...candidate, cosineScore: c, score: c };
  });
  const filtered = scored
    .filter((candidate) => candidate.score >= cosineMinScore)
    .sort((a, b) => b.score - a.score);

  let top = filtered.slice(0, rerankTopN);
  let reranked = false;
  let rerankError = null;

  if (rerankEnabled && reranker && top.length > 0) {
    try {
      const documents = top.map(buildDoc);
      const res = await reranker.rerank({
        query,
        documents,
        topN: finalLimit,
        signal,
      });
      const mapped = [];
      for (const entry of res.results ?? []) {
        const candidate = top[entry.index];
        if (candidate) {
          mapped.push({ ...candidate, score: entry.score });
        }
      }
      mapped.sort((a, b) => b.score - a.score);
      // The injected score is the rerank score, so only candidates above
      // `rerankMinScore` may be kept. The cosine prefilter above only bounds
      // the candidate set considered by the reranker.
      top = mapped
        .filter((candidate) => candidate.score >= rerankMinScore)
        .slice(0, finalLimit);
      reranked = true;
    } catch (err) {
      logger.warn?.(`[context-rag] rerank failed, falling back to cosine: ${err.message}`);
      top = filtered.slice(0, finalLimit);
      rerankError = err.message;
    }
  } else {
    top = filtered.slice(0, finalLimit);
  }

  return { top, reranked, rerankError };
}
