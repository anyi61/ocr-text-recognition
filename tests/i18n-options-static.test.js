'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const locale = (name) => JSON.parse(read(`_locales/${name}/messages.json`));

test('provider options and popup accessibility labels are localizable', () => {
  const optionsHtml = read('options.html');
  const popupHtml = read('popup.html');

  for (const provider of ['claude', 'openai', 'zhipu', 'baidu', 'aliyun', 'openai-compatible', 'custom']) {
    assert.match(optionsHtml, new RegExp(`<option value="${provider}" data-i18n="provider_`));
  }
  assert.match(popupHtml, /id="historyPreviewText"[^>]*data-i18n-aria="history_preview_aria"/);
  assert.match(popupHtml, /id="languageSelect"[^>]*data-i18n-aria="label_ui_language"/);
});

test('options and popup use translated messages for import/export and file access failures', () => {
  const optionsJs = read('options.js');
  const popupJs = read('popup.js');

  for (const key of ['msg_export_failed', 'msg_import_failed', 'modal_import_title', 'modal_import_message', 'modal_import_warning', 'modal_api_provider', 'modal_export_date']) {
    assert.match(optionsJs, new RegExp(`OCRI18n\\.t\\('${key}'`));
  }
  assert.match(popupJs, /error\.reason === 'file_access'/);
  assert.match(popupJs, /\? 'msg_capture_file_access'/);
  assert.match(popupJs, /alert\(OCRI18n\.t\(key\)\)/);
});

test('locales carry every options and popup regression key', () => {
  const required = [
    'provider_claude', 'provider_openai', 'provider_zhipu', 'provider_baidu',
    'provider_aliyun', 'provider_openai_compatible', 'provider_custom',
    'history_preview_aria', 'label_ui_language', 'msg_capture_file_access',
    'msg_export_failed', 'msg_import_failed', 'modal_import_title',
    'modal_import_message', 'modal_import_warning', 'modal_api_provider', 'modal_export_date'
  ];
  for (const catalog of [locale('en'), locale('zh_CN')]) {
    for (const key of required) assert.ok(catalog[key], `missing ${key}`);
  }
});
