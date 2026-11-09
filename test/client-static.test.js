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
    'formCard',
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
    'retrieval.rerankMinScore',
    'retrieval.allowSameSession',
    'retrieval.dedupeTurns',
    'retrieval.dedupeStateRetentionDays',
    'retrieval.dedupeStateMaxSessions',
    'indexing.enabled',
  ]) {
    assert.ok(text.includes(fieldPath), `must bind field path ${fieldPath}`);
  }
});

test('client.js: score inputs are two-decimal 0.00-1.00 fields', () => {
  const text = readClient();
  for (const label of ['minScore', 'rerankMinScore']) {
    assert.ok(
      text.includes(`numRow("${label}",`),
      `must render a numeric row for ${label}`,
    );
  }
  assert.ok(
    text.includes('step: 0.01, min: 0, max: 1, fixed: 2'),
    'score rows must use a 0.01 step, 0-1 range, and two-decimal display',
  );
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

test('client.js: one settings card per configuration category', () => {
  const text = readClient();
  for (const titleKey of ['embeddingTitle', 'rerankTitle', 'retrievalTitle', 'indexingTitle']) {
    assert.ok(
      text.includes(`formCard("${titleKey}"`),
      `must render a separate card for ${titleKey}`,
    );
  }
});

test('client.js: dashboard and configuration tabs use accessible tab semantics', () => {
  const text = readClient();
  for (const marker of [
    'role: "tablist"',
    'role: "tab"',
    'role: "tabpanel"',
    'aria-selected',
    '"aria-controls"',
    'tabDomId',
    'panelDomId',
    'storedTab',
    'rememberTab',
    'selectTab',
    'dashboardTab',
    'configurationTab',
  ]) {
    assert.ok(text.includes(marker), `must define/use ${marker}`);
  }
  // Keyboard support and persistent tab selection.
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    assert.ok(text.includes(`event.key === "${key}"`), `must handle ${key} in the tab bar`);
  }
  assert.ok(
    text.includes('localStorage.setItem(TAB_STORAGE_KEY'),
    'must remember the active tab in localStorage',
  );
});

test('client.js: dashboard owns index maintenance and configuration owns save', () => {
  const text = readClient();
  assert.ok(text.includes('dashboardCards'), 'must build a dashboard panel');
  assert.ok(text.includes('configurationCards'), 'must build a configuration panel');
  // Index maintenance (rebuild/clear) lives on the dashboard.
  const dashboardStart = text.indexOf('const dashboardCards');
  const configurationStart = text.indexOf('const actionsCard');
  assert.ok(
    dashboardStart >= 0 && configurationStart > dashboardStart,
    'dashboard and configuration builders must be ordered',
  );
  const dashboardBlock = text.slice(dashboardStart, configurationStart);
  assert.ok(dashboardBlock.includes('rebuild'), 'dashboard must expose index rebuild');
  assert.ok(dashboardBlock.includes('clear'), 'dashboard must expose index clear');
  // Save and connection tests live on the configuration tab.
  const configurationBlock = text.slice(configurationStart);
  for (const marker of ['save', 'connection.testEmbedding', 'connection.testRerank']) {
    assert.ok(configurationBlock.includes(marker), `configuration must expose ${marker}`);
  }
});

test('client.js: advanced JSON is a collapsible section inside configuration', () => {
  const text = readClient();
  assert.ok(text.includes('el("details",'), 'advanced JSON must be a details element');
  assert.ok(text.includes('advancedOpen'), 'advanced section must keep its open state');
  assert.ok(text.includes('setAdvancedOpen'), 'advanced section must toggle its open state');
});

test('client.js: page sizing is stable across tabs', () => {
  const text = readClient();
  // The page is a flex child of the host section; auto margins alone make its
  // width depend on the active tab's content. Explicit width + border-box
  // keeps both tab panels at one centered width.
  assert.ok(
    text.includes(
      '.dscr-page { width: 100%; max-width: 840px; box-sizing: border-box;',
    ),
    'page must fill its container with a stable border-box width',
  );
});

test('client.js: EN/ZH parity for every UI translation key', () => {
  const text = readClient();
  const requiredKeys = [
    'dashboardTab', 'configurationTab', 'tabsLabel', 'statusTitle',
    'indexOpsTitle', 'actionsTitle', 'indexFiles', 'indexSize',
    'indexOpsHelp', 'unsaved', 'refresh',
    'unitB', 'unitKB', 'unitMB', 'unitGB',
    'embeddingTitle', 'rerankTitle', 'retrievalTitle', 'indexingTitle',
    'advancedTitle', 'notSet', 'invalidJsonHint',
    'enabled', 'embeddingBaseUrl', 'embeddingModel', 'dimensions',
    'apiKey', 'clearKey', 'timeoutMs', 'maxRetries', 'batchSize',
    'maxEmbeddingChars', 'rerankEnabled', 'rerankBaseUrl', 'rerankModel',
    'rerankPath', 'injectionEnabled', 'scope', 'scopeWorkspace', 'scopeAll',
    'candidateLimit', 'topK', 'minScore', 'rerankMinScore', 'maxContextChars',
    'allowSameSession', 'dedupeTurns', 'dedupeStateRetentionDays',
    'dedupeStateMaxSessions', 'dedupeHelp',
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
