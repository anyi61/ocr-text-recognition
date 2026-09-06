// @ts-check
/** Owns history snapshots, filtering, previews and row listeners. */
(function initialize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRHistoryView = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create(dependencies) {
    const { document, chrome, navigator, i18n: OCRI18n, popupRuntime: OCRPopupRuntime,
      announcePopupStatus, listen, schedule, isActive } = dependencies;
    let rowEvents = new AbortController();
    function listenRow(target, type, callback) {
      target.addEventListener(type, callback, { signal: rowEvents.signal });
    }
    const historyArea = document.getElementById('historyArea');
    const historyList = document.getElementById('historyList');
    const historyEmptyState = document.getElementById('historyEmptyState');
    const historySearchEmptyState = document.getElementById('historySearchEmptyState');
    const historySearchWrap = document.getElementById('historySearchWrap');
    const historySearch = document.getElementById('historySearch');
    const exportHistoryBtn = document.getElementById('exportHistoryBtn');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    const historyPreview = document.getElementById('historyPreview');
    const historyPreviewMeta = document.getElementById('historyPreviewMeta');
    const historyPreviewText = document.getElementById('historyPreviewText');
    const closePreviewBtn = document.getElementById('closePreviewBtn');
    const previewCopyBtn = document.getElementById('previewCopyBtn');
    // 历史记录数据（用于点击查看）
    let historyData = [];
    let activePreviewId = null;

    const providerLabels = Object.freeze({
      claude: 'Claude',
      openai: 'OpenAI',
      baidu: 'Baidu OCR',
      aliyun: 'Aliyun',
      zhipu: 'Zhipu AI',
      'openai-compatible': 'OpenAI Compatible',
      custom: 'Custom API'
    });

    const getLanguageLabel = (language) => {
      const key = ['zh', 'en', 'ja', 'ko'].includes(language)
        ? `language_${language}`
        : 'language_auto';
      return OCRI18n.t(key);
    };

    const formatHistoryTimestamp = (item) => {
      return OCRPopupRuntime.formatHistoryTimestamp(item, OCRI18n.getResolvedLanguage());
    };

    const getHistorySource = OCRPopupRuntime.getHistorySource;

    const getFilteredHistory = () => {
      return OCRPopupRuntime.filterHistory(historyData, historySearch.value);
    };

    /**
     * 显示历史详情预览
     * @param {Object} item - 历史记录
     */
    const showHistoryPreview = (item) => {
      activePreviewId = item.id;
      historyPreviewText.value = item.text || '';
      historyPreviewMeta.replaceChildren();

      const metadata = [
        `${OCRI18n.t('history_provider')}: ${providerLabels[item.provider] || item.provider || '-'}`,
        `${OCRI18n.t('history_language')}: ${getLanguageLabel(item.language)}`,
        formatHistoryTimestamp(item)
      ];
      const source = getHistorySource(item);
      if (source) {
        metadata.push(`${OCRI18n.t('history_source')}: ${source}`);
      }
      metadata.forEach((value) => {
        const span = document.createElement('span');
        span.textContent = value;
        if (source && value.endsWith(source) && item.sourceUrl) {
          span.title = item.sourceUrl;
        }
        historyPreviewMeta.appendChild(span);
      });

      historyPreview.classList.remove('hidden');
      historyList.classList.add('hidden');
      historySearchEmptyState.classList.add('hidden');
      historyEmptyState.classList.add('hidden');
    };

    /**
     * 隐藏历史详情预览
     */
    const hideHistoryPreview = () => {
      activePreviewId = null;
      historyPreview.classList.add('hidden');
      renderHistory();
    };

    /**
     * 渲染当前历史记录及搜索结果。
     */
    function renderHistory() {
      if (!isActive()) return;
      rowEvents.abort();
      rowEvents = new AbortController();
      historyArea.classList.remove('hidden');
      historyList.replaceChildren();
      historyPreview.classList.add('hidden');
      historyEmptyState.classList.toggle('hidden', historyData.length > 0);
      historySearchWrap.classList.toggle('hidden', historyData.length === 0);
      clearHistoryBtn.classList.toggle('hidden', historyData.length === 0);
      exportHistoryBtn.classList.toggle('hidden', historyData.length === 0);

      if (historyData.length === 0) {
        historyList.classList.add('hidden');
        historySearchEmptyState.classList.add('hidden');
        return;
      }

      const history = getFilteredHistory();
      historySearchEmptyState.classList.toggle('hidden', history.length > 0);
      historyList.classList.toggle('hidden', history.length === 0);

      history.forEach((item) => {
        const text = String(item.text || '');
        const source = getHistorySource(item);
        const historyItem = document.createElement('div');
        historyItem.className = 'history-item';
        historyItem.setAttribute('tabindex', '0');
        historyItem.setAttribute('role', 'button');
        historyItem.setAttribute('aria-label', `${OCRI18n.t('history_view_detail')}: ${text.substring(0, 30)}`);

        historyItem.innerHTML = `
          <div class="history-item-text"></div>
          <div class="history-item-meta">
            <div class="history-item-context">
              <div class="history-item-tags">
                <span class="history-tag history-provider"></span>
                <span class="history-tag history-language"></span>
                <span class="timestamp"></span>
              </div>
              <span class="history-source hidden"></span>
            </div>
            <div class="history-item-actions">
              <button class="history-copy-btn" type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </button>
              <button class="history-delete-btn" type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </button>
            </div>
          </div>
        `;

        const textElement = historyItem.querySelector('.history-item-text');
        textElement.textContent = text;
        textElement.title = text;
        historyItem.querySelector('.history-provider').textContent = providerLabels[item.provider]
          || item.provider
          || '-';
        historyItem.querySelector('.history-language').textContent = getLanguageLabel(item.language);
        historyItem.querySelector('.timestamp').textContent = formatHistoryTimestamp(item);
        const sourceElement = historyItem.querySelector('.history-source');
        if (source) {
          sourceElement.classList.remove('hidden');
          sourceElement.textContent = source;
          sourceElement.title = item.sourceUrl || source;
        }

        listenRow(historyItem, 'click', (event) => {
          if (event.target.closest('button')) return;
          showHistoryPreview(item);
        });
        listenRow(historyItem, 'keydown', (event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button')) {
            event.preventDefault();
            showHistoryPreview(item);
          }
        });

        const copyBtn = historyItem.querySelector('.history-copy-btn');
        copyBtn.title = OCRI18n.t('content_btn_copy');
        copyBtn.setAttribute('aria-label', OCRI18n.t('history_copy'));
        const deleteBtn = historyItem.querySelector('.history-delete-btn');
        deleteBtn.title = OCRI18n.t('history_delete');
        deleteBtn.setAttribute('aria-label', OCRI18n.t('history_delete'));
        listenRow(copyBtn, 'click', async (event) => {
          event.stopPropagation();
          try {
            await navigator.clipboard.writeText(text);
            announcePopupStatus(OCRI18n.t('a11y_copy_success'));
            copyBtn.classList.add('copied');
            schedule(() => copyBtn.classList.remove('copied'), 1500);
          } catch (error) {
            console.error('复制失败:', error);
            announcePopupStatus(OCRI18n.t('a11y_copy_failed'));
          }
        });

        listenRow(deleteBtn, 'click', async (event) => {
          event.stopPropagation();
          if (!confirm(OCRI18n.t('confirm_delete_history'))) return;

          try {
            const response = await chrome.runtime.sendMessage({
              action: 'deleteHistoryRecord',
              historyId: item.id
            });
            if (!response?.success) {
              throw new Error(response?.error || OCRI18n.t('msg_history_action_failed'));
            }
            historyData = historyData.filter((record) => record.id !== item.id);
            if (activePreviewId === item.id) activePreviewId = null;
            announcePopupStatus(OCRI18n.t('a11y_history_deleted'));
            renderHistory();
          } catch (error) {
            console.error('删除历史记录失败:', error);
            alert(OCRI18n.t('msg_history_action_failed'));
          }
        });

        historyList.appendChild(historyItem);
      });
    }

    /**
     * 从存储中加载历史记录。
     */
    const loadHistory = async () => {
      try {
        const result = await chrome.runtime.sendMessage({ action: 'listHistory' });
        if (!isActive()) return;
        if (!result?.success) {
          throw new Error(result?.error || 'History unavailable');
        }
        historyData = Array.isArray(result.records) ? result.records : [];
        renderHistory();
      } catch (error) {
        console.error('加载历史记录失败:', error);
        historyData = [];
        renderHistory();
      }
    };

    /**
     * 清空历史记录
     * @async
     * @returns {Promise<void>}
     */
    const clearHistory = async () => {
      if (confirm(OCRI18n.t('confirm_clear_history'))) {
        try {
          const response = await chrome.runtime.sendMessage({ action: 'clearHistory' });
          if (!response?.success) {
            throw new Error(response?.error || OCRI18n.t('msg_history_action_failed'));
          }
          announcePopupStatus(OCRI18n.t('a11y_history_cleared'));
          historyData = [];
          activePreviewId = null;
          historySearch.value = '';
          renderHistory();
        } catch (error) {
          console.error('清空历史记录失败:', error);
          alert(OCRI18n.t('msg_history_action_failed'));
        }
      }
    };

    /**
     * 将全部历史记录导出为可移植 JSON 文件。
     */
    const exportHistory = () => {
      if (historyData.length === 0) return;

      const exportData = {
        version: 1,
        exportDate: new Date().toISOString(),
        records: historyData.map((item) => ({
          id: item.id,
          text: item.text || '',
          timestamp: Number(item.timestamp) || null,
          provider: item.provider || '',
          language: item.language || 'auto',
          sourceTitle: item.sourceTitle || '',
          sourceUrl: item.sourceUrl || ''
        }))
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ocr-history-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      announcePopupStatus(OCRI18n.t('a11y_history_exported'));
    };


    function bind() {
      listen(historySearch, 'input', renderHistory);
      listen(exportHistoryBtn, 'click', exportHistory);

      // 清空历史按钮事件
      listen(clearHistoryBtn, 'click', clearHistory);

      // 关闭预览按钮事件
      listen(closePreviewBtn, 'click', hideHistoryPreview);

      // 预览复制按钮事件
      listen(previewCopyBtn, 'click', async () => {
        try {
          await navigator.clipboard.writeText(historyPreviewText.value);
          announcePopupStatus(OCRI18n.t('a11y_copy_success'));
          previewCopyBtn.textContent = OCRI18n.t('btn_copied');
          schedule(() => {
            previewCopyBtn.textContent = OCRI18n.t('btn_copy_all');
          }, 1500);
        } catch (err) {
          console.error('复制失败:', err);
          announcePopupStatus(OCRI18n.t('a11y_copy_failed'));
        }
      });


    }
    return { load: loadHistory, render: renderHistory, bind, destroy() {
      rowEvents.abort();
      historyData = [];
      activePreviewId = null;
    } };

  }
  return { create };
}));
