// @ts-check
/**
 * Provider adapter registry. It owns configuration normalization and routes
 * both recognition and connection tests through the same implementation.
 */
(function initializeProviderAdapters(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRProviderAdapters = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createRegistryModule() {
  'use strict';

  const PROVIDERS = Object.freeze([
    'claude',
    'openai',
    'baidu',
    'aliyun',
    'zhipu',
    'openai-compatible',
    'custom'
  ]);
  const BAIDU_MODES = new Set(['general_basic', 'accurate_basic', 'handwriting']);

  function create(implementations, dependencies = {}) {
    const normalizeModel = dependencies.migrateRetiredModel || ((_provider, model) => model);
    const unknownProvider = dependencies.createUnknownProviderError
      || ((provider) => Object.assign(new Error(`Unknown provider: ${provider}`), {
        code: 'UNKNOWN_PROVIDER'
      }));

    const definitions = {
      claude: {
        normalize(config, common) {
          return { ...common, apiKey: config.apiKey, model: config.model || 'claude-sonnet-5' };
        }
      },
      openai: {
        normalize(config, common) {
          return { ...common, apiKey: config.apiKey, model: config.model || 'gpt-5-mini' };
        }
      },
      baidu: {
        normalize(config, common) {
          const mode = config.mode || 'general_basic';
          if (!BAIDU_MODES.has(mode)) {
            throw Object.assign(new Error(`Unsupported Baidu OCR mode: ${mode}`), {
              code: 'INVALID_PROVIDER_CONFIG'
            });
          }
          return {
            ...common,
            apiKey: config.apiKey,
            customSecret: config.secret || config.customSecret,
            mode
          };
        },
        interpretConnectionError(error) {
          return String(error?.code) === '216630'
            ? { success: true, warningCode: 'BAIDU_TEST_IMAGE_RECOGNIZE_ERROR' }
            : null;
        }
      },
      aliyun: {
        normalize(config, common) {
          const model = config.model || config.customModel || 'qwen-vl-max';
          return { ...common, apiKey: config.apiKey, model, customModel: model };
        }
      },
      zhipu: {
        normalize(config, common) {
          return { ...common, apiKey: config.apiKey, model: config.model || 'glm-4v' };
        }
      },
      'openai-compatible': {
        normalize(config, common) {
          const model = config.model || config.customModel;
          return {
            ...common,
            apiKey: config.apiKey,
            model,
            customModel: model,
            customEndpoint: config.endpoint || config.customEndpoint
          };
        }
      },
      custom: {
        normalize(config, common) {
          const model = config.model || config.customModel;
          return {
            ...common,
            apiKey: config.apiKey,
            model,
            customModel: model,
            customEndpoint: config.endpoint || config.customEndpoint,
            requestMode: config.requestMode || 'chat-completions',
            authMode: config.authMode || 'bearer',
            headerName: config.headerName || '',
            responsePath: config.responsePath || ''
          };
        }
      }
    };

    const adapters = Object.fromEntries(PROVIDERS.map((id) => {
      const recognize = implementations[id];
      if (typeof recognize !== 'function') {
        throw new TypeError(`Missing recognize implementation for ${id}`);
      }
      return [id, Object.freeze({
        id,
        normalizeConfig(config = {}, common = {}) {
          const normalized = definitions[id].normalize(config, common);
          normalized.apiProvider = id;
          if (normalized.model !== undefined) {
            normalized.model = normalizeModel(id, normalized.model);
          }
          if (normalized.customModel) normalized.customModel = normalized.model;
          for (const [key, value] of Object.entries(normalized)) {
            if (value === undefined) delete normalized[key];
          }
          return normalized;
        },
        recognize,
        interpretConnectionError: definitions[id].interpretConnectionError || (() => null)
      })];
    }));

    function get(provider) {
      const adapter = adapters[provider];
      if (!adapter) throw unknownProvider(provider);
      return adapter;
    }

    return Object.freeze({
      ids: PROVIDERS,
      get,
      normalizeConfig(provider, config, common) {
        return get(provider).normalizeConfig(config, common);
      },
      recognize(provider, image, config, signal) {
        return get(provider).recognize(image, config, signal);
      },
      interpretConnectionError(provider, error) {
        return get(provider).interpretConnectionError(error);
      }
    });
  }

  return Object.freeze({ PROVIDERS, create });
}));
