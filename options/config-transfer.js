// @ts-check
/** Imports and exports compatible settings, with cancellable import dialogs. */
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRConfigTransfer = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create(dependencies) {
    const { document, chrome, i18n: OCRI18n, config: OCRProviderConfig,
      optionsRuntime: OptionsRuntime, showStatus, loadSettings, loadTheme,
      getRuntimeVersion, isActive, listen } = dependencies;
    const includeApiKeys = document.getElementById('includeApiKeys');
    const modals = new Set();
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
        const runtimeVersion = getRuntimeVersion();
        const exportData = OptionsRuntime.buildExportData(result, exportedApiConfigs, runtimeVersion);

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

      config = {
        ...config,
        apiConfigs: OCRProviderConfig.mergeModernAndLegacyConfigs(config.apiConfigs, config)
      };

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

    function showConfirmDialog(title, message, configInfo) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
          <div class="modal-dialog">
            <h3 class="modal-title"></h3>
            <p class="modal-message"></p>
            <div class="config-info hidden">
              <p class="config-provider"><strong></strong><span></span></p>
              <p class="config-export-date hidden"><strong></strong><span></span></p>
            </div>
            <p class="warning-text"></p>
            <div class="modal-actions">
              <button class="btn btn-secondary" id="modalCancel"></button>
              <button class="btn btn-primary" id="modalConfirm"></button>
            </div>
          </div>
        `;

        overlay.querySelector('.modal-title').textContent = title;
        overlay.querySelector('.modal-message').textContent = message;
        overlay.querySelector('.warning-text').textContent = OCRI18n.t('modal_import_warning');
        overlay.querySelector('#modalCancel').textContent = OCRI18n.t('btn_cancel');
        overlay.querySelector('#modalConfirm').textContent = OCRI18n.t('btn_confirm_import');

        if (configInfo) {
          const info = overlay.querySelector('.config-info');
          info.classList.remove('hidden');
          const provider = info.querySelector('.config-provider');
          provider.querySelector('strong').textContent = `${OCRI18n.t('modal_api_provider')}: `;
          provider.querySelector('span').textContent = String(configInfo.apiProvider || 'claude');
          if (configInfo.exportDate) {
            const exportDate = info.querySelector('.config-export-date');
            exportDate.classList.remove('hidden');
            exportDate.querySelector('strong').textContent = `${OCRI18n.t('modal_export_date')}: `;
            exportDate.querySelector('span').textContent = new Date(configInfo.exportDate).toLocaleString();
          }
        }

        document.body.appendChild(overlay);

        // 触发动画
        requestAnimationFrame(() => {
          overlay.classList.add('active');
        });

        // 绑定事件
        const cancelBtn = overlay.querySelector('#modalCancel');
        const confirmBtn = overlay.querySelector('#modalConfirm');

        const modal = OptionsRuntime.createModalLifecycle(
          document,
          overlay,
          (value) => { modals.delete(modal); resolve(value); }
        );
        modals.add(modal);
        const closeDialog = modal.close;

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
        if (!isActive()) return;
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

        if (!isActive()) return;
        if (!confirmed) {
          showStatus(OCRI18n.t('msg_import_cancelled'), 'error');
          return;
        }

        // 应用配置
        showStatus(OCRI18n.t('msg_applying_config'), 'loading');

        const existingSettings = await chrome.storage.local.get([
          'apiConfigs', 'theme', 'uiLanguage'
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
    function bind() {
      const input = document.getElementById('importFileInput');
      listen(document.getElementById('exportBtn'), 'click', exportConfig);
      listen(document.getElementById('importBtn'), 'click', () => input.click());
      listen(input, 'change', importConfig);
    }
    return { bind, validateImportData,
      destroy() { for (const modal of modals) modal.destroy(); modals.clear(); } };

  }
  return { create };
}));
