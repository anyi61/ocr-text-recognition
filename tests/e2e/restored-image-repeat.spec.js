'use strict';

const { test, expect } = require('./fixtures');
const { startCapture, selectAndConfirm, readHistory, openPopupForTab, readPngDimensions, readPngPixel, RESULT_TEXT } = require('./helpers');

async function imageFile(page, { type = 'image/png', width = 300, height = 160, color = '#13aa40' } = {}) {
  const encoded = await page.evaluate(({ type, width, height, color }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = color; context.fillRect(0, 0, width, height);
    context.fillStyle = '#000'; context.font = '20px sans-serif'; context.fillText('LOCAL IMAGE SAMPLE', 15, 60);
    return canvas.toDataURL(type).split(',')[1];
  }, { type, width, height, color });
  return { name: `private-financial-file.${type.split('/')[1]}`, mimeType: type, buffer: Buffer.from(encoded, 'base64') };
}

async function upload(workspace, options) {
  await workspace.locator('#imageFile').setInputFiles(await imageFile(workspace, options));
  await expect(workspace.locator('#recognizeImage')).toBeEnabled();
}

async function dropFiles(workspace, files) {
  const transfer = await workspace.evaluateHandle((files) => {
    const transfer = new window.DataTransfer();
    for (const file of files) {
      const bytes = Uint8Array.from(window.atob(file.base64), (character) => character.charCodeAt(0));
      transfer.items.add(new window.File([bytes], file.name, { type: file.mimeType }));
    }
    return transfer;
  }, files.map((file) => ({ name: file.name, mimeType: file.mimeType, base64: file.buffer.toString('base64') })));
  try { await workspace.locator('#imageDropZone').dispatchEvent('drop', { dataTransfer: transfer }); }
  finally { await transfer.dispose(); }
}

async function recognize(browser, page) {
  await startCapture(browser, page);
  await page.bringToFront();
  await selectAndConfirm(page);
  await expect(page.locator('#ocr-result-text')).toHaveValue(RESULT_TEXT);
}

for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
  test(`restored: uploading ${type} recognizes normalized PNG and persists no image or filename`, async ({ extBrowser: browser, workspace, mock }) => {
    await upload(workspace, { type });
    expect(mock.state.requests).toHaveLength(0);
    await expect(workspace.locator('#imagePreview')).toBeVisible();
    await workspace.locator('#recognizeImage').click();
    await expect(workspace.locator('#imageResultText')).toHaveValue(RESULT_TEXT);
    const request = JSON.stringify(mock.state.requests[0].body);
    expect(request).toContain('data:image/png;base64,');
    const history = await readHistory(browser.serviceWorker);
    expect(history).toHaveLength(1);
    expect(history[0].sourceUrl).toBe('');
    expect(JSON.stringify(history)).not.toContain('private-financial-file');
    expect(JSON.stringify(history)).not.toContain('data:image');
  });
}

test('restored: dropping a large image downsizes before recognition', async ({ workspace, mock }) => {
  await dropFiles(workspace, [await imageFile(workspace, { width: 5000, height: 2600 })]);
  await expect(workspace.locator('#recognizeImage')).toBeEnabled();
  expect(mock.state.requests).toHaveLength(0);
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageResultText')).toHaveValue(RESULT_TEXT);
  const image = mock.state.requests[0].body.messages[0].content.find((item) => item.type === 'image_url').image_url.url;
  const dimensions = readPngDimensions(image);
  expect(dimensions.width).toBeLessThanOrEqual(4096);
  expect(dimensions.width * dimensions.height).toBeLessThanOrEqual(12_000_000);
});

test('restored: real clipboard image paste stays local until an explicit Recognize click', async ({ extBrowser: browser, workspace, mock }) => {
  await browser.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const file = await imageFile(workspace);
  await workspace.evaluate(async (base64) => {
    const bytes = Uint8Array.from(window.atob(base64), (character) => character.charCodeAt(0));
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  }, file.buffer.toString('base64'));
  await workspace.locator('#imageDropZone').focus();
  await workspace.keyboard.press('Control+V');
  await expect(workspace.locator('#imagePreview')).toBeVisible();
  await expect(workspace.locator('#recognizeImage')).toBeEnabled();
  expect(mock.state.requests).toHaveLength(0);
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageResultText')).toHaveValue(RESULT_TEXT);
});

test('restored: unsupported, corrupt and multiple images are rejected before any upload', async ({ workspace, mock }) => {
  for (const file of [
    { name: 'document.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') },
    { name: 'corrupt.png', mimeType: 'image/png', buffer: Buffer.from('invalid png') }
  ]) {
    await workspace.locator('#imageFile').setInputFiles(file);
    await expect(workspace.locator('#recognizeImage')).toBeDisabled();
    await expect(workspace.locator('#imageImportStatus')).not.toHaveText('');
    await expect(workspace.locator('#imagePreviewWrap')).toBeHidden();
  }
  const image = await imageFile(workspace);
  await dropFiles(workspace, [image, { ...image, name: 'second.png' }]);
  await expect(workspace.locator('#imageImportStatus')).toContainText(/one image|单张|一张/);
  await expect(workspace.locator('#recognizeImage')).toBeDisabled();
  expect(mock.state.requests).toHaveLength(0);
});

test('restored: image cancellation aborts the provider and retries the same retained preview', async ({ extBrowser: browser, workspace, mock }) => {
  await upload(workspace);
  const preview = await workspace.locator('#imagePreview').getAttribute('src');
  mock.state.queue.push({ delay: 10_000 });
  await workspace.locator('#recognizeImage').click();
  await mock.waitForRequestCount(1);
  await workspace.locator('#cancelImageOCR').click();
  await mock.waitForAbortCount(1);
  expect(await readHistory(browser.serviceWorker)).toHaveLength(0);
  await expect(workspace.locator('#imagePreview')).toHaveAttribute('src', preview);
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageResultText')).toHaveValue(RESULT_TEXT);
  expect((await readHistory(browser.serviceWorker))).toHaveLength(1);
  expect(mock.state.requests[1].body).toEqual(mock.state.requests[0].body);
});

test('restored: replacing an image cancels its request and ignores the old result', async ({ extBrowser: browser, workspace, mock }) => {
  await upload(workspace, { color: '#f02030' });
  mock.state.queue.push({ delay: 10_000, text: 'OLD IMAGE MUST NOT SURVIVE' });
  await workspace.locator('#recognizeImage').click();
  await mock.waitForRequestCount(1);
  await upload(workspace, { color: '#2050ff' });
  await mock.waitForAbortCount(1);
  await expect(workspace.locator('#imageResultSection')).toBeHidden();
  mock.state.queue.push({ text: 'Replacement image result' });
  await workspace.locator('#recognizeImage').click();
  await expect(workspace.locator('#imageResultText')).toHaveValue('Replacement image result');
  const history = await readHistory(browser.serviceWorker);
  expect(history).toHaveLength(1);
  expect(history[0].text).toBe('Replacement image result');
});

test('restored: closing an image workspace aborts only its own request', async ({ extBrowser: browser, page, workspace, mock }) => {
  await recognize(browser, page);
  await upload(workspace);
  mock.state.queue.push({ delay: 10_000 });
  await workspace.locator('#recognizeImage').click();
  await mock.waitForRequestCount(2);
  await workspace.close();
  await mock.waitForAbortCount(1);
  await expect(page.locator('#ocr-result-text')).toHaveValue(RESULT_TEXT);
  expect(await readHistory(browser.serviceWorker)).toHaveLength(1);
});

for (const fail of [false, true]) {
  test(`restored: image editor keeps newer input when a delayed save ${fail ? 'fails' : 'succeeds'}`, async ({ extBrowser: browser, workspace }) => {
    await upload(workspace);
    await workspace.locator('#recognizeImage').click();
    await expect(workspace.locator('#imageResultText')).toHaveValue(RESULT_TEXT);
    await workspace.locator('#imageResultText').fill('Submitted image correction A');
    await expect(workspace.locator('[data-draft=panel]')).toHaveAttribute('data-state', 'saved');
    await browser.serviceWorker.evaluate((fail) => {
      const original = chrome.storage.local.set.bind(chrome.storage.local);
      globalThis.__imageSaveWaiting = false;
      Object.defineProperty(chrome.storage.local, 'set', { configurable: true, value: async (values) => {
        if (!globalThis.__imageSaveWaiting && values.ocrHistory?.some((record) => record.text === 'Submitted image correction A')) {
          globalThis.__imageSaveWaiting = true;
          await new Promise((resolve) => { globalThis.__releaseImageSave = resolve; });
          if (fail) throw new Error('E2E delayed image save failure');
        }
        return original(values);
      } });
    }, fail);
    await workspace.locator('#saveImageResult').click();
    await expect.poll(() => browser.serviceWorker.evaluate(() => globalThis.__imageSaveWaiting)).toBe(true);
    await expect(workspace.locator('#imageResultText')).toBeEditable();
    await workspace.locator('#imageResultText').fill('Newer image edit B during save');
    await browser.serviceWorker.evaluate(() => globalThis.__releaseImageSave());
    await expect(workspace.locator('#saveImageResult')).toBeEnabled();
    await expect(workspace.locator('#imageResultText')).toHaveValue('Newer image edit B during save');
    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.draft?.text).toBe('Newer image edit B during save');
    const record = (await readHistory(browser.serviceWorker))[0];
    expect(record.text).toBe(fail ? RESULT_TEXT : 'Submitted image correction A');
    expect(record.draft.baseText).toBe(record.text);
    if (fail) await expect(workspace.locator('#imageResultStatus')).toContainText(/could not|fail|无法|失败/i);
    await workspace.locator('#saveImageResult').click();
    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.text).toBe('Newer image edit B during save');
  });
}

test('restored: repeating a selection reads fresh pixels at the same coordinates and saves a separate result', async ({ extBrowser: browser, page, mock }) => {
  await recognize(browser, page);
  const firstImage = mock.state.requests[0].body.messages[0].content.find((item) => item.type === 'image_url').image_url.url;
  await page.evaluate(() => { document.body.style.background = 'rgb(20, 120, 240)'; });
  await page.locator('.repeat-capture-btn').click();
  await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(2);
  const nextImage = mock.state.requests[1].body.messages[0].content.find((item) => item.type === 'image_url').image_url.url;
  expect(readPngDimensions(nextImage)).toMatchObject({ width: readPngDimensions(firstImage).width, height: readPngDimensions(firstImage).height });
  expect(nextImage).not.toBe(firstImage);
  expect(await readPngPixel(page, nextImage, 20, 20)).toEqual([20, 120, 240, 255]);
  await expect(page.locator('#ocr-result-text')).toHaveValue(RESULT_TEXT);
});

for (const change of ['scroll', 'resize', 'navigation']) {
  test(`restored: ${change} invalidates a repeat region instead of capturing stale coordinates`, async ({ extBrowser: browser, page, mock }) => {
    await recognize(browser, page);
    await page.locator('.ocr-close-btn').click();
    await expect(page.locator('#ocr-result-popup')).toHaveCount(0);
    if (change === 'scroll') await page.evaluate(() => { document.body.style.height = '3000px'; window.scrollTo(0, 200); });
    if (change === 'resize') await page.setViewportSize({ width: 1100, height: 760 });
    if (change === 'navigation') await page.goto(`${mock.origin}/another-page`);
    const popup = await openPopupForTab(browser, page);
    await expect(popup.locator('#repeatCaptureBtn')).toBeDisabled();
    await expect(popup.locator('#repeatCaptureHint')).not.toHaveText('');
    expect(mock.state.requests).toHaveLength(1);
  });
}

test('restored: cancelling repeated OCR keeps the first result and its history', async ({ extBrowser: browser, page, mock }) => {
  await recognize(browser, page);
  mock.state.queue.push({ delay: 10_000 });
  await page.locator('.repeat-capture-btn').click();
  await mock.waitForRequestCount(2);
  await page.locator('.ocr-progress-cancel').click();
  await mock.waitForAbortCount(1);
  const history = await readHistory(browser.serviceWorker);
  expect(history).toHaveLength(1);
  expect(history[0].text).toBe(RESULT_TEXT);
});
