/**
 * @fileoverview options.js - OCR文字识别助手设置页面逻辑
 * @description 处理设置页面的配置加载、保存、API测试等功能
 */

// 使用统一的 OCRI18n API（来自 i18n-runtime.js）

const OptionsRuntime = (() => {
  function createStatusPresenter(statusMessage, timerApi = globalThis) {
    let hideTimer = null;
    return (message, type) => {
      if (hideTimer !== null) {
        timerApi.clearTimeout(hideTimer);
        hideTimer = null;
      }
      statusMessage.textContent = message;
      statusMessage.className = 'status-message ' + type;
      statusMessage.classList.remove('hidden');
      if (type !== 'loading') {
        hideTimer = timerApi.setTimeout(() => {
          statusMessage.classList.add('hidden');
          hideTimer = null;
        }, 5000);
      }
    };
  }

  function connectionTestStatus(response, i18n) {
    if (response?.success && response.warningCode) {
      return { type: 'warning', message: i18n.errorMessage({ errorCode: response.warningCode }) };
    }
    if (response?.success) {
      return { type: 'success', message: i18n.t('msg_test_success') };
    }
    return {
      type: 'error',
      message: `${i18n.t('msg_test_failed')}: ${i18n.errorMessage(response)}`
    };
  }

  function buildExportData(result, apiConfigs, exportDate = new Date().toISOString()) {
    return {
      version: '1.2.2',
      exportDate,
      appName: 'OCR文字识别助手',
      config: {
        apiProvider: result.apiProvider || 'claude',
        apiConfigs,
        prompt: result.prompt || '',
        language: result.language || 'auto',
        theme: result.theme || 'light',
        uiLanguage: result.uiLanguage || 'auto',
        autoCopy: result.autoCopy === true,
        translationProvider: result.translationProvider || 'claude',
        translationTargetLanguage: result.translationTargetLanguage || 'zh_CN'
      }
    };
  }

  function createAutoCopyPreferences({ storage, onChange, onSaved = () => {}, onError = () => {} }) {
    let queue = Promise.resolve();
    let revision = 0;
    let confirmed = false;
    return {
      async load() {
        const token = revision;
        await queue;
        const result = await storage.get(['autoCopy']);
        if (token !== revision) return;
        confirmed = result.autoCopy === true;
        onChange(confirmed);
      },
      save(value, { silent = false } = {}) {
        const token = ++revision;
        onChange(value);
        const operation = queue.then(async () => {
          try {
            await storage.set({ autoCopy: value });
            confirmed = value;
            if (token === revision) {
              onChange(value);
              if (!silent) onSaved();
            }
            return true;
          } catch {
            // A previous toggle may also have failed. Reconcile with storage,
            // retaining the last acknowledged value if it is unavailable too.
            try { confirmed = (await storage.get(['autoCopy'])).autoCopy === true; }
            catch { /* Keep the last confirmed value. */ }
            if (token === revision) {
              onChange(confirmed);
              if (!silent) onError();
            }
            return false;
          }
        });
        queue = operation.catch(() => {});
        return operation;
      },
      settled: () => queue
    };
  }

  function createModalLifecycle(documentApi, overlay, resolve, timerApi = globalThis) {
    let closed = false;
    const close = (result) => {
      if (closed) return;
      closed = true;
      documentApi.removeEventListener('keydown', escHandler);
      overlay.classList.remove('active');
      timerApi.setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 300);
    };
    const escHandler = (event) => {
      if (event.key === 'Escape') close(false);
    };
    documentApi.addEventListener('keydown', escHandler);
    return { close };
  }

  return {
    createStatusPresenter,
    connectionTestStatus,
    buildExportData,
    createAutoCopyPreferences,
    createModalLifecycle
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OptionsRuntime;
}

document.addEventListener('DOMContentLoaded', async () => {
  // 初始化 i18n
  await OCRI18n.init();
  OCRI18n.applyToDom(document);

  // 获取DOM元素
  const apiProvider = document.getElementById('apiProvider');
  const claudeConfig = document.getElementById('claudeConfig');
  const openaiConfig = document.getElementById('openaiConfig');
  const baiduConfig = document.getElementById('baiduConfig');
  const aliyunConfig = document.getElementById('aliyunConfig');
  const zhipuConfig = document.getElementById('zhipuConfig');
  const openaiCompatibleConfig = document.getElementById('openaiCompatibleConfig');
  const customConfig = document.getElementById('customConfig');

  // Claude元素
  const claudeApiKey = document.getElementById('claudeApiKey');
  const claudeModel = document.getElementById('claudeModel');

  // OpenAI元素
  const openaiApiKey = document.getElementById('openaiApiKey');
  const openaiModel = document.getElementById('openaiModel');

  // 百度元素
  const baiduApiKey = document.getElementById('baiduApiKey');
  const baiduSecret = document.getElementById('baiduSecret');

  // 阿里云元素
  const aliyunApiKey = document.getElementById('aliyunApiKey');
  const aliyunModel = document.getElementById('aliyunModel');

  // 智谱AI元素
  const zhipuApiKey = document.getElementById('zhipuApiKey');
  const zhipuModel = document.getElementById('zhipuModel');

  // 通用OpenAI兼容接口元素
  const compatibleEndpoint = document.getElementById('compatibleEndpoint');
  const compatibleApiKey = document.getElementById('compatibleApiKey');
  const compatibleModel = document.getElementById('compatibleModel');

  // 自定义API元素
  const customEndpointInput = document.getElementById('customEndpoint');
  const customApiKeyInput = document.getElementById('customApiKey');
  const customModelInput = document.getElementById('customModel');
  const customRequestMode = document.getElementById('customRequestMode');
  const customAuthMode = document.getElementById('customAuthMode');
  const customHeaderName = document.getElementById('customHeaderName');
  const customHeaderNameGroup = document.getElementById('customHeaderNameGroup');
  const customResponsePath = document.getElementById('customResponsePath');

  // 高级设置
  const prompt = document.getElementById('prompt');
  const language = document.getElementById('language');
  const themeSelect = document.getElementById('theme');
  const uiLanguageSelect = document.getElementById('uiLanguage');
  const autoCopyInput = document.getElementById('autoCopy');

  // 按钮
  const testBtn = document.getElementById('testBtn');
  const statusMessage = document.getElementById('statusMessage');

  // 导入导出按钮
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importFileInput = document.getElementById('importFileInput');
  const includeApiKeys = document.getElementById('includeApiKeys');

  // Bind each editable control to exactly one setting. Export/file controls and
  // independently saved appearance/behavior controls cannot rewrite providers.
  const providerInputs = [
    ['claude', { apiKey: claudeApiKey, model: claudeModel }],
    ['openai', { apiKey: openaiApiKey, model: openaiModel }],
    ['baidu', { apiKey: baiduApiKey, secret: baiduSecret }],
    ['aliyun', { apiKey: aliyunApiKey, model: aliyunModel }],
    ['zhipu', { apiKey: zhipuApiKey, model: zhipuModel }],
    ['openaiCompatible', { endpoint: compatibleEndpoint, apiKey: compatibleApiKey, model: compatibleModel }],
    ['custom', { endpoint: customEndpointInput, apiKey: customApiKeyInput, model: customModelInput,
      requestMode: customRequestMode, authMode: customAuthMode, headerName: customHeaderName,
      responsePath: customResponsePath }]
  ];
  const inputPatches = new Map([[apiProvider, (value) => ({ apiProvider: value })],
    [prompt, (value) => ({ prompt: value })], [language, (value) => ({ language: value })]]);
  for (const [key, fields] of providerInputs) {
    for (const [field, input] of Object.entries(fields)) {
      inputPatches.set(input, (value) => ({ apiConfigs: { [key]: { [field]: value } } }));
    }
  }
  const savedInputs = new Map();
  const pendingInputs = new Map();
  const fieldStatusTimers = new Map();
  let settingsWrites = Promise.resolve();
  let importInProgress = false;
  let connectionTestInProgress = false;
  let themeRevision = 0;
  function updateTestButton() {
    testBtn.disabled = importInProgress || connectionTestInProgress;
  }
  function refreshLanguage() {
    uiLanguageSelect.value = OCRI18n.getLanguageSetting();
    OCRI18n.applyToDom(document);
  }
  window.addEventListener('ocr-i18n-changed', refreshLanguage);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.theme) return;
    themeRevision += 1;
    themeSelect.value = changes.theme.newValue || 'light';
    applyTheme(themeSelect.value);
  });
  async function loadTheme() {
    const revision = themeRevision;
    const result = await chrome.storage.local.get(['theme']);
    if (revision === themeRevision) {
      themeSelect.value = result.theme || 'light';
      applyTheme(themeSelect.value);
    }
    refreshLanguage();
  }
  function persistSettings(settings) {
    const operation = settingsWrites.then(async () => {
      const response = await chrome.runtime.sendMessage({ action: 'saveSettings', settings });
      if (!response?.success) throw Object.assign(new Error('Settings were not saved'), {
        code: response?.errorCode || 'SETTINGS_SAVE_FAILED'
      });
    });
    settingsWrites = operation.catch(() => {});
    return operation;
  }

  /**
   * 根据提供商显示对应的配置区块
   * @param {string} provider - API提供商类型
   */
  function showConfigSection(provider) {
    claudeConfig.classList.add('hidden');
    openaiConfig.classList.add('hidden');
    baiduConfig.classList.add('hidden');
    aliyunConfig.classList.add('hidden');
    zhipuConfig.classList.add('hidden');
    openaiCompatibleConfig.classList.add('hidden');
    customConfig.classList.add('hidden');

    switch (provider) {
      case 'claude':
        claudeConfig.classList.remove('hidden');
        break;
      case 'openai':
        openaiConfig.classList.remove('hidden');
        break;
      case 'baidu':
        baiduConfig.classList.remove('hidden');
        break;
      case 'aliyun':
        aliyunConfig.classList.remove('hidden');
        break;
      case 'zhipu':
        zhipuConfig.classList.remove('hidden');
        break;
      case 'openai-compatible':
        openaiCompatibleConfig.classList.remove('hidden');
        break;
      case 'custom':
        customConfig.classList.remove('hidden');
        break;
    }
  }

  function updateCustomAuthControls() {
    customHeaderNameGroup.classList.toggle(
      'hidden',
      customAuthMode.value !== 'custom-header'
    );
  }

  /**
   * 加载保存的设置
   * @async
   * @returns {Promise<void>}
   * @description 从chrome.storage加载所有API配置和设置，兼容新旧配置格式
   */
  async function loadSettings(unsavedInputs = new Map()) {
    // 统一从 apiConfigs 对象中加载各API配置，同时兼容旧版配置
    const result = await chrome.storage.local.get([
      'apiProvider', 'apiConfigs', 'prompt', 'language',
      // 以下是为了兼容旧版本配置
      'apiKey', 'model', 'customEndpoint', 'customSecret', 'customModel',
      'openaiApiKey', 'openaiModel', 'baiduApiKey',
      'aliyunApiKey', 'aliyunModel', 'zhipuApiKey', 'zhipuModel',
      'compatibleEndpoint', 'compatibleApiKey', 'compatibleModel',
      'customApiKey'
    ]);

    // 设置API提供商
    if (result.apiProvider) {
      apiProvider.value = result.apiProvider;
      showConfigSection(result.apiProvider);
    }

    // 优先从新的 apiConfigs 对象加载，否则兼容旧配置
    const configs = OCRProviderConfig.resolveApiConfigs(result);

    // Claude 配置
    const claudeConfig = OCRProviderConfig.getProviderConfig(configs, 'claude');
    claudeApiKey.value = claudeConfig.apiKey ?? result.apiKey ?? '';
    claudeModel.value = claudeConfig.model ?? result.model ?? OCRProviderConfig.DEFAULT_MODELS.claude;

    // OpenAI 配置
    const openaiConfig = OCRProviderConfig.getProviderConfig(configs, 'openai');
    openaiApiKey.value = openaiConfig.apiKey ?? result.openaiApiKey ?? '';
    openaiModel.value = openaiConfig.model ?? result.openaiModel ?? OCRProviderConfig.DEFAULT_MODELS.openai;

    // 百度配置
    const baiduConfig = OCRProviderConfig.getProviderConfig(configs, 'baidu');
    baiduApiKey.value = baiduConfig.apiKey ?? result.baiduApiKey ?? '';
    baiduSecret.value = baiduConfig.secret ?? result.customSecret ?? '';

    // 阿里云配置
    const aliyunCfg = OCRProviderConfig.getProviderConfig(configs, 'aliyun');
    aliyunApiKey.value = aliyunCfg.apiKey ?? result.aliyunApiKey ?? '';
    aliyunModel.value = aliyunCfg.model ?? result.aliyunModel ?? OCRProviderConfig.DEFAULT_MODELS.aliyun;

    // 智谱AI配置
    const zhipuCfg = OCRProviderConfig.getProviderConfig(configs, 'zhipu');
    zhipuApiKey.value = zhipuCfg.apiKey ?? result.zhipuApiKey ?? '';
    zhipuModel.value = zhipuCfg.model ?? result.zhipuModel ?? OCRProviderConfig.DEFAULT_MODELS.zhipu;

    // 通用OpenAI兼容接口配置
    const compatibleCfg = OCRProviderConfig.getProviderConfig(configs, 'openai-compatible');
    compatibleEndpoint.value = compatibleCfg.endpoint ?? result.compatibleEndpoint ?? '';
    compatibleApiKey.value = compatibleCfg.apiKey ?? result.compatibleApiKey ?? '';
    compatibleModel.value = compatibleCfg.model ?? result.compatibleModel ?? '';

    // 自定义API配置
    const customCfg = OCRProviderConfig.getProviderConfig(configs, 'custom');
    customEndpointInput.value = customCfg.endpoint ?? result.customEndpoint ?? '';
    customApiKeyInput.value = customCfg.apiKey ?? result.customApiKey ?? '';
    customModelInput.value = customCfg.model ?? result.customModel ?? '';
    customRequestMode.value = customCfg.requestMode;
    customAuthMode.value = customCfg.authMode;
    customHeaderName.value = customCfg.headerName ?? '';
    customResponsePath.value = customCfg.responsePath ?? '';
    updateCustomAuthControls();

    // 高级设置
    prompt.value = result.prompt ?? '';
    language.value = result.language ?? 'auto';
    for (const input of inputPatches.keys()) {
      savedInputs.set(input, input.value);
      clearFieldStatus(input);
    }
    // A partial import must not erase edits whose earlier save failed. Keep
    // their new values visible while the stored values remain the retry baseline.
    for (const [input, value] of unsavedInputs) {
      input.value = value;
      setFieldStatus(input, 'error', OCRI18n.t('msg_settings_save_failed'));
    }
    showConfigSection(apiProvider.value);
    updateCustomAuthControls();
    await autoCopyPreferences.load();
    // 主题在单独的 loadTheme 函数中处理
  }

  function saveInput(input) {
    const value = input.value;
    const pending = pendingInputs.get(input);
    if (pending?.value === value) return pending.promise;
    if (!pending && savedInputs.get(input) === value) return Promise.resolve(true);
    const current = { value };
    const operation = persistSettings(inputPatches.get(input)(value)).then(() => {
      savedInputs.set(input, value);
      if (pendingInputs.get(input) === current && input.value === value) {
        setFieldStatus(input, 'success', OCRI18n.t('msg_field_saved'));
        showStatus(OCRI18n.t('msg_saved'), 'success');
        clearFieldStatusLater(input);
      }
      return true;
    }).catch(() => {
      if (pendingInputs.get(input) === current) {
        setFieldStatus(input, 'error', OCRI18n.t('msg_settings_save_failed'));
        showStatus(OCRI18n.t('msg_settings_save_failed'), 'error');
      }
      return false;
    }).finally(() => {
      if (pendingInputs.get(input) === current) pendingInputs.delete(input);
    });
    current.promise = operation;
    pendingInputs.set(input, current);
    return operation;
  }

  function setupAutoSave() {
    for (const input of inputPatches.keys()) {
      input.addEventListener('blur', () => { void saveInput(input); });
      if (input.tagName === 'SELECT' && input !== apiProvider) {
        input.addEventListener('change', () => { void saveInput(input); });
      }
    }
  }

  function getUnimportedEdits(importedSettings) {
    const edits = new Map();
    for (const [input, createPatch] of inputPatches) {
      if (savedInputs.get(input) === input.value) continue;
      const patch = createPatch(input.value);
      const [key] = Object.keys(patch);
      if (key === 'apiConfigs') {
        const [provider] = Object.keys(patch.apiConfigs);
        const [field] = Object.keys(patch.apiConfigs[provider]);
        if (Object.hasOwn(importedSettings.apiConfigs?.[provider] || {}, field)) continue;
      } else if (Object.hasOwn(importedSettings, key)) continue;
      edits.set(input, input.value);
    }
    return edits;
  }

  /**
   * 获取当前Provider的配置
   * @param {string} provider - API提供商类型
   * @returns {Object} 配置对象
   */
  function getProviderConfig(provider) {
    const key = OCRProviderConfig.getStorageKey(provider);
    const fields = providerInputs.find(([providerKey]) => providerKey === key)?.[1] || {};
    return Object.fromEntries(Object.entries(fields).map(([field, input]) => [field, input.value]));
  }

  /**
   * 验证Provider配置
   * @param {string} provider - API提供商类型
   * @returns {{valid: boolean, message: string, fieldErrors: string[]}}
   */
  function validateProviderConfig(provider) {
    const config = getProviderConfig(provider);
    const fieldErrors = [];

    switch (provider) {
      case 'claude':
      case 'openai':
      case 'aliyun':
      case 'zhipu':
        if (!config.apiKey || config.apiKey.trim() === '') {
          fieldErrors.push('apiKey');
        }
        if (!config.model || config.model.trim() === '') {
          fieldErrors.push('model');
        }
        break;

      case 'baidu':
        if (!config.apiKey || config.apiKey.trim() === '') {
          fieldErrors.push('apiKey');
        }
        if (!config.secret || config.secret.trim() === '') {
          fieldErrors.push('secret');
        }
        break;

      case 'openai-compatible':
        if (!config.endpoint || config.endpoint.trim() === '') {
          fieldErrors.push('endpoint');
        } else if (!OCRProviderConfig.getEndpointOriginPattern(config.endpoint)) {
          fieldErrors.push('endpoint_invalid');
        }
        if (!config.apiKey || config.apiKey.trim() === '') {
          fieldErrors.push('apiKey');
        }
        if (!config.model || config.model.trim() === '') {
          fieldErrors.push('model');
        }
        break;

      case 'custom':
        if (!config.endpoint || config.endpoint.trim() === '') {
          fieldErrors.push('endpoint');
        } else if (!OCRProviderConfig.getEndpointOriginPattern(config.endpoint)) {
          fieldErrors.push('endpoint_invalid');
        }
        if (config.authMode !== 'none' && (!config.apiKey || config.apiKey.trim() === '')) {
          fieldErrors.push('apiKey');
        }
        if (config.authMode === 'custom-header'
          && !OCRProviderConfig.isValidHeaderName(config.headerName)) {
          fieldErrors.push('headerName');
        }
        break;
    }

    const configKey = OCRProviderConfig.getStorageKey(provider);
    if (
      fieldErrors.length === 0
      && !OCRProviderConfig.hasRequiredCredentials({ [configKey]: config }, provider)
    ) {
      fieldErrors.push('apiKey');
    }

    if (fieldErrors.length > 0) {
      const messages = {
        apiKey: OCRI18n.t('field_api_key'),
        secret: OCRI18n.t('field_secret_key'),
        endpoint: OCRI18n.t('field_endpoint'),
        endpoint_invalid: OCRI18n.t('err_endpoint_invalid'),
        model: OCRI18n.t('field_model_name'),
        headerName: OCRI18n.t('field_header_name')
      };

      const errorMessages = fieldErrors.map(f => messages[f] || f);
      const separator = OCRI18n.getResolvedLanguage() === 'en' ? ', ' : '、';
      return {
        valid: false,
        message: OCRI18n.t('err_config_incomplete_detail', [errorMessages.join(separator)]),
        fieldErrors: fieldErrors
      };
    }

    return { valid: true, message: '', fieldErrors: [] };
  }

  async function requestEndpointPermission(provider, config) {
    if (provider !== 'openai-compatible' && provider !== 'custom') {
      return true;
    }

    return OCRExtensionRuntime.requestEndpointPermission(
      chrome,
      provider,
      config.endpoint
    );
  }

  /**
   * 显示字段错误状态
   * @param {string[]} fieldErrors - 错误字段列表
   * @param {string} provider - API提供商类型
   */
  function showFieldErrors(fieldErrors, provider) {
    document.querySelectorAll('.input-error').forEach((element) => element.classList.remove('input-error'));
    for (const field of fieldErrors) getFieldElement(provider, field)?.classList.add('input-error');
  }

  /**
   * 测试API连接
   * @async
   * @returns {Promise<void>}
   * @description 使用当前选中的API配置进行连接测试
   */
  async function testConnection() {
    if (importInProgress || connectionTestInProgress) return;
    const provider = apiProvider.value;

    // 先进行配置校验
    const validation = validateProviderConfig(provider);
    if (!validation.valid) {
      showStatus(validation.message, 'error');
      showFieldErrors(validation.fieldErrors, provider);
      return;
    }

    // 清除之前的错误状态
    showFieldErrors([], provider);

    const config = {
      apiProvider: provider,
      apiKey: '',
      model: '',
      customEndpoint: '',
      customSecret: ''
    };

    switch (provider) {
      case 'claude':
        config.apiKey = claudeApiKey.value;
        config.model = claudeModel.value;
        break;
      case 'openai':
        config.apiKey = openaiApiKey.value;
        config.model = openaiModel.value || OCRProviderConfig.DEFAULT_MODELS.openai;
        break;
      case 'baidu':
        config.apiKey = baiduApiKey.value;
        config.customSecret = baiduSecret.value;
        break;
      case 'aliyun':
        config.apiKey = aliyunApiKey.value;
        config.model = aliyunModel.value; // 使用 .model 统一处理
        config.customModel = aliyunModel.value;
        break;
      case 'zhipu':
        config.apiKey = zhipuApiKey.value;
        config.model = zhipuModel.value;
        break;
      case 'openai-compatible':
        config.apiKey = compatibleApiKey.value;
        config.customEndpoint = compatibleEndpoint.value;
        config.customModel = compatibleModel.value;
        config.model = compatibleModel.value || config.customModel;
        break;
      case 'custom':
        config.apiKey = customApiKeyInput.value;
        config.customEndpoint = customEndpointInput.value;
        config.customModel = customModelInput.value;
        config.model = customModelInput.value || config.customModel;
        config.requestMode = customRequestMode.value;
        config.authMode = customAuthMode.value;
        config.headerName = customHeaderName.value;
        config.responsePath = customResponsePath.value;
        break;
    }

    connectionTestInProgress = true;
    updateTestButton();
    try {
      const permissionGranted = await requestEndpointPermission(provider, getProviderConfig(provider));
      if (!permissionGranted) {
        if (!importInProgress) showStatus(OCRI18n.t('msg_endpoint_permission_denied'), 'error');
        return;
      }
      if (!importInProgress) showStatus(OCRI18n.t('msg_testing'), 'loading');
      const response = await chrome.runtime.sendMessage({
        action: 'testAPI',
        config: config
      });

      const status = OptionsRuntime.connectionTestStatus(response, OCRI18n);
      if (!importInProgress) showStatus(status.message, status.type);
    } catch (error) {
      if (!importInProgress) showStatus(`${OCRI18n.t('msg_test_failed')}: ${OCRI18n.errorMessage(error)}`, 'error');
    } finally {
      connectionTestInProgress = false;
      updateTestButton();
    }
  }

  /**
   * 显示状态消息
   * @param {string} message - 状态消息内容
   * @param {string} type - 消息类型 (success|error|loading)
   * @description 在页面上方显示状态消息，非loading类型5秒后自动隐藏
   */
  const showStatus = OptionsRuntime.createStatusPresenter(statusMessage);

  /**
   * 设置字段状态提示
   * @param {HTMLElement} inputElement - 输入框元素
   * @param {string} type - 状态类型 (success|error|saving)
   * @param {string} message - 状态消息
   */
  function setFieldStatus(inputElement, type, message) {
    clearTimeout(fieldStatusTimers.get(inputElement));
    fieldStatusTimers.delete(inputElement);
    const wrapper = inputElement.closest('.input-wrapper');
    if (!wrapper) return;

    const statusEl = wrapper.querySelector('.field-status');
    if (!statusEl) return;

    // 清除之前的状态
    statusEl.classList.remove('success', 'error', 'saving');

    // 设置新状态
    statusEl.textContent = message;
    statusEl.classList.add(type);
  }

  /**
   * 清除字段状态提示
   * @param {HTMLElement} inputElement - 输入框元素
   */
  function clearFieldStatus(inputElement) {
    clearTimeout(fieldStatusTimers.get(inputElement));
    fieldStatusTimers.delete(inputElement);
    const wrapper = inputElement.closest('.input-wrapper');
    if (!wrapper) return;

    const statusEl = wrapper.querySelector('.field-status');
    if (!statusEl) return;

    statusEl.classList.remove('success', 'error', 'saving');
    statusEl.textContent = '';
  }

  function clearFieldStatusLater(inputElement) {
    clearTimeout(fieldStatusTimers.get(inputElement));
    fieldStatusTimers.set(inputElement, setTimeout(() => clearFieldStatus(inputElement), 3000));
  }

  /**
   * 获取字段对应的输入元素
   * @param {string} provider - API提供商
   * @param {string} field - 字段名
   * @returns {HTMLElement|null}
   */
  function getFieldElement(provider, field) {
    const key = OCRProviderConfig.getStorageKey(provider);
    const fields = providerInputs.find(([providerKey]) => providerKey === key)?.[1] || {};
    return fields[field === 'endpoint_invalid' ? 'endpoint' : field] || null;
  }

  /**
   * 导出配置到JSON文件
   * @async
   * @returns {Promise<void>}
   * @description 将当前配置导出为JSON文件下载；默认移除所有API凭据
   */
  async function exportConfig() {
    try {
      showStatus(OCRI18n.t('msg_exporting'), 'loading');
      await autoCopyPreferences.settled();
      await settingsWrites;

      // 获取当前配置（仅导出配置数据，不包含历史记录）
      const result = await chrome.storage.local.get([
        'apiProvider', 'apiConfigs', 'prompt', 'language', 'theme', 'uiLanguage',
        'autoCopy', 'translationProvider', 'translationTargetLanguage',
        ...OCRProviderConfig.LEGACY_STORAGE_KEYS
      ]);

      const apiConfigs = OCRProviderConfig.resolveApiConfigs(result);
      const exportedApiConfigs = includeApiKeys.checked
        ? apiConfigs
        : OCRProviderConfig.redactApiConfigs(apiConfigs);

      // 构建导出数据结构
      const exportData = OptionsRuntime.buildExportData(result, exportedApiConfigs);

      // 创建并下载JSON文件
      const jsonString = JSON.stringify(exportData, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      // 创建临时下载链接
      const a = document.createElement('a');
      a.href = url;
      a.download = `ocr-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();

      // 清理
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showStatus(OCRI18n.t('msg_export_success'), 'success');
    } catch (error) {
      console.error('导出配置失败:', error);
      showStatus(OCRI18n.t('msg_export_failed', [error.message]), 'error');
    }
  }

  /**
   * 验证导入的配置数据
   * @param {Object} data - 待验证的配置数据
   * @returns {{valid: boolean, error: string|null, config: Object|null}}
   * @description 验证JSON格式和必要字段，返回验证结果
   */
  function validateImportData(data) {
    try {
      if (!OCRProviderConfig.isRecord(data)) throw new Error('Invalid import');
      const config = Object.hasOwn(data, 'config') ? data.config : data;
      return { valid: true, error: null, config: OCRProviderConfig.prepareSettingsPatch(config) };
    } catch {
      return { valid: false, error: OCRI18n.t('err_import_invalid_structure'), config: null };
    }
  }

  /**
   * 显示确认对话框
   * @param {string} title - 对话框标题
   * @param {string} message - 对话框消息
   * @param {Object} configInfo - 配置信息对象
   * @returns {Promise<boolean>}
   * @description 显示模态确认对话框，返回用户选择结果
   */
  function showConfirmDialog(title, message, configInfo) {
    return new Promise((resolve) => {
      // 构建配置信息HTML
      let infoHtml = '';
      if (configInfo) {
        infoHtml = `
          <div class="config-info">
            <p><strong>${OCRI18n.t('modal_api_provider')}:</strong> ${configInfo.apiProvider || 'claude'}</p>
            ${configInfo.exportDate ? `<p><strong>${OCRI18n.t('modal_export_date')}:</strong> ${new Date(configInfo.exportDate).toLocaleString()}</p>` : ''}
          </div>
        `;
      }

      // 创建对话框HTML
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-dialog">
          <h3>${title}</h3>
          <p>${message}</p>
          ${infoHtml}
          <p class="warning-text">${OCRI18n.t('modal_import_warning')}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" id="modalCancel">${OCRI18n.t('btn_cancel')}</button>
            <button class="btn btn-primary" id="modalConfirm">${OCRI18n.t('btn_confirm_import')}</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      // 触发动画
      requestAnimationFrame(() => {
        overlay.classList.add('active');
      });

      // 绑定事件
      const cancelBtn = overlay.querySelector('#modalCancel');
      const confirmBtn = overlay.querySelector('#modalConfirm');

      const { close: closeDialog } = OptionsRuntime.createModalLifecycle(
        document,
        overlay,
        resolve
      );

      cancelBtn.addEventListener('click', () => closeDialog(false));
      confirmBtn.addEventListener('click', () => closeDialog(true));

      // 点击遮罩关闭
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          closeDialog(false);
        }
      });

    });
  }

  /**
   * 导入配置文件
   * @param {Event} event - 文件选择事件
   * @returns {Promise<void>}
   * @description 读取并验证JSON配置文件，确认后应用配置
   */
  async function importConfig(event) {
    const file = event.target.files[0];
    if (!file || importInProgress) {
      return;
    }

    // 重置文件输入，允许重复选择同一文件
    event.target.value = '';

    // 检查文件类型
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      showStatus(OCRI18n.t('err_import_invalid_json'), 'error');
      return;
    }

    showStatus(OCRI18n.t('msg_importing'), 'loading');
    importInProgress = true;
    updateTestButton();
    const lockedControls = [];

    try {
      // 读取文件内容
      const content = await file.text();
      let data;

      try {
        data = JSON.parse(content);
      } catch (parseError) {
        showStatus(OCRI18n.t('err_import_parse'), 'error');
        return;
      }

      // 验证配置数据
      const validation = validateImportData(data);
      if (!validation.valid) {
        showStatus(OCRI18n.t('err_import_parse') + ': ' + validation.error, 'error');
        return;
      }

      // 显示确认对话框
      const confirmed = await showConfirmDialog(
        OCRI18n.t('modal_import_title'),
        OCRI18n.t('modal_import_message'),
        {
          apiProvider: validation.config.apiProvider,
          exportDate: data.exportDate
        }
      );

      if (!confirmed) {
        showStatus(OCRI18n.t('msg_import_cancelled'), 'error');
        return;
      }

      // Applying an import refreshes the form. Prevent new edits from being
      // silently replaced by that refresh while the background write is pending.
      for (const control of document.querySelectorAll('input, select, textarea, button')) {
        if (control === testBtn) continue;
        lockedControls.push([control, control.disabled]);
        control.disabled = true;
      }
      // 应用配置
      showStatus(OCRI18n.t('msg_applying_config'), 'loading');

      // Flush older edits, then commit every imported field in one background
      // transaction. Omitted/redacted values remain untouched.
      await autoCopyPreferences.settled();
      await persistSettings(validation.config);
      const unsavedInputs = getUnimportedEdits(validation.config);
      await loadSettings(unsavedInputs);
      await loadTheme();
      OCRI18n.applyToDom(document);

      showStatus(unsavedInputs.size
        ? `${OCRI18n.t('msg_import_success')} ${OCRI18n.t('msg_settings_save_failed')}`
        : OCRI18n.t('msg_import_success'), unsavedInputs.size ? 'warning' : 'success');
    } catch (error) {
      console.error('导入配置失败:', error);
      const detail = error.code === 'SETTINGS_SAVE_FAILED' || error.code === 'SETTINGS_INVALID'
        ? OCRI18n.t('msg_settings_save_failed') : error.message;
      showStatus(OCRI18n.t('msg_import_failed', [detail]), 'error');
    } finally {
      for (const [control, disabled] of lockedControls) control.disabled = disabled;
      importInProgress = false;
      updateTestButton();
    }
  }

  // 事件监听
  apiProvider.addEventListener('change', async (e) => {
    const newProvider = e.target.value;
    showConfigSection(newProvider);
    await saveInput(apiProvider);
  });

  customAuthMode.addEventListener('change', updateCustomAuthControls);

  // 主题切换即时生效
  themeSelect.addEventListener('change', async () => {
    const theme = themeSelect.value;
    themeRevision += 1;
    applyTheme(theme);
    try {
      await persistSettings({ theme });
      setFieldStatus(themeSelect, 'success', OCRI18n.t('msg_field_saved'));
      clearFieldStatusLater(themeSelect);
    } catch {
      showStatus(OCRI18n.t('msg_settings_save_failed'), 'error');
    }
  });

  const autoCopyPreferences = OptionsRuntime.createAutoCopyPreferences({
    storage: { get: (keys) => chrome.storage.local.get(keys), set: persistSettings },
    onChange: (value) => { autoCopyInput.checked = value; },
    onSaved: () => showStatus(OCRI18n.t('msg_saved'), 'success'),
    onError: () => showStatus(OCRI18n.t('msg_auto_copy_save_failed'), 'error')
  });
  autoCopyInput.addEventListener('change', () => {
    void autoCopyPreferences.save(autoCopyInput.checked);
  });

  // 界面语言切换
  uiLanguageSelect.addEventListener('change', async () => {
    const newLang = uiLanguageSelect.value;
    try {
      await OCRI18n.setLanguage(newLang);
      uiLanguageSelect.value = OCRI18n.getLanguageSetting();
      OCRI18n.applyToDom(document);
      setFieldStatus(uiLanguageSelect, 'success', OCRI18n.t('msg_field_saved'));
      clearFieldStatusLater(uiLanguageSelect);
    } catch {
      uiLanguageSelect.value = OCRI18n.getLanguageSetting();
      showStatus(OCRI18n.t('msg_settings_save_failed'), 'error');
    }
  });

  testBtn.addEventListener('click', testConnection);

  // 导入导出按钮事件
  exportBtn.addEventListener('click', exportConfig);
  importBtn.addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', importConfig);

  // 加载设置
  await loadSettings();

  // 加载主题设置
  await loadTheme();

  // 设置自动保存
  setupAutoSave();
});

/**
 * 应用主题
 * @param {string} theme - 主题名称 (light|dark)
 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}
