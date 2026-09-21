# V0-T03 — AI Workflow 开发任务卡

> 项目：AI Course Workbench  
> 当前版本：V0  
> 当前任务：V0-T03 — AI Workflow  
> 前置状态：V0-T01 = VERIFIED；V0-T02 = VERIFIED  
> 本任务目标：让 AI 真正进入 Workbench 的课程生产工作流，但任何 AI 修改都必须继续受 `Suggestion → ChangeDraft → Diff → User Review → Apply` 控制。  
> 本文是 V0-T03 的任务输入材料，不创建新的产品阶段、Milestone 或任务层级。最终状态仍由 `PROJECT_MASTER_CONTROL.md` 决定。

---

# 0. Agent 启动要求

开始编码前必须完整阅读：

1. `PROJECT_MASTER_CONTROL.md`
2. `README.md`
3. 本任务卡
4. 与 AI、ChangeDraft、Diff、Apply、session、project lifecycle、native bridge、tests 直接相关的现有代码

开始前先确认并在内部回答：

```text
Current Version = V0
Current Task = V0-T03 — AI Workflow
Previous Tasks = V0-T01 VERIFIED / V0-T02 VERIFIED
Next Task after VERIFIED = V0-T04 — Output & Publish
```

不得重新规划 V0/V1/V2，不得创建 `V0-T03-A`、`M3`、`N1` 等新层级。

如果总控中仍出现“V0-T05 发布能力”的字样，将其视为文档笔误：本项目 V0 只有 T01–T04，不得因此创建 V0-T05。若本轮回写总控，可仅做文档纠错为 `V0-T04 — Output & Publish`。

---

# 1. 本任务唯一目标

V0-T03 不是给 Workbench 增加一个独立聊天窗口。

目标是：

> **让 AI 能理解用户当前正在制作的课程、课次和内容位置，并在用户明确授权下提出可审阅、可拒绝、可应用、可追踪的修改建议。**

用户需要能够完成以下真实闭环：

```text
打开课程
↓
进入某一课 / 某一区块
↓
明确选择 AI 要看的上下文范围
↓
向 AI 提出任务
↓
Workbench 组装并展示实际将发送的上下文
↓
调用已配置 / 已授权的 AI 能力
↓
AI 返回建议
↓
涉及内容修改时生成 ChangeDraft
↓
展示 Diff
↓
用户 Reject / Apply
↓
Apply 后进入 Canonical，并可正常保存 / 撤销 / 重开
↓
保留可理解的执行记录
```

---

# 2. 必须坚持的产品边界

## 2.1 AI 不得直接写 Canonical

任何会改变课程内容、结构、Requirement、素材引用或其他 Canonical 数据的 AI 结果，都必须走：

```text
Suggestion
↓
ChangeDraft
↓
Diff
↓
User Review
↓
Apply
```

严禁：

```text
AI response
↓
直接 project mutation
↓
直接 save project.json
```

即使结果看起来“明显正确”，也不能绕过审阅。

---

## 2.2 用户必须知道 AI 看了什么

每次调用 AI 前，界面至少要让用户理解本次上下文范围。

V0 必须支持三种核心范围：

```text
Course
Lesson
Block / Current Selection
```

允许组合必要的结构信息，但不得默认把整个项目无差别发送出去。

至少展示：

- 当前作用范围；
- 将发送的课程 / 课次 / Block 标识；
- 是否包含 Requirement / 待补；
- 是否包含素材元数据；
- 是否包含当前布局 / 完成状态等辅助信息；
- 使用哪个 Provider / Model；
- 是否会调用额外 Tool / MCP / Skill。

如果某类数据没有发送，也不需要为了“更智能”偷偷补发。

---

## 2.3 只使用已授权能力

继续遵守项目既有原则：

- 用户明确配置或授权的 AI Provider；
- 已安装 / 已连接的 MCP；
- 已安装 / 已连接的 Skill；
- 已明确授权的浏览器能力；
- 不得偷偷调用未授权软件或外部服务。

API Key / Token 等秘密信息不得写入 `project.json`，不得进入 Canonical，不得出现在导出的课程项目包中。

---

# 3. V0-T03 核心实现范围

## 3.1 Context Assembly

建立单一、可测试的 AI Context Assembly 层。

它负责把当前 Workbench 状态转换为 AI 可消费的结构化上下文，但不能成为第二套 Canonical。

建议至少形成类似结构：

```text
AiContext
- project identity
- course summary
- current lesson
- current block / selection
- nearby structure
- relevant requirements
- relevant asset metadata
- completion / status information when useful
- user instruction
- explicit scope metadata
```

要求：

- Context 来源必须可追溯回现有 Canonical / projection；
- 不复制出长期独立维护的“AI 版课程数据”；
- Context 必须可预览；
- 同一份输入在自动化测试中应可稳定组装；
- Block 级任务默认不应发送整门课程全文。

---

## 3.2 Provider / Connector Boundary

复用或收口现有 Fake / connector boundary，建立统一 AI 调用接口。

目标不是为每家厂商单独做一套工作流，而是：

```text
Workbench AI Workflow
        ↓
Unified Connector Contract
        ↓
Provider Adapter / MCP / Skill / Authorized Capability
```

V0 UI 中可优先以用户熟悉的：

```text
DeepSeek
豆包
ChatGPT
```

作为 Provider 入口或配置概念，但业务层不得把课程工作流写死在某一家 API 形状上。

至少统一处理：

- provider / model identity；
- request payload；
- streaming 或非 streaming 响应的归一化；
- timeout；
- cancellation；
- authentication missing；
- rate limit；
- provider error；
- malformed response；
- tool permission failure。

如果仓库当前没有可用真实凭据：

- 自动化测试继续使用 deterministic fake connector；
- 真实 Provider 只做到正确配置边界与可读错误；
- 不得伪造“已完成真实在线调用”的验收结论；
- Completion Report 必须把未做的 live-provider smoke 写入 `Unverified`。

如果环境中已有合法配置的真实 Provider 凭据，则至少完成一次真实端到端 smoke，并记录具体 Provider / Model，但不得把凭据写入报告。

---

## 3.3 AI 工作区 / 交互入口

在不破坏当前三栏 Course Authoring 的前提下增加 AI 工作入口。

V0 不追求复杂聊天产品，只要求最小而完整：

- 输入用户指令；
- 明确当前上下文范围；
- 可查看将发送的上下文摘要；
- 选择已配置 Provider / Model；
- 发起请求；
- 可取消正在进行的请求；
- 查看结果；
- 对“只回答问题”的结果可直接保留为 Suggestion；
- 对“要求修改课程”的结果生成 ChangeDraft；
- 可进入 Diff Review；
- 可 Reject；
- 可 Apply。

AI 入口不能把用户从当前课、当前 Block、当前编辑状态带离。

---

## 3.4 Suggestion / ChangeDraft / Diff / Apply 收口

仓库已有基础机制，本轮优先复用和补全，不重复造第二套 mutation system。

必须覆盖：

### 非修改型请求

例如：

```text
解释这一段
总结本课
给我三个改写方向
指出逻辑问题
```

允许只产生 Suggestion，不修改 Canonical。

### 修改型请求

例如：

```text
重写当前 Block
把这一节改成更适合新手的表达
补一个过渡段
按当前结构增加一个 Requirement
调整当前课的两个 Block 顺序
```

必须生成 ChangeDraft。

ChangeDraft 至少要能表达：

- target；
- operation；
- before；
- after；
- reason / source suggestion；
- validation result。

Diff 必须让用户看懂“哪里变了”。

Apply 前再次进行 Canonical / domain validation。

Apply 失败时：

- 不得产生半写入状态；
- 不得静默吞错；
- 必须保留 ChangeDraft 供用户处理或重新尝试。

Reject 后不得改变 Canonical。

---

## 3.5 Undo / Save / Reopen 一致性

AI Apply 后产生的修改必须与普通人工编辑处于同一套项目生命周期内：

```text
Apply
↓
Canonical mutation
↓
Autosave / Manual Save
↓
Close
↓
Restart
↓
Reopen
↓
结果一致
```

若当前普通编辑支持 Undo / Redo，则 AI Apply 必须进入同一历史机制，而不是成为不可撤销的特殊路径。

不得建立“AI 写入专用 project.json”或第二份持久化真相。

---

## 3.6 Execution Record

V0 需要保留可理解的 AI 执行记录，用于回答：

```text
什么时候调用的？
用户要求什么？
作用范围是什么？
用了哪个 Provider / Model？
调用了哪些已授权能力？
AI 返回了什么类型结果？
是否生成 ChangeDraft？
最终是 Applied / Rejected / Failed / Cancelled？
```

执行记录不是 Canonical 内容本身。

可以进入 `.workspace`、日志或其他可重建 / 非 Canonical 区域，但要满足：

- 不影响课程内容的唯一事实来源；
- 不把秘密信息写进去；
- 不把完整 API Key / Token 写进去；
- 错误信息可读；
- 记录失败也不得导致课程保存失败。

---

# 4. 本轮必须覆盖的错误与安全路径

至少验证：

```text
1. Provider 未配置
2. API Key / Token 缺失
3. Provider timeout
4. 用户主动 Cancel
5. Provider 返回错误
6. Provider 返回无法解析的修改建议
7. ChangeDraft validation 失败
8. Apply 前项目状态已经变化
9. Apply 失败
10. AI 请求成功但 execution record 写入失败
```

核心原则：

> AI 失败最多导致“这次 AI 没完成”，不能导致课程数据损坏、静默覆盖、项目打不开或当前编辑状态丢失。

---

# 5. 对 T02 结束后两个已知问题的处理决定

## 5.1 浏览器壳刷新后丢失阅读位置

现状：

> 浏览器壳的阅读位置只存在页面内存；刷新后丢失。桌面壳已经有原生 session 持久化。

本任务处理：

```text
BACKLOG
```

V0-T03 不实现 service session endpoint，也不引入 localStorage 补丁。

原因：

- 正式生产形态是 Desktop-first；
- T02 的“关闭 → 重启 → 继续”已经在真实 Tauri Desktop 验证；
- 浏览器壳主要用于开发、调试、UI 审查与 Service / Domain 验证；
- 该缺口不阻止 AI Workflow 的 Definition of Done。

要求：

- README / MASTER CONTROL 中不得继续把浏览器壳描述成“刷新 / 重启后可恢复阅读位置”；
- T03 新增的 AI UI 不得依赖“浏览器刷新后恢复当前阅读位置”才能工作；
- 若测试需要浏览器壳，按其真实能力验收，不做过度承诺。

---

## 5.2 切换项目时出现短暂的「新目录 + 旧 project_id」

现状：

- 切换项目过程中 session 会短暂出现新目录与旧项目 id；
- `project_id` guard 会阻止错误恢复；
- 简单删除提前写 session 的步骤会导致 `loadSession` 把 `projectDir` 拉回旧目录，风险更高；
- 彻底解决需要重构项目切换状态机。

本任务处理：

```text
BACKLOG / KNOWN TECHNICAL DEBT
```

明确禁止为了“代码更漂亮”在 V0-T03 顺手重构 project switch state machine。

T03 只需要遵守：

- 不削弱现有 `project_id` guard；
- 不绕过现有 project lifecycle；
- AI 状态不得改变当前项目身份判定；
- AI execution record / draft 若按项目持久化，必须以最终确认的当前项目 identity 为准；
- 如果 T03 实际修改了 session / openProject / enterProject / project switching 相关代码，则必须补定向回归测试；
- 若没有修改这些路径，不为这个已知问题扩大本轮 scope。

只有当该问题在 T03 中实际导致：

```text
错误项目被写入
AI Draft 串项目
Canonical 串写
错误恢复无法被 guard 阻止
```

时，才升级为当前任务 BLOCKER。

---

# 6. 明确非目标

本轮不得顺手做：

```text
- V0-T04 的发布 / 导出渲染重构
- 微信 / PDF / PNG 等发布适配
- Orchestrator
- 多 Agent 自动调度
- Windows 端适配
- 云同步
- 多人协作
- 完整 RAG / 向量数据库平台
- AI 自动后台持续执行
- 未授权浏览器自动化
- 浏览器壳 session 持久化补丁
- project switching 状态机重构
- 为未来 V1/V2 预建复杂插件平台
```

如果不做某项新增功能，仍能完成本任务 DoD，则把它写入 Backlog，不继续扩张。

---

# 7. 建议执行顺序

以下只是同一任务内的执行顺序，不是新的 Task / Milestone。

## A. 盘点现有 AI 基础

确认：

- Suggestion；
- ChangeDraft；
- Diff；
- Apply；
- fake / connector boundary；
- 当前 AI 相关 UI；
- mutation 与 history；
- native / web boundary；
- tests。

先列出现有能力与缺口，不重写已经可靠的机制。

## B. 收口 Context Assembly

先把 Course / Lesson / Block 三级上下文做成稳定、可测试、可预览的统一结构。

## C. 收口 Connector Contract

统一 fake 与真实 Provider 的输入输出、错误、取消与权限边界。

## D. 完成最小 AI UI Workflow

做到：

```text
选择范围 → 输入请求 → 查看上下文 → 调用 → 查看 Suggestion
```

## E. 完成修改闭环

做到：

```text
Suggestion → ChangeDraft → Diff → Reject / Apply
```

并接入 validation、history、autosave。

## F. Execution Record

记录请求、范围、Provider、结果状态与 Apply / Reject 结果。

## G. 自动化回归

补齐 Domain / Store / Connector / UI / Native boundary 测试。

## H. 真实 Tauri 窗口走查

至少完成一次真实 Desktop AI Workflow E2E。

如果没有真实 Provider 凭据：

- 允许真实 Tauri 窗口使用 deterministic fake connector 验证 Workbench 内部完整闭环；
- live Provider smoke 明确记为 Unverified；
- 不得因此把“真实在线 Provider 已验证”写成已完成。

---

# 8. Definition of Done

只有同时满足以下内容，V0-T03 才允许进入 `DONE` / `VERIFIED` 判断。

```text
[ ] AI 入口已进入现有 Workbench，而不是独立聊天 Demo

[ ] 支持 Course / Lesson / Block 或 Current Selection 三种核心上下文范围

[ ] 用户能在调用前理解实际发送的上下文范围

[ ] AI Context 从 Canonical / projection 组装，不形成第二套课程真相

[ ] Provider / Connector 有统一边界，业务逻辑不绑定单一厂商

[ ] Fake connector 可用于 deterministic 自动化测试

[ ] 已配置真实 Provider 时可完成正常调用；
    无真实凭据时能给出明确配置错误，且 Completion Report 如实标记 live smoke 未验证

[ ] 非修改型请求只产生 Suggestion，不改变 Canonical

[ ] 修改型请求必须产生 ChangeDraft

[ ] ChangeDraft 可展示可理解 Diff

[ ] Reject 不改变 Canonical

[ ] Apply 前执行 domain / canonical validation

[ ] Apply 成功后进入与人工编辑一致的 mutation / history / autosave 路径

[ ] Apply 可通过现有 Undo / Redo 机制撤销（若普通编辑当前支持该能力）

[ ] AI / Provider / parsing / validation / apply 任一失败都不会造成 partial write

[ ] Cancel 不留下半写入或不可恢复状态

[ ] AI execution record 至少记录 request scope / provider / model / status / apply result

[ ] Execution record 不包含 secret，不成为 Canonical 唯一事实来源

[ ] AI Apply 后 Save / Close / Restart / Reopen 数据一致

[ ] T01 的 lock / external modification / recovery 安全不回归

[ ] T02 的 course map / lesson editor / flow-grid / assets / requirement / preview / completion 不回归

[ ] deno task check 通过

[ ] deno task test 全部通过

[ ] cargo test 全部通过

[ ] cargo build / Tauri build 通过

[ ] 真实 Tauri 窗口完成至少一次：
    打开项目 → 进入某课 → 选择上下文 → AI 请求 →
    Suggestion → ChangeDraft → Diff → Reject →
    再次请求 → Apply → 保存 → 关闭 → 重启 → 结果仍在

[ ] BLOCKER = NONE

[ ] PROJECT_MASTER_CONTROL.md 已按总控规则回写

[ ] NEXT ACTION 只有一个：
    V0-T04 — Output & Publish
```

---

# 9. 验收时重点检查的回归风险

本轮尤其防止以下问题：

```text
1. AI 直接修改 canonical，绕过 ChangeDraft
2. AI 上下文误把另一课 / 另一项目内容发送出去
3. Provider error 后仍发生部分 Apply
4. AI history 与普通 Undo/Redo 分裂成两套
5. execution log 写入失败被误报成课程保存失败
6. API Key 被写进 project.json / log / export
7. AI UI rerender 导致当前课 / selection / view 丢失
8. Apply 后 autosave 与 external modification protection 冲突
9. 切换项目后 AI Draft 串到前一个项目
10. 为接 AI 顺手重构 T01/T02 已验证稳定的 project lifecycle
```

---

# 10. 真实桌面验收建议脚本

使用一个临时真实项目，准备至少：

- 2 个 Lesson；
- 当前 Lesson 含 2–3 个普通 Block；
- 1 个 Requirement；
- 1 个素材引用。

走查：

```text
1. 启动真实 Tauri Desktop
2. 打开临时项目
3. 进入 Lesson A / Block A1
4. 打开 AI 入口
5. 选择 Block scope
6. 确认上下文只指向当前范围
7. 请求“解释当前段落” → 得到 Suggestion → 不修改项目
8. 请求“把当前段落改写得更适合新手”
9. 得到 ChangeDraft
10. 打开 Diff
11. Reject → 确认正文未变
12. 再次生成修改
13. Apply
14. 确认正文变化、history 存在、autosave 正常
15. Undo → 内容回退
16. Redo / 再 Apply → 内容恢复
17. 手动保存
18. 关闭应用
19. 重启并重新进入项目
20. 确认 AI Apply 后的 Canonical 内容仍正确
21. 查看 execution record：Applied / Rejected / Failed 等状态正确
22. 用未配置 Provider 触发一次错误，确认只有 AI 请求失败，不影响课程数据
23. 跑一次 T01/T02 关键 smoke，确认无回归
```

若有合法真实 Provider 凭据，再补：

```text
24. 使用真实 Provider 完成一次只读 Suggestion
25. 使用真实 Provider 完成一次 ChangeDraft → Diff → Apply
```

---

# 11. Agent 结项报告要求

严格使用总控的 Task Completion Report 结构，并且必须明确回答：

## 1. Control Position

```text
Version: V0
Task: V0-T03 — AI Workflow
Previous Status:
Current Status:
```

## 2. Original Goal

说明原计划，不得只写最终做了什么。

## 3. Completed

逐项列出实际实现。

## 4. Not Completed

尤其明确：

- 是否完成真实 Provider smoke；
- 是否有凭据限制；
- 是否有真实 Tauri 窗口 E2E 未完成。

## 5. Completed But Not Good Enough

不能省略。

## 6. New Findings

严格分类：

```text
BLOCKER
BACKLOG
DEFERRED
REJECTED
```

本任务已知两项默认继续为 Backlog：

```text
- 浏览器壳刷新后不恢复阅读位置
- project switch 短暂「新目录 + 旧 project_id」状态
```

除非实际演变成阻止 T03 DoD 的问题，否则不要升级。

## 7. Functional Changes

说明 Added / Changed / Removed。

## 8. Verification

分别写：

```text
Tests
Runtime
E2E
Unverified
```

不得把 fake connector E2E 写成 live provider E2E。

## 9. Remaining Work in Current Task

若非空，V0-T03 不得判定 VERIFIED。

## 10. Overall Remaining Work

V0 剩余只能按总控写：

```text
V0-T03（若尚未 VERIFIED）
V0-T04
```

不得创建 V0-T05。

## 11. NEXT ACTION

- 若 V0-T03 未 VERIFIED：唯一 NEXT ACTION 仍是继续完成 V0-T03；
- 若 V0-T03 已 VERIFIED：唯一 NEXT ACTION 才能切换为 `V0-T04 — Output & Publish`。

## 12. MASTER CONTROL UPDATE

必须明确：

```text
已更新 / 未更新
```

未更新则不视为完成交接。

---

# 12. 总控回写要求

任务开始后可把 V0-T03 从 `NOT ACTIVE` 更新为合适的当前状态，例如 `IN PROGRESS`。

任务结束必须更新：

```text
- Last Updated
- Current Position
- V0 Task Board
- V0-T03 当前状态
- V0-T03 Done
- Open Blockers
- Definition of Done
- NEXT ACTION
- Change Log
```

只有 DoD 全部满足且真实验收完成后：

```text
V0-T03 = VERIFIED
NEXT ACTION = V0-T04 — Output & Publish
```

否则：

```text
NEXT ACTION = 继续 V0-T03
```

---

# 13. 最终开发纪律

本轮判断任何新需求时只问：

> **如果不做它，V0-T03 的 AI Workflow 还能达到 Definition of Done 吗？**

如果能：

```text
BACKLOG
```

如果不能：

```text
当前任务内解决
```

不要因为 AI 领域容易扩张，就把 Workbench 变成：

- 通用聊天客户端；
- Agent 平台；
- Orchestrator；
- RAG 平台；
- 模型管理中心；
- 自动发布系统。

V0-T03 只需要把这一件事做完整：

> **AI 理解当前课程上下文 → 给出建议 → 修改必须经 ChangeDraft / Diff / 用户确认 → 安全进入现有 Workbench 生命周期。**
