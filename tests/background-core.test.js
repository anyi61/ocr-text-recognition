const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRecognitionPrompt,
  getBaiduLanguageType,
  createCredentialFingerprint,
  createRequestRegistry,
  isAbortError
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
