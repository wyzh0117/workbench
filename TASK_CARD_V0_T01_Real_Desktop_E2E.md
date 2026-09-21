# Task Card — V0-T01 Real Desktop E2E Closure

> **Parent Task:** `V0-T01 — Desktop 基础闭环`  
> **Version:** `V0`  
> **Current Status:** `IN PROGRESS`  
>
> 本 Task Card 只是 `V0-T01` 内部工作包，不是新的版本、Milestone 或子阶段。
>
> 开工前必须先完整阅读目标仓库中的：
>
> 1. `PROJECT_MASTER_CONTROL.md`
> 2. `README.md`
> 3. 本 Task Card
>
> 不得进入 `V0-T02`，不得自行创建新的 V/M/N/Phase 层级。
>
> 本轮不要直接修改 `PROJECT_MASTER_CONTROL.md`；结项报告中只给出建议状态，由后续统一回写。

## Codex / Pi 强制指令

如果当前执行者是 **Codex 或 Pi**，以下内容视为强制执行要求：

> 注意你的主要任务是分析、编排和验证，具体任务尽可能交给 subagent（luna max）去执行。自己只做需求澄清、方案拆解、任务分发和结果验收，实现类工作（读大量代码、写代码、跑测试、批量修改）一律用 Agent 工具派给 subagent 执行。

## 强制自验收

代码实现结束后，不得立即提交结项。

执行 Agent 必须先切换为 **Self Reviewer**，重新完成一次自验收：

```text
1. 对照 Definition of Done 逐项检查
2. 查看 git diff / changed files，确认没有越界修改
3. 重新运行全部要求测试
4. 重新执行真实运行 / 手动复现步骤
5. 检查是否破坏已有 VERIFIED 能力
6. 检查是否出现 silent fallback / 假成功
7. 明确区分：
   - VERIFIED
   - IMPLEMENTED BUT UNVERIFIED
   - FAILED
   - BLOCKED
8. 如发现问题，先修复，再重新自验收
```

最终报告必须明确：

```text
SELF-ACCEPTANCE VERDICT: PASS / FAIL
```

如仍存在阻止本 Task Card DoD 的问题，不得写 PASS。


# 1. 任务目标

完成 `V0-T01` 当前剩余的另一个模块：

> **Real Desktop E2E**

当前总控中已经确认：

```text
Rust / Cargo / Tauri 环境可用
Desktop 编译成功
Desktop App 可启动
Native commands 可用
Native Picker 可用
Reopen 数据完整
Project Lock VERIFIED
stale lock VERIFIED
Deno / Rust tests 已通过
```

但完整 Desktop 工作流仍未 VERIFIED。

本任务负责把剩余真实运行项全部跑通并修复必要的 runtime gap。

---

# 2. 本任务覆盖范围

重点验证并完成：

```text
Asset Import 实机工作
Drag & Drop 实机工作
Autosave 实机工作
Recovery 实机验证
Markdown Desktop Export
HTML Desktop Export
Web 端无回归
Real Desktop E2E 全流程
```

External Modification Detection 由另一个并行任务负责。

如果当前分支尚未包含它：

> 不要自行重复实现，只在完整 E2E 中标记该步骤暂不属于本卡。

---

# 3. Golden Path

必须使用真实 Desktop App 跑通：

```text
Launch Desktop
↓
Create / Open Test Project
↓
Open Lesson
↓
Edit Block
↓
Import Image
↓
Import GIF
↓
Import Video
↓
Import Markdown
↓
Drag & Drop Asset
↓
Modify Existing Flow / Grid Data
↓
Autosave
↓
Close
↓
Restart
↓
Reopen
↓
Verify Persistence
↓
Recovery Scenario
↓
Export Markdown
↓
Export HTML
↓
Close Project
↓
Verify Lock Release
```

不要只用 Web UI 代替 Desktop 验证。

---

# 4. Asset Import

真实验证：

```text
image
gif
video
markdown
```

确认：

```text
Native Picker
↓
真实文件导入
↓
Asset 创建
↓
checksum
↓
Usage
↓
Canonical Save
↓
Restart
↓
仍然存在
```

如某种类型当前产品定义为“参考素材”而非可编辑正文，按既有语义验证，不要擅自改变。

---

# 5. Drag & Drop

从系统文件管理器真实拖入：

```text
image
gif
video
markdown
```

至少确认：

```text
事件被 Desktop 捕获
类型识别正确
导入成功
Asset / Usage 正确
保存后重启仍存在
```

不要只模拟 DOM drag event 就宣称实机通过。

---

# 6. Autosave

真实验证：

```text
编辑
↓
等待 autosave
↓
磁盘 project.json 实际更新
↓
关闭 App
↓
重启
↓
内容恢复
```

必须证明不是：

```text
UI 内存更新
但磁盘没写
```

---

# 7. Recovery

构造安全的 recovery 场景。

至少验证：

```text
检测恢复状态
预览 / 提示
Restore
Restore 前备份
恢复后 Canonical 正确
重新打开仍正确
```

不要破坏真实用户项目，使用测试项目。

---

# 8. Markdown / HTML Export

真实 Desktop 中完成：

```text
Export Markdown
Export HTML
```

检查：

```text
保存位置选择
文件实际生成
文件可打开
核心正文完整
关键素材引用正常
没有明显非法路径
```

不要因为 service 层已有 export test 就跳过 Desktop 实机。

---

# 9. Web Regression

Desktop 修复完成后，必须确认 Browser 审查壳没有被破坏。

至少：

```bash
deno task check
deno task test
deno task ui
```

并人工打开当前 Web UI，确认主要工作台仍能加载。

---

# 10. 允许修什么

E2E 过程中发现会直接阻止本卡 DoD 的问题：

> 可以做最小必要修复。

原则：

```text
能局部修，不重构
能复用，不重写
只修当前 runtime gap
```

如果发现：

```text
External Modification Detection
```

相关问题：

不要重复实现。

如果发现：

```text
V0-T02 Course Authoring
```

体验问题：

记录即可，不展开。

---

# 11. 修改边界

允许：

```text
Desktop bridge
UI glue
asset import glue
drag/drop glue
autosave glue
recovery glue
export glue
integration / E2E tests
test fixtures
```

禁止：

```text
重构 Canonical
重写 Project Lock
新发布平台
新 AI 功能
新课程编辑器
大型 UI 重构
```

---

# 12. 自验收

完成实现后，执行 Agent 必须从头重新跑一次完整 Golden Path。

不要只对修过的那个点做局部复测。

必须确认：

```text
Launch
Open
Edit
Import
Drag
Autosave
Close
Restart
Reopen
Recovery
Export
Close
```

整条链仍然成立。

同时重新运行所有自动测试。

---

# 13. Definition of Done

```text
[ ] Asset Import Desktop 实机通过
[ ] Image / GIF / Video / Markdown 行为符合当前产品语义
[ ] Drag & Drop Desktop 实机通过
[ ] Autosave 确认真实写入磁盘
[ ] Restart / Reopen 后数据完整
[ ] Recovery 实机通过
[ ] Markdown Desktop Export 通过
[ ] HTML Desktop Export 通过
[ ] Project Lock 无回归
[ ] Web UI 无回归
[ ] deno task check 通过
[ ] deno task test 通过
[ ] 必要 Rust/Tauri 测试通过
[ ] 完整 Golden Path 已从头重新跑过
[ ] 没有进入 V0-T02
```

---

# 14. 结项报告

最终输出：

```md
# Task Completion Report — Real Desktop E2E Closure

## Control Position
Version: V0
Task: V0-T01

## Original Goal

## Completed

## Not Completed

## Completed But Not Good Enough

## Files Changed

## Functional Changes
Added:
Changed:
Removed:

## Automated Tests

## Desktop Runtime Verification

## Golden Path Result

## Web Regression Result

## Self Review Findings

## Remaining Blockers

## SELF-ACCEPTANCE VERDICT
PASS / FAIL

## Recommended V0-T01 Status
IN PROGRESS / READY FOR FINAL V0-T01 CHECK
```

不要直接修改总控。
