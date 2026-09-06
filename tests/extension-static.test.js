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
  assert.deepEqual(manifest.optional_host_permissions, [
    'https://*/*',
    'http://localhost/*',
    'http://127.0.0.1/*'
  ]);
  assert.deepEqual(
    manifest.web_accessible_resources,
    [{ resources: ['_locales/*'], matches: ['<all_urls>'] }],
    'runtime locale loading is the only web-accessible resource'
  );
});

test('extension pages load shared configuration before their entry scripts', () => {
  assert.deepEqual(
    scriptSources('popup.html'),
    ['i18n-runtime.js', 'provider-config.js', 'extension-runtime.js', 'popup/runtime.js', 'popup/history-view.js', 'popup/controller.js', 'popup.js']
  );
  assert.deepEqual(
    scriptSources('options.html'),
    ['i18n-runtime.js', 'provider-config.js', 'extension-runtime.js', 'options/runtime.js', 'options/provider-form.js', 'options/config-transfer.js', 'options/controller.js', 'options.js']
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
    'popup.js', 'options.js', 'content.js', 'i18n-runtime.js',
    'options/controller.js', 'options/provider-form.js', 'options/config-transfer.js',
    'popup/controller.js', 'popup/history-view.js',
    ...['selection', 'notice-view', 'result-view', 'capture-pipeline', 'session'].map(name => `content/${name}.js`)
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
    /importScripts\([\s\S]*'provider-config\.js',[\s\S]*'extension-runtime\.js',[\s\S]*'background-core\.js',[\s\S]*'request-runtime\.js',[\s\S]*'history-store\.js',[\s\S]*'providers\/transport\.js',[\s\S]*'providers\/registry\.js'[\s\S]*\)/
  );
  const imports = [...background.match(/importScripts\(([\s\S]*?)\);/)[1].matchAll(/'([^']+)'/g)]
    .map(match => match[1]);
  for (const id of ['claude', 'openai', 'openai-compatible', 'custom', 'baidu', 'aliyun', 'zhipu']) {
    assert.ok(imports.indexOf('providers/transport.js') < imports.indexOf(`providers/${id}.js`));
    assert.ok(imports.indexOf(`providers/${id}.js`) < imports.indexOf('providers/registry.js'));
  }
  for (const service of ['capture-service', 'recognition-service', 'message-handlers']) {
    assert.ok(imports.indexOf(`background/${service}.js`) > imports.indexOf('providers/registry.js'));
  }
  assert.match(
    extensionRuntime,
    /'i18n-runtime\.js',\s*'capture-utils\.js',\s*'content\/styles\.js',[\s\S]*'content\/session\.js',\s*'content\.js'/
  );
});

test('content capture waits for i18n and runtime updates the document language', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const i18nRuntime = fs.readFileSync(path.join(ROOT, 'i18n-runtime.js'), 'utf8');

  assert.match(content, /const i18nReady = OCRI18n\.init\(\)/);
  assert.match(
    content,
    /if \(request\.action === 'startCapture'\)[\s\S]*i18nReady\.then\(\(\) => \{[\s\S]*session\.start\(\)/
  );
  assert.match(i18nRuntime, /documentElement\.lang = resolvedLanguage === 'zh_CN'/);
});

test('content capture uses a closed shadow root and rejects synthetic page events', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  const session = fs.readFileSync(path.join(ROOT, 'content/session.js'), 'utf8');
  assert.match(session, /attachShadow\(\{\s*mode:\s*'closed'\s*\}\)/);
  assert.match(session, /event\?\.isTrusted/);
  assert.match(content, /window\.addEventListener\('pagehide',\s*fullCleanup\)/);
});

test('dynamic translations are assigned through DOM properties outside HTML templates', () => {
  for (const relativePath of ['content.js', 'content/selection.js', 'content/notice-view.js', 'content/result-view.js', 'popup.js', 'options.js', 'popup/history-view.js', 'options/config-transfer.js']) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.doesNotMatch(
      source,
      /innerHTML\s*=\s*`[^`]*OCRI18n\.t/s,
      `${relativePath} must not interpolate translated strings into innerHTML`
    );
  }
});

test('background restricts local storage to trusted extension contexts', () => {
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

  assert.match(background, /setAccessLevel\(\{\s*accessLevel:\s*'TRUSTED_CONTEXTS'/);
  const handlers = fs.readFileSync(path.join(ROOT, 'background/message-handlers.js'), 'utf8');
  assert.match(handlers, /getContentPreferences\(_request, _sender, sendResponse\)/);
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

test('package, manifest, and exported configuration versions stay aligned', () => {
  const packageJson = readJson('package.json');
  const manifest = readJson('manifest.json');
  const options = fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8');
  const optionsRuntime = fs.readFileSync(path.join(ROOT, 'options/runtime.js'), 'utf8');
  const checkScript = fs.readFileSync(path.join(ROOT, 'scripts/check-version-sync.mjs'), 'utf8');

  assert.equal(packageJson.version, manifest.version);
  assert.match(options, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(optionsRuntime, /version:\s*runtimeVersion/);
  assert.match(checkScript, /packageJson\.version !== manifest\.version/);
});

test('the default check includes browser E2E and release commands are documented', () => {
  const packageJson = readJson('package.json');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  assert.match(packageJson.scripts.check, /npm test/);
  assert.match(packageJson.scripts.check, /test:e2e/);
  assert.match(packageJson.scripts.check, /npm run lint/);
  assert.match(packageJson.scripts.check, /npm run typecheck/);
  assert.equal(packageJson.engines.node, '>=20');
  assert.equal(packageJson.scripts.package, 'node scripts/package-extension.mjs');
  assert.match(readme, /playwright install chromium/);
  assert.match(readme, /npm run package/);
});
