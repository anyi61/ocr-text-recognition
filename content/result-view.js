// @ts-check
/** Renders text safely and handles copy and history edits through injected platform APIs. */
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRResultView = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create(dependencies) {
    const { document, navigator, chrome, i18n: OCRI18n, Z, getShadowRoot,
      initShadowDOM, scheduleUiTimeout, showNotification, announceA11y } = dependencies;
    function showResultPopup(text, historyId) {
      // 确保 Shadow DOM 已初始化
      if (!getShadowRoot()) {
        initShadowDOM();
      }

      // 移除已有的结果弹窗（在 Shadow DOM 范围内查找）
      const existingPopup = getShadowRoot().getElementById('ocr-result-popup');
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
          <span class="ocr-result-title"></span>
          <button class="ocr-close-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="ocr-result-content">
          <textarea class="ocr-result-textarea" id="ocr-result-text"></textarea>
          <div class="ocr-result-actions">
            <button class="ocr-result-btn ocr-result-btn-primary copy-btn">
              <svg class="copy-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span class="btn-text"></span>
            </button>
            <button class="ocr-result-btn ocr-result-btn-secondary save-changes-btn" type="button" disabled></button>
            <button class="ocr-result-btn ocr-result-btn-secondary close-popup-btn"></button>
          </div>
        </div>
      `;

      if (getShadowRoot()) {
        getShadowRoot().appendChild(popup);
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
      popup.querySelector('.ocr-result-title').textContent = OCRI18n.t('preview_title');
      closeBtn.title = OCRI18n.t('btn_close');
      closeBtn.setAttribute('aria-label', OCRI18n.t('content_aria_close'));
      textarea.placeholder = OCRI18n.t('content_result_title');
      textarea.setAttribute('aria-label', OCRI18n.t('content_aria_result'));
      copyBtn.setAttribute('aria-label', OCRI18n.t('content_aria_copy'));
      btnText.textContent = OCRI18n.t('content_btn_copy');
      saveChangesBtn.textContent = OCRI18n.t('content_btn_save_changes');
      closePopupBtn.textContent = OCRI18n.t('btn_close');
      closePopupBtn.setAttribute('aria-label', OCRI18n.t('btn_close'));
      let lastSavedText = textarea.value.trim();

      const updateSaveButtonState = () => {
        const currentText = textarea.value.trim();
        saveChangesBtn.disabled = !historyId || !currentText || currentText === lastSavedText;
      };

      textarea.addEventListener('input', updateSaveButtonState);

      const close = () => {
        popup.classList.add('closing');
        scheduleUiTimeout(() => popup.remove(), 300);
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

          if (!popup.isConnected) return;
          textarea.value = updatedText;
          lastSavedText = updatedText;
          saveChangesBtn.textContent = OCRI18n.t('content_btn_saved');
          showNotification(OCRI18n.t('content_msg_changes_saved'), 'success');
          announceA11y(OCRI18n.t('content_msg_changes_saved'));
          scheduleUiTimeout(() => {
            if (saveChangesBtn.isConnected) {
              saveChangesBtn.textContent = OCRI18n.t('content_btn_save_changes');
              updateSaveButtonState();
            }
          }, 1500);
        } catch (error) {
          if (!popup.isConnected) return;
          console.error('保存识别结果修改失败:', error);
          showNotification(OCRI18n.t('content_msg_changes_save_failed'), 'error');
          announceA11y(OCRI18n.t('content_msg_changes_save_failed'));
          updateSaveButtonState();
        }
      });

      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(textarea.value);
          if (!popup.isConnected) return;
          copyBtn.classList.add('copied');
          btnText.textContent = OCRI18n.t('btn_copied');
          copyIcon.innerHTML = `<polyline points="20 6 9 17 4 12"></polyline>`;

          scheduleUiTimeout(() => {
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
    return { show: showResultPopup,
      destroy: () => getShadowRoot()?.getElementById('ocr-result-popup')?.remove() };

  }
  return { create };
}));
