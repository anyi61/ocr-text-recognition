/** Translation defaults and serialized persistence, independent of OCR/UI settings. */
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

  function create(storage) {
    let writes = Promise.resolve();
    const read = async () => normalize(await storage.get(STORAGE_KEYS));
    return Object.freeze({
      async get() {
        await writes;
        return { success: true, preferences: await read() };
      },
      save(patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)
          || !Object.keys(patch).length || Object.keys(patch).some((key) => !['provider', 'targetLanguage'].includes(key))
          || ('provider' in patch && !PROVIDERS.includes(patch.provider))
          || ('targetLanguage' in patch && !LANGUAGES.includes(patch.targetLanguage))) {
          return Promise.reject(Object.assign(new Error('Invalid translation preferences'), {
            code: 'TRANSLATION_PREFERENCES_INVALID'
          }));
        }
        // Copy before queuing: callers cannot mutate a pending write.
        const update = {};
        if ('provider' in patch) update.translationProvider = patch.provider;
        if ('targetLanguage' in patch) update.translationTargetLanguage = patch.targetLanguage;
        const operation = writes.then(async () => {
          // Persist only explicitly changed keys; concurrent panels cannot clobber
          // one another's other field, OCR provider, or interface language.
          await storage.set(update);
          return { success: true, preferences: await read() };
        });
        writes = operation.catch(() => {});
        return operation;
      }
    });
  }

  const api = Object.freeze({ DEFAULTS, STORAGE_KEYS, normalize, create });
  root.OCRTranslationPreferences = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
