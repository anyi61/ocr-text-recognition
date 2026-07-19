const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getStorageKey,
  getProviderConfig,
  hasRequiredCredentials,
  redactApiConfigs,
  getEndpointOriginPattern,
  migrateRetiredModel,
  mergeImportedApiConfigs,
  buildLegacySettings,
  normalizeConfig,
  isValidHeaderName
} = require('../provider-config.js');

test('maps the OpenAI-compatible provider to its camelCase storage key', () => {
  assert.equal(getStorageKey('openai-compatible'), 'openaiCompatible');
  assert.deepEqual(
    getProviderConfig({
      openaiCompatible: {
        endpoint: 'https://example.com/v1/chat/completions',
        apiKey: 'compatible-secret',
        model: 'vision-model'
      }
    }, 'openai-compatible'),
    {
      endpoint: 'https://example.com/v1/chat/completions',
      apiKey: 'compatible-secret',
      model: 'vision-model',
      authMode: 'bearer',
      requestMode: 'chat-completions'
    }
  );
});

test('requires both Baidu credentials', () => {
  assert.equal(hasRequiredCredentials({
    baidu: { apiKey: 'client-id', secret: '' }
  }, 'baidu'), false);
  assert.equal(hasRequiredCredentials({
    baidu: { apiKey: 'client-id', secret: 'client-secret' }
  }, 'baidu'), true);
});

test('requires endpoint, model, and API key for OpenAI-compatible providers', () => {
  const complete = {
    endpoint: 'https://example.com/v1/chat/completions',
    apiKey: 'secret',
    model: 'vision-model'
  };

  assert.equal(hasRequiredCredentials({ openaiCompatible: complete }, 'openai-compatible'), true);
  assert.equal(hasRequiredCredentials({ openaiCompatible: { ...complete, endpoint: '' } }, 'openai-compatible'), false);
  assert.equal(hasRequiredCredentials({ openaiCompatible: { ...complete, model: '' } }, 'openai-compatible'), false);
  assert.equal(hasRequiredCredentials({ openaiCompatible: { ...complete, apiKey: '' } }, 'openai-compatible'), false);
});

test('custom provider accepts no-auth and no-model configuration', () => {
  assert.equal(hasRequiredCredentials({
    custom: {
      endpoint: 'http://localhost:11434/v1/chat/completions',
      authMode: 'none',
      requestMode: 'chat-completions'
    }
  }, 'custom'), true);
});

test('custom-header auth requires a safe header name and API key', () => {
  const base = {
    endpoint: 'https://example.test/ocr',
    authMode: 'custom-header',
    apiKey: 'secret'
  };
  assert.equal(hasRequiredCredentials({ custom: { ...base, headerName: '' } }, 'custom'), false);
  assert.equal(hasRequiredCredentials({ custom: { ...base, headerName: 'Host' } }, 'custom'), false);
  assert.equal(hasRequiredCredentials({ custom: { ...base, headerName: 'X-OCR-Key' } }, 'custom'), true);
  assert.equal(isValidHeaderName('X-OCR-Key'), true);
  assert.equal(isValidHeaderName('Content-Length'), false);
  assert.equal(isValidHeaderName('bad header'), false);
});

test('normalizes legacy configurable provider defaults', () => {
  assert.deepEqual(normalizeConfig('custom', { endpoint: 'http://localhost:11434' }), {
    endpoint: 'http://localhost:11434',
    authMode: 'bearer',
    requestMode: 'chat-completions'
  });
});

test('accepts the legacy Claude API key', () => {
  assert.equal(hasRequiredCredentials({}, 'claude', { apiKey: 'legacy-secret' }), true);
  assert.equal(hasRequiredCredentials({}, 'claude', { apiKey: '  ' }), false);
});

test('redacts credentials without mutating the source configuration', () => {
  const source = {
    claude: { apiKey: 'claude-secret', model: 'claude-model' },
    baidu: { apiKey: 'baidu-key', secret: 'baidu-secret' },
    custom: {
      endpoint: 'https://example.com/v1/chat/completions',
      apiKey: 'custom-secret',
      model: 'custom-model'
    }
  };

  const redacted = redactApiConfigs(source);

  assert.deepEqual(redacted, {
    claude: { model: 'claude-model' },
    baidu: {},
    custom: {
      endpoint: 'https://example.com/v1/chat/completions',
      model: 'custom-model'
    }
  });
  assert.equal(source.claude.apiKey, 'claude-secret');
  assert.equal(source.baidu.secret, 'baidu-secret');
});

test('builds an optional host permission pattern from a custom endpoint', () => {
  assert.equal(
    getEndpointOriginPattern('https://ocr.example.com:8443/v1/chat/completions'),
    'https://ocr.example.com:8443/*'
  );
  assert.equal(
    getEndpointOriginPattern('http://127.0.0.1:3000/ocr'),
    'http://127.0.0.1:3000/*'
  );
  assert.equal(getEndpointOriginPattern('file:///tmp/ocr'), null);
  assert.equal(getEndpointOriginPattern('not a URL'), null);
});

test('migrates only known retired first-party model ids', () => {
  assert.equal(migrateRetiredModel('claude', 'claude-3-opus-20240229'), 'claude-sonnet-5');
  assert.equal(migrateRetiredModel('openai', 'gpt-4o'), 'gpt-5-mini');
  assert.equal(migrateRetiredModel('openai-compatible', 'gpt-4o'), 'gpt-4o');
  assert.equal(migrateRetiredModel('claude', 'user-custom-model'), 'user-custom-model');
});

test('redacted imports preserve modern and legacy credentials', () => {
  const merged = mergeImportedApiConfigs(
    { openai: { apiKey: 'modern-secret', model: 'old-model' } },
    {
      claude: { model: 'claude-sonnet-5' },
      openai: { model: 'gpt-5-mini' }
    }
  );
  const legacy = buildLegacySettings(merged, { apiKey: 'legacy-secret' });

  assert.equal(merged.openai.apiKey, 'modern-secret');
  assert.equal(legacy.apiKey, 'legacy-secret');
  assert.equal(legacy.openaiApiKey, 'modern-secret');
  assert.equal(legacy.openaiModel, 'gpt-5-mini');
});
