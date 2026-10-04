/** Recoverable history drafts, shared by extension pages and the capture dialog. */
(function initializeDraftUI(root) {
  'use strict';

  function createSession({ historyId, getText, getSavedText, setText, sendMessage,
    onChange, onRestore = () => {}, createOwnerId = () => root.crypto.randomUUID() }) {
    let destroyed = false;
    let paused = false;
    let revision = 0;
    let loadGeneration = 0;
    let observed = { text: getText(), baseText: getSavedText() };
    let storedDraft = null;
    let draftVersion = null;
    const ownerId = createOwnerId();
    let state = { status: historyId ? 'loading' : 'unavailable', draft: null, errorCode: '' };
    const publish = (patch) => {
      state = { ...state, ...patch };
      if (!destroyed) onChange({ ...state, draft: state.draft ? { ...state.draft } : null });
    };
    const error = (response) => response?.errorCode || 'HISTORY_WRITE_FAILED';
    const validDraft = (draft) => draft && typeof draft.text === 'string' && typeof draft.baseText === 'string';
    const publishWithoutStoredDraft = () => {
      // Reading or discarding a stored draft does not acknowledge different
      // local edits. Keep those edits visibly unsaved and eligible for retry.
      const unsaved = getText() !== getSavedText();
      publish({ status: unsaved ? 'error' : 'idle', draft: null,
        errorCode: unsaved ? 'HISTORY_WRITE_FAILED' : '' });
    };
    async function refresh() {
      if (destroyed || !historyId) return;
      const token = ++loadGeneration;
      const atRevision = revision;
      if (getText() === getSavedText()) observed = { text: getText(), baseText: getSavedText() };
      publish({ status: 'loading', errorCode: '' });
      try {
        const response = await sendMessage({ action: 'getHistoryRecord', historyId });
        if (destroyed || token !== loadGeneration || atRevision !== revision) return;
        if (!response?.success || !response.record) {
          publish({ status: 'error', errorCode: response?.errorCode || 'HISTORY_READ_FAILED' });
          return;
        }
        const draft = response.record.draft;
        storedDraft = validDraft(draft) ? { ...draft } : null;
        draftVersion = draft?.updatedAt ?? response.record.draftMeta?.updatedAt ?? null;
        if (response.record.text !== getSavedText()) {
          publish({ status: 'conflict', draft: null, errorCode: 'HISTORY_DRAFT_CONFLICT' });
        } else if (!storedDraft) publishWithoutStoredDraft();
        else if (storedDraft.text === getText() && getText() !== getSavedText()) {
          publish({ status: storedDraft.baseText === getSavedText() ? 'saved' : 'conflict', draft: null, errorCode: '' });
        } else {
          publish({ status: storedDraft.baseText === getSavedText() ? 'available' : 'available-conflict',
            draft: { ...storedDraft }, errorCode: '' });
        }
      } catch {
        if (!destroyed && token === loadGeneration && atRevision === revision) {
          publish({ status: 'error', errorCode: 'HISTORY_READ_FAILED' });
        }
      }
    }
    function notifySourceChanged(force = false) {
      if (destroyed || paused || !historyId) return Promise.resolve();
      const snapshot = { text: getText(), baseText: getSavedText() };
      if (!force && snapshot.text === observed.text && snapshot.baseText === observed.baseText) return Promise.resolve();
      // Updating the editor's saved baseline is a read-only operation. In
      // particular, it must not clear another window's newer stored draft.
      if (!force && snapshot.text === snapshot.baseText && observed.text === snapshot.text) {
        observed = snapshot;
        return Promise.resolve();
      }
      observed = snapshot;
      const token = ++revision;
      publish({ status: 'saving', draft: null, errorCode: '' });
      // Send immediately, before yielding: an extension popup can disappear
      // after its final input event, so a debounce or pagehide save loses text.
      let request;
      try {
        request = sendMessage({ action: 'saveHistoryDraft', historyId, ...snapshot,
          ownerId, expectedUpdatedAt: draftVersion });
      } catch {
        publish({ status: 'error', errorCode: 'HISTORY_WRITE_FAILED' });
        return Promise.resolve();
      }
      return Promise.resolve(request).then((response) => {
        if (destroyed || token !== revision) return;
        if (!response?.success) {
          publish({ status: response?.errorCode === 'HISTORY_DRAFT_CONFLICT' ? 'conflict' : 'error', errorCode: error(response) });
          return;
        }
        storedDraft = validDraft(response.draft) ? { ...response.draft } : null;
        draftVersion = response.draftUpdatedAt ?? response.draft?.updatedAt ?? draftVersion;
        publish({ status: storedDraft ? 'saved' : 'idle', draft: null, errorCode: '' });
      }).catch(() => {
        if (!destroyed && token === revision) publish({ status: 'error', errorCode: 'HISTORY_WRITE_FAILED' });
      });
    }
    function restore() {
      if (destroyed || paused || !state.draft || !['available', 'available-conflict'].includes(state.status)) return false;
      const text = state.draft.text;
      setText(text);
      notifySourceChanged();
      onRestore(text);
      return true;
    }
    async function discard() {
      if (destroyed || paused || !historyId || !storedDraft || ['saving', 'loading', 'discarding'].includes(state.status)) return false;
      const draft = { ...storedDraft };
      const text = getText();
      const token = ++revision;
      publish({ status: 'discarding', errorCode: '' });
      try {
        const response = await sendMessage({ action: 'discardHistoryDraft', historyId, ownerId,
          ...(Number.isFinite(draft.updatedAt) ? { expectedUpdatedAt: draft.updatedAt } : {}) });
        if (destroyed || token !== revision) return false;
        if (!response?.success) {
          publish({ status: response?.errorCode === 'HISTORY_DRAFT_CONFLICT' ? 'conflict' : 'error', errorCode: error(response) });
          return false;
        }
        storedDraft = null;
        draftVersion = response.draftUpdatedAt ?? null;
        if (text === draft.text && getText() === text) {
          setText(getSavedText());
          observed = { text: getText(), baseText: getSavedText() };
          onRestore(getText());
        }
        publishWithoutStoredDraft();
        return true;
      } catch {
        if (!destroyed && token === revision) publish({ status: 'error', errorCode: 'HISTORY_WRITE_FAILED' });
        return false;
      }
    }
    async function retry() {
      if (destroyed || paused) return;
      if (state.status === 'error' && getText() !== getSavedText()) {
        return notifySourceChanged(true);
      }
      await refresh();
      // A conflicting draft may have been discarded since our last attempt.
      // Retry only after the read confirms no competing draft and a matching
      // formal baseline. The revision check still protects subsequent writes.
      if (!destroyed && !storedDraft && state.status === 'error'
        && state.errorCode === 'HISTORY_WRITE_FAILED' && getText() !== getSavedText()) {
        return notifySourceChanged(true);
      }
    }
    const ready = refresh();
    return { ready, refresh, retry, notifySourceChanged, restore, discard,
      setPaused(value) {
        const wasPaused = paused;
        paused = Boolean(value);
        if (wasPaused && !paused) void notifySourceChanged();
      },
      getState: () => ({ ...state, draft: state.draft ? { ...state.draft } : null }),
      destroy() { destroyed = true; loadGeneration += 1; } };
  }

  function mount({ container, sourceTextarea, historyId, getSavedText, onRestore = () => {}, onConflict,
    announce = () => {}, transport }) {
    const documentApi = container.ownerDocument;
    const t = (key) => root.OCRI18n.t(key);
    const sendMessage = transport?.sendMessage || ((message) => root.chrome.runtime.sendMessage(message));
    const panel = documentApi.createElement('section');
    panel.dataset.draft = 'panel';
    panel.className = 'ocr-draft';
    const style = documentApi.createElement('style');
    style.textContent = `
      .ocr-draft { margin:8px 0; color:var(--text-secondary,#666); font:12px/1.5 system-ui,sans-serif; }
      .ocr-draft [hidden] { display:none !important; }
      .ocr-draft p { margin:4px 0; overflow-wrap:anywhere; }
      .ocr-draft button { margin:4px 6px 0 0; padding:6px 10px; border:1px solid var(--border,#aaa); border-radius:7px; color:var(--text-primary,#222); background:var(--bg-hover,#eee); font:inherit; cursor:pointer; }
      .ocr-draft button:disabled { opacity:.5; cursor:not-allowed; }
      .ocr-draft button:focus-visible { outline:2px solid var(--accent,#111); outline-offset:2px; }
      .ocr-draft:is([data-state=conflict],[data-state=error],[data-state=available-conflict]) { color:var(--text-primary,#222); font-weight:600; }
    `;
    const status = documentApi.createElement('p');
    status.dataset.draft = 'status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const restore = documentApi.createElement('button');
    restore.type = 'button';
    restore.dataset.draft = 'restore';
    const discard = documentApi.createElement('button');
    discard.type = 'button';
    discard.dataset.draft = 'discard';
    const retry = documentApi.createElement('button');
    retry.type = 'button';
    retry.dataset.draft = 'retry';
    const compare = documentApi.createElement('button');
    compare.type = 'button';
    compare.dataset.draft = 'compare';
    panel.append(style, status, restore, discard, retry, compare);
    container.replaceChildren(panel);
    let destroyed = false;
    let paused = false;
    let lastAnnouncement = '';
    const render = (state) => {
      if (destroyed) return;
      panel.dataset.state = state.status;
      const busy = paused || ['loading', 'saving', 'discarding'].includes(state.status);
      panel.setAttribute('aria-busy', String(busy));
      status.textContent = t(`draft_${state.status.replaceAll('-', '_')}`);
      restore.textContent = t('draft_restore');
      discard.textContent = t('draft_discard');
      retry.textContent = t('draft_retry');
      compare.textContent = t('conflict_compare');
      restore.hidden = !['available', 'available-conflict'].includes(state.status);
      discard.hidden = !['available', 'available-conflict', 'saved', 'discarding'].includes(state.status);
      retry.hidden = !['error', 'conflict'].includes(state.status);
      compare.hidden = !onConflict || !['error', 'conflict', 'available-conflict'].includes(state.status);
      for (const button of [restore, discard, retry, compare]) button.disabled = busy;
      if (!busy && status.textContent && lastAnnouncement !== status.textContent) {
        lastAnnouncement = status.textContent;
        announce(status.textContent);
      }
    };
    const session = createSession({ historyId, getText: () => sourceTextarea.value, getSavedText,
      setText: (text) => { sourceTextarea.value = text; }, sendMessage, onChange: render, onRestore });
    const onInput = () => session.notifySourceChanged();
    const onRestoreClick = (event) => {
      if (!event.isTrusted || restore.disabled || destroyed) return;
      if (session.restore()) sourceTextarea.focus();
    };
    const onDiscardClick = (event) => {
      if (event.isTrusted && !discard.disabled && !destroyed) session.discard();
    };
    const onRetryClick = (event) => {
      if (!event.isTrusted || retry.disabled || destroyed) return;
      session.retry();
    };
    const onCompareClick = (event) => {
      if (event.isTrusted && !compare.disabled && !destroyed) onConflict?.(session.getState());
    };
    sourceTextarea.addEventListener('input', onInput);
    restore.addEventListener('click', onRestoreClick);
    discard.addEventListener('click', onDiscardClick);
    retry.addEventListener('click', onRetryClick);
    compare.addEventListener('click', onCompareClick);
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      session.destroy();
      sourceTextarea.removeEventListener('input', onInput);
      restore.removeEventListener('click', onRestoreClick);
      discard.removeEventListener('click', onDiscardClick);
      retry.removeEventListener('click', onRetryClick);
      compare.removeEventListener('click', onCompareClick);
      documentApi.defaultView?.removeEventListener('pagehide', destroy);
      for (const button of [restore, discard, retry, compare]) button.disabled = true;
    };
    documentApi.defaultView?.addEventListener('pagehide', destroy);
    render(session.getState());
    return { ready: session.ready, notifySourceChanged: session.notifySourceChanged,
      refresh: session.refresh, discard: session.discard, destroy,
      setPaused(value) { paused = Boolean(value); session.setPaused(paused); render(session.getState()); },
      refreshLabels: () => render(session.getState()) };
  }

  const api = Object.freeze({ mount, createSession });
  root.OCRDraftUI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
