# OCR Functional Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development when available. In this workspace the primary agent will use built-in Codex subagents, review every work package, and run each acceptance gate before integration.

**Goal:** Turn the extension from a single-shot viewport OCR tool into a reliable daily-use workflow by fixing the confirmed selection bugs, hardening image and Provider handling, making configurable endpoints truthful, and closing the result/history loop.

**Architecture:** Keep Manifest V3 and the build-free source layout. Extract only pure, testable helpers from the large content/background scripts; keep Chrome API orchestration in the existing entry points. Use bounded image normalization before messaging, a shared request/response runtime for Provider reliability, and a serialized history store for concurrent updates.

**Tech Stack:** Chrome Extension Manifest V3, browser JavaScript, `chrome.*` APIs, Node.js 20 test runner, Playwright Chromium.

## Global Constraints

- Preserve the existing build-free installation flow.
- Preserve current Claude, OpenAI, Baidu, Aliyun, Zhipu, OpenAI-compatible, and custom Provider configurations.
- Do not expose API credentials in logs, tests, fixtures, exports, or user-visible errors.
- Do not broaden checked-in host permissions; custom origins remain optional permissions.
- Every task must add or update an automated regression test.
- Each work package must pass its focused tests before integration.
- Final acceptance requires `npm run check`, `npm run test:e2e`, `git diff --check`, and a clean extension console during the E2E flow.

---

### Task 1: Selection editing and deterministic crop bounds

**Files:**
- Modify: `content.js`
- Modify: `capture-utils.js`
- Modify: `tests/capture-utils.test.js`
- Modify: `tests/e2e/extension.spec.js`

**Interfaces:**
- Produces: `OCRCaptureUtils.fitImageWithinLimits(width, height, limits)` returning `{ width, height, scale }`.
- Produces: `cropImage(dataUrl, rect)` returning a normalized PNG data URL.
- Preserves: `startCapture`, handle resizing, keyboard editing, undo, reselect, confirm, and cancel behavior.

- [x] **Step 1: Add failing selection and image-limit tests**

```javascript
test('fitImageWithinLimits preserves small images', () => {
  assert.deepEqual(
    fitImageWithinLimits(1200, 800, { maxEdge: 4096, maxPixels: 12_000_000 }),
    { width: 1200, height: 800, scale: 1 }
  );
});

test('fitImageWithinLimits scales high-DPI captures', () => {
  const result = fitImageWithinLimits(6000, 4000, {
    maxEdge: 4096,
    maxPixels: 12_000_000
  });
  assert.ok(result.width <= 4096);
  assert.ok(result.height <= 4096);
  assert.ok(result.width * result.height <= 12_000_000);
});
```

Extend E2E to drag the selected rectangle, resize one handle, undo once, and assert that the rectangle returns to the immediately previous state.

- [x] **Step 2: Run focused tests and record the expected failures**

Run:

```bash
node --test tests/capture-utils.test.js
npm run test:e2e -- --grep "moves and undoes"
```

Expected: helper export missing; selection rectangle does not move.

- [x] **Step 3: Bind and clean up the selection move listener**

In `enterEditMode`, bind the actual selection element:

```javascript
selectionBox.addEventListener('mousedown', onSelectionMouseDown);
```

In edit cleanup, remove it:

```javascript
selectionBox?.removeEventListener('mousedown', onSelectionMouseDown);
```

Set `box-sizing: border-box` so `getBoundingClientRect()` matches the intended crop boundary. Record the new rectangle after each completed drag/keyboard adjustment so one undo returns exactly one user action.

- [x] **Step 4: Normalize image dimensions and encoded size**

Implement `fitImageWithinLimits` with `maxEdge: 4096` and `maxPixels: 12_000_000`. In `cropImage`, render into the fitted dimensions and iteratively downscale while the Base64 payload exceeds 3 MiB. Reject images smaller than 15×15 physical pixels with an actionable localized message.

- [x] **Step 5: Run Task 1 acceptance**

Run:

```bash
node --test tests/capture-utils.test.js
npm run test:e2e -- --grep "selection|crop"
```

Expected: all focused tests pass and E2E verifies movement, resize, undo, and bounded output dimensions.

---

### Task 2: Provider request reliability and capture-window correctness

**Files:**
- Create: `request-runtime.js`
- Modify: `background.js`
- Modify: `background-core.js`
- Modify: `tests/background-core.test.js`
- Create: `tests/request-runtime.test.js`
- Modify: `tests/e2e/mock-server.js`
- Modify: `tests/e2e/extension.spec.js`

**Interfaces:**
- Produces: `OCRRequestRuntime.fetchJsonWithPolicy(fetchImpl, request, policy)`.
- Produces: `OCRRequestRuntime.normalizeOcrText(value)` returning a non-empty string or throwing `EMPTY_OCR_RESULT`.
- Produces: `getBaiduAccessToken(config, signal)` with an in-memory expiry-aware cache.
- Changes: `handleCapture(sendResponse, sender)` binds `captureVisibleTab` to `sender.tab.windowId`.

- [x] **Step 1: Add failing request-policy tests**

```javascript
test('retries one transient 503 then succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? new Response('busy', { status: 503 })
      : Response.json({ ok: true });
  };
  const result = await fetchJsonWithPolicy(fetchImpl, request, {
    timeoutMs: 1000,
    maxAttempts: 2,
    retryStatuses: [429, 502, 503, 504]
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test('rejects empty OCR output', () => {
  assert.throws(() => normalizeOcrText('   '), /EMPTY_OCR_RESULT/);
});
```

Add a timeout case and confirm caller cancellation remains distinguishable from timeout.

- [x] **Step 2: Run focused tests and record failures**

Run:

```bash
node --test tests/request-runtime.test.js
```

Expected: module missing.

- [x] **Step 3: Implement the request policy**

Use a 30-second default timeout, at most two attempts, exponential delay with `Retry-After` support, and retry only network-before-response plus 429/502/503/504. Abort immediately when the caller signal is cancelled. Return an actionable timeout message instead of a generic network error.

- [x] **Step 4: Bind screenshot capture to the sender window**

Change message routing to:

```javascript
if (request.action === 'captureVisibleTab') {
  handleCapture(sendResponse, sender);
  return true;
}
```

Call:

```javascript
chrome.tabs.captureVisibleTab(sender.tab?.windowId, {
  format: 'png',
  quality: 100
});
```

Reject requests without a valid sender tab.

- [x] **Step 5: Cache Baidu access tokens**

Cache by a non-logged credential fingerprint and expire 60 seconds before `expires_in`. Share an in-flight token promise so concurrent OCR calls do not request duplicate tokens. Remove failed promises from the cache.

- [x] **Step 6: Normalize every Provider response**

All Provider adapters must pass their extracted value through `normalizeOcrText`. Unknown custom response objects must produce an actionable schema error instead of `JSON.stringify(data)`. Main OCR and connection tests must reject empty output.

- [x] **Step 7: Run Task 2 acceptance**

Run:

```bash
node --test tests/background-core.test.js tests/request-runtime.test.js
npm run test:e2e -- --grep "retry|empty|cancel"
```

Expected: timeout, retry, cancellation, empty-result, and sender-window cases pass.

---

### Task 3: Truthful configurable Provider contract

**Files:**
- Modify: `provider-config.js`
- Modify: `options.html`
- Modify: `options.js`
- Modify: `_locales/zh_CN/messages.json`
- Modify: `_locales/en/messages.json`
- Modify: `tests/provider-config.test.js`
- Modify: `tests/extension-static.test.js`

**Interfaces:**
- Extends configurable Provider config with:
  - `requestMode: "chat-completions" | "responses"`
  - `authMode: "bearer" | "api-key" | "custom-header" | "none"`
  - `headerName?: string`
  - `responsePath?: string`
- Custom Provider model is optional.
- OpenAI-compatible Provider model remains required.
- API key is required only when `authMode !== "none"`.

- [x] **Step 1: Add failing dynamic-credential tests**

```javascript
test('custom provider accepts no-auth and no-model configuration', () => {
  assert.equal(hasRequiredCredentials({
    custom: {
      endpoint: 'http://localhost:11434/v1/chat/completions',
      authMode: 'none',
      requestMode: 'chat-completions'
    }
  }, 'custom'), true);
});

test('custom-header auth requires a header name and API key', () => {
  assert.equal(hasRequiredCredentials({
    custom: {
      endpoint: 'https://example.test/ocr',
      authMode: 'custom-header',
      headerName: '',
      apiKey: 'secret'
    }
  }, 'custom'), false);
});
```

- [x] **Step 2: Run focused tests and record failures**

Run:

```bash
node --test tests/provider-config.test.js
```

Expected: current static required-field logic rejects no-auth/no-model custom configuration.

- [x] **Step 3: Implement dynamic validation and migration defaults**

Default existing configs to `requestMode: "chat-completions"` and `authMode: "bearer"`. Preserve redaction of all credential-bearing fields. Validate custom header names against the HTTP token grammar and prohibit dangerous headers such as `Host`, `Origin`, and `Content-Length`.

- [x] **Step 4: Add settings controls and localized guidance**

Add request-mode and authentication-mode selects. Show the custom header name only for `custom-header`. Keep model optional only for Custom. Update help text so the supported contract is explicit instead of claiming arbitrary API compatibility.

- [x] **Step 5: Pass the extended config to background requests**

Save/import/export the new fields without leaking credentials. Task 2 consumes these values to build the correct header and parse the configured response path.

- [x] **Step 6: Run Task 3 acceptance**

Run:

```bash
node --test tests/provider-config.test.js tests/extension-static.test.js
```

Expected: legacy migration, no-auth local endpoint, Azure-style `api-key`, custom header, redaction, import, and export tests pass.

---

### Task 4: Editable result and serialized history store

**Files:**
- Create: `history-store.js`
- Modify: `background.js`
- Modify: `content.js`
- Modify: `popup.html`
- Modify: `popup.js`
- Modify: `popup.css`
- Modify: `_locales/zh_CN/messages.json`
- Modify: `_locales/en/messages.json`
- Create: `tests/history-store.test.js`
- Modify: `tests/e2e/extension.spec.js`

**Interfaces:**
- Produces: `OCRHistoryStore.create(storage, { limit: 50 })`.
- History record: `{ id, text, timestamp, provider, language, sourceUrl, sourceTitle }`.
- Background messages: `updateHistoryRecord`, `deleteHistoryRecord`, `exportHistory`.
- Successful `performOCR` returns `{ success: true, text, historyId }`.

- [x] **Step 1: Add failing serialized-history tests**

```javascript
test('concurrent appends preserve both records', async () => {
  const store = create(storage, { limit: 50 });
  await Promise.all([
    store.append({ text: 'A', timestamp: 1 }),
    store.append({ text: 'B', timestamp: 2 })
  ]);
  assert.deepEqual(
    (await store.list()).map((item) => item.text).sort(),
    ['A', 'B']
  );
});

test('updating a corrected result preserves metadata', async () => {
  const record = await store.append({
    text: 'teh',
    timestamp: 1,
    provider: 'baidu'
  });
  await store.updateText(record.id, 'the');
  assert.equal((await store.list())[0].text, 'the');
  assert.equal((await store.list())[0].provider, 'baidu');
});
```

- [x] **Step 2: Run focused tests and record failures**

Run:

```bash
node --test tests/history-store.test.js
```

Expected: module missing.

- [x] **Step 3: Implement serialized operations**

Use one internal promise queue for append, update, delete, and clear. Store raw timestamps and format dates in the current UI locale at render time. Retain at most 50 records.

- [x] **Step 4: Save corrected result text**

Return `historyId` from the OCR response. Add a localized “保存修改” action beside Copy/Close. Send `updateHistoryRecord` with the edited textarea value and show success/failure feedback.

- [x] **Step 5: Expand history controls**

Add search, single-record delete, and JSON export. Render Provider, language, and localized date. Do not store screenshot Base64 or credentials.

- [x] **Step 6: Run Task 4 acceptance**

Run:

```bash
node --test tests/history-store.test.js
npm run test:e2e -- --grep "corrected result|history"
```

Expected: edited text survives popup reopen, concurrent results are retained, search/delete/export operate on the intended records.

---

### Task 5: Initialization, restricted pages, and settings completeness

**Files:**
- Modify: `i18n-runtime.js`
- Modify: `content.js`
- Modify: `extension-runtime.js`
- Modify: `popup.js`
- Modify: `options.js`
- Modify: `_locales/zh_CN/messages.json`
- Modify: `_locales/en/messages.json`
- Modify: `tests/extension-runtime.test.js`
- Modify: `tests/extension-static.test.js`

**Interfaces:**
- Produces: `OCRExtensionRuntime.getUnsupportedPageReason(url)`.
- Produces: one shared `i18nReady` promise in the content script.
- Config import/export includes `theme` and `uiLanguage`.

- [x] **Step 1: Add failing initialization and restricted-page tests**

```javascript
test('classifies browser-internal pages before injection', () => {
  assert.equal(getUnsupportedPageReason('chrome://settings/'), 'browser_internal');
  assert.equal(getUnsupportedPageReason('https://example.com/'), null);
});
```

Add a static assertion that content capture awaits `i18nReady`.

- [x] **Step 2: Await i18n before first capture**

Initialize once:

```javascript
const i18nReady = OCRI18n.init().catch((error) => {
  console.error('i18n init failed in content script:', error);
});
```

The message listener must await it before `startCapture()`. `applyToDom` must update `document.documentElement.lang`.

- [x] **Step 3: Provide actionable restricted-page errors**

Detect `chrome:`, `edge:`, extension pages, the Chrome Web Store, and missing file-URL access before injection. Surface a localized explanation and the applicable next action.

- [x] **Step 4: Complete config portability and status timers**

Include `theme` and `uiLanguage` in import/export. Track and clear the previous status-message timer before scheduling another so stale timers cannot hide a new loading state.

- [x] **Step 5: Run Task 5 acceptance**

Run:

```bash
node --test tests/extension-runtime.test.js tests/extension-static.test.js
```

Expected: initialization ordering, page classification, locale parity, config portability, and timer behavior pass.

---

### Task 6: Provider contracts and production-like E2E

**Files:**
- Modify: `tests/e2e/mock-server.js`
- Modify: `tests/e2e/extension.spec.js`
- Create: `tests/provider-contracts.test.js`
- Modify: `scripts/run-e2e.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes all interfaces produced by Tasks 1–5.
- Produces no runtime API.

- [x] **Step 1: Add Provider contract fixtures**

For Claude, OpenAI, Baidu, Aliyun, Zhipu, OpenAI-compatible, and Custom, assert:

```javascript
assert.equal(request.method, 'POST');
assert.match(request.image, /^data:image\/png;base64,/);
assert.equal(normalizeResponse(providerFixture), expectedText);
```

Also cover official error shape, malformed JSON, empty text, timeout, 429 retry, and caller cancellation.

- [x] **Step 2: Expand E2E user journeys**

Add:

- Move → resize → undo → confirm.
- Oversized high-DPI selection is downscaled.
- First 503 retries and succeeds.
- Empty response shows failure and writes no history.
- Correct result → save → reopen popup → search → delete.
- Optional origin permission denied and granted.
- Restricted-page classification.

- [x] **Step 3: Document actual supported boundaries**

Update README with visible-viewport limits, configurable Provider request/auth modes, image normalization, retry policy, history metadata, restricted pages, and privacy behavior.

- [x] **Step 4: Run final acceptance**

Run:

```bash
npm run check
npm run test:e2e
git diff --check
git status --short
```

Expected: zero failures, zero syntax errors, no whitespace errors, and only intentional source/test/doc changes.

---

## Self-Review

- Spec coverage: confirmed selection defects, image limits, window binding, request reliability, response validation, Baidu token caching, custom Provider contract, editable results, concurrent history, i18n race, restricted pages, import/export completeness, and test blind spots all map to Tasks 1–6.
- Placeholder scan: no deferred implementation markers are present.
- Type consistency: Task 2 returns non-empty OCR text; Task 4 receives that text plus Provider/source metadata; Task 6 tests the same public message and storage shapes.
- Deliberate exclusions: full-page scrolling capture, PDF parsing, offline OCR, and table/coordinate OCR are larger product features. This plan stabilizes and completes the existing viewport OCR product first; those capabilities should be separate product plans after this acceptance gate.
