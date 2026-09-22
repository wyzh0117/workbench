# V1-T01 — V0 Hardening & UX Polish

> AI Course Workbench  
> V1 第一个平铺任务 / V0 收口、交互清理与真实使用准备  
> 本任务完成后暂停新增功能，进入实际使用（Dogfooding）观察期。

---

# 0. Agent 启动口令

开始任何修改前：

> **先完整阅读 `PROJECT_MASTER_CONTROL.md` 和 `README.md`。不要重新规划版本，不要创建新的 Milestone，不要拆出 V1-T01-A / V1-T01.1 / Patch Phase 等新层级。确认 Current Version、Current Task、Definition of Done 和 NEXT ACTION 后，只执行本任务。任务结束后输出 Completion Report，并同步回写 `PROJECT_MASTER_CONTROL.md`。**

本任务是用户在 V0 CLOSED 后明确批准启动的第一个 V1 任务。

因此开工时必须先把总控状态从：

```text
CURRENT VERSION
V0（已 CLOSED）

CURRENT TASK
无

V1
NOT ACTIVE
```

更新为：

```text
CURRENT VERSION
V1（ACTIVE）

CURRENT TASK
V1-T01 — V0 Hardening & UX Polish

CURRENT STATUS
IN PROGRESS
```

并同步更新 README 中与当前开发状态有关的表述。

---

# 1. Control Position

```text
Previous Version State:
V0 = CLOSED

V0-T01 = VERIFIED
V0-T02 = VERIFIED
V0-T03 = VERIFIED
V0-T04 = VERIFIED

Current Version:
V1

Current Task:
V1-T01 — V0 Hardening & UX Polish

Initial Task Status:
READY → IN PROGRESS
```

本任务不是重新打开 V0，也不是新增一个 V0.1 / V0-Fix 阶段。

它是：

> **V1 的第一个平铺任务：在开始效率型新功能之前，把已经完成的 Workbench 本体收拾到可以直接长期使用的状态。**

---

# 2. Why This Task Exists

V0 已经证明 Workbench 的核心链路可以真正工作：

```text
建立 / 打开课程
→ 课程地图
→ 单课编辑
→ 正文 / 结构 / 素材 / Flow / Grid
→ Requirement / Placeholder / 待补
→ Autosave / Recovery / Lock / External Change Protection
→ AI Suggestion / ChangeDraft / Diff / Apply
→ Preview
→ Output & Publish
```

当前没有 V0 BLOCKER。

但在连续开发和真实验收过程中，仍保留了一批：

```text
状态一致性粗糙处
浏览器会话缺口
系统级凭据持久化缺口
重复 UI 交互
视觉对齐问题
工程化解释文案
测试 / 调试残留状态
```

如果此时直接继续做模板、批量操作、跨课程复用、高级搜索等新能力，
这些问题会被继续叠加，后续修改成本更高。

所以 V1-T01 的目标不是“加功能”，而是：

> **把 V0 已完成的能力收口为一个干净、稳定、符合普通用户习惯、可以直接实际使用一段时间的 Workbench。**

---

# 3. North Star Alignment

本任务必须继续服从项目 North Star：

> **面向非技术用户、本地优先、可以长期维护课程内容，并允许 AI 深度参与但不夺走用户控制权的课程生产工作台。**

判断标准不是：

```text
代码是不是更复杂
架构是不是更“完整”
有没有顺手多加几个功能
```

而是：

```text
用户是否更不容易迷路
用户是否更不容易误操作
项目状态是否更一致
凭据是否更安全
界面是否更符合常见习惯
解释是否更容易看懂
软件是否可以像正式安装后一样直接开始使用
```

---

# 4. Scope Rules

本任务只处理本文件明确列出的收口项。

每当准备增加额外功能时，先问：

> **如果不做这件事，V1-T01 还能达到 Definition of Done 吗？**

如果答案是“能”：

```text
→ 放入 Backlog
→ 本任务不做
```

---

# 5. Explicit Non-Goals

V1-T01 **禁止顺手加入**：

```text
模板体系
跨课程复用
批量编辑
高级搜索
内容审计体系
更多 AI Provider
新的 MCP / Skill 工作流
新的发布平台
新的 Output 格式
AI 流式逐字体验升级
新的课程结构能力
新的素材类型
协作功能
插件生态
Orchestrator
Windows 端适配
```

除非其中某项被证明是完成本任务 DoD 的直接 BLOCKER，否则不得扩展。

本任务也不得：

```text
重新定义 V1
重新拆 V1 的完整路线
提前创建大量 V1-T02 / T03 / T04...
创建新的 Milestone
```

---

# 6. Required Execution Order

必须按照以下顺序推进：

```text
1. 项目切换状态机
2. 系统级密钥保存
3. 浏览器刷新 / 会话恢复
4. 重复 UI 交互清理
5. 全局 UI 对齐
6. 全局解释文案大白话化
7. 自动化 + 真实 Desktop 回归
8. 清理全部测试 / 调试残留
9. 恢复“全新安装 / 首次启动”状态
10. 再做一次干净启动验收
11. 回写总控
12. STOP FEATURE DEVELOPMENT
```

原因：

- 1–3 会影响真实状态与数据边界；
- 4 会改变交互结构；
- 5–6 必须在功能与交互冻结后统一清扫；
- 8–9 必须是最后动作，否则后续测试又会重新制造脏数据。

---

# 7. Work Item 1 — Project Switch State Consistency

## 7.1 Existing Problem

当前已知行为：

切换项目时，`openProject` 会短暂把 session 写成：

```text
新目录
+
旧 project_id
+
旧阅读位置
```

之后 `restoreSession` 依赖 `project_id` 不匹配来阻止恢复错误位置。

当前实现虽然有守卫，风险有限，但它仍然属于：

> **先产生不一致状态，再依靠后续逻辑阻止错误扩散。**

V1-T01 必须把这个状态机真正做干净。

## 7.2 Required Outcome

任意时刻持久化的 session：

```text
project_dir
project_id
current_course / lesson
current_mode
right_panel
route / view
selection
```

如果存在，就必须来自 **同一个项目**。

不能再出现：

```text
新项目目录 + 旧项目身份 / 旧阅读位置
```

作为正常切换流程的一部分。

## 7.3 Constraints

不得通过以下方式“修复”：

```text
简单删除现有写 session 步骤
```

因为历史验证已经确认：

如果新目录没有先正确进入会话 / 内存状态，
`loadSession` 可能重新采纳旧目录，
反而存在把新项目行为带回旧项目目录的风险。

因此必须：

> **重构项目切换状态机 / session transition，使切换成为明确的、一致的状态过渡。**

建议方向（不是强制实现细节）：

```text
old project
↓
flush / release
↓
enter SWITCHING state
↓
open new directory
↓
read canonical identity
↓
construct new coherent session
↓
commit new active project + session
↓
restore only if saved session belongs to the same project
```

## 7.4 Acceptance

至少验证：

```text
A → B
B → A
A → invalid path
A → locked project
A → project with saved reading position
切换后立即保存
切换后立即关闭
切换后重启
```

不得发生：

```text
错误目录
错误 project_id
旧项目阅读位置污染新项目
silent overwrite
继续工作入口被错误清空
```

---

# 8. Work Item 2 — System-Level Credential Storage

## 8.1 Goal

当前 AI 密钥已经满足：

```text
不进入 project.json
不进入 Canonical
不进入导出包
不进入诊断包
页面拿不到
```

V1-T01 进一步要求：

> **API Key 可以由 Workbench 在系统级安全存储中保存，而不是主要依赖临时进程注入。**

## 8.2 Security Boundary

凭据不得进入：

```text
project.json
project.bak
Canonical
session.json
AI context packs
executions.json
diagnostics.log
完整项目包
Project JSON export
HTML / Markdown / PDF / Web 输出
页面 DOM / 前端可枚举状态
普通日志
错误正文
```

## 8.3 Required User Actions

至少支持：

```text
保存密钥
判断是否已配置
更新密钥
删除密钥
切换 Provider 后正确使用对应凭据
```

页面只应该知道类似：

```text
configured: true / false
```

而不是拿到明文密钥。

## 8.4 UX

不要暴露工程化说明。

用户应看到类似：

```text
DeepSeek：已配置
OpenAI：未配置

保存密钥
更新密钥
删除密钥
```

失败时说明：

```text
发生了什么
现在能不能继续
下一步应该怎么做
```

## 8.5 Security Verification

必须主动检查：

```text
项目目录
应用数据目录中的普通日志
执行记录
诊断包
导出包
前端状态
错误信息
```

确认无密钥泄漏。

---

# 9. Work Item 3 — Browser Refresh Session Persistence

## 9.1 Existing Problem

桌面壳已经验证：

```text
关闭
→ 重启
→ 恢复上次项目 / 课程 / 模式 / 面板 / 视图
```

但浏览器审查壳当前的阅读位置只存在页面内存。

因此：

```text
刷新页面
→ 会丢失阅读位置
→ 回到初始化 / 初始页面
```

## 9.2 Goal

浏览器端刷新后：

```text
当前项目
当前课
主要工作模式
主要视图 / 面板
```

应恢复到合理位置。

至少不能：

> **每次刷新都像第一次打开 Workbench 一样重新进入初始化页。**

## 9.3 Constraints

浏览器会话不是 Canonical Truth。

它只能保存：

```text
“我上次看到哪里”
```

不能成为：

```text
课程正文
课程结构
素材
Requirement
Canonical identity
```

的第二真相。

## 9.4 Acceptance Flow

真实浏览器验证：

```text
打开项目
→ 进入某一课
→ 切换到指定视图 / 面板
→ 刷新
→ 项目仍正确
→ 回到合理阅读位置
→ 编辑并保存
→ 再刷新
→ 数据一致
```

同时验证：

```text
项目已不存在
目录不可访问
会话损坏
session 指向旧 project_id
```

都不能造成错误项目写入或白屏。

---

# 10. Work Item 4 — Remove Duplicate UI Interactions

## 10.1 Principle

同一个基础交互不能在界面不同位置放两套功能完全相同、
但语义关系不清楚的按钮。

尤其：

> **侧边栏的折叠 / 展开按钮应该和侧边栏本身绑定。**

用户看到按钮时，应自然理解：

```text
这个按钮控制旁边这个区域
```

而不是：

```text
页面顶部一个按钮
+
侧栏自身一个按钮
=
做同一件事
```

## 10.2 Left Sidebar

当前左侧栏折叠 / 展开存在重复入口。

要求：

### 保留

```text
与左侧栏本身绑定的折叠 / 展开控制
```

### 原本位于非侧栏区域、但执行左栏折叠的重复按钮

改为：

> **返回软件默认主页 / 项目选择页**

用途：

```text
返回默认首页
重新选择 / 打开其他项目文件夹
```

它必须拥有清楚、独立的语义。

不得继续兼做左侧栏折叠。

## 10.3 Right Sidebar

当前右侧栏折叠 / 展开存在重复入口。

要求：

### 保留

```text
与右侧栏本身绑定的折叠 / 展开控制
```

### 非侧栏位置的重复按钮

```text
直接取消
```

不要为了“保持左右对称”而保留无必要控件。

## 10.4 Global Duplicate Interaction Audit

不要只修这两个按钮。

在不扩展范围的前提下，快速检查核心界面是否还存在：

```text
两个明显位置执行完全相同动作
两个按钮只有图标不同但功能相同
同一操作在邻近区域重复出现且无独立语义
```

发现后判断：

```text
是否明显破坏基础交互一致性？
```

若是：

```text
本任务内收口
```

若只是“未来可以优化”：

```text
Backlog
```

---

# 11. Work Item 5 — Global UI Alignment Pass

> 这一项必须在 Work Item 1–4 稳定后执行。

## 11.1 Goal

对主要 Workbench UI 做一次全局视觉清扫。

重点不是重新设计 UI，而是修复明显不统一：

```text
文字垂直未对齐
按钮文字偏上 / 偏下
相邻按钮高度不一致
图标与文字基线不一致
标签 padding 不一致
同类状态文本行高不同
输入框与按钮不齐
左右栏标题区域不齐
弹窗 footer / header 对齐粗糙
```

## 11.2 Core Surfaces

至少检查：

```text
默认主页 / 项目选择
课程地图
单课编辑器
左侧栏
右侧栏
正文
结构视图
Flow
Grid
素材库
Requirement / 待补
Preview
AI 助手
Diff / Review
发布与导出中心
弹窗
Toast
状态栏
启动 / 错误页
```

## 11.3 Constraint

不要以 UI 清扫为理由重做设计系统。

原则：

> **修明显不齐，不重新设计产品。**

---

# 12. Work Item 6 — Plain-Language Explanatory Copy

> 这一项同样必须在功能与交互冻结之后统一执行。

## 12.1 Goal

所有面向普通用户的解释性备注：

> **尽量写成大白话。**

用户不应该需要理解内部架构才能知道下一步做什么。

## 12.2 Preferred Pattern

优先：

```text
发生了什么
↓
现在能不能继续
↓
下一步做什么
```

少写：

```text
canonical validation failed
native bridge unavailable
session identity mismatch
transport error
projection invalid
```

除非这些信息出现在：

```text
开发者诊断
日志
可展开的技术详情
```

普通界面应转换成用户语言。

## 12.3 Example Direction

工程化：

```text
Session project_id mismatch. Restore skipped.
```

面向用户：

```text
这个项目没有恢复上次的阅读位置。
课程内容没有受影响，你可以继续使用。
```

工程化：

```text
MISSING_CREDENTIAL
```

面向用户：

```text
还没有为 DeepSeek 保存 API Key。
保存后再试一次。
```

## 12.4 Surfaces

至少检查：

```text
错误提示
空状态
说明文字
Tooltip
AI 错误
导出前检查
锁冲突
外部修改
Recovery
素材异常
浏览器恢复
保存异常
项目打开失败
```

## 12.5 Constraint

不要为了“大白话”删除重要信息。

正确结构可以是：

```text
主提示：大白话
展开详情：技术原因 / 错误码
```

---

# 13. Work Item 7 — Remove Test / Debug Residue and Restore Fresh-Install State

> **这是本任务最后一个产品动作。所有功能测试完成后才能执行。**

## 13.1 Goal

V1-T01 验收完成后：

> **让 Workbench 处于像刚刚全新安装、第一次启动一样的状态。**

用户接下来会亲自实际使用一段时间。

因此不得把开发 / 验收过程中制造的内容留给用户。

## 13.2 Must Remove

清理所有仅用于开发、测试或验收的：

```text
测试课程
临时项目
测试素材
测试 Requirement
测试 Placeholder
AI Fake Provider 生成的示例内容
测试 Suggestion
测试 ChangeDraft
测试 publication
测试 execution record
临时 diagnostics
调试状态
用于走查的 session
测试 recent project
测试 recovery 数据
测试导出产物
临时锁 / 无效租约残留
其他明显的验收夹具
```

同时检查项目代码中是否存在：

```text
只为手工验收临时加入、但不属于正常产品行为的占位符 / Debug UI
```

如存在则移除。

## 13.3 Do NOT Delete

不要误删：

```text
正式默认配置
合法用户配置
必要系统目录
正常首次启动所需文件
产品真实功能中的 Placeholder 能力
测试代码本身
自动化测试夹具源码
```

注意：

> “清理占位符”指清理 **测试 / 调试产生的占位内容**，不是删除产品的 `Placeholder` 功能。

## 13.4 Fresh-Install Experience

最终启动时应呈现：

```text
没有测试项目自动打开
没有测试 recent card
没有测试课程
没有测试 AI 记录
没有测试发布记录
没有开发提示残留
没有调试数据自动加载
```

用户看到的是：

> **正常的软件默认主页 / 首次使用入口。**

并且可以：

```text
新建 / 选择 / 打开真实项目
```

---

# 14. Testing Strategy

本任务仍然坚持：

> **DONE ≠ VERIFIED**

---

# 15. Automated Gates

至少执行当前仓库已有的正式 gate：

```text
deno task check
deno task test
cargo test
cargo build
```

如果仓库当前正式流程使用：

```text
cargo tauri build --debug
```

则最终验收也必须使用最终构建产物，而不是只在 dev server 中通过。

不得为了让测试绿：

```text
删除有效测试
弱化关键断言
跳过真实失败路径
把错误改成吞掉
```

---

# 16. Required Real Runtime Verification

## 16.1 Desktop

真实 Tauri Desktop 至少完成一次定向走查：

```text
启动
→ 默认主页
→ 打开项目 A
→ 跳到某课 / 某视图
→ 切换到项目 B
→ 验证 B 没继承 A 的 id / 阅读位置
→ 返回默认主页
→ 再打开项目
→ AI Provider 保存 / 更新 / 删除凭据
→ AI 调用或缺凭据状态符合预期
→ 保存
→ 关闭
→ 重启
→ 恢复正确状态
```

同时验证：

```text
左栏折叠只由左栏自己的控件控制
左侧原重复按钮现在返回默认主页
右栏折叠只由右栏自己的控件控制
右侧原重复按钮已取消
```

## 16.2 Browser

真实浏览器至少完成：

```text
打开项目
→ 进入某课
→ 切换视图
→ 刷新
→ 恢复正确项目 / 阅读位置
→ 修改
→ 保存
→ 再刷新
→ 数据一致
```

## 16.3 Fresh-Install Final Pass

在清理测试 / 调试残留之后，最后再启动一次最终构建。

验证：

```text
启动即为干净默认主页
无测试 recent project
无测试课程
无测试 AI / publication / recovery 内容
可以正常选择真实项目
核心 UI 正常
```

这次检查之后：

> **不要再创建新的测试项目污染最终状态。**

如必须继续验证，应使用不会污染最终用户状态的隔离临时环境。

---

# 17. Definition of Done

只有全部满足才允许：

```text
V1-T01 = VERIFIED
```

---

## 17.1 State Consistency

```text
[ ] 项目切换过程中不再持久化“新目录 + 旧 project_id / 旧阅读位置”
[ ] A → B → A 状态正确
[ ] 切换后保存 / 关闭 / 重启一致
[ ] lock / invalid path / missing project 不导致错误清 session
[ ] 不发生 silent overwrite
```

---

## 17.2 Credential Storage

```text
[ ] 系统级安全保存 API Key
[ ] 支持保存 / 更新 / 删除
[ ] Provider 切换读取正确
[ ] 前端拿不到明文
[ ] project.json / Canonical 无密钥
[ ] logs / executions / diagnostics / exports 无密钥
[ ] 缺密钥 / 已配置状态对用户可理解
```

---

## 17.3 Browser Session

```text
[ ] 浏览器刷新不再重置回初始化页面
[ ] 当前项目恢复正确
[ ] 主要阅读位置恢复正确
[ ] session 不成为第二套课程真相
[ ] stale / invalid session 有安全降级
```

---

## 17.4 UI Interaction

```text
[ ] 左侧栏折叠按钮与左侧栏本身绑定
[ ] 右侧栏折叠按钮与右侧栏本身绑定
[ ] 左侧原重复折叠按钮改为“返回默认主页 / 项目选择”
[ ] 右侧原重复折叠按钮取消
[ ] 核心界面无明显重复基础交互
```

---

## 17.5 UI Polish

```text
[ ] 核心界面完成一轮对齐检查
[ ] 同类按钮高度 / padding / baseline 基本一致
[ ] 图标与文字无明显错位
[ ] 状态文本 / 标签 / 输入控件无明显未对齐
[ ] 未借机大规模重做 UI
```

---

## 17.6 Plain Language

```text
[ ] 核心解释性备注完成一轮大白话检查
[ ] 主要错误提示说明“发生了什么”
[ ] 需要时说明“现在能不能继续”
[ ] 需要时说明“下一步做什么”
[ ] 技术细节保留在日志或可展开详情，不强塞给普通用户
```

---

## 17.7 Regression

```text
[ ] deno task check 通过
[ ] deno task test 全部通过
[ ] cargo test 全部通过
[ ] cargo build 通过
[ ] 最终 Tauri 构建通过
[ ] T01 Desktop 基础闭环无回归
[ ] T02 Course Authoring 无回归
[ ] T03 AI Workflow 无回归
[ ] T04 Output & Publish 无回归
[ ] Web Workbench 无关键回归
```

---

## 17.8 Fresh State

```text
[ ] 测试 / 调试课程已清理
[ ] 测试 / 调试素材已清理
[ ] 测试 Requirement / Placeholder 已清理
[ ] 测试 AI / publication / recovery / recent 状态已清理
[ ] 最终启动为正常默认主页
[ ] 软件表现为“全新安装 / 首次使用”状态
[ ] 干净启动后核心入口可用
```

---

## 17.9 Project Control

```text
[ ] BLOCKER = NONE
[ ] README 已更新
[ ] PROJECT_MASTER_CONTROL.md 已更新
[ ] Change Log 已追加
[ ] V1-T01 = VERIFIED
[ ] NEXT ACTION 没有自动创建 V1-T02
```

---

# 18. Final Product State After Verification

V1-T01 完成后，不立即推进新的 V1 功能。

总控建议写为：

```text
CURRENT VERSION
V1（ACTIVE）

CURRENT TASK
V1-T01 — V0 Hardening & UX Polish

CURRENT STATUS
VERIFIED

PRODUCT STATE
DOGFOOD READY

OPEN BLOCKERS
NONE

NEXT ACTION
PAUSE FEATURE DEVELOPMENT
用户进入实际使用观察期；
收集真实使用问题后，再由用户决定是否制定 V1-T02。
```

注意：

> **Dogfooding 是产品使用状态，不是新的产品阶段 / Milestone。**

不得创建：

```text
Dogfood Phase
V1-Dogfood
V1.1
V1-T01A
```

---

# 19. After This Task

默认行为：

```text
STOP FEATURE DEVELOPMENT
```

不要自动：

```text
制定 V1-T02
实现模板
做批量操作
做高级搜索
升级 AI
扩发布平台
```

用户会先实际使用 Workbench 一段时间。

只有用户明确提出继续开发时：

```text
回看真实使用反馈
↓
检查 Backlog
↓
判断哪些问题具有真实产品优先级
↓
再决定 V1-T02
```

---

# 20. Backlog Handling

本任务中发现的新问题：

### 如果阻止本 Task DoD

```text
→ Open Blocker
→ 当轮解决
```

### 如果不阻止 DoD

```text
→ Backlog
→ 不顺手做
```

任务结束前统一检查一次：

```text
是否必须在用户实际使用前修复？
```

只有答案明确为“是”，才允许并入 V1-T01。

---

# 21. Git / Repository Closure

任务结束前至少检查：

```text
git status
当前 branch
未跟踪文件
测试 / 调试生成物
临时导出文件
临时日志
临时 fixture
```

要求：

```text
不把用户本地敏感数据提交进仓库
不把 API Key 提交进仓库
不把测试导出物误提交
不把临时项目误提交
不把系统级凭据存储数据提交
```

最终工作区状态应清楚、可解释。

---

# 22. Required Completion Report

任务结束必须输出以下结构：

```text
# Task Completion Report — V1-T01

## 1. Control Position

Version:
Task:
Previous Status:
Current Status:

## 2. Original Goal

...

## 3. Completed

...

## 4. Seven Closure Items

1. Browser refresh / session:
2. UI alignment:
3. Plain-language copy:
4. Project switch state consistency:
5. System-level credential storage:
6. Duplicate UI interaction cleanup:
7. Fresh-install cleanup:

## 5. Automated Verification

deno task check:
deno task test:
cargo test:
cargo build:
cargo tauri build:

## 6. Real Desktop Verification

...

## 7. Browser Verification

...

## 8. Fresh-Install Verification

...

## 9. Security Verification

Credential leakage check:
Logs:
Diagnostics:
Exports:
Canonical:

## 10. Open Blockers

...

## 11. Backlog

...

## 12. Git Status

...

## 13. MASTER CONTROL UPDATE

Updated / Not Updated

## 14. Final Product State

DOGFOOD READY / NOT READY

## 15. NEXT ACTION

PAUSE FEATURE DEVELOPMENT
or
Continue V1-T01 because ...
```

如果：

```text
MASTER CONTROL UPDATE = Not Updated
```

则任务不得视为完成交接。

---

# 23. Required Master Control Update

任务完成后至少更新：

```text
Last Updated
Current Position
Current Task
V1 Task Board（如总控开始记录 V1 Task Board）
Done
Open Blockers
Definition of Done
Next Action
Change Log
Current Summary
```

不要重新打开 V0。

不要修改：

```text
V0-T01 = VERIFIED
V0-T02 = VERIFIED
V0-T03 = VERIFIED
V0-T04 = VERIFIED
V0 = CLOSED
```

除非发现了会推翻历史 VERIFIED 结论的重大事实性问题；
普通 V1 修补不应篡改历史状态。

---

# 24. Final Success Condition

V1-T01 的最终成功不是：

> “又完成了一轮开发。”

而是：

> **用户拿到一个没有测试痕迹、不会因刷新或切项目轻易迷路、凭据保存安全、交互不重复、界面基本整齐、说明容易看懂，可以直接开始真实课程制作并连续使用一段时间的 Workbench。**

达到这个状态后：

```text
V1-T01 = VERIFIED
PRODUCT STATE = DOGFOOD READY
NEXT ACTION = PAUSE FEATURE DEVELOPMENT
```

然后停止继续加功能，等待真实使用反馈。
