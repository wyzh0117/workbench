# V0-T02 — Course Authoring 任务执行文档

> 项目：AI Course Workbench  
> 任务：V0-T02 — Course Authoring  
> 文档类型：执行任务卡 / 开发与验收说明  
> 日期：2026-09-21  
> 上位控制文件：`PROJECT_MASTER_CONTROL.md`  
> 优先级：当前唯一 NEXT ACTION

---

# 0. 文档定位

本文件只服务于：

```text
V0-T02 — Course Authoring
```

它不是新的产品阶段，不是 Milestone，也不得继续拆成：

```text
V0-T02-A
V0-T02.1
M2
N1
Phase-A
Fix-Phase
```

如果执行过程中发现问题：

- 阻止 V0-T02 达到 Definition of Done → 记为 `BLOCKER`，继续在 V0-T02 内解决；
- 不阻止 V0-T02 完成 → 记为 `BACKLOG`；
- 明确属于 V1 / V2 → 记为 `DEFERRED`；
- 与产品方向不符 → 记为 `REJECTED`。

无论经历多少轮开发、修复和验收，它始终是同一个任务：

```text
V0-T02
```

---

# 1. Agent 启动要求

开始任何修改之前，必须完整阅读：

```text
1. PROJECT_MASTER_CONTROL.md
2. README.md
3. 本文件
4. 与 Course Authoring 直接相关的现有代码、测试和历史设计资料
```

然后确认：

```text
Current Version = V0
Previous Task = V0-T01 — Desktop 基础闭环
Previous Task Status = VERIFIED
Current Task = V0-T02 — Course Authoring
Next Task after verification = V0-T03 — AI Workflow
```

如果仓库中的总控状态仍显示：

```text
Current Task = V0-T01
```

这是因为 T01 刚完成交接。

开始 V0-T02 时，应先将总控中的当前任务切换为：

```text
V0-T02 — Course Authoring
IN PROGRESS
```

并保持：

```text
V0-T03 — NOT ACTIVE
V0-T04 — NOT ACTIVE
```

不得提前扩张到 AI Workflow 或 Publish。

---

# 2. Git 与工作区纪律

开始开发前：

```text
git status
git branch --show-current
git log --oneline -n 10
```

要求：

1. 明确当前工作树是否干净；
2. 不覆盖或丢失 V0-T01 已验收成果；
3. 不删除来源不明的现有改动；
4. 推荐在独立分支完成 V0-T02；
5. 未经用户明确要求，不要重写历史；
6. 不要为了“整理代码”进行与 T02 无关的大规模重构。

若当前已有用户或其他 Agent 的未提交改动：

> 先识别归属，再决定是否继续；不得直接 reset / checkout / clean 掉未知修改。

---

# 3. Control Position

```text
Version:
V0

Task:
V0-T02 — Course Authoring

Previous Task:
V0-T01 — Desktop 基础闭环

Previous Task Status:
VERIFIED

Current Initial Status:
PARTIAL → IN PROGRESS

Next Task:
V0-T03 — AI Workflow
```

---

# 4. North Star 约束

AI Course Workbench 的长期目标不是“生成一节课”。

它要成为：

> 面向非技术用户、本地优先、可以长期维护课程内容，并允许 AI 深度参与但不夺走用户控制权的课程生产工作台。

因此 V0-T02 的重点不是增加功能数量，而是让现有课程生产能力真正形成一条自然、稳定、可长期继续的 Authoring Workflow。

用户在任何时候都应该知道：

```text
我现在在哪门课
我现在在哪一节课
这节课有什么内容
结构是什么
哪些内容还没补
哪些素材已经使用
排版大致是什么
这一节做到什么程度
整门课程还有哪些地方没完成
我下一步可以继续哪里
```

---

# 5. V0-T02 核心目标

最终目标：

> **让用户真正可以高效完成一节课，并且能随时跳转到整门课程的任何位置继续工作。**

本任务完成后，用户应能够在真实 Desktop Workbench 中顺畅完成：

```text
打开课程项目
↓
进入课程地图
↓
查看整门课程结构与状态
↓
进入任意一课
↓
查看该课正文 / 结构 / 排版 / 素材 / 待补状态
↓
编辑正文
↓
调整结构
↓
插入和管理图片 / GIF / 视频 / Markdown 等素材
↓
使用 Flow / Grid 完成基础编排
↓
创建 Requirement / Placeholder / 待补项
↓
预览当前结果
↓
查看完成状态
↓
跳转到另一课
↓
再返回原课
↓
保存 / 自动保存
↓
退出
↓
重启 Workbench
↓
重新打开课程
↓
继续刚才的工作
```

---

# 6. 本任务不是做什么

V0-T02 不负责：

```text
真实模型接入体系完善
DeepSeek / 豆包 / ChatGPT 的完整生产工作流
复杂 Agent orchestration
AI 自动修改 Canonical
MCP / Skill 全量集成
微信发布自动化
复杂发布适配
PDF / PNG 全套输出体系
模板市场
多人协作
跨课程资产库
批量生产
大型插件生态
V1 级效率优化
```

这些内容即使在实现过程中“顺手可做”，也不得因此扩大 T02。

已有基础 AI ChangeDraft / Diff / Apply 机制可以保持工作，不要在本任务中主动扩张。

---

# 7. 已有能力：优先复用，不要重造

当前项目已经存在或基本存在：

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

三栏工作台
正文
结构
排版
Grid
预览
待补
Inbox
快速收集
版本恢复
导出前检查

Autosave
Recovery
Project Lock
External Modification Detection
Native Picker
Finder Drag & Drop
素材 checksum
Asset / Usage
Markdown / HTML Export
```

V0-T02 应建立在这些能力上。

原则：

> 优先连接、整理、补齐、收口现有能力，而不是建立第二套 Authoring 系统。

尤其禁止出现：

```text
Web 一套编辑模型
Desktop 另一套编辑模型
Preview 单独维护一套内容
Course Map 自己复制一份课程状态
Grid 自己保存独立真相
```

---

# 8. 永久架构边界

## 8.1 Desktop-first, Browser-compatible

正式生产形态：

```text
Tauri Desktop
```

Web 保留用于：

```text
开发
调试
UI 审查
Domain / Service 验证
回归测试
```

不要维护两套产品逻辑。

---

## 8.2 Canonical First

必须继续保持：

```text
project.json = Canonical Truth
```

UI、缓存、索引、预览状态、缩略图等不得成为新的唯一事实来源。

Course Authoring 的任何编辑结果最终都必须能够：

```text
写入 Canonical
关闭应用
重新打开
重新构造 UI
得到一致结果
```

---

## 8.3 内容与排版分离

正文、课程结构、媒体语义与排版要求保持结构化。

不要把：

```text
最终 HTML
某个平台富文本
某个平台字体
某个平台专有样式
```

直接当成课程源内容。

---

## 8.4 不破坏 T01 的数据安全闭环

任何 Authoring 写入路径必须继续服从：

```text
Autosave
Atomic Write
Project Lock
External Modification Detection
Recovery
History / Snapshot
```

不得因为新增编辑器交互而绕开这些机制。

---

# 9. UX 总原则

Course Authoring 应优先满足：

```text
易理解
少迷路
少切换
少重复操作
状态明确
操作结果可预期
失败可恢复
长期回来还能继续
```

不是追求：

```text
功能按钮越多越好
面板越多越好
动画越多越好
信息越密越好
```

对于非技术用户：

> 页面应围绕“课程 → 课 → 内容 → 结构 → 排版 → 待补 → 预览”组织，而不是围绕内部数据模型命名组织。

---

# 10. 核心工作面

以下是同一 V0-T02 内的工作面，不是新的任务编号。

---

## 10.1 课程地图 / Course Map

课程地图必须让用户快速理解整门课程。

至少应能够看到：

```text
课程标题
课程整体结构
章节 / 单元
每一课
当前所在位置
各课完成状态
待补状态
必要的内容摘要或进度提示
```

应支持：

```text
点击任意课进入编辑
快速切换上一课 / 下一课
从单课返回课程地图
跳转后不丢未保存工作
```

课程地图不能只是静态目录。

它应成为：

> 整门课程的导航中心 + 进度入口。

### 验收关注

- 课程较长时仍能定位当前课；
- 当前课有明确视觉状态；
- 不需要记住课程编号才能跳转；
- 跳转后数据正确；
- 重开项目后仍能恢复课程状态；
- 不依赖临时前端状态重建课程结构。

---

## 10.2 单课编辑器 / Lesson Editor

单课编辑器是 V0-T02 的核心生产界面。

用户进入一课后，应在不频繁跳页的前提下完成主要工作。

推荐继续围绕已有三栏逻辑收口：

```text
左侧：
课程 / 结构 / 导航

中间：
正文与核心编辑区

右侧：
属性 / 排版 / 素材 / 状态 / 待补等上下文面板
```

具体布局可以根据现有实现优化，但必须确保：

```text
当前课明确
当前 Block 明确
当前选择对象明确
当前编辑结果明确
当前排版结果明确
```

避免：

```text
选中了什么不清楚
编辑正文后结构不更新
结构调整后正文错位
右侧面板作用对象不清楚
切换课后仍显示上一课属性
```

---

## 10.3 正文与结构同步

正文编辑与结构视图必须表达同一个 Canonical 内容。

至少验证：

```text
新增 Block
删除 Block
修改 Block
移动 Block
修改 Section
调整顺序
结构视图定位正文
正文定位结构项
```

要求：

> 结构变化不能只发生在 UI；正文变化也不能形成与结构脱节的“幽灵内容”。

需要重点排查：

```text
selection drift
index drift
删除后残留 selection
移动后引用失效
切换课后旧 selection 泄漏
undo / history 与当前结构冲突
```

---

# 11. Flow 与 Grid

V0-T02 需要让 Flow / Grid 从“已有能力”变为真正可用的课程编排工具。

---

## 11.1 Flow

Flow 至少要满足：

```text
自然纵向阅读
Block 顺序清楚
文本与素材混排合理
结构变化立即可见
```

---

## 11.2 Grid

Grid 至少要满足：

```text
用户能理解正在编辑的是布局
可选择 / 移动 / 调整 Grid 中的内容
不会把排版结果变成第二份内容真相
Grid 与 Canonical Block / Asset 引用保持一致
```

---

## 11.3 Flow / Grid 切换

至少验证：

```text
Flow → Grid
Grid → Flow
切换后内容不丢
引用不丢
素材不丢
结构不乱
重新打开项目结果一致
```

如果当前产品允许混合使用，应验证混合场景。

---

# 12. 素材 Authoring 体验

T01 已经完成真实素材导入基础闭环。

T02 的重点不是再次验证“能不能导入”，而是验证：

> 导入后的素材是否真的能自然地用于课程制作。

至少覆盖：

```text
image
GIF
video
Markdown
```

根据当前数据模型和 UI，完成以下体验闭环：

```text
导入素材
↓
看到素材
↓
选择素材
↓
插入当前课 / 当前 Block / 当前布局
↓
形成 Asset / Usage
↓
在正文 / Flow / Grid 中可见
↓
预览可见
↓
删除或解除引用时语义正确
↓
保存
↓
重开
↓
引用仍然正确
```

---

## 12.1 素材可视化

应让用户至少能判断：

```text
这是什么素材
是否已经使用
在哪里使用
当前插入的是什么
素材是否缺失
```

不要求 V1 级 DAM / 素材库能力。

---

## 12.2 删除与引用安全

重点验证：

```text
删除 Asset
删除 Usage
删除 Block
删除课
移动 Block
复制 / 重排
```

不得造成：

```text
无提示断链
幽灵引用
导出引用错误
项目重开后素材消失
错误删除实际文件
```

---

# 13. Requirement / Placeholder / 待补

这是长期课程维护能力的重要部分。

用户应能够在一课中明确记录：

```text
还缺什么
为什么缺
以后应该补什么
当前是否阻塞课程完成
```

至少验证：

```text
创建
查看
定位
编辑
完成 / 解除
删除
跨课查看或通过课程地图识别
保存
重开
```

Requirement / Placeholder / 待补不能只是备注文本。

它们应真正服务于：

> “隔几天回来，我仍然知道下一步做什么。”

---

# 14. Preview

Preview 必须成为 Authoring 的即时反馈工具，而不是另一套编辑系统。

至少确保：

```text
正文修改 → Preview 更新
结构修改 → Preview 更新
素材插入 → Preview 更新
Flow / Grid 变化 → Preview 更新
Requirement / Placeholder 不错误进入正式内容
```

Preview 不得：

```text
单独保存内容
单独修改 Canonical
静默修复源数据
使用与导出完全不同的数据来源
```

---

# 15. 完成状态

当前项目已有六维状态基础。

V0-T02 不要求构造复杂项目管理系统，但必须让完成状态对 Authoring 有实际意义。

用户至少应能理解：

```text
这一课是否完成
哪里没完成
为什么没完成
哪一课应该继续
```

需要确认：

```text
状态是否来自真实课程数据
状态变化是否持久化
课程地图是否反映状态
待补项是否影响状态
重开项目后状态是否一致
```

如果现有“六维状态”过于技术化：

> 可以优化显示方式，但不要破坏底层语义。

---

# 16. 快速跳转与继续工作

V0-T02 必须重点验证“长期继续做”。

典型场景：

```text
用户正在 Lesson 03 编辑
↓
发现 Lesson 07 缺一张图
↓
跳到 Lesson 07
↓
添加 Placeholder
↓
回到 Lesson 03
↓
继续原来的编辑
```

以及：

```text
用户今天做到 Lesson 05
↓
退出
↓
几天后重新打开
↓
能够快速知道之前做到哪里
↓
继续 Lesson 05 或任何其他课
```

不要求一定恢复像 IDE 一样精确的光标位置。

但必须避免：

```text
重新打开后完全不知道之前做到哪里
跳课后丢内容
返回后选择状态错乱
跨课操作污染当前课
```

---

# 17. 键盘、鼠标与桌面交互

V0-T02 是 Desktop Authoring 任务，因此不能只依赖浏览器点击测试。

根据当前产品已有交互，至少检查：

```text
鼠标点击
滚动
拖放
常用输入
删除
选择
面板切换
课程跳转
窗口尺寸变化
```

如果已有快捷键：

> 验证，不必为了 T02 新造复杂快捷键体系。

如果某个最基础操作必须经过大量点击才能完成：

> 可以作为 Authoring UX blocker 处理。

---

# 18. 空状态与错误状态

必须覆盖常见非 happy path。

至少考虑：

```text
空课程
空课
空 Section
无素材
素材缺失
无 Requirement
无 Placeholder
删除当前 Block
删除当前课内最后一个 Block
当前 selection 对象不存在
项目刚恢复
外部修改冲突发生在 Authoring 期间
素材导入失败
```

UI 不得因此：

```text
白屏
卡死
持续报错
无法继续操作
写坏 Canonical
```

---

# 19. 不允许破坏的 T01 能力

V0-T02 验收时必须进行回归。

至少确认：

```text
Desktop App 启动
Open Project
Native Picker
Finder Drag & Drop
Autosave
Close / Restart / Reopen
Recovery Restore
Recovery Discard
Project Lock
External Change Detection
No Silent Overwrite
Markdown Export
HTML Export
Web Workbench
```

Course Authoring 的新增交互不得绕过这些保护。

---

# 20. 数据一致性要求

所有关键 Authoring 操作应检查：

```text
UI 状态
Canonical 状态
磁盘状态
重开后的状态
```

至少对以下操作做一致性验证：

```text
编辑文本
新增 / 删除 / 移动 Block
新增 / 删除 Section
切换课
插入素材
调整 Usage
Flow / Grid 调整
新增 Requirement
新增 Placeholder
完成待补
状态变化
```

原则：

> “当前看起来对”不等于完成；必须重开后仍然对。

---

# 21. 测试要求

不要只增加 UI 代码。

根据项目现有测试结构，为关键逻辑增加或更新自动测试。

至少应覆盖能被自动化验证的：

```text
course navigation
lesson selection
block structure mutation
section mutation
asset usage
requirement / placeholder lifecycle
completion state
flow / grid persistence
canonical serialization
reopen / rehydrate
```

保持现有：

```text
deno task check
deno task test
cargo test
cargo check / build（按当前仓库惯例）
```

通过。

若已有 E2E / UI harness，优先复用。

不要为了测试另外造一套产品路径。

---

# 22. 真实 Desktop E2E 验收场景

V0-T02 必须至少完成一次真实 Tauri Desktop 的 Course Authoring 闭环。

建议使用临时测试课程，覆盖：

```text
1. 启动真实 Tauri Desktop

2. 打开一门已有多课的课程
   - 如果没有合适 fixture，可创建临时测试项目

3. 在 Course Map 中：
   - 查看课程结构
   - 进入 Lesson A
   - 跳转 Lesson B
   - 返回 Lesson A

4. 在 Lesson A：
   - 编辑正文
   - 新增一个 Block
   - 调整结构顺序
   - 创建一个 Requirement 或 Placeholder

5. 插入素材：
   - 至少 image
   - 至少再验证 GIF / video / Markdown 中的可用类型
   - 确认 Asset / Usage 关系

6. 使用 Flow / Grid：
   - 进行一次实际布局编辑
   - 至少完成一次视图切换

7. Preview：
   - 确认正文 / 素材 / 结构变化正确反映

8. 完成状态：
   - 确认当前课状态有明确变化或反馈
   - Course Map 能反映必要状态

9. 跳转到另一课：
   - 做一处编辑或待补标记
   - 再返回原课
   - 原数据仍正确

10. 等待或触发 Autosave

11. 关闭 Desktop

12. 重启 Desktop

13. 重新打开同一课程

14. 验证：
   - 课程结构
   - Lesson 内容
   - Block 顺序
   - 素材 Usage
   - Requirement / Placeholder
   - Flow / Grid
   - 完成状态
   - Preview
   均与关闭前一致

15. 执行一次现有 Markdown / HTML Export 回归

16. 执行 Web Workbench 回归
```

---

# 23. Authoring UX 验收判断

以下任一情况若严重影响正常课程制作，应视为 T02 BLOCKER，而不是留给“以后优化”：

```text
经常不知道当前课是谁
无法快速切换课
正文与结构经常不同步
素材导入后不知道怎么使用
Flow / Grid 会丢内容
跳课会丢编辑
重开项目后 Authoring 状态错误
待补项无法定位
完成状态明显不可信
Preview 与实际内容严重不一致
基本操作需要进入开发者工具才能恢复
正常 Authoring 会绕开 T01 的锁 / 冲突 / autosave
```

以下通常可以进入 BACKLOG：

```text
高级快捷键
复杂动画
主题美化
高级模板
批量处理
跨课程复制
高级素材检索
高级历史比较
多人协作
V1 级效率增强
```

---

# 24. 视觉与交互收口原则

这轮允许做必要 UI 优化，但目标是：

```text
清楚
稳定
一致
可理解
```

不是：

```text
完全重做视觉系统
重新设计品牌
引入大型 UI Framework
为了美观重写业务层
```

优先解决：

```text
层级混乱
面板命名不一致
状态不明显
当前选择不明确
按钮位置不稳定
空状态难理解
信息过载
关键入口过深
```

---

# 25. Scope Creep 判断

每准备增加一个功能前问：

> 如果不做这件事，用户还能否稳定完成“一节课 + 整门课程跳转维护”的 Authoring 闭环？

如果：

```text
不能
→ 属于 V0-T02

能
→ BACKLOG / DEFERRED
```

不要顺手扩张。

---

# 26. V0-T02 Definition of Done

只有以下项目同时满足，才允许：

```text
V0-T02 = VERIFIED
```

---

## 26.1 Course Map

```text
[ ] 可查看整门课程结构
[ ] 当前课位置明确
[ ] 可进入任意一课
[ ] 可快速在课程之间跳转
[ ] 必要完成 / 待补状态可识别
[ ] 跳转不丢数据
```

---

## 26.2 Lesson Editor

```text
[ ] 单课核心编辑流程稳定
[ ] 当前课明确
[ ] 当前 Block / selection 明确
[ ] 正文可以新增 / 修改 / 删除
[ ] 结构可以新增 / 修改 / 删除 / 重排
[ ] 正文与结构保持同步
```

---

## 26.3 Flow / Grid

```text
[ ] Flow 可实际用于课程正文编排
[ ] Grid 可实际用于基础布局
[ ] Flow / Grid 切换不丢内容
[ ] 布局结果持久化
[ ] 重开后布局一致
```

---

## 26.4 Assets

```text
[ ] 导入后的素材可自然进入 Authoring 流程
[ ] image 可插入并正确显示
[ ] GIF / video / Markdown 等已有类型不回归
[ ] Asset / Usage 语义正确
[ ] 素材使用状态可理解
[ ] 删除 / 解除引用不会产生明显断链
[ ] 重开后素材引用一致
```

---

## 26.5 Requirement / Placeholder / 待补

```text
[ ] 可创建
[ ] 可编辑
[ ] 可定位
[ ] 可完成 / 解除
[ ] 可删除
[ ] 可持久化
[ ] 课程地图或单课界面能帮助用户识别未完成工作
```

---

## 26.6 Preview

```text
[ ] 正文修改可正确预览
[ ] 结构修改可正确预览
[ ] 素材可正确预览
[ ] Flow / Grid 变化可正确预览
[ ] Preview 不形成第二套数据真相
```

---

## 26.7 Completion / Navigation

```text
[ ] 单课完成状态对用户可理解
[ ] 完成状态持久化
[ ] Course Map 能反映必要状态
[ ] 可以从任意一课跳到另一课继续
[ ] 返回原课后数据正确
```

---

## 26.8 Persistence

```text
[ ] Authoring 操作进入 Canonical
[ ] Autosave 正常
[ ] Close / Restart / Reopen 后内容一致
[ ] Recovery 不回归
[ ] Project Lock 不回归
[ ] External Change Detection 不回归
[ ] 不发生 silent overwrite
```

---

## 26.9 Runtime

```text
[ ] 真实 Tauri Desktop 完成完整 Course Authoring E2E
[ ] Native interaction 正常
[ ] 无关键白屏 / 卡死 /不可恢复状态
```

---

## 26.10 Automated Verification

```text
[ ] deno task check 通过
[ ] deno task test 通过
[ ] Rust tests 通过
[ ] 必要 build / compile 通过
[ ] 新增核心 Authoring 行为有合理测试覆盖
```

---

## 26.11 Regression

```text
[ ] V0-T01 Desktop 基础闭环无回归
[ ] Markdown Export 无回归
[ ] HTML Export 无回归
[ ] Web Workbench 无关键回归
```

---

## 26.12 Project Control

```text
[ ] BLOCKER = NONE
[ ] PROJECT_MASTER_CONTROL.md 已回写
[ ] V0 Task Board 已更新
[ ] Change Log 已追加
[ ] NEXT ACTION 唯一指向 V0-T03
```

全部满足后：

```text
V0-T02 = VERIFIED
```

否则只能：

```text
IN PROGRESS
BLOCKED
PARTIAL
DONE
```

不得提前宣称 VERIFIED。

---

# 27. 验收证据要求

“代码看起来完成”不算验收。

结项报告必须给出足够证据，例如：

```text
自动测试结果
真实 Desktop 运行结果
具体 E2E 路径
保存 / 重开验证
Course Map 跳转验证
Lesson Editor 操作验证
Flow / Grid 验证
Asset / Usage 验证
Requirement / Placeholder 验证
Preview 验证
Web Regression
```

如果某一项没有真实验证：

> 明确写入 `Unverified`。

不得用：

```text
理论上可用
应该没问题
代码已经覆盖
看起来没问题
```

替代真实验收。

---

# 28. 发现缺陷时如何处理

执行过程中发现问题时：

---

## BLOCKER

满足任一条件：

```text
阻止正常完成一节课
阻止跨课跳转
导致数据丢失
导致 Canonical 错乱
导致重开后不一致
导致素材断链
导致 silent overwrite
导致 Desktop 无法正常工作
```

必须继续在 V0-T02 内解决。

---

## BACKLOG

例如：

```text
快捷键增强
批量操作
美化
高级筛选
高级拖拽
高级面板定制
```

记录但不要顺手扩展。

---

## DEFERRED

明确属于：

```text
V1 高效生产
V2 长期扩展
V0-T03 AI Workflow
V0-T04 Output & Publish
```

直接记录，不实现。

---

## REJECTED

例如：

```text
引入第二套 Canonical
AI 静默修改课程
Desktop / Web 两套独立业务逻辑
为了 UI 美化重写整个架构
```

不做。

---

# 29. 完成前代码审查

进入真实验收前至少做一次针对 T02 的自查：

```text
是否重复实现已有 Domain / Service？
是否新增了第二份课程状态？
是否存在 UI-only persistence？
是否绕过 Autosave？
是否绕过 Lock？
是否绕过 External Modification Detection？
是否把 Preview 当成真相？
是否让 Grid 成为独立内容模型？
是否破坏 Asset / Usage 语义？
是否出现跨课 selection 泄漏？
是否存在明显 event listener 泄漏？
是否存在 lesson 切换 race？
是否存在 stale state 写回旧 lesson？
```

发现问题后先修复，再验收。

---

# 30. 完成后的总控更新

任务结束必须同步更新 `PROJECT_MASTER_CONTROL.md`。

至少更新：

```text
A. Last Updated
B. Current Position
C. Current Task
D. V0 Task Board
E. Next Action
F. Change Log
```

若 V0-T02 VERIFIED：

```text
Current Version:
V0

Current Task:
V0-T02 — Course Authoring（已完成）

Current Status:
VERIFIED

V0 Task Board:
V0-T01 = VERIFIED
V0-T02 = VERIFIED
V0-T03 = PARTIAL / NOT ACTIVE 或 READY（按总控实际状态）
V0-T04 = PARTIAL / NOT ACTIVE

NEXT ACTION:
V0-T03 — AI Workflow
```

不得直接进入 V1。

---

# 31. 强制结项报告

结束时严格按照总控模板输出：

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
```

---

# 32. 结项时必须明确回答

必须清楚回答：

```text
1. 原计划是什么？
2. 实际完成了什么？
3. 哪些没有完成？
4. 哪些完成但做得不够好？
5. 出现了哪些 BLOCKER / BACKLOG / DEFERRED / REJECTED？
6. 是否改变 / 删除原有功能？
7. 总控位置如何变化？
8. 下一步唯一应该做什么？
```

不能只写“已完成”。

---

# 33. 禁止提前开始 V0-T03

即使 T02 开发过程中看到 AI 相关问题，也只允许：

```text
记录
归类
保持兼容
```

不得主动扩张：

```text
DeepSeek
豆包
ChatGPT
MCP
Skill
Agent orchestration
Prompt system
AI memory
AI auto-apply
```

只有当：

```text
V0-T02 = VERIFIED
```

并且总控已更新后，才允许将唯一 NEXT ACTION 切换为：

```text
V0-T03 — AI Workflow
```

---

# 34. 最终验收一句话标准

V0-T02 是否完成，只问一个问题：

> **一个非技术用户能否在真实 Desktop Workbench 中，顺畅地进入整门课程的任意一课，完成正文、结构、素材、Flow/Grid、待补与预览等日常制作工作，随时跳到别处再回来，并在关闭、重启、重新打开后继续工作而不丢失、不迷路、不破坏数据？**

如果答案还不是稳定的“可以”：

```text
V0-T02 不能标记 VERIFIED。
```

如果答案为“可以”，并且全部 Definition of Done 与回归测试通过：

```text
V0-T02 = VERIFIED
NEXT ACTION = V0-T03 — AI Workflow
```
