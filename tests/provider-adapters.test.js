'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS, create } = require('../providers/registry.js');

function createRegistry() {
  const calls = [];
  const implementations = Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    async (image, config, signal) => {
      calls.push({ provider, image, config, signal });
      return `${provider}-result`;
    }
  ]));
  return {
    calls,
    registry: create(implementations, {
      migrateRetiredModel(provider, model) {
        return provider === 'openai' && model === 'retired' ? 'current' : model;
      }
    })
  };
}

test('registry exposes every supported provider through one recognition path', async () => {
  const { registry, calls } = createRegistry();
  for (const provider of PROVIDERS) {
    const config = registry.normalizeConfig(provider, { apiKey: 'key' }, { language: 'en' });
    assert.equal(await registry.recognize(provider, 'image', config), `${provider}-result`);
  }
  assert.deepEqual(calls.map((call) => call.provider), PROVIDERS);
});

test('normalization maps storage fields to provider runtime contracts', () => {
  const { registry } = createRegistry();
  assert.deepEqual(registry.normalizeConfig('baidu', {
    apiKey: 'client', secret: 'secret', mode: 'handwriting'
  }), {
    apiProvider: 'baidu',
    apiKey: 'client',
    customSecret: 'secret',
    mode: 'handwriting'
  });
  assert.throws(
    () => registry.normalizeConfig('baidu', { mode: 'unsupported' }),
    (error) => error.code === 'INVALID_PROVIDER_CONFIG'
  );
  assert.deepEqual(registry.normalizeConfig('custom', {
    endpoint: 'https://example.test/ocr',
    authMode: 'none'
  }), {
    apiProvider: 'custom',
    customEndpoint: 'https://example.test/ocr',
    requestMode: 'chat-completions',
    authMode: 'none',
    headerName: '',
    responsePath: ''
  });
});

test('Baidu keeps its connection-test-only recognition warning', () => {
  const { registry } = createRegistry();
  assert.deepEqual(registry.interpretConnectionError('baidu', { code: 216630 }), {
    success: true,
    warningCode: 'BAIDU_TEST_IMAGE_RECOGNIZE_ERROR'
  });
  assert.equal(registry.interpretConnectionError('baidu', { code: 110 }), null);
});

test('unknown providers fail with a stable code', () => {
  const { registry } = createRegistry();
  assert.throws(
    () => registry.get('unknown'),
    (error) => error.code === 'UNKNOWN_PROVIDER'
  );
});
