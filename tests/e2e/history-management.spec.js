'use strict';

const { test, expect } = require('./fixtures');
const { setStorage, readHistory, openExtensionPage } = require('./helpers');
const record = (id, extra = {}) => ({ id, text: `Text ${id}`, provider: 'openai-compatible', language: 'en', timestamp: 1000, ...extra });
const row = (page, id) => page.locator(`.history-item[data-history-id="${id}"]`);
const count = (popup, field) => popup.locator(`#historyManagementCounts [data-count="${field}"]`);

test('favorites and draft filters combine with draft search and update across popup windows', async ({ extBrowser: browser }) => {
  await setStorage(browser, { uiLanguage: 'en', ocrHistory: [
    record('normal'), record('favorite', { favorite: true, name: 'Invoice' }),
    record('draft', { draft: { text: 'UNIQUE DRAFT NEEDLE', baseText: 'Text draft', updatedAt: 2000 } }),
    record('empty-draft', { draft: { text: '', baseText: 'Text empty-draft', updatedAt: 2000 } })
  ] });
  const popup = await openExtensionPage(browser, 'popup.html');
  const other = await openExtensionPage(browser, 'popup.html');
  await popup.locator('#historyFilter').selectOption('drafts');
  await expect(popup.locator('.history-item')).toHaveCount(2);
  await popup.locator('#historySearch').fill('needle');
  await expect(popup.locator('.history-item')).toHaveCount(1);
  await expect(row(popup, 'draft')).toBeVisible();
  await row(popup, 'draft').click();
  await expect(popup.locator('#historyFilterWrap')).not.toBeVisible();
  await popup.locator('#closePreviewBtn').click();
  await expect(popup.locator('#historyFilter')).toHaveValue('drafts');
  await expect(popup.locator('#historySearch')).toHaveValue('needle');
  await popup.locator('#historySearch').fill('');
  await popup.locator('#historyFilter').selectOption('favorites');
  await expect(popup.locator('.history-item')).toHaveCount(1);
  await row(other, 'favorite').locator('.history-favorite-btn').click();
  await expect(popup.locator('#historySearchEmptyState')).toHaveText('No favorite records yet.');
  await row(other, 'draft').locator('.history-favorite-btn').click();
  await expect(row(popup, 'draft')).toBeVisible();
  await popup.locator('#historySearch').fill('needle');
  await expect(row(popup, 'draft')).toBeVisible();
  await popup.locator('#historySearch').fill('missing');
  await expect(popup.locator('#historySearchEmptyState')).toHaveText('No matching history records');
});

test('cleanup previews all ordinary records, protects empty drafts, and refreshes after a concurrent favorite', async ({ extBrowser: browser }) => {
  await setStorage(browser, { uiLanguage: 'en', ocrHistory: [
    record('normal'), record('completed', { draft: { text: 'Text completed', baseText: 'Text completed', updatedAt: 2000 } }),
    record('favorite', { favorite: true }),
    record('empty-draft', { draft: { text: '', baseText: 'Text empty-draft', updatedAt: 2000 } })
  ] });
  const popup = await openExtensionPage(browser, 'popup.html');
  const other = await openExtensionPage(browser, 'popup.html');
  await popup.locator('#historyFilter').selectOption('favorites');
  await popup.locator('#historySearch').fill('favorite');
  await popup.locator('#cleanupHistoryBtn').click();
  await expect(popup.locator('#historyManagementDescription')).toContainText('regardless of the current filter or search');
  await expect(count(popup, 'deleteCount')).toHaveText('2');
  await expect(count(popup, 'keepCount')).toHaveText('2');
  await expect(count(popup, 'favoriteCount')).toHaveText('1');
  await expect(count(popup, 'draftCount')).toHaveText('1');
  await popup.locator('#historyManagementCancel').click();
  expect(await readHistory(browser.serviceWorker)).toHaveLength(4);
  await popup.locator('#cleanupHistoryBtn').click();
  await expect(popup.locator('#historyManagementConfirm')).toBeEnabled();
  await row(other, 'normal').locator('.history-favorite-btn').click();
  await expect(popup.locator('#historyManagementStatus')).toContainText('History changed');
  await expect(popup.locator('#historyManagementConfirm')).toBeDisabled();
  await popup.locator('#historyManagementRefresh').click();
  await expect(count(popup, 'deleteCount')).toHaveText('1');
  await expect(count(popup, 'keepCount')).toHaveText('3');
  await popup.locator('#historyManagementConfirm').click();
  await expect(popup.locator('#historyManagementStatus')).toContainText('Deleted 1');
  expect((await readHistory(browser.serviceWorker)).map((item) => item.id)).toEqual(['normal', 'favorite', 'empty-draft']);
  await popup.locator('#historyManagementCancel').click();
  let clearMessage = '';
  popup.once('dialog', (dialog) => { clearMessage = dialog.message(); return dialog.dismiss(); });
  await popup.locator('#clearHistoryBtn').click();
  expect(clearMessage).toContain('including favorites, saved translations and unfinished drafts');
  expect(await readHistory(browser.serviceWorker)).toHaveLength(3);
  popup.once('dialog', (dialog) => dialog.accept());
  await popup.locator('#clearHistoryBtn').click();
  await expect.poll(() => readHistory(browser.serviceWorker)).toEqual([]);
});

test('management operations and external language changes preserve the current editor and unsaved name', async ({ extBrowser: browser }) => {
  await setStorage(browser, { uiLanguage: 'en', ocrHistory: [record('editing'), record('ordinary')] });
  const popup = await openExtensionPage(browser, 'popup.html');
  await row(popup, 'editing').click();
  await popup.locator('#historyPreviewText').fill('My unfinished edit');
  await popup.locator('#historyName').fill('My unsaved name');
  await expect.poll(async () => (await readHistory(browser.serviceWorker)).find((item) => item.id === 'editing').draft?.text).toBe('My unfinished edit');
  await popup.locator('#cleanupHistoryBtn').click();
  await expect(count(popup, 'keepCount')).toHaveText('1');
  await setStorage(browser, { uiLanguage: 'zh_CN' });
  await expect(popup.locator('#historyManagementConfirm')).toHaveText('确认删除普通历史');
  await popup.locator('#historyManagementCancel').press('Escape');
  await expect(popup.locator('#historyPreview')).toBeVisible();
  await expect(popup.locator('#historyPreviewText')).toHaveValue('My unfinished edit');
  await expect(popup.locator('#historyName')).toHaveValue('My unsaved name');
  await popup.locator('#cleanupHistoryBtn').click();
  await expect(popup.locator('#historyManagementConfirm')).toBeEnabled();
  await popup.locator('#historyManagementConfirm').click();
  await expect(popup.locator('#historyManagementStatus')).toContainText('已删除 1');
  await popup.locator('#historyManagementCancel').click();
  await expect(popup.locator('#historyPreview')).toBeVisible();
  await expect(popup.locator('#historyPreviewText')).toHaveValue('My unfinished edit');
  await expect(popup.locator('#historyName')).toHaveValue('My unsaved name');
  expect((await readHistory(browser.serviceWorker)).map((item) => item.id)).toEqual(['editing']);
});
