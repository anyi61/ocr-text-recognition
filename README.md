# OCR文字识别助手 - 浏览器插件

一款强大的浏览器扩展，帮助你在禁止复制的网站上截取文字，通过AI模型进行OCR识别，轻松提取文字内容。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Chrome](https://img.shields.io/badge/chrome-%E2%9C%93-brightgreen.svg)
![Edge](https://img.shields.io/badge/edge-%E2%9C%93-brightgreen.svg)

## 功能特点

- 🎯 **截图选区识别** - 在页面上框选任意区域进行文字识别
- 🤖 **多AI模型支持** - 支持 Claude、GPT-4V、GLM-4V、百度OCR、阿里云OCR 等7种服务
- 💾 **多API自动保存** - 可同时配置多个API，灵活切换使用
- 📦 **配置导入导出** - 支持导出配置到JSON文件，换设备快速导入配置
- 📋 **一键复制** - 识别结果一键复制到剪贴板
- 📜 **识别历史记录** - 自动保存最近10次识别结果，支持快速查看和复制
- ⏱️ **进度显示** - 实时显示识别进度和已用时间，支持取消操作
- ⌨️ **快捷键支持** - `Ctrl+Shift+S` 快速启动截图识别
- ⚡ **快速响应** - 流畅的交互体验，ESC键取消截图
- 🔒 **隐私安全** - 截图仅在本地处理，API密钥安全存储
- 🛡️ **错误处理优化** - 完善的错误提示，网络问题友好提醒
- 🧹 **内存优化** - 页面卸载时自动清理资源，防止内存泄漏

## 支持的API提供商

| 提供商 | 类型 | 特点 | 获取地址 |
|-------|------|------|---------|
| **Claude** | 大模型 | 识别准确率最高 | [Anthropic](https://console.anthropic.com/) |
| **OpenAI GPT-4V** | 大模型 | 速度快，准确率高 | [OpenAI](https://platform.openai.com/) |
| **智谱AI GLM-4V** | 大模型 | 国产大模型，中文效果好 | [智谱AI](https://open.bigmodel.cn/) |
| **百度智能云OCR** | 专业OCR | 中文识别效果好，性价比高 | [百度云](https://console.bce.baidu.com/ai/) |
| **阿里云OCR** | 专业OCR | DashScope兼容模式，稳定可靠 | [阿里云](https://dashscope.console.aliyun.com/) |
| **通用OpenAI兼容** | 通用接口 | 支持硅基流动、DeepSeek等 | 自定义端点 |
| **自定义API** | 通用接口 | 支持任何OpenAI格式API | 自定义配置 |

## 安装方法

### 方式一：开发者模式安装（推荐）

1. 下载本项目的源代码
2. 打开 Chrome/Edge 浏览器，访问 `chrome://extensions/` 或 `edge://extensions/`
3. 开启右上角的「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择项目文件夹
6. 安装完成！插件图标会显示在浏览器工具栏

### 方式二：Chrome Web Store（待发布）

> 未来可能会发布到 Chrome Web Store，敬请期待。

## 使用指南

### 首次配置

1. 点击浏览器工具栏的插件图标
2. 点击右上角的设置图标（⚙️）
3. 选择你想使用的API提供商
4. 填入对应的API密钥
5. 点击「保存设置」

**注意**：你可以同时配置多个API，切换API时之前填写的信息会自动保留。

### 文字识别

1. 访问任意网页（包括禁止复制的网站）
2. 点击浏览器工具栏的插件图标
3. 点击「开始截图识别」按钮
4. 在页面上按住鼠标左键，拖拽框选需要识别的文字区域
5. 松开鼠标，等待识别完成
6. 在弹出的结果窗口中查看或复制识别到的文字

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+S` / `Cmd+Shift+S` (Mac) | **开始截图识别** - 无需点击插件图标 |
| `ESC` | 取消截图 |
| `鼠标拖拽` | 框选截图区域 |

> **提示**：可以在 Chrome 扩展管理页面的「键盘快捷键」设置中自定义快捷键

### 各API配置说明

#### Claude
- **API Key**: 从 [Anthropic Console](https://console.anthropic.com/) 获取
- **推荐模型**: Claude 3 Opus（最佳质量）

#### OpenAI
- **API Key**: 从 [OpenAI Platform](https://platform.openai.com/api-keys) 获取
- **推荐模型**: GPT-4o（推荐）

#### 智谱AI GLM-4V
- **API Key**: 从 [智谱AI开放平台](https://open.bigmodel.cn/usercenter/apikeys) 获取
- **推荐模型**: GLM-4V（推荐）

#### 百度智能云OCR
- **API Key**: 从 [百度智能云](https://console.bce.baidu.com/ai/) 获取应用API Key
- **Secret Key**: 同一应用的Secret Key

#### 阿里云 OCR
- **API Key**: 从 [阿里云DashScope](https://dashscope.console.aliyun.com/apiKey) 获取
- **推荐模型**: qwen-vl-max（推荐）

#### 通用OpenAI兼容接口
- **API端点**: 填入服务商提供的OpenAI兼容端点，如 `https://api.siliconflow.cn/v1/chat/completions`
- **模型名称**: 填入对应的视觉模型，如 `Qwen/Qwen2-VL-72B-Instruct`

## 项目结构

```
browser-extension-ocr/
├── manifest.json          # 扩展配置文件
├── popup.html/js/css      # 弹出窗口界面
├── content.js             # 内容脚本（截图选区逻辑）
├── background.js          # 后台服务（OCR请求处理）
├── options.html/js/css    # 设置页面
├── TODO.md                # 开发任务清单
├── icons/                 # 插件图标
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md              # 使用说明
```

## 技术栈

- **Manifest V3** - Chrome扩展最新架构
- **原生 JavaScript/HTML/CSS** - 无需构建工具
- **Chrome Extension API** - 浏览器功能调用

## 隐私声明

- 所有API密钥仅存储在浏览器本地，不会上传到任何服务器
- 截图仅在本地处理，只有用户主动发起识别请求时才会发送给AI服务商
- 插件不会收集任何用户数据或使用统计

## 注意事项

1. **API费用**: 使用 Claude、OpenAI 等API可能会产生费用，请留意各平台的计费标准
2. **网络要求**: 需要能够访问对应的API服务商（部分服务商可能需要代理）
3. **图片尺寸**: 百度OCR要求图片最小尺寸为15x15像素

## 故障排除

### 插件无法加载
- 确保开启了开发者模式
- 检查文件是否完整

### 截图失败
- 确保已授权截图权限
- 刷新页面后重试

### API连接失败
- 检查API密钥是否正确
- 确认网络可以访问API服务商
- 在设置页面点击「测试连接」检查

### 识别结果不准确
- 尝试选择更大的文字区域
- 更换识别模型（如Claude 3 Opus）
- 调整自定义提示词

## 更新日志

### v1.4.0 (2026-02-26)
- ✨ **新增配置导入导出** - 支持导出配置到JSON文件备份，换设备时可快速导入恢复配置
- 🛡️ **导入确认对话框** - 导入前显示配置详情，需用户确认后才覆盖当前配置

### v1.3.4 (2026-02-26)
- 🎨 **优化保存机制** - 移除「保存设置」按钮，统一使用自动保存，输入框失去焦点时自动保存并显示提示

### v1.3.3 (2026-02-26)
- 📝 **更新底部信息** - popup窗口底部现在显示全部7种支持的API提供商

### v1.3.2 (2026-02-26)
- 📖 **添加JSDoc类型定义** - 为所有代码添加完整的JSDoc注释，提升代码可维护性

### v1.3.1 (2026-02-26)
- 🐛 **修复智谱API调用** - 修复 GLM-4V 因不支持 `max_tokens` 参数导致的调用失败问题

### v1.3.0 (2026-02-25)
- ✨ **新增进度显示** - 实时显示识别进度和已用时间，支持取消识别操作
- ⏱️ **优化用户体验** - 识别完成显示总用时，进度通知带加载动画

### v1.2.0 (2026-02-25)
- ✨ **新增识别历史记录** - 自动保存最近10次识别结果，支持快速查看和复制
- 🛡️ **优化错误处理** - 完善API错误提示，网络问题友好提醒，非JSON响应正确处理
- 🧹 **修复内存泄漏** - 页面卸载时自动清理监听器，防止内存占用持续增长
- ⚡ **代码优化** - 提升稳定性和用户体验

### v1.1.0
- ✨ 新增快捷键支持 - `Ctrl+Shift+S` 快速启动截图
- ✨ 优化API配置保存逻辑

### v1.0.0
- ✨ 初始版本发布
- ✨ 支持7种API提供商
- ✨ 截图选区识别功能
- ✨ 多API自动保存和切换

## 开源协议

MIT License

---

**免责声明**: 本插件仅供学习交流使用，请遵守各网站的使用条款和相关法律法规。使用第三方AI服务时，请遵守相应平台的服务条款。
