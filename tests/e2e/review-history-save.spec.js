'use strict';

const { test, expect } = require('./fixtures');
const { setStorage, readHistory, openExtensionPage } = require('./helpers');

const record = (id) => ({ id, text: `Text ${id}`, provider: 'openai-compatible', language: 'en', timestamp: 1 });
const row = (page, id) => page.locator(`.history-item[data-history-id="${id}"]`);

test('a stale popup cannot overwrite a newer correction, even after changing interface language', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [record('shared')] });
  const first = await openExtensionPage(browser, 'popup.html');
  const stale = await openExtensionPage(browser, 'popup.html');
  await row(first, 'shared').click();
  await row(stale, 'shared').click();
  await first.locator('#historyPreviewText').fill('First editor correction');
  await first.locator('#previewSaveBtn').click();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0].text).toBe('First editor correction');
  await stale.locator('#historyPreviewText').fill('Local edit from old version');
  await expect(stale.locator('[data-draft="panel"]')).toHaveAttribute('data-state', 'conflict');
  await stale.locator('#languageSelect').selectOption('zh_CN');
  await stale.locator('#previewSaveBtn').click();
  await expect(stale.locator('#historyPreviewStatus')).toHaveText(await stale.evaluate(() => OCRI18n.t('content_msg_changes_conflict')));
  await expect(stale.locator('#historyPreviewText')).toHaveValue('Local edit from old version');
  expect((await readHistory(browser.serviceWorker))[0].text).toBe('First editor correction');

  // Opening the current saved version establishes a new, explicit baseline.
  stale.once('dialog', (dialog) => dialog.accept());
  await stale.locator('#closePreviewBtn').click();
  await row(stale, 'shared').click();
  await expect(stale.locator('#historyPreviewText')).toHaveValue('First editor correction');
  await stale.locator('#historyPreviewText').fill('Reviewed correction');
  await stale.locator('#previewSaveBtn').click();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0].text).toBe('Reviewed correction');
});

test('a delayed deletion acknowledgement preserves edits in a different history preview', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [record('delete-me'), record('editing')] });
  const popup = await browser.context.newPage();
  await popup.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const response = await send(message);
      if (message.action === 'deleteHistoryRecord') {
        await new Promise((resolve) => { window.releaseDeletion = resolve; });
      }
      return response;
    };
  });
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  popup.once('dialog', (dialog) => dialog.accept());
  await row(popup, 'delete-me').locator('.history-delete-btn').click();
  await popup.waitForFunction(() => Boolean(window.releaseDeletion));
  await row(popup, 'editing').click();
  await popup.locator('#historyName').fill('Unsaved important name');
  await popup.locator('#historyPreviewText').fill('Unsaved body');
  await popup.evaluate(() => window.releaseDeletion());
  await expect(popup.locator('#historyPreview')).toBeVisible();
  await expect(popup.locator('#historyName')).toHaveValue('Unsaved important name');
  await expect(popup.locator('#historyPreviewText')).toHaveValue('Unsaved body');
  await popup.locator('#historyNameSaveBtn').click();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0].name).toBe('Unsaved important name');
});

test('a delayed body-save acknowledgement cannot replace the latest record shown on reopening', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [record('shared')], uiLanguage: 'en' });
  const first = await browser.context.newPage();
  await first.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const response = await send(message);
      if (message.action === 'updateHistoryRecord') {
        await new Promise((resolve) => { window.releaseBodySave = resolve; });
      }
      return response;
    };
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.ocrHistory) window.lastStoredBody = changes.ocrHistory.newValue?.[0]?.text;
    });
  });
  await first.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await row(first, 'shared').click();
  await first.locator('#historyPreviewText').fill('First correction');
  await first.locator('#previewSaveBtn').click();
  await first.waitForFunction(() => Boolean(window.releaseBodySave));
  const second = await openExtensionPage(browser, 'popup.html');
  await row(second, 'shared').click();
  await second.locator('#historyPreviewText').fill('Latest correction');
  await second.locator('#previewSaveBtn').click();
  await first.waitForFunction(() => window.lastStoredBody === 'Latest correction');
  await first.evaluate(() => window.releaseBodySave());
  await expect(first.locator('#closePreviewBtn')).toBeEnabled();
  await first.locator('#closePreviewBtn').click();
  await row(first, 'shared').click();
  await expect(first.locator('#historyPreviewText')).toHaveValue('Latest correction');
  await expect(first.locator('[data-draft="panel"]')).toHaveAttribute('data-state', 'idle');
  expect((await readHistory(browser.serviceWorker))[0].text).toBe('Latest correction');
});

test('changing language after another window deletes the record preserves its local editor and sessions', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [record('deleted')], uiLanguage: 'en' });
  const editor = await openExtensionPage(browser, 'popup.html');
  await row(editor, 'deleted').click();
  await editor.locator('#historyPreviewText').fill('Keep this local text');
  await editor.locator('#historyName').fill('Keep this unsaved name');
  await expect(editor.locator('[data-draft="panel"]')).toHaveAttribute('data-state', 'saved');
  await editor.evaluate(() => {
    window.originalDraftPanel = document.querySelector('[data-draft="panel"]');
    window.originalTranslationPanel = document.querySelector('[data-translation="panel"]');
  });
  const remover = await openExtensionPage(browser, 'popup.html');
  remover.once('dialog', (dialog) => dialog.accept());
  await row(remover, 'deleted').locator('.history-delete-btn').click();
  await expect.poll(() => readHistory(browser.serviceWorker)).toEqual([]);
  await expect(editor.locator('[data-draft="panel"]')).toHaveAttribute('data-state', 'error');
  await editor.locator('#languageSelect').selectOption('zh_CN');
  await expect(editor.locator('#languageSelect')).toBeEnabled();
  await expect(editor.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(editor.locator('#historyPreview')).toBeVisible();
  await expect(editor.locator('#historyPreviewText')).toHaveValue('Keep this local text');
  await expect(editor.locator('#historyName')).toHaveValue('Keep this unsaved name');
  expect(await editor.evaluate(() => ({
    sameDraft: window.originalDraftPanel === document.querySelector('[data-draft="panel"]'),
    sameTranslation: window.originalTranslationPanel === document.querySelector('[data-translation="panel"]')
  }))).toEqual({ sameDraft: true, sameTranslation: true });
  // Closing remains an explicit choice. Cancelling must keep both inputs.
  editor.once('dialog', (dialog) => dialog.dismiss());
  await editor.locator('#closePreviewBtn').click();
  await expect(editor.locator('#historyPreview')).toBeVisible();
  await expect(editor.locator('#historyName')).toHaveValue('Keep this unsaved name');
});

test('a delayed translation result cannot roll back history search to an older saved translation', async ({ extBrowser: browser, mock }) => {
  await setStorage(browser, { ocrHistory: [record('translated')], translationProvider: 'openai-compatible', translationTargetLanguage: 'ja' });
  const first = await browser.context.newPage();
  await first.addInitScript(() => {
    const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = (...args) => {
      const port = connect(...args);
      if (port.name === 'ocr-translation') {
        const addListener = port.onMessage.addListener.bind(port.onMessage);
        port.onMessage.addListener = (listener) => addListener((message) => {
          if (message.action === 'translationResult') window.releaseTranslationResult = () => listener(message);
          else listener(message);
        });
      }
      return port;
    };
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.ocrHistory) window.lastStoredTranslation = changes.ocrHistory.newValue?.[0]?.translation?.text;
    });
  });
  await first.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await row(first, 'translated').click();
  mock.state.queue.push({ text: 'Older saved translation' });
  await first.locator('[data-translation="start"]').click();
  await first.waitForFunction(() => Boolean(window.releaseTranslationResult));
  const second = await openExtensionPage(browser, 'popup.html');
  await row(second, 'translated').click();
  await expect(second.locator('[data-translation="text"]')).toHaveValue('Older saved translation');
  mock.state.queue.push({ text: 'Latest searchable translation' });
  await second.locator('[data-translation="start"]').click();
  await first.waitForFunction(() => window.lastStoredTranslation === 'Latest searchable translation');
  await first.evaluate(() => window.releaseTranslationResult());
  await expect(first.locator('[data-translation="text"]')).toHaveValue('Older saved translation');
  await first.locator('#closePreviewBtn').click();
  await first.locator('#historySearch').fill('Latest searchable');
  await expect(row(first, 'translated')).toBeVisible();
  expect((await readHistory(browser.serviceWorker))[0].translation.text).toBe('Latest searchable translation');
});
