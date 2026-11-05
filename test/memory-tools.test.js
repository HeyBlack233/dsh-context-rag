/**
 * Tests for the `memory_*` agent tools (`lib/memory-tools.js`).
 *
 * Definitions are built with the real `defineTool` from
 * `@deepseek-ai/dsh-tools` (a `peerDependency` of this package, declared also
 * as a `devDependency` so CI installs it; the DSH host resolves it for linked
 * plugins). The tests use a fake tool registry and in-memory fake memory
 * store / db / indexer so each definition's `execute` can be invoked directly,
 * without the host. A missing `@deepseek-ai/dsh-tools` fails loudly at import
 * rather than silently skipping coverage.
 *
 * @module memory-tools
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerMemoryTools } from "../lib/memory-tools.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Key for a memory record: scope + workspace + name. */
function memoryKey(type, cwd, name) {
  return `${type}\u0000${cwd ?? ""}\u0000${name}`;
}

/**
 * In-memory fake memory store implementing the `createMemoryStore` contract
 * surface used by the tools: `list`, `get`, `write`, `remove`, and `scan`.
 * Records carry `pairId`, `memoryType`, `type`, `cwd`, `name`, `description`,
 * `content`, and `createdAt`.
 *
 * @param {Array<object>} [seed] - Initial records.
 * @returns {object} Fake store plus call log.
 */
function makeMemoryStore(seed = []) {
  const memories = new Map();
  let seq = 0;
  const calls = { list: [], get: [], write: [], remove: [], scan: [] };
  for (const record of seed) {
    memories.set(memoryKey(record.type, record.cwd, record.name), { ...record });
  }
  return {
    calls,
    has(type, cwd, name) {
      return memories.has(memoryKey(type, cwd, name));
    },
    async list({ type, cwd }) {
      calls.list.push({ type, cwd });
      return [...memories.values()]
        .filter((record) => record.type === type && (type === "global" || record.cwd === cwd))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async get({ type, cwd, name }) {
      calls.get.push({ type, cwd, name });
      return memories.get(memoryKey(type, cwd, name)) ?? null;
    },
    async write({ type, cwd, name, description, content }) {
      calls.write.push({ type, cwd, name, description, content });
      const existing = memories.get(memoryKey(type, cwd, name));
      const record = {
        pairId: existing?.pairId ?? `mem-${(seq += 1)}`,
        recordType: "memory",
        memoryType: type,
        type,
        cwd: type === "global" ? "" : cwd,
        name,
        description,
        content,
        createdAt: existing?.createdAt ?? 1000 + seq,
      };
      memories.set(memoryKey(type, cwd, name), record);
      return { action: existing ? "updated" : "created", record };
    },
    async remove({ type, cwd, name, description }) {
      calls.remove.push({ type, cwd, name, description });
      const record = memories.get(memoryKey(type, cwd, name));
      if (!record || record.description !== description) return null;
      memories.delete(memoryKey(type, cwd, name));
      return { record };
    },
    async scan() {
      calls.scan.push({});
      return [...memories.values()];
    },
  };
}

/** Fake index database recording `upsertMemory` / `deletePair` calls. */
function makeDb({ deletePairResult = true } = {}) {
  const upserts = [];
  const deletes = [];
  return {
    upserts,
    deletes,
    upsertMemory(record) {
      upserts.push(record);
    },
    deletePair(pairId) {
      deletes.push(pairId);
      return deletePairResult;
    },
  };
}

/** Fake background indexer counting `wake()` calls. */
function makeIndexer() {
  const wakes = [];
  return { wakes, wake() { wakes.push(1); } };
}

/** Fake tools registry capturing registered definitions. */
function makeTools() {
  const definitions = [];
  return {
    definitions,
    register(definition) {
      definitions.push(definition);
      return () => {};
    },
    byName(name) {
      return definitions.find((definition) => definition.name === name);
    },
  };
}

/** Register the memory tools on a fake registry and return it. */
function registerTools(deps) {
  const registry = makeTools();
  // The host hands `registerMemoryTools` a ctx whose `tools` service is the
  // registry; mirror that shape so the definitions' `execute` can be invoked.
  assert.equal(registerMemoryTools({ tools: registry }, deps), 4, "four tools must be registered");
  return registry;
}

/** Build a default dependency bag with optional overrides (explicit null kept). */
function makeDeps(overrides = {}) {
  const pick = (key, fallback) => (Object.hasOwn(overrides, key) ? overrides[key] : fallback);
  return {
    memoryStore: pick("memoryStore", makeMemoryStore()),
    db: pick("db", makeDb()),
    indexer: pick("indexer", makeIndexer()),
    configStore: pick("configStore", null),
  };
}

/** Fake execution context for a session whose working directory is `cwd`. */
function execFor(cwd) {
  return {
    agent: { session: { header: { cwd } } },
    signal: new AbortController().signal,
  };
}

/** Fake execution context without an agent. */
function execWithoutAgent() {
  return { signal: new AbortController().signal };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

  test("registerMemoryTools fails clearly without a tools service or a memory store", () => {
    const deps = makeDeps();
    assert.throws(
      () => registerMemoryTools({}, deps),
      /tools service/,
      "a ctx without ctx.tools.register must be rejected",
    );
    assert.throws(
      () => registerMemoryTools({ tools: { register() {} } }, { ...deps, memoryStore: null }),
      /memoryStore/,
      "a missing memoryStore must be rejected",
    );
  });

  // -------------------------------------------------------------------------
  // No agent / no working directory
  // -------------------------------------------------------------------------

  test("all four tools fail clearly without an agent session", async () => {
    const tools = registerTools(makeDeps());
    const cases = [
      ["memory_list", { type: "global" }],
      ["memory_get", { type: "global", name: "alpha" }],
      ["memory_write", { type: "global", name: "alpha", description: "d", content: "c" }],
      ["memory_forget", { type: "global", name: "alpha", description: "d" }],
    ];
    for (const [name, args] of cases) {
      await assert.rejects(tools.byName(name).execute(args, execWithoutAgent()), /requires an agent Session/);
    }
  });

  test("workspace tools fail clearly when the session has no working directory", async () => {
    const tools = registerTools(makeDeps());
    const exec = { agent: { session: { header: {} } }, signal: new AbortController().signal };
    await assert.rejects(tools.byName("memory_list").execute({ type: "workspace" }, exec), /header\.cwd/);
    await assert.rejects(
      tools.byName("memory_write").execute({ type: "workspace", name: "a", description: "d", content: "c" }, exec),
      /header\.cwd/,
    );
  });

  test("global tools work without a session cwd", async () => {
    const memoryStore = makeMemoryStore([
      { pairId: "g1", type: "global", cwd: "", name: "alpha", description: "global alpha", content: "GA" },
    ]);
    const tools = registerTools(makeDeps({ memoryStore }));
    const exec = { agent: { session: { header: {} } }, signal: new AbortController().signal };
    const out = await tools.byName("memory_list").execute({ type: "global" }, exec);
    assert.equal(out.count, 1);
    assert.deepEqual(out.memories, [{ name: "alpha", description: "global alpha" }]);
  });

  // -------------------------------------------------------------------------
  // memory_list
  // -------------------------------------------------------------------------

  test("memory_list returns the name+description index for the requested scope, without content", async () => {
    const memoryStore = makeMemoryStore([
      { pairId: "g1", type: "global", cwd: "", name: "zeta", description: "global zeta", content: "GZ-SECRET" },
      { pairId: "g2", type: "global", cwd: "", name: "alpha", description: "global alpha", content: "GA-SECRET" },
      { pairId: "w1", type: "workspace", cwd: "/tmp/a", name: "beta", description: "workspace beta", content: "WB-SECRET" },
      { pairId: "w2", type: "workspace", cwd: "/tmp/b", name: "gamma", description: "workspace gamma", content: "WG-SECRET" },
    ]);
    const tools = registerTools(makeDeps({ memoryStore }));
    const list = tools.byName("memory_list");

    const globalOut = await list.execute({ type: "global" }, execFor("/tmp/a"));
    assert.equal(globalOut.type, "global");
    assert.equal(globalOut.cwd, undefined);
    assert.equal(globalOut.count, 2);
    assert.deepEqual(globalOut.memories, [
      { name: "alpha", description: "global alpha" },
      { name: "zeta", description: "global zeta" },
    ]);

    const workspaceA = await list.execute({ type: "workspace" }, execFor("/tmp/a"));
    assert.equal(workspaceA.cwd, "/tmp/a");
    assert.deepEqual(workspaceA.memories, [{ name: "beta", description: "workspace beta" }]);

    const workspaceB = await list.execute({ type: "workspace" }, execFor("/tmp/b"));
    assert.deepEqual(workspaceB.memories, [{ name: "gamma", description: "workspace gamma" }]);

    // The index never carries content, and the serialized output never leaks it.
    for (const memory of [...globalOut.memories, ...workspaceA.memories, ...workspaceB.memories]) {
      assert.deepEqual(Object.keys(memory).sort(), ["description", "name"]);
    }
    for (const secret of ["GZ-SECRET", "GA-SECRET", "WB-SECRET", "WG-SECRET"]) {
      assert.equal(JSON.stringify(globalOut).includes(secret), false);
      assert.equal(JSON.stringify(workspaceA).includes(secret), false);
      assert.equal(JSON.stringify(workspaceB).includes(secret), false);
    }

    // The store was asked for exactly the session's cwd (never a caller value).
    assert.deepEqual(memoryStore.calls.list.map((call) => call.cwd), [undefined, "/tmp/a", "/tmp/b"]);
  });

  test("memory_list renders an empty directory and never shows content", async () => {
    const memoryStore = makeMemoryStore([
      { pairId: "g1", type: "global", cwd: "", name: "alpha", description: "global alpha", content: "GA-SECRET" },
    ]);
    const tools = registerTools(makeDeps({ memoryStore }));
    const list = tools.byName("memory_list");

    const empty = await list.execute({ type: "workspace" }, execFor("/tmp/nope"));
    assert.equal(empty.count, 0);
    assert.ok(list.output.render({}, empty)[0].text.includes("No memories"));

    const full = await list.execute({ type: "global" }, execFor("/tmp/nope"));
    assert.equal(list.output.render({}, full)[0].text.includes("GA-SECRET"), false);
    assert.ok(list.output.render({}, full)[0].text.includes("global alpha"));
  });

  // -------------------------------------------------------------------------
  // memory_get
  // -------------------------------------------------------------------------

  test("memory_get returns content plus name/description/type and fails on a missing memory", async () => {
    const memoryStore = makeMemoryStore([
      { pairId: "g1", type: "global", cwd: "", name: "alpha", description: "global alpha", content: "GA content" },
      { pairId: "w1", type: "workspace", cwd: "/tmp/a", name: "beta", description: "workspace beta", content: "WB content" },
    ]);
    const tools = registerTools(makeDeps({ memoryStore }));
    const get = tools.byName("memory_get");

    const globalOut = await get.execute({ type: "global", name: "alpha" }, execFor("/tmp/a"));
    assert.deepEqual(globalOut, { type: "global", name: "alpha", description: "global alpha", content: "GA content" });

    const workspaceOut = await get.execute({ type: "workspace", name: "beta" }, execFor("/tmp/a"));
    assert.equal(workspaceOut.content, "WB content");
    assert.equal(workspaceOut.type, "workspace");

    // The store was asked for the session's cwd for workspace scope.
    assert.equal(memoryStore.calls.get[1].cwd, "/tmp/a");

    // Wrong scope / missing name are clear failures.
    await assert.rejects(get.execute({ type: "workspace", name: "beta" }, execFor("/tmp/b")), /no memory named "beta"/);
    await assert.rejects(get.execute({ type: "global", name: "nope" }, execFor("/tmp/a")), /no memory named "nope"/);
  });

  // -------------------------------------------------------------------------
  // memory_write
  // -------------------------------------------------------------------------

  test("memory_write creates, upserts into the index, and wakes the indexer without returning content", async () => {
    const memoryStore = makeMemoryStore();
    const db = makeDb();
    const indexer = makeIndexer();
    const tools = registerTools(makeDeps({ memoryStore, db, indexer }));
    const write = tools.byName("memory_write");

    const out = await write.execute(
      { type: "global", name: "project_notes", description: "Project conventions", content: "Use tabs." },
      execFor("/tmp/a"),
    );
    assert.deepEqual(out, { action: "created", type: "global", name: "project_notes", queued: true });
    assert.equal("content" in out, false);
    assert.equal(JSON.stringify(out).includes("Use tabs."), false);

    // The store write happened with no cwd for global scope.
    assert.equal(memoryStore.calls.write.length, 1);
    assert.equal(memoryStore.calls.write[0].cwd, undefined);

    // The record was upserted into the index and the indexer was woken once.
    assert.equal(db.upserts.length, 1);
    assert.equal(db.upserts[0].name, "project_notes");
    assert.equal(db.upserts[0].description, "Project conventions");
    assert.equal(db.upserts[0].content, "Use tabs.");
    assert.equal(db.upserts[0].pairId, "mem-1");
    assert.equal(indexer.wakes.length, 1);

    // The render never leaks content.
    const text = write.output.render({}, out)[0].text;
    assert.equal(text.includes("Use tabs."), false);
    assert.ok(text.includes("created"));

    // Writing the same name again updates the same entry.
    const again = await write.execute(
      { type: "global", name: "project_notes", description: "Project conventions", content: "Use spaces." },
      execFor("/tmp/a"),
    );
    assert.equal(again.action, "updated");
    assert.equal(db.upserts.length, 2);
    assert.equal(db.upserts[1].pairId, db.upserts[0].pairId, "the same pair id must be reused on update");
  });

  test("memory_write for workspace scope passes the session cwd to the store", async () => {
    const memoryStore = makeMemoryStore();
    const tools = registerTools(makeDeps({ memoryStore }));
    await tools.byName("memory_write").execute(
      { type: "workspace", name: "local_note", description: "Local note", content: "Only here" },
      execFor("/tmp/a"),
    );
    assert.equal(memoryStore.calls.write[0].cwd, "/tmp/a");
  });

  test("memory_write rejects invalid names and missing db/indexer without writing", async () => {
    const memoryStore = makeMemoryStore();
    const args = { type: "global", name: "bad name!", description: "d", content: "c" };

    // Invalid name charset is rejected before any store write.
    const tools = registerTools(makeDeps({ memoryStore }));
    await assert.rejects(tools.byName("memory_write").execute(args, execFor("/tmp/a")), /invalid memory name/);
    assert.equal(memoryStore.calls.write.length, 0);

    // db unavailable -> clear failure, no file write.
    const toolsNoDb = registerTools(makeDeps({ memoryStore, db: null }));
    await assert.rejects(
      toolsNoDb.byName("memory_write").execute(
        { type: "global", name: "alpha", description: "d", content: "c" },
        execFor("/tmp/a"),
      ),
      /index database is not open/,
    );
    assert.equal(memoryStore.calls.write.length, 0);

    // indexer unavailable -> clear failure, no file write.
    const toolsNoIndexer = registerTools(makeDeps({ memoryStore, indexer: null }));
    await assert.rejects(
      toolsNoIndexer.byName("memory_write").execute(
        { type: "global", name: "alpha", description: "d", content: "c" },
        execFor("/tmp/a"),
      ),
      /indexer is not running/,
    );
    assert.equal(memoryStore.calls.write.length, 0);
  });

  // -------------------------------------------------------------------------
  // memory_forget
  // -------------------------------------------------------------------------

  test("memory_forget deletes only on exact name+description match and removes the index vector", async () => {
    const memoryStore = makeMemoryStore([
      { pairId: "w1", type: "workspace", cwd: "/tmp/a", name: "beta", description: "workspace beta", content: "WB-SECRET" },
    ]);
    const db = makeDb();
    const tools = registerTools(makeDeps({ memoryStore, db }));
    const forget = tools.byName("memory_forget");

    // Description mismatch -> not removed, nothing deleted.
    const mismatch = await forget.execute({ type: "workspace", name: "beta", description: "different" }, execFor("/tmp/a"));
    assert.deepEqual(mismatch, { removed: false, type: "workspace", name: "beta" });
    assert.equal(db.deletes.length, 0);
    assert.ok(memoryStore.has("workspace", "/tmp/a", "beta"));

    // Missing name -> not removed, nothing deleted.
    const missing = await forget.execute({ type: "workspace", name: "nope", description: "workspace beta" }, execFor("/tmp/a"));
    assert.equal(missing.removed, false);
    assert.equal(db.deletes.length, 0);

    // Exact match -> removed and deleted from the index by pair id.
    const removed = await forget.execute({ type: "workspace", name: "beta", description: "workspace beta" }, execFor("/tmp/a"));
    assert.deepEqual(removed, { removed: true, type: "workspace", name: "beta" });
    assert.deepEqual(db.deletes, ["w1"]);
    assert.equal(memoryStore.has("workspace", "/tmp/a", "beta"), false);

    // Renders for both outcomes never show content.
    assert.equal(forget.output.render({}, removed)[0].text.includes("WB-SECRET"), false);
    assert.equal(forget.output.render({}, mismatch)[0].text.includes("WB-SECRET"), false);
    assert.ok(forget.output.render({}, mismatch)[0].text.includes("nothing was deleted"));
  });

  test("memory_forget fails clearly when the index database is unavailable", async () => {
    const memoryStore = makeMemoryStore();
    const tools = registerTools(makeDeps({ memoryStore, db: null }));
    await assert.rejects(
      tools.byName("memory_forget").execute({ type: "global", name: "alpha", description: "d" }, execFor("/tmp/a")),
      /index database is not open/,
    );
    assert.equal(memoryStore.calls.remove.length, 0);
  });

  // -------------------------------------------------------------------------
  // cwd isolation
  // -------------------------------------------------------------------------

  test("workspace memories are isolated by session cwd across all tools", async () => {
    const memoryStore = makeMemoryStore();
    const db = makeDb();
    const tools = registerTools(makeDeps({ memoryStore, db }));

    // Write into /tmp/a.
    await tools.byName("memory_write").execute(
      { type: "workspace", name: "alpha", description: "about alpha", content: "secret" },
      execFor("/tmp/a"),
    );
    assert.equal(memoryStore.calls.write[0].cwd, "/tmp/a");

    // /tmp/b cannot list it...
    const listB = await tools.byName("memory_list").execute({ type: "workspace" }, execFor("/tmp/b"));
    assert.equal(listB.count, 0);
    assert.deepEqual(listB.memories, []);

    // ...cannot read it...
    await assert.rejects(
      tools.byName("memory_get").execute({ type: "workspace", name: "alpha" }, execFor("/tmp/b")),
      /no memory named "alpha"/,
    );

    // ...and cannot forget it (nothing is deleted from the index).
    const forgetB = await tools.byName("memory_forget").execute(
      { type: "workspace", name: "alpha", description: "about alpha" },
      execFor("/tmp/b"),
    );
    assert.equal(forgetB.removed, false);
    assert.equal(db.deletes.length, 0);
    assert.ok(memoryStore.has("workspace", "/tmp/a", "alpha"));

    // The owning workspace still sees it.
    const listA = await tools.byName("memory_list").execute({ type: "workspace" }, execFor("/tmp/a"));
    assert.deepEqual(listA.memories, [{ name: "alpha", description: "about alpha" }]);
  });

  // -------------------------------------------------------------------------
  // Schemas
  // -------------------------------------------------------------------------

  test("tool schemas are simple, accurate, and closed (additionalProperties false)", () => {
    const tools = registerTools(makeDeps());
    const all = ["memory_list", "memory_get", "memory_write", "memory_forget"];

    for (const name of all) {
      const def = tools.byName(name);
      // type parameter: enum global/workspace, required.
      assert.deepEqual(def.parameters.properties.type.enum, ["global", "workspace"], `${name}: type enum`);
      assert.ok(def.parameters.required.includes("type"), `${name}: type must be required`);
      // No caller-supplied cwd parameter on any tool.
      assert.equal(def.parameters.properties.cwd, undefined, `${name}: no cwd parameter`);
      // Output root is a closed object.
      assert.equal(def.output.schema.type, "object");
      assert.equal(def.output.schema.additionalProperties, false, `${name}: output must be closed`);
    }

    // Per-tool required parameters.
    assert.deepEqual(tools.byName("memory_list").parameters.required, ["type"]);
    assert.deepEqual(tools.byName("memory_get").parameters.required.sort(), ["name", "type"]);
    assert.deepEqual(tools.byName("memory_write").parameters.required.sort(), ["content", "description", "name", "type"]);
    assert.deepEqual(tools.byName("memory_forget").parameters.required.sort(), ["description", "name", "type"]);
  });

  test("list and write output schemas never expose content; get does", () => {
    const tools = registerTools(makeDeps());

    const list = tools.byName("memory_list").output.schema;
    assert.equal(list.properties.content, undefined);
    assert.deepEqual(Object.keys(list.properties.memories.items.properties).sort(), ["description", "name"]);

    const write = tools.byName("memory_write").output.schema;
    assert.equal(write.properties.content, undefined);
    assert.deepEqual(write.properties.action.enum, ["created", "updated"]);
    assert.equal(write.properties.queued.type, "boolean");

    const forget = tools.byName("memory_forget").output.schema;
    assert.equal(forget.properties.content, undefined);
    assert.equal(forget.properties.removed.type, "boolean");

    const get = tools.byName("memory_get").output.schema;
    assert.equal(get.properties.content.type, "string");
  });

  test("tool descriptions encode the write/forget usage rules", () => {
    const tools = registerTools(makeDeps());

    const write = tools.byName("memory_write").description;
    assert.ok(write.includes("memory_list"), "write must require listing the directory first");
    assert.ok(/explicitly asks/.test(write), "write must mention an explicit user request");
    assert.ok(/worth recalling|valuable/.test(write), "write must mention agent-judged long-term value");
    assert.ok(write.includes("overwrite"), "write must mention overwriting same-topic memories");
    assert.ok(/English/.test(write), "write must require English name/description");
    assert.ok(/300/.test(write), "write must suggest the content length limit");
    assert.ok(/hyphens/.test(write), "write must state the name charset");

    const forget = tools.byName("memory_forget").description;
    assert.ok(/ONLY when the user explicitly asks/.test(forget), "forget must require an explicit user request");
    assert.ok(/exactly match/.test(forget), "forget must require exact name+description match");
  });

  // -------------------------------------------------------------------------
  // Argument validation (real defineTool wrapper)
  // -------------------------------------------------------------------------

  test("invalid argument values are rejected before execute runs", async () => {
    const memoryStore = makeMemoryStore();
    const tools = registerTools(makeDeps({ memoryStore }));
    const list = tools.byName("memory_list");

    await assert.rejects(list.execute({ type: "cluster" }, execFor("/tmp/a")), /invalid arguments/);
    await assert.rejects(list.execute({}, execFor("/tmp/a")), /missing required property "type"/);
    assert.equal(memoryStore.calls.list.length, 0);
  });

  // -------------------------------------------------------------------------
  // Render content-leak matrix
  // -------------------------------------------------------------------------

  test("renders: list/write/forget never show content; get does", async () => {
    const memoryStore = makeMemoryStore([
      { pairId: "g1", type: "global", cwd: "", name: "alpha", description: "global alpha", content: "SECRET-GA" },
    ]);
    const tools = registerTools(makeDeps({ memoryStore }));
    const exec = execFor("/tmp/a");

    const listOut = await tools.byName("memory_list").execute({ type: "global" }, exec);
    assert.equal(tools.byName("memory_list").output.render({}, listOut)[0].text.includes("SECRET-GA"), false);

    const writeOut = await tools.byName("memory_write").execute(
      { type: "global", name: "beta", description: "beta desc", content: "SECRET-WB" },
      exec,
    );
    assert.equal(tools.byName("memory_write").output.render({}, writeOut)[0].text.includes("SECRET-WB"), false);

    const forgetOut = await tools.byName("memory_forget").execute(
      { type: "global", name: "beta", description: "beta desc" },
      exec,
    );
    assert.equal(tools.byName("memory_forget").output.render({}, forgetOut)[0].text.includes("SECRET-WB"), false);

    const getOut = await tools.byName("memory_get").execute({ type: "global", name: "alpha" }, exec);
    assert.equal(tools.byName("memory_get").output.render({}, getOut)[0].text.includes("SECRET-GA"), true);
  });
