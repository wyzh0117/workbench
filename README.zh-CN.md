# AI Course Workbench

[English](./README.md)

**本地优先的课程创作工作台。** 课程地图、单课编辑器、待补管理、素材库、六维完成度、只审阅式 AI 助手，以及发布与导出中心——项目数据保存在你自己磁盘上的开放 `project.json`。

技术构成：Deno 服务/领域层、无依赖 Web UI 以及受限的 [Tauri 2](https://tauri.app) 桌面壳。凡是可重建的内容（搜索索引、缩略图、诊断日志、版本快照）都只是缓存，Canonical 项目文件是唯一真相。

---

## 下载

> **当前状态：v0.2.7 已公开发布**，仓库为 public，下面的链接对匿名访问者可用。

| 入口 | 链接 |
|---|---|
| 最新版本页面（含 Release Notes） | https://github.com/wyzh0117/workbench/releases/latest |
| **Windows 安装包（x64，固定链接——始终指向最新版本）** | https://github.com/wyzh0117/workbench/releases/latest/download/AI-Course-Workbench-Windows-x64-setup.exe |
| **macOS 安装镜像（Universal，固定链接——始终指向最新版本）** | https://github.com/wyzh0117/workbench/releases/latest/download/AI-Course-Workbench-macOS.dmg |

每个 Release 都会在安装包旁边提供 `.sha256` 校验文件。已发布的 Release 一律冻结：tag 的资产永不改写，所以历史下载永远与其公布的校验值一致。

### 系统要求

| 平台 | 最低系统 | 架构 |
|---|---|---|
| Windows | Windows 10（1809+），需要 WebView2 | x64 安装包（x64 与 ARM64 均可运行） |
| macOS | macOS 11.0（Big Sur） | Universal——Apple Silicon（arm64）+ Intel（x86_64）同一个安装包 |

### 安装——Windows

1. 下载 `AI-Course-Workbench-Windows-x64-setup.exe`；
2. 运行安装向导（按用户安装，不需要管理员权限）；
3. 从开始菜单启动 **AI Course Workbench**。

如果 Windows SmartScreen 提示「Windows 已保护你的电脑」，点**「更多信息」→「仍要运行」**——安装包目前尚未代码签名（见下方「分发状态」）。安装器会检查（并在缺失时引导安装）Microsoft Edge WebView2 运行时。

### 安装——macOS

1. 下载 `AI-Course-Workbench-macOS.dmg`；
2. 打开 DMG，把 **AI Course Workbench** 拖到「应用程序」；
3. 从「应用程序」打开。

由于尚未公证（见下方「分发状态」），首次打开需要手动放行一次：

- **macOS 15（Sequoia）/ 26 及更新版本**：双击后点「完成」→ 打开
  「系统设置 → 隐私与安全性」→ 在「安全性」区域点「仍要打开」→ 输入密码或
  Touch ID 确认；
- **macOS 11（Big Sur）– 14（Sonoma）**：在「应用程序」中右键点击（或按住
  Control 点击）AI Course Workbench → 选择「打开」→ 在弹窗中再次点「打开」。

不建议关闭 Gatekeeper，也不建议用 `xattr` 移除隔离属性。

### 校验下载完整性

每个 Release 都提供 `.sha256` 校验文件：

```powershell
# Windows（PowerShell）
Get-FileHash .\AI-Course-Workbench-Windows-x64-setup.exe -Algorithm SHA256
```

```bash
# macOS
shasum -a 256 ~/Downloads/AI-Course-Workbench-macOS.dmg
```

与同一 Release 中对应 `.sha256` 文件里的值比对即可。

## 分发状态

如实说明：

- **Windows**：NSIS 安装包**未做代码签名**（没有 Authenticode 证书），首次运行
  可能触发 SmartScreen 提示；按用户安装与应用本体功能完整；
- **macOS**：DMG 为 **ad-hoc 签名、未公证**，首次打开需要上面写的手动放行；
- 补上 Windows 代码签名 / Apple Developer ID 签名只需要在发布 workflow 中配置
  证书，应用本身不需要改动。

## 功能

- **课程地图**——阶段与课次的新增、重命名、调序、删除；
- **单课编辑器**——正文区块、结构/Flow、分页排版（Grid / Page）、实时预览、
  带真实锚点的待补占位；
- **素材库**——图片、GIF、视频、PDF/DOCX/EPUB/LaTeX/Markdown 导入与预览；
  引用素材重命名带撤销/重做；
- **待补管理与六维完成度**——缺什么被明确记录，与作者手动状态分开；
- **只审阅式 AI 助手**——只产生 `ChangeDraft`，逐条审核后才应用；API Key 存在
  系统凭据存储（macOS 钥匙串 / Windows 凭据管理器），绝不写入课程文件；
- **发布与导出中心**——Markdown、Semantic HTML、Static Web 包、PDF、PPTX、
  微信/富文本迁移版、Project JSON、素材包、完整项目包；导出严格只读，导出前
  有检查清单；
- **安全存储**——原子写入、自动保存与恢复日志、项目锁、外部修改检测与合并预览、
  时间戳版本快照、按项目分别保存的阅读位置。

## 从源码构建

前置：[Deno](https://deno.com) 2.x、Rust（stable；Windows 用 MSVC 工具链，
macOS 用 Xcode 命令行工具）、`cargo install tauri-cli`（或 `@tauri-apps/cli`）。

```bash
# 1. 运行检查（与发布时同一套 gate）
deno task check
deno task test                                # 服务/UI 测试套件
cargo test --manifest-path src-tauri/Cargo.toml

# 2. 构建当前平台的桌面应用
cargo tauri build                             # 在仓库根目录执行
```

平台打包配置在 `src-tauri/tauri.<platform>.conf.json`：macOS 产出 `app` + `dmg`，
Windows 产出 NSIS 安装包。

## 仓库结构

```
app/          # 无依赖 Web UI（同样运行在 Tauri 壳内）
src/          # Deno 领域/服务层（与浏览器壳共用）
src-tauri/    # Tauri 2 桌面壳（Rust）
tests/        # Deno 测试套件
docs/feature-history/  # 每个版本的产品历史（更新日志）
.github/      # 发布 workflow 与各版本 Release Notes
```

## 反馈

欢迎在仓库页提交 Issue 与讨论：https://github.com/wyzh0117/workbench
