/**
 * Embedding indexer for `dsh-context-rag`.
 *
 * The indexer reconciles the JSONL pair store and the memory store with the
 * index database and drains the embedding outbox in the background: due
 * records (conversation pairs and memories alike) are embedded in batches,
 * failures back off exponentially (capped at one hour, then a 24-hour pause
 * once the attempt cap is reached), and a configured embedding model change
 * clears and re-enqueues everything.
 *
 * @module indexer
 */

import { readPairs, readPairRecord } from "./pairs.js";
import { buildEmbeddingText, truncateMiddle } from "./text.js";
import { pairFilePath, textHash } from "./paths.js";

/** Cap for the exponential backoff delay, in milliseconds (1 hour). */
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Pause once the attempt cap is reached, in milliseconds (24 hours). */
const MAX_ATTEMPTS_PAUSE_MS = 24 * 60 * 60 * 1000;

/** Upper bound for `stop()` waiting on the loop, in milliseconds. */
const STOP_TIMEOUT_MS = 2000;

/**
 * Create the indexer surface.
 *
 * @param {object} options
 * @param {object} options.db - Index database handle (see `lib/db.js`).
 * @param {object} options.configStore - Config store exposing `home` and
 *   `get()`; the config is read on every pump and reconcile so live changes
 *   apply immediately.
 * @param {object} options.embeddings - Embedding client with
 *   `embed(texts) -> {vectors, model, dimension}` (see `lib/embeddings.js`).
 * @param {{debug?: (message: string) => void, info?: (message: string) => void, warn?: (message: string) => void, error?: (message: string) => void}} [options.logger]
 *   Optional logger for loop and reconcile diagnostics; debug lines trace
 *   pump batches, retries, and reconcile passes.
 * @param {string} [options.home = configStore.home] - Directory holding the
 *   JSONL pair store reconciled with the index database.
 * @param {object} [options.memoryStore] - Optional memory store exposing
 *   `scan() -> Iterable<memory records>`; when present, `reconcile` also
 *   syncs every scanned memory into the index (see `lib/db.js`
 *   `upsertMemory`). Without it the indexer behaves exactly as before.
 * @returns {{start: Function, stop: Function, status: Function, reindex: Function, clear: Function, reconcile: Function, wake: Function, pumpOnce: Function, reindexEntry: Function}}
 */
export function createIndexer({ db, configStore, embeddings, logger, home = configStore.home, memoryStore }) {
  /** Whether the background loop is running. @type {boolean} */
  let running = false;
  /** Promise of the running loop, or null when idle. @type {Promise<void>|null} */
  let loopPromise = null;
  /** Last loop failure message, or null. @type {string|null} */
  let lastError = null;
  /** Last reconcile failure message, or null. @type {string|null} */
  let reconcileError = null;
  /** In-flight reconcile promise, or null when idle. @type {Promise<void>|null} */
  let reconcilePromise = null;
  /** Pending loop sleep timer, or null. @type {NodeJS.Timeout|null} */
  let sleepTimer = null;
  /** Resolver of the pending loop sleep, or null. @type {Function|null} */
  let waitResolve = null;

  /**
   * Read the embedding- and indexing-relevant config with defensive defaults.
   * A missing or unreadable config behaves like empty `embedding` and
   * `indexing` sections.
   *
   * @returns {object} Effective values: `enabled`, `model`, `batchSize`,
   *   `maxEmbeddingChars`, `pollIntervalMs`, `retryDelayMs`, `maxAttempts`.
   */
  function readConfig() {
    let config = {};
    try {
      config = configStore.get() ?? {};
    } catch {
      // Unreadable config; fall through to defaults.
    }
    const embedding = config.embedding ?? {};
    const indexing = config.indexing ?? {};
    return {
      enabled: config.enabled !== false && indexing.enabled !== false,
      model: typeof embedding.model === "string" && embedding.model.length > 0 ? embedding.model : "",
      batchSize: Number.isInteger(embedding.batchSize) && embedding.batchSize > 0 ? embedding.batchSize : 8,
      maxEmbeddingChars: Number.isFinite(embedding.maxEmbeddingChars) && embedding.maxEmbeddingChars > 0
        ? embedding.maxEmbeddingChars
        : 8000,
      pollIntervalMs: Number.isFinite(indexing.pollIntervalMs) && indexing.pollIntervalMs > 0
        ? indexing.pollIntervalMs
        : 1000,
      retryDelayMs: Number.isFinite(indexing.retryDelayMs) && indexing.retryDelayMs >= 0
        ? indexing.retryDelayMs
        : 500,
      maxAttempts: Number.isInteger(indexing.maxAttempts) && indexing.maxAttempts > 0
        ? indexing.maxAttempts
        : 8,
    };
  }

  /**
   * Current surface status.
   *
   * @returns {{running: boolean, lastError: string|null, reconcileError: string|null}}
   */
  function status() {
    return { running, lastError, reconcileError };
  }

  /**
   * Sleep for `ms` milliseconds, interruptible by `wake()`. The timer is
   * unref'd so it never keeps the process alive by itself.
   *
   * @param {number} ms - Milliseconds to sleep.
   * @returns {Promise<void>} Resolves when the sleep completes or is woken.
   */
  function sleep(ms) {
    return new Promise((resolve) => {
      waitResolve = resolve;
      sleepTimer = setTimeout(() => {
        sleepTimer = null;
        waitResolve = null;
        resolve();
      }, ms);
      sleepTimer.unref?.();
    });
  }

  /**
   * Interrupt the loop's sleep so the next `pumpOnce()` runs immediately.
   * A no-op when the loop is not sleeping.
   *
   * @returns {void}
   */
  function wake() {
    if (sleepTimer !== null) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    const resolve = waitResolve;
    waitResolve = null;
    if (resolve) {
      resolve();
    }
  }

  /**
   * Reconcile the JSONL pair store and the memory store with the index
   * database.
   *
   * Every pair found on disk and every memory returned by `memoryStore.scan()`
   * is upserted and marked seen; records indexed but no longer present are
   * dropped by `finishReconcile` (this covers deleted pairs and forgotten
   * memories). A malformed memory record is skipped with a warning so one bad
   * entry cannot abort the whole pass. When the configured embedding model
   * differs from the stored one, the index is cleared and every record is
   * re-enqueued with reason `model-changed`. Concurrent calls share one
   * in-flight pass. Never throws: failures are recorded in `reconcileError`.
   *
   * @returns {Promise<void>} Resolves when the pass completes.
   */
  function reconcile() {
    if (reconcilePromise) {
      return reconcilePromise;
    }
    reconcilePromise = (async () => {
      let pairs = 0;
      let memories = 0;
      try {
        db.beginReconcile();
        for await (const { record } of readPairs(home)) {
          db.upsertPair(record);
          db.markSeen(record.pairId);
          pairs += 1;
        }
        if (memoryStore && typeof memoryStore.scan === "function") {
          const scanned = await memoryStore.scan();
          for await (const record of scanned ?? []) {
            try {
              db.upsertMemory(record);
              db.markSeen(record.pairId);
              memories += 1;
            } catch (err) {
              logger?.warn?.(
                `[context-rag] skipping invalid memory record ${String(record?.pairId ?? "<unknown>")}: ${String(err?.message ?? err)}`,
              );
            }
          }
        }
        db.finishReconcile();

        const { model } = readConfig();
        if (model !== "" && db.metaGet("embedding_model") !== model) {
          db.clearIndex();
          db.enqueueAll("model-changed");
          db.metaSet("embedding_model", model);
          logger?.info?.(`[context-rag] embedding model changed to ${model}; re-indexing all pairs`);
        }
        logger?.debug?.(`[context-rag] reconcile complete: ${pairs} pair(s), ${memories} memory(ies)`);
        reconcileError = null;
      } catch (err) {
        reconcileError = String(err?.message ?? err);
        logger?.error?.(`[context-rag] reconcile failed: ${reconcileError}`);
      } finally {
        reconcilePromise = null;
      }
    })();
    return reconcilePromise;
  }

  /**
   * Compute the next retry time for a failed embedding.
   *
   * The delay is `retryDelayMs * 2^attempts`, capped at one hour; once
   * `attempts` reaches `maxAttempts`, the next attempt is paused 24 hours.
   *
   * @param {number} attempts - Attempt count after this failure.
   * @param {object} cfg - Effective embedding config.
   * @param {number} now - Epoch milliseconds.
   * @returns {number} Epoch milliseconds for the next attempt.
   */
  function nextRetryAt(attempts, cfg, now) {
    if (attempts >= cfg.maxAttempts) {
      return now + MAX_ATTEMPTS_PAUSE_MS;
    }
    const delay = Math.min(cfg.retryDelayMs * 2 ** attempts, MAX_BACKOFF_MS);
    return now + (Number.isFinite(delay) ? delay : MAX_BACKOFF_MS);
  }

  /**
   * Process one batch of due outbox entries.
   *
   * A no-op (returns 0) when indexing is disabled or no embedding model is
   * configured. Claims up to `batchSize` due entries, embeds them in a single
   * call, and stores each vector with its model and dimension. Conversation
   * pairs are embedded from their `User:/Assistant:` text; memories are
   * embedded from their content alone (no wrapper). On failure every claimed
   * entry is failed with an exponential backoff (see `nextRetryAt`).
   *
   * @returns {Promise<number>} Number of outbox entries handled.
   */
  async function pumpOnce() {
    const cfg = readConfig();
    if (!cfg.enabled || cfg.model === "") {
      return 0;
    }
    const due = db.claimDue(Date.now(), cfg.batchSize);
    if (due.length === 0) {
      return 0;
    }
    const items = [];
    const texts = [];
    for (const row of due) {
      const pair = db.getPair(row.pairId);
      if (!pair) {
        continue; // Record vanished (deleted on disk); reconcile cleans the outbox.
      }
      const text = pair.recordType === "memory"
        ? truncateMiddle(pair.userText, cfg.maxEmbeddingChars).trim()
        : buildEmbeddingText(
            { user: pair.userText, assistant: pair.assistantText },
            cfg.maxEmbeddingChars,
          );
      texts.push(text);
      items.push({ row, pair });
    }
    if (items.length === 0) {
      return 0;
    }

    const now = Date.now();
    let result;
    try {
      result = await embeddings.embed(texts);
    } catch (err) {
      for (const { row } of items) {
        const attempts = row.attempts + 1;
        db.failPair(row.pairId, { attempts, nextAt: nextRetryAt(attempts, cfg, now), error: err });
      }
      const maxAttempt = items.reduce((highest, { row }) => Math.max(highest, row.attempts + 1), 0);
      logger?.debug?.(
        `[context-rag] embedding failed for ${items.length} record(s), retry attempt ${maxAttempt}: ${String(err?.message ?? err)}`,
      );
      return items.length;
    }

    for (let i = 0; i < items.length; i += 1) {
      // CAS on the text hash fetched with the row: if the text changed while
      // the embedding request was in flight, the stale vector is not stored.
      db.setEmbedding(items[i].row.pairId, Float32Array.from(result.vectors[i]), {
        model: result.model,
        dim: result.dimension,
        expectedTextHash: items[i].pair.textHash ?? null,
      });
    }
    logger?.debug?.(`[context-rag] indexed ${items.length} record(s)`);
    return items.length;
  }

  /**
   * Build an error with a stable code, an HTTP status, and optional details,
   * used by `reindexEntry` so the API layer can map it directly.
   *
   * @param {string} code - Stable error code.
   * @param {string} message - Human readable description.
   * @param {number} status - HTTP status code.
   * @param {object|null} [details] - Extra structured context.
   * @returns {Error} The error.
   */
  function browseError(code, message, status, details = null) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.details = details;
    return error;
  }

  /**
   * Synchronously re-index one record (pair or memory) by its id.
   *
   * The source of truth is re-read fresh (the JSONL line for a pair, the
   * Markdown file for a memory), the record is upserted into the index (which
   * refreshes the text and enqueues it when changed), a due outbox entry with
   * reason `"manual"` and reset attempts is ensured, and exactly that record
   * is embedded with the current embedding config using the same text
   * building/truncation as `pumpOnce`. The embedding is stored with a
   * compare-and-swap guard on the source text hash, so a concurrent text
   * change cannot be overwritten.
   *
   * @param {string} pairId - Record id to re-index.
   * @returns {Promise<{pairId: string, kind: string, model: string, dim:
   *   number, indexedAt: number}>} The updated record metadata.
   * @throws {Error} Code `NOT_FOUND` (404) when the record or its source is
   *   missing; `EMBEDDING_DISABLED` (409) when embedding is disabled or has no
   *   model; `TEXT_CHANGED` (409) when the source text changed concurrently;
   *   `EMBEDDING_FAILED` (500, details `{queued: true}`) when the embedding
   *   call failed (the record stays queued with backoff).
   */
  async function reindexEntry(pairId) {
    const cfg = readConfig();
    if (!cfg.enabled || cfg.model === "") {
      throw browseError(
        "EMBEDDING_DISABLED",
        "Embedding is disabled or no embedding model is configured",
        409,
      );
    }
    const row = db.getPair(pairId);
    if (!row) {
      throw browseError("NOT_FOUND", `No indexed record with pairId ${pairId}`, 404);
    }
    const isMemory = row.recordType === "memory";

    // Resolve the authoritative source; an index row without a source is an
    // orphan and cannot be re-indexed.
    let source;
    let sourceHash;
    if (isMemory) {
      if (!memoryStore || typeof memoryStore.get !== "function") {
        throw browseError("NOT_FOUND", `Memory store is unavailable for ${pairId}`, 404);
      }
      source = memoryStore.get({ type: row.memoryType, cwd: row.cwd, name: row.name });
      if (!source) {
        throw browseError(
          "NOT_FOUND",
          `Source memory file is missing for ${pairId} (orphan); nothing to re-index`,
          404,
        );
      }
      sourceHash = textHash(source.content);
    } else {
      const file = pairFilePath({ home, cwd: row.cwd, sessionId: row.sessionId });
      source = await readPairRecord(file, pairId);
      if (!source) {
        throw browseError(
          "NOT_FOUND",
          `Source pair line is missing for ${pairId} (orphan); nothing to re-index`,
          404,
        );
      }
      sourceHash = textHash(`${source.user}\u0000${source.assistant}`);
    }

    // Refresh the row (upserts re-enqueue changed text) and guarantee a due
    // outbox entry with reason "manual" and reset attempts, so a later
    // failure leaves the record queued for the background worker.
    if (isMemory) {
      db.upsertMemory(source);
    } else {
      db.upsertPair(source);
    }
    db.enqueue(pairId, "manual", { resetAttempts: true });

    const text = isMemory
      ? truncateMiddle(source.content, cfg.maxEmbeddingChars).trim()
      : buildEmbeddingText(
          { user: source.user, assistant: source.assistant },
          cfg.maxEmbeddingChars,
        );

    if (typeof embeddings?.embed !== "function") {
      throw browseError("EMBEDDING_DISABLED", "Embedding client is not available", 409);
    }

    const now = Date.now();
    let result;
    try {
      result = await embeddings.embed([text]);
    } catch (err) {
      db.failPair(pairId, { attempts: 1, nextAt: nextRetryAt(1, cfg, now), error: err });
      wake();
      throw browseError(
        "EMBEDDING_FAILED",
        `Embedding failed for ${pairId}: ${String(err?.message ?? err)}`,
        500,
        { queued: true },
      );
    }

    const stored = db.setEmbedding(pairId, Float32Array.from(result.vectors[0]), {
      model: result.model,
      dim: result.dimension,
      expectedTextHash: sourceHash,
    });
    if (!stored) {
      // CAS failed: the text changed underneath us. Leave the outbox entry;
      // the background worker (or a fresh re-index) will index the new text.
      throw browseError(
        "TEXT_CHANGED",
        `Source text of ${pairId} changed during re-index; embedding was not overwritten`,
        409,
      );
    }
    const fresh = db.getPair(pairId);
    return {
      pairId,
      kind: isMemory ? "memory" : "pair",
      model: fresh.model,
      dim: fresh.dim,
      indexedAt: fresh.indexedAt,
    };
  }

  /**
   * Start the background loop.
   *
   * Idempotent: while running, repeated calls return the current loop
   * promise. A reconciliation pass starts fire-and-forget, then the loop
   * pumps the outbox until `stop()`. Never blocks the caller.
   *
   * @returns {Promise<void>} The loop promise; resolves when the loop stops.
   */
  function start() {
    if (running) {
      return loopPromise;
    }
    running = true;
    lastError = null;
    reconcileError = null;
    queueMicrotask(() => {
      reconcile().catch(() => {});
    });
    loopPromise = (async () => {
      while (running) {
        try {
          const processed = await pumpOnce();
          if (!running) {
            break;
          }
          if (processed === 0) {
            await sleep(readConfig().pollIntervalMs);
          }
        } catch (err) {
          lastError = String(err?.message ?? err);
          logger?.error?.(`[context-rag] indexer loop error: ${lastError}`);
          if (!running) {
            break;
          }
          await sleep(readConfig().pollIntervalMs);
        }
      }
    })();
    loopPromise.finally(() => {
      loopPromise = null;
    });
    return loopPromise;
  }

  /**
   * Stop the background loop.
   *
   * Signals the loop, wakes any sleep, and waits for it to finish. The wait
   * is bounded by `STOP_TIMEOUT_MS` so an in-flight embedding can never hang
   * the caller.
   *
   * @returns {Promise<void>}
   */
  async function stop() {
    running = false;
    wake();
    const promise = loopPromise;
    if (promise) {
      await Promise.race([
        promise,
        new Promise((resolve) => {
          const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    }
  }

  /**
   * Clear all embeddings and re-enqueue every pair for embedding.
   *
   * @returns {{queued: number}} Number of pairs queued.
   */
  function reindex() {
    const { queued } = db.reindexAll("reindex");
    wake();
    return { queued };
  }

  /**
   * Drop every stored embedding and empty the outbox.
   *
   * @returns {{cleared: true}}
   */
  function clear() {
    db.clearIndex();
    return { cleared: true };
  }

  return { start, stop, status, reindex, clear, reconcile, wake, pumpOnce, reindexEntry };
}
