'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, MAX_BACKUP_BYTES, MAX_BACKUP_RECORDS } = require('../history-backup.js');
const { create } = require('../history-store.js');

const record = (id, extra = {}) => ({ id, text: `Text ${id}`, timestamp: 1, ...extra });
const backup = (records, version = 3) => ({ version, exportDate: new Date().toISOString(), records });

function memory(initial = []) {
  let history = structuredClone(initial);
  let writes = 0;
  let failure = false;
  return {
    async get() { return { ocrHistory: structuredClone(history) }; },
    async set(value) {
      if (failure) throw new Error('QUOTA_BYTES exceeded: private storage details');
      writes += 1;
      history = structuredClone(value.ocrHistory);
    },
    get writes() { return writes; },
    fail(value) { failure = value; },
    snapshot() { return structuredClone(history); },
    externallyReplace(value) { history = structuredClone(value); }
  };
}

test('portable versions restore text, protection, draft and translation with an explicit safe field set', () => {
  const source = record('saved', {
    name: ' Named ', favorite: true, provider: 'openai', language: 'en',
    sourceTitle: 'Invoice', sourceUrl: 'https://user:password@example.test/private?token=secret#fragment',
    draft: { text: '', baseText: 'Text saved', updatedAt: 2, apiKey: 'secret' },
    draftMeta: { ownerId: 'old-window', updatedAt: 2 }, apiKey: 'secret',
    translation: { sourceText: 'Text saved', text: '结果', targetLanguage: 'zh', provider: 'custom',
      model: 'model', timestamp: 3, stale: false, credentials: { secret: true } }
  });
  const [restored] = parse(backup([source]));
  assert.deepEqual(restored, { id: 'saved', text: 'Text saved', name: 'Named', favorite: true,
    timestamp: 1, provider: 'openai', language: 'en', sourceTitle: 'Invoice', sourceUrl: 'https://example.test',
    draft: { text: '', baseText: 'Text saved', updatedAt: 2 },
    translation: { sourceText: 'Text saved', text: '结果', targetLanguage: 'zh', provider: 'custom', model: 'model', timestamp: 3 } });
  for (const version of [1, 2]) assert.equal(parse(backup([record(123)], version))[0].id, 123);
  assert.equal(parse(backup([record('file', { sourceUrl: 'file:///private/user.txt' })]))[0].sourceUrl, '');
});

test('backup schema rejects malformed collections and fields before any write', () => {
  const invalid = [null, [], {}, { version: 4, records: [] }, { version: 3, records: {} },
    backup([null]), backup([record({})]), backup([record('bad', { text: [] })]),
    backup([record('bad', { text: '  ' })]), backup([record('bad', { favorite: 'true' })]),
    backup([record('bad', { name: 'x'.repeat(121) })]), backup([record('bad', { timestamp: 'today' })]),
    backup([record('bad', { timestamp: Number.MAX_SAFE_INTEGER })]),
    backup([record('bad', { timestamp: -1 })]), backup([record('bad', { provider: {} })]),
    backup([record('bad', { sourceUrl: [] })]), backup([record('bad', { draft: [] })]),
    backup([record('bad', { draft: { text: '', baseText: 'body', updatedAt: Number.MAX_SAFE_INTEGER } })]),
    backup([record('bad', { draft: { text: 'x'.repeat(100001), baseText: '' } })]),
    backup([record('bad', { translation: { sourceText: 'text', text: 't', provider: 'x', targetLanguage: 'zh', timestamp: Number.MAX_SAFE_INTEGER } })]),
    backup([record('bad', { translation: { sourceText: 'text', text: '', provider: 'x', targetLanguage: 'zh' } })])];
  for (const input of invalid) assert.throws(() => parse(input), { code: 'HISTORY_BACKUP_INVALID' });
  assert.throws(() => parse(backup(Array.from({ length: MAX_BACKUP_RECORDS + 1 }, (_, i) => record(i)))),
    { code: 'HISTORY_BACKUP_TOO_LARGE' });
  assert.throws(() => parse({ ...backup([]), extra: '汉'.repeat(Math.floor(MAX_BACKUP_BYTES / 3)) }),
    { code: 'HISTORY_BACKUP_TOO_LARGE' });
});

test('import preview is read-only, merges by ID, and never overwrites a locally changed record', async () => {
  const existing = record('existing', { text: 'Edited locally', timestamp: 1, name: 'Keep',
    draft: { text: 'Local draft', baseText: 'Edited locally', updatedAt: 2 },
    draftMeta: { ownerId: 'live-window', updatedAt: 2 } });
  const storage = memory([existing]);
  const store = create(storage);
  const preview = await store.previewImport(backup([record('existing', { text: 'Old backup', timestamp: 999 }),
    record('new'), record('new'), record('same-body', { text: 'Text new' })]));
  assert.equal(storage.writes, 0);
  assert.equal(preview.totalCount, 4);
  assert.equal(preview.importCount, 2);
  assert.equal(preview.duplicateCount, 2);
  assert.deepEqual(await store.commitImport(preview.token), { importedCount: 2, duplicateCount: 2, capacitySkippedCount: 0 });
  assert.deepEqual(await store.get('existing'), existing);
  assert.equal((await store.list()).length, 3);
  assert.equal(storage.writes, 1);
  await assert.rejects(store.commitImport(preview.token), { code: 'HISTORY_PREVIEW_EXPIRED' });
});

test('ordinary imports only fill remaining capacity while favorites and unfinished empty drafts are retained', async () => {
  const existing = [record('local-1'), record('local-2'), record('local-favorite', { favorite: true })];
  const storage = memory(existing);
  const store = create(storage, { limit: 3 });
  const preview = await store.previewImport(backup([record('ordinary'), record('overflow'),
    record('star', { favorite: true }), record('draft', { draft: { text: '', baseText: 'Text draft', updatedAt: 3 } }),
    record('both', { favorite: true, draft: { text: 'Other', baseText: 'Text both', updatedAt: 3 } }),
    record('finished', { draft: { text: 'Text finished', baseText: 'Text finished', updatedAt: 3 } })]));
  assert.deepEqual({ ...preview, token: '' }, { token: '', totalCount: 6, currentCount: 3,
    importCount: 4, duplicateCount: 0, capacitySkippedCount: 2, protectedCount: 3, favoriteCount: 2, draftCount: 2 });
  await store.commitImport(preview.token);
  assert.equal((await store.list()).length, 7);
  for (const source of existing) assert.deepEqual(await store.get(source.id), source);
});

test('import input is snapshotted before queueing and canceled previews cannot commit', async () => {
  const storage = memory();
  const store = create(storage);
  const input = backup([record('new')]);
  const pending = store.previewImport(input);
  input.records[0].text = 'Caller mutated';
  const preview = await pending;
  await store.commitImport(preview.token);
  assert.equal((await store.get('new')).text, 'Text new');
  const canceled = await store.previewImport(backup([record('cancel')]));
  await store.cancelPreview(canceled.token);
  await assert.rejects(store.commitImport(canceled.token), { code: 'HISTORY_PREVIEW_EXPIRED' });
  assert.equal(await store.get('cancel'), null);
});

test('preview expiration, popup ownership and replacement prevent reusing a stale confirmation', async () => {
  let clock = 1;
  const store = create(memory(), { now: () => clock });
  const first = await store.previewImport(backup([record('first')]), 'popup-a');
  await assert.rejects(store.commitImport(first.token, 'popup-b'), { code: 'HISTORY_ACCESS_DENIED' });
  await assert.rejects(store.cancelPreview(first.token, 'popup-b'), { code: 'HISTORY_ACCESS_DENIED' });
  const second = await store.previewImport(backup([record('second')]), 'popup-a');
  await assert.rejects(store.commitImport(first.token, 'popup-a'), { code: 'HISTORY_PREVIEW_EXPIRED' });
  clock += 5 * 60 * 1000;
  await assert.rejects(store.commitImport(second.token, 'popup-a'), { code: 'HISTORY_PREVIEW_EXPIRED' });
});

test('concurrent history edits invalidate imports and cleanup before either writes', async () => {
  const storage = memory([record('existing')]);
  const store = create(storage);
  const preview = await store.previewImport(backup([record('new')]));
  await store.updateText('existing', 'New edit', 'Text existing');
  await assert.rejects(store.commitImport(preview.token), { code: 'HISTORY_PREVIEW_STALE' });
  assert.equal(await store.get('new'), null);
  const cleanup = await store.previewCleanup();
  const protectedWrite = store.patchMetadata('existing', { favorite: true });
  const confirmation = store.commitCleanup(cleanup.token);
  await protectedWrite;
  await assert.rejects(confirmation, { code: 'HISTORY_PREVIEW_STALE' });
  assert.equal((await store.get('existing')).favorite, true);
});

test('direct external storage changes also invalidate confirmations', async () => {
  const storage = memory([record('existing')]);
  const store = create(storage);
  const preview = await store.previewCleanup();
  storage.externallyReplace([record('existing', { draft: { text: '', baseText: 'Text existing', updatedAt: 2 } })]);
  await assert.rejects(store.commitCleanup(preview.token), { code: 'HISTORY_PREVIEW_STALE' });
  assert.equal(storage.writes, 0);
});

test('cleanup removes only ordinary records and counts overlapping protections accurately', async () => {
  const store = create(memory([record('ordinary'), record('star', { favorite: true }),
    record('draft', { draft: { text: '', baseText: 'Text draft', updatedAt: 2 } }),
    record('both', { favorite: true, draft: { text: 'Pending', baseText: 'Text both', updatedAt: 2 } }),
    record('finished', { draft: { text: 'Text finished', baseText: 'Text finished', updatedAt: 2 } })]));
  const preview = await store.previewCleanup();
  assert.deepEqual({ ...preview, token: '' }, { token: '', deleteCount: 2, keepCount: 3,
    protectedCount: 3, favoriteCount: 2, draftCount: 2 });
  assert.deepEqual(await store.commitCleanup(preview.token), { deletedCount: 2, keptCount: 3 });
  assert.deepEqual((await store.list()).map((value) => value.id), ['star', 'draft', 'both']);
});

test('storage failure cannot partially import or clean history and the queue recovers', async () => {
  const original = [record('existing')];
  const storage = memory(original);
  const store = create(storage);
  for (const kind of ['import', 'cleanup']) {
    const preview = kind === 'import' ? await store.previewImport(backup([record('new')])) : await store.previewCleanup();
    storage.fail(true);
    await assert.rejects(kind === 'import' ? store.commitImport(preview.token) : store.commitCleanup(preview.token), /QUOTA_BYTES/);
    assert.deepEqual(storage.snapshot(), original);
    storage.fail(false);
    await assert.rejects(kind === 'import' ? store.commitImport(preview.token) : store.commitCleanup(preview.token),
      { code: 'HISTORY_PREVIEW_EXPIRED' });
  }
  const preview = await store.previewImport(backup([record('retry')]));
  await store.commitImport(preview.token);
  assert.equal((await store.list()).length, 2);
});

test('import and OCR append share the same queue without losing either write', async () => {
  const store = create(memory());
  const preview = await store.previewImport(backup([record('imported')]));
  await Promise.all([store.commitImport(preview.token), store.append(record('ocr'))]);
  assert.deepEqual((await store.list()).map((value) => value.id).sort(), ['imported', 'ocr']);
});

test('conflict copies preserve even the oldest original at full capacity and copy only source metadata', async () => {
  const original = record('source', { provider: 'openai', language: 'en', sourceTitle: 'Source',
    sourceUrl: 'https://example.test/path?token=secret', name: 'Original name',
    translation: { text: 'Translation', sourceText: 'Text source', provider: 'x', targetLanguage: 'zh' } });
  const store = create(memory([original, record('newer', { timestamp: 2 }), record('newest', { timestamp: 3 })]), { limit: 3 });
  const copy = await store.saveAsNew('source', ' Copied edits ');
  assert.notEqual(copy.id, 'source');
  assert.equal(copy.text, 'Copied edits');
  assert.equal(copy.sourceUrl, 'https://example.test');
  assert.equal(copy.sourceTitle, 'Source');
  assert.equal(copy.provider, 'openai');
  assert.equal(copy.language, 'en');
  assert.equal(copy.translation, undefined);
  assert.equal(copy.name, undefined);
  assert.equal(copy.draft, undefined);
  assert.deepEqual(await store.get('source'), original);
  assert.equal(await store.get('newer'), null);
  assert.equal((await store.list()).length, 3);
});

test('conflict copies tolerate a deleted original, serialize simultaneous saves, and reject invalid text', async () => {
  const storage = memory();
  const store = create(storage);
  const [a, b] = await Promise.all([store.saveAsNew('deleted', 'A'), store.saveAsNew('deleted', 'B')]);
  assert.notEqual(a.id, b.id);
  assert.equal(a.sourceUrl, '');
  assert.equal(a.language, 'auto');
  for (const value of [null, {}, '', '   ']) await assert.rejects(store.saveAsNew('deleted', value), { code: 'HISTORY_TEXT_INVALID' });
  assert.equal(storage.writes, 2);
});

test('history search includes pending draft text', async () => {
  const store = create(memory([record('draft', { draft: { text: 'Uncommitted CORRECTION', baseText: 'Text draft', updatedAt: 1 } }), record('ordinary')]));
  assert.deepEqual((await store.search('correction')).map((value) => value.id), ['draft']);
});
