# V1-T02 — macOS Distribution & Public Release Closure

> AI Course Workbench  
> V1 发布 / 分发任务  
> 本任务不是功能迭代，不增加新的课程编辑、AI、发布格式或工作流能力。  
> 目标：把已经 `DOGFOOD READY` 的 Workbench 做成普通 macOS 用户可以直接下载安装的正式分发包，并完成 GitHub Release 与稳定下载链接。

---

# 0. Task Position

开始前必须完整阅读：

```text
1. PROJECT_MASTER_CONTROL.md
2. README.md
3. 本任务卡
4. 必要的现有 Tauri / Git / Release 配置
```

当前基线：

```text
V0 = CLOSED

V1 = ACTIVE

V1-T01 — V0 Hardening & UX Polish
Status: VERIFIED

Product State:
DOGFOOD READY
```

本任务由用户明确提出，因此允许创建：

```text
V1-T02 — macOS Distribution & Public Release Closure
```

它是一个平铺任务，不是新的 Milestone，也不是 V1.1 / Release Phase / Distribution Phase。

---

# 1. Original Goal

本轮只完成四件事：

```text
1. 把 V1-T01 的 README / MASTER CONTROL 文档状态彻底对齐；
2. 生成普通 macOS 用户可以直接安装的正式分发包；
3. 推送 GitHub，并创建带可下载安装包的 GitHub Release；
4. 生成一个固定、简单、可长期使用的“最新版本直接下载”链接。
```

完成以后：

```text
V1-T02 = VERIFIED
Product Distribution State = PUBLIC RELEASE READY
```

随后仍然：

```text
PAUSE FEATURE DEVELOPMENT
```

用户继续真实使用 / Dogfooding，不自动创建 V1-T03。

---

# 2. Important Clarification — GitHub Release Means What?

用户的理解基本正确。

GitHub Release 可以：

```text
Tag / Version
Release Notes
安装包 / 压缩包等 Release Assets
```

用户打开 Release 页面后可以直接下载上传的 `.dmg`。

GitHub 还支持：

```text
/release/latest
```

跳转到最新 Release 页面，以及：

```text
/releases/latest/download/<asset-name>
```

直接下载“最新 Release 中指定文件名的资产”。

因此：

> **GitHub Release 完全可以作为 Workbench 的公开下载入口。**

---

# 3. “傻瓜式链接”的现实边界

## 3.1 可以做到

目标体验：

```text
用户复制一个固定链接
↓
粘贴浏览器
↓
回车
↓
浏览器直接开始下载最新 macOS 安装包
```

可以实现。

推荐稳定链接格式：

```text
https://github.com/<OWNER>/<REPO>/releases/latest/download/AI-Course-Workbench-macOS.dmg
```

前提：

```text
每个 Release 上传的 DMG 都保持完全相同的 asset 文件名：
AI-Course-Workbench-macOS.dmg
```

Release Tag 可以变化：

```text
v0.1.0
v0.1.1
v0.2.0
...
```

但下载资产文件名不要随版本号变化。

这样：

```text
/releases/latest/download/AI-Course-Workbench-macOS.dmg
```

就始终指向最新版本。

---

## 3.2 浏览器不能替用户自动安装 App

不要实现或承诺：

```text
粘贴链接
→ 下载
→ 自动挂载 DMG
→ 自动把 App 写入 /Applications
→ 自动启动
```

这是不符合正常 macOS 安全模型的目标。

本任务定义的“傻瓜式安装”是：

```text
固定链接
→ 自动下载 DMG
→ 用户双击 DMG
→ 将 Workbench 拖到 Applications
→ 打开 Workbench
```

这是 macOS App 在 App Store 之外最常见、最容易理解的安装方式。

---

# 4. Distribution Format

本轮正式分发格式：

```text
DMG
```

不要为了追求字面上的“一键安装”顺手增加：

```text
PKG
Homebrew Cask
Mac App Store
自定义安装器
自动更新器
```

这些全部不属于本任务。

---

# 5. Architecture Target

为了让一个链接同时服务更多 Mac 用户，优先目标：

```text
Universal macOS App
= Apple Silicon + Intel
```

优先尝试：

```text
universal-apple-darwin
```

要求先确认本机构建环境拥有：

```text
aarch64-apple-darwin
x86_64-apple-darwin
```

两个 Rust target。

如果 Universal 构建由于项目真实依赖无法成立：

```text
不要偷偷降级
```

必须报告：

```text
为什么失败
当前实际支持的架构
是否只发布 Apple Silicon
```

如果最终只发布 Apple Silicon：

```text
Release Notes
下载文件名
README
```

都必须明确说明。

---

# 6. Work Item 1 — Documentation Closure

当前已知状态：

`PROJECT_MASTER_CONTROL.md` 已写：

```text
V1-T01 = VERIFIED
DOGFOOD READY
NEXT ACTION = PAUSE FEATURE DEVELOPMENT
```

但上一版 README 顶部仍曾存在：

```text
V1-T01
IN PROGRESS
继续 V1-T01
```

本轮必须先检查并统一。

最终 README 至少应表达：

```text
当前版本：V1（ACTIVE）
V1-T01：VERIFIED
产品状态：DOGFOOD READY
当前任务：V1-T02 — macOS Distribution & Public Release Closure
NEXT ACTION：完成正式 macOS 分发与 GitHub Release
```

V1-T02 完成以后再次更新为：

```text
V1-T02 = VERIFIED
Product Distribution State = PUBLIC RELEASE READY
NEXT ACTION = PAUSE FEATURE DEVELOPMENT
```

---

# 7. Work Item 2 — Repository / Git Preflight

正式发布前必须检查：

```text
git status
git branch
git remote -v
git log
.gitignore
未跟踪文件
构建生成物
临时测试数据
密钥 / Token / Apple 凭据
```

必须确保：

```text
没有 API Key
没有 Keychain 导出物
没有 Apple 私钥
没有 App Store Connect 私钥
没有签名证书
没有测试项目
没有真实用户课程数据
没有 diagnostics
没有 session
没有 recovery 数据
没有 release 临时目录
```

---

# 8. Work Item 3 — Decide GitHub Visibility

在创建 Release 前必须确认 GitHub 分发策略。

## Option A — Public Source Repository

适合：

```text
允许公开 Workbench 源码
```

结构：

```text
公开 GitHub Repo
├── Source Code
├── Tags
└── Releases
    └── AI-Course-Workbench-macOS.dmg
```

优点：

```text
最简单
Release 页面任何人都能访问
稳定下载链接可直接使用
```

---

## Option B — Private Source + Public Binary Distribution Repo

如果：

```text
不希望公开源码
```

则推荐：

```text
Private Repo
└── Workbench source

Public Distribution Repo
└── Releases only
    ├── DMG
    ├── checksums
    └── Release Notes
```

这比为了提供公开下载而把私有源码仓库直接公开更安全。

---

## Hard Rule

如果目标是：

```text
任何人
无需登录 GitHub
拿到链接即可下载
```

那么承载 Release Asset 的仓库 / 下载源必须公开可访问。

私有 GitHub Release：

```text
不能当作公开“傻瓜式下载链接”
```

---

# 9. Work Item 4 — Versioning

检查：

```text
src-tauri/tauri.conf.json
src-tauri/Cargo.toml
其他 package / version 配置
```

确认当前正式 App Version。

不要混淆：

```text
项目开发阶段：V1
```

和：

```text
App Release Version：例如 0.1.0 / 0.2.0 / 1.0.0
```

它们不是一回事。

如果仓库已经有明确版本：

```text
沿用现有 SemVer
```

如果没有明确公开版本：

```text
不要 Agent 自行随意宣布 1.0.0
```

应使用现有配置中的版本，或报告用户需要最终确认版本号。

Tag 格式：

```text
v<semver>
```

例如：

```text
v0.1.0
```

---

# 10. Work Item 5 — Product Metadata Audit

正式打包前检查：

```text
productName
identifier / bundle id
version
app icon
窗口标题
About / application name
DMG 文件名
最低 macOS 版本
架构
```

要求：

```text
用户安装后在 Finder / Applications / Dock 中看到的是正式产品名
```

不要出现：

```text
debug
test
takeover
walk
v0-t04
localhost
AI Course Workbench Debug
```

等开发痕迹。

---

# 11. Work Item 6 — macOS Code Signing

为了让从浏览器下载的 App 能被普通用户正常打开：

> 正式公开分发必须优先使用 Apple Developer 的 Developer ID Application 证书进行签名。

先检查：

```bash
security find-identity -v -p codesigning
```

确认是否存在可用：

```text
Developer ID Application
```

签名身份不得硬编码到公开仓库中的敏感配置。

可以使用：

```text
APPLE_SIGNING_IDENTITY
```

或受控 Tauri 配置。

---

# 12. Work Item 7 — Apple Notarization

公开站外分发目标：

```text
Signed
+
Notarized
+
Stapled
```

优先使用：

```text
App Store Connect API credentials
```

或合法 Apple ID notarization credentials。

任何：

```text
APPLE_API_KEY
APPLE_API_ISSUER
APPLE_API_KEY_PATH
APPLE_ID
APPLE_PASSWORD
APPLE_TEAM_ID
```

都不得提交进 Git。

应放在：

```text
本机安全环境
GitHub Actions Secrets
```

等受控位置。

---

# 13. Signing / Notarization Decision Gate

如果当前没有：

```text
Apple Developer Program
Developer ID Application certificate
可用 notarization credentials
```

则：

### 可以完成

```text
代码构建
DMG 生成
GitHub 流程准备
Release Draft
```

### 不能宣称

```text
PUBLIC RELEASE READY
普通用户无安全阻碍安装
正式站外分发已完成
```

可以生成 ad-hoc signed 构建做测试，但它不能满足本任务最终的：

```text
“傻瓜式普通用户安装体验”
```

因此缺少正式签名 / notarization 资格时：

```text
V1-T02 = BLOCKED or PARTIAL
```

必须如实报告。

---

# 14. Work Item 8 — Build Final Release App

不要发布 Debug 构建。

目标：

```text
Release build
```

优先 Universal：

```bash
cargo tauri build --target universal-apple-darwin --bundles dmg
```

或者按照当前仓库实际 Tauri 调用方式执行等价命令。

如果不做 Universal，则根据真实架构执行对应 release build。

---

# 15. Work Item 9 — DMG Generation

Tauri DMG 应生成类似：

```text
AI Course Workbench.app
Applications
```

用户打开 DMG 后：

```text
拖 App → Applications
```

要求：

```text
DMG 能正常挂载
App 图标正常
Applications shortcut 正常
产品名正确
无 debug 命名
```

最终对外资产统一重命名为：

```text
AI-Course-Workbench-macOS.dmg
```

注意：

> GitHub “latest direct download” 依赖 asset 文件名稳定，因此不要每个版本改成 `AI-Course-Workbench-v0.1.1.dmg`。

版本信息放在：

```text
Release Tag
Release Title
Release Notes
App bundle metadata
```

而不是下载文件名中。

---

# 16. Work Item 10 — Verify Signing

对最终 `.app` / `.dmg` 做真实检查。

至少检查：

```bash
codesign --verify --deep --strict --verbose=2 "<App>.app"
codesign -dv --verbose=4 "<App>.app"
```

确认：

```text
签名身份正确
bundle id 正确
签名验证成功
```

---

# 17. Work Item 11 — Verify Notarization / Gatekeeper

至少检查：

```bash
spctl --assess --type execute --verbose "<App>.app"
```

如果使用已公证 DMG / App：

```text
确认 Gatekeeper 接受
确认 notarization ticket / stapling 状态符合预期
```

不得只看：

```text
tauri build exit 0
```

就认为公开安装体验成立。

---

# 18. Work Item 12 — Clean-Machine-Style Installation Smoke

必须模拟普通用户路径：

```text
1. 使用最终 DMG
2. 打开 DMG
3. 拖到 Applications
4. 从 Applications 启动
5. 首次启动正常
6. 默认主页干净
7. 新建 / 打开课程入口正常
8. 不加载测试项目
9. Keychain / AI 配置界面正常
10. 关闭 / 再打开正常
```

尽量不要从：

```text
target/
debug/
cargo run
```

路径验证。

必须验证：

```text
/Applications/<Product>.app
```

中的安装后 App。

---

# 19. Work Item 13 — Release Asset Integrity

计算最终 DMG：

```text
SHA-256
文件大小
```

生成：

```text
AI-Course-Workbench-macOS.dmg
AI-Course-Workbench-macOS.dmg.sha256
```

Release Notes 中可提供 SHA-256。

确保：

```text
Release 上传后的下载文件
```

和：

```text
本地最终验证文件
```

SHA-256 一致。

---

# 20. Work Item 14 — Push Repository to GitHub

前提：

```text
Git 状态干净
敏感信息扫描通过
文档状态正确
测试通过
```

然后：

```text
commit
push
```

如果当前还没有远端：

```text
创建 / 绑定 GitHub repository
```

如果已有：

```text
使用现有 origin
```

不得未经判断：

```text
force push
重写主分支历史
删除 tag
覆盖已有 release
```

---

# 21. Work Item 15 — Tag

创建与 App Version 对应的 Tag：

```text
v<version>
```

Tag 必须指向：

```text
已经通过最终 release build 与验收的 commit
```

不要：

```text
先 tag
再修代码
再继续用旧 tag
```

如果修复了代码：

```text
必须重新评估 tag / version
```

---

# 22. Work Item 16 — Create GitHub Release

Release 至少包含：

```text
Release Title
Tag
Release Notes
AI-Course-Workbench-macOS.dmg
AI-Course-Workbench-macOS.dmg.sha256
```

Release Notes 建议：

```text
AI Course Workbench <version>

首个可公开安装的 macOS 分发版本。

System:
- macOS <minimum supported version>
- Architecture: Universal / Apple Silicon（按实际填写）

Install:
1. 下载 AI-Course-Workbench-macOS.dmg
2. 双击打开
3. 将 AI Course Workbench 拖到 Applications
4. 从 Applications 打开

Highlights:
- ...
- ...

Known Limitations:
- ...

SHA-256:
...
```

不要把内部测试报告整段贴给普通用户。

Release Notes 是：

```text
给使用者看的
```

不是：

```text
开发 Completion Report
```

---

# 23. GitHub Release Must Be Downloadable

创建后必须在未登录 / 普通浏览器环境验证：

```text
GitHub Release 页面
```

能够：

```text
看到 Release
看到 DMG
点击下载
成功下载
```

如果 repo 是 private：

```text
必须明确记录：
这不是公开下载
```

不能把登录状态下能下载误判成公共分发已完成。

---

# 24. Work Item 17 — Latest Release Page Link

生成并记录：

```text
https://github.com/<OWNER>/<REPO>/releases/latest
```

用途：

> 用户打开后看到最新版本说明与下载资产。

README 可提供：

```text
Download latest release
```

指向该页面。

---

# 25. Work Item 18 — “傻瓜式” Direct Download Link

正式目标：

```text
https://github.com/<OWNER>/<REPO>/releases/latest/download/AI-Course-Workbench-macOS.dmg
```

这个链接应该：

```text
无需用户先找 Assets
无需判断版本号
每次都下载最新 Release 的 DMG
```

---

# 26. Stable Filename Rule

为了保证上面的链接长期有效：

所有 Release：

```text
v0.1.0
v0.1.1
v0.2.0
...
```

都必须上传：

```text
AI-Course-Workbench-macOS.dmg
```

而不是：

```text
AI-Course-Workbench-v0.1.0-macOS.dmg
AI-Course-Workbench-v0.1.1-macOS.dmg
```

版本号由 Release Tag / App Metadata 表达。

---

# 27. Optional Human-Friendly Short Link

本轮不强制。

如果 GitHub direct URL 仍然太长，未来可以额外提供：

```text
download.<your-domain>
```

或：

```text
<your-domain>/download
```

然后做：

```text
302 Redirect
→ GitHub latest direct download
```

但：

> 本轮只要 GitHub 固定 latest-download URL 工作，就已经满足“粘贴浏览器回车直接下载”的需求。

不要为了短链接引入新的网站、CDN 或后台系统。

---

# 28. Do NOT Add Auto-Updater in This Task

Tauri 支持 updater，但本轮禁止顺手接入。

原因：

```text
自动更新
```

会额外引入：

```text
Updater signing key
更新 manifest / endpoint
版本匹配
客户端安装流程
密钥长期保管
失败恢复
```

属于新的产品能力。

本任务只解决：

```text
首次下载安装
```

以后真实使用证明有需要，再单独讨论自动更新。

---

# 29. Release Automation Boundary

允许：

```text
使用现有 GitHub Actions
或
新增最小化 release workflow
```

前提：

```text
它只是自动构建 / 签名 / notarize / 上传 Release Asset
```

不要顺手扩展成：

```text
多平台构建
Windows
Linux
自动更新服务
Nightly Channel
Beta Channel
复杂 Release Matrix
```

---

# 30. Recommended GitHub Actions Direction

如果采用 GitHub Actions：

优先使用：

```text
Tauri 官方推荐的 tauri-action
```

Secrets 中保存：

```text
Apple signing / notarization credentials
GitHub token（优先使用 workflow 自带权限）
```

要求：

```text
任何 Apple 私钥 / Password / Token 不得写入 workflow YAML 明文
```

---

# 31. Security Checklist Before Public Push

必须搜索：

```text
API Key
Bearer
Token
Secret
Password
APPLE_
private key
.p8
.p12
certificate export
测试凭据
用户本地绝对路径
用户真实课程内容
```

同时人工检查：

```text
.gitignore
Git history
README examples
logs
fixture
screenshots
```

如果敏感信息已经进入历史：

> **不能只删当前文件后直接 public push。**

必须先处理 Git history / secret rotation。

---

# 32. README Update After Public Release

README 最终至少加入：

```text
## Download

Latest macOS release:
<GitHub latest release page>

Direct download:
<GitHub latest DMG direct-download link>
```

并明确：

```text
System requirement
Architecture
Installation steps
```

不要让 README 仍然只告诉普通用户：

```bash
cargo build
deno task ...
```

开发者运行方式可以保留，但需要和：

```text
普通用户下载
```

明显分开。

---

# 33. MASTER CONTROL Update

任务开工：

```text
CURRENT VERSION
V1 (ACTIVE)

CURRENT TASK
V1-T02 — macOS Distribution & Public Release Closure

CURRENT STATUS
IN PROGRESS
```

任务成功：

```text
CURRENT VERSION
V1 (ACTIVE)

CURRENT TASK
V1-T02 — macOS Distribution & Public Release Closure

CURRENT STATUS
VERIFIED

PRODUCT STATE
DOGFOOD READY

DISTRIBUTION STATE
PUBLIC RELEASE READY

NEXT ACTION
PAUSE FEATURE DEVELOPMENT
```

不要自动创建：

```text
V1-T03
```

---

# 34. Definition of Done

只有全部满足，才允许：

```text
V1-T02 = VERIFIED
```

---

## 34.1 Documentation

```text
[ ] README 与 MASTER CONTROL 状态一致
[ ] V1-T01 保持 VERIFIED
[ ] README 不再写“继续 V1-T01”
[ ] README 有普通用户下载入口
```

---

## 34.2 Repository Safety

```text
[ ] git status 清楚
[ ] 未跟踪文件已判断
[ ] 无测试 / 调试生成物误提交
[ ] 无用户真实课程数据误提交
[ ] 无 API Key / Token / Apple 凭据
[ ] Public push 前完成敏感信息检查
```

---

## 34.3 macOS App

```text
[ ] Release build 成功
[ ] 最终 App productName 正确
[ ] Bundle Identifier 正确
[ ] Version 正确
[ ] 图标正确
[ ] 无 Debug / Test 痕迹
```

---

## 34.4 Architecture

```text
[ ] 明确最终支持 Apple Silicon / Intel / Universal
[ ] 如果目标是 Universal，真实构建并验证 universal-apple-darwin
[ ] Release Notes 与真实架构一致
```

---

## 34.5 Signing

```text
[ ] Developer ID Application 签名成功
[ ] codesign verify 通过
[ ] 明确 signing identity
[ ] 签名私钥 / 证书未进入 Git
```

---

## 34.6 Notarization

```text
[ ] Apple notarization 成功
[ ] Gatekeeper assessment 通过
[ ] stapling / notarization 状态符合正式分发要求
[ ] notarization credentials 未进入 Git
```

---

## 34.7 DMG

```text
[ ] 正式 DMG 生成成功
[ ] DMG 可正常打开
[ ] App → Applications 安装体验正常
[ ] 从 /Applications 启动成功
[ ] 首次启动为干净默认主页
```

---

## 34.8 Runtime Smoke

```text
[ ] 安装后的 App 可以启动
[ ] 新建课程入口可用
[ ] 打开项目入口可用
[ ] 不加载测试项目
[ ] 关闭 / 重启正常
[ ] 不依赖 target/debug 运行
```

---

## 34.9 GitHub

```text
[ ] 代码 / 对应仓库内容已 push
[ ] release commit 清楚
[ ] tag 已创建并 push
[ ] GitHub Release 已创建
[ ] Release Notes 已填写
```

---

## 34.10 Release Assets

```text
[ ] AI-Course-Workbench-macOS.dmg 已上传
[ ] .sha256 已上传
[ ] GitHub 下载后的 SHA-256 与本地一致
```

---

## 34.11 Public Access

```text
[ ] Release 页面在目标用户条件下可访问
[ ] 用户可从 Release Assets 下载
[ ] 如果目标是公开分发，未登录浏览器也能下载
```

---

## 34.12 Stable Links

```text
[ ] /releases/latest 正确指向当前 Release
[ ] /releases/latest/download/AI-Course-Workbench-macOS.dmg 可直接下载
[ ] DMG asset filename 已固定
[ ] README 已记录两个下载入口
```

---

## 34.13 Project Control

```text
[ ] BLOCKER = NONE
[ ] README 已回写
[ ] PROJECT_MASTER_CONTROL.md 已回写
[ ] Change Log 已追加
[ ] V1-T02 = VERIFIED
[ ] NEXT ACTION = PAUSE FEATURE DEVELOPMENT
[ ] 没有自动创建 V1-T03
```

---

# 35. BLOCKER Definition

以下任意一项出现，不允许宣称：

```text
PUBLIC RELEASE READY
```

包括：

```text
签名失败
notarization 失败
Gatekeeper 拒绝
最终 DMG 无法打开
安装后 App 无法启动
Release Asset 下载损坏
公开链接需要未说明的 GitHub 权限
下载后 SHA-256 不一致
仓库包含密钥 / 私有凭据
```

---

# 36. Acceptable Backlog

以下事项不阻塞本任务：

```text
App Store 上架
PKG 安装器
Homebrew
自动更新
自定义下载网站
自定义短域名
Windows Release
Linux Release
Nightly / Beta Channel
下载统计面板
```

---

# 37. Special Case — No Paid Apple Developer Account

如果用户当前没有可以用于 Developer ID + notarization 的 Apple Developer 条件：

不要假装任务完成。

可以交付：

```text
代码已 push
DMG 可构建
GitHub Release draft / test asset
直接下载链路结构已准备
```

但最终状态必须是：

```text
PARTIAL / BLOCKED

BLOCKER:
缺正式 macOS signing / notarization credentials
```

并明确：

> 获取正确 Apple Developer 分发资格后，只需要继续完成签名、公证、最终 Release 上传与 smoke，不需要重新开发 Workbench 本体。

---

# 38. Completion Report Template

```text
# Task Completion Report — V1-T02

## 1. Control Position

Version:
Task:
Previous Status:
Current Status:
Distribution State:

## 2. Original Goal

...

## 3. Documentation Closure

README:
MASTER CONTROL:

## 4. Git / Repository

Remote:
Branch:
Commit:
Tag:
Visibility:
Sensitive data check:

## 5. macOS Packaging

App Version:
Bundle ID:
Architecture:
Release build:
DMG:
DMG size:
SHA-256:

## 6. Signing

Developer ID:
codesign verification:

## 7. Notarization

Notarization:
Stapling:
Gatekeeper:

## 8. Installation Smoke

DMG open:
Drag to Applications:
Launch from /Applications:
Fresh start:
Basic open/create:

## 9. GitHub Release

Repository:
Tag:
Release:
Asset:
Checksum:

## 10. Download Links

Latest Release Page:
Direct Latest DMG:

## 11. Public Access Test

Logged-out test:
Direct-download test:
Downloaded SHA-256:

## 12. Open Blockers

...

## 13. Backlog

...

## 14. MASTER CONTROL UPDATE

Updated / Not Updated

## 15. Final State

V1-T02:
Distribution State:

## 16. NEXT ACTION

PAUSE FEATURE DEVELOPMENT
```

---

# 39. Final Success Experience

本任务最终真正要实现的用户体验：

```text
朋友收到一个链接
↓
粘贴到 Safari / Chrome
↓
回车
↓
AI-Course-Workbench-macOS.dmg 开始下载
↓
双击 DMG
↓
拖 AI Course Workbench 到 Applications
↓
打开
↓
系统不提示“应用已损坏 / 开发者无法验证”
↓
进入干净的 Workbench 默认主页
↓
开始自己的课程项目
```

这才算：

```text
PUBLIC RELEASE READY
```

---

# 40. Official References for Agent

GitHub latest release / latest asset download:
https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases

GitHub Release Assets:
https://docs.github.com/en/rest/releases/assets

Tauri Distribution:
https://v2.tauri.app/distribute/

Tauri DMG:
https://v2.tauri.app/distribute/dmg/

Tauri macOS signing / notarization:
https://v2.tauri.app/distribute/sign/macos/

Tauri GitHub pipeline:
https://v2.tauri.app/distribute/pipelines/github/

Tauri CLI / universal macOS target:
https://v2.tauri.app/reference/cli/
