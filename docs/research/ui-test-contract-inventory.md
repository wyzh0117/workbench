# UI 整改不可破坏清单 — 测试逐字契约盘点

> 盘点对象：本仓库 tests/ 下全部 56 个测试文件（45,637 行）中对 **DOM 结构 / class / data-* / 逐字文案 / 元素顺序** 的断言。
> 基线：`deno task test` → **773 passed / 0 failed**（本盘点当日实测复核，35s）。
> 用途：视觉整改（app/styles.css 为主、app/views.js 少量 DOM/类名）前的“不可破坏清单”。
> 结论先行：**只改 styles.css 并非零风险** —— 有 67 处断言把 styles.css 当纯文本/正则断言（其中 22 条是逐字 CSS 规则字符串）；真正零风险的是 556 个测试从未引用的 class。

---

## 0. 数字总览

| 分类 | 条数 | 定义 |
|---|---|---|
| 【硬锁定】改动必挂的断言 | **327 处** | DOM/属性 179 + styles.css 文本与正则 67 + views.js/main.js 等 JS 源码文本 81 |
| 【文案锁定】逐字字符串 | **256 条**（distinct） | 渲染进 UI 的按钮/标签/状态/提示逐字文本（另有 107 条断言的是测试夹具文本，见 §3.9） |
| 【结构性锁定】类名/属性/顺序 | **179 条**（distinct） | 其中 data-* 属性 70 种、class 135 种、元素顺序/包含/计数 12 处 |
| 【可动】安全区 | **556 个 class** | 出现在 app 的 HTML 模板里、但测试全文零引用 |
| （附）native 壳源码锁 | 144 处 | native_boundary_test.ts 对 src-tauri/lib.rs 与 app.js 的源码文本断言，与 UI 整改无关，但改 native 文件会挡 |

> 三个分类存在交叉：文案/结构锁定都是“会挂”的硬锁，只是按锁定对象切了两个视图。

**四类断言形态**（后文标注用）：

| 代号 | 形态 | 例子 | 影响 |
|---|---|---|---|
| A | 渲染 HTML 断言 | `root.innerHTML.includes('class="ai-add-card"')`、`assertContains(markup, "已选 3 / 3 项")` | 改 DOM / class / 文案即挂 |
| B | 源码文本断言 | `viewsSource.includes('data-action="add-stage"')`、`styles.includes("--control-height: 35px")` | 改**源文件里的字面文本**即挂（哪怕行为不变） |
| C | CSS 正则断言 | `/\.block\.selected\s*\{[^}]*box-shadow:\s*inset 3px 0 0/.test(styles)` | 锁 CSS 选择器+属性值，换写法/换值即挂 |
| D | 顺序/计数断言 | `addEditor > addCard && addCard > rows`、`(markup.match(/class="document-import-group"/g)).length === 3` | 锁元素相对顺序、唯一性、数量 |

---

## 1. 【硬锁定 · styles.css】视觉整改的红线

> ⚠️ 本次盘点最重要的发现：**styles.css 本身被当文本断言**。下列规则改一个字符都会挂测试，且多数只给“必须存在这条规则”的低层自由度——排版数值、选择器、花括号写法都被锁。

### 1.1 逐字 CSS 文本锁（改动必挂，形态 B）

来源 `tests/workbench_ui_test.ts`（“Workbench shell keeps one collapse control per local sidebar” 与 “shared controls align core workbench surfaces without losing compact exceptions”）：

| 断言原文（needle） | file:line | 含义 |
|---|---|---|
| `.workspace { display: grid; grid-template-columns: 228px minmax(430px, 1fr) 286px;` | tests/workbench_ui_test.ts:103 | 三栏宽度逐字锁死（左 228 / 右 286） |
| `.shell.left-collapsed .workspace { grid-template-columns: 30px minmax(430px, 1fr) 286px; }` | tests/workbench_ui_test.ts:104 | 左栏折叠后 30px 轨 |
| `.shell.right-collapsed .workspace { grid-template-columns: 228px minmax(430px, 1fr) 30px; }` | tests/workbench_ui_test.ts:105 | 右栏折叠后 30px 轨 |
| `.shell.left-collapsed.right-collapsed .workspace { grid-template-columns: 30px minmax(430px, 1fr) 30px; }` | tests/workbench_ui_test.ts:106 | 双折叠 |
| `.left-collapsed .left-panel, .right-collapsed .right-panel { visibility: visible; }` | tests/workbench_ui_test.ts:107 | 折叠后面板保留可见的展开控件 |
| `.left-collapsed .left-panel nav` 与 `.right-collapsed .right-panel .right-content` | tests/workbench_ui_test.ts:108 | 折叠态隐藏内容的两个选择器 |
| `@media (max-width: 1150px)` | tests/workbench_ui_test.ts:109 | 窄屏断点文本逐字 |
| `--control-height: 35px` | tests/workbench_ui_test.ts:168 | 共享控件高度令牌值 |
| `--statusbar-height: 30px` | tests/workbench_ui_test.ts:169 | 状态栏高度令牌值 |
| `.overview-page .page-head .secondary { color: var(--primary-dark); }` | tests/workbench_ui_test.ts:171 | 整条规则逐字 |
| `min-height: var(--control-height);` | tests/workbench_ui_test.ts:178 | 标准控件最小高度声明文本 |
| `height: var(--icon-control-size);` | tests/workbench_ui_test.ts:179 | 图标控件高度声明文本 |
| `.field-label input, .field-label textarea` 与 `padding: 8px 10px` | tests/workbench_ui_test.ts:180 | 输入内边距逐字 |
| `.panel-heading {` 与 `height: 48px;` | tests/workbench_ui_test.ts:181 | 左栏标题高度 |
| `.right-tabs {` 与 `height: 48px;` | tests/workbench_ui_test.ts:182 | 右栏标签条高度 |
| `.side-head {` 与 `min-height: 36px;` | tests/workbench_ui_test.ts:183 | 右栏小节标题高度 |
| `.modal-head {` 与 `align-items: center;` | tests/workbench_ui_test.ts:184 | 弹窗头对齐 |
| `.modal > .modal-actions { min-height: var(--control-height); }` | tests/workbench_ui_test.ts:185 | 弹窗底部动作条（注意**直接子选择器**） |
| `.modal-actions.compact .secondary { min-height: var(--control-height-compact);` | tests/workbench_ui_test.ts:186 | 紧凑动作行 |
| `.statusbar > span {` 与 `text-overflow: ellipsis;` | tests/workbench_ui_test.ts:187 | 状态栏文本截断 |
| `bottom: calc(var(--statusbar-height) + 16px);` | tests/workbench_ui_test.ts:188 | toast 相对状态栏的偏移 |
| `.markdown-rich-editor[data-empty="true"]::before` | tests/dogfooding_test.ts:1004 | 空态提示必须是伪元素装饰 |

### 1.2 CSS 正则锁（选择器 + 属性值，形态 C）

| 契约 | 断言原文（正则/组合） | file:line |
|---|---|---|
| 按钮族共享 inline-flex | `/\.primary, \.secondary, \.text-button, \.icon-button, \.mode-button, \.filter\s*\{[\s\S]*?display: inline-flex/` | tests/workbench_ui_test.ts:175 |
| 右栏禁横向滚动 | `/\.right-content\s*\{[^}]*overflow-x:\s*hidden/s`（或 `.right-panel`） | tests/ui_test.ts:100-104 |
| requirement 动作换行 | `.requirement-actions` + `/requirement-actions[^}]*flex-wrap:\s*wrap/s` | tests/ui_test.ts:105-108 |
| requirement 文本折行 | `/requirement-body[^}]*(overflow-wrap|word-break)/s` 或 `requirement-item` 同义 | tests/ui_test.ts:110-116 |
| 版本卡三列网格 | `.versions-page .version-card` 内 `display: grid` + `grid-template-columns: auto minmax(0, 1fr) max-content` | tests/ui_test.ts:123-130 |
| 版本主列纵向堆叠 | `.versions-page .version-card > .version-main` 内 `flex-direction: column` + `min-width: 0` | tests/ui_test.ts:124,131-134 |
| 版本标题行 flex | `.versions-page .version-row-title` 内 `display: flex` | tests/ui_test.ts:125,135-138 |
| 危险按钮不铺红底（反向锁） | `!/(?:^|[^\w-])\.danger\s*\{\s*background:\s*#b74949\s*;\s*\}/m` | tests/p2_interaction_test.ts:426-430 |
| 图标危险按钮透明 | `/\.icon-button\.danger\s*\{[^}]*background:\s*transparent/m` | tests/p2_interaction_test.ts:429 |
| 危险 hover 用色不用底 | `.icon-button.danger:hover` + `color: #b3403f` | tests/p2_interaction_test.ts:433-434 |
| 带文字危险 CTA 保底色 | `/\.primary\.danger\s*\{[^}]*background:\s*var\(--primary\)/` + `color:\s*#fff` | tests/p2_interaction_test.ts:438-439 |
| 区块外框尺寸令牌 | `--block-outer-small: 100px` / `--block-outer-medium: 196px` / `--block-outer-large: 354px` | tests/p2_interaction_test.ts:450-462 |
| 旧 96px 令牌必须消失（反向锁） | `!/\.block-kind-short\.block-size-small\s*\{\s*max-height:\s*96px/` | tests/p2_interaction_test.ts:463-467 |
| textarea 不可手动缩放 | `/\.block-text,\s*\.block-heading\s*\{[^}]*resize:\s*none/m` | tests/p2_interaction_test.ts:468 |
| 选中块左侧强调条 | `/\.block\.selected\s*\{[^}]*box-shadow:\s*inset 3px 0 0\s+var\(--primary\)/m` | tests/p2_interaction_test.ts:478-480 |
| 拖放指示样式存在 | `/\.block\.drop-before\s*\{/` | tests/p2_interaction_test.ts:483 |
| 工具栏按钮不折行 | `/\.writing-toolbar\s*>\s*button\s*\{[^}]*white-space:\s*nowrap/m` | tests/p2_interaction_test.ts:487 |
| 区块操作默认隐藏且三种显示时机 | `.block-head-actions { visibility: hidden` + `.block:focus-within .block-head-actions` + `.block.menu-open .block-head-actions` + `@media (hover: none)` | tests/p2_interaction_test.ts:491-493 |
| 区块 chrome 是离浮层 | `.block-head` 规则 ≥2 条，其中一条含 `position: absolute` + `visibility: hidden` + `opacity: 0` | tests/editor_compile_test.ts:744-750 |
| chrome 三种揭示 | `/\.block:hover \.block-head,[\s\S]{0,200}?\.block:focus-within \.block-head[\s\S]*?\{[^}]*visibility: visible/` | tests/editor_compile_test.ts:753-755 |
| 区块无白卡容器 | `/\.block \{[^}]*background: transparent/` | tests/editor_compile_test.ts:757-760 |
| 源码模式不留孤儿 CSS（反向锁） | `!/\.markdown-inline-toolbar|\.markdown-format-button|\.markdown-source-field/` | tests/editor_compile_test.ts:761-765 |
| 预览状态铺满画框 | `.asset-preview-frame .<state>` 中至少一条同时含 `height: 100%` 与 `width: 100%`；`.asset-card-media > .asset-preview-frame` 含 `height: 100%` | tests/media_preview_stability_test.ts:1454-1492 |

### 1.3 styles.css 整改的安全边界

- **可以自由改**：颜色令牌（不含上表锁的 `#b3403f`/`var(--primary)` 组合）、圆角、普通阴影（除 `.block.selected` 的 inset 阴影）、间距（不触及上表数值）、字体、过渡动画、未列名选择器的任何视觉属性。
- **不能动**：§1.1 的 22 条逐字片段（含每条里的 px 值与选择器拼写）、§1.2 的 23 组正则契约（含 `100px/196px/354px`、`#b3403f`、`inset 3px 0 0`、`35px/30px/48px/36px` 等值）。
- **改写法也会挂**：`styles.includes` 是纯子串匹配——把 `.workspace { display: grid; grid-template-columns: ...;` 拆行、换声明顺序、把 px 改 rem、加注释，都会挂 workbench_ui_test。

---

## 2. 【硬锁定 · JS 源码文本】views.js / main.js 也被当文本断言

> 形态 B。测试直接读源文件断言字面文本（含模板字符串与 case 分支），重构 JS 代码但保持行为不变也会挂。

| 断言原文 | file:line | 锁定对象 |
|---|---|---|
| `source.includes("__workbenchReady = store.initialize();")` | tests/ui_test.ts:58 | main.js 启动语句 |
| `source.includes("event.stopPropagation();")` | tests/ui_test.ts:62 | main.js 标签关闭逻辑 |
| `source.includes('event.key === "Enter"')` | tests/ui_test.ts:66 | 命令面板键盘 |
| `source.includes("snapshotId: input.snapshot_id")` | tests/ui_test.ts:70 | 快照写入字段 |
| `source.includes("const invoke = globalThis.__TAURI__?.core?.invoke;")` 等 | tests/ui_test.ts:74-75 | 壳守卫写法 |
| `source.includes('requirement.scope === "layout"')` | tests/ui_test.ts:80 | 导出过滤条件 |
| `source.includes('} from "./ai.js";')`、`'case "ai-run": void store.aiRun(); return;'` | tests/ui_test.ts:84-86 | AI 面板共享工作流 |
| 反向锁：`!source.includes("AI 连接器尚未配置")` | tests/ui_test.ts:91 | 旧占位文案必须已删 |
| `main.includes('case "return-launcher": store.returnToLauncher(); return;')` | tests/workbench_ui_test.ts:71 | 顶栏返回按钮 handler 逐字 |
| `main.includes('case "build-blueprint": void store.startSeed(); return;')` | tests/workbench_ui_test.ts:97 | 种子卡 handler 逐字 |
| `main.includes('"course.seed.create"') && main.includes('"blueprint.build"')` | tests/workbench_ui_test.ts:98 | Domain 命令名 |
| `main.includes('case "open-workbench"') && main.includes("openWorkbench(")` | tests/workbench_ui_test.ts:139 | 工作台入口 handler |
| `main.includes('case "import-folder"')` | tests/t04_scan_test.ts:70 | 启动页导入 handler |
| `main.includes('"explorer"')`（ROUTES） | tests/t04_explorer_test.ts:270 | 路由表 |
| `views.includes("保存已暂停")` 等 12 条 | tests/workbench_ui_test.ts:287-298 | **views.js 源码里的文案**逐字（见 §3.1） |
| `views.includes('preview.error || "素材不可读"')` | tests/workbench_ui_test.ts:291 | 连 JS 表达式写法一起锁 |
| `views.includes('class="statusbar"') && views.includes('class="toast"')` | tests/workbench_ui_test.ts:189 | views.js 中的 class 字面量 |
| `source.includes('data-placeholder="`esc(placeholder)`"') && source.includes('aria-placeholder="`esc(placeholder)`"')` | tests/dogfooding_test.ts:1000 | 占位符属性写法（模板原文） |
| `viewsSource.includes('data-action="add-stage"')` 等 4 个 stage data-action | tests/authoring_ui_test.ts:4239-4243 | 课程地图阶段操作 |
| `mainSource.includes('"add-stage"')` 等 4 个 handler 绑定 | tests/authoring_ui_test.ts:4254-4257 | main.js 绑定 |
| `viewsSource.includes('data-action="rename-asset"')`、`"data-asset-title"` | tests/authoring_ui_test.ts:3538-3539 | 素材重命名 |
| `viewsSource.includes('data-focus-key="asset-menu-`esc(asset.id)`"')` | tests/authoring_ui_test.ts:3547 | focus key 模板原文 |
| `views.includes('data-action="insert-block"') && views.includes("＋ `label`")` | tests/authoring_ui_test.ts:3284 | 区块面板插入按钮（含全角＋） |
| `viewsSource.includes("isAttachmentAsset") || viewsSource.includes("asset-attachment")` | tests/authoring_ui_test.ts:4307-4308 | 附件素材识别 |
| `source.indexOf("function lessonStrip(") < source.indexOf("function writingView(")` 等 | tests/dogfooding_test.ts:1961-1971 | **views.js 函数定义顺序**也被锁 |
| native 壳：`lib.includes(...)` ×68、`app.includes(...)` ×70 | tests/native_boundary_test.ts:56-260 | src-tauri/lib.rs 与 app.js 源码文本（与 UI 无关，共 144 处） |

---

## 3. 【文案锁定】逐字中文文案清单（按页面/区块）

> 形态 A/B。改任何一个字符都会挂。§3.1 是源码文本锁（✎），其余多为渲染 HTML 断言（✔）。

### 3.1 全局外壳 / 冲突与恢复 / 预检（✎ 全部锁在 views.js/main.js/boot.js 源码文本里）

| 逐字文案 | file:line |
|---|---|
| 保存已暂停 / 磁盘版本没有改变 | tests/workbench_ui_test.ts:287 |
| 请选择重新载入、自动合并，或在确认后保留本地版本 | tests/workbench_ui_test.ts:288 |
| 显示技术信息 / 必须修复 / 确认提示并导出 | tests/workbench_ui_test.ts:290 |
| 素材不可读（写作 `preview.error || "素材不可读"`）/ 重试预览 / 没有找到匹配的素材。换一个文件名继续搜索 | tests/workbench_ui_test.ts:291 |
| 课程内容没有改动，你可以检查设置后重试 | tests/workbench_ui_test.ts:292 |
| 当前操作没有写入 / 暂存内容 | tests/workbench_ui_test.ts:293 |
| 发现未完成的保存；磁盘版本没有改变 | tests/workbench_ui_test.ts:294 |
| 项目文件没有被改动 | tests/workbench_ui_test.ts:295 |
| 这个项目正在其他窗口或进程中使用 / 课程文件在其他地方发生了变化 | tests/workbench_ui_test.ts:297 |
| 这项操作没有完成。工作台仍可继续使用，请重试。 | tests/workbench_ui_test.ts:298 |
| 反向锁：EXTERNAL MODIFICATION CONFLICT / BLOCKING / WARNING 三个英文标签**不得**出现在主文案 | tests/workbench_ui_test.ts:289 |

### 3.2 启动页 / 项目注册表 / 打开诊断

| 逐字文案 | file:line |
|---|---|
| 最近打开 / 刚刚打开 / 35 分钟前打开 / 3 天前打开 / 1 月 2 日打开 · 2025 年 | tests/registry_launcher_test.ts:249-255 |
| 不会删除或改写磁盘上的课程文件 | tests/registry_launcher_test.ts:265 |
| 找不到文件夹 / 重新定位 | tests/registry_launcher_test.ts:280-281 |
| 当前 / 继续工作 | tests/registry_launcher_test.ts:318-319 |
| 还没有最近项目 / 新建课程 / 打开项目文件夹（或 打开现有项目）/ 导入已有文件夹 | tests/registry_launcher_test.ts:329-331、tests/t04_scan_test.ts:53-59 |
| 检测到同一个 Workbench 项目的两个副本 / 更新项目位置 / 保留两条记录 | tests/registry_launcher_test.ts:427-429 |
| 不会被删除或修改 / 没有被改动 / 仍留在列表里 | tests/registry_launcher_test.ts:501,517,552 |
| 还不是 AI Course Workbench 项目 | tests/smart_open_routing_test.ts:301 |
| 检测到 project.json，但项目数据无法通过校验。/ 正文文档不存在 / 没有找到有效的 project.json / 还没有 project.json / 解析（失败前缀） | tests/smart_open_routing_test.ts:319-321,437-439 |
| 查看具体问题 / 作为普通资料文件夹重新导入 / 不会覆盖原来的 project.json / 完整保留为一个带时间戳的备份文件 / 不会删除 | tests/smart_open_routing_test.ts:334-361 |
| 这个项目由更高版本的 Workbench 创建。/ 当前版本支持到 0.2.3 / 你可以： | tests/smart_open_routing_test.ts:470-488 |
| 无法打开项目 / 没有选择文件夹 / 资料文件夹导入 / 选择其他｜新建课程｜导入已有文件夹 / 损坏｜无效 / project.json｜项目 JSON / 必须.*project.bak｜需要.*project.bak / 不是.*Workbench 项目…（正则锁，允许多种表述） | tests/dogfooding_test.ts:547-643 |
| 返回启动页；当前项目保持打开 | tests/workbench_ui_test.ts:68 |
| 课程地图 | tests/workbench_ui_test.ts:79 |

### 3.3 工作台外壳 / 顶栏 / 侧栏

| 逐字文案 | file:line |
|---|---|
| 顶栏六项顺序文本：概览 / 工作台 / 文件 / 收件箱 / 发布 / 设置 | tests/workbench_ui_test.ts:124-135（顺序锁）、tests/t04_explorer_test.ts:263-266 |
| 资料库 / 全部 / 案例 / 视频 / 图片 / 文档 / 幻灯片（左栏筛选） | tests/workbench_ui_test.ts:154-156 |
| 资源浏览器 / 文件名 / 导论预览 / 白板 / PDF 第一页 / 图片 / 视频 / 媒体 / 正文 | tests/t04_explorer_test.ts:364-416 |

### 3.4 区块编辑器 / 课程地图 / 素材 / 版本

| 逐字文案 | file:line |
|---|---|
| 区块类型名 `>标题<`（block-type-label） | tests/p2_interaction_test.ts:387 |
| 溢出菜单按钮文本 `>⋯<` | tests/p2_interaction_test.ts:398 |
| 新阶段 / 第一阶段 / 第二阶段 / 确认 / 节课 | tests/authoring_ui_test.ts:4196,4240,4276 |
| ＋ 媒体（区块面板项）、插入到当前位置、选中区块之后 / 当前选中区块之后 / 课末尾 / 课末 | tests/authoring_ui_test.ts:3280,3288,3439-3440 |
| 未定位 / 位置：（锚点前缀）/ 补充这段文字 / 补一张图片 / 定位 | tests/authoring_ui_test.ts:3482-3517 |
| 不能为空 / 已有一个素材使用这个文件名 / 已重命名文件 / 托管文件 / 磁盘文件同步改名（正则） | tests/authoring_ui_test.ts:3698-3729,3620,3543 |
| 已恢复历史版本 / 保存时间未知 / 索引尚未写入 / 持久化确认有限 / 没有恢复 / 课程内容已经保存，但阅读位置没有记住 | tests/authoring_ui_test.ts:580-817 |
| 页面尺寸不同，需选择统一尺寸 / 横版页面 / 竖版页面 | tests/authoring_ui_test.ts:2180,2198 |
| 2 个已在正文中显示 / 保留映射 | tests/authoring_ui_test.ts:3264,3266 |
| 结果暂时无法确认 / 本地修改 / 项目正在使用 / 没有接管项目锁 | tests/authoring_ui_test.ts:3810,3829,4070,4073 |
| 退出分页编辑 | tests/authoring_ui_test.ts:4978 |
| 导出文件的持久化确认不完整：（`role="alert"` 前缀）/ 目录同步尚未确认 &lt;待重试&gt; / 项目恢复状态 &lt;待确认&gt; / 任务回执 &lt;待确认&gt; | tests/authoring_ui_test.ts:5133-5166 |
| 正在保存… / 已保存（保存状态芯片与 toast） | tests/dogfooding_test.ts:693,699 |
| 合并冲突 `<b>1</b>`（HTML 组合文案） | tests/dogfooding_test.ts:1761,1776 |
| AI 助手（常驻面板标题） | tests/dogfooding_test.ts:1039,1045、tests/authoring_ui_test.ts:3518,4843 |
| 已保存为 / 添加到当前课 / 本候选将作为新资源保存 / 已用于：（`code title`）/ 属于同一事件 / 确认 | tests/dogfooding_test.ts:2105-2182 |
| 人工查看记录，不代表字幕或口播已校验 / 不能同时选择 | tests/dogfooding_test.ts:2240,2244 |
| 待补（完成度） | tests/dogfooding_test.ts:1968 |

### 3.5 AI 面板 / AI 设置

| 逐字文案 | file:line |
|---|---|
| 修改前 / 修改后 / 应用这些修改 / 拒绝 / 不能应用 | tests/ai_ui_test.ts:835-840,1451 |
| 请在 AI 设置里为这个 Provider 填写 API Key。 | tests/ai_ui_test.ts:1115 |
| 还没有可用的模型连接 | tests/ai_ui_test.ts:1196,1770 |
| 本项目目录的 .workspace/ai / 本机应用数据目录 / 课程文件不含凭据 / 已配置密钥（凭据状态三态文案） | tests/ai_ui_test.ts:1214-1227,1586,1594 |
| 执行记录（N）（含全角括号计数格式） | tests/ai_ui_test.ts:1270,1351,1368 |
| 服务商认证失败（401）/ 本机尚未保存 API Key / 连接配置尚未保存 | tests/ai_ui_test.ts:1731-1734,1776 |
| 当前浏览器服务壳不支持订阅登录 | tests/ai_ui_test.ts:1813 |
| 显示名称 / 编辑 / 移除 / 上下文窗口 / 最大输出 token / 输入类型 / 文本 / 图片 | tests/ai_ui_test.ts:2114-2121 |
| Model ID 不能重复：model-a / 模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。/ 请至少保留一个勾选的模型。/ 输入类型至少要保留一种。 | tests/ai_ui_test.ts:2197,2245,2458,2721 |
| 选择模型 / 勾选的模型即为模型列表 / 全选 / 取消全选 / 更新列表 / 取消（后四个锁 `>文本<` 形式） | tests/ai_ui_test.ts:2295-2300 |
| placeholder="留空显示 Model ID" / placeholder="搜索 Model ID" | tests/ai_ui_test.ts:2115,2297 |
| API 参数值 / 档位=模型能力档，API 参数值=发送给该协议的参数值 / 开启后，未指定档位时使用最强档；调用时可指定档位，off 表示不下发推理参数。 | tests/ai_ui_test.ts:2778-2793 |
| 连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口，需填写 API 地址、协议和模型。 | tests/ai_ui_test.ts:3113 |
| 填写服务商的地址、协议与 API 密钥，然后获取它自己的模型列表。 | tests/ai_ui_test.ts:3133 |
| 创建提供商（锁 `>创建提供商</button>`）/ 粘贴 API Key（不会回显）/ 删除本机保存的密钥 | tests/ai_ui_test.ts:3257-3259 |
| 读取模型失败：/ 可以直接在下面手动填写 Model ID，不影响保存 / 不需要密钥（离线连接器）。 | tests/ai_ui_test.ts:3298-3308 |
| 未绑定域名 / 本地确定性连接器 / 已保存 | tests/ai_ui_test.ts:656,781,2631 |
| ChatGPT 已登录，但没有授权套餐用量 / 重新授权 / 没有可用模型 / 模型可选 / 没有改动课程内容 / 重新登录 / 不会保存任何凭据 | tests/ai_subscription_stages_test.ts:90-176 |
| 不再内置服务商模板 / 设置 → 模型 / 不支持的 API 协议 / 手动填写 Model ID | tests/ai_provider_config_test.ts:198-481 |
| 整门课程 / 其他课次 / 本课结构 / 区块范围 / 归档 / 超出单次上下文长度上限 / 已截断 / 待补要求 / 素材信息 / 完成度与状态 / 相邻内容 / 已隐藏 / 密钥 / 还没有课次 / 没有下发推理参数 / 请改为预算数字或改用 OpenAI 协议 | tests/ai_workflow_test.ts:299-3207 |
| 显示名称 / 已经存在 / 不允许的字段 / 过大 / 层级过深 / AI 执行记录 | tests/ai_transport_test.ts:582-2668 |

### 3.6 文档导入对话框 / 映射预览

| 逐字文案 | file:line |
|---|---|
| 选择要导入为正文的文档 / 导入所选正文 / 取消 | tests/document_import_dialog_test.ts:337-340 |
| 根目录 | tests/document_import_dialog_test.ts:423 |
| 行元数据格式 `路径 · 类型 · 大小`（例：s01-00/导论.md · Markdown · 2 KB / s01-00/slides.pdf · PDF · 1.4 MB） | tests/document_import_dialog_test.ts:453-454 |
| aria-label="将 slides.pdf 导入为正文"（逐字 aria 文案） | tests/document_import_dialog_test.ts:455 |
| 已选 N / M 项（计数格式） | tests/document_import_dialog_test.ts:475,478,540 |
| 全选 / 取消全选 | tests/document_import_dialog_test.ts:493-494 |
| 文档扫描没有完成 / 重试 | tests/document_import_dialog_test.ts:558-559 |
| 已原地接管 / 没有写入任何课程内容 / 源文件仍在原处 / 映射预览 | tests/document_import_dialog_test.ts:700,774-777 |
| 正文导入结果 / 正文导入：成功 2 · 降级 1 · 跳过 0 · 失败 1 / 未进入正文：s01-02/scan.pdf / 图片依赖缺失 | tests/document_import_dialog_test.ts:835-859 |
| 桌面应用 / 不可进入正文 | tests/document_import_dialog_test.ts:1037,1322 |
| 映射 / 建议 / 确认导入计划 / 确认导入计划并打开 / 确认并追加到当前课程 | tests/t04_mapping_test.ts:387-394、tests/t04_adoption_test.ts:896 |
| 检查项目目录权限 / 默认跳过 / 目标课时已删除 / 按当前目标新建或追加 / 曾删除课时 / 来源路径已有较旧导入 / 用户已明确选择导入来源的新版本 | tests/t04_adoption_test.ts:970-1322 |

### 3.7 素材导入 / 预览 / 导出

| 逐字文案 | file:line |
|---|---|
| 已导入 N 个素材 / N 个失败 / N 个已按 checksum 复用 / 失败 / 没有选择素材文件 / 1 个重复或不适用条目已跳过 / 已将 N 个素材 | tests/asset_batch_import_test.ts:275-461 |
| 预览失败 / 缩略图已释放 / 正在读取 / 等待加载 / 预览未加载（**预览状态机分类器按这些字样识别状态**） | tests/media_preview_stability_test.ts:81-86 |
| 重试预览 / 图片文件格式不匹配 | tests/media_preview_stability_test.ts:1909,2137 |
| 持久化确认 / 导出目录 / 找不到本地图片 / 超出来源目录 / 正在其他窗口或进程中使用 | tests/native_boot_test.ts:905-1505 |
| 文件导入没有完成 / 插入素材： | tests/native_boundary_test.ts:344,358 |
| 页面内正文 / 尚未放置的正文 / 私聊 / 私密内容 / 可搬走的网页正文 | tests/import_export_test.ts:562-1183 |
| 素材超过单文件预览上限 | tests/asset_thumbnail_test.ts:688 |
| 目录元数据同步失败 | tests/snapshot_persistence_test.ts:217 |
| 未确认 / 清理失败 | tests/io_failure_recovery_test.ts:650-651 |
| 稍后重试 / 摘要已变化 | tests/import_preview_lifecycle_test.ts:59,162 |
| 该操作不受支持 | tests/browser_session_test.ts:509 |
| 项目校验失败 | tests/completeness_test.ts:50 |

### 3.8 反向文案锁（这些字样**不得**出现）

| 不得出现 | file:line |
|---|---|
| AI 连接器尚未配置（旧占位实现） | tests/ui_test.ts:91 |
| EXTERNAL MODIFICATION CONFLICT / BLOCKING / WARNING | tests/workbench_ui_test.ts:289 |
| >源码< / >Markdown< / toggle-markdown-source / markdown-format / markdown-inline-toolbar / markdown-source-field / data-source-mode | tests/editor_compile_test.ts:707-716 |
| block-bar（旧尾部操作栏） | tests/p2_interaction_test.ts:406-408 |
| `class="seed-choices"`（launcher 不得有九宫格入口） | tests/workbench_ui_test.ts:78 |
| data-action="route" data-route= 与 data-action="open-workbench" 出现在左栏 | tests/workbench_ui_test.ts:148-151 |
| 本项目目录的 .workspace/ai / 本机应用数据目录 出现在**浏览器壳**凭据文案 | tests/ai_ui_test.ts:1214,1223-1224 |
| 凭据明文（local-key-account-a 等） | tests/ai_ui_test.ts:1676-1677 |

### 3.9 非文案（测试夹具文本，107 条）

断言的是测试数据本身（如“第一课的正文”“课程 proj-a”“2026 汛情复盘”“01-基础”“GIF示例”），改 UI 文案不受影响，但**构造/修改测试数据时别动这些夹具**。完整清单见附录 A（标 [fixture]）。

---

## 4. 【结构性锁定】类名 / data-* / 顺序

### 4.1 data-* 属性全集（70 个，测试全文引用）

`data-action, data-actions, data-ai-api-protocol, data-ai-base-url, data-ai-editor, data-ai-model-context, data-ai-model-error, data-ai-model-max-tokens, data-ai-model-rows, data-ai-provider, data-ai-secret, data-ai-tier-value, data-asset, data-asset-preview-asset, data-asset-preview-key, data-asset-preview-surface, data-asset-title, data-block-id, data-block-text, data-chrome-save, data-chrome-statusbar, data-chrome-toast, data-dir, data-document-import-row, data-document-import-select, data-empty, data-explorer-filter, data-file, data-flow-drag-handle, data-focus-key, data-format, data-grid-surface, data-lesson, data-mapping-destination, data-mapping-duplicate, data-mapping-role, data-mapping-row, data-mapping-select, data-markdown-image-href, data-markdown-image-title, data-mode, data-only, data-page-id, data-panel, data-panel-scope, data-path, data-placeholder, data-project-dir, data-project-file, data-project-path, data-project-title, data-provider-id, data-resource-candidate, data-resource-existing, data-resource-merge-confirm, data-resource-questions, data-resource-timing-confirm, data-resource-timing-end, data-resource-timing-start, data-resource-use, data-resource-video-mode, data-rich-editor, data-route, data-row-key, data-selected, data-source-mode, data-stop-click, data-tier-key, data-title-surface, data-type`

其中 **`data-action` 是全局事件委派总线**：dogfooding 的假 DOM 以 `querySelectorAll("[data-action]")` + `closest("[data-action=…]")` 派发（tests/dogfooding_test.ts:107、100-115），media_preview_stability 用正则扫描所有带 `data-action` 的标签重建控件（tests/media_preview_stability_test.ts:124-138）。**改名或拆属性 = 全局事件失灵 + 一批测试挂**。

被逐字锁值的属性写法（改值/改引号形式即挂）：

| 断言原文 | file:line |
|---|---|
| `data-document-import-row data-path="s01-00/a.txt" data-selected="true"`（同元素多属性连写） | tests/document_import_dialog_test.ts:520 |
| `data-selected="false"` | tests/document_import_dialog_test.ts:539 |
| `data-ai-editor="add"` / `data-ai-editor="row"` | tests/ai_ui_test.ts:527,540 |
| `data-dir="up"` / `data-dir="down"` | tests/ai_ui_test.ts:2103-2104 |
| `data-placeholder="`esc(placeholder)`"` + `aria-placeholder=…`（模板原文） | tests/dogfooding_test.ts:1000 |
| `data-focus-key="snapshot-name"` / `"project-title"` / `data-focus-key="`key`"` | tests/dogfooding_test.ts:1130,1342,1088 |
| `data-panel-scope="项目 · `projectTitle`"` / `"课时 ·…"` | tests/authoring_ui_test.ts:4844-4845 |
| `data-title-surface="settings"` | tests/authoring_ui_test.ts:4825 |
| `data-action="pick-seed" data-type="`type`"` | tests/workbench_ui_test.ts:83 |
| `data-route="`navRoute`"` | tests/t04_explorer_test.ts:268 |

正则级属性锁（值 + 同元素其他属性顺序）：

| 契约 | 断言原文 | file:line |
|---|---|---|
| 禁用态在同标签内 | `/data-action="ai-picker-confirm"[^>]*disabled/` | tests/ai_ui_test.ts:2460 |
| 同上 | `/data-action="ai-add-tier"[^>]*disabled/` | tests/ai_ui_test.ts:2896 |
| 同上（逐字） | `data-action="document-import-confirm" disabled` | tests/document_import_dialog_test.ts:560 |
| 推理开关 checked 在 action 后 | `/data-action="ai-toggle-model-reasoning"[^>]*checked/` | tests/ai_ui_test.ts:2774 |
| 档位行属性顺序 | `/data-ai-tier-value[^>]*data-tier-key="tier-1"[^>]*value="off"[^>]*disabled/` | tests/ai_ui_test.ts:2780 |
| 档位行属性顺序 | `/data-ai-tier-value[^>]*data-tier-key="tier-2"[^>]*value="medium"/` | tests/ai_ui_test.ts:2784 |
| 校验态 | `/data-ai-tier-value[^>]*aria-invalid="true"/` | tests/ai_ui_test.ts:2950 |
| 已勾选行数 | `(markup.match(/data-document-import-select[^>]*checked/g)).length === 3` | tests/document_import_dialog_test.ts:480-491 |
| 打开映射与确认的包含顺序 | `/data-action="open-import-mapping"[^>]*>[\s\S]{0,80}confirm-import-mapping/` | tests/t04_mapping_test.ts:398 |
| 多文件选择器 | `/<input[^>]*\bmultiple\b[^>]*data-project-file/` | tests/asset_batch_import_test.ts:471 |

### 4.2 被测试引用的 class（135 个，动它们 = 挂测试或断链 CSS）

`active, ai-add-card, ai-add-trigger, ai-model-id, ai-model-rows, ai-provider-rows, ai-reasoning, ai-settings-modal, ai-tier-value, ai-toggle, asset-attachment, asset-card, asset-card-media, asset-doc, asset-image, asset-media-duration, asset-pdf-preview, asset-picker, asset-preview-frame, asset-video, attachment, before, block-handle, block-head, block-head-actions, block-main, block-more, block-more-menu, block-order, block-properties-modal, block-text, block-type-label, blocking, brand, card, center, check, cols, compact, course-tree-stage, danger, diagnostic, document-import-group, document-import-modal, dot, editing, empty, empty-state, failed, field-label, filter, fit-source-page, flow-drag-handle, full, icon-button, inline, launcher, launcher-return, left-panel, loading, mapping-destination, mapping-role, mapping-row, markdown-rich-editor, media, modal, modal-actions, modal-head, mode, muted, ok, open, overlay, overview-page, page, page-head, page-preview-sheet, palette, panel, panel-heading, preflight, primary, progress-track, project-picker, project-problem-modal, properties, publish-page, publish-size-warning, recent-card, requirement-actions, requirement-body, requirement-item, resource-candidate, resource-discovery, resource-merge, right-content, right-panel, right-tab, right-tabs, rows, secondary, select, side-head, small, statusbar, switch, tab, tabs, text, text-button, toast, topbar, version-card, version-main, version-row-title, versions-page, warning, workbench-page, workspace, writing-toolbar`

被**逐字锁组合**的 class（不只是名字，组合形式也锁）：

| 断言原文 | file:line |
|---|---|
| `class="secondary launcher-return"`（两个类同元素） | tests/workbench_ui_test.ts:67 |
| `class="recent-card"` + `data-action="enter-project"` | tests/workbench_ui_test.ts:72、tests/native_boot_test.ts:1346,1351 |
| `class="panel-heading"` / `class="right-tabs"` | tests/workbench_ui_test.ts:99,101 |
| `class="project-picker"` | tests/workbench_ui_test.ts:143 |
| `class="statusbar"` / `class="toast"`（views.js 文本） | tests/workbench_ui_test.ts:189 |
| `class="block-head"` + `block-handle` + `block-type-label` | tests/p2_interaction_test.ts:386、tests/editor_compile_test.ts:730-733 |
| `class="block-more"` + `>⋯<` | tests/p2_interaction_test.ts:396,407 |
| `class="modal block-properties-modal"` | tests/dogfooding_test.ts:1043 |
| `class="palette modal" role="dialog" aria-modal="true"` | tests/dogfooding_test.ts:1702 |
| `role="dialog" aria-modal="true"`（假 DOM 判定弹窗的唯一依据） | tests/dogfooding_test.ts:171 |
| `class="center"`（假 DOM 滚动容器选择器） | tests/dogfooding_test.ts:207,221 |
| `class="markdown-rich-editor"` / `class="markdown-rich-editor markdown-editor-heading markdown-heading-level-2"` | tests/editor_compile_test.ts:718,737 |
| `class="ai-provider-rows"` / `class="ai-add-card"` / `class="ai-add-trigger"` / `class="ai-model-id"` | tests/ai_ui_test.ts:525-544,2109 |
| `class="document-import-group"`（计数 === 3） | tests/document_import_dialog_test.ts:433 |
| `class="publication-inline-image"`（导出 HTML） | tests/import_export_test.ts:1117 |
| 反向锁：launcher 不得有 `class="seed-choices"` | tests/workbench_ui_test.ts:78 |
| 反向锁：`<select class="select" data-ai-provider>` 不得出现在助手 | tests/ai_ui_test.ts:1772 |

### 4.3 元素顺序 / 包含 / 计数（形态 D）

| 契约 | 断言原文 | file:line |
|---|---|
| 顶栏导航顺序：概览→工作台→文件→收件箱→发布→设置 | `nav.indexOf('"' + label + '"')` 逐个递增 | tests/workbench_ui_test.ts:125-135 |
| AI 新增卡编辑器在新增卡内、在行列表之后 | `addEditor > addCard && addCard > rows` | tests/ai_ui_test.ts:525-532 |
| 行内编辑器在所属行内 | `rowEditor > rowStart` | tests/ai_ui_test.ts:539-542 |
| 打开行编辑后新增入口回到虚线按钮且在行编辑器后 | `html.indexOf('class="ai-add-trigger"') > rowEditor` | tests/ai_ui_test.ts:543-546 |
| 区块头在正文前 | `card.indexOf("block-head") < card.indexOf("block-main")` | tests/p2_interaction_test.ts:409-412 |
| 头部高频区不得含 delete-block（`>⋯<` 菜单之前） | `!head.slice(0, head.indexOf('class="block-more"')).includes("delete-block")` | tests/p2_interaction_test.ts:399-401 |
| 导入对话框分组顺序：组头→组内行→下一组 | `firstGroup < outline && outline < secondGroup && secondGroup < intro` | tests/document_import_dialog_test.ts:424-431 |
| 分组数量恰好 3 | `(markup.match(/class="document-import-group"/g) ?? []).length === 3` | tests/document_import_dialog_test.ts:432-436 |
| 启动页卡顺序：recent-card 在 seed-choices 前 | `launcher.indexOf('class="recent-card"') < launcher.indexOf("seed-choices")` | tests/native_boot_test.ts:1346-1347 |
| 每个选中页一个 fit 矩形 | `(html.match(/fit-source-page/g) || []).length === 2` | tests/authoring_ui_test.ts:2199 |
| 左右折叠控件各恰好一个 | `count(source, 'data-action="toggle-left"') === 1` 等 | tests/workbench_ui_test.ts:63-65 |
| topbar 不得复制折叠控件 / recent-card 不得直接 open-item | `!topbar.includes('data-action="toggle-left"')` 等 | tests/workbench_ui_test.ts:69-74 |
| views.js 函数定义顺序（lessonStrip 在 writingView 前等） | `source.indexOf(…)` 比较 | tests/dogfooding_test.ts:1961-1971 |

---

## 5. 【可动】视觉整改安全区

### 5.1 纯视觉 class（556 个，测试零引用）

出现在 app/*.js 的 HTML 模板、但 tests/ 全文没有任何字符串引用。**重命名、合并、删除这些类名不会直接挂任何测试**（前提：不连带改变 §4.2/§4.3 锁定的元素）。按前缀分布：

- `ai-*` 81 个（ai-answer、ai-badge、ai-context、ai-diff、ai-diff-side、ai-empty-state、ai-hint、ai-model-row-body、ai-picker-list、ai-scope…）
- `explorer-*` 31 个、`asset-*` 22 个、`page-*` 21 个、`publish-*` 20 个、`resource-*` 19 个、`preview-*` 17 个、`document-*` 15 个
- `course-*` 14、`flow-*` 14、`media-*` 14、`settings-*` 14、`inbox-*` 13、`mapping-*` 13、`presentation-*` 13、`backlog-*` 12、`board-*` 11、`library-*` 11、`project-*` 11、`launcher-*` 10 …

全量清单见附录 B（556 行）。⚠️ 两个例外：
1. 类名虽然测试不看，**CSS 正则锁**（§1.2）可能间接锁住它的样式写法——改名后 CSS 选择器要同步，别破坏 §1.2 的正则。
2. **views.js 源码文本断言**（§2）会锁模板里的字符串；把 class 从模板字符串挪位置导致源文本片段变化时，`viewsSource.includes` 类断言可能挂。

### 5.2 只断言语义、不锁写法的部分（改实现自由）

| 测试 | 断言语义 | file:line |
|---|---|---|
| 版本历史/恢复类 | 只断言状态值与文案（如“已恢复历史版本”），不锁 DOM | tests/authoring_ui_test.ts:647-710 |
| recovery_ui_test 全部 1147 行 | 几乎全是 store 状态断言（saveStatus、lease、session），仅 recoveryWarning() 文案函数被断言 | tests/recovery_ui_test.ts:258-265 |
| AI 执行历史/凭据安全 | 断言“不出现凭据明文”（语义级否定） | tests/ai_ui_test.ts:1586-1594 |
| 打开失败提示 | 用**正则多选**（如 `/选择其他|新建课程|导入已有文件夹/`）——允许换表述，只要命中其一 | tests/dogfooding_test.ts:587,613-643 |
| 预览状态机 | 状态判定靠文案存在性（预览失败/正在读取/…），只要这几个字样保留、内部 DOM 随便换 | tests/media_preview_stability_test.ts:81-86 |
| markdown 转换输出 | 只锁语义 HTML（`<strong>`、`<table>`、`<code>`），不锁 class | tests/markdown_test.ts:50-147 |

---

## 6. 结论：风险评估

### 6.1 只改 styles.css（不动 DOM）——风险：**中低，但绝非零**

- **安全面**：556 个纯视觉 class 的全部视觉属性、配色、圆角、阴影、字体、动画、留白，只要不触碰 §1.1/§1.2 的逐字与正则契约。
- **风险面（必挂区）**：67 处 styles.css 文本/正则断言。最容易踩的：
  1. tests/workbench_ui_test.ts:103-109 —— `grid-template-columns` 的 228/286/30px 值与规则**单行书写形式**被逐字锁；重排版、改栏宽、把 30px 折叠轨改宽都挂。
  2. tests/workbench_ui_test.ts:168-188 —— 控件高度令牌值（35px/30px/48px/36px）、`.modal > .modal-actions` 直接子选择器、`bottom: calc(...)` 逐字。
  3. tests/p2_interaction_test.ts:450-467 —— `--block-outer-small/medium/large = 100px/196px/354px` 三个值逐字；旧 96px 写法被反向锁。
  4. tests/ui_test.ts:119-138 —— 版本卡必须是 `grid-template-columns: auto minmax(0, 1fr) max-content`。
  5. tests/editor_compile_test.ts:744-765 —— `.block-head` 必须 ≥2 条规则且浮层条含 `position:absolute; visibility:hidden; opacity:0`；`.block` 必须 `background: transparent`。
  6. 颜色也锁：`color: #b3403f`（danger hover）与 `var(--primary)`/`#fff` 组合（tests/p2_interaction_test.ts:433-439）。
- **结论**：只改 styles.css，预期挂 **0–67 处**，取决于整改幅度。改配色/字号/圆角/普通阴影 ≈ 0 挂；动布局模型、栏宽、控件高度、区块外框尺寸 ≈ 大概率挂。建议把 §1 表当“CSS 冻结清单”，或整改后同步放宽这些测试。

### 6.2 要改 DOM / 类名 / data-* ——必须同步改的测试

| 改动 | 必同步的测试 |
|---|---|
| 顶栏/侧栏结构与 class | tests/workbench_ui_test.ts:57-200（含 CSS 与 views 源码锁）、tests/t04_explorer_test.ts:255-270 |
| 启动页卡/入口按钮 | tests/workbench_ui_test.ts:63-98、tests/t04_scan_test.ts:45-70、tests/registry_launcher_test.ts:245-345、tests/native_boot_test.ts:1344-1355 |
| 区块卡（block-head/block-more/操作按钮） | tests/p2_interaction_test.ts:381-412、tests/editor_compile_test.ts:705-765、tests/dogfooding_test.ts:1035-1048 |
| AI 设置/助手 | tests/ai_ui_test.ts:515-550、1670-1790、2100-2300、2770-2960、3100-3312（含模板原文断言） |
| 文档导入对话框 | tests/document_import_dialog_test.ts:330-560（行属性连写、计数、分组顺序） |
| 映射/导入预览 | tests/t04_mapping_test.ts:387-436、tests/mapping_ui_runtime_test.ts:31-104、tests/t04_adoption_test.ts:896-988 |
| 素材预览卡 | tests/media_preview_stability_test.ts:1445-1520（含 CSS 正则） |
| 版本历史卡 | tests/ui_test.ts:119-138（CSS 正则锁结构等价物） |
| 弹窗（role="dialog" / modal 类） | tests/dogfooding_test.ts:171、1702、tests/authoring_ui_test.ts:1528 |

---

## 7. 改 DOM 时最容易踩的 10 个点

1. **`data-action` 是全局事件委派总线**，假 DOM 与真 DOM 都靠 `querySelectorAll("[data-action]")`/`closest` 派发；改名/拆分 = 交互全断 + tests/dogfooding_test.ts:107 一带全挂。
2. **workbench 的 CSS 是逐字子串锁**：`.workspace { display: grid; grid-template-columns: 228px minmax(430px, 1fr) 286px;` 连写法都锁；换行、调 1px、改声明顺序都挂（tests/workbench_ui_test.ts:103-109）。
3. **顶栏六个目的地的顺序被 indexOf 递增锁死**：概览→工作台→文件→收件箱→发布→设置，重排/增删都挂（tests/workbench_ui_test.ts:125-135）。
4. **AI 新增卡/行内卡的嵌套与顺序**：编辑器必须在对应卡内部（`addEditor > addCard > rows`、`rowEditor > rowStart`），把表单抽到卡外就挂（tests/ai_ui_test.ts:525-546）。
5. **`>⋯<`、`>标题<`、`>创建提供商</button>`、`>全选<` 这类“标签含文本”断言**：把文本包进 span、加空格、换图标字符都会挂（tests/p2_interaction_test.ts:387,398、tests/ai_ui_test.ts:2298-2300,3257）。
6. **多属性连写顺序**：`data-document-import-row data-path="…" data-selected="true"` 与 `/data-ai-tier-value[^>]*data-tier-key[^>]*value[^>]*disabled/` 要求属性顺序一致（tests/document_import_dialog_test.ts:520、tests/ai_ui_test.ts:2780-2785）。
7. **`role="dialog" aria-modal="true"` 与 `class="center"` 是假 DOM 的选择器**：动这两处假 DOM 直接失明，相关“焦点/滚动/不重建 DOM”测试全挂（tests/dogfooding_test.ts:171,207,221）。
8. **文档导入分组的顺序+计数**：组必须按 `s01-00/ → 组内行 → s01-01/` 排且 `document-import-group` 恰好 3 个（tests/document_import_dialog_test.ts:424-436）。
9. **views.js 源码文本断言**：哪怕渲染结果一样，把模板里的 `data-focus-key="asset-menu-…` 等字符串重写、或移动 `function lessonStrip` 等函数位置，都会挂（tests/authoring_ui_test.ts:3547、tests/dogfooding_test.ts:1961-1971）。
10. **区块浮层 chrome 的 CSS 契约**：`.block-head` 必须有“离浮层”规则（absolute + hidden + opacity:0）且 hover/focus-within/menu-open 三种揭示；`>⋯<` 菜单之前的头部区不得出现 delete-block（tests/editor_compile_test.ts:744-765、tests/p2_interaction_test.ts:399-401）。

---

## 附录 A · 全部 UI 契约断言逐条证据（631 条）

> 逐条列出 file:line、测试名、断言原文（needle/正则原文）。由脚本从 tests/*.ts 提取；正文引用均可在此核对。[fixture] = 测试夹具文本，非 UI 文案。


### A · acceptance_test.ts（1 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| acceptance_test.ts:313 | E2E-10 security redacts secrets and strips executable HTML | `<script` |

### A · ai_provider_config_test.ts（6 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| ai_provider_config_test.ts:198 | §9.2 normalizeAiConnection rejects a bare provider id | `不再内置服务商模板` |
| ai_provider_config_test.ts:202 | §9.2 normalizeAiConnection rejects a bare provider id | `设置 → 模型` |
| ai_provider_config_test.ts:217 | normalizeAiConnection rejects a missing connection readably | `设置 → 模型` |
| ai_provider_config_test.ts:275 | §9.4 normalizeAiConnection rejects an unknown API protocol | `不支持的 API 协议` |
| ai_provider_config_test.ts:471 | §9.5 discovery without a Base URL fails and keeps manual entry open | `手动填写 Model ID` |
| ai_provider_config_test.ts:481 | §9.5 discovery without a Base URL fails and keeps manual entry open | `不再内置服务商模板` |

### A · ai_subscription_stages_test.ts（7 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| ai_subscription_stages_test.ts:90 | §10.2 a logged-in account without plan usage says so explicitly | `ChatGPT 已登录，但没有授权套餐用量` |
| ai_subscription_stages_test.ts:98 | §10.2 a logged-in account without plan usage says so explicitly | `重新授权` |
| ai_subscription_stages_test.ts:115 | §10.3 model discovery and §10.4 inference stay separate stages | `没有可用模型` |
| ai_subscription_stages_test.ts:126 | §10.3 model discovery and §10.4 inference stay separate stages | `模型可选` |
| ai_subscription_stages_test.ts:130 | §10.3 model discovery and §10.4 inference stay separate stages | `没有改动课程内容` |
| ai_subscription_stages_test.ts:145 | §10.5 token refresh distinguishes「will refresh」from「refresh failed」 | `重新登录` |
| ai_subscription_stages_test.ts:176 | §10 login-stage states cover cancel, callback, session and native-only | `不会保存任何凭据` |

### A · ai_transport_test.ts（7 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| ai_transport_test.ts:582 | §9.4 a saved connection | `显示名称` [fixture] |
| ai_transport_test.ts:630 | §9.4 add-mode refuses a duplicate id and edit-mode refuses a phantom t | `已经存在` [fixture] |
| ai_transport_test.ts:1336 | a request URL carrying the key cannot leak through a url echo | `<url>` [fixture] |
| ai_transport_test.ts:2105 | a failing execution append surfaces an AI-scoped error, not a save fai | `AI 执行记录` [fixture] |
| ai_transport_test.ts:2548 | §4.3 model_meta rejects unknown fields, bad values and credential-shap | `不允许的字段` [fixture] |
| ai_transport_test.ts:2654 | §4.3 model_meta stays inside the 8KB and depth-4 provider limits | `过大` [fixture] |
| ai_transport_test.ts:2668 | §4.3 model_meta stays inside the 8KB and depth-4 provider limits | `层级过深` [fixture] |

### A · ai_ui_test.ts（102 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| ai_ui_test.ts:525 | an editor renders inside the card it belongs to: add card or provider  | `class="ai-provider-rows"` |
| ai_ui_test.ts:526 | an editor renders inside the card it belongs to: add card or provider  | `class="ai-add-card"` |
| ai_ui_test.ts:527 | an editor renders inside the card it belongs to: add card or provider  | `data-ai-editor="add"` |
| ai_ui_test.ts:534 | an editor renders inside the card it belongs to: add card or provider  | `data-ai-base-url` |
| ai_ui_test.ts:535 | an editor renders inside the card it belongs to: add card or provider  | `data-ai-api-protocol` |
| ai_ui_test.ts:539 | an editor renders inside the card it belongs to: add card or provider  | `data-provider-id="row-provider"` |
| ai_ui_test.ts:540 | an editor renders inside the card it belongs to: add card or provider  | `data-ai-editor="row"` |
| ai_ui_test.ts:544 | an editor renders inside the card it belongs to: add card or provider  | `class="ai-add-trigger"` |
| ai_ui_test.ts:656 | AI URL changes require an origin confirmation before saved Keys move | `未绑定域名` |
| ai_ui_test.ts:781 | the default provider is the offline connector and a run only adds a su | `本地确定性连接器` |
| ai_ui_test.ts:835 | a run with changes produces a reviewable ChangeDraft rendered from the | `修改前`<br>`修改后` |
| ai_ui_test.ts:836 | a run with changes produces a reviewable ChangeDraft rendered from the | `第一课的正文` [fixture] |
| ai_ui_test.ts:839 | a run with changes produces a reviewable ChangeDraft rendered from the | `应用这些修改` |
| ai_ui_test.ts:840 | a run with changes produces a reviewable ChangeDraft rendered from the | `拒绝` |
| ai_ui_test.ts:1003 | a failed review-record write only warns and never changes the Apply re | `执行记录` |
| ai_ui_test.ts:1115 | a shell failure carries its recommended action all the way to the pane | `请在 AI 设置里为这个 Provider 填写 API Key。` |
| ai_ui_test.ts:1196 | the panel discloses that no Tool, MCP or Skill is called | `还没有可用的模型连接` |
| ai_ui_test.ts:1214 | the panel names the AI storage location of the running shell | `本项目目录的 .workspace/ai` |
| ai_ui_test.ts:1215 | the panel names the AI storage location of the running shell | `课程文件不含凭据` |
| ai_ui_test.ts:1223 | the panel names the AI storage location of the running shell | `本机应用数据目录` |
| ai_ui_test.ts:1224 | the panel names the AI storage location of the running shell | `本项目目录的 .workspace/ai` |
| ai_ui_test.ts:1227 | the panel names the AI storage location of the running shell | `课程文件不含凭据` |
| ai_ui_test.ts:1270 | the execution history only shows the current project | `执行记录（1）` |
| ai_ui_test.ts:1351 | switching to another project clears the previous project | `执行记录（0）` |
| ai_ui_test.ts:1367 | switching to another project clears the previous project | `P2-范围标记` [fixture] |
| ai_ui_test.ts:1368 | switching to another project clears the previous project | `执行记录（1）` |
| ai_ui_test.ts:1378 | switching to another project clears the previous project | `P2-范围标记` [fixture] |
| ai_ui_test.ts:1451 | an apply after the underlying content changed is refused and keeps the | `不能应用` |
| ai_ui_test.ts:1544 | a failed execution-record write only warns and never fails the save | `执行记录` |
| ai_ui_test.ts:1586 | the panel never renders a provider credential value | `已配置密钥` |
| ai_ui_test.ts:1594 | the panel never renders a provider credential value | `课程文件不含凭据` |
| ai_ui_test.ts:1674 | connection management keeps provider metadata, keys, models, and selec | `data-action=\` |
| ai_ui_test.ts:1731 | connection management keeps provider metadata, keys, models, and selec | `服务商认证失败（401）` |
| ai_ui_test.ts:1734 | connection management keeps provider metadata, keys, models, and selec | `本机尚未保存 API Key` |
| ai_ui_test.ts:1770 | AI settings use one topbar modal; close clears a temporary key and pre | `还没有可用的模型连接` |
| ai_ui_test.ts:1771 | AI settings use one topbar modal; close clears a temporary key and pre | `data-action=\` |
| ai_ui_test.ts:1772 | AI settings use one topbar modal; close clears a temporary key and pre | `<select class="select" data-ai-provider>` |
| ai_ui_test.ts:1775 | AI settings use one topbar modal; close clears a temporary key and pre | `data-ai-api-protocol` |
| ai_ui_test.ts:1776 | AI settings use one topbar modal; close clears a temporary key and pre | `连接配置尚未保存` |
| ai_ui_test.ts:1780 | AI settings use one topbar modal; close clears a temporary key and pre | `data-ai-secret` |
| ai_ui_test.ts:1784 | AI settings use one topbar modal; close clears a temporary key and pre | `data-block-id="${block.id}"` |
| ai_ui_test.ts:1785 | AI settings use one topbar modal; close clears a temporary key and pre | `第一课的正文` [fixture] |
| ai_ui_test.ts:1813 | subscription login is native-only and the browser shell cannot report  | `当前浏览器服务壳不支持订阅登录` |
| ai_ui_test.ts:1817 | subscription login is native-only and the browser shell cannot report  | `data-action="ai-subscription-start"` |
| ai_ui_test.ts:1831 | subscription login is native-only and the browser shell cannot report  | `data-action="ai-subscription-start"` |
| ai_ui_test.ts:1892 | a key the shell cannot read back is never reported as configured | `/没有读回/`<br>`/凭据存储\|钥匙串/` |
| ai_ui_test.ts:2101 | the model catalog renders editable rows with order, edit and remove | `data-ai-model-rows` |
| ai_ui_test.ts:2103 | the model catalog renders editable rows with order, edit and remove | `data-action="ai-move-model"`<br>`data-dir="up"` |
| ai_ui_test.ts:2104 | the model catalog renders editable rows with order, edit and remove | `data-dir="down"` |
| ai_ui_test.ts:2107 | the model catalog renders editable rows with order, edit and remove | `data-action="ai-edit-model"`<br>`编辑` [fixture] |
| ai_ui_test.ts:2108 | the model catalog renders editable rows with order, edit and remove | `data-action="ai-remove-model"`<br>`移除` [fixture] |
| ai_ui_test.ts:2109 | the model catalog renders editable rows with order, edit and remove | `class="ai-model-id"` |
| ai_ui_test.ts:2114 | the model catalog renders editable rows with order, edit and remove | `显示名称` [fixture] |
| ai_ui_test.ts:2115 | the model catalog renders editable rows with order, edit and remove | `placeholder="留空显示 Model ID"` |
| ai_ui_test.ts:2116 | the model catalog renders editable rows with order, edit and remove | `上下文窗口`<br>`最大输出 token` |
| ai_ui_test.ts:2118 | the model catalog renders editable rows with order, edit and remove | `data-ai-model-context`<br>`data-ai-model-max-tokens` |
| ai_ui_test.ts:2121 | the model catalog renders editable rows with order, edit and remove | `输入类型`<br>`文本` [fixture]<br>`图片` [fixture] |
| ai_ui_test.ts:2123 | the model catalog renders editable rows with order, edit and remove | `value="甲模型"` [fixture] |
| ai_ui_test.ts:2197 | model row validation names the empty and duplicated Model ID on its ro | `Model ID 不能重复：model-a` |
| ai_ui_test.ts:2214 | model row validation names the empty and duplicated Model ID on its ro | `Model ID 不能重复：model-a` |
| ai_ui_test.ts:2245 | 「＋ 添加模型」adds one expanded row and puts the caret in its Model ID | `模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。` |
| ai_ui_test.ts:2295 | 「获取可用模型」opens the「选择模型」dialog whose ticks are the model list | `选择模型` |
| ai_ui_test.ts:2296 | 「获取可用模型」opens the「选择模型」dialog whose ticks are the model list | `勾选的模型即为模型列表` |
| ai_ui_test.ts:2297 | 「获取可用模型」opens the「选择模型」dialog whose ticks are the model list | `placeholder="搜索 Model ID"` |
| ai_ui_test.ts:2298 | 「获取可用模型」opens the「选择模型」dialog whose ticks are the model list | `>全选<`<br>`>取消全选<` |
| ai_ui_test.ts:2299 | 「获取可用模型」opens the「选择模型」dialog whose ticks are the model list | `>更新列表<` |
| ai_ui_test.ts:2300 | 「获取可用模型」opens the「选择模型」dialog whose ticks are the model list | `>取消<` |
| ai_ui_test.ts:2458 | an update that would empty the model list is refused (fetchKeepOne) | `请至少保留一个勾选的模型。` |
| ai_ui_test.ts:2460 | an update that would empty the model list is refused (fetchKeepOne) | `/data-action="ai-picker-confirm"[^>]*disabled/` |
| ai_ui_test.ts:2631 | a credential-shaped Model ID never carries a model_meta entry | `已保存` [fixture] |
| ai_ui_test.ts:2721 | a model row must keep at least one input type | `输入类型至少要保留一种。` |
| ai_ui_test.ts:2729 | a model row must keep at least one input type | `data-ai-model-error` |
| ai_ui_test.ts:2773 | 推理等级：开关、「?」说明与档位行按 design §2.1 渲染 | `data-action=` |
| ai_ui_test.ts:2774 | 推理等级：开关、「?」说明与档位行按 design §2.1 渲染 | `/data-action="ai-toggle-model-reasoning"[^>]*checked/` |
| ai_ui_test.ts:2775 | 推理等级：开关、「?」说明与档位行按 design §2.1 渲染 | `data-action=` |
| ai_ui_test.ts:2776 | 推理等级：开关、「?」说明与档位行按 design §2.1 渲染 | `data-action=` |
| ai_ui_test.ts:2777 | 推理等级：开关、「?」说明与档位行按 design §2.1 渲染 | `data-action=` |
| ai_ui_test.ts:2778 | 推理等级：开关、「?」说明与档位行按 design §2.1 渲染 | `API 参数值` |
| ai_ui_test.ts:2780 | 推理等级：开关、「?」说明与档位行按 design §2.1 渲染 | `/data-ai-tier-value[^>]*data-tier-key="tier-1"[^>]*value="off"[^>]*disabled/` |
| ai_ui_test.ts:2784 | 推理等级：开关、「?」说明与档位行按 design §2.1 渲染 | `/data-ai-tier-value[^>]*data-tier-key="tier-2"[^>]*value="medium"/` |
| ai_ui_test.ts:2785 | 推理等级：开关、「?」说明与档位行按 design §2.1 渲染 | `/data-ai-tier-value[^>]*data-tier-key="tier-2"[^>]*disabled/` |
| ai_ui_test.ts:2791 | 推理等级：开关、「?」说明与档位行按 design §2.1 渲染 | `档位=模型能力档，API 参数值=发送给该协议的参数值` |
| ai_ui_test.ts:2793 | 推理等级：开关、「?」说明与档位行按 design §2.1 渲染 | `开启后，未指定档位时使用最强档；调用时可指定档位，off 表示不下发推理参数。` |
| ai_ui_test.ts:2896 | 推理等级：「添加档位」按升级顺序补档，档位用完即禁用 | `/data-action="ai-add-tier"[^>]*disabled/` |
| ai_ui_test.ts:2950 | 推理等级校验：design §3 文案逐字，离开字段把档位名填回 | `/data-ai-tier-value[^>]*aria-invalid="true"/` |
| ai_ui_test.ts:3113 | 「＋ 添加模型提供商」分段切换不丢草稿：切走再切回已填字段仍在 | `连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口，需填写 API 地址、协议和模型。` |
| ai_ui_test.ts:3133 | 「＋ 添加模型提供商」分段切换不丢草稿：切走再切回已填字段仍在 | `填写服务商的地址、协议与 API 密钥，然后获取它自己的模型列表。` |
| ai_ui_test.ts:3169 | 行内编辑卡「收起」后重开同一 provider：已填字段仍在（reuse 分支） | `value="行内草稿显示名"` [fixture] |
| ai_ui_test.ts:3177 | 行内编辑卡「收起」后重开同一 provider：已填字段仍在（reuse 分支） | `data-ai-editor="row"` |
| ai_ui_test.ts:3185 | 行内编辑卡「收起」后重开同一 provider：已填字段仍在（reuse 分支） | `value="行内草稿显示名"` [fixture] |
| ai_ui_test.ts:3187 | 行内编辑卡「收起」后重开同一 provider：已填字段仍在（reuse 分支） | `data-ai-base-url` |
| ai_ui_test.ts:3223 | 行卡与新增卡两个草稿槽互不丢弃：开一张编辑卡不清另一张的草稿 | `value="行卡草稿显示名"` [fixture] |
| ai_ui_test.ts:3224 | 行卡与新增卡两个草稿槽互不丢弃：开一张编辑卡不清另一张的草稿 | `value="新增草稿显示名"` [fixture] |
| ai_ui_test.ts:3233 | 行卡与新增卡两个草稿槽互不丢弃：开一张编辑卡不清另一张的草稿 | `value="新增草稿显示名"` [fixture] |
| ai_ui_test.ts:3235 | 行卡与新增卡两个草稿槽互不丢弃：开一张编辑卡不清另一张的草稿 | `value="行卡草稿显示名"` [fixture] |
| ai_ui_test.ts:3244 | 行卡与新增卡两个草稿槽互不丢弃：开一张编辑卡不清另一张的草稿 | `value="行卡草稿显示名"` [fixture] |
| ai_ui_test.ts:3257 | 渲染文案逐字：「创建提供商」「粘贴 API Key（不会回显）」「删除本机保存的密钥」 | `>创建提供商</button>` |
| ai_ui_test.ts:3258 | 渲染文案逐字：「创建提供商」「粘贴 API Key（不会回显）」「删除本机保存的密钥」 | `粘贴 API Key（不会回显）` |
| ai_ui_test.ts:3259 | 渲染文案逐字：「创建提供商」「粘贴 API Key（不会回显）」「删除本机保存的密钥」 | `删除本机保存的密钥` |
| ai_ui_test.ts:3298 | 渲染文案逐字：「读取模型失败：」与「不需要密钥（离线连接器）。」 | `读取模型失败：` |
| ai_ui_test.ts:3300 | 渲染文案逐字：「读取模型失败：」与「不需要密钥（离线连接器）。」 | `可以直接在下面手动填写 Model ID，不影响保存` |
| ai_ui_test.ts:3308 | 渲染文案逐字：「读取模型失败：」与「不需要密钥（离线连接器）。」 | `不需要密钥（离线连接器）。` |

### A · ai_workflow_test.ts（42 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| ai_workflow_test.ts:299 | course scope ships the whole course and stays traceable | `整门课程` [fixture] |
| ai_workflow_test.ts:355 | lesson and block scope never ship another lesson | `其他课次` [fixture] |
| ai_workflow_test.ts:384 | lesson and block scope never ship another lesson | `本课结构` [fixture] |
| ai_workflow_test.ts:390 | lesson and block scope never ship another lesson | `区块范围` [fixture] |
| ai_workflow_test.ts:460 | context limits are reported honestly instead of dropping silently | `超出单次上下文长度上限` |
| ai_workflow_test.ts:464 | context limits are reported honestly instead of dropping silently | `已截断` [fixture] |
| ai_workflow_test.ts:488 | an archived lesson cannot be an AI scope | `归档` [fixture] |
| ai_workflow_test.ts:506 | excluded entries honestly report the categories the caller turned off | `待补要求` [fixture] |
| ai_workflow_test.ts:507 | excluded entries honestly report the categories the caller turned off | `素材信息` [fixture] |
| ai_workflow_test.ts:508 | excluded entries honestly report the categories the caller turned off | `完成度与状态` [fixture] |
| ai_workflow_test.ts:509 | excluded entries honestly report the categories the caller turned off | `相邻内容` [fixture] |
| ai_workflow_test.ts:558 | requirements and assets are included when they are switched on | `补一张章节配图` [fixture] |
| ai_workflow_test.ts:564 | requirements and assets are included when they are switched on | `封面.png` [fixture] |
| ai_workflow_test.ts:594 | context never carries credentials and redacts credential-shaped text | `已隐藏` [fixture] |
| ai_workflow_test.ts:598 | context never carries credentials and redacts credential-shaped text | `密钥` [fixture] |
| ai_workflow_test.ts:630 | context preview and prompt payload describe exactly what is sent | `解释这一段在讲什么` [fixture] |
| ai_workflow_test.ts:634 | context preview and prompt payload describe exactly what is sent | `【用户要求】` |
| ai_workflow_test.ts:635 | context preview and prompt payload describe exactly what is sent | `## 用户要求` |
| ai_workflow_test.ts:652 | scope resolution fails readably when there is nothing to target | `还没有课次` [fixture] |
| ai_workflow_test.ts:891 | buildAiProviderCall reports an unconfigured connection readably | `不再内置服务商模板` |
| ai_workflow_test.ts:895 | buildAiProviderCall reports an unconfigured connection readably | `设置 → 模型` |
| ai_workflow_test.ts:916 | buildAiProviderCall reports an unconfigured connection readably | `不再内置服务商模板` |
| ai_workflow_test.ts:1279 | parseAiAnswer treats prose as an answer but rejects broken change inte | `大纲` [fixture] |
| ai_workflow_test.ts:1350 | FakeAiConnector is deterministic and offline | `解释这一段` [fixture] |
| ai_workflow_test.ts:1411 | FakeAiConnector synthesises a reviewable rewrite for block scope | `【本地示例改写】` |
| ai_workflow_test.ts:1429 | FakeAiConnector synthesises a reviewable rewrite for block scope | `本地` [fixture]<br>`没有联网` [fixture] |
| ai_workflow_test.ts:1452 | FakeAiConnector synthesises a reviewable rewrite for block scope | `【本地示例改写】` |
| ai_workflow_test.ts:1505 | FakeAiConnector stays read-only for explanation requests | `不会改动课程内容` |
| ai_workflow_test.ts:1513 | FakeAiConnector stays read-only for explanation requests | `【本地示例改写】` |
| ai_workflow_test.ts:1558 | FakeAiConnector synthesis is deterministic and never empty | `【本地示例改写】` |
| ai_workflow_test.ts:1814 | HttpAiConnector maps connection-level codes without hiding the reason | `可写的课程项目` |
| ai_workflow_test.ts:1866 | HttpAiConnector keeps structured codes and text heuristics apart | `已取消` |
| ai_workflow_test.ts:2434 | create_requirement produces a canonical Requirement row | `视频` [fixture] |
| ai_workflow_test.ts:2495 | move_block reorders the lesson and diffs the affected window | `第二段正文` [fixture] |
| ai_workflow_test.ts:2496 | move_block reorders the lesson and diffs the affected window | `第二段` [fixture] |
| ai_workflow_test.ts:2546 | rejectAiChangeDraft leaves every block and requirement untouched | `不该被写入的正文` [fixture] |
| ai_workflow_test.ts:2550 | rejectAiChangeDraft leaves every block and requirement untouched | `这不是我想要的语气` [fixture] |
| ai_workflow_test.ts:2561 | rejectAiChangeDraft leaves every block and requirement untouched | `不能应用` |
| ai_workflow_test.ts:2726 | course scope refuses changes that belong to another lesson | `切换` [fixture] |
| ai_workflow_test.ts:2931 | offline end-to-end: context → call → parse → suggestion → draft → appl | `改写后的新手友好正文` [fixture] |
| ai_workflow_test.ts:3195 | §4.4 anthropic sends thinking.budget_tokens only for a plain number | `请改为预算数字或改用 OpenAI 协议` |
| ai_workflow_test.ts:3207 | §4.4 a named tier outside the declaration injects nothing but explains | `没有下发推理参数` |

### A · asset_batch_import_test.ts（14 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| asset_batch_import_test.ts:275 | native multi-select import runs one batch and undoes as one step | `已导入 3 个素材` |
| asset_batch_import_test.ts:300 | one unreadable file never cancels the rest of the batch | `已导入 2 个素材` |
| asset_batch_import_test.ts:301 | one unreadable file never cancels the rest of the batch | `1 个失败` |
| asset_batch_import_test.ts:319 | a checksum hit counts as a duplicate and adds no undo step | `已导入 1 个素材` |
| asset_batch_import_test.ts:320 | a checksum hit counts as a duplicate and adds no undo step | `1 个已按 checksum 复用` |
| asset_batch_import_test.ts:321 | a checksum hit counts as a duplicate and adds no undo step | `失败` [fixture] |
| asset_batch_import_test.ts:336 | a checksum hit counts as a duplicate and adds no undo step | `1 个已按 checksum 复用`<br>`失败` [fixture] |
| asset_batch_import_test.ts:358 | an empty or cancelled selection imports nothing and changes nothing | `没有选择素材文件` |
| asset_batch_import_test.ts:384 | the same file picked twice is skipped, not imported twice | `1 个重复或不适用条目已跳过` |
| asset_batch_import_test.ts:405 | the browser shell imports every dropped file as one batch | `已将 2 个素材` |
| asset_batch_import_test.ts:433 | a failing browser drop still reports the files that landed | `已将 1 个素材` |
| asset_batch_import_test.ts:434 | a failing browser drop still reports the files that landed | `1 个失败` |
| asset_batch_import_test.ts:461 | browser import rejects unsupported and oversized files before bufferin | `2 个失败` |
| asset_batch_import_test.ts:471 | the hidden browser picker accepts multiple files | `/<input[^>]*\bmultiple\b[^>]*data-project-file/` |

### A · asset_thumbnail_test.ts（3 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| asset_thumbnail_test.ts:525 | a PNG that cannot be decoded reports the real failure, not a placehold | `解码` [fixture] |
| asset_thumbnail_test.ts:526 | a PNG that cannot be decoded reports the real failure, not a placehold | `画面` [fixture] |
| asset_thumbnail_test.ts:688 | oversize asset bytes report the preview-cap failure with its unit | `素材超过单文件预览上限` |

### A · authoring_test.ts（14 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| authoring_test.ts:134 | lesson view projects blocks, gaps and asset references from canonical  | `待补` [fixture] |
| authoring_test.ts:516 | preview projection reads the same blocks the export reads | `<h1>标题</h1>` |
| authoring_test.ts:517 | preview projection reads the same blocks the export reads | `<strong>加粗</strong>` |
| authoring_test.ts:518 | preview projection reads the same blocks the export reads | `<code>代码</code>` |
| authoring_test.ts:519 | preview projection reads the same blocks the export reads | `<ul>`<br>`<li>一</li>` |
| authoring_test.ts:520 | preview projection reads the same blocks the export reads | `<blockquote>引用</blockquote>` |
| authoring_test.ts:522 | preview projection reads the same blocks the export reads | `<img` |
| authoring_test.ts:562 | the course-input hints teach the structure the Domain really builds | `缩进` [fixture] |
| authoring_test.ts:608 | requirement anchors name lesson + block, never 位置：待补 | `S01-02 · 正文 ` [fixture] |
| authoring_test.ts:611 | requirement anchors name lesson + block, never 位置：待补 | `待补` [fixture] |
| authoring_test.ts:612 | requirement anchors name lesson + block, never 位置：待补 | `位置：` [fixture] |
| authoring_test.ts:620 | requirement anchors name lesson + block, never 位置：待补 | `S01-02 · 图片 ` [fixture] |
| authoring_test.ts:623 | requirement anchors name lesson + block, never 位置：待补 | `待补` [fixture] |
| authoring_test.ts:741 | stage CRUD: empty delete removes the stage; non-empty refuses | `节课` [fixture] |

### A · authoring_ui_test.ts（89 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| authoring_ui_test.ts:580 | snapshot creation freezes the clicked revision and reports index save  | `索引尚未写入` |
| authoring_ui_test.ts:584 | snapshot creation freezes the clicked revision and reports index save  | `持久化确认有限` |
| authoring_ui_test.ts:647 | snapshot restore reports committed content with limited durability con | `已恢复历史版本` |
| authoring_ui_test.ts:648 | snapshot restore reports committed content with limited durability con | `持久化确认有限` |
| authoring_ui_test.ts:687 | version history formats ISO and native epoch-millisecond timestamps | `保存时间未知` |
| authoring_ui_test.ts:710 | restore stops when the pending Canonical save cannot drain | `没有恢复` |
| authoring_ui_test.ts:817 | session write failure leaves saved content intact and ignores stale pr | `课程内容已经保存，但阅读位置没有记住` |
| authoring_ui_test.ts:1166 | removed Flow and layout routes resume in the canonical editor | `保留的课程正文` |
| authoring_ui_test.ts:1167 | removed Flow and layout routes resume in the canonical editor | `data-mode="structure"` |
| authoring_ui_test.ts:1168 | removed Flow and layout routes resume in the canonical editor | `data-flow-drag-handle` |
| authoring_ui_test.ts:1169 | removed Flow and layout routes resume in the canonical editor | `data-route="free-layout"` |
| authoring_ui_test.ts:1528 | delete confirmation leaves data intact on cancel or Escape and commits | `aria-modal="true"` |
| authoring_ui_test.ts:2095 | legacy paged layout remains stored while editor and publish stay avail | `分页中的真实正文` [fixture] |
| authoring_ui_test.ts:2114 | legacy paged layout remains stored while editor and publish stay avail | `data-action=\` |
| authoring_ui_test.ts:2115 | legacy paged layout remains stored while editor and publish stay avail | `data-action=\` |
| authoring_ui_test.ts:2180 | whole-course PDF and PPTX fit preview includes every lesson page | `页面尺寸不同，需选择统一尺寸` |
| authoring_ui_test.ts:2181 | whole-course PDF and PPTX fit preview includes every lesson page | `data-action="publish-target-size"` |
| authoring_ui_test.ts:2198 | whole-course PDF and PPTX fit preview includes every lesson page | `横版页面`<br>`竖版页面` |
| authoring_ui_test.ts:2237 | completion state is derived from real data and drives navigation | `正文` [fixture] |
| authoring_ui_test.ts:2508 | browser export hands staged URLs to the download engine without an ear | `浏览器下载列表` |
| authoring_ui_test.ts:2841 | a project replaced on disk is never overwritten under the wrong identi | `已经被替换` |
| authoring_ui_test.ts:3147 | the browser export mirrors media resolution and never leaks filenames | `![封面.png](assets/封面.png)` [fixture] |
| authoring_ui_test.ts:3151 | the browser export mirrors media resolution and never leaks filenames | `/^封面\.png$/` [fixture] |
| authoring_ui_test.ts:3155 | the browser export mirrors media resolution and never leaks filenames | `正文` [fixture] |
| authoring_ui_test.ts:3264 | legacy Preview route keeps Markdown media mappings without a separate  | `2 个已在正文中显示` |
| authoring_ui_test.ts:3265 | legacy Preview route keeps Markdown media mappings without a separate  | `data-mode="preview"` |
| authoring_ui_test.ts:3266 | legacy Preview route keeps Markdown media mappings without a separate  | `保留映射` |
| authoring_ui_test.ts:3280 | block palette includes + 媒体 as a peer of + 正文 | `["media", "媒体"]`<br>`媒体` [fixture] |
| authoring_ui_test.ts:3284 | block palette includes + 媒体 as a peer of + 正文 | `data-action="insert-block"` |
| authoring_ui_test.ts:3288 | block palette includes + 媒体 as a peer of + 正文 | `插入到当前位置` |
| authoring_ui_test.ts:3292 | block palette includes + 媒体 as a peer of + 正文 | `data-action="insert-asset"` |
| authoring_ui_test.ts:3428 | Media Library insert-asset action shares insertAsset position semantic | `插入到当前位置` |
| authoring_ui_test.ts:3432 | Media Library insert-asset action shares insertAsset position semantic | `data-action="insert-asset"` |
| authoring_ui_test.ts:3439 | Media Library insert-asset action shares insertAsset position semantic | `选中区块之后`<br>`当前选中区块之后` |
| authoring_ui_test.ts:3440 | Media Library insert-asset action shares insertAsset position semantic | `课末尾`<br>`课末` |
| authoring_ui_test.ts:3482 | requirement panel shows real anchors and type-specific actions | `未定位` |
| authoring_ui_test.ts:3486 | requirement panel shows real anchors and type-specific actions | `/位置：\$\{esc\(blockLabel\(block\.type\)\)\}/` |
| authoring_ui_test.ts:3515 | requirement panel shows real anchors and type-specific actions | `补充这段文字`<br>`补一张图片` |
| authoring_ui_test.ts:3516 | requirement panel shows real anchors and type-specific actions | `data-action="focus-requirement"` |
| authoring_ui_test.ts:3517 | requirement panel shows real anchors and type-specific actions | `定位` |
| authoring_ui_test.ts:3518 | requirement panel shows real anchors and type-specific actions | `AI 助手` |
| authoring_ui_test.ts:3519 | requirement panel shows real anchors and type-specific actions | `data-panel="requirements"` |
| authoring_ui_test.ts:3538 | renaming an asset renames the managed file and stays reversible | `data-action="rename-asset"` |
| authoring_ui_test.ts:3539 | renaming an asset renames the managed file and stays reversible | `data-asset-title` |
| authoring_ui_test.ts:3543 | renaming an asset renames the managed file and stays reversible | `/磁盘文件同步改名/` |
| authoring_ui_test.ts:3547 | renaming an asset renames the managed file and stays reversible | `data-focus-key="asset-menu-${esc(asset.id)}"` |
| authoring_ui_test.ts:3548 | renaming an asset renames the managed file and stays reversible | `data-focus-key="${esc(focusKey)}" data-action="open-asset-image"` |
| authoring_ui_test.ts:3619 | renaming an asset renames the managed file and stays reversible | `data-action="confirm-rename-asset"` |
| authoring_ui_test.ts:3620 | renaming an asset renames the managed file and stays reversible | `托管文件` |
| authoring_ui_test.ts:3621 | renaming an asset renames the managed file and stays reversible | `data-asset-title` |
| authoring_ui_test.ts:3639 | renaming an asset renames the managed file and stays reversible | `已重命名文件` |
| authoring_ui_test.ts:3698 | renaming an asset renames the managed file and stays reversible | `不能为空` |
| authoring_ui_test.ts:3718 | renaming an asset renames the managed file and stays reversible | `已有一个素材使用这个文件名` |
| authoring_ui_test.ts:3729 | renaming an asset renames the managed file and stays reversible | `已有一个素材使用这个文件名` |
| authoring_ui_test.ts:3810 | an uncertain canonical mutation pauses later saves without discarding  | `结果暂时无法确认` |
| authoring_ui_test.ts:3812 | an uncertain canonical mutation pauses later saves without discarding  | `data-action="verify-save-result"` |
| authoring_ui_test.ts:3829 | an uncertain canonical mutation pauses later saves without discarding  | `本地修改` |
| authoring_ui_test.ts:4070 | a locked project offers safe retry and return without taking its lock | `项目正在使用` |
| authoring_ui_test.ts:4071 | a locked project offers safe retry and return without taking its lock | `data-action="retry-locked-project"` |
| authoring_ui_test.ts:4072 | a locked project offers safe retry and return without taking its lock | `data-action="dismiss-project-problem"` |
| authoring_ui_test.ts:4073 | a locked project offers safe retry and return without taking its lock | `没有接管项目锁` |
| authoring_ui_test.ts:4196 | stage CRUD store: add rename reorder empty delete and non-empty safety | `确认` [fixture] |
| authoring_ui_test.ts:4223 | stage CRUD store: add rename reorder empty delete and non-empty safety | `节课` [fixture] |
| authoring_ui_test.ts:4239 | course map stage header exposes add rename reorder delete actions | `data-action="add-stage"` |
| authoring_ui_test.ts:4240 | course map stage header exposes add rename reorder delete actions | `新阶段` [fixture] |
| authoring_ui_test.ts:4241 | course map stage header exposes add rename reorder delete actions | `data-action="rename-stage"` |
| authoring_ui_test.ts:4242 | course map stage header exposes add rename reorder delete actions | `data-action="move-stage"` |
| authoring_ui_test.ts:4243 | course map stage header exposes add rename reorder delete actions | `data-action="delete-stage"` |
| authoring_ui_test.ts:4270 | course map stage header exposes add rename reorder delete actions | `data-action=\` |
| authoring_ui_test.ts:4271 | course map stage header exposes add rename reorder delete actions | `新阶段` [fixture] |
| authoring_ui_test.ts:4272 | course map stage header exposes add rename reorder delete actions | `data-action=\` |
| authoring_ui_test.ts:4273 | course map stage header exposes add rename reorder delete actions | `data-action=\` |
| authoring_ui_test.ts:4274 | course map stage header exposes add rename reorder delete actions | `data-action=\` |
| authoring_ui_test.ts:4276 | course map stage header exposes add rename reorder delete actions | `第一阶段` [fixture]<br>`第二阶段` [fixture] |
| authoring_ui_test.ts:4294 | assetThumb gives non-blank previews for image video markdown and attac | `<video` |
| authoring_ui_test.ts:4825 | project and stage details live in settings and the course overview | `data-title-surface="settings"` |
| authoring_ui_test.ts:4843 | project and stage details live in settings and the course overview | `AI 助手` |
| authoring_ui_test.ts:4844 | project and stage details live in settings and the course overview | `data-panel-scope="项目 · ${projectTitle}"` |
| authoring_ui_test.ts:4845 | project and stage details live in settings and the course overview | `data-panel-scope="课时 ·` |
| authoring_ui_test.ts:4937 | legacy page-move state cannot open a canvas inside the lesson editor | `跨页目标面板` [fixture] |
| authoring_ui_test.ts:4958 | legacy continuous Grid remains stored without a visible layout editor | `连续网格正文` [fixture] |
| authoring_ui_test.ts:4977 | legacy pagination state remains data-only in the canonical editor | `分页编辑状态课` [fixture] |
| authoring_ui_test.ts:4978 | legacy pagination state remains data-only in the canonical editor | `退出分页编辑`<br>`data-action=\` |
| authoring_ui_test.ts:4998 | legacy page selection never creates a second visible editor projection | `页面标题去重课` [fixture] |
| authoring_ui_test.ts:4999 | legacy page selection never creates a second visible editor projection | `data-page-id="` |
| authoring_ui_test.ts:5133 | PowerPoint export renders durability warnings as escaped alerts | `role="alert">导出文件的持久化确认不完整：` |
| authoring_ui_test.ts:5134 | PowerPoint export renders durability warnings as escaped alerts | `目录同步尚未确认 &lt;待重试&gt;` |
| authoring_ui_test.ts:5165 | resource recovery warnings from project and task state remain visible | `项目恢复状态 &lt;待确认&gt;` |
| authoring_ui_test.ts:5166 | resource recovery warnings from project and task state remain visible | `任务回执 &lt;待确认&gt;` |

### A · browser_session_test.ts（2 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| browser_session_test.ts:386 | browser reload migrates a saved free-layout route to the current lesso | `旧版排版` [fixture] |
| browser_session_test.ts:509 | browser export preflight uses the real query route | `该操作不受支持` |

### A · completeness_test.ts（1 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| completeness_test.ts:50 | canonical validation fails closed on FK, enum, unique and cross-projec | `项目校验失败` |

### A · core_test.ts（2 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| core_test.ts:118 | Blueprint confirmation keeps reordered stage parents and root content  | `根内容` [fixture] |
| core_test.ts:511 | JSON round-trip and Markdown are open, generated views | `可迁移正文` [fixture] |

### A · descendant_media_adoption_test.ts（3 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| descendant_media_adoption_test.ts:96 | a selected directory imports descendant media as assets only | `递归收录 5` [fixture] |
| descendant_media_adoption_test.ts:170 | descendant media never follows a symlink out of the folder | `符号链接` |
| descendant_media_adoption_test.ts:214 | a descendant the plan already lists keeps its own row and imports once | `递归收录 4` [fixture] |

### A · document_import_dialog_test.ts（39 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| document_import_dialog_test.ts:337 | a confirmed plan with document candidates stops at the body dialog | `选择要导入为正文的文档` |
| document_import_dialog_test.ts:338 | a confirmed plan with document candidates stops at the body dialog | `data-action="document-import-confirm"` |
| document_import_dialog_test.ts:339 | a confirmed plan with document candidates stops at the body dialog | `data-action="document-import-cancel"` |
| document_import_dialog_test.ts:340 | a confirmed plan with document candidates stops at the body dialog | `导入所选正文` |
| document_import_dialog_test.ts:423 | direct documents are grouped by their selected root-level parent | `根目录` |
| document_import_dialog_test.ts:452 | every candidate row shows name, relative path, type and size | `>导论.md<` [fixture] |
| document_import_dialog_test.ts:453 | every candidate row shows name, relative path, type and size | `s01-00/导论.md · Markdown · 2 KB` [fixture] |
| document_import_dialog_test.ts:455 | every candidate row shows name, relative path, type and size | `aria-label="将 slides.pdf 导入为正文"` |
| document_import_dialog_test.ts:475 | 全选 and 取消全选 move every candidate together | `已选 3 / 3 项` |
| document_import_dialog_test.ts:478 | 全选 and 取消全选 move every candidate together | `已选 0 / 3 项` |
| document_import_dialog_test.ts:487 | 全选 and 取消全选 move every candidate together | `已选 3 / 3 项` |
| document_import_dialog_test.ts:493 | 全选 and 取消全选 move every candidate together | `data-action="document-import-all"` |
| document_import_dialog_test.ts:494 | 全选 and 取消全选 move every candidate together | `data-action="document-import-none"` |
| document_import_dialog_test.ts:520 | clicking the row — not only its checkbox — toggles that document | `data-document-import-row data-path="s01-00/a.txt" data-selected="true"` |
| document_import_dialog_test.ts:539 | clicking the row — not only its checkbox — toggles that document | `data-path="s01-00/a.txt" data-selected="false"` |
| document_import_dialog_test.ts:540 | clicking the row — not only its checkbox — toggles that document | `已选 1 / 2 项` |
| document_import_dialog_test.ts:558 | failed child scans block import until a retry succeeds | `文档扫描没有完成` |
| document_import_dialog_test.ts:559 | failed child scans block import until a retry succeeds | `data-action="document-import-retry"` |
| document_import_dialog_test.ts:560 | failed child scans block import until a retry succeeds | `data-action="document-import-confirm" disabled` |
| document_import_dialog_test.ts:576 | failed child scans block import until a retry succeeds | `文档扫描没有完成` |
| document_import_dialog_test.ts:700 | an unchecked document is never sent to folder.adopt | `已原地接管` |
| document_import_dialog_test.ts:774 | cancelling the dialog sends nothing and leaves the plan un-adopted | `没有写入任何课程内容` |
| document_import_dialog_test.ts:775 | cancelling the dialog sends nothing and leaves the plan un-adopted | `源文件仍在原处` |
| document_import_dialog_test.ts:777 | cancelling the dialog sends nothing and leaves the plan un-adopted | `映射预览` |
| document_import_dialog_test.ts:835 | the §28 tally renders from the shell | `正文导入结果` |
| document_import_dialog_test.ts:837 | the §28 tally renders from the shell | `正文导入：成功 2 · 降级 1 · 跳过 0 · 失败 1` |
| document_import_dialog_test.ts:838 | the §28 tally renders from the shell | `未进入正文：s01-02/scan.pdf` |
| document_import_dialog_test.ts:839 | the §28 tally renders from the shell | `已原地接管` |
| document_import_dialog_test.ts:857 | a shell with no document_import still reports the import, without a ta | `正文导入结果` |
| document_import_dialog_test.ts:858 | a shell with no document_import still reports the import, without a ta | `成功 0 · 降级 0 · 跳过 0 · 失败 0` |
| document_import_dialog_test.ts:859 | a shell with no document_import still reports the import, without a ta | `图片依赖缺失` |
| document_import_dialog_test.ts:860 | a shell with no document_import still reports the import, without a ta | `已原地接管` |
| document_import_dialog_test.ts:936 | long and hostile document names are escaped, never injected | `<script>alert(1)</script>` |
| document_import_dialog_test.ts:937 | long and hostile document names are escaped, never injected | `<script` |
| document_import_dialog_test.ts:942 | long and hostile document names are escaped, never injected | `很长的章节名称` [fixture] |
| document_import_dialog_test.ts:1037 | the browser shell fails unsupported documents without losing the batch | `桌面应用` |
| document_import_dialog_test.ts:1319 | Deno adoption parses only checked child Markdown and links only refere | `GIF示例` [fixture] |
| document_import_dialog_test.ts:1320 | Deno adoption parses only checked child Markdown and links only refere | `结尾` [fixture] |
| document_import_dialog_test.ts:1322 | Deno adoption parses only checked child Markdown and links only refere | `不可进入正文` |

### A · dogfooding_test.ts（49 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| dogfooding_test.ts:107 | (top-level) | `[data-action=` |
| dogfooding_test.ts:171 | (top-level) | `role="dialog" aria-modal="true"` |
| dogfooding_test.ts:207 | (top-level) | `class="center"` |
| dogfooding_test.ts:221 | (top-level) | `class="center"` |
| dogfooding_test.ts:547 | the project picker opens A, B, and A again without going silent | `/无法打开项目/` |
| dogfooding_test.ts:555 | the project picker opens A, B, and A again without going silent | `/没有选择文件夹/` |
| dogfooding_test.ts:584 | empty folder open explains missing project.json and next steps | `/还没有 project\.json/` |
| dogfooding_test.ts:585 | empty folder open explains missing project.json and next steps | `/资料文件夹导入/` |
| dogfooding_test.ts:587 | empty folder open explains missing project.json and next steps | `/选择其他\|新建课程\|导入已有文件夹/` |
| dogfooding_test.ts:613 | invalid project JSON open explains damage instead of opaque-only copy | `/损坏\|无效/` |
| dogfooding_test.ts:616 | invalid project JSON open explains damage instead of opaque-only copy | `/project\.json\|项目 JSON/` |
| dogfooding_test.ts:619 | invalid project JSON open explains damage instead of opaque-only copy | `/必须.*project\.bak\|需要.*project\.bak/` |
| dogfooding_test.ts:639 | malformed project payload open explains structure, not opaque-only cop | `/不是.*Workbench 项目\|不是可用\|无法识别\|缺少\|结构/` |
| dogfooding_test.ts:643 | malformed project payload open explains structure, not opaque-only cop | `/选择其他\|新建课程\|导入已有文件夹/` |
| dogfooding_test.ts:693 | autosave refreshes the chrome without rebuilding the editor | `正在保存…` |
| dogfooding_test.ts:699 | autosave refreshes the chrome without rebuilding the editor | `已保存` [fixture] |
| dogfooding_test.ts:1000 | hint text never reaches canonical content | `data-placeholder="${esc(placeholder)}"`<br>`aria-placeholder="${esc(placeholder)}"` |
| dogfooding_test.ts:1004 | hint text never reaches canonical content | `.markdown-rich-editor[data-empty="true"]::before` |
| dogfooding_test.ts:1039 | block details open in a local dialog while the AI panel stays present | `AI 助手` |
| dogfooding_test.ts:1040 | block details open in a local dialog while the AI panel stays present | `data-action="open-block-properties"` |
| dogfooding_test.ts:1043 | block details open in a local dialog while the AI panel stays present | `class="modal block-properties-modal"` |
| dogfooding_test.ts:1044 | block details open in a local dialog while the AI panel stays present | `data-block-text` |
| dogfooding_test.ts:1045 | block details open in a local dialog while the AI panel stays present | `AI 助手` |
| dogfooding_test.ts:1088 | every overlay hands the caret to its field when it opens | `data-focus-key="${key}"` |
| dogfooding_test.ts:1130 | blur into an action keeps the editor and action alive until click disp | `data-focus-key="snapshot-name"` |
| dogfooding_test.ts:1176 | pointerdown preserves an action through native blur without relatedTar | `data-focus-key="snapshot-name"` |
| dogfooding_test.ts:1341 | a real click on the course title opens the inline editor and it stays  | `data-project-title` |
| dogfooding_test.ts:1342 | a real click on the course title opens the inline editor and it stays  | `data-focus-key="project-title"` |
| dogfooding_test.ts:1493 | legacy free-layout data remains intact while its route opens the edito | `data-grid-surface` |
| dogfooding_test.ts:1655 | legacy placement data does not render removed Grid interaction control | `留在下面的第二段` [fixture] |
| dogfooding_test.ts:1659 | legacy placement data does not render removed Grid interaction control | `data-grid-surface`<br>`data-action=\` |
| dogfooding_test.ts:1702 | modal keyboard trap wraps Tab, skips hidden controls and Escape restor | `class="palette modal" role="dialog" aria-modal="true"` |
| dogfooding_test.ts:1761 | a failed merge preview exposes explicit keep-local without writing or  | `合并冲突 <b>1</b>` |
| dogfooding_test.ts:1762 | a failed merge preview exposes explicit keep-local without writing or  | `data-action="external-keep-local"` |
| dogfooding_test.ts:1776 | a failed merge preview exposes explicit keep-local without writing or  | `合并冲突 <b>0</b>` |
| dogfooding_test.ts:1777 | a failed merge preview exposes explicit keep-local without writing or  | `data-action="external-keep-local"` |
| dogfooding_test.ts:1968 | a single lesson reports gaps instead of a made-up percentage | `待补` [fixture] |
| dogfooding_test.ts:2105 | accepted resource can be explicitly reused in another planned lesson | `已保存为` |
| dogfooding_test.ts:2106 | accepted resource can be explicitly reused in another planned lesson | `洪灾响应案例` [fixture] |
| dogfooding_test.ts:2107 | accepted resource can be explicitly reused in another planned lesson | `已用于：${first.code} ${first.title}` |
| dogfooding_test.ts:2108 | accepted resource can be explicitly reused in another planned lesson | `添加到当前课` |
| dogfooding_test.ts:2109 | accepted resource can be explicitly reused in another planned lesson | `data-lesson="${second.id}"` |
| dogfooding_test.ts:2110 | accepted resource can be explicitly reused in another planned lesson | `本候选将作为新资源保存` |
| dogfooding_test.ts:2175 | resource merge needs a readable same-event confirmation | `2026 汛情复盘` [fixture] |
| dogfooding_test.ts:2177 | resource merge needs a readable same-event confirmation | `区县防洪复盘` [fixture] |
| dogfooding_test.ts:2178 | resource merge needs a readable same-event confirmation | `属于同一事件` |
| dogfooding_test.ts:2182 | resource merge needs a readable same-event confirmation | `确认` [fixture] |
| dogfooding_test.ts:2240 | manual video timing is confirmed, bounded and sent without a metadata  | `人工查看记录，不代表字幕或口播已校验` |
| dogfooding_test.ts:2244 | manual video timing is confirmed, bounded and sent without a metadata  | `不能同时选择` |

### A · editor_compile_test.ts（9 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| editor_compile_test.ts:583 | conversion refuses ambiguous structures and enables typed list renderi | `<ul>`<br>`<li><p>项目一 *字面星号*</p>` |
| editor_compile_test.ts:584 | conversion refuses ambiguous structures and enables typed list renderi | `<em>字面星号</em>` |
| editor_compile_test.ts:715 | the block UI has no B/I/S buttons and no Markdown source surface | `>源码<` |
| editor_compile_test.ts:718 | the block UI has no B/I/S buttons and no Markdown source surface | `class="markdown-rich-editor` |
| editor_compile_test.ts:722 | the block UI has no B/I/S buttons and no Markdown source surface | `<strong>你好</strong>` |
| editor_compile_test.ts:730 | chrome stays in the markup so the stylesheet can overlay it | `class="block-head"` |
| editor_compile_test.ts:734 | chrome stays in the markup so the stylesheet can overlay it | `data-action="insert-block-below"` |
| editor_compile_test.ts:735 | chrome stays in the markup so the stylesheet can overlay it | `class="block-more"` |
| editor_compile_test.ts:737 | chrome stays in the markup so the stylesheet can overlay it | `class="markdown-rich-editor markdown-editor-heading markdown-heading-level-2"` |

### A · import_export_test.ts（12 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| import_export_test.ts:172 | Markdown/TXT import is preview-first and content stays out of the cour | `正文` [fixture] |
| import_export_test.ts:224 | asset import shows checksum duplicates and never executes scripts | `不会执行` |
| import_export_test.ts:474 | Markdown and clean semantic HTML exports are deterministic | `![课程封面](assets/cover.png)` [fixture] |
| import_export_test.ts:479 | Markdown and clean semantic HTML exports are deterministic | `<article>`<br>`data-` |
| import_export_test.ts:483 | Markdown and clean semantic HTML exports are deterministic | `<script>` |
| import_export_test.ts:562 | paged HTML preflight freezes ordered pages and requires every warning  | `页面内正文`<br>`尚未放置的正文` |
| import_export_test.ts:745 | full project export excludes private conversation data and PDF is read | `私聊`<br>`私密内容` |
| import_export_test.ts:1000 | multi-page image export emits stable files per LayoutSection | `开场` [fixture] |
| import_export_test.ts:1116 | publish projection keeps scope/order/layout and omits workflow placeho | `<strong>粗体</strong>`<br>`<code>字面</code>` |
| import_export_test.ts:1117 | publish projection keeps scope/order/layout and omits workflow placeho | `class="publication-inline-image" src="assets/%E4%B8%AD%E6%96%87%20%E5%B0%81%E9%9D%A2.png"` |
| import_export_test.ts:1118 | publish projection keeps scope/order/layout and omits workflow placeho | `<script>x</script>` |
| import_export_test.ts:1183 | static web package is portable and copies only referenced assets | `可搬走的网页正文` [fixture] |

### A · import_preview_lifecycle_test.ts（3 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| import_preview_lifecycle_test.ts:58 | pending import previews are capped and can be released | `上限` [fixture] |
| import_preview_lifecycle_test.ts:59 | pending import previews are capped and can be released | `稍后重试` [fixture] |
| import_preview_lifecycle_test.ts:162 | confirm rejects a source changed under the same size, mtime and identi | `摘要已变化` [fixture] |

### A · io_failure_recovery_test.ts（2 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| io_failure_recovery_test.ts:650 | lost rename acknowledgement is verified as committed and cleanup failu | `未确认` [fixture] |
| io_failure_recovery_test.ts:651 | lost rename acknowledgement is verified as committed and cleanup failu | `清理失败` [fixture] |

### A · mapping_ui_runtime_test.ts（6 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| mapping_ui_runtime_test.ts:31 | (top-level) | `data-mapping-select` |
| mapping_ui_runtime_test.ts:52 | (top-level) | `data-mapping-select` |
| mapping_ui_runtime_test.ts:53 | (top-level) | `data-mapping-role` |
| mapping_ui_runtime_test.ts:54 | (top-level) | `data-mapping-destination` |
| mapping_ui_runtime_test.ts:55 | (top-level) | `data-mapping-duplicate` |
| mapping_ui_runtime_test.ts:104 | (top-level) | `data-selected="true"` |

### A · markdown_test.ts（14 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| markdown_test.ts:50 | markdown parsing keeps GFM semantics, safe HTML and image references | `- [x] 完成` [fixture] |
| markdown_test.ts:57 | markdown parsing keeps GFM semantics, safe HTML and image references | `<strong>粗体</strong>` |
| markdown_test.ts:58 | markdown parsing keeps GFM semantics, safe HTML and image references | `<table>` |
| markdown_test.ts:59 | markdown parsing keeps GFM semantics, safe HTML and image references | `<code>**代码字面量**</code>` |
| markdown_test.ts:61 | markdown parsing keeps GFM semantics, safe HTML and image references | `<script>` |
| markdown_test.ts:62 | markdown parsing keeps GFM semantics, safe HTML and image references | `<img src=` |
| markdown_test.ts:63 | markdown parsing keeps GFM semantics, safe HTML and image references | `<img src=` |
| markdown_test.ts:79 | publication semantic Markdown keeps inline meaning and only resolved i | `<script>` |
| markdown_test.ts:88 | rich editor round-trip writes Markdown while keeping inline formatting | `<strong>你好</strong>` |
| markdown_test.ts:89 | rich editor round-trip writes Markdown while keeping inline formatting | `<strong>标题</strong>` |
| markdown_test.ts:111 | a block typed into an empty editor stays one paragraph with its format | `<strong>重点</strong>` |
| markdown_test.ts:145 | edited lists, tables and local image refs round-trip as one Markdown s | `**粗体** ![封面](images/cover.png \` [fixture] |
| markdown_test.ts:146 | edited lists, tables and local image refs round-trip as one Markdown s | `- [x] 完成` [fixture] |
| markdown_test.ts:147 | edited lists, tables and local image refs round-trip as one Markdown s | `  - 子项` [fixture] |

### A · media_preview_stability_test.ts（15 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| media_preview_stability_test.ts:81 | (top-level) | `预览失败` |
| media_preview_stability_test.ts:82 | (top-level) | `缩略图已释放` |
| media_preview_stability_test.ts:84 | (top-level) | `正在读取` |
| media_preview_stability_test.ts:85 | (top-level) | `等待加载` |
| media_preview_stability_test.ts:86 | (top-level) | `预览未加载` |
| media_preview_stability_test.ts:124 | (top-level) | `data-action` |
| media_preview_stability_test.ts:138 | (top-level) | `data-` |
| media_preview_stability_test.ts:1507 | every preview state paints the same frame box, with no per-state geome | `data-asset-preview-key="${esc(key)}"` |
| media_preview_stability_test.ts:1508 | every preview state paints the same frame box, with no per-state geome | `data-asset-preview-surface=` |
| media_preview_stability_test.ts:1671 | every preview state paints the same frame box, with no per-state geome | `data-action` |
| media_preview_stability_test.ts:1708 | every preview state paints the same frame box, with no per-state geome | `data-action` |
| media_preview_stability_test.ts:1909 | the 重试预览 button the real patch paints is bound by the real binder and  | `重试预览` |
| media_preview_stability_test.ts:2130 | batched media errors settle visibly and typed images never decode as t | `预览失败` |
| media_preview_stability_test.ts:2132 | batched media errors settle visibly and typed images never decode as t | `等待加载`<br>`正在读取` |
| media_preview_stability_test.ts:2137 | batched media errors settle visibly and typed images never decode as t | `图片文件格式不匹配` |

### A · native_boot_test.ts（11 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| native_boot_test.ts:515 | (top-level) | `data-action="recovery-restore"` |
| native_boot_test.ts:905 | (top-level) | `持久化确认` |
| native_boot_test.ts:1206 | (top-level) | `导出目录` |
| native_boot_test.ts:1209 | (top-level) | `导出目录` |
| native_boot_test.ts:1346 | (top-level) | `class="recent-card"` |
| native_boot_test.ts:1351 | (top-level) | `data-action="enter-project"` |
| native_boot_test.ts:1355 | (top-level) | `data-action="open-item"` |
| native_boot_test.ts:1505 | (top-level) | `正在其他窗口或进程中使用` |
| native_boot_test.ts:1698 | (top-level) | `<img src="${resolvedImage.url}"` |
| native_boot_test.ts:1699 | (top-level) | `找不到本地图片` |
| native_boot_test.ts:1701 | (top-level) | `超出来源目录` |

### A · native_boundary_test.ts（14 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| native_boundary_test.ts:100 | native shell exposes explicit project and high-level workflows | `fn export_run(preset: Value, options: Option<Value>)` |
| native_boundary_test.ts:101 | native shell exposes explicit project and high-level workflows | `fn export_preflight(preset: Value, options: Option<Value>)` |
| native_boundary_test.ts:138 | native shell exposes explicit project and high-level workflows | `async fn select_export_path(app: AppHandle, input: Option<Value>)` |
| native_boundary_test.ts:139 | native shell exposes explicit project and high-level workflows | `async fn select_file(app: AppHandle, input: Option<Value>)` |
| native_boundary_test.ts:140 | native shell exposes explicit project and high-level workflows | `async fn select_folder(app: AppHandle, input: Option<Value>)` |
| native_boundary_test.ts:159 | native shell exposes explicit project and high-level workflows | `历史 API Key 未能安全迁移` |
| native_boundary_test.ts:209 | native shell exposes explicit project and high-level workflows | `expected_fingerprint: Option<FileFingerprint>` |
| native_boundary_test.ts:301 | native shell exposes explicit project and high-level workflows | `fn project_save(project_dir: Option<String>` |
| native_boundary_test.ts:302 | native shell exposes explicit project and high-level workflows | `fn read_project(project_dir: Option<String>` |
| native_boundary_test.ts:323 | native shell exposes explicit project and high-level workflows | `data-project-dir` |
| native_boundary_test.ts:344 | native shell exposes explicit project and high-level workflows | `插入素材：` |
| native_boundary_test.ts:358 | native shell exposes explicit project and high-level workflows | `文件导入没有完成` |
| native_boundary_test.ts:411 | native boundary has no fs or shell Tauri capability | `白名单动作` [fixture] |
| native_boundary_test.ts:520 | folder.adopt native IPC sends the confirmed plan and direct-child sele | `/^document_paths:\s*Option<Vec<String>>$/` |

### A · p2_interaction_test.ts（9 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| p2_interaction_test.ts:386 | T03 rendered blockCard puts handle, type and primary actions in a head | `class="block-head"` |
| p2_interaction_test.ts:387 | T03 rendered blockCard puts handle, type and primary actions in a head | `>标题<` |
| p2_interaction_test.ts:392 | T03 rendered blockCard puts handle, type and primary actions in a head | `data-action="insert-block-below"` |
| p2_interaction_test.ts:396 | T03 rendered blockCard puts handle, type and primary actions in a head | `class="block-more"` |
| p2_interaction_test.ts:401 | T03 rendered blockCard puts handle, type and primary actions in a head | `data-action="select-block"` |
| p2_interaction_test.ts:402 | T03 rendered blockCard puts handle, type and primary actions in a head | `data-action="move-block"` |
| p2_interaction_test.ts:403 | T03 rendered blockCard puts handle, type and primary actions in a head | `data-action="delete-block"` |
| p2_interaction_test.ts:407 | T03 rendered blockCard puts handle, type and primary actions in a head | `class="block-more"` |
| p2_interaction_test.ts:561 | T03 selected block keeps a left accent; handle uses pointer reorder no | `data-block-id="${blockId}"` |

### A · paged_section_export_review_test.ts（3 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| paged_section_export_review_test.ts:252 | legacy continuous Grid content stays intact while free-layout redirect | `data-grid-surface` |
| paged_section_export_review_test.ts:253 | legacy continuous Grid content stays intact while free-layout redirect | `data-action=\` |
| paged_section_export_review_test.ts:346 | DesktopService exports the selected paged HTML projection end to end | `data-page-id="${secondPage.id}"` |

### A · presentation_workflow_test.ts（1 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| presentation_workflow_test.ts:250 | presentation style extraction, machine rules, slide preview and export | `不是 PowerPoint` |

### A · project_registry_test.ts（1 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| project_registry_test.ts:177 | relocating refuses a folder whose id does not match | `不一致` [fixture] |

### A · registry_launcher_test.ts（29 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| registry_launcher_test.ts:249 | the start page lists every project this install has opened | `最近打开` |
| registry_launcher_test.ts:250 | the start page lists every project this install has opened | `课程 proj-b` [fixture] |
| registry_launcher_test.ts:251 | the start page lists every project this install has opened | `课程 proj-a` [fixture] |
| registry_launcher_test.ts:252 | the start page lists every project this install has opened | `刚刚打开` |
| registry_launcher_test.ts:253 | the start page lists every project this install has opened | `35 分钟前打开` |
| registry_launcher_test.ts:254 | the start page lists every project this install has opened | `3 天前打开` |
| registry_launcher_test.ts:255 | the start page lists every project this install has opened | `1 月 2 日打开 · 2025 年` |
| registry_launcher_test.ts:259 | the start page lists every project this install has opened | `data-action="open-registry-project"` |
| registry_launcher_test.ts:265 | the start page lists every project this install has opened | `不会删除或改写磁盘上的课程文件` |
| registry_launcher_test.ts:280 | a row whose folder is gone offers 重新定位, never an 打开 | `找不到文件夹` |
| registry_launcher_test.ts:281 | a row whose folder is gone offers 重新定位, never an 打开 | `data-action="relocate-registry-project"` |
| registry_launcher_test.ts:282 | a row whose folder is gone offers 重新定位, never an 打开 | `data-project-path="/tmp/proj-gone"` |
| registry_launcher_test.ts:283 | a row whose folder is gone offers 重新定位, never an 打开 | `data-action="relocate-registry-project"`<br>`data-action="relocate-registry-project"` |
| registry_launcher_test.ts:284 | a row whose folder is gone offers 重新定位, never an 打开 | `data-action="open-registry-project"` |
| registry_launcher_test.ts:285 | a row whose folder is gone offers 重新定位, never an 打开 | `data-action="open-registry-project"` |
| registry_launcher_test.ts:318 | the project that is open now is marked, not duplicated by guesswork | `当前` |
| registry_launcher_test.ts:319 | the project that is open now is marked, not duplicated by guesswork | `继续工作` |
| registry_launcher_test.ts:329 | an empty registry leaves the start page usable instead of blank | `还没有最近项目` |
| registry_launcher_test.ts:330 | an empty registry leaves the start page usable instead of blank | `data-action="new-project"` |
| registry_launcher_test.ts:331 | an empty registry leaves the start page usable instead of blank | `data-action="open-project-dir"` |
| registry_launcher_test.ts:332 | an empty registry leaves the start page usable instead of blank | `data-action="open-registry-project"` |
| registry_launcher_test.ts:345 | a stored title is escaped where it is rendered | `<script>alert(1)</script>` |
| registry_launcher_test.ts:427 | the same id at two live folders asks the user instead of choosing | `检测到同一个 Workbench 项目的两个副本` |
| registry_launcher_test.ts:428 | the same id at two live folders asks the user instead of choosing | `data-action="registry-copy-update-location"` |
| registry_launcher_test.ts:429 | the same id at two live folders asks the user instead of choosing | `data-action="registry-copy-keep-both"` |
| registry_launcher_test.ts:430 | the same id at two live folders asks the user instead of choosing | `data-action="registry-copy-dismiss"` |
| registry_launcher_test.ts:501 | removing a row is confirmed, then sends only the row | `不会被删除或修改` |
| registry_launcher_test.ts:517 | removing a row is confirmed, then sends only the row | `没有被改动` |
| registry_launcher_test.ts:552 | a cancelled relocation leaves the row alone and says so | `仍留在列表里` |

### A · smart_open_adoption_backup_test.ts（2 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| smart_open_adoption_backup_test.ts:124 | the confirmation never replaces a usable project | `可用` [fixture] |
| smart_open_adoption_backup_test.ts:141 | a newer schema is refused as too new, not treated as broken | `更高版本` [fixture] |

### A · smart_open_routing_test.ts（26 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| smart_open_routing_test.ts:301 | a folder without project.json is routed into the import scan | `还不是 AI Course Workbench 项目` |
| smart_open_routing_test.ts:319 | an unusable project.json shows its real first failure, not a missing f | `检测到 project.json` |
| smart_open_routing_test.ts:320 | an unusable project.json shows its real first failure, not a missing f | `正文文档不存在` |
| smart_open_routing_test.ts:321 | an unusable project.json shows its real first failure, not a missing f | `没有找到有效的 project.json` |
| smart_open_routing_test.ts:334 | the diagnosis overlay offers 查看具体问题, 返回 and a confirmed re-import | `检测到 project.json，但项目数据无法通过校验。` |
| smart_open_routing_test.ts:335 | the diagnosis overlay offers 查看具体问题, 返回 and a confirmed re-import | `正文文档不存在` |
| smart_open_routing_test.ts:336 | the diagnosis overlay offers 查看具体问题, 返回 and a confirmed re-import | `查看具体问题` |
| smart_open_routing_test.ts:340 | the diagnosis overlay offers 查看具体问题, 返回 and a confirmed re-import | `data-action="dismiss-project-problem"` |
| smart_open_routing_test.ts:341 | the diagnosis overlay offers 查看具体问题, 返回 and a confirmed re-import | `data-action="reimport-project-folder"` |
| smart_open_routing_test.ts:342 | the diagnosis overlay offers 查看具体问题, 返回 and a confirmed re-import | `不会覆盖原来的 project.json` |
| smart_open_routing_test.ts:343 | the diagnosis overlay offers 查看具体问题, 返回 and a confirmed re-import | `没有找到有效的 project.json` |
| smart_open_routing_test.ts:344 | the diagnosis overlay offers 查看具体问题, 返回 and a confirmed re-import | `data-action="confirm-reimport-project-folder"` |
| smart_open_routing_test.ts:359 | re-importing asks for confirmation before the existing file is touched | `完整保留为一个带时间戳的备份文件` |
| smart_open_routing_test.ts:360 | re-importing asks for confirmation before the existing file is touched | `不会删除` |
| smart_open_routing_test.ts:361 | re-importing asks for confirmation before the existing file is touched | `data-action="confirm-reimport-project-folder"` |
| smart_open_routing_test.ts:420 | 返回 leaves the folder exactly as it was | `没有被修改` |
| smart_open_routing_test.ts:437 | corrupted JSON is reported as corrupted, never as missing | `解析` [fixture] |
| smart_open_routing_test.ts:438 | corrupted JSON is reported as corrupted, never as missing | `没有找到有效的 project.json` |
| smart_open_routing_test.ts:439 | corrupted JSON is reported as corrupted, never as missing | `还没有 project.json` |
| smart_open_routing_test.ts:458 | every diagnosis gets its own copy with no generic fallback | `没有找到有效的 project.json` |
| smart_open_routing_test.ts:470 | a project from a newer version is never offered for re-import | `这个项目由更高版本的 Workbench 创建。` |
| smart_open_routing_test.ts:471 | a project from a newer version is never offered for re-import | `当前版本支持到 0.2.3` |
| smart_open_routing_test.ts:472 | a project from a newer version is never offered for re-import | `data-action="reimport-project-folder"` |
| smart_open_routing_test.ts:473 | a project from a newer version is never offered for re-import | `data-action="dismiss-project-problem"` |
| smart_open_routing_test.ts:487 | with no diagnosis the copy stays honest about what is unknown | `没有找到有效的 project.json` |
| smart_open_routing_test.ts:488 | with no diagnosis the copy stays honest about what is unknown | `你可以：` |

### A · snapshot_persistence_test.ts（3 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| snapshot_persistence_test.ts:217 | snapshot create and restore report snapshot-directory sync warnings | `目录元数据同步失败` |
| snapshot_persistence_test.ts:246 | snapshot create and restore report snapshot-directory sync warnings | `目录元数据同步失败` |
| snapshot_persistence_test.ts:276 | snapshot create and restore report snapshot-directory sync warnings | `目录元数据同步失败` |

### A · t04_adoption_test.ts（17 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| t04_adoption_test.ts:166 | Deno adopt refuses when project.json already exists (matches native) | `/已有 project\.json\|不能重复\|打开现有项目/` |
| t04_adoption_test.ts:395 | same checksum reuses existing Asset; same name different bytes does no | `/复用\|已存在\|checksum/` |
| t04_adoption_test.ts:459 | markdown lesson becomes Canonical blocks; docx/pdf stay Source/Referen | `导论` [fixture] |
| t04_adoption_test.ts:896 | UI confirmation performs one adopt action and keeps row controls disti | `确认并追加到当前课程`<br>`确认导入计划并打开` |
| t04_adoption_test.ts:900 | UI confirmation performs one adopt action and keeps row controls disti | `data-mapping-row`<br>`data-mapping-select` |
| t04_adoption_test.ts:937 | UI confirmation performs one adopt action and keeps row controls disti | `/接管\|写入\|已导入\|课程项目/` |
| t04_adoption_test.ts:970 | failed import keeps the editable plan, shows a persistent safe reason, | `检查项目目录权限` |
| t04_adoption_test.ts:980 | failed import keeps the editable plan, shows a persistent safe reason, | `确认导入计划并打开` |
| t04_adoption_test.ts:984 | failed import keeps the editable plan, shows a persistent safe reason, | `data-action="confirm-import-mapping"` |
| t04_adoption_test.ts:988 | failed import keeps the editable plan, shows a persistent safe reason, | `data-action=\` |
| t04_adoption_test.ts:1209 | append targets a lesson, preserves its edits/pages, and skips Markdown | `默认跳过` |
| t04_adoption_test.ts:1254 | append targets a lesson, preserves its edits/pages, and skips Markdown | `目标课时已删除` |
| t04_adoption_test.ts:1270 | append targets a lesson, preserves its edits/pages, and skips Markdown | `按当前目标新建或追加` |
| t04_adoption_test.ts:1286 | append targets a lesson, preserves its edits/pages, and skips Markdown | `曾删除课时`<br>`按当前目标新建或追加` |
| t04_adoption_test.ts:1297 | append targets a lesson, preserves its edits/pages, and skips Markdown | `来源路径已有较旧导入` |
| t04_adoption_test.ts:1307 | append targets a lesson, preserves its edits/pages, and skips Markdown | `用户已明确选择导入来源的新版本` |
| t04_adoption_test.ts:1322 | append targets a lesson, preserves its edits/pages, and skips Markdown | `来源路径已有较旧导入` |

### A · t04_explorer_test.ts（20 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| t04_explorer_test.ts:262 | canonical top navigation keeps 工作台 and adds 文件 beside project routes | `资料库` |
| t04_explorer_test.ts:263 | canonical top navigation keeps 工作台 and adds 文件 beside project routes | `["overview", "概览"]` |
| t04_explorer_test.ts:264 | canonical top navigation keeps 工作台 and adds 文件 beside project routes | `["editor", "工作台"]` |
| t04_explorer_test.ts:265 | canonical top navigation keeps 工作台 and adds 文件 beside project routes | `["explorer", "文件"]` |
| t04_explorer_test.ts:266 | canonical top navigation keeps 工作台 and adds 文件 beside project routes | `["inbox", "收件箱"]` |
| t04_explorer_test.ts:268 | canonical top navigation keeps 工作台 and adds 文件 beside project routes | `data-route="${navRoute}"` |
| t04_explorer_test.ts:364 | explorer view renders tree filter and non-blank preview kinds | `资源浏览器`<br>`文件` [fixture] |
| t04_explorer_test.ts:365 | explorer view renders tree filter and non-blank preview kinds | `01-基础` [fixture] |
| t04_explorer_test.ts:366 | explorer view renders tree filter and non-blank preview kinds | `导论.md` [fixture] |
| t04_explorer_test.ts:368 | explorer view renders tree filter and non-blank preview kinds | `data-explorer-filter`<br>`文件名` |
| t04_explorer_test.ts:371 | explorer view renders tree filter and non-blank preview kinds | `导论预览` [fixture]<br>`正文` [fixture] |
| t04_explorer_test.ts:372 | explorer view renders tree filter and non-blank preview kinds | `白板` |
| t04_explorer_test.ts:385 | explorer view renders tree filter and non-blank preview kinds | `<img`<br>`图片` [fixture] |
| t04_explorer_test.ts:400 | explorer view renders tree filter and non-blank preview kinds | `<video`<br>`媒体` [fixture]<br>`视频` [fixture] |
| t04_explorer_test.ts:414 | explorer view renders tree filter and non-blank preview kinds | `<iframe`<br>`PDF 第一页` |
| t04_explorer_test.ts:416 | explorer view renders tree filter and non-blank preview kinds | `总体说明.pdf` [fixture] |
| t04_explorer_test.ts:424 | explorer view renders tree filter and non-blank preview kinds | `<iframe` |
| t04_explorer_test.ts:441 | explorer filter and expand stay in UI workspace state, not Canonical | `02-进阶/nested-only-ui` [fixture] |
| t04_explorer_test.ts:557 | explorer expand filter recent restore from session without Canonical w | `02-进阶/nested-only-ui` [fixture] |
| t04_explorer_test.ts:578 | explorer expand filter recent restore from session without Canonical w | `02-进阶/nested-only-ui` [fixture] |

### A · t04_mapping_test.ts（9 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| t04_mapping_test.ts:145 | Stage mapping suggests 01-基础 and 02-进阶 as Stage candidates (§30) | `建议` |
| t04_mapping_test.ts:387 | mapping preview UI labels 建议; deselect and edit; confirm is separate a | `映射`<br>`建议` |
| t04_mapping_test.ts:390 | mapping preview UI labels 建议; deselect and edit; confirm is separate a | `01-基础` [fixture] |
| t04_mapping_test.ts:391 | mapping preview UI labels 建议; deselect and edit; confirm is separate a | `02-进阶` [fixture] |
| t04_mapping_test.ts:393 | mapping preview UI labels 建议; deselect and edit; confirm is separate a | `data-action=\` |
| t04_mapping_test.ts:394 | mapping preview UI labels 建议; deselect and edit; confirm is separate a | `确认导入计划` |
| t04_mapping_test.ts:398 | mapping preview UI labels 建议; deselect and edit; confirm is separate a | `/data-action=\"open-import-mapping\"[^>]*>[\s\S]{0,80}confirm-import-mapping/` |
| t04_mapping_test.ts:418 | mapping preview UI labels 建议; deselect and edit; confirm is separate a | `建议` |
| t04_mapping_test.ts:436 | mapping preview UI labels 建议; deselect and edit; confirm is separate a | `/尚未写入\|未写入\|后续\|Task 12\|正式接管\|确认导入计划/` |

### A · t04_scan_test.ts（7 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| t04_scan_test.ts:53 | launcher exposes three distinct project-entry actions including 导入已有文件 | `新建课程` |
| t04_scan_test.ts:55 | launcher exposes three distinct project-entry actions including 导入已有文件 | `/打开项目文件夹\|打开现有项目/` |
| t04_scan_test.ts:59 | launcher exposes three distinct project-entry actions including 导入已有文件 | `导入已有文件夹` |
| t04_scan_test.ts:60 | launcher exposes three distinct project-entry actions including 导入已有文件 | `data-action="import-folder"` |
| t04_scan_test.ts:64 | launcher exposes three distinct project-entry actions including 导入已有文件 | `data-action="new-project"` |
| t04_scan_test.ts:66 | launcher exposes three distinct project-entry actions including 导入已有文件 | `data-action="import-folder"` |
| t04_scan_test.ts:117 | readFolderPreview rejects intermediate symlinks and still reads an in- | `符号链接` |

### A · ui_test.ts（1 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| ui_test.ts:91 | Desktop shell restores persisted state and supports palette keyboard a | `AI 连接器尚未配置` |

### A · video_frame_test.ts（1 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| video_frame_test.ts:275 | video poster waits for the compositor frame without autoplay | `超时` [fixture] |

### A · workbench_ui_test.ts（35 条）

| file:line | 测试名 | 断言原文（needle / 正则） |
|---|---|---|
| workbench_ui_test.ts:66 | Workbench shell keeps one collapse control per local sidebar | `data-action="return-launcher"` |
| workbench_ui_test.ts:67 | Workbench shell keeps one collapse control per local sidebar | `class="secondary launcher-return"` |
| workbench_ui_test.ts:68 | Workbench shell keeps one collapse control per local sidebar | `返回启动页；当前项目保持打开` |
| workbench_ui_test.ts:69 | Workbench shell keeps one collapse control per local sidebar | `data-action="toggle-left"` |
| workbench_ui_test.ts:70 | Workbench shell keeps one collapse control per local sidebar | `data-action="toggle-right"` |
| workbench_ui_test.ts:72 | Workbench shell keeps one collapse control per local sidebar | `class="recent-card"`<br>`data-action="enter-project"` |
| workbench_ui_test.ts:74 | Workbench shell keeps one collapse control per local sidebar | `data-action="open-item"` |
| workbench_ui_test.ts:78 | Workbench shell keeps one collapse control per local sidebar | `class="seed-choices"` |
| workbench_ui_test.ts:79 | Workbench shell keeps one collapse control per local sidebar | `课程地图` |
| workbench_ui_test.ts:83 | Workbench shell keeps one collapse control per local sidebar | `data-action="pick-seed" data-type="${type}"` |
| workbench_ui_test.ts:95 | Workbench shell keeps one collapse control per local sidebar | `data-action="build-blueprint"` |
| workbench_ui_test.ts:99 | Workbench shell keeps one collapse control per local sidebar | `class="panel-heading"` |
| workbench_ui_test.ts:100 | Workbench shell keeps one collapse control per local sidebar | `data-action="toggle-left"` |
| workbench_ui_test.ts:101 | Workbench shell keeps one collapse control per local sidebar | `class="right-tabs"` |
| workbench_ui_test.ts:102 | Workbench shell keeps one collapse control per local sidebar | `data-action="toggle-right"` |
| workbench_ui_test.ts:138 | top navigation exposes the six project destinations without a duplicat | `data-action="open-workbench"` |
| workbench_ui_test.ts:143 | top navigation exposes the six project destinations without a duplicat | `class="project-picker"` |
| workbench_ui_test.ts:144 | top navigation exposes the six project destinations without a duplicat | `data-action="return-launcher"` |
| workbench_ui_test.ts:145 | top navigation exposes the six project destinations without a duplicat | `data-action="open-registry-project"` |
| workbench_ui_test.ts:149 | top navigation exposes the six project destinations without a duplicat | `data-action="route" data-route=` |
| workbench_ui_test.ts:150 | top navigation exposes the six project destinations without a duplicat | `data-action="open-workbench"` |
| workbench_ui_test.ts:154 | top navigation exposes the six project destinations without a duplicat | `资料库`<br>`全部`<br>`案例` |
| workbench_ui_test.ts:155 | top navigation exposes the six project destinations without a duplicat | `视频` [fixture]<br>`图片` [fixture]<br>`文档` |
| workbench_ui_test.ts:156 | top navigation exposes the six project destinations without a duplicat | `幻灯片` |
| workbench_ui_test.ts:189 | shared controls align core workbench surfaces without losing compact e | `class="statusbar"`<br>`class="toast"` |
| workbench_ui_test.ts:287 | user-facing copy explains safety, continuation, and next actions | `保存已暂停`<br>`磁盘版本没有改变` |
| workbench_ui_test.ts:288 | user-facing copy explains safety, continuation, and next actions | `请选择重新载入、自动合并，或在确认后保留本地版本` |
| workbench_ui_test.ts:290 | user-facing copy explains safety, continuation, and next actions | `显示技术信息`<br>`必须修复`<br>`确认提示并导出` |
| workbench_ui_test.ts:291 | user-facing copy explains safety, continuation, and next actions | `preview.error \|\| "素材不可读"`<br>`重试预览`<br>`没有找到匹配的素材。换一个文件名继续搜索` |
| workbench_ui_test.ts:292 | user-facing copy explains safety, continuation, and next actions | `课程内容没有改动，你可以检查设置后重试` |
| workbench_ui_test.ts:293 | user-facing copy explains safety, continuation, and next actions | `当前操作没有写入` |
| workbench_ui_test.ts:294 | user-facing copy explains safety, continuation, and next actions | `发现未完成的保存；磁盘版本没有改变`<br>`暂存内容` |
| workbench_ui_test.ts:295 | user-facing copy explains safety, continuation, and next actions | `显示技术信息`<br>`项目文件没有被改动` |
| workbench_ui_test.ts:297 | user-facing copy explains safety, continuation, and next actions | `这个项目正在其他窗口或进程中使用`<br>`课程文件在其他地方发生了变化` |
| workbench_ui_test.ts:298 | user-facing copy explains safety, continuation, and next actions | `这项操作没有完成。工作台仍可继续使用，请重试。` |

---

## 附录 B · 纯视觉 class 安全区全量清单（556 个，测试零引用）

> 出现在 app/*.js 的 class="…" 模板中，tests/ 全文无任何字符串引用。重命名/合并/删除不直接挂测试（注意 §1.2 CSS 正则与 §2 views 源码文本锁的间接约束）。

`action-row`, `add-block-line`, `ai-add-card-body`, `ai-add-panel`, `ai-advanced`, `ai-answer`, `ai-badge`, `ai-badge-custom`

`ai-block`, `ai-block-head`, `ai-collapse-toggle`, `ai-connection-actions`, `ai-connection-test`, `ai-context`, `ai-context-list`, `ai-context-total`

`ai-current-model`, `ai-current-use`, `ai-diff`, `ai-diff-actions`, `ai-diff-empty`, `ai-diff-lines`, `ai-diff-reason`, `ai-diff-row`

`ai-diff-side`, `ai-diff-sides`, `ai-editor-actions`, `ai-editor-divider`, `ai-editor-status`, `ai-empty-state`, `ai-error`, `ai-excluded`

`ai-execution`, `ai-execution-head`, `ai-execution-list`, `ai-executions`, `ai-hint`, `ai-include-row`, `ai-instruction`, `ai-key-dot`

`ai-key-label`, `ai-key-state`, `ai-model-caps`, `ai-model-empty`, `ai-model-head`, `ai-model-head-actions`, `ai-model-input-type`, `ai-model-move`

`ai-model-picker`, `ai-model-row-body`, `ai-model-row-head`, `ai-model-section`, `ai-picker-list`, `ai-picker-overlay`, `ai-picker-row`, `ai-protocol-select`

`ai-provider-actions`, `ai-provider-editor`, `ai-provider-id`, `ai-provider-identity`, `ai-provider-name`, `ai-provider-row-head`, `ai-provider-state`, `ai-reasoning-cols`

`ai-reasoning-head`, `ai-reasoning-help`, `ai-reasoning-row`, `ai-reasoning-rows`, `ai-run-row`, `ai-save-button`, `ai-save-status`, `ai-scope`

`ai-scope-row`, `ai-secret-eye`, `ai-secret-row`, `ai-segmented`, `ai-settings-foot`, `ai-settings-overlay`, `ai-subscription-list`, `ai-subscription-row`

`ai-subscription-settings`, `ai-subscription-status`, `ai-tier-select`, `asset-attachment-icon`, `asset-audio`, `asset-card-actions`, `asset-card-body`, `asset-card-menu`

`asset-card-menu-list`, `asset-card-meta`, `asset-card-name`, `asset-grid`, `asset-image-zoom`, `asset-insert-action`, `asset-media-preview-modal`, `asset-preview-error`

`asset-preview-video`, `asset-rename-input`, `asset-rename-modal`, `asset-row`, `asset-thumb`, `asset-type-label`, `asset-usage-label`, `asset-video-play`

`asset-video-stage`, `backlog-actions`, `backlog-empty`, `backlog-group`, `backlog-head`, `backlog-list`, `backlog-location`, `backlog-note`

`backlog-page`, `backlog-row`, `backlog-row-title`, `backlog-rows`, `backlog-summary`, `badge`, `block-code`, `block-divider`

`block-hint`, `block-list`, `block-more-item`, `blueprint-confirm`, `blueprint-nodes`, `board-card-code`, `board-card-list`, `board-card-meta`

`board-column`, `board-column-empty`, `board-column-head`, `board-columns`, `board-dimension`, `board-empty`, `board-page`, `board-summary`

`brand-mark`, `brand-title`, `breadcrumbs`, `canvas-first-page`, `canvas-page-intro`, `card-head`, `check-list`, `checkbox-inline`

`checkbox-row`, `collapse-left`, `collapse-right`, `compatibility-note`, `conflict-error`, `conflict-list`, `conflict-modal`, `conflict-summary`

`continue-code`, `continue-row`, `course-map-page`, `course-tree-code`, `course-tree-empty`, `course-tree-lesson`, `course-tree-open`, `course-tree-requirements`

`course-tree-scroll`, `course-tree-scroll-hint`, `course-tree-search`, `course-tree-status`, `course-tree-status-field`, `course-tree-table`, `course-tree-toolbar`, `course-tree-tools`

`delete-confirm-impact`, `delete-confirm-modal`, `document-import-count`, `document-import-directory`, `document-import-empty`, `document-import-feedback`, `document-import-foot`, `document-import-groups`

`document-import-mapping`, `document-import-meta`, `document-import-name`, `document-import-outcome`, `document-import-result`, `document-import-result-head`, `document-import-state`, `document-import-tally`

`document-import-tools`, `done-group`, `drop-icon`, `drop-zone`, `editor-body`, `editor-page`, `empty-icon`, `error-text`

`explorer-audio`, `explorer-columns`, `explorer-empty-state`, `explorer-entry`, `explorer-image`, `explorer-item-icon`, `explorer-layout`, `explorer-list-head`

`explorer-md`, `explorer-media-card`, `explorer-meta`, `explorer-name`, `explorer-page`, `explorer-page-head`, `explorer-pdf`, `explorer-preview-body`

`explorer-preview-empty`, `explorer-preview-head`, `explorer-preview-pane`, `explorer-reference-card`, `explorer-row`, `explorer-search`, `explorer-size`, `explorer-source-summary`

`explorer-status`, `explorer-text`, `explorer-toggle`, `explorer-tree`, `explorer-tree-pane`, `explorer-type`, `explorer-video`, `eyebrow`

`fit-target-page`, `flow-copy`, `flow-count`, `flow-drop-end`, `flow-empty`, `flow-flags`, `flow-footnote`, `flow-jump`

`flow-kind`, `flow-list`, `flow-move`, `flow-open-hint`, `flow-order`, `flow-toolbar`, `flow-view`, `form-error`

`format-capability`, `format-card`, `format-grid`, `free-layout-empty`, `free-layout-page`, `free-layout-transition`, `gap-counter`, `gap-summary`

`grid-moving-banner`, `image-preview-modal`, `inbox-actions`, `inbox-card`, `inbox-context-note`, `inbox-empty`, `inbox-list`, `inbox-main`

`inbox-page`, `inbox-row-meta`, `inbox-section`, `inbox-section-empty`, `inbox-section-head`, `inbox-summary`, `inbox-type`, `inline-title-button`

`is-done`, `is-empty`, `is-error`, `is-warning`, `issue-list`, `kanban`, `kanban-column`, `kanban-head`

`launcher-choice`, `launcher-choice-grid`, `launcher-choice-index`, `launcher-copy`, `launcher-footnote`, `launcher-intro`, `launcher-orb`, `launcher-resume`

`launcher-section-head`, `launcher-start`, `layout-meta`, `layout-mode-pill`, `layout-note`, `layout-toolbar`, `left-media-info`, `left-media-insert`

`left-media-item`, `left-media-list`, `left-media-preview`, `lesson-drag-handle`, `lesson-drop-end`, `lesson-nav`, `lesson-next`, `lesson-pill`

`lesson-state`, `lesson-switch`, `lesson-title-inline`, `library-badge`, `library-copy-paths`, `library-empty`, `library-head`, `library-list`

`library-path`, `library-row-actions`, `library-row-main`, `library-row-title`, `library-time`, `library-title`, `list-row`, `map-actions`

`map-empty-page`, `map-item`, `map-page-head`, `map-page-title`, `map-project-title`, `map-project-title-input`, `mapping-empty`, `mapping-error`

`mapping-object`, `mapping-object-kind`, `mapping-object-name`, `mapping-page`, `mapping-row-error`, `mapping-select-cell`, `mapping-selection-count`, `mapping-status`

`mapping-table`, `mapping-table-wrap`, `mapping-target`, `markdown-callout`, `markdown-editor-shell`, `media-actions`, `media-document`, `media-empty`

`media-filter`, `media-filter-list`, `media-library-note`, `media-library-tools`, `media-meta`, `media-page`, `media-page-head`, `media-pdf-preview`

`media-slot`, `media-slot-icon`, `media-tile`, `mode-writing`, `nav-icon`, `nav-item`, `no-results`, `orange`

`overview-activity`, `overview-activity-empty`, `overview-activity-list`, `overview-activity-title`, `overview-grid`, `page-action-row`, `page-actions`, `page-add`

`page-canvas-size`, `page-confirm-actions`, `page-conversion-preview`, `page-head-actions`, `page-move-panel`, `page-overflow-warning`, `page-preview-content`, `page-preview-controls`

`page-preview-item`, `page-preview-tabs`, `page-preview-viewport`, `page-section`, `page-size-control`, `page-size-preview`, `page-tab`, `page-tabs`

`page-toolbar`, `page-view-controls`, `paged-page-tools`, `pagination-edit-bar`, `palette-hint`, `palette-input`, `palette-results`, `panel-footer`

`picker-card`, `picker-grid`, `picker-thumb`, `placed-elsewhere`, `placeholder-actions`, `placeholder-body`, `placeholder-icon`, `placement-actions`

`placement-cell`, `placement-label`, `placement-text`, `preflight-pending`, `preflight-total`, `presentation-ai-review`, `presentation-export-result`, `presentation-extract-controls`

`presentation-extraction-report`, `presentation-form-grid`, `presentation-insertion-control`, `presentation-preview`, `presentation-representatives`, `presentation-saved-styles`, `presentation-slide-form`, `presentation-slide-plan`

`presentation-style-card`, `presentation-workflow`, `preview-asset-list`, `preview-assets`, `preview-attachment`, `preview-canvas`, `preview-code`, `preview-document`

`preview-grid`, `preview-grid-cell`, `preview-markdown`, `preview-media-failed`, `preview-meta`, `preview-pdf`, `preview-placeholder`, `preview-section-tag`

`preview-toolbar`, `preview-unplaced`, `preview-unplaced-item`, `project-library`, `project-lock-details`, `project-lock-modal`, `project-name`, `project-picker-actions`

`project-picker-current`, `project-picker-menu`, `project-problem-detail`, `project-problem-path`, `project-title-input`, `project-title-text`, `properties-box`, `properties-requirement`

`publish-card`, `publish-context-empty`, `publish-feedback`, `publish-fit-page-card`, `publish-fit-pages`, `publish-fit-preview`, `publish-format-note`, `publish-history`

`publish-history-empty`, `publish-last-export`, `publish-layout-controls`, `publish-layout-note`, `publish-page-options`, `publish-preflight`, `publish-preflight-action`, `publish-scope-detail`

`publish-section`, `publish-section-heading`, `publish-status-strip`, `publish-step`, `purple`, `req-dot`, `resource-candidate-form`, `resource-candidate-head`

`resource-candidates`, `resource-discovery-controls`, `resource-duration`, `resource-errors`, `resource-library`, `resource-library-card`, `resource-limitations`, `resource-manual-timing`

`resource-plan`, `resource-plan-summary`, `resource-provider-card`, `resource-provider-settings`, `resource-saved-binding`, `resource-task-status`, `resource-timing-fields`, `resource-video-fallback`

`resource-video-preview`, `result-type`, `seed-card`, `seed-grid`, `seed-input`, `segmented`, `settings-account-card`, `settings-ai-card`

`settings-card`, `settings-card-actions`, `settings-cards`, `settings-index`, `settings-model-list`, `settings-nav`, `settings-page`, `settings-project-card`

`settings-save-card`, `settings-section`, `settings-section-head`, `settings-security-note`, `side-empty`, `side-item`, `side-item-body`, `side-item-tools`

`side-list`, `side-note`, `side-thumb-wrap`, `simple-icon`, `simple-page`, `spacer`, `sr-only`, `stage-code`

`stage-collapse-toggle`, `status-code`, `status-list`, `status-pill`, `status-row`, `status-spacer`, `structure-row`, `success-text`

`summary-card`, `summary-grid`, `surface-card`, `switch-track`, `tab-close`, `tab-item`, `task-dot`, `task-list`

`toast-slot`, `toolbar-hint`, `top-actions`, `topbar-nav`, `topbar-nav-item`, `track-labels`, `trash-icon`, `unplaced-block`

`unplaced-list`, `unplaced-strip`, `update-guidance`, `update-step`, `update-summary`, `update-summary-grid`, `updates-page`, `usage-box`

`version-icon`, `version-list`, `versions-empty`, `versions-section`, `versions-section-head`, `versions-summary`, `warning-ack-list`, `warning-text`

`workbench-head`, `workbench-heading`, `writing-insert-menu`, `writing-insert-summary`


---

*本清单由脚本从 tests/*.ts 静态提取（`.includes` / `assertContains` / 正则断言 / `indexOf` / `count`），基线 773 passed / 0 failed。生成后未改动任何代码。*
