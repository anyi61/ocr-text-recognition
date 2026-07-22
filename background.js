/**
 * @fileoverview background.js - OCR文字识别助手后台服务工作线程
 * @description 处理截图、OCR识别请求、API调用和历史记录管理
 */

importScripts(
  'provider-config.js',
  'extension-runtime.js',
  'background-core.js',
  'request-runtime.js',
  'history-store.js'
);

const ocrRequestRegistry = OCRBackgroundCore.createRequestRegistry();
const baiduTokenCache = new Map();
const historyStore = OCRHistoryStore.create(chrome.storage.local, { limit: 50 });
const backgroundMessage = (key, fallback) => chrome.i18n?.getMessage(key) || fallback;

if (typeof chrome.storage.local.setAccessLevel === 'function') {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch((error) => console.error('无法限制本地存储访问范围:', error));
}

/**
 * API配置对象
 * @typedef {Object} APIConfig
 * @property {string} apiProvider - API提供商类型
 * @property {string} apiKey - API密钥
 * @property {string} [model] - 模型名称
 * @property {string} [customEndpoint] - 自定义API端点
 * @property {string} [customSecret] - 自定义Secret（百度OCR）
 * @property {string} [customModel] - 自定义模型名称
 * @property {string} [prompt] - 提示词
 * @property {string} [language] - 语言设置
 */

/**
 * OCR历史记录项
 * @typedef {Object} OCRHistoryItem
 * @property {number} id - 记录ID（时间戳）
 * @property {string} text - 识别结果文本
 * @property {number} timestamp - 时间戳
 * @property {string} date - 格式化日期字符串
 */

/**
 * OCR识别结果
 * @typedef {Object} OCRResult
 * @property {boolean} success - 是否成功
 * @property {string} [text] - 识别到的文本（成功时）
 * @property {string} [error] - 错误信息（失败时）
 */

/**
 * 安装时初始化
 * @listens chrome.runtime.onInstalled
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log('OCR文字识别助手已安装');
  // 初始化默认设置
  chrome.storage.local.get(['apiProvider', 'model', 'language'], (result) => {
    if (!result.apiProvider) {
      chrome.storage.local.set({
        apiProvider: 'claude',
        model: 'claude-sonnet-5',
        language: 'auto',
        prompt: '请识别图片中的文字内容，只返回识别到的纯文字，不要添加任何解释或额外说明。'
      });
    }
  });
});

// 处理消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureVisibleTab') {
    handleCapture(sendResponse, sender);
    return true; // 保持消息通道开启
  }

  if (request.action === 'performOCR') {
    handleOCR(request.imageData, request.requestId, sendResponse, sender);
    return true;
  }

  if (request.action === 'cancelOCR') {
    const cancelled = ocrRequestRegistry.cancel(request.requestId);
    sendResponse({ success: true, cancelled });
    return true;
  }

  if (request.action === 'testAPI') {
    testAPIConnection(request.config, sendResponse);
    return true;
  }

  if (request.action === 'getContentPreferences') {
    chrome.storage.local.get(['theme', 'uiLanguage'])
      .then((preferences) => sendResponse({ success: true, ...preferences }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (request.action === 'updateHistoryRecord') {
    historyStore.updateText(request.historyId, request.text)
      .then((updated) => sendResponse({ success: updated }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'deleteHistoryRecord') {
    historyStore.delete(request.historyId)
      .then((deleted) => sendResponse({ success: deleted }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'clearHistory') {
    historyStore.clear()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

/**
 * 处理截图请求
 * @async
 * @param {Function} sendResponse - Chrome消息回调函数
 * @returns {Promise<void>}
 */
async function handleCapture(sendResponse, sender) {
  try {
    if (!sender.tab || !Number.isInteger(sender.tab.id) || !Number.isInteger(sender.tab.windowId)) {
      throw OCRBackgroundCore.createCodedError('CAPTURE_TAB_CHANGED', 'Invalid capture tab');
    }
    const [activeBefore] = await chrome.tabs.query({
      active: true,
      windowId: sender.tab.windowId
    });
    if (!OCRBackgroundCore.isSameTabIdentity(sender.tab, activeBefore)) {
      throw OCRBackgroundCore.createCodedError('CAPTURE_TAB_CHANGED', 'Active tab changed');
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {
      format: 'png',
      quality: 100
    });
    const [activeAfter] = await chrome.tabs.query({
      active: true,
      windowId: sender.tab.windowId
    });
    if (!OCRBackgroundCore.isSameTabIdentity(sender.tab, activeAfter)) {
      throw OCRBackgroundCore.createCodedError('CAPTURE_TAB_CHANGED', 'Active tab changed');
    }
    sendResponse({ dataUrl });
  } catch (error) {
    console.error('截图失败:', error);
    sendResponse({ error: error.message, errorCode: error.code });
  }
}

/**
 * 处理OCR识别请求
 * @async
 * @param {string} imageData - Base64编码的图片数据
 * @param {string} requestId - 本次OCR请求ID
 * @param {Function} sendResponse - Chrome消息回调函数
 * @returns {Promise<void>}
 * @description 根据配置调用对应的API进行OCR识别，并保存历史记录
 */
async function handleOCR(imageData, requestId, sendResponse, sender) {
  const effectiveRequestId = requestId || `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const controller = ocrRequestRegistry.start(effectiveRequestId);
  const { signal } = controller;

  try {
    // 获取配置 - 优先从新的 apiConfigs 结构读取
    const result = await chrome.storage.local.get([
      'apiProvider', 'apiConfigs', 'prompt', 'language',
      // 以下是为了兼容旧版本配置
      'apiKey', 'model', 'customEndpoint', 'customModel', 'customSecret',
      'openaiApiKey', 'openaiModel', 'baiduApiKey',
      'aliyunApiKey', 'aliyunModel', 'zhipuApiKey', 'zhipuModel',
      'compatibleEndpoint', 'compatibleApiKey', 'compatibleModel',
      'customApiKey'
    ]);

    const provider = result.apiProvider || 'claude';
    const configs = result.apiConfigs || {};

    // 根据API提供商获取对应配置（优先使用新结构，兼容旧结构）
    let config = { prompt: result.prompt, language: result.language };

    switch (provider) {
      case 'claude': {
        const claude = OCRProviderConfig.getProviderConfig(configs, provider);
        config.apiKey = claude.apiKey || result.apiKey;
        config.model = claude.model || result.model || 'claude-sonnet-5';
        break;
      }
      case 'openai': {
        const openai = OCRProviderConfig.getProviderConfig(configs, provider);
        config.apiKey = openai.apiKey || result.openaiApiKey;
        config.model = openai.model || result.openaiModel || 'gpt-5-mini';
        break;
      }
      case 'baidu': {
        const baidu = OCRProviderConfig.getProviderConfig(configs, provider);
        config.apiKey = baidu.apiKey || result.baiduApiKey;
        config.customSecret = baidu.secret || result.customSecret;
        break;
      }
      case 'aliyun': {
        const aliyun = OCRProviderConfig.getProviderConfig(configs, provider);
        config.apiKey = aliyun.apiKey || result.aliyunApiKey;
        config.customModel = aliyun.model || result.aliyunModel || 'qwen-vl-max';
        config.model = config.customModel;
        break;
      }
      case 'zhipu': {
        const zhipu = OCRProviderConfig.getProviderConfig(configs, provider);
        config.apiKey = zhipu.apiKey || result.zhipuApiKey;
        config.model = zhipu.model || result.zhipuModel || 'glm-4v';
        break;
      }
      case 'openai-compatible': {
        const compatible = OCRProviderConfig.getProviderConfig(configs, provider);
        config.apiKey = compatible.apiKey || result.compatibleApiKey;
        config.customEndpoint = compatible.endpoint || result.compatibleEndpoint;
        config.customModel = compatible.model || result.compatibleModel;
        config.model = config.customModel;
        break;
      }
      case 'custom': {
        const custom = OCRProviderConfig.getProviderConfig(configs, provider);
        config.apiKey = custom.apiKey || result.customApiKey;
        config.customEndpoint = custom.endpoint || result.customEndpoint;
        config.customModel = custom.model || result.customModel;
        config.model = config.customModel;
        config.requestMode = custom.requestMode;
        config.authMode = custom.authMode;
        config.headerName = custom.headerName || '';
        config.responsePath = custom.responsePath || '';
        break;
      }
    }

    config.apiProvider = provider;
    config.model = OCRProviderConfig.migrateRetiredModel(provider, config.model);

    if (!OCRProviderConfig.hasRequiredCredentials(configs, provider, result)) {
      sendResponse({ success: false, errorCode: 'MISSING_API_KEY', error: 'Missing API configuration' });
      return;
    }

    // 提取base64数据
    const base64Image = imageData.replace(/^data:image\/\w+;base64,/, '');

    let ocrResult;
    switch (config.apiProvider) {
      case 'claude':
        ocrResult = await callClaudeAPI(base64Image, config, signal);
        break;
      case 'openai':
        ocrResult = await callOpenAIAPI(base64Image, config, signal);
        break;
      case 'baidu':
        ocrResult = await callBaiduOCR(base64Image, config, signal);
        break;
      case 'custom':
        ocrResult = await callCustomAPI(base64Image, config, signal);
        break;
      case 'aliyun':
        ocrResult = await callAliyunOCR(base64Image, config, signal);
        break;
      case 'zhipu':
        ocrResult = await callZhipuAPI(base64Image, config, signal);
        break;
      case 'openai-compatible':
        ocrResult = await callOpenAICompatibleAPI(base64Image, config, signal);
        break;
      default:
        throw OCRBackgroundCore.createCodedError('UNKNOWN_PROVIDER', 'Unknown API provider');
    }

    if (signal.aborted) {
      throw new DOMException('OCR request cancelled', 'AbortError');
    }

    // 保存到串行历史存储，保留识别上下文供检索和修订。
    const historyResult = await OCRBackgroundCore.appendHistoryBestEffort(historyStore, {
      text: ocrResult,
      provider: config.apiProvider,
      language: config.language || 'auto',
      sourceUrl: OCRBackgroundCore.sanitizeSourceUrl(sender?.tab?.url),
      sourceTitle: sender?.tab?.title || ''
    }, signal);

    sendResponse({
      success: true,
      text: ocrResult,
      historyId: historyResult.historyId,
      ...(historyResult.warningCode ? { warningCode: historyResult.warningCode } : {})
    });
  } catch (error) {
    if (OCRBackgroundCore.isAbortError(error) || signal.aborted) {
      sendResponse({ success: false, cancelled: true, errorCode: 'OCR_CANCELLED', error: 'OCR cancelled' });
      return;
    }
    console.error('OCR识别失败:', error);
    sendResponse({ success: false, error: error.message, errorCode: error.code });
  } finally {
    ocrRequestRegistry.finish(effectiveRequestId, controller);
  }
}

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
  const accessToken = await getBaiduAccessToken(config, signal);

  // 调用OCR接口
  try {
    const ocrData = await OCRRequestRuntime.fetchJsonWithPolicy(fetch, {
      url: `https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic?access_token=${encodeURIComponent(accessToken)}`,
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

/**
 * 测试API连接
 * @async
 * @param {APIConfig} config - API配置
 * @param {Function} sendResponse - Chrome消息回调函数
 * @returns {Promise<void>}
 * @description 使用测试图片调用对应的API验证配置是否正确
 */
async function testAPIConnection(config, sendResponse) {
  try {
    // 320x120 高对比度 PNG，包含清晰的 “OCR TEST” 文本，避免有效配置因空白图被误判。
    const testImage = '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';

    // 标准化配置，确保字段名正确
    const normalizedConfig = { ...config };

    // 根据提供商标准化配置字段
    switch (config.apiProvider) {
      case 'aliyun':
        normalizedConfig.apiKey = config.apiKey;
        normalizedConfig.customModel = config.customModel || config.model || 'qwen-vl-max';
        break;
      case 'openai':
        normalizedConfig.model = config.model || 'gpt-5-mini';
        break;
      case 'zhipu':
        normalizedConfig.model = config.model || 'glm-4v';
        break;
      case 'openai-compatible':
        normalizedConfig.customEndpoint = config.customEndpoint;
        normalizedConfig.customModel = config.customModel || config.model;
        break;
      case 'custom':
        normalizedConfig.customEndpoint = config.customEndpoint;
        normalizedConfig.customModel = config.customModel || config.model;
        normalizedConfig.requestMode = config.requestMode || 'chat-completions';
        normalizedConfig.authMode = config.authMode || 'bearer';
        normalizedConfig.headerName = config.headerName || '';
        normalizedConfig.responsePath = config.responsePath || '';
        break;
    }

    switch (config.apiProvider) {
      case 'claude':
        await callClaudeAPI(testImage, normalizedConfig);
        break;
      case 'openai':
        await callOpenAIAPI(testImage, normalizedConfig);
        break;
      case 'baidu':
        await callBaiduOCR(testImage, normalizedConfig);
        break;
      case 'custom':
        await callCustomAPI(testImage, normalizedConfig);
        break;
      case 'aliyun':
        await callAliyunOCR(testImage, normalizedConfig);
        break;
      case 'zhipu':
        await callZhipuAPI(testImage, normalizedConfig);
        break;
      case 'openai-compatible':
        await callOpenAICompatibleAPI(testImage, normalizedConfig);
        break;
      default:
        throw new Error('未知的API提供商');
    }

    sendResponse({ success: true, message: '连接成功' });
  } catch (error) {
    // 216630 表示测试图片识别失败；此时鉴权和 OCR 接口连接均已成功。
    // 正式识别仍由 callBaiduOCR 抛出该错误，避免隐藏真实图片的识别故障。
    if (config.apiProvider === 'baidu' && String(error.code) === '216630') {
      sendResponse({
        success: true,
        message: '连接成功',
        warningCode: 'BAIDU_TEST_IMAGE_RECOGNIZE_ERROR'
      });
      return;
    }
    sendResponse({ success: false, error: error.message, errorCode: error.code });
  }
}

/**
 * 监听键盘快捷键
 * @listens chrome.commands.onCommand
 * @param {string} command - 命令名称
 * @description 处理 start-capture 命令，启动截图识别模式
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'start-capture') {
    try {
      // 获取当前活动标签页
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        console.error('无法获取当前标签页');
        return;
      }

      // 检查是否已配置API
      const result = await chrome.storage.local.get([
        'apiProvider', 'apiConfigs',
        'apiKey', 'model',
        'openaiApiKey', 'openaiModel',
        'baiduApiKey', 'customSecret',
        'aliyunApiKey', 'aliyunModel',
        'zhipuApiKey', 'zhipuModel',
        'compatibleEndpoint', 'compatibleApiKey', 'compatibleModel',
        'customEndpoint', 'customApiKey', 'customModel'
      ]);
      const provider = result.apiProvider || 'claude';
      const hasApiKey = OCRProviderConfig.hasRequiredCredentials(
        result.apiConfigs,
        provider,
        result
      );

      if (!hasApiKey) {
        // 显示通知提示用户配置API
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: backgroundMessage('ext_name', 'OCR'),
          message: backgroundMessage('notification_config_required', 'Configure an API first')
        });
        return;
      }

      if (provider === 'openai-compatible' || provider === 'custom') {
        const config = OCRProviderConfig.getProviderConfig(result.apiConfigs, provider);
        const legacyEndpoint = provider === 'openai-compatible'
          ? result.compatibleEndpoint
          : result.customEndpoint;
        const hasEndpointPermission = await OCRExtensionRuntime.hasEndpointPermission(
          chrome,
          provider,
          config.endpoint || legacyEndpoint
        );

        if (!hasEndpointPermission) {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: backgroundMessage('ext_name', 'OCR'),
            message: backgroundMessage('notification_endpoint_permission_required', 'Authorize the API domain first')
          });
          return;
        }
      }

      await OCRExtensionRuntime.startCaptureInTab(chrome, tab);
    } catch (error) {
      console.error('快捷键启动截图失败:', error);
      const unsupportedMessages = {
        browser_internal: backgroundMessage('msg_capture_browser_internal', 'Capture is unavailable on browser pages'),
        browser_store: backgroundMessage('msg_capture_browser_store', 'Capture is unavailable in the extension store'),
        file_access: backgroundMessage('msg_capture_file_access', 'Enable file URL access and try again')
      };
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: backgroundMessage('ext_name', 'OCR'),
        message: unsupportedMessages[error?.reason]
          || backgroundMessage('notification_capture_unavailable', 'Capture is unavailable on this page')
      });
    }
  }
});
