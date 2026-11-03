/**
 * Tests for the SQLite index database in `lib/db.js`.
 *
 * Requires `lib/paths.js` (for `textHash`) to be present; when it is absent,
 * these tests are deferred and the import below fails loudly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndexDatabase, vectorFromBlob, vectorToBlob } from "../lib/db.js";

/**
 * Open a fresh database in a temporary directory, cleaned up afterwards.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} [name] - Database file name.
 * @returns {Promise<{db: object, dir: string, file: string}>}
 */
async function makeDb(t, name = "index.db") {
  const dir = await mkdtemp(join(tmpdir(), "dsh-db-test-"));
  const file = join(dir, name);
  const db = openIndexDatabase(file);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { db, dir, file };
}

/** @returns {object} A valid pair record. */
function samplePair(overrides = {}) {
  return {
    pairId: "pair-1",
    sessionId: "session-1",
    cwd: "/work/project",
    turn: 3,
    createdAt: 1_700_000_000_000,
    user: "What is the build command?",
    assistant: "Run `npm run build`.",
    ...overrides,
  };
}

/** @returns {Float32Array} A small finite vector. */
function vector(values) {
  return new Float32Array(values);
}

test("db: openIndexDatabase creates schema, indexes, and schema_version", async (t) => {
  const { db, file, dir } = await makeDb(t);

  assert.equal(db.path, file);
  assert.equal(typeof db.raw, "object");
  assert.equal(typeof db.raw.prepare, "function");

  const tables = db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ["meta", "outbox", "pairs"]);

  const indexes = db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx%' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(indexes, ["idx_pairs_cwd_created_at", "idx_pairs_model_dim"]);

  assert.equal(db.metaGet("schema_version"), "1");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM pairs").get().n, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 0);
  // Parent directory was created on demand.
  assert.ok(dir.startsWith(join(tmpdir(), "dsh-db-test-")));
});

test("db: openIndexDatabase is idempotent on an existing file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-db-test-"));
  const file = join(dir, "index.db");
  const first = openIndexDatabase(file);
  first.metaSet("custom", "value");
  first.upsertPair(samplePair());
  first.close();

  const reopened = openIndexDatabase(file);
  t.after(async () => {
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  });

  assert.equal(reopened.metaGet("custom"), "value");
  assert.equal(reopened.metaGet("schema_version"), "1");
  assert.equal(reopened.stats().pairCount, 1);
});

test("db: vectorToBlob writes little-endian bytes and round-trips", () => {
  const values = [1, -2.5, 3.25, 0];
  const blob = vectorToBlob(vector(values));
  assert.ok(blob instanceof Uint8Array);
  assert.equal(blob.length, values.length * 4);

  // 1.0 -> 0x3F800000; -2.5 -> 0xC0200000; 3.25 -> 0x40500000; 0.0 -> 0.
  assert.deepEqual([...blob], [
    0x00, 0x00, 0x80, 0x3f,
    0x00, 0x00, 0x20, 0xc0,
    0x00, 0x00, 0x50, 0x40,
    0x00, 0x00, 0x00, 0x00,
  ]);

  const decoded = vectorFromBlob(blob, 4);
  assert.ok(decoded instanceof Float32Array);
  assert.deepEqual([...decoded], values);
});

test("db: vectorToBlob rejects invalid input", () => {
  assert.throws(() => vectorToBlob([1, 2]), TypeError);
  assert.throws(() => vectorToBlob(new Float32Array(0)), (err) => err instanceof RangeError && /empty/.test(err.message));
  assert.throws(
    () => vectorToBlob(new Float32Array([1, Number.NaN])),
    (err) => err instanceof RangeError && /non-finite/.test(err.message),
  );
  assert.throws(
    () => vectorToBlob(new Float32Array([1, Number.POSITIVE_INFINITY])),
    (err) => err instanceof RangeError && /non-finite/.test(err.message),
  );
});

test("db: vectorFromBlob rejects invalid input", () => {
  assert.throws(() => vectorFromBlob("not-a-blob", 2), TypeError);
  assert.throws(() => vectorFromBlob(new Uint8Array(4), 0), RangeError);
  assert.throws(() => vectorFromBlob(new Uint8Array(4), -1), RangeError);
  assert.throws(() => vectorFromBlob(new Uint8Array(8), 3), (err) => err instanceof RangeError && /length/.test(err.message));
  // Non-finite encoded bytes (0x7FC00000 = NaN).
  const nanBlob = new Uint8Array([0x00, 0x00, 0xc0, 0x7f]);
  assert.throws(() => vectorFromBlob(nanBlob, 1), (err) => err instanceof RangeError && /non-finite/.test(err.message));
});

test("db: upsertPair inserts new pairs and enqueues reason 'new'", async (t) => {
  const { db } = await makeDb(t);
  const record = samplePair();

  const returned = db.upsertPair(record);
  assert.deepEqual(returned, record);

  const pair = db.getPair("pair-1");
  assert.equal(pair.pairId, "pair-1");
  assert.equal(pair.sessionId, "session-1");
  assert.equal(pair.cwd, "/work/project");
  assert.equal(pair.turn, 3);
  assert.equal(pair.createdAt, 1_700_000_000_000);
  assert.equal(pair.userText, record.user);
  assert.equal(pair.assistantText, record.assistant);
  assert.equal(typeof pair.textHash, "string");
  assert.ok(pair.textHash.length > 0);
  assert.equal(pair.vector, null);
  assert.equal(pair.model, null);

  const due = db.claimDue(Date.now(), 10);
  assert.equal(due.length, 1);
  assert.deepEqual(due[0], { pairId: "pair-1", attempts: 0, reason: "new" });
});

test("db: upsertPair with same hash preserves embedding and refreshes metadata", async (t) => {
  const { db } = await makeDb(t);
  db.upsertPair(samplePair());
  db.setEmbedding("pair-1", vector([1, 2, 3]), { model: "m", dim: 3 });
  const hashBefore = db.getPair("pair-1").textHash;

  db.upsertPair(samplePair({ turn: 9, createdAt: 2_000_000_000_000 }));
  const pair = db.getPair("pair-1");

  assert.equal(pair.textHash, hashBefore);
  assert.equal(pair.turn, 9);
  assert.equal(pair.createdAt, 2_000_000_000_000);
  assert.deepEqual([...pair.vector], [1, 2, 3]);
  assert.equal(pair.model, "m");
  assert.equal(pair.dim, 3);
  // No new outbox work.
  assert.deepEqual(db.claimDue(Date.now(), 10), []);
});

test("db: upsertPair with changed hash clears embedding and enqueues 'text-changed'", async (t) => {
  const { db } = await makeDb(t);
  db.upsertPair(samplePair());
  db.setEmbedding("pair-1", vector([1, 2, 3]), { model: "m", dim: 3 });
  const hashBefore = db.getPair("pair-1").textHash;

  db.upsertPair(samplePair({ user: "Different user text", assistant: "Different reply" }));
  const pair = db.getPair("pair-1");

  assert.notEqual(pair.textHash, hashBefore);
  assert.equal(pair.vector, null);
  assert.equal(pair.model, null);
  assert.equal(pair.dim, null);
  assert.equal(pair.indexedAt, null);

  const due = db.claimDue(Date.now(), 10);
  assert.deepEqual(due, [{ pairId: "pair-1", attempts: 0, reason: "text-changed" }]);
});

test("db: changed-hash upsert resets outbox attempts", async (t) => {
  const { db } = await makeDb(t);
  db.upsertPair(samplePair());
  db.failPair("pair-1", { attempts: 4, nextAt: Date.now() + 60_000, error: "boom" });
  assert.equal(db.claimDue(Date.now(), 10).length, 0); // scheduled in the future

  db.upsertPair(samplePair({ user: "changed", assistant: "text" }));
  const due = db.claimDue(Date.now(), 10);
  assert.equal(due.length, 1);
  assert.equal(due[0].pairId, "pair-1");
  assert.equal(due[0].reason, "text-changed");
  assert.equal(due[0].attempts, 0); // reset
});

test("db: enqueue/claimDue/failPair/setEmbedding outbox lifecycle", async (t) => {
  const { db } = await makeDb(t);
  const now = 1_700_000_000_000;
  db.upsertPair(samplePair({ pairId: "a" }));
  db.upsertPair(samplePair({ pairId: "b", turn: 1 }));
  db.upsertPair(samplePair({ pairId: "c", turn: 2 }));

  // failPair schedules b and c in the future; a stays due.
  db.failPair("b", { attempts: 1, nextAt: now + 60_000, error: new Error("rate limited") });
  db.failPair("c", { attempts: 2, nextAt: now + 120_000, error: "server 500" });

  let due = db.claimDue(now, 10);
  assert.deepEqual(
    due.map((row) => row.pairId),
    ["a"],
  );
  assert.equal(due[0].attempts, 0);

  // b is not yet due before its next_at; a (next_at 0) still is.
  due = db.claimDue(now + 59_000, 10);
  assert.deepEqual(
    due.map((row) => row.pairId),
    ["a"],
  );

  // claimDue does not increment attempts.
  due = db.claimDue(now + 60_000, 10);
  assert.deepEqual(
    due.map((row) => row.pairId),
    ["a", "b"],
  );
  assert.equal(due.find((row) => row.pairId === "b").attempts, 1);

  // Ordered by next_at: a, b, c.
  due = db.claimDue(now + 120_000, 10);
  assert.deepEqual(
    due.map((row) => row.pairId),
    ["a", "b", "c"],
  );

  // Completing work removes the outbox entry.
  db.setEmbedding("a", vector([1]), { model: "m", dim: 1 });
  assert.equal(db.getPair("a").model, "m");
  assert.equal(db.getPair("a").indexedAt !== null, true);
  const remaining = db.claimDue(now + 999_000, 10);
  assert.deepEqual(
    remaining.map((row) => row.pairId),
    ["b", "c"],
  );
  assert.equal(db.stats().pendingCount, 2);
  assert.equal(db.stats().errorCount, 2);
});

test("db: failPair updates last_error and validates arguments", async (t) => {
  const { db } = await makeDb(t);
  db.upsertPair(samplePair());
  const now = Date.now();

  assert.equal(db.failPair("pair-1", { attempts: 1, nextAt: now + 1_000, error: new Error("nope") }), true);
  assert.equal(db.failPair("missing", { attempts: 0, nextAt: now }), false);

  assert.throws(() => db.failPair("pair-1", { attempts: -1, nextAt: now }), RangeError);
  assert.throws(() => db.failPair("pair-1", { attempts: 1.5, nextAt: now }), RangeError);
  assert.throws(() => db.failPair("pair-1", { attempts: 0, nextAt: Number.NaN }), RangeError);
});

test("db: reconcile deletes unseen pairs and their outbox entries", async (t) => {
  const { db } = await makeDb(t);
  db.upsertPair(samplePair({ pairId: "a", turn: 0 }));
  db.upsertPair(samplePair({ pairId: "b", turn: 1 }));
  db.upsertPair(samplePair({ pairId: "c", turn: 2 }));
  assert.equal(db.stats().pendingCount, 3);

  db.beginReconcile();
  db.markSeen("a");
  db.markSeen("b");
  db.markSeen("a"); // idempotent
  const counts = db.finishReconcile();

  assert.deepEqual(counts, { pairsDeleted: 1, outboxDeleted: 1 });
  assert.equal(db.getPair("a") !== null, true);
  assert.equal(db.getPair("b") !== null, true);
  assert.equal(db.getPair("c"), null);
  assert.equal(db.stats().pendingCount, 2);

  // A new pass clears the seen set.
  db.beginReconcile();
  assert.deepEqual(db.finishReconcile(), { pairsDeleted: 2, outboxDeleted: 2 });
  assert.equal(db.stats().pairCount, 0);
});

test("db: deletePair removes pair and outbox entry", async (t) => {
  const { db } = await makeDb(t);
  db.upsertPair(samplePair({ pairId: "a" }));
  db.upsertPair(samplePair({ pairId: "b" }));

  assert.equal(db.deletePair("a"), true);
  assert.equal(db.getPair("a"), null);
  assert.equal(db.getPair("b") !== null, true);
  assert.equal(db.deletePair("a"), false); // already gone
  assert.equal(db.stats().pendingCount, 1);
});

test("db: setEmbedding validates vector length and model", async (t) => {
  const { db } = await makeDb(t);
  db.upsertPair(samplePair());

  assert.throws(() => db.setEmbedding("pair-1", vector([1, 2]), { model: "m", dim: 3 }), RangeError);
  assert.throws(() => db.setEmbedding("pair-1", vector([1, 2, 3]), { model: "", dim: 3 }), TypeError);
  assert.throws(() => db.setEmbedding("pair-1", vector([1, 2, 3]), { model: "m", dim: 0 }), RangeError);
  assert.throws(() => db.setEmbedding("pair-1", [1, 2, 3], { model: "m", dim: 3 }), RangeError);
  // Vector with non-finite values is rejected via the blob encoder.
  assert.throws(
    () => db.setEmbedding("pair-1", new Float32Array([1, Number.NaN]), { model: "m", dim: 2 }),
    RangeError,
  );
  assert.equal(db.getPair("pair-1").vector, null);
});

test("db: candidates filters by scope, model, and dim, ordered by created_at", async (t) => {
  const { db } = await makeDb(t);
  const now = 1_700_000_000_000;
  db.upsertPair(samplePair({ pairId: "w1a", cwd: "/w1", turn: 0, createdAt: now }));
  db.upsertPair(samplePair({ pairId: "w1b", cwd: "/w1", turn: 1, createdAt: now + 100 }));
  db.upsertPair(samplePair({ pairId: "w2a", cwd: "/w2", turn: 0, createdAt: now + 200 }));
  db.upsertPair(samplePair({ pairId: "unindexed", cwd: "/w1", turn: 2, createdAt: now + 300 }));

  db.setEmbedding("w1a", vector([1, 2, 3]), { model: "m1", dim: 3 });
  db.setEmbedding("w1b", vector([4, 5, 6]), { model: "m1", dim: 3 });
  db.setEmbedding("w2a", vector([7, 8, 9]), { model: "m2", dim: 3 });

  // Workspace scope filters by cwd, excludes unindexed rows, newest first.
  const ws = db.candidates({ scope: "workspace", cwd: "/w1", model: "m1", dim: 3, limit: 10 });
  assert.deepEqual(
    ws.map((c) => c.pairId),
    ["w1b", "w1a"],
  );
  assert.deepEqual([...ws[0].vector], [4, 5, 6]);
  assert.equal(ws[0].userText, "What is the build command?");
  assert.equal(ws[0].assistantText, "Run `npm run build`.");
  assert.equal(ws[0].sessionId, "session-1");

  // "all" scope ignores cwd.
  const all = db.candidates({ scope: "all", model: "m1", dim: 3, limit: 10 });
  assert.deepEqual(
    all.map((c) => c.pairId),
    ["w1b", "w1a"],
  );

  // Model/dim filter excludes m2 rows.
  const m2 = db.candidates({ scope: "all", model: "m2", dim: 3, limit: 10 });
  assert.deepEqual(
    m2.map((c) => c.pairId),
    ["w2a"],
  );

  // Unindexed pair never appears.
  const ids = db.candidates({ scope: "all", model: "m1", dim: 3, limit: 10 }).map((c) => c.pairId);
  assert.ok(!ids.includes("unindexed"));

  // limit is honored.
  const limited = db.candidates({ scope: "workspace", cwd: "/w1", model: "m1", dim: 3, limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].pairId, "w1b");

  // Workspace scope without cwd is rejected.
  assert.throws(() => db.candidates({ scope: "workspace", model: "m1", dim: 3, limit: 10 }), TypeError);
  assert.throws(() => db.candidates({ scope: "all", model: "", dim: 3 }), TypeError);
  assert.throws(() => db.candidates({ scope: "all", model: "m1", dim: 0 }), RangeError);
});

test("db: candidates returns an empty list when nothing matches", async (t) => {
  const { db } = await makeDb(t);
  db.upsertPair(samplePair());
  assert.deepEqual(db.candidates({ scope: "all", model: "m", dim: 3, limit: 10 }), []);
});

test("db: metaGet/metaSet round-trip and overwrite", async (t) => {
  const { db } = await makeDb(t);
  assert.equal(db.metaGet("missing"), null);
  assert.equal(db.metaSet("key", "v1"), "v1");
  assert.equal(db.metaGet("key"), "v1");
  assert.equal(db.metaSet("key", "v2"), "v2");
  assert.equal(db.metaGet("key"), "v2");
  assert.equal(db.metaGet("schema_version"), "1");
});

test("db: clearIndex drops embeddings and outbox but keeps meta", async (t) => {
  const { db } = await makeDb(t);
  db.upsertPair(samplePair({ pairId: "a" }));
  db.upsertPair(samplePair({ pairId: "b" }));
  db.setEmbedding("a", vector([1, 2]), { model: "m", dim: 2 });
  db.setEmbedding("b", vector([3, 4]), { model: "m", dim: 2 });
  db.metaSet("custom", "keep");

  const result = db.clearIndex();
  assert.deepEqual(result, { pairsCleared: 2 });
  assert.equal(db.getPair("a").vector, null);
  assert.equal(db.getPair("b").model, null);
  assert.equal(db.stats().indexedCount, 0);
  assert.equal(db.stats().pendingCount, 0);
  assert.equal(db.metaGet("custom"), "keep");
  assert.equal(db.metaGet("schema_version"), "1");
  assert.equal(db.stats().pairCount, 2);
});

test("db: reindexAll clears and re-enqueues every pair", async (t) => {
  const { db } = await makeDb(t);
  db.upsertPair(samplePair({ pairId: "a" }));
  db.upsertPair(samplePair({ pairId: "b" }));
  db.setEmbedding("a", vector([1, 2]), { model: "m", dim: 2 });
  db.setEmbedding("b", vector([3, 4]), { model: "m", dim: 2 });

  const result = db.reindexAll();
  assert.deepEqual(result, { queued: 2 });
  assert.equal(db.getPair("a").vector, null);
  assert.equal(db.stats().indexedCount, 0);
  assert.equal(db.stats().pendingCount, 2);

  const due = db.claimDue(Date.now(), 10);
  assert.deepEqual(
    due.map((row) => row.reason),
    ["reindex", "reindex"],
  );
});

test("db: stats reports counts and dominant model/dim", async (t) => {
  const { db } = await makeDb(t);
  assert.deepEqual(db.stats(), {
    pairCount: 0,
    indexedCount: 0,
    pendingCount: 0,
    errorCount: 0,
    model: null,
    dim: null,
  });

  db.upsertPair(samplePair({ pairId: "a", turn: 0 }));
  db.upsertPair(samplePair({ pairId: "b", turn: 1 }));
  db.upsertPair(samplePair({ pairId: "c", turn: 2 }));
  db.setEmbedding("a", vector([1]), { model: "m1", dim: 1 });
  db.setEmbedding("b", vector([2]), { model: "m1", dim: 1 });
  db.setEmbedding("c", vector([3, 4]), { model: "m2", dim: 2 });
  // setEmbedding cleared the outbox; re-queue a and fail it.
  db.enqueue("a", "new");
  db.failPair("a", { attempts: 1, nextAt: Date.now() + 1_000, error: "x" });

  const stats = db.stats();
  assert.equal(stats.pairCount, 3);
  assert.equal(stats.indexedCount, 3);
  assert.equal(stats.pendingCount, 1); // only a is queued again after its failure
  assert.equal(stats.errorCount, 1);
  assert.equal(stats.model, "m1"); // most common (model, dim)
  assert.equal(stats.dim, 1);
});

test("db: getPair returns null for a missing pair", async (t) => {
  const { db } = await makeDb(t);
  assert.equal(db.getPair("nope"), null);
});

test("db: claimDue defaults limit and orders deterministically", async (t) => {
  const { db } = await makeDb(t);
  db.upsertPair(samplePair({ pairId: "a", turn: 0 }));
  db.upsertPair(samplePair({ pairId: "b", turn: 1 }));
  const now = Date.now();
  const due = db.claimDue(now); // no limit argument
  assert.deepEqual(
    due.map((row) => row.pairId),
    ["a", "b"],
  );
  const limited = db.claimDue(now, 1);
  assert.equal(limited.length, 1);
});

test("db: enqueueAll updates reasons and keeps attempts", async (t) => {
  const { db } = await makeDb(t);
  db.upsertPair(samplePair({ pairId: "a" }));
  db.failPair("a", { attempts: 3, nextAt: Date.now() - 100, error: "err" });

  const changes = db.enqueueAll("rebuild");
  assert.equal(changes, 1);

  const due = db.claimDue(Date.now(), 10);
  assert.equal(due.length, 1);
  assert.equal(due[0].reason, "rebuild");
  assert.equal(due[0].attempts, 3); // preserved
});
