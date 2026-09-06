# history-management

## Purpose

本地识别历史。2026-09-05 从现有实现补录的行为基线；不表示新增功能或所有场景均已手工验收。

## Requirements

### Requirement: 历史保留与操作

系统 SHALL 在本地最多保留 50 条识别历史，支持列表、搜索、复制、修订、删除、清空及导出，存储变更通过串行操作避免相互覆盖。

#### Scenario: 达到保留上限

- **WHEN** 已有 50 条记录后新增识别结果
- **THEN** 保留最新结果并保持记录总数不超过 50

### Requirement: 保存失败与识别结果分离

系统 SHALL 在历史保存失败时仍返回成功识别的文字，并附带保存警告；取消请求不应留下其识别记录。

#### Scenario: 历史存储失败

- **WHEN** 服务商已返回文字但历史写入失败
- **THEN** 用户仍可获取文字并收到历史保存失败提示

## Evidence

history-store.js、background-core.js、background/recognition-service.js、background/message-handlers.js、popup/controller.js、popup/history-view.js、popup/runtime.js、content/result-view.js；tests/history-store.test.js、tests/background-core.test.js、tests/popup-runtime.test.js、tests/background-message-contracts.test.js、tests/e2e/extension.spec.js。具体测试范围及本轮执行状态见 `../../README.md`。
