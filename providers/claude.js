// @ts-check
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRClaudeProvider = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(dependencies) {
    const { core: OCRBackgroundCore, requestRuntime: OCRRequestRuntime, transport } = dependencies;
    const { apiRequest, buildOpenAIRequestBody } = transport;

    async function callClaudeAPI(base64Image, config, signal) {
      const model = config.model || 'claude-sonnet-5';
      const prompt = OCRBackgroundCore.buildRecognitionPrompt(config.prompt, config.language);

      const body = buildOpenAIRequestBody(model, prompt, base64Image);
      // Claude 使用不同的图片格式
      body.messages[0].content[1] = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: base64Image
        }
      };

      const data = await apiRequest(
        'https://api.anthropic.com/v1/messages',
        {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body,
        'Claude API错误',
        signal
      );

      OCRBackgroundCore.assertOcrResponseComplete('claude', data);
      return OCRRequestRuntime.normalizeOcrText(OCRBackgroundCore.extractClaudeText(data));
    }

    return { recognize: callClaudeAPI };
  }

  return { create };
}));
