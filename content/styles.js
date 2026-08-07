(function initializeContentStyles(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRContentStyles = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createContentStyles() {
  'use strict';

  /**
   * 获取所有样式内容
   * @returns {string} 样式文本
   */
  function getAllStyles(z) {
    return `
    :host {
      --bg-main: #FFFFFF;
      --bg-sub: #F5F5F7;
      --bg-hover: #EAEAEC;
      --text-primary: #1D1D1F;
      --text-secondary: #6B6B6E;
      --text-tertiary: #9E9EA3;
      --accent: #000000;
      --accent-inverse: #FFFFFF;
      --border: rgba(0, 0, 0, 0.08);
      --divider: rgba(0, 0, 0, 0.06);
      --radius-xs: 6px;
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 14px;
      --radius-xl: 24px;
      --duration-fast: 150ms;
      --duration-normal: 300ms;
      --ease-smooth: cubic-bezier(0.4, 0, 0.2, 1);
    }

    :host([data-theme="dark"]) {
      --bg-main: #0A0A0A;
      --bg-sub: #1C1C1E;
      --bg-hover: #2C2C2E;
      --text-primary: #F5F5F7;
      --text-secondary: #A0A0A5;
      --text-tertiary: #6C6C70;
      --accent: #FFFFFF;
      --accent-inverse: #000000;
      --border: rgba(255, 255, 255, 0.10);
      --divider: rgba(255, 255, 255, 0.08);
    }

    /* 进度通知样式 */
    #ocr-progress-notification {
      position: fixed;
      top: 32px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-sub);
      color: var(--text-primary);
      padding: 16px 24px;
      border-radius: var(--radius-md);
      z-index: ${z.PROGRESS};
      box-shadow: 0 8px 30px rgba(0,0,0,0.15);
      border: 1px solid var(--border);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: ocr-progress-fadeIn var(--duration-normal) var(--ease-smooth);
    }
    @keyframes ocr-progress-fadeIn {
      from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
    .ocr-progress-content {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .ocr-progress-spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--divider);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: ocr-spin 0.8s linear infinite;
    }
    @keyframes ocr-spin {
      to { transform: rotate(360deg); }
    }
    .ocr-progress-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .ocr-progress-message {
      font-size: 14px;
      font-weight: 600;
    }
    .ocr-progress-time {
      font-size: 12px;
      color: var(--text-tertiary);
    }
    .ocr-progress-cancel {
      background: var(--bg-hover);
      border: none;
      color: var(--text-secondary);
      padding: 6px 14px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: all var(--duration-fast);
    }
    .ocr-progress-cancel:hover {
      background: var(--text-tertiary);
      color: var(--bg-main);
    }

    .ocr-upload-notice-backdrop {
      position: fixed;
      inset: 0;
      z-index: ${z.RESULT_POPUP + 1};
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.48);
      pointer-events: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .ocr-upload-notice-dialog {
      width: min(420px, calc(100vw - 40px));
      box-sizing: border-box;
      padding: 24px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--bg-main);
      color: var(--text-primary);
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.3);
    }
    .ocr-upload-notice-dialog h2 {
      margin: 0 0 12px;
      font-size: 18px;
    }
    .ocr-upload-notice-dialog p {
      margin: 0;
      color: var(--text-secondary);
      font-size: 14px;
      line-height: 1.6;
    }
    .ocr-upload-notice-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 22px;
    }
    .ocr-upload-notice-actions button {
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 9px 16px;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
    }
    .ocr-upload-notice-cancel {
      background: var(--bg-sub);
      color: var(--text-primary);
    }
    .ocr-upload-notice-accept {
      background: var(--accent);
      color: var(--accent-inverse);
    }

    /* 编辑模式样式 */
    .ocr-handle {
      position: fixed;
      width: 10px;
      height: 10px;
      background: var(--accent);
      border: 2px solid var(--bg-main);
      border-radius: 50%;
      cursor: pointer;
      pointer-events: auto;
      z-index: ${z.HANDLE};
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      transition: transform var(--duration-fast) var(--ease-smooth);
    }
    .ocr-handle::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: transparent;
    }
    .ocr-handle:hover {
      transform: scale(1.4);
    }
    .ocr-handle:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 4px;
    }
    .ocr-handle-nw { cursor: nwse-resize; }
    .ocr-handle-ne { cursor: nesw-resize; }
    .ocr-handle-sw { cursor: nesw-resize; }
    .ocr-handle-se { cursor: nwse-resize; }
    .ocr-handle-n, .ocr-handle-s { cursor: ns-resize; }
    .ocr-handle-e, .ocr-handle-w { cursor: ew-resize; }

    /* 选区框样式 */
    #ocr-selection-box {
      border: 2px solid var(--accent);
      box-sizing: border-box;
      box-shadow: 0 0 0 1px var(--bg-main), 0 0 20px rgba(0,0,0,0.1);
      transition: none !important; /* 禁止选区框动画 */
    }

    /* 工具栏样式 */
    #ocr-toolbar {
      position: fixed;
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 10px 16px;
      background: var(--bg-main);
      border-radius: var(--radius-md);
      box-shadow: 0 8px 30px rgba(0,0,0,0.15);
      border: 1px solid var(--border);
      pointer-events: auto;
      z-index: ${z.TOOLBAR};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: ocr-toolbar-fadeIn var(--duration-normal) var(--ease-smooth);
      transition: none !important;
    }
    @keyframes ocr-toolbar-fadeIn {
      from { opacity: 0; transform: translate(-50%, 10px); }
      to { opacity: 1; transform: translate(-50%, 0); }
    }
    .ocr-size-info {
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 600;
      font-family: ui-monospace, SFMono-Regular, monospace;
      min-width: 80px;
    }
    .ocr-size-warning {
      color: #FF3B30;
    }
    .ocr-toolbar-buttons {
      display: flex;
      gap: 10px;
    }
    .ocr-btn {
      padding: 8px 16px;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all var(--duration-fast) var(--ease-smooth);
      font-family: inherit;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ocr-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
    .ocr-btn-primary {
      background: var(--accent);
      color: var(--accent-inverse);
    }
    .ocr-btn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .ocr-btn-primary:active:not(:disabled) {
      transform: scale(0.97);
    }
    .ocr-btn-secondary {
      background: var(--bg-sub);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }
    .ocr-btn-secondary:hover:not(:disabled) {
      background: var(--bg-hover);
    }
    .ocr-btn-cancel {
      background: transparent;
      color: var(--text-tertiary);
      border: 1px solid var(--divider);
    }
    .ocr-btn-cancel:hover:not(:disabled) {
      background: var(--bg-sub);
      color: var(--text-primary);
      border-color: var(--text-tertiary);
    }
    .ocr-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 3px;
    }

    /* 编辑模式下的选区框 */
    #ocr-selection-box.edit-mode {
      pointer-events: auto;
      cursor: move;
      background: rgba(0, 0, 0, 0.03);
    }

    /* 无障碍：屏幕阅读器专用 */
    .ocr-sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    `;
  }

  return Object.freeze({ getAllStyles });
}));
