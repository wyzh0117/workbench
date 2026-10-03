//! EPUB 解析测试：样本全部用 `zip` 写出器现场合成（见 `documents::fixtures`），
//! 不读磁盘、不依赖 Calibre。断言聚焦契约：按 spine 的阅读顺序 / 标题层级与 class
//! 弱提示 / 行内强调与 markdown 转义 / 列表与表格 / 链接与图片（含去重与 data URI）/
//! UTF-16 转码与实体 / 不支持对象只提示不静默丢 / 结构损坏要么 `Err` 要么按模块
//! 文档承诺降级，绝不 panic、绝不静默丢内容。

use super::*;
use crate::documents::fixtures::{
    epub_build, jpeg_bytes, opf_package, png_bytes, truncate_tail, xhtml, zip_build, zip_build_text,
};
use crate::documents::{parse_document, ParsedDocument};
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::json;

const XHTML_TYPE: &str = "application/xhtml+xml";

/// 一份 OPF：manifest 与 spine 分开给，用来证明"顺序由 spine 决定"。
fn opf(manifest: &str, spine: &str) -> String {
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

fn item(id: &str, href: &str, media_type: &str) -> String {
    format!(r#"<item id="{id}" href="{href}" media-type="{media_type}"/>"#)
}

fn chapter_item(id: &str, href: &str) -> String {
    item(id, href, XHTML_TYPE)
}

fn itemref(id: &str) -> String {
    format!(r#"<itemref idref="{id}"/>"#)
}

/// 一本只有一章的书（沿用 `fixtures::opf_package` 的形状：一章 + 封面 + CSS）。
fn one_chapter(body: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
    let package = opf_package(
        &[("ch1", "Text/a.xhtml", XHTML_TYPE)],
        "Images/cover.png",
        "styles/style.css",
    );
    epub_build(
        &package,
        &[("OEBPS/Text/a.xhtml", &xhtml("第一章", body))],
        extra,
    )
}

fn parse(body: &str) -> ParsedDocument {
    parse_document("sample.epub", &one_chapter(body, &[])).expect("合法 XHTML 章节必须解析成功")
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

fn text_all(parsed: &ParsedDocument) -> Vec<String> {
    (0..parsed.blocks.len())
        .map(|index| text(parsed, index))
        .collect()
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

fn warning_joined(parsed: &ParsedDocument) -> String {
    parsed.warnings.join("\n")
}

/// 报错信息必须是给中国用户看的中文（不能只剩英文栈信息），且绝不 panic。
fn chinese_error(name: &str, bytes: &[u8]) -> String {
    let outcome = parse_document(name, bytes);
    assert!(outcome.is_err(), "结构损坏必须返回 Err，实得 {outcome:?}");
    let message = outcome.expect_err("上一行已断言它是 Err");
    assert!(
        message.chars().any(|value| value as u32 >= 0x4e00),
        "错误信息必须是中文提示：{message}"
    );
    message
}

#[test]
fn epub_reads_chapters_in_spine_order() {
    // 文件名字母序 = alpha, beta, gamma, skip；manifest 一套顺序；spine 另一套。
    let package = opf(
        &[
            chapter_item("gamma", "Text/gamma.xhtml"),
            chapter_item("alpha", "Text/alpha.xhtml"),
            chapter_item("skip", "Text/skip.xhtml"),
            chapter_item("beta", "Text/beta.xhtml"),
            item("css", "styles/style.css", "text/css"),
        ]
        .join(""),
        &[
            itemref("beta"),
            itemref("gamma"),
            itemref("alpha"),
            r#"<itemref idref="skip" linear="no"/>"#.to_owned(),
        ]
        .join(""),
    );
    let bytes = epub_build(
        &package,
        &[
            (
                "OEBPS/Text/alpha.xhtml",
                &xhtml("甲", "<p>甲正文</p><p>甲第二段</p>"),
            ),
            (
                "OEBPS/Text/beta.xhtml",
                &xhtml("乙", "<h1>乙章</h1><p>乙正文</p>"),
            ),
            ("OEBPS/Text/gamma.xhtml", &xhtml("丙", "<p>丙正文</p>")),
            ("OEBPS/Text/skip.xhtml", &xhtml("附录", "<p>附录正文</p>")),
        ],
        &[],
    );
    let parsed = parse_document("sample.epub", &bytes).expect("按 spine 排布的书必须解析成功");
    assert_eq!(
        kinds(&parsed),
        vec![
            "heading:1",
            "paragraph",
            "paragraph",
            "paragraph",
            "paragraph"
        ],
        "区块必须严格按 spine 顺序（乙 -> 丙 -> 甲）：{:?}",
        text_all(&parsed)
    );
    assert_eq!(raw(&parsed, 0), "# 乙章\n");
    assert_eq!(
        text_all(&parsed)[1..],
        vec!["乙正文", "丙正文", "甲正文", "甲第二段"],
        "manifest 顺序与文件名字母序都必须让位于 spine"
    );
    assert!(
        !all_text(&parsed).contains("附录正文"),
        "linear=no 的内容不得混进阅读顺序"
    );
    assert!(
        !all_text(&parsed).contains("第一章"),
        "head 里的 title 不是正文标题"
    );
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("linear=no")),
        "{:?}",
        parsed.warnings
    );
    assert!(parsed.usable_text);
}

#[test]
fn epub_heading_levels_come_from_tags_and_class_hints() {
    let body = concat!(
        "<h1>一级</h1><h2>二级</h2><h3>三级</h3>",
        "<h4>四级</h4><h5>五级</h5><h6>六级</h6>",
        r#"<p class="chapter-title">章标题</p>"#,
        r#"<div class="h2">小节提示</div>"#,
        r#"<p class="normal-text">没有标题暗示</p>"#,
        "<hr/>",
    );
    let parsed = parse(body);
    assert_eq!(
        kinds(&parsed),
        vec![
            "heading:1",
            "heading:2",
            "heading:3",
            "heading:4",
            "heading:5",
            "heading:6",
            "heading:1",
            "heading:2",
            "paragraph",
            "divider"
        ]
    );
    assert_eq!(raw(&parsed, 0), "# 一级\n");
    assert_eq!(raw(&parsed, 5), "###### 六级\n");
    assert_eq!(raw(&parsed, 6), "# 章标题\n");
    assert_eq!(raw(&parsed, 7), "## 小节提示\n");
    assert_eq!(raw(&parsed, 8), "没有标题暗示\n");
    assert_eq!(raw(&parsed, 9), "");
    assert_eq!(parsed.blocks[9]["text"], json!(""));
    assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
}

#[test]
fn epub_landmarks_and_semantic_types_do_not_invent_headings() {
    let body = concat!(
        r#"<nav epub:type="toc"><p>目录</p></nav>"#,
        r#"<section epub:type="landmarks">导航说明</section>"#,
        r#"<div epub:type="page-list">页码列表</div>"#,
        r#"<div epub:type="colophon">版权页</div>"#,
    );
    let parsed = parse(body);
    assert_eq!(
        kinds(&parsed),
        vec!["paragraph", "paragraph", "paragraph", "paragraph"],
        "epub:type 的语义类型不是标题：{:?}",
        kinds(&parsed)
    );
    assert_eq!(
        text_all(&parsed),
        vec!["目录", "导航说明", "页码列表", "版权页"]
    );
    assert!(!parsed.degraded);
    assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
}

#[test]
fn epub_inline_formatting_becomes_markdown_not_html() {
    let body = concat!(
        "<p>普通 <b>重点</b> 与 <strong>更重要</strong> 与 <i>斜体</i> 与 <em>强调</em>",
        r#" 与 <span class="term">术语</span> 与 <del>删除</del> 与 <code>make</code> 结束</p>"#,
        "<p>run <b>fast </b>now</p>",
        "<p>字面量 50*100 与 a_b 与 #标签</p>",
    );
    let parsed = parse(body);
    assert_eq!(
        kinds(&parsed),
        vec!["paragraph", "paragraph", "paragraph"],
        "{:?}",
        text_all(&parsed)
    );
    assert_eq!(
        raw(&parsed, 0).trim_end(),
        "普通 **重点** 与 **更重要** 与 *斜体* 与 *强调* 与 术语 与 ~~删除~~ 与 `make` 结束"
    );
    assert_eq!(raw(&parsed, 1).trim_end(), "run **fast** now");
    // 源文本里的 markdown 控制符必须转义；已成形的标记不能再被转义。
    assert_eq!(
        raw(&parsed, 2).trim_end(),
        "字面量 50\\*100 与 a\\_b 与 \\#标签"
    );
    let joined = all_text(&parsed);
    assert!(!joined.contains('<'), "绝不输出 HTML 标签：{joined}");
    assert!(!joined.contains("term"), "class 不得进正文：{joined}");
    assert!(!joined.contains("\\*\\*"), "强调标记被二次转义：{joined}");
    assert!(!joined.contains("\\!\\["), "图片语法被二次转义：{joined}");
    assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
    assert!(!parsed.degraded);
}

#[test]
fn epub_nested_lists_use_gfm_prefixes_and_cap_recursion() {
    let body = concat!(
        // 嵌套列表是一个块：内层 `</ol>` / `</ul>` 不许把它劈开。
        "<ul><li>甲<ul><li>乙<ol><li>丙</li></ol></li></ul></li><li>丁</li></ul>",
        "<ol><li>序一<ol><li>序二</li></ol></li></ol>",
        // 漏写 `</li>`：HTML 会把同级 `<li>` 自动闭合，两项仍是同层兄弟。
        "<ol><li>漏闭合甲<li>漏闭合乙</li></li></ol>",
    );
    let parsed = parse(body);
    assert_eq!(
        kinds(&parsed),
        vec!["list", "list", "list"],
        "{:?}",
        text_all(&parsed)
    );
    assert_eq!(raw(&parsed, 0), "- 甲\n  - 乙\n    1. 丙\n- 丁\n");
    assert_eq!(raw(&parsed, 1), "1. 序一\n  1. 序二\n");
    assert_eq!(raw(&parsed, 2), "1. 漏闭合甲\n1. 漏闭合乙\n");

    // 超过 MAX_LIST_DEPTH 的嵌套：缩进封顶、内容不丢、不无限递归。
    let deepest = MAX_LIST_DEPTH + 4;
    let mut deep = String::new();
    for level in 1..=deepest {
        deep.push_str("<ul>");
        deep.push_str(&format!("<li>L{level}"));
    }
    for _ in 1..=deepest {
        deep.push_str("</li></ul>");
    }
    let parsed = parse(&deep);
    assert_eq!(kinds(&parsed), vec!["list"], "{:?}", text_all(&parsed));
    let deep_raw = raw(&parsed, 0);
    let lines: Vec<&str> = deep_raw.lines().collect();
    assert_eq!(lines.len(), deepest, "{lines:?}");
    assert_eq!(lines[0], "- L1");
    assert_eq!(
        lines[MAX_LIST_DEPTH - 1],
        format!("{}- L{MAX_LIST_DEPTH}", "  ".repeat(MAX_LIST_DEPTH - 1))
    );
    for (index, line) in lines.iter().enumerate().skip(MAX_LIST_DEPTH) {
        assert_eq!(
            *line,
            format!("{}- L{}", "  ".repeat(MAX_LIST_DEPTH), index + 1),
            "超出深度的层级必须停在最深处缩进：{lines:?}"
        );
    }
}

#[test]
fn epub_quote_and_code_blocks_keep_their_content() {
    let body = concat!(
        "<blockquote><p>引用的话</p><p>引用的第二段</p></blockquote>",
        "<blockquote>直接引用</blockquote>",
        r#"<pre><code class="language-python">print("hi")</code></pre>"#,
        r#"<pre class="lang-sh">echo   空格保留</pre>"#,
        "<pre>第一行\n    缩进行\n</pre>",
        "<p>末尾段落</p>",
    );
    let parsed = parse(body);
    assert_eq!(
        kinds(&parsed),
        vec![
            "quote",
            "quote",
            "quote",
            "code",
            "code",
            "code",
            "paragraph"
        ],
        "{:?}",
        text_all(&parsed)
    );
    assert_eq!(raw(&parsed, 0), "> 引用的话\n");
    assert_eq!(raw(&parsed, 1), "> 引用的第二段\n");
    assert_eq!(raw(&parsed, 2), "> 直接引用\n");
    assert_eq!(raw(&parsed, 3), "```python\nprint(\"hi\")\n```\n");
    assert_eq!(parsed.blocks[3]["language"], json!("python"));
    assert_eq!(raw(&parsed, 4), "```sh\necho   空格保留\n```\n");
    assert_eq!(parsed.blocks[4]["language"], json!("sh"));
    assert_eq!(raw(&parsed, 5), "```\n第一行\n    缩进行\n```\n");
    assert_eq!(parsed.blocks[5]["language"], json!(null));
    assert_eq!(raw(&parsed, 6), "末尾段落\n");
    assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
}

#[test]
fn epub_tables_become_gfm_and_uneven_rows_degrade_loudly() {
    let body = concat!(
        "<table><tr><th>名称</th><th>数量</th></tr><tr><td>讲义</td><td>3</td></tr></table>",
        "<table><tr><td>甲</td><td>乙</td><td>丙</td></tr><tr><td>只有两格</td><td>另一格</td></tr></table>",
        "<table></table>",
        "<p>表格之后</p>",
    );
    let parsed = parse(body);
    assert_eq!(
        kinds(&parsed),
        vec!["table", "table", "paragraph"],
        "{:?}",
        text_all(&parsed)
    );
    let good = raw(&parsed, 0);
    assert!(
        good.starts_with("| 名称 | 数量 |\n| --- | --- |\n"),
        "{good}"
    );
    assert!(good.contains("| 讲义 | 3 |"), "{good}");
    let uneven = raw(&parsed, 1);
    assert!(
        uneven.starts_with("| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n"),
        "{uneven}"
    );
    assert!(
        uneven.contains("| 只有两格 | 另一格 |"),
        "缺的单元格要补空而不是整行丢掉：{uneven}"
    );
    assert!(
        uneven.ends_with("|   |\n"),
        "第三列补成空单元格：{uneven:?}"
    );
    assert!(parsed.degraded);
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("单元格数")),
        "{:?}",
        parsed.warnings
    );
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("表格没有可还原的单元格内容")),
        "{:?}",
        parsed.warnings
    );
    assert_eq!(text(&parsed, 2), "表格之后");
}

#[test]
fn epub_links_follow_internal_external_and_scheme_rules() {
    let package = opf(
        &[
            chapter_item("one", "Text/one.xhtml"),
            chapter_item("two", "Text/two.xhtml"),
        ]
        .join(""),
        &itemref("one"),
    );
    let body = concat!(
        r#"<p>外站 <a href="https://example.com/a">示例</a> 邮件 <a href="mailto:me@example.com">来信</a>"#,
        r#" 脚本 <a href="javascript:alert(1)">坏</a> 章节 <a href="two.xhtml">第二章</a>"#,
        r##" 锚点 <a href="#sec">本节</a> 越界 <a href="../../../../etc/passwd">越界</a></p>"##,
    );
    let bytes = epub_build(
        &package,
        &[
            ("OEBPS/Text/one.xhtml", &xhtml("一章", body)),
            ("OEBPS/Text/two.xhtml", &xhtml("二章", "<p>第二章正文</p>")),
        ],
        &[],
    );
    let parsed = parse_document("sample.epub", &bytes).expect("链接测试包必须解析成功");
    assert_eq!(kinds(&parsed), vec!["paragraph"], "{:?}", text_all(&parsed));
    let line = raw(&parsed, 0);
    assert!(
        line.contains("[示例](https://example.com/a)"),
        "外链原样保留：{line}"
    );
    assert!(line.contains("[来信](mailto:me@example.com)"), "{line}");
    assert!(
        line.contains("[坏](javascript:alert%281%29)"),
        "危险协议也要能安全放进 markdown：{line}"
    );
    assert!(
        !line.contains("[第二章]") && line.contains("第二章"),
        "本书内部链接导入后无法跳转，只保留链接文字：{line}"
    );
    assert!(
        !line.contains("[本节]") && line.contains("本节"),
        "锚点也只保留文字：{line}"
    );
    assert!(
        line.contains("[越界](etc/passwd)"),
        "越界引用只能规范成容器内路径：{line}"
    );
    assert!(!line.contains(".."), "正文里不得出现跳出容器的路径：{line}");
    assert!(parsed.degraded);
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("锚点链接") && warning.contains("2 处")),
        "{:?}",
        parsed.warnings
    );
}

#[test]
fn epub_images_follow_the_ref_name_and_image_refs_contract() {
    let picture = png_bytes("同一张图");
    let photo = jpeg_bytes("照片");
    let body = concat!(
        r#"<p>图：<img src="images/pic.png" alt="图一"/></p>"#,
        r#"<p>再见 <img src="images/pic.png" alt="又见"/> 结束</p>"#,
        r#"<p><img src="images/photo.jpg" alt="照片"/></p>"#,
    );
    let bytes = one_chapter(
        body,
        &[
            ("OEBPS/Text/images/pic.png", &picture),
            ("OEBPS/Text/images/photo.jpg", &photo),
        ],
    );
    let parsed = parse_document("sample.epub", &bytes).expect("含图 EPUB 必须解析成功");
    assert_eq!(parsed.images.len(), 2, "同一个容器条目只提取一次");
    assert_eq!(parsed.images[0].ref_name, "document-image-1.png");
    assert_eq!(parsed.images[0].mime, "image/png");
    assert_eq!(parsed.images[0].base64, BASE64.encode(&picture));
    assert!(!parsed.images[0].base64.contains('\n'), "base64 不能带换行");
    assert_eq!(
        BASE64
            .decode(&parsed.images[0].base64)
            .expect("标准 base64 必须可解码"),
        picture,
        "图片字节必须原样搬运"
    );
    assert_eq!(text(&parsed, 0), "图：![图一](document-image-1.png)");
    assert_eq!(text(&parsed, 1), "再见 ![又见](document-image-1.png) 结束");
    for key in [
        "href",
        "title",
        "alt",
        "tokenIndex",
        "occurrence",
        "blockIndex",
    ] {
        assert!(
            parsed.blocks[0]["imageRefs"][0].get(key).is_some(),
            "imageRefs 缺字段 {key}"
        );
    }
    assert_eq!(
        parsed.blocks[0]["imageRefs"][0]["href"],
        json!("document-image-1.png")
    );
    assert_eq!(parsed.blocks[0]["imageRefs"][0]["alt"], json!("图一"));
    assert_eq!(parsed.blocks[0]["imageRefs"][0]["title"], json!(null));
    assert_eq!(parsed.blocks[0]["imageRefs"][0]["tokenIndex"], json!(0));
    assert_eq!(parsed.blocks[0]["imageRefs"][0]["occurrence"], json!(0));
    assert_eq!(parsed.blocks[0]["imageRefs"][0]["blockIndex"], json!(0));
    assert_eq!(
        parsed.blocks[1]["imageRefs"][0]["href"],
        json!("document-image-1.png")
    );
    assert_eq!(parsed.blocks[1]["imageRefs"][0]["tokenIndex"], json!(1));
    assert_eq!(parsed.blocks[1]["imageRefs"][0]["occurrence"], json!(1));
    assert_eq!(parsed.blocks[1]["imageRefs"][0]["blockIndex"], json!(1));
    assert_eq!(parsed.blocks[0]["type"], json!("paragraph"));
    // 第二张图：编号顺延、MIME 按来源扩展名判定、`occurrence` 各自从 0 重新数。
    assert_eq!(parsed.images[1].ref_name, "document-image-2.jpg");
    assert_eq!(parsed.images[1].mime, "image/jpeg");
    assert_eq!(parsed.images[1].base64, BASE64.encode(&photo));
    assert_eq!(text(&parsed, 2), "![照片](document-image-2.jpg)");
    assert_eq!(
        parsed.blocks[2]["imageRefs"][0]["href"],
        json!("document-image-2.jpg")
    );
    assert_eq!(parsed.blocks[2]["imageRefs"][0]["alt"], json!("照片"));
    assert_eq!(parsed.blocks[2]["imageRefs"][0]["tokenIndex"], json!(2));
    assert_eq!(parsed.blocks[2]["imageRefs"][0]["occurrence"], json!(0));
    assert_eq!(parsed.blocks[2]["imageRefs"][0]["blockIndex"], json!(2));
    assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
}

#[test]
fn epub_unresolvable_images_only_warn_and_keep_text() {
    let body = concat!(
        r#"<p>前文 <img src="images/nope.png"/> 后文</p>"#,
        r#"<img alt="没有 src"/>"#,
        r#"<p>越界 <img src="../../outside.png"/> 结束</p>"#,
        r#"<p><img src="images/figure.emf" alt="矢量"/></p>"#,
    );
    let bytes = one_chapter(
        body,
        &[("OEBPS/Text/images/figure.emf", b"EMF-bytes".as_slice())],
    );
    let parsed = parse_document("sample.epub", &bytes).expect("缺图只提示，不整体失败");
    assert!(parsed.images.is_empty(), "{:?}", parsed.images);
    assert_eq!(
        text_all(&parsed),
        vec!["前文 后文", "越界 结束"],
        "图片没提取成功时正文文字必须还在"
    );
    let warnings = warning_joined(&parsed);
    assert!(
        warnings.contains("OEBPS/Text/images/nope.png"),
        "{warnings}"
    );
    assert!(warnings.contains("不在容器里"), "{warnings}");
    assert!(warnings.contains("没有来源的图片"), "{warnings}");
    assert!(
        warnings.contains("outside.png") && !warnings.contains(".."),
        "跳出容器的引用要先规范成容器内路径：{warnings}"
    );
    assert!(warnings.contains("figure.emf"), "{warnings}");
    assert!(!all_text(&parsed).contains(".."));
}

#[test]
fn epub_data_uri_images_are_decoded_into_assets() {
    let picture = png_bytes("内联图");
    let body = format!(
        r#"<p><img src="data:image/png;base64,{}"/></p><p><img src="data:image/png;base64,@@@"/></p>"#,
        BASE64.encode(&picture)
    );
    let parsed = parse(&body);
    assert_eq!(parsed.images.len(), 1, "无法解码的 data URI 不进图片表");
    assert_eq!(parsed.images[0].ref_name, "document-image-1.png");
    assert_eq!(parsed.images[0].mime, "image/png");
    assert_eq!(parsed.images[0].base64, BASE64.encode(&picture));
    assert_eq!(
        BASE64.decode(&parsed.images[0].base64).expect("必须可解码"),
        picture
    );
    assert_eq!(
        text(&parsed, 0),
        "![文档图片 1](document-image-1.png)",
        "没有 alt 时要有稳定的占位名"
    );
    assert_eq!(parsed.blocks.len(), 1, "解码失败的图片只留提示");
    let warnings = warning_joined(&parsed);
    assert!(warnings.contains("data: 内联图片已解码"), "{warnings}");
    assert!(warnings.contains("无法解码或过大的 data:"), "{warnings}");
    assert!(parsed.degraded);
}

#[test]
fn epub_unsupported_media_and_math_are_reported_not_dropped() {
    let body = concat!(
        "<p>正文甲</p>",
        r#"<audio src="a.mp3">音频文字</audio>"#,
        r#"<video src="b.mp4"></video>"#,
        r#"<svg viewBox="0 0 1 1"><text>矢量文字</text></svg>"#,
        r#"<p>公式 <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>E</mi><mo>=</mo><mi>mc</mi></math></p>"#,
        "<p>正文乙</p>",
    );
    let parsed = parse(body);
    assert_eq!(
        kinds(&parsed),
        vec!["paragraph", "paragraph", "code", "paragraph"],
        "{:?}",
        text_all(&parsed)
    );
    assert_eq!(text(&parsed, 0), "正文甲");
    assert_eq!(text(&parsed, 1), "公式");
    assert_eq!(
        raw(&parsed, 2),
        "```\nE=mc\n```\n",
        "公式降级成代码，不静默丢"
    );
    assert_eq!(text(&parsed, 3), "正文乙");
    assert!(parsed.degraded);
    let warnings = warning_joined(&parsed);
    assert!(
        warnings.contains("4 处图形 / 媒体 / 公式对象"),
        "{warnings}"
    );
    for kind in ["audio", "video", "svg", "math"] {
        assert!(warnings.contains(kind), "提示要点名 {kind}：{warnings}");
    }
}

#[test]
fn epub_css_script_and_title_never_enter_blocks() {
    let source = concat!(
        r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html>"#,
        r#"<html xmlns="http://www.w3.org/1999/xhtml"><head>"#,
        r#"<style>p{font-family:KaiTi;color:#FF0000}</style><title>书名题</title>"#,
        r#"<script>var hidden = 1;</script></head>"#,
        r#"<body><style>.note{margin:0}</style><script>var b = 2;</script>"#,
        r#"<h1>真标题</h1><p>真正文</p></body></html>"#
    );
    let package = opf(&chapter_item("one", "Text/one.xhtml"), &itemref("one"));
    let bytes = epub_build(&package, &[("OEBPS/Text/one.xhtml", source)], &[]);
    let parsed = parse_document("sample.epub", &bytes).expect("head 里的样式脚本不该致命");
    assert_eq!(
        kinds(&parsed),
        vec!["heading:1", "paragraph"],
        "{:?}",
        text_all(&parsed)
    );
    assert_eq!(raw(&parsed, 0), "# 真标题\n");
    assert_eq!(raw(&parsed, 1), "真正文\n");
    let joined = all_text(&parsed);
    for noise in [
        "书名题",
        "KaiTi",
        "FF0000",
        "font-family",
        "hidden",
        "margin",
        "style",
        "<",
    ] {
        assert!(
            !joined.contains(noise),
            "版式 / 脚本 / 标题不得进正文：{noise}"
        );
    }
    assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
}

#[test]
fn epub_utf16_and_entities_decode_to_readable_text() {
    let source = concat!(
        r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html>"#,
        r#"<html xmlns="http://www.w3.org/1999/xhtml"><head><title>utf</title></head>"#,
        r#"<body><p>一 Utf 正文 二</p></body></html>"#
    );
    let little: Vec<u8> = std::iter::once(0xFFu8)
        .chain(std::iter::once(0xFE))
        .chain(source.encode_utf16().flat_map(u16::to_le_bytes))
        .collect();
    let big: Vec<u8> = std::iter::once(0xFEu8)
        .chain(std::iter::once(0xFF))
        .chain(source.encode_utf16().flat_map(u16::to_be_bytes))
        .collect();
    // 声明写着 UTF-8、字节其实是 UTF-16：以 BOM 为准转码，不能出乱码也不能报错。
    let package = opf_package(
        &[("ch1", "Text/a.xhtml", XHTML_TYPE)],
        "Images/cover.png",
        "styles/style.css",
    );
    for (label, bytes) in [("UTF-16LE", &little), ("UTF-16BE", &big)] {
        let archive = epub_build(&package, &[], &[("OEBPS/Text/a.xhtml", bytes)]);
        let parsed = parse_document("sample.epub", &archive)
            .unwrap_or_else(|error| panic!("{label} 章节必须解析成功：{error}"));
        assert_eq!(kinds(&parsed), vec!["paragraph"], "{label} 解析结果异常");
        assert_eq!(text(&parsed, 0), "一 Utf 正文 二", "{label} 不得是乱码");
        assert!(
            parsed
                .warnings
                .iter()
                .any(|warning| warning.contains("UTF-16")),
            "{label} 要说明做过转码：{:?}",
            parsed.warnings
        );
    }

    // UTF-8 字节 + 一条多余的 encoding="UTF-16" 处理指令：照样要读出文字。
    let conflicting = concat!(
        r#"<?xml version="1.0" encoding="UTF-8"?><?xml encoding="UTF-16"?><!DOCTYPE html>"#,
        r#"<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head>"#,
        r#"<body><p>冲突声明的正文</p></body></html>"#
    );
    let parsed = parse(conflicting);
    assert_eq!(text_all(&parsed), vec!["冲突声明的正文"]);
    assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);

    // 实体与 HTML 空白：连续空白压成一个空格，未知实体原样保留并提示。
    let parsed = parse("<p>甲&nbsp;&nbsp;&nbsp;乙 &amp; © &#20013; &weird; 收尾</p>");
    assert_eq!(text(&parsed, 0), "甲 乙 & © 中 &weird; 收尾");
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("无法识别的实体引用")),
        "{:?}",
        parsed.warnings
    );
}

#[test]
fn epub_unbalanced_markup_keeps_every_word() {
    let parsed = parse("<p>价格 <b>10 元</p><p>第二段</p><p>甲<strong>乙</p>");
    assert_eq!(
        kinds(&parsed),
        vec!["paragraph", "paragraph", "paragraph"],
        "{:?}",
        text_all(&parsed)
    );
    assert_eq!(
        text(&parsed, 0),
        "价格 **10 元**",
        "未闭合的行内标签不能吞掉它包住的文字"
    );
    assert_eq!(text(&parsed, 1), "第二段");
    assert_eq!(text(&parsed, 2), "甲**乙**");
    assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
}

#[test]
fn epub_broken_archives_are_chinese_errors_not_panics() {
    let good = one_chapter("<p>正文</p>", &[]);
    // 尾部截断：中央目录被切掉，一个条目都读不出来 —— 必须明确 Err。
    let message = chinese_error("sample.epub", &truncate_tail(&good, 40));
    assert!(
        message.contains("ZIP") && message.contains("截断"),
        "{message}"
    );
    assert!(chinese_error("sample.epub", &truncate_tail(&good, 0)).contains("ZIP"));
    assert!(
        chinese_error("sample.epub", b"PK\x03\x04garbage-garbage").contains("ZIP"),
        "非 ZIP 必须报错"
    );
    assert!(chinese_error("sample.epub", &[0u8; 64]).contains("EPUB"));
    // 是 ZIP、但既没有 container.xml 也没有 .opf：这份文档确实无法解析。
    let message = chinese_error("sample.epub", &zip_build_text(&[("note.txt", "不是 epub")]));
    assert!(message.contains("container.xml"), "{message}");

    // 其余破损形状按模块文档承诺降级：绝不 panic，一定有中文线索，
    // 读不出正文时判为不可用，不许装作导入成功。
    let damaged = vec![
        (
            "半截 container.xml".to_owned(),
            zip_build(&[
                ("mimetype", b"application/epub+zip".as_slice()),
                ("OEBPS/Text/a.xhtml", b"<html><body><p>x</p></body></html>"),
                (
                    "META-INF/container.xml",
                    r#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/>"#
                        .as_bytes(),
                ),
            ]),
        ),
        (
            "OPF 不是 XML".to_owned(),
            zip_build(&[
                ("mimetype", b"application/epub+zip".as_slice()),
                (
                    "META-INF/container.xml",
                    concat!(
                        r#"<?xml version="1.0" encoding="UTF-8"?>"#,
                        r#"<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">"#,
                        r#"<rootfiles><rootfile full-path="OEBPS/content.opf" "#,
                        r#"media-type="application/oebps-package+xml"/></rootfiles></container>"#
                    )
                    .as_bytes(),
                ),
                ("OEBPS/content.opf", "<<<这不是 XML>>>".as_bytes()),
            ]),
        ),
        (
            "只有一个空 .opf".to_owned(),
            zip_build(&[("whatever.opf", b"".as_slice())]),
        ),
    ];
    for (label, bytes) in damaged {
        match parse_document("sample.epub", &bytes) {
            Ok(parsed) => {
                assert!(
                    parsed.blocks.is_empty() && !parsed.usable_text,
                    "{label} 不该声称导入了正文：{:?}",
                    text_all(&parsed)
                );
                let warnings = warning_joined(&parsed);
                assert!(
                    warnings.chars().any(|value| value as u32 >= 0x4e00),
                    "{label} 必须有中文提示：{:?}",
                    parsed.warnings
                );
            }
            Err(message) => {
                assert!(
                    message.chars().any(|value| value as u32 >= 0x4e00),
                    "{label} 必须有中文报错：{message}"
                );
            }
        }
    }
}

#[test]
fn epub_damaged_package_parts_degrade_without_losing_the_book() {
    // 缺 container.xml：改用容器里第一个 .opf，并给出提示。
    let package = opf(&chapter_item("one", "one.xhtml"), &itemref("one"));
    let bytes = zip_build(&[
        ("mimetype", b"application/epub+zip".as_slice()),
        ("content.opf", package.as_bytes()),
        (
            "one.xhtml",
            xhtml("一章", "<p>没有容器索引的正文</p>").as_bytes(),
        ),
    ]);
    let parsed = parse_document("sample.epub", &bytes).expect("缺 container.xml 要能退化解析");
    assert_eq!(text(&parsed, 0), "没有容器索引的正文");
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("META-INF/container.xml")),
        "{:?}",
        parsed.warnings
    );

    // container.xml 指向不存在的 OPF：没有可用正文，但绝不 panic。
    let bytes = zip_build(&[
        (
            "META-INF/container.xml",
            concat!(
                r#"<?xml version="1.0" encoding="UTF-8"?>"#,
                r#"<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">"#,
                r#"<rootfiles><rootfile full-path="OEBPS/gone.opf" "#,
                r#"media-type="application/oebps-package+xml"/></rootfiles></container>"#
            )
            .as_bytes(),
        ),
        ("OEBPS/Text/a.xhtml", b"<html><body><p>x</p></body></html>"),
    ]);
    let parsed = parse_document("sample.epub", &bytes).expect("缺 OPF 只能提示，不能失败");
    assert!(parsed.blocks.is_empty());
    assert!(!parsed.usable_text, "没有任何可用文字");
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("OPF")),
        "{:?}",
        parsed.warnings
    );

    // spine 为空：顺序退化到 manifest 路径序，并明确降级。
    let package = opf(&chapter_item("one", "Text/a.xhtml"), "");
    let bytes = epub_build(
        &package,
        &[("OEBPS/Text/a.xhtml", &xhtml("一章", "<p>退化顺序</p>"))],
        &[],
    );
    let parsed = parse_document("sample.epub", &bytes).expect("空 spine 要退化，不该整体失败");
    assert_eq!(text_all(&parsed), vec!["退化顺序"]);
    assert!(parsed.degraded);
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("spine 为空")),
        "{:?}",
        parsed.warnings
    );

    // spine 里只有非正文媒体类型：没有可解析正文，只提示。
    let package = opf(
        &item("css", "styles/style.css", "text/css"),
        &itemref("css"),
    );
    let bytes = epub_build(&package, &[], &[("OEBPS/styles/style.css", b"p{}")]);
    let parsed = parse_document("sample.epub", &bytes).expect("非正文类型只提示");
    assert!(parsed.blocks.is_empty());
    assert!(!parsed.usable_text);
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("没有可解析的正文文件")),
        "{:?}",
        parsed.warnings
    );

    // spine 指向缺失章节 + 引用不存在的 id：跳过并提示，其它章照常读。
    let package = opf(
        &[
            chapter_item("one", "Text/one.xhtml"),
            chapter_item("missing", "Text/missing.xhtml"),
        ]
        .join(""),
        &[itemref("missing"), itemref("ghost"), itemref("one")].join(""),
    );
    let bytes = epub_build(
        &package,
        &[("OEBPS/Text/one.xhtml", &xhtml("一章", "<p>还能读的章</p>"))],
        &[],
    );
    let parsed = parse_document("sample.epub", &bytes).expect("单章缺失不该让整本书失败");
    assert_eq!(text_all(&parsed), vec!["还能读的章"]);
    let warnings = warning_joined(&parsed);
    assert!(warnings.contains("不在容器里"), "{warnings}");
    assert!(warnings.contains("manifest 中不存在"), "{warnings}");

    // 章节 XHTML 不是良构 XML：只中断该章并提示，另一章照读。
    let package = opf(
        &[
            chapter_item("bad", "Text/bad.xhtml"),
            chapter_item("good", "Text/good.xhtml"),
        ]
        .join(""),
        &[itemref("bad"), itemref("good")].join(""),
    );
    let bytes = epub_build(
        &package,
        &[
            (
                "OEBPS/Text/bad.xhtml",
                &xhtml("坏章", "<p>正文 <b>未闭合的加粗"),
            ),
            ("OEBPS/Text/good.xhtml", &xhtml("好章", "<p>好章正文</p>")),
        ],
        &[],
    );
    let parsed = parse_document("sample.epub", &bytes).expect("坏章只中断自己");
    let joined = all_text(&parsed);
    assert!(joined.contains("好章正文"), "{:?}", text_all(&parsed));
    assert!(
        joined.contains("未闭合的加粗"),
        "坏章已读到的文字不得丢掉：{:?}",
        text_all(&parsed)
    );
    assert!(!joined.contains('<'), "残片不得原样吐进正文：{joined}");
}

#[test]
fn epub_textless_spine_is_not_usable_text() {
    let body = concat!(
        "<p></p><div><span></span></div><br/>",
        r#"<img/>"#,
        "<table></table><ul></ul>",
    );
    let parsed = parse(body);
    assert!(parsed.blocks.is_empty(), "{:?}", text_all(&parsed));
    assert!(!parsed.usable_text, "没有文字层时只能保留 Reference");
    assert!(parsed.images.is_empty());
}

#[test]
fn epub_imageless_book_has_no_images_and_no_warnings() {
    let parsed = parse("<h1>纯文字</h1><p>第一段</p><p>第二段</p>");
    assert_eq!(kinds(&parsed), vec!["heading:1", "paragraph", "paragraph"]);
    assert_eq!(raw(&parsed, 1), "第一段\n");
    assert!(parsed.images.is_empty());
    assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
    assert!(!parsed.degraded);
    assert!(parsed.usable_text);
    assert_eq!(parsed.blocks[1]["imageRefs"], json!([]));
}

#[test]
fn epub_encryption_declaration_and_foreign_entries_are_data_only() {
    let package = opf(
        &format!(
            "{}{}",
            chapter_item("one", "Text/a.xhtml"),
            r#"<encryption xmlns="urn:epub:enc"><algorithm driver="encrypt-aes256"/></encryption>"#
        ),
        &itemref("one"),
    );
    let bytes = epub_build(
        &package,
        &[("OEBPS/Text/a.xhtml", &xhtml("一章", "<p>能读的正文</p>"))],
        &[
            ("OEBPS/Text/a.xhtml.enc", b"binary-garbage".as_slice()),
            ("outside.opf", b"<package/>".as_slice()),
        ],
    );
    let parsed = parse_document("sample.epub", &bytes).expect("加密声明只降级，不失败");
    assert_eq!(text(&parsed, 0), "能读的正文");
    assert!(parsed.degraded);
    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("DRM")),
        "{:?}",
        parsed.warnings
    );
    assert!(parsed.images.is_empty());
    assert!(!all_text(&parsed).contains("outside"));
}
