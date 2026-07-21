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
  assert.equal(await store.updateText(record.id, 'the'), true);

  const [updated] = await store.list();
  assert.equal(updated.text, 'the');
  assert.equal(updated.provider, 'baidu');
  assert.equal(updated.language, 'en');
  assert.equal(updated.sourceUrl, 'https://example.test/page');
  assert.equal(updated.sourceTitle, 'Example');
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
