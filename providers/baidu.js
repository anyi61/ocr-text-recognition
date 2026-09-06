// @ts-check
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRBaiduProvider = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(dependencies) {
    const { core: OCRBackgroundCore, requestRuntime: OCRRequestRuntime, fetch } = dependencies;

    // Token and in-flight authentication cache belongs to this adapter instance.
    const baiduTokenCache = new Map();

    async function callBaiduOCR(base64Image, config, signal) {
      const supportedModes = new Set(['general_basic', 'accurate_basic', 'handwriting']);
      const mode = config.mode || 'general_basic';
      if (!supportedModes.has(mode)) {
        throw OCRBackgroundCore.createCodedError(
          'INVALID_PROVIDER_CONFIG',
          `Unsupported Baidu OCR mode: ${mode}`
        );
      }
      const accessToken = await getBaiduAccessToken(config, signal);

      // 调用OCR接口
      try {
        const ocrData = await OCRRequestRuntime.fetchJsonWithPolicy(fetch, {
          url: `https://aip.baidubce.com/rest/2.0/ocr/v1/${mode}?access_token=${encodeURIComponent(accessToken)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `image=${encodeURIComponent(base64Image)}&language_type=${encodeURIComponent(OCRBackgroundCore.getBaiduLanguageType(config.language))}`,
          signal
        });

        if (ocrData.error_code) {
          const error = Object.assign(new Error(`百度OCR错误: ${ocrData.error_code}`), {
            code: String(ocrData.error_code)
          });
          throw error;
        }

        return OCRRequestRuntime.normalizeOcrText(ocrData.words_result?.map((item) => item.words).join('\n'));
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'REQUEST_TIMEOUT') throw error;
        const wrapped = Object.assign(new Error(`百度OCR请求失败: ${error.message}`), {
          code: error.code || 'API_ERROR'
        });
        throw wrapped;
      }
    }

    function baiduCredentialFingerprint(config) {
      return OCRBackgroundCore.createCredentialFingerprint(config.apiKey, config.customSecret);
    }

    function awaitWithAbort(promise, signal) {
      if (!signal) return promise;
      if (signal.aborted) return Promise.reject(new DOMException('OCR request cancelled', 'AbortError'));
      return Promise.race([
        promise,
        new Promise((_, reject) => signal.addEventListener(
          'abort',
          () => reject(new DOMException('OCR request cancelled', 'AbortError')),
          { once: true }
        ))
      ]);
    }

    async function getBaiduAccessToken(config, signal) {
      const cacheKey = baiduCredentialFingerprint(config);
      const existing = baiduTokenCache.get(cacheKey);
      if (existing?.token && existing.expiresAt > Date.now()) return awaitWithAbort(Promise.resolve(existing.token), signal);
      if (existing?.promise) return awaitWithAbort(existing.promise, signal);

      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.apiKey,
        client_secret: config.customSecret || ''
      });
      const promise = OCRRequestRuntime.fetchJsonWithPolicy(fetch, {
        url: `https://aip.baidubce.com/oauth/2.0/token?${params.toString()}`,
        method: 'POST'
      }).then((data) => {
        if (data.error) throw new Error(`百度认证失败: ${data.error}`);
        if (!data.access_token) throw new Error('未能获取百度access_token，请检查API Key和Secret');
        const expiresInMs = Math.max(0, Number(data.expires_in || 0) * 1000 - 60_000);
        baiduTokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + expiresInMs });
        return data.access_token;
      }).catch((error) => {
        baiduTokenCache.delete(cacheKey);
        throw error;
      });
      baiduTokenCache.set(cacheKey, { promise });
      return awaitWithAbort(promise, signal);
    }

    return { recognize: callBaiduOCR };
  }

  return { create };
}));
