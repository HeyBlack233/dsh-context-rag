/**
 * Tests for the read-only browse/audit service in `lib/browse.js`.
 *
 * Uses a real temporary home (JSONL pair files + Markdown memories) and a
 * real SQLite index, so status classification, scope filtering, pagination,
 * detail reads, and the audit behave exactly as in production. No network is
 * used; every fixture lives in a temp directory and is cleaned up afterwards.
 *
 * Plain ESM, `node:test` + `node:assert/strict`. Requires Node >= 22.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { computeStatus, createBrowseService } from "../lib/browse.js";
import { openIndexDatabase } from "../lib/db.js";
import { createMemoryStore } from "../lib/memories.js";
import { appendPair, serializePair } from "../lib/pairs.js";
import { pairFilePath, workspaceSlug } from "../lib/paths.js";
import { cleanupTempDir, makeTempDir } from "./helpers/tmp.js";

/** @param {string} pairId @param {object} [overrides] @returns {object} A valid pair record. */
function samplePairRecord(pairId, overrides = {}) {
  return {
    pairId,
    sessionId: "s-default",
    cwd: "/w",
    turn: 0,
    createdAt: 1_700_000_000_000,
    user: "What is the build command?",
    assistant: "Run `npm run build`.",
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
    name: `memory-${pairId}`,
    description: "note",
    content: "memory content",
    cwd: "/w",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * Build a full browse harness: temp home, real memory store, real SQLite
 * index, and the browse service. Cleaned up after the test.
 *
 * @param {import("node:test").TestContext} t
 * @param {object} [options]
 * @param {string} [options.model] - Configured embedding model.
 * @param {number} [options.dimensions] - Configured embedding dimensions.
 * @param {number} [options.maxEmbeddingChars] - Memory content limit; must be
 *   high enough to read long memory bodies in truncation tests.
 * @param {{warn?: Function}} [options.logger] - Logger for fail-open checks.
 * @returns {Promise<{home: string, db: object, configStore: object,
 *   memoryStore: object, service: object}>}
 */
async function makeHarness(t, { model = "m", dimensions = 4, maxEmbeddingChars = 8000, logger = null } = {}) {
  const home = await makeTempDir("dsh-browse-test-");
  const configStore = {
    home,
    get: () => ({ embedding: { model, dimensions, maxEmbeddingChars } }),
  };
  const memoryStore = createMemoryStore({ home, configStore, logger });
  const db = openIndexDatabase(join(home, "index.sqlite"));
  t.after(async () => {
    db.close();
    await cleanupTempDir(home);
  });
  const service = createBrowseService({ home, db, configStore, memoryStore, logger });
  return { home, db, configStore, memoryStore, service };
}

// ---------------------------------------------------------------------------
// computeStatus (exported pure function)
// ---------------------------------------------------------------------------

test("browse: computeStatus follows missing → stale-text → pending → corrupt → model-mismatch → consistent", () => {
  const row = (overrides) => ({
    textHash: "h",
    model: "m",
    dim: 4,
    hasEmbedding: true,
    embeddingLength: 16,
    indexedAt: 1,
    ...overrides,
  });

  // No index row -> missing.
  assert.deepEqual(computeStatus({ row: null, textHash: "h" }), {
    state: "missing",
    model: null,
    dim: null,
    indexedAt: null,
  });

  // Text-hash mismatch wins over everything else.
  assert.equal(computeStatus({ row: row({ textHash: "other" }), textHash: "h" }).state, "stale-text");
  assert.equal(
    computeStatus({ row: row({ textHash: "other", hasEmbedding: false }), textHash: "h" }).state,
    "stale-text",
    "a stale text beats a missing embedding",
  );

  // Matching hash without an embedding -> pending.
  assert.equal(computeStatus({ row: row({ hasEmbedding: false }), textHash: "h" }).state, "pending");

  // A physically broken embedding is corrupt, even when the model differs.
  assert.equal(
    computeStatus({ row: row({ dim: 0, embeddingLength: 0 }), textHash: "h" }).state,
    "corrupt",
  );
  assert.equal(
    computeStatus({ row: row({ dim: Number.NaN, embeddingLength: 0 }), textHash: "h" }).state,
    "corrupt",
  );
  assert.equal(
    computeStatus({ row: row({ dim: 4, embeddingLength: 20 }), textHash: "h" }).state,
    "corrupt",
  );
  assert.equal(
    computeStatus({
      row: row({ model: "other", dim: 4, embeddingLength: 20 }),
      textHash: "h",
      embeddingConfig: { model: "m", dimensions: 4 },
    }).state,
    "corrupt",
    "a broken blob is reported before a model mismatch",
  );

  // A valid embedding whose model and/or dimensions differ -> model-mismatch.
  assert.equal(
    computeStatus({
      row: row({ model: "other-model", dim: 4 }),
      textHash: "h",
      embeddingConfig: { model: "m", dimensions: 4 },
    }).state,
    "model-mismatch",
  );
  assert.equal(
    computeStatus({
      row: row({ model: "m", dim: 8, embeddingLength: 32 }),
      textHash: "h",
      embeddingConfig: { model: "m", dimensions: 4 },
    }).state,
    "model-mismatch",
  );

  // Everything matches -> consistent.
  assert.equal(
    computeStatus({ row: row({ model: "m", dim: 4 }), textHash: "h", embeddingConfig: { model: "m", dimensions: 4 } }).state,
    "consistent",
  );

  // The model/dim compatibility check is skipped when nothing is configured.
  assert.equal(computeStatus({ row: row({ model: "whatever", dim: 4 }), textHash: "h", embeddingConfig: {} }).state, "consistent");
  assert.equal(
    computeStatus({ row: row({ model: "m", dim: 4 }), textHash: "h", embeddingConfig: { model: "", dimensions: null } }).state,
    "consistent",
  );
});

// ---------------------------------------------------------------------------
// Status classification through a real harness
// ---------------------------------------------------------------------------

test("browse: statuses are classified from a real home and index", async (t) => {
  const { home, db, service } = await makeHarness(t, { model: "m", dimensions: 4 });
  const cwd = "/w";
  const f = pairFilePath({ home, cwd, sessionId: "s1" });

  // missing: source without a DB row.
  await appendPair(f, samplePairRecord("p-missing", { cwd, sessionId: "s1", user: "u1", assistant: "a1", createdAt: 100 }));

  // pending: matching text hash, no embedding.
  const recPending = samplePairRecord("p-pending", { cwd, sessionId: "s1", user: "u2", assistant: "a2", createdAt: 200 });
  await appendPair(f, recPending);
  db.upsertPair(recPending);

  // consistent: matching hash + matching embedding.
  const recOk = samplePairRecord("p-ok", { cwd, sessionId: "s1", user: "u3", assistant: "a3", createdAt: 300 });
  await appendPair(f, recOk);
  db.upsertPair(recOk);
  db.setEmbedding("p-ok", new Float32Array([1, 2, 3, 4]), { model: "m", dim: 4 });

  // stale-text: the row was indexed from an older text; the JSONL changed.
  db.upsertPair(samplePairRecord("p-stale", { cwd, sessionId: "s1", user: "old", assistant: "old reply", createdAt: 400 }));
  await appendPair(f, samplePairRecord("p-stale", { cwd, sessionId: "s1", user: "new text", assistant: "new reply", createdAt: 400 }));

  // model-mismatch: a valid embedding produced by a different model.
  const recMismatch = samplePairRecord("p-mismatch", { cwd, sessionId: "s1", user: "u5", assistant: "a5", createdAt: 500 });
  await appendPair(f, recMismatch);
  db.upsertPair(recMismatch);
  db.setEmbedding("p-mismatch", new Float32Array([1, 2, 3, 4]), { model: "other-model", dim: 4 });

  // corrupt: the stored blob length does not match the declared dim.
  const recCorrupt = samplePairRecord("p-corrupt", { cwd, sessionId: "s1", user: "u6", assistant: "a6", createdAt: 600 });
  await appendPair(f, recCorrupt);
  db.upsertPair(recCorrupt);
  db.raw
    .prepare("UPDATE pairs SET embedding = ?, dim = ?, model = ?, indexed_at = ? WHERE pair_id = ?")
    .run(Buffer.from(new Float32Array([1, 2, 3, 4]).buffer), 3, "m", Date.now(), "p-corrupt");

  const list = await service.list({ kind: "pairs", scope: { type: "all" }, offset: 0, limit: 20 });
  const byId = Object.fromEntries(list.items.map((item) => [item.pairId, item]));

  assert.equal(byId["p-missing"].status.state, "missing");
  assert.equal(byId["p-pending"].status.state, "pending");
  assert.equal(byId["p-ok"].status.state, "consistent");
  assert.equal(byId["p-stale"].status.state, "stale-text");
  assert.equal(byId["p-mismatch"].status.state, "model-mismatch");
  assert.equal(byId["p-corrupt"].status.state, "corrupt");
});

// ---------------------------------------------------------------------------
// scopes()
// ---------------------------------------------------------------------------

test("browse: scopes() reports all/global/workspace scopes with counts and malformed lines", async (t) => {
  const { home, service, memoryStore } = await makeHarness(t);
  const cwd1 = "/work/project-alpha";
  const cwd2 = "/work/project-beta";
  const f1 = pairFilePath({ home, cwd: cwd1, sessionId: "s1" });
  await appendPair(f1, samplePairRecord("a1", { cwd: cwd1, sessionId: "s1", createdAt: 1 }));
  await appendPair(f1, samplePairRecord("a2", { cwd: cwd1, sessionId: "s1", createdAt: 2 }));
  const f2 = pairFilePath({ home, cwd: cwd2, sessionId: "s2" });
  await appendPair(f2, samplePairRecord("b1", { cwd: cwd2, sessionId: "s2", createdAt: 3 }));
  // A malformed line in the first file.
  await writeFile(f1, (await readFile(f1, "utf8")) + "{not json\n");

  memoryStore.write({ type: "global", name: "alpha", description: "G", content: "global note" });
  memoryStore.write({ type: "workspace", cwd: cwd1, name: "beta", description: "W", content: "workspace note" });

  const result = await service.scopes();
  assert.equal(result.malformedLines, 1);

  const byId = Object.fromEntries(result.scopes.map((s) => [s.id, s]));
  assert.deepEqual(byId.all, {
    id: "all",
    type: "all",
    cwd: null,
    labelKey: "scopeAll",
    memories: 2,
    pairs: 3,
  });
  assert.deepEqual(byId.global, {
    id: "global",
    type: "global",
    cwd: "",
    labelKey: "browseScopeGlobal",
    memories: 1,
    pairs: 0,
  });
  const ws1 = byId[`ws:${cwd1}`];
  assert.equal(ws1.type, "workspace");
  assert.equal(ws1.cwd, cwd1);
  assert.equal(ws1.memories, 1);
  assert.equal(ws1.pairs, 2);
  assert.equal(ws1.label, `${basename(cwd1)} · ${workspaceSlug(cwd1).slice(-8)}`);
  const ws2 = byId[`ws:${cwd2}`];
  assert.equal(ws2.memories, 0);
  assert.equal(ws2.pairs, 1);
  assert.equal(result.scopes.length, 4);
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

test("browse: list filters memories and pairs by scope", async (t) => {
  const { home, service, memoryStore } = await makeHarness(t);
  const cwd1 = "/w1";
  const cwd2 = "/w2";
  const f1 = pairFilePath({ home, cwd: cwd1, sessionId: "s1" });
  await appendPair(f1, samplePairRecord("p-w1", { cwd: cwd1, sessionId: "s1", createdAt: 100 }));
  const f2 = pairFilePath({ home, cwd: cwd2, sessionId: "s2" });
  await appendPair(f2, samplePairRecord("p-w2", { cwd: cwd2, sessionId: "s2", createdAt: 200 }));

  memoryStore.write({ type: "global", name: "g1", description: "G", content: "global" });
  memoryStore.write({ type: "workspace", cwd: cwd1, name: "m-w1", description: "W1", content: "w1" });
  memoryStore.write({ type: "workspace", cwd: cwd2, name: "m-w2", description: "W2", content: "w2" });

  // "all": every memory (global + workspace) and every pair.
  const allMemories = await service.list({ kind: "memories", scope: { type: "all" }, offset: 0, limit: 20 });
  assert.equal(allMemories.total, 3);
  assert.deepEqual(allMemories.items.map((i) => i.pairId), [
    "memory:global:global:g1",
    `memory:workspace:${workspaceSlug(cwd1)}:m-w1`,
    `memory:workspace:${workspaceSlug(cwd2)}:m-w2`,
  ]);

  // "global": global memories only; pairs total 0.
  const globalMemories = await service.list({ kind: "memories", scope: { type: "global" }, offset: 0, limit: 20 });
  assert.equal(globalMemories.total, 1);
  assert.equal(globalMemories.items[0].pairId, "memory:global:global:g1");
  const globalPairs = await service.list({ kind: "pairs", scope: { type: "global" }, offset: 0, limit: 20 });
  assert.equal(globalPairs.total, 0);
  assert.deepEqual(globalPairs.items, []);

  // "workspace": exact cwd match; global memories excluded.
  const ws1Memories = await service.list({ kind: "memories", scope: { type: "workspace", cwd: cwd1 }, offset: 0, limit: 20 });
  assert.deepEqual(ws1Memories.items.map((i) => i.pairId), [`memory:workspace:${workspaceSlug(cwd1)}:m-w1`]);
  const ws1Pairs = await service.list({ kind: "pairs", scope: { type: "workspace", cwd: cwd1 }, offset: 0, limit: 20 });
  assert.deepEqual(ws1Pairs.items.map((i) => i.pairId), ["p-w1"]);

  const allPairs = await service.list({ kind: "pairs", scope: { type: "all" }, offset: 0, limit: 20 });
  assert.equal(allPairs.total, 2);
  assert.deepEqual(allPairs.items.map((i) => i.pairId), ["p-w2", "p-w1"], "pairs sort newest first");
});

test("browse: list sorts memories by name and pairs newest first with a pairId tie-break", async (t) => {
  const { home, service, memoryStore } = await makeHarness(t);
  const cwd = "/w";
  const f = pairFilePath({ home, cwd, sessionId: "s1" });
  await appendPair(f, samplePairRecord("b", { cwd, sessionId: "s1", createdAt: 200 }));
  await appendPair(f, samplePairRecord("a", { cwd, sessionId: "s1", createdAt: 200 }));
  await appendPair(f, samplePairRecord("c", { cwd, sessionId: "s1", createdAt: 100 }));

  const pairs = await service.list({ kind: "pairs", scope: { type: "all" }, offset: 0, limit: 20 });
  assert.deepEqual(pairs.items.map((i) => i.pairId), ["a", "b", "c"]);

  memoryStore.write({ type: "global", name: "zeta", description: "Z", content: "z" });
  memoryStore.write({ type: "global", name: "alpha", description: "A", content: "a" });
  const memories = await service.list({ kind: "memories", scope: { type: "all" }, offset: 0, limit: 20 });
  assert.deepEqual(memories.items.map((i) => i.name), ["alpha", "zeta"]);
});

test("browse: list preview is whitespace-normalized user text capped at 200 chars", async (t) => {
  const { home, service } = await makeHarness(t);
  const f = pairFilePath({ home, cwd: "/w", sessionId: "s1" });
  await appendPair(f, samplePairRecord("p1", { cwd: "/w", sessionId: "s1", user: "line one\n\n   line two\t spaced", assistant: "must not appear" }));
  await appendPair(f, samplePairRecord("p2", { cwd: "/w", sessionId: "s1", user: "x".repeat(250), assistant: "hidden" }));

  const pairs = await service.list({ kind: "pairs", scope: { type: "all" }, offset: 0, limit: 20 });
  const byId = Object.fromEntries(pairs.items.map((i) => [i.pairId, i]));
  assert.equal(byId.p1.preview, "line one line two spaced");
  assert.ok(!byId.p1.preview.includes("must not appear"), "the assistant text must never leak into the preview");
  assert.equal(byId.p2.preview.length, 200);
});

test("browse: list paginates with offset/limit and reports total", async (t) => {
  const { home, service } = await makeHarness(t);
  const f = pairFilePath({ home, cwd: "/w", sessionId: "s1" });
  for (let i = 0; i < 25; i += 1) {
    await appendPair(f, samplePairRecord(`p${String(i).padStart(2, "0")}`, { cwd: "/w", sessionId: "s1", createdAt: i }));
  }

  const first = await service.list({ kind: "pairs", scope: { type: "all" }, offset: 0, limit: 10 });
  assert.equal(first.total, 25);
  assert.deepEqual(first.items.map((i) => i.pairId), ["p24", "p23", "p22", "p21", "p20", "p19", "p18", "p17", "p16", "p15"]);

  const last = await service.list({ kind: "pairs", scope: { type: "all" }, offset: 20, limit: 10 });
  assert.equal(last.items.length, 5);
  assert.deepEqual(last.items.map((i) => i.pairId), ["p04", "p03", "p02", "p01", "p00"]);

  const beyond = await service.list({ kind: "pairs", scope: { type: "all" }, offset: 100, limit: 10 });
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.total, 25);
});

test("browse: list tolerates degenerate scopes and offsets gracefully", async (t) => {
  const { home, service } = await makeHarness(t);
  const f = pairFilePath({ home, cwd: "/w", sessionId: "s1" });
  await appendPair(f, samplePairRecord("p1", { cwd: "/w", sessionId: "s1" }));

  const globalPairs = await service.list({ kind: "pairs", scope: { type: "global" }, offset: 0, limit: 100 });
  assert.equal(globalPairs.total, 0, "the global scope never contains pairs");

  const unknownScope = await service.list({ kind: "pairs", scope: { type: "bogus" }, offset: 0, limit: 100 });
  assert.equal(unknownScope.total, 0, "an unknown scope type matches nothing");

  const beyond = await service.list({ kind: "pairs", scope: { type: "all" }, offset: 50, limit: 100 });
  assert.deepEqual(beyond.items, []);
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

test("browse: get returns full pair detail with outbox info for a pending row", async (t) => {
  const { home, service, db } = await makeHarness(t);
  const cwd = "/w";
  const f = pairFilePath({ home, cwd, sessionId: "s1" });
  const rec = samplePairRecord("p1", { cwd, sessionId: "s1", turn: 7, user: "user text", assistant: "assistant text" });
  await appendPair(f, rec);
  db.upsertPair(rec);
  db.enqueue("p1", "new");
  db.failPair("p1", { attempts: 3, nextAt: 1_700_000_100_000, error: "rate limited" });

  const detail = await service.get({ pairId: "p1" });
  assert.equal(detail.kind, "pair");
  assert.equal(detail.pairId, "p1");
  assert.equal(detail.sessionId, "s1");
  assert.equal(detail.cwd, cwd);
  assert.equal(detail.turn, 7);
  assert.equal(detail.user, "user text");
  assert.equal(detail.assistant, "assistant text");
  assert.equal(detail.userTruncated, false);
  assert.equal(detail.assistantTruncated, false);
  assert.equal(detail.status.state, "pending");
  assert.deepEqual(detail.outbox, {
    reason: "new",
    attempts: 3,
    nextAt: 1_700_000_100_000,
    lastError: "rate limited",
  });
});

test("browse: get returns full memory detail", async (t) => {
  const { service, memoryStore, db } = await makeHarness(t);
  const written = memoryStore.write({ type: "global", name: "alpha", description: "First memory", content: "Hello world" });
  db.upsertMemory(written.record);

  const detail = await service.get({ pairId: written.record.pairId });
  assert.equal(detail.kind, "memory");
  assert.equal(detail.name, "alpha");
  assert.equal(detail.description, "First memory");
  assert.equal(detail.memoryType, "global");
  assert.equal(detail.cwd, "");
  assert.equal(detail.content, "Hello world");
  assert.equal(detail.contentTruncated, false);
  assert.equal(detail.status.state, "pending");
  assert.equal(detail.outbox, null);
});

test("browse: get truncates long fields at 200000 chars and flags them", async (t) => {
  const { home, service, db, memoryStore } = await makeHarness(t, { maxEmbeddingChars: 300_000 });
  const f = pairFilePath({ home, cwd: "/w", sessionId: "s1" });
  const rec = samplePairRecord("p1", {
    cwd: "/w",
    sessionId: "s1",
    user: "u".repeat(200_050),
    assistant: "a".repeat(200_050),
  });
  await appendPair(f, rec);
  db.upsertPair(rec);

  const pair = await service.get({ pairId: "p1" });
  assert.equal(pair.user.length, 200_000);
  assert.equal(pair.assistant.length, 200_000);
  assert.equal(pair.userTruncated, true);
  assert.equal(pair.assistantTruncated, true);

  const written = memoryStore.write({ type: "global", name: "big", description: "big memory", content: "m".repeat(200_050) });
  db.upsertMemory(written.record);
  const mem = await service.get({ pairId: written.record.pairId });
  assert.equal(mem.content.length, 200_000);
  assert.equal(mem.contentTruncated, true);
});

test("browse: get throws NOT_FOUND when the source disappeared", async (t) => {
  const { home, service, db } = await makeHarness(t);
  const cwd = "/w";
  const f = pairFilePath({ home, cwd, sessionId: "s1" });
  const rec = samplePairRecord("p1", { cwd, sessionId: "s1" });
  await appendPair(f, rec);
  db.upsertPair(rec);
  await rm(f, { force: true }); // the source disappears while the index row stays.

  await assert.rejects(service.get({ pairId: "p1" }), (err) => err.code === "NOT_FOUND" && err.status === 404);
});

test("browse: get throws NOT_FOUND for a memory whose file was removed", async (t) => {
  const { home, service, memoryStore, db } = await makeHarness(t);
  const written = memoryStore.write({ type: "global", name: "alpha", description: "d", content: "c" });
  db.upsertMemory(written.record);
  await rm(join(home, "memories", "global", "alpha.md"), { force: true });

  await assert.rejects(service.get({ pairId: written.record.pairId }), (err) => err.code === "NOT_FOUND" && err.status === 404);
});

// ---------------------------------------------------------------------------
// statusOf()
// ---------------------------------------------------------------------------

test("browse: statusOf reports kind and status, NOT_FOUND for a missing source", async (t) => {
  const { home, service, db } = await makeHarness(t);
  const f = pairFilePath({ home, cwd: "/w", sessionId: "s1" });
  const rec = samplePairRecord("p1", { cwd: "/w", sessionId: "s1", user: "u", assistant: "a" });
  await appendPair(f, rec);
  db.upsertPair(rec);

  const status = await service.statusOf("p1");
  assert.equal(status.kind, "pair");
  assert.equal(status.status.state, "pending");
  assert.equal(status.status.model, null);

  await assert.rejects(service.statusOf("nope"), (err) => err.code === "NOT_FOUND" && err.status === 404);
});

// ---------------------------------------------------------------------------
// check() audit
// ---------------------------------------------------------------------------

test("browse: check counts statuses and orphans; counts sum to checked.total + orphan", async (t) => {
  const { home, service, db } = await makeHarness(t);
  const cwd = "/w1";
  const f = pairFilePath({ home, cwd, sessionId: "s1" });

  const recOk = samplePairRecord("p-ok", { cwd, sessionId: "s1", user: "u1", assistant: "a1", createdAt: 100 });
  await appendPair(f, recOk);
  await appendPair(f, samplePairRecord("p-missing", { cwd, sessionId: "s1", user: "u2", assistant: "a2", createdAt: 200 }));
  await appendPair(f, samplePairRecord("p-stale", { cwd, sessionId: "s1", user: "u3", assistant: "a3", createdAt: 300 }));
  await appendPair(f, samplePairRecord("p-pending", { cwd, sessionId: "s1", user: "u4", assistant: "a4", createdAt: 400 }));
  await appendPair(f, samplePairRecord("p-mismatch", { cwd, sessionId: "s1", user: "u5", assistant: "a5", createdAt: 500 }));

  db.upsertPair(recOk);
  db.setEmbedding("p-ok", new Float32Array([1, 2, 3, 4]), { model: "m", dim: 4 });
  db.upsertPair(samplePairRecord("p-stale", { cwd, sessionId: "s1", user: "old text", assistant: "old reply", createdAt: 300 }));
  db.upsertPair(samplePairRecord("p-pending", { cwd, sessionId: "s1", user: "u4", assistant: "a4", createdAt: 400 }));
  db.enqueue("p-pending", "new");
  db.upsertPair(samplePairRecord("p-mismatch", { cwd, sessionId: "s1", user: "u5", assistant: "a5", createdAt: 500 }));
  db.setEmbedding("p-mismatch", new Float32Array([1, 2, 3, 4]), { model: "other-model", dim: 4 });

  // Two orphan rows: index rows whose sources do not exist on disk.
  db.upsertPair(samplePairRecord("orphan-a", { cwd, sessionId: "s1", user: "x", assistant: "y", createdAt: 600 }));
  db.upsertMemory(sampleMemoryRecord("memory:global:global:ghost", {
    memoryType: "global",
    cwd: "",
    name: "ghost",
    content: "g",
    createdAt: 700,
  }));

  const result = await service.check({ scope: { type: "all" } });

  assert.deepEqual(result.checked, { pairs: 5, memories: 0, total: 5 });
  assert.equal(result.counts.consistent, 1);
  assert.equal(result.counts.missing, 1);
  assert.equal(result.counts.staleText, 1);
  assert.equal(result.counts.pending, 1);
  assert.equal(result.counts.modelMismatch, 1);
  assert.equal(result.counts.corrupt, 0);
  assert.equal(result.counts.orphan, 2);
  assert.equal(result.counts.unknown, 0);

  const sum = Object.values(result.counts).reduce((acc, n) => acc + n, 0);
  assert.equal(sum, result.checked.total + result.counts.orphan);

  // Every non-consistent item (including orphans) is listed, newest first.
  assert.equal(result.mismatches.length, 6);
  assert.equal(result.mismatches[0].pairId, "memory:global:global:ghost", "the newest mismatch comes first");
  assert.ok(result.mismatches.some((item) => item.status.state === "orphan"));
  assert.equal(result.truncated, false);
});

test("browse: check caps mismatches at 500 and flags truncation", async (t) => {
  const { home, service } = await makeHarness(t);
  const cwd = "/big";
  const f = pairFilePath({ home, cwd, sessionId: "s1" });
  const lines = [];
  for (let i = 0; i < 501; i += 1) {
    lines.push(
      serializePair(samplePairRecord(`cap-${String(i).padStart(3, "0")}`, { cwd, sessionId: "s1", user: `user ${i}`, assistant: `reply ${i}` })),
    );
  }
  await mkdir(join(home, "pairs", workspaceSlug(cwd)), { recursive: true });
  await writeFile(f, lines.join(""));

  const result = await service.check({ scope: { type: "all" } });
  assert.equal(result.checked.total, 501);
  assert.equal(result.counts.missing, 501);
  assert.equal(result.mismatches.length, 500);
  assert.equal(result.truncated, true);
});

test("browse: check counts malformed JSONL lines and excludes them from sources", async (t) => {
  const { home, service } = await makeHarness(t);
  const f = pairFilePath({ home, cwd: "/w", sessionId: "s1" });
  await appendPair(f, samplePairRecord("p1", { cwd: "/w", sessionId: "s1" }));
  await writeFile(f, (await readFile(f, "utf8")) + "not valid json\n{\"pairId\": 5}\n");

  const result = await service.check({ scope: { type: "all" } });
  assert.equal(result.malformedLines, 2);
  assert.equal(result.checked.total, 1);
  assert.equal(result.counts.missing, 1);
});

test("browse: orphan rows are audit-only and never listed", async (t) => {
  const { service, db } = await makeHarness(t);
  db.upsertPair(samplePairRecord("ghost", { cwd: "/w", sessionId: "s1", user: "x", assistant: "y" }));

  const list = await service.list({ kind: "pairs", scope: { type: "all" }, offset: 0, limit: 20 });
  assert.equal(list.total, 0);
  assert.deepEqual(list.items, []);

  const check = await service.check({ scope: { type: "all" } });
  assert.equal(check.counts.orphan, 1);
  assert.equal(check.mismatches.length, 1);
  assert.equal(check.mismatches[0].pairId, "ghost");
  assert.equal(check.mismatches[0].kind, "pair");
  assert.equal(check.mismatches[0].status.state, "orphan");
});

// ---------------------------------------------------------------------------
// fail-open
// ---------------------------------------------------------------------------

test("browse: a failing row inspection fails open as unknown with a warning", async (t) => {
  const home = await makeTempDir("dsh-browse-unknown-");
  t.after(() => cleanupTempDir(home));
  const warns = [];
  const logger = { warn: (message) => warns.push(String(message)) };
  const configStore = { home, get: () => ({ embedding: { model: "m", dimensions: 4 } }) };
  const memoryStore = createMemoryStore({ home, configStore, logger });
  const f = pairFilePath({ home, cwd: "/w", sessionId: "s1" });
  await appendPair(f, samplePairRecord("p1", { cwd: "/w", sessionId: "s1" }));
  const rows = [
    {
      pairId: "p1",
      get textHash() {
        throw new Error("boom");
      },
      model: null,
      dim: null,
      indexedAt: null,
      hasEmbedding: false,
    },
  ];
  const db = { indexRows: () => rows };
  const service = createBrowseService({ home, db, configStore, memoryStore, logger });

  const list = await service.list({ kind: "pairs", scope: { type: "all" }, offset: 0, limit: 20 });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].status.state, "unknown");
  assert.ok(warns.some((message) => message.includes("p1")), "the fail-open path must log a warning");

  const check = await service.check({ scope: { type: "all" } });
  assert.equal(check.counts.unknown, 1);
  assert.equal(check.checked.total, 1);
  assert.equal(check.mismatches.length, 1);
  assert.equal(check.mismatches[0].status.state, "unknown");
});
