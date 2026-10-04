'use strict';

const { test, expect, chromium } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMockServer, configureExtension, uploadImage, readHistory } = require('./helpers');

test('release ZIP installs with all runtime files and completes image retry, translation and protected history', async ({}, testInfo) => {
  const { buildPackage } = await import('../../scripts/package-extension.mjs');
  const zipPath = buildPackage();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-package-smoke-'));
  const extensionDir = path.join(temporary, 'extension');
  fs.mkdirSync(extensionDir);
  execFileSync('unzip', ['-q', zipPath, '-d', extensionDir]);
  const mock = await startMockServer();
  let context;
  try {
    const manifestFile = path.join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    expect(fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8')).toContain("attachShadow({ mode: 'closed' })");
    for (const excluded of ['tests', 'node_modules', '.git', 'docs']) {
      expect(fs.existsSync(path.join(extensionDir, excluded))).toBe(false);
    }
    // The sole package-copy alteration permits this test's local Mock origin.
    // No source instrumentation or changes to storage/clipboard behavior.
    manifest.host_permissions.push(`${mock.origin}/*`);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      channel: 'chromium', headless: true, viewport: { width: 1000, height: 900 },
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = worker.url().split('/')[2];
    const browser = { serviceWorker: worker };
    const workspace = await context.newPage();
    await workspace.goto(`chrome-extension://${extensionId}/workspace.html`);
    await expect(workspace.locator('#imageFile')).toBeAttached();
    await configureExtension(browser, `${mock.origin}/v1/chat/completions`);
    await worker.evaluate(() => chrome.storage.local.set({ uiLanguage: 'en' }));
    await workspace.reload();
    await uploadImage(workspace);
    mock.state.queue.push({ status: 401 });
    await workspace.locator('#recognizeImage').click();
    await expect(workspace.locator('#imageRecoveryActions')).toBeVisible();
    await workspace.screenshot({ path: testInfo.outputPath('installed-failure-recovery.png'), fullPage: true });
    await workspace.locator('#retryImageOCR').click();
    await expect(workspace.locator('#imageResultText')).toHaveValue('MOCK OCR RESULT 12345');
    await workspace.locator('[data-translation="provider"]').selectOption('openai-compatible');
    await workspace.locator('[data-translation="target"]').selectOption('ja');
    await workspace.locator('[data-translation="start"]').click();
    await expect(workspace.locator('[data-translation="text"]')).toHaveValue('MOCK TRANSLATION RESULT');
    await expect.poll(async () => (await readHistory(worker))[0]?.translation?.text).toBe('MOCK TRANSLATION RESULT');
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 420, height: 900 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator('.history-item').click();
    await popup.locator('#previewFavoriteBtn').click();
    await popup.locator('#historyName').fill('Release package verification');
    await popup.locator('#historyNameSaveBtn').click();
    await expect.poll(async () => {
      const record = (await readHistory(worker))[0];
      return { favorite: record?.favorite, name: record?.name, translation: record?.translation?.text };
    }).toEqual({ favorite: true, name: 'Release package verification', translation: 'MOCK TRANSLATION RESULT' });
    await expect(popup.locator('[data-translation="text"]')).toHaveValue('MOCK TRANSLATION RESULT');
    expect(mock.state.requests).toHaveLength(3);
    await popup.screenshot({ path: testInfo.outputPath('installed-protected-history.png'), fullPage: true });
  } finally {
    await context?.close();
    await mock.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
