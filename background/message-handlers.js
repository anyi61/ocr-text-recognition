// @ts-check
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRBackgroundHandlers = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(dependencies) {
    const { storage, historyStore, captureService, recognitionService,
      uploadNoticeVersion: UPLOAD_NOTICE_VERSION } = dependencies;

    return {
      captureVisibleTab(request, sender, sendResponse) {
        captureService.capture(sendResponse, sender);
        return true;
      },
      performOCR(request, sender, sendResponse) {
        recognitionService.recognize(request.imageData, request.requestId, sendResponse, sender);
        return true;
      },
      cancelOCR(request, _sender, sendResponse) {
        const cancelled = recognitionService.cancel(request.requestId);
        sendResponse({ success: true, cancelled });
      },
      testAPI(request, _sender, sendResponse) {
        recognitionService.testConnection(request.config, sendResponse);
        return true;
      },
      getContentPreferences(_request, _sender, sendResponse) {
        storage.get(['theme', 'uiLanguage'])
          .then((preferences) => sendResponse({ success: true, ...preferences }))
          .catch(() => sendResponse({ success: false }));
        return true;
      },
      getUploadNoticeState(_request, _sender, sendResponse) {
        storage.get(['uploadNoticeAcknowledgedVersion', 'apiProvider'])
          .then((stored) => sendResponse({
            success: true,
            acknowledged: stored.uploadNoticeAcknowledgedVersion >= UPLOAD_NOTICE_VERSION,
            provider: stored.apiProvider || 'claude',
            version: UPLOAD_NOTICE_VERSION
          }))
          .catch(() => sendResponse({ success: false }));
        return true;
      },
      acknowledgeUploadNotice(_request, _sender, sendResponse) {
        storage.set({ uploadNoticeAcknowledgedVersion: UPLOAD_NOTICE_VERSION })
          .then(() => sendResponse({ success: true, version: UPLOAD_NOTICE_VERSION }))
          .catch(() => sendResponse({ success: false }));
        return true;
      },
      updateHistoryRecord(request, _sender, sendResponse) {
        historyStore.updateText(request.historyId, request.text)
          .then((updated) => sendResponse({ success: updated }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;
      },
      listHistory(_request, _sender, sendResponse) {
        historyStore.list()
          .then((records) => sendResponse({ success: true, records }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;
      },
      deleteHistoryRecord(request, _sender, sendResponse) {
        historyStore.delete(request.historyId)
          .then((deleted) => sendResponse({ success: deleted }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;
      },
      clearHistory(_request, _sender, sendResponse) {
        historyStore.clear()
          .then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;
      }
    };
  }

  return { create };
}));
