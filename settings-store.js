/** All settings patches share one background queue, including backup imports. */
(function initializeSettingsStore(root) {
  'use strict';
  const providers = root.OCRProviderConfig || require('./provider-config.js');
  const translation = root.OCRTranslationPreferences || require('./translation-preferences.js');

  function create(storage) {
    let writes = Promise.resolve();
    function enqueue(operation) {
      const result = writes.then(operation);
      writes = result.catch(() => {});
      return result;
    }
    function save(input) {
      // Validate and copy before queueing. Failed imports perform no writes and
      // callers cannot change a pending patch after its validation.
      let patch;
      try { patch = providers.prepareSettingsPatch(input); }
      catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        const update = { ...patch };
        if (patch.apiConfigs) {
          const current = await storage.get(['apiConfigs', ...providers.LEGACY_STORAGE_KEYS]);
          update.apiConfigs = providers.mergeImportedApiConfigs(providers.resolveApiConfigs(current), patch.apiConfigs);
          Object.assign(update, providers.buildLegacySettings(update.apiConfigs, current));
        }
        if (Object.keys(update).length) await storage.set(update);
        return { success: true };
      });
    }
    function getTranslationPreferences() {
      return enqueue(async () => ({
        success: true, preferences: translation.normalize(await storage.get(translation.STORAGE_KEYS))
      }));
    }
    function saveTranslationPreferences(patch) {
      if (!providers.isRecord(patch) || !Object.keys(patch).length
        || Object.keys(patch).some((key) => !['provider', 'targetLanguage'].includes(key))) {
        return Promise.reject(Object.assign(new Error('Invalid translation preferences'), {
          code: 'TRANSLATION_PREFERENCES_INVALID'
        }));
      }
      const update = {};
      if (Object.hasOwn(patch, 'provider')) update.translationProvider = patch.provider;
      if (Object.hasOwn(patch, 'targetLanguage')) update.translationTargetLanguage = patch.targetLanguage;
      return save(update).then(getTranslationPreferences).catch((error) => {
        if (error.code === 'SETTINGS_INVALID') error.code = 'TRANSLATION_PREFERENCES_INVALID';
        throw error;
      });
    }
    return Object.freeze({ save, getTranslationPreferences, saveTranslationPreferences });
  }
  const api = Object.freeze({ create });
  root.OCRSettingsStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
