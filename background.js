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
    if (!sender.tab || !Number.isInteger(sender.tab.windowId)) {
      throw new Error('截图请求必须来自有效的网页标签页');
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {
      format: 'png',
      quality: 100
    });
    sendResponse({ dataUrl });
  } catch (error) {
    console.error('截图失败:', error);
    sendResponse({ error: error.message });
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
      sendResponse({ success: false, error: '未配置API密钥' });
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
        throw new Error('未知的API提供商');
    }

    if (signal.aborted) {
      throw new DOMException('OCR request cancelled', 'AbortError');
    }

    // 保存到串行历史存储，保留识别上下文供检索和修订。
    const historyRecord = await historyStore.append({
      text: ocrResult,
      provider: config.apiProvider,
      language: config.language || 'auto',
      sourceUrl: sender?.tab?.url || '',
      sourceTitle: sender?.tab?.title || ''
    }, signal);
    OCRBackgroundCore.throwIfAborted(signal);

    sendResponse({
      success: true,
      text: ocrResult,
      historyId: historyRecord.id
    });
  } catch (error) {
    if (OCRBackgroundCore.isAbortError(error) || signal.aborted) {
      sendResponse({ success: false, cancelled: true, error: '识别已取消' });
      return;
    }
    console.error('OCR识别失败:', error);
    sendResponse({ success: false, error: error.message });
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
      throw new Error('网络连接失败，请检查网络或代理设置');
    }
    throw new Error(`${errorPrefix}: ${error.message}`);
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

  return OCRRequestRuntime.normalizeOcrText(data.content?.[0]?.text);
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
      throw new Error(`百度OCR错误: ${ocrData.error_code}`);
    }

    return OCRRequestRuntime.normalizeOcrText(ocrData.words_result?.map((item) => item.words).join('\n'));
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'REQUEST_TIMEOUT') throw error;
    throw new Error(`百度OCR请求失败: ${error.message}`);
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
    // 使用一个50x50像素的测试图片（纯蓝色），满足百度OCR最小尺寸要求（15x15）
    const testImage = 'iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAIAAACRXR/mAAAAaklEQVR4nM3OQQEAIBCAMCSawQxsCgvcX5Zga59LjyRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkr8Dswfy9AIOoZwhhQAAAABJRU5ErkJggg==';

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
    sendResponse({ success: false, error: error.message });
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
          title: 'OCR文字识别助手',
          message: '请先配置API密钥后再使用快捷键截图'
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
            title: 'OCR文字识别助手',
            message: '请先在插件弹窗中授权访问自定义 API 域名'
          });
          return;
        }
      }

      await OCRExtensionRuntime.startCaptureInTab(chrome, tab);
    } catch (error) {
      console.error('快捷键启动截图失败:', error);
      const unsupportedMessages = {
        browser_internal: '浏览器内部页面禁止扩展截图，请切换到普通网页后重试',
        browser_store: '扩展商店页面禁止脚本注入，请切换到普通网页后重试',
        file_access: '请在扩展管理页开启“允许访问文件网址”后重试'
      };
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'OCR文字识别助手',
        message: unsupportedMessages[error?.reason]
          || '当前页面无法启动截图，请切换到普通网页后重试'
      });
    }
  }
});
