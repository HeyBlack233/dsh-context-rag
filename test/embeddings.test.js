/**
 * Tests for the embeddings client in `lib/embeddings.js`. All servers run
 * in-process on 127.0.0.1; no real network is used.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingClient, EmbeddingError } from "../lib/embeddings.js";
import { startJsonServer } from "./helpers/http-server.js";

/**
 * Build a full config object with the documented shape.
 *
 * @param {string} url - Base URL of the in-process test server.
 * @param {object} [overrides] - Overrides for the `embedding` section.
 * @returns {object}
 */
function makeConfig(url, overrides = {}) {
  return {
    embedding: {
      baseUrl: url,
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: null,
      timeoutMs: 1000,
      maxRetries: 1,
      batchSize: 16,
      maxEmbeddingChars: 8000,
      ...overrides,
    },
    rerank: {
      enabled: false,
      baseUrl: "",
      path: "/rerank",
      apiKey: "",
      model: "",
      timeoutMs: 5000,
      maxRetries: 1,
    },
  };
}

test("embed: batches by batchSize, preserves order, and normalizes", async (t) => {
  const server = await startJsonServer({
    "/embeddings": (record) => {
      const input = record.bodyJson.input;
      return {
        status: 200,
        body: {
          model: "text-embedding-3-small",
          data: input.map((_, i) => ({ embedding: [1, i + 1] })),
        },
      };
    },
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({
    getConfig: () => makeConfig(server.url, { batchSize: 2 }),
  });
  const { vectors, model, dimension } = await client.embed(["a", "bb", "ccc"]);

  // 3 inputs with batchSize 2 -> 2 requests, input order preserved.
  assert.equal(server.requests.length, 2);
  assert.deepEqual(server.requests[0].bodyJson.input, ["a", "bb"]);
  assert.deepEqual(server.requests[1].bodyJson.input, ["ccc"]);
  // Request shape per the contract.
  assert.equal(server.requests[0].bodyJson.model, "text-embedding-3-small");
  assert.equal(server.requests[0].bodyJson.encoding_format, "float");
  assert.equal(server.requests[0].bodyJson.dimensions, undefined);

  assert.equal(model, "text-embedding-3-small");
  assert.equal(dimension, 2);
  assert.equal(vectors.length, 3);

  const sqrt2 = Math.SQRT2;
  const sqrt5 = Math.sqrt(5);
  // Normalized [1,1], [1,2], [1,1] in original input order.
  assert.deepEqual(vectors[0], [1 / sqrt2, 1 / sqrt2]);
  assert.ok(Math.abs(vectors[1][0] - 1 / sqrt5) < 1e-9);
  assert.ok(Math.abs(vectors[1][1] - 2 / sqrt5) < 1e-9);
  assert.deepEqual(vectors[2], [1 / sqrt2, 1 / sqrt2]);
});

test("embed: L2-normalizes arbitrary vectors (unit length)", async (t) => {
  const server = await startJsonServer({
    "/embeddings": {
      status: 200,
      body: {
        data: [
          { embedding: [3, 4] },
          { embedding: [0, 5] },
          { embedding: [-2, 1] },
        ],
      },
    },
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({ getConfig: () => makeConfig(server.url) });
  const { vectors } = await client.embed(["x", "y", "z"]);

  assert.deepEqual(vectors[0], [0.6, 0.8]);
  assert.deepEqual(vectors[1], [0, 1]);
  assert.deepEqual(vectors[2], [-2 / Math.sqrt(5), 1 / Math.sqrt(5)]);
  for (const v of vectors) {
    const dot = v.reduce((sum, x) => sum + x * x, 0);
    assert.ok(Math.abs(dot - 1) < 1e-9, `expected unit norm, got ${dot}`);
  }
});

test("embed: configured dimension mismatch is rejected", async (t) => {
  const server = await startJsonServer({
    "/embeddings": { status: 200, body: { data: [{ embedding: [1, 2] }] } },
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({
    getConfig: () => makeConfig(server.url, { dimensions: 3 }),
  });

  await assert.rejects(
    client.embed(["x"]),
    (err) => {
      assert.ok(err instanceof EmbeddingError);
      assert.equal(err.code, "INVALID_EMBEDDING");
      assert.match(err.message, /dimension/);
      return true;
    },
  );
});

test("embed: all-zero vector is rejected", async (t) => {
  const server = await startJsonServer({
    "/embeddings": { status: 200, body: { data: [{ embedding: [0, 0, 0] }] } },
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({ getConfig: () => makeConfig(server.url) });

  await assert.rejects(
    client.embed(["x"]),
    (err) => {
      assert.ok(err instanceof EmbeddingError);
      assert.equal(err.code, "INVALID_EMBEDDING");
      return true;
    },
  );
});

test("embed: response count mismatch is rejected", async (t) => {
  const server = await startJsonServer({
    "/embeddings": { status: 200, body: { data: [{ embedding: [1, 0] }] } },
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({ getConfig: () => makeConfig(server.url) });

  await assert.rejects(
    client.embed(["x", "y"]),
    (err) => err.code === "INVALID_EMBEDDING",
  );
});

test("embed: missing config throws EMBEDDING_NOT_CONFIGURED without network", async (t) => {
  const server = await startJsonServer({
    "/embeddings": { status: 200, body: { data: [{ embedding: [1, 0] }] } },
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({ getConfig: () => ({}) });

  await assert.rejects(
    client.embed(["x"]),
    (err) => {
      assert.ok(err instanceof EmbeddingError);
      assert.equal(err.code, "EMBEDDING_NOT_CONFIGURED");
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(server.requests.length, 0);
});

test("embed: Authorization header sent only when apiKey is set", async (t) => {
  const server = await startJsonServer({
    "/embeddings": { status: 200, body: { data: [{ embedding: [1, 0] }] } },
  });
  t.after(() => server.close());

  const withKey = createEmbeddingClient({ getConfig: () => makeConfig(server.url) });
  await withKey.embed(["x"]);
  assert.equal(server.requests[0].headers.authorization, "Bearer sk-test");

  const withoutKey = createEmbeddingClient({
    getConfig: () => makeConfig(server.url, { apiKey: "" }),
  });
  await withoutKey.embed(["x"]);
  assert.equal(server.requests[1].headers.authorization, undefined);
});

test("embed: configured dimensions are forwarded in the body", async (t) => {
  const server = await startJsonServer({
    "/embeddings": { status: 200, body: { data: [{ embedding: [1, 0, 0] }] } },
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({
    getConfig: () => makeConfig(server.url, { dimensions: 3 }),
  });
  const { dimension } = await client.embed(["x"]);

  assert.equal(dimension, 3);
  assert.equal(server.requests[0].bodyJson.dimensions, 3);
});

test("embed: baseUrl already ending in /embeddings is used as-is", async (t) => {
  const server = await startJsonServer({
    "/embeddings": { status: 200, body: { data: [{ embedding: [1, 0] }] } },
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({
    getConfig: () => makeConfig(`${server.url}/embeddings/`),
  });
  await client.embed(["x"]);

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, "/embeddings");
});

test("embed: transient failures are retried at the client level", async (t) => {
  const server = await startJsonServer({
    "/embeddings": [
      { status: 429, headers: { "retry-after": "0" }, body: { error: "rate limited" } },
      { status: 200, body: { data: [{ embedding: [1, 0] }] } },
    ],
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({
    getConfig: () => makeConfig(server.url, { maxRetries: 2 }),
  });
  const { vectors } = await client.embed(["x"]);

  assert.equal(vectors.length, 1);
  assert.equal(server.requests.length, 2);
});

test("embed: transport errors map to EMBEDDING_REQUEST_FAILED", async (t) => {
  const server = await startJsonServer({
    "/embeddings": { status: 500, body: { error: "boom" } },
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({
    getConfig: () => makeConfig(server.url, { maxRetries: 0 }),
  });

  await assert.rejects(
    client.embed(["x"]),
    (err) => {
      assert.ok(err instanceof EmbeddingError);
      assert.equal(err.code, "EMBEDDING_REQUEST_FAILED");
      assert.equal(err.status, 500);
      assert.equal(err.retryable, true);
      assert.ok(err.details?.body.includes("boom"));
      return true;
    },
  );
});

test("embedOne: returns the first vector and metadata", async (t) => {
  const server = await startJsonServer({
    "/embeddings": { status: 200, body: { data: [{ embedding: [3, 4] }] } },
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({ getConfig: () => makeConfig(server.url) });
  const { vector, model, dimension } = await client.embedOne("hello");

  assert.deepEqual(vector, [0.6, 0.8]);
  assert.equal(model, "text-embedding-3-small");
  assert.equal(dimension, 2);
  assert.equal(server.requests[0].bodyJson.input[0], "hello");
});

test("testConnection: reports ok with model, dimension, and latency", async (t) => {
  const server = await startJsonServer({
    "/embeddings": { status: 200, body: { data: [{ embedding: [1, 1] }] } },
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({ getConfig: () => makeConfig(server.url) });
  const info = await client.testConnection();

  assert.equal(info.ok, true);
  assert.equal(info.model, "text-embedding-3-small");
  assert.equal(info.dimension, 2);
  assert.equal(typeof info.latencyMs, "number");
  assert.equal(server.requests[0].bodyJson.input.length, 1);
  assert.equal(server.requests[0].bodyJson.input[0], "dsh-context-rag embedding connection test");
});

test("testConnection: propagates failure as EmbeddingError", async (t) => {
  const server = await startJsonServer({
    "/embeddings": { status: 503, body: { error: "unavailable" } },
  });
  t.after(() => server.close());

  const client = createEmbeddingClient({
    getConfig: () => makeConfig(server.url, { maxRetries: 0 }),
  });

  await assert.rejects(
    client.testConnection(),
    (err) => {
      assert.ok(err instanceof EmbeddingError);
      assert.equal(err.code, "EMBEDDING_REQUEST_FAILED");
      assert.equal(err.status, 503);
      return true;
    },
  );
});
