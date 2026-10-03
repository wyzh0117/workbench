//! `.pdf`：文本层提取。
//!
//! 分工（以及为什么这样选）：
//! - **lopdf 只负责对象层**：交叉引用表 / xref 流 / 对象流 / 各种过滤器 / `/ToUnicode`
//!   与字体编码映射，以及"解压体积上限"这层防护。这套东西手写不现实。
//! - **内容流（content stream）的操作符走查由本模块手写的词法器完成**：
//!   1) lopdf 0.45 的 `parser` 模块是私有的，没有公开的 `Content::decode`，自带的
//!      `extract_text*` 又把文字摊平成一条字符串、丢掉字号；
//!   2) 而"字号明显更大 + 行很短"是 PDF 里唯一可靠的标题信号，必须自己拿操作符序列。
//! - 位置只用来判行边界（`Td` / `TD` / `Tm` / `T*` / `'`），不做二维排序：多栏页面按
//!   坐标排序很容易把阅读顺序排错，因此严格按"页序 + 内容流顺序"输出。
//! - 会递归进入 Form XObject（很多生成器把正文放在表单对象里），深度、数量与体积都有上限。
//! - `/Length` 缺失或写错（甚至写在流字典外面）时，lopdf 只会留下字典、整条流连同正文一起
//!   消失。这类损坏 PDF 很常见，因此本模块会按 xref 给出的对象位置回到原始字节，用
//!   `stream` / `endstream` + `endobj` 的对象边界把内容找回来（见 `recover_stream`）。
//!   `/Contents` 的候选对象也由本模块自己解析（`page_content_ids`）：lopdf 的
//!   `get_page_contents` 恰好会把这类"降级成字典"的流对象过滤掉，拿不到候选号。
//! - 字符串里的空白控制符（`\t` `\n` `\r` `\u{C}`）在单字节编码表里没有对应字形，会被
//!   整字节丢弃、把相邻词粘在一起，因此先归一成空格（多字节 / CMap 编码不做此替换）。
//!   解码失败的占位符 U+FFFD 计入"未导入"提示，绝不写进正文。
//!
//! 明确不做：不做 OCR（没有文本层就只保留 Reference，并给出固定提示）、不导入图片
//! （无法可靠确定位置与阅读顺序）、不导入表单字段与批注、不执行任何 PDF 内嵌脚本或
//! JavaScript。

use super::{markdown_escape, BlockSpec, Collector, Kind};
use lopdf::content::Operation;
use lopdf::xref::XrefEntry;
use lopdf::{
    DecompressError, Dictionary, Document, Encoding, Error, LoadOptions, Object, ObjectId, Stream,
    StringFormat,
};
use std::borrow::Cow;
use std::collections::BTreeMap;

/// 单页 `/Contents` 解压后的上限（压缩炸弹防护）。
const MAX_PAGE_CONTENT: usize = 24 * 1024 * 1024;
/// 单页内容（含递归进来的 Form XObject）解压总量上限。
const MAX_PAGE_TOTAL: usize = 48 * 1024 * 1024;
/// 单个 Form XObject 内容流的上限。
const MAX_FORM_CONTENT: usize = 8 * 1024 * 1024;
/// 单个对象流（如 `/ToUnicode` CMap）解压后的上限。
const MAX_OBJECT_STREAM: usize = 16 * 1024 * 1024;
/// 最多处理的页数。
const MAX_PAGES: usize = 4_000;
/// 暂存在内存里的正文字符上限（超过即停止收集并提示）。
const MAX_STORED_CHARS: usize = 6_000_000;
/// 单条内容流的操作符上限（恶意 / 畸形文件的止损）。
const MAX_OPERATIONS: usize = 4_000_000;
/// Form XObject 递归深度上限。
const MAX_FORM_DEPTH: usize = 4;
/// 单页递归的 Form XObject 数量上限。
const MAX_FORMS_PER_PAGE: usize = 300;
/// 数组 / 字典的嵌套深度上限。
const MAX_NESTING: usize = 12;
/// 单个数组 / 字典的元素上限。
const MAX_ITEMS: usize = 8_192;
/// 单个字符串 token 的软上限（防止畸形 token 吃掉内存）。
const MAX_TOKEN_BYTES: usize = 4 * 1024 * 1024;
/// 标题判定：字号至少是正文字号的 1.25 倍。
const HEADING_SIZE_RATIO: f32 = 1.25;
/// 标题判定：行长上限（标题不是一整段）。
const HEADING_MAX_CHARS: usize = 120;
/// 无文本层时的固定提示（对接层按此文案与用户沟通）。
const NO_TEXT_LAYER: &str = "这个 PDF 没有可读取的文本层，当前只能作为参考文件保留。";
/// 找回丢失流时允许扫描的最大字节数（一个对象体的上限）。
const MAX_STREAM_RECOVERY: usize = MAX_PAGE_CONTENT;
/// 关键字 token：`stream` / `endstream` / `endobj`。
const STREAM_KEYWORD: &[u8] = b"stream";
const ENDSTREAM_KEYWORD: &[u8] = b"endstream";
const ENDOBJ_KEYWORD: &[u8] = b"endobj";

/// 一行文字：未转义的正文 + 判定用的字号 + 整行是否加粗。
#[derive(Clone, Debug)]
struct Line {
    text: String,
    size: f32,
    bold: bool,
}

/// 全文档统计，用于聚合提示（绝不逐处刷屏）。
#[derive(Default)]
struct Stats {
    pages: Vec<Vec<Line>>,
    page_count: usize,
    blank_pages: usize,
    skipped_pages: usize,
    undecodable: usize,
    replacement_chars: usize,
    font_errors: usize,
    skipped_forms: usize,
    damaged_streams: usize,
    images: usize,
    annotations: usize,
    stored_chars: usize,
    bold_lines: usize,
    truncated: bool,
}

/// 一个字体：可用的编码映射（`None` 表示该字体的文字无法解码）与加粗线索。
struct FontInfo<'a> {
    encoding: Option<Encoding<'a>>,
    bold: bool,
}

type FontMap<'a> = BTreeMap<Vec<u8>, FontInfo<'a>>;

/// 一层资源：`/Resources` 字典（用来查 XObject）与该层自己的字体表。
struct Frame<'a> {
    resources: Vec<&'a Dictionary>,
    fonts: FontMap<'a>,
}

/// 取字体的解码映射：`Ok(None)` 表示"字体声明得清楚、但根本没有可用的 Unicode 映射"。
///
/// CID 字体（`/Subtype /Type0`，或 `/Encoding /Identity-*`）里的代码是字形索引，只有
/// `/ToUnicode` CMap 才能还原成文字；没有它时 lopdf 会退回单字节 Standard 编码，
/// 于是 `<0041><0042>` 这种两个字节的 CID 会被逐字节解成 "AB" —— 那是乱码，不是文字。
/// 这里把它登记成"无法解码"，让聚合提示如实说明缺的是 `/ToUnicode`。
fn font_encoding<'a>(
    document: &'a Document,
    dictionary: &'a Dictionary,
) -> Result<Option<Encoding<'a>>, Error> {
    if cid_without_tounicode(document, dictionary) {
        return Ok(None);
    }
    dictionary
        .get_font_encoding_with_limit(document, MAX_OBJECT_STREAM)
        .map(Some)
}

fn cid_without_tounicode(document: &Document, dictionary: &Dictionary) -> bool {
    let name = |key: &[u8]| {
        dictionary
            .get(key)
            .and_then(Object::as_name)
            .ok()
            .map(|value| value.to_vec())
            .unwrap_or_default()
    };
    let subtype = name(b"Subtype");
    let encoding = name(b"Encoding");
    let cid_keyed =
        subtype == b"Type0" || subtype == b"Type2" || encoding.starts_with(b"Identity-");
    // `UniGB-UCS2-H` 之类的预定义 CMap 直接给出 Unicode 码，不算没有映射。
    if !cid_keyed || encoding.starts_with(b"Uni") {
        return false;
    }
    match dictionary.get(b"ToUnicode") {
        Ok(Object::Reference(id)) => document.get_object(*id).is_err(),
        Ok(Object::Stream(_)) | Ok(Object::Dictionary(_)) => false,
        _ => true,
    }
}

/// 这页里出现过什么（用来判断"到底有没有文本层"）。
#[derive(Default)]
struct Flow {
    text: bool,
}

pub(crate) fn parse_pdf(bytes: &[u8], out: &mut Collector) -> Result<(), String> {
    let options = LoadOptions {
        max_decompressed_size: Some(MAX_OBJECT_STREAM),
        ..Default::default()
    };
    let document = Document::load_mem_with_options(bytes, options)
        .map_err(|error| format!("PDF 结构无法解析（文件损坏、加密或缺少交叉引用表）：{error}"))?;
    if document.is_encrypted() {
        return Err("PDF 已加密（需要口令），未解析正文内容。".to_owned());
    }
    let pages = document.get_pages();
    if pages.is_empty() {
        return Err("PDF 里没有页面对象，无法解析正文。".to_owned());
    }
    if document.trailer.get(b"AcroForm").is_ok() {
        out.warn("PDF 里的表单字段未导入（正文不承载可交互控件）。");
    }
    let mut stats = Stats::default();
    let file = RawFile::new(bytes, &document);
    for (number, page_id) in pages.iter().take(MAX_PAGES) {
        stats.page_count += 1;
        let mut lines = Vec::new();
        let mut flow = Flow::default();
        collect_page(
            &document, &file, *page_id, &mut lines, &mut flow, &mut stats,
        );
        if !flow.text {
            stats.blank_pages += 1;
        }
        stats.pages.push(lines);
        if stats.stored_chars >= MAX_STORED_CHARS {
            stats.truncated = true;
            break;
        }
        let _ = number;
    }
    if pages.len() > stats.page_count {
        out.warn(format!(
            "文档页数超过 {MAX_PAGES}，后续页面未解析（当前已处理 {} 页）。",
            stats.page_count
        ));
    }
    emit(&mut stats, out);
    summarize(out, &stats);
    Ok(())
}

/// 单页：解析字体与内容流，把文本行按内容流顺序追加到 `lines`。
fn collect_page<'a>(
    document: &'a Document,
    file: &RawFile,
    page_id: ObjectId,
    lines: &mut Vec<Line>,
    flow: &mut Flow,
    stats: &mut Stats,
) {
    let mut stack: Vec<Frame<'a>> = vec![root_frame(document, page_id, stats)];
    let content = match document.get_page_content_with_limit(page_id, MAX_PAGE_CONTENT) {
        Ok(content) => content,
        Err(error) => {
            if is_memory_limit(&error) {
                stats.skipped_pages += 1;
            } else {
                stats.damaged_streams += 1;
            }
            return;
        }
    };
    // 一个字节的正文都没有拿到，而这一页确实声明了 `/Contents`：多半是流长度声明
    // 坏了，先按对象边界找回一次，别把有文字的页面误报成扫描件。
    let content = if content.is_empty() {
        recover_page_content(document, file, page_id)
    } else {
        content
    };
    let mut budget = MAX_PAGE_TOTAL.saturating_sub(content.len());
    let mut walked = 0usize;
    run_stream(
        document,
        &mut stack,
        &content,
        lines,
        flow,
        stats,
        &mut budget,
        &mut walked,
        1,
    );
    if let Ok(images) = document.get_page_images(page_id) {
        stats.images += images.len();
    }
    if let Ok(annotations) = document.get_page_annotations(page_id) {
        stats.annotations += annotations.len();
    }
}

/// 原始文件字节 + 按位置排序的对象偏移：只在"流内容整体丢失"时用来找回字节。
struct RawFile<'a> {
    bytes: &'a [u8],
    /// 交叉引用表里所有普通对象的起始偏移（升序、去重），用来把找回扫描限制在
    /// 单个对象体内，绝不把邻居对象当本页正文。
    offsets: Vec<usize>,
}

impl<'a> RawFile<'a> {
    fn new(bytes: &'a [u8], document: &Document) -> Self {
        let mut offsets: Vec<usize> = document
            .reference_table
            .entries
            .values()
            .filter_map(|entry| match entry {
                XrefEntry::Normal { offset, .. } => {
                    Some(usize::try_from(*offset).unwrap_or(usize::MAX))
                }
                _ => None,
            })
            .collect();
        offsets.sort_unstable();
        offsets.dedup();
        RawFile { bytes, offsets }
    }

    /// 对象体的字节范围；压缩进对象流的条目没有文件偏移，返回 `None`。
    fn object_bytes(&self, document: &Document, id: ObjectId) -> Option<&[u8]> {
        let offset = match document.reference_table.entries.get(&id.0)? {
            XrefEntry::Normal { offset, .. } => *offset as usize,
            _ => return None,
        };
        if offset >= self.bytes.len() {
            return None;
        }
        let next = self
            .offsets
            .get(self.offsets.partition_point(|value| *value <= offset))
            .copied()
            .unwrap_or(self.bytes.len())
            .max(offset);
        let end = next.min(offset.saturating_add(MAX_STREAM_RECOVERY));
        self.bytes.get(offset..end)
    }
}

/// 找回整页内容：`/Contents` 可以是一个数组，逐个对象尝试。
///
/// 这里不能用 `Document::get_page_contents`：它只收录"仍然是流"的对象，而本函数正是
/// 为"流被降级成字典"的文件准备的 —— 用它的话候选对象列表恒为空，正文永远找不回来。
fn recover_page_content(document: &Document, file: &RawFile, page_id: ObjectId) -> Vec<u8> {
    let mut content = Vec::new();
    for id in page_content_ids(document, page_id) {
        if content.len() >= MAX_PAGE_CONTENT {
            break;
        }
        if let Some(data) = recover_stream(document, file, id) {
            content.extend_from_slice(&data);
            content.push(b'\n');
        }
    }
    content
}

/// 本页 `/Contents` 引用的对象号（引用、数组、直接对象都算），顺序即拼接顺序。
fn page_content_ids(document: &Document, page_id: ObjectId) -> Vec<ObjectId> {
    const MAX_CONTENT_OBJECTS: usize = 4_096;
    let Ok(page) = document.get_dictionary(page_id) else {
        return Vec::new();
    };
    let Ok(contents) = page.get(b"Contents") else {
        return Vec::new();
    };
    let mut ids: Vec<ObjectId> = Vec::new();
    match contents {
        Object::Reference(id) => ids.push(*id),
        Object::Array(items) => {
            for item in items.iter().take(MAX_CONTENT_OBJECTS) {
                if let Object::Reference(id) = item {
                    ids.push(*id);
                }
            }
        }
        // 内容流直接写在页字典里：对象号就是本页自己。
        Object::Stream(_) => ids.push(page_id),
        _ => {}
    }
    ids
}

/// 从原始字节里找回一条流：lopdf 只有在流字典内找不到 `/Length` 时才会把对象降级成
/// 纯字典（或空内容的流），此时正文按 PDF 32000-1 §7.3.7 的对象边界找回，并按流字典
/// 声明的过滤器解压。边界有歧义、或解压超限都放弃。
fn recover_stream(document: &Document, file: &RawFile, id: ObjectId) -> Option<Vec<u8>> {
    let dict = match document.get_object(id).ok()? {
        Object::Dictionary(dict) => dict.clone(),
        Object::Stream(stream)
            if stream.content.is_empty() && stream.dict.get(b"Length").is_err() =>
        {
            stream.dict.clone()
        }
        _ => return None,
    };
    if dict.get(b"Length").is_ok() {
        // 声明了长度却什么都没有：不是"长度丢失"，不猜。
        return None;
    }
    let body = file.object_bytes(document, id)?;
    let start = stream_data_start(body)?;
    let data = body.get(start..)?;
    let end = find_data_end(data)?;
    let recovered = Stream::new(dict, data.get(..end)?.to_vec());
    let decoded = recovered
        .decompressed_content_with_limit(MAX_STREAM_RECOVERY)
        .ok()?;
    (!decoded.is_empty()).then_some(decoded)
}

/// 定位 `stream` 关键字后的数据起点：关键字后最多跟一段空格/制表符和一个行结束符
/// （PDF 32000-1 §7.3.8.1：行结束符本身不属于正文）。
fn stream_data_start(body: &[u8]) -> Option<usize> {
    let mut cursor = 0usize;
    while let Some(found) = next_keyword(body, cursor, STREAM_KEYWORD) {
        cursor = found + STREAM_KEYWORD.len();
        let mut position = cursor;
        while body
            .get(position)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
        {
            position += 1;
        }
        let eol = match body.get(position) {
            Some(b'\r') if body.get(position + 1) == Some(&b'\n') => 2,
            Some(b'\n') | Some(b'\r') => 1,
            _ => continue,
        };
        return Some(position + eol);
    }
    None
}

/// 数据终点：独占一行、且后面紧跟 `endobj` 的 `endstream`；它前面的行结束符不算正文。
fn find_data_end(window: &[u8]) -> Option<usize> {
    let mut cursor = 0usize;
    while let Some(found) = next_keyword(window, cursor, ENDSTREAM_KEYWORD) {
        cursor = found + ENDSTREAM_KEYWORD.len();
        let data_end = if window[..found].ends_with(b"\r\n") {
            found - 2
        } else if window[..found].ends_with(b"\n") || window[..found].ends_with(b"\r") {
            found - 1
        } else {
            continue;
        };
        let mut position = cursor;
        while window
            .get(position)
            .is_some_and(|byte| is_whitespace(*byte))
        {
            position += 1;
        }
        if window[position..].starts_with(ENDOBJ_KEYWORD) {
            return Some(data_end);
        }
    }
    None
}

/// 下一个完整关键字：前后必须是词法分隔（空白或定界符），且不能是别的 token 的一部分
/// （`endstream` 里含 `stream`，`/Stream` 里也含）。
fn next_keyword(body: &[u8], from: usize, keyword: &[u8]) -> Option<usize> {
    if from >= body.len() {
        return None;
    }
    let mut position = from;
    while let Some(relative) = body[position..]
        .windows(keyword.len())
        .position(|slice| slice == keyword)
    {
        let found = position + relative;
        position = found + keyword.len();
        let before_ok = match found.checked_sub(1).and_then(|index| body.get(index)) {
            None => true,
            Some(byte) => *byte == b'>' || is_whitespace(*byte),
        };
        let after_ok = match body.get(position) {
            None => true,
            Some(byte) => is_whitespace(*byte) || is_delimiter(*byte),
        };
        if before_ok && after_ok {
            return Some(found);
        }
    }
    None
}

/// 页级资源与字体表；只有"解压超限"才放弃整页。
fn root_frame<'a>(document: &'a Document, page_id: ObjectId, stats: &mut Stats) -> Frame<'a> {
    let resources = match document.get_page_resources(page_id) {
        Ok((direct, inherited)) => {
            let mut list: Vec<&'a Dictionary> = direct.into_iter().collect();
            for id in inherited {
                if list.len() < 16 {
                    if let Ok(dict) = document.get_dictionary(id) {
                        list.push(dict);
                    }
                }
            }
            list
        }
        Err(_) => Vec::new(),
    };
    let mut fonts: FontMap<'a> = BTreeMap::new();
    match document.get_page_fonts(page_id) {
        Ok(map) => {
            for (name, dictionary) in map {
                if fonts.len() >= 512 {
                    break;
                }
                let bold = is_bold_font(dictionary);
                match font_encoding(document, dictionary) {
                    Ok(Some(encoding)) => {
                        fonts.insert(
                            name,
                            FontInfo {
                                encoding: Some(encoding),
                                bold,
                            },
                        );
                    }
                    // CID 字体缺 /ToUnicode：文字根本解不出来，登记成"无映射"而不是
                    // 让 lopdf 的 Standard 回退吐出乱码。
                    Ok(None) => {
                        stats.font_errors += 1;
                        fonts.insert(
                            name,
                            FontInfo {
                                encoding: None,
                                bold,
                            },
                        );
                    }
                    Err(error) => {
                        if is_memory_limit(&error) {
                            stats.skipped_pages += 1;
                            return Frame { resources, fonts };
                        }
                        stats.font_errors += 1;
                        fonts.insert(
                            name,
                            FontInfo {
                                encoding: None,
                                bold,
                            },
                        );
                    }
                }
            }
        }
        Err(_) => stats.font_errors += 1,
    }
    Frame { resources, fonts }
}

/// 走查一条内容流；`stack` 顶层是当前生效的资源层，递归时压入子层。
#[allow(clippy::too_many_arguments)]
fn run_stream<'a>(
    document: &'a Document,
    stack: &mut Vec<Frame<'a>>,
    content: &[u8],
    lines: &mut Vec<Line>,
    flow: &mut Flow,
    stats: &mut Stats,
    budget: &mut usize,
    walked: &mut usize,
    depth: usize,
) {
    let mut state = TextState::default();
    let mut lexer = Lexer::new(content);
    let mut operations = 0usize;
    while let Some(operation) = lexer.next_operation() {
        operations += 1;
        if operations > MAX_OPERATIONS {
            stats.truncated = true;
            break;
        }
        if stats.stored_chars >= MAX_STORED_CHARS {
            break;
        }
        let operands = operation.operands.as_slice();
        match operation.operator.as_str() {
            "BT" | "ET" | "Td" | "TD" | "T*" => state.close_line(lines, stats),
            "Tm" => {
                state.close_line(lines, stats);
                state.matrix_scale = matrix_scale(operands);
            }
            "Tf" => {
                state.close_line(lines, stats);
                state.font = operands
                    .first()
                    .and_then(|object| object.as_name().ok().map(|name| name.to_vec()))
                    .unwrap_or_default();
                state.size = operands
                    .get(1)
                    .and_then(|object| object.as_float().ok())
                    .unwrap_or_default()
                    .abs();
            }
            "Tj" | "TJ" => state.show(operands, 0, stack, lines, flow, stats),
            // `'` = `T* Tj`；`"` = `aw Tw string Tj`，文本从第 3 个操作数开始。
            "'" => {
                state.close_line(lines, stats);
                state.show(operands, 0, stack, lines, flow, stats);
            }
            "\"" => state.show(operands, 2, stack, lines, flow, stats),
            "BI" => stats.images += 1,
            "Do" => {
                if depth >= MAX_FORM_DEPTH || *walked >= MAX_FORMS_PER_PAGE {
                    stats.skipped_forms += 1;
                    continue;
                }
                let Some(name) = operands
                    .first()
                    .and_then(|object| object.as_name().ok())
                    .map(|name| name.to_vec())
                else {
                    continue;
                };
                let Some(stream) = find_xobject(document, stack, &name) else {
                    continue;
                };
                if !is_form(stream) {
                    stats.images += 1;
                    continue;
                }
                *walked += 1;
                let Some(data) = form_content(stream, budget) else {
                    stats.skipped_forms += 1;
                    continue;
                };
                let child = child_frame(document, stream, stats);
                stack.push(child);
                run_stream(
                    document,
                    stack,
                    &data,
                    lines,
                    flow,
                    stats,
                    budget,
                    walked,
                    depth + 1,
                );
                stack.pop();
            }
            _ => {}
        }
    }
    state.close_line(lines, stats);
    if lexer.damaged {
        stats.damaged_streams += 1;
    }
}

/// `/XObject` 查找：从最内层资源往外找。
fn find_xobject<'a>(
    document: &'a Document,
    stack: &[Frame<'a>],
    name: &[u8],
) -> Option<&'a Stream> {
    for frame in stack.iter().rev() {
        for resources in &frame.resources {
            let Ok(entry) = resources.get(b"XObject") else {
                continue;
            };
            let Some(map) = resolved_dict(document, entry) else {
                continue;
            };
            let Ok(object) = map.get(name) else {
                continue;
            };
            if let Ok(id) = object.as_reference() {
                if let Ok(stream) = document.get_object(id).and_then(Object::as_stream) {
                    return Some(stream);
                }
            }
            if let Ok(stream) = object.as_stream() {
                return Some(stream);
            }
        }
    }
    None
}

fn is_form(stream: &Stream) -> bool {
    stream
        .dict
        .get(b"Subtype")
        .and_then(Object::as_name)
        .unwrap_or_default()
        == b"Form"
}

/// 子层字体表：只登记 Form 自带 `/Resources` 里的字体，其余沿资源栈往外查。
fn child_frame<'a>(document: &'a Document, stream: &'a Stream, stats: &mut Stats) -> Frame<'a> {
    let own = stream
        .dict
        .get(b"Resources")
        .ok()
        .and_then(|entry| resolved_dict(document, entry));
    let resources: Vec<&'a Dictionary> = own.into_iter().collect();
    let mut fonts: FontMap<'a> = BTreeMap::new();
    if let Some(dict) = own {
        if let Ok(entry) = dict.get(b"Font") {
            if let Some(map) = resolved_dict(document, entry) {
                for (name, value) in map.iter() {
                    if fonts.len() >= 512 {
                        break;
                    }
                    let Some(dictionary) = resolved_dict(document, value) else {
                        continue;
                    };
                    let bold = is_bold_font(dictionary);
                    match font_encoding(document, dictionary) {
                        Ok(Some(encoding)) => {
                            fonts.insert(
                                name.clone(),
                                FontInfo {
                                    encoding: Some(encoding),
                                    bold,
                                },
                            );
                        }
                        Ok(None) => {
                            stats.font_errors += 1;
                            fonts.insert(
                                name.clone(),
                                FontInfo {
                                    encoding: None,
                                    bold,
                                },
                            );
                        }
                        Err(error) => {
                            if is_memory_limit(&error) {
                                stats.skipped_forms += 1;
                                continue;
                            }
                            stats.font_errors += 1;
                            fonts.insert(
                                name.clone(),
                                FontInfo {
                                    encoding: None,
                                    bold,
                                },
                            );
                        }
                    }
                }
            }
        }
    }
    Frame { resources, fonts }
}

/// Form 内容流：在剩余预算内解压，失败返回 `None`（只降级该对象，不失败整篇）。
fn form_content(stream: &Stream, budget: &mut usize) -> Option<Vec<u8>> {
    let limit = (*budget).min(MAX_FORM_CONTENT);
    if limit == 0 {
        return None;
    }
    let data = match stream.decompressed_content_with_limit(limit) {
        Ok(data) => data,
        Err(error) => {
            if is_memory_limit(&error) {
                return None;
            }
            stream.content.clone()
        }
    };
    if data.len() > limit {
        return None;
    }
    *budget = budget.saturating_sub(data.len());
    Some(data)
}

fn resolved_dict<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    match object {
        Object::Reference(id) => document.get_dictionary(*id).ok(),
        Object::Dictionary(dict) => Some(dict),
        _ => None,
    }
}

fn is_bold_font(dictionary: &Dictionary) -> bool {
    let name = String::from_utf8_lossy(
        dictionary
            .get(b"BaseFont")
            .and_then(Object::as_name)
            .unwrap_or_default(),
    )
    .to_ascii_lowercase();
    name.contains("bold") || name.contains("black") || name.contains("heavy")
}

fn matrix_scale(operands: &[Object]) -> f32 {
    let numbers: Vec<f32> = operands
        .iter()
        .take(6)
        .filter_map(|object| object.as_float().ok())
        .map(|value| value.abs())
        .collect();
    if numbers.len() == 6 {
        (numbers[0] + numbers[3]) / 2.0
    } else {
        0.0
    }
}

fn is_memory_limit(error: &Error) -> bool {
    matches!(
        error,
        Error::Decompress(DecompressError::MemoryLimitExceeded { .. })
    )
}

/// 单条内容流的文本状态。字体只记名字，取编码时现查资源栈（不长期持有引用）。
#[derive(Default)]
struct TextState {
    line: String,
    line_size: f32,
    font: Vec<u8>,
    size: f32,
    matrix_scale: f32,
    bold_run: Option<bool>,
}

impl TextState {
    /// 当前有效字号：`Tf` 给 0 时（Type3 / 矩阵缩放）退回 `Tm` 的缩放。
    fn effective_size(&self) -> f32 {
        if self.size > 0.5 {
            self.size
        } else {
            self.matrix_scale
        }
    }

    /// 处理一段显示文本；`skip` 用于 `"` 操作符跳过头两个数字操作数。
    fn show<'a>(
        &mut self,
        operands: &[Object],
        skip: usize,
        stack: &[Frame<'a>],
        lines: &mut Vec<Line>,
        flow: &mut Flow,
        stats: &mut Stats,
    ) {
        flow.text = true;
        let info = find_font(stack, &self.font);
        let bold = info.is_some_and(|info| info.bold);
        for operand in operands.iter().skip(skip) {
            match operand {
                Object::String(bytes, _) => {
                    let decoded = match info.and_then(|info| info.encoding.as_ref()) {
                        Some(encoding) => {
                            let visible = single_byte_whitespace(encoding, bytes);
                            encoding.bytes_to_string(&visible).ok()
                        }
                        None => {
                            stats.undecodable += 1;
                            None
                        }
                    };
                    if let Some(text) = decoded {
                        self.append_text(&text, bold, stats);
                    }
                }
                Object::Array(items) => self.show(items, 0, stack, lines, flow, stats),
                // `TJ` 数组里的负数是字距调整；足够大时等价于一个空格。
                Object::Integer(value) => {
                    if *value <= -100 {
                        self.append_space();
                    }
                }
                Object::Real(value) => {
                    if *value <= -100.0 {
                        self.append_space();
                    }
                }
                _ => {}
            }
        }
    }

    fn append_text(&mut self, text: &str, bold: bool, stats: &mut Stats) {
        // 解码失败的占位符不是文档内容：计入"未导入"，再由 `clean_text` 丢弃，
        // 绝不把 U+FFFD 写进正文（对接层拿到的是聚合提示，不是一个假字符）。
        let placeholders = text.matches(char::REPLACEMENT_CHARACTER).count();
        if placeholders > 0 {
            stats.replacement_chars += placeholders;
        }
        let cleaned = clean_text(text);
        if cleaned.is_empty() {
            return;
        }
        self.line.push_str(&cleaned);
        self.bold_run = Some(match self.bold_run {
            Some(previous) => previous && bold,
            None => bold,
        });
        self.line_size = self.line_size.max(self.effective_size());
        stats.stored_chars = stats.stored_chars.saturating_add(cleaned.chars().count());
    }

    fn append_space(&mut self) {
        if !self.line.is_empty() && !self.line.ends_with(' ') {
            self.line.push(' ');
        }
    }

    fn close_line(&mut self, lines: &mut Vec<Line>, stats: &mut Stats) {
        let text = std::mem::take(&mut self.line).trim_end().to_owned();
        let size = std::mem::replace(&mut self.line_size, 0.0);
        let bold = self.bold_run.take().unwrap_or(false);
        if !text.is_empty() {
            if bold {
                stats.bold_lines += 1;
            }
            lines.push(Line { text, size, bold });
        }
    }
}

fn find_font<'a, 'f>(stack: &'f [Frame<'a>], name: &[u8]) -> Option<&'f FontInfo<'a>> {
    if name.is_empty() {
        return None;
    }
    stack.iter().rev().find_map(|frame| frame.fonts.get(name))
}

/// 单字节编码（与 lopdf 的解码分支一一对应）：一个字节 = 一个字。
/// CID / `ToUnicode` 映射的代码是 1~4 字节，同一个字节的意义完全不同，不能当成空白。
fn is_single_byte_encoding(encoding: &Encoding<'_>) -> bool {
    match encoding {
        Encoding::OneByteEncoding(_)
        | Encoding::Differences(_)
        | Encoding::SimpleEncoding(b"WinAnsiEncoding") => true,
        Encoding::SimpleEncoding(_) | Encoding::UnicodeMapEncoding(_) => false,
    }
}

/// 把内容里的 PDF 空白控制符（IT / LF / FF / CR，§7.2.2 表 1）换成空格再解码。
///
/// 这些字节在字体的单字节编码表里没有对应字形，lopdf 会**整字节丢弃**，于是
/// `(tab\tand)` 解成 `taband`：词与词被粘住，等于静默丢内容。字符串里的换行在
/// PDF 里本来就不是断行（断行靠 `Td` / `T*`），压成空格才是可见文本的语义。
fn single_byte_whitespace<'b>(encoding: &Encoding<'_>, bytes: &'b [u8]) -> Cow<'b, [u8]> {
    if !is_single_byte_encoding(encoding)
        || !bytes
            .iter()
            .any(|byte| matches!(byte, 0x09 | 0x0A | 0x0C | 0x0D))
    {
        return Cow::Borrowed(bytes);
    }
    Cow::Owned(
        bytes
            .iter()
            .map(|byte| {
                if matches!(byte, 0x09 | 0x0A | 0x0C | 0x0D) {
                    b' '
                } else {
                    *byte
                }
            })
            .collect(),
    )
}

/// 去掉控制字符并把连续空白压成一个空格。
fn clean_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for character in text.chars() {
        match character {
            '\u{0}' | '\u{feff}' | '\u{ad}' | char::REPLACEMENT_CHARACTER => continue,
            value if value.is_control() || value.is_whitespace() => {
                if !out.is_empty() {
                    pending_space = true;
                }
            }
            value => {
                if pending_space {
                    out.push(' ');
                    pending_space = false;
                }
                out.push(value);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 内容流词法器（PDF 32000-1 §7.2 词法 + §7.6 操作符）
// ---------------------------------------------------------------------------

fn is_whitespace(byte: u8) -> bool {
    matches!(byte, 0x00 | 0x09 | 0x0A | 0x0C | 0x0D | 0x20)
}

fn is_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn number_object(token: &[u8]) -> Option<Object> {
    if token.is_empty()
        || !token
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'+' | b'-'))
    {
        return None;
    }
    let text = String::from_utf8_lossy(token);
    let trimmed = text.trim_end_matches('.');
    if trimmed.is_empty()
        || trimmed == "+"
        || trimmed == "-"
        || trimmed.chars().all(|value| value == '.')
    {
        return None;
    }
    if !trimmed.contains('.') {
        if let Ok(value) = trimmed.parse::<i64>() {
            return Some(Object::Integer(value));
        }
    }
    trimmed.parse::<f32>().ok().map(Object::Real)
}

/// 词法单元：`None` 载荷的操作符用名字表示。
enum Token {
    Operand(Object),
    Operator(Cow<'static, str>),
    Eof,
}

/// 内容流分词器：只做"对象 / 操作符"两级切分，不做语义解释，也不 panic。
struct Lexer<'a> {
    data: &'a [u8],
    pos: usize,
    /// 语法畸形（截断的字符串、多余的括号等）时置位，供上层聚合提示。
    damaged: bool,
}

impl<'a> Lexer<'a> {
    fn new(data: &'a [u8]) -> Self {
        Lexer {
            data,
            pos: 0,
            damaged: false,
        }
    }

    fn peek(&self, offset: usize) -> Option<u8> {
        self.data.get(self.pos + offset).copied()
    }

    fn skip_trivia(&mut self) {
        loop {
            match self.peek(0) {
                Some(byte) if is_whitespace(byte) => self.pos += 1,
                Some(b'%') => {
                    while let Some(byte) = self.peek(0) {
                        self.pos += 1;
                        if matches!(byte, b'\r' | b'\n') {
                            break;
                        }
                    }
                }
                _ => return,
            }
        }
    }

    /// 取下一个完整操作符（连同它的操作数）。
    fn next_operation(&mut self) -> Option<Operation> {
        let mut operands: Vec<Object> = Vec::new();
        loop {
            match self.next_token() {
                Token::Eof => {
                    if !operands.is_empty() {
                        self.damaged = true;
                    }
                    return None;
                }
                Token::Operand(object) => {
                    if operands.len() < MAX_ITEMS {
                        operands.push(object);
                    } else {
                        self.damaged = true;
                    }
                }
                Token::Operator(name) => {
                    if name == "BI" {
                        if !self.skip_inline_image() {
                            self.damaged = true;
                        }
                        return Some(Operation::new("BI", Vec::new()));
                    }
                    return Some(Operation::new(name.as_ref(), std::mem::take(&mut operands)));
                }
            }
        }
    }

    fn next_token(&mut self) -> Token {
        loop {
            self.skip_trivia();
            let Some(byte) = self.peek(0) else {
                return Token::Eof;
            };
            let object = match byte {
                b'(' => Object::String(self.literal_string(), StringFormat::Literal),
                b'<' if self.peek(1) == Some(b'<') => Object::Dictionary(self.dictionary(0)),
                b'<' => Object::String(self.hex_string(), StringFormat::Hexadecimal),
                b'[' => Object::Array(self.array(0)),
                b']' | b'{' | b'}' => {
                    self.pos += 1;
                    self.damaged = true;
                    continue;
                }
                b'/' => Object::Name(self.name()),
                _ => {
                    let token = self.plain_run();
                    if token.is_empty() {
                        // 任何意外字节都前进一格，绝不原地打转。
                        self.pos += 1;
                        self.damaged = true;
                        continue;
                    }
                    match token {
                        b"true" => Object::Boolean(true),
                        b"false" => Object::Boolean(false),
                        b"null" => Object::Null,
                        _ => {
                            if let Some(object) = number_object(token) {
                                object
                            } else {
                                let name = std::str::from_utf8(token).unwrap_or("<bytes>");
                                return Token::Operator(Cow::Owned(name.to_owned()));
                            }
                        }
                    }
                }
            };
            return Token::Operand(object);
        }
    }

    fn plain_run(&mut self) -> &'a [u8] {
        let start = self.pos;
        let mut count = 0usize;
        while let Some(byte) = self.peek(0) {
            if is_whitespace(byte) || is_delimiter(byte) || count >= 255 {
                break;
            }
            self.pos += 1;
            count += 1;
        }
        &self.data[start..self.pos]
    }

    /// `/Name`：`#XX` 是十六进制转义。
    fn name(&mut self) -> Vec<u8> {
        self.pos += 1;
        let mut out = Vec::with_capacity(16);
        let mut guard = 0usize;
        while let Some(byte) = self.peek(0) {
            if is_whitespace(byte) || is_delimiter(byte) || guard >= 512 {
                break;
            }
            guard += 1;
            self.pos += 1;
            if byte == b'#' {
                if let (Some(high), Some(low)) =
                    (self.hex_digit(self.peek(0)), self.hex_digit(self.peek(1)))
                {
                    out.push(high << 4 | low);
                    self.pos += 2;
                    continue;
                }
                out.push(b'#');
                continue;
            }
            out.push(byte);
        }
        out
    }

    fn hex_digit(&self, byte: Option<u8>) -> Option<u8> {
        match byte? {
            value @ b'0'..=b'9' => Some(value - b'0'),
            value @ b'a'..=b'f' => Some(value - b'a' + 10),
            value @ b'A'..=b'F' => Some(value - b'A' + 10),
            _ => None,
        }
    }

    /// `( ... )`：支持嵌套括号、反斜杠转义与八进制；未闭合时按已读内容收尾并标记畸形。
    fn literal_string(&mut self) -> Vec<u8> {
        self.pos += 1;
        let mut out = Vec::new();
        let mut depth = 1usize;
        while let Some(byte) = self.peek(0) {
            self.pos += 1;
            match byte {
                b'\\' => {
                    let Some(value) = self.peek(0) else { break };
                    self.pos += 1;
                    match value {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(0x08),
                        b'f' => out.push(0x0C),
                        b'(' | b')' | b'\\' => out.push(value),
                        0x0A => {}
                        0x0D => {
                            if self.peek(0) == Some(0x0A) {
                                self.pos += 1;
                            }
                        }
                        digit @ b'0'..=b'7' => {
                            // 八进制转义最多三位（0..511），用 u16 计算再取低 8 位。
                            let mut code = u16::from(digit - b'0');
                            for _ in 0..2 {
                                match self.peek(0) {
                                    Some(next @ b'0'..=b'7') => {
                                        code = (code * 8 + u16::from(next - b'0')) & 0o777;
                                        self.pos += 1;
                                    }
                                    _ => break,
                                }
                            }
                            out.push(code as u8);
                        }
                        other => out.push(other),
                    }
                }
                b'(' => {
                    depth += 1;
                    out.push(b'(');
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return out;
                    }
                    out.push(b')');
                }
                other => out.push(other),
            }
            if out.len() >= MAX_TOKEN_BYTES {
                self.damaged = true;
                break;
            }
        }
        self.damaged = true;
        out
    }

    /// `< ... >`：非十六进制字符忽略，奇数位补 0。
    fn hex_string(&mut self) -> Vec<u8> {
        self.pos += 1;
        let mut out = Vec::new();
        let mut pending: Option<u8> = None;
        while let Some(byte) = self.peek(0) {
            self.pos += 1;
            if byte == b'>' {
                if let Some(high) = pending {
                    out.push(high << 4);
                }
                return out;
            }
            if is_whitespace(byte) || byte == b'%' {
                continue;
            }
            let Some(value) = self.hex_digit(Some(byte)) else {
                self.damaged = true;
                continue;
            };
            match pending.take() {
                Some(high) => out.push(high << 4 | value),
                None => pending = Some(value),
            }
            if out.len() >= MAX_TOKEN_BYTES {
                self.damaged = true;
                break;
            }
        }
        self.damaged = true;
        out
    }

    fn array(&mut self, depth: usize) -> Vec<Object> {
        self.pos += 1;
        let mut out: Vec<Object> = Vec::new();
        if depth >= MAX_NESTING {
            self.damaged = true;
            return out;
        }
        loop {
            self.skip_trivia();
            match self.peek(0) {
                None => {
                    self.damaged = true;
                    return out;
                }
                Some(b']') => {
                    self.pos += 1;
                    return out;
                }
                Some(_) => match self.next_token() {
                    Token::Operand(object) => {
                        if out.len() < MAX_ITEMS {
                            out.push(object);
                        } else {
                            self.damaged = true;
                        }
                    }
                    // 数组里的裸操作符丢掉：内容流数组只允许对象。
                    Token::Operator(_) => self.damaged = true,
                    Token::Eof => {
                        self.damaged = true;
                        return out;
                    }
                },
            }
        }
    }

    fn dictionary(&mut self, depth: usize) -> Dictionary {
        self.pos += 2;
        let mut out = Dictionary::new();
        if depth >= MAX_NESTING {
            self.damaged = true;
            return out;
        }
        loop {
            self.skip_trivia();
            match self.peek(0) {
                None => {
                    self.damaged = true;
                    return out;
                }
                Some(b'>') if self.peek(1) == Some(b'>') => {
                    self.pos += 2;
                    return out;
                }
                Some(b'/') => {
                    let key = self.name();
                    let mut value: Option<Object> = None;
                    let mut nested = 0usize;
                    loop {
                        self.skip_trivia();
                        match self.peek(0) {
                            None => {
                                self.damaged = true;
                                return out;
                            }
                            Some(b'/') | Some(b'>') => break,
                            Some(_) => match self.next_token() {
                                Token::Operand(object) => {
                                    if value.is_none() {
                                        value = Some(object);
                                    } else {
                                        nested += 1;
                                    }
                                }
                                Token::Operator(_) => {
                                    self.damaged = true;
                                    break;
                                }
                                Token::Eof => {
                                    self.damaged = true;
                                    return out;
                                }
                            },
                        }
                    }
                    if nested > 0 {
                        self.damaged = true;
                    }
                    if let (Some(key), Some(object)) = (key.into(), value) {
                        if out.len() < MAX_ITEMS {
                            out.set(key, object);
                        }
                    } else {
                        self.damaged = true;
                    }
                }
                Some(_) => {
                    self.damaged = true;
                    match self.next_token() {
                        Token::Eof => return out,
                        Token::Operand(_) | Token::Operator(_) => {}
                    }
                }
            }
        }
    }

    /// 行内图片：`BI … ID <二进制> EI`。找不到 `EI` 就停在这条流的末尾。
    fn skip_inline_image(&mut self) -> bool {
        loop {
            match self.next_token() {
                Token::Operator(name) if name == "ID" => break,
                Token::Operator(_) | Token::Operand(_) => {}
                Token::Eof => return false,
            }
        }
        while self.pos < self.data.len() {
            if !is_whitespace(self.data[self.pos]) {
                self.pos += 1;
                continue;
            }
            let mut probe = self.pos;
            while matches!(self.data.get(probe), Some(byte) if is_whitespace(*byte)) {
                probe += 1;
            }
            // `EI` 之后必须是空白或定界符（或直接到流末尾），否则是数据里的巧合字节。
            let after = self.data.get(probe + 2).copied();
            let matched = self
                .data
                .get(probe..)
                .is_some_and(|rest| rest.starts_with(b"EI"))
                && match after {
                    None => true,
                    Some(byte) => is_whitespace(byte) || is_delimiter(byte),
                };
            if matched {
                self.pos = probe + 2;
                return true;
            }
            self.pos += 1;
        }
        false
    }
}

// ---------------------------------------------------------------------------
// 第二遍：正文分段 + 标题判定
// ---------------------------------------------------------------------------

/// 正文主字号：按字符数加权的众数（四舍五入到 0.5pt）。
fn body_size(pages: &[Vec<Line>]) -> f32 {
    let mut weights: BTreeMap<i64, usize> = BTreeMap::new();
    for lines in pages {
        for line in lines {
            let chars = line.text.chars().filter(|c| !c.is_whitespace()).count();
            if chars < 2 || line.size <= 0.5 {
                continue;
            }
            *weights.entry((line.size * 2.0).round() as i64).or_default() += chars;
        }
    }
    weights
        .into_iter()
        .max_by_key(|(_, chars)| *chars)
        .map(|(bucket, _)| bucket as f32 / 2.0)
        .unwrap_or_default()
}

fn emit(stats: &mut Stats, out: &mut Collector) {
    let body = body_size(&stats.pages);
    let threshold = if body > 0.5 {
        body * HEADING_SIZE_RATIO
    } else {
        f32::INFINITY
    };
    let pages = std::mem::take(&mut stats.pages);
    for lines in pages {
        let mut paragraph = Paragraph::default();
        for line in &lines {
            if out.text_budget_reached() {
                stats.truncated = true;
                paragraph.flush(out);
                return;
            }
            let text = line.text.trim();
            if text.is_empty() {
                paragraph.flush(out);
                continue;
            }
            let chars = text.chars().count();
            if line.size >= threshold && chars <= HEADING_MAX_CHARS {
                paragraph.flush(out);
                out.heading(heading_level(line.size, body), markdown_escape(text));
                continue;
            }
            if paragraph.breaks_before(text, line.size) {
                paragraph.flush(out);
            }
            paragraph.push(text, line.size, line.bold);
            if ends_paragraph(text) {
                paragraph.flush(out);
            }
        }
        paragraph.flush(out);
    }
}

/// 正在拼接的段落：记录字号与"整段是否加粗"。
#[derive(Default)]
struct Paragraph {
    text: String,
    size: f32,
    bold: bool,
    started: bool,
}

impl Paragraph {
    /// 合并规则：项目符号与字号变化都视为新段落。
    fn breaks_before(&self, text: &str, size: f32) -> bool {
        self.started && (starts_new_item(text) || (self.size - size).abs() > 0.4)
    }

    fn push(&mut self, text: &str, size: f32, bold: bool) {
        if !self.started {
            self.text.push_str(text);
            self.size = size;
            self.bold = bold;
            self.started = true;
            return;
        }
        // 英文断词的行尾连字符直接接上；中英文相接不补空格，ASCII 两侧才补空格。
        if self.text.ends_with('-') && text.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        {
            self.text.pop();
        } else if needs_space_between(&self.text, text) {
            self.text.push(' ');
        }
        self.text.push_str(text);
        self.bold &= bold;
    }

    fn flush(&mut self, out: &mut Collector) {
        let text = self.text.trim().to_owned();
        let bold = self.bold && self.started;
        self.text.clear();
        self.started = false;
        self.bold = false;
        self.size = 0.0;
        if text.is_empty() {
            return;
        }
        let escaped = markdown_escape(&text);
        let content = if bold {
            format!("**{escaped}**")
        } else {
            escaped
        };
        out.block(BlockSpec {
            kind: Kind::Paragraph,
            content,
            ..Default::default()
        });
    }
}

/// 只有两侧都是 ASCII 字母 / 数字时才补空格（中文按换行直接相接）。
fn needs_space_between(previous: &str, next: &str) -> bool {
    previous
        .chars()
        .next_back()
        .is_some_and(|value| value.is_ascii_alphanumeric())
        && next
            .chars()
            .next()
            .is_some_and(|value| value.is_ascii_alphanumeric())
}

/// 行首是不是条目符号 / 编号（用于把列表项拆成独立段落，而不是编造列表结构）。
fn starts_new_item(text: &str) -> bool {
    match text.chars().next() {
        Some('•' | '·' | '◦' | '‣' | '-' | '–' | '*') => true,
        Some('(' | '（' | '[' | '【') => {
            let digits: usize = text
                .chars()
                .skip(1)
                .take_while(|value| value.is_ascii_digit())
                .count();
            digits > 0 && digits <= 3 && matches!(text.chars().nth(1 + digits), Some(')' | '）'))
        }
        _ => {
            let digits: usize = text
                .chars()
                .take_while(|value| value.is_ascii_digit())
                .count();
            if digits == 0 || digits > 3 {
                return false;
            }
            matches!(
                text.chars().nth(digits),
                Some('.' | ')' | '）' | '、' | '．')
            )
        }
    }
}

/// 句末标点表示这一行是完整的句子，不再和下一行合并。
fn ends_paragraph(text: &str) -> bool {
    let trimmed = text.trim_end_matches(['"', '”', '』', '」', ')', '）', ']', '】']);
    match trimmed.chars().next_back() {
        Some('。' | '！' | '？' | '；' | '：' | '…') => true,
        Some('!' | '?' | ';' | ':') => true,
        Some('.') => trimmed
            .chars()
            .nth_back(1)
            .map_or(true, |value| !value.is_ascii_digit()),
        _ => false,
    }
}

fn heading_level(size: f32, body: f32) -> u64 {
    if body <= 0.5 {
        return 1;
    }
    let ratio = size / body;
    if ratio >= 2.0 {
        1
    } else if ratio >= 1.6 {
        2
    } else if ratio >= 1.35 {
        3
    } else {
        4
    }
}

/// 聚合提示：每类降级只出现一次，并带上数量。
fn summarize(out: &mut Collector, stats: &Stats) {
    if stats.skipped_pages > 0 {
        out.warn(format!(
            "{} 页内容无法解压或超过大小上限，这些页未解析（其余页正常）。",
            stats.skipped_pages
        ));
    }
    if stats.damaged_streams > 0 {
        out.warn(format!(
            "{} 条内容流有语法错误，已按可解析的部分提取。",
            stats.damaged_streams
        ));
    }
    if stats.font_errors > 0 {
        out.degrade(format!(
            "{} 个字体没有可用的编码映射（缺 /ToUnicode 等），相应文字未导入。",
            stats.font_errors
        ));
    }
    if stats.undecodable > 0 {
        out.degrade(format!(
            "{} 段文字无法用页面字体表解码，未导入（其余文字已保留）。",
            stats.undecodable
        ));
    }
    if stats.replacement_chars > 0 {
        out.degrade(format!(
            "{} 个字符在字体映射表里找不到对应 Unicode（代码被截断或映射缺失），这些字符未导入。",
            stats.replacement_chars
        ));
    }
    if stats.skipped_forms > 0 {
        out.degrade(format!(
            "{} 个内嵌表单对象超过深度或体积上限，其中内容未导入。",
            stats.skipped_forms
        ));
    }
    if stats.images > 0 {
        out.degrade(format!(
            "PDF 内嵌图片（{} 处）未导入：无法可靠确定位置与阅读顺序，只保留文字内容。",
            stats.images
        ));
    }
    if stats.annotations > 0 {
        out.warn(format!(
            "PDF 批注（{} 处）不属于正文，未导入。",
            stats.annotations
        ));
    }
    if stats.bold_lines > 0 {
        out.warn(format!(
            "{} 行的加粗按字体名推断，范围可能与原文不完全一致。",
            stats.bold_lines
        ));
    }
    if stats.blank_pages > 0 && stats.blank_pages < stats.page_count {
        out.degrade(format!(
            "{} 页没有可读取的文本层（扫描件或纯图片页），这些页未导入文字。",
            stats.blank_pages
        ));
    }
    if stats.truncated {
        out.degrade(format!(
            "文档正文超过 {MAX_STORED_CHARS} 字符的提取上限，后续内容未导入。"
        ));
    }
    if stats.stored_chars == 0 {
        out.degrade(NO_TEXT_LAYER);
        out.warn("未做 OCR（不引入大模型或外部进程），扫描件只能作为参考文件保留。");
    }
}

#[cfg(test)]
mod tests;
