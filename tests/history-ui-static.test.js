'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

test('result popup can persist corrected OCR text to its history record', () => {
  const content = read('content.js');

  assert.match(content, /showResultPopup\(ocrResponse\.text,\s*ocrResponse\.historyId\)/);
  assert.match(content, /action:\s*'updateHistoryRecord'/);
  assert.match(content, /historyId/);
  assert.match(content, /content_btn_save_changes/);
});

test('popup exposes searchable, deletable, exportable history controls', () => {
  const html = read('popup.html');
  const popup = read('popup.js');

  for (const id of ['historySearch', 'exportHistoryBtn', 'historySearchEmptyState']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(popup, /action:\s*'deleteHistoryRecord'/);
  assert.match(popup, /action:\s*'clearHistory'/);
  assert.match(popup, /new Blob\(/);
  assert.match(popup, /sourceTitle/);
  assert.match(popup, /sourceUrl/);
});

test('popup reads serialized history through the worker and refreshes on storage changes', () => {
  const popup = read('popup.js');
  const background = read('background.js');

  assert.match(popup, /action:\s*'listHistory'/);
  assert.match(popup, /chrome\.storage\.onChanged\.addListener/);
  assert.match(popup, /changes\.ocrHistory/);
  assert.match(background, /listHistory\(_request, _sender, sendResponse\)/);
  assert.match(background, /historyStore\.list\(\)/);
});

test('history rendering assigns untrusted text through DOM properties', () => {
  const popup = read('popup.js');

  assert.doesNotMatch(popup, /title="\$\{escapeHtml\(/);
  assert.match(popup, /textElement\.textContent = text/);
  assert.match(popup, /textElement\.title = text/);
  assert.match(popup, /sourceElement\.textContent = source/);
  assert.match(popup, /sourceElement\.title = item\.sourceUrl \|\| source/);
});

test('history timestamps are rendered from timestamp using the active UI locale', () => {
  const popup = read('popup.js');
  const runtime = read('popup/runtime.js');

  assert.match(popup, /OCRI18n\.getResolvedLanguage\(\)/);
  assert.match(runtime, /Intl\.DateTimeFormat/);
  assert.match(runtime, /item\?\.timestamp/);
});

test('popup passes complete tab context and explains unsupported pages', () => {
  const popup = read('popup.js');

  assert.match(popup, /startCaptureInTab\(chrome,\s*tab\)/);
  assert.match(popup, /UNSUPPORTED_PAGE/);
  assert.match(popup, /msg_capture_browser_internal/);
  assert.match(popup, /msg_capture_browser_store/);
});

test('new history workflow strings exist in both locale catalogs', () => {
  const catalogs = ['zh_CN', 'en'].map((locale) => JSON.parse(
    read(path.join('_locales', locale, 'messages.json'))
  ));
  const keys = [
    'history_search_placeholder',
    'history_search_empty',
    'history_export',
    'history_delete',
    'history_source',
    'history_provider',
    'history_language',
    'content_btn_save_changes',
    'content_btn_saved',
    'content_msg_changes_saved',
    'content_msg_changes_save_failed',
    'msg_capture_browser_internal',
    'msg_capture_browser_store'
  ];

  for (const key of keys) {
    assert.ok(catalogs.every((catalog) => catalog[key]), `missing locale key: ${key}`);
  }
});
