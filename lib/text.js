/**
 * Text helpers for `dsh-context-rag`: extracting the human-visible text of a
 * message, truncating embedding payloads, and escaping user content so it
 * cannot break out of the framing of an injected context message.
 *
 * @module text
 */

/** Marker inserted at a truncation point by `truncateMiddle`. */
const TRUNCATION_MARKER = "\n…[truncated]…\n";

/**
 * Extract the plain text of a message content array.
 *
 * Content blocks with `type === "text"` are joined with `\n`; reasoning,
 * tool, image, and any other block types are ignored. The result is trimmed.
 * Non-array input (for example a plain string message) yields `""`.
 *
 * @param {Array<object>|string|null|undefined} content - Message content
 *   blocks.
 * @returns {string} Joined, trimmed text of the `text` blocks.
 */
export function extractText(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n")
    .trim();
}

/**
 * Truncate `text` in the middle when it exceeds `maxChars`.
 *
 * The head (about 60% of the available budget) and the tail (the remaining
 * 40%) are kept, separated by `\n…[truncated]…\n`, so the result never
 * exceeds `maxChars`. Text at or below the limit is returned unchanged.
 * Degenerate limits (non-positive, or smaller than the marker) still return
 * a result no longer than `maxChars`.
 *
 * @param {string} text - Text to truncate.
 * @param {number} maxChars - Maximum length of the result.
 * @returns {string} Truncated text.
 */
export function truncateMiddle(text, maxChars) {
  const value = String(text);
  if (typeof maxChars !== "number" || !Number.isFinite(maxChars) || maxChars <= 0) {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars < TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }
  const budget = maxChars - TRUNCATION_MARKER.length;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return `${value.slice(0, head)}${TRUNCATION_MARKER}${value.slice(-tail)}`;
}

/**
 * Build the canonical embedding text for a (user, assistant) turn.
 *
 * The result is exactly `User:\n` + `user` + `\n\nAssistant:\n` +
 * `assistant`, then run through `truncateMiddle` and trimmed, so a long turn
 * is cut in the middle while the labels remain intact at the head.
 *
 * @param {object} turn
 * @param {string} turn.user - User message text.
 * @param {string} turn.assistant - Assistant reply text.
 * @param {number} maxChars - Maximum length of the result.
 * @returns {string} Embedding text no longer than `maxChars`.
 */
export function buildEmbeddingText({ user, assistant }, maxChars) {
  const raw = `User:\n${user}\n\nAssistant:\n${assistant}`;
  return truncateMiddle(raw, maxChars).trim();
}

/**
 * Escape every `<` in `text` as the literal six-character sequence `\u003c`.
 *
 * This neutralizes anything that could be mistaken for an opening tag (for
 * example `<system>`), so user content cannot break the framing of an
 * injected context message.
 *
 * @param {string} text - Text to escape.
 * @returns {string} Text with every `<` replaced.
 */
export function escapeFraming(text) {
  return String(text).replaceAll("<", "\\u003c");
}

/**
 * Produce a short, single-line summary of `text`.
 *
 * Runs of whitespace collapse to a single space and the result is trimmed.
 * When the collapsed text is longer than `max` (default 120), it is cut
 * short and `…` is appended so the result is at most `max` characters.
 *
 * @param {string} text - Text to summarize.
 * @param {number} [max=120] - Maximum length of the result.
 * @returns {string} Summarized text no longer than `max` characters.
 */
export function boundSummary(text, max = 120) {
  const collapsed = String(text).replace(/\s+/g, " ").trim();
  const limit = Math.max(0, Math.floor(max));
  if (collapsed.length <= limit) {
    return collapsed;
  }
  if (limit <= 0) {
    return "";
  }
  return `${collapsed.slice(0, limit - 1)}…`;
}
