/**
 * Tests for the text helpers in `lib/text.js`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  boundSummary,
  buildEmbeddingText,
  escapeFraming,
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

test("text: escapeFraming replaces every < with the literal \\u003c", () => {
  const out = escapeFraming("<system>hi</system>");
  assert.equal(out, "\\u003csystem>hi\\u003c/system>");
  assert.ok(!out.includes("<"));
  assert.equal(escapeFraming("plain text"), "plain text");
  assert.equal(escapeFraming(""), "");
  assert.equal(escapeFraming("a<b<c"), "a\\u003cb\\u003cc");
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
