/**
 * Tests for the shared HTTP client in `lib/http.js`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { HttpError, joinUrl, requestJson } from "../lib/http.js";
import { startHttpServer, startJsonServer } from "./helpers/http-server.js";

test("requestJson: successful JSON request", async (t) => {
  const server = await startJsonServer({
    "/echo": {
      status: 200,
      headers: { "x-test": "yes" },
      body: { ok: true, n: 42 },
    },
  });
  t.after(() => server.close());

  const resp = await requestJson(`${server.url}/echo`, { body: { a: 1 } });

  assert.deepEqual(resp.data, { ok: true, n: 42 });
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("x-test"), "yes");
  assert.equal(server.requests.length, 1);
  const req = server.requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.headers["content-type"], "application/json");
  assert.deepEqual(req.bodyJson, { a: 1 });
});

test("requestJson: string body and caller content-type are preserved", async (t) => {
  const server = await startJsonServer({
    "/raw": { status: 200, body: { ok: true } },
  });
  t.after(() => server.close());

  const resp = await requestJson(`${server.url}/raw`, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson", "x-extra": "1" },
    body: '{"raw":1}',
  });

  assert.deepEqual(resp.data, { ok: true });
  const req = server.requests[0];
  assert.equal(req.method, "PUT");
  assert.equal(req.headers["content-type"], "application/x-ndjson");
  assert.equal(req.headers["x-extra"], "1");
  assert.equal(req.body, '{"raw":1}');
});

test("requestJson: non-2xx throws HTTP_ERROR and does not retry", async (t) => {
  const server = await startJsonServer({
    "/fail": { status: 400, body: { error: "bad request" } },
  });
  t.after(() => server.close());

  await assert.rejects(
    requestJson(`${server.url}/fail`, { body: {}, maxRetries: 2 }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, "HTTP_ERROR");
      assert.equal(err.status, 400);
      assert.equal(err.retryable, false);
      assert.match(err.message, /400/);
      assert.ok(err.details?.body.includes("bad request"));
      return true;
    },
  );
  assert.equal(server.requests.length, 1);
});

test("requestJson: 429 with Retry-After seconds is retried then succeeds", async (t) => {
  const server = await startJsonServer({
    "/rate": [
      { status: 429, headers: { "retry-after": "0" }, body: { error: "rate limited" } },
      { status: 200, body: { ok: true } },
    ],
  });
  t.after(() => server.close());

  const resp = await requestJson(`${server.url}/rate`, { body: { a: 1 }, maxRetries: 2 });

  assert.deepEqual(resp.data, { ok: true });
  assert.equal(server.requests.length, 2);
  assert.deepEqual(server.requests[0].bodyJson, { a: 1 });
});

test("requestJson: Retry-After as HTTP-date is honored", async (t) => {
  const retryAfter = new Date(Date.now() + 400).toUTCString();
  const server = await startJsonServer({
    "/date": [
      { status: 503, headers: { "retry-after": retryAfter }, body: {} },
      { status: 200, body: { ok: true } },
    ],
  });
  t.after(() => server.close());

  const resp = await requestJson(`${server.url}/date`, { body: {}, maxRetries: 2 });

  assert.deepEqual(resp.data, { ok: true });
  assert.equal(server.requests.length, 2);
});

test("requestJson: 500 is retried then succeeds", async (t) => {
  const server = await startJsonServer({
    "/flaky": [
      { status: 500, body: { error: "boom" } },
      { status: 200, body: { ok: true } },
    ],
  });
  t.after(() => server.close());

  const resp = await requestJson(`${server.url}/flaky`, {
    body: {},
    maxRetries: 2,
    retryDelayMs: 5,
  });

  assert.deepEqual(resp.data, { ok: true });
  assert.equal(server.requests.length, 2);
});

test("requestJson: retries exhausted throws last error with full attempt count", async (t) => {
  const server = await startJsonServer({
    "/always503": { status: 503, body: {} },
  });
  t.after(() => server.close());

  await assert.rejects(
    requestJson(`${server.url}/always503`, { body: {}, maxRetries: 1, retryDelayMs: 5 }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, "HTTP_ERROR");
      assert.equal(err.status, 503);
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(server.requests.length, 2);
});

test("requestJson: logger.warn receives retry notices", async (t) => {
  const server = await startJsonServer({
    "/log": [
      { status: 500, body: {} },
      { status: 200, body: { ok: true } },
    ],
  });
  t.after(() => server.close());

  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };

  const resp = await requestJson(`${server.url}/log`, {
    body: {},
    maxRetries: 2,
    retryDelayMs: 5,
    logger,
  });

  assert.deepEqual(resp.data, { ok: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /500/);
  assert.match(warnings[0], /retrying/);
});

test("requestJson: timeout aborts with REQUEST_TIMEOUT", async (t) => {
  const server = await startHttpServer(() => {
    // Never respond: simulate a stalled upstream.
  });
  t.after(() => server.close());

  await assert.rejects(
    requestJson(`${server.url}/hang`, { body: {}, timeoutMs: 80, maxRetries: 0 }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, "REQUEST_TIMEOUT");
      assert.equal(err.retryable, true);
      assert.equal(err.status, null);
      return true;
    },
  );
  assert.equal(server.requests.length, 1);
});

test("requestJson: caller abort is not retried", async (t) => {
  const server = await startJsonServer({
    "/abort": { status: 200, body: { ok: true } },
  });
  t.after(() => server.close());

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    requestJson(`${server.url}/abort`, { body: {}, signal: controller.signal, maxRetries: 3 }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, "ABORTED");
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(server.requests.length, 0);
});

test("requestJson: invalid JSON on 2xx -> INVALID_RESPONSE, not retryable", async (t) => {
  const server = await startJsonServer({
    "/badjson": { status: 200, body: "not-json{" },
  });
  t.after(() => server.close());

  await assert.rejects(
    requestJson(`${server.url}/badjson`, { body: {}, maxRetries: 2 }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, "INVALID_RESPONSE");
      assert.equal(err.retryable, false);
      assert.equal(err.status, 200);
      return true;
    },
  );
  assert.equal(server.requests.length, 1);
});

test("requestJson: connection refused maps to NETWORK_ERROR", async (t) => {
  const server = await startJsonServer({
    "/x": { status: 200, body: { ok: true } },
  });
  const url = server.url;
  await server.close();

  await assert.rejects(
    requestJson(`${url}/x`, { body: {}, maxRetries: 0 }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, "NETWORK_ERROR");
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test("joinUrl: trims slashes and joins with exactly one separator", () => {
  assert.equal(joinUrl("https://api.openai.com/v1", "embeddings"), "https://api.openai.com/v1/embeddings");
  assert.equal(joinUrl("https://api.openai.com/v1/", "/embeddings"), "https://api.openai.com/v1/embeddings");
  assert.equal(joinUrl("https://api.openai.com/v1///", "///embeddings"), "https://api.openai.com/v1/embeddings");
  assert.equal(joinUrl("http://127.0.0.1:9", "v1"), "http://127.0.0.1:9/v1");
});

test("joinUrl: absolute http(s) path is returned unchanged", () => {
  assert.equal(
    joinUrl("https://a.example", "https://other.example/x/embeddings"),
    "https://other.example/x/embeddings",
  );
});

test("joinUrl: empty base yields a root-relative path", () => {
  assert.equal(joinUrl("", "/rerank"), "/rerank");
  assert.equal(joinUrl("", "rerank"), "/rerank");
});
