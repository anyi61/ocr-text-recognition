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
  await expect(page.locator('#ocr-root-host')).toHaveCount(1);
  await popup.close();
}

async function selectAndConfirm(page) {
  await page.mouse.move(90, 90);
  await page.mouse.down();
  await page.mouse.move(560, 330, { steps: 5 });
  await page.mouse.up();
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
