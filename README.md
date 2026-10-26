<div align="center">
  <h1>AI Course Workbench</h1>
  <p>在自己的电脑上，把课程结构、素材和待补内容整理成可编辑、可导出的课程。</p>
</div>

[English](README.en.md) · [下载与版本](https://github.com/wyzh0117/workbench/releases/latest)

## 项目介绍

AI Course Workbench 是一款本地优先的课程创作工具。课程内容保存在你电脑上的 `project.json` 文件中，便于继续编辑和备份。

## 快速开始

从[最新版本页面](https://github.com/wyzh0117/workbench/releases/latest)下载 Windows 或 macOS 安装包，安装后打开应用并新建或打开一个课程项目。

从源码运行需要 Deno 2.x、Rust 和对应平台的构建工具：

```bash
deno task check
deno task test
cargo test --manifest-path src-tauri/Cargo.toml
cargo tauri build
```

## 工作方式

先建立课程阶段和课次，再在每课中编辑内容、安排素材，并标记还需要补充的部分。可重建的搜索索引和预览只是缓存；课程文件保留项目的主要内容。AI 助手提出的修改需要你逐条检查后才会应用。

## 可以做什么

- 规划课程阶段与课次，调整顺序；
- 编辑讲义和页面结构，预览课程内容；
- 整理图片、视频、PDF、DOCX、EPUB、LaTeX 和 Markdown 素材；
- 导入课程大纲或教案后解析正文、提取结构化主题；配置 AI 模型与搜索服务后，可自动查找案例和教学视频，在右侧阅读来源后再收藏或插入课程；
- 从现有 PowerPoint 提取可编辑风格，并把补充页导出为单页文件或追加副本；
- 记录待补内容，查看课程完成情况；
- 审阅 AI 修改建议，并导出 Markdown、HTML、PDF、PPTX 或完整项目包。

课程文档解析与联网搜索分别显示状态；未配置模型或搜索服务时，解析结果仍保留并提示配置。桌面版支持 TXT、Markdown、DOCX、PDF 和 PPTX 正文解析；浏览器壳当前仅支持 TXT 与 Markdown。联网搜索通过已配置的 HTTPS 服务商 API；来源正文读取只访问公共 HTTPS 地址，并拒绝私有地址及重定向。

## 示例

制作一门摄影课时，可以先列出课程阶段和课次，再为每节课写讲义、附上示例图片、标出待补的拍摄练习，最后预览并导出课程材料。

## License

仓库当前没有提供 LICENSE 文件，使用、修改和再发布的授权方式尚未声明。
