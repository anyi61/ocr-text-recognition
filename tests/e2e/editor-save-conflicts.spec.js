'use strict';

const { test, expect } = require('./fixtures');
const { startCapture, selectAndConfirm, uploadImage, openExtensionPage, readHistory, RESULT_TEXT } = require('./helpers');

for (const surface of ['capture', 'workspace']) {
  test(`${surface} formal save preserves a newer correction from history and keeps the local edit`, async ({ extBrowser: browser, page, workspace }) => {
    let editor, source, save, feedback;
    if (surface === 'capture') {
      await startCapture(browser, page);
      await selectAndConfirm(page);
      editor = page;
      source = page.locator('#ocr-result-text');
      save = page.locator('.save-changes-btn');
      feedback = page.locator('#ocr-notification .ocr-notify-msg');
    } else {
      await uploadImage(workspace);
      await workspace.locator('#recognizeImage').click();
      editor = workspace;
      source = workspace.locator('#imageResultText');
      save = workspace.locator('#saveImageResult');
      feedback = workspace.locator('#imageResultStatus');
    }
    await expect(source).toHaveValue(RESULT_TEXT);
    await expect(editor.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'idle');
    const popup = await openExtensionPage(browser, 'popup.html');
    await popup.locator('.history-item-text').first().click();
    await popup.locator('#historyPreviewText').fill('Correction saved in history');
    await popup.locator('#previewSaveBtn').click();
    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.text).toBe('Correction saved in history');
    await editor.bringToFront();
    await source.fill('Local edit based on the old result');
    await save.click();
    await expect(feedback).toContainText(/another|changed|window/i);
    await expect(source).toHaveValue('Local edit based on the old result');
    await expect(save).toBeEnabled();
    expect((await readHistory(browser.serviceWorker))[0].text).toBe('Correction saved in history');
  });
}
