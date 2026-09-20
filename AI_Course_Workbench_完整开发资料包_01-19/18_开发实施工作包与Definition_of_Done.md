# AI Course Workbench｜开发实施工作包与 Definition of Done

> 不按产品 V0/V1/V2 切分。  
> 本文只描述实现依赖关系与可并行工作包。

---

# 1. 工作包 A：Project / Schema

交付：

- Project
- Stage
- ContentItem
- Document
- Block
- Requirement
- Asset
- Status
- Layout
- 新增 LayoutSection / InboxItem / ExportPreset
- schema_version
- serialization

DoD：

- 能创建、保存、重开项目；
- ID 稳定；
- JSON 可读；
- Schema 校验通过。

---

# 2. 工作包 B：Persistence / Recovery

交付：

- Atomic write；
- autosave；
- recovery journal；
- project lock；
- external modification detection；
- migration；
- trash。

DoD：

- 强杀应用后可恢复；
- 磁盘写失败明确提示；
- 不产生半写 JSON。

---

# 3. 工作包 C：Course Builder

交付：

- 多入口 CourseSeed；
- BlueprintDraft；
- BlueprintNode；
- 确认页；
- 课程树。

DoD：

- 从课程概论 / 大纲 / 表格 / 空白至少能完整创建项目；
- 创建前可调整结构；
- 不直接让 AI 改正式课程树。

---

# 4. 工作包 D：Document Editor

交付：

- ProseMirror schema；
- 弱 Block 感；
- Slash menu；
- Group；
- Requirement；
- 正文 / 结构模式；
- Undo / Redo；
- Markdown Mirror。

DoD：

- 连续写作顺畅；
- Block 可重排；
- 结构视图同步；
- Requirement 可插入、定位、完成。

---

# 5. 工作包 E：Asset / Inbox

交付：

- Media Library；
- drag/drop；
- clipboard；
- checksum；
- AssetUsage；
- Inbox；
- Quick Capture；
- 批量导入。

DoD：

- 同一素材多处复用；
- Inbox 可转 Asset / Block / Requirement；
- 缺失素材可定位。

---

# 6. 工作包 F：Status / Derived Views

交付：

- 多维状态；
- Assignment；
- 看板；
- 缺口视图；
- 项目概览；
- 自动统计。

DoD：

- 状态与缺口互不混淆；
- Requirement 数量实时反映；
- 不调用 AI 生成进度总结。

---

# 7. 工作包 G：Grid / Layout

交付：

- Flow；
- Grid；
- Track；
- Placement；
- lock；
- auto tidy；
- Section；
- content/layout Requirement；
- Preview。

DoD：

- 同一正文多个 Layout；
- Grid 不改变语义顺序；
- 文字自动高；
- Section 可导出分页。

---

# 8. 工作包 H：Version

交付：

- Git backend；
- Snapshot；
- diff；
- restore；
- restore-before-backup；
- AI apply restore point。

DoD：

- 用户无需 Git 知识；
- 可以可靠恢复命名节点。

---

# 9. 工作包 I：AI / Context

交付：

- ModelConnection；
- Provider Adapter；
- ContextPack；
- Suggestion；
- ChangeDraft；
- Diff；
- context checkbox。

DoD：

- AI 无直接写权限；
- 上下文可追踪；
- ChangeDraft 可应用 / 放弃 / 恢复。

---

# 10. 工作包 J：Conversation Connector

交付：

- Browser Companion；
- Local Bridge；
- Connector interface；
- 至少一个完整站点 Adapter；
- 对话列表；
- 选择导入。

DoD：

- 用户主动触发；
- 未选择记录不会送 AI；
- Connector 崩溃不影响工作台。

---

# 11. 工作包 K：Search / Command Palette

交付：

- SQLite 索引；
- Cmd-K；
- 分组结果；
- 快速跳转；
- 命令；
- filter jump。

DoD：

- 大项目搜索仍流畅；
- 能按 code 直接跳课程。

---

# 12. 工作包 L：Export / Publish

交付：

- ExportPreset；
- PNG；
- HTML；
- Markdown；
- PDF（如采用）；
- full project；
- preflight；
- Publication。

DoD：

- Section 导出稳定；
- Secret 不进入导出包；
- 同一 revision 导出可重复。

---

# 13. 工作包 M：Launcher / Session

交付：

- 最近项目；
- 继续工作；
- missing path relocation；
- crash recovery entry；
- tabs；
- session restore；
- Quick Capture window。

DoD：

- 用户重新打开 App 能迅速回到上次位置。

---

# 14. 工作包 N：Security / Diagnostics

交付：

- Secret Store；
- permission boundary；
- sanitize；
- bridge auth；
- structured errors；
- logs；
- diagnostic export。

DoD：

- 没有 Secret 泄漏；
- remote content 无本地特权；
- 错误可定位。

---

# 15. 实现依赖建议

可按依赖推进：

```text
A Schema
↓
B Persistence
↓
C Course Builder
↓
D Editor
↓
E Asset/Inbox
↓
F Status
↓
G Layout
↓
H Version

A/B 完成后可并行：
K Search
N Security

D/E/F/G 稳定后：
I AI
J Connector
L Export
M Launcher
```

这不是产品版本划分，只是工程依赖。

---

# 16. 最终产品 DoD

完整产品需要满足：

- 能从多个入口搭建课程；
- 能任意跳转课程而不丢进度；
- 能正文 / 结构 / 排版 / 预览；
- 能留待补并自动统计；
- 能集中管理素材与 Inbox；
- 能多维状态看板；
- 能 Flow / Grid；
- 能 Section 多页导出；
- 能自动保存；
- 能 Undo / Redo；
- 能命名版本 / 恢复；
- 能读取用户选定的外部 AI 对话；
- 能配置模型 API；
- AI 只能建议、不能越权；
- 能完整项目迁移；
- 能在错误/崩溃后恢复；
- 非技术用户不需要理解 Markdown / JSON / Git。
