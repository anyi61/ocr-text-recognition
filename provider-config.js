/**
 * Shared provider storage mapping and credential helpers.
 * Exposed as a browser global and as CommonJS for Node.js tests.
 */
(function initializeProviderConfig(root, factory) {
  const providerConfig = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = providerConfig;
  }

  root.OCRProviderConfig = providerConfig;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createProviderConfig() {
  'use strict';

  const STORAGE_KEYS = Object.freeze({
    claude: 'claude',
    openai: 'openai',
    baidu: 'baidu',
    aliyun: 'aliyun',
    zhipu: 'zhipu',
    'openai-compatible': 'openaiCompatible',
    custom: 'custom'
  });

  const LEGACY_FIELDS = Object.freeze({
    claude: { apiKey: 'apiKey', model: 'model' },
    openai: { apiKey: 'openaiApiKey', model: 'openaiModel' },
    baidu: { apiKey: 'baiduApiKey', secret: 'customSecret' },
    aliyun: { apiKey: 'aliyunApiKey', model: 'aliyunModel' },
    zhipu: { apiKey: 'zhipuApiKey', model: 'zhipuModel' },
    'openai-compatible': {
      endpoint: 'compatibleEndpoint',
      apiKey: 'compatibleApiKey',
      model: 'compatibleModel'
    },
    custom: {
      endpoint: 'customEndpoint',
      apiKey: 'customApiKey',
      model: 'customModel'
    }
  });

  const REQUIRED_FIELDS = Object.freeze({
    claude: ['apiKey'],
    openai: ['apiKey'],
    baidu: ['apiKey', 'secret'],
    aliyun: ['apiKey'],
    zhipu: ['apiKey'],
    'openai-compatible': ['endpoint', 'apiKey', 'model'],
    custom: ['endpoint']
  });

  const SENSITIVE_FIELDS = new Set(['apiKey', 'secret', 'headerValue']);
  const CONFIGURABLE_PROVIDERS = new Set(['openai-compatible', 'custom']);
  const AUTH_MODES = new Set(['bearer', 'api-key', 'custom-header', 'none']);
  const REQUEST_MODES = new Set(['chat-completions', 'responses']);
  const FORBIDDEN_HEADER_NAMES = new Set(['host', 'origin', 'content-length']);
  // Defaults apply only to an absent model, never to an explicit user selection.
  // Model availability and announced shutdowns are documented in the settings UI.
  const DEFAULT_MODELS = Object.freeze({
    claude: 'claude-sonnet-5',
    openai: 'gpt-5-mini',
    aliyun: 'qwen-vl-max',
    zhipu: 'glm-4v'
  });

  function isPresent(value) {
    return typeof value === 'string'
      ? value.trim().length > 0
      : value !== undefined && value !== null;
  }

  function getStorageKey(provider) {
    return STORAGE_KEYS[provider] || provider;
  }

  function getProviderConfig(apiConfigs, provider) {
    if (!apiConfigs || typeof apiConfigs !== 'object') {
      return {};
    }

    const config = apiConfigs[getStorageKey(provider)];
    return normalizeConfig(provider, config && typeof config === 'object' ? config : {});
  }

  function getLegacyConfig(legacy, provider) {
    if (!legacy || typeof legacy !== 'object') {
      return {};
    }

    const fieldMap = LEGACY_FIELDS[provider] || {};
    return Object.fromEntries(
      Object.entries(fieldMap)
        .filter(([, legacyField]) => legacy[legacyField] !== undefined)
        .map(([field, legacyField]) => [field, legacy[legacyField]])
    );
  }

  function normalizeConfig(provider, config) {
    const normalized = { ...(config || {}) };
    if (CONFIGURABLE_PROVIDERS.has(provider)) {
      normalized.authMode = AUTH_MODES.has(normalized.authMode)
        ? normalized.authMode
        : 'bearer';
      normalized.requestMode = REQUEST_MODES.has(normalized.requestMode)
        ? normalized.requestMode
        : 'chat-completions';
    }
    return normalized;
  }

  function isValidHeaderName(value) {
    if (typeof value !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
      return false;
    }
    return !FORBIDDEN_HEADER_NAMES.has(value.toLowerCase());
  }

  function hasRequiredCredentials(apiConfigs, provider, legacy = {}) {
    const config = normalizeConfig(provider, {
      ...getLegacyConfig(legacy, provider),
      ...getProviderConfig(apiConfigs, provider)
    });
    const requiredFields = REQUIRED_FIELDS[provider];

    if (!Array.isArray(requiredFields) || !requiredFields.every((field) => isPresent(config[field]))) {
      return false;
    }
    if (CONFIGURABLE_PROVIDERS.has(provider)) {
      if (!getEndpointOriginPattern(config.endpoint)) {
        return false;
      }
      if (config.authMode !== 'none' && !isPresent(config.apiKey)) {
        return false;
      }
      if (config.authMode === 'custom-header' && !isValidHeaderName(config.headerName)) {
        return false;
      }
    }
    return true;
  }

  function redactApiConfigs(apiConfigs) {
    if (!apiConfigs || typeof apiConfigs !== 'object') {
      return {};
    }

    return Object.fromEntries(
      Object.entries(apiConfigs).map(([provider, config]) => {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          return [provider, config];
        }

        const redactedConfig = Object.fromEntries(
          Object.entries(config)
            .filter(([field]) => !SENSITIVE_FIELDS.has(field))
        );
        return [provider, redactedConfig];
      })
    );
  }

  function getEndpointOriginPattern(endpoint) {
    try {
      const url = new URL(endpoint);
      const loopbackHttp = url.protocol === 'http:'
        && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
      if (url.protocol !== 'https:' && !loopbackHttp) {
        return null;
      }
      return `${url.origin}/*`;
    } catch {
      return null;
    }
  }

  function mergeImportedApiConfigs(existingConfigs, importedConfigs) {
    const merged = { ...(existingConfigs || {}) };
    for (const [providerKey, importedConfig] of Object.entries(importedConfigs || {})) {
      merged[providerKey] = {
        ...(existingConfigs?.[providerKey] || {}),
        ...(importedConfig || {})
      };
    }
    return merged;
  }

  function buildLegacySettings(apiConfigs, existing = {}) {
    const legacy = {};
    const claude = apiConfigs?.claude;
    if (claude) {
      legacy.apiKey = claude.apiKey ?? existing.apiKey ?? '';
      legacy.model = claude.model ?? existing.model ?? DEFAULT_MODELS.claude;
    }
    const openai = apiConfigs?.openai;
    if (openai) {
      legacy.openaiApiKey = openai.apiKey ?? existing.openaiApiKey ?? '';
      legacy.openaiModel = openai.model ?? existing.openaiModel ?? DEFAULT_MODELS.openai;
    }
    const baidu = apiConfigs?.baidu;
    if (baidu) {
      legacy.baiduApiKey = baidu.apiKey ?? existing.baiduApiKey ?? '';
      legacy.customSecret = baidu.secret ?? existing.customSecret ?? '';
    }
    const aliyun = apiConfigs?.aliyun;
    if (aliyun) {
      legacy.aliyunApiKey = aliyun.apiKey ?? existing.aliyunApiKey ?? '';
      legacy.aliyunModel = aliyun.model ?? existing.aliyunModel ?? DEFAULT_MODELS.aliyun;
    }
    const zhipu = apiConfigs?.zhipu;
    if (zhipu) {
      legacy.zhipuApiKey = zhipu.apiKey ?? existing.zhipuApiKey ?? '';
      legacy.zhipuModel = zhipu.model ?? existing.zhipuModel ?? DEFAULT_MODELS.zhipu;
    }
    const compatible = apiConfigs?.openaiCompatible;
    if (compatible) {
      legacy.compatibleEndpoint = compatible.endpoint ?? existing.compatibleEndpoint ?? '';
      legacy.compatibleApiKey = compatible.apiKey ?? existing.compatibleApiKey ?? '';
      legacy.compatibleModel = compatible.model ?? existing.compatibleModel ?? '';
    }
    const custom = apiConfigs?.custom;
    if (custom) {
      legacy.customEndpoint = custom.endpoint ?? existing.customEndpoint ?? '';
      legacy.customApiKey = custom.apiKey ?? existing.customApiKey ?? '';
      legacy.customModel = custom.model ?? existing.customModel ?? '';
    }
    return legacy;
  }

  return Object.freeze({
    DEFAULT_MODELS,
    getStorageKey,
    getProviderConfig,
    normalizeConfig,
    isValidHeaderName,
    hasRequiredCredentials,
    redactApiConfigs,
    getEndpointOriginPattern,
    mergeImportedApiConfigs,
    buildLegacySettings
  });
}));
