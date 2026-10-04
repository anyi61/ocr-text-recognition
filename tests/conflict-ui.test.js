const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../conflict-ui.js');

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness(sendMessage) {
  let id = 'original';
  let text = 'Local edits';
  const rebased = [];
  const saved = [];
  const busy = [];
  const session = createSession({ getHistoryId: () => id, getText: () => text, sendMessage,
    onRebase: (record) => rebased.push(record),
    onSavedAsNew: (record, snapshot) => { saved.push({ record, snapshot, live: text }); id = record.id; },
    onBusyChange: (value) => busy.push(value) });
  return { session, rebased, saved, busy, setText: (value) => { text = value; }, setId: (value) => { id = value; } };
}

test('comparison reads never replace typing and adopting the baseline does not write history', async () => {
  const pending = deferred();
  const messages = [];
  const h = harness((message) => { messages.push(message); return pending.promise; });
  const loading = h.session.open();
  h.setText('Typed while comparison loads');
  pending.resolve({ success: true, record: { id: 'original', text: 'Latest saved' } });
  await loading;
  assert.equal(h.session.getState().record.text, 'Latest saved');
  assert.equal(h.session.rebase(), true);
  assert.deepEqual(h.rebased, [{ id: 'original', text: 'Latest saved' }]);
  assert.deepEqual(messages, [{ action: 'getHistoryRecord', historyId: 'original' }]);
  assert.equal(h.session.getState().visible, false);
});

test('closing or switching history invalidates delayed comparison reads', async () => {
  for (const action of ['close', 'switch', 'destroy']) {
    const pending = deferred();
    const h = harness(() => pending.promise);
    const loading = h.session.open();
    if (action === 'switch') h.setId('another');
    else h.session[action]();
    pending.resolve({ success: true, record: { id: 'original', text: 'Old response' } });
    await loading;
    assert.equal(h.session.getState().record, null);
    assert.equal(h.session.rebase(), false);
  }
});

test('newer refresh takes precedence and failed reads retain a visibly stale snapshot without enabling rebase', async () => {
  const pending = [];
  const h = harness(() => { const read = deferred(); pending.push(read); return read.promise; });
  const first = h.session.open();
  const second = h.session.refresh();
  pending[1].resolve({ success: true, record: { id: 'original', text: 'Newer' } }); await second;
  pending[0].resolve({ success: true, record: { id: 'original', text: 'Older' } }); await first;
  assert.equal(h.session.getState().record.text, 'Newer');
  const failed = h.session.refresh();
  assert.equal(h.session.rebase(), false);
  pending[2].resolve({ success: false, errorCode: 'HISTORY_READ_FAILED' }); await failed;
  assert.equal(h.session.getState().status, 'read-error');
  assert.equal(h.session.getState().record.text, 'Newer');
  assert.equal(h.session.rebase(), false);
});

test('deleted history can be saved as a distinct record and keeps input typed while the save waits', async () => {
  const write = deferred();
  const messages = [];
  const h = harness((message) => {
    messages.push(message);
    return message.action === 'getHistoryRecord'
      ? Promise.resolve({ success: false, errorCode: 'HISTORY_RECORD_MISSING' }) : write.promise;
  });
  await h.session.open();
  assert.equal(h.session.getState().status, 'missing');
  assert.equal(h.session.rebase(), false);
  const saving = h.session.saveAsNew();
  assert.equal(await h.session.saveAsNew(), false);
  h.setText('More recent local input');
  h.session.close();
  write.resolve({ success: true, record: { id: 'new', text: 'Local edits' } });
  assert.equal(await saving, true);
  assert.deepEqual(h.saved, [{ record: { id: 'new', text: 'Local edits' }, snapshot: 'Local edits', live: 'More recent local input' }]);
  assert.deepEqual(h.busy, [true, false]);
  assert.deepEqual(messages[1], { action: 'saveHistoryAsNew', sourceId: 'original', text: 'Local edits' });
});

test('external formal saves disable rebase and save-as-new while keeping comparison readable', async () => {
  const h = harness(async () => ({ success: true, record: { id: 'original', text: 'Latest' } }));
  await h.session.open();
  h.session.setBusy(true);
  assert.equal(h.session.rebase(), false);
  assert.equal(await h.session.saveAsNew(), false);
  h.session.setBusy(false);
  assert.equal(h.session.rebase(), true);
});

test('failed new-record saves preserve text and allow retry without changing the source association', async () => {
  let attempts = 0;
  const h = harness(async (message) => message.action === 'getHistoryRecord'
    ? { success: true, record: { id: 'original', text: 'Latest' } }
    : (++attempts === 1 ? { success: false, errorCode: 'HISTORY_WRITE_FAILED' }
      : { success: true, record: { id: 'new', text: 'Local edits' } }));
  await h.session.open();
  assert.equal(await h.session.saveAsNew(), false);
  assert.equal(h.session.getState().status, 'save-error');
  assert.deepEqual(h.saved, []);
  assert.equal(await h.session.saveAsNew(), true);
  assert.equal(h.saved.length, 1);
});

test('destroyed or switched editors ignore an old successful new-record acknowledgement', async () => {
  for (const mode of ['destroy', 'switch']) {
    const write = deferred();
    const h = harness((message) => message.action === 'getHistoryRecord'
      ? Promise.resolve({ success: true, record: { id: 'original', text: 'Latest' } }) : write.promise);
    await h.session.open();
    const saving = h.session.saveAsNew();
    if (mode === 'destroy') h.session.destroy(); else h.setId('different');
    write.resolve({ success: true, record: { id: 'new', text: 'Local edits' } });
    assert.equal(await saving, false);
    assert.deepEqual(h.saved, []);
  }
});
