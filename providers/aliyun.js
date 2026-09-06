// @ts-check
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRAliyunProvider = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(dependencies) {
    const { core: OCRBackgroundCore, requestRuntime: OCRRequestRuntime, transport } = dependencies;
    const { apiRequest, buildOpenAIRequestBody } = transport;

    async function callAliyunOCR(base64Image, config, signal) {
      const apiKey = config.apiKey;

      if (!apiKey) {
        throw new Error('阿里云OCR需要API Key');
      }

      const model = config.customModel || 'qwen-vl-max';
      const prompt = OCRBackgroundCore.buildRecognitionPrompt(config.prompt, config.language);

      const data = await apiRequest(
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        buildOpenAIRequestBody(model, prompt, base64Image),
        '阿里云OCR错误',
        signal
      );

      OCRBackgroundCore.assertOcrResponseComplete('aliyun', data);
      return OCRRequestRuntime.normalizeOcrText(data.choices?.[0]?.message?.content);
    }

    return { recognize: callAliyunOCR };
  }

  return { create };
}));
