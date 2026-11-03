/**
 * Tests for the JSONL pair store in `lib/pairs.js`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PairError,
  appendPair,
  iteratePairFiles,
  parsePairLine,
  readPairs,
  serializePair,
  validatePair,
} from "../lib/pairs.js";

/**
 * Create a fresh temporary home directory, cleaned up after the test.
 *
 * @param {import("node:test").TestContext} t
 * @returns {Promise<string>}
 */
async function makeHome(t) {
  const home = await mkdtemp(join(tmpdir(), "dsh-pairs-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

/** @returns {object} A valid pair record. */
function samplePair(overrides = {}) {
  return {
    pairId: "pair-1",
    sessionId: "session-1",
    cwd: "/work/project",
    turn: 3,
    createdAt: 1_700_000_000_000,
    user: "What is the build command?",
    assistant: "Run `npm run build`.",
    ...overrides,
  };
}

test("pairs: validatePair accepts a valid record and normalizes it", () => {
  const record = samplePair({
    pairId: "  pair-1  ",
    sessionId: "  session-1  ",
    turn: 0,
  });
  const normalized = validatePair(record);
  assert.deepEqual(normalized, {
    pairId: "pair-1",
    sessionId: "session-1",
    cwd: "/work/project",
    turn: 0,
    createdAt: 1_700_000_000_000,
    user: "What is the build command?",
    assistant: "Run `npm run build`.",
  });
  // The original record is not mutated.
  assert.equal(record.pairId, "  pair-1  ");
});

test("pairs: validatePair accepts an empty cwd", () => {
  const normalized = validatePair(samplePair({ cwd: "" }));
  assert.equal(normalized.cwd, "");
});

test("pairs: validatePair rejects invalid records with INVALID_PAIR", () => {
  const cases = [
    { overrides: { pairId: "" }, field: "pairId" },
    { overrides: { pairId: "   " }, field: "pairId" },
    { overrides: { pairId: 42 }, field: "pairId" },
    { overrides: { sessionId: "" }, field: "sessionId" },
    { overrides: { sessionId: null }, field: "sessionId" },
    { overrides: { cwd: 7 }, field: "cwd" },
    { overrides: { turn: -1 }, field: "turn" },
    { overrides: { turn: 1.5 }, field: "turn" },
    { overrides: { turn: "3" }, field: "turn" },
    { overrides: { createdAt: "now" }, field: "createdAt" },
    { overrides: { createdAt: Number.NaN }, field: "createdAt" },
    { overrides: { user: 5 }, field: "user" },
    { overrides: { assistant: null }, field: "assistant" },
  ];
  for (const { overrides, field } of cases) {
    assert.throws(
      () => validatePair(samplePair(overrides)),
      (err) => {
        assert.ok(err instanceof PairError);
        assert.equal(err.code, "INVALID_PAIR");
        assert.equal(err.details?.field, field);
        return true;
      },
      `expected rejection for field ${field}`,
    );
  }
  assert.throws(
    () => validatePair(null),
    (err) => err instanceof PairError && err.code === "INVALID_PAIR",
  );
  assert.throws(
    () => validatePair([]),
    (err) => err instanceof PairError && err.code === "INVALID_PAIR",
  );
});

test("pairs: serializePair produces one line and parsePairLine round-trips", () => {
  const record = samplePair();
  const line = serializePair(record);
  assert.equal(typeof line, "string");
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.split("\n").length, 2);
  assert.equal(line.includes("\n") && !line.slice(0, -1).includes("\n"), true);
  assert.deepEqual(parsePairLine(line.slice(0, -1)), record);
});

test("pairs: parsePairLine returns null for malformed lines", () => {
  assert.equal(parsePairLine(""), null);
  assert.equal(parsePairLine("not json"), null);
  assert.equal(parsePairLine("{unclosed"), null);
  assert.equal(parsePairLine("[1, 2, 3]"), null);
  assert.equal(parsePairLine('{"pairId": "p"}'), null); // missing fields
  assert.equal(parsePairLine(JSON.stringify(samplePair({ turn: "3" }))), null); // wrong types
  assert.equal(parsePairLine(null), null);
  assert.equal(parsePairLine(undefined), null);
});

test("pairs: appendPair creates directories, appends one line, returns normalized record", async (t) => {
  const home = await makeHome(t);
  const file = join(home, "pairs", "deep", "nested", "pairs.jsonl");

  const returned = await appendPair(file, samplePair({ pairId: "  p  " }));
  assert.deepEqual(returned, samplePair({ pairId: "p" }));

  const content = await readFile(file, "utf8");
  assert.equal(content.split("\n").length, 2);
  assert.equal(content.endsWith("\n"), true);
  assert.deepEqual(parsePairLine(content.trimEnd()), samplePair({ pairId: "p" }));
});

test("pairs: appendPair does not rewrite existing content", async (t) => {
  const home = await makeHome(t);
  const file = join(home, "pairs", "pairs.jsonl");
  await appendPair(file, samplePair({ pairId: "first" }));
  const before = await readFile(file, "utf8");

  await appendPair(file, samplePair({ pairId: "second", turn: 1 }));
  const after = await readFile(file, "utf8");

  assert.ok(after.startsWith(before), "existing content must be preserved verbatim");
  assert.equal(after, before + serializePair(samplePair({ pairId: "second", turn: 1 })));
});

test("pairs: appendPair rejects invalid records without writing", async (t) => {
  const home = await makeHome(t);
  const file = join(home, "pairs", "pairs.jsonl");
  await assert.rejects(
    appendPair(file, samplePair({ turn: -2 })),
    (err) => err instanceof PairError && err.code === "INVALID_PAIR",
  );
  // Directory may exist (created lazily is fine), but no pair line was written.
  const content = await readFile(file, "utf8").catch(() => null);
  assert.equal(content, null);
});

test("pairs: readPairs yields records with unicode text in deterministic file order", async (t) => {
  const home = await makeHome(t);
  const records = [
    samplePair({ pairId: "u1", user: "你好，世界", assistant: "こんにちは 👋" }),
    samplePair({ pairId: "u2", user: "line1\nline2\ttab", assistant: "emoji 🎉 and 中文" }),
  ];
  await appendPair(join(home, "pairs", "z.jsonl"), records[0]);
  await appendPair(join(home, "pairs", "a", "m.jsonl"), records[1]);

  const seen = [];
  for await (const { record, file } of readPairs(home)) {
    seen.push({ record, file });
  }

  assert.equal(seen.length, 2);
  // Sorted: a/m.jsonl before z.jsonl.
  assert.equal(seen[0].record.pairId, "u2");
  assert.equal(seen[0].file, join(home, "pairs", "a", "m.jsonl"));
  assert.equal(seen[1].record.pairId, "u1");
  assert.equal(seen[1].file, join(home, "pairs", "z.jsonl"));
  assert.deepEqual(seen[0].record.user, "line1\nline2\ttab");
  assert.deepEqual(seen[1].record.user, "你好，世界");
  assert.deepEqual(seen[1].record.assistant, "こんにちは 👋");
});

test("pairs: readPairs skips malformed lines and reports them via onMalformed", async (t) => {
  const home = await makeHome(t);
  const file = join(home, "pairs", "pairs.jsonl");
  const good = samplePair({ pairId: "good" });
  const badLines = ["{broken json", JSON.stringify({ pairId: "x" }), JSON.stringify([1])];
  const content = [serializePair(good), badLines[0], badLines[1], "   ", badLines[2], ""].join("\n");
  await appendPair(file, samplePair({ pairId: "ignored" })); // ensure dir exists
  const handle = await open(file, "w");
  try {
    await handle.write(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  const seen = [];
  const malformed = [];
  for await (const item of readPairs(home, { onMalformed: (line, f) => malformed.push({ line, f }) })) {
    seen.push(item);
  }

  assert.equal(seen.length, 1);
  assert.equal(seen[0].record.pairId, "good");
  assert.equal(seen[0].file, file);
  // Three non-blank malformed lines reported; blank lines skipped silently.
  assert.equal(malformed.length, 3);
  assert.deepEqual(malformed.map((m) => m.line), badLines);
  for (const m of malformed) {
    assert.equal(m.f, file);
  }
});

test("pairs: readPairs yields nothing when the pairs directory is missing", async (t) => {
  const home = await makeHome(t);
  const seen = [];
  for await (const item of readPairs(home)) {
    seen.push(item);
  }
  assert.deepEqual(seen, []);
});

test("pairs: iteratePairFiles lists only .jsonl files recursively, absolute and sorted", async (t) => {
  const home = await makeHome(t);
  const pairsRoot = join(home, "pairs");
  await mkdir(join(pairsRoot, "b", "c"), { recursive: true });
  await writeFile(join(pairsRoot, "b", "1.jsonl"), "");
  await writeFile(join(pairsRoot, "b", "c", "2.jsonl"), "");
  await writeFile(join(pairsRoot, "a.jsonl"), "");
  await writeFile(join(pairsRoot, "b", "notes.txt"), "");
  await writeFile(join(pairsRoot, "b", "c", "3.txt"), "");

  const files = [];
  for await (const file of iteratePairFiles(home)) {
    files.push(file);
  }

  assert.deepEqual(files, [
    join(pairsRoot, "a.jsonl"),
    join(pairsRoot, "b", "1.jsonl"),
    join(pairsRoot, "b", "c", "2.jsonl"),
  ]);
  for (const file of files) {
    assert.ok(file.startsWith(pairsRoot));
    assert.ok(file.endsWith(".jsonl"));
  }
});

test("pairs: iteratePairFiles yields nothing when the pairs directory is missing", async (t) => {
  const home = await makeHome(t);
  const files = [];
  for await (const file of iteratePairFiles(home)) {
    files.push(file);
  }
  assert.deepEqual(files, []);
});

test("pairs: readPairs handles CRLF line endings", async (t) => {
  const home = await makeHome(t);
  await mkdir(join(home, "pairs"), { recursive: true });
  const line = `${serializePair(samplePair({ pairId: "crlf" }))}`;
  await writeFile(join(home, "pairs", "pairs.jsonl"), line.replace(/\n$/, "\r\n"));

  const seen = [];
  for await (const { record } of readPairs(home)) {
    seen.push(record);
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].pairId, "crlf");
});
