'use strict';

const { test, expect } = require('./fixtures');
const { openExtensionPage, readStorage, setStorage } = require('./helpers');

async function importConfiguration(page, config) {
  await page.locator('#importFileInput').setInputFiles({
    name: 'behavior-settings.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: '1.2.0', config }))
  });
  await page.locator('#modalConfirm').click();
  await expect(page.locator('#statusMessage')).toHaveClass('status-message success');
}

test('options imports explicit copy and translation choices through the actual confirmation flow', async ({ extBrowser: browser }) => {
  await setStorage(browser, { autoCopy: true, translationProvider: 'openai', translationTargetLanguage: 'ja' });
  const options = await openExtensionPage(browser, 'options.html');
  await expect(options.locator('#autoCopy')).toBeChecked();
  await importConfiguration(options, {
    apiProvider: 'openai-compatible', autoCopy: false,
    translationProvider: 'custom', translationTargetLanguage: 'fr'
  });
  await expect(options.locator('#autoCopy')).not.toBeChecked();
  await expect.poll(() => readStorage(browser, ['autoCopy', 'translationProvider', 'translationTargetLanguage']))
    .toEqual({ autoCopy: false, translationProvider: 'custom', translationTargetLanguage: 'fr' });
});

test('importing an old configuration preserves omitted copy and translation preferences', async ({ extBrowser: browser }) => {
  await setStorage(browser, { autoCopy: true, translationProvider: 'openai', translationTargetLanguage: 'ja' });
  const options = await openExtensionPage(browser, 'options.html');
  await expect(options.locator('#autoCopy')).toBeChecked();
  await importConfiguration(options, { apiProvider: 'openai-compatible', language: 'en' });
  await expect(options.locator('#autoCopy')).toBeChecked();
  expect(await readStorage(browser, ['autoCopy', 'translationProvider', 'translationTargetLanguage']))
    .toEqual({ autoCopy: true, translationProvider: 'openai', translationTargetLanguage: 'ja' });
});
