/**
 * Shared request policy for OCR providers. Kept dependency-free so it can be
 * loaded by the MV3 service worker and exercised directly in Node tests.
 */
(function initRequestRuntime(globalScope) {
  const DEFAULT_POLICY = Object.freeze({
    timeoutMs: 30_000,
    maxAttempts: 2,
    retryStatuses: [429, 502, 503, 504],
    retryDelayMs: 250,
    maxRetryDelayMs: 5_000
  });

  function abortError(message = 'Request cancelled') {
    return new DOMException(message, 'AbortError');
  }

  function timeoutError() {
    const error = new Error('请求超时，请检查网络后重试');
    error.code = 'REQUEST_TIMEOUT';
    return error;
  }

  function responseError(response, message) {
    const error = new Error(message || `HTTP ${response.status}`);
    error.status = response.status;
    return error;
  }

  function retryAfterMs(response, fallbackMs) {
    const value = response.headers?.get('retry-after');
    if (!value) return fallbackMs;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : fallbackMs;
  }

  function waitForRetry(delayMs, signal) {
    if (!delayMs) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, delayMs);
      function done() {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(timer);
        reject(abortError());
      }
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function fetchJsonWithPolicy(fetchImpl, request, policy = {}) {
    const settings = { ...DEFAULT_POLICY, ...policy };
    const attempts = Math.max(1, Math.min(2, settings.maxAttempts));
    const callerSignal = request.signal;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(
      () => timeoutController.abort(timeoutError()),
      settings.timeoutMs
    );

    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (callerSignal?.aborted) throw abortError();
        if (timeoutController.signal.aborted) throw timeoutError();
        const requestController = new AbortController();
        const abortFromCaller = () => requestController.abort(abortError());
        const abortFromTimeout = () => requestController.abort(timeoutError());
        callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
        timeoutController.signal.addEventListener('abort', abortFromTimeout, { once: true });

        try {
          const response = await fetchImpl(request.url, {
            ...request,
            signal: requestController.signal
          });
          if (response.ok) {
            try {
              return await response.json();
            } catch {
              throw new Error('服务器返回了无效的 JSON 数据');
            }
          }
          const shouldRetry = settings.retryStatuses.includes(response.status) && attempt < attempts;
          if (!shouldRetry) throw responseError(response);
          const delayMs = Math.min(
            settings.maxRetryDelayMs,
            retryAfterMs(response, settings.retryDelayMs * (2 ** (attempt - 1)))
          );
          await waitForRetry(delayMs, requestController.signal);
        } catch (error) {
          if (callerSignal?.aborted) throw abortError();
          if (timeoutController.signal.aborted) throw timeoutError();
          if (error?.name === 'AbortError' || error?.code === 'REQUEST_TIMEOUT') throw error;
          const isNetworkFailure = error instanceof TypeError;
          if (!isNetworkFailure || attempt >= attempts) throw error;
          const delayMs = Math.min(
            settings.maxRetryDelayMs,
            settings.retryDelayMs * (2 ** (attempt - 1))
          );
          await waitForRetry(delayMs, requestController.signal);
        } finally {
          callerSignal?.removeEventListener('abort', abortFromCaller);
          timeoutController.signal.removeEventListener('abort', abortFromTimeout);
        }
      }
      throw new Error('网络连接失败，请检查网络或代理设置');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function normalizeOcrText(value) {
    if (typeof value !== 'string') {
      const error = new Error('INVALID_OCR_RESULT: 服务端响应不包含可识别的文本字段');
      error.code = 'INVALID_OCR_RESULT';
      throw error;
    }
    const text = value.trim();
    if (!text) {
      const error = new Error('EMPTY_OCR_RESULT: 未识别到文字，请调整选区后重试');
      error.code = 'EMPTY_OCR_RESULT';
      throw error;
    }
    return text;
  }

  function buildCustomHeaders(config = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const authMode = config.authMode || 'bearer';

    if (authMode === 'none') return headers;
    if (!config.apiKey) {
      throw new Error('自定义 API 认证需要 API Key');
    }
    if (authMode === 'bearer') {
      headers.Authorization = `Bearer ${config.apiKey}`;
      return headers;
    }
    if (authMode === 'api-key') {
      headers['api-key'] = config.apiKey;
      return headers;
    }
    if (authMode === 'custom-header') {
      const headerName = String(config.headerName || '');
      const forbiddenNames = new Set(['host', 'origin', 'content-length']);
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)
        || forbiddenNames.has(headerName.toLowerCase())) {
        throw new Error('自定义 Header 认证需要安全的 Header 名称');
      }
      headers[headerName] = config.apiKey;
      return headers;
    }
    throw new Error(`不支持的认证方式: ${authMode}`);
  }

  function buildCustomRequestBody(config = {}) {
    const model = String(config.model || '').trim();
    const imageUrl = `data:image/png;base64,${config.base64Image || ''}`;
    const prompt = String(config.prompt || '');
    let body;

    if (config.requestMode === 'responses') {
      body = {
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: imageUrl }
          ]
        }],
        max_output_tokens: 4096
      };
    } else {
      body = {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }],
        max_tokens: 4096
      };
    }

    if (model) body.model = model;
    return body;
  }

  function getValueAtPath(value, path) {
    if (!path) return undefined;
    const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
    return String(path).split('.').reduce((current, segment) => {
      if (
        current === undefined
        || current === null
        || forbidden.has(segment)
        || !/^[A-Za-z0-9_-]+$/.test(segment)
      ) {
        return undefined;
      }
      return current[segment];
    }, value);
  }

  function extractCustomText(data, responsePath = '') {
    if (responsePath) {
      return normalizeOcrText(getValueAtPath(data, responsePath));
    }

    const responsesContent = Array.isArray(data?.output)
      ? data.output
        .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
        .find((item) => typeof item?.text === 'string')
        ?.text
      : undefined;
    return normalizeOcrText(
      data?.choices?.[0]?.message?.content
      || data?.choices?.[0]?.delta?.content
      || data?.output_text
      || responsesContent
      || data?.content?.[0]?.text
      || data?.result
      || data?.text
    );
  }

  const api = {
    DEFAULT_POLICY,
    fetchJsonWithPolicy,
    normalizeOcrText,
    buildCustomHeaders,
    buildCustomRequestBody,
    extractCustomText
  };
  globalScope.OCRRequestRuntime = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
