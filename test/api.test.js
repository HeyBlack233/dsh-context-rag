/**
 * Tests for the plugin config API (`lib/api.js`).
 *
 * All dependencies are fakes; no network and no real SQLite. HTTP handling is
 * exercised by driving `handle` with EventEmitter-based fake req objects and
 * capturing fake res objects; actions are also driven directly through the
 * exported internal `dispatch`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_PATH, MAX_BODY_BYTES, dispatch, handle, registerApi } from "../lib/api.js";

/** Home used by the default fakes; never created, so fs-derived stats are 0. */
const MISSING_HOME = join(tmpdir(), `dsh-rag-api-missing-${process.pid}`);

/** Build a full fake dependency bag plus call counters. */
function makeDeps(overrides = {}) {
  const calls = { save: [], reconcile: 0, reindex: 0, clear: 0, embeddingTests: 0, rerankTests: 0 };
  const deps = {
    configStore: {
      home: MISSING_HOME,
      masked: () => ({ embedding: { model: "text-embedding-3" }, rerank: { model: "rerank-model" } }),
      get: () => ({ embedding: { model: "text-embedding-3", apiKey: "secret-key" } }),
      save: async (patch) => {
        calls.save.push(patch);
      },
    },
    db: {
      stats: () => ({ pairCount: 3, indexedCount: 2, pendingCount: 1, errorCount: 0, model: "text-embedding-3", dim: 384 }),
    },
    embeddings: {
      testConnection: async () => {
        calls.embeddingTests += 1;
        return { ok: true, model: "text-embedding-3", dimension: 384, latencyMs: 12 };
      },
    },
    reranker: {
      testConnection: async () => {
        calls.rerankTests += 1;
        return { ok: true, model: "rerank-model", topScore: 0.9, latencyMs: 7 };
      },
    },
    indexer: {
      status: () => ({ running: true, lastError: null, reconcileError: null }),
      reconcile: async () => {
        calls.reconcile += 1;
      },
      reindex: async () => {
        calls.reindex += 1;
      },
      clear: async () => {
        calls.clear += 1;
      },
    },
    retriever: {
      status: () => ({ lastRetrieval: null, lastError: null }),
    },
    injector: {
      status: () => ({ lastError: null }),
    },
    initError: null,
    ...overrides,
  };
  return { deps, calls };
}

/** Fake req: an EventEmitter carrying method/url/headers plus a body to emit. */
function makeRequest({ method = "POST", headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = API_PATH;
  req.headers = headers;
  req.body = body;
  req.resumeCalls = 0;
  req.resume = () => {
    req.resumeCalls += 1;
  };
  return req;
}

/** Fake res capturing the status code, headers, and body text. */
function makeResponse() {
  const res = { statusCode: 0, headers: null, body: "" };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = (text) => {
    res.body = String(text);
  };
  return res;
}

/** Drive a handler with the fake req/res, emitting the body then end. */
async function driveRequest(handler, req, res) {
  const done = handler(req, res);
  if (req.body != null) {
    req.emit("data", req.body);
  }
  req.emit("end");
  await done;
}

/** POST a JSON body through `handle` with the given deps and return the response. */
async function post(deps, { body, headers = {} } = {}) {
  const req = makeRequest({ headers: { "content-type": "application/json", ...headers }, body });
  const res = makeResponse();
  await driveRequest((req_, res_) => handle(req_, res_, deps), req, res);
  return { res, req };
}

function jsonBody(action, payload) {
  return JSON.stringify({ action, payload });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test("dispatch: status returns masked config (no apiKey), stats, and runtime", async () => {
  const { deps } = makeDeps();
  const result = await dispatch({ action: "status" }, deps);

  assert.equal(result.ok, true);
  const { config, stats, runtime } = result.value;

  // Config is built from masked() only; the secret lives in get() and must
  // not appear anywhere in the response.
  assert.deepEqual(config, {
    embedding: { model: "text-embedding-3" },
    rerank: { model: "rerank-model" },
    home: MISSING_HOME,
  });
  assert.equal("apiKey" in config, false);
  assert.equal(config.embedding.apiKey, undefined);

  assert.deepEqual(stats, {
    pairCount: 3,
    indexedCount: 2,
    pendingCount: 1,
    errorCount: 0,
    model: "text-embedding-3",
    dim: 384,
    pairFiles: 0, // MISSING_HOME does not exist.
    indexBytes: 0,
  });

  assert.deepEqual(runtime, {
    indexerRunning: true,
    initError: null,
    lastError: null,
    lastRetrieval: null,
  });
});

test("dispatch: status still works with null deps and zero stats", async () => {
  const result = await dispatch({ action: "status" }, null);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.config, { home: null });
  assert.deepEqual(result.value.stats, {
    pairCount: 0,
    indexedCount: 0,
    pendingCount: 0,
    errorCount: 0,
    model: null,
    dim: null,
    pairFiles: 0,
    indexBytes: 0,
  });
  assert.equal(result.value.runtime.indexerRunning, false);
  assert.equal(result.value.runtime.lastError, null);
});

test("status: pairFiles are counted recursively from <home>/pairs/<workspace>/<session>.jsonl", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-rag-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "pairs", "workspace"), { recursive: true });
  mkdirSync(join(dir, "pairs", "empty-workspace"), { recursive: true }); // Empty subdir must not count.
  writeFileSync(join(dir, "pairs", "workspace", "session.jsonl"), "x"); // The one nested pair file.
  writeFileSync(join(dir, "pairs", "workspace", "notes.txt"), "x"); // Non-jsonl file must not count.
  writeFileSync(join(dir, "index.sqlite"), Buffer.alloc(100));
  writeFileSync(join(dir, "index.sqlite-wal"), Buffer.alloc(40));
  writeFileSync(join(dir, "index.sqlite-shm"), Buffer.alloc(9)); // Must not count.

  const { deps } = makeDeps({ configStore: { home: dir, masked: () => ({}) } });
  const result = await dispatch({ action: "status" }, deps);

  assert.equal(result.value.stats.pairFiles, 1);
  assert.equal(result.value.stats.indexBytes, 140);
});

test("status: runtime.lastError prefers indexer, then retriever, then injector, then initError", async () => {
  const { deps } = makeDeps();
  const withErrors = {
    ...deps,
    indexer: { status: () => ({ running: true, lastError: "ix-error", reconcileError: null }) },
    retriever: { status: () => ({ lastRetrieval: null, lastError: "rt-error" }) },
    injector: { status: () => ({ lastError: "in-error" }) },
    initError: "init-error",
  };

  const r1 = await dispatch({ action: "status" }, withErrors);
  assert.equal(r1.value.runtime.lastError, "ix-error");

  const r2 = await dispatch({ action: "status" }, { ...withErrors, indexer: null });
  assert.equal(r2.value.runtime.lastError, "rt-error");
  assert.equal(r2.value.runtime.indexerRunning, false);

  const r3 = await dispatch({ action: "status" }, { ...withErrors, indexer: null, retriever: null });
  assert.equal(r3.value.runtime.lastError, "in-error");

  const r4 = await dispatch({ action: "status" }, { ...withErrors, indexer: null, retriever: null, injector: null });
  assert.equal(r4.value.runtime.lastError, "init-error");
  assert.equal(r4.value.runtime.initError, "init-error");
});

// ---------------------------------------------------------------------------
// config actions
// ---------------------------------------------------------------------------

test("config.save: saves the patch, kicks reconcile fire-and-forget, returns status", async () => {
  const { deps, calls } = makeDeps();
  const patch = { embedding: { model: "other-model", apiKey: "new-secret" } };

  const result = await dispatch({ action: "config.save", payload: { config: patch } }, deps);

  assert.deepEqual(calls.save, [patch]);
  assert.equal(calls.reconcile, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value).sort(), ["config", "runtime", "stats"]);
});

test("config.save: rejects a missing or non-object patch", async () => {
  const { deps } = makeDeps();

  const missing = await dispatch({ action: "config.save", payload: {} }, deps);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "INVALID_PAYLOAD");
  assert.equal(missing.error.status, 400);

  const array = await dispatch({ action: "config.save", payload: { config: [1, 2] } }, deps);
  assert.equal(array.error.code, "INVALID_PAYLOAD");
});

test("config.get: returns masked config with home added", async () => {
  const { deps } = makeDeps();
  const result = await dispatch({ action: "config.get" }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.value.embedding.apiKey, undefined);
  assert.equal(result.value.home, MISSING_HOME);
});

// ---------------------------------------------------------------------------
// connection / index delegation
// ---------------------------------------------------------------------------

test("connection.testEmbedding and connection.testRerank delegate", async () => {
  const { deps, calls } = makeDeps();

  const emb = await dispatch({ action: "connection.testEmbedding" }, deps);
  assert.equal(calls.embeddingTests, 1);
  assert.deepEqual(emb.value, { ok: true, model: "text-embedding-3", dimension: 384, latencyMs: 12 });

  const rerank = await dispatch({ action: "connection.testRerank" }, deps);
  assert.equal(calls.rerankTests, 1);
  assert.deepEqual(rerank.value, { ok: true, model: "rerank-model", topScore: 0.9, latencyMs: 7 });
});

test("index.rebuild and index.clear delegate and return status", async () => {
  const { deps, calls } = makeDeps();

  const rebuilt = await dispatch({ action: "index.rebuild" }, deps);
  assert.equal(calls.reindex, 1);
  assert.equal(rebuilt.ok, true);
  assert.ok(rebuilt.value.stats);

  const cleared = await dispatch({ action: "index.clear" }, deps);
  assert.equal(calls.clear, 1);
  assert.equal(cleared.ok, true);
  assert.ok(cleared.value.runtime);
});

// ---------------------------------------------------------------------------
// NOT_READY
// ---------------------------------------------------------------------------

test("NOT_READY (503) when a required dep is unavailable", async () => {
  const { deps } = makeDeps();

  const noIndexer = await dispatch({ action: "index.rebuild" }, { ...deps, indexer: null });
  assert.equal(noIndexer.ok, false);
  assert.equal(noIndexer.error.code, "NOT_READY");
  assert.equal(noIndexer.error.status, 503);

  const noClear = await dispatch({ action: "index.clear" }, { ...deps, indexer: null });
  assert.equal(noClear.error.code, "NOT_READY");

  const noStore = await dispatch({ action: "config.save", payload: { config: {} } }, { ...deps, configStore: null });
  assert.equal(noStore.error.code, "NOT_READY");

  const noEmb = await dispatch({ action: "connection.testEmbedding" }, { ...deps, embeddings: null });
  assert.equal(noEmb.error.code, "NOT_READY");

  const noRerank = await dispatch({ action: "connection.testRerank" }, { ...deps, reranker: null });
  assert.equal(noRerank.error.code, "NOT_READY");
});

test("status: a null db yields zero stats instead of NOT_READY", async () => {
  const { deps } = makeDeps();
  const result = await dispatch({ action: "status" }, { ...deps, db: null });

  assert.equal(result.ok, true);
  assert.equal(result.value.stats.pairCount, 0);
  assert.equal(result.value.stats.model, null);
  assert.equal(result.value.stats.dim, null);
});

// ---------------------------------------------------------------------------
// action-level errors
// ---------------------------------------------------------------------------

test("unknown action maps to UNKNOWN_ACTION 400", async () => {
  const { deps } = makeDeps();
  const result = await dispatch({ action: "frobnicate" }, deps);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_ACTION");
  assert.equal(result.error.status, 400);
  assert.match(result.error.message, /frobnicate/);
});

test("error mapping: preserves error.code and 4xx/5xx status", async () => {
  const { deps } = makeDeps();
  const boom = new Error("index exploded");
  boom.code = "INDEX_FAILED";
  boom.status = 500;
  boom.details = { stage: "reindex" };
  deps.indexer.reindex = async () => {
    throw boom;
  };

  const result = await dispatch({ action: "index.rebuild" }, deps);

  assert.equal(result.ok, false);
  assert.deepEqual(result.error, {
    code: "INDEX_FAILED",
    message: "index exploded",
    status: 500,
    details: { stage: "reindex" },
  });
});

test("error mapping: a 4xx status (429) is preserved", async () => {
  const { deps } = makeDeps();
  const throttled = new Error("rate limited");
  throttled.code = "RATE_LIMITED";
  throttled.status = 429;
  deps.indexer.reindex = async () => {
    throw throttled;
  };

  const result = await dispatch({ action: "index.rebuild" }, deps);
  assert.equal(result.error.status, 429);
  assert.equal(result.error.code, "RATE_LIMITED");
});

test("error mapping: plain errors become INTERNAL_ERROR 500", async () => {
  const { deps } = makeDeps();
  deps.indexer.reindex = async () => {
    throw new Error("boom");
  };

  const result = await dispatch({ action: "index.rebuild" }, deps);
  assert.equal(result.error.code, "INTERNAL_ERROR");
  assert.equal(result.error.status, 500);
  assert.equal(result.error.message, "boom");
});

test("error mapping: messages are truncated to 500 characters", async () => {
  const { deps } = makeDeps();
  deps.indexer.reindex = async () => {
    throw new Error("x".repeat(600));
  };

  const result = await dispatch({ action: "index.rebuild" }, deps);
  assert.equal(result.error.message.length, 500);
});

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

test("HTTP: status round trip returns JSON with masked config", async () => {
  const { deps } = makeDeps();
  const { res } = await post(deps, { body: jsonBody("status") });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/json");
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.value.config.home, MISSING_HOME);
  assert.equal(body.value.config.embedding.apiKey, undefined);
  assert.equal(body.value.stats.pairCount, 3);
});

test("HTTP: wrong method is rejected with 405", async () => {
  const { deps } = makeDeps();
  const req = makeRequest({ method: "GET", body: jsonBody("status") });
  const res = makeResponse();
  await driveRequest(handle, req, res);

  assert.equal(res.statusCode, 405);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
});

test("HTTP: non-JSON content type is rejected with 415", async () => {
  const { deps } = makeDeps();
  const req = makeRequest({ headers: { "content-type": "text/plain" }, body: jsonBody("status") });
  const res = makeResponse();
  await driveRequest(handle, req, res);

  assert.equal(res.statusCode, 415);
  assert.equal(JSON.parse(res.body).error.code, "UNSUPPORTED_MEDIA_TYPE");
});

test("HTTP: a charset-qualified application/json content type is accepted", async () => {
  const { deps } = makeDeps();
  const req = makeRequest({
    headers: { "content-type": "application/json; charset=utf-8" },
    body: jsonBody("status"),
  });
  const res = makeResponse();
  await driveRequest(handle, req, res);

  assert.equal(res.statusCode, 200);
});

test("HTTP: sec-fetch-site cross-site is rejected with 403", async () => {
  const { deps } = makeDeps();
  const req = makeRequest({
    headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
    body: jsonBody("status"),
  });
  const res = makeResponse();
  await driveRequest(handle, req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error.code, "FORBIDDEN");
});

test("HTTP: an Origin whose host differs from Host is rejected with 403", async () => {
  const { deps } = makeDeps();
  const req = makeRequest({
    headers: {
      "content-type": "application/json",
      origin: "https://evil.example",
      host: "127.0.0.1:3080",
    },
    body: jsonBody("status"),
  });
  const res = makeResponse();
  await driveRequest(handle, req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error.code, "FORBIDDEN");
});

test("HTTP: a matching Origin is accepted", async () => {
  const { deps } = makeDeps();
  const req = makeRequest({
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3080",
      host: "127.0.0.1:3080",
    },
    body: jsonBody("status"),
  });
  const res = makeResponse();
  await driveRequest(handle, req, res);

  assert.equal(res.statusCode, 200);
});

test("HTTP: an oversized body is rejected with 413 and the stream is drained", async () => {
  const { deps } = makeDeps();
  const big = `{"action":"status","pad":"${"x".repeat(MAX_BODY_BYTES)}"}`;
  const req = makeRequest({ headers: { "content-type": "application/json" }, body: big });
  const res = makeResponse();
  await driveRequest((req_, res_) => handle(req_, res_, deps), req, res);

  assert.equal(res.statusCode, 413);
  assert.equal(JSON.parse(res.body).error.code, "BODY_TOO_LARGE");
  assert.equal(req.resumeCalls, 1);
});

test("HTTP: malformed JSON is rejected with 400", async () => {
  const { deps } = makeDeps();
  const { res } = await post(deps, { body: "{not-json" });

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, "MALFORMED_JSON");
});

test("HTTP: unknown action is rejected with 400", async () => {
  const { deps } = makeDeps();
  const { res } = await post(deps, { body: jsonBody("nope") });

  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, "UNKNOWN_ACTION");
  assert.equal(body.error.status, 400);
});

test("HTTP: NOT_READY surfaces as a 503 JSON body", async () => {
  const { deps } = makeDeps();
  const { res } = await post({ ...deps, indexer: null }, { body: jsonBody("index.rebuild") });

  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "NOT_READY");
  assert.equal(body.error.status, 503);
});

// ---------------------------------------------------------------------------
// registerApi
// ---------------------------------------------------------------------------

test("registerApi: registers an exact route whose handler answers requests", async () => {
  const registered = [];
  const effects = [];
  const ctx = {
    effect: (execute, label) => {
      effects.push({ execute, label });
      execute(); // Cordis invokes the effect body at setup.
    },
    webServer: {
      register: (route) => {
        registered.push(route);
        return () => {};
      },
    },
  };
  const { deps } = makeDeps();

  registerApi(ctx, deps);

  assert.equal(effects.length, 1);
  assert.equal(effects[0].label, "context-rag: config API");
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, "exact");
  assert.equal(registered[0].path, API_PATH);

  const req = makeRequest({ headers: { "content-type": "application/json" }, body: jsonBody("status") });
  const res = makeResponse();
  await driveRequest(registered[0].handler, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});
