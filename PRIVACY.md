# OCR 文字识别助手隐私政策

更新日期：2026-08-07

## 数据处理

- 扩展只在用户主动开始截图识别后读取当前可见页面的选定区域。
- 选区截图会直接发送到用户选择并配置的第三方 OCR 或多模态服务商，用于返回识别文本。项目没有自建中转服务器。
- API Key、Secret 和服务商配置保存在本机 `chrome.storage.local`。默认配置导出会移除凭据。
- 最近的识别文本、服务商、语言、时间和来源站点 origin 可保存在本机历史中；截图本身、页面完整 URL、查询参数和片段不会写入历史。
- 无痕窗口中的识别结果不会保存到持久化历史。

第三方服务商会按照其自身条款、隐私政策和数据保留规则处理请求。用户应避免上传不应交给所选服务商处理的敏感信息。

## 用户控制

- 新安装用户首次上传截图前需要明确同意产品内披露。
- 用户可随时删除单条历史或清空全部历史。
- 用户可删除 API 配置、卸载扩展或通过浏览器清除扩展存储。
- 自定义接口只允许 HTTPS；本机开发接口仅允许 `localhost` 和 `127.0.0.1`。

## Limited Use Disclosure

Data accessed by the extension is used only to provide the user-requested OCR feature. It is not used for advertising, profiling, resale, or unrelated purposes. Human access is not provided by this project. Data sent to a user-selected third-party provider is governed by that provider's terms and privacy policy.

## 联系方式

问题或隐私请求可通过本项目的 GitHub Issues 提交。
