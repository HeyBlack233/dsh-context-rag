/**
 * Rendering of retrieved past turns and memories into an injectable context
 * message.
 *
 * `renderInjection` is a pure function: it turns an array of retrieved
 * records (conversation pairs and memories) into an HTML-like tagged block
 * bounded by a character budget. The structure is:
 *
 *   <context-rag count="N">
 *   <notice>...</notice>
 *   <turn date="..." workspace="..." score="...">
 *   <user>...</user>
 *   <assistant>...</assistant>
 *   </turn>
 *   <memory scope="global|workspace" name="..." score="...">
 *   <content>...</content>
 *   </memory>
 *   </context-rag>
 *
 * Content and attribute values are escaped as character entities so they
 * cannot break out of the tags, and oversized entries are truncated inside
 * their text elements while the tags stay balanced.
 *
 * @module render
 */

import { basename } from "node:path";
import { escapeAttr, escapeText, truncateMiddle } from "./text.js";

/** The fixed notice shown once inside the root element. */
const NOTICE_TEXT =
  "Retrieved related past conversation turns and memories. " +
  "Use them as reference, not source of truth";

/** The notice element carrying the fixed notice text. */
const NOTICE = `<notice>${NOTICE_TEXT}</notice>`;

/** Closing tag of the root element. */
const ROOT_CLOSE = "</context-rag>";

/** Closing tag of a conversation turn. */
const TURN_CLOSE = "</turn>";

/** Closing tag of a memory. */
const MEMORY_CLOSE = "</memory>";

/**
 * Format a date locally as `YYYY-MM-DD HH:mm`.
 *
 * @param {Date|number|string} value - Date-like value.
 * @returns {string} Local `YYYY-MM-DD HH:mm`, or an empty string when invalid.
 */
function formatDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Derive the workspace display name from a cwd path.
 *
 * @param {string} [cwd] - Workspace path.
 * @returns {string} The path basename, or "unknown" when missing/empty.
 */
function workspaceName(cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    return "unknown";
  }
  return basename(cwd) || "unknown";
}

/**
 * Render a score to three decimals, or `null` when it is not a finite number.
 *
 * A missing score is omitted from the tags entirely rather than rendered as
 * `n/a`, so entries without a score stay structurally clean.
 *
 * @param {number|undefined} score - Optional cosine or rerank score.
 * @returns {string|null} Three-decimal string or `null`.
 */
function scoreValue(score) {
  return typeof score === "number" && Number.isFinite(score)
    ? score.toFixed(3)
    : null;
}

/**
 * Build the text of a conversation turn entry.
 *
 * @param {string} open - The `<turn ...>` opening tag.
 * @param {string} user - Escaped user text.
 * @param {string} assistant - Escaped assistant text.
 * @returns {string} The complete entry text.
 */
function pairText(open, user, assistant) {
  return `${open}\n<user>${user}</user>\n` +
    `<assistant>${assistant}</assistant>\n${TURN_CLOSE}`;
}

/**
 * Build the text of a memory entry.
 *
 * @param {string} open - The `<memory ...>` opening tag.
 * @param {string} content - Escaped memory content.
 * @returns {string} The complete entry text.
 */
function memoryText(open, content) {
  return `${open}\n<content>${content}</content>\n${MEMORY_CLOSE}`;
}

/**
 * Build an entry for a conversation pair.
 *
 * @param {object} pair - A retrieved conversation pair.
 * @returns {object} Entry with `text`, `fixedCost`, the escaped variable
 *   fields needed for truncation, and the record's `pairId`.
 */
function buildPairEntry(pair) {
  const userEsc = escapeText(pair.userText ?? pair.user ?? "");
  const assistantEsc = escapeText(pair.assistantText ?? pair.assistant ?? "");
  const date = formatDate(pair.createdAt);
  const attrs = [];
  if (date) {
    attrs.push(`date="${escapeAttr(date)}"`);
  }
  attrs.push(`workspace="${escapeAttr(workspaceName(pair.cwd))}"`);
  const score = scoreValue(pair.score);
  if (score !== null) {
    attrs.push(`score="${score}"`);
  }
  const open = `<turn ${attrs.join(" ")}>`;
  return {
    kind: "pair",
    open,
    userEsc,
    assistantEsc,
    text: pairText(open, userEsc, assistantEsc),
    fixedCost: pairText(open, "", "").length,
    pairId: pair?.pairId,
  };
}

/**
 * Build an entry for a memory.
 *
 * @param {object} pair - A retrieved memory record.
 * @returns {object} Entry with `text`, `fixedCost`, the escaped content needed
 *   for truncation, and the record's `pairId`.
 */
function buildMemoryEntry(pair) {
  const contentEsc = escapeText(pair.userText ?? pair.content ?? "");
  const attrs = [
    `scope="${escapeAttr(pair.memoryType ?? "workspace")}"`,
    `name="${escapeAttr(pair.name ?? "")}"`,
  ];
  const score = scoreValue(pair.score);
  if (score !== null) {
    attrs.push(`score="${score}"`);
  }
  const open = `<memory ${attrs.join(" ")}>`;
  return {
    kind: "memory",
    open,
    contentEsc,
    text: memoryText(open, contentEsc),
    fixedCost: memoryText(open, "").length,
    pairId: pair?.pairId,
  };
}

/**
 * Build the opening tag of the root element.
 *
 * @param {number} count - Number of entries rendered below it.
 * @returns {string} The `<context-rag count="N">` tag.
 */
function rootOpen(count) {
  return `<context-rag count="${count}">`;
}

/**
 * Assemble the complete rendered text for a list of entries.
 *
 * @param {Array<object>} included - Entries to include, in render order.
 * @returns {string} The framed text, always with balanced tags.
 */
function assemble(included) {
  const head = `${rootOpen(included.length)}\n${NOTICE}`;
  if (included.length === 0) {
    return `${head}\n${ROOT_CLOSE}`;
  }
  return `${head}\n${included.map((entry) => entry.text).join("\n")}\n${ROOT_CLOSE}`;
}

/**
 * Select whole entries that fit within the budget.
 *
 * The root's `count` attribute changes the length of the opening tag, so the
 * selection is iterated to a fixed point: the budget is computed for the
 * currently assumed entry count, the fitting prefix of entries is selected,
 * and the assumption is updated until the selected count matches it.
 *
 * @param {Array<object>} entries - All built entries, in render order.
 * @param {number} maxChars - Maximum length of the rendered text.
 * @returns {Array<object>} The longest fitting prefix of entries.
 */
function selectWholeEntries(entries, maxChars) {
  let assumed = entries.length;
  let included = [];
  for (let pass = 0; pass <= entries.length + 1; pass += 1) {
    // Root tag + newline + notice + the newline before the entry body.
    const headLen = rootOpen(assumed).length + 1 + NOTICE.length + 1;
    const tailLen = 1 + ROOT_CLOSE.length;
    const budget = maxChars - headLen - tailLen;
    const next = [];
    let used = 0;
    for (const entry of entries) {
      const cost = (next.length === 0 ? 0 : 1) + entry.text.length;
      if (used + cost > budget) {
        break;
      }
      next.push(entry);
      used += cost;
    }
    included = next;
    if (next.length === assumed) {
      return included;
    }
    assumed = next.length;
    if (assumed === 0) {
      return included;
    }
  }
  return included;
}

/**
 * Select the entries to render, trimming defensively if the assembled text
 * still exceeds the budget.
 *
 * @param {Array<object>} entries - All built entries, in render order.
 * @param {number} maxChars - Maximum length of the rendered text.
 * @returns {Array<object>} The entries to render.
 */
function selectEntries(entries, maxChars) {
  let included = selectWholeEntries(entries, maxChars);
  while (included.length > 0 && assemble(included).length > maxChars) {
    included = included.slice(0, -1);
  }
  return included;
}

/**
 * Truncate the first entry's variable text so that the single-entry message
 * fits within the budget, keeping its tags intact.
 *
 * @param {object} entry - First built entry.
 * @param {number} maxChars - Maximum length of the rendered text.
 * @returns {object|null} The truncated entry, or `null` when even its fixed
 *   scaffolding does not fit.
 */
function truncateFirstEntry(entry, maxChars) {
  const headLen = rootOpen(1).length + 1 + NOTICE.length + 1;
  const tailLen = 1 + ROOT_CLOSE.length;
  const textBudget = maxChars - headLen - tailLen - entry.fixedCost;
  if (textBudget < 0) {
    return null;
  }
  if (entry.kind === "memory") {
    return {
      ...entry,
      text: memoryText(entry.open, truncateMiddle(entry.contentEsc, textBudget)),
    };
  }
  const userLen = entry.userEsc.length;
  const asstLen = entry.assistantEsc.length;
  const total = userLen + asstLen;
  let userMax = textBudget;
  let asstMax = 0;
  if (total > 0) {
    userMax = Math.floor(textBudget * (userLen / total));
    asstMax = textBudget - userMax;
  }
  return {
    ...entry,
    text: pairText(
      entry.open,
      truncateMiddle(entry.userEsc, userMax),
      truncateMiddle(entry.assistantEsc, asstMax),
    ),
  };
}

/**
 * Render retrieved pairs and memories into a bounded injection body.
 *
 * @param {object} options
 * @param {Array<object>} [options.pairs] - Retrieved records. Conversation
 *   pairs have `userText`/`assistantText` (falling back to
 *   `user`/`assistant`), `createdAt`, `cwd`, optional `score`, and an
 *   optional string `pairId`. Memory records additionally carry
 *   `recordType: "memory"`, `memoryType`, and `name`.
 * @param {number} options.maxChars - Maximum length of the rendered text.
 * @returns {{text:string,summary:string,pairCount:number,pairIds:string[]}|null}
 *   The rendered result, or `null` when the budget is too small to render any
 *   entry. `pairIds` lists the non-empty `pairId`s of the records actually
 *   included, in render order (including a truncated first entry); records
 *   without a usable `pairId` are simply omitted from the list.
 */
export function renderInjection({ pairs = [], maxChars } = {}) {
  if (typeof maxChars !== "number" || !Number.isFinite(maxChars)) {
    return null;
  }
  const skeletonLen = assemble([]).length;
  if (maxChars < skeletonLen + 40) {
    return null;
  }

  const entries = (pairs ?? []).map((pair) =>
    pair?.recordType === "memory"
      ? buildMemoryEntry(pair)
      : buildPairEntry(pair),
  );

  let included = selectEntries(entries, maxChars);
  if (included.length === 0 && entries.length > 0) {
    const first = truncateFirstEntry(entries[0], maxChars);
    if (!first) {
      return null;
    }
    included = [first];
  }

  const text = assemble(included);
  const pairCount = included.length;
  const pairIds = included
    .map((entry) => entry.pairId)
    .filter((id) => typeof id === "string" && id.length > 0);

  return {
    text,
    summary: `Retrieved ${pairCount} related past turns and memories`,
    pairCount,
    pairIds,
  };
}
