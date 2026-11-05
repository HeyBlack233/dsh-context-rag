/**
 * Persistent memory store for `dsh-context-rag`.
 *
 * A "memory" is a short, named, human-readable note persisted as a Markdown
 * file with YAML-style front matter and a body. Memories live under two fixed
 * locations inside a home directory:
 *
 * ```
 * <home>/memories/global/<name>.md                  global memories
 * <home>/memories/workspaces/<workspace-slug>/<name>.md   workspace memories
 * <home>/memories/.../MEMORY.md                     per-directory index
 * ```
 *
 * The workspace slug is derived with `workspaceSlug(cwd)` from the current
 * working directory, so a workspace is located only through the `cwd` passed
 * in by the caller; the original absolute `cwd` is recorded on each record.
 *
 * File format: classic line-by-line YAML front matter between `---` fences,
 * followed by the body verbatim. Every string value is emitted as a JSON
 * double-quoted literal (via `JSON.stringify`) and `createdAt` as a bare
 * number, so newlines, colons, quotes and any other characters in the field
 * values are handled safely without a third-party YAML dependency:
 *
 * ```
 * ---
 * name: "alpha"
 * description: "one-line summary"
 * type: "global"
 * createdAt: 1730000000000
 * cwd: ""
 * ---
 * <content, kept verbatim>
 * ```
 *
 * The parser reads this line-by-line format and remains backward compatible
 * with the legacy single-line JSON flow mapping (`---` / `{"name":...}` /
 * `---`). For workspace files, a stored `cwd` whose `workspaceSlug(cwd)` does
 * not match the directory slug is rejected (tamper protection), so a hand-
 * edited `cwd` cannot reassign a memory to another workspace's recall scope.
 *
 * Each directory carries a `MEMORY.md` index with one `- <name> - <description>`
 * line per active memory, sorted by name. `remove()` renames `<name>.md` to
 * `<name>.forgotten` (history is preserved on disk, and a name may be written
 * again afterwards); forgotten files are never returned by `list`, `get`, or
 * `scan`. `scan()` is the startup sync entry point: it walks the global and
 * workspace directories, parses every active `<name>.md`, warns about and
 * skips invalid/corrupt files, rebuilds each `MEMORY.md`, and returns the
 * active records. There is no file watcher.
 *
 * All I/O is synchronous (`node:fs`). Writes are atomic (same-directory temp
 * file with mode `0o600` + rename). Names are strictly validated against
 * `[A-Za-z0-9_-]+` (and may not be `MEMORY`), and every resolved path is
 * checked to stay inside `<home>/memories`, so untrusted input cannot escape
 * the memory root through directory traversal.
 *
 * Plain ESM JavaScript. Requires Node.js >= 22.
 *
 * @module memories
 */

import fs from "node:fs";
import path from "node:path";
import { workspaceSlug } from "./paths.js";

/** Index file name reserved in every memory directory. */
const INDEX_FILE = "MEMORY.md";

/** Default `maxEmbeddingChars` used when the config store is unavailable. */
const DEFAULT_MAX_CHARS = 8000;

/** Strict name pattern: ASCII letters, digits, `_` and `-` only. */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Error thrown for invalid inputs and conflicting operations. Carries a stable
 * `code` and an optional `details` object.
 */
export class MemoryError extends Error {
  /**
   * @param {string} code - Stable error code (e.g. `INVALID_NAME`).
   * @param {string} message - Human readable description.
   * @param {object|null} [details] - Extra structured context.
   */
  constructor(code, message, details = null) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Whether a value is a plain (non-array) object.
 *
 * @param {unknown} value - Value to test.
 * @returns {boolean} True when `value` is a non-null, non-array object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether a string is a valid memory name: matches {@link NAME_PATTERN} and is
 * not `MEMORY` (case-insensitive), which is reserved for the index file.
 *
 * @param {unknown} name - Candidate name.
 * @returns {boolean} True when the name is usable.
 */
function isValidName(name) {
  return (
    typeof name === "string" &&
    NAME_PATTERN.test(name) &&
    name.toLowerCase() !== "memory"
  );
}

/**
 * Log a warning through a logger; never throws.
 *
 * @param {{warn?: Function}|undefined} logger - Logger with a `warn` method.
 * @param {string} message - Warning text.
 */
function warn(logger, message) {
  if (!logger || typeof logger.warn !== "function") return;
  try {
    logger.warn(message);
  } catch {
    // A broken logger must not break the store.
  }
}

/**
 * Compare two strings with a locale-independent, deterministic order.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative, zero, or positive.
 */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare two memory records by name (the only ASCII-only field, so the plain
 * string order is deterministic).
 *
 * @param {object} a
 * @param {object} b
 * @returns {number} Negative, zero, or positive.
 */
function compareByName(a, b) {
  return compareStrings(a.name, b.name);
}

/**
 * Build a canonical memory record.
 *
 * @param {object} parts - Record parts.
 * @param {string} parts.type - `"global"` or `"workspace"`.
 * @param {string} parts.cwd - Original workspace directory (empty for global).
 * @param {string} parts.name - Validated memory name.
 * @param {string} parts.description - One-line description.
 * @param {string} parts.content - Body content.
 * @param {number} parts.createdAt - Epoch milliseconds of creation.
 * @returns {object} The memory record.
 */
function buildRecord({ type, cwd, name, description, content, createdAt }) {
  const scope = type === "global" ? "global" : workspaceSlug(cwd);
  return {
    pairId: `memory:${type}:${scope}:${name}`,
    recordType: "memory",
    memoryType: type,
    type,
    name,
    description,
    content,
    cwd: type === "global" ? "" : cwd,
    createdAt,
  };
}

/**
 * Convert a value to a finite number when it is a finite number or a numeric
 * string (bare or quoted); otherwise `null`.
 *
 * @param {unknown} value - Value to convert.
 * @returns {number|null} The number, or `null` when unconvertible.
 */
function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

/**
 * Whether a candidate front matter block (the lines between the fences) is
 * structurally valid: a single line that is a JSON object (the legacy flow
 * mapping), or one or more non-blank `key: value` lines.
 *
 * @param {Array<string>} fmLines - Lines between the opening and closing
 *   fences.
 * @returns {boolean} True when the block could be front matter.
 */
function isStructurallyValidFrontMatter(fmLines) {
  if (fmLines.length === 0) return false;
  if (fmLines.length === 1) {
    const line = fmLines[0].trim();
    if (line.length === 0) return false;
    try {
      if (isPlainObject(JSON.parse(line))) return true; // legacy flow mapping
    } catch {
      // Not JSON; fall through to the `key: value` check below.
    }
    const colon = line.indexOf(":");
    return colon > 0 && line.slice(colon + 1).trim().length > 0;
  }
  let nonBlank = 0;
  for (const line of fmLines) {
    if (line.trim().length === 0) continue;
    nonBlank += 1;
    const colon = line.indexOf(":");
    if (colon <= 0 || line.slice(colon + 1).trim().length === 0) return false;
  }
  return nonBlank > 0;
}

/**
 * Parse the front matter fields of a block.
 *
 * A single-line block is parsed as JSON (legacy flow mapping). A multi-line
 * block is parsed as line-by-line YAML: each line is split at the first
 * colon; a value starting with `"` must be a valid JSON string literal,
 * anything else is taken as a bare scalar (used for numbers and unquoted
 * values). Blank lines and unknown keys are ignored.
 *
 * @param {Array<string>} fmLines - Lines between the opening and closing
 *   fences.
 * @returns {{fields: object}|{error: string}} Parsed fields, or an error.
 */
function parseFrontMatterFields(fmLines) {
  if (fmLines.length === 1) {
    let fields;
    try {
      fields = JSON.parse(fmLines[0]);
    } catch {
      return { error: "front matter is not valid JSON" };
    }
    if (!isPlainObject(fields)) {
      return { error: "front matter must be a JSON object" };
    }
    return { fields };
  }

  const fields = {};
  for (const line of fmLines) {
    if (line.trim().length === 0) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      return { error: `malformed front matter line ${JSON.stringify(line)}` };
    }
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (key.length === 0 || rawValue.length === 0) {
      return { error: `malformed front matter line ${JSON.stringify(line)}` };
    }
    let value;
    if (rawValue.startsWith('"')) {
      try {
        value = JSON.parse(rawValue);
      } catch {
        return { error: `unparseable quoted value ${JSON.stringify(rawValue)}` };
      }
    } else {
      value = rawValue; // bare scalar (numbers, unquoted values)
    }
    fields[key] = value;
  }
  return { fields };
}

/**
 * Parse the front matter of a memory file.
 *
 * Expects `---` fences with a structurally valid block between them and the
 * body verbatim after the closing fence. Both the generated line-by-line
 * format (`name: "..."` etc.) and the legacy single-line JSON flow mapping are
 * accepted. Validates the field types (`name` valid, `description` a
 * non-empty single-line string, `type` matching the directory type,
 * `createdAt` a finite number). The body is returned verbatim, without
 * content checks (callers decide).
 *
 * @param {string} text - Raw file content.
 * @param {object} options - Options.
 * @param {"global"|"workspace"} options.dirType - Expected front matter type.
 * @returns {{fields: object, content: string}|{error: string}} Parsed front
 *   matter and body, or an error description.
 */
function parseFrontMatter(text, { dirType }) {
  if (typeof text !== "string" || !text.startsWith("---\n")) {
    return { error: "missing front matter fence" };
  }
  const lines = text.split("\n");

  // Find the closing fence: the first `---` line whose block is structurally
  // valid front matter, so a body containing a `---` line is not confused
  // with the fence.
  let fmLines = null;
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] !== "---") continue;
    const candidate = lines.slice(1, i);
    if (isStructurallyValidFrontMatter(candidate)) {
      fmLines = candidate;
      closeIndex = i;
      break;
    }
  }
  if (fmLines === null) {
    return { error: "malformed front matter block" };
  }
  const content = lines.slice(closeIndex + 1).join("\n");

  const parsed = parseFrontMatterFields(fmLines);
  if (parsed.error) return parsed;
  const fields = parsed.fields;

  const { name, description, type, createdAt } = fields;
  if (typeof name !== "string" || !isValidName(name)) {
    return { error: `invalid name ${JSON.stringify(name)}` };
  }
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    /[\r\n]/.test(description)
  ) {
    return { error: "description must be a non-empty single-line string" };
  }
  if (type !== dirType) {
    return { error: `type ${JSON.stringify(type)} does not match ${dirType}` };
  }
  if (toFiniteNumber(createdAt) === null) {
    return { error: "createdAt must be a finite number" };
  }

  return { fields, content };
}

/**
 * Parse a memory file into a full record.
 *
 * On top of {@link parseFrontMatter}, enforces the content rules: trimmed body
 * must be non-empty, and the stored body length must not exceed `maxChars`.
 * For workspace directories the record `cwd` is the front matter `cwd` when
 * present (it is written on every write) and must match the directory: a
 * stored `cwd` whose `workspaceSlug(cwd)` differs from `dirSlug` is rejected
 * (tamper protection). A file without a stored `cwd` falls back to `dirCwd`.
 *
 * @param {string} text - Raw file content.
 * @param {object} options - Options.
 * @param {"global"|"workspace"} options.dirType - Expected front matter type.
 * @param {string} options.dirCwd - Fallback workspace directory.
 * @param {string} options.dirSlug - Workspace directory slug (used for the
 *   tamper check; ignored for global).
 * @param {number} options.maxChars - Content character limit.
 * @returns {{record: object}|{error: string}} The record, or an error.
 */
function parseMemoryFile(text, { dirType, dirCwd, dirSlug, maxChars }) {
  const parsed = parseFrontMatter(text, { dirType });
  if (parsed.error) return parsed;

  const content = parsed.content;
  if (content.trim().length === 0) return { error: "content is empty" };
  if (content.length > maxChars) {
    return { error: `content exceeds the ${maxChars} character limit` };
  }

  let cwd = "";
  if (dirType === "workspace") {
    const storedCwd = parsed.fields.cwd;
    if (typeof storedCwd === "string" && storedCwd.length > 0) {
      if (workspaceSlug(storedCwd) !== dirSlug) {
        return {
          error: `cwd ${JSON.stringify(storedCwd)} does not match workspace directory ${dirSlug}`,
        };
      }
      cwd = storedCwd;
    } else {
      cwd = dirCwd;
    }
  }

  return {
    record: buildRecord({
      type: dirType,
      cwd,
      name: parsed.fields.name,
      description: parsed.fields.description,
      content,
      createdAt: toFiniteNumber(parsed.fields.createdAt),
    }),
  };
}

/**
 * Read and parse one memory file.
 *
 * A missing file returns `null` silently (that is the normal "not found"
 * case); unreadable or invalid files log a warning and return `null`.
 *
 * @param {string} filePath - Absolute path of the `<name>.md` file.
 * @param {object} options - Options.
 * @param {"global"|"workspace"} options.dirType - Expected front matter type.
 * @param {string} options.dirCwd - Fallback workspace directory.
 * @param {number} options.maxChars - Content character limit.
 * @param {{warn?: Function}|undefined} options.logger - Logger.
 * @param {string} options.label - Label used in warning messages.
 * @returns {object|null} The record, or `null` when missing/invalid.
 */
function readMemoryFile(filePath, { dirType, dirCwd, maxChars, logger, label }) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      warn(logger, `${label} read failed: ${error.message}`);
    }
    return null;
  }

  const parsed = parseMemoryFile(text, {
    dirType,
    dirCwd,
    dirSlug: path.basename(path.dirname(filePath)),
    maxChars,
  });
  if (parsed.error) {
    warn(logger, `${label} skipped: ${parsed.error}`);
    return null;
  }
  const expectedName = path.basename(filePath, ".md");
  if (parsed.record.name !== expectedName) {
    warn(
      logger,
      `${label} skipped: front matter name ${parsed.record.name} does not match filename ${expectedName}`,
    );
    return null;
  }
  return parsed.record;
}

/**
 * List the active memory records in one memory directory.
 *
 * Only `<name>.md` files are considered (`MEMORY.md` and non-`.md` files such
 * as `<name>.forgotten` or temp files are ignored). Records are sorted by
 * name. A missing directory yields an empty list.
 *
 * @param {string} dir - Memory directory (global or workspace).
 * @param {object} options - Options.
 * @param {"global"|"workspace"} options.dirType - Expected front matter type.
 * @param {string} options.dirCwd - Fallback workspace directory.
 * @param {number} options.maxChars - Content character limit.
 * @param {{warn?: Function}|undefined} options.logger - Logger.
 * @param {string} options.label - Label used in warning messages.
 * @returns {Array<object>} Active records sorted by name.
 */
function listDirRecords(dir, { dirType, dirCwd, maxChars, logger, label }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      warn(logger, `${label} failed: ${error.message}`);
    }
    return [];
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === INDEX_FILE) {
      continue;
    }
    const record = readMemoryFile(path.join(dir, entry.name), {
      dirType,
      dirCwd,
      maxChars,
      logger,
      label: `${label}: ${entry.name}`,
    });
    if (record) records.push(record);
  }
  records.sort(compareByName);
  return records;
}

/**
 * Atomically write a file via a same-directory temp file created with mode
 * `0o600`, then rename it over the destination.
 *
 * @param {string} filePath - Destination file path.
 * @param {string} content - Content to write.
 * @param {number} [mode] - File mode; defaults to `0o600`.
 * @throws {Error} On any filesystem failure.
 */
function writeFileAtomic(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, content, { mode });
  fs.renameSync(tempPath, filePath);
}

/**
 * Rebuild the `MEMORY.md` index of a directory from its active records.
 *
 * Lines are `- <name> - <description>`, one per record, sorted by name. An
 * empty directory gets an empty (zero-byte) index.
 *
 * @param {string} dir - Memory directory.
 * @param {Array<object>} records - Active records sorted by name.
 */
function rebuildIndex(dir, records) {
  const lines = records.map((record) => `- ${record.name} - ${record.description}`);
  const text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  writeFileAtomic(path.join(dir, INDEX_FILE), text);
}

/**
 * Serialize the front matter block for a memory file.
 *
 * Emits line-by-line YAML fields between `---` fences: one `key: value` line
 * per field. String values are JSON double-quoted literals (safe for
 * newlines, colons, quotes and any other characters), `createdAt` is a bare
 * number, and `cwd` is a JSON string. The body follows verbatim.
 *
 * @param {object} fields - Front matter fields.
 * @returns {string} The front matter block.
 */
function serializeFrontMatter(fields) {
  const lines = [
    `name: ${JSON.stringify(fields.name)}`,
    `description: ${JSON.stringify(fields.description)}`,
    `type: ${JSON.stringify(fields.type)}`,
    `createdAt: ${fields.createdAt}`,
    `cwd: ${JSON.stringify(fields.cwd)}`,
  ];
  return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * Throw a MemoryError for an invalid `type`.
 *
 * @param {unknown} type - Candidate type.
 * @throws {MemoryError} Code `INVALID_TYPE` unless `"global"` or `"workspace"`.
 */
function checkType(type) {
  if (type !== "global" && type !== "workspace") {
    throw new MemoryError(
      "INVALID_TYPE",
      `type must be "global" or "workspace"`,
      { type },
    );
  }
}

/**
 * Throw a MemoryError for an invalid memory name.
 *
 * @param {unknown} name - Candidate name.
 * @throws {MemoryError} Code `INVALID_NAME` when the name is unusable.
 */
function checkName(name) {
  if (!isValidName(name)) {
    throw new MemoryError(
      "INVALID_NAME",
      `name must match ${NAME_PATTERN.source} and not be "MEMORY"`,
      { name },
    );
  }
}

/**
 * Throw a MemoryError when a workspace operation lacks a `cwd`.
 *
 * @param {unknown} cwd - Candidate workspace directory.
 * @throws {MemoryError} Code `MISSING_CWD` when `cwd` is not a non-empty
 *   string.
 */
function checkWorkspaceCwd(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new MemoryError(
      "MISSING_CWD",
      "workspace memories require the current cwd",
    );
  }
}

/**
 * Throw a MemoryError for an invalid description.
 *
 * @param {unknown} description - Candidate description.
 * @throws {MemoryError} Code `INVALID_DESCRIPTION` when the description is not
 *   a non-empty, single-line string.
 */
function checkDescription(description) {
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    /[\r\n]/.test(description)
  ) {
    throw new MemoryError(
      "INVALID_DESCRIPTION",
      "description must be a non-empty single-line string",
    );
  }
}

/**
 * Throw a MemoryError for invalid content.
 *
 * @param {unknown} content - Candidate content.
 * @param {number} maxChars - Character limit.
 * @throws {MemoryError} Code `INVALID_CONTENT` for missing/empty content, or
 *   `CONTENT_TOO_LONG` when the content exceeds `maxChars` characters.
 */
function checkContent(content, maxChars) {
  if (typeof content !== "string") {
    throw new MemoryError("INVALID_CONTENT", "content must be a string");
  }
  if (content.trim().length === 0) {
    throw new MemoryError(
      "INVALID_CONTENT",
      "content must not be empty after trimming",
    );
  }
  if (content.length > maxChars) {
    throw new MemoryError(
      "CONTENT_TOO_LONG",
      `content exceeds the ${maxChars} character limit`,
      { maxChars, length: content.length },
    );
  }
}

/**
 * Create a memory store bound to a home directory.
 *
 * The store is a small synchronous object with `list`, `get`, `write`,
 * `remove` and `scan`. Input validation throws {@link MemoryError}; file
 * scanning and reading are fail-open (invalid or unreadable files are skipped
 * with a warning, never thrown).
 *
 * @param {object} options - Options.
 * @param {string} options.home - DSH home directory that holds `memories/`.
 * @param {{get: () => object}} [options.configStore] - Config store; its
 *   `get().embedding.maxEmbeddingChars` sets the content character limit
 *   (default `8000` when unavailable).
 * @param {{warn?: Function}} [options.logger] - Logger whose `warn` method is
 *   used for skipped files; defaults to `console`.
 * @param {() => number} [options.now] - Clock returning epoch milliseconds;
 *   defaults to `Date.now`. Injectable for tests.
 * @returns {{
 *   home: string,
 *   list: (options: object) => Array<object>,
 *   get: (options: object) => object|null,
 *   write: (options: object) => {action: string, record: object},
 *   remove: (options: object) => {record: object}|null,
 *   scan: () => Array<object>,
 * }} The memory store.
 */
export function createMemoryStore({ home, configStore, logger = console, now = () => Date.now() } = {}) {
  if (typeof home !== "string" || home.length === 0) {
    throw new MemoryError("INVALID_INPUT", "home is required");
  }

  const storeHome = path.resolve(home);

  /**
   * Resolve the configured content character limit.
   *
   * @returns {number} `embedding.maxEmbeddingChars` from the config store, or
   *   {@link DEFAULT_MAX_CHARS} when unavailable/invalid.
   */
  function maxChars() {
    try {
      const value = configStore?.get()?.embedding?.maxEmbeddingChars;
      return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_CHARS;
    } catch {
      return DEFAULT_MAX_CHARS;
    }
  }

  /**
   * Absolute path of the memory directory for a type.
   *
   * @param {"global"|"workspace"} type - Memory type.
   * @param {string} cwd - Workspace directory (ignored for global).
   * @returns {string} The container directory.
   */
  function containerDir(type, cwd) {
    if (type === "global") {
      return path.join(storeHome, "memories", "global");
    }
    return path.join(storeHome, "memories", "workspaces", workspaceSlug(cwd));
  }

  /**
   * Throw when a resolved path escapes the memory root.
   *
   * @param {string} target - Path to check.
   * @throws {MemoryError} Code `INVALID_INPUT` when the path escapes.
   */
  function assertWithinRoot(target) {
    const base = path.resolve(storeHome);
    const resolved = path.resolve(target);
    if (
      resolved !== base &&
      !resolved.startsWith(base + path.sep)
    ) {
      throw new MemoryError(
        "INVALID_INPUT",
        `path escapes the memory root: ${target}`,
      );
    }
  }

  /**
   * Absolute path of the `<name>.md` file for a memory, after traversal
   * checks.
   *
   * @param {"global"|"workspace"} type - Memory type.
   * @param {string} cwd - Workspace directory (ignored for global).
   * @param {string} name - Validated memory name.
   * @returns {string} The memory file path.
   */
  function memoryFilePath(type, cwd, name) {
    const filePath = path.join(containerDir(type, cwd), `${name}.md`);
    assertWithinRoot(filePath);
    return filePath;
  }

  /**
   * Scan one memory directory: read its active records and rebuild its
   * index.
   *
   * @param {string} dir - Memory directory.
   * @param {object} options - Options.
   * @param {"global"|"workspace"} options.dirType - Expected front matter
   *   type.
   * @param {string} options.dirCwd - Fallback workspace directory.
   * @param {number} options.maxChars - Content character limit.
   * @returns {Array<object>} Active records sorted by name.
   */
  function scanDir(dir, { dirType, dirCwd, maxChars: limit }) {
    const records = listDirRecords(dir, {
      dirType,
      dirCwd,
      maxChars: limit,
      logger,
      label: `memories scan ${dir}`,
    });
    rebuildIndex(dir, records);
    return records;
  }

  return {
    /**
     * Resolved absolute home directory.
     *
     * @type {string}
     */
    home: storeHome,

    /**
     * List the active memory records of one type.
     *
     * Records are read from disk and sorted by name. Invalid files are
     * skipped with a warning. For `type: "workspace"` the current `cwd` is
     * required and locates the workspace directory; for `type: "global"` a
     * passed `cwd` is ignored and records carry an empty `cwd`.
     *
     * @param {object} options - Options.
     * @param {"global"|"workspace"} options.type - Memory type.
     * @param {string} [options.cwd] - Current workspace directory.
     * @returns {Array<object>} Active records.
     * @throws {MemoryError} For an invalid type or a missing workspace `cwd`.
     */
    list({ type, cwd } = {}) {
      checkType(type);
      if (type === "workspace") checkWorkspaceCwd(cwd);
      return listDirRecords(containerDir(type, cwd), {
        dirType: type,
        dirCwd: type === "workspace" ? cwd : "",
        maxChars: maxChars(),
        logger,
        label: `memories list ${type}`,
      });
    },

    /**
     * Read one memory by name.
     *
     * @param {object} options - Options.
     * @param {"global"|"workspace"} options.type - Memory type.
     * @param {string} [options.cwd] - Current workspace directory (required
     *   for `type: "workspace"`).
     * @param {string} options.name - Memory name.
     * @returns {object|null} The record, or `null` when the memory does not
     *   exist or its file is invalid.
     * @throws {MemoryError} For an invalid type, name, or missing workspace
     *   `cwd`.
     */
    get({ type, cwd, name } = {}) {
      checkType(type);
      checkName(name);
      if (type === "workspace") checkWorkspaceCwd(cwd);

      const dir = containerDir(type, cwd);
      const filePath = path.join(dir, `${name}.md`);
      assertWithinRoot(filePath);
      return readMemoryFile(filePath, {
        dirType: type,
        dirCwd: type === "workspace" ? cwd : "",
        maxChars: maxChars(),
        logger,
        label: `memories get ${name}`,
      });
    },

    /**
     * Create or overwrite a memory.
     *
     * Writes the `<name>.md` file atomically and rebuilds the directory index.
     * An existing active memory keeps its `createdAt` and yields
     * `action: "updated"`; otherwise a fresh `createdAt` is assigned and
     * `action` is `"created"`. The content is stored verbatim; only the
     * character limit applies (no truncation). An existing `<name>.forgotten`
     * file is never touched.
     *
     * @param {object} options - Options.
     * @param {"global"|"workspace"} options.type - Memory type.
     * @param {string} [options.cwd] - Current workspace directory (required
     *   for `type: "workspace"`); stored verbatim on the record.
     * @param {string} options.name - Memory name.
     * @param {string} options.description - One-line description.
     * @param {string} options.content - Body content.
     * @returns {{action: "created"|"updated", record: object}} The outcome and
     *   the stored record.
     * @throws {MemoryError} For any invalid input.
     */
    write({ type, cwd, name, description, content } = {}) {
      checkType(type);
      checkName(name);
      if (type === "workspace") checkWorkspaceCwd(cwd);
      checkDescription(description);

      const limit = maxChars();
      checkContent(content, limit);

      const dir = containerDir(type, cwd);
      const filePath = memoryFilePath(type, cwd, name);
      const recordCwd = type === "global" ? "" : cwd;

      // Preserve the createdAt of an existing valid active memory.
      let createdAt = now();
      let action = "created";
      const existing = readMemoryFile(filePath, {
        dirType: type,
        dirCwd: recordCwd,
        maxChars: limit,
        logger,
        label: `memories write existing ${name}`,
      });
      if (existing) {
        createdAt = existing.createdAt;
        action = "updated";
      }

      const fields = {
        name,
        description,
        type,
        createdAt,
        cwd: recordCwd,
      };
      writeFileAtomic(filePath, serializeFrontMatter(fields) + content);
      rebuildIndex(
        dir,
        listDirRecords(dir, {
          dirType: type,
          dirCwd: recordCwd,
          maxChars: limit,
          logger,
          label: `memories index ${type}`,
        }),
      );

      return {
        action,
        record: buildRecord({
          type,
          cwd: recordCwd,
          name,
          description,
          content,
          createdAt,
        }),
      };
    },

    /**
     * Forget a memory.
     *
     * Only when the stored front matter `name` and `description` both match
     * the arguments exactly is `<name>.md` renamed to `<name>.forgotten`, the
     * index rebuilt, and the removed record returned. A missing or invalid
     * file, or a name/description mismatch, leaves everything untouched and
     * returns `null`. When `<name>.forgotten` already exists the rename would
     * overwrite history, so a {@link MemoryError} with code
     * `FORGOTTEN_CONFLICT` is thrown instead.
     *
     * @param {object} options - Options.
     * @param {"global"|"workspace"} options.type - Memory type.
     * @param {string} [options.cwd] - Current workspace directory (required
     *   for `type: "workspace"`).
     * @param {string} options.name - Memory name.
     * @param {string} options.description - Exact description to match.
     * @returns {{record: object}|null} The removed record, or `null` when
     *   nothing matched.
     * @throws {MemoryError} For invalid input or a forgotten-file conflict.
     */
    remove({ type, cwd, name, description } = {}) {
      checkType(type);
      checkName(name);
      if (type === "workspace") checkWorkspaceCwd(cwd);
      checkDescription(description);

      const filePath = memoryFilePath(type, cwd, name);
      const dir = containerDir(type, cwd);
      const forgottenPath = path.join(dir, `${name}.forgotten`);
      assertWithinRoot(forgottenPath);

      // Parse the front matter without content checks: exact matching only
      // needs the stored name and description, and an overlong/corrupt body
      // must still be forgettable.
      let text;
      try {
        text = fs.readFileSync(filePath, "utf8");
      } catch (error) {
        if (error && error.code !== "ENOENT") {
          warn(logger, `memories remove ${name} read failed: ${error.message}`);
        }
        return null;
      }
      const parsed = parseFrontMatter(text, { dirType: type });
      if (parsed.error) {
        warn(logger, `memories remove ${name} skipped: ${parsed.error}`);
        return null;
      }
      if (parsed.fields.name !== name || parsed.fields.description !== description) {
        return null;
      }

      if (fs.existsSync(forgottenPath)) {
        throw new MemoryError(
          "FORGOTTEN_CONFLICT",
          `a forgotten file already exists for ${name}; refusing to overwrite history`,
          { name },
        );
      }

      try {
        fs.renameSync(filePath, forgottenPath);
      } catch (error) {
        if (error && error.code === "ENOENT") return null;
        throw error;
      }

      const recordCwd = type === "global" ? "" : cwd;
      rebuildIndex(
        dir,
        listDirRecords(dir, {
          dirType: type,
          dirCwd: recordCwd,
          maxChars: maxChars(),
          logger,
          label: `memories index ${type}`,
        }),
      );

      return {
        record: buildRecord({
          type,
          cwd: recordCwd,
          name: parsed.fields.name,
          description: parsed.fields.description,
          content: parsed.content,
          createdAt: toFiniteNumber(parsed.fields.createdAt),
        }),
      };
    },

    /**
     * Startup synchronization: walk every memory directory and rebuild it.
     *
     * Reads the global directory and every workspace directory under
     * `memories/workspaces`, parses all active `<name>.md` files, skips
     * invalid/corrupt files with a warning, rebuilds each `MEMORY.md` index
     * from the surviving records, and returns them all. `.forgotten` files
     * are never read or modified. Missing directories yield nothing. This is
     * the startup sync entry point; there is no file watcher.
     *
     * @returns {Array<object>} All active records, global first then
     *   workspaces (each sorted by name).
     */
    scan() {
      const limit = maxChars();
      const all = [];

      const globalDir = path.join(storeHome, "memories", "global");
      const globalRecords = scanDir(globalDir, {
        dirType: "global",
        dirCwd: "",
        maxChars: limit,
      });
      all.push(...globalRecords);

      const workspacesDir = path.join(storeHome, "memories", "workspaces");
      let workspaceEntries;
      try {
        workspaceEntries = fs.readdirSync(workspacesDir, { withFileTypes: true });
      } catch (error) {
        if (error && error.code !== "ENOENT") {
          warn(logger, `memories scan workspaces failed: ${error.message}`);
        }
        workspaceEntries = [];
      }

      const slugs = workspaceEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(compareStrings);
      for (const slug of slugs) {
        const dir = path.join(workspacesDir, slug);
        const records = scanDir(dir, {
          dirType: "workspace",
          dirCwd: dir,
          maxChars: limit,
        });
        all.push(...records);
      }
      return all;
    },
  };
}
