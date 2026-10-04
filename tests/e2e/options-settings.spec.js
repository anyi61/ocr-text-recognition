'use strict';
const fs = require('node:fs/promises');
const { test, expect } = require('./fixtures');
const { openExtensionPage, readStorage, setStorage, restartBrowser } = require('./helpers');

async function readyOptions(browser) {
  const page = await openExtensionPage(browser, 'options.html');
  await expect(page.locator('#compatibleApiKey')).toHaveValue('e2e-test-key');
  return page;
}
async function chooseImport(page, config) {
  await page.locator('#importFileInput').setInputFiles({
    name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config))
  });
}
async function confirmImport(page, config) {
  await chooseImport(page, config);
  await page.locator('#modalConfirm').click();
  await expect(page.locator('#statusMessage')).toHaveText('Configuration imported successfully!');
}
async function downloadConfig(page) {
  const downloading = page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  const download = await downloading;
  return JSON.parse(await fs.readFile(await download.path(), 'utf8'));
}

test('settings pages merge only edited provider fields and export controls never rewrite stale form values', async ({ extBrowser: browser }) => {
  const first = await readyOptions(browser);
  const second = await readyOptions(browser);
  await first.locator('#compatibleApiKey').fill('new-user-key');
  await first.locator('#prompt').focus();
  await expect.poll(async () => (await readStorage(browser, 'apiConfigs')).apiConfigs.openaiCompatible.apiKey).toBe('new-user-key');
  await second.locator('#includeApiKeys').check();
  await second.locator('#prompt').fill('Changed in second settings page');
  await second.locator('#compatibleModel').fill('new-model');
  await second.locator('#exportBtn').focus();
  await expect.poll(async () => (await readStorage(browser, 'apiConfigs')).apiConfigs.openaiCompatible.model).toBe('new-model');
  const state = await readStorage(browser, ['apiConfigs', 'prompt', 'apiProvider']);
  expect(state.apiConfigs.openaiCompatible.apiKey).toBe('new-user-key');
  expect(state.prompt).toBe('Changed in second settings page');
  expect(state.apiProvider).toBe('openai-compatible');
  const exported = await downloadConfig(second);
  expect(exported.config.apiConfigs.openaiCompatible).toMatchObject({ apiKey: 'new-user-key', model: 'new-model' });
});

test('legacy backups export resolved models and only explicitly include credentials, and flat imports persist after restart', async ({ extBrowser: browser }) => {
  await browser.serviceWorker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ apiProvider: 'claude', apiKey: 'legacy-secret', model: 'claude-sonnet-5', uiLanguage: 'en' });
  });
  const options = await openExtensionPage(browser, 'options.html');
  await expect(options.locator('#claudeApiKey')).toHaveValue('legacy-secret');
  expect((await downloadConfig(options)).config.apiConfigs).toEqual({ claude: { model: 'claude-sonnet-5' } });
  await options.locator('#includeApiKeys').check();
  expect((await downloadConfig(options)).config.apiConfigs.claude.apiKey).toBe('legacy-secret');
  await confirmImport(options, { apiProvider: 'claude', apiKey: 'replacement-secret', model: 'claude-sonnet-5' });
  await expect(options.locator('#claudeApiKey')).toHaveValue('replacement-secret');
  await restartBrowser(browser);
  const reopened = await openExtensionPage(browser, 'options.html');
  await expect(reopened.locator('#claudeApiKey')).toHaveValue('replacement-secret');
  expect((await readStorage(browser, 'apiConfigs')).apiConfigs.claude.apiKey).toBe('replacement-secret');
});

test('malformed nested provider values are rejected before confirmation or any persistence', async ({ extBrowser: browser }) => {
  const options = await readyOptions(browser);
  const before = await readStorage(browser, ['apiProvider', 'apiConfigs', 'autoCopy', 'translationProvider']);
  for (const apiConfigs of [null, [], { openaiCompatible: null }, { openaiCompatible: { apiKey: {} } },
    { openaiCompatible: { model: ['bad-model'] } }, { custom: { authMode: 'invalid' } }]) {
    await chooseImport(options, { config: { apiConfigs, autoCopy: true, translationProvider: 'custom' } });
    await expect(options.locator('#statusMessage')).toHaveClass('status-message error');
    await expect(options.locator('.modal-overlay')).toHaveCount(0);
    expect(await readStorage(browser, Object.keys(before))).toEqual(before);
    expect((await readStorage(browser, 'autoCopy')).autoCopy).toBeUndefined();
  }
});

test('redacted imports retain existing credentials while explicit clearing persists through reopening', async ({ extBrowser: browser }) => {
  const options = await readyOptions(browser);
  await confirmImport(options, { config: { apiConfigs: { openaiCompatible: { model: 'imported-model' } } } });
  await expect(options.locator('#compatibleApiKey')).toHaveValue('e2e-test-key');
  await expect(options.locator('#compatibleModel')).toHaveValue('imported-model');
  await options.locator('#compatibleApiKey').fill('');
  await options.locator('#prompt').focus();
  await expect.poll(async () => (await readStorage(browser, 'compatibleApiKey')).compatibleApiKey).toBe('');
  await options.reload();
  await expect(options.locator('#compatibleApiKey')).toHaveValue('');
  expect((await readStorage(browser, 'apiConfigs')).apiConfigs.openaiCompatible.apiKey).toBe('');
});

test('cancelled imports preserve all preferences and omission does not reset independent settings', async ({ extBrowser: browser }) => {
  await setStorage(browser, { autoCopy: true, translationProvider: 'custom', translationTargetLanguage: 'ja', theme: 'dark', uiLanguage: 'en' });
  const options = await readyOptions(browser);
  await chooseImport(options, { config: { apiConfigs: { openaiCompatible: { apiKey: 'cancelled-key' } }, autoCopy: false } });
  await options.locator('#modalCancel').click();
  await expect(options.locator('.modal-overlay')).toHaveCount(0);
  expect((await readStorage(browser, 'apiConfigs')).apiConfigs.openaiCompatible.apiKey).toBe('e2e-test-key');
  await confirmImport(options, { config: { prompt: '' } });
  await expect(options.locator('#prompt')).toHaveValue('');
  expect(await readStorage(browser, ['apiProvider', 'autoCopy', 'translationProvider', 'translationTargetLanguage', 'theme', 'uiLanguage']))
    .toEqual({ apiProvider: 'openai-compatible', autoCopy: true, translationProvider: 'custom', translationTargetLanguage: 'ja', theme: 'dark', uiLanguage: 'en' });
});

test('failed atomic imports preserve provider and behavior settings and can be retried', async ({ extBrowser: browser }) => {
  const options = await readyOptions(browser);
  await browser.serviceWorker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (values) => {
      if (values.apiConfigs?.openaiCompatible?.apiKey === 'new-import-key') {
        chrome.storage.local.set = original;
        throw new Error('Injected storage failure');
      }
      return original(values);
    };
  });
  const config = { config: { apiConfigs: { openaiCompatible: { apiKey: 'new-import-key' } }, autoCopy: true, translationProvider: 'custom' } };
  await chooseImport(options, config);
  await options.locator('#modalConfirm').click();
  await expect(options.locator('#statusMessage')).toHaveClass('status-message error');
  expect((await readStorage(browser, 'apiConfigs')).apiConfigs.openaiCompatible.apiKey).toBe('e2e-test-key');
  expect(await readStorage(browser, ['autoCopy', 'translationProvider'])).toEqual({});
  await confirmImport(options, config);
  await expect(options.locator('#compatibleApiKey')).toHaveValue('new-import-key');
  expect(await readStorage(browser, ['autoCopy', 'translationProvider'])).toEqual({ autoCopy: true, translationProvider: 'custom' });
});

test('background serializes edits, full imports and translation choices from concurrent pages', async ({ extBrowser: browser }) => {
  const first = await readyOptions(browser);
  const second = await readyOptions(browser);
  await Promise.all([
    first.evaluate(() => chrome.runtime.sendMessage({ action: 'saveSettings', settings: { apiConfigs: { openaiCompatible: { apiKey: 'concurrent-key' } } } })),
    second.evaluate(() => chrome.runtime.sendMessage({ action: 'saveSettings', settings: { apiConfigs: { openaiCompatible: { model: 'concurrent-model' } }, autoCopy: true } })),
    first.evaluate(() => chrome.runtime.sendMessage({ action: 'saveTranslationPreferences', preferences: { targetLanguage: 'fr' } }))
  ]);
  const state = await readStorage(browser, ['apiConfigs', 'autoCopy', 'translationTargetLanguage']);
  expect(state.apiConfigs.openaiCompatible).toMatchObject({ apiKey: 'concurrent-key', model: 'concurrent-model' });
  expect(state.autoCopy).toBe(true);
  expect(state.translationTargetLanguage).toBe('fr');
});

test('reverting a field while its older save reply is pending persists the final edit', async ({ extBrowser: browser }) => {
  const options = await readyOptions(browser);
  await options.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const response = await original(message);
      if (message.action === 'saveSettings' && message.settings.apiConfigs?.openaiCompatible?.apiKey === 'temporary-key') {
        await new Promise((resolve) => { window.releaseSettingsReply = resolve; });
      }
      return response;
    };
  });
  await options.locator('#compatibleApiKey').fill('temporary-key');
  await options.locator('#prompt').focus();
  await expect.poll(async () => (await readStorage(browser, 'apiConfigs')).apiConfigs.openaiCompatible.apiKey).toBe('temporary-key');
  await options.locator('#compatibleApiKey').fill('e2e-test-key');
  await options.locator('#prompt').focus();
  await options.evaluate(() => window.releaseSettingsReply());
  await expect.poll(async () => (await readStorage(browser, 'apiConfigs')).apiConfigs.openaiCompatible.apiKey).toBe('e2e-test-key');
  await options.reload();
  await expect(options.locator('#compatibleApiKey')).toHaveValue('e2e-test-key');
});

for (const firstCompleted of ['connection test', 'import']) {
  test(`connection tests and imports release their controls when the ${firstCompleted} completes first`, async ({ extBrowser: browser }) => {
    const options = await readyOptions(browser);
    await options.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (message) => {
        if (message.action === 'saveSettings' && message.settings.prompt === 'concurrent import') {
          await new Promise((resolve) => { window.releaseImport = resolve; });
        }
        const response = await send(message);
        if (message.action === 'testAPI') {
          await new Promise((resolve) => { window.releaseConnectionTest = resolve; });
          window.connectionReplyDelivered = true;
        }
        return response;
      };
    });
    await options.locator('#testBtn').click();
    await options.waitForFunction(() => Boolean(window.releaseConnectionTest));
    await chooseImport(options, { config: { prompt: 'concurrent import' } });
    await options.locator('#modalConfirm').click();
    await options.waitForFunction(() => Boolean(window.releaseImport));
    await expect(options.locator('#testBtn')).toBeDisabled();
    if (firstCompleted === 'connection test') {
      await options.evaluate(() => window.releaseConnectionTest());
      await options.waitForFunction(() => window.connectionReplyDelivered);
      await expect(options.locator('#testBtn')).toBeDisabled();
      await expect(options.locator('#importBtn')).toBeDisabled();
      await options.evaluate(() => window.releaseImport());
      await expect(options.locator('#statusMessage')).toHaveText('Configuration imported successfully!');
    } else {
      await options.evaluate(() => window.releaseImport());
      await expect(options.locator('#statusMessage')).toHaveText('Configuration imported successfully!');
      await expect(options.locator('#testBtn')).toBeDisabled();
      await expect(options.locator('#importBtn')).toBeEnabled();
      await options.evaluate(() => window.releaseConnectionTest());
    }
    await expect(options.locator('#testBtn')).toBeEnabled();
    await expect(options.locator('#importBtn')).toBeEnabled();
    expect((await readStorage(browser, 'prompt')).prompt).toBe('concurrent import');
  });
}

test('partial imports retain failed edits with a warning and allow retry or an explicit replacement', async ({ extBrowser: browser }) => {
  const options = await readyOptions(browser);
  await options.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.rejectKeySave = true;
    chrome.runtime.sendMessage = async (message) => {
      if (window.rejectKeySave && message.action === 'saveSettings'
        && message.settings.apiConfigs?.openaiCompatible?.apiKey === 'unsaved-key') {
        return { success: false, errorCode: 'SETTINGS_SAVE_FAILED' };
      }
      return send(message);
    };
  });
  await options.locator('#compatibleApiKey').fill('unsaved-key');
  await options.locator('#prompt').focus();
  await expect(options.locator('#statusMessage')).toContainText('Could not save settings');
  await chooseImport(options, { config: { prompt: 'imported unrelated field' } });
  await options.locator('#modalConfirm').click();
  await expect(options.locator('#importBtn')).toBeEnabled();
  await expect(options.locator('#statusMessage')).toHaveClass('status-message warning');
  await expect(options.locator('#statusMessage')).toContainText('Your edits are still here');
  await expect(options.locator('#compatibleApiKey')).toHaveValue('unsaved-key');
  await expect(options.locator('#compatibleApiKey').locator('..').locator('.field-status')).toHaveClass(/error/);
  expect((await readStorage(browser, 'apiConfigs')).apiConfigs.openaiCompatible.apiKey).toBe('e2e-test-key');
  expect((await readStorage(browser, 'prompt')).prompt).toBe('imported unrelated field');

  await options.evaluate(() => { window.rejectKeySave = false; });
  await options.locator('#compatibleApiKey').focus();
  await options.locator('#prompt').focus();
  await expect.poll(async () => (await readStorage(browser, 'apiConfigs')).apiConfigs.openaiCompatible.apiKey).toBe('unsaved-key');
  await options.reload();
  await expect(options.locator('#compatibleApiKey')).toHaveValue('unsaved-key');

  // An import that explicitly contains this field remains an intentional replacement.
  await options.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message) => message.action === 'saveSettings'
      && message.settings.apiConfigs?.openaiCompatible?.apiKey === 'another-unsaved-key'
      ? Promise.resolve({ success: false, errorCode: 'SETTINGS_SAVE_FAILED' }) : send(message);
  });
  await options.locator('#compatibleApiKey').fill('another-unsaved-key');
  await options.locator('#prompt').focus();
  await expect(options.locator('#statusMessage')).toContainText('Could not save settings');
  await confirmImport(options, { config: { apiConfigs: { openaiCompatible: { apiKey: 'explicit-import-key' } } } });
  await expect(options.locator('#compatibleApiKey')).toHaveValue('explicit-import-key');
  await expect(options.locator('#compatibleApiKey').locator('..').locator('.field-status')).not.toHaveClass(/error/);
  expect((await readStorage(browser, 'apiConfigs')).apiConfigs.openaiCompatible.apiKey).toBe('explicit-import-key');
});
