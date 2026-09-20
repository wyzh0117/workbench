# AI Course Workbench 下一阶段开发说明
## M1：Desktop Usability Closure（桌面可用性闭环）

> 本文用于指导 Agent 继续开发 AI Course Workbench。
>
> 当前阶段的核心目标不是继续增加课程功能，而是把已经存在的能力连接成一个可以每天稳定使用的桌面工作流。
>
> **一句话目标：让用户从启动软件开始，到打开课程、编辑、导入素材、自动保存、关闭、重新打开、继续编辑、最终导出，全程都能在 Workbench 内完成，不依赖命令行，也不丢失进度。**

---

# 0. Agent 开始前必须理解的项目状态

AI Course Workbench 已经不是“从零开始的原型”。

当前仓库已经具备较完整的底层能力，包括但不限于：

- `CourseSeed → BlueprintDraft → 用户确认 → 课程结构`
- Block 正文
- Requirement（内容要求 / 排版要求分离）
- Asset / Usage
- 六维状态
- Flow / Grid / Section
- 自动保存与恢复日志
- 项目锁
- 外部修改检测
- 历史版本恢复
- Canonical 数据校验
- 素材 checksum 与引用关系
- 三方合并预览
- AI 的 `Suggestion → ChangeDraft → Diff → Apply`
- 搜索索引
- Markdown / HTML / SVG / 分区导出
- 项目 JSON、素材包、完整项目包
- 测试、诊断和恢复机制

因此，本轮开发**禁止把项目重新当作一个新应用重写**。

本轮工作的本质是：

> 把现有“能运行、能审查、能测试”的架构，收口成“真正可以日常使用的桌面工作台”。

---

# 1. 现在到底出了什么问题

## 1.1 大白话解释

目前 Workbench 很像这样：

- 课程数据怎么存，已经设计好了；
- 单课怎么组织，已经设计好了；
- 图片、素材、Requirement、Grid 怎么表示，已经设计好了；
- 自动保存、恢复、版本管理，也已经有了；
- 浏览器里甚至已经可以看到三栏工作台和很多功能。

但是：

- 用户真正打开桌面软件以后，文件和文件夹怎么选；
- 图片 / GIF / 视频怎么真正拖进去；
- 项目怎么打开、关闭、重新进入；
- 桌面壳怎么把操作交给现有 service；
- 下次启动以后怎么自然回到原项目；
- 整个过程是否完全不需要命令行；

这些“每天一定会使用”的环节，还没有全部串起来。

所以现在的问题不是：

> “Workbench 功能太少。”

而是：

> “Workbench 已经有很多能力，但还缺最后一段把这些能力连接成日常使用流程的桌面层。”

---

# 2. 本轮产品定位必须固定

本项目正式采用：

## Desktop-first, Browser-compatible

即：

### 正式使用形态
**Tauri 桌面应用**

用于：

- 日常课程开发；
- 本地文件与素材管理；
- 打开 / 关闭项目；
- 拖拽素材；
- 自动保存；
- 版本恢复；
- 导出；
- 后续 AI / MCP / Skill 工作流。

### Browser 形态
**开发、调试、审查与 UI 契约验证入口**

Browser 不删除。

现有 Web UI 继续保留，因为它非常适合：

- 快速检查界面；
- 验证交互；
- 测试 domain / service；
- 没有 Rust 工具链时进行功能验收。

因此不要把任务理解成：

> “从 Web 版改造成 Desktop 版。”

正确理解是：

> “同一个 Workbench，Web UI 继续存在；Tauri 补上正式桌面能力。”

---

# 3. 本轮最高原则：不要横向继续堆功能

从本轮开始，暂时冻结大部分新的 Feature Development。

不要优先新增：

- 新课程类型；
- 新 AI 写作模式；
- 更多状态维度；
- 新课程地图能力；
- 新发布平台；
- 新模型连接器；
- 新版式系统；
- 新 PDF / PNG 渲染方案；
- 微信一键发布；
- 后台聊天抓取；
- 任何与 M1 闭环无关的大功能。

原因不是这些功能不重要。

而是：

> 如果“打开项目 → 编辑 → 保存 → 关闭 → 再打开 → 导出”都还没有形成稳定闭环，那么继续新增上层功能只会增加后续维护成本。

---

# 4. 必须保留的架构原则

以下原则属于本项目的基础约束，本轮禁止破坏。

---

## 4.1 `project.json` 继续作为 Canonical Truth

`project.json` 是项目的唯一事实来源。

以下内容都只能是：

- 镜像；
- 缓存；
- 索引；
- 派生数据；
- 可重建数据。

例如：

- SQLite；
- 搜索索引；
- 缩略图；
- 诊断日志；
- AI 对话缓存；
- Workspace 缓存；
- 预览缓存。

必须满足：

> 删除 `.workspace` 等缓存后，只依靠项目 Canonical 数据与 Assets，项目仍然可以恢复。

禁止让 SQLite 或其他内部数据库悄悄变成项目真正的数据源。

---

## 4.2 Tauri 只负责 Native Adapter

Tauri / Rust 不负责重新实现课程业务逻辑。

正确关系：

```text
UI
 ↓
High-level Command
 ↓
Service
 ↓
Domain / Canonical
```

当需要系统能力时：

```text
UI
 ↓
High-level Command
 ↓
Tauri Native Adapter
 ↓
OS
```

例如：

```text
用户点击“打开项目”
        ↓
UI
        ↓
OpenProject Command
        ↓
Tauri File Picker
        ↓
返回路径
        ↓
Service
        ↓
Canonical Project
```

禁止出现：

```text
Tauri / Rust
    ↓
自己维护另一套课程数据逻辑
```

也禁止：

```text
Web UI 一套逻辑
Tauri UI 又一套逻辑
```

---

## 4.3 Domain / Service / UI / Tauri 边界继续保持

现有目录职责继续成立：

```text
src/domain/
    Canonical schema
    确定性业务规则

src/service/
    存储
    恢复
    错误
    诊断
    搜索
    连接器
    导入导出
    高层命令

src/ui/
    UI contract
    Grid / layout calculation

app/
    Web UI

src-tauri/
    Native bridge only
```

除非发现明确架构缺陷，否则本轮不重新组织整个目录。

---

# 5. M1：Desktop Usability Closure

## 5.1 M1 的唯一核心目标

让一个真实用户可以完成：

```text
启动 Workbench
      ↓
打开课程项目
      ↓
看到课程结构
      ↓
进入某一节课
      ↓
编辑正文
      ↓
拖入图片 / GIF / 视频 / Markdown 等素材
      ↓
自动保存
      ↓
关闭软件
      ↓
再次启动 Workbench
      ↓
重新打开原项目
      ↓
内容 / 结构 / 素材引用仍然存在
      ↓
继续编辑
      ↓
导出 Markdown / HTML
```

只要这个流程还不能稳定完成，M1 就不算完成。

---

# 6. M1 必做范围

---

## P0-1：项目生命周期

需要让用户在 GUI 中完成：

- 打开项目；
- 识别合法项目；
- 项目加载；
- 项目关闭；
- 项目切换；
- 保存；
- 自动保存；
- 异常退出恢复；
- 再次打开；
- 外部修改检测；
- 历史恢复。

### 最低体验要求

用户不需要：

- 打终端命令；
- 手动编辑路径；
- 手动操作 `project.json`；
- 手动寻找 `.workspace`；
- 理解内部数据结构。

### 必须处理

- 项目正在被其他实例占用；
- project.json 不合法；
- Asset 引用损坏；
- 外部文件发生修改；
- 上一次异常退出；
- 恢复前备份；
- 用户取消打开项目。

错误必须结构化，不允许直接把底层异常堆给用户。

---

## P0-2：正式文件 / 文件夹选择能力

目前 Browser 审查壳不应承担真正桌面文件系统职责。

需要通过正式 Tauri Command 接入：

- Open File；
- Open Folder；
- Save / Export Location；
- Import Asset。

要求：

- UI 不直接依赖 OS API；
- 统一经过高层 Command；
- Browser 模式继续存在；
- Browser 下允许使用 mock / limited implementation；
- Desktop 下调用正式 Native Adapter。

---

## P0-3：素材导入闭环

本轮至少保证以下素材进入真实项目：

- 图片；
- GIF；
- 视频；
- Markdown。

Word / PDF 继续遵守现有规则：

> 可以作为参考素材导入，但不要伪装成可直接编辑的正文。

### 导入流程

```text
用户选择 / 拖入素材
        ↓
识别类型
        ↓
复制或注册真实素材
        ↓
计算 checksum
        ↓
创建 Asset
        ↓
创建 / 更新 Usage
        ↓
写入 Canonical
        ↓
UI 显示素材状态
```

### 必须保留

- 原始文件真实字节；
- checksum；
- Asset / Usage 关系；
- 引用检查；
- 缺失素材诊断；
- 外部修改检测。

---

## P0-4：拖拽导入

Desktop 版必须支持基本拖拽。

至少包括：

```text
图片 → 当前课 / 当前 Block
GIF → 当前课 / 当前 Block
视频 → 当前课 / 当前 Block
Markdown → 导入或作为参考内容
```

不要在本轮开发复杂素材库 DAM 系统。

先保证：

> “拖进去 → Workbench 知道它是什么 → 正确进入项目 → 下次还能找到。”

---

## P0-5：单课编辑的保存与恢复

必须验证现有单课编辑器相关数据在真实桌面流程中能够稳定保存。

需要覆盖：

- Block 正文；
- Section；
- Flow；
- Grid；
- Requirement；
- Asset Usage；
- 六维状态；
- 占位符；
- 内容顺序；
- Block 移动；
- 撤销相关数据。

关闭软件后重新打开，不允许出现：

- 正文还在但排版丢失；
- 素材还在但 Usage 丢失；
- Grid 丢失；
- Requirement 丢失；
- 结构视图与正文不同步。

---

# 7. UI 不重做，但必须保持之前确定的产品形态

现有 UI 方向继续保留。

## 工作台基本结构

```text
┌─────────────┬──────────────────────┬─────────────┐
│             │                      │             │
│  左侧结构区  │      中央编辑区       │  右侧状态区  │
│             │                      │             │
│             │                      │             │
└─────────────┴──────────────────────┴─────────────┘
```

要求：

- 左右侧栏可收起；
- 中央区域保持主要编辑空间；
- 结构视图必须存在；
- 当前课 / 当前 Block 的上下文必须明确。

---

## 继续保留已有视图概念

包括：

- 正文；
- 结构；
- 排版；
- Grid；
- 预览；
- 待补；
- 六维状态；
- Inbox；
- 快速收集；
- 版本恢复；
- 导出前检查。

M1 的目标不是重新设计这些界面。

目标是：

> 让这些界面背后的操作真正接上桌面文件与项目生命周期。

---

# 8. 占位符系统必须继续保留

此前已经确定：

在课程开发过程中，经常会出现：

- 这里以后要补一张图；
- 这里需要 GIF；
- 这里需要视频；
- 这里需要案例；
- 这里需要截图；
- 这里素材还没找到。

因此占位符不是临时 hack，而是正式功能。

至少需要支持记录：

```text
类型：
- text
- image
- gif
- video
- asset
- example
- other

状态：
- missing
- planned
- ready
- inserted

备注：
- 需要什么
- 为什么需要
- 放在哪里
```

M1 不需要扩展占位符能力，但不能破坏。

---

# 9. Flow / Grid 双模式继续保留

此前已经确定课程内容存在两种基本布局逻辑。

## Flow

适合：

- 普通图文课程；
- 连续阅读；
- 微信 / Web 内容；
- Markdown 输出。

## Grid

适合：

- 单页视觉布局；
- 图文组合；
- 海报式页面；
- 强排版场景。

本轮不要重新发明布局系统。

需要做的是：

> 验证 Flow / Grid 数据在桌面保存、恢复、重新打开项目后仍然一致。

---

# 10. AI 能力本轮不扩张，但必须守住权限边界

现有：

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

继续作为统一修改入口。

无论后续接入：

- DeepSeek；
- 豆包；
- ChatGPT；
- MCP；
- Skill；
- 其他 Agent；

都不得绕过该流程直接修改 Canonical Project。

### 原则

AI 可以：

- 建议；
- 起草；
- 分析；
- 生成 ChangeDraft；
- 生成结构；
- 提供候选方案。

AI 不可以：

- 静默修改项目；
- 越过用户确认；
- 自动写入凭据；
- 把 API Key / Token / Cookie 写进项目；
- 后台抓取聊天内容。

本轮不要新增新的模型供应商集成。

---

# 11. 外部软件与工具授权边界

Workbench 后续可以支持浏览器、MCP、Skill 等工具能力。

但必须遵守：

> 只有用户主动允许、已经安装、已经连接或明确选择的能力才可以使用。

特别是课程实操场景此前已经明确：

- Ego Browser 可以使用；
- 已装配 / 已授权 MCP 可以使用；
- 已装配 / 已授权 Skill 可以使用；
- 不要擅自调用没有提到或没有授权的软件。

Workbench 不应设计成一个偷偷接管系统的软件。

---

# 12. M1 暂时不做什么

以下项目明确推迟。

## 暂不做

- 原生 PDF 渲染；
- 原生 PNG 渲染；
- 微信公众号直接发布；
- 其他平台一键发布；
- 新 AI 模型连接器；
- 后台聊天抓取；
- 自动获取用户浏览器 Cookie；
- 系统钥匙串完整适配；
- 全新素材管理系统；
- 大规模 UI 重构；
- 全新课程 schema；
- 新版 Grid 引擎；
- 重新设计搜索系统；
- SQLite Canonical 化；
- 新增复杂协作功能。

注意：

**“暂不做”不是删除。**

现有代码如果已经存在，应保留。

---

# 13. 推荐实施顺序

Agent 应按照以下顺序执行。

---

## Phase A：Baseline Audit

先不要改代码。

检查：

1. 当前 `deno task check`
2. 当前 `deno task test`
3. 当前 `deno task ui`
4. 当前 Tauri command
5. UI 到 service 的调用链
6. 项目打开逻辑
7. Asset import
8. autosave / recovery
9. export
10. existing test coverage

输出一个内部 baseline。

### 目标

知道：

> 哪些能力已经存在，只是没有接到 Desktop。

不要因为没在 UI 看见就重新实现。

---

## Phase B：Native Bridge

建立正式 Native Adapter。

优先完成：

```text
open_project
select_file
select_folder
import_asset
select_export_path
```

如现有高层 command 已存在，应复用。

不要让 UI 直接操作系统文件 API。

---

## Phase C：Project Lifecycle

打通：

```text
Launch
 ↓
Open Project
 ↓
Validate
 ↓
Lock
 ↓
Load
 ↓
Edit
 ↓
Autosave
 ↓
Close
 ↓
Unlock
```

同时验证：

```text
Crash
 ↓
Restart
 ↓
Recovery Detection
 ↓
Preview
 ↓
Restore
```

---

## Phase D：Asset Pipeline

打通：

```text
File Picker / Drag & Drop
          ↓
        Import
          ↓
        Asset
          ↓
        Usage
          ↓
      Canonical Save
          ↓
        Preview
```

支持：

- image
- GIF
- video
- Markdown

---

## Phase E：Persistence Regression

针对已经存在的数据模型做回归测试。

至少覆盖：

```text
正文
Requirement
Asset
Usage
Flow
Grid
Section
六维状态
占位符
结构视图
Block 顺序
```

操作：

```text
修改
 ↓
保存
 ↓
关闭
 ↓
重启
 ↓
重新打开
 ↓
比较
```

必须一致。

---

## Phase F：Export Closure

本轮只要求稳定：

- Markdown；
- HTML。

验证：

```text
Project
 ↓
Preflight
 ↓
Export
 ↓
生成文件
 ↓
重新打开检查
```

不要为了追求 PDF / PNG 延误 M1。

---

## Phase G：End-to-End Test

建立至少一条真实课程项目 E2E。

测试流程：

```text
1. 启动应用
2. 打开项目
3. 打开一节课
4. 修改正文
5. 添加 Requirement
6. 拖入图片
7. 拖入 GIF
8. 拖入视频
9. 修改 Grid / Flow
10. 保存
11. 关闭程序
12. 重新启动
13. 打开同一项目
14. 检查所有内容
15. 导出 Markdown
16. 导出 HTML
17. 检查项目完整性
```

---

# 14. M1 验收标准

只有满足以下条件才可以宣布 M1 完成。

## 用户体验

- [ ] 可以从 GUI 打开项目
- [ ] 不需要终端
- [ ] 可以选择文件
- [ ] 可以选择文件夹
- [ ] 可以拖入素材
- [ ] 可以正常编辑课程
- [ ] 自动保存有效
- [ ] 关闭程序后数据不丢
- [ ] 再次打开可以继续
- [ ] 外部修改能被检测
- [ ] 异常退出可以恢复
- [ ] Markdown 可以导出
- [ ] HTML 可以导出

## 数据完整性

- [ ] Canonical 仍以 `project.json` 为准
- [ ] Asset 引用有效
- [ ] checksum 有效
- [ ] Grid 不丢
- [ ] Flow 不丢
- [ ] Requirement 不丢
- [ ] 六维状态不丢
- [ ] 占位符不丢
- [ ] 历史恢复有效
- [ ] 删除缓存后仍可重建

## 架构

- [ ] Tauri 没有复制 domain 逻辑
- [ ] Tauri 没有复制 service 逻辑
- [ ] Web UI 继续可以独立审查
- [ ] UI 不直接绕过 command 操作 Canonical
- [ ] AI 仍不能静默修改项目
- [ ] 凭据没有进入 project / Git / export / diagnostics

## 回归

- [ ] 现有测试通过
- [ ] 新增 Desktop 相关测试
- [ ] 没有删除已有功能
- [ ] 没有静默改变 schema 语义

---

# 15. 本轮明确禁止“顺手重构”

Agent 在执行过程中可能会发现：

- 某文件比较乱；
- 某函数可以重写；
- 某 UI 可以更漂亮；
- 某 schema 可以重新设计；
- 某依赖可以替换。

本轮不要因此扩大范围。

遵守：

> 能局部修复，不全局重写。

> 能 Adapter，不复制系统。

> 能复用，不重新造轮子。

> M1 无关的改进，记录为后续事项，不在本轮展开。

---

# 16. 不允许随意删除已有功能

这是本项目的重要开发约束。

Agent 不得因为：

- 简化代码；
- 当前 UI 没用到；
- 测试不方便；
- 自己认为多余；

就删除已有能力。

如果确实需要：

- 删除；
- 合并；
- 废弃；
- 改名；
- 改 schema；
- 改行为；

必须在任务结束报告中明确写出：

```text
原功能：
修改：
原因：
兼容性影响：
迁移方式：
```

没有明确说明的功能变化视为不合格更新。

---

# 17. Agent 完成任务后必须输出的报告

开发结束时不要只说：

> “Done.”

必须输出结构化报告。

---

## 17.1 本轮完成内容

按用户能力描述，而不是只列代码文件。

例如：

```text
已完成：
- GUI 打开项目
- Native 文件选择
- 图片拖入
- GIF 拖入
- 视频拖入
- 项目关闭 / 重开恢复
- Markdown 导出
- HTML 导出
```

---

## 17.2 修改文件

列出：

```text
新增：
修改：
删除：
```

如果没有删除：

```text
删除：无
```

---

## 17.3 功能变化

必须明确：

```text
新增功能：
修改功能：
删除功能：
```

特别要求：

> 如果删除功能为 0，明确写“无”。

---

## 17.4 测试

写出：

```text
deno task check
deno task test
...
```

以及最终结果。

---

## 17.5 已知问题

只记录真实存在的问题。

不要把未来 Feature 全部列成“问题”。

---

## 17.6 下一步建议

只允许建议进入：

> M2：Course Authoring UX

不要在 M1 结束时突然启动其他大型方向。

---

# 18. 后续 Milestones

为了防止 Agent 在本轮过度开发，后续阶段提前定义如下。

---

# M1 — Desktop Usability Closure

目标：

> 把已有能力变成真正可用的桌面工作流。

关键词：

```text
Open
Import
Edit
Autosave
Recover
Reopen
Export
```

---

# M2 — Course Authoring UX

M1 完成后，再集中优化：

- 课程结构视图；
- 单课编辑器；
- 左中右三栏体验；
- 结构 / 正文联动；
- Flow 编辑；
- Grid 编辑；
- 虚线编辑；
- 自动对齐；
- 图片 / GIF / 视频的可视化放置；
- Requirement 展示；
- 占位符；
- 待补；
- 素材状态；
- Preview；
- 单课完成度；
- 快速跳转任意课程节点。

目标：

> 真正提高“制作一节课”的效率。

---

# M3 — AI Native Workflow

M2 稳定后再进入。

重点：

- AI Context Assembly；
- DeepSeek；
- 豆包；
- ChatGPT；
- MCP；
- Skill；
- Ego Browser；
- 上下文选择；
-课程级 AI；
- 单课级 AI；
- Block 级 AI；
- Suggestion；
- ChangeDraft；
- Diff；
- Apply；
- AI 执行日志；
- 权限边界。

目标：

> AI 深度进入工作流，但仍然不破坏用户控制权。

---

# M4 — Publish & Render

最后处理发布层。

包括：

- PDF；
- PNG；
- 更稳定的 HTML；
- 微信课程场景适配；
- Web 发布；
- 平台 Adapter；
- 手动 / 半自动发布流程；
- 后续可能的平台 API。

目标：

> 把课程从 Workbench 安全迁移到真实发布场景。

---

# 19. 本轮 Agent 的最终任务定义

将以下内容视为本轮最高级 Prompt：

---

## TASK

将当前 AI Course Workbench 从“功能完整度较高的 Web / Service 原型”推进到“可以日常使用的 Desktop-first 工作台”。

本轮不新增大规模课程功能。

重点完成：

1. Tauri Native Adapter；
2. GUI 项目打开 / 关闭；
3. 文件 / 文件夹选择；
4. Desktop Drag & Drop；
5. 图片 / GIF / 视频 / Markdown Asset Import；
6. Canonical 保存；
7. Autosave；
8. Recovery；
9. Reopen；
10. Markdown / HTML Export；
11. End-to-End Desktop Workflow。

必须最大程度复用现有：

- domain；
- service；
- command；
- schema；
- UI；
- recovery；
- export；
- asset pipeline；
- tests。

禁止重新实现已经存在的业务逻辑。

禁止为了本轮任务重构整个项目。

禁止让 SQLite、缓存或 Tauri 成为新的 Canonical 数据源。

禁止 AI 绕过：

```text
Suggestion → ChangeDraft → Diff → Apply
```

禁止无说明删除已有功能。

任务结束后必须汇报：

- 完成了什么；
- 修改了哪些文件；
- 新增了哪些功能；
- 修改了哪些功能；
- 删除了哪些功能；
- 运行了哪些测试；
- 哪些问题仍未解决。

---

# 20. 最终判断标准

Agent 在开发过程中遇到选择时，用这一句话判断优先级：

> **这件事是否直接帮助用户在桌面 Workbench 中完成“打开项目 → 编辑 → 导入素材 → 保存 → 关闭 → 重开 → 继续 → 导出”的完整流程？**

如果：

**是** → M1 优先处理。

如果：

**不是** → 记录下来，放到 M2 / M3 / M4，不要扩大本轮范围。

---

# 21. 本轮结束时应该达到的状态

理想结果不是：

> “Workbench 又多了十个功能。”

而是：

> “从今天开始，即使后续功能还没有全部完成，我已经可以真正把一个课程项目放进 Workbench 里持续做，并且不用担心退出、重启、切换课程、插入素材或继续开发时进度丢失。”

这才是 M1 完成的意义。
