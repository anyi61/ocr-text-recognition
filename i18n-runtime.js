/**
 * @fileoverview i18n-runtime.js - OCR 插件运行时国际化模块
 * @description 提供统一的国际化 API，支持插件内手动切换中英文，不依赖浏览器 UI 语言
 */

const OCRI18n = (function() {
  // 缓存的语言字典
  const dictionaries = {
    zh_CN: null,
    en: null
  };

  // 当前解析后的语言
  let resolvedLanguage = 'zh_CN';

  // 当前语言设置（auto/zh_CN/en）
  let languageSetting = 'auto';

  // 是否已初始化
  let initialized = false;
  let storageListenerBound = false;
  let languageRevision = 0;
  const ERROR_MESSAGE_KEYS = Object.freeze({
    MISSING_API_KEY: 'error_missing_api_key',
    CAPTURE_TAB_CHANGED: 'error_capture_tab_changed',
    REQUEST_TIMEOUT: 'error_request_timeout',
    EMPTY_OCR_RESULT: 'error_empty_ocr_result',
    INVALID_OCR_RESULT: 'error_invalid_ocr_result',
    OCR_RESULT_TRUNCATED: 'error_ocr_result_truncated',
    OCR_RESULT_FILTERED: 'error_ocr_result_filtered',
    OCR_RESULT_INCOMPLETE: 'error_ocr_result_incomplete',
    HISTORY_SAVE_FAILED: 'error_history_save_failed',
    OCR_ENDPOINT_PERMISSION_REQUIRED: 'error_ocr_endpoint_permission_required',
    NETWORK_ERROR: 'error_network',
    API_INVALID_REQUEST: 'error_api_invalid_request',
    API_AUTHENTICATION_FAILED: 'error_api_authentication_failed',
    API_BILLING_REQUIRED: 'error_api_billing_required',
    API_ACCESS_DENIED: 'error_api_access_denied',
    API_NOT_FOUND: 'error_api_not_found',
    API_IMAGE_TOO_LARGE: 'error_api_image_too_large',
    API_RATE_LIMITED: 'error_api_rate_limited',
    API_UNAVAILABLE: 'error_api_unavailable',
    API_HTTP_ERROR: 'error_api_http',
    INVALID_API_RESPONSE: 'error_invalid_api_response',
    BAIDU_TEST_IMAGE_RECOGNIZE_ERROR: 'warning_baidu_test_image',
    TRANSLATION_EMPTY_TEXT: 'error_translation_empty_text',
    TRANSLATION_TEXT_TOO_LONG: 'error_translation_text_too_long',
    TRANSLATION_INVALID_LANGUAGE: 'error_translation_invalid_language',
    TRANSLATION_PROVIDER_UNSUPPORTED: 'error_translation_provider_unsupported',
    TRANSLATION_PROVIDER_UNCONFIGURED: 'error_translation_provider_unconfigured',
    TRANSLATION_PERMISSION_REQUIRED: 'error_translation_permission_required',
    TRANSLATION_INVALID_REQUEST: 'error_translation_invalid_request',
    TRANSLATION_CANCELLED: 'error_translation_cancelled',
    TRANSLATION_RESULT_EMPTY: 'error_translation_result_empty',
    TRANSLATION_RESULT_INVALID: 'error_translation_result_invalid',
    TRANSLATION_RESULT_TRUNCATED: 'error_translation_result_truncated',
    TRANSLATION_RESULT_FILTERED: 'error_translation_result_filtered',
    TRANSLATION_RESULT_INCOMPLETE: 'error_translation_result_incomplete',
    TRANSLATION_REQUEST_TOO_LARGE: 'error_translation_request_too_large',
    TRANSLATION_API_INVALID_REQUEST: 'error_translation_api_invalid_request',
    TRANSLATION_SETTINGS_FAILED: 'error_translation_settings_failed',
    TRANSLATION_FAILED: 'error_translation_failed',
    UNKNOWN_PROVIDER: 'error_unknown_provider'
  });

  function normalizeLanguageSetting(setting) {
    return ['auto', 'zh_CN', 'en'].includes(setting) ? setting : 'auto';
  }

  /**
   * 绑定 storage 监听，支持跨页面语言热更新
   */
  function bindStorageListener() {
    if (storageListenerBound || !chrome?.storage?.onChanged) {
      return;
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.uiLanguage) {
        return;
      }

      const revision = ++languageRevision;
      languageSetting = normalizeLanguageSetting(changes.uiLanguage.newValue);
      resolvedLanguage = resolveLanguage(languageSetting);

      loadDictionary(resolvedLanguage).then(() => {
        if (revision !== languageRevision) return;
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('ocr-i18n-changed', {
            detail: {
              languageSetting,
              resolvedLanguage
            }
          }));
        }
      });
    });

    storageListenerBound = true;
  }

  /**
   * 获取浏览器 UI 语言映射
   * @returns {string} 映射后的语言代码
   */
  function getBrowserLanguageMapping() {
    const uiLang = chrome.i18n.getUILanguage();
    // 以 zh 开头的映射为 zh_CN
    if (uiLang && uiLang.startsWith('zh')) {
      return 'zh_CN';
    }
    return 'en';
  }

  function isExtensionPage() {
    return typeof location === 'undefined' || location.protocol === 'chrome-extension:';
  }

  /**
   * 解析语言设置
   * @param {string} setting - 语言设置（auto/zh_CN/en）
   * @returns {string} 解析后的语言代码
   */
  function resolveLanguage(setting) {
    if (setting === 'auto') {
      return getBrowserLanguageMapping();
    }
    return setting;
  }

  /**
   * 加载语言字典
   * @param {string} lang - 语言代码
   * @returns {Promise<Object>} 语言字典
   */
  async function loadDictionary(lang) {
    if (dictionaries[lang]) {
      return dictionaries[lang];
    }

    try {
      const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`Failed to load dictionary for ${lang}`);
        return {};
      }
      const data = await response.json();
      dictionaries[lang] = data;
      return data;
    } catch (error) {
      console.error(`Error loading dictionary for ${lang}:`, error);
      return {};
    }
  }

  /**
   * 初始化 i18n 模块
   * @returns {Promise<void>}
   */
  async function init() {
    if (initialized) {
      return;
    }

    const extensionPage = isExtensionPage();
    // Observe changes before either the storage read or dictionary loading can
    // yield. A newer notification must win over the initial read's snapshot.
    if (extensionPage) bindStorageListener();
    const revision = languageRevision;

    // 从存储中读取语言设置
    try {
      const result = extensionPage
        ? await chrome.storage.local.get(['uiLanguage'])
        : await chrome.runtime.sendMessage({ action: 'getContentPreferences' });
      if (revision === languageRevision) {
        languageSetting = normalizeLanguageSetting(result.uiLanguage);
        resolvedLanguage = resolveLanguage(languageSetting);
      }
    } catch (error) {
      console.error('Error reading uiLanguage from storage:', error);
      if (revision === languageRevision) {
        languageSetting = 'auto';
        resolvedLanguage = resolveLanguage(languageSetting);
      }
    }

    // 预加载两种语言字典
    await Promise.all([
      loadDictionary('zh_CN'),
      loadDictionary('en')
    ]);

    initialized = true;
  }

  /**
   * 获取翻译文本
   * @param {string} key - 消息键
   * @param {string|string[]} [substitutions] - 替换参数
   * @returns {string} 翻译后的文本
   */
  function t(key, substitutions) {
    // 优先从运行时字典获取
    const dict = dictionaries[resolvedLanguage];
    if (dict && dict[key] && dict[key].message) {
      let message = dict[key].message;

      // 处理替换参数
      if (substitutions) {
        const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
        subs.forEach((sub, index) => {
          // 支持 {0}, {1} 格式
          message = message.replace(new RegExp(`\\{${index}\\}`, 'g'), () => String(sub));
        });
      }

      return message;
    }

    // fallback: 返回 key（避免空文案）
    return key;
  }

  function errorMessage(error, fallbackKey = 'content_msg_recognition_failed') {
    const code = error?.errorCode || error?.code;
    const key = ERROR_MESSAGE_KEYS[code];
    if (key) return t(key);
    return String(error?.error || error?.message || t(fallbackKey));
  }

  /**
   * 应用翻译到 DOM 元素
   * @param {Element} [root=document] - 根元素
   */
  function applyToDom(root = document) {
    const ownerDocument = root?.nodeType === 9 ? root : root?.ownerDocument;
    if (ownerDocument?.documentElement) {
      ownerDocument.documentElement.lang = resolvedLanguage === 'zh_CN'
        ? 'zh-CN'
        : 'en';
    }

    // 处理 data-i18n 属性
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      if (key) {
        el.textContent = t(key);
      }
    });

    // 处理 data-i18n-placeholder 属性
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.dataset.i18nPlaceholder;
      if (key) {
        el.placeholder = t(key);
      }
    });

    // 处理 data-i18n-title 属性
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.dataset.i18nTitle;
      if (key) {
        el.title = t(key);
      }
    });

    // 处理 data-i18n-aria 属性
    root.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const key = el.dataset.i18nAria;
      if (key) {
        el.setAttribute('aria-label', t(key));
      }
    });
  }

  /**
   * 设置语言
   * @param {string} setting - 语言设置（auto/zh_CN/en）
   * @returns {Promise<void>}
   */
  async function setLanguage(setting) {
    const requested = normalizeLanguageSetting(setting);
    const revision = ++languageRevision;
    const response = await chrome.runtime.sendMessage({
      action: 'saveAppearancePreferences', preferences: { uiLanguage: requested }
    });
    if (!response?.success) {
      throw Object.assign(new Error('Interface language was not saved'), { code: 'SETTINGS_SAVE_FAILED' });
    }
    const language = resolveLanguage(requested);
    await loadDictionary(language);
    // Storage notifications and newer selections take priority over this reply.
    if (revision !== languageRevision) return;
    languageSetting = requested;
    resolvedLanguage = language;
  }

  /**
   * 获取当前语言设置
   * @returns {string} 语言设置（auto/zh_CN/en）
   */
  function getLanguageSetting() {
    return languageSetting;
  }

  /**
   * 获取解析后的语言代码
   * @returns {string} 语言代码（zh_CN/en）
   */
  function getResolvedLanguage() {
    return resolvedLanguage;
  }

  // 导出公共 API
  return {
    init,
    t,
    applyToDom,
    setLanguage,
    getLanguageSetting,
    getResolvedLanguage,
    errorMessage
  };
})();

// 如果在 content script 环境，挂载到 window
if (typeof window !== 'undefined') {
  window.OCRI18n = OCRI18n;
}
