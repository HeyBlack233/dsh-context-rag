/**
 * Tests for the persistent recall-state module in `lib/recall-state.js`.
 *
 * Covers schema/validation, persistence across instances, gap eligibility
 * (0 / -1 / distance), per-session isolation, record semantics, invalid
 * inputs, retention by days and max sessions, atomic 0600 writes, and
 * fail-open behavior on unreadable/corrupt/unwritable files.
 *
 * Plain ESM, `node:test` + `node:assert/strict`. No network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createRecallState } from "../lib/recall-state.js";
import { cleanupTempDir, makeTempDir } from "./helpers/tmp.js";

const DAY_MS = 86400000;

/** Build a logger that records every warning. */
function warnLogger() {
  const warns = [];
  return { logger: { warn: (msg) => warns.push(String(msg)) }, warns };
}

/** Read and parse the recall-state file as JSON. */
async function readState(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

test("recall-state: missing file loads empty and is not rewritten", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const rs = createRecallState({ file });
  assert.deepEqual(rs.load(), {
    sessions: 0,
    entries: 0,
    prunedSessions: 0,
    prunedEntries: 0,
  });
  assert.deepEqual(rs.stats(), { sessions: 0, entries: 0 });
  assert.equal(rs.getLastTurn("s1", "p1"), null);
  assert.equal(rs.isEligible({ sessionId: "s1", pairId: "p1", turn: 3, gap: 5 }), true);
  // A missing file must not be created by load().
  await assert.rejects(access(file), { code: "ENOENT" });
});

test("recall-state: file property is an absolute path", () => {
  const rs = createRecallState({ file: "rel/recall-state.json" });
  assert.ok(isAbsolute(rs.file));
});

test("recall-state: corrupt file warns and starts empty", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");
  await writeFile(file, "this is {not json");

  const { logger, warns } = warnLogger();
  const rs = createRecallState({ file, logger });
  assert.deepEqual(rs.load(), {
    sessions: 0,
    entries: 0,
    prunedSessions: 0,
    prunedEntries: 0,
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /parse failed/);
});

test("recall-state: unsupported schema warns and starts empty", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const cases = [
    "just a string",
    JSON.stringify({ version: 2, sessions: {} }),
    JSON.stringify({ version: 1 }), // sessions missing
    JSON.stringify({ version: 1, sessions: [] }), // sessions not an object
    JSON.stringify({ version: 1, sessions: "x" }),
  ];
  for (const content of cases) {
    await writeFile(file, content);
    const { logger, warns } = warnLogger();
    const rs = createRecallState({ file, logger });
    const result = rs.load();
    assert.deepEqual(result, {
      sessions: 0,
      entries: 0,
      prunedSessions: 0,
      prunedEntries: 0,
    });
    assert.ok(warns.length >= 1, `expected a warning for: ${content}`);
  }
});

test("recall-state: load normalizes invalid sessions/entries and persists", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      sessions: {
        good: { lastActiveAt: 1000, entries: { p1: { lastTurn: 3, lastRecallAt: 1000, count: 1 } } },
        badTurn: { lastActiveAt: 2000, entries: { p1: { lastTurn: -1, lastRecallAt: 2000, count: 1 } } },
        badCount: { lastActiveAt: 3000, entries: { p1: { lastTurn: 1, lastRecallAt: 3000, count: 0 } } },
        badTime: { lastActiveAt: "soon", entries: { p1: { lastTurn: 1, lastRecallAt: 3000, count: 1 } } },
        empty: { lastActiveAt: 4000, entries: {} },
        notObject: "nope",
        "": { lastActiveAt: 5000, entries: { p1: { lastTurn: 1, lastRecallAt: 5000, count: 1 } } },
        mixed: {
          lastActiveAt: 6000,
          entries: {
            ok: { lastTurn: 2, lastRecallAt: 6000, count: 2 },
            bad: { lastTurn: 1.5, lastRecallAt: 6000, count: 1 },
          },
        },
      },
    }),
  );

  const rs = createRecallState({ file });
  const result = rs.load();
  assert.deepEqual(result.sessions, 2); // good + mixed
  assert.deepEqual(result.entries, 2); // good.p1 + mixed.ok
  assert.equal(result.prunedSessions, 6);
  assert.equal(result.prunedEntries, 3);

  assert.equal(rs.getLastTurn("good", "p1"), 3);
  assert.equal(rs.getLastTurn("mixed", "ok"), 2);
  assert.equal(rs.getLastTurn("mixed", "bad"), null);
  assert.equal(rs.getLastTurn("badTurn", "p1"), null);

  // The cleaned state was persisted immediately.
  const persisted = await readState(file);
  assert.equal(persisted.version, 1);
  assert.deepEqual(Object.keys(persisted.sessions).sort(), ["good", "mixed"]);
});

test("recall-state: valid file with no drops is not rewritten on load", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");
  const content = JSON.stringify(
    {
      version: 1,
      sessions: {
        s1: { lastActiveAt: 1000, entries: { p1: { lastTurn: 3, lastRecallAt: 1000, count: 2 } } },
      },
    },
    null,
    2,
  );
  await writeFile(file, content);

  const rs = createRecallState({ file });
  const result = rs.load();
  assert.deepEqual(result, { sessions: 1, entries: 1, prunedSessions: 0, prunedEntries: 0 });
  // Byte-identical content proves load() did not rewrite the file.
  assert.equal(await readFile(file, "utf8"), content);
});

test("recall-state: persists across two instances with the expected schema", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const first = createRecallState({ file, now: () => 12345 });
  const recorded = first.record({ sessionId: "s1", pairIds: ["p1", "p2"], turn: 3 });
  assert.deepEqual(recorded, { recorded: 2, prunedSessions: 0, prunedEntries: 0 });

  const second = createRecallState({ file });
  assert.deepEqual(second.load(), { sessions: 1, entries: 2, prunedSessions: 0, prunedEntries: 0 });
  assert.equal(second.getLastTurn("s1", "p1"), 3);
  assert.equal(second.getLastTurn("s1", "p2"), 3);
  assert.equal(second.getLastTurn("s1", "missing"), null);
  assert.equal(second.getLastTurn("missing", "p1"), null);
  assert.deepEqual(second.stats(), { sessions: 1, entries: 2 });

  // On-disk schema: version 1, sessions keyed by session id, entries keyed
  // by pair id with exactly the documented fields.
  const persisted = await readState(file);
  assert.deepEqual(Object.keys(persisted), ["version", "sessions"]);
  assert.equal(persisted.version, 1);
  assert.deepEqual(Object.keys(persisted.sessions), ["s1"]);
  assert.equal(persisted.sessions.s1.lastActiveAt, 12345);
  assert.deepEqual(persisted.sessions.s1.entries.p1, {
    lastTurn: 3,
    lastRecallAt: 12345,
    count: 1,
  });
  assert.deepEqual(persisted.sessions.s1.entries.p2, {
    lastTurn: 3,
    lastRecallAt: 12345,
    count: 1,
  });
});

test("recall-state: writes are atomic with mode 0600", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "nested", "recall-state.json"); // parent must be created

  const rs = createRecallState({ file });
  rs.record({ sessionId: "s1", pairIds: ["p1"], turn: 1 });

  const info = await stat(file);
  assert.equal(info.mode & 0o777, 0o600);
  // No stray temp files are left behind.
  assert.deepEqual(await readdir(join(dir, "nested")), ["recall-state.json"]);
});

test("recall-state: gap 5 requires a distance of 5 turns", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const rs = createRecallState({ file });
  rs.record({ sessionId: "s1", pairIds: ["p1"], turn: 1 });

  const eligible = (turn) =>
    rs.isEligible({ sessionId: "s1", pairId: "p1", turn, gap: 5 });

  assert.equal(eligible(1), false); // same turn
  assert.equal(eligible(2), false); // L+1
  assert.equal(eligible(5), false); // L+4: still ineligible
  assert.equal(eligible(6), true); // L+5: eligible again
  assert.equal(eligible(100), true);

  // A pair never recorded is always eligible.
  assert.equal(rs.isEligible({ sessionId: "s1", pairId: "never", turn: 0, gap: 5 }), true);
});

test("recall-state: gap 0 always eligible, gap -1 only once per session", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const rs = createRecallState({ file });
  rs.record({ sessionId: "s1", pairIds: ["p1"], turn: 1 });

  assert.equal(rs.isEligible({ sessionId: "s1", pairId: "p1", turn: 1, gap: 0 }), true);
  assert.equal(rs.isEligible({ sessionId: "s1", pairId: "p1", turn: 99, gap: 0 }), true);

  assert.equal(rs.isEligible({ sessionId: "s1", pairId: "p1", turn: 1, gap: -1 }), false);
  assert.equal(rs.isEligible({ sessionId: "s1", pairId: "p1", turn: 999, gap: -1 }), false);
  // Unrecorded pairs are still eligible even with gap -1.
  assert.equal(rs.isEligible({ sessionId: "s1", pairId: "never", turn: 5, gap: -1 }), true);
});

test("recall-state: invalid turn is eligible, valid distance check applies", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const rs = createRecallState({ file });
  rs.record({ sessionId: "s1", pairIds: ["p1"], turn: 1 });

  for (const bad of ["5", 1.5, -1, NaN, null, undefined, {}]) {
    assert.equal(
      rs.isEligible({ sessionId: "s1", pairId: "p1", turn: bad, gap: 5 }),
      true,
      `invalid turn ${String(bad)} should be eligible`,
    );
  }
  // Sanity: a valid far turn is eligible.
  assert.equal(rs.isEligible({ sessionId: "s1", pairId: "p1", turn: 6, gap: 5 }), true);
});

test("recall-state: per-session isolation for the same pair id", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const rs = createRecallState({ file });
  rs.record({ sessionId: "s1", pairIds: ["p1"], turn: 2 });
  rs.record({ sessionId: "s2", pairIds: ["p1"], turn: 5 });

  assert.equal(rs.getLastTurn("s1", "p1"), 2);
  assert.equal(rs.getLastTurn("s2", "p1"), 5);
  // Eligibility is per (sessionId, pairId): the same pair id can be deduped
  // independently in each session.
  assert.equal(rs.isEligible({ sessionId: "s1", pairId: "p1", turn: 3, gap: 2 }), false);
  assert.equal(rs.isEligible({ sessionId: "s2", pairId: "p1", turn: 5, gap: 2 }), false);
  assert.equal(rs.isEligible({ sessionId: "s2", pairId: "p1", turn: 7, gap: 2 }), true);
  assert.deepEqual(rs.stats(), { sessions: 2, entries: 2 });

  // A pair from another session can be deduped in the current session.
  rs.record({ sessionId: "s1", pairIds: ["foreign"], turn: 1 });
  rs.record({ sessionId: "s2", pairIds: ["foreign"], turn: 3 });
  assert.equal(rs.getLastTurn("s1", "foreign"), 1);
  assert.equal(rs.getLastTurn("s2", "foreign"), 3);
});

test("recall-state: record updates only the requested pair ids", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const rs = createRecallState({ file });
  rs.record({ sessionId: "s1", pairIds: ["p1", "p2"], turn: 2 });
  rs.record({ sessionId: "s1", pairIds: ["p1"], turn: 5 });

  assert.equal(rs.getLastTurn("s1", "p1"), 5);
  assert.equal(rs.getLastTurn("s1", "p2"), 2); // untouched by the second record
  const persisted = await readState(file);
  assert.equal(persisted.sessions.s1.entries.p1.count, 2);
  assert.equal(persisted.sessions.s1.entries.p2.count, 1);
});

test("recall-state: count increments and lastTurn keeps the max", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const rs = createRecallState({ file });
  rs.record({ sessionId: "s1", pairIds: ["p1"], turn: 3 });
  rs.record({ sessionId: "s1", pairIds: ["p1"], turn: 2 }); // lower turn: no regression
  rs.record({ sessionId: "s1", pairIds: ["p1"], turn: 10 });
  assert.equal(rs.getLastTurn("s1", "p1"), 10);

  const persisted = await readState(file);
  assert.equal(persisted.sessions.s1.entries.p1.count, 3);
  assert.equal(persisted.sessions.s1.entries.p1.lastTurn, 10);

  // Duplicates inside one call are counted once.
  const result = rs.record({ sessionId: "s1", pairIds: ["p1", "p1", "p1"], turn: 4 });
  assert.equal(result.recorded, 1);
  const after = await readState(file);
  assert.equal(after.sessions.s1.entries.p1.count, 4);
  assert.equal(after.sessions.s1.entries.p1.lastTurn, 10);
});

test("recall-state: invalid record inputs are ignored", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const rs = createRecallState({ file });
  const zero = { recorded: 0, prunedSessions: 0, prunedEntries: 0 };

  assert.deepEqual(rs.record({ sessionId: "", pairIds: ["p"], turn: 1 }), zero);
  assert.deepEqual(rs.record({ sessionId: "s", pairIds: [], turn: 1 }), zero);
  assert.deepEqual(rs.record({ sessionId: "s", pairIds: ["p"], turn: 1.5 }), zero);
  assert.deepEqual(rs.record({ sessionId: "s", pairIds: ["p"], turn: -1 }), zero);
  assert.deepEqual(rs.record({ sessionId: "s", pairIds: ["p"], turn: NaN }), zero);
  assert.deepEqual(rs.record({ sessionId: "s", pairIds: ["p"], turn: "3" }), zero);
  assert.deepEqual(rs.record({ sessionId: "s", pairIds: null, turn: 1 }), zero);
  assert.deepEqual(rs.record({ sessionId: null, pairIds: ["p"], turn: 1 }), zero);
  assert.deepEqual(rs.record({}), zero);
  assert.deepEqual(rs.stats(), { sessions: 0, entries: 0 });

  // Non-string / empty pair ids inside an otherwise valid call are skipped,
  // and only the distinct valid ones count as recorded.
  const result = rs.record({ sessionId: "s", pairIds: ["", "p", 123, null, "p"], turn: 1 });
  assert.equal(result.recorded, 1);
  assert.deepEqual(rs.stats(), { sessions: 1, entries: 1 });
  assert.equal(rs.getLastTurn("s", "p"), 1);
});

test("recall-state: retention by days uses injectable now and is strict", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const base = 1_000_000_000_000;
  const first = createRecallState({ file, now: () => base });
  first.record({ sessionId: "old", pairIds: ["p"], turn: 1 });

  // Exactly at the cutoff: not strictly older, so kept.
  const atCutoff = createRecallState({ file, now: () => base + 90 * DAY_MS });
  const kept = atCutoff.load({ retentionDays: 90 });
  assert.deepEqual(kept, { sessions: 1, entries: 1, prunedSessions: 0, prunedEntries: 0 });

  // One ms past the cutoff: strictly older, so pruned and persisted.
  const pastCutoff = createRecallState({ file, now: () => base + 90 * DAY_MS + 1 });
  const pruned = pastCutoff.load({ retentionDays: 90 });
  assert.deepEqual(pruned, { sessions: 0, entries: 0, prunedSessions: 1, prunedEntries: 1 });
  assert.deepEqual((await readState(file)).sessions, {});

  // A session active at `now` survives; retentionDays 0 disables the limit.
  const active = createRecallState({ file, now: () => base + 200 * DAY_MS });
  active.record({ sessionId: "new", pairIds: ["q"], turn: 1 });
  const fresh = createRecallState({ file, now: () => base + 201 * DAY_MS });
  assert.deepEqual(fresh.load({ retentionDays: 90 }).sessions, 1);
  assert.deepEqual(fresh.load({ retentionDays: 0, maxSessions: 0 }).sessions, 1);
});

test("recall-state: record applies retention limits and reports prune counts", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  let clock = 1_000_000_000_000;
  const rs = createRecallState({ file, now: () => clock });

  rs.record({ sessionId: "old", pairIds: ["p"], turn: 1 });
  clock += 100 * DAY_MS;
  const result = rs.record({
    sessionId: "new",
    pairIds: ["q"],
    turn: 1,
    retentionDays: 90,
    maxSessions: 0,
  });
  assert.deepEqual(result, { recorded: 1, prunedSessions: 1, prunedEntries: 1 });
  assert.deepEqual(rs.stats(), { sessions: 1, entries: 1 });
  assert.equal(rs.getLastTurn("old", "p"), null);
  assert.equal(rs.getLastTurn("new", "q"), 1);
  assert.deepEqual(Object.keys((await readState(file)).sessions), ["new"]);
});

test("recall-state: max sessions keeps the newest, tie-broken by session id", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  let clock = 1000;
  const rs = createRecallState({ file, now: () => clock });
  rs.record({ sessionId: "s_a", pairIds: ["p"], turn: 1 });
  clock = 2000;
  rs.record({ sessionId: "s_b", pairIds: ["p"], turn: 1 });

  // Newest activity wins.
  const newest = createRecallState({ file });
  assert.deepEqual(newest.load({ maxSessions: 1 }), {
    sessions: 1,
    entries: 1,
    prunedSessions: 1,
    prunedEntries: 1,
  });
  assert.equal(newest.getLastTurn("s_b", "p"), 1);
  assert.equal(newest.getLastTurn("s_a", "p"), null);

  // Tie on lastActiveAt breaks by ascending session id for determinism.
  const tieFile = join(dir, "tie.json");
  const tie = createRecallState({ file: tieFile, now: () => 5000 });
  tie.record({ sessionId: "s_z", pairIds: ["p"], turn: 1 });
  tie.record({ sessionId: "s_a", pairIds: ["p"], turn: 1 });
  const tieLoaded = createRecallState({ file: tieFile });
  tieLoaded.load({ maxSessions: 1 });
  assert.equal(tieLoaded.getLastTurn("s_a", "p"), 1);
  assert.equal(tieLoaded.getLastTurn("s_z", "p"), null);

  // maxSessions 0 disables the count limit.
  const all = createRecallState({ file });
  assert.deepEqual(all.load({ maxSessions: 0 }).sessions, 1);
});

test("recall-state: record applies the max-sessions limit during the write", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  let clock = 1000;
  const rs = createRecallState({ file, now: () => clock });
  rs.record({ sessionId: "s1", pairIds: ["p"], turn: 1 });
  clock = 2000;
  rs.record({ sessionId: "s2", pairIds: ["p"], turn: 1 });
  clock = 3000;

  const result = rs.record({ sessionId: "s3", pairIds: ["p"], turn: 1, maxSessions: 1 });
  assert.deepEqual(result, { recorded: 1, prunedSessions: 2, prunedEntries: 2 });
  assert.deepEqual(rs.stats(), { sessions: 1, entries: 1 });
  assert.deepEqual(Object.keys((await readState(file)).sessions), ["s3"]);
});

test("recall-state: save/load round-trip preserves data", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const rs = createRecallState({ file, now: () => 777 });
  rs.record({ sessionId: "s1", pairIds: ["p1", "p2"], turn: 4 });
  rs.record({ sessionId: "s2", pairIds: ["p1"], turn: 9 });
  assert.equal(rs.save(), true);

  const reloaded = createRecallState({ file });
  reloaded.load();
  assert.deepEqual(reloaded.stats(), { sessions: 2, entries: 3 });
  assert.equal(reloaded.getLastTurn("s1", "p1"), 4);
  assert.equal(reloaded.getLastTurn("s1", "p2"), 4);
  assert.equal(reloaded.getLastTurn("s2", "p1"), 9);
});

test("recall-state: unreadable file warns and starts empty", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  // The "file" path has a regular file as its parent, so every I/O fails.
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "x");
  const file = join(blocker, "recall-state.json");

  const { logger, warns } = warnLogger();
  const rs = createRecallState({ file, logger });
  assert.deepEqual(rs.load(), {
    sessions: 0,
    entries: 0,
    prunedSessions: 0,
    prunedEntries: 0,
  });
  assert.ok(warns.length >= 1);
});

test("recall-state: record never throws on write failure and reports zero", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  // The destination path's parent is a regular file, so mkdir/write fails.
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "x");
  const file = join(blocker, "recall-state.json");

  const { logger, warns } = warnLogger();
  const rs = createRecallState({ file, logger });
  const result = rs.record({ sessionId: "s1", pairIds: ["p1"], turn: 1 });
  assert.deepEqual(result, { recorded: 0, prunedSessions: 0, prunedEntries: 0 });
  assert.ok(warns.length >= 1, "expected a warning for the failed write");
  // save() itself also fails open.
  assert.equal(rs.save(), false);
});

test("recall-state: lastActiveAt and lastRecallAt use the injected clock", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const file = join(dir, "recall-state.json");

  const rs = createRecallState({ file, now: () => 424242 });
  rs.record({ sessionId: "s1", pairIds: ["p1"], turn: 2 });

  const persisted = await readState(file);
  assert.equal(persisted.sessions.s1.lastActiveAt, 424242);
  assert.equal(persisted.sessions.s1.entries.p1.lastRecallAt, 424242);

  // Recording again at a later time bumps both timestamps.
  const later = createRecallState({ file, now: () => 999999 });
  later.load();
  later.record({ sessionId: "s1", pairIds: ["p1"], turn: 3 });
  const after = await readState(file);
  assert.equal(after.sessions.s1.lastActiveAt, 999999);
  assert.equal(after.sessions.s1.entries.p1.lastRecallAt, 999999);
  assert.equal(after.sessions.s1.entries.p1.count, 2);
});
