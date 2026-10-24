# 设计：AI 模型配置界面仿 DeepSeek Harness「设置 → 模型」

- 日期：2026-10-24
- 状态：已定案，按本文契约实施
- 依据：`docs/research/dsh-model-config-ui-spec.md`（DSH 逆向规格）、`docs/research/workbench-ai-config-current.md`（现状调研）、产品反馈规格 `V1_Feedback_Import_Rendering_AI_Settings_2026-09-30.md` §7.2–§7.4、`docs/research/rea-tool-evaluation.md`（不使用 rea 的结论）

---

## 0. 目标与非目标

**目标**：把 AI 设置弹窗里的模型配置区改造成 DSH「设置 → 模型」的界面与逻辑——提供商行卡片 + 行内编辑卡 + 「自定义设置」折叠区 + 「＋ 添加模型提供商」分段卡片 + 模型目录行编辑 + 「获取可用模型」选择弹窗 + 推理等级，并复刻其视觉规范（去品牌化）。

**非目标**：
- 不引入任何**厂商预置目录/模板**（§9.2 红线，`tests/ai_provider_config_test.ts:138-186` 守护）。
- 不复制 DeepSeek 品牌资产（logo、商标、品牌蓝 #4176e6/#7aaaff、DeepSeek 账号行、欢迎语）。
- 不改助手面板（§9.7：助手无配置 UI）、不改订阅鉴权协议本身、不改三种 API 协议标识与文案（`app/ai.js:1740-1744` 被测试锁定）。
- 不做设置页多级导航改造（DSH 的 settings.section 导航体系不搬）；本项目仍是单一 `ai-settings-modal` 弹窗。
- 不改凭据安全模型：密钥仍只写、只进系统钥匙串、不进 ui/session/课程文件。

**逆向工具**：不使用 rea。DSH 仓库公开且 MIT（`packages/client/ui-settings-models/` 源码 + 官方用户指南与截图），逆向打包产物无增量价值，结论见 `docs/research/rea-tool-evaluation.md`。

---

## 1. 与 DSH 的必要偏差（受本项目契约约束）

| DSH | 本项目 | 原因 |
|---|---|---|
| 「添加模型提供商」内含**内置厂商目录**（anthropic/openai/moonshotai/zai…） | 分段只按**类型**：`第三方兼容 API` / `自定义模型 API` / `订阅登录` | §9.2 禁止预置提供商模板 |
| 目录提供端点/协议/模型默认值 | 端点、协议、模型全由用户填写或「获取可用模型」探测 | 同上 |
| 首次运行弹窗（预览声明 + DeepSeek 凭据引导） | 不做 | 品牌合规 + 无预置提供商 |
| DeepSeek 账号行（`deepseek-account`） | 不做 | 品牌合规 |
| 推理等级档位取自 llm-pi-ai schema | 档位固定 `off/minimal/low/medium/high/xhigh/max`，按协议映射请求参数 | 无 pi-ai |
| 设置分区多级导航 | 单一弹窗 | 保持 §9.7 与现有入口 |
| 模型选择器是会话 composer 的两级菜单 | 仅做模型目录选择弹窗（「获取可用模型」→「更新列表」） | 本次范围 |

---

## 2. 目标界面结构

弹窗骨架不变（`section.modal.ai-settings-modal`，`app/views.js:3851`）。内部自上而下：

```text
section.modal.ai-settings-modal
├─ header.modal-head（眉题「应用设置 · 模型」+ 标题「AI 模型」+ 关闭「×」）
├─ p.muted  「设置连接、协议、模型与本机凭据。配置保存、模型发现和连接测试分别显示状态。」
├─ p.ai-save-status[aria-live=polite]  「已保存 {显示名}。」（保存成功后显示，切换编辑即清）
├─ section.ai-provider-rows                    ← 提供商行列表
│  └─ article.ai-provider-row[.active][data-provider-id]
│     ├─ header.ai-provider-row-head
│     │  ├─ b.ai-provider-name   显示名
│     │  ├─ span.ai-badge.ai-badge-custom 「自定义」（kind 非 fake/订阅时）
│     │  ├─ span.ai-key-dot[.set/.unset] + span 文案「凭据已配置 / 未配置凭据」
│     │  ├─ span.ai-key-dot.active + 「当前使用」（仅当前连接）
│     │  └─ div.ai-provider-actions
│     │     ├─ button.text-button[data-action="ai-edit-connection"] 「编辑」/「收起」
│     │     ├─ button.text-button[data-action="ai-use-provider"] 「使用」/「当前连接」
│     │     └─ button.text-button.danger[data-action="ai-delete-connection"] 「删除」
│     ├─ p.ai-hint.danger[data-ai-row-error]（该行目录/保存诊断）
│     └─ div.ai-provider-editor（仅该行展开时）  ← 行内编辑卡，结构见 §2.1
├─ section.ai-add-card                         ← 「＋ 添加模型提供商」
│  ├─ div.ai-block-head
│  │  ├─ b「添加模型提供商」
│  │  └─ button.primary[data-action="ai-create-connection"] 「＋ 添加模型提供商」/「收起」
│  └─ div.ai-add-card-body（展开时）
│     ├─ div.ai-segmented[role=tablist][data-ai-add-tabs]
│     │  ├─ button.ai-segment[.active][role=tab][data-action="ai-add-tab"][data-tab="third-party"]「第三方兼容 API」
│     │  ├─ button.ai-segment[role=tab][data-action="ai-add-tab"][data-tab="custom"]「自定义模型 API」
│     │  └─ button.ai-segment[role=tab][data-action="ai-add-tab"][data-tab="subscription"]「订阅登录」
│     ├─ p.ai-hint[data-ai-add-tab-hint]  所选方式用途说明（文案见 §3）
│     └─ div.ai-add-panel（按 tab 渲染；third-party/custom 复用 §2.1 编辑卡，subscription 渲染现有订阅区）
└─ div.ai-settings-foot
   ├─ span「AI 配置仅保存连接元数据；密钥和订阅令牌写入{aiStorageLabel()}，课程文件不含凭据。」
   └─ button.secondary[data-action="ai-close-settings"]「完成」
```

### 2.1 编辑卡（行内编辑卡与新增卡共用同一渲染函数 `aiProviderEditorView(draft, mode)`）

```text
div.ai-provider-editor
├─ label.field-label「API 密钥」
│  └─ div.ai-secret-row
│     ├─ input.select[type=password|text][data-ai-secret][data-provider-id][autocomplete="new-password"]
│     │    placeholder：「留空使用已保存凭据」（已有密钥）/「输入 API 密钥」（无密钥且无环境后备）
│     │                /「留空使用环境认证」（无密钥但有环境后备）
│     └─ button.icon-button[data-action="ai-toggle-secret-visible"] 「显示密钥」/「隐藏密钥」
│        （输入非空才渲染；切换只改 type，不改值）
├─ p.ai-hint[data-ai-auth-hint]  认证说明（见 §3 凭据提示推导）
├─ button.ai-collapse-toggle[data-action="ai-toggle-advanced"][aria-expanded]
│   「自定义设置」▸ / ▾
├─ div.ai-advanced（折叠区展开时）
│  ├─ label.field-label「显示名称」 input[data-ai-provider-label]
│  ├─ label.field-label「API 地址」 input[data-ai-base-url]  placeholder「https://gateway.example/v1」
│  │   └─ p.ai-hint[data-ai-base-url-hint]（地址配置变量名 / 协议端点示例）
│  ├─ label.field-label「API 协议」 select[data-ai-api-protocol]（三选项不变）
│  ├─ div.ai-model-section
│  │  ├─ div.ai-block-head
│  │  │  ├─ b「模型目录」
│  │  │  └─ div: button.secondary[data-action="ai-discover-models"]「获取可用模型」
│  │  │           button.text-button[data-action="ai-reset-models"]「恢复默认模型」
│  │  ├─ p.ai-hint.warning[data-ai-models-error]
│  │  ├─ div.ai-model-rows[data-ai-model-rows]
│  │  │  └─ div.ai-model-row[data-model-key][.expanded]
│  │  │     ├─ div.ai-model-row-head
│  │  │     │  ├─ button.icon-button.ai-drag[data-action="ai-move-model"][data-dir="up|down"]「↑」「↓」
│  │  │     │  ├─ code.ai-model-id  模型 id
│  │  │     │  ├─ button.text-button[data-action="ai-edit-model"]「编辑」/「收起」
│  │  │     │  └─ button.text-button.danger[data-action="ai-remove-model"]「移除」
│  │  │     └─ div.ai-model-row-body（展开时）
│  │  │        ├─ label「Model ID」 input[data-ai-model-id]
│  │  │        ├─ label「显示名称」 input[data-ai-model-name]  placeholder「留空显示 Model ID」
│  │  │        ├─ div.ai-model-caps（两列）
│  │  │        │  ├─ label「上下文窗口」 input[data-ai-model-context]
│  │  │        │  └─ label「最大输出 token」 input[data-ai-model-max-tokens]
│  │  │        ├─ fieldset.ai-model-input-type「输入类型」
│  │  │        │  ├─ label checkbox[data-ai-model-input-text]「文本」
│  │  │        │  └─ label checkbox[data-ai-model-input-image]「图片」
│  │  │        └─ div.ai-reasoning（仅协议支持时）
│  │  │           ├─ label.switch[data-action="ai-toggle-model-reasoning"]「推理等级」+ button.icon-button「?」
│  │  │           └─ div.ai-reasoning-rows（开关打开时）
│  │  │              └─ div.ai-reasoning-row[data-tier-key]
│  │  │                 ├─ select[data-ai-tier-name]（off/minimal/low/medium/high/xhigh/max，每档只用一次）
│  │  │                 ├─ input[data-ai-tier-value]「API 参数值」（off 行禁用）
│  │  │                 └─ button.text-button.danger[data-action="ai-remove-tier"]「移除」
│  │  │              + button.text-button[data-action="ai-add-tier"]「添加档位」
│  │  └─ p.ai-hint「仅声明上游模型实际能够处理的输入类型与推理能力。」
│  └─ label.field-label「手动添加 Model ID」 input[data-ai-model-manual] + button.secondary[data-action="ai-add-manual-model"]「添加」
├─ div.ai-run-row
│  ├─ button.primary[data-action="ai-save-provider"]「保存」
│  ├─ button.secondary[data-action="ai-cancel-provider"]「取消」
│  ├─ button.secondary[data-action="ai-test-connection"]「测试连接」/「正在测试…」
│  └─ span.ai-connection-test[data-ai-connection-test]
└─ div.ai-editor-status
   ├─ p.ai-hint「配置状态：连接配置已保存 / 连接配置尚未保存」
   └─ p.ai-hint「凭据状态：已配置密钥。/ 未配置密钥；运行时会以「缺少密钥」提示，不会伪造回答。/ 不需要密钥（离线连接器）。」
```

**一次只展开一张编辑卡**：行卡编辑器与新增卡互斥（打开一个自动收起另一个），但**草稿互不丢弃**（两个 draft 槽各存各的）。


---

## 2.2 实测表单顺序与文案（以官方截图为准，优先级高于 §2.1 的示意）

来源：`docs/user/guide/providers-models-page.zh.png`（行内编辑卡）与 `providers-custom-form.zh.png`（创建表单），路径 `/tmp/dsh-research/full/deepseek-harness-master/docs/user/guide/`。

**A. 行内编辑卡（编辑已有提供商）**，自上而下：
1. 行头：**显示名加粗** `DeepSeek` ＋ 紧邻灰字小号 **Provider ID** `deepseek-official`（同一行，不是单独的「Provider ID：」小字行）。
2. 「API 密钥」label ＋ 输入框（placeholder「输入 API 密钥」），**通栏**。
3. **分隔线**（1px 浅灰，通栏）。
4. 「› 自定义设置」折叠行（chevron 在左，点击展开）。
5. 右下角按钮组：「取消」（白底描边）｜「保存」（**黑底白字**，圆角明显更大，约 R16）。

**B. 创建表单（新增卡，展开全部字段）**，自上而下：
1. 分段控件：「第三方模型提供商」｜「自定义模型 API」（白底选中胶囊 + 描边，灰底轨道）。
2. 一行小字说明所选方式用途。
3. **Provider ID**（placeholder `acme-gateway`）＋ 帮助文字「以小写字母开头的标识，在请求中唯一标识该提供商，并用于派生凭据名。」
4. **显示名称**（placeholder「显示名称」）
5. **API 地址**（placeholder `https://gateway.example/v1`）
6. **API 协议**（select，宽度约为其他输入的一半，显示「OpenAI Chat Completions」）
7. **API 密钥**（placeholder「输入 API 密钥」）
8. **分隔线**
9. **模型目录** 行：左侧「模型目录」标题，**右侧**文字按钮「获取可用模型」。
10. 空态：**虚线圆角框**居中文字「模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。」
11. 「＋ 添加模型」按钮（白底描边）。
12. 右下角：「取消」｜「**创建提供商**」（保存类主按钮在创建态的文案是「创建提供商」，禁用时灰底）。

**C. 「＋ 添加模型提供商」入口**：**虚线描边的通栏按钮**（居中「＋ 添加模型提供商」），不是带标题的卡片头。

**D. 引言文案**：标题「模型」＋ 一句「填入各提供商的 API 密钥即可使用其模型。」

**D2. 文案取值优先级定案（2026-10-24）**：§2/§3 若与本节（§2.2，逐字取自官方截图）不一致，**一律以本节为准**。两处已知不一致按本节取值：分段第一段的标签是「**第三方模型提供商**」（不是 §2/§3 写的「第三方兼容 API」）；「自定义模型 API」段的用途说明是「**连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口，需填写 API 地址、协议和模型。**」（不是 §3 写的「网关、自建服务…」）。实现已按本节落地，后续不得改回去。

**D3. 行列表范围定案（2026-10-24）**：提供商行列表只含 API 连接，**排除**订阅账户（归订阅段管理）与离线连接器（`fake`，内部确定性测试通道）。这是改造前 `aiConnectionManagerView` 的既有过滤（旧 views.js:2968 逐字相同），不是本次引入。因此离线连接器的「不需要密钥（离线连接器）。」只在新增卡里 Provider ID 命中它时可达（views.js:3375），文案按该路径锁定。

**E. 两段的差异（无厂商预置目录的适配）**：
- 「第三方模型提供商」：说明文字「填写服务商的地址、协议与 API 密钥，然后获取它自己的模型列表。」——模型目录以**探测结果**为主。
- 「自定义模型 API」：说明文字「连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口，需填写 API 地址、协议和模型。」（逐字取自截图）——模型目录以**手工添加**为主。
- 两段字段完全一致、都保留「获取可用模型」；差别只在说明文字与模型目录的默认空态/首选操作。**不得**引入任何厂商预置条目。

---

## 3. 文案（简体中文，逐字使用；被测试断言的不得改）

沿用现有、必须保留：「连接配置尚未保存」「连接配置已保存」「已配置密钥」「未配置密钥；运行时会以「缺少密钥」提示，不会伪造回答。」「不需要密钥（离线连接器）。」「macOS 系统钥匙串」「课程文件不含凭据」「粘贴 API Key（不会回显）」「删除本机保存的密钥」「读取模型失败：{原因}。可以直接在下面手动填写 Model ID，不影响保存。」

新增/改写（对齐 DSH 语义）：
- 新增卡分段说明：
  - 第三方兼容 API：「填写服务商的地址、协议与 API 密钥，然后获取它自己的模型列表。」
  - 自定义模型 API：「网关、自建服务或不支持读取模型列表的接口：手工声明模型 ID。」
  - 订阅登录：「使用服务商的订阅账号授权，不使用 API 密钥。」
- 「获取可用模型」/「正在获取…」；选择弹窗标题「选择模型」、描述「勾选的模型即为模型列表」、按钮「更新列表」/「取消」、搜索框 placeholder「搜索 Model ID」、空态「没有可显示的模型。可以手工添加 Model ID。」
- 「恢复默认模型」；确认文案「恢复这个提供商的默认模型目录？当前的模型编辑会被丢弃。」
- 模型行：「Model ID」「显示名称」「上下文窗口」「最大输出 token」「输入类型」「文本」「图片」「推理等级」「API 参数值」「添加档位」「移除」
- 容量非法：「容量必须是正整数，可用 K/M 后缀（K=1000、M=1000000）。」
- 模型 id 重复：「Model ID 不能重复：{id}」；空 id：「Model ID 不能为空。」
- 推理等级：无思考档位（只有 off）→「推理等级至少要有一个思考档位，或关闭推理等级。」；缺值→「每个思考档位都要填写 API 参数值。」
- 保存成功：「已保存 {显示名}。」
- 删除确认：「删除这个服务商在本机保存的 API Key？（课程内容不受影响）」（沿用）；连接删除：「删除连接「{显示名}」？本机保存的密钥会一并删除。」

错误契约不变：`user_message` 中文（句号结尾、不回显坏值）+ `technical_message` 英文 + `recommended_action` 中文非空。

---

## 4. 跨文件契约（P1 渲染层 / P2 交互层 / P3 服务层 必须逐字遵守）

### 4.1 `ui` 状态（`app/main.js` 初始化 + `resetAiState` + `aiCloseSettings` 负责）

| 字段 | 类型 | 语义 |
|---|---|---|
| `aiProviders` / `aiConfigured` / `aiCredentialOrigins` | 现有 | 不变 |
| `aiOpenEditor` | `"row" | "add" | null` | 当前展开的编辑卡 |
| `aiRowDraft` | `EditorDraft | null` | 行卡草稿（含 `providerId`） |
| `aiAddDraft` | `EditorDraft | null` | 新增卡草稿 |
| `aiAddTab` | `"third-party" | "custom" | "subscription"` | 分段；面板切换不丢草稿 |
| `aiSaveStatus` | `string | null` | 「已保存 {名称}。」 |
| `aiModelPicker` | `{ open: boolean, search: string, selected: Set<string>, models: DiscoveredModel[], loading: boolean, error: string | null }` | 选择弹窗 |
| `aiProviderForm` | 现有，**保留为 alias** | `aiOpenEditor === "row" ? aiRowDraft : aiAddDraft`，便于旧代码/旧测试平移 |

```
EditorDraft = {
  providerId: string, label: string, base_url: string, api_protocol: string,
  chat_path: string, default_model: string,
  is_saved: boolean, requires_credential: boolean, kind: string,
  secret: string, secret_visible: boolean,
  advanced_open: boolean,
  modelRows: ModelRow[],          // 有序
  errors: Record<string,string>,  // 字段级错误，键=data-* 名
  models_error: string | null,
}
ModelRow = {
  key: string,                    // 行本地稳定 key，重排不改
  id: string, name: string,
  context_window: string, max_tokens: string,   // 输入态文本，保存前解析
  input_text: boolean, input_image: boolean,
  reasoning_enabled: boolean,
  tiers: Array<{ key: string, tier: string, value: string }>,
  expanded: boolean,
}
```

**临时密钥**：`secret` 只存在于 draft 内；`ai-close-settings`/`ai-cancel-provider`/`ai-save-secret` 成功后必须清空；永不进 `ui` 之外、永不渲染值（只渲染 `type` 与 placeholder）。

### 4.2 DOM 契约（`data-*` 与 `data-action`，P1 产出、P2 绑定）

渲染侧新增/改动的属性名以 §2 树为准；P2 的 `handleAction`（`app/main.js:11648-11707`）必须覆盖这些 action：
`ai-edit-connection`、`ai-use-provider`、`ai-delete-connection`、`ai-create-connection`、`ai-add-tab`、`ai-toggle-advanced`、`ai-toggle-secret-visible`、`ai-discover-models`、`ai-open-model-picker`、`ai-picker-toggle`、`ai-picker-select-all`、`ai-picker-clear-all`、`ai-picker-confirm`、`ai-picker-close`、`ai-edit-model`、`ai-remove-model`、`ai-move-model`、`ai-add-manual-model`、`ai-reset-models`、`ai-toggle-model-reasoning`、`ai-add-tier`、`ai-remove-tier`、`ai-save-provider`、`ai-cancel-provider`、`ai-test-connection`、`ai-save-secret`、`ai-delete-secret`、`ai-close-settings`。

输入即时同步沿用现有“不重渲染以保 IME/光标”惯例（`app/main.js:12137-12139`），新增输入的 `data-*` 以 §2.1 为准。

### 4.3 数据模型（`AiProviderConfig`，P3 负责）

保持 `models?: string[]`（有序、trim、去重、即模型目录的 id 顺序）。**新增一个并列字段**承载每模型元数据：

```ts
model_meta?: Record<string, {
  name?: string;              // 显示名
  context_window?: number;    // 正整数
  max_tokens?: number;        // 正整数
  input?: ("text" | "image")[];   // 至少一种；缺省=继承
  reasoning_efforts?: Record<string, string>;  // 档位 -> API 参数值；off 键允许但值不下发
}>;
```

约束：
1. 字段名 `model_meta` 不得命中 `CREDENTIAL_FIELD`（`/key|token|secret|credential|password|authorization/i`）；其**值内**的键名同样受该正则约束（`findForbiddenField` 任意层级）。
2. 进 `SAFE_PROVIDER_FIELDS` 文案与 `normalizeProviderConfig` 校验；`MAX_PROVIDER_BYTES=8KB`、`MAX_PROVIDER_DEPTH=4` 保持（`model_meta` 深度为 3）。
3. 未知模型 id 的 `model_meta` 条目保留（不猜、不删）；`models` 里没有的 id 的 meta 保留但不下发。
4. **原生壳同步**：`src-tauri/src/lib.rs` 的 providers.json 解析必须接受 `model_meta`，且 `sensitive_key` 判定保持一致。
5. 老文件无 `model_meta` → 视为 `undefined`，UI 按“继承适配器默认”渲染（输入类型显示为「文本」默认勾选、容量留空）。

### 4.4 推理等级 → 请求体（按协议，不无条件塞入）

- `openai-completions` / `openai-responses`：思考档位选中且值非空时，在请求体写 `reasoning_effort: <值>`。
- `anthropic-messages`：不写 `reasoning_effort`；改为 `thinking: { type: "enabled", budget_tokens: <值>` 当值为纯数字时，否则**不写并给出可读提示**。
- off 档位只表示关闭思考：不写任何推理参数。
- 只有用户显式开启某模型的推理等级时才注入；默认不注入。


### 4.3.1 `max_tokens` 命名冲突的裁决（重要）

`CREDENTIAL_FIELD = /key|token|secret|credential|password|authorization/i` 会命中模型元数据字段 `max_tokens`。**裁决：保留 `max_tokens` 命名，在 `model_meta.<id>.max_tokens` 这一条精确路径上做豁免**，理由：

1. 该槽位的取值被**类型锁死为正整数**（TS `Number.isInteger && >0`，Rust `ai_positive_integer`），字符串密钥无法藏进去；外层与其它任意层级的 `max_tokens` 仍照常拒绝（已被测试锁定）。
2. `max_tokens` 是所有 LLM API 的通用命名，配置文件可读性与 DSH 语义一致；改成 `max_output` 之类只为绕过正则，反而让配置文件与业界脱节。
3. 豁免必须**只按路径、只此一处**，且两侧 transport 行为逐字一致。**禁止**再出现第二个豁免；若未来需要新的容量类字段，先改名避开正则，不要扩大豁免。

连带影响（前端必须知晓）：模型 id 若含 key/token/secret/credential/password/authorization 子串，则该 id **不能带 model_meta 条目**（会被拒）；`models` 数组本身不受影响。

### 4.5 服务层落地事实（P3 已完成，后续阶段直接依赖）

- 类型：`src/ui/contracts.ts:265` `ModelInputType`、`:273-283` `ModelMeta`；`AiProviderConfig.model_meta?: Record<string, ModelMeta>`（`src/service/ai_transport.ts:47`）。
- 校验：`normalizeModelMeta`（ai_transport.ts:654）+ Rust `ai_validate_model_meta`（lib.rs:14409）严格镜像：条目字段白名单 `name/context_window/max_tokens/input/reasoning_efforts`，未知字段拒；`input` 只能 `"text"|"image"`、去重保序、至少一个；`reasoning_efforts` 键精确小写枚举 `off|minimal|low|medium|high|xhigh|max`、值 trim 后非空；`context_window/max_tokens` 只收正整数。
- **保存合并语义**：`ai.connection.save` 按字段合并，缺省 `model_meta` = 保留旧值；要清空元数据必须显式提交 `model_meta: {}`。
- **前端职责**：容量输入框接受 `256K`/`1M` 等后缀（K=1000、M=1000000，DSH 语义），提交前解析为正整数；服务端只收数字。空输入=不写该字段（继承适配器默认）。
- 顺序：展示与下发按 `models` 数组迭代；服务端已把 map 按 models 排序，并提供 `modelMetaInModelsOrder`（ai_transport.ts:801）。
- **推理参数下发在 `app/ai.js`**（请求体构造处，anthropic body 约 app/ai.js:2046）；服务端 `ai.complete` 只透传、绝不拒绝或改写（已有测试锁定 openai-completions 与 anthropic-messages 两种透传）。
- 落盘：`providers.json` 读→写→读等值；Rust serde_json Map 为 BTreeMap，桌面壳键序为字典序，跨壳比较用值等值而非 JSON 文本。


#### 4.4.1 档位解析裁决（2026-10-24）

「所选档位」的来源在 §4.4 里原本未定义（DSH 由 composer 的请求级选择器决定，本项目无该组件）。裁决：

1. **未点名档位时取该模型已配置的最强思考档位**（off < minimal < low < medium < high < xhigh < max）。模型行的「推理等级」开关本身就是 §4.4 的「用户显式开启」，开了即同意注入，若仍不下发会让功能形同虚设。
2. 请求级可传 `reasoning_tier` 覆盖；`off` 或未开启开关 = 不下发任何推理参数。
3. **透明性**：执行记录与结果区必须显示实际使用的推理档位，并在使用默认档时说明（「未选择档位，使用最强档 high」）；「?」说明文字写明该规则。
4. anthropic-messages 遇到非纯数字的 API 参数值：**不写 thinking 参数、不抛错、不打断请求**，以 warnings 透传到完成结果，提示给出下一步。

---

## 5. 视觉规范（去品牌化，取自 DSH `docs/ui-radius.zh.md` + 截图实测）

| 元素 | 规格 |
|---|---|
| 卡片（提供商行、新增卡） | 圆角 **R20**、1px 描边（`settings-card-fill` 同族）、内边距 16px |
| 编辑卡（行内展开） | 圆角 **R16**、浅一档背景、内边距 16px、上间距 12px |
| 输入框 | 高 **32px**、圆角 **R12**、1px 描边、focus 蓝色描边（用主题色，不用 DeepSeek 蓝） |
| 主/次按钮 | 高 **36px**、圆角 **R12**；行内按钮高 **28px**、圆角 **R8** |
| 分段控件 | 外层圆角 **R12**、内缩 **4px**、分段圆角 **R8**、选中段浅色填充 |
| 状态点 | 6px 圆点；绿=已配置、橙=未配置、灰=未确认；胶囊「当前使用」 |
| 折叠区标题 | 常规字重 + ▸/▾ 箭头，`aria-expanded` |
| 模型行 | 行头单行（id 等宽字体），展开体两列容量 + 独立一行输入类型 |
| 字号层级 | 眉题 11px/大写字距、标题 17px、正文 13px、辅助 12px |

配色沿用 `app/styles.css` 现有 CSS 变量体系（明暗主题）；**不引入** DeepSeek 品牌蓝。间距遵循 4px 栅格。

---

## 6. 分阶段实施（每阶段结束必须 `deno task check && deno task test` 全绿）

1. **P1 骨架与文案**：提供商行卡片 + 行内编辑卡（API 密钥 + 眼睛 + 折叠自定义设置）+ 新增卡分段 + 视觉 token + 既有模型 chip 流程迁入「模型目录」区。P1=渲染层(`app/views.js`+`app/styles.css`)、P2=交互层(`app/main.js`+`app/ai.js`)，按 §4 契约并行。
2. **P2 模型行编辑**：模型行（id/显示名/容量/输入类型）+ 上下移排序 + 移除 + 恢复默认模型 + 「获取可用模型」→「选择模型」弹窗（勾选=列表、「更新列表」含移除语义）+ 手动添加。
3. **P3 推理等级**：开关 + 档位/API 参数值成对编辑 + 按协议注入请求体（§4.4）。
4. **P4 服务层与原生壳**：`model_meta` 字段校验/持久化/往返（`src/service/ai_transport.ts` + `src-tauri/src/lib.rs`）。
5. **P5 测试**：更新被逐字断言的结构断言（`ai_ui_test.ts:467-482` 的“表单在列表前”改为“编辑卡在所属行内”等）、新增 UI/契约测试、`deno.json` 清单登记。
6. **P6 独立验收**：未参与实现的 subagent 对照本文目标逐项验收 + 回归测试。

---

## 7. 测试计划

- 结构断言：新 DOM（`ai-provider-row`/`ai-provider-editor`/`ai-segmented`/`ai-model-row`/`ai-model-picker`）存在且顺序正确。
- 文案断言：§3 列出的保留文案逐字不变；新增文案逐字锁定。
- 交互断言：分段切换不丢草稿；一次只展开一张编辑卡；眼睛按钮只改 `type`；`secret` 清理时机（关闭/取消/保存密钥后）。
- 安全回归：密钥不渲染、不进 `ui`/`session`；`model_meta` 命名过 `CREDENTIAL_FIELD`；`normalizeProviderConfig` 拒绝凭据形状字段。
- 契约回归：`ai_provider_config_test.ts`（§9.2 无模板目录、协议三选一、错误 recommended_action 非空）、`ai_transport_test.ts`（字段校验、密钥防泄漏、8KB/深度 4 限额）。
- 新测试文件登记进 `deno.json` 的 check/test 清单。

---

## 8. 验收标准

1. `deno task check` 与 `deno task test` 全绿（基线 716 passed）。
2. 打开 AI 设置：先见提供商行卡列表，再见「＋ 添加模型提供商」；行内展开编辑卡，编辑卡含 API 密钥 + 「自定义设置」折叠区。
3. 新增卡有三段分段控件，切换不丢草稿；无任何厂商预置目录。
4. 模型目录支持行级编辑、排序、移除、恢复默认；「获取可用模型」→ 选择弹窗 →「更新列表」。
5. 推理等级可按模型开启并配档位/参数值，且只对支持的协议下发。
6. 密钥只写、不回显、关闭清空；`model_meta` 与 `sensitive_key` 契约不破。
7. 视觉与 DSH Models 页一致（卡片/输入/按钮/分段控件/状态点圆角与间距），且无 DeepSeek 品牌资产。
