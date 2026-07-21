# OCR Extension Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复审查确认的安全边界、OCR 正确性、请求生命周期、历史事务、UI 注入与发布验证问题，使生产扩展具备可验证的安全默认值。

**Architecture:** 保持 MV3 service worker、按需注入 content script 和无框架页面结构。把可纯函数测试的解析、矩形计算、URL 策略和持久化容错放进现有共享模块；content script 只管理受信用户交互和单次捕获会话；后台负责标签页身份校验、私密存储与稳定错误代码。

**Tech Stack:** Chrome Extension Manifest V3、原生 JavaScript、Node.js test runner、Playwright Chromium。

## Execution Record

- 状态：2026-07-21 已实施并完成全量验证。
- `npm run check`：ESLint 通过，Node 测试 94/94 通过，Playwright E2E 10/10 通过。
- `npm run package`：成功生成 `dist/ocr-text-recognition-extension-1.1.0.zip`，归档仅含 27 个生产文件/目录项。
- `git diff --check`：通过；未创建 commit。

## Global Constraints

- 不引入运行时依赖，不做无关 UI 重构。
- 自定义远程端点只允许 HTTPS；HTTP 仅允许 `localhost` 和 `127.0.0.1`。
- OCR 成功结果不能因历史存储失败而丢失。
- API Key 与 OCR 历史限制为可信扩展上下文访问；content script 通过后台消息读取主题和语言偏好。
- 用户可见错误使用稳定错误代码映射到中英文文案。
- 本次不创建 Git commit，保留修改供用户审阅。

---

### Task 1: Secure capture session and screenshot identity

**Files:**
- Modify: `content.js`
- Modify: `background.js`
- Modify: `capture-utils.js`
- Test: `tests/capture-utils.test.js`
- Test: `tests/e2e/extension.spec.js`

**Interfaces:**
- Consumes: `OCRCaptureUtils.createRequestId()`。
- Produces: `resizeSelectionRect(originalRect, dragType, deltaX, deltaY, viewport, minSize)`；单次 `captureSessionId`；后台 `handleCapture` 的 sender-tab 前后校验。

- [ ] **Step 1: 写失败测试**

```javascript
test('west resize clamps at viewport edge without expanding past the fixed right edge', () => {
  assert.deepEqual(
    resizeSelectionRect({ left: 100, top: 50, width: 200, height: 100 }, 'w', 200, 0,
      { width: 1000, height: 700 }, 5),
    { left: 295, top: 50, width: 5, height: 100 }
  );
});
```

E2E 增加：页面合成的 mouse/keyboard 事件不能发起 OCR；真实鼠标加 Enter 可以完成；OCR 进行中 reload 会让 mock server 观察到 abort 且历史为空；发送给 provider 的 PNG 不包含进度浮层像素。

- [ ] **Step 2: 运行目标测试并确认失败**

Run: `node --test tests/capture-utils.test.js && npm run test:e2e -- --grep "trusted|reload|overlay"`

Expected: 新增断言在实现前失败。

- [ ] **Step 3: 实现安全会话**

```javascript
shadowRoot = shadowHost.attachShadow({ mode: 'closed' });

function isTrustedInteraction(event) {
  return Boolean(event?.isTrusted);
}

function invalidateCaptureSession({ cancelRequest = false } = {}) {
  const requestId = activeRequestId;
  captureSessionId = null;
  isProcessing = false;
  isCancelled = true;
  activeRequestId = null;
  if (cancelRequest && requestId) {
    chrome.runtime.sendMessage({ action: 'cancelOCR', requestId }).catch(() => {});
  }
}
```

所有 document 级 mouse/keyboard 入口拒绝非可信事件；确认时立即锁定会话、清空 `currentRect`；截图完成前不插入可见进度元素；`beforeunload/pagehide` 调用取消；`startCapture()` 同时检查捕获和处理锁。

- [ ] **Step 4: 校验截图标签身份**

```javascript
const [activeBefore] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
if (activeBefore?.id !== sender.tab.id) throw createCodedError('CAPTURE_TAB_CHANGED');
const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
const [activeAfter] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
if (activeAfter?.id !== sender.tab.id) throw createCodedError('CAPTURE_TAB_CHANGED');
```

- [ ] **Step 5: 运行单元与目标 E2E**

Run: `node --test tests/capture-utils.test.js && npm run test:e2e -- --grep "capture|cancel|reload|trusted"`

Expected: 全部通过，mock 收到的截图无扩展浮层，卸载会取消请求。

### Task 2: Correct provider parsing, completion validation and timeout policy

**Files:**
- Modify: `background-core.js`
- Modify: `background.js`
- Modify: `request-runtime.js`
- Modify: `provider-config.js`
- Modify: `manifest.json`
- Test: `tests/background-core.test.js`
- Test: `tests/provider-contracts.test.js`
- Test: `tests/request-runtime.test.js`
- Test: `tests/provider-config.test.js`

**Interfaces:**
- Produces: `extractClaudeText(data)`、`assertOcrResponseComplete(provider, data)`、`isAllowedEndpoint(endpoint)`。
- `fetchJsonWithPolicy` 的 `timeoutMs` 表示包含 fetch 和 retry delay 的总截止时间；`maxRetryDelayMs` 默认 5000。

- [ ] **Step 1: 写失败测试**

```javascript
test('Claude joins text blocks after thinking blocks', () => {
  assert.equal(extractClaudeText({ content: [
    { type: 'thinking', thinking: 'hidden' },
    { type: 'text', text: 'visible OCR' }
  ] }), 'visible OCR');
});

test('timeout aborts Retry-After sleep', async () => {
  await assert.rejects(
    fetchJsonWithPolicy(async () => new Response('', { status: 429, headers: { 'retry-after': '1' } }),
      { url: 'https://example.test' }, { timeoutMs: 10, maxAttempts: 2 }),
    (error) => error.code === 'REQUEST_TIMEOUT'
  );
});
```

端点测试覆盖远程 HTTP 拒绝、HTTPS 接受、localhost/127.0.0.1 HTTP 接受；响应测试覆盖 Claude `stop_reason=max_tokens` 和 Chat Completions `finish_reason=length`。

- [ ] **Step 2: 运行目标测试并确认失败**

Run: `node --test tests/background-core.test.js tests/provider-contracts.test.js tests/request-runtime.test.js tests/provider-config.test.js`

Expected: thinking block、Retry-After 和远程 HTTP 用例失败。

- [ ] **Step 3: 实现解析与完整性检查**

```javascript
function extractClaudeText(data) {
  return (Array.isArray(data?.content) ? data.content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function assertOcrResponseComplete(provider, data) {
  const truncated = provider === 'claude'
    ? data?.stop_reason === 'max_tokens'
    : data?.choices?.some((choice) => choice?.finish_reason === 'length');
  if (truncated) throw createCodedError('OCR_RESULT_TRUNCATED');
}
```

- [ ] **Step 4: 实现总截止时间与端点安全策略**

把 timeout controller 移到重试循环外，fetch 和 `waitForRetry` 都监听组合后的 request signal；将 Retry-After 截断至 `maxRetryDelayMs`。`getEndpointOriginPattern` 只为 HTTPS 或 loopback HTTP 返回权限模式，manifest 的 HTTP optional patterns 收窄到 loopback。

- [ ] **Step 5: 替换连接测试图片**

把纯蓝 PNG 替换为带高对比度大号 `OCR TEST` 字样的确定性 PNG；连接测试仍走真实 provider adapter，从而同时验证认证和响应契约。

- [ ] **Step 6: 运行 Provider 测试**

Run: `node --test tests/background-core.test.js tests/provider-contracts.test.js tests/request-runtime.test.js tests/provider-config.test.js`

Expected: 全部通过。

### Task 3: Make history persistence private and failure-tolerant

**Files:**
- Modify: `background-core.js`
- Modify: `background.js`
- Modify: `history-store.js`
- Modify: `i18n-runtime.js`
- Modify: `content.js`
- Test: `tests/background-core.test.js`
- Test: `tests/history-store.test.js`

**Interfaces:**
- Produces: `sanitizeSourceUrl(url)`、`appendHistoryBestEffort(store, record, signal)`；后台消息 `getContentPreferences`。
- OCR success response: `{ success: true, text, historyId: string|null, warningCode?: 'HISTORY_SAVE_FAILED' }`。

- [ ] **Step 1: 写失败测试**

```javascript
test('aborting after a full history write restores the exact pre-image', async () => {
  // storage aborts immediately after its first set
  await assert.rejects(store.append(newRecord, controller.signal), /AbortError/);
  assert.deepEqual(storage.snapshot(), originalFiftyRecords);
});

test('history failure preserves OCR success', async () => {
  const result = await appendHistoryBestEffort(failingStore, { text: 'paid result' });
  assert.deepEqual(result, { historyId: null, warningCode: 'HISTORY_SAVE_FAILED' });
});
```

- [ ] **Step 2: 运行目标测试并确认失败**

Run: `node --test tests/history-store.test.js tests/background-core.test.js`

Expected: 容量满回滚和 best-effort 用例失败。

- [ ] **Step 3: 实现精确回滚和 best-effort 持久化**

```javascript
const previousHistory = history.map((item) => ({ ...item }));
await storage.set({ ocrHistory: nextHistory });
if (signal?.aborted) {
  await storage.set({ ocrHistory: previousHistory });
  throwIfAborted(signal);
}
```

非 Abort 的 storage 错误转换为 warning；Abort 继续终止整个 OCR。历史 URL 仅保留 HTTP(S) origin，file URL 只保存 `file://`。

- [ ] **Step 4: 限制 storage 访问范围**

```javascript
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error);
```

content script 的主题与 UI 语言通过 `getContentPreferences` 消息读取；扩展页面仍直接使用 storage。

- [ ] **Step 5: 运行历史与 i18n 测试**

Run: `node --test tests/history-store.test.js tests/background-core.test.js tests/i18n-runtime.test.js`

Expected: 全部通过。

### Task 4: Remove UI injection and modal lifecycle bugs

**Files:**
- Modify: `popup.js`
- Modify: `options.js`
- Modify: `_locales/en/messages.json`
- Modify: `_locales/zh_CN/messages.json`
- Test: `tests/options-runtime.test.js`
- Test: `tests/history-ui-static.test.js`
- Test: `tests/i18n-options-static.test.js`

**Interfaces:**
- Produces: `OptionsRuntime.createModalLifecycle(...)`；稳定的 OCR/快捷键错误文案键。

- [ ] **Step 1: 写失败测试**

```javascript
test('modal lifecycle removes Escape listener exactly once on every close path', () => {
  const lifecycle = createModalLifecycle(fakeDocument, overlay, resolve, timerApi);
  lifecycle.close(false);
  lifecycle.close(true);
  assert.equal(fakeDocument.removeCalls, 1);
  assert.equal(resolveCalls, 1);
});
```

静态测试禁止将 `escapeHtml(...)` 插入 quoted attributes，要求历史文本、title、标签和来源使用 DOM 属性赋值。

- [ ] **Step 2: 运行目标测试并确认失败**

Run: `node --test tests/options-runtime.test.js tests/history-ui-static.test.js tests/i18n-options-static.test.js`

Expected: modal 和属性拼接测试失败。

- [ ] **Step 3: 实现安全 DOM 构建和一次性关闭**

历史条目只用静态 `innerHTML` 创建结构，再以 `textContent`、`title`、`aria-label` 写入动态值。Modal 的 `close()` 首先设置 closed 标记并移除 keydown listener，再安排动画移除和 resolve。

- [ ] **Step 4: 国际化运行时错误**

为 `MISSING_API_KEY`、`CAPTURE_TAB_CHANGED`、`REQUEST_TIMEOUT`、`EMPTY_OCR_RESULT`、`INVALID_OCR_RESULT`、`OCR_RESULT_TRUNCATED`、`HISTORY_SAVE_FAILED` 和快捷键通知添加中英文键；content/options 根据 `errorCode` 映射，后台 notification 使用 `chrome.i18n.getMessage()`。

- [ ] **Step 5: 运行 UI 测试**

Run: `node --test tests/options-runtime.test.js tests/history-ui-static.test.js tests/i18n-options-static.test.js tests/extension-static.test.js`

Expected: 全部通过且两份字典键完全一致。

### Task 5: Strengthen test and release gates

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `README.md`
- Create: `scripts/package-extension.mjs`
- Test: `tests/extension-static.test.js`
- Test: `tests/e2e/extension.spec.js`

**Interfaces:**
- `npm run check`: unit/static + E2E。
- `npm run package`: 校验三处版本一致，生成根目录含 manifest 的 `dist/ocr-text-recognition-extension-<version>.zip`。

- [ ] **Step 1: 添加失败的发布一致性测试**

```javascript
test('package, manifest and exported config versions stay aligned', () => {
  assert.equal(readJson('package.json').version, readJson('manifest.json').version);
  assert.match(read('options.js'), new RegExp(`version: '${readJson('package.json').version}'`));
});
```

- [ ] **Step 2: 实现可重复打包脚本和完整 check**

```json
{
  "scripts": {
    "test": "node --test tests/*.test.js",
    "test:e2e": "node scripts/run-e2e.mjs",
    "check": "npm test && npm run test:e2e",
    "package": "node scripts/package-extension.mjs"
  }
}
```

打包采用明确 allowlist，排除 tests、docs、`.git`、`.codegraph`、node_modules 和本地结果。README 增加 `npx playwright install chromium`、完整检查和打包命令。

- [ ] **Step 3: 增加真实设置页 E2E**

通过 options 页面填写 loopback compatible endpoint、API key、model 并保存，再读取 storage 验证；不再把设置页完全绕过。生产权限边界由 provider-config/extension-runtime 单元测试覆盖，临时 `<all_urls>` 仅保留用于 Playwright 无法模拟的工具栏授权。

- [ ] **Step 4: 运行发布检查**

Run: `npm test && npm run test:e2e && npm run package`

Expected: 测试无失败；ZIP 存在且解压根目录含 `manifest.json`，不含测试或文档。

### Task 6: Final verification and requirement audit

**Files:**
- Modify: `docs/superpowers/plans/2026-07-21-ocr-hardening.md`（勾选完成项）

- [ ] **Step 1: 完整验证**

Run: `npm run check`

Expected: Node 测试和全部 Playwright E2E 通过。

- [ ] **Step 2: 发布包验证**

Run: `npm run package && unzip -l dist/ocr-text-recognition-extension-1.1.0.zip`

Expected: 命令退出 0；归档根目录包含生产文件，不包含 `tests/`、`docs/`、`node_modules/`。

- [ ] **Step 3: 工作树和补丁检查**

Run: `git diff --check && git status --short`

Expected: `git diff --check` 无输出；状态只包含本计划内文件和生成的、已被忽略的 `dist/`。

- [ ] **Step 4: 对照原始审查逐项复核**

逐项确认：closed shadow、可信事件、会话锁、无截图浮层、卸载取消、标签身份、Claude thinking、截断检测、总超时、HTTPS/loopback、带字测试图、历史精确回滚、历史失败不吞 OCR、私密 storage、URL 脱敏、安全 DOM、modal listener、国际化、完整 check、设置页 E2E、可重复 ZIP。
