# V1 补充反馈验收报告（目标版本 0.2.3）

> 更新日期：2026-10-01。状态：**验收总体 PARTIAL；0.2.3 候选进入发布准备**。本报告按反馈原编号区分自动化证据与原生 GUI 证据；未覆盖项保持待测。V1 仍为 ACTIVE，不据此关闭 V1。

## 版本与验证状态

- 应用配置版本为 `0.2.3`；当前公开版本仍是 [`v0.2.2`](https://github.com/wyzh0117/workbench/releases/tag/v0.2.2)。本地 Universal app/DMG 生产构建已生成，`hdiutil verify` 通过；DMG SHA-256 为 `b109449abc48f534fdc6e64618e3e0297da3435fad8bcdcb64df7631689074f6`，架构 x86_64+arm64。53 项明确文件已暂存，尚未提交、打 tag 或发布；该制品不是 GitHub Release 资产，尚无最终发布 commit/tag/URL 或公开 sidecar。
- preview6 构建基线位于 `main` 的 `d85c3f7f42cdf794ad53f9c8f2c3f8c7d726b9fd`；构建时版本候选改动仍在工作区，不能把该基线 commit 当作本轮发布源码 commit。
- 首次接管在用户明确选择的来源目录根创建 `project.json` 与 `.workspace`；确认的素材副本位于该项目的 `assets/`。preview7 原生向既有 C02 追加 TXT 与 Markdown 成功；同 SHA Markdown 默认跳过，保留已编辑正文，追加可一次 Undo/Redo。来源文件保持原位且字节不变；项目身份、历史和已有引用另有自动化回归保护。
- Markdown 正文仍以源 Markdown 存入 Canonical `Block.content`。浏览器/Deno 共享 AST parser 派生语义块与 HTML；显式本地图片引用按 AST 建立 `settings.markdown_assets` 的 href→asset ID 映射，远程/危险 href 不自动抓取；导入边界再次以源 hash、后端解析和路径授权校验依赖。预览层通过受控资源 resolver 渲染，不从 HTML 或正则反推路径。
- 隔离原生 preview4/preview6/preview7/preview8/preview9 提供了 PDF、PPTX、导入/追加、设置、响应式布局、Markdown 文件页与媒体走查证据；它们都是 QA 快照，不能替代完整的正式包 GUI 复测。preview4 PPTX 在 PowerPoint 中无 Repair，文字与图片可分别编辑。正式 Universal app/DMG 已从清理后的发布源码构建；原生 GUI 未在该正式包上重复整套流程。
- 最新完整自动化结果：Deno **389/389**、Rust **95/95**，`deno task check` 和 `cargo fmt --check` 通过；清理 QA 诊断后的正式 Universal app/DMG 构建成功。首帧解码改动最初出现的 388/1 失败来自旧测试替身缺 rVFC / canvas pixel API，更新替身后已修复；视频首帧与文件浏览器定向套件 **9/9**。
- preview6–9 为隔离 QA 快照；preview6 应用可执行文件 SHA-256 `faddd2e75a6f272c05d22666300b71e867cecf1237349c5fb75b413691b41286`，不代表后续 QA 构建或正式 app/DMG。QA 快照里的临时诊断 overlay/script 已从发布源码删除；正式 Universal app/DMG 已在删除后重建并验证。
- 最终无诊断轻抽检包使用隔离 QA identifier，启动并打开隔离工程正常；可执行文件 SHA-256 `296be7768bf84da4df21d9c32564e5dca5a0991d727e415ce34aa9dd4e1d2042`。此包只用于最后的正文行内操作与设置/课程地图导航抽检，不是正式发布 app，也不代表正式包完整 GUI 套件通过。
- 导入/安全定向证据：`tests/t04_scan_test.ts` 9/9；Rust 中间符号链接越界拒绝回归 1/1；Deno 导入事务测试 11/11（含故障注入）；Rust 导入测试 5/5。AI 设置定向测试 29/29。定向测试不等于完整套件或原生 UI 全部通过。

## 用户 1—15 项验收矩阵

| # | 要求 | 状态 | 已有证据 | 尚待验证 / 边界 |
|---:|---|---|---|---|
| 1 | 映射仅扫描所选目录第一层，文件名条选择行为一致 | 部分 | Deno 扫描/选择定向测试 9/9；preview3 首次导入成功；preview7 键盘明确选择目录后扫描了所选目录；preview8 展开依赖时 11/11 勾选保持不变，并列出本地可读/缺失分类 | 子目录排除的独立原生证据不足；此前 CUA 单击只触发 hover，后续键盘明确选择验证路径正常 |
| 2 | 单次确认创建、写入并打开项目；失败不覆盖、不重复导入 | 部分 | 导入事务、rollback 故障注入 Deno 11/11、Rust 5/5；preview3 创建并重开成功；preview7 既有目标追加和同 SHA 默认跳过成功 | preview8 只验证依赖预览，未提交该次计划；原生失败重试、打开失败边界未覆盖 |
| 3 | 小屏区块创建按钮保持完整可读 | preview8 通过（测试视口） | 工具栏全部按钮换行，说明水平显示且未遮挡 | 实际 CSS 宽度未记录；精确 1024 与系统字体缩放仍未测 |
| 4 | 概览支持向既有项目追加文件/文件夹并保留项目身份与引用 | 部分 | preview7 向既有 C02 追加 TXT/Markdown；同 SHA 默认跳过且不覆盖已编辑正文；一次 Undo/Redo 通过；identity/history 有自动化回归 | 原生验证覆盖文件追加，未覆盖向既有项目追加文件夹以及含既有分页/素材引用的目标 |
| 5 | Markdown 导入后正文按语义呈现、可编辑并保存 | preview7/8 抽样通过 | C02 Markdown 编辑/保存/重开、中文换行、bold/strikethrough、code 转义与惰性 XSS 通过；文件页 Markdown 语义渲染通过 | 原生证据为抽样流程，未穷尽所有目标类型和 Markdown 扩展 |
| 6 | 正文区默认简洁，悬停或聚焦后操作可见 | 通过（最终隔离原生轻抽检） | 无诊断 QA 包中默认卡片不显示行内按钮；聚焦正文 02、再聚焦正文 03 时，各自仅显示本行 +/⋯ 操作，其他行隐藏 | 原生观察来自隔离 QA 包；正式包未重复完整 GUI 套件 |
| 7 | 分页区域按编辑状态显示，退出编辑保留页面 | preview7/8 通过（QA fixture） | 退出分页编辑再进入、切换 Flow/Grid 后重新进入分页，页面与栅格位置保留 | 原生观察来自 QA fixture；正式包未重复完整分页 GUI 流程 |
| 8 | AI 使用界面和配置分离；关闭设置保留输入 | 部分 | AI 设置定向测试 29/29；preview7/8 设置列表、新建连接、三个协议项可见；取消后不持久化且 provider 列表保留 | 没有在线读取模型、连接测试或真实密钥验收；设置导航未做系统性原生验收 |
| 9 | 顶部设置入口明确，模型管理入口唯一且课程地图仍可达 | 通过（最终隔离原生轻抽检） | 无诊断 QA 包中顶部“设置”打开 AI 模型管理；主导航无第二个 AI 模型管理入口；侧栏“课程地图”可进入并显示课程结构 | 原生观察来自隔离 QA 包；没有在线 provider 或账户验证 |
| 10 | 三种 API 协议真实执行；订阅接入和授权边界正确 | 部分 | OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 的 loopback 请求行为及失败处理已自动化验证；SIWC 会话安全有 Rust/本地替身测试 | **未进行在线 SIWC 登录、真实 token refresh 或真实 Provider 请求**；不得称在线授权或调用已验收 |
| 11 | 正文、预览和导出语义一致，含图片、引用、粗体、标题 | 部分 | 原生 PDF 中文+图片；preview4 PPTX 在 PowerPoint 无 Repair、文字/图片可编辑；preview7 Flow/Grid/分页位置保留；preview8 Markdown headings/lists/table/code 与图片/缺图语义显示 | Deno/service PDF 当前省略 inline images 并产生 `pdf_inline_images_omitted` warning；原生 PDF 实测含图片。PPTX 对复杂 Markdown 表格和嵌套列表作简化并产生 warning；未逐一比较所有结构在各视图和导出格式中的呈现 |
| 12 | 图片/视频首帧缩略图；GIF/视频放大播放行为正确 | **部分；GIF 动画未通过本机观察** | 视频首帧、显式播放/返回复位通过；GIF Blob 487B、MIME `image/gif`、GIF89a，SHA-256 `b1032df239ec3512b03013dca9e9aba105d79df1b8a4755256014a5df0836f8e` 与 fixture 一致；独立 IMG 同字节重建并加载为 160×90 | preview9 modal 与独立 IMG 在 0、0.65、1.3、2.0、2.65 秒均只见红帧，未观察到蓝帧/动画；本机 WKWebView 动画未闭环。不能据此推断源文件损坏或声称通过 |
| 13 | 媒体卡主要动作在同一行并留出缩略图空间 | 部分 | 大窗口同一行观察通过；preview8 窄屏四种侧栏组合下布局与工具栏可读；CSS 在窄窗让文件页单列并避免文件名窄列竖排 | 视口实际 CSS 宽度未记录；1024 与字体缩放未测 |
| 14 | 文件页预览支持类型内容，保持只读和安全 | 部分 | preview8 文件页只读预览中文 Markdown 标题/列表/表格/代码、本地图与缺图提示；脚本文本惰性；PDF 有文字和图，TXT/媒体亦有走查 | 只覆盖常见格式 fixture；DOCX 与未支持格式的呈现未逐类原生走查 |
| 15 | 拖动把手不选中文字，取消/结束后恢复文本选择 | 部分 | preview6/8 移动后正文可选字；preview8 Escape 取消 click-move 后位置不变且可选字 | 当前 CUA 无法直接测指针拖动中途取消；未将 Escape 路径冒充 pointer-cancel 验收 |

## 当前限制与发布边界

- AI 设置参考 DSH 的提供商/自定义端点/协议/密钥/模型发现与保存流程，Workbench 将 API Key 留在系统凭据存储，连接 ID 固定端点与协议，并在凭据来源域变化时要求确认。自动化分别验证 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 请求路径，不把模型发现成功等同于实际调用授权。
- 订阅支持边界为原生 Tauri 的 Sign in with ChatGPT（SIWC）路径；Rust 本地替身测试覆盖 state、身份、scope、刷新、多个账户隔离和退出竞争。浏览器运行时不支持此原生回调路径。**未做真实 ChatGPT/SIWC 在线授权、token refresh 或模型请求**。其他 Pi 中列出的订阅 OAuth 不因参考实现存在就自动启用或宣称支持；仍可使用各自合规的 API 连接。
- 实现未复用 Pi/DSH 客户端 SDK：Markdown AST 使用 vendored `marked` 18.0.7（MIT）；原生 SIWC 使用锁定于 `Cargo.lock` 的 `reqwest` 0.11.27（MIT OR Apache-2.0）和 `jsonwebtoken` 9.3.1（MIT）。这些版本及许可证是实现依赖信息，不代表对外部订阅服务的在线验证或授权结论。

- preview4 的小视频首帧缩略图为空白；preview6/7 已看到红色静态首帧，显式播放、返回复位通过且没有解码错误。preview9 的 487B GIF fixture 内容、MIME、GIF89a 与 SHA 均匹配，modal 及同字节独立 IMG 能加载为 160×90，但两者在 2.65 秒观察中都只显示红帧；本机 WKWebView 未观察到动画，因此 GIF 动画项未通过/未闭环，不能归因于源文件损坏。精确 1024/字体缩放和指针拖动取消未测。
- 导出边界：Deno/service PDF 当前省略行内图片并产生 `pdf_inline_images_omitted` warning；已验证的原生 PDF 包含行内图片。PPTX 对复杂 Markdown 表格与嵌套列表作简化并产生 warning。
- 真实在线 AI 服务与订阅授权未测试，也没有在验收中读取或传入用户凭据。测试替身只证明本地请求格式和错误处理。
- 正式 Universal app/DMG 为 ad-hoc signed，没有 `TeamIdentifier`；本机 `spctl --assess --type execute` 结果为 `rejected`，未使用 Developer ID 签名或 Apple 公证。因此分发状态为 PARTIAL，不能承诺首次打开无需 Gatekeeper 放行。
- 原始反馈、用户私人历史文档和本地 QA 临时材料不属于公开发布文件。已发布 `v0.2.2` 的 tag/assets 必须保持冻结。

## 正式发布回填

清理 QA 诊断后的正式 Universal app/DMG 已生成且 `hdiutil verify` 通过。最终源码 `deno task test` 389/389、Rust `cargo test` 95/95、`deno task check` 与 `cargo fmt --check` 均已通过；正式构建成功。原生 GUI 观察来自 preview4/6/7/8/9，未在正式包上重跑完整 GUI 验收。候选整体验收仍为 PARTIAL。正式发布后补入：源码 commit 与 tag、公开下载与 sidecar 对照、GitHub Release URL。当前 DMG hash 是本地生产构建记录，不是公开下载验证；发布不代表 GIF 动画、在线 SIWC/Provider、精确字体缩放或指针拖动取消已验收。
