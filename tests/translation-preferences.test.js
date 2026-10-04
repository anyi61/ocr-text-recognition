'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create, normalize, DEFAULTS } = require('../translation-preferences.js');
const { createPreferenceSession } = require('../translation-ui.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function memoryStorage(initial = {}) {
  let data = structuredClone(initial);
  const writes = [];
  return {
    writes,
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]));
    },
    async set(patch) { writes.push(structuredClone(patch)); data = { ...data, ...patch }; },
    snapshot: () => structuredClone(data)
  };
}

function preferenceBridge(store) {
  return async (message) => message.action === 'getTranslationPreferences'
    ? store.get() : store.save(message.preferences);
}

test('translation defaults never inherit OCR provider or interface language', async () => {
  const storage = memoryStorage({ apiProvider: 'openai', uiLanguage: 'en', language: 'ja' });
  assert.deepEqual(await create(storage).get(), { success: true, preferences: DEFAULTS });
  assert.deepEqual(normalize({ translationProvider: 'unknown', translationTargetLanguage: 'unknown' }), DEFAULTS);
  assert.equal(storage.writes.length, 0);
});

test('saved translation preferences survive recreating the store and changing OCR/UI settings', async () => {
  const storage = memoryStorage({ apiProvider: 'baidu', uiLanguage: 'zh_CN' });
  await create(storage).save({ provider: 'openai', targetLanguage: 'ja' });
  await storage.set({ apiProvider: 'custom', uiLanguage: 'en' });
  assert.deepEqual((await create(storage).get()).preferences, { provider: 'openai', targetLanguage: 'ja' });
});

test('concurrent partial updates preserve both translation fields and unrelated preferences', async () => {
  const storage = memoryStorage({ apiProvider: 'baidu', uiLanguage: 'en', privateKey: 'unchanged' });
  const store = create(storage);
  await Promise.all([store.save({ provider: 'openai' }), store.save({ targetLanguage: 'fr' }),
    store.save({ provider: 'zhipu' })]);
  assert.deepEqual(storage.snapshot(), { apiProvider: 'baidu', uiLanguage: 'en', privateKey: 'unchanged',
    translationProvider: 'zhipu', translationTargetLanguage: 'fr' });
  assert.deepEqual(storage.writes, [{ translationProvider: 'openai' }, { translationTargetLanguage: 'fr' },
    { translationProvider: 'zhipu' }]);
});

test('queued preference mutations are copied and a read waits for pending writes', async () => {
  const gate = deferred();
  const storage = memoryStorage();
  const originalSet = storage.set;
  storage.set = async (patch) => { await gate.promise; return originalSet(patch); };
  const store = create(storage);
  const patch = { provider: 'openai' };
  const write = store.save(patch);
  patch.provider = 'custom';
  let readFinished = false;
  const read = store.get().then((value) => { readFinished = true; return value; });
  await Promise.resolve();
  assert.equal(readFinished, false);
  gate.resolve();
  await write;
  assert.equal((await read).preferences.provider, 'openai');
});

test('invalid preference patches cannot write arbitrary storage fields', async () => {
  const storage = memoryStorage();
  const store = create(storage);
  for (const patch of [null, [], {}, { apiProvider: 'openai' }, { provider: 'invalid' },
    { targetLanguage: 'invalid' }, { provider: 'openai', uiLanguage: 'en' }]) {
    await assert.rejects(store.save(patch), (error) => error.code === 'TRANSLATION_PREFERENCES_INVALID');
  }
  assert.deepEqual(storage.writes, []);
});

test('a failed write rejects honestly without poisoning later queued changes', async () => {
  const storage = memoryStorage();
  const originalSet = storage.set;
  let first = true;
  storage.set = async (patch) => {
    if (first) { first = false; throw new Error('Storage unavailable'); }
    return originalSet(patch);
  };
  const store = create(storage);
  const rejected = assert.rejects(store.save({ provider: 'openai' }), /Storage unavailable/);
  const following = store.save({ targetLanguage: 'de' });
  await rejected;
  assert.deepEqual((await following).preferences, { provider: 'claude', targetLanguage: 'de' });
});

test('message-only preference loading does not write defaults or restored selections', async () => {
  const storage = memoryStorage({ translationProvider: 'openai', translationTargetLanguage: 'es' });
  const patches = [];
  const session = createPreferenceSession({ sendMessage: preferenceBridge(create(storage)),
    onLoad: (patch) => patches.push(patch) });
  await session.load();
  session.keepCurrent(); // Historical translation selects its own service/language locally.
  await session.load();
  assert.deepEqual(patches, [{ provider: 'openai', targetLanguage: 'es' }, {}]);
  assert.deepEqual(storage.writes, []);
});

test('a late preference read preserves newly changed fields and loads untouched fields', async () => {
  const gate = deferred();
  const patches = [];
  const messages = [];
  const session = createPreferenceSession({
    sendMessage: (message) => {
      messages.push(message);
      return message.action === 'getTranslationPreferences' ? gate.promise : Promise.resolve({ success: true });
    },
    onLoad: (patch) => patches.push(patch)
  });
  const loading = session.load();
  await session.change({ provider: 'zhipu' });
  gate.resolve({ success: true, preferences: { provider: 'openai', targetLanguage: 'ja' } });
  await loading;
  assert.deepEqual(patches, [{ targetLanguage: 'ja' }]);
  assert.deepEqual(messages[1], { action: 'saveTranslationPreferences', preferences: { provider: 'zhipu' } });
});

test('starting translation protects visible selections from a delayed preference read', async () => {
  const gate = deferred();
  const patches = [];
  const session = createPreferenceSession({ sendMessage: () => gate.promise,
    onLoad: (patch) => patches.push(patch) });
  const loading = session.load();
  session.keepCurrent();
  gate.resolve({ success: true, preferences: { provider: 'openai', targetLanguage: 'ja' } });
  await loading;
  assert.deepEqual(patches, [{}]);
});

test('editing a historical language saves only that language, preserving global provider', async () => {
  const storage = memoryStorage({ translationProvider: 'openai', translationTargetLanguage: 'es' });
  const session = createPreferenceSession({ sendMessage: preferenceBridge(create(storage)) });
  await session.load();
  session.keepCurrent();
  await session.change({ targetLanguage: 'ja' });
  assert.deepEqual(storage.writes, [{ translationTargetLanguage: 'ja' }]);
  assert.equal(storage.snapshot().translationProvider, 'openai');
});

test('different panels share serialized backend updates without lost fields', async () => {
  const storage = memoryStorage();
  const bridge = preferenceBridge(create(storage));
  const first = createPreferenceSession({ sendMessage: bridge });
  const second = createPreferenceSession({ sendMessage: bridge });
  await Promise.all([first.change({ provider: 'openai' }), second.change({ targetLanguage: 'ko' }),
    first.change({ provider: 'zhipu' })]);
  assert.deepEqual(storage.snapshot(), { translationProvider: 'zhipu', translationTargetLanguage: 'ko' });
});

test('failed changes remain visibly unsaved even when another field saves, and can be retried', async () => {
  let failProvider = true;
  const messages = [];
  const statuses = [];
  const session = createPreferenceSession({ sendMessage: async (message) => {
    messages.push(message);
    return { success: !message.preferences.provider || !failProvider };
  }, onStatus: (status) => statuses.push(status) });
  assert.equal(await session.change({ provider: 'openai' }), false);
  assert.equal(statuses.at(-1).error, 'save');
  assert.equal(await session.change({ targetLanguage: 'de' }), true);
  assert.equal(statuses.at(-1).error, 'save');
  failProvider = false;
  await session.retry();
  assert.deepEqual(messages.at(-1).preferences, { provider: 'openai' });
  assert.deepEqual(statuses.at(-1), { error: '', pending: false });
});

test('out-of-order old write failures cannot override a newer successful choice', async () => {
  const old = deferred();
  const statuses = [];
  let calls = 0;
  const session = createPreferenceSession({ sendMessage: () => ++calls === 1 ? old.promise
    : Promise.resolve({ success: true }), onStatus: (status) => statuses.push(status) });
  const first = session.change({ provider: 'openai' });
  await session.change({ provider: 'zhipu' });
  old.resolve({ success: false });
  await first;
  assert.deepEqual(statuses.at(-1), { error: '', pending: false });
});

test('read failures are reported and retry never overwrites a selection made after failure', async () => {
  let calls = 0;
  const patches = [];
  const statuses = [];
  const session = createPreferenceSession({ sendMessage: async (message) => {
    if (message.action === 'saveTranslationPreferences') return { success: true };
    if (++calls === 1) throw new Error('No connection');
    return { success: true, preferences: { provider: 'openai', targetLanguage: 'ja' } };
  }, onLoad: (patch) => patches.push(patch), onStatus: (status) => statuses.push(status) });
  await session.load();
  assert.equal(statuses.at(-1).error, 'load');
  await session.change({ targetLanguage: 'fr' });
  await session.retry();
  assert.deepEqual(patches, [{ provider: 'openai' }]);
  assert.deepEqual(statuses.at(-1), { error: '', pending: false });
});

test('destroy suppresses late UI updates while an already dispatched write still persists', async () => {
  const gate = deferred();
  const storage = memoryStorage();
  const originalSet = storage.set;
  storage.set = async (patch) => { await gate.promise; await originalSet(patch); };
  let statusCount = 0;
  const session = createPreferenceSession({ sendMessage: preferenceBridge(create(storage)),
    onStatus: () => { statusCount += 1; } });
  const save = session.change({ provider: 'openai' });
  session.destroy();
  const before = statusCount;
  gate.resolve();
  await save;
  assert.equal(statusCount, before);
  assert.equal(storage.snapshot().translationProvider, 'openai');
  assert.equal(await session.change({ provider: 'zhipu' }), false);
});
