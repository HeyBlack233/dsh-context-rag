/**
 * Tests for the embedding indexer in `lib/indexer.js`.
 *
 * No network is used: the index database is an in-memory fake mirroring the
 * `lib/db.js` contract, and the embedding client is a fake returning canned
 * vectors (or throwing).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIndexer } from "../lib/indexer.js";
import { appendPair } from "../lib/pairs.js";
import { buildEmbeddingText } from "../lib/text.js";

/** @param {number} ms @returns {Promise<void>} */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a fresh temporary home directory, cleaned up after the test.
 *
 * @param {import("node:test").TestContext} t
 * @returns {Promise<string>}
 */
async function makeHome(t) {
  const home = await mkdtemp(join(tmpdir(), "dsh-indexer-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

/**
 * In-memory fake of the `lib/db.js` handle, mirroring the subset of methods
 * the indexer uses. `calls` records every method invocation in order;
 * `throwOn` makes a named method throw `"<name> boom"`.
 */
class FakeDb {
  constructor() {
    this.pairs = new Map();
    this.outbox = new Map();
    this.meta = new Map();
    this.seen = new Set();
    this.calls = [];
    this.throwOn = new Set();
  }

  _maybeThrow(name) {
    if (this.throwOn.has(name)) {
      throw new Error(`${name} boom`);
    }
  }

  beginReconcile() {
    this._maybeThrow("beginReconcile");
    this.calls.push("beginReconcile");
    this.seen = new Set();
  }

  markSeen(pairId) {
    this.calls.push("markSeen");
    this.seen.add(pairId);
  }

  finishReconcile() {
    this.calls.push("finishReconcile");
    let pairsDeleted = 0;
    let outboxDeleted = 0;
    for (const pairId of [...this.pairs.keys()]) {
      if (!this.seen.has(pairId)) {
        this.pairs.delete(pairId);
        if (this.outbox.delete(pairId)) {
          outboxDeleted += 1;
        }
        pairsDeleted += 1;
      }
    }
    return { pairsDeleted, outboxDeleted };
  }

  upsertPair(record) {
    this.calls.push("upsertPair");
    const existing = this.pairs.get(record.pairId);
    this.pairs.set(record.pairId, {
      pairId: record.pairId,
      userText: record.user,
      assistantText: record.assistant,
      recordType: "pair",
      embedding: existing?.embedding ?? null,
      model: existing?.model ?? null,
      dim: existing?.dim ?? null,
    });
    if (!existing) {
      this.outbox.set(record.pairId, { reason: "new", attempts: 0, nextAt: 0, lastError: null });
    }
    return record;
  }

  upsertMemory(record) {
    this.calls.push("upsertMemory");
    // Mirror the real db.js validation so malformed records throw here too,
    // letting reconcile's skip path be exercised.
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError("memory record must be a plain object");
    }
    if (typeof record.pairId !== "string" || record.pairId.trim().length === 0) {
      throw new TypeError("memory pairId must be a non-empty string");
    }
    if (typeof record.content !== "string") {
      throw new TypeError("memory content must be a string");
    }
    const existing = this.pairs.get(record.pairId);
    this.pairs.set(record.pairId, {
      pairId: record.pairId,
      userText: record.content,
      assistantText: "",
      recordType: "memory",
      memoryType: record.memoryType ?? "workspace",
      name: record.name ?? "",
      embedding: existing?.embedding ?? null,
      model: existing?.model ?? null,
      dim: existing?.dim ?? null,
    });
    if (!existing) {
      this.outbox.set(record.pairId, { reason: "new", attempts: 0, nextAt: 0, lastError: null });
    }
    return record;
  }

  getPair(pairId) {
    const pair = this.pairs.get(pairId);
    if (!pair) return null;
    return {
      pairId,
      userText: pair.userText,
      assistantText: pair.assistantText,
      recordType: pair.recordType ?? "pair",
      memoryType: pair.memoryType ?? null,
      name: pair.name ?? "",
    };
  }

  claimDue(now, limit) {
    this._maybeThrow("claimDue");
    this.calls.push("claimDue");
    return [...this.outbox.entries()]
      .filter(([, row]) => row.nextAt <= now)
      .sort((a, b) => (a[1].nextAt - b[1].nextAt) || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([pairId, row]) => ({ pairId, attempts: row.attempts, reason: row.reason }));
  }

  setEmbedding(pairId, vector, { model, dim }) {
    this.calls.push("setEmbedding");
    const pair = this.pairs.get(pairId);
    if (pair) {
      pair.embedding = vector;
      pair.model = model;
      pair.dim = dim;
    }
    this.outbox.delete(pairId);
  }

  failPair(pairId, { attempts, nextAt, error }) {
    this.calls.push("failPair");
    const row = this.outbox.get(pairId);
    if (row) {
      row.attempts = attempts;
      row.nextAt = nextAt;
      row.lastError = error instanceof Error ? error.message : String(error);
      return true;
    }
    return false;
  }

  metaGet(key) {
    return this.meta.get(key) ?? null;
  }

  metaSet(key, value) {
    this.meta.set(key, String(value));
    return String(value);
  }

  clearIndex() {
    this.calls.push("clearIndex");
    let pairsCleared = 0;
    for (const pair of this.pairs.values()) {
      pair.embedding = null;
      pair.model = null;
      pair.dim = null;
      pairsCleared += 1;
    }
    this.outbox.clear();
    return { pairsCleared };
  }

  enqueueAll(reason) {
    this.calls.push("enqueueAll");
    let queued = 0;
    for (const pairId of this.pairs.keys()) {
      if (!this.outbox.has(pairId)) {
        this.outbox.set(pairId, { reason, attempts: 0, nextAt: 0, lastError: null });
        queued += 1;
      }
    }
    return queued;
  }

  reindexAll(reason) {
    this.calls.push("reindexAll");
    this.clearIndex();
    return { queued: this.enqueueAll(reason) };
  }
}

/**
 * Seed one pair and a due outbox row into a fake db.
 *
 * @param {FakeDb} db
 * @param {string} pairId
 * @param {string} userText
 * @param {string} assistantText
 * @param {object} [options]
 * @param {number} [options.attempts]
 * @param {number} [options.nextAt]
 */
function seed(db, pairId, userText, assistantText, { attempts = 0, nextAt = 0 } = {}) {
  db.pairs.set(pairId, { pairId, userText, assistantText, embedding: null, model: null, dim: null });
  db.outbox.set(pairId, { reason: "new", attempts, nextAt, lastError: null });
}

/**
 * Build a config object with `embedding` and `indexing` sections, defaulting
 * to enabled values the tests can override. Flat overrides are routed to the
 * section that owns the key: `model`, `baseUrl`, `batchSize`, and
 * `maxEmbeddingChars` go to `embedding`; `enabled`, `pollIntervalMs`,
 * `retryDelayMs`, and `maxAttempts` go to `indexing`.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function makeConfig(overrides = {}) {
  const embedding = {
    model: "text-embedding-3-small",
    baseUrl: "http://example.invalid/",
    batchSize: 8,
    maxEmbeddingChars: 8000,
  };
  const indexing = {
    enabled: true,
    pollIntervalMs: 50,
    retryDelayMs: 100,
    maxAttempts: 3,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "enabled" || key === "pollIntervalMs" || key === "retryDelayMs" || key === "maxAttempts") {
      indexing[key] = value;
    } else {
      embedding[key] = value;
    }
  }
  return { embedding, indexing };
}

/**
 * Config that keeps the embedding model configured but disables indexing via
 * the real `indexing.enabled` switch, proving that switch is the gate that
 * stops pumping.
 *
 * @returns {object}
 */
function disabledConfig() {
  return {
    embedding: { model: "text-embedding-3-small", batchSize: 8 },
    indexing: { enabled: false },
  };
}

/**
 * Fake embedding client recording every call.
 *
 * @param {object} [options]
 * @param {number[][]} [options.vectors]
 * @param {string} [options.model]
 * @param {number} [options.dimension]
 * @param {Error|null} [options.failure]
 * @returns {{calls: Array<{texts: string[]}>, embed: Function}}
 */
function fakeEmbeddings({ vectors = [[1, 2]], model = "text-embedding-3-small", dimension = 2, failure = null } = {}) {
  const calls = [];
  return {
    calls,
    async embed(texts) {
      calls.push({ texts });
      if (failure) {
        throw failure;
      }
      return { vectors, model, dimension };
    },
  };
}

/** @param {string} pairId @param {object} [overrides] @returns {object} A valid pair record. */
function sampleRecord(pairId, overrides = {}) {
  return {
    pairId,
    sessionId: `s-${pairId}`,
    cwd: "/work/proj",
    turn: 0,
    createdAt: 1,
    user: `user ${pairId}`,
    assistant: `assistant ${pairId}`,
    ...overrides,
  };
}

/** @param {string} pairId @param {object} [overrides] @returns {object} A valid memory record. */
function sampleMemoryRecord(pairId, overrides = {}) {
  return {
    pairId,
    recordType: "memory",
    memoryType: "workspace",
    type: "note",
    name: `memory ${pairId}`,
    description: "",
    content: `content ${pairId}`,
    cwd: "/work/proj",
    createdAt: 1,
    ...overrides,
  };
}

test("indexer: reconcile upserts disk pairs, marks them seen, and drops missing pairs", async (t) => {
  const home = await makeHome(t);
  await appendPair(join(home, "pairs", "w", "s1.jsonl"), sampleRecord("p1", { user: "u1", assistant: "a1" }));
  await appendPair(join(home, "pairs", "w", "s1.jsonl"), sampleRecord("p2", { user: "u2", assistant: "a2" }));

  const db = new FakeDb();
  db.upsertPair(sampleRecord("p3", { user: "u3", assistant: "a3" })); // Indexed but gone from disk.
  const configStore = { home, get: () => makeConfig() };
  const indexer = createIndexer({
    db,
    configStore,
    embeddings: fakeEmbeddings(),
    logger: null,
    home,
  });

  await indexer.reconcile();

  assert.ok(db.pairs.has("p1"), "p1 must be upserted");
  assert.ok(db.pairs.has("p2"), "p2 must be upserted");
  assert.ok(!db.pairs.has("p3"), "p3 must be deleted by finishReconcile");
  assert.deepEqual(db.meta.get("embedding_model"), "text-embedding-3-small");
  assert.deepEqual(
    [...db.outbox.values()].map((row) => row.reason),
    ["model-changed", "model-changed"],
    "clearIndex + enqueueAll('model-changed') must re-queue the surviving pairs",
  );
  assert.equal(indexer.status().reconcileError, null);
});

test("indexer: reconcile only runs the model change once", async (t) => {
  const home = await makeHome(t);
  const db = new FakeDb();
  const indexer = createIndexer({
    db,
    configStore: { home, get: () => makeConfig() },
    embeddings: fakeEmbeddings(),
    logger: null,
    home,
  });

  await indexer.reconcile();
  const clearCalls = db.calls.filter((call) => call === "clearIndex").length;
  const enqueueCalls = db.calls.filter((call) => call === "enqueueAll").length;
  assert.equal(clearCalls, 1);

  await indexer.reconcile();
  assert.equal(db.calls.filter((call) => call === "clearIndex").length, clearCalls, "no second clear");
  assert.equal(db.calls.filter((call) => call === "enqueueAll").length, enqueueCalls, "no second enqueue");
});

test("indexer: reconcile skips the model change when no model is configured", async (t) => {
  const home = await makeHome(t);
  const db = new FakeDb();
  const indexer = createIndexer({
    db,
    configStore: { home, get: () => makeConfig({ model: "" }) },
    embeddings: fakeEmbeddings(),
    logger: null,
    home,
  });

  await indexer.reconcile();

  assert.equal(db.calls.filter((call) => call === "clearIndex").length, 0);
  assert.equal(db.meta.has("embedding_model"), false);
  assert.equal(indexer.status().reconcileError, null);
});

test("indexer: concurrent reconciles share one in-flight pass", async (t) => {
  const home = await makeHome(t);
  const db = new FakeDb();
  const indexer = createIndexer({
    db,
    configStore: { home, get: () => makeConfig() },
    embeddings: fakeEmbeddings(),
    logger: null,
    home,
  });

  const first = indexer.reconcile();
  const second = indexer.reconcile();
  assert.strictEqual(first, second, "concurrent calls must share the promise");
  await first;
  assert.equal(db.calls.filter((call) => call === "beginReconcile").length, 1);
});

test("indexer: reconcile failures are recorded, never thrown", async (t) => {
  const home = await makeHome(t);
  const db = new FakeDb();
  db.throwOn.add("beginReconcile");
  const indexer = createIndexer({
    db,
    configStore: { home, get: () => makeConfig() },
    embeddings: fakeEmbeddings(),
    logger: null,
    home,
  });

  await indexer.reconcile(); // Must resolve.
  assert.ok(indexer.status().reconcileError, "reconcileError must be set");
  assert.ok(indexer.status().reconcileError.includes("beginReconcile boom"));
});

test("indexer: pumpOnce embeds a batch and stores vectors", async (t) => {
  const home = await makeHome(t);
  const db = new FakeDb();
  seed(db, "p1", "hello", "world");
  seed(db, "p2", "foo", "bar");
  seed(db, "p3", "baz", "qux");
  const embeddings = fakeEmbeddings({
    vectors: [[1, 2], [3, 4], [5, 6]],
    model: "text-embedding-3-small",
    dimension: 2,
  });
  const indexer = createIndexer({
    db,
    configStore: { home, get: () => makeConfig() },
    embeddings,
    logger: null,
    home,
  });

  const processed = await indexer.pumpOnce();

  assert.equal(processed, 3);
  assert.equal(embeddings.calls.length, 1, "one batched embed call");
  assert.deepEqual(embeddings.calls[0].texts, [
    buildEmbeddingText({ user: "hello", assistant: "world" }, 8000),
    buildEmbeddingText({ user: "foo", assistant: "bar" }, 8000),
    buildEmbeddingText({ user: "baz", assistant: "qux" }, 8000),
  ]);
  for (const [pairId, vector] of [["p1", [1, 2]], ["p2", [3, 4]], ["p3", [5, 6]]]) {
    const pair = db.pairs.get(pairId);
    assert.ok(pair.embedding instanceof Float32Array, `${pairId} stores a Float32Array`);
    assert.deepEqual([...pair.embedding], vector);
    assert.equal(pair.model, "text-embedding-3-small");
    assert.equal(pair.dim, 2);
  }
  assert.equal(db.outbox.size, 0, "outbox entries must be cleared on success");
});

test("indexer: pumpOnce applies exponential backoff on failure", async (t) => {
  const db = new FakeDb();
  seed(db, "p1", "hello", "world", { attempts: 1, nextAt: 0 });
  const embeddings = fakeEmbeddings({ failure: new Error("boom") });
  const indexer = createIndexer({
    db,
    configStore: { home: "/tmp", get: () => makeConfig() },
    embeddings,
    logger: null,
    home: "/tmp",
  });

  const before = Date.now();
  const processed = await indexer.pumpOnce();

  assert.equal(processed, 1);
  const row = db.outbox.get("p1");
  assert.equal(row.attempts, 2, "attempts must increment");
  assert.equal(row.lastError, "boom");
  // attempts=2 (< maxAttempts=3) -> delay = retryDelayMs * 2^2 = 400.
  const delay = 100 * 2 ** 2;
  assert.ok(
    Math.abs(row.nextAt - delay - before) < 50,
    `nextAt ${row.nextAt} should be about ${before + delay}`,
  );
});

test("indexer: pumpOnce pauses 24h once maxAttempts is reached", async (t) => {
  const db = new FakeDb();
  seed(db, "p1", "hello", "world", { attempts: 2, nextAt: 0 }); // maxAttempts = 3.
  const embeddings = fakeEmbeddings({ failure: new Error("boom") });
  const indexer = createIndexer({
    db,
    configStore: { home: "/tmp", get: () => makeConfig() },
    embeddings,
    logger: null,
    home: "/tmp",
  });

  const before = Date.now();
  await indexer.pumpOnce();

  const row = db.outbox.get("p1");
  assert.equal(row.attempts, 3);
  const pause = 24 * 60 * 60 * 1000;
  assert.ok(
    Math.abs(row.nextAt - pause - before) < 50,
    `nextAt ${row.nextAt} should be about ${before + pause}`,
  );
});

test("indexer: backoff delay is capped at one hour", async (t) => {
  const db = new FakeDb();
  seed(db, "p1", "hello", "world", { attempts: 0, nextAt: 0 });
  const embeddings = fakeEmbeddings({ failure: new Error("boom") });
  const indexer = createIndexer({
    db,
    configStore: { home: "/tmp", get: () => makeConfig({ retryDelayMs: 1e12 }) },
    embeddings,
    logger: null,
    home: "/tmp",
  });

  const before = Date.now();
  await indexer.pumpOnce();

  const row = db.outbox.get("p1");
  assert.equal(row.attempts, 1);
  const cap = 60 * 60 * 1000;
  assert.ok(
    Math.abs(row.nextAt - cap - before) < 50,
    `nextAt ${row.nextAt} should be about ${before + cap}`,
  );
});

test("indexer: pumpOnce is a no-op when disabled or model-less", async (t) => {
  const db = new FakeDb();
  seed(db, "p1", "hello", "world");

  // The embedding model is configured; `indexing.enabled: false` is the only
  // reason pumpOnce must be a no-op.
  const disabled = createIndexer({
    db,
    configStore: { home: "/tmp", get: () => disabledConfig() },
    embeddings: fakeEmbeddings(),
    logger: null,
    home: "/tmp",
  });
  assert.equal(await disabled.pumpOnce(), 0);

  const modelless = createIndexer({
    db,
    configStore: { home: "/tmp", get: () => makeConfig({ model: "" }) },
    embeddings: fakeEmbeddings(),
    logger: null,
    home: "/tmp",
  });
  assert.equal(await modelless.pumpOnce(), 0);

  assert.equal(db.calls.filter((call) => call === "claimDue").length, 0, "claimDue must not run");
  assert.equal(db.outbox.size, 1, "nothing must be processed");
});

test("indexer: start/stop drive the loop and status reflects it", async (t) => {
  const db = new FakeDb();
  const indexer = createIndexer({
    db,
    configStore: { home: "/tmp", get: () => disabledConfig() },
    embeddings: fakeEmbeddings(),
    logger: null,
    home: "/tmp",
  });

  assert.deepEqual(indexer.status(), { running: false, lastError: null, reconcileError: null });

  const loop = indexer.start();
  assert.equal(indexer.status().running, true);
  assert.strictEqual(indexer.start(), loop, "start must be idempotent while running");

  await indexer.stop();
  assert.equal(indexer.status().running, false);
  assert.equal(indexer.status().lastError, null);
});

test("indexer: loop failures are captured in lastError", async (t) => {
  const db = new FakeDb();
  db.throwOn.add("claimDue");
  const indexer = createIndexer({
    db,
    configStore: { home: "/tmp", get: () => makeConfig() },
    embeddings: fakeEmbeddings(),
    logger: null,
    home: "/tmp",
  });

  indexer.start();
  await delay(30); // Let the loop hit the failing claimDue.
  assert.ok(indexer.status().lastError, "lastError must be set");
  assert.ok(indexer.status().lastError.includes("claimDue boom"));
  await indexer.stop();
});

test("indexer: reindex and clear drive the database", async (t) => {
  const db = new FakeDb();
  seed(db, "p1", "hello", "world");
  seed(db, "p2", "foo", "bar");
  const indexer = createIndexer({
    db,
    configStore: { home: "/tmp", get: () => makeConfig() },
    embeddings: fakeEmbeddings(),
    logger: null,
    home: "/tmp",
  });

  const reindexResult = indexer.reindex();
  assert.deepEqual(reindexResult, { queued: 2 });
  assert.ok(db.calls.includes("reindexAll"));
  assert.deepEqual(
    [...db.outbox.values()].map((row) => row.reason),
    ["reindex", "reindex"],
  );

  const clearResult = indexer.clear();
  assert.deepEqual(clearResult, { cleared: true });
  assert.equal(db.outbox.size, 0);
});

// ---------------------------------------------------------------------------
// Memories: reconcile syncs the memory store and pumpOnce embeds content.
// ---------------------------------------------------------------------------

test("indexer: reconcile syncs memoryStore records and drops forgotten ones", async (t) => {
  const home = await makeHome(t);
  await appendPair(join(home, "pairs", "w", "s1.jsonl"), sampleRecord("p1", { user: "u1", assistant: "a1" }));

  const db = new FakeDb();
  // Indexed but absent from the scan: must be dropped by finishReconcile.
  db.upsertMemory(sampleMemoryRecord("m-gone"));
  const memoryStore = {
    scan: async () => [
      sampleMemoryRecord("m1", { memoryType: "global", name: "Global note", content: "global content" }),
      sampleMemoryRecord("m2", { memoryType: "workspace", content: "workspace content" }),
    ],
  };
  const indexer = createIndexer({
    db,
    configStore: { home, get: () => makeConfig() },
    embeddings: fakeEmbeddings(),
    logger: null,
    home,
    memoryStore,
  });

  await indexer.reconcile();

  assert.ok(db.pairs.has("p1"), "p1 must be upserted from the JSONL store");
  assert.ok(db.pairs.has("m1"), "m1 must be upserted from the memory store");
  assert.ok(db.pairs.has("m2"), "m2 must be upserted from the memory store");
  assert.ok(!db.pairs.has("m-gone"), "m-gone must be deleted by finishReconcile");
  assert.equal(db.pairs.get("m1").userText, "global content");
  assert.equal(db.pairs.get("m1").memoryType, "global");
  assert.equal(db.pairs.get("m1").name, "Global note");
  assert.equal(db.pairs.get("m2").recordType, "memory");
  // Every surviving record was marked seen; the model change re-queues all of them.
  assert.deepEqual(
    [...db.outbox.values()].map((row) => row.reason),
    ["model-changed", "model-changed", "model-changed"],
  );
  assert.equal(indexer.status().reconcileError, null);
});

test("indexer: reconcile without a memoryStore never calls upsertMemory", async (t) => {
  const home = await makeHome(t);
  const db = new FakeDb();
  const indexer = createIndexer({
    db,
    configStore: { home, get: () => makeConfig() },
    embeddings: fakeEmbeddings(),
    logger: null,
    home,
  });

  await indexer.reconcile();

  assert.equal(db.calls.filter((call) => call === "upsertMemory").length, 0);
  assert.equal(indexer.status().reconcileError, null);
});

test("indexer: reconcile accepts a sync array from memoryStore.scan and skips invalid records", async (t) => {
  const home = await makeHome(t);
  const db = new FakeDb();
  const warns = [];
  const memoryStore = {
    // A plain array (not a promise, not a generator) must also work.
    scan: () => [
      sampleMemoryRecord("m1", { content: "ok content" }),
      { pairId: "m-bad", content: 42 }, // invalid: skipped with a warning
    ],
  };
  const indexer = createIndexer({
    db,
    configStore: { home, get: () => makeConfig() },
    embeddings: fakeEmbeddings(),
    logger: { warn: (m) => warns.push(m) },
    home,
    memoryStore,
  });

  await indexer.reconcile();

  assert.ok(db.pairs.has("m1"), "the valid memory must be upserted");
  assert.ok(!db.pairs.has("m-bad"), "the invalid memory must be skipped");
  assert.ok(warns.some((m) => m.includes("skipping invalid memory record m-bad")));
  assert.equal(indexer.status().reconcileError, null);
});

test("indexer: pumpOnce embeds memory content without the User/Assistant wrapper", async (t) => {
  const home = await makeHome(t);
  const db = new FakeDb();
  db.upsertMemory(sampleMemoryRecord("m1", { content: "plain memory content" }));
  const embeddings = fakeEmbeddings({
    vectors: [[1, 2]],
    model: "text-embedding-3-small",
    dimension: 2,
  });
  const indexer = createIndexer({
    db,
    configStore: { home, get: () => makeConfig() },
    embeddings,
    logger: null,
    home,
  });

  const processed = await indexer.pumpOnce();

  assert.equal(processed, 1);
  assert.equal(embeddings.calls.length, 1);
  assert.deepEqual(embeddings.calls[0].texts, ["plain memory content"]);
  const pair = db.pairs.get("m1");
  assert.ok(pair.embedding instanceof Float32Array);
  assert.deepEqual([...pair.embedding], [1, 2]);
  assert.equal(pair.model, "text-embedding-3-small");
  assert.equal(db.outbox.size, 0);
});

test("indexer: pumpOnce applies maxEmbeddingChars to memory content", async (t) => {
  const home = await makeHome(t);
  const db = new FakeDb();
  db.upsertMemory(sampleMemoryRecord("m1", { content: "x".repeat(300) }));
  const embeddings = fakeEmbeddings({ vectors: [[1]], dimension: 1 });
  const indexer = createIndexer({
    db,
    configStore: { home, get: () => makeConfig({ maxEmbeddingChars: 100 }) },
    embeddings,
    logger: null,
    home,
  });

  await indexer.pumpOnce();

  assert.equal(embeddings.calls.length, 1);
  assert.equal(embeddings.calls[0].texts[0].length, 100);
  assert.ok(!embeddings.calls[0].texts[0].includes("User:"));
});

test("indexer: pumpOnce mixes pair and memory rows in one batch", async (t) => {
  const home = await makeHome(t);
  const db = new FakeDb();
  seed(db, "p1", "hello", "world");
  db.upsertMemory(sampleMemoryRecord("m1", { content: "memory body" }));
  const embeddings = fakeEmbeddings({
    vectors: [[1], [2]],
    model: "text-embedding-3-small",
    dimension: 1,
  });
  const indexer = createIndexer({
    db,
    configStore: { home, get: () => makeConfig() },
    embeddings,
    logger: null,
    home,
  });

  const processed = await indexer.pumpOnce();

  assert.equal(processed, 2);
  assert.equal(embeddings.calls.length, 1);
  // Outbox order is deterministic by (next_at, pair_id): "m1" sorts before "p1".
  assert.deepEqual(embeddings.calls[0].texts, [
    "memory body",
    buildEmbeddingText({ user: "hello", assistant: "world" }, 8000),
  ]);
  assert.equal(db.outbox.size, 0);
});
