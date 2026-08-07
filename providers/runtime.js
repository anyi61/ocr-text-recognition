'use strict';

// Provider request implementations run in the service worker global scope.
const baiduTokenCache = new Map();

/**
 * 通用 API 请求函数
 * @async
 * @param {string} endpoint - API 端点URL
 * @param {Object} headers - 请求头对象
 * @param {Object} body - 请求体对象
 * @param {string} errorPrefix - 错误信息前缀
 * @returns {Promise<Object>} 返回解析后的 JSON 数据
 * @throws {Error} 网络错误或API错误时抛出
 * @description 统一处理网络错误、响应检查、错误解析和 JSON 解析
 */
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
    const wrapped = new Error(`${errorPrefix}: ${error.message}`);
    wrapped.code = error.code || 'API_ERROR';
    throw wrapped;
  }
}

/**
 * 构建 OpenAI 兼容格式的请求体
 * @param {string} model - 模型名称
 * @param {string} prompt - 提示词
 * @param {string} base64Image - base64 编码的图片
 * @returns {Object} OpenAI兼容格式的请求体
 */
function buildOpenAIRequestBody(model, prompt, base64Image, preferMaxCompletionTokens = false) {
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

/**
 * 调用 Claude API
 * @async
 * @param {string} base64Image - base64编码的图片
 * @param {APIConfig} config - API配置
 * @returns {Promise<string>} 识别结果文本
 * @throws {Error} API调用失败时抛出
 */
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

/**
 * 调用 OpenAI API
 * @async
 * @param {string} base64Image - base64编码的图片
 * @param {APIConfig} config - API配置
 * @returns {Promise<string>} 识别结果文本
 * @throws {Error} API调用失败时抛出
 */
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

/**
 * 调用百度OCR API
 * @async
 * @param {string} base64Image - base64编码的图片
 * @param {APIConfig} config - API配置
 * @returns {Promise<string>} 识别结果文本
 * @throws {Error} API调用失败时抛出
 * @description 需要先获取access_token，然后调用OCR接口
 */
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
      const error = new Error(`百度OCR错误: ${ocrData.error_code}`);
      error.code = String(ocrData.error_code);
      throw error;
    }

    return OCRRequestRuntime.normalizeOcrText(ocrData.words_result?.map((item) => item.words).join('\n'));
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'REQUEST_TIMEOUT') throw error;
    const wrapped = new Error(`百度OCR请求失败: ${error.message}`);
    wrapped.code = error.code || 'API_ERROR';
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

/**
 * 调用自定义API
 * @async
 * @param {string} base64Image - base64编码的图片
 * @param {APIConfig} config - API配置
 * @returns {Promise<string>} 识别结果文本
 * @throws {Error} API调用失败时抛出
 * @description 支持任何OpenAI格式API，自动适配多种响应格式
 */
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

/**
 * 调用阿里云 OCR API (DashScope兼容模式)
 * @async
 * @param {string} base64Image - base64编码的图片
 * @param {APIConfig} config - API配置
 * @returns {Promise<string>} 识别结果文本
 * @throws {Error} API调用失败时抛出
 */
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

/**
 * 调用智谱AI GLM-4V API
 * @async
 * @param {string} base64Image - base64编码的图片
 * @param {APIConfig} config - API配置
 * @returns {Promise<string>} 识别结果文本
 * @throws {Error} API调用失败时抛出
 * @description 智谱API不支持max_tokens参数，需要特殊处理
 */
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

/**
 * 调用通用OpenAI兼容API
 * @async
 * @param {string} base64Image - base64编码的图片
 * @param {APIConfig} config - API配置
 * @returns {Promise<string>} 识别结果文本
 * @throws {Error} API调用失败时抛出
 * @description 兼容多种响应格式，支持硅基流动、DeepSeek等服务商
 */
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
