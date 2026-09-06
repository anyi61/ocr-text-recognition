# OCR Reliability Hardening Implementation Plan

> 历史计划：2026-09-06 整理归档。以下要求和验证数字仅记录当时实施情况；当前规格、架构与验收状态见 [OpenSpec 导航](../../../openspec/README.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 修复配置识别、语言选择、请求取消、模型默认值、密钥导出、权限范围和可维护性问题，并通过自动化浏览器端到端验收。

**Architecture:** 保留 Manifest V3 原生扩展形态，将 provider 配置映射、请求构造和取消协议提炼成可独立测试的纯函数。内容脚本用 `requestId` 管理一次识别会话，后台用 `AbortController` 中止真实网络请求。端到端测试加载未打包扩展，通过本地模拟 OpenAI 兼容服务验证配置、框选、截图、OCR、结果和历史记录。

**Tech Stack:** Chrome Extension Manifest V3、原生 JavaScript、Node.js `node:test`、Playwright/Chromium、本地 HTTP mock server。

## Global Constraints

- 所有问题逐步验收；每一任务必须有独立验证命令。
- 使用子代理并行处理互不冲突的文件组，主代理负责接口和最终集成。
- API Key 默认不进入配置导出文件，用户主动确认后才可包含。
- OCR 的取消操作必须中止后台网络请求，且取消结果不得写入历史。
- 不依赖真实第三方 API Key 完成自动化验收。
- 保持解压加载扩展的使用方式，不引入运行时框架。

---

### Task 1: 配置映射与安全导出

**Files:**
- Create: `provider-config.js`
- Modify: `manifest.json`
- Modify: `popup.html`
- Modify: `options.html`
- Modify: `popup.js`
- Modify: `options.js`
- Modify: `_locales/en/messages.json`
- Modify: `_locales/zh_CN/messages.json`
- Test: `tests/provider-config.test.js`

**Interfaces:**
- Produces: `OCRProviderConfig.getStorageKey(provider): string`
- Produces: `OCRProviderConfig.getProviderConfig(apiConfigs, provider): object`
- Produces: `OCRProviderConfig.hasRequiredCredentials(apiConfigs, provider, legacy): boolean`
- Produces: `OCRProviderConfig.redactApiConfigs(apiConfigs): object`

- [x] **Step 1: 写 provider 映射失败测试**

  覆盖 `openai-compatible -> openaiCompatible`、百度双凭据、自定义 endpoint/model/key 校验和旧版 Claude key。

- [x] **Step 2: 运行测试并确认旧实现失败**

  Run: `node --test tests/provider-config.test.js`
  Expected: FAIL，因为模块尚不存在或兼容 provider 无法解析。

- [x] **Step 3: 实现共享 provider 配置模块**

  模块使用浏览器全局导出，并同时支持 `module.exports`，以便扩展页面和 Node 测试共用。

- [x] **Step 4: 接入 Popup、Options 和快捷键前置检查**

  Popup 与设置页加载 `provider-config.js`；后台在 Task 4 接入同一映射。

- [x] **Step 5: 改造导出**

  默认导出 `redactApiConfigs()` 结果；增加“包含 API Key”显式复选框和风险提示。导入继续兼容旧版明文配置。

- [x] **Step 6: 验收**

  Run: `node --test tests/provider-config.test.js && node --check popup.js && node --check options.js`
  Expected: PASS。

### Task 2: 内容脚本请求生命周期与模块拆分

**Files:**
- Create: `capture-utils.js`
- Modify: `content.js`
- Modify: `manifest.json`
- Test: `tests/capture-utils.test.js`

**Interfaces:**
- Produces: `OCRCaptureUtils.createRequestId(): string`
- Produces: `OCRCaptureUtils.computeCropScale(imageWidth, imageHeight, viewportWidth, viewportHeight): {x:number,y:number}`
- Content/background protocol: `performOCR { requestId, imageData }`
- Content/background protocol: `cancelOCR { requestId }`

- [x] **Step 1: 写请求 ID 和缩放计算测试**

- [x] **Step 2: 运行测试并确认失败**

  Run: `node --test tests/capture-utils.test.js`
  Expected: FAIL。

- [x] **Step 3: 实现工具模块并接入裁剪**

  使用截图实际尺寸与 viewport 比例分别计算 X/Y 缩放，不再假设 DPR 等于截图比例。

- [x] **Step 4: 接入取消协议**

  内容脚本在请求前生成 `requestId`；取消按钮发送 `cancelOCR`。取消后不展示结果。

- [x] **Step 5: 修复重复注入保护**

  IIFE 开头检查并设置 `window.ocrCaptureInitialized`；快捷键动态注入时保证先加载 i18n 和共享依赖。

- [x] **Step 6: 验收**

  Run: `node --test tests/capture-utils.test.js && node --check content.js`
  Expected: PASS。

### Task 3: 测试基础和端到端场景

**Files:**
- Create: `package.json`
- Create: `tests/extension-static.test.js`
- Create: `tests/e2e/extension.spec.js`
- Create: `tests/e2e/mock-server.js`
- Create: `scripts/run-e2e.mjs`

**Interfaces:**
- Consumes: provider module和 `performOCR/cancelOCR` 消息协议。
- Produces: `npm test`、`npm run test:e2e`、`npm run check`。

- [x] **Step 1: 建立静态清单测试**

  验证 manifest、脚本顺序、locale 键一致、所有 JS 可解析、敏感权限和资源声明符合预期。

- [x] **Step 2: 建立浏览器 E2E**

  加载扩展，打开本地测试页，写入 mock OpenAI-compatible 配置，触发截图，框选并确认，验证结果弹窗和历史记录。

- [x] **Step 3: 增加取消 E2E**

  mock 服务延迟响应，点击取消，验证请求断开、页面无结果、历史无新增。

- [x] **Step 4: 验收测试脚本本身**

  Run: `npm run check`
  Expected: 静态和单元测试可运行；核心代码未完成前允许行为断言失败，Task 5 必须全绿。

### Task 4: 后台请求、语言与模型集成

**Files:**
- Modify: `background.js`
- Modify: `manifest.json`
- Modify: `options.html`
- Modify: `README.md`
- Test: `tests/background-core.test.js`

**Interfaces:**
- Consumes: `OCRProviderConfig.getProviderConfig()`
- Consumes: `performOCR.requestId` 和 `cancelOCR.requestId`
- Produces: `buildRecognitionPrompt(prompt, language): string`
- Produces: requestId -> AbortController 生命周期。

- [x] **Step 1: 写语言提示和取消测试**

  覆盖 auto/zh/en/ja/ko，取消后抛出标准 `AbortError`，取消请求不保存历史。

- [x] **Step 2: 运行测试并确认失败**

  Run: `node --test tests/background-core.test.js`
  Expected: FAIL。

- [x] **Step 3: 实现语言生效**

  对多模态 provider 将识别语言约束合并进 prompt；百度 OCR 将语言映射到 `language_type`。

- [x] **Step 4: 实现真实请求中止**

  `apiRequest` 和百度两段 fetch 接收 signal；`cancelOCR` 调用对应控制器并清理 map；只有成功且未取消的请求保存历史。

- [x] **Step 5: 更新模型列表**

  移除已弃用 Claude 3/3.5 与 OpenAI o1 preview/min；保留质量和经济两个视觉模型角色。模型字段允许手工输入，避免再次硬编码锁死。

- [x] **Step 6: 收窄权限**

  内容脚本继续按需覆盖普通网页；删除无需的 `web_accessible_resources`，评估并删除重复权限。保留第三方 API 所需 host 权限并在 README 解释。

- [x] **Step 7: 验收**

  Run: `npm test`
  Expected: 所有单元和静态测试 PASS。

### Task 5: 最终端到端验收

**Files:**
- Modify: `README.md`
- Modify: 本计划复选框

- [x] **Step 1: 全量静态检查**

  Run: `npm run check`
  Expected: exit 0，0 failures。

- [x] **Step 2: 浏览器主流程**

  Run: `npm run test:e2e`
  Expected: 配置、框选、OCR、复制结果/历史场景 PASS。

- [x] **Step 3: 浏览器取消流程**

  Run: `npm run test:e2e`
  Expected: 延迟请求被中止，无结果、无历史新增。

- [x] **Step 4: 工作树与权限复核**

  Run: `git diff --check && git status --short`
  Expected: 无空白错误；只包含本任务文件和 CodeGraph 本地索引。

- [x] **Step 5: 更新 README**

  写明配置存储、导出密钥风险、页面截图会发送到所选服务商、权限用途和自动化验证命令。

## Self-Review

- Spec coverage: 七类问题分别由 Task 1–4 覆盖，Task 5 完成全量验收。
- Placeholder scan: 无 TBD/TODO/“稍后实现”。
- Type consistency: `provider-config.js`、`capture-utils.js` 和消息协议在生产与测试中共用相同名称。
