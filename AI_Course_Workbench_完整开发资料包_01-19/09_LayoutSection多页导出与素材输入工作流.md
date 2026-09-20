# AI Course Workbench｜LayoutSection、多页导出与素材输入工作流

> 用途：完善 Grid 的视觉分区、多页导出、发布前检查，以及图片 / GIF / 视频 / 文件 / URL / 剪贴板等素材进入工作台的完整链路。

---

# 1. LayoutSection 正式加入

`LayoutSection` 属于排版，不属于正文。

它代表：

> 某一个 Layout 中的视觉分区 / 页面分区。

例如同一篇正文：

```text
标题
开场
案例
解释
对比
结论
练习
```

在小红书版本中可以被切为：

```text
Section 01 → 封面
Section 02 → 问题
Section 03 → 对比
Section 04 → 解释
Section 05 → 总结
```

正文 Block 不发生复制。

---

# 2. Section 的核心价值

Section 不只是分组。

更重要的是：

> **它定义导出边界。**

---

# 3. Section 导出行为

建议每个 Section 支持：

```text
连续
单独一页
从这里分页
与下一段合并
不单独导出
```

不同平台可组合使用不同规则。

---

# 4. 小红书多图示例

```text
Section 01 → 图1
Section 02 → 图2
Section 03 → 图3
Section 04 → 图4
```

导出：

```text
01.png
02.png
03.png
04.png
```

---

# 5. 公众号长图

所有 Section：

```text
连续导出
```

最终得到一张长图。

---

# 6. 网页

Section 作为页面视觉区段。

不一定分页。

可以映射为 HTML Section。

---

# 7. PDF

Section 可以作为建议分页边界。

允许：

- 自动分页；
- Section 强制分页；
- Section 连续。

---

# 8. Section 在画布中的表现

不采用 PPT 式完全分离页面。

仍保留连续长画布。

示例：

```text
────────────────────────
 SECTION 01 ｜ 封面
────────────────────────

        内容


────────────────────────
 SECTION 02 ｜ 搜索引擎
────────────────────────

        内容


────────────────────────
 SECTION 03 ｜ AI
────────────────────────
```

这样用户可以同时看到：

- 单页内部设计；
- 整套视觉节奏。

---

# 9. Section 操作

支持：

## 新建分区

在某个 Row 后插入 Section 边界。

## 移动边界

拖动 Section 边界，让 Row 进入上一段或下一段。

## 自动生成 Section

根据：

- H1 / H2；
- Group；
- 大段留白；
- 内容类型；

生成建议。

但不能未经用户确认破坏既有布局。

---

# 10. Group 与 Section 区别

## Group

属于内容层。

例如：

```text
图片
+
图片说明
```

一起移动。

## Section

属于 Layout。

例如：

```text
第1页
第2页
第3页
```

原则：

```text
Document
└── Group

Layout
└── Section
```

严格分开。

---

# 11. ExportPreset

导出不绑定某个平台的内部逻辑。

建议建立：

```text
ExportPreset
```

保存：

```text
尺寸
格式
分页方式
文件命名
边距
像素倍率
是否包含背景
媒体处理方式
```

前端可以提供：

- 小红书多图；
- 公众号长图；
- 网页；
- PDF；
- 3:4；
- 16:9；
- 自定义。

---

# 12. 发布前检查

点击导出前执行结构化检查，不调用 AI。

例如：

```text
内容级待补：2
当前 Layout 待补：1
超出画布：0
文字溢出：1
缺失素材：0
未加载字体：0
```

提示：

> 当前仍有 4 个问题。

操作：

```text
[返回修复]
[仍然导出]
```

系统提醒，但不强制阻止。

---

# 13. 素材进入工作台的方式

桌面应用应支持：

```text
拖文件
从 Finder / 资源管理器拖入
复制图片后 Cmd/Ctrl + V
截图后直接粘贴
拖文件夹
拖一批文件
拖到媒体库
拖到正文
拖到占位符
拖到 Grid
```

---

# 14. 同一个素材拖到不同区域的行为

## 拖到媒体库

只创建 Asset。

不插入正文。

## 拖到正文

创建：

```text
Asset
+
Image/GIF/Video Block
```

## 拖到对应 Requirement

创建 Asset，并：

```text
Requirement → resolved
```

## 拖到 Grid 空区域

创建：

```text
Asset
+
Placement
```

## 拖到已有媒体元素

进入“替换素材”语义。

---

# 15. 剪贴板是一等输入来源

例如用户在浏览器截图后：

```text
Cmd/Ctrl + V
```

系统根据焦点决定：

## 当前焦点：正文

插入图片 Block。

## 当前焦点：图片 Requirement

直接完成 Requirement。

## 当前焦点：媒体库

导入 Asset。

## 当前焦点：Grid

按当前选中区域或鼠标位置放入画布。

---

# 16. 粘贴网页内容

## 普通粘贴

尽可能保留：

- 文字；
- 标题；
- 段落；
- 链接；
- 基础图片。

去除：

- 网站 CSS；
- 脚本；
- 无关布局。

原则：

> 保留语义，不保留网站样式。

## 纯文本粘贴

```text
Cmd/Ctrl + Shift + V
```

去除格式。

---

# 17. 粘贴 URL

用户单独粘贴 URL 时，可以提示：

```text
作为链接
抓取网页内容
创建网页卡片
创建待处理资料
```

“创建待处理资料”进入 Inbox。

---

# 18. Inbox

建议增加项目级 Inbox。

用途：

> 先把内容扔进来，以后再决定怎么处理。

支持：

- 图片；
- 网页；
- PDF；
- 视频；
- 一句话；
- 灵感；
- 截图；
- 聊天记录；
- 语音；
- 其他资料。

---

# 19. Inbox 与媒体库的区别

## Media Library

已经成为项目资产的素材。

## Inbox

尚未决定用途的原始输入。

InboxItem 后续可以：

```text
转为 Asset
转为正文 Block
转为 Requirement
转为参考资料
转为新课程建议
忽略
```

---

# 20. InboxItem 数据模型

```text
InboxItem
├── id
├── project_id
├── type
├── content
├── file_path
├── source_url
├── note
├── created_at
├── status
└── resolved_target
```

状态：

```text
unprocessed
processed
ignored
```

---

# 21. 文件夹导入

拖入一个文件夹后，不直接全部塞入项目。

先显示导入预览：

```text
即将导入 6 个项目

图片 2
GIF 1
视频 1
文档 2

[全部导入]
[选择]
```

后台执行：

- checksum 去重；
- 读取尺寸；
- 读取时长；
- 生成缩略图；
- 建立 Asset 元数据。

---

# 22. 外部文件处理模式

支持两种：

## 复制进项目

默认推荐。

适合：

- 图片；
- GIF；
- 小视频；
- 普通附件。

优点：

- 可迁移；
- 不依赖原路径。

## 外部引用

只保存路径。

适合：

- 超大视频；
- 大型原始素材。

界面需要明确提醒：

> 原文件被移动或删除后，该素材会失效。

---

# 23. 内置截图能力

桌面应用未来可以提供：

> 截图到工作台

示例快捷键：

```text
Cmd/Ctrl + Shift + 2
```

截图完成后：

```text
保存到：

○ 当前课程
○ 当前占位符
○ 媒体库
○ Inbox
```

对于 AI 教程类项目尤其高频。

---

# 24. 简单视频 / GIF 处理

不做完整视频编辑器。

仅提供内容生产所需基础操作：

```text
裁掉头尾
截取一段
静音
转 GIF
生成封面
压缩
```

例如：

```text
开始 00:04
结束 00:11
导出 GIF
```

可以直接完成当前 Requirement。

---

# 25. 完整素材链路

```text
看到东西
↓
拖入 / 粘贴 / 截图
↓
Inbox 或 Media Library
↓
转成 Project Asset
↓
插入正文 / Requirement / Grid
↓
AssetUsage 自动记录
↓
Layout
↓
Export
```

---

# 26. 创作主链路

```text
课程结构
↓
正文 Block
↓
Requirement
↓
素材输入
↓
Asset / Inbox
↓
排版 Layout
↓
Section
↓
预览
↓
发布前检查
↓
Export
```

---

# 27. 建议新增对象

## LayoutSection

```text
LayoutSection
├── id
├── layout_instance_id
├── title
├── order_index
├── start_row
├── end_row
├── export_behavior
├── locked
└── settings
```

## InboxItem

```text
InboxItem
├── id
├── project_id
├── type
├── content
├── file_path
├── source_url
├── note
├── created_at
├── status
└── resolved_target
```

## ExportPreset

建议：

```text
ExportPreset
├── id
├── project_id|null
├── name
├── target_type
├── width
├── height
├── format
├── pagination_mode
├── naming_rule
├── scale
├── background_mode
├── media_rules
└── settings
```

---

# 28. 当前闭环

完成本轮后，课程工作台的主链路已经覆盖：

- 课程结构；
- 正文；
- 结构视图；
- 占位符；
- 媒体；
- Inbox；
- 多维状态；
- Flow/Grid 排版；
- LayoutSection；
- 多页导出；
- 发布前检查；
- 版本；
- AI 辅助；
- 外部聊天记录；
- 模型 API。
