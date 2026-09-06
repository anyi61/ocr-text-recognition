## Why

用户已确认同标签页启动新识别时应结束旧会话，但当前 `content.js` 在框选或识别进行中直接忽略再次启动。此差异已由 `modularize-ocr-extension` 阶段 1 的 E2E 复现，需要独立行为变更后再继续纯结构重构。

## What Changes

- Popup 或快捷键再次启动时，用新框选会话替换该标签页旧会话；支持框选、上传告知、截图/裁剪及识别等待阶段。
- 先使旧会话失效，清理其界面和监听，再启动新会话；存在旧 OCR 请求时通过原有取消消息中止。
- 旧会话的成功、失败、告知响应及清理回调均不得改变新会话；未确认的新选区不自动上传。
- 保持跨标签页隔离、手动 Provider 选择、本机存储、上传告知与零构建加载方式。
- 将现有“忙碌时保留旧请求”的现状测试替换为新行为验收，补齐取消及迟到响应的回归与变异验证。

## Capabilities

### New Capabilities

无新增能力目录。

### Modified Capabilities

- `capture-session`：增加同标签页的新会话替换规则，完善取消、迟到响应及标签页隔离场景。

## Impact

- 主要涉及 `content.js` 和 `tests/e2e/extension.spec.js`；必要时扩展测试 Mock/消息契约测试以控制响应时序。
- 复用 `background.js` 的 `cancelOCR`、请求注册表和历史取消机制；不新增消息 action、Provider、权限、存储字段或运行时依赖。
- 本次在现有闭包内修正生命周期，不提前实施 `modularize-ocr-extension` 的目录拆分。
- 本提案仅完成规划。后续 apply 并验收后，更新主规格并将证据交回原重构任务 1.4；原重构的任务不能因本提案创建而勾选。
