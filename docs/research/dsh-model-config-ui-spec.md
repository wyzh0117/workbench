# DSH「模型 / Models 设置」界面与交互逆向规格（可照着仿制）

> 目标读者：要在另一款桌面应用里实现同等「AI 模型配置」界面与逻辑的工程师。
> 调研对象：DeepSeek Harness（DSH）Web/桌面客户端的 Models 设置页与模型选择器。
> 本文只做规格记录，不改动任何产品代码；所有结论均带证据（文件 + 行号或片段）。无法确认处显式标注「未确认」。

---

## 0. 证据来源与引用约定

| 优先级 | 来源 | 本地镜像 | 说明 |
|---|---|---|---|
| 一手 | GitHub 仓库 `deepseek-ai/deepseek-harness@master`（MIT） | `/tmp/dsh-research/github/`、`/tmp/dsh-research/gh-mine/` | `packages/client/ui-settings-models/src/client/*.ts(x)` 等源码与 `docs/` 文档 |
| 二手 | `app.asar` 解包产物（0.2 预览版构建，已打包压缩后的 bundle） | `/tmp/dsh-research/extract/dsh/node_modules/@deepseek-ai/` | 仓库材料未覆盖的包（ui-theme、settings-general、api-settings-controller、model-selection 代码）以此为证 |
| 截图 | `docs/user/guide/providers-models-page.zh.png`（1600×850）、`docs/user/guide/providers-custom-form.zh.png`（1128×1390） | `/tmp/dsh-research/gh-mine/` | 视觉规格的实测依据 |
| 文档 | `docs/user/guide/providers.zh.md`、`docs/web-styling.zh.md`、`docs/ui-radius.zh.md`、`BRAND_GUIDELINES.zh.md` | 同上 | 官方用户指南与样式/圆角/品牌规范 |

引用格式：`src/ModelRow.tsx:85` = `packages/client/ui-settings-models/src/client/ModelRow.tsx` 第 85 行（仓库 master）；`README.zh.md:60` = `packages/client/ui-settings-models/README.zh.md`；`bundle settings-models/lib/client.js:2032` = asar 解包后的打包文件；`providers.zh.md:37` = `docs/user/guide/providers.zh.md`；截图记为 `[截图A]`（模型页）、`[截图B]`（自定义表单）。

### 0.1 asar（0.2 构建）与仓库 master 的已知差异 —— 一律以 master 为准

| 项 | master（本文采用） | asar 0.2 bundle |
|---|---|---|
| 获取模型弹窗主按钮 | **更新列表**（`locales.ts:255` fetchAdopt = '更新列表'） | 「添加所选」（bundle fetchAdopt） |
| 弹窗语义 | 打开即勾选已配置模型；「更新列表」= 追加勾选 + 移除取消勾选的已配置模型；回复未列出的已配置模型保留；重复候选 id 只列一次；会把非空列表清空时按钮禁用（`README.zh.md:70`） | 只新增勾选项，不删除（bundle ModelListEditor adoptPicked） |
| 全选/取消全选 | 只影响可见结果（`ModelListEditor.tsx:293-305`） | 「取消全选」清空全部勾选 |
| 模型排序 | 新增拖拽手柄 + 上下方向键（`ModelRow.tsx:82-106`、`README.zh.md:60`） | 无排序能力 |
| 模型行本地状态 | 展开项、未完成容量输入随模型移动保留（`useModelRows.ts:41-48`） | 「各行不保留自己的状态」 |
| pi-ai 容量占位 | 上下文窗口 `1M`、最大输出 `128K`（`ModelListEditor.tsx:122-125`） | `256K` / `32K` |
| 弹窗标题/描述 | 「选择模型」/「以下是模型提供商的可用模型，勾选的模型即为模型列表。」（`locales.ts:251-252`） | 「选择要添加的模型」/「…勾选要添加的模型。」 |
| 新增文案 | `fetchKeepOne`「请至少保留一个勾选的模型。」、`reorderModel`/`reorderModelHelp`（`locales.ts:231-232,256`） | 无 |
| 模型选择器焦点 | 手机/平板在用户主动点按或键盘导航前不聚焦搜索框（`ui-model-selection/README.zh.md:35`） | 桌面措辞 |

---

## 1. 信息架构

### 1.1 设置导航中 Models 页的位置

- 设置是居中模态面板：外层遮罩 + `800px` 宽面板（`height: min(800px, calc(100vh - 2*max(24px, ...)))`），左侧导航栏宽 `188px`（`bundle settings-general/lib/client.js:61` CSS `.Dws9Sa_panel/.Dws9Sa_nav`）。
- 左栏自上而下：标题「设置」（`.navTitle`，16px/24px，500）+ 导航项列表（每项高 `40px`、圆角 R12、14px/22px 文字、16px 图标，`bundle settings-general/lib/client.js:61`）。
- 导航项 = 所有 `settings.section` 注册者按 `order` 升序（`bundle settings-general/lib/client.js:1146-1151`）：

| order | id | 中文名 | 图标 | 证据 |
|---|---|---|---|---|
| -10 | account | 账号（名称未确认） | IconUserOutlineMedium | `bundle settings-account/lib/client.js:4778-4780` |
| 0 | general | 通用设置 | 默认齿轮 | `bundle settings-general/lib/client.js:1295-1297`、`[截图A]` |
| **10** | **models** | **模型** | IconDataOutlineMedium（16px） | `src/index.ts:136-139`（`id: 'models', order: 10`）、`bundle settings-general/lib/client.js:250-253` |
| 15 | plugins | 内置插件 | IconPersonalizationOutlineMedium | `bundle settings-plugins/lib/client.js:203-205` |
| 20 | agent-presets | Agent 预设 | IconAgentPresetOutlineMedium | `bundle ui-agent-preset/lib/client.js:2457-2459` |

- `[截图A]` 实测导航四项：通用设置 / **模型**（选中态浅灰圆角底）/ 内置插件 / Agent 预设；顶部右侧有「打开配置文件」按钮（仅 Host 同机时出现，`bundle settings-general/lib/client.js:1115`）与关闭 ×。账号项未出现在截图中（是否条件挂载：未确认）。
- 入口与快捷键：侧栏底部设置按钮（`sidebar.settings` 插槽）；快捷键 `settings.open` = 桌面 `Cmd/Ctrl+,`、Web `Cmd/Ctrl+Alt+,`（`bundle settings-general/lib/client.js:1188-1213`）。
- 页面标题与图标之外，模型页自身注册为 `settings.section{ id:'models', order:10, label: '模型' }`（`src/index.ts:136-146`）。

### 1.2 页面自上而下的区块顺序

`ModelsSection` 内容列（`src/ModelsSection.tsx`、`bundle settings-models/lib/client.js:2493-2804`）：

1. `h2`「模型」（16px/24px、500）
2. 引言「填入各提供商的 API 密钥即可使用其模型。」（14px/22px，tertiary）
3. 只读提示「当前部署的设置文档为只读。」（仅 `!writable && status==='ready'`）
4. 保存状态「已保存 {provider}。」（`role=status aria-live=polite`，绿色，保存成功并刷新后显示）
5. `ul.rows`：提供商行列表（DeepSeek 账号 → DeepSeek → 其余按目录顺序，`store.ts:73-75`）
6. `div.addBlock`：「＋ 添加模型提供商」按钮（收起态）或添加卡片（展开态）
7. `settings.models.footer` 插槽（无注册者时不渲染）
8. 删除确认 Modal（按需）
9. 模型目录内的「获取可用模型」Modal（按需，挂在模型目录组件内）

行内自上而下（`li.rowCard`）：行头（名称 + 徽章 + 状态点 + 编辑/删除按钮）→ 目录错误（`role=alert`）→ `settings.models.provider-card` 插槽 → 展开的编辑卡（`div.editor`）。

### 1.3 DOM 层级树

```text
section.section  (max-width:720px; flex column; gap:12px)
├─ h2.title「模型」
├─ p.intro「填入各提供商的 API 密钥即可使用其模型。」
├─ p.notice「当前部署的设置文档为只读。」                [可选]
├─ p.savedNotice[role=status][aria-live=polite]「已保存 {provider}。」 [可选]
├─ ul.rows                                        (gap:8px; margin-top:12px)
│  ├─ li.setupCard                                [首次运行姿态，替代整行]
│  │  ├─ p.error[role=alert]                      [目录错误，可选]
│  │  ├─ ProviderEditor → div.editor
│  │  └─ [slot] settings.models.provider-card (keyed by settingsNs)
│  └─ li.rowCard                                  (卡片材质：R20/0.5px 描边/卡片底色)
│     ├─ div.rowHead                              (flex; gap:10px)
│     │  ├─ span.rowIdentity
│     │  │  ├─ span.rowName「显示名」(14px/22px, 500)
│     │  │  ├─ span.rowTag「自定义」                [仅手工声明路由]
│     │  │  ├─ span.accountStatus: span.credentialDot +「已登录」 [仅 deepseek-account]
│     │  │  ├─ span.credentialDot.green「API 密钥已配置」  [可选，role=img]
│     │  │  └─ span.credentialDot.red「API 密钥缺失」      [可选，role=img]
│     │  └─ span.rowActions (margin-left:auto)
│     │     ├─ button「编辑」 (secondaryButton, 28px)
│     │     └─ button「删除」 (dangerButton, 28px)  [仅用户层单独承载该行]
│     ├─ p.error[role=alert]
│     ├─ [slot] settings.models.provider-card
│     └─ div.editor                               [点「编辑」展开]
│        ├─ div.editorHeader: span.editorTitle + span.editorRoute
│        ├─ div.field: span.fieldLabel「API 密钥」+ button.helpButton「?」
│        │             + ApiKeyInput + p.notice/advancedHint/savedNotice + p.error
│        ├─ details.customized > summary.customizedSummary「自定义设置」
│        │  └─ div.customizedBody
│        │     ├─ div.field「显示名称」              [仅手工声明 pi-ai 路由]
│        │     ├─ div.field「API 地址」(+ endpoint hint)
│        │     ├─ div.field「API 协议」select        [仅手工声明 pi-ai 路由]
│        │     └─ section.modelCatalog「模型目录」   (DeepSeek 或 pi-ai 变体，见下)
│        └─ div.editorActions: button「取消」+ button「保存」/「保存中…」
├─ div.addBlock
│  ├─ div.addCard                                 [添加卡片展开态]
│  │  ├─ div.addModes
│  │  │  ├─ SegmentedControl「添加方式」            [两种方式都可用时]
│  │  │  │    ├─ tab「第三方模型提供商」
│  │  │  │    └─ tab「自定义模型 API」
│  │  │  └─ 或 div.editorHeader > span.editorTitle  [仅一种方式时，直接显示该方式名]
│  │  │  └─ p.advancedHint（所选方式的一行用途说明）
│  │  ├─ div.addPanel#…-catalog-panel[hidden]       [第三方模型提供商]
│  │  │  ├─ div.field:「提供商」select（休眠目录选择框）
│  │  │  ├─ ProviderEditor (hideTitle)              [同编辑卡，无标题头]
│  │  │  └─ [slot] settings.models.provider-card
│  │  └─ div.addPanel#…-custom-panel[hidden]        [自定义模型 API]
│  │     └─ CustomProviderCard → div.editor
│  │        ├─ div.field「Provider ID」input (placeholder "acme-gateway")
│  │        ├─ p.advancedHint「以小写字母开头的标识…」/ p.error
│  │        ├─ div.field「显示名称」input
│  │        ├─ div.field「API 地址」input (placeholder 随协议变化) + p.error
│  │        ├─ div.field「API 协议」select
│  │        ├─ div.field「API 密钥」ApiKeyInput + p.error
│  │        ├─ section.modelCatalog「模型目录」（pi-ai 变体 + 获取可用模型）
│  │        ├─ p.error（创建失败）+ p.advancedHint（未满足项提示）
│  │        └─ div.editorActions: 「取消」+「创建提供商」/「创建中…」
│  └─ div.addActions > button.addButton「＋ 添加模型提供商」 [卡片收起态，虚线框]
├─ [slot] settings.models.footer
└─ Modal (删除确认)  width:min(480px,100%)
   ├─ title「删除 {provider}？」+ description（两种文案，见 `3.6）
   └─ footer: 「取消」+「删除 {provider}」(deleteConfirm, 红字描边)

section.modelCatalog「模型目录」                     [两种编辑器共用骨架]
├─ div.modelListHead
│  ├─ div.modelCatalogHeading
│  │  ├─ span.modelCatalogTitle「模型目录」
│  │  └─ span.modelCatalogMeta「正在使用适配器默认模型」/「已自定义模型目录」
│  ├─ button.linkButton「恢复默认模型」              [仅已覆盖时]
│  └─ button.linkButton「获取可用模型」/「正在询问提供商…」 [仅 pi-ai 变体]
├─ p.modelEmpty「模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。」 [空列表]
├─ div.modelList
│  └─ div.modelEntry × N                            (0.5px 描边, R16, padding:6px)
│     ├─ div.modelRow (grid: 1.4fr 1fr auto auto; gap:6px)
│     │  ├─ input「模型 ID」
│     │  ├─ input「显示名称」
│     │  ├─ button.iconButton [拖拽手柄 IconDragHandleOutlineRegular 14px] [master 新增]
│     │  ├─ button.iconButton [chevron 展开/收起 模型选项]
│     │  └─ button.iconButton.iconButtonDanger [垃圾桶 删除模型]
│     └─ div.modelAdvanced                          [展开时，grid 2 列]
│        ├─ label.modelField「上下文窗口」input (inputMode=numeric)
│        ├─ label.modelField「最大输出 token 数」input (inputMode=numeric)
│        ├─ fieldset.modelInputTypes「输入类型」(grid-column:1/-1)
│        │  └─ Checkbox「文本」 + Checkbox「图片」
│        └─ div.modelReasoning「推理等级」(grid-column:1/-1) [仅手工声明 pi-ai 路由]
│           ├─ div.modelReasoningHead: 标签 + 「?」帮助 + Switch
│           ├─ 表头行「档位 | API 参数值」            [aria-hidden]
│           ├─ div.modelReasoningRow × N: select(档位) + input(API 参数值) + 删除按钮
│           ├─ p.error                             [校验失败]
│           └─ button.addModelButton「＋ 添加档位」
├─ button.addModelButton「＋ 添加模型」
├─ p.error                                          [探测失败信息]
└─ Modal「选择模型」                                 [获取可用模型的候选选择器]
   ├─ div.candidateToolbar: input[type=search]「搜索模型」+ button「全选/取消全选」
   ├─ ul.candidateList (max-height:320px)
   │  └─ li.candidate > label: input[checkbox] + span.candidateId（等宽原始 id，title=模型名）
   ├─ p.candidateEmpty「没有匹配的模型。」            [无匹配]
   └─ footer: 「取消」+「更新列表」（会清空列表时禁用，title「请至少保留一个勾选的模型。」）
```

证据：`src/ModelsSection.tsx:422-731`、`src/ProviderEditor.tsx:418-437`、`src/CustomProviderCard.tsx:224-302`、`src/ModelListEditor.tsx:308-440`、`src/ModelRow.tsx:58-106`、`src/ModelReasoningEfforts.tsx:157-233`；样式类名与结构见 `bundle settings-models/lib/client.js:59`（完整 CSS）。

---

## 2. 完整字段清单

所有标签/占位/帮助/错误文案为简体中文原文，取自 `src/locales.ts` zh 字典（行号指 en→zh 各键；下表「文案」列为 zh 值）。

### 2.1 提供商编辑卡（ProviderEditor，编辑/首次运行/目录添加共用）

| # | 标签 | 控件 | 占位符 | 帮助/提示 | 校验 | 错误文案 | 证据 |
|---|---|---|---|---|---|---|---|
| 1 | **API 密钥** | password input（`autocomplete=new-password`，非空时右侧眼睛按钮） | 见 `4.2` 推导顺序：「输入 API 密钥」/「留空使用已保存凭据」/「留空使用环境认证（{hint}）」 | 标签旁「?」按钮（Tooltip）：「优先使用已保存的凭据。此处显示的环境后备按以下顺序排列：{env}。来源依次为启动环境、$cwd/.env、$DSH_HOME/.env。」；输入框下方认证状态提示见 `4.3` | `apiKey.ts:12,23,51-56`：trim 后非空；可打印 ASCII `[\x21-\x7E]`；拒绝 `NAME=value` 环境行（`/^[A-Z][A-Z0-9_]*=[^=]/`）与成对引号包裹值 | 「请输入 API 密钥；留空则保持已存储的密钥。」（keyBlank）/「请输入 API 密钥；若该提供商以其他方式鉴权，可以留空。」（keyBlankNew）/「该 API 密钥格式错误，请检查。」 | `src/apiKey.ts:12-56`、`src/ProviderEditor.tsx:387-404` |
| 2 | **显示名称**（自定义设置内，仅手工声明路由） | text | 继承层的 displayName ?? 提供商 id | — | 清空=删除该字段（恢复继承） | — | `bundle settings-models/lib/client.js:2085-2100` |
| 3 | **API 地址**（自定义设置内） | text | DeepSeek：「https://api.deepseek.com/anthropic（默认使用环境 DEEPSEEK_BASE_URL）」；pi-ai：profile/目录端点 →「{url}」；无默认但有地址变量 →「由提供方配置地址」；都没有 →「没有默认地址」 | DeepSeek 卡下显示「请填写兼容 Anthropic Messages 协议的 API 地址。」；无固定默认端点时显示「提供方地址配置：{env}」（`baseURLEnv`，不算凭据） | 仅自定义表单做 URL 校验（见 2.6）；编辑卡上清空=删除字段 | — | `README.zh.md:57`、`bundle settings-models/lib/client.js:2113-2125` |
| 4 | **API 协议**（自定义设置内，仅手工声明路由） | select | — | 选项为产品名：OpenAI Chat Completions / OpenAI Responses / Anthropic Messages（存储值 `openai-completions` / `openai-responses` / `anthropic-messages`；未知协议直接显示标识符） | — | — | `src/CustomProviderCard.tsx:255`、`bundle settings-models/lib/client.js:1490-1506`、`providers.zh.md:29` |
| 5 | **模型目录**（自定义设置内） | 见 `2.3` | | | | | |

DeepSeek 卡（`llm-deepseek`）与 pi-ai 卡（`llm-pi-ai`）共用上述布局；DeepSeek 用 Messages 协议、默认端点占位 `https://api.deepseek.com/anthropic`（`README.zh.md:59`）。Provider ID 不可编辑（它是 settings 键、引用词干，`README.zh.md:57`）。

### 2.2 「自定义设置」折叠区

- `details.customized` + `summary「自定义设置」`；折叠箭头为 5×5px CSS 三角（border-bottom/right 1.5px，旋转 -45°→45°，transition .12s）（`bundle settings-models/lib/client.js:59` `._6fYtdq_customizedSummary:before`）。
- 内容：显示名称（仅手工声明）→ API 地址 → API 协议（仅手工声明）→ 模型目录。
- Profile `headers`、超时、重试等不在本页（`README.zh.md:57`、`advancedHint`「其余字段在 cordis.patch.yml 中，请直接编辑对应段。」）。

### 2.3 模型目录编辑器（两种变体）

| 元素 | DeepSeek 变体（DeepSeekModelsEditor） | pi-ai 变体（ModelListEditor） | 证据 |
|---|---|---|---|
| 标题行 | 「模型目录」+「正在使用适配器默认模型」/「已自定义模型目录」 | 同左（meta 可省） | `src/DeepSeekModelsEditor.tsx:188`、`src/ModelListEditor.tsx:325-335` |
| 「恢复默认模型」 | 仅已覆盖时显示；unset 整个 `models` 覆盖 | 同左（`onReset` 存在时） | `README.zh.md:61` |
| 「获取可用模型」 | 无（DeepSeek 跟随官方列表） | 有；禁用条件：`disabled ‖ busy ‖ !askable ‖ probeBlocked`；title：被字段错误阻塞时显示该错误，否则未填地址显示「请先填写 API 地址，再获取。」 | `src/ModelListEditor.tsx:337-343` |
| 空态 | 「模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。」（虚线框，居中） | 同左 | `src/locales.ts:233` |
| 行 | `ModelRow` × N（见 2.4） | 同左 | |
| 「＋ 添加模型」 | 追加 `{ id: "" }` 行 | 同左 | `src/DeepSeekModelsEditor.tsx`、`src/ModelListEditor.tsx:364-369` |
| 继承语义 | `models` 是按值整体替换数组：首次模型编辑物化完整数组到用户层；恢复默认=unset 覆盖 | 空列表=「用该路由的内置 catalog」；任何条目=替换 catalog | `README.zh.md:91`、`bundle settings-models/lib/client.js:816-821` |
| 输入类型回退 | 未声明时显示继承值 | 未声明时：已安装目录同 id 模型的 `inputModalities` → 路由 `defaultInput` → 文本 | `src/ModelInputTypes.tsx:34`、`src/ModelListEditor.tsx:167` |
| 容量占位 | 无 provider 默认值时「使用提供商默认值」；有则显示 `formatCapacity(default)` | 固定提示「上下文窗口 1M」「最大输出 128K」（十进制 K/M） | `src/DeepSeekModelsEditor.tsx:188`、`src/ModelListEditor.tsx:122-125` |

### 2.4 模型行（ModelRow）与模型选项

| 字段 | 标签 | 控件 | 占位符 | 校验 | 错误文案 | 证据 |
|---|---|---|---|---|---|---|
| id | 模型 ID（aria-label 带序号） | text | 「模型 ID」 | trim 后非空；全表唯一（trim 后比较） | 「模型 ID 不能为空。」/「模型 ID 不能重复。」 | `src/DeepSeekModelsEditor.tsx:86-106` |
| name | 显示名称 | text | 「显示名称」 | 若存在必须非空字符串；清空=删除字段 | 「显示名称不能为空。」 | 同上 |
| contextWindow | 上下文窗口 | text + `inputMode=numeric` | DeepSeek：「使用提供商默认值」或默认值速记；pi-ai：「1M」 | `/^(\d+(?:\.\d+)?)([km])?$/i`，K=1000、M=1000000（十进制）；解析结果必须为正整数（`Number.isInteger && >0`）；空=继承 | 「上下文窗口必须是正数，例如 131072、256K 或 1M。」 | `src/DeepSeekModelsEditor.tsx:23-26,35-59,106` |
| maxTokens | 最大输出 token 数 | 同上 | 「使用提供商默认值」/「128K」 | 同上 | 「最大输出 token 数必须是正数，例如 8192、64K 或 1M。」 | 同上 |
| inputModalities / input | 输入类型（fieldset，独占一行） | Checkbox「文本」「图片」 | — | 至少保留一种；只剩一种时该项禁用（`src/ModelInputTypes.tsx:44`）；DeepSeek 取消「图片」同时删除 `imagePixelBudget`、`imageMaxBytes` | — | `src/ModelInputTypes.tsx:34-52` |
| reasoningEfforts | 推理等级（仅手工声明 pi-ai 路由） | Switch + 每档一行：select「档位」+ input「API 参数值」+ 删除按钮 | API 参数值占位：off 行为「关闭思考」（禁用输入），其余为档位名 | 见 `2.5` | 见 `2.5` | `src/ModelReasoningEfforts.tsx:15-82` |

模型行辅助控件：拖拽手柄（`aria-label「调整模型顺序 N」`、`aria-keyshortcuts="ArrowUp ArrowDown"`、Tooltip「拖动排序，或使用上下方向键调整顺序。」）、「模型选项」展开按钮（chevron，`aria-expanded`）、「删除模型」按钮（`src/ModelRow.tsx:82-106`）。

### 2.5 推理等级（reasoningEfforts）细则

- 开关关闭 = 字段不存在：模型不推理、选择器不出档位；已存 `false` 在开关被操作前保持原样（`README.zh.md:64`、`src/ModelReasoningEfforts.tsx:39-50`）。
- 打开开关固定从 `off, low, medium, high` 四行开始（`INITIAL_LEVELS`，`src/ModelReasoningEfforts.tsx:15`）；不会恢复曾删掉的档位。
- 档位可选值来自 `llm-pi-ai` 配置 schema（与协议选项同源），当前为 `off, minimal, low, medium, high, xhigh, max`，每档只能用一次；schema 未列的已存键保留自己的行（`README.zh.md:64`、`src/store.ts:158-170`）。
- 每行 = 档位 select + **API 参数值** input 成对；参数值初值=档位名；输入时清空存档位名、失焦回显；off 行输入禁用（已写入值显示并保留）；改档位时旧名参数值重置，自定义值仅在两个思考档位间保留，进出 off 均重置（`README.zh.md:64`）。
- 拒绝条件（保存前校验，`src/ModelReasoningEfforts.tsx:77-83`）：
  - 除 off 外没有任何档位（含 `reasoningEfforts:` 空值 → 开关显示开但 0 行）→「至少添加一个 Off 以外的档位；不需要思考请关闭推理等级。」
  - off 外档位缺值或任意档位值为空串 →「Off 以外的档位都需要填写 API 参数值，且参数值不能为空字符串。」；被拒字段标 `aria-invalid`，失焦回填档位名。
- 帮助「?」Tooltip（`modelReasoningHelpText`）：「API 参数值会写入请求的推理强度字段（如 OpenAI 的 reasoning_effort），默认与档位名相同；如有不同，以模型提供商的 API 文档为准。Off 表示关闭思考，不需要填写参数值；配置中已写入的值会保留并发送。」
- 行可增删、按行序保存；模型选择器按升级顺序列出档位（`README.zh.md:64`）。

### 2.6 添加卡片 — 两种方式

**方式 A「第三方模型提供商」**（DSH 原型：休眠目录提供商选择框 + ProviderEditor）：

| 元素 | 内容 | 证据 |
|---|---|---|
| 分段说明 | 「从内置目录中选择 OpenAI、Anthropic、Kimi 等提供商，填入其 API 密钥即可使用。」 | `src/locales.ts:163` |
| 「提供商」select | 只列未配置的目录提供商，显示 displayName（值为路由 id，如 `anthropic`、`openai`、`moonshotai`、`zai`） | `providers.zh.md:19`、`bundle settings-models/lib/client.js:2690-2705` |
| 编辑器 | 同 `2.1`（hideTitle） | |
| 禁用条件 | 目录中已无未配置提供商 → 该方式禁用，悬停提示「目录中的提供商都已添加。」 | `src/locales.ts:165` |
| ⚠️ 仿制约束 | **目标项目禁止预置厂商目录**，此方式必须改型，见 `7.3` | |

**方式 B「自定义模型 API」**（CustomProviderCard）：

| # | 标签 | 控件 | 占位符 | 帮助 | 校验 | 错误文案 | 证据 |
|---|---|---|---|---|---|---|---|
| 1 | Provider ID | text | `acme-gateway` | 「以小写字母开头的标识，在请求中唯一标识该提供商，并用于派生凭据名。」 | `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`；且不可与现有提供商重名；创建后不可改 | 「需以小写字母开头，之后可用小写字母、数字和短横线。」/「已有提供商使用了这个 ID。」 | `src/CustomProviderCard.tsx:55,124` |
| 2 | 显示名称 | text | 空时占位=Provider ID（都空时占位「显示名称」） | — | — | — | `src/CustomProviderCard.tsx:224-255` |
| 3 | API 地址 | text | `https://gateway.example/v1`（OpenAI 两种协议）/ `https://gateway.example`（Anthropic Messages，其 SDK 追加 `/v1/messages`） | — | `new URL()` 可解析且协议为 `http:`/`https:`（localhost、IPv4/IPv6 字面量、自定义端口均有效）；必填 | 「请输入有效的 HTTP 或 HTTPS 地址。」；未填时提交按钮下方提示「自定义模型 API 需要填写 API 地址。」 | `src/CustomProviderCard.tsx:57-63`、`README.zh.md:70` |
| 4 | API 协议 | select | — | — | 必选（默认第一个） | 「没有可用的 API 协议。」（方式禁用提示） | `src/CustomProviderCard.tsx:255` |
| 5 | API 密钥 | ApiKeyInput（同 2.1，但无认证状态提示） | 「输入 API 密钥」 | — | 同 `apiKey.ts`；留空=保存无引用 profile（保留原生认证） | 「请输入 API 密钥；若该提供商以其他方式鉴权，可以留空。」/「该 API 密钥格式错误，请检查。」 | `src/CustomProviderCard.tsx` |
| 6 | 模型目录 | ModelListEditor（pi-ai 变体 + 推理等级） | | | 至少一个模型 | 「自定义模型 API 至少需要一个模型。」 | `src/CustomProviderCard.tsx:132-138` |

- 创建流程：`settings.mutate` 一次写入 `providers.<route>` 整个 profile（含 `displayName?/apiKeyEnv?/api/baseURL/models`），成功后再 `credentials.set` 存密钥；两阶段各自可重试（`src/CustomProviderCard.tsx:160-210`、`README.zh.md:70`）。
- 分段说明：「连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口，需填写 API 地址、协议和模型。」

### 2.7 校验规则汇总（实现者可直接抄）

| 规则 | 判定 | 失败文案 key | 证据 |
|---|---|---|---|
| API Key | 空字段=合法（保持已存）；仅空白=失败；`NAME=value` 环境行=失败；成对引号（`" ' ``）包裹=失败；其余须整串匹配 `^[\x21-\x7E]+$`（可打印 ASCII，含空格即非法） | keyBlank / keyIllegalCharacters | `src/apiKey.ts:12,23,35-56` |
| URL | `new URL(v).protocol ∈ {http:, https:}` | customBaseUrlInvalid | `src/CustomProviderCard.tsx:57-63` |
| 容量（contextWindow/maxTokens） | `^(\d+(?:\.\d+)?)([km])?$/i`；K=×1000、M=×1000000；结果取整（四舍五入到整数，若与原值差 <1e-6）；存储值须正整数；空=继承 | modelContextInvalid / modelMaxTokensInvalid | `src/DeepSeekModelsEditor.tsx:23-59,86-106` |
| 模型 id | trim 后非空、全表唯一（trim 后） | modelIdRequired / modelIdDuplicate | `src/DeepSeekModelsEditor.tsx:86-97` |
| 显示名称 | 若存在须非空 | modelNameInvalid | 同上 |
| Provider ID | `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` 且不与现有 id 重复（首字母小写要求源于凭据名派生须为 POSIX 标识符，`src/CustomProviderCard.tsx:45-55`） | customRouteInvalid / customRouteTaken | |
| 推理等级 | 见 `2.5` | modelReasoningValueRequired / modelReasoningNeedsLevel | `src/ModelReasoningEfforts.tsx:77-83` |
| 自定义表单整体 | route 有效未占用 + baseURL 非空且合法 + ≥1 模型 + 模型校验通过 + 密钥校验通过才允许「创建提供商」 | 各字段提示以 `advancedHint` 汇总显示 | `src/CustomProviderCard.tsx:138-145` |

### 2.8 通用文案（zh 原文，节选全量）

页面/行/卡片：「模型」「填入各提供商的 API 密钥即可使用其模型。」「编辑」「删除」「添加模型提供商」「添加方式」「第三方模型提供商」「自定义模型 API」「提供商」「关闭」「取消」「保存」「保存中…」「已保存 {provider}。」「API 密钥已配置」「API 密钥缺失」「已登录」「当前部署的设置文档为只读。」「加载提供商目录失败」「这张卡片打开期间，这些设置已被其他地方改动。请关闭后重新打开，在当前值上编辑。」「重试」「创建提供商」「创建中…」「无法解析设置路径」（`src/locales.ts:150-196,265-266`）。

删除弹窗：「删除 {provider}？」「删除 {provider} 会移除其配置和存储的 API 密钥。」（将清凭据时）/「删除 {provider} 会移除其配置；其使用的凭证（如有）由其他位置管理，将会保留。」（不清时）/「删除 {provider}」「正在删除 {provider}…」（`src/locales.ts:157-161`）。

获取模型弹窗：「获取可用模型」「正在询问提供商…」「请先填写 API 地址，再获取。」「该提供商没有列出任何模型，请手动添加。」「选择模型」「以下是模型提供商的可用模型，勾选的模型即为模型列表。」「搜索模型」「没有匹配的模型。」「全选」「取消全选」「更新列表」「请至少保留一个勾选的模型。」（`src/locales.ts:245-256`）。

引导弹窗：「预览版说明」+ 正文、「继续」「暂时无法保存确认状态，请重试。」「添加一个 API Key 开始使用」「配置 DeepSeek 官方模型，即可开始使用。」「稍后配置」「保存并继续」「保存中…」「请输入 API 密钥后继续。」（`src/locales.ts:258-266`；DeepSeek 特有，见 `7.2`）。

### 2.9 字典中存在但当前构建未引用的文案（未确认用途）

`modelNamePlaceholder`「留空时使用模型 ID」、`modelCapacityInvalid`「容量需为数字，可加 K 或 M 后缀。」、`modelDuplicate`「每个模型 ID 只能出现一次。」——在 `src/locales.ts` 定义但 grep 不到渲染处（与 bundle 一致）；仿制时可省略或用作字段下方说明。

---

## 3. 交互与状态机

### 3.1 行展开 / 编辑卡

- 一次只展开一张编辑卡（`editing` 单值）；点行内「编辑」= 打开该行的编辑卡并收起添加卡；再点=收起（`bundle settings-models/lib/client.js:2594-2599`）。
- 每类卡片（行编辑器 / 首次运行 setup 卡 / 添加卡）各自持有展开状态，互不丢草稿（`README.zh.md:35`）。
- 「就绪门」：`status !== 'ready'` 时「编辑」「删除」「添加模型提供商」禁用；打开任一编辑器/添加卡/删除确认都等待当前刷新完成（`README.zh.md:39`、`bundle .../client.js:2593-2607`）。后台刷新保留已挂载编辑器的草稿；页面加载失败或提供商被移除会关闭编辑器。
- 保存成功（`onClose(true)`）→ `controller.load()` → 显示「已保存 {provider}。」（`bundle .../client.js:2371-2375`）。

### 3.2 「自定义设置」折叠区

`details/summary` 原生折叠，独立于行展开；关闭行不丢弃折叠区内的草稿（草稿在卡片 state）。

### 3.3 「添加模型提供商」卡片与分段切换

- 入口按钮：任一 `settings.section` 命名空间挂载即出现；`disabled = !writable ‖ status!=='ready' ‖ (两种方式都不可继续)`（`bundle .../client.js:2762`）。
- 打开后默认落在「第三方模型提供商」（有目录可采用时）否则「自定义模型 API」（`bundle .../client.js:2765-2771`）。
- 分段控件（SegmentedControl）仅当两种方式都可用时渲染；只剩一种时卡片以该方式名作标题直接渲染表单（`bundle .../client.js:2665-2670`）。
- 每种方式只在其命名空间挂载时提供；不可继续时禁用该段并把原因作悬停提示：「目录中的提供商都已添加。」「没有可用的 API 协议。」
- 面板在方式首次显示时挂载，之后保持挂载但 `hidden`——切换不丢任一边草稿；任一面板有写入或端点探测在途时切换被锁定（`catalogBusy/customBusy`）（`README.zh.md:70`、`bundle .../client.js:2477-2478`）。
- tab/panel 通过 `id` + `role=tabpanel/aria-labelledby` 关联（`bundle .../client.js:2677-2681`）。

### 3.4 「获取可用模型」→ 搜索选择器 → 「更新列表」（master 语义）

1. 触发：模型目录标题行右侧「获取可用模型」；`disabled‖busy‖!askable‖probeBlocked`；请求用**表单当前值**（含未保存密钥）调 `llm/discoverModels`（`src/ModelListEditor.tsx:209-230`、`README.zh.md:70`）。
2. 成功且空列表 → 该按钮下方红字「该提供商没有列出任何模型，请手动添加。」；失败 → 同处显示 Host 拒绝消息（手填模型不受影响，`README.zh.md:70`）。
3. 弹窗「选择模型」：
   - 候选 = 原始模型 id（等宽字体，单行省略，`title=模型名 ?? id`）；重复 id 只列一次。
   - 勾选初值：已配置 id 全勾；若当前列表无任何已配置 id（空列表=提供完整 catalog）则全部勾选（`src/ModelListEditor.tsx:246-249`）。
   - 搜索：按 id + 可选显示名的不区分大小写子串过滤；不清除隐藏项勾选（`src/ModelListEditor.tsx:290-292`）。
   - 「全选/取消全选」只作用于**可见**候选（防止误删隐藏的已配置模型，`src/ModelListEditor.tsx:293-305`）。
   - 「更新列表」= 保留未被点名/已勾选的既有行（用户改过的值优先）+ 追加新勾选候选（复制 id/name/contextWindow/maxTokens/输入类型）+ 移除「在候选中且被取消勾选」的已配置行；半填（无 id）行不动（`src/ModelListEditor.tsx:253-271`）。
   - 若更新会把非空列表清空 → 「更新列表」禁用，title「请至少保留一个勾选的模型。」（空列表代表完整 catalog，清空≠删除，`src/ModelListEditor.tsx:268,404-405`）。
   - 「取消」关闭弹窗不写任何东西；保存/创建之前不落库（`providers.zh.md:37`）。
4. 内置（目录）提供商的探测由已安装目录应答而非端点；要看网关真实模型需用自定义提供商（`providers.zh.md:39`）。

> asar 0.2 差异见 `0.1`：按钮为「添加所选」、仅追加、取消全选清全部。

### 3.5 模型行编辑

- 展开「模型选项」（chevron）→ 2 列容量字段 + 输入类型 + （手工声明路由）推理等级（`src/ModelRow.tsx:58-106`）。
- id/name 输入即时写入草稿（name 清空=删除字段）；DeepSeek 变体 id 失焦 trim。
- 容量输入有编辑缓冲：键入文本保存在行级 state，解析失败（NaN）时保留原文，失焦若可解析则清除缓冲显示格式化值（`formatCapacity`：整百万→`xM`、整千→`xK`、否则原样）（`src/DeepSeekModelsEditor.tsx:56-59`）。
- 模型排序（master）：拖拽手柄整行拖放（前后插入标记），或聚焦手柄按 ↑/↓；移动后各模型的参数、展开状态、未完成容量输入随行保留（`useModelRows.ts:41-48`、`README.zh.md:60`）。
- 删除模型行：仅删除该行；行本地状态按 index 丢弃（`useModelRows.ts:102-105`）。
- 「恢复默认模型」：unset 整个 `models` 覆盖（含其他模型编辑），清空行本地状态（`README.zh.md:61`、`bundle .../client.js:701-705`）。
- 输入类型复选框：至少保留一项；DeepSeek 取消「图片」→ 同删 `imagePixelBudget`/`imageMaxBytes`；恢复继承需手编 `cordis.patch.yml` 清字段（`providers.zh.md:83-85`）。

### 3.6 删除提供商

1. 行内「删除」（仅 `removable`：用户层单独承载该路径且组合基线没有；`bundle .../client.js:1371`）→ 确认弹窗。
2. 弹窗文案二选一：将清凭据 →「删除 {provider} 会移除其配置和存储的 API 密钥。」；否则 →「…其使用的凭证（如有）由其他位置管理，将会保留。」（`src/ModelsSection.tsx:731`）。
3. 确认后：**先**`credentials.unset`（仅当凭据引用恰为本页派生的 `<ROUTE>_API_KEY` 且已配置且可写），**再** `settings.mutate` unset 该 profile，最后刷新；两步幂等，凭据先行以便失败可重试且行仍可见（`src/ModelsSection.tsx:153-170`、`README.zh.md:95`）。
4. 删除进行中按钮禁用，文案「正在删除 {provider}…」；失败在弹窗内红字显示。

### 3.7 恢复默认模型

见 `3.5`；仅在「已自定义模型目录」时可见，作用域为整个模型数组（不是单行）。

### 3.8 保存 / 取消 / 冲突 / 只读

- 底栏（EditorFooter）：左「取消」右「保存」（busy 时「保存中…」），右对齐、间距 8px（`src/EditorFooter.tsx`、`bundle .../client.js:205-223`）。
- 提交 = `settings.mutate(ns, pathOps, expectedRevision)`：只写改动字段（每字段一次 set、每清除字段一次 unset），携带卡片当前 revision；成功后采纳返回的脱敏 user 子树与新 revision 再存凭据——凭据阶段失败只重试该阶段（`src/ProviderEditor.tsx:134-171,268-310`、`README.zh.md:95`）。
- 冲突：另一标签页/外部编辑 `cordis.patch.yml` 导致 revision 过期 → `settings/conflict` → 编辑器保持打开并显示「这张卡片打开期间，这些设置已被其他地方改动。请关闭后重新打开，在当前值上编辑。」（`bundle settings-controller/lib/types/index.js:254-259`）。
- 只读部署：`writable=false` 时页面顶部黄字「当前部署的设置文档为只读。」且所有写入按钮禁用。
- 页面加载失败：红字「加载提供商目录失败: {message}」+「重试」按钮（`bundle .../client.js:2425-2441`）。
- 外部事件收敛：订阅 `settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated`、`llm/adapters-updated`、`connection/reset`，仅在页面已加载过时刷新（`src/index.ts`、`README.zh.md:95`）。

### 3.9 首次运行姿态与引导（DSH 特有）

- `needsSetup`：整段配置的提供商 + 尚无任何可用提供商 + 凭据未配置 + 非账号行 → 该行以**展开的 setup 卡**渲染而非收起行；用户关闭后本会话回退为普通行（`src/ModelsSection.tsx:181-192`、`README.zh.md:35`）。
- 引导协调器：① 版本化「预览版说明」弹窗（`welcomeNoticeVersion`=`2026-09-28.1` 写入 `ui-settings-general`，显式点「继续」才记录）→ ② DeepSeek 官方密钥弹窗（credential-only 编辑器 + 「稍后配置」/「保存并继续」；任何可用提供商存在即跳过）（`README.zh.md:71,101`、`bundle .../client.js:2895-2975`）。Electron preload 标记与 `credentialOnboarding: false` 可整体关闭（`src/index.ts:82`）。

### 3.10 状态机总览（文本）

```text
页面加载: idle → loading → ready | error(重试)
行状态:  收起行 ⇄ 展开编辑卡（保存→savedNotice→收起；取消→收起）
        首次运行: 展开 setup 卡 → 关闭 → 永久变回收起行（本会话）
添加卡:  收起(＋按钮) ⇄ 展开[第三方 | 自定义]（切换保留双方草稿；busy 锁定切换）
获取模型: 按钮 → 询问中(busy) → 弹窗(勾选态=已配置∪补选) → 更新列表/取消
        ↘ 失败/空列表 → 错误提示（手填继续）
模型行:  收起 ⇄ 展开(模型选项)；拖拽/↑↓ 换位；删除；恢复默认模型=整表重置
保存:    校验失败(字段级错误, 禁止提交) → mutate(revision) → 冲突(保持打开) | 成功 → credentials.set → 关闭+savedNotice
删除行:  确认弹窗 → credentials.unset(条件) → settings.unset → 刷新 | 失败→弹窗内错误
```

---

## 4. 凭据逻辑

### 4.1 只写存储与派生引用

- 输入框初始为空、`autocomplete="new-password"`；已保存凭据**从不回读**进输入框（`README.zh.md:45`、`src/ApiKeyInput.tsx`）。
- 眼睛按钮：输入非空才出现；「显示密钥/隐藏密钥」切换 `type=text/password`（`aria-pressed`）；任何输入变化立即重新遮罩（`src/ApiKeyInput.tsx:51-56`）。
- 键入的密钥经 `credentials.set` 只写存储：引用 = profile 的 `apiKeyEnv`，无则派生 `<ROUTE>_API_KEY`（`deriveKeyRef`：大写、非字母数字连续段→`_`，再加 `_API_KEY`；`src/store.ts:125-127`），pi-ai profile 把派生记为 `apiKeyEnv`；`cordis.patch.yml` 永不带密钥值。
- 新 pi-ai 提供商留空密钥 = 保存无引用 profile，保留原生认证（Bedrock 链、Vertex ADC 等）（`README.zh.md:47`）。

### 4.2 占位符与帮助提示的推导顺序（实现者照抄）

```text
namedRef   = 有效 profile.apiKeyEnv（非空字符串）
nativeAuth = namedRef==null ? 目录为该路由报告的 nativeAuth : null
authRefs   = namedRef!=null ? [namedRef]
            : nativeAuth.env 过滤掉 baseURLEnv 地址变量
visibleRefs= authRefs 过滤掉 /oauth/i（不区分大小写）
keyHint    = visibleRefs[0]

占位符: credentialRequired 或 keyHint==null → 「输入 API 密钥」
        否则检测到已保存凭据(source==='file') → 「留空使用已保存凭据」
        否则 → 「留空使用环境认证（{keyHint}）」
帮助「?」: visibleRefs 为空 → 不显示
        否则 Tooltip = 「优先使用已保存的凭据。此处显示的环境后备按以下顺序
        排列：{visibleRefs.join(' / ')}。来源依次为启动环境、$cwd/.env、$DSH_HOME/.env。」
无密钥认证(nativeAuth.env 为空且 oauth) → 整个密钥字段与帮助都不渲染；
显式引用仍显示字段（即使该引用因含 oauth 被隐藏提示）。
```

证据：`src/ProviderEditor.tsx:373-404`、`README.zh.md:47`。

### 4.3 认证状态提示（输入框下方一行）

仅当**密钥输入为空**且**非已保存凭据**且**存在可见提示引用**且非 credentialRequired 时显示（`src/ProviderEditor.tsx:387-391,437`）：

| 条件 | 文案 | 颜色类 |
|---|---|---|
| 全部引用都确认未配置（missingRefs） | 「未检测到环境变量。请填写 API 密钥，或设置环境变量 {hint}。」（hint=首个可见引用） | `notice` = 警告黄（`--dsw-alias-state-warn-label`） |
| 已检测到环境引用但含 oauth 被隐藏 | 「已检测到环境变量」 | `savedNotice` = 成功绿 |
| 已检测到可见环境引用 | 「已检测到环境变量（{hint}）」 | `savedNotice` = 成功绿 |
| 读取状态未确认 | 「环境凭据状态尚未确认」 | `advancedHint` = 中性灰 |

检测口径：脱敏 `credentials.describe`（configured/source/writable），每批 ≤64 个引用（`src/store.ts:278-280`；控制器侧同为 64，`bundle settings-controller/lib/types/credentials.js:50-53`）；地址变量（`baseURLEnv`）不算凭据；**不**验证凭据、不测连接、不查 AWS profile / Google ADC 等提供商管理文件（`README.zh.md:53`、`providers.zh.md:21`）。输入非空时不显示状态文字。

### 4.4 行状态点（绿/红实心圆，8px）

| 状态 | 判定（`src/ModelsSection.tsx:459-461`） | 呈现 |
|---|---|---|
| 绿点 | `row.credential?.configured === true`（具名引用确认已配置） | `credentialDotConfigured`，`role=img`，title/aria「API 密钥已配置」 |
| 红点 | 非已配置 **且** 行有具名引用（`apiKeyEnv != null`）**且** `credential.configured === false`（确认缺失） | 「API 密钥缺失」 |
| 无点 | 其余（无引用的原生认证路由、状态未确认） | 不渲染 |
| 账号行 | `deepseek-account` | 绿点 + 「已登录」文字（`accountStatus`） |

### 4.5 删除时的凭据清理范围（刻意收窄）

仅当 `row.apiKeyEnv === deriveKeyRef(provider)`（即引用恰为本页派生目标）**且** `credential.configured && credential.writable` 时才随行删除凭据（`src/ModelsSection.tsx:200-210`）；自定义引用、环境凭据、无法识别的目标一律保留（`README.zh.md:139`）。自定义表单创建的提供商同理（`apiKeyEnv=deriveKeyRef(route)`）。

---

## 5. 视觉设计（确切规格）

### 5.1 截图实测（[截图A] 模型页 1600×850、[截图B] 自定义表单 1128×1390，均为 2× 高分屏）

[截图A]：设置面板白底大圆角（≈28px）；左栏「设置」+ 四个导航项，选中项浅灰圆角底；右上「打开配置文件」描边胶囊按钮 + ×。内容列：标题「模型」（粗）→ 灰色引言 → **提供商卡**（浅灰底、≈20px 圆角、宽约 1130px/2≈565px）：卡内「DeepSeek」粗体 + 灰色路由「deepseek-official」→ 小号灰标签「API 密钥」→ 全宽输入框（白底、浅描边、圆角≈12px、placeholder 极浅灰「输入 API 密钥」）→ 发丝分隔线 → 「› 自定义设置」（12px 灰字 + 小三角）→ 右下「取消」（白底描边胶囊）+「保存」（**纯黑填充**、白字胶囊）。卡下方全宽**虚线圆角按钮**「＋ 添加模型提供商」居中。

[截图B]：顶部**分段控件**——灰色圆角容器（R12）内两段：未选「第三方模型提供商」灰字，选中「自定义模型 API」白底圆角片（R8）+ 细描边/微阴影；下一行灰色说明文字；随后字段纵向排列（标签 12px 深灰、输入框 32px 高/R12/白底/浅描边，占位极浅灰）：Provider ID（占位 acme-gateway）→ 灰色帮助行 → 显示名称 → API 地址（占位 https://gateway.example/v1）→ API 协议 select（宽约 240px、右侧下拉箭头）→ API 密钥 → 发丝分隔线 → 「模型目录」标题行（左侧标题 + 右侧灰色「获取可用模型」链接钮）→ 虚线空态框「模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。」→ 左侧「＋ 添加模型」小描边按钮 → 右下「取消」+「创建提供商」（禁用态=灰填充）。

### 5.2 设计 token（ui-theme；浅色 `body{…}` / 深色 `body[data-ds-dark-theme]{…}`）

| token | 浅色 | 深色 | 数值 |
|---|---|---|---|
| `--dsw-alias-label-primary` | neutral-bluish-1000 | neutral-bluish-50 | #0f1115 / #f9fafb |
| `--dsw-alias-label-secondary` | bluish-700 | bluish-300 | #61666b / #cfd3d6 |
| `--dsw-alias-label-tertiary` | bluish-600 | bluish-400 | #81858c / #adb2b8 |
| `--dsw-alias-label-dimmed`（占位/禁用） | bluish-200 | bluish-750 | #e1e5ee / #43454a |
| `--dsw-alias-label-caption` | bluish-400 | bluish-600 | #adb2b8 / #81858c |
| `--dsw-alias-state-success-primary` | green-500 | green-500 | #22c55e |
| `--dsw-alias-state-error-primary` | red-600 | red-400 | #ec1313 / #f25a5a |
| `--dsw-alias-state-warn-label` | amber-600 | amber-600 | #dd8629 |
| `--dsw-alias-state-business-primary`（焦点/主色） | deepseek-500 | deepseek-400 | #4176e6 / #7aaaff ⚠️品牌色，仿制需替换（`7.4`） |
| `--dsw-alias-button-primary-fill` / hover | brand-primary（bluish-1000/50）/ bluish-750 或 100 | | 保存按钮填充=黑（浅色） |
| `--dsw-alias-bg-layer-1` / `-2` | bluish-00 #fff | bluish-875 #232324 / bluish-850 #2c2c2e | |
| `--dsw-alias-bg-module-platform`（编辑器底） | bluish-60 #f9fafb | bluish-800 #353638 | |
| `--dsw-alias-settings-card-fill` / `-stroke` | =bg-layer-2 / =border-l4 | 同左 | `docs/ui-radius.zh.md:98-106` |
| `--dsw-alias-border-l2/l3/l4` | #0000001a / 1f / 29 | #ffffff1f / 29 / 33 | 0.5px 发丝线 |
| `--dsw-alias-interactive-bg-hover` / `-solid` / `-danger` | #2631480f / bluish-75 #f1f3f5 / #ec13130d | #ffffff14 / bluish-800 / #f25a5a26 | |
| `--dsw-focus-ring-width/-color` | 2px / business-primary（可覆写为 transparent） | | `bundle ui-theme/lib/client.js` |
| `--ds-font-family-code` | "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, "PingFang SC", … | | 模型 id、API 参数值用等宽 |

证据：`bundle ui-theme/lib/client.js`（token 定义；浅/深块位置 65046/71865）。

### 5.3 圆角与尺寸规范（`docs/ui-radius.zh.md:30-43,71,98-106`）

| 档位 | token | 值 | 本界面用途 |
|---|---|---|---|
| R4 | `--dsw-radius-xs` | 4px | 徽章「自定义」 |
| R8 | `--dsw-radius-sm` | 8px | 行内 28px 小按钮、图标按钮、添加模型/添加档位按钮、折叠 summary、分段控件分段 |
| R12 | `--dsw-radius-md` | 12px | 36px 按钮、32px 输入框/选择器、候选行、分段控件外层 |
| R16 | `--dsw-radius-lg` | 16px | 编辑卡/添加卡/模型行容器、添加大按钮 |
| R20 | `--dsw-radius-xl` | 20px | 提供商行卡（设置卡片材质） |
| R28 | `--dsw-radius-panel` | 28px | 设置面板/对话框外壳 |

通用：固定尺寸用 `box-sizing:border-box`；圆角继承主题 `superellipse(1.5)` 曲线；正圆（状态点 50%）必须配 `corner-shape: round`；中性描边一律 0.5px 发丝线，dashed 标记与状态色边框用 1px；高层表面（菜单/弹窗）`border:0` + `--dsw-elevation-*` 投影（`docs/web-styling.zh.md:26,30`）。按钮默认值：sm=H28/R8、md=H36/R12；输入框 H32/R12（`docs/ui-radius.zh.md:41`）。

### 5.4 ModelsSection CSS 规格（`bundle settings-models/lib/client.js:59` 全量；类名前缀 `_6fYtdq_`）

| 区块 | 关键规则 |
|---|---|
| section | max-width:720px；display:flex；flex-direction:column；gap:12px；color:label-primary |
| title / intro | 16px/24px 500 / 14px/22px（tertiary） |
| notice / savedNotice / error / advancedHint | 12px/18px；warn 黄 / success 绿 / error 红 / tertiary 灰；margin:0 |
| rows | flex column gap:8px；margin:12px 0 0；list-style:none |
| rowCard | border:.5px solid settings-card-stroke；background:settings-card-fill；border-radius:20px；padding:12px 14px；gap:12px |
| rowHead / rowIdentity / rowName / rowTag | flex gap:10px / inline-flex gap:6px min-width:0 / 14px 22px 500 / 0.5px border-l3、radius 4px、padding:1px 6px、11px/16px |
| credentialDot | 8×8px、border-radius:50%、corner-shape:round；configured=success 绿、missing=error 红 |
| accountStatus | 13px/20px、success 绿、inline-flex gap:6px |
| rowActions | margin-left:auto；gap:4px |
| primaryButton / secondaryButton / dangerButton / addButton | box-sizing:border-box；radius 12px；height:36px；padding:0 14px；font:14px/22px；gap:4px。primary=button-primary-fill+label-primary-foreground，hover=button-primary-hover；secondary/add=0.5px border-l3+透明底，hover=interactive-bg-hover(-solid)；danger=error 红字，hover=interactive-bg-hover-danger。行内变体 28px/12px/radius 8px/padding 0 10px |
| 禁用 | 按钮族 opacity:.4 cursor:default；输入/keyToggle opacity:.6 |
| focus-visible | box-shadow:0 0 0 2px var(--dsw-focus-ring-color, business-primary)；outline:none（keyToggle 用 outline 2px、offset -2px） |
| editor / addCard / setupCard | radius 16px；background:bg-module-platform；padding:14px 16px；gap:14px（addCard/setupCard 内的 editor 去底去padding） |
| editorHeader / editorTitle / editorRoute | baseline gap:8px / 14px 22px 500 / 12px 18px tertiary |
| field / fieldLabel / helpButton | flex column gap:6px / 12px 18px 500 secondary / 16×16 圆形 0.5px border-l3、11px「?」、cursor:help |
| customized | border-top:.5px border-l2；padding-top:10px；summary：12px 500 secondary、radius 8px、padding 2px 4px、自带 5×5 三角箭头（rotate -45°/45°、transition .12s） |
| customizedBody / modelCatalog | gap:12px padding-top:12px / border-top:.5px border-l2、gap:10px padding-top:12px |
| modelCatalogTitle / Meta / modelEmpty | 12px/18px 500 secondary / tertiary / 空态：1px dashed border-l3、radius 16px、padding:12px、居中 |
| modelList / modelListHead / modelEntry | gap:8px / space-between / 0.5px border-l4、radius 16px、padding:6px |
| modelRow | grid: minmax(0,1.4fr) minmax(0,1fr) auto auto；gap:6px；align-items:center |
| modelAdvanced | grid 2 列；gap:8px；padding:8px 4px 2px |
| modelInputTypes | fieldset 无边框、grid-column:1/-1；复选框行 gap:16px、min-height:32px |
| modelReasoning* | grid-column:1/-1；行 grid:1fr 1fr auto；API 参数值输入等宽 13px |
| iconButton | 28×28、radius 8px、tertiary；hover=interactive-bg-hover+label-primary；danger 变体 hover=hover-danger+error |
| addBlock / addActions / addButton | gap:12px / flex / 1px **dashed** border-l3、radius 16px、height:44px、min-width:180px、flex:1、gap:6px |
| addModes / addPanel | gap:8px / gap:14px；`[hidden]{display:none}` |
| input | width:100%；height:32px；radius 12px；border:.5px border-l4；background:bg-layer-1；padding:0 10px；14px/22px；focus→border-color business-primary；placeholder= label-dimmed；`select.input{max-width:240px; cursor:pointer}` |
| selectInput | appearance:none + 内嵌 SVG 下拉箭头（12×12，stroke #81858C 1.5，右 12px 居中），padding-right:32px |
| keyInput / keyInputFilled / keyInputToggle | position:relative / 有值时 padding-right:40px / 眼睛按钮 32px 宽、inset:1px 1px 1px auto、radius 12px |
| deleteDialog / deleteConfirm | width:min(480px,100%) / 确认钮红字红描边、hover=hover-danger |
| fetchDialog / candidate* | max-width:520px（自定义滚动条变量）；toolbar gap:8px margin-bottom:6px；search flex:240px；列表 gap:2px、max-height:320px、overflow-y:auto；行 radius 12px；label padding:6px 8px gap:8px；id 等宽 13px 单行省略；空态 13px/20px secondary、margin:24px 0 |
| 动效 | 仅两处过渡（summary 箭头 .12s、开关滑块）；`prefers-reduced-motion:reduce` 时全部 transition:none |

图标（ui-primitives，尺寸实测）：眼睛 16×16（stroke 1.3、round）、加号/垃圾桶/chevron 14px、导航图标 16px。**ui-primitives 内部（SegmentedControl/Switch/Checkbox/Modal/Tooltip/Button 的精确尺寸）未确认**——只能从截图与 `docs/ui-radius.zh.md:71`（SegmentedControl：外层 R12、4px 内缩、R8 分段与指示器）与 `:41`（Button sm=H28/R8、md=H36/R12）推得。

### 5.5 模型选择器样式（`bundle model-selection/lib/client.js:1060-1101`，类前缀 `cl2Rlq_`）

触发器：height:28px、radius 8px、13px/20px 400、padding:0 4px 0 8px、gap:4px、max-width:min(360px,45cqw)；文字+推理等级（caption 色）；hover=interactive-bg-hover；chevron 12px caption 色、展开旋转 180°（.12s）。菜单：fixed、z-index:1100、width:max-content、min-width:min(240px,100vw-32px)、max-width:min(420px,100vw-32px)、max-height:min(360px,100vh-96px)、padding:4px、`--dsw-elevation-prominent` 投影、border:0。选项行：min-height:34px、radius 12px、padding:5px 7px、gap:6px、名称 13px/18px 400、勾选列 14px。搜索行：输入 12px、placeholder=caption、清除按钮 24px 圆形。分组标题吸顶时才上底色（94% 不透明填充，macOS 之外 md 圆角，`ui-model-selection/README.zh.md:45`）。

---

## 6. 模型选择器（dsh-client-ui-model-selection）

### 6.1 入口

1. **composer 触发按钮**（`conversation.input.model` 席位）：待处理指示器旁，显示「模型名 · 推理等级」（触发器文案 = 模型名 + " · " + 推理等级名，`bundle model-selection/lib/client.js:1459-1460`）；空间不足时文字换模型图标（`--dsh-composer-model-icon/text-display`）。
2. **`/model` 命令**：popupSelect 弹窗（`searchMode:'fuzzy-label'`，命令名「模型」、描述「选择本会话使用的模型」），被寻址的 subagent 会话不可用（`bundle model-selection/lib/client.js:1869-1899`）。
3. 两入口共享同一会话级目录与提交通道（`ModelDirectory`），任一切换立即反映到另一入口；选择自下一次请求生效（`ui-model-selection/README.zh.md:15,77`）。

### 6.2 结构与显示内容

- 两级菜单（根菜单→下钻）：根菜单两行 cell「模型 | 当前值 ›」「推理等级 | 当前值 ›」（无推理元数据时无第二行）；下钻模型面板按**提供方分组**（DeepSeek 账号 → DeepSeek → 其余目录序，`bundle model-selection/lib/client.js:1109-1111`），分组标题=提供方名，行=模型名，选中打勾；不重复显示提供方、不显示目录说明。
- composer 菜单只显示模型与推理等级名称；所有名称 400 字重（含选中项）。
- 推理等级面板：行 = 档位名（含「Default」= providerDefault），勾选当前档位；模型无档位时显示「当前模型未提供推理等级。」

### 6.3 搜索与排序

- composer 菜单仅当目录 >4 个模型时显示搜索框；`/model` 恒有（`bundle .../client.js:1188`）。
- 匹配：模型名（`rankByName`）不区分大小写、按序不连续子串、忽略首尾空格；组内排序=前缀匹配 → 匹配得分 → 目录顺序；无匹配分组隐藏（`ui-model-selection/README.zh.md:41`）。
- 空目录「暂无可用模型」、无匹配「没有匹配的模型。」，均以 `role=status` 朗读。

### 6.4 键盘与鼠标（`bundle .../client.js:1363-1415`、`ui-model-selection/README.zh.md:35-37`）

| 键 | 行为 |
|---|---|
| ↑/↓ | 根菜单/推理面板：移动行焦点；模型面板带搜索框：循环移动高亮并把焦点留在搜索框 |
| Enter / Tab | 选定高亮模型或聚焦行（Tab 在行上=点击） |
| Escape / Shift+Tab | 先退出下钻面板（回到根菜单），否则关闭并回到触发按钮 |
| Tab（从触发器） | 进入面板：带搜索→聚焦搜索框；否则聚焦当前选中行/首个可用行 |
| 下钻时聚焦 | 桌面：有搜索框→搜索框，否则当前模型/推理行；手机/平板：用户主动点按或键盘导航前不聚焦搜索框（master） |
| 鼠标 | 悬停即高亮；仅按下不选定；再次点击触发器关闭并回焦；选择后回焦触发器但不显示焦点环（`data-selection-focus`） |

### 6.5 状态

- 目录加载中：触发器「正在加载模型…」；面板内「正在刷新模型列表…」；待提交选择在途时触发器箭头换 spinner、对应行勾选位换 spinner（`StateDot`）。
- 载入失败：行内红条「模型操作失败：{message}」+「重新加载」；单提供方失败显示黄条「{name} 加载失败：{message}」+ 重试，且该组为不可选失败行（`option.loadError`「目录加载失败：{message}」）。
- 选择被拒（如 `session/writer-held`）：菜单保持打开，composer 卡片锚定 Toast 显示「当前会话已被占用，可能是其他正在运行的 DSH 导致的…请退出其他正在运行的 DSH 后重试。」
- 已保存选择不在目录时：触发器显示「请选择模型」并隐藏推理等级文案；目录恢复后重新显示名称（`ui-model-selection/README.zh.md:33`）。
- 模型名扩展槽 `conversation.input.model.label`（single/inline，placement: trigger|menu|option）可替换显示名；无贡献者显示目录名（`ui-model-selection/README.zh.md:51-55`）。

---

## 7. 可裁剪建议（在另一款桌面应用里仿制）

### 7.1 必须保留（功能内核）

1. 提供商行 + 一次一张编辑卡 + 卡内「API 密钥（只写）」+「自定义设置」折叠（baseURL / 模型目录）。
2. 模型目录编辑：id/显示名称/上下文窗口/最大输出 token/输入类型（文本+图片）/（可选）推理等级成对配置；「添加模型」「删除模型」「恢复默认模型」。
3. 「获取可用模型」→ 可搜索候选选择器 →「更新列表」（master 语义）＋ 手填兜底。
4. 添加提供商卡片：分段切换 + 独立创建表单（Provider ID/显示名称/API 地址/API 协议/API 密钥/≥1 模型）。
5. 凭据只写 + 眼睛显隐 + 占位/帮助推导 + 绿/红状态点 + 删除时窄范围清理（`4`）。
6. 校验全集（`2.7`）与错误文案就近展示；保存带 revision、冲突提示、只读与加载失败态。
7. 模型选择器（`6`）——至少 composer 入口 + 分组 + 搜索 + 推理等级。

### 7.2 可裁剪（DSH 特有）

| 项 | 理由 |
|---|---|
| **DeepSeek 账号行**（`deepseek-account`、「已登录」、账号目录、modelOverrides） | 深度绑定 DSH 账号服务；且属品牌资产 |
| **首次运行双弹窗**（预览版说明 + DeepSeek 官方密钥引导、`credentialOnboarding`/preload 开关） | 产品引导，可整体省略或换成自己的 onboarding |
| **扩展 slot**（`settings.models.provider-card`、`settings.models.footer`、`settings.models.sign-in`、`conversation.input.model.label`） | 插件生态扩展点；无插件需求可省 |
| **pi-ai 路由 / `llm-pi-ai`·`llm-deepseek` 双命名空间**、`cordis.patch.yml` 提示文案、`apiKeyEnv`/`baseURLEnv`/`nativeAuth` 目录语义 | DSH 配置平面特有；仿制时简化为单一「提供商配置」模型 |
| **第三方提供商目录选择器**（休眠目录、`anthropic/openai/moonshotai/zai` 等内置 id） | ⚠️ 目标项目有测试守护契约「**禁止任何预置提供商模板/厂商预置目录**」——**不能照搬**，按下节改型 |
| 已安装 catalog 回退（`inputDefaults`、目录应答探测）、`CAPACITY_HINT 1M/128K` 等适配器默认值 | 属「预置目录」范畴；改由用户配置或可选插件提供 |
| 埋点（`productAnalytics`、`api_key_save_click`）、`打开配置文件` 按钮、多语言（ja/es/fr…） | 按需 |

### 7.3 适配形式：无厂商预置目录的「添加模型提供商」

把 DSH 的「目录选择 vs 自定义表单」两分段改型为**按 API 类型分段**（不出现任何厂商名/预置模板）：

```text
[ 添加模型提供商 ]
├─ SegmentedControl「添加方式」
│   ├─ 「第三方兼容 API」   → 同一创建表单，但协议先选（OpenAI Chat Completions /
│   │    OpenAI Responses / Anthropic Messages），端点与模型全部用户输入；
│   │    仅提供「示例占位」（https://gateway.example/v1），无任何厂商名录
│   └─ 「自定义模型 API」   → 完全手工路由：Provider ID、显示名称、API 地址、
│        API 协议、API 密钥、手工模型行（可推理等级）
└─ 两者共用同一 profile 写入与凭据写入（`3.6/`4）
```

- 分段控件、面板挂载/隐藏/锁定、草稿保持、禁用原因提示等**交互照抄 `3.3`**。
- 「获取可用模型」**保留**（询问的是用户自己的端点，不是预置目录）；删除 `catalogProvider`/已安装目录回退分支。
- 若未来允许用户**自行导入**提供商模板（用户数据而非内置），可把第一段换回「从我的目录选择」——接口上把 DSH 的 `addable[]`（目录来源）做成可注入列表，默认空。
- 容量占位改由用户提供或显示「使用提供商默认值」；不要硬编码 1M/128K 之类厂商默认。

### 7.4 品牌合规（`BRAND_GUIDELINES.zh.md:7-10`）

- 不复制 DeepSeek 商标/logo/品牌专属配色（DSH 的 business-primary #4176e6/#7aaaff 即品牌蓝，仿制请换自有品牌色；本文记录它仅为还原度）。
- 不使用「DeepSeek Harness」作为项目名；描述关系可用「基于 DSH 构建/兼容」或缩写 DSH。
- 「DeepSeek 账号」「DeepSeek」卡片、欢迎语文案均属品牌与产品资产，仿制时不复刻。

### 7.5 最小实现清单（照此拆工）

1. 设置壳（导航 + section 注册，`1.1`）→ 2. 行/卡片骨架 + 卡片材质（`5.3/5.4`）→ 3. 密钥输入与凭据推导（`4`）→ 4. 自定义设置折叠 + 模型目录编辑器（`2.3/2.4`）→ 5. 推理等级子组件（`2.5`）→ 6. 获取模型弹窗（`3.4`）→ 7. 添加卡与分段（`3.3/7.3`）→ 8. 删除/保存/冲突/只读（`3.6/3.8`）→ 9. 模型选择器（`6`）→ 10. 视觉校准（`5`，对照截图）。

---

## 8. 仍未确认清单

1. ui-primitives 内部规格（SegmentedControl/Switch/Checkbox/Modal/Tooltip/Button 的精确尺寸与配色）：asar 中无独立包，仅能从截图与 `docs/ui-radius.zh.md` 推得——**SegmentedControl 外层 R12/内缩 4px/分段 R8** 为文档明证，其余推断。
2. 设置导航「账号」项在 [截图A] 中缺席的原因（条件挂载 or 版本差异）；`archived-sessions` 导航 id 有图标映射但本构建未找到注册方。
3. asar 内 `locale/*.json` 被截断（仅含包元数据），完整多语言文案以仓库 `src/locales.ts` 为准；日/西/法文案已见于 master。
4. `modelNamePlaceholder`/`modelCapacityInvalid`/`modelDuplicate` 三个文案在 master 与 bundle 均未见引用，用途未确认。
5. `settings-conflict`（控制器 README 表述）与 wire code `settings/conflict`（`bundle settings-controller/lib/types/index.js:257`）为同一语义的两种拼写，仿制时以 wire code 为准；差异原因未确认。
6. 模型选择器 MenuSurface 材质、吸顶标题 94% 填充的精确色值（含 macOS 底层）未在已取文件中确认。
7. [截图A] 中提供商卡宽度/字号为 2× 屏实测换算值（≈565px 内容宽），与 CSS `max-width:720px` 的关系（内容列 vs 卡宽）未逐像素测量。
8. DeepSeek 模型「跟随官方列表、约十分钟后台刷新」的行为位于 `dsh-llm-deepseek-api-key`（`providers.zh.md:15`），本规格未展开其代码级细节。
