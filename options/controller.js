// @ts-check
/** Owns settings-page initialization, appearance, listeners and timers. */
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCROptionsController = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create(dependencies) {
    const { document, window, chrome, i18n: OCRI18n, config: OCRProviderConfig,
      runtime, optionsRuntime: OptionsRuntime, formModule, transferModule, getRuntimeVersion } = dependencies;
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
    const themeSelect = document.getElementById('theme');
    const uiLanguageSelect = document.getElementById('uiLanguage');
    const captureShortcutStatus = document.getElementById('captureShortcutStatus');
    const shortcutAssignmentState = document.getElementById('shortcutAssignmentState');
    async function loadShortcutStatus() {
      try {
        const commands = await chrome.commands.getAll();
        const captureCommand = commands.find((command) => command.name === 'start-capture');
        const shortcut = String(captureCommand?.shortcut || '').trim();
        captureShortcutStatus.textContent = shortcut || OCRI18n.t('shortcut_unassigned');
        shortcutAssignmentState.textContent = shortcut
          ? OCRI18n.t('shortcut_assigned', [shortcut])
          : OCRI18n.t('shortcut_unassigned_help');
      } catch (error) {
        console.warn('读取快捷键状态失败:', error);
        captureShortcutStatus.textContent = OCRI18n.t('shortcut_unassigned');
        shortcutAssignmentState.textContent = OCRI18n.t('shortcut_status_unavailable');
      }
    }
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

    let transfer;
    async function init() {
      if (initialized || destroyed) return;
      initialized = true;
      await OCRI18n.init();
      if (destroyed) return;
      OCRI18n.applyToDom(document);
      await OCRProviderConfig.migrateLegacyConfigOnce(chrome.storage.local);
      if (destroyed) return;
      const showStatus = OptionsRuntime.createStatusPresenter(document.getElementById('statusMessage'), {
        setTimeout: schedule, clearTimeout: clearScheduled
      });
      const form = formModule.create({ document, chrome, i18n: OCRI18n, config: OCRProviderConfig,
        runtime, showStatus, applyTheme, listen, schedule });
      transfer = transferModule.create({ document, chrome, i18n: OCRI18n, config: OCRProviderConfig,
        optionsRuntime: OptionsRuntime, showStatus, loadSettings: form.load, loadTheme,
        getRuntimeVersion, isActive: () => !destroyed, listen });
      listen(themeSelect, 'change', async () => {
        const theme = themeSelect.value;
        applyTheme(theme);
        await chrome.storage.local.set({ theme });
        form.setFieldStatus(themeSelect, 'success', OCRI18n.t('msg_field_saved'));
        schedule(() => form.clearFieldStatus(themeSelect), 3000);
      });
      listen(uiLanguageSelect, 'change', async () => {
        await OCRI18n.setLanguage(uiLanguageSelect.value);
        OCRI18n.applyToDom(document);
        await loadShortcutStatus();
        form.setFieldStatus(uiLanguageSelect, 'success', OCRI18n.t('msg_field_saved'));
        schedule(() => form.clearFieldStatus(uiLanguageSelect), 3000);
      });
      transfer.bind();
      await form.load();
      await loadTheme();
      await loadShortcutStatus();
      form.bind();
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      events.abort();
      transfer?.destroy();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      window.removeEventListener('pagehide', destroy);
    }
    window.addEventListener('pagehide', destroy);
    return { init, destroy };

  }
  return { create };
}));
