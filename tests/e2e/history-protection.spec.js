'use strict';

const { test, expect } = require('./fixtures');
const { setStorage, readHistory, openExtensionPage, uploadImage, restartBrowser } = require('./helpers');
const record = (id, extra = {}) => ({ id, text: `Text ${id}`, provider: 'openai-compatible', language: 'en', timestamp: 1000, ...extra });
const row = (page, id) => page.locator(`.history-item[data-history-id="${id}"]`);

async function newRecognition(workspace) {
  await uploadImage(workspace);
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageResultText')).toHaveValue('MOCK OCR RESULT 12345');
}

test('favorite and name controls persist, support search, and survive browser restart', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [record('important')] });
  const popup = await openExtensionPage(browser, 'popup.html');
  await row(popup, 'important').locator('.history-favorite-btn').click();
  await expect(row(popup, 'important').locator('.history-favorite-btn')).toHaveAttribute('aria-pressed', 'true');
  await row(popup, 'important').click();
  await popup.locator('#historyName').fill('Invoice December');
  await popup.locator('#historyNameSaveBtn').click();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0].name).toBe('Invoice December');
  await popup.locator('#closePreviewBtn').click();
  await popup.locator('#historySearch').fill('December');
  await expect(row(popup, 'important')).toBeVisible();
  await expect(row(popup, 'important').locator('.history-item-name')).toHaveText('Invoice December');
  await restartBrowser(browser);
  const reopened = await openExtensionPage(browser, 'popup.html');
  await expect(row(reopened, 'important').locator('.history-favorite-btn')).toHaveAttribute('aria-pressed', 'true');
  await row(reopened, 'important').click();
  await expect(reopened.locator('#historyName')).toHaveValue('Invoice December');
});

test('name Escape and cancel do not persist edits while Enter commits and empty clears name', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [record('name', { name: 'Original' })] });
  const popup = await openExtensionPage(browser, 'popup.html');
  await row(popup, 'name').click();
  await popup.locator('#historyName').fill('Abandoned');
  await popup.locator('#historyName').press('Escape');
  await expect(popup.locator('#historyName')).toHaveValue('Original');
  await popup.locator('#historyName').fill('Also abandoned');
  await popup.locator('#historyNameCancelBtn').click();
  expect((await readHistory(browser.serviceWorker))[0].name).toBe('Original');
  await popup.locator('#historyName').fill('  Saved name  ');
  await popup.locator('#historyName').press('Enter');
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0].name).toBe('Saved name');
  await popup.locator('#historyName').fill('');
  await popup.locator('#historyNameSaveBtn').click();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0].name || '').toBe('');
});

test('new OCR retains old favorites and unfinished drafts beyond fifty ordinary records', async ({ extBrowser: browser, workspace }) => {
  const ordinary = Array.from({ length: 50 }, (_, index) => record(`ordinary-${index}`, { timestamp: 1000 - index }));
  await setStorage(browser, { ocrHistory: [...ordinary,
    record('favorite', { timestamp: 3, favorite: true, name: 'Important' }),
    record('draft', { timestamp: 2, draft: { text: 'Unfinished', baseText: 'Text draft', updatedAt: 2000 } }),
    record('empty-draft', { timestamp: 1, draft: { text: '', baseText: 'Text empty-draft', updatedAt: 2000 } })] });
  await newRecognition(workspace);
  const history = await readHistory(browser.serviceWorker);
  expect(history).toHaveLength(53);
  expect(history.map((item) => item.id)).toEqual(expect.arrayContaining(['favorite', 'draft', 'empty-draft']));
  expect(history.some((item) => item.id === 'ordinary-49')).toBe(false);
  const popup = await openExtensionPage(browser, 'popup.html');
  await expect(row(popup, 'draft').locator('.history-draft-tag')).toBeVisible();
  await expect(row(popup, 'empty-draft').locator('.history-draft-tag')).toBeVisible();
});

test('removing favorite makes an old record eligible for the next automatic trim', async ({ extBrowser: browser, workspace }) => {
  await setStorage(browser, { ocrHistory: [...Array.from({ length: 50 }, (_, index) => record(`normal-${index}`, { timestamp: 1000 - index })), record('old-favorite', { timestamp: 1, favorite: true })] });
  const popup = await openExtensionPage(browser, 'popup.html');
  await row(popup, 'old-favorite').locator('.history-favorite-btn').click();
  await expect.poll(async () => (await readHistory(browser.serviceWorker)).find((item) => item.id === 'old-favorite')?.favorite).toBe(false);
  await newRecognition(workspace);
  const history = await readHistory(browser.serviceWorker);
  expect(history).toHaveLength(50);
  expect(history.some((item) => item.id === 'old-favorite')).toBe(false);
});

test('concurrent popup favorite and name changes preserve both metadata and unsaved body draft', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [record('shared')] });
  const first = await openExtensionPage(browser, 'popup.html');
  const second = await openExtensionPage(browser, 'popup.html');
  await row(first, 'shared').click();
  await row(second, 'shared').click();
  await first.locator('#historyPreviewText').fill('Unsaved body');
  await first.locator('#historyName').fill('Concurrent name');
  await Promise.all([first.locator('#historyNameSaveBtn').click(), second.locator('#previewFavoriteBtn').click()]);
  await expect.poll(async () => {
    const item = (await readHistory(browser.serviceWorker))[0];
    return { name: item.name, favorite: item.favorite };
  }).toEqual({ name: 'Concurrent name', favorite: true });
  await expect(first.locator('#historyPreviewText')).toHaveValue('Unsaved body');
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0].draft?.text).toBe('Unsaved body');
});

test('explicit deletion still requires confirmation and can remove a protected record', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [record('protected', { favorite: true, draft: { text: 'DRAFT', baseText: 'Text protected', updatedAt: Date.now() } })] });
  const popup = await openExtensionPage(browser, 'popup.html');
  popup.once('dialog', (dialog) => dialog.dismiss());
  await row(popup, 'protected').locator('.history-delete-btn').click();
  expect(await readHistory(browser.serviceWorker)).toHaveLength(1);
  popup.once('dialog', (dialog) => dialog.accept());
  await row(popup, 'protected').locator('.history-delete-btn').click();
  await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(0);
});

test('failed metadata save retains the edited name for retry', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [record('retry-name', { name: 'Original' })] });
  const popup = await browser.context.newPage();
  await popup.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    let failed = false;
    chrome.runtime.sendMessage = async (message) => {
      if (message.action === 'updateHistoryMetadata' && !failed) {
        failed = true; return { success: false, errorCode: 'HISTORY_WRITE_FAILED' };
      }
      return send(message);
    };
  });
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await row(popup, 'retry-name').click();
  await popup.locator('#historyName').fill('Retained pending name');
  await popup.locator('#historyNameSaveBtn').click();
  await expect(popup.locator('#historyMetadataStatus')).not.toBeEmpty();
  await expect(popup.locator('#historyName')).toHaveValue('Retained pending name');
  expect((await readHistory(browser.serviceWorker))[0].name).toBe('Original');
  await popup.locator('#historyNameSaveBtn').click();
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0].name).toBe('Retained pending name');
});
