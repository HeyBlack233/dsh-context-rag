/**
 * HTTP API for the dsh-context-rag configuration page.
 *
 * Deliberately dependency-light: only Node built-ins are imported, and every
 * action works against the `deps` object passed by `index.js`, so this module
 * loads and is testable before the Phase-1/Phase-2 modules exist.
 *
 * Actions cover status/config, connection tests, index management, and the
 * in-memory log buffer: `logs.get` snapshots the buffer, `logs.configure`
 * resizes/toggles it (persisting via the config store), and `logs.export`
 * writes a log file under `<home>/logs`.
 *
 * @module api
 */

import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import { MAX_LOG_LIMIT } from "./log-buffer.js";

/** Exact URL path the API is registered on. */
export const API_PATH = "/plugins/dsh-context-rag/api";

/** Upper bound for a request body, in bytes. */
export const MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Cap applied to error messages before they are sent to the client. */
const MAX_ERROR_MESSAGE_LENGTH = 500;

/** Stats returned when the index database is unavailable. */
const ZERO_STATS = {
  pairCount: 0,
  indexedCount: 0,
  pendingCount: 0,
  errorCount: 0,
  model: null,
  dim: null,
};

/**
 * Build a failure response body.
 * @returns {{ok: false, error: {code: string, message: string, status: number, details: object|null}}}
 */
function failure(code, message, status, details = null) {
  return { ok: false, error: { code, message, status, details } };
}

/**
 * Map a thrown error to a stable client error payload. Keeps `error.code`
 * when it is a string, `error.status` when it is a 4xx/5xx, and truncates the
 * message to `MAX_ERROR_MESSAGE_LENGTH`.
 */
function mapError(err) {
  const code = typeof err?.code === "string" && err.code.length > 0
    ? err.code
    : "INTERNAL_ERROR";
  const rawStatus = Number.isInteger(err?.status) ? err.status : 0;
  const status = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  const message = String(err?.message ?? err ?? "Internal error").slice(0, MAX_ERROR_MESSAGE_LENGTH);
  return { code, message, status, details: err?.details ?? null };
}

/** Case-insensitive header lookup for a plain headers object. */
function headerOf(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** True when the content-type is `application/json` (parameters ignored). */
function isJsonContentType(value) {
  if (!value) return false;
  const mediaType = String(value).split(";")[0].trim().toLowerCase();
  return mediaType === "application/json";
}

/** Extract the host part of an Origin header value. */
function parseOriginHost(origin) {
  try {
    return new URL(String(origin)).host;
  } catch {
    const match = String(origin).match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
    return match ? match[1] : null;
  }
}

/**
 * Cross-site request trust checks: reject `sec-fetch-site: cross-site`, and
 * reject requests whose Origin host differs from the Host header.
 */
function checkTrust(headers) {
  const secFetchSite = headerOf(headers, "sec-fetch-site");
  if (secFetchSite && String(secFetchSite).trim().toLowerCase() === "cross-site") {
    return { ok: false, message: "Cross-site requests are not allowed" };
  }
  const origin = headerOf(headers, "origin");
  if (origin) {
    const host = headerOf(headers, "host");
    const originHost = parseOriginHost(origin);
    if (!host || !originHost || originHost.toLowerCase() !== String(host).toLowerCase()) {
      return { ok: false, message: "Origin host does not match the Host header" };
    }
  }
  return { ok: true, message: null };
}

/**
 * Read a request body up to `limit` bytes, rejecting with a
 * `BODY_TOO_LARGE` error when the limit is exceeded.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const settle = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };
    const onData = (chunk) => {
      size += chunk?.length ?? 0;
      if (size > limit) {
        settle();
        const err = new Error(`Request body exceeds ${limit} bytes`);
        err.code = "BODY_TOO_LARGE";
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    };
    const onEnd = () => {
      settle();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (err) => {
      settle();
      reject(err);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** Send a JSON response with the given status. */
function respond(res, status, body) {
  const text = JSON.stringify(body);
  if (typeof res.writeHead === "function") {
    res.writeHead(status, { "content-type": "application/json" });
  } else if (typeof res.statusCode === "number") {
    res.statusCode = status;
  }
  if (typeof res.end === "function") {
    res.end(text);
  }
}

/** Masked config with the resolved home directory added. */
function maskedConfig(deps) {
  const store = deps?.configStore;
  const masked = store && typeof store.masked === "function" ? store.masked() : {};
  return { ...(masked ?? {}), home: store?.home ?? null };
}

/** Status of a surface, or null when the surface is unavailable. */
function safeStatus(surface) {
  if (!surface || typeof surface.status !== "function") return null;
  try {
    return surface.status();
  } catch {
    return null;
  }
}

/**
 * Database stats plus filesystem-derived `pairFiles` and `indexBytes`.
 * Both filesystem fields fall back to 0 on any read error.
 */
function computeStats(deps) {
  let base;
  try {
    base = deps?.db && typeof deps.db.stats === "function" ? deps.db.stats() : null;
  } catch {
    base = null;
  }
  const stats = base ?? ZERO_STATS;
  const home = deps?.configStore?.home;
  let pairFiles = 0;
  let indexBytes = 0;
  if (typeof home === "string" && home.length > 0) {
    try {
      // Pair files live one level deeper: <home>/pairs/<workspace-slug>/<session-slug>.jsonl.
      pairFiles = readdirSync(path.join(home, "pairs"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .length;
    } catch {
      pairFiles = 0;
    }
    for (const suffix of ["", "-wal"]) {
      try {
        const entry = statSync(path.join(home, `index.sqlite${suffix}`));
        if (entry.isFile()) indexBytes += entry.size;
      } catch {
        // Missing or unreadable file; keep the running total.
      }
    }
  }
  return { ...stats, pairFiles, indexBytes };
}

/** Runtime status: indexer/retriever/injector surfaces plus initError. */
function computeRuntime(deps) {
  const indexerStatus = safeStatus(deps?.indexer);
  const retrieverStatus = safeStatus(deps?.retriever);
  const injectorStatus = safeStatus(deps?.injector);
  const lastError = indexerStatus?.lastError
    ?? retrieverStatus?.lastError
    ?? injectorStatus?.lastError
    ?? deps?.initError
    ?? null;
  return {
    indexerRunning: indexerStatus?.running ?? false,
    initError: deps?.initError ?? null,
    lastError,
    lastRetrieval: retrieverStatus?.lastRetrieval ?? null,
  };
}

/** The full status payload for the `status` action. */
function buildStatus(deps) {
  return { config: maskedConfig(deps), stats: computeStats(deps), runtime: computeRuntime(deps) };
}

/**
 * Snapshot of the in-memory log buffer for clients: current limit, debug
 * capture flag, and a detached copy of the buffered entries (oldest first).
 * Every field degrades gracefully when the buffer is missing.
 */
function buildLogs(deps) {
  const logs = deps?.logs;
  return {
    limit: logs?.limit ?? 0,
    debug: Boolean(logs?.debug),
    entries: typeof logs?.entries === "function" ? logs.entries() : [],
  };
}

/** True for plain (non-array) objects. */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Invoke a fire-and-forget function, swallowing synchronous and async errors. */
function fireAndForget(fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      result.catch(() => {});
    }
  } catch {
    // Ignored; failures surface through the surface's own status().
  }
}

/**
 * Execute one API action against `deps`.
 *
 * Internal helper, exported so tests can drive actions without HTTP; not part
 * of the production API surface.
 *
 * @param {{action: string, payload?: object}} request - Parsed request body.
 * @param {object|null} deps - Dependency bag from `index.js` (may be partial).
 * @returns {Promise<{ok: true, value: *}|{ok: false, error: object}>} Never throws.
 */
export async function dispatch(request = {}, deps = null) {
  try {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return failure("MALFORMED_JSON", "Request body must be a JSON object", 400);
    }
    const { action, payload } = request;
    if (typeof action !== "string" || action.length === 0) {
      return failure("MALFORMED_JSON", "Request body must be an object with an action string", 400);
    }
    switch (action) {
      case "status":
        return { ok: true, value: buildStatus(deps) };
      case "config.get":
        return { ok: true, value: maskedConfig(deps) };
      case "config.save": {
        if (!deps?.configStore) {
          return failure("NOT_READY", "Config store is not available", 503);
        }
        const patch = payload?.config;
        if (!isPlainObject(patch)) {
          return failure("INVALID_PAYLOAD", "payload.config must be a plain object", 400);
        }
        await deps.configStore.save(patch);
        if (deps.indexer) {
          fireAndForget(() => deps.indexer.reconcile?.());
        }
        return { ok: true, value: buildStatus(deps) };
      }
      case "connection.testEmbedding": {
        if (!deps?.embeddings) {
          return failure("NOT_READY", "Embedding client is not available", 503);
        }
        return { ok: true, value: await deps.embeddings.testConnection() };
      }
      case "connection.testRerank": {
        if (!deps?.reranker) {
          return failure("NOT_READY", "Rerank client is not available", 503);
        }
        return { ok: true, value: await deps.reranker.testConnection() };
      }
      case "index.rebuild": {
        if (!deps?.indexer) {
          return failure("NOT_READY", "Indexer is not available", 503);
        }
        await deps.indexer.reindex();
        return { ok: true, value: buildStatus(deps) };
      }
      case "index.clear": {
        if (!deps?.indexer) {
          return failure("NOT_READY", "Indexer is not available", 503);
        }
        await deps.indexer.clear();
        return { ok: true, value: buildStatus(deps) };
      }
      case "logs.get": {
        if (!deps?.logs) {
          return failure("NOT_READY", "Log buffer is not available", 503);
        }
        return { ok: true, value: buildLogs(deps) };
      }
      case "logs.configure": {
        if (!deps?.logs) {
          return failure("NOT_READY", "Log buffer is not available", 503);
        }
        if (!deps?.configStore) {
          return failure("NOT_READY", "Config store is not available", 503);
        }
        if (!isPlainObject(payload)) {
          return failure("INVALID_PAYLOAD", "payload must be a plain object", 400);
        }
        const hasBufferSize = Object.prototype.hasOwnProperty.call(payload, "bufferSize");
        const hasDebug = Object.prototype.hasOwnProperty.call(payload, "debug");
        if (!hasBufferSize && !hasDebug) {
          return failure("INVALID_PAYLOAD", "payload must include bufferSize or debug", 400);
        }
        // Unknown fields are ignored; only the two recognized fields are
        // validated, each with an explicit presence check so that a key
        // holding `undefined` is rejected as well.
        const patch = {};
        if (hasBufferSize) {
          const bufferSize = payload.bufferSize;
          if (
            typeof bufferSize !== "number" ||
            !Number.isInteger(bufferSize) ||
            bufferSize < 1 ||
            bufferSize > MAX_LOG_LIMIT
          ) {
            return failure(
              "INVALID_PAYLOAD",
              `payload.bufferSize must be an integer between 1 and ${MAX_LOG_LIMIT}`,
              400,
            );
          }
          patch.bufferSize = bufferSize;
        }
        if (hasDebug) {
          if (typeof payload.debug !== "boolean") {
            return failure("INVALID_PAYLOAD", "payload.debug must be a boolean", 400);
          }
          patch.debug = payload.debug;
        }
        // Persist first so a rejected save never mutates the buffer; the
        // config store's onChange listener re-applies the same values in
        // production, so applying here is idempotent.
        await deps.configStore.save({ logging: patch });
        if (hasBufferSize) deps.logs.setLimit(patch.bufferSize);
        if (hasDebug) deps.logs.setDebug(patch.debug);
        return { ok: true, value: buildLogs(deps) };
      }
      case "logs.export": {
        if (!deps?.logs) {
          return failure("NOT_READY", "Log buffer is not available", 503);
        }
        if (!deps?.configStore) {
          return failure("NOT_READY", "Config store is not available", 503);
        }
        const home = deps.configStore.home;
        if (typeof home !== "string" || home.length === 0) {
          return failure("NOT_READY", "Context RAG home is not available", 503);
        }
        // A write failure is caught by `dispatch` and mapped to a 500.
        const { path: filePath, count } = deps.logs.exportTo(path.join(home, "logs"));
        return { ok: true, value: { path: filePath, count } };
      }
      default:
        return failure("UNKNOWN_ACTION", `Unknown action: ${action}`, 400);
    }
  } catch (err) {
    return { ok: false, error: mapError(err) };
  }
}

/**
 * Handle one HTTP request for the config API.
 *
 * Internal handler wired by `registerApi`; exported so tests can drive the
 * full request pipeline with fake req/res objects.
 */
export async function handle(req, res, deps) {
  try {
    if (req.method !== "POST") {
      respond(res, 405, failure("METHOD_NOT_ALLOWED", `Method ${req.method} is not allowed; use POST`, 405));
      return;
    }
    if (!isJsonContentType(headerOf(req.headers, "content-type"))) {
      respond(res, 415, failure("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json", 415));
      return;
    }
    const trust = checkTrust(req.headers);
    if (!trust.ok) {
      respond(res, 403, failure("FORBIDDEN", trust.message, 403));
      return;
    }
    let bodyText;
    try {
      bodyText = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err?.code === "BODY_TOO_LARGE") {
        respond(res, 413, failure("BODY_TOO_LARGE", "Request body is too large", 413));
      } else {
        respond(res, 500, failure("INTERNAL_ERROR", String(err?.message ?? err).slice(0, MAX_ERROR_MESSAGE_LENGTH), 500));
      }
      req.resume?.(); // Drain the oversized (or failed) stream.
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      respond(res, 400, failure("MALFORMED_JSON", "Request body is not valid JSON", 400));
      return;
    }
    const result = await dispatch(parsed, deps);
    respond(res, result.ok ? 200 : result.error.status, result);
  } catch (err) {
    try {
      respond(res, 500, failure("INTERNAL_ERROR", String(err?.message ?? err).slice(0, MAX_ERROR_MESSAGE_LENGTH), 500));
    } catch {
      // The response was already sent or is unusable; nothing more to do.
    }
  }
}

/**
 * Register the config API on `ctx.webServer` for the lifetime of `ctx`.
 *
 * @param {object} ctx - A context with `effect` and `webServer`.
 * @param {object} deps - Dependency bag (see `dispatch`).
 */
export function registerApi(ctx, deps) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: API_PATH,
      handler: (req, res) => handle(req, res, deps),
    }),
    "context-rag: config API",
  );
}
