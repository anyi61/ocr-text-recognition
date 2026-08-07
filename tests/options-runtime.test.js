'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadOptionsRuntime() {
  const optionsPath = path.resolve(__dirname, '../options/runtime.js');
  delete require.cache[optionsPath];
  return require(optionsPath);
}

test('status presenter clears an older hide timer before showing a newer status', () => {
  const OptionsRuntime = loadOptionsRuntime();
  const timers = new Map();
  const cleared = [];
  let nextId = 0;
  const status = {
    textContent: '',
    className: '',
    classList: {
      add() {},
      remove() {}
    }
  };
  const showStatus = OptionsRuntime.createStatusPresenter(status, {
    setTimeout(callback) {
      const id = ++nextId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      timers.delete(id);
    }
  });

  showStatus('first success', 'success');
  showStatus('still working', 'loading');

  assert.deepEqual(cleared, [1]);
  assert.equal(status.textContent, 'still working');
  assert.equal(timers.size, 0);
});

test('exports appearance preferences and preserves them when importing old backups', () => {
  const OptionsRuntime = loadOptionsRuntime();
  const exported = OptionsRuntime.buildExportData({
    apiProvider: 'openai',
    prompt: 'extract',
    language: 'en',
    theme: 'dark',
    uiLanguage: 'en'
  }, { openai: { model: 'gpt-test' } }, '2.3.4', '2026-07-19T00:00:00.000Z');

  assert.equal(exported.version, '2.3.4');
  assert.equal(exported.config.theme, 'dark');
  assert.equal(exported.config.uiLanguage, 'en');
  assert.deepEqual(
    OptionsRuntime.applyImportedAppearance({}, { theme: 'dark', uiLanguage: 'en' }),
    { theme: 'dark', uiLanguage: 'en' },
    'old backups retain current local appearance preferences'
  );
  assert.deepEqual(
    OptionsRuntime.applyImportedAppearance({ theme: 'light', uiLanguage: 'auto' }, { theme: 'dark', uiLanguage: 'en' }),
    { theme: 'light', uiLanguage: 'auto' }
  );
});

test('only imports supported theme, UI language, and OCR language values', () => {
  const OptionsRuntime = loadOptionsRuntime();
  assert.equal(OptionsRuntime.validateImportPreferences({ theme: 'dark', uiLanguage: 'en', language: 'ja' }), null);
  assert.match(OptionsRuntime.validateImportPreferences({ theme: 'system' }), /theme/);
  assert.match(OptionsRuntime.validateImportPreferences({ uiLanguage: 'fr' }), /uiLanguage/);
  assert.match(OptionsRuntime.validateImportPreferences({ language: 'de' }), /language/);
});

test('modal lifecycle removes its Escape listener and resolves only once', () => {
  const OptionsRuntime = loadOptionsRuntime();
  let addedHandler;
  let removeCalls = 0;
  let removeOverlayCalls = 0;
  const results = [];
  const fakeDocument = {
    addEventListener(_name, handler) {
      addedHandler = handler;
    },
    removeEventListener(_name, handler) {
      assert.equal(handler, addedHandler);
      removeCalls += 1;
    }
  };
  const overlay = {
    classList: { remove() {} },
    remove() { removeOverlayCalls += 1; }
  };
  const lifecycle = OptionsRuntime.createModalLifecycle(
    fakeDocument,
    overlay,
    (result) => results.push(result),
    { setTimeout(callback) { callback(); } }
  );

  lifecycle.close(false);
  lifecycle.close(true);

  assert.equal(removeCalls, 1);
  assert.equal(removeOverlayCalls, 1);
  assert.deepEqual(results, [false]);
});

test('import confirmation assigns imported metadata through textContent', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.resolve(__dirname, '../options.js'), 'utf8');
  assert.match(source, /provider\.querySelector\('span'\)\.textContent/);
  assert.match(source, /exportDate\.querySelector\('span'\)\.textContent/);
  assert.doesNotMatch(source, /\$\{configInfo\.apiProvider/);
});
