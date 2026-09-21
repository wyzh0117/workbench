# V0-T03 — AI Workflow 设计冻结（本轮实现契约）

> 本文件是 **V0-T03 的开发输入材料**，不是新的任务层级，不改变 `PROJECT_MASTER_CONTROL.md` 的判定权。
> 目的：把各 workstream 之间必须共享的接口先冻结，避免并行实现时互相猜。

## 0. 已有事实（不要重做）

- Canonical = `project.json`（`ProjectData`）。AI 相关的 canonical 行已存在：
  `context_packs` / `context_pack_items` / `suggestions` / `change_drafts`（见 `src/domain/types.ts:438-487`）。
- 已有 domain 原语：`src/domain/ai.ts`（`createContextPack` / `analyzeForSuggestions` /
  `DeterministicModelAdapter` / `UnsupportedModelAdapter` / `createSuggestion` /
  `acceptSuggestion` / `reviewChangeDraft` / `applyChangeDraft`）。
  **保持其现有行为不回归**（已被 T01/T02 测试覆盖）。
- UI 只能加载 `app/` 下的模块（dev server 只服务 `app/`，Tauri `frontendDist = ../app`）。
  因此 **UI 与 Deno 测试共享的实现必须放在 `app/*.js`**，与 `app/authoring.js` 同一模式：
  `// @ts-check` + JSDoc typedef `import("../src/domain/types.ts")`。
- 浏览器壳的一切命令走 `POST /api/command` → `DesktopService.commands.execute(name, input)`，
  白名单是 `src/service/commands.ts` 的 `HIGH_LEVEL_COMMANDS`。
- 桌面壳走 `DesktopBridge.command(name, input)` → `nativeCommand(command)` 映射 → Rust `invoke`。
  **桌面壳没有跑 Deno service**：所有 canonical mutation 都在 `app/main.js` 的 WorkbenchStore 里发生，
  再由 `project.save` 整包落盘。
- `assertAuthoringInvariants`（`app/main.js:2767`）不扫描 AI 行；`validateProjectData` 只校验已知字段
  （新增**可选**字段不会破坏校验）。
- Tauri CSP 是 `default-src 'self'`，页面无法直连外部 Provider；桌面壳的 HTTP 必须走 Rust 命令。
- `reqwest 0.11`（`default-features = false, features = ["json","rustls-tls"]`）可离线构建（已实测）。

## 1. 分层

```
app/main.js (WorkbenchStore)          ← 唯一的 canonical mutation 入口（本地 JS，两壳一致）
   │  import
   ▼
app/ai.js                             ← AI Workflow 核心（纯函数 + 连接器契约），UI 与 Deno 测试共享
   │  transport（只有需要联网时才用）
   ▼
bridge.command("ai.complete", …)
   ├─ 浏览器壳 → src/service/ai_transport.ts（Deno fetch，密钥由服务侧注入）
   └─ 桌面壳   → Rust `ai_complete`（reqwest，密钥由 Rust 侧注入）
```

**原则**
1. Provider 语义（URL / 鉴权头 / 响应形状 / 错误映射）**只在 `app/ai.js` 里写一份**；
   两个 transport 只做「按给定 url/headers/body 发一次 HTTPS，回传状态码+响应体」。
2. API Key 只在 transport 所在进程内注入，**不进入页面、不进入 project.json、不进入导出包、
   不进入 execution record**。
3. AI 的一切 canonical 修改都经 `store.commit(...)`，因此自动获得 history / undo / redo /
   autosave / external-modification protection。

## 2. `app/ai.js` 冻结接口

模块必须能被浏览器（无构建）和 Deno 直接加载：只用 `crypto.subtle`、`TextEncoder`、
`structuredClone` 等双端都存在的能力；**不得在模块顶层访问 `document` / `window` / `Deno`**。

### 2.1 上下文装配

```js
/** @typedef {"course" | "lesson" | "block"} AiScopeKind */

/**
 * @param {import("../src/domain/types.ts").ProjectData} data
 * @param {{
 *   scope: AiScopeKind,
 *   content_item_id?: string | null,
 *   block_id?: string | null,
 *   instruction?: string,
 *   include?: { requirements?: boolean, assets?: boolean, completion?: boolean, nearby?: boolean },
 * }} input
 * @returns {AiContext}
 */
export function assembleAiContext(data, input)
```

`AiContext`（可 JSON 化，纯读，不含任何 secret）：

```js
{
  scope: { kind, label, content_item_id, block_id },
  project: { id, title },
  course: { title, lesson_count, stage_count, completed_lessons, open_requirements, missing_assets },
  lesson: null | { id, code, title, type, stage_title, block_count, media_count, completion_percentage },
  block: null | { id, type, label, text, position, asset_filename },
  nearby: [ { relation: "previous" | "next" | "stage_sibling", code, title } ],
  requirements: [ { id, type, note, priority, status, anchor_block_id, resolved_asset_id } ],
  assets: [ { id, filename, type, mime_type, size, used_by } ],
  completion: null | { percentage, dimensions: [ { key, label, selected } ], gaps },
  instruction: string,
  items: [ { source_type, source_id, label, content, chars } ],   // 只会发送这些
  excluded: [ { source_type, source_id, reason } ],               // 明确没发送的
  payload_chars: number,
}
```

规则（DoD / §3.1）：
- `items` 必须能追溯回 canonical：`source_id` 一定是 canonical 行的 id，或 `course_map`
  这类显式投影 id（`source_type: "course_map"`, `source_id: <project.id>`）。
- 相同的 `data` + 相同 `input` → 逐字节相同的 `items`（确定性；数组顺序固定）。
- Block scope 默认**不发送整门课程全文**，只发送：本课结构摘要 + 目标区块全文
  （+ 可选相邻区块标题）。
- `excluded` 必须诚实列出被关掉的类别（例如 `requirements` 未勾选），不得偷偷补发。

辅助：
```js
export function aiContextPromptPayload(context) // → { system, user } 纯文本，供 provider 组装 messages
export function aiContextPreviewLines(context)  // → [{ label, chars, source_type }] 供 UI 预览
```

### 2.2 Provider 目录与连接器契约

```js
export const AI_PROVIDER_PRESETS = [
  // id, label, kind, base_url, chat_path, auth_header, auth_scheme, default_model, models[], requires_credential
];
// id: "deepseek" | "doubao" | "openai" | "custom" | "fake"
export function aiProviderPreset(id)          // → preset | null
export function aiProviderDescriptors()       // → preset[]（给 UI 下拉）

export const AI_FAILURE_CODES = [
  "not_configured",     // Provider 未配置
  "missing_credential", // API Key / Token 缺失
  "timeout",
  "cancelled",
  "rate_limited",
  "provider_error",
  "malformed_response",
  "permission_denied",  // tool / MCP / Skill 未授权
  "transport_unavailable",
  "invalid_request",
];
export class AiFailure extends Error { code; details; recoverable; recommended_action }

/** 统一请求（业务层只认这个） */
export function buildAiProviderCall({ preset, model, context, instruction, wants_changes, base_url })
// → { url, headers: {…}, body: {…}, response_kind: "chat" }
//    headers 里 **不含** 密钥；只放 "x-workbench-auth: provider" 之类的注入指令

/** 统一响应归一化：同时吃 JSON 与 SSE(text/event-stream) */
export function normalizeAiProviderResponse(preset, transport_result)
// → { text, model, usage, finish_reason, raw_kind: "json" | "stream" }

/** 把模型文本解析成 { answer, changes[] }；无法解析时抛 AiFailure("malformed_response") */
export function parseAiAnswer(text)
```

`parseAiAnswer` 的契约（写进 system prompt，模型必须遵守）：
模型返回一个 JSON 对象（允许 ```json 围栏）：
```json
{
  "answer": "给用户看的说明",
  "changes": [
    { "op": "replace_block", "block_id": "…", "content": "新正文", "reason": "…" },
    { "op": "insert_block", "after_block_id": "…", "type": "paragraph", "content": "…", "reason": "…" },
    { "op": "create_requirement", "requirement_type": "text", "note": "…", "priority": "medium", "anchor_block_id": null, "reason": "…" },
    { "op": "move_block", "block_id": "…", "after_block_id": "…", "reason": "…" }
  ]
}
```
- `answer` 必填（string）。
- `changes` 缺省为 `[]` → 非修改型请求，只产生 Suggestion。
- 若文本不是 JSON：若明显是自然语言回答，则视为 `{ answer: text, changes: [] }`；
  若看起来像想改内容但结构不可解析（例如出现 `changes` 字样但没有合法 JSON），
  抛 `AiFailure("malformed_response")`（对应 §4.6）。
- 任何 `op` 不在上述四种 → `malformed_response`。

### 2.3 连接器实现

```js
export class FakeAiConnector {
  constructor(options = {})         // { scenario: "ok" | "timeout" | "provider_error" | "rate_limit" | "malformed" | "missing_credential" | "permission_denied" | "cancelled", latency_ms, changes }
  descriptor()
  async complete(request, { signal })  // 完全不联网；deterministic
}

export class HttpAiConnector {
  constructor({ preset, model, base_url, transport })  // transport: (call) => Promise<TransportResult>
  descriptor()
  async complete(request, { signal })
}
```

`TransportResult`：
```js
{ ok: true, status: 200, headers: {}, body: <parsed JSON or string>, response_kind: "json" | "stream" }
{ ok: false, code: <AI_FAILURE_CODES>, message: string, status?: number, detail?: string }
```

`HttpAiConnector.complete` 负责：组装 → `transport(call, { signal, timeout_ms })` →
HTTP 状态映射（401/403 → `missing_credential`/`permission_denied`，429 → `rate_limited`，
5xx → `provider_error`，超时 → `timeout`，abort → `cancelled`）→ `normalizeAiProviderResponse`
→ `parseAiAnswer`。**所有错误都归一到 `AiFailure`。**

### 2.4 ChangeDraft 构建 / Diff / Apply

canonical 类型新增**可选**字段（不破坏既有校验、不需要迁移）：
```ts
// src/domain/types.ts
export interface ChangeDraft {
  …既有字段…
  operations?: ChangeOperation[];        // 新增
  reason?: string;                       // 新增：来源 Suggestion 的理由
  validation?: ChangeValidation;         // 新增：Apply 前的 domain 校验结果
  scope?: JsonObject;                    // 新增：{ kind, content_item_id, block_id }
  provider?: JsonObject;                 // 新增：{ provider_id, model }（无密钥）
}
export interface ChangeOperation {
  id: string;
  op: "replace_block" | "insert_block" | "create_requirement" | "move_block";
  target: JsonObject;   // { block_id } / { after_block_id } / { content_item_id, anchor_block_id }
  before: JsonValue | null;
  after: JsonValue;
  reason: string;
}
export interface ChangeValidation {
  checked_at: string;
  ok: boolean;
  issues: string[];
}
```

`app/ai.js` 导出：

```js
/** 由 Suggestion + 模型 changes 造 ChangeDraft（不改正文） */
export function createAiChangeDraft(data, suggestionId, changes, options)
/** 由模型回答直接造 Suggestion（非修改型请求也走这里） */
export function createAiSuggestion(data, { contextPackId, targetContentItemId, answer, modelMetadata })
/** 纯校验：能否应用。返回 { ok, issues } */
export function validateAiChangeDraft(data, draftId)
/** 展示用的 Diff 行：{ op, label, before_lines, after_lines, block_id } */
export function aiChangeDraftDiffRows(data, draftId)
/** 只改 canonical：把已验证的 operation 落到 data 上（调用方负责 clone + commit） */
export function applyAiChangeDraft(data, draftId, { confirmed, operation_ids })
export function rejectAiChangeDraft(data, draftId, { reason })
```

**原子性要求**：`applyAiChangeDraft` 必须
1. 先对 **全部** 选中 operation 做校验（存在性 / before 匹配 / 不重复 / 同一课）；
2. 再在传入的 `data` 上一次性落盘；
3. 调用方（`app/main.js`）在 `store.commit` 内对 **深拷贝候选** 执行，全部成功后才整体替换
   `store.data` 内容 → 任何失败都不可能半写入。
4. 失败必须抛出可读错误并保留 draft（`status` 仍为 `reviewing`，`validation.ok=false`）。

`operation` 语义：
- `replace_block`：`before` = 当前 `block.content`，`after` = 新 content。
- `insert_block`：`before` = null，`after` = `{ type, content, order_index }`；新 block 属于当前课
  （沿用 `document.ts` 的 `content_item_id`/`document_id` 约定）。
- `create_requirement`：`before` = null，`after` = `{ type, note, priority, anchor_block_id, content_item_id }`。
- `move_block`：`before` = `{ block_ids }`（受影响窗口的当前顺序），
  `after` = `{ block_ids }`（目标顺序）。

### 2.5 执行记录（非 Canonical）

```js
export function buildAiExecutionRecord({ … })  // → record（纯函数，便于测试）
export const AI_EXECUTION_STATUS = ["succeeded", "failed", "cancelled"];
export const AI_EXECUTION_OUTCOME = ["answer", "suggestion", "change_draft", "none"];
```

Record 形状（**不含任何 secret / 不含正文全文**）：
```js
{
  id, project_id, created_at, finished_at, duration_ms,
  scope: { kind, content_item_id, block_id, label },
  instruction,                       // 用户要求（截断到 2000 字）
  context: { item_count, chars, source_types: [...] },   // 只有元数据，没有正文
  provider: { provider_id, model, label },
  capabilities: { tools: [], mcp: [], skills: [] },      // V0 恒为空数组且如实声明
  status, error_code, error_message,                     // 失败时的可读原因
  outcome,
  suggestion_id, change_draft_id,
  review: { state: "pending" | "rejected" | "applied" | "apply_failed", decided_at },
}
```

## 3. Transport 契约（Workstream B / C 共用的 JSON）

命令：`ai.complete`

输入：
```json
{
  "request_id": "uuid",
  "provider_id": "deepseek",
  "url": "https://api.deepseek.com/chat/completions",
  "auth": { "header": "authorization", "scheme": "Bearer" },
  "headers": { "content-type": "application/json" },
  "body": { "...": "…" },
  "timeout_ms": 60000
}
```
输出（成功）：
```json
{ "status": 200, "headers": { "content-type": "application/json" }, "body": { … }, "response_kind": "json" }
```
输出（失败）**不抛异常给用户**，而是抛出结构化错误，UI 侧归一为 `AiFailure`：
- `missing_credential`：该 provider 没有配置密钥 → 可读中文提示 + `recommended_action`
- `timeout` / `cancelled` / `provider_error` / `rate_limited` / `transport_unavailable`

命令：`ai.cancel` → `{ request_id }` → `{ cancelled: boolean }`

命令：`ai.connection.list` → `{ providers: AiProviderConfig[], credentials: { [provider_id]: boolean } }`
命令：`ai.connection.save` → `{ provider }`（**不含密钥**）
命令：`ai.connection.delete` → `{ provider_id }`
命令：`ai.secret.set` → `{ provider_id, value }` → `{ provider_id }`（**绝不回显 value**）
命令：`ai.secret.delete` → `{ provider_id }`

命令：`ai.execution.append` → `{ record }` → `{ id }`（写失败不得影响课程保存）
命令：`ai.execution.list` → `{ limit }` → `{ records: [] }`

存储位置（两壳一致，均为**非 Canonical**）：
- `<project>/.workspace/ai-providers.json`（provider 配置 + 密钥，文件权限 0600）
- `<project>/.workspace/ai-executions.json`（执行记录，有界，最多 200 条）

> 说明：系统钥匙串适配器尚未安装；密钥放在 `.workspace`（既不在 `project.json`、
> 不在 Canonical、不进入任何导出包），UI 必须如实告知用户这一点。

## 4. UI 契约（Workstream D）

`store.ui` 新增字段（全部非 canonical，可进 session 的只有安全的少数字段）：

```js
aiScope: "lesson",              // course | lesson | block
aiBlockId: null,                // block scope 时的目标区块
aiInstruction: "",
aiProviderId: "fake",           // 默认使用确定性本地连接器
aiModel: "",
aiInclude: { requirements: true, assets: true, completion: true, nearby: true },
aiContext: null,                // assembleAiContext 的结果（预览）
aiContextOpen: false,
aiStatus: "idle",               // idle | assembling | running | done | failed | cancelled
aiError: null,                  // { code, message, recommended_action }
aiResult: null,                 // { answer, suggestion_id, change_draft_id, outcome }
aiDraftId: null,                // 正在 Diff 审核的 ChangeDraft
aiExecutions: [],               // 最近执行记录
aiExecutionsOpen: false,
aiProviders: [],                // 来自 ai.connection.list
aiCredentials: {},              // { provider_id: boolean }
aiProviderForm: null,           // 配置 provider 的小表单
aiRunId: null,                  // 当前 request_id
```

动作（`data-action`）：
`ai-scope` / `ai-select-block` / `ai-toggle-context`（`data-key`）/ `ai-preview-context` /
`ai-run` / `ai-cancel` / `ai-close-result` / `ai-open-draft`（`data-id`）/ `ai-reject-draft` /
`ai-apply-draft` / `ai-open-diff` / `ai-toggle-executions` / `ai-refresh-executions` /
`ai-edit-provider`（`data-id`）/ `ai-save-provider` / `ai-cancel-provider` /
`ai-save-secret` / `ai-delete-secret` / `ai-use-result-as-suggestion` / `ai-dismiss-draft`

**状态保持要求（§9.7）**：AI 面板的任何 rerender 都不得改变
`ui.activeId` / `ui.mode` / `ui.route` / `ui.selectedBlockId`（除用户显式点击区块）。

**Scope 与当前课的一致性**：`lesson`/`block` scope 永远绑定 `store.currentItem()`；
切换课以后 `aiContext` 必须置空（防止把 A 课的上下文发到 B 课）。

## 5. 必须覆盖的错误路径（§4）

| # | 场景 | 期望 |
|---|---|---|
| 1 | Provider 未配置 | `not_configured`，可读提示，Canonical 不变 |
| 2 | API Key 缺失 | `missing_credential`，提示去哪里配置，Canonical 不变 |
| 3 | Provider timeout | `timeout`，请求结束，无半写入 |
| 4 | 用户 Cancel | `cancelled`，无半写入，draft 保留 |
| 5 | Provider 返回错误 | `provider_error` / `rate_limited`，Canonical 不变 |
| 6 | 无法解析的修改建议 | `malformed_response`，不生成 ChangeDraft |
| 7 | ChangeDraft validation 失败 | `validation.ok=false` + issues，Apply 被拒 |
| 8 | Apply 前项目状态已变化 | before 不匹配 → Apply 被拒，draft 保留 |
| 9 | Apply 失败 | 无半写入（深拷贝候选替换） |
| 10 | execution record 写入失败 | 只提示，不影响课程保存 |

## 6. 文件所有权（避免并行冲突）

| Workstream | 独占文件 |
|---|---|
| A 核心 | `app/ai.js`(新)、`tests/ai_workflow_test.ts`(新)、`app/boot.js`、`deno.json` |
| B 服务 | `src/service/ai_transport.ts`(新)、`src/service/desktop.ts`、`src/service/commands.ts`、`tests/ai_transport_test.ts`(新) |
| C 原生 | `src-tauri/Cargo.toml`、`src-tauri/src/lib.rs`、`src-tauri/build.rs`(如需要) |
| D UI | `app/views.js`、`app/main.js`、`app/styles.css`、`tests/ai_ui_test.ts`(新) |
| 类型 | `src/domain/types.ts`（只允许 A 追加可选字段；其他人不改） |

`src/domain/ai.ts` 与既有测试**不改行为**；如确需修改必须说明原因并保持既有断言通过。
