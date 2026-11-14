/**
 * Tests for the text helpers in `lib/text.js`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  boundSummary,
  buildEmbeddingText,
  countMessageUnits,
  escapeAttr,
  escapeText,
  extractText,
  truncateMiddle,
} from "../lib/text.js";

const MARKER = "\n…[truncated]…\n";

test("text: extractText joins only text blocks and trims", () => {
  const content = [
    { type: "text", text: "  Hello" },
    { type: "reasoning", text: "secret reasoning" },
    { type: "tool", text: "tool payload" },
    { type: "image", image: "img.png" },
    { type: "text", text: "world  " },
  ];
  assert.equal(extractText(content), "Hello\nworld");
  assert.equal(extractText([{ type: "text", text: "only" }]), "only");
  // Missing or wrong text fields contribute nothing.
  assert.equal(extractText([{ type: "text" }, { type: "text", text: 42 }]), "42");
  assert.equal(extractText([{ type: "text", text: "a" }, { type: "text", text: "" }]), "a");
});

test("text: extractText handles empty and non-array input", () => {
  assert.equal(extractText([]), "");
  assert.equal(extractText(null), "");
  assert.equal(extractText(undefined), "");
  assert.equal(extractText("plain string"), "");
});

test("text: truncateMiddle keeps short, empty and exact text unchanged", () => {
  assert.equal(truncateMiddle("", 100), "");
  assert.equal(truncateMiddle("abc", 100), "abc");
  const exact = "x".repeat(100);
  assert.equal(truncateMiddle(exact, 100), exact);
  assert.equal(truncateMiddle(exact, 100).length, 100);
});

test("text: truncateMiddle cuts over-long text to exactly maxChars", () => {
  const text = "x".repeat(1000);
  const out = truncateMiddle(text, 100);
  assert.equal(out.length, 100);
  assert.ok(out.includes(MARKER));
  // 60% head + 40% tail around the marker: 51 + 15 + 34 = 100.
  assert.equal(out, `${"x".repeat(51)}${MARKER}${"x".repeat(34)}`);
  assert.ok(out.startsWith("x"));
  assert.ok(out.endsWith("x"));
});

test("text: truncateMiddle respects degenerate limits", () => {
  assert.equal(truncateMiddle("abc", 0), "");
  assert.equal(truncateMiddle("abc", -5), "");
  // A limit smaller than the marker still yields at most maxChars chars.
  const tiny = truncateMiddle("x".repeat(100), 5);
  assert.equal(tiny, MARKER.slice(0, 5));
  assert.ok(tiny.length <= 5);
});

test("text: buildEmbeddingText uses the exact framing and trims", () => {
  const out = buildEmbeddingText({ user: "hello", assistant: "world" }, 1000);
  assert.equal(out, "User:\nhello\n\nAssistant:\nworld");
  assert.ok(out.startsWith("User:\n"));
  assert.ok(out.includes("\n\nAssistant:\n"));
});

test("text: buildEmbeddingText truncates and stays within maxChars", () => {
  const out = buildEmbeddingText({ user: "u".repeat(500), assistant: "a".repeat(500) }, 120);
  assert.ok(out.length <= 120);
  assert.ok(out.includes(MARKER));
  assert.ok(out.startsWith("User:\n"));
  // Trailing whitespace is trimmed after truncation.
  const trimmed = buildEmbeddingText({ user: "hi", assistant: "bye  \n" }, 1000);
  assert.equal(trimmed, "User:\nhi\n\nAssistant:\nbye");
});

test("text: escapeText replaces &, <, and > with character entities", () => {
  const out = escapeText("<system>hi</system>");
  assert.equal(out, "&lt;system&gt;hi&lt;/system&gt;");
  assert.ok(!out.includes("<"));
  assert.ok(!out.includes(">"));
  assert.equal(escapeText("plain text"), "plain text");
  assert.equal(escapeText(""), "");
  assert.equal(escapeText("a<b&c>d"), "a&lt;b&amp;c&gt;d");
});

test("text: escapeText escapes the ampersand first so entities stay literal", () => {
  assert.equal(escapeText("&lt;system&gt;"), "&amp;lt;system&amp;gt;");
  assert.equal(escapeText("&amp;"), "&amp;amp;");
});

test("text: escapeAttr escapes quotes, ampersands, brackets, and newlines", () => {
  assert.equal(
    escapeAttr('a "quoted" <tag> & value'),
    "a &quot;quoted&quot; &lt;tag&gt; &amp; value",
  );
  assert.equal(escapeAttr("line one\nline two\r\tend"), "line one&#10;line two&#13;&#9;end");
  assert.equal(escapeAttr("plain"), "plain");
});

test("text: boundSummary collapses whitespace and trims", () => {
  assert.equal(boundSummary("a  b\n c\t d"), "a b c d");
  assert.equal(boundSummary("  leading"), "leading");
  assert.equal(boundSummary("trailing  "), "trailing");
});

test("text: boundSummary caps at max and appends an ellipsis", () => {
  assert.equal(boundSummary("x".repeat(200), 120).length, 120);
  assert.ok(boundSummary("x".repeat(200), 120).endsWith("…"));
  assert.equal(boundSummary("x".repeat(200), 120), `${"x".repeat(119)}…`);
  // At or under the limit nothing is cut.
  assert.equal(boundSummary("y".repeat(120), 120), "y".repeat(120));
  assert.equal(boundSummary("short", 120), "short");
  // Default limit is 120.
  assert.equal(boundSummary("x".repeat(500)).length, 120);
  // Degenerate limits.
  assert.equal(boundSummary("x".repeat(10), 0), "");
  assert.equal(boundSummary("xy", 1), "…");
});

test("text: countMessageUnits returns 0 for empty and non-string input", () => {
  assert.equal(countMessageUnits(""), 0);
  assert.equal(countMessageUnits(null), 0);
  assert.equal(countMessageUnits(undefined), 0);
  assert.equal(countMessageUnits(42), 0);
  assert.equal(countMessageUnits([]), 0);
  assert.equal(countMessageUnits({}), 0);
});

test("text: countMessageUnits counts English words and punctuation separators", () => {
  assert.equal(countMessageUnits("Hello, world!"), 2);
  assert.equal(countMessageUnits("hello"), 1);
  assert.equal(countMessageUnits("a b c"), 3);
  assert.equal(countMessageUnits("..."), 0);
  assert.equal(countMessageUnits("???"), 0);
});

test("text: countMessageUnits counts Chinese with punctuation", () => {
  assert.equal(countMessageUnits("你好，世界"), 4);
  assert.equal(countMessageUnits("你好"), 2);
  assert.equal(countMessageUnits("一二三四五六七八"), 8);
});

test("text: countMessageUnits counts mixed Han and English", () => {
  assert.equal(countMessageUnits("你好 world"), 3);
  assert.equal(countMessageUnits("world你好"), 3);
  assert.equal(countMessageUnits("你好world"), 3);
});

test("text: countMessageUnits ignores emoji and whitespace as separators", () => {
  assert.equal(countMessageUnits("hello👋world"), 2);
  assert.equal(countMessageUnits("   a   b   "), 2);
  assert.equal(countMessageUnits("你好 👋 世界"), 4);
});

test("text: countMessageUnits counts number runs as single words", () => {
  assert.equal(countMessageUnits("123"), 1);
  assert.equal(countMessageUnits("hello123"), 1);
  assert.equal(countMessageUnits("hello 123"), 2);
  assert.equal(countMessageUnits("abc-123"), 2);
});

test("text: countMessageUnits joins do not change the count", () => {
  // The capture join ("\n\n") and the injection join ("\n") are whitespace
  // separators, so summing per-message counts equals the joined count.
  const parts = ["Hello, world!", "你好，世界", "123"];
  const joined = parts.join("\n");
  const sum = parts.reduce((acc, part) => acc + countMessageUnits(part), 0);
  assert.equal(countMessageUnits(joined), sum);
  assert.equal(countMessageUnits(joined), 2 + 4 + 1);
});
