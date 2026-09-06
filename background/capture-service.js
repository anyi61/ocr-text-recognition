// @ts-check
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRCaptureService = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(dependencies) {
    const { tabs, core: OCRBackgroundCore } = dependencies;

    async function handleCapture(sendResponse, sender) {
      try {
        if (!sender.tab || !Number.isInteger(sender.tab.id) || !Number.isInteger(sender.tab.windowId)) {
          throw OCRBackgroundCore.createCodedError('CAPTURE_TAB_CHANGED', 'Invalid capture tab');
        }
        const [activeBefore] = await tabs.query({
          active: true,
          windowId: sender.tab.windowId
        });
        if (!OCRBackgroundCore.isSameTabIdentity(sender.tab, activeBefore)) {
          throw OCRBackgroundCore.createCodedError('CAPTURE_TAB_CHANGED', 'Active tab changed');
        }
        const dataUrl = await tabs.captureVisibleTab(sender.tab.windowId, {
          format: 'png',
          quality: 100
        });
        const [activeAfter] = await tabs.query({
          active: true,
          windowId: sender.tab.windowId
        });
        if (!OCRBackgroundCore.isSameTabIdentity(sender.tab, activeAfter)) {
          throw OCRBackgroundCore.createCodedError('CAPTURE_TAB_CHANGED', 'Active tab changed');
        }
        sendResponse({ dataUrl });
      } catch (error) {
        console.error('截图失败:', error);
        sendResponse({ error: error.message, errorCode: error.code });
      }
    }

    return { capture: handleCapture };
  }

  return { create };
}));
