'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../i18n-runtime.js'),
  'utf8'
);

function createRuntime(storedLanguage, browserLanguage = 'en-US', options = {}) {
  const saved = [];
  const storageListeners = [];
  const context = vm.createContext({
    ...(options.protocol ? { location: { protocol: options.protocol } } : {}),
    chrome: {
      i18n: { getUILanguage: () => browserLanguage },
      runtime: { getURL: (value) => value, async sendMessage(message) {
        saved.push(message.preferences);
        return options.sendMessage ? options.sendMessage(message) : { success: true };
      } },
      storage: {
        local: {
          async get() { return options.getStorage ? options.getStorage() : { uiLanguage: storedLanguage }; },
          async set(value) { saved.push(value); }
        },
        onChanged: { addListener(listener) { storageListeners.push(listener); } }
      }
    },
    console: { error() {} },
    CustomEvent: class CustomEvent {},
    fetch: async (url) => {
      await options.beforeDictionaryLoad?.(url);
      return {
        ok: true,
        async json() {
          const locale = String(url).includes('/zh_CN/') ? 'zh_CN' : 'en';
          return JSON.parse(fs.readFileSync(
            path.resolve(__dirname, `../_locales/${locale}/messages.json`),
            'utf8'
          ));
        }
      };
    }
  });
  vm.runInContext(SOURCE, context, { filename: 'i18n-runtime.js' });
  return {
    runtime: vm.runInContext('OCRI18n', context),
    saved,
    emitLanguage(value) {
      storageListeners.forEach((listener) => listener({ uiLanguage: { newValue: value } }, 'local'));
    }
  };
}

test('invalid stored and requested UI languages fall back to auto safely', async () => {
  const { runtime, saved } = createRuntime('../../unexpected', 'zh-CN');
  await runtime.init();

  assert.equal(runtime.getLanguageSetting(), 'auto');
  assert.equal(runtime.getResolvedLanguage(), 'zh_CN');

  await runtime.setLanguage('unsupported');
  assert.equal(runtime.getLanguageSetting(), 'auto');
  assert.equal(runtime.getResolvedLanguage(), 'zh_CN');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].uiLanguage, 'auto');
});

test('stable background error codes resolve through localized message keys', async () => {
  const { runtime } = createRuntime('en', 'en-US');
  await runtime.init();

  assert.equal(
    runtime.errorMessage({ errorCode: 'REQUEST_TIMEOUT', error: '请求超时' }),
    'The request timed out. Check your network and try again.'
  );
  assert.equal(
    runtime.errorMessage({ errorCode: 'UNKNOWN', error: 'provider detail' }),
    'provider detail'
  );
});

test('failed language persistence rejects without changing the confirmed interface language', async () => {
  const { runtime } = createRuntime('en', 'en-US', { sendMessage: async () => ({ success: false }) });
  await runtime.init();
  await assert.rejects(runtime.setLanguage('zh_CN'), { code: 'SETTINGS_SAVE_FAILED' });
  assert.equal(runtime.getLanguageSetting(), 'en');
  assert.equal(runtime.getResolvedLanguage(), 'en');
});

test('late language save replies cannot restore an older selection', async () => {
  const pending = [];
  const { runtime, saved } = createRuntime('en', 'en-US', {
    sendMessage: () => new Promise((resolve) => pending.push(resolve))
  });
  await runtime.init();
  const first = runtime.setLanguage('zh_CN');
  const second = runtime.setLanguage('en');
  pending[1]({ success: true });
  await second;
  pending[0]({ success: true });
  await first;
  assert.equal(runtime.getLanguageSetting(), 'en');
  assert.deepEqual(saved.map((patch) => patch.uiLanguage), ['zh_CN', 'en']);
});

for (const fails of [false, true]) {
  test(`a language notification during the initial storage read survives its ${fails ? 'failure' : 'stale result'}`, async () => {
    let finishRead;
    const pendingRead = new Promise((resolve, reject) => {
      finishRead = () => fails ? reject(new Error('Storage unavailable')) : resolve({ uiLanguage: 'en' });
    });
    const { runtime, emitLanguage } = createRuntime('en', 'en-US', { getStorage: () => pendingRead });
    const initializing = runtime.init();
    emitLanguage('zh_CN');
    finishRead();
    await initializing;
    assert.equal(runtime.getLanguageSetting(), 'zh_CN');
    assert.equal(runtime.getResolvedLanguage(), 'zh_CN');
  });
}

test('language changes during dictionary initialization are not missed', async () => {
  let releaseDictionary;
  let dictionaryStarted;
  const pendingDictionary = new Promise((resolve) => { releaseDictionary = resolve; });
  const dictionaryLoading = new Promise((resolve) => { dictionaryStarted = resolve; });
  const { runtime, emitLanguage } = createRuntime('en', 'en-US', {
    beforeDictionaryLoad: () => { dictionaryStarted(); return pendingDictionary; }
  });
  const initializing = runtime.init();
  await dictionaryLoading;
  emitLanguage('zh_CN');
  releaseDictionary();
  await initializing;
  assert.equal(runtime.getLanguageSetting(), 'zh_CN');
  assert.equal(runtime.getResolvedLanguage(), 'zh_CN');
  assert.equal(runtime.t('btn_settings'), '设置');
});

test('content initialization keeps using the background bridge without direct storage access or listeners', async () => {
  let storageReads = 0;
  const { runtime, emitLanguage } = createRuntime('en', 'en-US', {
    protocol: 'https:',
    getStorage: () => { storageReads += 1; return { uiLanguage: 'en' }; },
    sendMessage: async (message) => {
      assert.equal(message.action, 'getContentPreferences');
      return { uiLanguage: 'zh_CN' };
    }
  });
  await runtime.init();
  emitLanguage('en');
  assert.equal(storageReads, 0);
  assert.equal(runtime.getLanguageSetting(), 'zh_CN');
});
