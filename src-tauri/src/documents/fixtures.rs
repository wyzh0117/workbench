//! 测试专用的合成文档构造器（只在 `cfg(test)` 下编译，见 `mod.rs` 的声明）。
//!
//! 约定：真实样例永远可选、离线可复核，所以 docx / epub / pdf 的测试样本全部在这里
//! 按字节构造 —— 不读磁盘、不联网、不依赖任何外部工具。ZIP 用 `zip` crate 的写出器
//! （deflate），PDF 用一个只认识"对象 + xref + 流"的极简写出器。

use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// 用 deflate 打一个 ZIP 容器（docx / epub 都是 ZIP）。
pub(crate) fn zip_build(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer.start_file(*name, options).expect("条目名必须合法");
        writer.write_all(bytes).expect("写入内存不该失败");
    }
    writer.finish().expect("收尾必须成功").into_inner()
}

/// 文本版 `zip_build`。
pub(crate) fn zip_build_text(entries: &[(&str, &str)]) -> Vec<u8> {
    zip_build(
        &entries
            .iter()
            .map(|(name, text)| (*name, text.as_bytes()))
            .collect::<Vec<_>>(),
    )
}

/// 把容器尾部截掉：模拟下载中断 / 半截文件。
pub(crate) fn truncate_tail(bytes: &[u8], keep: usize) -> Vec<u8> {
    bytes[..keep.min(bytes.len())].to_vec()
}

/// 看起来像 PNG 的字节（解析层只搬字节，不解码图像）。
pub(crate) fn png_bytes(label: &str) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(label.as_bytes());
    bytes
}

/// 看起来像 JPEG 的字节。
pub(crate) fn jpeg_bytes(label: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0];
    bytes.extend_from_slice(label.as_bytes());
    bytes.push(0xFF);
    bytes.push(0xD9);
    bytes
}

/// 只保留字母数字与空格，避免测试里的 XML 文本把 markdown 控制符搅乱。
pub(crate) fn xml_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .collect()
}

/// 合法字面量内容：括号与反斜杠必须转义。
pub(crate) fn pdf_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 4);
    out.push('(');
    for character in value.chars() {
        match character {
            '(' | ')' | '\\' => {
                out.push('\\');
                out.push(character);
            }
            '\n' | '\r' | '\t' => out.push(' '),
            control if control.is_control() => {}
            other => out.push(other),
        }
    }
    out.push(')');
    out
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/// `word/document.xml` 的外壳。
pub(crate) fn docx_document(body: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>{body}</w:body></w:document>"#
    )
}

/// DOCX 的最小骨架（正文 + 关系表）；`extra` 追加 media / styles / numbering 等。
pub(crate) fn docx_build(document_xml: &str, rels: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
    let mut entries: Vec<(&str, Vec<u8>)> = vec![
        (
            "[Content_Types].xml",
            concat!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">"#,
                r#"<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>"#,
                r#"<Default Extension="xml" ContentType="application/xml"/>"#,
                r#"<Default Extension="png" ContentType="image/png"/>"#,
                r#"<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>"#,
                r#"</Types>"#
            )
            .as_bytes()
                .to_vec(),
        ),
        (
            "_rels/.rels",
            concat!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
                r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>"#,
                r#"</Relationships>"#
            )
            .as_bytes()
                .to_vec(),
        ),
        ("word/document.xml", document_xml.as_bytes().to_vec()),
        ("word/_rels/document.xml.rels", rels.as_bytes().to_vec()),
    ];
    for (name, bytes) in extra {
        entries.push((name, bytes.to_vec()));
    }
    zip_build(
        &entries
            .iter()
            .map(|(name, bytes)| (*name, bytes.as_slice()))
            .collect::<Vec<_>>(),
    )
}

/// `w:rPr` 一类的行内格式。
pub(crate) fn docx_run(text: &str, props: &str) -> String {
    if props.is_empty() {
        format!(r#"<w:r><w:t xml:space="preserve">{text}</w:t></w:r>"#)
    } else {
        format!(r#"<w:r><w:rPr>{props}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>"#)
    }
}

/// 一个段落（可选 `w:pPr`）。
pub(crate) fn docx_paragraph(props: &str, runs: &str) -> String {
    if props.is_empty() {
        format!(r#"<w:p>{runs}</w:p>"#)
    } else {
        format!(r#"<w:p><w:pPr>{props}</w:pPr>{runs}</w:p>"#)
    }
}

/// 一张内嵌图的 drawing 结构（`r:embed` 指向 rels 里的关系 id）。
pub(crate) fn docx_image(embed_id: &str, descr: &str) -> String {
    format!(
        concat!(
            r#"<w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/>"#,
            r#"<wp:docPr id="7" name="Picture 7" descr="{descr}"/>"#,
            r#"<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">"#,
            r#"<pic:pic><pic:nvPicPr><pic:cNvPr id="7" name="{descr}"/><pic:cNvPicPr/></pic:nvPicPr>"#,
            r#"<pic:blipFill><a:blip r:embed="{embed_id}"/></pic:blipFill>"#,
            r#"<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm></pic:spPr>"#,
            r#"</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#
        ),
        descr = descr,
        embed_id = embed_id
    )
}

/// 文本框（`w:txbxContent`）：规格里明确不导入，只该产生提示。
pub(crate) fn docx_textbox(paragraphs: &str) -> String {
    format!(
        concat!(
            r#"<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml">"#,
            r#"<v:textbox><w:txbxContent>{paragraphs}</w:txbxContent></v:textbox>"#,
            r#"</v:shape></w:pict></w:r></w:p>"#
        ),
        paragraphs = paragraphs
    )
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

/// 一本三章的书：spine 顺序与文件名字母序**故意不同**，用来证明按 spine 走。
pub(crate) fn epub_build(opf: &str, chapters: &[(&str, &str)], extra: &[(&str, &[u8])]) -> Vec<u8> {
    let mut entries: Vec<(&str, Vec<u8>)> = vec![
        ("mimetype", b"application/epub+zip".to_vec()),
        (
            "META-INF/container.xml",
            concat!(
                r#"<?xml version="1.0" encoding="UTF-8"?>"#,
                r#"<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">"#,
                r#"<rootfiles><rootfile full-path="OEBPS/content.opf" "#,
                r#"media-type="application/oebps-package+xml"/></rootfiles></container>"#
            )
            .as_bytes()
                .to_vec(),
        ),
        ("OEBPS/content.opf", opf.as_bytes().to_vec()),
    ];
    for (path, xhtml) in chapters {
        entries.push((*path, xhtml.as_bytes().to_vec()));
    }
    for (path, bytes) in extra {
        entries.push((*path, bytes.to_vec()));
    }
    zip_build(
        &entries
            .iter()
            .map(|(name, bytes)| (*name, bytes.as_slice()))
            .collect::<Vec<_>>(),
    )
}

/// XHTML 章节外壳。
pub(crate) fn xhtml(title: &str, body: &str) -> String {
    format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<!DOCTYPE html>"#,
            r#"<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">"#,
            r#"<head><title>{title}</title>"#,
            r#"<link rel="stylesheet" type="text/css" href="../styles/style.css"/></head>"#,
            r#"<body>{body}</body></html>"#
        ),
        title = title,
        body = body
    )
}

/// 一个 OPF：章节按 `ids` 顺序进 spine，另有一张图与一个 CSS。
pub(crate) fn opf_package(items: &[(&str, &str, &str)], image: &str, css: &str) -> String {
    let mut manifest = String::new();
    let mut spine = String::new();
    for (id, href, media_type) in items {
        manifest.push_str(&format!(
            r#"<item id="{id}" href="{href}" media-type="{media_type}"/>"#,
            id = id,
            href = href,
            media_type = media_type
        ));
        spine.push_str(&format!(r#"<itemref idref="{id}"/>"#, id = id));
    }
    manifest.push_str(&format!(
        r#"<item id="cover" href="{href}" media-type="image/png"/>"#,
        href = image
    ));
    manifest.push_str(&format!(
        r#"<item id="css" href="{href}" media-type="text/css"/>"#,
        href = css
    ));
    format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">"#,
            r#"<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:test</dc:identifier><dc:title>测试讲义</dc:title></metadata>"#,
            r#"<manifest>{manifest}</manifest><spine>{spine}</spine></package>"#
        ),
        manifest = manifest,
        spine = spine
    )
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/// 一页正文：`(文本, 字号)` 的有序列表，一行一个显示操作符。
pub(crate) type PdfPage = Vec<(String, f32)>;

/// 极简 PDF 写出器：够 lopdf 建出对象树与 xref，不做任何美化。
struct PdfWriter {
    objects: Vec<Vec<u8>>,
}

impl PdfWriter {
    fn new() -> Self {
        PdfWriter {
            objects: Vec::new(),
        }
    }

    /// 占位（前向引用用），返回 1 起的对象号。
    fn reserve(&mut self) -> usize {
        self.objects.push(Vec::new());
        self.objects.len()
    }

    fn set(&mut self, number: usize, body: Vec<u8>) {
        if let Some(slot) = self.objects.get_mut(number - 1) {
            *slot = body;
        }
    }

    /// 未压缩流（无 `/Filter`）：lopdf 直接返回原始字节。
    fn stream(&mut self, dict: &str, content: &[u8]) -> usize {
        let mut body = format!("{dict} /Length {}\nstream\n", content.len()).into_bytes();
        body.extend_from_slice(content);
        body.extend_from_slice(b"\nendstream\nendobj");
        self.objects.push(body);
        self.objects.len()
    }

    /// 写出 `%PDF` 头 + 对象表 + xref + trailer + `%%EOF`。
    fn finish(mut self, root: usize) -> Vec<u8> {
        // 先补没填的空对象，免得 xref 少一项。
        for slot in &mut self.objects {
            if slot.is_empty() {
                *slot = b"<< /Type /Annots >>".to_vec();
            }
        }
        let mut out = b"%PDF-1.7\n".to_vec();
        // 二进制注释标记：真实 PDF 用它表示"这是二进制文件"。
        out.extend_from_slice(&[0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]);
        let mut offsets: Vec<usize> = Vec::with_capacity(self.objects.len());
        for (index, body) in self.objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref_position = out.len();
        let count = self.objects.len() + 1;
        out.extend_from_slice(format!("xref\n0 {count}\n").as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {count} /Root {root} 0 R >>\nstartxref\n{xref_position}\n%%EOF\n"
            )
            .as_bytes(),
        );
        out
    }
}

/// 把一页 `(文本, 字号)` 渲染成内容流：每行一组 `Tf` + `Td` + `Tj`。
fn content_stream(lines: &[(String, f32)]) -> String {
    let mut stream = String::from("BT\n");
    let mut y = 720i32;
    for (text, size) in lines {
        let font = if *size >= 16.0 { "F2" } else { "F1" };
        stream.push_str(&format!("/{font} {size} Tf\n72 {y} Td\n"));
        stream.push_str(&format!("({}) Tj\n", escape_pdf_literal(text)));
        y = y.saturating_sub((*size + 4.0).round() as i32);
    }
    stream.push_str("ET\n");
    stream
}

fn escape_pdf_literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '(' | ')' | '\\' => {
                out.push('\\');
                out.push(character);
            }
            '\n' | '\r' | '\t' => out.push(' '),
            value if value.is_control() => {}
            value => out.push(value),
        }
    }
    out
}

/// 文本层 PDF：每页一个内容流，两个字体（正文 / 大号粗体）。
pub(crate) fn pdf_text_document(pages: &[PdfPage]) -> Vec<u8> {
    let mut pdf = PdfWriter::new();
    let catalog = pdf.reserve();
    let pages_id = pdf.reserve();
    let font_regular = pdf.stream(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"",
    );
    let font_bold = pdf.stream(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        b"",
    );
    let mut kids: Vec<usize> = Vec::new();
    for page in pages {
        let stream = pdf.stream("<< >>", content_stream(page).as_bytes());
        let page_id = pdf.reserve();
        kids.push(page_id);
        let resources = format!(
            "<< /Font << /F1 {regular} 0 R /F2 {bold} 0 R >> >>",
            regular = font_regular,
            bold = font_bold
        );
        pdf.set(
            page_id,
            format!(
                "<< /Type /Page /Parent {pages} 0 R /MediaBox [0 0 612 792] /Resources {resources} /Contents {stream} 0 R >>",
                pages = pages_id,
                resources = resources,
                stream = stream
            )
            .into_bytes(),
        );
    }
    let kid_refs = kids
        .iter()
        .map(|id| format!("{id} 0 R"))
        .collect::<Vec<_>>()
        .join(" ");
    pdf.set(
        pages_id,
        format!(
            "<< /Type /Pages /Kids [{kid_refs}] /Count {count} >>",
            kid_refs = kid_refs,
            count = kids.len()
        )
        .into_bytes(),
    );
    pdf.set(
        catalog,
        format!("<< /Type /Catalog /Pages {pages_id} 0 R >>").into_bytes(),
    );
    pdf.finish(catalog)
}

/// 图片页 PDF：只有一个 `/Image` XObject，内容流里没有任何文字操作符。
pub(crate) fn pdf_image_only_document() -> Vec<u8> {
    let mut pdf = PdfWriter::new();
    let catalog = pdf.reserve();
    let pages_id = pdf.reserve();
    // 1x1 的灰点位图：内容是什么不重要，重要的是"没有文本操作符"。
    let image = pdf.stream(
        "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 >>",
        &[0xFFu8],
    );
    let stream = pdf.stream("<< >>", b"q 612 0 0 792 0 0 cm /Im1 Do Q\n");
    let page_id = pdf.reserve();
    pdf.set(
        page_id,
        format!(
            "<< /Type /Page /Parent {pages} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 {image} 0 R >> >> /Contents {stream} 0 R >>",
            pages = pages_id,
            image = image,
            stream = stream
        )
        .into_bytes(),
    );
    pdf.set(
        pages_id,
        format!("<< /Type /Pages /Kids [{page_id} 0 R] /Count 1 >>").into_bytes(),
    );
    pdf.set(
        catalog,
        format!("<< /Type /Catalog /Pages {pages_id} 0 R >>").into_bytes(),
    );
    pdf.finish(catalog)
}

/// 单页快捷构造。
pub(crate) fn page(lines: &[(&str, f32)]) -> PdfPage {
    lines
        .iter()
        .map(|(text, size)| ((*text).to_owned(), *size))
        .collect()
}
