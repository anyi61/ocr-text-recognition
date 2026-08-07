// @ts-check
/** Small, auditable dispatcher for Chrome runtime message actions. */
(function initializeMessageRouter(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRBackgroundMessageRouter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createMessageRouterModule() {
  'use strict';

  function create(handlers) {
    const registered = Object.freeze({ ...handlers });
    return function dispatch(request, sender, sendResponse) {
      const action = typeof request?.action === 'string' ? request.action : '';
      const handler = registered[action];
      if (!handler) {
        sendResponse({ success: false, error: 'UNKNOWN_ACTION' });
        return false;
      }
      try {
        return handler(request, sender, sendResponse) === true;
      } catch (error) {
        sendResponse({
          success: false,
          error: typeof error?.code === 'string' ? error.code : 'MESSAGE_HANDLER_FAILED'
        });
        return false;
      }
    };
  }

  return Object.freeze({ create });
}));
