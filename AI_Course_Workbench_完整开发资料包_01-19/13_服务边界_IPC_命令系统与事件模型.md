# AI Course Workbench｜服务边界、IPC、命令系统与事件模型

# 1. 前端不得直接操作系统资源

所有系统级能力通过 Desktop Service / IPC。

例如：

```text
UI
→ Command
→ Service
→ Storage / Git / Secret / Export
```

---

# 2. IPC 原则

IPC 只暴露高层、白名单 API。

错误：

```text
fs.read(path)
shell.exec(command)
git.raw(args)
```

推荐：

```text
project.open(projectId)
asset.import(files)
snapshot.create(name, note)
export.run(layoutId, presetId)
secret.set(provider, value)
```

---

# 3. Command 模型

用户的重要修改操作统一抽象为 Command。

例如：

```text
RenameContentItem
MoveContentItem
InsertBlock
MoveBlock
ResolveRequirement
ChangeStatus
MovePlacement
ResizeGridTrack
CreateSection
ApplyChangeDraft
```

Command 支持：

- validate；
- execute；
- undo（可行时）；
- event emission；
- audit metadata。

---

# 4. Query 与 Command 分离

Query 只读：

```text
getCourseTree
getMissingRequirements
searchAssets
listSnapshots
```

Command 修改：

```text
moveContentItem
resolveRequirement
createSnapshot
```

避免一个 API 同时读写。

---

# 5. Domain Event

Command 成功后发事件：

```text
ContentItemRenamed
BlockInserted
RequirementCreated
RequirementResolved
AssetImported
StatusChanged
LayoutChanged
SnapshotCreated
SuggestionAccepted
```

---

# 6. 事件用途

用于：

- 更新 UI；
- 更新派生统计；
- 更新搜索索引；
- 刷新 Markdown 镜像；
- 刷新 AssetUsage；
- 触发 autosave；
- 记录 recovery journal。

---

# 7. 禁止事件循环

事件消费者不得再次无条件发同类型事件造成循环。

必须区分：

```text
Domain Event
Derived Update
UI Notification
```

---

# 8. 前端状态

前端 Store 保存：

- 当前选择；
- 当前 Tab；
- 当前视图；
- 临时表单；
- Command 执行结果。

不应复制整个 Canonical Project 并脱离后台长期维护两个真相。

---

# 9. 长任务

以下操作视为 Job：

- 大文件导入；
- 批量缩略图；
- 全项目搜索索引；
- 导出；
- AI 分析；
- 外部聊天同步；
- Migration；
- Git restore。

Job 状态：

```text
queued
running
completed
failed
cancelled
```

---

# 10. Job UI

右下角或任务中心：

```text
正在导入 36 个素材
18 / 36
[取消]
```

完成：

```text
✓ 已导入 36 个素材
```

失败应指出具体项目。

---

# 11. Toast 使用边界

Toast 只用于短暂反馈：

```text
✓ 已保存版本
✓ 图片已加入媒体库
⚠ 3 个文件导入失败
```

不得用 Toast 承载需要用户仔细阅读的大段错误。

---

# 12. Error Object

统一错误：

```text
code
user_message
technical_message
recoverable
recommended_action
details
```

普通 UI 只显示 `user_message` 和建议动作。

开发日志保留 technical 信息。

---

# 13. Derived View 更新

例如 Requirement resolved 后：

```text
RequirementResolved
↓
MissingCount Projection 更新
↓
底部状态栏刷新
↓
制作看板刷新
↓
项目概览数字刷新
```

不需要 AI。

---

# 14. Context Pack

Context Pack 构建也作为 Job：

```text
用户选择上下文
→ resolve sources
→ hash
→ build pack
→ preview
→ model call
```

用户可以在调用前查看“本次将发送哪些来源”。

---

# 15. 外部 Connector

Connector 与核心应用通过统一协议：

```text
health()
listConversations()
fetchConversation(id)
capturePage()
sendSelection()
```

连接器失败不应使主应用崩溃。

---

# 16. 插件化边界

未来可把以下做成插件式 Adapter：

- Conversation Connector；
- Model Provider；
- Export Adapter；
- Publish Adapter。

但核心数据模型不可由插件任意改写。

---

# 17. 审计日志

建议保存轻量操作日志：

```text
时间
对象
动作
来源：user / ai-applied / migration / import
```

不记录用户正文全文，只记录操作元数据。

用于调试与恢复。
