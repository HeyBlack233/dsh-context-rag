/**
 * Path and identifier helpers for `dsh-context-rag`.
 *
 * Every path segment derived from untrusted input (workspace directories,
 * session ids, file names) is sanitized into a safe slug before it is used in
 * a path, so a pair file can never escape `<home>/pairs` through traversal
 * (`/`, `\`, or a bare `..` segment). Identifiers are hashed with sha1 or
 * sha256 so slugs stay short, stable, and unique enough for their purpose.
 *
 * @module paths
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

/** Maximum length of a slug produced by `slugify`. */
const MAX_SLUG_LENGTH = 120;
/** Maximum length of a session slug; longer values get a hash suffix. */
const MAX_SESSION_SLUG_LENGTH = 120;
/** Fallback used for empty or unreadable workspace basenames. */
const WORKSPACE_FALLBACK = "workspace";

/**
 * Sanitize a raw string into a safe slug: anything outside
 * `[A-Za-z0-9._-]` becomes `-`, repeated hyphens collapse, and leading or
 * trailing hyphens are trimmed. A result that is empty or consists only of
 * dots (e.g. `.` or `..`) is rejected by returning `""`, because such a
 * segment would be ambiguous with the current or parent directory.
 *
 * @param {string} value - Raw value to sanitize.
 * @returns {string} A slug with only `[A-Za-z0-9._-]` characters, or `""`.
 */
function sanitizeSlug(value) {
  const slug = String(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^\.+$/.test(slug) ? "" : slug;
}

/**
 * Build a safe filename slug from an arbitrary value.
 *
 * Anything outside `[A-Za-z0-9._-]` is replaced with `-`, repeated hyphens
 * collapse, leading and trailing hyphens are trimmed, and the result is
 * capped at 120 characters. When the sanitized value would be empty (or only
 * dots, such as `..`), `fallback` is sanitized the same way and used instead;
 * if that is empty too, the result is `""`.
 *
 * @param {string} value - Raw value (converted with `String()`).
 * @param {string} [fallback] - Replacement when `value` yields nothing
 *   usable; defaults to `""`.
 * @returns {string} A slug no longer than 120 characters.
 */
export function slugify(value, fallback = "") {
  let slug = sanitizeSlug(value);
  if (slug.length === 0) {
    slug = sanitizeSlug(fallback);
  }
  return slug.slice(0, MAX_SLUG_LENGTH);
}

/**
 * Stable, readable slug for a workspace directory: the slugified basename of
 * `cwd` plus `-` plus the first 8 hex characters of the sha1 of the raw
 * `cwd`. Empty or `undefined` `cwd` values are hashed deterministically and
 * get the `workspace` fallback for the basename part.
 *
 * @param {string} [cwd] - Workspace directory path.
 * @returns {string} `<basename-slug>-<8 hex>`.
 */
export function workspaceSlug(cwd) {
  const raw = cwd ?? "";
  const base = slugify(basename(raw), WORKSPACE_FALLBACK);
  const hash = sha1Hex(String(raw)).slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * Safe filename slug for a session, capped at 120 characters. When the
 * sanitized value exceeds the cap, its tail is replaced by `-` plus the
 * first 8 hex characters of the sha256 of the raw session id, so the slug
 * stays at most 120 characters while remaining stable and unique per
 * session. A value that sanitizes to nothing gets the `session` fallback.
 *
 * @param {string} sessionId - Session id.
 * @returns {string} Slug no longer than 120 characters.
 */
export function sessionSlug(sessionId) {
  const raw = String(sessionId);
  const base = sanitizeSlug(raw);
  const slug = base.length > 0 ? base : "session";
  if (slug.length <= MAX_SESSION_SLUG_LENGTH) {
    return slug;
  }
  const hash = sha256Hex(raw).slice(0, 8);
  return `${slug.slice(0, MAX_SESSION_SLUG_LENGTH - hash.length - 1)}-${hash}`;
}

/**
 * Absolute path of the `.jsonl` pair file for a session in a workspace:
 * `<home>/pairs/<workspaceSlug(cwd)>/<sessionSlug(sessionId)>.jsonl`. Both
 * derived segments are sanitized by their slug helpers, so `home` is the
 * only trust boundary and the result always stays under `<home>/pairs`.
 *
 * @param {object} parts
 * @param {string} parts.home - DSH home directory.
 * @param {string} parts.cwd - Workspace directory.
 * @param {string} parts.sessionId - Session id.
 * @returns {string} Pair file path.
 */
export function pairFilePath({ home, cwd, sessionId }) {
  return join(
    String(home),
    "pairs",
    workspaceSlug(cwd),
    `${sessionSlug(sessionId)}.jsonl`,
  );
}

/**
 * Stable 32-character identifier for a pair, derived from the sha256 hex of
 * the canonical JSON array `[sessionId, turn, userMessageIds,
 * assistantMessageId]` truncated to its first 32 characters. The same inputs
 * always produce the same id; any change to a component produces a
 * different id.
 *
 * @param {object} parts
 * @param {string} parts.sessionId - Session id.
 * @param {number} parts.turn - Turn number.
 * @param {Array<string>} parts.userMessageIds - Message ids of the user
 *   messages that make up the turn.
 * @param {string} parts.assistantMessageId - Message id of the final
 *   assistant reply.
 * @returns {string} 32-character hex id.
 */
export function pairId({ sessionId, turn, userMessageIds, assistantMessageId }) {
  const payload = JSON.stringify([sessionId, turn, userMessageIds, assistantMessageId]);
  return sha256Hex(payload).slice(0, 32);
}

/**
 * sha256 hex digest of a string. Used by `lib/db.js` to derive the
 * `text_hash` of a pair's text.
 *
 * @param {string} text - Text to hash.
 * @returns {string} 64-character lowercase hex digest.
 */
export function textHash(text) {
  return sha256Hex(String(text));
}

/**
 * Short human-friendly form of a session id: its last 8 characters.
 *
 * @param {string} id - Full session id.
 * @returns {string} At most the last 8 characters of `id`.
 */
export function shortSessionId(id) {
  return String(id).slice(-8);
}

/**
 * Format a timestamp as local `YYYY-MM-DD HH:mm`.
 *
 * @param {number} ms - Milliseconds since the Unix epoch.
 * @returns {string} Local date and time without seconds.
 */
export function formatDate(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Create a directory (and any missing parents) if it does not exist.
 *
 * @param {string} dir - Directory path.
 * @returns {Promise<string|undefined>} Resolves when the directory is
 *   ensured; rejects on non-`EEXIST` filesystem errors.
 */
export function ensureDir(dir) {
  return mkdir(String(dir), { recursive: true });
}

/**
 * Lowercase hex digest of the sha1 of a string.
 *
 * @param {string} value
 * @returns {string} 40-character hex digest.
 */
function sha1Hex(value) {
  return createHash("sha1").update(value).digest("hex");
}

/**
 * Lowercase hex digest of the sha256 of a string.
 *
 * @param {string} value
 * @returns {string} 64-character hex digest.
 */
function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
