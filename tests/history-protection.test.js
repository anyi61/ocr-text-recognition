'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create, MAX_NAME_CHARACTERS } = require('../history-store.js');

function memoryStorage(initialHistory = []) {
  let history = structuredClone(initialHistory);
  return {
    async get() { return { ocrHistory: structuredClone(history) }; },
    async set(value) { history = structuredClone(value.ocrHistory); },
    snapshot() { return structuredClone(history); }
  };
}

function record(id, timestamp, metadata = {}) {
  return { id, text: `Text ${id}`, timestamp, ...metadata };
}

test('legacy records acquire optional metadata without losing unknown source fields', async () => {
  const original = record('legacy', 1, { date: 'old date', sourceTitle: 'Source', extensionField: { enabled: true } });
  const storage = memoryStorage([original]);
  const store = create(storage);
  assert.deepEqual(await store.get('legacy'), original);
  const updated = await store.patchMetadata('legacy', { name: '  Annual report  ', favorite: true });
  assert.deepEqual(updated, { ...original, name: 'Annual report', favorite: true });
  assert.deepEqual(await store.search('ANNUAL'), [updated]);
  assert.deepEqual(await store.search('source'), [updated]);
});

test('retention keeps 50 ordinary records in addition to older favorites and unfinished drafts', async () => {
  const storage = memoryStorage([
    record('favorite', 1, { favorite: true, name: 'Pinned' }),
    record('draft', 2, { draft: { text: 'Unfinished', baseText: 'Text draft', updatedAt: 2 } }),
    record('empty-draft', 3, { draft: { text: '', baseText: 'Text empty-draft', updatedAt: 3 } }),
    ...Array.from({ length: 50 }, (_, i) => record(`normal-${i}`, 100 + i))
  ]);
  const store = create(storage);
  await store.append(record('new', 999));
  const retained = await store.list();
  assert.equal(retained.length, 53);
  assert.equal(retained.filter((item) => !item.favorite && !item.draft).length, 50);
  assert.equal(retained[0].id, 'new');
  assert.ok(!retained.some((item) => item.id === 'normal-0'));
  for (const id of ['favorite', 'draft', 'empty-draft']) assert.ok(await store.get(id));
});

test('a draft equal to saved text and a draft ownership tombstone do not exempt old records', async () => {
  const storage = memoryStorage([
    record('same-draft', 1, { draft: { text: 'Text same-draft', baseText: 'Text same-draft', updatedAt: 1 } }),
    record('tombstone', 2, { draftMeta: { ownerId: 'editor', updatedAt: 2 } }),
    record('named', 3, { name: 'Name alone is not a favorite' })
  ]);
  const store = create(storage, { limit: 1 });
  await store.append(record('new', 4));
  assert.deepEqual((await store.list()).map((item) => item.id), ['new']);
});

test('removing a favorite keeps the record until the next append and unfinished drafts still protect it', async () => {
  const storage = memoryStorage([
    record('favorite', 1, { favorite: true }),
    record('both', 2, { favorite: true, draft: { text: '', baseText: 'Text both', updatedAt: 2 } }),
    record('normal', 3)
  ]);
  const store = create(storage, { limit: 1 });
  await store.patchMetadata('favorite', { favorite: false });
  await store.patchMetadata('both', { favorite: false });
  assert.ok(await store.get('favorite'));
  await store.append(record('new', 4));
  assert.deepEqual((await store.list()).map((item) => item.id), ['new', 'both']);
  await store.discardDraft('both', 2);
  await store.append(record('newer', 5));
  assert.deepEqual((await store.list()).map((item) => item.id), ['newer']);
});

test('committing an unfinished draft returns it to ordinary retention unless still favorited', async () => {
  const storage = memoryStorage([
    record('draft', 1, { draft: { text: 'Edited', baseText: 'Text draft', updatedAt: 1 } }),
    record('favorite', 2, { favorite: true, draft: { text: 'Edited favorite', baseText: 'Text favorite', updatedAt: 2 } })
  ]);
  const store = create(storage, { limit: 1 });
  await store.updateText('draft', 'Edited', 'Text draft');
  await store.updateText('favorite', 'Edited favorite', 'Text favorite');
  await store.append(record('new', 3));
  assert.deepEqual((await store.list()).map((item) => item.id), ['new', 'favorite']);
});

test('serialized metadata patches preserve concurrent text, draft ownership, and translation writes', async () => {
  const storage = memoryStorage([record('shared', 1)]);
  const store = create(storage);
  const translation = {
    sourceText: 'Text shared', text: '翻译', provider: 'openai', model: 'mock', targetLanguage: 'zh', timestamp: 5
  };
  await Promise.all([
    store.patchMetadata('shared', { favorite: true }),
    store.saveDraft('shared', { text: 'Still editing', baseText: 'Text shared' }, { ownerId: 'editor', expectedUpdatedAt: null }),
    store.patchMetadata('shared', { name: 'Shared item' }),
    store.saveTranslation('shared', translation),
    store.updateText('shared', 'Formal edit', 'Text shared')
  ]);
  const updated = await store.get('shared');
  assert.equal(updated.favorite, true);
  assert.equal(updated.name, 'Shared item');
  assert.equal(updated.text, 'Formal edit');
  assert.equal(updated.draft.text, 'Still editing');
  assert.equal(updated.draftMeta.ownerId, 'editor');
  assert.deepEqual(updated.translation, translation);
});

test('discard retains the editor ownership for input sent before its acknowledgement', async () => {
  const storage = memoryStorage([record('shared', 1)]);
  const store = create(storage);
  const saved = await store.saveDraft('shared', { text: 'Old draft', baseText: 'Text shared' },
    { ownerId: 'editor-a', expectedUpdatedAt: null });
  const revision = saved.draftUpdatedAt;
  const discard = store.discardDraft('shared', revision, 'editor-a');
  const input = store.saveDraft('shared', { text: 'Typed during discard', baseText: 'Text shared' },
    { ownerId: 'editor-a', expectedUpdatedAt: revision });
  assert.equal((await discard).success, true);
  assert.equal((await input).success, true);
  const staleOther = await store.saveDraft('shared', { text: 'Another editor', baseText: 'Text shared' },
    { ownerId: 'editor-b', expectedUpdatedAt: revision });
  assert.equal(staleOther.errorCode, 'HISTORY_DRAFT_CONFLICT');
  assert.equal((await store.get('shared')).draft.text, 'Typed during discard');
});

test('managed discard keeps revision checks and cannot take ownership of an absent draft', async () => {
  const storage = memoryStorage([record('shared', 1)]);
  const store = create(storage);
  const saved = await store.saveDraft('shared', { text: 'Draft', baseText: 'Text shared' },
    { ownerId: 'editor-a', expectedUpdatedAt: null });
  await assert.rejects(store.discardDraft('shared', saved.draftUpdatedAt - 1, 'editor-b'),
    { code: 'HISTORY_DRAFT_CONFLICT' });
  await store.discardDraft('shared', saved.draftUpdatedAt, 'editor-a');
  const before = storage.snapshot();
  await store.discardDraft('shared', saved.draftUpdatedAt, 'editor-b');
  assert.deepEqual(storage.snapshot(), before);
  for (const owner of ['', null, 4, 'x'.repeat(129)]) {
    await assert.rejects(store.discardDraft('shared', saved.draftUpdatedAt, owner),
      { code: 'HISTORY_DRAFT_INVALID' });
  }
});

test('metadata snapshots cannot be changed by the caller while queued or after return', async () => {
  const storage = memoryStorage([record('item', 1, {
    draft: { text: 'Draft', baseText: 'Text item', updatedAt: 1 },
    draftMeta: { ownerId: 'owner', updatedAt: 1 },
    translation: { text: 'Translated' }
  })]);
  const store = create(storage);
  const patch = { name: 'Original request' };
  const pending = store.patchMetadata('item', patch);
  patch.name = 'Changed after submission';
  const result = await pending;
  result.draft.text = 'Mutation';
  result.draftMeta.ownerId = 'Mutation';
  result.translation.text = 'Mutation';
  const saved = await store.get('item');
  assert.equal(saved.name, 'Original request');
  assert.equal(saved.draft.text, 'Draft');
  assert.equal(saved.draftMeta.ownerId, 'owner');
  assert.equal(saved.translation.text, 'Translated');
});

test('metadata validation rejects non-boolean favorites, invalid names, and unrelated replacement fields', async () => {
  const original = record('item', 1);
  const storage = memoryStorage([original]);
  const store = create(storage);
  for (const patch of [null, [], {}, { favorite: 'true' }, { name: 1 },
    { name: 'x'.repeat(MAX_NAME_CHARACTERS + 1) }, { text: 'replacement' }, { draft: {} }]) {
    await assert.rejects(store.patchMetadata('item', patch), { code: 'HISTORY_METADATA_INVALID' });
  }
  assert.deepEqual(storage.snapshot(), [original]);
  assert.equal((await store.patchMetadata('item', { name: '😀'.repeat(MAX_NAME_CHARACTERS) })).name.length, 240);
  assert.equal((await store.patchMetadata('item', { name: '   ' })).name, '');
});

test('cancelled metadata patches do not persist and missing records are never recreated', async () => {
  const original = record('item', 1);
  const storage = memoryStorage([original]);
  const store = create(storage);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.patchMetadata('item', { favorite: true }, controller.signal), { name: 'AbortError' });
  assert.equal(await store.patchMetadata('missing', { name: 'Missing' }), null);
  assert.deepEqual(storage.snapshot(), [original]);
});

test('cancellation after metadata write restores the pre-image before a queued edit runs', async () => {
  const original = record('item', 1, { name: 'Original', favorite: true,
    draft: { text: '', baseText: 'Text item', updatedAt: 1 } });
  const controller = new AbortController();
  let history = [original];
  let writes = 0;
  const storage = {
    async get() { return { ocrHistory: structuredClone(history) }; },
    async set(value) {
      history = structuredClone(value.ocrHistory);
      writes += 1;
      if (writes === 1) controller.abort();
    }
  };
  const store = create(storage);
  const cancelled = store.patchMetadata('item', { favorite: false, name: 'Cancelled' }, controller.signal);
  const newer = store.patchMetadata('item', { name: 'Newest' });
  await assert.rejects(cancelled, { name: 'AbortError' });
  await newer;
  assert.deepEqual(history, [{ ...original, name: 'Newest' }]);
  assert.equal(writes, 3);
});

test('a cancelled append restores all protected and ordinary records even after retention ran', async () => {
  const original = [record('favorite', 1, { favorite: true }),
    record('draft', 2, { draft: { text: '', baseText: 'Text draft', updatedAt: 2 } }), record('normal', 3)];
  const controller = new AbortController();
  let history = structuredClone(original);
  let writes = 0;
  const storage = {
    async get() { return { ocrHistory: structuredClone(history) }; },
    async set(value) {
      history = structuredClone(value.ocrHistory);
      writes += 1;
      if (writes === 1) controller.abort();
    }
  };
  await assert.rejects(create(storage, { limit: 1 }).append(record('new', 4), controller.signal), { name: 'AbortError' });
  assert.deepEqual(history, original);
});

test('favorites, names, and empty drafts survive a store restart and explicit deletion remains available', async () => {
  const storage = memoryStorage([record('item', 1)]);
  const first = create(storage, { limit: 1 });
  await first.patchMetadata('item', { name: 'Persistent', favorite: true });
  await first.saveDraft('item', { text: '', baseText: 'Text item' });
  const restarted = create(storage, { limit: 1 });
  await restarted.append(record('new', 2));
  assert.equal((await restarted.search('persistent'))[0].draft.text, '');
  assert.equal((await restarted.get('item')).favorite, true);
  assert.equal(await restarted.delete('item'), true);
  await restarted.clear();
  assert.deepEqual(storage.snapshot(), []);
});
