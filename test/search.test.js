/**
 * Tests for the manual search service in `lib/search.js`.
 *
 * The service is exercised with fake db/configStore/embeddings/reranker
 * doubles so every stage of the pipeline (embed, candidate pull, cosine +
 * rerank ranking, stats, error handling) is observable in isolation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createSearchService } from "../lib/search.js";

/** @returns {object} A fully configured search config. */
function makeConfig(overrides = {}) {
  return {
    embedding: { enabled: true, baseUrl: "http://embed", model: "m", dimensions: 4 },
    rerank: { enabled: false, model: "r" },
    retrieval: { minScore: 0, rerankMinScore: 0, scanLimit: 100, timeoutMs: 5000 },
    ...overrides,
  };
}

/** @param {Function} candidatesImpl @returns {object} A fake db. */
function makeDb(candidatesImpl) {
  return { searchCandidates: candidatesImpl };
}

/** @param {number[]} vector @returns {object} A fake embeddings client. */
function makeEmbeddings(vector) {
  return {
    async embed(texts, { signal } = {}) {
      void texts;
      void signal;
      return { vectors: [vector], model: "m", dimension: vector.length };
    },
  };
}

/** @returns {{calls: {debug: string[], warn: string[]}, debug: Function, warn: Function}} A capturing logger. */
function makeLogger() {
  const calls = { debug: [], warn: [] };
  return {
    debug: (m) => calls.debug.push(String(m)),
    warn: (m) => calls.warn.push(String(m)),
    calls,
  };
}

/** @param {object} deps @returns {{search: Function}} The search service. */
function makeService({ config, db, embeddings, reranker, logger }) {
  return createSearchService({
    db,
    configStore: { get: () => config },
    embeddings,
    reranker: reranker ?? null,
    logger: logger ?? console,
  });
}

test("scores by cosine, filters by minScore, and slices to the limit", async () => {
  const candidates = [
    { pairId: 1, userText: "a", assistantText: "A", vector: [0.5, 0, 0, 0] },
    { pairId: 2, userText: "b", assistantText: "B", vector: [1, 0, 0, 0] },
    { pairId: 3, userText: "c", assistantText: "C", vector: [-1, 0, 0, 0] },
    { pairId: 4, userText: "d", assistantText: "D", vector: [0.2, 0, 0, 0] },
  ];
  const service = makeService({
    config: makeConfig({ retrieval: { minScore: 0.25, rerankMinScore: 0, scanLimit: 100, timeoutMs: 5000 } }),
    db: makeDb(async () => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  const result = await service.search({ query: "q", limit: 2 });
  assert.deepEqual(result.results.map((r) => r.pairId), [2, 1]);
  assert.equal(result.stats.returned, 2);
  assert.equal(result.stats.candidateCount, 4);
  assert.equal(result.stats.reranked, false);
  assert.equal(result.stats.rerankError, null);
  assert.equal(result.results[0].score, 1);
  assert.equal(result.results[0].cosineScore, 1);
  assert.equal(result.results[1].score, 0.5);
  assert.equal(result.results[1].cosineScore, 0.5);
});

test("rerank reorders by its scores and applies rerankMinScore", async () => {
  const candidates = [
    { pairId: 1, userText: "a", assistantText: "A", vector: [0.9, 0, 0, 0] },
    { pairId: 2, userText: "b", assistantText: "B", vector: [0.8, 0, 0, 0] },
    { pairId: 3, userText: "c", assistantText: "C", vector: [0.7, 0, 0, 0] },
  ];
  const calls = [];
  const reranker = {
    async rerank({ query, documents, topN, signal }) {
      calls.push({ query, documents, topN, signal });
      return {
        results: [
          { index: 1, document: documents[1], score: 0.9 },
          { index: 0, document: documents[0], score: 0.4 },
          { index: 2, document: documents[2], score: 0.6 },
        ],
        model: "r",
      };
    },
  };
  const service = makeService({
    config: makeConfig({
      rerank: { enabled: true, model: "r" },
      retrieval: { minScore: 0, rerankMinScore: 0.5, scanLimit: 100, timeoutMs: 5000 },
    }),
    db: makeDb(async () => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    reranker,
    logger: makeLogger(),
  });
  const result = await service.search({ query: "q", limit: 3 });
  assert.equal(result.stats.reranked, true);
  assert.deepEqual(result.results.map((r) => r.pairId), [2, 3]);
  assert.equal(result.results[0].score, 0.9);
  assert.equal(result.results[0].cosineScore, 0.8, "cosineScore must stay the original cosine");
  assert.equal(result.results[1].score, 0.6);
  assert.equal(result.results[1].cosineScore, 0.7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, "q");
});

test("feeds the first `limit` cosine candidates to the reranker with topN = limit", async () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    pairId: i + 1,
    userText: `u${i + 1}`,
    assistantText: `a${i + 1}`,
    vector: [(8 - i) / 10, 0, 0, 0], // descending cosine
  }));
  const calls = [];
  const reranker = {
    async rerank({ query, documents, topN, signal }) {
      calls.push({ query, documents, topN, signal });
      return {
        results: documents.map((document, index) => ({ index, document, score: 1 - index * 0.05 })),
        model: "r",
      };
    },
  };
  const service = makeService({
    config: makeConfig({ rerank: { enabled: true, model: "r" } }),
    db: makeDb(async () => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    reranker,
    logger: makeLogger(),
  });
  const result = await service.search({ query: "q", limit: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].topN, 3);
  assert.equal(calls[0].documents.length, 3);
  assert.equal(calls[0].documents[0], "User:\nu1\n\nAssistant:\na1");
  assert.equal(result.results.length, 3);
});

test("caps the limit at 50", async () => {
  const candidates = Array.from({ length: 60 }, (_, i) => ({
    pairId: i + 1,
    userText: `u${i + 1}`,
    assistantText: `a${i + 1}`,
    vector: [1, 0, 0, 0],
  }));
  const calls = [];
  const reranker = {
    async rerank({ documents, topN, signal }) {
      calls.push({ documents, topN, signal });
      return { results: documents.map((document, index) => ({ index, document, score: 1 })) };
    },
  };
  const service = makeService({
    config: makeConfig({ rerank: { enabled: true, model: "r" } }),
    db: makeDb(async () => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    reranker,
    logger: makeLogger(),
  });
  const result = await service.search({ query: "q", limit: 500 });
  assert.equal(calls[0].topN, 50);
  assert.equal(result.results.length, 50);
});

test("falls back to cosine when rerank throws and reports stats.rerankError", async () => {
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
  const service = makeService({
    config: makeConfig({ rerank: { enabled: true, model: "r" } }),
    db: makeDb(async () => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    reranker,
    logger,
  });
  const result = await service.search({ query: "q", limit: 2 });
  assert.equal(result.stats.reranked, false);
  assert.equal(result.stats.rerankError, "boom");
  assert.deepEqual(result.results.map((r) => r.pairId), [2, 1]);
  assert.equal(result.results[0].score, 0.7, "the fallback score must be the cosine");
  assert.ok(logger.calls.warn.some((m) => m.includes("rerank failed")));
});

test("rejects an empty query with INVALID_INPUT 400", async () => {
  const service = makeService({
    config: makeConfig(),
    db: makeDb(async () => []),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  await assert.rejects(
    service.search({ query: "   " }),
    (err) => err.code === "INVALID_INPUT" && err.status === 400,
  );
});

test("rejects with EMBEDDING_NOT_CONFIGURED 409 when embedding is disabled", async () => {
  const service = makeService({
    config: makeConfig({ embedding: { enabled: false, baseUrl: "http://embed", model: "m" } }),
    db: makeDb(async () => []),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  await assert.rejects(
    service.search({ query: "q" }),
    (err) => err.code === "EMBEDDING_NOT_CONFIGURED" && err.status === 409,
  );
});

test("rejects with EMBEDDING_NOT_CONFIGURED 409 when model or baseUrl is empty", async () => {
  for (const embedding of [
    { enabled: true, baseUrl: "", model: "m" },
    { enabled: true, baseUrl: "http://embed", model: "" },
  ]) {
    const service = makeService({
      config: makeConfig({ embedding }),
      db: makeDb(async () => []),
      embeddings: makeEmbeddings([1, 0, 0, 0]),
      logger: makeLogger(),
    });
    await assert.rejects(
      service.search({ query: "q" }),
      (err) => err.code === "EMBEDDING_NOT_CONFIGURED" && err.status === 409,
    );
  }
});

test("normalizes an embed-time EMBEDDING_NOT_CONFIGURED error to status 409", async () => {
  const embeddings = {
    async embed() {
      const err = new Error("Embedding is not configured: model is empty");
      err.code = "EMBEDDING_NOT_CONFIGURED";
      err.status = null;
      throw err;
    },
  };
  const service = makeService({
    config: makeConfig(),
    db: makeDb(async () => []),
    embeddings,
    logger: makeLogger(),
  });
  await assert.rejects(
    service.search({ query: "q" }),
    (err) => err.code === "EMBEDDING_NOT_CONFIGURED" && err.status === 409,
  );
});

test("passes scope, kinds, model, dim, and scanLimit to db.searchCandidates", async () => {
  const calls = [];
  const service = makeService({
    config: makeConfig({ retrieval: { minScore: 0, scanLimit: 42, timeoutMs: 5000 } }),
    db: makeDb(async (args) => {
      calls.push(args);
      return [];
    }),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  await service.search({ query: "q", scope: { type: "workspace", cwd: "/w" }, kinds: ["pair"], limit: 3 });
  assert.deepEqual(calls[0], {
    scope: { type: "workspace", cwd: "/w" },
    kinds: ["pair"],
    model: "m",
    dim: 4,
    limit: 42,
  });
});

test("defaults scope to all and kinds to memory+pair", async () => {
  const calls = [];
  const service = makeService({
    config: makeConfig(),
    db: makeDb(async (args) => {
      calls.push(args);
      return [];
    }),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  await service.search({ query: "q" });
  assert.deepEqual(calls[0].scope, { type: "all" });
  assert.deepEqual(calls[0].kinds, ["memory", "pair"]);
  assert.equal(calls[0].dim, 4);
  assert.equal(calls[0].limit, 100);
});

test("preserves candidate metadata on results", async () => {
  const candidates = [
    {
      pairId: "mem-1",
      sessionId: "",
      cwd: "/w",
      turn: 0,
      createdAt: 123,
      userText: "memory body",
      assistantText: "",
      recordType: "memory",
      memoryType: "workspace",
      name: "Note",
      description: "A note",
      vector: [1, 0, 0, 0],
    },
    {
      pairId: "pair-1",
      sessionId: "s1",
      cwd: "/w",
      turn: 4,
      createdAt: 456,
      userText: "user text",
      assistantText: "assistant text",
      recordType: "pair",
      memoryType: null,
      name: "",
      description: "",
      vector: [0.8, 0, 0, 0],
    },
  ];
  const service = makeService({
    config: makeConfig(),
    db: makeDb(async () => candidates),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  const result = await service.search({ query: "q", limit: 5 });
  assert.equal(result.query, "q");
  const mem = result.results.find((r) => r.pairId === "mem-1");
  assert.equal(mem.recordType, "memory");
  assert.equal(mem.memoryType, "workspace");
  assert.equal(mem.name, "Note");
  assert.equal(mem.description, "A note");
  assert.equal(mem.userText, "memory body");
  const pair = result.results.find((r) => r.pairId === "pair-1");
  assert.equal(pair.sessionId, "s1");
  assert.equal(pair.turn, 4);
  assert.equal(pair.assistantText, "assistant text");
});

test("never includes the query text in debug or warn logs", async () => {
  const logger = makeLogger();
  const service = makeService({
    config: makeConfig(),
    db: makeDb(async () => [{ pairId: 1, userText: "a", assistantText: "A", vector: [1, 0, 0, 0] }]),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger,
  });
  await service.search({ query: "secret token abc123" });
  assert.ok(logger.calls.debug.length >= 1, "a debug line must be emitted");
  for (const message of [...logger.calls.debug, ...logger.calls.warn]) {
    assert.ok(
      !message.includes("secret token abc123"),
      `log lines must not leak the query text: ${message}`,
    );
  }
});

test("propagates a caller abort instead of swallowing it", async () => {
  const controller = new AbortController();
  controller.abort();
  const embeddings = {
    async embed(_texts, { signal } = {}) {
      signal.throwIfAborted();
      return { vectors: [[1, 0, 0, 0]], model: "m", dimension: 4 };
    },
  };
  const service = makeService({
    config: makeConfig(),
    db: makeDb(async () => []),
    embeddings,
    logger: makeLogger(),
  });
  await assert.rejects(
    service.search({ query: "q", signal: controller.signal }),
    (err) => err.name === "AbortError",
  );
});

test("binds the caller signal with a timeout into one AbortSignal", async () => {
  let seenSignal = null;
  const embeddings = {
    async embed(_texts, { signal } = {}) {
      seenSignal = signal;
      return { vectors: [[1, 0, 0, 0]], model: "m", dimension: 4 };
    },
  };
  const service = makeService({
    config: makeConfig(),
    db: makeDb(async () => []),
    embeddings,
    logger: makeLogger(),
  });
  const controller = new AbortController();
  await service.search({ query: "q", signal: controller.signal });
  assert.ok(seenSignal instanceof AbortSignal);
});

test("reports stats with scope, kinds, model, dim, and latency", async () => {
  const service = makeService({
    config: makeConfig(),
    db: makeDb(async () => [{ pairId: 1, userText: "a", assistantText: "A", vector: [1, 0, 0, 0] }]),
    embeddings: makeEmbeddings([1, 0, 0, 0]),
    logger: makeLogger(),
  });
  const result = await service.search({ query: "q", limit: 1 });
  assert.deepEqual(result.stats.scope, { type: "all" });
  assert.deepEqual(result.stats.kinds, ["memory", "pair"]);
  assert.equal(result.stats.model, "m");
  assert.equal(result.stats.dim, 4);
  assert.equal(result.stats.candidateCount, 1);
  assert.equal(result.stats.returned, 1);
  assert.equal(result.stats.reranked, false);
  assert.equal(result.stats.rerankError, null);
  assert.equal(typeof result.stats.latencyMs, "number");
});

test("prefers the embed-returned model in stats", async () => {
  const embeddings = {
    async embed() {
      return { vectors: [[1, 0, 0, 0]], model: "embed-model", dimension: 4 };
    },
  };
  const service = makeService({
    config: makeConfig(),
    db: makeDb(async () => []),
    embeddings,
    logger: makeLogger(),
  });
  const result = await service.search({ query: "q" });
  assert.equal(result.stats.model, "embed-model");
});

test("uses the query vector length as dim when dimensions is not configured", async () => {
  const service = makeService({
    config: makeConfig({ embedding: { enabled: true, baseUrl: "http://embed", model: "m", dimensions: null } }),
    db: makeDb(async (args) => {
      assert.equal(args.dim, 3);
      return [];
    }),
    embeddings: makeEmbeddings([0.5, 0.5, 0.5]),
    logger: makeLogger(),
  });
  const result = await service.search({ query: "q" });
  assert.equal(result.stats.dim, 3);
});
