/** Compare saved text without replacing local edits or bypassing history CAS. */
(function initializeConflictUI(root) {
  'use strict';

  function createSession({ getHistoryId, getText, sendMessage, onChange = () => {},
    onRebase = () => {}, onSavedAsNew = () => {}, onBusyChange = () => {} }) {
    let destroyed = false;
    let readGeneration = 0;
    let writeGeneration = 0;
    let externalBusy = false;
    let state = { visible: false, status: 'idle', record: null, sourceId: null, saving: false };
    const current = (id) => !destroyed && getHistoryId() === id;
    const publish = (patch) => {
      state = { ...state, ...patch };
      if (!destroyed) onChange({ ...state, externalBusy });
    };
    async function refresh() {
      if (destroyed) return;
      const sourceId = getHistoryId();
      const token = ++readGeneration;
      publish({ visible: true, status: 'loading', sourceId,
        ...(sourceId !== state.sourceId ? { record: null } : {}) });
      try {
        const response = await sendMessage({ action: 'getHistoryRecord', historyId: sourceId });
        if (!current(sourceId) || token !== readGeneration) return;
        if ((response?.success && !response.record)
          || ['HISTORY_NOT_FOUND', 'HISTORY_RECORD_MISSING'].includes(response?.errorCode)) {
          publish({ status: 'missing', record: null });
        } else if (!response?.success || typeof response.record?.text !== 'string') {
          publish({ status: 'read-error' });
        } else publish({ status: 'ready', record: { ...response.record } });
      } catch {
        if (current(sourceId) && token === readGeneration) publish({ status: 'read-error' });
      }
    }
    function close() {
      readGeneration += 1;
      publish({ visible: false });
    }
    function rebase() {
      if (destroyed || externalBusy || state.saving || !state.visible
        || state.status !== 'ready' || !state.record || !current(state.sourceId)) return false;
      // The host adopts only this saved baseline. The live textarea is never
      // assigned here, and the next formal save still compares this baseline.
      onRebase({ ...state.record });
      close();
      return true;
    }
    async function saveAsNew() {
      if (destroyed || externalBusy || state.saving || !state.visible) return false;
      const submittedText = getText();
      const text = submittedText.trim();
      if (!text) return false;
      const sourceId = getHistoryId();
      const token = ++writeGeneration;
      onBusyChange(true);
      publish({ saving: true });
      try {
        const response = await sendMessage({ action: 'saveHistoryAsNew', sourceId, text });
        if (!current(sourceId) || token !== writeGeneration) return false;
        if (!response?.success || !response.record?.id || typeof response.record.text !== 'string') {
          publish({ status: 'save-error' });
          return false;
        }
        // A close only hides comparison. A successful explicit save still
        // associates its new record, preserving any input typed while waiting.
        onSavedAsNew({ ...response.record }, submittedText);
        close();
        return true;
      } catch {
        if (current(sourceId) && token === writeGeneration) publish({ status: 'save-error' });
        return false;
      } finally {
        if (!destroyed && token === writeGeneration) {
          publish({ saving: false });
          onBusyChange(false);
        }
      }
    }
    return { open: refresh, refresh, close, rebase, saveAsNew,
      setBusy(value) { if (externalBusy !== Boolean(value)) { externalBusy = Boolean(value); publish({}); } },
      getState: () => ({ ...state, externalBusy }),
      destroy() { destroyed = true; readGeneration += 1; writeGeneration += 1; } };
  }

  function mount({ container, sourceTextarea, getHistoryId, onRebase, onSavedAsNew,
    onBusyChange, announce = () => {}, transport }) {
    const documentApi = container.ownerDocument;
    const t = (key) => root.OCRI18n.t(key);
    const panel = documentApi.createElement('section');
    panel.className = 'ocr-conflict';
    panel.dataset.conflict = 'panel';
    panel.hidden = true;
    const style = documentApi.createElement('style');
    style.textContent = `
      .ocr-conflict { margin:12px 0; padding:12px; border:1px solid var(--border,#aaa); border-radius:8px; color:var(--text-primary,#222); font:12px/1.5 system-ui,sans-serif; }
      .ocr-conflict[hidden], .ocr-conflict [hidden] { display:none !important; }
      .ocr-conflict p { margin:4px 0 8px; overflow-wrap:anywhere; }
      .ocr-conflict textarea { box-sizing:border-box; width:100%; min-height:100px; padding:8px; color:inherit; background:var(--bg-sub,#f7f7f7); border:1px solid var(--border,#aaa); border-radius:5px; font:inherit; resize:vertical; }
      .ocr-conflict button { margin:6px 6px 0 0; padding:6px 10px; color:inherit; background:var(--bg-hover,#eee); border:1px solid var(--border,#aaa); border-radius:6px; font:inherit; cursor:pointer; }
      .ocr-conflict button:disabled { opacity:.5; cursor:not-allowed; }
      .ocr-conflict button:focus-visible { outline:2px solid var(--accent,#111); outline-offset:2px; }
    `;
    const heading = documentApi.createElement('strong');
    const description = documentApi.createElement('p');
    const status = documentApi.createElement('p');
    status.dataset.conflict = 'status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const latest = documentApi.createElement('textarea');
    latest.dataset.conflict = 'latest'; latest.readOnly = true; latest.dir = 'auto';
    const buttons = {};
    for (const action of ['refresh', 'rebase', 'save-new', 'close']) {
      const button = documentApi.createElement('button');
      button.type = 'button'; button.dataset.conflict = action;
      buttons[action] = button;
    }
    panel.append(style, heading, description, status, latest, ...Object.values(buttons));
    container.replaceChildren(panel);
    let destroyed = false;
    let lastAnnouncement = '';
    const render = (state) => {
      if (destroyed) return;
      panel.hidden = !state.visible;
      panel.dataset.state = state.saving ? 'saving' : state.status;
      panel.setAttribute('aria-busy', String(state.saving || state.status === 'loading'));
      heading.textContent = t('conflict_title');
      description.textContent = t('conflict_local_preserved');
      const key = state.saving ? 'conflict_saving' : `conflict_${state.status.replaceAll('-', '_')}`;
      status.textContent = t(key);
      latest.hidden = !state.record;
      latest.value = state.record?.text || '';
      latest.setAttribute('aria-label', t('conflict_latest_label'));
      for (const [action, button] of Object.entries(buttons)) {
        button.textContent = t(`conflict_${action.replace('-', '_')}`);
      }
      buttons.refresh.disabled = state.saving || state.status === 'loading';
      buttons.rebase.disabled = state.externalBusy || state.saving || state.status !== 'ready';
      buttons['save-new'].disabled = state.externalBusy || state.saving || !sourceTextarea.value.trim();
      if (state.visible && status.textContent !== lastAnnouncement) {
        lastAnnouncement = status.textContent; announce(status.textContent);
      }
    };
    const session = createSession({ getHistoryId, getText: () => sourceTextarea.value,
      sendMessage: transport?.sendMessage || ((message) => root.chrome.runtime.sendMessage(message)),
      onChange: render, onRebase, onSavedAsNew, onBusyChange });
    const listeners = [];
    for (const [action, button] of Object.entries(buttons)) {
      const listener = (event) => {
        if (!event.isTrusted || button.disabled || destroyed) return;
        if (action === 'save-new') void session.saveAsNew();
        else if (action === 'rebase') { if (session.rebase()) sourceTextarea.focus({ preventScroll: true }); }
        else if (action === 'close') { session.close(); sourceTextarea.focus({ preventScroll: true }); }
        else void session.refresh();
      };
      button.addEventListener('click', listener); listeners.push([button, 'click', listener]);
    }
    const onInput = () => render(session.getState());
    sourceTextarea.addEventListener('input', onInput);
    listeners.push([sourceTextarea, 'input', onInput]);
    render(session.getState());
    return { open: session.open, close: session.close, setBusy: session.setBusy,
      refreshLabels: () => render(session.getState()),
      destroy() {
        if (destroyed) return;
        destroyed = true; session.destroy();
        for (const [node, event, listener] of listeners) node.removeEventListener(event, listener);
      } };
  }

  const api = Object.freeze({ mount, createSession });
  root.OCRConflictUI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
