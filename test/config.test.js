/**
 * Tests for lib/config.js — defaults, normalization/validation, and the
 * synchronous config store.
 *
 * Plain ESM, `node:test` + `node:assert/strict`. No network.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CONFIG,
  ConfigError,
  normalizeConfig,
  createConfigStore,
} from "../lib/config.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function tempHome(t) {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "dsh-cfg-test-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeStore(home, logger) {
  return createConfigStore({ home, logger });
}

/** Assert that normalizeConfig rejects a patch at the given field. */
function assertInvalid(patch, expectedField) {
  assert.throws(
    () => normalizeConfig(patch),
    (err) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err}`);
      assert.strictEqual(err.code, "INVALID_CONFIG");
      assert.ok(err.details, "ConfigError should carry details");
      assert.strictEqual(err.details.field, expectedField);
      return true;
    },
    `expected ConfigError for field "${expectedField}"`,
  );
}

/* ------------------------------------------------------------------ */
/* DEFAULT_CONFIG                                                      */
/* ------------------------------------------------------------------ */

describe("DEFAULT_CONFIG", () => {
  test("has the expected shape and values", () => {
    assert.deepStrictEqual(DEFAULT_CONFIG, {
      enabled: true,
      embedding: {
        baseUrl: "",
        apiKey: "",
        model: "",
        dimensions: null,
        timeoutMs: 3000,
        maxRetries: 2,
        batchSize: 16,
        maxEmbeddingChars: 8000,
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
      retrieval: {
        scope: "workspace",
        candidateLimit: 20,
        topK: 5,
        minScore: 0.4,
        rerankMinScore: 0.4,
        maxContextChars: 3000,
        timeoutMs: 3000,
        injectionEnabled: true,
        scanLimit: 5000,
      },
      indexing: {
        enabled: true,
        retryDelayMs: 2000,
        maxAttempts: 8,
        pollIntervalMs: 1000,
      },
    });
  });

  test("is deeply frozen (every nested object is read-only)", () => {
    assert.ok(Object.isFrozen(DEFAULT_CONFIG));
    assert.ok(Object.isFrozen(DEFAULT_CONFIG.embedding));
    assert.ok(Object.isFrozen(DEFAULT_CONFIG.rerank));
    assert.ok(Object.isFrozen(DEFAULT_CONFIG.retrieval));
    assert.ok(Object.isFrozen(DEFAULT_CONFIG.indexing));
    // Mutating throws in strict mode or silently fails; the value must not change.
    assert.throws(() => {
      "use strict";
      DEFAULT_CONFIG.enabled = false;
    }, TypeError);
    assert.strictEqual(DEFAULT_CONFIG.enabled, true);
  });
});

/* ------------------------------------------------------------------ */
/* normalizeConfig                                                     */
/* ------------------------------------------------------------------ */

describe("normalizeConfig", () => {
  test("returns a full config when given a partial input (deep merge)", () => {
    const cfg = normalizeConfig({ embedding: { timeoutMs: 999 } });
    assert.strictEqual(cfg.embedding.timeoutMs, 999);
    assert.strictEqual(cfg.embedding.batchSize, DEFAULT_CONFIG.embedding.batchSize);
    assert.strictEqual(cfg.enabled, DEFAULT_CONFIG.enabled);
  });

  test("deep-merges over defaults at every level", () => {
    const cfg = normalizeConfig({
      rerank: { maxRetries: 4 },
      retrieval: { topK: 9 },
      indexing: { maxAttempts: 12 },
    });
    assert.strictEqual(cfg.rerank.maxRetries, 4);
    assert.strictEqual(cfg.rerank.timeoutMs, DEFAULT_CONFIG.rerank.timeoutMs);
    assert.strictEqual(cfg.retrieval.topK, 9);
    assert.strictEqual(cfg.indexing.maxAttempts, 12);
  });

  test("returns a plain (unfrozen) object, not the frozen defaults", () => {
    const cfg = normalizeConfig({});
    assert.notStrictEqual(cfg, DEFAULT_CONFIG);
    assert.ok(!Object.isFrozen(cfg));
    assert.ok(!Object.isFrozen(cfg.embedding));
    cfg.embedding.timeoutMs = 42; // must not throw
    assert.strictEqual(cfg.embedding.timeoutMs, 42);
  });

  test("ignores unknown top-level and nested keys", () => {
    const cfg = normalizeConfig({
      bogus: 123,
      embedding: { nonsense: true, timeoutMs: 500 },
    });
    assert.ok(!("bogus" in cfg));
    assert.ok(!("nonsense" in cfg.embedding));
    assert.strictEqual(cfg.embedding.timeoutMs, 500);
    assert.ok(!Object.isFrozen(cfg));
  });

  test("accepts non-object input as empty", () => {
    const cfg = normalizeConfig(null);
    assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
  });

  test("trims embedding.model and rerank.model", () => {
    const cfg = normalizeConfig({
      embedding: { model: "  text-embedding-3  " },
      rerank: { model: " rerank-v2 \t" },
    });
    assert.strictEqual(cfg.embedding.model, "text-embedding-3");
    assert.strictEqual(cfg.rerank.model, "rerank-v2");
  });

  describe("validation categories", () => {
    test("bad baseUrl (embedding.baseUrl / rerank.baseUrl)", () => {
      assertInvalid({ embedding: { baseUrl: "not-a-url" } }, "embedding.baseUrl");
      assertInvalid({ embedding: { baseUrl: "ftp://example.com" } }, "embedding.baseUrl");
      assertInvalid({ embedding: { baseUrl: 42 } }, "embedding.baseUrl");
      assertInvalid({ rerank: { baseUrl: "nope" } }, "rerank.baseUrl");
    });

    test("bad path (rerank.path)", () => {
      assertInvalid({ rerank: { path: "" } }, "rerank.path");
      assertInvalid({ rerank: { path: "rerank" } }, "rerank.path");
      assertInvalid({ rerank: { path: "/has space" } }, "rerank.path");
      assertInvalid({ rerank: { path: "http://x" } }, "rerank.path");
      assertInvalid({ rerank: { path: 7 } }, "rerank.path");
    });

    test("dimensions out of range or not an integer", () => {
      assertInvalid({ embedding: { dimensions: 0 } }, "embedding.dimensions");
      assertInvalid({ embedding: { dimensions: -5 } }, "embedding.dimensions");
      assertInvalid({ embedding: { dimensions: 8193 } }, "embedding.dimensions");
      assertInvalid({ embedding: { dimensions: 1.5 } }, "embedding.dimensions");
      assertInvalid({ embedding: { dimensions: "128" } }, "embedding.dimensions");
    });

    test("timeout out of range", () => {
      assertInvalid({ embedding: { timeoutMs: 1 } }, "embedding.timeoutMs");
      assertInvalid({ embedding: { timeoutMs: 60001 } }, "embedding.timeoutMs");
      assertInvalid({ rerank: { timeoutMs: 50 } }, "rerank.timeoutMs");
      assertInvalid({ retrieval: { timeoutMs: 99999 } }, "retrieval.timeoutMs");
    });

    test("retries out of range", () => {
      assertInvalid({ embedding: { maxRetries: -1 } }, "embedding.maxRetries");
      assertInvalid({ embedding: { maxRetries: 6 } }, "embedding.maxRetries");
      assertInvalid({ rerank: { maxRetries: 7 } }, "rerank.maxRetries");
    });

    test("batchSize out of range", () => {
      assertInvalid({ embedding: { batchSize: 0 } }, "embedding.batchSize");
      assertInvalid({ embedding: { batchSize: 129 } }, "embedding.batchSize");
    });

    test("maxEmbeddingChars out of range", () => {
      assertInvalid({ embedding: { maxEmbeddingChars: 255 } }, "embedding.maxEmbeddingChars");
      assertInvalid({ embedding: { maxEmbeddingChars: 32001 } }, "embedding.maxEmbeddingChars");
    });

    test("scope must be workspace or all", () => {
      assertInvalid({ retrieval: { scope: "invalid" } }, "retrieval.scope");
      assertInvalid({ retrieval: { scope: "" } }, "retrieval.scope");
      assertInvalid({ retrieval: { scope: 1 } }, "retrieval.scope");
    });

    test("candidateLimit / topK relationship", () => {
      assertInvalid({ retrieval: { candidateLimit: 3, topK: 4 } }, "retrieval.topK");
      assertInvalid({ retrieval: { candidateLimit: 0 } }, "retrieval.candidateLimit");
      assertInvalid({ retrieval: { candidateLimit: 1001 } }, "retrieval.candidateLimit");
      assertInvalid({ retrieval: { topK: 0 } }, "retrieval.topK");
      assertInvalid({ retrieval: { topK: 101 } }, "retrieval.topK");
    });

    test("minScore out of range", () => {
      assertInvalid({ retrieval: { minScore: -0.1 } }, "retrieval.minScore");
      assertInvalid({ retrieval: { minScore: 1.1 } }, "retrieval.minScore");
    });

    test("rerankMinScore out of range", () => {
      assertInvalid(
        { retrieval: { rerankMinScore: -0.1 } },
        "retrieval.rerankMinScore",
      );
      assertInvalid(
        { retrieval: { rerankMinScore: 1.1 } },
        "retrieval.rerankMinScore",
      );
    });

    test("maxContextChars out of range", () => {
      assertInvalid({ retrieval: { maxContextChars: 199 } }, "retrieval.maxContextChars");
      assertInvalid({ retrieval: { maxContextChars: 20001 } }, "retrieval.maxContextChars");
    });

    test("scanLimit out of range", () => {
      assertInvalid({ retrieval: { scanLimit: 0 } }, "retrieval.scanLimit");
      assertInvalid({ retrieval: { scanLimit: 100001 } }, "retrieval.scanLimit");
    });

    test("indexing timing fields out of range", () => {
      assertInvalid({ indexing: { retryDelayMs: 99 } }, "indexing.retryDelayMs");
      assertInvalid({ indexing: { retryDelayMs: 60001 } }, "indexing.retryDelayMs");
      assertInvalid({ indexing: { maxAttempts: 0 } }, "indexing.maxAttempts");
      assertInvalid({ indexing: { maxAttempts: 101 } }, "indexing.maxAttempts");
      assertInvalid({ indexing: { pollIntervalMs: 99 } }, "indexing.pollIntervalMs");
      assertInvalid({ indexing: { pollIntervalMs: 60001 } }, "indexing.pollIntervalMs");
    });

    test("wrong booleans", () => {
      assertInvalid({ enabled: "yes" }, "enabled");
      assertInvalid({ rerank: { enabled: 1 } }, "rerank.enabled");
      assertInvalid({ retrieval: { injectionEnabled: 0 } }, "retrieval.injectionEnabled");
      assertInvalid({ indexing: { enabled: "true" } }, "indexing.enabled");
    });

    test("invalid apiKey types (non-string, non-null)", () => {
      assertInvalid({ embedding: { apiKey: 123 } }, "embedding.apiKey");
      assertInvalid({ rerank: { apiKey: true } }, "rerank.apiKey");
    });
  });

  test("throws ConfigError with code INVALID_CONFIG and details.field", () => {
    assert.throws(
      () => normalizeConfig({ enabled: "nope" }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.strictEqual(err.name, "ConfigError");
        assert.strictEqual(err.code, "INVALID_CONFIG");
        assert.strictEqual(err.status, 400);
        assert.strictEqual(err.details.field, "enabled");
        assert.strictEqual(typeof err.details.reason, "string");
        return true;
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* createConfigStore                                                   */
/* ------------------------------------------------------------------ */

describe("createConfigStore", () => {
  test("exposes home and path", async (t) => {
    const home = await tempHome(t);
    const store = makeStore(home);
    assert.strictEqual(store.home, home);
    assert.strictEqual(store.path, path.join(home, "config.json"));
  });

  test("load() on missing file -> defaults, loadError null", async (t) => {
    const home = await tempHome(t);
    const store = makeStore(home);
    const cfg = store.load();
    assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
    assert.strictEqual(store.loadError, null);
  });

  test("load() on malformed JSON -> defaults + loadError set, does not throw", async (t) => {
    const home = await tempHome(t);
    fs.writeFileSync(path.join(home, "config.json"), "{ not json", "utf8");
    const store = makeStore(home);
    let returned;
    assert.doesNotThrow(() => {
      returned = store.load();
    });
    assert.deepStrictEqual(returned, DEFAULT_CONFIG);
    assert.ok(store.loadError instanceof Error);
    assert.ok(!(store.loadError instanceof ConfigError)); // a SyntaxError
  });

  test("load() on invalid config -> defaults + loadError set, does not throw", async (t) => {
    const home = await tempHome(t);
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ embedding: { timeoutMs: 1 } }),
      "utf8",
    );
    const store = makeStore(home);
    let returned;
    assert.doesNotThrow(() => {
      returned = store.load();
    });
    assert.deepStrictEqual(returned, DEFAULT_CONFIG);
    assert.ok(store.loadError instanceof ConfigError);
    assert.strictEqual(store.loadError.code, "INVALID_CONFIG");
  });

  test("save() roundtrip: persisted and re-read from disk", async (t) => {
    const home = await tempHome(t);
    const store = makeStore(home);
    const patch = { embedding: { model: "m1", timeoutMs: 777 }, rerank: { enabled: true } };
    const saved = store.save(patch);
    assert.strictEqual(saved.embedding.model, "m1");
    assert.strictEqual(saved.embedding.timeoutMs, 777);
    assert.strictEqual(saved.rerank.enabled, true);

    const onDisk = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.strictEqual(onDisk.embedding.model, "m1");
    assert.strictEqual(onDisk.embedding.timeoutMs, 777);
  });

  test("get() returns a deep clone detached from the store", async (t) => {
    const home = await tempHome(t);
    const store = makeStore(home);
    store.save({ embedding: { model: "m1" } });
    const clone = store.get();
    assert.strictEqual(clone.embedding.model, "m1");
    clone.embedding.model = "m2";
    clone.embedding.timeoutMs = 1;
    assert.strictEqual(store.get().embedding.model, "m1");
    assert.strictEqual(store.get().embedding.timeoutMs, DEFAULT_CONFIG.embedding.timeoutMs);
  });

  test("atomic write: file mode 0o600 and no leftover temp files", async (t) => {
    const home = await tempHome(t);
    const store = makeStore(home);
    store.save({ embedding: { model: "m1" } });

    const stat = fs.statSync(store.path);
    assert.strictEqual((stat.mode & 0o777), 0o600);

    const entries = fs.readdirSync(home);
    assert.deepStrictEqual(entries, ["config.json"]);
    assert.ok(!entries.some((e) => e.includes(".tmp")));
  });

  describe("masked()", () => {
    test("hides apiKey but reports apiKeySet and apiKeyPreview", async (t) => {
      const home = await tempHome(t);
      const store = makeStore(home);
      store.save({ embedding: { apiKey: "abc12345" }, rerank: { apiKey: "def67890" } });
      const masked = store.masked();

      assert.ok(!("apiKey" in masked.embedding));
      assert.ok(!("apiKey" in masked.rerank));
      assert.strictEqual(masked.apiKeySet, true);
      assert.strictEqual(masked.apiKeyPreview, "…2345");
      // Never leaks the full key.
      assert.ok(!masked.apiKeyPreview.includes("abc12345"));
      assert.ok(!JSON.stringify(masked).includes("abc12345"));
      assert.ok(!JSON.stringify(masked).includes("def67890"));
    });

    test("empty preview and apiKeySet false when no key set", async (t) => {
      const home = await tempHome(t);
      const store = makeStore(home);
      const masked = store.masked();
      assert.strictEqual(masked.apiKeySet, false);
      assert.strictEqual(masked.apiKeyPreview, "");
    });
  });

  describe("apiKey semantics", () => {
    test("undefined keeps the current key", async (t) => {
      const home = await tempHome(t);
      const store = makeStore(home);
      store.save({ embedding: { apiKey: "abc12345" } });
      store.save({ embedding: { apiKey: undefined } });
      assert.strictEqual(store.get().embedding.apiKey, "abc12345");
    });

    test("null clears the key", async (t) => {
      const home = await tempHome(t);
      const store = makeStore(home);
      store.save({ embedding: { apiKey: "abc12345" } });
      store.save({ embedding: { apiKey: null } });
      assert.strictEqual(store.get().embedding.apiKey, "");
      assert.strictEqual(store.masked().apiKeySet, false);
    });

    test("string sets and trims the key", async (t) => {
      const home = await tempHome(t);
      const store = makeStore(home);
      store.save({ embedding: { apiKey: "  abc12345  " } });
      assert.strictEqual(store.get().embedding.apiKey, "abc12345");
    });
  });

  test("invalid save leaves previous in-memory and on-disk config untouched", async (t) => {
    const home = await tempHome(t);
    const store = makeStore(home);
    store.save({ embedding: { model: "good", timeoutMs: 777 } });

    assert.throws(
      () => store.save({ embedding: { timeoutMs: 1 } }),
      (err) => err instanceof ConfigError && err.code === "INVALID_CONFIG",
    );

    // In-memory unchanged.
    assert.strictEqual(store.get().embedding.model, "good");
    assert.strictEqual(store.get().embedding.timeoutMs, 777);

    // On-disk unchanged.
    const onDisk = JSON.parse(fs.readFileSync(store.path, "utf8"));
    assert.strictEqual(onDisk.embedding.model, "good");
    assert.strictEqual(onDisk.embedding.timeoutMs, 777);

    // loadError stays null because the failed save did not alter state.
    assert.strictEqual(store.loadError, null);
  });

  test("onChange fires on save and the disposer stops it", async (t) => {
    const home = await tempHome(t);
    const store = makeStore(home);

    const calls = [];
    const disposer = store.onChange((cfg) => calls.push(cfg));

    store.save({ embedding: { model: "m1" } });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].embedding.model, "m1");

    store.save({ embedding: { model: "m2" } });
    assert.strictEqual(calls.length, 2);

    disposer();
    store.save({ embedding: { model: "m3" } });
    assert.strictEqual(calls.length, 2); // listener removed
  });

  test("onChange rejects non-function listeners", async (t) => {
    const home = await tempHome(t);
    const store = makeStore(home);
    assert.throws(() => store.onChange("nope"), TypeError);
  });

  test("refresh() re-reads the disk, discarding in-memory changes", async (t) => {
    const home = await tempHome(t);
    const store = makeStore(home);
    store.save({ embedding: { model: "m1" } });

    // Overwrite the file directly, bypassing the store.
    fs.writeFileSync(
      store.path,
      JSON.stringify(
        normalizeConfig({ embedding: { model: "from-disk" } }),
        null,
        2,
      ) + "\n",
      "utf8",
    );

    assert.strictEqual(store.get().embedding.model, "m1"); // stale
    const refreshed = store.refresh();
    assert.strictEqual(refreshed.embedding.model, "from-disk");
    assert.strictEqual(store.get().embedding.model, "from-disk");
    assert.strictEqual(store.loadError, null);
  });
});
