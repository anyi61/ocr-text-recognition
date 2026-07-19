const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requestEndpointPermission,
  hasEndpointPermission,
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
      files: ['i18n-runtime.js', 'capture-utils.js', 'content.js']
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
