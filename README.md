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

- `background.js`：截图、Provider 路由、API 请求、取消和历史。
- `content.js`：页面选区、裁剪、进度和结果 UI。
- `provider-config.js`：Provider 存储映射、凭据校验、脱敏和模型迁移。
- `extension-runtime.js`：自定义域名授权与内容脚本按需注入。
- `background-core.js`：语言提示、百度语言映射、请求注册表和可取消历史写入。
- `request-runtime.js`：超时、重试、取消、响应校验和自定义接口请求契约。
- `history-store.js`：串行化的历史新增、修订、搜索、删除和保留策略。
- `capture-utils.js`：请求 ID 与截图缩放计算。
- `options.js` / `popup.js`：设置和扩展 Popup。
