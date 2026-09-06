# 分阶段验证记录

日期：2026-09-06。最终状态：24/24 项完成；Chrome 人工验收通过，Edge 经用户明确取消。结构重构已归档。

最终门禁：`npm run check` 退出码 0，135/135 Node、28/28 Chromium E2E（1.2 分钟），版本、lint、局部 checkJs 均通过；`npm run package` 成功生成 1.1.0 ZIP；归档前严格校验 8/8、`git diff --check` 通过。无行为 delta；独立 `replace-active-capture-session` 保持未同步/未归档。本轮未提交、推送或发布。

## Chrome 最终人工验收（2026-09-06）

Chrome 152.0.7977.82，用户指定的 Dave 配置中新加载当前源码扩展 1.1.0；通过原生 GUI 操作，生产 manifest、脚本和浏览器 API 均未修改。Dave 是已有独立配置（已登录账号），不是本轮新建的空白浏览器 profile；加载前扩展列表为空，OCR 配置为默认空字段，上传告知为首次状态。日常“学文”配置未改动。

使用仓库 Mock HTTP 服务在 `127.0.0.1:58739` 提供固定测试文字及 OCR 响应，GUI 完整执行真实权限弹窗、快捷键、选区、上传告知与无痕窗口。此处“本地 Mock”只替代外部服务，不采用 Playwright 的放宽权限 manifest 或 API 替换。凭据为无效测试占位字符串。

| 场景 | 原生操作和独立证据 | 结果 |
|---|---|---|
| 自定义域拒绝 | 设置兼容端点后测试连接，Chrome 请求访问 127.0.0.1；点击拒绝，页面提示未授予端点权限，服务端 requests=0 | 通过 |
| 允许端点 | 再次测试连接并允许，本地连接成功，requests=1、completed=1；此请求为连接测试，不是用户截图 | 通过 |
| 首次告知拒绝 | 普通测试页快捷键框选并 Enter，出现“发送截图前请确认”；取消后请求数仍为 1，再 Enter 仍须同意 | 通过 |
| 首次告知同意 | 点击同意后 requests=2、completed=1（等待中），随后显示固定识别结果 | 通过 |
| 截图无 UI | 检查实际 POST 图片，白底、测试文字和原页面边框完整，无遮罩/告知/进度；选区跨越原提示栏所在区域 | 通过 |
| 请求中取消 | 10 秒响应的两次尝试均赶在取消前完成，不计为取消通过；将仅临时服务副本延迟改为 25 秒后重新测试，服务端先记录 requests=1、completed=0，Esc 后 aborted=1、completed=0；立即快捷键重启仍保留新框选 | 通过 |
| 取消历史 | Popup 仅有两条先前完成记录（20:45、20:46）；25 秒请求中断后没有第三条 | 通过 |
| 无痕历史 | 临时打开 Dave 配置无痕权限，真实无痕窗口识别成功并显示结果；服务端累计 requests=2、aborted=1、completed=1。关闭无痕窗口后普通 Popup 仍为同两条记录 | 通过 |

上传图片证据：`evidence/chrome-uploaded-capture.png`。截图尺寸为 1640 × 410，对应 820 × 205 CSS 像素选区。计数在服务重启后重新从 0 开始，未混用两个服务进程的累计值。无痕界面显示用时 28 秒，服务响应延迟设为 25 秒；记录观察值，不将其误称为超时失败。

验收结束关闭无痕窗口，并恢复 Dave 的无痕权限为关闭。保留测试端点设置及两条测试历史以便复核；测试服务在本轮结束时停止。首次告知已被正常确认。工具栏、快捷键及受限页的先前真实 Chrome 证据继续有效。Edge 按用户明确要求取消，不宣称通过。

以下分阶段及中断记录为历史快照，当前结果以上表为准。

## 第五阶段交付验证

2026-09-06 完成 5.1、5.2，保留 5.3、5.4 未勾选。

### 模块收尾与职责审查

删除 `providers/runtime.js` 的七个转发函数、后台连接测试别名及对应 ESLint globals。原 Provider 契约测试改用正式 `providerAdapters.recognize`，连接测试直接调用 recognition service；不再为测试保留生产桥接。静态加载检查调整为 transport → 七个适配器 → registry → 后台 services。

CodeGraph 在修改前定位桥接与别名，修改后定位 `providerAdapters`、`recognitionService` 和 `adapterDependencies` 的实际组装；嵌套闭包的索引范围有限，已结合已知模块源码及加载/契约测试审查。新模块均有独立协议、状态或编排职责，完整映射见根 README。根 Options/Popup 入口保留 DOMContentLoaded 及平台依赖组装；controller 承担初始化、订阅和销毁。message-handlers 保留 action、响应形状和消息通道适配职责。删除的 runtime 是本次发现的纯转发空层，其余模块无需合并。

### 规格与回归入口

六组主规格仅更新 Evidence，Requirement/Scenario 保持原文；会话行为增量仍在独立变更中。

| 主规格 | 本轮验证入口 |
|---|---|
| capture-session | `content-session.test.js`、`capture-utils.test.js`、`extension-runtime.test.js`、后台消息契约及会话 E2E |
| ocr-providers | `provider-adapters.test.js`、`provider-contracts.test.js`、`provider-modules.test.js`、`request-runtime.test.js`；选定服务商重试隔离消息测试 |
| provider-settings | `provider-config.test.js`、`options-runtime.test.js`；Options 授权拒绝、迁移和导入导出 E2E |
| history-management | `history-store.test.js`、`background-core.test.js`、`popup-runtime.test.js`；后台消息契约及历史操作 E2E |
| privacy-boundaries | 静态可信存储检查、后台无痕/历史元数据契约；上传告知和拒绝 E2E |
| extension-delivery | 静态加载与版本检查、`package-extension.test.js`、包内后台消息测试，以及本节生产 manifest 加载冒烟 |

测试路径位于 `tests/`；浏览器用例位于 `tests/e2e/extension.spec.js`。映射表示验证入口，不将 Mock 覆盖等同于生产浏览器人工验收。

### 自动门禁与生产包

- `npm run check` 退出码 0：版本、ESLint、27 个文件的局部 checkJs、Node **135/135**、Chromium Mock E2E **28/28**（1.1 分钟）。日志：`/tmp/ocr-phase5-check.log`。
- `npm run package` 退出码 0：`dist/ocr-text-recognition-extension-1.1.0.zip`。版本 1.1.0 与 package、manifest、配置导出版本来源一致。
- ZIP 49 个文件逐字节匹配源码，顶层集合严格等于生产白名单；已删除桥接未进入包。未包含银行卡项目、OpenSpec、测试、技能、node_modules、缓存或配置导出文件。
- 对包内 44 个文本文件检查常见 API Key 和私钥字面量模式，匹配数 0；结合生产配置取值与空默认值审查，未发现内置真实凭据。此检查不声称可识别所有形式的秘密，未读取用户浏览器凭据。
- 使用独立临时 profile，在 **Chromium 149.0.7827.55** 分别直接加载源码目录和解压 ZIP，未修改 manifest、权限、脚本或浏览器 API。两者后台启动、Options/Popup 页面加载与 controller factory 可用，页面异常数 0，host_permissions 与源码一致。结束后删除本次临时 profile 和解压目录。该项仅验证零构建加载，不验证工具栏 activeTab 授权。
- package.json 与依赖锁未修改，无新增框架或运行时构建。后台明确注入 `chrome.storage.local`；Provider 只使用用户配置的端点，生产文本未发现 `chrome.storage.sync`，无新增账号或云同步路径。
- `openspec validate --all --strict --no-interactive` **8/8** 通过；`git diff --check` 通过。

### Chrome 人工验收待办（Edge 已取消）

范围更新：用户于 2026-09-06 明确取消 Edge 验收；不计为通过，不再阻塞本次归档。

本轮继续：已通过 Chrome 头像菜单点击“添加 Chrome 个人资料”，准备独立本地测试配置。随后 CUA 返回仅有窗口标题的空可访问性树，截图明确返回 `Screenshot unavailable for /Applications/Google Chrome.app`；重新获取应用、检查可用窗口及重置 CUA 会话仍未恢复。尚未确认新 profile 创建完成，因此未执行剩余测试，也未修改既有凭据/端点/告知状态/无痕权限。需要恢复可访问的 Chrome 新配置窗口后继续。


2026-09-06 Chrome 重试：Google Chrome **152.0.7977.82**（应用 Info.plist）已可通过原生 GUI 操作。扩展详情确认 ID `hheoklfpjlmalkdhocbhfnpakggipppc`、版本 1.1.0、来源 `~/Downloads/个人资料/ocr`，点击重新加载后执行以下验证，生产 manifest 未修改。此次沿用已有用户 profile，只在新开的 `https://example.com` 测试页操作；未改凭据、端点、告知状态和无痕权限。成功识别会按正常产品行为增加一条 Example Domain 测试历史。

实际观察：真实工具栏 Popup 正常；在 `chrome://extensions` 启动显示“浏览器内部页面不允许扩展截图”；普通网页能进入选区，Esc 显示已取消；Cmd+Shift+S 再次启动，拖拽产生 773 × 112 px 选区与调整工具栏。确认后约 1 秒返回 Example Domain 标题、正文和 Learn more，结果未混入插件提示文字。未直接检查截图像素中的遮罩，因此仅将工具栏截图/识别链路标为通过。

取消补测：第一次点击等待中的取消按钮前请求已完成，不能计为成功取消。第二次 Enter 后立即 Esc 显示已取消，随后快捷键可重新框选，后续观察未出现旧结果覆盖，最后 Esc 清理 UI。此时不能确认网络请求是否已发出，也未独立核对历史差额，故请求中的取消及不入历史仍保留部分待验收。

`/Applications` 和可用应用/浏览器清单未发现 Microsoft Edge，版本未知。首次告知、自定义域拒绝、无痕历史需在独立测试 profile 继续，避免重置现有用户设置。此前 GUI 被用户操作中断的情况已在此次重试解除。

| 项目 | 操作与通过标准 | Chrome | Edge |
|---|---|---|---|
| 工具栏 | 点击真实扩展图标启动，在普通网页框选；确认可截图且不包含遮罩 | 截图识别通过；遮罩像素检查待验收 | 用户取消 |
| 快捷键 | macOS Cmd+Shift+S 启动，检查快捷键冲突；Esc 结束框选 | 通过 | 用户取消 |
| 受限页 | 在 chrome:// 或 edge:// 页面启动，出现明确失败原因，不注入框选 | 通过 | 用户取消 |
| 自定义域拒绝 | 配置未授权测试域并拒绝浏览器权限弹窗，确认无 OCR 请求并有提示 | 待验收 | 用户取消 |
| 取消 | 识别等待中取消，再开始；迟到结果不出现、取消记录不入历史 | 确认后立即取消/重启通过；请求中取消及历史差额待验收 | 用户取消 |
| 首次告知 | 新 profile 首次确认选区，拒绝时无上传；再次启动同意后才发请求 | 待验收 | 用户取消 |
| 无痕历史 | 测试 profile 允许无痕后识别，结果可见；普通历史前后不增加 | 待验收 | 用户取消 |

当前唯一 Next：补齐 Chrome 的人工证据（用户已取消本次 Edge 验收），再完成 5.4 最终校验与归档。未提交、推送、发布、同步行为主规格或归档。

## 第四阶段验收（历史）

2026-09-06 完成 4.1–4.4。页面入口仅组装 controller；模块沿用命名空间工厂与依赖注入。Options 和 Popup 各自管理 DOM 事件、定时器与销毁；Popup 历史快照和行监听属于 history-view，后台继续独占持久化历史写入。

| 任务 | 实施与验证入口 |
|---|---|
| 4.1 | `options/controller.js` 管理初始化、主题、界面语言及生命周期；`options/provider-form.js` 管理七类字段、配置校验、自动保存和连接测试，复用原 provider-config 与端点权限 helper。原设置页 E2E 及新增 Provider 切换/百度 mode 保存/授权拒绝测试通过。拒绝路径明确断言权限申请发生一次、没有 Provider HTTP 请求。 |
| 4.2 | `options/config-transfer.js` 承接导入校验、确认、合并和导出，继续复用现代/旧格式转换、脱敏、凭据合并及 appearance helper。新增浏览器测试实际下载默认脱敏与主动包含测试凭据两种 JSON，验证 runtime manifest 版本、现代 model 优先、缺凭据保留本机密钥、重复导入幂等、非法导入不改存储、中文/暗色设置保留。原 provider-config 单测继续覆盖重复迁移与失败保留旧数据。 |
| 4.3 | `popup/controller.js` 管理启动、权限、主题/语言与 storage.onChanged 订阅；`popup/history-view.js` 管理历史快照、搜索、详情、复制、删除、清空与导出。新增浏览器用例覆盖详情/行复制回调、后台修订后刷新且保留搜索词、导出全部记录、删除一条、清空、中英文及明暗切换。原 history-store 单测继续验证串行写入与 50 条限制。 |
| 4.4 | HTML 顺序为原纯 helper → 新模块 → 页面入口，ESLint globals 与 checkJs 同步。新增五个模块及本次修改的 `options/runtime.js` 均纳入检查，共 27 个文件。控制器通过 AbortController 清理 DOM 监听并清除定时器；Popup 重复 pagehide 只解除一次自身历史订阅，销毁后主题按钮不再生效。导入确认支持销毁时取消；单测验证正在关闭的对话框清除 timer、移除 DOM、只结算一次，浏览器验证关闭待确认导入不会写配置。 |

门禁结果：

- `npm run check`：退出码 0，版本、ESLint、局部 checkJs、Node **135/135**、Chromium Mock E2E **28/28** 全部通过（E2E 输出 1.0 分钟）。随后将修改过的 `options/runtime.js` 加入覆盖，再次独立 `npm run typecheck` 通过，当前 checkJs 共 27 个文件。
- `npm run package`：退出码 0，生成 `dist/ocr-text-recognition-extension-1.1.0.zip`；ZIP 中本阶段入口、HTML、runtime 和新模块逐字节匹配源码，不含测试、OpenSpec、技能、node_modules 和银行卡目录。
- `openspec validate --all --strict --no-interactive`：**8/8** 通过；`git diff --check` 通过。
- 静态源码检查已定位新职责文件，翻译键与安全模板检查覆盖新模块。新增授权测试先等待 blur 自动保存完成，再独立断言权限拒绝，保持原自动保存时序。

复制测试在临时浏览器中捕获剪贴板写入参数，不覆盖系统剪贴板。页面 controller 只解除自身订阅；原 i18n runtime 的文档级订阅保持现有设计。生产 manifest、第三方依赖、配置 schema 和历史格式不变；未提交、推送、发布、同步行为主规格或归档。阶段 5 的 Chrome/Edge 生产权限人工验收仍待执行。

## 第三阶段验收（历史）

2026-09-06 完成 3.1–3.5。`content.js` 保留注入幂等、字典就绪等待和平台监听注册；每个文档创建一个 session 实例。会话拥有 requestId、会话标识、UI 定时器和 Shadow Root，负责子模块生命周期。选区模块封装几何及撤销栈，只返回矩形副本；其他模块通过回调连接会话，不共享可写状态对象。

| 任务 | 实施与验证入口 |
|---|---|
| 3.1 | `content/session.js` 工厂提供 `start/cancel/destroy`，先使旧会话失效再清理和取消请求；重复 destroy 幂等，销毁后 start 无效。`tests/content-session.test.js` 覆盖替换、旧完成不清除新 requestId、实例隔离、销毁及迟到同意。原会话 E2E 保留；新增真实 DOM 测试验证重复注入仍为一个实例、销毁后监听器/进度 interval 为 0、旧结果不重建界面、再注入可正常启动。 |
| 3.2 | `content/selection.js` 持有选区、拖拽、手柄、工具栏和撤销历史，统一移除文档监听器。保留可信事件检查与原几何计算；浏览器测试覆盖框选、拖拽/缩放/撤销、重选、取消、重复启动及合成事件隔离。 |
| 3.3 | `content/capture-pipeline.js` 执行双帧等待、后台截图、DPI 裁剪/压缩、识别提交与结果分派，每个异步边界查询会话是否仍有效。复用 `capture-utils.js`；高 DPI、大图、无覆盖层截图、标签页身份、迟到截图/裁剪/识别及取消回归通过。 |
| 3.4 | `content/notice-view.js` 持有上传告知 Promise、进度 UI 和 interval；`content/result-view.js` 负责结果安全赋值、复制与历史修订。会话销毁使未完成告知返回 false。保留首次同意/拒绝、过期同意回调隔离、结果保存、错误提示及文本安全渲染验证。新增浏览器用例直接操作结果编辑、复制、保存和关闭；剪贴板写入在临时测试副本中捕获参数，不写入系统剪贴板。 |
| 3.5 | `CONTENT_SCRIPT_FILES` 同步为公共工具/样式 → selection/notice/result/pipeline → session → entry。静态测试定位实际模块，并将翻译键和模板检查扩展至新文件。五个工厂纳入 checkJs，总计 21 个文件；`content/` 已在生产白名单内。完整 check、package 与严格校验通过。 |

门禁结果：

- `npm run check`：退出码 0；版本、ESLint、局部 checkJs 通过，Node **134/134**、Chromium Mock E2E **25/25**（52.1 秒）。
- `npm run package`：退出码 0，生成 `dist/ocr-text-recognition-extension-1.1.0.zip`；生产包仍使用白名单，包内后台加载测试通过，浏览器测试使用同一生产文件集合。
- `openspec validate --all --strict --no-interactive`：**8/8** 通过；`git diff --check` 通过。
- 变异验证：`OCR_SESSION_MUTATION=unguarded npm run test:e2e -- --grep 'session ignores late OCR error'` **预期失败**。仅临时副本中将 `content/session.js` 的会话判断替换为 `return true`，旧错误移除了新会话进度，断言 `after.progress` 期望 1、实得 0。证明重构后的测试仍能检出异步隔离回归；生产源码与 ZIP 保留真实判断。ZIP 内入口、加载清单及五个模块均逐字节匹配当前源码，且不含测试、OpenSpec、技能和独立银行卡目录。

本阶段没有修改生产权限、Provider 实现和持久化结构，未提交、推送、发布或归档。Chrome/Edge 生产 manifest 与真实 Provider 的人工验收仍留在阶段 5；自动测试不替代该项。

## 第二阶段验收（历史）

本阶段完成 2.1–2.6，保持 `skip_specs: true`。七个 Provider 与后台用例采用命名空间工厂，入口显式注入依赖；接口、请求参数、错误字段及存储结构保持兼容。

| 任务 | 实施与验证入口 |
|---|---|
| 2.1 | `providers/transport.js` 统一 JSON 请求、错误映射及 OpenAI 请求体构造。仍使用 `request-runtime.js` 的单次策略预算 27000 ms、最多两次尝试。`tests/request-runtime.test.js`、`tests/provider-contracts.test.js`、`tests/provider-modules.test.js` 验证重试、鉴权、超时与取消。 |
| 2.2 | `providers/claude.js`、`openai.js`、`openai-compatible.js`、`custom.js` 独立构造请求并解析结果，由现有 registry 接入。原 payload、空结果、响应解析契约通过；新增模块测试逐一验证六类 chat adapter 截断与取消。 |
| 2.3 | `providers/baidu.js`、`aliyun.js`、`zhipu.js` 独立实现。百度缓存属于实例闭包；新增测试覆盖三种 mode、实例/凭据隔离、失败/过期后重新鉴权、并发共享 token 请求及取消单个等待者。原 216630 连接测试警告契约通过。 |
| 2.4 | `background/capture-service.js` 负责截图前后标签页身份检查；`background/message-handlers.js` 保持 11 个 action、返回字段与消息通道生命周期。真实入口 VM 消息契约测试通过。 |
| 2.5 | `background/recognition-service.js` 接收配置、Provider registry、请求注册表与历史 store，负责识别、连接测试和取消。消息测试覆盖取消隔离、无痕、保存失败警告及正常历史；重试测试在首个 503 后切换存储中的服务商，验证成功/401/503 三条结局均只有两次原 OpenAI 端点请求，鉴权及模型不变，没有调用其他服务商。 |
| 2.6 | `background.js` 负责加载与组装；ESLint globals、静态加载顺序与 `jsconfig.json` 同步，checkJs 从 5 个文件扩展至 16 个。生产白名单加入 `background/`。新增测试在临时目录构建并解压 ZIP，校验顶层白名单，再用包内真实入口完成截图、识别与历史操作。 |

门禁结果：

- `npm run check`：退出码 0；版本、ESLint、局部 checkJs 通过；Node **131/131**，Chromium Mock E2E **22/22**（47.0 秒）。
- `npm run package`：退出码 0；生成 `dist/ocr-text-recognition-extension-1.1.0.zip`。
- `openspec validate --all --strict --no-interactive`：**8/8** 通过。
- `git diff --check`：通过。
- 首次完整检查发现历史静态测试仍定位旧 `background.js`，更新为 `background/message-handlers.js` 后重新完整运行通过，未删除原断言。

兼容与边界：`providers/runtime.js` 暂保留旧函数名转发，既有契约测试仍调用这些入口；生产 registry 直接使用新工厂实例，桥接不持有缓存。`testAPIConnection` 也保留现有测试入口别名。阶段 5 统一清理这些过渡入口。生产 manifest、依赖及本阶段页面代码未修改；真实服务商、Chrome/Edge 生产权限人工验收仍待阶段 5。未提交、推送、发布、同步行为主规格或归档。

## 第一阶段会话行为验收（历史）

`replace-active-capture-session` 已实施并通过自动验收，任务 1.4 已完成。默认 check 通过：123/123 Node、22/22 Chromium E2E；package 和 OpenSpec 8/8 严格校验通过。新会话替换、告知结束、旧成功/错误回调隔离、跨标签页取消及临时副本变异失败证据见 [会话替换验证](../replace-active-capture-session/verification.md)。

以下为第一阶段最初的实施记录与历史差异诊断，保留其当时结果。

## 已完成范围

| 任务 | 实施与证据 |
|---|---|
| 1.1 | `eslint.config.mjs` 排除独立 `银行卡活动/`，原有生成目录忽略规则保留；普通 lint 通过。通过 ESLint API 核对当时 39 个 OCR 生产、测试和脚本文件仍受检，随后新增消息测试也纳入最终 lint。 |
| 1.2 | E2E 临时副本使用 `scripts/package-extension.mjs` 的 `PRODUCTION_FILES`，每次创建断言顶层内容与白名单完全一致；保留 Mock manifest 的权限处理。原有 11/11 E2E 通过。 |
| 1.3 | 新增 `tests/background-message-contracts.test.js`，在 VM 内加载真实 background 入口与 importScripts，仅模拟 Chrome 与 HTTP；六个测试覆盖全部 11 个后台 action、消息通道生命周期、响应结构、截图身份变化、历史完整操作、无痕、缺配置和取消。 |
| 1.5 | 原样执行完整 check、package 并记录结果。此任务的命令已完成，不代表未完成的 1.4 或整个阶段验收通过。 |

## 执行结果

- `npm run check`：退出码 0；版本、ESLint、现有局部 checkJs 全通过；Node **123/123**；Chromium E2E **12/12**。
- `npm run package`：退出码 0；生成 `dist/ocr-text-recognition-extension-1.1.0.zip`。
- `npm run test:e2e -- --grep 'busy restart'`：1/1，通过下面的现状复现。
- 测试使用 Mock HTTP 和测试专用凭据，未访问真实 OCR 服务或用户浏览器配置。
- 业务运行文件、生产 manifest 与依赖未修改；未提交、推送、发布或归档。

## 历史诊断：任务 1.4 的原行为差异

审阅确认的目标是：同标签页启动新会话时结束旧会话，取消旧请求并忽略迟到结果。

当前 `content.js:1785` 的 `startCapture()` 行为：

1. 框选中再次启动，因 `isCapturing` 直接返回。
2. 识别进行中再次启动，因 `isProcessing || activeRequestId` 显示提示并直接返回。
3. 因此没有发生已确认的新旧会话替换。

新增 E2E `busy restart currently keeps the original request until page reload cancels it` 复现：开始延迟请求，再次从 Popup 启动并框选确认后，服务端仍只有一个请求，取消数与完成数均为 0；刷新页面后取消数才变为 1。测试记录当前行为，不接受该行为作为新设计的最终结果。

消息契约测试已验证两个不同标签页、不同 requestId 并发时，取消 A 不会中止 B，B 可以正常写入历史。它不替代页面层的会话替换与迟到回调测试。

**当时尚未完成，现已由独立行为变更补齐**：新会话替换旧会话的行为实现与验收、快速取消后新会话的完整页面测试、迟到响应不能覆盖新会话、故意移除会话检查时测试应失败的变异验证。当时因此暂停了 1.4 和阶段 2；当前状态以上方最新验收为准。

## 下一步

当前 change 继续声明 `skip_specs: true`，保持纯结构重构；行为差异已由 `replace-active-capture-session` 单独实施。当前唯一 Next：进入阶段 5，清理过渡入口、更新职责映射并执行生产包与真实浏览器验收；主规格同步和行为变更归档按后续流程处理。
