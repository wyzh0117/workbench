//! `.txt` / `.text`：编码识别 + 按空行切分段落。
//!
//! 刻意保守：不根据字号、全大写或行首符号猜测标题，纯文本只可能是段落。

use super::{
    collapse_blank_lines, markdown_escape, normalize_newlines, Collector, MAX_EXTRACTED_CHARS,
};
use encoding_rs::Encoding;

/// 无 BOM 且不是合法 UTF-8 时按顺序尝试的编码（中文课件常见）。
const FALLBACK_ENCODINGS: [&str; 4] = ["gb18030", "big5", "windows-1252", "x-mac-roman"];

pub(crate) struct Decoded {
    pub text: String,
    /// 实际使用的编码名，用于用户提示。
    pub label: String,
    /// 有字符无法还原（孤立代理项等）。
    pub lossy: bool,
}

/// 把任意字节解码成 UTF-8 文本。
///
/// 顺序：BOM（UTF-8 / UTF-16LE / UTF-16BE / UTF-32）-> 严格 UTF-8 ->
/// 常见中文/单字节编码。全部失败就报错，绝不用替换字符"凑"出正文。
pub(crate) fn decode_text_bytes(bytes: &[u8]) -> Result<Decoded, String> {
    if bytes.is_empty() {
        return Ok(Decoded {
            text: String::new(),
            label: "empty".to_owned(),
            lossy: false,
        });
    }
    if bytes.starts_with(b"\xFF\xFE\x00\x00") {
        let text = decode_utf32(&bytes[4..], true)?;
        return Ok(Decoded {
            text,
            label: "UTF-32LE".to_owned(),
            lossy: false,
        });
    }
    if bytes.starts_with(b"\x00\x00\xFE\xFF") {
        let text = decode_utf32(&bytes[4..], false)?;
        return Ok(Decoded {
            text,
            label: "UTF-32BE".to_owned(),
            lossy: false,
        });
    }
    if bytes.starts_with(b"\xFF\xFE") {
        let (text, lossy) = decode_utf16(&bytes[2..], true)?;
        return Ok(Decoded {
            text,
            label: "UTF-16LE".to_owned(),
            lossy,
        });
    }
    if bytes.starts_with(b"\xFE\xFF") {
        let (text, lossy) = decode_utf16(&bytes[2..], false)?;
        return Ok(Decoded {
            text,
            label: "UTF-16BE".to_owned(),
            lossy,
        });
    }
    if bytes.starts_with(b"\xEF\xBB\xBF") {
        return std::str::from_utf8(&bytes[3..])
            .map(|value| Decoded {
                text: value.to_owned(),
                label: "UTF-8".to_owned(),
                lossy: false,
            })
            .map_err(|_| "带 UTF-8 BOM 的文件内容不是合法 UTF-8，无法解析。".to_owned());
    }
    // 大量 NUL 说明这是二进制内容，别装作是文本。必须放在严格 UTF-8 之前判：
    // NUL 本身是合法 UTF-8，全 NUL 的文件会被 from_utf8 误判成"能读的文本"。
    let nul_count = bytes.iter().filter(|byte| **byte == 0).count();
    if nul_count > bytes.len() / 20 {
        return Err("文件看起来是二进制内容，不是文本文件。".to_owned());
    }
    if let Ok(value) = std::str::from_utf8(bytes) {
        return Ok(Decoded {
            text: value.to_owned(),
            label: "UTF-8".to_owned(),
            lossy: false,
        });
    }
    for label in FALLBACK_ENCODINGS {
        let Some(encoding) = Encoding::for_label_no_replacement(label.as_bytes()) else {
            continue;
        };
        let (cow, _used, had_errors) = encoding.decode(bytes);
        if had_errors || !looks_like_text(&cow) {
            continue;
        }
        return Ok(Decoded {
            text: cow.into_owned(),
            label: label.to_owned(),
            lossy: false,
        });
    }
    Err("无法识别文本编码（既不是 UTF-8，也不在受兼容的编码列表里），文件可能已损坏。".to_owned())
}

/// 解码并把结论写进收集器；非 UTF-8 与有损解码都会给出提示。
pub(crate) fn decode_to_text(bytes: &[u8], out: &mut Collector) -> Result<String, String> {
    let decoded = decode_text_bytes(bytes)?;
    if decoded.label == "empty" {
        out.warn("文本文件为空，没有可导入的内容。");
        return Ok(String::new());
    }
    if decoded.label != "UTF-8" {
        out.warn(format!(
            "文本编码识别为 {}（不是 UTF-8），已转换为 UTF-8。",
            decoded.label
        ));
    }
    if decoded.lossy {
        out.degrade(format!(
            "{} 文本中存在无法配对的代理项，个别字符已用占位符替代。",
            decoded.label
        ));
    }
    Ok(decoded.text)
}

fn looks_like_text(text: &str) -> bool {
    let mut printable = 0usize;
    let mut total = 0usize;
    for character in text.chars().take(20_000) {
        total += 1;
        if !character.is_control() || matches!(character, '\n' | '\r' | '\t') {
            printable += 1;
        }
    }
    total == 0 || printable * 100 >= total * 85
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> Result<(String, bool), String> {
    if bytes.len() % 2 != 0 {
        return Err("UTF-16 文本长度不是偶数字节，文件已损坏。".to_owned());
    }
    let mut units: Vec<u16> = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        units.push(if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        });
    }
    // 孤立代理项只能有损还原；这里用 lossy 但一定回报 lossy，由调用方降级提示。
    let lossy = String::from_utf16(&units).is_err();
    Ok((String::from_utf16_lossy(&units), lossy))
}

fn decode_utf32(bytes: &[u8], little_endian: bool) -> Result<String, String> {
    if bytes.len() % 4 != 0 {
        return Err("UTF-32 文本长度不是 4 的倍数，文件已损坏。".to_owned());
    }
    let mut out = String::with_capacity(bytes.len() / 4);
    for group in bytes.chunks_exact(4) {
        let value = if little_endian {
            u32::from_le_bytes([group[0], group[1], group[2], group[3]])
        } else {
            u32::from_be_bytes([group[0], group[1], group[2], group[3]])
        };
        match char::from_u32(value) {
            Some(character) => out.push(character),
            None => return Err(format!("UTF-32 中出现无效码点 {value:#010X}，文件已损坏。")),
        }
    }
    Ok(out)
}

/// `.txt` / `.text` 主流程。
pub(crate) fn parse_plain_text(bytes: &[u8], out: &mut Collector) -> Result<(), String> {
    let text = decode_to_text(bytes, out)?;
    let (normalized, dropped_controls) = normalize_newlines(&text);
    if dropped_controls > 0 {
        out.warn(format!("已忽略 {dropped_controls} 个不可显示的控制字符。"));
    }
    let normalized = collapse_blank_lines(&normalized);
    if normalized.trim().is_empty() {
        if !normalized.is_empty() {
            out.warn("文本文件只有空白字符，没有可导入的内容。");
        }
        return Ok(());
    }
    let mut truncated = false;
    for paragraph in normalized.split("\n\n") {
        let trimmed = paragraph.trim_matches('\n');
        if trimmed.trim().is_empty() {
            continue;
        }
        if out.text_budget_reached() {
            truncated = true;
            break;
        }
        // 纯文本按字面处理：转义 markdown 控制符，避免 "# 行" 被当成标题。
        out.paragraph(markdown_escape(trimmed));
    }
    if truncated {
        out.degrade(format!(
            "文本超过 {MAX_EXTRACTED_CHARS} 字符，后续段落未导入，原文件已保留。"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::{parse_document, ParsedDocument};

    fn utf16le(text: &str) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    fn utf16be(text: &str) -> Vec<u8> {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        bytes
    }

    fn texts(parsed: &ParsedDocument) -> Vec<String> {
        parsed
            .blocks
            .iter()
            .map(|block| block["text"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    #[test]
    fn plain_text_splits_paragraphs_on_blank_lines() {
        let parsed = parse_document(
            "notes.txt",
            "第一段\n还是第一段\n\n第二段\n\n\n\n第三段\n".as_bytes(),
        )
        .expect("ok");
        assert_eq!(
            texts(&parsed),
            vec!["第一段\n还是第一段", "第二段", "第三段"]
        );
        assert!(parsed
            .blocks
            .iter()
            .all(|block| block["type"] == "paragraph"));
        assert!(!parsed.degraded);
        assert!(parsed.usable_text);
        assert!(parsed.warnings.is_empty());
    }

    #[test]
    fn plain_text_does_not_invent_headings() {
        let parsed = parse_document("caps.txt", b"# not a heading\n\nALL CAPS LINE\n").expect("ok");
        assert_eq!(parsed.blocks.len(), 2);
        assert!(parsed
            .blocks
            .iter()
            .all(|block| block["type"] == "paragraph"));
        // 字面 # 被转义（渲染时仍是普通文本），不会被当成标题。
        assert_eq!(parsed.blocks[0]["text"], "\\# not a heading");
        assert!(parsed.blocks[0]["raw"]
            .as_str()
            .unwrap_or_default()
            .starts_with("\\#"));
    }

    #[test]
    fn plain_text_detects_utf16_with_bom() {
        for (name, bytes) in [
            ("le.txt", utf16le("第一行\n\n第二行 — dash\n")),
            ("be.txt", utf16be("第一行\n\n第二行 — dash\n")),
        ] {
            let parsed = parse_document(name, &bytes).expect("utf-16 应解析成功");
            assert_eq!(texts(&parsed), vec!["第一行", "第二行 — dash"], "{name}");
            assert!(parsed
                .warnings
                .iter()
                .any(|warning| { warning.contains("UTF-16") && warning.contains("不是 UTF-8") }));
            assert!(!parsed.degraded);
        }
    }

    #[test]
    fn plain_text_reports_unpaired_surrogates_as_degraded() {
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend_from_slice(&0xD800u16.to_le_bytes());
        bytes.extend_from_slice(&0x0041u16.to_le_bytes());
        let parsed = parse_document("lone.txt", &bytes).expect("有损解码不算失败");
        assert!(parsed.degraded);
        assert!(parsed.warnings.iter().any(|w| w.contains("代理项")));
    }

    #[test]
    fn plain_text_accepts_utf8_bom_and_crlf() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("甲\r\n乙\r\n\r\n丙\r\n".as_bytes());
        let parsed = parse_document("bom.txt", &bytes).expect("ok");
        assert_eq!(texts(&parsed), vec!["甲\n乙", "丙"]);
        assert!(parsed.warnings.is_empty(), "UTF-8 BOM 不该报编码提示");
    }

    #[test]
    fn plain_text_falls_back_to_gb18030() {
        let (cow, _encoding, had_errors) = encoding_rs::GB18030.encode("中文讲义\n\n第二段");
        assert!(!had_errors);
        let parsed = parse_document("gbk.text", cow.as_ref()).expect("GB18030 应可识别");
        assert_eq!(texts(&parsed), vec!["中文讲义", "第二段"]);
        assert!(parsed.warnings.iter().any(|w| w.contains("gb18030")));
    }

    #[test]
    fn plain_text_rejects_binary_and_truncated_encodings() {
        assert!(parse_document("bin.txt", &[0u8; 4_096]).is_err());
        assert!(parse_document("odd.txt", &[0xFF, 0xFE, 0x41]).is_err());
        assert!(parse_document("bad.txt", b"\xEF\xBB\xBF\xC3\x28 broken").is_err());
        assert!(parse_document("u32.txt", b"\xFF\xFE\x00\x00\x41\x00\x00").is_err());
    }

    #[test]
    fn plain_text_reports_control_chars_and_empty_file() {
        let parsed = parse_document("ctl.txt", "ok\u{1}text\n".as_bytes()).expect("ok");
        assert!(parsed.warnings.iter().any(|w| w.contains("控制字符")));
        let empty = parse_document("empty.txt", b"").expect("空文件不算错误");
        assert!(empty.blocks.is_empty());
        assert!(!empty.usable_text);
        assert!(empty.warnings.iter().any(|w| w.contains("为空")));
        let blank = parse_document("blank.txt", b"   \n\n  \n").expect("ok");
        assert!(blank.blocks.is_empty());
        assert!(blank.warnings.iter().any(|w| w.contains("空白字符")));
    }

    #[test]
    fn decoder_covers_utf32_and_windows_1252() {
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE, 0x00, 0x00];
        for value in "字x".chars().map(u32::from) {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let decoded = decode_text_bytes(&bytes).expect("utf-32 可解码");
        assert_eq!(decoded.text, "字x");
        assert_eq!(decoded.label, "UTF-32LE");

        let (latin, _encoding, had_errors) = encoding_rs::WINDOWS_1252.encode("café");
        assert!(!had_errors);
        let decoded = decode_text_bytes(&latin).expect("windows-1252 可解码");
        assert_eq!(decoded.text, "café");
        assert_eq!(decoded.label, "windows-1252");

        let be = {
            let mut bytes = vec![0x00, 0x00, 0xFE, 0xFF];
            for value in "字".chars().map(u32::from) {
                bytes.extend_from_slice(&value.to_be_bytes());
            }
            bytes
        };
        assert_eq!(decode_text_bytes(&be).expect("ok").label, "UTF-32BE");
    }

    #[test]
    fn looks_like_text_rejects_control_dense_payload() {
        assert!(!looks_like_text("\u{1}\u{2}\u{3}\u{4}"));
        assert!(looks_like_text("普通讲义内容"));
    }
}
