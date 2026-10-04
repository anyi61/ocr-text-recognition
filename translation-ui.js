/** Shared, explicit text translation UI for extension pages and closed shadow DOM. */
(function initializeTranslationUI(root) {
  'use strict';

  const LANGUAGES = ['zh_CN', 'zh_TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'ar'];
  const PROVIDERS = {
    claude: 'Claude', openai: 'OpenAI', baidu: 'Baidu OCR', aliyun: 'Aliyun',
    zhipu: 'Zhipu AI', 'openai-compatible': 'OpenAI Compatible', custom: 'Custom API'
  };
  const DEFAULT_PREFERENCES = Object.freeze({ provider: 'claude', targetLanguage: 'zh_CN' });

  // UI documents cannot read trusted extension storage. Only explicit changes
  // cross the message bridge; historical selections stay local to their panel.
  function createPreferenceSession({ sendMessage, onLoad = () => {}, onStatus = () => {} }) {
    const revisions = { provider: 0, targetLanguage: 0 };
    const dirty = new Map();
    const failed = new Set();
    let pending = 0;
    let loadFailed = false;
    let loadGeneration = 0;
    let keepVisibleSelection = false;
    let destroyed = false;
    const publish = () => {
      if (!destroyed) onStatus({ pending: pending > 0,
        error: failed.size ? 'save' : loadFailed ? 'load' : '' });
    };
    const valid = (key, value) => key === 'provider'
      ? Object.prototype.hasOwnProperty.call(PROVIDERS, value) : LANGUAGES.includes(value);
    async function load() {
      const token = ++loadGeneration;
      try {
        const result = await sendMessage({ action: 'getTranslationPreferences' });
        if (destroyed || token !== loadGeneration) return;
        if (!result?.success || !result.preferences) throw new Error('Preferences unavailable');
        const patch = {};
        for (const key of Object.keys(DEFAULT_PREFERENCES)) {
          if (!keepVisibleSelection && revisions[key] === 0) patch[key] = valid(key, result.preferences[key])
            ? result.preferences[key] : DEFAULT_PREFERENCES[key];
        }
        loadFailed = false;
        onLoad(patch);
      } catch {
        if (destroyed || token !== loadGeneration) return;
        loadFailed = true;
      }
      publish();
    }
    async function change(patch) {
      if (destroyed) return false;
      const preferences = {};
      const versions = {};
      for (const key of Object.keys(DEFAULT_PREFERENCES)) {
        if (!Object.prototype.hasOwnProperty.call(patch, key) || !valid(key, patch[key])) continue;
        preferences[key] = patch[key];
        versions[key] = ++revisions[key];
        dirty.set(key, patch[key]);
        failed.delete(key);
      }
      if (!Object.keys(preferences).length) return false;
      pending += 1;
      publish();
      try {
        // Dispatch immediately so closing a panel does not abandon user intent.
        // The background serializes all patches, including other panels' writes.
        const result = await sendMessage({ action: 'saveTranslationPreferences', preferences });
        if (!result?.success) throw new Error('Preferences were not saved');
        for (const key of Object.keys(preferences)) {
          if (versions[key] === revisions[key]) {
            dirty.delete(key);
            failed.delete(key);
          }
        }
        return true;
      } catch {
        for (const key of Object.keys(preferences)) {
          if (versions[key] === revisions[key]) failed.add(key);
        }
        return false;
      } finally {
        pending -= 1;
        publish();
      }
    }
    return {
      load, change,
      retry: () => Promise.all([loadFailed ? load() : Promise.resolve(),
        dirty.size ? change(Object.fromEntries(dirty)) : Promise.resolve()]),
      // A translation started with the visible selections must not be replaced
      // by a late preference read, even when neither selector was changed.
      keepCurrent: () => { keepVisibleSelection = true; },
      destroy: () => { destroyed = true; loadGeneration += 1; }
    };
  }

  function createSession({ getSnapshot, connect, onChange, onPersisted = () => {},
    createRequestId = () => root.crypto.randomUUID() }) {
    let port = null;
    let request = null;
    let generation = 0;
    let destroyed = false;
    let observed = getSnapshot();
    let state = { status: 'idle', text: '', errorCode: '', provider: '', model: '', targetLanguage: '',
      sourceText: '', timestamp: '', persisted: false };
    const same = (left, right) => left.text === right.text
      && left.provider === right.provider && left.targetLanguage === right.targetLanguage;
    // The last request can fail or be cancelled while the retained result is
    // still valid. Keep its usability separate from the request lifecycle.
    const hasCurrentResult = (snapshot = getSnapshot()) => Boolean(state.text)
      && same(snapshot, { text: state.sourceText, provider: state.provider, targetLanguage: state.targetLanguage });
    const getState = () => ({ ...state, canCopy: hasCurrentResult() });
    const publish = (patch) => {
      state = { ...state, ...patch };
      if (!destroyed) onChange(getState());
    };
    const cancelRequest = () => {
      generation += 1;
      const pending = request;
      request = null;
      if (pending && port) {
        try { port.postMessage({ action: 'cancel', requestId: pending.id }); } catch { /* Disconnected already. */ }
      }
      return Boolean(pending);
    };
    const onMessage = (message) => {
      const pending = request;
      if (destroyed || !pending || message?.action !== 'translationResult'
        || message.requestId !== pending.id || pending.generation !== generation) return;
      if (!same(getSnapshot(), pending.snapshot)) {
        notifySourceChanged();
        return;
      }
      request = null;
      if ((message.provider && message.provider !== pending.snapshot.provider)
        || (message.targetLanguage && message.targetLanguage !== pending.snapshot.targetLanguage)) {
        publish({ status: 'error', errorCode: 'TRANSLATION_RESULT_INVALID' });
        return;
      }
      if (message.success && typeof message.text === 'string' && message.text.trim()) {
        const translation = message.translation || { text: message.text, sourceText: pending.snapshot.text,
          provider: message.provider || pending.snapshot.provider, model: message.model || '',
          targetLanguage: message.targetLanguage || pending.snapshot.targetLanguage, timestamp: '' };
        if (translation.text !== message.text || translation.sourceText !== pending.snapshot.text
          || translation.provider !== pending.snapshot.provider || translation.targetLanguage !== pending.snapshot.targetLanguage) {
          publish({ status: 'error', errorCode: 'TRANSLATION_RESULT_INVALID' });
          return;
        }
        publish({ status: 'success', text: message.text, errorCode: '',
          provider: translation.provider, model: translation.model || '', sourceText: translation.sourceText,
          targetLanguage: translation.targetLanguage, timestamp: translation.timestamp || '', persisted: message.persisted === true });
        if (message.persisted === true) onPersisted({ ...translation });
      } else {
        publish({ status: message.cancelled ? 'cancelled' : 'error',
          errorCode: message.errorCode || 'TRANSLATION_RESULT_INVALID' });
      }
    };
    const onDisconnect = () => {
      port = null;
      if (!destroyed && request) {
        request = null;
        generation += 1;
        publish({ status: 'error', errorCode: 'TRANSLATION_CONNECTION_LOST' });
      }
    };
    function notifySourceChanged(force = false) {
      if (destroyed) return;
      const snapshot = getSnapshot();
      if (!force && same(observed, snapshot)) return;
      observed = snapshot;
      const wasPending = cancelRequest();
      publish({ status: hasCurrentResult(snapshot) ? 'success' : state.text || wasPending ? 'stale' : 'idle', errorCode: '' });
    }
    return {
      getState,
      notifySourceChanged,
      restore(translation) {
        if (destroyed || request || !translation || typeof translation.text !== 'string' || !translation.text.trim()
          || typeof translation.sourceText !== 'string' || !LANGUAGES.includes(translation.targetLanguage)
          || !Object.prototype.hasOwnProperty.call(PROVIDERS, translation.provider)) return false;
        observed = getSnapshot();
        publish({ status: same(observed, { text: translation.sourceText, provider: translation.provider,
          targetLanguage: translation.targetLanguage }) ? 'success' : 'stale', text: translation.text,
        sourceText: translation.sourceText, provider: translation.provider, model: translation.model || '',
        targetLanguage: translation.targetLanguage, timestamp: translation.timestamp || '', persisted: true, errorCode: '' });
        return true;
      },
      start() {
        if (destroyed || request) return false;
        observed = getSnapshot();
        try {
          if (!port) {
            port = connect();
            port.onMessage.addListener(onMessage);
            port.onDisconnect.addListener(onDisconnect);
          }
          const id = createRequestId();
          request = { id, generation: ++generation, snapshot: { ...observed } };
          publish({ status: 'translating', errorCode: '' });
          port.postMessage({ action: 'translate', requestId: id, ...observed });
          return true;
        } catch {
          request = null;
          if (port) {
            port.onMessage.removeListener(onMessage);
            port.onDisconnect.removeListener(onDisconnect);
            try { port.disconnect(); } catch { /* Already disconnected. */ }
            port = null;
          }
          publish({ status: 'error', errorCode: 'TRANSLATION_CONNECTION_LOST' });
          return false;
        }
      },
      cancel() {
        if (destroyed) return;
        if (cancelRequest()) publish({ status: 'cancelled', errorCode: '' });
      },
      destroy() {
        if (destroyed) return;
        cancelRequest();
        destroyed = true;
        if (port) {
          port.onMessage.removeListener(onMessage);
          port.onDisconnect.removeListener(onDisconnect);
          try { port.disconnect(); } catch { /* Already disconnected. */ }
          port = null;
        }
      }
    };
  }

  function mount({ container, sourceTextarea, idPrefix = 'ocr-translation', transport, historyId,
    announce = () => {}, openSettings, onPersisted = () => {} }) {
    const documentApi = container.ownerDocument;
    const i18n = root.OCRI18n;
    const t = (key, values) => i18n.t(key, values);
    const bridge = transport || {
      sendMessage: (message) => root.chrome.runtime.sendMessage(message),
      connect: () => root.chrome.runtime.connect({ name: 'ocr-translation' })
    };
    let destroyed = false;
    let capabilities = null;
    let loading = true;
    let historyLoading = Boolean(historyId);
    let historyLoadFailed = false;
    let capabilitiesError = false;
    let loadGeneration = 0;
    let localStatus = '';
    let statusAnnouncement = '';
    let selectionGeneration = 0;
    let preferenceStatus = { pending: false, error: '' };
    let uiGeneration = 0;
    const listeners = [];
    const listen = (element, name, callback) => {
      element.addEventListener(name, callback);
      listeners.push(() => element.removeEventListener(name, callback));
    };
    const make = (tag, control, className) => {
      const element = documentApi.createElement(tag);
      if (control) element.dataset.translation = control;
      if (className) element.className = className;
      return element;
    };
    const section = make('section', 'panel', 'ocr-translation');
    section.setAttribute('aria-labelledby', `${idPrefix}-heading`);
    const style = documentApi.createElement('style');
    style.textContent = `
      .ocr-translation { margin-top:16px; padding-top:16px; border-top:1px solid var(--border,#ddd); color:var(--text-primary,#222); font:13px/1.5 system-ui,sans-serif; min-width:0; }
      .ocr-translation [hidden] { display:none !important; }
      .ocr-translation h3 { font-size:14px; margin:0 0 8px; }
      .ocr-translation p { margin:7px 0; overflow-wrap:anywhere; }
      .ocr-translation .translation-notice { color:var(--text-secondary,#666); font-size:12px; }
      .ocr-translation-source-label { display:block; margin-bottom:6px; color:var(--text-primary,#222); font-size:13px; font-weight:600; }
      .ocr-translation .translation-fields { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:10px 0; }
      .ocr-translation label { display:block; font-weight:600; }
      .ocr-translation select, .ocr-translation textarea { box-sizing:border-box; width:100%; min-width:0; padding:8px; margin-top:4px; border:1px solid var(--border,#aaa); border-radius:8px; background:var(--bg-sub,#f5f5f7); color:var(--text-primary,#222); font:inherit; }
      .ocr-translation textarea { height:125px; min-height:70px; resize:vertical; font-weight:400; }
      .ocr-translation .translation-actions { display:flex; gap:8px; flex-wrap:wrap; }
      .ocr-translation button { border:1px solid var(--border,#aaa); border-radius:8px; padding:8px 12px; background:var(--bg-hover,#eee); color:var(--text-primary,#222); font:inherit; cursor:pointer; }
      .ocr-translation [data-translation=start] { background:var(--accent,#111); color:var(--accent-inverse,#fff); }
      .ocr-translation button:disabled { opacity:.5; cursor:not-allowed; }
      .ocr-translation :is(button,select,textarea):focus-visible { outline:2px solid var(--accent,#111); outline-offset:2px; }
      .ocr-translation [data-translation=status] { min-height:1.5em; font-size:12px; }
      .ocr-translation[data-state=error] [data-translation=status], .ocr-translation[data-state=stale] [data-translation=status] { font-weight:600; }
    `;
    const heading = make('h3', 'heading');
    heading.id = `${idPrefix}-heading`;
    const notice = make('p', 'notice', 'translation-notice');
    const summary = make('p', 'summary');
    const fields = make('div', null, 'translation-fields');
    const providerLabel = make('label');
    const providerCaption = make('span');
    const provider = make('select', 'provider');
    provider.id = `${idPrefix}-provider`;
    providerLabel.htmlFor = provider.id;
    providerLabel.append(providerCaption, provider);
    const targetLabel = make('label');
    const targetCaption = make('span');
    const target = make('select', 'target');
    target.id = `${idPrefix}-target`;
    targetLabel.htmlFor = target.id;
    targetLabel.append(targetCaption, target);
    fields.append(providerLabel, targetLabel);
    const actions = make('div', null, 'translation-actions');
    const start = make('button', 'start');
    const cancel = make('button', 'cancel');
    const settings = make('button', 'settings');
    for (const button of [start, cancel, settings]) button.type = 'button';
    actions.append(start, cancel, settings);
    const status = make('p', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const preferencesStatus = make('p', 'preferences-status');
    preferencesStatus.setAttribute('role', 'status');
    preferencesStatus.setAttribute('aria-live', 'polite');
    const preferencesRetry = make('button', 'preferences-retry');
    preferencesRetry.type = 'button';
    const output = make('div', 'output');
    const outputLabel = make('label');
    const outputCaption = make('span');
    const outputMeta = make('p', 'result-meta', 'translation-notice');
    const translated = make('textarea', 'text');
    translated.id = `${idPrefix}-text`;
    translated.readOnly = true;
    translated.dir = 'auto';
    outputLabel.htmlFor = translated.id;
    outputLabel.append(outputCaption, translated);
    const copy = make('button', 'copy');
    copy.type = 'button';
    output.append(outputLabel, outputMeta, copy);
    section.append(style, heading, notice, summary, fields, preferencesStatus, preferencesRetry, actions, status, output);
    container.replaceChildren(section);
    const sourceLabel = make('label', 'source-label', 'ocr-translation-source-label');
    if (!sourceTextarea.id) sourceTextarea.id = `${idPrefix}-source`;
    sourceLabel.htmlFor = sourceTextarea.id;
    sourceTextarea.before(sourceLabel);

    const snapshot = () => ({ text: sourceTextarea.value, provider: provider.value, targetLanguage: target.value,
      ...(historyId ? { historyId } : {}) });
    const session = createSession({ getSnapshot: snapshot, connect: () => bridge.connect(), onPersisted, onChange: () => {
      uiGeneration += 1;
      localStatus = '';
      render();
    } });
    const preferences = createPreferenceSession({
      sendMessage: (message) => bridge.sendMessage(message),
      onLoad: (patch) => {
        if (patch.provider) provider.value = patch.provider;
        if (patch.targetLanguage) target.value = patch.targetLanguage;
        session.notifySourceChanged();
        render();
      },
      onStatus: (state) => { preferenceStatus = state; render(); }
    });
    function selectedProvider() {
      return capabilities?.providers?.find((item) => item.id === provider.value);
    }
    function blockedReason() {
      if (loading || historyLoading) return 'translation_loading';
      if (capabilitiesError) return 'translation_capabilities_failed';
      const selected = selectedProvider();
      if (!selected || !selected.supported) return 'translation_provider_unsupported';
      if (!selected.configured) return 'translation_provider_unconfigured';
      if (!selected.permissionGranted) return 'translation_permission_required';
      if (!sourceTextarea.value.trim()) return 'translation_empty_source';
      if ([...sourceTextarea.value].length > (capabilities?.maxCharacters || 12000)) return 'translation_too_long';
      if (!target.value) return 'translation_choose_target';
      return '';
    }
    function render() {
      if (destroyed) return;
      const state = session.getState();
      const blocked = blockedReason();
      const busy = state.status === 'translating';
      section.dataset.state = state.status;
      section.setAttribute('aria-busy', String(busy || loading || historyLoading));
      start.disabled = Boolean(blocked) || busy;
      cancel.hidden = !busy;
      provider.disabled = loading;
      target.disabled = loading;
      preferencesStatus.hidden = !preferenceStatus.error;
      preferencesStatus.textContent = preferenceStatus.error
        ? t(preferenceStatus.error === 'save' ? 'translation_preferences_save_failed' : 'translation_preferences_load_failed') : '';
      preferencesRetry.hidden = !preferenceStatus.error;
      preferencesRetry.disabled = preferenceStatus.pending;
      settings.hidden = !capabilitiesError
        && !['translation_provider_unsupported', 'translation_provider_unconfigured', 'translation_permission_required'].includes(blocked)
        && !['TRANSLATION_PROVIDER_UNSUPPORTED', 'TRANSLATION_PROVIDER_UNCONFIGURED', 'TRANSLATION_PERMISSION_REQUIRED'].includes(state.errorCode);
      output.hidden = !state.text;
      if (translated.value !== state.text) translated.value = state.text;
      translated.lang = state.targetLanguage.replaceAll('_', '-');
      outputCaption.textContent = state.text
        ? t('translation_output_summary', [t(`translation_language_${state.targetLanguage}`), PROVIDERS[state.provider] || state.provider])
        : t('translation_output_label');
      outputMeta.textContent = state.model ? t('translation_result_model', [state.model]) : '';
      if (state.persisted) outputMeta.textContent += `${outputMeta.textContent ? ' · ' : ''}${t('translation_saved')}`;
      outputMeta.hidden = !outputMeta.textContent;
      copy.disabled = !state.canCopy;
      const selected = selectedProvider();
      summary.textContent = t('translation_provider_summary', [PROVIDERS[provider.value] || provider.value || '—', selected?.model || '—']);
      let message = localStatus;
      if (!message && busy) message = t('translation_working');
      if (!message && state.status === 'stale') message = t('translation_stale');
      if (!message && state.status === 'cancelled') message = t('translation_cancelled');
      if (!message && state.status === 'error') message = state.errorCode === 'TRANSLATION_CONNECTION_LOST'
        ? t('translation_connection_lost') : i18n.errorMessage({ errorCode: state.errorCode });
      if (blocked && !busy && !localStatus && state.status !== 'success') {
        const explanation = t(blocked, [String(capabilities?.maxCharacters || 12000)]);
        message = message ? `${message} ${explanation}` : explanation;
      }
      if (!message && state.status === 'success') message = t(state.persisted ? 'translation_done_saved' : 'translation_done_unsaved');
      if (!message && historyLoadFailed) message = t('translation_history_failed');
      status.textContent = message;
      if (message && message !== statusAnnouncement) {
        statusAnnouncement = message;
        announce(message);
      }
    }
    function refreshLabels(preferredProvider = provider.value || DEFAULT_PREFERENCES.provider) {
      if (destroyed) return;
      const currentProvider = preferredProvider;
      const currentTarget = target.value || DEFAULT_PREFERENCES.targetLanguage;
      heading.textContent = t('translation_title');
      sourceLabel.textContent = t('translation_source_label');
      notice.textContent = t(historyId ? 'translation_notice' : 'translation_notice_temporary');
      providerCaption.textContent = t('translation_provider_label');
      targetCaption.textContent = t('translation_target_label');
      outputCaption.textContent = t('translation_output_label');
      start.textContent = t('translation_start');
      cancel.textContent = t('translation_cancel');
      settings.textContent = t('translation_settings');
      copy.textContent = t('translation_copy');
      preferencesRetry.textContent = t('translation_preferences_retry');
      provider.replaceChildren();
      // Retain supported choice values even when capability discovery changes;
      // an unavailable service is explained by blockedReason, never substituted.
      for (const id of Object.keys(PROVIDERS)) {
        const option = documentApi.createElement('option');
        option.value = id;
        option.textContent = PROVIDERS[id];
        provider.appendChild(option);
      }
      provider.value = currentProvider;
      target.replaceChildren();
      for (const language of LANGUAGES) {
        const option = documentApi.createElement('option');
        option.value = language;
        option.textContent = t(`translation_language_${language}`);
        target.appendChild(option);
      }
      target.value = currentTarget;
      render();
    }
    async function loadCapabilities() {
      const token = ++loadGeneration;
      try {
        const result = await bridge.sendMessage({ action: 'getTranslationCapabilities' });
        if (destroyed || token !== loadGeneration) return;
        if (!result?.success || !Array.isArray(result.providers)) throw new Error('Missing translation capabilities');
        const previous = selectedProvider();
        const preferredProvider = provider.value || DEFAULT_PREFERENCES.provider;
        capabilities = result;
        capabilitiesError = false;
        loading = false;
        refreshLabels(preferredProvider);
        if (previous && JSON.stringify(previous) !== JSON.stringify(selectedProvider())
          && session.getState().status === 'translating') {
          session.notifySourceChanged(true);
        }
        render();
      } catch {
        if (destroyed || token !== loadGeneration) return;
        loading = false;
        capabilitiesError = true;
        render();
      }
    }
    const notifySourceChanged = () => {
      localStatus = '';
      session.notifySourceChanged();
      render();
    };
    listen(sourceTextarea, 'input', notifySourceChanged);
    listen(provider, 'change', () => {
      selectionGeneration += 1;
      preferences.change({ provider: provider.value });
      notifySourceChanged();
    });
    listen(target, 'change', () => {
      selectionGeneration += 1;
      preferences.change({ targetLanguage: target.value });
      notifySourceChanged();
    });
    listen(preferencesRetry, 'click', (event) => {
      if (event.isTrusted && !destroyed && !preferencesRetry.disabled) preferences.retry();
    });
    listen(start, 'click', (event) => {
      if (!event.isTrusted || start.disabled || destroyed) return;
      selectionGeneration += 1;
      preferences.keepCurrent();
      localStatus = '';
      if (session.start()) cancel.focus();
    });
    listen(cancel, 'click', (event) => {
      if (!event.isTrusted || destroyed) return;
      session.cancel();
      start.focus();
    });
    listen(copy, 'click', async (event) => {
      if (!event.isTrusted || copy.disabled || destroyed) return;
      const token = uiGeneration;
      try {
        await root.navigator.clipboard.writeText(translated.value);
        if (destroyed || token !== uiGeneration) return;
        localStatus = t('translation_copied');
      } catch {
        if (destroyed || token !== uiGeneration) return;
        translated.focus();
        translated.select();
        localStatus = t('translation_copy_failed');
      }
      render();
    });
    listen(settings, 'click', async (event) => {
      if (!event.isTrusted || destroyed) return;
      try {
        if (openSettings) await openSettings();
        else {
          const result = await bridge.sendMessage({ action: 'openTranslationSettings' });
          if (!result?.success) throw new Error('Unable to open settings');
        }
      } catch {
        localStatus = t('translation_settings_failed');
        render();
      }
    });
    listen(documentApi, 'visibilitychange', () => {
      if (!documentApi.hidden) loadCapabilities();
    });
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      session.destroy();
      preferences.destroy();
      for (const button of [start, cancel, settings, copy, preferencesRetry]) button.disabled = true;
      listeners.forEach((remove) => remove());
      sourceLabel.remove();
    };
    if (documentApi.defaultView) listen(documentApi.defaultView, 'pagehide', destroy);
    refreshLabels();
    const capabilitiesReady = loadCapabilities();
    const preferencesReady = preferences.load();
    const historyReady = historyId
      ? bridge.sendMessage({ action: 'getHistoryRecord', historyId }).catch(() => null) : Promise.resolve(null);
    const ready = Promise.all([capabilitiesReady, historyReady, preferencesReady]).then(([, response]) => {
      if (destroyed) return;
      historyLoading = false;
      if (historyId && !response?.success) historyLoadFailed = true;
      const translation = response?.record?.translation;
      if (translation && Object.prototype.hasOwnProperty.call(PROVIDERS, translation.provider)
        && LANGUAGES.includes(translation.targetLanguage)) {
        if (selectionGeneration === 0) {
          provider.value = translation.provider;
          target.value = translation.targetLanguage;
          preferences.keepCurrent();
        }
        session.restore(translation);
      }
      render();
    });
    return { ready, notifySourceChanged, refreshLabels, destroy };
  }

  const api = Object.freeze({ mount, createSession, createPreferenceSession, DEFAULT_PREFERENCES });
  root.OCRTranslationUI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
