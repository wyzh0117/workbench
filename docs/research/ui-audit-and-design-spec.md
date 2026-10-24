# AI Course Workbench 全站 UI 整改审计与设计规范

> 角色：UI 设计评审与规范制定者 · 只写规范，不改产品代码
> 工作目录：`/Users/youngi/Documents/MiniWork/workbench`
> 证据基线：`/tmp/ego/ui-audit-20261024/before/*.png`（改造前真实渲染）+ `app/styles.css`（1764 行）+ `app/views.js`（4354 行）
> 美学参照：`docs/research/dsh-model-config-ui-spec.md` §5–6 + `docs/reports/evidence/ai-model-config-2026-10-24/`（已获用户认可的 AI 模型设置页）
> 日期：2026-10-24

---

## 0. 摘要与证据声明

**一句话结论**：现有界面**骨架与信息层级基本正确**（页头 eyebrow+H1+说明 三段式统一、左中右三栏工作区稳定、绿色主色语义清晰），但**视觉执行层严重失控**——设计 token 被大面积绕过，色板/圆角/字号/控件高度/阴影各成多套，且混入一整族**未声明的紫色强调色**与**冷灰中性色**，与绿色主色打架。整改方向不是推倒重来，而是**把散落的硬编码值收敛回 token**，并以已认可的 AI 模型设置页规格（R16 编辑卡 / R12·H32 输入 / H36·R12 按钮 / H28·R8 行内）为统一锚点向全站铺开。

### 0.1 证据缺口（务必先读，影响"逐页诊断"的可信度）

对 `before/` 9 张截图做 sha256 去重后发现**只有 6 个不同页面**，另 3 张是重复渲染：

| 截图 | sha256(前8) | 实际渲染的 view | 说明 |
|---|---|---|---|
| overview.png | ba403ee0 | `mapView()` | 基准 |
| backlog.png | ba403ee0 | `mapView()` | **与 overview.png 字节完全相同** |
| map.png | e655165a | `mapView()` | 视觉与 overview 相同 |
| media.png | 91fe1092 | `mapView()` | 仅左栏缩略图加载态不同，中心区仍是课程表 |
| editor.png | 06b74815 | `editorView()` | 独立 |
| explorer.png | 14c19180 | `explorerView()` | 独立 |
| inbox.png | 7fc26340 | `inboxView()` | 独立 |
| publish.png | 67028a42 | `publishView()` | 独立 |
| settings.png | 00a31e93 | `settingsView()` | 独立 |

原因：`views.js:709-718 centerView()` 的路由表是 `route "overview" → mapView()`。截图采集一直停留在 overview 路由，因此 `overview/map/media/backlog` 四张都落在 `mapView`。

**后果（诚实声明）**：`overviewView`（绿色渐变 hero 页）、`backlogView`（待补总览）、`mediaView`（媒体库）、`mappingView`、`boardView`、`flowView`、`layoutView`、`previewView`、`launcherView`、`registryListView` 的**独立中心区没有截图证据**。这些页面的诊断在 §A7 一律标注 **「未确认（无截图）」**，仅依据 `views.js` 的 DOM/类名 + `styles.css` 推断，视觉细节（真实对比度/留白/密度）待补截图后复核。

### 0.2 什么是对的（整改时要保住）

1. **页头三段式统一**：`<span class="eyebrow">…</span><h1>…</h1><p class="muted">…</p>` 在 map/editor/explorer/inbox/publish/settings 全部一致（`views.js:791,864,2210,2024,` 等）。这是全站最稳的结构，**不要动 DOM**。
2. **绿色主色语义清晰**：`--primary #14725f` 用于主行动、选中态、图标 hover，语义一致。
3. **AI 模型设置页已达标**（`styles.css:629-684`）：`.ai-provider-editor{border-radius:16px}`、`.ai-provider-editor input{border-radius:12px;min-height:32px}`、`.ai-editor-actions .secondary{border-radius:12px;min-height:36px}`、`.ai-model-row{border-radius:16px}`、行内 `.text-button{border-radius:8px;min-height:28px}` —— **正是参照规格 §5.3/§5.4 的落地**。整改就是把这个锚点铺到全站。

---

## A. 逐页视觉诊断

> 每节标注证据：`截图名` + 关键 `file:line`。设计语言词汇：字阶 / 间距节奏 / 描边阴影 / 控件规格 / 层级对比 / 密度 / 空态加载态 / 图标状态点 / 强调色 / 标题区。

### A0. 全站共有外壳（topbar / tabs / statusbar）

证据：`styles.css:108-166`，截图全部可见。

- **标题区结构**：topbar（52px）+ tabs（36→39px）+ 工作区 + statusbar（30px）。整体稳定。
- **问题 T1｜字阶失衡**：顶栏/标签/状态栏正文充斥 11px、12px、13px，而内容页 H1 高达 clamp(27–36px)（`styles.css:1108`），**顶栏到正文的字阶跳变过大且中间层（15/16/20/22）散落**，缺过渡。
- **问题 T2｜标签栏两套规格**：`.tab{height:35px}`（`styles.css:116`）被后文覆盖为 `height:39px; border-radius:9px 9px 0 0`（`styles.css:1081`），再被 `.tab-item .tab{height:37px}`（`styles.css:1527`）第三次覆盖。**同名 `.tab` 三种高度（35/37/39）**。
- **问题 T3｜状态栏过密**：30px 高、10–11px 字（`styles.css` statusbar），与 52px 顶栏不对称，字对比度偏低。

### A1. `mapView` —— 概览 / 课程结构（截图：overview.png = map.png = media.png = backlog.png）

证据：`overview.png`；`views.js:755-845`；`styles.css:171-177, 276-279, 1136-1147`。

- **标题区**：eyebrow「项目概览 · 课程结构」+ H1「认识 AI」+ 说明。右侧 `map-actions`：`项目设置/定位当前课/＋新阶段`（secondary）在上，主行动 `＋新建课程内容`（primary 绿）**折到第二行左对齐**。
  - **问题 M1｜主次行动失衡**：绿色主 CTA 被 3 个次级按钮挤到第二行、且不与按钮组对齐（`views.js:791 map-actions`）。主行动应最醒目、首位或右上单列，而非"被换行"。
- **工具条**：左「3 课 · 1 项待补 · 0 处缺素材」小字 + 搜索框 + 筛选 `全部/进行中/待补/缺素材/已完成`（`filter` pill，`全部` 为绿底选中）。
  - **问题 M2｜筛选 pill 与左栏 pill 重复造轮**：`.filter.active{background:var(--primary-soft)}`（`styles.css:201`）与左栏 `.side-item`/`library-badge` 选中态、AI `.ai-scope[aria-pressed]` 是**三套选中 pill 写法**。
- **课程表**：表头 `课程/状态/待补/素材/操作`；分组行（S01/S02）浅灰通栏 + 子行白底；状态徽章 `待研究/起草中` 小橙丸；行内 `▶状态`、`▶1 项待补`；行右 5 个图标钮（🗑↓↑📎＋）。
  - **问题 M3｜状态指示混乱**：同一"状态"概念用了**徽章（.badge/.status-pill）+ 三角前缀文本 + 纯文本（齐全/无待补）** 三种表达（`views.js:807-842`）。视觉权重不一致，扫描成本高。
  - **问题 M4｜行操作图标过密无规格**：5 个 17px 图标钮挤在右侧（`views.js:842`），hit-area/间距不统一，部分禁用态仅降透明度，缺 hover 反馈层级。
  - **问题 M5｜徽章描边圆角不统一**：`.badge{border-radius:999px;background:#eef0f6;color:#5d6474}`（`styles.css:276`）是**冷灰**，但选中/警示徽章又用暖橙/绿/红（`styles.css:277-279`），且后文整套覆盖为另一组色（`styles.css:1124-1127`）。**同名 `.badge` 两套配色**。
- **留白**：表格下方大量空白（812px 高视口只用到 ~640px），页面底部空旷；`course-tree-scroll-hint` 说明文字孤立在底部。
  - **问题 M6｜留白失衡**：内容集中在上 2/3，标题区 margin-bottom 30px、表格行 14px 内距，节奏偏"松-紧-空"，缺统一竖向栅格。

### A2. `editorView` —— 工作台（截图：editor.png）

证据：`editor.png`；`views.js:847-1110`；`styles.css:195-199, 541`。

- **标题区**：面包屑 `课程概览 / 认识 AI / S01-01 素材待补测试` + eyebrow「工作台 · S01-01」+ H1「素材待补测试」+ 说明 + `＋插入内容` 文本钮。
  - **问题 E1｜字阶/层级混杂**：面包屑 11px、eyebrow 10–11px、H1 27–36px 三层紧贴，中间缺 16/20 过渡；`.breadcrumbs b{color:#c6c8d1}`（`styles.css:189`）分隔符用冷灰，与暖灰 `--muted` 不一致。
- **正文画布**：大片空白 + **孤立文本「需要配图」悬浮在中部**。
  - **问题 E2｜空态随意**："需要配图"像是未定位的占位/批注，孤零零浮在空白正文区（`editor.png` 中部），既无容器也无对齐锚点，是**未完成的空态/占位态**，观感最差的一处。
- **底部素材卡**：灰底卡 `#说明 / 这是一段 **Markdown** 素材。 / ———` + 行：复选方块 + `文字待补 / 补充这段文字 / 补充这段文字·未完成` + 右侧 `选择素材/去媒体库/改备注`（secondary）+`删除`（红文本钮）。
  - **问题 E3｜卡片材质不一致**：该卡灰底（近 `--panel-muted`）圆角 ~7–8px，与 AI 面板白底卡、inbox 白底卡材质不同。
  - **问题 E4｜按钮组规格不齐**：`选择素材/去媒体库/改备注` 三个 secondary 与 `删除` 文本钮并排，高度/圆角与全站按钮（35/36px, R7/12）未统一；`.asset-card-actions > button{min-height:28px}`（`styles.css:454`）又造了 28px 第三档。
  - **问题 E5｜原始 Markdown 泄漏**：`**Markdown**`、`#`、`———` 以原始字符显示（`editor.png` 底卡），正文未渲染，视觉上像乱码（**是否为产品预期未确认**）。

### A3. `explorerView` —— 文件（截图：explorer.png）

证据：`explorer.png`；`views.js:2097-2227`；`styles.css:206, 541, 1128-1130`。

- **标题区**：eyebrow「项目资料」+ H1「文件浏览」+ 说明；右上主行动 `选择资料文件夹`（primary 绿）。
- **空态**：大虚线圆角框 + 圆形绿图标 + `尚未连接资料文件夹` + 说明 + `浏览本机文件夹`（primary 绿）。
  - **问题 X1｜双主 CTA 冗余**：右上 `选择资料文件夹` 与空态内 `浏览本机文件夹` **两个绿色主按钮做同一件事**（`views.js:2210`）。主行动重复，削弱层级。
  - **问题 X2｜空态规格尚可但与别处不齐**：此处空态是"虚线大框 + 60px 圆icon"，与 AI 面板"描边卡 + 文本"、editor"裸浮文本"、backlog"虚线框"四种空态写法（`styles.css:206, 541, 1128`）不统一。
  - **问题 X3｜圆形 icon 规格**：`.empty-icon{height/width:60px;font-size:28px}`（`styles.css:206`）偏大，与参考"6px/8px 状态点、16px 图标"的克制尺度不符，且 icon 是几何字符 `▤`（非图标库）。

### A4. `inboxView` —— 收件箱（截图：inbox.png）

证据：`inbox.png`；`views.js:1991-2038`；`styles.css:171-177, 201, 1128`。

- **标题区**：eyebrow「项目级输入」+ H1「收件箱 <sup>2</sup>」+ 说明 + `＋快速收集`（primary）。
  - **问题 I1｜计数徽章混入标题**：H1 里 `<sup>2</sup>` 与 backlog「待补总览 <sup>N</sup>」、media「媒体库 <sup>N</sup>」一致（好），但 sup 与标题同字重、无底色，**和 .badge/.status-pill 计数是两套**。
- **统计卡**：`待决定 2 / 已分配 0 / 已保存素材 0` 三张白卡，大数字（29px，`styles.css:175`）+ 小标签 + 说明；`待决定` 数字橙色。
  - **问题 I2｜卡片嵌套过深**：统计卡（一级白卡）+ `待决定` 大卡（一级）里再套条目卡（二级白卡），**卡中卡双描边**（`views.js:1999 cardView`），视觉偏重、层级拥挤。
  - **问题 I3｜统计数字字阶孤立**：`strong{font-size:29px;letter-spacing:-.06em}`（`styles.css:175`）与 overview 变体 `30px/-.04em`（`styles.css:1144`）**两套 stat 字号/字距**。
- **条目卡**：缩略方块（emoji `🔗/🖼/📝`，`views.js:2006`）+ eyebrow「灵感 尚未决定用途」+ 粗标题 + 等宽 `{not:project}` + 右侧竖排 `加入当前课程/保存为素材/忽略`。
  - **问题 I4｜emoji 当图标**：条目类型用 `🔗🖼📝` emoji（`views.js:2006`），与全站几何字符图标（`▤✎⚙✦`）混用，风格冲突、跨平台渲染不稳。
  - **问题 I5｜行动按钮竖排**：右侧 `加入当前课程/保存为素材`（secondary）+ `忽略`（文本钮）竖向堆叠（`styles.css:201 .inbox-actions`），与全站横向按钮行不一致，右列被拉高。

### A5. `publishView` —— 发布（截图：publish.png）

证据：`publish.png`；`views.js:2468-2574`；`styles.css:1718, 2564`。

- **标题区**：eyebrow「交付课程内容」+ H1「发布中心」+ 说明 + `运行导出前检查`（primary）。
- **概要条**：绿底通栏 `输出范围|当前课 · S01-01  输出格式|Markdown  兼容性|输出会降级`。
  - **问题 P1｜meta 条写法独特**：标签+值内联、绿底通栏，是全站唯一这种"信息条"，与别处 `properties`/`summary-card` 不共享组件。
- **步骤卡**：`01`（大灰数字）+`1. 选择输出范围`+说明+分段控件 `当前课·S01-01 | 整门课程`；`02`+`2. 输出布局与页面`+输入行 `输出页面尺寸 [各课保持原尺寸 ▾]`。
  - **问题 P2｜步骤编号重复**：大号 `01`/`02` **又** 在标题里写 `1.`/`2.`（`views.js:2571 publish-step`），同一序号出现两次，冗余。
  - **问题 P3｜分段控件非标准**：`当前课·S01-01 / 整门课程` 选中态是"绿字浅底"（`publish.png`），与参考"R12 灰容器 + R8 白色选中片 + 细描边"（§5.3）不符，也与 AI `.ai-scope` 的紫色选中态不一致（`styles.css:594`）——**三套分段控件**。
  - **问题 P4｜步骤卡数字与 settings 不一致**：publish 用**裸大灰数**，settings 用**绿色圆徽章**（见 A6），同一"分步"概念两套。

### A6. `settingsView` —— 设置（截图：settings.png）

证据：`settings.png`；`views.js:2840-2896`；`styles.css:1273, 1718`。

- **标题区**：eyebrow「项目偏好与账户」+ H1「项目设置」+ 说明。
- **子导航**：圆角容器内 `常规/保存与版本/AI 连接/模型/账户/项目` 文本项。
  - **问题 S1｜子导航选中态不明**：`常规` 与其它项视觉几乎无差（`settings.png`），缺清晰 active 指示（对比顶部 tabs 有绿色顶边 `styles.css:160`）。
- **分区**：`01`（**绿色圆徽章**）+「常规」+说明；下挂两张信息卡 `保存方式 / 当前界面`；`02`（绿圆）+「保存」+ `✓已保存` + `保存项目`（primary）`保存当前版本`（secondary）。
  - **问题 S2｜分步徽章与 publish 冲突**（同 P4）：settings 绿圆 vs publish 裸大数。
  - **问题 S3｜信息卡内部层级 OK，但留白**：`✓已保存` 与右侧按钮之间大片空白，卡片被拉宽、信息密度低（`settings.png` 底卡）。

### A7. 未捕获页面 —— 仅代码诊断，**未确认（无截图）**

> 以下页面缺截图，诊断基于 `views.js` DOM/类名 + `styles.css`，**视觉细节未确认**，整改前建议补截图复核。

| 页面 | view 函数 | 代码线索 | 推断问题（未确认） |
|---|---|---|---|
| 项目概览 hero | `overviewView` `views.js:1697` | `.overview-page .page-head` 用**绿色渐变** `linear-gradient(118deg,#123f36,#176a57 68%,#277962)`（`styles.css:1136`） | **唯一渐变 hero**，与其它扁平页头冲突；若铺开会加剧不一致 |
| 待补总览 | `backlogView` `views.js:1655` | `.summary-grid/.summary-card/.backlog-row/.req-dot/.status-pill` | 复用 summary-card（R9）+ req-dot(23px) + status-pill，规格同 A1/A4 问题 |
| 媒体库 | `mediaView` `views.js:2406` | `.media-page/.media-page-head` + `.media-document`（`styles.css:573` 等宽） | 缩略图/文档卡规格未证 |
| 映射预览 | `mappingView` `views.js:2379` | `.mapping-table/.mapping-status`（`styles.css:2404`） | 表格规格未证 |
| 制作看板 | `boardView` `views.js:2039` | `.kanban` 4 列 + `.kanban-card`（`styles.css:202`） | kanban 卡 R7 + `.kanban-card:hover{outline:2px solid #d9d4ff}`（**紫描边**） |
| Flow / 自由排版 / 预览 | `flowView/freeLayoutView/layoutView/previewView` | `.flow-*`、`.grid-canvas`、`.placement`（`styles.css:197, 808-830`） | **紫色大面积**：`.placement` 渐变紫、`.grid-canvas` 紫网格线、`.block.focused` 紫聚焦（见 §B6） |
| 启动页 / 项目库 | `launcherView/registryListView` `views.js:574,505` | `.launcher` 径向渐变紫底 `radial-gradient(...#f7f7ff...)`（`styles.css:207`） | 启动页紫色基调，与绿色主色不搭 |

---

## B. 全部一致性问题（grep 证据）

> 以下每条均有 `styles.css`/ `views.js` 的可复现 grep 计数。命令示例写在括号里。

### B1｜设计 token 被大面积绕过：硬编码颜色

- **硬编码 hex 出现在 120 行**（`grep -nE '#[0-9a-fA-F]{3,8}\b' styles.css | grep -v 'var(--' | wc -l` → **120**）。
- **去重后约 200+ 个不同 hex 值**（`grep -oE '#[0-9a-fA-F]{3,8}\b' | sort | uniq -c`），而 `--root` 只声明 15 个色彩 token（`styles.css:3-24`）。**绝大多数颜色在 token 之外**。
- `#fff` 出现 **56 次**、`#b3403f` **11 次**（一个**非 token 红**，与 `--danger #b44949` 仅一字之差却不同色，见 `.badge.warning{color:#b3403f}` `styles.css:279`）。
- **rgba() 字面量 25+ 种**，阴影/底色各写各的（见 B5）。

### B2｜圆角失控：15 种半径值

（`grep -oE 'border-radius: ?[^;]+;' | grep -oE '[0-9]+px' | sort | uniq -c`）

| 值 | 8px | 7px | 9px | 6px | 10px | 999px | 12px | 16px | 13px | 5px | 4px | 11px | 3px | 20px | 14px | 21px |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 次数 | 50 | 39 | 29 | 25 | 19 | 14 | 14 | 7 | 6 | 5 | 5 | 5 | 2 | 2 | 2 | 1 |

- token 只定义 `--radius-sm:7 / --radius-md:12 / --radius-lg:18`（`styles.css:26-28`），但实际用到 3,4,5,6,7,8,9,10,11,12,13,14,16,20,21 —— **15 种**，且最常用的 8px/9px 竟不是任何 token 值。`--radius-lg:18` 几乎不用。
- 参照规格 §5.3 是 6 档（R4/8/12/16/20/28）。当前圆角**既不成档、又不等于参照**。

### B3｜字阶失控 + 过小字号

（`grep -oE 'font-size: ?[^;]+;' | sort | uniq -c`）

- **24+ 种字号**。前三：`11px × 91`、`10px × 69`、`12px × 41` —— 全站正文被压缩到 10–12px。
- **大量低于 11px**：`10px(69)、9px(8)、10.5px、9.5px、8px` —— **中文在 8–10px 极难阅读**，是可读性硬伤。
- 跳档：8/9/10/10.5/11/12/12.5/13/14/15/16/17/18/20/21/22/25/27/28/29/30/32/36 + clamp。**无连续字阶**。
- token 只定义 `--type-label:11 / --type-small:12 / --type-body:14 / --type-section-title:18 / --type-page-title:clamp`（`styles.css:12-18`），但 91 处直接写 `11px` 而非 `var(--type-label)`。

### B4｜控件高度不统一：至少 8 档

（`grep -nE '(min-height|height): ?[0-9]+px' | grep -iE 'button|tab|control|input'`）

实测高度：**28 / 29 / 32 / 35 / 36 / 39 / 42 / 46px**。
- token：`--control-height:35px`、`--control-height-large:2.9rem(46.4)`、`--control-height-compact:2rem(32)`、`--icon-control-size:2rem(32)`（`styles.css:40-43`）。
- `.tab{height:35px}`→`39px`（`styles.css:116,1081`）、`.right-tab{42px}`、`.workbench-tab{42px}`、`.media-filter{29px}`、`.ai-model-row-head .text-button{28px}`、`.asset-card-actions button{28px}`、`.ai-save-button{36px}`。
- 参照规格：按钮 md=H36 / 行内=H28 / 输入=H32（§5.3）。当前 **35px 主控件高度本身就与参照 36px 差 1px**，且散出 29/39/42 等野值。

### B5｜阴影不统一：6+ 色系

（`grep -oE 'box-shadow: ?[^;]+;' | sort | uniq -c`）

- token 只有 `--shadow:0 14px 38px rgba(26,48,39,.08)`、`--shadow-soft:0 2px 12px rgba(26,48,39,.045)`（**绿调**）。
- 但实测 **20+ 种字面量阴影**，色系至少 6 种：
  - 绿调 `rgba(26,48,39,...)`、`rgba(26,48,39,.08)`
  - 蓝调 `rgba(30,30,60,...)`、`rgba(30,30,70,...)`、`rgba(24,24,50,.22)`、`#18223026`、`#15281c1a`
  - **紫调** `rgba(141,107,232,...)`、`rgba(98,85,216,...)`
- 模态框两套：`.modal{box-shadow:0 26px 70px rgba(24,24,50,.22)}`（`styles.css:231`）vs 另一处 `0 26px 70px rgba(17,32,26,.22)`。**同为模态、两种阴影色**。

### B6｜脱轨强调色：一整族"紫" + 冷灰中性（最严重）

**这是全站最刺眼的不一致，且违反"仅绿主色 + 语义四色"的克制原则。**

**紫色族（未在 token 声明）**，遍布布局/AI/焦点/进度：
- `#8d6be8 #8b7ff0 #9a8cf0 #cbc5ff #d7d2fb #c8c2fa #cfc9f7 #eae8ff #8982c9 #d9d4ff #e9e7ff` 及浅底 `#f1efff #f8f7ff #f5f3ff #eeecff #f0effc #f3f1ff`；rgba 版 `rgba(141,107,232,...) rgba(98,85,216,...)`。
- 典型处：
  - `styles.css:195 .block.focused{border-color:#8d6be8; box-shadow:0 0 0 3px rgba(141,107,232,.14)}` —— **正文块聚焦用紫**，而全局焦点是绿（`styles.css:62`）。**焦点色不统一**。
  - `styles.css:259 .progress-track > span{background:linear-gradient(90deg, var(--primary), #8b7ff0)}` —— **进度条绿→紫渐变**，主色里掺了脱轨紫。
  - `styles.css:594,598,665-666` AI 的 `ai-scope/ai-toggle/ai-model-chip` 选中态用 `border-color:#d7d2fb`、`background:#f5f3ff`（紫），**即便在已认可的 AI 页里，选中描边也是紫**。
  - `styles.css:197,295,298,808-830,936` 布局/网格/放置态大量紫底紫描边；`styles.css:207 .launcher` 启动页径向渐变紫底；`styles.css:202 .kanban-card:hover{outline:2px solid #d9d4ff}`（紫 hover）。
- **冷灰中性族（与暖绿 token 中性打架）**：`#7d8391 #5d6474 #b0b3be #a9adba #c6c8d1 #c9cad3 #e7e9f1 #e0e2eb #b9bdca #9aa0b0 #a5a8b3 #b2b5c0 #c0c3cf #b7bbc7 #cdd0dc #969baa`。
  - 用于次要文本/手柄/徽章：`.badge{color:#5d6474}`、`.stage-more-item.danger{color:#7d8391}`（**"危险"项居然是灰的**）、`.block-handle{color:#b7bbc7}`、`.breadcrumbs b{color:#c6c8d1}` 等。
  - 而 token 中性是暖绿：`--text:#1d2b27 / --muted:#61716b / --line:#e3e9e4 / --line-strong:#cbd6cf`。**两套中性色温并存**。

### B7｜状态 / 徽章组件多套并存

（`grep -nE 'class="[^"]*(badge|status-pill|task-dot|req-dot|dot)' views.js`）

- `.dot`（7px 绿，`styles.css:110`）、`.task-dot.orange/.purple/.blue`（7px，`styles.css:188`，**蓝 #63a7d8 又是脱轨色**）、`.req-dot.open/.done`（23px 圆，`styles.css:205`）、`.check.ok/.warning`（20px 圆，`styles.css:231`）、`.badge/.badge.done/.open/.warning`（**两套配色**：`styles.css:276-279` vs `1124-1127`）、`.status-pill/.is-done/.is-open/.is-warning`（多处）。
- **同一"状态点"概念有 7px / 20px / 23px 三种尺寸、5 种配色写法**，且状态徽章 `.badge` 有两套主题色。

### B8｜图标系统缺失：emoji + 几何字符混用

（node 扫描 `views.js` 非 ASCII 图形字符）

- **110 个图形字符实例、35+ 种不同字符**，混三类：
  - **emoji**：`📎🖼🔗📝⚠`（`views.js:2006,260,337,1071,226`）
  - **几何字符**：`▤▦▧▰○◎◉□✦`
  - **箭头/符号**：`→↑↓←↗↻↶↷▸▶⌄▾✓✕✎⚙⌂☰⌘⇧⌕◷↵`
- 无统一图标库/尺寸/描边；emoji 跨平台渲染不稳、风格与几何字符冲突（违反"图标应来自单一专业图标库"）。
- 参照规格图标是 16px 线性（stroke 1.3），当前图标字号 10–28px 乱跳。

### B9｜同名组件多写法（叠加覆盖）

| 组件 | 冲突写法 | 证据 |
|---|---|---|
| `.tab` | 35 / 37 / 39px 三高 + 两种圆角 | `styles.css:116,1081,1527` |
| `.badge` | 两套配色（冷灰组 vs 暖色组） | `styles.css:276-279,1124-1127` |
| `empty-state` | 4 种空态（虚线框/描边卡/裸浮文本/无结果） | `styles.css:206,541,1128,231` |
| 页头行动容器 | `.page-head-actions` vs `.map-actions` vs 裸按钮 | `views.js:791,1665,2024` |
| 分段/筛选选中 | `.filter.active` 绿 / `.ai-scope[aria-pressed]` 紫 / publish 绿字浅底 | `styles.css:201,594` + `publish.png` |
| stat 数字 | 29px/-.06em vs 30px/-.04em | `styles.css:175,1144` |

---

## C. 设计规范定案（可直接写进 CSS 变量）

> 原则：**在现有 token 基础上收敛 + 补齐，不推倒重来**；以已认可的 AI 模型设置页（§5.3/§5.4）为锚点；仅浅色主题；不引入 DeepSeek 品牌资产。
> 命名沿用现有 `--*`，值向参照规格对齐。**加粗 = 定案关键数值**。

### C1. 色板与层级（收敛 + 补齐）

保留语义四色与绿主色，**消灭紫色族与冷灰族**，新增状态浅底 token 收编散落的 tint。

```css
:root {
  /* 中性（暖绿，唯一色温） */
  --bg: #f2f4f1;          /* 应用底 */
  --panel: #fff;          /* 卡/面板 */
  --panel-muted: #f7f9f6; /* 次级面板/选中tab底 */
  --line: #e3e9e4;        /* 常规描边 */
  --line-strong: #cbd6cf; /* 强描边/输入框描边 */
  --text: #1d2b27;        /* 主文本 */
  --muted: #61716b;       /* 次文本（唯一 muted） */
  --muted-soft: #8c9a93;  /* 三级文本/占位/图标（收编冷灰族） */

  /* 主色（绿） */
  --primary: #14725f;
  --primary-dark: #0d5b4c;
  --primary-soft: #e6f2ee;

  /* 语义四色 + 浅底（收编所有硬编码 tint） */
  --green: #25805e;  --green-soft: #e6f7ee;
  --orange: #b96c35; --orange-soft: #fdf0e2;
  --danger: #b44949; --danger-soft: #fdeaea;   /* 统一，废 #b3403f */
  --blue: #3977a3;   --blue-soft: #eef6ff;
}
```

**规则**：`grep` 里出现的 `#7d8391/#5d6474/#b0b3be/#a9adba/#c6c8d1…` 全部 → `--muted` 或 `--muted-soft`；`#b3403f` → `--danger`；蓝灰描边 → `--line/ --line-strong`。**紫色族见 C10 与 D-G 项，全部替换**。

### C2. 字阶与行高（收敛到 8 档，设 11px 下限）

```css
:root {
  --type-caption: 11px;  /* 行高 1.35  徽章/标签/最小可读（FLOOR） */
  --type-small:   12px;  /* 行高 1.5   说明/次要 */
  --type-meta:    13px;  /* 行高 1.5   元信息/表单元 */
  --type-body:    14px;  /* 行高 1.65  正文 */
  --type-lead:    16px;  /* 行高 1.6   卡标题/引导 */
  --type-section: 18px;  /* 行高 1.4   H2（原 --type-section-title） */
  --type-subhead: 20px;  /* 行高 1.3   模态标题/大卡强标题 */
  --type-page:    clamp(27px, 2.3vw, 36px); /* 行高 1.13  H1（原 --type-page-title） */
  --type-stat:    28px;  /* 行高 1     统计大数字，字距 -.04em */
}
```

**规则**：
- **任何文本 ≥ 11px**（`8/9/9.5/10/10.5px` 全部 → `--type-caption 11px`，密集元信息可 → 12px）。
- `12.5/13px` → `--type-meta 13`；`15/17px` → `--type-body 14` 或 `--type-lead 16`；`21/22px` → `--type-subhead 20` 或 `--type-section 18`；`25/27/29/30/32/36px` 的 stat → `--type-stat 28`，display → `--type-page`/`--type-subhead`。
- 统一 stat：`--type-stat 28px / letter-spacing -.04em`（废 29/-.06em 与 30/-.04em 两套）。
- **`.eyebrow` 修正**（`styles.css:73,1111`）：`text-transform:uppercase; letter-spacing:.13em` 对中文是错的（CJK 无大小写、宽字距显松）。定案：中文 eyebrow 用 `letter-spacing:.04em; text-transform:none`，纯英文 eyebrow（FLOW/CANONICAL ORDER）保留 `.12em + uppercase`。→ 建议拆 `.eyebrow`（中文）与 `.eyebrow.en`（拉丁）。

### C3. 间距节奏（4px 栅格，消灭非栅格值）

```css
:root {
  --space-0: 0;  --space-half: 2px;
  --space-1: 4px;  --space-1-5: 6px;  --space-2: 8px;
  --space-3: 12px; --space-4: 16px;   --space-5: 24px;
  --space-6: 32px; --space-7: 48px;
}
```

**规则**：所有 `gap/padding/margin` 取上表之一（**偶数，优先 4 的倍数**）。当前 **216 处非栅格值**（`grep -oE '(gap|padding|margin…): ?[0-9]*(5|7|9|11|13|15|17|19|21|23)px' | wc -l` → **216**）与 **21 种 gap**（1..24）→ 就近归档（3/5→4，7/9→8，11→12，13→12/16，15→16，17/19→16/24）。

### C4. 圆角层级（6 档，对齐参照 §5.3）

```css
:root {
  --radius-xs: 4px;   /* 标签/徽章内、track-label */
  --radius-sm: 8px;   /* 行内按钮28/图标钮/分段片/小chip（原7→8） */
  --radius-md: 12px;  /* 输入32/按钮36/候选行/分段外层/行卡 */
  --radius-lg: 16px;  /* 内容卡/编辑卡/添加卡（原18→16） */
  --radius-xl: 20px;  /* 大面板/hero 卡/统计卡组 */
  --radius-2xl: 28px; /* 模态/对话框外壳 */
}
```

**规则**：15 种圆角就最近归档：3→4，5/6/7→8，9/10/11→12，13/14→12/16，21→20。**`--control-radius` 从 `--radius-sm` 改为按控件**：按钮 md=R12、行内/图标=R8。

### C5. 描边与阴影

**描边**：结构 1px `var(--line)`；强调 1px `var(--line-strong)`；空态/添加 1px dashed `var(--line-strong)`；状态色边 1px 语义色。（参照的 0.5px 发丝线依赖设备像素比，本次**不做**，见 D-N。）

**阴影（4 级，全绿调 rgba(26,48,39)）**：
```css
:root {
  --shadow-soft: 0 2px 8px rgba(26,48,39,.06);        /* 卡片静置 */
  --shadow:      0 8px 24px rgba(26,48,39,.12);       /* 悬浮卡/菜单/下拉 */
  --shadow-modal:0 26px 70px rgba(26,48,39,.18);      /* 模态 */
  --shadow-ring: 0 0 0 2px var(--primary-soft);       /* 轻焦点/选中环 */
}
```
**规则**：废除所有 `rgba(30,30,60/70)`、`rgba(24,24,50)`、`rgba(141,107,232)`、`#18223026`、`#15281c1a` 等字面量，映射到上述 4 级。模态两套 → 统一 `--shadow-modal`。

### C6. 控件规格（对齐参照 §5.3/§5.4）

| 控件 | 规格 | 备注 |
|---|---|---|
| 按钮 md（primary/secondary） | **H36 / R12 / padding 0 14px / 14px·22px / 600** | 现 H35/36、R7 → 定案 |
| 按钮 sm / 行内 | **H28 / R8 / padding 0 10px / 13px** | 收编 28/29px 野值 |
| 按钮 big（页面主 CTA） | **H44 / R12 / padding 0 20px** | 收编 `.big 46px` |
| 图标钮 icon-button | **28×28 / R8 / icon 16px** | 现 32px/17px → 收敛 |
| 输入/下拉/文本域 | **H32 / R12 / padding 0 10px / 14px·22px / 描边 --line-strong** | AI 页已达标，铺全站 |
| 复选/单选 | 15×15 / accent --primary | 保持 |
| 开关 switch | 轨 36×20 R10 / 拇指 16 / 滑 180ms | 现状未确认，给定值 |
| 分段控件 | 外层 **R12 / bg --panel-muted / padding 4px**；片 **H28 / R8**；选中 **bg --panel + 1px --line + --shadow-soft**；未选 transparent/--muted | **替换紫选中态**，对齐 §5.3 |
| 状态点 status dot | **8px 正圆**（`--dot-size:8px`） | ⚠️ 分歧见下 |
| 徽章 badge | **pill R999 / H22 / padding 0 8px / 11px·16px / 600**；`bg=语义-soft, color=语义` | 收编两套 badge |
| 标签 tag | R4 / H20 / 11px | 类目 |

> **状态点尺寸分歧（标注）**：任务简报写「6px 状态点」，但参照规格 §5.4 `credentialDot` 与 §4.4 实测均为 **8px**，现有代码 `.dot/.task-dot` 为 **7px**（`styles.css:110,188`）。三者不一致。**本定案取 8px**（与已认可的参照规格一致）；若必须贴合简报可改 6px，但会与参照证据相悖 —— **未确认用户最终取向**。

### C7. 卡片与面板

- **内容卡**（summary-card / surface-card / inbox-card / stage-card / backlog-group）：`bg --panel` + `1px --line` + **R16** + `--shadow-soft` + padding **16px**（收编现 9px 圆角/乱内距）。
- **编辑/内嵌卡**（ai-provider-editor / 编辑态）：**R16** + padding 14–16px + gap 14px。
- **大面板/hero**（页头卡、统计组、空态大框）：**R20**。
- **模态/对话框**：**R28** + `--shadow-modal`。
- **行卡**（表格子行、候选行）：**R12**。
- 卡内层级统一三层：`caption 标签(11px --muted) → lead 强标题(16px 600) → body 说明(13/14px --muted)`。

### C8. 表格与列表

- 表头：`--type-meta 13px / --muted / 600`，行高固定，底 `--panel-muted`，下描边 `--line`。
- 分组行（S01/S02）：底 `--panel-muted`，与子行（`--panel`）用描边而非色块分隔；子行 hover → `--panel-muted`。
- 行高/密度：数据行 **min-height 52px**（现 map-item/structure-row 60–65px 偏松，inbox 52px），元信息 11–12px。
- 行操作图标：**统一 5 个 → 归纳为「图标钮 28×28 / R8 / gap 4px」**，hover 才显 (`.row-actions{opacity:0} .row:hover .row-actions{opacity:1}`)，禁用态 `opacity .35`（现已有）+ 统一 hover 反馈。
- 排序/拖拽手柄：`--muted-soft` 16px（收编冷灰 `#b7bbc7`）。

### C9. 空态与加载态（收编 4 种空态为 1 种）

- **空态**（唯一 `.empty-state`）：居中；`.empty-icon` = **48px** 正圆 `bg --primary-soft / color --primary / glyph 22px`（现 60px/28px 收敛）；标题 `--type-lead 16px/600`；正文 `--type-small 12px --muted`，max-width 420px；下接按钮行（`action-row`）。变体仅 `.inline`（虚线 1px --line-strong R16 小框，用于卡内空态）。
- 废除"裸浮文本"式空态（editor「需要配图」应改为空态/占位卡，见 D-P）。
- **加载态**：统一 `.spinner`（16px 线性转圈）+ `.skeleton`（`--panel-muted` 微光条）。**修左栏「待加载」徽章换行 bug**（见 D-P/左栏）：`待加载` 因容器过窄断成「待加/载」，应 `white-space:nowrap` + 足够 min-width。

### C10. 焦点与 hover（统一，去紫）

- **焦点（唯一）**：`:focus-visible{ outline:2px solid var(--primary); outline-offset:2px; }`（保留现有 `styles.css:62` 的做法），**删除** `.block.focused` 的紫描边紫环（`styles.css:195`）→ 改 `border-color:var(--primary); box-shadow:0 0 0 3px var(--primary-soft)`。
- **hover**：文字/图标 → `--primary`；带描边控件 → `border-color:var(--primary) + color:var(--primary)`；实底按钮 → `--primary-dark`；卡 → `bg --panel-muted`。**所有 `#d9d4ff/#cbc5ff/#d7d2fb` 紫 hover → `--primary-soft`**。
- 选中态统一：`bg --primary-soft + color --primary(-dark) + border var(--primary)`（或参考的白片+细描边，用于分段控件）。

### C11. 动效时长与缓动（收敛）

```css
:root {
  --motion-fast: 120ms;        /* 颜色/图标微反馈 */
  --motion-standard: 180ms;    /* 背景/描边/hover */
  --motion-emphasized: 220ms;  /* 展开/滑块/进入 */
  --ease-standard: cubic-bezier(.2,.7,.2,1);
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```
**规则**：仅允许 `background-color/border-color/color/box-shadow/opacity/transform` 过渡，≤220ms。**修 reduced-motion 覆盖不全**：现仅 2 处局部规则（`styles.css:302,1385`），改为全局（如上）。

---

## D. 整改清单（可执行）

> 排序：**全局 token → 通用组件 → 逐页**。每条含【改哪/改成什么/为什么/预期/风险】。
> **风险图例**：🟢 纯 CSS，不动 DOM/类名，测试安全｜🟡 改 CSS + 轻动 class 拼接，需核对测试｜🔴 动 DOM/类名/结构，测试高风险（已标注可能踩到测试）。
> 档位：**必做（影响美学明显）/ 建议（质量加分）/ 不做（超出范围）**。

### D-I. 全局 token（先做，最高杠杆）

| # | 档 | 改哪 | 改成什么 | 为什么 | 预期 | 风险 |
|---|---|---|---|---|---|---|
| G1 | 必做 | `styles.css:3-43 :root` | 落地 §C1 色板：新增 `--muted-soft/--green-soft/--orange-soft/--danger-soft/--blue-soft`；`--danger` 收编 `#b3403f` | 收编 200+ 硬编码色到 token | 全站色温统一、可一处调色 | 🟢 |
| G2 | 必做 | `styles.css:26-28` + 全文件 | 圆角改 §C6 六档 `--radius-xs..2xl`（sm 7→8、lg 18→16、新增 xl 20/2xl 28）；全文件 15 种圆角就近归档 | 15 种圆角不成体系 | 圆角成清晰阶梯 | 🟢 |
| G3 | 必做 | `styles.css:12-18` + 全文件 | 字阶改 §C8 档；**全站字号 ≥11px**；10/9/8px→11px；stat 统一 28px/-.04em | 中文 8–10px 不可读、字阶乱 | 可读性提升、字阶连贯 | 🟢（`clamp(8px,1vw,…)` 两处留意） |
| G4 | 必做 | 全文件 gap/padding/margin | 216 处非栅格值 → §C3 4px 栅格 | 间距无节奏 | 竖向节奏均匀 | 🟢 |
| G5 | 必做 | `styles.css` 20+ 阴影 | 阴影 → §C5 四级（全绿调）；模态两套→`--shadow-modal` | 6 种阴影色打架 | 表面层级统一 | 🟢 |
| G6 | 必做 | `styles.css:40-43` 控件高度 | 按钮/输入/图标钮/行内高度 → §C6（H36/32/28/44）；`--control-height:35→36px` | 8 档控件高度 | 控件规整对齐 | 🟢 |
| G7 | 必做 | 全文件紫色/冷灰 | **紫族 → 绿/主色-soft**（focus/hover/placement/grid/progress/ai-scope/launcher/kanban）；**冷灰 → --muted/--muted-soft** | 脱轨强调色，最刺眼 | 恢复"绿主色+语义四色"克制 | 🟢 |
| G8 | 建议 | `styles.css:73,1111 .eyebrow` | 拆 `.eyebrow`（中文 `.04em` 无 uppercase）/`.eyebrow.en`（拉丁保留） | uppercase+宽字距对中文是错的 | 标签呼吸正常 | 🟡（改 class 需核对测试引用） |
| G9 | 建议 | `styles.css:302,1385` | reduced-motion 改全局（§C11） | 现覆盖不全 | 无障碍达标 | 🟢 |
| G10 | 建议 | `styles.css:62` 焦点 | 统一 `:focus-visible` 2px 主色 outline（去紫焦点环） | 焦点色绿/紫不一 | 焦点一致可辨 | 🟢 |

### D-II. 通用组件（跨页复用，收敛多写法）

| # | 档 | 改哪 | 改成什么 | 为什么 | 预期 | 风险 |
|---|---|---|---|---|---|---|
| C1 | 必做 | `styles.css:276-279 + 1124-1127` `.badge` | 合并两套 badge 为一套（§C6 pill H22/R999，`语义-soft` 底 + 语义字） | 两套 badge 配色 | 状态徽章统一 | 🟢 |
| C2 | 必做 | `styles.css:110,188,205,231` 状态点 | 统一状态点：**8px**（`--dot-size`），语义色；`req-dot/check` 归为"状态圆标"统一规格 | 7/20/23px 三种状态点 | 状态指示一致 | 🟢 |
| C3 | 必做 | `styles.css:206,541,1128,231` 空态 | 收编 4 种空态为 `.empty-state`(+`.inline`)（§C9）；`.empty-icon` 60→48px | 空态随意 | 空态统一、克制 | 🟢 |
| C4 | 必做 | `styles.css:594,598,665` 分段/筛选选中 + `publish` | 分段控件 → §C6（外 R12 灰容器 + R8 白片）；`.filter.active`/ai-scope 选中去紫 | 三套分段/选中控件 | 选中态统一 | 🟢 |
| C5 | 必做 | `styles.css:116,1081,1527` `.tab` | 统一 tab 单一高度（39px）与圆角（`9px 9px 0 0` 或 R8 顶角），删 35/37 覆盖 | 同名 tab 三高 | 标签栏整齐 | 🟢 |
| C6 | 建议 | `styles.css` 按钮族 | primary/secondary/text/icon → §C6 规格；行内变体 28/R8；`.big` 44 | 按钮高/圆角不齐 | 按钮成族 | 🟢 |
| C7 | 建议 | `views.js` 图标（多处） | 图标统一为单一图标库（如 Lucide/内联 SVG），16px 线性；**替换 emoji `📎🖼🔗📝⚠` 与几何字符** | emoji+几何字符混用 | 图标风格统一、跨平台稳 | 🔴 **动 DOM/文案节点**，图标是文本节点被测试断言风险高（见 E） |
| C8 | 建议 | `styles.css:175,1144` stat | 统一 stat 28px/-.04em | 两套 stat | 数字统一 | 🟢 |
| C9 | 建议 | `styles.css` loading | 新增 `.spinner/.skeleton`；修左栏「待加载」换行 | 加载态随意/换行 bug | 加载态专业 | 🟢（skeleton 新增类，慎改旧类名） |

### D-III. 逐页

| # | 档 | 页 | 改哪 | 改成什么 | 为什么 | 预期 | 风险 |
|---|---|---|---|---|---|---|---|
| P1 | 必做 | map（A1） | `views.js:791 map-actions` | 主 CTA `＋新建课程内容` 置于右上单列/首位，不折行；secondary 组在其左/下 | 主次行动失衡 | 主行动醒目 | 🟡（改 `.map-actions` 布局顺序，类名可保留） |
| P2 | 必做 | map（A1） | `views.js:807-842` 行 | 状态统一为「徽章（状态色 pill）」单一表达；`▶状态/▶1项待补` 去三角前缀改纯文本或徽章 | 状态三写法 | 表格易扫 | 🔴 **改行内节点/文本前缀**，测试可能断言「▶状态」等字符串/结构（见 E） |
| P3 | 必做 | map（A1） | `styles.css` 行操作 + `views.js:842` | 5 图标钮 → 28×28/R8/gap4，hover 显现；统 hover | 行操作过密无规格 | 行清爽 | 🟡 |
| P4 | 必做 | editor（A2） | `editor.png`「需要配图」/`views.js` writingView 空态 | 孤立浮文 → `.empty-state.inline` 占位卡（§C9） | 空态随意，观感最差 | 空态专业 | 🟡（占位文本节点，测试可能查「需要配图」） |
| P5 | 必做 | editor（A2） | 底素材卡 `styles.css:195` `.block` | 卡材质 → §C7 内容卡（R16、bg --panel、描边 --line）；按钮组 → C6 | 卡材质/按钮不齐 | 卡统一 | 🟢 |
| P6 | 建议 | editor（A2） | `.breadcrumbs b`（`styles.css:189`） | 冷灰 `#c6c8d1` → `--line-strong` | 冷灰脱轨 | 面包屑统一 | 🟢 |
| P7 | 必做 | explorer（A3） | `views.js:2210` 双主 CTA | 保留一处主行动（空态内），右上改 secondary 或去掉 | 双绿主 CTA 冗余 | 层级清晰 | 🟡（删/降级按钮，测试可能查「选择资料文件夹」按钮存在） |
| P8 | 建议 | inbox（A4） | `views.js:1999 cardView` + `styles.css:201` | 去卡中卡：条目卡改为列表行或降描边；行动按钮竖排→横排 | 嵌套过深、按钮竖排 | 列表轻盈 | 🟡（动 `.inbox-actions` 布局） |
| P9 | 必做 | publish（A5） | `views.js:2571 publish-step` | 去重复编号：保留 `01/02` 或 `1./2.` 其一 | 序号双写 | 步骤清爽 | 🟡（删一处序号文本，测试可能查「1.」） |
| P10 | 必做 | publish（A5） | 分段 `当前课/整门课程` | → C4/C6 标准分段控件（去绿字浅底） | 分段非标准 | 控件统一 | 🟢 |
| P11 | 建议 | publish/settings | 分步徽章统一（publish 裸数 vs settings 绿圆） | 统一为「绿圆徽章」或「裸数」一种 | 同概念两写法 | 一致 | 🟡 |
| P12 | 必做 | settings（A6） | `常规/保存与版本/…` 子导航 | 加清晰 active（bg --panel + 底/顶主色条，对齐顶部 tabs `styles.css:160`） | 选中态不明 | 导航可辨 | 🟡（加 active 类，需核对测试断言 active 项） |
| P13 | 建议 | settings（A6） | `.page-head` 底部 `✓已保存` 卡 | 收紧留白/对齐（`justify-between` 使信息靠拢或限宽） | 留白失衡 | 密度均衡 | 🟢 |
| P14 | 必做 | overviewView（A7） | `styles.css:1136` 绿渐变 hero | **评估**：与扁平页头统一（去渐变，改 `--panel/--radius-xl` 卡）或明确保留为特色 | 唯一渐变 hero 冲突 | 全站页头统一 | 🟡（若测试断言 hero 类名/结构） |
| P15 | 建议 | 左栏（全页共有） | `待加载` 徽章换行（`overview/media.png`） | `white-space:nowrap` + min-width，或 `.skeleton` | 文字断行 bug | 左栏整洁 | 🟡 |

### 三档条数统计

- **必做**：G1–G7（7）+ C1–C5（5）+ P1,P2,P3,P4,P5,P7,P9,P10,P12,P14（10）= **22 条**
- **建议**：G8,G9,G10（3）+ C6,C7,C8,C9（4）+ P6,P8,P11,P13,P15（5）= **12 条**
- **不做（超范围）**：见 §E 红线与下列 **6 条**
  1. 深色主题（本次仅浅色，`styles.css:2 color-scheme:light`）
  2. 0.5px 发丝描边（设备像素比依赖，沿用 1px）
  3. 字体家族更换（Inter/衬线阅读体保留；问题在字阶不在字族）
  4. 品牌资产/插画引入（不引入 DeepSeek 资产）
  5. 产品功能/交互逻辑/文案语义改动
  6. 图标库大规模引入（C7 列为"建议"且标 🔴；若测试契约紧，本次可只做 emoji→同族几何字符的最小替换，或暂缓）

---

## E. 范围与红线（含测试契约风险）

### E1. 范围
- **只做**视觉与交互质感：色/字/距/圆角/描边/阴影/控件规格/空态加载/焦点 hover/动效。
- **不做**产品功能、数据逻辑、交互流程、**中文文案语义**。

### E2. 红线（硬约束）
1. **中文文案逐字保留**（被测试断言）：`遇到/需要配图/待加载/选择资料文件夹/新建课程内容/待研究/起草中/齐全/无待补` 等字符串**不得改字**。整改只动样式，不动词。
2. **测试断言的 DOM 结构与类名不得破坏**：另一 agent 正在盘点测试契约；本规范仅**标注风险**，不擅自改结构。
3. **仅浅色主题**（`styles.css:2 color-scheme:light`）。
4. **不引入 DeepSeek 品牌资产**（含其蓝 `#4176e6`）；参照规格里的品牌色仅作美学参考。
5. **不推倒重来**：在现有 token 上收敛/补齐。

### E3. 可能踩到测试的地方（重点标注，🔴/🟡）

> 提醒：测试可能按「可见文案字符串」「aria-label」「data-action」「class 组合」断言。以下改动触及这些面，实施前**必须**与测试契约盘点 agent 对齐：

1. **🔴 P2 / C7 —— 行内状态前缀与图标**：`▶状态`、`▶1 项待补`、emoji `🔗🖼📝`、几何字符 `▤✎⚙✦` 都是**文本/图形节点**。若测试用 `textContent` 或 `getByRole('img', {name})`/`getByText` 断言，替换图标或去三角前缀会**直接 break**。→ 建议：图标先"同族替换"（emoji→内联 SVG 但保留 `aria-label` 与可见兜底），或暂缓。
2. **🟡 P7 —— 按钮存在性**：去掉/降级 `选择资料文件夹` 按钮若测试 `getByRole('button', {name:'选择资料文件夹'})` 会失败。→ 保留按钮、仅改视觉层级更安全。
3. **🟡 P9 —— 步骤序号文本**：删 `1.`/`2.` 或 `01`/`02` 之一，若测试查该字符串会失败。→ 优先只改 CSS 字号/颜色，不动文本。
4. **🟡 P12 —— 子导航 active**：新增/改 active 类名若测试按 class 断言。→ 优先用现有类 + CSS，勿改 class 字符串。
5. **🟡 G8 —— `.eyebrow` 拆类**：若测试按 `.eyebrow` 选中元素，拆成 `.eyebrow`/`.eyebrow.en` 时**保留 `.eyebrow` 基类**不动，仅新增修饰类。
6. **🟡 P1/P4/P8/P15 —— 布局与空态**：改 flex 顺序/增删包裹节点可能影响按 DOM 顺序或 `nth-child` 的断言。→ **纯 CSS 优先**（用 `order`/`flex` 调整，不改节点顺序）。
7. **🟢 安全面**：D-I 全部 token/色/圆角/字号/阴影/间距改动（G1–G7,G9,G10）与大部分组件 CSS（C1–C6,C8,C9）**不动 DOM/类名/文案**，是测试安全区，可先行。

### E4. 未确认清单
- overviewView / backlogView / mediaView / mappingView / boardView / flowView / layoutView / previewView / launcherView / registryListView 的**真实视觉**（无截图，仅代码推断）。
- 状态点最终取 **6px（简报）还是 8px（参照规格）** —— 本定案取 8px，需用户确认。
- editor 底卡 `**Markdown**` 原始语法显示**是否产品预期**（若是渲染 bug 属功能范围，不归本次视觉整改）。
- `ui-primitives` 内 SegmentedControl/Switch/Checkbox 的精确尺寸（参照规格 §5.4 标注"未确认"），本规范给的是**建议定值**。
- 各 view 与截图的精确 1:1 映射（如 `mapView` 表格是否即截图所示）—— 已由 `centerView()` 路由表佐证 `overview 路由→mapView`，其余按内容判断，未逐帧核对。

---

*本文档为设计规范与整改清单，供实施 agent 照改；实施前请先与测试契约盘点 agent 对齐 §E3 的 7 处风险点。*
