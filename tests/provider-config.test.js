const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getStorageKey,
  getProviderConfig,
  mergeModernAndLegacyConfigs,
  migrateLegacyConfigOnce,
  hasRequiredCredentials,
  redactApiConfigs,
  getEndpointOriginPattern,
  migrateRetiredModel,
  mergeImportedApiConfigs,
  normalizeConfig,
  isValidHeaderName
} = require('../provider-config.js');

function createStorage(initial = {}, hooks = {}) {
  const state = structuredClone(initial);
  let setCalls = 0;
  return {
    state,
    get setCalls() { return setCalls; },
    async get(keys) {
      const selected = {};
      for (const key of keys) {
        if (state[key] !== undefined) selected[key] = structuredClone(state[key]);
      }
      return hooks.transformGet ? hooks.transformGet(selected) : selected;
    },
    async set(values) {
      setCalls += 1;
      if (hooks.failSet) throw new Error('write failed');
      Object.assign(state, structuredClone(values));
      if (hooks.corruptReadback) state.apiConfigs = { corrupted: true };
    },
    async remove(keys) {
      for (const key of keys) delete state[key];
    }
  };
}

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

test('legacy migration prefers modern values and fills only missing fields', async () => {
  const storage = createStorage({
    apiConfigs: {
      openai: { apiKey: '', model: 'modern-model' },
      baidu: { apiKey: 'modern-baidu' }
    },
    openaiApiKey: 'legacy-openai',
    openaiModel: 'legacy-model',
    baiduApiKey: 'legacy-baidu',
    customSecret: 'legacy-secret'
  });

  const migrated = await migrateLegacyConfigOnce(storage);
  assert.deepEqual(migrated.openai, { apiKey: '', model: 'modern-model' });
  assert.deepEqual(migrated.baidu, { apiKey: 'modern-baidu', secret: 'legacy-secret' });
  assert.equal(storage.state.openaiApiKey, undefined);
  assert.equal(storage.state.customSecret, undefined);
});

test('legacy migration is idempotent and shares one in-flight promise', async () => {
  const storage = createStorage({ apiKey: 'legacy-secret', model: 'legacy-model' });
  const first = migrateLegacyConfigOnce(storage);
  const second = migrateLegacyConfigOnce(storage);
  assert.equal(first, second);
  await first;
  await migrateLegacyConfigOnce(storage);
  assert.equal(storage.setCalls, 1);
  assert.deepEqual(storage.state.apiConfigs.claude, {
    apiKey: 'legacy-secret',
    model: 'legacy-model'
  });
});

test('legacy migration accepts reordered Chrome storage readback', async () => {
  const storage = createStorage({
    apiKey: 'legacy-secret',
    model: 'legacy-model',
    openaiApiKey: 'openai-secret',
    openaiModel: 'openai-model'
  }, {
    transformGet(selected) {
      if (!selected.apiConfigs) return selected;
      return {
        ...selected,
        apiConfigs: {
          openai: {
            model: selected.apiConfigs.openai.model,
            apiKey: selected.apiConfigs.openai.apiKey
          },
          claude: {
            model: selected.apiConfigs.claude.model,
            apiKey: selected.apiConfigs.claude.apiKey
          }
        }
      };
    }
  });

  await migrateLegacyConfigOnce(storage);
  assert.equal(storage.state.apiKey, undefined);
  assert.equal(storage.state.openaiApiKey, undefined);
  assert.deepEqual(storage.state.apiConfigs, {
    claude: { apiKey: 'legacy-secret', model: 'legacy-model' },
    openai: { apiKey: 'openai-secret', model: 'openai-model' }
  });
});

test('legacy migration preserves original fields when write or verification fails', async () => {
  const writeFailure = createStorage({ apiKey: 'keep-me' }, { failSet: true });
  await assert.rejects(migrateLegacyConfigOnce(writeFailure), /write failed/);
  assert.equal(writeFailure.state.apiKey, 'keep-me');

  const verificationFailure = createStorage({ apiKey: 'also-keep-me' }, { corruptReadback: true });
  await assert.rejects(migrateLegacyConfigOnce(verificationFailure), /verification failed/);
  assert.equal(verificationFailure.state.apiKey, 'also-keep-me');
});

test('legacy import conversion accepts a legacy-only configuration object', () => {
  assert.deepEqual(mergeModernAndLegacyConfigs(undefined, {
    apiKey: 'claude-key',
    model: 'claude-model',
    compatibleEndpoint: 'https://example.test/v1/chat/completions',
    compatibleApiKey: 'compatible-key',
    compatibleModel: 'vision-model'
  }), {
    claude: { apiKey: 'claude-key', model: 'claude-model' },
    openaiCompatible: {
      endpoint: 'https://example.test/v1/chat/completions',
      apiKey: 'compatible-key',
      model: 'vision-model'
    }
  });
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
  assert.equal(
    getEndpointOriginPattern('http://localhost:11434/v1/chat/completions'),
    'http://localhost:11434/*'
  );
  assert.equal(getEndpointOriginPattern('http://ocr.example.com/v1/chat/completions'), null);
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
  assert.equal(merged.openai.apiKey, 'modern-secret');
  assert.equal(merged.openai.model, 'gpt-5-mini');
});
