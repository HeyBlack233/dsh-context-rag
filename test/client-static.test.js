// client-static.test.js — static contract checks for client.js, no browser.
//
// Reads client.js as UTF-8 text (never executes it) and asserts the static
// contracts the web client plugin is expected to keep: module loader wiring,
// slot registration, locale registration style, status/config field reads,
// API error handling, save-time apiKey stripping, CSS theme-token usage,
// structured-form markers, and EN/ZH language parity for every UI key.
//
// Plain ESM using node:test + node:assert/strict; requires Node >= 22.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The package root is one level above this test file, regardless of cwd.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readClient() {
  return readFileSync(path.join(root, 'client.js'), 'utf8');
}

test('client.js: module loader wiring and plugin identity', () => {
  const text = readClient();
  assert.ok(text.includes('window.__ModuleLoader__.load'), 'must load via window.__ModuleLoader__.load');
  assert.ok(text.includes('id: "@local/dsh-context-rag"'), 'must declare id @local/dsh-context-rag');
  assert.ok(text.includes('inject: ["slots", "locale"]'), 'must inject ["slots", "locale"]');
});

test('client.js: registers the plugins.bundle.config slot with its key', () => {
  const text = readClient();
  assert.ok(text.includes('plugins.bundle.config'), 'must reference the plugins.bundle.config slot');
  assert.ok(
    text.includes('key: "@local/dsh-context-rag"'),
    'must register slot key @local/dsh-context-rag',
  );
  assert.ok(
    !text.includes('plugins.row.config'),
    'must not register the plugins.row.config slot (no secondary row page)',
  );
});

test('client.js: locale registration is bound, not the legacy helper', () => {
  const text = readClient();
  assert.ok(
    text.includes('ctx.locale.register(LOCALE, messages)'),
    'must register via ctx.locale.register(LOCALE, messages)',
  );
  assert.ok(
    !text.includes('registerLocale('),
    'must not call the unbound registerLocale( helper',
  );
});

test('client.js: status reads config, stats, runtime fields', () => {
  const text = readClient();
  assert.ok(text.includes('status.config'), 'must read status.config');
  assert.ok(text.includes('status.stats'), 'must read status.stats');
  assert.ok(text.includes('status.runtime'), 'must read status.runtime');
  // The status object must not be probed by its display-oriented field names.
  assert.ok(!text.includes('status.counts'), 'must not read status.counts');
  assert.ok(!text.includes('status.embedding'), 'must not read status.embedding');
  assert.ok(!text.includes('status.homePath'), 'must not read status.homePath');
  assert.ok(!text.includes('status.indexerRunning'), 'must not read status.indexerRunning');
});

test('client.js: API error handling reads error.message', () => {
  const text = readClient();
  assert.ok(text.includes('error.message'), 'must surface error.message from API failures');
});

test('client.js: save strips apiKeySet and apiKeyPreview', () => {
  const text = readClient();
  assert.ok(text.includes('apiKeySet'), 'must strip apiKeySet on save');
  assert.ok(text.includes('apiKeyPreview'), 'must strip apiKeyPreview on save');
});

test('client.js: CSS uses only known theme tokens', () => {
  const text = readClient();
  assert.ok(
    text.includes('--dsw-alias-label-primary'),
    'must use the --dsw-alias-label-primary token',
  );
  assert.ok(
    text.includes('--dsw-alias-state-error-primary'),
    'must use the --dsw-alias-state-error-primary token',
  );
  for (const forbidden of [
    '--dsw-alias-text-1',
    '--dsw-alias-text-2',
    '--dsw-alias-text-danger',
  ]) {
    assert.ok(!text.includes(forbidden), `must not use the ${forbidden} token`);
  }
});

test('client.js: structured form markers and field paths exist', () => {
  const text = readClient();
  for (const marker of [
    'settingsTitle',
    'advancedTitle',
    'updateField',
    'apiKeyRow',
    'parsedConfig',
  ]) {
    assert.ok(text.includes(marker), `must define/use ${marker}`);
  }
  for (const fieldPath of [
    'embedding.baseUrl',
    'embedding.model',
    'embedding.apiKey',
    'rerank.model',
    'retrieval.scope',
    'retrieval.topK',
    'retrieval.minScore',
    'indexing.enabled',
  ]) {
    assert.ok(text.includes(fieldPath), `must bind field path ${fieldPath}`);
  }
});

test('client.js: API key input is not forced empty', () => {
  const text = readClient();
  // The password input must be bound to the config value (read(path, ""))
  // rather than a hard-coded empty string.
  assert.ok(
    text.includes('value: read(path, ""'),
    'password input must bind value: read(path, ""',
  );
});

test('client.js: EN/ZH parity for every UI translation key', () => {
  const text = readClient();
  const requiredKeys = [
    'settingsTitle', 'advancedTitle', 'notSet', 'invalidJsonHint',
    'enabled', 'embeddingBaseUrl', 'embeddingModel', 'dimensions',
    'apiKey', 'clearKey', 'timeoutMs', 'maxRetries', 'batchSize',
    'maxEmbeddingChars', 'rerankEnabled', 'rerankBaseUrl', 'rerankModel',
    'rerankPath', 'injectionEnabled', 'scope', 'scopeWorkspace', 'scopeAll',
    'candidateLimit', 'topK', 'minScore', 'maxContextChars',
    'indexingEnabled', 'pollIntervalMs', 'retryDelayMs', 'maxAttempts',
    'configHelp', 'reload', 'save', 'testEmbedding', 'testRerank',
    'rebuild', 'clear', 'confirmClear', 'saved', 'cleared', 'rebuilt',
    'testOk', 'jsonInvalid', 'busy', 'ok', 'error',
  ];
  for (const key of requiredKeys) {
    const pattern = new RegExp(`${key}\\s*:`, 'g');
    const count = (text.match(pattern) || []).length;
    assert.ok(
      count >= 2,
      `key "${key}" must appear at least twice (EN + ZH), found ${count}`,
    );
  }
});
