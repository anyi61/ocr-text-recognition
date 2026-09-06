# 会话替换实施验证

日期：2026-09-05。状态：8/8 项任务完成；本次行为变更已实施并自动验收，主规格尚未同步，尚未归档、提交、推送或发布。

## 实施范围

- `content.js`：统一结束会话并取消旧请求，清理选区、上传告知、结果、通知和计时器；保留 runtime 监听供新会话继续使用，卸载时完整解绑。
- 上传告知以可结算句柄结束，确认前捕获会话身份与选区快照，防止旧告知恢复后使用新选区；并发确认只允许一个流程。
- 每个截图、裁剪和识别异步阶段校验会话身份，catch/finally 同样受保护；旧结果修订回调在结果界面已移除后不会显示通知。
- `tests/e2e/extension.spec.js`：将旧 busy restart 用例替换为新行为验收，并增加可控时序测试。
- `tests/e2e/session-probe.js`：仅序列化到临时扩展副本，在扩展隔离世界保存 closed ShadowRoot 引用并控制消息/图片完成顺序；生产代码不包含测试入口，真实鼠标键盘事件与可信事件校验保持生效。
- 多标签页测试关闭 Popup 后显式恢复目标页焦点，真实截图确认按调用配额控制节奏；行为断言依赖请求/回调检查点，而非固定等待时间。

## 先失败、后通过的证据

1. 未修改业务实现时，新“再次启动取消旧请求”E2E 失败：服务端未观察到旧连接取消。
2. 未修改业务实现时，“框选中再次启动”E2E 失败：旧选区数量仍为 1，目标为 0。
3. 修改生命周期后，11 个针对性场景全部通过；完整检查的 22 个 E2E 全部通过。

## 规格与测试映射

| 行为 | 验证 |
|---|---|
| 框选中替换、连续启动只留一个新选区 | `session replacement resets an edited selection and continuous starts remain single` |
| 旧 OCR 连接取消，新请求独立完成，取消结果不入历史 | `restarting recognition cancels the old request and accepts a fresh selection`，真实后台与 Mock HTTP |
| 旧成功、Promise 拒绝、失败响应不影响新结果/进度 | `session ignores late OCR success/error/failure without disturbing a newer request`，分别释放两次识别的响应 |
| 旧截图/裁剪完成后不提交 OCR | `session discards old captureVisibleTab/crop completion before submitting OCR` |
| 告知状态迟到、重复确认不重复提交 | `session ignores stale upload-state response and requires fresh consent` |
| 关闭旧告知，不把替换当作同意 | `session replacement settles an open upload dialog without granting consent` |
| 真实同意已写入时保留同意，旧选区不上传 | `session ignores old consent-write response while preserving real consent` |
| 主动取消后立即启动、旧回调失效、标签页 B 不受影响 | `session cancel and immediate restart reject old callbacks and spare another tab`；后台消息契约另验实际 requestId 取消隔离 |
| 取消之前已完成记录保留 | 框选替换用例完成识别后再次启动，断言历史内容完全不变 |
| 历史写入中的取消补偿 | 现有 Node `aborting after a full history write restores the exact pre-image` 与取消持久化测试通过 |
| 页面卸载取消与隐私、权限、裁剪等原行为 | 完整 E2E/Node 检查继续覆盖，未放宽生产 manifest |

## 变异验证

命令：`OCR_SESSION_MUTATION=unguarded npm run test:e2e -- --grep 'session ignores late OCR error'`。

变异只发生在 E2E 临时副本：将 `isCurrentSession()` 的身份判断替换为恒真。测试如预期失败，旧异常导致 `after.progress` 从应有的 1 变为 0，退出码 1。原版同一用例在针对性与完整测试中均通过。

变异运行前后工作区 `content.js` SHA-256 一致：`3102cb5fb61ba72c1e764df55ff66b15ae564d963836e445f5ecc18a7d3cfded`。生产源码未残留变异；临时副本在测试 finally 中清理。

## 最终门禁

- `npm run check`：退出码 0；版本检查、ESLint、现有局部 checkJs 通过；Node **123/123**；Chromium E2E **22/22**（44.9 秒）。
- `npm run package`：退出码 0，生成 `dist/ocr-text-recognition-extension-1.1.0.zip`。
- ZIP 内容核对：`content.js` 与工作区完全一致，不含测试探针、tests、openspec 或银行卡项目。
- `openspec validate --all --strict --no-interactive`：**8/8** 通过。
- `git diff --check`：通过。

这些证据覆盖本变更约定的自动验收；没有使用真实服务商，也没有执行 Chrome/Edge 商店生产权限的手工验收。后者仍属于原重构阶段 5。

## 交接

原 `modularize-ocr-extension` 任务 1.4 所需的单标签页替换、快速取消后启动、迟到结果/错误隔离、跨标签页取消与变异验证已有上述证据。其阶段 1 全部五项可完成，整体进度更新为 5/24；阶段 2 尚未开始。本行为变更的主规格同步与归档保留为后续流程。
