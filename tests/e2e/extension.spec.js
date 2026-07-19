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

async function launchExtension(mockOrigin) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-extension-e2e-'));
  const extensionDir = createE2EExtensionCopy(mockOrigin);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1000, height: 700 },
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

async function startCapture(browser, page) {
  await page.bringToFront();
  const targetTabId = await browser.serviceWorker.evaluate(async ({ pageUrl }) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((candidate) => candidate.url === pageUrl)?.id;
  }, { pageUrl: page.url() });
  if (!targetTabId) throw new Error(`Could not find test tab: ${page.url()}`);

  const popup = await browser.context.newPage();
  await popup.addInitScript(({ targetTabId }) => {
    Object.defineProperty(chrome.tabs, 'query', {
      configurable: true,
      value: async () => [{ id: targetTabId }]
    });
  }, { targetTabId });
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await popup.waitForLoadState('domcontentloaded');
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
