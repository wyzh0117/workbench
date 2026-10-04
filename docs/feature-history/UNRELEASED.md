# UNRELEASED — 尚未归档进任何公开版本的用户可见变更

> 滚动文件。每次改变了产品行为的开发工作结束后更新这里；创建公开 Release 时，把属于该版本的内容冻结成 `docs/feature-history/vX.Y.Z.md` 并清空本文件（规则见 [`README.md`](./README.md) 的「维护工作流」与 `PROJECT_MASTER_CONTROL.md`）。

---

## 当前状态（2026-10-05）

```text
Latest public release       = v0.2.5（发布验证事实见本目录 README「当前循环」，验证完成后回填）
Rolling content             = v0.2.6 candidate —— Mapping / Preview / Flow / Free Layout /
                              Full UI Redesign；逐项状态与证据见本页下文和
                              [HTML completion report](../reports/v0.2.6-ui-redesign-completion-report.html)
Still open from v0.2.5      = 三条验收通道没有由自动化环境闭合：原生窗口的指针 / 面板手势、
                              真实在线 AI 调用、媒体库滚动的真实触控板 / 滚轮验证
                              （原因见 v0.2.5.md 与 v0.2.4.md 的「已知限制」）
v0.2.6 release state        = 尚未发布；latest public 仍为 v0.2.5。用户已明确授权本轮开发完成后同步、tag 与 Release；
                              候选验收和公开产物验证完成前不写成已发布事实。
V0 = CLOSED；V1 = ACTIVE；V1-T01–T06 保留原 VERIFIED；不创建 V1-T07，不关闭 V1
```

用户在上述几处给出的结论，以及任何新的行为改动，从下一条记录开始写进本文件。

---

## 这个版本用户能做什么新事情？

- **Mapping Preview 只负责确认根级对象与目标。** 勾选和行点击使用稳定扫描快照，不触发其他行重读；不再展示图片依赖、正文导入结果或建议栏。
- **映射后可挑选直接子文档导入正文。** 根级选择仍只读一级；媒体递归入素材库且不会因入库自动挂到正文。二次选择支持分组、全选 / 清空、checkbox 与整行切换，并服从已确认的目标映射。
- **结构化导入保留可解析图片的语义位置。** Markdown、DOCX、EPUB、LaTeX 中能安全解析的图片进入素材库并关联原文区块；纯递归发现、未被正文引用的媒体只入库。逐格式边界见 [后端格式证据](../reports/evidence/v0.2.6/mapping-backend.md)。
- **Preview 按阅读顺序呈现正文语义和媒体。** 图片直接显示；GIF 用静态首帧，点开媒体查看器后播放；视频展示首帧并由用户明确播放。关闭查看器会停止并重置媒体。
- **Flow 成为正文顺序视图。** 点项目跳到对应正文区块；拖动把手修改 Canonical 顺序，正文、Preview 和导出读取同一顺序。
- **Grid / Page 排版移到顶层「自由排版」。** 旧「结构」与工作台内旧「排版」入口移除；网格、分页、页面操作、跨页移动与既有导出入口继续可达。
- **全局页面和弹窗统一视觉与交互规则。** 页面清单、响应式 / 键盘检查、例外与证据见 [UI audit](../reports/v0.2.6-ui-audit.md) 和 [completion report](../reports/v0.2.6-ui-redesign-completion-report.html)；不宣称达到奖项标准。

最终 frozen-source Deno gates 通过：`deno task check` 与 `deno task test`（602/602，含 loopback），Rust tests 222/222。Browser CUA 已验证导入 Markdown Preview、GIF 动画与静态 inline 首帧、真实 video block 播放/关闭、两行 dash-list 键入与 blur 转换，以及 rename dialog 的取消、校验、实际文件重命名和 Undo。Flow handle 04→03 拖动、Undo/Redo、Body/Preview 同序与保存重开磁盘顺序通过；可信快照接收时误显「未保存」已修复，run6 reload 中显示「已保存」。Free Layout 的 `pageGrid` 错误已修，66/66 回归通过，browser CUA 实测跨页移动、跨度调整、新建页和复制页并确认 placement 已落盘。删除未执行，重开/导出仍待验收；Overview/shared shell 在 1024、1280、1440、1728×900 实测无横向溢出或顶栏重叠，其余页面、侧栏/text scale 和部分 modal/keyboard 仍按 HTML 报告标记为 PARTIAL。Mac 锁屏使 native smoke 为 BLOCKED；截图文件无法通过当前 CUA 接口保存。一次隔离浏览器复测中，主导航和概览操作只能获得焦点，未观察到路由或操作结果；独立源码检查确认事件绑定路径存在，但 Mac 随后锁屏，无法复现运行时原因，仍按 PARTIAL 标记。本地最终 Universal candidate 通过版本、架构、DMG integrity 检查，SHA-256 `c4594037e0c9d4e908c9896e2aff9b39c55b23c883e19c0429fb73654d2e354f`；本地包未签名/公证，且尚未公开发布。详见 [HTML completion report](../reports/v0.2.6-ui-redesign-completion-report.html)、[CUA evidence](../reports/evidence/v0.2.6/ui-evidence.md) 与 [candidate package](../reports/evidence/v0.2.6/candidate-build-final.md)。

## 哪些操作方式发生了变化？

- 先在根级 Mapping 确认对象和目标，再在有支持文档时逐份选择正文导入对象；文档弹窗不递归读取子目录文档，也不自行推测 Stage / Lesson。
- 在工作台顶部使用「正文 / Flow / 预览」；Flow 点击回正文，重排通过拖动把手完成。
- 需要安排区块、页面或导出时，从主导航进入「自由排版」。

## 哪些旧问题被修复？

- Mapping 行勾选抖动、无关项被连带重读、反复打开后错位的问题有针对性回归覆盖。
- 磁盘版本在其他地方变化时，保存会暂停以防覆盖；冲突界面可重新载入、合并，或在确有冲突时明确保留本地内容。重复导入保护会保留已经编辑的正文，而不是静默替换。
- Flow 项目点击现在能直接定位正文区块。
- 旧「结构」与工作台内「排版」的信息架构重复；入口按职责拆分到 Flow 与顶层自由排版。
- lesson-folder 选择到新目标时，多个勾选的直接子文档会归入一个以文件夹命名的新课时；未选文档不导入。后端从已确认映射和重验路径派生分组，不信任客户端 group 字段。

## 兼容性或迁移变化

- `project.json` 仍是 Canonical；Flow 顺序继续写原 block `order_index`，自由排版复用既有 layout / page 模型。
- 旧工作台 Layout 路由迁移到 Free Layout；已有 Grid/Page 数据与导出投影保留。v0.2.5 与更早公开包、assets 和 tags 不变。
- 导入原文件保持原地；图片引用仅在解析成功且路径安全位于选定根目录内时落入语义块；递归媒体扫描不新增 `AssetUsage`。

## 已知限制

- PDF 仅提取文本层；图片 XObject 不导入、不伪造语义位置；扫描版 PDF 不做 OCR。纯文本 `.txt/.text` 没有嵌入图片语义。
- LaTeX 以 `\\includegraphics` 为主；`\\graphicspath` 与旧图形宏不解析，数学 / 不支持的环境按警告降级。DOCX / EPUB 保留文档语义而非原排版；CSS、脚本和不支持的嵌入对象不进入正文。
- 当前公开下载和 latest 仍是 v0.2.5；分发签名、公证状态以长期事实和发布后验证为准。

---

## 验收入口

- [v0.2.6 UI redesign completion report](../reports/v0.2.6-ui-redesign-completion-report.html)
- [UI audit](../reports/v0.2.6-ui-audit.md)
- [Design system](../reports/v0.2.6-design-system.md)
- [Mapping backend and format evidence](../reports/evidence/v0.2.6/mapping-backend.md)

---

## 发版时需要做的事

1. 本轮用户已明确授权开发完成后同步 GitHub、tag 与 Release；在候选验收和公开产物验证之前，本文件和报告仍按 candidate / latest public v0.2.5 记载。`v0.2.5` 及更早 tags / 资产保持冻结。
2. 发布前补做：release 配置的 Universal 构建 + DMG + `hdiutil verify`，以及本机真实指针 smoke。完整步骤见 [`../release-playbook.md`](../release-playbook.md)。
3. 发布后核对公开 Release 资产与 `.sha256` sidecar，并把事实回写 Release Notes、本目录索引与 `PROJECT_MASTER_CONTROL.md`。
4. 把本文件中属于该版本的内容冻结成 `docs/feature-history/vX.Y.Z.md`，在 `docs/feature-history/README.md` 的索引表加一行，然后**把本文件重置为下一个周期的空模板**。
5. 同步更新 `PROJECT_MASTER_CONTROL.md`、`README.md` 与该轮的 Completion Report。
