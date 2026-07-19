/**
 * Shared Chrome runtime helpers for optional endpoint permissions and
 * on-demand content-script injection.
 */
(function initializeExtensionRuntime(root, factory) {
  const providerConfig = typeof module === 'object' && module.exports
    ? require('./provider-config.js')
    : root.OCRProviderConfig;
  const api = factory(providerConfig);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.OCRExtensionRuntime = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createExtensionRuntime(providerConfig) {
  'use strict';

  const CONTENT_SCRIPT_FILES = Object.freeze([
    'i18n-runtime.js',
    'capture-utils.js',
    'content.js'
  ]);

  function usesCustomEndpoint(provider) {
    return provider === 'openai-compatible' || provider === 'custom';
  }

  async function requestEndpointPermission(chromeApi, provider, endpoint) {
    if (!usesCustomEndpoint(provider)) return true;
    const originPattern = providerConfig.getEndpointOriginPattern(endpoint);
    return originPattern
      ? chromeApi.permissions.request({ origins: [originPattern] })
      : false;
  }

  async function hasEndpointPermission(chromeApi, provider, endpoint) {
    if (!usesCustomEndpoint(provider)) return true;
    const originPattern = providerConfig.getEndpointOriginPattern(endpoint);
    return originPattern
      ? chromeApi.permissions.contains({ origins: [originPattern] })
      : false;
  }

  async function startCaptureInTab(chromeApi, tabId) {
    try {
      await chromeApi.tabs.sendMessage(tabId, { action: 'startCapture' });
    } catch (error) {
      const message = String(error?.message || error);
      const noReceiver = message.includes('Receiving end does not exist')
        || message.includes('Could not establish connection');
      if (!noReceiver) throw error;

      await chromeApi.scripting.executeScript({
        target: { tabId },
        files: [...CONTENT_SCRIPT_FILES]
      });
      await chromeApi.tabs.sendMessage(tabId, { action: 'startCapture' });
    }
  }

  return Object.freeze({
    CONTENT_SCRIPT_FILES,
    requestEndpointPermission,
    hasEndpointPermission,
    startCaptureInTab
  });
}));
