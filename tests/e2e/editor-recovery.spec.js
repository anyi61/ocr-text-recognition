'use strict';

const { test, expect } = require('./fixtures');
const { setStorage, openExtensionPage, readHistory } = require('./helpers');

async function openEditor(browser) {
  const popup = await openExtensionPage(browser, 'popup.html');
  await popup.locator('.history-item[data-history-id="shared"]').click();
  await expect(popup.locator('[data-draft=panel]')).toHaveAttribute('data-state', /idle|available/);
  return popup;
}

test('new input during a pending discard persists even if its popup closes before storage completes', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [{ id: 'shared', text: 'Original text', timestamp: 1 }] });
  let popup = await openEditor(browser);
  await popup.locator('#historyPreviewText').fill('Discard this draft');
  await expect(popup.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'saved');
  await browser.serviceWorker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    let delayed = false;
    Object.defineProperty(chrome.storage.local, 'set', { configurable: true, value: async (values) => {
      if (!delayed && values.ocrHistory?.some((record) => record.id === 'shared' && !record.draft)) {
        delayed = true;
        await new Promise((resolve) => { globalThis.__releaseDraftDiscard = resolve; });
      }
      return original(values);
    } });
  });
  await popup.locator('[data-draft=discard]').click();
  await expect.poll(() => browser.serviceWorker.evaluate(() => Boolean(globalThis.__releaseDraftDiscard))).toBe(true);
  await popup.locator('#historyPreviewText').fill('New input must survive discard and closure');
  await popup.close();
  await browser.serviceWorker.evaluate(() => globalThis.__releaseDraftDiscard());
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.draft?.text).toBe('New input must survive discard and closure');
  popup = await openEditor(browser);
  await popup.locator('[data-draft=restore]').click();
  await expect(popup.locator('#historyPreviewText')).toHaveValue('New input must survive discard and closure');
  expect((await readHistory(browser.serviceWorker))[0].text).toBe('Original text');
});

test('retry after a competing draft is discarded persists local text and survives reopening', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [{ id: 'shared', text: 'Original text', timestamp: 1 }] });
  const first = await openEditor(browser);
  let second = await openEditor(browser);
  await first.locator('#historyPreviewText').fill('First window draft');
  await expect(first.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'saved');
  await second.locator('#historyPreviewText').fill('Second window unsaved text');
  await expect(second.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'conflict');
  await first.locator('[data-draft=discard]').click();
  await expect(first.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'idle');
  await second.locator('[data-draft=retry]').click();
  await expect(second.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'saved');
  await second.close();
  second = await openEditor(browser);
  await second.locator('[data-draft=restore]').click();
  await expect(second.locator('#historyPreviewText')).toHaveValue('Second window unsaved text');
  expect((await readHistory(browser.serviceWorker))[0].text).toBe('Original text');
});

test('retry with a competing draft still present preserves both windows texts', async ({ extBrowser: browser }) => {
  await setStorage(browser, { ocrHistory: [{ id: 'shared', text: 'Original text', timestamp: 1 }] });
  const first = await openEditor(browser);
  const second = await openEditor(browser);
  await first.locator('#historyPreviewText').fill('First window draft');
  await expect(first.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'saved');
  await second.locator('#historyPreviewText').fill('Second window unsaved text');
  await expect(second.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'conflict');
  await second.locator('[data-draft=retry]').click();
  await expect(second.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'available');
  await expect(second.locator('#historyPreviewText')).toHaveValue('Second window unsaved text');
  await expect(first.locator('#historyPreviewText')).toHaveValue('First window draft');
  expect((await readHistory(browser.serviceWorker))[0].draft.text).toBe('First window draft');
  await second.locator('[data-draft=discard]').click();
  await expect(second.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'error');
  await expect(second.locator('#historyPreviewText')).toHaveValue('Second window unsaved text');
  expect((await readHistory(browser.serviceWorker))[0].draft).toBeUndefined();
  await second.locator('[data-draft=retry]').click();
  await expect(second.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'saved');
  expect((await readHistory(browser.serviceWorker))[0].draft.text).toBe('Second window unsaved text');
});
