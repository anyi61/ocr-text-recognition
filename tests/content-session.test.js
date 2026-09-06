'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../content/session.js');

function harness() {
  let selectionHooks;
  let pipelineHooks;
  let noticeHooks;
  let starts = 0;
  let destroyed = 0;
  let sequence = 0;
  const messages = [];
  const pending = [];
  let accept = async () => true;
  const session = create({
    document: {}, window: { matchMedia: () => ({ matches: false }) },
    chrome: { runtime: { async sendMessage(message) { messages.push(message); return { theme: 'light' }; } } },
    i18n: { t: key => key }, captureUtils: { createRequestId: () => `session-${++sequence}` },
    selectionModule: { create(hooks) {
      selectionHooks = hooks;
      return { start() { starts++; }, destroy() {}, clear() {}, getRect: () => ({ left: 1, top: 2, width: 100, height: 80 }) };
    } },
    noticeModule: { create(hooks) {
      noticeHooks = hooks;
      return { confirm: id => accept(id), isOpen: () => false, destroy() {}, showNotification() {} };
    } },
    resultModule: { create: () => ({ destroy() {}, show() {} }) },
    pipelineModule: { create(hooks) {
      pipelineHooks = hooks;
      return { run(rect, id) {
        hooks.setActiveRequestId(`request-${id}`);
        return new Promise(resolve => pending.push({ id, rect, finish() { hooks.finish(id, `request-${id}`); resolve(); } }));
      } };
    } },
    onDestroy() { destroyed++; }
  });
  return { session, messages, pending, selectionHooks, pipelineHooks, noticeHooks,
    setAccept(fn) { accept = fn; }, starts: () => starts, destroyed: () => destroyed };
}

test('replacement owns request cancellation and stale completion cannot clear the new request', async () => {
  const h = harness();
  h.session.start();
  const first = h.selectionHooks.confirmSelection({ isTrusted: true });
  await Promise.resolve();
  h.session.start();
  const second = h.selectionHooks.confirmSelection({ isTrusted: true });
  await Promise.resolve();
  assert.equal(h.pending.length, 2);
  assert.equal(h.noticeHooks.isCurrentSession('session-1'), false);
  assert.equal(h.noticeHooks.isCurrentSession('session-2'), true);
  assert.deepEqual(h.messages.filter(m => m.action === 'cancelOCR'), [{ action: 'cancelOCR', requestId: 'request-session-1' }]);
  h.pending[0].finish();
  await first;
  assert.equal(h.pipelineHooks.getActiveRequestId(), 'request-session-2');
  h.pending[1].finish();
  await second;
  assert.equal(h.pipelineHooks.getActiveRequestId(), null);
});

test('destroy is idempotent, cancels only its instance and rejects a subsequent start', async () => {
  const a = harness();
  const b = harness();
  a.session.start(); b.session.start();
  const first = a.selectionHooks.confirmSelection({ isTrusted: true });
  const second = b.selectionHooks.confirmSelection({ isTrusted: true });
  await Promise.resolve();
  a.session.destroy(); a.session.destroy(); a.session.start();
  assert.equal(a.destroyed(), 1);
  assert.equal(a.starts(), 1);
  assert.equal(a.messages.filter(m => m.action === 'cancelOCR').length, 1);
  assert.equal(b.messages.filter(m => m.action === 'cancelOCR').length, 0);
  assert.equal(b.noticeHooks.isCurrentSession('session-1'), true);
  a.pending[0].finish(); b.pending[0].finish();
  await Promise.all([first, second]);
});

test('late consent after destruction cannot begin a pipeline or revive a session', async () => {
  const h = harness();
  let accept;
  h.setAccept(() => new Promise(resolve => { accept = resolve; }));
  h.session.start();
  const confirmation = h.selectionHooks.confirmSelection({ isTrusted: true });
  h.session.destroy();
  accept(true);
  await confirmation;
  assert.equal(h.pending.length, 0);
  assert.equal(h.noticeHooks.isCurrentSession('session-1'), false);
});
