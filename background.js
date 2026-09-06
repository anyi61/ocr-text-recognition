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
  'providers/transport.js',
  'providers/claude.js',
  'providers/openai.js',
  'providers/openai-compatible.js',
  'providers/custom.js',
  'providers/baidu.js',
  'providers/aliyun.js',
  'providers/zhipu.js',
  'providers/registry.js',
  'background/capture-service.js',
  'background/recognition-service.js',
  'background/message-handlers.js'
);

const ocrRequestRegistry = OCRBackgroundCore.createRequestRegistry();
const historyStore = OCRHistoryStore.create(chrome.storage.local, { limit: 50 });
const backgroundMessage = (key, fallback) => chrome.i18n?.getMessage(key) || fallback;
const UPLOAD_NOTICE_VERSION = 1;
const providerDependencies = {
  core: OCRBackgroundCore,
  requestRuntime: OCRRequestRuntime,
  fetch
};
const transport = OCRProviderTransport.create(providerDependencies);
const adapterDependencies = { ...providerDependencies, transport };
const providerImplementations = {
  'claude': OCRClaudeProvider.create(adapterDependencies).recognize,
  'openai': OCROpenAIProvider.create(adapterDependencies).recognize,
  'openai-compatible': OCROpenAICompatibleProvider.create(adapterDependencies).recognize,
  'custom': OCRCustomProvider.create(adapterDependencies).recognize,
  'baidu': OCRBaiduProvider.create(adapterDependencies).recognize,
  'aliyun': OCRAliyunProvider.create(adapterDependencies).recognize,
  'zhipu': OCRZhipuProvider.create(adapterDependencies).recognize
};
const providerAdapters = OCRProviderAdapters.create(providerImplementations, {
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

const captureService = OCRCaptureService.create({ tabs: chrome.tabs, core: OCRBackgroundCore });
const recognitionService = OCRRecognitionService.create({
  storage: chrome.storage.local,
  core: OCRBackgroundCore,
  config: OCRProviderConfig,
  providers: providerAdapters,
  requestRegistry: ocrRequestRegistry,
  historyStore
});
const messageHandlers = OCRBackgroundHandlers.create({
  storage: chrome.storage.local,
  historyStore,
  captureService,
  recognitionService,
  uploadNoticeVersion: UPLOAD_NOTICE_VERSION
});
chrome.runtime.onMessage.addListener(OCRBackgroundMessageRouter.create(messageHandlers));

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
