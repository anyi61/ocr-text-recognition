'use strict';

const { test, expect } = require('./fixtures');
const { startCapture, selectAndConfirm, readHistory, setStorage } = require('./helpers');

async function setEndpointPermission(browser, granted) {
  // The capture fixture grants <all_urls> to simulate a toolbar invocation.
  // Override only its background permission query to model a user revocation.
  await browser.serviceWorker.evaluate((granted) => {
    Object.defineProperty(chrome.permissions, 'contains', {
      configurable: true,
      value: async () => granted
    });
  }, granted);
}

test('page OCR blocks a permission revoked after selection starts and retains the captured image', async ({ mock, extBrowser: browser, page }) => {
  await setStorage(browser, { uiLanguage: 'en' });
  await startCapture(browser, page);
  await setEndpointPermission(browser, false);
  await selectAndConfirm(page);
  await expect(page.locator('#ocr-recovery-error')).toContainText('not authorized');
  await expect(page.locator('#ocr-recovery-preview')).toHaveAttribute('src', /^data:image\/png;base64,/);
  expect(mock.state.requests).toHaveLength(0);
  expect(await readHistory(browser.serviceWorker)).toHaveLength(0);
  await page.locator('#ocr-dismiss-recovery').click();
  await expect(page.locator('#ocr-recovery-panel')).toHaveCount(0);
  expect(mock.state.requests).toHaveLength(0);
});

test('failed page image retry cannot upload while permission is revoked and recovers the same image after access returns', async ({ mock, extBrowser: browser, page }) => {
  await setStorage(browser, { uiLanguage: 'en' });
  mock.state.queue.push({ status: 401 });
  await startCapture(browser, page);
  await selectAndConfirm(page);
  await expect(page.locator('#ocr-recovery-panel')).toBeVisible();
  const original = await page.locator('#ocr-recovery-preview').getAttribute('src');
  expect(mock.state.requests).toHaveLength(1);
  await setEndpointPermission(browser, false);
  await page.locator('#ocr-retry-original').click();
  await expect(page.locator('#ocr-recovery-error')).toContainText('not authorized');
  await expect(page.locator('#ocr-recovery-preview')).toHaveAttribute('src', original);
  expect(mock.state.requests).toHaveLength(1);
  expect(await readHistory(browser.serviceWorker)).toHaveLength(0);
  await setEndpointPermission(browser, true);
  await page.locator('#ocr-retry-original').click();
  await expect(page.locator('#ocr-result-text')).toHaveValue('MOCK OCR RESULT 12345');
  expect(mock.state.requests).toHaveLength(2);
  expect(mock.state.requests[1].body.messages[0].content[1].image_url.url).toBe(original);
  expect(await readHistory(browser.serviceWorker)).toHaveLength(1);
});
