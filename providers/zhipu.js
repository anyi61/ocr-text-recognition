// @ts-check
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRZhipuProvider = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(dependencies) {
    const { core: OCRBackgroundCore, requestRuntime: OCRRequestRuntime, transport } = dependencies;
    const { apiRequest, buildOpenAIRequestBody } = transport;

    async function callZhipuAPI(base64Image, config, signal) {
      const model = config.model || 'glm-4v';
      const prompt = OCRBackgroundCore.buildRecognitionPrompt(config.prompt, config.language);

      // 智谱API不支持 max_tokens 参数，需要手动构建请求体
      const body = {
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${base64Image}`
              }
            }
          ]
        }]
      };

      const data = await apiRequest(
        'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        body,
        '智谱AI错误',
        signal
      );

      OCRBackgroundCore.assertOcrResponseComplete('zhipu', data);
      return OCRRequestRuntime.normalizeOcrText(data.choices?.[0]?.message?.content);
    }

    return { recognize: callZhipuAPI };
  }

  return { create };
}));
