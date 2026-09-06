# capture-session

## Purpose

截图与页面会话。2026-09-05 从现有实现补录的行为基线；不表示新增功能或所有场景均已手工验收。

## Requirements

### Requirement: 用户触发的视口识别

扩展 SHALL 通过 Popup 或快捷键启动当前可见网页的框选，允许调整、撤销、重选与确认；受限页面显示可操作的失败原因。

#### Scenario: 启动可识别页面

- **WHEN** 用户在普通网页启动并调整选区
- **THEN** 仅确认后的可见选区进入截图和裁剪流程

### Requirement: 截图目标一致性

后台 SHALL 在截图前后核对发送标签页与活动标签页身份，并在身份变化时返回 CAPTURE_TAB_CHANGED。

#### Scenario: 截图期间切换标签

- **WHEN** 截图前后活动标签页与发送者不一致
- **THEN** 识别流程终止并报告目标变化，不使用其他标签页截图

### Requirement: 会话取消及迟到响应

页面 SHALL 用会话与请求标识隔离异步结果，取消时中止当前请求并忽略过期回调。

#### Scenario: 取消后重新框选

- **WHEN** 旧请求在用户取消并开始新会话后才返回
- **THEN** 旧结果不覆盖新会话 UI

## Evidence

content.js、content/session.js、content/selection.js、content/capture-pipeline.js、capture-utils.js、extension-runtime.js、background/capture-service.js；tests/content-session.test.js、tests/capture-utils.test.js、tests/extension-runtime.test.js、tests/background-message-contracts.test.js、tests/e2e/extension.spec.js。具体测试范围及本轮执行状态见 `../../README.md`。
