// @ts-check
/** Owns Popup initialization, capture launch, appearance and storage subscription. */
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRPopupController = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create(dependencies) {
    const { document, window, chrome, navigator, i18n: OCRI18n, config: OCRProviderConfig,
      runtime: OCRExtensionRuntime, popupRuntime, historyModule } = dependencies;
    const events = new AbortController();
    const timers = new Set();
    let destroyed = false;
    let initialized = false;
    function listen(target, type, callback) {
      if (!destroyed) target.addEventListener(type, callback, { signal: events.signal });
    }
    function schedule(callback, delay) {
      if (destroyed) return null;
      const timer = setTimeout(() => { timers.delete(timer); if (!destroyed) callback(); }, delay);
      timers.add(timer);
      return timer;
    }
    function clearScheduled(timer) { clearTimeout(timer); timers.delete(timer); }
    const captureBtn = document.getElementById('captureBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const themeBtn = document.getElementById('themeBtn');
    const languageSelect = document.getElementById('languageSelect');
    const configTip = document.getElementById('configTip');
    const a11yLive = document.getElementById('a11y-live');
    const popupShortcutStatus = document.getElementById('popupShortcutStatus');

    /**
     * 统一的状态播报函数
     * @param {string} message - 播报文案
     */
    const announcePopupStatus = (message) => {
      if (a11yLive) {
        a11yLive.textContent = message;
      }
    };

    /**
     * 应用主题
     * @param {string} theme - 主题名称 (light|dark)
     */
    const applyTheme = (theme) => {
      document.documentElement.dataset.theme = theme;
      // 更新图标显示
      const lightIcon = themeBtn.querySelector('.theme-icon-light');
      const darkIcon = themeBtn.querySelector('.theme-icon-dark');
      if (theme === 'dark') {
        lightIcon.style.display = 'none';
        darkIcon.style.display = 'block';
      } else {
        lightIcon.style.display = 'block';
        darkIcon.style.display = 'none';
      }
    };

    /**
     * 切换主题
     */
    const toggleTheme = async () => {
      const currentTheme = document.documentElement.dataset.theme || 'light';
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      applyTheme(newTheme);
      await chrome.storage.local.set({ theme: newTheme });
    };

    /**
     * 加载主题设置
     */
    const loadTheme = async () => {
      const result = await chrome.storage.local.get(['theme']);
      const theme = result.theme || 'light';
      applyTheme(theme);
    };

    const loadShortcutStatus = async () => {
      popupShortcutStatus.classList.remove('warning');
      try {
        const commands = await chrome.commands.getAll();
        const captureCommand = commands.find((command) => command.name === 'start-capture');
        const shortcut = String(captureCommand?.shortcut || '').trim();
        popupShortcutStatus.textContent = shortcut
          ? OCRI18n.t('shortcut_assigned', [shortcut])
          : OCRI18n.t('shortcut_unassigned_help');
        popupShortcutStatus.classList.toggle('warning', !shortcut);
      } catch (error) {
        console.warn('读取快捷键状态失败:', error);
        popupShortcutStatus.textContent = OCRI18n.t('shortcut_status_unavailable');
      }
    };

    // 检查是否已配置API（支持多API配置）
    const checkConfig = async () => {
      const result = await chrome.storage.local.get(['apiProvider', 'apiConfigs']);
      const provider = result.apiProvider || 'claude';

      const hasApiKey = OCRProviderConfig.hasRequiredCredentials(
        result.apiConfigs,
        provider
      );

      if (!hasApiKey) {
        configTip.classList.remove('hidden');
        return false;
      }
      configTip.classList.add('hidden');
      return true;
    };

    /**
     * Requests access to a user-configured API origin when the selected provider
     * is not covered by the extension's fixed host permissions.
     */
    const requestEndpointPermission = async () => {
      const result = await chrome.storage.local.get(['apiProvider', 'apiConfigs']);
      const provider = result.apiProvider || 'claude';

      if (provider !== 'openai-compatible' && provider !== 'custom') {
        return true;
      }

      const modernConfig = OCRProviderConfig.getProviderConfig(result.apiConfigs, provider);
      return OCRExtensionRuntime.requestEndpointPermission(
        chrome,
        provider,
        modernConfig.endpoint
      );
    };


    const history = historyModule.create({ document, chrome, navigator, i18n: OCRI18n,
      popupRuntime, announcePopupStatus, listen, schedule, isActive: () => !destroyed });
    let storageListener = null;
    async function init() {
      if (initialized || destroyed) return;
      initialized = true;
      await OCRI18n.init();
      if (destroyed) return;
      OCRI18n.applyToDom(document);
      await OCRProviderConfig.migrateLegacyConfigOnce(chrome.storage.local);
      if (destroyed) return;
      // 初始化
      // 设置语言选择器当前值
      languageSelect.value = OCRI18n.getLanguageSetting();
      await loadTheme();
      await checkConfig();
      await loadShortcutStatus();
      await history.load();

      // Keep an open popup synchronized with OCR results written by content tabs.
      // renderHistory reads the existing search input, preserving the active filter.
      storageListener = (changes, areaName) => {
        if (!destroyed && areaName === 'local' && changes.ocrHistory) {
          history.load();
        }
      };
      if (!destroyed) chrome.storage.onChanged.addListener(storageListener);

      // 主题切换按钮事件
      listen(themeBtn, 'click', toggleTheme);

      // 语言切换事件
      listen(languageSelect, 'change', async (e) => {
        const newLang = e.target.value;
        await OCRI18n.setLanguage(newLang);
        OCRI18n.applyToDom(document);
        await loadShortcutStatus();
        history.render();
      });


      history.bind();
      // 配置提示点击事件
      listen(configTip, 'click', () => {
        chrome.runtime.openOptionsPage();
      });

      // 设置按钮点击事件
      listen(settingsBtn, 'click', () => {
        chrome.runtime.openOptionsPage();
      });

      // 开始截图识别
      listen(captureBtn, 'click', async () => {
        // 检查配置
        const hasConfig = await checkConfig();
        if (!hasConfig) {
          announcePopupStatus(OCRI18n.t('a11y_config_missing'));
          alert(OCRI18n.t('msg_config_api_first'));
          return;
        }

        try {
          const permissionGranted = await requestEndpointPermission();
          if (!permissionGranted) {
            announcePopupStatus(OCRI18n.t('msg_endpoint_permission_denied'));
            alert(OCRI18n.t('msg_endpoint_permission_denied'));
            return;
          }

          // 获取当前活动标签页
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

          if (!tab) {
            alert(OCRI18n.t('msg_no_tab'));
            return;
          }

          // 发送消息；按需注入依赖和内容脚本后重试。
          await OCRExtensionRuntime.startCaptureInTab(chrome, tab);

          // 关闭popup窗口
          window.close();
        } catch (error) {
          console.error('启动截图失败:', error);
          announcePopupStatus(OCRI18n.t('a11y_capture_start_failed'));
          if (error?.code === 'UNSUPPORTED_PAGE') {
            const key = error.reason === 'browser_store'
              ? 'msg_capture_browser_store'
              : error.reason === 'file_access'
                ? 'msg_capture_file_access'
                : 'msg_capture_browser_internal';
            alert(OCRI18n.t(key));
          } else {
            alert(OCRI18n.t('msg_capture_failed'));
          }
        }
      });
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      events.abort();
      if (storageListener) chrome.storage.onChanged.removeListener(storageListener);
      history.destroy();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      window.removeEventListener('pagehide', destroy);
    }
    window.addEventListener('pagehide', destroy);
    return { init, destroy };

  }
  return { create };
}));
