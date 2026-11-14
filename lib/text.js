/**
 * Text helpers for `dsh-context-rag`: extracting the human-visible text of a
 * message, truncating embedding payloads, and escaping user content so it
 * cannot break out of the tags that frame an injected context message.
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
 * Count the "message units" of `text` for the `retrieval.minMessageLength`
 * gate.
 *
 * Each Han ideograph counts 1 unit; each contiguous run of Latin letters and
 * digits counts 1 word. Punctuation, whitespace, emoji, and every other
 * symbol count 0 and act as separators, so joining two messages with
 * whitespace never changes the total. The text is iterated by Unicode code
 * point (not UTF-16 code unit), so astral characters like emoji or rare Han
 * ideographs are handled correctly.
 *
 * Non-string input (including `null`/`undefined`) and empty text return 0.
 *
 * @param {unknown} text - Text to count.
 * @returns {number} The number of message units.
 */
export function countMessageUnits(text) {
  if (typeof text !== "string") {
    return 0;
  }
  let units = 0;
  let inRun = false;
  for (const ch of text) {
    if (/\p{Script=Han}/u.test(ch)) {
      units += 1;
      inRun = false;
    } else if (/[\p{Script=Latin}\p{Nd}]/u.test(ch)) {
      if (!inRun) {
        units += 1;
        inRun = true;
      }
    } else {
      inRun = false;
    }
  }
  return units;
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
 * Escape text for an HTML-like text node with character entities.
 *
 * The ampersand is escaped first so a literal entity-looking sequence in the
 * source text (for example `&lt;`) cannot be decoded back into markup. The
 * result contains no raw `<` or `>`, so user content cannot open, close, or
 * forge a tag inside an injected context message.
 *
 * @param {unknown} text - Text to escape.
 * @returns {string} Escaped text with `&`, `<`, and `>` replaced.
 */
export function escapeText(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Escape text for an HTML-like attribute value delimited by `"`.
 *
 * Applies the text-node escaping from `escapeText`, then escapes double
 * quotes and encodes carriage returns, line feeds, and tabs numerically,
 * because an attribute value must stay on one line and cannot terminate its
 * own quoting.
 *
 * @param {unknown} text - Attribute value to escape.
 * @returns {string} Escaped attribute value.
 */
export function escapeAttr(text) {
  return escapeText(text)
    .replaceAll('"', "&quot;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\t", "&#9;");
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
