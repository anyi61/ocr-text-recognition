# ocr-providers

## Purpose

识别服务与请求策略。2026-09-05 从现有实现补录的行为基线；不表示新增功能或所有场景均已手工验收。

## Requirements

### Requirement: 服务商统一路由

系统 SHALL 支持 claude、openai、baidu、aliyun、zhipu、openai-compatible、custom 七个 ID，识别和连接测试复用注册表与识别实现。

#### Scenario: 未知服务商

- **WHEN** 请求指定未注册 Provider ID
- **THEN** 返回 UNKNOWN_PROVIDER 错误

### Requirement: 有限重试与取消

请求运行时 SHALL 默认采用 27000 毫秒超时预算，覆盖一次 fetchJsonWithPolicy 调用及其重试等待；网络错误或 429/502/503/504 最多再尝试一次，支持取消。

#### Scenario: 超时或主动取消

- **WHEN** 请求触发预算超时或调用者取消
- **THEN** 分别返回 REQUEST_TIMEOUT 或取消语义，结束该调用；此预算不表示包含百度取 token 等多个调用的整条 OCR 总时长

### Requirement: 可配置接口契约

自定义接口 SHALL 支持 Chat Completions 与 Responses 请求模式以及 Bearer、api-key、自定义 Header、无认证模式，并允许指定响应文本路径。

#### Scenario: 配置自定义响应路径

- **WHEN** 配置有效路径且响应中包含文本
- **THEN** 按该路径返回标准化文本；空内容或无效响应报告错误

## Evidence

providers/registry.js、providers/transport.js、providers/{claude,openai,openai-compatible,custom,baidu,aliyun,zhipu}.js、request-runtime.js、background/recognition-service.js；tests/provider-adapters.test.js、tests/provider-contracts.test.js、tests/provider-modules.test.js、tests/request-runtime.test.js、tests/background-message-contracts.test.js。具体测试范围及本轮执行状态见 `../../README.md`。
