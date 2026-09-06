// @ts-check
/** Owns consent dialogs and progress UI; calls back to the session for cancellation. */
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRNoticeView = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create(dependencies) {
    const { document, i18n: OCRI18n, chrome, Z, getShadowRoot, initShadowDOM,
      scheduleUiTimeout, getSessionId, isCurrentSession, endCaptureSession } = dependencies;
    let progressNotification = null;
    let progressTimer = null;
    let progressStartTime = null;
    let uploadNoticeOpen = false;
    let closeUploadNotice = null;
    function getProviderLabel(provider) {
      const keys = {
        claude: 'provider_claude',
        openai: 'provider_openai',
        baidu: 'provider_baidu',
        aliyun: 'provider_aliyun',
        zhipu: 'provider_zhipu',
        'openai-compatible': 'provider_openai_compatible',
        custom: 'provider_custom'
      };
      return OCRI18n.t(keys[provider] || 'provider_custom');
    }

    async function confirmUploadNoticeIfNeeded(sessionId) {
      const state = await chrome.runtime.sendMessage({ action: 'getUploadNoticeState' });
      if (!isCurrentSession(sessionId)) return false;
      if (!state?.success) {
        throw new Error(OCRI18n.t('content_upload_notice_state_failed'));
      }
      if (state.acknowledged) return true;
      if (!getShadowRoot()) return false;

      uploadNoticeOpen = true;
      const accepted = await new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'ocr-upload-notice-backdrop';

        const dialog = document.createElement('div');
        dialog.className = 'ocr-upload-notice-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const title = document.createElement('h2');
        title.textContent = OCRI18n.t('content_upload_notice_title');
        const message = document.createElement('p');
        message.textContent = OCRI18n.t('content_upload_notice_message', [
          getProviderLabel(state.provider)
        ]);

        const actions = document.createElement('div');
        actions.className = 'ocr-upload-notice-actions';
        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'ocr-upload-notice-cancel';
        cancelButton.textContent = OCRI18n.t('btn_cancel');
        const acceptButton = document.createElement('button');
        acceptButton.type = 'button';
        acceptButton.className = 'ocr-upload-notice-accept';
        acceptButton.textContent = OCRI18n.t('content_upload_notice_accept');

        let settled = false;
        const events = new AbortController();
        const finish = (value) => {
          if (settled) return;
          settled = true;
          events.abort();
          backdrop.remove();
          if (closeUploadNotice === finish) {
            closeUploadNotice = null;
            uploadNoticeOpen = false;
          }
          resolve(value);
        };
        closeUploadNotice = finish;
        cancelButton.addEventListener('click', (event) => {
          if (event?.isTrusted) finish(false);
        }, { signal: events.signal });
        acceptButton.addEventListener('click', (event) => {
          if (event?.isTrusted) finish(true);
        }, { signal: events.signal });
        dialog.addEventListener('keydown', (event) => {
          if (event.isTrusted && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }, { signal: events.signal });

        actions.append(cancelButton, acceptButton);
        dialog.append(title, message, actions);
        backdrop.appendChild(dialog);
        getShadowRoot().appendChild(backdrop);
        cancelButton.focus();
      });

      if (!accepted || !isCurrentSession(sessionId)) return false;
      const result = await chrome.runtime.sendMessage({ action: 'acknowledgeUploadNotice' });
      if (!isCurrentSession(sessionId)) return false;
      if (!result?.success) {
        throw new Error(OCRI18n.t('content_upload_notice_state_failed'));
      }
      return true;
    }

    function showNotification(message, type = 'info') {
      // 确保 Shadow DOM 已初始化
      if (!getShadowRoot()) {
        initShadowDOM();
      }

      // 移除已有通知
      const existing = getShadowRoot().getElementById('ocr-notification');
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

      if (getShadowRoot()) {
        getShadowRoot().appendChild(notification);
      }

      scheduleUiTimeout(() => {
        notification.style.animation = 'ocr-notify-fadeOut var(--duration-normal) var(--ease-smooth) forwards';
        scheduleUiTimeout(() => notification.remove(), 300);
      }, 3000);
    }

    function showProgressNotification(message, showCancel = false) {
      // 移除已有进度通知
      hideProgressNotification();

      // 确保 Shadow DOM 已初始化
      if (!getShadowRoot()) {
        initShadowDOM();
      }

      const notification = document.createElement('div');
      notification.id = 'ocr-progress-notification';
      notification.innerHTML = `
        <div class="ocr-progress-content">
          <div class="ocr-progress-spinner"></div>
          <div class="ocr-progress-info">
            <div class="ocr-progress-message"></div>
            <div class="ocr-progress-time"></div>
          </div>
        </div>
      `;
      notification.querySelector('.ocr-progress-message').textContent = message;
      notification.querySelector('.ocr-progress-time').textContent = `${OCRI18n.t('content_progress_elapsed')}: 0 ${OCRI18n.t('content_progress_seconds')}`;
      if (showCancel) {
        const cancelButton = document.createElement('button');
        cancelButton.className = 'ocr-progress-cancel';
        cancelButton.textContent = OCRI18n.t('content_progress_cancel');
        notification.querySelector('.ocr-progress-content').appendChild(cancelButton);
      }

      if (getShadowRoot()) {
        getShadowRoot().appendChild(notification);
      }
      progressNotification = notification;
      progressStartTime = Date.now();

      // 启动计时器
      const timeEl = notification.querySelector('.ocr-progress-time');
      const sessionId = getSessionId();
      progressTimer = setInterval(() => {
        if (timeEl && isCurrentSession(sessionId) && progressNotification === notification) {
          const elapsed = Math.floor((Date.now() - progressStartTime) / 1000);
          timeEl.textContent = `${OCRI18n.t('content_progress_elapsed')}: ${elapsed} ${OCRI18n.t('content_progress_seconds')}`;
        }
      }, 1000);

      // 绑定取消按钮
      if (showCancel) {
        const cancelBtn = notification.querySelector('.ocr-progress-cancel');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', (event) => {
            if (!event?.isTrusted || !isCurrentSession(sessionId)) return;
            endCaptureSession();
            showNotification(OCRI18n.t('content_msg_recognition_cancelled'), 'warning');
          });
        }
      }

      return notification;
    }

    function updateProgressNotification(message) {
      if (progressNotification) {
        const msgEl = progressNotification.querySelector('.ocr-progress-message');
        if (msgEl) {
          msgEl.textContent = message;
        }
      }
    }

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
    function destroy() {
      closeUploadNotice?.(false);
      hideProgressNotification();
      getShadowRoot()?.getElementById('ocr-notification')?.remove();
    }
    return { confirm: confirmUploadNoticeIfNeeded, showNotification,
      showProgressNotification, hideProgressNotification, destroy,
      isOpen: () => uploadNoticeOpen,
      elapsed: () => progressStartTime ? Math.floor((Date.now() - progressStartTime) / 1000) : 0 };

  }
  return { create };
}));
