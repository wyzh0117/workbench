# rea 工具调研报告

- 调研日期：2026-10-24
- 调研目标：评估 https://github.com/morluto/rea 是否真实存在、是什么工具，以及在"把某款 Tauri/Electron 桌面客户端的 AI 模型配置界面仿制成 DeepSeek Harness 样式"这一任务中是否需要使用它。
- 结论速览：**rea 真实存在（MIT 开源逆向工具），但本次任务不需要使用**；`deepseek-ai/deepseek-harness` 仓库**公开可读**，其源码是比逆向打包产物更权威的参照。

---

## 一、rea 是什么

### 1.1 仓库确实存在（已核实）

| 项目 | 核实结果 |
| --- | --- |
| 仓库 | <https://github.com/morluto/rea>（GitHub API 返回 200，`private: false`，公开可读） |
| 名称 / 定位 | **REA: Reverse Engineer Anything** — “Reverse engineer anything with agents, from app behavior down to native binaries.” |
| 默认分支 | `main` |
| License | MIT |
| 主要语言 | TypeScript（约 38 MB 源码），其余为 JavaScript / Python / HTML 等 |
| Star / Fork | 371,802 / 93,108（2026-10-24 查询） |
| 创建 / 最近推送 | 2026-04-14 创建，2026-10-23 仍活跃 |
| npm 包 | `rea-agents`（v6.7.0，MCP 名 `io.github.morluto/rea`，bin：`rea` / `rea-agents`） |
| 官网 | <https://rea.tools/>（含 guides / showcase） |

### 1.2 工具类型

rea 是**逆向工程工具集**，同一套能力以两种形态提供：

1. **MCP server**：注册进 Claude Code / Codex / Cursor / Gemini CLI 等编码 Agent，让 Agent 调用逆向分析工具并带证据回答"这个 App 的某功能是怎么实现的"。
2. **CLI**：终端直接调用（`rea` 命令），也可脚本化。

分析能力（README 能力表摘要）：桌面应用安装目录探测、**JavaScript/Electron 应用静态分析**（模块、imports、Electron 边界，无需原生反编译引擎）、原生二进制伪代码/汇编/符号（需 Hopper、Ghidra 或 IDA）、Go/Rust 二进制元数据、模型文件（GGUF/safetensors）、Unity IL2CPP 元数据、Godot PCK、WASM 等。分析在本地运行，结论附证据与局限说明。

### 1.3 安装与命令行用法（来自 README / package.json，未编造）

- Agent 集成：`npx rea-agents setup`（交互式选择 Agent，写入 MCP 注册与工作流指令，需重启 Agent）。
- 全局 CLI：`npm install --global rea-agents` 得到 `rea` 命令；`rea --help` 查看子命令；更新用 `rea update`。
- **Electron/JS 静态分析（与本任务最相关的子命令）**：

~~~bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
~~~

  参数可以是已解包的 JS/Electron 应用目录或 ASAR；输出包含模块、imports、Electron 边界及证据。
- 原生二进制分析需先配置 provider（Hopper/Ghidra/IDA），见仓库 `docs/cli.md`。
- 运行要求：Node.js 22.x（≥22.23.4）、24.x（≥24.22.1）或 26.12.1+，加 npm。**本机 Node 为 v22.23.2，略低于 rea 的 engines 下限 22.23.4**（npm 会报 EBADENGINE 警告）。

---

## 二、deepseek-harness 仓库是否公开

**公开可读。** <https://github.com/deepseek-ai/deepseek-harness>（GitHub API 返回 200，`private: false`）：

| 项目 | 核实结果 |
| --- | --- |
| 默认分支 | `master` |
| License | MIT |
| Star / Fork | 259,308 / 31,303（2026-10-24 查询） |
| 创建 / 最近推送 | 2026-08-13 创建，2026-10-23 仍活跃 |
| 描述 | "DeepSeek Harness: Everything is a Plugin." |
| 结构 | `apps/`（desktop、web、cli…）、`packages/`、`docs/`、`native/`、`website/` 等，标准 pnpm monorepo |

> 附注：本沙箱内 git 协议访问 github.com 失败（git ls-remote 报 "Empty reply from server"），但 GitHub REST API 与 raw.githubusercontent.com 均可正常读取；以上结论基于 API 实测。

### 2.1 与"模型设置界面"直接相关的目录/文档（比逆向打包产物更权威）

| 路径（仓库内） | 内容 |
| --- | --- |
| `packages/client/ui-settings-models/` | **模型设置页面包源码**：`src/`、`tests/`、`locale/`、`package.json`，以及 README.md（24.5 KB）/ README.zh.md（22.8 KB）——逐条描述提供商行、API 密钥（只写凭据）、模型列表、自定义 pi-ai 路由、DeepSeek 首次运行弹窗等交互细节 |
| `packages/client/ui-model-selection/` | composer 里的模型选择器 |
| `packages/client/ui-settings/`、`ui-settings-general/`、`ui-settings-account/` 等 | 设置外壳与相邻设置页（导航结构、页面骨架） |
| `packages/settings/settings/` | 设置存储层 |
| `docs/user/guide/providers.zh.md` | 官方用户指南"模型提供商"页，**配界面截图 `providers-models-page.zh.png`、`providers-custom-form.zh.png`** |
| `docs/web-styling.zh.md`、`docs/ui-radius.zh.md` | Web 样式与圆角规范（仿制视觉细节直接看这里） |
| `BRAND_GUIDELINES.zh.md` | 品牌规范——仿制时注意只学布局/交互，不复制品牌资产 |
| `apps/desktop/`、`apps/web/` | 桌面壳与 Web 入口 |

---

## 三、本任务是否需要 rea：**不需要**

理由（按重要性）：

1. **参照物（DeepSeek Harness）根本不需要逆向**：其 GitHub 仓库公开、MIT 授权，`packages/client/ui-settings-models` 就是"AI 模型配置界面"的**完整源码 + 2 万余字中文设计文档 + 测试**；官方用户指南还附界面截图。这是第一手材料，逆向得到的任何结论都不如它权威。
2. **asar 已成功解析，无需借助逆向工具**：`app.asar` 已解到 `/tmp/dsh-research/extract/`，其中 `/tmp/dsh-research/extract/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/` 自带 `README.md`、`README.zh.md`、`LICENSE`（MIT, Copyright 2026 DeepSeek）、`locale/`、`package.json` 与未压缩可读的 `lib/client.js`、`lib/index.js`。普通解包 + 读文件即可。
3. **MIT 授权**：仓库与包均为 MIT，参考其布局、交互、文案结构实现仿制在授权上无障碍（仍须遵守 `BRAND_GUIDELINES`，不得复制 DeepSeek 商标/品牌资产冒充官方）。
4. **引入 rea 反而增加成本**：要求 Node ≥22.23.4（本机 v22.23.2 不满足 engines）；`npx rea-agents setup` 会改写 agent 配置（本次不应执行）；原生二进制能力还需另装 Hopper/Ghidra/IDA——而本任务对原生二进制毫无需求。

### 什么情况下才用得上 rea（备用路径）

仅当需要逆向**目标第三方 Tauri/Electron 客户端本身**（例如只有成品、拿不到它自己的源码，必须反推它现有"AI 模型配置"实现）时才需要，例如：

~~~bash
# Electron：对客户端的 asar 或解包目录做 JS 静态分析
npx -y rea-agents@latest analyze-javascript-application "/path/To/Client.app/Contents/Resources/app.asar" --json

# Tauri：对解开的前端资源（前端仍是 JS/HTML）用同一命令
npx -y rea-agents@latest analyze-javascript-application /path/to/extracted-frontend --json
~~~

若还需理解客户端的 Rust/Tauri 后端逻辑，则需 rea 的 native 分析 + Hopper/Ghidra/IDA。**本次任务的视觉/交互参照是 DeepSeek Harness（公开源码），客户端侧如已有源码可直接改动，因此这两条路径都不会触发。**

---

## 四、rea 安装试跑（仅在 /tmp 内）

试跑环境与结果（2026-10-24，全部只在 /tmp/dsh-research/ 内操作）：

| 项目 | 结果 |
| --- | --- |
| 安装 | `npm install rea-agents`（npm cache 重定向到 /tmp/dsh-research/.npm-cache）**成功**，安装于 `/tmp/dsh-research/rea/`，体积约 132 MB，版本 **6.7.0** |
| Node 引擎要求 | 要求 ≥22.23.4，本机 v22.23.2 不满足 engines；npm 仅告警，CLI 实际可运行 |
| `rea --help` | 正常，列出大量子命令（`inspect`、`decompile`、`analyze-javascript-application`、`export-web-scripts`、`compare-*` 等） |
| 试跑命令 | `node /tmp/dsh-research/rea/node_modules/rea-agents/scripts/rea.mjs analyze-javascript-application /tmp/dsh-research/extract --json`（目标为已解出的 app.asar 目录） |
| 试跑结果 | **部分成功后失败**：进度日志显示它逐个解析了 43 个 JS/JSON 工件（含 `ui-settings-models/lib/client.js`、`ui-settings-models/lib/index.js` 的 parse scope、locale/en.json 等），但最终以 `cleanup_incomplete`（execution_failure）退出——"Provider cleanup could not be fully confirmed"，并在 `/var/folders/.../T/rea-javascript-analysis-V9hQvu` 留下临时资源目录 |
| 产物 | `/tmp/dsh-research/rea-trial.json`（6.9 MB，错误 JSON，含 `partial_observation` 部分观测，其中提及 ui-settings-models 112 次）、`/tmp/dsh-research/rea-trial.err`（进度流） |

试跑结论：rea 能够自动解析已解包的 Electron/JS 应用（本次确实识别并解析了 `ui-settings-models` 包），**但它的产出在本任务中没有增量价值**——它读的正是我们已有的同一份未压缩 JS，而它没有能力替代 `README.zh.md` 这类随包分发的设计文档；且本次试跑以清理失败告终，说明在受限沙箱里还会产生额外摩擦（残留临时目录 `/var/folders/fb/.../T/rea-javascript-analysis-V9hQvu` 未自动回收）。因此维持"不使用 rea"的结论。

---

## 五、给主任务的执行建议

1. 直接以 `packages/client/ui-settings-models/`（GitHub 源码）+ `docs/user/guide/providers.zh.md`（含截图）+ `/tmp/dsh-research/extract` 中的 `lib/*.js`、`README.zh.md` 为蓝本，梳理"模型配置界面"的布局与交互规格。
2. 视觉规范看 `docs/web-styling.zh.md`、`docs/ui-radius.zh.md`；注意 `BRAND_GUIDELINES.zh.md` 的合规边界。
3. 不要安装/调用 rea；如后续遇到"只有成品客户端没有源码"的新需求，再按 §3 备用路径引入。
