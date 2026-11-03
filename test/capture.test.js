/**
 * Tests for the turn capture surface in `lib/capture.js`.
 *
 * Sessions, events, and agents are synthetic plain objects shaped like the
 * DSH events the plugin listens to; the index database is a fake Map-backed
 * handle and the pair store is a real temp directory.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapture } from "../lib/capture.js";
import { readPairs } from "../lib/pairs.js";
import { pairFilePath, pairId } from "../lib/paths.js";

/**
 * Create a fresh temporary home directory, cleaned up after the test.
 *
 * @param {import("node:test").TestContext} t
 * @returns {Promise<string>}
 */
async function makeHome(t) {
  const home = await mkdtemp(join(tmpdir(), "dsh-capture-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

/**
 * Map-backed fake of the index database handle used by the capture surface.
 *
 * @returns {object} `getPair`/`upsertPair` plus the `pairs` map and a way to
 *   make `upsertPair` throw.
 */
function fakeDb() {
  const pairs = new Map();
  let upsertError = null;
  return {
    pairs,
    setUpsertError(err) {
      upsertError = err;
    },
    getPair(pairId) {
      return pairs.get(pairId) ?? null;
    },
    upsertPair(record) {
      if (upsertError) {
        throw upsertError;
      }
      pairs.set(record.pairId, record);
      return record;
    },
  };
}

/** @param {string} home @returns {object} A config store with `home`. */
function fakeConfigStore(home) {
  return { home, get: () => ({}) };
}

/**
 * Build a session object.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.origin]
 * @returns {object}
 */
function session(id, { cwd = "/work/proj", origin = undefined } = {}) {
  const header = { cwd };
  if (origin !== undefined) {
    header.origin = origin;
  }
  return { id, header };
}

/** @param {object} sess @returns {object} An agent wrapping the session. */
function agentOf(sess) {
  return { session: sess };
}

/**
 * Build synthetic session events with DSH-like shapes. Message content is an
 * array of blocks so it flows through `extractText` the way real content
 * does.
 */

/** @param {number} turn @returns {object} A `turn/start` event. */
function turnStart(turn) {
  return { type: "turn/start", data: { turn } };
}

/**
 * @param {string} id
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.sourceKind]
 * @returns {object} A `user/message` event.
 */
function userMessage(id, text, { sourceKind = "user" } = {}) {
  return {
    type: "user/message",
    data: { id, source: { kind: sourceKind }, content: [{ type: "text", text }] },
  };
}

/**
 * @param {string} id
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.interrupted]
 * @param {number} [options.time]
 * @param {Array<object>} [options.blocks] - Override the content blocks.
 * @returns {object} An `assistant/message` event.
 */
function assistantMessage(id, text, { interrupted = false, time, blocks } = {}) {
  const content = blocks ?? [{ type: "text", text }];
  return { type: "assistant/message", data: { time, interrupted, message: { id, content } } };
}

/** @returns {object} A `turn/end` event. */
function turnEnd() {
  return { type: "turn/end", data: {} };
}

/** Drive a complete turn through `observe` and `stopping`. */
async function storeTurn(capture, sess, turn, { time = 1_700_000_000_000 } = {}) {
  capture.observe(sess, turnStart(turn));
  capture.observe(sess, userMessage(`u-${turn}`, "Hello there"));
  capture.observe(sess, assistantMessage(`a-${turn}`, "Hi back", { time }));
  await capture.stopping(agentOf(sess), turn);
}

test("capture: a complete turn is stored with all pair fields", async (t) => {
  const home = await makeHome(t);
  const db = fakeDb();
  const capture = createCapture({ db, configStore: fakeConfigStore(home), logger: null });
  const sess = session("sess-1", { cwd: "/work/proj" });

  capture.observe(sess, turnStart(7));
  capture.observe(sess, userMessage("u1", "First question"));
  capture.observe(sess, userMessage("u2", "Second question"));
  capture.observe(sess, assistantMessage("a1", "First answer", { time: 1_700_000_000_000 }));
  capture.observe(sess, assistantMessage("a2", "Final answer", { time: 1_700_000_000_001 }));

  await capture.stopping(agentOf(sess), 7);

  const id = pairId({
    sessionId: "sess-1",
    turn: 7,
    userMessageIds: ["u1", "u2"],
    assistantMessageId: "a2",
  });
  const expected = {
    pairId: id,
    sessionId: "sess-1",
    cwd: "/work/proj",
    turn: 7,
    createdAt: 1_700_000_000_001,
    user: "First question\n\nSecond question",
    assistant: "Final answer",
  };

  // Mirrored into the index database.
  assert.deepEqual(db.pairs.get(id), expected);

  // Appended to the JSONL store at the derived path.
  const file = pairFilePath({ home, cwd: "/work/proj", sessionId: "sess-1" });
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), expected);

  // Readable back through readPairs.
  const found = [];
  for await (const { record } of readPairs(home)) {
    found.push(record);
  }
  assert.deepEqual(found, [expected]);
});

test("capture: createdAt falls back to now when no assistant event time", async (t) => {
  const home = await makeHome(t);
  const db = fakeDb();
  const capture = createCapture({ db, configStore: fakeConfigStore(home), logger: null });
  const sess = session("sess-1");

  capture.observe(sess, turnStart(0));
  capture.observe(sess, userMessage("u1", "Hello"));
  capture.observe(sess, assistantMessage("a1", "World")); // no `time` field

  const before = Date.now();
  await capture.stopping(agentOf(sess), 0);
  const after = Date.now();

  const id = pairId({ sessionId: "sess-1", turn: 0, userMessageIds: ["u1"], assistantMessageId: "a1" });
  const record = db.pairs.get(id);
  assert.ok(record, "pair must be stored");
  assert.ok(record.createdAt >= before && record.createdAt <= after, "createdAt must be now-ish");
});

test("capture: subagent sessions are skipped entirely", async (t) => {
  const home = await makeHome(t);
  const db = fakeDb();
  const capture = createCapture({ db, configStore: fakeConfigStore(home), logger: null });
  const sess = session("sess-9", { cwd: "/work/proj", origin: "subagent" });

  capture.observe(sess, turnStart(1));
  capture.observe(sess, userMessage("u1", "hello"));
  capture.observe(sess, assistantMessage("a1", "world"));
  await capture.stopping(agentOf(sess), 1);

  assert.equal(db.pairs.size, 0);
  const found = [];
  for await (const { record } of readPairs(home)) {
    found.push(record);
  }
  assert.deepEqual(found, []);
});

test("capture: a repeated stopping call deduplicates", async (t) => {
  const home = await makeHome(t);
  const db = fakeDb();
  const capture = createCapture({ db, configStore: fakeConfigStore(home), logger: null });
  const sess = session("sess-1", { cwd: "/work/proj" });

  capture.observe(sess, turnStart(2));
  capture.observe(sess, userMessage("u1", "Hello"));
  capture.observe(sess, assistantMessage("a1", "World"));
  await capture.stopping(agentOf(sess), 2);
  await capture.stopping(agentOf(sess), 2); // Repeated notification.

  const file = pairFilePath({ home, cwd: "/work/proj", sessionId: "sess-1" });
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(db.pairs.size, 1);
});

test("capture: a turn without an assistant reply is skipped", async (t) => {
  const home = await makeHome(t);
  const db = fakeDb();
  const capture = createCapture({ db, configStore: fakeConfigStore(home), logger: null });
  const sess = session("sess-1");

  capture.observe(sess, turnStart(0));
  capture.observe(sess, userMessage("u1", "Hello"));
  await capture.stopping(agentOf(sess), 0);

  assert.equal(db.pairs.size, 0);
});

test("capture: an interrupted assistant reply is skipped", async (t) => {
  const home = await makeHome(t);
  const db = fakeDb();
  const capture = createCapture({ db, configStore: fakeConfigStore(home), logger: null });
  const sess = session("sess-1");

  capture.observe(sess, turnStart(0));
  capture.observe(sess, userMessage("u1", "Hello"));
  capture.observe(sess, assistantMessage("a1", "partial", { interrupted: true }));
  await capture.stopping(agentOf(sess), 0);

  assert.equal(db.pairs.size, 0);
});

test("capture: an assistant reply without text blocks is skipped", async (t) => {
  const home = await makeHome(t);
  const db = fakeDb();
  const capture = createCapture({ db, configStore: fakeConfigStore(home), logger: null });
  const sess = session("sess-1");

  capture.observe(sess, turnStart(0));
  capture.observe(sess, userMessage("u1", "Hello"));
  capture.observe(sess, assistantMessage("a1", "", { blocks: [{ type: "tool", id: "t1" }] }));
  await capture.stopping(agentOf(sess), 0);

  assert.equal(db.pairs.size, 0);
});

test("capture: non-user messages never fill the user text", async (t) => {
  const home = await makeHome(t);
  const db = fakeDb();
  const capture = createCapture({ db, configStore: fakeConfigStore(home), logger: null });
  const sess = session("sess-1");

  capture.observe(sess, turnStart(0));
  capture.observe(sess, userMessage("u1", "Hello", { sourceKind: "system" }));
  capture.observe(sess, userMessage("u2", "Human", { sourceKind: "user" }));
  capture.observe(sess, assistantMessage("a1", "World"));
  await capture.stopping(agentOf(sess), 0);

  assert.equal(db.pairs.size, 1);
  const record = [...db.pairs.values()][0];
  assert.equal(record.user, "Human"); // Only the user-sourced message counts.
});

test("capture: stopping ignores a mismatched turn", async (t) => {
  const home = await makeHome(t);
  const db = fakeDb();
  const capture = createCapture({ db, configStore: fakeConfigStore(home), logger: null });
  const sess = session("sess-1");

  capture.observe(sess, turnStart(5));
  capture.observe(sess, userMessage("u1", "Hello"));
  capture.observe(sess, assistantMessage("a1", "World"));
  await capture.stopping(agentOf(sess), 6); // Wrong turn.

  assert.equal(db.pairs.size, 0);
});

test("capture: turn/end and session/disposed drop the buffer", async (t) => {
  const home = await makeHome(t);
  const db = fakeDb();
  const capture = createCapture({ db, configStore: fakeConfigStore(home), logger: null });
  const sess = session("sess-1");

  capture.observe(sess, turnStart(0));
  capture.observe(sess, userMessage("u1", "Hello"));
  capture.observe(sess, assistantMessage("a1", "World"));
  capture.observe(sess, turnEnd());
  await capture.stopping(agentOf(sess), 0);
  assert.equal(db.pairs.size, 0, "turn/end must clear the buffer");

  capture.observe(sess, turnStart(1));
  capture.observe(sess, userMessage("u2", "Again"));
  capture.observe(sess, assistantMessage("a2", "Reply"));
  capture.observe(sess, turnEnd());
  // A stale stopping call after turn/end must not resurrect the turn.
  await capture.stopping(agentOf(sess), 1);
  assert.equal(db.pairs.size, 0);
});

test("capture: storage errors are swallowed, never thrown", async (t) => {
  const home = await makeHome(t);
  const db = fakeDb();
  db.setUpsertError(new Error("db is on fire"));
  const capture = createCapture({ db, configStore: fakeConfigStore(home), logger: null });
  const sess = session("sess-1", { cwd: "/work/proj" });

  capture.observe(sess, turnStart(0));
  capture.observe(sess, userMessage("u1", "Hello"));
  capture.observe(sess, assistantMessage("a1", "World"));

  await capture.stopping(agentOf(sess), 0); // Must resolve without throwing.

  // The JSONL append happened before the failing upsert, so the line exists.
  const file = pairFilePath({ home, cwd: "/work/proj", sessionId: "sess-1" });
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(db.pairs.size, 0, "failed upsert must not leave a db row");
});

test("capture: attach wires the handlers and returns a disposer", async (t) => {
  const home = await makeHome(t);
  const db = fakeDb();
  const capture = createCapture({ db, configStore: fakeConfigStore(home), logger: null });

  const handlers = new Map();
  const ctx = {
    on(type, handler) {
      handlers.set(type, handler);
    },
    off(type, handler) {
      if (handlers.get(type) === handler) {
        handlers.delete(type);
      }
    },
  };
  const disposer = capture.attach(ctx);

  for (const type of ["session/event", "agent/turn-stopping", "session/disposed"]) {
    assert.ok(handlers.has(type), `${type} must be registered`);
  }

  // Drive a full turn through the wired handlers.
  const sess = session("sess-1", { cwd: "/work/proj" });
  const emit = (event) => handlers.get("session/event")(sess, event);
  emit(turnStart(0));
  emit(userMessage("u1", "Hello"));
  emit(assistantMessage("a1", "World", { time: 1_700_000_000_000 }));
  await handlers.get("agent/turn-stopping")({ agent: agentOf(sess), turn: 0 });

  assert.equal(db.pairs.size, 1);
  const record = [...db.pairs.values()][0];
  assert.equal(record.user, "Hello");
  assert.equal(record.assistant, "World");
  assert.equal(record.createdAt, 1_700_000_000_000);

  // session/disposed drops the buffer for the next turn.
  emit(turnStart(1));
  emit(userMessage("u2", "Again"));
  handlers.get("session/disposed")(sess);
  emit(assistantMessage("a2", "Reply"));
  await handlers.get("agent/turn-stopping")({ agent: agentOf(sess), turn: 1 });
  assert.equal(db.pairs.size, 1, "disposed session must not be stored");

  // The disposer unregisters everything and is safe to call twice.
  disposer();
  disposer();
  assert.equal(handlers.size, 0);
});
