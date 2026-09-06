// @ts-check
/** Captures, crops and recognizes while checking the owning session at async boundaries. */
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRCapturePipeline = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create(dependencies) {
    const { document, window, chrome, Image, requestAnimationFrame,
      i18n: OCRI18n, captureUtils: OCRCaptureUtils, announceA11y,
      isCancelled, isCurrentSession, getActiveRequestId, setActiveRequestId, finish,
      showProgressNotification, hideProgressNotification, showNotification,
      showResultPopup, getElapsed } = dependencies;
    async function captureAndRecognize(rect, sessionId) {
      let requestId = null;

      try {
        announceA11y(OCRI18n.t('content_a11y_capturing'));

        // cleanup() 刚移除了遮罩、选区和工具栏。等待浏览器提交一帧，
        // 避免 captureVisibleTab 捕获到已删除但尚未重绘的扩展 UI。
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (isCancelled() || !isCurrentSession(sessionId)) return;

        // 发送消息给background进行截图（因为content script无法直接调用chrome.tabs.captureVisibleTab）
        const response = await chrome.runtime.sendMessage({
          action: 'captureVisibleTab'
        });

        // 检查是否被取消
        if (isCancelled() || !isCurrentSession(sessionId)) return;

        if (!response || !response.dataUrl) {
          hideProgressNotification();
          showNotification(OCRI18n.errorMessage(response, 'content_msg_capture_failed'), 'error');
          return;
        }

        // 裁剪选区
        const croppedImage = await cropImage(response.dataUrl, rect);

        // 检查是否被取消
        if (isCancelled() || !isCurrentSession(sessionId)) return;

        // 更新为识别阶段，显示取消按钮
        showProgressNotification(OCRI18n.t('content_progress_recognizing'), true);
        announceA11y(OCRI18n.t('content_a11y_recognizing'));

        requestId = OCRCaptureUtils.createRequestId();
        setActiveRequestId(requestId);

        // 发送给background进行OCR识别
        const ocrResponse = await chrome.runtime.sendMessage({
          action: 'performOCR',
          requestId,
          imageData: croppedImage
        });

        // 检查是否被取消
        if (isCancelled() || !isCurrentSession(sessionId) || getActiveRequestId() !== requestId) return;
        setActiveRequestId(null);

        // 计算识别用时
        const elapsed = getElapsed();
        hideProgressNotification();

        if (ocrResponse && ocrResponse.success) {
          showResultPopup(ocrResponse.text, ocrResponse.historyId);
          showNotification(
            ocrResponse.warningCode
              ? OCRI18n.errorMessage({ errorCode: ocrResponse.warningCode })
              : OCRI18n.t('content_msg_done', [String(elapsed)]),
            ocrResponse.warningCode ? 'warning' : 'success'
          );
          announceA11y(OCRI18n.t('content_a11y_done', [String(elapsed)]));
        } else {
          showNotification(OCRI18n.errorMessage(ocrResponse), 'error');
          announceA11y(OCRI18n.t('content_a11y_failed'));
        }
      } catch (error) {
        if (!isCurrentSession(sessionId)) return;
        hideProgressNotification();
        if (!isCancelled()) {
          console.error('截图识别失败:', error);
          const message = OCRI18n.errorMessage(error);
          showNotification(message, 'error');
          announceA11y(`${OCRI18n.t('content_a11y_failed')}: ${message}`);
        }
      } finally {
        finish(sessionId, requestId);
      }
    }

    function cropImage(dataUrl, rect) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          const imageWidth = img.naturalWidth || img.width;
          const imageHeight = img.naturalHeight || img.height;
          const scale = OCRCaptureUtils.computeCropScale(
            imageWidth,
            imageHeight,
            window.innerWidth,
            window.innerHeight
          );

          const sourceLeft = Math.max(0, Math.min(imageWidth - 1, rect.left * scale.x));
          const sourceTop = Math.max(0, Math.min(imageHeight - 1, rect.top * scale.y));
          const sourceWidth = Math.max(0, Math.min(imageWidth - sourceLeft, rect.width * scale.x));
          const sourceHeight = Math.max(0, Math.min(imageHeight - sourceTop, rect.height * scale.y));

          if (sourceWidth < 15 || sourceHeight < 15) {
            reject(new Error(OCRI18n.t('content_msg_selection_small_edit')));
            return;
          }

          const limits = { maxEdge: 4096, maxPixels: 12_000_000 };
          let fitted = OCRCaptureUtils.fitImageWithinLimits(sourceWidth, sourceHeight, limits);
          const maxBase64Length = 3 * 1024 * 1024;

          for (let attempt = 0; attempt < 12; attempt += 1) {
            canvas.width = fitted.width;
            canvas.height = fitted.height;
            ctx.clearRect(0, 0, fitted.width, fitted.height);
            ctx.drawImage(
              img,
              sourceLeft,
              sourceTop,
              sourceWidth,
              sourceHeight,
              0,
              0,
              fitted.width,
              fitted.height
            );

            const normalizedImage = canvas.toDataURL('image/png');
            const base64Payload = normalizedImage.slice(normalizedImage.indexOf(',') + 1);
            if (base64Payload.length <= maxBase64Length) {
              resolve(normalizedImage);
              return;
            }

            const nextScale = Math.min(0.9, Math.sqrt(maxBase64Length / base64Payload.length) * 0.95);
            const nextWidth = Math.floor(fitted.width * nextScale);
            const nextHeight = Math.floor(fitted.height * nextScale);
            if (nextWidth < 15 || nextHeight < 15) break;
            fitted = { width: nextWidth, height: nextHeight };
          }

          reject(new Error(OCRI18n.t('content_msg_selection_small_edit')));
        };
        img.onerror = reject;
        img.src = dataUrl;
      });
    }
    return { run: captureAndRecognize };

  }
  return { create };
}));
