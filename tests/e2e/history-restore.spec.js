'use strict';

const fs = require('node:fs');
const { test, expect } = require('./fixtures');
const { setStorage, readHistory, openExtensionPage, restartBrowser } = require('./helpers');
const record = (id, extra = {}) => ({ id, text: `Text ${id}`, provider: 'openai-compatible', language: 'en', timestamp: 1000, ...extra });
const backupFile = (records) => ({ name: 'history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 3, records })) });
const count = (popup, field) => popup.locator(`#historyManagementCounts [data-count="${field}"]`);

test('exported history restores from empty state with favorite draft translation and restart persistence', async ({ extBrowser: browser }) => {
  const saved = record('portable', { name: 'My receipt', favorite: true,
    draft: { text: 'Unfinished receipt', baseText: 'Text portable', updatedAt: 2000 },
    translation: { sourceText: 'Text portable', text: 'Saved translation', targetLanguage: 'zh', provider: 'openai-compatible', model: 'mock-model', timestamp: 3000 } });
  await setStorage(browser, { uiLanguage: 'en', ocrHistory: [saved] });
  const popup = await openExtensionPage(browser, 'popup.html');
  const downloaded = popup.waitForEvent('download');
  await popup.locator('#exportHistoryBtn').click();
  const file = { name: 'exported-history.json', mimeType: 'application/json', buffer: fs.readFileSync(await (await downloaded).path()) };
  await setStorage(browser, { ocrHistory: [] });
  await expect(popup.locator('#historyEmptyState')).toBeVisible();
  await expect(popup.locator('#restoreHistoryBtn')).toBeVisible();
  await popup.locator('#historyBackupFile').setInputFiles(file);
  await expect(count(popup, 'importCount')).toHaveText('1');
  await expect(count(popup, 'favoriteCount')).toHaveText('1');
  await expect(count(popup, 'draftCount')).toHaveText('1');
  expect(await readHistory(browser.serviceWorker)).toEqual([]);
  await popup.locator('#historyManagementCancel').press('Escape');
  await expect(popup.locator('#historyManagementDialog')).not.toBeVisible();
  expect(await readHistory(browser.serviceWorker)).toEqual([]);
  await popup.locator('#historyBackupFile').setInputFiles(file);
  await expect(popup.locator('#historyManagementConfirm')).toBeEnabled();
  await popup.locator('#historyManagementConfirm').click();
  await expect(popup.locator('#historyManagementStatus')).toContainText('Restored 1');
  const [restored] = await readHistory(browser.serviceWorker);
  expect(restored).toMatchObject(saved);
  await restartBrowser(browser);
  const reopened = await openExtensionPage(browser, 'popup.html');
  await expect(reopened.locator('.history-item-name')).toHaveText('My receipt');
  expect((await readHistory(browser.serviceWorker))[0]).toMatchObject(saved);
});

test('restore preview keeps existing and repeated IDs and counts capacity skips before merging', async ({ extBrowser: browser }) => {
  const existing = Array.from({ length: 49 }, (_, index) => record(`existing-${index}`));
  await setStorage(browser, { uiLanguage: 'en', ocrHistory: existing });
  const popup = await openExtensionPage(browser, 'popup.html');
  await popup.locator('#historyBackupFile').setInputFiles(backupFile([
    record('existing-0', { text: 'Must not overwrite', favorite: true }), record('new-one'),
    record('new-one', { text: 'Repeated must not overwrite' }), record('new-two'),
    record('new-favorite', { favorite: true }),
    record('new-draft', { draft: { text: '', baseText: 'Text new-draft', updatedAt: 3000 } })
  ]));
  await expect(count(popup, 'totalCount')).toHaveText('6');
  await expect(count(popup, 'importCount')).toHaveText('3');
  await expect(count(popup, 'duplicateCount')).toHaveText('2');
  await expect(count(popup, 'capacitySkippedCount')).toHaveText('1');
  expect(await readHistory(browser.serviceWorker)).toHaveLength(49);
  await popup.locator('#historyManagementConfirm').click();
  await expect(popup.locator('#historyManagementStatus')).toContainText('Restored 3');
  const history = await readHistory(browser.serviceWorker);
  expect(history).toHaveLength(52);
  expect(history.find((item) => item.id === 'existing-0')).toEqual(existing[0]);
  expect(history.find((item) => item.id === 'new-one').text).toBe('Text new-one');
  expect(history.some((item) => item.id === 'new-two')).toBe(false);
});

test('malformed and oversized files are rejected without a history mutation or oversized transport', async ({ extBrowser: browser }) => {
  await setStorage(browser, { uiLanguage: 'en', ocrHistory: [record('kept')] });
  const popup = await browser.context.newPage();
  await popup.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.importPreviews = 0;
    chrome.runtime.sendMessage = (message) => {
      if (message.action === 'previewHistoryImport') window.importPreviews += 1;
      return send(message);
    };
  });
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await popup.locator('#historyBackupFile').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(popup.locator('#historyManagementStatus')).toContainText('not a supported history backup');
  await expect(popup.locator('#historyManagementConfirm')).toBeDisabled();
  await popup.locator('#historyManagementCancel').click();
  await popup.locator('#historyBackupFile').setInputFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.alloc(20 * 1024 * 1024 + 1, 32) });
  await expect(popup.locator('#historyManagementStatus')).toContainText('20 MiB');
  expect(await popup.evaluate(() => window.importPreviews)).toBe(0);
  expect(await readHistory(browser.serviceWorker)).toEqual([record('kept')]);
});

test('a history change during confirmation rejects the old preview and a refresh can restore safely', async ({ extBrowser: browser }) => {
  await setStorage(browser, { uiLanguage: 'en', ocrHistory: [record('concurrent')] });
  const popup = await browser.context.newPage();
  await popup.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    let raced = false;
    chrome.runtime.sendMessage = async (message) => {
      if (message.action === 'commitHistoryImport' && !raced) {
        raced = true;
        await send({ action: 'updateHistoryMetadata', historyId: 'concurrent', patch: { favorite: true } });
      }
      return send(message);
    };
  });
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await popup.locator('#historyBackupFile').setInputFiles(backupFile([record('new')]));
  await expect(popup.locator('#historyManagementConfirm')).toBeEnabled();
  await popup.locator('#historyManagementConfirm').click();
  await expect(popup.locator('#historyManagementStatus')).toContainText('History changed');
  await expect(popup.locator('#historyManagementConfirm')).toBeDisabled();
  expect(await readHistory(browser.serviceWorker)).toHaveLength(1);
  await popup.locator('#historyManagementRefresh').click();
  await expect(popup.locator('#historyManagementConfirm')).toBeEnabled();
  await popup.locator('#historyManagementConfirm').click();
  await expect(popup.locator('#historyManagementStatus')).toContainText('Restored 1');
  expect((await readHistory(browser.serviceWorker)).find((item) => item.id === 'concurrent').favorite).toBe(true);
});

test('failed restore preserves the selected backup and requires a fresh preview before retry', async ({ extBrowser: browser }) => {
  await setStorage(browser, { uiLanguage: 'en' });
  const popup = await browser.context.newPage();
  await popup.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    let failed = false;
    chrome.runtime.sendMessage = async (message) => {
      if (message.action === 'commitHistoryImport' && !failed) {
        failed = true;
        return { success: false, errorCode: 'HISTORY_WRITE_FAILED' };
      }
      return send(message);
    };
  });
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await popup.locator('#historyBackupFile').setInputFiles(backupFile([record('retry')]));
  await expect(popup.locator('#historyManagementConfirm')).toBeEnabled();
  await popup.locator('#historyManagementConfirm').click();
  await expect(popup.locator('#historyManagementStatus')).toContainText('selection is retained');
  await expect(popup.locator('#historyManagementFile')).toHaveText('history.json');
  await expect(popup.locator('#historyManagementConfirm')).toBeDisabled();
  expect(await readHistory(browser.serviceWorker)).toEqual([]);
  await popup.locator('#historyManagementRefresh').click();
  await expect(popup.locator('#historyManagementConfirm')).toBeEnabled();
  await popup.locator('#historyManagementConfirm').click();
  await expect(popup.locator('#historyManagementStatus')).toContainText('Restored 1');
});

test('cancelling an in-flight preview ignores its late result and releases its token', async ({ extBrowser: browser }) => {
  await setStorage(browser, { uiLanguage: 'en' });
  const popup = await browser.context.newPage();
  await popup.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.cancelledTokens = [];
    chrome.runtime.sendMessage = async (message) => {
      if (message.action === 'cancelHistoryPreview') window.cancelledTokens.push(message.token);
      const response = await send(message);
      if (message.action === 'previewHistoryImport') {
        await new Promise((resolve) => { window.releaseHistoryPreview = resolve; });
      }
      return response;
    };
  });
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await popup.locator('#historyBackupFile').setInputFiles(backupFile([record('cancelled')]));
  await expect.poll(() => popup.evaluate(() => typeof window.releaseHistoryPreview)).toBe('function');
  await popup.locator('#historyManagementCancel').click();
  await popup.evaluate(() => window.releaseHistoryPreview());
  await expect.poll(() => popup.evaluate(() => window.cancelledTokens.length)).toBe(1);
  await expect(popup.locator('#historyManagementDialog')).not.toBeVisible();
  expect(await readHistory(browser.serviceWorker)).toEqual([]);
});
