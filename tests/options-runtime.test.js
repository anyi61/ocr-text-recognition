'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadOptionsRuntime() {
  const optionsPath = path.resolve(__dirname, '../options.js');
  delete require.cache[optionsPath];
  const previousDocument = global.document;
  global.document = { addEventListener() {} };
  const runtime = require(optionsPath);
  global.document = previousDocument;
  return runtime;
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
  }, { openai: { model: 'gpt-test' } }, '2026-07-19T00:00:00.000Z');

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

test('exports independent copy and translation preferences without deriving them from OCR or UI language', () => {
  const runtime = loadOptionsRuntime();
  const defaults = runtime.buildExportData({ apiProvider: 'openai', uiLanguage: 'en' }, {}).config;
  assert.equal(defaults.autoCopy, false);
  assert.equal(defaults.translationProvider, 'claude');
  assert.equal(defaults.translationTargetLanguage, 'zh_CN');
  const saved = runtime.buildExportData({ autoCopy: true, translationProvider: 'custom', translationTargetLanguage: 'ja' }, {}).config;
  assert.equal(saved.autoCopy, true);
  assert.equal(saved.translationProvider, 'custom');
  assert.equal(saved.translationTargetLanguage, 'ja');
  assert.equal(runtime.buildExportData({ autoCopy: 'true' }, {}).config.autoCopy, false);
});

test('imports only explicit behavior preferences and validates all values before writing', () => {
  const runtime = loadOptionsRuntime();
  assert.deepEqual(runtime.applyImportedBehavior({ apiProvider: 'openai', uiLanguage: 'en' }), {});
  assert.deepEqual(runtime.applyImportedBehavior({ autoCopy: false, translationTargetLanguage: 'fr' }), {
    autoCopy: false, translationTargetLanguage: 'fr'
  });
  assert.equal(runtime.validateImportPreferences({ autoCopy: true, translationProvider: 'custom', translationTargetLanguage: 'zh_TW' }), null);
  for (const [key, value] of [['autoCopy', 'true'], ['translationProvider', 'unknown'], ['translationTargetLanguage', 'unknown']]) {
    assert.equal(runtime.validateImportPreferences({ [key]: value }), key);
    assert.equal(runtime.validateImportPreferences({ [key]: null }), key);
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function behaviorStorage(initial = {}) {
  let data = { ...initial };
  return {
    async get() { return { ...data }; },
    async set(patch) { data = { ...data, ...patch }; },
    snapshot: () => ({ ...data })
  };
}

test('automatic copy rolls back repeated failed toggles to stored state rather than the previous checkbox value', async () => {
  const runtime = loadOptionsRuntime();
  for (const initial of [false, true]) {
    let visible;
    let failures = 0;
    const storage = behaviorStorage({ autoCopy: initial });
    storage.set = async () => { throw new Error('Storage unavailable'); };
    const controller = runtime.createAutoCopyPreferences({ storage,
      onChange: (value) => { visible = value; }, onError: () => { failures += 1; } });
    await controller.load();
    const first = controller.save(!initial);
    const second = controller.save(initial);
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(visible, initial);
    assert.equal(storage.snapshot().autoCopy, initial);
    assert.equal(failures, 1, 'only the most recent action reports its failure');
  }
});

test('automatic copy falls back to the last acknowledged value when save and recovery read both fail', async () => {
  const runtime = loadOptionsRuntime();
  const storage = behaviorStorage({ autoCopy: true });
  let visible;
  const controller = runtime.createAutoCopyPreferences({ storage, onChange: (value) => { visible = value; } });
  await controller.load();
  storage.set = async () => { throw new Error('Write failed'); };
  storage.get = async () => { throw new Error('Read failed'); };
  assert.equal(await controller.save(false), false);
  assert.equal(visible, true);
});

test('late automatic-copy initial reads cannot replace a newer user toggle', async () => {
  const runtime = loadOptionsRuntime();
  const gate = deferred();
  const storage = behaviorStorage({ autoCopy: false });
  storage.get = () => gate.promise;
  let visible;
  const controller = runtime.createAutoCopyPreferences({ storage, onChange: (value) => { visible = value; } });
  const loading = controller.load();
  await Promise.resolve();
  await controller.save(true);
  gate.resolve({ autoCopy: false });
  await loading;
  assert.equal(visible, true);
  assert.equal(storage.snapshot().autoCopy, true);
});

test('automatic-copy refresh waits for queued user writes and preserves the latest acknowledged setting', async () => {
  const runtime = loadOptionsRuntime();
  const gate = deferred();
  const storage = behaviorStorage({ autoCopy: false });
  const originalSet = storage.set;
  storage.set = async (patch) => { await gate.promise; await originalSet(patch); };
  let visible;
  const controller = runtime.createAutoCopyPreferences({ storage, onChange: (value) => { visible = value; } });
  const first = controller.save(true);
  const second = controller.save(false);
  const refresh = controller.load();
  gate.resolve();
  await Promise.all([first, second, refresh, controller.settled()]);
  assert.equal(visible, false);
  assert.equal(storage.snapshot().autoCopy, false);
});

test('behavior imports omit old backup fields and send only explicitly imported translation fields', async () => {
  const runtime = loadOptionsRuntime();
  const calls = [];
  const bridge = {
    async saveAutoCopy(value) { calls.push(['copy', value]); return true; },
    async sendMessage(message) { calls.push(message); return { success: true }; }
  };
  await runtime.persistImportedBehavior({ apiProvider: 'openai', uiLanguage: 'en' }, bridge);
  assert.deepEqual(calls, []);
  await runtime.persistImportedBehavior({ translationTargetLanguage: 'fr' }, bridge);
  assert.deepEqual(calls, [{ action: 'saveTranslationPreferences', preferences: { targetLanguage: 'fr' } }]);
});

test('an imported translation preference runs after older queued UI writes through the same background store', async () => {
  const runtime = loadOptionsRuntime();
  const { create } = require('../translation-preferences.js');
  const gate = deferred();
  const storage = behaviorStorage({ translationProvider: 'claude' });
  const originalGet = storage.get;
  let reads = 0;
  storage.get = async () => { if (++reads === 1) await gate.promise; return originalGet(); };
  const store = create(storage);
  const first = store.save({ targetLanguage: 'ja' });
  const second = store.save({ provider: 'openai' });
  const importing = runtime.persistImportedBehavior({ translationProvider: 'custom' }, {
    saveAutoCopy: async () => { assert.fail('Missing auto-copy field must not be written'); },
    sendMessage: (message) => store.save(message.preferences)
  });
  gate.resolve();
  await Promise.all([first, second, importing]);
  assert.deepEqual(storage.snapshot(), { translationProvider: 'custom', translationTargetLanguage: 'ja' });
});

test('an imported automatic-copy choice shares the toggle queue and survives a subsequent refresh', async () => {
  const runtime = loadOptionsRuntime();
  const gate = deferred();
  const storage = behaviorStorage({ autoCopy: false });
  const originalSet = storage.set;
  let writes = 0;
  storage.set = async (patch) => { if (++writes === 1) await gate.promise; await originalSet(patch); };
  let visible;
  const controller = runtime.createAutoCopyPreferences({ storage, onChange: (value) => { visible = value; } });
  const toggle = controller.save(true);
  const importing = runtime.persistImportedBehavior({ autoCopy: false }, {
    saveAutoCopy: (value, options) => controller.save(value, options),
    sendMessage: async () => { assert.fail('Missing translation fields must not be written'); }
  });
  gate.resolve();
  await Promise.all([toggle, importing]);
  await controller.load();
  assert.equal(visible, false);
  assert.equal(storage.snapshot().autoCopy, false);
});

test('behavior imports reject copy or translation persistence failures instead of claiming success', async () => {
  const runtime = loadOptionsRuntime();
  await assert.rejects(runtime.persistImportedBehavior({ autoCopy: true }, {
    saveAutoCopy: async () => false, sendMessage: async () => ({ success: true })
  }), { code: 'AUTO_COPY_SAVE_FAILED' });
  await assert.rejects(runtime.persistImportedBehavior({ translationProvider: 'openai' }, {
    saveAutoCopy: async () => true, sendMessage: async () => ({ success: false })
  }), { code: 'TRANSLATION_PREFERENCES_WRITE_FAILED' });
});
