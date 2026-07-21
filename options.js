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

  function buildExportData(result, apiConfigs, exportDate = new Date().toISOString()) {
    return {
      version: '1.1.0',
      exportDate,
      appName: 'OCR文字识别助手',
      config: {
        apiProvider: result.apiProvider || 'claude',
        apiConfigs,
        prompt: result.prompt || '',
        language: result.language || 'auto',
        theme: result.theme || 'light',
        uiLanguage: result.uiLanguage || 'auto'
      }
    };
  }

  function applyImportedAppearance(config, existingSettings) {
    return {
      // Old exports do not carry these fields, so retain local preferences.
      theme: config.theme ?? existingSettings.theme ?? 'light',
      uiLanguage: config.uiLanguage ?? existingSettings.uiLanguage ?? 'auto'
    };
  }

  function validateImportPreferences(config) {
    if (config.theme !== undefined && !['light', 'dark'].includes(config.theme)) {
      return 'theme';
    }
    if (config.uiLanguage !== undefined && !['auto', 'zh_CN', 'en'].includes(config.uiLanguage)) {
      return 'uiLanguage';
    }
    if (config.language !== undefined && !['auto', 'zh', 'en', 'ja', 'ko'].includes(config.language)) {
      return 'language';
    }
    return null;
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
    buildExportData,
    applyImportedAppearance,
    validateImportPreferences,
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

  // 按钮
  const testBtn = document.getElementById('testBtn');
  const statusMessage = document.getElementById('statusMessage');

  // 导入导出按钮
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importFileInput = document.getElementById('importFileInput');
  const includeApiKeys = document.getElementById('includeApiKeys');

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
  async function loadSettings() {
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
    const configs = result.apiConfigs || {};

    // Claude 配置
    const claudeConfig = OCRProviderConfig.getProviderConfig(configs, 'claude');
    claudeApiKey.value = claudeConfig.apiKey || result.apiKey || '';
    claudeModel.value = OCRProviderConfig.migrateRetiredModel(
      'claude',
      claudeConfig.model || result.model || 'claude-sonnet-5'
    );

    // OpenAI 配置
    const openaiConfig = OCRProviderConfig.getProviderConfig(configs, 'openai');
    openaiApiKey.value = openaiConfig.apiKey || result.openaiApiKey || '';
    openaiModel.value = OCRProviderConfig.migrateRetiredModel(
      'openai',
      openaiConfig.model || result.openaiModel || 'gpt-5-mini'
    );

    // 百度配置
    const baiduConfig = OCRProviderConfig.getProviderConfig(configs, 'baidu');
    baiduApiKey.value = baiduConfig.apiKey || result.baiduApiKey || '';
    baiduSecret.value = baiduConfig.secret || result.customSecret || '';

    // 阿里云配置
    const aliyunCfg = OCRProviderConfig.getProviderConfig(configs, 'aliyun');
    aliyunApiKey.value = aliyunCfg.apiKey || result.aliyunApiKey || '';
    aliyunModel.value = aliyunCfg.model || result.aliyunModel || 'qwen-vl-max';

    // 智谱AI配置
    const zhipuCfg = OCRProviderConfig.getProviderConfig(configs, 'zhipu');
    zhipuApiKey.value = zhipuCfg.apiKey || result.zhipuApiKey || '';
    zhipuModel.value = zhipuCfg.model || result.zhipuModel || 'glm-4v';

    // 通用OpenAI兼容接口配置
    const compatibleCfg = OCRProviderConfig.getProviderConfig(configs, 'openai-compatible');
    compatibleEndpoint.value = compatibleCfg.endpoint || result.compatibleEndpoint || '';
    compatibleApiKey.value = compatibleCfg.apiKey || result.compatibleApiKey || '';
    compatibleModel.value = compatibleCfg.model || result.compatibleModel || '';

    // 自定义API配置
    const customCfg = OCRProviderConfig.getProviderConfig(configs, 'custom');
    customEndpointInput.value = customCfg.endpoint || result.customEndpoint || '';
    customApiKeyInput.value = customCfg.apiKey || result.customApiKey || '';
    customModelInput.value = customCfg.model || result.customModel || '';
    customRequestMode.value = customCfg.requestMode;
    customAuthMode.value = customCfg.authMode;
    customHeaderName.value = customCfg.headerName || '';
    customResponsePath.value = customCfg.responsePath || '';
    updateCustomAuthControls();

    // 高级设置
    if (result.prompt) {
      prompt.value = result.prompt;
    }
    if (result.language) {
      language.value = result.language;
    }
    // 主题在单独的 loadTheme 函数中处理
  }

  /**
   * 保存设置
   * @async
   * @returns {Promise<boolean>}
   * @description 保存所有API配置到chrome.storage，同时兼容新旧格式。返回是否保存成功。
   */
  async function saveSettings() {
    const provider = apiProvider.value;

    // 校验当前 provider 配置
    const validation = validateProviderConfig(provider);
    if (!validation.valid) {
      showFieldErrors(validation.fieldErrors, provider);
      // 显示字段级错误提示
      validation.fieldErrors.forEach(field => {
        const el = getFieldElement(provider, field);
        if (el) {
          const messages = {
            apiKey: OCRI18n.t('err_api_key_empty'),
            secret: OCRI18n.t('err_secret_empty'),
            endpoint: OCRI18n.t('err_endpoint_empty'),
            endpoint_invalid: OCRI18n.t('err_endpoint_invalid'),
            model: OCRI18n.t('err_model_empty')
          };
          setFieldStatus(el, 'error', messages[field] || OCRI18n.t('err_config_incomplete'));
        }
      });
      showStatus(validation.message, 'error');
      return false;
    }

    // 清除之前的错误状态和字段状态
    showFieldErrors([], provider);
    // 清除当前provider所有字段的错误状态
    const providerFields = {
      'claude': ['apiKey', 'model'],
      'openai': ['apiKey', 'model'],
      'baidu': ['apiKey', 'secret'],
      'aliyun': ['apiKey', 'model'],
      'zhipu': ['apiKey', 'model'],
      'openai-compatible': ['endpoint', 'apiKey', 'model'],
      'custom': ['endpoint', 'apiKey', 'model', 'headerName']
    };
    (providerFields[provider] || []).forEach(field => {
      const el = getFieldElement(provider, field);
      if (el) clearFieldStatus(el);
    });

    // 构建统一的 apiConfigs 对象，每个API独立存储
    const apiConfigs = {
      claude: {
        apiKey: claudeApiKey.value,
        model: claudeModel.value
      },
      openai: {
        apiKey: openaiApiKey.value,
        model: openaiModel.value
      },
      baidu: {
        apiKey: baiduApiKey.value,
        secret: baiduSecret.value
      },
      aliyun: {
        apiKey: aliyunApiKey.value,
        model: aliyunModel.value
      },
      zhipu: {
        apiKey: zhipuApiKey.value,
        model: zhipuModel.value
      },
      openaiCompatible: {
        endpoint: compatibleEndpoint.value,
        apiKey: compatibleApiKey.value,
        model: compatibleModel.value
      },
      custom: {
        endpoint: customEndpointInput.value,
        apiKey: customApiKeyInput.value,
        model: customModelInput.value,
        requestMode: customRequestMode.value,
        authMode: customAuthMode.value,
        headerName: customHeaderName.value,
        responsePath: customResponsePath.value
      }
    };

    // 同时保存旧格式以兼容旧代码
    const settings = {
      apiProvider: provider,
      prompt: prompt.value,
      language: language.value,
      theme: themeSelect.value,
      apiConfigs: apiConfigs,
      // 以下是为了兼容 background.js 中的旧代码
      apiKey: claudeApiKey.value,
      model: claudeModel.value,
      openaiApiKey: openaiApiKey.value,
      openaiModel: openaiModel.value,
      baiduApiKey: baiduApiKey.value,
      customSecret: baiduSecret.value,
      aliyunApiKey: aliyunApiKey.value,
      aliyunModel: aliyunModel.value,
      zhipuApiKey: zhipuApiKey.value,
      zhipuModel: zhipuModel.value,
      compatibleEndpoint: compatibleEndpoint.value,
      compatibleApiKey: compatibleApiKey.value,
      compatibleModel: compatibleModel.value,
      customEndpoint: customEndpointInput.value,
      customApiKey: customApiKeyInput.value,
      customModel: customModelInput.value
    };

    await chrome.storage.local.set(settings);
    // 应用主题
    applyTheme(themeSelect.value);
    showStatus(OCRI18n.t('msg_saved'), 'success');
    return true;
  }

  /**
   * 自动保存所有输入框的变更
   * @description 为所有输入框和选择框添加blur事件监听，失去焦点时自动保存并显示提示
   */
  function setupAutoSave() {
    const allInputs = document.querySelectorAll('input, select, textarea');
    allInputs.forEach(input => {
      input.addEventListener('blur', async () => {
        // 当输入框失去焦点时自动保存
        const ok = await saveSettings();
        // 保存成功时显示字段级提示
        if (ok && input.closest('.input-wrapper')) {
          setFieldStatus(input, 'success', OCRI18n.t('msg_field_saved'));
          // 3秒后自动清除
          setTimeout(() => clearFieldStatus(input), 3000);
        }
      });
    });
  }

  /**
   * 获取当前Provider的配置
   * @param {string} provider - API提供商类型
   * @returns {Object} 配置对象
   */
  function getProviderConfig(provider) {
    switch (provider) {
      case 'claude':
        return { apiKey: claudeApiKey.value, model: claudeModel.value };
      case 'openai':
        return { apiKey: openaiApiKey.value, model: openaiModel.value };
      case 'baidu':
        return { apiKey: baiduApiKey.value, secret: baiduSecret.value };
      case 'aliyun':
        return { apiKey: aliyunApiKey.value, model: aliyunModel.value };
      case 'zhipu':
        return { apiKey: zhipuApiKey.value, model: zhipuModel.value };
      case 'openai-compatible':
        return {
          endpoint: compatibleEndpoint.value,
          apiKey: compatibleApiKey.value,
          model: compatibleModel.value
        };
      case 'custom':
        return {
          endpoint: customEndpointInput.value,
          apiKey: customApiKeyInput.value,
          model: customModelInput.value,
          requestMode: customRequestMode.value,
          authMode: customAuthMode.value,
          headerName: customHeaderName.value,
          responsePath: customResponsePath.value
        };
      default:
        return {};
    }
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
    // 先清除所有错误状态
    document.querySelectorAll('.input-error').forEach(el => {
      el.classList.remove('input-error');
    });

    // 根据provider和字段设置错误状态
    fieldErrors.forEach(field => {
      let element = null;
      switch (provider) {
        case 'claude':
          if (field === 'apiKey') element = claudeApiKey;
          if (field === 'model') element = claudeModel;
          break;
        case 'openai':
          if (field === 'apiKey') element = openaiApiKey;
          if (field === 'model') element = openaiModel;
          break;
        case 'baidu':
          if (field === 'apiKey') element = baiduApiKey;
          if (field === 'secret') element = baiduSecret;
          break;
        case 'aliyun':
          if (field === 'apiKey') element = aliyunApiKey;
          if (field === 'model') element = aliyunModel;
          break;
        case 'zhipu':
          if (field === 'apiKey') element = zhipuApiKey;
          if (field === 'model') element = zhipuModel;
          break;
        case 'openai-compatible':
          if (field === 'endpoint' || field === 'endpoint_invalid') element = compatibleEndpoint;
          if (field === 'apiKey') element = compatibleApiKey;
          if (field === 'model') element = compatibleModel;
          break;
        case 'custom':
          if (field === 'endpoint' || field === 'endpoint_invalid') element = customEndpointInput;
          if (field === 'apiKey') element = customApiKeyInput;
          if (field === 'model') element = customModelInput;
          if (field === 'headerName') element = customHeaderName;
          break;
      }
      if (element) {
        element.classList.add('input-error');
      }
    });
  }

  /**
   * 测试API连接
   * @async
   * @returns {Promise<void>}
   * @description 使用当前选中的API配置进行连接测试
   */
  async function testConnection() {
    const provider = apiProvider.value;
    const testBtn = document.getElementById('testBtn');

    // 先进行配置校验
    const validation = validateProviderConfig(provider);
    if (!validation.valid) {
      showStatus(validation.message, 'error');
      showFieldErrors(validation.fieldErrors, provider);
      return;
    }

    // 清除之前的错误状态
    showFieldErrors([], provider);

    const providerConfig = getProviderConfig(provider);
    const permissionGranted = await requestEndpointPermission(provider, providerConfig);
    if (!permissionGranted) {
      showStatus(OCRI18n.t('msg_endpoint_permission_denied'), 'error');
      return;
    }

    testBtn.disabled = true;
    showStatus(OCRI18n.t('msg_testing'), 'loading');

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
        config.model = openaiModel.value || 'gpt-5-mini';
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

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'testAPI',
        config: config
      });

      if (response.success) {
        showStatus(OCRI18n.t('msg_test_success'), 'success');
      } else {
        showStatus(`${OCRI18n.t('msg_test_failed')}: ${OCRI18n.errorMessage(response)}`, 'error');
      }
    } catch (error) {
      showStatus(`${OCRI18n.t('msg_test_failed')}: ${OCRI18n.errorMessage(error)}`, 'error');
    }

    testBtn.disabled = false;
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
    const wrapper = inputElement.closest('.input-wrapper');
    if (!wrapper) return;

    const statusEl = wrapper.querySelector('.field-status');
    if (!statusEl) return;

    statusEl.classList.remove('success', 'error', 'saving');
    statusEl.textContent = '';
  }

  /**
   * 获取字段对应的输入元素
   * @param {string} provider - API提供商
   * @param {string} field - 字段名
   * @returns {HTMLElement|null}
   */
  function getFieldElement(provider, field) {
    switch (provider) {
      case 'claude':
        if (field === 'apiKey') return claudeApiKey;
        if (field === 'model') return claudeModel;
        break;
      case 'openai':
        if (field === 'apiKey') return openaiApiKey;
        if (field === 'model') return openaiModel;
        break;
      case 'baidu':
        if (field === 'apiKey') return baiduApiKey;
        if (field === 'secret') return baiduSecret;
        break;
      case 'aliyun':
        if (field === 'apiKey') return aliyunApiKey;
        if (field === 'model') return aliyunModel;
        break;
      case 'zhipu':
        if (field === 'apiKey') return zhipuApiKey;
        if (field === 'model') return zhipuModel;
        break;
      case 'openai-compatible':
        if (field === 'endpoint' || field === 'endpoint_invalid') return compatibleEndpoint;
        if (field === 'apiKey') return compatibleApiKey;
        if (field === 'model') return compatibleModel;
        break;
      case 'custom':
        if (field === 'endpoint' || field === 'endpoint_invalid') return customEndpointInput;
        if (field === 'apiKey') return customApiKeyInput;
        if (field === 'model') return customModelInput;
        if (field === 'headerName') return customHeaderName;
        break;
    }
    return null;
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

      // 获取当前配置（仅导出配置数据，不包含历史记录）
      const result = await chrome.storage.local.get([
        'apiProvider', 'apiConfigs', 'prompt', 'language', 'theme', 'uiLanguage'
      ]);

      const apiConfigs = result.apiConfigs || {};
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
    // 检查基本结构
    if (!data || typeof data !== 'object') {
      return { valid: false, error: OCRI18n.t('err_import_invalid_structure'), config: null };
    }

    // 检查是否有config字段（新格式）或直接是配置（兼容旧格式）
    let config = data.config || data;

    if (!config || typeof config !== 'object') {
      return { valid: false, error: OCRI18n.t('err_import_missing_config'), config: null };
    }

    // 验证apiProvider
    const validProviders = ['claude', 'openai', 'baidu', 'aliyun', 'zhipu', 'openai-compatible', 'custom'];
    if (config.apiProvider && !validProviders.includes(config.apiProvider)) {
      return { valid: false, error: OCRI18n.t('err_import_invalid_provider', [config.apiProvider]), config: null };
    }

    // 验证apiConfigs结构
    if (config.apiConfigs && typeof config.apiConfigs !== 'object') {
      return { valid: false, error: OCRI18n.t('err_import_invalid_api_configs'), config: null };
    }

    // 验证各个API配置的结构
    if (config.apiConfigs) {
      const validConfigKeys = ['claude', 'openai', 'baidu', 'aliyun', 'zhipu', 'openaiCompatible', 'custom'];
      for (const key of Object.keys(config.apiConfigs)) {
        if (!validConfigKeys.includes(key)) {
          console.warn('未知的API配置键:', key);
          continue;
        }
        const apiConfig = config.apiConfigs[key];
        if (typeof apiConfig !== 'object') {
          return { valid: false, error: OCRI18n.t('err_import_invalid_provider_config', [key]), config: null };
        }
      }
    }

    // 验证prompt和language
    if (config.prompt !== undefined && typeof config.prompt !== 'string') {
      return { valid: false, error: OCRI18n.t('err_import_invalid_prompt'), config: null };
    }

    if (config.language !== undefined && typeof config.language !== 'string') {
      return { valid: false, error: OCRI18n.t('err_import_invalid_language'), config: null };
    }

    const invalidPreference = OptionsRuntime.validateImportPreferences(config);
    if (invalidPreference) {
      return {
        valid: false,
        error: OCRI18n.t(`err_import_invalid_${invalidPreference}`),
        config: null
      };
    }

    return { valid: true, error: null, config: config };
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
    if (!file) {
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

      // 应用配置
      showStatus(OCRI18n.t('msg_applying_config'), 'loading');

      const existingSettings = await chrome.storage.local.get([
        'apiConfigs',
        'apiKey', 'model', 'customEndpoint', 'customSecret', 'customModel',
        'openaiApiKey', 'openaiModel', 'baiduApiKey',
        'aliyunApiKey', 'aliyunModel', 'zhipuApiKey', 'zhipuModel',
        'compatibleEndpoint', 'compatibleApiKey', 'compatibleModel',
        'customApiKey', 'theme', 'uiLanguage'
      ]);
      const importedApiConfigs = validation.config.apiConfigs || {};
      const existingApiConfigs = existingSettings.apiConfigs || {};
      const mergedApiConfigs = OCRProviderConfig.mergeImportedApiConfigs(
        existingApiConfigs,
        importedApiConfigs
      );

      // 构建要保存的配置。缺少凭据字段的脱敏导出会保留本机已有密钥；
      // 旧版明文导出仍会覆盖对应字段。
      const settingsToSave = {
        apiProvider: validation.config.apiProvider || 'claude',
        apiConfigs: mergedApiConfigs,
        prompt: validation.config.prompt || '',
        language: validation.config.language || 'auto',
        ...OptionsRuntime.applyImportedAppearance(validation.config, existingSettings)
      };

      // 为了兼容性，也保存旧格式字段；脱敏导入会保留本机已有凭据。
      Object.assign(
        settingsToSave,
        OCRProviderConfig.buildLegacySettings(settingsToSave.apiConfigs, existingSettings)
      );

      // 保存到chrome.storage
      await chrome.storage.local.set(settingsToSave);

      // 重新加载页面设置
      await loadSettings();
      await loadTheme();
      await OCRI18n.setLanguage(settingsToSave.uiLanguage);
      OCRI18n.applyToDom(document);

      showStatus(OCRI18n.t('msg_import_success'), 'success');
    } catch (error) {
      console.error('导入配置失败:', error);
      showStatus(OCRI18n.t('msg_import_failed', [error.message]), 'error');
    }
  }

  // 事件监听
  apiProvider.addEventListener('change', async (e) => {
    const newProvider = e.target.value;
    showConfigSection(newProvider);
    // 切换API时尝试保存当前选择（校验不通过则不保存，但仍允许切换）
    await saveSettings();
  });

  customAuthMode.addEventListener('change', updateCustomAuthControls);

  // 主题切换即时生效
  themeSelect.addEventListener('change', async () => {
    const theme = themeSelect.value;
    applyTheme(theme);
    await chrome.storage.local.set({ theme });
    setFieldStatus(themeSelect, 'success', OCRI18n.t('msg_field_saved'));
    setTimeout(() => clearFieldStatus(themeSelect), 3000);
  });

  // 界面语言切换
  uiLanguageSelect.addEventListener('change', async () => {
    const newLang = uiLanguageSelect.value;
    await OCRI18n.setLanguage(newLang);
    OCRI18n.applyToDom(document);
    setFieldStatus(uiLanguageSelect, 'success', OCRI18n.t('msg_field_saved'));
    setTimeout(() => clearFieldStatus(uiLanguageSelect), 3000);
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

/**
 * 加载主题设置
 * @async
 */
async function loadTheme() {
  const result = await chrome.storage.local.get(['theme', 'uiLanguage']);
  const theme = result.theme || 'light';
  const themeSelect = document.getElementById('theme');
  if (themeSelect) {
    themeSelect.value = theme;
  }
  // 设置 uiLanguage 选择器
  const uiLanguageSelect = document.getElementById('uiLanguage');
  if (uiLanguageSelect) {
    uiLanguageSelect.value = result.uiLanguage || 'auto';
  }
  applyTheme(theme);
}
