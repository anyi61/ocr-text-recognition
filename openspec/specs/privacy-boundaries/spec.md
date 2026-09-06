# privacy-boundaries

## Purpose

上传告知与数据边界。2026-09-05 从现有实现补录的行为基线；不表示新增功能或所有场景均已手工验收。

## Requirements

### Requirement: 首次上传告知

新安装用户的页面识别流程 SHALL 在首次发送截图前展示服务商上传告知并等待明确同意；现有升级路径保留已使用用户的告知版本兼容处理。

#### Scenario: 拒绝上传

- **WHEN** 新安装用户在告知界面拒绝
- **THEN** 本次页面截图不发送给识别服务商

### Requirement: 无痕与历史最小化

系统 SHALL 避免将无痕标签页识别结果写入持久化历史；普通历史不保存图片 Base64，来源 URL 仅保留 origin。

#### Scenario: 无痕识别成功

- **WHEN** 无痕标签页完成识别
- **THEN** 结果可显示，但不持久化文字及来源元数据

### Requirement: 凭据访问边界

系统 SHALL 在浏览器支持时将本地存储访问限制为 TRUSTED_CONTEXTS，页面脚本通过消息取得所需主题与语言偏好。

#### Scenario: 页面需要偏好

- **WHEN** 框选 UI 初始化读取偏好
- **THEN** 后台仅通过偏好接口返回所需主题与界面语言，不向页面返回 API 配置

## Evidence

PRIVACY.md、background.js、background-core.js、background/recognition-service.js、background/message-handlers.js、content/notice-view.js、content/session.js、provider-config.js、options/config-transfer.js；tests/extension-static.test.js、tests/background-core.test.js、tests/background-message-contracts.test.js、tests/e2e/extension.spec.js。具体测试范围及本轮执行状态见 `../../README.md`。
