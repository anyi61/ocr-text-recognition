// @ts-check
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCROpenAIProvider = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(dependencies) {
    const { core: OCRBackgroundCore, requestRuntime: OCRRequestRuntime, transport } = dependencies;
    const { apiRequest, buildOpenAIRequestBody } = transport;

    async function callOpenAIAPI(base64Image, config, signal) {
      const model = config.model || 'gpt-5-mini';
      const prompt = OCRBackgroundCore.buildRecognitionPrompt(config.prompt, config.language);

      const data = await apiRequest(
        'https://api.openai.com/v1/chat/completions',
        {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        buildOpenAIRequestBody(model, prompt, base64Image, true),
        'OpenAI API错误',
        signal
      );

      OCRBackgroundCore.assertOcrResponseComplete('openai', data);
      return OCRRequestRuntime.normalizeOcrText(data.choices?.[0]?.message?.content);
    }

    return { recognize: callOpenAIAPI };
  }

  return { create };
}));
