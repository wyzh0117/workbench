//! `.epub`：ZIP 容器 -> `META-INF/container.xml` -> OPF -> spine 顺序 -> XHTML。
//!
//! 只读容器内的文件，绝不联网、绝不访问源目录。阅读顺序严格按 spine（缺失时退化为
//! manifest 顺序并提示）。CSS **完全不解析**：Workbench 的排版承载字体、颜色与版式，
//! 把样式写进正文一定是错的；唯一用到的"弱提示"是 XHTML 里的 `class` / `epub:type`
//! 名字（例如 `chapter-title`），用来给没有 `h1..h6` 的章节补标题层级。
//!
//! 单个章节读坏了只产生提示并跳过，绝不整体失败；只有容器本身不是 ZIP、或既没有
//! `container.xml` 也找不到任何 OPF 时才返回 `Err`（这份文档确实无法解析）。

use super::{
    find_zip_entry, image_identity, image_mime_from_extension, markdown_code_span, markdown_escape,
    markdown_table, normalize_zip_name, read_zip_entry, resolve_entity_reference, resolve_relative,
    BlockSpec, Collector, Kind, MAX_TOTAL_IMAGE_BYTES,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use quick_xml::XmlVersion;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// 单本书最多解析的章节数。
const MAX_CHAPTERS: usize = 1200;
/// 单章解析的事件上限，防御病态文档。
const MAX_EVENTS_PER_CHAPTER: usize = 6_000_000;
/// `data:` 图片 base64 负载的字节上限（体积上限由 `Collector` 再校验一次）。
const MAX_DATA_URI_BYTES: usize = 32 * 1024 * 1024;
/// 列表嵌套上限，更深的层级按最深处缩进。
const MAX_LIST_DEPTH: usize = 8;

/// OPF manifest 条目。
#[derive(Clone, Debug)]
struct PackageItem {
    path: String,
    media_type: String,
}

/// OPF 解析结果。
#[derive(Default)]
struct Package {
    /// 规范路径 -> manifest 条目。
    items: HashMap<String, PackageItem>,
    /// spine 顺序下的章节路径（已解析、已去重）。
    order: Vec<String>,
    /// spine 里指向缺失条目的引用数。
    broken_refs: usize,
    /// `linear="no"` 被排除的条目数。
    non_linear: usize,
    /// 是否检测到 DRM 加密声明。
    drm: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wrap {
    Bold,
    Italic,
    Strike,
    Code,
    Link,
}

/// 一个内联格式帧（加粗 / 斜体 / 删除线 / 行内代码 / 链接）。
struct Inline {
    wrap: Wrap,
    target: String,
    text: String,
}

/// 一个正在收集的块级元素。
struct Frame {
    kind: Kind,
    level: Option<u64>,
    language: Option<String>,
    prefix: String,
    text: String,
}

impl Frame {
    fn new(kind: Kind) -> Frame {
        Frame {
            kind,
            level: None,
            language: None,
            prefix: String::new(),
            text: String::new(),
        }
    }
}

/// 表格状态（只还原一层表格；嵌套表格展平为单元格文本）。
#[derive(Default)]
struct TableState {
    rows: Vec<Vec<String>>,
    row: Vec<String>,
    cell: String,
    in_cell: bool,
    nested: usize,
}

/// 章节解析器。
struct Chapter<'a> {
    out: &'a mut Collector,
    base: String,
    media: &'a HashMap<String, Vec<u8>>,
    items: &'a HashMap<String, PackageItem>,
    frames: Vec<Frame>,
    inlines: Vec<Inline>,
    lists: Vec<bool>,
    table: Option<TableState>,
    pending_list: Vec<String>,
    refs: Vec<Value>,
    pre_depth: usize,
    math_depth: usize,
    /// 正在引用的块（`blockquote` 内的段落也必须是 quote，不能降级成段落）。
    quote_depth: usize,
    text_skip: usize,
    raw_tag: Option<String>,
    placed: usize,
    internal_links: usize,
    data_images: usize,
    unsupported: usize,
    unsupported_kinds: HashSet<String>,
    unknown_entities: usize,
}

pub(crate) fn parse_epub(bytes: &[u8], out: &mut Collector) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec()))
        .map_err(|error| format!("EPUB 不是有效的 ZIP 容器（文件可能被截断）：{error}"))?;
    let opf_path = match read_container(&mut archive, out)? {
        Some(path) => Some(path),
        None => {
            let fallback = archive.file_names().map(normalize_zip_name).find(|name| {
                name.rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .ends_with(".opf")
            });
            if fallback.is_some() {
                out.warn("缺少 META-INF/container.xml，改用容器内第一个 .opf 确定章节顺序。");
            }
            fallback
        }
    };
    let Some(opf_path) = opf_path else {
        return Err(
            "EPUB 既没有 META-INF/container.xml 也没有 .opf，无法确定阅读顺序。".to_owned(),
        );
    };
    let package = read_package(&mut archive, &opf_path, out)?;
    if package.drm {
        out.degrade("文档声明了 DRM 加密，加密内容未解析（只读取容器内的明文部分）。");
    }
    let media = read_media(&mut archive, out);
    let order = reading_order(&package, out);
    if order.is_empty() {
        out.warn("EPUB 的 spine 与 manifest 里没有可解析的正文文件，未导入任何内容。");
        return Ok(());
    }
    for (chapter, path) in order.into_iter().enumerate() {
        if chapter >= MAX_CHAPTERS {
            out.warn(format!(
                "章节数量超过 {MAX_CHAPTERS}，后续章节未解析（多半是畸形文档）。"
            ));
            break;
        }
        if out.text_budget_reached() {
            out.degrade("正文提取量已达上限，后续章节未解析。");
            break;
        }
        let Some(index) = find_zip_entry(&mut archive, &path) else {
            out.warn(format!("章节 {path} 不在容器里，已跳过。"));
            continue;
        };
        let xml = match read_zip_entry(&mut archive, index) {
            Ok(xml) => xml,
            Err(error) => {
                out.warn(format!("章节 {path} 读取失败，已跳过该章：{error}"));
                continue;
            }
        };
        let utf8 = transcode_xml(&xml, out);
        let walked = Chapter {
            out: &mut *out,
            base: path.clone(),
            media: &media,
            items: &package.items,
            frames: vec![Frame::new(Kind::Paragraph)],
            inlines: Vec::new(),
            lists: Vec::new(),
            table: None,
            pending_list: Vec::new(),
            refs: Vec::new(),
            pre_depth: 0,
            math_depth: 0,
            quote_depth: 0,
            text_skip: 0,
            raw_tag: None,
            placed: 0,
            internal_links: 0,
            data_images: 0,
            unsupported: 0,
            unsupported_kinds: HashSet::new(),
            unknown_entities: 0,
        }
        .walk(&utf8);
        if let Err(error) = walked {
            out.warn(format!("章节 {path} 解析中断，该章剩余内容未导入：{error}"));
        }
    }
    Ok(())
}

impl Chapter<'_> {
    fn walk(mut self, xml: &[u8]) -> Result<(), String> {
        let mut reader = Reader::from_reader(xml);
        reader.config_mut().check_end_names = false;
        let mut buffer: Vec<u8> = Vec::new();
        let mut events = 0usize;
        let mut outcome = Ok(());
        loop {
            events += 1;
            if events > MAX_EVENTS_PER_CHAPTER {
                self.out
                    .warn("章节标签数量异常（可能已损坏），该章剩余内容停止解析。");
                break;
            }
            match reader.read_event_into(&mut buffer) {
                Ok(Event::Eof) => break,
                Ok(Event::Start(event)) => {
                    let name = name_of(&event);
                    let attributes = attributes_of(&event);
                    self.on_start(&name, &attributes);
                }
                Ok(Event::End(event)) => {
                    let name = local(event.name().into_inner());
                    self.on_end(&name);
                }
                Ok(Event::Empty(event)) => {
                    let name = name_of(&event);
                    let attributes = attributes_of(&event);
                    self.on_empty(&name, &attributes);
                }
                Ok(Event::Text(text)) => {
                    let value = text.xml10_content().into_owned();
                    self.on_text(&value);
                }
                Ok(Event::CData(data)) => {
                    let value = data.as_ref().to_owned();
                    self.on_text(&value);
                }
                Ok(Event::GeneralRef(reference)) => {
                    let raw = reference.xml10_content().into_owned();
                    match resolve_entity_reference(&raw) {
                        Some(value) => self.on_text(&value),
                        None => {
                            self.unknown_entities += 1;
                            self.on_text(&format!("&{raw};"));
                        }
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    outcome = Err(format!("{error}"));
                    break;
                }
            }
            buffer.clear();
        }
        self.finish();
        outcome
    }

    fn on_start(&mut self, name: &str, attributes: &HashMap<String, String>) {
        if self.raw_tag.is_none() && matches!(name, "script" | "style" | "head" | "title") {
            self.raw_tag = Some(name.to_owned());
            self.text_skip += 1;
            return;
        }
        if self.raw_tag.is_some() {
            return;
        }
        match name {
            "script" | "style" | "head" | "noscript" | "template" => self.text_skip += 1,
            "svg" | "canvas" | "audio" | "video" | "iframe" | "object" | "embed" | "form"
            | "select" | "textarea" | "input" | "button" => {
                self.text_skip += 1;
                self.note_unsupported(name);
            }
            "math" => {
                self.math_depth += 1;
                self.note_unsupported(name);
                self.enter_block("mathml", attributes);
            }
            "p" | "div" | "section" | "article" | "main" | "aside" | "header" | "footer"
            | "nav" | "figure" | "details" | "summary" | "address" | "blockquote" | "pre"
            | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "dt" | "dd" | "caption"
            | "figcaption" | "table" | "tr" | "td" | "th" | "hr" | "br" => {
                self.enter_block(name, attributes);
            }
            "ol" | "ul" | "dl" => self.lists.push(name == "ol"),
            "em" | "i" | "cite" | "dfn" | "var" => self.push_inline(Wrap::Italic, None),
            "strong" | "b" => self.push_inline(Wrap::Bold, None),
            "s" | "strike" | "del" => self.push_inline(Wrap::Strike, None),
            "code" | "kbd" | "samp" | "tt" if self.pre_depth == 0 && self.math_depth == 0 => {
                self.push_inline(Wrap::Code, None)
            }
            "code" | "kbd" | "samp" | "tt" if self.pre_depth > 0 => {
                self.set_code_language(attributes);
            }
            "a" => {
                let href = attributes
                    .get("href")
                    .or_else(|| attributes.get("src"))
                    .cloned()
                    .unwrap_or_default();
                if href.is_empty() || href.starts_with('#') || self.is_internal_reference(&href) {
                    if !href.is_empty() {
                        self.internal_links += 1;
                    }
                    self.push_inline(Wrap::Link, Some(String::new()));
                } else {
                    let target = self.link_target(&href);
                    self.push_inline(Wrap::Link, Some(sanitize_href(&target)));
                }
            }
            "img" | "image" => self.handle_image(attributes),
            _ => {}
        }
    }

    fn on_empty(&mut self, name: &str, attributes: &HashMap<String, String>) {
        match name {
            "br" => self.push_text("\n"),
            "hr" => {
                self.flush_frame_text();
                self.flush_pending_list();
                self.out.divider();
            }
            "img" | "image" => self.handle_image(attributes),
            "audio" | "video" | "iframe" | "object" | "embed" | "input" | "canvas" => {
                self.note_unsupported(name);
            }
            _ => self.on_start(name, attributes),
        }
    }

    fn on_end(&mut self, name: &str) {
        if self.raw_tag.as_deref() == Some(name) {
            self.raw_tag = None;
            self.text_skip = self.text_skip.saturating_sub(1);
            return;
        }
        if self.raw_tag.is_some() {
            // 还在 head / title / script / style 里：这些区域内层的闭合标签
            // 不产生任何状态变化，否则 `</style>` 会提前解除跳过、
            // 把 `<title>` 的文字漏进正文。
            return;
        }
        match name {
            "script" | "style" | "head" | "noscript" | "template" | "svg" | "canvas" | "audio"
            | "video" | "iframe" | "object" | "embed" | "form" | "select" | "textarea"
            | "input" | "button" => self.text_skip = self.text_skip.saturating_sub(1),
            "math" => {
                self.math_depth = self.math_depth.saturating_sub(1);
                self.leave_block("mathml");
            }
            "p" | "div" | "section" | "article" | "main" | "aside" | "header" | "footer"
            | "nav" | "figure" | "details" | "summary" | "address" | "blockquote" | "pre"
            | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "dt" | "dd" | "caption"
            | "figcaption" | "table" | "tr" | "td" | "th" => self.leave_block(name),
            "ol" | "ul" | "dl" => {
                self.lists.pop();
                // 嵌套列表是一个整体：只有最外层收尾才结算，
                // 否则内层 `</ol>` 会把 `- 甲 / - 乙 / 1. 丙` 劈成两块，
                // GFM 的缩进层级就读不出来了。
                if self.lists.is_empty() {
                    self.flush_pending_list();
                }
            }
            "em" | "i" | "cite" | "dfn" | "var" | "strong" | "b" | "s" | "strike" | "del"
            | "code" | "kbd" | "samp" | "tt" | "a" => self.close_inline(),
            _ => {}
        }
    }

    fn on_text(&mut self, value: &str) {
        if self.text_skip > 0 || value.is_empty() {
            return;
        }
        if self.pre_depth == 0 && self.math_depth == 0 {
            let normalized = collapse_html_spaces(value);
            self.push_text(&normalized);
        } else {
            self.push_text(value);
        }
    }

    /// 文本落地：内联帧优先，其次表格单元格，最后当前块。
    /// 这里是**源文本**入口，必须先做 markdown 转义。
    fn push_text(&mut self, value: &str) {
        if value.is_empty() {
            return;
        }
        let raw_spacing = self.pre_depth > 0 || self.math_depth > 0;
        let wrapped = if raw_spacing {
            value.to_owned()
        } else {
            markdown_escape(value)
        };
        self.commit(&wrapped, !raw_spacing);
    }

    /// 已经成形的 markdown 片段（强调、行内代码、链接、图片）：
    /// 再转义一次就会把 `**` / `[]()` / `![]()` 变成字面反斜杠，必须绕过转义。
    fn push_markdown(&mut self, value: &str) {
        if value.is_empty() {
            return;
        }
        self.commit(value, true);
    }

    /// 把片段追加到当前落点：内联帧 > 表格单元格 > 当前块。
    fn commit(&mut self, value: &str, merge_boundary_space: bool) {
        if let Some(inline) = self.inlines.last_mut() {
            append_fragment(&mut inline.text, value, merge_boundary_space);
            return;
        }
        if let Some(state) = self.table.as_mut() {
            if state.in_cell {
                append_fragment(&mut state.cell, value, merge_boundary_space);
                return;
            }
        }
        if let Some(frame) = self.frames.last_mut() {
            append_fragment(&mut frame.text, value, merge_boundary_space);
        }
    }

    fn push_inline(&mut self, wrap: Wrap, target: Option<String>) {
        self.inlines.push(Inline {
            wrap,
            target: target.unwrap_or_default(),
            text: String::new(),
        });
    }

    fn close_inline(&mut self) {
        let Some(inline) = self.inlines.pop() else {
            return;
        };
        let raw = inline.text;
        let inner = raw.trim().to_owned();
        if inner.is_empty() && inline.wrap != Wrap::Link {
            // 空强调（`<b> </b>`）：至少把空白还给正文，否则两侧的词会被缝在一起。
            if !raw.is_empty() {
                self.push_markdown(&raw);
            }
            return;
        }
        // 强调标记只能包住实际文字：首尾空白留在标记外面，词与词之间的缝才不会丢。
        let lead = &raw[..raw.len() - raw.trim_start().len()];
        let trail = &raw[raw.trim_end().len()..];
        let body = match inline.wrap {
            Wrap::Bold => format!("**{inner}**"),
            Wrap::Italic => format!("*{inner}*"),
            Wrap::Strike => format!("~~{inner}~~"),
            Wrap::Code => markdown_code_span(&inner),
            Wrap::Link => {
                let label = if inner.is_empty() {
                    markdown_escape(&inline.target)
                } else {
                    inner.replace(['[', ']'], ")")
                };
                if inline.target.is_empty() {
                    label
                } else {
                    format!("[{label}]({})", inline.target)
                }
            }
        };
        let rendered = format!("{lead}{body}{trail}");
        self.push_markdown(&rendered);
    }

    /// 结算前把未闭合的行内帧倒回正文：`<p>文字 <b>未闭合` 不能把 `b` 里的字丢掉。
    fn drain_open_inlines(&mut self) {
        while !self.inlines.is_empty() {
            self.close_inline();
        }
    }

    /// 块级元素进入：先结算当前文本，再压入新帧。
    fn enter_block(&mut self, name: &str, attributes: &HashMap<String, String>) {
        match name {
            "table" => {
                self.flush_frame_text();
                self.flush_pending_list();
                match self.table.as_mut() {
                    Some(state) => state.nested += 1,
                    None => self.table = Some(TableState::default()),
                }
                return;
            }
            "tr" => {
                if let Some(state) = self.table.as_mut() {
                    if state.nested == 0 {
                        state.row = Vec::new();
                    }
                }
                return;
            }
            "td" | "th" => {
                if let Some(state) = self.table.as_mut() {
                    if state.nested == 0 {
                        state.in_cell = true;
                        state.cell = String::new();
                    }
                }
                return;
            }
            "br" => {
                self.push_text("\n");
                return;
            }
            "hr" => {
                self.flush_frame_text();
                self.flush_pending_list();
                self.out.divider();
                return;
            }
            _ => {}
        }
        if self
            .table
            .as_ref()
            .is_some_and(|state| state.nested > 0 || state.in_cell)
        {
            // 单元格 / 嵌套表格内部的块只贡献文本，不单独成块。
            return;
        }
        let frame = match name {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let mut frame = Frame::new(Kind::Heading);
                frame.level = Some(name[1..].parse::<u64>().unwrap_or(1).clamp(1, 6));
                frame
            }
            "blockquote" => {
                self.quote_depth += 1;
                Frame::new(Kind::Quote)
            }
            "pre" => {
                self.pre_depth += 1;
                let mut frame = Frame::new(Kind::Code);
                frame.language = code_language_from_class(attributes);
                frame
            }
            "mathml" => Frame::new(Kind::Code),
            "li" | "dt" | "dd" => {
                let mut frame = Frame::new(Kind::List);
                frame.prefix = self.list_prefix();
                frame
            }
            _ => {
                let mut frame = Frame::new(if self.quote_depth > 0 {
                    Kind::Quote
                } else {
                    Kind::Paragraph
                });
                if let Some(level) = heading_hint_from_class(attributes) {
                    frame.kind = Kind::Heading;
                    frame.level = Some(level);
                }
                frame
            }
        };
        self.flush_frame_text();
        self.frames.push(frame);
    }

    fn leave_block(&mut self, name: &str) {
        match name {
            "table" => {
                if let Some(state) = self.table.as_mut() {
                    if state.nested > 0 {
                        state.nested -= 1;
                        return;
                    }
                }
                let Some(state) = self.table.take() else {
                    return;
                };
                self.finish_table(state);
                return;
            }
            "tr" => {
                if let Some(state) = self.table.as_mut() {
                    if state.nested == 0 {
                        let row = std::mem::take(&mut state.row);
                        state.rows.push(row);
                    }
                }
                return;
            }
            "td" | "th" => {
                if let Some(state) = self.table.as_mut() {
                    if state.nested == 0 && state.in_cell {
                        let cell = std::mem::take(&mut state.cell);
                        state.row.push(cell.trim().to_owned());
                        state.in_cell = false;
                    }
                }
                return;
            }
            "pre" => {
                self.pre_depth = self.pre_depth.saturating_sub(1);
            }
            "blockquote" => {
                self.quote_depth = self.quote_depth.saturating_sub(1);
            }
            _ => {}
        }
        if self
            .table
            .as_ref()
            .is_some_and(|state| state.nested > 0 || state.in_cell)
        {
            return;
        }
        self.flush_frame_text();
        if self.frames.len() > 1 {
            self.frames.pop();
        }
    }

    fn list_prefix(&self) -> String {
        let depth = self.lists.len().saturating_sub(1).min(MAX_LIST_DEPTH);
        let indent = "  ".repeat(depth);
        if self.lists.last().copied().unwrap_or(false) {
            format!("{indent}1. ")
        } else {
            format!("{indent}- ")
        }
    }

    /// 当前帧文本结算成区块（列表项先进缓冲，连续项合成一个 list 区块）。
    fn flush_frame_text(&mut self) {
        self.drain_open_inlines();
        let Some(frame) = self.frames.last_mut() else {
            return;
        };
        let raw = std::mem::take(&mut frame.text);
        let prefix = frame.prefix.clone();
        let kind = frame.kind;
        let level = frame.level;
        let language = frame.language.clone();
        let text = raw
            .trim_matches(|c| matches!(c, ' ' | '\t' | '\n'))
            .to_owned();
        let references = std::mem::take(&mut self.refs);
        if text.is_empty() && references.is_empty() {
            return;
        }
        if kind == Kind::List {
            if !text.is_empty() {
                self.pending_list.push(format!("{prefix}{text}"));
            }
            self.refs = references;
            return;
        }
        self.flush_pending_list();
        self.out.block(BlockSpec {
            kind,
            content: text,
            level,
            language,
            checked: None,
            images: references,
        });
    }

    fn flush_pending_list(&mut self) {
        if self.pending_list.is_empty() {
            return;
        }
        let content = std::mem::take(&mut self.pending_list).join("\n");
        let references = std::mem::take(&mut self.refs);
        self.out.block(BlockSpec {
            kind: Kind::List,
            content,
            level: None,
            language: None,
            checked: None,
            images: references,
        });
    }

    fn finish_table(&mut self, state: TableState) {
        let widths: Vec<usize> = state
            .rows
            .iter()
            .map(|row| row.len())
            .filter(|count| *count > 0)
            .collect();
        let columns = widths.iter().copied().max().unwrap_or_default();
        let uneven = widths.iter().filter(|count| **count != columns).count();
        if uneven > 0 {
            // GFM 的列数由表头分隔行决定：不补齐就会被渲染端整列丢掉，
            // 所以这里既补齐（不丢内容）也明确降级提示。
            self.out.degrade(format!(
                "表格有 {uneven} 行单元格数与最宽行（{columns} 列）不一致，缺失处已补空单元格。"
            ));
        }
        match markdown_table(&state.rows) {
            Some(source) => {
                self.out.table(source);
            }
            None => self.out.warn("表格没有可还原的单元格内容，已跳过该表格。"),
        }
    }

    fn handle_image(&mut self, attributes: &HashMap<String, String>) {
        let source = attributes
            .get("src")
            .or_else(|| attributes.get("href"))
            .cloned()
            .unwrap_or_default();
        if source.trim().is_empty() {
            self.out
                .warn("文档里有没有来源的图片标签，已只保留正文文字。");
            return;
        }
        let alt = ["alt", "aria-label", "title", "desc"]
            .iter()
            .find_map(|key| attributes.get(*key))
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .unwrap_or_default();
        let (identity, mime, bytes) = if let Some(rest) = source.strip_prefix("data:") {
            match decode_data_uri(rest) {
                Some((mime, bytes)) => {
                    self.data_images += 1;
                    (
                        format!("data-{}", image_identity(&bytes)),
                        Some(mime),
                        bytes,
                    )
                }
                None => {
                    self.out.degrade(
                        "文档里有无法解码或过大的 data: 图片，已跳过该位置（正文文字保留）。",
                    );
                    return;
                }
            }
        } else {
            let Some(path) = resolve_relative(&self.base, &source) else {
                self.out
                    .warn(format!("图片引用 {source} 无法定位到容器内文件，已跳过。"));
                return;
            };
            let mime = self
                .items
                .get(&path)
                .and_then(|item| mime_from_media_type(&item.media_type))
                .or_else(|| image_mime_from_extension(path.rsplit('.').next().unwrap_or_default()));
            match self.media.get(&path) {
                Some(bytes) => (path.clone(), mime.map(str::to_owned), bytes.clone()),
                None => {
                    self.out.warn(format!(
                        "内嵌图片 {path} 不在容器里或超出大小上限，已跳过该位置。"
                    ));
                    return;
                }
            }
        };
        self.placed += 1;
        let alt = if alt.trim().is_empty() {
            format!("文档图片 {}", self.placed)
        } else {
            alt
        };
        let Some(placement) = self
            .out
            .place_image(&identity, &bytes, mime.as_deref(), &alt)
        else {
            return;
        };
        self.refs.push(placement.reference);
        self.push_markdown(&placement.markdown);
    }

    fn note_unsupported(&mut self, name: &str) {
        self.unsupported += 1;
        self.unsupported_kinds.insert(name.to_owned());
    }

    /// 指向本书内其它文件的引用（非 `http:` 等外链）按内部锚点处理。
    fn is_internal_reference(&self, href: &str) -> bool {
        if has_scheme(href) {
            return false;
        }
        match resolve_relative(&self.base, href) {
            Some(path) => self.items.contains_key(&path),
            None => false,
        }
    }

    /// 链接目标：带 scheme 的原样保留；相对写法规范化成容器内路径，
    /// 这样 `../` 之类的越界引用不会带着跳出容器的路径进正文（正文只读、不落地）。
    fn link_target(&self, href: &str) -> String {
        if has_scheme(href) {
            return href.to_owned();
        }
        let fragment = match href.find('#') {
            Some(index) => href[index..].to_owned(),
            None => String::new(),
        };
        match resolve_relative(&self.base, href) {
            Some(path) => format!("{path}{fragment}"),
            None => href.to_owned(),
        }
    }

    /// `<pre><code class="language-rust">`：语言标在 `code` 上（最常见写法）也要认。
    fn set_code_language(&mut self, attributes: &HashMap<String, String>) {
        let Some(frame) = self.frames.last_mut() else {
            return;
        };
        if frame.kind == Kind::Code && frame.language.is_none() {
            frame.language = code_language_from_class(attributes);
        }
    }

    /// 章节结束：收尾未闭合的帧与列表，并输出聚合提示。
    fn finish(&mut self) {
        while self.frames.len() > 1 {
            self.flush_frame_text();
            self.frames.pop();
        }
        self.flush_frame_text();
        if let Some(state) = self.table.take() {
            self.finish_table(state);
        }
        self.flush_pending_list();
        if self.unsupported > 0 {
            let mut kinds: Vec<&str> = self.unsupported_kinds.iter().map(String::as_str).collect();
            kinds.sort_unstable();
            self.out.degrade(format!(
                "文档里的 {} 处图形 / 媒体 / 公式对象（{}）无法还原为正文，已只保留文字。",
                self.unsupported,
                kinds.join("、")
            ));
        }
        if self.unknown_entities > 0 {
            self.out.warn(format!(
                "有 {} 处无法识别的实体引用，已按原文保留。",
                self.unknown_entities
            ));
        }
        if self.internal_links > 0 {
            self.out.degrade(format!(
                "章节内锚点链接（{} 处）导入后无法跳转，已只保留链接文字。",
                self.internal_links
            ));
        }
        if self.data_images > 0 {
            self.out.warn(format!(
                "{} 张 data: 内联图片已解码为普通图片。",
                self.data_images
            ));
        }
    }
}

/// `container.xml` -> OPF 路径。
fn read_container(
    archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
    out: &mut Collector,
) -> Result<Option<String>, String> {
    let Some(index) = find_zip_entry(&mut *archive, "META-INF/container.xml") else {
        return Ok(None);
    };
    let xml = match read_zip_entry(archive, index) {
        Ok(xml) => xml,
        Err(error) => {
            out.warn(format!(
                "container.xml 读取失败，改用容器内第一个 .opf：{error}"
            ));
            return Ok(None);
        }
    };
    let mut reader = Reader::from_reader(xml.as_slice());
    let mut buffer = Vec::new();
    let mut found: Option<String> = None;
    let mut extra = 0usize;
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(event)) | Ok(Event::Empty(event)) => {
                if local(event.name().into_inner()) != "rootfile" {
                    continue;
                }
                let attributes = attributes_of(&event);
                let Some(full_path) = attributes.get("full-path").cloned() else {
                    continue;
                };
                if attributes
                    .get("media-type")
                    .is_some_and(|value| value.contains("encrypted"))
                {
                    out.degrade("container.xml 声明了加密的根文件，内容未解析。");
                }
                let path = normalize_zip_name(&full_path);
                if found.is_none() {
                    found = Some(path.clone());
                } else {
                    extra += 1;
                }
            }
            Ok(_) => {}
            Err(error) => {
                out.warn(format!("container.xml 解析中断：{error}"));
                break;
            }
        }
        buffer.clear();
    }
    if extra > 0 {
        out.warn(format!(
            "container.xml 声明了 {extra} 个额外根文件，只按第一个（{}）解析。",
            found.clone().unwrap_or_default()
        ));
    }
    if found.is_none() {
        out.warn("container.xml 里没有可用的 rootfile。");
    }
    Ok(found)
}

/// OPF：manifest + spine（spine 顺序即阅读顺序）。
fn read_package(
    archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
    opf_path: &str,
    out: &mut Collector,
) -> Result<Package, String> {
    let mut package = Package::default();
    let Some(index) = find_zip_entry(&mut *archive, opf_path) else {
        out.warn(format!("OPF（{opf_path}）不在容器里，无法确定章节顺序。"));
        return Ok(package);
    };
    let xml = read_zip_entry(archive, index)?;
    let mut reader = Reader::from_reader(xml.as_slice());
    let mut buffer = Vec::new();
    let mut by_id: HashMap<String, String> = HashMap::new();
    let mut references: Vec<(String, bool)> = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(event)) | Ok(Event::Empty(event)) => {
                let name = local(event.name().into_inner());
                let attributes = attributes_of(&event);
                match name.as_str() {
                    "item" => {
                        let href = attributes.get("href").cloned().unwrap_or_default();
                        let path = resolve_relative(opf_path, &href)
                            .or_else(|| Some(normalize_zip_name(&href)))
                            .unwrap_or_default();
                        if path.is_empty() {
                            out.warn("OPF 里有缺少 href 的 manifest 条目，该条目已忽略。");
                            continue;
                        }
                        let id = attributes.get("id").cloned().unwrap_or_default();
                        if id.is_empty() {
                            out.warn("OPF 里有缺少 id 的 manifest 条目，spine 无法引用它。");
                        } else {
                            by_id.insert(id, path.clone());
                        }
                        package.items.insert(
                            path.clone(),
                            PackageItem {
                                path,
                                media_type: attributes
                                    .get("media-type")
                                    .cloned()
                                    .unwrap_or_default(),
                            },
                        );
                    }
                    "itemref" => {
                        let idref = attributes.get("idref").cloned().unwrap_or_default();
                        let linear = !attributes
                            .get("linear")
                            .is_some_and(|value| value.eq_ignore_ascii_case("no"));
                        references.push((idref, linear));
                    }
                    "encryption" => package.drm = true,
                    _ => {
                        if attributes
                            .get("driver")
                            .is_some_and(|value| value.contains("encrypt"))
                        {
                            package.drm = true;
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(error) => return Err(format!("EPUB 的 OPF 无法解析：{error}")),
        }
        buffer.clear();
    }
    for (idref, linear) in &references {
        let Some(path) = by_id.get(idref) else {
            package.broken_refs += 1;
            continue;
        };
        if !linear {
            package.non_linear += 1;
            continue;
        }
        if !package.order.iter().any(|existing| existing == path) {
            package.order.push(path.clone());
        }
    }
    if package.broken_refs > 0 {
        out.warn(format!(
            "spine 里有 {} 个引用在 manifest 中不存在，对应章节未解析。",
            package.broken_refs
        ));
    }
    if package.non_linear > 0 {
        out.warn(format!(
            "spine 里有 {} 个 linear=no 的章节，按 EPUB 语义不计入阅读顺序。",
            package.non_linear
        ));
    }
    Ok(package)
}

/// 阅读顺序：spine 优先，为空时退化为 manifest 中正文文件的路径顺序。
fn reading_order(package: &Package, out: &mut Collector) -> Vec<String> {
    let documents: Vec<String> = package
        .order
        .iter()
        .filter(|path| is_document(package, path))
        .cloned()
        .collect();
    if !documents.is_empty() {
        return documents;
    }
    let mut fallback: Vec<String> = package
        .items
        .values()
        .filter(|item| is_document_media_type(&item.media_type) || looks_like_html(&item.path))
        .map(|item| item.path.clone())
        .collect();
    fallback.sort();
    if !fallback.is_empty() {
        out.degrade("EPUB 的 spine 为空或全部指向缺失条目，章节顺序改用 manifest 的路径顺序。");
    }
    fallback
}

fn is_document(package: &Package, path: &str) -> bool {
    match package.items.get(path) {
        Some(item) => is_document_media_type(&item.media_type) || looks_like_html(path),
        None => looks_like_html(path),
    }
}

fn is_document_media_type(media_type: &str) -> bool {
    let lowered = media_type.to_ascii_lowercase();
    lowered.ends_with("html") || lowered.ends_with("xhtml") || lowered == "application/xml"
}

fn looks_like_html(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "xhtml" | "html" | "htm" | "xml"
    )
}

fn mime_from_media_type(media_type: &str) -> Option<&'static str> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" | "image/pjpeg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        "image/bmp" | "image/x-bmp" => Some("image/bmp"),
        "image/tiff" | "image/x-tiff" => Some("image/tiff"),
        "image/svg+xml" => Some("image/svg+xml"),
        "image/avif" => Some("image/avif"),
        "image/heic" => Some("image/heic"),
        _ => None,
    }
}

/// 预读容器里的图片条目（带总量上限），避免解析过程中反复解压不可信容器。
fn read_media(
    archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
    out: &mut Collector,
) -> HashMap<String, Vec<u8>> {
    let mut media: HashMap<String, Vec<u8>> = HashMap::new();
    let mut candidates: Vec<(usize, String, usize)> = Vec::new();
    for index in 0..archive.len() {
        let Ok(file) = archive.by_index(index) else {
            continue;
        };
        if file.is_dir() {
            continue;
        }
        let name = normalize_zip_name(file.name());
        if image_mime_from_extension(name.rsplit('.').next().unwrap_or_default()).is_none() {
            continue;
        }
        candidates.push((
            index,
            name,
            usize::try_from(file.size()).unwrap_or(usize::MAX),
        ));
    }
    let mut total = 0usize;
    for (index, name, declared) in candidates {
        if total.saturating_add(declared) > MAX_TOTAL_IMAGE_BYTES {
            out.degrade("容器内图片总量超出上限，其余图片未提取（正文文字保留）。");
            break;
        }
        match read_zip_entry(archive, index) {
            Ok(bytes) => {
                total = total.saturating_add(bytes.len());
                media.insert(name, bytes);
            }
            Err(error) => out.warn(format!("图片 {name} 解压失败，已跳过：{error}")),
        }
    }
    media
}

/// XHTML 一律按 UTF-8 解析；带 BOM 的 UTF-16 需要转码。
fn transcode_xml(bytes: &[u8], out: &mut Collector) -> Vec<u8> {
    let little = if bytes.starts_with(&[0xff, 0xfe]) {
        true
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        false
    } else {
        return bytes.to_vec();
    };
    let body = bytes.get(2..).unwrap_or(&[]);
    let units: Vec<u16> = body
        .chunks(2)
        .filter_map(|chunk| {
            // 末尾落单的一字节按补 0 处理（畸形文档），不 panic。
            let first = chunk.first().copied().unwrap_or_default();
            let second = chunk.get(1).copied().unwrap_or_default();
            Some(if little {
                u16::from_le_bytes([first, second])
            } else {
                u16::from_be_bytes([first, second])
            })
        })
        .collect();
    out.warn("章节使用 UTF-16 编码，已转成 UTF-8 后解析。");
    // 孤立代理项用替换字符兜住：绝不 panic，也绝不止损在半个字符上。
    char::decode_utf16(units)
        .map(|value| value.unwrap_or('\u{fffd}'))
        .collect::<String>()
        .into_bytes()
}

fn decode_data_uri(rest: &str) -> Option<(String, Vec<u8>)> {
    let (meta, payload) = rest.split_once(',')?;
    if payload.len() > MAX_DATA_URI_BYTES {
        return None;
    }
    let mime = meta
        .split(';')
        .next()
        .filter(|value| value.starts_with("image/"))?
        .to_ascii_lowercase();
    let cleaned: String = payload
        .chars()
        .filter(|value| !value.is_whitespace())
        .collect();
    let bytes = BASE64.decode(cleaned).ok()?;
    Some((mime, bytes))
}

/// class / epub:type 名字里的标题弱提示（只看名字，绝不解析 CSS 规则）。
fn heading_hint_from_class(attributes: &HashMap<String, String>) -> Option<u64> {
    let probe = ["class", "epub:type"]
        .iter()
        .filter_map(|key| attributes.get(*key))
        .cloned()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if probe.is_empty() {
        return None;
    }
    for token in probe.split(|c: char| !c.is_alphanumeric()) {
        let level = match token {
            "h1" => 1,
            "h2" => 2,
            "h3" => 3,
            "h4" => 4,
            "h5" => 5,
            "h6" => 6,
            _ => continue,
        };
        return Some(level);
    }
    if probe.contains("chapter-title")
        || probe.contains("book-title")
        || probe.contains("titlepage")
        || probe.contains("heading1")
    {
        return Some(1);
    }
    if probe.contains("heading") || probe.contains("chapter") || probe.contains("title") {
        return Some(2);
    }
    None
}

/// `class="language-rust"` 之类的弱提示。
fn code_language_from_class(attributes: &HashMap<String, String>) -> Option<String> {
    let class = attributes.get("class")?.to_ascii_lowercase();
    for token in class.split_whitespace() {
        let language = token
            .strip_prefix("language-")
            .or_else(|| token.strip_prefix("lang-"))
            .unwrap_or_default();
        if !language.is_empty() && language.len() <= 24 {
            return Some(language.to_owned());
        }
    }
    None
}

fn has_scheme(href: &str) -> bool {
    let lowered = href.to_ascii_lowercase();
    [
        "http:",
        "https:",
        "mailto:",
        "ftp:",
        "data:",
        "tel:",
        "javascript:",
    ]
    .iter()
    .any(|scheme| lowered.starts_with(scheme))
}

/// 链接目标必须能安全放进 markdown：去掉空白与方括号，圆括号转义。
fn sanitize_href(value: &str) -> String {
    let cleaned = value
        .trim()
        .replace(['[', ']', '<', '>', '\\', ' '], "")
        .replace('(', "%28")
        .replace(')', "%29");
    cleaned.chars().take(2_000).collect()
}

/// HTML 空白语义：连续空白压成一个空格（首尾空白由落点决定，
/// 落点是否吃这个空格由 `append_fragment` 判断，否则 `a <b>x</b> b` 会粘成 `axb`）。
fn collapse_html_spaces(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending = false;
    for character in value.chars() {
        if character.is_whitespace() {
            pending = true;
        } else {
            if pending {
                // 前导空白也压成一个空格交给 `append_fragment` 判定：
                // 在这里就吃掉的话，`a <b>x</b> b` 会被缝成 `axb`。
                out.push(' ');
            }
            pending = false;
            out.push(character);
        }
    }
    if pending {
        out.push(' ');
    }
    out
}

/// 追加片段：目标为空时不吃前导空白，避免段落开头凭空多一个空格。
/// `merge_boundary_space` 表示这段空白可以按 HTML 语义合并（`pre` / 公式内为 `false`，
/// 那里的空格是内容）。
fn append_fragment(target: &mut String, value: &str, merge_boundary_space: bool) {
    if target.is_empty() {
        target.push_str(value.trim_start_matches([' ', '\n', '\t']));
        return;
    }
    if value == " " && target.ends_with([' ', '\n']) {
        return;
    }
    if merge_boundary_space && value.starts_with(' ') && target.ends_with(' ') {
        target.push_str(&value[1..]);
        return;
    }
    target.push_str(value);
}

fn local(raw: &str) -> String {
    raw.rsplit(':').next().unwrap_or(raw).to_owned()
}

fn name_of(event: &BytesStart<'_>) -> String {
    local(event.name().into_inner())
}

/// 属性值：先按 XML 规则还原实体引用与换行，失败就退回原始文本（绝不丢字）。
fn attribute_value_of(attribute: &quick_xml::events::attributes::Attribute<'_>) -> String {
    match attribute.normalized_value(XmlVersion::default()) {
        Ok(value) => value.into_owned(),
        Err(_) => attribute.value.clone().into_owned(),
    }
}

fn attributes_of(event: &BytesStart<'_>) -> HashMap<String, String> {
    let mut attrs: HashMap<String, String> = HashMap::new();
    for attribute in event.attributes().flatten() {
        let key = local(attribute.key.into_inner());
        let value = attribute_value_of(&attribute);
        attrs.insert(key, value);
    }
    attrs
}

#[cfg(test)]
mod tests;
