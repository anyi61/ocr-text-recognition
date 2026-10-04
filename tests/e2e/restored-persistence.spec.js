'use strict';

const { test, expect } = require('./fixtures');
const { startCapture, selectAndConfirm, readHistory, openPopupForTab, RESULT_TEXT } = require('./helpers');

async function recognize(browser, page) {
  await startCapture(browser, page);
  await page.bringToFront();
  await selectAndConfirm(page);
  await expect(page.locator('#ocr-result-text')).toHaveValue(RESULT_TEXT);
}

async function openHistory(browser, page) {
  const popup = await openPopupForTab(browser, page);
  await popup.locator('.history-item-text').first().click();
  await expect(popup.locator('[data-draft=panel]')).toHaveAttribute('data-state', /idle|available/);
  return popup;
}

async function delayFormalSave(browser, text) {
  await browser.serviceWorker.evaluate((text) => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    globalThis.__saveWaiting = false;
    Object.defineProperty(chrome.storage.local, 'set', { configurable: true, value: async (values) => {
      if (values.ocrHistory?.some((record) => record.text === text) && !globalThis.__saveWaiting) {
        globalThis.__saveWaiting = true;
        await new Promise((resolve) => { globalThis.__releaseSave = resolve; });
      }
      return original(values);
    } });
  }, text);
}

test('restored: an abruptly closed history popup offers its draft and never overwrites the official original', async ({ extBrowser: browser, page }) => {
  await recognize(browser, page);
  let popup = await openHistory(browser, page);
  await popup.locator('#historyPreviewText').fill('Uncommitted draft survives immediate closure');
  await popup.close();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.draft?.text).toBe('Uncommitted draft survives immediate closure');
  expect((await readHistory(browser.serviceWorker))[0].text).toBe(RESULT_TEXT);
  popup = await openHistory(browser, page);
  await expect(popup.locator('#historyPreviewText')).toHaveValue(RESULT_TEXT);
  await popup.locator('[data-draft=restore]').click();
  await expect(popup.locator('#historyPreviewText')).toHaveValue('Uncommitted draft survives immediate closure');
  await popup.locator('#previewSaveBtn').click();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.text).toBe('Uncommitted draft survives immediate closure');
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.draft).toBeUndefined();
});

test('restored: discarding a recoverable draft keeps the saved original across reopening', async ({ extBrowser: browser, page }) => {
  await recognize(browser, page);
  await page.locator('#ocr-result-text').fill('Discard this result draft');
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.draft?.text).toBe('Discard this result draft');
  await page.reload();
  let popup = await openHistory(browser, page);
  await popup.locator('[data-draft=discard]').click();
  await expect(popup.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'idle');
  await expect(popup.locator('#historyPreviewText')).toHaveValue(RESULT_TEXT);
  await popup.close();
  popup = await openHistory(browser, page);
  await expect(popup.locator('[data-draft=restore]')).toBeHidden();
  expect((await readHistory(browser.serviceWorker))[0].draft).toBeUndefined();
});

test('restored: stale concurrent editor cannot overwrite another window draft', async ({ extBrowser: browser, page }) => {
  await recognize(browser, page);
  const first = await openHistory(browser, page);
  const second = await openHistory(browser, page);
  await first.locator('#historyPreviewText').fill('First window owns this draft');
  await expect(first.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'saved');
  await second.locator('#historyPreviewText').fill('Second window input stays visible');
  await expect(second.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'conflict');
  await expect(second.locator('#historyPreviewText')).toHaveValue('Second window input stays visible');
  const record = (await readHistory(browser.serviceWorker))[0];
  expect(record.text).toBe(RESULT_TEXT);
  expect(record.draft.text).toBe('First window owns this draft');
});

test('restored: clearing every character is a durable empty draft recoverable after page closure', async ({ extBrowser: browser, page, mock }) => {
  await recognize(browser, page);
  await page.locator('#ocr-result-text').fill('');
  await page.close();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.draft?.text).toBe('');
  const replacement = await browser.context.newPage();
  await replacement.goto(mock.origin);
  const popup = await openHistory(browser, replacement);
  await popup.locator('[data-draft=restore]').click();
  await expect(popup.locator('#historyPreviewText')).toHaveValue('');
  await expect(popup.locator('#previewSaveBtn')).toBeDisabled();
  expect((await readHistory(browser.serviceWorker))[0].text).toBe(RESULT_TEXT);
});

test('restored: declining result close preserves unsaved text and accepting keeps its recoverable draft', async ({ extBrowser: browser, page }) => {
  await recognize(browser, page);
  await page.locator('#ocr-result-text').fill('Do not lose this unsaved text');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('.ocr-close-btn').click();
  await expect(page.locator('#ocr-result-text')).toHaveValue('Do not lose this unsaved text');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.ocr-close-btn').click();
  await expect(page.locator('#ocr-result-popup')).toHaveCount(0);
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.draft?.text).toBe('Do not lose this unsaved text');
});

test('restored: line cleanup is reversible and cannot overwrite newer manual edits', async ({ extBrowser: browser, page, mock }) => {
  mock.state.queue.push({ text: 'Wrapped English\nparagraph one.\n\nSecond paragraph.' });
  await startCapture(browser, page);
  await selectAndConfirm(page);
  const source = page.locator('#ocr-result-text');
  await expect(source).toHaveValue('Wrapped English\nparagraph one.\n\nSecond paragraph.');
  await page.locator('.merge-lines-btn').click();
  await expect(source).toHaveValue('Wrapped English paragraph one.\n\nSecond paragraph.');
  expect((await readHistory(browser.serviceWorker))[0].text).toBe('Wrapped English\nparagraph one.\n\nSecond paragraph.');
  await page.locator('.undo-text-btn').click();
  await expect(source).toHaveValue('Wrapped English\nparagraph one.\n\nSecond paragraph.');
  await page.locator('.merge-lines-btn').click();
  await source.fill('Manually corrected text after cleanup');
  await expect(page.locator('.undo-text-btn')).toBeDisabled();
  await browser.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('.copy-btn').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Manually corrected text after cleanup');
  await page.locator('.save-changes-btn').click();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.text).toBe('Manually corrected text after cleanup');
});

test('restored: newer result edits survive a delayed formal save and become a draft against the committed text', async ({ extBrowser: browser, page }) => {
  await recognize(browser, page);
  await page.locator('#ocr-result-text').fill('First submitted correction');
  await expect(page.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'saved');
  await delayFormalSave(browser, 'First submitted correction');
  await page.locator('.save-changes-btn').click();
  await expect.poll(() => browser.serviceWorker.evaluate(() => globalThis.__saveWaiting)).toBe(true);
  await page.locator('#ocr-result-text').fill('Newer edit typed while save is pending');
  await browser.serviceWorker.evaluate(() => globalThis.__releaseSave());
  await expect(page.locator('#ocr-result-text')).toHaveValue('Newer edit typed while save is pending');
  await expect(page.locator('.save-changes-btn')).toBeEnabled();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.draft?.text).toBe('Newer edit typed while save is pending');
  const record = (await readHistory(browser.serviceWorker))[0];
  expect(record.text).toBe('First submitted correction');
  expect(record.draft.baseText).toBe('First submitted correction');
});

test('restored: pending history save locks conflicting controls until storage completes', async ({ extBrowser: browser, page }) => {
  await recognize(browser, page);
  const popup = await openHistory(browser, page);
  await popup.locator('#historyPreviewText').fill('History correction awaiting storage');
  await expect(popup.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'saved');
  await delayFormalSave(browser, 'History correction awaiting storage');
  await popup.locator('#previewSaveBtn').click();
  await expect.poll(() => browser.serviceWorker.evaluate(() => globalThis.__saveWaiting)).toBe(true);
  await expect(popup.locator('#historyPreviewText')).toHaveAttribute('readonly', '');
  await expect(popup.locator('#closePreviewBtn')).toBeDisabled();
  await expect(popup.locator('#previewRevertBtn')).toBeDisabled();
  await expect(popup.locator('#clearHistoryBtn')).toBeDisabled();
  await browser.serviceWorker.evaluate(() => globalThis.__releaseSave());
  await expect(popup.locator('#historyPreviewText')).not.toHaveAttribute('readonly', '');
  await expect(popup.locator('#closePreviewBtn')).toBeEnabled();
  expect((await readHistory(browser.serviceWorker))[0].text).toBe('History correction awaiting storage');
});

test('restored: failed history save preserves the editor and durable draft for retry', async ({ extBrowser: browser, page }) => {
  await recognize(browser, page);
  const popup = await openHistory(browser, page);
  await popup.locator('#historyPreviewText').fill('Correction that must survive failed save');
  await expect(popup.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'saved');
  await browser.serviceWorker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    let failed = false;
    Object.defineProperty(chrome.storage.local, 'set', { configurable: true, value: async (values) => {
      if (!failed && values.ocrHistory?.some((record) => record.text === 'Correction that must survive failed save')) {
        failed = true;
        throw new Error('E2E simulated storage unavailable');
      }
      return original(values);
    } });
  });
  await popup.locator('#previewSaveBtn').click();
  await expect(popup.locator('#historyPreviewStatus')).toContainText(/could not|fail|无法|失败/i);
  await expect(popup.locator('#historyPreviewText')).toHaveValue('Correction that must survive failed save');
  expect((await readHistory(browser.serviceWorker))[0].text).toBe(RESULT_TEXT);
  await popup.locator('#previewSaveBtn').click();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.text).toBe('Correction that must survive failed save');
});
