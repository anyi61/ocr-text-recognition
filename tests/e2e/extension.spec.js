'use strict';

const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMockServer } = require('./mock-server');
const { installSessionProbe } = require('./session-probe');

const EXTENSION_PATH = path.resolve(__dirname, '../..');
const RESULT_TEXT = 'MOCK OCR RESULT 12345';

async function createE2EExtensionCopy(mockOrigin, instrument = false) {
  const { PRODUCTION_FILES } = await import('../../scripts/package-extension.mjs');
  const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-extension-src-'));
  for (const relativePath of PRODUCTION_FILES) {
    fs.cpSync(path.join(EXTENSION_PATH, relativePath), path.join(extensionDir, relativePath), {
      recursive: true
    });
  }
  expect(fs.readdirSync(extensionDir).sort()).toEqual([...PRODUCTION_FILES].sort());
  if (instrument) {
    const contentPath = path.join(extensionDir, 'content.js');
    let source = fs.readFileSync(contentPath, 'utf8');
    if (process.env.OCR_SESSION_MUTATION === 'unguarded') {
      const sessionPath = path.join(extensionDir, 'content/session.js');
      let sessionSource = fs.readFileSync(sessionPath, 'utf8');
      const guard = 'return sessionId !== null && captureSessionId === sessionId;';
      if (!sessionSource.includes(guard)) throw new Error('Session guard mutation target missing');
      sessionSource = sessionSource.replace(guard, 'return true;');
      fs.writeFileSync(sessionPath, sessionSource);
    }
    fs.writeFileSync(contentPath, `(${installSessionProbe.toString()})();\n${source}`);
  }
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // Playwright cannot synthesize a Chrome toolbar invocation, so its temporary
  // copy uses <all_urls> only to satisfy captureVisibleTab. The test still
  // exercises the production Popup permission check and missing-listener
  // injection fallback; the checked-in manifest remains narrowly scoped.
  manifest.host_permissions = [
    ...new Set([...(manifest.host_permissions || []), `${mockOrigin}/*`, '<all_urls>'])
  ];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return extensionDir;
}

async function launchExtension(mockOrigin, contextOptions = {}, instrument = false) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-extension-e2e-'));
  const extensionDir = await createE2EExtensionCopy(mockOrigin, instrument);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1000, height: 700 },
    ...contextOptions,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`
    ]
  });

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker');
  await serviceWorker.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
  const extensionId = serviceWorker.url().split('/')[2];
  return { context, extensionDir, extensionId, serviceWorker, userDataDir };
}

async function configureExtension(browser, endpoint, model = 'mock-vision-model') {
  const { serviceWorker } = browser;
  await serviceWorker.evaluate(async ({ endpoint, model }) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      apiProvider: 'openai-compatible',
      apiConfigs: {
        openaiCompatible: {
          endpoint,
          apiKey: 'e2e-test-key',
          model
        }
      },
      language: 'en',
      prompt: 'Recognize the text.',
      ocrHistory: [],
      uploadNoticeAcknowledgedVersion: 1
    });
  }, { endpoint, model });
}

async function openPopupForTab(browser, page, options = {}) {
  await page.bringToFront();
  const targetTab = await browser.serviceWorker.evaluate(async ({ pageUrl }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === pageUrl);
    return tab ? { id: tab.id, url: tab.url, title: tab.title } : null;
  }, { pageUrl: page.url() });
  if (!targetTab) throw new Error(`Could not find test tab: ${page.url()}`);

  const popup = await browser.context.newPage();
  await popup.addInitScript(({ targetTab }) => {
    Object.defineProperty(chrome.tabs, 'query', {
      configurable: true,
      value: async () => [targetTab]
    });
  }, { targetTab });
  if (options.denyEndpointPermission) {
    await popup.addInitScript(() => {
      Object.defineProperty(chrome.permissions, 'request', {
        configurable: true,
        value: async () => false
      });
    });
  }
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await popup.waitForLoadState('domcontentloaded');
  return popup;
}

async function startCapture(browser, page) {
  const popup = await openPopupForTab(browser, page);
  await popup.locator('#captureBtn').click();
  await expect(page.locator('#ocr-root-host')).toHaveCount(1);
  await popup.close();
  // Closing a popup test tab can activate another page in multi-tab scenarios.
  await page.bringToFront();
}

let lastConfirmationAt = 0;
async function selectAndConfirm(page) {
  await page.mouse.move(90, 90);
  await page.mouse.down();
  await page.mouse.move(560, 330, { steps: 5 });
  await page.mouse.up();
  // Pace real screenshots below captureVisibleTab's rate limit. Session
  // assertions use explicit request/probe checkpoints, not this delay.
  const waitMs = Math.max(0, 600 - (Date.now() - lastConfirmationAt));
  if (waitMs) await page.waitForTimeout(waitMs);
  lastConfirmationAt = Date.now();
  await page.keyboard.press('Enter');
}

async function readHistory(serviceWorker) {
  return serviceWorker.evaluate(async () => {
    const { ocrHistory = [] } = await chrome.storage.local.get('ocrHistory');
    return ocrHistory;
  });
}

function readPngDimensions(dataUrl) {
  const encoded = dataUrl.split(',')[1];
  const png = Buffer.from(encoded, 'base64');
  return {
    encodedLength: encoded.length,
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20)
  };
}

async function readPngPixel(page, dataUrl, x, y) {
  return page.evaluate(async ({ dataUrl, x, y }) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return [...context.getImageData(x, y, 1, 1).data];
  }, { dataUrl, x, y });
}

test.describe.configure({ mode: 'serial', timeout: 30_000 });

test('captures a selection, returns OCR text, and stores history', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(
      browser,
      `${mock.origin}/v1/chat/completions`
    );
    const page = await browser.context.newPage();
    await page.goto(mock.origin);

    await startCapture(browser, page);
    await selectAndConfirm(page);

    await mock.waitForRequestCount(1);

    expect(mock.state.requests[0].authorization).toBe('Bearer e2e-test-key');
    expect(mock.state.requests[0].body.model).toBe('mock-vision-model');
    expect(JSON.stringify(mock.state.requests[0].body)).toContain('data:image/png;base64,');
    await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(1);
    expect((await readHistory(browser.serviceWorker))[0].text).toBe(RESULT_TEXT);
    expect((await readHistory(browser.serviceWorker))[0].sourceUrl).toBe(mock.origin);
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('requires one-time upload consent before the first provider request', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    await browser.serviceWorker.evaluate(() => chrome.storage.local.remove('uploadNoticeAcknowledgedVersion'));
    const page = await browser.context.newPage();
    await page.goto(mock.origin);

    await startCapture(browser, page);
    await selectAndConfirm(page);
    await page.waitForTimeout(150);
    expect(mock.state.requests).toHaveLength(0);

    // Escape closes only the notice and retains the selected area.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await mock.waitForRequestCount(1);

    const acknowledgedVersion = await browser.serviceWorker.evaluate(async () => (
      (await chrome.storage.local.get('uploadNoticeAcknowledgedVersion')).uploadNoticeAcknowledgedVersion
    ));
    expect(acknowledgedVersion).toBe(1);
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('keeps the page untouched when optional endpoint permission is denied', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    const page = await browser.context.newPage();
    await page.goto(mock.origin);

    const popup = await openPopupForTab(browser, page, {
      denyEndpointPermission: true
    });
    let dialogMessage = '';
    const dialogHandled = new Promise((resolve) => {
      popup.once('dialog', async (dialog) => {
        dialogMessage = dialog.message();
        await dialog.accept();
        resolve();
      });
    });
    await popup.locator('#captureBtn').click();
    await dialogHandled;
    expect(dialogMessage).toBeTruthy();

    await expect(page.locator('#ocr-root-host')).toHaveCount(0);
    expect(mock.state.requests).toHaveLength(0);
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('page reload cancels an in-flight OCR request without storing a result', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(
      browser,
      `${mock.origin}/v1/chat/completions`,
      'mock-delay-model'
    );
    const page = await browser.context.newPage();
    await page.goto(mock.origin);

    await startCapture(browser, page);
    await selectAndConfirm(page);
    await mock.waitForRequestCount(1);

    await page.reload();

    await mock.waitForAbortCount(1);
    await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(0);
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('restarting recognition cancels the old request and accepts a fresh selection', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`, 'mock-delay-model');
    const page = await browser.context.newPage();
    await page.goto(mock.origin);
    await startCapture(browser, page);
    await selectAndConfirm(page);
    await mock.waitForRequestCount(1);
    await startCapture(browser, page);
    await mock.waitForAbortCount(1);
    expect(await readHistory(browser.serviceWorker)).toEqual([]);
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    await selectAndConfirm(page);
    await mock.waitForRequestCount(2);
    await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(1);
    expect(mock.state.abortedCount).toBe(1);
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('synthetic page events cannot select, confirm, or trigger provider requests', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    const page = await browser.context.newPage();
    await page.goto(mock.origin);

    await startCapture(browser, page);
    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 0, clientX: 90, clientY: 90
      }));
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: 560, clientY: 330
      }));
      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, button: 0, clientX: 560, clientY: 330
      }));
      document.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, key: 'Enter'
      }));
    });
    await page.waitForTimeout(100);
    expect(mock.state.requests).toHaveLength(0);

    await selectAndConfirm(page);
    await mock.waitForRequestCount(1);
    await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(1);
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('normalizes an oversized high-DPI crop before sending it to the provider', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin, { deviceScaleFactor: 5 });
  try {
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    const page = await browser.context.newPage();
    await page.goto(mock.origin);

    await startCapture(browser, page);
    await page.mouse.move(50, 50);
    await page.mouse.down();
    await page.mouse.move(950, 650, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('Enter');
    await mock.waitForRequestCount(1);

    const imageUrl = mock.state.requests[0].body.messages[0].content[1].image_url.url;
    const dimensions = readPngDimensions(imageUrl);
    expect(dimensions.width).toBeLessThanOrEqual(4096);
    expect(dimensions.height).toBeLessThanOrEqual(4096);
    expect(dimensions.width * dimensions.height).toBeLessThanOrEqual(12_000_000);
    expect(dimensions.encodedLength).toBeLessThanOrEqual(3 * 1024 * 1024);
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('retries one transient 503 and stores only the successful result', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(
      browser,
      `${mock.origin}/v1/chat/completions?transient=503`
    );
    const page = await browser.context.newPage();
    await page.goto(mock.origin);

    await startCapture(browser, page);
    await selectAndConfirm(page);

    await mock.waitForRequestCount(2);
    expect(mock.state.transientFailures).toBe(1);
    await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(1);
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('rejects an empty OCR response without showing or storing a result', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(
      browser,
      `${mock.origin}/v1/chat/completions?empty=1`
    );
    const page = await browser.context.newPage();
    await page.goto(mock.origin);

    await startCapture(browser, page);
    await selectAndConfirm(page);
    await mock.waitForRequestCount(1);

    await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(0);
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('finds a recognition in history and deletes only that record', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    const page = await browser.context.newPage();
    await page.goto(mock.origin);

    await startCapture(browser, page);
    await selectAndConfirm(page);

    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.text)
      .toBe(RESULT_TEXT);

    const historyPopup = await browser.context.newPage();
    await historyPopup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
    await historyPopup.waitForLoadState('domcontentloaded');
    await expect(historyPopup.locator('.history-item-text')).toContainText(RESULT_TEXT);

    await historyPopup.locator('#historySearch').fill('mock');
    await expect(historyPopup.locator('.history-item')).toHaveCount(1);
    await expect(historyPopup.locator('.history-source')).toContainText('OCR extension test page');

    historyPopup.once('dialog', (dialog) => dialog.accept());
    await historyPopup.locator('.history-delete-btn').click();
    await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(0);
    await expect(historyPopup.locator('#historyEmptyState')).toBeVisible();
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('provider image excludes the extension progress notification', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    const page = await browser.context.newPage();
    await page.goto(mock.origin);

    await startCapture(browser, page);
    await page.mouse.move(10, 10);
    await page.mouse.down();
    await page.mouse.move(910, 230, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('Enter');
    await mock.waitForRequestCount(1);

    const imageUrl = mock.state.requests[0].body.messages[0].content[1].image_url.url;
    const pixel = await readPngPixel(page, imageUrl, 450, 35);
    expect(pixel.slice(0, 3)).toEqual([255, 255, 255]);
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('saves an OpenAI-compatible configuration through the real options form', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    const optionsPage = await browser.context.newPage();
    await optionsPage.goto(`chrome-extension://${browser.extensionId}/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');

    await optionsPage.locator('#apiProvider').selectOption('openai-compatible');
    await optionsPage.locator('#compatibleEndpoint').fill(`${mock.origin}/v1/chat/completions`);
    await optionsPage.locator('#compatibleApiKey').fill('options-form-key');
    await optionsPage.locator('#compatibleModel').fill('options-form-model');
    await optionsPage.locator('h1').click();

    await expect.poll(() => browser.serviceWorker.evaluate(async () => {
      const result = await chrome.storage.local.get(['apiProvider', 'apiConfigs']);
      return result.apiProvider === 'openai-compatible'
        ? result.apiConfigs?.openaiCompatible
        : null;
    })).toEqual({
      endpoint: `${mock.origin}/v1/chat/completions`,
      apiKey: 'options-form-key',
      model: 'options-form-model'
    });
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

async function probe(browser, page, operation, ...args) {
  return browser.serviceWorker.evaluate(async ({ url, operation, args }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(candidate => candidate.url === url);
    if (!tab) throw new Error('Probe target tab missing');
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (method, values) => globalThis.__ocrSessionProbe[method](...values),
      args: [operation, args]
    });
    return result.result;
  }, { url: page.url(), operation, args });
}

async function clickProbe(browser, page, selector) {
  const point = await probe(browser, page, 'point', selector);
  await page.mouse.click(point.x, point.y);
}

async function withSessionTest(run) {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin, {}, true);
  try {
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    const page = await browser.context.newPage();
    await page.goto(mock.origin);
    await startCapture(browser, page);
    await run({ mock, browser, page });
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
}

test('session replacement resets an edited selection and continuous starts remain single', async () => {
  await withSessionTest(async ({ mock, browser, page }) => {
    await page.mouse.move(90, 90);
    await page.mouse.down();
    await page.mouse.move(560, 330, { steps: 5 });
    await page.mouse.up();
    expect((await probe(browser, page, 'snapshot')).selections).toBe(1);
    await startCapture(browser, page);
    expect((await probe(browser, page, 'snapshot')).selections).toBe(0);
    await startCapture(browser, page);
    expect((await probe(browser, page, 'snapshot')).overlays).toBe(1);
    expect(mock.state.requests).toHaveLength(0);
    await selectAndConfirm(page);
    await mock.waitForRequestCount(1);
    await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(1);
    expect(mock.state.requests).toHaveLength(1);
    const completed = await readHistory(browser.serviceWorker);
    await startCapture(browser, page);
    expect(await readHistory(browser.serviceWorker)).toEqual(completed);
  });
});

for (const outcome of ['success', 'error', 'failure']) {
  test(`session ignores late OCR ${outcome} without disturbing a newer request`, async () => {
    await withSessionTest(async ({ mock, browser, page }) => {
      await probe(browser, page, 'hold', 'performOCR');
      await selectAndConfirm(page);
      await expect.poll(() => probe(browser, page, 'count', 'performOCR')).toBe(1);
      await startCapture(browser, page);
      await selectAndConfirm(page);
      await expect.poll(() => probe(browser, page, 'count', 'performOCR')).toBe(2);
      const before = await probe(browser, page, 'snapshot');
      expect(before.progress).toBe(1);
      await probe(browser, page, 'release', 'performOCR', 0, outcome === 'error'
        ? { error: 'OLD SESSION ERROR' }
        : { value: outcome === 'failure' ? { success: false, error: 'OLD FAILURE' } : { success: true, text: 'OLD SESSION RESULT' } });
      const after = await probe(browser, page, 'snapshot');
      expect(after.progress).toBe(1);
      expect(after.result).toBe('');
      expect(after.notification).toBe(before.notification);
      await probe(browser, page, 'release', 'performOCR', 1, { value: { success: true, text: 'NEW SESSION RESULT' } });
      expect((await probe(browser, page, 'snapshot')).result).toBe('NEW SESSION RESULT');
      expect(mock.state.requests).toHaveLength(0);
    });
  });
}

for (const stage of ['captureVisibleTab', 'crop']) {
  test(`session discards old ${stage} completion before submitting OCR`, async () => {
    await withSessionTest(async ({ browser, page }) => {
      await probe(browser, page, 'hold', stage, 'after');
      await selectAndConfirm(page);
      await expect.poll(() => probe(browser, page, 'count', stage)).toBe(1);
      await startCapture(browser, page);
      await probe(browser, page, 'unhold', stage);
      await probe(browser, page, 'hold', 'performOCR');
      await selectAndConfirm(page);
      await expect.poll(() => probe(browser, page, 'count', 'performOCR')).toBe(1);
      await probe(browser, page, 'release', stage);
      expect(await probe(browser, page, 'count', 'performOCR')).toBe(1);
      expect((await probe(browser, page, 'snapshot')).progress).toBe(1);
      await probe(browser, page, 'release', 'performOCR', 0, { value: { success: true, text: 'CURRENT' } });
      expect((await probe(browser, page, 'snapshot')).result).toBe('CURRENT');
    });
  });
}

test('session ignores stale upload-state response and requires fresh consent', async () => {
  await withSessionTest(async ({ mock, browser, page }) => {
    await browser.serviceWorker.evaluate(() => chrome.storage.local.remove('uploadNoticeAcknowledgedVersion'));
    await probe(browser, page, 'hold', 'getUploadNoticeState', 'after');
    await selectAndConfirm(page);
    await expect.poll(() => probe(browser, page, 'count', 'getUploadNoticeState')).toBe(1);
    await page.keyboard.press('Enter');
    expect(await probe(browser, page, 'count', 'getUploadNoticeState')).toBe(1);
    await startCapture(browser, page);
    await probe(browser, page, 'release', 'getUploadNoticeState');
    expect((await probe(browser, page, 'snapshot')).notices).toBe(0);
    expect((await probe(browser, page, 'snapshot')).overlays).toBe(1);
    await probe(browser, page, 'unhold', 'getUploadNoticeState');
    await selectAndConfirm(page);
    await expect.poll(async () => (await probe(browser, page, 'snapshot')).notices).toBe(1);
    expect(mock.state.requests).toHaveLength(0);
    await clickProbe(browser, page, '.ocr-upload-notice-accept');
    await mock.waitForRequestCount(1);
  });
});

test('session replacement settles an open upload dialog without granting consent', async () => {
  await withSessionTest(async ({ mock, browser, page }) => {
    await browser.serviceWorker.evaluate(() => chrome.storage.local.remove('uploadNoticeAcknowledgedVersion'));
    await selectAndConfirm(page);
    await expect.poll(async () => (await probe(browser, page, 'snapshot')).notices).toBe(1);
    await startCapture(browser, page);
    expect((await probe(browser, page, 'snapshot')).notices).toBe(0);
    await selectAndConfirm(page);
    await expect.poll(async () => (await probe(browser, page, 'snapshot')).notices).toBe(1);
    expect(mock.state.requests).toHaveLength(0);
    const consent = await browser.serviceWorker.evaluate(() => chrome.storage.local.get('uploadNoticeAcknowledgedVersion'));
    expect(consent.uploadNoticeAcknowledgedVersion).toBeUndefined();
    await clickProbe(browser, page, '.ocr-upload-notice-accept');
    await mock.waitForRequestCount(1);
    expect(mock.state.requests).toHaveLength(1);
  });
});

test('session ignores old consent-write response while preserving real consent', async () => {
  await withSessionTest(async ({ mock, browser, page }) => {
    await browser.serviceWorker.evaluate(() => chrome.storage.local.remove('uploadNoticeAcknowledgedVersion'));
    await probe(browser, page, 'hold', 'acknowledgeUploadNotice', 'after');
    await selectAndConfirm(page);
    await expect.poll(async () => (await probe(browser, page, 'snapshot')).notices).toBe(1);
    await clickProbe(browser, page, '.ocr-upload-notice-accept');
    await expect.poll(() => probe(browser, page, 'count', 'acknowledgeUploadNotice')).toBe(1);
    await startCapture(browser, page);
    await probe(browser, page, 'release', 'acknowledgeUploadNotice');
    expect(mock.state.requests).toHaveLength(0);
    expect((await probe(browser, page, 'snapshot')).overlays).toBe(1);
    await selectAndConfirm(page);
    await mock.waitForRequestCount(1);
    expect((await probe(browser, page, 'snapshot')).notices).toBe(0);
  });
});

test('session cancel and immediate restart reject old callbacks and spare another tab', async () => {
  await withSessionTest(async ({ browser, page }) => {
    await probe(browser, page, 'hold', 'performOCR');
    await selectAndConfirm(page);
    await expect.poll(() => probe(browser, page, 'count', 'performOCR')).toBe(1);
    const other = await browser.context.newPage();
    await other.goto(`${page.url()}?tab=b`);
    await startCapture(browser, other);
    await probe(browser, other, 'hold', 'performOCR');
    await selectAndConfirm(other);
    await expect.poll(() => probe(browser, other, 'count', 'performOCR')).toBe(1);
    await page.bringToFront();
    await clickProbe(browser, page, '.ocr-progress-cancel');
    await startCapture(browser, page);
    await selectAndConfirm(page);
    await expect.poll(async () => ({
      count: await probe(browser, page, 'count', 'performOCR'),
      ui: await probe(browser, page, 'snapshot'),
      messages: await probe(browser, page, 'messages')
    })).toMatchObject({ count: 2 });
    await probe(browser, page, 'release', 'performOCR', 0, { value: { success: true, text: 'CANCELLED' } });
    expect((await probe(browser, page, 'snapshot')).progress).toBe(1);
    expect((await probe(browser, other, 'snapshot')).progress).toBe(1);
    expect((await probe(browser, other, 'messages')).filter(message => message.action === 'cancelOCR')).toHaveLength(0);
    await other.bringToFront();
    await probe(browser, other, 'release', 'performOCR', 0, { value: { success: true, text: 'TAB B' } });
    expect((await probe(browser, other, 'snapshot')).result).toBe('TAB B');
    await page.bringToFront();
    await probe(browser, page, 'release', 'performOCR', 1, { value: { success: true, text: 'TAB A NEW' } });
    expect((await probe(browser, page, 'snapshot')).result).toBe('TAB A NEW');
  });
});


test('session destruction removes listeners and repeated injection remains idempotent', async () => {
  await withSessionTest(async ({ mock, browser, page }) => {
    const files = require('../../extension-runtime.js').CONTENT_SCRIPT_FILES;
    const tabId = await browser.serviceWorker.evaluate(async url => {
      const tabs = await chrome.tabs.query({});
      return tabs.find(tab => tab.url === url).id;
    }, page.url());
    const inject = () => browser.serviceWorker.evaluate(({ tabId, files }) => chrome.scripting.executeScript({ target: { tabId }, files }), { tabId, files });
    const initial = await probe(browser, page, 'lifecycle');
    await inject();
    expect(await probe(browser, page, 'lifecycle')).toEqual(initial);
    await probe(browser, page, 'hold', 'performOCR');
    await selectAndConfirm(page);
    await expect.poll(() => probe(browser, page, 'count', 'performOCR')).toBe(1);
    await probe(browser, page, 'destroy');
    await probe(browser, page, 'destroy');
    expect((await probe(browser, page, 'lifecycle')).listeners).toBe(0);
    expect((await probe(browser, page, 'lifecycle')).intervals).toBe(0);
    await expect(page.locator('#ocr-root-host')).toHaveCount(0);
    await probe(browser, page, 'release', 'performOCR', 0, { value: { success: true, text: 'destroyed result' } });
    await expect(page.locator('#ocr-root-host')).toHaveCount(0);
    await startCapture(browser, page);
    expect((await probe(browser, page, 'snapshot')).overlays).toBe(1);
    expect((await probe(browser, page, 'lifecycle')).listeners).toBe(initial.listeners);
    expect((await probe(browser, page, 'lifecycle')).instances).toBe(2);
    expect(mock.state.requests).toHaveLength(0);
  });
});


test('selection supports moving, resizing, undo, reselection and Escape', async () => {
  await withSessionTest(async ({ mock, browser, page }) => {
    await page.mouse.move(90, 90);
    await page.mouse.down();
    await page.mouse.move(560, 330, { steps: 5 });
    await page.mouse.up();
    const original = await probe(browser, page, 'rect');
    const center = await probe(browser, page, 'point', '#ocr-selection-box');
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 40, center.y + 30, { steps: 5 });
    await page.mouse.up();
    expect(await probe(browser, page, 'rect')).toEqual({ ...original, left: original.left + 40, top: original.top + 30 });
    await clickProbe(browser, page, '#ocr-undo-btn');
    expect(await probe(browser, page, 'rect')).toEqual(original);
    const handle = await probe(browser, page, 'point', '.ocr-handle-se');
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + 30, handle.y + 20, { steps: 5 });
    await page.mouse.up();
    const resized = { ...original, width: original.width + 30, height: original.height + 20 };
    expect(await probe(browser, page, 'rect')).toEqual(resized);
    for (let step = 0; step < 20 && !(await probe(browser, page, 'focused', '.ocr-handle-se')); step++) {
      await page.keyboard.press('Tab');
    }
    expect(await probe(browser, page, 'focused', '.ocr-handle-se')).toBe(true);
    await page.keyboard.press('ArrowRight');
    expect(await probe(browser, page, 'rect')).toEqual({ ...resized, width: resized.width + 2 });
    await page.keyboard.press('ControlOrMeta+z');
    expect(await probe(browser, page, 'rect')).toEqual(resized);
    await clickProbe(browser, page, '#ocr-reselect-btn');
    expect(await probe(browser, page, 'rect')).toBeNull();
    expect((await probe(browser, page, 'snapshot')).overlays).toBe(1);
    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(400, 250, { steps: 5 });
    await page.mouse.up();
    expect(await probe(browser, page, 'rect')).toEqual({ left: 100, top: 100, width: 300, height: 150 });
    await page.keyboard.press('Escape');
    expect((await probe(browser, page, 'snapshot')).overlays).toBe(0);
    expect(await probe(browser, page, 'rect')).toBeNull();
    expect(mock.state.requests).toHaveLength(0);
  });
});

test('result view copies, saves literal edits and closes through real controls', async () => {
  await withSessionTest(async ({ browser, page }) => {
    await selectAndConfirm(page);
    await expect.poll(() => probe(browser, page, 'snapshot')).toMatchObject({ result: RESULT_TEXT });
    await probe(browser, page, 'settle', '#ocr-result-popup');
    const edited = '<script>window.ocrInjected = true</script> corrected text';
    await clickProbe(browser, page, '#ocr-result-text');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(edited);
    expect((await probe(browser, page, 'snapshot')).result).toBe(edited);
    await clickProbe(browser, page, '.copy-btn');
    await expect.poll(() => probe(browser, page, 'copied')).toEqual([edited]);
    await clickProbe(browser, page, '.save-changes-btn');
    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.text).toBe(edited);
    expect((await probe(browser, page, 'snapshot')).result).toBe(edited);
    expect(await probe(browser, page, 'scriptCount')).toBe(0);
    expect(await page.evaluate(() => window.ocrInjected)).toBeUndefined();
    await clickProbe(browser, page, '.close-popup-btn');
    await expect.poll(async () => (await probe(browser, page, 'snapshot')).result).toBe('');
  });
});

async function withOptionsTest(run) {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    const page = await browser.context.newPage();
    await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
    await expect(page.locator('#compatibleEndpoint')).toHaveValue(`${mock.origin}/v1/chat/completions`);
    await run({ page, browser, mock });
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
}

async function readDownloadedJson(page, action) {
  const pending = page.waitForEvent('download');
  await action();
  const download = await pending;
  return JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
}

function importFixture(page, data) {
  return page.locator('#importFileInput').setInputFiles({
    name: 'test-config.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data))
  });
}

test('options form preserves provider fields and denies an unapproved test endpoint', async () => {
  await withOptionsTest(async ({ page, browser, mock }) => {
    await page.locator('#apiProvider').selectOption('baidu');
    await page.locator('#baiduApiKey').fill('form-test-key');
    await page.locator('#baiduSecret').fill('form-test-secret');
    await page.locator('#baiduMode').focus();
    await page.locator('#baiduMode').selectOption('handwriting');
    await page.locator('#baiduMode').blur();
    await expect.poll(() => browser.serviceWorker.evaluate(async () => (await chrome.storage.local.get('apiConfigs')).apiConfigs.baidu?.mode)).toBe('handwriting');
    await page.locator('#apiProvider').selectOption('openai-compatible');
    await expect(page.locator('#compatibleApiKey')).toHaveValue('e2e-test-key');
    await page.locator('#compatibleEndpoint').fill('https://permission-denied.example/v1/chat/completions');
    await page.locator('#compatibleEndpoint').blur();
    await expect.poll(() => browser.serviceWorker.evaluate(async () => (await chrome.storage.local.get('apiConfigs')).apiConfigs.openaiCompatible.endpoint)).toBe('https://permission-denied.example/v1/chat/completions');
    await expect(page.locator('#statusMessage')).toHaveClass(/success/);
    await page.evaluate(() => {
      chrome.permissions.contains = async () => false;
      globalThis.deniedRequests = 0;
      chrome.permissions.request = async () => { globalThis.deniedRequests++; return false; };
    });
    await page.locator('#testBtn').click();
    await expect.poll(() => page.evaluate(() => globalThis.deniedRequests)).toBe(1);
    await expect(page.locator('#statusMessage')).toHaveClass(/error/);
    expect(mock.state.requests).toHaveLength(0);
    await page.locator('#apiProvider').selectOption('baidu');
    await expect(page.locator('#baiduSecret')).toHaveValue('form-test-secret');
    await expect(page.locator('#baiduMode')).toHaveValue('handwriting');
  });
});

test('options transfers preserve credentials, modern precedence and appearance through import and export', async () => {
  await withOptionsTest(async ({ page, browser }) => {
    const redacted = await readDownloadedJson(page, () => page.locator('#exportBtn').click());
    expect(redacted.config.apiConfigs.openaiCompatible.apiKey).toBeUndefined();
    expect(redacted.version).toBe(require('../../manifest.json').version);
    await page.locator('#includeApiKeys').check();
    const complete = await readDownloadedJson(page, () => page.locator('#exportBtn').click());
    expect(complete.config.apiConfigs.openaiCompatible.apiKey).toBe('e2e-test-key');
    await page.locator('#theme').selectOption('dark');
    await page.locator('#uiLanguage').selectOption('zh_CN');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    const imported = { apiProvider: 'openai-compatible', apiConfigs: { openaiCompatible: { model: 'modern-import-model' } }, customModel: 'legacy-model', customEndpoint: 'https://legacy.example/v1/chat/completions' };
    await importFixture(page, imported);
    await page.locator('#modalConfirm').click();
    await expect(page.locator('#compatibleModel')).toHaveValue('modern-import-model');
    await expect(page.locator('#compatibleApiKey')).toHaveValue('e2e-test-key');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#uiLanguage')).toHaveValue('zh_CN');
    const before = await browser.serviceWorker.evaluate(() => chrome.storage.local.get(['apiConfigs', 'apiProvider', 'theme', 'uiLanguage']));
    await importFixture(page, imported);
    await page.locator('#modalConfirm').click();
    await expect(page.locator('.modal-overlay')).toHaveCount(0);
    await importFixture(page, { language: 'unsupported-language' });
    await expect(page.locator('#statusMessage')).toHaveClass(/error/);
    expect(await browser.serviceWorker.evaluate(() => chrome.storage.local.get(['apiConfigs', 'apiProvider', 'theme', 'uiLanguage']))).toEqual(before);
    await importFixture(page, { apiProvider: 'claude', apiKey: 'never-imported-test-key' });
    await expect(page.locator('.modal-overlay')).toBeVisible();
    await page.evaluate(() => { window.dispatchEvent(new window.Event('pagehide')); window.dispatchEvent(new window.Event('pagehide')); });
    await expect(page.locator('.modal-overlay')).toHaveCount(0);
    expect(await browser.serviceWorker.evaluate(() => chrome.storage.local.get(['apiConfigs', 'apiProvider', 'theme', 'uiLanguage']))).toEqual(before);
    await page.locator('#theme').selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test('popup history refreshes edits, copies, exports, deletes and clears while retaining appearance controls', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    await browser.serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ ocrHistory: [
        { id: 'a', text: 'alpha result', provider: 'openai', language: 'en', timestamp: Date.now() },
        { id: 'b', text: 'beta result', provider: 'claude', language: 'zh', timestamp: Date.now() - 1000 }
      ] });
    });
    const page = await browser.context.newPage();
    await page.addInitScript(() => {
      globalThis.copiedHistory = [];
      navigator.clipboard.writeText = async text => { globalThis.copiedHistory.push(text); };
      globalThis.removedStorageListeners = 0;
      const remove = chrome.storage.onChanged.removeListener.bind(chrome.storage.onChanged);
      chrome.storage.onChanged.removeListener = callback => { globalThis.removedStorageListeners++; remove(callback); };
    });
    await page.goto(`chrome-extension://${browser.extensionId}/popup.html`);
    await expect(page.locator('.history-item')).toHaveCount(2);
    await page.locator('#historySearch').fill('alpha');
    await expect(page.locator('.history-item')).toHaveCount(1);
    await page.locator('.history-item-text').click();
    await expect(page.locator('#historyPreviewText')).toHaveValue('alpha result');
    await page.locator('#previewCopyBtn').click();
    expect(await page.evaluate(() => globalThis.copiedHistory)).toEqual(['alpha result']);
    await page.evaluate(() => chrome.runtime.sendMessage({ action: 'updateHistoryRecord', historyId: 'a', text: 'alpha edited' }));
    await expect(page.locator('.history-item-text')).toHaveText('alpha edited');
    await expect(page.locator('#historySearch')).toHaveValue('alpha');
    await page.locator('.history-copy-btn').click();
    expect(await page.evaluate(() => globalThis.copiedHistory)).toEqual(['alpha result', 'alpha edited']);
    const exported = await readDownloadedJson(page, () => page.locator('#exportHistoryBtn').click());
    expect(exported.records).toHaveLength(2);
    expect(exported.records.find(record => record.id === 'a').text).toBe('alpha edited');
    await page.locator('#languageSelect').selectOption('zh_CN');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.locator('#languageSelect').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.locator('#themeBtn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#themeBtn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.history-delete-btn').click();
    await expect(page.locator('.history-item')).toHaveCount(0);
    await page.locator('#historySearch').fill('');
    await expect(page.locator('.history-item-text')).toHaveText('beta result');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#clearHistoryBtn').click();
    await expect(page.locator('#historyEmptyState')).toBeVisible();
    expect(await readHistory(browser.serviceWorker)).toEqual([]);
    await page.evaluate(() => { window.dispatchEvent(new window.Event('pagehide')); window.dispatchEvent(new window.Event('pagehide')); });
    expect(await page.evaluate(() => globalThis.removedStorageListeners)).toBe(1);
    await page.locator('#themeBtn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});
