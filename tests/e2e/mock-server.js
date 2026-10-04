'use strict';

const http = require('node:http');

const TEST_PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>OCR extension test page</title>
    <style>
      body { margin: 0; font: 24px system-ui; background: white; color: #111; }
      main { margin: 64px; width: 640px; padding: 48px; border: 2px solid #333; }
    </style>
  </head>
  <body><main>端到端测试 OCR SAMPLE 12345</main></body>
</html>`;

function startMockServer() {
  const state = {
    requests: [],
    queue: [],
    abortedCount: 0,
    completedCount: 0,
    transientFailures: 0
  };
  const waiters = new Set();
  const timers = new Set();

  function notifyWaiters() {
    for (const waiter of waiters) waiter();
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && !url.pathname.startsWith('/v1/')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(TEST_PAGE);
      return;
    }

    if (request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      let parsedBody;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        response.writeHead(400).end('invalid JSON');
        return;
      }

      state.requests.push({
        authorization: request.headers.authorization,
        headers: { ...request.headers },
        path: `${url.pathname}${url.search}`,
        body: parsedBody
      });
      notifyWaiters();

      if (url.searchParams.get('transient') === '503' && state.transientFailures === 0) {
        state.transientFailures += 1;
        response.writeHead(503, {
          'content-type': 'application/json',
          'retry-after': '0'
        });
        response.end(JSON.stringify({ error: { message: 'temporarily busy' } }));
        return;
      }

      let closedBeforeResponse = false;
      response.on('close', () => {
        if (!response.writableEnded && !closedBeforeResponse) {
          closedBeforeResponse = true;
          state.abortedCount += 1;
          notifyWaiters();
        }
      });

      const queued = state.queue.shift() || {};
      const delay = queued.delay ?? (parsedBody.model === 'mock-delay-model'
        ? 10_000
        : Number(url.searchParams.get('delay') || 0));
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (closedBeforeResponse || response.destroyed) return;
        const status = queued.status ?? Number(url.searchParams.get('status') || 200);
        const isTranslation = !JSON.stringify(parsedBody).includes('data:image/');
        const content = queued.text ?? url.searchParams.get('text')
          ?? (isTranslation ? 'MOCK TRANSLATION RESULT' : 'MOCK OCR RESULT 12345');
        const output = queued.empty || url.searchParams.get('empty') === '1' ? '   ' : content;
        const result = status >= 400
          ? { error: { message: queued.error || 'Mock provider rejected request' } }
          : url.pathname.endsWith('/responses')
            ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] }
          : url.pathname.endsWith('/messages')
            ? { content: [{ type: 'text', text: output }] }
            : { choices: [{ message: { content: output } }] };
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result), () => {
          state.completedCount += 1;
          notifyWaiters();
        });
      }, delay);
      timers.add(timer);
    });
  });

  function waitFor(predicate, timeoutMs = 5000) {
    if (predicate(state)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Mock server condition timed out; state=${JSON.stringify({ requestCount: state.requests.length, abortedCount: state.abortedCount, completedCount: state.completedCount, transientFailures: state.transientFailures })}`));
      }, timeoutMs);
      const check = () => {
        if (!predicate(state)) return;
        clearTimeout(timeout);
        waiters.delete(check);
        resolve();
      };
      waiters.add(check);
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        state,
        waitFor,
        waitForRequestCount(count, timeoutMs) {
          return waitFor((current) => current.requests.length >= count, timeoutMs);
        },
        waitForAbortCount(count, timeoutMs) {
          return waitFor((current) => current.abortedCount >= count, timeoutMs);
        },
        async close() {
          for (const timer of timers) clearTimeout(timer);
          timers.clear();
          await new Promise((done) => {
            server.close(done);
            server.closeAllConnections?.();
          });
        }
      });
    });
  });
}

module.exports = { startMockServer };
