'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const draftUI = require('../draft-ui.js');
const translationUI = require('../translation-ui.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function draftHarness(sendMessage) {
  let text = 'Original';
  let baseline = 'Original';
  const changes = [];
  const messages = [];
  const restored = [];
  const session = draftUI.createSession({
    historyId: 'record-1', getText: () => text, getSavedText: () => baseline,
    setText: (value) => { text = value; }, createOwnerId: () => 'editor-1',
    sendMessage: (message) => { messages.push(message); return sendMessage(message); },
    onChange: (state) => changes.push(state), onRestore: (value) => restored.push(value)
  });
  return { session, messages, changes, restored, get text() { return text; },
    input(value) { text = value; return session.notifySourceChanged(); },
    setBaseline(value) { baseline = value; } };
}

test('restored stored draft requires explicit restore and keeps the formal history baseline', async () => {
  const draft = { text: 'Recovered', baseText: 'Original', updatedAt: 5 };
  const harness = draftHarness(async (message) => message.action === 'getHistoryRecord'
    ? { success: true, record: { text: 'Original', draft } }
    : { success: true, draft, draftUpdatedAt: 6 });
  await harness.session.ready;
  assert.equal(harness.session.getState().status, 'available');
  assert.equal(harness.text, 'Original');
  assert.equal(harness.session.restore(), true);
  assert.equal(harness.text, 'Recovered');
  assert.deepEqual(harness.restored, ['Recovered']);
  assert.deepEqual(harness.messages[1], { action: 'saveHistoryDraft', historyId: 'record-1',
    text: 'Recovered', baseText: 'Original', ownerId: 'editor-1', expectedUpdatedAt: 5 });
  harness.session.destroy();
});

test('restored every draft input dispatches immediately, including the final input before destruction', async () => {
  const pending = deferred();
  const harness = draftHarness((message) => message.action === 'getHistoryRecord'
    ? Promise.resolve({ success: true, record: { text: 'Original' } }) : pending.promise);
  await harness.session.ready;
  const first = harness.input('A');
  const final = harness.input('AB');
  assert.deepEqual(harness.messages.filter((item) => item.action === 'saveHistoryDraft').map((item) => item.text), ['A', 'AB']);
  harness.session.destroy();
  const count = harness.changes.length;
  pending.resolve({ success: true, draft: { text: 'AB', baseText: 'Original', updatedAt: 7 } });
  await Promise.all([first, final]);
  assert.equal(harness.changes.length, count);
});

test('restored delayed initial reads cannot expose an obsolete draft after fresh input', async () => {
  const read = deferred();
  const harness = draftHarness((message) => message.action === 'getHistoryRecord' ? read.promise
    : Promise.resolve({ success: true, draft: { text: message.text, baseText: message.baseText, updatedAt: 2 } }));
  await harness.input('Newest input');
  read.resolve({ success: true, record: { text: 'Original', draft: { text: 'Obsolete', baseText: 'Original', updatedAt: 1 } } });
  await harness.session.ready;
  assert.equal(harness.text, 'Newest input');
  assert.equal(harness.session.getState().status, 'saved');
  assert.equal(harness.session.restore(), false);
});

test('restored out-of-order acknowledgements cannot mark a failed latest draft save successful', async () => {
  const writes = [deferred(), deferred()];
  let index = 0;
  const harness = draftHarness((message) => message.action === 'getHistoryRecord'
    ? Promise.resolve({ success: true, record: { text: 'Original' } }) : writes[index++].promise);
  await harness.session.ready;
  const first = harness.input('First');
  const second = harness.input('Second');
  writes[1].resolve({ success: false, errorCode: 'HISTORY_WRITE_FAILED' });
  await second;
  writes[0].resolve({ success: true, draft: { text: 'First', baseText: 'Original', updatedAt: 2 } });
  await first;
  assert.equal(harness.session.getState().status, 'error');
  assert.equal(harness.text, 'Second');
});

test('restored duplicate input and formal baseline updates cannot clear another editor draft', async () => {
  const harness = draftHarness(async (message) => message.action === 'getHistoryRecord'
    ? { success: true, record: { text: 'Original' } }
    : { success: true, draft: { text: message.text, baseText: message.baseText, updatedAt: 3 } });
  await harness.session.ready;
  await harness.input('Edited');
  await harness.session.notifySourceChanged();
  harness.setBaseline('Edited');
  await harness.session.notifySourceChanged();
  assert.equal(harness.messages.filter((message) => message.action === 'saveHistoryDraft').length, 1);
});

test('restored changed formal source becomes a conflict without replacing editor text', async () => {
  const harness = draftHarness(async () => ({ success: true, record: { text: 'Changed elsewhere',
    draft: { text: 'Another edit', baseText: 'Changed elsewhere', updatedAt: 9 } } }));
  await harness.session.ready;
  assert.equal(harness.session.getState().status, 'conflict');
  assert.equal(harness.text, 'Original');
  assert.equal(harness.session.restore(), false);
});

test('restored stale discard includes the exact draft revision and preserves input on conflict', async () => {
  const harness = draftHarness(async (message) => message.action === 'getHistoryRecord'
    ? { success: true, record: { text: 'Original', draft: { text: 'Recovered', baseText: 'Original', updatedAt: 9 } } }
    : { success: false, errorCode: 'HISTORY_DRAFT_CONFLICT' });
  await harness.session.ready;
  assert.equal(await harness.session.discard(), false);
  assert.equal(harness.messages.at(-1).expectedUpdatedAt, 9);
  assert.equal(harness.text, 'Original');
  assert.equal(harness.session.getState().status, 'conflict');
});

test('restored successful discard resets a recovered editor and advances the observed tombstone revision', async () => {
  const draft = { text: 'Recovered', baseText: 'Original', updatedAt: 9 };
  const harness = draftHarness(async (message) => {
    if (message.action === 'getHistoryRecord') return { success: true, record: { text: 'Original', draft } };
    if (message.action === 'discardHistoryDraft') return { success: true, draftUpdatedAt: 11 };
    return { success: true, draft, draftUpdatedAt: 10 };
  });
  await harness.session.ready;
  harness.session.restore();
  await Promise.resolve();
  assert.equal(await harness.session.discard(), true);
  assert.equal(harness.text, 'Original');
  await harness.input('Next edit');
  assert.equal(harness.messages.at(-1).expectedUpdatedAt, 11);
});

test('restored draft read failures remain actionable and destroying a pending read blocks recovery', async () => {
  const failed = draftHarness(async () => { throw new Error('storage internals'); });
  await failed.session.ready;
  assert.equal(failed.session.getState().errorCode, 'HISTORY_READ_FAILED');
  const read = deferred();
  const pending = draftHarness(() => read.promise);
  pending.session.destroy();
  const before = pending.changes.length;
  read.resolve({ success: true, record: { text: 'Original', draft: { text: 'Lost', baseText: 'Original' } } });
  await pending.session.ready;
  assert.equal(pending.changes.length, before);
  assert.equal(pending.session.restore(), false);
  assert.equal(await pending.session.discard(), false);
});

function eventHook() {
  const listeners = new Set();
  return { addListener(listener) { listeners.add(listener); }, removeListener(listener) { listeners.delete(listener); },
    emit(value) { for (const listener of listeners) listener(value); } };
}

function translationHarness() {
  let snapshot = { text: 'Original', provider: 'openai', targetLanguage: 'en', historyId: 'record-1' };
  const messages = [];
  const changes = [];
  const persisted = [];
  let connects = 0;
  let disconnects = 0;
  let requestId = 0;
  const port = { onMessage: eventHook(), onDisconnect: eventHook(),
    postMessage: (message) => messages.push(message), disconnect: () => { disconnects += 1; } };
  const session = translationUI.createSession({ getSnapshot: () => ({ ...snapshot }),
    connect: () => { connects += 1; return port; }, createRequestId: () => `task-${++requestId}`,
    onChange: (state) => changes.push(state), onPersisted: (value) => persisted.push(value) });
  return { session, port, messages, changes, persisted, get connects() { return connects; },
    get disconnects() { return disconnects; }, update(patch) { snapshot = { ...snapshot, ...patch }; session.notifySourceChanged(); },
    success(extra = {}) { port.onMessage.emit({ action: 'translationResult', requestId: `task-${requestId}`,
      success: true, text: 'Translated', provider: snapshot.provider, targetLanguage: snapshot.targetLanguage, ...extra }); } };
}

test('restored translation requires explicit start and successful output leaves source untouched', () => {
  const harness = translationHarness();
  assert.equal(harness.connects, 0);
  assert.equal(harness.session.start(), true);
  assert.equal(harness.session.start(), false);
  assert.deepEqual(harness.messages[0], { action: 'translate', requestId: 'task-1',
    text: 'Original', provider: 'openai', targetLanguage: 'en', historyId: 'record-1' });
  harness.success();
  assert.equal(harness.session.getState().status, 'success');
  assert.equal(harness.session.getState().sourceText, 'Original');
});

for (const patch of [{ text: 'New source' }, { provider: 'claude' }, { targetLanguage: 'ja' }]) {
  test(`restored translation cancels and ignores a late result after changing ${Object.keys(patch)[0]}`, () => {
    const harness = translationHarness();
    harness.session.start();
    harness.update(patch);
    assert.deepEqual(harness.messages.at(-1), { action: 'cancel', requestId: 'task-1' });
    harness.success();
    assert.equal(harness.session.getState().text, '');
    assert.equal(harness.session.getState().status, 'stale');
    assert.equal(harness.session.start(), true);
    harness.success();
    assert.equal(harness.session.getState().status, 'success');
  });
}

test('restored manual translation cancellation blocks stale replies and allows explicit retry', () => {
  const harness = translationHarness();
  harness.session.start();
  harness.session.cancel();
  harness.success();
  assert.equal(harness.session.getState().status, 'cancelled');
  assert.equal(harness.session.getState().text, '');
  harness.session.start();
  harness.port.onMessage.emit({ action: 'translationResult', requestId: 'task-1', success: true, text: 'Stale' });
  assert.equal(harness.session.getState().status, 'translating');
  harness.success();
  assert.equal(harness.session.getState().text, 'Translated');
});

test('restored invalid provider, target and persisted source snapshots cannot be presented as valid output', () => {
  for (const patch of [{ provider: 'claude' }, { targetLanguage: 'fr' }, { translation: {
    text: 'Translated', sourceText: 'Different', provider: 'openai', targetLanguage: 'en' } }]) {
    const harness = translationHarness();
    harness.session.start();
    harness.success({ ...patch, persisted: true });
    assert.equal(harness.session.getState().errorCode, 'TRANSLATION_RESULT_INVALID');
    assert.equal(harness.session.getState().text, '');
    assert.equal(harness.persisted.length, 0);
  }
});

test('restored saved translations restore with no connection and only confirmed persistence notifies the owner', () => {
  const harness = translationHarness();
  const snapshot = { sourceText: 'Original', text: 'Saved translation', provider: 'openai', targetLanguage: 'en', model: 'old-model', timestamp: 3 };
  assert.equal(harness.session.restore(snapshot), true);
  assert.equal(harness.connects, 0);
  assert.equal(harness.session.getState().persisted, true);
  harness.update({ text: 'Edited' });
  assert.equal(harness.session.getState().status, 'stale');
  harness.session.start();
  harness.success({ persisted: true, translation: { ...snapshot, text: 'Translated', sourceText: 'Edited' } });
  assert.equal(harness.persisted.length, 1);
  assert.equal(harness.persisted[0].sourceText, 'Edited');
  harness.session.start();
  harness.success({ persisted: false });
  assert.equal(harness.persisted.length, 1);
});

test('restored cancelling or failing replacement translation preserves the prior saved output', () => {
  const harness = translationHarness();
  harness.session.restore({ sourceText: 'Original', text: 'Previous', provider: 'openai', targetLanguage: 'en' });
  harness.session.start();
  harness.session.cancel();
  assert.equal(harness.session.getState().text, 'Previous');
  harness.session.start();
  harness.port.onMessage.emit({ action: 'translationResult', requestId: 'task-2', success: false, errorCode: 'API_RATE_LIMITED' });
  assert.equal(harness.session.getState().text, 'Previous');
  assert.equal(harness.session.getState().errorCode, 'API_RATE_LIMITED');
});

test('restored translation connection loss is retryable and destroy cancels and disconnects once', () => {
  const harness = translationHarness();
  harness.session.start();
  harness.port.onDisconnect.emit();
  assert.equal(harness.session.getState().errorCode, 'TRANSLATION_CONNECTION_LOST');
  assert.equal(harness.session.start(), true);
  assert.equal(harness.connects, 2);
  harness.session.destroy();
  harness.session.destroy();
  assert.equal(harness.disconnects, 1);
  assert.deepEqual(harness.messages.at(-1), { action: 'cancel', requestId: 'task-2' });
  const changes = harness.changes.length;
  harness.success();
  assert.equal(harness.changes.length, changes);
  assert.equal(harness.session.start(), false);
});
