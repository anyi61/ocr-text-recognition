/**
 * @fileoverview content.js - OCR文字识别助手内容脚本
 * @description 处理页面截图选区、图片裁剪、结果显示和进度通知
 */

(function() {
  // 使用统一的 OCRI18n API（来自 i18n-runtime.js）
  OCRI18n.init().catch((error) => {
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

  // 注入进度通知样式和编辑模式样式
  const progressStyles = document.createElement('style');
  progressStyles.textContent = `
    /* 进度通知样式 */
    #ocr-progress-notification {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #333;
      color: #fff;
      padding: 16px 24px;
      border-radius: 12px;
      z-index: ${Z.PROGRESS};
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

    /* 编辑模式样式 */
    .ocr-handle {
      position: fixed;
      width: 12px;
      height: 12px;
      background: #667eea;
      border: 2px solid #fff;
      border-radius: 50%;
      cursor: pointer;
      z-index: ${Z.HANDLE};
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      transition: transform 0.15s ease, background 0.15s ease;
    }
    /* 手柄热区扩大到 24px */
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
      transform: scale(1.3);
      background: #764ba2;
    }
    .ocr-handle-nw { cursor: nwse-resize; }
    .ocr-handle-ne { cursor: nesw-resize; }
    .ocr-handle-sw { cursor: nesw-resize; }
    .ocr-handle-se { cursor: nwse-resize; }
    .ocr-handle-n, .ocr-handle-s { cursor: ns-resize; }
    .ocr-handle-e, .ocr-handle-w { cursor: ew-resize; }

    /* 选区框双层边框 */
    #ocr-selection-box {
      border: 2px solid #667eea;
      outline: 2px solid rgba(255, 255, 255, 0.8);
      outline-offset: 0;
    }

    /* 工具栏样式 */
    #ocr-toolbar {
      position: fixed;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 16px;
      background: #333;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      z-index: ${Z.TOOLBAR};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: ocr-toolbar-fadeIn 0.2s ease;
    }
    @keyframes ocr-toolbar-fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .ocr-size-info {
      color: #fff;
      font-size: 13px;
      font-weight: 500;
      min-width: 100px;
    }
    .ocr-size-warning {
      color: #ff6b6b;
    }
    .ocr-toolbar-buttons {
      display: flex;
      gap: 8px;
    }
    .ocr-btn {
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
    }
    .ocr-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .ocr-btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .ocr-btn-primary:hover:not(:disabled) {
      opacity: 0.9;
      transform: translateY(-1px);
    }
    .ocr-btn-secondary {
      background: #555;
      color: #fff;
    }
    .ocr-btn-secondary:hover {
      background: #666;
    }
    .ocr-btn-cancel {
      background: transparent;
      color: #aaa;
      border: 1px solid #555;
    }
    .ocr-btn-cancel:hover {
      background: #444;
      color: #fff;
    }
    /* 统一 focus-visible 样式 */
    .ocr-btn:focus-visible {
      outline: 2px solid #2563eb;
      outline-offset: 2px;
    }

    /* 编辑模式下的选区框 */
    #ocr-selection-box.edit-mode {
      pointer-events: auto;
      cursor: move;
      border-width: 2px;
    }
    #ocr-selection-box.edit-mode:hover {
      border-color: #764ba2;
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
  document.head.appendChild(progressStyles);

  // 创建无障碍状态播报区域
  let a11yLiveRegion = null;
  function ensureA11yLiveRegion() {
    if (!a11yLiveRegion || !document.body.contains(a11yLiveRegion)) {
      a11yLiveRegion = document.createElement('div');
      a11yLiveRegion.id = 'ocr-a11y-live';
      a11yLiveRegion.className = 'ocr-sr-only';
      a11yLiveRegion.setAttribute('aria-live', 'polite');
      a11yLiveRegion.setAttribute('aria-atomic', 'true');
      document.body.appendChild(a11yLiveRegion);
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
    overlay = document.createElement('div');
    overlay.id = 'ocr-capture-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.3);
      z-index: ${Z.OVERLAY};
      cursor: crosshair;
    `;

    // 创建提示文字
    tooltip = document.createElement('div');
    tooltip.id = 'ocr-capture-tooltip';
    tooltip.textContent = OCRI18n.t('content_tooltip_start');
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
      z-index: ${Z.TOOLTIP};
      pointer-events: none;
      white-space: nowrap;
      transition: background 0.2s;
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
      outline: 2px solid rgba(255, 255, 255, 0.8);
      outline-offset: 0;
      background: rgba(102, 126, 234, 0.1);
      pointer-events: none;
      z-index: ${Z.SELECTION};
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

    // 根据选区大小显示不同提示
    if (width < 10 || height < 10) {
      tooltip.textContent = `${Math.round(width)} × ${Math.round(height)} px - ${OCRI18n.t('content_tooltip_size_small')}`;
      tooltip.style.background = '#e74c3c';
      selectionBox.style.borderColor = '#e74c3c';
    } else {
      tooltip.textContent = `${Math.round(width)} × ${Math.round(height)} px - ${OCRI18n.t('content_tooltip_size_ok')}`;
      tooltip.style.background = '#333';
      selectionBox.style.borderColor = '#667eea';
    }
  }

  /**
   * 清理截图相关资源
   * @description 移除遮罩层、选区框，重置状态
   */
  function cleanup() {
    isCapturing = false;
    isEditMode = false;
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
    // 清理编辑模式元素
    cleanupEditMode();
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown);
  }

  /**
   * 清理编辑模式元素
   * @description 移除手柄和工具栏
   */
  function cleanupEditMode() {
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

    positions.forEach(pos => {
      const handle = document.createElement('div');
      handle.className = `ocr-handle ocr-handle-${pos}`;
      handle.dataset.position = pos;
      handle.addEventListener('mousedown', onHandleMouseDown);
      document.body.appendChild(handle);
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

    document.body.appendChild(toolbar);
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
      // 拖拽结束，记录历史
      if (currentRect && rectHistory.length > 0) {
        const lastRect = rectHistory[rectHistory.length - 1];
        // 只有当位置变化时才记录
        if (lastRect.left !== currentRect.left || lastRect.top !== currentRect.top ||
            lastRect.width !== currentRect.width || lastRect.height !== currentRect.height) {
          rectHistory.push({ ...currentRect });
        }
      }
      // 更新撤销按钮状态
      updateUndoButtonState();
      isDragging = false;
      dragType = null;
      originalRect = null;
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
      z-index: ${Z.RESULT_POPUP};
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
        #ocr-result-popup .btn:focus-visible {
          outline: 2px solid #2563eb;
          outline-offset: 2px;
        }
        #ocr-result-popup .close-btn:focus-visible {
          outline: 2px solid #2563eb;
          outline-offset: 2px;
        }
      </style>
      <button class="close-btn" title="${OCRI18n.t('btn_close')}" aria-label="${OCRI18n.t('content_aria_close')}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
      <div class="content">
        <textarea id="ocr-result-text" placeholder="${OCRI18n.t('content_result_title')}" aria-label="${OCRI18n.t('content_aria_result')}"></textarea>
        <div class="actions">
          <button class="btn btn-primary copy-btn" aria-label="${OCRI18n.t('content_aria_copy')}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            ${OCRI18n.t('content_btn_copy')}
          </button>
          <button class="btn btn-secondary close-popup-btn" aria-label="${OCRI18n.t('btn_close')}">${OCRI18n.t('btn_close')}</button>
        </div>
      </div>
    `;

    document.body.appendChild(popup);

    // 安全赋值：通过 value 属性设置文本，避免 innerHTML 注入风险
    const textarea = popup.querySelector('#ocr-result-text');
    textarea.value = text || '';

    // 绑定事件
    const closeBtn = popup.querySelector('.close-btn');
    const closePopupBtn = popup.querySelector('.close-popup-btn');
    const copyBtn = popup.querySelector('.copy-btn');

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
          ${OCRI18n.t('btn_copied')}
        `;
        copyBtn.style.background = '#4caf50';
        setTimeout(() => {
          copyBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            ${OCRI18n.t('content_btn_copy_text')}
          `;
          copyBtn.style.background = '';
        }, 2000);
      } catch (err) {
        console.error(OCRI18n.t('content_msg_recognition_failed') + ':', err);
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
      z-index: ${Z.NOTIFICATION};
      display: flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      animation: fadeIn 0.3s ease;
    `;

    // 使用 DOM API 构建通知内容，避免 innerHTML 注入风险
    const style = document.createElement('style');
    style.textContent = `
      @keyframes fadeIn {
        from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      @keyframes fadeOut {
        from { opacity: 1; transform: translateX(-50%) translateY(0); }
        to { opacity: 0; transform: translateX(-50%) translateY(-10px); }
      }
    `;
    notification.appendChild(style);

    const iconSpan = document.createElement('span');
    iconSpan.textContent = icon;
    notification.appendChild(iconSpan);

    const messageSpan = document.createElement('span');
    messageSpan.textContent = message;
    notification.appendChild(messageSpan);

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
          <div class="ocr-progress-time">${OCRI18n.t('content_progress_elapsed')}: 0 ${OCRI18n.t('content_progress_seconds')}</div>
        </div>
        ${showCancel ? `<button class="ocr-progress-cancel">${OCRI18n.t('content_progress_cancel')}</button>` : ''}
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
        timeEl.textContent = `${OCRI18n.t('content_progress_elapsed')}: ${elapsed} ${OCRI18n.t('content_progress_seconds')}`;
      }
    }, 1000);

    // 绑定取消按钮
    if (showCancel) {
      const cancelBtn = notification.querySelector('.ocr-progress-cancel');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          isCancelled = true;
          hideProgressNotification();
          showNotification(OCRI18n.t('content_msg_recognition_cancelled'), 'warning');
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
  function messageListener(request, _sender, sendResponse) {
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
