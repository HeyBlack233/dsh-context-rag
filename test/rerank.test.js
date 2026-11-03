/**
 * Tests for the rerank client in `lib/rerank.js`. All servers run in-process
 * on 127.0.0.1; no real network is used.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRerankClient, RerankError } from "../lib/rerank.js";
import { startJsonServer } from "./helpers/http-server.js";

/**
 * Build a full config object with the documented shape.
 *
 * @param {string} url - Base URL of the in-process test server.
 * @param {object} [overrides] - Overrides for the `rerank` section.
 * @returns {object}
 */
function makeConfig(url, overrides = {}) {
  return {
    embedding: {
      baseUrl: url,
      apiKey: "sk-embed",
      model: "embed-model",
      dimensions: null,
      timeoutMs: 1000,
      maxRetries: 1,
      batchSize: 16,
      maxEmbeddingChars: 8000,
    },
    rerank: {
      enabled: true,
      baseUrl: "",
      path: "/rerank",
      apiKey: "",
      model: "rerank-model",
      timeoutMs: 1000,
      maxRetries: 1,
      ...overrides,
    },
  };
}

test("rerank: parses relevance_score and sorts descending", async (t) => {
  const server = await startJsonServer({
    "/rerank": {
      status: 200,
      body: {
        model: "rerank-model",
        results: [
          { index: 1, relevance_score: 0.4 },
          { index: 0, relevance_score: 0.9 },
          { index: 2, relevance_score: 0.7 },
        ],
      },
    },
  });
  t.after(() => server.close());

  const client = createRerankClient({ getConfig: () => makeConfig(server.url) });
  const { results, model } = await client.rerank({
    query: "q",
    documents: ["d0", "d1", "d2"],
  });

  assert.equal(model, "rerank-model");
  assert.deepEqual(results, [
    { index: 0, document: "d0", score: 0.9 },
    { index: 2, document: "d2", score: 0.7 },
    { index: 1, document: "d1", score: 0.4 },
  ]);

  const body = server.requests[0].bodyJson;
  assert.equal(body.model, "rerank-model");
  assert.equal(body.query, "q");
  assert.deepEqual(body.documents, ["d0", "d1", "d2"]);
  assert.equal(body.top_n, 3);
  assert.equal(server.requests[0].headers.authorization, "Bearer sk-embed");
});

test("rerank: clamps results to topN", async (t) => {
  const server = await startJsonServer({
    "/rerank": {
      status: 200,
      body: {
        results: [
          { index: 0, relevance_score: 0.3 },
          { index: 1, relevance_score: 0.9 },
          { index: 2, relevance_score: 0.6 },
        ],
      },
    },
  });
  t.after(() => server.close());

  const client = createRerankClient({ getConfig: () => makeConfig(server.url) });
  const { results } = await client.rerank({
    query: "q",
    documents: ["a", "b", "c"],
    topN: 1,
  });

  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { index: 1, document: "b", score: 0.9 });
  assert.equal(server.requests[0].bodyJson.top_n, 1);
});

test("rerank: falls back to score when relevance_score is absent", async (t) => {
  const server = await startJsonServer({
    "/rerank": {
      status: 200,
      body: {
        results: [
          { index: 1, score: 5 },
          { index: 0, score: 9 },
        ],
      },
    },
  });
  t.after(() => server.close());

  const client = createRerankClient({ getConfig: () => makeConfig(server.url) });
  const { results } = await client.rerank({ query: "q", documents: ["a", "b"] });

  assert.equal(results.length, 2);
  assert.equal(results[0].index, 0);
  assert.equal(results[0].score, 9);
  assert.equal(results[1].index, 1);
});

test("rerank: malformed entries are skipped while valid ones remain", async (t) => {
  const server = await startJsonServer({
    "/rerank": {
      status: 200,
      body: {
        results: [
          { index: 0, relevance_score: 0.8 },
          { index: 99, relevance_score: 0.9 }, // out of bounds
          { index: "1", relevance_score: 0.7 }, // non-integer index
          { index: 1, relevance_score: "high" }, // non-finite score
          { index: 1.5, relevance_score: 0.5 }, // float index
          null,
        ],
      },
    },
  });
  t.after(() => server.close());

  const client = createRerankClient({ getConfig: () => makeConfig(server.url) });
  const { results } = await client.rerank({ query: "q", documents: ["a", "b"] });

  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { index: 0, document: "a", score: 0.8 });
});

test("rerank: no valid results -> INVALID_RERANK_RESPONSE", async (t) => {
  const server = await startJsonServer({
    "/rerank": {
      status: 200,
      body: { results: [{ index: 5, relevance_score: 0.9 }] },
    },
  });
  t.after(() => server.close());

  const client = createRerankClient({ getConfig: () => makeConfig(server.url) });

  await assert.rejects(
    client.rerank({ query: "q", documents: ["a"] }),
    (err) => {
      assert.ok(err instanceof RerankError);
      assert.equal(err.code, "INVALID_RERANK_RESPONSE");
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("rerank: empty results array -> INVALID_RERANK_RESPONSE", async (t) => {
  const server = await startJsonServer({
    "/rerank": { status: 200, body: { results: [] } },
  });
  t.after(() => server.close());

  const client = createRerankClient({ getConfig: () => makeConfig(server.url) });

  await assert.rejects(
    client.rerank({ query: "q", documents: ["a"] }),
    (err) => err.code === "INVALID_RERANK_RESPONSE",
  );
});

test("rerank: empty documents returns empty results without network", async (t) => {
  const server = await startJsonServer({
    "/rerank": { status: 200, body: { results: [] } },
  });
  t.after(() => server.close());

  const client = createRerankClient({ getConfig: () => makeConfig(server.url) });
  const { results, model } = await client.rerank({ query: "q", documents: [] });

  assert.deepEqual(results, []);
  assert.equal(model, "rerank-model");
  assert.equal(server.requests.length, 0);
});

test("rerank: inherits baseUrl and apiKey from the embedding section", async (t) => {
  const server = await startJsonServer({
    "/rerank": { status: 200, body: { results: [{ index: 0, relevance_score: 1 }] } },
  });
  t.after(() => server.close());

  const config = {
    embedding: {
      baseUrl: server.url,
      apiKey: "sk-embed",
      model: "embed-model",
      dimensions: null,
      timeoutMs: 1000,
      maxRetries: 1,
      batchSize: 16,
      maxEmbeddingChars: 8000,
    },
    rerank: {
      enabled: true,
      baseUrl: "",
      path: "/rerank",
      apiKey: "",
      model: "rr-model",
      timeoutMs: 1000,
      maxRetries: 1,
    },
  };
  const client = createRerankClient({ getConfig: () => config });
  const { results } = await client.rerank({ query: "q", documents: ["a"] });

  assert.equal(results.length, 1);
  assert.equal(server.requests[0].url, "/rerank");
  assert.equal(server.requests[0].headers.authorization, "Bearer sk-embed");
});

test("rerank: custom path is honored", async (t) => {
  const server = await startJsonServer({
    "/custom-rank": { status: 200, body: { results: [{ index: 0, relevance_score: 1 }] } },
  });
  t.after(() => server.close());

  const client = createRerankClient({
    getConfig: () => makeConfig(server.url, { path: "/custom-rank" }),
  });
  await client.rerank({ query: "q", documents: ["a"] });

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, "/custom-rank");
});

test("rerank: disabled or missing config -> RERANK_NOT_CONFIGURED, no network", async (t) => {
  const server = await startJsonServer({
    "/rerank": { status: 200, body: { results: [] } },
  });
  t.after(() => server.close());

  const disabled = createRerankClient({
    getConfig: () => makeConfig(server.url, { enabled: false }),
  });
  await assert.rejects(
    disabled.rerank({ query: "q", documents: ["a"] }),
    (err) => {
      assert.ok(err instanceof RerankError);
      assert.equal(err.code, "RERANK_NOT_CONFIGURED");
      assert.equal(err.retryable, false);
      return true;
    },
  );

  const noModel = createRerankClient({
    getConfig: () => makeConfig(server.url, { model: "" }),
  });
  await assert.rejects(
    noModel.rerank({ query: "q", documents: ["a"] }),
    (err) => err.code === "RERANK_NOT_CONFIGURED",
  );

  const noBase = createRerankClient({
    getConfig: () => ({ embedding: {}, rerank: { enabled: true, model: "m" } }),
  });
  await assert.rejects(
    noBase.rerank({ query: "q", documents: ["a"] }),
    (err) => err.code === "RERANK_NOT_CONFIGURED",
  );

  assert.equal(server.requests.length, 0);
});

test("rerank: invalid input arguments are rejected", async (t) => {
  const server = await startJsonServer({
    "/rerank": { status: 200, body: { results: [] } },
  });
  t.after(() => server.close());

  const client = createRerankClient({ getConfig: () => makeConfig(server.url) });

  await assert.rejects(client.rerank({ query: "", documents: ["a"] }), (err) => err.code === "INVALID_INPUT");
  await assert.rejects(client.rerank({ query: "q", documents: "not-an-array" }), (err) => err.code === "INVALID_INPUT");
  await assert.rejects(client.rerank({ query: "q", documents: [42] }), (err) => err.code === "INVALID_INPUT");
  assert.equal(server.requests.length, 0);
});

test("rerank: transport errors map to RERANK_REQUEST_FAILED", async (t) => {
  const server = await startJsonServer({
    "/rerank": { status: 500, body: { error: "boom" } },
  });
  t.after(() => server.close());

  const client = createRerankClient({
    getConfig: () => makeConfig(server.url, { maxRetries: 0 }),
  });

  await assert.rejects(
    client.rerank({ query: "q", documents: ["a"] }),
    (err) => {
      assert.ok(err instanceof RerankError);
      assert.equal(err.code, "RERANK_REQUEST_FAILED");
      assert.equal(err.status, 500);
      assert.equal(err.retryable, true);
      assert.ok(err.details?.body.includes("boom"));
      return true;
    },
  );
});

test("rerank: transient failures are retried at the client level", async (t) => {
  const server = await startJsonServer({
    "/rerank": [
      { status: 429, headers: { "retry-after": "0" }, body: { error: "rate limited" } },
      { status: 200, body: { results: [{ index: 0, relevance_score: 1 }] } },
    ],
  });
  t.after(() => server.close());

  const client = createRerankClient({
    getConfig: () => makeConfig(server.url, { maxRetries: 2 }),
  });
  const { results } = await client.rerank({ query: "q", documents: ["a"] });

  assert.equal(results.length, 1);
  assert.equal(server.requests.length, 2);
});

test("testConnection: reports ok with topScore and latency", async (t) => {
  const server = await startJsonServer({
    "/rerank": {
      status: 200,
      body: {
        model: "rerank-model",
        results: [
          { index: 0, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.5 },
        ],
      },
    },
  });
  t.after(() => server.close());

  const client = createRerankClient({ getConfig: () => makeConfig(server.url) });
  const info = await client.testConnection();

  assert.equal(info.ok, true);
  assert.equal(info.model, "rerank-model");
  assert.equal(info.topScore, 0.9);
  assert.equal(typeof info.latencyMs, "number");
  assert.equal(server.requests[0].bodyJson.top_n, 2);
  assert.deepEqual(server.requests[0].bodyJson.documents, ["first candidate", "second candidate"]);
});

test("testConnection: propagates failure as RerankError", async (t) => {
  const server = await startJsonServer({
    "/rerank": { status: 503, body: { error: "unavailable" } },
  });
  t.after(() => server.close());

  const client = createRerankClient({
    getConfig: () => makeConfig(server.url, { maxRetries: 0 }),
  });

  await assert.rejects(
    client.testConnection(),
    (err) => {
      assert.ok(err instanceof RerankError);
      assert.equal(err.code, "RERANK_REQUEST_FAILED");
      assert.equal(err.status, 503);
      return true;
    },
  );
});
