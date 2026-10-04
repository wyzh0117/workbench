# AI Course Workbench

本地优先的课程创作工作台：课程地图、单课编辑器、待补管理、素材、六维完成度、只审阅式 AI 助手，以及发布与导出中心。项目数据保存在你自己磁盘上的开放 `project.json`。

技术构成：Deno 服务/领域层、无依赖 Web UI 以及受限的 Tauri 2 壳。Canonical 项目数据保存在开放的 `project.json`；Markdown、课程地图、搜索索引、缩略图和诊断日志都是可重建镜像或缓存。

---

## Download

> **当前状态：公开下载已恢复。** 仓库已重新设为 **public**，下面的链接对匿名访问者可用。

当前开发候选为 v0.2.6；它尚未发布，`releases/latest`、固定下载链接和 SHA-256 sidecar 继续指向已冻结的 v0.2.5。最终冻结源码通过 `deno task check` 和 `deno task test`（602/602，含 loopback），Rust 测试 222/222；本地 Universal App/DMG 通过架构、版本和完整性检查，尚未做本机原生 smoke（Mac 锁屏），本地包未签名/公证。Overview 在 1024/1280/1440/1728×900 测量通过；其余页面、部分 overlay 和 Free Layout 删除/重开/导出仍按验收报告标记为 PARTIAL。详见 [v0.2.6 completion report](docs/reports/v0.2.6-ui-redesign-completion-report.html)、[候选 feature history](docs/feature-history/v0.2.6.md) 与 [候选构建证据](docs/reports/evidence/v0.2.6/candidate-build-final.md)。

**下载最新 macOS 安装包（DMG）：**

| 入口 | 链接 |
|---|---|
| 最新版本页面（含 Release Notes） | https://github.com/wyzh0117/workbench/releases/latest |
| 直接下载最新 DMG（固定链接，始终指向最新版本） | https://github.com/wyzh0117/workbench/releases/latest/download/AI-Course-Workbench-macOS.dmg |
| 下载最新 DMG 的 SHA-256 校验文件 | https://github.com/wyzh0117/workbench/releases/latest/download/AI-Course-Workbench-macOS.dmg.sha256 |

把第二个链接粘贴到 Safari / Chrome 回车，浏览器就会开始下载最新的 `AI-Course-Workbench-macOS.dmg`，不需要先找 Assets，也不需要判断版本号。

SHA-256 会随版本更新，可下载上述 sidecar 校验文件；它与固定 DMG 文件来自同一个 Release。已发布版本及其 tag、DMG 和校验值保持冻结，历史版本可在各自的 Release 页面下载。

### 系统要求与架构

```text
最低系统版本：macOS 11.0（Big Sur）
架构：Universal —— Apple Silicon（arm64）与 Intel（x86_64）同一个安装包
```

### 安装步骤

```text
1. 下载 AI-Course-Workbench-macOS.dmg
2. 双击打开 DMG
3. 把 AI Course Workbench 拖到 Applications
4. 从 Applications 打开
```

### 首次打开说明（重要）

本版本**尚未使用 Apple Developer ID 签名与公证**（原因见下方「分发状态」），所以首次打开时 macOS 会拦截，
提示「无法验证开发者」或「Apple 无法检查其是否包含恶意软件」。这是**预期行为，不是安装包损坏**。

放行方式只需要做一次，但**取决于你的 macOS 版本**：macOS 15 (Sequoia) 及更新版本已经取消了
「右键 → 打开」这条捷径（Apple 官方说明：Control-click 不再能绕过 Gatekeeper，
必须到「系统设置 → 隐私与安全性」里确认）。

**macOS 15 (Sequoia) / 26 及更新版本**

```text
1. 双击 AI Course Workbench，出现「无法打开，因为 Apple 无法检查其是否包含恶意软件」时点「完成」
2. 打开「系统设置」→「隐私与安全性」
3. 在「安全性」区域找到「已阻止使用 AI Course Workbench，因为来自身份不明的开发者」
4. 点「仍要打开」，输入密码或 Touch ID 确认
5. 在再次出现的确认框里再点一次「仍要打开」
```

**macOS 11 (Big Sur) – 14 (Sonoma)**

```text
在「应用程序」中右键点击（或按住 Control 点击）AI Course Workbench
→ 选择「打开」
→ 在弹窗中再次点「打开」
```

两种方式都只需要做一次；放行之后双击即可正常打开。

本版不指导、也不建议关闭 Gatekeeper，或用 `xattr` 移除隔离属性。

### 校验下载完整性

每个 Release 同时提供 `AI-Course-Workbench-macOS.dmg.sha256`：

```bash
shasum -a 256 ~/Downloads/AI-Course-Workbench-macOS.dmg
```

输出应与 Release Notes 中的 SHA-256 一致。

---

## 分发状态（如实说明）

```text
DISTRIBUTION STATE = PARTIAL
BLOCKER            = 缺正式 macOS signing / notarization credentials
```

- **已有公开版**：最新正式 Release 为 v0.2.5，Universal（Apple Silicon + Intel）DMG、固定 latest 直链与 SHA-256 sidecar 均已发布并校验；已发布 tag 与资产保持冻结。
- **当前可见性**：仓库为 **public**，Release 页面与 latest 直链对匿名访问者可用。
- **未完成**：Developer ID Application 签名与 Apple 公证（notarization / stapling）。
  本机 `security find-identity -v -p codesigning` 返回 0 valid identities，没有可用的
  Apple Developer Program 分发凭据，因此**不能宣称「普通用户无安全阻碍安装」**，
  也不宣称 `PUBLIC RELEASE READY`。
- 拿到正确的 Apple Developer 分发资格后，只需要补做签名、公证、重新上传 Release 与
  一次安装 smoke，**不需要重新开发 Workbench 本体**（见 `.github/workflows/release.yml`）。
- **实测**：把 Release 资产重新匿名下载、按浏览器行为加上隔离属性后，
  `spctl --assess --type execute` 判定 `rejected` —— 上面「首次打开说明」写的就是用户真实会遇到的状态。
- **一处未实测项**：「右键 → 打开」放行**之后**的首次启动没有在自动化环境里实测过
  （无法自动投递右键菜单操作），只实测了放行**之前**的拦截状态。

---

## 当前开发位置

- 最新公开版本与校验文件通过上方 `releases/latest` 链接动态查看；已发布版本及资产保持冻结。
- 当前版本：**V1（ACTIVE）**
- V1-T01 — V0 Hardening & UX Polish：**VERIFIED**
- V1-T02 — Dogfooding Critical Fixes & Authoring UX Refinement：**VERIFIED**
- V1-T03 — Course Authoring & Project Structure Closure：**VERIFIED**
- V1-T04 — Workspace Explorer & Existing-Folder Adoption：**VERIFIED**
- V1-T05 — Paged Canvas & Pagination：**VERIFIED**
- V1-T06 — Layout-aware Export & PPTX：**VERIFIED**
- 当前交接：**v0.2.5 已发布并冻结；v0.2.6 为开发候选**（Mapping / Preview / Flow / Free Layout / 全局 UI 重设计）
- 当前状态：**Latest public = v0.2.5；Current source = v0.2.6 candidate**。V1 ACTIVE；V1-T01–T06 的 VERIFIED 为历史任务结论，不因本轮新增任务改写。
- [Completion Report](docs/V0.2.5_Closure_2026-10-03_Completion_Report.md) · [Master Control §45](PROJECT_MASTER_CONTROL.md)：§33 19 项验收矩阵、自动化 gate、真实 UI 证据与未闭合通道；媒体库闪烁的大白话根因见 [docs/v0.2.5_media_flicker_root_cause.md](docs/v0.2.5_media_flicker_root_cause.md)。
- [v0.2.6 candidate feature history](docs/feature-history/v0.2.6.md) · [rolling UNRELEASED record](docs/feature-history/UNRELEASED.md) · [UI redesign completion report](docs/reports/v0.2.6-ui-redesign-completion-report.html)：列出本轮用户可见变化、当前证据和未闭合限制。
- 公开版与源码态的区别：**v0.2.4 及更早的公开包不含本轮四块改动**；这些改动已随 `v0.2.5` 到达用户。`v0.2.5` 的下载地址、SHA-256 与验证结果见本页上方 `releases/latest` 链接与 `PROJECT_MASTER_CONTROL.md` §45.4。已发布版本一律冻结，不会被重建或覆盖。
- v0.2.5 的用户改动清单见 [Feature Update Manual / v0.2.5](docs/feature-history/v0.2.5.md)；当前 v0.2.6 功能说明暂列在 [UNRELEASED candidate](docs/feature-history/UNRELEASED.md)，不会误写成已包含于公开包。
- 产品状态：**公开版 v0.2.5 = 已发布并完成公开产物验证**（上轮 v0.2.4 收口 15 项为 11 PASS / 2 PARTIAL / 1 BLOCKED）；**v0.2.5 的真实 Tauri 验收行按 UNCLOSED 如实记录**（原生窗口手势、真实在线 AI、媒体库真实滚动三条通道未闭合，见 Completion Report §2 与 §9），不作整体 VERIFIED 或 DOGFOOD READY 结论
- 分发状态：**PARTIAL / 公开下载可用**（v0.2.5 Universal DMG 与 SHA-256 sidecar 已匿名下载校验；制品为 ad-hoc signed，无 `TeamIdentifier`，`spctl --assess --type execute` 为 `rejected`，未做 Developer ID 签名或公证）
- V0 状态：**V0 CLOSED；V0-T01 / V0-T02 / V0-T03 / V0-T04 全部 VERIFIED**
- 最新公开版本为 [`v0.2.5`](https://github.com/wyzh0117/workbench/releases/tag/v0.2.5)（tag/source commit `d16b622c082720c3c386613df187deec3b7ec469`，workflow run `37100286505`）；[Universal DMG](https://github.com/wyzh0117/workbench/releases/download/v0.2.5/AI-Course-Workbench-macOS.dmg) 与 [SHA-256 sidecar](https://github.com/wyzh0117/workbench/releases/download/v0.2.5/AI-Course-Workbench-macOS.dmg.sha256) 已匿名下载核验（SHA-256 `a84884466b084cd674a4d0d32a52b3284863a9adb9706c11283009fb14b7f9fd`、`hdiutil verify` VALID、`x86_64 arm64`、版本 0.2.5）；[`v0.2.4`](https://github.com/wyzh0117/workbench/releases/tag/v0.2.4) 及其资产保持冻结。
- NEXT ACTION：`v0.2.5` 已发布；用户在真实窗口里补做原生验收（启动页项目列表、原生打开面板、媒体库真实滚动、正文选择窗口点击、重启走查）并发起第一次真实 AI 调用，清单见 `PROJECT_MASTER_CONTROL.md` §45.3 与 Completion Report §2 的 UNCLOSED 行；新问题按下一个版本处理，下一次发布仍需单独授权；不创建 V1-T07，不关闭 V1。
- 发版本身怎么操作（版本字段三处联动、Release Notes 规则、tag 与 workflow、发布后验证与回写、只有用户能做的部分）见 [docs/release-playbook.md](docs/release-playbook.md)。

2026-10-03 v0.2.5 发布：用户授权「开发完成后同步 GitHub 以及 tag、release 页」后，源码提交 `d16b622c082720c3c386613df187deec3b7ec469` 推送 `main`，附注 tag `v0.2.5` 触发 workflow `37100286505`（`success`，8m4s），Release 为当前 Latest（`isDraft=false`）。公开 Universal DMG（14,293,951 bytes）与 `.sha256` sidecar 匿名下载校验一致：SHA-256 `a84884466b084cd674a4d0d32a52b3284863a9adb9706c11283009fb14b7f9fd`、`hdiutil verify` VALID、`lipo -archs` = `x86_64 arm64`、包内版本 0.2.5。发布前与 tag 所在源码状态的自动化 gate 全绿：`deno task check`、Deno 584/584、`cargo fmt --check`、Rust 216/216、`cargo build`。三条验收通道带着「未闭合」发布而非记成通过：原生窗口指针 / 面板手势 smoke、真实在线 AI 调用（`api.openai.com` 60 秒超时）、媒体库真实触控板 / 滚轮滚动；逐条清单见 `PROJECT_MASTER_CONTROL.md` §45.3。正式 DMG 为 ad-hoc signed、无 `TeamIdentifier`、未公证，`spctl --assess --type execute` 返回 `rejected`。`v0.2.4` 及更早 tag / DMG / sidecar 未移动、未覆盖。

2026-10-02 v0.2.4 发布：用户授权「把项目同步到 GitHub，同时 tag 和发布新版本 release」后，源码提交 `4db396bf7c1953a62f72d3887d6ae07b03fcaa76` 推送 `main`，附注 tag `v0.2.4` 触发 workflow `36906333256`（`success`），Release 为当前 Latest（`isDraft=false`）。公开 Universal DMG（12,107,473 bytes）与 `.sha256` sidecar 匿名下载校验一致：SHA-256 `82fdba5957f57d9650f74922197e9593e981be418515e6c7e34519164cef4dab`、`hdiutil verify` VALID、`lipo -archs` = `x86_64 arm64`、包内版本 0.2.4。发布前与 tag 所在源码状态的自动化 gate 全绿：`deno task check`、Deno 522/522、`cargo fmt --check`、Rust 104/104、`cargo build`。两条验收通道按用户决定带着「未闭合」发布而非记成通过：原生窗口指针 / 面板手势 smoke（本环境 AppleScript `-1712`、截图 `could not create image from display`）与真实在线 AI 调用（`api.openai.com` 60 秒超时），逐条清单见 `PROJECT_MASTER_CONTROL.md` §43.6。正式 DMG 同样是 ad-hoc signed、无 `TeamIdentifier`、未公证，`spctl --assess --type execute` 返回 `rejected`。`v0.2.3` 及更早 tag / DMG / sidecar 未移动、未覆盖。发版操作步骤固化在 [docs/release-playbook.md](docs/release-playbook.md)。

2026-10-01 v0.2.3 验收与发布：源码提交 `0ce229ac79b925164e3ea43eae4ac8059d5022e4` 已推送，`v0.2.3` tag 触发 workflow `36805861906` 成功，GitHub Release 为 Latest。公开 Universal DMG 与 SHA-256 sidecar 均以匿名 HTTP 200 下载并校验一致；公开 DMG SHA-256 为 `62f8d6a4c00360c27452244aa0de6d2a1fb3dd9d7a9053522494e07d750a2d73`，`hdiutil verify` 通过，版本 0.2.3、架构 x86_64+arm64。preview4 PDF/PPTX 原生检查通过，PPTX 在 PowerPoint 中可打开且文字、图片可编辑。preview6–9 对编辑、追加、分页、设置、窄屏工具栏、Markdown/图片/PDF 预览及视频完成了多项原生走查；最终源码自动化为 Deno 389/389、Rust 95/95，`deno task check` 与 `cargo fmt --check` 通过。QA-only 诊断脚本及 HTML 引用已删除。preview9 验证 GIF Blob 487B、MIME、GIF89a 与 fixture SHA 一致，独立 IMG 从同字节加载为 160×90；但本机 WKWebView 中 modal 与独立 IMG 在 2.65 秒内都只观察到红帧，动画未通过/未闭环，不能归因于源文件损坏。最终无诊断 QA 轻抽检确认正文聚焦行显示自己的 +/⋯ 操作，顶部设置进入 AI 模型管理且课程地图可达。preview8 窄屏工具栏可读；精确 1024/字体缩放、指针拖动取消及在线 SIWC/Provider 请求未验证。原生 GUI 观察来自 QA 快照，未在正式包上重复完整 GUI 套件。正式 DMG 为 ad-hoc signed、无 `TeamIdentifier`，`spctl --assess --type execute` 返回 `rejected`；未做 Developer ID 签名/公证。preview6–9 为隔离 QA 包，不是发布物。详见 [v0.2.3 验收报告](docs/V1_Feedback_Import_Rendering_AI_Settings_2026-09-30_Acceptance_Report.md)。

T05/T06 自动化检查为 346/346，Rust 检查 78/78；这些是 §38 历史验收证据。页面恢复修复已在隔离桌面项目上连续两次重启验证；T05/T06 的 Universal app 恢复了 page 3。原生 PDF smoke 输出一页 960×540 pt，正确包含第 3 页标题与正文。PowerPoint 已打开三页 PPTX 且未触发 Repair，并在副本中验证文字与图片可编辑。三页、两张图片的 Static Web 样例已通过独立 Chrome `file://` 阅读检查。此前 `v0.2.1` 由 tag-triggered run `36325086880` 成功发布；其公开 Universal DMG SHA-256 为 `ca151a578065939f6c2e0dfa4f23955faee5f512c6833ccbe4931a68bf66817c`，匿名下载与 `.sha256` sidecar 校验一致。`v0.2.0` 失败 tag 保持冻结且没有 Release/资产。当前公开版本及 `v0.2.2` 分发状态见上方；DMG 为 ad-hoc signed，未做 Apple Developer ID 签名或公证。

2026-09-29 本地验证属于 v0.2.2 的历史快照，不代表当时的 v0.2.3 候选：当时的 Deno 357/357 与 Rust AI 定向 32/32 在后续导入改动前运行；原生 smoke 覆盖 PDF、图片/GIF、音视频、Markdown、课程地图、Undo/Redo 与导入素材副作用。真实在线 Provider 调用未验证。当前公开版本与逐项验收以本节上方摘要、`PROJECT_MASTER_CONTROL.md` §43 与 [Feature Update Manual / v0.2.4](docs/feature-history/v0.2.4.md) 为准。
- 分发边界：v0.2.3 与 v0.2.4 均已公开且冻结；后续改动使用新的版本与 tag。Developer ID 签名、公证与签名版安装 smoke 仍需取得 Apple 分发凭据后完成。

---

## 路线规划（V2 · 只记录路线，不开发）

**这一节不是开发授权。** V2 只有在 V1 正式收口并且用户明确批准之后才会激活；在那之前不创建 V2 任务卡、不改变当前版本状态。完整规划见 `PROJECT_MASTER_CONTROL.md` §4 与 §44。

规划中的 V2 任务（编号沿用旧草案，暂不重新编号，避免任务名漂移）：

| 编号 | 方向 | 要点 |
| --- | --- | --- |
| **V2-T02** | Project Library + Model & Skill Center | 把本轮的「历史项目列表」升级为真正的资源库（收藏 / 标签 / 封面 / 完成度 / 待补 / 路径状态 / 搜索筛选）；模型管理**只复用**已有能力，不扩传输层；新增 Skill 管理，与模型同处一个「设置 → AI」入口 |
| **V2-T03** | Reuse & Templates | Block / Lesson / Stage 复制、模板、跨项目复制、素材复用；必须分清「复制」与「链接引用」，默认复制后独立，A 课的修改不得静默改到 B 课 |
| **V2-T04** | Search / Audit / Maintenance | 跨项目搜索、待补与状态筛选、缺失素材检查、来源变化检查、长期未更新内容、外链检查、内容审计 |
| **V2-T06** | Batch & Automation | 批量改状态 / 移动 / 重新导入 / 来源更新 / Requirement / AI Review / 摘要；仍然必须 Plan → Preview → 用户确认 → Apply，不做后台静默 Agent |

规划的依赖顺序：**V2-T02 → V2-T03 → V2-T04 → V2-T06**（先有多项目管理，才谈跨项目复用，再做维护审计，最后才是批量自动化）。

已经从路线中删除、不会自动恢复的方向：

- `V2-T01 Universal Content Import`：用户要求的九类文本 / 文档格式已全部前移到 **v0.2.5** 本轮实现，「继续兼容更多文本文件」不再是独立路线；以后出现新格式按真实使用反馈进入 Backlog，不预先建设无限格式平台。
- `V2-T05 AI / Connector Platform`：并入 V2-T02，**只保留 Skill**；MCP 平台、Connector 生态、新模型架构、新 Provider 协议框架全部删除。模型能力只使用已实现的部分，后续允许 bug 修复、Provider 兼容性修复、安全更新与必要的小幅 UX 调整，不再把模型管理扩成一个大系统。
- `.gitignore` / `.workbenchignore` 式系统文件过滤方案（含各类目录黑名单）：此前提案废止，不开发。导入范围由「用户勾选的映射对象」+「明确支持的扩展名」两层自然收敛。

Skill 的边界（V2-T02 开工时锁定细节）：安装不等于自动获得权限，至少区分读取 Block / 读取 Lesson / 读取 Course / 使用模型 / 提出 ChangeDraft；产出仍走 `Suggestion → ChangeDraft → Diff → 用户审阅 → Apply`，不得绕过 Canonical 安全边界，也不得偷偷切换更贵的模型或未授权账户。

---

## 开发者运行

以下内容面向参与开发的工程师。**普通用户请从上面的 Download 入口下载安装包。**

需要 Deno 2：

```bash
deno task check
deno task test
deno task ui
```

浏览器打开 `http://localhost:4173` 可检查三栏工作台、课程地图、单课编辑器（正文/结构/排版/预览）、Flow/Grid、媒体库、待补总览、六维状态、收件箱、快速收集、版本恢复、AI 助手（上下文范围 / Diff 审核）、发布与导出中心（范围 / 格式 / 导出前检查 / 发布记录）以及 Markdown、HTML、富文本迁移版下载。没有 Rust 工具链时仍可完成服务层与 UI 契约验收；Static Web Package、PDF、项目 JSON、素材包与完整项目包由桌面壳生成。审查壳的 HTML 与富文本迁移版目前共用同一轻量渲染器，因此它的「富文本迁移版」下载与 HTML 下载内容相同、不含迁移提示；带迁移提示的迁移版由桌面壳导出。

桌面壳（需要 Rust 工具链）：

```bash
cargo build --manifest-path src-tauri/Cargo.toml
./src-tauri/target/debug/ai-course-workbench                      # 从上次的位置继续
./src-tauri/target/debug/ai-course-workbench --project-dir /绝对/路径   # 启动即打开该课程
```

构建与发布完全一致的正式分发包（Universal DMG，产物在 `src-tauri/target/universal-apple-darwin/release/bundle/`）：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cargo tauri build --target universal-apple-darwin --bundles app,dmg
```

DMG 内的对外资产名固定为 `AI-Course-Workbench-macOS.dmg`（版本号只出现在 Release Tag、Release Notes 与 App bundle metadata 中），这样 `/releases/latest/download/AI-Course-Workbench-macOS.dmg` 才能长期指向最新版本。

**发版规则：已发布的 tag 不可变。** 一个 tag 一旦发布，它和它的 DMG 就冻结了：

```text
发现问题 → 修代码 → 新 commit → 新 tag → 新 Release
（例如 v0.1.0 发现 Bug → 修复 → v0.1.1）
```

**不要**用修复后的代码重新构建同一个 tag，也不要覆盖已发布 Release 的资产。文件名固定不变，
但**同一个版本号的字节永远不变** —— 只有这样，用户下载到的文件才能长期和 Release Notes 里的
SHA-256 对得上。（完整规则见 `PROJECT_MASTER_CONTROL.md` §0.4。）

`--project-dir`（可写 `-p <路径>`）必须是绝对路径，目录不存在或参数缺值会在开窗前退出并打印原因。不传参数时应用读取 `.workspace/session.json` 恢复上次的项目与阅读位置（当前课、模式、右栏、所在视图）。

需要另一个隔离项目（例如验收用的临时课程）时可以指定根目录与端口：

```bash
PROJECT_ROOT=/path/to/project PORT=4174 deno run --allow-net --allow-read --allow-write --allow-run=/usr/bin/security --allow-sys --allow-env scripts/dev_server.ts
```

## 已支持

- CourseSeed → BlueprintDraft → 用户确认后生成课程结构；
- Course Map：整门课程结构、当前课标记、每课完成度/待补/缺素材、任意课一键进入、上一课/下一课/继续未完成；
- Lesson Editor：当前课与当前 Block 明确，正文可新增/修改/删除/换类型/拖动重排，结构与正文共享同一份 Block 数据并互相定位；
- Block 正文、Requirement（内容/排版分开）、Asset/Usage、六维状态、Flow/Grid/Section；
- 素材 Authoring：有界只读预览（`asset_read` 原生命令 / `/api/asset` 服务路由）、插入区块、建立 AssetUsage、解除引用、删除前引用确认；素材链接同时写入 `settings.asset_id` 与文件名，编辑器、预览与导出读取同一份引用；
- Requirement 生命周期：创建、编辑备注/类型/优先级、定位、用素材完成、重新打开、删除，以及跨课待补总览；
- Preview 与导出读取同一份 Canonical 正文；单课完成度由六维状态 + 待补 + 素材 + 排版派生，不单独保存；
- 重启后恢复上次的课、模式、右侧面板、所在视图与选中区块（UI session 不含凭据字段）。桌面壳把会话写入应用数据目录，已在真实窗口中验证「关闭 → 重启 → 继续」；浏览器壳把同一份会话写入 `<project>/.workspace/browser-session.json`（带版本号、字段白名单与 64KB 上限，只保存阅读位置这类可重建状态），刷新页面后课程位置与右侧面板都会恢复，文件缺失 / 损坏 / 属于别的项目时安全降级为默认视图而不是白屏或写错项目；
- 切换项目只提交新项目自己的状态：按 `project_id` 分别保存每个项目的阅读位置，切换到 B 不会把 A 的课次或面板带过去，切回 A 时仍回到 A 原来的位置；切换失败时保留原项目会话，不写半套状态；
- 打开文件夹先做只读分类再动作：有可用的 `project.json` 直接打开；属于旧 schema 先结构修复（`project.id` 原样保留）；坏文件 / 太新的文件 / 不是课程文件都给出具体字段级原因；没有 `project.json` 则进入导入扫描。父目录下每个子目录各是一个项目时，父目录不会被当成其中任何一个；
- 应用级项目登记表与启动页：列出全部历史项目（最近打开优先、id 稳定排序），文件夹被移走的那一行标明「找不到」并可「重新定位」（新路径里的 `project.id` 必须一致）或「从列表移除」（只删行、不碰磁盘）；同一项目出现两个副本时询问用户而不是擅自合并。登记表是可重建索引：不含课程正文、不含任何密钥，删除它只丢「最近打开」列表；
- 九类文本 / 文档作为正文导入（`.txt` `.text` `.md` `.markdown` `.tex` `.latex` `.docx` `.epub` `.pdf`）：按文档原本结构落位（标题层级、段落、加粗 / 斜体 / 删除线、引用、列表、代码、表格、链接、文档内嵌图片）；映射确认后媒体递归自动进素材库，文档候选进入「选择要导入为正文的文档」窗口（分组、全选 / 全不选 / 行点击）；导入严格服从已确认的映射计划，单文件失败只降级该文件，结果给出成功 / 降级 / 跳过 / 失败的逐文件回执；来源文件不移动、不改名、不删除、不覆盖，重复来源默认跳过、不静默替换已编辑正文；
- 媒体库滚动稳定性：预览完成只就地更新对应卡片（不再整页重建）、正在显示的卡片不会被缓存淘汰、同一素材不会重复读取、淘汰前先重画再释放并给出「已释放 / 重试预览」，120 张卡来回滚动的回归用例钉住整条状态机（根因说明见 [docs/v0.2.5_media_flicker_root_cause.md](docs/v0.2.5_media_flicker_root_cause.md)）；
- 项目被另一实例持有时启动会给出可读提示并保留上次位置，不会清空「继续工作」入口；前端资源加载失败时窗口显示失败原因，而不是空白页；
- 写入前一致性校验：编号唯一、待补/素材/排版/收件箱引用完整，磁盘上的项目被替换时停止写入而不是覆盖；
- 原子写入、自动保存恢复日志、项目锁、外部修改检测、历史版本恢复前备份；
- Canonical 图在保存/迁移时执行 FK、枚举、唯一性和跨项目校验；正文分组、Block 移动可撤销；
- 素材导入保留真实文件字节并可复核 checksum/引用；外部修改提供差异和三方合并预览；
- AI 助手进入现有三栏工作台：可选择课程 / 当前课次 / 当前区块三种上下文范围，调用前先「预览」本次实际会发送的条目与字数，并单独列出「不会发送」的类别（例如区块范围不发送本课其他区块的正文，任何密钥字段都不进入上下文）；
- AI 上下文由 Canonical 与现有投影现场装配，不复制出第二份「AI 版课程数据」；同一份输入稳定可复现，装配过程只读、不改动项目（`app/ai.js` 的 `assembleAiContext`）；
- 统一 Connector 边界：DeepSeek / 火山方舟（豆包）/ OpenAI / 自定义 OpenAI 兼容接口，以及完全离线、确定性的「本地确定性连接器」；请求组装、JSON 与 SSE 响应归一化、timeout / cancel / 缺密钥 / 限流 / Provider 错误 / 无法解析的返回都在同一层处理，业务逻辑不绑定任何一家 API 形状；
- API Key 由所在进程注入（桌面壳走 Rust `ai_complete`，浏览器壳走本地服务），页面拿不到密钥；macOS 两条路径都把密钥写入系统钥匙串，`providers.json` 只保留服务商元数据，不进入 `project.json`、Canonical、导出包或执行记录；
- 非修改型请求只产生 Suggestion；修改型请求产生 ChangeDraft（target / operation / before / after / 理由 / 校验结果），Diff 逐条展示「修改前 / 修改后」，Reject 不动正文，Apply 前重新做 domain 校验并在深拷贝候选上一次性落盘，失败不留半写入；
- Apply 与人工编辑共用同一套 `commit` / history / undo / redo / autosave 路径：撤销回到应用前，重做回到应用后，保存 / 关闭 / 重启 / 重开后数据一致；
- AI 执行记录写入工作台本机数据区（桌面壳在应用数据目录、浏览器壳在 `<project>/.workspace/ai/`，均为非 Canonical、可重建）：记录时间、范围、指令、Provider / Model、结果类型、成功 / 失败 / 取消与错误码，以及 Apply / Reject 结论；写入失败只提示、不影响课程保存，且不含任何密钥；
- 高层命令边界、结构化错误、凭据字段拒绝、HTML/路径安全检查；
- 本地/导入式对话连接器：只有用户主动 `sync` 且显式选择的会话进入 Canonical；
- 可重建搜索索引（默认使用 `.workspace/index.json`；未注入原生 SQLite 时不会伪装成 SQLite）；
- 发布与导出（Output & Publish）：同一份 Canonical 通过只读 Publish Projection 生成 Markdown（当前课 / 整门课程）、Semantic HTML、Static Web Package（`index.html` + `manifest.json` + 实际使用的素材）、PDF（原生 PDF 1.4，中文走 STSong-Light）、微信 / 富文本迁移版 HTML、Project JSON、素材包与完整项目包；导出前检查（preflight）区分 BLOCKING（引用素材文件不存在、路径非法等，必须修复且不生成半成品）与 WARNING（仍有待补、外部引用、媒体降级，可确认后继续），导出结果给出实际位置并可在系统里打开，用户确认后可记录发布节点；
- 导出严格只读：不修改 Canonical 正文 / 排版 / 素材引用，也不修改素材文件本身；导出包不含 AI 执行记录、诊断日志、lock/session 私有文件与任何密钥；
- Deno 核心/服务/导入导出/完整性/Authoring/Authoring UI/AI 工作流/AI 传输/原生启动测试覆盖恢复、Grid、AI 上下文与权限、连接器故障隔离与错误码归一、ChangeDraft 原子应用、执行记录、安全、旋转诊断、规模搜索、三方合并、课程地图与单课投影、区块与待补生命周期、素材引用与删除安全、Flow/Grid 持久化、重开后的数据一致；
- `tests/native_boot_test.ts` 用假的 `__TAURI__.core.invoke` 跑真实模块启动流程，覆盖 `--project-dir` 打开、会话写回、重启恢复到同一课/模式/视图，以及目录失效与租约冲突两种降级路径。

## 明确未支持

- 输出能力边界：PNG / JPG 位图输出在 V0 明确不支持，导出中心不提供该格式卡片；服务层 `preflightExport` 对 png/jpg 报 `unsupported_format`，桌面壳原生导出对未知格式直接返回「当前原生导出不支持这个格式」。复杂长图 / 海报系统列为 V0 REJECTED，已有 SVG / 分区导出不回归；PDF 使用系统 CJK 字体（STSong-Light + UniGB-UCS2-H），另存/取词依赖阅读器对该字体的支持，视觉渲染已用真实页面 OCR 核对；
- 媒体降级是显式设计：Markdown / 富文本迁移版 / PDF 中 video、audio、document 与 PDF 中的 GIF 以非交互附件说明呈现，并在导出前检查里作为 WARNING 逐条列出；
- 微信 / 富文本迁移只做到「可复制结构」：本轮用真实 Chromium 打开导出的迁移版 HTML，并用 `contenteditable` 接收页做粘贴结构验证（标题 / 段落 / 图片顺序正确、无脚本、无 Workbench 私有 class）。**未验证真实微信公众号后台**：不做登录、授权、草稿箱 API 或自动发布，也不承诺目标平台保留我们无法控制的样式；
- Tauri 壳目前只提供受限高层命令骨架；真实平台发布（自动上传 / 登录）仍未支持。macOS 系统钥匙串适配器同时用于桌面壳与本地浏览器审查服务；Windows 是明确的非目标平台；
- 历史 `providers.json` / `providers.bak` 中的明文 API Key 会在首次读取时迁移到 macOS 系统钥匙串，只有写入并校验成功后才删除明文；迁移失败会保留原文件并给出可读提示，不回显密钥；
- **尚未完成真实在线 Provider 调用验收**：真实 ChatGPT 订阅凭据确实存在于 macOS 钥匙串（收口轮只读取元数据、未打印任何密钥），但该环境到 `api.openai.com` 的出网请求 60 秒超时，因此真实登录、套餐范围、账户模型清单与一次完成的推理都没有被观察过；本地服务内是用离线连接器与本地桩目录服务走通完整阶段链的。真实 Provider 的请求组装、鉴权注入与错误码映射有自动化测试覆盖（含回环 HTTP 服务器），请勿把离线闭环当作「已联网验证」；
- AI 面板不做逐字流式渲染：连接器已能归一化 SSE 与非流式响应，界面按完整结果展示；
- 不做 AI 后台自动执行、多 Agent 调度、RAG / 向量数据库，也不做绕过 ChangeDraft 的直接写入；
- 原生壳未提供在创作期间打开系统默认应用查看素材；键盘快捷键只保留撤销/重做/保存/搜索与快速收集；
- 文本 / 文档导入的边界（如实说明）：扫描版 PDF 不做 OCR——没有文本层时只保留为参考文件并说明，不假装导入正文；PDF 只提取文本层，不导入内嵌图片（位置不可靠，保留原 PDF 为来源引用）、表单字段与批注，不执行任何 PDF 脚本，多栏按「页序 + 内容流顺序」输出；LaTeX 只做词法级识别，数学公式以代码形式保留（源码不丢），未知命令按原文保留并提示；`.txt` 刻意不猜标题（全部按段落）；EPUB 不解析 CSS（只用 class 名做弱标题提示）；DOCX 忽略 Word 主题 / 字体 / 字号 / 颜色 / 页边距 / 页眉页脚 / 文本框 / WordArt 等装饰样式；未列出的文件类型既不自动作为正文也不自动作为素材——不做 `.gitignore` / `.workbenchignore` 式系统文件过滤，也不做目录黑名单；
- 浏览器 UI 是无依赖审查壳，文件选择和复杂拖拽体验仍需接入正式 Tauri 命令；
- 不提供后台聊天抓取，不将 API Key、Cookie、Token 写入项目、Git、导出或诊断包。

## 目录边界

`src/domain/` 保存 Canonical schema 与确定性业务规则；`src/service/` 保存存储/恢复、错误/诊断、搜索、连接器、AI 传输、导入/导出和高层命令；`src/ui/` 是 UI 契约与 Grid 计算；`app/` 是可直接打开的 Web UI（`authoring.js` 是课程地图/单课/完成度投影，`ai.js` 是 AI 上下文装配与连接器契约，`views.js` 是渲染层，`canvas.js` 是素材预览缓存，`constants.js` 是壳与视图层共用常量，`main.js` 是存储模型与桌面桥接）；`src-tauri/` 负责受限桌面桥接，以及文本 / 文档解析层（`src-tauri/src/documents/`）与应用级项目登记表（`registry.rs`）。SQLite、日志、恢复、AI 执行记录和缩略图等工作台数据不得反过来成为项目唯一真相。
