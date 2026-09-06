// @ts-check
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRCustomProvider = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(dependencies) {
    const { core: OCRBackgroundCore, requestRuntime: OCRRequestRuntime, transport } = dependencies;
    const { apiRequest, buildOpenAIRequestBody } = transport;

    async function callCustomAPI(base64Image, config, signal) {
      const endpoint = config.customEndpoint;
      const model = config.customModel || '';
      const prompt = OCRBackgroundCore.buildRecognitionPrompt(
        config.prompt || '请识别图片中的文字内容',
        config.language
      );

      if (!endpoint) {
        throw new Error('未配置自定义API端点');
      }

      const data = await apiRequest(
        endpoint,
        OCRRequestRuntime.buildCustomHeaders(config),
        OCRRequestRuntime.buildCustomRequestBody({
          requestMode: config.requestMode,
          model,
          prompt,
          base64Image
        }),
        '自定义API错误',
        signal
      );

      OCRBackgroundCore.assertOcrResponseComplete('custom', data);
      return OCRRequestRuntime.extractCustomText(data, config.responsePath);
    }

    return { recognize: callCustomAPI };
  }

  return { create };
}));
