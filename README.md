# OCR文字识别助手（Chrome / Edge 扩展）

在网页中框选区域，将截图发送给用户选择的 OCR 或多模态服务，并把返回结果转换为可复制文本。

## 功能

- 框选后可移动、缩放、撤销、重新选择，再确认识别。
- 支持 Claude、OpenAI、百度 OCR、阿里云、智谱、OpenAI 兼容接口和自定义接口。
- 支持中文、英文、日文、韩文识别偏好。
- 支持中英文界面、浅色/深色主题和最近 10 条本地历史记录。
- `Ctrl + Shift + S`（macOS 为 `Cmd + Shift + S`）启动截图，`Esc` 取消。
- 取消识别会中止正在进行的网络请求，取消结果不会写入历史。

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
3. 在当前页面拖拽框选区域，按需调整后确认。
4. 等待识别完成，在页面结果弹窗中复制文字。
5. 可在扩展 Popup 中查看或清空最近 10 条历史。

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
- 自定义或 OpenAI 兼容接口按配置的域名单独请求权限，不会默认获得所有网站的网络权限。

API Key 保存在 `chrome.storage.local`，没有上传到本项目自己的服务器。截图内容会发送到当前选择的第三方服务商，适用其隐私和数据保留政策；请勿识别不应交给该服务商处理的敏感页面。

配置导出默认移除 API Key 和 Secret。只有主动勾选“在导出文件中包含 API Key”时才会导出明文凭据；此类文件应只存放在可信设备上。

## 开发与验证

需要 Node.js 20+：

```bash
npm install
npm run check
npm run test:e2e
```

- `npm run check`：运行 provider 映射、语言提示、取消竞态、截图缩放、manifest、语言包和 JavaScript 语法测试。
- `npm run test:e2e`：启动 Playwright Chromium 和本地 Mock OCR 服务，加载扩展后验证截图、裁剪、OCR、结果、历史记录与真实请求中止。
- 端到端测试不需要任何真实 API Key，也不会请求第三方 OCR 服务。

## 核心文件

- `background.js`：截图、Provider 路由、API 请求、取消和历史。
- `content.js`：页面选区、裁剪、进度和结果 UI。
- `provider-config.js`：Provider 存储映射、凭据校验、脱敏和模型迁移。
- `extension-runtime.js`：自定义域名授权与内容脚本按需注入。
- `background-core.js`：语言提示、百度语言映射、请求注册表和可取消历史写入。
- `capture-utils.js`：请求 ID 与截图缩放计算。
- `options.js` / `popup.js`：设置和扩展 Popup。
