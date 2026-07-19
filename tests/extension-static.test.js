'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function scriptSources(relativePath) {
  const html = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  return [...html.matchAll(/<script\s+[^>]*src=["']([^"']+)["'][^>]*>/g)]
    .map((match) => match[1]);
}

function walkJavaScript(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkJavaScript(entryPath);
    return entry.isFile() && /\.(?:c?js|mjs)$/.test(entry.name) ? [entryPath] : [];
  });
}

test('manifest keeps the minimum expected extension surface', () => {
  const manifest = readJson('manifest.json');

  assert.equal(manifest.manifest_version, 3);
  assert.ok(!manifest.content_scripts, 'capture UI must be injected only after user action');
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ['activeTab', 'clipboardWrite', 'notifications', 'scripting', 'storage'].sort()
  );
  assert.ok(!manifest.permissions.includes('tabs'), 'tabs permission is unnecessary');
  assert.deepEqual(manifest.host_permissions, [
    'https://api.anthropic.com/*',
    'https://api.openai.com/*',
    'https://aip.baidubce.com/*',
    'https://dashscope.aliyuncs.com/*',
    'https://open.bigmodel.cn/*'
  ]);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(
    manifest.web_accessible_resources,
    [{ resources: ['_locales/*'], matches: ['<all_urls>'] }],
    'runtime locale loading is the only web-accessible resource'
  );
});

test('extension pages load shared configuration before their entry scripts', () => {
  assert.deepEqual(
    scriptSources('popup.html'),
    ['i18n-runtime.js', 'provider-config.js', 'extension-runtime.js', 'popup.js']
  );
  assert.deepEqual(
    scriptSources('options.html'),
    ['i18n-runtime.js', 'provider-config.js', 'extension-runtime.js', 'options.js']
  );
});

test('locale catalogs contain exactly the same keys', () => {
  const english = readJson('_locales/en/messages.json');
  const chinese = readJson('_locales/zh_CN/messages.json');

  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
  for (const [locale, catalog] of [['en', english], ['zh_CN', chinese]]) {
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value.message, 'string', `${locale}.${key}.message must be a string`);
      assert.ok(value.message.length > 0, `${locale}.${key}.message must not be empty`);
    }
  }
});

test('every referenced translation key exists in both locale catalogs', () => {
  const catalogs = [
    readJson('_locales/en/messages.json'),
    readJson('_locales/zh_CN/messages.json')
  ];
  const referenced = new Set();
  for (const relativePath of [
    'manifest.json', 'popup.html', 'options.html',
    'popup.js', 'options.js', 'content.js', 'i18n-runtime.js'
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    for (const match of source.matchAll(/OCRI18n\.t\(\s*['"]([^'"]+)['"]/g)) {
      referenced.add(match[1]);
    }
    for (const match of source.matchAll(/data-i18n(?:-placeholder|-title|-aria)?=['"]([^'"]+)['"]/g)) {
      referenced.add(match[1]);
    }
    for (const match of source.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
      referenced.add(match[1]);
    }
  }

  for (const key of referenced) {
    assert.ok(catalogs.every((catalog) => catalog[key]), `missing locale key: ${key}`);
  }
});

test('background and popup preserve dependency injection order', () => {
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const extensionRuntime = fs.readFileSync(path.join(ROOT, 'extension-runtime.js'), 'utf8');

  assert.match(
    background,
    /importScripts\([\s\S]*'provider-config\.js',[\s\S]*'extension-runtime\.js',[\s\S]*'background-core\.js',[\s\S]*'request-runtime\.js',[\s\S]*'history-store\.js'[\s\S]*\)/
  );
  assert.match(
    extensionRuntime,
    /'i18n-runtime\.js',\s*'capture-utils\.js',\s*'content\.js'/
  );
});

test('content capture waits for i18n and runtime updates the document language', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const i18nRuntime = fs.readFileSync(path.join(ROOT, 'i18n-runtime.js'), 'utf8');

  assert.match(content, /const i18nReady = OCRI18n\.init\(\)/);
  assert.match(
    content,
    /if \(request\.action === 'startCapture'\)[\s\S]*i18nReady\.then\(\(\) => \{[\s\S]*startCapture\(\)/
  );
  assert.match(i18nRuntime, /documentElement\.lang = resolvedLanguage === 'zh_CN'/);
});

test('every project JavaScript file parses', () => {
  const files = walkJavaScript(ROOT);
  assert.ok(files.length > 0);

  for (const file of files) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
      `${path.relative(ROOT, file)} must pass node --check`
    );
  }
});
