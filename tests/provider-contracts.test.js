'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const IMAGE = 'ZmFrZS1wbmc=';

function createBackgroundHarness(responseFixtures) {
  const requests = [];
  const fixtures = [...responseFixtures];
  let context;

  const storageState = { ocrHistory: [] };
  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} }
    },
    commands: { onCommand: { addListener() {} } },
    notifications: { create() {} },
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            names
              .filter((name) => Object.hasOwn(storageState, name))
              .map((name) => [name, storageState[name]])
          );
        },
        async set(values) {
          Object.assign(storageState, values);
        }
      }
    },
    tabs: {
      async captureVisibleTab() {},
      async query() { return []; }
    }
  };

  async function fetchImpl(url, options = {}) {
    requests.push({ url: String(url), options });
    const fixture = fixtures.shift();
    if (!fixture) throw new Error(`No response fixture for ${url}`);
    if (fixture instanceof Response) return fixture;
    return new Response(JSON.stringify(fixture.body ?? fixture), {
      status: fixture.status || 200,
      headers: { 'content-type': 'application/json', ...(fixture.headers || {}) }
    });
  }

  const sandbox = {
    AbortController,
    DOMException,
    Map,
    Promise,
    Response,
    URL,
    URLSearchParams,
    chrome,
    clearTimeout,
    console: { error() {}, log() {}, warn() {} },
    crypto: globalThis.crypto,
    fetch: fetchImpl,
    setTimeout
  };
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(
        fs.readFileSync(path.join(ROOT, file), 'utf8'),
        context,
        { filename: file }
      );
    }
  };

  context = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'),
    context,
    { filename: 'background.js' }
  );

  async function call(expression, config = {}) {
    context.__image = IMAGE;
    context.__config = config;
    return vm.runInContext(expression, context);
  }

  return { call, requests };
}

function jsonBody(request) {
  return JSON.parse(request.options.body);
}

test('vision chat providers send their documented endpoints, auth, model and PNG payload', async () => {
  const cases = [
    {
      expression: 'providerAdapters.recognize("claude", __image, __config)',
      config: { apiKey: 'claude-key', model: 'claude-test', language: 'auto' },
      response: { content: [{ text: 'claude text' }] },
      text: 'claude text',
      endpoint: 'https://api.anthropic.com/v1/messages',
      assertRequest(request) {
        assert.equal(request.options.headers['x-api-key'], 'claude-key');
        const body = jsonBody(request);
        assert.equal(body.model, 'claude-test');
        assert.equal(body.messages[0].content[1].source.data, IMAGE);
      }
    },
    {
      expression: 'providerAdapters.recognize("openai", __image, __config)',
      config: { apiKey: 'openai-key', model: 'gpt-5-mini', language: 'en' },
      response: { choices: [{ message: { content: 'openai text' } }] },
      text: 'openai text',
      endpoint: 'https://api.openai.com/v1/chat/completions'
    },
    {
      expression: 'providerAdapters.recognize("aliyun", __image, __config)',
      config: { apiKey: 'aliyun-key', customModel: 'qwen-vl-max', language: 'zh' },
      response: { choices: [{ message: { content: 'aliyun text' } }] },
      text: 'aliyun text',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    },
    {
      expression: 'providerAdapters.recognize("zhipu", __image, __config)',
      config: { apiKey: 'zhipu-key', model: 'glm-4v', language: 'auto' },
      response: { choices: [{ message: { content: 'zhipu text' } }] },
      text: 'zhipu text',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
    },
    {
      expression: 'providerAdapters.recognize("openai-compatible", __image, __config)',
      config: {
        apiKey: 'compatible-key',
        customEndpoint: 'https://compatible.example/v1/chat/completions',
        customModel: 'vision-model',
        language: 'auto'
      },
      response: { choices: [{ message: { content: 'compatible text' } }] },
      text: 'compatible text',
      endpoint: 'https://compatible.example/v1/chat/completions'
    }
  ];

  for (const providerCase of cases) {
    const harness = createBackgroundHarness([providerCase.response]);
    const text = await harness.call(providerCase.expression, providerCase.config);
    assert.equal(text, providerCase.text);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].url, providerCase.endpoint);

    if (providerCase.assertRequest) {
      providerCase.assertRequest(harness.requests[0]);
      continue;
    }
    assert.equal(
      harness.requests[0].options.headers.Authorization,
      `Bearer ${providerCase.config.apiKey}`
    );
    const body = jsonBody(harness.requests[0]);
    assert.equal(
      body.model,
      providerCase.config.model || providerCase.config.customModel
    );
    assert.match(
      body.messages[0].content[1].image_url.url,
      /^data:image\/png;base64,/
    );
  }
});

test('Baidu exchanges credentials once and sends an encoded image to general_basic', async () => {
  const harness = createBackgroundHarness([
    { access_token: 'baidu-token', expires_in: 3600 },
    { words_result: [{ words: '百度' }, { words: '文本' }] }
  ]);

  const text = await harness.call('providerAdapters.recognize("baidu", __image, __config)', {
    apiKey: 'baidu-key',
    customSecret: 'baidu-secret',
    language: 'zh'
  });

  assert.equal(text, '百度\n文本');
  assert.equal(harness.requests.length, 2);
  assert.match(harness.requests[0].url, /\/oauth\/2\.0\/token\?/);
  assert.match(harness.requests[0].url, /client_id=baidu-key/);
  assert.match(harness.requests[1].url, /\/ocr\/v1\/general_basic\?access_token=baidu-token/);
  assert.equal(
    harness.requests[1].options.headers['Content-Type'],
    'application/x-www-form-urlencoded'
  );
  assert.match(harness.requests[1].options.body, /image=ZmFrZS1wbmc%3D/);
});

test('Baidu routes an explicitly selected handwriting mode to its matching endpoint', async () => {
  const harness = createBackgroundHarness([
    { access_token: 'baidu-token', expires_in: 3600 },
    { words_result: [{ words: '手写文本' }] }
  ]);

  const text = await harness.call('providerAdapters.recognize("baidu", __image, __config)', {
    apiKey: 'baidu-key',
    customSecret: 'baidu-secret',
    mode: 'handwriting',
    language: 'zh'
  });

  assert.equal(text, '手写文本');
  assert.match(harness.requests[1].url, /\/ocr\/v1\/handwriting\?/);
});

test('Baidu connection test accepts a recognized API path when its synthetic image returns 216630', async () => {
  const harness = createBackgroundHarness([
    { access_token: 'baidu-token', expires_in: 3600 },
    { error_code: 216630, error_msg: 'recognize error' }
  ]);

  await harness.call(
    'recognitionService.testConnection(__config, (value) => { globalThis.__testResponse = value; })',
    {
      apiProvider: 'baidu',
      apiKey: 'baidu-key',
      customSecret: 'baidu-secret'
    }
  );
  const response = await harness.call('__testResponse');

  assert.equal(response.success, true);
  assert.equal(response.warningCode, 'BAIDU_TEST_IMAGE_RECOGNIZE_ERROR');
  assert.equal(harness.requests.length, 2);
});

test('Custom supports Responses mode, no auth, and a configured response path', async () => {
  const harness = createBackgroundHarness([
    { payload: { recognized: 'custom response text' } }
  ]);

  const text = await harness.call('providerAdapters.recognize("custom", __image, __config)', {
    apiKey: '',
    authMode: 'none',
    customEndpoint: 'http://localhost:11434/v1/responses',
    customModel: '',
    language: 'auto',
    requestMode: 'responses',
    responsePath: 'payload.recognized'
  });

  assert.equal(text, 'custom response text');
  assert.equal(harness.requests[0].options.headers.Authorization, undefined);
  const body = jsonBody(harness.requests[0]);
  assert.equal(body.model, undefined);
  assert.equal(body.input[0].content[0].type, 'input_text');
  assert.equal(body.input[0].content[1].type, 'input_image');
  assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
});

test('all provider adapters reject empty or unknown text shapes', async () => {
  const cases = [
    ['providerAdapters.recognize("claude", __image, __config)', { apiKey: 'key' }, { content: [] }],
    ['providerAdapters.recognize("openai", __image, __config)', { apiKey: 'key' }, { choices: [] }],
    [
      'providerAdapters.recognize("openai-compatible", __image, __config)',
      {
        apiKey: 'key',
        customEndpoint: 'https://compatible.example/v1/chat/completions'
      },
      { unexpected: true }
    ],
    [
      'providerAdapters.recognize("custom", __image, __config)',
      {
        apiKey: '',
        authMode: 'none',
        customEndpoint: 'http://localhost:11434/v1/chat/completions'
      },
      { result: '   ' }
    ]
  ];

  for (const [expression, config, response] of cases) {
    const harness = createBackgroundHarness([response]);
    await assert.rejects(
      harness.call(expression, config),
      /INVALID_OCR_RESULT|EMPTY_OCR_RESULT/
    );
  }
});

test('Claude returns visible text when adaptive thinking blocks come first', async () => {
  const harness = createBackgroundHarness([{
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: 'internal reasoning' },
      { type: 'text', text: 'VISIBLE OCR TEXT' }
    ]
  }]);

  assert.equal(
    await harness.call('providerAdapters.recognize("claude", __image, __config)', { apiKey: 'key' }),
    'VISIBLE OCR TEXT'
  );
});

test('provider adapters reject truncated OCR output instead of saving partial text', async () => {
  const claude = createBackgroundHarness([{
    stop_reason: 'max_tokens',
    content: [{ type: 'text', text: 'partial' }]
  }]);
  await assert.rejects(
    claude.call('providerAdapters.recognize("claude", __image, __config)', { apiKey: 'key' }),
    (error) => error.code === 'OCR_RESULT_TRUNCATED'
  );

  const openai = createBackgroundHarness([{
    choices: [{ finish_reason: 'length', message: { content: 'partial' } }]
  }]);
  await assert.rejects(
    openai.call('providerAdapters.recognize("openai", __image, __config)', { apiKey: 'key' }),
    (error) => error.code === 'OCR_RESULT_TRUNCATED'
  );
});
