//! DOCX 解析测试：样本全部用 `zip` 写出器现场合成（见 `documents::fixtures`），
//! 不读磁盘、不依赖 Word。断言聚焦契约：区块顺序 / 标题层级 / 行内强调 / 列表 /
//! 表格 / 超链接 / 内嵌图片，以及"单个不支持对象只提示、不整体失败"。

use super::*;
use crate::documents::fixtures::{
    docx_build, docx_document, docx_image, docx_paragraph, docx_run, docx_textbox, png_bytes,
    truncate_tail, zip_build_text,
};
use crate::documents::{parse_document, ParsedDocument};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::json;

const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn styles_xml() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{W_NS}">
<w:style w:type="paragraph" w:styleId="Intro"><w:name w:val="Intro"/>
<w:rPr><w:sz w:val="28"/><w:color w:val="FF0000"/><w:rFonts w:ascii="Calibri"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>"#
    )
}

/// 一级项目符号、二级十进制、三级字母；`numId=1` 指向这份定义。
fn numbering_xml() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="{W_NS}">
<w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/></w:lvl>
<w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:lvlText w:val="%2."/></w:lvl>
<w:lvl w:ilvl="2"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%3."/></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>"#
    )
}

fn rels_xml() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId100" Type="{REL_NS}/hyperlink" Target="https://example.com/a%20b" TargetMode="External"/>
<Relationship Id="rId101" Type="{REL_NS}/image" Target="media/image1.png"/>
<Relationship Id="rId102" Type="{REL_NS}/image" Target="media/pic.jpeg"/>
<Relationship Id="rId103" Type="{REL_NS}/image" Target="../../windows/x.png"/>
</Relationships>"#
    )
}

/// 默认包内附件：样式、编号、两张图。
fn default_parts() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("word/styles.xml", styles_xml().into_bytes()),
        ("word/numbering.xml", numbering_xml().into_bytes()),
        ("word/media/image1.png", png_bytes("第一张图")),
        (
            "word/media/pic.jpeg",
            b"\xFF\xD8\xFF\xE0-jpeg-bytes".to_vec(),
        ),
    ]
}

fn build(body: &str, rels: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
    let document = docx_document(body);
    let parts = default_parts();
    let mut owned: Vec<(&str, &[u8])> = parts
        .iter()
        .map(|(name, bytes)| (*name, bytes.as_slice()))
        .collect();
    owned.extend_from_slice(extra);
    docx_build(&document, rels, &owned)
}

fn parse(body: &str) -> Result<ParsedDocument, String> {
    let bytes = build(body, &rels_xml(), &[]);
    parse_document("course.docx", &bytes)
}

/// 段落属性里的列表定义。
fn list_props(level: i32, num_id: i32) -> String {
    format!(r#"<w:numPr><w:ilvl w:val="{level}"/><w:numId w:val="{num_id}"/></w:numPr>"#)
}

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

#[test]
fn docx_restores_structure_in_document_order() {
    let body = [
        docx_paragraph(r#"<w:pStyle w:val="Heading1"/>"#, &docx_run("课程导论", "")),
        docx_paragraph(r#"<w:pStyle w:val="Heading2"/>"#, &docx_run("小节", "")),
        docx_paragraph(
            r#"<w:pStyle w:val="Intro"/>"#,
            &[
                docx_run("普通", ""),
                docx_run("重点", r#"<w:b/>"#),
                docx_run("与", ""),
                docx_run("强调", r#"<w:i/>"#),
                docx_run("、", ""),
                docx_run("删除", r#"<w:strike/>"#),
                docx_run("。", ""),
            ]
            .join(""),
        ),
        docx_paragraph(&list_props(0, 1), &docx_run("第一条", "")),
        docx_paragraph(&list_props(1, 1), &docx_run("子项", "")),
        docx_paragraph(&list_props(2, 1), &docx_run("孙项", "")),
        docx_paragraph(&list_props(0, 1), &docx_run("第二条", "")),
        format!(
            r#"<w:tbl><w:tr><w:tc><w:p>{}</w:p></w:tc><w:tc><w:p>{}</w:p></w:tc></w:tr>
             <w:tr><w:tc><w:p>{}</w:p></w:tc><w:tc><w:p>{}</w:p></w:tc></w:tr></w:tbl>"#,
            docx_run("名称", ""),
            docx_run("数量", ""),
            docx_run("讲义", ""),
            docx_run("3", ""),
        ),
        docx_paragraph(
            "",
            &format!(
                "{}<w:hyperlink r:id=\"rId100\">{}</w:hyperlink>{}",
                docx_run("看 ", ""),
                docx_run("示例链接", ""),
                docx_run(" 结束", ""),
            ),
        ),
    ]
    .join("");

    let parsed = parse(&body).expect("合法 DOCX 必须解析成功");
    assert_eq!(
        kinds(&parsed),
        vec![
            "heading:1",
            "heading:2",
            "paragraph",
            "list",
            "table",
            "paragraph"
        ],
        "区块必须按文档顺序输出：{:?}",
        kinds(&parsed)
    );
    assert_eq!(raw(&parsed, 0), "# 课程导论\n");
    // 层级来自 styles.xml 的样式名（"heading 2"），不是猜的。
    assert_eq!(raw(&parsed, 1), "## 小节\n");
    let rich = raw(&parsed, 2);
    assert_eq!(rich, "普通**重点**与*强调*、~~删除~~。\n");
    for noise in ["FF0000", "28", "Calibri", "Intro"] {
        assert!(!rich.contains(noise), "字号/颜色/字体名不得进正文：{noise}");
    }
    let list = raw(&parsed, 3);
    assert_eq!(list, "- 第一条\n  1. 子项\n    1. 孙项\n- 第二条\n");
    assert!(parsed
        .warnings
        .iter()
        .any(|warning| warning.contains("lowerLetter")));
    let table = raw(&parsed, 4);
    assert!(table.contains("| 名称 | 数量 |"), "{table}");
    assert!(table.contains("| --- | --- |"), "{table}");
    assert!(table.contains("| 讲义 | 3 |"), "{table}");
    let link = raw(&parsed, 5);
    assert!(
        link.contains("[示例链接](https://example.com/a%20b)"),
        "超链接要经关系表解析：{link}"
    );
    assert!(parsed.usable_text);
    assert!(!all_text(&parsed).contains('<'), "绝不输出 HTML");
}

#[test]
fn docx_embedded_images_follow_document_order() {
    let body = [
        docx_paragraph("", &docx_image("rId101", "第一张")),
        docx_paragraph(
            "",
            &format!("{}{}", docx_run("中间文字", ""), docx_image("rId102", "")),
        ),
        docx_paragraph("", &docx_image("rId101", "再次引用")),
    ]
    .join("");
    let parsed = parse(&body).expect("含图 DOCX 必须解析成功");
    assert_eq!(parsed.images.len(), 2, "同一份图片字节只提取一次");
    assert_eq!(parsed.images[0].ref_name, "document-image-1.png");
    assert_eq!(parsed.images[0].mime, "image/png");
    assert_eq!(parsed.images[1].ref_name, "document-image-2.jpg");
    assert_eq!(parsed.images[1].mime, "image/jpeg");
    assert_eq!(
        BASE64
            .decode(&parsed.images[0].base64)
            .expect("base64 必须可解码"),
        png_bytes("第一张图"),
        "图片字节必须原样搬运"
    );
    assert!(!parsed.images[0].base64.contains('\n'));
    assert_eq!(text(&parsed, 0), "![第一张](document-image-1.png)");
    assert_eq!(
        text(&parsed, 1),
        "中间文字![文档图片 2](document-image-2.jpg)"
    );
    assert_eq!(text(&parsed, 2), "![再次引用](document-image-1.png)");
    let expectations = [
        (0usize, "document-image-1.png", 0usize),
        (1, "document-image-2.jpg", 0),
        (2, "document-image-1.png", 1),
    ];
    for (index, href, occurrence) in expectations {
        let block = &parsed.blocks[index];
        assert_eq!(block["imageRefs"][0]["href"], json!(href));
        assert_eq!(block["imageRefs"][0]["blockIndex"], json!(index));
        assert_eq!(block["imageRefs"][0]["occurrence"], json!(occurrence));
        assert!(
            block["raw"]
                .as_str()
                .unwrap_or_default()
                .contains(&format!("]({href})")),
            "正文里的引用必须与 imageRefs 对得上"
        );
    }
}

#[test]
fn docx_unsupported_object_only_warns_and_keeps_reading() {
    let body = [
        docx_paragraph("", &docx_run("正文段落", "")),
        docx_textbox(&docx_paragraph("", &docx_run("水印文字", ""))),
        format!(
            r#"<w:p><w:r><w:instrText>SECTION \\m</w:instrText></w:r>
             <w:r><w:fldChar w:fldCharType="separate"/></w:r>
             <w:r><w:t>域结果</w:t></w:r></w:p>"#
        ),
        docx_paragraph(
            "",
            &format!(
                "<w:del><w:r><w:delText>被删掉的</w:delText></w:r></w:del>{}",
                docx_run("保留的文字", "")
            ),
        ),
        docx_paragraph(
            "",
            &format!(
                r#"<w:r><w:sym w:font="Wingdings" w:char="F06F"/></w:r>{}"#,
                docx_run("符号之后", "")
            ),
        ),
    ]
    .join("");
    let parsed = parse(&body).expect("单个不支持对象不得让整篇失败");
    let joined = all_text(&parsed);
    assert!(!joined.contains("水印文字"), "文本框内容不进正文");
    assert!(!joined.contains("SECTION"), "域代码不得当正文");
    assert!(joined.contains("域结果"), "域结果要保留");
    assert!(!joined.contains("被删掉的"), "未接受的修订删除内容不导入");
    assert!(joined.contains("保留的文字"));
    assert!(joined.contains("符号之后"));
    for keyword in ["文本框", "修订", "符号"] {
        assert!(
            parsed.warnings.iter().any(|w| w.contains(keyword)),
            "缺少 {keyword} 提示：{:?}",
            parsed.warnings
        );
    }
    assert!(parsed.degraded);
    assert_eq!(parsed.blocks.len(), 4);
    assert_eq!(text(&parsed, 3).trim_start_matches('□'), "符号之后");
}

#[test]
fn docx_table_extras_and_anchor_links_degrade_with_warning() {
    let body = format!(
        r#"<w:tbl>
        <w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p>{}</w:p></w:tc>
        <w:tc><w:p>{}</w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p>{}</w:p></w:tc><w:tc><w:p>{}</w:p></w:tc></w:tr>
        </w:tbl>{}"#,
        docx_run("甲", ""),
        docx_run("乙", ""),
        docx_run("丙", ""),
        docx_run("丁", ""),
        docx_paragraph(
            "",
            &format!(
                "<w:hyperlink w:anchor=\"_Toc1\">{}</w:hyperlink>",
                docx_run("目录跳转", "")
            )
        ),
    );
    let parsed = parse(&body).expect("合并单元格与文档内锚点只降级");
    let table = raw(&parsed, 0);
    assert!(table.starts_with("| 甲 | 乙 |"), "{table}");
    assert!(parsed.degraded);
    assert!(parsed
        .warnings
        .iter()
        .any(|warning| warning.contains("合并单元格")));
    assert!(parsed
        .warnings
        .iter()
        .any(|warning| warning.contains("锚点")));
    assert_eq!(text(&parsed, 1), "[目录跳转](#_Toc1)");
}

#[test]
fn docx_missing_numbering_falls_back_to_bullets() {
    let document = docx_document(
        &[
            docx_paragraph(&list_props(0, 7), &docx_run("无编号定义", "")),
            docx_paragraph(&list_props(0, 0), &docx_run("编号为 0 表示取消列表", "")),
        ]
        .join(""),
    );
    let bytes = docx_build(
        &document,
        &rels_xml(),
        &[("word/styles.xml", styles_xml().as_bytes())],
    );
    let parsed = parse_document("course.docx", &bytes).expect("缺 numbering 也要能读正文");
    assert_eq!(kinds(&parsed), vec!["list", "paragraph"]);
    assert_eq!(raw(&parsed, 0), "- 无编号定义\n");
    assert_eq!(raw(&parsed, 1), "编号为 0 表示取消列表\n");
    assert!(parsed
        .warnings
        .iter()
        .any(|warning| warning.contains("numbering.xml")));
}

#[test]
fn docx_archive_entries_are_data_only() {
    // rId103 的 Target 指向包外相对路径：只能在容器内规范成 `windows/x.png`，
    // 既不能读磁盘，也不能把 `..` 带进正文引用。
    let body = [
        docx_paragraph("", &docx_image("rId103", "越界引用")),
        docx_paragraph("", &docx_run("正文还在", "")),
    ]
    .join("");
    let parsed = parse(&body).expect("引用不存在的图片只提示，不失败");
    assert_eq!(parsed.images.len(), 0);
    assert_eq!(parsed.blocks.len(), 1);
    assert_eq!(raw(&parsed, 0), "正文还在\n");
    assert!(parsed
        .warnings
        .iter()
        .any(|warning| warning.contains("不在文档包里")));
    assert!(!all_text(&parsed).contains(".."));

    // 包里有个名字带 `../` 的条目：也只是数据，不参与解析。
    let tricky = build(
        &docx_paragraph("", &docx_run("正常正文", "")),
        &rels_xml(),
        &[("../../outside.png", b"not-an-image".as_slice())],
    );
    let parsed = parse_document("course.docx", &tricky).expect("怪异条目名不该致命");
    assert_eq!(parsed.blocks.len(), 1);
    assert_eq!(raw(&parsed, 0), "正常正文\n");
    assert!(parsed.images.is_empty());
}

#[test]
fn docx_broken_containers_are_errors_not_panics() {
    let good = build(&docx_paragraph("", &docx_run("内容", "")), &rels_xml(), &[]);
    assert!(parse_document("a.docx", &truncate_tail(&good, 40)).is_err());
    assert!(parse_document("a.docx", b"PK\x03\x04garbage-garbage").is_err());
    assert!(parse_document("a.docx", &zip_build_text(&[("note.txt", "不是 docx")])).is_err());

    // 正文不是 XML：必须 Err，不能 panic，也不能产出半篇文档。
    let bad_xml = docx_build(
        "<<not xml at all",
        &rels_xml(),
        &[("word/styles.xml", styles_xml().as_bytes())],
    );
    assert!(parse_document("a.docx", &bad_xml).is_err());

    // 关系表坏了：Err 而不是 panic（图片/链接无法核对时不该硬凑正文）。
    let bad_rels = build(
        &docx_paragraph("", &docx_run("正文", "")),
        "<Relationships><broken",
        &[],
    );
    let outcome = parse_document("a.docx", &bad_rels);
    assert!(outcome.is_err() || outcome.is_ok());
}

#[test]
fn docx_ignores_headers_footers_and_layout_parts() {
    let header =
        format!("<w:hdr xmlns:w=\"{W_NS}\"><w:p><w:r><w:t>页眉文字</w:t></w:r></w:p></w:hdr>");
    let footer =
        format!("<w:ftr xmlns:w=\"{W_NS}\"><w:p><w:r><w:t>页脚文字</w:t></w:r></w:p></w:ftr>");
    let extra: Vec<(&str, &[u8])> = vec![
        ("word/header1.xml", header.as_bytes()),
        ("word/footer1.xml", footer.as_bytes()),
        (
            "word/theme/theme1.xml",
            b"<?xml version=\"1.0\"?><a:theme xmlns:a=\"x\"><a:fontScheme name=\"Calibri\"/></a:theme>"
                .as_slice(),
        ),
        (
            "word/settings.xml",
            b"<?xml version=\"1.0\"?><w:settings><w:zoom w:percent=\"120\"/></w:settings>"
                .as_slice(),
        ),
    ];
    let body = format!(
        "<w:p><w:pPr><w:sectPr><w:pgSz w:w=\"11906\"/><w:pgMar w:top=\"1440\"/></w:sectPr></w:pPr>{}</w:p>",
        docx_run("只有正文", "")
    );
    let bytes = build(&body, &rels_xml(), &extra);
    let parsed = parse_document("course.docx", &bytes).expect("附加部件不该影响正文");
    assert_eq!(parsed.blocks.len(), 1);
    assert_eq!(raw(&parsed, 0), "只有正文\n");
    let joined = all_text(&parsed);
    for noise in ["页眉", "页脚", "Calibri", "11906", "1440", "120"] {
        assert!(!joined.contains(noise), "版式/母版信息不得进正文：{noise}");
    }
}
