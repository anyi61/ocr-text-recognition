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

function createRuntime(storedLanguage, browserLanguage = 'en-US') {
  const saved = [];
  const context = vm.createContext({
    chrome: {
      i18n: { getUILanguage: () => browserLanguage },
      runtime: { getURL: (value) => value },
      storage: {
        local: {
          async get() { return { uiLanguage: storedLanguage }; },
          async set(value) { saved.push(value); }
        },
        onChanged: { addListener() {} }
      }
    },
    console: { error() {} },
    CustomEvent: class CustomEvent {},
    fetch: async () => ({
      ok: true,
      async json() { return { sample: { message: 'sample' } }; }
    })
  });
  vm.runInContext(SOURCE, context, { filename: 'i18n-runtime.js' });
  return {
    runtime: vm.runInContext('OCRI18n', context),
    saved
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
