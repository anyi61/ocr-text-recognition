/**
 * @fileoverview popup.js - OCR文字识别助手弹出窗口逻辑
 * @description 处理弹出窗口的UI交互、历史记录显示和复制功能
 */

// popup.js - 弹出窗口逻辑
// 使用统一的 OCRI18n API（来自 i18n-runtime.js）

document.addEventListener('DOMContentLoaded', async () => {
  // 初始化 i18n
  await OCRI18n.init();
  OCRI18n.applyToDom(document);

  // 获取DOM元素
  const captureBtn = document.getElementById('captureBtn');
  const repeatCaptureBtn = document.getElementById('repeatCaptureBtn');
  const repeatCaptureHint = document.getElementById('repeatCaptureHint');
  const imageImportBtn = document.getElementById('imageImportBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const themeBtn = document.getElementById('themeBtn');
  const languageSelect = document.getElementById('languageSelect');
  const configTip = document.getElementById('configTip');
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
  const previewSaveBtn = document.getElementById('previewSaveBtn');
  const previewRevertBtn = document.getElementById('previewRevertBtn');
  const historyPreviewStatus = document.getElementById('historyPreviewStatus');
  const historyTranslation = document.getElementById('historyTranslation');
  const historyDraft = document.getElementById('historyDraft');
  const previewFavoriteBtn = document.getElementById('previewFavoriteBtn');
  const historyName = document.getElementById('historyName');
  const historyNameSaveBtn = document.getElementById('historyNameSaveBtn');
  const historyNameCancelBtn = document.getElementById('historyNameCancelBtn');
  const historyMetadataStatus = document.getElementById('historyMetadataStatus');
  const a11yLive = document.getElementById('a11y-live');

  /**
   * 统一的状态播报函数
   * @param {string} message - 播报文案
   */
  const announcePopupStatus = (message) => {
    if (a11yLive) {
      a11yLive.textContent = message;
    }
  };

  // 历史记录数据（用于点击查看）
  let historyData = [];
  let activePreviewId = null;
  let previewSavedText = '';
  let previewSaving = false;
  let previewTranslation = null;
  let previewDraft = null;
  let repeatAvailable = false;
  let previewSavedName = '';
  const pendingMetadata = new Set();
  const metadataVersions = new Map();
  let metadataVersion = 0;

  const destroyPreviewTranslation = () => {
    previewTranslation?.destroy();
    previewTranslation = null;
    previewDraft?.destroy();
    previewDraft = null;
  };
  window.addEventListener('pagehide', destroyPreviewTranslation);

  const hasPreviewChanges = () => activePreviewId !== null
    && historyPreviewText.value !== previewSavedText;

  const hasPreviewNameChanges = () => activePreviewId !== null
    && historyName.value !== previewSavedName;

  const updateMetadataControls = () => {
    const record = historyData.find((item) => item.id === activePreviewId);
    const busy = pendingMetadata.has(activePreviewId);
    const favorite = record?.favorite === true;
    previewFavoriteBtn.textContent = OCRI18n.t(favorite ? 'history_unfavorite' : 'history_favorite');
    previewFavoriteBtn.setAttribute('aria-pressed', String(favorite));
    previewFavoriteBtn.disabled = busy || !record;
    historyName.disabled = busy || !record;
    historyNameSaveBtn.disabled = busy || !record || !hasPreviewNameChanges();
    historyNameCancelBtn.disabled = busy || !hasPreviewNameChanges();
  };

  const updatePreviewSaveState = () => {
    previewSaveBtn.disabled = previewSaving || !historyPreviewText.value.trim() || !hasPreviewChanges();
    previewRevertBtn.disabled = previewSaving || !hasPreviewChanges();
    historyPreviewText.readOnly = previewSaving;
    closePreviewBtn.disabled = previewSaving;
    for (const control of [captureBtn, imageImportBtn, settingsBtn, configTip, clearHistoryBtn, exportHistoryBtn, languageSelect]) {
      control.disabled = previewSaving;
    }
    repeatCaptureBtn.disabled = previewSaving || !repeatAvailable;
  };

  const providerLabels = Object.freeze({
    claude: 'Claude',
    openai: 'OpenAI',
    baidu: 'Baidu OCR',
    aliyun: 'Aliyun',
    zhipu: 'Zhipu AI',
    'openai-compatible': 'OpenAI Compatible',
    custom: 'Custom API'
  });

  /**
   * 应用主题
   * @param {string} theme - 主题名称 (light|dark)
   */
  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    // 更新图标显示
    const lightIcon = themeBtn.querySelector('.theme-icon-light');
    const darkIcon = themeBtn.querySelector('.theme-icon-dark');
    if (theme === 'dark') {
      lightIcon.style.display = 'none';
      darkIcon.style.display = 'block';
    } else {
      lightIcon.style.display = 'block';
      darkIcon.style.display = 'none';
    }
  };

  /**
   * 切换主题
   */
  const toggleTheme = async () => {
    const currentTheme = document.documentElement.dataset.theme || 'light';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
    await chrome.storage.local.set({ theme: newTheme });
  };

  /**
   * 加载主题设置
   */
  const loadTheme = async () => {
    const result = await chrome.storage.local.get(['theme']);
    const theme = result.theme || 'light';
    applyTheme(theme);
  };

  // 检查是否已配置API（支持多API配置）
  const checkConfig = async () => {
    const result = await chrome.storage.local.get([
      'apiProvider', 'apiConfigs', 'apiKey',
      'compatibleEndpoint', 'compatibleApiKey', 'compatibleModel',
      'customEndpoint', 'customApiKey', 'customModel'
    ]);
    const provider = result.apiProvider || 'claude';

    // 共享映射会处理 openai-compatible 的存储键及旧版 Claude 配置。
    const hasApiKey = OCRProviderConfig.hasRequiredCredentials(
      result.apiConfigs,
      provider,
      result
    );

    if (!hasApiKey) {
      configTip.classList.remove('hidden');
      return false;
    }
    configTip.classList.add('hidden');
    return true;
  };

  /**
   * Requests access to a user-configured API origin when the selected provider
   * is not covered by the extension's fixed host permissions.
   */
  const requestEndpointPermission = async () => {
    const result = await chrome.storage.local.get([
      'apiProvider', 'apiConfigs',
      'compatibleEndpoint', 'compatibleApiKey', 'compatibleModel',
      'customEndpoint', 'customApiKey', 'customModel'
    ]);
    const provider = result.apiProvider || 'claude';

    if (provider !== 'openai-compatible' && provider !== 'custom') {
      return true;
    }

    const modernConfig = OCRProviderConfig.getProviderConfig(result.apiConfigs, provider);
    const legacyEndpoint = provider === 'openai-compatible'
      ? result.compatibleEndpoint
      : result.customEndpoint;
    return OCRExtensionRuntime.requestEndpointPermission(
      chrome,
      provider,
      modernConfig.endpoint || legacyEndpoint
    );
  };

  const getLanguageLabel = (language) => {
    const key = ['zh', 'en', 'ja', 'ko'].includes(language)
      ? `language_${language}`
      : 'language_auto';
    return OCRI18n.t(key);
  };

  const formatHistoryTimestamp = (item) => {
    const timestamp = Number(item?.timestamp);
    if (!Number.isFinite(timestamp)) {
      return String(item?.date || '');
    }
    const locale = OCRI18n.getResolvedLanguage() === 'en' ? 'en-US' : 'zh-CN';
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(timestamp));
  };

  const getHistorySource = (item) => (
    String(item?.sourceTitle || item?.sourceUrl || '').trim()
  );

  const getFilteredHistory = () => {
    const query = historySearch.value.trim().toLocaleLowerCase();
    if (!query) return [...historyData];

    return historyData.filter((item) => [
      item.name,
      item.text,
      item.provider,
      item.language,
      item.sourceTitle,
      item.sourceUrl,
      item.translation?.text,
      item.translation?.targetLanguage
    ].some((value) => String(value || '').toLocaleLowerCase().includes(query)));
  };

  /**
   * 显示历史详情预览
   * @param {Object} item - 历史记录
   */
  const showHistoryPreview = (item, { preserveDraft = false } = {}) => {
    const draft = preserveDraft ? historyPreviewText.value : null;
    const name = preserveDraft ? historyName.value : null;
    activePreviewId = item.id;
    previewSavedName = item.name || '';
    historyName.value = name ?? previewSavedName;
    historyMetadataStatus.textContent = '';
    updateMetadataControls();
    previewSavedText = item.text || '';
    historyPreviewText.value = draft ?? previewSavedText;
    historyPreviewStatus.textContent = '';
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
    historySearchWrap.classList.add('hidden');
    updatePreviewSaveState();
    if (preserveDraft && previewTranslation) {
      previewTranslation.refreshLabels();
      previewDraft?.refreshLabels?.();
    } else {
      destroyPreviewTranslation();
      previewTranslation = globalThis.OCRTranslationUI.mount({
        container: historyTranslation,
        sourceTextarea: historyPreviewText,
        idPrefix: 'history-translation',
        historyId: item.id,
        announce: announcePopupStatus,
        onPersisted: (translation) => {
          historyData = historyData.map((record) => record.id === item.id ? { ...record, translation } : record);
        },
        openSettings: () => openSettings()
      });
      previewDraft = globalThis.OCRDraftUI.mount({
        container: historyDraft,
        sourceTextarea: historyPreviewText,
        historyId: item.id,
        getSavedText: () => previewSavedText,
        onRestore: () => {
          previewTranslation?.notifySourceChanged();
          updatePreviewSaveState();
        },
        announce: announcePopupStatus
      });
    }
    if (!preserveDraft) historyPreviewText.focus();
  };

  /**
   * 隐藏历史详情预览
   */
  const hideHistoryPreview = () => {
    if (previewSaving || pendingMetadata.has(activePreviewId)) return false;
    if (hasPreviewChanges() && !confirm(OCRI18n.t('history_discard_changes'))) return false;
    if (hasPreviewNameChanges() && !confirm(OCRI18n.t('history_discard_name_changes'))) return false;
    const previousId = activePreviewId;
    activePreviewId = null;
    historyPreview.classList.add('hidden');
    renderHistory();
    [...historyList.children].find((item) => item.dataset.historyId === String(previousId))?.focus();
    return true;
  };

  const saveHistoryPreview = async () => {
    if (previewSaveBtn.disabled) return;
    const historyId = activePreviewId;
    const text = historyPreviewText.value.trim();
    previewSaving = true;
    historyPreviewStatus.textContent = '';
    updatePreviewSaveState();
    try {
      const response = await chrome.runtime.sendMessage({ action: 'updateHistoryRecord', historyId, text });
      if (!response?.success) throw new Error('History update failed');
      historyData = historyData.map((item) => item.id === historyId ? { ...item, text } : item);
      previewSavedText = text;
      historyPreviewText.value = text;
      previewTranslation?.notifySourceChanged();
      await previewDraft?.refresh();
      historyPreviewStatus.textContent = OCRI18n.t('content_msg_changes_saved');
    } catch (error) {
      console.error('保存历史修改失败:', error);
      historyPreviewStatus.textContent = OCRI18n.t('content_msg_changes_save_failed');
    } finally {
      previewSaving = false;
      updatePreviewSaveState();
    }
  };

  const saveHistoryMetadata = async (historyId, patch) => {
    if (pendingMetadata.has(historyId)) return false;
    const submittedVersions = { ...metadataVersions.get(historyId) };
    pendingMetadata.add(historyId);
    updateMetadataControls();
    if (activePreviewId === historyId) historyMetadataStatus.textContent = '';
    try {
      const response = await chrome.runtime.sendMessage({ action: 'updateHistoryMetadata', historyId, patch });
      if (!response?.success || !response.record) throw new Error('History metadata update failed');
      // Storage events can carry a newer write from another popup before this
      // request's acknowledgement arrives. Such fields already have their
      // latest value; apply response fields only when no event changed them.
      const latestVersions = metadataVersions.get(historyId) || {};
      const savedPatch = Object.fromEntries(Object.keys(patch)
        .filter((key) => latestVersions[key] === submittedVersions[key])
        .map((key) => [key, response.record[key]]));
      historyData = historyData.map((item) => item.id === historyId ? { ...item, ...savedPatch } : item);
      if (activePreviewId === historyId) {
        if ('name' in patch) {
          previewSavedName = historyData.find((item) => item.id === historyId)?.name || '';
          historyName.value = previewSavedName;
        }
        historyMetadataStatus.textContent = OCRI18n.t('history_metadata_saved');
      }
      announcePopupStatus(OCRI18n.t('history_metadata_saved'));
      return true;
    } catch (error) {
      console.error('保存历史信息失败:', error);
      if (activePreviewId === historyId) historyMetadataStatus.textContent = OCRI18n.t('msg_history_action_failed');
      announcePopupStatus(OCRI18n.t('msg_history_action_failed'));
      return false;
    } finally {
      pendingMetadata.delete(historyId);
      updateMetadataControls();
      if (activePreviewId === null) renderHistory();
    }
  };

  /**
   * 渲染当前历史记录及搜索结果。
   */
  function renderHistory() {
    destroyPreviewTranslation();
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
      historyItem.dataset.historyId = String(item.id);
      historyItem.setAttribute('tabindex', '0');
      historyItem.setAttribute('role', 'button');
      historyItem.setAttribute('aria-label', `${OCRI18n.t('history_view_detail')}: ${item.name || text.substring(0, 30)}`);

      historyItem.innerHTML = `
        <div class="history-item-name hidden"></div>
        <div class="history-item-text"></div>
        <div class="history-item-meta">
          <div class="history-item-context">
            <div class="history-item-tags">
              <span class="history-tag history-provider"></span>
              <span class="history-tag history-language"></span>
              <span class="history-tag history-draft-tag hidden"></span>
              <span class="timestamp"></span>
            </div>
            ${source ? '<span class="history-source"></span>' : ''}
          </div>
          <div class="history-item-actions">
            <button class="history-favorite-btn" type="button" aria-pressed="false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"></path>
              </svg>
            </button>
            <button class="history-copy-btn" type="button" title="${OCRI18n.t('content_btn_copy')}" aria-label="${OCRI18n.t('history_copy')}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
            <button class="history-delete-btn" type="button" title="${OCRI18n.t('history_delete')}" aria-label="${OCRI18n.t('history_delete')}">
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
      const nameElement = historyItem.querySelector('.history-item-name');
      nameElement.textContent = item.name || '';
      nameElement.classList.toggle('hidden', !item.name);
      const draftTag = historyItem.querySelector('.history-draft-tag');
      draftTag.textContent = OCRI18n.t('history_unfinished_draft');
      draftTag.classList.toggle('hidden', !(typeof item.draft?.text === 'string' && item.draft.text !== item.text));
      const favoriteBtn = historyItem.querySelector('.history-favorite-btn');
      const favorite = item.favorite === true;
      const favoriteLabel = OCRI18n.t(favorite ? 'history_unfavorite' : 'history_favorite');
      favoriteBtn.title = favoriteLabel;
      favoriteBtn.setAttribute('aria-label', favoriteLabel);
      favoriteBtn.setAttribute('aria-pressed', String(favorite));
      favoriteBtn.disabled = pendingMetadata.has(item.id);
      favoriteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        favoriteBtn.disabled = true;
        saveHistoryMetadata(item.id, { favorite: !favorite });
      });
      historyItem.querySelector('.history-provider').textContent = providerLabels[item.provider]
        || item.provider
        || '-';
      historyItem.querySelector('.history-language').textContent = getLanguageLabel(item.language);
      historyItem.querySelector('.timestamp').textContent = formatHistoryTimestamp(item);
      const sourceElement = historyItem.querySelector('.history-source');
      if (sourceElement) {
        sourceElement.textContent = source;
        sourceElement.title = item.sourceUrl || source;
      }

      historyItem.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        showHistoryPreview(historyData.find((record) => record.id === item.id) || item);
      });
      historyItem.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button')) {
          event.preventDefault();
          showHistoryPreview(historyData.find((record) => record.id === item.id) || item);
        }
      });

      const copyBtn = historyItem.querySelector('.history-copy-btn');
      copyBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          announcePopupStatus(OCRI18n.t('a11y_copy_success'));
          copyBtn.classList.add('copied');
          setTimeout(() => copyBtn.classList.remove('copied'), 1500);
        } catch (error) {
          console.error('复制失败:', error);
          announcePopupStatus(OCRI18n.t('a11y_copy_failed'));
        }
      });

      historyItem.querySelector('.history-delete-btn').addEventListener('click', async (event) => {
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
      const result = await chrome.storage.local.get(['ocrHistory']);
      historyData = Array.isArray(result.ocrHistory) ? result.ocrHistory : [];
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
  const exportHistory = async () => {
    if (previewSaving || historyData.length === 0) return;

    try {
      const result = await chrome.storage.local.get(['ocrHistory']);
      historyData = Array.isArray(result.ocrHistory) ? result.ocrHistory : [];
    } catch {
      announcePopupStatus(OCRI18n.t('msg_history_action_failed'));
      return;
    }

    const exportData = {
      version: 3,
      exportDate: new Date().toISOString(),
      records: historyData.map((item) => ({
        id: item.id,
        text: item.text || '',
        name: item.name || '',
        favorite: item.favorite === true,
        timestamp: Number(item.timestamp) || null,
        provider: item.provider || '',
        language: item.language || 'auto',
        sourceTitle: item.sourceTitle || '',
        sourceUrl: item.sourceUrl || '',
        ...(item.draft ? { draft: {
          text: item.draft.text,
          baseText: item.draft.baseText,
          updatedAt: item.draft.updatedAt
        } } : {}),
        ...(item.translation ? { translation: {
          sourceText: item.translation.sourceText,
          text: item.translation.text,
          targetLanguage: item.translation.targetLanguage,
          provider: item.translation.provider,
          model: item.translation.model,
          timestamp: item.translation.timestamp,
          stale: item.translation.sourceText !== item.text
        } } : {})
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

  // 初始化
  // 设置语言选择器当前值
  languageSelect.value = OCRI18n.getLanguageSetting();
  await loadTheme();
  await checkConfig();
  await loadHistory();
  const repeatMessageKey = (reason) => ({
    'viewport-changed': 'popup_repeat_viewport_changed',
    'page-changed': 'popup_repeat_page_changed',
    busy: 'popup_repeat_busy'
  }[reason] || 'popup_repeat_no_region');
  const refreshRepeatCapture = async () => {
    let state;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (Number.isInteger(tab?.id)) state = await chrome.tabs.sendMessage(tab.id, { action: 'getRepeatCaptureState' });
    } catch { /* The current page has no remembered selection. */ }
    repeatAvailable = Boolean(state?.success && state.available);
    repeatCaptureHint.textContent = OCRI18n.t(repeatAvailable ? 'popup_repeat_ready' : repeatMessageKey(state?.reason));
    updatePreviewSaveState();
  };
  refreshRepeatCapture();
  window.addEventListener('focus', refreshRepeatCapture);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.ocrHistory) return;
    const oldRecords = new Map((Array.isArray(changes.ocrHistory.oldValue) ? changes.ocrHistory.oldValue : [])
      .map((item) => [item.id, item]));
    const newRecords = new Map((Array.isArray(changes.ocrHistory.newValue) ? changes.ocrHistory.newValue : [])
      .map((item) => [item.id, item]));
    for (const id of new Set([...oldRecords.keys(), ...newRecords.keys()])) {
      const versions = metadataVersions.get(id) || {};
      for (const key of ['name', 'favorite']) {
        if (oldRecords.get(id)?.[key] !== newRecords.get(id)?.[key]) {
          versions[key] = ++metadataVersion;
        }
      }
      metadataVersions.set(id, versions);
    }
    historyData = Array.isArray(changes.ocrHistory.newValue) ? changes.ocrHistory.newValue : [];
    if (activePreviewId === null) renderHistory();
    else {
      const record = historyData.find((item) => item.id === activePreviewId);
      if (record && !hasPreviewNameChanges()) {
        previewSavedName = record.name || '';
        historyName.value = previewSavedName;
      }
      updateMetadataControls();
    }
  });

  // 主题切换按钮事件
  themeBtn.addEventListener('click', toggleTheme);

  // 语言切换事件
  languageSelect.addEventListener('change', async (e) => {
    const newLang = e.target.value;
    await OCRI18n.setLanguage(newLang);
    OCRI18n.applyToDom(document);
    const activeItem = historyData.find((item) => item.id === activePreviewId);
    if (activeItem) showHistoryPreview(activeItem, { preserveDraft: true });
    else renderHistory();
    refreshRepeatCapture();
  });

  historySearch.addEventListener('input', renderHistory);
  exportHistoryBtn.addEventListener('click', exportHistory);

  // 清空历史按钮事件
  clearHistoryBtn.addEventListener('click', clearHistory);

  // 关闭预览按钮事件
  closePreviewBtn.addEventListener('click', hideHistoryPreview);
  historyPreviewText.addEventListener('input', () => {
    historyPreviewStatus.textContent = '';
    previewTranslation?.notifySourceChanged();
    updatePreviewSaveState();
  });
  previewSaveBtn.addEventListener('click', saveHistoryPreview);
  previewFavoriteBtn.addEventListener('click', () => {
    const record = historyData.find((item) => item.id === activePreviewId);
    if (record) saveHistoryMetadata(record.id, { favorite: record.favorite !== true });
  });
  historyName.addEventListener('input', () => {
    historyMetadataStatus.textContent = '';
    updateMetadataControls();
  });
  const cancelHistoryName = () => {
    previewSavedName = historyData.find((item) => item.id === activePreviewId)?.name || '';
    historyName.value = previewSavedName;
    historyMetadataStatus.textContent = '';
    updateMetadataControls();
  };
  historyNameCancelBtn.addEventListener('click', cancelHistoryName);
  historyNameSaveBtn.addEventListener('click', () => {
    if (!historyNameSaveBtn.disabled) saveHistoryMetadata(activePreviewId, { name: historyName.value });
  });
  previewRevertBtn.addEventListener('click', () => {
    historyPreviewText.value = previewSavedText;
    previewTranslation?.notifySourceChanged();
    previewDraft?.notifySourceChanged();
    historyPreviewStatus.textContent = '';
    updatePreviewSaveState();
    historyPreviewText.focus();
  });
  document.addEventListener('keydown', (event) => {
    if (activePreviewId === null) return;
    if (event.target === historyName && (event.key === 'Escape' || event.key === 'Enter'
      || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's'))) {
      event.preventDefault();
      if (pendingMetadata.has(activePreviewId)) return;
      if (event.key === 'Escape') cancelHistoryName();
      else if (!historyNameSaveBtn.disabled) saveHistoryMetadata(activePreviewId, { name: historyName.value });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideHistoryPreview();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveHistoryPreview();
    }
  });

  // 预览复制按钮事件
  previewCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(historyPreviewText.value);
      announcePopupStatus(OCRI18n.t('a11y_copy_success'));
      previewCopyBtn.textContent = OCRI18n.t('btn_copied');
      setTimeout(() => {
        previewCopyBtn.textContent = OCRI18n.t('btn_copy_all');
      }, 1500);
    } catch (err) {
      console.error('复制失败:', err);
      announcePopupStatus(OCRI18n.t('a11y_copy_failed'));
      historyPreviewStatus.textContent = OCRI18n.t('history_copy_failed');
      historyPreviewText.focus();
      historyPreviewText.select();
    }
  });

  // 配置提示点击事件
  const openSettings = () => {
    if (activePreviewId !== null && !hideHistoryPreview()) return;
    chrome.runtime.openOptionsPage();
  };
  configTip.addEventListener('click', openSettings);
  settingsBtn.addEventListener('click', openSettings);

  // 开始截图识别
  const runCapture = async (repeat = false) => {
    if (activePreviewId !== null && !hideHistoryPreview()) return;
    // 检查配置
    const hasConfig = await checkConfig();
    if (!hasConfig) {
      announcePopupStatus(OCRI18n.t('a11y_config_missing'));
      alert(OCRI18n.t('msg_config_api_first'));
      return;
    }

    try {
      const permissionGranted = await requestEndpointPermission();
      if (!permissionGranted) {
        announcePopupStatus(OCRI18n.t('msg_endpoint_permission_denied'));
        alert(OCRI18n.t('msg_endpoint_permission_denied'));
        return;
      }

      // 获取当前活动标签页
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        alert(OCRI18n.t('msg_no_tab'));
        return;
      }

      // 发送消息；按需注入依赖和内容脚本后重试。
      if (repeat) {
        const result = await chrome.tabs.sendMessage(tab.id, { action: 'repeatCapture' });
        if (!result?.success) {
          if (result?.reason === 'cancelled') return;
          repeatAvailable = false;
          repeatCaptureHint.textContent = OCRI18n.t(repeatMessageKey(result?.reason));
          updatePreviewSaveState();
          return;
        }
      } else {
        await OCRExtensionRuntime.startCaptureInTab(chrome, tab);
      }

      // 关闭popup窗口
      window.close();
    } catch (error) {
      console.error('启动截图失败:', error);
      announcePopupStatus(OCRI18n.t('a11y_capture_start_failed'));
      if (error?.code === 'UNSUPPORTED_PAGE') {
        const key = error.reason === 'browser_store'
          ? 'msg_capture_browser_store'
          : error.reason === 'file_access'
            ? 'msg_capture_file_access'
            : 'msg_capture_browser_internal';
        alert(OCRI18n.t(key));
      } else {
        alert(OCRI18n.t('msg_capture_failed'));
      }
    }
  };
  captureBtn.addEventListener('click', () => runCapture());
  repeatCaptureBtn.addEventListener('click', () => runCapture(true));
  imageImportBtn.addEventListener('click', async () => {
    if (activePreviewId !== null && !hideHistoryPreview()) return;
    try {
      const result = await chrome.runtime.sendMessage({ action: 'openImageWorkspace' });
      if (!result?.success) throw new Error('Unable to open image workspace');
      window.close();
    } catch {
      announcePopupStatus(OCRI18n.t('popup_import_failed'));
    }
  });
});
