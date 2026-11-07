/**
 * dsh-context-rag plugin entry point.
 *
 * Wires the config store, index database, Phase-2 surfaces (capture, indexer,
 * retriever, injector), the memory store + `memory_*` agent tools, and the
 * config HTTP API. `apply` never throws to the Host: every fallible step is
 * guarded, failures are logged and surfaced via `initError`, and the API is
 * registered even when the database is missing.
 *
 * @module index
 */

import path from "node:path";
import { DEFAULT_HOME, createConfigStore } from "./lib/config.js";
import { openIndexDatabase } from "./lib/db.js";
import { createEmbeddingClient } from "./lib/embeddings.js";
import { createRerankClient } from "./lib/rerank.js";
import { createCapture } from "./lib/capture.js";
import { createIndexer } from "./lib/indexer.js";
import { createRetriever } from "./lib/retrieval.js";
import { createInjector } from "./lib/inject.js";
import { createRecallState } from "./lib/recall-state.js";
import { registerApi } from "./lib/api.js";
import { createMemoryStore } from "./lib/memories.js";
import { registerMemoryTools } from "./lib/memory-tools.js";

/** Plugin row name. */
export const name = "context-rag";

/** Use `ctx.logger` when it exposes the full logger surface, else `console`. */
function createLogger(ctx) {
  const logger = ctx?.logger;
  if (logger && ["debug", "info", "warn", "error"].every((key) => typeof logger[key] === "function")) {
    return logger;
  }
  return console;
}

/** Human-readable form of an unknown thrown value. */
function messageOf(err) {
  return String(err?.message ?? err ?? "unknown error");
}

/**
 * Read an optional host service without failing when it is absent.
 *
 * @param {object} ctx - Host plugin context.
 * @param {string} name - Service name.
 * @returns {object|null} The service, or `null` when unavailable.
 */
function optionalService(ctx, name) {
  try {
    // Cordis contexts expose `get(name, false)` to read a service without
    // declaring an inject dependency; the plain property read is a fallback
    // for lightweight fake contexts used by tests.
    if (ctx && typeof ctx.get === "function") {
      return ctx.get(name, false) ?? null;
    }
    return ctx?.[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * Activate the plugin. Only `config.home` is honored; unknown keys are
 * ignored. Registration never blocks on network or index reconciliation.
 *
 * @param {object} ctx - Host plugin context.
 * @param {object} [config] - Plugin config row.
 */
export function apply(ctx, config = {}) {
  const logger = createLogger(ctx);
  let configStore = null;
  let db = null;
  let initError = null;
  let recallState = null;

  // Config store; keep it (and the API) alive even when loading fails.
  try {
    configStore = createConfigStore({ home: config.home || DEFAULT_HOME, logger });
  } catch (err) {
    initError = `config store: ${messageOf(err)}`;
    logger.error(`[context-rag] failed to create config store: ${initError}`);
  }

  if (configStore) {
    try {
      configStore.load();
      if (configStore.loadError) {
        initError ??= `config: ${messageOf(configStore.loadError)}`;
        logger.warn(`[context-rag] config load warning: ${initError}`);
      }
    } catch (err) {
      initError = `config: ${messageOf(err)}`;
      logger.warn(`[context-rag] config load failed: ${initError}`);
    }

    // Index database; on failure keep the API registered so the config page
    // can surface the error.
    try {
      db = openIndexDatabase(path.join(configStore.home, "index.sqlite"), { logger });
    } catch (err) {
      initError = messageOf(err);
      logger.error(`[context-rag] failed to open index database: ${initError}`);
    }

    // Persistent recall state for turn dedupe; independent of the index
    // database and fail-open: if it cannot be created or loaded, continue
    // without it (turn dedupe simply does not run).
    try {
      recallState = createRecallState({
        file: path.join(configStore.home, "recall-state.json"),
        logger,
      });
      const config = configStore.get();
      recallState.load({
        retentionDays: config.retrieval?.dedupeStateRetentionDays ?? 90,
        maxSessions: config.retrieval?.dedupeStateMaxSessions ?? 500,
      });
    } catch (err) {
      recallState = null;
      initError ??= `recall-state: ${messageOf(err)}`;
      logger.error(`[context-rag] recall-state setup failed: ${initError}`);
    }
  } else if (!initError) {
    initError = "config store unavailable";
  }

  // Clients are always created; they read config lazily on every call.
  const embeddings = createEmbeddingClient({
    getConfig: () => (configStore ? configStore.get() : {}),
    logger,
  });
  const reranker = createRerankClient({
    getConfig: () => (configStore ? configStore.get() : {}),
    logger,
  });

  let capture = null;
  let indexer = null;
  let retriever = null;
  let injector = null;
  let memoryStore = null;

  // Memory store: Markdown memories plus the memory_* tools. Independent of
  // the index database (files are the source of truth) but needed by the
  // indexer's memory scan and the agent tools; fail-open like the rest.
  if (configStore) {
    try {
      memoryStore = createMemoryStore({ home: configStore.home, configStore, logger });
    } catch (err) {
      initError ??= `memory store: ${messageOf(err)}`;
      logger.error(`[context-rag] failed to create memory store: ${initError}`);
    }
  }

  if (db) {
    try {
      capture = createCapture({ db, configStore, logger });
    } catch (err) {
      initError = `capture: ${messageOf(err)}`;
      logger.error(`[context-rag] failed to create capture: ${initError}`);
    }
    try {
      indexer = createIndexer({ db, configStore, embeddings, logger, home: configStore.home, memoryStore });
    } catch (err) {
      initError = `indexer: ${messageOf(err)}`;
      logger.error(`[context-rag] failed to create indexer: ${initError}`);
    }
    try {
      retriever = createRetriever({ db, configStore, embeddings, reranker, recallState, logger });
    } catch (err) {
      initError = `retriever: ${messageOf(err)}`;
      logger.error(`[context-rag] failed to create retriever: ${initError}`);
    }
    try {
      injector = createInjector({ retriever, configStore, recallState, logger });
    } catch (err) {
      initError = `injector: ${messageOf(err)}`;
      logger.error(`[context-rag] failed to create injector: ${initError}`);
    }

    if (capture) {
      try {
        if (typeof ctx.effect === "function") {
          ctx.effect(() => capture.attach(ctx), "context-rag: capture listeners");
        } else {
          capture.attach(ctx);
        }
      } catch (err) {
        initError ??= `capture attach: ${messageOf(err)}`;
        logger.error(`[context-rag] capture attach failed: ${messageOf(err)}`);
      }
    }
    if (injector) {
      try {
        if (typeof ctx.effect === "function") {
          ctx.effect(() => injector.attach(ctx), "context-rag: pre-step injection");
        } else {
          injector.attach(ctx);
        }
      } catch (err) {
        initError ??= `injector attach: ${messageOf(err)}`;
        logger.error(`[context-rag] injector attach failed: ${messageOf(err)}`);
      }
    }

    if (indexer) {
      try {
        const result = indexer.start(); // Fire-and-forget; never blocks activation.
        if (result && typeof result.then === "function") {
          result.catch((err) => logger.error(`[context-rag] indexer failed: ${messageOf(err)}`));
        }
      } catch (err) {
        logger.error(`[context-rag] indexer failed to start: ${messageOf(err)}`);
      }
      ctx.effect(() => () => indexer.stop(), "context-rag: indexer stop");
    }
    ctx.effect(() => () => db.close(), "context-rag: db close");
  }

  // Config API. Prefer injection so the route only mounts once webServer is
  // available; fall back to a directly present `ctx.webServer`.
  const deps = { configStore, db, embeddings, reranker, indexer, retriever, injector, recallState, initError };
  try {
    if (typeof ctx.inject === "function") {
      ctx.inject(["webServer"], (webCtx) => {
        try {
          registerApi(webCtx, deps);
        } catch (err) {
          logger.error(`[context-rag] failed to register config API: ${messageOf(err)}`);
        }
      });
    } else if (ctx.webServer) {
      registerApi(ctx, deps);
    }
  } catch (err) {
    logger.error(`[context-rag] failed to register config API: ${messageOf(err)}`);
  }

  // Agent memory tools. Prefer injection so the tools only register once the
  // host's `tools` service is available; the registration lifecycle is owned
  // by `ctx.tools.register` itself. A missing tools service (or a fake ctx
  // whose `inject` calls back immediately without `tools`) only disables the
  // tools — it never affects the rest of the plugin. A missing index db or
  // indexer is left to the tools to fail clearly at call time.
  if (memoryStore) {
    const memoryDeps = {
      memoryStore,
      db,
      indexer,
      configStore,
      recallState,
      // The `turnBoundary` projection lives in this core service; when a host
      // does not expose it, memory writes simply are not recorded for dedupe.
      sessionProjections: optionalService(ctx, "sessionProjections"),
      logger,
    };
    try {
      if (typeof ctx.inject === "function") {
        ctx.inject(["tools"], (toolsCtx) => {
          try {
            if (toolsCtx?.tools && typeof toolsCtx.tools.register === "function") {
              registerMemoryTools(toolsCtx, memoryDeps);
            } else {
              logger.warn("[context-rag] tools service unavailable; memory tools not registered");
            }
          } catch (err) {
            logger.warn(`[context-rag] failed to register memory tools: ${messageOf(err)}`);
          }
        });
      } else if (ctx.tools && typeof ctx.tools.register === "function") {
        registerMemoryTools(ctx, memoryDeps);
      } else {
        logger.warn("[context-rag] tools service unavailable; memory tools not registered");
      }
    } catch (err) {
      logger.warn(`[context-rag] failed to register memory tools: ${messageOf(err)}`);
    }
  } else {
    logger.warn("[context-rag] memory store unavailable; memory tools not registered");
  }
}
