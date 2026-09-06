/** Content-script entry: one session instance per injected document. */
(function() {
  if (window.ocrCaptureInitialized) return;
  window.ocrCaptureInitialized = true;
  const i18nReady = OCRI18n.init().catch((error) => {
    console.error('i18n init failed in content script:', error);
  });
  const session = OCRCaptureSession.create({
    document, window, chrome, navigator, Image, requestAnimationFrame,
    i18n: OCRI18n, captureUtils: OCRCaptureUtils, styles: OCRContentStyles,
    selectionModule: OCRSelection, noticeModule: OCRNoticeView,
    resultModule: OCRResultView, pipelineModule: OCRCapturePipeline,
    onDestroy() {
      chrome.runtime.onMessage.removeListener(messageListener);
      window.ocrCaptureInitialized = false;
      window.removeEventListener('beforeunload', fullCleanup);
      window.removeEventListener('pagehide', fullCleanup);
    }
  });
  function fullCleanup() { session.destroy(); }

  /**
   * 消息监听器
   * @param {Object} request - 消息请求
   * @param {chrome.runtime.MessageSender} sender - 发送者信息
   * @param {Function} sendResponse - 响应回调
   * @returns {boolean} 保持消息通道开启
   * @description 监听来自popup的消息，启动截图模式
   */
  function messageListener(request, _sender, sendResponse) {
    if (request.action === 'startCapture') {
      i18nReady.then(() => {
        session.start();
        sendResponse({ success: true });
      }).catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    }
    return true;
  }

  /**
   * 监听来自popup的消息
   * @listens chrome.runtime.onMessage
   */
  chrome.runtime.onMessage.addListener(messageListener);

  /**
   * 页面卸载时清理资源
   * @listens window.beforeunload
   * @description 防止内存泄漏
   */
  window.addEventListener('beforeunload', fullCleanup);
  window.addEventListener('pagehide', fullCleanup);

  console.log('OCR文字识别助手已加载');
})();
