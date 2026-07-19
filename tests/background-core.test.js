const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRecognitionPrompt,
  getBaiduLanguageType,
  createRequestRegistry,
  isAbortError,
  saveHistoryRecord
} = require('../background-core.js');

test('buildRecognitionPrompt preserves auto prompt unchanged', () => {
  assert.equal(buildRecognitionPrompt('Extract only text', 'auto'), 'Extract only text');
});

test('buildRecognitionPrompt applies every configured recognition language', () => {
  for (const language of ['zh', 'en', 'ja', 'ko']) {
    const result = buildRecognitionPrompt('OCR', language);
    assert.match(result, /^OCR\n\n/);
    assert.ok(result.length > 5);
  }
});

test('getBaiduLanguageType maps supported UI languages', () => {
  assert.deepEqual(
    ['auto', 'zh', 'en', 'ja', 'ko'].map(getBaiduLanguageType),
    ['CHN_ENG', 'CHN_ENG', 'ENG', 'JAP', 'KOR']
  );
});

test('request registry aborts and removes an active request', () => {
  const registry = createRequestRegistry();
  const controller = registry.start('request-1');

  assert.equal(registry.has('request-1'), true);
  assert.equal(controller.signal.aborted, false);
  assert.equal(registry.cancel('request-1'), true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(registry.has('request-1'), false);
});

test('starting the same request id aborts the previous controller', () => {
  const registry = createRequestRegistry();
  const first = registry.start('request-1');
  const second = registry.start('request-1');

  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
});

test('finishing a stale duplicate request cannot remove its replacement', () => {
  const registry = createRequestRegistry();
  const first = registry.start('request-1');
  const second = registry.start('request-1');

  assert.equal(registry.finish('request-1', first), false);
  assert.equal(registry.has('request-1'), true);
  assert.equal(registry.cancel('request-1'), true);
  assert.equal(second.signal.aborted, true);
});

test('isAbortError recognizes abort failures', () => {
  assert.equal(isAbortError(new DOMException('cancelled', 'AbortError')), true);
  assert.equal(isAbortError(new Error('network')), false);
});

test('history persistence rolls back when cancellation happens during storage write', async () => {
  const controller = new AbortController();
  const state = { ocrHistory: [] };
  const storage = {
    async get() {
      return structuredClone(state);
    },
    async set(value) {
      Object.assign(state, structuredClone(value));
      if (state.ocrHistory.length > 0) {
        controller.abort();
      }
    }
  };

  await assert.rejects(
    saveHistoryRecord(storage, 'must not persist', controller.signal, 123),
    (error) => error.name === 'AbortError'
  );
  assert.deepEqual(state.ocrHistory, []);
});
