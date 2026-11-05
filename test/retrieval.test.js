import test from "node:test";
import assert from "node:assert/strict";
import { createRetriever } from "../lib/retrieval.js";

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    embedding: { baseUrl: "http://embed", model: "m", dimensions: 4, timeoutMs: 5000 },
    rerank: { enabled: false, model: "r" },
    retrieval: {
      scope: "workspace",
      candidateLimit: 5,
      topK: 3,
      minScore: 0.1,
      maxContextChars: 8000,
      timeoutMs: 5000,
      injectionEnabled: true,
      scanLimit: 100,
      allowSameSession: false,
      dedupeTurns: 5,
    },
    ...overrides,
  };
}

function makeDb(candidatesImpl, countCandidatesImpl = null) {
  const db = { candidates: candidatesImpl };
  if (countCandidatesImpl) db.countCandidates = countCandidatesImpl;
  return db;
}

function makeEmbeddings(vector, onEmbed = null) {
  return {
    async embed(texts, { signal } = {}) {
      if (onEmbed) onEmbed(texts, signal);
      return { vectors: [vector], model: "m", dimension: vector.length };
    },
  };
}

function makeLogger() {
  const calls = { warn: [], error: [] };
  return {
    warn: (m) => calls.warn.push(m),
    error: (m) => calls.error.push(m),
    calls,
  };
}

function makeRetriever({ config, db, embeddings, reranker, logger, recallState }) {
  return createRetriever({
    db,
    configStore: { get: () => config },
    embeddings,
    reranker: reranker ?? null,
    logger,
    recallState,
  });
}

test("skips when disabled", async () => {
  const logger = makeLogger();
  const retriever = makeRetriever({
    config: makeConfig({ enabled: false }),
    db: makeDb(() => []),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger,
  });
  const result = await retriever.retrieve({ query: "hello", cwd: "/x" });
  assert.deepEqual(result.pairs, []);
  assert.equal(result.stats.skipped, "disabled");
  assert.deepEqual(logger.calls.error, []);
});

test("skips on empty query", async () => {
  const retriever = makeRetriever({
    config: makeConfig(),
    db: makeDb(() => []),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "   ", cwd: "/x" });
  assert.equal(result.stats.skipped, "empty-query");
  assert.deepEqual(result.pairs, []);
});

test("skips when model or baseUrl is not configured", async () => {
  const config = makeConfig({ embedding: { baseUrl: "", model: "m" } });
  const retriever = makeRetriever({
    config,
    db: makeDb(() => []),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "hello", cwd: "/x" });
  assert.equal(result.stats.skipped, "not-configured");
  assert.deepEqual(result.pairs, []);
});

test("sorts by cosine, applies threshold, and slices topK", async () => {
  const candidates = [
    { pairId: 1, userText: "a", assistantText: "A", vector: [0.5, 0, 0, 0] },
    { pairId: 2, userText: "b", assistantText: "B", vector: [1, 0, 0, 0] },
    { pairId: 3, userText: "c", assistantText: "C", vector: [-1, 0, 0, 0] },
    { pairId: 4, userText: "d", assistantText: "D", vector: [0.2, 0, 0, 0] },
  ];
  const retrieval = { ...makeConfig().retrieval, minScore: 0.1, topK: 2, candidateLimit: 5 };
  const retriever = makeRetriever({
    config: makeConfig({ retrieval }),
    db: makeDb(() => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x" });
  assert.deepEqual(result.pairs.map((p) => p.pairId), [2, 1]);
  assert.equal(result.stats.returned, 2);
  assert.equal(result.stats.candidateCount, 4);
  assert.equal(result.stats.reranked, false);
  assert.equal(result.stats.scope, "workspace");
});

test("maps rerank indices, sorts by rerank score, and slices topK", async () => {
  const candidates = [
    { pairId: 1, userText: "a", assistantText: "A", vector: [0.3, 0, 0, 0] },
    { pairId: 2, userText: "b", assistantText: "B", vector: [0.5, 0, 0, 0] },
    { pairId: 3, userText: "c", assistantText: "C", vector: [0.7, 0, 0, 0] },
  ];
  const calls = [];
  const reranker = {
    async rerank({ query, documents, topN, signal }) {
      calls.push({ query, documents, topN, signal });
      // documents are ordered by descending cosine: [pair3, pair2, pair1]
      return {
        results: [
          { index: 2, document: documents[2], score: 0.9 },
          { index: 0, document: documents[0], score: 0.6 },
          { index: 1, document: documents[1], score: 0.5 },
        ],
        model: "r",
      };
    },
  };
  const retrieval = { ...makeConfig().retrieval, minScore: 0, topK: 2, candidateLimit: 10 };
  const retriever = makeRetriever({
    config: makeConfig({ rerank: { enabled: true, model: "r" }, retrieval }),
    db: makeDb(() => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    reranker,
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x" });
  assert.equal(result.stats.reranked, true);
  assert.deepEqual(result.pairs.map((p) => p.pairId), [1, 3]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].topN, 2);
  assert.equal(calls[0].query, "q");
  assert.equal(calls[0].documents[0], "User:\nc\n\nAssistant:\nC");
});

test("drops reranked candidates below rerankMinScore before injecting", async () => {
  const candidates = [
    { pairId: 1, userText: "a", assistantText: "A", vector: [0.9, 0, 0, 0] },
    { pairId: 2, userText: "b", assistantText: "B", vector: [0.8, 0, 0, 0] },
    { pairId: 3, userText: "c", assistantText: "C", vector: [0.7, 0, 0, 0] },
  ];
  const reranker = {
    async rerank({ documents }) {
      // Every candidate clears the cosine prefilter, but only the first
      // reranked result clears rerankMinScore.
      return {
        results: [
          { index: 1, document: documents[1], score: 0.95 },
          { index: 2, document: documents[2], score: 0.2 },
          { index: 0, document: documents[0], score: 0.01 },
        ],
        model: "r",
      };
    },
  };
  const retrieval = {
    ...makeConfig().retrieval,
    minScore: 0.4,
    rerankMinScore: 0.4,
    topK: 2,
    candidateLimit: 10,
  };
  const retriever = makeRetriever({
    config: makeConfig({ rerank: { enabled: true, model: "r" }, retrieval }),
    db: makeDb(() => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    reranker,
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x" });
  assert.equal(result.stats.reranked, true);
  assert.deepEqual(result.pairs.map((p) => p.pairId), [2]);
  assert.equal(result.pairs[0].score, 0.95);
  assert.ok(result.pairs.every((p) => p.score >= 0.4));
});

test("uses separate cosine and rerank thresholds", async () => {
  const candidates = [
    { pairId: 1, userText: "a", assistantText: "A", vector: [0.9, 0, 0, 0] },
    { pairId: 2, userText: "b", assistantText: "B", vector: [0.8, 0, 0, 0] },
  ];
  const reranker = {
    async rerank({ documents }) {
      return {
        results: [
          { index: 0, document: documents[0], score: 0.2 },
          { index: 1, document: documents[1], score: 0.18 },
        ],
        model: "r",
      };
    },
  };
  // Cosine must be >= 0.4, but the rerank threshold is lower: 0.2 still
  // passes on its own scale.
  const retrieval = {
    ...makeConfig().retrieval,
    minScore: 0.4,
    rerankMinScore: 0.15,
    topK: 2,
    candidateLimit: 10,
  };
  const retriever = makeRetriever({
    config: makeConfig({ rerank: { enabled: true, model: "r" }, retrieval }),
    db: makeDb(() => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    reranker,
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x" });
  assert.equal(result.stats.reranked, true);
  assert.deepEqual(result.pairs.map((p) => p.pairId), [1, 2]);
});

test("injects no pairs when every reranked candidate is below rerankMinScore", async () => {
  const candidates = [
    { pairId: 1, userText: "a", assistantText: "A", vector: [0.8, 0, 0, 0] },
    { pairId: 2, userText: "b", assistantText: "B", vector: [0.7, 0, 0, 0] },
  ];
  const reranker = {
    async rerank({ documents }) {
      return {
        results: [
          { index: 0, document: documents[0], score: 0.013 },
          { index: 1, document: documents[1], score: 0.002 },
        ],
        model: "r",
      };
    },
  };
  const retrieval = {
    ...makeConfig().retrieval,
    minScore: 0.1,
    rerankMinScore: 0.4,
    topK: 2,
    candidateLimit: 10,
  };
  const retriever = makeRetriever({
    config: makeConfig({ rerank: { enabled: true, model: "r" }, retrieval }),
    db: makeDb(() => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    reranker,
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x" });
  assert.equal(result.stats.reranked, true);
  assert.deepEqual(result.pairs, []);
});

test("falls back to cosine topK when rerank throws", async () => {
  const candidates = [
    { pairId: 1, userText: "a", assistantText: "A", vector: [0.3, 0, 0, 0] },
    { pairId: 2, userText: "b", assistantText: "B", vector: [0.7, 0, 0, 0] },
  ];
  const logger = makeLogger();
  const reranker = {
    async rerank() {
      throw new Error("boom");
    },
  };
  const retrieval = { ...makeConfig().retrieval, minScore: 0, topK: 1, candidateLimit: 10 };
  const retriever = makeRetriever({
    config: makeConfig({ rerank: { enabled: true }, retrieval }),
    db: makeDb(() => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    reranker,
    logger,
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x" });
  assert.equal(result.stats.reranked, false);
  assert.deepEqual(result.pairs.map((p) => p.pairId), [2]);
  assert.ok(logger.calls.warn.length >= 1);
});

test("does not call rerank when rerank is disabled", async () => {
  const candidates = [
    { pairId: 1, userText: "a", assistantText: "A", vector: [0.3, 0, 0, 0] },
  ];
  let rerankCalls = 0;
  const reranker = {
    async rerank() {
      rerankCalls += 1;
      return { results: [] };
    },
  };
  const retriever = makeRetriever({
    config: makeConfig({ rerank: { enabled: false } }),
    db: makeDb(() => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    reranker,
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x" });
  assert.equal(rerankCalls, 0);
  assert.equal(result.stats.reranked, false);
  assert.equal(result.pairs.length, 1);
});

test("returns skipped aborted without logging when the caller aborts", async () => {
  const controller = new AbortController();
  controller.abort();
  const logger = makeLogger();
  const embeddings = {
    async embed(_texts, { signal } = {}) {
      signal.throwIfAborted();
      return { vectors: [[1, 0, 0, 0]] };
    },
  };
  const retriever = makeRetriever({
    config: makeConfig(),
    db: makeDb(() => []),
    embeddings,
    logger,
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x", signal: controller.signal });
  assert.equal(result.stats.skipped, "aborted");
  assert.deepEqual(result.pairs, []);
  assert.equal(retriever.status().lastError, null);
  assert.deepEqual(logger.calls.error, []);
});

test("records embed errors in lastError and returns error stats", async () => {
  const logger = makeLogger();
  const embeddings = {
    async embed() {
      throw new Error("network down");
    },
  };
  const retriever = makeRetriever({
    config: makeConfig(),
    db: makeDb(() => []),
    embeddings,
    logger,
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x" });
  assert.equal(result.stats.error, "network down");
  assert.deepEqual(result.pairs, []);
  assert.equal(retriever.status().lastError, "network down");
  assert.ok(logger.calls.error.length >= 1);
});

test("status tracks the last successful retrieval", async () => {
  const retriever = makeRetriever({
    config: makeConfig(),
    db: makeDb(() => []),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  assert.equal(retriever.status().lastRetrieval, null);
  await retriever.retrieve({ query: "hello world", cwd: "/x" });
  const status = retriever.status();
  assert.ok(status.lastRetrieval);
  assert.equal(status.lastRetrieval.pairCount, 0);
  assert.equal(status.lastRetrieval.queryPreview, "hello world");
  assert.equal(status.lastRetrieval.scope, "workspace");
  assert.equal(status.lastRetrieval.reranked, false);
});

test("excludes same-session candidates by default and reports the count", async () => {
  const candidates = [
    { pairId: 1, sessionId: "other-session", userText: "a", assistantText: "A", vector: [1, 0, 0, 0] },
  ];
  const calls = [];
  const db = makeDb(
    (args) => {
      calls.push(args);
      return candidates;
    },
    async (args) => {
      assert.deepEqual(args, { scope: "workspace", cwd: "/x", model: "m", dim: 4, sessionId: "session-x" });
      return 2;
    },
  );
  const retriever = makeRetriever({
    config: makeConfig(),
    db,
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x", sessionId: "session-x" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].excludeSessionId, "session-x");
  assert.equal(result.stats.candidateCount, 1);
  assert.equal(result.stats.excludedSameSession, 2);
  assert.deepEqual(result.pairs.map((p) => p.pairId), [1]);
});

test("allows same-session candidates when allowSameSession is true", async () => {
  const candidates = [
    { pairId: 1, sessionId: "session-x", userText: "a", assistantText: "A", vector: [1, 0, 0, 0] },
  ];
  const calls = [];
  let countCalls = 0;
  const db = makeDb(
    (args) => {
      calls.push(args);
      return candidates;
    },
    () => {
      countCalls += 1;
      return 1;
    },
  );
  const retriever = makeRetriever({
    config: makeConfig({ retrieval: { ...makeConfig().retrieval, allowSameSession: true } }),
    db,
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x", sessionId: "session-x" });
  assert.equal(calls[0].excludeSessionId, undefined);
  assert.equal(countCalls, 0);
  assert.equal(result.stats.excludedSameSession, 0);
  assert.deepEqual(result.pairs.map((p) => p.pairId), [1]);
});

test("skips the same-session filter when sessionId is empty", async () => {
  const calls = [];
  let countCalls = 0;
  const db = makeDb(
    (args) => {
      calls.push(args);
      return [{ pairId: 1, sessionId: "s", userText: "a", assistantText: "A", vector: [1, 0, 0, 0] }];
    },
    () => {
      countCalls += 1;
      return 1;
    },
  );
  const retriever = makeRetriever({
    config: makeConfig(),
    db,
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x" });
  assert.equal(calls[0].excludeSessionId, undefined);
  assert.equal(countCalls, 0);
  assert.equal(result.stats.excludedSameSession, 0);
  assert.equal(result.stats.candidateCount, 1);
});

test("tolerates a db without countCandidates", async () => {
  const retriever = makeRetriever({
    config: makeConfig(),
    db: makeDb(() => [{ pairId: 1, userText: "a", assistantText: "A", vector: [1, 0, 0, 0] }]),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x", sessionId: "session-x" });
  assert.equal(result.stats.excludedSameSession, 0);
  assert.equal(result.stats.candidateCount, 1);
  assert.equal(result.pairs.length, 1);
});

test("falls back to 0 when countCandidates throws", async () => {
  const db = makeDb(
    () => [],
    () => {
      throw new Error("boom");
    },
  );
  const retriever = makeRetriever({
    config: makeConfig(),
    db,
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x", sessionId: "session-x" });
  assert.equal(result.stats.excludedSameSession, 0);
  assert.deepEqual(result.pairs, []);
});

test("injection dedupe: a pair is eligible again after the configured turn distance", async () => {
  const recalls = [];
  const recorded = { recent: 1 };
  const recallState = {
    isEligible({ sessionId, pairId, turn, gap }) {
      recalls.push({ sessionId, pairId, turn, gap });
      const last = recorded[pairId];
      if (last === undefined) return true;
      if (gap === -1) return false;
      return turn - last >= gap;
    },
  };
  const candidates = [
    { pairId: "recent", userText: "a", assistantText: "A", vector: [1, 0, 0, 0] },
    { pairId: "fresh", userText: "b", assistantText: "B", vector: [1, 0, 0, 0] },
  ];
  const retriever = makeRetriever({
    config: makeConfig(),
    db: makeDb(() => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    recallState,
    logger: makeLogger(),
  });

  // Turn 4: recent was injected at turn 1; 4 - 1 = 3 < 5 -> excluded.
  let result = await retriever.retrieve({ query: "q", cwd: "/x", sessionId: "s", turn: 4, mode: "injection" });
  assert.deepEqual(result.pairs.map((p) => p.pairId), ["fresh"]);
  assert.equal(result.stats.excludedDedupe, 1);
  assert.equal(result.stats.dedupeApplied, true);
  assert.deepEqual(recalls[0], { sessionId: "s", pairId: "recent", turn: 4, gap: 5 });

  // Turn 6: 6 - 1 = 5 >= 5 -> eligible again.
  result = await retriever.retrieve({ query: "q", cwd: "/x", sessionId: "s", turn: 6, mode: "injection" });
  assert.deepEqual(result.pairs.map((p) => p.pairId), ["recent", "fresh"]);
  assert.equal(result.stats.excludedDedupe, 0);
  assert.equal(result.stats.dedupeApplied, true);
});

test("injection dedupe: dedupeTurns 0 disables the filter entirely", async () => {
  let calls = 0;
  const recallState = {
    isEligible() {
      calls += 1;
      return false;
    },
  };
  const retriever = makeRetriever({
    config: makeConfig({ retrieval: { ...makeConfig().retrieval, dedupeTurns: 0 } }),
    db: makeDb(() => [{ pairId: "x", userText: "a", assistantText: "A", vector: [1, 0, 0, 0] }]),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    recallState,
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x", sessionId: "s", turn: 1, mode: "injection" });
  assert.equal(calls, 0);
  assert.equal(result.stats.excludedDedupe, 0);
  assert.equal(result.stats.dedupeApplied, false);
  assert.deepEqual(result.pairs.map((p) => p.pairId), ["x"]);
});

test("injection dedupe: dedupeTurns -1 excludes any recorded pair", async () => {
  const recorded = new Set(["seen"]);
  const recallState = {
    isEligible({ pairId }) {
      return !recorded.has(pairId); // once per session, ever
    },
  };
  const candidates = [
    { pairId: "seen", userText: "a", assistantText: "A", vector: [1, 0, 0, 0] },
    { pairId: "fresh", userText: "b", assistantText: "B", vector: [1, 0, 0, 0] },
  ];
  const retriever = makeRetriever({
    config: makeConfig({ retrieval: { ...makeConfig().retrieval, dedupeTurns: -1 } }),
    db: makeDb(() => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    recallState,
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x", sessionId: "s", turn: 10, mode: "injection" });
  assert.deepEqual(result.pairs.map((p) => p.pairId), ["fresh"]);
  assert.equal(result.stats.excludedDedupe, 1);
  assert.equal(result.stats.dedupeApplied, true);
});

test("turn dedupe does not run outside injection mode", async () => {
  let calls = 0;
  const recallState = {
    isEligible() {
      calls += 1;
      return false;
    },
  };
  const retriever = makeRetriever({
    config: makeConfig(),
    db: makeDb(() => [{ pairId: "x", userText: "a", assistantText: "A", vector: [1, 0, 0, 0] }]),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    recallState,
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x", sessionId: "s", turn: 3, mode: "active" });
  assert.equal(calls, 0);
  assert.equal(result.stats.excludedDedupe, 0);
  assert.equal(result.stats.dedupeApplied, false);
  assert.deepEqual(result.pairs.map((p) => p.pairId), ["x"]);
});

test("turn dedupe does not run when recallState is absent", async () => {
  const retriever = makeRetriever({
    config: makeConfig(),
    db: makeDb(() => [{ pairId: "x", userText: "a", assistantText: "A", vector: [1, 0, 0, 0] }]),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x", sessionId: "s", turn: 3, mode: "injection" });
  assert.equal(result.stats.excludedDedupe, 0);
  assert.equal(result.stats.dedupeApplied, false);
  assert.deepEqual(result.pairs.map((p) => p.pairId), ["x"]);
});

test("dedupe filters candidates before topK/rerank so eligible pairs fill slots", async () => {
  const recorded = new Set(["a", "b"]);
  const recallState = {
    isEligible({ pairId }) {
      return !recorded.has(pairId);
    },
  };
  const candidates = [
    { pairId: "a", userText: "a", assistantText: "A", vector: [1, 0, 0, 0] },
    { pairId: "b", userText: "b", assistantText: "B", vector: [1, 0, 0, 0] },
    { pairId: "c", userText: "c", assistantText: "C", vector: [1, 0, 0, 0] },
  ];
  let rerankDocs = null;
  const reranker = {
    async rerank({ documents }) {
      rerankDocs = documents;
      return {
        results: documents.map((doc, index) => ({ index, document: doc, score: 1 - index * 0.1 })),
        model: "r",
      };
    },
  };
  const retrieval = { ...makeConfig().retrieval, dedupeTurns: 5, topK: 2, candidateLimit: 3, minScore: 0 };
  const retriever = makeRetriever({
    config: makeConfig({ rerank: { enabled: true, model: "r" }, retrieval }),
    db: makeDb(() => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    reranker,
    recallState,
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x", sessionId: "s", turn: 2, mode: "injection" });
  // Only the eligible candidate reaches the reranker.
  assert.deepEqual(rerankDocs, ["User:\nc\n\nAssistant:\nC"]);
  assert.deepEqual(result.pairs.map((p) => p.pairId), ["c"]);
  assert.equal(result.stats.candidateCount, 3);
  assert.equal(result.stats.excludedDedupe, 2);
  assert.equal(result.stats.dedupeApplied, true);
});

test("reports filter counts in stats and lastRetrieval", async () => {
  const recallState = {
    isEligible({ pairId }) {
      return pairId !== "recent";
    },
  };
  const candidates = [
    { pairId: "recent", userText: "a", assistantText: "A", vector: [1, 0, 0, 0] },
    { pairId: "fresh", userText: "b", assistantText: "B", vector: [1, 0, 0, 0] },
  ];
  const retriever = makeRetriever({
    config: makeConfig(),
    db: makeDb(() => candidates, async () => 7),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    recallState,
    logger: makeLogger(),
  });
  const result = await retriever.retrieve({ query: "q", cwd: "/x", sessionId: "s", turn: 3, mode: "injection" });
  assert.equal(result.stats.candidateCount, 2);
  assert.equal(result.stats.excludedSameSession, 7);
  assert.equal(result.stats.excludedDedupe, 1);
  assert.equal(result.stats.dedupeApplied, true);
  assert.equal(result.stats.returned, 1);
  assert.equal(result.stats.reranked, false);
  assert.equal(typeof result.stats.latencyMs, "number");

  const last = retriever.status().lastRetrieval;
  assert.equal(last.pairCount, 1);
  assert.equal(last.excludedSameSession, 7);
  assert.equal(last.excludedDedupe, 1);
  assert.equal(last.dedupeApplied, true);
  assert.equal(last.scope, "workspace");
});
