/**
 * Persistent recall (turn-dedupe) state for `dsh-context-rag`.
 *
 * Stores, per (session id, pair id), when a pair or memory was last recalled
 * and how often it has been recorded, so the retrieval layer can enforce the
 * `retrieval.dedupeTurns` distance without re-reading message content. A
 * recall is either an actual injection into the context or a successful
 * `memory_write` (both count as "this candidate is already in the session's
 * recent context"). The state lives in its own JSON file (never inside
 * `index.sqlite`) and survives plugin/DSH restarts and deletion of
 * `index.sqlite`. It holds only ids, turns, timestamps and counts — never
 * message text.
 *
 * File schema (JSON, version 1):
 *
 * ```json
 * {
 *   "version": 1,
 *   "sessions": {
 *     "<sessionId>": {
 *       "lastActiveAt": 1730000000000,
 *       "entries": {
 *         "<pairId>": { "lastTurn": 12, "lastRecallAt": 1730000000000, "count": 2 }
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * All I/O is synchronous (`node:fs`) for simplicity. Writes are atomic
 * (same-directory temp file with mode `0o600` + rename) and never throw.
 *
 * Plain ESM JavaScript. Requires Node.js >= 22.
 *
 * @module recall-state
 */

import fs from "node:fs";
import path from "node:path";

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
 * Fresh empty in-memory state (schema version 1).
 *
 * @returns {{version: number, sessions: object}} Empty state.
 */
function emptyState() {
  return { version: 1, sessions: {} };
}

/**
 * Validate and normalize the `sessions` map of a loaded file.
 *
 * Invalid sessions and entries are dropped silently (a structurally invalid
 * file itself is rejected by `load`, not here). Sessions that end up with no
 * entries after normalization are dropped too.
 *
 * @param {object} rawSessions - Raw `sessions` object from the parsed file.
 * @returns {{sessions: object, droppedSessions: number, droppedEntries: number}}
 *   Normalized sessions plus how many sessions/entries were dropped.
 */
function normalizeLoadedData(rawSessions) {
  const sessions = {};
  let droppedSessions = 0;
  let droppedEntries = 0;

  for (const [sessionId, rawSession] of Object.entries(rawSessions)) {
    // A session needs a usable id, a plain object body, and a finite
    // activity timestamp to be kept.
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      droppedSessions += 1;
      continue;
    }
    if (!isPlainObject(rawSession)) {
      droppedSessions += 1;
      continue;
    }
    const lastActiveAt = rawSession.lastActiveAt;
    if (typeof lastActiveAt !== "number" || !Number.isFinite(lastActiveAt)) {
      droppedSessions += 1;
      continue;
    }
    if (!isPlainObject(rawSession.entries)) {
      droppedSessions += 1;
      continue;
    }

    const entries = {};
    for (const [pairId, rawEntry] of Object.entries(rawSession.entries)) {
      // An entry needs a usable id, a plain object body, an integer turn
      // >= 0, a finite recall timestamp, and a positive integer count.
      if (typeof pairId !== "string" || pairId.length === 0) {
        droppedEntries += 1;
        continue;
      }
      if (!isPlainObject(rawEntry)) {
        droppedEntries += 1;
        continue;
      }
      const lastTurn = rawEntry.lastTurn;
      const lastRecallAt = rawEntry.lastRecallAt;
      const count = rawEntry.count;
      if (!Number.isInteger(lastTurn) || lastTurn < 0) {
        droppedEntries += 1;
        continue;
      }
      if (typeof lastRecallAt !== "number" || !Number.isFinite(lastRecallAt)) {
        droppedEntries += 1;
        continue;
      }
      if (!Number.isInteger(count) || count < 1) {
        droppedEntries += 1;
        continue;
      }
      entries[pairId] = { lastTurn, lastRecallAt, count };
    }

    if (Object.keys(entries).length === 0) {
      droppedSessions += 1;
      continue;
    }
    sessions[sessionId] = { lastActiveAt, entries };
  }

  return { sessions, droppedSessions, droppedEntries };
}

/**
 * Create a recall-state store bound to a JSON file.
 *
 * The store is a small synchronous object with `load`, `getLastTurn`,
 * `isEligible`, `record`, `remove`, `prune`, `stats` and `save`. It never
 * throws: file failures are logged via `logger.warn` and the state falls back
 * to empty (fail-open), which keeps the retrieval/injection pipeline running
 * even when the recall-state file is missing, corrupt, or unwritable.
 *
 * @param {object} options - Options.
 * @param {string} options.file - Path of the `recall-state.json` file.
 * @param {{warn?: Function}} [options.logger] - Logger whose `warn` method
 *   is used for failures; defaults to `console`.
 * @param {() => number} [options.now] - Clock returning epoch milliseconds;
 *   defaults to `Date.now`. Injectable for tests.
 * @returns {{
 *   file: string,
 *   load: (options?: object) => object,
 *   getLastTurn: (sessionId: string, pairId: string) => number|null,
 *   isEligible: (options: object) => boolean,
 *   record: (options: object) => object,
 *   remove: (options: object) => object,
 *   prune: (options?: object) => object,
 *   stats: () => object,
 *   save: () => boolean,
 * }} The recall-state store.
 */
export function createRecallState({ file, logger = console, now = () => Date.now() }) {
  const store = {
    /**
     * Absolute path of the recall-state file.
     *
     * @type {string}
     */
    file: path.resolve(String(file)),

    /** @type {object} In-memory state: `{ version, sessions }`. */
    _data: emptyState(),

    /**
     * Whether the in-memory state changed since the last successful write.
     *
     * @type {boolean}
     */
    _changed: false,

    /**
     * Log a warning through the configured logger; never throws.
     *
     * @param {string} message - Warning text.
     */
    _warn(message) {
      if (!logger || typeof logger.warn !== "function") return;
      try {
        logger.warn(message);
      } catch {
        // A broken logger must not break the store.
      }
    },

    /**
     * Count sessions and entries in the current in-memory state.
     *
     * @param {object} [extra] - Extra fields merged into the result.
     * @returns {{sessions: number, entries: number}} Counts.
     */
    _counts(extra = {}) {
      let sessions = 0;
      let entries = 0;
      for (const session of Object.values(this._data.sessions)) {
        sessions += 1;
        entries += Object.keys(session.entries).length;
      }
      return { sessions, entries, ...extra };
    },

    /**
     * Load the recall-state file into memory.
     *
     * A missing file yields an empty state and is never rewritten. An
     * unreadable, corrupt, or structurally invalid file logs a warning and
     * starts empty — never throws. Valid content is normalized (invalid
     * sessions/entries dropped, empty sessions removed) and pruned with the
     * given limits; if anything was dropped or pruned the cleaned state is
     * persisted immediately.
     *
     * @param {object} [options] - Options.
     * @param {number} [options.retentionDays] - Drop whole sessions inactive
     *   for more than this many days; `0` disables (default `0`).
     * @param {number} [options.maxSessions] - Keep at most this many
     *   most-recently-active sessions; `0` disables (default `0`).
     * @returns {{sessions: number, entries: number, prunedSessions: number,
     *   prunedEntries: number}} Counts after load/prune.
     */
    load({ retentionDays = 0, maxSessions = 0 } = {}) {
      this._data = emptyState();
      this._changed = false;

      let text;
      try {
        text = fs.readFileSync(this.file, "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") {
          // Missing file: empty state, and do not create the file.
          return this._counts({ prunedSessions: 0, prunedEntries: 0 });
        }
        this._warn(`recall-state load failed: ${error.message}`);
        return this._counts({ prunedSessions: 0, prunedEntries: 0 });
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        this._warn(`recall-state parse failed: ${error.message}`);
        return this._counts({ prunedSessions: 0, prunedEntries: 0 });
      }

      if (
        !isPlainObject(parsed) ||
        parsed.version !== 1 ||
        !isPlainObject(parsed.sessions)
      ) {
        this._warn("recall-state load ignored: unsupported schema");
        return this._counts({ prunedSessions: 0, prunedEntries: 0 });
      }

      try {
        const normalized = normalizeLoadedData(parsed.sessions);
        this._data = { version: 1, sessions: normalized.sessions };
        const pruned = this.prune({ retentionDays, maxSessions });
        const prunedSessions = normalized.droppedSessions + pruned.prunedSessions;
        const prunedEntries = normalized.droppedEntries + pruned.prunedEntries;
        if (prunedSessions + prunedEntries > 0) this.save();
        return this._counts({ prunedSessions, prunedEntries });
      } catch (error) {
        this._data = emptyState();
        this._warn(`recall-state load failed: ${error.message}`);
        return this._counts({ prunedSessions: 0, prunedEntries: 0 });
      }
    },

    /**
     * Last turn a pair was injected in a session, or `null` when unknown.
     *
     * @param {string} sessionId - Session id.
     * @param {string} pairId - Pair id.
     * @returns {number|null} The recorded `lastTurn`, or `null` when the
     *   session/pair has no record or the inputs are invalid.
     */
    getLastTurn(sessionId, pairId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      if (typeof pairId !== "string" || pairId.length === 0) return null;
      const entry = this._data.sessions[sessionId]?.entries[pairId];
      return entry ? entry.lastTurn : null;
    },

    /**
     * Whether a pair may be injected at `turn` given a `gap`.
     *
     * Rules, in order: `gap === 0` always eligible; no recorded entry always
     * eligible; `gap === -1` never eligible once recorded (once per session,
     * ever); an invalid `turn` (not an integer >= 0) is eligible; otherwise
     * eligible when `turn - lastTurn >= gap`.
     *
     * @param {object} options - Options.
     * @param {string} options.sessionId - Current session id.
     * @param {string} options.pairId - Candidate pair id.
     * @param {number} options.turn - Current session turn.
     * @param {number} options.gap - Turn distance required; `0` disables,
     *   `-1` means once per session ever.
     * @returns {boolean} True when the pair may be injected now.
     */
    isEligible({ sessionId, pairId, turn, gap }) {
      if (gap === 0) return true;
      const lastTurn = this.getLastTurn(sessionId, pairId);
      if (lastTurn === null) return true;
      if (gap === -1) return false;
      if (!Number.isInteger(turn) || turn < 0) return true;
      return turn - lastTurn >= gap;
    },

    /**
     * Record that pairs or memories were recalled into a session at a turn.
     *
     * A recall is an injection into the context or a successful
     * `memory_write`; both use this same entry and the same turn window.
     * Invalid inputs (non-empty-string session id, integer turn < 0, empty
     * `pairIds`) are ignored. Duplicate pair ids are counted once. For each
     * distinct valid pair id: `count` increments, `lastTurn` becomes the max
     * of the existing and the current turn, and `lastRecallAt` is set to
     * `now()`. The session `lastActiveAt` is set to `now()`. Pruning runs
     * with the given limits, then the state is persisted atomically.
     *
     * Never throws: on any failure it logs a warning and returns zero counts,
     * so recording can never break the injection pipeline.
     *
     * @param {object} options - Options.
     * @param {string} options.sessionId - Session id.
     * @param {Array<string>} options.pairIds - Pair ids actually injected.
     * @param {number} options.turn - Session turn of the injection.
     * @param {number} [options.retentionDays] - Day-based session retention
     *   limit passed to `prune` (default `0`).
     * @param {number} [options.maxSessions] - Session-count limit passed to
     *   `prune` (default `0`).
     * @returns {{recorded: number, prunedSessions: number, prunedEntries:
     *   number}} Number of distinct valid pair ids updated, and prune counts.
     */
    record({ sessionId, pairIds, turn, retentionDays = 0, maxSessions = 0 } = {}) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { recorded: 0, prunedSessions: 0, prunedEntries: 0 };
      }
      if (!Number.isInteger(turn) || turn < 0) {
        return { recorded: 0, prunedSessions: 0, prunedEntries: 0 };
      }
      if (!Array.isArray(pairIds) || pairIds.length === 0) {
        return { recorded: 0, prunedSessions: 0, prunedEntries: 0 };
      }

      try {
        const nowValue = now();
        let session = this._data.sessions[sessionId];
        if (!session) {
          session = { lastActiveAt: nowValue, entries: {} };
          this._data.sessions[sessionId] = session;
        }

        const seen = new Set();
        let recorded = 0;
        for (const pairId of pairIds) {
          if (typeof pairId !== "string" || pairId.length === 0) continue;
          if (seen.has(pairId)) continue;
          seen.add(pairId);

          const existing = session.entries[pairId];
          if (existing) {
            existing.count += 1;
            if (turn > existing.lastTurn) existing.lastTurn = turn;
            existing.lastRecallAt = nowValue;
          } else {
            session.entries[pairId] = {
              lastTurn: turn,
              lastRecallAt: nowValue,
              count: 1,
            };
          }
          recorded += 1;
        }

        if (recorded === 0) {
          // No valid pair ids: undo a just-created empty session and persist
          // nothing.
          if (Object.keys(session.entries).length === 0) {
            delete this._data.sessions[sessionId];
          }
          return { recorded: 0, prunedSessions: 0, prunedEntries: 0 };
        }

        session.lastActiveAt = nowValue;
        this._changed = true;
        const pruned = this.prune({ retentionDays, maxSessions });
        if (!this.save()) {
          return { recorded: 0, prunedSessions: 0, prunedEntries: 0 };
        }
        return {
          recorded,
          prunedSessions: pruned.prunedSessions,
          prunedEntries: pruned.prunedEntries,
        };
      } catch (error) {
        this._warn(`recall-state record failed: ${error.message}`);
        return { recorded: 0, prunedSessions: 0, prunedEntries: 0 };
      }
    },

    /**
     * Remove recorded entries for the given pair ids from every session.
     *
     * Used when a memory is forgotten: the memory is deleted globally, so its
     * per-session turn history is stale everywhere and must not suppress a
     * later memory recreated with the same name (and therefore the same
     * `pairId`). Invalid or empty `pairIds` are ignored. Sessions left with
     * no entries are pruned. Persists atomically when anything was removed.
     *
     * Never throws: on failure it logs a warning and returns zero counts.
     *
     * @param {object} options - Options.
     * @param {Array<string>} options.pairIds - Pair ids to forget.
     * @returns {{removed: number, prunedSessions: number}} Number of entries
     *   removed and sessions pruned as a result.
     */
    remove({ pairIds } = {}) {
      if (!Array.isArray(pairIds) || pairIds.length === 0) {
        return { removed: 0, prunedSessions: 0 };
      }

      try {
        const targets = new Set();
        for (const pairId of pairIds) {
          if (typeof pairId === "string" && pairId.length > 0) targets.add(pairId);
        }
        if (targets.size === 0) {
          return { removed: 0, prunedSessions: 0 };
        }

        let removed = 0;
        for (const session of Object.values(this._data.sessions)) {
          for (const pairId of targets) {
            if (session.entries[pairId]) {
              delete session.entries[pairId];
              removed += 1;
            }
          }
        }

        if (removed === 0) {
          return { removed: 0, prunedSessions: 0 };
        }

        this._changed = true;
        const pruned = this.prune();
        if (!this.save()) {
          return { removed: 0, prunedSessions: 0 };
        }
        return { removed, prunedSessions: pruned.prunedSessions };
      } catch (error) {
        this._warn(`recall-state remove failed: ${error.message}`);
        return { removed: 0, prunedSessions: 0 };
      }
    },

    /**
     * Prune the in-memory state.
     *
     * When `retentionDays > 0`, whole sessions whose `lastActiveAt` is
     * strictly older than `retentionDays * 86400000` ms (relative to `now()`)
     * are removed. When `maxSessions > 0`, the `maxSessions` sessions with
     * the newest `lastActiveAt` are kept, tie-broken by ascending session id
     * for determinism. Sessions with no entries are always removed. When both
     * limits are `0`, only empty sessions are removed.
     *
     * @param {object} [options] - Options.
     * @param {number} [options.retentionDays] - Day-based retention limit;
     *   `0` disables (default `0`).
     * @param {number} [options.maxSessions] - Session-count limit; `0`
     *   disables (default `0`).
     * @returns {{prunedSessions: number, prunedEntries: number}} How many
     *   sessions and entries were removed.
     */
    prune({ retentionDays = 0, maxSessions = 0 } = {}) {
      const sessions = this._data.sessions;
      let prunedSessions = 0;
      let prunedEntries = 0;

      if (retentionDays > 0) {
        const cutoff = now() - retentionDays * 86400000;
        for (const [sessionId, session] of Object.entries(sessions)) {
          if (session.lastActiveAt < cutoff) {
            prunedEntries += Object.keys(session.entries).length;
            delete sessions[sessionId];
            prunedSessions += 1;
          }
        }
      }

      if (maxSessions > 0) {
        const keys = Object.keys(sessions);
        if (keys.length > maxSessions) {
          keys.sort((a, b) => {
            const byActivity = sessions[b].lastActiveAt - sessions[a].lastActiveAt;
            if (byActivity !== 0) return byActivity;
            return a < b ? -1 : a > b ? 1 : 0;
          });
          const keep = new Set(keys.slice(0, maxSessions));
          for (const sessionId of keys) {
            if (keep.has(sessionId)) continue;
            prunedEntries += Object.keys(sessions[sessionId].entries).length;
            delete sessions[sessionId];
            prunedSessions += 1;
          }
        }
      }

      // Always drop sessions that hold no entries.
      for (const [sessionId, session] of Object.entries(sessions)) {
        if (Object.keys(session.entries).length === 0) {
          delete sessions[sessionId];
          prunedSessions += 1;
        }
      }

      if (prunedSessions + prunedEntries > 0) this._changed = true;
      return { prunedSessions, prunedEntries };
    },

    /**
     * Current counts of sessions and entries in memory.
     *
     * @returns {{sessions: number, entries: number}} Counts.
     */
    stats() {
      return this._counts();
    },

    /**
     * Atomically persist the in-memory state to `file`.
     *
     * Writes 2-space-indented JSON with mode `0o600` via a same-directory
     * temp file and a rename, creating the parent directory if needed.
     * Never throws: on failure it logs a warning and returns `false`.
     * Not normally called directly; `record` and `load` persist themselves.
     *
     * @returns {boolean} True when the write succeeded.
     */
    save() {
      try {
        const dir = path.dirname(this.file);
        fs.mkdirSync(dir, { recursive: true });
        const tempPath = path.join(
          dir,
          `.${path.basename(this.file)}.${process.pid}.${Date.now()}.tmp`,
        );
        fs.writeFileSync(tempPath, `${JSON.stringify(this._data, null, 2)}\n`, {
          mode: 0o600,
        });
        fs.renameSync(tempPath, this.file);
        this._changed = false;
        return true;
      } catch (error) {
        this._warn(`recall-state save failed: ${error.message}`);
        return false;
      }
    },
  };

  return store;
}
