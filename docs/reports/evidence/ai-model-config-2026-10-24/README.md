# AI 模型配置界面对照证据（2026-10-24）

本目录记录本次「AI 设置 → 模型」界面改造的**真实渲染证据**。截图取自浏览器壳 `deno task ui`（端口 4174，`PORT=4174 deno task ui`）打开同一份代码后的实际渲染，不是设计稿。

## 文件

| 文件 | 内容 |
|---|---|
| `01-before-modal.png` | 改造前的 AI 设置弹窗（旧结构：「AI 模型」标题 +「已有模型服务商」+ 绿色「+ 添加模型服务商」按钮 + 固定订阅区）。来自改造前启动、仍在运行的 dev 实例（127.0.0.1:4173，启动于 2026-10-21），其内存中缓存的是旧代码。 |
| `02-after-modal.png` | 改造后：标题「模型」、引言「填入各提供商的 API 密钥即可使用其模型。」、空态说明、**虚线通栏「＋ 添加模型提供商」**。 |
| `03-after-add-card.png` | 新增卡：三段分段控件（第三方模型提供商 / 自定义模型 API / 订阅登录）+ 逐字用途说明 + 创建表单字段顺序（Provider ID → 显示名称 → API 地址 → API 协议 → API 密钥）+「模型目录」区。 |
| `04-after-model-row.png` | 模型行编辑：↑/↓ 排序、Model ID、显示名称、上下文窗口 / 最大输出 token 两列、输入类型（文本 / 图片）、「推理等级」开关 +「?」、「＋ 添加模型」、右下黑底「创建提供商」。 |
| `05-reasoning-tiers.png` | 推理等级展开：「档位」/「API 参数值」两列，off / low / medium / high 四行起步，off 行输入禁用，每行「移除」，「添加档位」。 |

## 对照基准

上游为 `deepseek-ai/deepseek-harness`（MIT）的「设置 → 模型」页。为避免在公开仓库中再分发其品牌素材，此处不存放上游截图，请对照上游文档自行查看：

- `docs/user/guide/providers-models-page.zh.png` —— 模型页（行卡 + 折叠自定义设置 + 虚线「添加模型提供商」）
- `docs/user/guide/providers-custom-form.zh.png` —— 自定义模型 API 创建表单
- 源仓库：<https://github.com/deepseek-ai/deepseek-harness>

逐项对照结论（含与 DSH 的**有意偏差**：不设内置厂商目录（本仓库 §9.2 红线）、不设多级设置导航、密钥另设「保存密钥 / 删除本机保存的密钥」入口、不复制 DeepSeek 品牌资产与品牌色）见
[`docs/superpowers/specs/2026-10-24-dsh-model-config-design.md`](../../../superpowers/specs/2026-10-24-dsh-model-config-design.md) §1 与 §2.2。
