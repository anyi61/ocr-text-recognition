const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setImmediate } = require('node:timers');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Element {
  constructor() {
    this.children = new Map();
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.isConnected = true;
    this.value = '';
    this.classList = { add() {}, remove() {} };
  }
  setAttribute() {}
  removeAttribute(name) { delete this[name]; }
  click() { return this.fire('click'); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener() {}
  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector);
  }
  getElementById() { return null; }
  appendChild(element) { this.lastChild = element; }
  append(...elements) { this.lastChild = elements.at(-1); }
  remove() { this.isConnected = false; }
  focus() { this.focused = true; }
  contains() { return false; }
  select() {}
  fire(name, overrides = {}) { return this.listeners.get(name)?.({ isTrusted: true, preventDefault() {}, stopPropagation() {}, ...overrides }); }
}

function contentHarness({ realResult = false, clipboard = async () => {} } = {}) {
  const root = new Element();
  const sent = [];
  const requests = [];
  const observations = { progress: false, notices: [], results: [] };
  const document = new Element();
  document.createElement = () => new Element();
  const window = new Element();
  const chrome = {
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(message) {
        sent.push(message);
        if (message.action === 'performOCR') {
          const pending = deferred(); requests.push(pending); return pending.promise;
        }
        return Promise.resolve({ success: true });
      }
    }
  };
  const context = vm.createContext({
    console: { log() {}, error() {}, debug() {} }, window, document, chrome,
    OCRI18n: { init: async () => {}, t: (key) => key, errorMessage: () => 'recognition error' },
    OCRCaptureUtils: { createRequestId: (() => { let id = 0; return () => `request-${++id}`; })() },
    navigator: { clipboard: { writeText: clipboard } },
    OCRTranslationUI: { mount: () => ({ destroy() {}, notifySourceChanged() {} }) },
    OCRDraftUI: { mount: () => ({ destroy() {}, notifySourceChanged() {} }) },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    confirm: () => true, root, observations, realResult
  });
  const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  const hooks = `
    initShadowDOM = () => { shadowRoot = root; return root; };
    showProgressNotification = () => { observations.progress = true; };
    hideProgressNotification = () => { observations.progress = false; };
    showNotification = (text) => observations.notices.push(text);
    announceA11y = () => {};
    if (!realResult) showResultPopup = (...args) => observations.results.push(args);
    globalThis.harness = {
      begin: (id) => { isCancelled = false; isProcessing = true; captureSessionId = id; },
      cancel: () => { isCancelled = true; isProcessing = false; captureSessionId = null; activeRequestId = null; },
      recognize: recognizeCapturedImage,
      recover: showRecovery,
      clear: clearRecovery,
      cleanup: fullCleanup,
      result: showResultPopup,
      state: () => ({ failedImage, panel: recoveryPanel, captureSessionId, activeRequestId, isProcessing })
    };
  `;
  vm.runInContext(source.replace("  console.log('OCR文字识别助手已加载');", hooks), context);
  return { api: context.harness, sent, requests, observations, root };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('failed OCR keeps the exact crop and retry sends it under a new request without capturing again', async () => {
  const { api, sent, requests } = contentHarness();
  const original = 'data:image/png;base64,original-crop';
  api.begin('first');
  const first = api.recognize(original, 'first');
  requests[0].resolve({ success: false, errorCode: 'OCR_FAILED' });
  await first;
  assert.equal(api.state().failedImage, original);
  assert.equal(api.state().panel.querySelector('#ocr-recovery-preview').src, original);
  const oldPanel = api.state().panel;
  oldPanel.querySelector('#ocr-retry-original').fire('click');
  assert.equal(sent.filter((request) => request.action === 'performOCR').length, 2);
  assert.deepEqual(sent.filter((request) => request.action === 'performOCR').map((request) => request.imageData), [original, original]);
  assert.notEqual(sent[0].requestId, sent[1].requestId);
  assert.equal(sent.some((request) => request.action === 'captureVisibleTab'), false);
  assert.equal(api.state().failedImage, null);
  assert.equal(oldPanel.isConnected, false);
  requests[1].resolve({ success: false });
  await flush();
});

test('retry disables concurrent submissions and recovery settings preserve the retained image', async () => {
  const { api, sent, requests } = contentHarness();
  api.recover({ success: false }, 'data:image/png;base64,image');
  const panel = api.state().panel;
  await panel.querySelector('#ocr-recovery-settings').fire('click');
  assert.equal(api.state().failedImage, 'data:image/png;base64,image');
  assert.equal(sent[0].action, 'openSettings');
  const retry = panel.querySelector('#ocr-retry-original');
  retry.fire('click'); retry.fire('click');
  assert.equal(requests.length, 1);
  requests[0].resolve({ success: true, text: 'recognized', autoCopy: true });
  await flush();
  assert.equal(api.state().panel, null);
  assert.equal(api.state().isProcessing, false);
});

test('cancelled response cannot create recovery, display a result, or request automatic copy', async () => {
  const { api, requests, observations } = contentHarness();
  api.begin('cancelled');
  const task = api.recognize('image', 'cancelled');
  api.cancel();
  requests[0].resolve({ success: true, text: 'late', autoCopy: true });
  await task;
  assert.equal(api.state().panel, null);
  assert.deepEqual(observations.results, []);
});

test('late rejection from a cancelled request does not clear newer progress or replace its recovery', async () => {
  const { api, requests, observations } = contentHarness();
  api.begin('old');
  const oldTask = api.recognize('old-image', 'old');
  api.cancel();
  api.begin('new');
  const newTask = api.recognize('new-image', 'new');
  requests[0].reject(new Error('late network error'));
  await oldTask;
  assert.equal(observations.progress, true);
  assert.equal(api.state().captureSessionId, 'new');
  requests[1].resolve({ success: false });
  await newTask;
  assert.equal(api.state().failedImage, 'new-image');
});

test('capture failure without an image has a disabled retry and dismissal releases the recovery', () => {
  const { api } = contentHarness();
  api.recover({ success: false });
  assert.equal(api.state().panel.querySelector('#ocr-retry-original').disabled, true);
  assert.equal(api.state().panel.querySelector('#ocr-recovery-preview').hidden, true);
  api.state().panel.querySelector('#ocr-dismiss-recovery').fire('click');
  assert.equal(api.state().panel, null);
  assert.equal(api.state().failedImage, null);
});

test('fresh result copies once only when enabled; copy failure preserves result and manual copy button', async () => {
  const writes = [];
  const { api, root } = contentHarness({ realResult: true, clipboard: async (text) => { writes.push(text); throw new Error('denied'); } });
  api.result('disabled result', 'one', false);
  await flush();
  assert.deepEqual(writes, []);
  api.result('retained result', 'two', true);
  const popup = root.lastChild;
  await flush();
  assert.deepEqual(writes, ['retained result']);
  assert.equal(popup.querySelector('#ocr-result-text').value, 'retained result');
  assert.equal(popup.querySelector('#ocr-auto-copy-status').textContent, 'auto_copy_failed');
  assert.equal(popup.querySelector('.copy-btn').isConnected, true);
});

test('pending automatic clipboard feedback cannot overwrite feedback after manual copying', async () => {
  const firstCopy = deferred();
  let count = 0;
  const { api, root } = contentHarness({ realResult: true, clipboard: () => ++count === 1 ? firstCopy.promise : Promise.resolve() });
  api.result('result', 'id', true);
  const popup = root.lastChild;
  await popup.querySelector('.copy-btn').fire('click');
  firstCopy.reject(new Error('late copy failure'));
  await flush();
  assert.equal(popup.querySelector('#ocr-auto-copy-status').hidden, true);
  assert.equal(popup.querySelector('.copy-btn').querySelector('.btn-text').textContent, 'btn_copied');
  assert.equal(count, 2);
});

async function workspaceHarness({ clipboard = async () => {}, permission = async () => true, sendMessage = async () => ({ success: true }) } = {}) {
  const document = new Element();
  document.documentElement = new Element();
  document.getElementById = (id) => document.querySelector(`#${id}`);
  const window = new Element();
  const ports = [];
  const normalized = [];
  const draftEvents = [];
  const chrome = {
    storage: {
      local: { get: async () => ({ apiProvider: 'openai' }) },
      onChanged: { addListener() {}, removeListener() {} }
    },
    runtime: {
      openOptionsPage: async () => {},
      sendMessage,
      connect() {
        const port = {
          messages: [], disconnected: false,
          onMessage: { addListener(handler) { port.emit = handler; } },
          onDisconnect: { addListener(handler) { port.disconnectedListener = handler; } },
          postMessage(message) { port.messages.push(message); },
          disconnect() { port.disconnected = true; },
          result(response) { port.emit({ action: 'ocrResult', requestId: port.messages[0].requestId, ...response }); }
        };
        ports.push(port); return port;
      }
    }
  };
  const context = vm.createContext({
    document, window, chrome, console,
    navigator: { clipboard: { writeText: clipboard } },
    OCRI18n: { init: async () => {}, t: (key) => key, errorMessage: () => 'recognition error', applyToDom() {}, getResolvedLanguage: () => 'en' },
    OCRProviderConfig: { getProviderConfig: () => ({}), hasRequiredCredentials: () => true },
    OCRExtensionRuntime: { requestEndpointPermission: permission },
    OCRCaptureUtils: { createRequestId: (() => { let id = 0; return () => `image-${++id}`; })() },
    OCRImageUtils: { normalizeFile: async (file) => { normalized.push(file); return { dataUrl: `data:image/png;base64,${file.name}`, width: 100, height: 100 }; } },
    OCRTranslationUI: { mount: () => ({ destroy() {}, notifySourceChanged() {}, refreshLabels() {} }) },
    OCRDraftUI: { mount: (options) => ({
      destroy() {}, refresh: async () => {}, refreshLabels() {},
      notifySourceChanged(force) { draftEvents.push({ force, text: options.sourceTextarea.value, baseText: options.getSavedText() }); }
    }) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../workspace.js'), 'utf8'), context);
  await document.fire('DOMContentLoaded');
  const get = (id) => document.getElementById(id);
  for (const id of ['imagePreviewWrap', 'imageResultSection', 'imageAutoCopyStatus', 'imageRecoveryActions']) get(id).hidden = true;
  async function select(name) {
    get('imageFile').files = [{ name }];
    get('imageFile').fire('change');
    await flush();
  }
  return { get, ports, normalized, select, window, document, draftEvents };
}

test('image workspace retry reuses the retained normalized image and rejects duplicate success responses', async () => {
  const writes = [];
  const { get, ports, normalized, select } = await workspaceHarness({ clipboard: async (text) => writes.push(text) });
  await select('original');
  await get('recognizeImage').fire('click');
  ports[0].result({ success: false });
  assert.equal(get('imagePreview').src, 'data:image/png;base64,original');
  assert.equal(get('imageRecoveryActions').hidden, false);
  assert.equal(get('recognizeImage').hidden, true);
  await get('retryImageOCR').fire('click');
  assert.equal(normalized.length, 1);
  assert.equal(ports[1].messages[0].imageData, ports[0].messages[0].imageData);
  assert.notEqual(ports[1].messages[0].requestId, ports[0].messages[0].requestId);
  ports[1].result({ success: true, text: 'new text', autoCopy: true });
  ports[1].result({ success: true, text: 'duplicate', autoCopy: true });
  await flush();
  assert.deepEqual(writes, ['new text']);
  assert.equal(get('imageResultText').value, 'new text');
  assert.equal(get('imageRecoveryActions').hidden, true);
});

test('replacing an image cancels old OCR and ignores both late failures and clipboard feedback', async () => {
  const copy = deferred();
  const { get, ports, select } = await workspaceHarness({ clipboard: () => copy.promise });
  await select('old');
  await get('recognizeImage').fire('click');
  ports[0].result({ success: true, text: 'old result', autoCopy: true });
  await select('new');
  await get('recognizeImage').fire('click');
  ports[0].result({ success: false });
  copy.reject(new Error('late clipboard error'));
  await flush();
  assert.equal(get('imageAutoCopyStatus').hidden, true);
  assert.equal(get('imageRecoveryActions').hidden, true);
  assert.equal(get('cancelImageOCR').hidden, false);
  ports[1].result({ success: true, text: 'new result' });
  assert.equal(get('imageResultText').value, 'new result');
});

test('workspace cancellation while permission is pending never opens an OCR connection', async () => {
  const permission = deferred();
  const { get, ports, select } = await workspaceHarness({ permission: () => permission.promise });
  await select('pending');
  const task = get('recognizeImage').fire('click');
  get('cancelImageOCR').fire('click');
  permission.resolve(true);
  await task;
  assert.equal(ports.length, 0);
  assert.equal(get('imageImportStatus').textContent, 'image_import_cancelled');
  assert.equal(get('imagePreview').src, 'data:image/png;base64,pending');
});

test('workspace pagehide cancels the live connection and suppresses late success/automatic copy', async () => {
  const writes = [];
  const { get, ports, select, window } = await workspaceHarness({ clipboard: async (text) => writes.push(text) });
  await select('closing');
  await get('recognizeImage').fire('click');
  window.fire('pagehide');
  assert.equal(ports[0].messages.at(-1).action, 'cancel');
  assert.equal(ports[0].disconnected, true);
  ports[0].result({ success: true, text: 'late', autoCopy: true });
  await flush();
  assert.deepEqual(writes, []);
  assert.equal(get('imageResultSection').hidden, true);
});


test('editing while automatic copy is pending clears obsolete copy feedback and never copies edits', async () => {
  const pending = deferred();
  const writes = [];
  const { api, root } = contentHarness({ realResult: true, clipboard: (text) => { writes.push(text); return pending.promise; } });
  api.result('original', 'id', true);
  const popup = root.lastChild;
  popup.querySelector('#ocr-result-text').value = 'edited';
  popup.querySelector('#ocr-result-text').fire('input');
  pending.resolve();
  await flush();
  assert.equal(popup.querySelector('#ocr-auto-copy-status').hidden, true);
  assert.equal(popup.querySelector('.copy-btn').querySelector('.btn-text').textContent, 'content_btn_copy');
  assert.deepEqual(writes, ['original']);
});

test('content unload clears the retained image and cancels any active retry without restoring late failure', async () => {
  const { api, requests, sent } = contentHarness();
  api.recover({ success: false }, 'original');
  api.state().panel.querySelector('#ocr-retry-original').fire('click');
  api.cleanup();
  assert.equal(api.state().failedImage, null);
  assert.equal(api.state().panel, null);
  assert.equal(sent.at(-1).action, 'cancelOCR');
  requests[0].reject(new Error('late'));
  await flush();
  assert.equal(api.state().panel, null);
});


test('workspace saving uses its submitted snapshot while newer input stays editable and becomes a draft', async () => {
  const pending = deferred();
  const messages = [];
  const { get, ports, select, draftEvents } = await workspaceHarness({ sendMessage: (message) => {
    messages.push(message); return pending.promise;
  } });
  await select('editable');
  await get('recognizeImage').fire('click');
  ports[0].result({ success: true, text: 'original', historyId: 'saved-image' });
  const source = get('imageResultText');
  source.value = 'submitted'; source.fire('input');
  const saving = get('saveImageResult').fire('click');
  assert.equal(source.readOnly, false);
  assert.equal(get('saveImageResult').disabled, true);
  source.value = 'newer edits'; source.fire('input');
  pending.resolve({ success: true });
  await saving;
  assert.equal(messages[0].text, 'submitted');
  assert.equal(source.value, 'newer edits');
  assert.equal(get('saveImageResult').disabled, false);
  assert.deepEqual(draftEvents.at(-1), { force: true, text: 'newer edits', baseText: 'submitted' });
});

test('workspace save failure preserves newer input and unloading suppresses a delayed save result', async () => {
  const pending = deferred();
  const { get, ports, select, window } = await workspaceHarness({ sendMessage: () => pending.promise });
  await select('editable');
  await get('recognizeImage').fire('click');
  ports[0].result({ success: true, text: 'original', historyId: 'id' });
  const source = get('imageResultText');
  source.value = 'submitted'; source.fire('input');
  const saving = get('saveImageResult').fire('click');
  source.value = 'newer edits'; source.fire('input');
  pending.resolve({ success: false });
  await saving;
  assert.equal(source.value, 'newer edits');
  assert.equal(get('saveImageResult').disabled, false);
  assert.equal(get('imageResultStatus').textContent, 'content_msg_changes_save_failed');
  const second = get('saveImageResult').fire('click');
  window.fire('pagehide');
  await second;
  assert.equal(get('imageResultStatus').textContent, '');
  assert.equal(get('imageResultSection').hidden, true);
});

test('recovery gives keyboard focus to retry or reselect, and Escape dismisses the failure panel', () => {
  const { api } = contentHarness();
  api.recover({ success: false }, 'image');
  assert.equal(api.state().panel.querySelector('#ocr-retry-original').focused, true);
  api.state().panel.fire('keydown', { key: 'Escape' });
  assert.equal(api.state().panel, null);
  assert.equal(api.state().failedImage, null);
  api.recover({ success: false });
  assert.equal(api.state().panel.querySelector('#ocr-reselect-region').focused, true);
});

test('workspace Escape cancels recognition and restores keyboard focus without discarding its image', async () => {
  const { get, ports, select, document } = await workspaceHarness();
  await select('keyboard');
  await get('recognizeImage').fire('click');
  assert.equal(get('cancelImageOCR').focused, true);
  document.fire('keydown', { key: 'Escape' });
  assert.equal(ports[0].messages.at(-1).action, 'cancel');
  assert.equal(get('recognizeImage').focused, true);
  assert.equal(get('imagePreview').src, 'data:image/png;base64,keyboard');
});
