# 全站 UI 整改对照证据（2026-10-24）

本目录是 v3.0.2「全站 UI 整改」的**真实渲染对照**。截图来自浏览器壳（`PROJECT_ROOT=<项目副本> PORT=4175 deno task ui`）打开同一份代码的实际渲染，不是设计稿。

## 文件

| 文件 | 内容 |
|---|---|
| `01-before-overview.png` / `02-after-overview.png` | 课程表页前后对照：页头行动组由 3+1 折行改为单行右对齐、主 CTA 首位；状态列由「徽章 + ▶ 三角文本 + 裸灰文本」三套写法统一为同一 chip 家族；行操作图标钮规格统一；左栏「等待加载」不再断行。 |
| `03-before-course-map.png` / `04-after-course-map.png` | 课程地图页前后对照（同上，页头行动组为该页最明显变化）。 |
| `05-before-publish.png` / `06-after-publish.png` | 发布页前后对照：步骤序号 `1. 选择输出范围` 与 `01` 徽章双写去重；步骤徽章与设置页绿色圆徽章同型；分段控件统一为 R12 灰容器 + R8 白片。 |
| `07-after-settings-nav.png` | 设置页子导航 active 态：状态驱动高亮 + 点击锚点后指示器跟随目标分区。 |
| `08-before-editor.png` / `09-after-editor.png` | 工作台编辑页前后对照：按钮族、卡片材质、加载/占位态统一。 |

## 改了什么（两阶段）

**第 1 阶段 · 全局视觉体系**（只改 `app/styles.css`，纯 CSS）：

- **脱轨色清零**：紫色强调族 26 处 → 0（焦点/进度条/AI 选中/网格/启动页/看板 hover 全部归入品牌绿），冷灰中性族 42 处 → 0（归入 `--muted` / `--line` 系）。
- **圆角 16 种 → 6 档**（4 / 8 / 12 / 16 / 20 + pill），**字号 24 种 → 9 档**（11–28px，8–10.5px 中文不可读字号清零，11px 硬下限），**奇数间距野值 347 处 → 10 处**（余 10 处为刻意 1px 发丝隙），**字面量阴影 16 种 → 0**（统一 4 级全绿调）。
- **硬编码颜色 341 → 31 个**（其中 17 个是 token 定义、13 个是测试逐字锁定的字面量）。
- 通用组件：按钮族（主按钮品牌绿 `#14725f`）、输入 H32/R12、标签页统一 39px、分段控件、状态点统一 8px 正圆、徽章合并为一套 pill、空态收编、卡片 R16 / 模态 R28。

**第 2 阶段 · 逐页结构性修正**（`app/views.js` 15 处 DOM / 3 处文案 / 9 个图标字符，CSS 纯追加 113 行）：页头行动组、行内状态 chip 归一、emoji 与几何图标同族化、explorer 双主 CTA 降级、publish 序号去重与徽章同型、settings 子导航 active 态、spinner/skeleton 加载态、`.eyebrow` 中文排版。

## 测试与约束

- `deno task check` 通过；`deno task test` **773 passed / 0 failed**，**改动测试 0 条**。
- 测试对 `styles.css` 有 67 处文本/正则断言（22 条逐字规则），对 DOM 有 179 条、文案 256 条锁定。分页区块尺寸、三栏栏宽、断点、`--control-height: 35px` 等**功能不变量逐字保留**，未为美观改动。契约清单见 [`docs/research/ui-test-contract-inventory.md`](../../../research/ui-test-contract-inventory.md)。
- 规范与逐页诊断见 [`docs/research/ui-audit-and-design-spec.md`](../../../research/ui-audit-and-design-spec.md)。

## 一处改道（产品判断）

审计清单里的「`需要配图` 孤立浮文 → 空态卡」**未执行**：经浏览器实测，该文本是 `article.block.block-paragraph` 里的**用户正文段落**，不是 UI 空态；给它包卡片等于篡改正文呈现语义，且与测试锁「区块无白卡容器」冲突。改为统一真正的占位/空态与加载态。
