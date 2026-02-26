/**
 * @fileoverview options.js - OCR文字识别助手设置页面逻辑
 * @description 处理设置页面的配置加载、保存、API测试等功能
 */

document.addEventListener('DOMContentLoaded', async () => {
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

  // 高级设置
  const prompt = document.getElementById('prompt');
  const language = document.getElementById('language');

  // 按钮
  const testBtn = document.getElementById('testBtn');
  const statusMessage = document.getElementById('statusMessage');

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
    const claudeConfig = configs.claude || {};
    claudeApiKey.value = claudeConfig.apiKey || result.apiKey || '';
    claudeModel.value = claudeConfig.model || result.model || 'claude-3-opus-20240229';

    // OpenAI 配置
    const openaiConfig = configs.openai || {};
    openaiApiKey.value = openaiConfig.apiKey || result.openaiApiKey || '';
    openaiModel.value = openaiConfig.model || result.openaiModel || 'gpt-4o';

    // 百度配置
    const baiduConfig = configs.baidu || {};
    baiduApiKey.value = baiduConfig.apiKey || result.baiduApiKey || '';
    baiduSecret.value = baiduConfig.secret || result.customSecret || '';

    // 阿里云配置
    const aliyunCfg = configs.aliyun || {};
    aliyunApiKey.value = aliyunCfg.apiKey || result.aliyunApiKey || '';
    aliyunModel.value = aliyunCfg.model || result.aliyunModel || 'qwen-vl-max';

    // 智谱AI配置
    const zhipuCfg = configs.zhipu || {};
    zhipuApiKey.value = zhipuCfg.apiKey || result.zhipuApiKey || '';
    zhipuModel.value = zhipuCfg.model || result.zhipuModel || 'glm-4v';

    // 通用OpenAI兼容接口配置
    const compatibleCfg = configs.openaiCompatible || {};
    compatibleEndpoint.value = compatibleCfg.endpoint || result.compatibleEndpoint || '';
    compatibleApiKey.value = compatibleCfg.apiKey || result.compatibleApiKey || '';
    compatibleModel.value = compatibleCfg.model || result.compatibleModel || '';

    // 自定义API配置
    const customCfg = configs.custom || {};
    customEndpointInput.value = customCfg.endpoint || result.customEndpoint || '';
    customApiKeyInput.value = customCfg.apiKey || result.customApiKey || '';
    customModelInput.value = customCfg.model || result.customModel || '';

    // 高级设置
    if (result.prompt) {
      prompt.value = result.prompt;
    }
    if (result.language) {
      language.value = result.language;
    }
  }

  /**
   * 保存设置
   * @async
   * @returns {Promise<void>}
   * @description 保存所有API配置到chrome.storage，同时兼容新旧格式
   */
  async function saveSettings() {
    const provider = apiProvider.value;

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
        model: customModelInput.value
      }
    };

    // 同时保存旧格式以兼容旧代码
    const settings = {
      apiProvider: provider,
      prompt: prompt.value,
      language: language.value,
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
    showStatus('设置已保存', 'success');
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
        await saveSettings();
        // 显示自动保存提示
        showStatus('已自动保存', 'success');
      });
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

    testBtn.disabled = true;
    showStatus('正在测试连接...', 'loading');

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
        config.model = openaiModel.value || 'gpt-4o';
        break;
      case 'baidu':
        config.apiKey = baiduApiKey.value;
        config.customSecret = baiduSecret.value;
        break;
      case 'aliyun':
        config.apiKey = aliyunApiKey.value;
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
        break;
    }

    if (!config.apiKey) {
      showStatus('请先输入API Key', 'error');
      testBtn.disabled = false;
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'testAPI',
        config: config
      });

      if (response.success) {
        showStatus('连接成功！API配置正确', 'success');
      } else {
        showStatus('连接失败: ' + response.error, 'error');
      }
    } catch (error) {
      showStatus('测试失败: ' + error.message, 'error');
    }

    testBtn.disabled = false;
  }

  /**
   * 显示状态消息
   * @param {string} message - 状态消息内容
   * @param {string} type - 消息类型 (success|error|loading)
   * @description 在页面上方显示状态消息，非loading类型5秒后自动隐藏
   */
  function showStatus(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = 'status-message ' + type;
    statusMessage.classList.remove('hidden');

    if (type !== 'loading') {
      setTimeout(() => {
        statusMessage.classList.add('hidden');
      }, 5000);
    }
  }

  // 事件监听
  apiProvider.addEventListener('change', async (e) => {
    showConfigSection(e.target.value);
    // 切换API时自动保存当前选择
    await saveSettings();
  });

  testBtn.addEventListener('click', testConnection);

  // 加载设置
  await loadSettings();

  // 设置自动保存
  setupAutoSave();
});
