// @ts-check
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRRecognitionService = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(dependencies) {
    const { storage, core: OCRBackgroundCore, config: OCRProviderConfig,
      providers: providerAdapters, requestRegistry: ocrRequestRegistry, historyStore } = dependencies;

    async function handleOCR(imageData, requestId, sendResponse, sender) {
      const effectiveRequestId = requestId || `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const controller = ocrRequestRegistry.start(effectiveRequestId);
      const { signal } = controller;

      try {
        await OCRProviderConfig.migrateLegacyConfigOnce(storage);
        const result = await storage.get([
          'apiProvider', 'apiConfigs', 'prompt', 'language'
        ]);

        const provider = result.apiProvider || 'claude';
        const configs = result.apiConfigs || {};
        const config = providerAdapters.normalizeConfig(
          provider,
          OCRProviderConfig.getProviderConfig(configs, provider),
          { prompt: result.prompt, language: result.language }
        );

        if (!OCRProviderConfig.hasRequiredCredentials(configs, provider)) {
          sendResponse({ success: false, errorCode: 'MISSING_API_KEY', error: 'Missing API configuration' });
          return;
        }

        // 提取base64数据
        const base64Image = imageData.replace(/^data:image\/\w+;base64,/, '');

        const ocrResult = await providerAdapters.recognize(provider, base64Image, config, signal);

        if (signal.aborted) {
          throw new DOMException('OCR request cancelled', 'AbortError');
        }

        // Incognito windows must not leave OCR text or page metadata in persistent
        // extension history.
        const historyResult = OCRBackgroundCore.shouldPersistHistory(sender?.tab)
          ? await OCRBackgroundCore.appendHistoryBestEffort(historyStore, {
            text: ocrResult,
            provider: config.apiProvider,
            language: config.language || 'auto',
            sourceUrl: OCRBackgroundCore.sanitizeSourceUrl(sender?.tab?.url),
            sourceTitle: sender?.tab?.title || ''
          }, signal)
          : { historyId: null };

        sendResponse({
          success: true,
          text: ocrResult,
          historyId: historyResult.historyId,
          ...(historyResult.warningCode ? { warningCode: historyResult.warningCode } : {})
        });
      } catch (error) {
        if (OCRBackgroundCore.isAbortError(error) || signal.aborted) {
          sendResponse({ success: false, cancelled: true, errorCode: 'OCR_CANCELLED', error: 'OCR cancelled' });
          return;
        }
        console.error('OCR识别失败:', error);
        sendResponse({ success: false, error: error.message, errorCode: error.code });
      } finally {
        ocrRequestRegistry.finish(effectiveRequestId, controller);
      }
    }

    async function testAPIConnection(config, sendResponse) {
      try {
        // 320x120 高对比度 PNG，包含清晰的 “OCR TEST” 文本，避免有效配置因空白图被误判。
        const testImage = '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';

        const normalizedConfig = providerAdapters.normalizeConfig(
          config.apiProvider,
          config,
          { prompt: config.prompt, language: config.language }
        );
        await providerAdapters.recognize(config.apiProvider, testImage, normalizedConfig);

        sendResponse({ success: true, message: '连接成功' });
      } catch (error) {
        const interpreted = providerAdapters.interpretConnectionError(config.apiProvider, error);
        if (interpreted?.success) {
          sendResponse({
            ...interpreted,
            message: '连接成功',
          });
          return;
        }
        sendResponse({ success: false, error: error.message, errorCode: error.code });
      }
    }

    return { recognize: handleOCR, testConnection: testAPIConnection,
      cancel: (requestId) => ocrRequestRegistry.cancel(requestId) };
  }

  return { create };
}));
