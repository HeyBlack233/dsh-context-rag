// manifest.test.js — validates repository/manifest consistency without network.
//
// Checks package.json metadata and exports, dsh bundle/client wiring, the
// presence of every file referenced by the manifest, absence of any icon
// files, the cordis patch text, locale resources, client.js / index.js slot
// and export markers, the docs index links, and the CHANGELOG top entry.
//
// Plain ESM using node:test + node:assert/strict; requires Node >= 22.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The package root is one level above this test file, regardless of cwd.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function isFile(relativePath) {
  const full = path.join(root, relativePath);
  return existsSync(full) && statSync(full).isFile();
}

test('package.json: identity and licensing metadata', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.name, '@local/dsh-context-rag');
  assert.equal(pkg.version, '0.0.0');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.engines.node, '>=22');
});

test('package.json: exports map is exact (no ./icon export)', () => {
  const pkg = readJson('package.json');
  assert.deepEqual(Object.keys(pkg.exports), [
    '.',
    './client',
    './locale/*.json',
    './package.json',
  ]);
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./client'], './client.js');
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.equal(pkg.exports['./icon'], undefined);
  assert.equal(pkg.exports['./icon.svg'], undefined);
});

test('package.json: dsh bundle and client wiring', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.dsh.client.immediately, true);
  assert.ok(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'),
    'inject must include @deepseek-ai/dsh-client-locale',
  );
  assert.ok(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'),
    'inject must include @deepseek-ai/dsh-client-ui-plugin-manager',
  );
});

test('package.json: files array covers all shipped artifacts', () => {
  const pkg = readJson('package.json');
  for (const entry of [
    'index.js',
    'client.js',
    'lib/**/*.js',
    'locale/*.json',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
  ]) {
    assert.ok(pkg.files.includes(entry), `files must include ${entry}`);
  }
});

test('manifest-referenced files all exist', () => {
  for (const relativePath of [
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'locale/en.json',
    'locale/zh.json',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'docs/README.md',
  ]) {
    assert.ok(isFile(relativePath), `${relativePath} must exist as a file`);
  }
});

test('no icon.svg or any ./icon file exists', () => {
  // No icon.svg at the package root (or anywhere under it).
  const iconSvg = path.join(root, 'icon.svg');
  assert.equal(existsSync(iconSvg), false, 'icon.svg must not exist');
  // No exports entry for ./icon or ./icon.svg.
  const pkg = readJson('package.json');
  assert.equal(pkg.exports['./icon'], undefined);
  assert.equal(pkg.exports['./icon.svg'], undefined);
  // No other top-level icon.* file.
  for (const entry of ['icon.png', 'icon.jpg', 'icon.jpeg', 'icon.gif']) {
    assert.equal(
      existsSync(path.join(root, entry)),
      false,
      `${entry} must not exist`,
    );
  }
});

test('cordis.patch.yml declares the bundle id and name', () => {
  const text = read('cordis.patch.yml');
  assert.match(text, /id:\s*dsh-context-rag/);
  assert.match(text, /name:\s*'@local\/dsh-context-rag'/);
});

test('locale resources parse and expose nonempty meta', () => {
  for (const file of ['locale/en.json', 'locale/zh.json']) {
    const data = readJson(file);
    assert.equal(typeof data.meta.title, 'string');
    assert.equal(typeof data.meta.description, 'string');
    assert.ok(data.meta.title.trim().length > 0, `${file} meta.title is empty`);
    assert.ok(
      data.meta.description.trim().length > 0,
      `${file} meta.description is empty`,
    );
  }
});

test('client.js registers the bundle config slot and key', () => {
  const text = read('client.js');
  assert.ok(text.includes('plugins.bundle.config'), 'slot name plugins.bundle.config');
  assert.ok(
    text.includes('key: "@local/dsh-context-rag"'),
    'slot key @local/dsh-context-rag',
  );
  assert.ok(
    !text.includes('plugins.row.config'),
    'no plugins.row.config slot (the row detail page is removed)',
  );
});

test('index.js exports name and apply', () => {
  const text = read('index.js');
  assert.ok(text.includes('export function apply'), 'must export function apply');
  assert.ok(text.includes('export const name'), 'must export const name');
});

test('docs/README.md links every document and each target exists', () => {
  const readme = read('docs/README.md');
  const docs = [
    'architecture.md',
    'configuration.md',
    'storage-and-data-model.md',
    'retrieval-and-injection.md',
    'configuration-page.md',
    'testing.md',
    'security-and-privacy.md',
    'operations.md',
  ];
  for (const doc of docs) {
    assert.ok(
      readme.includes(`](${doc})`),
      `docs/README.md must link ${doc}`,
    );
    assert.ok(isFile(`docs/${doc}`), `docs/${doc} must exist`);
  }
});

test('CHANGELOG.md top entry and Highlights, no Contributors section', () => {
  const text = read('CHANGELOG.md');
  // The first version (H2) heading must be the [0.0.0] - Unreleased top entry.
  const headings = text
    .split('\n')
    .filter((line) => /^##\s+/.test(line));
  assert.ok(headings.length > 0, 'CHANGELOG must contain version headings');
  assert.equal(
    headings[0],
    '## [0.0.0] - Unreleased',
    'top entry must be [0.0.0] - Unreleased',
  );
  assert.ok(text.includes('Release Date: TBD'));
  assert.ok(text.includes('### Highlights'));
  assert.doesNotMatch(
    text,
    /^#{1,3}\s*Contributors\s*$/m,
    'must not contain a Contributors section',
  );
});
