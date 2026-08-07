'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_POLICY,
  fetchJsonWithPolicy,
  normalizeOcrText,
  buildCustomHeaders,
  buildCustomRequestBody,
  extractCustomText
} = require('../request-runtime.js');

test('default request deadline stays below the service worker fetch boundary', () => {
  assert.equal(DEFAULT_POLICY.timeoutMs, 27_000);
  assert.ok(DEFAULT_POLICY.timeoutMs < 30_000);
});

test('retries one transient 503 then succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? new Response('busy', { status: 503 })
      : Response.json({ ok: true });
  };

  const result = await fetchJsonWithPolicy(fetchImpl, { url: 'https://example.test' }, {
    timeoutMs: 1_000,
    maxAttempts: 2,
    retryStatuses: [429, 502, 503, 504],
    retryDelayMs: 0
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test('retries a network failure before receiving a response', async () => {
  let calls = 0;
  const result = await fetchJsonWithPolicy(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return Response.json({ ok: true });
  }, { url: 'https://example.test' }, { maxAttempts: 2, retryDelayMs: 0 });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test('does not retry a non-retryable HTTP response', async () => {
  let calls = 0;
  await assert.rejects(
    fetchJsonWithPolicy(async () => {
      calls += 1;
      return new Response('bad request', { status: 400 });
    }, { url: 'https://example.test' }, { maxAttempts: 2, retryDelayMs: 0 }),
    (error) => error.status === 400
  );
  assert.equal(calls, 1);
});

test('does not expose untrusted remote error messages', async () => {
  await assert.rejects(
    fetchJsonWithPolicy(
      async () => Response.json({
        error: { message: 'Authorization: Bearer should-never-leak' }
      }, { status: 401 }),
      { url: 'https://example.test' },
      { maxAttempts: 1 }
    ),
    (error) => error.status === 401
      && error.message === 'HTTP 401'
      && !error.message.includes('should-never-leak')
  );
});

test('reports a timeout separately from caller cancellation', async () => {
  await assert.rejects(
    fetchJsonWithPolicy(
      (_url, init) => new Promise((_, reject) => init.signal.addEventListener(
        'abort',
        () => reject(new DOMException('aborted by fetch', 'AbortError'))
      )),
      { url: 'https://example.test' },
      { timeoutMs: 5, maxAttempts: 1 }
    ),
    (error) => error.code === 'REQUEST_TIMEOUT'
  );

  const controller = new AbortController();
  const pending = fetchJsonWithPolicy(
    (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
    { url: 'https://example.test', signal: controller.signal },
    { timeoutMs: 1_000, maxAttempts: 2 }
  );
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});

test('the request deadline also aborts Retry-After waiting', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    fetchJsonWithPolicy(
      async () => new Response('', {
        status: 429,
        headers: { 'retry-after': '0.2' }
      }),
      { url: 'https://example.test' },
      { timeoutMs: 10, maxAttempts: 2, maxRetryDelayMs: 1_000 }
    ),
    (error) => error.code === 'REQUEST_TIMEOUT'
  );
  assert.ok(Date.now() - startedAt < 100, 'timeout should interrupt retry sleep');
});

test('caps an untrusted Retry-After value before retrying', async () => {
  let calls = 0;
  const startedAt = Date.now();
  const result = await fetchJsonWithPolicy(async () => {
    calls += 1;
    return calls === 1
      ? new Response('', { status: 503, headers: { 'retry-after': '9999' } })
      : Response.json({ ok: true });
  }, { url: 'https://example.test' }, {
    timeoutMs: 1_000,
    maxAttempts: 2,
    maxRetryDelayMs: 5
  });

  assert.deepEqual(result, { ok: true });
  assert.ok(Date.now() - startedAt < 100);
});

test('rejects empty OCR output and accepts trimmed text', () => {
  assert.throws(() => normalizeOcrText('   '), /EMPTY_OCR_RESULT/);
  assert.equal(normalizeOcrText('  readable text\n'), 'readable text');
  assert.throws(() => normalizeOcrText({ text: 'unknown object' }), /INVALID_OCR_RESULT/);
});

test('builds configurable authentication headers', () => {
  assert.deepEqual(
    buildCustomHeaders({ authMode: 'none', apiKey: '' }),
    { 'Content-Type': 'application/json' }
  );
  assert.deepEqual(
    buildCustomHeaders({ authMode: 'api-key', apiKey: 'secret' }),
    { 'Content-Type': 'application/json', 'api-key': 'secret' }
  );
  assert.deepEqual(
    buildCustomHeaders({
      authMode: 'custom-header',
      headerName: 'X-OCR-Key',
      apiKey: 'secret'
    }),
    { 'Content-Type': 'application/json', 'X-OCR-Key': 'secret' }
  );
  assert.deepEqual(
    buildCustomHeaders({ authMode: 'bearer', apiKey: 'secret' }),
    { 'Content-Type': 'application/json', Authorization: 'Bearer secret' }
  );
  assert.throws(
    () => buildCustomHeaders({ authMode: 'custom-header', headerName: 'Origin', apiKey: 'secret' }),
    /Header 名称/
  );
});

test('builds Responses API image input without an empty optional model', () => {
  const body = buildCustomRequestBody({
    requestMode: 'responses',
    model: '',
    prompt: 'Read this',
    base64Image: 'abc123'
  });

  assert.equal('model' in body, false);
  assert.equal(body.input[0].content[0].type, 'input_text');
  assert.equal(body.input[0].content[1].type, 'input_image');
  assert.equal(body.input[0].content[1].image_url, 'data:image/png;base64,abc123');
});

test('extracts custom text from a response path or known response formats', () => {
  assert.equal(
    extractCustomText({ payload: { result: 'Configured path' } }, 'payload.result'),
    'Configured path'
  );
  assert.equal(
    extractCustomText({
      output: [{ content: [{ type: 'output_text', text: 'Responses text' }] }]
    }),
    'Responses text'
  );
  assert.throws(
    () => extractCustomText({ payload: { result: '' } }, 'payload.result'),
    /EMPTY_OCR_RESULT/
  );
});

test('builds a Chat Completions request by default', () => {
  const body = buildCustomRequestBody({ model: 'vision', prompt: 'Read this', base64Image: 'abc123' });
  assert.equal(body.model, 'vision');
  assert.equal(body.messages[0].content[0].type, 'text');
  assert.equal(body.messages[0].content[1].type, 'image_url');
  assert.equal(body.messages[0].content[1].image_url.url, 'data:image/png;base64,abc123');
});
