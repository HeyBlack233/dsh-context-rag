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
    },
    ...overrides,
  };
}

function makeDb(impl) {
  return { candidates: impl };
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

function makeRetriever({ config, db, embeddings, reranker, logger }) {
  return createRetriever({
    db,
    configStore: { get: () => config },
    embeddings,
    reranker: reranker ?? null,
    logger,
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
