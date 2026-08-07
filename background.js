/**
 * @fileoverview background.js - OCR文字识别助手后台服务工作线程
 * @description 处理截图、OCR识别请求、API调用和历史记录管理
 */

importScripts(
  'provider-config.js',
  'extension-runtime.js',
  'background-core.js',
  'background-message-router.js',
  'request-runtime.js',
  'history-store.js',
  'providers/runtime.js',
  'providers/registry.js'
);

const ocrRequestRegistry = OCRBackgroundCore.createRequestRegistry();
const historyStore = OCRHistoryStore.create(chrome.storage.local, { limit: 50 });
const backgroundMessage = (key, fallback) => chrome.i18n?.getMessage(key) || fallback;
const UPLOAD_NOTICE_VERSION = 1;
const providerAdapters = OCRProviderAdapters.create({
  claude: callClaudeAPI,
  openai: callOpenAIAPI,
  baidu: callBaiduOCR,
  aliyun: callAliyunOCR,
  zhipu: callZhipuAPI,
  'openai-compatible': callOpenAICompatibleAPI,
  custom: callCustomAPI
}, {
  migrateRetiredModel: OCRProviderConfig.migrateRetiredModel,
  createUnknownProviderError: () => (
    OCRBackgroundCore.createCodedError('UNKNOWN_PROVIDER', 'Unknown API provider')
  )
});

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
chrome.runtime.onInstalled.addListener((details) => {
  console.log('OCR文字识别助手已安装');
  (async () => {
    await OCRProviderConfig.migrateLegacyConfigOnce(chrome.storage.local);
    const result = await chrome.storage.local.get([
      'apiProvider', 'apiConfigs', 'language', 'uploadNoticeAcknowledgedVersion'
    ]);
    if (!result.apiProvider) {
      await chrome.storage.local.set({
        apiProvider: 'claude',
        apiConfigs: {
          ...(result.apiConfigs || {}),
          claude: { apiKey: '', model: 'claude-sonnet-5' }
        },
        language: 'auto',
        prompt: '请识别图片中的文字内容，只返回识别到的纯文字，不要添加任何解释或额外说明。'
      });
    }

    // Existing users have already used the upload flow. Preserve that workflow
    // on upgrade while requiring explicit consent from new installations.
    if (
      details?.reason === 'update'
      && !Number.isInteger(result.uploadNoticeAcknowledgedVersion)
    ) {
      await chrome.storage.local.set({
        uploadNoticeAcknowledgedVersion: UPLOAD_NOTICE_VERSION
      });
    }
  })().catch((error) => {
    console.error('初始化扩展配置失败:', error);
  });
});

const messageHandlers = {
  captureVisibleTab(request, sender, sendResponse) {
    handleCapture(sendResponse, sender);
    return true;
  },
  performOCR(request, sender, sendResponse) {
    handleOCR(request.imageData, request.requestId, sendResponse, sender);
    return true;
  },
  cancelOCR(request, _sender, sendResponse) {
    const cancelled = ocrRequestRegistry.cancel(request.requestId);
    sendResponse({ success: true, cancelled });
  },
  testAPI(request, _sender, sendResponse) {
    testAPIConnection(request.config, sendResponse);
    return true;
  },
  getContentPreferences(_request, _sender, sendResponse) {
    chrome.storage.local.get(['theme', 'uiLanguage'])
      .then((preferences) => sendResponse({ success: true, ...preferences }))
      .catch(() => sendResponse({ success: false }));
    return true;
  },
  getUploadNoticeState(_request, _sender, sendResponse) {
    chrome.storage.local.get(['uploadNoticeAcknowledgedVersion', 'apiProvider'])
      .then((stored) => sendResponse({
        success: true,
        acknowledged: stored.uploadNoticeAcknowledgedVersion >= UPLOAD_NOTICE_VERSION,
        provider: stored.apiProvider || 'claude',
        version: UPLOAD_NOTICE_VERSION
      }))
      .catch(() => sendResponse({ success: false }));
    return true;
  },
  acknowledgeUploadNotice(_request, _sender, sendResponse) {
    chrome.storage.local.set({ uploadNoticeAcknowledgedVersion: UPLOAD_NOTICE_VERSION })
      .then(() => sendResponse({ success: true, version: UPLOAD_NOTICE_VERSION }))
      .catch(() => sendResponse({ success: false }));
    return true;
  },
  updateHistoryRecord(request, _sender, sendResponse) {
    historyStore.updateText(request.historyId, request.text)
      .then((updated) => sendResponse({ success: updated }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  },
  listHistory(_request, _sender, sendResponse) {
    historyStore.list()
      .then((records) => sendResponse({ success: true, records }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  },
  deleteHistoryRecord(request, _sender, sendResponse) {
    historyStore.delete(request.historyId)
      .then((deleted) => sendResponse({ success: deleted }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  },
  clearHistory(_request, _sender, sendResponse) {
    historyStore.clear()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
};

chrome.runtime.onMessage.addListener(
  OCRBackgroundMessageRouter.create(messageHandlers)
);

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
    await OCRProviderConfig.migrateLegacyConfigOnce(chrome.storage.local);
    const result = await chrome.storage.local.get([
      'apiProvider', 'apiConfigs', 'prompt', 'language'
    ]);

    const provider = result.apiProvider || 'claude';
    const configs = result.apiConfigs || {};
    const config = providerAdapters.normalizeConfig(
      provider,
      OCRProviderConfig.getProviderConfig(configs, provider),
      { prompt: result.prompt, language: result.language }
    );

    if (!OCRProviderConfig.hasRequiredCredentials(configs, provider)) {
      sendResponse({ success: false, errorCode: 'MISSING_API_KEY', error: 'Missing API configuration' });
      return;
    }

    // 提取base64数据
    const base64Image = imageData.replace(/^data:image\/\w+;base64,/, '');

    const ocrResult = await providerAdapters.recognize(provider, base64Image, config, signal);

    if (signal.aborted) {
      throw new DOMException('OCR request cancelled', 'AbortError');
    }

    // Incognito windows must not leave OCR text or page metadata in persistent
    // extension history.
    const historyResult = OCRBackgroundCore.shouldPersistHistory(sender?.tab)
      ? await OCRBackgroundCore.appendHistoryBestEffort(historyStore, {
        text: ocrResult,
        provider: config.apiProvider,
        language: config.language || 'auto',
        sourceUrl: OCRBackgroundCore.sanitizeSourceUrl(sender?.tab?.url),
        sourceTitle: sender?.tab?.title || ''
      }, signal)
      : { historyId: null };

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

    const normalizedConfig = providerAdapters.normalizeConfig(
      config.apiProvider,
      config,
      { prompt: config.prompt, language: config.language }
    );
    await providerAdapters.recognize(config.apiProvider, testImage, normalizedConfig);

    sendResponse({ success: true, message: '连接成功' });
  } catch (error) {
    const interpreted = providerAdapters.interpretConnectionError(config.apiProvider, error);
    if (interpreted?.success) {
      sendResponse({
        ...interpreted,
        message: '连接成功',
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

      await OCRProviderConfig.migrateLegacyConfigOnce(chrome.storage.local);
      const result = await chrome.storage.local.get(['apiProvider', 'apiConfigs']);
      const provider = result.apiProvider || 'claude';
      const hasApiKey = OCRProviderConfig.hasRequiredCredentials(
        result.apiConfigs,
        provider
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
        const hasEndpointPermission = await OCRExtensionRuntime.hasEndpointPermission(
          chrome,
          provider,
          config.endpoint
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
