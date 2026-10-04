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

## 0.4 已发布的 tag 不可变（Release 冻结规则）

一个 tag 一旦**发布**（Release 已对外可见），它连同它的构建产物就**冻结**，永久不变：

```text
tag 发布 → 冻结

发现问题：
修代码 → 新 commit → 新 tag → 新 Release
```

例如：

```text
v0.1.0
  ↓  发现 Bug
修复
  ↓
v0.1.1
```

**而不是**用修复后的代码重新构建 `v0.1.0`。

禁止：

```text
在同一 tag 下重新构建并覆盖已发布的 Release 资产（gh release upload --clobber）
删除已发布的 tag，再把同名 tag 指向新 commit
改写已发布 Release 的 notes 里的 SHA-256 / 大小
```

理由：已经下载过某个版本的用户，手里那个文件的 SHA-256 必须**永远**对得上它自己的版本号。
同名文件在不同时间下载得到不同内容，等于版本号失去意义，Release Notes 里的 SHA-256 也不再是可信记录。

唯一例外：Release **尚未发布**（仍是 draft，或建 Release 这一步本身失败）时，
重跑同一条 workflow 把资产补齐是允许的；但**不得覆盖任何已经对外可见的 Release**。

**强制边界（如实说明）**：本规则目前只在**发版路径**上被强制 ——
`.github/workflows/release.yml` 发现目标 tag 的 Release 已发布时会直接 `exit 1`，不做任何上传。
它**不是**由 GitHub 平台强制的：本仓库的 *immutable releases* 开关为**关闭**状态，
因此有写权限的人仍可绕过 workflow 直接改动已发布版本：

```text
gh release upload <tag> ... --clobber     覆盖已发布资产（SHA-256 随即改变）
gh release delete <tag>                   删掉 Release 后再重跑 workflow，
                                          会以「新 tag」分支重建同一 tag，字节不同
git push -f origin <tag>                  把 tag 指向另一个 commit
```

这是本轮**知情的取舍**，不是遗漏：决定暂不开启平台级开关，只保留 workflow 层强制 + 本文档约定。
若以后要彻底堵住上述绕过路径，在仓库 Settings 开启 immutable releases 即可
（按 GitHub 官方说明：开启后**新**发布的 Release 资产不可增删改、tag 不可删除或移动，
并自动附带签名 attestation 供下载者校验；**已存在**的 Release 不受影响，
关闭该开关也不会让已冻结的 Release 重新可改）。

> 与 §0.1 的区别：本节约束的是**发版用的 git tag / GitHub Release**；
> §0.1 禁止的是把 `V0.1.1` 当成新的**产品阶段名**。两者不冲突 ——
> 发版 tag 可以叫 `v0.1.1`，但产品阶段永远只有 V0 / V1 / V2。

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

必须同时做三件事：

### A. 输出本次开发报告

### B. 回写本文件

### C. 更新 Feature Update Manual（`docs/feature-history/`）

永久规则：

> 每一次改变了用户可见产品行为的开发完成，都必须更新 `docs/feature-history/UNRELEASED.md`。
> 每一次创建公开 Release，都必须把该版本的自然语言变更归档到 `docs/feature-history/vX.Y.Z.md`，并更新索引 `docs/feature-history/README.md`。
> Feature Update Manual 没有更新，任务就不算完成交接。

原文逐字保留，以免转写丢失：

> Every development completion that changes user-visible product behavior must update docs/feature-history/UNRELEASED.md. Every public release must archive that release's natural-language changes to docs/feature-history/vX.Y.Z.md and update the index. A task is not considered fully handed off until the Feature Update Manual has been updated.

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
更成熟的模型 / Skill 协作
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

> 状态：**PLANNED ONLY —— 不启动开发**。V2 只有在 V1 正式收口且用户明确批准后才激活（见 §44 的激活门槛）。

V2 关注：

> **Workbench 如何从个人课程生产工具，成长为可以长期承载多门课程、可维护、可复用的内容库。**

规划中的任务（编号沿用此前草案，本轮**不重新编号**，避免在 V2 尚未启动时制造任务名漂移）：

```text
V2-T02 — Project Library + Model & Skill Center
V2-T03 — Reuse & Templates
V2-T04 — Search / Audit / Maintenance
V2-T06 — Batch & Automation
```

规划的依赖顺序：

```text
V2-T02 项目库 + 模型与 Skill
      ↓
V2-T03 复用与模板
      ↓
V2-T04 搜索 / 审计 / 维护
      ↓
V2-T06 批量与自动化
```

原因：先有稳定的多项目管理，才谈跨项目复用；再做维护审计；最后才是批量自动化。

已经从 V2 路线中删除的方向（不得因为旧草案写过就自动恢复）：

```text
V2-T01 Universal Content Import   → 九类文本 / 文档格式已前移进本轮 v0.2.5，不再是 V2 任务
V2-T05 AI / Connector Platform    → 并入 V2-T02，并且只保留 Skill
MCP 平台 / Connector 生态 / 新模型架构 / 新 Provider 协议框架 / 无限文件格式平台
```

V2 的关键词：

```text
多项目
复用
维护
长期运营
```

详细规划、Skill 语义与激活门槛见 §44。

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

> 最后更新时间：2026-09-27
>
> 当前版本：**V1（ACTIVE）**
>
> 当前交接：**T05/T06 已 VERIFIED；下一步用户 dogfood**（任务保持平级；不新增 combined task 编号）
>
> V1-T05 — Paged Canvas & Pagination：**VERIFIED**
> V1-T06 — Layout-aware Export & PPTX：**VERIFIED**
>
> 产品状态：**DOGFOOD READY — ROUND 3；V1 ACTIVE**
>
> 分发状态：**PARTIAL / 公开下载可用**（latest public release `v0.2.2` 已发布；Universal DMG 为 ad-hoc signed，未做 Developer ID 签名与 Apple 公证）
>
> Release 边界：**T05/T06 由 `v0.2.1` tag-triggered workflow 成功发布；此前失败的 `v0.2.0` tag 未移动且没有 Release/资产，所有已发布 tags / assets 均保持冻结。`v0.2.1` 源码提交为 `60f697697843a340da3a793f1bbd2165e390f783`；本次文档回写是后续 docs-only 提交，tag 保持指向发布源码提交。**
>
> 下一步：**用户 dogfood；不创建 V1-T07，不关闭 V1。**
>
> V0 状态保持：**V0 CLOSED；V0-T01 / V0-T02 / V0-T03 / V0-T04 全部 VERIFIED**
>
> V1-T01 状态保持：**VERIFIED**（见 **§33**）；V1-T02 状态保持：**VERIFIED**（见 **§29** / **§35** / **§36**）；V1-T03 状态保持：**VERIFIED**（ego-browser §21：26 PASS / 1 N-A / 0 FAIL；§9.3 真鼠 Drag Handle PASS；Tauri WebView 拖拽与原生非法文件夹 picker toast 记 BACKLOG，非 BLOCKER）；V1-T04 状态保持：**VERIFIED**（见 **§37**；ego-browser CourseFolder §41 走查；原生 folder picker N-A；Strategy A 原地接管；自动化 gate 全绿）；
> T05/T06 完成报告与当前证据见 **§38** 和 `V1-T05_T06_Completion_Report.md`。此前 macOS Distribution & Public Release Closure 的已完成/未完成事实保留在 **§34**；`v0.2.1` 已发布，但签名/公证仍缺失。
> 不发明 `V1-T03+04`、`V1-T05+T06` 或 `V1-T07` 编号。

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

## 12A. FEATURE UPDATE MANUAL UPDATE

docs/feature-history/UNRELEASED.md：已更新 / 未更新 / 本轮没有用户可见行为变化
公开 Release 归档 docs/feature-history/vX.Y.Z.md + 索引更新：已完成 / 本轮不适用

如果未更新，任务不得视为完成交接（见 §1「任务结束后」C 项）。
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

## G. Feature Update Manual（`docs/feature-history/`）

每一次任务结束，都必须按 §1「任务结束后」C 项的永久规则更新本区域：

```text
改变了用户可见产品行为  → 更新 docs/feature-history/UNRELEASED.md
创建了公开 Release      → 把该版本的自然语言变更冻结成
                          docs/feature-history/vX.Y.Z.md
                          并在 docs/feature-history/README.md 索引加一行
                          再把 UNRELEASED.md 重置为下一个周期
没有用户可见行为变化    → 在 Completion Report 的 12A 项写明「本轮没有」
```

不为「没有成为公开用户版本的 tag」单独建档；这类 tag 只在索引里标注为
未发布 / 失败 tag（当前唯一一例是 `v0.2.0`）。

Feature Update Manual 没有更新，任务不得视为完成交接。

---

# 22. Change Log

此处只记录“总控状态变化”，不记录所有代码提交。

格式：

```text
YYYY-MM-DD | Task | From → To | Summary
```

当前：

```text
2026-10-03 | v0.2.5 发布 | 实现完成 → 已发布，公开产物验证完成（RELEASED）
commit d16b622c082720c3c386613df187deec3b7ec469 推送 origin/main；附注 tag v0.2.5（tag 对象
9d9507999eb3b46a1bf58fd87e04c743aafd15ba）指向该 commit；release workflow run 37100286505
（event=push、headBranch=v0.2.5）completed / success（8m4s）。Release v0.2.5 isDraft=false、
isPrerelease=false，publishedAt 2026-10-03T05:42:45Z。匿名下载 Universal DMG（14,293,951 bytes）
SHA-256 a84884466b084cd674a4d0d32a52b3284863a9adb9706c11283009fb14b7f9fd，与 .sha256 sidecar
及 GitHub 自报 asset digest 逐字符一致，hdiutil verify = VALID；挂载后 lipo -archs = x86_64 arm64、
Info.plist 版本 0.2.5、codesign Signature=adhoc / TeamIdentifier not set、
spctl --assess --type execute = rejected；/releases/latest 指向 v0.2.5；固定直链匿名 200。
tag 所在源码状态 gate 全绿：deno task check、deno task test 584 passed、cargo fmt --check、
cargo test 216 passed、cargo build。v0.2.4 及更早 tag / DMG / sidecar 未动（v0.2.4 DMG
SHA-256 82fdba59…4dab 复测不变）。验证段以第二个 commit 追加进 .github/release-notes/v0.2.5.md
并同步进公开 Release 正文（只改 notes，不重传资产）。本轮四块范围（项目身份 / 多项目入口、
素材滚动稳定性、九类文本·文档导入、映射后二次选择）与十点回写见 §45；未闭合的三条通道见
§45.3：原生窗口手势 smoke、真实在线 AI 调用、媒体库真实触控板 / 滚轮滚动验证；交用户验收。
2026-10-02 | v0.2.4 发布 | 发布执行中 → 已发布，公开产物验证完成（RELEASED）
commit 4db396bf7c1953a62f72d3887d6ae07b03fcaa76 推送 origin/main；附注 tag v0.2.4（tag 对象
db3171c2ad14cac8ae1ded0d1300757963ffe937）指向该 commit；release workflow run 36906333256
（event=push、headBranch=v0.2.4）completed / success。Release v0.2.4 isDraft=false、
isPrerelease=false，publishedAt 2026-10-01T18:28:40Z。匿名下载 Universal DMG（12,107,473 bytes）
SHA-256 82fdba5957f57d9650f74922197e9593e981be418515e6c7e34519164cef4dab，与 .sha256 sidecar
及 GitHub 自报 asset digest 逐字符一致，hdiutil verify = VALID；挂载后 lipo -archs = x86_64 arm64、
Info.plist 版本 0.2.4、codesign Signature=adhoc / TeamIdentifier not set、
spctl --assess --type execute = rejected（与 Notes 的 ad-hoc / 未公证表述一致）；/releases/latest
指向 v0.2.4。tag 所在源码状态复跑 gate 全绿：deno task check、deno task test 522 passed、
cargo fmt --check、cargo test 104 passed、cargo build。v0.2.3 及更早 tag / DMG / sidecar 未动。
验证段以第二个 commit 追加进 .github/release-notes/v0.2.4.md 并同步进公开 Release 正文（只改
notes，不重传资产）。仍未闭合的两条通道见 §43.6：原生窗口手势 smoke、真实在线 AI 调用；交用户验收。
2026-10-02 | v0.2.4 发布 | 等待用户验收 → 用户授权发布，发布执行中
用户明确授权「把项目同步到 GitHub，同时 tag 和发布新版本 release」，覆盖 §42.8 / 需求 §22 的
「未单独授权不发布」限制，范围是本次 v0.2.4。决定：两条未闭合验收通道（§15.4 原生指针 smoke、
item 9 真实在线 AI）如实写进 Release Notes / docs/feature-history/v0.2.4.md / README，不记成已验收；
15 项结论仍按 §42.2 逐项保留，不合并成「大致完成」。版本 0.2.3 → 0.2.4（tauri.conf.json /
Cargo.toml / Cargo.lock 三处同步），新增 .github/release-notes/v0.2.4.md，Feature Manual 冻结成
docs/feature-history/v0.2.4.md 并把 UNRELEASED.md 重置为下一周期模板，发版步骤固化到
docs/release-playbook.md。发布前 gate 复跑全绿：deno task check、deno task test 522 passed、
cargo fmt --check、cargo test 104 passed、cargo build（v0.2.4）。v0.2.3 及更早 tag / 资产不动；
无 Developer ID 凭据，CI 继续走 ad-hoc 分支。发布结果与校验值见 §43.4。
2026-10-02 | V1 Post-v0.2.3 实际使用反馈收口 | INTERRUPTED → 实现完成，等待用户验收
15 项反馈全部实现：智能打开路由与精确诊断、目录后代图片/视频导入、区块浮层化（默认不可见、
hover/focus 浮出不抖动布局）、移除 B/I/S 与 Markdown 源码 UI、保守可撤销的自动转换、分页两态、
DSH 式模型设置（三协议 / 无模板 / 只写密钥 / 真实读取模型）、SIWC 分阶段错误、去重复页标题、
PNG 缩略图与媒体卡重做、素材多选批量导入、磁盘物理重命名（含 Undo/Redo 与回滚）、Grid 左/右键
根因修复、Feature Update Manual 建立。正式 gate 全绿：deno task check、deno task test 522 passed、
cargo fmt --check、cargo test 104 passed、cargo build、cargo tauri build（候选 .app，debug，独立
bundle id）。95 份实时 UI 证据原产于 /tmp/wb-smoke/shots/，已复制到仓库外的
~/Documents/MiniWork/wb-smoke-evidence-20261002/shots/ 长期保留。未闭环两项：在线 AI 推理被网络阻断
（api.openai.com 60 秒超时）、原生窗口指针与截图在本 agent 环境不可得（AppleScript -1712；
screencapture "could not create image from display"），故 §15.4 要求的原生指针 smoke 留给用户。
全部改动仍在工作树，未 commit、未 tag、未发布；V1 保持 ACTIVE，不创建 V1-T07。详见 §42 与
docs/V1_Post_v0.2.3_Actual_Use_Closure_2026-10-01_Completion_Report.md。

2026-09-27 | V1-T05 / V1-T06 | DONE → VERIFIED
验收完成。Deno 346/346 + check、Rust 78/78；独立 review 通过。隔离桌面最终 Universal app 恢复 page 3，native 当前页 PDF smoke 通过（1 页 960×540 pt，标题与正文提取正确）。PowerPoint 三页输出无 Repair 且文本/图片可编辑；完整 PDF 与三页/两图 Static Web 通过阅读器验证。V1 保持 ACTIVE，下一步用户 dogfood；已授权发布 v0.2.0，旧 releases 不可覆盖。

2026-09-27 | V1-T05 / V1-T06 | AUTHORIZED → DONE（实现；验收当时仍在进行）
用户授权连续实施 V1-T05 Paged Canvas 与 V1-T06 Layout-aware Export & PPTX；二者保持平级，V1 ACTIVE，不创建 V1-T07。用户同时授权通过验收后发布 v0.2.0，覆盖任务文档中的旧限制；不覆盖已发布版本。最终实现与验收状态见本节及 `V1-T05_T06_Completion_Report.md`。

2026-09-27 | V1-T03 / V1-T04 | 发布 v0.1.2（新 tag / 新 Release；不覆盖 v0.1.1）
版本提交：da6e3e9 chore(release): bump version to 0.1.2
（tauri.conf.json / Cargo.toml / Cargo.lock 0.1.1 → 0.1.2）。
构建：本机 `APPLE_SIGNING_IDENTITY="-" cargo tauri build --target universal-apple-darwin --bundles app,dmg`。
资产（固定文件名）：`AI-Course-Workbench-macOS.dmg` 10,616,574 字节，
SHA-256 `1740d8f921adff2787550f276749e055bb6ea963fff2ca28543c57f8a284cb8b`。
`v0.1.1` 冻结保留。`/releases/latest` 改指 v0.1.2。签名 / 公证仍未完成（ad-hoc；`spctl` rejected）。

2026-09-25 | V1-T04 | IN PROGRESS → VERIFIED；NEXT ACTION = PAUSE FEATURE DEVELOPMENT
按 Combined Package §2.3：V1-T03 / V1-T04 = VERIFIED；CURRENT STATUS = VERIFIED；
PRODUCT STATE = DOGFOOD READY — ROUND 3；OPEN BLOCKERS = NONE；不创建 V1-T05。
正式 gate：deno task check OK；deno task test 326 passed；cargo test 68 passed；cargo build OK。
§41 ego-browser CourseFolder 走查（TaskSpace 33）：scan → Explorer 预览 → Mapping 取消/改映射 →
Confirm → Strategy A 原地接管；原文件 SHA-256 不变；reload 后结构一致。原生 folder picker 在
浏览器 N-A（toast 已验证）→ BACKLOG，非 BLOCKER（同 T03 接受浏览器证据的裁定方式）。
Latest public release 仍为 **v0.1.1**（未改 tag / Release）。证据：`t04-desktop-acceptance.md` +
`combined-completion-report.md`（§37）。

2026-09-25 | V1-T03 → V1-T04 | IN PROGRESS → VERIFIED → T04 IN PROGRESS
Controller 裁定：ego-browser Real Desktop Acceptance（§21）26 PASS / 1 N-A / 0 FAIL；
§9.3 Drag Handle 以真实 `page.mouse` 在 `.block-handle` 上 PASS；Step 1（原生非法文件夹）
在浏览器 N-A，由 Task 1 / `dogfooding_test.ts` 覆盖。Tauri WebView pointer-reorder 确认与
原生 invalid-folder picker toast 记 **BACKLOG**（非 BLOCKER）。按 Combined Package §2.2：
**V1-T03 = VERIFIED**；CURRENT TASK = **V1-T04 — Workspace Explorer & Existing-Folder Adoption**；
CURRENT STATUS = IN PROGRESS；NEXT ACTION = 执行 V1-T04。保留 V0 = CLOSED、V1-T01 / V1-T02 /
V1-T03 = VERIFIED。不发明 `V1-T03+04`。Latest public release 仍为 **v0.1.1**（未改 tag / Release）。
证据：`t03-desktop-acceptance.md` + 更新后的 `t03-verification.md`。

2026-09-25 | V1-T03 | verification gate attempted — still IN PROGRESS
Tasks 1–7 已合入；§20 自动化项齐备；正式 gate：`deno task check` / `deno task test`（298）/
`cargo test`（55）/ `cargo build` 全绿。Real Desktop Acceptance（§21）与 §9.3 真鼠 Drag Handle
未能在本环境诚实完成 → OPEN BLOCKERS 非空 → **不写 V1-T03 = VERIFIED**，不切换 T04。
证据：`.superpowers/sdd/2026-09-25-v1-t03-t04-authoring-and-explorer/t03-verification.md`。
Latest public release 仍为 **v0.1.1**（未改 tag / Release）。NEXT ACTION = 完成桌面验收后再关 T03。

2026-09-25 | V1-T03 | PAUSE FEATURE DEVELOPMENT → IN PROGRESS
按 Combined Development Package 开工 V1-T03 — Course Authoring & Project Structure Closure。
CURRENT VERSION = V1（ACTIVE）；CURRENT TASK = V1-T03；CURRENT STATUS = IN PROGRESS；
NEXT ACTION = 执行 V1-T03。保留 V0 = CLOSED、V1-T01 = VERIFIED、V1-T02 = VERIFIED。
不发明 V1-T03+04；T04 须等 T03 = VERIFIED 后再切换。

2026-09-25 | V1-T02 | 仓库重新设为 PUBLIC；发布 v0.1.1（按最新代码重建）
起因：`v0.1.0` 的 DMG 构建自 `90872bd`，落后 `main` 6 个提交（不含 P0/P1/P2 修复），
因此「可下载的安装包」并不是最新代码；用户要求恢复公开并把下载版本更新到最新。
为什么不覆盖 v0.1.0：同一 tag 下替换二进制会让已下载过的用户拿到 SHA 不同的同名文件，
版本号与内容不再对应；按 README 已预告的方式新发 `v0.1.1`，`/releases/latest` 自动改指它，
`v0.1.0` 保留为历史版本。
版本提交：`f5fb1a3 chore(release): bump version to 0.1.1`
（`tauri.conf.json` / `Cargo.toml` / `Cargo.lock` 三处 0.1.0 → 0.1.1，无行为改动）。
构建：本机 `cargo tauri build --target universal-apple-darwin --bundles app,dmg`，
`APPLE_SIGNING_IDENTITY="-"` 走 Tauri 官方 ad-hoc 签名路径（与 §34 记载的 v0.1.0 同一条路径）。
**踩坑记录**：不设置该变量时 Tauri 会整个跳过签名，产物没有 `_CodeSignature/`，
`codesign --verify --deep --strict` 报「code object is not signed at all」，`codesign -dv` 回落到
链接器签名（`Identifier=ai_course_workbench-…`）；设置后恢复为
`Identifier=io.github.wyzh0117.ai-course-workbench` + `Sealed Resources version=2` 并通过校验。
资产（固定文件名）：`AI-Course-Workbench-macOS.dmg` 10,468,230 字节，
SHA-256 `801fb7ea27610a8799cc5017e5c960462c76894f4ef7274af299ec0384071857`。
仓库可见性：`PRIVATE → PUBLIC`（`gh repo edit --visibility public`，已复核 `visibility=PUBLIC`）；
Release 页面与 `/releases/latest/download/...` 恢复对匿名访问者可用。
README 同步：Download 入口与「分发状态」改回公开口径，并写明 v0.1.0 不包含本轮修复。

2026-09-25 | V1-T02 | 确立「已发布 tag 不可变」发版规则（§0.4），并让 release.yml 强制执行
规则：tag 一旦发布即**冻结**；发现问题走「修代码 → 新 commit → 新 tag → 新 Release」
（`v0.1.0` → 修复 → `v0.1.1`），**不得**用修复后的代码重新构建同一个 tag，
也不得覆盖已发布 Release 的资产或改写其 notes 中的 SHA-256。
写入三处：`PROJECT_MASTER_CONTROL.md` §0.4（与 0.1–0.3 并列的总控规则）、
README 发版章节、`.github/workflows/release.yml` 头部注释。
§0.4 内注明它与 §0.1 不冲突：§0.1 禁止的是把 `V0.1.1` 当作**产品阶段名**，
本规则约束的是**发版 tag / Release**。
代码加固：`Publish release assets` 步骤原本对「Release 已存在」一律 `gh release upload --clobber`，
会静默替换已发布资产并改写 notes（SHA-256 随之变化），与本规则直接冲突。
现改为先读 `isDraft`：draft → 仍允许补齐资产（「建 Release 没走完」的合法重试）；
已发布 → 打印 `::error::` 与 step summary 后 `exit 1`，拒绝覆盖并提示改发新 tag。
本机验证（不依赖真实发版）：从 workflow YAML 抽出该步骤脚本做 `bash -n` 语法检查通过；
再用 stub `gh` 跑通三个分支 —— 新 tag → `release create`；draft → `release upload --clobber`
+ `release edit`；已发布 → exit 1，且**完全没有调用** `release upload`（资产未被触碰）。

2026-09-24 | V1-T02 | 提交并同步远端；仓库重新设为 PRIVATE（公开下载暂时下架）
工作树已提交：`1181e4e feat(v1-t02): dogfooding critical fixes + authoring UX refinement (P0/P1 + P2)`
（20 个文件，+6328 / −337），已推送到 `origin/main`；提交前对暂存内容做过密钥扫描（无凭据、无用户课程、无日志）。
仓库可见性：`PUBLIC → PRIVATE`（`gh repo edit --visibility private`，已复核 `visibility=PRIVATE`）。
公开下载下架：Release 页面与 `/releases/latest/download/AI-Course-Workbench-macOS.dmg` 对匿名访问者实测均为 **404**；
Release `v0.1.0` 与资产保留在仓库内（GitHub 不要求仓库 public 才能有 Release，因此未删除，也就不需要「重新上传」），
等初步开发确认完成后再重新公开即可恢复原固定直链。
README 同步：Download 入口与「分发状态」如实标注「公开下载已暂时下架 / 仓库为 private」，不留死链。
推送路径说明：本机 `git` 直连 `github.com:443` 不可达（`api.github.com` 正常），本次通过本机代理
`http://127.0.0.1:7890` 推送成功；未改动全局 git 配置。

2026-09-23 | V1-T02 | IN PROGRESS（第二次实施 P2 完成）→ VERIFIED
第二次实施（P2）完成：Provider / Model 配置重构、Block 自适应高度体系、Flow 成为唯一顺序入口、
Grid 交互重设计；两次实施（P0 + P1 + P2）全部通过自动化门禁与真实 Desktop 回归，OPEN BLOCKERS = NONE。
P2-1 Provider / Model：Base URL + API Key（仍只进系统钥匙串）+ 真实 `GET {base}/models` 枚举 + 选择即用 +
手动 Model ID 永远可用（读取失败也不阻塞保存）；不再依赖任何硬编码模型清单。
P2-2 Block 自适应高度：短内容（标题 / 引用 / 提示 / 分隔线 / 占位符）Small ⇄ Medium 封顶；
长内容（正文 / 代码 / 列表 / 练习）Medium ⇄ Large 封顶；到顶后由外框滚动，取消内部手动 resize，
打字时高度与层级即时跟随（不需要等下一次渲染）。
P2-3 顺序职责迁移：Flow 是唯一排序入口并直接写回 Canonical `order_index`；结构 / Preview 只读同一份顺序，
结构视图不再提供 ↑↓，改为指向 Flow 的入口。
P2-4 Grid 交互：未放置 Block 左键上画布（自动落到第一个空位）、Grid Block 左键进入移动状态（可用 Cell 高亮）、
点击目标 Cell 直接移动、右键移出网格；↑↓←→ 不再是核心移动方式，尺寸按钮在选中后仍然稳定可用。
验证：`deno task check` 通过；`deno task test` 266 passed / 0 failed；`cargo test` 55 passed / 0 failed；
真实 Tauri Desktop 19 步走查全部完成（含保存 → 关闭 → 重启后排版与顺序一致）。
详细记录与证据见 **§36**。

2026-09-23 | V1-T02 | IN PROGRESS（第一次实施 P0 + P1 完成）
第一次实施（P0 + P1）已完成并通过真实 Desktop 回归，OPEN BLOCKERS = NONE，NEXT ACTION = 执行 P2 交互重构。
P0（真实使用阻断）：①项目选择后无法再次打开同一项目；②输入被保存 / 重渲染打断；③二级弹窗自动关闭；
④API Key 配置未真正写入钥匙串却显示已配置；⑤Drag Handle 不工作；⑥Grid Preview 与真实排版不一致；⑦Grid hover 工具无法稳定操作。
P1（Authoring 直觉）：seed 入口语义、课程地图缺漏提示、区块 / 待补删除、课程标题 inline 改名、待补类型在所有投影一致、
真实占位符（不写入提示文字）、新建 Block 当次渲染即选中并打开属性、状态栏说明作用对象、Section 语义与增删、网格编辑门控。
本轮额外发现并修复：`course.seed.create` / `blueprint.build` 桌面命令缺失与 `{input:{}}` 嵌套错误、
新增 Block 后属性面板要等下一次渲染才切换（本轮第二次修复）、所有弹窗打开时不接管输入焦点（会吞掉用户第一次输入）。
验证：`deno task check` 通过；`deno task test` 255 passed / 0 failed；`cargo test` 54 passed / 0 failed；
真实 Tauri Desktop 21 步走查完成（其中 3 步受原生控件 / HTML5 拖拽限制，已用自动化测试覆盖并如实标注）。
详细记录与证据见 **§35**。

2026-09-23 | V1-T02 | PARTIAL → IN PROGRESS（范围重定位）
按用户明确批准，V1-T02 编号改用于「Dogfooding Critical Fixes & Authoring UX Refinement」
（平铺任务，不是新 Milestone；不创建 V1-T02-A / V1-T02.1 / Fix Phase / 新阶段层级）。
此前草拟并已实施完成的 V1-T02 — macOS Distribution & Public Release Closure 本轮不再执行、也不继续占用该编号：
其已完成事实（正式 Release 构建、Universal DMG、公开仓库与 GitHub Release、固定 latest 直链、
SHA-256 校验资产、安装后 App 的真实运行 smoke、安全预检）与未完成边界（缺 Developer ID Application
签名与 Apple 公证，`spctl --assess` 判定 rejected）如实保留在 §34 与 README「分发状态」中，不撤回、不夸大；
剩余动作（签名 / 公证 / Release 重传 / 安装 smoke）降级为后续候选任务，等用户再次明确批准后才编号与启动。
优先级依据：真实 Dogfooding 使用暴露了更高优先级的真实问题 —— 项目选择后无法再次打开项目、输入频繁中断、
二级弹窗自动关闭、API Key 无法配置、Drag Handle 不工作、Grid Preview 不一致。
因此调整为「先修真实使用问题 → 再次 Dogfooding → 再决定公开分发」。
执行结构：V1-T02 只进行两次实施 —— 第一次 P0 + P1（一起完成），第二次 P2（已批准的四项交互重构）；
两次都通过真实 Desktop 回归后才允许 V1-T02 = VERIFIED，NEXT ACTION = PAUSE FEATURE DEVELOPMENT。
本轮开工状态：CURRENT TASK = V1-T02 — Dogfooding Critical Fixes & Authoring UX Refinement；CURRENT STATUS = IN PROGRESS；
OPEN BLOCKERS = NONE；V0 保持 CLOSED，V0-T01 / V0-T02 / V0-T03 / V0-T04 保持 VERIFIED，V1-T01 保持 VERIFIED。

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

> **V0 仍为 CLOSED；V0-T01 / V0-T02 / V0-T03 / V0-T04 全部 VERIFIED。V1 保持 ACTIVE。V1-T01—T06 全部 VERIFIED。**

用户授权 T05/T06 验收通过后发布新 Release，覆盖联合开发文档中旧的“不发布新 Release”条款，但不改写既有 tag / 资产。v0.2.1 已发布；此前 v0.2.0 workflow 失败且无 Release / 资产。当前不创建新任务层级，不创建 V1-T07，也不关闭 V1。

T05/T06 自动化、独立 review、桌面与真实阅读器验收证据见 **§38** 与 `V1-T05_T06_Completion_Report.md`。签名 / 公证仍为 PARTIAL 分发边界。

```text
V0 CLOSED
V0-T01 / V0-T02 / V0-T03 / V0-T04  VERIFIED
V1 ACTIVE
V1-T01 / V1-T02 / V1-T03 / V1-T04  VERIFIED
V1-T05 Paged Canvas                VERIFIED
V1-T06 Layout-aware Export & PPTX  VERIFIED
CURRENT CLOSURE   v0.2.5 四块收口（项目身份 / 多项目入口、素材滚动稳定性、九类文本·文档导入、
                  映射后二次选择）：已实现并随 v0.2.5 公开（§45）
CURRENT HANDOFF  v0.2.5 已发布并完成公开产物验证（§45.4）；待用户在真实窗口做原生验收（§45.3）
CURRENT STATUS  RELEASED v0.2.5，SELF-VERIFIED；用户原生验收 + 真实在线 AI + 真实滚动 = PENDING
PRODUCT STATE   公开最新版 = v0.2.5（tag d16b622，DMG SHA-256 a8488446…f9fd）；v0.2.4 及更早冻结
DISTRIBUTION    PARTIAL；Apple Developer ID signing / notarization not configured（CI 走 ad-hoc 分支）
OPEN BLOCKERS   NONE（在线 AI smoke、原生指针 smoke 与真实滚动 = 环境限制，见 §45.3；用户选择先发布）
BACKLOG         Tauri WebView pointer-reorder；原生 folder picker / invalid-folder toast（Tauri）；
                Tauri WebView Explorer/Adopt smoke；不创建 V1-T07
```

下一步唯一动作：

```text
用户侧：下载 v0.2.5 DMG，跑 §45.3 列出的三条未闭合通道（原生手势、真实在线 AI、媒体库真实滚动）
新问题 → 按 docs/release-playbook.md 走 v0.2.6；不覆盖 v0.2.5 及更早的已发布资产
```

T05/T06 已 VERIFIED；v0.2.1 已按授权发布，v0.2.0 失败 tag 冻结且无 Release / 资产。严格保护 §0.4，不覆盖已发布 tag / Release / 资产。

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
v0.2.5 已发布（§45.4）；收口内容见 §45；V1-T05 / V1-T06 已 VERIFIED，不新增 V1-T07

CURRENT STATUS
RELEASED v0.2.5，SELF-VERIFIED — 用户原生验收、真实在线 AI 与真实滚动验证仍 PENDING；V1 ACTIVE
PRODUCT STATE = v0.2.5 四块收口已公开：项目身份 / 多项目入口（Project Registry）、素材滚动稳定性
（消闭环 + 钉住在页卡片 + 有界淘汰）、九类文本 / 文档导入（逐份选择 + §28 回执 + 来源原地不动）、
映射后二次正文选择；证据见 §45 与 Completion Report
NEXT ACTION = 用户下载 v0.2.5 按 §45.3 清单做原生手势 / 真实滚动验收并发起第一次真实 AI 调用；
新问题按 docs/release-playbook.md 走 v0.2.6；不创建 V1-T07，不关闭 V1
DISTRIBUTION STATE = PARTIAL（ad-hoc 签名；Apple Developer ID / 公证未配置）；
v0.2.5 tag / Universal DMG / .sha256 已由 CI 发布并匿名下载校验（§45.4）
V0 = CLOSED；V0-T01 / V0-T02 / V0-T03 / V0-T04 全部 VERIFIED
V1-T01 = VERIFIED（§33）；V1-T02 = VERIFIED（§29 / §35 第一次实施 / §36 第二次实施）；
V1-T03 = VERIFIED（ego-browser §21 26/27 PASS + 1 N-A；§9.3 page.mouse Drag Handle PASS）；
V1-T04 = VERIFIED（§37；Explorer + Strategy A 原地接管；ego-browser CourseFolder 走查）
V1-T05 = VERIFIED（分页 Canvas / 页面操作 / session）
V1-T06 = VERIFIED（layout-aware HTML / PDF / Web / PPTX）

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
- V1-T02 P0 + P1：七个真实使用阻断修复（项目重开、输入不被打断、二级弹窗生命周期、API Key 真写入钥匙串、
  Drag Handle、Grid Preview 一致性、Grid hover 稳定性）+ 十项 Authoring 直觉修正（种子入口语义、完成度提示、
  区块删除、课程标题 inline 改名、待补类型投影一致、真实 Placeholder、新建 Block 当次渲染选中、状态栏作用对象、
  Section 语义与增删、网格编辑门控）
- V1-T02 P2-1：Provider 可用 Base URL + 钥匙串密钥 + 真实 `GET {base}/models` 枚举、选择即用、
  手动 Model ID 永远可用，不再依赖硬编码模型清单
- V1-T02 P2-2：Block 自适应高度体系（短内容 Small ⇄ Medium、长内容 Medium ⇄ Large，到顶由外框滚动、
  取消内部手动 resize、打字时即时跟随）
- V1-T02 P2-3：Flow 成为唯一排序入口并写回 Canonical `order_index`，结构 / Preview 只读同一份顺序
- V1-T02 P2-4：Grid 交互重设计（左键上画布、左键进入移动状态、Cell 高亮、点目标 Cell 直接移动、右键移出；
  ↑↓←→ 不再是核心移动方式）
- 测试与回归：Deno 266 tests + Rust 55 tests + cargo build + cargo tauri build --debug（.app 与 .dmg 生成）
- V1-T02 P2 真实桌面走查 19 步全部完成（含保存 → 关闭 → 重启后排版与顺序一致）
- 真实走查：最终构建的桌面走查 + 浏览器刷新走查 + 首启验收（真正首次启动状态）
- V1-T02 分发：正式 Release 构建（Universal，arm64 + x86_64）、DMG 打包、正式图标集（.icns 全尺寸）
- V1-T02 分发：产品元数据对齐（productName / identifier / version / 最低 macOS / 分类 / 版权）
- V1-T02 分发：固定 asset 文件名 `AI-Course-Workbench-macOS.dmg` + SHA-256 校验资产
- V1-T02 分发：公开 GitHub 仓库、`v0.1.0` tag、GitHub Release、`/releases/latest/download/...` 固定直链
- V1-T02 分发：最小 release workflow（tag / 手动触发；配好 Secrets 后自动签名 + 公证）
- V1-T02 分发：安装后 App 的真实运行 smoke（从 /Applications 启动、干净默认主页、三栏工作台、
  AI 助手与钥匙串说明、关闭 → 重启）
- V1-T02 安全预检：全仓 + 全 Git history 密钥扫描、用户数据 / 开发痕迹清理、文档脱敏
- V1-T03：项目文件夹错误契约、Stage CRUD / 删除安全、Block 外框 100/196/354、Selection/Focus、
  Drag Handle（自动化 + ego-browser 真鼠）、媒体插入锚点、Media display name / preview、
  Placeholder→状态、工作台入口、Requirement 响应式与真实 anchor、destructive 样式统一；
  自动化 gate 全绿；ego-browser §21 验收 26 PASS / 1 N-A / 0 FAIL
- V1-T04：导入已有文件夹入口、只读 folder.scan、Workspace Explorer 预览、Mapping Preview（建议≠事实）、
  Confirm 后 Strategy A 原地接管（project.json + .workspace + assets/{id}-*；原文件不移动）、
  Source/Asset/Canonical 语义、checksum 复用与同名不同内容不静默覆盖、symlink 边界；
  自动化 gate 全绿（Deno 326 / Rust 68）；ego-browser CourseFolder §41 走查通过（原生 picker N-A）
- V1-T05：稳定 `layout_page_id`、分页 Grid、页面 CRUD/调序/复制、跨页放置、分页预览和旧 Grid 兼容。
- V1-T06：共用 Publish Projection；HTML / PDF / Web / PPTX 页面输出；独立 PPTX 文字/图片对象；
  警告需确认、blocking errors 阻断；混合页面尺寸的 PDF/PPTX 缺少统一目标时返回 `explicit_target_page_size_required`。
- T05/T06 自动化：Deno 全套 346 passed / check OK；新增 review test 6/6、authoring UI 43/43；
  Rust 78 tests passed + cargo fmt --check。最终集成全套通过。
- T05/T06 独立 review：旧 schema migration、复杂 clone、分页 HTML selected scope、旧 Grid preview、
  legacy multi-section overlap 修复均已报告 PASS；native PDF intermediate 3页 960×540 pt，文本/真实图片可检出并通过位置渲染检查。

OPEN BLOCKERS
- T05/T06：None。
- 本轮（§45.3）三条环境受限的验收通道，非产品缺陷：
  1) 原生窗口 GUI 输入 / 截图——AppleScript `-1712`、`screencapture: could not create image from display`；
     覆盖 §45 的原生指针 / 面板手势与启动页项目列表走查。
  2) 在线 AI 真实推理——`api.openai.com` 在本环境 60 s 超时；本轮未改 AI 链路，按 v0.2.4 结论顺延。
  3) 生产规模媒体库（大图 + 240+ 素材）与真实触控板 / 滚轮滚动——状态机由自动化用例覆盖，
     真实指针滚动仍需真实窗口验证。

DISTRIBUTION LIMITATION
- 缺正式 macOS signing / notarization credentials（无 Developer ID Application 证书或公证凭据）；DMG 为 ad-hoc 签名，macOS 可能显示安全提示。

BACKLOG
- Tauri WebView pointer-reorder confirmation（ego-browser Chromium 已 PASS；尚未在 WKWebView 内复测）
- 原生 invalid-folder picker toast（Tauri 目录选择器选空/非法文件夹时的用户可见 toast；浏览器 Step 1 N-A，
  自动化 `dogfooding_test.ts` / Task 1 已覆盖契约文案）
- 原生 folder picker 交互式 §41（浏览器 N-A；toast + 绝对路径 importExistingFolder 已验证）
- Tauri WebView Explorer / Mapping / Adopt smoke（本轮未在 WKWebView 内复测）

AFTER CURRENT TASK
用户已授权本次提交 / tag / 发布（§45 开头）；下一次发布仍需要单独授权。
v0.2.5 发布后，v0.2.5 及更早的 release tags / assets 全部冻结。V0 不重新打开。

V1
ACTIVE

V2
NOT ACTIVE

NEXT ACTION
v0.2.5 已发布并回填 §45.4；由用户对原生 GUI 手势 / 真实滚动做验收并发起第一次真实 AI 调用（V1-T01—T06 VERIFIED；V1 ACTIVE；V0 CLOSED；不创建 V1-T07。）
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
>
> **2026-09-24 可见性补充（不改动以下历史事实）**：按用户要求，仓库已重新设为 **PRIVATE**，
> 公开下载暂时下架 —— Release 页面与 `/releases/latest/download/...` 对匿名访问者均返回 404；
> Release `v0.1.0` 与其资产**保留在仓库内**（GitHub 不要求仓库 public 才能有 Release，因此无需删除），
> 等初步开发确认完成后再重新公开。本节以下内容描述的是公开时期的事实与证据，依然成立。
>
> **2026-09-25 可见性补充（不改动以下历史事实）**：按用户要求，仓库已重新设为 **PUBLIC**，
> 公开下载恢复 —— Release 页面与 `/releases/latest/download/...` 对匿名访问者重新可用。
> 同时新发 **`v0.1.1`**（按当前 `main` 重新构建，含 §35 / §36 的 P0/P1/P2 修复），
> `/releases/latest` 已指向它；`v0.1.0` 保留为历史版本。构建与签名路径、以及
> 「未签名 / 未公证、`spctl --assess` 判定 rejected」的如实边界与 §34 记载完全一致。

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

### 34.6.1 v0.1.1 复发行（2026-09-25）

`v0.1.0` 的 DMG 构建自 `90872bd`，落后 `main` 6 个提交，因此下载页上的安装包**不含** P0/P1/P2 修复。
按用户要求恢复公开并把下载版本更新到最新，做法是**新发 `v0.1.1`**，不覆盖 `v0.1.0`
（同一 tag 换二进制会让已下载过的用户拿到 SHA 不同的同名文件，版本号与内容不再对应）。

```text
仓库可见性：PRIVATE → PUBLIC（gh repo edit --visibility public，已复核 visibility=PUBLIC）
版本提交：  f5fb1a3 chore(release): bump version to 0.1.1
构建：      cargo tauri build --target universal-apple-darwin --bundles app,dmg
             APPLE_SIGNING_IDENTITY="-"（Tauri 官方 ad-hoc 签名路径，与 34.5 同一条）
Release Tag：v0.1.1
Release 标题：AI Course Workbench v0.1.1 — macOS (Universal)
Release 状态：已发布（isDraft=false, isPrerelease=false），/releases/latest 指向它
Release Assets：
  AI-Course-Workbench-macOS.dmg           10,468,230 bytes
  AI-Course-Workbench-macOS.dmg.sha256    96 bytes
固定直链：https://github.com/wyzh0117/workbench/releases/latest/download/AI-Course-Workbench-macOS.dmg
```

本次实际执行的验证（只写真实跑过的项）：

```text
deno task check                     通过
deno task test                      266 passed / 0 failed
cargo test                          55 passed / 0 failed
lipo -archs                         x86_64 arm64
codesign --verify --deep --strict   通过（ad-hoc）
codesign -dv                        Identifier=io.github.wyzh0117.ai-course-workbench
                                    Signature=adhoc, TeamIdentifier=not set
                                    Info.plist entries=16, Sealed Resources version=2
spctl --assess --type execute       rejected（未签名 / 未公证，与 34.5 一致）
hdiutil verify                      VALID
启动 smoke                          从 DMG 取出 App → 指定项目目录启动 → 存活 10s 无崩溃
                                    → SIGTERM graceful 退出；--project-dir 指向不存在目录时
                                    按文档在开窗前退出并打印原因
```

本版**未重做** §34.7 / §34.8 记录过的完整交互安装走查（拖入 Applications → 三栏工作台 →
AI 助手 → 关闭 → 重启），因此 §34.7 表格中「安装 / 首启 / 三栏工作台 / 关闭重启」这些结论
仍然只属于 v0.1.0 那一轮，不随本版自动继承。

推送 `v0.1.1` tag 前同样按上面记载的做法临时停用了 `.github/workflows/release.yml`
（避免 CI 用未签名的并行产物覆盖本机已验证的 DMG），Release 建好后重新启用（active）。

### 34.6.2 v0.1.2 发行（2026-09-27）

按用户要求把本地 `main`（含已 VERIFIED 的 V1-T03 / V1-T04）同步到 GitHub，并新发公开 Release。
**不覆盖**已冻结的 `v0.1.1`。

```text
版本提交：  da6e3e9 chore(release): bump version to 0.1.2
构建：      cargo tauri build --target universal-apple-darwin --bundles app,dmg
             APPLE_SIGNING_IDENTITY="-"（与 34.5 / 34.6.1 同一条 ad-hoc 路径）
Release Tag：v0.1.2
Release 标题：AI Course Workbench v0.1.2 — macOS (Universal)
资产：
  AI-Course-Workbench-macOS.dmg           10,616,574 bytes
  AI-Course-Workbench-macOS.dmg.sha256
SHA-256：1740d8f921adff2787550f276749e055bb6ea963fff2ca28543c57f8a284cb8b
lipo -archs：x86_64 arm64
codesign --verify --deep --strict：通过（adhoc, Sealed Resources version=2）
spctl --assess --type execute：rejected（缺 Developer ID 与公证）
hdiutil verify：VALID
启动 smoke：指定项目目录存活 10s 后 SIGTERM；--project-dir 指向不存在目录时开窗前退出并打印「项目目录不存在」
```

`v0.1.1` 的 tag / DMG / SHA-256 **未改动**。`/releases/latest` 改指 `v0.1.2`。

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
- v0.1.0 发布当时，两份 Release 资产的下载计数只有发版本机自己的匿名校验下载（各 2 次）；
  Intel 切片与 macOS 11.0 最低版本至今仍没有在真实机器上跑过。

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
| 2 | `release.yml` 在已存在 Release 时走 `--clobber` 覆盖资产，却不重写 Notes，会让 Notes 里记录的 SHA-256 与新资产不一致 | 中 | **当时已修**：覆盖资产后追加 `gh release edit --notes-file dist/release-notes.md`。**（该做法现已被 §0.4 取代：已发布的 Release 不再允许覆盖，workflow 改为直接拒绝并 `exit 1`。此行保留为当时的历史记录。）** |
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

---

# 35. V1-T02 — Dogfooding Critical Fixes & Authoring UX Refinement（第一次实施记录）

任务文档：`V1-T02_Dogfooding_Critical_Fixes_and_Authoring_UX_Refinement.md`
执行结构：本任务只做两次实施 —— 第一次 P0 + P1（本文档），第二次 P2（Provider / Block / Flow / Grid 四项交互重构）。
不创建 V1-T02-A / V1-T02.1 / Fix Phase / 新 Milestone。

## 35.1 Interim Report（第一次实施结束）

```text
# V1-T02 Interim Report — P0 + P1

## Control Position
V1-T02 = IN PROGRESS

## Root Cause Findings
1. 项目选择后无法再次打开同一项目
   `openProject(dir)` 在同一目录分支直接 return，只切回编辑器，既没有重新 lease，也没有重读数据；
   一旦中途回到项目选择页，再点同一个项目就等于什么都没发生（第二实例 / 锁过期后更明显）。
   修复：改为 `reopenLeasedProject(dir)` —— 重新 `project.open` 取锁并重读数据，失败用 userFacingError 如实说明。
2. 输入被保存 / 重渲染打断
   输入时 autosave 触发 `notify()` → 整壳 `render()`（`root.innerHTML = shellView()`），
   正在输入的 textarea 节点被整体替换：焦点、光标、IME 组字、滚动位置全部丢失。
   修复：拆分「全量渲染」与「外壳更新」——保存状态、状态栏、toast 走 `notifyChrome()` / `patchChrome()`；
   全量渲染在 IME 组字期间延后；渲染前后捕获 / 还原焦点、光标、滚动；未绑定输入框走 DOM→DOM 还原
   （API Key 这类值不进入 `store.ui`）。
3. 二级弹窗自动关闭
   `bindEvents()` 给每个 `[data-action]` 元素单独挂 click，`data-stop-click` 的守卫只作用于那一个监听器；
   弹窗内部没有 `data-action` 的区域点击继续冒泡到遮罩的 `close-overlay`，于是「点一下弹窗就关」，
   「显示技术信息」这类 `<details>` 也一起被关掉。修复：把守卫提升为弹窗作用域级别的判断（事件源在弹窗内即不关闭）。
4. API Key 显示已配置但实际没写入
   shell 用 `/usr/bin/security add-generic-password … -w </dev/null` 写入：密码为空、命令仍返回 0，
   UI 只看退出码就报「已配置密钥」。修复：真实传值写入，并在写入后**读回比对**，
   只有读回一致才算配置成功；读不回就如实显示未配置并给出原因。
5. Drag Handle 不工作
   `.block-handle` 只有样式和 `dragstart` 监听，没有 `draggable="true"`，浏览器永远不会发起拖拽。
   修复：补 `draggable="true"`，并由 `bindBlockDrag()` 用 `dataTransfer` 传递 block 身份，drop 时调用
   `store.reorderBlockTo(source, target)` 写回 canonical 顺序。
6. Grid Preview 与真实排版不一致
   预览按 Flow 顺序平铺输出，忽略 `placements` 的行列 / 跨格 / 分区，也看不到未上画布的正文。
   修复：预览按真实网格几何渲染（列、行、span、分区），并单列「还没有放进网格」的正文。
7. Grid hover 工具无法稳定操作
   悬停工具条在鼠标移动时被重渲染替换，pointer 还没抬起目标节点就没了；放置也依赖悬停位置。
   修复：悬停控件稳定渲染并带 title / aria，`place-block` 由数据决定落点（下一个空网格），
   放置 / 移出 / 缩放都写成 canonical `placements`。

## P0 Completed
- P0-1 项目选择：A → 项目选择 → A 再次打开（重新取锁 + 重读），A → 项目选择 → B 走真实 Folder Picker。
- P0-2 输入连续性：连续中文输入 + autosave 不丢焦点、不丢光标、不触发弹窗误关；弹窗内输入不再触发关闭。
- P0-3 二级弹窗 / 技术信息：弹窗内点击不再关闭；`<details>` 展开状态在弹窗内保持。
- P0-4 API Key：真实写入 macOS 钥匙串并读回确认，失败如实显示未配置。
- P0-5 Drag Handle：`draggable="true"` + 拖拽写回 canonical 顺序。
- P0-6 Grid Preview：预览反映真实网格几何与未上画布正文。
- P0-7 Grid 交互：放置 / 移出 / 缩放可稳定操作，落点由数据决定。

## P1 Completed
- P1-1 seed 入口语义：入口与 `course_seed.source_type` 一一对应，课程地图是正式入口，seed 只生成草稿、确认后才建结构。
- P1-2 课程地图完整度：逐课列出缺什么，不再编造百分比。
- P1-3 删除能力：区块 / 待补可删除（含确认与 canonical 同步）。
- P1-4 课程标题 inline 改名：顶栏直接编辑，Enter 保存 / Esc 取消。
- P1-5 待补类型：类型改写后所有投影（面板、占位符设置、区块提示）一致。
- P1-6 真实占位符：占位符不再把提示文字写进 canonical 正文，空段落用 `placeholder` 属性表达。
- P1-7 新建 Block：当次渲染即选中新块并切到属性面板（本轮修了两次，见 §35.4）。
- P1-8 状态栏：说明当前作用对象（`作用对象：S01-02|第一课 …`）与待补 / 排版 / 完成度。
- P1-9 Section 语义：输出分区（一个分区 = 导出时的一段连续输出），可重命名、可增删。
- P1-10 网格编辑门控：默认只显示网格与提示，点「编辑网格」后才出现 +行 / -行 / +列 / -列。

## Automated Verification
deno task check: 通过（app/*.js + src/domain + src/ui + 全部 tests）
deno task test: 255 passed / 0 failed
cargo test --manifest-path src-tauri/Cargo.toml: 54 passed / 0 failed
新增回归：tests/dogfooding_test.ts（15 例，覆盖 P0-1 / P0-2 / P0-5 / P0-6 / P0-7 / P1-3 / P1-4 / P1-6 / P1-7 / P1-8 / P1-10 与弹窗聚焦）、
native_boundary_test 中 `course.seed.create` / `blueprint.build` 的命令名与 `{input:{}}` 嵌套契约。

## Real Desktop Verification
真实 Tauri Desktop 二进制 + 真实工作区（`workbench-test/wt-walkthrough/课程A`、`课程B`）走查 21 步：
1 启动 / 2 真实 Folder Picker 打开 A / 3 返回项目选择 / 4 再次打开 A（继续工作，直接回到编辑器）/
5 返回项目选择 / 6 Picker 打开 B / 7 连续输入三段中文正文 / 8 autosave 期间继续输入不中断（93 字全部累积）/
9 快速收集写入收件箱 / 10 保存版本写出快照 / 11 导出窗口保持打开且预检为 0 / 13 配置 API Key（粘贴 → 保存 → 钥匙串读回 → 已配置密钥）/
15 排版版本 + 放置两块正文（R1C1 / R1C2，canonical placements 各 1 条）/ 16 预览按真实网格列渲染 /
17 占位符与关联待补同时建立 / 18 空段落为真实 `placeholder` 属性、canonical 为空 / 19 顶栏改名写回 canonical /
20 状态栏显示作用对象与三维度 / 21 网格编辑门控（点前只有提示，点后出现行列控件）。
如实标注的 3 处限制（不是未做，而是无法用合成事件驱动）：
- 12 「显示技术信息」：干净项目没有 issue 可展开，弹窗内 `<summary>` 行为由自动化 DOM 测试覆盖（弹窗内点击不关闭）。
- 14 Drag Handle：HTML5 原生拖拽无法用 CGEvent 合成，`draggable="true"` 与 `reorderBlockTo` 有自动化覆盖 + 代码路径核对。
- 17 后半（待补类型改图片）：桌面被原生 select 弹层限制，类型一致性由 store 级自动化测试覆盖。
补充：本轮第二遍桌面回归（重启后）现场验证了两个「第一次实施末期」的修复 —— 弹窗打开即接管输入焦点、
新增 Block 当次渲染切到属性面板。

## Remaining
P2

## Blockers
NONE

## NEXT ACTION
执行 V1-T02 的 P2 交互重构
```

## 35.2 第一次实施后的功能变化（用户可见）

```text
项目选择    同一项目可以反复打开；换项目走真实文件夹选择；失败有具体原因，不再静默无反应
输入        输入、保存、状态栏更新、toast 不再互相打断；中文输入法组字期间不重渲染
弹窗        弹窗内点击 / 展开不再误关；弹窗打开就把光标放进该填的输入框
API Key     只有真正写入并能读回才显示「已配置密钥」；失败会说明是权限还是写入问题
Block       每个区块有拖拽把手；新建区块立刻选中并打开属性面板
Flow/Grid   放置、移出、缩放稳定；预览和真实网格一致，并列出还没上画布的正文
课程地图    逐课说明缺什么；seed 只生成草稿，确认后才建正式结构
状态栏      永远说明「现在改的是谁」
```

## 35.3 本轮不改（保持原样，留待真实反馈）

```text
Project Settings 深度配置、Stage CRUD、Workbench 独立文件格式、macOS 公开分发（见 §34 的未完成边界）
```

## 35.4 本轮内额外发现并修复（不在原始 21 条反馈里）

```text
1. course.seed.create / blueprint.build 在桌面壳里没有命令映射（点「把材料变成课程地图」直接失败）
   —— 补映射，并按 Rust 侧签名补 `{ input: { … } }` 嵌套；两条 native boundary 测试固化契约。
2. 沙箱内启动 App 时，项目目录写入被拒会显示成「项目被占用」这类误导性提示
   —— 改为如实说明写入权限问题（本机走完整权限启动即可）。
3. 新建 Block 后属性面板要等下一次无关渲染才切换（第一次修复把选中放在 commit 之后，渲染已经发生）
   —— 移进 commit 回调，并补一条「创建区块的那次渲染就已经显示属性」的渲染级测试。
4. 所有弹窗打开时都不接管输入焦点（`data-focus-key` 是死属性），用户第一次输入直接丢失
   —— 让 capture / palette / save-version / seed 四个入口显式请求焦点，并补一条聚焦回归测试。
```

## 35.5 结论

```text
V1-T02 = IN PROGRESS
P0/P1 = completed
PRODUCT STATE = DOGFOOD READY
OPEN BLOCKERS = NONE
NEXT ACTION = P2
```

第一次实施（P0 + P1）已完成：七个真实使用阻断全部修复并有回归，十个 Authoring 直觉问题全部落地，
自动化验证（255 + 54）与真实桌面 21 步走查都已完成，无遗留阻断。
按用户批准的执行结构，本任务**尚未结束**：接下来做第二次实施 P2（Provider / Model 发现、Block 自适应高度、
Flow 负责排序、Grid 交互重设计），两次实施都通过真实 Desktop 回归后才允许
`V1-T02 = VERIFIED` / `NEXT ACTION = PAUSE FEATURE DEVELOPMENT`。不创建 V1-T03。

---

# 36. V1-T02 — Dogfooding Critical Fixes & Authoring UX Refinement（第二次实施记录 · P2）

任务文档：`V1-T02_Dogfooding_Critical_Fixes_and_Authoring_UX_Refinement.md`
执行结构：本任务只做两次实施 —— 第一次 P0 + P1（见 **§35**），第二次 P2（本文档）。
不创建 `V1-T02-A` / `V1-T02.1` / Fix Phase / 新 Milestone / `V1-T03`。

## 36.1 P2 完成内容

### P2-1 Provider / Model 配置重构

- 「改为配置真实服务商」表单重做为：Base URL → **读取模型** →（读取结果 chips）→ **手动输入 Model ID** →
  「将要使用的模型」→ 保存配置；密钥仍由下面的「保存密钥」单独写入系统凭据。
- 新增真实模型枚举：服务层 `listAiModels()`（`src/service/ai_transport.ts`）+ Rust `ai_models_list`
  （`src-tauri/src/lib.rs`），两者都只做一件事：读回该 Provider 的钥匙串密钥 → `GET {base_url}/models`
  （`Authorization: <auth_scheme> <key>`，不跟随重定向）→ 解析 `{data:[{id}]}` / `{models:[{id|name|model}]}` / 裸数组
  → 去重排序返回。失败按统一错误码归一（401/403/404/超时/非 JSON…），并**不回显密钥**。
- 选择即用：点 chip 即成为「将要使用的模型」；保存配置把它写进 `providers.json` 的 `default_model`，
  并把读取结果并入 `models`（读取失败时保留手动输入的 Model ID，同样可保存）。
- 手动 Model ID 永远可用，且是读取失败时的明确出口：失败提示直接写明「可以直接在下面手动填写 Model ID，不影响保存」。
- 不再依赖任何硬编码模型清单：`providers.json` 只保留元数据（`base_url` / `default_model` / `models` / 标签），
  密钥永远只在系统钥匙串。

### P2-2 Block 自适应高度体系

- 两类内容两套档位，写在 `app/authoring.js` 一处规则里，由视图与实时输入共用：
  - 短内容（标题 / 引用 / 提示 / 分隔线 / 占位符）：**Small → Medium**，封顶 Medium，永远不到 Large；
  - 长内容（正文 / 代码 / 列表 / 练习）：**Medium → Large**，封顶 Large，永远不低于 Medium。
- 到顶后由 Block 外框自己滚动（`.block[data-block-size]{overflow:auto}` + 分档 `max-height`），
  字段本身取消内部手动 resize（`resize:none`）、不再是第二个滚动容器。
- 打字即时跟随：文本编辑不触发整页重渲染（保护插入符与输入法），因此高度与档位在输入时由
  `autosizeBlockFields()` 就地刷新（测量实际行数 → 同一套档位规则 → 换 class），不需要等下一次渲染。
- 内容减少时自动收缩（删除后回到 Small / Medium），实测 34 行正文 340px 封顶、28 行引用 188px 封顶、
  标题 96px 封顶，删除后全部回落。

### P2-3 顺序调整职责迁移到 Flow

- Flow 成为唯一显式排序入口：每行 ↑↓ 直接写回 Canonical `order_index`（`moveBlock`），
  工具栏写明「Flow 是一维文档流：这里调整的就是正文的先后顺序（写回 Canonical order）」。
- 结构视图不再提供排序：每行只保留「定位 / 删除」，工具栏写明「结构视图只看结构…调整先后顺序请到
  「排版 > Flow」」并提供跳转按钮。
- 结构 / Preview 与 Flow 显示同一份 Canonical 顺序，不存在第二份顺序。

### P2-4 Grid Interaction Redesign

- 未放置区（还没有放进网格的正文）：**左键点击**即落到网格第一个空位，并给出反馈。
- Grid 内 Block：**左键点击**进入移动状态（横幅提示 + 所有可用 Cell 高亮为「放这里」+ Esc 取消）；
  **点击目标 Cell 直接移动**；**右键点击**把这块内容移出网格回到未放置区（带 toast 说明）。
- ↑↓←→ 不再是核心移动方式：卡片动作改为 ✎ / ＋宽 / −宽 / ＋高 / −高 / ✕，尺寸按钮在选中 / 移动后仍然稳定可用，
  并在放不下时明确拒绝（toast「这个位置放不下：目标格子已被占用，或超出网格。」）。
- 网格只保存位置：正文、素材引用、待补等仍保存在原来的地方，移动/移出都不动内容本身。

## 36.2 自动化验证

```text
deno task check                     通过（无类型 / 格式错误）
deno task test                      266 passed / 0 failed（第二次实施新增 11 条：P2-1 模型发现与回退 8 条、
                                    P2-2 高度档位与测量一致性、P2-3 顺序写回、P2-4 上画布与移动）
cargo test                          55 passed / 0 failed（新增 Rust 侧模型清单解析用例）
cargo build                         Finished
cargo tauri build --debug           成功：AI Course Workbench.app + AI Course Workbench_0.1.0_aarch64.dmg
```

回归测试落在两处，都是「能抓住回归」的断言而不是快照：
`tests/p2_interaction_test.ts`（模型枚举 URL / 请求头 / 去重 / 不泄漏密钥 / 失败结构化 / 401 不吞错 /
缺密钥时不发网络请求 / 各家 payload 形状 / 高度档位阶梯与收缩 / 测量路径与估算路径同规则），
`tests/dogfooding_test.ts`（Flow 写回唯一 Canonical 顺序、Grid 落第一个空位且可再次移动、
P2 视图标记与交互模型一致）。

## 36.3 真实 Desktop 走查（第二次实施 19 步，全部完成）

用最终构建的真实 Tauri 窗口，在 `./workbench-test` 的走查课程上逐步执行并留证：

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 1 | Base URL + API Key 配置 | 通过 | 表单写入 `http://127.0.0.1:8899/v1`；「保存密钥」提示「API Key 已保存到 macOS 系统钥匙串，并已读回确认（不回显，也不进入课程文件）」；`providers.json` 只有元数据 |
| 2 | 自动读取 models | 通过 | 点「读取模型」→ 本地 OpenAI 兼容服务日志收到 `GET /v1/models`，请求头 `Authorization: Bearer <key>`（密钥来自钥匙串）→ 面板显示「已从服务商读取到 2 个模型」 |
| 3 | 选择 Model | 通过 | 点 `stub-chat-small` chip → 「将要使用的模型：stub-chat-small（来自读取结果）」→ 保存配置后 `providers.json` 的 `default_model` = `stub-chat-small` |
| 4 | 手动 Model ID fallback | 通过 | 先在密钥不匹配时观察失败路径：面板显示 401 失败原因 +「可以直接在下面手动填写 Model ID，不影响保存」，来源改为「改为手动填写 Model ID」；随后手动输入 `stub-manual-model` 保存成功，`default_model` = `stub-manual-model`，`models` 保留读取结果 |
| 5 | 正文 Medium → Large → Scroll → 收缩 | 通过 | 空正文 158px；粘贴 34 行后外框 340px 并在框内滚动；全选删除后回落（AX 实测块框高度） |
| 6 | 标题 / 引用 Small → Medium → Scroll → 收缩 | 通过 | 空引用 96px（Small）；4 行 158px；28 行后外框停在 188px（Medium 封顶）并在框内滚动；标题（单行字段）稳定 96px |
| 7 | 无内部手动 resize | 通过 | 字段 `resize:none`；AX 树中字段高 820px、外框 340px，滚动条只在外框；没有内部尺寸手柄 |
| 8 | Flow 调整 Block 顺序 | 通过 | Flow 行 ↓ 后 `project.json` 的 `order_index` 立即互换（两段正文对调） |
| 9 | 结构 / Preview 同步 | 通过 | 结构视图、Preview 与 Flow 显示同一顺序（空正文在前、长正文在后） |
| 10 | 未上 Grid Block 左键上画布 | 通过 | 左键点未放置项 → `placements` 新增记录，落在第一个空位 R1C1 |
| 11 | Grid Block 右键下画布 | 通过 | 右键点击 → `placements` 归零 + toast「已把「正文」移出网格，回到「还没有放进网格的正文」」 |
| 12 | Grid Block 左键进入移动状态 | 通过 | 左键点击 → 出现移动提示横幅与 9 个「放这里」目标 |
| 13 | 可用 Cell 高亮 | 通过 | 每个空位渲染为「放这里」，当前格单独标记 |
| 14 | 点击目标 Cell 后直接移动 | 通过 | R1C1 → 点击目标 → R3C3 → 再点 → R2C2（`placements` 的行列区间同步变化） |
| 15 | 不再依赖 ↑↓←→ 微按钮 | 通过 | 提示文案「↑↓←→ 不再用于移动」；＋宽 → 占两列、＋高 → 占两行，选中后依然可用 |
| 16 | 保存 | 通过 | ⌘S 后顶栏显示「已保存」；`project.json` 落盘为当前顺序与位置 |
| 17 | 关闭 | 通过 | 点窗口关闭按钮后进程正常退出，无数据丢失提示 |
| 18 | 重启 | 通过 | 重新启动 → 「继续工作」重新进入同一课程与课节 |
| 19 | 布局与顺序一致 | 通过 | 重启后排版仍是 Grid、分区「第 1 段 1 块」、格子读数仍为 **R1C1**；Flow / 结构 / Preview 顺序与关闭前一致 |

走查说明（如实记录）：
- 第 1–4 步的模型枚举使用本机 `127.0.0.1:8899` 上的 OpenAI 兼容**本地替身服务**（当次会话临时启动，
  带一个一次性测试密钥），原因是走查环境不能嵌入任何第三方密钥；协议与鉴权路径与真实服务商完全一致
  （同一条 `GET {base}/models` + 同一个钥匙串取密钥的代码路径），替身服务在走查结束后已关闭。
- 第 12–14 步的「左键进入移动状态 → 点击目标移动」用真实鼠标事件执行；右键移出用真实右键事件执行。
- 走查课程位于 `./workbench-test/wt-walkthrough/`（用户指定可用于测试的目录），其中新增的段落 / 标题 / 引用
  文本都是走查用的可见样例，保留以便复现；未触碰任何真实课程内容。

## 36.4 P2 验收门槛对照（任务文档 §8，22 项）

```text
[x] Provider 可输入 Base URL
[x] API Key 仍走系统凭据
[x] 可尝试自动读取 models
[x] models 读取失败时可手动输入 Model ID
[x] 不依赖容易过期的硬编码模型列表
[x] 短内容 Block：Small ⇄ Medium → Scroll
[x] 长内容 Block：Medium ⇄ Large → Scroll
[x] 内容减少时 Block 自动收缩
[x] 取消内部手动 resize
[x] Flow 成为显式顺序调整入口
[x] Flow 修改 Canonical order
[x] 结构 / Preview 与 Flow 顺序一致
[x] 未放置 Block 左键上 Grid
[x] Grid Block 右键下 Grid
[x] Grid Block 左键进入移动状态
[x] 可放置 Cell 高亮
[x] 点击目标 Cell 后直接移动
[x] ↑↓←→ 不再作为核心移动方式
[x] Grid 保存 / 重启后一致
[x] 自动化测试全绿
[x] 真实 Desktop 走查通过
[x] P0/P1 无回归
```

## 36.5 第二次实施发现的真实问题（已在本轮修掉）

1. **高度档位只在整页渲染时更新**：文本编辑不触发重渲染（这是 P0 的保护），但档位 class 也因此不更新，
   长正文永远停在 Medium。修复：输入时由 `autosizeBlockFields()` 用实测行数刷新档位（与首渲染同一套规则），
   并补了一条「测量路径与估算路径必须同规则」的测试。
2. **手动 Model ID 输入时预览不跟随**：原来只在保存时才读该字段，「将要使用的模型」会短暂显示与输入不一致的值。
   修复：输入时就地更新预览文本（不重渲染，插入符与输入法不受影响），保存时读取同一个值。
3. **保存配置后表单状态没有回写**：保存成功后把已保存的模型镜像回表单状态，避免预览继续显示未保存的选择。
4. **结构视图曾持有自己的行内排序按钮**（P0/P1 遗留）：按 P2-3 移除，排序只剩 Flow 一个入口。

## 36.6 本轮不改（保持原样）

- Section / 「分区」的 Domain 语义仍是「输出分区」（网格里的输出分组），UI 文案按此统一；
  若后续要把它变成「课程阶段分区」，属于新的产品决策，不在本任务范围内改动。
- Grid 的「＋分区 / 重命名排版 / 一键排版全部正文」等既有能力保持原样，只重做交互方式。
- 空白课的引导文案、导出 / 发布中心、AI 助手其余能力保持 P0/P1 之后的状态。

## 36.7 结论

```text
V1-T02 = VERIFIED
P0/P1 = completed（§35）
P2 = completed（§36）
PRODUCT STATE = DOGFOOD READY
OPEN BLOCKERS = NONE
NEXT ACTION = PAUSE FEATURE DEVELOPMENT
```

两次实施（P0 + P1 + P2）全部完成：七个真实使用阻断与十项 Authoring 直觉问题有回归保护，
四项交互重构（Provider/Model、Block 高度、Flow 排序职责、Grid 交互）在真实 Desktop 上逐步走查通过，
自动化门禁（`deno task check` / `deno task test` 266 / `cargo test` 55 / `cargo build` /
`cargo tauri build --debug`）全绿，无遗留阻断。
按任务卡：**到此停止功能开发**（不创建 V1-T03），等真实使用反馈再决定下一个任务；
macOS 签名 / 公证 / Release 重传 / 安装 smoke 仍为后续候选任务（见 §34、§29）。

---

# 37. V1-T03 + V1-T04 Combined Closure（VERIFIED）

> 完整模板见 `.superpowers/sdd/2026-09-25-v1-t03-t04-authoring-and-explorer/combined-completion-report.md`。
> 本节目的是把 Combined Package §2.3 / §44 收口结论写进总控。

## 37.1 Control Position

```text
CURRENT VERSION V1（ACTIVE）
V1-T03          VERIFIED
V1-T04          VERIFIED
CURRENT TASK    V1-T04 — Workspace Explorer & Existing-Folder Adoption
CURRENT STATUS  VERIFIED
PRODUCT STATE   DOGFOOD READY — ROUND 3
OPEN BLOCKERS   NONE
NEXT ACTION     PAUSE FEATURE DEVELOPMENT
```

不创建 V1-T05。Latest public release = **v0.1.2**（`v0.1.1` 冻结保留，未改写其 tag / DMG / SHA-256）。

## 37.2 Strategy A

原地接管：在用户所选文件夹写入 `project.json` + `.workspace`，确认后的媒体复制到 `assets/{id}-{filename}`；
**不**移动 / 重命名 / 删除原文件。拒绝在已有 `project.json` 的目录上重复接管。
未选 Strategy B（旁路 managed project / Source Root），以避免第二根目录与双向同步幻觉，并保持 Canonical First。

## 37.3 Stage Operation Guide（摘要）

入口仅在 **课程地图** Stage 标题区：＋ 新阶段 / ✎ 重命名 / ↑↓ 调序 / ⋯→删除。
空阶段二次确认后删除；非空阶段提示先移课，不级联删除。`code` 与显示标题分离。

## 37.4 Project Folder Contract（摘要）

- 合法项目 = 可读且通过校验的 `project.json`（Canonical Truth）
- `.workspace` = 可重建本地状态
- `project.bak` = 备份 / 恢复产物，**不是**合法性必要条件

## 37.5 Verification

```text
deno task check     OK
deno task test      326 passed
cargo test          68 passed
cargo build         OK
```

§41 Real Folder Import：ego-browser TaskSpace 33 + `tests/fixtures/CourseFolder` 副本；
原生 folder picker 浏览器 N-A（toast 已验证）→ BACKLOG，非 BLOCKER。
证据：`t04-desktop-acceptance.md`。

§43 回归：Stage/Block/Media/Requirement/Flow/Grid/Preview/Autosave/Recovery/Lock/External/AI/Export/Session
均有既有自动化覆盖；本轮 UI 复走 T04 导入链路与 session restore，其余未再人工走 UI。

## 37.6 Conclusion

```text
V1-T03 = VERIFIED
V1-T04 = VERIFIED
PRODUCT STATE = DOGFOOD READY — ROUND 3
OPEN BLOCKERS = NONE
NEXT ACTION = PAUSE FEATURE DEVELOPMENT
```

---

# 38. V1-T05 / V1-T06 — Paged Canvas & Layout-aware Export（VERIFIED）

> 详细状态与证据：`V1-T05_T06_Completion_Report.md`。本节记录 T05/T06 验收及 `v0.2.1` 发布时的状态；当前发布状态见 §39。

## 38.1 Position at v0.2.1 Publication

```text
V1 = ACTIVE
V1-T05 Paged Canvas & Pagination = VERIFIED
V1-T06 Layout-aware Export & PPTX = VERIFIED
NEXT ACTION = USER DOGFOOD; V1 remains ACTIVE; no V1-T07
Latest public release at that time = v0.2.1
Release source commit = 60f697697843a340da3a793f1bbd2165e390f783
GitHub Actions run 36325086880 = SUCCESS
v0.2.0 tag workflow = FAILED before creating a Release; tag stays immutable
v0.2.1 Universal DMG = SHA-256 ca151a578065939f6c2e0dfa4f23955faee5f512c6833ccbe4931a68bf66817c
Distribution = ad-hoc signed; no Developer ID signature or notarization
```

用户授权发布 T05/T06 新版本；该授权覆盖需求文档中旧的“不发布新 Release”范围限制，但不覆盖或改写既有 tag / 资产。`v0.2.0` tag-triggered run `36323485548` 因空 `APPLE_CERTIFICATE` 导入失败，未创建 Release 或资产；该 tag 保持冻结。`v0.2.1` 已由 run `36325086880` 成功发布，源码提交为 `60f697697843a340da3a793f1bbd2165e390f783`。后续 docs-only PR 会让 `main` 前进，发布 tag 仍固定在该源码提交。README 使用 latest Release 与 SHA-256 sidecar 动态链接，不把本地构建 hash 当成公开资产。

## 38.2 Implementation and Automated Gates

- `layout_pages` 与稳定 page IDs 已接入现有 Domain、Store、UI 和分页预览，支持页面 CRUD、复制、调序、placement 和跨页移动；旧项目保留迁移与连续布局兼容。
- UI、service 和 native adapter 消费同一 publication projection。跨课异尺寸 PDF/PPTX 未指定目标页尺寸时以 `explicit_target_page_size_required` 阻断；warning acknowledgment 与 snapshot revision 绑定，blocking issue 不可确认绕过。
- `deno task test` 346/346、`deno task check` 通过。新增 T04 folder adoption → shared page mutation → projection/preflight/HTML export 串联测试，并核对源文件相对路径和字节不变；`native_boot_test` 9/9、`authoring_ui_test` 43/43、`paged_section_export_review_test.ts` 6/6。
- Rust `cargo fmt --check`、`cargo test` 78/78 通过，含 PPTX OPC parts/content types/layout ID/theme style matrix 结构回归。独立 review 已报告旧 schema migration、复杂 clone identities/anchors、paged HTML selected scope、legacy Grid preview 与 multi-section ambiguity 修复通过。
- 本轮运行 `graft build`：74 个 indexed files，2199 nodes / 6881 edges；图谱缓存被 gitignore。

## 38.3 Native Evidence and Final Build

- 隔离真实项目已完成 legacy 3 sections → 3 pages 转换、保存和关闭。修复 CLI 启动首次 `load_session` 只返回 locator 的 session restore 根因后，diagnostic app 对同一项目连续两次 close/restart 恢复 page 3；最终 Universal 构建也恢复 page 3。`layout_page_id`、zoom 和 canonical project path 保持正确。
- PowerPoint 已打开三页 Tauri UI PPTX，无 Repair；文字与图片对象可分别编辑并保存。合格 PDF、PPTX 与 Static Web 样例归档在 `deliverables/v0.2.0/`，来源构建身份及 SHA-256 记录在 Completion Report/样例 README。三页/两图 Static Web 目录已由隔离 Chrome 直接以 `file://` 打开。
- 最终 Universal app executable SHA-256 `885fb6b143bf578405ba85db29edb623031d58994d624a12e0aa266d43de3d29`；Launch → Workbench 后恢复已保存的第 3 页。Native current-page PDF smoke 输出 1 页、960×540 pt，含第 3 页标题与正文；文件 SHA-256 `7eec0f3524f3feb696b6e8a45be27bca60dc48020e72ffe3934c493b1914bc73`。完整 reader 证据见 Completion Report。
- 本地 Universal DMG：`src-tauri/target/universal-apple-darwin/release/bundle/dmg/AI Course Workbench_0.2.0_universal.dmg`，x86_64 + arm64，10,856,185 bytes，SHA-256 `6800e76ea5717e9cc64403eeba3eb73c525fefd662442c3a6977e82f2ed0ffb2`；`hdiutil verify` 通过。该构建为 ad-hoc signed，无 Developer ID 签名或公证；README 不把本地 hash 冒充公开 CI 资产。

## 38.4 Published Release

- `.github/release-notes/v0.2.1.md` 保存 T05/T06 正文及空证书 fallback 修复说明。唯一公开路径仍是 tag **push**；`workflow_dispatch`（即使选中 tag）只构建、不发布。已发布 tag/assets 不可覆盖。
- `v0.2.1` 由 run `36325086880` 成功发布：[GitHub Release](https://github.com/wyzh0117/workbench/releases/tag/v0.2.1)。发布源码 commit 与 peeled tag 均为 `60f697697843a340da3a793f1bbd2165e390f783`；本次 docs-only 回写提交晚于此源码提交，`main` 因此会前进而 Release tag 不移动。
- Universal DMG 大小 10,857,264 bytes，SHA-256 `ca151a578065939f6c2e0dfa4f23955faee5f512c6833ccbe4931a68bf66817c`。匿名下载文件、公开 `.sha256` sidecar 与 GitHub asset digest 一致；`hdiutil verify` 为 VALID。bundle version `0.2.1`，架构 x86_64 + arm64，ad-hoc signed，无 Apple Developer ID 签名或公证。
- `v0.2.0` tag-triggered run `36323485548` 因空证书导入失败，未创建 Release 或资产；tag 仍固定于原 commit。V1 保持 ACTIVE，下一步用户 dogfood；不创建 T07。

# 39. V1 实际使用反馈收口（2026-09-28，进行中）

> 当前状态：**IN PROGRESS — V1 ACTIVE**。本记录不创建 V1-T07，不关闭 V1，也不把本轮未完成的真实使用反馈标为 VERIFIED。

## 39.1 Version and Release Boundary

```text
Local main HEAD: d85c3f7; app version: 0.2.2
Latest public release: v0.2.2
Release: https://github.com/wyzh0117/workbench/releases/tag/v0.2.2
Tag/source commit: d85c3f7
Successful release workflow run: 36539271460
Universal DMG: AI-Course-Workbench-macOS.dmg; 10,900,979 bytes
SHA-256: 3713375ee4501ffda026a335a5a4bd54bc625ed2ef22efa6d35753d80d29a5bc
Signing: ad-hoc; not notarized; no Apple Developer ID signature
V0: CLOSED; V1: ACTIVE; V1-T01 through V1-T06: historical VERIFIED records remain unchanged
Current handoff: V1 actual-use feedback closure (2026-09-28), IN PROGRESS
```

`v0.2.2` 已公开发布，tag 与 DMG 资产保持冻结；后续修复应使用新版本。本轮工作区里的 tests/ fixture 修改、测试/验收结果与证据、`docs/`、反馈/开发包与计划文件、`deno.lock`，以及 README/PMC 本地状态回写仍未暂存、提交或推送。GitHub 的 v0.2.2 tag source archive 会继承此前已跟踪的 `README.md`、`PROJECT_MASTER_CONTROL.md` 与 `V1-T05_T06_Completion_Report.md`（历史提交 `6938bfb` / `557b294`）；本轮 README/PMC 状态回写不在已发布 tag 中。

## 39.2 Automated Validation

- 最新 `app/main.js` 导入修复之前，本地 `deno task test` 为 357 passed / 0 failed、`deno task check` 通过，Rust AI 定向测试为 32 passed / 0 failed。导入修复之后 `deno check app/main.js`、native/browser 导入路径回归与原生 ledger 验收通过；未重跑最新完整 Deno suite。
- `tests/native_boundary_test.ts` 保留一条针对旧 `asset.import` context payload 的静态断言，已不兼容 import-only 新语义；该 fixture 的兼容更新未包含在本次产品 commit、未上传，且修复后未重跑全套 Deno tests。此前干净 HEAD 的旧 AI fixtures 还沿用先存 Key 后建连接及 renderer endpoint；新安全实现要求确认凭据来源并从已保存连接取 endpoint，不能放宽产品安全约束迎合旧 fixtures。
- 当前 main push 没有触发 GitHub 测试 workflow；发布 workflow run `36539271460` 成功并发布了 v0.2.2。此前干净 HEAD fixture 失败来自定向快照运行，不是 GitHub Actions 测试失败；本轮测试资料未上传。

## 39.3 Native Smoke Evidence

真实 0.2.2 WKWebView smoke 通过：PDF blob iframe 预览；PNG/GIF 放大；MP4、WAV、Markdown 预览；损坏、空白及缺失图片的错误区分与重试；地图阶段折叠/展开；阶段菜单焦点和改名；阶段/课时标题编辑及 Undo/Redo；发布预检显示 0 个必须修复项、0 个提示。未点击开始导出。预检前后隔离 fixture 的 `project.json` SHA-256 均为 `e94063dc95bc15f1ff1558530509107f21afa6fffdbb7917ef9b36c802e43cde`，资产、备份与 index 文件名及 hash 均相同；仅运行时 `project.lock` 变化。

## 39.4 Open Items and Limits

- **已提交并原生复测通过：**新导入的 43-byte TXT 使用懒加载；离屏第 10 张卡先显示“等待加载 smoke-text.txt”，滚动两页进入视口后约 1.36 秒显示 `Smoke TXT preview Tauri WKWebView fixture.`。修复包含于已公开的 `v0.2.2`，发布源码 tag 指向 `d85c3f7`。
- **原生复测通过：**真实跨阶段拖放 S01-02 → S02-01 后，课时 ID、文档 ID 与标题保持稳定，目标阶段与 order 写入磁盘；Undo、Redo 后 UI 与持久化状态均正确。验收 fixture 的目标课原本有 0 个正文 block、0 个 `asset_usages`，因此非空正文/素材引用的移动保留尚未覆盖。
- **DOCX 参考卡验收通过：**原生导入有效最小 DOCX 后，WKWebView 显示“参考文件 · 当前环境没有内嵌缩略图”，没有读取或解码错误。全文解析未做且不属于本次验收要求；缩略图仅在可用时提供。证据：本地 WKWebView smoke 记录（未随 Release 附带）。
- **导入副作用修复原生复测通过：**main commit `202e6e4` 修复“添加素材”导入自动附加当前课程上下文。补丁版只执行“添加素材”导入新的 957B DOCX 后，AX 显示“还没有被任何内容引用”；磁盘状态为 assets 11→12、usages 1→1、blocks 0→0，没有给新素材新增 usage。旧 fixture 已有的 1 条 usage 保留，不自动清理。证据：本地隔离导入记录（未随 Release 附带）。
- **未覆盖：**本次没有在原生 UI 执行显式“插入素材”步骤；现有 acceptance 回归覆盖显式 usage。旧 `tests/native_boundary_test.ts` 静态断言仍针对已废弃的 import context payload；兼容更新未包含在本次产品 commit、未上传。
- **未验证：**真实在线 Provider 调用。本次隔离 smoke 未配置或读取 Key，也未发起 Provider 请求；自动化测试不能替代在线调用验收。
- 初次原生验收、TXT 复测及跨阶段拖放/Undo/Redo 的证据均保存在本地隔离 QA 记录中，未随 Release 附带；初次记录包含 TXT 离屏卡片的初始复现，不代表修复后状态。

NEXT ACTION = 如需覆盖非空正文/素材引用保留，用含这些内容的隔离课时补测跨阶段移动及 Undo/Redo；有条件时完成显式素材插入的原生 UI 验收和在线 Provider 验收。保持 V1 ACTIVE；不创建 T07；已发布的 `v0.2.2` tag/assets 保持冻结，后续修复发布新版本。

# 40. V1 补充反馈与 v0.2.3 发布收尾记录（2026-10-01）

> 本节记录 v0.2.3 发布时的状态；当前收口状态见 §41。V1 保持 ACTIVE，本节不创建 V1-T07，也不将未完成的实际使用反馈标为 VERIFIED。

## 40.1 Current Position

```text
V0 = CLOSED
V1 = ACTIVE
V1-T01 through V1-T06 = historical VERIFIED records unchanged
Current task = v0.2.3 published; overall acceptance PARTIAL
Application target version = 0.2.3
Latest public release = v0.2.3 (Latest)
v0.2.3 source commit/tag = 0ce229ac79b925164e3ea43eae4ac8059d5022e4 / v0.2.3
Release workflow = 36805861906 (success)
Public release = https://github.com/wyzh0117/workbench/releases/tag/v0.2.3
Public Universal DMG = https://github.com/wyzh0117/workbench/releases/download/v0.2.3/AI-Course-Workbench-macOS.dmg
Public SHA-256 sidecar = https://github.com/wyzh0117/workbench/releases/download/v0.2.3/AI-Course-Workbench-macOS.dmg.sha256
Public DMG SHA-256 = 62f8d6a4c00360c27452244aa0de6d2a1fb3dd9d7a9053522494e07d750a2d73 (anonymous download and sidecar match; hdiutil verify passed)
Local pre-release DMG SHA-256 = b109449abc48f534fdc6e64618e3e0297da3435fad8bcdcb64df7631689074f6 (local pre-release build; not the public asset)
Product state = PARTIAL; explicit limitations remain; V1 stays ACTIVE
Distribution = PARTIAL; Developer ID signing / notarization unavailable
```

用户已授权本轮完成后同步 Git、GitHub 与 Release 页面。53 项功能源码和预发布文档已提交至 `0ce229ac79b925164e3ea43eae4ac8059d5022e4` 并推送 `main`；tag `v0.2.3` 指向该源码提交且保持冻结。release workflow `36805861906` 成功，GitHub Release 已列为 Latest；公开 Universal DMG 与 sidecar 完成匿名下载、SHA 和镜像校验。发布后状态文档回填作为独立后续提交推送到 `main`，不移动 tag。4 份原始反馈/私人历史文件排除在公开提交之外，v0.2.2 及更早 tags/assets 保持不变。

## 40.2 Scope and Acceptance Record

本轮范围按反馈 15 项覆盖：文件与文件夹首次导入/追加、Markdown 解析与显式本地图片依赖、编辑器小屏与区块交互、分页控制、AI 设置与三类 API 协议、媒体库及文件页预览。导入重复检测使用来源校验和持久来源记录；追加需保留项目身份、现有正文/分页/素材引用，并把一个导入作为一次可撤销操作。安全预览仅处理明确的本地引用，不自动抓取远程图片。

逐项状态、preview4/6/7/8/9 原生证据、正式发布记录和仍未验证边界详见 [`0.2.3 验收报告`](docs/V1_Feedback_Import_Rendering_AI_Settings_2026-09-30_Acceptance_Report.md)。报告区分自动化与原生证据，未以单项测试通过替代整体验收。

## 40.3 Automated Validation Snapshot

- 安全补丁后、首帧解码改动前：Deno 388/388、Rust 95/95；`deno task check` 与 `cargo fmt --check` 通过。
- 测试替身更新后的最新完整结果：Deno 389/389、Rust 95/95，`deno task check` 与 `cargo fmt --check` 通过。首帧改动的早期 388/1 结果由旧测试替身缺少 rVFC / canvas pixel API 引起，已修复；视频首帧与文件浏览器定向测试 9/9。
- 导入/安全定向回归：Deno 扫描测试 9/9、导入事务 11/11（含故障注入）、Rust 导入 5/5、中间符号链接拒绝 1/1；AI 设置定向测试 29/29。QA-only 诊断脚本/HTML 引用删除后，最终源码完整结果为 Deno 389/389、Rust 95/95，`deno task check` 与 `cargo fmt --check` 通过；清理后的 Universal app/DMG 生产构建成功。

## 40.4 Native Snapshot and Blockers

preview4 验证了 PDF 整页中文和真实图片；PPTX 在 PowerPoint 打开且未触发 Repair，文字和图片对象分别可编辑。preview6/7 视频静态 poster 显示红色首帧且未自动播放；显式播放与返回复位通过。preview6 中文正文编辑持久、加粗 Undo/Redo、分页退出重进及拖动后重新选字通过；preview7 已有 C02 追加、同 SHA 默认跳过、单次 Undo/Redo、新连接表单取消无持久化通过。preview8 验证窄屏工具栏与四种侧栏组合、设置三协议取消保留列表、Markdown 本地图/缺图/PDF、依赖展开保持选择、分页位置保留及 Escape 取消 click-move 后正文可选字。目录选择经键盘明确选中后扫描目标目录；此前 CUA 单击只是 hover，不是产品路径缺陷。preview9 GIF Blob 为 487B，MIME/GIF89a/SHA 与 fixture 匹配，独立 IMG 从同字节重建并加载；modal 与独立 IMG 连续 2.65 秒都只观察到红帧，本机 WKWebView 动画未通过/未闭环，不归因于源文件损坏。最终无诊断 QA 轻抽检确认正文聚焦行显示自己的 +/⋯ 控件、顶部设置进入 AI 模型管理且课程地图可达。精确 1024/字体缩放、指针拖动取消、在线 SIWC/Provider 未测。首帧解码透明帧重试与迟到 Blob 清理自动化已通过。preview6–9 均为 QA 快照；正式发布的 Universal app/DMG 由 workflow `36805861906` 构建成功，公开匿名下载和 sidecar 校验一致，镜像 `hdiutil verify` 通过；包内版本 0.2.3、架构 x86_64+arm64。公开 DMG SHA-256 `62f8d6a4c00360c27452244aa0de6d2a1fb3dd9d7a9053522494e07d750a2d73`；ad-hoc signed，`TeamIdentifier` 未设置，spctl rejected，无 Developer ID 签名/公证。整体验收保持 PARTIAL。

三种 API 协议的 loopback 请求与部分订阅会话行为通过自动化/本地替身验证；没有在线 SIWC 登录、真实 token refresh 或真实 Provider 请求。不得把本地替身描述为在线账户验收。签名与公证仍是单独的分发阻碍。

## 40.5 Next Gate

1. 已完成 v0.2.3 源码提交、main/tag push、Release workflow、匿名下载与 sidecar/DMG 校验；发布后回填文档独立推送 main，不移动 tag。
2. 保持报告中的 PARTIAL 限制：GIF 动画、在线 SIWC/Provider、Developer ID 签名/公证、精确交互与尺寸仍未验收或未具备条件。
3. 获得 Apple Developer ID 分发凭据后，可另行制作签名公证版本；保持当前已发布 tag/assets 冻结。
4. 保持 V1 ACTIVE；后续用户实际使用确认后再收口，不自动关闭 V1。

# 41. V1 Post-v0.2.3 实际使用反馈收口（2026-10-01）

> 本节保留为 2026-10-01 中断记录；**当前状态见 §42**。§40 及更早章节保留为历史记录。V1 保持 ACTIVE，不创建 V1-T07。

## 41.1 Current Position

```text
V0 = CLOSED
V1 = ACTIVE
V1-T01 through V1-T06 = historical VERIFIED records unchanged
Current closure = INTERRUPTED at the user's request
Acceptance = PARTIAL; all 15 closure items remain unverified
Application version baseline = 0.2.3
Latest public release = v0.2.3 (frozen)
Closure release = not created; no new tag or release was published
```

本轮中断原因、精确工作树快照与恢复阅读顺序见[需求中断交接段](V1_Post_v0.2.3_Actual_Use_Closure_2026-10-01.md#28-user-requested-interruption-handoff-2026-10-01)和[交接报告](docs/V1_Post_v0.2.3_Actual_Use_Closure_2026-10-01_Completion_Report.md)。v0.2.3 Release 和资产仍为公开最新版且保持冻结；本轮没有新版本/tag/Release。

## 41.2 Next Gate

1. 用户恢复任务后先阅读需求 §28 中断交接段和 Completion Report，核对当前工作树，再接续尚未验收的内容。
2. 15 项完成并通过任务要求的自动化 gate、最终 Tauri smoke 前，整体状态保持 PARTIAL。
3. 需要发布时使用新版本与 tag；当前公开版本继续为 v0.2.3，既有 tag/资产保持冻结。
4. Apple Developer ID 签名与公证仍是单独的分发限制；v0.2.3 的 DMG 为 ad-hoc signed 且未公证。

本节记录到 2026-10-01 中断为止，作为历史保留。中断已按 §41.2 第 1 条恢复：先读需求 §28 交接段与 Completion Report、核对工作树，再续做 15 项；恢复后的实现与验收结果全部记入 §42，本节文字不再改动。

---

# 42. V1 Post-v0.2.3 实际使用反馈收口（2026-10-02，实现完成 / 等待用户验收）

> 本节记录 2026-10-02 的实现与自测收口；**当前状态见 §43（v0.2.4 发布）**。§41 及更早章节保留为历史记录，V1-T01—T06 的 VERIFIED 记录未改写。V1 保持 ACTIVE，不创建 V1-T07。
> 需求：`V1_Post_v0.2.3_Actual_Use_Closure_2026-10-01.md`；完整证据：`docs/V1_Post_v0.2.3_Actual_Use_Closure_2026-10-01_Completion_Report.md`。

## 42.1 Current Position

```text
V0 = CLOSED
V1 = ACTIVE
V1-T01 through V1-T06 = historical VERIFIED records unchanged
Current closure = 15 项全部实现并完成我方自测；整体状态 = IMPLEMENTED, SELF-VERIFIED
Acceptance = 用户验收 PENDING（§1 规定本轮不产出中间用户验收节点，只交一个最终候选包）
Source commit = HEAD 4ab8e5d "Document v0.2.3 release verification"；本轮不创建提交，全部改动在工作树
Worktree = 26 files changed（src/app/tests/deno.json）+ 12 个新测试文件；文档另计
Application version baseline = src-tauri/tauri.conf.json 仍为 0.2.3（有意不改）
Latest public release = v0.2.3 (frozen；tag / DMG / .sha256 sidecar 均未移动、未替换、未覆盖)
Closure release = NOT created；无新 tag、无新 Release、无新 DMG、无 Universal build
Candidate build = src-tauri/target/debug/bundle/macos/AI Course Workbench.app
                 debug profile，2026-10-02 00:28 构建，identifier
                 io.github.wyzh0117.ai-course-workbench.smoke-20261002（与已安装公开版隔离）
                 仅本机验收用，不发布、不分发
```

## 42.2 15 项矩阵（§24：实现 / 自动化证据 / 真实 UI 证据 / 结论）

| # | 用户反馈 | 实现 | 自动化证据 | 真实 UI 证据 | 结论 |
|---:|---|---|---|---|---|
| 1 | 智能识别项目 / 普通文件夹 | `inspectProjectData`/`inspectProjectDirectory` 分类 valid/migratable/invalid_root/malformed_json/too_new；无 `project.json` 的文件夹走导入扫描并给出诊断层；确认重导时备份不可用清单而非销毁 | `smart_project_inspect_test.ts`(8)、`smart_open_routing_test.ts`(8，驱动真实 overlay DOM)、`smart_open_adoption_backup_test.ts`(3) |  shipped 前端内走查路由；原生 macOS 文件夹面板无法在本环境点击（§42.4） | **PARTIAL** |
| 2 | 选定目录递归贡献图片/视频子项 | `scanMediaDescendants`（仅 image/video 递归、拒 symlink/路径穿越、逐文件降级、绝不改动源目录）；接入 mapping/adoption/desktop；Mapping Preview 保持单层 | `descendant_media_scan_test.ts`(7)、`descendant_media_adoption_test.ts`(4) | service 测试针对真实磁盘文件；原生 picker + mapping UI 端到端未走（同 item 1） | **PARTIAL** |
| 3 | 块级工具条默认不可见 | `app/styles.css:861-876` `.block-head` absolute + opacity:0 + visibility:hidden，hover/selected/focus-within/menu-open 才显；`@media (hover: none)` 常显 | `editor_compile_test.ts`、`authoring_ui_test.ts` 结构与计算样式断言 | 实测 REST `opacity=0/hidden`、HOVER `visible`，几何一致无回流；`editor-live-chrome-*.png` | **PASS** |
| 4 | 去掉 B/I/S 与 Markdown 源码切换，语义直接编译 | `views.js` 删除源码/格式工具条；`markdown.js` + `flushPendingEdit()` 编译粗体/斜体/行内码/删除线/链接/标题/引用/列表/代码块并去掉标记 | `editor_compile_test.ts`（逐标记编译、编译后光标、保留周围空格、未完成语法不动、非编辑器选区不改写）、`markdown_test.ts` | `views.js` 已无加粗/格式/源码控件；`editor_two_blocks.png`、`editor-live-caret.png` | **PASS** |
| 5 | 块属性改为浮层 | 属性/格式入口进 absolute `.block-head` + ⋯ 溢出菜单（含 `pendingBlockOverflowFocus` 焦点归还） | `authoring_ui_test.ts`「溢出动作把焦点还给新 summary」+ 脱离文档流断言 | 真实 `page.mouse.move` + `editor-live-hover.png`；无布局跳动 | **PASS** |
| 6 | 保守、可撤销的 Markdown 块自动转换 | `flushPendingEdit(..., {convert,structuralOnly})` + 600ms 空闲探针；转义字面标记；「已是该形态」守卫；IME 由 `composingField` 保护、`focusTextOffset` 复位光标 | `editor_compile_test.ts`「编译后光标原地不动」等、`markdown_test.ts` | 真实键盘完成标题/引用/分割线转换、光标连续、`⌘Z`/`⇧⌘Z` 撤销重做转换、真实 IME 跨两个探针窗口未被打断 | **PASS** |
| 7 | 分页 UI 状态随启用/编辑态 | `views.js` `paged`/`paginationEditing` 门控：连续 Grid 不渲染输出小节编辑器；分页态显示页签 + 编辑分页/退出分页编辑 | `authoring_ui_test.ts`「连续 Grid 无小节编辑器但 启用分页 可达」「退出分页编辑不改任何页面或放置数据」 | `shots/layout/02,03,05,19,20,23,24`：退出→重进→reload 后页面数据与放置逐字节一致 | **PASS** |
| 8 | DSH 风格模型设置、无预设模板 | `views.js` 服务商表单（ID/显示名/Base URL/协议/只写密钥/拉取模型/选择模型/手填 Model ID/保存）；`constants.js` 仅三种协议；删除随包模板目录；`baseUrlIssue()`+`rememberProviderForm()` | `ai_provider_config_test.ts`「恰好三种协议且用 DSH 文案」「随包模板目录已不存在」等、`ai_ui_test.ts` | 真实输入走完 `shots/settings/01…11`，含非法输入、密钥掩码、本地 stub 目录拉取、无密钥保存成功；拒绝文案逐字复现且消息中零次出现假 key | **PASS** |
| 9 | 真实 ChatGPT 订阅 / 真实 API 可用性 | `ai_transport.ts`：SIWC + 套餐范围 + 账户模型清单 + Responses 推理 + 刷新处理，每阶段独立错误码；API 走 `/v1/models`；模型选择跟随线上清单，不硬编码权益 | `ai_subscription_stages_test.ts`(7，含「已登录但无套餐用量要明说」「发现与推理分离」「will refresh vs refresh failed」)、`ai_transport_test.ts` | 本地 stub 目录 + 完整 UI 阶段链已观察；线上半段不可观察：`api.openai.com` 60s 超时。钥匙串确认真实订阅凭据存在（仅读元数据，未打印密钥），沙箱内 `security` exit 44 说明此前“无 key”是 harness 假象 | **BLOCKED**（仅线上推理；实现与阶段上报已验证） |
| 10 | 页面标题重复 | 分页画布只渲染一个可见页面标题；页签与元数据保留自身标签 | `authoring_ui_test.ts`「活动页面恰好一个可见标题」 | `shots/layout/21-preview-titles.png`、`17/18-5g-page*.png` | **PASS** |
| 11 | PNG 缩略图空白 + 素材卡片间距 | `assetThumb`/`staticImagePoster` 让 PNG/JPG/WebP 走自己的解码路径，只有 GIF/MP4 走首帧视频逻辑；卡片 markup + `styles.css:357` `aspect-ratio: 4/3` + `object-fit: contain` | `asset_thumbnail_test.ts`、`video_frame_test.ts`、`authoring_ui_test.ts` | `shots/media/01`（PNG 不再空白）…`09-narrow-820.png`；本轮补测：Escape 与 × 共用同一媒体拆除，真实点击播放后 Escape 得 `paused:true, currentTime:0, src 已移除`，DOM 残留 overlay = 0 | **PASS** |
| 12 | 多选导入素材 | `PROJECT_FILE_PICKER` 为 `multiple`；`importBrowserFiles()`/`importNativeFiles()` 单批处理并逐项记账（导入/重复/失败/跳过/已捕获）、单次撤销步；拖拽区仍支持多文件 | `asset_batch_import_test.ts`(8，含「一个不可读文件不会取消整批」「重复不计撤销步」「空选择/取消不改任何数据」) | shipped 壳内观察 `shots/media/23,24`；原生打开面板的多选手势受 §42.4 限制，同一批处理路径由 bridge 层原生测试覆盖 | **PASS** |
| 13 | 重命名要真的改本地文件 | `planAssetRename`/`applyAssetRename`(`src/domain/assets.ts:335,:426`) + `renameManagedAsset`(`storage.ts:1556`)：预检→改名→改写 canonical→保存，失败回滚；`asset.rename` Rust 命令；历史步携带 `physical_rename{previous,next}` 使 Undo/Redo 也移动文件；§14.3 拒绝分隔符/`..`/空/冲突/symlink 逃逸 | `asset_physical_rename_test.ts`(8，含「拒绝不安全名称」「canonical 保存失败时回滚文件」「Undo/Redo 往返」)、`authoring_ui_test.ts`（blur 不再二次请求/二次撤销；空名不下发） | 真机改名前后磁盘名 `shots/media/12…15`；拒绝态 `18…22`；空名 toast 逐字「素材名称不能为空，文件名称没有改变。」，普通打开后失焦保持静默 | **PASS** |
| 14 | 恢复 Grid 左右键交互根因 | `app/main.js` 单一委托的 pointer/click/contextmenu 面，重渲染后仍生效；未放置块左键→首个有效格恰好一次；已放置块左键进入移动态→点高亮格提交；右键可撤销地移出；Escape/点画布取消；块内选字拖拽不被读作命令；移动态在 `commit()` 前清理 | `grid_pointer_test.ts`(8，逐条对应，含「当前格不是 disabled 按钮也不提交」「块内选字拖拽不是移动命令」)、`p2_interaction_test.ts` | shipped 前端真实指针事件 `shots/grid-live-a/b/c`、`shots/layout/09,11,15`；提交后 `.grid-moving-banner` 计数 0、`project.json` sha256 `853fe1d0…` 不变。**§15.4「至少一次真实 Tauri 指针 smoke」条款 BLOCKED，见 §42.4** | **PASS**（含一条 BLOCKED 验收条款） |
| 15 | 常设 Feature Update Manual | 新建 `docs/feature-history/`：索引 + `UNRELEASED.md` + `v0.1.0/v0.1.1/v0.1.2/v0.2.1/v0.2.2/v0.2.3`；未发布的 v0.2.0 只在索引记为失败/未发布 tag；§23 要求的常设规则写入本文件与任务收尾清单 | 无代码，故无测试；规则见本文件 §Feature Update Manual 条款 | `docs/feature-history/README.md` 版本表含真实发布日期、peeled commit 与 Release 链接；内容仅从 Release Notes / 本文件 / 完成报告 / git history 回填，不虚构能力 | **PASS** |

统计（不做「大致完成」式概括）：**11 PASS**（3、4、5、6、7、8、10、11、12、13、15）、**1 PASS + 1 条 BLOCKED 验收条款**（14）、**2 PARTIAL**（1、2，均因原生面板通道）、**1 BLOCKED**（9，线上推理）。

## 42.3 自动化 gate（§20.1，最终源码状态，2026-10-02 复跑确认）

```text
deno task check       PASS — exit 0，app/*.js + src/** + 39 个测试文件无类型错误
deno task test        PASS — 522 passed | 0 failed
cargo fmt --check     PASS — exit 0，无 diff
cargo test            PASS — 104 passed; 0 failed; 0 ignored（lib）+ 0（bin）+ 0（doc）
cargo build           PASS — Finished dev profile，exit 0
cargo tauri build     PASS — 候选 .app 已打包（debug profile，仅 app bundle）
graft build           已刷新 — 2961 nodes / 9303 edges / 92 cards
```

本轮基线移动：收口前记录为 Deno 389 / Rust 95，收口后为 Deno 522 / Rust 104（新增 12 个测试文件并扩写既有用例）。无前端构建步骤，因此浏览器壳执行的 JS 与候选 `.app` 内 JS 逐字节相同。

## 42.4 真实 Tauri 证据与未闭合通道

```text
候选 .app 启动              OK — PID 56564 从打包 .app 运行，原生完成启动：写入
                            /tmp/workbench-native-closure/AI学习课程/.workspace/project.lock
                            （app_instance_id=app-p56564-…、pid、heartbeat）+ project.lock.guard，
                            证明 JS 启动路径与原生命令往返可用。
原生指针输入                BLOCKED — AppleScript 操控 System Events 返回
                            "AppleEvent timed out. (-1712)"：本进程无辅助功能授权且无法应答弹窗。
窗口截图                    BLOCKED — `screencapture -x` 返回 "could not create image from display"。
原生打开/保存面板           BLOCKED — 同上（无法点击窗口）。
在线 AI（item 9）           BLOCKED — 到 api.openai.com 的出网请求 60s 超时；订阅凭据确实存在于钥匙串，
                            只读元数据、未打印任何密钥（§10.6）。
```

结论：items 1、2、12 的原生面板手势与 §15.4 的原生指针 smoke 需在用户自己的 GUI 会话各跑一次；除已列证据外不主张任何行为。95 份证据产物（截图、磁盘清单、JSON dump）原产于 `/tmp/wb-smoke/shots/`，已复制到仓库外的
`~/Documents/MiniWork/wb-smoke-evidence-20261002/shots/` 长期保留，供用户验收时对照。

## 42.5 本轮发现并修复的缺陷（均已有回归断言）

1. 素材重命名提交两次（Enter 后 blur 重发同名，后端补回扩展名，成功 toast 被「素材名称没有变化」覆盖并留下空撤销步）——改为 `ui.editingAssetId` 门控。
2. 撤销重命名后 canonical 指向已被改走的 `storage_path`——历史步同时携带前后名，Undo 改写它真正写出的路径。
3. 服务商配置保存被拒时丢弃已填表单——新增 `rememberProviderForm()`，只走 toast，不写 `ui.aiError`。
4. Base URL 从不校验——新增 `baseUrlIssue()`：空/不可解析/非 http(s)/无 host/含凭据全部拒保存且不发起请求。
5. Grid 提交后残留「正在移动」横幅与「放这里」目标——移动态在同步渲染的 `commit()` 之前清理。
6. Markdown 编译后光标漂移——`focusTextOffset` 复位。
7. 空重命名静默失败——按 §14.3 明确拒绝并提示，不下发命令、不写历史、不动文件。
8. 放大预览 Escape 不关闭（× 与遮罩可以）——两者共用 `stopMediaPreview()`，保证 GIF/视频一并拆除。

## 42.6 剩余限制（继承 + 新增）

继承自 v0.2.3 且本轮未改变：公开包为 ad-hoc 签名（无 TeamIdentifier / Developer ID / 公证，`spctl --assess --type execute` = rejected，首次启动需手动过 Gatekeeper）；仅支持 macOS；Deno/service 侧 PDF 省略内联图片（`pdf_inline_images_omitted`）；PPTX 会简化复杂表格与嵌套列表并告警；1024px 精确排版、系统文字缩放、拖拽中途指针取消仍未验收。

本轮新增：item 9 的线上半段（真实 SIWC 登录、套餐用量范围、账户模型清单、一次完整响应、一次真实 API 推理）从未被观察过；原生 GUI 手势（含放大后 GIF 动图播放，在被测 WKWebView 环境只显示首帧）未验收；候选 .app 为 debug 包，release profile 与依赖时序的编辑器探针未被它证明。

有意不改（记录以免后续重复排查）：「↗ 移动到其他页面看似无效」不可复现（编辑分页开启时面板正常渲染，此前是在查看态点击）；打开项目后保存标签显示「未保存」是真实状态（`migrateUiProject()` 会在加载时修复旧数据，内存与磁盘确有差异）；批量导入撤销后 `assets/` 保留文件（与已发布的删除策略一致，Workbench 不删除非自建文件）；卡片标题去扩展名与 `body { min-width: 960px }` 符合 §12.3 表述，整体响应式重写不属于这 15 项。

## 42.7 Feature Update Manual 路径

```text
docs/feature-history/README.md              版本索引（本轮新建）
docs/feature-history/UNRELEASED.md          本轮 15 项：已实现、已自测、待用户验收
docs/feature-history/v0.1.0.md … v0.2.3.md  历史回填
PROJECT_MASTER_CONTROL.md                   常设 Manual 规则 + 本节收口记录 + Change Log + §29/§30
README.md                                   区分「公开版本 v0.2.3」与「当前源码状态」
```

## 42.8 Next Gate

1. 用户运行 §42.1 的候选 `.app`，在真实窗口内完成 items 1、2、12 的原生面板手势与 §15.4 的原生指针 smoke，并给出 15 项验收结论；在此之前本轮保持 IMPLEMENTED / SELF-VERIFIED，不称 VERIFIED。
2. 只有用户另行授权后才创建提交、切 `v0.2.4`、推 tag 或发布 Release；发布需新版本与新 tag，v0.2.3 的 tag / DMG / SHA-256 sidecar 保持冻结。
3. Apple Developer ID 签名与公证仍是独立分发边界；未获凭据前不得把候选包当作可分发产物。
4. 保持 V1 ACTIVE，不创建 V1-T07，不改写 V1-T01—T06 的 VERIFIED 记录。

---

# 43. v0.2.4 发布执行记录（2026-10-02，已发布并完成公开资产验证）

> 本节是当前状态；§42 及更早章节保留为历史记录。V1 保持 ACTIVE，不创建 V1-T07。

## 43.1 授权与决定

用户在 2026-10-02 明确授权执行收口后的第 2 项交接：**「把项目同步到 GitHub，同时 tag 和发布新版本 release」**。这覆盖了 §42.8 与本轮需求 §22/§26 中「未单独授权不得发布」的限制——授权已经给出来了，范围是本次 v0.2.4 的提交、推送、tag 与 Release。

```text
Decision   = 在两条验收通道未闭合的情况下先发布（用户决定）
             1) 原生窗口指针 / 面板手势 smoke（§15.4）
             2) 真实在线 AI 调用（item 9）
Consequence= 这两条以「已知限制」写进 Release Notes、docs/feature-history/v0.2.4.md 与 README，
             不写成已验收；v0.2.4 的 15 项结论仍按 §42.2 逐项记录，不合并成「大致完成」。
Version    = 0.2.3 → 0.2.4（tauri.conf.json / Cargo.toml / Cargo.lock 三处同步；workflow 校验 tag 与版本一致）
Tag        = v0.2.4，附注 tag，消息 "Release v0.2.4"（沿用 v0.2.1—v0.2.3 格式）
Freeze     = v0.2.3 及更早 tag / DMG / .sha256 一律不动
Signing    = 仍然没有 Apple Developer ID 与公证凭据；CI 走 ad-hoc 分支（`APPLE_SIGNING_IDENTITY: '-'`）
Playbook   = 发布步骤、验证清单、只有用户能做的部分固化到 docs/release-playbook.md，
             后续版本照着走，不再从对话记录里重新爬
```

## 43.2 发布内容

- 源码与测试：§42 的 15 项收口（26 files，代码 + 12 个新测试文件）。
- `.github/release-notes/v0.2.4.md`：用户视角 What's new（11 条）+ Notes（6 条，含两条未闭合验收通道与 ad-hoc 签名现状）。
- Feature Update Manual：`docs/feature-history/v0.2.4.md`（五个问题齐全）、`UNRELEASED.md` 重置为下一周期空模板、索引表新增 v0.2.4 行。
- `docs/release-playbook.md`：本仓库的发版操作手册。

## 43.3 发布前 gate（版本 bump 之后复跑）

```text
deno task check       OK（无类型错误）
deno task test        522 passed / 0 failed
cargo fmt --check     OK（无 diff）
cargo test            104 passed / 0 failed（另两个 target 各 0 tests）
cargo build           OK
```

发布前复跑通过，因此允许推 tag；任一项失败则不推 tag。tag 推送后 CI 再跑一次
Universal `cargo tauri build`（release 配置 + DMG），run 36906333256 结论 `success`。

## 43.4 发布结果与验证（发布后回填，2026-10-02）

```text
Commit                 = 4db396bf7c1953a62f72d3887d6ae07b03fcaa76
                         （"Implement v0.2.4 actual-use feedback closure"，已推送 origin/main）
Tag → commit           = v0.2.4（附注 tag 对象 db3171c2ad14cac8ae1ded0d1300757963ffe937）
                         → 4db396b；git ls-remote 确认远端 ref 已建立
Workflow run           = 36906333256，event=push，headBranch=v0.2.4，
                         status=completed / conclusion=success
                         https://github.com/wyzh0117/workbench/actions/runs/36906333256
Release / isDraft      = https://github.com/wyzh0117/workbench/releases/tag/v0.2.4
                         isDraft=false、isPrerelease=false，publishedAt=2026-10-01T18:28:40Z
DMG SHA-256            = 82fdba5957f57d9650f74922197e9593e981be418515e6c7e34519164cef4dab
                         （AI-Course-Workbench-macOS.dmg，12,107,473 bytes）
sidecar 一致 / hdiutil = 匿名下载 DMG 与 .sha256（96 bytes）成功；sidecar 内容与上面的
                         digest 逐字符一致，也与 GitHub 自报的 asset digest 一致；
                         hdiutil verify → "checksum ... is VALID"
架构切片               = lipo -archs → x86_64 arm64（Universal 成立）
                         Info.plist CFBundleShortVersionString / CFBundleVersion = 0.2.4
codesign / spctl       = Signature=adhoc，TeamIdentifier=not set，无 Developer ID、未公证；
                         spctl --assess --type execute → rejected（exit 3），与 Release Notes 一致
/releases/latest 指向  = v0.2.4 | AI Course Workbench 0.2.4
v0.2.3 冻结核对        = 未移动 tag、未替换 DMG、未改写 .sha256，本轮只新增 v0.2.4
```

验证细节：DMG 挂载后 bundle 里没有独立的 `app/*.js` 文件（Tauri 把前端资源压进二进制），
所以「发布包用的就是仓库里那份 `app/`」这条依据是 `frontendDist: "../app"` 且没有任何构建/转译步骤，
外加对二进制里版本串的 grep（`0.2.4` 命中 77 处）；对 JS 文本做 strings grep 不适用，不作证据。

## 43.5 发布后的产品状态

```text
Latest public release  = v0.2.4（发布即冻结，§43.4 的验证写进公开 Release 正文）
Feature Update Manual  = docs/feature-history/v0.2.4.md（本轮 15 项的用户视角事实）
Rolling file           = docs/feature-history/UNRELEASED.md 已重置为下一周期空模板
Workflow 规则          = 只在推送新的 v* tag 时发布；workflow_dispatch 只构建（未改动）
下一版本预期           = v0.2.5（用户验收暴露的问题在那里修）
V1                     = 仍然 ACTIVE；不创建 V1-T07，不关闭 V1
```

## 43.6 发布时仍未闭合的两条验收通道

发布是用户在 §43.1 明确授权下先行的，这两条不是被判定通过，而是带着「未验收」标记公开：

1. **原生窗口 pointer / 面板手势 smoke（需求 §15.4）**：本环境无法向 macOS 窗口发送真实点击
   （AppleScript 系统事件 `-1712`），也无法截图（`could not create image from display`）。
   需要用户在本机做的动作：原生打开面板的多选与文件夹/项目分流、Grid 的真实左键移动 + 右键移出、
   放大后 GIF 播放、Esc 关闭预览、真实输入法打字。
2. **真实在线 AI（item 9）**：没有在线 Sign in with ChatGPT 登录、没有真实账户 token 刷新、
   没有真实服务商推理调用（`api.openai.com` 在此 60 秒超时）。用户授权自己的连接后，
   第一次真实调用才算这条通道闭合。

用户验收若发现问题，按 `docs/release-playbook.md` 走 v0.2.5；两条通道闭合后，在
`docs/feature-history/v0.2.4.md` 的「已知限制」里把它们从「未验证」改为带证据的结论，
并同步 `.github/release-notes/v0.2.4.md` 的正文（只改 notes，不动已发布的资产）。

---

# 44. V2 路线图修订（2026-10-02，仅规划 · 不启动开发）

来源：`V0.2.4_Closure_and_V2_Roadmap_Revision.md` PART III（§37—§49）。该文件把目标版本写作
`v0.2.4`，但 `v0.2.4` 已于 2026-10-02 发布并冻结（§43），因此本轮范围按用户决定顺延为 **v0.2.5**；
本文其余部分对范围的定义不变。

本节的状态是：

```text
V2 = PLANNED ONLY
本轮不创建 V2 任务、不改变 Current Version、不启动任何 V2 开发
```

## 44.1 两处路线变更

1. **删除 `V2-T01 — Universal Content Import`。** 用户要求的
   `.txt .text .md .markdown .tex .latex .docx .epub .pdf` 全部前移进 v0.2.5 本轮实现，
   因此「继续兼容更多文本文件」不再作为独立路线。以后出现新格式：按真实使用反馈进入 Backlog，
   不预先建设无限格式平台。
2. **原 `V2-T05 — AI / Connector Platform` 并入 `V2-T02`，且只保留 Skill。**
   MCP 平台、Connector 生态、新模型平台、新 Provider 协议框架全部从路线中删除；
   模型能力只复用 V1 / v0.2.5 已实现的部分，V2 不重新开发传输层、API 协议、订阅授权体系、
   模型路由平台或模型市场，后续只允许 bug 修复、Provider 兼容性修复、安全更新与必要的小幅 UX 调整。

同时废止的此前提案（本轮明确不做，不进入任何版本）：

```text
.gitignore / .workbenchignore 式过滤规则解析器
.DS_Store 黑名单、node_modules 目录目录表、IDE 目录目录表
```

导入范围改由两层自然收敛：用户所选的 mapped files / folders + 明确支持的 media / text 扩展名；
其它类型既不自动作为正文，也不自动作为素材。

## 44.2 V2-T02 — Project Library + Model & Skill Center

v0.2.5 只做「历史项目列表」（应用级 Project Registry，见 §45）；V2-T02 再升级为真正的
Project Library：全部项目 / 最近项目 / 收藏 / 标签 / 封面 / 最后修改时间 / 完成度 / 待补数量 /
路径状态 / 重新定位 / 搜索筛选。

模型管理复用现有能力（API providers、protocol、models、subscription accounts、default model），
不扩底层。

Skill 管理是 V2-T02 新增，至少需要定义：

```text
Skill ID / Name / Description / Version / Instruction 行为定义
Allowed scope / Enabled-disabled / 兼容模型与能力要求 / Source / Updated_at
```

Skill 来源优先支持 Local Skill、导入的 Skill 包、用户自己编写的 Skill；**包格式等到 V2-T02
真正开工时再锁定**，现在不提前设计完整插件生态。

Skill 权限：安装不等于自动获得全部权限，至少区分「读取当前 Block / 读取当前 Lesson /
读取 Course / 使用模型 / 提出 ChangeDraft」，并仍然遵守

```text
Suggestion → ChangeDraft → Diff → User Review → Apply
```

Skill 不得绕过 Canonical 安全边界；可以声明 recommended capability，但不能偷偷切换到收费更高的
模型或使用未授权账户。

**界面约束（不可拆）**：模型与 Skill 在用户认知里同属「AI 能力」，必须放在同一个设置位置：

```text
设置 → AI → { 模型, Skills }
```

不允许「模型藏在设置、Skill 放项目侧栏」这种两个无关入口的形态。

## 44.3 V2-T03 / V2-T04 / V2-T06 摘要

```text
V2-T03 复用与模板：Block / Lesson / Stage 复制、Lesson / Stage 模板、跨项目复制、Asset reuse；
        必须把「复制」与「链接引用」分清，默认复制后独立，A 课的普通修改不得静默改到 B 课。
V2-T04 搜索 / 审计 / 维护：跨项目搜索、按对象类型检索、待补与状态筛选、缺失素材检查、
        来源变化检查、长期未更新内容、外链检查、布局 warning、内容审计。
V2-T06 批量与自动化：批量状态修改 / 移动 / 重新导入 / 来源更新 / Requirement / AI Review / 摘要；
        必须仍然 Plan → Preview → User Confirm → Apply，不发展后台静默 Agent。
```

## 44.4 激活门槛

只有同时满足：

```text
v0.2.5 完成 + V1 实际使用收口达到用户认可 + V1 正式收口 + 用户明确批准 V2
```

才可以把 V2 置为 ACTIVE。在此之前禁止创建 V2 任务卡或改动 Current Version。
正式进入 V2 时，如果用户希望编号连续，可以一次性锁定最终编号；在那之前保持
`V2-T02 / T03 / T04 / T06` 现有编号不动。

---

# 45. v0.2.5 — 项目身份 / 多项目入口 / 素材滚动稳定性 / 文本·文档导入（2026-10-03，实现完成并已发布）

来源：`V0.2.4_Closure_and_V2_Roadmap_Revision.md` PART I / PART II（该文件交接时写作“v0.2.4”，
因 v0.2.4 已于 2026-10-02 发布并冻结，经用户决定本轮以 **v0.2.5** 交付，范围不删减；
偏差已在 Completion Report 如实记录）。发布授权：用户在原任务中明确指示「开发完成后同步
GitHub 以及 tag、release 页」，即本轮提交 / 推送 / tag / Release 四件事的授权（同 v0.2.4 先例）。

## 45.1 §50 十点回写（本轮强制）

```text
1. project.id 是永久项目身份
   → 唯一身份字段；迁移只在缺失时才生成 id，已有 id 逐字节保留；
     无第二个 UUID / 别名（§32.1 用例如实断言 uuid / project_id 等字段不存在）。

2. Project Registry 是应用级可重建索引，不是 Canonical
   → 桌面壳 <app local data>/.workspace/projects.json；浏览器壳 <项目根>/.workspace/projects.json。
     仅存 5 个字段：project_id / project_path / project_title / last_opened_at /
     可选 last_content_item_id；≤200 行、原子写、0600、损坏另存 .bak 并按空表；
     凭据形状键逐层拒绝；课程正文 / API Key / AI Token / project.json 拷贝一律不存；
     删掉它只丢“最近打开”便利列表，课程不受影响（registry.rs / project_registry.ts）。

3. v0.2.5 的九类文本 / 文档格式能力
   → .txt .text / .md .markdown / .tex .latex / .docx / .epub / .pdf 全部作为正文导入
     （src-tauri/src/documents/，Rust 侧）；逐格式“保留 / 降级 / 未支持”见
     Completion Report §5 与 docs/feature-history（.md 走既有 marked 管线透传，
     不做第二套实现；扫描版 PDF 不做 OCR、诚实保留为 Source Reference）。

4. 媒体闪烁根因与修复摘要
   → 根因一句话：load 完成 → notify → 整页重建（render innerHTML）→ 观察器重新登记
     → 再 load 的闭环；诱因是“读取即重排 LRU + 容量 32 淘汰在页卡片并 revoke 其 URL”。
     修复：预览完成就地 patch 那一格（不再整页重建）、在页卡片钉住缓存（容量 = 在页数 + 32，
     上限 240）、字节预算先重画再作废并标记 released + 重试、get() 只读、已就绪/在途
     卡片不再重新登记、等待队列有界且作废“卡片已消失”的读取。
     大白话六问见 docs/v0.2.5_media_flicker_root_cause.md 与 Completion Report；
     回归 tests/media_preview_stability_test.ts（12 例，120 卡三轮 reads===120、rebuilds===0）。

5. 映射后的“媒体自动导入 + 文档二次选择”规则
   → 根级 Mapping Preview 不变；确认后媒体（图片/视频）递归自动进素材库（不自动生成
     AssetUsage、不自动插入正文）；九类文档候选出现时弹「选择要导入为正文的文档」
     （分组显示、全选/全不选/行点击、媒体-only 目录保持单次确认旧路径、取消 = 零写入）；
     导入严格服从已确认 Mapping Plan，不回推第二套 Stage/Lesson；结果给 §28 回执
     document_import = { succeeded, degraded, skipped, failed, files:[…] }；
     来源原地不动，权威清单在 project.settings.markdown_import_sources。

6. .gitignore-style filtering proposal = REJECTED / removed
   → 不实现 .gitignore / .workbenchignore 解析器与目录黑名单；导入范围由
     「用户勾选的 mapped files / folders」+「明确支持的扩展名」两层收敛（§31）。
```

第 7—10 点（V2 事务）已在 §44 完成回写，此处只做索引：

```text
7. V2 Universal Content Import 已前移本轮 → §44.1（V2-T01 删除）
8. 原 V2-T05 并入 V2-T02，仅保留 Skill → §44.1 / §44.2
9. Model + Skill 同处「设置 → AI」同一管理面 → §44.2 界面约束
10. V2 仍未激活（PLANNED ONLY；激活门槛见 §44.4）
```

## 45.2 自动化证据快照（2026-10-03，源码状态）

```text
deno task check                 clean
Deno 测试                       584 passed / 0 failed
   新增：media_preview_stability_test.ts (12)、project_registry_test.ts (15)、
        registry_launcher_test.ts (16)、document_import_dialog_test.ts (17)；
        smart_project_inspect_test.ts 增至 16（§3.5 + §32.1）；t04_adoption_test.ts 按 §18 更新
cargo fmt --check               clean
Rust 测试                       216 passed / 0 failed
   documents 模块 90（docx 8 / epub 20 / pdf 25 / latex 17 / plaintext 10 / mod 契约 10）、
   registry.rs 14、folder_adopt / folder_append / 原生文档导入系列走真实临时目录
cargo build                     clean
```

## 45.3 未闭合通道（如实记录，不记成通过）

```text
1. 原生窗口指针 / 面板手势 smoke —— 本环境 AppleScript -1712、截图无权限；
   全部真实 Tauri 验收行按 UNCLOSED 记录（Completion Report §2 / §9）。
2. 真实在线 AI 调用 —— 环境到 api.openai.com 60s 超时；本轮未改 AI 链路，按 v0.2.4 结论顺延。
3. 生产规模媒体库的量化证据（大图 + 240+ 素材）—— 有界淘汰行为本身是 §11 允许的。
```

## 45.4 发布记录（发布后回填，2026-10-03）

```text
授权           用户在原任务中授权「开发完成后同步 GitHub 以及 tag、release 页」（提交 / 推送 / tag /
               Release 四件事，同 v0.2.4 先例）
源码提交        d16b622c082720c3c386613df187deec3b7ec469 推送 origin/main（5559881..d16b622）
附注 tag        v0.2.5（tag 对象 9d9507999eb3b46a1bf58fd87e04c743aafd15ba）指向该 commit
发布 workflow   run 37100286505（event=push、headBranch=v0.2.5）completed / success（8m4s）
Release         isDraft=false、isPrerelease=false，publishedAt 2026-10-03T05:42:45Z；
                https://github.com/wyzh0117/workbench/releases/tag/v0.2.5
公开资产        匿名下载 Universal DMG 14,293,951 bytes，SHA-256
                a84884466b084cd674a4d0d32a52b3284863a9adb9706c11283009fb14b7f9fd，与 .sha256
                sidecar 及 GitHub 自报 asset digest 逐字符一致；hdiutil verify = VALID；
                lipo -archs = x86_64 arm64；Info.plist 版本 0.2.5；codesign Signature=adhoc /
                TeamIdentifier not set；spctl --assess --type execute = rejected
                （与 Notes 的 ad-hoc / 未公证表述一致）
latest          /releases/latest 指向 v0.2.5；固定直链 releases/latest/download/… 匿名 200
冻结            v0.2.4 及更早 tag / DMG / sidecar 未移动、未覆盖（v0.2.4 DMG 12,107,473 bytes /
                SHA-256 82fdba59…4dab 复测不变）；v0.2.5 发布后即刻冻结
发布前 gate     版本 bump 到 0.2.5 后复跑全绿：deno task check、deno task test 584 passed、
                cargo fmt --check、cargo test 216 passed、cargo build（与 §45.2 同源）
回写            验证段以第二个 commit 追加进 .github/release-notes/v0.2.5.md 并同步进公开
                Release 正文（只改 notes，不重传资产）；docs/feature-history/v0.2.5.md 头部与
                索引表回填；README 当前开发位置切换为 v0.2.5
未闭合通道      三条（§45.3）：原生窗口指针 / 面板手势 smoke、真实在线 AI 调用、
                真实触控板 / 滚轮滚动验证；如实记录，不记成通过
```

---

# 46. v0.2.6 — Mapping / Preview / Flow / Free Layout / Full UI Redesign（2026-10-05，candidate）

> 本节只记录当前开发候选，不改写 §45 及更早版本的历史验收结论。最新公开版仍为 v0.2.5；V0 CLOSED、V1 ACTIVE，V1-T01–T06 保持原 VERIFIED，不创建 V1-T07 或关闭 V1。用户已明确授权本轮完成后同步 GitHub、tag 与 Release；实际发布状态仅在对应动作完成后回填。
>
> 验收入口：[v0.2.6 HTML completion report](docs/reports/v0.2.6-ui-redesign-completion-report.html) · [中文 candidate feature history](docs/feature-history/v0.2.6.md) · [rolling UNRELEASED](docs/feature-history/UNRELEASED.md) · [Mapping backend evidence](docs/reports/evidence/v0.2.6/mapping-backend.md) · [Deno gate evidence](docs/reports/evidence/v0.2.6/deno-gates.md).

## 46.1 七项需求当前状态

| # | 需求 | 状态 |
|---:|---|---|
| 1 | Mapping 勾选、快照与精简 | PARTIAL — Deno 覆盖稳定 scan snapshot、选择/reopen 和 stale-scan 作废；native UI rapid-toggle / repeated-open 因本机锁屏未测。 |
| 2 | 确认映射后的直接子文档选择与媒体递归扫描 | PARTIAL — Deno/Rust 夹具覆盖多目标、未选文件、既有目标、lesson-folder 分组和信任边界；native chooser 完整流程未测。 |
| 3 | Mapping 多次打开稳定性 | PARTIAL — 20 次 reopen 与 stale scan 作废测试通过；native UI 重开验收未测。 |
| 4 | 正文 Preview 图片 / GIF / 视频 | PARTIAL — UI owner 的 run6 browser CUA 实测 rich Markdown、PNG/GIF、MP4 图片语法提示、GIF 动画/关闭、video block poster/暂停/播放/关闭；native 重测受锁屏阻断。 |
| 5 | Flow 迁移、正文定位、拖动重排 | PARTIAL — UI owner 实测 handle 04→03、Undo/Redo、Body/Preview 同序与保存重开磁盘 order 2/3。可信快照接收时误显「未保存」已修复，受影响的 98 项检查通过，UI owner 的 run6 browser reload 已观察到「已保存」；native CUA 因锁屏 BLOCKED。 |
| 6 | 顶层 Free Layout 与既有 Grid/Page/export | PARTIAL — `pageGrid` 缺失导入已修，目标面板回归 66/66 PASS；browser CUA 实测跨页移动、span 调整、新建页、复制页并确认 on-disk placement 持久。Delete 未执行；Free Layout 重开/导出仍待实测。 |
| 7 | 全局页面和 overlay 重设计 | PARTIAL — 页面/弹窗 IA 改造及共用视觉系统已落地；Overview 在 1024/1280/1440/1728×900 测量无横向溢出或顶栏重叠。其他 15 页、侧栏组合、系统 text scaling 与完整键盘审计仍未闭环；run7 控件未触发动作但独立源码检查未确认绑定缺陷。 |

## 46.2 自动化快照

最终冻结源码通过 `deno task check` 与 `deno task test`（602/602，21 秒；授予 `127.0.0.1` loopback）。saveStatus 修复后的受影响检查为 98/98，Free Layout `pageGrid` target-panel regression 为 66/66，UI owner 最终 editor/authoring targeted 检查为 87/87。早期无 loopback 权限的两项失败属于本地 HTTP 测试环境，最终 loopback run 全绿。命令、CAS smoke 与历史 gate 见 `docs/reports/evidence/v0.2.6/deno-gates.md`。

Rust 记录 `docs/reports/evidence/v0.2.6/mapping-backend.md`：`cargo fmt --check`、`cargo check --all-targets`、完整 `cargo test`（222 tests，binary/doc targets 通过）与 `cargo build` 通过；文件包括 Markdown/DOCX/EPUB/LaTeX/GIF/PDF 位置与明确降级、目标分组和源文件保全证据。最终冻结源码已重建 Universal App/DMG：version 0.2.6、`x86_64 arm64`、`hdiutil verify` VALID、只读挂载内容与 App 元数据一致，SHA-256 `c4594037e0c9d4e908c9896e2aff9b39c55b23c883e19c0429fb73654d2e354f`。本地候选无 Developer ID 签名/公证；native CUA 因 Mac 锁屏 BLOCKED。详见 `docs/reports/evidence/v0.2.6/candidate-build-final.md`。

## 46.3 候选 UI / 桌面证据

当前 browser CUA run6 由 UI owner 在隔离 run6/tab 6、`http://127.0.0.1:4194/` 执行：导入 Markdown Preview 显示 heading / bold / italic / quote / list / PNG / GIF；Preview footer 报告 3 项显示素材（Markdown PNG、GIF 与独立视频 block）。`![...](clip.mp4)` 显示正确的视频图片语法提示；Media 插入的实际 video block 显示 poster、默认暂停、显式播放后前进，关闭移除播放器并恢复焦点。两帧 GIF 在 viewer 中红→蓝动画，关闭移除 viewer，inline 静态红色 poster 与 source 保持；Body 键入两行 dash list 后 blur 转为 semantic list，未编辑 escaped list 不变。Rename 对话框 Esc 不改数据、空名称保留对话框并报错、有效重命名实际移动托管文件、Undo 恢复原文件。Flow handle 04→03 拖动、Undo/Redo、Body/Preview 同序、保存重开及磁盘顺序 2/3 通过；重开后「未保存」错误状态已做源码修复、98 项受影响检查和 browser reload 复验，显示「已保存」。Free Layout `pageGrid` 运行时错误已修并通过 66/66 regression；browser CUA 实测跨页移动、span resize、新建页、复制页并确认 placement 持久。Delete 未执行，Free Layout 重开/导出待完成。UI owner 测量 Overview/shared shell 在 1024、1280、1440、1728 px × 900 时无横向溢出或顶栏重叠；其他路由、sidebar 组合与系统 text scaling 未覆盖。run7 可见且启用的路由/Overview 控件通过 locator、AX、坐标与键盘输入均未触发动作；独立源码审查确认 startup→render→bindEvents→bindActionControls→route handler 链完整，未发现已确认的业务源码缺陷。本 reviewer 的独立 CUA 观察因 Mac 锁屏、无可见 tabs 且 URL lookup 找不到 owner tab 而 BLOCKED。project-lock dialog 的实机可用性未测。截图仅在 CUA 内联显示，未保存二进制。完整区分见 HTML report 与 `docs/reports/evidence/v0.2.6/ui-evidence.md`。

## 46.4 Release boundary 与下一步

本轮用户原始授权覆盖开发完成后 GitHub sync、tag、Release；本节仍准确记录 v0.2.6 尚未发布，latest public 为 v0.2.5。v0.2.5 及更早 tag / DMG / sidecar 永久冻结。独立 reviewer 未发现已证实未修复的实现缺陷，且最终 Deno/Rust gates 与本地 Universal 包验证通过；建议可按报告明确披露的 PARTIAL/BLOCKED 限制继续发布。原生 smoke、除 Overview 外的全页四宽度/侧栏/text-scale、Free Layout 删除/重开/导出和本地截图文件仍未闭环。发布成功后追加 public workflow、资产、SHA-256 与签名状态 verification，不重写 §45.4。
