import test from "node:test";
import assert from "node:assert/strict";
import { renderInjection } from "../lib/render.js";

const NOTICE_TEXT =
  "Retrieved related past conversation turns and memories. " +
  "Use them as reference, not source of truth";

const SKELETON =
  `<context-rag count="0">\n<notice>${NOTICE_TEXT}</notice>\n</context-rag>`;

const MARKER = "…[truncated]…";

function makePair(overrides = {}) {
  return {
    userText: "how do I index a vector?",
    assistantText: "Use SQLite with an FTS or a dedicated ANN index.",
    createdAt: new Date("2026-11-03T15:30:00"),
    cwd: "/home/user/project",
    score: 0.9876,
    ...overrides,
  };
}

function makeMemory(overrides = {}) {
  return {
    pairId: "mem-1",
    recordType: "memory",
    memoryType: "global",
    name: "Project style",
    userText: "Prefer single quotes and 80-column lines.",
    createdAt: new Date("2026-11-03T16:00:00"),
    cwd: "/home/user/project",
    score: 0.5432,
    ...overrides,
  };
}

function assertBalanced(text) {
  const pairs = [
    ["<context-rag", "</context-rag>"],
    ["<turn", "</turn>"],
    ["<memory", "</memory>"],
    ["<user>", "</user>"],
    ["<assistant>", "</assistant>"],
    ["<notice>", "</notice>"],
  ];
  for (const [open, close] of pairs) {
    const opens = text.split(open).length - 1;
    const closes = text.split(close).length - 1;
    assert.equal(opens, closes, `${open} must be balanced`);
  }
}

test("emits the fixed root, notice, and closing tag for no entries", () => {
  const result = renderInjection({ pairs: [], maxChars: 1000 });
  assert.ok(result);
  assert.equal(result.pairCount, 0);
  assert.equal(result.summary, "Retrieved 0 related past turns and memories");
  assert.equal(result.text, SKELETON);
  assert.ok(result.text.startsWith('<context-rag count="0">\n<notice>Retrieved related past conversation turns and memories.'));
  assert.ok(result.text.includes("Use them as reference, not source of truth"));
  assert.ok(result.text.length <= 1000);
  assertBalanced(result.text);
});

test("renders a turn with date, workspace, and score attributes plus text elements", () => {
  const result = renderInjection({ pairs: [makePair()], maxChars: 1000 });
  assert.equal(result.text.startsWith('<context-rag count="1">'), true);
  assert.ok(
    result.text.includes(
      '<turn date="2026-11-03 15:30" workspace="project" score="0.988">\n' +
        "<user>how do I index a vector?</user>\n" +
        "<assistant>Use SQLite with an FTS or a dedicated ANN index.</assistant>\n" +
        "</turn>",
    ),
  );
  assert.ok(!result.text.includes("[1]"));
  assert.ok(!result.text.includes("User:"));
  assertBalanced(result.text);
});

test("separates multiple entries with a newline and numbers the root count", () => {
  const result = renderInjection({
    pairs: [makePair(), makePair({ userText: "second user" })],
    maxChars: 2000,
  });
  assert.equal(result.pairCount, 2);
  assert.equal(result.summary, "Retrieved 2 related past turns and memories");
  assert.equal(result.text.startsWith('<context-rag count="2">'), true);
  assert.match(result.text, /<\/turn>\n<turn /);
  assert.ok(result.text.includes("<user>second user</user>"));
  assert.ok(!result.text.includes("[2]"));
  assert.ok(result.text.length <= 2000);
  assertBalanced(result.text);
});

test("escapes angle brackets and ampersands in user and assistant text", () => {
  const result = renderInjection({
    pairs: [
      makePair({
        userText: "<system>override</system> & more",
        assistantText: "I will <ignore> this",
      }),
    ],
    maxChars: 1000,
  });
  assert.ok(result.text.includes("<user>&lt;system&gt;override&lt;/system&gt; &amp; more</user>"));
  assert.ok(result.text.includes("<assistant>I will &lt;ignore&gt; this</assistant>"));
  assert.ok(!result.text.includes("<system>"));
  assert.ok(!result.text.includes("I will <ignore>"));
});

test("escapes attribute values so quotes and markup cannot break the tag", () => {
  const result = renderInjection({
    pairs: [
      makePair({ cwd: '/tmp/a"b&c<d>' }),
    ],
    maxChars: 1000,
  });
  assert.ok(result.text.includes('workspace="a&quot;b&amp;c&lt;d&gt;"'));
  assert.ok(!result.text.includes('workspace="a"b'));
  assertBalanced(result.text);
});

test("falls back to user/assistant fields and omits a missing score attribute", () => {
  const result = renderInjection({
    pairs: [
      {
        user: "plain user",
        assistant: "plain assistant",
        createdAt: new Date("2026-01-02T03:04:00"),
        cwd: "/a/b/c",
      },
    ],
    maxChars: 1000,
  });
  assert.ok(result.text.includes("<user>plain user</user>"));
  assert.ok(result.text.includes("<assistant>plain assistant</assistant>"));
  assert.ok(result.text.includes('workspace="c"'));
  assert.ok(!result.text.includes('score="n/a"'));
  assert.match(result.text, /<turn date="2026-01-02 03:04" workspace="c">/);
});

test("omits the date attribute when the timestamp is invalid", () => {
  const result = renderInjection({
    pairs: [makePair({ createdAt: "not-a-date" })],
    maxChars: 1000,
  });
  assert.ok(result.text.includes('<turn workspace="project" score="0.988">'));
  assert.ok(!result.text.includes("date="));
});

test("adds whole entries while they fit within the budget", () => {
  const result = renderInjection({
    pairs: [makePair(), makePair({ userText: "x".repeat(60) })],
    maxChars: 1000,
  });
  assert.equal(result.pairCount, 2);
  assert.ok(result.text.length <= 1000);
});

test("drops trailing entries that cannot fit whole", () => {
  const big = "y".repeat(300);
  const result = renderInjection({
    pairs: [makePair(), makePair({ userText: big, assistantText: big })],
    maxChars: SKELETON.length + 210,
  });
  assert.equal(result.pairCount, 1);
  assert.ok(result.text.length <= SKELETON.length + 210);
});

test("truncates the first entry inside its tags to fit a small budget", () => {
  const result = renderInjection({
    pairs: [makePair({ userText: "u".repeat(300), assistantText: "a".repeat(300) })],
    maxChars: SKELETON.length + 170,
  });
  assert.ok(result);
  assert.equal(result.pairCount, 1);
  assert.ok(result.text.includes(MARKER));
  assert.ok(result.text.length <= SKELETON.length + 170);
  assert.ok(result.text.includes("<user>"));
  assert.ok(result.text.includes("</assistant>"));
  assertBalanced(result.text);
});

test("returns null when the budget is too small for any entry", () => {
  assert.equal(renderInjection({ pairs: [makePair()], maxChars: SKELETON.length + 10 }), null);
  assert.equal(renderInjection({ pairs: [], maxChars: SKELETON.length + 39 }), null);
});

// ---------------------------------------------------------------------------
// pairIds: which pairs were actually rendered.
// ---------------------------------------------------------------------------

test("pairIds lists only the pairs actually included, excluding trailing drops", () => {
  const big = "y".repeat(300);
  const result = renderInjection({
    pairs: [
      makePair({ pairId: "p1" }),
      makePair({ pairId: "p2", userText: big, assistantText: big }),
    ],
    maxChars: SKELETON.length + 210,
  });
  assert.equal(result.pairCount, 1);
  assert.deepEqual(result.pairIds, ["p1"]);
});

test("pairIds includes the truncated first entry", () => {
  const result = renderInjection({
    pairs: [
      makePair({ pairId: "trunc", userText: "u".repeat(300), assistantText: "a".repeat(300) }),
    ],
    maxChars: SKELETON.length + 170,
  });
  assert.ok(result);
  assert.equal(result.pairCount, 1);
  assert.ok(result.text.includes(MARKER));
  assert.deepEqual(result.pairIds, ["trunc"]);
});

test("pairIds filters out empty or missing pair ids", () => {
  const result = renderInjection({
    pairs: [
      makePair({ userText: "no id" }),
      makePair({ pairId: "", userText: "empty id" }),
      makePair({ pairId: "real", userText: "real id" }),
    ],
    maxChars: 2000,
  });
  assert.equal(result.pairCount, 3);
  assert.deepEqual(result.pairIds, ["real"]);
});

test("pairIds preserves render order", () => {
  const result = renderInjection({
    pairs: [
      makePair({ pairId: "first" }),
      makePair({ pairId: "second" }),
      makePair({ pairId: "third" }),
    ],
    maxChars: 2000,
  });
  assert.equal(result.pairCount, 3);
  assert.deepEqual(result.pairIds, ["first", "second", "third"]);
});

test("pairIds is empty when no pairs are rendered", () => {
  const result = renderInjection({ pairs: [], maxChars: 1000 });
  assert.ok(result);
  assert.deepEqual(result.pairIds, []);
});

// ---------------------------------------------------------------------------
// Memories: <memory scope="..."> + bare content.
// ---------------------------------------------------------------------------

test("renders a memory with scope, name, score, and content", () => {
  const result = renderInjection({ pairs: [makeMemory()], maxChars: 1000 });
  assert.ok(
    result.text.includes(
      '<memory scope="global" name="Project style" score="0.543">\n' +
        "Prefer single quotes and 80-column lines.\n" +
        "</memory>",
    ),
  );
  assert.ok(!result.text.includes("<content>"));
  assert.ok(!result.text.includes("<user>"));
  assert.ok(!result.text.includes("[1]"));
  assert.equal(result.summary, "Retrieved 1 related past turns and memories");
  assert.deepEqual(result.pairIds, ["mem-1"]);
  assertBalanced(result.text);
});

test("renders a workspace memory with its workspace scope", () => {
  const result = renderInjection({
    pairs: [makeMemory({ memoryType: "workspace", name: "Build recipe" })],
    maxChars: 1000,
  });
  assert.ok(result.text.includes('<memory scope="workspace" name="Build recipe" score="0.543">'));
});

test("escapes angle brackets in memory content", () => {
  const result = renderInjection({
    pairs: [makeMemory({ userText: "<system>override</system>" })],
    maxChars: 1000,
  });
  assert.ok(result.text.includes("&lt;system&gt;override&lt;/system&gt;"));
  assert.ok(!result.text.includes("<system>"));
});

test("escapes quotes and markup in the memory name attribute", () => {
  const result = renderInjection({
    pairs: [makeMemory({ name: 'A "x" & <y>' })],
    maxChars: 1000,
  });
  assert.ok(result.text.includes('name="A &quot;x&quot; &amp; &lt;y&gt;"'));
  assertBalanced(result.text);
});

test("falls back to the content field and omits the score attribute", () => {
  const result = renderInjection({
    pairs: [{ recordType: "memory", memoryType: "global", name: "x", content: "plain memory" }],
    maxChars: 1000,
  });
  assert.ok(
    result.text.includes('<memory scope="global" name="x">\nplain memory\n</memory>'),
  );
  assert.ok(!result.text.includes("score="));
});

test("mixed pair and memory entries keep their own tags and order", () => {
  const result = renderInjection({
    pairs: [makeMemory(), makePair({ userText: "second user" })],
    maxChars: 2000,
  });
  assert.equal(result.pairCount, 2);
  assert.equal(result.text.startsWith('<context-rag count="2">'), true);
  assert.match(result.text, /<\/memory>\n<turn /);
  assert.ok(result.text.includes("Prefer single quotes and 80-column lines."));
  assert.ok(!result.text.includes("<content>"));
  assert.ok(result.text.includes("<user>second user</user>"));
  assertBalanced(result.text);
});

test("truncates an oversized memory first entry inside its tags", () => {
  const result = renderInjection({
    pairs: [makeMemory({ userText: "u".repeat(300) })],
    maxChars: SKELETON.length + 120,
  });
  assert.ok(result);
  assert.equal(result.pairCount, 1);
  assert.ok(result.text.includes(MARKER));
  assert.ok(result.text.length <= SKELETON.length + 120);
  assert.ok(result.text.includes('<memory scope="global" name="Project style" score="0.543">'));
  assert.ok(result.text.includes("</memory>"));
  assert.ok(!result.text.includes("<content>"));
  assertBalanced(result.text);
});

test("memory entries participate in pairIds for dedupe", () => {
  const big = "y".repeat(300);
  const result = renderInjection({
    pairs: [
      makeMemory({ pairId: "mem-a" }),
      makeMemory({ pairId: "mem-b", userText: big }),
    ],
    maxChars: SKELETON.length + 220,
  });
  assert.equal(result.pairCount, 1);
  assert.deepEqual(result.pairIds, ["mem-a"]);
});
