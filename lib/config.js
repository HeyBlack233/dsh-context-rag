/**
 * Configuration handling for dsh-context-rag.
 *
 * Provides the default configuration, validation and normalization of raw
 * configuration objects, and a small synchronous configuration store that
 * persists the normalized configuration as JSON inside a home directory.
 *
 * Plain ESM JavaScript. Requires Node.js >= 22.
 *
 * @module config
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Default location of the context-rag configuration directory.
 *
 * Derived from the `DSH_HOME` environment variable when set, otherwise
 * `~/.dsh`, with `context-rag` appended.
 *
 * @type {string}
 */
const DEFAULT_HOME = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), ".dsh"),
  "context-rag",
);

/**
 * Recursively freeze a plain object so that it and every nested object
 * become read-only.
 *
 * @param {object} obj - Object to freeze.
 * @returns {object} The same object, deeply frozen.
 */
function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (isPlainObject(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

/**
 * Default configuration for dsh-context-rag.
 *
 * Deep frozen: read it, never mutate it. `normalizeConfig()` returns plain
 * (unfrozen) objects derived from it.
 *
 * @type {object}
 */
const DEFAULT_CONFIG = deepFreeze({
  enabled: true,
  embedding: {
    baseUrl: "",
    apiKey: "",
    model: "",
    dimensions: null,
    timeoutMs: 3000,
    maxRetries: 2,
    batchSize: 16,
    maxEmbeddingChars: 8000,
  },
  rerank: {
    enabled: false,
    baseUrl: "",
    path: "/rerank",
    apiKey: "",
    model: "",
    timeoutMs: 5000,
    maxRetries: 1,
  },
  retrieval: {
    scope: "workspace",
    candidateLimit: 20,
    topK: 5,
    minScore: 0.4,
    rerankMinScore: 0.4,
    maxContextChars: 3000,
    timeoutMs: 3000,
    injectionEnabled: true,
    scanLimit: 5000,
  },
  indexing: {
    enabled: true,
    retryDelayMs: 2000,
    maxAttempts: 8,
    pollIntervalMs: 1000,
  },
});

/**
 * Error thrown when a configuration value is invalid.
 *
 * @augments Error
 */
class ConfigError extends Error {
  /**
   * @param {string} message - Human readable description of the failure.
   * @param {{field: string|null, reason: string}|null} [details] - Structured
   *   details about the offending field and why it was rejected.
   */
  constructor(message, details = null) {
    super(message);
    this.name = "ConfigError";
    this.code = "INVALID_CONFIG";
    this.status = 400;
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
 * Deep clone of plain JSON-like data (objects, arrays, primitives).
 *
 * @param {unknown} value - Value to clone.
 * @returns {unknown} Deep copy of `value`.
 */
function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clonePlain(value[key]);
    return out;
  }
  return value;
}

/**
 * Deep merge `source` over `target`, keeping only keys that already exist in
 * `target` at every level. Unknown keys in `source` are ignored.
 *
 * `undefined` source values keep the target value. `null` source values keep
 * the target value when the target value is an object, and otherwise replace
 * it with `null`.
 *
 * @param {object} target - Schema/base object; defines the known keys.
 * @param {object} source - Overrides to apply.
 * @returns {object} New plain object with merged values.
 */
function deepMerge(target, source) {
  const out = {};
  for (const key of Object.keys(target)) {
    const targetValue = target[key];
    const sourceValue = source[key];
    if (sourceValue === undefined) {
      out[key] = clonePlain(targetValue);
    } else if (
      isPlainObject(targetValue) &&
      (isPlainObject(sourceValue) || sourceValue === null)
    ) {
      out[key] =
        sourceValue === null
          ? clonePlain(targetValue)
          : deepMerge(targetValue, sourceValue);
    } else {
      out[key] = clonePlain(sourceValue);
    }
  }
  return out;
}

/**
 * Throw a ConfigError for a rejected field.
 *
 * @param {string} field - Dot separated field path (e.g. "embedding.timeoutMs").
 * @param {string} reason - Why the field was rejected.
 * @throws {ConfigError} Always.
 */
function fail(field, reason) {
  throw new ConfigError(`Invalid config: "${field}" ${reason}`, {
    field,
    reason,
  });
}

/**
 * @param {unknown} value - Value to test.
 * @param {string} field - Field path used in error details.
 * @throws {ConfigError} When `value` is not a boolean.
 */
function checkBoolean(value, field) {
  if (typeof value !== "boolean") fail(field, "must be a boolean");
}

/**
 * @param {unknown} value - Value to test.
 * @param {string} field - Field path used in error details.
 * @throws {ConfigError} When `value` is not a string.
 */
function checkString(value, field) {
  if (typeof value !== "string") fail(field, "must be a string");
}

/**
 * @param {unknown} value - Value to test.
 * @param {string} field - Field path used in error details.
 * @param {number} min - Inclusive lower bound.
 * @param {number} max - Inclusive upper bound.
 * @throws {ConfigError} When `value` is not a finite number within range.
 */
function checkNumber(value, field, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(field, `must be a number between ${min} and ${max}`);
  }
  if (value < min || value > max) {
    fail(field, `must be between ${min} and ${max}`);
  }
}

/**
 * Validate a base URL: must be an empty string or a well-formed http(s) URL.
 *
 * @param {unknown} value - Value to test.
 * @param {string} field - Field path used in error details.
 * @throws {ConfigError} When `value` is invalid.
 */
function checkBaseUrl(value, field) {
  checkString(value, field);
  if (value === "") return;
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(field, "must be empty or a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(field, "must be empty or a valid http(s) URL");
  }
}

/**
 * Validate the rerank endpoint path: non-empty, starts with "/", contains no
 * whitespace and no "://".
 *
 * @param {unknown} value - Value to test.
 * @throws {ConfigError} When `value` is invalid.
 */
function checkRerankPath(value) {
  const field = "rerank.path";
  checkString(value, field);
  if (value.length === 0 || !value.startsWith("/")) {
    fail(field, "must be non-empty and start with \"/\"");
  }
  if (/\s/.test(value)) fail(field, "must not contain whitespace");
  if (value.includes("://")) fail(field, "must not contain \"://\"");
}

/**
 * Validate an API key: must be a string or null. `null` is normalized to an
 * empty string by the caller to mean "cleared".
 *
 * @param {unknown} value - Value to test.
 * @param {string} field - Field path used in error details.
 * @throws {ConfigError} When `value` is neither a string nor null.
 */
function checkApiKey(value, field) {
  if (value === null) return;
  checkString(value, field);
}

/**
 * Validate a fully merged configuration object.
 *
 * @param {object} config - Merged configuration to validate.
 * @throws {ConfigError} On the first invalid field.
 */
function validate(config) {
  checkBoolean(config.enabled, "enabled");
  checkBoolean(config.rerank.enabled, "rerank.enabled");
  checkBoolean(config.retrieval.injectionEnabled, "retrieval.injectionEnabled");
  checkBoolean(config.indexing.enabled, "indexing.enabled");

  checkBaseUrl(config.embedding.baseUrl, "embedding.baseUrl");
  checkBaseUrl(config.rerank.baseUrl, "rerank.baseUrl");
  checkRerankPath(config.rerank.path);

  checkString(config.embedding.model, "embedding.model");
  config.embedding.model = config.embedding.model.trim();
  checkString(config.rerank.model, "rerank.model");
  config.rerank.model = config.rerank.model.trim();

  checkApiKey(config.embedding.apiKey, "embedding.apiKey");
  if (config.embedding.apiKey === null) config.embedding.apiKey = "";
  checkApiKey(config.rerank.apiKey, "rerank.apiKey");
  if (config.rerank.apiKey === null) config.rerank.apiKey = "";

  if (config.embedding.dimensions !== null) {
    const dimensions = config.embedding.dimensions;
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192) {
      fail(
        "embedding.dimensions",
        "must be an integer between 1 and 8192, or null",
      );
    }
  }

  checkNumber(config.embedding.timeoutMs, "embedding.timeoutMs", 100, 60000);
  checkNumber(config.embedding.maxRetries, "embedding.maxRetries", 0, 5);
  checkNumber(config.embedding.batchSize, "embedding.batchSize", 1, 128);
  checkNumber(
    config.embedding.maxEmbeddingChars,
    "embedding.maxEmbeddingChars",
    256,
    32000,
  );

  checkNumber(config.rerank.timeoutMs, "rerank.timeoutMs", 100, 60000);
  checkNumber(config.rerank.maxRetries, "rerank.maxRetries", 0, 5);

  checkString(config.retrieval.scope, "retrieval.scope");
  if (
    config.retrieval.scope !== "workspace" &&
    config.retrieval.scope !== "all"
  ) {
    fail("retrieval.scope", "must be \"workspace\" or \"all\"");
  }
  checkNumber(config.retrieval.candidateLimit, "retrieval.candidateLimit", 1, 1000);
  checkNumber(config.retrieval.topK, "retrieval.topK", 1, 100);
  if (config.retrieval.topK > config.retrieval.candidateLimit) {
    fail("retrieval.topK", "must be less than or equal to candidateLimit");
  }
  checkNumber(config.retrieval.minScore, "retrieval.minScore", 0, 1);
  checkNumber(
    config.retrieval.rerankMinScore,
    "retrieval.rerankMinScore",
    0,
    1,
  );
  checkNumber(
    config.retrieval.maxContextChars,
    "retrieval.maxContextChars",
    200,
    20000,
  );
  checkNumber(config.retrieval.timeoutMs, "retrieval.timeoutMs", 100, 60000);
  checkNumber(config.retrieval.scanLimit, "retrieval.scanLimit", 1, 100000);

  checkNumber(config.indexing.retryDelayMs, "indexing.retryDelayMs", 100, 60000);
  checkNumber(config.indexing.maxAttempts, "indexing.maxAttempts", 1, 100);
  checkNumber(config.indexing.pollIntervalMs, "indexing.pollIntervalMs", 100, 60000);
}

/**
 * Normalize a raw configuration object.
 *
 * Deep-merges `raw` over the defaults, keeps only known keys, trims model
 * strings, validates every field, and returns a plain object.
 *
 * @param {object} raw - Raw configuration values (unknown keys are ignored).
 * @param {object} [options] - Options.
 * @param {string} [options.home] - Reserved for callers that pass a home
 *   directory through; currently unused by normalization.
 * @returns {object} Fully populated, validated configuration object.
 * @throws {ConfigError} With `details = {field, reason}` when any field is
 *   invalid.
 */
function normalizeConfig(raw, { home } = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const result = deepMerge(DEFAULT_CONFIG, source);
  validate(result);
  return result;
}

/**
 * Atomically write JSON data to `filePath` via a same-directory temp file
 * created with mode `0o600`.
 *
 * @param {string} filePath - Destination file path.
 * @param {object} data - JSON-serializable data to write.
 */
function writeAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tempPath, filePath);
}

/**
 * Create a synchronous configuration store.
 *
 * @param {object} [options] - Options.
 * @param {string} [options.home] - Directory holding `config.json`. Defaults
 *   to {@link DEFAULT_HOME}.
 * @param {{warn?: Function}} [options.logger] - Optional logger; its `warn`
 *   method is used for load failures.
 * @returns {{
 *   home: string,
 *   path: string,
 *   loadError: Error|null,
 *   load: () => object,
 *   get: () => object,
 *   masked: () => object,
 *   save: (patch: object) => object,
 *   onChange: (fn: Function) => Function,
 *   refresh: () => object,
 * }} The store.
 */
function createConfigStore({ home = DEFAULT_HOME, logger } = {}) {
  const store = {
    /** @type {string} Home directory holding the configuration file. */
    home,

    /** @type {string} Absolute path of the `config.json` file. */
    path: path.join(home, "config.json"),

    /**
     * Last load failure (an Error from read/parse/validation), or `null`
     * when the last load succeeded.
     *
     * @type {Error|null}
     */
    loadError: null,

    /** @type {object} In-memory normalized configuration. */
    _config: clonePlain(DEFAULT_CONFIG),

    /** @type {Array<Function>} Change listeners. */
    _listeners: [],

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
     * Re-read the configuration file synchronously.
     *
     * A missing file, unparseable content, or invalid content all fall back
     * to the defaults. Failures are recorded in `loadError` and reported via
     * the logger's `warn`; this method never throws.
     *
     * @returns {object} The loaded configuration.
     */
    load() {
      let text;
      try {
        text = fs.readFileSync(this.path, "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") {
          this._config = clonePlain(DEFAULT_CONFIG);
          this.loadError = null;
          return this._config;
        }
        this._config = clonePlain(DEFAULT_CONFIG);
        this.loadError = error;
        this._warn(`config load failed: ${error.message}`);
        return this._config;
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        this._config = clonePlain(DEFAULT_CONFIG);
        this.loadError = error;
        this._warn(`config parse failed: ${error.message}`);
        return this._config;
      }

      if (!isPlainObject(parsed)) {
        const error = new ConfigError("Config root must be a plain object", {
          field: null,
          reason: "root must be a plain object",
        });
        this._config = clonePlain(DEFAULT_CONFIG);
        this.loadError = error;
        this._warn(`config validation failed: ${error.message}`);
        return this._config;
      }

      try {
        this._config = normalizeConfig(parsed);
        this.loadError = null;
      } catch (error) {
        this._config = clonePlain(DEFAULT_CONFIG);
        this.loadError = error;
        this._warn(`config validation failed: ${error.message}`);
      }
      return this._config;
    },

    /**
     * Deep clone of the current configuration, including secrets.
     *
     * @returns {object} A detached copy; mutating it does not affect the
     *   store.
     */
    get() {
      return clonePlain(this._config);
    },

    /**
     * Public view of the current configuration with all secrets removed.
     *
     * `embedding.apiKey` and `rerank.apiKey` are deleted. Top-level
     * `apiKeySet` reports whether any key is configured, and `apiKeyPreview`
     * is `"…"` plus the last four characters of the first configured key (or
     * `""`). Full keys are never included.
     *
     * @returns {object} The masked configuration.
     */
    masked() {
      const copy = clonePlain(this._config);
      delete copy.embedding.apiKey;
      delete copy.rerank.apiKey;

      const embeddingKey = this._config.embedding.apiKey;
      const rerankKey = this._config.rerank.apiKey;
      copy.apiKeySet = Boolean(embeddingKey || rerankKey);
      const previewKey = embeddingKey || rerankKey;
      copy.apiKeyPreview = previewKey ? `…${previewKey.slice(-4)}` : "";
      return copy;
    },

    /**
     * Apply a patch, persist, and notify listeners.
     *
     * The patch is deep-merged over the current configuration and normalized
     * (unknown keys are dropped). `apiKey: undefined` keeps the current key,
     * `apiKey: null` clears it, and a string sets it trimmed. The merged
     * configuration is written atomically (temp file, mode `0o600`, rename).
     * On validation failure a ConfigError is thrown and neither the file nor
     * the in-memory state is touched.
     *
     * @param {object} patch - Configuration overrides.
     * @returns {object} The new configuration (a detached copy).
     * @throws {ConfigError} When any merged field is invalid.
     */
    save(patch) {
      const prepared = clonePlain(isPlainObject(patch) ? patch : {});
      for (const section of ["embedding", "rerank"]) {
        const sectionPatch = prepared[section];
        if (!isPlainObject(sectionPatch)) continue;
        if (sectionPatch.apiKey === null) sectionPatch.apiKey = "";
        else if (typeof sectionPatch.apiKey === "string") {
          sectionPatch.apiKey = sectionPatch.apiKey.trim();
        }
      }

      const merged = deepMerge(this._config, prepared);
      const next = normalizeConfig(merged);

      writeAtomic(this.path, next);
      this._config = next;
      this.loadError = null;
      this._notify(clonePlain(next));
      return clonePlain(next);
    },

    /**
     * Register a listener invoked with the new configuration after each
     * successful `save()`.
     *
     * @param {Function} fn - Listener receiving the new configuration.
     * @returns {Function} Disposer; calling it removes the listener.
     * @throws {TypeError} When `fn` is not a function.
     */
    onChange(fn) {
      if (typeof fn !== "function") {
        throw new TypeError("onChange listener must be a function");
      }
      this._listeners.push(fn);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = this._listeners.indexOf(fn);
        if (index !== -1) this._listeners.splice(index, 1);
      };
    },

    /**
     * Notify all listeners of a new configuration; a throwing listener never
     * breaks the store.
     *
     * @param {object} config - New configuration to hand to listeners.
     */
    _notify(config) {
      for (const listener of [...this._listeners]) {
        try {
          listener(config);
        } catch {
          // Listener errors are isolated.
        }
      }
    },

    /**
     * Re-read the configuration file, discarding any in-memory changes.
     *
     * Equivalent to `load()`.
     *
     * @returns {object} The freshly loaded configuration.
     */
    refresh() {
      return this.load();
    },
  };

  return store;
}

export {
  DEFAULT_HOME,
  DEFAULT_CONFIG,
  ConfigError,
  normalizeConfig,
  createConfigStore,
};
