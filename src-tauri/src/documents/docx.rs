//! `.docx`：ZIP + `word/document.xml` 的事件式解析。
//!
//! 保留：段落顺序、标题层级（Heading1..6，兼容中文版样式名与 styles.xml 映射）、
//! 加粗 / 斜体 / 删除线、列表（含 `numbering.xml` 的编号语义）、表格、超链接
//! （`w:hyperlink r:id` -> `word/_rels/document.xml.rels`）、简单引用样式、
//! 行内图片（`w:drawing`/`a:blip` -> `word/media/*`，按文档顺序落位）。
//!
//! 明确忽略（不写进正文）：Word 主题、字体族、字号、颜色、页边距、页眉页脚、
//! 文本框、WordArt。单个不支持的对象只产生提示，绝不整体失败。

use super::{
    find_zip_entry, image_mime_from_extension, markdown_escape, markdown_table, normalize_zip_name,
    read_zip_entry, resolve_entity_reference, resolve_relative, BlockSpec, Collector, Kind,
    MAX_IMAGE_BYTES, MAX_PART_BYTES,
};
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use quick_xml::XmlVersion;
use serde_json::Value;
use std::collections::HashMap;

/// 关系表条目：`Id -> (Target, 是否外链)`。
#[derive(Clone, Debug)]
struct Relationship {
    target: String,
    external: bool,
}

/// `numbering.xml` 摘要：numId -> abstractNumId；(abstractNumId, ilvl) -> numFmt。
#[derive(Default)]
struct Numbering {
    abstract_by_num: HashMap<String, String>,
    formats: HashMap<(String, i64), String>,
}

/// 段落累积状态。
#[derive(Default)]
struct Paragraph {
    style: Option<String>,
    ilvl: Option<i64>,
    numid: Option<String>,
    text: String,
    images: Vec<Value>,
}

/// 表格累积状态（只还原一层表格；嵌套表格展平为单元格文本）。
#[derive(Default)]
struct TableState {
    rows: Vec<Vec<String>>,
    current_row: Vec<String>,
    cell: String,
    in_cell: bool,
    nested: usize,
}

/// 行内格式：`w:rPr` 的加粗 / 斜体 / 删除线。
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct RunProps {
    bold: bool,
    italic: bool,
    strike: bool,
}

/// 超链接帧：目标 + 标签缓冲。
struct LinkFrame {
    target: String,
    label: String,
}

struct Walk<'a> {
    out: &'a mut Collector,
    rels: HashMap<String, Relationship>,
    numbering: Numbering,
    styles: HashMap<String, String>,
    media: HashMap<String, Option<Vec<u8>>>,
    paragraph: Paragraph,
    has_paragraph: bool,
    table: Option<TableState>,
    pending_list: Vec<String>,
    pending_list_images: Vec<Value>,
    links: Vec<LinkFrame>,
    run: RunProps,
    in_rpr: bool,
    textbox_depth: usize,
    in_del_text: bool,
    in_instr_text: bool,
    in_field_code: bool,
    drawing_depth: usize,
    drawing_alt: String,
    placed_images: usize,
    deleted_runs: usize,
    merged_cells: usize,
    nested_tables: usize,
    lists_in_tables: usize,
    internal_links: usize,
}

pub(crate) fn parse_docx(bytes: &[u8], out: &mut Collector) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec()))
        .map_err(|error| format!("DOCX 不是有效的 ZIP 容器（文件可能被截断）：{error}"))?;
    let document_index = find_zip_entry(&mut archive, "word/document.xml")
        .ok_or_else(|| "DOCX 缺少 word/document.xml，无法解析正文。".to_owned())?;
    let document_xml = read_zip_entry(&mut archive, document_index)?;
    let rels = read_relationships(&mut archive, "word/_rels/document.xml.rels")?;
    let media = read_media(&mut archive, out)?;
    let styles = read_styles(&mut archive, out);
    let numbering = read_numbering(&mut archive, out)?;
    let mut walk = Walk {
        out,
        rels,
        numbering,
        styles,
        media,
        paragraph: Paragraph::default(),
        has_paragraph: false,
        table: None,
        pending_list: Vec::new(),
        pending_list_images: Vec::new(),
        links: Vec::new(),
        run: RunProps::default(),
        in_rpr: false,
        textbox_depth: 0,
        in_del_text: false,
        in_instr_text: false,
        in_field_code: false,
        drawing_depth: 0,
        drawing_alt: String::new(),
        placed_images: 0,
        deleted_runs: 0,
        merged_cells: 0,
        nested_tables: 0,
        lists_in_tables: 0,
        internal_links: 0,
    };
    walk.run(&document_xml)?;
    walk.finish();
    Ok(())
}

impl Walk<'_> {
    fn run(&mut self, xml: &[u8]) -> Result<(), String> {
        let mut reader = Reader::from_reader(xml);
        let mut buffer: Vec<u8> = Vec::new();
        loop {
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
                Ok(Event::GeneralRef(reference)) => {
                    let raw = reference.xml10_content().into_owned();
                    match resolve_entity_reference(&raw) {
                        Some(value) => self.on_text(&value),
                        None => {
                            self.out.warn("文档里有无法识别的实体引用，已按原文保留。");
                            self.on_text(&format!("&{raw};"));
                        }
                    }
                }
                Ok(Event::CData(data)) => {
                    let value = data.as_ref().to_owned();
                    self.on_text(&value);
                }
                Ok(_) => {}
                Err(error) => return Err(format!("DOCX 正文 XML 无法解析：{error}")),
            }
            buffer.clear();
        }
        Ok(())
    }

    fn on_start(&mut self, name: &str, attributes: &HashMap<String, String>) {
        match name {
            "p" => {
                if self.textbox_depth == 0 {
                    self.paragraph = Paragraph::default();
                    self.has_paragraph = true;
                    self.run = RunProps::default();
                }
            }
            "r" => {
                // 每个 run 从干净格式开始：否则上一个 run 的加粗会漏染后面的 run。
                if self.textbox_depth == 0 {
                    self.run = RunProps::default();
                }
            }
            "pStyle" => {
                // 段落属性写在 <w:p> 之后、正文之前，直接落到当前段落。
                if self.textbox_depth == 0 {
                    self.paragraph.style = attributes.get("val").cloned();
                }
            }
            "rPr" => {
                self.in_rpr = true;
                if self.textbox_depth == 0 {
                    self.run = RunProps::default();
                }
            }
            "b" if self.in_rpr => {
                self.run.bold = truthy(attributes.get("val"));
            }
            "i" if self.in_rpr => {
                self.run.italic = truthy(attributes.get("val"));
            }
            "strike" | "dstrike" if self.in_rpr => {
                self.run.strike = truthy(attributes.get("val"));
            }
            "numPr" => {}
            "ilvl" => {
                if self.textbox_depth == 0 {
                    self.paragraph.ilvl = attributes
                        .get("val")
                        .and_then(|value| value.parse::<i64>().ok());
                }
            }
            "numId" => {
                if self.textbox_depth == 0 {
                    self.paragraph.numid = attributes.get("val").cloned();
                }
            }
            "hyperlink" => {
                if self.textbox_depth == 0 {
                    let target = self.hyperlink_target(attributes);
                    self.links.push(LinkFrame {
                        target,
                        label: String::new(),
                    });
                }
            }
            "drawing" | "pict" => {
                if self.textbox_depth == 0 {
                    self.drawing_depth += 1;
                    self.drawing_alt = String::new();
                }
            }
            "docPr" if self.drawing_depth > 0 => {
                // 只认 `descr`（作者在"替换文字"里写的-alt）：`wp:docPr/@name` 是
                // Word 自动生成的对象名（"Picture 7" / "图片 1"），当 alt 用只会污染正文，
                // 空着时由 `request_image` 用"文档图片 N"占位。
                self.drawing_alt = attributes
                    .get("descr")
                    .filter(|value| !value.trim().is_empty())
                    .cloned()
                    .unwrap_or_default();
            }
            "blip" | "imagedata" if self.drawing_depth > 0 => {
                self.request_image(attributes);
            }
            "txbxContent" => {
                self.textbox_depth += 1;
                self.out
                    .degrade("文本框 / WordArt 的内容不导入正文（Workbench 由排版承载文字）。");
            }
            "tbl" => {
                if self.textbox_depth > 0 {
                    return;
                }
                if self.table.is_some() {
                    self.nested_tables += 1;
                    if let Some(state) = self.table.as_mut() {
                        state.nested += 1;
                    }
                } else {
                    self.flush_paragraph_now();
                    self.table = Some(TableState::default());
                }
            }
            "tr" => {
                if let Some(state) = self.table.as_mut() {
                    if state.nested == 0 {
                        state.current_row = Vec::new();
                    }
                }
            }
            "tc" => {
                if let Some(state) = self.table.as_mut() {
                    if state.nested == 0 {
                        state.in_cell = true;
                        state.cell = String::new();
                    }
                }
            }
            // OOXML 里合并单元格是 `w:tcPr` 的子元素（`<w:vMerge/>` / `<w:gridSpan w:val="2"/>`），
            // 不是 `w:tc` 的属性：只查属性的话，真实文件里的合并单元格一条提示都不会有。
            "vMerge" | "gridSpan" if self.table.is_some() && self.textbox_depth == 0 => {
                self.merged_cells += 1;
            }
            "delText" => {
                self.in_del_text = true;
                self.deleted_runs += 1;
            }
            "instrText" => self.in_instr_text = true,
            "fldChar" => {
                self.in_field_code = match attributes.get("fldCharType").map(|v| v.as_str()) {
                    Some("begin") => true,
                    Some("separate") | Some("end") => false,
                    _ => self.in_field_code,
                };
            }
            "br" | "cr" => self.push_text("\n"),
            "tab" => self.push_text("\t"),
            "noBreakHyphen" => self.push_text("-"),
            "sym" => {
                self.out
                    .warn("符号字体字符（w:sym）无法可靠还原，已用占位符保留位置。");
                self.push_text("□");
            }
            _ => {}
        }
    }

    fn on_empty(&mut self, name: &str, attributes: &HashMap<String, String>) {
        match name {
            "br" | "cr" => self.push_text("\n"),
            "tab" => self.push_text("\t"),
            "noBreakHyphen" => self.push_text("-"),
            // `w:sym` 是空元素：交给 `on_start` 统一处理，否则占位符写进了正文
            // 却一条提示都没有（"不静默丢失"要求可还原的替换必须说明）。
            "blip" | "imagedata" if self.drawing_depth > 0 => self.request_image(attributes),
            _ => self.on_start(name, attributes),
        }
    }

    fn on_end(&mut self, name: &str) {
        match name {
            "p" => {
                if self.has_paragraph {
                    self.flush_paragraph_now();
                    self.has_paragraph = false;
                }
            }
            "rPr" => {
                // `</w:rPr>` 之后的正文属于这个 run：格式必须保留到 run 结束，
                // 否则加粗 / 斜体 / 删除线全都会被抹平。
                self.in_rpr = false;
            }
            "hyperlink" => self.close_hyperlink(),
            "drawing" | "pict" => self.drawing_depth = self.drawing_depth.saturating_sub(1),
            "txbxContent" => self.textbox_depth = self.textbox_depth.saturating_sub(1),
            "delText" => self.in_del_text = false,
            "instrText" => self.in_instr_text = false,
            "tbl" => {
                if let Some(state) = self.table.as_mut() {
                    if state.nested > 0 {
                        state.nested -= 1;
                        return;
                    }
                }
                if let Some(state) = self.table.take() {
                    self.finish_table(state);
                }
            }
            "tr" => {
                if let Some(state) = self.table.as_mut() {
                    if state.nested == 0 {
                        let row = std::mem::take(&mut state.current_row);
                        state.rows.push(row);
                    }
                }
            }
            "tc" => {
                if let Some(state) = self.table.as_mut() {
                    if state.nested == 0 && state.in_cell {
                        let cell = std::mem::take(&mut state.cell);
                        state.current_row.push(cell.trim().to_owned());
                        state.in_cell = false;
                    }
                }
            }
            _ => {}
        }
    }

    fn on_text(&mut self, value: &str) {
        if value.is_empty() || self.in_del_text || self.in_instr_text || self.in_field_code {
            return;
        }
        let cleaned: String = value
            .chars()
            .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
            .collect();
        self.push_text(&cleaned);
    }

    /// 文本落地到最深的活动缓冲：超链接标签 > 段落 > 丢弃。
    fn push_text(&mut self, value: &str) {
        if value.is_empty() || self.textbox_depth > 0 {
            return;
        }
        let wrapped = wrap_run(value, self.run);
        if let Some(frame) = self.links.last_mut() {
            frame.label.push_str(&wrapped);
            return;
        }
        if !self.has_paragraph {
            return;
        }
        self.paragraph.text.push_str(&wrapped);
    }

    fn hyperlink_target(&mut self, attributes: &HashMap<String, String>) -> String {
        if let Some(id) = attributes
            .get("id")
            .or_else(|| attributes.get("embed"))
            .cloned()
        {
            if let Some(relationship) = self.rels.get(&id) {
                if relationship.external {
                    return sanitize_href(&relationship.target);
                }
                let part = normalize_zip_name(&relationship.target);
                return sanitize_href(&part);
            }
        }
        if let Some(anchor) = attributes.get("anchor").cloned() {
            self.internal_links += 1;
            return format!("#{anchor}");
        }
        self.out.warn("文档里有无目标的超链接，已只保留链接文字。");
        String::new()
    }

    fn close_hyperlink(&mut self) {
        let Some(frame) = self.links.pop() else {
            return;
        };
        let label = if frame.label.trim().is_empty() {
            markdown_escape(&frame.target)
        } else {
            frame.label
        };
        let label = label.replace('[', "(").replace(']', ")");
        let markdown = if frame.target.is_empty() {
            label
        } else {
            format!("[{label}]({})", frame.target)
        };
        if let Some(link) = self.links.last_mut() {
            link.label.push_str(&markdown);
            return;
        }
        if self.has_paragraph {
            self.paragraph.text.push_str(&markdown);
        }
    }

    fn request_image(&mut self, attributes: &HashMap<String, String>) {
        let id = ["embed", "id"]
            .iter()
            .find_map(|key| attributes.get(*key))
            .cloned()
            .unwrap_or_default();
        if id.is_empty() {
            return;
        }
        let Some(relationship) = self.rels.get(&id).cloned() else {
            self.out.warn(format!(
                "图片引用 {id} 在关系表中不存在，该位置只保留正文文字。"
            ));
            return;
        };
        if relationship.external {
            self.out.degrade(format!(
                "外链图片 {id} 未在导入时读取（不访问网络与源目录），正文文字已保留。"
            ));
            return;
        }
        let part = resolve_relative("word/document.xml", &relationship.target)
            .map(|value| normalize_zip_name(&value))
            .unwrap_or_else(|| normalize_zip_name(&relationship.target));
        let extension = part
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mime = image_mime_from_extension(&extension);
        let bytes = match self.media.get(&part) {
            Some(Some(bytes)) => bytes.clone(),
            Some(None) => {
                self.out
                    .degrade(format!("内嵌图片 {part} 超出大小上限或无法解压，已跳过。"));
                return;
            }
            None => {
                self.out
                    .warn(format!("内嵌图片 {part} 不在文档包里，已跳过该位置。"));
                return;
            }
        };
        self.placed_images += 1;
        let alt = if self.drawing_alt.trim().is_empty() {
            format!("文档图片 {}", self.placed_images)
        } else {
            self.drawing_alt.clone()
        };
        let Some(placement) = self.out.place_image(&part, &bytes, mime, &alt) else {
            return;
        };
        self.paragraph.images.push(placement.reference);
        if let Some(link) = self.links.last_mut() {
            link.label.push_str(&placement.markdown);
            return;
        }
        if self.has_paragraph {
            self.paragraph.text.push_str(&placement.markdown);
        }
    }

    /// 段落落地：列表项先进缓冲（连续项合成一个 list 区块），其余按类型落块。
    fn flush_paragraph_now(&mut self) {
        let paragraph = std::mem::take(&mut self.paragraph);
        let text = paragraph.text.trim_matches([' ', '\t', '\n']).to_owned();
        let images = paragraph.images.clone();
        if let Some(state) = self.table.as_mut() {
            if state.nested == 0 {
                if state.in_cell {
                    if !text.is_empty() {
                        if !state.cell.is_empty() {
                            state.cell.push(' ');
                        }
                        state.cell.push_str(&text);
                    }
                    if paragraph.numid.is_some() {
                        self.lists_in_tables += 1;
                    }
                    return;
                }
            }
            return;
        }
        if let (Some(ilvl), Some(numid)) = (paragraph.ilvl, paragraph.numid.clone()) {
            if !text.is_empty() && numid != "0" {
                let marker = self.list_marker(&numid, ilvl);
                let indent = "  ".repeat(ilvl.clamp(0, 8) as usize);
                self.pending_list.push(format!("{indent}{marker} {text}"));
                self.pending_list_images.extend(images);
                return;
            }
        }
        self.flush_pending_list();
        if text.is_empty() && images.is_empty() {
            return;
        }
        if text.is_empty() {
            self.out.block(BlockSpec {
                kind: Kind::Other,
                content: String::new(),
                level: None,
                language: None,
                checked: None,
                images,
            });
            return;
        }
        let (kind, level) = self.block_kind(&paragraph.style);
        self.out.block(BlockSpec {
            kind,
            content: text,
            level,
            language: None,
            checked: None,
            images,
        });
    }

    /// 段落样式 -> 区块类型：先查 styles.xml 的样式名，再退化为样式 id。
    fn block_kind(&mut self, style: &Option<String>) -> (Kind, Option<u64>) {
        let Some(style) = style.clone() else {
            return (Kind::Paragraph, None);
        };
        let name = self.styles.get(&style).cloned().unwrap_or_default();
        let probe = format!("{name} {style}").to_ascii_lowercase();
        if let Some(level) = heading_level(&probe) {
            return (Kind::Heading, Some(level));
        }
        if is_quote_style(&probe) {
            return (Kind::Quote, None);
        }
        (Kind::Paragraph, None)
    }

    fn flush_pending_list(&mut self) {
        if self.pending_list.is_empty() {
            return;
        }
        let content = std::mem::take(&mut self.pending_list).join("\n");
        let images = std::mem::take(&mut self.pending_list_images);
        self.out.block(BlockSpec {
            kind: Kind::List,
            content,
            level: None,
            language: None,
            checked: None,
            images,
        });
    }

    fn list_marker(&mut self, numid: &str, ilvl: i64) -> &'static str {
        let abstract_id = self
            .numbering
            .abstract_by_num
            .get(numid)
            .cloned()
            .unwrap_or_default();
        let format = self
            .numbering
            .formats
            .get(&(abstract_id.clone(), ilvl))
            .cloned()
            .or_else(|| self.numbering.formats.get(&(abstract_id, 0)).cloned());
        match format.as_deref() {
            Some("bullet") => "-",
            Some("decimal") | Some("decimalZero") => "1.",
            Some(
                value @ ("lowerLetter" | "upperLetter" | "lowerRoman" | "upperRoman" | "ordinal"
                | "cardinalText" | "ordinalText"),
            ) => {
                self.out.degrade(format!(
                    "编号格式 {value} 在 markdown 列表里没有对应写法，已降级为数字列表。"
                ));
                "1."
            }
            Some(other) => {
                self.out
                    .degrade(format!("未支持的编号格式 {other}，列表按项目符号还原。"));
                "-"
            }
            None => {
                self.out
                    .warn("未找到列表编号定义（numbering.xml 缺失或无对应层级），按项目符号还原。");
                "-"
            }
        }
    }

    fn finish_table(&mut self, state: TableState) {
        let rows: Vec<Vec<String>> = state
            .rows
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|cell| cell.replace('\n', " "))
                    .collect()
            })
            .collect();
        match markdown_table(&rows) {
            Some(source) => {
                self.out.table(source);
            }
            None => self.out.warn("表格没有可还原的单元格内容，已跳过该表格。"),
        }
    }

    /// 文档结束：收尾未闭合的段落 / 列表，并输出聚合提示。
    fn finish(&mut self) {
        if self.has_paragraph {
            self.flush_paragraph_now();
            self.has_paragraph = false;
        }
        self.flush_pending_list();
        if let Some(state) = self.table.take() {
            self.finish_table(state);
        }
        if self.deleted_runs > 0 {
            self.out.degrade(format!(
                "文档含未接受的修订：{} 处被删除的文字未导入（插入内容已保留）。",
                self.deleted_runs
            ));
        }
        if self.merged_cells > 0 {
            self.out.degrade(format!(
                "表格中的合并单元格（{} 处）已展平为普通单元格。",
                self.merged_cells
            ));
        }
        if self.nested_tables > 0 {
            self.out.degrade(format!(
                "嵌套表格（{} 处）已展平为单元格文本。",
                self.nested_tables
            ));
        }
        if self.lists_in_tables > 0 {
            self.out.degrade(format!(
                "表格单元格内的列表（{} 处）已展平为文本。",
                self.lists_in_tables
            ));
        }
        if self.internal_links > 0 {
            self.out.degrade(format!(
                "文档内锚点链接（{} 处）在导入后无法跳转，已保留链接文字。",
                self.internal_links
            ));
        }
    }
}

fn wrap_run(value: &str, run: RunProps) -> String {
    let escaped = markdown_escape(value);
    if escaped.trim().is_empty() || run == RunProps::default() {
        return escaped;
    }
    let mut text = escaped;
    if run.bold {
        text = format!("**{text}**");
    }
    if run.italic {
        text = format!("*{text}*");
    }
    if run.strike {
        text = format!("~~{text}~~");
    }
    text
}

fn truthy(value: Option<&String>) -> bool {
    match value.map(|raw| raw.trim().to_ascii_lowercase()) {
        Some(value) => !matches!(value.as_str(), "" | "0" | "false" | "off" | "none"),
        None => true,
    }
}

/// `Heading 1..6` / `heading1` / 中文版 `标题 1` / 样式 id `1`..`9`。
fn heading_level(probe: &str) -> Option<u64> {
    for level in 1..=6u64 {
        let patterns = [
            format!("heading {level}"),
            format!("heading{level}"),
            format!("标题 {level}"),
            format!("标题{level}"),
            format!("h{level}"),
            format!("标题样式 {level}"),
        ];
        if patterns.iter().any(|pattern| probe.contains(pattern)) {
            return Some(level);
        }
    }
    // 中文版 Word 常把 styleId 写成 "1".."9"，样式名缺失时才用这个兜底。
    let trimmed = probe.trim();
    if matches!(trimmed, "1" | "2" | "3" | "4" | "5" | "6") && !trimmed.is_empty() {
        return trimmed.parse::<u64>().ok();
    }
    if probe.contains("title") || probe.contains("文档标题") {
        return Some(1);
    }
    None
}

fn is_quote_style(probe: &str) -> bool {
    probe.contains("quote") || probe.contains("引用") || probe.contains("block quote")
}

/// 链接目标必须能安全放进 markdown：去掉空白、方括号与裸括号。
fn sanitize_href(value: &str) -> String {
    let cleaned = value
        .trim()
        .replace(['[', ']', '<', '>', '\\', ' '], "")
        .replace('(', "%28")
        .replace(')', "%29");
    cleaned.chars().take(2_000).collect()
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

fn read_relationships(
    archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
    path: &str,
) -> Result<HashMap<String, Relationship>, String> {
    let mut rels: HashMap<String, Relationship> = HashMap::new();
    let Some(index) = find_zip_entry(&mut *archive, path) else {
        return Ok(rels);
    };
    let xml = read_zip_entry(archive, index)?;
    let mut reader = Reader::from_reader(xml.as_slice());
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Empty(event)) | Ok(Event::Start(event)) => {
                if local(event.name().into_inner()) == "Relationship" {
                    let attributes = attributes_of(&event);
                    if let Some(id) = attributes.get("Id") {
                        rels.insert(
                            id.clone(),
                            Relationship {
                                target: attributes.get("Target").cloned().unwrap_or_default(),
                                external: attributes
                                    .get("TargetMode")
                                    .map(|value| value.eq_ignore_ascii_case("external"))
                                    .unwrap_or(false),
                            },
                        );
                    }
                }
            }
            Ok(_) => {}
            Err(error) => return Err(format!("DOCX 关系表无法解析：{error}")),
        }
        buffer.clear();
    }
    Ok(rels)
}

/// `styles.xml`：styleId -> 样式名（解析失败只提示，不影响正文）。
fn read_styles(
    archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
    out: &mut Collector,
) -> HashMap<String, String> {
    let mut styles: HashMap<String, String> = HashMap::new();
    let Some(index) = find_zip_entry(&mut *archive, "word/styles.xml") else {
        out.warn("文档没有 word/styles.xml，标题层级只按段落样式名判断。");
        return styles;
    };
    let xml = match read_zip_entry(archive, index) {
        Ok(xml) => xml,
        Err(error) => {
            out.warn(format!("样式表读取失败，标题层级可能不完整：{error}"));
            return styles;
        }
    };
    let mut reader = Reader::from_reader(xml.as_slice());
    let mut buffer = Vec::new();
    let mut current_id = String::new();
    let mut current_type = String::new();
    let mut current_name = String::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(event)) => {
                let name = local(event.name().into_inner());
                let attributes = attributes_of(&event);
                if name == "style" {
                    current_id = attributes.get("styleId").cloned().unwrap_or_default();
                    current_type = attributes.get("type").cloned().unwrap_or_default();
                    current_name = String::new();
                } else if name == "name" {
                    current_name = attributes.get("val").cloned().unwrap_or_default();
                }
            }
            Ok(Event::End(event)) => {
                if local(event.name().into_inner()) == "style"
                    && current_type == "paragraph"
                    && !current_id.is_empty()
                {
                    styles.insert(current_id.clone(), current_name.clone());
                }
            }
            Ok(_) => {}
            Err(error) => {
                out.warn(format!("样式表解析中断，标题层级可能不完整：{error}"));
                break;
            }
        }
        buffer.clear();
    }
    styles
}

fn read_numbering(
    archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
    out: &mut Collector,
) -> Result<Numbering, String> {
    let mut numbering = Numbering::default();
    let Some(index) = find_zip_entry(&mut *archive, "word/numbering.xml") else {
        out.warn("文档没有 word/numbering.xml，编号列表按项目符号还原。");
        return Ok(numbering);
    };
    let xml = read_zip_entry(archive, index)?;
    let mut reader = Reader::from_reader(xml.as_slice());
    let mut buffer = Vec::new();
    let mut abstract_id = String::new();
    let mut level = 0i64;
    let mut pending_num = String::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(event)) | Ok(Event::Empty(event)) => {
                let name = local(event.name().into_inner());
                let attributes = attributes_of(&event);
                match name.as_str() {
                    "abstractNum" => {
                        abstract_id = attributes.get("abstractNumId").cloned().unwrap_or_default();
                    }
                    "lvl" => {
                        level = attributes
                            .get("ilvl")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(0);
                    }
                    "numFmt" => {
                        let format = attributes.get("val").cloned().unwrap_or_default();
                        if !abstract_id.is_empty() && !format.is_empty() {
                            numbering
                                .formats
                                .insert((abstract_id.clone(), level), format);
                        }
                    }
                    "num" => {
                        pending_num = attributes.get("numId").cloned().unwrap_or_default();
                    }
                    "abstractNumId" => {
                        if !pending_num.is_empty() {
                            numbering.abstract_by_num.insert(
                                pending_num.clone(),
                                attributes.get("val").cloned().unwrap_or_default(),
                            );
                        }
                    }
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(error) => return Err(format!("DOCX 编号定义无法解析：{error}")),
        }
        buffer.clear();
    }
    Ok(numbering)
}

/// 预读 `word/media/*`；超限条目记为 `None`，引用到时才提示。
fn read_media(
    archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
    out: &mut Collector,
) -> Result<HashMap<String, Option<Vec<u8>>>, String> {
    let mut media: HashMap<String, Option<Vec<u8>>> = HashMap::new();
    for index in 0..archive.len() {
        let (name, declared) = match archive.by_index(index) {
            Ok(file) => (normalize_zip_name(file.name()), file.size()),
            Err(_) => continue,
        };
        if !name.starts_with("word/media/") {
            continue;
        }
        if declared > MAX_PART_BYTES as u64 {
            out.degrade(format!("内嵌图片 {name} 解压后超过上限，已跳过。"));
            media.insert(name, None);
            continue;
        }
        match read_zip_entry(archive, index) {
            Ok(bytes) if bytes.len() <= MAX_IMAGE_BYTES => {
                media.insert(name, Some(bytes));
            }
            Ok(bytes) => {
                out.degrade(format!(
                    "内嵌图片 {name} 过大（{} 字节），已跳过。",
                    bytes.len()
                ));
                media.insert(name, None);
            }
            Err(error) => {
                out.warn(format!("内嵌图片 {name} 解压失败：{error}"));
                media.insert(name, None);
            }
        }
    }
    Ok(media)
}

#[cfg(test)]
mod tests;
