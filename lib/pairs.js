/**
 * JSONL pair store for `dsh-context-rag`.
 *
 * A "pair" is the authoritative record of one (user message, final assistant
 * reply) turn: `{ pairId, sessionId, cwd, turn, createdAt, user, assistant }`.
 * Pairs are persisted as one JSON object per line in `.jsonl` files under
 * `<home>/pairs`. This module owns record validation, serialization, and the
 * file conventions; it performs no deduplication (that belongs to the index
 * database).
 *
 * @module pairs
 */

import { mkdir, open, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";

/**
 * Error thrown for invalid pair records. Carries a stable `code` and an
 * optional `details` object.
 */
export class PairError extends Error {
  /**
   * @param {string} code - Stable error code (e.g. `INVALID_PAIR`).
   * @param {string} message - Human readable description.
   * @param {object|null} [details] - Extra structured context, such as the
   *   offending field name.
   */
  constructor(code, message, details = null) {
    super(message);
    this.name = "PairError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Normalize and validate a pair record.
 *
 * Returns a canonical copy containing exactly the authoritative fields.
 * Rules: `pairId` and `sessionId` must be non-empty strings (both are
 * trimmed); `cwd` must be a string (empty allowed); `turn` must be an
 * integer >= 0; `createdAt` must be a finite number; `user` and `assistant`
 * must be strings.
 *
 * @param {object} record - Candidate pair record.
 * @returns {object} Normalized record.
 * @throws {PairError} Code `INVALID_PAIR` when any field fails validation.
 */
export function validatePair(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new PairError("INVALID_PAIR", "pair record must be a plain object");
  }
  if (typeof record.pairId !== "string" || record.pairId.trim().length === 0) {
    throw new PairError("INVALID_PAIR", "pairId must be a non-empty string", { field: "pairId" });
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    throw new PairError("INVALID_PAIR", "sessionId must be a non-empty string", { field: "sessionId" });
  }
  if (typeof record.cwd !== "string") {
    throw new PairError("INVALID_PAIR", "cwd must be a string", { field: "cwd" });
  }
  if (!Number.isInteger(record.turn) || record.turn < 0) {
    throw new PairError("INVALID_PAIR", "turn must be an integer >= 0", { field: "turn" });
  }
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) {
    throw new PairError("INVALID_PAIR", "createdAt must be a finite number", { field: "createdAt" });
  }
  if (typeof record.user !== "string") {
    throw new PairError("INVALID_PAIR", "user must be a string", { field: "user" });
  }
  if (typeof record.assistant !== "string") {
    throw new PairError("INVALID_PAIR", "assistant must be a string", { field: "assistant" });
  }
  return {
    pairId: record.pairId.trim(),
    sessionId: record.sessionId.trim(),
    cwd: record.cwd,
    turn: record.turn,
    createdAt: record.createdAt,
    user: record.user,
    assistant: record.assistant,
  };
}

/**
 * Serialize a pair record to one JSON line terminated by `\n`. The record is
 * validated first, so an invalid record throws `PairError`.
 *
 * @param {object} record - Valid pair record.
 * @returns {string} One-line JSON plus a trailing newline.
 * @throws {PairError} When the record is invalid.
 */
export function serializePair(record) {
  return `${JSON.stringify(validatePair(record))}\n`;
}

/**
 * Parse one line of a pair file. Returns the normalized record when the line
 * is valid JSON describing a valid pair, and `null` for empty input, JSON
 * syntax errors, or schema violations.
 *
 * @param {string} line - A single line without its trailing newline.
 * @returns {object|null} Normalized pair record, or `null` if malformed.
 */
export function parsePairLine(line) {
  if (typeof line !== "string") {
    return null;
  }
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  try {
    return validatePair(data);
  } catch {
    return null;
  }
}

/**
 * Append a pair record to a `.jsonl` file.
 *
 * The parent directory is created on demand. Exactly one line is written in
 * append mode through a `FileHandle`, then synced and closed, so existing
 * content is never rewritten. Returns the normalized record.
 *
 * @param {string} file - Absolute path of the `.jsonl` file.
 * @param {object} record - Pair record to append.
 * @returns {Promise<object>} The normalized record.
 * @throws {PairError} When the record is invalid.
 */
export async function appendPair(file, record) {
  const normalized = validatePair(record);
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, "a");
  try {
    await handle.write(serializePair(normalized));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return normalized;
}

/**
 * Compare two absolute paths for a deterministic sort order that is
 * independent of locale.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative, zero, or positive.
 */
function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Iterate the absolute `.jsonl` file paths under `<home>/pairs`.
 *
 * Subdirectories are visited recursively; only regular files ending in
 * `.jsonl` are yielded, in deterministic sorted order. A missing `pairs`
 * directory yields nothing.
 *
 * @param {string} home - DSH home directory.
 * @returns {AsyncGenerator<string, void, void>} Absolute `.jsonl` paths.
 */
export async function* iteratePairFiles(home) {
  const root = join(resolve(home), "pairs");
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") {
      return;
    }
    throw err;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort(comparePaths);
  for (const file of files) {
    yield file;
  }
}

/**
 * Read every pair record from `<home>/pairs`.
 *
 * Files are visited in deterministic order (see `iteratePairFiles`); each
 * valid line yields `{ record, file }`. Malformed lines are skipped; when
 * `onMalformed` is provided it is called with `(line, file)`. Blank and
 * whitespace-only lines are skipped silently. The file is read through a
 * `readline` stream, one record at a time.
 *
 * @param {string} home - DSH home directory.
 * @param {object} [options]
 * @param {(line: string, file: string) => void} [options.onMalformed] - Called
 *   for every non-blank line that does not parse to a valid pair.
 * @returns {AsyncGenerator<{record: object, file: string}, void, void>}
 */
export async function* readPairs(home, { onMalformed } = {}) {
  for await (const file of iteratePairFiles(home)) {
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        const record = parsePairLine(line);
        if (record !== null) {
          yield { record, file };
        } else if (typeof onMalformed === "function") {
          onMalformed(line, file);
        }
      }
    } finally {
      lines.close();
    }
  }
}
