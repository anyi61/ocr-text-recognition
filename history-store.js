/**
 * Serialized local history operations shared by the background worker, popup,
 * and Node tests.
 */
(function initializeHistoryStore(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.OCRHistoryStore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createHistoryStoreModule() {
  'use strict';

  const DEFAULT_LIMIT = 50;
  const MAX_DRAFT_CHARACTERS = 100000;
  const MAX_NAME_CHARACTERS = 120;

  function codedError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function copyRecord(record) {
    return {
      ...record,
      ...(record.translation ? { translation: { ...record.translation } } : {}),
      ...(record.draft ? { draft: { ...record.draft } } : {}),
      ...(record.draftMeta ? { draftMeta: { ...record.draftMeta } } : {})
    };
  }

  function validateDraft(draft) {
    if (!draft || typeof draft.text !== 'string' || typeof draft.baseText !== 'string'
      || Array.from(draft.text).length > MAX_DRAFT_CHARACTERS
      || Array.from(draft.baseText).length > MAX_DRAFT_CHARACTERS) {
      throw codedError('HISTORY_DRAFT_INVALID');
    }
  }

  function metadataPatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || !Object.keys(patch).length
      || Object.keys(patch).some((key) => !['favorite', 'name'].includes(key))
      || ('favorite' in patch && typeof patch.favorite !== 'boolean')
      || ('name' in patch && (typeof patch.name !== 'string'
        || Array.from(patch.name.trim()).length > MAX_NAME_CHARACTERS))) {
      throw codedError('HISTORY_METADATA_INVALID');
    }
    return {
      ...('favorite' in patch ? { favorite: patch.favorite } : {}),
      ...('name' in patch ? { name: patch.name.trim() } : {})
    };
  }

  function isProtected(record) {
    // Empty text is a valid unfinished draft: deleting all recognized text
    // must not make the source record eligible for automatic removal.
    return record?.favorite === true || (typeof record?.draft?.text === 'string'
      && record.draft.text !== record.text);
  }

  function translationSnapshot(value) {
    if (!value || typeof value.sourceText !== 'string' || !value.sourceText.trim()
      || typeof value.text !== 'string' || !value.text.trim()
      || ['provider', 'model', 'targetLanguage'].some((field) => typeof value[field] !== 'string')) {
      throw codedError('HISTORY_TRANSLATION_INVALID');
    }
    return {
      sourceText: value.sourceText,
      text: value.text,
      provider: value.provider,
      model: value.model,
      targetLanguage: value.targetLanguage,
      timestamp: Number.isFinite(value.timestamp) ? value.timestamp : Date.now()
    };
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) {
      throw new DOMException('History operation cancelled', 'AbortError');
    }
  }

  function createRecordId() {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
    return `ocr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function normalizeText(text) {
    const normalized = String(text ?? '').trim();
    if (!normalized) {
      throw new TypeError('History text must be a non-empty string');
    }
    return normalized;
  }

  function create(storage, options = {}) {
    if (!storage?.get || !storage?.set) {
      throw new TypeError('A storage area with get/set methods is required');
    }

    const configuredLimit = Number(options.limit ?? DEFAULT_LIMIT);
    const limit = Number.isInteger(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : DEFAULT_LIMIT;
    let operationQueue = Promise.resolve();

    function enqueue(operation) {
      const result = operationQueue.then(operation, operation);
      operationQueue = result.catch(() => undefined);
      return result;
    }

    async function readHistory() {
      const result = await storage.get(['ocrHistory']);
      return Array.isArray(result.ocrHistory) ? result.ocrHistory : [];
    }

    async function writeCancellable(nextHistory, previousHistory, signal) {
      throwIfAborted(signal);
      await storage.set({ ocrHistory: nextHistory });
      // This rollback is still inside the operation queue. No queued delete,
      // edit, or newer translation can run until the pre-image is restored.
      if (signal?.aborted) {
        await storage.set({ ocrHistory: previousHistory });
        throwIfAborted(signal);
      }
    }

    async function append(record, signal) {
      return enqueue(async () => {
        throwIfAborted(signal);
        const history = await readHistory();
        const previousHistory = history.map(copyRecord);
        throwIfAborted(signal);

        const timestamp = Number.isFinite(record?.timestamp)
          ? record.timestamp
          : Date.now();
        const newRecord = {
          id: record?.id || createRecordId(),
          text: normalizeText(record?.text),
          timestamp,
          provider: String(record?.provider || ''),
          language: String(record?.language || 'auto'),
          sourceUrl: String(record?.sourceUrl || ''),
          sourceTitle: String(record?.sourceTitle || '')
        };
        let ordinaryCount = 0;
        const nextHistory = [
          newRecord,
          ...history.filter((item) => item?.id !== newRecord.id)
        ]
          .sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0))
          .filter((item) => isProtected(item) || ++ordinaryCount <= limit);

        await writeCancellable(nextHistory, previousHistory, signal);

        return { ...newRecord };
      });
    }

    async function updateText(id, text, expectedText) {
      if (typeof text !== 'string' || typeof expectedText !== 'string') {
        throw codedError('HISTORY_TEXT_INVALID');
      }
      const savedText = normalizeText(text);
      return enqueue(async () => {
        const history = await readHistory();
        const index = history.findIndex((item) => item?.id === id);
        if (index < 0) return false;
        // Serializing writes prevents lost fields, but a stale editor must also
        // prove that the body it edited is still the current saved version.
        if (history[index].text !== expectedText) throw codedError('HISTORY_TEXT_CONFLICT');

        const updated = { ...history[index], text: savedText };
        // A concurrent editor may have saved a different draft. Only the draft
        // that was just committed is consumed by this formal save.
        if (typeof updated.draft?.text === 'string' && updated.draft.text.trim() === updated.text) delete updated.draft;
        const nextHistory = history.map((item, itemIndex) => itemIndex === index ? updated : item);
        await storage.set({ ocrHistory: nextHistory });
        return true;
      });
    }

    async function get(id) {
      return enqueue(async () => {
        const record = (await readHistory()).find((item) => item?.id === id);
        return record ? copyRecord(record) : null;
      });
    }

    async function patchMetadata(id, patch, signal) {
      // Snapshot only the requested fields before enqueueing. A caller cannot
      // mutate the queued patch, and unrelated concurrent writes are merged
      // from storage inside the same queue as drafts and translations.
      const normalized = metadataPatch(patch);
      return enqueue(async () => {
        throwIfAborted(signal);
        const history = await readHistory();
        throwIfAborted(signal);
        const index = history.findIndex((item) => item?.id === id);
        if (index < 0) return null;
        const updated = { ...history[index], ...normalized };
        const nextHistory = history.map((item, itemIndex) => itemIndex === index ? updated : item);
        await writeCancellable(nextHistory, history.map(copyRecord), signal);
        return copyRecord(updated);
      });
    }

    async function saveTranslation(id, translation, signal) {
      return enqueue(async () => {
        throwIfAborted(signal);
        const snapshot = translationSnapshot(translation);
        const history = await readHistory();
        throwIfAborted(signal);
        const index = history.findIndex((item) => item?.id === id);
        if (index < 0) return false;
        const nextHistory = history.map((item, itemIndex) => (
          itemIndex === index ? { ...item, translation: snapshot } : item
        ));
        await writeCancellable(nextHistory, history.map(copyRecord), signal);
        return true;
      });
    }

    async function saveDraft(id, draft, options = {}) {
      return enqueue(async () => {
        validateDraft(draft);
        const managed = options.ownerId !== undefined;
        if (managed && (typeof options.ownerId !== 'string' || !options.ownerId || options.ownerId.length > 128
          || !(options.expectedUpdatedAt === null || Number.isFinite(options.expectedUpdatedAt)))) {
          throw codedError('HISTORY_DRAFT_INVALID');
        }
        const history = await readHistory();
        const index = history.findIndex((item) => item?.id === id);
        if (index < 0) return { success: false, errorCode: 'HISTORY_RECORD_MISSING' };
        if (history[index].text !== draft.baseText) {
          return { success: false, errorCode: 'HISTORY_DRAFT_CONFLICT' };
        }
        const updated = { ...history[index] };
        const revision = updated.draftMeta?.updatedAt ?? updated.draft?.updatedAt ?? null;
        const sameOwner = managed && updated.draftMeta?.ownerId === options.ownerId;
        // Each editor sends immediately so its final input survives closing
        // the popup. Same-owner writes can advance without waiting for earlier
        // acknowledgements; taking ownership requires the revision it read.
        if ((managed && !sameOwner && options.expectedUpdatedAt !== revision)
          || (!managed && updated.draftMeta)) {
          return { success: false, errorCode: 'HISTORY_DRAFT_CONFLICT' };
        }
        const updatedAt = Math.max(Date.now(), Number(revision || 0) + 1);
        if (managed) updated.draftMeta = { ownerId: options.ownerId, updatedAt };
        if (draft.text === updated.text) delete updated.draft;
        else updated.draft = {
          text: draft.text,
          baseText: draft.baseText,
          updatedAt
        };
        await storage.set({
          ocrHistory: history.map((item, itemIndex) => itemIndex === index ? updated : item)
        });
        return {
          success: true,
          draft: updated.draft ? { ...updated.draft } : null,
          ...(managed ? { draftUpdatedAt: updatedAt } : {})
        };
      });
    }

    async function discardDraft(id, expectedUpdatedAt, ownerId) {
      if (ownerId !== undefined && (typeof ownerId !== 'string' || !ownerId || ownerId.length > 128)) {
        throw codedError('HISTORY_DRAFT_INVALID');
      }
      return enqueue(async () => {
        const history = await readHistory();
        const index = history.findIndex((item) => item?.id === id);
        if (index < 0) return false;
        if (!history[index].draft) return { success: true, draftUpdatedAt: history[index].draftMeta?.updatedAt ?? null };
        if (expectedUpdatedAt !== undefined && history[index].draft.updatedAt !== expectedUpdatedAt) {
          throw codedError('HISTORY_DRAFT_CONFLICT');
        }
        const updated = { ...history[index] };
        delete updated.draft;
        if (updated.draftMeta || ownerId !== undefined) {
          // The editor can type again while its discard acknowledgement is in
          // flight. Keep that owner's right to submit the next immediate input.
          const revision = updated.draftMeta?.updatedAt ?? history[index].draft.updatedAt ?? 0;
          updated.draftMeta = { ownerId: ownerId ?? '', updatedAt: Math.max(Date.now(), revision + 1) };
        }
        await storage.set({ ocrHistory: history.map((item, itemIndex) => itemIndex === index ? updated : item) });
        return { success: true, draftUpdatedAt: updated.draftMeta?.updatedAt ?? null };
      });
    }

    async function deleteRecord(id) {
      return enqueue(async () => {
        const history = await readHistory();
        const nextHistory = history.filter((item) => item?.id !== id);
        if (nextHistory.length === history.length) return false;
        await storage.set({ ocrHistory: nextHistory });
        return true;
      });
    }

    async function clear() {
      return enqueue(async () => {
        await storage.set({ ocrHistory: [] });
      });
    }

    async function list() {
      return enqueue(async () => (await readHistory()).map(copyRecord));
    }

    async function search(query) {
      const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
      const history = await list();
      if (!normalizedQuery) return history;

      const searchableFields = [
        'name',
        'text',
        'provider',
        'language',
        'sourceUrl',
        'sourceTitle'
      ];
      return history.filter((item) => searchableFields.some((field) => (
        String(item?.[field] || '').toLocaleLowerCase().includes(normalizedQuery)
      )) || ['text', 'sourceText', 'provider', 'targetLanguage'].some((field) => (
        String(item?.translation?.[field] || '').toLocaleLowerCase().includes(normalizedQuery)
      )));
    }

    return Object.freeze({
      append,
      get,
      patchMetadata,
      updateText,
      saveTranslation,
      saveDraft,
      discardDraft,
      delete: deleteRecord,
      clear,
      list,
      search
    });
  }

  return Object.freeze({
    DEFAULT_LIMIT,
    MAX_DRAFT_CHARACTERS,
    MAX_NAME_CHARACTERS,
    create
  });
}));
