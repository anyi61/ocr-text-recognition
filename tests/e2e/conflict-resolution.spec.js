'use strict';

const { test, expect } = require('./fixtures');
const { startCapture, selectAndConfirm, uploadImage, readHistory, setStorage, openExtensionPage, RESULT_TEXT } = require('./helpers');

async function editorFor(surface, browser, page, workspace) {
  let editor, source, save;
  if (surface === 'capture') {
    await startCapture(browser, page);
    await selectAndConfirm(page);
    editor = page; source = page.locator('#ocr-result-text'); save = page.locator('.save-changes-btn');
  } else {
    await uploadImage(workspace);
    await workspace.locator('#recognizeImage').click();
    editor = workspace; source = workspace.locator('#imageResultText'); save = workspace.locator('#saveImageResult');
  }
  await expect(source).toHaveValue(RESULT_TEXT);
  await expect(editor.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'idle');
  return { editor, source, save };
}

async function savedElsewhere(browser, text) {
  const history = await readHistory(browser.serviceWorker);
  const original = { ...history[0], text, favorite: true, name: 'Keep original name' };
  await setStorage(browser, { ocrHistory: [original, ...history.slice(1)] });
  return original;
}

for (const surface of ['capture', 'workspace']) {
  test(`${surface} comparison keeps edits, closes safely, and retries with a reviewed CAS baseline`, async ({ extBrowser: browser, page, workspace }) => {
    const { editor, source, save } = await editorFor(surface, browser, page, workspace);
    const original = await savedElsewhere(browser, 'Latest saved correction');
    await source.fill('My local correction');
    await save.click();
    await expect(editor.locator('[data-conflict=latest]')).toHaveValue('Latest saved correction');
    await expect(editor.locator('[data-conflict=latest]')).not.toBeEditable();
    await source.fill('Continued typing during comparison');
    await editor.locator('[data-conflict=close]').click();
    await expect(editor.locator('[data-conflict=panel]')).toBeHidden();
    await expect(source).toHaveValue('Continued typing during comparison');
    await editor.locator('[data-draft=compare]').click();
    await expect(editor.locator('[data-conflict=rebase]')).toBeEnabled();
    await editor.locator('[data-conflict=rebase]').click();
    await expect(source).toHaveValue('Continued typing during comparison');
    expect((await readHistory(browser.serviceWorker))[0].text).toBe('Latest saved correction');
    // A reviewed baseline is still conditional: another change must conflict again.
    await savedElsewhere(browser, 'A still newer correction');
    await save.click();
    await expect(editor.locator('[data-conflict=latest]')).toHaveValue('A still newer correction');
    await editor.locator('[data-conflict=rebase]').click();
    await save.click();
    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0].text).toBe('Continued typing during comparison');
    const record = (await readHistory(browser.serviceWorker))[0];
    expect(record.id).toBe(original.id);
    expect(record.favorite).toBe(true);
    expect(record.name).toBe('Keep original name');
  });

  test(`${surface} deleted original can be saved separately and subsequent edits belong to the new record`, async ({ extBrowser: browser, page, workspace, mock }) => {
    const { editor, source, save } = await editorFor(surface, browser, page, workspace);
    const originalId = (await readHistory(browser.serviceWorker))[0].id;
    await setStorage(browser, { ocrHistory: [], translationProvider: 'openai-compatible', translationTargetLanguage: 'ja' });
    await source.fill('Keep text after deletion');
    await save.click();
    await expect(editor.locator('[data-conflict=panel]')).toHaveAttribute('data-state', 'missing');
    await expect(editor.locator('[data-conflict=rebase]')).toBeDisabled();
    await editor.locator('[data-conflict=save-new]').click();
    await expect(editor.locator('[data-conflict=panel]')).toBeHidden();
    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.text).toBe('Keep text after deletion');
    let record = (await readHistory(browser.serviceWorker))[0];
    expect(record.id).not.toBe(originalId);
    const newId = record.id;
    await source.fill('Further edit of the separate record');
    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.draft?.text).toBe('Further edit of the separate record');
    await save.click();
    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.text).toBe('Further edit of the separate record');
    record = (await readHistory(browser.serviceWorker))[0];
    expect(record.id).toBe(newId);
    expect(record.draft).toBeUndefined();
    const preferences = await browser.serviceWorker.evaluate(() => chrome.storage.local.get(['translationProvider', 'translationTargetLanguage']));
    expect(preferences).toEqual({ translationProvider: 'openai-compatible', translationTargetLanguage: 'ja' });
    mock.state.queue.push({ text: 'Translation associated with the new record' });
    await editor.locator('[data-translation=start]').click();
    await expect(editor.locator('[data-translation=text]')).toHaveValue('Translation associated with the new record');
    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.translation?.sourceText).toBe('Further edit of the separate record');
    expect((await readHistory(browser.serviceWorker))[0].id).toBe(newId);
  });

  test(`${surface} save-as-new holds edits until its new ID exists and keeps subsequent drafts separate from the source`, async ({ extBrowser: browser, page, workspace }) => {
    const { editor, source, save } = await editorFor(surface, browser, page, workspace);
    const original = await savedElsewhere(browser, 'Saved elsewhere');
    original.draft = { text: 'Other window unfinished work', baseText: 'Saved elsewhere', updatedAt: 123 };
    original.draftMeta = { ownerId: 'other-window', updatedAt: 123 };
    original.translation = { text: 'Original translation', sourceText: 'Saved elsewhere', provider: 'openai-compatible', targetLanguage: 'en', timestamp: 1 };
    await setStorage(browser, { ocrHistory: [original] });
    await source.fill('Snapshot to save separately');
    await save.click();
    await expect(editor.locator('[data-conflict=latest]')).toHaveValue('Saved elsewhere');
    await browser.serviceWorker.evaluate(() => {
      const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
      Object.defineProperty(chrome.storage.local, 'set', { configurable: true, value: async (values) => {
        if (!globalThis.__newRecordDelayed && values.ocrHistory?.some((record) => record.text === 'Snapshot to save separately')) {
          globalThis.__newRecordDelayed = true;
          await new Promise((resolve) => { globalThis.__releaseNewRecord = resolve; });
        }
        return originalSet(values);
      } });
    });
    await editor.locator('[data-conflict=save-new]').click();
    await expect.poll(() => browser.serviceWorker.evaluate(() => Boolean(globalThis.__releaseNewRecord))).toBe(true);
    await expect(save).toBeDisabled();
    await expect(source).not.toBeEditable();
    if (surface === 'capture') {
      await expect(editor.locator('.merge-lines-btn')).toBeDisabled();
      await expect(editor.locator('.undo-text-btn')).toBeDisabled();
    }
    await browser.serviceWorker.evaluate(() => globalThis.__releaseNewRecord());
    await expect(editor.locator('[data-conflict=panel]')).toBeHidden();
    await expect(source).toBeEditable();
    await expect(source).toHaveValue('Snapshot to save separately');
    await source.fill('Newer draft for the separate record');
    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.draft?.text).toBe('Newer draft for the separate record');
    const records = await readHistory(browser.serviceWorker);
    expect(records).toHaveLength(2);
    expect(records[0].text).toBe('Snapshot to save separately');
    expect(records[0].draft.baseText).toBe('Snapshot to save separately');
    expect(records[0].translation).toBeUndefined();
    expect(records[1]).toEqual(original);
    const popup = await openExtensionPage(browser, 'popup.html');
    await popup.locator(`.history-item[data-history-id="${records[0].id}"]`).click();
    await popup.locator('[data-draft=restore]').click();
    await expect(popup.locator('#historyPreviewText')).toHaveValue('Newer draft for the separate record');
  });

  test(`${surface} closing during save-as-new preserves the submitted snapshot without changing the original`, async ({ extBrowser: browser, page, workspace }) => {
    const { editor, source, save } = await editorFor(surface, browser, page, workspace);
    const original = await savedElsewhere(browser, 'Original must remain');
    await source.fill('Saved even after the editor closes');
    await save.click();
    await expect(editor.locator('[data-conflict=latest]')).toHaveValue('Original must remain');
    await browser.serviceWorker.evaluate(() => {
      const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
      Object.defineProperty(chrome.storage.local, 'set', { configurable: true, value: async (values) => {
        if (!globalThis.__closingCopyDelayed && values.ocrHistory?.some((record) => record.text === 'Saved even after the editor closes')) {
          globalThis.__closingCopyDelayed = true;
          await new Promise((resolve) => { globalThis.__releaseClosingCopy = resolve; });
        }
        return originalSet(values);
      } });
    });
    await editor.locator('[data-conflict=save-new]').click();
    await expect.poll(() => browser.serviceWorker.evaluate(() => Boolean(globalThis.__releaseClosingCopy))).toBe(true);
    await expect(source).not.toBeEditable();
    if (surface === 'capture') {
      page.once('dialog', (dialog) => dialog.accept());
      await page.locator('.ocr-close-btn').click();
      await expect(page.locator('#ocr-result-popup')).toHaveCount(0);
    } else await workspace.close();
    await browser.serviceWorker.evaluate(() => globalThis.__releaseClosingCopy());
    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.text).toBe('Saved even after the editor closes');
    const records = await readHistory(browser.serviceWorker);
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual(original);
    if (surface === 'capture') await expect(page.locator('#ocr-result-popup')).toHaveCount(0);
  });
}

test('comparison read and save failures preserve edits, mark stale comparison, and offer local retry', async ({ extBrowser: browser, page, workspace }) => {
  const { editor, source, save } = await editorFor('workspace', browser, page, workspace);
  await savedElsewhere(browser, 'Saved version to compare');
  await source.fill('Local changes through failures');
  await save.click();
  await expect(editor.locator('[data-conflict=latest]')).toHaveValue('Saved version to compare');
  await workspace.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    let failRead = true;
    let failSave = true;
    chrome.runtime.sendMessage = (message, ...rest) => {
      if (message.action === 'getHistoryRecord' && failRead) {
        failRead = false;
        return Promise.resolve({ success: false, errorCode: 'HISTORY_READ_FAILED' });
      }
      if (message.action === 'saveHistoryAsNew' && failSave) {
        failSave = false;
        return Promise.resolve({ success: false, errorCode: 'HISTORY_WRITE_FAILED' });
      }
      return send(message, ...rest);
    };
  });
  await editor.locator('[data-conflict=refresh]').click();
  await expect(editor.locator('[data-conflict=panel]')).toHaveAttribute('data-state', 'read-error');
  await expect(editor.locator('[data-conflict=latest]')).toHaveValue('Saved version to compare');
  await expect(editor.locator('[data-conflict=rebase]')).toBeDisabled();
  await expect(source).toHaveValue('Local changes through failures');
  await editor.locator('[data-conflict=refresh]').click();
  await expect(editor.locator('[data-conflict=rebase]')).toBeEnabled();
  await editor.locator('[data-conflict=save-new]').click();
  await expect(editor.locator('[data-conflict=panel]')).toHaveAttribute('data-state', 'save-error');
  await expect(source).toHaveValue('Local changes through failures');
  expect(await readHistory(browser.serviceWorker)).toHaveLength(1);
  await editor.locator('[data-conflict=save-new]').click();
  await expect(editor.locator('[data-conflict=panel]')).toBeHidden();
  expect(await readHistory(browser.serviceWorker)).toHaveLength(2);
});
