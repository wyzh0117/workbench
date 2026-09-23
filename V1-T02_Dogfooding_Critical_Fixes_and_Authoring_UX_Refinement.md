# V1-T02 — Dogfooding Critical Fixes & Authoring UX Refinement

> AI Course Workbench  
> V1 平铺任务  
> 来源：V1-T01 完成后的真实 Dogfooding 使用反馈  
> 本任务不重新规划 V1，不创建新的 Milestone。

---

# 0. Agent 启动口令

开始前必须完整阅读：

```text
1. PROJECT_MASTER_CONTROL.md
2. README.md
3. 本任务卡
4. 必要代码与历史报告
```

并遵守：

> 不创建 V1-T02-A / V1-T02.1 / Fix Phase / 新 Milestone。整个过程始终只有一个 `V1-T02`。

开工时将总控更新为：

```text
CURRENT VERSION
V1（ACTIVE）

CURRENT TASK
V1-T02 — Dogfooding Critical Fixes & Authoring UX Refinement

CURRENT STATUS
IN PROGRESS
```

V0 保持 CLOSED；V1-T01 保持 VERIFIED。

---

# 1. 任务定位

此前曾草拟：

```text
V1-T02 — macOS Distribution & Public Release Closure
```

该方案本轮暂不执行，也不继续占用 `V1-T02` 编号。

原因是 Dogfooding 已发现更高优先级的真实问题：

```text
项目选择后无法再次打开项目
输入频繁中断
二级弹窗自动关闭
API Key 无法配置
Drag Handle 不工作
Grid Preview 不一致
```

因此当前优先级调整为：

```text
先修真实使用问题
→ 再次 Dogfooding
→ 再决定公开分发
```

macOS Distribution / GitHub Release 继续保留为后续候选任务。

---

# 2. 本任务的执行结构

V1-T02 只进行两次实施。

## 第一次实施

一次性完成：

```text
P0 + P1
```

即：

> 所有影响真实使用的 Bug + 已有功能的明显 UX / 产品逻辑问题。

P0 和 P1 不拆开。

第一次实施完成后：

```text
V1-T02 仍然 = IN PROGRESS
NEXT ACTION = 执行 P2
```

## 第二次实施

只完成：

```text
P2
```

即：

> 已经明确批准的交互重构。

只有 P0 + P1 + P2 全部完成并通过真实 Desktop 回归，才允许：

```text
V1-T02 = VERIFIED
```

---

# 3. Diagnostic First Rule

第一次实施开始时，不要直接逐条打补丁。

先做一次只读诊断，重点回答：

```text
1. 为什么输入会丢 focus？
2. 为什么 modal 会自行关闭？
3. 为什么页面会自动上弹？
4. 是否存在 store update / autosave 导致大范围 rerender？
5. 返回项目选择后，为什么第二次 Folder Picker 不执行？
```

重点排查：

```text
autosave
session save
store update
global rerender
blur
click-away
event bubbling
selection change
focus restore
modal ownership
native picker busy state
bridge handler
```

如果多个症状共享一个根因：

> 修共同根因，不要给每个弹窗分别加临时补丁。

---

# 4. P0 — Critical Real-Use Bugs

> P0 与 P1 在第一次实施中一起完成。

## P0-1 项目选择后无法再次打开项目

真实路径：

```text
打开项目文件夹
→ 进入课程主页面
→ 返回“项目选择”
→ 再点“打开项目文件夹”
→ 无任何反应
```

用户已重复验证：

```text
无论通过什么方式进入课程主页面
→ 回项目选择
→ 打开项目文件夹
→ 都无法再次正常打开
```

### Expected

```text
项目选择
→ 打开项目文件夹
→ Native Folder Picker 每次均能正常打开
→ 可打开同一项目或其他项目
→ 切换状态正确
```

重点检查：

```text
picker handler
native bridge 绑定
event listener 生命周期
openProject guard
picker busy flag
lease / session 状态
```

不得通过增加一个重复按钮来掩盖根因。

---

## P0-2 全局输入 / Focus / Modal 生命周期故障

用户反馈：

```text
输入或点击后页面频繁上弹
输入一两个字后被打断
快速收集弹窗一输入就关闭
保存版本弹窗一输入就关闭
导出窗口也会自动关闭
```

当前排查假设：

```text
input / click
→ state update / autosave
→ 大范围 rerender
→ DOM node 被替换
→ focus 丢失
→ modal state 被重置
```

但该链路只是排查假设，必须通过代码与运行时证据确认。

### Required Outcome

必须真实做到：

```text
连续中文输入不中断
连续英文输入不中断
autosave 不抢 focus
保存不重建当前输入控件
modal 内输入不关闭 modal
点击 modal 内容不触发外层 click-away
页面不无理由自动上弹
```

至少覆盖：

```text
正文
标题
引用
代码
Requirement 备注
Inbox 快速收集
保存版本名称
导出窗口
AI 指令
课程标题
```

---

## P0-3 “显示技术信息”无反应 + 导出窗口自动关闭

当前真实行为：

```text
点击“显示技术信息”
→ 完全无反应
```

并且导出窗口可能自动关闭。

本任务不预设按钮最终是“展开”还是“跳转”。

首先检查：

```text
设计意图
handler
modal 生命周期
是否与 P0-2 同根因
```

最低要求：

```text
按钮必须有真实响应
不能无反应
不能导致导出窗口关闭
```

---

## P0-4 API Key 无法配置

当前系统已具备系统级凭据存储，因此“无法配置 Key”属于真实 Bug。

### Required Outcome

至少实现：

```text
输入 Provider / Base URL
输入 API Key
保存
重启后仍显示已配置
更新
删除
实际调用可读取
```

安全边界继续保持：

```text
project.json 无密钥
Canonical 无密钥
session 无密钥
logs 无密钥
diagnostics 无密钥
exports 无密钥
execution record 无密钥
```

---

## P0-5 Drag Handle 无法使用

当前 Block 拖动重排已经属于已支持能力。

### Expected

```text
拖动左侧 Drag Handle
→ Block 真正重排
→ Canonical 顺序更新
→ Undo / Redo 正常
→ Autosave 正常
→ 重开后顺序一致
```

---

## P0-6 Preview 未真实体现 Grid 布局

Preview 不能只显示“当前是 Grid”，却继续按普通 Flow 顺序渲染。

Grid 模式至少应真实反映：

```text
row
column
row_span
column_span
未上画布内容
区域关系
```

必须继续遵守：

```text
Canonical + LayoutInstance
→ Preview Projection
```

不得创建第二套 Preview Truth。

---

## P0-7 Grid hover 工具无法稳定操作

当前：

```text
Block hover
→ 工具出现
→ 鼠标准备移动过去
→ 工具立刻消失
```

第一次实施只要求先把现有工具修到“能点”。

可以用合理方式处理：

```text
hover 区域覆盖 Block + toolbar
延迟隐藏
pointer enter / leave 正确边界
```

不要在这一步对 hover 工具过度设计，因为 P2 会重构 Grid 操作模型。

---

# 5. P1 — Existing Product Logic / UX Fixes

> 与 P0 同一次开发完成。

## P1-1 “你现在有什么？”入口语义

不同名称的入口不能全部执行“新建课程”。

必须检查每个入口的真实设计意图。

如果某个入口对应功能尚不存在：

```text
隐藏
禁用并说明
或合并
```

不要继续伪装成不同入口。

---

## P1-2 课程地图完成度

### 整门课程

允许：

```text
总体进度条
总体完成度
整体待补
```

### 单个课时

取消：

```text
XX%
单课进度条
```

改成更可靠的信息：

```text
待补 3 项
缺素材 1 项
无待补
```

只改展示，不删除底层六维状态。

---

## P1-3 删除按钮

处理两件事：

```text
1. 所有垃圾桶图标正常显示
2. 删除按钮默认视觉与普通按钮体系一致
```

危险性通过：

```text
hover
确认弹窗
文字提示
```

表达，不使用大红背景常驻。

---

## P1-4 课程标题编辑

最终需求：

```text
状态栏中的标题入口可以保留
```

同时：

```text
点击页面顶部课程大标题
→ inline edit
```

建议行为：

```text
Enter / blur 提交
Esc 取消
Autosave
重启后一致
```

---

## P1-5 Placeholder / Requirement 类型选择

新增占位符不能永远只表现为“文字待补”。

属性页应允许选择现有 Domain 已支持的 Requirement 类型。

要求：

```text
正文
结构
待补总览
课程地图
属性页
```

对同一 Requirement 类型保持一致。

如果 Domain 本身没有用户需要的类型：

> 报告，不自行扩 enum。

---

## P1-6 新建 Block 的提示文字必须是真 Placeholder

现在的：

```text
“开始写点什么……”
```

不得作为真实正文写入。

应改成控件 placeholder：

```text
未输入 → 灰色提示
开始输入 → 自动消失
Canonical 中永远不保存提示文案
```

适用于：

```text
正文
标题
引用
代码
其他同类输入 Block
```

---

## P1-7 新建 Block 后右侧自动进入“属性”

点击：

```text
+正文
+标题
+引用
...
```

创建后应：

```text
自动选中该 Block
右侧切到属性页
```

但不要抢走主编辑框输入 focus。

---

## P1-8 状态栏明确“正在修改什么”

当前：

```text
未完成
待审核
待研究
...
```

用户不知道修改对象。

每组控件左侧必须依据真实六维状态 schema 显示：

```text
状态维度 / 修改对象
```

不要凭空发明维度含义。

---

## P1-9 Section / “分区”可理解且可删除

先确认当前 Section 在 Domain / Layout 中的真实语义。

然后：

```text
改成普通用户能理解的名称 / 提示
补充删除 Section
```

不要只根据“分区”这个 UI 名字猜 Domain 含义。

---

## P1-10 Grid 编辑模式门控

未点击：

```text
编辑网格
```

之前，不应允许直接增减行列。

优先：

```text
隐藏行列编辑控件
```

如果保留：

```text
disabled
并提示“请先开启编辑网格”
```

---

# 6. 第一次实施验收门槛 — P0 + P1

第一次实施必须同时完成：

```text
[ ] 项目选择 → 打开项目可以重复执行
[ ] 页面不再频繁自动上弹
[ ] 连续输入不被 autosave / rerender 打断
[ ] 快速收集 modal 可正常输入
[ ] 保存版本 modal 可正常输入
[ ] 导出 modal 不自动关闭
[ ] 显示技术信息有真实响应
[ ] API Key 可保存 / 更新 / 删除
[ ] Drag Handle 可用
[ ] Grid Preview 真实反映布局
[ ] Grid hover 当前功能可稳定点击
[ ] “你现在有什么？”入口语义正确
[ ] 单课不再显示虚假百分比进度条
[ ] 删除图标全部可见
[ ] 删除按钮视觉统一
[ ] 点击课程大标题可编辑
[ ] Requirement 类型可在属性页选择
[ ] Block 提示文字是真 placeholder
[ ] 新建 Block 后右侧进入属性
[ ] 状态栏明确显示修改对象 / 维度
[ ] Section 语义可理解且可删除
[ ] 未进入编辑网格时不能直接改行列
[ ] 自动化测试全绿
[ ] 真实 Desktop 走查通过
```

第一次实施结束时：

```text
V1-T02 = IN PROGRESS
NEXT ACTION = 执行 P2
```

不要提前置 VERIFIED。

---

# 7. P2 — Interaction Redesign

> P2 单独进行第二次实施。

只做以下四项：

```text
1. Provider / Model 配置重构
2. Block 自适应高度体系
3. Flow 承担顺序调整职责
4. Grid 交互模型重构
```

---

## P2-1 Provider / Model 配置重构

不再维护容易过时的硬编码模型列表。

目标：

```text
用户输入 Base URL
+
API Key
↓
Workbench 尝试读取模型列表
↓
用户按需选择 Model
```

推荐流程：

```text
新增 / 编辑 Provider
→ Base URL
→ API Key
→ 读取模型
→ 用户选择
→ 保存
```

由于并非所有兼容 API 都稳定支持模型枚举：

```text
必须保留手动输入 Model ID fallback
```

API Key 继续只进入系统级安全凭据存储。

现有 Connector / transport 不无必要重写。

---

## P2-2 Block 自适应高度体系

取消当前：

```text
外框
└── 内部又有一个可手动 resize / 带滚动条的输入框
```

最终：

```text
Block 外框
= 唯一尺寸容器
= 内容增长容器
= 最终滚动容器
```

### 短内容型 Block

例如：

```text
标题
引用
其他短表达 Block
```

规则：

```text
默认 Small
内容增加：Small → Medium
继续增加：保持 Medium，外框出现滚动条
内容减少：Medium → Small
```

明确：

```text
短内容 Block 永远不进入 Large
```

### 长内容型 Block

```text
正文
代码
```

规则：

```text
默认 Medium
内容增加：Medium → Large
继续增加：保持 Large，外框出现滚动条
内容减少：Large → Medium
```

明确：

```text
最低不小于 Medium
```

### Remove Inner Resize

取消：

```text
textarea 手动 resize
内部独立滚动框
```

滚动统一由 Block 外框承担。

---

## P2-3 顺序调整职责迁移到 Flow

目标职责：

```text
结构
= 查看结构 / 定位
```

```text
排版 → Flow
= 调整 Block 先后顺序
```

把“上移 / 下移”主要入口迁到 Flow。

关键规则：

```text
Flow 改的是 Canonical Block order
```

绝不能出现：

```text
结构一套顺序
Flow 一套顺序
Preview 第三套顺序
```

结构页可以继续显示顺序与定位，但不保留重复、同等显眼的上下移动入口。

---

## P2-4 Grid Interaction Redesign

### 未上画布 Block

区域：

```text
还没有放进网格的正文
```

操作：

```text
左键点击 Block
→ Block 上 Grid
```

初始位置必须确定、可预测，例如第一个可用 Cell。

### Grid 上 Block — 移出

```text
右键点击
→ 移出网格
→ 回到“还没有放进网格的正文”
```

### Grid 上 Block — 移动

```text
左键点击 Grid Block
→ 进入选中 / 待移动状态
→ 可放置 Cell 高亮
→ 点击目标 Cell
→ Block 直接跳过去
```

必须明确反馈：

```text
当前移动哪个 Block
哪些 Cell 可放
当前 Cell 在哪里
```

并支持取消移动状态。

### Remove Direction Micro-controls

新交互成立后取消：

```text
↑ ↓ ← →
```

作为核心移动方式。

### Size Controls

原有“加宽 / 加高 / 没有减宽减高”不应简单补成更多 hover 按钮。

如果需要保留 resize：

> 设计成选中 Block 后稳定、明确的尺寸控制，不再依赖短暂 hover 小按钮群。

本任务必须完成：

```text
上画布
下画布
点击目标 Cell 移动
```

尺寸控制在不回归现有能力前提下合理收口。

---

# 8. P2 验收门槛

第二次实施必须满足：

```text
[ ] Provider 可输入 Base URL
[ ] API Key 仍走系统凭据
[ ] 可尝试自动读取 models
[ ] models 读取失败时可手动输入 Model ID
[ ] 不依赖容易过期的硬编码模型列表
[ ] 短内容 Block：Small ⇄ Medium → Scroll
[ ] 长内容 Block：Medium ⇄ Large → Scroll
[ ] 内容减少时 Block 自动收缩
[ ] 取消内部手动 resize
[ ] Flow 成为显式顺序调整入口
[ ] Flow 修改 Canonical order
[ ] 结构 / Preview 与 Flow 顺序一致
[ ] 未放置 Block 左键上 Grid
[ ] Grid Block 右键下 Grid
[ ] Grid Block 左键进入移动状态
[ ] 可放置 Cell 高亮
[ ] 点击目标 Cell 后直接移动
[ ] ↑↓←→ 不再作为核心移动方式
[ ] Grid 保存 / 重启后一致
[ ] 自动化测试全绿
[ ] 真实 Desktop 走查通过
[ ] P0/P1 无回归
```

---

# 9. Explicitly Deferred — 本任务不做

以下不按本轮 Bug 处理：

## 完整 Project Settings

不新增成熟项目设置中心。

## Stage CRUD

本轮不新增：

```text
新增同级阶段
删除阶段
阶段重命名
完整 Stage CRUD
```

## Workbench 自有文件格式

本轮不设计：

```text
.acw
单文件课程容器
双击文件关联
```

继续使用：

```text
项目文件夹
└── project.json
```

## macOS Public Release

本轮不执行：

```text
Developer ID
Notarization
GitHub Release
公开 DMG
直接下载链接
```

先完成真实使用修复。

---

# 10. Regression Protection

不得破坏：

```text
Project Lock
Autosave
Recovery
External Modification Detection
Browser Session
Native Session
Suggestion → ChangeDraft → Diff → Apply
Undo / Redo
Asset / Usage
Requirement
Preview
Export / Publish
Keychain security boundary
```

---

# 11. Automated Verification

至少执行：

```text
deno task check
deno task test
cargo test
cargo build
```

如仓库当前正式流程允许，再运行：

```text
cargo tauri build --debug
```

不要写死测试数量。

要求：

```text
旧测试继续通过
新问题补真正能抓住回归的测试
```

---

# 12. Required Regression Tests

至少覆盖：

## Project Picker

```text
open A → home → open B
open A → home → open A
```

## Focus / Modal

```text
input 不因保存事件被替换
modal 内 input 不触发 close
modal 内容点击不触发 outside-close
autosave 不改变当前 editor identity
```

## Placeholder

```text
提示文字不进入 Canonical
```

## Course Title

```text
inline edit → commit → reload
```

## Requirement Type

```text
属性修改类型 → 所有投影一致
```

## Grid Preview

```text
row / col / span → Preview 一致
```

## P2 Model Discovery

```text
models 成功
models 失败
手动 Model ID fallback
```

## P2 Block Height

```text
short: Small → Medium → Scroll
long: Medium → Large → Scroll
内容减少自动收缩
```

## P2 Flow / Grid

```text
Flow reorder → Canonical order
Grid place → layout position
Grid remove → unplaced
Grid target click → deterministic relocation
```

---

# 13. Real Desktop Verification — 第一次实施（P0 + P1）

必须在真实 Tauri Desktop 中走查：

```text
1. 启动
2. 打开项目 A
3. 返回项目选择
4. 再次打开 A
5. 返回项目选择
6. 打开项目 B
7. 连续输入一段中文正文
8. 等待 Autosave，输入不中断
9. 快速收集弹窗连续输入并提交
10. 保存版本弹窗输入并提交
11. 导出窗口保持打开
12. “显示技术信息”有真实响应
13. 配置 API Key
14. Drag Handle 重排
15. Grid 排版
16. Preview 检查 Grid
17. 创建 Placeholder 并改类型
18. 新建 Block 检查 placeholder
19. 点击课程大标题改名
20. 状态栏能看懂修改对象
21. Grid 编辑模式门控正常
```

第一次实施后：

```text
V1-T02 仍 IN PROGRESS
```

不要恢复成首次安装状态，因为还要继续 P2。

---

# 14. Real Desktop Verification — 第二次实施（P2）

至少验证：

```text
1. Base URL + API Key 配置
2. 自动读取 models
3. 选择 Model
4. 手动 Model ID fallback
5. 正文：Medium → Large → Scroll → 收缩
6. 标题 / 引用：Small → Medium → Scroll → 收缩
7. 无内部手动 resize
8. Flow 调整 Block 顺序
9. 结构 / Preview 同步
10. 未上 Grid Block 左键上画布
11. Grid Block 右键下画布
12. Grid Block 左键进入移动状态
13. 可用 Cell 高亮
14. 点击目标 Cell 后直接移动
15. 不再依赖 ↑↓←→ 微按钮
16. 保存
17. 关闭
18. 重启
19. 布局与顺序一致
```

---

# 15. V1-T02 最终 Definition of Done

只有同时满足：

```text
P0 + P1 第一次实施完成
+
P2 第二次实施完成
+
自动化全绿
+
真实 Desktop 回归通过
+
无关键回归
+
总控回写
```

才允许：

```text
V1-T02 = VERIFIED
```

---

# 16. Git Discipline

开工前：

```text
git status
git branch
git log -1
```

任务结束：

```text
git status
git diff
未跟踪文件
测试结果
```

不得提交：

```text
API Key
Keychain 数据
用户真实课程
临时日志
测试导出
session
recovery fixture
```

---

# 17. 第一次实施 Interim Report

第一次实施结束：

```text
# V1-T02 Interim Report — P0 + P1

## Control Position
V1-T02 = IN PROGRESS

## Root Cause Findings
...

## P0 Completed
...

## P1 Completed
...

## Automated Verification
...

## Real Desktop Verification
...

## Remaining
P2

## Blockers
...

## NEXT ACTION
执行 V1-T02 的 P2 交互重构
```

---

# 18. 最终 Completion Report

```text
# Task Completion Report — V1-T02

## 1. Control Position
Version:
Task:
Previous Status:
Current Status:

## 2. Original Goal
...

## 3. P0 Completed
...

## 4. P1 Completed
...

## 5. P2 Completed
...

## 6. Root Causes
focus / modal / autosave:
project picker:
other:

## 7. Functional Changes
...

## 8. Automated Verification
deno task check:
deno task test:
cargo test:
cargo build:
tauri build:

## 9. Real Desktop Verification
...

## 10. Regression
V0-T01:
V0-T02:
V0-T03:
V0-T04:
V1-T01:

## 11. Open Blockers
...

## 12. Deferred
Project Settings:
Stage CRUD:
Workbench file format:
macOS Public Release:

## 13. Git Status
...

## 14. MASTER CONTROL UPDATE
Updated / Not Updated

## 15. Final Product State
...

## 16. NEXT ACTION
PAUSE FEATURE DEVELOPMENT
```

---

# 19. Master Control Update

开工时更新：

```text
Last Updated
Current Position
Current Task
NEXT ACTION
Change Log
```

第一次实施结束：

```text
V1-T02 = IN PROGRESS
P0/P1 = completed
NEXT ACTION = P2
```

最终结束：

```text
V1-T02 = VERIFIED
OPEN BLOCKERS = NONE
NEXT ACTION = PAUSE FEATURE DEVELOPMENT
```

---

# 20. No Automatic V1-T03

本任务完成后不要自动创建：

```text
V1-T03
```

包括此前的 macOS Distribution / Public Release，也必须等用户再次明确批准后才编号与启动。

---

# 21. Final Success Condition

本任务真正成功不是“21 条反馈分别改了一点”。

而是：

> **Workbench 可以连续操作，不会因为保存、重渲染或弹窗而打断用户；已有 Authoring 能力符合直觉；Provider、Block、Flow、Grid 进入更稳定、更高效的交互模型。**

最终应真实跑通：

```text
打开项目
→ 返回项目选择
→ 再打开项目
→ 连续输入
→ Autosave
→ 弹窗编辑
→ AI 配置
→ Block 编辑
→ Flow 排序
→ Grid 上 / 下 / 移动
→ Preview
→ 保存
→ 重启
→ 继续工作
```

达到后：

```text
V1-T02 = VERIFIED
NEXT ACTION = PAUSE FEATURE DEVELOPMENT
```
