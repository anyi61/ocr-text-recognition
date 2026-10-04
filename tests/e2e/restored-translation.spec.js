'use strict';

const { test, expect } = require('./fixtures');
const { startCapture, selectAndConfirm, readHistory, openPopupForTab, setStorage, readStorage, RESULT_TEXT } = require('./helpers');

async function recognize(browser, page) {
  await startCapture(browser, page);
  await page.bringToFront();
  await selectAndConfirm(page);
  await expect(page.locator('#ocr-result-text')).toHaveValue(RESULT_TEXT);
  await expect(page.locator('[data-translation=provider]')).toBeEnabled();
  await page.locator('[data-translation=provider]').selectOption('openai-compatible');
  await page.locator('[data-translation=target]').selectOption('ja');
}

async function translate(page, mock, text = '保存された翻訳') {
  mock.state.queue.push({ text });
  await page.locator('[data-translation=start]').click();
  await expect(page.locator('[data-translation=text]')).toHaveValue(text);
  await expect(page.locator('[data-translation=panel]')).toHaveAttribute('data-state', 'success');
}

test('restored: translation sends only visible text, saves its exact source, and copies separately', async ({ extBrowser: browser, page, mock }) => {
  await recognize(browser, page);
  expect(mock.state.requests).toHaveLength(1);
  await translate(page, mock);
  const translationRequest = mock.state.requests[1].body;
  expect(JSON.stringify(translationRequest)).toContain(RESULT_TEXT);
  expect(JSON.stringify(translationRequest)).not.toContain('image_url');
  expect(JSON.stringify(translationRequest)).not.toContain('data:image');
  await expect(page.locator('#ocr-result-text')).toHaveValue(RESULT_TEXT);
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.translation?.text).toBe('保存された翻訳');
  const record = (await readHistory(browser.serviceWorker))[0];
  expect(record.text).toBe(RESULT_TEXT);
  expect(record.translation).toMatchObject({ sourceText: RESULT_TEXT, provider: 'openai-compatible', targetLanguage: 'ja' });
  await browser.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('[data-translation=copy]').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('保存された翻訳');
});

test('restored: editing source marks the saved translation stale and explicit retry snapshots new text', async ({ extBrowser: browser, page, mock }) => {
  await recognize(browser, page);
  await translate(page, mock);
  await page.locator('#ocr-result-text').fill('Corrected source to translate');
  await expect(page.locator('[data-translation=panel]')).toHaveAttribute('data-state', 'stale');
  await expect(page.locator('[data-translation=copy]')).toBeDisabled();
  await expect(page.locator('[data-translation=text]')).toHaveValue('保存された翻訳');
  await translate(page, mock, '新しい翻訳');
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.translation?.sourceText).toBe('Corrected source to translate');
  expect((await readHistory(browser.serviceWorker))[0].text).toBe(RESULT_TEXT);
});

for (const action of ['cancel', 'source', 'provider', 'target', 'close']) {
  test(`restored: ${action} cancels an actual in-flight translation and prevents late persistence`, async ({ extBrowser: browser, page, mock }) => {
    await recognize(browser, page);
    mock.state.queue.push({ delay: 10_000, text: 'MUST NEVER PERSIST' });
    await page.locator('[data-translation=start]').click();
    await mock.waitForRequestCount(2);
    if (action === 'cancel') await page.locator('[data-translation=cancel]').click();
    if (action === 'source') await page.locator('#ocr-result-text').fill('New unsaved source');
    if (action === 'provider') await page.locator('[data-translation=provider]').selectOption('custom');
    if (action === 'target') await page.locator('[data-translation=target]').selectOption('fr');
    if (action === 'close') await page.locator('.ocr-close-btn').click();
    await mock.waitForAbortCount(1);
    const history = await readHistory(browser.serviceWorker);
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe(RESULT_TEXT);
    expect(history[0].translation).toBeUndefined();
    if (action === 'cancel') {
      await translate(page, mock, 'Retry completed');
      expect(mock.state.requests).toHaveLength(3);
    }
  });
}

test('restored: a failed or cancelled replacement keeps the previous saved translation recoverable', async ({ extBrowser: browser, page, mock }) => {
  await recognize(browser, page);
  await translate(page, mock, 'First successful translation');
  mock.state.queue.push({ status: 401 });
  await page.locator('[data-translation=start]').click();
  await expect(page.locator('[data-translation=panel]')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('[data-translation=text]')).toHaveValue('First successful translation');
  await expect(page.locator('[data-translation=copy]')).toBeEnabled();
  await expect(page.locator('#ocr-result-text')).toHaveValue(RESULT_TEXT);
  mock.state.queue.push({ delay: 10_000, text: 'Cancelled translation' });
  await page.locator('[data-translation=start]').click();
  await mock.waitForRequestCount(4);
  await page.locator('[data-translation=cancel]').click();
  await mock.waitForAbortCount(1);
  await expect(page.locator('[data-translation=copy]')).toBeEnabled();
  await browser.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('[data-translation=copy]').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('First successful translation');
  expect((await readHistory(browser.serviceWorker))[0].translation.text).toBe('First successful translation');
  await page.locator('.ocr-close-btn').click();
  const popup = await openPopupForTab(browser, page);
  await popup.locator('.history-item-text').first().click();
  await expect(popup.locator('[data-translation=text]')).toHaveValue('First successful translation');
  expect(mock.state.requests).toHaveLength(4);
});

test('restoring matching source text reuses the previous translation without another provider call', async ({ extBrowser: browser, page, mock }) => {
  await recognize(browser, page);
  await translate(page, mock, 'Reusable translation');
  await page.locator('#ocr-result-text').fill('Temporarily edited source');
  await expect(page.locator('[data-translation=copy]')).toBeDisabled();
  await page.locator('#ocr-result-text').fill(RESULT_TEXT);
  await expect(page.locator('[data-translation=panel]')).toHaveAttribute('data-state', 'success');
  await expect(page.locator('[data-translation=copy]')).toBeEnabled();
  await browser.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('[data-translation=copy]').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Reusable translation');
  expect(mock.state.requests).toHaveLength(2);
});

test('restored: saved history translation reopens without a request and remains stale after source commit', async ({ extBrowser: browser, page, mock }) => {
  await recognize(browser, page);
  await translate(page, mock);
  await page.locator('.ocr-close-btn').click();
  let popup = await openPopupForTab(browser, page);
  await popup.locator('.history-item-text').first().click();
  await expect(popup.locator('[data-translation=target]')).toHaveValue('ja');
  await expect(popup.locator('[data-translation=text]')).toHaveValue('保存された翻訳');
  await expect(popup.locator('[data-translation=copy]')).toBeEnabled();
  await popup.locator('#historyPreviewText').fill('Committed corrected original');
  await popup.locator('#previewSaveBtn').click();
  await expect(popup.locator('#previewSaveBtn')).toBeDisabled();
  await popup.close();
  popup = await openPopupForTab(browser, page);
  await popup.locator('.history-item-text').first().click();
  await expect(popup.locator('#historyPreviewText')).toHaveValue('Committed corrected original');
  await expect(popup.locator('[data-translation=panel]')).toHaveAttribute('data-state', 'stale');
  await expect(popup.locator('[data-translation=text]')).toHaveValue('保存された翻訳');
  await expect(popup.locator('[data-translation=copy]')).toBeDisabled();
  expect(mock.state.requests).toHaveLength(2);
});

test('restored: two translation windows stay independent and closing one leaves the other running', async ({ extBrowser: browser, page, mock }) => {
  await recognize(browser, page);
  const popup = await openPopupForTab(browser, page);
  await popup.locator('.history-item-text').first().click();
  await popup.locator('[data-translation=provider]').selectOption('openai-compatible');
  await popup.locator('[data-translation=target]').selectOption('fr');
  mock.state.queue.push({ delay: 10_000, text: 'Closing window translation' });
  await popup.locator('[data-translation=start]').click();
  await mock.waitForRequestCount(2);
  await page.bringToFront();
  mock.state.queue.push({ delay: 300, text: 'Independent completed translation' });
  await page.locator('[data-translation=start]').click();
  await mock.waitForRequestCount(3);
  await popup.close();
  await mock.waitForAbortCount(1);
  await expect(page.locator('[data-translation=text]')).toHaveValue('Independent completed translation');
  await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.translation?.text).toBe('Independent completed translation');
});

test('restored: custom Responses translates text only and retains the configured authentication', async ({ extBrowser: browser, page, mock }) => {
  const { apiConfigs } = await readStorage(browser, 'apiConfigs');
  await setStorage(browser, { apiConfigs: { ...apiConfigs, custom: {
    endpoint: `${mock.origin}/v1/responses`, model: 'responses-translation-model',
    apiKey: 'custom-translation-key', authMode: 'api-key', requestMode: 'responses'
  } } });
  await recognize(browser, page);
  await page.locator('[data-translation=provider]').selectOption('custom');
  await translate(page, mock, 'Custom response translation');
  const request = mock.state.requests[1];
  expect(request.path).toContain('/v1/responses');
  expect(request.body.model).toBe('responses-translation-model');
  expect(JSON.stringify(request.body)).toContain(RESULT_TEXT);
  expect(JSON.stringify(request.body)).not.toContain('input_image');
  expect(request.headers['api-key']).toBe('custom-translation-key');
});
