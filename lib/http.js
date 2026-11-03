/**
 * Low-level OpenAI-compatible HTTP client helpers shared by the embedding and
 * rerank clients.
 *
 * @module http
 */

/**
 * Error thrown for every failure of `requestJson`. Carries a stable machine
 * readable `code` so callers can distinguish timeout / network / HTTP status /
 * parse failures, plus the HTTP status and a `details` object when relevant.
 */
export class HttpError extends Error {
  /**
   * @param {string} code - Stable error code. See `requestJson` for the codes
   *   this module produces (`REQUEST_TIMEOUT`, `NETWORK_ERROR`, `ABORTED`,
   *   `INVALID_RESPONSE`, `HTTP_ERROR`).
   * @param {string} message - Human readable description.
   * @param {object} [options]
   * @param {number|null} [options.status] - HTTP status when the failure came
   *   from a non-2xx response, otherwise null.
   * @param {boolean} [options.retryable] - Whether retrying may succeed.
   * @param {object|null} [options.details] - Extra structured context, e.g.
   *   `{ body }` with a bounded response body preview.
   */
  constructor(code, message, { status = null, retryable = false, details = null } = {}) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
    /** @type {number|null} Delay in milliseconds suggested by a `Retry-After`
     *  response header, when the failing response carried one. */
    this.retryAfterMs = null;
  }
}

/** HTTP statuses that are safe to retry (transient / throttling). */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Cap for body text kept in error `details.body`. */
const BODY_PREVIEW_LIMIT = 4096;

/** Cap for the body preview embedded in the error message. */
const MESSAGE_PREVIEW_LIMIT = 160;

/** Upper bound for a `Retry-After` derived delay (defensive against absurd
 *  values from misconfigured servers). */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Join a base URL and a path with exactly one slash between them.
 *
 * A trailing slash on `base` and a leading slash on `path` are trimmed so the
 * result never contains `//` at the seam. When `path` is already an absolute
 * http(s) URL it is returned unchanged.
 *
 * @param {string} baseUrl - Base URL, e.g. `https://api.example.com/v1/`.
 * @param {string} path - Relative path (optionally starting with `/`) or an
 *   absolute http(s) URL.
 * @returns {string} The joined URL.
 */
export function joinUrl(baseUrl, path) {
  const rawPath = String(path ?? "");
  if (/^https?:\/\//i.test(rawPath)) {
    return rawPath;
  }
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  const cleaned = rawPath.replace(/^\/+/, "");
  return `${base}/${cleaned}`;
}

/**
 * Case-insensitive check whether a plain headers object already contains a
 * header name.
 *
 * @param {Record<string, string>} headers
 * @param {string} name
 * @returns {boolean}
 */
function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * Parse a `Retry-After` header value into a delay in milliseconds.
 *
 * Supports both forms allowed by RFC 9110: a delay in seconds, or an
 * HTTP-date. Past dates yield 0 (retry immediately). Returns null when the
 * value cannot be parsed.
 *
 * @param {string|null|undefined} value - Raw header value.
 * @returns {number|null} Delay in milliseconds, capped at `MAX_RETRY_AFTER_MS`.
 */
function parseRetryAfter(value) {
  if (value == null) {
    return null;
  }
  const v = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(v)) {
    const seconds = Number(v);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(v);
  if (!Number.isFinite(date)) {
    return null;
  }
  const seconds = Math.max(0, (date - Date.now()) / 1000);
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/**
 * Collapse whitespace in a response body preview for embedding in a message.
 *
 * @param {string} text
 * @returns {string}
 */
function previewLine(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MESSAGE_PREVIEW_LIMIT
    ? `${oneLine.slice(0, MESSAGE_PREVIEW_LIMIT)}…`
    : oneLine;
}

/**
 * Sleep for `ms`, aborting early (rejecting with an `ABORTED` HttpError) when
 * the caller signal aborts.
 *
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HttpError("ABORTED", "Request aborted by caller", { retryable: false }));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new HttpError("ABORTED", "Request aborted by caller", { retryable: false }));
    };
    function cleanup() {
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Perform a single fetch attempt with a combined caller/timeout abort signal.
 *
 * On failure throws an `HttpError` classified as `REQUEST_TIMEOUT`,
 * `NETWORK_ERROR`, `ABORTED`, `HTTP_ERROR`, or `INVALID_RESPONSE`.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.method
 * @param {Record<string, string>} opts.headers
 * @param {string|undefined} opts.body
 * @param {AbortSignal|undefined} opts.signal
 * @param {number} opts.timeoutMs
 * @returns {Promise<{data: any, status: number, headers: Headers}>}
 */
async function attemptOnce({ url, method, headers, body, signal, timeoutMs }) {
  let timeoutSignal = null;
  let timedOutFlag = false;
  let combined;
  if (typeof AbortSignal.any === "function") {
    timeoutSignal = AbortSignal.timeout(timeoutMs);
    timeoutSignal.addEventListener("abort", () => {
      timedOutFlag = true;
    }, { once: true });
    const signals = [timeoutSignal];
    if (signal) {
      signals.push(signal);
    }
    combined = AbortSignal.any(signals);
  } else {
    // Manual fallback for runtimes without AbortSignal.any.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOutFlag = true;
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    }, timeoutMs);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        controller.abort(signal.reason);
      }, { once: true });
    }
    combined = controller.signal;
  }

  const throwTransportError = (err) => {
    if (signal?.aborted) {
      throw new HttpError("ABORTED", "Request aborted by caller", { retryable: false });
    }
    if (timedOutFlag || timeoutSignal?.aborted) {
      throw new HttpError(
        "REQUEST_TIMEOUT",
        `Request timed out after ${timeoutMs}ms`,
        { retryable: true },
      );
    }
    throw new HttpError(
      "NETWORK_ERROR",
      `Network error: ${err?.message ?? String(err)}`,
      { retryable: true },
    );
  };

  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: combined });
  } catch (err) {
    throwTransportError(err);
  }

  let bodyText;
  try {
    bodyText = await response.text();
  } catch (err) {
    throwTransportError(err);
  }

  if (response.ok) {
    let data;
    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      throw new HttpError(
        "INVALID_RESPONSE",
        `Invalid JSON response from ${url}`,
        { status: response.status, retryable: false, details: { body: bodyText.slice(0, BODY_PREVIEW_LIMIT) } },
      );
    }
    return { data, status: response.status, headers: response.headers };
  }

  const bounded = bodyText.slice(0, BODY_PREVIEW_LIMIT);
  const status = response.status;
  const retryable = RETRYABLE_STATUSES.has(status);
  const error = new HttpError(
    "HTTP_ERROR",
    `HTTP ${status}${bounded ? `: ${previewLine(bounded)}` : ""}`,
    { status, retryable, details: { body: bounded } },
  );
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfterMs !== null) {
    error.retryAfterMs = retryAfterMs;
  }
  throw error;
}

/**
 * Send a JSON HTTP request with timeout and bounded retry behaviour.
 *
 * The body is JSON-encoded exactly once; a `content-type: application/json`
 * header is added unless the caller already provided one (case-insensitive).
 * String bodies are passed through verbatim.
 *
 * The caller's `signal` is combined with an internal timeout via
 * `AbortSignal.any` (with a manual fallback), so a stalled server aborts with
 * the stable `REQUEST_TIMEOUT` code while a caller abort surfaces as
 * `ABORTED` and is never retried.
 *
 * Retries happen only for network errors, timeouts, and HTTP 408/425/429/
 * 500/502/503/504, up to `maxRetries` times, with exponential backoff plus
 * jitter. A `Retry-After` header (delay in seconds, or an HTTP-date) is
 * honored when present and takes precedence over the backoff schedule.
 * Retries are logged exclusively through the optional `logger.warn`.
 *
 * @param {string} url - Target URL.
 * @param {object} [options]
 * @param {string} [options.method="POST"] - HTTP method.
 * @param {Record<string, string>} [options.headers={}] - Request headers.
 * @param {*} [options.body] - Object to JSON-encode, or a raw string body.
 * @param {AbortSignal} [options.signal] - Caller abort signal.
 * @param {number} [options.timeoutMs=3000] - Per-attempt timeout in ms.
 * @param {number} [options.maxRetries=2] - Retry count after the first attempt.
 * @param {number} [options.retryDelayMs=500] - Base backoff delay in ms.
 * @param {{warn?: (message: string) => void}} [options.logger] - Optional
 *   logger used only for retry notices.
 * @returns {Promise<{data: any, status: number, headers: Headers}>} Parsed
 *   JSON payload, HTTP status, and response headers.
 * @throws {HttpError} On any failure, with a stable `code`:
 *   - `REQUEST_TIMEOUT` — the request exceeded `timeoutMs` (retryable).
 *   - `NETWORK_ERROR` — transport failure, e.g. connection refused (retryable).
 *   - `ABORTED` — the caller aborted via `signal` (not retryable).
 *   - `HTTP_ERROR` — non-2xx response; `status` and `details.body` carry the
 *     response, `retryable` reflects the status code.
 *   - `INVALID_RESPONSE` — 2xx but the body is not valid JSON (not retryable).
 */
export async function requestJson(url, {
  method = "POST",
  headers = {},
  body,
  signal,
  timeoutMs = 3000,
  maxRetries = 2,
  retryDelayMs = 500,
  logger,
} = {}) {
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : 3000;
  const effectiveRetries = Number.isInteger(maxRetries) && maxRetries >= 0
    ? maxRetries
    : 2;
  const effectiveRetryDelay = Number.isFinite(retryDelayMs) && retryDelayMs >= 0
    ? retryDelayMs
    : 500;

  const bodyText = typeof body === "string"
    ? body
    : (body === undefined ? undefined : JSON.stringify(body));
  const requestHeaders = { ...headers };
  if (!hasHeader(requestHeaders, "content-type") && bodyText !== undefined) {
    requestHeaders["content-type"] = "application/json";
  }

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await attemptOnce({
        url,
        method,
        headers: requestHeaders,
        body: bodyText,
        signal,
        timeoutMs: effectiveTimeout,
      });
    } catch (err) {
      const httpError = err instanceof HttpError ? err : new HttpError(
        "NETWORK_ERROR",
        `Network error: ${err?.message ?? String(err)}`,
        { retryable: true },
      );
      if (!httpError.retryable) {
        throw httpError;
      }
      if (attempt >= effectiveRetries) {
        throw httpError;
      }
      attempt += 1;
      let delay = httpError.retryAfterMs;
      if (delay === null) {
        const backoff = effectiveRetryDelay * (2 ** (attempt - 1));
        delay = backoff + Math.random() * effectiveRetryDelay;
      }
      if (logger?.warn) {
        logger.warn(
          `[http] retrying ${url} (attempt ${attempt}/${effectiveRetries}) after ${Math.round(delay)}ms: ${httpError.code}${httpError.status ? ` HTTP ${httpError.status}` : ""}`,
        );
      }
      await sleep(delay, signal);
    }
  }
}
