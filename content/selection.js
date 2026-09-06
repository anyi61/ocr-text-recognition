// @ts-check
/** Owns selection geometry, editing history, handles and input listeners. */
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRSelection = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create(dependencies) {
    const { document, window, i18n: OCRI18n, captureUtils: OCRCaptureUtils, Z,
      getShadowRoot, initShadowDOM, announceA11y, showNotification,
      confirmSelection, cancelCapture, isNoticeOpen } = dependencies;
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
      if (getShadowRoot()) {
        getShadowRoot().appendChild(selectionBox);
      }
    }

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

    function cleanup() {
      isCapturing = false;
      isEditMode = false;
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
      // 注意：不销毁 shadowHost/getShadowRoot()，因为后续可能需要显示通知/结果弹窗
      // Shadow DOM 的销毁放在 fullCleanup() 或 destroyShadowDOM() 中
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keydown', onKeyDown);
    }

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
        if (getShadowRoot()) {
          getShadowRoot().appendChild(handle);
        }
        handles.push(handle);
      });

      updateHandlesPosition();
    }

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

    function createToolbar() {
      toolbar = document.createElement('div');
      toolbar.id = 'ocr-toolbar';
      toolbar.setAttribute('role', 'toolbar');
      toolbar.innerHTML = `
        <span class="ocr-size-info"></span>
        <div class="ocr-toolbar-buttons">
          <button class="ocr-btn ocr-btn-secondary" id="ocr-undo-btn" disabled></button>
          <button class="ocr-btn ocr-btn-primary" id="ocr-confirm-btn"></button>
          <button class="ocr-btn ocr-btn-secondary" id="ocr-reselect-btn"></button>
          <button class="ocr-btn ocr-btn-cancel" id="ocr-cancel-btn"></button>
        </div>
      `;

      toolbar.querySelector('.ocr-size-info').textContent = `${Math.round(currentRect.width)} × ${Math.round(currentRect.height)} px`;
      for (const [selector, textKey, ariaKey] of [
        ['#ocr-undo-btn', 'content_btn_undo', 'content_aria_undo'],
        ['#ocr-confirm-btn', 'content_btn_confirm', 'content_aria_confirm'],
        ['#ocr-reselect-btn', 'content_btn_reselect', 'content_aria_reselect'],
        ['#ocr-cancel-btn', 'content_btn_cancel_capture', 'content_aria_cancel']
      ]) {
        const button = toolbar.querySelector(selector);
        button.textContent = OCRI18n.t(textKey);
        button.setAttribute('aria-label', OCRI18n.t(ariaKey));
      }

      if (getShadowRoot()) {
        getShadowRoot().appendChild(toolbar);
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

    function updateSizeDisplay() {
      if (!toolbar || !currentRect) return;

      const sizeInfo = toolbar.querySelector('.ocr-size-info');
      const confirmBtn = toolbar.querySelector('#ocr-confirm-btn');

      if (currentRect.width < 10 || currentRect.height < 10) {
        sizeInfo.replaceChildren();
        const warning = document.createElement('span');
        warning.className = 'ocr-size-warning';
        warning.textContent = `${Math.round(currentRect.width)} × ${Math.round(currentRect.height)} px - ${OCRI18n.t('content_msg_selection_small_edit')}`;
        sizeInfo.appendChild(warning);
        confirmBtn.disabled = true;
      } else {
        sizeInfo.textContent = `${Math.round(currentRect.width)} × ${Math.round(currentRect.height)} px`;
        confirmBtn.disabled = false;
      }
    }

    function onHandleMouseDown(e) {
      if (!e?.isTrusted) return;
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

    function onHandleKeyDown(e) {
      if (!e?.isTrusted) return;
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

    function updateSelectionRect() {
      if (!selectionBox || !currentRect) return;

      selectionBox.style.left = `${currentRect.left}px`;
      selectionBox.style.top = `${currentRect.top}px`;
      selectionBox.style.width = `${currentRect.width}px`;
      selectionBox.style.height = `${currentRect.height}px`;
    }

    function onSelectionMouseDown(e) {
      if (!e?.isTrusted) return;
      if (!isEditMode || isDragging) return;
      e.preventDefault();
      e.stopPropagation();

      isDragging = true;
      dragType = 'move';
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      originalRect = { ...currentRect };
    }

    function onEditModeMouseMove(e) {
      if (!e?.isTrusted) return;
      if (!isDragging || !originalRect) return;

      const deltaX = e.clientX - dragStartX;
      const deltaY = e.clientY - dragStartY;
      currentRect = OCRCaptureUtils.resizeSelectionRect(
        originalRect,
        dragType,
        deltaX,
        deltaY,
        { width: window.innerWidth, height: window.innerHeight },
        5
      );

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

    function onEditModeMouseUp(e) {
      if (!e?.isTrusted) return;
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

    function recordCurrentRect() {
      if (!currentRect || rectHistory.length === 0) return;
      const lastRect = rectHistory[rectHistory.length - 1];
      if (lastRect.left !== currentRect.left || lastRect.top !== currentRect.top ||
          lastRect.width !== currentRect.width || lastRect.height !== currentRect.height) {
        rectHistory.push({ ...currentRect });
      }
    }

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

    function updateUndoButtonState() {
      if (!toolbar) return;
      const undoBtn = toolbar.querySelector('#ocr-undo-btn');
      if (undoBtn) {
        undoBtn.disabled = rectHistory.length <= 1;
      }
    }

    function reselectArea(event) {
      if (!event?.isTrusted) return;
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

    function onMouseDown(e) {
      if (!e?.isTrusted) return;
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

    function onMouseMove(e) {
      if (!e?.isTrusted) return;
      if (!selectionBox) return;
      updateSelectionBox(startX, startY, e.clientX, e.clientY);
    }

    async function onMouseUp(e) {
      if (!e?.isTrusted) return;
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

    function onKeyDown(e) {
      if (!e?.isTrusted) return;
      if (isNoticeOpen()) return;
      if (e.key === 'Escape') {
        cancelCapture(e);
      } else if (e.key === 'Enter' && isEditMode) {
        // 编辑模式下Enter确认
        e.preventDefault();
        confirmSelection(e);
      } else if (e.key === 'z' && isEditMode && (e.ctrlKey || e.metaKey)) {
        // 编辑模式下 Ctrl/Cmd+Z 撤销
        e.preventDefault();
        undoSelection();
      }
    }
    function start() {
      cleanup();
      currentRect = null;
      startX = startY = 0;
      isCapturing = true;
      createOverlay();
      document.addEventListener('mousedown', onMouseDown);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.addEventListener('keydown', onKeyDown);
    }
    function destroy() {
      cleanup();
      currentRect = null;
      startX = startY = 0;
    }
    return { start, destroy, clear: destroy,
      getRect: () => currentRect ? { ...currentRect } : null };

  }
  return { create };
}));
