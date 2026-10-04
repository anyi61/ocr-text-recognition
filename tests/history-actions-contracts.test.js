'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const POPUP = { url: 'chrome-extension://fixture/popup.html', documentId: 'popup-document-a' };
const backup = { version: 3, records: [{ id: 'imported', text: 'Imported body', timestamp: 1 }] };

function harness(initial = [], options = {}) {
  let listener;
  const state = { ocrHistory: structuredClone(initial), apiConfigs: { openai: { apiKey: 'private-key' } } };
  let writes = 0;
  const noopHook = { addListener() {} };
  const chrome = {
    runtime: { getURL: (file) => `chrome-extension://fixture/${file}`, onInstalled: noopHook,
      onConnect: noopHook, onMessage: { addListener(value) { listener = value; } } },
    commands: { onCommand: noopHook },
    storage: { local: {
      async get(keys) { return structuredClone(Object.fromEntries(keys.map((key) => [key, state[key]]))); },
      async set(value) {
        if (options.failWrites) throw new Error('private storage trace private-key');
        writes += 1;
        Object.assign(state, structuredClone(value));
      }
    } }
  };
  let context;
  const sandbox = { chrome, URL, URLSearchParams, AbortController, DOMException,
    crypto: globalThis.crypto, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} } };
  sandbox.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  };
  context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  return { state, get writes() { return writes; },
    message(request, sender = POPUP) {
      return new Promise((resolve) => listener(request, sender, (response) => resolve(structuredClone(response))));
    } };
}

test('history import, cleanup and preview cancellation only accept this extension popup', async () => {
  const app = harness();
  const actions = ['previewHistoryImport', 'commitHistoryImport', 'previewHistoryCleanup',
    'commitHistoryCleanup', 'cancelHistoryPreview'];
  for (const action of actions) {
    for (const sender of [{}, { url: 'https://example.test/popup.html' },
      { url: 'chrome-extension://other/popup.html' },
      { url: 'chrome-extension://fixture/options.html' },
      { url: 'chrome-extension://fixture/workspace.html' }]) {
      assert.deepEqual(await app.message({ action, backup, token: 'guessed' }, sender),
        { success: false, errorCode: 'HISTORY_ACCESS_DENIED' });
    }
  }
  assert.equal(app.writes, 0);
  const preview = await app.message({ action: 'previewHistoryImport', backup },
    { ...POPUP, url: `${POPUP.url}?source=history#restore` });
  assert.equal(preview.success, true);
  assert.equal(preview.preview.importCount, 1);
  assert.deepEqual(await app.message({ action: 'commitHistoryImport', token: preview.preview.token }),
    { success: true, importedCount: 1, duplicateCount: 0, capacitySkippedCount: 0 });
  assert.equal(app.state.ocrHistory[0].id, 'imported');
});

test('preview tokens are bound to the originating popup document and are single use', async () => {
  const app = harness([{ id: 'ordinary', text: 'Ordinary', timestamp: 1 }]);
  const { preview } = await app.message({ action: 'previewHistoryCleanup' });
  for (const action of ['commitHistoryCleanup', 'cancelHistoryPreview']) {
    assert.deepEqual(await app.message({ action, token: preview.token }, { ...POPUP, documentId: 'popup-document-b' }),
      { success: false, errorCode: 'HISTORY_ACCESS_DENIED' });
  }
  assert.equal(app.writes, 0);
  assert.deepEqual(await app.message({ action: 'commitHistoryCleanup', token: preview.token }),
    { success: true, deletedCount: 1, keptCount: 0 });
  assert.deepEqual(await app.message({ action: 'commitHistoryCleanup', token: preview.token }),
    { success: false, errorCode: 'HISTORY_PREVIEW_EXPIRED' });
});

test('cancelled or concurrently changed previews cannot import and expose stable recovery error codes', async () => {
  const app = harness([{ id: 'existing', text: 'Original', timestamp: 1 }]);
  const first = await app.message({ action: 'previewHistoryImport', backup });
  assert.deepEqual(await app.message({ action: 'cancelHistoryPreview', token: first.preview.token }), { success: true });
  assert.deepEqual(await app.message({ action: 'commitHistoryImport', token: first.preview.token }),
    { success: false, errorCode: 'HISTORY_PREVIEW_EXPIRED' });
  const second = await app.message({ action: 'previewHistoryImport', backup });
  await app.message({ action: 'updateHistoryMetadata', historyId: 'existing', patch: { favorite: true } });
  assert.deepEqual(await app.message({ action: 'commitHistoryImport', token: second.preview.token }),
    { success: false, errorCode: 'HISTORY_PREVIEW_STALE' });
  assert.equal(app.state.ocrHistory.length, 1);
});

test('invalid backups and failed storage expose no credentials or internal errors', async () => {
  const app = harness();
  assert.deepEqual(await app.message({ action: 'previewHistoryImport', backup: { version: 3, records: [{}] } }),
    { success: false, errorCode: 'HISTORY_BACKUP_INVALID' });
  assert.equal(app.writes, 0);
  const failed = harness([], { failWrites: true });
  const { preview } = await failed.message({ action: 'previewHistoryImport', backup });
  assert.deepEqual(await failed.message({ action: 'commitHistoryImport', token: preview.token }),
    { success: false, errorCode: 'HISTORY_WRITE_FAILED' });
  assert.deepEqual(failed.state.ocrHistory, []);
});

test('save-as-new returns a complete unique record from existing editors and tolerates a missing source', async () => {
  const app = harness([{ id: 'source', text: 'Original', timestamp: 1, provider: 'openai',
    sourceUrl: 'https://example.test/private?q=secret', sourceTitle: 'Title' }]);
  const sender = { url: 'https://example.test/page', tab: { id: 3 } };
  const saved = await app.message({ action: 'saveHistoryAsNew', sourceId: 'source', text: 'My version' }, sender);
  assert.equal(saved.success, true);
  assert.notEqual(saved.record.id, 'source');
  assert.equal(saved.record.text, 'My version');
  assert.equal(saved.record.sourceUrl, 'https://example.test');
  assert.equal(saved.record.provider, 'openai');
  assert.equal(app.state.ocrHistory.find((value) => value.id === 'source').text, 'Original');
  const missing = await app.message({ action: 'saveHistoryAsNew', sourceId: 'deleted', text: 'Recovered edits' }, sender);
  assert.equal(missing.success, true);
  assert.equal(missing.record.sourceUrl, '');
  assert.deepEqual(await app.message({ action: 'saveHistoryAsNew', sourceId: 'deleted', text: {} }, sender),
    { success: false, errorCode: 'HISTORY_TEXT_INVALID' });
});
