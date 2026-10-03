# Feature Update Manual / 功能更新手册

这里是 **AI Course Workbench 的自然语言产品历史**，写给「会用这个软件的人」，不是写给编译器的。

## 版本索引

日期均为 `+0800`（GitHub 返回的是 UTC，此处已换算）。源码提交为 tag peel 后的 commit（短写）。
「公开 Release」列 = GitHub 上真的存在、真的能下载到安装包的 Release 页面。

| 版本 | 发布日期 | 源码提交 | 公开 Release | 状态 | 用户视角：这一版能做什么新事情 |
|---|---|---|---|---|---|
| v0.1.0 | 2026-09-23 | `90872bd` | [v0.1.0](https://github.com/wyzh0117/workbench/releases/tag/v0.1.0) | 公开可用（历史版本） | 第一个可以下载安装就能用的版本：课程地图、单课编辑器、Flow / Grid、素材库、只审阅式 AI 助手、发布与导出中心全部可用；首次打开需要手动过一次 Gatekeeper。 |
| v0.1.1 | 2026-09-25 | `7dda413` | [v0.1.1](https://github.com/wyzh0117/workbench/releases/tag/v0.1.1) | 公开可用（历史版本） | 真实使用中「点一下就没反应 / 输入法被打断」这类阻断问题被解决；模型配置改为向服务商真实读取模型清单；Flow 成为唯一的排序入口，Grid 的重设计让左键落位、右键移出。 |
| v0.1.2 | 2026-09-27 | `d749038` | [v0.1.2](https://github.com/wyzh0117/workbench/releases/tag/v0.1.2) | 公开可用（历史版本） | 可以自己在课程地图里增 / 改名 / 排序 / 删除阶段；区块可以拖把手重排；并且可以把一个**已经存在的文件夹**直接接管成 Workbench 项目，原文件不移动、不改名、不删除。 |
| **v0.2.0** | 2026-09-27（tag 时间） | `a793204` | **不存在** | **未发布 / 失败 tag** | **用户没有从这一版拿到任何东西。** 见下方「关于 v0.2.0」。 |
| v0.2.1 | 2026-09-27 | `60f6976` | [v0.2.1](https://github.com/wyzh0117/workbench/releases/tag/v0.2.1) | 公开可用（历史版本） | Grid 布局里出现了真正的「页」：页有稳定编号、可以改顺序和尺寸、内容能在页之间移动；课程可以按页导出 HTML / PDF / PowerPoint，PPTX 一页对应一张幻灯片，文字和图片是能分别编辑的独立对象。 |
| v0.2.2 | 2026-09-29 | `d85c3f7` | [v0.2.2](https://github.com/wyzh0117/workbench/releases/tag/v0.2.2) | 公开可用（历史版本） | 素材库里可以直接看内容：图片和 GIF 能放大、PDF 看首页、视频音频能播、Markdown 能读；往素材库加文件不再被自动挂到当前课；服务商换了服务域名时，会先问你是否愿意把密钥发过去。 |
| v0.2.3 | 2026-10-01 | `0ce229a` | [v0.2.3](https://github.com/wyzh0117/workbench/releases/tag/v0.2.3) | 公开可用（历史版本） | 可以把一批 Markdown 文件或多个文件夹，带着**看得见、可修改的映射计划**导入并追加到已有课程，整个导入能一次撤销；正文里的 Markdown 按语义呈现；AI 设置把 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 当成三种不同协议处理，并新增原生 Sign in with ChatGPT 订阅登录。 |
| **v0.2.4** | 2026-10-02 | `4db396b` | [v0.2.4](https://github.com/wyzh0117/workbench/releases/tag/v0.2.4) | **公开可用 / Latest / 冻结** | 编辑器去掉干扰（B/I/S 与 Markdown 源码切换消失，Markdown 语义直接编译且可撤销）、区块工具条与属性改成浮层、Grid 恢复左键落位 / 右键移出、素材改名会真的改磁盘文件、素材支持多选批量导入、打开文件夹会先看懂再说话、子目录图片视频进素材库、PNG 缩略图修好且卡片重做、AI 连接改为自配服务商与真实模型清单、ChatGPT 订阅登录逐阶段报错。 |
| **v0.2.5** | 2026-10-03 | 见下方说明 | [v0.2.5](https://github.com/wyzh0117/workbench/releases/tag/v0.2.5) | **公开可用 / Latest / 冻结** | 打开入口变成项目列表（最近优先、可重新定位）；打开文件夹不再认错项目（旧 schema 先修复、坏文件说具体原因、父目录不顶替子项目）；`.txt .text .md .markdown .tex .latex .docx .epub .pdf` 九类文本 / 文档按原结构导入正文（无 OCR、PDF 只取文本层、LaTeX 公式存代码、编码自动识别）；映射确认后可逐份挑选要导入的文档；媒体库大列表来回滚动不再闪屏 / UI 抽搐 / 卡片卡住。 |

### 关于 v0.2.0

`v0.2.0` **不是一个公开版本**，因此本手册**没有** `v0.2.0.md`。

- tag `v0.2.0` 指向源码提交 `a793204eda40ad6723ca6aa3ac5b95e646c4ebcc`（本地 tag 时间 2026-09-27 21:39 +0800）。
- 由该 tag 触发的发布 workflow [36323485548](https://github.com/wyzh0117/workbench/actions/runs/36323485548)（`Release macOS DMG`，结论 `failure`）在导入空的 `APPLE_CERTIFICATE` 时失败，**没有创建 Release，也没有上传任何资产**。`gh release view v0.2.0` 返回 `release not found`。
- `.github/release-notes/v0.2.0.md` 这份正文当时写好了，但从未公开过。
- 该 tag 按总控的冻结规则**保持不动、未移动、未删除**（见 `PROJECT_MASTER_CONTROL.md` §38.1 / §38.4）。
- **v0.2.0 想发布的内容，是随 `v0.2.1` 第一次到达用户的**：`v0.2.1` 的 Release 正文与 `v0.2.0.md` 逐条相同，只多出最后一条空证书回退修复。所以要看这部分用户变更，请读 [`v0.2.1.md`](./v0.2.1.md)。

## 这份手册是干什么的

它**不是 commit log**，也不是测试报告。它是一份让人读懂的产品历史：一年后回来查「这个功能是从哪个版本开始能用的」「那件事当时到底验过没有」，这里有答案。

每个**公开可用**的版本文件都必须回答这五个问题：

1. **这个版本用户能做什么新事情？**
2. **哪些操作方式发生了变化？**
3. **哪些旧问题被修复？**
4. **兼容性或迁移变化**
5. **已知限制**

写的是「用户现在能做某件事」，不是「改了哪个模块」。测试数量只有在能解释这一版为什么可信时才写。

## 维护工作流

- **每次改变了产品行为的开发工作结束**：更新 [`UNRELEASED.md`](./UNRELEASED.md)。不需要等发版。
- **每次创建公开 Release**：把 `UNRELEASED.md` 中属于该版本的内容**冻结**成 `docs/feature-history/vX.Y.Z.md`，然后**清空 `UNRELEASED.md`** 给下一个循环用，并在上面的索引表加一行。
- **永远不为「没有成为公开用户版本的 tag」单独建文件**；这类 tag 只在索引里以「未发布 / 失败 tag」标注（当前只有 `v0.2.0`）。
- 本手册的更新是任务交接的一部分，规则见 `PROJECT_MASTER_CONTROL.md`（§1 任务结束后 / §20 / §21）。

## 记录来源与优先级

1. **GitHub Release 正文** —— 用户可见能力的**权威**来源（`gh release view <tag>` 逐个核对）。
2. `PROJECT_MASTER_CONTROL.md` §33–§41（各版本的验收记录）。
3. `docs/` 下的验收 / 交接报告、`.github/release-notes/*.md`、Git 历史。

Release 正文与总控冲突时以 Release 正文为准，并在版本文件里注明分歧。
**没有证据的地方一律写「无记录」，不推测、不补全。**

## 分发状态的长期事实（从 v0.1.0 到 v0.2.4 没有变过）

所有已发布的 DMG 都是 **ad-hoc 签名**：没有 Apple Developer ID 签名、没有 Apple 公证，
`spctl --assess --type execute` 判定 **rejected**（v0.2.4 的公开包在 2026-10-02 复测仍是 `rejected`，见 `PROJECT_MASTER_CONTROL.md` §43.4）。每个用户首次打开都需要手动过一次 Gatekeeper 放行。
另外，**放行之后的首次启动从未被实测过**（自动化环境无法投递右键菜单与「系统设置」交互），
实测到的只是放行**之前**的拦截状态。

## 当前循环

`v0.2.5` 是 v0.2.4 之后的下一轮收口版本（2026-10-03），发布后即刻冻结。本轮把四个用户可见方向一起落地：打开入口变成项目列表、打开文件夹不再认错项目、九类文本 / 文档按原结构导入正文（映射确认后可逐份挑选）、媒体库大列表滚动不再闪屏。逐项矩阵与证据见 `PROJECT_MASTER_CONTROL.md` §45 与 `docs/V0.2.5_Closure_2026-10-03_Completion_Report.md`；媒体库闪烁根因的大白话说明见 `docs/v0.2.5_media_flicker_root_cause.md`。原生窗口指针 smoke、真实在线 AI 与真实触控板滚动三条通道仍未闭合，`v0.2.5.md` 的「已知限制」写明了它们，发布验证事实发布后回填本节与本表。

**v0.2.5 的源码提交**由 tag 自身给出：`git rev-parse v0.2.5^{commit}`（发布验证段补在 `v0.2.5.md` 与本表之后）。
