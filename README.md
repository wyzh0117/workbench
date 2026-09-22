# AI Course Workbench

本地优先的课程创作工作台：课程地图、单课编辑器、待补管理、素材、六维完成度、只审阅式 AI 助手，以及发布与导出中心。项目数据保存在你自己磁盘上的开放 `project.json`。

技术构成：Deno 服务/领域层、无依赖 Web UI 以及受限的 Tauri 2 壳。Canonical 项目数据保存在开放的 `project.json`；Markdown、课程地图、搜索索引、缩略图和诊断日志都是可重建镜像或缓存。

---

## Download

**下载最新 macOS 安装包（DMG）：**

| 入口 | 链接 |
|---|---|
| 最新版本页面（含 Release Notes） | https://github.com/wyzh0117/workbench/releases/latest |
| 直接下载最新 DMG（固定链接，始终指向最新版本） | https://github.com/wyzh0117/workbench/releases/latest/download/AI-Course-Workbench-macOS.dmg |

把第二个链接粘贴到 Safari / Chrome 回车，浏览器就会开始下载最新的 `AI-Course-Workbench-macOS.dmg`，不需要先找 Assets，也不需要判断版本号。

### 当前已发布版本

```text
Release Tag ：v0.1.0
文件名      ：AI-Course-Workbench-macOS.dmg（固定不变，版本号只在 Tag 与 Release Notes 里）
大小        ：10,357,233 字节
SHA-256     ：59597a342109785e190d9dc8194d841744249dbbc46498ee594572d2d2412573
```

因为文件名固定不变，上面那条「直接下载最新 DMG」链接在以后发布 `v0.1.1`、`v0.2.0` 时**依然有效**，
永远指向最新版本；只有 Release Notes 与 SHA-256 会随版本更新。

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

- **已完成**：正式 Release 构建（非 Debug）、Universal（Apple Silicon + Intel）DMG、
  公开 GitHub 仓库与 Release、固定 latest 直链、SHA-256 校验。
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

- 当前版本：**V1（ACTIVE）**
- V1-T01 — V0 Hardening & UX Polish：**VERIFIED**
- 当前任务：**V1-T02 — macOS Distribution & Public Release Closure**
- 当前状态：**PARTIAL**（BLOCKER：缺正式 macOS signing / notarization credentials）
- 产品状态：**DOGFOOD READY**
- 分发状态：**PARTIAL**（DMG / Release / 固定直链已完成；签名与公证未完成）
- V0 状态：**V0 CLOSED；V0-T01 / V0-T02 / V0-T03 / V0-T04 全部 VERIFIED**
- NEXT ACTION：**获取 Apple Developer 分发资格后补做签名 / 公证 / Release 重传 / smoke**

---

## 开发者运行

以下内容面向参与开发的工程师。**普通用户请直接使用上面的 Download 入口。**

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
- **尚未完成真实在线 Provider 调用验收**：本轮环境没有为工作台配置任何合法 Provider 凭据，真实 Tauri 窗口内是用离线的「本地确定性连接器」走通完整闭环的。真实 Provider 的请求组装、鉴权注入与错误码映射有自动化测试覆盖（含回环 HTTP 服务器），但没有一次真实在线 smoke，请勿把离线闭环当作「已联网验证」；
- AI 面板不做逐字流式渲染：连接器已能归一化 SSE 与非流式响应，界面按完整结果展示；
- 不做 AI 后台自动执行、多 Agent 调度、RAG / 向量数据库，也不做绕过 ChangeDraft 的直接写入；
- 原生壳未提供在创作期间打开系统默认应用查看素材；键盘快捷键只保留撤销/重做/保存/搜索与快速收集；
- Word/PDF 内容解析只作为参考素材导入，不伪装成可编辑正文；
- 浏览器 UI 是无依赖审查壳，文件选择和复杂拖拽体验仍需接入正式 Tauri 命令；
- 不提供后台聊天抓取，不将 API Key、Cookie、Token 写入项目、Git、导出或诊断包。

## 目录边界

`src/domain/` 保存 Canonical schema 与确定性业务规则；`src/service/` 保存存储/恢复、错误/诊断、搜索、连接器、AI 传输、导入/导出和高层命令；`src/ui/` 是 UI 契约与 Grid 计算；`app/` 是可直接打开的 Web UI（`authoring.js` 是课程地图/单课/完成度投影，`ai.js` 是 AI 上下文装配与连接器契约，`views.js` 是渲染层，`canvas.js` 是素材预览缓存，`constants.js` 是壳与视图层共用常量，`main.js` 是存储模型与桌面桥接）；`src-tauri/` 只负责受限桌面桥接。SQLite、日志、恢复、AI 执行记录和缩略图等工作台数据不得反过来成为项目唯一真相。
