# provider-settings

## Purpose

配置与迁移。覆盖服务商配置的兼容读取、旧数据迁移、默认脱敏导出以及用户自定义端点的权限处理。2026-09-05 从现有实现补录的行为基线；不表示新增功能或所有场景均已手工验收。

## Requirements

### Requirement: 配置迁移兼容

系统 SHALL 统一读取 apiConfigs 与公共设置；迁移时现代字段优先、旧字段仅补缺，写入并读回确认后才删除旧字段，同一存储对象内共享迁移 Promise。

#### Scenario: 迁移写入失败

- **WHEN** 旧配置转换后的写入失败
- **THEN** 保留旧数据供后续恢复，不宣告迁移成功

### Requirement: 配置导出脱敏

设置页 SHALL 默认移除导出文件中的凭据，只有用户主动选择包含 API Key 时允许凭据导出。

#### Scenario: 默认导出

- **WHEN** 用户未选中包含 API Key 并导出配置
- **THEN** 导出内容不含 API Key 与 Secret

### Requirement: 自定义端点权限

扩展 SHALL 按自定义端点域名申请可选权限，远程端点使用 HTTPS，HTTP 仅允许 localhost 或 127.0.0.1。

#### Scenario: 权限拒绝

- **WHEN** 用户拒绝当前自定义端点的权限请求
- **THEN** 阻止依赖该授权的启动操作并提示处理方式

## Evidence

provider-config.js、options/controller.js、options/provider-form.js、options/config-transfer.js、options/runtime.js、extension-runtime.js；tests/provider-config.test.js、tests/options-runtime.test.js、tests/e2e/extension.spec.js。具体测试范围及本轮执行状态见 `../../README.md`。
