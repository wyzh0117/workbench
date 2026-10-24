# Workbench「AI 模型配置 / AI 设置」现状调研

> 调研对象：`/Users/youngi/Documents/MiniWork/workbench`（Deno + 原生 JS + Rust/Tauri 桌面客户端）。
> 本文只记录现状，不含改造方案的实现。所有结论带 `file:line` 证据；未能核实处显式标注「未确认」。
> 规格基线：`V1_Post_v0.2.3_Actual_Use_Closure_2026-10-01.md` §9（"Rebuild Model Settings using DSH's model-provider UX"，L686-L860）与 `V1_Feedback_Import_Rendering_AI_Settings_2026-09-30.md` §7.2—7.6（L247-L328）。代码注释中的 §9.x 均指向这两份文档。

---

## 1. UI 入口与结构

### 1.1 入口（打开/关闭）

| 入口 | 位置 | 文案 / 属性 |
|---|---|---|
| 顶栏「设置」按钮 | `app/views.js:673`（topbarView，函数区间 `app/views.js:649-688`） | `<button class="secondary" data-action="ai-toggle-settings" aria-haspopup="dialog">设置</button>` |
| 项目设置页「管理连接」 | `app/views.js:2522`（settingsView，`app/views.js:2505-2523`） | `data-focus-key="settings-ai-connections" data-action="ai-toggle-settings" aria-haspopup="dialog"`，文案「管理连接」 |
| 项目设置页「发现或选择模型」 | `app/views.js:2522` | `data-focus-key="settings-ai-models" data-action="ai-toggle-settings"` |
| AI 助手空状态「配置 AI」 | `app/views.js:3396`（assistantPanel，`app/views.js:3320-3507`） | `<button class="primary" data-action="ai-toggle-settings">配置 AI</button>`，旁注「右上角"设置"也可随时打开模型管理。」 |

状态开关（Store 方法）：

- `aiToggleSettings()` — `app/main.js:3786-3794`：切换 `ui.aiSettingsOpen`；打开时若无表单且当前选中的不是订阅账户，自动 `aiEditProvider(..., { preserveSelection: true })` 打开当前连接的表单。
- `aiCloseSettings()` — `app/main.js:3795-3804`：清空所有 `[data-ai-secret], [data-ai-temporary-secret]` 输入框、`aiSettingsOpen=false`、`aiProviderForm=null`、`aiConnectionTestStatus=null`、`focusField=""`。
- action 分发：`handleAction` 的 `ai-toggle-settings` / `ai-close-settings` / `ai-settings-backdrop` — `app/main.js:11655-11660`（handleAction 总函数在 `app/main.js:11236-11757`）。

### 1.2 渲染函数（app/views.js）

AI 设置不是独立页面，而是 `overlayView()`（`app/views.js:3705-3854`）里的**一个模态 overlay 分支**：

- **总装**：`overlayView` 的 `if (store.ui.aiSettingsOpen)` 分支 — `app/views.js:3840-3852`。
- **表单**：`aiProviderFormView(descriptor, configured)` — `app/views.js:3037-3173`（无表单时返回空串，L3039）。
- **已有连接列表**：`aiConnectionManagerView(choices, configured)` — `app/views.js:2961-3003`。
- **订阅登录区**：`aiSubscriptionSettingsView(store, configured)` — `app/views.js:3005-3027`。
- **辅助**：`aiProviderChoices()` — `app/views.js:2870-2898`（只含 shell 实际持有的连接 + 会话显式选择的离线连接器；当前选中排最前，L2894-2897）；`aiConfiguredMap()` — `app/views.js:2900-2904`。
- 关联但不在弹窗内：`settingsView()` — `app/views.js:2505-2523`（项目设置页 05 个区块，含「AI 连接」「模型」「账户」卡）；`assistantPanel()` — `app/views.js:3320-3507`（§9.7：助手内**不得**有模型配置 UI，只留连接/模型选择与运行区）。

### 1.3 DOM 结构（树状图）

产出位置：`app/views.js:3851`（外层）+ 三个子渲染函数。缩进表示嵌套：

```text
div.overlay.ai-settings-overlay[data-action="ai-settings-backdrop"]        ← views.js:3851
└─ section.modal.ai-settings-modal[role=dialog][aria-modal=true]
   │  [aria-labelledby="ai-settings-title"][data-stop-click="true"]
   ├─ header.modal-head
   │  ├─ div
   │  │  ├─ span.eyebrow        "应用设置 · 模型"
   │  │  └─ h2#ai-settings-title "AI 模型"
   │  └─ button.icon-button[data-action="ai-close-settings"]
   │     [aria-label="关闭设置"][title="关闭设置"]  "×"
   ├─ p.muted  "设置连接、协议、模型与本机凭据。配置保存、模型发现和连接测试分别显示状态。"
   ├─ div.ai-provider-form                       ← aiProviderFormView views.js:3064-3172（有表单时才渲染）
   │  ├─ label.field-label  "Provider ID"
   │  │  └─ input.select[data-ai-provider-id][data-focus-key="ai-provider-id"]
   │  │     [disabled 当 isFake 或已保存][autocomplete=off]
   │  ├─ p.ai-hint  （ID 永久固定提示，两种文案见 1.4）
   │  ├─ label.field-label  "显示名称"
   │  │  └─ input.select[data-ai-provider-label][data-focus-key="ai-provider-label"]
   │  ├─ label.field-label  "Base URL"
   │  │  └─ input.select[data-ai-base-url][data-focus-key="ai-base-url"][disabled 当 isFake]
   │  ├─ label.field-label  "API 协议"（isFake 时省略）
   │  │  └─ select.select[data-ai-api-protocol][data-focus-key="ai-api-protocol"]
   │  │     └─ option × 3（见 1.4）
   │  ├─ p.ai-hint  "这里保存的是地址与模型名，不是密钥；密钥用下面的「保存密钥」单独写入。"
   │  ├─ div.ai-run-row
   │  │  ├─ button.secondary[data-action="ai-discover-models"][data-focus-key="ai-discover"]
   │  │  │    "读取模型" / "正在读取模型…"
   │  │  └─ span.ai-model-source  （来源状态，见 1.4）
   │  ├─ p.ai-hint.warning[data-ai-models-error]  （读取失败时）
   │  ├─ label.field-label  "搜索模型"
   │  │  └─ input.select[data-ai-model-search][data-focus-key="ai-model-search"]
   │  ├─ p.ai-hint  "勾选想要的模型再点「加入所选模型」；这一步只改表单…"
   │  ├─ div.ai-model-list[data-ai-model-list]
   │  │  └─ button.ai-model-chip[.active][aria-pressed][data-action="ai-toggle-model-selection"][data-id]
   │  ├─ div.ai-run-row
   │  │  └─ button.secondary[data-action="ai-add-selected-models"]  "加入所选模型（N）"
   │  ├─ p.ai-hint  "这个连接将拥有的模型（点一个设为默认模型）："
   │  ├─ div.ai-model-list.ai-model-list-added
   │  │  └─ button.ai-model-chip[.active][aria-pressed][data-action="ai-pick-model"][data-id]
   │  │       模型名 + "<small>默认</small>"
   │  ├─ label.field-label  "手动输入 Model ID（读取失败或需要未列出的模型时使用）"
   │  │  └─ input.select[data-ai-model-manual][data-focus-key="ai-model-manual"]
   │  ├─ p.ai-hint  "将要使用的模型：<b data-ai-model-preview>…</b><span data-ai-model-preview-note>…</span>"
   │  ├─ div.ai-run-row
   │  │  ├─ button.primary[data-action="ai-save-provider"]   "保存配置"
   │  │  └─ button.secondary[data-action="ai-cancel-provider"] "取消"
   │  ├─ div.ai-run-row（isFake 时省略）
   │  │  ├─ button.secondary[data-action="ai-test-connection"]  "测试连接"/"正在测试…"
   │  │  └─ span.ai-connection-test[data-ai-connection-test]   （测试状态文案）
   │  ├─ p.ai-hint  "配置状态：连接配置已保存 / 连接配置尚未保存"
   │  ├─ p.ai-hint  "凭据状态：已配置密钥 / 未配置密钥；…"
   │  └─ （isFake 时省略）
   │     ├─ div.ai-run-row
   │     │  ├─ input.select[type=password][data-ai-secret][data-provider-id]
   │     │  │    [data-focus-key="ai-secret"][autocomplete=off]（placeholder 见 1.4）
   │     │  └─ button.secondary[data-action="ai-save-secret"][data-provider-id]  "保存密钥"
   │     └─ div.ai-run-row
   │        └─ button.text-button.danger[data-action="ai-delete-secret"][data-provider-id]
   │             "删除本机保存的密钥"
   ├─ section.ai-connection-manager#ai-connection-manager   ← aiConnectionManagerView views.js:2971-3002
   │  ├─ div.ai-block-head
   │  │  ├─ div
   │  │  │  ├─ b      "已有模型服务商"
   │  │  │  └─ small  "只显示你创建的 API 连接与已保存的订阅账户；API Key 只显示是否已配置，不会回显。"
   │  │  └─ button.primary[data-action="ai-create-connection"]  "+ 添加模型服务商"
   │  ├─ div.ai-connection-list
   │  │  └─ article.ai-connection-row[.active][data-provider-id]   （每条连接一行）
   │  │     ├─ div.ai-connection-info
   │  │     │  ├─ div.ai-connection-title
   │  │     │  │  ├─ b        显示名称
   │  │     │  │  ├─ span.ai-key-state.active  "当前使用"（仅当前连接）
   │  │     │  │  └─ span.ai-key-state.set/.unset  "凭据已配置"/"未配置凭据"
   │  │     │  ├─ small  "Provider ID：…"
   │  │     │  ├─ small  "Base URL：…（尚未设置）"
   │  │     │  ├─ small  "协议：…"
   │  │     │  ├─ small[data-ai-connection-models]  "已配置模型：…（无（可手动填写 Model ID））"
   │  │     │  └─ small  "默认模型：…（未设置）"
   │  │     └─ div.ai-connection-actions
   │  │        ├─ button.text-button[data-action="ai-use-provider"]  "使用"/"当前连接"（disabled）
   │  │        ├─ button.text-button[data-action="ai-edit-connection"]  "编辑"
   │  │        └─ button.text-button.danger[data-action="ai-delete-connection"]  "删除"（仅已保存）
   │  └─ p.ai-hint  （空列表文案，见 1.4）
   ├─ section.ai-subscription-settings               ← aiSubscriptionSettingsView views.js:3014-3026
   │  ├─ div.ai-block-head  "ChatGPT 订阅登录" / "OpenAI SIWC · 独立于 API Key"
   │  ├─ p.ai-hint  （原生/浏览器两种文案，见 1.4）
   │  ├─ div.ai-run-row（仅原生）
   │  │  ├─ button.secondary[data-action="ai-subscription-start"]  "Continue with ChatGPT"
   │  │  └─ button.text-button[data-action="ai-subscription-cancel"]  "取消登录"（pending 时）
   │  ├─ p.ai-subscription-status[aria-live=polite]（尝试状态行）/ p.ai-hint
   │  └─ div.ai-subscription-list
   │     └─ article.ai-subscription-row（每账户一行：名称、"已授权/未登录"、"默认模型：…"，
   │        按钮 退出登录 / 重新登录 / 删除）或 p.ai-hint "尚未添加 ChatGPT 订阅账户。"
   ├─ p.ai-hint  "选择一个 API 连接进行管理，或新建连接。"（无表单时才渲染）
   └─ div.ai-settings-foot
      ├─ span  "AI 配置仅保存连接元数据；密钥和订阅令牌写入{aiStorageLabel()}，课程文件不含凭据。"
      └─ button.secondary[data-action="ai-close-settings"]  "完成"
```

### 1.4 当前界面上的区块 / 字段 / 按钮（逐条，含中文文案）

**弹窗框架**（views.js:3851）：
1. 眉题「应用设置 · 模型」；标题「AI 模型」；关闭按钮「×」（aria-label/title「关闭设置」）。
2. 说明段「设置连接、协议、模型与本机凭据。配置保存、模型发现和连接测试分别显示状态。」
3. 页脚说明「AI 配置仅保存连接元数据；密钥和订阅令牌写入 macOS 系统钥匙串（浏览器壳为"macOS 系统钥匙串（本机浏览器服务）"，`app/main.js:3684-3688`），课程文件不含凭据。」＋按钮「完成」。

**A. 提供商表单**（aiProviderFormView，views.js:3037-3173；仅当 `ui.aiProviderForm` 存在）：
1. 字段「Provider ID」（`data-ai-provider-id`；已保存或离线连接器时 disabled）。
2. 提示：已保存→「Provider ID 创建后永久固定，不能再修改；显示名称可以随时改。」；未保存→「保存后这个 ID 就永久固定，之后只能改显示名称。」（L3068-3070）
3. 字段「显示名称」（`data-ai-provider-label`）。
4. 字段「Base URL」（`data-ai-base-url`，placeholder `https://api.example.com/v1`）。
5. 字段「API 协议」（`data-ai-api-protocol`）下拉，恰好 3 个选项（`app/ai.js:1740-1744`，§9.4）：**OpenAI Chat Completions**（`openai-completions`）、**OpenAI Responses**（`openai-responses`）、**Anthropic Messages**（`anthropic-messages`）。
6. 提示「这里保存的是地址与模型名，不是密钥；密钥用下面的「保存密钥」单独写入。」（L3086）
7. 按钮「读取模型」/「正在读取模型…」（`ai-discover-models`）＋来源状态 `ai-model-source`：「已从服务商读取到 N 个模型」/「改为手动填写 Model ID」/「还没有读取模型」（L3091-3097）。
8. 失败提示「读取模型失败：{原因}。可以直接在下面手动填写 Model ID，不影响保存。」（L3101-3103）
9. 字段「搜索模型」（placeholder「搜索 Model ID」）＋提示「勾选想要的模型再点「加入所选模型」；这一步只改表单，保存连接之前不会写入任何配置。」（L3108-3109）
10. 发现结果 chip 列表（`ai-model-chip`，显示名 + 小字 Model ID，`aria-pressed`）。
11. 按钮「加入所选模型（N）」（`ai-add-selected-models`，无勾选时 disabled）。
12. 已加入模型 chip 列表（点选设默认，选中 chip 带「<small>默认</small>」）；空时提示「还没有加入任何模型；读取失败时也可以直接手动填写 Model ID。」（L3125-3137）
13. 字段「手动输入 Model ID（读取失败或需要未列出的模型时使用）」（`data-ai-model-manual`）。
14. 预览行「将要使用的模型：{模型}（手动填写）/（来自读取结果）」（L3142-3146）。
15. 按钮「保存配置」（primary）、「取消」（secondary）（L3148-3153）。
16. 按钮「测试连接」/「正在测试…」＋状态 `ai-connection-test`（默认文案「测试使用固定短提示，不会读取课程内容。」，成功「连接成功：{model}（固定短提示，不读取课程内容）」）（L3154，`app/main.js:4104-4117`）。
17. 「配置状态：连接配置已保存 / 连接配置尚未保存」（L3155）。
18. 「凭据状态：已配置密钥。/ 未配置密钥；运行时会以「缺少密钥」提示，不会伪造回答。/ 不需要密钥（离线连接器）。」（L3156-3162）
19. 密钥输入框（`type=password`，placeholder「粘贴 API Key（不会回显）」/「粘贴新 API Key 以替换本机密钥」）＋按钮「保存密钥」（L3165-3166）。
20. 按钮「删除本机保存的密钥」（danger，未配置时 disabled）（L3168-3170）。
21. 离线连接器（`fake`）专属提示「「本地确定性连接器」是完全离线的自动化测试通道…」（L3085）。

**B. 已有模型服务商**（aiConnectionManagerView，views.js:2971-3002）：
1. 标题「已有模型服务商」＋说明「只显示你创建的 API 连接与已保存的订阅账户；API Key 只显示是否已配置，不会回显。」
2. 按钮「+ 添加模型服务商」（primary，`ai-create-connection`）。
3. 每条连接一行（`ai-connection-row`）：显示名、状态点「当前使用」（`ai-key-state.active`）、「凭据已配置 / 未配置凭据」（`ai-key-state.set/.unset`）、「Provider ID：」「Base URL：（尚未设置）」「协议：」「已配置模型：（无（可手动填写 Model ID））」「默认模型：（未设置）」；按钮「使用 / 当前连接」（`ai-use-provider`）、「编辑」（`ai-edit-connection`）、「删除」（danger，`ai-delete-connection`，仅已保存连接显示）。
4. 空态「还没有 API 连接。点「+ 添加模型服务商」新建一个，填写 Provider ID、Base URL、协议与模型即可。」（L3001）

**C. ChatGPT 订阅登录**（aiSubscriptionSettingsView，views.js:3014-3026）：
1. 标题「ChatGPT 订阅登录」/「OpenAI SIWC · 独立于 API Key」。
2. 原生壳提示「首次登录会为 Workbench 动态注册独立客户端身份。Workbench 不读取其他应用的会话，也不会用环境 API Key 代替订阅授权。」＋按钮「Continue with ChatGPT」、「取消登录」；浏览器壳提示「当前浏览器服务壳不支持订阅登录；请在 macOS 桌面版使用系统浏览器回调与系统钥匙串。这里不会模拟成功状态。」（无登录按钮）。
3. 状态行（`aria-live="polite"`）或提示「授权由你在系统浏览器中完成；Access/Refresh Token 只保存在本机系统钥匙串。」
4. 账户行：名称、"已授权 / 未登录"、「默认模型：…」；按钮「退出登录 / 重新登录 / 删除」（仅原生）。空态「尚未添加 ChatGPT 订阅账户。」

**D. 项目设置页**（settingsView，views.js:2522）中的相关卡片：「02 AI 连接」（当前选择 + 模型 + 「凭据已保存在本机 / 连接尚未配置」＋按钮「管理连接」「打开 AI 助手」）、「03 模型」（`settings-model-list` 前 8 条模型 + 按钮「发现或选择模型」）、「04 账户」（嵌 `aiSubscriptionSettingsView`＋安全说明「Access Token 与 Refresh Token 只保存在本机系统钥匙串；API Key 仅通过已配置的连接管理器保存，页面不会显示密钥。」）。

### 1.5 styles.css 对应类

主要在 `app/styles.css:590-658`（少量响应式在 `app/styles.css:1222-1227`）：

| 类 | 行 | 用途 |
|---|---|---|
| `.ai-block-head` | 590-591 | 分区头（标题+说明+右侧按钮） |
| `.ai-key-state` / `.set` / `.unset` / `.active` | 610-612, 628 | 凭据状态点（绿=已配置、橙=未配置、胶囊=当前使用） |
| `.ai-connection-manager` | 613-615 | 已有连接区容器 |
| `.ai-connection-row` / `.active` | 617-618 | 连接行卡片 |
| `.ai-connection-info` | 619-620 | 行内信息栅格 |
| `.ai-connection-actions` | 621 | 行内按钮组 |
| `.ai-provider-form` | 622-625 | 提供商表单容器 |
| `.ai-model-list` / `.ai-model-list-added` | 629, 634 | 模型 chip 容器 |
| `.ai-model-chip` / `.active` | 630-633 | 模型 chip（含 `aria-pressed` 样式） |
| `.ai-settings-overlay` | 635 | 弹窗遮罩（顶部对齐、5vh 内边距） |
| `.ai-settings-modal` | 636 | 弹窗主体（flex column、max-height 90vh、滚动） |
| `.ai-subscription-settings` / `.ai-subscription-row` | 637-640 | 订阅区/账户行 |
| `.ai-settings-foot` | 645-646 | 页脚（说明+完成） |
| `.ai-connection-test` / `.ok` / `.error` | 647-649 | 测试连接状态文字 |
| `.ai-run-row` | 656-658 | 按钮/输入横向行 |

另有通用类：`.overlay`、`.modal`、`.modal-head`、`.field-label`、`.select`、`.primary`、`.secondary`、`.text-button`、`.danger`、`.ai-hint`、`.muted`、`.eyebrow`、`.icon-button`（样式行号未逐一核对，未确认）。

---

## 2. 数据模型

### 2.1 AiProviderConfig（`src/service/ai_transport.ts:30-42`）

```ts
export interface AiProviderConfig {
  id: string;            // 连接身份；保存后永久固定（§9.4）；格式 ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$（L174）
  label?: string;        // 显示名，可改
  kind?: string;         // "openai_compatible" | "openai_chatgpt_subscription" | "fake"（前端约定，见 main.js:3088、views.js:2969）
  base_url?: string;     // 服务地址；不能内联密钥查询参数；不能带 user:pass（前端 baseUrlIssue main.js:4141-4158）
  chat_path?: string;    // 对话路径，默认 "/chat/completions"
  api_protocol?: string; // "openai-completions" | "openai-responses" | "anthropic-messages"（ai.js:1740-1744）
  auth_header?: string;  // anthropic → "x-api-key"，其余 → "authorization"（ai_transport.ts:638-645）
  auth_scheme?: string;  // anthropic → ""，其余 → "Bearer"
  default_model?: string;
  models?: string[];     // 用户选择加入的模型 ID 列表（trim + 去重，ai_transport.ts:650-664）
  [field: string]: unknown;  // 允许扩展字段，但见 2.4 禁止字段契约
}
```

前端还附加只读元数据 `requires_credential`（`app/main.js:3105`），**提交保存前必须删掉**（`app/main.js:4321`），服务端会把 `requires_credential` 当凭据形状字段拒绝（`src/service/ai_transport.ts:590-593`）。

### 2.2 提供商配置存哪

- **文件，不是 settings**：`providers.json`（`src/service/ai_transport.ts:140`），目录 `<home>/`，home 默认 `<projectDir>/.workspace/ai`（`src/service/ai_transport.ts:948-967`，可由 `options.ai_home` 覆盖）。
- **两个 shell 存储位置不同**（`app/main.js:878-882` 注释）：浏览器服务壳＝项目内 `.workspace/ai`；桌面壳＝app 级 `<app local data>/.workspace/ai`（`src-tauri/src/lib.rs:13551-13575`，`AI_STORE_DIR=".workspace/ai"`、`AI_PROVIDERS_FILE="providers.json"`）。因此桌面壳的连接**跨项目共享**。
- 文件内容结构：`{ providers: AiProviderConfig[], credentials: Record<string,string>, credential_origins: Record<string,string> }`（解析器 `normalizeProvidersState`，`src/service/ai_transport.ts:693-731`；**明文 credentials 槽是旧格式兼容读取**，实际写入钥匙串后只保留 `credential_origins`）。写入 `writeProviders`（L2057-2072）。
- 限额：`MAX_PROVIDERS=50`（L151）、`MAX_PROVIDER_BYTES=8KB`（L152）、`MAX_PROVIDER_DEPTH=4`（L153）、`MAX_PROVIDERS_FILE_BYTES=1MB`，且拒绝符号链接/非普通文件（L1945）。

### 2.3 API Key 存哪、怎么写/读/删

- **存储**：macOS 系统钥匙串。浏览器壳用 `MacKeychainSecretStore`（`src/service/ai_transport.ts:960-962`，account 前缀 `projectKeychainPrefix(projectDirectory)`）；原生壳用 Rust `MacKeychainStore`（`src-tauri/src/lib.rs:13678-13730`，`security` CLI，service 常量 `AI_KEYCHAIN_SERVICE`）。
- **写入**：UI「保存密钥」按钮 → `ai-save-secret`（`app/main.js:11698-11706`，读 DOM 后立刻清空输入框）→ `store.aiSaveSecret(value, providerId)`（`app/main.js:4333-4381`）→ 命令 `ai.secret.set`（`src/service/desktop.ts:2888-2908`）→ `setCredential(providerId, value)`（`src/service/ai_transport.ts:1091-1122`）。校验：非空 trim（L1097-1103「密钥不能为空。」）；长度 ≤8192（L1105-1110「密钥过长，请确认粘贴的内容是否正确。」）；provider 必须已存在（隐式，L1111-1113）；订阅 kind 拒绝（`rejectNativeOnlySubscription`）。写入顺序：先钥匙串、后元数据（L1115-1120 注释：元数据失败时密钥仍可恢复、不产生明文回退）。保存后记录 `credential_origins[providerId] = normalizedOrigin(base_url)`。
- **读取**：**只读"是否存在"**。命令 `ai.connection.list` → `listConnections()`（`src/service/ai_transport.ts:991-1002`）返回 `{ providers, configured: Record<id, boolean>, credential_origins }`；值本身永不返回（注释 "Providers plus credential *presence*; never a credential value"）。前端把结果存 `ui.aiProviders / ui.aiConfigured / ui.aiCredentialOrigins`（`app/main.js:3699-3720`）；「已配置密钥」只信读回结果，不乐观假设（`app/main.js:4330-4331`、测试 `tests/ai_ui_test.ts:1541-1552`）。
- **删除**：按钮「删除本机保存的密钥」→ `ai-delete-secret`（`app/main.js:11707`）→ `aiDeleteSecret`（`app/main.js:4382-4398`，confirm「删除这个服务商在本机保存的 API Key？（课程内容不受影响）」）→ 命令 `ai.secret.delete`（`src/service/desktop.ts:2909-2925`）→ `deleteCredential`（`src/service/ai_transport.ts:1124-1135`）。删除连接会连带删除其密钥（`deleteConnection` L1073-1088）。
- **前端保存密钥前置检查**：未保存的连接会先 `ensureProviderRecord()` 把当前表单落盘（`app/main.js:4309-4324`），否则"键找不到 provider 会被当成未配置"；若表单里的 Base URL 与已绑定 origin 不一致，拒绝并提示「请先保存服务地址并确认 API Key 的新使用域名，再保存密钥」（`app/main.js:4354-4363`）。
- **origin 绑定**：`aiSaveProvider` 在改地址且已有密钥时弹 confirm「此连接的 API Key 当前绑定到 X。目标域名将改为 Y。…」（`app/main.js:4244-4259`）；服务端同样校验，未确认则抛 `providerOriginConfirmationError`（`src/service/ai_transport.ts:1041-1059`），`ai.complete` 时也校验（L1440s）。

### 2.4 禁止字段 / 禁止内联密钥契约

- `SAFE_PROVIDER_FIELDS = "id / label / kind / base_url / chat_path / auth_header / auth_scheme / default_model / models"`（`src/service/ai_transport.ts:172-173`）——错误文案中直接展示。
- `CREDENTIAL_FIELD = /key|token|secret|credential|password|authorization/i`（L170）：**任意层级**出现此类字段名即拒绝（`findForbiddenField` L490-506），文案「服务商配置中出现了不允许的字段「x」。」＋提示「密钥请通过「保存密钥」单独提交。」（`requires_credential` 有专门提示，L586-593）。该正则与原生侧 `sensitive_key`（`src-tauri/src/lib.rs:241, 308`）保持一致，注释明确"两transport 必须拒绝同样的 payload"（L164-169）。
- `DANGEROUS_FIELDS = {"__proto__","constructor","prototype"}`（L171）：克隆时丢弃（`cloneJsonValue` L472-487）。
- **内联密钥查询参数**：`base_url` 的 query 里参数名命中 `CREDENTIAL_FIELD` 即拒绝（`findInlineCredentialField` L509-541），文案「…不允许的密钥查询参数「base_url[query:api_key]」。」。
- 其他：JSON-only（`assertJsonOnly` L543-565，拒 function/symbol/bigint）、深度 ≤4、序列化 ≤8KB、id 必须匹配 `PROVIDER_ID_PATTERN`（L567-569）。保存上限 50 个（L1062-1068）。
- 会话（session）持久化只含 `ai_scope/ai_provider_id/ai_model` 等阅读位（`app/main.js:1969-1971`、校验 L2106-2109）；**不持久化** `aiProviders/aiConfigured/aiExecutions/aiContext/aiResult`，且禁出现凭据形状字段名（测试 `tests/ai_ui_test.ts:1928-1955`）。

---

## 3. 命令面

白名单：`HIGH_LEVEL_COMMANDS`（`src/service/commands.ts:20-96`）；类型声明 `src/ui/contracts.ts:331-346`。前端经 `bridge.command(name, input)` 调用，Tauri 侧名字映射在 `app/main.js:883-898`（如 `ai.connection.save → ai_connection_save`）；AI 命令**不注入 projectDir**（`app/main.js:878-882` 注释）。注册全部在 `src/service/desktop.ts:2815-3048`；原生壳在 `src-tauri/src/lib.rs` 有等价实现（未逐条核对，未确认）。

| 命令 | 入参 | 返回（value） | 错误/边界 |
|---|---|---|---|
| `ai.connection.list` | `{}` | `{ providers: AiProviderConfig[], configured: Record<id,bool>, credential_origins }` | 无项目时返回空列表（desktop.ts:2815-2826，**唯一**在无项目时可用的 AI 命令） |
| `ai.connection.save` | `{ provider, original_id?, require_new?, confirm_credential_origin? }` 或裸 provider | `{ provider }` | `original_id` 与新 id 不一致→ID 不可变错误；`require_new` 撞已有→重复错误（ai_transport.ts:1011-1071）。**注意：当前前端未传 `original_id/require_new`**（app/ 内 grep 无命中），改名防线仅靠 UI（aiSetProviderId） |
| `ai.connection.delete` | `{ provider_id }` | `{ provider_id, removed }` | 连带删除钥匙串密钥（ai_transport.ts:1073-1088） |
| `ai.secret.set` | `{ provider_id, value }` | `{ provider_id }`（**绝不含 value**） | 空/超长拒绝；audit 记 `{ has_value: true }`（desktop.ts:2888-2908） |
| `ai.secret.delete` | `{ provider_id }` | `{ provider_id, removed }` | |
| `ai.models.list` | `{ provider_id, base_url?, timeout_ms? }` | `{ provider_id, models: AiModelEntry[], model_ids, display_names, endpoint }` | 用已存密钥；不支持 /models 的端点抛可读 ServiceError，UI 转手填（ai_transport.ts:1139-1160+） |
| `ai.models.probe` | `{ provider, temporary_credential }` | 同上 shape | 临时密钥只传一次、不落盘（前端 aiDiscoverModels main.js:3958-3970） |
| `ai.connection.test` | `{ provider_id }` | `{ provider_id, model, endpoint }` | 固定短提示，不读课程内容（ai_transport.ts:1306） |
| `ai.complete` | `{ provider_id, url?, headers?, auth?, body, timeout_ms?, request_id? }` | `AiTransportResult`（status/headers/body/response_kind） | 认证请求 URL 钉在已存 provider 端点；缺密钥→`missing_credential`；origin 不符→确认错误（ai_transport.ts:1358-1457） |
| `ai.cancel` | `{ request_id }` | `{ cancelled }` | 幂等、无项目也可用（desktop.ts:2997-3014） |
| `ai.subscription.start/status/cancel/logout` | `{ provider_id? }/{ attempt_id }` 等 | attempt 状态对象 | 浏览器壳一律抛 `subscription_native_only`（desktop.ts:2866-2887） |
| `ai.execution.append/list` | `{ record }` / `{ limit }` | `{ id, ... }` / `{ records }` | 非规范数据，失败只软提示（main.js:4399-4419） |
| （旧）`secret.set/secret.delete` | `{ provider, value }` | `{ provider }` | 连接器通用密钥，与 AI 无关（desktop.ts:2788-2810） |

**错误契约**（`src/service/errors.ts:150-208`、`src/service/ai_transport.ts:448-458`）：

- `ErrorObject = { code, user_message, technical_message, severity, recoverable, recommended_action, details }`；跨桥传输时外层包 `{ error: ... }`（errors.ts:150-173），兜底中文「这项操作没有完成。工作台仍可继续使用，请重试。」（L180）。
- `invalidRequest(userMessage, technicalMessage, recommendedAction?)`（ai_transport.ts:448-458）固定产出 `code="invalid_request"`、`recoverable=true`，**中文文案规范**：
  - `user_message`：中文、面向用户、以句号结尾、**不回显坏值**（粘贴的 URL 可能本身带密钥，见 main.js:4137 注释）；
  - `technical_message`：英文、开发者可读（如 `"Invalid provider id: ..."`、`"Credential-shaped provider field rejected: x"`）；
  - `recommended_action`：中文、给出下一步（如「密钥请通过「保存密钥」单独提交。」「请在「设置 → 模型」里选择上面三种协议之一。」）。
- 其他码：`not_configured`（L460-469）、`missing_credential`（L1420s，带 recommended_action「在 AI 面板点击该服务商的「保存密钥」…」）、`read_only_project`（L973-986）、`subscription_native_only`（desktop.ts:2874-2887）。前端把错误转 `AiFailure`（`app/ai.js`，`normalizeAiProviderResponse` L2224-2340），面板按 code 显示标题（`authentication_failed → "服务商认证失败（401）"`、`missing_credential → "本机尚未保存 API Key"`，views.js:3341-3352）。

---

## 4. 已有能力盘点

### 4.1 已实现（含实现位置）

| 能力 | 实现位置 |
|---|---|
| 打开/关闭设置弹窗、关闭清密钥输入 | `app/main.js:3786-3804`；actions `app/main.js:11655-11660` |
| 添加提供商（空表单，预填随机 id） | `aiCreateConnection` `app/main.js:3758-3785`；按钮 views.js:2972 |
| 编辑提供商（打开表单） | `aiEditProvider` `app/main.js:3721-3750`（设置打开/刷新表单、focusField="ai-provider-label"） |
| Provider ID 校验 + 永久固定 | `providerIdIssue` `app/main.js:3115-3123`；`aiSetProviderId` `app/main.js:4017-4041`；输入绑定 change/blur `app/main.js:12162-12169` |
| 保存配置（含协议/地址校验、origin 确认） | `aiSaveProvider` `app/main.js:4179-4299`；提交聚合 `app/main.js:11665-11692`；`rememberProviderForm` `app/main.js:4164-4177`（拒绝时保留已填内容） |
| 协议选择（3 种） | `AI_API_PROTOCOLS` `app/ai.js:1740-1744`；下拉 views.js:3077-3082；auth 头按协议派生（main.js:3096-3100、ai_transport.ts:638-645） |
| 读取可用模型（真探测，非硬编码） | `aiDiscoverModels` `app/main.js:3909-4002`（已存密钥走 `ai.models.list`，未保存表单走 `ai.models.probe` + 临时密钥，用完即清 L3946-3949）；服务端 `listAiModels` `src/service/ai_transport.ts:1146+`、`probeAiModels` L1233+ |
| 模型搜索 | 前端过滤 `app/views.js:3053` + DOM 隐藏 `app/main.js:12170-12178` |
| 模型多选 → 加入所选 | `aiToggleModelSelection` `app/main.js:4043-4053`、`aiAddSelectedModels` `app/main.js:4058-4081`（仅表单态，保存前不落盘 §9.5） |
| 设默认模型（点已加入 chip） | `aiPickModel` `app/main.js:4004-4011` |
| 手动 Model ID（探测失败兜底） | views.js:3139-3146；输入即改预览 `app/main.js:12137-12161` |
| 凭据状态点（已配置/未配置/当前使用） | views.js:2985-2989（`ai-key-state`）+ styles.css:610-612,628；数据源 `aiConfiguredMap` views.js:2900-2904 |
| 保存状态（配置已保存/未保存、凭据状态分开显示） | views.js:3155-3162 |
| 测试连接 | `aiTestConnection` `app/main.js:4082-4120`（要求先保存且已存密钥）；服务端 `testAiConnection` ai_transport.ts:1306 |
| 保存/删除密钥（只写不读） | `aiSaveSecret` `app/main.js:4333-4381`、`aiDeleteSecret` `app/main.js:4382-4398`、`ensureProviderRecord` `app/main.js:4309-4324` |
| 凭据 origin 绑定 + 换域确认 | main.js:4244-4259, 4354-4363；ai_transport.ts:1041-1059, 1118-1119 |
| 删除连接（confirm + 清选择） | `aiDeleteConnection` `app/main.js:3875-3903` |
| ChatGPT 订阅登录/退出/删除 | `aiSubscriptionStart/Cancel/Logout` `app/main.js:3805-3874`；UI views.js:3005-3027；仅原生壳 |
| 助手面板与配置分离（§9.7） | assistantPanel views.js:3320-3507（空态只给「配置 AI」） |
| 执行记录只显示当前项目 | `aiLoadExecutions` `app/main.js:4408-4419` |
| 会话持久化阅读位、不持久化凭据/连接 | main.js:1969-1971, 2106-2109；测试 ai_ui_test.ts:1928-1955 |

### 4.2 DSH Models 页有、这里没有的（差距盘点）

依据改造目标描述（提供商行卡片 + 折叠自定义设置 + 添加提供商分段卡片 + 模型行编辑 + 推理等级）与本仓库规格 §9/反馈 §7 的 DSH 描述比对：

1. **添加提供商的分段卡片**：反馈文档 §7.2 的目标结构是「添加模型提供商 → 第三方模型提供商 / 自定义模型 API / 订阅登录」三段（`V1_Feedback_...2026-09-30.md:253-264`）；现状是单一「+ 添加模型服务商」直接开自定义表单（views.js:2972），订阅区固定在下方（无选择分段）。
2. **折叠式自定义/高级设置**：现状表单全部平铺（views.js:3064-3172），没有折叠区；反馈 §7.2:270 明说「高级兼容参数可按需折叠」。
3. **模型行编辑**：现状模型是 chip（点选设默认），**没有**行级「编辑/移除单个模型」操作（app/ 内 grep 无 remove-model action；仅 `ai-pick-model` main.js:11694）。也没有每模型元数据行（显示名/输入类型/容量，反馈 §7.2:270）。
4. **推理等级（reasoning effort）**：全仓 app/、src/ 无 reasoning-effort 概念（grep 仅命中订阅阶段文案 `app/ai.js:528, 646-647`）。`AiProviderConfig` 也没有承载每模型推理参数的字段。相关规格只说「推理参数…必须遵守实际协议及提供商能力」（反馈 §7.3:286）。
5. **提供商行卡片的信息架构**：现状 `ai-connection-row` 是"平铺小字段列表 + 右侧按钮"（views.js:2983-2999），无"行卡 + 展开区"结构。
6. **内置第三方提供商目录**：DSH 有预置提供商，但 Workbench §9.2 **明确禁止**（见 6.3），这不是差距而是红线，改造时不能"补"。

（DSH 客户端实现打包在 asar 内、无法直接检索，以上 DSH 能力对照依据本仓库规格文档与改造目标描述，DSH 内部实现细节**未确认**。）

---

## 5. 测试与验收约定

### 5.1 tests/ai_ui_test.ts（1955 行）——UI 怎么测

- **不是真 DOM**：`bootStore()`（`tests/ai_ui_test.ts:142-453`）注入伪 `document`/`root`（`querySelector` 返回 null、`innerHTML` 是普通字符串，L166-190）＋**内存假 bridge**（L199-…，按命令名模拟 `ai.connection.list/save/delete、ai.models.list/probe、ai.connection.test、ai.secret.set/delete、ai.complete…`，并记录 `state.calls`）。`fetch` 一律抛错（L192-194）。
- **起 store**：真 `WorkbenchStore` ＋ 真 `app/ai.js`；夹具 `seedCourse()`（L455-465）建两课各一段。`until()`（L132-139）做 2s 轮询等待。
- **DOM 断言方式**：全部是**渲染后 HTML 字符串断言**——`root.innerHTML.includes(...)`/`indexOf`（例：L1518-1527、L1701-1717），或直接 `createViews(store).shellView()` 取字符串（L471-478，动态 import 带 cache-bust query `?ai-new-connection-N`）。没有任何 DOM 查询类断言。
- **代表性用例**（改造会直接踩到的）：
  - L467-482「creating a connection renders its editable form before the connection list」：**断言表单必须出现在连接列表之前**（`form < manager`），且必须含 `data-ai-base-url`、`data-ai-api-protocol`。
  - L1485-1556「the panel never renders a provider credential value」：密钥绝不进 `ui`、绝不渲染；必须出现「已配置密钥」「macOS 系统钥匙串」「课程文件不含凭据」；删除后"已配置"必须来自读回。
  - L1558+「connection management keeps provider metadata, keys, models, and selection scoped by id」。
  - L1694-1721「AI settings use one topbar modal; close clears a temporary key and preserves assistant input」：必须是 `ai-settings-modal` 弹窗、必须有协议选择、必须显示「连接配置尚未保存」、关闭清密钥输入但保留助手指令、助手不得有连接选择器（L1703 断言**不存在** `data-ai-provider` select）。
  - L1723-1764 订阅 native-only；L1766+ 临时密钥只发一次；L1795+ 密钥读不回就不算已配置；L1928-1955 session 不含凭据/连接状态。
- confirm() 需手动 stub 成 true（L1530-1539）。

### 5.2 tests/ai_provider_config_test.ts（499 行）

纯模块测试（无 DOM、无 store）：直接 import `app/ai.js` 的 `normalizeAiConnection / aiApiProtocolChoices / aiModelDiscoveryPlan / AI_API_PROTOCOLS / AiFailure` 等（L19-30）。断言 §9.x 契约：恰好三种协议及 DSH 文案（L92）、**无任何预置提供商模板目录**（L138-186）、id 必填且是身份（L223）、协议未知拒绝（L267）、auth 头/方案按协议派生（L287）、模型字段 trim/去重/可空（L353-381）、探测计划按协议推导且不带密钥（L382-486）。错误断言统一走 `assertAiFailure`（L43-60）：`AiFailure.code` ＋ **必须有非空 `recommended_action`**。

### 5.3 怎么跑（deno.json:3-5）

- `deno task check`：`deno check` 全部 app/*.js + src 关键 ts + **每个测试文件**（含 tests/ai_ui_test.ts、tests/ai_provider_config_test.ts）。
- `deno task test`：`deno test --allow-read --allow-write --allow-net=127.0.0.1 --allow-run --allow-env=TMPDIR` ＋ 显式测试文件清单（新增测试文件**必须手工加进这两个任务的清单**）。
- `deno task ui`：起 scripts/dev_server.ts（浏览器壳）。
- 其他相关：`tests/ai_transport_test.ts`（2362 行，服务端契约/密钥防泄漏）、`tests/ai_workflow_test.ts`（3069 行，Suggestion/ChangeDraft/Apply）、`tests/ai_subscription_stages_test.ts`。

### 5.4 新增 UI 需要补哪些测试

沿用现有模式（bootStore + HTML 字符串断言）：
1. 新结构渲染断言（新 DOM 类名/data-* 选择器存在、区块顺序）。
2. 旧断言兼容性：`form < manager` 顺序（ai_ui_test.ts:473-476）、`ai-settings-modal`、协议 select、密钥字段 `data-ai-secret`、状态文案「连接配置尚未保存/已保存」等**被逐字断言的中文文案**不能随意改。
3. 新交互的 store 方法级测试（如折叠展开、模型行编辑、推理等级选取 → 表单态 → 保存 payload）。
4. 若新增 `aiProviderConfig` 字段：`tests/ai_provider_config_test.ts`（normalize 契约）＋ `tests/ai_transport_test.ts`（服务端拒绝/接受）。
5. 安全回归：密钥不渲染、不进 ui/session、CREDENTIAL_FIELD 拒绝（新字段命名必须过 `/key|token|secret|credential|password|authorization/i` 检查）。
6. 新测试文件要加进 deno.json 的 check/test 清单。

---

## 6. 改动落点清单：改造成"仿 DSH Models 页"

### 6.1 UI 渲染层（app/views.js）

| 目标 | 函数 / 位置 | 要动什么 |
|---|---|---|
| 提供商行卡片 + 折叠自定义设置 | `aiConnectionManagerView` `app/views.js:2961-3003` | 行卡片重构（信息层级、展开/折叠控件）；折叠态需要新的 `ui.*` 状态 |
| 添加提供商分段卡片 | `overlayView` 的 aiSettingsOpen 分支 `app/views.js:3840-3852` ＋ 新增分段选择视图 | 「第三方模型提供商 / 自定义模型 API / 订阅登录」分段（§7.2:253-264）；订阅区从固定区改为分段之一 |
| 表单（含模型行编辑） | `aiProviderFormView` `app/views.js:3037-3173` | chip → 模型行（行内编辑/删除/设默认/推理等级）；`ai-model-chip` 相关 markup（L3110-3137）重做 |
| 订阅区分段 | `aiSubscriptionSettingsView` `app/views.js:3005-3027` | 接入分段卡片；保留 native-only 分支 |
| 项目设置页入口卡 | `settingsView` `app/views.js:2505-2523` | 「管理连接/发现或选择模型」按钮与卡片文案随新结构调整 |
| 助手面板（不动逻辑，只核对） | `assistantPanel` `app/views.js:3320-3507` | §9.7 红线：不得把新配置 UI 渗回助手 |

### 6.2 样式（app/styles.css）

- `app/styles.css:590-658`：`.ai-connection-row/.ai-connection-info/.ai-provider-form/.ai-model-list/.ai-model-chip/.ai-settings-modal/.ai-settings-foot/.ai-key-state/.ai-connection-test/.ai-run-row` 等全部随新结构调整/新增（折叠控件、模型行、分段卡）。
- 响应式补丁 `app/styles.css:1222-1227`。

### 6.3 交互与状态（app/main.js）

| 目标 | 位置 | 要动什么 |
|---|---|---|
| 新 action 分发 | `handleAction` 的 AI 段 `app/main.js:11648-11707` | 新增/改造 case：分段切换、折叠切换、模型行编辑/删除/设默认、推理等级选取 |
| 新字段输入绑定 | `app/main.js:12137-12178` | 模型行/推理等级等输入的即时同步（注意"不重渲染以保 IME/光标"惯例 L12137-12139） |
| 表单状态机 | `aiCreateConnection` 3758-3785、`aiEditProvider` 3721-3750、`rememberProviderForm` 4164-4177、`aiSaveProvider` 4179-4299、`aiAddSelectedModels` 4058-4081、`aiPickModel` 4004-4011、`aiToggleModelSelection` 4043-4053 | 新表单态字段（折叠态、每模型编辑态、推理等级）；保存 payload 聚合（`app/main.js:11665-11692`） |
| UI 状态初始化/清理 | ui 默认值 `app/main.js:1763-1770` 附近、`resetAiState` 3669-3682、`aiCloseSettings` 3795-3804 | 新 ui 字段纳入初始化与关闭清理；**临时密钥清理逻辑不能弱化** |
| 密钥流（尽量不动） | `aiSaveSecret` 4333-4381、`aiDeleteSecret` 4382-4398、`ensureProviderRecord` 4309-4324 | 若行内编辑引入"每模型密钥"之类需求，必须仍走同一套只写不读 + origin 绑定 |
| 连接记录规范化 | `connectionRecord` `app/main.js:3082-3107` | 新字段透传时保持 auth 派生与 `requires_credential` 删除规则（4321） |

### 6.4 协议/规范化层（app/ai.js）

- `AI_API_PROTOCOLS` `app/ai.js:1740-1744`：**不动**（三协议文案被测试锁定）。
- `normalizeAiConnection`（app/ai.js，测试 `ai_provider_config_test.ts:223-367` 锚定）：若每模型元数据/推理等级入连接记录，需扩字段并保持"只留连接字段、复制语义"。
- `aiModelDiscoveryPlan`：模型行如需携带显示名/推理等级，探测结果映射（`aiDiscoveredModelIds`、`display_names`，main.js:3971-3974）要对应。

### 6.5 服务层（src/service/ai_transport.ts + src-tauri/src/lib.rs）

- `AiProviderConfig` `src/service/ai_transport.ts:30-42`：新增字段（如每模型设置、`reasoning_effort`）必须：
  1. 字段名**不得**命中 `CREDENTIAL_FIELD`（L170）——`reasoning_effort` 安全，`api_key/token/...` 会被拒；
  2. 进 `SAFE_PROVIDER_FIELDS` 文案（L172-173）与 `normalizeProviderConfig` 白名单校验（L572-664）；
  3. 满足 `MAX_PROVIDER_BYTES=8KB`/`MAX_PROVIDER_DEPTH=4`（L152-153）。
- `normalizeProviderConfig` / `normalizeProvidersState`（L572-731）：读旧文件的向后兼容（`coerceProviderEntry`）。
- **原生壳等价实现**：`src-tauri/src/lib.rs` 的 providers.json 解析与 `sensitive_key`（lib.rs:241,308）必须同步接受新字段，否则桌面壳会拒掉浏览器壳能存的配置（ai_transport.ts:164-169 注释明示此约束）。原生侧具体解析点在 `lib.rs:13551-13575` 附近（细节未逐行确认）。
- 若"推理等级"参与请求体：`completeAiRequest`（L1358-1457）/ 各协议请求构造（`src/service/ai_transport.ts` 请求构造段）；反馈 §7.3:286 要求"推理参数必须遵守实际协议及提供商能力，不无条件塞入同一请求体"。

### 6.6 测试落点

- `tests/ai_ui_test.ts:467-482`（表单在列表前、字段存在）、`1485-1556`（密钥不渲染）、`1694-1721`（单弹窗/关闭清理/状态文案）、`1766+`（临时密钥）——**结构改动必改这些断言**，且注意它们逐字断言中文文案。
- `tests/ai_provider_config_test.ts`（协议/模板/字段契约）、`tests/ai_transport_test.ts`（服务端字段校验、密钥防泄漏）、`tests/ai_workflow_test.ts`（若有请求体变化）。
- 新测试加入 `deno.json` 的 check/test 清单。

### 6.7 硬约束（不能破坏）

1. **§9.2 无预置提供商模板**：不得出现 Volcengine/OpenAI/Anthropic/DeepSeek 预置卡片或隐藏目录（`tests/ai_provider_config_test.ts:138-186` 专门守护；"添加提供商分段卡片"只能是**类型**分段，不能是预置厂商目录）。
2. **密钥永不落 UI/日志/课程文件**：渲染层不回显、`ui`/`session` 不含值与凭据形状字段名（ai_ui_test.ts:1485-1556、1928-1955）；配置 payload 禁止凭据形状字段与内联 query 密钥（ai_transport.ts:490-541）；与 Rust `sensitive_key` 保持一致（lib.rs:241）。
3. **Provider ID 永久固定 + 凭据 origin 绑定**：`ai.connection.save` 的 `original_id/require_new` 契约（ai_transport.ts:1011-1071）；换域必须显式确认（main.js:4244-4259；ai_transport.ts:1041-1059）。
4. **错误文案规范**：`user_message` 中文、`technical_message` 英文、`recommended_action` 中文非空；不回显坏输入值（ai_transport.ts:448-458；ai_provider_config_test.ts:43-60）。
5. **§9.7 助手面板无配置 UI**（ai_ui_test.ts:1703 断言不存在连接选择器）；**§9.5 探测结果保存前不落盘**、**§9.6 多选只进表单**。
6. **无障碍**：`aria-haspopup="dialog"`、`role="dialog"`/`aria-modal`/`aria-labelledby`、chip 的 `aria-pressed`、状态 `aria-live`、`data-focus-key` 焦点恢复（main.js:1763+ focusField 机制）、`data-stop-click` 防冒泡、关闭时清理密钥输入（ai_ui_test.ts:1713）。
7. **中文文案被测试逐字断言**（如「连接配置尚未保存」「已配置密钥」「macOS 系统钥匙串」「课程文件不含凭据」），改文案需同步改测试。
8. 测试/表单结构断言：`aiProviderFormView` 必须渲染在 `aiConnectionManagerView` 之前（ai_ui_test.ts:473-476）——若新布局改变顺序，必须有意更新该测试。

---

## 附：未确认事项

- 原生壳 `src-tauri/src/lib.rs` 中 `ai_connection_save` 等命令的逐条实现与字段校验细节（只确认了 `sensitive_key` lib.rs:241,308、`AI_PROVIDERS_FILE`/钥匙串 lib.rs:13551-13730）。
- DSH 客户端自身 Models 页的实现细节（打包于 app.asar 无法检索）；§4.2 差距对照依据本仓库规格文档与改造目标描述。
- `app/styles.css` 通用类（`.modal`、`.field-label` 等）的确切行号。
- `ai.models.list/probe` 返回的 `AiModelEntry` 完整字段（只确认 `{ id, label }` 形状来自测试假件 tests/ai_ui_test.ts:223-238）。
