'use strict';

const { test: base, expect } = require('@playwright/test');
const { startMockServer, launchExtension, configureExtension, disposeBrowser, openExtensionPage } = require('./helpers');

const test = base.extend({
  mock: async ({}, use) => {
    const mock = await startMockServer();
    try { await use(mock); } finally { await mock.close(); }
  },
  extBrowser: [async ({ mock }, use) => {
    const browser = await launchExtension(mock.origin);
    try {
      await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
      await use(browser);
    } finally { await disposeBrowser(browser); }
  }, { scope: 'test' }],
  page: async ({ extBrowser: browser, mock }, use) => {
    const page = await browser.context.newPage();
    await page.goto(mock.origin);
    await use(page);
  },
  workspace: async ({ extBrowser: browser }, use) => {
    await use(await openExtensionPage(browser));
  }
});

module.exports = { test, expect };
