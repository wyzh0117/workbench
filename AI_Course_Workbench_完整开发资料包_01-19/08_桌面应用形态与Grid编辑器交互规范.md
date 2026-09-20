# AI Course Workbench｜桌面应用形态与Grid编辑器交互规范

> 用途：确定产品运行形态、桌面端技术边界、浏览器桥接方式，以及 Grid 编辑器的工具栏、鼠标操作和右侧属性面板。

---

# 1. 产品形态：Desktop-first

当前工作台更适合：

> **桌面应用外壳 + Web 技术界面 + 本地优先数据 + 浏览器扩展桥接**

而不是纯网页工作台。

原因在于产品已经涉及：

- 本地项目文件；
- Markdown / JSON；
- 大量图片、GIF、视频；
- Git；
- 自动保存；
- 历史版本；
- 文件夹导入；
- 本地媒体库；
- 系统凭据；
- DeepSeek / 豆包 / ChatGPT API Key；
- 网页 AI 对话记录读取；
- 大量拖放；
- Grid 画布；
- 导出目录；
- 离线编辑。

---

# 2. 为什么不优先做纯 Web

## 2.1 本地文件系统

桌面应用可以自然管理：

```text
我的课程/
├── contents/
├── assets/
├── exports/
└── .git/
```

不用频繁经过浏览器文件权限授权。

## 2.2 Git

用户点击：

> 保存版本

软件可以直接在后台执行 Git 操作。

## 2.3 凭据

API Key 可保存于：

- macOS Keychain；
- Windows Credential Manager；
- 系统安全密钥库。

比浏览器 Local Storage 更符合产品定位。

---

# 3. 前端仍然采用 Web UI

不建议分别为 macOS / Windows 编写两套传统原生 GUI。

推荐结构：

```text
桌面应用
│
├── Web UI
│   ├── 左中右三栏
│   ├── Block Editor
│   ├── Grid Editor
│   ├── 看板
│   └── AI 面板
│
└── 本地能力层
    ├── 文件系统
    ├── Git
    ├── SQLite 缓存
    ├── API 调用
    ├── 凭据管理
    └── 浏览器连接
```

前端仍然可以使用 React / Vue / Svelte 等现代 Web UI 技术。

---

# 4. Local-first

默认项目数据保存在用户电脑：

```text
用户电脑
├── 课程文件
├── 媒体
├── Git
├── SQLite缓存
└── 对话缓存
```

只有用户主动调用模型时，所勾选的上下文才发送给模型 API。

这与“AI 上下文必须显式勾选”的原则一致。

---

# 5. 网页 AI 对话记录：浏览器扩展桥接

桌面软件不应直接读取 Chrome / Edge 浏览器内部 Cookie 数据库。

推荐：

```text
ChatGPT / DeepSeek / 豆包 网页
              │
              ▼
       浏览器扩展 Companion
              │
       用户明确点击读取
              │
              ▼
      Desktop Local Bridge
              │
              ▼
      AI Course Workbench
```

工作台可显示：

```text
ChatGPT

☐ AI课程设计
☐ 新闻工作流
☐ MCP讨论
☐ 其他

[导入已选记录]
```

---

# 6. Connector Adapter

分别实现：

```text
ChatGPTAdapter
DeepSeekAdapter
DoubaoAdapter
ClaudeAdapter
GeminiAdapter
CustomAgentAdapter
```

网页结构变化时，只更新对应 Adapter。

不影响桌面主体。

---

# 7. 桌面技术形态总图

```text
┌──────────────────────────────────────────┐
│        AI Course Workbench Desktop       │
│                                          │
│              Web UI Layer                │
│     左栏 / 编辑器 / Grid / AI / 看板      │
└──────────────────┬───────────────────────┘
                   │
             Desktop Bridge
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
   文件系统       Git       Secure Store
       │                       │
       ▼                       ▼
 Markdown/JSON             API Keys
 Assets
 SQLite Cache

                   │
                   ├───────────────► 模型 API
                   │
                   ▼
          Browser Extension Bridge
                   │
          ┌────────┼─────────┐
          ▼        ▼         ▼
       ChatGPT  DeepSeek    豆包
```

---

# 8. 未来可扩展 Web 版

Desktop-first 不封死未来。

未来可以：

```text
Desktop
+
Web Cloud
```

共享大部分：

- 编辑器；
- Grid；
- 看板；
- UI 组件；
- 数据模型。

区别只在底层能力。

---

# 9. 鼠标操作分层

## 左键

高频：

- 选择；
- 编辑；
- 拖放；
- 切换。

## Hover / 浮动按钮

中频：

- `+`
- 拖动手柄；
- AI；
- 替换素材。

## 右键

低频高级操作：

```text
复制
剪切
锁定
组合
取消组合
转为……
创建待补内容
在结构视图中定位
删除
```

---

# 10. Grid 顶部工具栏

进入：

> 排版 → Grid

中央顶部建议：

```text
[选择 ▾]  [＋内容]  [编辑网格]  [自动整理 ▾]  [对齐 ▾]  |  [100%]  [预览]
```

不做 Photoshop 式复杂工具栏。

---

# 11. 选择工具

默认鼠标行为：

```text
点击        选中
Shift点击   多选
拖框        框选
拖元素      移动
拖边缘      改变占格范围
```

所有移动与缩放始终吸附 Grid。

---

# 12. 双击行为

## 双击文字

直接进入文字编辑。

## 双击图片

进入图片内部调整：

- 裁切；
- 缩放；
- 内部位置。

Grid 占位区域不变。

## 双击占位符

编辑：

- 备注；
- 类型；
- 优先级。

---

# 13. Grid 右键菜单

单元素：

```text
剪切
复制
粘贴

────────

置于前面
置于后面

锁定位置
锁定尺寸

────────

组合
取消组合

替换素材
创建待补内容

────────

删除
```

多选时增加：

```text
组合
左对齐
居中
右对齐
顶对齐
底对齐
等距排列
```

---

# 14. Grid 右侧栏

建议拆为四个 Tab：

> **布局｜元素｜媒体｜样式**

---

# 15. 布局 Tab

针对整个画布：

```text
画布尺寸
3:4

列数
4

边距
32

间距
24

[编辑网格]
[自动整理]
```

---

# 16. 元素 Tab

根据选中对象动态变化。

选中图片：

```text
位置
C1–C3
R2–R4

适配
[保持完整 ▼]

对齐
[居中]

锁定
□ 位置
□ 尺寸
```

选中文字：

```text
宽度
高度：自动

对齐
左

□ 锁定高度
```

---

# 17. 媒体 Tab

显示：

- 当前 Layout 可用媒体；
- 当前 Layout 待补媒体；
- 搜索；
- 上传；
- 拖入 Grid。

---

# 18. 样式 Tab

只管理视觉属性：

```text
字体
字号
字重
行距

背景
边框
圆角
阴影
```

布局属性不放在这里。

---

# 19. Grid 导航小地图

当画布较长或较大时，在右下角显示可选 mini-map：

```text
┌─────────┐
│ ▣       │
│    ▣    │
│      ▣  │
└─────────┘
```

用于快速定位长画布。

---

# 20. LayoutSection

Grid 长画布可以进一步按视觉区段拆分。

例如：

```text
Section 01
──────────
标题

Section 02
──────────
核心概念

Section 03
──────────
案例

Section 04
──────────
总结
```

Section 不改变正文结构。

它属于 Layout。

---

# 21. LayoutSection 数据模型建议

```text
LayoutSection
├── id
├── layout_instance_id
├── title
├── order_index
├── start_row
├── end_row
├── export_behavior
└── settings
```

它主要用于：

- 长画布管理；
- 导出分页；
- 小红书多图；
- 长信息图；
- 网页分区。
