## 1. Baseline and Scope

架构审阅已确认保留全部五阶段。以下共 24 项任务，实施进度以复选框和 `verification.md` 为准；模块按独立职责、状态和测试边界抽取，仅转发的入口/controller 可合并并在验收记录中说明。实现若与已确认的用户行为边界存在差异，先记录并另立行为变更，保持本 change 的纯重构范围。

- [x] 1.1 在 `eslint.config.mjs` 中隔离 `银行卡活动/` 等非 OCR 项目及生成目录；验证普通 `npm run lint` 通过，OCR 生产源码与测试仍全部受检。
- [x] 1.2 调整 `tests/e2e/extension.spec.js` 的临时副本创建以复用生产白名单，并保留 Mock manifest 处理；验证副本不含银行卡项目、OpenSpec 与开发产物，11 个现有 E2E 仍通过。
- [x] 1.3 给现有消息处理补兼容性特征测试，覆盖截图、识别、取消、偏好、告知、历史 action 与原响应形状；在未迁移入口前运行新增测试通过。
- [x] 1.4 补齐每标签页单会话、重复启动结束旧会话、快速取消再启动、迟到响应不覆盖新会话及跨标签页取消隔离的行为测试；核对现有实现，记录实际行为差异，通过基线测试并验证能检测故意移除会话校验的回归。
- [x] 1.5 运行原样 `npm run check` 与 `npm run package`，将结果记录到变更目录 `verification.md`；全部通过后才进入阶段 2。

## 2. Background and Providers

- [x] 2.1 抽出 `providers/transport.js` 共用请求封装、错误映射与请求体 helper，保留过渡 runtime；运行 request-runtime 与 Provider 契约测试，验证超时、重试及鉴权不变。
- [x] 2.2 抽出 Claude、OpenAI、OpenAI-compatible、custom 实现并通过现有注册表接入；验证四类请求 payload、响应解析、空结果、截断与取消契约。
- [x] 2.3 抽出百度、阿里云、智谱实现，将百度 token 缓存封装在适配器实例；验证百度三种 mode、token 缓存与 216630 连接测试语义及其余服务商契约。
- [x] 2.4 抽出 `background/capture-service.js` 与 `background/message-handlers.js`；运行阶段 1 的消息特征测试及标签页切换测试，确认 action 与响应字段兼容。
- [x] 2.5 抽出 `background/recognition-service.js`，注入 registry、配置、请求注册表和历史 store；验证取消、保存失败警告、无痕不持久化及正常识别，断言失败与自动重试始终使用该次选定的服务商，其他 Provider 不被调用。
- [x] 2.6 同步后台 importScripts、必要 globals、checkJs、加载测试与生产白名单；运行完整 check 和 package，记录阶段 2 结果后再继续。

## 3. Content Session

- [x] 3.1 引入 `content/session.js` 工厂并保留原 UI，将会话 ID、请求 ID 和销毁转为实例所有权；验证同标签页新会话结束旧会话并取消其请求、清理监听与 UI，重复注入幂等、重复销毁、旧回调失效且其他标签页会话不受影响。
- [x] 3.2 抽出 `content/selection.js`，保留可信事件检查；验证框选、移动、缩放、撤销、重选、Esc 与合成事件拦截。
- [x] 3.3 抽出 `content/capture-pipeline.js` 并复用 capture-utils；验证截图不含插件遮罩、DPI 压缩、标签页变化、截图中取消及迟到响应。
- [x] 3.4 抽出 `content/result-view.js`、`content/notice-view.js`，通过回调连接 session；验证首次上传同意/拒绝、结果复制/修订、错误显示及文字安全渲染。
- [x] 3.5 同步 `CONTENT_SCRIPT_FILES`、加载测试与打包，完成完整 check 和 package；记录取消/重启/卸载的清理结果，通过后进入阶段 4。

## 4. Options and Popup

- [x] 4.1 抽出 Options controller 与 provider-form，保留 `options/runtime.js` 和 provider-config 契约；验证服务商切换、字段保存、域名授权拒绝及设置页 E2E。
- [x] 4.2 抽出 config-transfer，旧格式兼容转换复用 provider-config；验证现代字段优先、失败保留旧数据、重复迁移、脱敏导出及主动包含凭据的分支。
- [x] 4.3 抽出 Popup controller 与 history-view，复用 popup/runtime 和后台历史 action，页面和 Popup 通过消息读写历史；验证搜索、复制、修订后刷新、删除/清空/导出、storage.onChanged 更新，并验证后台历史 store 的串行写入和 50 条上限。
- [x] 4.4 同步 Options/Popup HTML 脚本顺序与必要 globals，验证中英文、明暗主题和监听销毁；运行完整 check 和 package，记录阶段 4 验收。

## 5. Delivery and Closure

- [x] 5.1 移除已无调用方的过渡 Provider 桥接与重复逻辑，更新 README 核心文件映射及主规格 Evidence 路径；审查每个新增模块具有独立职责，合并仅转发的空层并记录映射，验证 CodeGraph 依赖、加载顺序、checkJs 和完整 check。
- [x] 5.2 生成生产 ZIP 并检查内容，验证无银行卡项目、OpenSpec、测试、开发缓存和真实凭据，版本与 manifest 一致；验证源码目录与解压包均可零构建加载，依赖未引入框架或运行时构建，配置/历史仍使用本机存储且无新增账号或云同步路径。
- [x] 5.3 在 Chrome 使用生产 manifest 手工验证工具栏、快捷键、受限页、自定义域授权拒绝、取消、首次告知与无痕历史；记录浏览器版本、结果及未验收项，Mock E2E 不替代本项。2026-09-06 用户明确取消本次 Edge 验收，不计为通过。
- [x] 5.4 整理 `verification.md` 的规格—测试映射、完整 check/package 结果和手工验收证据，运行 `openspec validate --all --strict --no-interactive`；确认任务实际完成后再按流程 archive，未验收项保持未勾选。
