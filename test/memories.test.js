/**
 * Tests for the persistent memory store in `lib/memories.js`.
 *
 * Covers creation/overwrite, global/workspace isolation, the `MEMORY.md`
 * index, invalid names and the content character limit, reads, exact-match
 * forgetting, forgotten-file exclusion, and the startup scan (manual add /
 * modify / delete and index repair). Front matter round-trips, atomic writes,
 * pairId scoping, and input validation are covered too.
 *
 * Plain ESM, `node:test` + `node:assert/strict`. No network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryStore, MemoryError } from "../lib/memories.js";
import { workspaceSlug } from "../lib/paths.js";
import { cleanupTempDir, makeTempDir } from "./helpers/tmp.js";

/** Build a config-store stub with a configurable content limit. */
function configStore(maxEmbeddingChars = 8000) {
  return { get: () => ({ embedding: { maxEmbeddingChars } }) };
}

/** Build a logger that records every warning. */
function warnLogger() {
  const warns = [];
  return { logger: { warn: (msg) => warns.push(String(msg)) }, warns };
}

/** Raw memory file text in the line-by-line format produced by the store. */
function rawMemory({ name, description, type = "global", createdAt = 1_700_000_000_000, cwd = "", content }) {
  const lines = [
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    `type: ${JSON.stringify(type)}`,
    `createdAt: ${createdAt}`,
    `cwd: ${JSON.stringify(cwd)}`,
  ];
  return `---\n${lines.join("\n")}\n---\n${content}`;
}

/**
 * Create a store on a fresh temporary home directory, cleaned up after the
 * test.
 *
 * @param {import("node:test").TestContext} t
 * @param {object} [options] - Options for `createMemoryStore`/the config
 *   stub.
 * @param {number} [options.maxChars] - Content character limit for the stub.
 * @param {{warn?: Function}} [options.logger] - Logger for the store.
 * @param {() => number} [options.now] - Injectable clock.
 * @returns {Promise<{store: object, home: string}>}
 */
async function makeStore(t, { maxChars = 8000, logger, now } = {}) {
  const home = await makeTempDir("dsh-memories-test-");
  t.after(() => cleanupTempDir(home));
  const store = createMemoryStore({
    home,
    configStore: configStore(maxChars),
    logger,
    now,
  });
  return { store, home };
}

test("memories: write creates a global memory file, record, and index", async (t) => {
  const { store, home } = await makeStore(t, { now: () => 1_700_000_000_000 });

  const result = store.write({
    type: "global",
    name: "alpha",
    description: "First memory",
    content: "Hello world",
  });

  assert.equal(result.action, "created");
  assert.deepEqual(result.record, {
    pairId: "memory:global:global:alpha",
    recordType: "memory",
    memoryType: "global",
    type: "global",
    name: "alpha",
    description: "First memory",
    content: "Hello world",
    cwd: "",
    createdAt: 1_700_000_000_000,
  });

  const text = await readFile(join(home, "memories", "global", "alpha.md"), "utf8");
  assert.equal(
    text,
    '---\nname: "alpha"\ndescription: "First memory"\ntype: "global"\ncreatedAt: 1700000000000\ncwd: ""\n---\nHello world',
  );
  const index = await readFile(join(home, "memories", "global", "MEMORY.md"), "utf8");
  assert.equal(index, "- alpha - First memory\n");
});

test("memories: write stores a workspace memory under the workspace slug", async (t) => {
  const { store, home } = await makeStore(t);
  const cwd = join(home, "my-project");
  const slug = workspaceSlug(cwd);

  const result = store.write({
    type: "workspace",
    cwd,
    name: "notes",
    description: "Project notes",
    content: "Body",
  });

  assert.equal(result.action, "created");
  assert.equal(result.record.type, "workspace");
  assert.equal(result.record.memoryType, "workspace");
  assert.equal(result.record.cwd, cwd);
  assert.equal(result.record.pairId, `memory:workspace:${slug}:notes`);

  const file = join(home, "memories", "workspaces", slug, "notes.md");
  assert.ok((await stat(file)).isFile());
  const index = await readFile(join(home, "memories", "workspaces", slug, "MEMORY.md"), "utf8");
  assert.equal(index, "- notes - Project notes\n");
});

test("memories: write overwrites an active memory, preserves createdAt, and reports updated", async (t) => {
  const { store, home } = await makeStore(t, { now: () => 1_700_000_000_000 });

  const first = store.write({
    type: "global",
    name: "alpha",
    description: "Old summary",
    content: "Old content",
  });
  const second = store.write({
    type: "global",
    name: "alpha",
    description: "New summary",
    content: "New content",
  });

  assert.equal(second.action, "updated");
  assert.equal(second.record.createdAt, first.record.createdAt);
  assert.equal(second.record.description, "New summary");
  assert.equal(second.record.content, "New content");
  assert.equal(second.record.pairId, "memory:global:global:alpha");

  assert.deepEqual(store.get({ type: "global", name: "alpha" }), second.record);
  const index = await readFile(join(home, "memories", "global", "MEMORY.md"), "utf8");
  assert.equal(index, "- alpha - New summary\n");
});

test("memories: global and workspace namespaces are isolated", async (t) => {
  const { store } = await makeStore(t);
  const cwd = join("/work", "project");

  store.write({ type: "global", name: "shared", description: "Global note", content: "G" });
  store.write({ type: "workspace", cwd, name: "shared", description: "Workspace note", content: "W" });

  const global = store.list({ type: "global" });
  const workspace = store.list({ type: "workspace", cwd });
  assert.equal(global.length, 1);
  assert.equal(global[0].content, "G");
  assert.equal(workspace.length, 1);
  assert.equal(workspace[0].content, "W");

  assert.equal(store.get({ type: "global", name: "shared" }).description, "Global note");
  assert.equal(store.get({ type: "workspace", cwd, name: "shared" }).description, "Workspace note");
});

test("memories: the index is sorted by name and follows the exact format", async (t) => {
  const { store, home } = await makeStore(t);

  store.write({ type: "global", name: "zeta", description: "Z", content: "z" });
  store.write({ type: "global", name: "alpha", description: "A", content: "a" });
  store.write({ type: "global", name: "Mango", description: "M", content: "m" });

  const index = await readFile(join(home, "memories", "global", "MEMORY.md"), "utf8");
  assert.equal(index, "- Mango - M\n- alpha - A\n- zeta - Z\n");
});

test("memories: write rejects invalid names including MEMORY", async (t) => {
  const { store, home } = await makeStore(t);
  const invalid = [
    "",
    "a b",
    "a/b",
    "a\\b",
    "..",
    ".",
    "a.b",
    "MEMORY",
    "memory",
    "Memory",
    "中文",
    "naïve",
    "a\nb",
    "a\tb",
    null,
    42,
  ];
  for (const name of invalid) {
    assert.throws(
      () => store.write({ type: "global", name, description: "d", content: "c" }),
      (err) => err instanceof MemoryError && err.code === "INVALID_NAME",
      `expected INVALID_NAME for ${JSON.stringify(name)}`,
    );
  }
  // Nothing was written.
  await assert.rejects(readFile(join(home, "memories", "global", "a.md")), { code: "ENOENT" });
  await assert.rejects(readFile(join(home, "memories", "global", "MEMORY.md")), { code: "ENOENT" });
});

test("memories: write enforces the content character limit without truncation", async (t) => {
  const { store, home } = await makeStore(t, { maxChars: 10 });

  const ok = store.write({ type: "global", name: "ok", description: "d", content: "x".repeat(10) });
  assert.equal(ok.record.content.length, 10);

  assert.throws(
    () => store.write({ type: "global", name: "long", description: "d", content: "x".repeat(11) }),
    (err) => err instanceof MemoryError && err.code === "CONTENT_TOO_LONG",
  );
  // Rejected content is never written.
  await assert.rejects(readFile(join(home, "memories", "global", "long.md")), { code: "ENOENT" });

  // The stored content is the exact accepted input, not truncated.
  const text = await readFile(join(home, "memories", "global", "ok.md"), "utf8");
  assert.ok(text.endsWith("x".repeat(10)));

  // The default limit from the config store shape is 8000.
  const { store: defaultStore } = await makeStore(t);
  defaultStore.write({ type: "global", name: "big", description: "d", content: "y".repeat(8000) });
  assert.throws(
    () => defaultStore.write({ type: "global", name: "huge", description: "d", content: "y".repeat(8001) }),
    (err) => err instanceof MemoryError && err.code === "CONTENT_TOO_LONG",
  );
});

test("memories: write requires valid strings for description and content", async (t) => {
  const { store } = await makeStore(t);
  const cases = [
    { args: { description: null }, code: "INVALID_DESCRIPTION" },
    { args: { description: 42 }, code: "INVALID_DESCRIPTION" },
    { args: { description: "" }, code: "INVALID_DESCRIPTION" },
    { args: { description: "   " }, code: "INVALID_DESCRIPTION" },
    { args: { description: "line1\nline2" }, code: "INVALID_DESCRIPTION" },
    { args: { description: "line1\rline2" }, code: "INVALID_DESCRIPTION" },
    { args: { content: null }, code: "INVALID_CONTENT" },
    { args: { content: 42 }, code: "INVALID_CONTENT" },
    { args: { content: "" }, code: "INVALID_CONTENT" },
    { args: { content: "   " }, code: "INVALID_CONTENT" },
  ];
  for (const { args, code } of cases) {
    assert.throws(
      () => store.write({ type: "global", name: "x", description: "d", content: "c", ...args }),
      (err) => err instanceof MemoryError && err.code === code,
      `expected ${code} for ${JSON.stringify(args)}`,
    );
  }
});

test("memories: get returns the record, null for missing, and null for corrupt files", async (t) => {
  const { store, home } = await makeStore(t);

  store.write({ type: "global", name: "alpha", description: "d", content: "c" });
  const record = store.get({ type: "global", name: "alpha" });
  assert.equal(record.name, "alpha");
  assert.equal(record.content, "c");

  assert.equal(store.get({ type: "global", name: "missing" }), null);

  // A corrupt file is skipped with a warning.
  const { logger, warns } = warnLogger();
  const scanning = createMemoryStore({
    home,
    configStore: configStore(),
    logger,
  });
  await writeFile(join(home, "memories", "global", "broken.md"), "not a memory");
  assert.equal(scanning.get({ type: "global", name: "broken" }), null);
  assert.ok(warns.length >= 1);
  assert.match(warns[0], /broken/);
});

test("memories: list requires a cwd for workspace and ignores it for global", async (t) => {
  const { store } = await makeStore(t);
  store.write({ type: "global", name: "alpha", description: "d", content: "c" });

  assert.throws(
    () => store.list({ type: "workspace" }),
    (err) => err instanceof MemoryError && err.code === "MISSING_CWD",
  );

  // A stray cwd on a global query is ignored; records still carry cwd "".
  const records = store.list({ type: "global", cwd: "/irrelevant" });
  assert.equal(records.length, 1);
  assert.equal(records[0].cwd, "");
});

test("memories: workspace operations without a cwd throw MISSING_CWD", async (t) => {
  const { store } = await makeStore(t);
  const ops = [
    () => store.list({ type: "workspace" }),
    () => store.get({ type: "workspace", name: "x" }),
    () => store.write({ type: "workspace", name: "x", description: "d", content: "c" }),
    () => store.remove({ type: "workspace", name: "x", description: "d" }),
  ];
  for (const op of ops) {
    assert.throws(op, (err) => err instanceof MemoryError && err.code === "MISSING_CWD");
  }
});

test("memories: list is sorted by name and excludes forgotten files", async (t) => {
  const { store } = await makeStore(t);

  store.write({ type: "global", name: "beta", description: "B", content: "b" });
  store.write({ type: "global", name: "alpha", description: "A", content: "a" });
  store.write({ type: "global", name: "gamma", description: "G", content: "g" });
  store.remove({ type: "global", name: "beta", description: "B" });

  const records = store.list({ type: "global" });
  assert.deepEqual(
    records.map((r) => [r.name, r.description, r.content]),
    [
      ["alpha", "A", "a"],
      ["gamma", "G", "g"],
    ],
  );
});

test("memories: remove forgets only on an exact name and description match", async (t) => {
  const { store, home } = await makeStore(t, { now: () => 1_700_000_000_000 });

  store.write({ type: "global", name: "alpha", description: "First memory", content: "Hello" });

  // Wrong description: nothing happens.
  const miss = store.remove({ type: "global", name: "alpha", description: "First Memory" });
  assert.equal(miss, null);
  await assert.rejects(readFile(join(home, "memories", "global", "alpha.forgotten")), { code: "ENOENT" });
  assert.deepEqual(store.list({ type: "global" }).map((r) => r.name), ["alpha"]);

  // Exact match: renamed to `.forgotten` and removed from the index.
  const result = store.remove({ type: "global", name: "alpha", description: "First memory" });
  assert.deepEqual(result, {
    record: {
      pairId: "memory:global:global:alpha",
      recordType: "memory",
      memoryType: "global",
      type: "global",
      name: "alpha",
      description: "First memory",
      content: "Hello",
      cwd: "",
      createdAt: 1_700_000_000_000,
    },
  });

  await assert.rejects(readFile(join(home, "memories", "global", "alpha.md")), { code: "ENOENT" });
  const forgotten = await readFile(join(home, "memories", "global", "alpha.forgotten"), "utf8");
  assert.ok(forgotten.startsWith("---\n"));
  const index = await readFile(join(home, "memories", "global", "MEMORY.md"), "utf8");
  assert.equal(index, "");
  assert.equal(store.get({ type: "global", name: "alpha" }), null);
});

test("memories: remove returns null when the memory does not exist", async (t) => {
  const { store } = await makeStore(t);
  assert.equal(store.remove({ type: "global", name: "nope", description: "d" }), null);
});

test("memories: remove refuses to overwrite an existing forgotten file", async (t) => {
  const { store, home } = await makeStore(t);

  store.write({ type: "global", name: "alpha", description: "d", content: "c" });
  const dir = join(home, "memories", "global");
  await writeFile(join(dir, "alpha.forgotten"), "historical content");

  assert.throws(
    () => store.remove({ type: "global", name: "alpha", description: "d" }),
    (err) => err instanceof MemoryError && err.code === "FORGOTTEN_CONFLICT",
  );
  // The active file and the history are untouched.
  assert.ok((await stat(join(dir, "alpha.md"))).isFile());
  assert.equal(await readFile(join(dir, "alpha.forgotten"), "utf8"), "historical content");
});

test("memories: writing a new memory with the same name keeps the forgotten file", async (t) => {
  const { store, home } = await makeStore(t, { now: () => 1_700_000_000_000 });

  store.write({ type: "global", name: "alpha", description: "old", content: "old body" });
  store.remove({ type: "global", name: "alpha", description: "old" });
  await writeFile(join(home, "memories", "global", "alpha.forgotten"), "edited history");

  const result = store.write({ type: "global", name: "alpha", description: "new", content: "new body" });
  assert.equal(result.action, "created"); // the active file was gone
  assert.equal(result.record.createdAt, 1_700_000_000_000); // fresh creation time

  const forgotten = await readFile(join(home, "memories", "global", "alpha.forgotten"), "utf8");
  assert.equal(forgotten, "edited history");
  assert.equal(store.get({ type: "global", name: "alpha" }).content, "new body");
});

test("memories: forgotten files are never listed, gotten, or scanned", async (t) => {
  const { store, home } = await makeStore(t);
  const cwd = join(home, "proj");

  store.write({ type: "global", name: "alpha", description: "d", content: "c" });
  store.remove({ type: "global", name: "alpha", description: "d" });

  // A hand-made forgotten file with valid front matter is also ignored.
  const wsDir = join(home, "memories", "workspaces", workspaceSlug(cwd));
  await mkdir(wsDir, { recursive: true });
  await writeFile(
    join(wsDir, "ghost.forgotten"),
    rawMemory({ name: "ghost", description: "g", type: "workspace", cwd, content: "x" }),
  );

  assert.equal(store.get({ type: "global", name: "alpha" }), null);
  assert.deepEqual(store.list({ type: "global" }), []);
  assert.deepEqual(store.scan(), []);
  const index = await readFile(join(home, "memories", "global", "MEMORY.md"), "utf8");
  assert.equal(index, "");
});

test("memories: scan returns all active records and repairs the index", async (t) => {
  const { store, home } = await makeStore(t, { now: () => 1_700_000_000_000 });
  const cwdA = join(home, "proj-a");
  const slugA = workspaceSlug(cwdA);

  store.write({ type: "global", name: "beta", description: "B", content: "b" });
  store.write({ type: "global", name: "alpha", description: "A", content: "a" });
  store.write({ type: "workspace", cwd: cwdA, name: "note", description: "N", content: "n" });

  // Corrupt both indexes to prove scan repairs them.
  await writeFile(join(home, "memories", "global", "MEMORY.md"), "garbage");
  await writeFile(join(home, "memories", "workspaces", slugA, "MEMORY.md"), "also garbage");

  const records = store.scan();
  assert.deepEqual(
    records.map((r) => [r.type, r.name]),
    [
      ["global", "alpha"],
      ["global", "beta"],
      ["workspace", "note"],
    ],
  );

  const globalIndex = await readFile(join(home, "memories", "global", "MEMORY.md"), "utf8");
  assert.equal(globalIndex, "- alpha - A\n- beta - B\n");
  const wsIndex = await readFile(join(home, "memories", "workspaces", slugA, "MEMORY.md"), "utf8");
  assert.equal(wsIndex, "- note - N\n");
});

test("memories: scan picks up manually added, modified, and deleted files", async (t) => {
  const { store, home } = await makeStore(t, { now: () => 1_700_000_000_000 });

  store.write({ type: "global", name: "kept", description: "K", content: "k" });
  store.write({ type: "global", name: "edit", description: "E", content: "old" });
  store.write({ type: "global", name: "gone", description: "G", content: "g" });

  // Manual add: a raw valid file with matching front matter.
  await writeFile(
    join(home, "memories", "global", "manual.md"),
    rawMemory({ name: "manual", description: "M", content: "added by hand" }),
  );
  // Manual modify: change the body in place.
  await writeFile(
    join(home, "memories", "global", "edit.md"),
    rawMemory({ name: "edit", description: "E", content: "edited by hand" }),
  );
  // Manual delete.
  await rm(join(home, "memories", "global", "gone.md"));

  const records = store.scan();
  assert.deepEqual(records.map((r) => r.name), ["edit", "kept", "manual"]);
  assert.equal(records.find((r) => r.name === "edit").content, "edited by hand");
  assert.equal(records.find((r) => r.name === "manual").content, "added by hand");
  assert.equal(records.find((r) => r.name === "manual").createdAt, 1_700_000_000_000);

  // The index now reflects the directory.
  const index = await readFile(join(home, "memories", "global", "MEMORY.md"), "utf8");
  assert.equal(index, "- edit - E\n- kept - K\n- manual - M\n");
});

test("memories: scan skips invalid files with warnings and leaves forgotten files alone", async (t) => {
  const { store, home } = await makeStore(t);
  const { logger, warns } = warnLogger();
  const scanning = createMemoryStore({
    home,
    configStore: configStore(10),
    logger,
  });

  const dir = join(home, "memories", "global");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "ok.md"), rawMemory({ name: "ok", description: "O", content: "12345" }));
  await writeFile(join(dir, "bad-fence.md"), "no front matter here");
  await writeFile(join(dir, "bad-json.md"), "---\nnot json\n---\nbody");
  await writeFile(join(dir, "bad-type.md"), rawMemory({ name: "badtype", description: "T", type: "workspace", content: "x" }));
  await writeFile(join(dir, "bad-name.md"), rawMemory({ name: "other", description: "N", content: "x" }));
  await writeFile(join(dir, "too-long.md"), rawMemory({ name: "toolong", description: "L", content: "12345678901" }));
  await writeFile(
    join(dir, "empty.md"),
    `---\n${JSON.stringify({ name: "empty", description: "E", type: "global", createdAt: 1, cwd: "" })}\n---\n`,
  );
  await writeFile(join(dir, "notes.txt"), "ignored");
  const forgottenText = rawMemory({ name: "old", description: "F", content: "forgotten body" });
  await writeFile(join(dir, "old.forgotten"), forgottenText);

  const records = scanning.scan();
  assert.deepEqual(records.map((r) => r.name), ["ok"]);
  // The forgotten file is untouched.
  assert.equal(await readFile(join(dir, "old.forgotten"), "utf8"), forgottenText);
  assert.ok(warns.length >= 6, `expected at least 6 warnings, got ${warns.length}`);
  // The index only lists the valid memory.
  assert.equal(await readFile(join(dir, "MEMORY.md"), "utf8"), "- ok - O\n");
});

test("memories: scan with no memories directory returns empty", async (t) => {
  const { store } = await makeStore(t);
  assert.deepEqual(store.scan(), []);
  assert.deepEqual(store.list({ type: "global" }), []);
});

test("memories: front matter and body round-trip newlines, colons, quotes, and unicode", async (t) => {
  const { store, home } = await makeStore(t, { now: () => 1_700_000_000_000 });

  const content = 'line one\nline two: with colon "quote" and \\ backslash\n中文 🎉';
  store.write({
    type: "global",
    name: "alpha",
    description: 'summary: with "quotes" and colon',
    content,
  });

  const record = store.get({ type: "global", name: "alpha" });
  assert.equal(record.description, 'summary: with "quotes" and colon');
  assert.equal(record.content, content);

  // The body is stored verbatim after the closing fence, with the fields on
  // their own lines and JSON-quoted values.
  const text = await readFile(join(home, "memories", "global", "alpha.md"), "utf8");
  assert.equal(
    text,
    '---\nname: "alpha"\ndescription: "summary: with \\"quotes\\" and colon"\ntype: "global"\ncreatedAt: 1700000000000\ncwd: ""\n---\n' +
      content,
  );
});

test("memories: writes are atomic and leave no temp files behind", async (t) => {
  const { store, home } = await makeStore(t);

  store.write({ type: "global", name: "alpha", description: "d", content: "c" });
  store.write({ type: "global", name: "alpha", description: "d2", content: "c2" });
  store.write({ type: "global", name: "beta", description: "d", content: "c" });

  const files = (await readdir(join(home, "memories", "global"))).sort();
  assert.deepEqual(files, ["MEMORY.md", "alpha.md", "beta.md"]);
});

test("memories: pairId is stable and scoped per type and workspace", async (t) => {
  const { store, home } = await makeStore(t);
  const cwdA = join(home, "project");
  const cwdB = join(home, "other", "project"); // same basename, different parent
  const slugA = workspaceSlug(cwdA);
  const slugB = workspaceSlug(cwdB);
  assert.notEqual(slugA, slugB);

  const global = store.write({ type: "global", name: "alpha", description: "d", content: "c" });
  const wsA = store.write({ type: "workspace", cwd: cwdA, name: "alpha", description: "d", content: "c" });
  const wsB = store.write({ type: "workspace", cwd: cwdB, name: "alpha", description: "d", content: "c" });

  assert.equal(global.record.pairId, "memory:global:global:alpha");
  assert.equal(wsA.record.pairId, `memory:workspace:${slugA}:alpha`);
  assert.equal(wsB.record.pairId, `memory:workspace:${slugB}:alpha`);
  assert.equal(wsA.record.cwd, cwdA);
  assert.equal(wsB.record.cwd, cwdB);

  assert.deepEqual(store.list({ type: "global" }).map((r) => r.pairId), ["memory:global:global:alpha"]);
  assert.deepEqual(store.list({ type: "workspace", cwd: cwdA }).map((r) => r.pairId), [`memory:workspace:${slugA}:alpha`]);
  assert.deepEqual(store.list({ type: "workspace", cwd: cwdB }).map((r) => r.pairId), [`memory:workspace:${slugB}:alpha`]);
});

test("memories: scanned workspace records keep the original cwd from front matter", async (t) => {
  const { store, home } = await makeStore(t, { now: () => 1_700_000_000_000 });
  const cwd = join(home, "project");

  const written = store.write({ type: "workspace", cwd, name: "note", description: "N", content: "n" });
  const scanned = store.scan();

  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].cwd, cwd);
  assert.equal(scanned[0].pairId, written.record.pairId);
  assert.equal(scanned[0].createdAt, 1_700_000_000_000);
});

test("memories: an invalid type is rejected by every method", async (t) => {
  const { store } = await makeStore(t);
  const ops = [
    () => store.list({ type: "all" }),
    () => store.get({ type: "all", name: "x" }),
    () => store.write({ type: "all", name: "x", description: "d", content: "c" }),
    () => store.remove({ type: "all", name: "x", description: "d" }),
  ];
  for (const op of ops) {
    assert.throws(op, (err) => err instanceof MemoryError && err.code === "INVALID_TYPE");
  }
});

test("memories: the parser supports hand-written line-by-line front matter", async (t) => {
  const { store, home } = await makeStore(t);
  const dir = join(home, "memories", "global");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "lined.md"),
    [
      "---",
      'name: "lined"',
      'description: "Line by line"',
      'type: "global"',
      "createdAt: 1700000000000",
      'cwd: ""',
      "---",
      "body of lined memory",
    ].join("\n"),
  );

  const record = store.get({ type: "global", name: "lined" });
  assert.equal(record.description, "Line by line");
  assert.equal(record.content, "body of lined memory");
  assert.equal(record.createdAt, 1_700_000_000_000);

  const records = store.scan();
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "lined");
});

test("memories: the parser is backward compatible with the legacy single-line JSON front matter", async (t) => {
  const { store, home } = await makeStore(t);
  const dir = join(home, "memories", "global");
  await mkdir(dir, { recursive: true });
  const legacy =
    '---\n{"name":"legacy","description":"Old format","type":"global","createdAt":1700000000000,"cwd":""}\n---\nlegacy body';
  await writeFile(join(dir, "legacy.md"), legacy);

  const records = store.scan();
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "legacy");
  assert.equal(records[0].content, "legacy body");
  assert.equal(records[0].createdAt, 1_700_000_000_000);
  assert.equal(store.get({ type: "global", name: "legacy" }).description, "Old format");
  // The index is rebuilt from the legacy file too.
  assert.equal(await readFile(join(dir, "MEMORY.md"), "utf8"), "- legacy - Old format\n");
});

test("memories: scan and reads skip workspace files whose front matter cwd does not match the directory slug", async (t) => {
  const { store, home } = await makeStore(t);
  const cwd = join(home, "project");
  const slug = workspaceSlug(cwd);
  const wsDir = join(home, "memories", "workspaces", slug);
  await mkdir(wsDir, { recursive: true });

  // A legit memory: the stored cwd slugs to this directory.
  store.write({ type: "workspace", cwd, name: "legit", description: "L", content: "l" });

  // A tampered memory: same directory, but the cwd belongs to another
  // workspace, which would otherwise reassign it to a foreign recall scope.
  const otherCwd = join(home, "other-project");
  const otherSlug = workspaceSlug(otherCwd);
  assert.notEqual(slug, otherSlug);
  await writeFile(
    join(wsDir, "tampered.md"),
    rawMemory({ name: "tampered", description: "T", type: "workspace", cwd: otherCwd, content: "t" }),
  );

  const { logger, warns } = warnLogger();
  const scanning = createMemoryStore({ home, configStore: configStore(), logger });
  const records = scanning.scan();
  assert.deepEqual(records.map((r) => r.name), ["legit"]);
  assert.equal(records[0].cwd, cwd);
  assert.ok(
    warns.some((w) => w.includes("tampered") && w.includes("workspace directory")),
    `expected a cwd-mismatch warning, got: ${JSON.stringify(warns)}`,
  );

  // get/list refuse the tampered file as well.
  assert.equal(scanning.get({ type: "workspace", cwd, name: "tampered" }), null);
  assert.deepEqual(scanning.list({ type: "workspace", cwd }).map((r) => r.name), ["legit"]);

  // The index only lists the legit memory.
  assert.equal(await readFile(join(wsDir, "MEMORY.md"), "utf8"), "- legit - L\n");
});

test("memories: a body containing --- lines round-trips without fence confusion", async (t) => {
  const { store, home } = await makeStore(t, { now: () => 1_700_000_000_000 });

  const content = "line one\n---\nline two\n---\nline three";
  store.write({ type: "global", name: "alpha", description: "d", content });

  // The body is stored verbatim after the closing fence, including the
  // inner `---` lines (the closing fence is the first structurally valid one).
  const text = await readFile(join(home, "memories", "global", "alpha.md"), "utf8");
  assert.equal(
    text,
    '---\nname: "alpha"\ndescription: "d"\ntype: "global"\ncreatedAt: 1700000000000\ncwd: ""\n---\n' + content,
  );
  const record = store.get({ type: "global", name: "alpha" });
  assert.equal(record.content, content);
  const scanned = store.scan();
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].content, content);
});

test("memories: createMemoryStore requires a home directory", () => {
  assert.throws(
    () => createMemoryStore({ configStore: configStore() }),
    (err) => err instanceof MemoryError && err.code === "INVALID_INPUT",
  );
});
