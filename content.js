// content.js - 内容脚本，处理页面截图选区

(function() {
  // 防止重复注入
  if (window.ocrCaptureInitialized) {
    return;
  }
  window.ocrCaptureInitialized = true;

  let isCapturing = false;
  let startX = 0;
  let startY = 0;
  let selectionBox = null;
  let overlay = null;
  let tooltip = null;

  // 创建遮罩层
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

  // 创建选区框
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

  // 更新选区框
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

  // 清理资源
  function cleanup() {
    isCapturing = false;
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

  // 完全清理所有资源（用于页面卸载时）
  function fullCleanup() {
    cleanup();
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
      showNotification('正在截图...', 'info');

      // 发送消息给background进行截图（因为content script无法直接调用chrome.tabs.captureVisibleTab）
      const response = await chrome.runtime.sendMessage({
        action: 'captureVisibleTab'
      });

      if (!response || !response.dataUrl) {
        showNotification('截图失败', 'error');
        return;
      }

      // 裁剪选区
      const croppedImage = await cropImage(response.dataUrl, rect);

      showNotification('正在识别文字...', 'info');

      // 发送给background进行OCR识别
      const ocrResponse = await chrome.runtime.sendMessage({
        action: 'performOCR',
        imageData: croppedImage
      });

      if (ocrResponse && ocrResponse.success) {
        showResultPopup(ocrResponse.text);
        showNotification('识别完成！', 'success');
      } else {
        showNotification(ocrResponse?.error || '识别失败', 'error');
      }
    } catch (error) {
      console.error('截图识别失败:', error);
      showNotification('识别失败: ' + error.message, 'error');
    }
  }

  // 裁剪图片
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

  // 显示结果弹窗
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

  // 显示通知
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

  // 启动截图模式
  function startCapture() {
    if (isCapturing) return;

    isCapturing = true;
    createOverlay();

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
  }

  // 消息监听器（命名函数，便于移除）
  function messageListener(request, sender, sendResponse) {
    if (request.action === 'startCapture') {
      startCapture();
      sendResponse({ success: true });
    }
    return true;
  }

  // 监听来自popup的消息
  chrome.runtime.onMessage.addListener(messageListener);

  // 页面卸载时清理资源，防止内存泄漏
  window.addEventListener('beforeunload', fullCleanup);

  console.log('OCR文字识别助手已加载');
})();
