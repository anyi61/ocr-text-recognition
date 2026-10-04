'use strict';

const { test, expect } = require('./fixtures');
const { setStorage, openExtensionPage, readHistory } = require('./helpers');

async function delayedMetadataPopup(browser) {
  const popup = await browser.context.newPage();
  await popup.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const response = await send(message);
      if (message.action === 'updateHistoryMetadata') {
        await new Promise((resolve) => { window.releaseMetadataResponse = resolve; });
      }
      return response;
    };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.ocrHistory) window.observedHistory = changes.ocrHistory.newValue;
    });
  });
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await popup.locator('.history-item[data-history-id="shared"]').click();
  return popup;
}

test('late name-save acknowledgement keeps a newer name from another popup and preserves body edits', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [{ id: 'shared', text: 'Saved text', name: 'Original', timestamp: 1 }] });
  const first = await delayedMetadataPopup(browser);
  const second = await openExtensionPage(browser, 'popup.html');
  await first.locator('#historyPreviewText').fill('Unsubmitted body edit');
  await first.locator('#historyName').fill('First saved name');
  await first.locator('#historyNameSaveBtn').click();
  await expect.poll(() => first.evaluate(() => Boolean(window.releaseMetadataResponse))).toBe(true);
  const result = await second.evaluate(() => chrome.runtime.sendMessage({
    action: 'updateHistoryMetadata', historyId: 'shared', patch: { name: 'Newer name from second popup' }
  }));
  expect(result.success).toBe(true);
  await expect.poll(() => first.evaluate(() => window.observedHistory?.[0]?.name)).toBe('Newer name from second popup');
  await first.evaluate(() => window.releaseMetadataResponse());
  await expect(first.locator('#historyName')).toBeEnabled();
  await expect(first.locator('#historyName')).toHaveValue('Newer name from second popup');
  await expect(first.locator('#historyNameSaveBtn')).toBeDisabled();
  await expect(first.locator('#historyPreviewText')).toHaveValue('Unsubmitted body edit');
  expect((await readHistory(browser.serviceWorker))[0].name).toBe('Newer name from second popup');
});

test('late favorite acknowledgement keeps a newer un-favorite and does not replace an unsaved name', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [{ id: 'shared', text: 'Saved text', name: 'Original', favorite: false, timestamp: 1 }] });
  const first = await delayedMetadataPopup(browser);
  const second = await openExtensionPage(browser, 'popup.html');
  await first.locator('#historyName').fill('Unsaved local name');
  await first.locator('#previewFavoriteBtn').click();
  await expect.poll(() => first.evaluate(() => Boolean(window.releaseMetadataResponse))).toBe(true);
  const result = await second.evaluate(() => chrome.runtime.sendMessage({
    action: 'updateHistoryMetadata', historyId: 'shared', patch: { favorite: false, name: 'Remote saved name' }
  }));
  expect(result.success).toBe(true);
  await expect.poll(() => first.evaluate(() => window.observedHistory?.[0]?.name)).toBe('Remote saved name');
  await first.evaluate(() => window.releaseMetadataResponse());
  await expect(first.locator('#previewFavoriteBtn')).toBeEnabled();
  await expect(first.locator('#previewFavoriteBtn')).toHaveAttribute('aria-pressed', 'false');
  await expect(first.locator('#historyName')).toHaveValue('Unsaved local name');
  await first.locator('#historyNameCancelBtn').click();
  await expect(first.locator('#historyName')).toHaveValue('Remote saved name');
});
