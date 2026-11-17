/**
 * In-memory ring buffer for plugin logs.
 *
 * Backs the "Logs" tab of the plugin settings page: entries live in memory
 * only (nothing touches disk unless `exportTo()` is called), the buffer is
 * capped at `limit` entries with the oldest dropped first, and `debug`-level
 * capture can be toggled at runtime. Callers decide what to log; secrets and
 * message bodies are the caller's responsibility.
 *
 * Plain ESM JavaScript using only Node built-ins. Requires Node.js >= 22.
 *
 * @module log-buffer
 */

import fs from "node:fs";
import path from "node:path";
import util from "node:util";

/** Valid log levels, ordered from most to least verbose. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"];

/** Default number of entries kept in memory. */
export const DEFAULT_LOG_LIMIT = 200;

/** Hard upper bound for the in-memory entry limit. */
export const MAX_LOG_LIMIT = 5000;

/** Cap for a single formatted message, in characters. */
const MAX_MESSAGE_LENGTH = 20000;

/** Suffix appended when a message is truncated. */
const TRUNCATION_MARK = "…";

/**
 * Format a single argument for a log message.
 *
 * Strings are kept verbatim, `Error` instances render as their stack (or
 * their message when no stack is available), and every other value is
 * inspected with bounded options so cyclic structures and huge values cannot
 * blow up memory.
 *
 * @param {unknown} value - Argument to format.
 * @returns {string} Rendered argument.
 */
function formatArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    if (typeof value.stack === "string" && value.stack.length > 0) {
      return value.stack;
    }
    return value.message;
  }
  return util.inspect(value, {
    depth: 4,
    breakLength: Infinity,
    maxArrayLength: 50,
    maxStringLength: 4000,
  });
}

/**
 * Format a list of arguments into a single message separated by single
 * spaces.
 *
 * @param {unknown[]} args - Arguments to join.
 * @returns {string} The formatted message.
 */
function formatArgs(args) {
  return args.map(formatArg).join(" ");
}

/**
 * Create an in-memory log buffer.
 *
 * @param {object} [options] - Options.
 * @param {number} [options.limit=DEFAULT_LOG_LIMIT] - Max entries to keep;
 *   must be an integer in 1..MAX_LOG_LIMIT.
 * @param {boolean} [options.debug=false] - Whether `debug`-level capture is
 *   enabled initially.
 * @param {() => Date} [options.now=() => new Date()] - Clock used for entry
 *   timestamps and export file names; injectable for deterministic tests.
 * @returns {{
 *   limit: number,
 *   debug: boolean,
 *   setLimit: (n: number) => number,
 *   setDebug: (flag: boolean) => boolean,
 *   record: (level: string, ...args: unknown[]) => object|null,
 *   entries: () => Array<{time: string, level: string, message: string}>,
 *   clear: () => void,
 *   logger: (base: object|null) => Record<string, (...args: unknown[]) => unknown>,
 *   toText: () => string,
 *   exportTo: (dir: string) => {path: string, count: number},
 * }} The buffer. `limit` and `debug` are read-only getters.
 * @throws {RangeError} When `limit` is not an integer between 1 and
 *   MAX_LOG_LIMIT.
 */
function createLogBuffer({
  limit = DEFAULT_LOG_LIMIT,
  debug = false,
  now = () => new Date(),
} = {}) {
  let currentLimit = limit;
  let currentDebug = debug;
  const buffer = [];

  /**
   * Validate a proposed entry limit.
   *
   * @param {unknown} n - Value to test.
   * @throws {RangeError} When `n` is not an integer in 1..MAX_LOG_LIMIT.
   */
  function checkLimit(n) {
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > MAX_LOG_LIMIT
    ) {
      throw new RangeError(
        `limit must be an integer between 1 and ${MAX_LOG_LIMIT}`,
      );
    }
  }

  // Validate the constructor limit up front so the buffer can never start in
  // an inconsistent state.
  checkLimit(currentLimit);

  /**
   * Drop the oldest entries until the buffer fits within `currentLimit`.
   */
  function trim() {
    if (buffer.length > currentLimit) {
      buffer.splice(0, buffer.length - currentLimit);
    }
  }

  /**
   * Set the entry limit; excess entries are dropped from the head at once.
   *
   * @param {number} n - New limit, an integer in 1..MAX_LOG_LIMIT.
   * @returns {number} The new limit.
   * @throws {RangeError} When `n` is not an integer in range.
   */
  function setLimit(n) {
    checkLimit(n);
    currentLimit = n;
    trim();
    return currentLimit;
  }

  /**
   * Toggle `debug`-level capture.
   *
   * @param {boolean} flag - New capture flag.
   * @returns {boolean} The flag.
   * @throws {TypeError} When `flag` is not a boolean.
   */
  function setDebug(flag) {
    if (typeof flag !== "boolean") {
      throw new TypeError("debug must be a boolean");
    }
    currentDebug = flag;
    return currentDebug;
  }

  /**
   * Record one entry.
   *
   * The message is the arguments formatted and joined, capped at
   * MAX_MESSAGE_LENGTH characters (longer messages are truncated and gain a
   * trailing TRUNCATION_MARK). The buffer is trimmed to `limit` afterwards.
   *
   * @param {string} level - One of LOG_LEVELS.
   * @param {...unknown} args - Values to format into the message.
   * @returns {object|null} The stored entry, or null when a `debug` entry was
   *   dropped because capture is off.
   * @throws {RangeError} When `level` is not one of LOG_LEVELS.
   */
  function record(level, ...args) {
    if (!LOG_LEVELS.includes(level)) {
      throw new RangeError(`unknown log level: ${level}`);
    }
    if (level === "debug" && !currentDebug) return null;

    const time = now().toISOString();
    let message = formatArgs(args);
    if (message.length > MAX_MESSAGE_LENGTH) {
      message = `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}${TRUNCATION_MARK}`;
    }
    const entry = { time, level, message };
    buffer.push(entry);
    trim();
    return entry;
  }

  /**
   * Snapshot of all buffered entries, oldest first.
   *
   * @returns {Array<{time: string, level: string, message: string}>} A
   *   detached copy; mutating it does not affect the buffer.
   */
  function entries() {
    return buffer.map((entry) => ({ ...entry }));
  }

  /**
   * Discard all buffered entries.
   */
  function clear() {
    buffer.length = 0;
  }

  /**
   * Serialize the buffered entries as plain text.
   *
   * Each line is `[<time>] [<LEVEL>] <message>` (level uppercased), lines are
   * joined with `\n` and the result ends with `\n`. Multi-line messages are
   * preserved verbatim. An empty buffer yields `""`.
   *
   * @returns {string} The serialized log.
   */
  function toText() {
    if (buffer.length === 0) return "";
    const lines = buffer.map(
      (entry) =>
        `[${entry.time}] [${entry.level.toUpperCase()}] ${entry.message}`,
    );
    return `${lines.join("\n")}\n`;
  }

  /**
   * Build a tee logger that forwards to `base` while also buffering.
   *
   * Each call records the entry first, then forwards to `base[level]` with
   * `base` as `this`; a throwing base method never breaks the buffer or the
   * caller (the forwarding exception is swallowed). With capture off, the
   * `debug` method is a complete no-op: nothing is recorded or forwarded.
   *
   * @param {object|null} base - Target logger (console, host logger, or
   *   null). Only methods that exist are forwarded.
   * @returns {Record<string, (...args: unknown[]) => unknown>} A tee logger
   *   with `debug`, `info`, `warn` and `error` methods.
   */
  function logger(base) {
    const tee = {};
    for (const level of LOG_LEVELS) {
      tee[level] = (...args) => {
        if (level === "debug" && !currentDebug) return; // full no-op
        const entry = record(level, ...args);
        if (base && typeof base[level] === "function") {
          try {
            base[level].apply(base, args);
          } catch {
            // A throwing base must not break buffering or the caller.
          }
        }
        return entry;
      };
    }
    return tee;
  }

  /**
   * Export the current entries to a new file inside `dir`.
   *
   * The directory is created recursively when missing. The file name uses the
   * host-local components of `now()` as `context-rag-YYYYMMDD-HHmmss-SSS.log`;
   * on collision a numeric suffix (`-1`, `-2`, ...) is inserted before the
   * extension. The content is a short header, a blank line, then `toText()`.
   * The file is written with mode 0o600.
   *
   * @param {string} dir - Destination directory.
   * @returns {{path: string, count: number}} Absolute path of the written
   *   file and the number of entries exported.
   * @throws {TypeError} When `dir` is not a string.
   */
  function exportTo(dir) {
    if (typeof dir !== "string") {
      throw new TypeError("exportTo dir must be a string");
    }
    fs.mkdirSync(dir, { recursive: true });

    const stamp = now();
    const yyyy = String(stamp.getFullYear()).padStart(4, "0");
    const mm = String(stamp.getMonth() + 1).padStart(2, "0");
    const dd = String(stamp.getDate()).padStart(2, "0");
    const hh = String(stamp.getHours()).padStart(2, "0");
    const min = String(stamp.getMinutes()).padStart(2, "0");
    const ss = String(stamp.getSeconds()).padStart(2, "0");
    const mmm = String(stamp.getMilliseconds()).padStart(3, "0");
    const baseName = `context-rag-${yyyy}${mm}${dd}-${hh}${min}${ss}-${mmm}`;

    let fileName = `${baseName}.log`;
    for (let suffix = 1; fs.existsSync(path.join(dir, fileName)); suffix += 1) {
      fileName = `${baseName}-${suffix}.log`;
    }

    const filePath = path.resolve(dir, fileName);
    const header = [
      "# dsh-context-rag in-memory log buffer",
      `# exported: ${stamp.toISOString()}`,
      `# limit: ${currentLimit}; entries: ${buffer.length}`,
    ].join("\n");
    fs.writeFileSync(filePath, `${header}\n\n${toText()}`, { mode: 0o600 });
    return { path: filePath, count: buffer.length };
  }

  return {
    get limit() {
      return currentLimit;
    },
    get debug() {
      return currentDebug;
    },
    setLimit,
    setDebug,
    record,
    entries,
    clear,
    logger,
    toText,
    exportTo,
  };
}

export { createLogBuffer };
