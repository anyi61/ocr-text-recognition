'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'chrome-extension://fixture/workspace.html';
const IMAGE = 'data:image/png;base64,ZmFrZS1wbmc=';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function eventHook() {
  const listeners = new Set();
  return { addListener(listener) { listeners.add(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); } };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('Expected background contract condition was not reached');
}

function pendingResponse(_url, options) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('cancelled', 'AbortError'));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  });
}

function createHarness(options = {}) {
  const state = structuredClone({ apiProvider: 'openai',
    apiConfigs: { openai: { apiKey: 'fixture-secret', model: 'fixture-model' } },
    ocrHistory: [], ...options.state });
  const requests = [];
  const tabs = [];
  const permissions = [];
  const writes = [];
  let openedSettings = 0;
  const onMessage = eventHook();
  const onConnect = eventHook();
  const chrome = {
    runtime: { onMessage, onConnect, onInstalled: eventHook(), getURL: (value) => `chrome-extension://fixture/${value}`,
      async openOptionsPage() { openedSettings += 1; } },
    commands: { onCommand: eventHook() }, notifications: { create() {} },
    permissions: { async contains(details) { permissions.push(structuredClone(details)); return options.permission !== false; } },
    storage: { local: {
      async get(keys) {
        if (options.onGet) await options.onGet(keys);
        return structuredClone(Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]])));
      },
      async set(values) {
        if (options.failWrites) throw new Error('private storage detail');
        Object.assign(state, structuredClone(values));
        writes.push(structuredClone(values));
        if (options.onSet) await options.onSet(values, writes.length);
      }
    } },
    tabs: { async create(details) { tabs.push(structuredClone(details)); }, async query() { return []; } }
  };
  let context;
  const sandbox = { chrome, AbortController, DOMException, Response, URL, URLSearchParams,
    crypto: globalThis.crypto, setTimeout, clearTimeout, console: { log() {}, error() {}, warn() {} },
    async fetch(url, fetchOptions) {
      requests.push({ url: String(url), options: fetchOptions });
      if (options.fetch) return options.fetch(url, fetchOptions, requests.length);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Translated result' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
  };
  sandbox.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  };
  context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  return { state, requests, tabs, permissions, writes, get openedSettings() { return openedSettings; },
    message(request, sender = {}) { return new Promise((resolve) => onMessage.emit(request, sender, (value) => resolve(structuredClone(value)))); },
    connect(name = 'ocr-translation', sender = {}) {
      const replies = [];
      const port = { name, sender, onMessage: eventHook(), onDisconnect: eventHook(), postMessage: (value) => replies.push(structuredClone(value)) };
      onConnect.emit(port);
      return { replies, send: (message) => port.onMessage.emit(message), disconnect: () => port.onDisconnect.emit() };
    }
  };
}

test('settings mutation is restricted to this extension options page and never returns credentials', async () => {
  const harness = createHarness();
  const request = { action: 'saveSettings', settings: { prompt: 'New prompt', apiConfigs: { openai: { apiKey: 'replacement-secret' } } } };
  for (const sender of [{}, { url: 'https://example.test/options.html' },
    { url: 'chrome-extension://other/options.html' }, { url: PAGE }]) {
    const response = await harness.message(request, sender);
    assert.equal(response.errorCode, 'SETTINGS_ACCESS_DENIED');
  }
  assert.equal(harness.writes.length, 0);
  const response = await harness.message(request, { url: 'chrome-extension://fixture/options.html?source=review#provider' });
  assert.deepEqual(response, { success: true });
  assert.equal(harness.state.apiConfigs.openai.apiKey, 'replacement-secret');
  assert.equal(harness.state.apiConfigs.openai.model, 'fixture-model');
  assert.equal(harness.state.prompt, 'New prompt');
});

test('invalid settings import and failed storage cannot claim success or leak private errors', async () => {
  const harness = createHarness();
  const before = structuredClone(harness.state);
  const sender = { url: 'chrome-extension://fixture/options.html' };
  const response = await harness.message({ action: 'saveSettings', settings: {
    prompt: 'Must not save', apiConfigs: { openai: { apiKey: { secret: 'invalid-object' } } }
  } }, sender);
  assert.deepEqual(response, { success: false, errorCode: 'SETTINGS_INVALID' });
  assert.deepEqual(harness.state, before);
  assert.equal(harness.writes.length, 0);
  const failed = createHarness({ failWrites: true });
  assert.deepEqual(await failed.message({ action: 'saveSettings', settings: { prompt: 'Valid' } }, sender),
    { success: false, errorCode: 'SETTINGS_SAVE_FAILED' });
});

test('import and translation preference messages share one write queue', async () => {
  const gate = deferred();
  const harness = createHarness({ onSet: (_values, count) => count === 1 ? gate.promise : undefined });
  const first = harness.message({ action: 'saveTranslationPreferences', preferences: { targetLanguage: 'ja' } });
  await until(() => harness.writes.length === 1);
  const second = harness.message({ action: 'saveTranslationPreferences', preferences: { provider: 'openai' } });
  const imported = harness.message({ action: 'saveSettings', settings: {
    translationProvider: 'custom', translationTargetLanguage: 'fr'
  } }, { url: 'chrome-extension://fixture/options.html' });
  gate.resolve();
  const responses = await Promise.all([first, second, imported]);
  assert.ok(responses.every((response) => response.success));
  assert.deepEqual(await harness.message({ action: 'getTranslationPreferences' }), {
    success: true, preferences: { provider: 'custom', targetLanguage: 'fr' }
  });
});

const translationRequest = (changes = {}) => ({ action: 'translate', requestId: 'translate-1',
  provider: 'openai', targetLanguage: 'en', text: 'Original source', ...changes });

test('appearance changes accept only known fields from extension settings and popup', async () => {
  const harness = createHarness();
  const request = { action: 'saveAppearancePreferences', preferences: { theme: 'dark', uiLanguage: 'zh_CN' } };
  for (const sender of [{}, { url: PAGE }, { url: 'https://example.test/popup.html' },
    { url: 'chrome-extension://other/popup.html' }]) {
    assert.equal((await harness.message(request, sender)).errorCode, 'SETTINGS_ACCESS_DENIED');
  }
  const sender = { url: 'chrome-extension://fixture/popup.html?review=1' };
  for (const preferences of [{}, [], { theme: 'invalid' }, { uiLanguage: 'ja' }, { apiConfigs: {} },
    { theme: 'dark', prompt: 'Disallowed field' }]) {
    assert.equal((await harness.message({ ...request, preferences }, sender)).errorCode, 'SETTINGS_INVALID');
  }
  assert.equal(harness.writes.length, 0);
  assert.deepEqual(await harness.message(request, sender), { success: true });
  assert.equal(harness.state.theme, 'dark');
  assert.equal(harness.state.uiLanguage, 'zh_CN');
  const failed = createHarness({ failWrites: true });
  assert.deepEqual(await failed.message(request, sender), { success: false, errorCode: 'SETTINGS_SAVE_FAILED' });
});

test('popup appearance changes wait for earlier configuration imports in the shared queue', async () => {
  const gate = deferred();
  const harness = createHarness({ onSet: (_values, count) => count === 1 ? gate.promise : undefined });
  const imported = harness.message({ action: 'saveSettings', settings: {
    theme: 'light', uiLanguage: 'en', translationTargetLanguage: 'fr'
  } }, { url: 'chrome-extension://fixture/options.html' });
  await until(() => harness.writes.length === 1);
  const appearance = harness.message({ action: 'saveAppearancePreferences', preferences: {
    theme: 'dark', uiLanguage: 'zh_CN'
  } }, { url: 'chrome-extension://fixture/popup.html' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.writes.length, 1);
  gate.resolve();
  assert.ok((await Promise.all([imported, appearance])).every((response) => response.success));
  assert.equal(harness.state.theme, 'dark');
  assert.equal(harness.state.uiLanguage, 'zh_CN');
  assert.equal(harness.state.translationTargetLanguage, 'fr');
});

test('restored capabilities expose supported models and limits without credentials or private endpoints', async () => {
  const harness = createHarness({ state: { apiProvider: 'baidu', apiConfigs: {
    openai: { apiKey: 'fixture-secret', model: 'older-model' },
    custom: { endpoint: 'https://private.example.test/api', authMode: 'none', model: '' }
  } } });
  const capabilities = await harness.message({ action: 'getTranslationCapabilities' });
  assert.equal(capabilities.success, true);
  assert.equal(capabilities.maxCharacters, 12000);
  assert.ok(capabilities.languages.includes('zh_CN'));
  assert.equal(capabilities.providers.find((item) => item.id === 'baidu').supported, false);
  assert.equal(capabilities.providers.find((item) => item.id === 'openai').model, 'older-model');
  assert.equal(capabilities.providers.find((item) => item.id === 'custom').configured, true);
  assert.doesNotMatch(JSON.stringify(capabilities), /fixture-secret|private\.example|apiKey|endpoint/);
});

test('restored translation uses explicit provider and rereads updated credentials without changing OCR settings', async () => {
  const harness = createHarness({ state: { apiProvider: 'baidu' } });
  const port = harness.connect();
  port.send(translationRequest());
  await until(() => port.replies.length === 1);
  assert.equal(port.replies[0].success, true);
  harness.state.apiConfigs.openai = { apiKey: 'replacement-key', model: 'replacement-model' };
  port.send(translationRequest({ requestId: 'translate-2' }));
  await until(() => port.replies.length === 2);
  const request = harness.requests[1];
  assert.equal(request.options.headers.Authorization, 'Bearer replacement-key');
  assert.equal(JSON.parse(request.options.body).model, 'replacement-model');
  assert.doesNotMatch(request.options.body, /image_url|input_image|base64/);
  assert.equal(harness.state.apiProvider, 'baidu');
  assert.deepEqual(harness.state.ocrHistory, []);
});

test('restored invalid translation requests fail before network calls', async () => {
  for (const [changes, code] of [
    [{ text: '' }, 'TRANSLATION_EMPTY_TEXT'], [{ text: 'a'.repeat(12001) }, 'TRANSLATION_TEXT_TOO_LONG'],
    [{ provider: 'baidu' }, 'TRANSLATION_PROVIDER_UNSUPPORTED'],
    [{ provider: 'claude' }, 'TRANSLATION_PROVIDER_UNCONFIGURED'],
    [{ targetLanguage: 'bad' }, 'TRANSLATION_INVALID_LANGUAGE']
  ]) {
    const harness = createHarness();
    const port = harness.connect();
    port.send(translationRequest(changes));
    await until(() => port.replies.length === 1);
    assert.equal(port.replies[0].errorCode, code);
    assert.equal(harness.requests.length, 0);
  }
});

test('restored custom translation checks permission for capabilities and every actual request', async () => {
  const harness = createHarness({ permission: false, state: { apiConfigs: {
    custom: { endpoint: 'https://example.test/private', authMode: 'none', model: '' }
  } } });
  const capabilities = await harness.message({ action: 'getTranslationCapabilities' });
  assert.equal(capabilities.providers.find((item) => item.id === 'custom').permissionGranted, false);
  const port = harness.connect();
  port.send(translationRequest({ provider: 'custom' }));
  await until(() => port.replies.length === 1);
  assert.equal(port.replies[0].errorCode, 'TRANSLATION_PERMISSION_REQUIRED');
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.permissions.filter((item) => item.origins[0] === 'https://example.test/*').length, 2);
});

test('restored translation cancellation really aborts fetch and a later retry succeeds', async () => {
  const harness = createHarness({ fetch: (url, options, count) => count === 1 ? pendingResponse(url, options)
    : Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'Retry result' } }] }))) });
  const port = harness.connect();
  port.send(translationRequest());
  await until(() => harness.requests.length === 1);
  port.send({ action: 'cancel', requestId: 'wrong-task' });
  assert.equal(harness.requests[0].options.signal.aborted, false);
  port.send({ action: 'cancel', requestId: 'translate-1' });
  await until(() => port.replies.length === 1);
  assert.equal(harness.requests[0].options.signal.aborted, true);
  assert.equal(port.replies[0].errorCode, 'TRANSLATION_CANCELLED');
  assert.equal(port.replies[0].cancelled, true);
  port.send(translationRequest({ requestId: 'translate-2' }));
  await until(() => port.replies.length === 2);
  assert.equal(port.replies[1].text, 'Retry result');
  assert.deepEqual(harness.state.ocrHistory, []);
});

test('restored task replacement and disconnect affect only their own translation port', async () => {
  const harness = createHarness({ fetch: pendingResponse });
  const first = harness.connect();
  const second = harness.connect();
  first.send(translationRequest({ requestId: 'first-1' }));
  second.send(translationRequest({ requestId: 'second-1' }));
  await until(() => harness.requests.length === 2);
  first.send(translationRequest({ requestId: 'first-2' }));
  await until(() => harness.requests.length === 3);
  assert.equal(harness.requests[0].options.signal.aborted, true);
  assert.equal(harness.requests[1].options.signal.aborted, false);
  first.disconnect();
  assert.equal(harness.requests[2].options.signal.aborted, true);
  assert.equal(harness.requests[1].options.signal.aborted, false);
  second.send({ action: 'cancel', requestId: 'second-1' });
  await until(() => second.replies.length === 1);
  assert.deepEqual(first.replies, []);
  assert.deepEqual(harness.state.ocrHistory, []);
});

test('restored disconnect during configuration lookup prevents outgoing translation', async () => {
  const gate = deferred();
  const harness = createHarness({ onGet: () => gate.promise });
  const port = harness.connect();
  port.send(translationRequest());
  port.disconnect();
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.requests.length, 0);
  assert.deepEqual(port.replies, []);
});

test('restored history translation snapshots exact edited source without committing the original or draft', async () => {
  const original = { id: 'record-1', text: 'Saved original', timestamp: 1,
    draft: { text: 'Draft input', baseText: 'Saved original', updatedAt: 2 } };
  const harness = createHarness({ state: { ocrHistory: [original] } });
  const port = harness.connect();
  port.send(translationRequest({ historyId: 'record-1', text: 'Visible edited source' }));
  await until(() => port.replies.length === 1);
  const reply = port.replies[0];
  assert.equal(reply.persisted, true);
  assert.equal(reply.translation.sourceText, 'Visible edited source');
  assert.equal(harness.state.ocrHistory[0].text, 'Saved original');
  assert.deepEqual(harness.state.ocrHistory[0].draft, original.draft);
  assert.equal(harness.state.ocrHistory[0].translation.text, 'Translated result');
  assert.doesNotMatch(JSON.stringify(harness.state.ocrHistory), /fixture-secret|apiKey/);
});

test('restored translation storage failure preserves a successful session result with a warning', async () => {
  const harness = createHarness({ failWrites: true, state: { ocrHistory: [{ id: 'record-1', text: 'Original', timestamp: 1 }] } });
  const port = harness.connect();
  port.send(translationRequest({ historyId: 'record-1' }));
  await until(() => port.replies.length === 1);
  assert.equal(port.replies[0].success, true);
  assert.equal(port.replies[0].persisted, false);
  assert.equal(port.replies[0].warningCode, 'TRANSLATION_SAVE_FAILED');
  assert.equal(port.replies[0].text, 'Translated result');
  assert.equal(harness.state.ocrHistory[0].translation, undefined);
});

test('restored deleting history during translation never resurrects the deleted record', async () => {
  const response = deferred();
  const harness = createHarness({ fetch: () => response.promise,
    state: { ocrHistory: [{ id: 'record-1', text: 'Original', timestamp: 1 }] } });
  const port = harness.connect();
  port.send(translationRequest({ historyId: 'record-1' }));
  await until(() => harness.requests.length === 1);
  assert.equal((await harness.message({ action: 'deleteHistoryRecord', historyId: 'record-1' })).success, true);
  response.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'Late translation' } }] })));
  await until(() => port.replies.length === 1);
  assert.equal(port.replies[0].success, true);
  assert.equal(port.replies[0].persisted, false);
  assert.deepEqual(harness.state.ocrHistory, []);
});

test('restored translation cancellation rolls back a pending write before queued history deletion', async () => {
  const gate = deferred();
  const original = [{ id: 'record-1', text: 'Original', timestamp: 1 }, { id: 'keep', text: 'Keep', timestamp: 2 }];
  const harness = createHarness({ state: { ocrHistory: original }, onSet: (_value, count) => count === 1 ? gate.promise : undefined });
  const port = harness.connect();
  port.send(translationRequest({ historyId: 'record-1' }));
  await until(() => harness.writes.length === 1);
  port.send({ action: 'cancel', requestId: 'translate-1' });
  const deletion = harness.message({ action: 'deleteHistoryRecord', historyId: 'record-1' });
  gate.resolve();
  await deletion;
  await until(() => port.replies.length === 1);
  assert.equal(port.replies[0].errorCode, 'TRANSLATION_CANCELLED');
  assert.deepEqual(harness.writes[1].ocrHistory, original);
  assert.deepEqual(harness.state.ocrHistory, [original[1]]);
});

test('restored background draft messages preserve originals, detect stale owners, discard exact revisions and commit explicitly', async () => {
  const harness = createHarness({ state: { ocrHistory: [{ id: 'record-1', text: 'Original', timestamp: 1 }] } });
  const draft = await harness.message({ action: 'saveHistoryDraft', historyId: 'record-1', text: '', baseText: 'Original', ownerId: 'editor-a', expectedUpdatedAt: null });
  assert.equal(draft.success, true);
  assert.equal(draft.draft.text, '');
  assert.equal(harness.state.ocrHistory[0].text, 'Original');
  const stale = await harness.message({ action: 'saveHistoryDraft', historyId: 'record-1', text: 'Stale', baseText: 'Original', ownerId: 'editor-b', expectedUpdatedAt: null });
  assert.equal(stale.errorCode, 'HISTORY_DRAFT_CONFLICT');
  const wrongDiscard = await harness.message({ action: 'discardHistoryDraft', historyId: 'record-1', expectedUpdatedAt: draft.draft.updatedAt - 1 });
  assert.equal(wrongDiscard.errorCode, 'HISTORY_DRAFT_CONFLICT');
  const discard = await harness.message({ action: 'discardHistoryDraft', historyId: 'record-1', expectedUpdatedAt: draft.draft.updatedAt });
  assert.equal(discard.success, true);
  const next = await harness.message({ action: 'saveHistoryDraft', historyId: 'record-1', text: 'Corrected', baseText: 'Original', ownerId: 'editor-a', expectedUpdatedAt: discard.draftUpdatedAt });
  assert.equal(next.success, true);
  await harness.message({ action: 'updateHistoryRecord', historyId: 'record-1', text: 'Corrected', expectedText: 'Original' });
  const saved = await harness.message({ action: 'getHistoryRecord', historyId: 'record-1' });
  assert.equal(saved.record.text, 'Corrected');
  assert.equal(saved.record.draft, undefined);
});

test('restored invalid, missing and failing draft storage uses stable public errors', async () => {
  const harness = createHarness();
  assert.equal((await harness.message({ action: 'saveHistoryDraft', historyId: 'missing', text: {}, baseText: 'Original' })).errorCode, 'HISTORY_DRAFT_INVALID');
  assert.equal((await harness.message({ action: 'saveHistoryDraft', historyId: 'missing', text: 'Edited', baseText: 'Original' })).errorCode, 'HISTORY_RECORD_MISSING');
  assert.equal((await harness.message({ action: 'getHistoryRecord', historyId: 'missing' })).errorCode, 'HISTORY_RECORD_MISSING');
  const failed = createHarness({ failWrites: true, state: { ocrHistory: [{ id: 'record-1', text: 'Original', timestamp: 1 }] } });
  const response = await failed.message({ action: 'saveHistoryDraft', historyId: 'record-1', text: 'Edit', baseText: 'Original' });
  assert.equal(response.errorCode, 'HISTORY_WRITE_FAILED');
  assert.doesNotMatch(JSON.stringify(response), /private storage detail/);
});

test('restored workspace and translation settings open only packaged extension destinations', async () => {
  const harness = createHarness();
  assert.equal((await harness.message({ action: 'openImageWorkspace', url: 'https://evil.test' })).success, true);
  assert.deepEqual(harness.tabs, [{ url: PAGE }]);
  assert.equal((await harness.message({ action: 'openTranslationSettings' })).success, true);
  assert.equal(harness.openedSettings, 1);
});

test('restored image workspace saves generic provenance without filenames or image payloads', async () => {
  const harness = createHarness();
  const port = harness.connect('ocr-image-workspace', { url: `${PAGE}?file=private-name.png`, tab: { title: 'private-name.png', url: 'file:///secret.png' } });
  port.send({ action: 'performOCR', requestId: 'image-1', imageData: IMAGE });
  await until(() => port.replies.length === 1);
  assert.equal(port.replies[0].success, true);
  assert.equal(harness.state.ocrHistory[0].sourceTitle, 'Imported image');
  assert.equal(harness.state.ocrHistory[0].sourceUrl, '');
  assert.doesNotMatch(JSON.stringify(harness.state.ocrHistory), /private-name|secret\.png|base64|ZmFr/);
});

test('restored forged workspace ports and revoked custom endpoint permissions never upload an image', async () => {
  const harness = createHarness({ permission: false, state: { apiProvider: 'custom', apiConfigs: {
    custom: { endpoint: 'https://example.test/ocr', authMode: 'none', model: '' }
  } } });
  const forged = harness.connect('ocr-image-workspace', { url: 'https://example.test/workspace.html' });
  forged.send({ action: 'performOCR', requestId: 'forged', imageData: IMAGE });
  const port = harness.connect('ocr-image-workspace', { url: PAGE });
  port.send({ action: 'performOCR', requestId: 'image-1', imageData: IMAGE });
  await until(() => port.replies.length === 1);
  assert.equal(port.replies[0].errorCode, 'IMAGE_ENDPOINT_PERMISSION_REQUIRED');
  assert.equal(harness.requests.length, 0);
  assert.deepEqual(forged.replies, []);
});

test('restored workspace replacement and closure abort only the matching image request while page OCR survives', async () => {
  const harness = createHarness({ fetch: pendingResponse });
  const workspace = harness.connect('ocr-image-workspace', { url: PAGE });
  workspace.send({ action: 'performOCR', requestId: 'image-1', imageData: IMAGE });
  await until(() => harness.requests.length === 1);
  const pageRequest = harness.message({ action: 'performOCR', requestId: 'page-1', imageData: IMAGE },
    { tab: { id: 1, url: 'https://example.test/page', title: 'Page' } });
  await until(() => harness.requests.length === 2);
  workspace.send({ action: 'performOCR', requestId: 'image-2', imageData: IMAGE });
  await until(() => harness.requests.length === 3);
  assert.equal(harness.requests[0].options.signal.aborted, true);
  assert.equal(harness.requests[1].options.signal.aborted, false);
  workspace.disconnect();
  assert.equal(harness.requests[2].options.signal.aborted, true);
  assert.equal(harness.requests[1].options.signal.aborted, false);
  await harness.message({ action: 'cancelOCR', requestId: 'page-1' });
  const pageResult = await pageRequest;
  assert.equal(pageResult.cancelled, true);
  assert.deepEqual(workspace.replies, []);
  assert.deepEqual(harness.state.ocrHistory, []);
});

test('restored workspace closure while history is writing rolls back before another queued mutation', async () => {
  const gate = deferred();
  const original = [{ id: 'keep', text: 'Keep', timestamp: 1 }];
  const harness = createHarness({ state: { ocrHistory: original }, onSet: (_value, count) => count === 1 ? gate.promise : undefined });
  const port = harness.connect('ocr-image-workspace', { url: PAGE });
  port.send({ action: 'performOCR', requestId: 'image-1', imageData: IMAGE });
  await until(() => harness.writes.length === 1);
  port.disconnect();
  const update = harness.message({ action: 'updateHistoryRecord', historyId: 'keep', text: 'Keep edited', expectedText: 'Keep' });
  gate.resolve();
  await update;
  assert.deepEqual(harness.writes[1].ocrHistory, original);
  assert.equal(harness.state.ocrHistory.length, 1);
  assert.equal(harness.state.ocrHistory[0].text, 'Keep edited');
  assert.deepEqual(port.replies, []);
});

test('OCR auto-copy preference defaults off and only the boolean true enables it', async () => {
  for (const value of [undefined, false, 'true', 1, null, true]) {
    const harness = createHarness({ state: value === undefined ? {} : { autoCopy: value } });
    const result = await harness.message({ action: 'performOCR', requestId: 'ocr-1', imageData: IMAGE });
    assert.equal(result.success, true);
    assert.equal(result.autoCopy, value === true);
    assert.equal(harness.state.ocrHistory.length, 1);
  }
});

test('OCR retry rereads credentials, model and auto-copy preference without a second screenshot payload', async () => {
  const harness = createHarness({ fetch: (_url, _options, count) => Promise.resolve(new Response(JSON.stringify(count === 1
    ? { error: { message: 'authentication fixture' } }
    : { choices: [{ message: { content: 'Recovered OCR' } }] }), { status: count === 1 ? 401 : 200 })) });
  const failed = await harness.message({ action: 'performOCR', requestId: 'ocr-1', imageData: IMAGE });
  assert.equal(failed.success, false);
  assert.equal(failed.errorCode, 'API_AUTHENTICATION_FAILED');
  assert.deepEqual(harness.state.ocrHistory, []);
  harness.state.autoCopy = true;
  harness.state.apiConfigs.openai = { apiKey: 'corrected-key', model: 'corrected-model' };
  const result = await harness.message({ action: 'performOCR', requestId: 'ocr-2', imageData: IMAGE });
  assert.equal(result.success, true);
  assert.equal(result.autoCopy, true);
  assert.equal(harness.requests[1].options.headers.Authorization, 'Bearer corrected-key');
  const firstBody = JSON.parse(harness.requests[0].options.body);
  const retryBody = JSON.parse(harness.requests[1].options.body);
  assert.equal(retryBody.model, 'corrected-model');
  assert.equal(retryBody.messages[0].content[1].image_url.url, firstBody.messages[0].content[1].image_url.url);
  assert.equal(harness.state.ocrHistory.length, 1);
});

test('OCR auto-copy uses the initiating request preference and cancellation never grants a success copy flag', async () => {
  const response = deferred();
  const harness = createHarness({ state: { autoCopy: true }, fetch: () => response.promise });
  const result = harness.message({ action: 'performOCR', requestId: 'ocr-1', imageData: IMAGE });
  await until(() => harness.requests.length === 1);
  harness.state.autoCopy = false;
  response.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'Started with copy enabled' } }] })));
  assert.equal((await result).autoCopy, true);
  const cancelled = createHarness({ state: { autoCopy: true }, fetch: pendingResponse });
  const pending = cancelled.message({ action: 'performOCR', requestId: 'cancelled-1', imageData: IMAGE });
  await until(() => cancelled.requests.length === 1);
  await cancelled.message({ action: 'cancelOCR', requestId: 'cancelled-1' });
  const cancellation = await pending;
  assert.equal(cancellation.cancelled, true);
  assert.equal(cancellation.autoCopy, undefined);
  assert.deepEqual(cancelled.state.ocrHistory, []);
});

test('background metadata patches merge concurrently with each other and drafts without changing OCR text', async () => {
  const harness = createHarness({ state: { ocrHistory: [{ id: 'record-1', text: 'Original', timestamp: 1 }] } });
  const results = await Promise.all([
    harness.message({ action: 'updateHistoryMetadata', historyId: 'record-1', patch: { favorite: true } }),
    harness.message({ action: 'updateHistoryMetadata', historyId: 'record-1', patch: { name: '  Invoice 2026  ' } }),
    harness.message({ action: 'saveHistoryDraft', historyId: 'record-1', text: 'Unfinished edit', baseText: 'Original' })
  ]);
  assert.ok(results.every((result) => result.success));
  const record = (await harness.message({ action: 'getHistoryRecord', historyId: 'record-1' })).record;
  assert.equal(record.favorite, true);
  assert.equal(record.name, 'Invoice 2026');
  assert.equal(record.text, 'Original');
  assert.equal(record.draft.text, 'Unfinished edit');
  assert.equal(results[1].record.favorite, true);
});

test('background metadata validation and storage errors preserve the record and never recreate deleted history', async () => {
  const original = { id: 'record-1', text: 'Original', timestamp: 1 };
  const harness = createHarness({ state: { ocrHistory: [original] } });
  for (const patch of [{ favorite: 'true' }, { name: 4 }, { text: 'overwrite' }, { name: 'a'.repeat(121) }, null]) {
    const result = await harness.message({ action: 'updateHistoryMetadata', historyId: 'record-1', patch });
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'HISTORY_METADATA_INVALID');
    assert.deepEqual(harness.state.ocrHistory, [original]);
  }
  await harness.message({ action: 'deleteHistoryRecord', historyId: 'record-1' });
  assert.equal((await harness.message({ action: 'updateHistoryMetadata', historyId: 'record-1', patch: { favorite: true } })).errorCode, 'HISTORY_RECORD_MISSING');
  assert.deepEqual(harness.state.ocrHistory, []);
  const failed = createHarness({ state: { ocrHistory: [original] }, failWrites: true });
  const result = await failed.message({ action: 'updateHistoryMetadata', historyId: 'record-1', patch: { name: 'Invoice' } });
  assert.equal(result.errorCode, 'HISTORY_WRITE_FAILED');
  assert.deepEqual(failed.state.ocrHistory, [original]);
});

test('background OCR retention keeps favorite and unfinished draft records beyond fifty ordinary entries', async () => {
  const protectedRecords = [
    { id: 'favorite', text: 'Favorite', timestamp: 1, favorite: true, name: 'Important' },
    { id: 'draft', text: 'Draft source', timestamp: 2, draft: { text: '', baseText: 'Draft source', updatedAt: 3 } }
  ];
  const ordinary = Array.from({ length: 50 }, (_, index) => ({ id: `ordinary-${index}`, text: `Text ${index}`, timestamp: 10 + index }));
  const harness = createHarness({ state: { ocrHistory: [...protectedRecords, ...ordinary] } });
  await harness.message({ action: 'performOCR', requestId: 'ocr-1', imageData: IMAGE });
  assert.equal(harness.state.ocrHistory.length, 52);
  assert.deepEqual(harness.state.ocrHistory.find((record) => record.id === 'favorite'), protectedRecords[0]);
  assert.deepEqual(harness.state.ocrHistory.find((record) => record.id === 'draft'), protectedRecords[1]);
  assert.equal(harness.state.ocrHistory.some((record) => record.id === 'ordinary-0'), false);
});

test('background independent translation preferences serialize field patches and persist across worker restart', async () => {
  const harness = createHarness({ state: { apiProvider: 'baidu', uiLanguage: 'en', language: 'ja' } });
  const defaults = await harness.message({ action: 'getTranslationPreferences' });
  assert.deepEqual(defaults.preferences, { provider: 'claude', targetLanguage: 'zh_CN' });
  const results = await Promise.all([
    harness.message({ action: 'saveTranslationPreferences', preferences: { provider: 'openai' } }),
    harness.message({ action: 'saveTranslationPreferences', preferences: { targetLanguage: 'fr' } })
  ]);
  assert.ok(results.every((result) => result.success));
  const restarted = createHarness({ state: harness.state });
  assert.deepEqual((await restarted.message({ action: 'getTranslationPreferences' })).preferences,
    { provider: 'openai', targetLanguage: 'fr' });
  assert.equal(harness.state.apiProvider, 'baidu');
  assert.equal(harness.state.uiLanguage, 'en');
  assert.equal(harness.state.language, 'ja');
  const history = harness.state.ocrHistory;
  assert.deepEqual(history, []);
});

test('background invalid preference patches and write failures keep previous global preferences', async () => {
  const state = { translationProvider: 'openai', translationTargetLanguage: 'ja' };
  const harness = createHarness({ state });
  for (const preferences of [null, {}, { provider: 'unknown' }, { targetLanguage: 'unknown' }, { apiProvider: 'claude' }]) {
    const response = await harness.message({ action: 'saveTranslationPreferences', preferences });
    assert.equal(response.success, false);
    assert.equal(response.errorCode, 'TRANSLATION_PREFERENCES_WRITE_FAILED');
  }
  assert.deepEqual((await harness.message({ action: 'getTranslationPreferences' })).preferences, { provider: 'openai', targetLanguage: 'ja' });
  const failed = createHarness({ state, failWrites: true });
  const result = await failed.message({ action: 'saveTranslationPreferences', preferences: { provider: 'custom' } });
  assert.equal(result.errorCode, 'TRANSLATION_PREFERENCES_WRITE_FAILED');
  assert.equal(failed.state.translationProvider, 'openai');
  assert.equal((await failed.message({ action: 'openSettings' })).success, true);
  assert.equal(failed.openedSettings, 1);
});

test('page OCR checks endpoint permission for both configurable providers before uploading', async () => {
  for (const provider of ['custom', 'openai-compatible']) {
    const storageKey = provider === 'custom' ? 'custom' : 'openaiCompatible';
    const harness = createHarness({ permission: false, state: { apiProvider: provider, apiConfigs: {
      [storageKey]: { endpoint: 'https://example.test/ocr', apiKey: 'fixture-key', model: 'fixture-model' }
    } } });
    const result = await harness.message({ action: 'performOCR', requestId: 'page-1', imageData: IMAGE },
      { tab: { id: 1, url: 'https://page.test/document' } });
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'OCR_ENDPOINT_PERMISSION_REQUIRED');
    assert.equal(result.cancelled, undefined);
    assert.deepEqual(harness.permissions, [{ origins: ['https://example.test/*'] }]);
    assert.equal(harness.requests.length, 0);
    assert.deepEqual(harness.state.ocrHistory, []);
  }
});

test('retrying a failed page image rechecks revoked permission and resumes only after access is granted', async () => {
  const options = { state: { apiProvider: 'openai-compatible', apiConfigs: { openaiCompatible: {
    endpoint: 'https://example.test/ocr', apiKey: 'fixture-key', model: 'fixture-model'
  } } }, fetch: (_url, _options, count) => Response.json(count === 1
    ? { error: { message: 'Rejected first attempt' } }
    : { choices: [{ message: { content: 'Recovered text' } }] }, { status: count === 1 ? 401 : 200 }) };
  const harness = createHarness(options);
  const sender = { tab: { id: 1, url: 'https://page.test/document' } };
  const recognize = (requestId) => harness.message({ action: 'performOCR', requestId, imageData: IMAGE }, sender);
  assert.equal((await recognize('page-first')).errorCode, 'API_AUTHENTICATION_FAILED');
  options.permission = false;
  const denied = await recognize('page-retry-denied');
  assert.equal(denied.errorCode, 'OCR_ENDPOINT_PERMISSION_REQUIRED');
  assert.equal(harness.requests.length, 1, 'revoked access must not allow a retry upload');
  assert.deepEqual(harness.state.ocrHistory, []);
  options.permission = true;
  const recovered = await recognize('page-retry-granted');
  assert.equal(recovered.success, true);
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[1].options.body, harness.requests[0].options.body);
  assert.equal(harness.state.ocrHistory.length, 1);
  assert.equal(harness.permissions.length, 3);
});
