'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const TAB = { id: 7, windowId: 1, url: 'https://example.test/private?q=hidden', title: 'Sample' };
const IMAGE = 'data:image/png;base64,ZmFrZQ==';

// Execute the real service-worker entry and its imports. Only Chrome and HTTP
// are replaced; dispatch, configuration, provider, cancellation and history run unchanged.
function createHarness(fetchImpl = async () => new Response(JSON.stringify({
  choices: [{ message: { content: 'recognized text' } }]
})), extensionRoot = ROOT) {
  let listener;
  let context;
  const state = {
    apiProvider: 'openai', apiConfigs: { openai: { apiKey: 'test-only', model: 'test-model' } },
    language: 'en', theme: 'dark', uiLanguage: 'en', ocrHistory: []
  };
  const local = {
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return structuredClone(Object.fromEntries(names.filter(key => key in state).map(key => [key, state[key]])));
    },
    async set(values) { Object.assign(state, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; },
    async setAccessLevel() {}
  };
  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener(fn) { assert.equal(listener, undefined); listener = fn; } }
    },
    commands: { onCommand: { addListener() {} } },
    storage: { local },
    tabs: { async query() { return [TAB]; }, async captureVisibleTab() { return IMAGE; } }
  };
  context = vm.createContext({
    chrome, AbortController, DOMException, URL, URLSearchParams, Response,
    setTimeout, clearTimeout, crypto: globalThis.crypto,
    console: { log() {}, error() {}, warn() {} }, fetch: fetchImpl,
    importScripts(...files) {
      for (const file of files) vm.runInContext(fs.readFileSync(path.join(extensionRoot, file), 'utf8'), context, { filename: file });
    }
  });
  vm.runInContext(fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  function send(request, sender = { tab: TAB }, asynchronous = true) {
    return new Promise((resolve, reject) => {
      let calls = 0;
      const timer = setTimeout(() => reject(new Error(`No response for ${request.action}`)), 1000);
      const keepOpen = listener(request, sender, value => {
        clearTimeout(timer);
        calls += 1;
        assert.equal(calls, 1, 'one response per message');
        resolve(structuredClone(value));
      });
      assert.equal(keepOpen, asynchronous, `channel lifetime: ${request.action}`);
    });
  }
  return { send, state, chrome };
}

test('capture message preserves dataUrl-only success and coded identity failures', async () => {
  const h = createHarness();
  assert.deepEqual(await h.send({ action: 'captureVisibleTab' }), { dataUrl: IMAGE });
  assert.deepEqual(await h.send({ action: 'captureVisibleTab' }, {}), {
    error: 'Invalid capture tab', errorCode: 'CAPTURE_TAB_CHANGED'
  });
  let queries = 0;
  h.chrome.tabs.query = async () => [++queries === 1 ? TAB : { ...TAB, id: 8 }];
  assert.deepEqual(await h.send({ action: 'captureVisibleTab' }), {
    error: 'Active tab changed', errorCode: 'CAPTURE_TAB_CHANGED'
  });
});

test('preference and upload notice messages preserve fields without exposing configuration', async () => {
  const h = createHarness();
  assert.deepEqual(await h.send({ action: 'getContentPreferences' }), { success: true, theme: 'dark', uiLanguage: 'en' });
  assert.deepEqual(await h.send({ action: 'getUploadNoticeState' }), {
    success: true, acknowledged: false, provider: 'openai', version: 1
  });
  assert.deepEqual(await h.send({ action: 'acknowledgeUploadNotice' }), { success: true, version: 1 });
  assert.deepEqual(await h.send({ action: 'getUploadNoticeState' }), {
    success: true, acknowledged: true, provider: 'openai', version: 1
  });
  h.chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  assert.deepEqual(await h.send({ action: 'getContentPreferences' }), { success: false });
  assert.deepEqual(await h.send({ action: 'getUploadNoticeState' }), { success: false });
});

test('OCR and history messages preserve response shapes through a complete edit/delete cycle', async () => {
  const h = createHarness();
  const result = await h.send({ action: 'performOCR', imageData: IMAGE, requestId: 'history' });
  assert.equal(typeof result.historyId, 'string');
  assert.deepEqual(result, { success: true, text: 'recognized text', historyId: result.historyId });
  const listed = await h.send({ action: 'listHistory' });
  assert.deepEqual(Object.keys(listed).sort(), ['records', 'success']);
  assert.equal(listed.success, true);
  assert.equal(listed.records.length, 1);
  assert.equal(listed.records[0].sourceUrl, 'https://example.test');
  assert.equal(listed.records[0].id, result.historyId);
  assert.deepEqual(await h.send({ action: 'updateHistoryRecord', historyId: result.historyId, text: 'edited' }), { success: true });
  assert.equal((await h.send({ action: 'listHistory' })).records[0].text, 'edited');
  assert.deepEqual(await h.send({ action: 'updateHistoryRecord', historyId: 'missing', text: 'edited' }), { success: false });
  assert.deepEqual(await h.send({ action: 'deleteHistoryRecord', historyId: result.historyId }), { success: true });
  assert.deepEqual(await h.send({ action: 'deleteHistoryRecord', historyId: result.historyId }), { success: false });
  await h.send({ action: 'performOCR', imageData: IMAGE, requestId: 'another' });
  assert.deepEqual(await h.send({ action: 'clearHistory' }), { success: true });
  assert.deepEqual(await h.send({ action: 'listHistory' }), { success: true, records: [] });
});

test('OCR configuration failures and incognito results retain their original contracts', async () => {
  const h = createHarness();
  assert.deepEqual(await h.send({ action: 'performOCR', imageData: IMAGE, requestId: 'private' }, { tab: { ...TAB, incognito: true } }), {
    success: true, text: 'recognized text', historyId: null
  });
  assert.deepEqual(h.state.ocrHistory, []);
  h.state.apiConfigs = {};
  assert.deepEqual(await h.send({ action: 'performOCR', imageData: IMAGE, requestId: 'missing-config' }), {
    success: false, errorCode: 'MISSING_API_KEY', error: 'Missing API configuration'
  });
});

test('connection test and unknown action retain separate success/error shapes', async () => {
  const h = createHarness();
  assert.deepEqual(await h.send({ action: 'testAPI', config: { apiProvider: 'openai', apiKey: 'test-only', model: 'test-model' } }), {
    success: true, message: '连接成功'
  });
  assert.deepEqual(h.state.ocrHistory, []);
  assert.deepEqual(await h.send({ action: 'unknown' }, {}, false), { success: false, error: 'UNKNOWN_ACTION' });
});

test('cancel message aborts only its request while a second tab completes', async () => {
  const pending = [];
  const h = createHarness((_url, options) => new Promise((resolve, reject) => {
    pending.push({ resolve, signal: options.signal });
    options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }));
  const first = h.send({ action: 'performOCR', imageData: IMAGE, requestId: 'tab-a' });
  const second = h.send({ action: 'performOCR', imageData: IMAGE, requestId: 'tab-b' }, { tab: { ...TAB, id: 8 } });
  // Wait for the two real provider paths to enter the injected transport.
  while (pending.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(await h.send({ action: 'cancelOCR', requestId: 'tab-a' }, { tab: TAB }, false), { success: true, cancelled: true });
  assert.deepEqual(await first, { success: false, cancelled: true, errorCode: 'OCR_CANCELLED', error: 'OCR cancelled' });
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending[1].signal.aborted, false);
  pending[1].resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'tab B' } }] })));
  assert.equal((await second).text, 'tab B');
  assert.deepEqual(h.state.ocrHistory.map(record => record.text), ['tab B']);
  assert.deepEqual(await h.send({ action: 'cancelOCR', requestId: 'missing' }, {}, false), { success: true, cancelled: false });
});

test('history write failure returns recognized text with the existing warning', async () => {
  const h = createHarness();
  const originalSet = h.chrome.storage.local.set;
  h.chrome.storage.local.set = async values => {
    if ('ocrHistory' in values) throw new Error('quota exceeded');
    return originalSet(values);
  };
  const result = await h.send({ action: 'performOCR', imageData: IMAGE, requestId: 'quota' });
  assert.deepEqual(result, {
    success: true, text: 'recognized text', historyId: null, warningCode: 'HISTORY_SAVE_FAILED'
  });
  assert.deepEqual(h.state.ocrHistory, []);
  assert.deepEqual(await h.send({ action: 'cancelOCR', requestId: 'quota' }, {}, false), { success: true, cancelled: false });
});

test('failure and retries stay with the originally selected provider even when settings change', async () => {
  for (const finalStatus of [200, 401, 503]) {
    const requests = [];
    const h = createHarness(async (url, options) => {
      requests.push({ url, options });
      h.state.apiProvider = 'claude';
      h.state.apiConfigs.claude = { apiKey: 'other-test-key' };
      return new Response(JSON.stringify({ choices: [{ message: { content: 'original provider' } }] }), {
        status: requests.length === 1 ? 503 : finalStatus,
        headers: { 'retry-after': '0' }
      });
    });
    const result = await h.send({ action: 'performOCR', imageData: IMAGE, requestId: `retry-${finalStatus}` });
    assert.equal(result.success, finalStatus === 200);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(request.options.headers.Authorization, 'Bearer test-only');
      assert.equal(JSON.parse(request.options.body).model, 'test-model');
    }
    assert.equal(h.state.ocrHistory.length, finalStatus === 200 ? 1 : 0);
    if (finalStatus === 200) assert.equal(h.state.ocrHistory[0].provider, 'openai');
  }
});


test('production ZIP contains and loads the complete background dependency graph', async () => {
  const { buildPackage, PRODUCTION_FILES } = await import('../scripts/package-extension.mjs');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-background-package-'));
  try {
    const source = path.join(temporary, 'source');
    const unpacked = path.join(temporary, 'unpacked');
    fs.mkdirSync(source);
    for (const file of [...PRODUCTION_FILES, 'package.json']) {
      fs.cpSync(path.join(ROOT, file), path.join(source, file), { recursive: true });
    }
    const zip = buildPackage(source);
    execFileSync('unzip', ['-q', zip, '-d', unpacked]);
    assert.deepEqual(fs.readdirSync(unpacked).sort(), [...PRODUCTION_FILES].sort());
    const h = createHarness(undefined, unpacked);
    const result = await h.send({ action: 'performOCR', imageData: IMAGE, requestId: 'packaged' });
    assert.equal(result.success, true);
    assert.equal(result.text, 'recognized text');
    assert.equal((await h.send({ action: 'listHistory' })).records.length, 1);
    assert.deepEqual(await h.send({ action: 'captureVisibleTab' }), { dataUrl: IMAGE });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
