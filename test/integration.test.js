/**
 * End-to-end integration tests for `dsh-context-rag`.
 *
 * These tests exercise the real modules together (capture -> JSONL pair store
 * -> index database -> indexer -> retriever -> injector) using a temporary
 * home directory and a fake host context plus a fake embeddings/rerank client.
 * No real network is used.
 *
 * @module integration
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { apply } from "../index.js";
import { createConfigStore } from "../lib/config.js";
import { openIndexDatabase } from "../lib/db.js";
import { createCapture } from "../lib/capture.js";
import { createIndexer } from "../lib/indexer.js";
import { createRetriever } from "../lib/retrieval.js";
import { createInjector } from "../lib/inject.js";
import { createRecallState } from "../lib/recall-state.js";
import { createMemoryStore } from "../lib/memories.js";
import { workspaceSlug } from "../lib/paths.js";
import { renderInjection } from "../lib/render.js";
import { readPairs } from "../lib/pairs.js";
import { makeTempDir, cleanupTempDir } from "./helpers/tmp.js";

/**
 * Build a fake host context that records listeners, effects, and webServer
 * routes, and can drive an `agent/pre-step` waterfall where each listener
 * receives `(payload, next)` and the terminal resolves to a supplied base
 * decision.
 *
 * @returns {object} A fake `ctx`.
 */
function makeCtx() {
  /** @type {Map<string, Array<{fn: Function, opts: object}>>} */
  const listeners = new Map();
  /** @type {Array<Function>} */
  const disposers = [];
  /** @type {Array<object>} */
  const routes = [];
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },

    on(event, fn, opts) {
      const list = listeners.get(event) || [];
      list.push({ fn, opts: opts ?? {} });
      listeners.set(event, list);
      return () => {
        const index = list.findIndex((entry) => entry.fn === fn);
        if (index !== -1) list.splice(index, 1);
      };
    },

    effect(fn) {
      const result = fn();
      if (typeof result === "function") disposers.push(result);
      return result;
    },

    inject(deps, cb) {
      cb(this);
    },

    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },

    listeners,
    disposers,
    routes,

    /**
     * Emit an event. For `agent/pre-step` this walks the registered listeners
     * outermost-first (registration order); each listener receives
     * `(payload, next)` where `next()` invokes the following listener. The
     * terminal `next()` resolves to `terminal()` (defaults to a neutral
     * `{kind: "enter", messages: []}` decision). Each listener's `next` is
     * called exactly once.
     *
     * @param {string} event
     * @param {object} payload
     * @param {() => object} [terminal]
     * @returns {Promise<object>}
     */
    async emit(event, payload, terminal) {
      const list = (listeners.get(event) || []).slice();
      let index = 0;
      const callNext = () => {
        if (index >= list.length) {
          return Promise.resolve(
            typeof terminal === "function"
              ? terminal()
              : { kind: "enter", messages: [] },
          );
        }
        const { fn } = list[index];
        index += 1;
        return Promise.resolve(fn(payload, callNext));
      };
      return callNext();
    },
  };
  return ctx;
}

/**
 * Deterministic 4-dim normalized fake embeddings. Texts containing "alpha"
 * embed to `[1,0,0,0]`, "beta" to `[0,1,0,0]`, and anything else to
 * `[0,0,1,0]`. Accepts the optional `{signal}` the real retriever passes.
 *
 * @returns {{embed: Function}}
 */
function makeEmbeddings() {
  return {
    async embed(texts, { signal } = {}) {
      const vectors = texts.map((text) => {
        const value = String(text);
        if (value.includes("alpha")) return [1, 0, 0, 0];
        if (value.includes("beta")) return [0, 1, 0, 0];
        return [0, 0, 1, 0];
      });
      return { vectors, model: "fake-embed", dimension: 4 };
    },
  };
}

/**
 * Drive a single turn through the capture surface using the documented DSH
 * session events, then close it via `capture.stopping`.
 *
 * @param {object} capture
 * @param {object} session
 * @param {object} turn
 * @param {number} turn.turn
 * @param {string} turn.userText
 * @param {string} turn.userId
 * @param {string} turn.assistantText
 * @param {string} turn.assistantId
 */
function captureTurn(capture, session, { turn, userText, userId, assistantText, assistantId }) {
  capture.observe(session, { type: "turn/start", data: { turn } });
  capture.observe(session, {
    type: "user/message",
    data: { id: userId, source: { kind: "user" }, content: [{ type: "text", text: userText }] },
  });
  capture.observe(session, {
    type: "assistant/message",
    data: { message: { id: assistantId, content: [{ type: "text", text: assistantText }] } },
  });
}

/**
 * Stand up a real end-to-end pipeline in a fresh temporary home:
 * config store + real SQLite index DB + capture + indexer + retriever +
 * injector (attached to a fake ctx) + a real recall-state store persisted
 * under `<home>/recall-state.json`. With `withMemoryStore`, a real memory
 * store (see `lib/memories.js`) is created under `<home>/memories` and wired
 * into the indexer so reconciliation also syncs memories. Cleanup is
 * registered on `t.after`.
 *
 * @param {import("node:test").TestContext} t
 * @param {object} [options]
 * @param {object} [options.patch] - Config patch applied via `configStore.save`.
 * @param {object|null} [options.reranker] - Optional fake rerank client.
 * @param {boolean} [options.withMemoryStore] - When true, create and wire a
 *   real `createMemoryStore` into the indexer.
 * @returns {Promise<object>} The assembled pipeline pieces.
 */
async function makePipeline(t, { patch = {}, reranker = null, withMemoryStore = false } = {}) {
  const home = await makeTempDir("dsh-rag-int-");
  const configStore = createConfigStore({ home });
  configStore.save({
    embedding: { baseUrl: "http://fake", model: "fake-embed", dimensions: 4 },
    retrieval: {
      scope: "workspace",
      candidateLimit: 5,
      topK: 2,
      minScore: 0.2,
      maxContextChars: 2000,
      timeoutMs: 2000,
    },
    indexing: { enabled: true },
    ...patch,
  });

  const db = openIndexDatabase(path.join(home, "index.sqlite"));
  const embeddings = makeEmbeddings();
  const capture = createCapture({ db, configStore });
  const memoryStore = withMemoryStore
    ? createMemoryStore({ home, configStore })
    : null;
  const indexer = createIndexer({
    db,
    configStore,
    embeddings,
    home,
    ...(memoryStore ? { memoryStore } : {}),
  });
  const recallState = createRecallState({
    file: path.join(home, "recall-state.json"),
  });
  const config = configStore.get();
  recallState.load({
    retentionDays: config.retrieval?.dedupeStateRetentionDays ?? 90,
    maxSessions: config.retrieval?.dedupeStateMaxSessions ?? 500,
  });
  const retriever = createRetriever({ db, configStore, embeddings, reranker, recallState });
  const injector = createInjector({ retriever, configStore, recallState });

  const injectorCtx = makeCtx();
  injector.attach(injectorCtx);

  t.after(async () => {
    await indexer.stop();
    try {
      db.close();
    } catch {
      // Already closed; ignore.
    }
    await cleanupTempDir(home);
  });

  return {
    home,
    configStore,
    db,
    capture,
    indexer,
    retriever,
    injector,
    injectorCtx,
    embeddings,
    recallState,
    ...(memoryStore ? { memoryStore } : {}),
  };
}

/** Collect the pair records currently on disk under a home directory. */
async function collectPairs(home) {
  const records = [];
  for await (const { record } of readPairs(home)) {
    records.push(record);
  }
  return records;
}

/**
 * Emit a single `agent/pre-step` injection for a session with one fresh
 * direct user message, returning the resulting decision.
 *
 * @param {object} injectorCtx - Fake host context with the injector attached.
 * @param {object} session - Session object with `id` and `header.cwd`.
 * @param {number} turn - Current session turn.
 * @param {string} text - User message text.
 * @param {string} messageId - Unique user message id.
 * @returns {Promise<object>} The final decision.
 */
async function emitInjection(injectorCtx, session, turn, text, messageId) {
  const baseDecision = {
    kind: "enter",
    messages: [
      {
        id: messageId,
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "user" },
      },
    ],
  };
  const payload = {
    agent: { session },
    turn,
    step: 1,
    signal: new AbortController().signal,
  };
  return injectorCtx.emit("agent/pre-step", payload, () => baseDecision);
}

// ---------------------------------------------------------------------------
// Test 1: `apply` smoke.
// ---------------------------------------------------------------------------

test("apply registers listeners and the config API, then tears down cleanly", async (t) => {
  const home = await makeTempDir("dsh-rag-apply-");
  t.after(() => cleanupTempDir(home));

  const ctx = makeCtx();
  assert.doesNotThrow(() => apply(ctx, { home }));

  // Config API route registered on the exact path.
  assert.ok(
    ctx.routes.some((route) => route.path === "/plugins/dsh-context-rag/api"),
    "the /plugins/dsh-context-rag/api route must be registered",
  );

  // The capture + injector listeners are attached.
  for (const event of ["session/event", "agent/turn-stopping", "agent/pre-step"]) {
    assert.ok(
      (ctx.listeners.get(event) || []).length >= 1,
      `at least one ${event} listener must be registered`,
    );
  }

  // Running the recorded effects (indexer stop, db close, api disposer) must
  // not throw.
  for (const disposer of ctx.disposers) {
    const result = disposer();
    if (result && typeof result.then === "function") {
      await result;
    }
  }
});

// ---------------------------------------------------------------------------
// Test 2: end-to-end capture -> index -> retrieve -> inject.
// ---------------------------------------------------------------------------

test("captures a pair, indexes it, and injects related context with dedupe", async (t) => {
  const { home, configStore, db, capture, indexer, retriever, injectorCtx } =
    await makePipeline(t, {
      patch: { retrieval: { allowSameSession: true } },
    });

  // Simulate one turn in a workspace.
  const session = { id: "sess-alpha", header: { cwd: "/tmp/work" } };
  captureTurn(capture, session, {
    turn: 1,
    userText: "alpha question",
    userId: "u1",
    assistantText: "alpha answer",
    assistantId: "a1",
  });
  await capture.stopping({ session }, 1);

  // The JSONL pair store gained one parseable pair; the outbox is pending.
  const pairs = await collectPairs(home);
  assert.equal(pairs.length, 1, "exactly one pair line should be on disk");
  assert.equal(pairs[0].user, "alpha question");
  assert.equal(pairs[0].assistant, "alpha answer");
  assert.equal(pairs[0].cwd, "/tmp/work");
  assert.ok(db.stats().pendingCount >= 1, "a pending outbox entry must exist");

  // Reconcile + one pump indexes the pair.
  await indexer.reconcile();
  await indexer.pumpOnce();
  const indexed = db.stats();
  assert.equal(indexed.indexedCount, 1);
  assert.equal(indexed.pendingCount, 0);

  // Emit an agent/pre-step carrying a fresh direct user message.
  const baseDecision = {
    kind: "enter",
    messages: [
      { id: "u2", role: "user", content: [{ type: "text", text: "alpha follow up" }], source: { kind: "user" } },
    ],
  };
  const payload = {
    agent: { session },
    turn: 2,
    step: 1,
    signal: new AbortController().signal,
  };

  const decision = await injectorCtx.emit("agent/pre-step", payload, () => baseDecision);

  assert.equal(decision.messages.length, 2, "the decision must gain one context message");
  const added = decision.messages[1];
  assert.equal(added.role, "user");
  assert.equal(added.source.kind, "context-rag");
  assert.equal(added.source.form, "notice");
  assert.ok(added.source.summary.includes("Retrieved"), "summary must describe retrieval");
  assert.ok(added.content[0].text.includes("alpha question"), "injected text must carry the user text");
  assert.ok(added.content[0].text.includes("alpha answer"), "injected text must carry the assistant text");
  assert.ok(
    added.content[0].text.includes("untrusted reference material"),
    "injected text must carry the fixed warning",
  );

  // Re-emit the same payload: the same user message is deduped, so no second
  // context message is appended.
  const decision2 = await injectorCtx.emit("agent/pre-step", payload, () => baseDecision);
  assert.equal(decision2.messages.length, 1, "repeated pre-step must not re-inject");
  assert.equal(
    decision2.messages.filter((m) => m.source?.kind === "context-rag").length,
    0,
  );
});

// ---------------------------------------------------------------------------
// Test 2b: same-session exclusion (default allowSameSession: false).
// ---------------------------------------------------------------------------

test("default allowSameSession false does not inject the current session's pair; other sessions stay eligible", async (t) => {
  const { db, capture, indexer, injectorCtx } = await makePipeline(t);

  // One pair in session A, same workspace as the injections.
  const sessionA = { id: "sess-a", header: { cwd: "/tmp/work" } };
  captureTurn(capture, sessionA, {
    turn: 1,
    userText: "alpha question",
    userId: "au",
    assistantText: "alpha answer",
    assistantId: "aa",
  });
  await capture.stopping({ session: sessionA }, 1);
  await indexer.reconcile();
  await indexer.pumpOnce();
  assert.equal(db.stats().indexedCount, 1);

  // A pre-step injection in session A must NOT pull in its own pair.
  const same = await emitInjection(injectorCtx, sessionA, 2, "alpha follow up", "u2");
  assert.equal(
    same.messages.filter((m) => m.source?.kind === "context-rag").length,
    0,
    "the current session's own pair must not be injected by default",
  );

  // A pair from another session in the same workspace is still eligible.
  const sessionB = { id: "sess-b", header: { cwd: "/tmp/work" } };
  captureTurn(capture, sessionB, {
    turn: 1,
    userText: "beta question",
    userId: "bu",
    assistantText: "beta answer",
    assistantId: "ba",
  });
  await capture.stopping({ session: sessionB }, 1);
  await indexer.reconcile();
  await indexer.pumpOnce();
  assert.equal(db.stats().indexedCount, 2);

  const other = await emitInjection(injectorCtx, sessionA, 3, "beta follow up", "u3");
  const added = other.messages.filter((m) => m.source?.kind === "context-rag");
  assert.equal(added.length, 1, "a pair from another session must still be injectable");
  assert.ok(added[0].content[0].text.includes("beta question"));
});

// ---------------------------------------------------------------------------
// Test 2c: turn dedupe end-to-end with a real recall-state file.
// ---------------------------------------------------------------------------

test("turn dedupe: pair injected at turn 2 is skipped at turn 3 and eligible again at turn 7", async (t) => {
  const { home, db, capture, indexer, retriever, injectorCtx } = await makePipeline(t, {
    patch: { retrieval: { allowSameSession: true, dedupeTurns: 5 } },
  });

  const session = { id: "sess-dedupe", header: { cwd: "/tmp/work" } };
  captureTurn(capture, session, {
    turn: 1,
    userText: "alpha question",
    userId: "u1",
    assistantText: "alpha answer",
    assistantId: "a1",
  });
  await capture.stopping({ session }, 1);
  await indexer.reconcile();
  await indexer.pumpOnce();
  assert.equal(db.stats().indexedCount, 1);

  // Direct retrieval at turn 2: the pair is eligible; capture its id.
  const first = await retriever.retrieve({
    query: "alpha follow up",
    cwd: "/tmp/work",
    sessionId: session.id,
    turn: 2,
    mode: "injection",
  });
  assert.equal(first.stats.dedupeApplied, true);
  assert.equal(first.stats.excludedDedupe, 0);
  assert.ok(first.pairs.length > 0, "the pair must be eligible at turn 2");
  const pairId = first.pairs[0].pairId;
  assert.equal(typeof pairId, "string");
  assert.ok(pairId.length > 0);

  // Real pre-step injection at turn 2: injects the pair and records it.
  const injected2 = await emitInjection(injectorCtx, session, 2, "alpha follow up", "u2");
  const added2 = injected2.messages.filter((m) => m.source?.kind === "context-rag");
  assert.equal(added2.length, 1, "turn 2 must inject the pair");
  assert.ok(added2[0].content[0].text.includes("alpha question"));

  // The recall-state file is persisted with the recorded turn.
  const stateFile = path.join(home, "recall-state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.sessions[session.id].entries[pairId].lastTurn, 2);

  // Turn 3: injected 1 turn ago; 3 - 2 = 1 < 5 -> excluded, nothing injected.
  const injected3 = await emitInjection(injectorCtx, session, 3, "alpha follow up again", "u3");
  assert.equal(
    injected3.messages.filter((m) => m.source?.kind === "context-rag").length,
    0,
    "the pair must not be injected at turn 3",
  );

  // Turn 7: 7 - 2 = 5 >= 5 -> eligible again.
  const later = await retriever.retrieve({
    query: "alpha follow up",
    cwd: "/tmp/work",
    sessionId: session.id,
    turn: 7,
    mode: "injection",
  });
  assert.equal(later.stats.dedupeApplied, true);
  assert.equal(later.stats.excludedDedupe, 0);
  assert.ok(
    later.pairs.some((pair) => pair.pairId === pairId),
    "the pair must be eligible again at turn 7",
  );

  // Real pre-step injection at turn 7: injects the pair once more and
  // re-records the later turn.
  const injected7 = await emitInjection(injectorCtx, session, 7, "alpha follow up", "u7");
  const added7 = injected7.messages.filter((m) => m.source?.kind === "context-rag");
  assert.equal(added7.length, 1, "turn 7 must inject the pair again");
  const state2 = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state2.sessions[session.id].entries[pairId].lastTurn, 7);
});

// ---------------------------------------------------------------------------
// Test 3: retrieval scope.
// ---------------------------------------------------------------------------

test("workspace scope excludes other workspaces; scope all includes them", async (t) => {
  const { configStore, db, capture, indexer, retriever } = await makePipeline(t);

  // alpha in /tmp/work, beta in /tmp/other.
  const alpha = { id: "s-alpha", header: { cwd: "/tmp/work" } };
  captureTurn(capture, alpha, { turn: 1, userText: "alpha question", userId: "au", assistantText: "alpha answer", assistantId: "aa" });
  await capture.stopping({ session: alpha }, 1);
  const beta = { id: "s-beta", header: { cwd: "/tmp/other" } };
  captureTurn(capture, beta, { turn: 1, userText: "beta question", userId: "bu", assistantText: "beta answer", assistantId: "ba" });
  await capture.stopping({ session: beta }, 1);

  await indexer.reconcile();
  await indexer.pumpOnce();
  assert.equal(db.stats().indexedCount, 2);

  // workspace scope from /tmp/work only sees the workspace pair.
  const workspaceRes = await retriever.retrieve({ query: "alpha query", cwd: "/tmp/work" });
  assert.equal(workspaceRes.stats.candidateCount, 1);
  assert.ok(workspaceRes.pairs.length > 0);
  assert.ok(
    workspaceRes.pairs.every((pair) => pair.cwd === "/tmp/work"),
    "workspace scope must not return the other workspace pair",
  );

  // Switch to scope all: the other workspace is now considered and returned.
  configStore.save({ retrieval: { scope: "all" } });
  const allRes = await retriever.retrieve({ query: "beta query", cwd: "/tmp/work" });
  assert.equal(allRes.stats.candidateCount, 2);
  assert.ok(
    allRes.pairs.some((pair) => pair.cwd === "/tmp/other"),
    "scope=all must include the other workspace pair",
  );
});

// ---------------------------------------------------------------------------
// Test 4: rerank ordering and fallback.
// ---------------------------------------------------------------------------

test("rerank reorders results by its scores and falls back to cosine on failure", async (t) => {
  const reranker = {
    async rerank({ query, documents }) {
      // Score each candidate 1..n so the last candidate ranks first.
      return { results: documents.map((_, i) => ({ index: i, score: i + 1 })) };
    },
  };
  const { db, capture, indexer, retriever } = await makePipeline(t, {
    patch: {
      retrieval: { scope: "all", candidateLimit: 5, topK: 2, minScore: 0 },
      rerank: { enabled: true, baseUrl: "http://fake", model: "fake-rerank" },
    },
    reranker,
  });

  const alpha = { id: "s-alpha", header: { cwd: "/tmp/work" } };
  captureTurn(capture, alpha, { turn: 1, userText: "alpha question", userId: "au", assistantText: "alpha answer", assistantId: "aa" });
  await capture.stopping({ session: alpha }, 1);
  const beta = { id: "s-beta", header: { cwd: "/tmp/other" } };
  captureTurn(capture, beta, { turn: 1, userText: "beta question", userId: "bu", assistantText: "beta answer", assistantId: "ba" });
  await capture.stopping({ session: beta }, 1);
  await indexer.reconcile();
  await indexer.pumpOnce();
  assert.equal(db.stats().indexedCount, 2);

  const res = await retriever.retrieve({ query: "alpha", cwd: "/tmp/work" });
  assert.equal(res.stats.reranked, true);
  assert.equal(res.stats.candidateCount, 2);
  assert.equal(res.pairs.length, 2);
  assert.equal(res.pairs[0].cwd, "/tmp/other", "beta scores highest so ranks first");
  assert.equal(res.pairs[1].cwd, "/tmp/work");
});

test("rerank failure falls back to cosine order and still returns pairs", async (t) => {
  const throwingReranker = {
    async rerank() {
      throw new Error("rerank is down");
    },
  };
  const { db, capture, indexer, retriever } = await makePipeline(t, {
    patch: {
      retrieval: { scope: "all", candidateLimit: 5, topK: 2, minScore: 0 },
      rerank: { enabled: true, baseUrl: "http://fake", model: "fake-rerank" },
    },
    reranker: throwingReranker,
  });

  const alpha = { id: "s-alpha", header: { cwd: "/tmp/work" } };
  captureTurn(capture, alpha, { turn: 1, userText: "alpha question", userId: "au", assistantText: "alpha answer", assistantId: "aa" });
  await capture.stopping({ session: alpha }, 1);
  await indexer.reconcile();
  await indexer.pumpOnce();
  assert.equal(db.stats().indexedCount, 1);

  const res = await retriever.retrieve({ query: "alpha", cwd: "/tmp/work" });
  assert.equal(res.stats.reranked, false);
  assert.ok(res.pairs.length > 0, "cosine fallback must still return pairs");
});

// ---------------------------------------------------------------------------
// Test 5: error paths.
// ---------------------------------------------------------------------------

test("retrieval is a no-op when embedding is not configured", async (t) => {
  const { retriever } = await makePipeline(t, {
    patch: { embedding: { baseUrl: "", model: "", dimensions: null } },
  });
  const res = await retriever.retrieve({ query: "alpha", cwd: "/tmp/work" });
  assert.equal(res.stats.skipped, "not-configured");
  assert.equal(res.pairs.length, 0);
});

test("indexer pumpOnce returns 0 when embedding indexing is disabled", async (t) => {
  const home = await makeTempDir("dsh-rag-disabled-");
  t.after(() => cleanupTempDir(home));

  const configStore = createConfigStore({ home });
  configStore.save({
    embedding: { baseUrl: "http://fake", model: "fake-embed", dimensions: 4 },
    indexing: { enabled: false },
  });

  const db = openIndexDatabase(path.join(home, "index.sqlite"));
  t.after(() => {
    try {
      db.close();
    } catch {
      // Already closed; ignore.
    }
  });

  // Seed one pair so the outbox is non-empty.
  db.upsertPair({
    pairId: "p1",
    sessionId: "s1",
    cwd: "/tmp/work",
    turn: 1,
    createdAt: 1,
    user: "alpha question",
    assistant: "alpha answer",
  });
  assert.ok(db.stats().pendingCount >= 1);

  // The embedding model is configured; `indexing.enabled: false` is the only
  // reason pumpOnce must be a no-op.
  const indexer = createIndexer({ db, configStore, embeddings: makeEmbeddings(), home });

  assert.equal(await indexer.pumpOnce(), 0);
  assert.ok(db.stats().pendingCount >= 1, "the outbox must remain untouched");
});

// ---------------------------------------------------------------------------
// Test 6: renderInjection budget.
// ---------------------------------------------------------------------------

test("renderInjection never exceeds maxChars and truncates oversized entries", () => {
  const now = Date.now();
  const pairs = [
    { userText: "u".repeat(150), assistantText: "a".repeat(150), createdAt: now, cwd: "/work" },
    { userText: "x".repeat(150), assistantText: "y".repeat(150), createdAt: now, cwd: "/other" },
  ];
  const maxChars = 400;
  const rendered = renderInjection({ pairs, maxChars });

  assert.ok(rendered, "renderInjection must produce a result within the budget");
  assert.ok(rendered.text.length <= maxChars, `text (${rendered.text.length}) must not exceed maxChars`);
  assert.ok(rendered.text.includes("Context RAG:"), "rendered text must include the header");
  assert.ok(rendered.text.includes("…[truncated]…"), "oversized entries must be truncated");
  assert.ok(rendered.summary.includes("Retrieved"));
});

// ---------------------------------------------------------------------------
// Test 7: memories end-to-end (real memory store + SQLite + indexer +
// retriever + injector). These exercise the shared embedding/outbox pipeline:
// reconcile syncs scanned memories, pumpOnce embeds them, and recall merges
// global + current-workspace memories with conversation pairs regardless of
// `retrieval.scope`, while other-workspace memories stay out.
// ---------------------------------------------------------------------------

test("memories: global + current workspace memories embed and recall; other workspaces stay out", async (t) => {
  const { db, configStore, capture, indexer, retriever, injectorCtx, memoryStore } = await makePipeline(t, {
    patch: { retrieval: { allowSameSession: true, topK: 10, candidateLimit: 10 } },
    withMemoryStore: true,
  });

  // One conversation pair in /tmp/work, plus memories in global, the current
  // workspace (/tmp/work), and another workspace (/tmp/other).
  const session = { id: "sess-mem", header: { cwd: "/tmp/work" } };
  captureTurn(capture, session, {
    turn: 1,
    userText: "alpha question",
    userId: "u1",
    assistantText: "alpha answer",
    assistantId: "a1",
  });
  await capture.stopping({ session }, 1);

  const global = memoryStore.write({
    type: "global",
    name: "global-note",
    description: "Global preference",
    content: "alpha global memory content",
  });
  const work = memoryStore.write({
    type: "workspace",
    cwd: "/tmp/work",
    name: "work-note",
    description: "Work note",
    content: "alpha work memory content",
  });
  const other = memoryStore.write({
    type: "workspace",
    cwd: "/tmp/other",
    name: "other-note",
    description: "Other note",
    content: "alpha other memory content",
  });

  // Reconcile syncs the pair and the scanned memories, then pumpOnce embeds
  // them through the shared outbox.
  await indexer.reconcile();
  await indexer.pumpOnce();
  assert.equal(db.stats().indexedCount, 4, "pair + 3 memories must all be indexed");

  // Workspace scope from /tmp/work: the pair, the global memory, and the
  // /tmp/work memory are candidates; the /tmp/other memory is not.
  const res = await retriever.retrieve({ query: "alpha", cwd: "/tmp/work" });
  assert.equal(res.stats.candidateCount, 3, "pair + global memory + current-workspace memory");
  const ids = new Set(res.pairs.map((p) => p.pairId));
  assert.ok(ids.has(global.record.pairId), "the global memory must be recalled");
  assert.ok(ids.has(work.record.pairId), "the current-workspace memory must be recalled");
  assert.ok(!ids.has(other.record.pairId), "the other-workspace memory must not be recalled");

  // scope=all keeps memory scoping to global + the current cwd.
  configStore.save({ retrieval: { scope: "all" } });
  const all = await retriever.retrieve({ query: "alpha", cwd: "/tmp/work" });
  assert.equal(all.stats.candidateCount, 3);
  const allIds = new Set(all.pairs.map((p) => p.pairId));
  assert.ok(allIds.has(global.record.pairId));
  assert.ok(allIds.has(work.record.pairId));
  assert.ok(!allIds.has(other.record.pairId), "scope=all must not pull in the other-workspace memory");

  // End-to-end injection renders the memories as `Memory · global|workspace`
  // entries alongside the conversation pair.
  const decision = await emitInjection(injectorCtx, session, 2, "alpha follow up", "u-mem");
  const added = decision.messages.filter((m) => m.source?.kind === "context-rag");
  assert.equal(added.length, 1, "memories must be injectable through the pre-step hook");
  assert.ok(added[0].content[0].text.includes("Memory · global"), "the global memory entry must be rendered");
  assert.ok(added[0].content[0].text.includes("Memory · workspace"), "the workspace memory entry must be rendered");
  assert.ok(added[0].content[0].text.includes("alpha global memory content"));
  assert.ok(added[0].content[0].text.includes("alpha work memory content"));
});

test("memories: deleting the index row (tool flow) stops recall immediately", async (t) => {
  const { db, indexer, retriever, memoryStore } = await makePipeline(t, {
    patch: { retrieval: { allowSameSession: true, topK: 10, candidateLimit: 10 } },
    withMemoryStore: true,
  });

  const work = memoryStore.write({
    type: "workspace",
    cwd: "/tmp/work",
    name: "work-note",
    description: "Work note",
    content: "alpha work memory content",
  });
  await indexer.reconcile();
  await indexer.pumpOnce();
  assert.equal(db.stats().indexedCount, 1);

  const before = await retriever.retrieve({ query: "alpha", cwd: "/tmp/work" });
  assert.ok(
    before.pairs.some((p) => p.pairId === work.record.pairId),
    "the memory must be recalled before deletion",
  );

  // The memory_forget tool flow: remove from the store, then drop the index
  // row via db.deletePair.
  const removed = memoryStore.remove({
    type: "workspace",
    cwd: "/tmp/work",
    name: "work-note",
    description: "Work note",
  });
  assert.ok(removed, "remove() must report the removed record");
  assert.equal(db.deletePair(removed.record.pairId), true);
  assert.equal(db.getPair(removed.record.pairId), null);

  const after = await retriever.retrieve({ query: "alpha", cwd: "/tmp/work" });
  assert.equal(after.stats.candidateCount, 0);
  assert.ok(
    !after.pairs.some((p) => p.pairId === work.record.pairId),
    "the deleted memory must no longer be recalled",
  );
});

test("memories: reconcile picks up manual file edits and drops manually deleted/forgotten files", async (t) => {
  const { db, indexer, retriever, memoryStore, home } = await makePipeline(t, {
    patch: { retrieval: { allowSameSession: true, topK: 10, candidateLimit: 10 } },
    withMemoryStore: true,
  });

  const edit = memoryStore.write({
    type: "workspace",
    cwd: "/tmp/work",
    name: "edit-note",
    description: "Edit note",
    content: "alpha original",
  });
  const gone = memoryStore.write({
    type: "global",
    name: "gone-note",
    description: "Gone note",
    content: "alpha gone",
  });
  const forgot = memoryStore.write({
    type: "global",
    name: "forgot-note",
    description: "Forgot note",
    content: "alpha forgot",
  });
  await indexer.reconcile();
  await indexer.pumpOnce();
  assert.equal(db.stats().indexedCount, 3);

  // Manual edit: rewrite the body on disk directly, keeping the front matter.
  const editFile = path.join(
    home,
    "memories",
    "workspaces",
    workspaceSlug("/tmp/work"),
    "edit-note.md",
  );
  await writeFile(
    editFile,
    `---\n${JSON.stringify({
      name: "edit-note",
      description: "Edit note",
      type: "workspace",
      createdAt: edit.record.createdAt,
      cwd: "/tmp/work",
    })}\n---\nalpha edited body`,
  );

  // Manual delete and manual "forget" (rename to .forgotten).
  await rm(path.join(home, "memories", "global", "gone-note.md"));
  await rename(
    path.join(home, "memories", "global", "forgot-note.md"),
    path.join(home, "memories", "global", "forgot-note.forgotten"),
  );

  // Reconcile syncs the file-system state.
  await indexer.reconcile();

  // The edited memory is refreshed: its content changed, so the stale
  // embedding is cleared and re-computed on the next pump.
  const edited = db.getPair(edit.record.pairId);
  assert.equal(edited.userText, "alpha edited body");
  assert.equal(edited.vector, null, "a content change must clear the stale embedding");
  await indexer.pumpOnce();
  assert.notEqual(db.getPair(edit.record.pairId).vector, null, "the new content must be re-embedded");

  // The manually deleted and forgotten memories are no longer indexed.
  assert.equal(db.getPair(gone.record.pairId), null, "the deleted memory row must be gone");
  assert.equal(db.getPair(forgot.record.pairId), null, "the forgotten memory row must be gone");
  assert.equal(db.stats().indexedCount, 1);

  // Only the edited memory is recalled.
  const res = await retriever.retrieve({ query: "alpha", cwd: "/tmp/work" });
  const ids = new Set(res.pairs.map((p) => p.pairId));
  assert.ok(ids.has(edit.record.pairId));
  assert.ok(!ids.has(gone.record.pairId));
  assert.ok(!ids.has(forgot.record.pairId));
});
