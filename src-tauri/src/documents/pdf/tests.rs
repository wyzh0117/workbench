//! PDF 解析测试：样本全部在本文件里按字节合成（不读磁盘、不依赖 `qpdf` / `mutool`
//! 等外部工具，也不要求真实 PDF）。断言聚焦契约：页序与行序、字号判标题、文本显示
//! 操作符、字面量/十六进制字符串、`/ToUnicode` 与字体编码回退、无文本层（扫描件）、
//! 过滤器与对象流，以及"结构坏了必须 `Err` 或如实降级，绝不 panic、绝不静默丢内容"。

use crate::documents::fixtures::{page, pdf_image_only_document, pdf_text_document, truncate_tail};
use crate::documents::{parse_document, ParsedDocument};

// ---------------------------------------------------------------------------
// 字节构造器
// ---------------------------------------------------------------------------

/// 流的对象体：`/Length` 必须写在字典**里面**，否则读取器只能看到一个空字典。
fn stream_bytes(dict_body: &str, payload: &[u8]) -> Vec<u8> {
    let mut body = format!("<< {dict_body} /Length {} >>\nstream\n", payload.len()).into_bytes();
    body.extend_from_slice(payload);
    body.extend_from_slice(b"\nendstream");
    body
}

fn stream_text(dict_body: &str, payload: &str) -> Vec<u8> {
    stream_bytes(dict_body, payload.as_bytes())
}

/// 手搭文档：1 号 catalog、2 号 pages，其余对象按追加顺序编号。
struct PdfDoc {
    objects: Vec<Vec<u8>>,
    kids: Vec<usize>,
}

impl PdfDoc {
    fn new() -> Self {
        PdfDoc {
            objects: vec![Vec::new(), Vec::new()],
            kids: Vec::new(),
        }
    }

    /// 追加任意对象，返回 1 起的对象号。
    fn push(&mut self, body: &[u8]) -> usize {
        self.objects.push(body.to_vec());
        self.objects.len()
    }

    fn push_str(&mut self, body: &str) -> usize {
        self.push(body.as_bytes())
    }

    /// 追加一个流对象，返回对象号。
    fn push_stream(&mut self, dict_body: &str, payload: &str) -> usize {
        self.push(&stream_text(dict_body, payload))
    }

    /// 追加一页，同时登记进 `/Pages /Kids`。
    fn add_page(&mut self, body: &str) -> usize {
        let id = self.push_str(body);
        self.kids.push(id);
        id
    }

    /// 追加一条内容流并包一层页面。
    fn add_text_page(&mut self, content: &str, resources: &str) -> usize {
        let stream = self.push_stream("", content);
        self.add_page(&format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << {resources} >> /Contents {stream} 0 R >>"
        ))
    }

    /// WinAnsi 简单字体：字节按 cp1252 解出，适合拉丁正文。
    fn win_ansi_font(&mut self, base_font: &str) -> usize {
        self.push_str(&format!(
            "<< /Type /Font /Subtype /Type1 /BaseFont /{base_font} /Encoding /WinAnsiEncoding >>"
        ))
    }

    /// 单页 + 一条内容流 + 一个 WinAnsi 字体：多数用例的入口。
    fn add_default_page(&mut self, content: &str, font: usize) -> usize {
        self.add_text_page(
            &format!("/F1 12 Tf\n72 720 Td\n{content}"),
            &format!("/Font << /F1 {font} 0 R >>"),
        )
    }

    fn finish(&self) -> Vec<u8> {
        self.finish_with("/Root 1 0 R")
    }

    /// 收尾并替换 trailer 字典内容（`/Size` 仍自动补齐）：用于 `/AcroForm`、缺
    /// `/Root` 等结构测试。
    fn finish_with(&self, trailer: &str) -> Vec<u8> {
        let kid_refs = self
            .kids
            .iter()
            .map(|id| format!("{id} 0 R"))
            .collect::<Vec<_>>()
            .join(" ");
        let mut objects = self.objects.clone();
        objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>".to_vec();
        objects[1] = format!(
            "<< /Type /Pages /Kids [{kid_refs}] /Count {} >>",
            self.kids.len()
        )
        .into_bytes();
        for slot in &mut objects {
            if slot.is_empty() {
                slot.extend_from_slice(b"<< >>");
            }
        }
        assemble(&objects, trailer)
    }

    /// 单页 + WinAnsi 字体 + 给定正文操作。
    fn single_text(content: &str) -> Vec<u8> {
        let mut doc = PdfDoc::new();
        let font = doc.win_ansi_font("Helvetica");
        doc.add_default_page(content, font);
        doc.finish()
    }
}

/// 把对象体列表拼成完整 PDF：头部 + 对象表 + xref + trailer + `%%EOF`。
fn assemble(objects: &[Vec<u8>], trailer: &str) -> Vec<u8> {
    let mut out = b"%PDF-1.7\n".to_vec();
    // 二进制注释标记：真实 PDF 用它声明"这是二进制文件"。
    out.extend_from_slice(&[0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]);
    let mut offsets: Vec<usize> = Vec::with_capacity(objects.len());
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref_position = out.len();
    let count = objects.len() + 1;
    out.extend_from_slice(format!("xref\n0 {count}\n").as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {count} {trailer} >>\nstartxref\n{xref_position}\n%%EOF\n")
            .as_bytes(),
    );
    out
}

/// 把第 `object_number` 号对象的 xref 偏移改成 `value`：模拟损坏的交叉引用表。
fn corrupt_xref_offset(mut bytes: Vec<u8>, object_number: usize, value: usize) -> Vec<u8> {
    let start = bytes
        .windows(b"\nxref\n".len())
        .position(|window| window == b"\nxref\n")
        .expect("样本必须有交叉引用表")
        + 1;
    let header = bytes[start + b"xref\n".len()..]
        .iter()
        .position(|byte| *byte == b'\n')
        .expect("xref 表头必须有换行");
    let entries = start + b"xref\n".len() + header + 1;
    let entry = entries + object_number * 20;
    let replacement = format!("{value:010} 00000 n \n");
    if bytes.len() < entry + replacement.len() {
        return bytes;
    }
    bytes[entry..entry + replacement.len()].copy_from_slice(replacement.as_bytes());
    bytes
}

/// 用"存储块"（deflate BTYPE=00）打一个合法 zlib 流：本仓库没有把 `flate2`
/// 作为直接依赖，无法在测试里现压；存储块解压后就是原始字节，走的是同一条
/// `FlateDecode` 解压路径。
fn zlib_stored(payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x9C];
    let mut rest = payload;
    loop {
        let chunk = rest.len().min(0xFFFE);
        let last = chunk == rest.len();
        out.push(u8::from(last));
        out.extend_from_slice(&(chunk as u16).to_le_bytes());
        out.extend_from_slice(&(!(chunk as u16)).to_le_bytes());
        out.extend_from_slice(&rest[..chunk]);
        rest = &rest[chunk..];
        if last {
            break;
        }
    }
    out.extend_from_slice(&adler32(payload).to_be_bytes());
    out
}

fn adler32(payload: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for byte in payload {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    b << 16 | a
}

/// PDF 1.5 结构：页树三件套藏在对象流（`/ObjStm`）里，交叉引用只有一张 xref 流。
/// `startxref` 直接指向 xref 流，文件里没有 `trailer` 关键字。
fn xref_stream_document(content: &str) -> Vec<u8> {
    let mut objects: Vec<Vec<u8>> = vec![Vec::new(); 9];
    objects[4] = stream_text("", &format!("/F1 12 Tf\n72 720 Td\n{content}"));
    objects[5] =
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_vec();
    // 对象流里的三个对象：catalog / pages / page。
    let inner: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>".to_vec(),
    ];
    let mut header = String::new();
    let mut relative = 0usize;
    for (index, body) in inner.iter().enumerate() {
        header.push_str(&format!("{} {relative} ", index + 1));
        relative += body.len();
    }
    let mut payload = header.as_bytes().to_vec();
    for body in &inner {
        payload.extend_from_slice(body);
    }
    objects[6] = stream_bytes(
        &format!("/Type /ObjStm /N {} /First {}", inner.len(), header.len()),
        &payload,
    );

    // 先把 1..=7 号对象写出去，才能知道 xref 流自己的字节位置。
    let mut out = b"%PDF-1.5\n".to_vec();
    out.extend_from_slice(&[0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]);
    let mut offsets = vec![0usize; objects.len() + 1];
    for (index, body) in objects.iter().enumerate() {
        if body.is_empty() {
            continue;
        }
        offsets[index + 1] = out.len();
        out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref_position = out.len();
    // W = [1, 2, 1]：类型 / 偏移或容器号 / 代号或组内下标，三行宽度合起来必须
    // 和写入的字节数严格一致，否则整张交叉引用表都会读歪。
    let mut rows: Vec<u8> = Vec::new();
    rows.extend_from_slice(&[0u8, 0, 0, 255]);
    for entry in [
        (2u8, 7u32, 0u32), // catalog：对象流 8 里的第 0 个
        (2, 7, 1),         // pages
        (2, 7, 2),         // page
        (0, 0, 255),       // 空洞
        (1, offsets[5] as u32, 0),
        (1, offsets[6] as u32, 0),
        (1, offsets[7] as u32, 0),
        (1, xref_position as u32, 0),
    ] {
        rows.extend_from_slice(&[entry.0]);
        rows.extend_from_slice(&(entry.1 as u16).to_be_bytes());
        rows.extend_from_slice(&[entry.2 as u8]);
    }
    assert_eq!(rows.len(), 4 * 9, "每行必须是 1 + 2 + 1 = 4 字节");
    let xref_stream = stream_bytes("/Type /XRef /Size 9 /W [1 2 1] /Root 1 0 R", &rows);
    out.extend_from_slice(b"8 0 obj\n");
    out.extend_from_slice(&xref_stream);
    out.extend_from_slice(b"\nendobj\n");
    out.extend_from_slice(format!("startxref\n{xref_position}\n%%EOF\n").as_bytes());
    out
}

// ---------------------------------------------------------------------------
// 断言助手
// ---------------------------------------------------------------------------

fn kinds(parsed: &ParsedDocument) -> Vec<String> {
    parsed
        .blocks
        .iter()
        .map(|block| {
            let kind = block["type"].as_str().unwrap_or_default();
            match block["level"].as_u64() {
                Some(level) => format!("{kind}:{level}"),
                None => kind.to_owned(),
            }
        })
        .collect()
}

fn raw(parsed: &ParsedDocument, index: usize) -> String {
    parsed
        .blocks
        .get(index)
        .and_then(|block| block["raw"].as_str())
        .unwrap_or_default()
        .to_owned()
}

fn text(parsed: &ParsedDocument, index: usize) -> String {
    parsed
        .blocks
        .get(index)
        .and_then(|block| block["text"].as_str())
        .unwrap_or_default()
        .to_owned()
}

fn all_text(parsed: &ParsedDocument) -> String {
    parsed
        .blocks
        .iter()
        .map(|block| {
            format!(
                "{}{}",
                block["raw"].as_str().unwrap_or_default(),
                block["text"].as_str().unwrap_or_default()
            )
        })
        .collect()
}

fn warning_contains(parsed: &ParsedDocument, keyword: &str) -> bool {
    parsed
        .warnings
        .iter()
        .any(|warning| warning.contains(keyword))
}

fn error_of(name: &str, bytes: &[u8]) -> String {
    match parse_document(name, bytes) {
        Ok(parsed) => panic!(
            "期望 Err，实际解析成功：blocks={:?} warnings={:?}",
            parsed.blocks, parsed.warnings
        ),
        Err(error) => error,
    }
}

// ---------------------------------------------------------------------------
// 正常文档
// ---------------------------------------------------------------------------

#[test]
fn pdf_two_pages_keep_page_and_reading_order() {
    // `pdf_text_document` 声明的是 `/Encoding /WinAnsiEncoding`，所以正文按 cp1252
    // 编码；中文必须走 `/ToUnicode`（见 pdf_tounicode_cmap_decodes_cid_codes），
    // 这里用拉丁正文。
    let bytes = pdf_text_document(&[
        page(&[("Chapter One", 20.0), ("Intro to the course", 11.0)]),
        page(&[("Second Page", 17.0), ("Exercises and reading", 11.0)]),
    ]);
    let parsed = parse_document("sample.pdf", &bytes).expect("合法两页文本 PDF 必须解析成功");
    assert_eq!(
        kinds(&parsed),
        vec!["heading:2", "paragraph", "heading:3", "paragraph"],
        "区块必须按页序 + 行序输出：{:?}",
        kinds(&parsed)
    );
    // 20pt 相对 11pt 正文是 1.82 倍 → 2 级标题；raw 的 `#` 个数必须和 level 一致。
    assert_eq!(raw(&parsed, 0), "## Chapter One\n");
    assert_eq!(raw(&parsed, 1), "Intro to the course\n");
    assert_eq!(raw(&parsed, 2), "### Second Page\n");
    assert_eq!(raw(&parsed, 3), "Exercises and reading\n");
    assert_eq!(text(&parsed, 1), "Intro to the course");
    assert_eq!(text(&parsed, 3), "Exercises and reading");
    // 第二页不能跑到第一页前面，也不能和第一页正文粘成一个块。
    assert!(!text(&parsed, 1).contains("Exercises"));
    assert!(parsed.usable_text);
    assert!(!parsed.degraded);
    assert!(parsed.images.is_empty());
    assert!(
        warning_contains(&parsed, "加粗"),
        "粗体来自字体名推断，必须告知：{:?}",
        parsed.warnings
    );
}

#[test]
fn pdf_font_size_thresholds_decide_heading_levels() {
    // 正文主字号（按字符数加权）= 13pt；阈值 13 * 1.25 = 16.25pt。
    // 层级：比值 >=2 -> 1，>=1.6 -> 2，>=1.35 -> 3，其余 -> 4。
    let mut doc = PdfDoc::new();
    let regular = doc.win_ansi_font("Helvetica");
    let bold = doc.win_ansi_font("Helvetica-Bold");
    let content = [
        "BT",
        "/F2 26 Tf\n72 720 Td\n(Title twenty six) Tj",
        "/F1 13 Tf\n72 700 Td\n(Body thirteen size line one) Tj",
        "/F1 13 Tf\n72 686 Td\n(Body thirteen size line two) Tj",
        "/F2 17 Tf\n72 650 Td\n(Subtitle seventeen) Tj",
        "/F2 22 Tf\n72 620 Td\n(Chapter twenty two) Tj",
        "/F2 28 Tf\n72 590 Td\n(Poster twenty eight) Tj",
        "/F2 14 Tf\n72 560 Td\n(Just above body fourteen) Tj",
        "ET",
    ]
    .join("\n");
    let stream = doc.push_stream("", &content);
    doc.add_page(&format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {regular} 0 R /F2 {bold} 0 R >> >> /Contents {stream} 0 R >>"
    ));
    let parsed = parse_document("sample.pdf", &doc.finish()).expect("必须解析成功");
    assert_eq!(
        kinds(&parsed),
        vec![
            "heading:1",
            "paragraph",
            "heading:4",
            "heading:2",
            "heading:1",
            "paragraph"
        ],
        "标题层级必须按实际阈值判定：{:?}",
        kinds(&parsed)
    );
    assert_eq!(raw(&parsed, 0), "# Title twenty six\n");
    assert_eq!(raw(&parsed, 2), "#### Subtitle seventeen\n");
    assert_eq!(raw(&parsed, 3), "## Chapter twenty two\n");
    assert_eq!(raw(&parsed, 4), "# Poster twenty eight\n");
    // 整行都来自 Helvetica-Bold：段落保留加粗语义（与 DOCX 的 `**重点**` 同一约定），
    // 同时靠 warning 说明"加粗是按字体名推断的"。14pt 只比正文大 1.08 倍，不到 1.25 倍
    // 阈值 —— 不该升级成标题，那会毁掉正常排版。
    assert_eq!(raw(&parsed, 5), "**Just above body fourteen**\n");
    assert_eq!(
        raw(&parsed, 1),
        "Body thirteen size line one Body thirteen size line two\n"
    );
    assert!(parsed.usable_text);
    assert!(!parsed.degraded);
}

#[test]
fn pdf_line_breaks_and_paragraph_merging_follow_the_rules() {
    // 同字号的折行拼回一段；句末标点断段；字号变化也断段。
    let bytes = PdfDoc::single_text(
        "(First wrapped line) Tj\n0 -14 Td\n(continues on the next line.) Tj\n0 -14 Td\n(Second paragraph stands alone.) Tj\n0 -14 Td",
    );
    let parsed = parse_document("sample.pdf", &bytes).expect("必须解析成功");
    assert_eq!(kinds(&parsed), vec!["paragraph", "paragraph"]);
    assert_eq!(
        raw(&parsed, 0),
        "First wrapped line continues on the next line\\.\n"
    );
    assert_eq!(raw(&parsed, 1), "Second paragraph stands alone\\.\n");

    // TL + T*：按行距换行，同样只断行不断段。
    let bytes = PdfDoc::single_text(
        "14 TL\n(Line one set with leading) Tj\nT*\n(Line two after T star) Tj\nT*",
    );
    let parsed = parse_document("sample.pdf", &bytes).expect("必须解析成功");
    assert_eq!(kinds(&parsed), vec!["paragraph"]);
    assert_eq!(
        text(&parsed, 0),
        "Line one set with leading Line two after T star"
    );
}

#[test]
fn pdf_show_operators_produce_the_same_visible_text() {
    // Tj、TJ（含字距数字）、'、" 四种显示方式；操作符与字距数字都不许漏进正文。
    let bytes = PdfDoc::single_text(
        "(Plain show) Tj\n0 -14 Td\n[(Kern) -300 (ing) -60 (array)] TJ\n0 -14 Td\n(Prime show) \'\n0 -14 Td\n12 0 (Double quote show) \"\n0 -14 Td",
    );
    let parsed = parse_document("sample.pdf", &bytes).expect("必须解析成功");
    assert_eq!(kinds(&parsed), vec!["paragraph"]);
    // 阈值 -100：-300 算一个空格，-60 只是紧字距，不补空格。
    assert_eq!(
        text(&parsed, 0),
        "Plain show Kern ingarray Prime show Double quote show"
    );
    let joined = all_text(&parsed);
    for noise in ["Tj", "TJ", "300", "-60", "[", "]", "Td", "(", ")"] {
        assert!(!joined.contains(noise), "操作符或字距数字漏进正文：{noise}");
    }
    // 只有足够大的负字距才算一个空格，-60 不算。
    assert!(!text(&parsed, 0).contains("ing array"));
}

#[test]
fn pdf_literal_string_escapes_decode_exactly() {
    let bytes = PdfDoc::single_text(
        "(A\\(B\\)C\\\\D) Tj\n0 -14 Td\n(nested (parens) inside) Tj\n0 -14 Td\n(octal \\101\\050\\051\\41) Tj\n0 -14 Td\n(split\\\ncontinuation) Tj\n0 -14 Td",
    );
    let parsed = parse_document("sample.pdf", &bytes).expect("必须解析成功");
    // 第三行以 `!`（八进制 \41）结尾：句末标点断段，所以续行自成一段。
    assert_eq!(kinds(&parsed), vec!["paragraph", "paragraph"]);
    // `\101\050\051\41` 是八进制的 A ( ) !；`\(` / `\)` / `\\` 是字面括号与反斜杠。
    // 解码后按模块约定把 markdown 控制字符重新转义（`text` 与 `raw` 同为带行内标记的
    // 内容，`raw` 只多块级前缀），所以括号在这里仍然带反斜杠 —— 与 `raw` 一致。
    assert_eq!(
        text(&parsed, 0),
        "A\\(B\\)C\\\\D nested \\(parens\\) inside octal A\\(\\)\\!"
    );
    assert_eq!(text(&parsed, 1), "splitcontinuation");
    // 正文里的 markdown 控制字符必须转义，不能让导入内容变成假标题或假链接。
    assert_eq!(
        raw(&parsed, 0),
        "A\\(B\\)C\\\\D nested \\(parens\\) inside octal A\\(\\)\\!\n"
    );
    assert_eq!(raw(&parsed, 1), "splitcontinuation\n");
}

#[test]
fn pdf_hex_string_decodes_utf16_be_text() {
    // `/Encoding /UniGB-UCS2-H` 是预定义 CMap：代码本身就是 UTF-16BE，
    // 不需要 `/ToUnicode` 也能还原中文。
    let mut doc = PdfDoc::new();
    let cid = doc.push_str(
        "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>",
    );
    doc.push_str(
        "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>",
    );
    doc.add_text_page(
        "/F1 12 Tf\n72 720 Td\n<4E2D6587> Tj\n0 -14 Td\n<4E2D 6587 0> Tj\n0 -14 Td",
        &format!("/Font << /F1 {cid} 0 R >>"),
    );
    let parsed = parse_document("sample.pdf", &doc.finish()).expect("必须解析成功");
    assert_eq!(kinds(&parsed), vec!["paragraph"]);
    // 奇数个十六进制位补 0 得到残缺码元：解不出的字符不写进正文，改为聚合提示。
    assert_eq!(text(&parsed, 0), "中文中文");
    assert_eq!(raw(&parsed, 0), "中文中文\n");
    assert!(parsed.usable_text);
    assert!(
        parsed.degraded,
        "缺映射的字符必须计入未导入，不能静默丢弃：{:?}",
        parsed.warnings
    );
    assert!(
        warning_contains(&parsed, "找不到对应 Unicode"),
        "要说明丢了多少个字符：{:?}",
        parsed.warnings
    );
    assert!(!all_text(&parsed).contains(char::REPLACEMENT_CHARACTER));
}

#[test]
fn pdf_whitespace_is_collapsed_not_dropped() {
    let bytes = PdfDoc::single_text(
        "(two   spaces) Tj\n0 -14 Td\n(leading and trailing   ) Tj\n0 -14 Td\n(tab\tand\r\nnewline) Tj\n0 -14 Td",
    );
    let parsed = parse_document("sample.pdf", &bytes).expect("必须解析成功");
    assert_eq!(kinds(&parsed), vec!["paragraph"]);
    // 连续空白压成一个空格（不是全吃掉），行尾空白由区块层裁剪。
    assert_eq!(
        text(&parsed, 0),
        "two spaces leading and trailing tab and newline"
    );
    assert!(raw(&parsed, 0).ends_with("newline\n"));
    assert!(!raw(&parsed, 0).contains('\t'));
    assert!(!raw(&parsed, 0).contains('\r'));
}

#[test]
fn pdf_tounicode_cmap_decodes_cid_codes() {
    let mut doc = PdfDoc::new();
    let cmap = [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def",
        "/CMapType 2 def",
        "1 begincodespacerange",
        "<0000> <FFFF>",
        "endcodespacerange",
        "2 beginbfchar",
        "<0001> <4E2D>",
        "<0002> <6587>",
        "endbfchar",
        "1 beginbfrange",
        "<0010> <0012> <0061>",
        "endbfrange",
        "endcmap",
        "CMapName currentdict /CMap defineresource pop",
        "end",
        "end",
    ]
    .join("\n");
    let tounicode = doc.push_stream("", &cmap);
    let descendant = doc.objects.len() + 2;
    let cid = doc.push_str(&format!(
        "<< /Type /Font /Subtype /Type0 /BaseFont /TestCID /Encoding /Identity-H /DescendantFonts [{descendant} 0 R] /ToUnicode {} 0 R >>",
        tounicode
    ));
    doc.push_str(
        "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /TestCID /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>",
    );
    doc.add_text_page(
        "/F1 12 Tf\n72 720 Td\n<00010002001000110012> Tj\n0 -14 Td\n<00010002001000110012> ' ",
        &format!("/Font << /F1 {cid} 0 R >>"),
    );
    let parsed = parse_document("sample.pdf", &doc.finish()).expect("必须解析成功");
    assert_eq!(kinds(&parsed), vec!["paragraph"]);
    // bfchar 给 中/文，bfrange 给 a/b/c；两行字号相同、又无句末标点，合成一段。
    // 中英相接不补空格（`needs_space_between` 只在两侧都是 ASCII 字母数字时补）。
    assert_eq!(text(&parsed, 0), "中文abc中文abc");
    assert_eq!(raw(&parsed, 0), "中文abc中文abc\n");
    assert!(!parsed.degraded);
    assert!(parsed.usable_text);
}

#[test]
fn pdf_cid_font_without_tounicode_never_fabricates_text() {
    // `<0041><0042>` 这类 CID 代码如果被按单字节 Standard 编码解，会变成 "AB" ——
    // 那是凭空造出来的正文。契约要求：解不出来就如实说明，并让用户被告知。
    let mut doc = PdfDoc::new();
    let cid = doc.push_str(
        "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [4 0 R] >>",
    );
    doc.push_str(
        "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>",
    );
    doc.add_text_page(
        "/F1 12 Tf\n72 720 Td\n<004100420043> Tj\n0 -14 Td\n<414243> Tj",
        &format!("/Font << /F1 {cid} 0 R >>"),
    );
    let parsed = parse_document("sample.pdf", &doc.finish()).expect("必须解析成功");
    assert!(
        parsed.blocks.is_empty(),
        "不得用错编码硬凑正文：{:?}",
        kinds(&parsed)
    );
    assert!(!parsed.usable_text);
    assert!(parsed.degraded);
    assert!(
        warning_contains(&parsed, "/ToUnicode"),
        "必须说明缺的是什么：{:?}",
        parsed.warnings
    );
    assert!(warning_contains(&parsed, "未导入"));
    let joined = all_text(&parsed);
    assert!(!joined.contains("AB"));
    assert!(!joined.contains('A') && !joined.contains('B'));
}

// ---------------------------------------------------------------------------
// 没有文字层的页面
// ---------------------------------------------------------------------------

#[test]
fn pdf_scanned_document_keeps_only_a_reference() {
    let parsed = parse_document("sample.pdf", &pdf_image_only_document()).expect("扫描件不是错误");
    assert!(!parsed.usable_text, "没有文本层就不是可用正文");
    assert!(parsed.blocks.is_empty());
    assert!(
        parsed.images.is_empty(),
        "PDF 不导入图片：无法确定位置与阅读顺序"
    );
    assert!(parsed.degraded);
    assert!(
        warning_contains(&parsed, "没有可读取的文本层"),
        "必须给出固定文案：{:?}",
        parsed.warnings
    );
    assert!(
        warning_contains(&parsed, "扫描件") && warning_contains(&parsed, "OCR"),
        "必须说明没做 OCR：{:?}",
        parsed.warnings
    );
    assert!(all_text(&parsed).is_empty());
}

#[test]
fn pdf_image_xobject_is_reported_but_not_imported() {
    let mut doc = PdfDoc::new();
    let font = doc.win_ansi_font("Helvetica");
    let image = doc.push(&stream_bytes(
        "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8",
        &[0xFFu8],
    ));
    doc.add_text_page(
        &format!("/F1 12 Tf\n72 720 Td\n(Text next to a picture) Tj\nq 100 0 0 100 72 500 cm /Im1 Do Q\n0 -14 Td"),
        &format!("/Font << /F1 {font} 0 R >> /XObject << /Im1 {image} 0 R >>"),
    );
    let parsed = parse_document("sample.pdf", &doc.finish()).expect("必须解析成功");
    assert_eq!(kinds(&parsed), vec!["paragraph"]);
    assert_eq!(text(&parsed, 0), "Text next to a picture");
    assert!(parsed.images.is_empty());
    assert!(parsed.degraded);
    assert!(
        warning_contains(&parsed, "图片"),
        "内嵌图片被跳过必须告知：{:?}",
        parsed.warnings
    );
    assert!(!all_text(&parsed).contains("!["), "不能编造图片引用");
}

#[test]
fn pdf_blank_page_and_empty_content_stream_are_not_errors() {
    // 整页没有文字操作符：只留 Reference，不当成解析失败。
    let mut doc = PdfDoc::new();
    let font = doc.win_ansi_font("Helvetica");
    let empty = doc.push_stream("", "");
    doc.add_page(&format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >> /Contents {empty} 0 R >>"
    ));
    let parsed = parse_document("sample.pdf", &doc.finish()).expect("空内容流不是错误");
    assert!(parsed.blocks.is_empty());
    assert!(!parsed.usable_text);
    assert!(warning_contains(&parsed, "文本层"));
}

// ---------------------------------------------------------------------------
// 过滤器
// ---------------------------------------------------------------------------

#[test]
fn pdf_flate_decoded_content_stream_is_extracted() {
    let mut doc = PdfDoc::new();
    let font = doc.win_ansi_font("Helvetica");
    let payload = "/F1 12 Tf\n72 720 Td\n(Compressed content stream) Tj\n0 -14 Td";
    let stream = doc.push(&stream_bytes(
        "/Filter /FlateDecode",
        &zlib_stored(payload.as_bytes()),
    ));
    doc.add_page(&format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >> /Contents {stream} 0 R >>"
    ));
    let parsed = parse_document("sample.pdf", &doc.finish()).expect("必须解析成功");
    assert_eq!(kinds(&parsed), vec!["paragraph"]);
    assert_eq!(text(&parsed, 0), "Compressed content stream");
}

#[test]
fn pdf_corrupt_compressed_stream_never_claims_success() {
    // 声明 FlateDecode 但压缩字节是坏的：不 panic、不静默当成空文档。
    let mut doc = PdfDoc::new();
    let font = doc.win_ansi_font("Helvetica");
    let mut broken = zlib_stored(b"(Text that must not appear) Tj");
    let last = broken.len() - 5;
    for byte in &mut broken[8..last] {
        *byte = byte.wrapping_add(0x5A);
    }
    let stream = doc.push(&stream_bytes("/Filter /FlateDecode", &broken));
    doc.add_page(&format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >> /Contents {stream} 0 R >>"
    ));
    let outcome = parse_document("sample.pdf", &doc.finish());
    match outcome {
        Ok(parsed) => {
            assert!(
                !all_text(&parsed).contains("must not appear"),
                "解压失败的内容不得当成正文返回：{:?}",
                parsed.blocks
            );
            assert!(
                parsed.degraded || parsed.warnings.iter().any(|warning| !warning.is_empty()),
                "必须告诉用户这一页没能读出来"
            );
        }
        Err(error) => assert!(error.contains("PDF"), "错误文案必须是中文提示：{error}"),
    }
}

#[test]
fn pdf_unsupported_filter_is_reported_not_skipped_silently() {
    let mut doc = PdfDoc::new();
    let font = doc.win_ansi_font("Helvetica");
    let stream = doc.push(&stream_bytes(
        "/Filter /CCITTFaxDecode",
        b"zwc2:0001,0003;1,24;0,1,0,0,1,24;\n0000!000\"00#000$00%000&00\'000(00)0\n",
    ));
    doc.add_page(&format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >> /Contents {stream} 0 R >>"
    ));
    let outcome = parse_document("sample.pdf", &doc.finish());
    match outcome {
        Ok(parsed) => {
            assert!(
                !parsed.usable_text || parsed.degraded || !parsed.warnings.is_empty(),
                "不支持的过滤器必须有任何一种可见提示：{:?}",
                parsed.warnings
            );
            assert!(
                !parsed.warnings.is_empty() || parsed.degraded,
                "必须提示内容流没能解码：{:?}",
                parsed.blocks
            );
        }
        Err(error) => assert!(error.contains("PDF"), "错误必须是中文提示：{error}"),
    }
}

// ---------------------------------------------------------------------------
// 结构损坏
// ---------------------------------------------------------------------------

#[test]
fn pdf_xref_stream_and_object_stream_documents_are_supported() {
    let bytes = xref_stream_document("(Text reached through an xref stream) Tj");
    let parsed = match parse_document("sample.pdf", &bytes) {
        Ok(parsed) => parsed,
        Err(error) => panic!("lopdf 支持 xref 流与对象流，这类合法 PDF 不该失败：{error}"),
    };
    assert_eq!(kinds(&parsed), vec!["paragraph"]);
    assert_eq!(text(&parsed, 0), "Text reached through an xref stream");
    assert!(parsed.usable_text);
    assert!(!parsed.degraded);
}

#[test]
fn pdf_stream_length_declared_outside_the_dictionary_is_recovered() {
    // `fixtures::PdfWriter` 产出的就是这个形状：`/Length` 落在流字典外面，lopdf 会把
    // 整条流降级成空字典。找回失败时整页正文会凭空消失，只剩一条"这是扫描件"的误导提示。
    let mut doc = PdfDoc::new();
    let font = doc.win_ansi_font("Helvetica");
    let payload = "/F1 12 Tf\n72 720 Td\n(Length outside the dictionary) Tj";
    let stream = doc.push(&stream_bytes_outside_dict(payload));
    doc.add_page(&format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >> /Contents {stream} 0 R >>"
    ));
    let parsed = parse_document("sample.pdf", &doc.finish()).expect("必须解析成功");
    assert_eq!(
        text(&parsed, 0),
        "Length outside the dictionary",
        "流长度声明丢失时要把正文找回来，不能误报成扫描件：{:?}",
        parsed.warnings
    );
    assert!(parsed.usable_text);
    assert!(
        !warning_contains(&parsed, "没有可读取的文本层"),
        "找回正文后不能再报扫描件：{:?}",
        parsed.warnings
    );
}

/// `/Length` 写在流字典**外面**（非法但常见）的对象体。
fn stream_bytes_outside_dict(payload: &str) -> Vec<u8> {
    let mut body = format!("<< >> /Length {}\nstream\n", payload.len()).into_bytes();
    body.extend_from_slice(payload.as_bytes());
    body.extend_from_slice(b"\nendstream");
    body
}

#[test]
fn pdf_form_xobject_content_is_extracted() {
    let mut doc = PdfDoc::new();
    let font = doc.win_ansi_font("Helvetica");
    // Form XObject 自带 `/Resources`：正文藏在表单对象里，很多生成器就是这么写的。
    let form = doc.push(&stream_text(
        &format!(
            "/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >>"
        ),
        "BT /F1 12 Tf 72 700 Td (Text inside a form xobject) Tj ET",
    ));
    doc.add_text_page(
        "q 1 0 0 1 0 0 cm /Fm1 Do Q\n0 -14 Td",
        &format!("/XObject << /Fm1 {form} 0 R >>"),
    );
    let parsed = parse_document("sample.pdf", &doc.finish()).expect("必须解析成功");
    assert_eq!(kinds(&parsed), vec!["paragraph"]);
    assert_eq!(text(&parsed, 0), "Text inside a form xobject");
    assert!(parsed.usable_text);
    assert!(!parsed.degraded);
}

#[test]
fn pdf_non_pdf_and_missing_cross_reference_table_are_errors() {
    assert!(error_of(
        "sample.pdf",
        b"\xE4\xB8\x8D\xE6\x98\xAF\xE4\xB8\x80\xE4\xBB\xBD PDF"
    )
    .contains("PDF"));
    assert!(error_of("sample.pdf", b"%PDF-1.7\n").contains("PDF"));
    assert!(error_of("sample.pdf", b"").contains("PDF"));
    let good = PdfDoc::single_text("(Some text) Tj");
    // 缺 xref 表与 startxref：模拟下载中断。
    let error = error_of("sample.pdf", &truncate_tail(&good, good.len() - 90));
    assert!(error.contains("PDF"), "截断文件必须给出中文错误：{error}");
}

#[test]
fn pdf_damaged_offsets_and_trailers_fail_loudly() {
    let good = PdfDoc::single_text("(Text that cannot be reached) Tj");
    // 内容流对象的 xref 偏移指向文件之外。
    let outside = corrupt_xref_offset(good.clone(), 5, good.len() + 4096);
    let outcome = parse_document("sample.pdf", &outside);
    match outcome {
        Ok(parsed) => assert!(
            !parsed.usable_text,
            "偏移越界不能返回可用正文：{:?}",
            parsed.blocks
        ),
        Err(error) => assert!(error.contains("PDF"), "{error}"),
    }

    // trailer 里没有 /Root：没有任何页面可循。
    let no_root = PdfDoc {
        objects: vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        ],
        kids: Vec::new(),
    };
    let mut doc = no_root;
    let font = doc.win_ansi_font("Helvetica");
    doc.add_default_page("(Unreachable text) Tj", font);
    let bytes = doc.finish_with("/Root 0 0 R");
    assert!(
        error_of("sample.pdf", &bytes).contains("PDF"),
        "坏 /Root 必须失败：{}",
        String::from_utf8_lossy(&bytes)
    );

    // 零页文档。
    let mut empty_doc = PdfDoc::new();
    empty_doc.push_str("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    let error = error_of("sample.pdf", &empty_doc.finish());
    assert!(error.contains("没有页面"), "零页必须给出中文错误：{error}");
}

#[test]
fn pdf_missing_page_and_non_stream_contents_degrade_honestly() {
    // /Pages 指向一个不存在的页对象。
    let mut doc = PdfDoc::new();
    doc.push_str("<< /Type /Pages /Kids [99 0 R] /Count 1 >>");
    // 覆盖 2 号对象：把上面这个字典挪到 2 号位。
    let objects = std::mem::take(&mut doc.objects);
    let mut rebuilt = vec![objects[0].clone(), objects[2].clone()];
    rebuilt.extend_from_slice(&objects[3..]);
    doc.objects = rebuilt;
    doc.kids = vec![2];
    let bytes = assemble(&doc.objects, "/Root 1 0 R");
    let outcome = parse_document("sample.pdf", &bytes);
    match outcome {
        Ok(parsed) => {
            assert!(parsed.blocks.is_empty());
            assert!(
                parsed.degraded || !parsed.warnings.is_empty(),
                "断链的页树必须有任何提示：{:?}",
                parsed.warnings
            );
        }
        Err(error) => assert!(error.contains("PDF"), "{error}"),
    }

    // /Contents 指向一个非流对象（页字典）。
    let mut doc = PdfDoc::new();
    let font = doc.win_ansi_font("Helvetica");
    let other = doc.push_str("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
    doc.add_page(&format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >> /Contents {other} 0 R >>"
    ));
    let outcome = parse_document("sample.pdf", &doc.finish());
    match outcome {
        Ok(parsed) => {
            assert!(!parsed.usable_text, "非流对象不能当正文");
            assert!(all_text(&parsed).is_empty());
            assert!(
                parsed.degraded || !parsed.warnings.is_empty(),
                "必须给出提示：{:?}",
                parsed.warnings
            );
        }
        Err(error) => assert!(error.contains("PDF"), "{error}"),
    }
}

#[test]
fn pdf_stream_length_longer_than_the_file_is_survivable() {
    // 撒谎的 /Length（比文件还长）：不能 panic；要么按对象边界恢复出正文，要么如实报错。
    let mut doc = PdfDoc::new();
    let font = doc.win_ansi_font("Helvetica");
    let payload = "/F1 12 Tf\n72 720 Td\n(Length is a lie) Tj";
    let mut body = format!("<< /Length {} >>\nstream\n", payload.len() + 100_000).into_bytes();
    body.extend_from_slice(payload.as_bytes());
    body.extend_from_slice(b"\nendstream");
    let stream = doc.push(&body);
    doc.add_page(&format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >> /Contents {stream} 0 R >>"
    ));
    let outcome = parse_document("sample.pdf", &doc.finish());
    match outcome {
        Ok(parsed) => {
            if parsed.usable_text {
                assert_eq!(text(&parsed, 0), "Length is a lie");
            } else {
                assert!(
                    parsed.degraded || !parsed.warnings.is_empty(),
                    "恢复失败也必须告知：{:?}",
                    parsed.warnings
                );
            }
        }
        Err(error) => assert!(error.contains("PDF"), "{error}"),
    }
}

// ---------------------------------------------------------------------------
// 上限与其它内容类型
// ---------------------------------------------------------------------------

#[test]
fn pdf_source_over_max_bytes_is_rejected_before_parsing() {
    // 上限 96 MiB：只构造一个刚过线的合法头部（一次分配 + memset，几十毫秒级）。
    let limit = 96 * 1024 * 1024;
    let mut bytes = b"%PDF-1.7\n".to_vec();
    bytes.resize(limit + 1, b' ');
    let error = error_of("sample.pdf", &bytes);
    assert!(
        error.contains("文件过大") && error.contains("96MiB".replace("MiB", "").as_str().trim()),
        "文案要包含上限与实际字节数：{error}"
    );
    assert!(error.contains(&(limit + 1).to_string()), "{error}");
    assert!(error.contains(&limit.to_string()), "{error}");
}

#[test]
fn pdf_form_fields_and_annotations_are_warned_about() {
    let mut doc = PdfDoc::new();
    let font = doc.win_ansi_font("Helvetica");
    let annots = doc.push_str(
        "<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] /A << /S /URI /URI (https://example.invalid/target) >> >>",
    );
    let stream = doc.push_stream("", "/F1 12 Tf\n72 720 Td\n(Body text stays) Tj\n0 -14 Td");
    doc.add_page(&format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >> /Annots [{annots} 0 R] /Contents {stream} 0 R >>"
    ));
    let form =
        doc.push_str("<< /Fields [] /DR << /Font << /Helv 4 0 R >> >> /DA (/Helv 0 Tf 0 g ) >>");
    let bytes = doc.finish_with(&format!("/Root 1 0 R /AcroForm {form} 0 R"));
    let parsed = parse_document("sample.pdf", &bytes).expect("批注与表单只降级不失败");
    assert_eq!(kinds(&parsed), vec!["paragraph"]);
    assert_eq!(text(&parsed, 0), "Body text stays");
    assert!(
        warning_contains(&parsed, "表单"),
        "表单字段未导入要说明：{:?}",
        parsed.warnings
    );
    assert!(
        warning_contains(&parsed, "批注"),
        "批注不属于正文要说明：{:?}",
        parsed.warnings
    );
    assert!(
        !all_text(&parsed).contains("example.invalid"),
        "链接注解的目标地址不得混进正文"
    );
    assert!(parsed.usable_text);
}

#[test]
fn pdf_block_ir_shape_matches_the_contract() {
    let bytes = PdfDoc::single_text("(Heading sized) Tj");
    let parsed = parse_document("sample.pdf", &bytes).expect("必须解析成功");
    assert_eq!(parsed.blocks.len(), 1);
    let block = &parsed.blocks[0];
    for key in [
        "type",
        "raw",
        "text",
        "level",
        "language",
        "checked",
        "imageRefs",
    ] {
        assert!(
            block.get(key).is_some(),
            "区块必须带 IR 字段 {key}：{block}"
        );
    }
    assert_eq!(block["type"], serde_json::json!("paragraph"));
    assert_eq!(block["level"], serde_json::Value::Null);
    assert_eq!(block["language"], serde_json::Value::Null);
    assert_eq!(block["checked"], serde_json::Value::Null);
    assert_eq!(block["imageRefs"], serde_json::json!([]));
    let kinds_seen: Vec<&str> = parsed
        .blocks
        .iter()
        .filter_map(|block| block["type"].as_str())
        .collect();
    for kind in kinds_seen {
        assert!(
            matches!(
                kind,
                "heading" | "paragraph" | "quote" | "code" | "divider" | "table" | "list" | "other"
            ),
            "type 必须是 adopt_markdown_blocks 认识的取值：{kind}"
        );
    }
    assert!(
        parsed
            .images
            .iter()
            .all(|image| !image.ref_name.contains(':')
                && !image.ref_name.contains('\\')
                && !image.ref_name.contains("..")),
        "ref_name 必须是安全相对名"
    );
}
