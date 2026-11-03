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
import { apply } from "../index.js";
import { createConfigStore } from "../lib/config.js";
import { openIndexDatabase } from "../lib/db.js";
import { createCapture } from "../lib/capture.js";
import { createIndexer } from "../lib/indexer.js";
import { createRetriever } from "../lib/retrieval.js";
import { createInjector } from "../lib/inject.js";
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
 * injector (attached to a fake ctx). Cleanup is registered on `t.after`.
 *
 * @param {import("node:test").TestContext} t
 * @param {object} [options]
 * @param {object} [options.patch] - Config patch applied via `configStore.save`.
 * @param {object|null} [options.reranker] - Optional fake rerank client.
 * @returns {Promise<object>} The assembled pipeline pieces.
 */
async function makePipeline(t, { patch = {}, reranker = null } = {}) {
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
  const indexer = createIndexer({ db, configStore, embeddings, home });
  const retriever = createRetriever({ db, configStore, embeddings, reranker });
  const injector = createInjector({ retriever, configStore });

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

  return { home, configStore, db, capture, indexer, retriever, injector, injectorCtx, embeddings };
}

/** Collect the pair records currently on disk under a home directory. */
async function collectPairs(home) {
  const records = [];
  for await (const { record } of readPairs(home)) {
    records.push(record);
  }
  return records;
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
    await makePipeline(t);

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
