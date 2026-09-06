/** Pure helpers shared by the settings page and Node tests. */
(function initializeOptionsRuntime(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCROptionsRuntime = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createOptionsRuntime() {
  'use strict';

  function createStatusPresenter(statusMessage, timerApi = globalThis) {
    let hideTimer = null;
    return (message, type) => {
      if (hideTimer !== null) {
        timerApi.clearTimeout(hideTimer);
        hideTimer = null;
      }
      statusMessage.textContent = message;
      statusMessage.className = 'status-message ' + type;
      statusMessage.classList.remove('hidden');
      if (type !== 'loading') {
        hideTimer = timerApi.setTimeout(() => {
          statusMessage.classList.add('hidden');
          hideTimer = null;
        }, 5000);
      }
    };
  }

  function buildExportData(result, apiConfigs, runtimeVersion, exportDate = new Date().toISOString()) {
    return {
      version: runtimeVersion,
      exportDate,
      appName: 'OCR文字识别助手',
      config: {
        apiProvider: result.apiProvider || 'claude',
        apiConfigs,
        prompt: result.prompt || '',
        language: result.language || 'auto',
        theme: result.theme || 'light',
        uiLanguage: result.uiLanguage || 'auto'
      }
    };
  }

  function applyImportedAppearance(config, existingSettings) {
    return {
      theme: config.theme ?? existingSettings.theme ?? 'light',
      uiLanguage: config.uiLanguage ?? existingSettings.uiLanguage ?? 'auto'
    };
  }

  function validateImportPreferences(config) {
    if (config.theme !== undefined && !['light', 'dark'].includes(config.theme)) return 'theme';
    if (config.uiLanguage !== undefined && !['auto', 'zh_CN', 'en'].includes(config.uiLanguage)) return 'uiLanguage';
    if (config.language !== undefined && !['auto', 'zh', 'en', 'ja', 'ko'].includes(config.language)) return 'language';
    return null;
  }

  function createModalLifecycle(documentApi, overlay, resolve, timerApi = globalThis) {
    let closed = false;
    let settled = false;
    let removeTimer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(result);
    };
    const close = (result) => {
      if (closed) return;
      closed = true;
      documentApi.removeEventListener('keydown', escHandler);
      overlay.classList.remove('active');
      removeTimer = timerApi.setTimeout(() => settle(result), 300);
    };
    const escHandler = (event) => {
      if (event.key === 'Escape') close(false);
    };
    documentApi.addEventListener('keydown', escHandler);
    return { close, destroy() {
      closed = true;
      documentApi.removeEventListener('keydown', escHandler);
      if (removeTimer !== null) timerApi.clearTimeout(removeTimer);
      settle(false);
    } };
  }

  return Object.freeze({
    createStatusPresenter,
    buildExportData,
    applyImportedAppearance,
    validateImportPreferences,
    createModalLifecycle
  });
}));
