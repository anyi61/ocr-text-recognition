// @ts-check
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCROpenAICompatibleProvider = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(dependencies) {
    const { core: OCRBackgroundCore, requestRuntime: OCRRequestRuntime, transport } = dependencies;
    const { apiRequest, buildOpenAIRequestBody } = transport;

    async function callOpenAICompatibleAPI(base64Image, config, signal) {
      const endpoint = config.customEndpoint || 'https://api.openai.com/v1/chat/completions';
      const model = config.customModel || 'gpt-5-mini';
      const prompt = OCRBackgroundCore.buildRecognitionPrompt(config.prompt, config.language);

      if (!endpoint) {
        throw new Error('未配置API端点');
      }

      const data = await apiRequest(
        endpoint,
        {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        buildOpenAIRequestBody(model, prompt, base64Image),
        'API错误',
        signal
      );

      // 兼容不同格式的响应
      OCRBackgroundCore.assertOcrResponseComplete('openai-compatible', data);
      return OCRRequestRuntime.normalizeOcrText(data.choices?.[0]?.message?.content
        || data.choices?.[0]?.delta?.content
        || data.content?.[0]?.text
        || data.result
        || data.text);
    }

    return { recognize: callOpenAICompatibleAPI };
  }

  return { create };
}));
