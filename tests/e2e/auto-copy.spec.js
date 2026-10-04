'use strict';

const { test, expect } = require('./fixtures');
const { startCapture, selectAndConfirm, readHistory, setStorage, readStorage,
  uploadImage, openExtensionPage, restartBrowser } = require('./helpers');
const writes = async (browser) => (await readStorage(browser, 'e2eClipboardWrites')).e2eClipboardWrites || [];

for (const location of ['capture', 'workspace']) {
  test(`automatic copy defaults off for ${location} while manual copy remains usable`, async ({ extBrowser: browser, page, workspace }) => {
    await setStorage(browser, { e2eClipboardMode: 'success' });
    if (location === 'capture') {
      await startCapture(browser, page); await selectAndConfirm(page);
      await expect(page.locator('#ocr-result-text')).toHaveValue('MOCK OCR RESULT 12345');
      await expect(page.locator('#ocr-auto-copy-status')).toBeHidden();
    } else {
      await uploadImage(workspace); await workspace.locator('#recognizeImage').click();
      await expect(workspace.locator('#imageResultText')).toHaveValue('MOCK OCR RESULT 12345');
      await expect(workspace.locator('#imageAutoCopyStatus')).toBeHidden();
    }
    expect(await writes(browser)).toEqual([]);
    await (location === 'capture' ? page.locator('.copy-btn') : workspace.locator('#copyImageResult')).click();
    await expect.poll(() => writes(browser)).toEqual(['MOCK OCR RESULT 12345']);
  });

  test(`automatic copy runs once after new ${location} success and ignores edits and history reopening`, async ({ extBrowser: browser, page, workspace }) => {
    await setStorage(browser, { autoCopy: true, e2eClipboardMode: 'success' });
    if (location === 'capture') {
      await startCapture(browser, page); await selectAndConfirm(page);
      await expect(page.locator('#ocr-auto-copy-status')).toBeVisible();
      await page.locator('#ocr-result-text').fill('Edited capture');
    } else {
      await uploadImage(workspace); await workspace.locator('#recognizeImage').click();
      await expect(workspace.locator('#imageAutoCopyStatus')).toBeVisible();
      await workspace.locator('#imageResultText').fill('Edited import');
    }
    await expect.poll(() => writes(browser)).toEqual(['MOCK OCR RESULT 12345']);
    const popup = await openExtensionPage(browser, 'popup.html');
    await popup.locator('.history-item').click();
    await expect(popup.locator('#historyPreviewText')).toHaveValue('MOCK OCR RESULT 12345');
    expect(await writes(browser)).toEqual(['MOCK OCR RESULT 12345']);
  });

  test(`clipboard rejection preserves ${location} result and supports manual recovery`, async ({ extBrowser: browser, page, workspace }) => {
    await setStorage(browser, { autoCopy: true, e2eClipboardMode: 'fail', uiLanguage: 'en' });
    let status, text, copy;
    if (location === 'capture') {
      await startCapture(browser, page); await selectAndConfirm(page);
      status = page.locator('#ocr-auto-copy-status'); text = page.locator('#ocr-result-text'); copy = page.locator('.copy-btn');
    } else {
      await uploadImage(workspace); await workspace.locator('#recognizeImage').click();
      status = workspace.locator('#imageAutoCopyStatus'); text = workspace.locator('#imageResultText'); copy = workspace.locator('#copyImageResult');
    }
    await expect(status).toBeVisible();
    await expect(status).toContainText(/could not|failed|unable/i);
    await expect(text).toHaveValue('MOCK OCR RESULT 12345');
    expect(await readHistory(browser.serviceWorker)).toHaveLength(1);
    await setStorage(browser, { e2eClipboardMode: 'success' });
    await copy.click();
    await expect.poll(() => writes(browser)).toEqual(['MOCK OCR RESULT 12345', 'MOCK OCR RESULT 12345']);
    await expect(status).toBeHidden();
  });
}

test('automatic copy preference defaults off, persists from settings across restart, and turns off again', async ({ extBrowser: browser }) => {
  const options = await openExtensionPage(browser, 'options.html');
  await expect(options.locator('#autoCopy')).not.toBeChecked();
  await options.locator('#autoCopy').check();
  await expect.poll(() => readStorage(browser, 'autoCopy')).toEqual({ autoCopy: true });
  await restartBrowser(browser);
  const reopened = await openExtensionPage(browser, 'options.html');
  await expect(reopened.locator('#autoCopy')).toBeChecked();
  await reopened.locator('#autoCopy').uncheck();
  await expect.poll(() => readStorage(browser, 'autoCopy')).toEqual({ autoCopy: false });
});

test('failed and cancelled recognitions never automatically copy', async ({ mock, extBrowser: browser, workspace }) => {
  await setStorage(browser, { autoCopy: true, e2eClipboardMode: 'success' });
  await uploadImage(workspace);
  mock.state.queue.push({ status: 401 });
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageRecoveryActions')).toBeVisible();
  expect(await writes(browser)).toEqual([]);
  mock.state.queue.push({ delay: 800 });
  await workspace.locator('#retryImageOCR').click();
  await mock.waitForRequestCount(2);
  await workspace.locator('#cancelImageOCR').click();
  await mock.waitForAbortCount(1);
  await workspace.waitForTimeout(900);
  expect(await writes(browser)).toEqual([]);
  expect(await readHistory(browser.serviceWorker)).toHaveLength(0);
});

test('late clipboard rejection cannot overwrite a newer edited result status', async ({ extBrowser: browser, workspace }) => {
  await setStorage(browser, { autoCopy: true, e2eClipboardMode: 'fail', e2eClipboardDelay: 600 });
  await uploadImage(workspace);
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageResultText')).toHaveValue('MOCK OCR RESULT 12345');
  await expect.poll(() => writes(browser)).toHaveLength(1);
  await workspace.locator('#imageResultText').fill('NEW EDIT');
  await workspace.waitForTimeout(700);
  await expect(workspace.locator('#imageAutoCopyStatus')).toBeHidden();
  await expect(workspace.locator('#imageResultText')).toHaveValue('NEW EDIT');
  await expect(workspace.locator('#saveImageResult')).toBeEnabled();
});

test('enabled automatic copy writes recognized text to the real Chromium clipboard', async ({ extBrowser: browser, workspace }) => {
  await browser.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await setStorage(browser, { autoCopy: true, uiLanguage: 'en' });
  await workspace.bringToFront();
  await workspace.evaluate(() => navigator.clipboard.writeText('Before OCR'));
  await uploadImage(workspace);
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageAutoCopyStatus')).toBeVisible();
  await expect.poll(() => workspace.evaluate(() => navigator.clipboard.readText())).toBe('MOCK OCR RESULT 12345');
  expect((await readStorage(browser, 'e2eClipboardWrites')).e2eClipboardWrites).toBeUndefined();
});
