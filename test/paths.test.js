/**
 * Tests for the path and identifier helpers in `lib/paths.js`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { access, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureDir,
  formatDate,
  pairFilePath,
  pairId,
  sessionSlug,
  shortSessionId,
  slugify,
  textHash,
  workspaceSlug,
} from "../lib/paths.js";
import { cleanupTempDir, makeTempDir } from "./helpers/tmp.js";

test("paths: slugify replaces disallowed characters and collapses hyphens", () => {
  assert.equal(slugify("Hello, World!"), "Hello-World");
  assert.equal(slugify("a/b\\c d"), "a-b-c-d");
  assert.equal(slugify("--a---b--"), "a-b");
  assert.equal(slugify("a  b\tc"), "a-b-c");
  // Dots, underscores and hyphens are allowed.
  assert.equal(slugify("keep.dots_and-dashes"), "keep.dots_and-dashes");
});

test("paths: slugify caps the length and returns the fallback when empty", () => {
  assert.equal(slugify("x".repeat(500)).length, 120);
  assert.equal(slugify("!!!", "fallback name"), "fallback-name");
  assert.equal(slugify("", "fallback"), "fallback");
  assert.equal(slugify("!!!", ""), "");
  assert.equal(slugify("   "), "");
});

test("paths: slugify rejects traversal segments", () => {
  // A bare `..` (or any all-dots value) must not survive sanitization.
  assert.equal(slugify(".."), "");
  assert.equal(slugify("."), "");
  assert.equal(slugify("..", "safe"), "safe");
  assert.equal(slugify("a..b"), "a..b"); // embedded dots are fine
});

test("paths: sessionSlug sanitizes and never yields a traversal segment", () => {
  assert.equal(sessionSlug("session-abc"), "session-abc");
  assert.equal(sessionSlug("a b/c\\d"), "a-b-c-d");
  assert.equal(sessionSlug(".."), "session");
  assert.equal(sessionSlug("../../etc/passwd"), "..-..-etc-passwd");
  const slug = sessionSlug("../../etc/passwd");
  assert.ok(!slug.includes("/"));
  assert.ok(!slug.includes("\\"));
  assert.notEqual(slug, "..");
});

test("paths: sessionSlug truncates long ids at 120 chars with a hash suffix", () => {
  const long = "x".repeat(200);
  const slug = sessionSlug(long);
  assert.equal(slug.length, 120);
  assert.match(slug, /^x{111}-[0-9a-f]{8}$/);
  // Different long ids keep different (stable) hash suffixes.
  const other = sessionSlug(`${long}a`);
  assert.notEqual(slug, other);
  assert.match(other, /^x{111}-[0-9a-f]{8}$/);
  // Ids that already fit are returned unchanged.
  const exact = "y".repeat(120);
  assert.equal(sessionSlug(exact), exact);
});

test("paths: workspaceSlug is stable, readable, and deterministic", () => {
  const cwd = "/home/user/My Project (dev)";
  const slug = workspaceSlug(cwd);
  assert.match(slug, /^My-Project-dev-[0-9a-f]{8}$/);
  assert.equal(workspaceSlug(cwd), slug); // stable
  assert.notEqual(workspaceSlug("/home/user/Other Project"), slug);
  // Empty/undefined/null cwd values hash deterministically.
  const empty = workspaceSlug("");
  assert.equal(empty, workspaceSlug(undefined));
  assert.equal(empty, workspaceSlug(null));
  assert.match(empty, /^workspace-[0-9a-f]{8}$/);
  // A root directory has no basename and falls back too.
  assert.match(workspaceSlug("/"), /^workspace-[0-9a-f]{8}$/);
});

test("paths: pairId is a stable 32-char hex of the canonical inputs", () => {
  const args = {
    sessionId: "session-1",
    turn: 3,
    userMessageIds: ["u1", "u2"],
    assistantMessageId: "a1",
  };
  const id = pairId(args);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(pairId(args), id); // stable
  assert.notEqual(pairId({ ...args, turn: 4 }), id);
  assert.notEqual(pairId({ ...args, userMessageIds: ["u1"] }), id);
  assert.notEqual(pairId({ ...args, assistantMessageId: "a2" }), id);
});

test("paths: pairFilePath lays out home/pairs/<workspace>/<session>.jsonl", () => {
  const file = pairFilePath({ home: "/home/dsh", cwd: "/work/proj", sessionId: "sess-1" });
  assert.equal(file, join("/home/dsh", "pairs", workspaceSlug("/work/proj"), "sess-1.jsonl"));
  assert.ok(file.startsWith(join("/home/dsh", "pairs")));
  assert.ok(file.endsWith(".jsonl"));
});

test("paths: pairFilePath stays under home/pairs for hostile inputs", () => {
  const home = "/home/dsh";
  const file = pairFilePath({ home, cwd: "..", sessionId: "../../etc/passwd" });
  assert.ok(file.startsWith(join(home, "pairs")));
  assert.ok(!file.includes("/../"));
  assert.ok(!file.includes("\\"));
  // The segment count is exactly home + pairs + workspace + session file.
  const rest = file.slice(home.length + 1).split("/");
  assert.equal(rest.length, 3);
  assert.equal(rest[0], "pairs");
  assert.notEqual(rest[2], "..");
});

test("paths: textHash matches known sha256 vectors", () => {
  assert.equal(
    textHash("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    textHash(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  // The shape `lib/db.js` relies on: hash of user\0assistant, 64 hex chars.
  const dbHash = textHash("What is the build command?\u0000Run `npm run build`.");
  assert.match(dbHash, /^[0-9a-f]{64}$/);
  assert.equal(textHash("What is the build command?\u0000Run `npm run build`."), dbHash);
});

test("paths: shortSessionId keeps the last 8 characters", () => {
  assert.equal(shortSessionId("0123456789abcdef"), "89abcdef");
  assert.equal(shortSessionId("abc"), "abc");
  assert.equal(shortSessionId(""), "");
});

test("paths: formatDate produces local YYYY-MM-DD HH:mm", () => {
  const ms = new Date(2024, 0, 15, 8, 30, 45).getTime(); // local time
  const out = formatDate(ms);
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(out, "2024-01-15 08:30");
  const parsed = new Date(ms);
  assert.equal(out.slice(0, 4), String(parsed.getFullYear()).padStart(4, "0"));
  assert.equal(out.slice(5, 7), String(parsed.getMonth() + 1).padStart(2, "0"));
  assert.equal(out.slice(8, 10), String(parsed.getDate()).padStart(2, "0"));
  assert.equal(out.slice(11, 13), String(parsed.getHours()).padStart(2, "0"));
  assert.equal(out.slice(14, 16), String(parsed.getMinutes()).padStart(2, "0"));
});

test("paths: ensureDir creates nested directories idempotently", async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const target = join(dir, "a", "b", "c");
  await ensureDir(target);
  const first = await stat(target);
  assert.ok(first.isDirectory());
  await ensureDir(target); // must not throw
  const second = await stat(target);
  assert.ok(second.isDirectory());
});

test("paths: makeTempDir/cleanupTempDir manage a temp directory", async () => {
  const dir = await makeTempDir("dsh-rag-tmp-");
  const file = join(dir, "x.txt");
  await writeFile(file, "hi");
  await cleanupTempDir(dir);
  await assert.rejects(access(dir), { code: "ENOENT" });
  // Tolerates already-missing and empty paths.
  await cleanupTempDir(dir);
  await cleanupTempDir("");
  await cleanupTempDir(undefined);
});
