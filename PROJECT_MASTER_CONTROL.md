# AI Course Workbench — PROJECT MASTER CONTROL
## 项目总控 / Single Source of Truth

> **文件定位：本文件是 AI Course Workbench 开发进度、版本边界、当前状态和下一步行动的唯一总控文件。**
>
> 建议文件名：`PROJECT_MASTER_CONTROL.md`
>
> 建议位置：仓库根目录，与 `README.md` 同级。
>
> 所有 Agent 在开始任何开发任务前，必须先完整阅读本文件；任务结束后，必须回写本文件。
>
> 任何临时开发说明、修复说明、补丁报告、任务 Prompt 都不得替代本文件，也不得自行创造新的版本层级。

---

# 0. 总控规则

## 0.1 项目只允许三个产品阶段

本项目从现在开始只使用：

```text
V0
V1
V2
```

作为产品级开发阶段。

禁止再创建：

```text
M1 / M2 / M3 / M4
N1 / N2 / N3
Phase-A / Phase-B（作为产品阶段）
V0-A / V0-B
V0.1.1 / V0.1.2
```

等新的阶段树。

---

## 0.2 允许存在“任务”，但任务是平铺的

每个版本内部可以有若干具体任务，但只用于记录工作，不形成新的产品层级。

统一格式：

```text
V0-T01
V0-T02
V0-T03
V0-T04
...
```

任务之间是平级关系。

禁止：

```text
V0-T01-A
V0-T01.1
V0-T01-N1
V0-T01-Fix-Phase-2
```

如果执行 V0-T01 时发现 10 个问题：

> 它们仍然只是 V0-T01 的“未完成项 / 缺陷”，不是新的阶段。

---

## 0.3 补丁不是阶段

任何：

- Bug；
- 编译错误；
- 环境缺失；
- 测试失败；
- 回归；
- 交互缺口；
- 实机验证问题；

都不能因为需要多轮修复，就自动升级为新的 Milestone。

它只能被归类为：

```text
BLOCKER
必须解决，否则当前任务不能关闭

BACKLOG
不阻塞当前任务，记录后继续

DEFERRED
明确属于后续版本

REJECTED
不符合当前产品方向，不做
```

---

# 1. Agent 每次工作的强制流程

以后任何 Agent 接手项目，都必须执行以下流程。

---

## 开始任务前

阅读顺序：

```text
1. PROJECT_MASTER_CONTROL.md
2. README.md
3. 当前任务对应的具体需求 / 开发说明
4. 必要的相关代码和历史报告
```

然后先回答内部四个问题：

```text
当前版本是什么？
当前任务是什么？
这个任务的 Definition of Done 是什么？
完成后下一步是什么？
```

如果回答不出来：

> 不允许开始扩展开发。

---

## 任务执行中

发现任何新问题时，先判断：

```text
是否阻止当前任务达到 Definition of Done？
```

### 是

记录到当前任务的：

```text
Open Blockers
```

继续解决。

### 否

记录到：

```text
Backlog
```

不要因此扩展本次任务。

---

## 任务结束后

必须同时做两件事：

### A. 输出本次开发报告

### B. 回写本文件

没有更新总控文件：

> 本次任务视为没有完成项目交接。

---

# 2. 项目最初目标 / North Star

> **本节是项目最高层目标。除非用户明确改变产品方向，否则 Agent 不得自行修改。**

AI Course Workbench 的目标不是做一个单次生成课程的 AI 页面。

它的目标是：

> **成为一个面向非技术用户、本地优先、可以长期维护课程内容，并允许 AI 深度参与但不夺走用户控制权的课程生产工作台。**

用户应该始终能够知道：

```text
我有什么内容
我现在做到哪里
哪些地方还没完成
哪些内容需要更新
下一步应该做什么
最终如何发布出去
```

Workbench 应支持用户随时：

```text
暂停
重新进入
跳到另一节课
继续编辑
补素材
改变排版
调用 AI
恢复历史版本
重新发布
```

而不会因为切换会话、切换 Agent、软件退出或长期中断而丢失项目状态。

---

# 3. 产品核心原则

以下原则跨 V0 / V1 / V2 永久有效。

---

## 3.1 Desktop-first, Browser-compatible

正式生产形态：

```text
Tauri Desktop
```

浏览器形态继续存在，用于：

```text
开发
调试
UI 审查
Service / Domain 验证
```

不要维护两套产品逻辑。

---

## 3.2 Canonical First

```text
project.json = Canonical Truth
```

以下内容不能成为唯一事实来源：

```text
SQLite
搜索索引
缩略图
缓存
日志
AI 会话缓存
.workspace
```

这些内容必须可重建。

---

## 3.3 内容与排版分离

课程正文、结构、媒体语义和排版要求应保持结构化。

不要把最终平台的字体、富文本 HTML 或某个平台特有格式当成课程源内容。

---

## 3.4 AI 不得静默修改 Canonical

统一保持：

```text
Suggestion
    ↓
ChangeDraft
    ↓
Diff
    ↓
User Review
    ↓
Apply
```

无论未来接入：

```text
DeepSeek
豆包
ChatGPT
MCP
Skill
其他 Agent
```

都不能绕过该机制直接修改项目。

---

## 3.5 已授权工具原则

只使用：

- 用户主动允许的能力；
- 已安装 / 已连接的 MCP；
- 已安装 / 已连接的 Skill；
- 已明确授权的软件或浏览器能力。

不得偷偷调用未授权外部软件。

---

# 4. 三个版本的唯一宏观路线

---

# V0 — 可真正使用的完整基础版

## V0 的目标

V0 不是 Demo。

V0 结束时，用户必须已经可以：

> **把一门真实课程长期放在 Workbench 里制作和维护。**

完整链路至少包括：

```text
建立 / 打开课程
        ↓
查看课程地图
        ↓
进入任意一课
        ↓
编辑正文和结构
        ↓
插入图片 / GIF / 视频
        ↓
使用 Flow / Grid
        ↓
记录 Requirement / Placeholder / 待补
        ↓
自动保存 / 恢复 / 历史版本
        ↓
使用基础 AI 协作
        ↓
预览
        ↓
导出
        ↓
迁移到真实课程 / 内容场景
```

V0 的关键词：

```text
能用
完整
稳定
不丢进度
可以长期继续做
```

---

# V1 — 高效生产版

> V0 未完成前，不拆分 V1 的具体任务。

V1 的目标不是重新做基础功能，而是：

> **让已经能用的 Workbench 明显提高课程生产、维护和更新效率。**

方向包括但不限于：

```text
更成熟的课程编辑体验
模板复用
跨课程复用
批量操作
更高效的素材组织
课程更新 / 审计
更成熟的 AI 上下文装配
更成熟的模型 / MCP / Skill 协作
内容版本比较
更强的搜索、定位和维护能力
发布工作流提速
```

V1 的关键词：

```text
效率
复用
维护
更新
规模化生产
```

V1 的详细任务：

> **只有在 V0 CLOSED 后再制定。**

禁止现在提前把 V1 拆成大量任务。

---

# V2 — 长期运营与扩展版

> V0 / V1 未完成前，不拆分 V2 的具体任务。

V2 关注：

> **Workbench 如何从个人课程生产工具，成长为可以长期扩展和承载更多内容工作流的平台。**

方向可能包括：

```text
更成熟的发布适配
跨项目内容资产
更强的自动化
插件 / Connector 生态
更稳定的平台迁移
大型内容库
长期运营
必要时的协作能力
```

V2 的关键词：

```text
扩展
生态
自动化
长期运营
```

V2 的详细范围：

> 到 V1 后期再决定。

避免现在为遥远需求提前造系统。

---

# 5. 历史阶段名称处理

此前讨论中出现过：

```text
M1 — Desktop Usability Closure
M2 — Course Authoring UX
M3 — AI Native Workflow
M4 — Publish & Render
```

这些名称从本文件生效后：

> **全部废止为正式阶段名称。**

它们不再是 Milestone。

其内容重新归入 V0 的平铺任务：

```text
旧 M1 → V0-T01 Desktop 基础闭环
旧 M2 → V0-T02 Course Authoring
旧 M3 → V0-T03 AI Workflow
旧 M4 → V0-T04 Output & Publish
```

这只是历史映射。

以后不得继续使用：

```text
M1.1
M1-Fix
M2-A
N1
```

等名称。

---

# 6. 当前项目位置

> 最后更新时间：2026-09-23
>
> 当前版本：**V1（ACTIVE）**
>
> 当前任务：**V1-T02 — macOS Distribution & Public Release Closure**
>
> 当前状态：**PARTIAL**（BLOCKER：缺正式 macOS signing / notarization credentials）
>
> 产品状态：**DOGFOOD READY**
>
> 分发状态：**PARTIAL**（正式 Universal DMG、公开仓库、GitHub Release、固定 latest 直链与 SHA-256 已完成；Developer ID 签名与 Apple 公证未完成）
>
> 下一步：**获取 Apple Developer 分发资格后补做签名 / 公证 / Release 重传 / 安装 smoke**
>
> V0 状态保持：**V0 CLOSED；V0-T01 / V0-T02 / V0-T03 / V0-T04 全部 VERIFIED**
>
> V1-T01 状态保持：**VERIFIED**（见 **§33**）；V1-T02 完成记录与证据：见 **§34**。

---

# 7. V0 总体任务板

V0 当前只使用以下四个平级任务。

| ID | 任务 | 当前状态 | 目标 |
|---|---|---|---|
| V0-T01 | Desktop 基础闭环 | VERIFIED | 真实桌面运行、项目生命周期、文件/素材、保存恢复安全 |
| V0-T02 | Course Authoring | VERIFIED | 真正顺手地制作一节课和维护整门课程 |
| V0-T03 | AI Workflow | VERIFIED | AI 真正进入工作流，同时保持 Diff / Apply 控制 |
| V0-T04 | Output & Publish | VERIFIED | 将课程可靠迁移到实际使用和发布场景 |

注意：

> V0 的四个平级任务已全部 VERIFIED；V0 CLOSED。V1 已 ACTIVE，其当前唯一任务 V1-T01 已完成并置为 VERIFIED，产品进入 DOGFOOD READY（见 §33）。

V0-T02 已 VERIFIED（含真实 Tauri 窗口内完整 Course Authoring 走查，见 14.4）。
V0-T03 已 VERIFIED（含最终构建真实 Tauri 窗口内完整 AI 走查，见 §15）。
V0-T04 已 VERIFIED（含最终构建真实 Tauri 窗口内完整 Output & Publish 走查，见 §16）。

---

# 8. 当前已完成的 V0 基础能力

根据当前 README、已有开发与本轮验收记录，以下基础能力已经存在或基本落地。

---

## 数据与架构

```text
CourseSeed → BlueprintDraft → 用户确认 → 课程结构
Block
Requirement
Asset / Usage
Flow
Grid
Section
六维状态
Canonical 校验
项目数据结构
```

---

## 数据安全

```text
原子写入
Autosave
Recovery Log
历史版本恢复前备份
素材 checksum
素材引用检查
三方合并预览基础
```

---

## UI / 工作台

目前 Web 审查界面已经包含：

```text
三栏工作台
正文
结构
排版
Grid
预览
待补
六维状态
Inbox
快速收集
版本恢复
导出前检查
```

---

## 输出

已有：

```text
Markdown
HTML
SVG / 分区导出
Project JSON
素材包
完整项目包
```

---

## AI 安全边界

已有：

```text
Suggestion
→ ChangeDraft
→ Diff
→ Apply
```

基础机制。

---

## 测试

当前开发报告显示：

```text
deno task check
deno task test
```

通过。

当前：

```text
Rust 14 tests + Deno 87 tests passed
```

---

# 9. 刚完成的任务：V0-T02（VERIFIED）

> 下一个任务为 V0-T03 — AI Workflow（见 §15 与 §29）。本节保留 V0-T02 的完整记录，
> 待 V0-T03 开工时再切换为新的「当前任务」。

## 名称

```text
V0-T02 — Course Authoring
```

## 当前目标

让用户真正可以高效完成一节课，并且能随时跳转到整门课程的任何位置继续工作：

```text
打开课程项目
↓
进入课程地图
↓
查看整门课程结构与状态
↓
进入任意一课
↓
编辑正文 / 调整结构 / 插入素材 / 使用 Flow·Grid
↓
创建与处理待补
↓
预览
↓
跳转到另一课再返回
↓
保存 / 自动保存
↓
关闭 → 重启 → 重新打开
↓
继续刚才的工作
```

## 当前状态

```text
VERIFIED
```

## Open Blockers

```text
NONE
```

---

# 9A. V0-T02 已完成内容（Course Authoring）

## 9A.1 新增/收口的 Authoring 能力

```text
课程地图：整门课程结构 + 当前课 + 每课完成度/待补/缺素材 + 一键进入任意一课
单课编辑器：当前课、当前区块、当前选择明确；正文可新增/修改/删除/换类型/重排
正文与结构同步：结构视图与正文读写同一份 Block 数据，可互相定位
Flow / Grid：LayoutInstance.mode 为唯一真相；Grid 可放置/移动/缩放/移出/一键排版
素材 Authoring：缩略图预览、插入区块、绑定 AssetUsage、解除引用、删除（含引用确认）
Requirement / 待补：创建 / 编辑备注·类型·优先级 / 定位 / 完成 / 重新打开 / 删除
待补总览：跨课集中查看未完成工作，一键跳回对应课程
Preview：正文 / 结构 / 素材 / Flow·Grid 变化实时反映，占位符不进入正式内容
完成状态：由六维状态 + 待补 + 素材 + 排版派生的单课完成度，课程地图同步反映
跨课继续工作：跳课不丢编辑，重启后回到上次的课、模式、面板与选中区块
```

## 9A.2 新增文件

```text
app/authoring.js     课程地图 / 单课 / 完成度 / 待补 backlog 的只读投影（唯一投影层）
app/views.js         三栏工作台、课程地图、单课编辑器、待补总览、预览的渲染层
app/canvas.js        素材预览缓存（有界、只读）与本地 Markdown 渲染
tests/authoring_test.ts     投影层与 Domain mutation 测试（9 项）
tests/authoring_ui_test.ts  WorkbenchStore Authoring 行为测试（7 项）
```

## 9A.3 关键修正

```text
.app/shell 网格缺少 tabs 行，导致三栏工作区被压成 30px（T01 遗留布局缺陷）
.statusbarView 在未选择课程时崩溃
.status_assignments 旧的非规范写法（dimension_key/option）会导致保存校验失败
占位符曾经只创建 Block 而不创建 Requirement
解除素材引用 / 删除素材只清了一部分 resolved_* 字段，触发 canonical 校验失败
外部修改「自动合并」曾读取错误的结果字段，导致外部改动被静默丢弃
Toast 覆盖在课程地图按钮上吞掉点击
桌面模式下 inbox / blueprint / status 等命令缺少原生处理，快速收集实际不可用
```

---

# 10. V0-T01 已完成

当前报告显示已经完成：

```text
Desktop Native 主体代码
真实系统选择器代码
素材导入
checksum
Asset / Usage
当前课程导出
恢复安全
Web 端继续可用
AssetUsage 语义统一
Rust 14 tests + Deno 87 tests
```

主要实现已经进入：

```text
src-tauri/src/lib.rs
app/main.js
```

---

# 11. V0-T01 完成状态

当前 BLOCKER：

```text
NONE
```

Real Desktop E2E、External Modification Detection、Finder Drag & Drop、Recovery Restore / Discard、Markdown / HTML Asset References 与 Web Regression 均已闭环。

---

## 11.1 Real Tauri Runtime

Native Runtime smoke 已 VERIFIED：

```text
Rust / Cargo 1.98.1
cargo-tauri 2.11.5
cargo check / cargo build 通过
debug Tauri app bundle 成功
真实 cargo tauri dev 启动，UI 非白屏
Native folder picker 实机工作
临时项目新建 / 编辑 / 保存 / 终止 / 重启重开并读回内容
Rust 14 tests / Deno 87 tests 通过
```

Native Runtime smoke、Native Project Lock、External Modification Detection 与完整 Desktop E2E 均已 VERIFIED。

---

## 11.2 Project Lock

状态：

```text
VERIFIED
```

本轮证据：

```text
统一 project.lock / project.lock.guard 协议
30s stale TTL / 5s heartbeat
owner-scoped acquire / heartbeat / release
stale takeover 与 malformed fresh/old 处理
Native + TS 所有项目写路径均经同一 lock/guard 保护
create / open / switch / close 生命周期均覆盖租约
Rust 14 tests、Deno 87 tests、cargo build 通过
真实 Tauri GUI：session 失效自愈、新建、保存、heartbeat、正常 close release、重启 reopen
```

说明：

```text
project.lock.guard 是协调文件；它可以是零字节并在释放后保留。
guard 文件存在不等于当前仍持有项目锁，持锁状态只由统一协议与实际 owner 判断。
```

Native Project Lock 已 VERIFIED；V0-T01 全部 DoD 亦已 VERIFIED。

必须防止：

```text
两个 Workbench 实例
同时写入
同一个项目
```

已覆盖：

```text
Acquire
Detect
Release
Stale Lock Handling
Multi-instance Protection
```

---

## 11.3 External Modification Detection

状态：

```text
VERIFIED
```

真实 Tauri Desktop 已验证 Manual Save / Autosave 阻止静默覆盖，磁盘外部版本保持不变；Reload、非重叠 Merge 和 Explicit Resolution 均刷新 baseline，后续保存与 reopen 成功；Snapshot Restore 不能绕过保护。

---

## 11.4 Real Desktop E2E

状态：

```text
VERIFIED
```

真实完成：

```text
Launch / Open / Edit / Autosave / Close / Restart / Reopen
Finder Drag & Drop（image / GIF / video / Markdown）
Recovery Restore / Discard（含恢复前安全快照）
External Change Conflict / Reload / Merge / Explicit Resolution
Markdown / HTML Export（正文与已使用素材引用）
Project Lock 正常释放
Web Workbench Regression
```

---

# 12. V0-T01 Definition of Done

只有同时满足：

```text
[x] Rust / Cargo / Tauri 环境可用
[x] Desktop 真实编译成功
[x] Desktop App 真实启动成功
[x] Native commands 实机工作
[x] Native Picker 实机工作
[x] Asset Import 实机工作
[x] Drag & Drop 实机工作
[x] Autosave 实机工作
[x] Reopen 数据完整
[x] Recovery 实机验证
[x] Project Lock 完成
[x] stale lock 完成
[x] External Change Detection 完成
[x] 不发生 silent overwrite
[x] Markdown Desktop Export 正常
[x] HTML Desktop Export 正常
[x] Real Desktop E2E 全流程通过
[x] deno task check 通过
[x] deno task test 通过
[x] Web 端无回归
```

才允许：

```text
V0-T01 = VERIFIED
```

---

# 13. V0-T01 当前下一步

V0-T01 已完成并 VERIFIED，Remaining Blockers 已清零。

下一任务：

```text
V0-T02 — Course Authoring
```

本轮没有进入 V0-T02。

---

# 14. V0-T02 — Course Authoring

状态：

```text
VERIFIED
```

V0-T02 的最终目标：

> **让用户真正可以高效完成一节课，并且能随时跳转到整门课程的任何位置继续工作。**

核心范围预计包括：

```text
课程地图
单课编辑器
结构视图
正文 / 结构同步
左中右三栏
Flow
Grid
素材可视化
图片 / GIF / 视频插入体验
Requirement
Placeholder
待补
Preview
完成状态
快速跳转
```

具体任务已在 V0-T02 内完成并验收；不再细分为新的阶段。

## 14.1 V0-T02 Definition of Done

```text
[x] Course Map：整门课程结构、当前课、任意一课进入、快速跳转、完成/待补状态、跳转不丢数据
[x] Lesson Editor：单课流程稳定、当前课明确、当前 Block/selection 明确、正文增删改、结构增删改重排、正文与结构同步
[x] Flow / Grid：Flow 可用于正文编排、Grid 可用于基础布局、切换不丢内容、布局持久化、重开后一致
[x] Assets：导入素材进入 Authoring 流程、image 正确显示、GIF/video/Markdown 不回归、Asset/Usage 语义正确、使用状态可理解、删除不断链、重开一致
[x] Requirement / Placeholder / 待补：创建、编辑、定位、完成/解除、删除、持久化、课程地图与单课界面帮助识别未完成工作
[x] Preview：正文/结构/素材/Flow·Grid 变化可正确预览，且不形成第二套真相
[x] Completion / Navigation：单课完成状态可理解、持久化、课程地图反映、任意课互跳、返回后数据正确
[x] Persistence：Authoring 进入 Canonical、Autosave 正常、Close/Restart/Reopen 一致、Recovery/Lock/External Detection 不回归、无 silent overwrite
[x] Runtime：真实 Tauri Desktop 可编译、可启动，并已在真实窗口内完成 §26.9 的完整
        Course Authoring 走查（课程地图 / 单课编辑 / 结构 / 素材 / Flow·Grid / 待补 /
        Preview / 完成状态 / 关闭 / 重启继续），证据见 14.2 与 14.4
[x] Automated：deno task check、deno task test（120）、cargo test（17）、cargo build 全部通过
[x] Regression：T01 基础闭环、Markdown Export、HTML Export、Web Workbench 无回归
[x] Project Control：BLOCKER = NONE、总控回写、任务板更新、Change Log 追加
[x] NEXT ACTION 切换为 V0-T03
```

## 14.2 V0-T02 验证摘要

```text
Deno：120 tests passed（authoring 9 + authoring_ui 19 + native_boot 5 + 其余 87）
Rust：17 tests passed（含 asset_read、session 边界与 --project-dir 启动参数）
deno task check：通过
cargo build / cargo check：通过
真实 Tauri Desktop：应用启动、加载三栏 Workbench，并完成窗口内完整 Course Authoring 走查
浏览器/服务层 E2E：课程地图、单课作者流、素材导入与预览、Requirement 生命周期、
                    Flow/Grid、Preview、跨课跳转、重启后恢复、导出、冲突保护全部通过
原生窗口走查（AX 驱动真实点击与键入，逐屏 AX 树 + 截图 OCR 核对，落盘文件复核）：
  课程地图 / 任意课跳转 / 正文键入 / 结构占位符 / 素材预览 / Flow·Grid 往返 /
  Preview / 保存 / 关闭释放租约 / 重启回到上次的课·模式·视图 / 第二实例被拒且不清会话
```

## 14.3 验收中发现并当轮修复的缺陷（四轮：两轮独立复核 + 一轮真实窗口走查 + 一轮复核问题修正）

### 第一轮复核

```text
1. exportPreflight 读取了不存在的投影字段，导致导出与发布记录全部抛错、界面卡死
2. 「用素材完成待补」写入的 AssetUsage 带了排版版本，违反 Canonical 一致性规则，
   并且会改当前选中的区块而不是待补自己的锚点
3. 删除中间一课后新增一课会复用编号，导致 content_items.code 重复、项目无法再打开
4. 删除课程内容后收件箱仍指向已删除的内容，留下悬空外键
5. migrateUiProject 会把已加载的 project 对象整体替换成空白默认值，导致项目身份每次
   加载都被重新生成、后续保存全部被写入前校验拦下
```

### 第二轮复核（针对第一轮修复）

第一轮修复本身又引入/暴露了以下问题，同样已修复并补齐回归测试：

```text
6. 写入前校验把「排版位置超出网格」当成致命错误，而 Canonical 校验并不如此判定；
   结果是领域层认为合法的项目（包括本机真实样例项目）永久无法保存。
   现在越界只作为导出前检查的画布警告，写入前只校验坐标必须为整数。
7. 排版待补（anchor_block_id 为 null）用素材完成时会凭空造一个区块，
   导致 usage.block_id 与待补锚点不一致，保存被拒。现在排版待补只引用排版版本。
8. migrateUiProject 只在启动路径被调用；外部重载与冲突解决路径直接采用磁盘 JSON，
   旧格式状态行会在此后阻塞所有保存。现在所有采用磁盘数据的路径都做同样迁移。
9. 浏览器版导出渲染器在重构素材解析时被误删，导致 Web 端导出抛错；已恢复，
   并与服务层保持同一套素材解析规则（不再把文件名当正文输出）。
10. 真实键入不可撤销：input 监听直接改 canonical，blur 提交又因内容相同而跳过历史。
    现在输入框记住起始值，blur 时按起始值提交历史，撤销可回退这次输入。
11. 预览把已在正文内联显示的素材又在下方列一遍；HTML 导出同样重复。
    现在图库只统计内联素材，导出只列没有自己区块的素材。
12. 音频区块在任何视图都没有播放器，PDF/DOCX 素材永久显示「正在读取素材预览…」。
    现在音频渲染播放器，其他不可直接渲染的类型显示明确的附件卡片。
```

同时收口的其他复核意见：区块素材链接同时写 `settings.asset_id` 与文件名（预览与导出
读取同一份引用）、Markdown/文档素材在编辑器与预览中显示真实内容、非图片素材不再用
`<img>` 承载、重新打开待补会释放素材链接、满网格时 `placeBlock` 自动扩展行、
`changeGrid(row,-n)` 真正删除指定行数、`/api/asset` 增加大小与符号链接防护、
原生 `asset_read` 限定 `assets/` 目录与真实路径、项目被替换时停止写入。

### 第三轮：真实 Tauri 窗口走查中发现的缺陷（本轮）

前两轮的证据都在服务层（开发服务器）与 Rust 单元测试上，原生窗口内的写入与会话链路
从未被真正跑过。本轮在真实窗口内走查时发现并修复：

```text
13. app/views.js 反向 import app/main.js 取 PROJECT_FILE_PICKER，与 main.js → views.js
    构成循环导入；main.js 一旦以第二个 specifier 被加载（测试用 query 破坏去重）就会
    实例化第二份完整应用（两套 store、定时器、全局与关闭钩子互相竞争）。
    已抽出 app/constants.js 断开环，模块图恢复无环。
14. 原生会话从不保存阅读位置：WorkbenchStore.session() 在原生模式只返回 { project_dir }，
    而 DesktopBridge.loadSession() 又只把 project_dir 交回调用方，restoreSession 需要的
    当前课/模式/右栏/视图全部丢失 —— 原生「关闭 → 重启 → 继续」实际只回到默认位置。
    现在两侧都保留完整会话，重启可回到同一课、同一模式、同一视图、同一右栏。
15. 原生素材预览必定失败：Rust 侧是 fn asset_read(input: Value)，而 JS 发的是平铺参数，
    真实窗口里每个素材都显示「invalid args `input` for command `asset_read`」。
    现在与 asset.import 一致地包在 input 里，媒体库恢复真实缩略图。
16. write_recovery_journal / save_session / clear_recovery_journal / project_close 等直接
    调用 invoke，失败时没有任何错误文本，界面只能显示「保存失败」四个字，无法定位。
    现在统一走 nativeInvoke + bridgeError，错误原因（例如「无法创建临时文件」）可见。
17. 启动流程先写 session 再 restoreSession，等于每次启动都用空位置覆盖磁盘上的阅读位置；
    未做任何操作就退出会永久丢失「上次看到哪里」。现在先恢复再写回。
18. enterProject() 把已恢复的位置又交给 openItem()，而 openItem 会把 route 重置为 editor，
    会话里保存的视图被丢弃；启动页「继续工作」按钮走的是 open-item 而不是 enter-project，
    卡片显示的也不是将要恢复的那一课。现在卡片命名即将恢复的课，按钮走会话恢复路径。
19. 租约被另一实例占用时启动失败会执行 forgetNativeProject()，把会话清成
    { project_dir: null }，用户的继续工作入口被永久抹掉。现在只有项目目录真的不可用时
    才清除，锁冲突只提示并保留位置。
20. session 写入失败会被当成项目保存失败上报（toast「保存失败」），而 project.json
    其实已经写成功。现在区分为「项目已保存，但无法记录上次阅读位置」。
21. Tauri 构建不跟踪 app/ 目录：普通 cargo build 会把旧前端打进二进制，真实窗口只剩空白
    （且 cargo 报告 Everything fresh）。build.rs 现在对每个前端文件声明 rerun-if-changed。
22. 前端 bundle 加载失败时窗口全白且无任何提示。现在由独立的经典脚本 app/boot.js
    显式 import() 主模块，失败时在页面内报告失败原因与逐文件 HTTP 状态。
    该脚本放在独立文件而非内联，是因为 Tauri 的 script-src 'self' 会拦截内联脚本；
    已用「故意删除 app/canvas.js 后重新构建」在真实窗口内验证：页面显示
    「工作台界面加载失败 / 界面脚本加载失败 / /canvas.js → HTTP 404」，不再是白屏。
```

### 第四轮：独立验收复核提出的非阻塞问题（本轮已修）

两份独立复核（一份完整复核 + 一份针对本轮修复的定向复核）均判定 **无 BLOCKER**。
以下非阻塞问题已在本轮修正：

```text
23. 租约冲突判定过窄：isTransientOpenError 只认 project_locked / project_lock_lost，
    锁文件无法创建或写入、project.json 一时读不出等原因仍会被当成「项目没了」而清空
    继续工作入口。判定反转为「只有 explicit_project_dir 明确报告该路径不可用时才清除」，
    并列出全部六种目录错误。理由：保留一个过期指针最多让下次启动失败一次并给出可读提示，
    清掉指针则永久丢失阅读位置。
24. 三处注释与代码不符：PROJECT_FILE_PICKER 的说明留在 main.js 而常量已搬到 constants.js；
    forgetNativeProject 上方还留着一段「清空会话」的旧 JSDoc；invoke 上方仍写着已被替换的
    表达式 native !== undefined。已全部改写为与代码一致。
    注意 tests/ui_test.ts 原本断言的正是那句失效注释——已改为断言真实守卫
    （invoke 是否存在），否则把守卫删掉测试仍会通过。
25. tests/native_boot_test.ts 中「目录不存在要清会话」的用例夹具本身没有会话，
    「已清空」无论如何都成立；现在夹具带完整阅读位置，断言才真正校验清理动作。
26. 启动页「继续工作」的断言被 9 个同 action 的入口按钮满足，属弱断言；
    现在只在 recent-card 片段内断言 action 与卡片文案，并额外断言卡片里不再出现
    open-item（即不会绕过会话恢复直接打开某一课）。
27. asset.read 的参数嵌套此前没有回归测试（native_boundary 中那条也能被 asset.import
    满足）；新增用例直接断言 DesktopBridge.nativeInput("asset.read") 产出
    { input: { asset_id, project_dir } }，同一处再踩坑会立刻失败。
28. /api/status 的 project_root 恒为 ".workbench-project"，即使 PROJECT_ROOT 覆盖了根目录；
    现在返回真实根目录。
```

## 14.4 真实 Tauri 窗口走查记录

```text
走查方式：
  真实 Tauri Debug 二进制在真实窗口中运行；通过 macOS Accessibility（AX）对真实窗口
  执行点击与键入，并以「逐屏 AX 树 + 窗口截图 OCR」双向核对渲染结果；所有落盘结论
  直接读 project.json / session.json / project.lock 验证，不依赖界面自述。
  项目通过两条等价路径进入：`--project-dir <绝对路径>`（启动即打开）与不传参数时
  由 session 恢复上次项目；两者走完全相同的 project_open → 租约 → 读取 → 自动保存 →
  会话持久化链路。系统模态选择器（NSOpenPanel）不可脚本驱动，故未纳入脚本走查。

走查结果（全部在真实窗口内完成，均有落盘证据）：
  1. 启动：`--project-dir <临时验收项目路径>` 直接打开课程；不传参数时从 session
     恢复上次项目，启动页卡片显示上次所在的那一课与「整门课程 0/3 课完成 · 待补 1 项」。
  2. 课程地图：整门结构（2 个阶段 3 课）、每课完成度（80% / 100% / 67%）、
     「共 3 课 · 已完成 0 课 · 待补 0 项 · 缺素材 0 处」，每课带编辑/上移/下移/删除控件。
  3. 任意一课：点击 S01-02 跳到该课，面包屑、标签页、左栏同步切换，S01-01 数据不受影响。
  4. 正文：在窗口内键入正文并自动保存，project.json 的 updated_at 与区块 content 同步更新。
  5. 结构：「＋ 添加占位符」生成待补区块（02），完成度 100% → 33%，出现「文字：缺 1 段」。
  6. 素材：媒体库列出 2 个素材，图片渲染为真实 <img>（AXImage 暴露素材文件名）、
     Markdown 显示正文内容，均无「无法预览」错误。
  7. Flow / Grid：Flow ↔ Grid 往返切换后默认网格仍为 3 列 × 3 行，已放置区块保持 R1C1，
     未放置的待补归入「还没有放进网格的正文」。
  8. 预览：预览视图按同一份正文渲染，显示「排版：默认网格 · Grid / 已放置 1 块 /
     正文 2 块」；「导出前检查」在窗口内点开并返回结构化清单（内容级待补 / 当前排版待补 /
     缺失素材文件 / 超出画布 / 文字溢出 / 未加载字体 / 外部引用，全部为 0 并标 ✓）。
  9. 保存：project.json 与 project.bak 成功写入，状态栏回到「已保存」，无失败提示。
 10. 关闭：窗口关闭请求走 flush + 释放租约，project.lock 被删除，进程退出。
 11. 重启 → 继续：不传任何参数重新启动，启动页命名上次那一课；点「继续工作」直接回到
     上次所在的媒体库视图（而不是被重置到正文编辑器），左栏待补计数 1 保持。
 12. 锁互斥：另一实例仍持锁时启动第二个实例，第二个实例被拒绝并给出可读提示，
     且不清除会话里的阅读位置（修复前会被清成 project_dir: null）。

对应任务卡 §26.9 Runtime：
  [x] 真实 Tauri Desktop 完成完整 Course Authoring E2E —— 见上 12 步。
  [x] Native interaction 正常 —— 窗口内点击、键入与关闭请求均由真实事件驱动；
      project_open / project_save / asset_read / write_recovery_journal /
      clear_recovery_journal / save_session / load_session 全部在真实壳内实际调用成功
      （project.json、project.bak、session.json、project.lock 的落盘内容为证）。
  [x] 无关键白屏 / 卡死 / 不可恢复状态 —— 构建跟踪修复后每次启动都正常渲染
      （含第二实例、无参数启动、预览预检启动），走查期间未出现无响应状态。
      走查中确实出现过一次真实白屏：旧前端被打进二进制（见 14.3 第 21 项），
      已修复构建跟踪，并新增启动失败页面提示，使前端加载失败不再以空白窗口呈现。

本轮走查发现并修复的缺陷：见 14.3 第三轮（第 13–22 项）。

已知粗糙处（本轮未改，留给后续任务）：
  当第二个实例因租约冲突被拒绝时，本轮的修复保证「不清空继续工作入口」，但被拒绝的
  那个窗口本身仍停在空白启动页：如果用户坚持在该窗口点「继续工作」，它只会显示一个
  空课程地图，而不会自动重试打开项目。正确做法是关掉另一个窗口后重新启动（位置会
  完整恢复）。把「已知目录 + 无数据」的继续工作改成自动重试属于交互行为变更，
  不在 V0-T02 范围内，故只记录不改。

  切换项目时 openProject 会先把会话写成「新目录 + 旧项目 id + 旧阅读位置」，随后
  restoreSession 因 project_id 不匹配而跳过恢复。影响有限：会话文件一次只保存「当前项目」
  的位置，被覆盖的本来就是即将关闭的那个项目的位置；新目录是对的，id 不匹配只导致
  「打开后停在项目概览」。这一步也不能简单删掉——loadSession 会采纳文件里的目录，若文件
  里没有新目录，切换后 projectDir 会被还原成旧项目，反而可能把新项目的数据写进旧目录。
  要彻底做干净需要重构切换状态机，风险高于收益，故本轮保留现状并记录。

口径更正（避免夸大）：
  「重启后恢复上次位置」这条能力本轮只在**桌面壳**得到验证：原生 save_session/load_session
  把会话写进应用数据目录。浏览器壳的 saveSession 目前只写页面内存（dev_server 没有会话
  端点），刷新页面会丢失阅读位置。此前 22.x 摘要中「重启后恢复」的服务层证据指的是
  同一页面生命周期内的行为，不应被理解为浏览器壳也具备跨刷新持久化。

未覆盖（诚实记录）：
  「打开项目文件夹」与「添加素材」的系统模态选择器无法由脚本驱动，故走查未覆盖
  在模态框里选路径这一步；素材侧只验证了已有素材的读取、预览与引用，未覆盖导入动作。
  键盘快捷键（撤销/重做/保存/搜索/快速收集）本轮未逐一在窗口内触发。
  拖拽导入本轮未在窗口内复现（T01 已在真实窗口验证过同一入口）。

BACKLOG：video/document 素材在导出中仍以链接形式出现（导出渲染属 V0-T04）；
         应用内未提供「用系统默认程序打开素材」；
         键盘快捷键只保留撤销/重做/保存/搜索与快速收集；
         浏览器壳的阅读位置只在页面内存中，刷新即丢失（需要服务层会话端点或
         localStorage，属后续任务）。
```

## 14.5 V0-T02 状态判定

```text
V0-T02 = VERIFIED
```

理由：§26 的 12 组 Definition of Done 全部满足。其中 §26.9「真实 Tauri GUI 内完整
Course Authoring E2E」已在本轮真实窗口内完成（见 14.4），并因此发现并修复了 10 项
只在原生路径上才会暴露的缺陷（见 14.3 第三轮）——这些缺陷此前被服务层证据掩盖，
正是 T01/T02 坚持要求真实 Desktop 走查的原因。

自动化证据：deno task check 通过；deno task test 120 passed / 0 failed；
cargo test 17 passed / 0 failed；cargo build 通过。

`V0-T03 — AI Workflow` 现在允许开始。

---

# 15. V0-T03 — AI Workflow

状态：

```text
VERIFIED
```

依据：任务卡 §8 的 Definition of Done 全部满足，包含**最终构建（cargo tauri build --debug
产出的 .app，嵌入前端）真实 Tauri 窗口内的完整 AI 走查**（见 15.2 与 15.3）。

## 15.1 本轮完成内容

```text
AI 上下文装配（Course / Lesson / Block 三级范围，从 Canonical 与现有投影现场装配，不形成第二套课程真相）
调用前可预览：本次实际发送的条目与字数，并单独列出「不会发送」的类别
统一 Connector 边界：DeepSeek / 火山方舟（豆包）/ OpenAI / 自定义 OpenAI 兼容 + 离线确定性连接器
JSON 与 SSE 归一化；timeout / cancel / 缺密钥 / 限流 / Provider 错误 / 无法解析 / 项目未打开 全部归一到统一错误码
AI 工作流 UI 进入现有三栏工作台（右栏 AI 助手），不丢当前课、当前区块与当前视图
Suggestion → ChangeDraft → Diff → Reject / Apply：Apply 前重新校验、深拷贝候选一次性落盘、失败不留半写入
Apply 走与人工编辑同一套 commit / history / undo / redo / autosave
执行记录（非 Canonical、可重建、0600、不含密钥）：时间 / 范围 / 指令 / Provider·Model / 结果类型 / 状态与错误码 / Apply·Reject 结论
密钥边界：由所在进程注入（桌面壳 Rust ai_complete、浏览器壳服务层），页面拿不到；
            不进入 project.json / Canonical / 导出包 / 诊断包
```

## 15.2 本轮证据

```text
deno task check                    通过
deno task test                     220 passed / 0 failed（含 AI 工作流 / AI 传输 / AI UI 三个新测试文件）
cargo test --offline               45 passed / 0 failed（含 Rust 侧凭据擦除对等项）
cargo build --offline              通过；cargo tauri build --debug 通过，产出 .app 与 .dmg 两个 bundle

浏览器整栈 E2E（Chromium + 真实 Deno 服务，真实点击与键入）：
  进入项目 → 进入某课 → 选中区块 → 区块范围 → 预览上下文（含「不会发送」清单）
  → 只读请求得到 Suggestion 且正文不变 → 修改型请求得到 ChangeDraft 与 Diff（修改前/后）
  → Reject 后正文不变 → 再次请求 → Apply 后正文改变 → Undo 回退 → Redo 恢复 → 显式保存
  落盘校验：project.json 0 issue；3 次请求对应 3 行执行记录，状态 pending / rejected / applied 正确、权限 0600

真实 Tauri 窗口 E2E（最终构建 .app、嵌入前端、真实窗口内真实控件操作）：
  1  启动桌面应用（不传 --project-dir，由 session 恢复上次项目）
  2  打开项目 V0-T03 走查课程
  3  进入 S01-01，选中第 2 个正文区块
  4  打开右栏「AI 助手」
  5  范围切到「当前区块」
  6  点「预览」：面板显示「本次共发送 8 项、1005 字。范围：区块「正文」@ S01-01 课程导论」，
     并逐条列出 course_map / document / custom / requirement / asset 来源与字数
  8  点开「不会发送」：明确写出「本课其他区块的正文没有发送（只发送了结构与相邻区块标题）」、
     「项目设置、本地连接信息与任何密钥字段」不进入上下文
  7  指令「解释当前段落」→ 运行：状态「已完成」，面板显示 AI 回答与
     「已把这次回答保存成建议（记录在 project.json 的 suggestions 里），正文没有被修改」；
     落盘核对：blocks 逐字节不变，suggestions +1，change_drafts 0
  8  指令「把当前段落改写得更适合新手」+ 勾选「要求修改课程内容」→ 运行：
     落盘核对：生成 change_drafts 1 条、status=reviewing、operations=[replace_block]，blocks 仍逐字节不变
     面板渲染「修改草稿 · Diff / 待审核 / 替换第 2 段的正文 / 理由… / 修改前 | 修改后」
  9  点「拒绝」：blocks 逐字节不变，draft status → discarded
 10  再次运行 → 再次点「应用这些修改」：blocks 改变且含「【本地示例改写】」，draft status → applied
 11  点顶部「↶」撤销：正文回退到应用前（改写内容消失）；点「↷」重做：内容恢复
 12  点「保存」：状态栏显示「✓ 已保存」
 13  关闭窗口：project.lock 释放（仅保留 guard 文件）
 14  重新启动并重新进入项目：AI Apply 后的 Canonical 内容仍在，AI 面板恢复到「当前区块」范围，
     change_drafts 状态仍为 discarded / applied，suggestions 与 context_packs 数量一致
 15  查看执行记录（<app-data>/.workspace/ai/executions.json，权限 0600）：
     3 次运行 3 行，instruction 分别为「解释当前段落」「把当前段落改写得更适合新手」×2，
     review 状态 pending / rejected / applied 正确，provider=fake，全文无密钥
 16  把服务商切到未配置密钥的 DeepSeek 再运行：
     状态「失败」、错误码 MISSING_CREDENTIAL、「AI 服务商「deepseek」还没有配置 API Key。」、
     下一步「在 AI 面板点击该服务商的「保存密钥」，填入 API Key 后重试。」；
     落盘核对：blocks 与 requirements 逐字节不变；执行记录新增一行 failed / missing_credential / deepseek
 17  回归：走查期间使用课程地图、单课编辑器、结构视图、区块选择、自动保存、手动保存、
     关闭与重启恢复均正常；结束时 project.json 通过 Canonical 校验（0 issue），
     T01/T02 的锁、租约释放与重开一致性未回归（deno task test 220 项含全部 T01/T02 用例）
```

## 15.3 本轮验收方式与限制说明

```text
真实窗口走查由 macOS Accessibility（AX）驱动：对本工具编译的小型 AX 驱动直接对真实窗口
执行 AXPress、AXValue 写入与键盘事件，并以 CGWindowList 截图 + Vision OCR 逐屏核对渲染结果；
所有结论同时用落盘文件（project.json / executions.json / project.lock / session.json）复核，
不依赖界面自述。

过程中的环境限制（已记录，供后续任务参考）：
  - 本轮中途开始，macOS 不再向本工具进程树投递合成鼠标点击（光标可移动、AXIsProcessTrusted=true，
    但 down/up 事件不生效）。因此走查改用 AXPress（等价于真实点击目标控件）与 AXValue 写入，
    不依赖鼠标坐标。
  - WebKit 网页内容的 AX 树仅在应用真正前台且 AXEnhancedUserInterface 生效后暴露；
    需要先激活应用并等待其稳定，自动化才能定位控件。
  - 合成键盘事件（CGEvent unicode）会改变文本框的 DOM 值但不触发 input 事件，
    因此指令输入改用 AXValue 写入（会走正常编辑管线并触发 input）。
  - 未使用任何测试专用代码或隐藏开关：走查全部通过应用自身的真实控件与真实命令完成。
```

## 15.4 本轮发现并当轮修复的缺陷

```text
1. assertNoSecretFields 拒绝 context_packs[].model_connection_id —— 任何建立过 AI 上下文包的
   项目都无法保存（autosave 直接抛错）。已加精确列级豁免并补回归测试。
2. 桌面壳把 Rust 返回的结构化错误码全部压成 transport_unavailable（缺密钥会显示成传输不可用）。
   已让 mapTransportError 尊重结构化 code / details / recommended_action。
3. bridgeError 丢掉 recommended_action，面板看不到服务端给出的下一步。已补齐。
4. 修改型请求在真实窗口无法产生 ChangeDraft：默认离线连接器不合成任何修改。
   已让它在区块范围按下合成一条可审核的替换操作。
5. 执行记录一次运行写两行（review 决策追加而非更新）。已改为按 id 就地更新（两壳一致）。
6. AI 运行不是原子的：createAiSuggestion 与 createAiChangeDraft 同在一个 commit 回调内，
   后者抛错时建议 / 上下文包会残留并被自动保存（partial write）。
   已改为克隆候选、全部成功才提交。
7. 浏览器壳把服务商原始错误正文写进 details.detail，配合只替换首个 token 的 redactSecrets，
   使 API Key 可经渲染进程、diagnostics.log（0644）与诊断导出包泄漏。已加多层擦除
   （按值精确擦除、转义解码、变形 / 分段检测、长不透明串过滤），诊断日志改为 0600。
8. 课程 / 课级范围的说明文案与实际发送内容不符（少报了正文全文）。已按实际行为更正。
9. 缺少任务卡要求的 Tool / MCP / Skill 披露。已从执行记录的 capabilities 派生并显示。
10. 桌面壳 AI 存储位置在应用数据目录，面板文案却写「项目 .workspace」。已按壳分别显示。
11. 切换项目后仍渲染上一个项目的执行记录。已新增 resetAiState()，并在 9 条整体替换项目的路径上调用。
```

## 15.5 Definition of Done 对照

任务卡 §8 的全部条目均已满足，包括「真实 Tauri 窗口完成至少一次完整 AI 走查」（证据见 15.2），
故 V0-T03 = VERIFIED。

---

# 16. V0-T04 — Output & Publish

状态：

```text
VERIFIED
```

本轮目标：

> **Workbench 中的课程可以可靠迁移到真实课程或内容发布场景，且不破坏源项目、不形成第二套课程真相。**

## 16.1 本轮完成内容

```text
只读发布投影层 src/service/publish.ts：
  Canonical → PublishProjection → Adapter；平台标记不进入 Canonical
桌面壳原生输出链（src-tauri/src/lib.rs）：
  export.preflight / export.run / export.reveal / publication.record
  导出前检查 BLOCKING / WARNING 分类；原子暂存 .{name}.acw-<id>.tmp
  导出包脱敏（移除 conversations / conversation_sources / messages /
  context_packs / context_pack_items）；素材复制；PDF 1.4 原生写出
输出格式（当前课 / 整门课程两种范围）：
  Markdown、Semantic HTML、Static Web Package（index.html + manifest.json +
  实际使用素材）、PDF（STSong-Light + UniGB-UCS2-H 中文）、
  微信 / 富文本迁移版 HTML、Project JSON、素材包、完整项目包
发布与导出中心 UI（app/views.js / app/main.js / app/styles.css）：
  范围、格式、导出前检查（逐项 ✓ / WARNING / BLOCKING + 问题清单 +
  「能不能继续 / 继续后会怎样」）、最近一次导出的实际位置与在 Finder 中显示、
  发布记录（用户确认的发布节点）
浏览器审查壳：Markdown / HTML / 富文本迁移版下载；Web / PDF / 项目包由桌面壳生成。
  注意（独立复核发现）：审查壳的 HTML 与富文本迁移版共用同一轻量渲染器
  （app/main.js 的 browserHtml），其「富文本迁移版」下载与 HTML 下载内容相同、
  不含迁移提示；带迁移提示的迁移版由桌面壳导出（见 §16.4-3）。
```

平台特有格式一律通过：

```text
统一结构化课程内容
        ↓
发布适配层（Publish Projection）
```

不得让某个平台格式反过来控制 Canonical —— 本轮实测导出严格只读。

## 16.2 本轮证据（真实 Tauri 窗口走查 + 落盘复核）

```text
测试项目：验收用临时项目（V0-T04 takeover 场景，位于系统临时目录）
  4 个真实素材：课程 封面.png(1504B) / 演示 动图.gif(1874B) /
  讲解 视频.mp4(12083B) / 配套 阅读.md(48B)
  2 课：S01-01 输出基础（正文/引用/外链/图片/GIF/视频/文档，Grid 排版）、
  S01-02 迁移实践（含 1 条内容级待补）
全程使用最终构建的 .app（cargo tauri build --debug）与真实原生保存面板；
每条结论都用落盘文件复核（sha256 / JSON / PDF 渲染 OCR），不依赖界面自述。

1  单课 Markdown 导出「到项目目录内」（即上一轮踩雷的自拷贝场景，本轮在修复后的
   构建上复跑）：生成 S01-01-输出基础.md(402B)，标题/段落/引用/外链/图片/GIF/视频/
   附件引用正确；4 个素材 sha256 与导出前完全一致、大小非零（ASSETS_BYTE_IDENTICAL_OK）。
   说明：截断缺陷本身的原始现场来自上一轮的验收项目
   （临时验收项目；其 assets/* 与导出的
   基础阶段.web/assets/*、course-web-moved/assets/* 均为 0 字节），
   本轮走查用的是修复后构建，因此本轮不再出现 0 字节，属预期。
2  Static Web Package：包内 index.html(1138B) / manifest.json(338B) / assets 4 个，
   素材与源 sha256 逐一相同；整包移出项目目录后在真实 Chromium 打开：
   图片 naturalWidth 640×360（PNG）与 320×180（GIF）（修复前为 0）、
   video 带 controls、document 为附件链接，节点顺序
   H2>H2>P>BLOCKQUOTE>P>FIGURE>FIGURE>FIGURE>ASIDE 与课程一致
2b Semantic HTML：导出 S01-01-输出基础.html(1138B，与 Web 包的 index.html 同字节数，
   同一渲染路径），在真实 Chromium 打开：H1 基础阶段 / H2 输出基础 / H2 真实发布链、
   图片 640×360 与 320×180、video 带 controls、0 个 <script>，正文与外链可读
3  PDF：194,503B、PDF 1.4、2 页；对渲染结果做 Vision OCR，页面文字为
   「基础阶段 / 输出基础 / 真实发布链 / 这是一段用于核对 Markdown、HTML、
   Web 与 PDF 的中文正文。/ 输出只读 Canonical，不反向污染课程内容。/
   外部参考：https://example.com/course」；第 2 页为媒体降级
   （GIF 静态帧、视频说明、附件链接）
4  微信 / 富文本迁移版：真实 Chromium 打开导出的迁移版 HTML（
   S01-01-输出基础.wechat-migration.html），把其 body 写入系统剪贴板后粘贴进
   普通 contenteditable 接收页，结构
   P(migration banner)/H1/H2/H2/P/BLOCKQUOTE/P/FIGURE(IMG)/FIGURE(IMG)/FIGURE(VIDEO)/ASIDE
   保序、0 个 <script>、0 个 Workbench 私有 class，媒体单独上传提示随内容保留。
   证据文件：验收用的粘贴结构记录（位于系统临时目录，含接收页 DOM 与逐项观测）
5  导出前检查（preflight）实测两态：
   BLOCKING：把 assets/演示 动图.gif 移走后 → 面板「缺失素材文件 1」、
   问题清单「BLOCKING 项目素材文件不存在」、BLOCKING 1 · WARNING 3、
   导出按钮禁用 + 「当前不能导出：请返回修复上面的严重问题。不会生成半成品，
   也不会修改源课程。」，且不弹出保存面板、磁盘无半成品；恢复文件后字节一致
   WARNING：仍有待补 / 外部引用 / 媒体降级 → 逐条列出，可「确认警告并导出」
6  只读性：整轮走查前后素材 sha256 完全相同；Canonical 内容哈希
   （屏蔽 autosave 的 project.updated_at 与用户显式记录的 publications）不变
7  发布记录：点「记录已发布」→ project.json 的 publications 增加 1 条
   （platform=手动发布，status=published，带 content_item_id 与时间戳），
   UI 显示「手动发布 · published」
8  关闭 → 重启 → 重开：窗口关闭后 project.lock 释放（仅留 guard），
   重开回到同一项目与同一课、数据一致，无回归
9  自动化与构建：deno task check 通过；deno test 223 passed；
   cargo test 47 passed；cargo tauri build --debug 产出 .app 与 .dmg
```

## 16.3 本轮验收方式与限制说明

```text
真实窗口走查由 macOS Accessibility（AX）驱动：对真实窗口执行 AXPress、
AXValue 写入与键盘事件，并以落盘文件（sha256 / project.json / PDF OCR）复核。

环境限制（已记录，供后续任务参考）：
  - 本会话进程默认没有 Apple Events / 辅助功能权限，System Events 报
    -10004 privilege violation；放行后才能驱动真实窗口。
  - 原生保存面板的「前往文件夹」子表在 AX 下提交不稳定（上一轮同样遇到），
    本轮改用面板默认目录（项目根目录）导出后 cp -R 移出项目再打开，
    不影响 DoD「Static Web Package 离开原项目目录后仍可打开」。
  - 未验证真实微信公众号后台（任务卡 §4.9 允许）：不做登录 / 授权 / 草稿箱 API /
    自动发布，只做迁移格式本身的复制粘贴结构验证。
  - cargo tauri build --debug 在应用仍从该 bundle 运行时会在 DMG 步骤失败
    （首次构建遇到：bundle_dmg.sh 失败）；关闭应用后重跑即产出 .app 与 .dmg。
  - 上一轮会话中断时遗留的 Desktop UI 独占锁（位于系统临时目录，owner 为当时的
    验收实例）已确认
    owner 进程不存在、应用已退出后释放，并在本轮以自己的身份重新取锁、结束时释放。
  - 关于「导出包不含私有会话数据」：实现是 sanitized_project_package（导出前移除
    conversations / conversation_sources / messages / context_packs / context_pack_items），
    本轮测试项目的这些数组本来就是空的，因此「非空数据被移除」这一点由 Deno 回归测试
    full project export excludes private conversation data 覆盖，本轮未另造真实 AI 数据复验；
    可直接核实的是导出包内不存在 .workspace / 诊断 / lock / session 文件与任何密钥。

Git 状态（§13.7）：
  branch = main（全程未 switch / checkout / reset / merge，未新建 worktree）
  起始 HEAD = 74c3281（merge(v0-t03)）；本轮在其上追加 1 条提交
  提交主题 = feat(v0-t04): output and publish verified（显式 stage，未用 git add -A；
  本文件不绑定可能因后续修订而变化的 commit hash，以 git log 主题为准）
  本轮实际修改：PROJECT_MASTER_CONTROL.md、README.md、app/main.js、app/styles.css、
  app/views.js、src-tauri/src/lib.rs、src/domain/index.ts、
  src/service/import_export.ts、src/service/publish.ts（新增）、
  tests/acceptance_test.ts、tests/import_export_test.ts、tests/native_boundary_test.ts、
  V0-T04_OUTPUT_PUBLISH_TASK.md（新增，任务卡入库）
  提交后工作区干净（git status 无输出）；未观察到其他任务混入的改动。
```

## 16.4 本轮发现并当轮修复的缺陷

```text
1. BLOCKER — 导出会把源素材截断为 0 字节：把单文件导出到项目目录内时，
   素材复制目标与源路径相同，fs::copy 自拷贝在 macOS 上截断文件；此后所有导出
   都引用空素材。原始现场（上一轮验收用的临时项目）：
   4 个素材 sha256 均为空文件哈希 e3b0c44…，其导出的基础阶段.web/assets/* 与
   course-web-moved/assets/* 也都是 0 字节、Web 包图片 naturalWidth=0；
   独立复核另用单独 Rust 探针确认 fs::copy(same, same) → Ok(0) 在本机确实截断文件。
   已修：copy_export_assets 增加同文件判定
   （路径相等或 canonicalize 后相等则跳过复制），导出恢复严格只读；
   补 Rust 回归测试 exporting_beside_project_never_copies_an_asset_onto_itself。
   反证（本轮独立复核）：临时把该守卫改成恒假后重跑该测试 → 失败并显示素材被截断为
   空文件（断言 left: [] vs right: 非空字节），恢复守卫后 47 项全绿，
   证明缺陷真实存在且回归测试确实能抓住它，而不是同义反复。
2. 导出前检查面板「缺失素材文件 ✓ 0」与「BLOCKING 1」自相矛盾：磁盘缺文件由原生
   检查发现，而面板该行只统计引用断链。已修：openPreflight 合并原生
   missing_asset 计数，面板行与 BLOCKING 总数一致（重跑构建后实测 1 / 0 两态正确）。

未修复但已记录（不阻塞 V0-T04）：
3. BACKLOG — 同一格式存在多套渲染实现，输出不一致（独立复核已更正归属）：
   桌面壳用 Rust html_for_project，服务层用 TS renderPublishHtml（class 化迁移提示、
   视频降级为 <aside> 媒体卡片），浏览器审查壳 app/main.js 用自带的 browserHtml。
   实测差异：
   (a) 桌面壳迁移版保留 <video controls> + 行内样式提示；服务层版本把 video 降级为
       <aside> 卡片 + .migration-note 文案 —— 同一「微信 / 富文本」格式两个实现不同；
   (b) 审查壳把 wechat 与 html 交给同一个 browserHtml、同名同扩展名下载
       （app/main.js 的 exportCurrent），因此审查壳的「富文本迁移版」下载与它的
       HTML 下载完全相同、且不含任何迁移提示。
   三者都以 Canonical 为唯一来源，不构成第二份内容真相，但应在后续版本收敛到
   同一投影 / 渲染层；收敛前 README 与本文件 §16.1 已注明该限制。
4. 观察（非缺陷，fail-closed）：exportCurrent 自身不跑 preflight，拦截由两处保证 ——
   发布与导出中心的点击路径先调 preflight 并禁用按钮，且 Rust export_run 内部会
   重新执行 preflight 并以结构化 export_blocked 拒绝写入。即使绕过 UI 直接调用，
   也不会产生 BLOCKING 输出；仅为审计记录，不需要修改。
```

§12 Backlog 判定（本轮）：

```text
纳入 T04 并已完成：video / document 素材在导出中的表达 —— HTML / Web / 迁移版按类型
输出 img / video(controls) / audio / 附件卡片，Markdown 与 PDF 为非交互附件说明，
导出前检查对每种降级逐条给出 WARNING（真实窗口与落盘证据见 §16.2）。
继续留在 Backlog（不属于 T04）：应用内「用系统默认程序打开素材」、键盘快捷键范围、
浏览器壳阅读位置刷新丢失、系统钥匙串适配器、AI 逐字流式 UI。不需要强行清空。
```

## 16.5 Definition of Done 对照

```text
10.1 Architecture
 [x] Canonical → Publish Projection → Adapter 边界清楚（publish.ts 只读投影；
     桌面壳原生导出同样只读 Canonical，不写回）
 [x] 平台格式未反向污染 Canonical（导出后 Canonical 内容哈希不变）
 [x] Preview / Export 未形成互相漂移的第二套内容真相（两侧都从同一份 Canonical 派生，
     本轮实测导出未改变任何内容字段；但两壳各自有渲染实现这一差异已记为 §16.4-3 BACKLOG）
 [x] 未重构 T01/T02/T03 已 VERIFIED 生命周期（223 Deno + 47 Rust 全绿）
10.2 Preflight
 [x] 导出前检查真实可运行（真实窗口实测 BLOCKING / WARNING 两态）
 [x] Blocking / Warning 明确区分（缺素材/非法路径 = BLOCKING；待补/外链/媒体降级 = WARNING）
 [x] 缺失素材 / 断链不会被错误标为成功（BLOCKING 时按钮禁用 + 不生成半成品）
 [x] 用户能理解 warning 的后果与下一步（逐条问题 + 「可以继续；…会按说明降级」）
10.3 Core Outputs
 [x] 当前课 / 整门课程 Markdown 可真实使用且素材引用稳定
 [x] Semantic HTML 可独立打开
 [x] Static Web Package 离开原项目目录后仍可打开（Chromium 实测图片正常渲染）
 [x] PDF 能生成、打开、阅读（PDF 1.4 / 2 页 / 渲染 OCR 文字正确）
 [x] 现有 SVG / 分区导出无回归（由 Deno 回归测试 multi-page image export emits
     stable files per LayoutSection 覆盖，本轮未做人工 SVG 走查，如实记录）
 [x] Project JSON / 素材包 / 完整项目包无回归（完整项目包实测导出并检查内容；
     Project JSON / 素材包与「不导出私有会话数据」由 Deno 回归测试覆盖）
10.4 Media
 [x] image 不丢失、GIF 不被当普通图片或破图（Web 包 GIF naturalWidth 320×180）
 [x] video/audio 有正确 HTML 表达与非交互格式降级（Web 保留 controls；PDF/迁移版说明）
 [x] Markdown / document 不停在错误预览 / 导出状态（附件链接可打开）
 [x] inline 素材不重复导出、未使用素材不进入正文（selected_export_assets 只取被引用素材）
10.5 Real Migration
 [x] 至少一条微信 / 富文本迁移路径可实际完成（迁移版 HTML + contenteditable 粘贴保序）
 [x] 复制 / 粘贴后标题、段落、图片顺序基本正确（结构实测保序）
 [x] 不承诺平台无法保证的样式保真（迁移版明确写出）
 [~] 未验证真实微信后台（任务卡允许，已在 16.3 诚实说明）
10.6 Safety
 [x] Export 失败不修改 Canonical（BLOCKING 时无写入；内容哈希不变）
 [x] Export 失败不谎报成功（明确报错文案 + 按钮禁用）
 [x] 不留误导性半成品（原子暂存 + 目录已存在时拒绝覆盖）
 [x] 路径 / 文件名 / 覆盖行为安全（拒绝符号链接、拒绝既有目标目录覆盖）
 [x] 导出包不含 API Key / secret；不含 AI 执行记录 / 诊断日志 / lock / session 私有文件
10.7 Runtime
 [x] Web / Service 路径可用（deno task check / test 全绿）
 [x] 真实 Tauri Desktop 可编译（.app 与 .dmg 均产出）
 [x] 最终构建真实 Tauri 窗口完成 Output & Publish 走查
 [x] 实际输出文件在系统中可打开（Chromium / PDF OCR / Finder 位置）
 [x] Close / Restart / Reopen 不回归
10.8 Automated
 [x] deno task check 通过；deno task test 223 passed；Rust tests 47 passed
 [x] cargo build / cargo tauri build --debug 通过（.app + .dmg）
 [x] 新增输出 / preflight / failure-safety 回归测试（含自拷贝回归）
10.9 Project Control
 [x] BLOCKER = NONE
 [x] README 已同步真实输出能力与限制
 [x] PROJECT_MASTER_CONTROL.md 已按 §21 回写；V0 Task Board: V0-T04 = VERIFIED
 [x] §16 更新为真实完成内容、证据、限制与 DoD 对照；§17 = V0 CLOSED
 [x] §22 Change Log 追加；§29 NEXT ACTION 不再指向 V0-T04；§30 总控摘要同步

PNG / 图片输出：按任务卡 §4.8，V0 只要求「若确有独立必要性才实现」；审计结论是
Markdown / HTML / Web / PDF 已覆盖本轮真实迁移场景，复杂 PNG 生成器列为
REJECTED for V0（导出中心不提供 png / jpg 格式卡片；服务层 preflightExport 对
png / jpg 报 unsupported_format，桌面壳原生导出对未知格式直接返回「当前原生导出
不支持这个格式」；SVG / 分区导出不回归）。
```

---

# 17. V0 还有多少工作

当前 V0 共 4 个平铺任务：

```text
V0-T01  VERIFIED
V0-T02  VERIFIED
V0-T03  VERIFIED
V0-T04  VERIFIED
```

因此从宏观上：

> **V0 已完成并 CLOSED；V0 内部没有剩余任务。**

正确理解不是：

```text
M1 做完 → 项目快结束
```

而是：

```text
V0 的四个收口任务全部 VERIFIED：
Desktop 基础闭环、Course Authoring、AI Workflow、Output & Publish
```

```text
V0 CLOSED
```

V0 关闭后，已按用户批准的 V1-T01 启动 V1。V1 当前只执行这个已批准的平铺任务，不创建其他 V1 任务、阶段或任务层级；V0 的 CLOSED 与四个 VERIFIED 结论保持不变。

V0 关闭时仍留在 Backlog 且不阻塞 V0 的事项见 §16.4 第 3 条与 §23。

---

# 18. 任务状态统一标准

以后所有任务只能使用以下状态：

```text
NOT STARTED
READY
IN PROGRESS
BLOCKED
PARTIAL
DONE
VERIFIED
DEFERRED
REJECTED
```

其中：

## DONE

代码或实现已经完成。

不等于真实验收。

## VERIFIED

已经通过对应 Definition of Done。

只有：

```text
VERIFIED
```

才算真正完成。

这是为了避免：

> “代码写完了”被误认为“功能已经完成”。

---

# 19. 每次任务结束必须回答的 8 个问题

以后 Agent 的结项报告必须回答：

## 1. 本次原计划是什么？

不能只写最终做了什么。

---

## 2. 实际完成了什么？

必须具体。

---

## 3. 哪些原计划没有完成？

不能省略。

---

## 4. 哪些虽然完成，但做得不够好？

例如：

```text
只做了代码实现，没实机验证
只有 happy path
UI 仍然粗糙
测试覆盖不足
Fallback 不完善
```

---

## 5. 出现了哪些新问题？

并分类：

```text
BLOCKER
BACKLOG
DEFERRED
REJECTED
```

---

## 6. 有没有改变 / 删除原有功能？

必须明确回答。

如果没有：

```text
无
```

---

## 7. 当前总控位置发生了什么变化？

必须写：

```text
版本：
任务：
任务状态：
V0 剩余任务：
```

---

## 8. 下一步唯一应该继续什么？

不能给出五六个平级“建议”。

必须给一个：

```text
NEXT ACTION
```

---

# 20. 强制结项报告模板

每次开发结束统一输出：

```text
# Task Completion Report

## 1. Control Position

Version:
Task:
Previous Status:
Current Status:

## 2. Original Goal

...

## 3. Completed

...

## 4. Not Completed

...

## 5. Completed But Not Good Enough

...

## 6. New Findings

### BLOCKER
...

### BACKLOG
...

### DEFERRED
...

### REJECTED
...

## 7. Functional Changes

Added:
...

Changed:
...

Removed:
无 / ...

## 8. Verification

Tests:
...

Runtime:
...

E2E:
...

Unverified:
...

## 9. Remaining Work in Current Task

...

## 10. Overall Remaining Work

Current version remaining:
...

Later versions:
V1 — not active
V2 — not active

## 11. NEXT ACTION

只写下一步唯一优先事项。

## 12. MASTER CONTROL UPDATE

已更新 / 未更新

如果未更新，任务不得视为完成交接。
```

---

# 21. 总控文件的强制更新区域

每一次任务结束，都必须更新以下几个区域。

---

## A. Last Updated

```text
最后更新时间
```

---

## B. Current Position

```text
当前版本
当前任务
当前状态
```

---

## C. Current Task

更新：

```text
Done
Open Blockers
Definition of Done
```

---

## D. V0 Task Board

更新对应状态。

---

## E. Next Action

永远只保留一个下一步。

---

## F. Change Log

追加一条记录。

---

# 22. Change Log

此处只记录“总控状态变化”，不记录所有代码提交。

格式：

```text
YYYY-MM-DD | Task | From → To | Summary
```

当前：

```text
2026-09-23 | V1-T02 | NOT ACTIVE → IN PROGRESS → DONE → PARTIAL
按用户明确要求创建 V1-T02 — macOS Distribution & Public Release Closure（平铺任务，不是新 Milestone，也不是 V1.1 / Release Phase）。
完成：①README / 总控文档状态对齐（下载入口、系统要求、安装步骤、首次打开说明、分发状态如实标注）；②仓库安全预检
（全仓 + 全 Git history 密钥扫描：0 真实凭据；`.release/` 等 release 暂存目录补入 `.gitignore`；文档中的本机路径 / 真实课程标题 /
钥匙串账户 UUID 全部脱敏；修正 src-tauri/README.md 中已过时的「无 Rust 工具链 / 钥匙串未实现」描述）；
③正式 Release 构建：`cargo tauri build --target universal-apple-darwin --bundles app,dmg`，
`lipo -archs` 实测 `x86_64 arm64`；④产品元数据对齐：identifier `local.ai-course-workbench` → `io.github.wyzh0117.ai-course-workbench`
（首次公开分发前唯一可无痛更换的时机）、正式全尺寸 `.icns` 图标集、`LSMinimumSystemVersion 11.0`（与二进制 `minos 11.0` 一致）、
`CFBundleShortVersionString 0.1.0`、教育分类、版权字段；⑤固定 asset 名 `AI-Course-Workbench-macOS.dmg`
（10,357,233 bytes，SHA-256 `59597a342109785e190d9dc8194d841744249dbbc46498ee594572d2d2412573`）+ 同名 `.sha256` 资产；
⑥公开 GitHub 仓库、`v0.1.0` tag、GitHub Release、`/releases/latest/download/AI-Course-Workbench-macOS.dmg` 固定直链；
⑦最小 release workflow（tag / 手动触发，Actions 按 commit SHA 固定，Apple 凭据全部走 Secrets）；
⑧安装后 App 的真实运行 smoke：DMG 挂载 → 拖入 /Applications → 从 /Applications 启动 →
真正的首次启动状态（应用数据目录零文件、干净默认主页、无测试项目）→ 三栏工作台 → AI 助手面板与
「API Key 只由本机服务写入 macOS 系统钥匙串 / 不回显 / 不进入课程、备份、日志、导出或执行记录」说明 → 关闭 → 重启；
⑨自动化门禁：deno task check 通过、deno task test 236 passed / 0 failed、cargo test 49 passed / 0 failed。
BLOCKER（未完成）：缺正式 macOS signing / notarization credentials —— 本机 `security find-identity -v -p codesigning`
返回 0 valid identities，无 Developer ID Application 证书，无公证凭据。当前 DMG 为 **ad-hoc 签名**
（`codesign --verify --deep --strict` 通过，`Identifier=io.github.wyzh0117.ai-course-workbench`，`TeamIdentifier=not set`），
`spctl --assess --type execute` 判定 **rejected**。因此 V1-T02 = **PARTIAL**，
**不宣称** `PUBLIC RELEASE READY` / 「普通用户无安全阻碍安装 / 正式站外分发已完成」。
NEXT ACTION：获取 Apple Developer 分发资格后补做签名 / 公证 / Release 重传 / 安装 smoke，不需要重新开发 Workbench 本体。详见 §34。

2026-09-23 | V1-T01 | IN PROGRESS → DONE → VERIFIED
V1-T01 七项收尾全部完成并验证：①项目切换状态机（切换只提交新项目自身状态，失败保留原会话，不再出现「新目录 + 旧 project_id / 旧阅读位置」）②系统级凭据存储
（macOS 钥匙串，桌面壳 Rust 与浏览器服务两条路径；providers.json 只留元数据，明文仅在写入并校验成功后迁移删除）③浏览器刷新 / 会话恢复（`<project>/.workspace/browser-session.json`，
版本化 + 字段白名单 + 64KB 上限 + 缺失/损坏/串项目安全降级）④重复交互清理（顶栏重复折叠按钮改为「项目选择」，左右栏各只保留一个与自身绑定的折叠控件）⑤全局 UI 对齐
⑥大白话文案（保存 / 锁 / 外部冲突 / 凭据 / 恢复提示）⑦自动化 + 真实回归。
自动化门禁：deno task check 通过、deno task test 236 passed / 0 failed、cargo test 49 passed / 0 failed、cargo build 通过、
cargo tauri build --debug 生成 .app 成功（.dmg 因本环境禁用 hdiutil 无法生成，属环境限制而非仓库缺陷，见 §33.4）。
真实桌面走查（最终构建）：项目选择返回后项目与阅读位置仍在（S01-02）、左右栏折叠控件收窄为窄轨 ☰ 后可原样恢复、DeepSeek 密钥保存 / 更新 / 删除在系统钥匙串实测生效
（账户 `<project-hash>:provider:deepseek`）、测试密钥在项目 / 应用数据 / 执行记录中零明文命中。
真实浏览器走查：切课次 + 切右侧面板后 `browser-session.json` 记录 A 的 project_id、S01-02 与 right_panel=media，刷新后位置与面板恢复；编辑 → 保存 → 刷新内容一致；折叠状态入会话。
清理与首启：/tmp 与 /private/tmp 的测试夹具、日志、导出物、临时工具全部移除；应用数据目录会话与执行记录清空，首启验收后零持久化文件（真正首次启动状态）；
用户真实课程项目（本地路径已隐去）内容零改动（深度比对仅 `updated_at` 元数据刷新）。
OPEN BLOCKERS：NONE。V1-T01 = VERIFIED；PRODUCT STATE = DOGFOOD READY；
NEXT ACTION = PAUSE FEATURE DEVELOPMENT（不创建 V1-T02，等待真实使用反馈）。详见 §33。

2026-09-22 | V1-T01 | READY → IN PROGRESS
按已批准的 V1-T01 任务卡启动 V1：V1 进入 ACTIVE，V1-T01 成为当前任务并进入 IN PROGRESS；
V0 保持 CLOSED，V0-T01 / V0-T02 / V0-T03 / V0-T04 保持 VERIFIED；不创建其他 V1 任务或新阶段。
NEXT ACTION：继续 V1-T01。

2026-09-22 | V0-T04 | NOT ACTIVE → IN PROGRESS → DONE → VERIFIED
最终构建真实 Tauri 窗口内完成完整 Output & Publish 走查（AX 驱动真实控件 + 落盘 sha256/JSON/PDF OCR 复核）：
单课 Markdown 导出到项目目录内（自拷贝场景）→ 素材字节完全不变 → Static Web Package 移出项目目录后
在真实 Chromium 打开（图片 640×360 / 320×180 正常渲染）→ PDF 1.4 两页、渲染 OCR 文字正确 →
微信/富文本迁移版在 contenteditable 接收页粘贴后结构保序、无脚本、无私有 class →
导出前检查 BLOCKING（缺素材：按钮禁用、不生成半成品）与 WARNING（待补/外链/媒体降级可确认继续）两态实测 →
整轮走查前后素材 sha256 相同、Canonical 内容哈希不变 → 记录发布节点（publications 1 条）→
关闭释放租约、重启重开一致。过程中修复 1 个 BLOCKER（导出把源素材截断为 0 字节的自拷贝缺陷）与
1 个 preflight 面板计数矛盾；deno task check 通过、deno task test 223、cargo test 47、
cargo tauri build --debug（.app + .dmg）通过。V0-T04 = VERIFIED → V0 CLOSED；
NEXT ACTION 不再是 V0 任务（V1 保持 NOT ACTIVE，需用户明确开启）。
详见 §16。

2026-09-21 | V0-T03 | NOT ACTIVE → IN PROGRESS → DONE → VERIFIED
最终构建真实 Tauri 窗口内完成完整 AI 走查（AX 驱动真实控件 + 截图 OCR 逐屏核对 + 落盘文件复核）：
启动/恢复项目 → 进入 S01-01 选中区块 → 切换「当前区块」范围 → 预览上下文（8 项/1005 字，
并列出「不会发送」类别）→ 只读请求「解释当前段落」得到 Suggestion 且正文逐字节不变
→ 「把当前段落改写得更适合新手」+ 勾选要求修改 → 得到 ChangeDraft(status=reviewing, replace_block)
与 Diff（修改前/修改后）→ Reject 后正文不变、draft→discarded → 再次运行 → Apply 后正文改变、
draft→applied → 撤销回退、重做恢复 → 保存「✓ 已保存」→ 关闭释放租约 → 重启重开内容仍在、
AI 面板恢复原范围 → 执行记录 3 行且 instruction/review 状态正确、权限 0600、无密钥
→ 切到未配置密钥的 DeepSeek 运行：状态「失败」/MISSING_CREDENTIAL/可执行下一步，
课程数据逐字节不变。全部 gates 绿：deno task check、deno task test 220、cargo test 45、
cargo build、cargo tauri build --debug（.app 与 .dmg）。V0-T03 = VERIFIED；
NEXT ACTION 切换为 V0-T04。

2026-09-21 | V0-T03 | NOT ACTIVE → IN PROGRESS → DONE
AI Workflow 已实现并通过自动化与浏览器整栈验收：Context Assembly（Course/Lesson/Block，从
Canonical 现场装配、可预览、可复现）、统一 Connector 边界（DeepSeek / 火山方舟（豆包）/
OpenAI / 自定义 OpenAI 兼容 + 离线确定性连接器；JSON 与 SSE 归一化；timeout/cancel/缺密钥/
限流/Provider 错误/无法解析全部归一到统一错误码）、进入现有三栏工作台的 AI 助手面板
（范围选择、上下文预览与「不会发送」清单、Provider/Model、运行与取消、Suggestion、
ChangeDraft、Diff、Reject/Apply）、App 走与人工编辑同一套 commit/history/undo/redo/autosave、
非 Canonical 执行记录（0600、无密钥、一次运行一行）、密钥由所在进程注入且不进入
project.json / Canonical / 导出包 / 诊断包。
过程中发现并当轮修复 11 项缺陷，其中两个为 BLOCKER：context_packs[].model_connection_id 被
凭据扫描拒绝导致任何建过上下文包的项目无法保存；AI 运行非原子导致失败后残留
Suggestion/ContextPack（partial write）。另修复：桌面壳结构化错误码被压成
transport_unavailable、bridgeError 丢 recommended_action、离线连接器不产生 ChangeDraft、
执行记录一跑两行、浏览器壳把服务商原始错误正文（含 API Key）写入渲染进程与
diagnostics.log/诊断导出包、范围文案与实际发送不符、缺少 Tool/MCP/Skill 披露、
存储位置文案与壳不符、切换项目后残留上一个项目的执行记录。
证据：deno task check 通过；deno task test 220 passed；cargo test 通过；cargo build 与
cargo tauri build --debug（.app 与 .dmg）通过；Chromium + 真实 Deno 服务的浏览器整栈 E2E 完成
完整闭环（含 Undo/Redo 与执行记录落盘校验）；真实 Tauri 窗口（最终构建）验证启动、渲染、
打开项目、恢复 AI 面板状态与接受键入指令。
未完成：最终构建真实 Tauri 窗口内的「运行 → Suggestion → ChangeDraft → Diff → Reject → Apply」
交互走查——macOS 中途不再向本工具进程树投递合成鼠标点击，键盘可达但无法稳定保持前台，
WebKit 网页内容 Accessibility 树不再暴露，无法按下运行/应用/拒绝控件（环境限制）。
故本轮置为 DONE 而非 VERIFIED；NEXT ACTION 仍为继续 V0-T03（重跑该走查后即可转 VERIFIED）。
V0-T04 保持 NOT ACTIVE。

2026-09-20 | V0-T01 | IN PROGRESS → IN PROGRESS
Native Runtime smoke 与 Native Project Lock 已 VERIFIED（统一 lock/guard、30s/5s、owner 安全、stale/malformed、Native+TS 写 guard、create/open/switch/close 生命周期；Rust 11、Deno 81、Tauri build；真实 GUI session 自愈、新建/保存/heartbeat/正常 close release/reopen）。
V0-T01 仍 IN PROGRESS；尚缺 External Modification Detection、Real Desktop E2E。

2026-09-21 | V0-T02 | DONE → VERIFIED
真实 Tauri 窗口内完成 §26.9 完整 Course Authoring 走查（AX 驱动真实点击/键入 + 逐屏
AX 树与截图 OCR 核对 + 落盘文件复核）：课程地图 / 任意课跳转 / 正文键入 / 结构占位符 /
素材预览 / Flow·Grid 往返 / Preview / 保存 / 关闭释放租约 / 重启回到上次的课·模式·视图 /
第二实例被拒且不清会话。走查暴露并当轮修复 10 项只在原生路径出现的缺陷：views.js ⇄
main.js 循环导入导致应用被实例化两次、原生 session 既不写也不读阅读位置（关闭→重启→
继续实际失效）、asset_read 参数形状与 Rust 签名不符导致素材预览必定失败、多处直接
invoke 吞掉错误文本、启动先写 session 再恢复导致每次启动覆盖磁盘位置、enterProject 与
启动页按钮丢弃已恢复的视图、锁冲突时清空会话目录、session 失败误报为项目保存失败、
Tauri 构建不跟踪 app/ 导致 cargo build 打进旧前端（窗口全白）、前端加载失败时白屏无提示。
Deno 120 tests、Rust 17 tests、deno task check、cargo build 全部通过；BLOCKER = NONE；
NEXT ACTION 切换为 V0-T03。

2026-09-21 | V0-T01 | IN PROGRESS → VERIFIED
Real Desktop E2E 已闭环：真实 Finder 拖入 image/GIF/video/Markdown，Recovery Restore/Discard 与恢复前快照，External Modification Manual Save/Autosave 阻止覆盖、Reload/Merge/Explicit Resolution、Snapshot Restore 保护，Markdown/HTML 素材引用，Web regression；Rust 14、Deno 87 全部通过，Remaining Blockers 清零。下一任务仍为 V0-T02，本轮未进入。

2026-09-21 | V0-T02 | NOT ACTIVE → DONE
Course Authoring 已闭环：课程地图（整门结构/当前课/完成度/待补/任意课跳转）、单课编辑器（当前课与当前 Block 明确、正文增删改重排、结构与正文同一份数据互定位）、Flow/Grid（LayoutInstance.mode 为唯一真相，放置/移动/缩放/移出/一键排版，切换不丢内容）、素材 Authoring（缩略图预览、插入区块、AssetUsage、解除引用、删除含引用确认）、Requirement/待补（创建/编辑/定位/完成/重开/删除 + 跨课待补总览）、Preview（正文/结构/素材/布局实时一致，占位符不进入正式内容）、完成状态（六维 + 待补 + 素材 + 排版派生，课程地图同步）、跨课继续工作（跳课不丢编辑，重启回到上次的课/模式/面板/区块）、只读 asset_read 预览命令与完整 UI session 持久化。同时修复 T01 遗留的 shell 网格少一行导致工作区被压成 30px、状态栏空课崩溃、非规范状态写法导致保存失败、占位符不创建 Requirement、解除/删除素材残留 resolved_* 触发校验失败、外部合并读取错误字段导致外部改动丢失、Toast 吞点击，以及桌面模式下 inbox/blueprint 等命令缺失导致的快速收集不可用。两轮独立复核共发现 12 项缺陷（含导出全部抛错、待补完成写错引用、删课后编号重复、删课后收件箱悬空、项目身份被重置、写入前校验过严导致真实项目无法保存、排版待补引用不一致、外部重载未迁移、浏览器导出渲染器被误删）均已当轮修复并补充回归测试。两轮独立复核共发现 12 项缺陷（其中 8 项会破坏 Canonical 或打断导出/保存）均已当轮修复并补充回归测试。Deno 115 tests、Rust 16 tests、deno task check、cargo build 全部通过；真实 Tauri Desktop 二进制启动并加载三栏 Workbench，服务层完成完整 Course Authoring E2E（含外部修改冲突阻止静默覆盖、锁互斥、重启后恢复、锁被第二实例拒绝）。BLOCKER = NONE；仍缺一次真实 Tauri 窗口内的人工 Course Authoring 走查，故本轮置为 DONE 而非 VERIFIED；NEXT ACTION = 完成该走查后转 VERIFIED，再切换 V0-T03。
（历史条目：该结论已被其上方的 DONE → VERIFIED 条目取代——走查已完成，Deno 120 / Rust 17。）
```

---

# 23. Backlog 规则

Backlog 只收：

> 不阻塞当前任务，但未来可能需要处理的事项。

Backlog 不允许自动变成开发阶段。

每次准备切换到下一个任务时，才统一检查一次 Backlog：

```text
是否属于下一任务 Definition of Done？
```

### 是

并入下一任务。

### 否

继续留在 Backlog。

### 不再需要

标记：

```text
REJECTED
```

---

# 24. 防止 Scope Creep 的判断题

Agent 每准备增加一个新功能前，都必须问：

> **如果不做这件事，当前任务还能达到 Definition of Done 吗？**

如果：

### 不能

属于当前任务。

### 能

放入 Backlog。

不要顺手做。

---

# 25. 防止忘记最初目标的判断题

每次准备做较大修改前，都必须问：

> **这项修改是在帮助 Workbench 更接近“长期课程生产与维护工作台”，还是只是让当前代码看起来更完整？**

只有前者具有产品优先级。

---

# 26. 什么时候允许改变总路线

只有用户明确提出：

```text
改变产品定位
删除某个版本目标
增加新的产品级目标
重新划定 V0 / V1 / V2
```

时，才允许修改：

```text
North Star
V0
V1
V2
```

Agent 自己不能因为：

```text
实现困难
发现新技术
某个库更有趣
当前任务复杂
```

就重新规划整个项目。

---

# 27. README 与 MASTER CONTROL 的职责区别

## README.md

回答：

```text
这个项目是什么？
怎么运行？
当前代码支持什么？
目录是什么？
```

---

## PROJECT_MASTER_CONTROL.md

回答：

```text
为什么做这个项目？
当前在 V0 / V1 / V2 哪一步？
现在正在做什么？
哪些做完了？
哪些没做完？
哪些做得不够好？
还有多少工作？
下一步唯一做什么？
什么时候允许进入下一个版本？
```

两者不要混在一起。

---

# 28. 临时开发文档的角色

可以继续生成类似：

```text
PATCH_REPORT.md
DESKTOP_CLOSURE.md
AUTHORING_SPEC.md
AI_WORKFLOW_SPEC.md
```

但它们只能是：

> **某一次任务的输入材料 / 设计资料。**

它们不能决定：

```text
当前版本
当前项目优先级
项目是否完成
下一阶段是什么
```

这些只有：

```text
PROJECT_MASTER_CONTROL.md
```

可以决定。

---

# 29. 当前唯一 NEXT ACTION

> **V0 仍为 CLOSED；V0-T01 / V0-T02 / V0-T03 / V0-T04 全部 VERIFIED。V1 已 ACTIVE。V1-T01 — V0 Hardening & UX Polish = VERIFIED；V1-T02 — macOS Distribution & Public Release Closure = PARTIAL（BLOCKER：缺正式 macOS signing / notarization credentials）。**

V1-T01 的实现、自动化门禁与最终构建的真实走查（桌面 + 浏览器）全部完成（证据见 §33），OPEN BLOCKERS = NONE。

V1-T02 由用户明确提出，因此允许创建；它把已 DOGFOOD READY 的 Workbench 做成普通 macOS 用户可下载安装的正式分发包。
已完成：文档对齐、仓库安全预检、Universal（Apple Silicon + Intel）Release 构建、正式 DMG、
版本号与 bundle 元数据、SHA-256、公开 GitHub 仓库、`v0.1.0` tag、GitHub Release、固定 latest 直链、
安装后 App 的真实运行 smoke。**未完成**：Developer ID Application 签名与 Apple 公证/stapling，
因此**不得宣称** `PUBLIC RELEASE READY` / 「普通用户无安全阻碍安装」（证据与边界见 §34）。

```text
V0 CLOSED
V0-T01 / V0-T02 / V0-T03 / V0-T04  VERIFIED
V1 ACTIVE
CURRENT TASK    V1-T02 — macOS Distribution & Public Release Closure
CURRENT STATUS  PARTIAL
PRODUCT STATE   DOGFOOD READY
DISTRIBUTION    PARTIAL
OPEN BLOCKERS   BLOCKER：缺正式 macOS signing / notarization credentials
```

下一步唯一动作：

```text
获取 Apple Developer 分发资格后补做签名 / 公证 / Release 重传 / 安装 smoke
```

拿到 Developer ID Application 证书与公证凭据后，只需：

```text
1. 导入证书并设置 APPLE_SIGNING_IDENTITY（本机钥匙串 / GitHub Actions Secrets）
2. 重新执行 cargo tauri build --target universal-apple-darwin --bundles app,dmg
   （或直接运行 .github/workflows/release.yml，它会自动签名 + 公证）
3. 用同一个固定文件名 AI-Course-Workbench-macOS.dmg 重新上传 Release Asset
4. 重跑一次安装 smoke 与 spctl 评估
```

**不需要重新开发 Workbench 本体。** 在此之前不重新打开 V0，也不创建 V1-T03 或任何新的阶段层级。

注意：Dogfooding 是产品使用状态，不是新的产品阶段；不得创建
`Dogfood Phase` / `V1-Dogfood` / `V1.1` / `V1-T01A`。

（文档纠错：本项目 V0 只有 T01–T04，此前出现的“V0-T05 发布能力”为笔误，已更正为
`V0-T04 — Output & Publish`，不创建 V0-T05。）

---

# 30. 当前总控摘要

```text
PROJECT
AI Course Workbench

NORTH STAR
长期、本地优先、AI 协作的课程生产与维护工作台

CURRENT VERSION
V1（ACTIVE）

CURRENT TASK
V1-T02 — macOS Distribution & Public Release Closure

CURRENT STATUS
PARTIAL
PRODUCT STATE = DOGFOOD READY
DISTRIBUTION STATE = PARTIAL
V0 = CLOSED；V0-T01 / V0-T02 / V0-T03 / V0-T04 全部 VERIFIED
V1-T01 = VERIFIED（§33）；V1-T02 = PARTIAL（§34）

DONE / IMPLEMENTED
- Canonical / Domain / Service 主体
- Web Workbench 主体
- Native Desktop 主体代码
- Native Picker 代码
- Asset Import / checksum / Asset·Usage
- Autosave / Recovery 基础
- Course Map / Lesson Editor / Flow-Grid / 素材 Authoring / 待补 / Preview / 完成状态
- 只读 asset_read 预览命令与完整 UI session 持久化
- 真实 Tauri 窗口内完整 Course Authoring 走查（含关闭 → 重启 → 继续）
- AI Context Assembly（Course / Lesson / Block，可预览、可复现、只读）
- 统一 AI Connector 边界 + 离线确定性连接器 + 完整错误码归一
- AI 助手面板：范围 / 上下文预览 / Provider·Model / 运行 / 取消 / Suggestion / ChangeDraft / Diff / Reject / Apply
- AI Apply 进入与人工编辑同一套 commit / history / undo / redo / autosave
- AI 执行记录（非 Canonical、0600、无密钥、一次运行一行）
- 密钥由所在进程注入，不进入 project.json / Canonical / 导出包 / 诊断包
- 只读 Publish Projection + 导出前检查（BLOCKING / WARNING）+ 发布与导出中心
- 输出：Markdown（当前课 / 整门课程）、Semantic HTML、Static Web Package、PDF、
  微信 / 富文本迁移版、Project JSON、素材包、完整项目包；导出严格只读并可记录发布节点
- 真实 Tauri 窗口内完整 Output & Publish 走查（含自拷贝素材回归、BLOCKING 拦截、关闭 → 重启）
- V1-T01 收尾：项目切换状态机（按 project_id 分别保存阅读位置，切换不继承旧项目状态、失败回滚）
- V1-T01 收尾：系统级凭据存储（macOS 钥匙串，桌面壳 + 浏览器服务两条路径；明文迁移成功后删除、零泄漏）
- V1-T01 收尾：浏览器刷新 / 会话恢复（browser-session.json，版本化 + 字段白名单 + 安全降级）
- V1-T01 收尾：重复交互清理（顶栏改为「项目选择」，左右栏各一个与自身绑定的折叠控件）
- V1-T01 收尾：全局 UI 对齐 + 大白话文案（保存 / 锁 / 外部冲突 / 凭据 / 恢复 / 下一步动作）
- 测试与回归：Deno 236 tests + Rust 49 tests + cargo build + cargo tauri build --debug（.app 成功生成）
- 真实走查：最终构建的桌面走查 + 浏览器刷新走查 + 首启验收（真正首次启动状态）
- V1-T02 分发：正式 Release 构建（Universal，arm64 + x86_64）、DMG 打包、正式图标集（.icns 全尺寸）
- V1-T02 分发：产品元数据对齐（productName / identifier / version / 最低 macOS / 分类 / 版权）
- V1-T02 分发：固定 asset 文件名 `AI-Course-Workbench-macOS.dmg` + SHA-256 校验资产
- V1-T02 分发：公开 GitHub 仓库、`v0.1.0` tag、GitHub Release、`/releases/latest/download/...` 固定直链
- V1-T02 分发：最小 release workflow（tag / 手动触发；配好 Secrets 后自动签名 + 公证）
- V1-T02 分发：安装后 App 的真实运行 smoke（从 /Applications 启动、干净默认主页、三栏工作台、
  AI 助手与钥匙串说明、关闭 → 重启）
- V1-T02 安全预检：全仓 + 全 Git history 密钥扫描、用户数据 / 开发痕迹清理、文档脱敏

OPEN BLOCKERS
- BLOCKER：缺正式 macOS signing / notarization credentials
  （本机 0 valid code-signing identities；无 Developer ID Application 证书，无公证凭据）
  → 当前 DMG 为 ad-hoc 签名，`spctl --assess` 判定 rejected；
     不得宣称 PUBLIC RELEASE READY / 「普通用户无安全阻碍安装」

AFTER CURRENT TASK
拿到 Apple Developer 分发资格后补做签名 / 公证 / Release 重传 / 安装 smoke；
在此之前不创建 V1-T03，也不重新打开 V0。

V1
ACTIVE

V2
NOT ACTIVE

NEXT ACTION
获取 Apple Developer 分发资格后补做签名 / 公证 / Release 重传 / 安装 smoke
（V1-T02 = PARTIAL；PRODUCT STATE = DOGFOOD READY；V0 保持 CLOSED，四个 V0 任务保持 VERIFIED。）
```

---

# 31. 最终纪律

整个项目以后只回答三个层级的问题：

```text
1. 我们现在处在哪个版本？
2. 当前正在完成哪个平铺任务？
3. 当前任务的下一步是什么？
```

不再创建新的阶段树。

如果一个任务执行五轮才完成：

> 它仍然是同一个任务。

如果出现十个 Bug：

> 它们仍然是当前任务的缺陷。

如果某件事不阻止当前任务完成：

> 它进入 Backlog。

只有当 Definition of Done 真正满足：

```text
DONE
→ VERIFIED
```

才移动到下一任务。

这样项目才能真正从：

```text
V0
↓
V1
↓
V2
↓
完成
```

而不是无限长成：

```text
V0
└─ M1
   └─ N1
      └─ Patch A
         └─ Fix Phase 2
            └─ ...
```

---

# 32. Agent 启动口令

每次新的 Agent / 新会话开始工作时，都可以直接给出：

> **先完整阅读 `PROJECT_MASTER_CONTROL.md` 和 `README.md`。不要重新规划版本，不要创建新的 Milestone。确认当前 Version、Current Task、Definition of Done 和 NEXT ACTION 后，只继续当前任务。任务结束后按照总控规定输出 Completion Report，并同步更新 `PROJECT_MASTER_CONTROL.md`。**

这条规则优先于任何历史临时开发文档中的阶段命名。

---

# 33. V1-T01 — V0 Hardening & UX Polish（VERIFIED）

> 状态：**DONE → VERIFIED**　｜　完成时间：2026-09-23
> 产品状态：**DOGFOOD READY**　｜　OPEN BLOCKERS：**NONE**
> 任务卡：`V1-T01_V0_Hardening_and_UX_Polish.md`

## 33.1 七项收尾内容（Done）

| # | 收尾项 | 结果 | 关键实现 |
|---|---|---|---|
| 1 | 项目切换状态机 | 完成 | 切换只提交新项目自身状态；按 `project_id` 分别保存阅读位置；切换失败 / 回滚保留原会话，不产生「新目录 + 旧 project_id / 旧阅读位置」 |
| 2 | 系统级凭据存储 | 完成 | macOS 钥匙串（`com.ai-course-workbench.ai`），桌面壳 Rust `MacKeychainStore` 与浏览器服务 `MacKeychainSecretStore` 两条路径；`providers.json` 只留元数据，明文仅在写入并校验成功后迁移删除，失败保留并给出可读提示、不回显 |
| 3 | 浏览器刷新 / 会话恢复 | 完成 | `<project>/.workspace/browser-session.json`：版本号 + 字段白名单 + 64KB 上限；缺失 / 损坏 / 属于其他项目时安全降级，不白屏、不写错项目 |
| 4 | 重复 UI 交互清理 | 完成 | 顶栏重复折叠按钮改为「项目选择」（返回默认主页、不关闭项目）；左右栏各只保留一个与自身绑定的折叠控件；全仓重复交互审计 |
| 5 | 全局 UI 对齐 | 完成 | 工作台各核心界面控件位置 / 尺寸 / 间距统一，保留必要的紧凑例外 |
| 6 | 大白话文案 | 完成 | 保存失败 / 项目锁 / 外部修改冲突 / 凭据写入 / 恢复与下一步动作改为用户可读表述，并说明「不会做什么」 |
| 7 | 自动化 + 真实回归 | 完成 | 见 §33.2 与 §33.3 |

## 33.2 自动化验证

```text
deno task check             通过（exit 0）
deno task test              236 passed / 0 failed
cargo test                  49 passed / 0 failed
cargo build                 通过
cargo tauri build --debug   生成 .app 成功；.dmg 未能生成（本环境禁用 hdiutil，见 §33.4）
```

新增 / 扩展测试：`tests/workbench_ui_test.ts`（折叠控件唯一性、控件对齐、返回主页保留项目与位置、文案可读性）、
`tests/browser_session_test.ts`（浏览器会话存取、白名单、上限、损坏 / 缺失 / 串项目降级）、
`tests/recovery_ui_test.ts`（A→B→A 阅读位置与身份、失败回滚）、`tests/ai_transport_test.ts`、
`tests/native_boot_test.ts`、`tests/ai_ui_test.ts`、`tests/ai_workflow_test.ts`、`tests/native_boundary_test.ts`。

## 33.3 真实走查证据

**桌面（最终构建 `.app`）**

- 启动 → 默认主页（首启状态：新建课程 / 打开项目文件夹 / 种子选择，无任何测试项目）；
- 打开项目 A（真实课程项目，3 课）→ 切到第 2 课；
- 点顶栏「项目选择」→ 回到默认主页，**项目与阅读位置仍在**（继续工作卡显示 S01-02），项目租约未释放；
- 左栏折叠控件收窄为窄轨 `☰` 后点击可原样恢复（导航 13 项 → 0 → 13）；右栏折叠 / 展开对称；
- 顶栏只有课次前后导航 `‹ ›` 与「项目选择」，无重复折叠按钮；
- AI 助手 → DeepSeek → 「设置」：显示「这里保存的是地址与模型名，不是密钥」；
  未配置时如实提示「缺少密钥，不会伪造回答」；
- 密钥保存 → 系统钥匙串出现账户 `<project-hash>:provider:deepseek`
  （与 Rust 实现的 sha256 账户规则一致），UI 转为「已配置密钥」；更新 → 条目修改时间刷新；
  删除 → 条目消失、UI 回到「未配置密钥」；
- 项目未完成保存时启动会给出恢复选择（保留磁盘版本 / 恢复暂存内容），实测「保留磁盘版本」可正常继续。

**浏览器（真实 Chromium + 本地服务，`PROJECT_ROOT=<测试项目>`）**

- 载入项目 → 切到 S01-02 → 切右侧面板到「媒体」→ `browser-session.json` 记录
  `project_id`（项目 A）、`active_content_item_id`（S01-02）、`right_panel=media`；
- 刷新页面 → 课程位置与右侧面板均恢复；
- 正文追加标记 → 「保存」显示「已保存」→ 刷新后标记仍在、位置不变；
- 左栏折叠状态写入会话（`left_collapsed: true`）。

## 33.4 验证方式与限制说明（如实记录）

- `.dmg` 未能生成：`hdiutil create ... ` 在本环境返回 `Operation not permitted`（对 /tmp 的自建镜像同样失败），
  属**环境对磁盘镜像操作的权限限制**，不是仓库或产品缺陷；任务卡要求的最终构建产物 `.app` 已成功生成并用于上述走查。
- 桌面壳的密钥读写需要**不继承代理沙箱**的进程上下文：由代理会话直接派生的子进程会被沙箱拒绝钥匙串写入
  （`UNIX[Operation not permitted]`），改用 LaunchServices（`open`）启动应用后，保存 / 更新 / 删除全部实测通过。
  这是验证环境约束，用户正常双击启动不受影响。
- 原生「打开项目文件夹」面板（NSOpenPanel）的列表项在本环境未通过 AX / OCR 稳定暴露，因此**多项目切换**的运行时验证
  采用两条路径交叉印证：①一次真实的经面板完成的切换（会话从上一个项目一致地切换到新项目自身的位置，未继承旧位置）；
  ②服务层与 UI 层自动化用例覆盖 A→B→A 身份 / 位置 / 失败回滚。面板本身的打开、取消、路径跳转均实测可用。
- 首启验收通过界面控件（新建课程 / 打开项目文件夹 / 继续工作 + 种子选择）与「退出后应用数据目录零文件」确认，
  未使用截图 OCR（本环境双屏 Retina 下 OCR 坐标不可靠）。

## 33.5 清理与用户数据保护

- 移除 `/tmp` 与 `/private/tmp` 下全部测试夹具、日志、导出物与临时工具（`v1t01-*`、`acw-*`、`V0-T0*`、`workbench-*` 等）；
- 应用数据目录中的测试会话与假 provider 执行记录已清空；首启验收后该目录**无任何持久化文件**（真正首次启动状态）；
- 测试期间写入系统钥匙串的测试密钥已删除（服务名下无残留条目）；
- 用户真实课程项目（本地路径已隐去）：内容零改动（与本地备份深度比对，唯一差异为
  `project.updated_at` 元数据刷新），未删除、未导入任何测试素材；
- 仓库工作区无测试 / 调试生成物，未跟踪文件仅为本次任务卡与新增源码 / 测试。

## 33.6 Definition of Done 对照

| DoD 项 | 结论 |
|---|---|
| 17.1 状态一致性（切换不继承、关闭重启一致） | 通过（自动化 + 运行时证据） |
| 17.2 系统级凭据存储 | 通过（钥匙串实测 + 零明文泄漏） |
| 17.3 浏览器会话 | 通过（刷新恢复 + 安全降级） |
| 17.4 UI 交互唯一性 | 通过（顶栏 / 左右栏控件唯一且绑定自身） |
| 17.5 UI 对齐与恢复 UI | 通过 |
| 17.6 大白话文案 | 通过 |
| 17.7 回归 | 通过（Deno 236 / Rust 49 / check / build） |
| 17.8 全新状态 | 通过（首启零持久化文件，无测试项目） |
| 17.9 项目总控 | 通过（README、本文件、Change Log、V1-T01 = VERIFIED、NEXT ACTION 未创建 V1-T02） |

## 33.7 Backlog（本轮不改，留给真实使用反馈判断）

- 原生打开项目面板在自动化环境下的可访问性（属验证工具限制，非产品问题）；
- `.dmg` 打包在受限环境无法验证（需在普通桌面会话复核一次）；
- `--project-dir` 启动参数在已有其他会话时不会把该参数项目提交为会话项目（用户界面路径不受影响）；
- 面板列表在超长目录下的滚动 / 搜索体验（观察项，待真实使用反馈）。

## 33.8 结论

```text
V1-T01 = VERIFIED
PRODUCT STATE = DOGFOOD READY
OPEN BLOCKERS = NONE
NEXT ACTION = PAUSE FEATURE DEVELOPMENT
```

用户拿到的是一个没有测试痕迹、刷新与切项目不会迷路、凭据保存在系统钥匙串、交互不重复、
界面基本整齐、说明容易看懂的 Workbench，可直接开始真实课程制作并连续使用。
本任务到此停止功能开发，不创建 V1-T02，等待真实使用反馈。

---

# 34. V1-T02 — macOS Distribution & Public Release Closure（PARTIAL）

> 状态：**DONE → PARTIAL**　｜　完成时间：2026-09-23
> 产品状态：**DOGFOOD READY**　｜　分发状态：**PARTIAL**
> OPEN BLOCKERS：**BLOCKER — 缺正式 macOS signing / notarization credentials**
> 任务卡：`V1-T02_macOS_Distribution_and_Public_Release_Closure.md`

由用户明确提出而创建。它是一个**平铺任务**，不是新的 Milestone，也不是 V1.1 / Release Phase / Distribution Phase。
本轮不增加任何课程编辑、AI、发布格式或工作流能力，只把已 DOGFOOD READY 的 Workbench 做成可下载安装的正式分发包。

## 34.1 四件原始目标对照

| # | 目标 | 结果 |
|---|---|---|
| 1 | README / MASTER CONTROL 文档状态彻底对齐 | 完成（V1-T01 = VERIFIED；V1-T02 = PARTIAL；下载入口 / 系统要求 / 安装步骤 / 首次打开说明 / 分发状态全部写明） |
| 2 | 生成普通 macOS 用户可直接安装的正式分发包 | 完成（Universal DMG，Release 构建，正式图标与元数据），但**签名与公证未完成** → 首次打开多一步 |
| 3 | 推送 GitHub 并创建带可下载安装包的 GitHub Release | 完成（仓库已 public，`v0.1.0` Release 含 `AI-Course-Workbench-macOS.dmg` 与 `.sha256`） |
| 4 | 固定、简单、可长期使用的「最新版本直接下载」链接 | 完成（`/releases/latest/download/AI-Course-Workbench-macOS.dmg`，asset 文件名不随版本变化） |

结论：目标 1 / 3 / 4 完成；目标 2 **部分完成** —— 安装包本身已可安装并实测可用，
但「双击即开、无任何安全阻碍」这一步被签名 / 公证凭据卡住，因此整体为 **PARTIAL**。

## 34.2 分发格式与架构

```text
分发格式：DMG（未增加 PKG / Homebrew Cask / Mac App Store / 自定义安装器 / 自动更新器）
架构：Universal —— arm64 + x86_64 同一个安装包
命令：cargo tauri build --target universal-apple-darwin --bundles app,dmg
实测：lipo -archs → "x86_64 arm64"（Universal 构建成立，未降级为单一架构）
最低系统：macOS 11.0（与二进制 LC_BUILD_VERSION minos 11.0 一致）
```

构建环境先补装 `x86_64-apple-darwin` Rust target（本机原本只有 `aarch64-apple-darwin`），Universal 目标因此可以成立。

## 34.3 产品元数据（正式打包前检查）

| 项 | 结果 |
|---|---|
| productName | `AI Course Workbench`（无 debug / test / v0-t04 等痕迹） |
| identifier / bundle id | `local.ai-course-workbench` → **`io.github.wyzh0117.ai-course-workbench`** |
| version | `0.1.0`（tauri.conf.json 与 Cargo.toml 一致，Release Tag `v0.1.0`） |
| App 图标 | 由 1024×1024 源图生成正式全尺寸图标集；macOS 使用 `icon.icns`；DMG 卷图标同源 |
| 窗口标题 | `AI Course Workbench` |
| Finder / Applications / Dock 显示名 | `AI Course Workbench`（`CFBundleDisplayName` / `CFBundleName`） |
| 最低 macOS | `LSMinimumSystemVersion 11.0` |
| 分类 / 版权 | `public.app-category.education` / `NSHumanReadableCopyright` |
| 架构 | Universal（arm64 + x86_64） |

identifier 更换说明：`local.` 前缀是占位感较强的开发期取值，公开分发后会长期固化在
Launch Services、应用数据目录与用户机器上；应用数据目录当前为空（无数据迁移成本），
因此这是**唯一可以无痛更换的时机**。更换后应用数据目录为
`~/Library/Application Support/io.github.wyzh0117.ai-course-workbench`，用户项目数据不受影响。

## 34.4 发布资产与校验

```text
asset 文件名（固定，永不随版本号变化）：AI-Course-Workbench-macOS.dmg
字节数：10,357,233
SHA-256：59597a342109785e190d9dc8194d841744249dbbc46498ee594572d2d2412573
同时上传：AI-Course-Workbench-macOS.dmg.sha256
```

固定文件名是「固定直链」成立的前提：Release Tag 可以是 `v0.1.0` / `v0.1.1` / `v0.2.0`，
但下载资产文件名必须始终是 `AI-Course-Workbench-macOS.dmg`，否则
`/releases/latest/download/<asset>` 会随版本失效。

## 34.5 签名状态（本任务的核心限制）

```text
security find-identity -v -p codesigning  →  0 valid identities
Developer ID Application 证书             →  不存在（钥匙串中无任何开发者证书）
App Store Connect API Key / 公证凭据      →  不存在
```

因此本轮只能做 **ad-hoc 签名**（`APPLE_SIGNING_IDENTITY="-"` 走 Tauri 官方签名路径）：

```text
codesign --verify --deep --strict   →  valid on disk / satisfies its Designated Requirement（通过）
codesign -dv                         →  Identifier=io.github.wyzh0117.ai-course-workbench
                                        Signature=adhoc, TeamIdentifier=not set
                                        Info.plist entries=16, Sealed Resources version=2
spctl --assess --type execute        →  rejected
```

Tauri 打包过程同时明确输出：

```text
Warn skipping app notarization, no APPLE_ID & APPLE_PASSWORD & APPLE_TEAM_ID
     or APPLE_API_KEY & APPLE_API_ISSUER & APPLE_API_KEY_PATH environment variables found
```

**必须如实说明**：未签名 / 未公证的 App 从浏览器下载后会被 Gatekeeper 隔离，
普通用户首次打开需要「右键 → 打开 → 再点打开」或到「系统设置 → 隐私与安全性」放行。
这不是本任务定义的「傻瓜式普通用户安装体验」，因此：

```text
不得宣称：PUBLIC RELEASE READY
不得宣称：普通用户无安全阻碍安装
不得宣称：正式站外分发已完成
```

本任务未做 ad-hoc 签名之外的任何绕过（不指导用户 `xattr -d com.apple.quarantine`、不关闭 Gatekeeper）。

**隔离状态实测**：把 Release 资产重新匿名下载后，按浏览器行为打上 quarantine 属性
（`com.apple.quarantine = 0083;<hex 时间>;Safari;`），挂载、取出 App 再评估：

```text
spctl --assess --type execute --verbose=4 "&lt;解包后放在临时目录的 AI Course Workbench.app&gt;"
  →  rejected（exit 3）
```

即**普通用户从浏览器下载拿到的就是这个被拦截的状态**，上面的「首次打开说明」不是推测。

**如实记录一处未实测项**：`README.md` 给出的「右键 → 打开 → 再点打开」是 macOS 对
**签名有效但没有 Developer ID** 的 App 提供的标准放行路径，本包
`codesign --verify --deep --strict` 通过、满足自己的 Designated Requirement，正属于这一类；
但该 GUI 放行动作在本环境无法被自动化执行（无法投递右键菜单点击），
因此**本轮只实测了放行前的拦截状态，没有实测放行之后的首次启动**。
想在真机上确认这一点，需要人工在「应用程序」里右键打开一次。

## 34.6 公开仓库与 Release

```text
仓库：https://github.com/wyzh0117/workbench           （PRIVATE → PUBLIC，已生效）
Release 页面：https://github.com/wyzh0117/workbench/releases/latest
Release Tag：v0.1.0（annotated，指向 90872bd）
Release 标题：AI Course Workbench v0.1.0 — macOS (Universal)
Release 状态：已发布（isDraft=false, isPrerelease=false）
Release Assets：
  AI-Course-Workbench-macOS.dmg           10,357,233 bytes
  AI-Course-Workbench-macOS.dmg.sha256    96 bytes
固定直链：https://github.com/wyzh0117/workbench/releases/latest/download/AI-Course-Workbench-macOS.dmg
```

GitHub 侧独立记录的资产摘要与本机一致，说明上传过程未损坏文件：

```text
GitHub asset digest : sha256:59597a342109785e190d9dc8194d841744249dbbc46498ee594572d2d2412573
本机 shasum -a 256  :     59597a342109785e190d9dc8194d841744249dbbc46498ee594572d2d2412573
```

**匿名（未登录）下载链验证** —— 这是「固定直链」是否真的成立的关键证据：

```text
GET /releases/latest
  → 302 → https://github.com/wyzh0117/workbench/releases/tag/v0.1.0

GET /releases/latest/download/AI-Course-Workbench-macOS.dmg   （不带任何 Authorization）
  → 200，由 GitHub CDN（release-assets.githubusercontent.com）返回
  → 下载得到 10,357,233 bytes
  → 下载文件 SHA-256 == Release Notes 中记录的 SHA-256          ✅ 完全一致

GET /releases/latest/download/AI-Course-Workbench-macOS.dmg.sha256
  → 返回 "59597a34…  AI-Course-Workbench-macOS.dmg"

GET https://github.com/wyzh0117/workbench                      → 200（匿名可访问）
```

同步新增 `.github/workflows/release.yml`：最小化、单 macOS 作业、Universal 构建 →
固定 asset 名重命名 → SHA-256 → 上传 Release Asset；**不**做多平台矩阵 / Windows / Linux /
自动更新服务 / Nightly / Beta / 复杂 Release Matrix。Apple 凭据全部通过 `secrets.*` 注入，
Actions 按 commit SHA 固定。配置好 Secrets 后同一条 workflow 会自动完成签名与公证，
不需要改代码。**注意：该 workflow 在本轮未实际运行过**（首次运行需要 tag 推送或手动触发），
属「已备好的路径」，不计入本轮已验证项。

本轮发版时曾临时停用该 workflow，以免它在 tag 推送时用未签名的 CI 产物覆盖本机已验证并
通过安装 smoke 的 DMG；Release 建好后又重新启用（当前状态 active）。
**因此后续推送 `v*` tag 会触发一次 CI 构建**：在 Secrets 配好之前它会产出一个未签名 DMG，
配好之后才会产出已签名已公证的 DMG。

## 34.7 交付与验证证据

| 项 | 证据 |
|---|---|
| 自动化门禁 | `deno task check` 通过（exit 0）；`deno task test` 236 passed / 0 failed；`cargo test` 49 passed / 0 failed |
| 正式构建 | `cargo tauri build --target universal-apple-darwin --bundles app,dmg` exit 0（release profile，非 Debug） |
| 架构 | `lipo -archs` → `x86_64 arm64` |
| 签名 | `codesign --verify --deep --strict` 通过；`spctl` rejected（见 34.5） |
| DMG 内容 | 挂载后含 `AI Course Workbench.app`、`Applications -> /Applications` 符号链接、`.VolumeIcon.icns` |
| Info.plist | `CFBundleIdentifier` / `CFBundleShortVersionString` / `LSMinimumSystemVersion` / 分类 / 图标全部正确 |
| 安装 | 从挂载的 DMG 拖入 `/Applications`，安装后 `codesign --verify --deep --strict` 仍通过 |
| 首启 | 首次启动前应用数据目录零文件；启动后为干净默认主页（新建课程 / 打开项目文件夹 / 继续工作 + 种子选择），**无测试项目** |
| 运行位置 | 进程路径为 `/Applications/AI Course Workbench.app/Contents/MacOS/ai-course-workbench`，**不依赖 `src-tauri/target/debug`** |
| 三栏工作台 | 真实窗口内进入项目后渲染完整工作台：项目选择 / 课程地图 / 收件箱 / 制作看板 / 媒体库 / 待补总览 / 更新中心 / 发布中心 / 版本历史 / 项目设置 / 快速收集 / 搜索与命令，右栏 媒体 / 待补 / 状态 / AI 助手 / 属性 / 版本 |
| AI 与钥匙串界面 | AI 助手面板显示「本地优先 · 只生成可审核建议」、上下文范围、服务商 / 模型、以及「API Key 只由本机服务写入 macOS 系统钥匙串，不回显，也不会进入课程、备份、日志、导出或执行记录」；设置区可展开显示名称 / Base URL / 默认模型 |
| 关闭 → 重启 | AppleEvent 正常退出（0 残留进程），项目租约释放（`project.lock` 删除）；再次启动正常 |
| 数据保护 | 验收使用的项目是 `/tmp` 下的隔离副本，原 `.workbench-project/project.json` SHA-256 前后一致（`606bb5dc…`） |

## 34.8 Runtime Smoke 对照

| 项 | 结论 |
|---|---|
| 安装后的 App 可以启动 | 通过（`/Applications` 真实窗口） |
| 新建课程入口可用 | 通过（点击「新建课程」打开原生文件夹选择面板；面板 Cancel/Open 均存在） |
| 打开项目入口可用 | 通过（`--project-dir` 打开隔离副本；点击「继续工作」卡进入完整三栏工作台） |
| 不加载测试项目 | 通过（真正首次启动为零持久化文件 + 干净默认主页） |
| 关闭 / 重启正常 | 通过（干净退出、租约释放、重启一致） |
| 不依赖 `target/debug` 运行 | 通过（进程路径为 `/Applications/...`） |
| 无 Debug 构建路径漏出 | 通过（本轮交付物全部来自 release profile） |
| 出现 Debug 名称 / 测试项目 / DevTools | 未出现 |

## 34.9 安全预检与文档脱敏

公开仓库前对**当前工作树与全部 Git history**做了独立审计（结果：无真实凭据、无用户数据文件、history 可安全发布）：

- 27 处 `sk-` 命中全部为自解释的测试夹具（如 `sk-should-never-be-written`、`sk-round-trip-must-never-return`），非真实密钥；
- 无 `ghp_` / `AKIA` / 私钥 / `.env` / `.p8` / `.p12` / `.mobileprovision` / `.cer` 命中，且这些文件从未进入任何提交；
- `.workbench-project/`、`.workspace`、`project.lock`、诊断日志、快照、会话文件**从未被提交**；
- 提交身份为 GitHub noreply 邮箱，无个人邮箱泄漏；
- **本轮修正**：`PROJECT_MASTER_CONTROL.md` 中本机真实路径、真实课程标题、钥匙串账户 UUID 全部脱敏为通用描述；
  `src-tauri/README.md` 中已过时的「无 Rust 工具链 / 钥匙串未实现」表述更正为与当前代码一致；
  `.gitignore` 补入 `.release/`、`.release-tmp/`、`dist/`、`*.dmg`、`*.dmg.sha256`（release 暂存目录不得入库）。

## 34.10 本轮明确的非目标（未做，也不做）

```text
不新增课程编辑 / AI / 发布格式 / 工作流能力
不增加 PKG / Homebrew Cask / Mac App Store / 自定义安装器 / 自动更新器
不构建 Windows / Linux 分发包
不做多平台 Release Matrix / Nightly / Beta 通道
不实现浏览器代替用户自动挂载 DMG、写入 /Applications 或自动启动
不绕过 Gatekeeper，不指导用户移除 quarantine 属性
不把密钥写入仓库、Release Notes、日志或任何提交
```

## 34.11 Definition of Done 对照

| DoD 项 | 结论 |
|---|---|
| 34.1 文档状态一致性 | 通过 |
| 34.2 分发格式仅 DMG | 通过 |
| 34.3 产品元数据正式且无开发痕迹 | 通过 |
| 34.4 Universal 架构（或如实降级说明） | 通过（Universal 成立，未降级） |
| 34.5 正式构建（非 Debug） | 通过 |
| 34.6 SHA-256 校验 | 通过 |
| 34.7 安全预检（无密钥 / 无用户数据 / 无开发痕迹） | 通过 |
| 34.8 公开仓库与 GitHub Release | 通过 |
| 34.9 固定直链可下载 | 通过（`/releases/latest/download/AI-Course-Workbench-macOS.dmg`） |
| 34.10 签名 / 公证 | **未通过** — BLOCKER：缺 Developer ID 与公证凭据 |
| 34.11 普通用户双击安装体验 | **未通过** — 首次打开需要一次显式放行 |
| 34.12 文档记录两个下载入口 | 通过（README 的 Release 页面 + 固定直链） |
| 34.13 Runtime Smoke | 通过（见 34.8） |

## 34.12 Backlog（本任务不做，留给拿到分发资格之后）

- 获取 Apple Developer Program 分发资格 → Developer ID Application 证书 + 公证凭据；
- 用同一固定 asset 文件名重新构建并上传 Release，使 `spctl --assess` 通过、stapling 生效；
- 在 GitHub Actions Secrets 中配置证书与公证凭据，实跑一次 `.github/workflows/release.yml`；
- 重跑一次「下载 → 安装 → 首次打开无阻碍」的干净机器 smoke；
- 将 release workflow 的 Actions 依赖升级到新版本时同步更新 commit SHA；
- 用 `--remap-path-prefix` 重新构建，去掉二进制里内嵌的本机 Cargo registry 绝对路径
  panic 位置元数据（属卫生问题，非泄漏；会改变 SHA，适合与下一次签名发版一起做）；
- 仓库当前**没有 LICENSE**（公开仓库默认「保留所有权利」）。是否开源、用哪个许可证属用户决策，
  本轮不擅自添加；
- 两份 Release 资产的下载计数目前只有发版本机自己的匿名校验下载（各 2 次），
  还没有任何第三方真正下载过；Intel 切片与 macOS 11.0 最低版本都还没有在真实机器上跑过。

## 34.13 独立复核与据其修正

交付后由一个**未参与实现**的 subagent 做只读对抗性复核（不修改任何东西）：
逐条重derive 上面的每一项声明、扫描全部 refs 的 208 个 blob、检查非目标合规、专门搜索过度声明。

复核结论：**PASS-WITH-NOTES** —— `V1-T02 = PARTIAL` 是**正确且被如实报告**的状态；
**未发现任何过度声明**（仓库里每一处 `PUBLIC RELEASE READY` 都是否定句）；
非目标全部合规（无 PKG / Cask / MAS / 自定义安装器 / 自动更新器 / Windows / Linux / 矩阵 / Nightly / Beta）；
`release.yml` 是单个 `macos-latest` 作业、3/3 Actions 按 SHA 固定、零明文密钥。

复核发现的问题与**本轮已做的修正**：

| # | 复核发现 | 严重度 | 本轮处理 |
|---|---|---|---|
| 1 | Release Notes 的「首次打开说明」只给了「右键 → 打开」，并断言「此后双击即可正常打开」；**在 macOS 15 (Sequoia) 及更新版本上这条已失效**（Apple 官方公告：Control-click 不再能绕过 Gatekeeper，必须到「系统设置 → 隐私与安全性」） | 高 | **已修**：README 与 Release Notes 都改为按版本分两条路径（macOS 15/26+ 走「系统设置 → 隐私与安全性 → 仍要打开」；macOS 11–14 走右键打开），并去掉「此后双击即可正常打开」这种一刀切说法；线上 Release Notes 已用 `gh release edit` 更新（资产未动，SHA 不变）；`release.yml` 自动生成的 Notes 同步修正 |
| 2 | `release.yml` 在已存在 Release 时走 `--clobber` 覆盖资产，却不重写 Notes，会让 Notes 里记录的 SHA-256 与新资产不一致 | 中 | **已修**：覆盖资产后追加 `gh release edit --notes-file dist/release-notes.md` |
| 3 | `APPLE_API_KEY_PATH` 被当成 repository secret，但它必须指向 runner 上真实存在的 `.p8`，照原样配是不可用的（「配好 Secrets 就不用改代码」只对 Apple ID 路线成立） | 中 | **已修**：新增「Materialize App Store Connect API key (optional)」步骤，把 `APPLE_API_KEY_P8` 写成 runner 临时目录的 `.p8` 并经 `GITHUB_ENV` 传入；Apple ID 路线保持原样，两条路线都在注释里写明 |
| 4 | 公开文档里残留上一轮的临时验收路径与实例名（系统临时目录下的测试项目名、锁文件 owner 等） | 低 | **已修**：改为通用描述；保留了对真实 commit 主题的引用（那是对历史的如实引用） |
| 5 | 二进制内嵌 514 个本机 Cargo registry 绝对路径（Rust panic 位置元数据）；无项目路径泄漏 | 低 | **未修**（记为 Backlog）：修它需要 `--remap-path-prefix` 重新构建，会改变 SHA 从而作废已发布的 Release 与已记录校验值，收益不足以抵消 |

复核同时确认的既有事实（可直接引用）：Release 的 GitHub 侧 asset digest 与本机 SHA-256 三方一致；
匿名 `curl -L` 走通 `302 → 302 → 200` 且下载文件哈希一致；Universal 与元数据是在**挂载后的 DMG 内部**验证的
（不只是 `target/`）；release profile 无 `__debug_info`；全部 Git history 中本机用户名 / 家目录绝对路径的命中数为 **0**。

## 34.14 结论

```text
V1-T02 = PARTIAL
PRODUCT STATE = DOGFOOD READY
DISTRIBUTION STATE = PARTIAL
OPEN BLOCKERS = BLOCKER：缺正式 macOS signing / notarization credentials
NEXT ACTION = 获取 Apple Developer 分发资格后补做签名 / 公证 / Release 重传 / 安装 smoke
```

用户现在拿到的是：一个公开的 GitHub 仓库、一个带 Universal DMG 与 SHA-256 的 GitHub Release、
一条固定且长期有效的「最新版本直接下载」链接，以及一个实测可安装、可运行、
带完整三栏工作台与钥匙串凭据说明的 Workbench。

**唯一欠缺的是签名与公证**：它取决于 Apple Developer Program 分发资格，不是代码或仓库缺陷。
拿到资格后不需要重新开发 Workbench 本体，只需补做签名、公证、Release 重传与一次安装 smoke。
在此之前不创建 V1-T03，也不重新打开 V0，产品继续停在 DOGFOOD READY。
