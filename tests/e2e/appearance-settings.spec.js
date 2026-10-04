'use strict';

const { test, expect } = require('./fixtures');
const { setStorage, readStorage, openExtensionPage, restartBrowser } = require('./helpers');

test('popup appearance changes persist through restart without changing OCR or translation preferences', async ({ extBrowser: browser }) => {
  await setStorage(browser, { theme: 'light', uiLanguage: 'en', translationProvider: 'custom', translationTargetLanguage: 'fr' });
  const popup = await openExtensionPage(browser, 'popup.html');
  await expect(popup.locator('#languageSelect')).toHaveValue('en');
  await popup.locator('#themeBtn').click();
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
  await popup.locator('#languageSelect').selectOption('zh_CN');
  await expect(popup.locator('#languageSelect')).toBeEnabled();
  await expect.poll(() => readStorage(browser, ['theme', 'uiLanguage'])).toEqual({ theme: 'dark', uiLanguage: 'zh_CN' });
  await restartBrowser(browser);
  const reopened = await openExtensionPage(browser, 'popup.html');
  await expect(reopened.locator('#languageSelect')).toHaveValue('zh_CN');
  await expect(reopened.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await readStorage(browser, ['apiProvider', 'translationProvider', 'translationTargetLanguage']))
    .toEqual({ apiProvider: 'openai-compatible', translationProvider: 'custom', translationTargetLanguage: 'fr' });
});

test('rejected popup appearance writes retain saved controls and allow another attempt', async ({ extBrowser: browser }) => {
  await setStorage(browser, { theme: 'light', uiLanguage: 'en' });
  const popup = await browser.context.newPage();
  await popup.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.rejectAppearance = true;
    chrome.runtime.sendMessage = (message, ...rest) => window.rejectAppearance && message.action === 'saveAppearancePreferences'
      ? Promise.resolve({ success: false, errorCode: 'SETTINGS_SAVE_FAILED' }) : send(message, ...rest);
  });
  const dialogs = [];
  popup.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await expect(popup.locator('#languageSelect')).toHaveValue('en');
  await popup.locator('#themeBtn').click();
  await expect.poll(() => dialogs.length).toBe(1);
  await expect(popup.locator('#themeBtn')).toBeEnabled();
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light');
  await popup.locator('#languageSelect').selectOption('zh_CN');
  await expect.poll(() => dialogs.length).toBe(2);
  expect(dialogs.every((message) => message.includes('Could not save settings'))).toBe(true);
  await expect(popup.locator('#languageSelect')).toHaveValue('en');
  await expect(popup.locator('#languageSelect')).toBeEnabled();
  expect(await readStorage(browser, ['theme', 'uiLanguage'])).toEqual({ theme: 'light', uiLanguage: 'en' });
  await popup.evaluate(() => { window.rejectAppearance = false; });
  await popup.locator('#languageSelect').selectOption('zh_CN');
  await expect.poll(async () => (await readStorage(browser, 'uiLanguage')).uiLanguage).toBe('zh_CN');
});

async function openWithDelayedAppearanceReply(browser, filename) {
  const page = await browser.context.newPage();
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message, ...rest) => {
      const result = await send(message, ...rest);
      if (message.action === 'saveAppearancePreferences') {
        await new Promise((resolve) => { window.releaseAppearanceReply = resolve; });
        window.appearanceReplyDelivered = true;
      }
      return result;
    };
  });
  await page.goto(`chrome-extension://${browser.extensionId}/${filename}`);
  return page;
}

test('late popup theme acknowledgement cannot override a newer settings import', async ({ extBrowser: browser }) => {
  await setStorage(browser, { theme: 'light', uiLanguage: 'en' });
  const options = await openExtensionPage(browser, 'options.html');
  const popup = await openWithDelayedAppearanceReply(browser, 'popup.html');
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light');
  await popup.locator('#themeBtn').click();
  await popup.waitForFunction(() => Boolean(window.releaseAppearanceReply));
  // Another options page uses the same queued transaction as a backup import.
  expect(await options.evaluate(() => chrome.runtime.sendMessage({
    action: 'saveSettings', settings: { theme: 'light' }
  }))).toEqual({ success: true });
  await popup.evaluate(() => window.releaseAppearanceReply());
  await expect(popup.locator('#themeBtn')).toBeEnabled();
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await readStorage(browser, 'theme')).toEqual({ theme: 'light' });
});

for (const [filename, selector] of [['popup.html', '#languageSelect'], ['options.html', '#uiLanguage']]) {
  test(`late ${filename} language acknowledgement keeps its selector consistent with the latest import`, async ({ extBrowser: browser }) => {
    await setStorage(browser, { uiLanguage: 'en' });
    const otherOptions = await openExtensionPage(browser, 'options.html');
    const page = await openWithDelayedAppearanceReply(browser, filename);
    await expect(page.locator(selector)).toHaveValue('en');
    await page.locator(selector).selectOption('zh_CN');
    await page.waitForFunction(() => Boolean(window.releaseAppearanceReply));
    expect(await otherOptions.evaluate(() => chrome.runtime.sendMessage({
      action: 'saveSettings', settings: { uiLanguage: 'en' }
    }))).toEqual({ success: true });
    await page.waitForFunction(() => OCRI18n.getLanguageSetting() === 'en');
    await page.evaluate(() => window.releaseAppearanceReply());
    await page.waitForFunction(() => window.appearanceReplyDelivered);
    await expect(page.locator(selector)).toHaveValue('en');
    expect(await readStorage(browser, 'uiLanguage')).toEqual({ uiLanguage: 'en' });
  });
}

test('appearance changes update other open pages without replacing unsaved settings fields', async ({ extBrowser: browser }) => {
  await setStorage(browser, { uiLanguage: 'en', theme: 'light' });
  const options = await openExtensionPage(browser, 'options.html');
  const popup = await openExtensionPage(browser, 'popup.html');
  await expect(options.locator('#uiLanguage')).toHaveValue('en');
  await options.locator('#prompt').fill('Still editing this prompt');
  await popup.locator('#languageSelect').selectOption('zh_CN');
  await popup.locator('#themeBtn').click();
  await expect(options.locator('#uiLanguage')).toHaveValue('zh_CN');
  await expect(options.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(options.locator('#theme')).toHaveValue('dark');
  await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(options.locator('#prompt')).toHaveValue('Still editing this prompt');

  await options.locator('#uiLanguage').selectOption('en');
  await options.locator('#theme').selectOption('light');
  await expect(popup.locator('#languageSelect')).toHaveValue('en');
  await expect(popup.locator('html')).toHaveAttribute('lang', 'en');
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('external language changes preserve the active history draft and translation request', async ({ extBrowser: browser, mock }) => {
  await setStorage(browser, { uiLanguage: 'en', theme: 'light',
    translationProvider: 'openai-compatible', translationTargetLanguage: 'ja',
    ocrHistory: [{ id: 'active-language-editor', text: 'Original text', name: 'Saved name',
      provider: 'openai-compatible', language: 'en', timestamp: 1,
      translation: { text: 'Retained translation', sourceText: 'Original text',
        provider: 'openai-compatible', targetLanguage: 'ja', model: 'mock-vision-model', timestamp: 1 } }]
  });
  const options = await openExtensionPage(browser, 'options.html');
  const popup = await openExtensionPage(browser, 'popup.html');
  await popup.locator('.history-item[data-history-id="active-language-editor"]').click();
  await expect(popup.locator('[data-translation=text]')).toHaveValue('Retained translation');
  await popup.locator('#historyPreviewText').fill('Uncommitted original correction');
  await popup.locator('#historyName').fill('Uncommitted name');
  await expect(popup.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'saved');
  await popup.evaluate(() => {
    window.activeTranslationPanel = document.querySelector('[data-translation=panel]');
    window.activeDraftPanel = document.querySelector('[data-draft=panel]');
  });
  mock.state.queue.push({ delay: 1500, text: 'Completed during language change' });
  await popup.locator('[data-translation=start]').click();
  await mock.waitForRequestCount(1);
  await expect(popup.locator('[data-translation=panel]')).toHaveAttribute('data-state', 'translating');
  await options.locator('#uiLanguage').selectOption('zh_CN');
  await expect(popup.locator('#languageSelect')).toHaveValue('zh_CN');
  await expect(popup.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(popup.locator('#historyPreviewText')).toHaveValue('Uncommitted original correction');
  await expect(popup.locator('#historyName')).toHaveValue('Uncommitted name');
  expect(await popup.evaluate(() => ({
    translation: window.activeTranslationPanel === document.querySelector('[data-translation=panel]'),
    draft: window.activeDraftPanel === document.querySelector('[data-draft=panel]')
  }))).toEqual({ translation: true, draft: true });
  await expect(popup.locator('[data-translation=text]')).toHaveValue('Completed during language change');
  await expect(popup.locator('[data-translation=copy]')).toBeEnabled();
  expect(mock.state.requests).toHaveLength(1);
  expect(mock.state.abortedCount).toBe(0);
  const { ocrHistory } = await readStorage(browser, 'ocrHistory');
  expect(ocrHistory[0]).toMatchObject({ text: 'Original text', name: 'Saved name',
    draft: { text: 'Uncommitted original correction' },
    translation: { text: 'Completed during language change', sourceText: 'Uncommitted original correction' } });
});

test('an imported interface language updates the page when its storage notification arrives later', async ({ extBrowser: browser }) => {
  await setStorage(browser, { uiLanguage: 'en' });
  const options = await browser.context.newPage();
  await options.addInitScript(() => {
    const add = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
    chrome.storage.onChanged.addListener = (listener) => add((changes, area) => {
      if (changes.uiLanguage) {
        (window.languageNotifications ||= []).push(() => listener(changes, area));
        return;
      }
      listener(changes, area);
    });
  });
  await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
  await expect(options.locator('#uiLanguage')).toHaveValue('en');
  await options.locator('#importFileInput').setInputFiles({ name: 'language.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ config: { uiLanguage: 'zh_CN' } })) });
  await options.locator('#modalConfirm').click();
  await expect(options.locator('#uiLanguage')).toBeEnabled();
  await expect.poll(async () => (await readStorage(browser, 'uiLanguage')).uiLanguage).toBe('zh_CN');
  await options.waitForFunction(() => window.languageNotifications?.length);
  await options.evaluate(() => window.languageNotifications.splice(0).forEach((notify) => notify()));
  await expect(options.locator('#uiLanguage')).toHaveValue('zh_CN');
  await expect(options.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(options).toHaveTitle(await options.evaluate(() => OCRI18n.t('app_title')));
});
