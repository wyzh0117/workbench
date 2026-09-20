# AI Course Workbench｜开发资料总目录

这是一套面向非技术用户的课程与长期内容生产工作台设计文档。

核心目标：

> 让用户始终知道自己有什么内容、现在做到哪里、还缺什么、下一步该做什么，并能在同一个工作台里完成写作、媒体管理、排版、版本保存、AI 协作与长期更新。

## 文档清单

1. `01_产品定位与设计原则.md`
2. `02_系统总体架构与数据分层.md`
3. `03_对象关系图与核心数据模型.md`
4. `04_编辑器_占位符_媒体_状态_排版.md`
5. `05_AI连接器_上下文_建议_版本.md`
6. `06_课程创建入口与自动生成.md`
7. `07_GUI三栏架构与核心交互.md`

## 核心原则

- GUI 是用户入口，结构化数据是真实状态。
- Markdown、JSON、Git、API Key 等技术细节尽量不向普通用户暴露。
- 状态由用户决定，完整度由 Requirement 自动计算。
- 内容与排版完全分离。
- 占位符是正式数据对象。
- 课程结构只维护一次，其他目录与视图自动生成。
- AI 只产生建议与修改草稿，不直接覆写真实课程。
- 所有 AI 上下文由用户显式勾选。
- API Key 与网页登录凭据不进入课程项目和 Git。
- 项目底层保持开放文件，确保未来可迁移。
- 自动总结不使用 AI，直接显示结构化状态。

## 推荐实现依赖顺序

```text
数据模型
↓
课程结构 / ContentItem
↓
Document / Block
↓
Requirement / Asset
↓
Status Engine
↓
Layout Engine
↓
三栏 GUI
↓
Course Builder
↓
Version Engine
↓
AI Context Engine
↓
Conversation Connectors
↓
Publication / Export
```
