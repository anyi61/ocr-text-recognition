'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../history-store.js');
const { createSession } = require('../draft-ui.js');

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function harness() {
  let data = [{ id: 'record', text: 'Original' }];
  let beforeWrite = async () => {};
  let afterRead = async () => {};
  const store = create({
    async get() { return { ocrHistory: structuredClone(data) }; },
    async set(patch) { await beforeWrite(patch); data = structuredClone(patch.ocrHistory); }
  });
  const editor = (ownerId) => {
    let text = 'Original';
    const session = createSession({ historyId: 'record', getText: () => text, getSavedText: () => 'Original',
      setText: (value) => { text = value; }, createOwnerId: () => ownerId, onChange() {},
      async sendMessage(message) {
        try {
          if (message.action === 'getHistoryRecord') {
            const record = await store.get(message.historyId);
            await afterRead(record);
            return { success: true, record };
          }
          if (message.action === 'saveHistoryDraft') return await store.saveDraft(message.historyId, message, message);
          if (message.action === 'discardHistoryDraft') {
            return await store.discardDraft(message.historyId, message.expectedUpdatedAt, message.ownerId);
          }
          throw new Error('Unexpected message');
        } catch (error) { return { success: false, errorCode: error.code || 'HISTORY_WRITE_FAILED' }; }
      }
    });
    return { session, get text() { return text; }, input(value) { text = value; return session.notifySourceChanged(); } };
  };
  return { store, editor, beforeWrite(fn) { beforeWrite = fn; }, afterRead(fn) { afterRead = fn; } };
}

test('save-as-new pauses writes to the source draft and resumes retained input after a failed copy', async () => {
  const h = harness();
  const editor = h.editor('first');
  await editor.session.ready;
  await editor.input('Source draft snapshot');
  const original = await h.store.get('record');
  editor.session.setPaused(true);
  await editor.input('Input belonging to the pending new record');
  assert.deepEqual(await h.store.get('record'), original);
  assert.equal(await editor.session.discard(), false);
  editor.session.setPaused(false);
  const restored = await h.store.get('record');
  assert.equal(restored.draft.text, 'Input belonging to the pending new record');
});

test('input dispatched during discard survives immediate editor closure and is recoverable', async () => {
  const h = harness();
  const first = h.editor('first');
  await first.session.ready;
  await first.input('Discard this draft');
  const waiting = deferred();
  const release = deferred();
  h.beforeWrite(async (patch) => {
    if (!patch.ocrHistory[0].draft) { waiting.resolve(); await release.promise; }
  });
  const discard = first.session.discard();
  await waiting.promise;
  const save = first.input('Keep the newest input');
  first.session.destroy();
  release.resolve();
  await Promise.all([discard, save]);
  const record = await h.store.get('record');
  assert.equal(record.text, 'Original');
  assert.equal(record.draft.text, 'Keep the newest input');
  const reopened = h.editor('reopened');
  await reopened.session.ready;
  assert.equal(reopened.session.getState().status, 'available');
  assert.equal(reopened.session.restore(), true);
  assert.equal(reopened.text, 'Keep the newest input');
});

test('refresh after an unsuccessful draft write never labels unsaved input idle', async () => {
  const h = harness();
  const editor = h.editor('first');
  await editor.session.ready;
  h.beforeWrite(async () => { throw new Error('Storage unavailable'); });
  await editor.input('Unsaved input');
  h.beforeWrite(async () => {});
  await editor.session.refresh();
  assert.equal(editor.session.getState().status, 'error');
  assert.equal(editor.text, 'Unsaved input');
  assert.equal((await h.store.get('record')).draft, undefined);
  await editor.session.retry();
  assert.equal(editor.session.getState().status, 'saved');
  assert.equal((await h.store.get('record')).draft.text, 'Unsaved input');
});

test('retry after another editor discards its conflicting draft saves the retained local input', async () => {
  const h = harness();
  const first = h.editor('first');
  const second = h.editor('second');
  await Promise.all([first.session.ready, second.session.ready]);
  await first.input('Competing draft');
  await second.input('Local input to recover');
  assert.equal(second.session.getState().status, 'conflict');
  await first.session.discard();
  await second.session.retry();
  assert.equal(second.session.getState().status, 'saved');
  assert.equal((await h.store.get('record')).draft.text, 'Local input to recover');
});

test('retry never replaces a competing draft still present in another editor', async () => {
  const h = harness();
  const first = h.editor('first');
  const second = h.editor('second');
  await Promise.all([first.session.ready, second.session.ready]);
  await first.input('Competing draft');
  await second.input('Local input to recover');
  await second.session.retry();
  assert.equal(second.text, 'Local input to recover');
  assert.equal(second.session.getState().status, 'available');
  assert.equal((await h.store.get('record')).draft.text, 'Competing draft');
});

test('discarding a competing draft keeps different local input visibly unsaved until retried', async () => {
  const h = harness();
  const first = h.editor('first');
  const second = h.editor('second');
  await Promise.all([first.session.ready, second.session.ready]);
  await first.input('Competing draft');
  await second.input('Local input to recover');
  await second.session.retry();
  await second.session.discard();
  assert.equal(second.text, 'Local input to recover');
  assert.equal(second.session.getState().status, 'error');
  assert.equal((await h.store.get('record')).draft, undefined);
  await second.session.retry();
  assert.equal(second.session.getState().status, 'saved');
  assert.equal((await h.store.get('record')).draft.text, 'Local input to recover');
});

test('a competing draft created after the recovery read remains protected by revision checks', async () => {
  const h = harness();
  const first = h.editor('first');
  const second = h.editor('second');
  await Promise.all([first.session.ready, second.session.ready]);
  await first.input('Competing draft');
  await second.input('Local input to recover');
  await first.session.discard();
  const read = deferred();
  const release = deferred();
  h.afterRead(async () => { read.resolve(); await release.promise; });
  const retry = second.session.retry();
  await read.promise;
  await first.input('New competing draft');
  release.resolve();
  await retry;
  assert.equal(second.session.getState().status, 'conflict');
  assert.equal(second.text, 'Local input to recover');
  assert.equal((await h.store.get('record')).draft.text, 'New competing draft');
});
