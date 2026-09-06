# OCR文字识别助手（Chrome / Edge 扩展）

在网页中框选区域，将截图发送给用户选择的 OCR 或多模态服务，并把返回结果转换为可复制文本。

## 功能

- 在当前可见网页区域框选后，可移动、缩放、撤销、重新选择，再确认识别。
- 裁剪图片会自动限制最长边、总像素和编码体积，避免高分辨率截图超过常见 OCR 接口限制。
- 请求默认 27 秒超时，为 Chrome Service Worker 的 30 秒 fetch 边界保留余量；网络失败或 429/502/503/504 会自动重试一次。用户取消会立即中止请求，取消结果不会写入历史。
- 支持 7 个服务商：Claude、OpenAI、百度 OCR、阿里云、智谱、OpenAI 兼容接口和自定义接口。
- 自定义接口支持 Chat Completions 与 Responses 请求格式，以及 Bearer、`api-key`、自定义 Header 或无需认证；可填写响应文本的点分路径。
- 支持中文、英文、日文、韩文识别偏好。
- 支持中英文界面、浅色/深色主题和最多 50 条本地历史记录。历史保存识别文本、时间、服务商、语言和来源页面元数据，可修订、搜索、单条删除和导出。
- `Ctrl + Shift + S`（macOS 为 `Cmd + Shift + S`）启动截图，`Esc` 取消。

扩展处理的是当前可见视口，不提供完整网页滚动截图、PDF 解析、离线 OCR 或表格/坐标版面识别。

## 安装

1. 打开 `chrome://extensions/` 或 `edge://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目目录。
5. 打开扩展设置页，选择服务商并填写 API 配置。

项目没有运行时构建步骤，可以直接加载源码目录。

## 架构与需求规划

本目录仅维护 OCR 扩展。银行卡活动项目已独立迁至同级 `../银行卡活动/`。历史实施文档见 [文档导航](docs/README.md)。

现有行为规格、架构设计与分阶段任务见 [OpenSpec 导航](openspec/README.md)。五阶段结构重构已完成并归档，Chrome 生产环境验收通过；Edge 本次按用户决定不验收。验证证据见 OpenSpec 导航。

## 使用流程

1. 点击扩展图标或使用快捷键。
2. 点击“开始截图识别”。
3. 在当前页面拖拽框选区域；可移动、缩放、撤销或重新选择后确认。
4. 等待识别完成，在页面结果弹窗中复制或修订文字并保存。
5. 在扩展 Popup 中查看、搜索、复制、删除、导出或清空本地历史。

Chrome、Edge 内部页面、扩展页面、Chrome Web Store 以及未开启文件网址访问权限的本地文件页面无法注入框选界面；扩展会在启动前提示可用的下一步操作。

## 默认模型

- Claude：`claude-sonnet-5`，也可选择 `claude-haiku-4-5-20251001` 或 `claude-opus-4-8`。
- OpenAI：`gpt-5-mini`，也可选择 `gpt-5.4-mini`。

模型输入框允许手工填写服务商支持的视觉模型。扩展会把已知的旧 Claude 3/3.5、GPT-4o 和 o1 preview/min 配置迁移到当前默认模型。

## 权限与隐私

- 扩展只在用户点击开始识别或触发快捷键后，向当前标签页注入框选界面。
- `activeTab` 和 `scripting` 用于用户触发后的截图和页面框选。
- `storage` 用于在本机 Chrome 配置中保存 API 配置、主题和最近历史。
- `notifications` 用于快捷键无法使用时显示原因。
- Anthropic、OpenAI、百度、阿里云和智谱的官方 API 域名在 manifest 中明确列出。
- 自定义或 OpenAI 兼容接口按配置的域名单独请求权限；远程地址强制使用 HTTPS，HTTP 仅允许 `localhost` 和 `127.0.0.1` 本机服务。

API Key 保存在 `chrome.storage.local`，并限制为扩展可信页面与后台访问，没有上传到本项目自己的服务器。截图内容会发送到当前选择的第三方服务商，适用其隐私和数据保留政策；请勿识别不应交给该服务商处理的敏感页面。凭据不会写入识别历史、运行日志或默认配置导出；历史也不保存截图 Base64，来源 URL 只保留站点 origin。

完整的数据处理说明见 [隐私政策](PRIVACY.md)。新安装用户首次发送截图前需要在扩展界面明确同意；无痕窗口中的识别结果不会写入持久化历史。

配置导出默认移除 API Key 和 Secret。只有主动勾选“在导出文件中包含 API Key”时才会导出明文凭据；此类文件应只存放在可信设备上。

## 开发与验证

需要 Node.js 20+：

```bash
npm install
npx playwright install chromium
npm run check
npm run package
```

- `npm run check`：依次运行全部单元/静态测试和 Playwright 端到端测试。
- `npm run lint`：检查未定义变量、不可达代码、重复分支和恒定表达式等 JavaScript 错误。
- `npm run test:e2e`：启动 Playwright Chromium 和本地 Mock OCR 服务，加载扩展后验证截图、裁剪、OCR、结果、历史记录与真实请求中止。
- `npm run package`：校验 `package.json`、manifest 与配置导出版本一致，并在 `dist/` 生成只包含生产文件的商店 ZIP。
- 端到端测试不需要任何真实 API Key，也不会请求第三方 OCR 服务。

## 核心文件

| 区域 | 职责与状态所有者 |
|---|---|
| `background.js` | 加载依赖、组装实例、安装迁移和快捷键监听 |
| `background/capture-service.js`、`recognition-service.js`、`message-handlers.js` | 截图身份校验；识别/取消/历史编排；兼容消息响应 |
| `providers/registry.js`、`transport.js`、七个服务商模块 | 配置标准化与路由；共用请求策略；服务商协议和解析，百度实例持有 token 缓存 |
| `content.js`、`content/session.js` | 注入幂等和平台监听；会话 ID、请求 ID、UI 生命周期及销毁 |
| `content/selection.js`、`capture-pipeline.js` | 选区几何和撤销栈；截图、裁剪与识别流水线 |
| `content/notice-view.js`、`result-view.js`、`styles.js` | 上传告知/进度；安全显示、复制和修订；样式 |
| `options.js`、`options/controller.js` | 页面启动；初始化、事件订阅和清理 |
| `options/provider-form.js`、`config-transfer.js`、`runtime.js` | 字段和保存状态；导入导出/确认框；纯 helper 和对话框生命周期 |
| `popup.js`、`popup/controller.js`、`history-view.js`、`runtime.js` | 页面启动；捕获入口/历史订阅；列表、搜索和操作；纯 helper |
| `provider-config.js` | 存储映射、凭据校验、脱敏和兼容迁移 |
| `extension-runtime.js` | 自定义域名授权与内容脚本按需注入 |
| `background-core.js`、`background-message-router.js` | 后台纯 helper、请求注册表；消息分派与异常兜底 |
| `request-runtime.js`、`history-store.js` | 请求超时、重试与取消；本地历史串行写入及保留上限 |
| `capture-utils.js`、`i18n-runtime.js` | 截图计算与请求 ID；字典和界面语言 |

加载顺序为公共 helper → 视图/适配器 → controller/service → 入口组装。后台通过 `importScripts`、页面通过 HTML、内容脚本通过 `CONTENT_SCRIPT_FILES` 明确加载。配置和历史继续使用本机存储，无运行时构建或框架依赖。
