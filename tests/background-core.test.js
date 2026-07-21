const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRecognitionPrompt,
  getBaiduLanguageType,
  createCredentialFingerprint,
  createRequestRegistry,
  isAbortError,
  isSameTabIdentity,
  extractClaudeText,
  assertOcrResponseComplete,
  sanitizeSourceUrl,
  appendHistoryBestEffort
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

test('credential cache fingerprints are stable without containing credentials', () => {
  const fingerprint = createCredentialFingerprint('api-secret', 'client-secret');
  assert.equal(fingerprint, createCredentialFingerprint('api-secret', 'client-secret'));
  assert.notEqual(fingerprint, createCredentialFingerprint('other-key', 'client-secret'));
  assert.doesNotMatch(fingerprint, /api-secret|client-secret/);
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

test('capture sender remains the active tab only when both tab ids match', () => {
  assert.equal(isSameTabIdentity({ id: 42 }, { id: 42 }), true);
  assert.equal(isSameTabIdentity({ id: 42 }, { id: 43 }), false);
  assert.equal(isSameTabIdentity({ id: 42 }, null), false);
});

test('Claude text extraction skips thinking blocks and joins visible text blocks', () => {
  assert.equal(extractClaudeText({
    content: [
      { type: 'thinking', thinking: 'hidden reasoning' },
      { type: 'text', text: 'first line' },
      { type: 'text', text: 'second line' }
    ]
  }), 'first line\nsecond line');
});

test('completion validation rejects truncated provider responses', () => {
  assert.throws(
    () => assertOcrResponseComplete('claude', { stop_reason: 'max_tokens' }),
    (error) => error.code === 'OCR_RESULT_TRUNCATED'
  );
  assert.throws(
    () => assertOcrResponseComplete('openai', {
      choices: [{ finish_reason: 'length' }]
    }),
    (error) => error.code === 'OCR_RESULT_TRUNCATED'
  );
  assert.doesNotThrow(() => assertOcrResponseComplete('openai', {
    choices: [{ finish_reason: 'stop' }]
  }));
});

test('history source URLs retain only a non-sensitive origin', () => {
  assert.equal(
    sanitizeSourceUrl('https://example.test/private/report?token=secret#section'),
    'https://example.test'
  );
  assert.equal(sanitizeSourceUrl('file:///Users/person/secret.txt'), 'file://');
  assert.equal(sanitizeSourceUrl('not a url'), '');
});

test('history persistence failure does not discard a successful OCR result', async () => {
  const result = await appendHistoryBestEffort({
    async append() {
      throw new Error('quota exceeded');
    }
  }, { text: 'paid OCR result' });

  assert.deepEqual(result, {
    historyId: null,
    warningCode: 'HISTORY_SAVE_FAILED'
  });
});

test('history persistence still propagates cancellation', async () => {
  await assert.rejects(
    appendHistoryBestEffort({
      async append() {
        throw new DOMException('cancelled', 'AbortError');
      }
    }, { text: 'cancelled result' }),
    (error) => error.name === 'AbortError'
  );
});
