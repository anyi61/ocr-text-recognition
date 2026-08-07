// @ts-check
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

    async function append(record, signal) {
      return enqueue(async () => {
        throwIfAborted(signal);
        const history = await readHistory();
        const previousHistory = history.map((item) => ({ ...item }));
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
        const nextHistory = [
          newRecord,
          ...history.filter((item) => item?.id !== newRecord.id)
        ]
          .sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0))
          .slice(0, limit);

        throwIfAborted(signal);
        await storage.set({ ocrHistory: nextHistory });

        if (signal?.aborted) {
          await storage.set({ ocrHistory: previousHistory });
          throwIfAborted(signal);
        }

        return { ...newRecord };
      });
    }

    async function updateText(id, text) {
      return enqueue(async () => {
        const history = await readHistory();
        const index = history.findIndex((item) => item?.id === id);
        if (index < 0) return false;

        const nextHistory = history.map((item, itemIndex) => (
          itemIndex === index
            ? { ...item, text: normalizeText(text) }
            : item
        ));
        await storage.set({ ocrHistory: nextHistory });
        return true;
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
      await operationQueue;
      return (await readHistory()).map((item) => ({ ...item }));
    }

    async function search(query) {
      const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
      const history = await list();
      if (!normalizedQuery) return history;

      const searchableFields = [
        'text',
        'provider',
        'language',
        'sourceUrl',
        'sourceTitle'
      ];
      return history.filter((item) => searchableFields.some((field) => (
        String(item?.[field] || '').toLocaleLowerCase().includes(normalizedQuery)
      )));
    }

    return Object.freeze({
      append,
      updateText,
      delete: deleteRecord,
      clear,
      list,
      search
    });
  }

  return Object.freeze({
    DEFAULT_LIMIT,
    create
  });
}));
