'use strict';

const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMockServer } = require('./mock-server');

const EXTENSION_PATH = path.resolve(__dirname, '../..');
const RESULT_TEXT = 'MOCK OCR RESULT 12345';

function createE2EExtensionCopy(mockOrigin) {
  const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-extension-src-'));
  fs.cpSync(EXTENSION_PATH, extensionDir, {
    recursive: true,
    filter(source) {
      const relative = path.relative(EXTENSION_PATH, source);
      const firstPart = relative.split(path.sep)[0];
      return !['.codegraph', '.cursor', '.git', 'node_modules', 'test-results'].includes(firstPart);
    }
  });
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

async function launchExtension(mockOrigin, contextOptions = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-extension-e2e-'));
  const extensionDir = createE2EExtensionCopy(mockOrigin);
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
      ocrHistory: []
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
  await expect(page.locator('#ocr-root-host #ocr-capture-overlay')).toBeVisible();
}

async function selectAndConfirm(page) {
  await page.mouse.move(90, 90);
  await page.mouse.down();
  await page.mouse.move(560, 330, { steps: 5 });
  await page.mouse.up();
  const confirmButton = page.locator('#ocr-root-host #ocr-confirm-btn');
  await expect(confirmButton).toBeVisible();
  await confirmButton.click();
}

async function readHistory(serviceWorker) {
  return serviceWorker.evaluate(async () => {
    const { ocrHistory = [] } = await chrome.storage.local.get('ocrHistory');
    return ocrHistory;
  });
}

async function selectionRect(page) {
  return page.locator('#ocr-root-host #ocr-selection-box').boundingBox();
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

    const result = page.locator('#ocr-root-host #ocr-result-text');
    await expect(result).toHaveValue(RESULT_TEXT);
    await mock.waitForRequestCount(1);

    expect(mock.state.requests[0].authorization).toBe('Bearer e2e-test-key');
    expect(mock.state.requests[0].body.model).toBe('mock-vision-model');
    expect(JSON.stringify(mock.state.requests[0].body)).toContain('data:image/png;base64,');
    await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(1);
    expect((await readHistory(browser.serviceWorker))[0].text).toBe(RESULT_TEXT);
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

test('cancels an in-flight OCR request without showing or storing a result', async () => {
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

    const cancelButton = page.locator('#ocr-root-host .ocr-progress-cancel');
    await expect(cancelButton).toBeVisible();
    await cancelButton.dispatchEvent('click');

    await mock.waitForAbortCount(1);
    await expect(page.locator('#ocr-root-host #ocr-result-popup')).toHaveCount(0);
    await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(0);
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('moves and resizes the selection, undoes the resize, then confirms', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    const page = await browser.context.newPage();
    await page.goto(mock.origin);

    await startCapture(browser, page);
    await page.mouse.move(90, 90);
    await page.mouse.down();
    await page.mouse.move(560, 330, { steps: 5 });
    await page.mouse.up();

    const initial = await selectionRect(page);
    expect(initial).not.toBeNull();

    await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      initial.x + initial.width / 2 + 80,
      initial.y + initial.height / 2 + 50,
      { steps: 4 }
    );
    await page.mouse.up();

    const moved = await selectionRect(page);
    expect(moved.x).toBeCloseTo(initial.x + 80, 0);
    expect(moved.y).toBeCloseTo(initial.y + 50, 0);
    expect(moved.width).toBeCloseTo(initial.width, 0);
    expect(moved.height).toBeCloseTo(initial.height, 0);

    const southeastHandle = page.locator('#ocr-root-host .ocr-handle-se');
    const handle = await southeastHandle.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      handle.x + handle.width / 2 + 40,
      handle.y + handle.height / 2 + 30,
      { steps: 4 }
    );
    await page.mouse.up();

    const resized = await selectionRect(page);
    expect(resized.width).toBeGreaterThan(moved.width);
    expect(resized.height).toBeGreaterThan(moved.height);

    await page.locator('#ocr-root-host #ocr-undo-btn').click();
    const undone = await selectionRect(page);
    expect(undone.x).toBeCloseTo(moved.x, 0);
    expect(undone.y).toBeCloseTo(moved.y, 0);
    expect(undone.width).toBeCloseTo(moved.width, 0);
    expect(undone.height).toBeCloseTo(moved.height, 0);

    await page.locator('#ocr-root-host #ocr-confirm-btn').click();
    await expect(page.locator('#ocr-root-host #ocr-result-text')).toHaveValue(RESULT_TEXT);
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
    await page.locator('#ocr-root-host #ocr-confirm-btn').click();
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

    await expect(page.locator('#ocr-root-host #ocr-result-text')).toHaveValue(RESULT_TEXT);
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

    await expect(page.locator('#ocr-root-host #ocr-result-popup')).toHaveCount(0);
    await expect(page.locator('#ocr-root-host #ocr-notification')).toBeVisible();
    await expect.poll(() => readHistory(browser.serviceWorker)).toHaveLength(0);
  } finally {
    await browser.context.close();
    fs.rmSync(browser.userDataDir, { recursive: true, force: true });
    fs.rmSync(browser.extensionDir, { recursive: true, force: true });
    await mock.close();
  }
});

test('saves a corrected result, finds it in history, and deletes only that record', async () => {
  const mock = await startMockServer();
  const browser = await launchExtension(mock.origin);
  try {
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    const page = await browser.context.newPage();
    await page.goto(mock.origin);

    await startCapture(browser, page);
    await selectAndConfirm(page);

    const result = page.locator('#ocr-root-host #ocr-result-text');
    await expect(result).toHaveValue(RESULT_TEXT);
    await result.fill('CORRECTED OCR RESULT');
    await page.locator('#ocr-root-host .save-changes-btn').click();
    await expect.poll(async () => (await readHistory(browser.serviceWorker))[0]?.text)
      .toBe('CORRECTED OCR RESULT');

    const historyPopup = await browser.context.newPage();
    await historyPopup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
    await historyPopup.waitForLoadState('domcontentloaded');
    await expect(historyPopup.locator('.history-item-text')).toContainText('CORRECTED OCR RESULT');

    await historyPopup.locator('#historySearch').fill('corrected');
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
