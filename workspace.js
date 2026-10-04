/** A stable extension tab for local image recognition and result editing. */
document.addEventListener('DOMContentLoaded', async () => {
  'use strict';
  await OCRI18n.init();
  const get = (id) => document.getElementById(id);
  const fileInput = get('imageFile');
  const dropZone = get('imageDropZone');
  const previewWrap = get('imagePreviewWrap');
  const preview = get('imagePreview');
  const metadata = get('imageMetadata');
  const recognize = get('recognizeImage');
  const cancel = get('cancelImageOCR');
  const settings = get('importSettings');
  const status = get('imageImportStatus');
  const resultSection = get('imageResultSection');
  const source = get('imageResultText');
  const save = get('saveImageResult');
  const copy = get('copyImageResult');
  const resultStatus = get('imageResultStatus');
  const recoveryActions = get('imageRecoveryActions');
  const retry = get('retryImageOCR');
  const chooseNew = get('chooseNewImage');
  const recoverySettings = get('imageRecoverySettings');
  const autoCopyStatus = get('imageAutoCopyStatus');
  const configKeys = ['apiProvider', 'apiConfigs', 'apiKey', 'model', 'openaiApiKey', 'openaiModel',
    'baiduApiKey', 'customSecret', 'aliyunApiKey', 'aliyunModel', 'zhipuApiKey', 'zhipuModel',
    'compatibleEndpoint', 'compatibleApiKey', 'compatibleModel', 'customEndpoint', 'customApiKey', 'customModel'];
  const providerLabels = { claude: 'Claude', openai: 'OpenAI', baidu: 'Baidu OCR', aliyun: 'Aliyun', zhipu: 'Zhipu AI', 'openai-compatible': 'OpenAI Compatible', custom: 'Custom API' };
  let config = null;
  let configVersion = 0;
  let configRead = 0;
  let configSignature = '';
  let image = null;
  let generation = 0;
  let loading = false;
  let busy = false;
  let recovering = false;
  let copyGeneration = 0;
  let autoCopyStatusKey = '';
  let saving = false;
  let disposed = false;
  let port = null;
  let requestId = null;
  let savedText = '';
  let historyId = null;
  let translation = null;
  let draft = null;
  let statusKey = '';
  let statusArgs = [];
  let resultStatusKey = '';
  const setStatus = (key, args = []) => {
    statusKey = key; statusArgs = args;
    status.textContent = key ? OCRI18n.t(key, args) : '';
  };
  const setResultStatus = (key) => {
    resultStatusKey = key;
    resultStatus.textContent = key ? OCRI18n.t(key) : '';
  };
  function updateButtons() {
    recognize.disabled = !image || loading || busy || saving || !config?.configured;
    recognize.hidden = recovering;
    recoveryActions.hidden = !recovering;
    retry.disabled = recognize.disabled;
    chooseNew.disabled = saving;
    recoverySettings.disabled = saving;
    cancel.hidden = !busy;
    save.disabled = saving || busy || !historyId || !source.value.trim() || source.value === savedText;
    source.readOnly = busy;
    fileInput.disabled = saving;
    settings.disabled = saving;
    resultSection.setAttribute('aria-busy', String(saving));
    dropZone.setAttribute('aria-busy', String(loading));
  }
  function focusRecoveryAction() {
    if (recovering && !busy && !disposed) (retry.disabled ? recoverySettings : retry).focus({ preventScroll: true });
  }
  function refreshLabels() {
    OCRI18n.applyToDom(document);
    document.documentElement.lang = OCRI18n.getResolvedLanguage() === 'en' ? 'en' : 'zh-CN';
    document.title = OCRI18n.t('image_import_title');
    preview.alt = OCRI18n.t('image_import_preview');
    get('importProvider').textContent = config ? OCRI18n.t(config.configured ? 'image_import_provider' : 'image_import_config_required', [providerLabels[config.provider] || config.provider]) : '';
    if (image) metadata.textContent = OCRI18n.t('image_import_dimensions', [image.name, String(image.originalWidth), String(image.originalHeight), String(image.width), String(image.height)]);
    if (statusKey) setStatus(statusKey, statusArgs);
    if (resultStatusKey) setResultStatus(resultStatusKey);
    if (autoCopyStatusKey) autoCopyStatus.textContent = OCRI18n.t(autoCopyStatusKey);
    translation?.refreshLabels();
    draft?.refreshLabels();
  }
  async function loadConfig() {
    const version = ++configRead;
    const stored = await chrome.storage.local.get([...configKeys, 'theme']);
    if (disposed || version !== configRead) return;
    const signature = JSON.stringify(configKeys.map((key) => stored[key]));
    if (signature !== configSignature) { configSignature = signature; configVersion += 1; }
    const provider = stored.apiProvider || 'claude';
    const providerConfig = OCRProviderConfig.getProviderConfig(stored.apiConfigs, provider);
    config = {
      provider,
      endpoint: providerConfig.endpoint || (provider === 'custom' ? stored.customEndpoint : stored.compatibleEndpoint),
      configured: OCRProviderConfig.hasRequiredCredentials(stored.apiConfigs, provider, stored)
    };
    document.documentElement.dataset.theme = stored.theme || 'light';
    refreshLabels(); updateButtons();
  }
  function stopRequest(showMessage = false) {
    generation += 1;
    if (port && requestId) {
      try { port.postMessage({ action: 'cancel', requestId }); } catch { /* Already disconnected. */ }
    }
    port?.disconnect(); port = null; requestId = null;
    busy = false;
    if (showMessage) { recovering = false; setStatus('image_import_cancelled'); }
    updateButtons();
    if (showMessage && !disposed) recognize.focus({ preventScroll: true });
  }
  function destroyResult() {
    copyGeneration += 1;
    autoCopyStatusKey = ''; autoCopyStatus.textContent = ''; autoCopyStatus.hidden = true;
    translation?.destroy(); translation = null;
    draft?.destroy(); draft = null;
    historyId = null; savedText = ''; source.value = '';
    resultSection.hidden = true; setResultStatus('');
  }
  async function selectFiles(files) {
    if (saving || disposed) return;
    stopRequest();
    recovering = false;
    loading = false;
    destroyResult();
    image = null; preview.removeAttribute('src'); previewWrap.hidden = true;
    fileInput.value = '';
    const selection = Array.from(files);
    if (selection.length !== 1) { setStatus('image_import_single_only'); updateButtons(); return; }
    loading = true;
    setStatus('image_import_preparing'); updateButtons();
    const version = generation;
    try {
      const normalized = await globalThis.OCRImageUtils.normalizeFile(selection[0]);
      if (disposed || version !== generation) return;
      image = { ...normalized, name: selection[0].name || OCRI18n.t('image_import_clipboard_name') };
      preview.src = image.dataUrl;
      previewWrap.hidden = false;
      refreshLabels(); setStatus('image_import_ready');
    } catch (error) {
      if (!disposed && version === generation) setStatus(error.code?.startsWith('image_import_') ? error.code : 'image_import_invalid_image');
    } finally {
      if (version === generation) { loading = false; updateButtons(); }
    }
  }
  function showResult(response) {
    destroyResult();
    historyId = response.historyId || null;
    savedText = response.text;
    source.value = response.text;
    resultSection.hidden = false;
    translation = globalThis.OCRTranslationUI.mount({
      container: get('imageTranslation'), sourceTextarea: source,
      idPrefix: 'image-translation', historyId,
      openSettings: () => chrome.runtime.openOptionsPage()
    });
    if (historyId && globalThis.OCRDraftUI) {
      draft = globalThis.OCRDraftUI.mount({
        container: get('imageDraft'), sourceTextarea: source, historyId,
        getSavedText: () => savedText,
        onRestore: () => { translation?.notifySourceChanged(); updateButtons(); }
      });
    }
    setResultStatus(response.warningCode ? 'error_history_save_failed' : 'image_import_history_saved');
    updateButtons(); source.focus();
    if (response.autoCopy === true) void copyText(true, response.text);
  }
  async function copyText(automatic = false, text = source.value) {
    const token = ++copyGeneration;
    const version = generation;
    let message = automatic ? 'auto_copy_success' : 'btn_copied';
    try { await navigator.clipboard.writeText(text); }
    catch { message = automatic ? 'auto_copy_failed' : 'content_msg_copy_failed'; }
    if (disposed || version !== generation || token !== copyGeneration || source.value !== text || resultSection.hidden) return;
    if (automatic) {
      autoCopyStatusKey = message;
      autoCopyStatus.textContent = OCRI18n.t(message);
      autoCopyStatus.hidden = false;
    } else {
      autoCopyStatus.hidden = true;
      autoCopyStatusKey = '';
      setResultStatus(message);
    }
  }
  async function recognizeChosenImage(event) {
    if (!event.isTrusted || recognize.disabled) return;
    const chosenImage = image;
    const version = ++generation;
    const configSnapshot = config;
    const configRevision = configVersion;
    busy = true;
    setStatus('image_import_working'); updateButtons();
    cancel.focus({ preventScroll: true });
    try {
      // Start Chrome's permission request directly in this user gesture, using
      // the already loaded endpoint. Never defer it behind a storage read.
      const allowed = await OCRExtensionRuntime.requestEndpointPermission(chrome, configSnapshot.provider, configSnapshot.endpoint);
      if (disposed || version !== generation) return;
      if (!allowed) { busy = false; recovering = true; setStatus('image_import_permission_denied'); updateButtons(); focusRecoveryAction(); return; }
      if (configRevision !== configVersion) { busy = false; recovering = true; setStatus('image_import_config_changed'); updateButtons(); focusRecoveryAction(); return; }
      const activePort = chrome.runtime.connect({ name: 'ocr-image-workspace' });
      const id = OCRCaptureUtils.createRequestId();
      port = activePort; requestId = id;
      activePort.onMessage.addListener((response) => {
        if (disposed || version !== generation || port !== activePort || requestId !== id
          || response.action !== 'ocrResult' || response.requestId !== id) return;
        port = null; requestId = null; busy = false;
        activePort.disconnect();
        if (response.success) {
          recovering = false;
          setStatus('image_import_done'); showResult(response);
        } else {
          recovering = !response.cancelled;
          if (response.cancelled) setStatus('image_import_cancelled');
          else if (response.errorCode === 'IMAGE_ENDPOINT_PERMISSION_REQUIRED') setStatus('image_import_permission_denied');
          else { statusKey = ''; status.textContent = OCRI18n.errorMessage(response); }
        }
        updateButtons(); focusRecoveryAction();
      });
      activePort.onDisconnect.addListener(() => {
        if (disposed || version !== generation || port !== activePort) return;
        port = null; requestId = null; busy = false;
        recovering = true; setStatus('image_import_connection_lost'); updateButtons(); focusRecoveryAction();
      });
      activePort.postMessage({ action: 'performOCR', requestId: id, imageData: chosenImage.dataUrl });
    } catch {
      if (!disposed && version === generation) {
        stopRequest(); recovering = true; setStatus('image_import_connection_lost'); updateButtons(); focusRecoveryAction();
      }
    }
  }
  recognize.addEventListener('click', recognizeChosenImage);
  retry.addEventListener('click', recognizeChosenImage);
  chooseNew.addEventListener('click', () => fileInput.click());
  recoverySettings.addEventListener('click', () => chrome.runtime.openOptionsPage().catch(() => setStatus('image_import_connection_lost')));
  cancel.addEventListener('click', () => stopRequest(true));
  document.addEventListener('keydown', (event) => {
    if (event.isTrusted && event.key === 'Escape' && busy) {
      event.preventDefault(); event.stopPropagation(); stopRequest(true);
    }
  });
  fileInput.addEventListener('change', () => { const files = [...fileInput.files]; if (files.length) void selectFiles(files); });
  document.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
  document.addEventListener('drop', (event) => { if (event.dataTransfer?.files.length) event.preventDefault(); });
  dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.dataset.dragging = 'true'; });
  dropZone.addEventListener('dragleave', () => { delete dropZone.dataset.dragging; });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault(); delete dropZone.dataset.dragging;
    if (event.dataTransfer?.files.length) void selectFiles(event.dataTransfer.files);
  });
  document.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault(); void selectFiles(files);
  });
  source.addEventListener('input', () => { copyGeneration += 1; autoCopyStatus.hidden = true; autoCopyStatusKey = ''; setResultStatus(''); translation?.notifySourceChanged(); updateButtons(); });
  save.addEventListener('click', async () => {
    if (save.disabled || disposed) return;
    const submittedText = source.value;
    const text = submittedText.trim();
    const version = generation;
    const savedHistoryId = historyId;
    const isCurrent = () => !disposed && version === generation && historyId === savedHistoryId;
    saving = true; updateButtons();
    source.focus({ preventScroll: true });
    try {
      const response = await chrome.runtime.sendMessage({ action: 'updateHistoryRecord', historyId: savedHistoryId, text });
      if (!isCurrent()) return;
      if (!response?.success) throw new Error('History update failed');
      // The request saves its submitted snapshot. Typing while storage is
      // pending belongs to a newer draft and must stay in the editor.
      if (source.value === submittedText) {
        source.value = text;
        translation?.notifySourceChanged();
      }
      savedText = text;
      await draft?.refresh();
      if (!isCurrent()) return;
      if (source.value.trim() !== savedText) void draft?.notifySourceChanged(true);
      setResultStatus('content_msg_changes_saved');
    } catch {
      if (isCurrent()) setResultStatus('content_msg_changes_save_failed');
    } finally {
      saving = false;
      if (!disposed) updateButtons();
    }
  });
  copy.addEventListener('click', () => void copyText());
  settings.addEventListener('click', () => chrome.runtime.openOptionsPage().catch(() => setStatus('image_import_connection_lost')));
  const storageChanged = (changes, area) => {
    if (area === 'local' && [...configKeys, 'theme'].some((key) => changes[key])) void loadConfig();
  };
  chrome.storage.onChanged.addListener(storageChanged);
  window.addEventListener('focus', () => void loadConfig());
  window.addEventListener('ocr-i18n-changed', refreshLabels);
  window.addEventListener('pagehide', () => {
    disposed = true; stopRequest(); destroyResult(); image = null;
    chrome.storage.onChanged.removeListener(storageChanged);
  }, { once: true });
  refreshLabels();
  await loadConfig();
});
