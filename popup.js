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
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const historyPreview = document.getElementById('historyPreview');
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

  /**
   * 显示历史详情预览
   * @param {string} text - 识别结果文本
   */
  const showHistoryPreview = (text) => {
    historyPreviewText.value = text;
    historyPreview.classList.remove('hidden');
    historyList.classList.add('hidden');
    historyEmptyState.classList.add('hidden');
  };

  /**
   * 隐藏历史详情预览
   */
  const hideHistoryPreview = () => {
    historyPreview.classList.add('hidden');
    // 根据历史记录数量决定显示列表还是空状态
    if (historyData.length === 0) {
      historyList.classList.add('hidden');
      historyEmptyState.classList.remove('hidden');
    } else {
      historyList.classList.remove('hidden');
    }
  };

  /**
   * 加载历史记录
   * @async
   * @returns {Promise<void>}
   * @description 从存储中加载识别历史记录并显示在popup中
   */
  const loadHistory = async () => {
    try {
      const result = await chrome.storage.local.get(['ocrHistory']);
      const history = result.ocrHistory || [];
      historyData = history; // 保存数据供点击查看使用

      // 始终显示历史区域
      historyArea.classList.remove('hidden');

      if (history.length === 0) {
        // 显示空状态，隐藏列表和清空按钮
        historyEmptyState.classList.remove('hidden');
        historyList.classList.add('hidden');
        clearHistoryBtn.classList.add('hidden');
        return;
      }

      // 有历史记录：隐藏空状态，显示列表和清空按钮
      historyEmptyState.classList.add('hidden');
      historyList.classList.remove('hidden');
      clearHistoryBtn.classList.remove('hidden');
      historyList.innerHTML = '';

      history.forEach((item, index) => {
        const historyItem = document.createElement('div');
        historyItem.className = 'history-item';
        historyItem.setAttribute('tabindex', '0');
        historyItem.setAttribute('role', 'button');
        historyItem.setAttribute('aria-label', `${OCRI18n.t('history_view_detail')}: ${item.text.substring(0, 30)}...`);

        historyItem.innerHTML = `
          <div class="history-item-text" title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</div>
          <div class="history-item-meta">
            <span class="timestamp">${item.date}</span>
            <button class="history-copy-btn" data-index="${index}" title="${OCRI18n.t('content_btn_copy')}" aria-label="${OCRI18n.t('history_copy')}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </div>
        `;

        // 点击历史项查看详情
        historyItem.addEventListener('click', (e) => {
          // 如果点击的是复制按钮，不触发预览
          if (e.target.closest('.history-copy-btn')) return;
          showHistoryPreview(history[index].text);
        });

        // 键盘支持
        historyItem.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            if (e.target.classList.contains('history-copy-btn')) return;
            e.preventDefault();
            showHistoryPreview(history[index].text);
          }
        });

        historyList.appendChild(historyItem);
      });

      // 绑定复制按钮事件
      document.querySelectorAll('.history-copy-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const index = parseInt(btn.dataset.index);
          const text = history[index].text;
          try {
            await navigator.clipboard.writeText(text);
            announcePopupStatus(OCRI18n.t('a11y_copy_success'));
            // 使用规范中的成功图标
            btn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            `;
            btn.classList.add('copied');
            setTimeout(() => {
              btn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              `;
              btn.classList.remove('copied');
            }, 1500);
          } catch (err) {
            console.error('复制失败:', err);
            announcePopupStatus(OCRI18n.t('a11y_copy_failed'));
          }
        });
      });
    } catch (error) {
      console.error('加载历史记录失败:', error);
    }
  };

  /**
   * 清空历史记录
   * @async
   * @returns {Promise<void>}
   */
  const clearHistory = async () => {
    if (confirm(OCRI18n.t('confirm_clear_history'))) {
      await chrome.storage.local.remove(['ocrHistory']);
      announcePopupStatus(OCRI18n.t('a11y_history_cleared'));
      historyData = [];
      historyEmptyState.classList.remove('hidden');
      historyList.classList.add('hidden');
      clearHistoryBtn.classList.add('hidden');
      // 隐藏预览（会根据 historyData.length 正确显示空状态）
      historyPreview.classList.add('hidden');
    }
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
  });

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
      await OCRExtensionRuntime.startCaptureInTab(chrome, tab.id);

      // 关闭popup窗口
      window.close();
    } catch (error) {
      console.error('启动截图失败:', error);
      announcePopupStatus(OCRI18n.t('a11y_capture_start_failed'));
      alert(OCRI18n.t('msg_capture_failed'));
    }
  });
});
