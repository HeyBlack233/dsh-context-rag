/**
 * Embedding indexer for `dsh-context-rag`.
 *
 * The indexer reconciles the JSONL pair store with the index database and
 * drains the embedding outbox in the background: due pairs are embedded in
 * batches, failures back off exponentially (capped at one hour, then a
 * 24-hour pause once the attempt cap is reached), and a configured embedding
 * model change clears and re-enqueues everything.
 *
 * @module indexer
 */

import { readPairs } from "./pairs.js";
import { buildEmbeddingText } from "./text.js";

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
 * @param {{info?: (message: string) => void, warn?: (message: string) => void, error?: (message: string) => void}} [options.logger]
 *   Optional logger for loop and reconcile diagnostics.
 * @param {string} [options.home = configStore.home] - Directory holding the
 *   JSONL pair store reconciled with the index database.
 * @returns {{start: Function, stop: Function, status: Function, reindex: Function, clear: Function, reconcile: Function, wake: Function, pumpOnce: Function}}
 */
export function createIndexer({ db, configStore, embeddings, logger, home = configStore.home }) {
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
   * Reconcile the JSONL pair store with the index database.
   *
   * Every pair found on disk is upserted and marked seen; pairs indexed but
   * no longer on disk are dropped by `finishReconcile`. When the configured
   * embedding model differs from the stored one, the index is cleared and
   * every pair is re-enqueued with reason `model-changed`. Concurrent calls
   * share one in-flight pass. Never throws: failures are recorded in
   * `reconcileError`.
   *
   * @returns {Promise<void>} Resolves when the pass completes.
   */
  function reconcile() {
    if (reconcilePromise) {
      return reconcilePromise;
    }
    reconcilePromise = (async () => {
      try {
        db.beginReconcile();
        for await (const { record } of readPairs(home)) {
          db.upsertPair(record);
          db.markSeen(record.pairId);
        }
        db.finishReconcile();

        const { model } = readConfig();
        if (model !== "" && db.metaGet("embedding_model") !== model) {
          db.clearIndex();
          db.enqueueAll("model-changed");
          db.metaSet("embedding_model", model);
          logger?.info?.(`[context-rag] embedding model changed to ${model}; re-indexing all pairs`);
        }
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
   * call, and stores each vector with its model and dimension. On failure
   * every claimed entry is failed with an exponential backoff (see
   * `nextRetryAt`).
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
        continue; // Pair vanished (deleted on disk); reconcile cleans the outbox.
      }
      texts.push(buildEmbeddingText(
        { user: pair.userText, assistant: pair.assistantText },
        cfg.maxEmbeddingChars,
      ));
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
      return items.length;
    }

    for (let i = 0; i < items.length; i += 1) {
      db.setEmbedding(items[i].row.pairId, Float32Array.from(result.vectors[i]), {
        model: result.model,
        dim: result.dimension,
      });
    }
    return items.length;
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

  return { start, stop, status, reindex, clear, reconcile, wake, pumpOnce };
}
