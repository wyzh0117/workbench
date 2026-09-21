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

> 最后更新时间：2026-09-21
>
> 当前版本：**V0**
>
> 当前任务：**V0-T01 — Desktop 基础闭环（已完成）**
>
> 当前状态：**VERIFIED / DONE / PASS**

---

# 7. V0 总体任务板

V0 当前只使用以下四个平级任务。

| ID | 任务 | 当前状态 | 目标 |
|---|---|---|---|
| V0-T01 | Desktop 基础闭环 | VERIFIED | 真实桌面运行、项目生命周期、文件/素材、保存恢复安全 |
| V0-T02 | Course Authoring | PARTIAL | 真正顺手地制作一节课和维护整门课程 |
| V0-T03 | AI Workflow | PARTIAL | AI 真正进入工作流，同时保持 Diff / Apply 控制 |
| V0-T04 | Output & Publish | PARTIAL | 将课程可靠迁移到实际使用和发布场景 |

注意：

> PARTIAL 不表示应该并行继续开发。

当前只执行：

```text
V0-T01
```

V0-T01 VERIFIED 后才切换 V0-T02。

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

# 9. 当前任务：V0-T01

## 名称

```text
V0-T01 — Desktop 基础闭环
```

## 当前目标

让 Workbench 真正作为桌面软件完成：

```text
启动
↓
打开项目
↓
编辑
↓
导入素材
↓
保存
↓
关闭
↓
重新启动
↓
重新打开
↓
恢复状态
↓
导出
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
PARTIAL / NOT ACTIVE
```

当前已有一些基础 UI 与数据能力。

V0-T01 已 VERIFIED，V0-T02 是下一任务；本轮尚未进入集中开发。

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

具体任务只有在 V0-T01 完成后才整理。

禁止现在继续细分。

---

# 15. V0-T03 — AI Workflow

状态：

```text
PARTIAL / NOT ACTIVE
```

已有：

```text
Suggestion
ChangeDraft
Diff
Apply
Fake / connector boundary
```

但真实 AI 生产工作流尚未作为完整 V0 能力验收。

目标：

> **让 AI 成为 Workbench 内部的协作者，而不是一个脱离课程状态的聊天窗口。**

范围包括：

```text
课程级上下文
单课级上下文
Block 级上下文
DeepSeek
豆包
ChatGPT
MCP
Skill
必要的浏览器能力
选择性聊天 / 内容导入
Suggestion
ChangeDraft
Diff
Apply
执行记录
权限边界
```

V0-T02 未完成前，不主动扩张此任务。

---

# 16. V0-T04 — Output & Publish

状态：

```text
PARTIAL / NOT ACTIVE
```

目前已有：

```text
Markdown
HTML
SVG / 分区
项目包
素材包
```

但最终目标是：

> **Workbench 中的课程可以可靠迁移到真实课程或内容发布场景。**

V0 阶段重点是建立稳定输出链。

后续可能覆盖：

```text
Semantic HTML
图片 / 页面输出
PDF
必要的 PNG
微信内容迁移
网页内容
其他实际课程场景
```

平台特有格式必须通过：

```text
统一结构化课程内容
        ↓
发布适配层
```

完成。

不得让某个平台格式反过来控制 Canonical。

---

# 17. V0 还有多少工作

当前 V0 共 4 个平铺任务：

```text
V0-T01  VERIFIED
V0-T02  PARTIAL / NOT ACTIVE
V0-T03  PARTIAL / NOT ACTIVE
V0-T04  PARTIAL / NOT ACTIVE
```

因此从宏观上：

> **当前还没有完成 V0。**

正确理解不是：

```text
M1 做完 → 项目快结束
```

而是：

```text
当前正在完成 V0 的第一个收口任务
```

完成 V0-T01 后仍然需要依次完成：

```text
V0-T02
V0-T03
V0-T04
```

全部 VERIFIED 后：

```text
V0 CLOSED
```

才进入 V1。

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
2026-09-20 | V0-T01 | IN PROGRESS → IN PROGRESS
Native Runtime smoke 与 Native Project Lock 已 VERIFIED（统一 lock/guard、30s/5s、owner 安全、stale/malformed、Native+TS 写 guard、create/open/switch/close 生命周期；Rust 11、Deno 81、Tauri build；真实 GUI session 自愈、新建/保存/heartbeat/正常 close release/reopen）。
V0-T01 仍 IN PROGRESS；尚缺 External Modification Detection、Real Desktop E2E。

2026-09-21 | V0-T01 | IN PROGRESS → VERIFIED
Real Desktop E2E 已闭环：真实 Finder 拖入 image/GIF/video/Markdown，Recovery Restore/Discard 与恢复前快照，External Modification Manual Save/Autosave 阻止覆盖、Reload/Merge/Explicit Resolution、Snapshot Restore 保护，Markdown/HTML 素材引用，Web regression；Rust 14、Deno 87 全部通过，Remaining Blockers 清零。下一任务仍为 V0-T02，本轮未进入。
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

> **V0-T02 — Course Authoring。**

V0-T01 已 VERIFIED；本轮仅完成交接，尚未进入 V0-T02 开发。

---

# 30. 当前总控摘要

```text
PROJECT
AI Course Workbench

NORTH STAR
长期、本地优先、AI 协作的课程生产与维护工作台

CURRENT VERSION
V0

CURRENT TASK
V0-T01 Desktop 基础闭环（已完成）

CURRENT STATUS
VERIFIED / DONE / PASS

DONE / IMPLEMENTED
- Canonical / Domain / Service 主体
- Web Workbench 主体
- Native Desktop 主体代码
- Native Picker 代码
- Asset Import
- checksum
- Asset / Usage
- Autosave / Recovery 基础
- Markdown / HTML 等基础输出
- AI ChangeDraft 安全边界
- Rust 14 tests + Deno 87 tests
- Finder Drag & Drop / Recovery Restore & Discard / External Modification Desktop GUI
- Markdown / HTML 已使用素材引用 / Web Regression

OPEN BLOCKERS
- NONE

AFTER CURRENT TASK
V0-T02 Course Authoring
V0-T03 AI Workflow
V0-T04 Output & Publish

V1
NOT ACTIVE

V2
NOT ACTIVE

NEXT ACTION
V0-T02 Course Authoring（本轮未进入）。
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
