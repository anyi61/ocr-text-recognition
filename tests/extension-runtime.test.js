const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requestEndpointPermission,
  hasEndpointPermission,
  getUnsupportedPageReason,
  startCaptureInTab
} = require('../extension-runtime.js');

test('requests only the configured custom endpoint origin', async () => {
  const requests = [];
  const chromeApi = {
    permissions: {
      async request(permission) {
        requests.push(permission);
        return true;
      }
    }
  };

  assert.equal(
    await requestEndpointPermission(
      chromeApi,
      'openai-compatible',
      'https://ocr.example.com:8443/v1/chat/completions'
    ),
    true
  );
  assert.deepEqual(requests, [{ origins: ['https://ocr.example.com:8443/*'] }]);
  assert.equal(await requestEndpointPermission(chromeApi, 'openai', ''), true);
  assert.equal(await requestEndpointPermission(chromeApi, 'custom', 'file:///tmp/api'), false);
});

test('checks custom permission without prompting', async () => {
  const chromeApi = {
    permissions: {
      async contains(permission) {
        assert.deepEqual(permission, { origins: ['http://127.0.0.1:3000/*'] });
        return true;
      }
    }
  };

  assert.equal(
    await hasEndpointPermission(chromeApi, 'custom', 'http://127.0.0.1:3000/ocr'),
    true
  );
});

test('missing content listener triggers ordered injection and retry', async () => {
  const calls = [];
  let attempts = 0;
  const chromeApi = {
    tabs: {
      async sendMessage(tabId, message) {
        calls.push(['send', tabId, message]);
        attempts += 1;
        if (attempts === 1) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
      }
    },
    scripting: {
      async executeScript(details) {
        calls.push(['inject', details]);
      }
    }
  };

  await startCaptureInTab(chromeApi, 42);
  assert.deepEqual(calls[1], [
    'inject',
    {
      target: { tabId: 42 },
      files: ['i18n-runtime.js', 'capture-utils.js', 'content/styles.js', 'content/selection.js', 'content/notice-view.js', 'content/result-view.js', 'content/capture-pipeline.js', 'content/session.js', 'content.js']
    }
  ]);
  assert.equal(attempts, 2);
});

test('unexpected messaging errors do not inject scripts', async () => {
  let injected = false;
  const chromeApi = {
    tabs: {
      async sendMessage() {
        throw new Error('Tab was closed');
      }
    },
    scripting: {
      async executeScript() {
        injected = true;
      }
    }
  };

  await assert.rejects(startCaptureInTab(chromeApi, 42), /Tab was closed/);
  assert.equal(injected, false);
});

test('classifies browser-internal and store pages before injection', () => {
  assert.equal(getUnsupportedPageReason('chrome://settings/'), 'browser_internal');
  assert.equal(getUnsupportedPageReason('edge://extensions/'), 'browser_internal');
  assert.equal(
    getUnsupportedPageReason('https://chromewebstore.google.com/detail/example/id'),
    'browser_store'
  );
  assert.equal(getUnsupportedPageReason('https://example.com/page'), null);
});

test('unsupported pages fail before content script messaging', async () => {
  let messaged = false;
  const chromeApi = {
    tabs: {
      async sendMessage() {
        messaged = true;
      }
    }
  };

  await assert.rejects(
    startCaptureInTab(chromeApi, { id: 42, url: 'chrome://settings/' }),
    (error) => error?.code === 'UNSUPPORTED_PAGE'
      && error?.reason === 'browser_internal'
  );
  assert.equal(messaged, false);
});

test('file pages fail with an actionable reason when extension file access is disabled', async () => {
  let messaged = false;
  const chromeApi = {
    extension: {
      isAllowedFileSchemeAccess(callback) {
        callback(false);
      }
    },
    tabs: {
      async sendMessage() {
        messaged = true;
      }
    }
  };

  await assert.rejects(
    startCaptureInTab(chromeApi, { id: 42, url: 'file:///tmp/example.html' }),
    (error) => error?.code === 'UNSUPPORTED_PAGE'
      && error?.reason === 'file_access'
  );
  assert.equal(messaged, false);
});
