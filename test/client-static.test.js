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
    'retrieval.minMessageLength',
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

test('client.js: four tabs in order dashboard, browse, configuration, logs', () => {
  const text = readClient();
  assert.ok(
    text.includes('TAB_IDS = ["dashboard", "browse", "configuration", "logs"]'),
    'TAB_IDS must list dashboard, browse, configuration and logs',
  );
  const tabsIndex = text.indexOf('const tabs = ');
  assert.ok(tabsIndex >= 0, 'must define the tabs array');
  const tabsBlock = text.slice(tabsIndex);
  assert.ok(
    tabsBlock.includes('{ id: "browse", labelKey: "browseTab", content: browseCards }'),
    'must add a browse tab entry labelled browseTab without a dirty marker',
  );
  assert.ok(
    tabsBlock.includes('{ id: "logs", labelKey: "logsTab", content: logsCards }'),
    'must add a logs tab entry labelled logsTab without a dirty marker',
  );
  assert.ok(
    tabsBlock.indexOf('{ id: "browse"') < tabsBlock.indexOf('{ id: "configuration"'),
    'browse must come before configuration in the tab order',
  );
  assert.ok(
    tabsBlock.indexOf('{ id: "configuration"') < tabsBlock.indexOf('{ id: "logs"'),
    'logs must come after configuration in the tab order',
  );
});

test('client.js: logs actions call logs.get, logs.configure and logs.export', () => {
  const text = readClient();
  for (const action of ['logs.get', 'logs.configure', 'logs.export']) {
    assert.ok(text.includes(action), `must call the ${action} action`);
  }
  assert.ok(text.includes('logExport'), 'must render the Write to disk (logExport) button');
  assert.ok(text.includes('logExportOk'), 'must confirm exports with the logExportOk message');
});

test('client.js: logs poll every 2000 ms only while the logs tab is active', () => {
  const text = readClient();
  assert.ok(text.includes('window.setInterval(poll, 2000)'), 'must poll every 2000 ms');
  assert.ok(text.includes('window.clearInterval(timer)'), 'must clear the poll interval when leaving');
  assert.ok(text.includes('activeTab !== "logs"'), 'must only poll while the logs tab is active');
  assert.ok(text.includes('logPollError'), 'must show a local poll error message');
  assert.ok(text.includes('logEpochRef'), 'must discard poll responses that raced a configure');
});

test('client.js: log limit input validates an integer between 1 and 5000', () => {
  const text = readClient();
  assert.ok(text.includes('min: 1, max: 5000, step: 1'), 'N input must be a 1..5000 integer field');
  assert.ok(text.includes('n < 1 || n > 5000'), 'must reject N outside 1..5000');
  assert.ok(text.includes('logLimitInvalid'), 'must report invalid N with logLimitInvalid');
});

test('client.js: patchConfigSnapshot syncs logging into both config snapshots', () => {
  const text = readClient();
  const start = text.indexOf('const patchConfigSnapshot');
  assert.ok(start >= 0, 'must define the patchConfigSnapshot helper');
  const marker = 'setSavedText((prev) => applyTo(prev));';
  const end = text.indexOf(marker, start);
  assert.ok(end > start, 'patchConfigSnapshot must patch the savedText snapshot');
  const block = text.slice(start, end + marker.length);
  assert.ok(block.includes('setConfigText((prev)'), 'must patch the configText snapshot');
  assert.ok(block.includes('obj.logging = '), 'must write the logging section of the snapshot');
  assert.ok(!block.includes('reload'), 'must not reload (would discard Configuration edits)');
  assert.ok(
    text.includes('patchConfigSnapshot({ bufferSize: value.limit })'),
    'must patch bufferSize after applying N',
  );
  assert.ok(
    text.includes('patchConfigSnapshot({ debug: value.debug })'),
    'must patch debug after toggling it',
  );
});

test('client.js: log list is a non-live log region', () => {
  const text = readClient();
  assert.ok(text.includes('role: "log"'), 'log list must have role="log"');
  assert.ok(text.includes('"aria-live": "off"'), 'log list must not announce every poll');
  assert.ok(text.includes('tabIndex: 0'), 'log list must be keyboard focusable for scrolling');
  assert.ok(text.includes('logsLabel'), 'log list must carry the logsLabel aria-label');
});

test('client.js: page fills the plugin detail column', () => {
  const text = readClient();
  const rule = text.match(/\.dscr-page \{([^}]*)\}/)?.[1];
  assert.ok(rule, 'must define the dscr-page base rule');
  // The page is a flex child of the host detail section, whose siblings
  // (Components, Versions, Source) use the section's full column width. A
  // max-width cap, outer margin, or page padding would make the panel and its
  // cards narrower than those sections.
  assert.match(rule, /width: 100%/, 'page must fill its container');
  assert.match(rule, /box-sizing: border-box/, 'page must include no implicit outer box');
  assert.ok(!rule.includes('max-width'), 'page must not cap its width below the section');
  assert.ok(!rule.includes('padding'), 'page must not inset itself from the section edges');
  assert.ok(!rule.includes('margin'), 'page must not add outer spacing');
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
    'allowSameSession', 'minMessageLength', 'dedupeTurns', 'dedupeStateRetentionDays',
    'dedupeStateMaxSessions', 'dedupeHelp',
    'indexingEnabled', 'pollIntervalMs', 'retryDelayMs', 'maxAttempts',
    'configHelp', 'reload', 'save', 'testEmbedding', 'testRerank',
    'rebuild', 'clear', 'confirmClear', 'saved', 'cleared', 'rebuilt',
    'testOk', 'jsonInvalid', 'busy', 'ok', 'error',
    'logsTab', 'logsTitle', 'logsHelp', 'logLimit', 'logApply', 'logDebug',
    'logRefresh', 'logExport', 'logExportOk', 'logConfigured', 'logLimitInvalid',
    'logLimitPending', 'logEmpty', 'logCount', 'logPollError', 'logsLabel',
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

// ---------------------------------------------------------------------------
// Browse tab (static contracts)
// ---------------------------------------------------------------------------

test('client.js: browse actions call browse.scopes/list/search/get/check/reindex/forget', () => {
  const text = readClient();
  for (const action of [
    'browse.scopes',
    'browse.list',
    'browse.search',
    'browse.get',
    'browse.check',
    'browse.reindex',
    'browse.forget',
  ]) {
    assert.ok(text.includes(action), `must call the ${action} action`);
  }
  assert.ok(text.includes('BROWSE_PAGE_SIZE'), 'must define the browse page size');
  assert.ok(text.includes('limit: BROWSE_PAGE_SIZE'), 'must send BROWSE_PAGE_SIZE as the list limit');
  assert.ok(text.includes('BROWSE_SEARCH_LIMIT'), 'must define the browse search limit');
  assert.ok(text.includes('limit: BROWSE_SEARCH_LIMIT'), 'must send BROWSE_SEARCH_LIMIT as the search limit');
});

test('client.js: EN/ZH parity for every Browse tab translation key', () => {
  const text = readClient();
  const browseKeys = [
    'browseTab', 'browseHelp', 'browseMemories', 'browsePairs', 'browseModeLabel',
    'browseScopeGlobal', 'browseListLabel', 'browseDetailLabel', 'browseSelectHint',
    'browseLoadMore', 'browseLoading', 'browseEmptyMemories', 'browseEmptyPairs',
    'browseEmptyMismatch', 'checkIndex', 'checkingIndex', 'onlyMismatched',
    'checkSummary', 'checkTruncated', 'checkNoMismatch', 'memoryCount', 'browseCounts',
    'statusConsistent', 'statusMissing', 'statusStale', 'statusPending', 'statusModel',
    'statusCorrupt', 'statusOrphan', 'statusUnknown',
    'reindex', 'reindexDone', 'reindexQueued', 'reindexFailed', 'forget',
    'confirmForget', 'forgotten', 'memoryContent', 'userMessage', 'assistantMessage',
    'contentTruncated', 'browseLoadError', 'browseNotFound', 'browseCheckError',
    'browseMetaName', 'browseMetaDescription', 'browseMetaType', 'browseMetaCwd',
    'browseMetaCreatedAt', 'browseMetaStatus', 'browseMetaModel', 'browseMetaDim',
    'browseMetaIndexedAt', 'browseMetaPairId', 'browseMetaSessionId', 'browseMetaTurn',
    'browseMetaOutbox', 'browseMetaReason', 'browseMetaAttempts', 'browseMetaLastError',
    'globalLabel', 'workspaceLabel', 'browseWorkspaceUnavailable', 'browseEmbeddingDisabled',
    'browseSearchPlaceholder', 'browseSearch', 'browseSearching', 'browseClearSearch',
    'browseSearchResults', 'browseSearchEmpty', 'browseSearchFailed', 'browseSearchReranked',
    'browseSearchCosine', 'browseSearchScore', 'browseSearchStatusLine', 'browseSearchRerankFallback',
  ];
  for (const key of browseKeys) {
    const pattern = new RegExp(`${key}\\s*:`, 'g');
    const count = (text.match(pattern) || []).length;
    assert.ok(
      count >= 2,
      `key "${key}" must appear at least twice (EN + ZH), found ${count}`,
    );
  }
});

test('client.js: browse split-view and status-pill classes and row/mode aria attributes are referenced', () => {
  const text = readClient();
  for (const cls of [
    'dscr-browse-split',
    'dscr-browse-list',
    'dscr-browse-detail',
    'dscr-browse-pill',
    'dscr-browse-pill-consistent',
    'dscr-browse-pill-missing',
    'dscr-browse-pill-stale-text',
    'dscr-browse-pill-model-mismatch',
    'dscr-browse-pill-corrupt',
    'dscr-browse-pill-pending',
    'dscr-browse-pill-orphan',
    'dscr-browse-pill-unknown',
    'dscr-browse-row',
    'dscr-browse-mode',
  ]) {
    assert.ok(text.includes(cls), `must reference the ${cls} class`);
  }
  for (const aria of [
    '"aria-pressed"',
    '"aria-current"',
    'role: "group"',
    'role: "list"',
    'role: "region"',
    'role: "status"',
    '"aria-label": t("browseModeLabel")',
    '"aria-label": t("browseListLabel")',
    '"aria-label": t("browseDetailLabel")',
  ]) {
    assert.ok(text.includes(aria), `must use ${aria}`);
  }
});

test('client.js: Browse render uses translation keys only, no hard-coded visible strings', () => {
  const text = readClient();
  const browseStart = text.indexOf('// Browse tab render');
  const tabsStart = text.indexOf('const tabs = [');
  assert.ok(browseStart >= 0 && tabsStart > browseStart, 'must isolate the Browse render section');
  const block = text.slice(browseStart, tabsStart);

  // Remove every direct t("...") call, then every remaining string literal
  // must be a non-display token (class name, tag name, aria token, key,
  // separator) rather than user-visible text.
  const stripped = block.replace(/t\("[^"]*"\)/g, 't("")');
  const allowedTokens = new Set([
    // HTML tag names / input types
    'div', 'span', 'button', 'form', 'h2', 'h3', 'p', 'pre', 'select', 'option',
    'label', 'input', 'strong', 'checkbox',
    // aria / role tokens
    'aria-current', 'aria-label', 'aria-labelledby', 'aria-live', 'aria-pressed',
    'group', 'list', 'polite', 'region', 'search', 'status', 'submit', 'tabpanel',
    // browse kind / scope / state keys
    'memories', 'pairs', 'memory', 'all', 'global', 'workspace', 'workspace:',
    'consistent', 'pending', 'orphan', 'error', 'true', '__browse-more',
    // translation keys passed to t() indirectly (ternary/helper arguments)
    'browseEmptyMemories', 'browseEmptyPairs', 'checkIndex', 'checkingIndex',
    'confirmForget', 'forget',
    // separators and punctuation
    ' ', ' (', ' · ', ' — ', ')', ', ', ':', ': ',
  ]);
  for (const match of stripped.matchAll(/"([^"\\]*)"/g)) {
    const literal = match[1];
    assert.ok(
      literal === ''
        || /^ ?dscr-/.test(literal)
        || /^(aria-|dsw-)/.test(literal)
        || allowedTokens.has(literal),
      `hard-coded string ${JSON.stringify(literal)} found in the Browse render code`,
    );
  }
});
