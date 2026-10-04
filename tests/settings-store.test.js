'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../settings-store.js');
const providers = require('../provider-config.js');

function harness(initial = {}) {
  const state = structuredClone(initial);
  const writes = [];
  let fail = false;
  const storage = {
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key))
        .map((key) => [key, structuredClone(state[key])]));
    },
    async set(patch) {
      writes.push(structuredClone(patch));
      if (fail) { fail = false; throw new Error('Storage write failed'); }
      Object.assign(state, structuredClone(patch));
    }
  };
  return { state, writes, store: create(storage), failNextWrite() { fail = true; } };
}

test('settings merge concurrent field patches against the latest provider configuration', async () => {
  const h = harness({ apiConfigs: { openai: { apiKey: 'old', model: 'old-model' } }, theme: 'dark' });
  await Promise.all([
    h.store.save({ apiConfigs: { openai: { apiKey: 'new' } } }),
    h.store.save({ apiConfigs: { openai: { model: 'new-model' }, claude: { apiKey: 'claude-key' } } }),
    h.store.save({ prompt: 'New prompt' })
  ]);
  assert.deepEqual(h.state.apiConfigs, {
    openai: { apiKey: 'new', model: 'new-model' }, claude: { apiKey: 'claude-key' }
  });
  assert.equal(h.state.openaiApiKey, 'new');
  assert.equal(h.state.openaiModel, 'new-model');
  assert.equal(h.state.theme, 'dark');
  assert.deepEqual(h.writes[2], { prompt: 'New prompt' });
});

test('settings copy a validated patch before queuing it', async () => {
  const h = harness();
  const patch = { apiConfigs: { openai: { apiKey: 'accepted' } } };
  const saving = h.store.save(patch);
  patch.apiConfigs.openai.apiKey = 'mutated';
  await saving;
  assert.equal(h.state.apiConfigs.openai.apiKey, 'accepted');
});

test('legacy imports migrate credentials and explicit modern clearing takes precedence', async () => {
  const h = harness({ apiKey: 'old', model: 'old-model', openaiApiKey: 'keep-other' });
  await h.store.save({ apiKey: 'replacement', model: 'new-model' });
  assert.equal(h.state.apiConfigs.claude.apiKey, 'replacement');
  assert.equal(h.state.apiConfigs.claude.model, 'new-model');
  assert.equal(h.state.apiConfigs.openai.apiKey, 'keep-other');
  await h.store.save({ apiConfigs: { claude: { model: 'redacted-model' } } });
  assert.equal(h.state.apiKey, 'replacement');
  await h.store.save({ apiKey: 'must-not-return', apiConfigs: { claude: { apiKey: '' } } });
  assert.equal(h.state.apiConfigs.claude.apiKey, '');
  assert.equal(h.state.apiKey, '');
  assert.equal(providers.hasRequiredCredentials(h.state.apiConfigs, 'claude', h.state), false);
});

test('malformed imports are rejected before any setting is written', async () => {
  const h = harness({ prompt: 'keep', autoCopy: false });
  for (const invalid of [
    null, [], { apiConfigs: null }, { apiConfigs: [] },
    { apiConfigs: { openai: null } }, { apiConfigs: { openai: [] } },
    { apiConfigs: { openai: { apiKey: {} } } }, { apiConfigs: { openai: { model: [] } } },
    { apiConfigs: { typo: {} } }, { apiConfigs: { openai: { unexpected: 'value' } } },
    { apiConfigs: { custom: { authMode: 'invalid' } } },
    { apiConfigs: { custom: { requestMode: 'invalid' } } },
    { apiConfigs: { custom: { endpoint: 'file:///tmp/data' } } },
    { apiKey: true }, { autoCopy: 'true' }, { translationProvider: 'unknown' }
  ]) {
    await assert.rejects(h.store.save(invalid), { code: 'SETTINGS_INVALID' });
  }
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.state, { prompt: 'keep', autoCopy: false });
});

test('a complete import is one atomic storage write and a failed write leaves all fields intact', async () => {
  const initial = { apiConfigs: { openai: { apiKey: 'old' } }, autoCopy: false, translationProvider: 'claude' };
  const h = harness(initial);
  h.failNextWrite();
  await assert.rejects(h.store.save({
    apiConfigs: { openai: { apiKey: 'new' } }, autoCopy: true, translationProvider: 'openai'
  }));
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.state, initial);
  await h.store.save({ autoCopy: true });
  assert.equal(h.state.autoCopy, true);
});

test('translation choices and configuration imports share invocation order without clobbering independent keys', async () => {
  const h = harness({ apiProvider: 'openai', uiLanguage: 'en', translationTargetLanguage: 'ja' });
  const first = h.store.saveTranslationPreferences({ provider: 'openai' });
  const importing = h.store.save({ translationProvider: 'custom', autoCopy: true });
  const last = h.store.saveTranslationPreferences({ targetLanguage: 'fr' });
  await Promise.all([first, importing, last]);
  assert.deepEqual(await h.store.getTranslationPreferences(), {
    success: true, preferences: { provider: 'custom', targetLanguage: 'fr' }
  });
  assert.equal(h.state.apiProvider, 'openai');
  assert.equal(h.state.uiLanguage, 'en');
  assert.equal(h.state.autoCopy, true);
});

test('invalid translation patches fail without creating undefined preference values', async () => {
  const h = harness();
  for (const patch of [null, [], {}, { unexpected: 'en' }, { provider: undefined }, { targetLanguage: 'unknown' }]) {
    await assert.rejects(h.store.saveTranslationPreferences(patch));
  }
  assert.deepEqual(h.writes, []);
});
