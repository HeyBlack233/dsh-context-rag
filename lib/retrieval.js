/**
 * Retrieval for `dsh-context-rag`: embedding the query, pulling candidates from
 * the vector store, scoring by cosine similarity, and optionally reranking.
 *
 * `createRetriever` wires together the embeddings client, the candidate index,
 * and an optional reranker. It never throws to the caller; every failure is
 * recorded in status and returned as an empty result.
 *
 * @module retrieval
 */

/**
 * Build the rerank document for a candidate pair.
 *
 * @param {object} candidate - A candidate pair record.
 * @returns {string} A `User:\n...\n\nAssistant:\n...` document, ≤ 4000 chars.
 */
function buildDoc(candidate) {
  const user = candidate.userText ?? candidate.user ?? "";
  const assistant = candidate.assistantText ?? candidate.assistant ?? "";
  return `User:\n${user}\n\nAssistant:\n${assistant}`.slice(0, 4000);
}

/**
 * Cosine similarity of two equal-length L2-normalized vectors.
 *
 * @param {number[]} a - Query vector.
 * @param {number[]} b - Candidate vector.
 * @returns {number} Dot product (equals cosine when both are normalized).
 */
function cosine(a, b) {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Create a retriever.
 *
 * @param {object} deps
 * @param {object} deps.db - Candidate index exposing `candidates({scope,cwd,model,dim,limit})`.
 * @param {{get:Function}} deps.configStore - Config store exposing `.get()`.
 * @param {{embed:Function}} deps.embeddings - Embedding client with `.embed(texts,{signal})`.
 * @param {{rerank:Function}|null} [deps.reranker] - Optional rerank client.
 * @param {object} [deps.logger] - Logger with `warn`/`error`.
 * @returns {{retrieve:Function, status:Function}} The retriever.
 */
export function createRetriever({ db, configStore, embeddings, reranker, logger = console }) {
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
   * Retrieve related past turns for a query.
   *
   * @param {object} options
   * @param {string} options.query - The query text.
   * @param {string} [options.cwd] - Current workspace path.
   * @param {AbortSignal} [options.signal] - Caller signal.
   * @returns {Promise<{pairs:Array<object>,stats:object}>} Pairs and stats.
   */
  async function retrieve({ query, cwd = "", signal } = {}) {
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
      const candidates = await db.candidates({
        scope,
        cwd,
        model,
        dim,
        limit: scanLimit,
      });

      const minScore = config.retrieval?.minScore ?? 0;
      // The rerank relevance score is on a different scale than cosine
      // similarity, so it has its own threshold. Falling back to `minScore`
      // keeps older configurations (and test doubles) working unchanged.
      const rerankMinScore =
        config.retrieval?.rerankMinScore ?? minScore;
      const candidateLimit = config.retrieval?.candidateLimit ?? 5;
      const topK = config.retrieval?.topK ?? 3;

      const scored = (candidates ?? []).map((candidate) => ({
        ...candidate,
        score: cosine(queryVector, candidate.vector),
      }));
      const filtered = scored
        .filter((candidate) => candidate.score >= minScore)
        .sort((a, b) => b.score - a.score);

      let top = filtered.slice(0, candidateLimit);
      let reranked = false;

      if (config.rerank?.enabled && top.length > 0 && reranker) {
        try {
          const documents = top.map(buildDoc);
          const res = await reranker.rerank({
            query: trimmed,
            documents,
            topN: topK,
            signal: combined,
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
          // `rerankMinScore` may be injected. The cosine prefilter above only
          // bounds the candidate set considered by the reranker.
          top = mapped
            .filter((candidate) => candidate.score >= rerankMinScore)
            .slice(0, topK);
          reranked = true;
        } catch (err) {
          logger.warn?.(`[context-rag] rerank failed, falling back to cosine: ${err.message}`);
          top = filtered.slice(0, topK);
        }
      } else {
        top = filtered.slice(0, topK);
      }

      const pairs = top;
      const latencyMs = Date.now() - started;
      const stats = {
        scope,
        model: embedModel || model,
        dim,
        candidateCount: (candidates ?? []).length,
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
