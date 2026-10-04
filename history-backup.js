/** Validate portable history backups without trusting their stored fields. */
(function initializeHistoryBackup(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OCRHistoryBackup = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createHistoryBackupModule() {
  'use strict';

  const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
  const MAX_BACKUP_RECORDS = 10000;
  const MAX_TEXT_CHARACTERS = 1000000;

  function invalid(code = 'HISTORY_BACKUP_INVALID') {
    const error = new Error(code);
    error.code = code;
    throw error;
  }

  function isObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function text(value, maximum, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'string' || value.length > maximum * 2
      || Array.from(value).length > maximum) invalid();
    return value;
  }

  function timestamp(value, fallback = 0) {
    if (value === undefined || value === null) return fallback;
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) invalid();
    return value;
  }

  function sourceOrigin(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
    } catch { return ''; }
  }

  function normalizeRecord(value) {
    if (!isObject(value)
      || !((typeof value.id === 'string' && value.id.trim() && value.id.length <= 128)
        || (typeof value.id === 'number' && Number.isSafeInteger(value.id)))) invalid();
    const body = text(value.text, MAX_TEXT_CHARACTERS);
    if (!body.trim()) invalid();
    if (value.favorite !== undefined && typeof value.favorite !== 'boolean') invalid();
    const name = text(value.name, 120, '').trim();
    const record = {
      id: value.id,
      text: body,
      name,
      favorite: value.favorite === true,
      timestamp: timestamp(value.timestamp),
      provider: text(value.provider, 80, ''),
      language: text(value.language, 64, 'auto'),
      sourceTitle: text(value.sourceTitle, 10000, ''),
      sourceUrl: sourceOrigin(text(value.sourceUrl, 10000, ''))
    };
    if (value.draft !== undefined) {
      if (!isObject(value.draft)) invalid();
      record.draft = {
        text: text(value.draft.text, 100000),
        baseText: text(value.draft.baseText, 100000),
        updatedAt: timestamp(value.draft.updatedAt, record.timestamp)
      };
    }
    if (value.translation !== undefined) {
      const translation = value.translation;
      if (!isObject(translation)) invalid();
      const sourceText = text(translation.sourceText, MAX_TEXT_CHARACTERS);
      const translatedText = text(translation.text, MAX_TEXT_CHARACTERS);
      if (!sourceText.trim() || !translatedText.trim()) invalid();
      record.translation = {
        sourceText,
        text: translatedText,
        provider: text(translation.provider, 80),
        model: text(translation.model, 256, ''),
        targetLanguage: text(translation.targetLanguage, 64),
        timestamp: timestamp(translation.timestamp, record.timestamp)
      };
    }
    return record;
  }

  function parse(value) {
    if (!isObject(value) || ![1, 2, 3].includes(value.version) || !Array.isArray(value.records)) invalid();
    if (value.records.length > MAX_BACKUP_RECORDS) invalid('HISTORY_BACKUP_TOO_LARGE');
    let serialized;
    try { serialized = JSON.stringify(value); } catch { invalid(); }
    if (serialized.length > MAX_BACKUP_BYTES) invalid('HISTORY_BACKUP_TOO_LARGE');
    let bytes = 0;
    for (const character of serialized) {
      const point = character.codePointAt(0);
      bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      if (bytes > MAX_BACKUP_BYTES) invalid('HISTORY_BACKUP_TOO_LARGE');
    }
    // Construct every record afresh. Unknown fields, credentials, and draft
    // ownership tokens never cross the import boundary.
    return value.records.map(normalizeRecord);
  }

  return Object.freeze({ MAX_BACKUP_BYTES, MAX_BACKUP_RECORDS, MAX_TEXT_CHARACTERS, parse, sourceOrigin });
}));
