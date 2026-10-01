# AI Course Workbench — V1-T03 + V1-T04 Combined Development Package

> **当前基线**：V1-T01 = VERIFIED；V1-T02 = VERIFIED；产品状态 = DOGFOOD READY。  
> **本次执行方式**：在一次连续开发中依次完成两个平铺任务：
>
> ```text
> V1-T03 — Course Authoring & Project Structure Closure
>        ↓
> V1-T04 — Workspace Explorer & Existing-Folder Adoption
> ```
>
> 两个任务仍然是平级 Task，不创建新的 Milestone、Phase 或子任务层级。  
> T03 必须先完成并达到 VERIFIED，再切换总控到 T04；T04 完成后统一结束本轮开发。

---

# 0. Agent 启动口令

开始任何修改前，完整阅读：

```text
1. PROJECT_MASTER_CONTROL.md
2. README.md
3. 本任务文档
4. V1-T02 §35 / §36 的完成记录
5. 相关 Authoring / Project / Asset / Session / Grid / Import 代码
```

并先确认：

```text
V0 = CLOSED
V1 = ACTIVE
V1-T01 = VERIFIED
V1-T02 = VERIFIED
```

当前总控仍写：

```text
NEXT ACTION = PAUSE FEATURE DEVELOPMENT
```

这是因为在 V1-T02 结束时尚未收到新的真实使用反馈。

用户现在已经明确批准：

```text
启动 V1-T03
并在 T03 VERIFIED 后
继续执行 V1-T04
```

因此本任务文档即为新的用户批准依据。

---

# 1. Project Control Discipline

本次允许在一次开发流程中执行两个任务，但不得把它们合并成新的产品层级。

允许：

```text
V1-T03
V1-T04
```

禁止：

```text
V1-T03+04（作为正式 Task ID）
V1-T03-A
V1-T03.1
V1-T04-Phase-2
Authoring Milestone
Explorer Milestone
```

---

# 2. Required MASTER CONTROL Transition

## 2.1 开工时

Agent 开始编码前，将总控更新为：

```text
CURRENT VERSION
V1（ACTIVE）

CURRENT TASK
V1-T03 — Course Authoring & Project Structure Closure

CURRENT STATUS
IN PROGRESS

NEXT ACTION
执行 V1-T03
```

并保留：

```text
V1-T01 = VERIFIED
V1-T02 = VERIFIED
V0 = CLOSED
```

---

## 2.2 T03 完成并验收后

只有当 T03 全部 DoD 达成：

```text
V1-T03 = VERIFIED
```

才允许把总控切换为：

```text
CURRENT TASK
V1-T04 — Workspace Explorer & Existing-Folder Adoption

CURRENT STATUS
IN PROGRESS

NEXT ACTION
执行 V1-T04
```

不得在 T03 尚有 BLOCKER 时越级做 T04。

---

## 2.3 T04 最终完成后

统一写为：

```text
CURRENT VERSION
V1（ACTIVE）

V1-T03
VERIFIED

V1-T04
VERIFIED

CURRENT TASK
V1-T04 — Workspace Explorer & Existing-Folder Adoption

CURRENT STATUS
VERIFIED

PRODUCT STATE
DOGFOOD READY — ROUND 3

OPEN BLOCKERS
NONE

NEXT ACTION
PAUSE FEATURE DEVELOPMENT
```

不要自动创建 V1-T05。

下一步仍应先让用户真实使用。

---

# 3. README Update Rule

本轮必须更新 README 的开发状态。

但当前公开 Release：

```text
v0.1.1
```

已经发布并冻结。

因此：

> **不得覆盖 v0.1.1、不得重新上传同 tag 的 DMG、不得移动同名 tag。**

本轮没有公开发版任务。

T03 / T04 完成后 README 必须准确区分：

```text
Latest public release = v0.1.1
Current main = 含尚未公开发布的 V1-T03 / V1-T04 变更
```

不要继续写：

```text
“v0.1.1 是按当前 main 构建”
```

如果 main 已经发生新提交，该说法会变成事实错误。

Download 链接继续保留：

```text
/releases/latest
/releases/latest/download/AI-Course-Workbench-macOS.dmg
```

它们继续指向当前已发布版本。

---

# 4. Why T03 and T04 Are Developed Together

用户当前真实使用暴露了两个连续问题。

第一层：

```text
Workbench 自己内部的 Authoring 仍有明显摩擦
```

包括：

```text
Stage
Block
Drag Handle
媒体插入
媒体库
待补栏
工作台导航
项目文件夹错误说明
```

第二层：

```text
Workbench 只能处理已经是 Workbench Project 的目录
```

无法自然接管：

```text
已有课程文件夹
已有大纲 / 概论文件夹
半成品资料文件夹
```

两者逻辑上有依赖：

```text
先把 Workbench 自己的内部编辑模型收口（T03）
↓
再让外部已有文件进入这个稳定模型（T04）
```

所以本轮可以连续开发，但必须保持 T03 → T04 的验证顺序。

---

# PART I — V1-T03
# Course Authoring & Project Structure Closure

---

# 5. T03 Goal

让 Workbench 的核心 Authoring 在真实鼠标、真实素材、真实课程结构下符合普通桌面软件直觉。

目标链：

```text
知道什么是 Workbench 项目
→ 打开项目
→ 进入“工作台”
→ 新建 / 管理 Stage
→ 选择 Block
→ 真正拖动 Block
→ 在当前位置插媒体
→ 管理媒体
→ 管理待补
→ 保存 / 重启
→ 继续工作
```

---

# 6. T03 Classification

本任务处理以下最新真实反馈：

```text
1. “可用项目文件夹”规则不透明
3. Stage CRUD 不存在 / 不可发现
4.1 Drag Handle 真实不可用
4.2 Block 操作 icon 被裁切
4.3 Block 尺寸仍过大
4.4 Block Selection 不直观
4.5 无正文当前位置媒体插入
4.6 Placeholder 点击后不自动到状态
5. 左栏缺“工作台”
6. Media Library 名称 / Preview 不够用
7. Trash destructive style 仍错误
8. Requirement / 待补右栏横向滚动且语义混乱
```

本任务不实现：

```text
已有普通文件夹自动接管
Explorer
文件夹扫描 / 自动映射
Page / Pagination
PPTX
新的公开 Release
Apple signing / notarization
```

---

# 7. T03-1 — Valid Project Folder Contract

## 7.1 Audit Actual Rule

Agent 必须先定位真实：

```text
project_open
project validation
project migration
schema validation
```

并给出当前代码中的最小合法项目条件。

必须回答：

```text
project.json 是否必须？
project.bak 是否必须？
project_id 是否必须？
schema/version 哪些字段必须？
assets 是否必须？
.workspace 是否必须？
空目录如何处理？
损坏 project.json 如何处理？
旧 schema 如何处理？
```

不得根据文档猜。

---

## 7.2 Product Contract

当前总原则继续保持：

```text
project.json = Canonical Truth
```

`.workspace`：

```text
可重建
```

`project.bak`：

```text
Backup / Recovery Artifact
```

原则上不得要求普通用户手工创建 `project.bak` 才能让目录合法。

如果当前 validator 真的依赖它：

> 必须报告并修正不合理设计。

---

## 7.3 Error UX

不能只显示：

```text
这个文件夹不是可用项目文件夹
```

必须显示：

```text
为什么
+
缺什么
+
用户下一步怎么做
```

例如：

```text
这个文件夹还不是 AI Course Workbench 项目。

没有找到有效的 project.json。

你可以：
• 选择其他 Workbench 项目；
• 新建课程；
• 或返回后使用“导入已有文件夹”（该能力由 V1-T04 提供）。
```

T03 阶段先把错误说清楚。

T04 完成后：

```text
“导入已有文件夹”
```

必须成为真实可点击入口。

---

# 8. T03-2 — Stage CRUD

V1-T02 已明确把 Stage CRUD Deferred。

现在正式实现。

至少支持：

```text
新增 Stage
重命名 Stage
调整 Stage 顺序
删除 Stage
```

---

## 8.1 UI

入口放在：

```text
课程地图
Stage 标题区域
```

推荐：

```text
+ 新阶段
重命名
更多(...)
```

不得藏在：

```text
状态
项目设置
```

---

## 8.2 Naming

新增时给出合理默认：

```text
S02 第二阶段
S03 第三阶段
```

但：

```text
阶段名称必须可编辑
```

code 与 display title 不要混为一谈。

---

## 8.3 Delete Safety

空 Stage：

```text
确认后删除
```

非空 Stage：

```text
不得静默删除
```

优先：

```text
这个阶段还有 N 节课，请先移动课程。
```

若产品已有安全的级联删除模式，可保留，但必须二次明确确认。

---

## 8.4 Completion Report Requirement

最终报告必须单独写：

```text
## 如何操作阶段
```

明确告诉用户：

```text
在哪里新增
在哪里改名
如何调整顺序
如何删除
```

如果审计发现部分 Stage 能力此前就已经存在，也必须说明实际入口。

---

# 9. T03-3 — Drag Handle Real Fix

V1-T02 虽然加入：

```text
draggable="true"
```

但当时真实 Desktop 走查没有完成真实拖拽验证。

用户真实鼠标确认：

```text
Drag Handle 仍不可用
```

所以本次以真实用户证据为准。

---

## 9.1 Diagnosis

检查：

```text
dragstart 是否真实触发
pointer 是否被 overlay / input 吃掉
rerender 是否中断拖拽
WebKit / Tauri HTML5 DnD 是否稳定
drop zone 是否命中
selection / autosave 是否破坏 drag
```

---

## 9.2 Preferred Direction

如果 HTML5 `DataTransfer` 在 Tauri WebView 中不稳定：

> 优先改为 Pointer-based Reorder。

模型：

```text
pointerdown(handle)
→ drag threshold
→ setPointerCapture
→ pointermove
→ 计算目标 Block
→ 插入线 / drop indicator
→ pointerup
→ commit reorder
```

---

## 9.3 Hard DoD

必须至少有一次：

```text
真实鼠标
→ 按住 Handle
→ 拖过其他 Block
→ 松开
→ 顺序变化
→ 保存
→ 重启后顺序一致
```

不能再用：

```text
“属性存在 / 测试覆盖”
```

替代用户级验证。

---

# 10. T03-4 — Block Toolbar Layout

Block 变矮之后，右侧操作区被裁切。

要求将 Block 主要操作重排到：

```text
左上 Header
```

推荐：

```text
┌──────────────────────────────────────────┐
│ [Handle] [类型] [常用操作] [...]       │
│                                          │
│ 内容                                     │
└──────────────────────────────────────────┘
```

原则：

```text
高频动作直接可见
低频动作进 ...
```

不要把全部功能重新挤成一排。

---

# 11. T03-5 — Block Height Round 2

用户希望：

```text
整体同比缩小
Small 完整 Block 外框 = 100px
```

注意：

上一轮报告的 `96px` 可能只是某个测量层级。

本轮先测真实：

```text
outer block box
```

而不是直接修改 token。

---

## 11.1 Required Measurement

先记录：

```text
Old Small outer = ?
Old Medium outer = ?
Old Large outer = ?
```

然后：

```text
New Small outer = 100px
```

以：

```text
scale = 100 / Old Small outer
```

为基准同比压缩 Medium / Large。

允许为了：

```text
工具条可用
文本可读性
整数像素
```

做小范围 correction。

最终报告：

```text
Old:
Small ?
Medium ?
Large ?

New:
Small 100px
Medium ?
Large ?
```

---

## 11.2 Semantics Continue

短内容：

```text
Small ⇄ Medium → Outer Scroll
```

正文 / 代码：

```text
Medium ⇄ Large → Outer Scroll
```

内容减少：

```text
自动缩回
```

继续禁止：

```text
内部 textarea 手动 resize
```

---

# 12. T03-6 — Block Selection Model

点击：

```text
Block 外框
或
Block 文字区域
```

都必须：

```text
selected_block = 当前 Block
```

视觉：

```text
Block 左侧 accent / 高亮条
```

---

## 12.1 Selection != Focus

点击 textarea：

```text
Block 选中
+
caret 正常进入文字
```

不得因为选中状态改变而：

```text
替换 DOM
丢 focus
中断 IME
```

---

# 13. T03-7 — Direct Media Insertion

和：

```text
+ 正文
+ 标题
+ 引用
+ 提示
+ 代码
...
```

同级增加：

```text
+ 媒体
```

---

## 13.1 Media Picker Flow

点击：

```text
+ 媒体
```

可：

```text
选择已有 Asset
或
导入新 Asset
```

最终创建：

```text
媒体 Block
+
AssetUsage
```

---

## 13.2 Insert Anchor

有 selected block：

```text
插到当前 Block 之后
```

没有 selected block：

```text
追加到当前课末尾
```

UI 必须明确。

不得永远：

```text
插到全文末尾
```

---

## 13.3 Media Library Entry

Media Library 中：

```text
插入到当前位置
```

必须调用同一 Domain mutation。

不要维护两套插入逻辑。

---

# 14. T03-8 — Placeholder Opens Status

点击：

```text
Placeholder Block
```

自动：

```text
selected block = placeholder
right panel = 状态
```

---

# 15. T03-9 — Left Navigation “工作台”

左栏改为：

```text
项目概览
课程地图
工作台
收件箱
制作看板
媒体库
待补总览
更新中心
发布中心
版本历史
项目设置
```

其中：

```text
工作台
```

是真实可点击入口。

作用：

> 回到当前课的 Authoring 区域。

默认：

```text
正文
```

如果同一课存在合法 Session：

```text
可恢复最近的 正文 / 结构 / 排版 / 预览 子视图
```

---

# 16. T03-10 — Media Library Rename & Preview

## 16.1 Display Name

允许：

```text
修改 Asset 显示名称
```

默认不要直接重命名磁盘文件。

优先：

```text
display_name / title metadata
```

若 Domain 尚无字段：

```text
以向后兼容方式增加
```

---

## 16.2 Preview

README 已声称预览存在，所以真实白板必须当 Regression Bug 处理。

至少测试：

```text
PNG
JPG/JPEG
GIF
MP4
Markdown
PDF attachment
DOCX attachment
```

目标：

```text
图片 → thumbnail
GIF → thumbnail / type indication
Video → poster / media card
Markdown → content preview
PDF/DOCX → attachment card
```

不能全部显示成白板。

---

# 17. T03-11 — Destructive Button Style

全局审计：

```text
delete
remove
trash
destructive
```

默认：

```text
transparent / white / neutral
```

危险语义通过：

```text
icon
hover
label
confirm
```

表达。

不要：

```text
红底导致垃圾桶 icon 本身看不见
```

---

# 18. T03-12 — Requirement Panel / 待补栏重排

当前问题：

```text
右栏横向滚动
信息层级混乱
“位置：待补”几乎没有信息
```

---

## 18.1 No Horizontal Scroll

强制：

```text
overflow-x: hidden
text wrap
action wrap
vertical scroll only
```

---

## 18.2 Requirement Card

建议：

```text
┌─────────────────────────┐
│ ! 文字待补              │
│ 补充这段文字            │
│                         │
│ 位置：S01-02 · 正文 01  │
│                         │
│ [定位] [完成] [...]     │
└─────────────────────────┘
```

---

## 18.3 Real Anchor

禁止：

```text
位置：待补
```

优先：

```text
S01-02 · 正文 01
S01-02 · 标题 Block
Grid · Section 1 · R2C1
```

无法定位：

```text
未定位
```

---

## 18.4 Type-specific Actions

文字待补：

```text
定位
改备注
完成
```

素材待补：

```text
选择素材
用素材完成
定位
```

不机械让每种类型都显示相同动作。

---

# 19. T03 Carry-over Gate

必须回归 V1-T02 已实现：

```text
连续输入 / IME
Autosave 不抢 focus
Modal 不自动关闭
API Key / Base URL / Models
真实 placeholder
课程标题 inline edit
Flow 唯一排序职责
Grid 上画布 / 下画布 / Cell 移动
Grid Preview
```

T03 不得修新问题时把 T02 能力打坏。

---

# 20. T03 Automated Tests

至少新增 / 加固：

```text
Stage CRUD
Stage deletion safety
project folder error contract
pointer reorder / drag
selected block
media insertion anchor
asset display name
asset preview fallback
placeholder → status
workspace nav
requirement responsive contract
requirement anchor text
destructive styles
```

正式 gate：

```text
deno task check
deno task test
cargo test
cargo build
```

---

# 21. T03 Real Desktop Acceptance

真实最终构建中逐步完成：

```text
1. 选择普通非项目文件夹 → 得到明确原因和下一步
2. 选择合法项目 → 正常进入
3. 新建 S02
4. 重命名 S02
5. 调整 S01/S02 顺序
6. 删除空 Stage
7. 非空 Stage 删除被安全阻止 / 明确确认
8. 真实鼠标 Drag Handle 重排 Block
9. Block toolbar 不被裁切
10. Small 完整 outer = 100px
11. 点击文字 → Block 选中 + caret 仍可输入
12. 点击外框 → Block 选中
13. 左侧高亮明确
14. +媒体 → 插到 selected block 后
15. Media Library → 插入当前位置
16. 点击 Placeholder → 状态
17. 左栏“工作台” → 回当前 Authoring
18. 修改素材显示名称
19. 图片可看到 thumbnail
20. GIF / video / document 明显可区分
21. Trash 按钮不再红底遮挡
22. 待补栏没有横向滚动
23. 待补卡片能看懂类型 / 备注 / 位置
24. 保存
25. 关闭
26. 重启
27. Stage / Block / Asset / Requirement 状态一致
```

---

# 22. T03 Definition of Done

只有全部满足：

```text
[ ] 合法项目规则已审计并写进用户可读错误
[ ] Stage CRUD 可用
[ ] Stage 删除安全
[ ] Completion Report 告诉用户如何操作 Stage
[ ] Drag Handle 真实鼠标拖动成功
[ ] Block toolbar 不裁切
[ ] Small 完整外框 = 100px
[ ] Medium / Large 同比缩小
[ ] Block Selection / Focus 分离正确
[ ] 选中状态左侧高亮
[ ] 正文可以当前位置插入媒体
[ ] Media Library 可插入当前位置
[ ] Placeholder 自动切状态
[ ] 左栏工作台入口存在
[ ] Media display name 可编辑
[ ] Media Preview 可用
[ ] Destructive style 统一
[ ] Requirement Panel 无横向滚动
[ ] Requirement 信息层级清楚
[ ] Requirement 位置是真实 anchor
[ ] V1-T02 无回归
[ ] 自动化 gate 全绿
[ ] Real Desktop Acceptance 全部通过
[ ] BLOCKER = NONE
[ ] README 回写
[ ] MASTER CONTROL 回写
```

才能：

```text
V1-T03 = VERIFIED
```

然后立即按本任务包切换到：

```text
V1-T04
```

---

# PART II — V1-T04
# Workspace Explorer & Existing-Folder Adoption

---

# 23. T04 Goal

解决真实用户已有资料世界与 Workbench 之间的断层。

目标场景：

### 场景 A

```text
用户已经有一个结构完整的课程文件夹
```

### 场景 B

```text
用户有多个大纲 / 概论 / 文档 / 图片 / 视频
但还没有 Workbench project.json
```

### 场景 C

```text
用户只想先浏览文件夹
再决定哪些内容导入课程
```

Workbench 必须从：

```text
“不是 Workbench 项目，拒绝打开”
```

进化为：

```text
先识别
→ Explorer 可见
→ Preview
→ 用户决定是否接管 / 导入
```

---

# 24. T04 Core Principle — External Files Are Not Canonical Automatically

这一条必须锁死：

```text
普通外部文件
≠
自动成为 Canonical
```

必须：

```text
External Source
→ Scan
→ Mapping Preview
→ User Confirm
→ Canonical Mutation
```

不能：

```text
扫描完
→ AI / 规则猜测
→ 直接写 project.json
```

---

# 25. T04 Project Contract v1

T04 要正式把 Workbench 项目与普通文件夹的边界说清楚。

推荐逻辑结构：

```text
<Project Root>/
├── project.json
├── assets/
├── .workspace/
└── 用户自己的其他文件 / 文件夹
```

但：

> **实际目录名必须与当前真实仓库和代码一致。**

不得为了文档整齐：

```text
强行迁移现有 assets / workspace 路径
```

---

## 25.1 Project Identity

Workbench Project 最小身份：

```text
有效 project.json
+
可验证 project identity / schema
```

其他：

```text
.workspace
index
thumbnail
logs
project.bak
```

都不是项目唯一身份。

---

# 26. T04 Entry Points

项目选择页调整为三条真正不同的路径：

```text
新建课程
打开 Workbench 项目
导入已有文件夹
```

不要再让不同按钮最后都变成：

```text
新建课程
```

---

# 27. T04 Workspace Explorer

选择“导入已有文件夹”后进入：

```text
Workspace Explorer
```

至少显示：

```text
文件夹树
文件
类型
大小（可选）
可识别状态
```

---

## 27.1 Supported Initial Types

至少识别：

```text
Markdown
TXT
DOCX
PDF
PNG / JPG / GIF
MP4
常见音频
```

但：

```text
识别 ≠ 全部可编辑
```

例如：

```text
DOCX/PDF
```

当前仍可先作为：

```text
Source Material / Reference
```

不要假装已经能完整转成正文。

---

# 28. T04 Explorer Preview

点击文件：

### Markdown / TXT

```text
文本预览
```

### Image

```text
thumbnail / preview
```

### Video

```text
media card / poster
```

### PDF / DOCX

```text
文件信息
+
可用的文本预览（若现有解析能力支持）
```

如果不能解析：

```text
明确显示“作为参考文件导入”
```

不要白板。

---

# 29. T04 Folder Scan

扫描：

```text
目录
子目录
文件
```

生成只读：

```text
ScanResult
```

建议包含：

```text
path
relative_path
kind
mime
size
suggested_role
```

不得在 Scan 阶段修改用户文件。

---

# 30. T04 Import Mapping Preview

Workbench 可以根据目录结构给出：

```text
候选映射
```

例如：

```text
一级文件夹 → Stage candidate
二级文档 → Lesson / Source candidate
图片 / 视频 → Asset candidate
Markdown → Lesson content candidate
PDF / DOCX → Reference candidate
```

但必须标记：

```text
“建议”
```

不是：

```text
“事实”
```

---

# 31. T04 User Confirmation

真正导入前，用户必须能修改：

```text
哪些文件导入
哪个文件夹映射成 Stage
哪个文档映射成 Lesson
哪些只作为 Source
哪些媒体进入 Asset
哪些忽略
```

然后：

```text
Preview
→ Confirm
→ Apply
```

---

# 32. T04 Adopt Existing Folder

用户可以选择：

```text
将这个文件夹作为 Workbench 项目
```

设计原则：

```text
非破坏性
```

不得：

```text
移动原文件
重命名原文件
删除原目录
覆盖已有文档
```

---

## 32.1 Two Reasonable Strategies

Agent 应审计当前项目架构后选择最稳妥的一种：

### Strategy A — In-place Adoption

在原目录中新增：

```text
project.json
必要 Workbench metadata
```

用户原文件保持原样。

### Strategy B — Create Managed Project

创建新的 Workbench 项目：

```text
Canonical project
```

原目录只作为：

```text
Source Root
```

不搬文件。

---

## 32.2 Decision Rule

优先：

> **不破坏原目录、不会制造双向同步幻觉、最符合 Canonical First。**

最终报告必须解释选择 A 还是 B，以及原因。

---

# 33. T04 Source vs Asset vs Canonical

必须建立清晰语义：

### Source

```text
外部参考资料
尚未成为课程正式内容
```

### Asset

```text
Workbench 已纳管的媒体 / 附件
可被 Block / Requirement 引用
```

### Canonical Content

```text
正式课程结构与正文
写入 project.json
```

不要让 Explorer 中的每个文件：

```text
自动变课程内容
```

---

# 34. T04 Import Rules

至少支持：

## Markdown

可提供：

```text
作为 Lesson 正文导入
或
作为 Source 保存
```

## TXT

同上，但结构识别更保守。

## DOCX / PDF

当前默认：

```text
作为 Source / Reference
```

如果现有解析已稳定：

```text
可提供“提取文本生成草稿”
```

但必须：

```text
Preview
→ User Confirm
```

## Image / Video / Audio

默认：

```text
Asset candidate
```

---

# 35. T04 Duplicate / Conflict Handling

导入时必须处理：

```text
同名文件
相同 checksum
重复导入
已有 Asset
已有 Lesson title
```

至少：

```text
相同 checksum → 提示已存在，可复用
同名但内容不同 → 不能静默覆盖
```

---

# 36. T04 Explorer Navigation

Explorer 不应该替代：

```text
课程地图
工作台
媒体库
```

它是：

> **外部源资料与项目文件视图。**

推荐左栏新增：

```text
文件
```

或：

```text
资源浏览器
```

名称可以根据现有中文 UI 统一。

---

# 37. T04 Search Boundary

T04 只要求：

```text
基本文件名过滤 / 搜索
```

不要在这里提前开发：

```text
全课程高级搜索
全文索引 UX
跨课程搜索
```

这些仍属于后续 V1 效率能力。

---

# 38. T04 Security / Path Rules

必须防：

```text
path traversal
symlink escape
超大文件
无法读取文件
权限不足
```

Explorer 不能因为一个坏文件：

```text
整个目录打不开
```

应：

```text
单文件降级
+
错误可读
```

---

# 39. T04 Persistence

Explorer 自己的：

```text
展开状态
最近浏览目录
过滤条件
```

属于：

```text
可重建 workspace state
```

不要进入 Canonical。

导入确认后的：

```text
Stage
Lesson
Block
Asset
Source reference
```

才按真实 Domain 进入 Canonical / Project data。

---

# 40. T04 Automated Tests

至少覆盖：

```text
普通文件夹 scan
嵌套文件夹 scan
不支持文件类型
无法读取单文件
symlink boundary
Markdown mapping
Stage mapping preview
Asset mapping preview
User deselect
Confirm import
Repeated import
checksum duplicate
same name different bytes
in-place / managed-project adoption
项目原文件不被改写
```

正式 gate：

```text
deno task check
deno task test
cargo test
cargo build
```

---

# 41. T04 Real Desktop Acceptance

准备一个隔离真实文件夹：

```text
CourseFolder/
├── 01-基础/
│   ├── 导论.md
│   ├── 大纲.docx
│   └── intro.png
├── 02-进阶/
│   ├── 第二课.md
│   └── demo.mp4
└── 总体说明.pdf
```

真实走查：

```text
1. 项目选择 → 导入已有文件夹
2. 选择 CourseFolder
3. Explorer 显示完整树
4. 点击 Markdown → 有预览
5. 点击 PNG → 有预览
6. 点击 MP4 → 有媒体卡
7. 点击 DOCX/PDF → 有明确 Reference 体验
8. 系统生成 Mapping Preview
9. 01-基础 / 02-进阶 被建议为 Stage
10. 用户取消某个文件导入
11. 修改一项建议映射
12. Confirm
13. 创建 / 接管 Workbench Project
14. Course Map 出现确认后的 Stage / Lesson
15. Media Library 出现确认后的 Asset
16. 未选择导入的原文件仍原样存在
17. 原目录文件没有被改名 / 移动 / 删除
18. 保存
19. 关闭
20. 重启
21. 项目结构一致
22. Explorer 仍可查看原文件
```

---

# 42. T04 Definition of Done

```text
[ ] 项目选择页有真实“导入已有文件夹”
[ ] Workspace Explorer 可浏览目录树
[ ] 常见文档 / 图片 / 视频可识别
[ ] 预览不再是白板
[ ] Folder Scan 只读、非破坏
[ ] Mapping Preview 存在
[ ] Stage / Lesson / Asset 映射可修改
[ ] 用户可取消某项导入
[ ] Confirm 后才写 Canonical
[ ] Source / Asset / Canonical 语义清楚
[ ] DOCX/PDF 不伪装成完整可编辑正文
[ ] Adoption 不破坏原目录
[ ] 重复导入可识别
[ ] checksum duplicate 可复用
[ ] 同名不同内容不静默覆盖
[ ] symlink / path boundary 安全
[ ] 单文件失败不拖垮全目录
[ ] T03 无回归
[ ] 自动化 gate 全绿
[ ] Real Desktop Acceptance 全部通过
[ ] BLOCKER = NONE
[ ] README 回写
[ ] MASTER CONTROL 回写
```

才能：

```text
V1-T04 = VERIFIED
```

---

# 43. Combined Regression Gate

T04 最终验收时，必须再完整检查：

```text
Stage CRUD
Block Drag
Block Selection
Media insertion
Media Library
Requirement Panel
Flow
Grid
Preview
Autosave
Recovery
Project Lock
External Modification Detection
AI Provider config
Export / Publish
Session restore
```

因为 T04 会触碰：

```text
project lifecycle
path
files
assets
canonical import
```

这些是高风险区域。

---

# 44. Combined Completion Report

本轮最终只需要一份总报告，但里面必须清楚区分 T03 与 T04。

模板：

```text
# Combined Completion Report — V1-T03 + V1-T04

## 1. Control Position

Before:
After:

## 2. V1-T03 Result

Status:
Completed:
Real Desktop:
Automated:
Blockers:

## 3. Stage Operation Guide

How to add:
How to rename:
How to reorder:
How to delete:

## 4. Project Folder Contract

What makes a valid Workbench project:
What is project.json:
What is project.bak:
What is .workspace:

## 5. Authoring UX

Drag:
Selection:
Block size:
Toolbar:
Media:
Requirement:

## 6. V1-T04 Result

Status:
Explorer:
Folder scan:
Mapping Preview:
Adoption:
Source / Asset / Canonical:

## 7. Real Folder Import Walkthrough

...

## 8. Regression

V1-T01:
V1-T02:
V1-T03:
Project lifecycle:
Assets:
AI:
Export:

## 9. Automated Verification

deno task check:
deno task test:
cargo test:
cargo build:

## 10. Open Blockers

...

## 11. Backlog

...

## 12. README Update

...

## 13. MASTER CONTROL UPDATE

T03:
T04:
NEXT ACTION:

## 14. Release State

Latest public release:
Current main:
Was any published tag modified? MUST BE NO

## 15. Final Product State

DOGFOOD READY — ROUND 3 / NOT READY

## 16. NEXT ACTION

PAUSE FEATURE DEVELOPMENT
```

---

# 45. Release Freeze Guard

本轮禁止：

```text
gh release upload v0.1.1 --clobber
删除 v0.1.1
移动 v0.1.1 tag
重新构建 v0.1.1 并冒充同一版本
```

如果未来需要把 T03 / T04 发布给用户：

```text
新 commit
→ 新 tag
→ 新 Release
```

版本号由未来独立发版任务决定。

---

# 46. After T04

完成后：

```text
不要自动进入分页 / PPT / 搜索 / 模板
```

先：

```text
PAUSE FEATURE DEVELOPMENT
→ 用户真实使用
```

根据下一轮反馈再批准新的任务。

---

# 47. V1 Planned Direction After This Combined Run

当前只作为路线，不开工：

```text
V1-T05 — Paged Canvas / Pagination
V1-T06 — Layout-aware Export & PPTX
后续：
Search / Maintenance / Updating
Reuse / Templates / Batch
Distribution Finalization（Developer ID + Notarization）
```

具体编号和范围：

> 等 T03 / T04 VERIFIED 并经过下一轮真实使用后再最终锁定。

---

# 48. Final Success Condition

这次联合开发真正成功，应让用户感觉：

```text
我的 Workbench 不只是“只能打开它自己生成的 project.json”。

它先把内部课程编辑做顺：
Stage、Block、媒体、待补都自然。

然后它能看见我原来就有的课程文件夹：
文件、文档、图片、视频都能看见。

它不会擅自改我的原文件，
而是先告诉我：
“我准备把这些东西怎么变成课程。”

我确认以后，
它才真正写进 Workbench。
```

达到这个状态后：

```text
V1-T03 = VERIFIED
V1-T04 = VERIFIED
NEXT ACTION = PAUSE FEATURE DEVELOPMENT
```
