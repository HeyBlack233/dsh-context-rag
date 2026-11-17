/**
 * Read-only browse, search, and audit service for `dsh-context-rag`.
 *
 * Backs the configuration page's Browse tab: scope discovery, source listing
 * with pagination, free-text search over memories and message pairs,
 * per-entry detail reads, per-entry index-consistency status, and a full
 * audit of every entry. The source of truth is always the JSONL pair files
 * and the Markdown memory files; the SQLite index only supplies status (via
 * `db.indexRows()`) and is never mutated here. Search delegates to the
 * optional manual search engine (`lib/search.js`) and re-resolves every hit
 * against the authoritative sources so raw engine metadata never reaches the
 * client. The service is deliberately read-only — single-entry re-indexing
 * is delegated to the indexer (`indexer.reindexEntry`) and forgetting to the
 * memory store.
 *
 * Status rules (see `computeStatus`): a source record with no DB row is
 * `missing`; a differing text hash is `stale-text`; a matching hash with no
 * embedding is `pending`; an embedding that does not match the configured
 * model/dim is `model-mismatch`; a physically broken embedding is `corrupt`;
 * otherwise `consistent`. Per-record inspection failures fail open as
 * `unknown` (logged, never failing the whole request), and DB rows with no
 * source are reported as `orphan` by the audit only.
 *
 * Plain ESM JavaScript. Requires Node.js >= 22.
 *
 * @module browse
 */

import { basename } from "node:path";
import { readPairs, readPairRecord } from "./pairs.js";
import { pairFilePath, textHash, workspaceSlug } from "./paths.js";

/** Maximum characters of the pair preview in list items. */
const PREVIEW_CHARS = 200;

/** Maximum characters of each text field in detail reads. */
const DETAIL_MAX_CHARS = 200_000;

/** Cap for non-consistent entries in the audit mismatch list. */
const MAX_MISMATCHES = 500;

/** Compare two strings with a locale-independent, deterministic order. */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort source records newest first, tie-broken by pair id. */
function compareNewest(a, b) {
  const byTime = b.createdAt - a.createdAt;
  if (byTime !== 0) return byTime;
  return compareStrings(a.pairId, b.pairId);
}

/** Sort memory records by name ascending (byte order, like the store). */
function compareByName(a, b) {
  return compareStrings(a.name, b.name);
}

/**
 * Whitespace-normalize text: collapse every run of whitespace to a single
 * space and trim. Used for the short pair preview in list items.
 *
 * @param {string} text - Raw text.
 * @returns {string} Normalized text.
 */
function collapseWhitespace(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

/**
 * Short preview of a pair's user text: whitespace-normalized and capped at
 * {@link PREVIEW_CHARS} characters. Assistant text is never included.
 *
 * @param {string} userText - Pair user text.
 * @returns {string} The preview.
 */
function previewOf(userText) {
  return collapseWhitespace(userText).slice(0, PREVIEW_CHARS);
}

/** True for plain (non-array) objects. */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Compute the index-consistency status of one entry.
 *
 * Pure and exported so the API layer can reuse it (e.g. to report the status
 * of an entry right after a synchronous re-index).
 *
 * @param {object} params
 * @param {object|null} params.row - `db.indexRows()` row for the entry, or
 *   `null` when the entry is not indexed.
 * @param {string} params.textHash - Hash of the source text (pairs hash
 *   `user + "\0" + assistant`; memories hash the content).
 * @param {object} [params.embeddingConfig] - The `embedding` section of the
 *   config (read at call time).
 * @returns {{state: string, model: string|null, dim: number|null,
 *   indexedAt: number|null}} The status. `state` is one of `missing`,
 *   `stale-text`, `pending`, `model-mismatch`, `corrupt`, `consistent`, or
 *   `unknown`.
 */
export function computeStatus({ row, textHash: sourceHash, embeddingConfig = {} } = {}) {
  if (!row) {
    return { state: "missing", model: null, dim: null, indexedAt: null };
  }
  if (row.textHash !== sourceHash) {
    return { state: "stale-text", model: row.model ?? null, dim: row.dim ?? null, indexedAt: row.indexedAt ?? null };
  }
  if (!row.hasEmbedding) {
    return { state: "pending", model: row.model ?? null, dim: row.dim ?? null, indexedAt: row.indexedAt ?? null };
  }
  const dimValid = Number.isInteger(row.dim) && row.dim > 0;
  if (!dimValid || row.embeddingLength !== row.dim * 4) {
    return { state: "corrupt", model: row.model ?? null, dim: row.dim ?? null, indexedAt: row.indexedAt ?? null };
  }
  // The model/dim compatibility check is skipped entirely when no embedding
  // model is configured: without an active model the configured dimensions
  // do not describe how the stored vectors were produced.
  const cfgModel = typeof embeddingConfig.model === "string" && embeddingConfig.model.length > 0
    ? embeddingConfig.model
    : "";
  const cfgDim = Number.isFinite(embeddingConfig.dimensions) ? embeddingConfig.dimensions : null;
  const mismatched =
    cfgModel !== "" && (row.model !== cfgModel || (cfgDim !== null && row.dim !== cfgDim));
  if (mismatched) {
    return { state: "model-mismatch", model: row.model ?? null, dim: row.dim ?? null, indexedAt: row.indexedAt ?? null };
  }
  return { state: "consistent", model: row.model ?? null, dim: row.dim ?? null, indexedAt: row.indexedAt ?? null };
}

/**
 * Create the browse/audit service bound to one home directory.
 *
 * @param {object} options - Options.
 * @param {string} options.home - DSH home directory holding `pairs/`,
 *   `memories/`, and `index.sqlite`.
 * @param {object} options.db - Index database handle (see `lib/db.js`);
 *   only `indexRows()` and `getPair()` are read.
 * @param {object} options.configStore - Config store exposing `get()` and
 *   `home`; the `embedding` section drives the model/dim status check.
 * @param {object} options.memoryStore - Memory store from
 *   `createMemoryStore`; `listAll()` and `get()` are read.
 * @param {{warn?: (message: string) => void}} [options.logger] - Optional
 *   logger for fail-open diagnostics; defaults to `console`.
 * @param {object|null} [options.searchService] - Optional manual search
 *   engine exposing `search({query, scope, kinds, limit, signal})` (see
 *   `lib/search.js`). When absent or lacking a `search` function, the
 *   service's `search` method answers `NOT_READY` (503).
 * @returns {{
 *   scopes: () => Promise<object>,
 *   list: (params: object) => Promise<object>,
 *   get: (params: object) => Promise<object>,
 *   check: (params: object) => Promise<object>,
 *   statusOf: (pairId: string) => Promise<object>,
 *   search: (params: object) => Promise<object>,
 * }} The browse service.
 */
export function createBrowseService({
  home,
  db,
  configStore,
  memoryStore,
  logger = console,
  searchService = null,
} = {}) {
  /** Canonical scope form: `{type, cwd}` with `cwd: null` for all and `""` for global. */
  function normalizeScope(scope) {
    if (scope.type === "all") return { type: "all", cwd: null };
    if (scope.type === "global") return { type: "global", cwd: "" };
    return { type: "workspace", cwd: scope.cwd };
  }

  /** Source-record filter for one canonical scope. */
  function filterFor(scope) {
    if (scope.type === "all") return () => true;
    if (scope.type === "global") {
      return (record) => record.memoryType === "global";
    }
    // Workspace: only records whose cwd matches; global memories never match.
    return (record) => record.cwd === scope.cwd && record.memoryType !== "global";
  }

  /** DB-row filter for orphan detection in one canonical scope. */
  function orphanFilter(scope, row) {
    if (scope.type === "all") return true;
    if (scope.type === "global") {
      return row.recordType === "memory" && row.memoryType === "global";
    }
    return row.cwd === scope.cwd && !(row.recordType === "memory" && row.memoryType === "global");
  }

  /** Read every pair record from `<home>/pairs`, counting malformed lines. */
  async function collectPairs() {
    const records = [];
    let malformedLines = 0;
    for await (const { record } of readPairs(home, {
      onMalformed: () => {
        malformedLines += 1;
      },
    })) {
      records.push(record);
    }
    return { records, malformedLines };
  }

  /** Current `embedding` config section, with defensive defaults. */
  function embeddingConfig() {
    try {
      return configStore?.get()?.embedding ?? {};
    } catch {
      return {};
    }
  }

  /** `db.indexRows()` as a pair-id map. */
  function rowsMap() {
    const rows = db.indexRows();
    return new Map(rows.map((row) => [row.pairId, row]));
  }

  /** Kind of one source record: `"memory"` or `"pair"`. */
  function kindOf(record) {
    return record.memoryType ? "memory" : "pair";
  }

  /**
   * Resolve the authoritative source of one entry.
   *
   * A DB row narrows the lookup (memory file for memory rows, the session
   * JSONL for pair rows); without a row the pair-id prefix decides the kind.
   *
   * @param {string} pairId - Entry id.
   * @param {object|null} row - `indexRows()` row, or null.
   * @returns {Promise<object|null>} The source record, or `null` when it no
   *   longer exists (an orphan).
   */
  async function resolveSource(pairId, row) {
    if (row) {
      if (row.recordType === "memory") {
        if (row.memoryType !== "global" && row.memoryType !== "workspace") {
          return null;
        }
        return memoryStore.get({ type: row.memoryType, cwd: row.cwd, name: row.name });
      }
      const file = pairFilePath({ home, cwd: row.cwd, sessionId: row.sessionId });
      return readPairRecord(file, pairId);
    }
    if (pairId.startsWith("memory:")) {
      const memories = await memoryStore.listAll();
      return memories.find((record) => record.pairId === pairId) ?? null;
    }
    const { records } = await collectPairs();
    return records.find((record) => record.pairId === pairId) ?? null;
  }

  /** Build an `NOT_FOUND` error carrying code and HTTP status. */
  function notFound(pairId) {
    const error = new Error(`No record with pairId ${pairId}`);
    error.code = "NOT_FOUND";
    error.status = 404;
    return error;
  }

  /**
   * Compute the status of one source record, failing open to `unknown` with a
   * logged warning when the inspection itself fails.
   */
  function statusOfRecord({ record, row, cfg, kind, label }) {
    const sourceHash = kind === "memory"
      ? textHash(record.content)
      : textHash(`${record.user}\u0000${record.assistant}`);
    try {
      return computeStatus({ row, textHash: sourceHash, embeddingConfig: cfg });
    } catch (err) {
      logger?.warn?.(
        `[context-rag] browse status inspection failed for ${label}: ${String(err?.message ?? err)}`,
      );
      return { state: "unknown", model: row?.model ?? null, dim: row?.dim ?? null, indexedAt: row?.indexedAt ?? null };
    }
  }

  /** Build a `MemoryItem` for one memory source record. */
  function memoryItem(record, row, cfg) {
    return {
      pairId: record.pairId,
      kind: "memory",
      name: record.name,
      description: record.description,
      memoryType: record.memoryType,
      cwd: record.cwd,
      createdAt: record.createdAt,
      status: statusOfRecord({ record, row, cfg, kind: "memory", label: record.pairId }),
    };
  }

  /** Build a `PairItem` for one pair source record. */
  function pairItem(record, row, cfg) {
    return {
      pairId: record.pairId,
      kind: "pair",
      sessionId: record.sessionId,
      cwd: record.cwd,
      turn: record.turn,
      createdAt: record.createdAt,
      preview: previewOf(record.user),
      status: statusOfRecord({ record, row, cfg, kind: "pair", label: record.pairId }),
    };
  }

  /** Build an `OrphanItem` for one indexed row without a source. */
  function orphanItem(row) {
    const kind = row.recordType === "memory" ? "memory" : "pair";
    const item = {
      pairId: row.pairId,
      kind,
      cwd: row.cwd,
      createdAt: row.createdAt,
      status: { state: "orphan", model: row.model, dim: row.dim, indexedAt: row.indexedAt },
    };
    if (kind === "memory") {
      item.name = row.name;
      item.description = row.description;
      return item;
    }
    // Pair orphans carry optional session/turn/preview; the preview comes from
    // the index row's user text (a corrupt blob must not break the audit, so
    // this is fail-open and logged).
    item.sessionId = row.sessionId;
    item.turn = row.turn;
    try {
      const pair = db.getPair(row.pairId);
      if (pair) {
        item.preview = previewOf(pair.userText);
      }
    } catch (err) {
      logger?.warn?.(
        `[context-rag] browse orphan detail failed for ${row.pairId}: ${String(err?.message ?? err)}`,
      );
    }
    return item;
  }

  /**
   * List every browse scope with per-scope source counts.
   *
   * @returns {Promise<{scopes: Array<object>, malformedLines: number}>}
   */
  async function scopes() {
    const { records: pairRecords, malformedLines } = await collectPairs();
    const memoryRecords = await memoryStore.listAll();

    const pairCountByCwd = new Map();
    for (const record of pairRecords) {
      const cwd = record.cwd || "";
      pairCountByCwd.set(cwd, (pairCountByCwd.get(cwd) ?? 0) + 1);
    }
    let globalMemories = 0;
    const memoryCountByCwd = new Map();
    for (const record of memoryRecords) {
      if (record.memoryType === "global") {
        globalMemories += 1;
      } else {
        const cwd = record.cwd || "";
        memoryCountByCwd.set(cwd, (memoryCountByCwd.get(cwd) ?? 0) + 1);
      }
    }

    const workspaceCwds = new Set();
    for (const record of pairRecords) {
      if (record.cwd) workspaceCwds.add(record.cwd);
    }
    for (const record of memoryRecords) {
      if (record.memoryType === "workspace" && record.cwd) workspaceCwds.add(record.cwd);
    }
    const sortedCwds = [...workspaceCwds].sort(compareStrings);

    return {
      scopes: [
        {
          id: "all",
          type: "all",
          cwd: null,
          labelKey: "scopeAll",
          memories: memoryRecords.length,
          pairs: pairRecords.length,
        },
        {
          id: "global",
          type: "global",
          cwd: "",
          labelKey: "browseScopeGlobal",
          memories: globalMemories,
          pairs: 0,
        },
        ...sortedCwds.map((cwd) => ({
          id: `ws:${cwd}`,
          type: "workspace",
          cwd,
          label: `${basename(cwd)} · ${workspaceSlug(cwd).slice(-8)}`,
          memories: memoryCountByCwd.get(cwd) ?? 0,
          pairs: pairCountByCwd.get(cwd) ?? 0,
        })),
      ],
      malformedLines,
    };
  }

  /**
   * List source records of one kind in one scope with pagination.
   *
   * @param {object} params
   * @param {"memories"|"pairs"} params.kind - Record kind to list.
   * @param {object} params.scope - Validated scope `{type, cwd?}`.
   * @param {number} params.offset - Pagination offset.
   * @param {number} params.limit - Page size (1..100).
   * @returns {Promise<object>} `{kind, scope, total, offset, limit, items}`.
   */
  async function list({ kind, scope, offset, limit }) {
    const norm = normalizeScope(scope);
    const cfg = embeddingConfig();
    const rows = rowsMap();
    let total;
    let items;
    if (kind === "memories") {
      const memories = await memoryStore.listAll();
      const filtered = memories.filter(filterFor(norm));
      filtered.sort(compareByName);
      total = filtered.length;
      items = filtered.slice(offset, offset + limit).map((record) =>
        memoryItem(record, rows.get(record.pairId) ?? null, cfg),
      );
    } else {
      const { records } = await collectPairs();
      const filtered = records.filter(filterFor(norm));
      filtered.sort(compareNewest);
      total = filtered.length;
      items = filtered.slice(offset, offset + limit).map((record) =>
        pairItem(record, rows.get(record.pairId) ?? null, cfg),
      );
    }
    return { kind, scope: norm, total, offset, limit, items };
  }

  /**
   * Read one entry in full, re-reading the source fresh.
   *
   * @param {object} params
   * @param {string} params.pairId - Entry id.
   * @returns {Promise<object>} The full memory or pair value.
   * @throws {Error} Code `NOT_FOUND` (404) when the source no longer exists.
   */
  async function get({ pairId }) {
    const row = rowsMap().get(pairId) ?? null;
    const source = await resolveSource(pairId, row);
    if (!source) {
      throw notFound(pairId);
    }
    const cfg = embeddingConfig();
    if (kindOf(source) === "memory") {
      const content = String(source.content ?? "");
      const contentTruncated = content.length > DETAIL_MAX_CHARS;
      return {
        pairId,
        kind: "memory",
        name: source.name,
        description: source.description,
        memoryType: source.memoryType,
        cwd: source.cwd,
        createdAt: source.createdAt,
        status: statusOfRecord({ record: source, row, cfg, kind: "memory", label: pairId }),
        content: contentTruncated ? content.slice(0, DETAIL_MAX_CHARS) : content,
        contentTruncated,
        outbox: null,
      };
    }
    const user = String(source.user ?? "");
    const assistant = String(source.assistant ?? "");
    const userTruncated = user.length > DETAIL_MAX_CHARS;
    const assistantTruncated = assistant.length > DETAIL_MAX_CHARS;
    return {
      pairId,
      kind: "pair",
      sessionId: source.sessionId,
      cwd: source.cwd,
      turn: source.turn,
      createdAt: source.createdAt,
      status: statusOfRecord({ record: source, row, cfg, kind: "pair", label: pairId }),
      user: userTruncated ? user.slice(0, DETAIL_MAX_CHARS) : user,
      assistant: assistantTruncated ? assistant.slice(0, DETAIL_MAX_CHARS) : assistant,
      userTruncated,
      assistantTruncated,
      outbox: row && row.outboxReason !== null
        ? {
            reason: row.outboxReason,
            attempts: row.outboxAttempts,
            nextAt: row.outboxNextAt,
            lastError: row.outboxLastError,
          }
        : null,
    };
  }

  /**
   * Audit every entry of a scope: count statuses, list all non-consistent
   * entries (newest first, capped), and report orphans and malformed lines.
   *
   * @param {object} params
   * @param {object} params.scope - Validated scope `{type, cwd?}`.
   * @returns {Promise<object>} The audit value.
   */
  async function check({ scope }) {
    const norm = normalizeScope(scope);
    const cfg = embeddingConfig();
    const { records: pairRecords, malformedLines } = await collectPairs();
    const memoryRecords = await memoryStore.listAll();
    const rows = db.indexRows();
    const rowsByPairId = new Map(rows.map((row) => [row.pairId, row]));

    const pairSources = pairRecords.filter(filterFor(norm));
    const memorySources = memoryRecords.filter(filterFor(norm));

    const counts = {
      consistent: 0,
      missing: 0,
      staleText: 0,
      pending: 0,
      modelMismatch: 0,
      corrupt: 0,
      orphan: 0,
      unknown: 0,
    };
    const mismatches = [];

    const countKey = (state) => {
      if (state === "stale-text") return "staleText";
      if (state === "model-mismatch") return "modelMismatch";
      return state;
    };

    for (const record of pairSources) {
      const item = pairItem(record, rowsByPairId.get(record.pairId) ?? null, cfg);
      counts[countKey(item.status.state)] += 1;
      if (item.status.state !== "consistent") mismatches.push(item);
    }
    for (const record of memorySources) {
      const item = memoryItem(record, rowsByPairId.get(record.pairId) ?? null, cfg);
      counts[countKey(item.status.state)] += 1;
      if (item.status.state !== "consistent") mismatches.push(item);
    }

    const known = new Set([...pairSources, ...memorySources].map((record) => record.pairId));
    for (const row of rows) {
      if (known.has(row.pairId) || !orphanFilter(norm, row)) continue;
      counts.orphan += 1;
      mismatches.push(orphanItem(row));
    }

    mismatches.sort(compareNewest);
    const truncated = mismatches.length > MAX_MISMATCHES;
    mismatches.splice(MAX_MISMATCHES);

    return {
      scope: norm,
      checked: {
        pairs: pairSources.length,
        memories: memorySources.length,
        total: pairSources.length + memorySources.length,
      },
      counts,
      malformedLines,
      mismatches,
      truncated,
    };
  }

  /**
   * Current kind and status of one entry (used after a synchronous
   * re-index).
   *
   * @param {string} pairId - Entry id.
   * @returns {Promise<{kind: string, status: object}>}
   * @throws {Error} Code `NOT_FOUND` (404) when the source no longer exists.
   */
  async function statusOf(pairId) {
    const row = rowsMap().get(pairId) ?? null;
    const source = await resolveSource(pairId, row);
    if (!source) {
      throw notFound(pairId);
    }
    const kind = kindOf(source);
    return {
      kind,
      status: statusOfRecord({ record: source, row, cfg: embeddingConfig(), kind, label: pairId }),
    };
  }

  /**
   * Search memories and message pairs with the configured search engine.
   *
   * Delegates to the optional `searchService` (the same cosine + optional
   * rerank pipeline as retrieval) and re-resolves every engine hit against
   * the authoritative source files (pairs JSONL + Markdown memories), so raw
   * engine metadata (`vector`, `userText`, `assistantText`, memory `content`)
   * never reaches the client and orphaned index rows (whose source file is
   * gone) are dropped instead of surfaced. Engine results keep their
   * score-descending order after dropping orphans; each item's `reranked`
   * mirrors `engineResult.stats.reranked` because rerank is a single pass
   * over the whole result set.
   *
   * @param {object} params
   * @param {string} params.query - The query text.
   * @param {object} params.scope - Validated scope `{type, cwd?}`.
   * @param {number} [params.limit] - Maximum results (1..50).
   * @returns {Promise<{query: string, scope: object, limit: number|undefined,
   *   results: Array<object>, stats: object}>}
   * @throws {Error} Code `NOT_READY` (`status` 503) when no search service is
   *   configured; the engine's own errors (e.g. `EMBEDDING_NOT_CONFIGURED`)
   *   and source-read failures propagate unchanged.
   */
  async function search({ query, scope, limit } = {}) {
    if (!searchService || typeof searchService.search !== "function") {
      const error = new Error("Search service is not available");
      error.code = "NOT_READY";
      error.status = 503;
      throw error;
    }
    const norm = normalizeScope(scope);
    const engineResult = await searchService.search({
      query,
      scope: norm,
      kinds: ["memory", "pair"],
      limit,
    });

    const cfg = embeddingConfig();
    const rows = rowsMap();
    const { records: pairRecords, malformedLines } = await collectPairs();
    const memoryRecords = await memoryStore.listAll();
    const pairByPairId = new Map(pairRecords.map((record) => [record.pairId, record]));
    const memoryByPairId = new Map(memoryRecords.map((record) => [record.pairId, record]));

    const reranked = Boolean(engineResult.stats.reranked);
    const results = [];
    let excludedOrphan = 0;
    for (const candidate of engineResult.results) {
      const kind = candidate.recordType === "memory" ? "memory" : "pair";
      const source = kind === "memory"
        ? memoryByPairId.get(candidate.pairId)
        : pairByPairId.get(candidate.pairId);
      if (!source) {
        excludedOrphan += 1;
        continue;
      }
      const row = rows.get(candidate.pairId) ?? null;
      if (kind === "memory") {
        results.push({
          kind: "memory",
          pairId: source.pairId,
          name: source.name,
          description: source.description,
          memoryType: source.memoryType,
          cwd: source.cwd,
          createdAt: source.createdAt,
          status: statusOfRecord({ record: source, row, cfg, kind: "memory", label: source.pairId }),
          score: candidate.score,
          cosineScore: candidate.cosineScore,
          reranked,
        });
      } else {
        results.push({
          kind: "pair",
          pairId: source.pairId,
          sessionId: source.sessionId,
          cwd: source.cwd,
          turn: source.turn,
          createdAt: source.createdAt,
          preview: previewOf(source.user),
          status: statusOfRecord({ record: source, row, cfg, kind: "pair", label: source.pairId }),
          score: candidate.score,
          cosineScore: candidate.cosineScore,
          reranked,
        });
      }
    }

    return {
      query: engineResult.query,
      scope: norm,
      limit,
      results,
      stats: {
        ...engineResult.stats,
        returned: results.length,
        excludedOrphan,
        malformedLines,
      },
    };
  }

  return { scopes, list, get, check, statusOf, search };
}
