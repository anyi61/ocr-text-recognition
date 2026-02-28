/**
 * @fileoverview popup.js - OCR文字识别助手弹出窗口逻辑
 * @description 处理弹出窗口的UI交互、历史记录显示和复制功能
 */

// popup.js - 弹出窗口逻辑

document.addEventListener('DOMContentLoaded', async () => {
  // 获取DOM元素
  const captureBtn = document.getElementById('captureBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const configTip = document.getElementById('configTip');
  const historyArea = document.getElementById('historyArea');
  const historyList = document.getElementById('historyList');
  const historyEmptyState = document.getElementById('historyEmptyState');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const historyPreview = document.getElementById('historyPreview');
  const historyPreviewText = document.getElementById('historyPreviewText');
  const closePreviewBtn = document.getElementById('closePreviewBtn');
  const previewCopyBtn = document.getElementById('previewCopyBtn');

  // 历史记录数据（用于点击查看）
  let historyData = [];

  // 检查是否已配置API（支持多API配置）
  const checkConfig = async () => {
    const result = await chrome.storage.local.get(['apiProvider', 'apiConfigs', 'apiKey']);
    const provider = result.apiProvider || 'claude';

    // 优先从新的 apiConfigs 结构检查，兼容旧配置
    let hasApiKey = false;
    const configs = result.apiConfigs || {};

    if (configs[provider] && configs[provider].apiKey) {
      hasApiKey = true;
    } else if (provider === 'claude' && result.apiKey) {
      // 兼容旧版本配置
      hasApiKey = true;
    }

    if (!hasApiKey) {
      configTip.classList.remove('hidden');
      return false;
    }
    configTip.classList.add('hidden');
    return true;
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
        historyItem.setAttribute('aria-label', `查看历史记录: ${item.text.substring(0, 30)}...`);

        // 截断显示文本
        const displayText = item.text.length > 50 ? item.text.substring(0, 50) + '...' : item.text;

        historyItem.innerHTML = `
          <div class="history-item-text" title="${escapeHtml(item.text)}">${escapeHtml(displayText)}</div>
          <div class="history-item-meta">
            <span>${item.date}</span>
            <button class="history-copy-btn" data-index="${index}" title="复制" aria-label="复制该条历史记录">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </div>
        `;

        // 点击历史项查看详情
        historyItem.addEventListener('click', () => {
          showHistoryPreview(history[index].text);
        });

        // 键盘支持
        historyItem.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
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
            btn.innerHTML = `
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            `;
            btn.setAttribute('aria-label', '已复制该条历史记录');
            setTimeout(() => {
              btn.innerHTML = `
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              `;
              btn.setAttribute('aria-label', '复制该条历史记录');
            }, 1500);
          } catch (err) {
            console.error('复制失败:', err);
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
    if (confirm('确定要清空所有历史记录吗？')) {
      await chrome.storage.local.remove(['ocrHistory']);
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
  await checkConfig();
  await loadHistory();

  // 清空历史按钮事件
  clearHistoryBtn.addEventListener('click', clearHistory);

  // 关闭预览按钮事件
  closePreviewBtn.addEventListener('click', hideHistoryPreview);

  // 预览复制按钮事件
  previewCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(historyPreviewText.value);
      previewCopyBtn.textContent = '已复制';
      setTimeout(() => {
        previewCopyBtn.textContent = '复制全文';
      }, 1500);
    } catch (err) {
      console.error('复制失败:', err);
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
      alert('请先配置API密钥');
      return;
    }

    try {
      // 获取当前活动标签页
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        alert('无法获取当前标签页');
        return;
      }

      // 发送消息给content script启动截图模式
      await chrome.tabs.sendMessage(tab.id, { action: 'startCapture' });

      // 关闭popup窗口
      window.close();
    } catch (error) {
      console.error('启动截图失败:', error);
      alert('启动截图失败，请刷新页面后重试');
    }
  });
});
