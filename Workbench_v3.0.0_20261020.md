# AI Course Workbench 大模型开发指南

## 课程创作界面收敛、案例与教学视频发现、PPT 风格延续

> **文档状态：待实现设计提案。** 本文和配套 HTML 用于评审与后续开发交接，均不代表产品代码已经修改、联网能力已经接通或新增功能已经验收。本文不激活 V2、不创建 V1-T07、不修改总控，不构成提交、推送、发布或覆盖用户课件的授权。

**编制日期：** 2026-10-20。  
**读者：** 接手现有仓库的大模型开发者、代码审查者与产品验收者。  
**目标：** 把课程结构、正文、媒体与 AI 的操作位置收敛为一套清楚的工作台，并补齐“文档→真实教学资源候选→审阅入课”以及“已有 PPT→可编辑风格规范→持续补单页”的完整链路。  
**架构选择：** 继续使用现有 Canonical、投影、Store、Deno service 与受限 Tauri bridge。界面合并以复用状态和动作完成；新资源与课件能力沿既有校验、历史、凭据和导出边界扩展，不另建课程真相或通用 Agent 平台。  
**实施条件：** 后续开发者先读取最新总控、README、AGENTS 和用户的新开发指令，确认本设计的范围仍适用，再登记已获授权的平铺工作项。本文的“建议契约”需要映射到当时真实 schema；不能复制粘贴后绕过现有 validator。

---

## 1. 阅读顺序与证据分级

### 1.1 三种信息不得混写

| 标记 | 含义 | 使用规则 |
|---|---|---|
| 现有事实 | 上传总控/README 明确记录，或本轮只读源码已核对 | 可作为设计基线；历史验收只覆盖其标明的范围 |
| 本次设计决定 | 本文为用户新需求选定的交互与数据策略 | 待开发、待测试；不能在产品中标成已完成 |
| 建议契约 | 新类型、模块、接口、默认数值与验收用例 | 后续对照真实仓库实现；命名可适配，语义不可缩水 |

**不要把静态 HTML 按钮点击、样例候选或示例补页当作运行中的后端。** 演示内容应标明“方案示例”；没有来源证据的标题、视频时长、原文摘录和 PPT 提取结果不能伪装为真实数据。

### 1.2 本轮基线

上传资料为 PROJECT_MASTER_CONTROL(20261020-081546).md 与 README(20261020-081545).md。总控 §48 记录 v0.2.7 已公开，V1 ACTIVE，V1-T01–T06 的 VERIFIED 是历史任务结论；File I/O / UI 总体验收仍为 PARTIAL。v0.2.7 tag/source 为 fb050b121c2014ac3226e90d3683b7c6c26391b0，公开包是 ad-hoc signed，未做 Developer ID 签名或 Apple 公证。发布不代表全部交互通过。[M §29，2512–2546；§48，4303–4335；R 107–120]

本轮远程只读核验仓库为 /Users/youngi/Documents/MiniWork/workbench，main HEAD 为 d6c84959b949ee9f95182f55a39056b4bc32d6aa，提交说明为 2026-10-07 的 docs: record v0.2.7 release verification。存在用户未跟踪文档，本次未触碰。读取遵循该仓库 AGENTS 的 graft map/ask/skeleton 后按 span 查看约束；后续不得以本记录代替再次检查最新工作树。[C1]

### 1.3 已知而未闭合的基线风险

1. 保存执行期间继续编辑时的点击时快照冻结、A→B→A 迟到 ACK 重叠，仍缺真实 UI 观察。
2. 150%/200% 真实文字缩放、reduced-motion 行为、完整 Native 页面与侧栏矩阵仍有未测项。
3. 真实 SIWC 登录、套餐范围、账户模型清单、完整响应与真实 API 推理未观察到；离线连接器和本地 stub 的闭环不能代替在线验收。
4. Deno diagnostics-on changed-save 的 p95 比基线高 21.12%，十样本尾部未定位；no-op 性能改善不能抵消此问题。
5. WebKit 总内存、解码图像留存、object URL 留存、设备级写放大和峰值 RSS 未测。[M §47–48，4274–4327；R 253]

本次改版必须防止这些风险扩大，并针对受影响的路径补证据；不得顺手把所有历史 PARTIAL 改为 VERIFIED。

---

## 2. 用户需求与可验收范围

下表编号只用于本文件追踪，不是新产品版本、里程碑或任务树。

| ID | 用户要求 | 本次设计决定 | 最小可观察结果 |
|---|---|---|---|
| U01 | 项目选择和原项目导航放顶栏 | 顶部同排项目下拉与六个导航入口；课程选择放上方 chrome | 左栏无项目导航，顶栏可到全部保留目标 |
| U02 | 项目概览合并课程地图、制作看板、待补总览并去重 | 一张可展开课程树表，共用课次、状态与待补投影 | 同一课不重复为三张卡；筛选、展开后仍是同一实体 |
| U03 | 删除自由排版及相关功能 | 删除自由排版路由、网格/分页编辑动作与完成度依赖；保留旧数据兼容 | 新 UI、命令、旧 session 都不会重新打开自由排版 |
| U04 | 设置、保存、保存版本、版本历史合并项目设置 | 一处项目设置，内含项目信息、保存与恢复、版本历史、AI 设置 | 四类动作均可达，普通保存与创建版本语义分明 |
| U05 | 更新中心与收件箱合并收件箱 | 同一待处理视图聚合原 inbox、Suggestion、ChangeDraft 和资源候选引用 | 同一条建议不产生两份审核状态 |
| U06 | 正文保留全部现有功能 | 以现有 writingView、Store 与编辑链路为基础 | 正文、类型、排序、媒体、待补、属性、撤销等不回归 |
| U07 | 删 Flow/Preview 和工作台完成度提示 | 无独立模式标签；正文保持排序、行内媒体查看；缺项在概览显示 | 编辑器没有模式切换和完成率条，但能重排、看素材 |
| U08 | 右侧只保留 AI | 右栏固定 AI；上下文、Diff、运行记录仍在 AI 内 | 属性、版本、状态、媒体不再占用右侧标签 |
| U09 | 左侧全媒体库 | 全部/案例/视频/图片/文档/课件筛选，候选与已入库清楚区分 | 左栏可管理全项目媒体，不局限当前课引用 |
| R01 | 解析上传文档，批量寻找文字案例 | 复用文档解析，确认结构与偏好后启动一次有界发现任务 | 给出有出处、有适用课次、有审核动作的候选 |
| R02 | 寻找约五分钟教学视频 | 默认完整时长 240–360 秒精筛；其它时长另列 | 显示实际时长证据，未知不冒充符合条件 |
| P01 | 从已有 PPT 抽取风格 MD | 源 PPTX、代表页、风格规范、机器约束按同一版本绑定 | 风格 MD 可读可改，事实与推断可区分 |
| P02 | 持续补单页并保持风格 | 选择风格版本→结构化单页方案→预览→生成单页或追加副本 | 至少一张真实可打开、可编辑、视觉一致的补充页 |

### 2.1 默认偏好是产品建议，不是用户已确认事实

首次资源发现建议默认“中文、本科教学、当前课、3 个文字案例＋2 个视频、视频 240–360 秒”。设置面板可改语言、学生层次、案例类型、来源偏好、时效范围、数量和时长。没有填这些参数时，界面明确显示正在使用默认值，不每条候选重复追问。

“约五分钟教学视频”在本设计中按**查找已有教学视频**处理。已有视频的原链接与合法嵌入优先，不扩为视频生成、自动剪辑或通用下载平台。长视频片段是一种另列的候选形式，不冒充已生成五分钟成片。

### 2.2 本次不扩大为其他平台

不重新建设模型协议、MCP/Connector 生态、模型市场、自动后台 Agent、RAG/向量数据库或跨项目模板市场。九类文本导入已有实现，不再新开“万能文档导入”路线。风格规范是课程生产资料，不要求先建设 V2 Skill 包管理。总控 §44 的 V2 仍保持 PLANNED ONLY。[M §44，4006–4098；R 136–157]

---

## 3. 现有能力、真实缺口与代码入口

### 3.1 必须承接的能力

现有正文支持 Block 新增、编辑、删除、换类型、重排；结构与正文读写同一数据。Requirement 有创建、修改、定位、完成、重开、删除；素材有预览、AssetUsage、解除引用、引用删除确认、真实文件重命名及 Undo/Redo。保存、恢复、锁、外部冲突、会话恢复、只读导出均已存在。[R 213–242]

较新的正文已经取消 B/I/S 和 Markdown 源码切换，以语义编译和块浮层操作为主；600ms 空闲探针、IME 和光标保护已有实现。新界面不能为了“保留功能”恢复过时按钮，也不能重写一个简化 textarea 替代现有编辑链路。[M §42.2 #3–6，3820–3823]

### 3.2 新能力没有被现有能力自动覆盖

- 现有九类文档解析不等于外网资源发现；当前材料未证明已有案例检索 adapter 或视频元数据链路。
- 现有 PPTX 导出不等于读取用户 PPTX 模板。实际 src-tauri/src/paged_export.rs 的 render_pptx 949–995 使用固定 SLIDE_MASTER、SLIDE_LAYOUT、THEME；它是现有输出器，不是模板导入器。[C2]
- 扫描版 PDF 不做 OCR；文本 PDF 不提取内嵌图片；DOCX 忽略主题、字体和装饰样式；旧 .ppt 不在既有导入范围内。产品需要诚实回执，不能把空解析当完整文档。[R 224、257；M §45.1，4123–4127]
- 视频语言、字幕、可播放性、时长与时间戳需要分别取证。模型判断不能补成平台事实。

### 3.3 已核对的源码落点

| 现有位置 | 本轮核对范围 | 后续改动职责 |
|---|---|---|
| app/views.js topbarView 649–688 | 顶栏 | 项目下拉、导航、保存状态和全局动作 |
| app/views.js leftPanelView 690–758 | 原项目导航列表 | 替换为全媒体库；旧 route 兼容映射 |
| app/views.js centerView 760–775 | 中心路由 | 合并地图/看板/待补；删除自由排版及独立媒体目标 |
| app/views.js editorView 931–984 | head、tabs、lesson-meta、strip | 去重 chrome 与完成度，保留当前课信息 |
| app/views.js writingView 1025–1034 | 仅定位正文渲染入口，实施前读取完整函数 | 核心复用，避免整套替换 |
| app/views.js overview 1804–1866 | 概览 | 课程树表统一 projection |
| app/views.js inbox 1870–1914 | 收件箱 | 原 inbox 与审核对象的统一展示 |
| app/views.js updates 2495–2503 | suggestions 与 drafts 聚合及去 AI 入口 | 合并进收件箱，复用对象和审核动作 |
| app/views.js settings 2505–2523 | 项目设置 | 保存、版本、AI 配置归并 |
| app/views.js rightPanel 2559–2602 | 右栏分面板逻辑 | 只保留 AI；其它面板迁移 |
| app/views.js statusbar 3624–3650 | 待补、完成度、排版重复显示 | 移到概览或移除重复；不删必要保存/错误反馈 |
| src-tauri/src/paged_export.rs render_pptx 949–995 | 固定 master/layout/theme | 增加风格输入能力，不能声称已有模板加载 |
| deno.json | check/test/ui 任务 | 沿既有命令做验证 |

这些行号对应 C1 的 HEAD，后续以符号重新定位；不得按过期行号盲改。app/authoring.js 是课程、单课、待补及完成度投影，app/main.js 是 Store/桌面桥接，app/ai.js 装配 AI 上下文，app/canvas.js 是媒体预览缓存；src/domain、src/service、src-tauri/src/documents 分别承载领域规则、服务与文档解析。[R 263；M §9A.2，810–817]

---

## 4. 新信息架构与旧入口迁移

### 4.1 顶部固定结构

同一行依次为：**项目选择｜项目概览｜工作台｜文件｜收件箱｜发布与导出｜项目设置**。项目选择是显示当前项目名的紧凑下拉，包含历史项目、新建/打开、重新定位和返回启动页；不建立第二套项目资源库。

保存状态、撤销、重做可保留为全局 chrome。普通保存按钮的主入口在项目设置，原有保存快捷键继续可用。课次选择、上一课/下一课和当前打开课次标签放在正文上方，不回流进左栏。项目名和课次标题各有一个清楚的编辑位置，避免顶栏、面包屑、页面头同时重复同一标题。

窄屏时导航允许受控溢出为一个“更多”菜单；项目选择、当前主要页面、保存状态仍可见。菜单只是同一导航的响应式表示，不产生第二套状态。

### 4.2 旧入口的明确去向

| 旧 route/入口 | 新去向 | 兼容行为 |
|---|---|---|
| overview、map、board、backlog | 项目概览 | 保留旧筛选意图；map 定位课程树，backlog 应用待补筛选，board 应用状态筛选 |
| workbench | 工作台 | 恢复同课、同 Block 与可用阅读位置 |
| explorer | 文件 | 保留文件树、映射/导入和来源检查，不与媒体库重复列课程导航 |
| inbox、updates | 收件箱 | updates 的 Suggestion/ChangeDraft 沿原 ID 显示 |
| media | 左侧媒体库 | 兼容跳转聚焦左栏并恢复筛选，不再打开独立媒体页 |
| publish | 发布与导出 | 沿既有范围、preflight、输出和发布记录 |
| settings、保存、保存版本、versions | 项目设置 | 跳到相应设置分区/版本记录 |
| free-layout、Grid/分页编辑入口 | 删除 | 旧链接回到当前课工作台；展示一次兼容说明，不恢复画布 |
| Flow、Preview 标签 | 删除 | 回到当前课正文；正文排序与媒体查看继续可用 |
| 右栏 media、requirements、status、properties、versions | 迁移 | 媒体到左栏；待补/状态到概览或块上下文；属性到就近弹窗；版本到设置 |
| 搜索、快速收集 | 全局快捷入口/收件箱动作 | 原快捷键与原数据路径保留，不新建顶层页面 |

兼容映射在解析 session 和路由的单一函数中完成，不能分散在每个 render 分支。旧路由参数先校验项目、课次和 Block 归属；无效目标安全回退，不写入新项目的 session。

### 4.3 中央与左右栏的职责

左栏始终是全项目媒体库，右栏始终是 AI；两栏可折叠但每栏只保留一个关联自身的控件。概览、文件、收件箱等中央页面不把右侧切换为属性面板。素材详情与属性使用 modal/popover，关闭后回到触发按钮，并停止媒体播放。

正文是主工作区。AI 建议关联当前项目、课次和范围；用户在概览选中一课，AI 范围可显式随之更新，但不得静默发送整门课程。全局导航、当前课、当前 AI scope 是不同状态，不能用一个 selectedId 混存。

---

## 5. 项目概览：一张课程树表完成三种工作

### 5.1 行与列

以 Stage→Lesson 的可展开树表为唯一主体。课行建议列为“课次与标题、六维状态、待补/缺素材、最近编辑、操作”。六维名称从现有配置读取，不另起一套“未开始/进行中/完成”替换原枚举；横向空间不足时六维以摘要展开。

默认操作是“继续编辑”，展开行可查看具体缺项、调整状态、处理待补、定位相关 Block。全局仅保留搜索、状态筛选、仅看待补、仅看缺素材和展开/折叠。三个旧页面不再各渲染同一批课程卡；切筛选只改变同一 projection 的可见行。

Stage 标题区承接新增阶段、重命名、调序、删除；非空阶段先移课，保持 code 与标题分离。课次跳转和返回不能丢未提交输入。[M §37.3，3584–3587]

### 5.2 统计与完成度政策

概览展示可解释的数量，例如课次数、待补数、缺失媒体引用数；统计来自 Canonical 与可重建 projection。一个 Requirement 在课行、筛选结果和总数中按同一 ID 计数，不因存在多条提醒而重复计数。

自由排版下线后，完成判定应排除“尚未放置/尚未分页”等旧布局条件。先保留六维与内容待补语义，再根据实际 schema 把仅与旧布局有关的要求标为“旧版排版要求，仅历史保留，不计当前完成”。不能自动将内容待补完成，也不能让所有旧项目永远显示未完成。该政策变更必须有明确 migration 记录和前后对照，不强造百分比。

工作台不显示完成率 strip、重复待补总数或排版提示。要处理具体待补时，在对应 Block 就近显示明确动作；项目级概览承担汇总职责。

### 5.3 交互验收

- 单一课行更新状态后，筛选和总数立即由同一数据反映；保存重开一致。
- 任意课可进入；当前课有标识；上一/下一/继续未完成可达。
- 新建、删除、移课不会复用 code 或留下 Requirement/Inbox 悬空引用。
- 无课项目提供建结构/导入的实际入口；全筛空结果能重置筛选，不显示假课程。
- 在中文长标题、多个待补、1024 宽度和键盘操作下，行操作仍可用，内容不被固定栏遮住。

---

## 6. 正文保留清单与编辑连续性

本节是删除旧模式入口时的回归清单。开发者逐项映射原 Store 动作，不以“新编辑器看起来更清爽”代替功能承接。

| 功能组 | 必须保留 | 新位置/行为 |
|---|---|---|
| Block 生命周期 | 新增、编辑、删除、换类型、复制能力若当前源码已有 | 原正文就近 +/⋯，新建后选中新块 |
| 正文内容 | 标题、段落、引用、列表、代码、提示、练习、分隔线、占位符与当前实际类型 | 沿现有类型与语义渲染，不删未知合法类型 |
| 语义输入 | 粗斜体、行内码、删除线、链接、标题、引用、列表、代码块的现有编译 | 复用 flushPendingEdit；未完成语法与转义文本不误改 |
| 排序/结构 | 拖柄、现有移动操作、结构定位 | 写同一 order_index；删除 Flow 标签不删除 moveBlock |
| 属性 | 原 Block 属性、相关设置与类型属性 | 块菜单打开就近属性弹窗，关闭归还焦点 |
| 媒体 | 图片、GIF、音视频、文档/附件预览、插入、解除引用 | 原引用模型；查看在正文或媒体 modal |
| 待补 | 创建/编辑/定位/完成/重开/删除；类型/优先级/备注 | 块上下文与概览展开行，仍使用原 Requirement |
| 历史 | Undo/Redo，含转换、排序、素材物理改名 | 原 commit/history，不另设正文历史栈 |
| 保存 | 自动保存、手动保存、错误/冲突/锁、恢复 | 状态走 chrome patch，输入 DOM 不被替换 |
| 阅读位置 | 当前课、Block、滚动、焦点/IME 的原保护 | 与新 route/session 对应；不扩大“光标恢复已验收”声明 |
| 输出语义 | 正文、素材、引用、附件降级和 preflight | 同一 publication projection，独立 Preview 标签无需存在 |

输入期间只更新必要 DOM。自动保存完成、AI 返回和媒体缩略图加载不得整壳 render，导致光标、IME、选区、拖拽目标或弹窗消失。既有 notifyChrome/patchChrome 和 focusTextOffset 的保护优先复用。[M §35.1，3263–3272；§42.2，3821–3823]

---

## 7. 左侧媒体库、右侧 AI、项目设置与收件箱

### 7.1 全媒体库

一级筛选为“全部、案例、视频、图片、文档、课件”。音频沿现有 Asset 类型保留，可在全部中查到，并在类型筛选的扩展菜单中选择。课件包含源 PPTX、风格规范与生成页的关联组；“案例”是教学资源类型，不要求有本地二进制文件。

“候选”与“已入库”必须清楚区分。机器刚找到的结果不能被计入正式素材数，也不能自动建立 AssetUsage。已入库卡显示引用到哪些课/Block；未引用素材仍属于全项目媒体库。详情弹窗包含来源、核验状态、适用课次、插入、重新查找及合法打开入口，不另开右侧面板。

保留多文件导入、逐项回执、重复跳过、真实文件改名、引用删除确认和 Undo/Redo。沿 app/canvas.js 有界缓存，就地 patch 完成预览；可见卡片不能因 LRU 淘汰闪烁，released 状态提供重试。视频/GIF 关闭后拆除播放器与 object URL；同一素材并发读取合并。[M §45.1，4129–4136；R 217、225]

### 7.2 右侧 AI

AI 内有上下文范围、将发送内容的预览、Provider/Model、指令、运行/取消、Suggestion、ChangeDraft Diff、Apply/Reject 与执行记录。媒体详情、版本、属性和状态不作为 AI 的 sibling tabs。

资源任务和补页任务在 AI 内显示“处理哪一课、使用哪些来源/风格版本、进行到哪一步、可取消、产生多少真实结果”。进度来自任务事件；不播放固定秒数的假进度，不在失败后显示完成。用户切到别课时可以查看原任务，但所有应用按钮仍绑定原目标并重新校验。

### 7.3 项目设置

建议分区为“项目信息、保存与恢复、版本历史、AI”。保存与恢复包含普通保存、创建命名版本、自动保存状态与恢复入口；版本历史提供查看和恢复前确认/备份。一个保存按钮不能同时暗含创建快照和恢复版本。

AI 设置复用现有模型/账户配置，凭据仍为本机范围；不得因为入口叫“项目设置”就把 API Key 写入 project.json。未来若增加 Skill，仍同处 AI 设置，但本次不做 Skill 安装平台。[M §44.2，4069–4075]

### 7.4 统一收件箱

原 updates 只是 suggestions 与 drafts 的聚合并提供去 AI 的入口；应复用这些对象，而不是复制成新的 inbox 正文。[C1，app/views.js 2495–2503]

收件箱按“全部、资源候选、AI 建议、修改草稿、快速收集”筛选；标签只是 projection。一个候选在媒体库与收件箱通过同一 ID 引用，只有一份审核状态。接受、拒绝、已应用和撤销后状态由对象事实推导；不要分别维护 mediaAccepted 与 inboxProcessed。

临时机器候选可由工作台任务缓存投影到收件箱，不为每条机器候选写一个指向缓存的 Canonical 外键。用户决定保留、添加不可重建备注或形成正式修改方案时，必须先提升为正式资源/草稿，再由 Canonical 引用；删除缓存不应丢掉用户确认的决定。

## 8. 文档驱动的案例与教学视频发现

### 8.1 一次明确启动，完整执行一个有界任务

用户流程为：选择文档→查看解析结果→确认章节/课次映射→确认资源偏好→“导入并寻找资源”。最后一次按钮点击同时授权该次导入和展示范围内的外部检索；操作前列明来源文档、课次数、搜索类型、数量目标、请求预算与将发送的上下文。既已启动的任务不为每次 query 或每个候选再次追问。

导入仍先沿既有 Mapping Plan 和九类文档解析完成；媒体递归入库不自动插入正文，文档候选仍可取消。解析单文件失败时只降级该文件；扫描 PDF、空文档、密码保护或格式不支持均有逐文件回执，不把失败页喂给模型编补。[M §45.1，4138–4144；R 224、257]

导入成功后可以自动启动一次该次授权绑定的检索。普通保存、切课、重开应用不重新触发检索。用户改变偏好或文档后明确选择“重新寻找”，创建新任务与新输入 hash，旧结果保持可追溯。

整门课程按课次分批处理，首次展示预计课次数、数量目标与最大请求数；先提交有证据的已完成结果，允许取消剩余批次。预算耗尽显示“本次预算已用完，已返回结果可继续审阅”，不能无限搜索以凑数，也不能把未执行批次显示成无匹配。

### 8.2 处理链与每一步产物

| 顺序 | 处理动作 | 产物与检查 |
|---|---|---|
| 1 | 从已确认文档/课程结构提取概念、问题、学习目标 | 逐课 ResourceNeed；每项回指页码、段落或 Block |
| 2 | 搜索当前媒体库中的既有资源 | 命中引用，不重复下载；说明为何适用于新课 |
| 3 | 为缺少的资源生成有限 query | QueryPlan；显示主题、语言、时间和来源限制 |
| 4 | 调用已配置的检索 adapter | 原始结果带 Provider、请求时间、URL、标题；无 adapter 时如实阻断外网步骤 |
| 5 | 获取证据与元数据 | SourceEvidence；抓取失败保留失败原因，不伪造原文 |
| 6 | 归一 URL、文件 hash 与事件聚类去重 | 同链接/同源副本合并；同事件的多来源保留为证据组 |
| 7 | 生成教学加工建议 | 区分来源事实、模型概括、讨论题和课堂用法 |
| 8 | 发布为候选 | 媒体库与收件箱引用同一候选；数量据真实结果计算 |
| 9 | 用户保留、引用或要求改写 | 正式资源、手工引用 commit 或 ChangeDraft；保存与撤销沿既有路径 |

搜索引擎摘要可作发现线索，不直接等同证据全文。来源打不开或日期不明时保留 unknown/unverified；不能根据题目猜发生时间。对同一事件的新闻转载不能充当多个独立核实来源。

### 8.3 文字案例的类型与字段

案例不只包括新闻。建议可选类型为：新闻事件、企业运营、失败事故/复盘、人物/创业故事、调查/访谈、政策实际实施、判例/监管决定、科研应用、地方产业/供应链、历史决策、对照案例、行业报告数据。presentation medium 与 narrative case type 分开：同一企业复盘可有文字材料和视频，两者不是两种事件。

每条文字候选至少展示：

- 标题、事件/主体、发生日期与发布日期，未知分别标注；
- 案例类型、对应课次和概念、适用教学层次及匹配理由；
- 来源机构/作者、原 URL、获取时间、证据所在页/段/节；
- 有依据的事实摘要，以及单独标注的教学问题、争议点和课堂用法；
- 原文短摘录如使用须对应确切来源；不能以模型改写冒充引文；
- 可用性与核验状态、同事件的关联来源、是否已在其它课使用；
- 保留入库、查看原文、插入引用、要求改写、跳过的动作。

不承诺每课都找到指定数量的真实案例。零结果应保留搜索范围与失败原因，并提供调整主题、时间范围、来源或数量的具体出口。

### 8.4 视频时长、字幕与片段的严格语义

默认目标是完整视频 240–360 秒，用户可修改。180–480 秒是建议的宽范围备用结果，必须独立显示“时长放宽候选”，不能悄悄混进符合条件列表。长视频中的约五分钟片段另列为“建议片段”，显示完整视频总时长和片段起止。

YouTube search.list 的 videoDuration=medium 实际覆盖 4–20 分钟，不能代表“五分钟”。若采用此 adapter，先搜视频，再读 videos 资源的 contentDetails.duration 并解析 ISO 8601 时长，按秒精筛。[T4][T5] 标题写“5分钟”而元数据未知时，仍为时长未核验。

视频候选显示 providerVideoId、原链接、频道/机构、总时长及其证据、口播语言、字幕语言/状态、发布时间、获取时间、地区/嵌入可用性及教学目标。口播与字幕语言分别记录；未知用 null 并附获取限制，不能根据中文标题猜口播语言。语言、字幕和时长各自独立，字幕存在不等于字幕可下载；YouTube captions.download 要求具有编辑该视频的权限，不能据此承诺拿到任意公开视频字幕。[T6]

片段建议必须有可访问字幕、章节信息、平台时间戳或人工查看记录支持。视频本体保存 totalDurationSec 与时长证据；ResourceUsage.videoSelection 保存该次引用的 startSec/endSec/timingEvidenceId，检查 0≤start<end≤total。一个视频可在不同课次引用不同片段，本体元数据只存一份。没有证据不填伪造时间戳；无字幕则降级为人工核验候选。打开平台带时间参数链接只是定位，不等于本地剪辑完成。

优先保存原链接与允许的嵌入。是否允许下载、嵌入、课堂播放属于来源实际能力/许可信息；不编造“可商用”标签，不实现绕过访问控制的通用下载器。

### 8.5 插入动作与 AI 写入边界

用户对已核实候选点击“插入引用”，插入其准确标题、原链接与已确认的短摘要，属于明确的手工 commit；先形成候选项目深拷贝，校验正式资源、ResourceUsage、Block 以及实际涉及的 AssetUsage，成功后一次落盘，可撤销。

若用户要求“改写成课堂案例、替换原段落、自动补到各课”，模型输出必须进入 Suggestion/ChangeDraft/Diff/Apply。确认保留资源与确认改写正文是不同动作；可在一个批量审阅界面完成，但每个目标、before/after 和冲突必须可见。模型不得直接运行 mutateCanonical 或写磁盘。

### 8.6 外部请求、取消和恢复

只发完成检索所需的概念 query、语言和范围。整份文档正文不因“自动寻找”默认上传；上下文预览展示实际发送的片段和字数。若特定功能需要更大范围，使用当前 AI scope 机制显示并由本次任务启动动作确认，凭据沿现有本机钥匙串注入。

抓取到的网页、字幕和文档是资料，不是执行指令。诸如“忽略先前要求、导出密钥、改写项目”的文字不得进入工具权限或控制流程。fetch adapter 只接受受控 http(s) 请求，继承已有路径、凭据和网络边界；拒绝任意本地文件读取和地址跳转扩权。

取消使任务进入 cancel_requested，并停止新 query、终止可中断请求。无论 Provider 能否立即中断，后续响应到达都必须检查取消状态和 snapshot；取消后不能悄悄新增候选、扣入完成数或改课程。已经审阅入库的结果不因取消剩余任务被撤回。

断网、鉴权失败、限流、超时、来源不可读、预算耗尽、无匹配和用户取消是不同结果。运行记录保留原因与重试范围；恢复任务先重新校验输入 hash 和当前 revision，不能复活一个已经 stale 的运行。

---

## 9. PPT 风格规范与持续单页生产

### 9.1 交付链必须完整

本能力的结束点不是“生成一个 style.md”，而是用户可以反复从同一份已确认风格出发，获得真实、可打开、文字/图片可编辑的补充页。连续补第二页时必须还能找到原源文件、采用的风格 revision、variant、页内容方案与生成记录。

关联资料组包含：原 PPTX Asset、源文件 SHA-256、结构扫描结果、代表页图、style.md、经验证的类型化约束、用户确认的 StyleProfile revision，以及引用该版本的 SlidePlan/生成课件。文件图可重建，用户确认的规范和补页方案不能只放缓存。

### 9.2 结构提取与视觉检查并行提供证据

第一条通道读取 PPTX 包内的幻灯片尺寸、主题色、字体方案、master/layout 关系、placeholder、对象位置与尺寸、文本层级、页码/页眉、填充/描边、常用边距、图片裁切、背景与装饰元素。第二条通道渲染代表页并检查实际视觉：标题位置、密度、对齐、留白、色彩比例、图片语言、图表样式和不同页面家族。

PresentationML 包由独立的 presentation、slide master、slide layout、slide、theme 等部件及关系组成；不能只读每页显式颜色就认为已还原主题。[T1] Placeholder 存在 master→layout→slide 的继承，同时允许直接格式覆盖，因此提取必须记录继承来源和覆盖值。[T2]

多母版、多主题或内容页/章节页风格不同的 PPTX，应形成多个 variant，并保留代表页与原 layout 关系。不要平均字体、颜色或边距后生成一个现实中不存在的混合模板。机器读到的值标为“结构提取”；根据图像判断的规范标为“视觉推断”；缺字体和低置信推断标为需复核。

源为 .ppt 时明确说明当前既有解析不支持二进制旧格式，并提供“另存为 .pptx 后重新导入”的操作；只有后续另行实现并验证转换器，才可显示可自动转换。加密、损坏、外部链接和特殊对象给出逐项能力报告。

### 9.3 style.md 的内容边界

style.md 只记录视觉与呈现规范，不塞入模型系统指令、Provider 凭据、课程正文或自动调用脚本。推荐固定结构：

~~~markdown
# 课件视觉规范
## 身份与版本
源课件 Asset ID、SHA-256、风格 ID、revision、variant、提取时间
## 页面与安全区
尺寸、比例、边距、标题/正文/页码区域
## 字体与层级
标题、正文、注释、图表标签；继承来源与可用替代字体
## 色彩与背景
主题色、文本色、强调色、背景、允许的组合
## 页面家族
标题页、章节页、内容页、对照页、图文页；对应原 layout
## 图形、表格与图片
线条、圆角、表格/图表、图标、裁切与来源标注规则
## 密度、对齐与分页
最大内容量建议、溢出处理、禁止静默缩字
## 示例与证据
代表页引用、结构事实、视觉推断与待复核项
## 保真限制
复杂对象、缺字体、不可编辑对象与近似重建范围
~~~

类型化 tokens 是机器消费的派生结果，必须带 parsedFromHash 和 parserVersion。明确选择一个事实来源：**用户确认后的规范文本及身份在 Canonical StyleProfile 的单一 revision 对象中保存；磁盘 style.md 是可编辑镜像。** 用户改外部文件后，通过“导入修改/保存到项目”读取、校验、建立新 revision，再重新生成 tokens；不能让 markdown、JSON 和主题文件各自悄悄改写。

校验失败保留上一个有效 revision，并呈现具体字段/段落冲突；不覆盖旧规范。旧 SlidePlan 固定原 revision，不自动跟随最新风格改变。要升级既有补页计划，展示变化并重新确认。

### 9.4 两种渲染策略与保真承诺

**优先策略：基于当前工作课件的副本受控追加。** 第一次以源 PPTX 开始，后续按 §9.5 接续已接受的工作版本；在副本中复制已选代表页或新增引用原 layout 的页，对支持的 title/body placeholder、基础 text、shape、image 做定向替换。复制时维护关系 ID、媒体部件、唯一 shape/slide ID 和布局引用，原有页按包结构保持完整。未知 SmartArt、复杂图表、动画、嵌入对象等保留在原包中，禁止模型盲改或“重建全部文件”。

**备用策略：按已确认 tokens 重建单页。** 当原布局不能安全复用时，使用固定的结构化渲染器生成近似页；在预览和输出报告标明“按风格重建，非原模板保真”。PptxGenJS 的 master 定义可用于按对象创建 master/layout，但这项 API 本身不能证明能导入并保留任意现有 PPTX。[T3] 是否引入该库，需结合现有 Rust 输出器和部署依赖评估；本文不强制更换技术栈。

现有 render_pptx 必须接收明确的风格/布局输入，或由新的模板追加服务承接；固定 THEME 常量不能继续用于“已提取用户风格”的伪实现。[C2] 发布 projection 可以读取已确认 SlideSpec 和 style revision，无需依赖被删除的自由排版编辑器。

### 9.5 单页生成流程

用户在 AI 或课件详情选择“按此风格补一页”，确认关联课次、插入位置、页面家族及要表达的内容。模型读取所选规范和许可范围内课程内容，输出结构化 SlideSpec：目标 layout、标题、段落/要点、图像引用、数据/来源引用、备注与约束，不输出任意 Python/JS 或 Office 宏。

服务端校验内容是否符合风格、对象数量、文本长度、图片存在性和页面安全区，再生成预览。字体缺失、文字溢出、图片低分辨率或难以复用的复杂对象需要显示具体影响；优先减内容密度、调整结构或让用户确认替代，不通过把正文静默缩小到不可读来过检。

预览位于 AI 结果、课件 modal 或导出流程，不恢复一个顶层 Preview 标签。用户可修改单页内容、重新生成候选、采纳并创建输出。建议提供“生成单页 PPTX”和“追加到当前课件工作副本”两个明确动作；原课件不被覆盖。新输出作为 Asset 入库，记录原文件 hash、风格 revision、SlidePlan revision、输出 hash 和验证结果。

**持续补页使用显式工作副本链。** StyleProfile.sourceAssetId/sourceSha256 始终指向风格来源；PresentationDocument.currentAssetId 指向当前已接受的工作版本。第一次追加形成副本，第二次默认以该副本的 Asset/hash 为目标，不能再次从最初文件开始而丢掉第一张补页。目标选择器显示文件名、版本和页数，允许明确另起副本。输出记录保存 documentId、parentAssetId、newAssetId、operationId 与采用的计划/风格版本；仅在输出验证成功并按用户该次动作登记后更新 currentAssetId。单独导出一页不自动推进整份课件工作版本。

### 9.6 单页实际验收

至少用两类真实课件：单 master 的常规课程，以及具有多个 layout/字体层级的课件。每类至少完成导入、style.md 确认、生成一页、再补一页、保存重开、导出副本和真实 PowerPoint 打开。复杂对象样例用于确认保留/阻断/近似报告，不拿简化截图证明全对象保真。

验证原课件 N 页不变、首次工作副本 N+1 页、第二次 N+2 页，且第一张补页仍在并未改写；同时检查插入位置、原页对象关系、无 Repair 提示、文字图片可编辑、原文件 SHA 不变。并排检查代表页与新增页的字体、颜色、背景、边距、标题/正文/页码位置及图片风格。自动结构检查只能发现部分问题，不能替代真实渲染对照。

---

## 10. 数据模型、生命周期与单一事实

本节类型均为建议契约。已有项目版本字段仍使用既有 data.project.schema_version；新增记录的 contractVersion 仅标识本类型格式，不引入第二个 project schema 版本。正式实现必须把扩展字段纳入现有 schema、migration、validator、导出过滤和两运行时的读写路径。

### 10.1 正式数据与工作台临时数据

| 内容 | 所在层 | 规则 |
|---|---|---|
| 已有课程、Block、Requirement、Asset/Usage、正式 Inbox/Suggestion/Draft | 原 Canonical | 沿现有字段、身份、外键与历史，不复制一套 |
| 用户确认保留的资源、来源证据、ResourceUsage 与教学加工内容 | Canonical 扩展 | 离线可读；删除任务缓存不会丢失 |
| 已确认 StyleProfile/SlidePlan、课件工作版本指针及 revision/hash 绑定 | Canonical 扩展 | 可恢复、可导出，不能只存 style.md 文件路径 |
| 原 PPTX、用户导入媒体、生成课件文件 | 既有 Asset 存储 | ID/checksum/引用完整，输出不覆盖原源 |
| 机器检索任务、尚未确认的候选、网络回执 | .workspace 可重建任务存储 | 有界、无密钥；丢失只影响未保留的发现结果 |
| token JSON、代表页图、缩略图、搜索索引 | 可重建派生物 | 带 source hash/revision，过期时重建 |
| UI filter、左右栏折叠、当前页/滚动 | session | 按项目隔离、字段白名单、无凭据 |

用户编辑的候选备注、保留决定或批准方案不是可重建机器结果；发生此类操作时，必须升级为 Canonical 记录或既有 ChangeDraft，再让两个界面引用同一正式 ID。

### 10.2 关键类型

~~~ts
// 建议契约；需与既有命名适配，不是当前仓库已存在的类型。
type EvidenceAccess = 'metadata_only' | 'content_read' |
  'timed_transcript' | 'unavailable';
type FactCheck = 'unchecked' | 'supported' | 'disputed';
type ResourceMedium = 'text' | 'video' | 'image' | 'audio' | 'document' | 'presentation';
type TaskState = 'queued' | 'running' | 'partial' | 'completed' |
  'cancel_requested' | 'cancelled' | 'failed' | 'stale';

interface TaskSnapshot {
  projectId: string;
  generation: number;
  inputHash: string;
  lessonRevisions: Record<string, string>;
  styleRevision?: number;
  targetAssetHash?: string;
}

interface SourceEvidence {
  id: string;
  url?: string;
  assetId?: string;
  title: string;
  publisher?: string;
  eventDate?: string;
  publishedAt?: string;
  fetchedAt: string;
  locator?: {
    page?: number; section?: string; paragraph?: string;
    startSec?: number; endSec?: number;
  };
  excerpt?: string;
  evidenceAccess: EvidenceAccess;
  factCheck: FactCheck;
  contentHash?: string;
  limitations: string[];
}

interface ResourceItem {
  contractVersion: 1;
  id: string;
  projectId: string;
  medium: ResourceMedium;
  narrativeCaseType?: string;
  title: string;
  sourceIds: string[];
  eventClusterId?: string;
  factualSummary: string;
  claims: Array<{ text: string; evidenceIds: string[] }>;
  video?: {
    provider: string;
    providerVideoId?: string;
    totalDurationSec: number | null;
    durationEvidenceId: string | null;
    spokenLanguage: string | null;
    subtitleLanguages: string[] | null;
    languageEvidenceIds: string[];
    captionState: 'available' | 'unavailable' | 'unknown';
    metadataLimitations: string[];
  };
  revision: number;
}

interface ResourceUsage {
  contractVersion: 1;
  id: string;
  projectId: string;
  resourceId: string;
  lessonId: string;
  blockId: string | null;
  teachingUse: string;
  discussionQuestions: string[];
  videoSelection?: {
    mode: 'full' | 'clip';
    startSec: number | null;
    endSec: number | null;
    timingEvidenceId: string | null;
  };
}

interface StyleProfile {
  contractVersion: 1;
  id: string;
  projectId: string;
  sourceAssetId: string;
  sourceSha256: string;
  revision: number;
  variantId: string;
  markdown: string;
  markdownHash: string;
  representativeSlideIds: string[];
  extractionFacts: string[];
  visualInferences: string[];
  limitations: string[];
}

// 从已确认 StyleProfile 派生，可重建，不是第二份课程或风格真相。
interface StyleTokens {
  profileId: string;
  profileRevision: number;
  parsedFromHash: string;
  parserVersion: string;
  page: { widthEmu: number; heightEmu: number };
  fonts: Record<string, {
    family: string | null;
    sizePt: number | null;
    minReadableSizePt: number | null;
    fallbackFamilies: string[];
  }>;
  colors: Record<string, string | null>;
  layouts: Array<{
    id: string;
    sourceMasterRef: string;
    sourceLayoutRef: string;
    slots: Array<{
      name: string;
      kind: 'text' | 'image' | 'shape';
      xEmu: number; yEmu: number; widthEmu: number; heightEmu: number;
    }>;
  }>;
}

interface PresentationDocument {
  id: string;
  projectId: string;
  sourceAssetId: string;
  currentAssetId: string;
  revision: number;
}

interface SlideSpec {
  layoutRef: string;
  title: string;
  body: Array<{ kind: 'paragraph' | 'bullet'; text: string }>;
  imageAssetIds: string[];
  sourceIds: string[];
  speakerNotes: string;
}

interface SlidePlan {
  contractVersion: 1;
  id: string;
  projectId: string;
  documentId: string;
  lessonId: string;
  styleProfileId: string;
  styleRevision: number;
  targetAssetId: string;
  targetAssetHash: string;
  insertAfterSlideId: string | null;
  spec: SlideSpec;
  revision: number;
}
~~~

draft 候选状态和正式 ResourceItem 不需要各建一套审核枚举。候选是否已保留，由正式资源/关联记录推导；ChangeDraft 的 applied/rejected 沿现有生命周期。若要显示“已用于课堂”，必须来自实际引用或用户状态字段，不由点击预览推测。

SourceEvidence 的 eventDate 与 publishedAt 分开；unknown 用空值及原因，不写假的日期。evidenceAccess 仅说明取得了什么，factCheck 说明关键事实与证据的核对结论；取得原文不自动成为 supported，官方材料只证明其声明，多个来源是否独立也不等于其内容已证实。ResourceItem.claims 将关键事实映射到具体 evidenceIds，教学用途放在 ResourceUsage。

ResourceItem.video 只存本体元数据；总时长有 durationEvidenceId，口播语言与字幕语言分开。subtitleLanguages=null 表示未知，空数组只能用于已确认无字幕；captionState 表示字幕轨是否存在，不承诺可下载。完整使用的 videoSelection 为 full、起止为空；clip 使用必须有合法起止及时间证据。关联课次列表由 ResourceUsage 派生，不在 ResourceItem 再维护一份；同一视频两课的片段互不覆盖。ResourceUsage 沿既有引用校验扩展，对本地素材仍复用 Asset/AssetUsage，不另存冲突的文件引用。

StyleProfile 单 variant 单 revision；多个母版建立多个关联 variant。StyleTokens 的 EMU 几何须为有限合法数、文字角色须指向已确认约束；缺值保留 null 并提示，不按猜测填成结构事实。所有 tokens 的 parsedFromHash/profileRevision 必须与已确认规范匹配。

### 10.3 任务隔离与迟到响应

每次项目打开或切换产生新的 generation；同一个项目 A→B→A 后也具有不同 generation。运行开始时固定 TaskSnapshot，旧异步回调、候选发布和隐式写入都比较 projectId、generation、inputHash、目标课 revision 和必要的风格/课件 hash。不一致则标 stale_input/stale_target，不因当前项目恰好又是 A 而接纳旧 ACK。

generation 不使持久化方案永久失效。用户重开项目后明确采纳已保存资源或补页计划，先重新核验原目标课 revision、style revision、source/target hash，再为这次 Apply 绑定当前 generation 的新 snapshot；内容未变即可预览/应用，无需重跑搜索或模型。数据已变则先重新审阅差异或更新方案，不自动覆盖。原运行的迟到回包仍保持失效。任务缓存按项目命名空间隔离，保存锁与事务仍是最后写入约束。

更换课次但未改内容时，后台可以继续为原目标找资源；显示其归属。任何 Apply 仍检查目标 revision，不以当前选中课替换 task.lessonId。批量应用预检所有目标，选择全有全无或明确逐课事务，并在 UI 展示实际策略；不得“前两课写入、第三课失败”却报告整批成功。

### 10.4 原数据不变量

- project.id 已存在时逐字节保留；Registry 不存课程正文/密钥；路径重定位检查同一身份。
- content_items.code 唯一；所有 Block、Requirement、Usage、Inbox 外键在删除、移动和迁移后仍有效。
- 文字、媒体语义与排版分离；layout_pages 和 placement 旧数据不反向改正文顺序。
- 重开/解除素材时完整处理 resolved_*；素材 rename/Undo/Redo 同步真实文件及 Canonical 路径。
- 保存、迁移、外部 reload、冲突 merge、历史 restore 使用一致校验；恢复前备份，原子失败无半写入。
- AI Apply 与人工编辑共用 commit/history/undo/redo/autosave；导出只读，不带密钥、私有日志和 session。
- 字段被删除前先确认历史恢复与导出兼容，不能靠 validator 拒绝旧项目来逃避迁移。[M §3；§14.3，1094–1134；§38.2，3646–3649；R 220–242]

## 11. 建议模块与服务接口

### 11.1 按职责增量扩展

以下新文件名是建议，不声称当前已存在。若仓库已有相同职责的模块，应合并到既有边界，避免第二实现；不要为了本次改版拆分整个 main.js。

| 位置 | 操作 | 职责 |
|---|---|---|
| app/views.js、app/styles.css | 修改 | 顶栏/三栏、路由归并、概览树表、设置与收件箱 |
| app/main.js | 修改 | 新导航与 session 迁移、动作绑定、复用 commit、异步结果归属 |
| app/authoring.js | 修改 | 统一概览 projection，排除废弃布局完成条件 |
| app/canvas.js | 复用/必要修改 | 媒体缓存和生命周期，不承载资源事实模型 |
| app/ai.js | 修改 | 新任务 scope/context preview，复用建议/Diff 与日志 |
| app/resource_views.js | 建议新增 | 候选/来源详情/批量审核 UI；读取共享资源对象 |
| app/presentation_views.js | 建议新增 | 课件、风格/variant、单页方案/预览 UI |
| src/domain/resources.ts | 建议新增 | Resource/SourceEvidence 的校验、去重身份与引用操作 |
| src/domain/presentation_styles.ts | 建议新增 | StyleProfile/SlidePlan 版本绑定、约束与纯校验 |
| src/service/resource_discovery.ts | 建议新增 | 有界任务调度、snapshot、取消/重试、预算和回执 |
| src/service/resource_providers.ts | 建议新增 | 搜索/元数据/证据 adapter，不兼任模型平台 |
| src/service/presentation_workflow.ts | 建议新增 | 风格提取与补页计划编排、结果/输出登记 |
| src-tauri/src/documents/ | 复用 | 已有九类文档解析，不做第二套 Markdown 管线 |
| src-tauri/src/presentation_import.rs | 建议新增 | PPTX 结构提取、安全副本/关系处理与能力报告 |
| src-tauri/src/paged_export.rs | 修改/复用 | 固定结构化输出、显式风格参数与兼容既有导出 |
| 既有 schema/migration/validator 文件 | 修改 | 新字段纳入同一版本和 FK 校验，Deno/Rust 同义 |
| tests/ 下领域、服务、UI、native 对应测试 | 增补 | 下节关键风险与契约，不用快照数量代替有效断言 |

源码核验第一步应找出 schema/migration/validator 的实际文件路径、导出名、Native command 和浏览器 service 注册点，写入该次范围记录。本文不编造没有核对过的路径；完成定位是可检查动作，不是留给模型猜测的空白开发项。

### 11.2 请求与返回契约

同一请求在浏览器服务与 Tauri 高层命令中保持相同语义；名称映射可不同，错误码和成功结果形状必须一致。所有写动作需要 expectedRevision/snapshot，所有文件操作由服务处理，不让前端拼任意磁盘路径。

| 建议接口 | 输入 | 输出/核心约束 |
|---|---|---|
| buildResourceNeeds | 已有 Canonical 项目、选中课 ID、已确认文档来源 | ResourceNeed[]：lessonId、concepts、questions、sourceLocators |
| planResourceDiscovery | needs、语言/时长/数量偏好、请求预算 | queryPlan、上下文预览、最大批次；只读 |
| startResourceDiscovery | queryPlan、TaskSnapshot、用户启动授权记录 | jobId、queued 状态；不直接改正文 |
| getResourceDiscovery | projectId、jobId | 实际状态、逐批回执、候选 IDs、已耗预算 |
| cancelResourceDiscovery | projectId、jobId | cancel_requested/cancelled；迟到回包仍受保护 |
| searchResources | 标准 query、类型、限制、取消信号 | 有来源 ID/URL 的结果，不返回任意工具指令 |
| fetchResourceEvidence | 受控来源定位、字节/时间上限 | SourceEvidence、能力限制与失败原因 |
| acceptResourceCandidate | candidateId、目标项目/课次、snapshot | 正式 resourceId；选择引用时返回 usageId，事务可撤销 |
| extractPresentationStyle | sourceAssetId/hash、代表页/variant 选择 | 结构事实、视觉推断、规范草稿、能力报告 |
| saveStyleProfile | 草稿或修改后 MD、source hash、expectedRevision | 新 StyleProfile revision；同步派生 hash |
| proposeSlide | lessonId、documentId、style id/revision、当前工作文件 hash、内容指令 | SlidePlan 草稿、来源、warning；无磁盘覆盖 |
| renderSlidePreview | 已校验 SlideSpec、style revision | 预览资源、溢出/字体/对象诊断；只读课程 |
| exportSupplementSlide | 已确认计划、输出模式和目录 | 新 Asset/hash、parent lineage、工作版本更新回执；原文件不变 |

统一失败结果建议包含 code、userMessage、retryable、targetId、details，details 不含密钥或整段敏感正文。至少区分：provider_unavailable、auth_required、rate_limited、timeout、source_unreadable、unsupported_format、no_matches、budget_exhausted、cancelled、stale_input、stale_target、invalid_style_profile、unsupported_presentation_object、font_unavailable、content_overflow、export_validation_failed。未知 Provider 错误归一为可显示的通用错误，但保留无敏感信息的诊断码。

adapter 只提供实际已配置的能力。没有视频元数据能力时，返回 unknown 和可人工核验的链接；不模拟成功，也不临时使用用户未连接的服务。新增服务的凭据仍通过现有密钥链路保存，不落在课程或风格文件。

---

## 12. 迁移策略与兼容收尾

### 12.1 先只读清点，再做可重复迁移

对隔离项目副本先统计旧 route/session、layout_pages/placements、布局 Requirement、已用素材、版本快照、AI Draft 和外部来源数量，记录 project.id 与文件 hash。禁止直接在用户真实项目上试 migration。

迁移沿当前 project.schema_version 升级路径进行，保持幂等：同一数据运行两次，第二次不得再生成 ID、改变规范 revision 或制造“未保存”。只补缺失的新字段；已有未知但合法字段按既有兼容规则保留。旧项目初次打开不触发资源联网检索，也不自动解析全部 PPT。

### 12.2 旧 UI 与旧布局数据

session 的旧 route 和 right_panel 按 §4.2 映射；不存在的课次回退到项目默认课或概览，不能带着 A 的 ID 写进 B。恢复当前课和滚动后再定位 Block；不声称仅凭 scroll 恢复就实现了文本光标恢复。

自由排版数据先做兼容只读保留，用于打开旧项目、历史恢复及已有输出兼容，不提供新的放置、缩放、编辑网格或分页 UI。旧布局专用待补从当前完成判定中排除并保留来源标识；用户内容与媒体引用不动。后续若实际移除旧结构，必须先证明无损转换，不能以删字段使旧导出或历史恢复失败。

普通课程导出继续读取 Canonical publication projection。PPT 补页读取 StyleProfile/SlideSpec，而非通过隐藏 Free Layout 画布生成；两者共用服务边界但职责分明。

### 12.3 保存、冲突与回滚

UI 收敛先保持现有 commit 与 autosave API 不变；新写动作进入相同候选深拷贝、domain 校验、原子存储和历史路径。外部 reload、merge、restore 都调用同一迁移函数。发生磁盘冲突时，资源采纳和风格保存同样受拦截，不可绕过项目锁。

PPT 输出失败删除本次临时产物并回滚新引用，不回滚用户已批准的 StyleProfile。若系统在导出完成、登记 Asset 前退出，恢复时通过任务回执与文件 hash 判定未登记产物；不能重复追加同一页。每个输出操作有唯一 operationId，重复请求返回同一已验证结果或明确拒绝。

---

## 13. 后续实施顺序与每步出口

以下是先后顺序，不新增 V1/V2 阶段。只有获得用户明确开发指令后才开始执行；代码变更、Git 操作和发布分别服从该次授权。每一项都有独立可审查的结果，上一项的关键数据风险未解决时不把复杂功能叠上去。

### 工作项 A：核对基线并完成 UI 收敛

- [ ] 读取最新总控、README、AGENTS 和工作树状态；保护用户未跟踪文件；按仓库要求完成图谱定位。
- [ ] 补全原 route、Store action、schema、session、projection 和 native/browser 注册点的真实清单，与 §3/4 对照差异。
- [ ] 先固定 session 路由迁移、概览去重与正文状态连续性的有效回归用例，再改 topbar/leftPanel/center/rightPanel。
- [ ] 合并概览、收件箱、项目设置；移走右侧非 AI 面板；删除自由排版/Flow/Preview 入口及重复完成度。
- [ ] 完成旧项目打开、切项目、正文、素材、保存与四格式输出的受影响验证；输出真实未闭合项。

**出口：**用户能在新三栏内完成现有课程编辑，旧内容/引用/历史不丢，U01–U09 全部有对应行为证据。

### 工作项 B：文字案例完成一条真实闭环

- [ ] 定义 Resource/SourceEvidence 与正式/临时候选边界，沿现有 validator 迁移；校验 FK、无密钥、重复事件与多课引用。
- [ ] 复用九类文档解析和 mapping，输出逐课 needs；接一个实际可用的搜索/证据 adapter 与真实错误回执。
- [ ] 实现一次有界任务的计划、启动、预算、分批、取消、snapshot 检查和重开可解释状态。
- [ ] 媒体库/收件箱读取同一候选，完成保留、查看来源、手工插入和 AI 改写 Diff。
- [ ] 用真实来源验收一个文档→多个课次→文字案例→入课→Undo→保存重开流程。

**出口：**有可查证的案例和不串项目的应用链；不是仅生成一组看似合理的案例标题。

### 工作项 C：视频匹配与证据完善

- [ ] 扩展同一资源 adapter/类型，实现平台 ID、实际总时长、语言/字幕/可用性及缺失值。
- [ ] 固定 240–360 秒精筛、独立备用范围和长视频片段规则；无证据时间戳不得入“符合条件”列表。
- [ ] 复用视频预览生命周期和外链打开；确认关闭、取消、项目切换不残留播放/对象。
- [ ] 跑真实平台候选检查及元数据缺失/地区不可用/字幕不可取的降级用例。

**出口：**视频候选时间范围可核实，原链接可用，长片段没有冒充本地成片。

### 工作项 D：PPT 风格与实际单页闭环

- [ ] 在真实 PPTX 夹具上实现结构提取、代表页图和 variant；记录不能处理的对象。
- [ ] 将风格 MD 确认为 Canonical revision，验证编辑后 tokens/hash 同步与旧计划不漂移。
- [ ] 接结构化 SlideSpec 方案和安全渲染；选择原模板副本追加或明确标注的近似重建。
- [ ] 完成实际单页与追加副本输出，原文件不变；再补第二页验证同风格持续使用。
- [ ] 用真实 PowerPoint 打开、编辑并保存输出；核对原页、追加位置、布局与图片文字对象。

**出口：**P01/P02 交付可用文件与复现记录；仅生成 style.md、PNG 预览或无法编辑的截图不算完成。

### 工作项 E：整条链路与交接

- [ ] 补足 U/R/P 矩阵，做新 schema/旧布局/历史恢复/取消/A→B→A/Provider 错误的综合复核。
- [ ] 执行既有 deno task check、deno task test；Rust 按真实改动执行 fmt/check/test/build 及必要原生 smoke。
- [ ] 把 Deno、Native、浏览器、真实阅读器和在线 Provider 的证据分开记录；无法运行就写具体未观察路径。
- [ ] 在真正实施完成后按总控规则更新完成报告、MASTER CONTROL 与 feature-history/UNRELEASED；只有获得发布授权才使用新 tag/Release，已发布资产冻结。

**出口：**可交接的源码、报告、样例、证据和明确剩余风险；不以“基本完成”合并未通过项。

---

## 14. 验收矩阵与证据要求

以下是应执行的用例，不是已经通过的结果。自动化断言聚焦数据和交互风险；低影响文案/位置调整用走查即可，不写只复述 DOM 实现的测试凑数量。

| 用例 | 操作/输入 | 必须观察的结果 | 证据类型 |
|---|---|---|---|
| UI-01 | 顶部进入全部目标、返回启动页 | 原导航按矩阵可达；左栏无项目导航 | Browser＋Native |
| UI-02 | 概览对同一课筛状态/待补，展开并改状态 | 单实体单计数；视图与保存重开一致 | projection＋UI |
| UI-03 | 旧 free-layout/Preview/right_panel session | 安全迁移到新路由；无空白右栏/旧画布复活 | session＋Native |
| UI-04 | 中文 IME 连续输入同时 autosave/AI 返回 | 不丢字、焦点、选区、滚动，不误关弹窗 | 真实输入 |
| UI-05 | 正文换类型、语义转换、拖动、Undo/Redo | 同 Canonical order，前后内容恢复 | domain＋UI |
| UI-06 | 右侧打开 AI 的范围/预览/Diff/记录 | 所有原 AI 动作可用，其它属性在新位置 | UI |
| UI-07 | 保存、保存版本、恢复历史、外部冲突 | 动作区别清楚，恢复有备份，冲突不覆盖 | service＋Native |
| UI-08 | 长标题、1024/1280/1440 宽度、两栏组合 | 无横向不可达内容，菜单/浮层可键盘操作 | 几何＋手势 |
| UI-09 | 150%/200% 真文字缩放、reduced motion | 关键操作可达；有环境证据，不用 CSS 假装 | 实际环境 |
| DATA-01 | 旧 schema 与布局待补迁移两次 | id 不变、无重复修复，布局不再阻塞完成 | migration |
| DATA-02 | 删课、删素材、重开待补、版本恢复 | code 唯一、无悬空 FK、resolved 字段一致 | domain/service |
| DATA-03 | 素材实际改名→Undo→Redo | 文件名/字节/checksum/引用全程一致 | 磁盘＋UI |
| ASYNC-01 | A任务→B→A，旧请求迟到 | generation 不符，不能写 A 新会话或 B | service＋UI |
| ASYNC-02 | 保存期间继续改目标课，再应用结果 | revision 冲突明确；新正文不被旧快照盖掉 | service＋Native |
| ASYNC-03 | 取消后响应到达/重试/应用退出 | 无迟到写入；回执清楚；已入库结果仍在 | service |
| ASYNC-04 | 保存计划→退出→重开，内容/文件未变 | 新 Apply snapshot 可直接采纳；原迟到回包仍拒绝 | service＋UI |
| RES-01 | 九类导入、扫描 PDF、单文件失败 | 真解析/降级逐项说明；映射及源文件不变 | Rust＋UI |
| RES-02 | 同 URL 转载、同事件多来源、跨课命中 | 去重身份稳定，多证据保留，不重复入库 | domain |
| RES-03 | 真实外网 query、抓证据、候选入课 | 来源可查、事实/加工分开，Undo/重开一致 | online＋UI |
| RES-04 | 限流、无密钥、断网、预算耗尽、零结果 | 不伪造内容；结果/失败/未执行数量准确 | adapter＋UI |
| RES-05 | 同候选从媒体库与收件箱处理 | 只有一个审核结论，无双写竞态 | Store＋UI |
| VID-01 | 239/240/300/360/361 秒与未知时长 | 边界精确；未知及备用结果独立 | unit＋真实元数据 |
| VID-02 | 长视频选段、无字幕、错误时间戳 | 总时长/片段分开；不合规片段被拒/降级 | service＋人工核验 |
| VID-03 | 播放、关闭、重开、切项目 | 无后台残留播放/旧 Blob 覆盖 | media＋Native |
| VID-04 | 同视频两课各引不同片段，删除其一 | 本体一份、两段互不覆盖、另一引用不受影响 | domain＋重开 |
| PPT-01 | 单/多 master PPTX，源 .ppt/损坏文件 | variant 与限制真实；不虚构转换成功 | 结构＋UI |
| PPT-02 | 改 style.md 并保存，旧计划再打开 | 新 revision/hash 一致；旧计划仍绑定旧版本 | domain/service |
| PPT-03 | 文本超量、缺字体、复杂对象 | 明确溢出/替代/保留/阻断，不静默缩字 | render＋视觉 |
| PPT-04 | 生成一页再补一页，接续工作副本 | 原 N 页不变，副本 N+1→N+2，首张补页保留、对象可编辑 | PowerPoint＋包检查 |
| PPT-05 | 输出失败/重复提交/退出后恢复 | 无半登记、无重复追加，无原文件损坏 | service＋文件系统 |
| OUT-01 | 旧项目与新资源导出 HTML/Web/PDF/PPTX | preflight 正确，同源内容/引用，私有数据排除 | UI＋物理输出 |
| PERF-01 | 大媒体库滚动、任务返回、连续编辑 | 无重复全页重建；按真实量测标注内存/延迟范围 | 性能记录 |

验收报告每行至少包含 source commit、运行壳/环境、输入 fixture、操作、预期、观察、产物位置与结论。PASS、FAIL、PARTIAL、BLOCKED 分别记录；只有测试代码存在、截图存在或全套测试总数增加，不足以认定功能闭环。

PPT 图片对照、Native 原生交互和真实在线 Provider 必须各有自己的证据。不得用浏览器 mock Provider 演示覆盖在线结果，用测试 invoke 覆盖 macOS 文件选择，或用 PPTX ZIP 结构正确覆盖真实 PowerPoint 打开。

---

## 15. 交接、风险决策与下一位模型的开始指令

### 15.1 必须带走的交付

真正实现后应交接：需求矩阵和新旧入口映射、迁移说明/回滚结果、源码与测试、真实文档导入回执、可查证案例和视频样例、至少一份源 PPTX 的风格规范与连续两次补页输出、浏览器/Native/PowerPoint/在线验证证据、用户可读功能更新与未闭合项。样例采用隔离资料，不把真实用户课程混入测试夹具。

任何改动引入明显额外模型/搜索消耗，任务启动页应先展示数量/预算上限并允许调整。不要用硬编码币价估算无法核验的费用；已经授权的一次有界任务无需逐 query 再确认，超预算停止而非擅自扩展。

### 15.2 优先审查的五类失败

1. **旧项目恢复与布局删除相遇：**能打开、恢复和导出，不能丢字段后再报不支持。
2. **异步请求和编辑并行：**A→B→A、迟到保存/搜索/渲染回包不能覆盖新数据。
3. **候选的两处展示：**媒体库与收件箱不复制审核状态或留下指向缓存的正式外键。
4. **风格版本漂移：**外部 MD 改动、源 PPTX 改动、tokens、SlidePlan 和生成文件的 hash/revision 必须一致。
5. **能力不足伪装成功：**无来源、无字幕、未知时长、PPT 复杂对象、缺字体、在线调用失败都应明确可见。

这些风险已分别落在 DATA/ASYNC/RES/PPT 矩阵，不再额外创建独立产品阶段。

### 15.3 可直接交给下一位模型的指令

> 先读取最新 PROJECT_MASTER_CONTROL.md、README.md、AGENTS.md、本指南和用户本次明确开发指令；核实当前分支/HEAD、工作树与未跟踪用户资料。遵循仓库图谱查找和按 span 阅读要求。当前设计依据 v0.2.7 的已发布但 PARTIAL 验收基线，不得擅自激活 V2、创建 V1-T07、改写历史 VERIFIED 或覆盖已发布资产。  
> 先完成 §3.3 和 §11.1 的实际代码/schema/命令注册映射，再按 §13 顺序增量实现。保留正文、Canonical、历史、锁/冲突、素材引用、凭据和导出边界；新类型沿现有 migration/validator，两运行时语义一致。  
> 新 UI 为顶部项目选择与导航、左媒体、正文中心、右 AI；概览与收件箱必须复用实体和状态。自由排版/Flow/Preview 入口彻底删除，旧数据仅兼容。案例/视频必须来自真实证据；PPT 风格必须完成真实单页再补页，不止输出说明文件。  
> 逐项记录实际证据和限制；不能运行的真实路径标明未观察。只执行本次已经授权的工程和交付动作，Git 发布遵循用户指令与冻结规则。完成真实开发后回写总控与 feature history；本指南自身不构成实施或发布完成记录。

---

## 16. 证据与一手技术资料

### 16.1 项目资料

- **M：**用户上传 PROJECT_MASTER_CONTROL(20261020-081546).md，4,335 行。本文按章节和上传版行号引用；重点 §3、§14.3、§35–38、§42、§44–48。
- **R：**用户上传 README(20261020-081545).md，263 行。重点“当前开发位置”“已支持”“明确未支持”“目录边界”。旧段落与后续总控冲突时，以较新的冻结记录解释，不改写历史。
- **C1：**2026-10-20 对远程 /Users/youngi/Documents/MiniWork/workbench 的只读源码核验，main HEAD d6c84959b949ee9f95182f55a39056b4bc32d6aa。本文 §3.3 列明 app/views.js 各符号与 span，以及 deno.json 任务。
- **C2：**同一 HEAD 的 src-tauri/src/paged_export.rs，render_pptx 949–995；确认固定 SLIDE_MASTER/SLIDE_LAYOUT/THEME，不是用户模板导入器。

### 16.2 技术原理来源

以下链接于 2026-10-20 核验。它们支持格式/API 原理，不代表本产品已实现对应能力；后续实施再次检查所用版本和访问能力。

- **T1：**[Microsoft Learn：Structure of a PresentationML document](https://learn.microsoft.com/en-us/office/open-xml/presentation/structure-of-a-presentationml-document)。支持 PPTX 的部件与关系结构。
- **T2：**[python-pptx：Understanding placeholders](https://python-pptx.readthedocs.io/en/latest/user/placeholders-understanding.html)。支持 master/layout/slide 的 placeholder 继承与直接覆盖。
- **T3：**[PptxGenJS：Masters and Placeholders](https://gitbrent.github.io/PptxGenJS/docs/masters/)。支持以对象定义 master/layout；不作为任意原 PPTX 导入保真的证据。
- **T4：**[YouTube Data API：search.list](https://developers.google.com/youtube/v3/docs/search/list)。videoDuration 的 medium 为 4–20 分钟范围。
- **T5：**[YouTube Data API：Videos resource](https://developers.google.com/youtube/v3/docs/videos)。contentDetails.duration 提供 ISO 8601 视频时长，可用于进一步精筛。
- **T6：**[YouTube Data API：captions.download](https://developers.google.com/youtube/v3/docs/captions/download)。下载字幕轨要求有权编辑该视频，不能承诺任意公开视频字幕可取。

**本文件的最终性质仍是设计指南：所有新增接口、字段、默认偏好和用例均待实施验证；未改远程产品代码、未改总控、未改变项目阶段或公开版本。**
