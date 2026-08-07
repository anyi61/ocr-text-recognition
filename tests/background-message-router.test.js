'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../background-message-router.js');

test('message router dispatches a registered action and preserves async-channel intent', () => {
  let received;
  const dispatch = create({
    known(request, sender, sendResponse) {
      received = { request, sender };
      sendResponse({ success: true });
      return true;
    }
  });
  let response;
  assert.equal(dispatch({ action: 'known' }, { id: 1 }, (value) => { response = value; }), true);
  assert.deepEqual(received, { request: { action: 'known' }, sender: { id: 1 } });
  assert.deepEqual(response, { success: true });
});

test('message router reports unknown actions and sync failures with stable codes', () => {
  const dispatch = create({ broken() { throw new Error('private detail'); } });
  const responses = [];
  assert.equal(dispatch({ action: 'missing' }, {}, (value) => responses.push(value)), false);
  assert.equal(dispatch({ action: 'broken' }, {}, (value) => responses.push(value)), false);
  assert.deepEqual(responses, [
    { success: false, error: 'UNKNOWN_ACTION' },
    { success: false, error: 'MESSAGE_HANDLER_FAILED' }
  ]);
});
