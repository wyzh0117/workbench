# AI Course Workbench — M1 当前阶段闭环文档
## Desktop Usability Closure · Final Closure

> 适用阶段：M1 最终收口  
> 用途：直接交给 Agent 继续执行  
> 核心原则：**不新增大功能，只补齐真实桌面运行、项目安全与最终 E2E 验收。**

---

# 1. 当前状态一句话结论

AI Course Workbench 的 M1 主体能力已经基本实现：

- Web 端仍可正常使用；
- Desktop Native 主体代码已经接入；
- 系统选择器已经实现；
- 素材导入、checksum、Asset / Usage 已实现；
- 当前课程导出已实现；
- 恢复安全机制已实现；
- AssetUsage 语义已经统一；
- `deno task check` / `deno task test` 已通过；
- 当前共 78 tests 通过。

但 **M1 仍未正式关闭**。

原因只有三个核心点：

1. **真实 Tauri Desktop 尚未编译运行验证**
2. **Project Lock 尚未闭环**
3. **External Modification Detection 尚未闭环**

因此当前阶段不是继续做新功能，而是：

> **把已经写好的 Desktop 能力真正跑起来，并完成最后的项目安全与真实端到端验收。**

---

# 2. 当前架构继续保持不变

不得因为当前进入桌面收口而重构整体架构。

继续保持：

```text
src/domain/
    Canonical schema
    确定性业务规则

src/service/
    存储
    恢复
    错误
    诊断
    搜索
    连接器
    导入导出
    高层命令

src/ui/
    UI contract
    Grid / layout calculation

app/
    Web UI

src-tauri/
    Native bridge only
```

核心原则：

```text
project.json = Canonical Truth
```

SQLite、索引、缓存、日志、缩略图、AI 对话缓存等都只能是：

```text
可重建
可丢失
非唯一事实来源
```

---

# 3. 当前 Desktop 的真实状态

当前 Desktop 不是“没有实现”，而是：

> **实现已经写入代码，但尚未完成真实 Native Runtime 验证。**

当前主要实现位置：

```text
src-tauri/src/lib.rs
app/main.js
```

目前已经具备的 Desktop 主体能力：

```text
系统文件 / 文件夹选择器
素材导入
checksum
Asset / Usage
课程导出
恢复安全
```

但是当前机器缺少 Rust 工具链，因此此前没有完成：

```text
Rust compile
Cargo build
Tauri runtime
Native picker actual run
Desktop drag & drop actual run
真实 Desktop E2E
```

因此：

> “代码已实现” ≠ “Desktop 已验收完成”

---

# 4. 当前阶段唯一目标

本轮唯一目标：

# M1 Final Closure

最终完成以下闭环：

```text
安装 / 确认 Rust & Tauri 环境
        ↓
真实启动 Desktop App
        ↓
打开真实项目
        ↓
Project Lock
        ↓
编辑课程
        ↓
导入 / 拖入素材
        ↓
Autosave
        ↓
关闭应用
        ↓
重新启动
        ↓
重新打开项目
        ↓
恢复所有内容
        ↓
检测外部修改
        ↓
执行 Recovery
        ↓
导出 Markdown / HTML
        ↓
完整 E2E 通过
        ↓
M1 CLOSED
```

---

# 5. Priority 0：先让 Desktop 真正启动

这是当前最高优先级。

Agent 不应继续假设 Native 已经可用。

首先必须检查并补齐：

```text
Rust
Cargo
Tauri prerequisites
```

至少验证：

```bash
rustc --version
cargo --version
```

然后检查当前项目实际已有的 task。

优先执行项目现有脚本，不要凭空创造新的启动方式。

例如先检查：

```bash
deno task
```

如果存在类似：

```text
tauri
desktop
dev:desktop
tauri:dev
```

则优先使用项目已有 task。

如果没有包装 task，再根据当前 Tauri 配置执行对应 Native dev 命令。

---

# 6. Desktop Runtime 验收

必须实际启动桌面应用。

不能只做到：

```text
cargo check
```

必须达到：

```text
AI Course Workbench Desktop
真正启动
```

验证：

- App 可以启动；
- 页面不是白屏；
- Web UI 正常挂载；
- Native bridge 正常初始化；
- Tauri command 能正常调用；
- 系统文件选择器真实弹出；
- 没有权限错误；
- 没有 command mismatch；
- 没有路径错误；
- 没有 Rust panic。

---

# 7. Project Lock

当前尚未完成。

## 目标

防止同一个项目被两个 Workbench 实例同时写入。

---

## 7.1 正常打开

```text
Open Project
   ↓
Check Lock
   ↓
No Lock
   ↓
Acquire Lock
   ↓
Load Project
```

---

## 7.2 第二实例

当另一个实例尝试打开同一个项目：

```text
Detect Existing Lock
```

不得：

```text
静默进入可写状态
```

至少应：

```text
阻止写入
或
只读进入
或
明确提示用户
```

具体行为优先遵循当前项目已有设计。

不要额外创造复杂协作系统。

---

## 7.3 正常关闭

```text
Close Project
   ↓
Flush Save
   ↓
Release Lock
```

---

## 7.4 stale lock

必须处理：

```text
应用崩溃
电脑关机
进程异常退出
```

导致的旧锁。

不能让一个项目因为 stale lock 永久打不开。

---

# 8. External Modification Detection

当前尚未完成最终闭环。

典型场景：

```text
Workbench 已打开 project.json
        ↓
外部 Agent / 编辑器 / Git 修改 project.json
        ↓
Workbench 内存仍是旧状态
```

Workbench 不能继续：

```text
旧内容
 ↓
直接覆盖磁盘新内容
```

---

## 8.1 最低要求

检测：

```text
磁盘版本是否在 Workbench 打开后发生变化
```

发现变化后：

```text
External Change Detected
```

必须停止静默覆盖。

---

## 8.2 用户可见处理

至少支持现有能力中的：

```text
Reload
Diff
Merge
Keep Current with explicit confirmation
```

如果当前项目已经具备：

```text
三方合并预览
外部修改差异
```

必须优先复用。

禁止重新创建第二套 conflict system。

---

# 9. Asset Desktop 实测

当前 Asset 主体已经实现，但必须做真实 Desktop 验收。

至少测试：

```text
Image
GIF
Video
Markdown
```

---

## 9.1 系统选择器导入

流程：

```text
Import Asset
    ↓
Native File Picker
    ↓
真实文件
    ↓
Asset
    ↓
checksum
    ↓
Usage
    ↓
Canonical Save
```

验证：

- 文件真实存在；
- checksum 正常；
- Asset 创建正常；
- Usage 正常；
- 引用关系正常；
- 重启后仍然有效。

---

## 9.2 Drag & Drop

真实 Tauri App 中测试：

```text
Image → Workbench
GIF → Workbench
Video → Workbench
Markdown → Workbench
```

验证：

```text
拖入
 ↓
识别
 ↓
导入
 ↓
Asset
 ↓
Usage
 ↓
保存
 ↓
重启
 ↓
仍可恢复
```

---

# 10. 编辑持久化验收

在一个真实课程项目中修改：

```text
Block
Section
Requirement
Flow
Grid
Asset Usage
六维状态
Placeholder
Block 顺序
```

等待 Autosave。

随后：

```text
关闭 App
 ↓
重新启动
 ↓
重新打开同一项目
```

必须保持一致。

不得出现：

```text
正文存在但 Grid 丢失
素材存在但 Usage 丢失
Requirement 丢失
Placeholder 丢失
结构视图和正文不同步
```

---

# 11. Recovery 验收

模拟：

```text
异常退出
未完成保存
存在 recovery log
```

重新启动后：

```text
Detect Recovery
      ↓
Preview
      ↓
Restore
```

必须保留：

```text
Restore Before Backup
```

要求：

> Recovery 操作本身不能造成新的数据损失。

---

# 12. Export 验收

本轮只验收已经存在的核心导出。

必须完成：

```text
Markdown
HTML
```

真实 Desktop 流程：

```text
Export
 ↓
Native Save Picker
 ↓
选择保存位置
 ↓
生成文件
 ↓
手动打开验证
```

确认：

- 文件生成成功；
- 内容完整；
- 路径安全；
- Asset 引用正常；
- 没有关键内容缺失。

---

# 13. 最终 Desktop E2E

M1 最终必须至少跑通一次以下真实流程：

```text
1. Launch Desktop App

2. Open Project

3. Acquire Project Lock

4. Open Lesson

5. Edit Block

6. Edit Requirement

7. Import Image

8. Import GIF

9. Import Video

10. Import Markdown

11. Test Drag & Drop

12. Modify Flow / Grid

13. Autosave

14. Close App

15. Restart App

16. Reopen Project

17. Verify All Persistence

18. Simulate External Modification

19. Verify Detection / Diff / Merge

20. Simulate Recovery

21. Verify Restore Safety

22. Export Markdown

23. Export HTML

24. Close Project

25. Verify Lock Release
```

---

# 14. M1 最终验收标准

## Runtime

- [ ] Rust 可用
- [ ] Cargo 可用
- [ ] Tauri 可编译
- [ ] Desktop App 可启动
- [ ] Native command 可调用
- [ ] 原生选择器可用

## Project Lifecycle

- [ ] Open Project
- [ ] Close Project
- [ ] Switch Project
- [ ] Save
- [ ] Autosave
- [ ] Restart
- [ ] Reopen
- [ ] Recovery

## Project Lock

- [ ] Acquire Lock
- [ ] Existing Lock Detection
- [ ] Multi-instance Protection
- [ ] Release Lock
- [ ] stale lock handling

## External Change

- [ ] Detect external modification
- [ ] No silent overwrite
- [ ] Reload
- [ ] Diff
- [ ] Merge / existing resolution path

## Asset

- [ ] Image
- [ ] GIF
- [ ] Video
- [ ] Markdown
- [ ] File Picker
- [ ] Drag & Drop
- [ ] checksum
- [ ] Asset
- [ ] Usage
- [ ] Reopen persistence

## Export

- [ ] Markdown
- [ ] HTML
- [ ] Native Save Picker
- [ ] exported files verified

## Regression

- [ ] `deno task check`
- [ ] `deno task test`
- [ ] 当前 78 tests 继续通过
- [ ] Project Lock tests
- [ ] External Change tests
- [ ] Desktop integration / E2E coverage
- [ ] Web 端继续可用

---

# 15. 本轮明确禁止新增

M1 Closure 阶段不要做：

```text
新 AI Provider
新课程地图
新课程 Schema
新 Grid Engine
新素材管理系统
新发布平台
微信一键发布
PDF Renderer
PNG Renderer
新数据库架构
SQLite Canonical 化
大型 UI 重构
大型目录重构
新的后台 Agent 系统
```

这些不是当前阶段问题。

---

# 16. 本轮禁止“顺手重构”

Agent 必须遵守：

```text
能修复，不重写
能复用，不重造
能 Adapter，不复制业务逻辑
能保持兼容，不修改 Schema
```

发现非 M1 问题：

```text
记录
 ↓
不展开
 ↓
放入后续 Milestone
```

---

# 17. 不得删除已有能力

任何：

```text
删除
废弃
重命名
Schema 修改
行为变化
```

都必须在最终报告中说明：

```text
原功能：
变更：
原因：
兼容性影响：
迁移方式：
```

如果没有删除：

```text
删除功能：无
```

---

# 18. Agent 本轮任务 Prompt

## TASK — M1 FINAL CLOSURE

继续完成 AI Course Workbench 的 M1 Desktop Usability Closure。

已完成：

```text
Desktop Native 主体实现
Native Picker
Asset Import
checksum
Asset / Usage
Course Export
Recovery Safety
Web compatibility
AssetUsage unification
78 tests passing
```

尚未完成：

```text
Real Tauri Runtime Validation
Project Lock
External Modification Detection
Real Desktop E2E
```

本轮只能完成这些 Closure 工作。

优先级：

```text
P0 真实启动 Tauri Desktop
P1 Project Lock
P2 External Modification Detection
P3 Desktop E2E
P4 Regression Verification
```

禁止扩大功能范围。

---

# 19. 最终报告格式

Agent 完成后必须输出：

```text
# M1 Closure Report

## Final Status

M1:
PASS / FAIL

Desktop Runtime:
PASS / FAIL

Project Lock:
PASS / FAIL

External Modification:
PASS / FAIL

Desktop E2E:
PASS / FAIL

## 本轮完成

...

## 新增功能

...

## 修改功能

...

## 删除功能

无 / 明细

## 修改文件

...

## Tests

...

## Desktop E2E

...

## Known Issues

...

## 是否可以进入 M2

YES / NO

原因：
...
```

---

# 20. 进入 M2 的硬条件

必须同时满足：

```text
Desktop 真实启动成功
+
Project Lock 完成
+
External Modification Detection 完成
+
完整 Desktop E2E 通过
+
现有 tests 无回归
```

只要有任意一项失败：

```text
M1 = NOT CLOSED
```

不得开始 M2。

---

# 21. M1 完成后的下一阶段

M1 正式关闭后才进入：

# M2 — Course Authoring UX

届时再优化：

```text
单课编辑器
结构视图
左中右三栏
正文 / 结构联动
Flow
Grid
素材可视化
Placeholder
Requirement
待补
Preview
完成度
快速跳转
```

M2 的问题是：

> 如何让一节课制作得更快、更顺手。

当前 M1 的问题是：

> Workbench 是否已经是一款真正可靠的桌面软件。

不要混淆两个阶段。

---

# 22. 本阶段最终判断

当前最重要的认识：

> **Workbench 的 Desktop 代码主体已经有了，但它还没有完成真实世界验证。**

因此现在不要继续问：

> “还能加什么功能？”

而应该只问：

> “这款软件现在是否已经能够真正启动、打开项目、编辑、导入、保存、重开、恢复并导出？”

只有答案是：

```text
YES
```

而且经过真实 Desktop E2E 证明，

M1 才正式结束。
