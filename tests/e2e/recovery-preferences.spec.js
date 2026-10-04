'use strict';

const { test, expect } = require('./fixtures');
const { startCapture, selectAndConfirm, readHistory, setStorage, readStorage,
  uploadImage, openExtensionPage, restartBrowser } = require('./helpers');
const imageOf = (request) => request.body.messages[0].content[1].image_url.url;
const translation = (page, name) => page.locator(`[data-translation="${name}"]`);

async function failCapture(mock, browser, page) {
  mock.state.queue.push({ status: 401 });
  await startCapture(browser, page);
  await selectAndConfirm(page);
  await expect(page.locator('#ocr-recovery-panel')).toBeVisible();
}

async function recognizeWorkspace(workspace) {
  await uploadImage(workspace);
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageResultText')).toHaveValue('MOCK OCR RESULT 12345');
}

test('failed capture keeps its exact image and retry uses current settings without another screenshot', async ({ mock, extBrowser: browser, page }) => {
  await failCapture(mock, browser, page);
  const original = imageOf(mock.state.requests[0]);
  await expect(page.locator('#ocr-recovery-preview')).toHaveAttribute('src', original);
  expect(await readHistory(browser.serviceWorker)).toHaveLength(0);
  await page.evaluate(() => { document.body.style.background = 'red'; });
  await setStorage(browser, { apiConfigs: { openaiCompatible: {
    endpoint: `${mock.origin}/v1/chat/completions`, apiKey: 'changed-key', model: 'changed-model'
  } } });
  await page.locator('#ocr-retry-original').click();
  await expect(page.locator('#ocr-result-text')).toHaveValue('MOCK OCR RESULT 12345');
  expect(imageOf(mock.state.requests[1])).toBe(original);
  expect(mock.state.requests[1].body.model).toBe('changed-model');
  expect(mock.state.requests[1].authorization).toBe('Bearer changed-key');
  await expect(page.locator('#ocr-recovery-panel')).toHaveCount(0);
  expect(await readHistory(browser.serviceWorker)).toHaveLength(1);
});

test('failed capture settings entry opens options while preserving retry image', async ({ mock, extBrowser: browser, page }) => {
  await failCapture(mock, browser, page);
  const original = await page.locator('#ocr-recovery-preview').getAttribute('src');
  const optionsPromise = browser.context.waitForEvent('page');
  await page.locator('#ocr-recovery-settings').click();
  const options = await optionsPromise;
  await options.waitForURL(`chrome-extension://${browser.extensionId}/options.html`);
  await expect(options.locator('#apiProvider')).toBeVisible();
  await expect(page.locator('#ocr-recovery-preview')).toHaveAttribute('src', original);
  expect(mock.state.requests).toHaveLength(1);
});

test('reselect after failure captures changed page pixels instead of retrying the old image', async ({ mock, extBrowser: browser, page }) => {
  await failCapture(mock, browser, page);
  const original = imageOf(mock.state.requests[0]);
  await page.evaluate(() => { document.body.style.background = 'red'; });
  await page.locator('#ocr-reselect-region').click();
  await selectAndConfirm(page);
  await expect(page.locator('#ocr-result-text')).toHaveValue('MOCK OCR RESULT 12345');
  expect(imageOf(mock.state.requests[1])).not.toBe(original);
});

test('dismissing failed recognition leaves no result or history and permits a fresh capture', async ({ mock, extBrowser: browser, page }) => {
  await failCapture(mock, browser, page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#ocr-recovery-panel')).toHaveCount(0);
  expect(mock.state.requests).toHaveLength(1);
  expect(await readHistory(browser.serviceWorker)).toHaveLength(0);
  await startCapture(browser, page);
  await selectAndConfirm(page);
  await expect(page.locator('#ocr-result-text')).toHaveValue('MOCK OCR RESULT 12345');
});

test('cancelled delayed retry cannot show a late result or history', async ({ mock, extBrowser: browser, page }) => {
  await failCapture(mock, browser, page);
  mock.state.queue.push({ delay: 800, text: 'STALE RETRY' });
  await page.locator('#ocr-retry-original').click();
  await mock.waitForRequestCount(2);
  await page.locator('.ocr-progress-cancel').click();
  await mock.waitForAbortCount(1);
  await page.waitForTimeout(900);
  await expect(page.locator('#ocr-result-popup')).toHaveCount(0);
  await expect(page.locator('#ocr-recovery-panel')).toHaveCount(0);
  expect(await readHistory(browser.serviceWorker)).toHaveLength(0);
});

test('workspace retry preserves failed imported pixels and settings entry', async ({ mock, extBrowser: browser, workspace }) => {
  await uploadImage(workspace);
  mock.state.queue.push({ status: 401 });
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageRecoveryActions')).toBeVisible();
  const original = imageOf(mock.state.requests[0]);
  await expect(workspace.locator('#imagePreview')).toHaveAttribute('src', original);
  const optionsPromise = browser.context.waitForEvent('page');
  await workspace.locator('#imageRecoverySettings').click();
  await (await optionsPromise).waitForURL(`chrome-extension://${browser.extensionId}/options.html`);
  await workspace.bringToFront();
  await workspace.locator('#retryImageOCR').click();
  await expect(workspace.locator('#imageResultText')).toHaveValue('MOCK OCR RESULT 12345');
  expect(imageOf(mock.state.requests[1])).toBe(original);
  await expect(workspace.locator('#imageRecoveryActions')).toBeHidden();
});

test('workspace choose-new replaces failed image and cancelling delayed retry permits another recognition', async ({ mock, extBrowser: browser, workspace }) => {
  await uploadImage(workspace);
  mock.state.queue.push({ status: 401 });
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageRecoveryActions')).toBeVisible();
  const original = imageOf(mock.state.requests[0]);
  mock.state.queue.push({ delay: 800, text: 'STALE IMPORT' });
  await workspace.locator('#retryImageOCR').click();
  await mock.waitForRequestCount(2);
  await workspace.locator('#cancelImageOCR').click();
  await mock.waitForAbortCount(1);
  await uploadImage(workspace, '#abcdef', 'replacement.png');
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageResultText')).toHaveValue('MOCK OCR RESULT 12345');
  expect(imageOf(mock.state.requests[2])).not.toBe(original);
  await workspace.waitForTimeout(900);
  expect(await readHistory(browser.serviceWorker)).toHaveLength(1);
});

test('translation defaults stay independent of OCR and interface language', async ({ extBrowser: browser, workspace }) => {
  await setStorage(browser, { apiProvider: 'openai-compatible', uiLanguage: 'en' });
  await recognizeWorkspace(workspace);
  await expect(translation(workspace, 'provider')).toHaveValue('claude');
  await expect(translation(workspace, 'target')).toHaveValue('zh_CN');
  expect((await readStorage(browser, ['translationProvider', 'translationTargetLanguage'])).translationProvider).toBeUndefined();
});

test('explicit translation choices survive new pages and browser restart independently', async ({ extBrowser: browser, workspace }) => {
  await recognizeWorkspace(workspace);
  await translation(workspace, 'provider').selectOption('openai-compatible');
  await translation(workspace, 'target').selectOption('ja');
  await expect.poll(() => readStorage(browser, ['translationProvider', 'translationTargetLanguage']))
    .toEqual({ translationProvider: 'openai-compatible', translationTargetLanguage: 'ja' });
  await setStorage(browser, { uiLanguage: 'zh_CN', apiProvider: 'openai-compatible' });
  const second = await openExtensionPage(browser);
  await recognizeWorkspace(second);
  await expect(translation(second, 'provider')).toHaveValue('openai-compatible');
  await expect(translation(second, 'target')).toHaveValue('ja');
  await restartBrowser(browser);
  const third = await openExtensionPage(browser);
  await recognizeWorkspace(third);
  await expect(translation(third, 'provider')).toHaveValue('openai-compatible');
  await expect(translation(third, 'target')).toHaveValue('ja');
});

test('restoring historic translation selects its metadata without overwriting global choices', async ({ extBrowser: browser }) => {
  const source = 'HISTORIC SOURCE';
  await setStorage(browser, {
    translationProvider: 'openai-compatible', translationTargetLanguage: 'ja',
    ocrHistory: [{ id: 'translated', text: source, provider: 'openai-compatible', timestamp: new Date().toISOString(),
      translation: { sourceText: source, text: 'HISTORIC FRENCH', provider: 'openai', targetLanguage: 'fr', model: 'historic', timestamp: new Date().toISOString() } }]
  });
  const popup = await openExtensionPage(browser, 'popup.html');
  await popup.locator('.history-item').click();
  await expect(translation(popup, 'text')).toHaveValue('HISTORIC FRENCH');
  await expect(translation(popup, 'provider')).toHaveValue('openai');
  await expect(translation(popup, 'target')).toHaveValue('fr');
  expect(await readStorage(browser, ['translationProvider', 'translationTargetLanguage']))
    .toEqual({ translationProvider: 'openai-compatible', translationTargetLanguage: 'ja' });
  await translation(popup, 'target').selectOption('de');
  await expect.poll(() => readStorage(browser, ['translationProvider', 'translationTargetLanguage']))
    .toEqual({ translationProvider: 'openai-compatible', translationTargetLanguage: 'de' });
});

test('late preference loading cannot reset a selection made by the user', async ({ extBrowser: browser }) => {
  await setStorage(browser, { translationProvider: 'openai', translationTargetLanguage: 'fr' });
  const workspace = await browser.context.newPage();
  await workspace.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const response = await send(message);
      if (message.action === 'getTranslationPreferences') await new Promise((resolve) => setTimeout(resolve, 900));
      return response;
    };
  });
  await workspace.goto(`chrome-extension://${browser.extensionId}/workspace.html`);
  await recognizeWorkspace(workspace);
  await translation(workspace, 'provider').selectOption('openai-compatible');
  await translation(workspace, 'target').selectOption('ja');
  await workspace.waitForTimeout(1000);
  await expect(translation(workspace, 'provider')).toHaveValue('openai-compatible');
  await expect(translation(workspace, 'target')).toHaveValue('ja');
  expect(await readStorage(browser, ['translationProvider', 'translationTargetLanguage']))
    .toEqual({ translationProvider: 'openai-compatible', translationTargetLanguage: 'ja' });
});

test('failed preference save keeps the selected value and offers an explicit retry', async ({ extBrowser: browser }) => {
  const workspace = await browser.context.newPage();
  await workspace.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    let failed = false;
    chrome.runtime.sendMessage = async (message) => {
      if (message.action === 'saveTranslationPreferences' && !failed) {
        failed = true;
        return { success: false, errorCode: 'TRANSLATION_PREFERENCES_SAVE_FAILED' };
      }
      return send(message);
    };
  });
  await workspace.goto(`chrome-extension://${browser.extensionId}/workspace.html`);
  await recognizeWorkspace(workspace);
  await translation(workspace, 'target').selectOption('ja');
  await expect(translation(workspace, 'preferences-status')).toBeVisible();
  await expect(translation(workspace, 'target')).toHaveValue('ja');
  expect((await readStorage(browser, 'translationTargetLanguage')).translationTargetLanguage).toBeUndefined();
  await translation(workspace, 'preferences-retry').click();
  await expect.poll(() => readStorage(browser, 'translationTargetLanguage')).toEqual({ translationTargetLanguage: 'ja' });
  await expect(translation(workspace, 'preferences-status')).toBeHidden();
});

test('different translation preference fields changed in concurrent pages both persist', async ({ extBrowser: browser, workspace }) => {
  await recognizeWorkspace(workspace);
  const second = await openExtensionPage(browser);
  await recognizeWorkspace(second);
  await Promise.all([
    translation(workspace, 'provider').selectOption('openai-compatible'),
    translation(second, 'target').selectOption('de')
  ]);
  await expect.poll(() => readStorage(browser, ['translationProvider', 'translationTargetLanguage']))
    .toEqual({ translationProvider: 'openai-compatible', translationTargetLanguage: 'de' });
  const third = await openExtensionPage(browser);
  await recognizeWorkspace(third);
  await expect(translation(third, 'provider')).toHaveValue('openai-compatible');
  await expect(translation(third, 'target')).toHaveValue('de');
});

test('failed capture focuses original-image retry and supports Enter without a fresh selection', async ({ mock, extBrowser: browser, page }) => {
  await failCapture(mock, browser, page);
  await expect(page.locator('#ocr-retry-original')).toBeFocused();
  const original = imageOf(mock.state.requests[0]);
  await page.keyboard.press('Enter');
  await expect(page.locator('#ocr-result-text')).toHaveValue('MOCK OCR RESULT 12345');
  expect(imageOf(mock.state.requests[1])).toBe(original);
});

test('workspace keyboard Escape cancels a focused retry while retaining the imported image', async ({ mock, extBrowser: browser, workspace }) => {
  await uploadImage(workspace);
  mock.state.queue.push({ status: 401 });
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#retryImageOCR')).toBeFocused();
  const original = await workspace.locator('#imagePreview').getAttribute('src');
  mock.state.queue.push({ delay: 800, text: 'CANCELLED KEYBOARD RETRY' });
  await workspace.keyboard.press('Enter');
  await mock.waitForRequestCount(2);
  await expect(workspace.locator('#cancelImageOCR')).toBeFocused();
  await workspace.keyboard.press('Escape');
  await mock.waitForAbortCount(1);
  await workspace.waitForTimeout(900);
  await expect(workspace.locator('#imagePreview')).toHaveAttribute('src', original);
  await expect(workspace.locator('#recognizeImage')).toBeEnabled();
  await expect(workspace.locator('#imageResultSection')).toBeHidden();
  expect(await readHistory(browser.serviceWorker)).toHaveLength(0);
});

test('workspace recovery choose-new action opens the file chooser and replaces failed pixels', async ({ mock, workspace }) => {
  await uploadImage(workspace);
  mock.state.queue.push({ status: 401 });
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageRecoveryActions')).toBeVisible();
  const original = imageOf(mock.state.requests[0]);
  const chooserPromise = workspace.waitForEvent('filechooser');
  await workspace.locator('#chooseNewImage').click();
  await (await chooserPromise).setFiles(require('node:path').resolve(__dirname, '../../icons/icon128.png'));
  await expect(workspace.locator('#imageRecoveryActions')).toBeHidden();
  await expect(workspace.locator('#recognizeImage')).toBeEnabled();
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageResultText')).toHaveValue('MOCK OCR RESULT 12345');
  expect(imageOf(mock.state.requests[1])).not.toBe(original);
});
