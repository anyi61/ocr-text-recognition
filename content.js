/**
 * @fileoverview content.js - OCR文字识别助手内容脚本
 * @description 处理页面截图选区、图片裁剪、结果显示和进度通知
 */

(function() {
  if (window.ocrCaptureInitialized) {
    return;
  }
  window.ocrCaptureInitialized = true;

  // 使用统一的 OCRI18n API（来自 i18n-runtime.js）。首次按需注入后，
  // startCapture 必须等待字典完成加载，避免把内部翻译键显示给用户。
  const i18nReady = OCRI18n.init().catch((error) => {
    console.error('i18n init failed in content script:', error);
  });

  /**
   * 选区矩形信息
   * @typedef {Object} Rect
   * @property {number} left - 左坐标
   * @property {number} top - 上坐标
   * @property {number} width - 宽度
   * @property {number} height - 高度
   */

  // ============ 叠层常量统一管理（高基线，避免被宿主页面覆盖）============
  const Z = {
    OVERLAY: 1000010,
    TOOLTIP: 1000020,
    SELECTION: 1000030,
    HANDLE: 1000040,
    TOOLBAR: 1000050,
    NOTIFICATION: 1000060,
    PROGRESS: 1000070,
    RESULT_POPUP: 1000080
  };

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

  // 编辑模式状态
  let isEditMode = false;           // 是否处于编辑模式
  let isDragging = false;           // 是否正在拖拽
  let dragType = null;              // 拖拽类型: 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
  let dragStartX = 0;               // 拖拽起始X
  let dragStartY = 0;               // 拖拽起始Y
  let originalRect = null;          // 拖拽前的选区 {left, top, width, height}
  let toolbar = null;               // 工具栏元素
  let handles = [];                 // 调整手柄元素数组
  let currentRect = null;           // 当前选区 {left, top, width, height}
  let rectHistory = [];             // 选区历史栈（用于撤销）

  // 进度通知相关变量
  let progressNotification = null;
  let progressTimer = null;
  let progressStartTime = null;
  let isCancelled = false;
  let activeRequestId = null;

  // Shadow DOM 相关变量
  let shadowHost = null;      // Shadow DOM 宿主元素
  let shadowRoot = null;      // Shadow DOM 根节点
  let styleEl = null;         // shadowRoot 内的样式元素
  let themeListenerBound = false;

  /**
   * 应用主题到 Shadow Host
   * @param {string} theme - 主题名称 (light|dark)
   */
  function applyThemeToShadowHost(theme) {
    if (!shadowHost) return;
    const safeTheme = theme === 'dark' ? 'dark' : 'light';
    shadowHost.setAttribute('data-theme', safeTheme);
  }

  /**
   * 从存储同步主题到 Shadow Host
   */
  async function syncThemeFromStorage() {
    try {
      const result = await chrome.storage.local.get(['theme']);
      const fallback = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      applyThemeToShadowHost(result.theme || fallback);
    } catch (error) {
      const fallback = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      applyThemeToShadowHost(fallback);
    }
  }

  /**
   * 监听主题变更并同步到 Shadow Host
   */
  function ensureThemeChangeListener() {
    if (themeListenerBound) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.theme) {
        applyThemeToShadowHost(changes.theme.newValue);
      }
    });
    themeListenerBound = true;
  }

  /**
   * 获取所有样式内容
   * @returns {string} 样式文本
   */
  function getAllStyles() {
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
      z-index: ${Z.PROGRESS};
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
      z-index: ${Z.HANDLE};
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
      z-index: ${Z.TOOLBAR};
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

  /**
   * 初始化 Shadow DOM
   * @description 创建 Shadow DOM 宿主元素并注入样式
   * @returns {ShadowRoot} Shadow DOM 根节点
   */
  function initShadowDOM() {
    // 如果已经存在，直接返回
    if (shadowRoot && shadowHost) {
      return shadowRoot;
    }

    // 创建宿主元素（全屏容器，但不拦截事件）
    shadowHost = document.createElement('div');
    shadowHost.id = 'ocr-root-host';
    shadowHost.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      pointer-events: none;
      z-index: 1000009;
    `;

    // 挂载 Shadow DOM
    shadowRoot = shadowHost.attachShadow({ mode: 'open' });

    // 创建样式元素
    styleEl = document.createElement('style');
    styleEl.textContent = getAllStyles();
    shadowRoot.appendChild(styleEl);

    // 添加到页面
    document.body.appendChild(shadowHost);

    // 主题同步
    syncThemeFromStorage();
    ensureThemeChangeListener();

    return shadowRoot;
  }

  // 创建无障碍状态播报区域
  let a11yLiveRegion = null;
  function ensureA11yLiveRegion() {
    if (!a11yLiveRegion || !shadowRoot || !shadowRoot.contains(a11yLiveRegion)) {
      a11yLiveRegion = document.createElement('div');
      a11yLiveRegion.id = 'ocr-a11y-live';
      a11yLiveRegion.className = 'ocr-sr-only';
      a11yLiveRegion.setAttribute('aria-live', 'polite');
      a11yLiveRegion.setAttribute('aria-atomic', 'true');
      if (shadowRoot) {
        shadowRoot.appendChild(a11yLiveRegion);
      }
    }
  }

  /**
   * 播报无障碍状态
   * @param {string} message - 播报消息
   */
  function announceA11y(message) {
    ensureA11yLiveRegion();
    if (a11yLiveRegion) {
      a11yLiveRegion.textContent = message;
    }
  }

  /**
   * 创建遮罩层和提示文字
   * @description 创建全屏半透明遮罩和操作提示
   */
  function createOverlay() {
    const root = initShadowDOM();

    overlay = document.createElement('div');
    overlay.id = 'ocr-capture-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.4);
      z-index: ${Z.OVERLAY};
      cursor: crosshair;
      pointer-events: auto;
    `;

    // 创建提示文字
    tooltip = document.createElement('div');
    tooltip.id = 'ocr-capture-tooltip';
    tooltip.textContent = OCRI18n.t('content_tooltip_start');
    tooltip.style.cssText = `
      position: fixed;
      top: 32px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-main);
      color: var(--text-primary);
      padding: 12px 24px;
      border-radius: var(--radius-md);
      font-size: 14px;
      font-weight: 600;
      z-index: ${Z.TOOLTIP};
      pointer-events: none;
      white-space: nowrap;
      transition: all var(--duration-fast) var(--ease-smooth);
      box-shadow: 0 8px 30px rgba(0,0,0,0.15);
      border: 1px solid var(--border);
    `;

    root.appendChild(overlay);
    root.appendChild(tooltip);
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
      border: 2px solid var(--accent);
      box-shadow: 0 0 0 1px var(--bg-main);
      background: rgba(0, 0, 0, 0.05);
      box-sizing: border-box;
      pointer-events: none;
      z-index: ${Z.SELECTION};
      display: none;
    `;
    if (shadowRoot) {
      shadowRoot.appendChild(selectionBox);
    }
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

    // 根据选区大小显示不同提示
    if (width < 10 || height < 10) {
      tooltip.textContent = `${Math.round(width)} × ${Math.round(height)} px - ${OCRI18n.t('content_tooltip_size_small')}`;
      tooltip.style.borderColor = '#FF3B30';
      selectionBox.style.borderColor = '#FF3B30';
    } else {
      tooltip.textContent = `${Math.round(width)} × ${Math.round(height)} px - ${OCRI18n.t('content_tooltip_size_ok')}`;
      tooltip.style.borderColor = 'var(--border)';
      selectionBox.style.borderColor = 'var(--accent)';
    }
  }

  /**
   * 清理截图相关资源（会话级清理）
   * @description 移除遮罩层、选区框，重置状态，但不销毁 Shadow DOM
   */
  function cleanup() {
    isCapturing = false;
    isEditMode = false;
    isCancelled = false;
    // 先解除仍挂在选区上的编辑监听，再移除选区元素。
    cleanupEditMode();
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
    // 注意：不销毁 shadowHost/shadowRoot，因为后续可能需要显示通知/结果弹窗
    // Shadow DOM 的销毁放在 fullCleanup() 或 destroyShadowDOM() 中
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown);
  }

  /**
   * 销毁 Shadow DOM（彻底清理）
   * @description 移除 Shadow DOM 宿主，清理所有子元素和样式
   */
  function destroyShadowDOM() {
    if (shadowHost && document.body.contains(shadowHost)) {
      shadowHost.remove();
      shadowHost = null;
      shadowRoot = null;
      styleEl = null;
    }
  }

  /**
   * 清理编辑模式元素
   * @description 移除手柄和工具栏
   */
  function cleanupEditMode() {
    selectionBox?.removeEventListener('mousedown', onSelectionMouseDown);
    // 清理手柄
    handles.forEach(h => h && h.remove());
    handles = [];
    // 清理工具栏
    if (toolbar) {
      toolbar.remove();
      toolbar = null;
    }
    // 清空历史栈
    rectHistory = [];
    // 移除编辑模式事件监听
    document.removeEventListener('mousemove', onEditModeMouseMove);
    document.removeEventListener('mouseup', onEditModeMouseUp);
    isDragging = false;
    dragType = null;
    originalRect = null;
  }

  /**
   * 进入编辑模式
   * @param {Object} rect - 选区位置 {left, top, width, height}
   * @description 创建调整手柄和工具栏，允许用户调整选区
   */
  function enterEditMode(rect) {
    isEditMode = true;
    currentRect = { ...rect };

    // 初始化历史栈，记录初始状态
    rectHistory = [{ ...rect }];

    // 移除初始框选阶段的事件监听器，避免冲突
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    // 更新选区框样式
    if (selectionBox) {
      selectionBox.classList.add('edit-mode');
      selectionBox.style.pointerEvents = 'auto';
      selectionBox.addEventListener('mousedown', onSelectionMouseDown);
    }

    // 创建调整手柄
    createHandles();

    // 创建工具栏
    createToolbar();

    // 更新提示
    if (tooltip) {
      tooltip.textContent = OCRI18n.t('content_tooltip_edit');
    }

    // 更新遮罩层光标
    if (overlay) {
      overlay.style.cursor = 'default';
    }

    // 绑定编辑模式事件
    document.addEventListener('mousemove', onEditModeMouseMove);
    document.addEventListener('mouseup', onEditModeMouseUp);
  }

  /**
   * 创建调整手柄
   * @description 在选区四角和四边中点创建8个拖拽手柄
   */
  function createHandles() {
    const positions = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    const ariaLabels = {
      nw: OCRI18n.t('content_handle_nw'),
      n: OCRI18n.t('content_handle_n'),
      ne: OCRI18n.t('content_handle_ne'),
      e: OCRI18n.t('content_handle_e'),
      se: OCRI18n.t('content_handle_se'),
      s: OCRI18n.t('content_handle_s'),
      sw: OCRI18n.t('content_handle_sw'),
      w: OCRI18n.t('content_handle_w')
    };
    const orientations = {
      nw: 'undefined', ne: 'undefined', se: 'undefined', sw: 'undefined',
      n: 'vertical', s: 'vertical', e: 'horizontal', w: 'horizontal'
    };

    positions.forEach(pos => {
      const handle = document.createElement('div');
      handle.className = `ocr-handle ocr-handle-${pos}`;
      handle.dataset.position = pos;
      handle.tabIndex = 0;
      handle.setAttribute('role', 'slider');
      handle.setAttribute('aria-label', ariaLabels[pos]);
      handle.setAttribute('aria-orientation', orientations[pos]);
      handle.addEventListener('mousedown', onHandleMouseDown);
      handle.addEventListener('keydown', onHandleKeyDown);
      if (shadowRoot) {
        shadowRoot.appendChild(handle);
      }
      handles.push(handle);
    });

    updateHandlesPosition();
  }

  /**
   * 更新手柄位置
   * @description 根据当前选区更新所有手柄的位置
   */
  function updateHandlesPosition() {
    if (!currentRect || handles.length === 0) return;

    const { left, top, width, height } = currentRect;
    const halfSize = 6; // 手柄半径

    const positions = {
      nw: { x: left, y: top },
      n: { x: left + width / 2, y: top },
      ne: { x: left + width, y: top },
      e: { x: left + width, y: top + height / 2 },
      se: { x: left + width, y: top + height },
      s: { x: left + width / 2, y: top + height },
      sw: { x: left, y: top + height },
      w: { x: left, y: top + height / 2 }
    };

    handles.forEach((handle, index) => {
      if (!handle) return;
      const pos = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'][index];
      const { x, y } = positions[pos];
      handle.style.left = `${x - halfSize}px`;
      handle.style.top = `${y - halfSize}px`;
    });
  }

  /**
   * 创建工具栏
   * @description 在选区下方创建操作工具栏
   */
  function createToolbar() {
    toolbar = document.createElement('div');
    toolbar.id = 'ocr-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.innerHTML = `
      <span class="ocr-size-info">${Math.round(currentRect.width)} × ${Math.round(currentRect.height)} px</span>
      <div class="ocr-toolbar-buttons">
        <button class="ocr-btn ocr-btn-secondary" id="ocr-undo-btn" aria-label="${OCRI18n.t('content_aria_undo')}" disabled>${OCRI18n.t('content_btn_undo')}</button>
        <button class="ocr-btn ocr-btn-primary" id="ocr-confirm-btn" aria-label="${OCRI18n.t('content_aria_confirm')}">${OCRI18n.t('content_btn_confirm')}</button>
        <button class="ocr-btn ocr-btn-secondary" id="ocr-reselect-btn" aria-label="${OCRI18n.t('content_aria_reselect')}">${OCRI18n.t('content_btn_reselect')}</button>
        <button class="ocr-btn ocr-btn-cancel" id="ocr-cancel-btn" aria-label="${OCRI18n.t('content_aria_cancel')}">${OCRI18n.t('content_btn_cancel_capture')}</button>
      </div>
    `;

    if (shadowRoot) {
      shadowRoot.appendChild(toolbar);
    }
    updateToolbarPosition();

    // 绑定按钮事件
    const confirmBtn = toolbar.querySelector('#ocr-confirm-btn');
    const reselectBtn = toolbar.querySelector('#ocr-reselect-btn');
    const cancelBtn = toolbar.querySelector('#ocr-cancel-btn');

    confirmBtn.addEventListener('click', confirmSelection);
    reselectBtn.addEventListener('click', reselectArea);
    cancelBtn.addEventListener('click', cancelCapture);

    // 绑定撤销按钮事件
    const undoBtn = toolbar.querySelector('#ocr-undo-btn');
    undoBtn.addEventListener('click', undoSelection);
  }

  /**
   * 更新工具栏位置
   * @description 将工具栏定位在选区下方或上方
   */
  function updateToolbarPosition() {
    if (!toolbar || !currentRect) return;

    const { left, top, width, height } = currentRect;
    const toolbarHeight = 50;
    const margin = 10;

    // 默认放在选区下方
    let toolbarTop = top + height + margin;

    // 如果下方空间不足，放在选区上方
    if (toolbarTop + toolbarHeight > window.innerHeight) {
      toolbarTop = top - toolbarHeight - margin;
    }

    // 确保工具栏在视口内
    toolbarTop = Math.max(10, toolbarTop);

    // 水平居中于选区
    let toolbarLeft = left + width / 2;

    // 确保工具栏不超出视口
    const toolbarWidth = 320;
    toolbarLeft = Math.max(toolbarWidth / 2 + 10, Math.min(window.innerWidth - toolbarWidth / 2 - 10, toolbarLeft));

    toolbar.style.left = `${toolbarLeft}px`;
    toolbar.style.top = `${toolbarTop}px`;
    toolbar.style.transform = 'translateX(-50%)';
  }

  /**
   * 更新选区尺寸显示
   */
  function updateSizeDisplay() {
    if (!toolbar || !currentRect) return;

    const sizeInfo = toolbar.querySelector('.ocr-size-info');
    const confirmBtn = toolbar.querySelector('#ocr-confirm-btn');

    if (currentRect.width < 10 || currentRect.height < 10) {
      sizeInfo.innerHTML = `<span class="ocr-size-warning">${Math.round(currentRect.width)} × ${Math.round(currentRect.height)} px - ${OCRI18n.t('content_msg_selection_small_edit')}</span>`;
      confirmBtn.disabled = true;
    } else {
      sizeInfo.textContent = `${Math.round(currentRect.width)} × ${Math.round(currentRect.height)} px`;
      confirmBtn.disabled = false;
    }
  }

  /**
   * 手柄鼠标按下事件
   * @param {MouseEvent} e
   */
  function onHandleMouseDown(e) {
    e.preventDefault();
    e.stopPropagation();

    isDragging = true;
    dragType = e.target.dataset.position;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    originalRect = { ...currentRect };

    document.addEventListener('mousemove', onEditModeMouseMove);
    document.addEventListener('mouseup', onEditModeMouseUp);
  }

  /**
   * 手柄键盘事件
   * @param {KeyboardEvent} e
   * @description 支持键盘调整选区大小
   */
  function onHandleKeyDown(e) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;

    e.preventDefault();
    e.stopPropagation();

    const handle = e.target;
    const handlePos = handle.dataset.position;
    const step = e.shiftKey ? 10 : 2; // Shift+Arrow 大步进

    // 计算调整方向
    const direction = {
      ArrowUp: { dx: 0, dy: -1 },
      ArrowDown: { dx: 0, dy: 1 },
      ArrowLeft: { dx: -1, dy: 0 },
      ArrowRight: { dx: 1, dy: 0 }
    }[e.key];

    // 根据手柄位置和按键方向计算新选区
    const newRect = calculateRectByKeyboard(currentRect, handlePos, direction, step);
    if (!newRect) return;

    currentRect = newRect;
    recordCurrentRect();

    // 更新 UI
    updateSelectionRect();
    updateHandlesPosition();
    updateToolbarPosition();
    updateSizeDisplay();
    updateUndoButtonState();

    // 播报无障碍提示
    const sizeInfo = `${Math.round(currentRect.width)} × ${Math.round(currentRect.height)}`;
    announceA11y(OCRI18n.t('content_a11y_resized', [sizeInfo]));
  }

  /**
   * 根据键盘输入计算新选区
   * @param {Object} rect - 当前选区
   * @param {string} handlePos - 手柄位置
   * @param {Object} direction - 移动方向 {dx, dy}
   * @param {number} step - 步进值
   * @returns {Object|null} 新选区或 null
   */
  function calculateRectByKeyboard(rect, handlePos, direction, step) {
    const minSize = 10;
    let newRect = { ...rect };

    // 根据手柄位置决定如何调整
    // 角落手柄：两个方向都能调整
    // 边缘手柄：只能调整垂直或水平方向
    switch (handlePos) {
      case 'nw':
        // 左上角：向左/上扩展或收缩
        if (direction.dx < 0) {
          newRect.left = Math.max(0, rect.left - step);
          newRect.width = rect.width + (rect.left - newRect.left);
        } else if (direction.dx > 0) {
          newRect.width = Math.max(minSize, rect.width - step);
          newRect.left = rect.left + rect.width - newRect.width;
        }
        if (direction.dy < 0) {
          newRect.top = Math.max(0, rect.top - step);
          newRect.height = rect.height + (rect.top - newRect.top);
        } else if (direction.dy > 0) {
          newRect.height = Math.max(minSize, rect.height - step);
          newRect.top = rect.top + rect.height - newRect.height;
        }
        break;

      case 'n':
        // 上边：只能上下调整
        if (direction.dy < 0) {
          newRect.top = Math.max(0, rect.top - step);
          newRect.height = rect.height + (rect.top - newRect.top);
        } else if (direction.dy > 0) {
          newRect.height = Math.max(minSize, rect.height - step);
          newRect.top = rect.top + rect.height - newRect.height;
        }
        break;

      case 'ne':
        // 右上角
        if (direction.dx > 0) {
          newRect.width = Math.min(window.innerWidth - rect.left, rect.width + step);
        } else if (direction.dx < 0) {
          newRect.width = Math.max(minSize, rect.width - step);
        }
        if (direction.dy < 0) {
          newRect.top = Math.max(0, rect.top - step);
          newRect.height = rect.height + (rect.top - newRect.top);
        } else if (direction.dy > 0) {
          newRect.height = Math.max(minSize, rect.height - step);
          newRect.top = rect.top + rect.height - newRect.height;
        }
        break;

      case 'e':
        // 右边：只能左右调整
        if (direction.dx > 0) {
          newRect.width = Math.min(window.innerWidth - rect.left, rect.width + step);
        } else if (direction.dx < 0) {
          newRect.width = Math.max(minSize, rect.width - step);
        }
        break;

      case 'se':
        // 右下角
        if (direction.dx > 0) {
          newRect.width = Math.min(window.innerWidth - rect.left, rect.width + step);
        } else if (direction.dx < 0) {
          newRect.width = Math.max(minSize, rect.width - step);
        }
        if (direction.dy > 0) {
          newRect.height = Math.min(window.innerHeight - rect.top, rect.height + step);
        } else if (direction.dy < 0) {
          newRect.height = Math.max(minSize, rect.height - step);
        }
        break;

      case 's':
        // 下边：只能上下调整
        if (direction.dy > 0) {
          newRect.height = Math.min(window.innerHeight - rect.top, rect.height + step);
        } else if (direction.dy < 0) {
          newRect.height = Math.max(minSize, rect.height - step);
        }
        break;

      case 'sw':
        // 左下角
        if (direction.dx < 0) {
          newRect.left = Math.max(0, rect.left - step);
          newRect.width = rect.width + (rect.left - newRect.left);
        } else if (direction.dx > 0) {
          newRect.width = Math.max(minSize, rect.width - step);
          newRect.left = rect.left + rect.width - newRect.width;
        }
        if (direction.dy > 0) {
          newRect.height = Math.min(window.innerHeight - rect.top, rect.height + step);
        } else if (direction.dy < 0) {
          newRect.height = Math.max(minSize, rect.height - step);
        }
        break;

      case 'w':
        // 左边：只能左右调整
        if (direction.dx < 0) {
          newRect.left = Math.max(0, rect.left - step);
          newRect.width = rect.width + (rect.left - newRect.left);
        } else if (direction.dx > 0) {
          newRect.width = Math.max(minSize, rect.width - step);
          newRect.left = rect.left + rect.width - newRect.width;
        }
        break;
    }

    // 确保选区不超出视口
    newRect.left = Math.max(0, newRect.left);
    newRect.top = Math.max(0, newRect.top);
    newRect.width = Math.min(window.innerWidth - newRect.left, newRect.width);
    newRect.height = Math.min(window.innerHeight - newRect.top, newRect.height);

    // 确保最小尺寸
    if (newRect.width < minSize || newRect.height < minSize) {
      return null;
    }

    return newRect;
  }

  /**
   * 更新选区框显示
   */
  function updateSelectionRect() {
    if (!selectionBox || !currentRect) return;

    selectionBox.style.left = `${currentRect.left}px`;
    selectionBox.style.top = `${currentRect.top}px`;
    selectionBox.style.width = `${currentRect.width}px`;
    selectionBox.style.height = `${currentRect.height}px`;
  }

  /**
   * 选区框鼠标按下事件（移动选区）
   * @param {MouseEvent} e
   */
  function onSelectionMouseDown(e) {
    if (!isEditMode || isDragging) return;
    e.preventDefault();
    e.stopPropagation();

    isDragging = true;
    dragType = 'move';
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    originalRect = { ...currentRect };
  }

  /**
   * 编辑模式鼠标移动事件
   * @param {MouseEvent} e
   */
  function onEditModeMouseMove(e) {
    if (!isDragging || !originalRect) return;

    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;
    const minSize = 5;

    let newRect = { ...originalRect };

    switch (dragType) {
      case 'move':
        // 移动整个选区
        newRect.left = Math.max(0, Math.min(window.innerWidth - newRect.width, originalRect.left + deltaX));
        newRect.top = Math.max(0, Math.min(window.innerHeight - newRect.height, originalRect.top + deltaY));
        break;

      case 'nw':
        newRect.left = Math.min(originalRect.left + originalRect.width - minSize, originalRect.left + deltaX);
        newRect.top = Math.min(originalRect.top + originalRect.height - minSize, originalRect.top + deltaY);
        newRect.width = originalRect.width - (newRect.left - originalRect.left);
        newRect.height = originalRect.height - (newRect.top - originalRect.top);
        break;

      case 'n':
        newRect.top = Math.min(originalRect.top + originalRect.height - minSize, originalRect.top + deltaY);
        newRect.height = originalRect.height - (newRect.top - originalRect.top);
        break;

      case 'ne':
        newRect.top = Math.min(originalRect.top + originalRect.height - minSize, originalRect.top + deltaY);
        newRect.width = Math.max(minSize, originalRect.width + deltaX);
        newRect.height = originalRect.height - (newRect.top - originalRect.top);
        break;

      case 'e':
        newRect.width = Math.max(minSize, originalRect.width + deltaX);
        break;

      case 'se':
        newRect.width = Math.max(minSize, originalRect.width + deltaX);
        newRect.height = Math.max(minSize, originalRect.height + deltaY);
        break;

      case 's':
        newRect.height = Math.max(minSize, originalRect.height + deltaY);
        break;

      case 'sw':
        newRect.left = Math.min(originalRect.left + originalRect.width - minSize, originalRect.left + deltaX);
        newRect.width = originalRect.width - (newRect.left - originalRect.left);
        newRect.height = Math.max(minSize, originalRect.height + deltaY);
        break;

      case 'w':
        newRect.left = Math.min(originalRect.left + originalRect.width - minSize, originalRect.left + deltaX);
        newRect.width = originalRect.width - (newRect.left - originalRect.left);
        break;
    }

    // 确保选区在视口内
    newRect.left = Math.max(0, newRect.left);
    newRect.top = Math.max(0, newRect.top);
    newRect.width = Math.min(window.innerWidth - newRect.left, newRect.width);
    newRect.height = Math.min(window.innerHeight - newRect.top, newRect.height);

    currentRect = newRect;

    // 更新选区框显示
    selectionBox.style.left = `${currentRect.left}px`;
    selectionBox.style.top = `${currentRect.top}px`;
    selectionBox.style.width = `${currentRect.width}px`;
    selectionBox.style.height = `${currentRect.height}px`;

    // 更新手柄和工具栏位置
    updateHandlesPosition();
    updateToolbarPosition();
    updateSizeDisplay();
  }

  /**
   * 编辑模式鼠标释放事件
   * @param {MouseEvent} e
   */
  function onEditModeMouseUp(e) {
    if (isDragging) {
      // 只在一次完整拖拽结束后记录，保证一次撤销回到拖拽前的状态。
      recordCurrentRect();
      // 更新撤销按钮状态
      updateUndoButtonState();
      isDragging = false;
      dragType = null;
      originalRect = null;
    }
  }

  /**
   * 将当前选区作为一个完整用户操作写入撤销栈。
   */
  function recordCurrentRect() {
    if (!currentRect || rectHistory.length === 0) return;
    const lastRect = rectHistory[rectHistory.length - 1];
    if (lastRect.left !== currentRect.left || lastRect.top !== currentRect.top ||
        lastRect.width !== currentRect.width || lastRect.height !== currentRect.height) {
      rectHistory.push({ ...currentRect });
    }
  }

  /**
   * 撤销选区操作
   * @description 回退到上一个选区状态
   */
  function undoSelection() {
    if (rectHistory.length <= 1) {
      // 没有可撤销的历史
      return;
    }

    // 移除当前状态
    rectHistory.pop();
    // 恢复到上一个状态
    const prevRect = rectHistory[rectHistory.length - 1];
    currentRect = { ...prevRect };

    // 更新选区框显示
    if (selectionBox) {
      selectionBox.style.left = `${currentRect.left}px`;
      selectionBox.style.top = `${currentRect.top}px`;
      selectionBox.style.width = `${currentRect.width}px`;
      selectionBox.style.height = `${currentRect.height}px`;
    }

    // 更新手柄和工具栏位置
    updateHandlesPosition();
    updateToolbarPosition();
    updateSizeDisplay();
    // 更新撤销按钮状态
    updateUndoButtonState();
  }

  /**
   * 更新撤销按钮状态
   */
  function updateUndoButtonState() {
    if (!toolbar) return;
    const undoBtn = toolbar.querySelector('#ocr-undo-btn');
    if (undoBtn) {
      undoBtn.disabled = rectHistory.length <= 1;
    }
  }

  /**
   * 确认选区并开始识别
   */
  async function confirmSelection() {
    if (!currentRect || currentRect.width < 10 || currentRect.height < 10) {
      showNotification(OCRI18n.t('content_msg_selection_small_edit'), 'warning');
      return;
    }

    // 清理UI（保留选区信息）
    const rect = { ...currentRect };
    cleanup();

    // 执行截图
    await captureAndRecognize(rect);
  }

  /**
   * 重新选择区域
   */
  function reselectArea() {
    cleanupEditMode();

    // 重置编辑模式状态
    isEditMode = false;
    currentRect = null;

    // 移除选区框
    if (selectionBox) {
      selectionBox.remove();
      selectionBox = null;
    }

    // 更新提示
    if (tooltip) {
      tooltip.textContent = OCRI18n.t('content_tooltip_start');
    }

    // 恢复遮罩层光标
    if (overlay) {
      overlay.style.cursor = 'crosshair';
    }

    // 重置起始坐标
    startX = 0;
    startY = 0;

    // 重新绑定初始框选阶段的事件监听器
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  /**
   * 取消截图
   */
  function cancelCapture() {
    cleanup();
    showNotification(OCRI18n.t('content_msg_cancelled'), 'info');
  }

  /**
   * 完全清理所有资源
   * @description 页面卸载时调用，移除所有DOM元素和事件监听器
   */
  function fullCleanup() {
    cleanup();
    cleanupEditMode();
    hideProgressNotification();
    // 销毁 Shadow DOM（彻底清理）
    destroyShadowDOM();
    // 移除运行时消息监听器
    chrome.runtime.onMessage.removeListener(messageListener);
    // 标记为未初始化
    window.ocrCaptureInitialized = false;
  }

  // 鼠标按下
  function onMouseDown(e) {
    if (e.button !== 0) return; // 只处理左键

    // 如果正在编辑模式或点击了工具栏/手柄，不处理
    if (isEditMode) return;
    if (toolbar && toolbar.contains(e.target)) return;
    if (handles.some(h => h && h.contains(e.target))) return;

    e.preventDefault();

    startX = e.clientX;
    startY = e.clientY;

    // 确保选区框不存在或已隐藏
    if (selectionBox) {
      selectionBox.remove();
      selectionBox = null;
    }

    createSelectionBox();
    updateSelectionBox(startX, startY, startX, startY);
  }

  // 鼠标移动
  function onMouseMove(e) {
    if (!selectionBox) return;
    updateSelectionBox(startX, startY, e.clientX, e.clientY);
  }

  // 鼠标释放
  async function onMouseUp() {
    if (!selectionBox) return;

    const rect = selectionBox.getBoundingClientRect();

    // 检查选区大小
    if (rect.width < 10 || rect.height < 10) {
      cleanup();
      showNotification(OCRI18n.t('content_msg_selection_small'), 'warning');
      return;
    }

    // 进入编辑模式（不再直接截图）
    enterEditMode({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    });
  }

  // 键盘事件
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (isEditMode) {
        // 编辑模式下ESC取消
        cancelCapture();
      } else {
        cleanup();
      }
    } else if (e.key === 'Enter' && isEditMode) {
      // 编辑模式下Enter确认
      e.preventDefault();
      confirmSelection();
    } else if (e.key === 'z' && isEditMode && (e.ctrlKey || e.metaKey)) {
      // 编辑模式下 Ctrl/Cmd+Z 撤销
      e.preventDefault();
      undoSelection();
    }
  }

  // 截取并识别
  async function captureAndRecognize(rect) {
    isCancelled = false;
    let requestId = null;

    try {
      showProgressNotification(OCRI18n.t('content_progress_capturing'), false);
      announceA11y(OCRI18n.t('content_a11y_capturing'));

      // 发送消息给background进行截图（因为content script无法直接调用chrome.tabs.captureVisibleTab）
      const response = await chrome.runtime.sendMessage({
        action: 'captureVisibleTab'
      });

      // 检查是否被取消
      if (isCancelled) return;

      if (!response || !response.dataUrl) {
        hideProgressNotification();
        showNotification(OCRI18n.t('content_msg_capture_failed'), 'error');
        return;
      }

      // 裁剪选区
      const croppedImage = await cropImage(response.dataUrl, rect);

      // 检查是否被取消
      if (isCancelled) return;

      // 更新为识别阶段，显示取消按钮
      showProgressNotification(OCRI18n.t('content_progress_recognizing'), true);
      announceA11y(OCRI18n.t('content_a11y_recognizing'));

      requestId = OCRCaptureUtils.createRequestId();
      activeRequestId = requestId;

      // 发送给background进行OCR识别
      const ocrResponse = await chrome.runtime.sendMessage({
        action: 'performOCR',
        requestId,
        imageData: croppedImage
      });

      // 检查是否被取消
      if (isCancelled || activeRequestId !== requestId) return;
      activeRequestId = null;

      // 计算识别用时
      const elapsed = progressStartTime ? Math.floor((Date.now() - progressStartTime) / 1000) : 0;
      hideProgressNotification();

      if (ocrResponse && ocrResponse.success) {
        showResultPopup(ocrResponse.text, ocrResponse.historyId);
        showNotification(OCRI18n.t('content_msg_done', [String(elapsed)]), 'success');
        announceA11y(OCRI18n.t('content_a11y_done', [String(elapsed)]));
      } else {
        showNotification(ocrResponse?.error || OCRI18n.t('content_msg_recognition_failed'), 'error');
        announceA11y(OCRI18n.t('content_a11y_failed'));
      }
    } catch (error) {
      hideProgressNotification();
      if (!isCancelled) {
        console.error('截图识别失败:', error);
        showNotification(OCRI18n.t('content_msg_recognition_failed') + ': ' + error.message, 'error');
        announceA11y(OCRI18n.t('content_a11y_failed') + ': ' + error.message);
      }
    } finally {
      if (requestId && activeRequestId === requestId) {
        activeRequestId = null;
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

        const imageWidth = img.naturalWidth || img.width;
        const imageHeight = img.naturalHeight || img.height;
        const scale = OCRCaptureUtils.computeCropScale(
          imageWidth,
          imageHeight,
          window.innerWidth,
          window.innerHeight
        );

        const sourceLeft = Math.max(0, Math.min(imageWidth - 1, rect.left * scale.x));
        const sourceTop = Math.max(0, Math.min(imageHeight - 1, rect.top * scale.y));
        const sourceWidth = Math.max(0, Math.min(imageWidth - sourceLeft, rect.width * scale.x));
        const sourceHeight = Math.max(0, Math.min(imageHeight - sourceTop, rect.height * scale.y));

        if (sourceWidth < 15 || sourceHeight < 15) {
          reject(new Error(OCRI18n.t('content_msg_selection_small_edit')));
          return;
        }

        const limits = { maxEdge: 4096, maxPixels: 12_000_000 };
        let fitted = OCRCaptureUtils.fitImageWithinLimits(sourceWidth, sourceHeight, limits);
        const maxBase64Length = 3 * 1024 * 1024;

        for (let attempt = 0; attempt < 12; attempt += 1) {
          canvas.width = fitted.width;
          canvas.height = fitted.height;
          ctx.clearRect(0, 0, fitted.width, fitted.height);
          ctx.drawImage(
            img,
            sourceLeft,
            sourceTop,
            sourceWidth,
            sourceHeight,
            0,
            0,
            fitted.width,
            fitted.height
          );

          const normalizedImage = canvas.toDataURL('image/png');
          const base64Payload = normalizedImage.slice(normalizedImage.indexOf(',') + 1);
          if (base64Payload.length <= maxBase64Length) {
            resolve(normalizedImage);
            return;
          }

          const nextScale = Math.min(0.9, Math.sqrt(maxBase64Length / base64Payload.length) * 0.95);
          const nextWidth = Math.floor(fitted.width * nextScale);
          const nextHeight = Math.floor(fitted.height * nextScale);
          if (nextWidth < 15 || nextHeight < 15) break;
          fitted = { width: nextWidth, height: nextHeight };
        }

        reject(new Error(OCRI18n.t('content_msg_selection_small_edit')));
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  /**
   * 显示结果弹窗
   * @param {string} text - 识别结果文本
   * @param {string|number} historyId - 对应的历史记录 ID
   * @description 在页面右上角显示识别结果弹窗，支持修订、保存和复制
   */
  function showResultPopup(text, historyId) {
    // 确保 Shadow DOM 已初始化
    if (!shadowRoot) {
      initShadowDOM();
    }

    // 移除已有的结果弹窗（在 Shadow DOM 范围内查找）
    const existingPopup = shadowRoot.getElementById('ocr-result-popup');
    if (existingPopup) {
      existingPopup.remove();
    }

    const popup = document.createElement('div');
    popup.id = 'ocr-result-popup';
    popup.style.cssText = `
      position: fixed;
      top: 32px;
      right: 32px;
      width: 420px;
      max-height: 80vh;
      background: var(--bg-main);
      border-radius: var(--radius-xl);
      box-shadow: 0 20px 60px rgba(0,0,0,0.2);
      z-index: ${Z.RESULT_POPUP};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      overflow: hidden;
      animation: ocr-slideIn var(--duration-normal) var(--ease-smooth);
      pointer-events: auto;
      border: 1px solid var(--border);
      display: flex;
      flex-direction: column;
    `;

    popup.innerHTML = `
      <style>
        @keyframes ocr-slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes ocr-slideOut {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(100%); opacity: 0; }
        }
        #ocr-result-popup.closing {
          animation: ocr-slideOut var(--duration-normal) var(--ease-smooth) forwards;
        }
        .ocr-result-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--divider);
        }
        .ocr-result-title {
          font-size: 15px;
          font-weight: 700;
          color: var(--text-primary);
        }
        .ocr-close-btn {
          width: 32px;
          height: 32px;
          background: transparent;
          border: none;
          border-radius: var(--radius-sm);
          color: var(--text-secondary);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all var(--duration-fast);
        }
        .ocr-close-btn:hover {
          background: var(--bg-sub);
          color: var(--text-primary);
        }
        .ocr-result-content {
          padding: 20px;
          flex: 1;
          display: flex;
          flex-direction: column;
        }
        .ocr-result-textarea {
          width: 100%;
          height: 240px;
          padding: 14px;
          background: var(--bg-sub);
          border: 1px solid transparent;
          border-radius: var(--radius-lg);
          font-size: 14px;
          line-height: 1.6;
          resize: vertical;
          outline: none;
          font-family: inherit;
          box-sizing: border-box;
          color: var(--text-primary);
          transition: border-color var(--duration-normal);
        }
        .ocr-result-textarea:focus {
          border-color: var(--accent);
        }
        .ocr-result-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-top: 20px;
        }
        .ocr-result-btn {
          flex: 1;
          min-width: 110px;
          padding: 12px 16px;
          border: none;
          border-radius: var(--radius-md);
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all var(--duration-fast) var(--ease-smooth);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }
        .ocr-result-btn:disabled {
          cursor: not-allowed;
          opacity: 0.45;
          transform: none;
          box-shadow: none;
        }
        .ocr-result-btn-primary {
          background: var(--accent);
          color: var(--accent-inverse);
        }
        .ocr-result-btn-primary:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        .ocr-result-btn-secondary {
          background: var(--bg-hover);
          color: var(--text-primary);
        }
        .ocr-result-btn-secondary:hover {
          filter: brightness(0.95);
        }
        .ocr-result-btn.copied {
          background: var(--status-success) !important;
          color: white !important;
        }
      </style>
      <div class="ocr-result-header">
        <span class="ocr-result-title">${OCRI18n.t('preview_title')}</span>
        <button class="ocr-close-btn" title="${OCRI18n.t('btn_close')}" aria-label="${OCRI18n.t('content_aria_close')}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="ocr-result-content">
        <textarea class="ocr-result-textarea" id="ocr-result-text" placeholder="${OCRI18n.t('content_result_title')}" aria-label="${OCRI18n.t('content_aria_result')}"></textarea>
        <div class="ocr-result-actions">
          <button class="ocr-result-btn ocr-result-btn-primary copy-btn" aria-label="${OCRI18n.t('content_aria_copy')}">
            <svg class="copy-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span class="btn-text">${OCRI18n.t('content_btn_copy')}</span>
          </button>
          <button class="ocr-result-btn ocr-result-btn-secondary save-changes-btn" type="button" disabled>${OCRI18n.t('content_btn_save_changes')}</button>
          <button class="ocr-result-btn ocr-result-btn-secondary close-popup-btn" aria-label="${OCRI18n.t('btn_close')}">${OCRI18n.t('btn_close')}</button>
        </div>
      </div>
    `;

    if (shadowRoot) {
      shadowRoot.appendChild(popup);
    }

    // 安全赋值
    const textarea = popup.querySelector('#ocr-result-text');
    textarea.value = text || '';

    // 绑定事件
    const closeBtn = popup.querySelector('.ocr-close-btn');
    const closePopupBtn = popup.querySelector('.close-popup-btn');
    const copyBtn = popup.querySelector('.copy-btn');
    const saveChangesBtn = popup.querySelector('.save-changes-btn');
    const btnText = copyBtn.querySelector('.btn-text');
    const copyIcon = copyBtn.querySelector('.copy-icon');
    let lastSavedText = textarea.value.trim();

    const updateSaveButtonState = () => {
      const currentText = textarea.value.trim();
      saveChangesBtn.disabled = !historyId || !currentText || currentText === lastSavedText;
    };

    textarea.addEventListener('input', updateSaveButtonState);

    const close = () => {
      popup.classList.add('closing');
      setTimeout(() => popup.remove(), 300);
    };

    closeBtn.addEventListener('click', close);
    closePopupBtn.addEventListener('click', close);

    saveChangesBtn.addEventListener('click', async () => {
      const updatedText = textarea.value.trim();
      if (!historyId || !updatedText || updatedText === lastSavedText) return;

      saveChangesBtn.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'updateHistoryRecord',
          historyId,
          text: updatedText
        });
        if (!response?.success) {
          throw new Error(response?.error || OCRI18n.t('content_msg_changes_save_failed'));
        }

        textarea.value = updatedText;
        lastSavedText = updatedText;
        saveChangesBtn.textContent = OCRI18n.t('content_btn_saved');
        showNotification(OCRI18n.t('content_msg_changes_saved'), 'success');
        announceA11y(OCRI18n.t('content_msg_changes_saved'));
        setTimeout(() => {
          if (saveChangesBtn.isConnected) {
            saveChangesBtn.textContent = OCRI18n.t('content_btn_save_changes');
            updateSaveButtonState();
          }
        }, 1500);
      } catch (error) {
        console.error('保存识别结果修改失败:', error);
        showNotification(OCRI18n.t('content_msg_changes_save_failed'), 'error');
        announceA11y(OCRI18n.t('content_msg_changes_save_failed'));
        updateSaveButtonState();
      }
    });

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textarea.value);
        copyBtn.classList.add('copied');
        btnText.textContent = OCRI18n.t('btn_copied');
        copyIcon.innerHTML = `<polyline points="20 6 9 17 4 12"></polyline>`;
        
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          btnText.textContent = OCRI18n.t('content_btn_copy');
          copyIcon.innerHTML = `
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          `;
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
    // 确保 Shadow DOM 已初始化
    if (!shadowRoot) {
      initShadowDOM();
    }

    // 移除已有通知
    const existing = shadowRoot.getElementById('ocr-notification');
    if (existing) existing.remove();

    const notification = document.createElement('div');
    notification.id = 'ocr-notification';
    notification.style.cssText = `
      position: fixed;
      top: 32px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-main);
      color: var(--text-primary);
      padding: 12px 24px;
      border-radius: var(--radius-md);
      font-size: 14px;
      font-weight: 600;
      z-index: ${Z.NOTIFICATION};
      display: flex;
      align-items: center;
      gap: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.15);
      border: 1px solid var(--border);
      animation: ocr-notify-fadeIn var(--duration-normal) var(--ease-smooth);
    `;

    // 状态色指示器
    const statusColors = {
      info: 'var(--text-tertiary)',
      success: '#34C759',
      warning: '#FF9500',
      error: '#FF3B30'
    };
    const indicatorColor = statusColors[type] || statusColors.info;

    notification.innerHTML = `
      <style>
        @keyframes ocr-notify-fadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes ocr-notify-fadeOut {
          from { opacity: 1; transform: translateX(-50%) translateY(0); }
          to { opacity: 0; transform: translateX(-50%) translateY(-20px); }
        }
        .ocr-notify-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: ${indicatorColor};
        }
      </style>
      <div class="ocr-notify-indicator"></div>
      <span class="ocr-notify-msg"></span>
    `;

    notification.querySelector('.ocr-notify-msg').textContent = message;

    if (shadowRoot) {
      shadowRoot.appendChild(notification);
    }

    setTimeout(() => {
      notification.style.animation = 'ocr-notify-fadeOut var(--duration-normal) var(--ease-smooth) forwards';
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

    // 确保 Shadow DOM 已初始化
    if (!shadowRoot) {
      initShadowDOM();
    }

    const notification = document.createElement('div');
    notification.id = 'ocr-progress-notification';
    notification.innerHTML = `
      <div class="ocr-progress-content">
        <div class="ocr-progress-spinner"></div>
        <div class="ocr-progress-info">
          <div class="ocr-progress-message">${message}</div>
          <div class="ocr-progress-time">${OCRI18n.t('content_progress_elapsed')}: 0 ${OCRI18n.t('content_progress_seconds')}</div>
        </div>
        ${showCancel ? `<button class="ocr-progress-cancel">${OCRI18n.t('content_progress_cancel')}</button>` : ''}
      </div>
    `;

    if (shadowRoot) {
      shadowRoot.appendChild(notification);
    }
    progressNotification = notification;
    progressStartTime = Date.now();

    // 启动计时器
    const timeEl = notification.querySelector('.ocr-progress-time');
    progressTimer = setInterval(() => {
      if (timeEl) {
        const elapsed = Math.floor((Date.now() - progressStartTime) / 1000);
        timeEl.textContent = `${OCRI18n.t('content_progress_elapsed')}: ${elapsed} ${OCRI18n.t('content_progress_seconds')}`;
      }
    }, 1000);

    // 绑定取消按钮
    if (showCancel) {
      const cancelBtn = notification.querySelector('.ocr-progress-cancel');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          const requestId = activeRequestId;
          isCancelled = true;
          activeRequestId = null;
          hideProgressNotification();
          showNotification(OCRI18n.t('content_msg_recognition_cancelled'), 'warning');

          if (requestId) {
            chrome.runtime.sendMessage({
              action: 'cancelOCR',
              requestId
            }).catch((error) => {
              console.debug('取消 OCR 请求消息发送失败:', error);
            });
          }
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
    if (activeRequestId) {
      showNotification(OCRI18n.t('content_progress_recognizing'), 'warning');
      return;
    }

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
  function messageListener(request, _sender, sendResponse) {
    if (request.action === 'startCapture') {
      i18nReady.then(() => {
        startCapture();
        sendResponse({ success: true });
      }).catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
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
