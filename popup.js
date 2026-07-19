/**
 * @fileoverview popup.js - OCR文字识别助手弹出窗口逻辑
 * @description 处理弹出窗口的UI交互、历史记录显示和复制功能
 */

// popup.js - 弹出窗口逻辑
// 使用统一的 OCRI18n API（来自 i18n-runtime.js）

document.addEventListener('DOMContentLoaded', async () => {
  // 初始化 i18n
  await OCRI18n.init();
  OCRI18n.applyToDom(document);

  // 获取DOM元素
  const captureBtn = document.getElementById('captureBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const themeBtn = document.getElementById('themeBtn');
  const languageSelect = document.getElementById('languageSelect');
  const configTip = document.getElementById('configTip');
  const historyArea = document.getElementById('historyArea');
  const historyList = document.getElementById('historyList');
  const historyEmptyState = document.getElementById('historyEmptyState');
  const historySearchEmptyState = document.getElementById('historySearchEmptyState');
  const historySearchWrap = document.getElementById('historySearchWrap');
  const historySearch = document.getElementById('historySearch');
  const exportHistoryBtn = document.getElementById('exportHistoryBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const historyPreview = document.getElementById('historyPreview');
  const historyPreviewMeta = document.getElementById('historyPreviewMeta');
  const historyPreviewText = document.getElementById('historyPreviewText');
  const closePreviewBtn = document.getElementById('closePreviewBtn');
  const previewCopyBtn = document.getElementById('previewCopyBtn');
  const a11yLive = document.getElementById('a11y-live');

  /**
   * 统一的状态播报函数
   * @param {string} message - 播报文案
   */
  const announcePopupStatus = (message) => {
    if (a11yLive) {
      a11yLive.textContent = message;
    }
  };

  // 历史记录数据（用于点击查看）
  let historyData = [];
  let activePreviewId = null;

  const providerLabels = Object.freeze({
    claude: 'Claude',
    openai: 'OpenAI',
    baidu: 'Baidu OCR',
    aliyun: 'Aliyun',
    zhipu: 'Zhipu AI',
    'openai-compatible': 'OpenAI Compatible',
    custom: 'Custom API'
  });

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

  // 检查是否已配置API（支持多API配置）
  const checkConfig = async () => {
    const result = await chrome.storage.local.get([
      'apiProvider', 'apiConfigs', 'apiKey',
      'compatibleEndpoint', 'compatibleApiKey', 'compatibleModel',
      'customEndpoint', 'customApiKey', 'customModel'
    ]);
    const provider = result.apiProvider || 'claude';

    // 共享映射会处理 openai-compatible 的存储键及旧版 Claude 配置。
    const hasApiKey = OCRProviderConfig.hasRequiredCredentials(
      result.apiConfigs,
      provider,
      result
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
    const result = await chrome.storage.local.get([
      'apiProvider', 'apiConfigs',
      'compatibleEndpoint', 'compatibleApiKey', 'compatibleModel',
      'customEndpoint', 'customApiKey', 'customModel'
    ]);
    const provider = result.apiProvider || 'claude';

    if (provider !== 'openai-compatible' && provider !== 'custom') {
      return true;
    }

    const modernConfig = OCRProviderConfig.getProviderConfig(result.apiConfigs, provider);
    const legacyEndpoint = provider === 'openai-compatible'
      ? result.compatibleEndpoint
      : result.customEndpoint;
    return OCRExtensionRuntime.requestEndpointPermission(
      chrome,
      provider,
      modernConfig.endpoint || legacyEndpoint
    );
  };

  const getLanguageLabel = (language) => {
    const key = ['zh', 'en', 'ja', 'ko'].includes(language)
      ? `language_${language}`
      : 'language_auto';
    return OCRI18n.t(key);
  };

  const formatHistoryTimestamp = (item) => {
    const timestamp = Number(item?.timestamp);
    if (!Number.isFinite(timestamp)) {
      return String(item?.date || '');
    }
    const locale = OCRI18n.getResolvedLanguage() === 'en' ? 'en-US' : 'zh-CN';
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(timestamp));
  };

  const getHistorySource = (item) => (
    String(item?.sourceTitle || item?.sourceUrl || '').trim()
  );

  const getFilteredHistory = () => {
    const query = historySearch.value.trim().toLocaleLowerCase();
    if (!query) return [...historyData];

    return historyData.filter((item) => [
      item.text,
      item.provider,
      item.language,
      item.sourceTitle,
      item.sourceUrl
    ].some((value) => String(value || '').toLocaleLowerCase().includes(query)));
  };

  /**
   * 显示历史详情预览
   * @param {Object} item - 历史记录
   */
  const showHistoryPreview = (item) => {
    activePreviewId = item.id;
    historyPreviewText.value = item.text || '';
    historyPreviewMeta.replaceChildren();

    const metadata = [
      `${OCRI18n.t('history_provider')}: ${providerLabels[item.provider] || item.provider || '-'}`,
      `${OCRI18n.t('history_language')}: ${getLanguageLabel(item.language)}`,
      formatHistoryTimestamp(item)
    ];
    const source = getHistorySource(item);
    if (source) {
      metadata.push(`${OCRI18n.t('history_source')}: ${source}`);
    }
    metadata.forEach((value) => {
      const span = document.createElement('span');
      span.textContent = value;
      if (source && value.endsWith(source) && item.sourceUrl) {
        span.title = item.sourceUrl;
      }
      historyPreviewMeta.appendChild(span);
    });

    historyPreview.classList.remove('hidden');
    historyList.classList.add('hidden');
    historySearchEmptyState.classList.add('hidden');
    historyEmptyState.classList.add('hidden');
  };

  /**
   * 隐藏历史详情预览
   */
  const hideHistoryPreview = () => {
    activePreviewId = null;
    historyPreview.classList.add('hidden');
    renderHistory();
  };

  /**
   * 渲染当前历史记录及搜索结果。
   */
  function renderHistory() {
    historyArea.classList.remove('hidden');
    historyList.replaceChildren();
    historyPreview.classList.add('hidden');
    historyEmptyState.classList.toggle('hidden', historyData.length > 0);
    historySearchWrap.classList.toggle('hidden', historyData.length === 0);
    clearHistoryBtn.classList.toggle('hidden', historyData.length === 0);
    exportHistoryBtn.classList.toggle('hidden', historyData.length === 0);

    if (historyData.length === 0) {
      historyList.classList.add('hidden');
      historySearchEmptyState.classList.add('hidden');
      return;
    }

    const history = getFilteredHistory();
    historySearchEmptyState.classList.toggle('hidden', history.length > 0);
    historyList.classList.toggle('hidden', history.length === 0);

    history.forEach((item) => {
      const text = String(item.text || '');
      const source = getHistorySource(item);
      const historyItem = document.createElement('div');
      historyItem.className = 'history-item';
      historyItem.setAttribute('tabindex', '0');
      historyItem.setAttribute('role', 'button');
      historyItem.setAttribute('aria-label', `${OCRI18n.t('history_view_detail')}: ${text.substring(0, 30)}`);

      historyItem.innerHTML = `
        <div class="history-item-text" title="${escapeHtml(text)}">${escapeHtml(text)}</div>
        <div class="history-item-meta">
          <div class="history-item-context">
            <div class="history-item-tags">
              <span class="history-tag">${escapeHtml(providerLabels[item.provider] || item.provider || '-')}</span>
              <span class="history-tag">${escapeHtml(getLanguageLabel(item.language))}</span>
              <span class="timestamp">${escapeHtml(formatHistoryTimestamp(item))}</span>
            </div>
            ${source ? `<span class="history-source" title="${escapeHtml(item.sourceUrl || source)}">${escapeHtml(source)}</span>` : ''}
          </div>
          <div class="history-item-actions">
            <button class="history-copy-btn" type="button" title="${OCRI18n.t('content_btn_copy')}" aria-label="${OCRI18n.t('history_copy')}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
            <button class="history-delete-btn" type="button" title="${OCRI18n.t('history_delete')}" aria-label="${OCRI18n.t('history_delete')}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </div>
      `;

      historyItem.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        showHistoryPreview(item);
      });
      historyItem.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button')) {
          event.preventDefault();
          showHistoryPreview(item);
        }
      });

      const copyBtn = historyItem.querySelector('.history-copy-btn');
      copyBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          announcePopupStatus(OCRI18n.t('a11y_copy_success'));
          copyBtn.classList.add('copied');
          setTimeout(() => copyBtn.classList.remove('copied'), 1500);
        } catch (error) {
          console.error('复制失败:', error);
          announcePopupStatus(OCRI18n.t('a11y_copy_failed'));
        }
      });

      historyItem.querySelector('.history-delete-btn').addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!confirm(OCRI18n.t('confirm_delete_history'))) return;

        try {
          const response = await chrome.runtime.sendMessage({
            action: 'deleteHistoryRecord',
            historyId: item.id
          });
          if (!response?.success) {
            throw new Error(response?.error || OCRI18n.t('msg_history_action_failed'));
          }
          historyData = historyData.filter((record) => record.id !== item.id);
          if (activePreviewId === item.id) activePreviewId = null;
          announcePopupStatus(OCRI18n.t('a11y_history_deleted'));
          renderHistory();
        } catch (error) {
          console.error('删除历史记录失败:', error);
          alert(OCRI18n.t('msg_history_action_failed'));
        }
      });

      historyList.appendChild(historyItem);
    });
  }

  /**
   * 从存储中加载历史记录。
   */
  const loadHistory = async () => {
    try {
      const result = await chrome.storage.local.get(['ocrHistory']);
      historyData = Array.isArray(result.ocrHistory) ? result.ocrHistory : [];
      renderHistory();
    } catch (error) {
      console.error('加载历史记录失败:', error);
      historyData = [];
      renderHistory();
    }
  };

  /**
   * 清空历史记录
   * @async
   * @returns {Promise<void>}
   */
  const clearHistory = async () => {
    if (confirm(OCRI18n.t('confirm_clear_history'))) {
      try {
        const response = await chrome.runtime.sendMessage({ action: 'clearHistory' });
        if (!response?.success) {
          throw new Error(response?.error || OCRI18n.t('msg_history_action_failed'));
        }
        announcePopupStatus(OCRI18n.t('a11y_history_cleared'));
        historyData = [];
        activePreviewId = null;
        historySearch.value = '';
        renderHistory();
      } catch (error) {
        console.error('清空历史记录失败:', error);
        alert(OCRI18n.t('msg_history_action_failed'));
      }
    }
  };

  /**
   * 将全部历史记录导出为可移植 JSON 文件。
   */
  const exportHistory = () => {
    if (historyData.length === 0) return;

    const exportData = {
      version: 1,
      exportDate: new Date().toISOString(),
      records: historyData.map((item) => ({
        id: item.id,
        text: item.text || '',
        timestamp: Number(item.timestamp) || null,
        provider: item.provider || '',
        language: item.language || 'auto',
        sourceTitle: item.sourceTitle || '',
        sourceUrl: item.sourceUrl || ''
      }))
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ocr-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    announcePopupStatus(OCRI18n.t('a11y_history_exported'));
  };

  /**
   * HTML转义函数
   * @param {string} text - 原始文本
   * @returns {string} 转义后的HTML安全文本
   * @description 防止XSS攻击，将特殊字符转换为HTML实体
   */
  const escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };

  // 初始化
  // 设置语言选择器当前值
  languageSelect.value = OCRI18n.getLanguageSetting();
  await loadTheme();
  await checkConfig();
  await loadHistory();

  // 主题切换按钮事件
  themeBtn.addEventListener('click', toggleTheme);

  // 语言切换事件
  languageSelect.addEventListener('change', async (e) => {
    const newLang = e.target.value;
    await OCRI18n.setLanguage(newLang);
    OCRI18n.applyToDom(document);
    renderHistory();
  });

  historySearch.addEventListener('input', renderHistory);
  exportHistoryBtn.addEventListener('click', exportHistory);

  // 清空历史按钮事件
  clearHistoryBtn.addEventListener('click', clearHistory);

  // 关闭预览按钮事件
  closePreviewBtn.addEventListener('click', hideHistoryPreview);

  // 预览复制按钮事件
  previewCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(historyPreviewText.value);
      announcePopupStatus(OCRI18n.t('a11y_copy_success'));
      previewCopyBtn.textContent = OCRI18n.t('btn_copied');
      setTimeout(() => {
        previewCopyBtn.textContent = OCRI18n.t('btn_copy_all');
      }, 1500);
    } catch (err) {
      console.error('复制失败:', err);
      announcePopupStatus(OCRI18n.t('a11y_copy_failed'));
    }
  });

  // 配置提示点击事件
  configTip.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // 设置按钮点击事件
  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // 开始截图识别
  captureBtn.addEventListener('click', async () => {
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
});
