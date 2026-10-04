'use strict';

const { test: base, expect } = require('@playwright/test');
const { startMockServer, launchExtension, configureExtension, disposeBrowser, openExtensionPage } = require('./helpers');

const test = base.extend({
  mock: async ({}, use) => {
    const mock = await startMockServer();
    try { await use(mock); } finally { await mock.close(); }
  },
  extBrowser: [async ({ mock }, use, testInfo) => {
    const browser = await launchExtension(mock.origin);
    let tracing = false;
    try {
      if (process.env.CI === 'true' || process.env.OCR_E2E_TRACE === '1') {
        await browser.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        tracing = true;
      }
      await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
      await use(browser);
    } finally {
      try {
        const failed = testInfo.status !== testInfo.expectedStatus;
        if (failed) {
          await Promise.all(browser.context.pages().map(async (page, index) => {
            if (page.isClosed()) return;
            // Evidence collection must never replace the original failure or
            // prevent browser/profile cleanup when a page is already closing.
            try {
              const screenshot = testInfo.outputPath(`failure-page-${index + 1}.png`);
              await page.screenshot({ path: screenshot, fullPage: true, timeout: 5000 });
              await testInfo.attach(`failure-page-${index + 1}`, { path: screenshot, contentType: 'image/png' });
            } catch { /* Best effort: the trace/report still records the failure. */ }
          }));
        }
        if (tracing) {
          try {
            const trace = failed ? testInfo.outputPath('trace.zip') : undefined;
            await browser.context.tracing.stop(trace ? { path: trace } : {});
            if (trace) await testInfo.attach('trace', { path: trace, contentType: 'application/zip' });
          } catch { /* A crashed browser may not be able to flush its trace. */ }
        }
      } finally { await disposeBrowser(browser); }
    }
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
