// @ts-check
/** Owns Provider fields, validation, persistence and connection testing. */
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRProviderForm = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create(dependencies) {
    const { document, chrome, i18n: OCRI18n, config: OCRProviderConfig,
      runtime: OCRExtensionRuntime, showStatus, applyTheme, listen, schedule } = dependencies;
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
    const baiduMode = document.getElementById('baiduMode');

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

    async function loadSettings() {
      const result = await chrome.storage.local.get([
        'apiProvider', 'apiConfigs', 'prompt', 'language'
      ]);

      // 设置API提供商
      if (result.apiProvider) {
        apiProvider.value = result.apiProvider;
        showConfigSection(result.apiProvider);
      }

      const configs = result.apiConfigs || {};

      // Claude 配置
      const claudeConfig = OCRProviderConfig.getProviderConfig(configs, 'claude');
      claudeApiKey.value = claudeConfig.apiKey || '';
      claudeModel.value = OCRProviderConfig.migrateRetiredModel(
        'claude',
        claudeConfig.model || 'claude-sonnet-5'
      );

      // OpenAI 配置
      const openaiConfig = OCRProviderConfig.getProviderConfig(configs, 'openai');
      openaiApiKey.value = openaiConfig.apiKey || '';
      openaiModel.value = OCRProviderConfig.migrateRetiredModel(
        'openai',
        openaiConfig.model || 'gpt-5-mini'
      );

      // 百度配置
      const baiduConfig = OCRProviderConfig.getProviderConfig(configs, 'baidu');
      baiduApiKey.value = baiduConfig.apiKey || '';
      baiduSecret.value = baiduConfig.secret || '';
      baiduMode.value = baiduConfig.mode || 'general_basic';

      // 阿里云配置
      const aliyunCfg = OCRProviderConfig.getProviderConfig(configs, 'aliyun');
      aliyunApiKey.value = aliyunCfg.apiKey || '';
      aliyunModel.value = aliyunCfg.model || 'qwen-vl-max';

      // 智谱AI配置
      const zhipuCfg = OCRProviderConfig.getProviderConfig(configs, 'zhipu');
      zhipuApiKey.value = zhipuCfg.apiKey || '';
      zhipuModel.value = zhipuCfg.model || 'glm-4v';

      // 通用OpenAI兼容接口配置
      const compatibleCfg = OCRProviderConfig.getProviderConfig(configs, 'openai-compatible');
      compatibleEndpoint.value = compatibleCfg.endpoint || '';
      compatibleApiKey.value = compatibleCfg.apiKey || '';
      compatibleModel.value = compatibleCfg.model || '';

      // 自定义API配置
      const customCfg = OCRProviderConfig.getProviderConfig(configs, 'custom');
      customEndpointInput.value = customCfg.endpoint || '';
      customApiKeyInput.value = customCfg.apiKey || '';
      customModelInput.value = customCfg.model || '';
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
          secret: baiduSecret.value,
          mode: baiduMode.value
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

      const settings = {
        apiProvider: provider,
        prompt: prompt.value,
        language: language.value,
        theme: themeSelect.value,
        apiConfigs
      };

      await chrome.storage.local.set(settings);
      // 应用主题
      applyTheme(themeSelect.value);
      showStatus(OCRI18n.t('msg_saved'), 'success');
      return true;
    }

    function setupAutoSave() {
      const allInputs = document.querySelectorAll('input, select, textarea');
      allInputs.forEach(input => {
        listen(input, 'blur', async () => {
          // 当输入框失去焦点时自动保存
          const ok = await saveSettings();
          // 保存成功时显示字段级提示
          if (ok && input.closest('.input-wrapper')) {
            setFieldStatus(input, 'success', OCRI18n.t('msg_field_saved'));
            // 3秒后自动清除
            schedule(() => clearFieldStatus(input), 3000);
          }
        });
      });
    }

    function getProviderConfig(provider) {
      switch (provider) {
        case 'claude':
          return { apiKey: claudeApiKey.value, model: claudeModel.value };
        case 'openai':
          return { apiKey: openaiApiKey.value, model: openaiModel.value };
        case 'baidu':
          return { apiKey: baiduApiKey.value, secret: baiduSecret.value, mode: baiduMode.value };
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
          config.mode = baiduMode.value;
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

    function clearFieldStatus(inputElement) {
      const wrapper = inputElement.closest('.input-wrapper');
      if (!wrapper) return;

      const statusEl = wrapper.querySelector('.field-status');
      if (!statusEl) return;

      statusEl.classList.remove('success', 'error', 'saving');
      statusEl.textContent = '';
    }

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
    function bind() {
      listen(apiProvider, 'change', async (event) => {
        showConfigSection(event.target.value);
        await saveSettings();
      });
      listen(customAuthMode, 'change', updateCustomAuthControls);
      listen(document.getElementById('testBtn'), 'click', testConnection);
      setupAutoSave();
    }
    return { load: loadSettings, bind, setFieldStatus, clearFieldStatus };

  }
  return { create };
}));
