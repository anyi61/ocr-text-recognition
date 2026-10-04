'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { create } = require('../history-store.js');

function createMemoryStorage(initialHistory = [], delayMs = 0) {
  let history = structuredClone(initialHistory);

  return {
    async get() {
      if (delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return { ocrHistory: structuredClone(history) };
    },

    async set(value) {
      if (delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      history = structuredClone(value.ocrHistory || []);
    },

    snapshot() {
      return structuredClone(history);
    }
  };
}

test('concurrent appends preserve every record', async () => {
  const storage = createMemoryStorage([], 5);
  const store = create(storage, { limit: 50 });

  await Promise.all([
    store.append({ id: 'a', text: 'Alpha', timestamp: 1 }),
    store.append({ id: 'b', text: 'Beta', timestamp: 2 })
  ]);

  assert.deepEqual(
    (await store.list()).map((item) => item.text).sort(),
    ['Alpha', 'Beta']
  );
});

test('updating corrected text preserves source metadata', async () => {
  const storage = createMemoryStorage();
  const store = create(storage, { limit: 50 });
  const record = await store.append({
    id: 'record-1',
    text: 'teh',
    timestamp: 10,
    provider: 'baidu',
    language: 'en',
    sourceUrl: 'https://example.test/page',
    sourceTitle: 'Example'
  });

  assert.equal(record.id, 'record-1');
  assert.equal(await store.updateText(record.id, 'the', 'teh'), true);

  const [updated] = await store.list();
  assert.equal(updated.text, 'the');
  assert.equal(updated.provider, 'baidu');
  assert.equal(updated.language, 'en');
  assert.equal(updated.sourceUrl, 'https://example.test/page');
  assert.equal(updated.sourceTitle, 'Example');
});

test('concurrent formal saves compare their original body inside the write queue', async () => {
  const original = { id: 'shared', text: 'Original', timestamp: 1, favorite: true,
    name: 'Important', draft: { text: 'Another draft', baseText: 'Original', updatedAt: 1 },
    translation: { sourceText: 'Original', text: '翻译' } };
  const storage = createMemoryStorage([original], 5);
  const store = create(storage);
  const first = store.updateText('shared', 'First correction', 'Original');
  const stale = store.updateText('shared', 'Stale correction', 'Original');
  assert.equal(await first, true);
  await assert.rejects(stale, { code: 'HISTORY_TEXT_CONFLICT' });
  assert.deepEqual(storage.snapshot(), [{ ...original, text: 'First correction' }]);
});

test('formal saves require an explicit baseline and still allow reopening the latest text', async () => {
  const original = { id: 'shared', text: 'Original', timestamp: 1 };
  const storage = createMemoryStorage([original]);
  const store = create(storage);
  await assert.rejects(store.updateText('shared', 'Unsafe edit'), { code: 'HISTORY_TEXT_INVALID' });
  await assert.rejects(store.updateText('shared', {}, 'Original'), { code: 'HISTORY_TEXT_INVALID' });
  assert.deepEqual(storage.snapshot(), [original]);
  await store.updateText('shared', ' First correction ', 'Original');
  await store.updateText('shared', 'Reviewed correction', 'First correction');
  assert.equal((await store.get('shared')).text, 'Reviewed correction');
  assert.equal(await store.updateText('missing', 'Unstored', 'Original'), false);
});

test('delete removes only the requested record', async () => {
  const storage = createMemoryStorage([
    { id: 'a', text: 'Alpha', timestamp: 1 },
    { id: 'b', text: 'Beta', timestamp: 2 }
  ]);
  const store = create(storage);

  assert.equal(await store.delete('a'), true);
  assert.equal(await store.delete('missing'), false);
  assert.deepEqual((await store.list()).map((item) => item.id), ['b']);
});

test('search matches text and source metadata case-insensitively', async () => {
  const storage = createMemoryStorage([
    {
      id: 'a',
      text: 'Invoice 2026',
      timestamp: 1,
      provider: 'baidu',
      sourceTitle: 'Quarterly REPORT',
      sourceUrl: 'https://example.test/report'
    },
    {
      id: 'b',
      text: 'Meeting notes',
      timestamp: 2,
      provider: 'openai',
      sourceTitle: 'Notes',
      sourceUrl: 'https://example.test/notes'
    }
  ]);
  const store = create(storage);

  assert.deepEqual((await store.search('invoice')).map((item) => item.id), ['a']);
  assert.deepEqual((await store.search('report')).map((item) => item.id), ['a']);
  assert.deepEqual((await store.search('OPENAI')).map((item) => item.id), ['b']);
  assert.equal((await store.search('')).length, 2);
});

test('retention limit keeps the newest records', async () => {
  const storage = createMemoryStorage();
  const store = create(storage, { limit: 3 });

  for (let index = 1; index <= 5; index += 1) {
    await store.append({
      id: `record-${index}`,
      text: `Text ${index}`,
      timestamp: index
    });
  }

  assert.deepEqual(
    (await store.list()).map((item) => item.id),
    ['record-5', 'record-4', 'record-3']
  );
});

test('aborted append does not persist a record', async () => {
  const storage = createMemoryStorage([], 5);
  const store = create(storage);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    store.append({ id: 'cancelled', text: 'Do not save', timestamp: 1 }, controller.signal),
    (error) => error?.name === 'AbortError'
  );
  assert.deepEqual(storage.snapshot(), []);
});

test('aborting after a full history write restores the exact pre-image', async () => {
  const original = Array.from({ length: 50 }, (_, index) => ({
    id: `old-${index}`,
    text: `Old ${index}`,
    timestamp: 100 - index
  }));
  const controller = new AbortController();
  let history = structuredClone(original);
  let writes = 0;
  const storage = {
    async get() {
      return { ocrHistory: structuredClone(history) };
    },
    async set(value) {
      history = structuredClone(value.ocrHistory);
      writes += 1;
      if (writes === 1) controller.abort();
    }
  };
  const store = create(storage, { limit: 50 });

  await assert.rejects(
    store.append({ id: 'new', text: 'New', timestamp: 999 }, controller.signal),
    (error) => error?.name === 'AbortError'
  );
  assert.deepEqual(history, original);
  assert.equal(writes, 2);
});
