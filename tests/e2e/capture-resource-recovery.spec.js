'use strict';

const { test, expect } = require('./fixtures');
const { startCapture, selectAndConfirm, RESULT_TEXT } = require('./helpers');

async function setCanvasFailure(browser, page, failure) {
  await browser.serviceWorker.evaluate(async ({ url, failure }) => {
    const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (failure) => {
      // Only the isolated world of this temporary test extension is modified.
      if (!globalThis.restoreCropResources) {
        const getContext = globalThis.HTMLCanvasElement.prototype.getContext;
        const drawImage = globalThis.CanvasRenderingContext2D.prototype.drawImage;
        const toDataURL = globalThis.HTMLCanvasElement.prototype.toDataURL;
        globalThis.restoreCropResources = () => {
          globalThis.HTMLCanvasElement.prototype.getContext = getContext;
          globalThis.CanvasRenderingContext2D.prototype.drawImage = drawImage;
          globalThis.HTMLCanvasElement.prototype.toDataURL = toDataURL;
        };
      }
      globalThis.restoreCropResources();
      if (failure === 'context') globalThis.HTMLCanvasElement.prototype.getContext = () => null;
      if (failure === 'draw') globalThis.CanvasRenderingContext2D.prototype.drawImage = () => { throw new Error('Canvas allocation failed'); };
      if (failure === 'serialize') globalThis.HTMLCanvasElement.prototype.toDataURL = () => { throw new Error('Canvas serialization failed'); };
    }, args: [failure] });
  }, { url: page.url(), failure });
}

for (const failure of ['context', 'draw', 'serialize']) {
  test(`crop ${failure} failure shows recovery and allows a new successful capture`, async ({ mock, extBrowser: browser, page }) => {
    const uncaughtErrors = [];
    page.on('pageerror', (error) => uncaughtErrors.push(error.message));
    await startCapture(browser, page);
    await setCanvasFailure(browser, page, failure);
    await selectAndConfirm(page);
    await expect(page.locator('#ocr-recovery-panel')).toBeVisible();
    await expect(page.locator('#ocr-retry-original')).toBeDisabled();
    await expect(page.locator('#ocr-progress-notification')).toHaveCount(0);
    expect(mock.state.requests).toHaveLength(0);
    expect(uncaughtErrors).toEqual([]);
    await setCanvasFailure(browser, page, null);
    await page.locator('#ocr-reselect-region').click();
    await selectAndConfirm(page);
    await expect(page.locator('#ocr-result-text')).toHaveValue(RESULT_TEXT);
    await expect(page.locator('#ocr-recovery-panel')).toHaveCount(0);
    expect(mock.state.requests).toHaveLength(1);
  });
}
