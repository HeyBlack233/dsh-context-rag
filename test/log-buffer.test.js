/**
 * Tests for lib/log-buffer.js — the in-memory ring buffer backing the plugin
 * "Logs" tab.
 *
 * Plain ESM, `node:test` + `node:assert/strict`. No network.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import {
  LOG_LEVELS,
  DEFAULT_LOG_LIMIT,
  MAX_LOG_LIMIT,
  createLogBuffer,
} from "../lib/log-buffer.js";
import { makeTempDir, cleanupTempDir } from "./helpers/tmp.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Fixed UTC instant used to make entry timestamps deterministic. */
const FIXED_UTC = new Date("2026-11-17T12:03:20.000Z");
const nowUtc = () => FIXED_UTC;

/**
 * Fixed local-time instant used to make export file names deterministic in
 * any host time zone (built from local components).
 */
const FIXED_LOCAL = new Date(2026, 10, 17, 20, 3, 22, 123);
const nowLocal = () => FIXED_LOCAL;

/** Expected export file name for FIXED_LOCAL, in any time zone. */
const FIXED_FILE_NAME = "context-rag-20261117-200322-123.log";

/** Spy base logger; every method records calls, `warn` always throws. */
function makeSpyBase() {
  const calls = [];
  const base = {
    debug(...args) {
      calls.push({ level: "debug", thisArg: this, args });
    },
    info(...args) {
      calls.push({ level: "info", thisArg: this, args });
    },
    warn() {
      throw new Error("base warn failed");
    },
    error(...args) {
      calls.push({ level: "error", thisArg: this, args });
    },
  };
  return { base, calls };
}

/** Messages of all buffered entries, in order. */
function messages(buf) {
  return buf.entries().map((entry) => entry.message);
}

/* ------------------------------------------------------------------ */
/* Exports and defaults                                                */
/* ------------------------------------------------------------------ */

describe("exports and defaults", () => {
  test("exports the contract constants", () => {
    assert.deepStrictEqual(LOG_LEVELS, ["debug", "info", "warn", "error"]);
    assert.strictEqual(DEFAULT_LOG_LIMIT, 200);
    assert.strictEqual(MAX_LOG_LIMIT, 5000);
  });

  test("default buffer: limit 200, debug off, empty entries and text", () => {
    const buf = createLogBuffer();
    assert.strictEqual(buf.limit, DEFAULT_LOG_LIMIT);
    assert.strictEqual(buf.debug, false);
    assert.deepStrictEqual(buf.entries(), []);
    assert.strictEqual(buf.toText(), "");
  });

  test("limit and debug getters are read-only", () => {
    const buf = createLogBuffer();
    assert.throws(() => {
      buf.limit = 5;
    }, TypeError);
    assert.throws(() => {
      buf.debug = true;
    }, TypeError);
    assert.strictEqual(buf.limit, DEFAULT_LOG_LIMIT);
    assert.strictEqual(buf.debug, false);
  });
});

/* ------------------------------------------------------------------ */
/* record                                                              */
/* ------------------------------------------------------------------ */

describe("record", () => {
  test("creates entries with ISO time, level and message", () => {
    const buf = createLogBuffer({ now: nowUtc });
    const entry = buf.record("info", "hello");
    assert.strictEqual(entry.time, "2026-11-17T12:03:20.000Z");
    assert.strictEqual(entry.level, "info");
    assert.strictEqual(entry.message, "hello");
    assert.deepStrictEqual(buf.entries(), [
      { time: "2026-11-17T12:03:20.000Z", level: "info", message: "hello" },
    ]);
  });

  test("joins multiple arguments with single spaces", () => {
    const buf = createLogBuffer();
    buf.record("warn", "alpha", "beta", "gamma");
    assert.strictEqual(buf.entries()[0].message, "alpha beta gamma");
  });

  test("keeps plain strings verbatim (no quoting)", () => {
    const buf = createLogBuffer();
    buf.record("info", "raw string with spaces  and  gaps");
    assert.strictEqual(
      buf.entries()[0].message,
      "raw string with spaces  and  gaps",
    );
  });

  test("formats Error instances via their stack, falling back to message", () => {
    const buf = createLogBuffer();
    const err = new Error("boom");
    buf.record("error", err);
    assert.strictEqual(buf.entries()[0].message, err.stack);

    const stackless = Object.create(Error.prototype);
    stackless.message = "no-stack-message";
    buf.record("error", stackless);
    assert.strictEqual(buf.entries()[1].message, "no-stack-message");
  });

  test("formats objects with the documented inspect options", () => {
    const buf = createLogBuffer();
    const obj = { a: 1, list: ["x", "y", "z"], nested: { deep: { flag: true } } };
    buf.record("info", obj);
    const expected = util.inspect(obj, {
      depth: 4,
      breakLength: Infinity,
      maxArrayLength: 50,
      maxStringLength: 4000,
    });
    assert.strictEqual(buf.entries()[0].message, expected);
  });

  test("handles circular objects without throwing", () => {
    const buf = createLogBuffer();
    const circular = { name: "loop" };
    circular.self = circular;
    assert.doesNotThrow(() => buf.record("info", circular));
    const message = buf.entries()[0].message;
    assert.ok(typeof message === "string" && message.length > 0);
    assert.ok(message.includes("name"));
  });

  test("rejects unknown levels with RangeError", () => {
    const buf = createLogBuffer();
    assert.throws(() => buf.record("verbose", "x"), RangeError);
    assert.throws(() => buf.record("INFO", "x"), RangeError);
    assert.throws(() => buf.record(null, "x"), RangeError);
    assert.deepStrictEqual(buf.entries(), []);
  });

  test("entries() returns a detached copy", () => {
    const buf = createLogBuffer({ now: nowUtc });
    buf.record("info", "keep");
    const snapshot = buf.entries();
    snapshot[0].message = "hacked";
    snapshot.push({ time: "t", level: "info", message: "extra" });
    assert.deepStrictEqual(buf.entries(), [
      { time: "2026-11-17T12:03:20.000Z", level: "info", message: "keep" },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Ring trimming                                                       */
/* ------------------------------------------------------------------ */

describe("ring trimming", () => {
  test("keeps only the newest `limit` entries, oldest first", () => {
    const buf = createLogBuffer({ limit: 3 });
    for (const m of ["m1", "m2", "m3", "m4", "m5"]) buf.record("info", m);
    assert.deepStrictEqual(messages(buf), ["m3", "m4", "m5"]);
  });

  test("setLimit shrink trims immediately", () => {
    const buf = createLogBuffer({ limit: 5 });
    for (const m of ["m1", "m2", "m3", "m4", "m5"]) buf.record("info", m);
    assert.strictEqual(buf.setLimit(2), 2);
    assert.deepStrictEqual(messages(buf), ["m4", "m5"]);
  });

  test("setLimit growth keeps existing entries", () => {
    const buf = createLogBuffer({ limit: 2 });
    buf.record("info", "m1");
    buf.record("info", "m2");
    assert.strictEqual(buf.setLimit(10), 10);
    assert.deepStrictEqual(messages(buf), ["m1", "m2"]);
  });
});

/* ------------------------------------------------------------------ */
/* setLimit / setDebug validation                                      */
/* ------------------------------------------------------------------ */

describe("setLimit / setDebug validation", () => {
  test("setLimit rejects non-integers and out-of-range values", () => {
    const buf = createLogBuffer();
    for (const bad of [0, -1, 5001, 1.5, "3", NaN, null, undefined]) {
      assert.throws(
        () => buf.setLimit(bad),
        RangeError,
        `setLimit(${String(bad)})`,
      );
    }
    assert.strictEqual(buf.limit, DEFAULT_LOG_LIMIT);
  });

  test("setLimit accepts the boundary values 1 and 5000", () => {
    const buf = createLogBuffer();
    assert.strictEqual(buf.setLimit(1), 1);
    assert.strictEqual(buf.limit, 1);
    assert.strictEqual(buf.setLimit(MAX_LOG_LIMIT), MAX_LOG_LIMIT);
    assert.strictEqual(buf.limit, MAX_LOG_LIMIT);
  });

  test("setDebug rejects non-boolean flags", () => {
    const buf = createLogBuffer();
    for (const bad of ["yes", 1, 0, null, undefined, {}]) {
      assert.throws(
        () => buf.setDebug(bad),
        TypeError,
        `setDebug(${String(bad)})`,
      );
    }
    assert.strictEqual(buf.debug, false);
  });

  test("setDebug toggles the capture flag", () => {
    const buf = createLogBuffer();
    assert.strictEqual(buf.setDebug(true), true);
    assert.strictEqual(buf.debug, true);
    assert.strictEqual(buf.setDebug(false), false);
    assert.strictEqual(buf.debug, false);
  });
});

/* ------------------------------------------------------------------ */
/* Debug capture gating                                                */
/* ------------------------------------------------------------------ */

describe("debug capture gating", () => {
  test("record('debug') returns null and stores nothing while capture is off", () => {
    const buf = createLogBuffer();
    assert.strictEqual(buf.record("debug", "hidden"), null);
    assert.deepStrictEqual(buf.entries(), []);
  });

  test("record('debug') stores entries once capture is on", () => {
    const buf = createLogBuffer();
    buf.setDebug(true);
    const entry = buf.record("debug", "visible");
    assert.strictEqual(entry.level, "debug");
    assert.strictEqual(buf.entries().length, 1);
  });

  test("tee logger debug is a full no-op while capture is off", () => {
    const { base, calls } = makeSpyBase();
    const buf = createLogBuffer();
    const tee = buf.logger(base);
    assert.strictEqual(tee.debug("hidden"), undefined);
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(buf.entries(), []);
  });

  test("tee logger debug records and forwards once capture is on", () => {
    const { base, calls } = makeSpyBase();
    const buf = createLogBuffer();
    buf.setDebug(true);
    const tee = buf.logger(base);
    const entry = tee.debug("visible");
    assert.strictEqual(entry.level, "debug");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].level, "debug");
    assert.deepStrictEqual(calls[0].args, ["visible"]);
    assert.strictEqual(calls[0].thisArg, base);
    assert.strictEqual(buf.entries().length, 1);
  });

  test("tee logger other levels always record and forward, preserving `this`", () => {
    const { base, calls } = makeSpyBase();
    const buf = createLogBuffer();
    const tee = buf.logger(base);
    tee.info("i");
    tee.error("e", 42);
    assert.strictEqual(buf.entries().length, 2);
    assert.deepStrictEqual(calls.map((c) => c.level), ["info", "error"]);
    assert.deepStrictEqual(calls[0].args, ["i"]);
    assert.deepStrictEqual(calls[1].args, ["e", 42]);
    assert.ok(calls.every((c) => c.thisArg === base));
  });

  test("a throwing base method does not break recording or the caller", () => {
    const { base } = makeSpyBase();
    const buf = createLogBuffer();
    const tee = buf.logger(base);
    assert.doesNotThrow(() => tee.warn("w"));
    assert.strictEqual(buf.entries().length, 1);
    assert.strictEqual(buf.entries()[0].level, "warn");
    assert.strictEqual(buf.entries()[0].message, "w");
  });

  test("tee logger tolerates a null base", () => {
    const buf = createLogBuffer();
    const tee = buf.logger(null);
    assert.doesNotThrow(() => {
      tee.info("x");
      tee.warn("y");
      tee.error("z");
    });
    assert.strictEqual(buf.entries().length, 3);
  });
});

/* ------------------------------------------------------------------ */
/* Message truncation                                                  */
/* ------------------------------------------------------------------ */

describe("message truncation", () => {
  test("truncates over-long messages to 20000 chars ending with …", () => {
    const buf = createLogBuffer();
    buf.record("info", "x".repeat(25000));
    const message = buf.entries()[0].message;
    assert.strictEqual(message.length, 20000);
    assert.ok(message.endsWith("…"));
    assert.strictEqual(message.slice(0, 19999), "x".repeat(19999));
  });

  test("keeps messages up to 20000 chars untouched", () => {
    const buf = createLogBuffer();
    const exact = "x".repeat(20000);
    buf.record("info", exact);
    assert.strictEqual(buf.entries()[0].message, exact);
  });
});

/* ------------------------------------------------------------------ */
/* clear                                                               */
/* ------------------------------------------------------------------ */

describe("clear", () => {
  test("empties the buffer", () => {
    const buf = createLogBuffer();
    buf.record("info", "a");
    buf.record("warn", "b");
    buf.clear();
    assert.deepStrictEqual(buf.entries(), []);
    assert.strictEqual(buf.toText(), "");
  });
});

/* ------------------------------------------------------------------ */
/* toText                                                              */
/* ------------------------------------------------------------------ */

describe("toText", () => {
  test("renders one line per entry with uppercase level and trailing newline", () => {
    const buf = createLogBuffer({ now: nowUtc });
    buf.record("info", "one");
    buf.record("warn", "two");
    buf.record("error", "three");
    assert.strictEqual(
      buf.toText(),
      "[2026-11-17T12:03:20.000Z] [INFO] one\n" +
        "[2026-11-17T12:03:20.000Z] [WARN] two\n" +
        "[2026-11-17T12:03:20.000Z] [ERROR] three\n",
    );
  });

  test("preserves multi-line messages verbatim", () => {
    const buf = createLogBuffer({ now: nowUtc });
    buf.record("info", "line1\nline2");
    assert.strictEqual(
      buf.toText(),
      "[2026-11-17T12:03:20.000Z] [INFO] line1\nline2\n",
    );
  });

  test("returns an empty string for an empty buffer", () => {
    assert.strictEqual(createLogBuffer().toText(), "");
  });
});

/* ------------------------------------------------------------------ */
/* exportTo                                                            */
/* ------------------------------------------------------------------ */

describe("exportTo", () => {
  test("writes header, entries, count and mode 0600 to a new file", async (t) => {
    const dir = await makeTempDir("dsh-rag-log-export-");
    t.after(() => cleanupTempDir(dir));

    const buf = createLogBuffer({ now: nowLocal });
    buf.record("info", "first");
    buf.record("warn", "second");

    const result = buf.exportTo(dir);
    assert.ok(path.isAbsolute(result.path));
    assert.strictEqual(path.basename(result.path), FIXED_FILE_NAME);
    assert.strictEqual(result.count, 2);

    const stat = fs.statSync(result.path);
    assert.strictEqual(stat.mode & 0o777, 0o600);

    const content = fs.readFileSync(result.path, "utf8");
    const iso = FIXED_LOCAL.toISOString();
    assert.ok(content.startsWith("# dsh-context-rag in-memory log buffer\n"));
    assert.ok(content.includes(`# exported: ${iso}\n`));
    assert.ok(content.includes("# limit: 200; entries: 2\n"));
    assert.ok(content.includes(`[${iso}] [INFO] first\n`));
    assert.ok(content.includes(`[${iso}] [WARN] second\n`));
  });

  test("exports only the buffered (limited) entries", async (t) => {
    const dir = await makeTempDir("dsh-rag-log-export-");
    t.after(() => cleanupTempDir(dir));

    const buf = createLogBuffer({ limit: 2, now: nowLocal });
    for (const m of ["m1", "m2", "m3", "m4"]) buf.record("info", m);

    const result = buf.exportTo(dir);
    assert.strictEqual(result.count, 2);
    const content = fs.readFileSync(result.path, "utf8");
    assert.ok(content.includes("# limit: 2; entries: 2\n"));
    assert.ok(content.includes("[INFO] m3\n"));
    assert.ok(content.includes("[INFO] m4\n"));
    assert.ok(!content.includes("m1"));
    assert.ok(!content.includes("m2"));
  });

  test("consecutive exports within the same millisecond do not overwrite", async (t) => {
    const dir = await makeTempDir("dsh-rag-log-export-");
    t.after(() => cleanupTempDir(dir));

    const buf = createLogBuffer({ now: nowLocal });
    buf.record("info", "a");
    const first = buf.exportTo(dir);
    const second = buf.exportTo(dir);

    assert.strictEqual(path.basename(first.path), FIXED_FILE_NAME);
    assert.strictEqual(
      path.basename(second.path),
      "context-rag-20261117-200322-123-1.log",
    );
    assert.ok(fs.existsSync(first.path));
    assert.ok(fs.existsSync(second.path));
    assert.notStrictEqual(first.path, second.path);
  });

  test("creates missing directories recursively", async (t) => {
    const root = await makeTempDir("dsh-rag-log-export-");
    t.after(() => cleanupTempDir(root));
    const nested = path.join(root, "logs", "sub");

    const buf = createLogBuffer({ now: nowLocal });
    buf.record("info", "deep");
    const result = buf.exportTo(nested);
    assert.ok(fs.existsSync(result.path));
    assert.strictEqual(path.basename(result.path), FIXED_FILE_NAME);
  });

  test("rejects non-string directories with TypeError", () => {
    const buf = createLogBuffer();
    for (const bad of [123, null, undefined, {}, ["x"]]) {
      assert.throws(
        () => buf.exportTo(bad),
        TypeError,
        `exportTo(${String(bad)})`,
      );
    }
  });
});
