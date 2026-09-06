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
    'content/styles.js',
    'content/selection.js',
    'content/notice-view.js',
    'content/result-view.js',
    'content/capture-pipeline.js',
    'content/session.js',
    'content.js'
  ]);

  function usesCustomEndpoint(provider) {
    return provider === 'openai-compatible' || provider === 'custom';
  }

  /**
   * Return a stable reason when Chrome does not allow content-script injection
   * into the target page.
   */
  function getUnsupportedPageReason(url) {
    if (!url || typeof url !== 'string') return null;

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    const internalProtocols = new Set([
      'about:',
      'brave:',
      'chrome:',
      'chrome-extension:',
      'devtools:',
      'edge:',
      'edge-extension:',
      'opera:',
      'view-source:',
      'vivaldi:'
    ]);
    if (internalProtocols.has(parsed.protocol)) {
      return 'browser_internal';
    }

    const storeHosts = new Set([
      'chrome.google.com',
      'chromewebstore.google.com',
      'microsoftedge.microsoft.com'
    ]);
    if (storeHosts.has(parsed.hostname)) {
      return 'browser_store';
    }

    return null;
  }

  function createUnsupportedPageError(reason) {
    const error = new Error(`Capture is unavailable on this page: ${reason}`);
    error.code = 'UNSUPPORTED_PAGE';
    error.reason = reason;
    return error;
  }

  async function hasFileSchemeAccess(chromeApi) {
    const checker = chromeApi.extension?.isAllowedFileSchemeAccess;
    if (typeof checker !== 'function') return true;
    return new Promise((resolve) => checker.call(chromeApi.extension, resolve));
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

  async function startCaptureInTab(chromeApi, tabOrId) {
    const tabId = typeof tabOrId === 'object' ? tabOrId?.id : tabOrId;
    const reason = typeof tabOrId === 'object'
      ? getUnsupportedPageReason(tabOrId?.url)
      : null;

    if (reason) {
      throw createUnsupportedPageError(reason);
    }
    if (
      typeof tabOrId === 'object'
      && String(tabOrId?.url || '').startsWith('file:')
      && !(await hasFileSchemeAccess(chromeApi))
    ) {
      throw createUnsupportedPageError('file_access');
    }
    if (!Number.isInteger(tabId)) {
      throw new TypeError('A valid target tab id is required');
    }

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
    getUnsupportedPageReason,
    startCaptureInTab
  });
}));
