# OCR 扩展改进清单：问题 → 解决方案

> 基于 v1.1.0 代码审查整理，2026-08-07 已按实施顺序完成并验收。
> 范围：可维护性、工程化、体验、安全细节、测试缺口。
> 不包含已完成的 hardening（截图身份校验、closed shadow、isTrusted、凭据脱敏等）。

> **当前状态：清单已执行完成；P3-2 按原决策保持搁置。**

**状态约定**

| 标记 | 含义 |
|------|------|
| 待办 | 尚未开始 |
| 进行中 | 正在实现 |
| 已完成 | 已落地并通过验证 |
| 搁置 | 有意不做或延后 |
| 已合并 | 并入另一项实施，不再单独跟踪 |
| 部分合并 | 一部分随其它任务实施，剩余范围继续单独跟踪 |

**优先级**

| 级别 | 含义 |
|------|------|
| P0 | 结构与数据基础，后续改动依赖 |
| P1 | 可靠性、工程与发布质量 |
| P2 | 体验与产品能力 |
| P3 | 锦上添花，风险/收益较低 |

---

## P0 可维护性

### P0-1 核心文件过大，改动风险高

| 项 | 内容 |
|----|------|
| **状态** | 已完成（有边界例外） |
| **问题** | `content.js`（~1973 行）、`options.js`（~1166 行）、`background.js`（~853 行）职责混杂；改选区容易碰到结果 UI，改 Provider 容易碰到 capture 逻辑。 |
| **影响** | Code review 成本高、回归面大、并行开发困难。 |
| **解决方案** | 按职责拆文件，保持零构建：<br>1. `background/`：消息分发与捕获编排分离；Provider 文件拆分由 P0-3 完成<br>2. `content/`：选区状态机、裁剪、结果 UI、通知、样式分别成模块；重建 UI 时，动态翻译统一使用 `textContent`/属性赋值<br>3. `options/`：配置表单、校验、导入导出、状态展示分别成模块<br>4. 通过现有 `CONTENT_SCRIPT_FILES` / `importScripts` 按确定顺序加载<br>5. P2-2、P3-1 与 P3-3 的 content 范围随本项完成 |
| **实施 checkpoints** | **C1 Background**：拆出 handlers（含 P3-1）→ 目标测试 → 完整 `npm run check`。<br>**C2 Content**：拆选区、裁剪、结果、通知、样式，并移除动态翻译 `innerHTML`（含 P2-2、P3-3 content 范围）→ 目标测试 → 完整 `npm run check`。<br>**C3 Options**：拆表单、校验、导入导出、状态展示 → 目标测试 → 完整 `npm run check`。<br>任一 checkpoint 未通过，不进入下一个。 |
| **验收标准** | 每个模块有单一职责；原则上单文件 < ~400 行，超出时记录边界理由；动态注入与 Service Worker 加载顺序有静态测试；package allowlist 已更新；目标测试及完整 `npm run check` 全绿。 |
| **涉及文件** | `content.js`、`background.js`、`options.js`、`extension-runtime.js`、`scripts/package-extension.mjs`、`manifest` 相关引用 |
| **实施结果** | Background 已拆为 394 行编排层、Provider runtime/registry 和消息 router；Content 样式拆至 323 行模块，公共裁剪/尺寸纯函数保留在 `capture-utils.js`；Options/Popup 的纯运行时 helper 已拆出。`content.js` 与 `options.js` 的 DOM 事件闭包仍超过 400 行：这些状态均与单一页面生命周期绑定，继续拆分会引入跨模块可变状态和更大的回归面，因此作为已记录的边界例外保留。加载顺序、打包 allowlist 和 E2E 均已覆盖。 |

---

### P0-2 新旧配置双轨读取，分支重复

| 项 | 内容 |
|----|------|
| **状态** | 已完成 |
| **问题** | `handleOCR`、快捷键启动、`options` 加载同时读取 `apiConfigs` 与大量 legacy 字段（`apiKey`、`openaiApiKey`、`baiduApiKey` 等）。逻辑已部分集中在 `provider-config.js`，但调用点仍复制粘贴。 |
| **影响** | 漏改一处导致“设置页保存了但识别仍用旧 key”；代码噪音大。 |
| **解决方案** | 1. 在 `provider-config.js` 实现幂等 `migrateLegacyConfigOnce(storage)`：现代字段优先，legacy 仅填补缺失字段<br>2. 先写入并读回验证 `apiConfigs`，成功后再删除 legacy key；写入失败时保留原数据<br>3. 安装/升级与所有运行时配置读取共用一个迁移 Promise，避免升级后立即触发快捷键或 OCR 的竞态<br>4. 运行时只读 `apiConfigs` + 公共字段；旧导出文件在导入边界转换为新结构 |
| **验收标准** | 覆盖 legacy-only、部分新 + 部分旧、现代值优先、重复执行、写入失败不删旧值、旧导出导入；迁移完成后存储只剩新结构；`background.js`/`options.js`/`popup.js` 无散落 legacy 字段列表；目标测试及完整 `npm run check` 通过。 |
| **涉及文件** | `provider-config.js`、`background.js`、`options.js`、`popup.js`、`tests/provider-config.test.js` 及相关运行时测试 |

---

### P0-3 Provider 适配器用 switch 堆叠，扩展成本高

| 项 | 内容 |
|----|------|
| **状态** | 已完成 |
| **问题** | `background.js` 内 `switch (provider)` 分发 7 个 `callXxxAPI`，识别与连接测试路径不统一。 |
| **影响** | 新增/修改服务商要改多处；契约测试与实现易漂移。 |
| **解决方案** | 统一适配器接口：<br>`{ id, normalizeConfig(config), recognize(image, config, signal), interpretConnectionError?(error) }`<br>用注册表 `adapters[provider]` 替代识别与连接测试中的 switch；连接测试默认调用同一个 `recognize`，百度 `216630` 等特殊语义留在对应适配器。 |
| **验收标准** | 未知 Provider 返回稳定错误；新增 Provider 只需新增适配器文件、注册与契约测试；识别和连接测试使用同一注册表；`provider-contracts.test.js` 覆盖端点、鉴权、空结果、截断、取消和 Provider 特殊连接语义；完整 `npm run check` 通过。 |
| **涉及文件** | `background.js`、新建 `providers/*`、`tests/provider-contracts.test.js` |

---

## P1 工程与发布

### P1-1 缺少持续集成（CI）

| 项 | 内容 |
|----|------|
| **状态** | 已完成 |
| **问题** | 无 `.github/workflows`；质量门禁依赖本机 `npm run check`。 |
| **影响** | PR/push 可能带入 lint 失败或回归；协作者无法自动验证。 |
| **解决方案** | 增加 GitHub Actions，并在结构重构前落地：<br>1. **unit job（每次 PR/push）**：`npm ci` → `npm run lint` → `npm test`<br>2. **e2e job（每次 PR/push）**：`npm ci` → `npx playwright install --with-deps chromium` → `npm run test:e2e`<br>3. 使用 concurrency 取消同分支旧任务；在 GitHub 分支规则中把两个 job 设为必需检查 |
| **验收标准** | 正常提交两个 job 均通过；lint、单测或 E2E 任一故意失败时对应 job 阻止合并；CI 不依赖真实 Provider 密钥；README 是否增加徽章不作为门禁。 |
| **涉及文件** | `.github/workflows/ci.yml`、`README.md` |

---

### P1-2 版本号多处手写，易不一致

| 项 | 内容 |
|----|------|
| **状态** | 已完成 |
| **问题** | `package.json`、`manifest.json`、`options.js` 的 export `version` 三处维护；打包脚本会校验，但改版仍靠人工同步。 |
| **影响** | 发版漏改导致 `npm run package` 失败或商店版本与导出配置不一致。 |
| **解决方案** | 单一发布源：`package.json.version`<br>1. 导出配置通过 `chrome.runtime.getManifest().version` 获取运行版本，删除 `options.js` 的版本字面量<br>2. 提供 `npm run version:sync`，只同步 `package.json.version` → `manifest.json.version`<br>3. `npm run package` 先执行同步/一致性检查，再打包；不使用正则改写业务 JS |
| **验收标准** | 只改 `package.json` 即可发版；导出配置版本等于运行中 manifest 版本；重复执行 sync 不产生 diff；package 测试覆盖同步、一致性失败和打包文件名。 |
| **涉及文件** | `package.json`、`manifest.json`、`options.js`、`scripts/package-extension.mjs`、`tests/package-extension.test.js` |

---

### P1-3 实施计划文档状态混乱

| 项 | 内容 |
|----|------|
| **状态** | 已完成 |
| **问题** | [历史加固计划](archive/plans/2026-07-21-ocr-hardening.md) 的执行记录写“已实施”，步骤 checkbox 仍为未勾选，易被当成未完成任务；另外两份现有 plan 已基本勾选。 |
| **影响** | 后续 agent/人误读优先级，重复劳动。 |
| **解决方案** | 1. 为 `2026-07-21-ocr-hardening.md` 增加明确的完成状态与完成日期，并将已执行步骤勾选<br>2. 保留执行记录中的实际验证数字，不重写历史结果<br>3. 本清单作为改进总入口；进入实施的批次仍可建立独立 plan，并从本清单链接过去 |
| **验收标准** | 三份现有 plan 的状态与 checkbox 一致；本清单和独立实施 plan 之间有单一、可追踪的状态来源。 |
| **涉及文件** | [历史加固计划](archive/plans/2026-07-21-ocr-hardening.md)、本清单 |

---

### P1-4 Service Worker 长请求边界

| 项 | 内容 |
|----|------|
| **状态** | 已完成 |
| **问题** | Chrome 可能终止等待 `fetch()` 响应超过 30 秒的扩展 Service Worker；当前应用请求超时同样为 30 秒，存在浏览器终止与应用主动超时之间的竞态。百度 token 内存缓存随 Worker 重启丢失属于可接受的性能退化。 |
| **影响** | 极慢 Provider 可能出现不稳定的静默中断，用户收到的错误也可能不一致。 |
| **解决方案** | 1. 将应用总截止时间调整为低于浏览器边界并留出余量，例如 25–28 秒<br>2. 增加接近截止时间成功、超过截止时间返回 `REQUEST_TIMEOUT`、用户取消优先于超时的测试<br>3. 不引入 `chrome.alarms` 或持续 keep-alive；保持 Worker 可重启，关键状态继续放在持久化存储 |
| **验收标准** | 慢响应在应用截止时间内成功；超时稳定返回 `REQUEST_TIMEOUT`，取消稳定返回取消语义；无静默丢结果；目标测试与 E2E 通过。 |
| **涉及文件** | `request-runtime.js`、`background.js`、`tests/request-runtime.test.js`、`tests/e2e/*` |
| **依据** | [Chrome Extension Service Worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) |

---

## P2 体验与产品

### P2-1 Popup 历史读取与写入路径不一致

| 项 | 内容 |
|----|------|
| **状态** | 已完成 |
| **问题** | 写历史走 background + `history-store` 串行队列；popup 读历史直接 `storage.local.get`。 |
| **影响** | 多数场景可用；多窗口/并发修订时可能短暂不一致，也绕过统一 list API。 |
| **解决方案** | 1. Background 增加统一的 `listHistory` action，由 `historyStore.list()` 返回快照<br>2. Popup 初次加载和搜索刷新均通过 message 获取数据<br>3. Popup 监听 `chrome.storage.onChanged`；`ocrHistory` 变化时重新请求快照并保留当前搜索条件<br>4. 更新/删除/清空继续只通过 Background 写入 |
| **验收标准** | 识别完成、修订、删除或清空后，已打开的 Popup 自动显示最新列表；多个 Popup 实例最终一致；搜索条件在刷新后仍生效；单测覆盖过滤逻辑，E2E 覆盖外部写入触发刷新。 |
| **涉及文件** | `popup.js`、`background.js`、`history-store.js`、`tests/e2e/*` |

---

### P2-2 结果弹窗与 content 内联样式难维护

| 项 | 内容 |
|----|------|
| **状态** | 已合并至 P0-1 |
| **问题** | `content.js` 内大段 CSS 字符串（结果弹窗、通知等），与选区逻辑耦合。 |
| **影响** | 主题/间距微调成本高，无法单独 review 样式。 |
| **解决方案** | 作为 P0-1 的 content 模块拆分内容实施：抽到 `content/styles.js` 或独立 CSS 文本模块，由 closed shadow 注入。 |
| **验收标准** | 由 P0-1 统一验收：样式与逻辑分离，注入顺序有静态测试，视觉主路径 E2E 通过。 |
| **涉及文件** | `content.js`、新建 styles 模块 |

---

### P2-3 百度 OCR 能力偏基础，缺少模式选择

| 项 | 内容 |
|----|------|
| **状态** | 已完成 |
| **问题** | 固定 `general_basic`，复杂版面/手写场景可能偏弱。 |
| **影响** | 百度用户识别率上限受限。 |
| **解决方案** | 1. 在 `apiConfigs.baidu.mode` 保存枚举 `general_basic` / `accurate_basic` / `handwriting`，缺省为 `general_basic`<br>2. 在百度 adapter 内维护固定 endpoint map：`/rest/2.0/ocr/v1/general_basic`、`/rest/2.0/ocr/v1/accurate_basic`、`/rest/2.0/ocr/v1/handwriting`<br>3. 三种模式复用现有 API Key + Secret Key 换取和缓存 access token 的鉴权流程，以及 `application/x-www-form-urlencoded` 图片请求与公共错误解析<br>4. 设置页在百度 Provider 卡片中提供模式选择和简短用途说明 |
| **验收标准** | 默认配置仍请求 `general_basic`；三种 mode 分别命中固定 endpoint；未知 mode 在发请求前返回稳定配置错误；契约测试覆盖 endpoint、共享鉴权、响应 `words_result`、Provider 错误码和导入导出。 |
| **涉及文件** | `background.js`（或 baidu adapter）、`options.html/js`、`_locales/*`、`provider-contracts` 测试 |
| **依据** | 百度官方文档：[标准版](https://cloud.baidu.com/doc/OCR/s/zk3h7xz52)、[高精度版](https://cloud.baidu.com/doc/OCR/s/1k3h7y3db)、[手写文字识别](https://cloud.baidu.com/doc/OCR/s/hk3h7y2qq) |

---

### P2-4 费用与上传行为提示不足

| 项 | 内容 |
|----|------|
| **状态** | 已完成 |
| **问题** | 多模态/OCR 按次或按图计费，设置页与截图前缺少“会上传当前截图到所选服务商”的明确提示。 |
| **影响** | 用户对隐私与费用预期不清（README 有写，产品内偏弱）。 |
| **解决方案** | 1. 设置页每个 Provider 卡片固定显示“截图将上传至当前服务商，可能产生费用”的中英文提示<br>2. 新安装用户在 content 端完成选区后、发送 `performOCR` 前显示一次确认，确保 Popup、快捷键等入口共用同一门禁<br>3. 接受后写入 `uploadNoticeAcknowledgedVersion: 1`；取消时保留选区且不发送图片。提示内容发生实质变化时递增版本<br>4. 升级用户若该 key 不存在，由 update migration 写入当前版本，保持既有高频流程不中断；设置页固定提示仍对其可见 |
| **验收标准** | 新安装用户确认前无 OCR 网络请求；接受后仅提示一次；取消不上传且可继续操作；升级用户不弹窗；设置页固定提示始终可见；存储迁移、所有入口和中英文案均有测试。 |
| **涉及文件** | `options.html/js`、`content.js`、`background.js`（升级迁移）、`_locales/*`、相关运行时与 E2E 测试 |

---

### P2-5 快捷键可能与系统/其他扩展冲突

| 项 | 内容 |
|----|------|
| **状态** | 已完成 |
| **问题** | 默认 `Cmd/Ctrl+Shift+S` 在 macOS 等环境易冲突。 |
| **影响** | 用户以为扩展坏了，实际是快捷键被占用。 |
| **解决方案** | 1. 设置页新增“快捷键”区域，Popup footer 增加紧凑状态行<br>2. 两处都通过 `chrome.commands.getAll()` 查找 `start-capture` 并显示当前 shortcut<br>3. shortcut 为空时显示警告和 `chrome://extensions/shortcuts` 操作说明；不尝试替用户修改快捷键<br>4. 读取失败时显示普通说明，不把 API 错误误报成“快捷键冲突” |
| **验收标准** | 有 shortcut 时两处显示实际组合；空 shortcut 时显示明确警告和设置路径；API 失败时降级为说明文案；中英文案和 mock `commands.getAll()` 测试完整。 |
| **涉及文件** | `options.html/js`、`popup.html/js`、`_locales/*`、相关 UI 测试 |

---

## P3 安全与健壮性（可选）

### P3-1 消息处理为长 if 链，审计不便

| 项 | 内容 |
|----|------|
| **状态** | 已合并至 P0-1 |
| **问题** | `onMessage` 多个 `if (request.action === ...)`，未知 action 静默忽略但结构松散。 |
| **解决方案** | 随 P0-1 的 Background 模块拆分实现 `handlers` 注册表；公共 dispatch 统一未知 action、同步异常、Promise 拒绝和 `sendResponse` 形态。 |
| **验收标准** | 由 P0-1 统一验收；额外覆盖未知 action、同步异常和异步异常；新增 action 只需注册 handler。 |
| **涉及文件** | `background.js` |

---

### P3-2 未预置 sender 校验辅助函数

| 项 | 内容 |
|----|------|
| **状态** | 搁置 |
| **问题** | 当前无 `externally_connectable`，风险可控；若未来开放外部页面消息，缺少统一校验。 |
| **解决方案** | 当前不增加无调用方的辅助函数。未来若新增 `externally_connectable`、`onMessageExternal` 或网页桥接，必须单独立项并同时实现来源 allowlist、action allowlist、输入校验和回归测试。 |
| **验收标准** | 当前保持无外部消息入口；manifest 静态测试继续确认未声明 `externally_connectable`。若未来开放外部入口，未完成上述安全门禁不得合并。 |
| **涉及文件** | 当前仅维护 `manifest.json` 静态测试；未来外部消息立项再确定运行时文件 |

---

### P3-3 i18n 字符串拼进 innerHTML

| 项 | 内容 |
|----|------|
| **状态** | 已完成 |
| **问题** | 工具栏/通知等用模板字符串把 `OCRI18n.t(...)` 写入 `innerHTML`。文案本地可控，风险低，但翻译含 `"`/`</` 可能破坏 DOM。 |
| **解决方案** | `content.js` 范围随 P0-1 C2 完成；本项剩余范围仅为 `popup.js` 与 `options.js`。动态文案用 `textContent`/属性赋值，结构用 `createElement`，SVG 图标使用固定静态模板或 `<use>`。 |
| **验收标准** | P0-1 C2 结束时 content 无 `innerHTML + 动态翻译`；本项结束时 popup/options 同样满足；静态测试分别锁定三个入口，避免模块拆分后回退。 |
| **涉及文件** | `content.js`（由 P0-1 C2 处理）、`popup.js`、`options.js`、静态测试 |

---

### P3-4 Service Worker 休眠与长请求（已提升为 P1-4）

| 项 | 内容 |
|----|------|
| **状态** | 已合并至 P1-4 |
| **问题** | 原问题与方案已移动到工程可靠性批次，避免作为低优先级可选项延后。 |
| **解决方案** | 按 P1-4 实施；不使用 `alarms` 保护单次 OCR 请求。 |
| **验收标准** | 由 P1-4 统一验收。 |
| **涉及文件** | 见 P1-4 |

---

### P3-5 缺少静态类型检查

| 项 | 内容 |
|----|------|
| **状态** | 已完成 |
| **问题** | 仅有 JSDoc typedef，无编译期/编辑器强制检查。 |
| **解决方案** | 渐进：`jsconfig.json` + `// @ts-check` 关键模块；或后续轻量 TS，仍保持零运行时构建。 |
| **验收标准** | 至少 `provider-config` / `history-store` / `request-runtime` 通过 check；CI 可选加入。 |
| **涉及文件** | `jsconfig.json`、核心 `*.js` |
| **实施结果** | 增加 TypeScript 7 开发期检查、`jsconfig.json`、关键模块 `// @ts-check` 和 `npm run typecheck`；本地门禁及 CI unit job 均执行类型检查。 |

---

## 测试缺口（可并入上述项）

| ID | 问题 | 解决方案 | 优先级 |
|----|------|----------|--------|
| T-1 | `content` 选区/拖拽状态机测试偏少 | 纯函数继续下沉 `capture-utils`，状态机单测 + E2E 兜底 | 随 P0-1 |
| T-2 | `popup` 渲染/搜索几乎只靠 E2E | 抽过滤/格式化纯函数做单测 | P2 |
| T-3 | 无真实 Provider 冒烟 | 设为手工触发或发版前检查；显式选择 Provider，使用受保护 secret，默认 CI 不执行，失败不与本地回归混为一类 | P3 |
| T-4 | 导入导出/迁移边界可再加 | 覆盖 redacted import、legacy-only、部分新旧混合、坏 version、迁移写入失败 | 随 P0-2 |

---

## 建议实施顺序

```text
第 0 批（建立门禁）  P1-3 文档归档 → P1-1 CI
第 1 批（可靠性边界）  P1-4 Service Worker 长请求边界
第 2 批（配置收口）  P0-2 Legacy 配置一次迁移
第 3 批（后台边界）  P0-3 Provider 注册表
第 4 批（模块拆分）  P0-1 C1 Background → C2 Content → C3 Options
第 5 批（发布工程）  P1-2 版本单源
第 6 批（体验）  P2-1 历史同步 → P2-3/4/5 按产品需要
第 7 批（可选）  P3-3 剩余 popup/options → P3-5 与测试补强；P3-2 保持搁置
```

P1-4 提前到结构重构之前：它改动集中、验证独立，先消除 30 秒边界竞态，再扩大后台与 content 的重构面。

**批次验收门禁**

1. 每批开始前确认工作树基线与 `npm run check` 状态；基线失败先记录并处理，不把既有失败混入本批。
2. 每项先写能证明行为的失败测试，再做最小实现；纯文档项用状态一致性检查代替红绿测试。
3. 每项完成后运行目标测试；每批结束运行完整 `npm run check`、`npm run package` 和 `git diff --check`。
4. 检查打包 allowlist、manifest 权限和生产包内容；新增运行时依赖或权限必须单独决策。
5. 只有完整门禁通过后才更新本清单状态并进入下一批；失败时停在当前批次，记录失败命令与原因。

**原则（与历史 hardening 一致）**

- 不引入运行时依赖（除非明确决策改变）
- 行为变更需有测试证明
- 自定义远程端点继续 HTTPS-only（localhost HTTP 例外）
- API Key 不进历史/日志/默认导出

---

## 明确不在本清单内的项

| 项 | 原因 |
|----|------|
| 整页滚动截图 / PDF / 离线 OCR / 版面坐标 | README 已声明产品边界，属新产品能力，需单独立项 |
| 重写为 React/Vue 等框架 | 与零构建、扩展体量目标冲突，收益不明确 |
| 自建中转服务器 | 改变隐私模型与运维成本，需单独产品决策 |

---

## 跟踪表

| ID | 事项 | 状态 | 归属 / 下一步 |
|----|------|------|---------------|
| P1-3 | 计划文档归档 | 已完成 | 历史计划状态与 checkbox 已对齐 |
| P1-1 | CI | 已完成 | unit/typecheck/package 与 Chromium E2E 双 job |
| P1-4 | Service Worker 长请求边界 | 已完成 | 27 秒应用截止时间及回归测试 |
| P0-2 | Legacy 配置一次迁移 | 已完成 | 原子迁移、读回校验、失败保留旧值 |
| P0-3 | Provider 适配器注册表 | 已完成 | 单一 registry 路径和 Provider 契约测试 |
| P0-1 | 大文件拆分 | 已完成（有边界例外） | Provider、消息、样式、页面纯 helper 已拆分；页面状态闭包保留 |
| P2-2 | Content 样式抽离 | 已合并 | P0-1 C2 |
| P3-1 | 消息 handler 表 | 已合并 | P0-1 C1 |
| P3-3 | 减少动态 innerHTML | 已完成 | 三个入口的动态翻译均改为 DOM 属性赋值并有静态门禁 |
| P1-2 | 版本号单源 | 已完成 | package 源、sync/check 脚本、运行 manifest 导出版本 |
| P2-1 | Popup 历史一致性 | 已完成 | worker 快照 + storage change 刷新，保留搜索条件 |
| P2-3 | 百度识别模式 | 已完成 | 标准/高精度/手写固定 endpoint 与契约测试 |
| P2-4 | 费用/上传提示 | 已完成 | 设置页披露、首次同意门禁、隐私文档、无痕不落历史 |
| P2-5 | 快捷键说明 | 已完成 | Popup/Options 显示实际分配状态并处理 API 失败 |
| P3-2 | 外部 sender 安全门禁 | 搁置 | 开放外部消息入口时单独立项 |
| P3-4 | 长请求 SW 验证 | 已合并 | P1-4 |
| P3-5 | 渐进类型检查 | 已完成 | TypeScript checkJs 已纳入本地与 CI 门禁 |
