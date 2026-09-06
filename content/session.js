// @ts-check
/** Owns the capture identity, active request and document UI lifetime. */
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRCaptureSession = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create(dependencies) {
    const { document, window, chrome, navigator, Image, requestAnimationFrame,
      i18n: OCRI18n, captureUtils: OCRCaptureUtils, styles: OCRContentStyles,
      selectionModule, noticeModule, resultModule, pipelineModule, onDestroy } = dependencies;
    let destroyed = false;
    let isCancelled = false;
    let activeRequestId = null;
    let captureSessionId = null;
    let isProcessing = false;
    let confirmingSessionId = null;
    const uiTimers = new Set();
    let shadowHost = null;
    let shadowRoot = null;
    let a11yLiveRegion = null;
  const Z = {
    OVERLAY: 1000010,
    TOOLTIP: 1000020,
    SELECTION: 1000030,
    HANDLE: 1000040,
    TOOLBAR: 1000050,
    NOTIFICATION: 1000060,
    PROGRESS: 1000070,
    RESULT_POPUP: 1000080
  };
    const viewDependencies = { document, window, chrome, navigator, i18n: OCRI18n, Z,
      getShadowRoot: () => shadowRoot, initShadowDOM, scheduleUiTimeout, announceA11y };
    const notice = noticeModule.create({ ...viewDependencies,
      getSessionId: () => captureSessionId, isCurrentSession, endCaptureSession });
    const { showNotification } = notice;
    const result = resultModule.create({ ...viewDependencies, showNotification });
    const selection = selectionModule.create({ ...viewDependencies,
      captureUtils: OCRCaptureUtils, showNotification, confirmSelection, cancelCapture,
      isNoticeOpen: notice.isOpen });
    const pipeline = pipelineModule.create({ document, window, chrome, Image, requestAnimationFrame,
      i18n: OCRI18n, captureUtils: OCRCaptureUtils, announceA11y,
      isCancelled: () => isCancelled, isCurrentSession,
      getActiveRequestId: () => activeRequestId,
      setActiveRequestId: (id) => { activeRequestId = id; },
      finish(sessionId, requestId) {
        if (!isCurrentSession(sessionId)) return;
        if (requestId && activeRequestId === requestId) activeRequestId = null;
        captureSessionId = null;
        isProcessing = false;
      },
      showProgressNotification: notice.showProgressNotification,
      hideProgressNotification: notice.hideProgressNotification,
      showNotification, showResultPopup: result.show, getElapsed: notice.elapsed });
    function isCurrentSession(sessionId) {
      return sessionId !== null && captureSessionId === sessionId;
    }

    function scheduleUiTimeout(callback, delay) {
      const timer = setTimeout(() => {
        uiTimers.delete(timer);
        callback();
      }, delay);
      uiTimers.add(timer);
      return timer;
    }

    function endCaptureSession() {
      const requestId = activeRequestId;
      captureSessionId = null;
      activeRequestId = null;
      confirmingSessionId = null;
      isProcessing = false;
      isCancelled = true;
      notice.destroy();
      selection.destroy();
      result.destroy();
      for (const timer of uiTimers) clearTimeout(timer);
      uiTimers.clear();
      if (a11yLiveRegion) a11yLiveRegion.textContent = '';
      if (requestId) {
        chrome.runtime.sendMessage({ action: 'cancelOCR', requestId }).catch(() => {});
      }
    }

    function applyThemeToShadowHost(theme) {
      if (!shadowHost) return;
      const safeTheme = theme === 'dark' ? 'dark' : 'light';
      shadowHost.setAttribute('data-theme', safeTheme);
    }

    async function syncThemeFromStorage() {
      try {
        const result = await chrome.runtime.sendMessage({ action: 'getContentPreferences' });
        const fallback = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        applyThemeToShadowHost(result.theme || fallback);
      } catch (error) {
        const fallback = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        applyThemeToShadowHost(fallback);
      }
    }



    function initShadowDOM() {
      // 如果已经存在，直接返回
      if (shadowRoot && shadowHost) {
        return shadowRoot;
      }

      // 创建宿主元素（全屏容器，但不拦截事件）
      shadowHost = document.createElement('div');
      shadowHost.id = 'ocr-root-host';
      shadowHost.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none;
        z-index: 1000009;
      `;

      // 挂载 Shadow DOM
      shadowRoot = shadowHost.attachShadow({ mode: 'closed' });

      // 创建样式元素
      const styleEl = document.createElement('style');
      styleEl.textContent = OCRContentStyles.getAllStyles(Z);
      shadowRoot.appendChild(styleEl);

      // 添加到页面
      document.body.appendChild(shadowHost);

      // 主题同步
      syncThemeFromStorage();

      return shadowRoot;
    }

    function ensureA11yLiveRegion() {
      if (!a11yLiveRegion || !shadowRoot || !shadowRoot.contains(a11yLiveRegion)) {
        a11yLiveRegion = document.createElement('div');
        a11yLiveRegion.id = 'ocr-a11y-live';
        a11yLiveRegion.className = 'ocr-sr-only';
        a11yLiveRegion.setAttribute('aria-live', 'polite');
        a11yLiveRegion.setAttribute('aria-atomic', 'true');
        if (shadowRoot) {
          shadowRoot.appendChild(a11yLiveRegion);
        }
      }
    }

    function announceA11y(message) {
      ensureA11yLiveRegion();
      if (a11yLiveRegion) {
        a11yLiveRegion.textContent = message;
      }
    }

    function destroyShadowDOM() {
      if (shadowHost && document.body.contains(shadowHost)) {
        shadowHost.remove();
        shadowHost = null;
        shadowRoot = null;
      }
    }

    async function confirmSelection(event) {
      if (!event?.isTrusted || isProcessing || notice.isOpen() || confirmingSessionId || !captureSessionId) return;
      const currentRect = selection.getRect();
      if (!currentRect || currentRect.width < 10 || currentRect.height < 10) {
        showNotification(OCRI18n.t('content_msg_selection_small_edit'), 'warning');
        return;
      }

      const sessionId = captureSessionId;
      const rect = { ...currentRect };
      confirmingSessionId = sessionId;
      try {
        if (!(await notice.confirm(sessionId)) || !isCurrentSession(sessionId)) return;
      } catch (error) {
        if (isCurrentSession(sessionId)) showNotification(error.message, 'error');
        return;
      } finally {
        if (confirmingSessionId === sessionId) confirmingSessionId = null;
      }

      // The snapshot belongs to the confirming session, never to a replacement.
      isProcessing = true;
      selection.clear();

      // 执行截图
      await pipeline.run(rect, sessionId);
    }

    function cancelCapture(event) {
      if (!event?.isTrusted) return;
      endCaptureSession();
      showNotification(OCRI18n.t('content_msg_cancelled'), 'info');
    }

    function fullCleanup() {
      if (destroyed) return;
      destroyed = true;
      endCaptureSession();
      destroyShadowDOM();
      onDestroy();
    }

    function startCapture() {
      if (destroyed) return;
      endCaptureSession();
      isCancelled = false;
      captureSessionId = OCRCaptureUtils.createRequestId();
      syncThemeFromStorage();
      selection.start();
    }

    return { start: startCapture, cancel: endCaptureSession, destroy: fullCleanup };

  }
  return { create };
}));
