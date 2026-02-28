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

  // 导入导出按钮
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importFileInput = document.getElementById('importFileInput');

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
   * @returns {Promise<boolean>}
   * @description 保存所有API配置到chrome.storage，同时兼容新旧格式。返回是否保存成功。
   */
  async function saveSettings() {
    const provider = apiProvider.value;

    // 校验当前 provider 配置
    const validation = validateProviderConfig(provider);
    if (!validation.valid) {
      showFieldErrors(validation.fieldErrors, provider);
      showStatus(validation.message, 'error');
      return false;
    }

    // 清除之前的错误状态
    showFieldErrors([], provider);

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
        // 仅在保存成功时显示自动保存提示
        if (ok) {
          showStatus('已自动保存', 'success');
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
          model: customModelInput.value
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
      case 'custom':
        if (!config.endpoint || config.endpoint.trim() === '') {
          fieldErrors.push('endpoint');
        } else {
          // 验证URL格式
          try {
            new URL(config.endpoint);
          } catch {
            fieldErrors.push('endpoint_invalid');
          }
        }
        if (!config.apiKey || config.apiKey.trim() === '') {
          fieldErrors.push('apiKey');
        }
        if (!config.model || config.model.trim() === '') {
          fieldErrors.push('model');
        }
        break;
    }

    if (fieldErrors.length > 0) {
      const messages = {
        apiKey: 'API Key',
        secret: 'Secret Key',
        endpoint: 'API 端点',
        endpoint_invalid: 'API 端点格式无效（需为有效URL）',
        model: '模型名称'
      };

      const errorMessages = fieldErrors.map(f => messages[f] || f);
      return {
        valid: false,
        message: '配置不完整：' + errorMessages.join('、') + ' 未填写或格式错误',
        fieldErrors: fieldErrors
      };
    }

    return { valid: true, message: '', fieldErrors: [] };
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
          break;
        case 'openai':
          if (field === 'apiKey') element = openaiApiKey;
          break;
        case 'baidu':
          if (field === 'apiKey') element = baiduApiKey;
          if (field === 'secret') element = baiduSecret;
          break;
        case 'aliyun':
          if (field === 'apiKey') element = aliyunApiKey;
          break;
        case 'zhipu':
          if (field === 'apiKey') element = zhipuApiKey;
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

  /**
   * 导出配置到JSON文件
   * @async
   * @returns {Promise<void>}
   * @description 将当前配置导出为JSON文件下载，不包含敏感的历史记录数据
   */
  async function exportConfig() {
    try {
      showStatus('正在导出配置...', 'loading');

      // 获取当前配置（仅导出配置数据，不包含历史记录）
      const result = await chrome.storage.local.get([
        'apiProvider', 'apiConfigs', 'prompt', 'language'
      ]);

      // 构建导出数据结构
      const exportData = {
        version: '1.0.0',
        exportDate: new Date().toISOString(),
        appName: 'OCR文字识别助手',
        config: {
          apiProvider: result.apiProvider || 'claude',
          apiConfigs: result.apiConfigs || {},
          prompt: result.prompt || '',
          language: result.language || 'auto'
        }
      };

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

      showStatus('配置已成功导出', 'success');
    } catch (error) {
      console.error('导出配置失败:', error);
      showStatus('导出失败: ' + error.message, 'error');
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
      return { valid: false, error: '无效的配置文件格式', config: null };
    }

    // 检查是否有config字段（新格式）或直接是配置（兼容旧格式）
    let config = data.config || data;

    if (!config || typeof config !== 'object') {
      return { valid: false, error: '配置文件缺少必要的配置数据', config: null };
    }

    // 验证apiProvider
    const validProviders = ['claude', 'openai', 'baidu', 'aliyun', 'zhipu', 'openai-compatible', 'custom'];
    if (config.apiProvider && !validProviders.includes(config.apiProvider)) {
      return { valid: false, error: '无效的API提供商类型: ' + config.apiProvider, config: null };
    }

    // 验证apiConfigs结构
    if (config.apiConfigs && typeof config.apiConfigs !== 'object') {
      return { valid: false, error: 'apiConfigs格式无效', config: null };
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
          return { valid: false, error: `apiConfigs.${key} 格式无效`, config: null };
        }
      }
    }

    // 验证prompt和language
    if (config.prompt !== undefined && typeof config.prompt !== 'string') {
      return { valid: false, error: 'prompt格式无效', config: null };
    }

    if (config.language !== undefined && typeof config.language !== 'string') {
      return { valid: false, error: 'language格式无效', config: null };
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
            <p><strong>API提供商:</strong> ${configInfo.apiProvider || 'claude'}</p>
            ${configInfo.exportDate ? `<p><strong>导出时间:</strong> ${new Date(configInfo.exportDate).toLocaleString()}</p>` : ''}
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
          <p class="warning-text">此操作将覆盖当前所有配置，是否继续？</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" id="modalCancel">取消</button>
            <button class="btn btn-primary" id="modalConfirm">确认导入</button>
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

      const closeDialog = (result) => {
        overlay.classList.remove('active');
        setTimeout(() => {
          document.body.removeChild(overlay);
          resolve(result);
        }, 300);
      };

      cancelBtn.addEventListener('click', () => closeDialog(false));
      confirmBtn.addEventListener('click', () => closeDialog(true));

      // 点击遮罩关闭
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          closeDialog(false);
        }
      });

      // ESC键关闭
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', escHandler);
          closeDialog(false);
        }
      };
      document.addEventListener('keydown', escHandler);
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
      showStatus('请选择JSON格式的配置文件', 'error');
      return;
    }

    showStatus('正在读取配置文件...', 'loading');

    try {
      // 读取文件内容
      const content = await file.text();
      let data;

      try {
        data = JSON.parse(content);
      } catch (parseError) {
        showStatus('配置文件格式错误，请确保是有效的JSON', 'error');
        return;
      }

      // 验证配置数据
      const validation = validateImportData(data);
      if (!validation.valid) {
        showStatus('配置验证失败: ' + validation.error, 'error');
        return;
      }

      // 显示确认对话框
      const confirmed = await showConfirmDialog(
        '导入配置确认',
        '即将导入配置文件，请确认以下信息：',
        {
          apiProvider: validation.config.apiProvider,
          exportDate: data.exportDate
        }
      );

      if (!confirmed) {
        showStatus('已取消导入', 'error');
        return;
      }

      // 应用配置
      showStatus('正在应用配置...', 'loading');

      // 构建要保存的配置
      const settingsToSave = {
        apiProvider: validation.config.apiProvider || 'claude',
        apiConfigs: validation.config.apiConfigs || {},
        prompt: validation.config.prompt || '',
        language: validation.config.language || 'auto'
      };

      // 为了兼容性，也保存旧格式字段
      if (settingsToSave.apiConfigs.claude) {
        settingsToSave.apiKey = settingsToSave.apiConfigs.claude.apiKey || '';
        settingsToSave.model = settingsToSave.apiConfigs.claude.model || 'claude-3-opus-20240229';
      }
      if (settingsToSave.apiConfigs.openai) {
        settingsToSave.openaiApiKey = settingsToSave.apiConfigs.openai.apiKey || '';
        settingsToSave.openaiModel = settingsToSave.apiConfigs.openai.model || 'gpt-4o';
      }
      if (settingsToSave.apiConfigs.baidu) {
        settingsToSave.baiduApiKey = settingsToSave.apiConfigs.baidu.apiKey || '';
        settingsToSave.customSecret = settingsToSave.apiConfigs.baidu.secret || '';
      }
      if (settingsToSave.apiConfigs.aliyun) {
        settingsToSave.aliyunApiKey = settingsToSave.apiConfigs.aliyun.apiKey || '';
        settingsToSave.aliyunModel = settingsToSave.apiConfigs.aliyun.model || 'qwen-vl-max';
      }
      if (settingsToSave.apiConfigs.zhipu) {
        settingsToSave.zhipuApiKey = settingsToSave.apiConfigs.zhipu.apiKey || '';
        settingsToSave.zhipuModel = settingsToSave.apiConfigs.zhipu.model || 'glm-4v';
      }
      if (settingsToSave.apiConfigs.openaiCompatible) {
        settingsToSave.compatibleEndpoint = settingsToSave.apiConfigs.openaiCompatible.endpoint || '';
        settingsToSave.compatibleApiKey = settingsToSave.apiConfigs.openaiCompatible.apiKey || '';
        settingsToSave.compatibleModel = settingsToSave.apiConfigs.openaiCompatible.model || '';
      }
      if (settingsToSave.apiConfigs.custom) {
        settingsToSave.customEndpoint = settingsToSave.apiConfigs.custom.endpoint || '';
        settingsToSave.customApiKey = settingsToSave.apiConfigs.custom.apiKey || '';
        settingsToSave.customModel = settingsToSave.apiConfigs.custom.model || '';
      }

      // 保存到chrome.storage
      await chrome.storage.local.set(settingsToSave);

      // 重新加载页面设置
      await loadSettings();

      showStatus('配置已成功导入！', 'success');
    } catch (error) {
      console.error('导入配置失败:', error);
      showStatus('导入失败: ' + error.message, 'error');
    }
  }

  // 事件监听
  apiProvider.addEventListener('change', async (e) => {
    const newProvider = e.target.value;
    showConfigSection(newProvider);
    // 切换API时尝试保存当前选择（校验不通过则不保存，但仍允许切换）
    await saveSettings();
  });

  testBtn.addEventListener('click', testConnection);

  // 导入导出按钮事件
  exportBtn.addEventListener('click', exportConfig);
  importBtn.addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', importConfig);

  // 加载设置
  await loadSettings();

  // 设置自动保存
  setupAutoSave();
});
