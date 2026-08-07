'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../popup/runtime.js');

const history = [
  { id: '1', text: 'Invoice total', provider: 'openai', language: 'en', sourceTitle: 'Billing' },
  { id: '2', text: '中文结果', provider: 'baidu', language: 'zh', sourceUrl: 'https://example.test' }
];

test('popup history filter searches text and source metadata without mutating input', () => {
  assert.deepEqual(runtime.filterHistory(history, 'BILL'), [history[0]]);
  assert.deepEqual(runtime.filterHistory(history, 'example.test'), [history[1]]);
  assert.notEqual(runtime.filterHistory(history, ''), history);
});

test('popup history source prefers title and timestamps have a legacy fallback', () => {
  assert.equal(runtime.getHistorySource(history[0]), 'Billing');
  assert.equal(runtime.getHistorySource(history[1]), 'https://example.test');
  assert.equal(runtime.formatHistoryTimestamp({ date: 'legacy' }, 'en'), 'legacy');
});
