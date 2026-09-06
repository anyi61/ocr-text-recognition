# OCR 项目的 OpenSpec 导航

2026-09-06：结构重构 `modularize-ocr-extension` 已完成 24/24 并归档。Chrome 生产 manifest 人工验收通过，Edge 经用户明确取消。独立行为变更 `replace-active-capture-session` 保持 8/8 已实施、尚未同步及归档。

## 阅读顺序

1. [提案](changes/archive/2026-09-06-modularize-ocr-extension/proposal.md)：为什么重构及范围。
2. [架构设计](changes/archive/2026-09-06-modularize-ocr-extension/design.md)：现状流程、目标目录、状态所有者、兼容约束和回退。
3. [任务清单](changes/archive/2026-09-06-modularize-ocr-extension/tasks.md)：五阶段、24 项任务，每项带验证方式，进度见复选框。

## 行为基线

这些主规格是从现有实现补录的可回归契约；新增需求应另立变更。

| 规格 | 范围 |
|---|---|
| [capture-session](specs/capture-session/spec.md) | 用户启动、选区、截图身份、会话与取消 |
| [ocr-providers](specs/ocr-providers/spec.md) | 七类服务商、超时重试、自定义协议 |
| [provider-settings](specs/provider-settings/spec.md) | 配置迁移、导入导出与端点授权 |
| [history-management](specs/history-management/spec.md) | 本地历史、搜索修订、保留上限与保存警告 |
| [privacy-boundaries](specs/privacy-boundaries/spec.md) | 上传告知、无痕、来源最小化与凭据边界 |
| [extension-delivery](specs/extension-delivery/spec.md) | 零构建加载、版本与生产白名单 |

纯结构重构 `modularize-ocr-extension` 已设置 `skip_specs: true`，不产生行为 delta。主规格补录不意味着这些能力是本次新增，也不意味着规划中的模块已经存在。

## 规划时的基线验证

| 检查 | 2026-09-05 结果 |
|---|---|
| `npm run check` | 失败于 ESLint：扫描独立 `银行卡活动/`，报告 42 个错误；未进入其后测试步骤 |
| `npx eslint . --ignore-pattern '银行卡活动/**'` | 通过，仅本次命令限定范围，配置尚未修复 |
| `npm run typecheck` | 通过，现有五个核心文件的局部 checkJs |
| `npm test` | 117/117 通过 |
| `npm run test:e2e` | 11/11 Chromium Mock E2E 通过 |
| `openspec validate --all --strict --no-interactive` | 六组主规格和一个重构提案严格校验通过 |
| 商店生产权限、Chrome/Edge 人工操作、真实 Provider API | 本轮未验证 |

测试验证了当前代码基线，未实施的目标结构尚无运行验证。每份规格的 Evidence 是验证入口，不承诺所列测试覆盖该规格的所有场景。旧清单 `docs/improvement-checklist.md` 保留历史日期与当时结果；本表代表本轮执行结果。

## 第一阶段实施验证

默认 `npm run check` 已通过：版本检查、ESLint、局部 checkJs、123/123 Node 测试、22/22 Chromium E2E；`npm run package` 通过。新会话替换行为与变异验证详见 [独立行为变更验证](changes/replace-active-capture-session/verification.md)。原重构交接见 [verification.md](changes/archive/2026-09-06-modularize-ocr-extension/verification.md)。行为增量主规格尚未同步，两个变更均未归档。

## 第二阶段实施验证

后台截图、消息处理、识别用例和七个 Provider 已分离，百度 token 缓存由适配器实例持有；共用请求策略和原消息契约保持不变。完整 check 通过：131/131 Node、22/22 Chromium E2E；package、解压包后台加载测试和 OpenSpec 8/8 严格校验通过。checkJs 覆盖扩展至 16 个文件。详细映射见 [第二阶段验证](changes/archive/2026-09-06-modularize-ocr-extension/verification.md)。

## 第三阶段实施验证

页面入口已缩小为注入和监听组装，新增 session、selection、capture-pipeline、notice-view、result-view 五个工厂。完整 check 通过：134/134 Node、25/25 Chromium E2E；package 和 OpenSpec 8/8 严格校验通过。重复销毁/注入的监听器清理与旧回调隔离通过；仅临时副本移除会话校验的变异测试按预期失败。checkJs 扩展至 21 个文件。详见 [第三阶段验证](changes/archive/2026-09-06-modularize-ocr-extension/verification.md)。

## 第四阶段实施验证

设置页已分为 controller、provider-form、config-transfer；Popup 已分为 controller、history-view，页面入口只负责组装。配置兼容、脱敏导出、授权拒绝、历史刷新和销毁验证通过。完整 check：135/135 Node、28/28 Chromium E2E；package 和 OpenSpec 8/8 严格校验通过。当前局部 checkJs 覆盖 27 个文件。详见 [第四阶段验证](changes/archive/2026-09-06-modularize-ocr-extension/verification.md)。

## 后续流程

本次结构重构已完成并归档；独立会话行为变更的规格同步与归档保留为后续工作。提交、推送和发布尚未执行。

```bash
openspec list
openspec validate --all --strict --no-interactive
```

实施使用项目生成的 `openspec-apply-change` 技能；按阶段完成代码和验证后才勾选任务。全部通过 verify 后才 archive；若新增产品行为，先更新对应变更规格再 apply。此次没有提交或推送。
