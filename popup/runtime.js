/** Pure history helpers for the popup. */
(function initializePopupRuntime(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRPopupRuntime = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPopupRuntime() {
  'use strict';

  function getHistorySource(item) {
    return String(item?.sourceTitle || item?.sourceUrl || '').trim();
  }

  function filterHistory(history, query) {
    const normalized = String(query || '').trim().toLocaleLowerCase();
    if (!normalized) return [...history];
    return history.filter((item) => [
      item.text,
      item.provider,
      item.language,
      item.sourceTitle,
      item.sourceUrl
    ].some((value) => String(value || '').toLocaleLowerCase().includes(normalized)));
  }

  function formatHistoryTimestamp(item, language) {
    const timestamp = Number(item?.timestamp);
    if (!Number.isFinite(timestamp)) return String(item?.date || '');
    return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(timestamp));
  }

  return Object.freeze({ getHistorySource, filterHistory, formatHistoryTimestamp });
}));
