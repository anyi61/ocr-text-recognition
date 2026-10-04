'use strict';

const { test, expect } = require('./fixtures');
const { setStorage, readStorage, readHistory, openExtensionPage, restartBrowser } = require('./helpers');

const original = { id: 'shared', text: 'Original body', timestamp: 1, provider: 'openai-compatible', language: 'en', name: 'Source record', favorite: true };
const row = (page, id = 'shared') => page.locator(`.history-item[data-history-id="${id}"]`);

async function editor(browser) {
  await setStorage(browser, { uiLanguage: 'en', ocrHistory: [original] });
  const popup = await openExtensionPage(browser, 'popup.html');
  await row(popup).click();
  await expect(popup.locator('[data-draft="panel"]')).toHaveAttribute('data-state', 'idle');
  return popup;
}

async function correctElsewhere(browser, expectedText, text) {
  const other = await openExtensionPage(browser, 'popup.html');
  expect(await other.evaluate(({ expectedText, text }) => chrome.runtime.sendMessage({
    action: 'updateHistoryRecord', historyId: 'shared', expectedText, text
  }), { expectedText, text })).toEqual({ success: true });
  await other.close();
}

test('popup compares in place, preserves local text and still rejects changes after adopting a baseline', async ({ extBrowser: browser }) => {
  const popup = await editor(browser);
  await correctElsewhere(browser, 'Original body', 'Latest saved body');
  await popup.locator('#historyPreviewText').fill('My local correction');
  await popup.locator('#previewSaveBtn').click();
  await expect(popup.locator('[data-conflict="latest"]')).toHaveValue('Latest saved body');
  await expect(popup.locator('#historyPreviewText')).toHaveValue('My local correction');
  await popup.locator('#historyPreviewText').fill('My revised correction');
  await popup.locator('[data-conflict="rebase"]').click();
  await expect(popup.locator('[data-conflict="panel"]')).toBeHidden();
  await expect(popup.locator('#historyPreviewText')).toHaveValue('My revised correction');
  expect((await readHistory(browser.serviceWorker))[0].text).toBe('Latest saved body');

  await correctElsewhere(browser, 'Latest saved body', 'Changed again');
  await popup.locator('#previewSaveBtn').click();
  await expect(popup.locator('[data-conflict="latest"]')).toHaveValue('Changed again');
  expect((await readHistory(browser.serviceWorker))[0].text).toBe('Changed again');
  await popup.locator('[data-conflict="rebase"]').click();
  await popup.locator('#previewSaveBtn').click();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0].text).toBe('My revised correction');
});

test('popup save-as-new freezes pending edits and binds later drafts to the new record without changing the source or preferences', async ({ extBrowser: browser }) => {
  const popup = await editor(browser);
  await setStorage(browser, { autoCopy: true, e2eClipboardMode: 'success', e2eClipboardWrites: [],
    translationProvider: 'custom', translationTargetLanguage: 'fr' });
  await correctElsewhere(browser, 'Original body', 'Other window correction');
  await popup.locator('#historyPreviewText').fill('Save this separately');
  await popup.locator('#historyName').fill('Unsaved local name');
  await popup.locator('#previewSaveBtn').click();
  await expect(popup.locator('[data-conflict="latest"]')).toHaveValue('Other window correction');
  const before = (await readHistory(browser.serviceWorker)).find((item) => item.id === 'shared');
  await popup.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const response = await send(message);
      if (message.action === 'saveHistoryAsNew') await new Promise((resolve) => { window.releaseNewRecord = resolve; });
      return response;
    };
  });
  await popup.locator('[data-conflict="save-new"]').click();
  await popup.waitForFunction(() => Boolean(window.releaseNewRecord));
  await expect(popup.locator('#closePreviewBtn')).toBeDisabled();
  await expect(popup.locator('#restoreHistoryBtn')).toBeDisabled();
  await expect(popup.locator('#historyPreviewText')).toHaveAttribute('readonly', '');
  await popup.locator('#historyPreviewText').focus();
  await popup.keyboard.type('Must not enter while saving');
  await expect(popup.locator('#historyPreviewText')).toHaveValue('Save this separately');
  await popup.evaluate(() => window.releaseNewRecord());
  await expect(popup.locator('#closePreviewBtn')).toBeEnabled();
  await expect(popup.locator('#historyPreviewText')).toBeEditable();
  await popup.locator('#historyPreviewText').fill('Input typed after saving');
  await expect(popup.locator('#historyName')).toHaveValue('Unsaved local name');
  await expect.poll(async () => (await readHistory(browser.serviceWorker)).find((item) => item.id !== 'shared')?.draft?.text)
    .toBe('Input typed after saving');
  const records = await readHistory(browser.serviceWorker);
  const copy = records.find((item) => item.id !== 'shared');
  expect(copy.text).toBe('Save this separately');
  expect(records.find((item) => item.id === 'shared')).toEqual(before);
  expect(await readStorage(browser, ['translationProvider', 'translationTargetLanguage', 'e2eClipboardWrites']))
    .toEqual({ translationProvider: 'custom', translationTargetLanguage: 'fr', e2eClipboardWrites: [] });
  await restartBrowser(browser);
  const reopened = await openExtensionPage(browser, 'popup.html');
  await row(reopened, copy.id).click();
  await reopened.locator('[data-draft="restore"]').click();
  await expect(reopened.locator('#historyPreviewText')).toHaveValue('Input typed after saving');
});

test('a deleted popup record can be saved separately and failed attempts preserve local text', async ({ extBrowser: browser }) => {
  const popup = await editor(browser);
  await popup.locator('#historyPreviewText').fill('Rescue deleted record');
  const other = await openExtensionPage(browser, 'popup.html');
  await other.evaluate(() => chrome.runtime.sendMessage({ action: 'deleteHistoryRecord', historyId: 'shared' }));
  await popup.locator('#previewSaveBtn').click();
  await expect(popup.locator('[data-conflict="panel"]')).toHaveAttribute('data-state', 'missing');
  await expect(popup.locator('[data-conflict="rebase"]')).toBeDisabled();
  await popup.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    let rejectOnce = true;
    chrome.runtime.sendMessage = (message) => {
      if (message.action === 'saveHistoryAsNew' && rejectOnce) {
        rejectOnce = false;
        return Promise.resolve({ success: false, errorCode: 'HISTORY_WRITE_FAILED' });
      }
      return send(message);
    };
  });
  await popup.locator('[data-conflict="save-new"]').click();
  await expect(popup.locator('[data-conflict="panel"]')).toHaveAttribute('data-state', 'save-error');
  await expect(popup.locator('#historyPreviewText')).toHaveValue('Rescue deleted record');
  expect(await readHistory(browser.serviceWorker)).toEqual([]);
  await popup.locator('[data-conflict="save-new"]').click();
  await expect.poll(async () => (await readHistory(browser.serviceWorker)).length).toBe(1);
  const saved = (await readHistory(browser.serviceWorker))[0];
  expect(saved.id).not.toBe('shared');
  expect(saved.text).toBe('Rescue deleted record');
});

test('Escape closes comparison and suppresses a late read without closing the local editor', async ({ extBrowser: browser }) => {
  const popup = await editor(browser);
  await correctElsewhere(browser, 'Original body', 'Saved elsewhere');
  await popup.locator('#historyPreviewText').fill('Keep my local text');
  await popup.locator('#previewSaveBtn').click();
  await expect(popup.locator('[data-conflict="latest"]')).toHaveValue('Saved elsewhere');
  await popup.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const response = await send(message);
      if (message.action === 'getHistoryRecord') await new Promise((resolve) => { window.releaseLatestRead = resolve; });
      return response;
    };
  });
  await popup.locator('[data-conflict="refresh"]').click();
  await popup.waitForFunction(() => Boolean(window.releaseLatestRead));
  await popup.keyboard.press('Escape');
  await popup.evaluate(() => window.releaseLatestRead());
  await expect(popup.locator('[data-conflict="panel"]')).toBeHidden();
  await expect(popup.locator('#historyPreview')).toBeVisible();
  await expect(popup.locator('#historyPreviewText')).toHaveValue('Keep my local text');
  expect((await readHistory(browser.serviceWorker))[0].text).toBe('Saved elsewhere');
});
