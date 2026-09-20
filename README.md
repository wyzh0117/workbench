# AI Course Workbench

本仓库是 AI Course Workbench 的可运行本地优先骨架：Deno 服务/领域层、无依赖 Web UI 以及受限的 Tauri 2 壳。Canonical 项目数据保存在开放的 `project.json`；Markdown、课程地图、搜索索引、缩略图和诊断日志都是可重建镜像或缓存。

## 运行

需要 Deno 2：

```bash
deno task check
deno task test
deno task ui
```

浏览器打开 `http://localhost:4173` 可检查三栏工作台、正文/结构/排版/Grid/预览、待补、六维状态、收件箱、快速收集、版本恢复、导出前检查和 Markdown/HTML 导出。没有 Rust 工具链时仍可完成服务层与 UI 契约验收。

## 已支持

- CourseSeed → BlueprintDraft → 用户确认后生成课程结构；
- Block 正文、Requirement（内容/排版分开）、Asset/Usage、六维状态、Flow/Grid/Section；
- 原子写入、自动保存恢复日志、项目锁、外部修改检测、历史版本恢复前备份；
- Canonical 图在保存/迁移时执行 FK、枚举、唯一性和跨项目校验；正文分组、Block 移动可撤销；
- 素材导入保留真实文件字节并可复核 checksum/引用；外部修改提供差异和三方合并预览；
- AI 连接器边界提供明确的未配置错误与确定性测试 fake，Suggestion → ChangeDraft → Diff → Apply 仍需用户确认；
- 高层命令边界、结构化错误、凭据字段拒绝、HTML/路径安全检查；
- 本地/导入式对话连接器：只有用户主动 `sync` 且显式选择的会话进入 Canonical；
- 可重建搜索索引（默认使用 `.workspace/index.json`；未注入原生 SQLite 时不会伪装成 SQLite）；
- Markdown、HTML、SVG/分区导出、项目 JSON/素材包/完整项目包和手动发布记录；
- Deno 核心/服务/导入导出/完整性测试覆盖恢复、Grid、AI 权限、连接器故障隔离、安全、旋转诊断、规模搜索和三方合并。

## 明确未支持

- Tauri 壳目前只提供受限高层命令骨架；原生 PDF/PNG 渲染、真实平台发布和系统钥匙串适配器尚未安装；
- Word/PDF 内容解析只作为参考素材导入，不伪装成可编辑正文；
- 浏览器 UI 是无依赖审查壳，文件选择和复杂拖拽体验仍需接入正式 Tauri 命令；
- 不提供后台聊天抓取，不将 API Key、Cookie、Token 写入项目、Git、导出或诊断包。

## 目录边界

`src/domain/` 保存 Canonical schema 与确定性业务规则；`src/service/` 保存存储/恢复、错误/诊断、搜索、连接器、导入/导出和高层命令；`src/ui/` 是 UI 契约与 Grid 计算；`app/` 是可直接打开的 Web UI；`src-tauri/` 只负责受限桌面桥接。SQLite、日志、恢复和缩略图等工作台数据不得反过来成为项目唯一真相。
