// popup.js - 弹出窗口逻辑

document.addEventListener('DOMContentLoaded', async () => {
  // 获取DOM元素
  const captureBtn = document.getElementById('captureBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const copyBtn = document.getElementById('copyBtn');
  const statusArea = document.getElementById('statusArea');
  const resultArea = document.getElementById('resultArea');
  const configTip = document.getElementById('configTip');
  const resultText = document.getElementById('resultText');
  const statusText = document.getElementById('statusText');

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

  // 初始化检查
  await checkConfig();

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

  // 复制结果到剪贴板
  copyBtn.addEventListener('click', async () => {
    const text = resultText.value;
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      copyBtn.classList.add('copied');
      copyBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>已复制</span>
      `;

      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span>复制</span>
        `;
      }, 2000);
    } catch (error) {
      console.error('复制失败:', error);
      alert('复制失败，请手动复制');
    }
  });

  // 监听来自background的消息（识别结果）
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ocrResult') {
      statusArea.classList.add('hidden');
      resultArea.classList.remove('hidden');
      resultText.value = request.text || '';
      captureBtn.disabled = false;
      captureBtn.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
        <span>开始截图识别</span>
      `;
    } else if (request.action === 'ocrError') {
      statusArea.classList.add('hidden');
      captureBtn.disabled = false;
      captureBtn.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
        <span>开始截图识别</span>
      `;
      alert('识别失败: ' + (request.error || '未知错误'));
    }
    sendResponse({ received: true });
    return true;
  });
});
