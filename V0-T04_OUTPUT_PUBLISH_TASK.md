# V0-T04 — Output & Publish
## Agent Task Card / V0 最终收口任务

> 本任务卡是 `PROJECT_MASTER_CONTROL.md` 的执行附件，不替代总控。
> 如本任务卡与总控冲突，以 `PROJECT_MASTER_CONTROL.md` 为唯一事实来源。

---

# 0. Control Position

```text
Project: AI Course Workbench
Version: V0
Task: V0-T04 — Output & Publish
Start Condition: V0-T01 / V0-T02 / V0-T03 均已 VERIFIED
Current Master State: V0-T04 READY / 尚未正式开工
Target End State: V0-T04 VERIFIED → V0 CLOSED
```

本任务是 **V0 唯一剩余任务**。

不得创建：

```text
V0-T04-A
V0-T04.1
M5
V0-T05
Publish Phase 2
```

如需多轮完成，仍全部属于 `V0-T04`。

---

# 1. 开工前强制动作

Agent 开始编码前必须：

1. 完整阅读 `PROJECT_MASTER_CONTROL.md`。
2. 完整阅读 `README.md`。
3. 检查当前 Git 状态、分支、未提交修改与最近提交，确认上一任务的改动不会与本轮混杂。
4. 盘点当前已有输出实现，不假设“已有 Markdown / HTML / SVG / 项目包”就等于已经满足 T04。
5. 找出当前输出链涉及的 Domain / Service / Desktop / Web / UI / tests / renderer / exportPreflight / publish record 代码。
6. 在真正改代码前，先明确并记录：

```text
当前 Version = V0
当前 Task = V0-T04 — Output & Publish
本任务 DoD = 本文 §10
下一步 = 只有 V0-T04 VERIFIED 后才允许 V0 CLOSED
```

开工时将总控中的 V0-T04 状态切换到 `IN PROGRESS`；不要提前改为 DONE / VERIFIED。

---

# 2. Original Goal

V0-T04 的目标不是“再增加几个导出按钮”。

真正目标是：

> **让 Workbench 中已经完成或正在维护的真实课程，能够从 Canonical 内容稳定、可理解、可重复地迁移到真实课程和内容发布场景，而不破坏源项目、不形成第二套课程真相。**

用户最终应能完成：

```text
打开真实课程
    ↓
进入预览 / 发布
    ↓
选择输出范围与目标格式
    ↓
查看导出前检查
    ↓
理解哪些问题会阻止发布、哪些只是提醒
    ↓
生成稳定输出
    ↓
在系统中找到实际文件 / 文件夹
    ↓
直接打开检查
    ↓
迁移到网页 / 微信类富文本 / 课程使用场景
    ↓
返回 Workbench 后 Canonical 内容保持不变
```

---

# 3. 核心设计原则

## 3.1 Canonical 只做内容真相，不做平台格式真相

必须保持：

```text
project.json / Canonical
        ↓
统一 Publish Projection / Render Input
        ↓
各输出 Adapter / Renderer
        ↓
Markdown / Semantic HTML / Web Package / PDF / 迁移输出
```

禁止：

- 为微信公众号、网页、PDF 等直接往 Canonical 写平台 CSS / 富文本 HTML。
- 为了导出方便修改正文、Block、Requirement、AssetUsage 或 Layout 的原始语义。
- 为不同输出格式维护多套互相漂移的课程内容副本。

导出 / 发布过程默认必须是 **只读地消费 Canonical**。

---

## 3.2 统一输出投影，避免每个格式各自重新理解项目

优先复用并收口现有投影 / preview / export 逻辑，形成一个清晰的发布输入边界。

至少统一表达：

- course / lesson / section / block 顺序；
- 标题层级与正文语义；
- Flow / Grid 当前有效布局信息；
- Asset 与 AssetUsage；
- image / GIF / video / audio / Markdown / document / attachment 的语义；
- Requirement / Placeholder 的发布状态；
- 外部引用与本地素材引用；
- 必要的元数据（课程名、课次名、生成时间、输出范围等）。

不得为了“统一”而重构 T01/T02/T03 已 VERIFIED 的 project lifecycle、authoring 或 AI 架构。

---

## 3.3 预览与导出不能成为两套结果

Workbench 内部 Preview 与最终输出应尽可能消费同一语义投影 / 渲染规则。

验收重点不是像素完全一致，而是：

```text
内容顺序一致
素材引用一致
正文不重复
Placeholder 不误入正式正文
Flow / Grid 语义不丢
未使用素材不凭空进入导出
已使用素材不丢失
```

---

# 4. 本任务必须完成的范围

## 4.1 现有输出能力审计与收口

首先盘点并真实运行目前已有：

```text
Markdown
HTML
SVG / 分区导出
Project JSON
素材包
完整项目包
exportPreflight
publish/export record（如当前实现存在）
```

对每一种现有能力明确：

```text
入口在哪里
输出范围是什么
是否包含素材
是否读取 Canonical
是否会改 Canonical
Web / Desktop 是否一致
当前已知缺陷
是否继续保留
```

原则：**能修就修，能复用就复用，不重新造一套同功能导出系统。**

---

## 4.2 Export / Publish Preflight

把现有“导出前检查”收口成真正可用的发布门禁。

至少检查：

- Canonical 是否可读取 / 可校验；
- 缺失的本地素材文件；
- 悬空 Asset / AssetUsage / Block 引用；
- 未完成 Requirement / Placeholder；
- 外部引用；
- Flow / Grid 超出画布或明显布局异常；
- 文字溢出 / 未加载字体（若现有系统已能判断）；
- 当前输出格式不支持或只能降级表达的媒体类型。

必须区分：

### BLOCKING

会生成损坏或不可理解输出的问题，例如：

```text
引用素材文件不存在
关键引用断链
导出目标路径不可写
Canonical 无法通过必要校验
```

BLOCKING 存在时不得假装导出成功。

### WARNING

不会破坏文件，但用户应该知道的问题，例如：

```text
仍有待补 Requirement
存在外部链接
PDF 中视频只能降级为附件/链接卡片
某些布局在线性 Markdown 中会降级
文字可能溢出
字体回退
```

WARNING 可允许用户明确确认后继续。

UI 必须用用户能理解的语言说明“发生什么 / 是否能继续 / 继续后会怎样”。

---

## 4.3 输出范围

V0 至少支持两种可理解范围：

```text
当前课 / 当前 Lesson
整门课程 / Full Course
```

如现有架构已有更细粒度分区导出，可继续保留，但不要为了 T04 再扩展复杂范围系统。

输出范围在 UI、文件名、manifest / metadata 中必须明确。

---

## 4.4 Markdown 输出

将已有 Markdown 从“能导出”收口到“真实可迁移”。

至少保证：

- 标题层级清楚；
- 正文顺序正确；
- 图片使用稳定的相对引用；
- GIF 仍作为 GIF 资源引用，不静态替换；
- video / audio / document 不伪装成图片；
- 无法内嵌的媒体使用明确的附件 / 链接表达；
- Markdown 内容不会重复列出已经内联在正文中的素材；
- Placeholder / 未完成 Requirement 不默认混进正式正文；
- 当前课和整门课程导出均可理解；
- 中文文件名、空格、特殊字符不会破坏引用。

不得把机器内部路径直接暴露为最终用户必须手动修正的链接。

---

## 4.5 Semantic HTML 输出

HTML 是 V0 发布链的核心格式之一。

必须形成 **语义化、可独立打开、可迁移** 的 HTML，而不是简单把当前 UI DOM dump 出去。

至少要求：

- 使用合理的 `main / article / section / h1-h6 / p / ul / ol / figure / figcaption` 等语义结构；
- 不依赖 Workbench 运行时 JS 才能阅读正文；
- 样式与内容分层，但导出包本身必须能独立打开；
- image / GIF 正常显示；
- video / audio 使用正确媒体元素或明确降级卡片；
- Markdown / 文档类素材按当前产品语义渲染或作为附件卡片；
- 所有本地资源路径在导出后可解析；
- 不带 API Key、AI 执行记录、诊断日志、锁文件、session、`.workspace` 私有数据；
- 不把编辑控件、按钮、待补操作 UI 导出到正文。

---

## 4.6 Static Web Package

在 Semantic HTML 基础上提供一个真正可搬走的静态网页输出。

推荐结构可类似：

```text
<course-name>-web/
  index.html
  assets/
  ...必要样式文件
  manifest.json（如确有价值）
```

要求：

- 整个目录复制到别处后仍可打开；
- 不依赖原项目绝对路径；
- 不依赖 Workbench 正在运行；
- 不引用 `.workspace`；
- 素材只复制实际需要的内容，或明确说明采用何种稳定策略；
- 文件名冲突、非法字符、路径穿越得到处理；
- 同一份课程重复导出时行为可预测，不随机丢资源。

V0 不要求自动上传服务器或生成公网 URL。

---

## 4.7 PDF 输出

V0-T04 应提供一个面向“交付 / 阅读 / 留档”的稳定 PDF 输出路径。

目标是可靠，不要求桌面出版级排版系统。

至少要求：

- 当前课和/或整门课程按明确范围生成；
- 标题、正文、图片正常；
- Flow / Grid 不应导致正文丢失；
- GIF 在 PDF 中可合理降级为静态代表帧 / 附件说明，不得变成破图；
- video / audio 使用明确的不可交互降级表示（标题、文件名、链接或附件提示）；
- 分页不能把内容直接截没；
- 中文文字可正常显示；
- 输出文件可被系统 PDF 阅读器实际打开。

如当前技术栈已有稳定打印 / PDF 路径，优先复用；不要为了 PDF 引入重量级独立渲染平台。

---

## 4.8 PNG / 图片输出边界

总控提出“必要的 PNG”，这里按 V0 的最小必要范围执行：

- 如果现有 SVG / 分区渲染已经自然支持 PNG，则补齐并验证 PNG；
- 如果某个真实迁移场景必须靠图片才能保真，则实现对应页面 / 分区 PNG；
- **不要求**为整门课程打造复杂的长图生成器、海报系统或图片编辑器；
- 不得因此引入新的排版产品线。

若审计后确认 V0 的 Markdown / HTML / Web / PDF 已覆盖实际迁移，而 PNG 没有独立必要性，可以在结项中将“复杂 PNG 系统”明确列为 `REJECTED for V0`，但已有 SVG / 分区导出不得回归。

---

## 4.9 微信 / 富文本迁移

V0 不做公众号自动登录、自动发布、账号授权、扫码、草稿箱 API 或第三方平台自动化。

V0 要解决的是：

> **用户能把 Workbench 里的课程内容可靠搬进微信类富文本编辑场景。**

至少提供一种清晰、可验证的迁移路径，例如：

```text
Workbench
  ↓
微信迁移预览 / 兼容 HTML
  ↓
复制富文本 / 打开导出 HTML 后复制
  ↓
粘贴到目标富文本编辑器
```

要求：

- 标题、段落、列表、图片顺序不乱；
- 样式尽量采用安全、保守、可迁移规则；
- 不依赖 Workbench 私有 class 或脚本；
- 对 GIF / video / audio / document 等不能稳定随复制迁移的内容给出明确提示；
- 不向用户承诺平台一定保留其不受我们控制的所有样式；
- 输出结果应尽量降低“复制后还要人工重新排全文”的成本。

如自动化环境无法真正登录微信后台，可使用一个普通 `contenteditable` / 富文本接收页做复制粘贴结构验证，并在结项中诚实说明“未验证真实微信后台”；这不等于可以跳过迁移格式本身的测试。

---

## 4.10 项目包 / 素材包 / Project JSON 回归

已有：

```text
Project JSON
素材包
完整项目包
```

必须继续可用并做回归。

重点验证：

- 包含范围符合当前定义；
- 不泄漏 AI 密钥；
- 不泄漏 `.workspace` 执行记录 / 诊断私有数据（除非当前已有明确、安全、用户可理解的包含规则）；
- 素材引用可恢复；
- 导出行为不修改原项目；
- 不因为 T04 的新 renderer 破坏 T01/T02 的项目生命周期。

---

## 4.11 Publish / Export UI 闭环

不要只做命令和 service。

真实 Desktop 至少提供完整、可理解的用户流程：

```text
进入 Preview / Publish
    ↓
选择范围
    ↓
选择格式 / 目标
    ↓
运行 Preflight
    ↓
查看 Blocking / Warning
    ↓
确认导出
    ↓
选择或确认输出位置
    ↓
导出
    ↓
显示成功 / 失败原因
    ↓
显示实际输出文件 / 目录
    ↓
可打开 / 可定位结果（在当前平台能力允许的情况下）
```

错误必须可理解，不能只显示：

```text
Export failed
Unknown error
```

至少要说明：

```text
失败在哪一步
是否写出了部分文件
用户下一步可以做什么
```

---

## 4.12 输出的原子性与失败安全

导出不能出现“界面说成功，但目录只有半包”的情况。

优先采用：

```text
临时目录 / 临时文件
    ↓
完整生成
    ↓
必要验证
    ↓
原子替换 / 最终提交
```

如目标格式本身无法做到完全原子，必须做到：

- 不把失败标为成功；
- 清理本轮临时垃圾；
- 不覆盖用户已有有效文件而不提示；
- 不修改 Canonical；
- 失败后可以安全重试。

---

## 4.13 Export / Publish Record

如项目已有发布记录能力，应收口并继续使用，不要另建重复日志系统。

记录至少能回答：

```text
何时导出
导出了哪个项目 / 哪个范围
什么格式
输出到哪里（注意隐私，只保留合理路径信息）
成功 / 失败
Warnings / Blocking 摘要
```

发布记录不能成为课程内容的第二事实来源。

不得记录：

```text
API Key
Provider Secret
不必要的 AI 原始执行正文
系统凭据
```

---

# 5. 媒体输出规则

必须建立统一、可测试的媒体降级规则，而不是每个 renderer 临时处理。

| 媒体 | HTML / Web | Markdown | PDF | 微信类迁移 |
|---|---|---|---|---|
| image | 正常内嵌/相对资源 | 相对图片引用 | 正常图片 | 尽量保留 |
| GIF | 保持 GIF | GIF 相对引用 | 静态代表/明确说明 | 能复制则保留，否则提示 |
| video | `<video>` 或明确卡片 | 链接/附件 | 非交互卡片/链接 | 提示需单独处理 |
| audio | `<audio>` 或明确卡片 | 链接/附件 | 非交互卡片/链接 | 提示需单独处理 |
| Markdown 素材 | 按现有语义渲染 | 合理展开/引用 | 渲染后进入正文 | 迁移渲染结果 |
| PDF/DOCX/其他文档 | 附件卡片/链接 | 附件链接 | 附件说明 | 提示需单独上传/处理 |

实际规则可根据当前代码结构微调，但四个原则不能变：

```text
不丢
不重复
不冒充其他媒体类型
降级时明确告诉用户
```

---

# 6. 明确非目标 / Scope Guard

以下 **不是 V0-T04**：

```text
微信公众号账号登录 / 自动发布
自动上传到任意 LMS / CMS
云托管 / 公网部署平台
复杂主题商城 / 模板市场
多人协作发布审批流
批量跨课程发布
发布定时任务
RAG 发布
Agent 发布平台
Orchestrator
Windows 端适配
移动端发布客户端
版本级内容审计系统
复杂长图 / 海报编辑器
全新的排版引擎
为 T04 重写 T01/T02/T03 lifecycle
```

如发现这些需求：

```text
不阻塞 T04 → BACKLOG / DEFERRED
与产品方向不符 → REJECTED
```

不要顺手做。

---

# 7. 不得回归的已验证能力

T04 的任何改动不得破坏：

## T01

- 项目创建 / 打开 / 保存 / Autosave；
- Recovery；
- Project Lock / stale lock；
- External Modification Detection；
- Finder 拖放与素材导入；
- Desktop / Browser 共用一套产品逻辑。

## T02

- Course Map；
- Lesson Editor；
- 正文 / 结构同步；
- Flow / Grid；
- 素材 Authoring；
- Requirement / Placeholder / 待补；
- Preview；
- 完成状态；
- Close / Restart / Reopen 后继续工作。

## T03

- AI Context Assembly；
- Provider / Connector 边界；
- Suggestion → ChangeDraft → Diff → Review → Apply；
- AI Apply 的 Undo / Redo / Autosave；
- 密钥不进入 Canonical / 导出包 / 诊断包；
- AI 执行记录边界。

特别强调：

> **任何新的项目包 / 发布包都必须再次验证“不含 AI 密钥”。**

---

# 8. 自动化测试要求

不得只靠人工点一下。

至少补齐以下测试面：

## 8.1 Projection / Renderer

- 同一 Canonical 输入生成稳定结构；
- lesson / full-course 范围正确；
- Placeholder / Requirement 规则正确；
- inline asset 不重复；
- Flow / Grid 不丢正文；
- 特殊字符 / 中文文件名 / 空格路径。

## 8.2 Preflight

- missing asset → blocking；
- dangling reference → blocking；
- unresolved requirement → warning；
- external reference → warning；
- unsupported media downgrade → warning；
- clean project → pass。

## 8.3 Markdown / HTML / Web

- 资源路径正确；
- 文件真实存在；
- HTML 可解析；
- web package 搬离项目目录后仍能打开；
- 不引用 `.workspace`；
- 不含 secret。

## 8.4 PDF

- 文件存在且非空；
- 可被 PDF parser / 系统阅读器打开；
- 关键文字存在；
- 图片资源至少一项实际渲染；
- 不因 video/GIF 导致失败。

## 8.5 Failure Safety

- 不可写目录；
- 已存在同名输出；
- 中途 renderer 报错；
- 素材消失；
- 取消（如当前 UI 提供取消）；
- 失败后 Canonical 字节级不变。

## 8.6 Regression

至少继续通过当前项目已有：

```text
deno task check
deno task test
cargo test --offline（或项目当前标准 Rust test 命令）
cargo build --offline（如当前环境采用 offline）
```

并根据项目现有构建脚本完成真实 Tauri bundle build。

---

# 9. 真实验收 / E2E

V0-T04 不能只以自动化测试通过判定 VERIFIED。

至少准备一门真实走查课程，包含：

```text
≥ 2 个 Lesson
普通正文
标题 / 列表等常见结构
Flow / Grid
image
GIF
video 或 audio 至少一种
Markdown 或 document 素材至少一种
1 个未完成 Requirement
1 个外部链接/外部引用（如产品支持）
```

## 9.1 真实 Tauri Desktop 完整走查

在最终构建的真实 Tauri 窗口完成：

```text
1. 启动 / 恢复项目
2. 打开 Preview / Publish
3. 运行 Preflight
4. 确认能区分 Blocking 与 Warning
5. 修复或使用无 Blocking 的测试状态
6. 导出当前课 Markdown
7. 实际打开并核对 Markdown 与素材引用
8. 导出整门课程 Semantic HTML / Web Package
9. 将 Web Package 复制/移动离开原项目目录后实际打开
10. 核对图片 / GIF / video/audio / 文档降级表现
11. 导出 PDF
12. 用系统 PDF 阅读器实际打开并检查关键文字与图片
13. 执行微信/富文本迁移路径，至少完成一次复制→粘贴结构验证
14. 回到 Workbench，确认正文 / Requirement / Layout / AssetUsage 未因导出变化
15. 保存 → 关闭 → 重启 → 项目仍正常
16. 检查 publish/export record（如存在）
17. 检查所有输出包无 API Key / secret / `.workspace` 私有执行记录
18. 检查 Project JSON / 素材包 / 完整项目包回归
```

如某个系统模态对自动化不可驱动，可以像 T02/T03 一样采用真实控件 + AX / 文件落盘复核等方式，但必须诚实记录环境限制，不能把“代码路径存在”写成“真机已验证”。

---

# 10. Definition of Done

只有以下全部满足，才允许：

```text
V0-T04 = VERIFIED
V0 = CLOSED
```

## 10.1 Architecture

```text
[ ] Canonical → Publish Projection / Render Input → Adapter 的边界清楚
[ ] 平台格式未反向污染 Canonical
[ ] Preview / Export 没有形成互相漂移的第二套内容真相
[ ] 未为 T04 重构 T01/T02/T03 已 VERIFIED 生命周期
```

## 10.2 Preflight

```text
[ ] 导出前检查真实可运行
[ ] Blocking / Warning 明确区分
[ ] 缺失素材 / 断链不会被错误标为成功
[ ] 用户能理解 warning 的后果与下一步
```

## 10.3 Core Outputs

```text
[ ] 当前课 Markdown 可真实使用
[ ] 整门课程 Markdown 可真实使用
[ ] Semantic HTML 可独立打开
[ ] Static Web Package 离开原项目目录后仍可打开
[ ] PDF 能生成、打开、阅读
[ ] 现有 SVG / 分区导出无回归
[ ] Project JSON / 素材包 / 完整项目包无回归
```

## 10.4 Media

```text
[ ] image 不丢失
[ ] GIF 不被错误当普通图片或破图
[ ] video/audio 有正确 HTML 表达与非交互格式降级
[ ] Markdown / document 不永久停在错误预览/导出状态
[ ] inline 素材不重复导出
[ ] 未使用素材不会无意义进入正文
```

## 10.5 Real Migration

```text
[ ] 至少一条微信/富文本迁移路径可实际完成
[ ] 复制/粘贴后标题、段落、图片顺序基本正确
[ ] 不承诺平台无法保证的样式保真
[ ] 不做账号登录 / 自动发布也不影响 V0 的迁移目标
```

## 10.6 Safety

```text
[ ] Export 失败不修改 Canonical
[ ] Export 失败不谎报成功
[ ] 不留下误导性的半成品，或半成品被明确标记/清理
[ ] 路径 / 文件名 / 覆盖行为安全
[ ] 导出包不含 API Key / secret
[ ] 导出包不意外包含 AI 执行记录、诊断日志、lock/session 私有文件
```

## 10.7 Runtime

```text
[ ] Web / Service 路径可用
[ ] 真实 Tauri Desktop 可编译
[ ] 最终构建真实 Tauri 窗口完成 §9.1 完整 Output & Publish 走查
[ ] 实际输出文件在系统中可打开
[ ] Close / Restart / Reopen 不回归
```

## 10.8 Automated

```text
[ ] deno task check 通过
[ ] deno task test 全绿
[ ] Rust tests 全绿
[ ] cargo build / Tauri build 通过
[ ] 新增输出 / preflight / failure-safety 回归测试
```

## 10.9 Project Control

```text
[ ] BLOCKER = NONE
[ ] README 已同步“当前真实支持的输出能力 / 限制”
[ ] PROJECT_MASTER_CONTROL.md 已按 §21 回写
[ ] V0 Task Board: V0-T04 = VERIFIED
[ ] §16 更新为真实完成内容、证据、限制与 DoD 对照
[ ] §17 更新为 V0 CLOSED
[ ] §22 Change Log 追加本次状态变化
[ ] §29 NEXT ACTION 不再指向 V0-T04
[ ] §30 总控摘要同步
```

---

# 11. V0 关闭规则

T04 VERIFIED 后，才允许把：

```text
V0-T01 VERIFIED
V0-T02 VERIFIED
V0-T03 VERIFIED
V0-T04 VERIFIED
```

汇总为：

```text
V0 = CLOSED
```

注意：

- **不要在同一轮顺手拆 V1。**
- T04 验收结束只负责关闭 V0，并把下一步写成“制定 / 启动 V1 规划”这一类唯一动作；V1 具体任务仍应在 V0 CLOSED 后由用户决定。
- 如果 T04 还有任何 DoD BLOCKER，V0 不得 CLOSED。

---

# 12. BACKLOG / DEFERRED 处理

本轮开始时顺手检查现有 Backlog 中是否有项目天然属于 T04，例如：

```text
video/document 素材在导出中仍只显示为链接
浏览器壳刷新后阅读位置丢失
两壳 AI 配置存储位置不统一
系统钥匙串适配器
AI 逐字流式 UI
```

判断规则：

- `video/document 导出表达`：属于 T04，纳入本轮。
- `浏览器阅读位置`：不影响 Output & Publish，继续 BACKLOG。
- `AI 配置位置`：不属于 T04，继续 BACKLOG。
- `钥匙串`：不属于 T04，继续 BACKLOG / 后续安全增强。
- `AI 流式 UI`：不属于 T04，继续 DEFERRED。

不要因为 V0 即将关闭，就把所有历史 Backlog 强行清空。

---

# 13. Git / 变更纪律

1. 开工前记录 Git 状态。
2. 不覆盖或丢弃用户现有未提交改动。
3. T04 修改尽量保持聚焦。
4. 如发现 T01/T02/T03 回归，属于当前 T04 的 BLOCKER，必须修复，不创建新任务编号。
5. 任务结束前再次检查 Git diff，确认没有无关大规模格式化或重构。
6. `cargo fmt --check` 若仍只有 T03 报告中已存在的 3 处历史差异，不要为了“顺便清洁”扩大范围；除非本轮修改触及这些文件并必须处理。
7. 是否 commit / merge 依用户当前工作流执行；结项报告必须明确工作区是否干净、是否已经 commit。

---

# 14. 结项报告格式

必须严格按照 `PROJECT_MASTER_CONTROL.md` 的强制模板输出：

```text
# Task Completion Report

## 1. Control Position
Version:
Task:
Previous Status:
Current Status:

## 2. Original Goal

## 3. Completed

## 4. Not Completed

## 5. Completed But Not Good Enough

## 6. New Findings
### BLOCKER
### BACKLOG
### DEFERRED
### REJECTED

## 7. Functional Changes
Added:
Changed:
Removed:

## 8. Verification
Tests:
Runtime:
E2E:
Unverified:

## 9. Remaining Work in Current Task

## 10. Overall Remaining Work
Current version remaining:
Later versions:

## 11. NEXT ACTION

## 12. MASTER CONTROL UPDATE
```

不得只写“完成了”。

尤其必须明确：

```text
真实导出了哪些文件
哪些文件实际打开过
哪些迁移场景实际验证过
哪些只是自动化测试
哪些由于环境原因仍未验证
有没有任何 Canonical 变化
输出包有没有 secret
Git 当前是什么状态
```

---

# 15. Agent 启动口令

可直接将下面这段作为执行指令：

> 先完整阅读 `PROJECT_MASTER_CONTROL.md`、`README.md` 与本任务卡。不要重新规划版本，不要创建新的 Milestone / 子阶段。当前唯一任务是 `V0-T04 — Output & Publish`。先审计现有 Markdown / HTML / SVG / Project JSON / 素材包 / 完整项目包、exportPreflight、publish/export record 与 Preview 的真实实现，再按本任务卡建立稳定的 `Canonical → Publish Projection → Adapter → Artifact` 输出链。重点完成 Markdown、Semantic HTML、Static Web Package、PDF、微信/富文本迁移、媒体降级、Preflight、失败安全与真实 Tauri Desktop E2E；不得污染 Canonical，不得重构 T01/T02/T03 已 VERIFIED 的生命周期，不考虑 Orchestrator 与 Windows。任务结束后严格对照 §10 DoD，完成自动化 + 最终构建真实 Tauri 窗口走查，更新 README 与 `PROJECT_MASTER_CONTROL.md`，并按总控模板输出 Completion Report。只有全部 DoD 满足且 BLOCKER = NONE 时，才允许 `V0-T04 = VERIFIED` 并将 `V0 = CLOSED`。

---

# 16. 最终判定

本任务不是：

> “新增导出格式”。

而是：

> **把 Workbench 从“课程已经能制作、能 AI 协作”，真正收口到“做完之后可以可靠拿出去使用”。**

T04 的价值判断只有一个：

```text
用户做完一门真实课程后，
能不能在不破坏源项目的情况下，
看得懂地检查、稳定地导出、真实地打开、顺利地迁移。
```

如果答案是“能”，且真实 Desktop E2E 与所有 DoD 通过：

```text
V0-T04 = VERIFIED
V0 = CLOSED
```
