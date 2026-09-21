# Task Card — V0-T01 External Modification Detection

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

完成 `V0-T01` 当前剩余核心模块之一：

> **External Modification Detection**

目标是确保 Workbench 在项目打开后，如果 `project.json` 被外部编辑器、Agent、Git 操作或其他进程修改，Workbench 不会继续使用旧内存状态静默覆盖磁盘新版本。

正确链路应是：

```text
Open Project
↓
建立当前 baseline
↓
外部修改 project.json
↓
Workbench 再次 Save / Autosave
↓
Detect external change
↓
Block silent overwrite
↓
进入现有 Reload / Diff / Merge 处理路径
↓
Resolve
↓
建立新的 baseline
```

---

# 2. 开工前必须先审计现状

先查清现有代码中：

```text
project.json load/save
autosave
recovery
three-way merge
diff preview
project lock
native command boundary
service persistence
app/main.js save path
src-tauri write path
```

重点确认是否已经存在：

```text
hash
mtime
revision
base snapshot
loaded snapshot
checksum
merge base
file watcher
```

如果已有能力可以复用，不要重新造第二套冲突系统。

---

# 3. 必须满足的行为

## Case A — 无外部修改

```text
Open
Edit
Save
```

正常成功。

## Case B — 外部修改后手动 Save

```text
Open
External modify project.json
Workbench edit
Save
```

必须：

```text
检测到外部修改
阻止写入
保留磁盘新版本
返回明确冲突状态
```

禁止 silent overwrite。

## Case C — 外部修改后 Autosave

Autosave 必须和手动 Save 一样受保护。

不能出现：

```text
手动 Save 会检测
Autosave 却直接覆盖
```

## Case D — Reload

如果用户选择 Reload：

```text
重新读取磁盘版本
更新内存
更新 baseline
```

之后正常保存不应持续误报冲突。

## Case E — Diff / Merge

如果已有三方合并 / diff preview：

> 必须复用现有路径。

不要新增平行 conflict subsystem。

## Case F — Resolve 后继续工作

完成 Reload / Merge / 明确处理后：

```text
建立新 baseline
后续正常 Save
不重复报旧冲突
```

---

# 4. 实现原则

1. `project.json` 继续是 Canonical Truth。
2. External Change Detection 与 Project Lock 分开处理。
3. Native / Service / Autosave 使用同一冲突语义。
4. 宁可阻止写入，也不能静默覆盖。
5. 不把 `.workspace`、SQLite、缓存作为唯一冲突依据。
6. 不大改 schema。
7. 不重构整个 persistence stack。
8. 不进入 V0-T02。

---

# 5. 推荐实现方向

优先检查并复用现有“打开时基线 + 写前比较”能力。

如确实缺失，可实现类似：

```text
Open:
  capture baseline fingerprint

Before Write:
  read current disk fingerprint
  compare with baseline

If same:
  write
  update baseline

If different:
  return EXTERNAL_MODIFICATION_CONFLICT
```

fingerprint 的实现由现有代码决定，可基于：

```text
canonical hash
content hash
revision
mtime + size
```

但不要仅依赖低精度 mtime，如果现有环境中可能发生误判。

---

# 6. 测试要求

至少覆盖：

```text
no external change → save succeeds

external change
→ manual save blocked

external change
→ autosave blocked

external change
→ disk version preserved

reload
→ baseline refreshed

merge / explicit resolution
→ new baseline established

resolved project
→ subsequent save succeeds
```

同时验证 Project Lock 既有测试仍然通过。

至少执行：

```bash
deno task check
deno task test
```

如果 Rust / Tauri 侧被修改，运行项目当前已有对应 Rust/Tauri 检查与测试。

---

# 7. 修改边界

优先修改：

```text
现有 persistence / storage / recovery / conflict service
必要 command boundary
必要 UI conflict state
对应 tests
```

只有确有必要时修改：

```text
app/main.js
src-tauri/src/lib.rs
```

禁止：

```text
Course Authoring
AI Provider
Publish
新数据库
全局目录重构
Canonical schema 大改
重新实现 Project Lock
```

---

# 8. 自验收必须真实执行

实现完成后必须自行重新验证：

```text
1. 打开测试项目
2. 记录当前 project.json
3. 用外部方式修改 project.json
4. 回 Workbench 修改另一处内容
5. 触发 Save
6. 验证没有覆盖外部版本
7. 再重复一次 Autosave 场景
8. 执行 Reload / Diff / Merge 中实际存在的处理方式
9. Resolve 后再次保存
10. 重新打开确认最终数据正确
```

不能只以单元测试通过代替真实流程。

---

# 9. Definition of Done

```text
[ ] external change 能稳定检测
[ ] manual Save 不会 silent overwrite
[ ] Autosave 不会 silent overwrite
[ ] 冲突时磁盘外部版本被保留
[ ] 返回明确结构化 conflict 状态
[ ] Reload 可重新建立 baseline
[ ] 已有 Diff / Merge 路径可继续使用
[ ] Resolve 后后续保存恢复正常
[ ] Project Lock 无回归
[ ] deno task check 通过
[ ] deno task test 通过
[ ] 必要 Rust/Tauri 测试通过
[ ] 已完成真实手动复现
[ ] 没有扩大到 V0-T02+
```

---

# 10. 结项报告

最终输出：

```md
# Task Completion Report — External Modification Detection

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

## Tests

## Runtime Verification

## Self Review Findings

## Remaining Blockers

## SELF-ACCEPTANCE VERDICT
PASS / FAIL

## Recommended V0-T01 Status
IN PROGRESS / READY FOR FINAL V0-T01 CHECK
```

不要直接修改总控。
