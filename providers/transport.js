// @ts-check
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRProviderTransport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(dependencies) {
    const { core: OCRBackgroundCore, requestRuntime: OCRRequestRuntime, fetch } = dependencies;

    async function apiRequest(endpoint, headers, body, errorPrefix, signal) {
      try {
        return await OCRRequestRuntime.fetchJsonWithPolicy(fetch, {
          url: endpoint,
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal
        });
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'REQUEST_TIMEOUT') {
          throw error;
        }
        if (error?.name === 'TypeError') {
          throw OCRBackgroundCore.createCodedError('NETWORK_ERROR', 'Network request failed');
        }
        const wrapped = Object.assign(new Error(`${errorPrefix}: ${error.message}`), {
          code: error.code || 'API_ERROR'
        });
        throw wrapped;
      }
    }

    function buildOpenAIRequestBody(model, prompt, base64Image, preferMaxCompletionTokens = false) {
      /** @type {any} */
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

      if (preferMaxCompletionTokens && /^(gpt-5|o[1-9])/.test(model)) {
        body.max_completion_tokens = 4096;
      } else {
        body.max_tokens = 4096;
      }

      return body;
    }

    return { apiRequest, buildOpenAIRequestBody };
  }

  return { create };
}));
