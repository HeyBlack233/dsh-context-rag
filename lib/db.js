/**
 * SQLite index database for `dsh-context-rag`.
 *
 * Every pair record and memory record is indexed in the `pairs` table
 * together with its embedding (stored as a little-endian Float32Array blob),
 * while work that still needs an embedding (or a re-embedding after a text
 * change) is queued in the `outbox` table. Conversations are stored as pairs
 * (`record_type = 'pair'`); memories share the same table with
 * `record_type = 'memory'` and carry their `memory_type` (`'global'` or
 * `'workspace'`), `name`, and `description`. The database is opened through
 * the synchronous `node:sqlite` API; prepared statements are cached per SQL
 * string. Pre-memory databases are migrated non-destructively: the new
 * columns are added via `ALTER TABLE` and existing rows default to
 * `record_type = 'pair'`.
 *
 * @module db
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { textHash } from "./paths.js";
import { validatePair } from "./pairs.js";

/** Current schema version, recorded in `meta.schema_version`. */
const SCHEMA_VERSION = "2";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pairs (
  pair_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  turn INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  user_text TEXT NOT NULL,
  assistant_text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  record_type TEXT NOT NULL DEFAULT 'pair',
  memory_type TEXT,
  name TEXT,
  description TEXT,
  embedding BLOB,
  dim INTEGER,
  model TEXT,
  indexed_at INTEGER
);
CREATE TABLE IF NOT EXISTS outbox (
  pair_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairs_cwd_created_at ON pairs (cwd, created_at);
CREATE INDEX IF NOT EXISTS idx_pairs_model_dim ON pairs (model, dim);
`;

/**
 * Serialize a Float32Array into a little-endian byte blob for storage in the
 * `embedding` column. Every value must be finite and the vector must be
 * non-empty.
 *
 * @param {Float32Array} vector - Embedding vector.
 * @returns {Buffer} `vector.length * 4` bytes, little-endian.
 * @throws {TypeError} When `vector` is not a Float32Array.
 * @throws {RangeError} When the vector is empty or contains a non-finite
 *   value.
 */
export function vectorToBlob(vector) {
  if (!(vector instanceof Float32Array)) {
    throw new TypeError("vector must be a Float32Array");
  }
  if (vector.length === 0) {
    throw new RangeError("vector must not be empty");
  }
  const buffer = new ArrayBuffer(vector.length * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i];
    if (!Number.isFinite(value)) {
      throw new RangeError(`vector contains a non-finite value at index ${i}`);
    }
    view.setFloat32(i * 4, value, true);
  }
  return Buffer.from(buffer);
}

/**
 * Decode a little-endian byte blob back into a Float32Array of exactly `dim`
 * values. The blob length must be exactly `dim * 4` bytes and every decoded
 * value must be finite.
 *
 * @param {Uint8Array} blob - Byte blob as read from the `embedding` column.
 * @param {number} dim - Expected vector dimension.
 * @returns {Float32Array} Decoded vector.
 * @throws {TypeError} When `blob` is not a Uint8Array.
 * @throws {RangeError} When `dim` is not a positive integer, the blob length
 *   is wrong, or a decoded value is non-finite.
 */
export function vectorFromBlob(blob, dim) {
  if (!(blob instanceof Uint8Array)) {
    throw new TypeError("blob must be a Uint8Array");
  }
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new RangeError("dim must be a positive integer");
  }
  if (blob.length !== dim * 4) {
    throw new RangeError(`blob length ${blob.length} does not match dim ${dim}`);
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const vector = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) {
    const value = view.getFloat32(i * 4, true);
    if (!Number.isFinite(value)) {
      throw new RangeError(`blob contains a non-finite value at index ${i}`);
    }
    vector[i] = value;
  }
  return vector;
}

/**
 * Open (creating if needed) the index database at `file`.
 *
 * The parent directory is created on demand and the file is opened in WAL
 * mode with `synchronous = NORMAL` and a 5000 ms busy timeout. The schema is
 * created idempotently (with a non-destructive migration for databases from
 * before memory support) and `schema_version = 2` is recorded in `meta`.
 *
 * @param {string} file - Path of the SQLite database file.
 * @param {object} [options]
 * @param {{warn?: (message: string) => void}} [options.logger] - Optional
 *   logger, currently unused but accepted for future diagnostics.
 * @returns {object} The database handle: `path` (resolved absolute file
 *   path), `raw` (the underlying `DatabaseSync`), `close()`, and the methods
 *   below.
 */
export function openIndexDatabase(file, { logger } = {}) {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA synchronous = NORMAL;");
  raw.exec("PRAGMA busy_timeout = 5000;");
  raw.exec(SCHEMA_SQL);

  // Non-destructive migration for databases created before memory support:
  // `CREATE TABLE IF NOT EXISTS` never alters an existing table, so add the
  // new columns explicitly. Existing rows keep `record_type = 'pair'` (the
  // DEFAULT) and `NULL` optional fields.
  const pairColumns = new Set(
    raw.prepare("PRAGMA table_info(pairs)").all().map((row) => row.name),
  );
  if (!pairColumns.has("record_type")) {
    raw.exec("ALTER TABLE pairs ADD COLUMN record_type TEXT NOT NULL DEFAULT 'pair'");
  }
  if (!pairColumns.has("memory_type")) {
    raw.exec("ALTER TABLE pairs ADD COLUMN memory_type TEXT");
  }
  if (!pairColumns.has("name")) {
    raw.exec("ALTER TABLE pairs ADD COLUMN name TEXT");
  }
  if (!pairColumns.has("description")) {
    raw.exec("ALTER TABLE pairs ADD COLUMN description TEXT");
  }
  raw
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(SCHEMA_VERSION);

  /** Cache of prepared statements keyed by SQL text. @type {Map<string, import("node:sqlite").StatementSync>} */
  const statements = new Map();
  /** @param {string} sql @returns {import("node:sqlite").StatementSync} */
  function stmt(sql) {
    let statement = statements.get(sql);
    if (statement === undefined) {
      statement = raw.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * Read one metadata value.
   *
   * @param {string} key
   * @returns {string|null} The stored value, or `null` when absent.
   */
  function metaGet(key) {
    const row = stmt("SELECT value FROM meta WHERE key = ?").get(key);
    return row === undefined ? null : row.value;
  }

  /**
   * Write (or overwrite) one metadata value.
   *
   * @param {string} key
   * @param {string} value
   * @returns {string} The stored value.
   */
  function metaSet(key, value) {
    const text = String(value);
    stmt(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, text);
    return text;
  }

  /**
   * Enqueue (or update) an outbox entry for one pair.
   *
   * @param {string} pairId
   * @param {string} reason - Stable reason (`new`, `text-changed`, ...).
   * @param {object} [options]
   * @param {boolean} [options.resetAttempts] - When true, reset `attempts` to
   *   zero and `next_at` to now-so-it-is-due; otherwise keep both.
   * @returns {void}
   */
  function enqueue(pairId, reason, { resetAttempts = false } = {}) {
    stmt(
      `INSERT INTO outbox (pair_id, reason) VALUES (?, ?)
       ON CONFLICT(pair_id) DO UPDATE SET
         reason = excluded.reason,
         attempts = CASE WHEN ? THEN 0 ELSE outbox.attempts END,
         next_at = CASE WHEN ? THEN 0 ELSE outbox.next_at END,
         last_error = NULL`,
    ).run(pairId, reason, resetAttempts ? 1 : 0, resetAttempts ? 1 : 0);
  }

  /**
   * Upsert one pair record into the index.
   *
   * `text_hash` is derived from the pair text via `textHash(user + "\0" +
   * assistant)`. A new pair enqueues reason `new`. A re-upsert with the same
   * hash refreshes metadata and preserves the stored embedding. A changed
   * hash clears the embedding and enqueues reason `text-changed` with
   * `resetAttempts` (so a stale embedding is recomputed promptly).
   *
   * @param {object} record - Pair record (see `validatePair`).
   * @returns {object} The normalized record.
   */
  function upsertPair(record) {
    const pair = validatePair(record);
    const hash = textHash(`${pair.user}\u0000${pair.assistant}`);
    const existing = stmt("SELECT text_hash FROM pairs WHERE pair_id = ?").get(pair.pairId);
    if (existing === undefined) {
      stmt(
        `INSERT INTO pairs (pair_id, session_id, cwd, turn, created_at, user_text, assistant_text, text_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(pair.pairId, pair.sessionId, pair.cwd, pair.turn, pair.createdAt, pair.user, pair.assistant, hash);
      enqueue(pair.pairId, "new");
    } else if (existing.text_hash === hash) {
      stmt(
        `UPDATE pairs
         SET session_id = ?, cwd = ?, turn = ?, created_at = ?, user_text = ?, assistant_text = ?
         WHERE pair_id = ?`,
      ).run(pair.sessionId, pair.cwd, pair.turn, pair.createdAt, pair.user, pair.assistant, pair.pairId);
    } else {
      stmt(
        `UPDATE pairs
         SET session_id = ?, cwd = ?, turn = ?, created_at = ?, user_text = ?, assistant_text = ?,
             text_hash = ?, embedding = NULL, dim = NULL, model = NULL, indexed_at = NULL
         WHERE pair_id = ?`,
      ).run(
        pair.sessionId,
        pair.cwd,
        pair.turn,
        pair.createdAt,
        pair.user,
        pair.assistant,
        hash,
        pair.pairId,
      );
      enqueue(pair.pairId, "text-changed", { resetAttempts: true });
    }
    return pair;
  }

  /**
   * Normalize and validate a memory record.
   *
   * Returns a canonical copy containing exactly the fields the index stores.
   * Rules: `pairId` must be a non-empty string (trimmed); `memoryType` must
   * be `"global"` or `"workspace"` (defaults to `"workspace"`); `cwd` must be
   * a string; `content` must be a string; `createdAt` must be a finite
   * number. `name` and `description` are optional and default to `""`.
   *
   * @param {object} record - Candidate memory record.
   * @returns {object} Normalized record.
   * @throws {TypeError} Code when any field fails validation.
   */
  function validateMemory(record) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError("memory record must be a plain object");
    }
    if (typeof record.pairId !== "string" || record.pairId.trim().length === 0) {
      throw new TypeError("memory pairId must be a non-empty string");
    }
    const memoryType = record.memoryType ?? "workspace";
    if (memoryType !== "global" && memoryType !== "workspace") {
      throw new TypeError('memoryType must be "global" or "workspace"');
    }
    if (typeof record.cwd !== "string") {
      throw new TypeError("memory cwd must be a string");
    }
    if (typeof record.content !== "string") {
      throw new TypeError("memory content must be a string");
    }
    if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) {
      throw new TypeError("memory createdAt must be a finite number");
    }
    return {
      pairId: record.pairId.trim(),
      memoryType,
      cwd: record.cwd,
      createdAt: record.createdAt,
      content: record.content,
      name: typeof record.name === "string" ? record.name : "",
      description: typeof record.description === "string" ? record.description : "",
    };
  }

  /**
   * Upsert one memory record into the index.
   *
   * `text_hash` is derived from the memory content alone. A new memory
   * enqueues reason `new`. A re-upsert with the same hash refreshes metadata
   * and preserves the stored embedding. A changed hash clears the embedding
   * and enqueues reason `text-changed` with `resetAttempts` (so a stale
   * embedding is recomputed promptly).
   *
   * Memories share the `pairs` table: `user_text` holds the content,
   * `assistant_text` is `""`, `session_id` is `""`, `turn` is `0`, and `cwd`
   * is the record's workspace path — or `""` for `global` memories.
   *
   * @param {object} record - Memory record (see `validateMemory`).
   * @returns {object} The normalized record.
   */
  function upsertMemory(record) {
    const memory = validateMemory(record);
    const cwd = memory.memoryType === "global" ? "" : memory.cwd;
    const hash = textHash(memory.content);
    const existing = stmt("SELECT text_hash FROM pairs WHERE pair_id = ?").get(memory.pairId);
    if (existing === undefined) {
      stmt(
        `INSERT INTO pairs
           (pair_id, session_id, cwd, turn, created_at, user_text, assistant_text, text_hash,
            record_type, memory_type, name, description)
         VALUES (?, '', ?, 0, ?, ?, '', ?, 'memory', ?, ?, ?)`,
      ).run(
        memory.pairId,
        cwd,
        memory.createdAt,
        memory.content,
        hash,
        memory.memoryType,
        memory.name,
        memory.description,
      );
      enqueue(memory.pairId, "new");
    } else if (existing.text_hash === hash) {
      stmt(
        `UPDATE pairs
         SET cwd = ?, created_at = ?, user_text = ?, memory_type = ?, name = ?, description = ?
         WHERE pair_id = ?`,
      ).run(cwd, memory.createdAt, memory.content, memory.memoryType, memory.name, memory.description, memory.pairId);
    } else {
      stmt(
        `UPDATE pairs
         SET cwd = ?, created_at = ?, user_text = ?, memory_type = ?, name = ?, description = ?,
             text_hash = ?, embedding = NULL, dim = NULL, model = NULL, indexed_at = NULL
         WHERE pair_id = ?`,
      ).run(
        cwd,
        memory.createdAt,
        memory.content,
        memory.memoryType,
        memory.name,
        memory.description,
        hash,
        memory.pairId,
      );
      enqueue(memory.pairId, "text-changed", { resetAttempts: true });
    }
    return memory;
  }

  /**
   * Record that a pair still exists on disk during a reconciliation pass.
   *
   * @param {string} pairId
   * @returns {void}
   */
  function markSeen(pairId) {
    stmt("INSERT OR IGNORE INTO reconcile_seen (pair_id) VALUES (?)").run(pairId);
  }

  /**
   * Begin a reconciliation pass: create (if needed) the `reconcile_seen`
   * temp table and clear it. Callers then `markSeen` every pair found on
   * disk and finish with `finishReconcile`.
   *
   * @returns {void}
   */
  function beginReconcile() {
    raw.exec("CREATE TEMP TABLE IF NOT EXISTS reconcile_seen (pair_id TEXT PRIMARY KEY)");
    raw.exec("DELETE FROM reconcile_seen");
  }

  /**
   * Finish a reconciliation pass: delete every indexed pair that was not
   * marked seen, together with its outbox entry.
   *
   * @returns {{pairsDeleted: number, outboxDeleted: number}} Number of rows
   *   removed from each table.
   */
  function finishReconcile() {
    const outboxDeleted = stmt(
      `DELETE FROM outbox
       WHERE pair_id IN (SELECT pair_id FROM pairs WHERE pair_id NOT IN (SELECT pair_id FROM reconcile_seen))`,
    ).run().changes;
    const pairsDeleted = stmt(
      "DELETE FROM pairs WHERE pair_id NOT IN (SELECT pair_id FROM reconcile_seen)",
    ).run().changes;
    return { pairsDeleted, outboxDeleted };
  }

  /**
   * Delete one pair and its outbox entry.
   *
   * @param {string} pairId
   * @returns {boolean} Whether a pair row existed and was deleted.
   */
  function deletePair(pairId) {
    const changes = stmt("DELETE FROM pairs WHERE pair_id = ?").run(pairId).changes;
    stmt("DELETE FROM outbox WHERE pair_id = ?").run(pairId);
    return changes > 0;
  }

  /**
   * Enqueue every indexed pair with the given reason, keeping existing
   * attempts/next_at values. Existing outbox rows have their reason updated;
   * pairs without an outbox row are inserted.
   *
   * @param {string} reason
   * @returns {number} Number of outbox rows inserted or updated.
   */
  function enqueueAll(reason) {
    const updated = stmt(
      "UPDATE outbox SET reason = ? WHERE pair_id IN (SELECT pair_id FROM pairs)",
    ).run(reason).changes;
    const inserted = stmt(
      "INSERT INTO outbox (pair_id, reason) SELECT pair_id, ? FROM pairs WHERE pair_id NOT IN (SELECT pair_id FROM outbox)",
    ).run(reason).changes;
    return inserted + updated;
  }

  /**
   * Claim outbox entries whose `next_at` has passed, ordered by `next_at`
   * (then `pair_id` for determinism). This does not increment `attempts`;
   * use `failPair` for that.
   *
   * @param {number} now - Epoch milliseconds threshold.
   * @param {number} [limit] - Maximum number of entries; defaults to 100.
   * @returns {Array<{pairId: string, attempts: number, reason: string}>}
   */
  function claimDue(now, limit) {
    const lim = Number.isInteger(limit) && limit > 0 ? limit : 100;
    const rows = stmt(
      "SELECT pair_id, attempts, reason FROM outbox WHERE next_at <= ? ORDER BY next_at, pair_id LIMIT ?",
    ).all(now, lim);
    return rows.map((row) => ({
      pairId: row.pair_id,
      attempts: row.attempts,
      reason: row.reason,
    }));
  }

  /**
   * Read one record (pair or memory) with its decoded embedding vector.
   *
   * @param {string} pairId
   * @returns {object|null} `{pairId, sessionId, cwd, turn, createdAt,
   *   userText, assistantText, textHash, recordType, memoryType, name,
   *   description, vector, dim, model, indexedAt}`, or `null` when the record
   *   does not exist. `vector` is null when no embedding is stored. For
   *   memories, `recordType` is `"memory"` and `userText` holds the content;
   *   for conversations `recordType` is `"pair"`.
   */
  function getPair(pairId) {
    const row = stmt(
      `SELECT pair_id, session_id, cwd, turn, created_at, user_text, assistant_text,
              text_hash, record_type, memory_type, name, description,
              embedding, dim, model, indexed_at
       FROM pairs WHERE pair_id = ?`,
    ).get(pairId);
    if (row === undefined) {
      return null;
    }
    return {
      pairId: row.pair_id,
      sessionId: row.session_id,
      cwd: row.cwd,
      turn: row.turn,
      createdAt: row.created_at,
      userText: row.user_text,
      assistantText: row.assistant_text,
      textHash: row.text_hash,
      recordType: row.record_type ?? "pair",
      memoryType: row.memory_type ?? null,
      name: row.name ?? "",
      description: row.description ?? "",
      vector: row.embedding === null ? null : vectorFromBlob(row.embedding, row.dim),
      dim: row.dim,
      model: row.model,
      indexedAt: row.indexed_at,
    };
  }

  /**
   * Store the embedding for a pair, record model/dim/indexed_at, and clear
   * the pair's outbox entry (the work is done).
   *
   * @param {string} pairId
   * @param {Float32Array} vector - Embedding vector; length must equal `dim`.
   * @param {object} meta
   * @param {string} meta.model - Non-empty model identifier.
   * @param {number} meta.dim - Positive integer dimension.
   * @returns {void}
   * @throws {TypeError} When `model` is not a non-empty string.
   * @throws {RangeError} When `dim` is invalid or the vector length does not
   *   match `dim`.
   */
  function setEmbedding(pairId, vector, { model, dim }) {
    if (typeof model !== "string" || model.length === 0) {
      throw new TypeError("model must be a non-empty string");
    }
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new RangeError("dim must be a positive integer");
    }
    if (!(vector instanceof Float32Array) || vector.length !== dim) {
      throw new RangeError(`vector length must equal dim (${dim})`);
    }
    const blob = vectorToBlob(vector);
    stmt(
      "UPDATE pairs SET embedding = ?, dim = ?, model = ?, indexed_at = ? WHERE pair_id = ?",
    ).run(blob, dim, model, Date.now(), pairId);
    stmt("DELETE FROM outbox WHERE pair_id = ?").run(pairId);
  }

  /**
   * Record a failure for an outbox entry.
   *
   * @param {string} pairId
   * @param {object} options
   * @param {number} options.attempts - New attempt count (integer >= 0).
   * @param {number} options.nextAt - Epoch milliseconds for the next retry.
   * @param {Error|string|null} [options.error] - Failure detail.
   * @returns {boolean} Whether an outbox row was updated.
   */
  function failPair(pairId, { attempts, nextAt, error = null }) {
    if (!Number.isInteger(attempts) || attempts < 0) {
      throw new RangeError("attempts must be an integer >= 0");
    }
    if (!Number.isFinite(nextAt)) {
      throw new RangeError("nextAt must be a finite number");
    }
    const errorText = error === null || error === undefined
      ? null
      : error instanceof Error
        ? error.message
        : String(error);
    const result = stmt(
      "UPDATE outbox SET attempts = ?, next_at = ?, last_error = ? WHERE pair_id = ?",
    ).run(attempts, nextAt, errorText, pairId);
    return result.changes > 0;
  }

  /**
   * Retrieve candidate records (pairs and memories) for retrieval.
   *
   * Only records with a stored embedding matching `model` and `dim` are
   * returned, ordered by `created_at` descending across both kinds. Memories
   * are always eligible when `memory_type = 'global'` or their stored `cwd`
   * equals the current `cwd` exactly — the retrieval `scope` does not apply
   * to them. Pairs are filtered by `scope`: with `scope` of `"all"` no
   * workspace filter is applied; any other scope (or omission) filters by
   * `cwd`. When `excludeSessionId` is a non-empty string, pairs from that
   * exact session are excluded (memories are session-less and never match).
   *
   * @param {object} params
   * @param {"workspace"|"all"} [params.scope] - Retrieval scope for pairs.
   * @param {string} [params.cwd] - Current workspace path; filters workspace
   *   memories and is required when `scope` is not `"all"`.
   * @param {string} params.model - Model the embeddings were produced with.
   * @param {number} params.dim - Embedding dimension.
   * @param {number} [params.limit] - Maximum results; defaults to 10.
   * @param {string} [params.excludeSessionId] - When non-empty, exclude
   *   pairs from this exact session.
   * @returns {Array<{pairId: string, sessionId: string, cwd: string,
   *   turn: number, createdAt: number, userText: string, assistantText:
   *   string, recordType: string, memoryType: string|null, name: string,
   *   description: string, vector: Float32Array}>}
   */
  function candidates({ scope, cwd, model, dim, limit, excludeSessionId }) {
    if (typeof model !== "string" || model.length === 0) {
      throw new TypeError("model must be a non-empty string");
    }
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new RangeError("dim must be a positive integer");
    }
    const workspaceScope = scope !== "all";
    if (workspaceScope && typeof cwd !== "string") {
      throw new TypeError('cwd is required when scope is not "all"');
    }
    const excludeSession = typeof excludeSessionId === "string" && excludeSessionId.length > 0;
    const lim = Number.isInteger(limit) && limit > 0 ? limit : 10;
    const memCwd = typeof cwd === "string" ? cwd : "";
    const memoryCond = "(record_type = 'memory' AND (memory_type = 'global' OR cwd = ?))";
    const pairCond = workspaceScope ? "(record_type = 'pair' AND cwd = ?)" : "(record_type = 'pair')";
    const sql = `SELECT pair_id, session_id, cwd, turn, created_at, user_text, assistant_text,
                        record_type, memory_type, name, description, embedding, dim
                 FROM pairs
                 WHERE embedding IS NOT NULL AND model = ? AND dim = ?
                   AND (${memoryCond} OR ${pairCond})
                   ${excludeSession ? "AND (record_type = 'memory' OR session_id <> ?)" : ""}
                 ORDER BY created_at DESC
                 LIMIT ?`;
    const params = [model, dim, memCwd];
    if (workspaceScope) params.push(cwd);
    if (excludeSession) params.push(excludeSessionId);
    params.push(lim);
    const rows = stmt(sql).all(...params);
    return rows.map((row) => ({
      pairId: row.pair_id,
      sessionId: row.session_id,
      cwd: row.cwd,
      turn: row.turn,
      createdAt: row.created_at,
      userText: row.user_text,
      assistantText: row.assistant_text,
      recordType: row.record_type ?? "pair",
      memoryType: row.memory_type ?? null,
      name: row.name ?? "",
      description: row.description ?? "",
      vector: vectorFromBlob(row.embedding, row.dim),
    }));
  }

  /**
   * Count candidate records for retrieval.
   *
   * Applies the same merged filters as `candidates` (stored embedding
   * matching `model` and `dim`, memories by `global`/exact `cwd`, pairs by
   * workspace scope) without a limit. When `sessionId` is a non-empty
   * string, only conversation pairs from that exact session are counted —
   * memories never contribute to the same-session statistic.
   *
   * @param {object} params
   * @param {"workspace"|"all"} [params.scope] - Retrieval scope for pairs.
   * @param {string} [params.cwd] - Current workspace path; required when
   *   `scope` is not `"all"`.
   * @param {string} params.model - Model the embeddings were produced with.
   * @param {number} params.dim - Embedding dimension.
   * @param {string} [params.sessionId] - When non-empty, count only
   *   conversation pairs from this exact session.
   * @returns {number} Number of matching records.
   */
  function countCandidates({ scope, cwd, model, dim, sessionId }) {
    if (typeof model !== "string" || model.length === 0) {
      throw new TypeError("model must be a non-empty string");
    }
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new RangeError("dim must be a positive integer");
    }
    const workspaceScope = scope !== "all";
    if (workspaceScope && typeof cwd !== "string") {
      throw new TypeError('cwd is required when scope is not "all"');
    }
    const restrictSession = typeof sessionId === "string" && sessionId.length > 0;
    const memCwd = typeof cwd === "string" ? cwd : "";
    const memoryCond = "(record_type = 'memory' AND (memory_type = 'global' OR cwd = ?))";
    const pairCond = workspaceScope ? "(record_type = 'pair' AND cwd = ?)" : "(record_type = 'pair')";
    const sql = `SELECT COUNT(*) AS n
                 FROM pairs
                 WHERE embedding IS NOT NULL AND model = ? AND dim = ?
                   AND (${memoryCond} OR ${pairCond})
                   ${restrictSession ? "AND record_type = 'pair' AND session_id = ?" : ""}`;
    const params = [model, dim, memCwd];
    if (workspaceScope) params.push(cwd);
    if (restrictSession) params.push(sessionId);
    return stmt(sql).get(...params).n;
  }

  /**
   * Index statistics. `model`/`dim` report the most common (model, dim)
   * combination among indexed rows, or `null` when nothing is indexed.
   * `pendingCount` counts every outbox entry (including failed ones, which
   * are additionally counted in `errorCount`).
   *
   * @returns {{pairCount: number, indexedCount: number, pendingCount: number,
   *   errorCount: number, model: string|null, dim: number|null}}
   */
  function stats() {
    const count = (sql) => stmt(sql).get().n;
    const pairCount = count("SELECT COUNT(*) AS n FROM pairs");
    const indexedCount = count("SELECT COUNT(*) AS n FROM pairs WHERE embedding IS NOT NULL");
    const pendingCount = count("SELECT COUNT(*) AS n FROM outbox");
    const errorCount = count("SELECT COUNT(*) AS n FROM outbox WHERE last_error IS NOT NULL");
    const dominant = stmt(
      `SELECT model, dim FROM pairs
       WHERE embedding IS NOT NULL
       GROUP BY model, dim
       ORDER BY COUNT(*) DESC, model
       LIMIT 1`,
    ).get();
    return {
      pairCount,
      indexedCount,
      pendingCount,
      errorCount,
      model: dominant === undefined ? null : dominant.model,
      dim: dominant === undefined ? null : dominant.dim,
    };
  }

  /**
   * Clear the index: drop every stored embedding (and its model/dim/indexed
   * metadata) and empty the outbox. Metadata in `meta` is preserved.
   *
   * @returns {{pairsCleared: number}} Number of pairs whose embedding was
   *   cleared.
   */
  function clearIndex() {
    const result = stmt(
      "UPDATE pairs SET embedding = NULL, dim = NULL, model = NULL, indexed_at = NULL",
    ).run();
    stmt("DELETE FROM outbox").run();
    return { pairsCleared: result.changes };
  }

  /**
   * Clear the index and re-enqueue every pair for embedding.
   *
   * @param {string} [reason] - Outbox reason; defaults to `"reindex"`.
   * @returns {{queued: number}} Number of pairs queued.
   */
  function reindexAll(reason = "reindex") {
    clearIndex();
    return { queued: enqueueAll(reason) };
  }

  /**
   * Close the underlying database connection.
   *
   * @returns {void}
   */
  function close() {
    raw.close();
  }

  return {
    path,
    raw,
    close,
    metaGet,
    metaSet,
    upsertPair,
    upsertMemory,
    markSeen,
    beginReconcile,
    finishReconcile,
    deletePair,
    enqueue,
    enqueueAll,
    claimDue,
    getPair,
    setEmbedding,
    failPair,
    candidates,
    countCandidates,
    stats,
    clearIndex,
    reindexAll,
  };
}
