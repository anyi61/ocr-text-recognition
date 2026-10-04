'use strict';

const { expect, chromium } = require('@playwright/test');
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
      return !['.codegraph', '.cursor', '.git', 'node_modules', 'test-results', 'playwright-report', 'dist', 'tests'].includes(firstPart);
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
  // Production keeps its UI in a closed isolated-world shadow root. Only this
  // disposable test copy exposes it so Playwright can drive real trusted input.
  const contentPath = path.join(extensionDir, 'content.js');
  fs.writeFileSync(contentPath, fs.readFileSync(contentPath, 'utf8')
    .replace("attachShadow({ mode: 'closed' })", "attachShadow({ mode: 'open' })"));
  // Clipboard failure and late completion are unavailable as native browser
  // controls. Instrument only disposable isolated-world/page test sources.
  const clipboardHook = `(() => {
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text) => {
      const settings = await chrome.runtime.sendMessage({ action: 'e2eClipboard', text });
      if (!settings.e2eClipboardMode) return original(text);
      if (settings.e2eClipboardDelay) await new Promise((resolve) => setTimeout(resolve, settings.e2eClipboardDelay));
      if (settings.e2eClipboardMode === 'fail') throw new Error('Clipboard denied by test');
    };
  })();\n`;
  const backgroundPath = path.join(extensionDir, 'background.js');
  const testBackground = `chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.action !== 'e2eClipboard') return;
    (async () => {
      const settings = await chrome.storage.local.get(['e2eClipboardMode', 'e2eClipboardWrites', 'e2eClipboardDelay']);
      if (settings.e2eClipboardMode) await chrome.storage.local.set({ e2eClipboardWrites: [...(settings.e2eClipboardWrites || []), message.text] });
      respond(settings);
    })();
    return true;
  });\n`;
  fs.writeFileSync(backgroundPath, testBackground + fs.readFileSync(backgroundPath, 'utf8'));
  for (const filename of ['content.js', 'workspace.js']) {
    const sourcePath = path.join(extensionDir, filename);
    fs.writeFileSync(sourcePath, clipboardHook + fs.readFileSync(sourcePath, 'utf8'));
  }
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
  await page.bringToFront();
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

async function setStorage(browser, values) {
  await browser.serviceWorker.evaluate((values) => chrome.storage.local.set(values), values);
}

async function readStorage(browser, keys) {
  return browser.serviceWorker.evaluate((keys) => chrome.storage.local.get(keys), keys);
}

async function openExtensionPage(browser, filename = 'workspace.html') {
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${browser.extensionId}/${filename}`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function disposeBrowser(browser) {
  await browser.context.close();
  fs.rmSync(browser.userDataDir, { recursive: true, force: true });
  fs.rmSync(browser.extensionDir, { recursive: true, force: true });
}

async function restartBrowser(browser) {
  await browser.context.close();
  const context = await chromium.launchPersistentContext(browser.userDataDir, {
    channel: 'chromium', headless: true, viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${browser.extensionDir}`, `--load-extension=${browser.extensionDir}`]
  });
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker');
  browser.context = context;
  browser.serviceWorker = serviceWorker;
  return browser;
}

async function uploadImage(page, color = '#123456', name = 'sample.png') {
  const base64 = await page.evaluate((color) => {
    const canvas = document.createElement('canvas');
    canvas.width = 100; canvas.height = 60;
    const context = canvas.getContext('2d');
    context.fillStyle = color; context.fillRect(0, 0, 100, 60);
    return canvas.toDataURL('image/png').split(',')[1];
  }, color);
  await page.locator('#imageFile').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') });
  await expect(page.locator('#imagePreview')).toBeVisible();
  await expect(page.locator('#recognizeImage')).toBeEnabled();
}

module.exports = {
  RESULT_TEXT, startMockServer, launchExtension, configureExtension, openPopupForTab,
  startCapture, selectAndConfirm, readHistory, readPngDimensions, readPngPixel,
  setStorage, readStorage, openExtensionPage, disposeBrowser, restartBrowser, uploadImage
};
