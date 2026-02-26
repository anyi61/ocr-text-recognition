/**
 * @fileoverview content.js - OCR文字识别助手内容脚本
 * @description 处理页面截图选区、图片裁剪、结果显示和进度通知
 */

(function() {
  /**
   * 选区矩形信息
   * @typedef {Object} Rect
   * @property {number} left - 左坐标
   * @property {number} top - 上坐标
   * @property {number} width - 宽度
   * @property {number} height - 高度
   */

  /**
   * 截图状态
   * @type {boolean}
   */
  let isCapturing = false;
  let startX = 0;
  let startY = 0;
  let selectionBox = null;
  let overlay = null;
  let tooltip = null;

  // 进度通知相关变量
  let progressNotification = null;
  let progressTimer = null;
  let progressStartTime = null;
  let isCancelled = false;

  // 注入进度通知样式
  const progressStyles = document.createElement('style');
  progressStyles.textContent = `
    #ocr-progress-notification {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #333;
      color: #fff;
      padding: 16px 24px;
      border-radius: 12px;
      z-index: 1000004;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: ocr-progress-fadeIn 0.3s ease;
    }
    @keyframes ocr-progress-fadeIn {
      from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
    .ocr-progress-content {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .ocr-progress-spinner {
      width: 20px;
      height: 20px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: #667eea;
      border-radius: 50%;
      animation: ocr-spin 1s linear infinite;
    }
    @keyframes ocr-spin {
      to { transform: rotate(360deg); }
    }
    .ocr-progress-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ocr-progress-message {
      font-size: 14px;
      font-weight: 500;
    }
    .ocr-progress-time {
      font-size: 12px;
      color: rgba(255,255,255,0.7);
    }
    .ocr-progress-cancel {
      background: rgba(255,255,255,0.2);
      border: none;
      color: #fff;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.2s;
    }
    .ocr-progress-cancel:hover {
      background: rgba(255,255,255,0.3);
    }
  `;
  document.head.appendChild(progressStyles);

  /**
   * 创建遮罩层和提示文字
   * @description 创建全屏半透明遮罩和操作提示
   */
  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'ocr-capture-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.3);
      z-index: 999999;
      cursor: crosshair;
    `;

    // 创建提示文字
    tooltip = document.createElement('div');
    tooltip.id = 'ocr-capture-tooltip';
    tooltip.textContent = '按住鼠标左键框选需要识别的文字区域，按ESC取消';
    tooltip.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #333;
      color: #fff;
      padding: 10px 20px;
      border-radius: 6px;
      font-size: 14px;
      z-index: 1000000;
      pointer-events: none;
      white-space: nowrap;
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(tooltip);
  }

  /**
   * 创建选区框元素
   * @description 创建用于显示用户选择区域的DOM元素
   */
  function createSelectionBox() {
    selectionBox = document.createElement('div');
    selectionBox.id = 'ocr-selection-box';
    selectionBox.style.cssText = `
      position: fixed;
      border: 2px solid #667eea;
      background: rgba(102, 126, 234, 0.1);
      pointer-events: none;
      z-index: 1000001;
      display: none;
    `;
    document.body.appendChild(selectionBox);
  }

  /**
   * 更新选区框位置和大小
   * @param {number} x1 - 起始X坐标
   * @param {number} y1 - 起始Y坐标
   * @param {number} x2 - 结束X坐标
   * @param {number} y2 - 结束Y坐标
   */
  function updateSelectionBox(x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);

    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
    selectionBox.style.width = `${width}px`;
    selectionBox.style.height = `${height}px`;
    selectionBox.style.display = 'block';

    // 更新提示
    tooltip.textContent = `${Math.round(width)} × ${Math.round(height)} 像素 - 松开鼠标完成截图`;
  }

  /**
   * 清理截图相关资源
   * @description 移除遮罩层、选区框，重置状态
   */
  function cleanup() {
    isCapturing = false;
    isCancelled = false;
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    if (selectionBox) {
      selectionBox.remove();
      selectionBox = null;
    }
    if (tooltip) {
      tooltip.remove();
      tooltip = null;
    }
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown);
  }

  /**
   * 完全清理所有资源
   * @description 页面卸载时调用，移除所有DOM元素和事件监听器
   */
  function fullCleanup() {
    cleanup();
    hideProgressNotification();
    // 移除运行时消息监听器
    chrome.runtime.onMessage.removeListener(messageListener);
    // 标记为未初始化
    window.ocrCaptureInitialized = false;
  }

  // 鼠标按下
  function onMouseDown(e) {
    if (e.button !== 0) return; // 只处理左键
    e.preventDefault();

    startX = e.clientX;
    startY = e.clientY;

    createSelectionBox();
    updateSelectionBox(startX, startY, startX, startY);
  }

  // 鼠标移动
  function onMouseMove(e) {
    if (!selectionBox) return;
    updateSelectionBox(startX, startY, e.clientX, e.clientY);
  }

  // 鼠标释放
  async function onMouseUp(e) {
    if (!selectionBox) return;

    const rect = selectionBox.getBoundingClientRect();

    // 清理UI
    cleanup();

    // 检查选区大小
    if (rect.width < 10 || rect.height < 10) {
      showNotification('选区太小，请重新框选', 'warning');
      return;
    }

    // 执行截图
    await captureAndRecognize(rect);
  }

  // 键盘事件
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      cleanup();
    }
  }

  // 截取并识别
  async function captureAndRecognize(rect) {
    try {
      showProgressNotification('正在截图...', false);

      // 发送消息给background进行截图（因为content script无法直接调用chrome.tabs.captureVisibleTab）
      const response = await chrome.runtime.sendMessage({
        action: 'captureVisibleTab'
      });

      // 检查是否被取消
      if (isCancelled) return;

      if (!response || !response.dataUrl) {
        hideProgressNotification();
        showNotification('截图失败', 'error');
        return;
      }

      // 裁剪选区
      const croppedImage = await cropImage(response.dataUrl, rect);

      // 检查是否被取消
      if (isCancelled) return;

      // 更新为识别阶段，显示取消按钮
      showProgressNotification('正在识别文字...', true);

      // 发送给background进行OCR识别
      const ocrResponse = await chrome.runtime.sendMessage({
        action: 'performOCR',
        imageData: croppedImage
      });

      // 检查是否被取消
      if (isCancelled) return;

      // 计算识别用时
      const elapsed = progressStartTime ? Math.floor((Date.now() - progressStartTime) / 1000) : 0;
      hideProgressNotification();

      if (ocrResponse && ocrResponse.success) {
        showResultPopup(ocrResponse.text);
        showNotification(`识别完成！用时 ${elapsed} 秒`, 'success');
      } else {
        showNotification(ocrResponse?.error || '识别失败', 'error');
      }
    } catch (error) {
      hideProgressNotification();
      if (!isCancelled) {
        console.error('截图识别失败:', error);
        showNotification('识别失败: ' + error.message, 'error');
      }
    }
  }

  /**
   * 裁剪图片
   * @param {string} dataUrl - 原始图片的Data URL
   * @param {DOMRect} rect - 裁剪区域
   * @returns {Promise<string>} 裁剪后的图片Data URL
   * @description 使用Canvas根据选区裁剪图片
   */
  function cropImage(dataUrl, rect) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // 考虑设备像素比
        const scale = window.devicePixelRatio || 1;

        canvas.width = rect.width * scale;
        canvas.height = rect.height * scale;

        ctx.drawImage(
          img,
          rect.left * scale,
          rect.top * scale,
          rect.width * scale,
          rect.height * scale,
          0,
          0,
          rect.width * scale,
          rect.height * scale
        );

        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  /**
   * 显示结果弹窗
   * @param {string} text - 识别结果文本
   * @description 在页面右上角显示识别结果弹窗，包含复制和关闭功能
   */
  function showResultPopup(text) {
    // 移除已有的结果弹窗
    const existingPopup = document.getElementById('ocr-result-popup');
    if (existingPopup) {
      existingPopup.remove();
    }

    const popup = document.createElement('div');
    popup.id = 'ocr-result-popup';
    popup.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      width: 400px;
      max-height: 500px;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      z-index: 1000002;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      overflow: hidden;
      animation: slideIn 0.3s ease;
    `;

    popup.innerHTML = `
      <style>
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(100%); opacity: 1; }
        }
        #ocr-result-popup.closing {
          animation: slideOut 0.3s ease forwards;
        }
        #ocr-result-popup .close-btn {
          position: absolute;
          top: 8px;
          right: 8px;
          width: 28px;
          height: 28px;
          background: rgba(0,0,0,0.1);
          border: none;
          border-radius: 50%;
          color: #666;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
          z-index: 10;
        }
        #ocr-result-popup .close-btn:hover {
          background: rgba(0,0,0,0.2);
          color: #333;
        }
        #ocr-result-popup .content {
          padding: 16px;
          padding-top: 20px;
        }
        #ocr-result-popup textarea {
          width: 100%;
          height: 180px;
          padding: 12px;
          border: 1px solid #e0e0e0;
          border-radius: 8px;
          font-size: 14px;
          line-height: 1.6;
          resize: vertical;
          outline: none;
          font-family: inherit;
          box-sizing: border-box;
        }
        #ocr-result-popup textarea:focus {
          border-color: #667eea;
        }
        #ocr-result-popup .actions {
          display: flex;
          gap: 8px;
          margin-top: 12px;
        }
        #ocr-result-popup .btn {
          flex: 1;
          padding: 10px 16px;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        #ocr-result-popup .btn-primary {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }
        #ocr-result-popup .btn-primary:hover {
          opacity: 0.9;
          transform: translateY(-1px);
        }
        #ocr-result-popup .btn-secondary {
          background: #f0f0f0;
          color: #666;
        }
        #ocr-result-popup .btn-secondary:hover {
          background: #e0e0e0;
        }
      </style>
      <button class="close-btn" title="关闭">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
      <div class="content">
        <textarea id="ocr-result-text" placeholder="识别结果...">${text || ''}</textarea>
        <div class="actions">
          <button class="btn btn-primary copy-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            复制
          </button>
          <button class="btn btn-secondary close-popup-btn">关闭</button>
        </div>
      </div>
    `;

    document.body.appendChild(popup);

    // 绑定事件
    const closeBtn = popup.querySelector('.close-btn');
    const closePopupBtn = popup.querySelector('.close-popup-btn');
    const copyBtn = popup.querySelector('.copy-btn');
    const textarea = popup.querySelector('#ocr-result-text');

    const close = () => {
      popup.classList.add('closing');
      setTimeout(() => popup.remove(), 300);
    };

    closeBtn.addEventListener('click', close);
    closePopupBtn.addEventListener('click', close);

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textarea.value);
        copyBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          已复制
        `;
        copyBtn.style.background = '#4caf50';
        setTimeout(() => {
          copyBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            复制文字
          `;
          copyBtn.style.background = '';
        }, 2000);
      } catch (err) {
        console.error('复制失败:', err);
      }
    });
  }

  /**
   * 显示通知
   * @param {string} message - 通知消息
   * @param {string} [type='info'] - 通知类型 (info|success|warning|error)
   * @description 在页面顶部显示临时通知，3秒后自动消失
   */
  function showNotification(message, type = 'info') {
    // 移除已有通知
    const existing = document.getElementById('ocr-notification');
    if (existing) existing.remove();

    const colors = {
      info: { bg: '#333', icon: 'ℹ️' },
      success: { bg: '#4caf50', icon: '✓' },
      warning: { bg: '#ff9800', icon: '⚠️' },
      error: { bg: '#f44336', icon: '✗' }
    };

    const { bg, icon } = colors[type] || colors.info;

    const notification = document.createElement('div');
    notification.id = 'ocr-notification';
    notification.style.cssText = `
      position: fixed;
      top: 60px;
      left: 50%;
      transform: translateX(-50%);
      background: ${bg};
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      z-index: 1000003;
      display: flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      animation: fadeIn 0.3s ease;
    `;
    notification.innerHTML = `
      <style>
        @keyframes fadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes fadeOut {
          from { opacity: 1; transform: translateX(-50%) translateY(0); }
          to { opacity: 0; transform: translateX(-50%) translateY(-10px); }
        }
      </style>
      <span>${icon}</span>
      <span>${message}</span>
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.animation = 'fadeOut 0.3s ease forwards';
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  /**
   * 显示进度通知
   * @param {string} message - 进度消息
   * @param {boolean} [showCancel=false] - 是否显示取消按钮
   * @returns {HTMLElement} 通知元素
   * @description 显示带加载动画和计时器的进度通知
   */
  function showProgressNotification(message, showCancel = false) {
    // 移除已有进度通知
    hideProgressNotification();

    isCancelled = false;
    const notification = document.createElement('div');
    notification.id = 'ocr-progress-notification';
    notification.innerHTML = `
      <div class="ocr-progress-content">
        <div class="ocr-progress-spinner"></div>
        <div class="ocr-progress-info">
          <div class="ocr-progress-message">${message}</div>
          <div class="ocr-progress-time">已用时: 0 秒</div>
        </div>
        ${showCancel ? '<button class="ocr-progress-cancel">取消</button>' : ''}
      </div>
    `;

    document.body.appendChild(notification);
    progressNotification = notification;
    progressStartTime = Date.now();

    // 启动计时器
    const timeEl = notification.querySelector('.ocr-progress-time');
    progressTimer = setInterval(() => {
      if (timeEl) {
        const elapsed = Math.floor((Date.now() - progressStartTime) / 1000);
        timeEl.textContent = `已用时: ${elapsed} 秒`;
      }
    }, 1000);

    // 绑定取消按钮
    if (showCancel) {
      const cancelBtn = notification.querySelector('.ocr-progress-cancel');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          isCancelled = true;
          hideProgressNotification();
          showNotification('已取消识别', 'warning');
        });
      }
    }

    return notification;
  }

  /**
   * 更新进度通知消息
   * @param {string} message - 新的进度消息
   */
  function updateProgressNotification(message) {
    if (progressNotification) {
      const msgEl = progressNotification.querySelector('.ocr-progress-message');
      if (msgEl) {
        msgEl.textContent = message;
      }
    }
  }

  /**
   * 隐藏进度通知
   * @description 清除计时器并移除进度通知元素
   */
  function hideProgressNotification() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    if (progressNotification) {
      progressNotification.remove();
      progressNotification = null;
    }
    progressStartTime = null;
  }

  /**
   * 启动截图模式
   * @description 初始化截图状态，创建遮罩层并绑定鼠标/键盘事件
   */
  function startCapture() {
    if (isCapturing) return;

    isCapturing = true;
    createOverlay();

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
  }

  /**
   * 消息监听器
   * @param {Object} request - 消息请求
   * @param {chrome.runtime.MessageSender} sender - 发送者信息
   * @param {Function} sendResponse - 响应回调
   * @returns {boolean} 保持消息通道开启
   * @description 监听来自popup的消息，启动截图模式
   */
  function messageListener(request, sender, sendResponse) {
    if (request.action === 'startCapture') {
      startCapture();
      sendResponse({ success: true });
    }
    return true;
  }

  /**
   * 监听来自popup的消息
   * @listens chrome.runtime.onMessage
   */
  chrome.runtime.onMessage.addListener(messageListener);

  /**
   * 页面卸载时清理资源
   * @listens window.beforeunload
   * @description 防止内存泄漏
   */
  window.addEventListener('beforeunload', fullCleanup);

  console.log('OCR文字识别助手已加载');
})();
