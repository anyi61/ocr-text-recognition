/** Translation defaults, independent of OCR/UI settings. Persistence lives in settings-store.js. */
(function initializeTranslationPreferences(root) {
  'use strict';

  const DEFAULTS = Object.freeze({ provider: 'claude', targetLanguage: 'zh_CN' });
  const PROVIDERS = ['claude', 'openai', 'baidu', 'aliyun', 'zhipu', 'openai-compatible', 'custom'];
  const LANGUAGES = ['zh_CN', 'zh_TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'ar'];
  const STORAGE_KEYS = Object.freeze(['translationProvider', 'translationTargetLanguage']);

  function normalize(settings = {}) {
    return {
      provider: PROVIDERS.includes(settings.translationProvider) ? settings.translationProvider : DEFAULTS.provider,
      targetLanguage: LANGUAGES.includes(settings.translationTargetLanguage)
        ? settings.translationTargetLanguage : DEFAULTS.targetLanguage
    };
  }

  const api = Object.freeze({ DEFAULTS, STORAGE_KEYS, normalize });
  root.OCRTranslationPreferences = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
