//! v0.2.5 文本/文档导入的解析层：把 `.txt .text .md .markdown .tex .latex .docx .epub .pdf`
//! 解析成 Workbench 已有的 `parsed_markdown` 区块 IR。
//!
//! 契约（下一步的导入事务按此对接，改动需同步）：
//!
//! - [`ParsedDocument::blocks`] 的形状与 JS `parseMarkdown()`（app/markdown.js）产出、
//!   Rust `adopt_markdown_blocks`（src-tauri/src/lib.rs）消费的区块一致：
//!   `{ "type", "raw", "text", "level", "language", "checked", "imageRefs" }`。
//!   `type` 只使用 `adopt_markdown_blocks` 认识的取值：
//!   `heading | paragraph | quote | code | divider | table | list | other`
//!   （Workbench Block 是闭合枚举、没有 list 类型：列表与表格以 markdown 源文本形式
//!   存在段落块里，渲染时重新编译，所以这里一律输出 markdown 文本而不是 HTML）。
//! - 每个解析器只做"一份文档一次事务"：失败就返回 `Err(String)`，调用方只把该文件
//!   降级为 Reference，其它文件不受影响。
//! - [`ParsedImage`]：`ref_name` 是稳定的相对名（形如 `document-image-1.png`，不含
//!   `:`、`\`、`..`），同时出现在块正文的 `![alt](ref_name)` 和该块
//!   `imageRefs[*].href` 里。对接层只要建立 `ref_name -> 受管理 Asset` 的映射并改写
//!   正文与 `imageRefs[*].href`，不需要理解源格式。`imageRefs` 条目沿用 JS 字段：
//!   `{ href, title, alt, tokenIndex, occurrence, blockIndex }`；`tokenIndex` 是全文档
//!   图片出现顺序的递增计数，`occurrence` 是同一个 `ref_name` 的第几次出现
//!   （同一张内嵌图被多次引用只产生一条 [`ParsedImage`]）。
//! - [`ParsedDocument::usable_text`]：`false` 表示没有可用的文字（扫描件 PDF），
//!   此时 `blocks` 为空，调用方只保留文件本身作为 Reference。
//!
//! 安全性：输入全是用户磁盘上的不可信字节。解析路径不使用 `unwrap()` / `expect()`，
//! 所有体积与解压比都有显式上限（见 [`MAX_SOURCE_BYTES`] 等常量），超限一律 `Err`
//! 或带提示跳过 —— 不 panic，也不静默丢内容。
//!
//! 测试资产约定（全仓库共用）：真实样例统一放在仓库根 `test-documents/`（已被
//! `.gitignore` 忽略，可能不存在，只读不写）。Rust 侧用
//! `concat!(env!("CARGO_MANIFEST_DIR"), "/../test-documents/<file>")` 取绝对路径，
//! 目录缺失时跳过真实样例用例；合成样本一律用测试内的字节构造器，保证离线可复核。

pub mod docx;
pub mod epub;
pub mod latex;
pub mod pdf;
pub mod plaintext;

/// 测试专用的合成文档构造器（docx / epub / pdf 样本全部按字节生成）。
#[cfg(test)]
mod fixtures;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// 本模块负责的后缀（小写）。`md`/`markdown` 虽在列表里，但只做透传：
/// Markdown 由既有 marked 管线解析，避免两套实现分叉。
const SUPPORTED_EXTENSIONS: [&str; 9] = [
    "txt", "text", "md", "markdown", "tex", "latex", "docx", "epub", "pdf",
];

/// 单个文件的可接受上限（磁盘字节数）。
pub(crate) const MAX_SOURCE_BYTES: usize = 96 * 1024 * 1024;
/// 容器内单个条目解压后的上限（ZIP 炸弹防护）。
pub(crate) const MAX_PART_BYTES: usize = 64 * 1024 * 1024;
/// 区块正文上限：必须小于 `adopt_markdown_blocks` 的 2_000_000 硬限制，留出余量。
pub(crate) const MAX_BLOCK_BYTES: usize = 1_500_000;
/// 单文档区块数量上限。
pub(crate) const MAX_BLOCKS: usize = 20_000;
/// 提取正文的总字符上限。
pub(crate) const MAX_EXTRACTED_CHARS: usize = 8_000_000;
/// 单张图片上限。
pub(crate) const MAX_IMAGE_BYTES: usize = 24 * 1024 * 1024;
/// 单文档图片总量上限。
pub(crate) const MAX_TOTAL_IMAGE_BYTES: usize = 96 * 1024 * 1024;
/// 单文档图片数量上限。
pub(crate) const MAX_IMAGES: usize = 400;
/// 用户提示条数上限，避免畸形文件把提示刷爆。
const MAX_WARNINGS: usize = 200;

/// 内嵌图片：解码后可直接被对接层写入受管理素材目录。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedImage {
    /// 块正文与 `imageRefs[*].href` 使用的稳定相对引用名。
    pub ref_name: String,
    /// 标准 MIME，例如 `image/png`。
    pub mime: String,
    /// 图片字节的标准 base64（无换行）。
    pub base64: String,
}

/// 一次解析的结果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedDocument {
    /// `parsed_markdown` IR 区块数组。
    pub blocks: Vec<Value>,
    /// 内嵌图片，按文档出现顺序。
    pub images: Vec<ParsedImage>,
    /// 面向用户的中文提示（"不得静默丢失"）。
    pub warnings: Vec<String>,
    /// 是否有内容被降级（数学公式存成代码、未知宏保留原文、编号样式降级等）。
    pub degraded: bool,
    /// `false` 表示没有可导入的文字层，调用方只保留 Reference。
    pub usable_text: bool,
}

/// 是否属于本模块的文档后缀（含 markdown 透传类型）。
pub fn is_supported_document(name: &str) -> bool {
    SUPPORTED_EXTENSIONS.contains(&extension_of(name).as_str())
}

/// 解析单个文件。`name` 只用于判定后缀，`bytes` 是文件原始字节。
pub fn parse_document(name: &str, bytes: &[u8]) -> Result<ParsedDocument, String> {
    let extension = extension_of(name);
    if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!("不支持的文档类型：{name}"));
    }
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(format!(
            "文件过大（{} 字节，上限 {} 字节），未解析：{name}",
            bytes.len(),
            MAX_SOURCE_BYTES
        ));
    }
    let mut collector = Collector::new();
    match extension.as_str() {
        "md" | "markdown" => {
            collector.warn("Markdown 由既有 marked 管线解析，本模块不重复解析，blocks 为空。");
            return Ok(collector.finish_markdown_passthrough());
        }
        "txt" | "text" => plaintext::parse_plain_text(bytes, &mut collector)?,
        "tex" | "latex" => latex::parse_latex(bytes, &mut collector)?,
        "docx" => docx::parse_docx(bytes, &mut collector)?,
        "epub" => epub::parse_epub(bytes, &mut collector)?,
        "pdf" => pdf::parse_pdf(bytes, &mut collector)?,
        other => return Err(format!("不支持的文档类型：{other}")),
    }
    Ok(collector.finish())
}

pub(crate) fn extension_of(name: &str) -> String {
    let trimmed = name.trim();
    let base = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    match base.rfind('.') {
        Some(index) if index > 0 && index + 1 < base.len() => {
            base[index + 1..].to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

/// 区块种类，对应 IR 的 `type`；全部是 `adopt_markdown_blocks` 认识的取值。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Kind {
    #[default]
    Paragraph,
    Heading,
    Quote,
    Code,
    Divider,
    /// markdown 列表源文本（`- 项` / `1. 项`），落地为段落块。
    List,
    /// GFM 管道表格源文本，落地为表格块。
    Table,
    /// 无法归类但必须保留原文的块，落地为段落块。
    Other,
}

impl Kind {
    pub(crate) fn ir_name(self) -> &'static str {
        match self {
            Kind::Paragraph => "paragraph",
            Kind::Heading => "heading",
            Kind::Quote => "quote",
            Kind::Code => "code",
            Kind::Divider => "divider",
            Kind::List => "list",
            Kind::Table => "table",
            Kind::Other => "other",
        }
    }

    /// 该种类是否承载可计数的正文（分隔符与纯图片块不算）。
    fn counts_as_text(self) -> bool {
        !matches!(self, Kind::Divider | Kind::Other)
    }
}

/// 一个待写入的区块；`content` 是该块的 markdown 源文本。
#[derive(Clone, Debug, Default)]
pub(crate) struct BlockSpec {
    pub kind: Kind,
    pub content: String,
    pub level: Option<u64>,
    pub language: Option<String>,
    pub checked: Option<bool>,
    pub images: Vec<Value>,
}

/// 图片落位结果：写进正文的 markdown，以及该块的 `imageRefs` 条目。
#[derive(Clone, Debug)]
pub(crate) struct Placement {
    pub markdown: String,
    pub reference: Value,
}

/// 各解析器共用的收集器：区块 / 图片 / 提示 / 降级标记，以及所有上限守卫。
pub(crate) struct Collector {
    blocks: Vec<Value>,
    images: Vec<ParsedImage>,
    warnings: Vec<String>,
    seen_warnings: HashSet<String>,
    dropped_warnings: usize,
    degraded: bool,
    text_chars: usize,
    /// 图片标识（容器条目名或内容摘要）-> `images` 下标，用于同名图片复用。
    image_index: HashMap<String, usize>,
    /// `ref_name` -> 已出现次数。
    occurrences: HashMap<String, usize>,
    image_bytes_total: usize,
    token_index: usize,
    image_sequence: usize,
    split_emitted: bool,
}

impl Default for Collector {
    fn default() -> Self {
        Self::new()
    }
}

impl Collector {
    pub(crate) fn new() -> Self {
        Collector {
            blocks: Vec::new(),
            images: Vec::new(),
            warnings: Vec::new(),
            seen_warnings: HashSet::new(),
            dropped_warnings: 0,
            degraded: false,
            text_chars: 0,
            image_index: HashMap::new(),
            occurrences: HashMap::new(),
            image_bytes_total: 0,
            token_index: 0,
            image_sequence: 0,
            split_emitted: false,
        }
    }

    /// 追加一条用户提示（自动去重，超出上限只做汇总）。
    pub(crate) fn warn(&mut self, message: impl Into<String>) {
        let message = message.into();
        if message.is_empty() || !self.seen_warnings.insert(message.clone()) {
            return;
        }
        if self.warnings.len() >= MAX_WARNINGS {
            self.dropped_warnings += 1;
            return;
        }
        self.warnings.push(message);
    }

    /// 标记内容降级并给出原因。
    pub(crate) fn degrade(&mut self, reason: impl Into<String>) {
        self.degraded = true;
        self.warn(reason);
    }

    /// 正文预算是否已用完；解析器据此尽早停止收集更多内容。
    pub(crate) fn text_budget_reached(&self) -> bool {
        self.text_chars >= MAX_EXTRACTED_CHARS
    }

    pub(crate) fn divider(&mut self) -> Option<usize> {
        self.block(BlockSpec {
            kind: Kind::Divider,
            ..Default::default()
        })
    }

    pub(crate) fn paragraph(&mut self, content: impl Into<String>) -> Option<usize> {
        self.text_block(Kind::Paragraph, content)
    }

    /// 列表 / 引用区块目前只有 IR 契约测试在构造（解析器都在 `block()` 上带
    /// level / language / images，用不上这两个快捷方法），所以跟着测试编译。
    #[cfg(test)]
    pub(crate) fn list(&mut self, content: impl Into<String>) -> Option<usize> {
        self.text_block(Kind::List, content)
    }

    pub(crate) fn table(&mut self, content: impl Into<String>) -> Option<usize> {
        self.text_block(Kind::Table, content)
    }

    #[cfg(test)]
    pub(crate) fn quote(&mut self, content: impl Into<String>) -> Option<usize> {
        self.text_block(Kind::Quote, content)
    }

    pub(crate) fn heading(&mut self, level: u64, content: impl Into<String>) -> Option<usize> {
        self.block(BlockSpec {
            kind: Kind::Heading,
            content: content.into(),
            level: Some(level.clamp(1, 6)),
            ..Default::default()
        })
    }

    /// `code` / `image_block` 与其他快捷方法一样只在 IR 契约测试里构造区块
    /// （解析器都在 `block()` 上带自己的 level / language / images），所以跟着测试编译。
    #[cfg(test)]
    pub(crate) fn code(
        &mut self,
        language: Option<&str>,
        content: impl Into<String>,
    ) -> Option<usize> {
        self.block(BlockSpec {
            kind: Kind::Code,
            content: content.into(),
            language: language.map(str::to_owned),
            ..Default::default()
        })
    }

    pub(crate) fn text_block(&mut self, kind: Kind, content: impl Into<String>) -> Option<usize> {
        self.block(BlockSpec {
            kind,
            content: content.into(),
            ..Default::default()
        })
    }

    /// 纯图片块：正文只有 `![alt](ref_name)`，`adopt_markdown_blocks` 按
    /// `other -> paragraph` 落地，渲染时再依据 `imageRefs` 换成素材地址。
    #[cfg(test)]
    pub(crate) fn image_block(&mut self, placement: Placement) -> Option<usize> {
        self.block(BlockSpec {
            kind: Kind::Other,
            content: placement.markdown,
            images: vec![placement.reference],
            ..Default::default()
        })
    }

    /// 写入一个区块，返回区块下标；超长内容按行拆分，块数超限则丢弃并提示。
    pub(crate) fn block(&mut self, spec: BlockSpec) -> Option<usize> {
        let BlockSpec {
            kind,
            content,
            level,
            language,
            checked,
            images,
        } = spec;
        if kind == Kind::Divider {
            self.push_chunk(Kind::Divider, "", None, &None, None, Vec::new());
            return Some(self.blocks.len().saturating_sub(1));
        }
        let content = content.trim_end_matches('\n').to_owned();
        if content.trim().is_empty() {
            if images.is_empty() {
                return None;
            }
            // 只有图片没有文字的块：用 imageRefs 反推出 `![alt](href)` 正文，
            // 否则对接层按正文引用与 imageRefs 交叉核对时会丢引用。
            let markdown = images
                .iter()
                .filter_map(|entry| {
                    let href = entry.get("href")?.as_str()?;
                    let alt = entry.get("alt").and_then(Value::as_str).unwrap_or_default();
                    Some(format!("![{alt}]({href})"))
                })
                .collect::<Vec<_>>()
                .join(" ");
            if markdown.is_empty() {
                return None;
            }
            let index = self.blocks.len();
            self.push_chunk(Kind::Other, &markdown, level, &language, checked, images);
            return Some(index);
        }
        if content.len() <= MAX_BLOCK_BYTES {
            let index = self.blocks.len();
            self.push_chunk(kind, &content, level, &language, checked, images);
            return Some(index);
        }
        if !self.split_emitted {
            self.split_emitted = true;
            self.degrade("有超长区块被按行拆成多段，以满足可导入体积限制。");
        }
        let mut first = true;
        let mut images = images;
        for chunk in split_markdown(&content, MAX_BLOCK_BYTES) {
            let chunk_images = if first {
                std::mem::take(&mut images)
            } else {
                Vec::new()
            };
            self.push_chunk(
                if first { kind } else { Kind::Paragraph },
                &chunk,
                if first { level } else { None },
                &language,
                if first { checked } else { None },
                chunk_images,
            );
            first = false;
        }
        Some(self.blocks.len().saturating_sub(1))
    }

    fn push_chunk(
        &mut self,
        kind: Kind,
        content: &str,
        level: Option<u64>,
        language: &Option<String>,
        checked: Option<bool>,
        images: Vec<Value>,
    ) {
        if self.blocks.len() >= MAX_BLOCKS {
            self.warn(format!("文档区块超过 {MAX_BLOCKS} 个，其余内容已忽略。"));
            return;
        }
        if kind.counts_as_text() {
            self.text_chars = self.text_chars.saturating_add(count_body_chars(content));
        }
        let raw = match kind {
            Kind::Heading => format!(
                "{} {content}\n",
                "#".repeat(level.unwrap_or(1).clamp(1, 6) as usize)
            ),
            Kind::Divider => String::new(),
            Kind::Code => {
                let fence = code_fence(content);
                match language.as_deref().filter(|value| !value.is_empty()) {
                    Some(language) => format!("{fence}{language}\n{content}\n{fence}\n"),
                    None => format!("{fence}\n{content}\n{fence}\n"),
                }
            }
            Kind::Quote => format!(
                "{}\n",
                content
                    .lines()
                    .map(|line| format!("> {line}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            Kind::Other => content.to_owned(),
            other => {
                let _ = other;
                format!("{content}\n")
            }
        };
        let index = self.blocks.len();
        let mut entries = images;
        for entry in &mut entries {
            if let Some(object) = entry.as_object_mut() {
                object.insert("blockIndex".to_owned(), json!(index));
            }
        }
        self.blocks.push(json!({
            "type": kind.ir_name(),
            "raw": raw,
            "text": if kind == Kind::Divider { "" } else { content },
            "level": level,
            "language": language,
            "checked": checked,
            "imageRefs": entries,
        }));
    }

    /// 登记一张内嵌图片，返回可写进正文的 markdown 与 `imageRefs` 条目。
    /// 无法提取（超限 / 格式不支持）时返回 `None`，但一定留下提示。
    pub(crate) fn place_image(
        &mut self,
        identity: &str,
        bytes: &[u8],
        mime: Option<&str>,
        alt: &str,
    ) -> Option<Placement> {
        let alt = sanitize_alt(alt);
        let label = identity.rsplit('/').next().unwrap_or(identity);
        let Some(mime) = mime.map(str::to_ascii_lowercase) else {
            self.degrade(format!("暂不支持该内嵌图片格式，已跳过：{label}"));
            return None;
        };
        if bytes.is_empty() {
            self.warn(format!("内嵌图片为空，已跳过：{label}"));
            return None;
        }
        if bytes.len() > MAX_IMAGE_BYTES {
            self.degrade(format!(
                "内嵌图片过大（{} 字节），已跳过：{label}",
                bytes.len()
            ));
            return None;
        }
        let ref_name = match self.image_index.get(identity).copied() {
            Some(index) => self.images.get(index).map(|image| image.ref_name.clone())?,
            None => {
                if self.images.len() >= MAX_IMAGES {
                    self.degrade(format!("内嵌图片数量超过 {MAX_IMAGES} 张，已跳过：{label}"));
                    return None;
                }
                if self.image_bytes_total.saturating_add(bytes.len()) > MAX_TOTAL_IMAGE_BYTES {
                    self.degrade(format!("内嵌图片总量超过上限，已跳过：{label}"));
                    return None;
                }
                self.image_sequence += 1;
                let name = format!(
                    "document-image-{}{}",
                    self.image_sequence,
                    extension_for_mime(&mime)
                );
                self.images.push(ParsedImage {
                    ref_name: name.clone(),
                    mime,
                    base64: BASE64.encode(bytes),
                });
                self.image_index
                    .insert(identity.to_owned(), self.images.len() - 1);
                self.image_bytes_total = self.image_bytes_total.saturating_add(bytes.len());
                name
            }
        };
        let occurrence = self.occurrences.get(&ref_name).copied().unwrap_or(0);
        self.occurrences.insert(ref_name.clone(), occurrence + 1);
        let token_index = self.token_index;
        self.token_index += 1;
        Some(Placement {
            markdown: format!("![{alt}]({ref_name})"),
            reference: json!({
                "href": ref_name,
                "title": Value::Null,
                "alt": alt,
                "tokenIndex": token_index,
                "occurrence": occurrence,
            }),
        })
    }

    /// Markdown 由既有管线负责时的透传结果。
    fn finish_markdown_passthrough(&mut self) -> ParsedDocument {
        ParsedDocument {
            blocks: Vec::new(),
            images: Vec::new(),
            warnings: std::mem::take(&mut self.warnings),
            degraded: false,
            usable_text: true,
        }
    }

    pub(crate) fn finish(&mut self) -> ParsedDocument {
        if self.dropped_warnings > 0 {
            // 汇总行必须写出去：`warn` 在条数已达上限时会把它一起丢掉，
            // 那样超限的文档就一条提示也看不到了。
            let message = format!(
                "另有 {} 条解析提示未列出（同类问题过多）。",
                self.dropped_warnings
            );
            if self.seen_warnings.insert(message.clone()) {
                self.warnings.push(message);
            }
            self.dropped_warnings = 0;
        }
        let usable_text = !self.blocks.is_empty();
        ParsedDocument {
            blocks: std::mem::take(&mut self.blocks),
            images: std::mem::take(&mut self.images),
            warnings: std::mem::take(&mut self.warnings),
            degraded: self.degraded,
            usable_text,
        }
    }
}

/// 图片字节的稳定标识：内容摘要，用于跨位置复用同一张图。
pub(crate) fn image_identity(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

/// 由文件后缀推断 MIME；无法作为图片管理的返回 `None`（例如 EMF/WMF）。
pub(crate) fn image_mime_from_extension(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" | "jfif" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" | "dib" => Some("image/bmp"),
        "tif" | "tiff" => Some("image/tiff"),
        "svg" => Some("image/svg+xml"),
        "heic" => Some("image/heic"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

pub(crate) fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/bmp" => ".bmp",
        "image/tiff" => ".tiff",
        "image/svg+xml" => ".svg",
        "image/heic" => ".heic",
        "image/avif" => ".avif",
        _ => ".bin",
    }
}

/// 与 JS `escapeMarkdownText` 同一套转义集（app/markdown.js 里有它的逆函数
/// `unescapeMarkdownText`），保证正文里的字面控制符不被重新解释。
pub(crate) fn markdown_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for character in text.chars() {
        if matches!(
            character,
            '\\' | '`'
                | '*'
                | '_'
                | '{'
                | '}'
                | '['
                | ']'
                | '('
                | ')'
                | '#'
                | '+'
                | '-'
                | '.'
                | '!'
                | '>'
                | '~'
                | '|'
        ) {
            out.push('\\');
        }
        out.push(character);
    }
    out
}

/// 行内代码：与 JS `markdownCodeSpan` 一致地选择反引号长度与空格。
pub(crate) fn markdown_code_span(text: &str) -> String {
    let value = text.replace('\n', " ");
    let mut ticks = String::from("`");
    while value.contains(&ticks) {
        ticks.push('`');
    }
    let needs_pad = value.starts_with('`')
        || value.ends_with('`')
        || (value.starts_with(' ') && value.chars().any(|c| c != ' '))
        || (value.ends_with(' ') && value.chars().any(|c| c != ' '));
    let pad = if needs_pad { " " } else { "" };
    format!("{ticks}{pad}{value}{pad}{ticks}")
}

pub(crate) fn code_fence(text: &str) -> String {
    let mut longest = 0usize;
    let mut run = 0usize;
    for character in text.chars() {
        if character == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat(if longest < 3 { 3 } else { longest + 1 })
}

/// 按行边界把长文本切成不超过 `limit` 字节的片段，绝不切断 UTF-8 字符。
pub(crate) fn split_markdown(text: &str, limit: usize) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.split_inclusive('\n') {
        if line.len() > limit {
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            let mut rest = line;
            while !rest.is_empty() {
                let mut target = rest.len().min(limit);
                while target > 0 && !rest.is_char_boundary(target) {
                    target -= 1;
                }
                if target == 0 {
                    target = rest.chars().next().map(char::len_utf8).unwrap_or(1);
                }
                chunks.push(rest[..target].to_owned());
                rest = &rest[target..];
            }
            continue;
        }
        if !current.is_empty() && current.len() + line.len() > limit {
            chunks.push(std::mem::take(&mut current));
        }
        current.push_str(line);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

/// 换行归一：CRLF/CR -> LF，丢弃其余控制字符；返回正文与被丢弃的字符数。
pub(crate) fn normalize_newlines(text: &str) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut dropped = 0usize;
    // 上一个字符是 CR：它已经产出一个 LF，紧跟的 LF 不再重复输出。
    let mut after_cr = false;
    for character in text.chars() {
        match character {
            // 单独的 CR（老式 Mac 换行 / XML 规范也要求归一）必须是换行，
            // 直接把两行文字粘在一起等于悄悄改正文。
            '\r' => out.push('\n'),
            '\n' if after_cr => {}
            '\n' | '\t' => out.push(character),
            '\u{feff}' => dropped += 1,
            value if value.is_control() => dropped += 1,
            value => out.push(value),
        }
        after_cr = character == '\r';
    }
    (out, dropped)
}

/// 连续 3 个以上换行压成一个空行。
pub(crate) fn collapse_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut newlines = 0usize;
    for character in text.chars() {
        if character == '\n' {
            newlines += 1;
            if newlines <= 2 {
                out.push(character);
            }
        } else {
            newlines = 0;
            out.push(character);
        }
    }
    out
}

/// 去掉图片语法后的正文字数（用于判断"有没有可用文本"）。
fn count_body_chars(content: &str) -> usize {
    let mut count = 0usize;
    let mut index = 0usize;
    while index < content.len() {
        if content[index..].starts_with("![") {
            match content[index..]
                .find("))")
                .or_else(|| content[index..].find(')'))
            {
                Some(offset) => index += offset + 1,
                None => index += 1,
            }
            continue;
        }
        let character = content[index..].chars().next().unwrap_or_default();
        index += character.len_utf8();
        if !character.is_whitespace() {
            count += 1;
        }
    }
    count
}

pub(crate) fn sanitize_alt(alt: &str) -> String {
    alt.chars()
        .filter(|character| !character.is_control() && !matches!(character, '[' | ']'))
        .take(160)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// 把容器条目名规范成相对路径（去掉 `./`、`../`、反斜杠）。
pub(crate) fn normalize_zip_name(name: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for part in name.replace('\\', "/").split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value.to_owned()),
        }
    }
    parts.join("/")
}

/// 解析相对引用（EPUB/DOCX 的 href、target）：百分号解码 + 去掉 `?`/`#` 尾巴。
/// `base` 是发起引用的条目名；以 `/` 开头的引用按容器根目录解析。
pub(crate) fn resolve_relative(base: &str, href: &str) -> Option<String> {
    let href = href.trim();
    if href.is_empty() || href.starts_with('#') {
        return None;
    }
    let path_part = href.split(['?', '#']).next().unwrap_or_default();
    let decoded = percent_decode(path_part)?;
    let mut parts: Vec<String> = Vec::new();
    let push = |segments: &str, parts: &mut Vec<String>| {
        for segment in segments.replace('\\', "/").split('/') {
            match segment {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                value => parts.push(value.to_owned()),
            }
        }
    };
    if decoded.starts_with('/') {
        push(decoded.trim_start_matches('/'), &mut parts);
    } else {
        // base 的所在目录：去掉最后一段条目名（`rsplit_once` 保持目录段的原始顺序）。
        let directory = base
            .rsplit_once('/')
            .map(|(dir, _)| dir)
            .unwrap_or_default();
        push(directory, &mut parts);
        push(&decoded, &mut parts);
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

pub(crate) fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            b'%' => return None,
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// 解析 XML/HTML 实体引用（quick-xml 的 `Event::GeneralRef` 载荷，即 `&` 与 `;`
/// 之间的内容）：字符引用 + XML 预定义实体 + EPUB 正文里最常见的 HTML 命名实体。
/// 无法识别时返回 `None`，调用方按原文保留并给出提示（绝不静默丢字）。
pub(crate) fn resolve_entity_reference(reference: &str) -> Option<String> {
    let reference = reference.trim();
    if let Some(code) = reference.strip_prefix('#') {
        let (radix, digits) = match code.strip_prefix(['x', 'X']) {
            Some(rest) => (16, rest),
            None => (10, code),
        };
        let value = u32::from_str_radix(digits, radix).ok()?;
        return char::from_u32(value).map(|value| value.to_string());
    }
    let resolved = match reference {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "shy" => "\u{ad}",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "hellip" => "…",
        "mdash" => "—",
        "ndash" => "–",
        "lsquo" => "\u{2018}",
        "rsquo" => "\u{2019}",
        "ldquo" => "\u{201c}",
        "rdquo" => "\u{201d}",
        "bull" => "•",
        "middot" => "·",
        "deg" => "°",
        "plusmn" => "±",
        "times" => "×",
        "divide" => "÷",
        "laquo" => "«",
        "raquo" => "»",
        "prime" => "′",
        "Prime" => "″",
        "euro" => "€",
        "pound" => "£",
        "yen" => "¥",
        "cent" => "¢",
        "sect" => "§",
        "para" => "¶",
        "dagger" => "†",
        "Dagger" => "‡",
        "permil" => "‰",
        "larr" => "←",
        "uarr" => "↑",
        "rarr" => "→",
        "darr" => "↓",
        "harr" => "↔",
        "minus" => "−",
        "lowbar" => "_",
        "colon" => ":",
        "semi" => ";",
        "excl" => "!",
        "num" => "#",
        "dollar" => "$",
        "percnt" => "%",
        "lpar" => "(",
        "rpar" => ")",
        "comma" => ",",
        "period" => ".",
        "sol" => "/",
        _ => return None,
    };
    Some(resolved.to_owned())
}

/// 把二维单元格表渲染成 GFM 管道表格源文本（docx / epub 共用）。
/// 返回值已含表头分隔行；单元格里的 `|` 与换行会被安全化，全空表返回 `None`。
pub(crate) fn markdown_table(rows: &[Vec<String>]) -> Option<String> {
    let normalized: Vec<Vec<String>> = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|cell| {
                    let cell = cell
                        .replace('|', "\\|")
                        .replace('\n', " ")
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ");
                    if cell.is_empty() {
                        " ".to_owned()
                    } else {
                        cell
                    }
                })
                .collect()
        })
        .filter(|row: &Vec<String>| row.iter().any(|cell| !cell.trim().is_empty()))
        .collect();
    let columns = normalized.iter().map(|row| row.len()).max()?;
    if columns == 0 {
        return None;
    }
    let mut lines: Vec<String> = Vec::new();
    for (index, row) in normalized.iter().enumerate() {
        let mut cells = row.clone();
        cells.resize(columns, " ".to_owned());
        lines.push(format!("| {} |", cells.join(" | ")));
        if index == 0 {
            lines.push(format!("| {} |", vec!["---"; columns].join(" | ")));
        }
    }
    Some(lines.join("\n"))
}

/// 读取容器条目时统一带上限，防止压缩炸弹。
pub(crate) fn read_zip_entry<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    index: usize,
) -> Result<Vec<u8>, String> {
    let mut file = archive
        .by_index(index)
        .map_err(|error| format!("压缩包条目无法读取：{error}"))?;
    let declared = usize::try_from(file.size()).unwrap_or(usize::MAX);
    if declared > MAX_PART_BYTES {
        return Err(format!(
            "压缩包内单个文件解压后过大（{declared} 字节，上限 {MAX_PART_BYTES}），已拒绝解析"
        ));
    }
    let mut buffer = Vec::new();
    // `take` 多留 1 字节：读出来真的超过上限时才能区分"恰好等于上限"与"压缩炸弹"。
    let mut limited = std::io::Read::take(&mut file, MAX_PART_BYTES as u64 + 1);
    std::io::Read::read_to_end(&mut limited, &mut buffer)
        .map_err(|error| format!("压缩包内容读取失败：{error}"))?;
    if buffer.len() > MAX_PART_BYTES {
        return Err(format!(
            "压缩包内单个文件解压后超过上限 {MAX_PART_BYTES}，已拒绝解析"
        ));
    }
    Ok(buffer)
}

/// 在容器里按规范名查找条目下标（先精确，再大小写不敏感）。
pub(crate) fn find_zip_entry<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    wanted: &str,
) -> Option<usize> {
    let wanted = normalize_zip_name(wanted);
    let mut names: Vec<(usize, String)> = Vec::new();
    for index in 0..archive.len() {
        if let Ok(file) = archive.by_index(index) {
            names.push((index, normalize_zip_name(file.name())));
        }
    }
    for (index, name) in &names {
        if name == &wanted {
            return Some(*index);
        }
    }
    let lowered = wanted.to_ascii_lowercase();
    names
        .into_iter()
        .find(|(_, name)| name.to_ascii_lowercase() == lowered)
        .map(|(index, _)| index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_and_support_are_case_insensitive() {
        assert_eq!(extension_of("Notes.PDF"), "pdf");
        assert_eq!(extension_of("a/b/c.Docx"), "docx");
        assert_eq!(extension_of("no-extension"), "");
        assert_eq!(extension_of(".md"), "");
        for name in [
            "a.txt",
            "a.text",
            "a.md",
            "a.markdown",
            "a.tex",
            "a.latex",
            "a.docx",
            "a.epub",
            "a.pdf",
            "A.PDF",
        ] {
            assert!(is_supported_document(name), "{name} 应受支持");
        }
        for name in ["a.doc", "a.pages", "a.zip", "a", ".md"] {
            assert!(!is_supported_document(name), "{name} 不应受支持");
        }
    }

    #[test]
    fn markdown_passes_through_without_blocks() {
        let parsed =
            parse_document("lesson.md", "# 标题\n\n正文\n".as_bytes()).expect("markdown 应透传");
        assert!(parsed.blocks.is_empty());
        assert!(parsed.usable_text);
        assert!(!parsed.degraded);
        assert_eq!(parsed.warnings.len(), 1);
    }

    #[test]
    fn unsupported_and_oversized_are_errors_not_panics() {
        assert!(parse_document("a.doc", b"whatever").is_err());
        let huge = vec![0u8; MAX_SOURCE_BYTES + 1];
        assert!(parse_document("a.txt", &huge).is_err());
        // 截断的 ZIP / 随机字节：必须是 Err 或带提示的结果，不能 panic。
        assert!(parse_document("a.docx", b"PK\x03\x04not-a-zip-at-all").is_err());
        assert!(parse_document("a.epub", &[0u8; 64]).is_err());
        assert!(parse_document("a.pdf", b"%PDF-1.4\nbroken").is_err());
    }

    #[test]
    fn block_shape_matches_adopt_markdown_blocks_ir() {
        let mut collector = Collector::new();
        collector.heading(2, "小节");
        collector.paragraph("正文");
        collector.list("- 甲\n- 乙\n");
        collector.table("| a | b |\n| - | - |\n| 1 | 2 |");
        collector.code(Some("rust"), "fn main() {}");
        collector.quote("引用的话");
        collector.divider();
        let parsed = collector.finish();
        let keys = [
            "type",
            "raw",
            "text",
            "level",
            "language",
            "checked",
            "imageRefs",
        ];
        for block in &parsed.blocks {
            for key in keys {
                assert!(block.get(key).is_some(), "缺少字段 {key}");
            }
            let kind = block["type"].as_str().unwrap_or_default();
            assert!(
                matches!(
                    kind,
                    "heading"
                        | "paragraph"
                        | "quote"
                        | "code"
                        | "divider"
                        | "table"
                        | "list"
                        | "other"
                ),
                "adopt_markdown_blocks 不认识的类型：{kind}"
            );
        }
        let kinds: Vec<&str> = parsed
            .blocks
            .iter()
            .map(|block| block["type"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            kinds,
            vec![
                "heading",
                "paragraph",
                "list",
                "table",
                "code",
                "quote",
                "divider"
            ]
        );
        assert_eq!(parsed.blocks[0]["level"], json!(2));
        assert_eq!(parsed.blocks[0]["text"], json!("小节"));
        assert_eq!(parsed.blocks[0]["raw"], json!("## 小节\n"));
        assert_eq!(parsed.blocks[2]["raw"], json!("- 甲\n- 乙\n"));
        assert_eq!(parsed.blocks[4]["language"], json!("rust"));
        assert_eq!(parsed.blocks[5]["raw"], json!("> 引用的话\n"));
        assert!(parsed.usable_text);
    }

    #[test]
    fn oversized_block_is_split_and_warned() {
        let mut collector = Collector::new();
        let line = "字".repeat(400);
        let content = vec![line; 1_500].join("\n"); // ~1.8MB 字节
        assert!(content.len() > MAX_BLOCK_BYTES);
        collector.paragraph(content.clone());
        let parsed = collector.finish();
        assert!(parsed.blocks.len() > 1);
        assert!(parsed.degraded);
        for block in &parsed.blocks {
            let raw = block["raw"].as_str().unwrap_or_default();
            let text = block["text"].as_str().unwrap_or_default();
            assert!(raw.len() <= MAX_BLOCK_BYTES + 64, "raw 超出可导入限制");
            assert!(text.len() <= MAX_BLOCK_BYTES + 64);
            // adopt_markdown_blocks 的硬限制必须不被触碰。
            assert!(raw.len() < 2_000_000 && text.len() < 2_000_000);
        }
        let joined: String = parsed
            .blocks
            .iter()
            .map(|block| block["text"].as_str().unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            joined.chars().count(),
            content.chars().count() + parsed.blocks.len() - 1
        );
    }

    #[test]
    fn images_are_deduped_and_keyed_by_ref_name() {
        let mut collector = Collector::new();
        let png = b"\x89PNG\r\n\x1a\n-fake-bytes".to_vec();
        let first = collector
            .place_image("word/media/image1.png", &png, Some("image/png"), "图 A")
            .expect("图片应登记");
        let second = collector
            .place_image("word/media/image1.png", &png, Some("image/png"), "图 B")
            .expect("重复图片应复用");
        assert!(first.markdown.contains("document-image-1.png"));
        assert_eq!(first.reference["occurrence"], json!(0));
        assert_eq!(second.reference["occurrence"], json!(1));
        assert_eq!(second.reference["tokenIndex"], json!(1));
        let index = collector.image_block(first).expect("图片块应写入");
        let parsed = collector.finish();
        assert_eq!(parsed.images.len(), 1);
        assert_eq!(parsed.images[0].ref_name, "document-image-1.png");
        assert_eq!(parsed.images[0].mime, "image/png");
        assert!(!parsed.images[0].base64.contains('\n'));
        let block = &parsed.blocks[index];
        assert_eq!(block["type"], json!("other"));
        assert_eq!(block["imageRefs"][0]["href"], json!("document-image-1.png"));
        assert_eq!(block["imageRefs"][0]["blockIndex"], json!(index));
        // 图片语法不计入正文字数，但 imageRefs 保留 ref_name 供对接层换素材。
        assert!(!block["raw"].as_str().unwrap_or_default().contains(':'));
    }

    #[test]
    fn unsupported_image_keeps_text_and_warns() {
        let mut collector = Collector::new();
        let placed = collector.place_image("word/media/diagram.emf", b"EMF", None, "示意图");
        assert!(placed.is_none());
        let parsed = collector.finish();
        assert!(parsed.degraded);
        assert!(parsed.warnings.iter().any(|w| w.contains("emf")));
    }

    #[test]
    fn warnings_are_deduped_and_capped() {
        let mut collector = Collector::new();
        for index in 0..(MAX_WARNINGS + 50) {
            collector.warn(format!("提示 {index}"));
        }
        collector.warn("提示 0");
        let parsed = collector.finish();
        assert_eq!(parsed.warnings.len(), MAX_WARNINGS + 1);
        assert!(parsed.warnings[MAX_WARNINGS].contains("未列出"));
    }

    #[test]
    fn markdown_helpers_mirror_javascript() {
        assert_eq!(markdown_escape("a*b_c"), "a\\*b\\_c");
        assert_eq!(markdown_code_span("`x`"), "`` `x` ``");
        assert_eq!(markdown_code_span("x"), "`x`");
        assert_eq!(code_fence("no ticks"), "```");
        assert_eq!(code_fence("```` four"), "`````");
        assert_eq!(
            split_markdown("aaa\nbbb\n", 4),
            vec!["aaa\n".to_owned(), "bbb\n".to_owned()]
        );
        // `limit` 是字节上限（对接层 lib.rs 的 `adopt_markdown_blocks` 按字节判 2_000_000
        // 硬限制），所以 3 字节汉字在 limit=4 时只能一段一字。
        let chunks = split_markdown("一二三四五六", 4);
        assert_eq!(chunks.len(), 6);
        assert!(chunks.iter().all(|chunk| chunk.len() <= 4));
        assert_eq!(chunks.concat(), "一二三四五六");
        assert_eq!(
            normalize_newlines("a\r\nb\rc\u{0}d"),
            ("a\nb\ncd".to_owned(), 1)
        );
        assert_eq!(collapse_blank_lines("a\n\n\n\nb"), "a\n\nb");
        assert_eq!(count_body_chars("![x](a.png)abc"), 3);
    }

    #[test]
    fn path_helpers_handle_relative_references() {
        assert_eq!(
            normalize_zip_name("./OEBPS/../Images/a.png"),
            "Images/a.png"
        );
        assert_eq!(
            resolve_relative("OEBPS/Text/chap.xhtml", "../Images/pic.png").as_deref(),
            Some("OEBPS/Images/pic.png")
        );
        assert_eq!(
            resolve_relative("OEBPS/Text/chap.xhtml", "pic%201.png").as_deref(),
            Some("OEBPS/Text/pic 1.png")
        );
        assert_eq!(resolve_relative("OEBPS/Text/chap.xhtml", "#anchor"), None);
        assert_eq!(percent_decode("a%2b"), Some("a+".to_owned()));
        assert_eq!(percent_decode("a%2"), None);
    }
}
