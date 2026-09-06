'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../background-core.js');
const requestRuntime = require('../request-runtime.js');
const { create: createTransport } = require('../providers/transport.js');
const { create: createBaidu } = require('../providers/baidu.js');

function dependencies(fetch) {
  const deps = { core, requestRuntime, fetch };
  return { ...deps, transport: createTransport(deps) };
}
const config = { apiKey: 'test-key', customSecret: 'test-secret', language: 'zh' };
const json = data => new Response(JSON.stringify(data));

test('Baidu modes reuse tokens within an instance and isolate tokens between instances and credentials', async () => {
  let authRequests = 0;
  const ocrUrls = [];
  const deps = dependencies(async url => {
    if (url.includes('/oauth/')) return json({ access_token: `token-${++authRequests}`, expires_in: 3600 });
    ocrUrls.push(url);
    return json({ words_result: [{ words: '文字' }] });
  });
  const first = createBaidu(deps);
  for (const mode of ['general_basic', 'accurate_basic', 'handwriting']) {
    assert.equal(await first.recognize('image', { ...config, mode }), '文字');
    assert.match(ocrUrls.at(-1), new RegExp(`/ocr/v1/${mode}\\?access_token=token-1$`));
  }
  assert.equal(authRequests, 1);
  await createBaidu(deps).recognize('image', config);
  assert.equal(authRequests, 2, 'a new instance must acquire its own token');
  await first.recognize('image', { ...config, customSecret: 'another-test-secret' });
  assert.equal(authRequests, 3, 'different credentials must acquire another token');
  await assert.rejects(first.recognize('image', { ...config, mode: 'invalid' }), { code: 'INVALID_PROVIDER_CONFIG' });
  assert.equal(authRequests, 3);
});

test('Baidu shares pending authentication while cancellation only ends the cancelled waiter', async () => {
  let resolveToken;
  let tokenSignal;
  let authRequests = 0;
  let ocrRequests = 0;
  const adapter = createBaidu(dependencies(async (url, options) => {
    if (url.includes('/oauth/')) {
      authRequests++;
      tokenSignal = options.signal;
      return new Promise(resolve => { resolveToken = resolve; });
    }
    ocrRequests++;
    return json({ words_result: [{ words: 'surviving request' }] });
  }));
  const controller = new AbortController();
  const cancelled = adapter.recognize('first', config, controller.signal);
  const survivor = adapter.recognize('second', config);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(tokenSignal.aborted, false);
  resolveToken(json({ access_token: 'shared-token', expires_in: 3600 }));
  assert.equal(await survivor, 'surviving request');
  assert.equal(authRequests, 1);
  assert.equal(ocrRequests, 1);
});

test('Baidu retries authentication after rejected or expired cached tokens', async () => {
  let authRequests = 0;
  const adapter = createBaidu(dependencies(async url => {
    if (!url.includes('/oauth/')) return json({ words_result: [{ words: 'text' }] });
    authRequests++;
    if (authRequests === 1) return json({ error: 'invalid_client' });
    return json({ access_token: 'short-lived', expires_in: 30 });
  }));
  await assert.rejects(adapter.recognize('image', config), /百度认证失败/);
  await adapter.recognize('image', config);
  await adapter.recognize('image', config);
  assert.equal(authRequests, 3);
});

test('all chat adapters retain truncation and caller cancellation contracts', async () => {
  for (const id of ['claude', 'openai', 'openai-compatible', 'custom', 'aliyun', 'zhipu']) {
    const { create } = require(`../providers/${id}.js`);
    const response = id === 'claude'
      ? { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] }
      : { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] };
    const providerConfig = { ...config, customEndpoint: 'https://example.test/ocr' };
    const truncated = create(dependencies(async () => json(response)));
    await assert.rejects(truncated.recognize('image', providerConfig), { code: 'OCR_RESULT_TRUNCATED' }, id);
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const adapter = create(dependencies((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
      entered();
    })));
    const controller = new AbortController();
    const pending = adapter.recognize('image', providerConfig, controller.signal);
    await started;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' }, id);
  }
});

test('transport preserves coded timeout, authentication and network errors', async () => {
  for (const [failure, expected] of [
    [Object.assign(new Error('timed out'), { code: 'REQUEST_TIMEOUT' }), 'REQUEST_TIMEOUT'],
    [new TypeError('network unavailable'), 'NETWORK_ERROR'],
    [Object.assign(new Error('HTTP 401'), { status: 401 }), 'API_ERROR']
  ]) {
    const transport = createTransport({
      core, fetch() {},
      requestRuntime: { async fetchJsonWithPolicy() { throw failure; } }
    });
    await assert.rejects(transport.apiRequest('https://example.test', {}, {}, 'API', undefined), { code: expected });
  }
});
