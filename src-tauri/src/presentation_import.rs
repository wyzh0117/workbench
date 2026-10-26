//! Read PresentationML style facts and append a slide by copying a source slide.
//!
//! The package writer keeps every original part payload and changes only the
//! presentation index, content types, and relationships needed by new slides.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::ops::Range;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use quick_xml::XmlVersion;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const MAX_SOURCE_BYTES: usize = 256 * 1024 * 1024;
const MAX_PART_BYTES: usize = 64 * 1024 * 1024;
const MAX_PACKAGE_PARTS: usize = 20_000;
const MAX_XML_EVENTS: usize = 4_000_000;
const MAX_PREVIEW_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PREVIEW_INLINE_BYTES: usize = 32 * 1024 * 1024;
const A_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const RELATIONSHIPS_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P_NS: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidatedSlideSpec {
    pub layout_ref: String,
    pub title: String,
    pub body: Vec<SlideBodyItem>,
    pub image_asset_ids: Vec<String>,
    pub source_ids: Vec<String>,
    pub speaker_notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SlideBodyItem {
    pub kind: SlideBodyKind,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SlideBodyKind {
    Paragraph,
    Bullet,
}

/// Image bytes resolved by the trusted asset service. The canonical slide spec
/// stores only IDs; bytes must never come from an arbitrary UI path.
#[derive(Debug, Clone)]
pub struct ResolvedPresentationImage {
    pub asset_id: String,
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub extension: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StyleExtractionReport {
    pub source_sha256: String,
    pub presentation_part: String,
    pub slide_count: usize,
    pub ordered_slides: Vec<OrderedSlide>,
    pub slide_width_emu: Option<u64>,
    pub slide_height_emu: Option<u64>,
    pub variants: Vec<StyleVariant>,
    pub representative_previews: Vec<RepresentativeSlidePreview>,
    pub extraction_facts: Vec<String>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OrderedSlide {
    pub slide_id: String,
    pub order: usize,
    pub part: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepresentativeSlidePreview {
    pub source_sha256: String,
    pub variant_id: String,
    pub slide_part: String,
    pub width_emu: Option<u64>,
    pub height_emu: Option<u64>,
    pub format: String,
    pub svg: String,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StyleVariant {
    pub id: String,
    pub master_part: String,
    pub theme_part: Option<String>,
    pub layout_part: String,
    pub slide_parts: Vec<String>,
    pub representative_slide_part: String,
    pub theme_colors: Vec<ThemeColor>,
    pub theme_fonts: Vec<ThemeFont>,
    pub placeholders: Vec<PlaceholderFact>,
    pub representative_objects: Vec<PresentationObjectFact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ThemeColor {
    pub slot: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ThemeFont {
    pub scheme: String,
    pub script: String,
    pub typeface: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlaceholderFact {
    pub placeholder_type: String,
    pub index: Option<String>,
    pub shape_name: Option<String>,
    pub inheritance_source: String,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PresentationObjectFact {
    pub kind: String,
    pub name: Option<String>,
    pub placeholder_type: Option<String>,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fill: Option<String>,
    pub line: Option<String>,
    pub font_sizes_hundredth_pt: Vec<u32>,
    pub text_run_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SlideSizeEmu {
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EditableStyleRule {
    pub font_size_hundredth_pt: Option<i64>,
    pub color: Option<String>,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EditableStyleRules {
    pub title: EditableStyleRule,
    pub body: EditableStyleRule,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PresentationStyleTokens {
    pub slide_size_emu: SlideSizeEmu,
    pub theme_colors: Vec<ThemeColor>,
    pub theme_fonts: Vec<ThemeFont>,
    pub placeholders: Vec<PlaceholderFact>,
    pub representative_objects: Vec<PresentationObjectFact>,
    pub editable_rules: EditableStyleRules,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannedSlidePreview {
    pub format: String,
    pub svg: String,
    pub limitations: Vec<String>,
    pub slide_width_emu: Option<u64>,
    pub slide_height_emu: Option<u64>,
}

#[derive(Debug, Clone)]
struct PackagePart {
    name: String,
    bytes: Vec<u8>,
    is_dir: bool,
}

#[derive(Debug, Clone)]
struct Package {
    parts: Vec<PackagePart>,
    index: HashMap<String, usize>,
}

#[derive(Debug, Clone)]
struct Relationship {
    id: String,
    kind: String,
    target: String,
    target_mode: Option<String>,
}

#[derive(Debug, Clone)]
struct SlideRecord {
    slide_id: String,
    part: String,
}

#[derive(Debug, Clone)]
struct Presentation {
    part: String,
    relationships: Vec<Relationship>,
    slides: Vec<SlideRecord>,
}

#[derive(Debug, Default)]
struct ParsedTheme {
    colors: Vec<ThemeColor>,
    fonts: Vec<ThemeFont>,
}

#[derive(Debug, Clone)]
struct ShapeFact {
    kind: String,
    name: Option<String>,
    placeholder_type: Option<String>,
    placeholder_index: Option<String>,
    x: Option<i64>,
    y: Option<i64>,
    width: Option<i64>,
    height: Option<i64>,
    fill: Option<String>,
    line: Option<String>,
    font_sizes: Vec<u32>,
    text_run_count: usize,
    text: String,
    image_embed_id: Option<String>,
}

#[derive(Debug, Clone)]
struct XmlRange {
    element: Range<usize>,
    inner: Range<usize>,
    qname: String,
    empty: bool,
}

/// Extract structural facts from a `.pptx` package. Visual inference remains a
/// separate pass and is intentionally not fabricated here.
pub fn inspect_pptx(bytes: &[u8]) -> Result<StyleExtractionReport, String> {
    let package = read_package(bytes)?;
    inspect_package(&package, bytes)
}

/// Extract source-addressable text in presentation order for discovery.
/// Each returned row maps to one slide and one editable text shape.
pub(crate) fn extract_slide_text(bytes: &[u8]) -> Result<Vec<(usize, String)>, String> {
    let package = read_package(bytes)?;
    let presentation = read_presentation(&package)?;
    let mut blocks = Vec::new();
    let mut total_chars = 0usize;
    for (index, slide) in presentation.slides.iter().enumerate() {
        let xml = package
            .get(&slide.part)
            .ok_or_else(|| format!("PPTX 缺少幻灯片部件：{}", slide.part))?;
        for shape in parse_shapes(xml)? {
            let text = shape.text.trim();
            if text.is_empty() {
                continue;
            }
            total_chars = total_chars.saturating_add(text.chars().count());
            if total_chars > 8_000_000 || blocks.len() >= 20_000 {
                return Err("PPTX 正文超过资源发现读取上限。".to_owned());
            }
            blocks.push((index + 1, text.to_owned()));
        }
    }
    Ok(blocks)
}

/// Copy an existing representative slide, replace its supported editable
/// title/body text and image slots, then append it to the same OPC package.
/// `template_slide_part` must be a slide part selected from the matching
/// `StyleVariant`; it is not a slide-layout part.
pub fn append_slide_copy(
    source_bytes: &[u8],
    template_slide_part: &str,
    spec: &ValidatedSlideSpec,
    style_tokens: &PresentationStyleTokens,
    resolved_images: &[ResolvedPresentationImage],
) -> Result<Vec<u8>, String> {
    insert_slide_copy(
        source_bytes,
        template_slide_part,
        spec,
        style_tokens,
        resolved_images,
        None,
    )
}

/// Copy a representative slide and insert it after the selected existing
/// slide ID, or at the end when `insert_after_slide_id` is `None`.
pub fn insert_slide_copy(
    source_bytes: &[u8],
    template_slide_part: &str,
    spec: &ValidatedSlideSpec,
    style_tokens: &PresentationStyleTokens,
    resolved_images: &[ResolvedPresentationImage],
    insert_after_slide_id: Option<&str>,
) -> Result<Vec<u8>, String> {
    validate_spec(spec, resolved_images)?;
    validate_slide_part_name(template_slide_part)?;
    let mut package = read_package(source_bytes)?;
    let report = inspect_package(&package, source_bytes)?;
    let variant = report
        .variants
        .iter()
        .find(|variant| {
            variant
                .slide_parts
                .iter()
                .any(|part| part == template_slide_part)
        })
        .ok_or_else(|| "模板页不属于当前 PPTX 的任何已提取 variant。".to_owned())?;
    if spec.layout_ref != variant.id {
        return Err(format!(
            "SlideSpec layout_ref 与模板页 variant 不一致：{} != {}",
            spec.layout_ref, variant.id
        ));
    }
    validate_style_tokens(style_tokens, &report, variant)?;

    let mut presentation = read_presentation(&package)?;
    let source_slide = package
        .get(template_slide_part)
        .ok_or_else(|| format!("模板页不存在：{template_slide_part}"))?
        .to_vec();
    let source_rels_part = relationship_part(template_slide_part);
    let source_rels_xml = package
        .get(&source_rels_part)
        .ok_or_else(|| format!("模板页关系文件不存在：{source_rels_part}"))?;
    let mut slide_rels = parse_relationships(source_rels_xml)?;
    let source_layout = slide_rels
        .iter()
        .find(|relation| relation.kind.ends_with("/slideLayout") && relation.target_mode.is_none())
        .ok_or_else(|| "模板页没有可用的内部 slideLayout 关系。".to_owned())?;
    let actual_layout_part = resolve_target(template_slide_part, &source_layout.target)?;
    if actual_layout_part != variant.layout_part {
        return Err("模板页的实际 layout 与已提取的 variant 已变化。".to_owned());
    }

    let new_slide_part = next_slide_part(&package)?;
    let new_slide_index = slide_index(&new_slide_part)?;
    let mut slide_xml = replace_slide_text(&source_slide, spec)?;
    apply_editable_style_rules(
        &mut slide_xml,
        style_tokens,
        report.slide_width_emu,
        report.slide_height_emu,
    )?;
    let image_relationships = add_resolved_images(
        &mut package,
        &mut slide_xml,
        &mut slide_rels,
        &new_slide_part,
        new_slide_index,
        resolved_images,
    )?;
    let notes_parts = add_notes_if_supported(
        &mut package,
        &mut presentation,
        &mut slide_rels,
        &new_slide_part,
        variant.theme_part.as_deref(),
        spec,
    )?;

    let new_slide_rels_part = relationship_part(&new_slide_part);
    let new_slide_rels_xml = serialize_relationships(&slide_rels);
    package.insert(new_slide_part.clone(), slide_xml, false)?;
    package.insert(new_slide_rels_part, new_slide_rels_xml.into_bytes(), false)?;

    let mut presentation_xml = package
        .get(&presentation.part)
        .ok_or_else(|| "PPTX presentation.xml 不存在。".to_owned())?
        .to_vec();
    let new_slide_rel_id = next_relationship_id(&presentation.relationships);
    let new_slide_id = next_slide_id(&presentation_xml)?;
    presentation_xml = insert_slide_id_after(
        &presentation_xml,
        &new_slide_id,
        &new_slide_rel_id,
        insert_after_slide_id,
    )?;
    package.insert(presentation.part.clone(), presentation_xml, false)?;

    let mut presentation_rels = presentation.relationships;
    presentation_rels.push(Relationship {
        id: new_slide_rel_id,
        kind: format!("{OFFICE_REL_NS}/slide"),
        target: relative_target(&presentation.part, &new_slide_part),
        target_mode: None,
    });
    let presentation_rels_xml = serialize_relationships(&presentation_rels);
    package.insert(
        relationship_part(&presentation.part),
        presentation_rels_xml.into_bytes(),
        false,
    )?;

    let mut content_types = package
        .get("[Content_Types].xml")
        .ok_or_else(|| "PPTX Content_Types.xml 不存在。".to_owned())?
        .to_vec();
    content_types = add_content_type_override(
        &content_types,
        &format!("/{new_slide_part}"),
        "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
    )?;
    for (part, content_type) in notes_parts.content_types {
        content_types =
            add_content_type_override(&content_types, &format!("/{part}"), &content_type)?;
    }
    for (extension, content_type) in image_relationships.content_types {
        content_types = add_default_content_type(&content_types, &extension, &content_type)?;
    }
    package.insert("[Content_Types].xml".to_owned(), content_types, false)?;

    write_package(package)
}

/// Export only the newly appended slide and the OPC parts it depends on.
/// The source package is used as a template but is never written in place.
pub fn single_slide_copy(
    source_bytes: &[u8],
    template_slide_part: &str,
    spec: &ValidatedSlideSpec,
    style_tokens: &PresentationStyleTokens,
    resolved_images: &[ResolvedPresentationImage],
) -> Result<Vec<u8>, String> {
    single_slide_copy_after(
        source_bytes,
        template_slide_part,
        spec,
        style_tokens,
        resolved_images,
        None,
    )
}

/// Export only the inserted slide and its reachable dependencies.
pub fn single_slide_copy_after(
    source_bytes: &[u8],
    template_slide_part: &str,
    spec: &ValidatedSlideSpec,
    style_tokens: &PresentationStyleTokens,
    resolved_images: &[ResolvedPresentationImage],
    insert_after_slide_id: Option<&str>,
) -> Result<Vec<u8>, String> {
    let source_package = read_package(source_bytes)?;
    let new_slide_part = next_slide_part(&source_package)?;
    let appended = insert_slide_copy(
        source_bytes,
        template_slide_part,
        spec,
        style_tokens,
        resolved_images,
        insert_after_slide_id,
    )?;
    let mut package = read_package(&appended)?;
    let presentation = read_presentation(&package)?;
    let new_slide_relation = presentation
        .relationships
        .iter()
        .find(|relation| {
            relation.kind.ends_with("/slide")
                && relation.target_mode.is_none()
                && resolve_target(&presentation.part, &relation.target)
                    .is_ok_and(|target| target == new_slide_part)
        })
        .ok_or_else(|| "single 导出找不到新增页的 presentation 关系。".to_owned())?;
    let new_slide_relation_id = new_slide_relation.id.clone();

    let presentation_xml = package
        .get(&presentation.part)
        .ok_or_else(|| "single 导出缺少 presentation.xml。".to_owned())?;
    let presentation_xml = retain_one_slide_id(presentation_xml, &new_slide_relation_id)?;
    package.insert(presentation.part.clone(), presentation_xml, false)?;
    let presentation_relations = presentation
        .relationships
        .into_iter()
        .filter(|relation| {
            !relation.kind.ends_with("/slide") || relation.id == new_slide_relation_id
        })
        .collect::<Vec<_>>();
    package.insert(
        relationship_part(&presentation.part),
        serialize_relationships(&presentation_relations).into_bytes(),
        false,
    )?;

    drop_single_package_metadata(&mut package)?;
    prune_unreachable_parts(&mut package)?;
    let output = write_package(package)?;
    let final_package = read_package(&output)?;
    let final_presentation = read_presentation(&final_package)?;
    if final_presentation.slides.len() != 1 || final_presentation.slides[0].part != new_slide_part {
        return Err("single 导出包裁剪后未保留且仅保留新增幻灯片。".to_owned());
    }
    Ok(output)
}

pub fn preview_slide_copy(
    source_bytes: &[u8],
    template_slide_part: &str,
    spec: &ValidatedSlideSpec,
    style_tokens: &PresentationStyleTokens,
    resolved_images: &[ResolvedPresentationImage],
) -> Result<PlannedSlidePreview, String> {
    let planned_package = append_slide_copy(
        source_bytes,
        template_slide_part,
        spec,
        style_tokens,
        resolved_images,
    )?;
    let package = read_package(&planned_package)?;
    let presentation = read_presentation(&package)?;
    let slide_part = &presentation
        .slides
        .last()
        .ok_or_else(|| "预览包没有新增幻灯片。".to_owned())?
        .part;
    let slide_xml = package
        .get(slide_part)
        .ok_or_else(|| format!("新增预览页缺失：{slide_part}"))?;
    let relations = parse_relationships(
        package
            .get(&relationship_part(slide_part))
            .ok_or_else(|| format!("新增预览页关系文件缺失：{slide_part}"))?,
    )?;
    let width_emu = style_tokens
        .slide_size_emu
        .width
        .and_then(|value| u64::try_from(value).ok());
    let height_emu = style_tokens
        .slide_size_emu
        .height
        .and_then(|value| u64::try_from(value).ok());
    let rendered = render_structural_preview(
        &package,
        slide_part,
        slide_xml,
        &relations,
        &spec.layout_ref,
        &sha256_hex(source_bytes),
        width_emu,
        height_emu,
        &style_tokens.theme_colors,
    )?;
    Ok(PlannedSlidePreview {
        format: rendered.format,
        svg: rendered.svg,
        limitations: rendered.limitations,
        slide_width_emu: rendered.width_emu,
        slide_height_emu: rendered.height_emu,
    })
}

fn validate_style_tokens(
    tokens: &PresentationStyleTokens,
    report: &StyleExtractionReport,
    variant: &StyleVariant,
) -> Result<(), String> {
    let source_width = report
        .slide_width_emu
        .and_then(|value| i64::try_from(value).ok());
    let source_height = report
        .slide_height_emu
        .and_then(|value| i64::try_from(value).ok());
    if tokens.slide_size_emu.width != source_width || tokens.slide_size_emu.height != source_height
    {
        return Err("StyleTokens 的画布尺寸与当前 PPTX 来源不匹配。".to_owned());
    }
    if tokens.theme_colors != variant.theme_colors
        || tokens.theme_fonts != variant.theme_fonts
        || tokens.placeholders != variant.placeholders
        || tokens.representative_objects != variant.representative_objects
    {
        return Err("StyleTokens 的结构事实与当前代表页 variant 不匹配。".to_owned());
    }
    for (slot, rule) in [
        ("title", &tokens.editable_rules.title),
        ("body", &tokens.editable_rules.body),
    ] {
        if rule
            .font_size_hundredth_pt
            .is_some_and(|size| !(100..=400_000).contains(&size))
        {
            return Err(format!(
                "{}.font_size_hundredth_pt 必须在 100–400000 之间。",
                slot
            ));
        }
        if rule
            .color
            .as_deref()
            .is_some_and(|color| !is_hex_color(color))
        {
            return Err(format!("{}.color 必须是 #RRGGBB。", slot));
        }
    }
    Ok(())
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn retain_one_slide_id(xml: &[u8], relationship_id: &str) -> Result<Vec<u8>, String> {
    let ranges = xml_elements(xml, "sldId")?;
    let mut output = xml.to_vec();
    let mut retained = 0usize;
    for range in ranges.into_iter().rev() {
        let attributes = attributes_in_element(&output, &range)?;
        let id = attributes
            .iter()
            .find(|(key, _)| key.ends_with(":id"))
            .map(|(_, value)| value.as_str());
        if id == Some(relationship_id) {
            retained += 1;
        } else {
            output.splice(range.element, std::iter::empty());
        }
    }
    if retained != 1 {
        return Err("single 导出要求 presentation.xml 中恰有一个新增页 ID。".to_owned());
    }
    Ok(output)
}

fn prune_unreachable_parts(package: &mut Package) -> Result<(), String> {
    let root_relationships = package
        .get("_rels/.rels")
        .ok_or_else(|| "single 导出缺少包级关系文件。".to_owned())?;
    let mut reachable = HashSet::from(["_rels/.rels".to_owned(), "[Content_Types].xml".to_owned()]);
    let mut pending = Vec::<String>::new();
    for relation in parse_relationships(root_relationships)? {
        if relation.target_mode.as_deref() == Some("External") {
            continue;
        }
        pending.push(resolve_target("", &relation.target)?);
    }

    while let Some(part_name) = pending.pop() {
        if !reachable.insert(part_name.clone()) {
            continue;
        }
        if !package.index.contains_key(&part_name) {
            return Err(format!("single 导出依赖关系指向缺失部件：{part_name}"));
        }
        let rels_part = relationship_part(&part_name);
        if let Some(rels_xml) = package.get(&rels_part) {
            reachable.insert(rels_part);
            for relation in parse_relationships(rels_xml)? {
                if relation.target_mode.as_deref() == Some("External") {
                    continue;
                }
                pending.push(resolve_target(&part_name, &relation.target)?);
            }
        }
    }

    let content_types = package
        .get("[Content_Types].xml")
        .ok_or_else(|| "single 导出缺少 Content_Types.xml。".to_owned())?;
    let filtered_types = retain_reachable_content_types(content_types, &reachable)?;
    package.insert("[Content_Types].xml".to_owned(), filtered_types, false)?;

    package.parts.retain(|part| {
        if !part.is_dir {
            return reachable.contains(&part.name);
        }
        let directory = part.name.trim_end_matches('/');
        reachable
            .iter()
            .any(|name| name.starts_with(&format!("{directory}/")))
    });
    package.index.clear();
    for (index, part) in package.parts.iter().enumerate() {
        package.index.insert(part.name.clone(), index);
    }
    Ok(())
}

fn drop_single_package_metadata(package: &mut Package) -> Result<(), String> {
    let relationship_parts = package
        .parts
        .iter()
        .filter(|part| !part.is_dir && part.name.ends_with(".rels"))
        .map(|part| part.name.clone())
        .collect::<Vec<_>>();
    for relationship_part_name in relationship_parts {
        let source_part = if relationship_part_name == "_rels/.rels" {
            String::new()
        } else {
            let (directory, filename) = relationship_part_name
                .rsplit_once("/_rels/")
                .ok_or_else(|| format!("关系部件路径无效：{relationship_part_name}"))?;
            let filename = filename
                .strip_suffix(".rels")
                .ok_or_else(|| format!("关系部件后缀无效：{relationship_part_name}"))?;
            format!("{directory}/{filename}")
        };
        let relations = parse_relationships(
            package
                .get(&relationship_part_name)
                .ok_or_else(|| format!("关系部件消失：{relationship_part_name}"))?,
        )?;
        let filtered = if relationship_part_name == "_rels/.rels" {
            let office_document = relations
                .into_iter()
                .filter(|relation| relation.kind.ends_with("/officeDocument"))
                .collect::<Vec<_>>();
            if office_document.len() != 1 {
                return Err("single 导出要求唯一的 package officeDocument 关系。".to_owned());
            }
            office_document
        } else {
            relations
                .into_iter()
                .filter(|relation| {
                    if relation.target_mode.as_deref() == Some("External") {
                        return true;
                    }
                    let target = resolve_target(&source_part, &relation.target).ok();
                    let is_metadata_part = target.as_deref().is_some_and(|part| {
                        part.starts_with("docProps/") || part.starts_with("customXml/")
                    });
                    let is_metadata_relation = [
                        "/core-properties",
                        "/extended-properties",
                        "/custom-properties",
                        "/thumbnail",
                    ]
                    .iter()
                    .any(|suffix| relation.kind.ends_with(suffix));
                    !is_metadata_part && !is_metadata_relation
                })
                .collect::<Vec<_>>()
        };
        package.insert(
            relationship_part_name,
            serialize_relationships(&filtered).into_bytes(),
            false,
        )?;
    }
    Ok(())
}

fn retain_reachable_content_types(
    xml: &[u8],
    reachable: &HashSet<String>,
) -> Result<Vec<u8>, String> {
    let mut output = xml.to_vec();
    let ranges = xml_elements(xml, "Override")?;
    for range in ranges.into_iter().rev() {
        let attributes = attributes_in_element(xml, &range)?;
        let part_name = attributes
            .get("PartName")
            .ok_or_else(|| "Content_Types Override 缺少 PartName。".to_owned())?;
        let part_name = part_name.trim_start_matches('/');
        if !reachable.contains(part_name) {
            output.splice(range.element, std::iter::empty());
        }
    }
    Ok(output)
}

fn style_rule_has_values(rule: &EditableStyleRule) -> bool {
    rule.font_size_hundredth_pt.is_some()
        || rule.color.is_some()
        || rule.x.is_some()
        || rule.y.is_some()
        || rule.width.is_some()
        || rule.height.is_some()
}

fn apply_editable_style_rules(
    slide_xml: &mut Vec<u8>,
    tokens: &PresentationStyleTokens,
    slide_width_emu: Option<u64>,
    slide_height_emu: Option<u64>,
) -> Result<(), String> {
    let title_rule = &tokens.editable_rules.title;
    let body_rule = &tokens.editable_rules.body;
    if !style_rule_has_values(title_rule) && !style_rule_has_values(body_rule) {
        return Ok(());
    }

    let mut shapes = Vec::<(XmlRange, ShapeFact)>::new();
    for range in xml_elements(slide_xml, "sp")? {
        let fact = parse_shapes(&slide_xml[range.element.clone()])?
            .into_iter()
            .next()
            .unwrap_or_else(|| empty_shape("sp".to_owned()));
        if fact.text_run_count > 0 {
            shapes.push((range, fact));
        }
    }
    let title_index = shapes
        .iter()
        .position(|(_, shape)| is_title_shape(shape))
        .or_else(|| (!shapes.is_empty()).then_some(0));
    if title_index.is_none() && style_rule_has_values(title_rule) {
        return Err("StyleTokens title rule has no supported title text placeholder.".to_owned());
    }
    let body_indices = shapes
        .iter()
        .enumerate()
        .filter(|(index, (_, shape))| Some(*index) != title_index && is_body_shape(shape))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let body_indices = if body_indices.is_empty() {
        shapes
            .iter()
            .enumerate()
            .filter(|(index, _)| Some(*index) != title_index)
            .map(|(index, _)| index)
            .collect::<Vec<_>>()
    } else {
        body_indices
    };
    if style_rule_has_values(body_rule) && body_indices.is_empty() {
        return Err("StyleTokens body rule has no supported body text placeholder.".to_owned());
    }

    let mut replacements = Vec::<(Range<usize>, Vec<u8>)>::new();
    if style_rule_has_values(title_rule) {
        let index = title_index.expect("title rule validated above");
        let (range, shape) = &shapes[index];
        replacements.push((
            range.element.clone(),
            apply_style_rule_to_shape(
                &slide_xml[range.element.clone()],
                shape,
                title_rule,
                tokens,
                slide_width_emu,
                slide_height_emu,
            )?,
        ));
    }
    if style_rule_has_values(body_rule) {
        for index in body_indices {
            let (range, shape) = &shapes[index];
            replacements.push((
                range.element.clone(),
                apply_style_rule_to_shape(
                    &slide_xml[range.element.clone()],
                    shape,
                    body_rule,
                    tokens,
                    slide_width_emu,
                    slide_height_emu,
                )?,
            ));
        }
    }
    replacements.sort_by_key(|(range, _)| range.start);
    for (range, replacement) in replacements.into_iter().rev() {
        slide_xml.splice(range, replacement);
    }
    Ok(())
}

fn is_title_shape(shape: &ShapeFact) -> bool {
    shape
        .placeholder_type
        .as_deref()
        .is_some_and(|kind| matches!(kind, "title" | "ctrTitle" | "subTitle"))
        || shape.name.as_deref().is_some_and(|name| {
            let name = name.to_ascii_lowercase();
            name.contains("title") || name.contains("heading") || name.contains("标题")
        })
}

fn is_body_shape(shape: &ShapeFact) -> bool {
    let name = shape
        .name
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    shape
        .placeholder_type
        .as_deref()
        .is_some_and(|kind| matches!(kind, "body" | "obj" | "subTitle"))
        || name.contains("paragraph")
        || name.contains("body")
        || name.contains("content")
        || name.contains("正文")
        || name.contains("段落")
}

fn matching_placeholder_fact<'a>(
    shape: &ShapeFact,
    placeholders: &'a [PlaceholderFact],
) -> Option<&'a PlaceholderFact> {
    let kind = shape.placeholder_type.as_deref()?;
    let candidates = placeholders
        .iter()
        .filter(|item| item.placeholder_type == kind)
        .collect::<Vec<_>>();
    candidates
        .iter()
        .copied()
        .find(|item| {
            item.index == shape.placeholder_index
                && (shape.name.is_none() || item.shape_name.as_deref() == shape.name.as_deref())
        })
        .or_else(|| (candidates.len() == 1).then(|| candidates[0]))
}

fn validate_geometry(
    x: i64,
    y: i64,
    width: i64,
    height: i64,
    slide_width_emu: Option<u64>,
    slide_height_emu: Option<u64>,
) -> Result<(), String> {
    let slide_width = slide_width_emu
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(|| "画布宽度未知，无法验证样式几何。".to_owned())?;
    let slide_height = slide_height_emu
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(|| "画布高度未知，无法验证样式几何。".to_owned())?;
    if x < 0
        || y < 0
        || width <= 0
        || height <= 0
        || x.checked_add(width).is_none_or(|right| right > slide_width)
        || y.checked_add(height)
            .is_none_or(|bottom| bottom > slide_height)
    {
        return Err("样式几何超出画布或包含非正尺寸。".to_owned());
    }
    Ok(())
}

fn apply_style_rule_to_shape(
    shape_xml: &[u8],
    shape: &ShapeFact,
    rule: &EditableStyleRule,
    tokens: &PresentationStyleTokens,
    slide_width_emu: Option<u64>,
    slide_height_emu: Option<u64>,
) -> Result<Vec<u8>, String> {
    let mut output = shape_xml.to_vec();
    if rule.font_size_hundredth_pt.is_some() || rule.color.is_some() {
        let runs = xml_elements(&output, "r")?;
        if runs.is_empty() {
            return Err("StyleTokens 字号/颜色规则要求包含可编辑的文本 run。".to_owned());
        }
        for range in runs.into_iter().rev() {
            let updated = apply_run_style(&output[range.element.clone()], rule)?;
            output.splice(range.element, updated);
        }
    }
    if rule.x.is_some() || rule.y.is_some() || rule.width.is_some() || rule.height.is_some() {
        let placeholder = matching_placeholder_fact(shape, &tokens.placeholders);
        let x = rule
            .x
            .or(shape.x)
            .or_else(|| placeholder.and_then(|item| item.x))
            .ok_or_else(|| "样式规则无法解析标题/正文原始 x 坐标。".to_owned())?;
        let y = rule
            .y
            .or(shape.y)
            .or_else(|| placeholder.and_then(|item| item.y))
            .ok_or_else(|| "样式规则无法解析标题/正文原始 y 坐标。".to_owned())?;
        let width = rule
            .width
            .or(shape.width)
            .or_else(|| placeholder.and_then(|item| item.width))
            .ok_or_else(|| "样式规则无法解析标题/正文原始宽度。".to_owned())?;
        let height = rule
            .height
            .or(shape.height)
            .or_else(|| placeholder.and_then(|item| item.height))
            .ok_or_else(|| "样式规则无法解析标题/正文原始高度。".to_owned())?;
        validate_geometry(x, y, width, height, slide_width_emu, slide_height_emu)?;
        apply_shape_geometry(&output, x, y, width, height)
    } else {
        Ok(output)
    }
}

fn apply_shape_geometry(
    shape_xml: &[u8],
    x: i64,
    y: i64,
    width: i64,
    height: i64,
) -> Result<Vec<u8>, String> {
    if !xml_elements(shape_xml, "xfrm")?.is_empty() {
        let mut output = replace_attribute_value(shape_xml, "off", "x", &x.to_string())?;
        output = replace_attribute_value(&output, "off", "y", &y.to_string())?;
        output = replace_attribute_value(&output, "ext", "cx", &width.to_string())?;
        return replace_attribute_value(&output, "ext", "cy", &height.to_string());
    }
    let sp_pr = xml_elements(shape_xml, "spPr")?
        .into_iter()
        .next()
        .ok_or_else(|| "目标文本框没有 spPr，无法安全应用几何。".to_owned())?;
    let sp_tag = sp_pr.qname;
    let drawing_prefix = qname_for(shape_xml, "t")?
        .and_then(|name| name.split_once(':').map(|(prefix, _)| prefix.to_owned()))
        .unwrap_or_else(|| "a".to_owned());
    let transform = format!(
        "<{drawing_prefix}:xfrm><{drawing_prefix}:off x=\"{x}\" y=\"{y}\"/><{drawing_prefix}:ext cx=\"{width}\" cy=\"{height}\"/></{drawing_prefix}:xfrm>"
    );
    let mut output = shape_xml.to_vec();
    if sp_pr.empty {
        let expanded = format!("<{sp_tag}>{transform}</{sp_tag}>");
        output.splice(sp_pr.element, expanded.bytes());
    } else {
        let after_open = start_tag_end(&output, "spPr")?
            .ok_or_else(|| "目标文本框 spPr 起始标签缺失。".to_owned())?;
        output.splice(after_open..after_open, transform.bytes());
    }
    Ok(output)
}

fn apply_run_style(run_xml: &[u8], rule: &EditableStyleRule) -> Result<Vec<u8>, String> {
    let mut output = run_xml.to_vec();
    let ranges = xml_elements(&output, "rPr")?;
    if let Some(range) = ranges.first() {
        let mut rpr = output[range.element.clone()].to_vec();
        if let Some(size) = rule.font_size_hundredth_pt {
            rpr = set_element_attribute(&rpr, "rPr", "sz", &size.to_string())?;
        }
        if let Some(color) = rule.color.as_deref() {
            rpr = set_run_color(&rpr, color)?;
        }
        output.splice(range.element.clone(), rpr);
        return Ok(output);
    }

    let prefix = qname_for(&output, "t")?
        .and_then(|name| name.split_once(':').map(|(prefix, _)| prefix.to_owned()))
        .unwrap_or_else(|| "a".to_owned());
    let size = rule
        .font_size_hundredth_pt
        .map(|value| format!(" sz=\"{value}\""))
        .unwrap_or_default();
    let fill = rule
        .color
        .as_deref()
        .map(|color| {
            format!(
                "<{prefix}:solidFill><{prefix}:srgbClr val=\"{}\"/></{prefix}:solidFill>",
                &color[1..]
            )
        })
        .unwrap_or_default();
    let fragment = format!("<{prefix}:rPr{size}>{fill}</{prefix}:rPr>");
    let after_open =
        start_tag_end(&output, "r")?.ok_or_else(|| "文本 run 起始标签缺失。".to_owned())?;
    output.splice(after_open..after_open, fragment.bytes());
    Ok(output)
}

fn set_element_attribute(
    xml: &[u8],
    element: &str,
    attribute: &str,
    value: &str,
) -> Result<Vec<u8>, String> {
    let range = xml_elements(xml, element)?
        .into_iter()
        .next()
        .ok_or_else(|| format!("缺少 {element} 样式节点。"))?;
    let attrs = attributes_in_element(xml, &range)?;
    if attrs.keys().any(|key| local_name(key) == attribute) {
        return replace_attribute_value(xml, element, attribute, value);
    }
    let mut output = xml.to_vec();
    if range.empty {
        let tag = &xml[range.element.clone()];
        let close = tag
            .iter()
            .rposition(|byte| *byte == b'/')
            .ok_or_else(|| format!("{element} 空标签无法扩展。"))?;
        let insertion = range.element.start + close;
        output.splice(
            insertion..insertion,
            format!(" {attribute}=\"{}\"", escape_xml_attr(value)).bytes(),
        );
    } else {
        let start =
            start_tag_end(xml, element)?.ok_or_else(|| format!("{element} 起始标签缺失。"))?;
        let insertion = start.saturating_sub(1);
        output.splice(
            insertion..insertion,
            format!(" {attribute}=\"{}\"", escape_xml_attr(value)).bytes(),
        );
    }
    Ok(output)
}

fn set_run_color(rpr_xml: &[u8], color: &str) -> Result<Vec<u8>, String> {
    let rpr = xml_elements(rpr_xml, "rPr")?
        .into_iter()
        .next()
        .ok_or_else(|| "文本 run 缺少 rPr。".to_owned())?;
    let prefix = rpr
        .qname
        .rsplit_once(':')
        .map(|(prefix, _)| prefix)
        .unwrap_or("a");
    let replacement = format!(
        "<{prefix}:solidFill><{prefix}:srgbClr val=\"{}\"/></{prefix}:solidFill>",
        &color[1..]
    );
    if let Some(fill) = xml_elements(rpr_xml, "solidFill")?.into_iter().next() {
        let mut output = rpr_xml.to_vec();
        output.splice(fill.element, replacement.bytes());
        return Ok(output);
    }
    if rpr.empty {
        let raw = &rpr_xml[rpr.element.clone()];
        let start_tag = raw
            .strip_suffix(b"/>")
            .ok_or_else(|| "rPr 空标签格式无效。".to_owned())?;
        let close = format!("</{}>", rpr.qname);
        let expanded = [start_tag, b">", replacement.as_bytes(), close.as_bytes()].concat();
        let mut output = rpr_xml.to_vec();
        output.splice(rpr.element, expanded);
        Ok(output)
    } else {
        insert_before_end(rpr_xml, "rPr", replacement.as_bytes())
    }
}

fn validate_spec(
    spec: &ValidatedSlideSpec,
    images: &[ResolvedPresentationImage],
) -> Result<(), String> {
    if spec.layout_ref.trim().is_empty() || spec.title.len() > 20_000 {
        return Err("SlideSpec 缺少 layout_ref 或标题过长。".to_owned());
    }
    if spec.body.len() > 256 || spec.speaker_notes.len() > 100_000 {
        return Err("SlideSpec 正文或备注超过安全上限。".to_owned());
    }
    if spec.body.iter().any(|item| item.text.len() > 20_000) {
        return Err("SlideSpec 正文项过长。".to_owned());
    }
    if spec.image_asset_ids.len() != images.len() {
        return Err("图片素材 ID 与可信解析后的图片字节数量不一致。".to_owned());
    }
    let mut seen = HashSet::new();
    for (expected, image) in spec.image_asset_ids.iter().zip(images) {
        if expected != &image.asset_id || !seen.insert(&image.asset_id) {
            return Err("图片素材解析结果与 SlideSpec 引用不一致或重复。".to_owned());
        }
        if image.bytes.is_empty() || image.bytes.len() > MAX_PART_BYTES {
            return Err(format!("图片素材 {} 为空或超过大小上限。", image.asset_id));
        }
        let (expected_type, expected_ext) = match image.extension.to_ascii_lowercase().as_str() {
            "png" => ("image/png", "png"),
            "jpg" | "jpeg" => ("image/jpeg", "jpg"),
            _ => return Err("PPTX 追加页当前只支持 PNG 与 JPEG 图片。".to_owned()),
        };
        if image.content_type.to_ascii_lowercase() != expected_type {
            return Err(format!(
                "图片素材 {} 的 MIME 类型与扩展名不一致。",
                image.asset_id
            ));
        }
        let has_valid_signature = match expected_type {
            "image/png" => image.bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg" => image.bytes.starts_with(b"\xff\xd8"),
            _ => false,
        };
        if !has_valid_signature {
            return Err(format!(
                "图片素材 {} 的字节签名与声明类型不匹配。",
                image.asset_id
            ));
        }
        let _ = expected_ext;
    }
    Ok(())
}

fn validate_slide_part_name(part: &str) -> Result<(), String> {
    if !part.starts_with("ppt/slides/slide")
        || !part.ends_with(".xml")
        || part.contains("..")
        || part.contains('\\')
        || part.contains(':')
    {
        return Err("模板页必须是包内 ppt/slides/slideN.xml 部件。".to_owned());
    }
    slide_index(part).map(|_| ())
}

fn read_package(bytes: &[u8]) -> Result<Package, String> {
    if bytes.is_empty() || bytes.len() > MAX_SOURCE_BYTES {
        return Err("PPTX 文件为空或超过 256 MiB 上限。".to_owned());
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("输入不是有效的 PPTX/ZIP 包：{error}"))?;
    if archive.len() > MAX_PACKAGE_PARTS {
        return Err("PPTX 部件数量超过安全上限。".to_owned());
    }
    let mut parts = Vec::with_capacity(archive.len());
    let mut index = HashMap::with_capacity(archive.len());
    let mut total = 0usize;
    for part_index in 0..archive.len() {
        let mut file = archive
            .by_index(part_index)
            .map_err(|error| format!("PPTX 部件读取失败：{error}"))?;
        let name = file.name().to_owned();
        if name.is_empty() || index.contains_key(&name) {
            return Err(format!("PPTX 包含空名称或重复部件：{name}"));
        }
        let declared = usize::try_from(file.size()).unwrap_or(usize::MAX);
        if declared > MAX_PART_BYTES {
            return Err(format!("PPTX 部件超过 64 MiB 安全上限：{name}"));
        }
        let mut limited = (&mut file).take(MAX_PART_BYTES as u64 + 1);
        let mut data = Vec::with_capacity(declared.min(2 * 1024 * 1024));
        limited
            .read_to_end(&mut data)
            .map_err(|error| format!("PPTX 部件解压失败：{name}: {error}"))?;
        if data.len() > MAX_PART_BYTES {
            return Err(format!("PPTX 解压部件超过 64 MiB 安全上限：{name}"));
        }
        total = total.saturating_add(data.len());
        if total > MAX_SOURCE_BYTES {
            return Err("PPTX 解压总大小超过 256 MiB 安全上限。".to_owned());
        }
        let is_dir = file.is_dir();
        index.insert(name.clone(), parts.len());
        parts.push(PackagePart {
            name,
            bytes: data,
            is_dir,
        });
    }
    Ok(Package { parts, index })
}

impl Package {
    fn get(&self, name: &str) -> Option<&[u8]> {
        self.index
            .get(name)
            .map(|index| self.parts[*index].bytes.as_slice())
    }

    fn insert(&mut self, name: String, bytes: Vec<u8>, is_dir: bool) -> Result<(), String> {
        if bytes.len() > MAX_PART_BYTES {
            return Err(format!("输出部件超过 64 MiB 上限：{name}"));
        }
        if let Some(index) = self.index.get(&name).copied() {
            self.parts[index].bytes = bytes;
            self.parts[index].is_dir = is_dir;
        } else {
            self.index.insert(name.clone(), self.parts.len());
            self.parts.push(PackagePart {
                name,
                bytes,
                is_dir,
            });
        }
        Ok(())
    }
}

fn write_package(package: Package) -> Result<Vec<u8>, String> {
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for part in package.parts {
        if part.is_dir {
            writer
                .add_directory(&part.name, options)
                .map_err(|error| format!("PPTX 目录重写失败：{}: {error}", part.name))?;
        } else {
            writer
                .start_file(&part.name, options)
                .map_err(|error| format!("PPTX 部件重写失败：{}: {error}", part.name))?;
            writer
                .write_all(&part.bytes)
                .map_err(|error| format!("PPTX 部件写入失败：{}: {error}", part.name))?;
        }
    }
    let bytes = writer
        .finish()
        .map_err(|error| format!("PPTX ZIP 收尾失败：{error}"))?
        .into_inner();
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err("输出 PPTX 超过 256 MiB 上限。".to_owned());
    }
    Ok(bytes)
}

fn inspect_package(
    package: &Package,
    source_bytes: &[u8],
) -> Result<StyleExtractionReport, String> {
    let presentation = read_presentation(package)?;
    let presentation_xml = package
        .get(&presentation.part)
        .ok_or_else(|| "缺少 presentation.xml。".to_owned())?;
    let (slide_width_emu, slide_height_emu) = slide_size(presentation_xml);
    let source_sha256 = sha256_hex(source_bytes);
    let mut variants = Vec::<StyleVariant>::new();
    let mut representative_previews = Vec::new();
    let mut variant_index = HashMap::<(String, Option<String>, String), usize>::new();
    let mut limitations = vec![
        "结构提取来自 PPTX XML；标题位置、留白、密度、色彩比例和页面家族仍需渲染代表页做视觉检查。".to_owned(),
        "特殊对象（SmartArt、复杂图表、动画、嵌入对象、外部链接）保留在源包；本模块不会盲目重建或修改它们。".to_owned(),
    ];
    let mut extraction_facts = vec![format!(
        "读取 {} 张幻灯片的 PresentationML 部件。",
        presentation.slides.len()
    )];

    for slide in &presentation.slides {
        let slide_xml = package
            .get(&slide.part)
            .ok_or_else(|| format!("presentation 引用了缺失幻灯片：{}", slide.part))?;
        let rels_part = relationship_part(&slide.part);
        let relations = match package.get(&rels_part) {
            Some(xml) => parse_relationships(xml)?,
            None => return Err(format!("幻灯片关系文件缺失：{rels_part}")),
        };
        let layout_rel = relations
            .iter()
            .find(|relation| {
                relation.kind.ends_with("/slideLayout") && relation.target_mode.is_none()
            })
            .ok_or_else(|| format!("幻灯片缺少 slideLayout 关系：{}", slide.part))?;
        let layout_part = resolve_target(&slide.part, &layout_rel.target)?;
        if package.get(&layout_part).is_none() {
            return Err(format!("幻灯片 layout 部件不存在：{layout_part}"));
        }
        let layout_relations = parse_relationships(
            package
                .get(&relationship_part(&layout_part))
                .ok_or_else(|| format!("layout 关系文件缺失：{layout_part}"))?,
        )?;
        let master_rel = layout_relations
            .iter()
            .find(|relation| {
                relation.kind.ends_with("/slideMaster") && relation.target_mode.is_none()
            })
            .ok_or_else(|| format!("layout 缺少 slideMaster 关系：{layout_part}"))?;
        let master_part = resolve_target(&layout_part, &master_rel.target)?;
        if package.get(&master_part).is_none() {
            return Err(format!("slideMaster 部件不存在：{master_part}"));
        }
        let master_relations = parse_relationships(
            package
                .get(&relationship_part(&master_part))
                .ok_or_else(|| format!("slideMaster 关系文件缺失：{master_part}"))?,
        )?;
        let theme_part = master_relations
            .iter()
            .find(|relation| relation.kind.ends_with("/theme") && relation.target_mode.is_none())
            .map(|relation| resolve_target(&master_part, &relation.target))
            .transpose()?;
        let key = (master_part.clone(), theme_part.clone(), layout_part.clone());
        let index = if let Some(index) = variant_index.get(&key).copied() {
            index
        } else {
            let index = variants.len();
            let theme = theme_part
                .as_deref()
                .and_then(|part| package.get(part))
                .map(parse_theme)
                .transpose()?
                .unwrap_or_default();
            let placeholders =
                extract_placeholders(package, &master_part, &layout_part, &slide.part)?;
            let objects = parse_shapes(slide_xml)?
                .into_iter()
                .map(object_fact)
                .collect::<Vec<_>>();
            let variant_id = format!("variant-{}", index + 1);
            representative_previews.push(render_structural_preview(
                package,
                &slide.part,
                slide_xml,
                &relations,
                &variant_id,
                &source_sha256,
                slide_width_emu,
                slide_height_emu,
                &theme.colors,
            )?);
            variants.push(StyleVariant {
                id: variant_id,
                master_part: master_part.clone(),
                theme_part: theme_part.clone(),
                layout_part: layout_part.clone(),
                slide_parts: Vec::new(),
                representative_slide_part: slide.part.clone(),
                theme_colors: theme.colors,
                theme_fonts: theme.fonts,
                placeholders,
                representative_objects: objects,
            });
            variant_index.insert(key, index);
            index
        };
        variants[index].slide_parts.push(slide.part.clone());
        if relations
            .iter()
            .any(|relation| relation.target_mode.is_some())
        {
            limitations.push(format!(
                "{} 含外部关系，目标未访问且原关系保留。",
                slide.part
            ));
        }
        if package.parts.iter().any(|part| {
            part.name.starts_with("ppt/diagrams/")
                || part.name.starts_with("ppt/charts/")
                || part.name.starts_with("ppt/embeddings/")
        }) {
            limitations.push("包中检测到 diagram/chart/embedded 部件；这些部件会随源包保留，但本次追加不会重写。".to_owned());
        }
    }

    for variant in &variants {
        extraction_facts.push(format!(
            "{}: {} slides, master {}, layout {}, theme {}.",
            variant.id,
            variant.slide_parts.len(),
            variant.master_part,
            variant.layout_part,
            variant.theme_part.as_deref().unwrap_or("无可解析主题关系")
        ));
    }
    if variants.is_empty() {
        return Err("PPTX 没有可解析的 slide/layout/master 关系。".to_owned());
    }
    if package.get("ppt/notesMasters/notesMaster1.xml").is_none()
        && !presentation
            .relationships
            .iter()
            .any(|relation| relation.kind.ends_with("/notesMaster"))
    {
        limitations.push(
            "源文件没有 notesMaster；导出备注时会为新增页创建 notesMaster 与 notesSlide。"
                .to_owned(),
        );
    }
    deduplicate(&mut limitations);
    let ordered_slides = presentation
        .slides
        .iter()
        .enumerate()
        .map(|(index, slide)| OrderedSlide {
            slide_id: slide.slide_id.clone(),
            order: index + 1,
            part: slide.part.clone(),
        })
        .collect();
    Ok(StyleExtractionReport {
        source_sha256,
        presentation_part: presentation.part,
        slide_count: presentation.slides.len(),
        ordered_slides,
        slide_width_emu,
        slide_height_emu,
        variants,
        representative_previews,
        extraction_facts,
        limitations,
    })
}

fn render_structural_preview(
    package: &Package,
    slide_part: &str,
    slide_xml: &[u8],
    relationships: &[Relationship],
    variant_id: &str,
    source_sha256: &str,
    width_emu: Option<u64>,
    height_emu: Option<u64>,
    theme_colors: &[ThemeColor],
) -> Result<RepresentativeSlidePreview, String> {
    const FALLBACK_WIDTH: u64 = 9_144_000;
    const FALLBACK_HEIGHT: u64 = 5_143_500;
    const DISPLAY_WIDTH: u64 = 1200;
    let (view_width, view_height) = match (
        width_emu.filter(|value| *value > 0),
        height_emu.filter(|value| *value > 0),
    ) {
        (Some(width), Some(height)) => (width, height),
        _ => (FALLBACK_WIDTH, FALLBACK_HEIGHT),
    };
    let display_height = DISPLAY_WIDTH.saturating_mul(view_height) / view_width.max(1);
    let mut limitations = vec![
        "结构 SVG 仅按可提取的几何、纯色、文字和包内 PNG/JPEG 绘制，不是 PowerPoint 的实际渲染。".to_owned(),
        "不复现字体度量、自动换行、段落缩进、透明度、图片裁剪、母版背景、动画或特殊对象；视觉推断须另行复核。".to_owned(),
    ];
    if width_emu.is_none() || height_emu.is_none() {
        limitations.push(
            "幻灯片尺寸未完整声明，预览使用 16:9 默认 viewBox；尺寸字段仍保持 null。".to_owned(),
        );
    }
    let shapes = parse_shapes(slide_xml)?;
    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {view_width} {view_height}\" width=\"{DISPLAY_WIDTH}\" height=\"{display_height}\"><title>结构预览：{}</title><desc>基于 PPTX XML 的结构示意，不代表 Office 渲染结果。</desc><rect x=\"0\" y=\"0\" width=\"{view_width}\" height=\"{view_height}\" fill=\"#ffffff\"/>",
        escape_xml_text(slide_part)
    );
    let mut inline_bytes = 0usize;
    for (index, shape) in shapes.iter().enumerate() {
        let geometry = match (shape.x, shape.y, shape.width, shape.height) {
            (Some(x), Some(y), Some(width), Some(height)) if width > 0 && height > 0 => {
                (x, y, width, height)
            }
            _ => {
                push_preview_limitation(
                    &mut limitations,
                    format!("对象 {} 缺少可绘制的矩形几何，未画入结构预览。", index + 1),
                );
                continue;
            }
        };
        let (x, y, width, height) = geometry;
        if shape.kind == "pic" {
            if let Some(embed_id) = shape.image_embed_id.as_deref() {
                if let Some(relation) = relationships.iter().find(|relation| {
                    relation.id == embed_id
                        && relation.kind.ends_with("/image")
                        && relation.target_mode.is_none()
                }) {
                    let media_part = resolve_target(slide_part, &relation.target)?;
                    if let Some(bytes) = package.get(&media_part) {
                        let (mime, signature_ok) = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                            ("image/png", true)
                        } else if bytes.starts_with(b"\xff\xd8") {
                            ("image/jpeg", true)
                        } else {
                            ("", false)
                        };
                        if signature_ok
                            && bytes.len() <= MAX_PREVIEW_IMAGE_BYTES
                            && inline_bytes.saturating_add(bytes.len()) <= MAX_PREVIEW_INLINE_BYTES
                        {
                            inline_bytes += bytes.len();
                            svg.push_str(&format!(
                                "<image x=\"{x}\" y=\"{y}\" width=\"{width}\" height=\"{height}\" preserveAspectRatio=\"xMidYMid meet\" href=\"data:{mime};base64,{}\"/>",
                                BASE64.encode(bytes)
                            ));
                            continue;
                        }
                        push_preview_limitation(
                            &mut limitations,
                            format!(
                                "图片 {} 未嵌入预览：格式不支持或超过内嵌大小上限。",
                                media_part
                            ),
                        );
                    } else {
                        push_preview_limitation(
                            &mut limitations,
                            format!("图片关系目标缺失：{media_part}。"),
                        );
                    }
                } else {
                    push_preview_limitation(
                        &mut limitations,
                        format!("图片关系 {embed_id} 为外部、缺失或非图片关系，预览未访问该目标。"),
                    );
                }
            } else {
                push_preview_limitation(
                    &mut limitations,
                    "图片对象缺少 r:embed 关系，预览未显示该图片。".to_owned(),
                );
            }
            svg.push_str(&format!("<rect x=\"{x}\" y=\"{y}\" width=\"{width}\" height=\"{height}\" fill=\"#f3f4f6\" stroke=\"#6b7280\"/><text x=\"{}\" y=\"{}\" font-size=\"{}\" fill=\"#374151\">图片未显示</text>", x + 12_700, y + 228_600, 190_500));
            continue;
        }

        let unsupported = matches!(shape.kind.as_str(), "graphicFrame" | "grpSp");
        if unsupported {
            push_preview_limitation(
                &mut limitations,
                format!("{} 对象只绘制边框占位，内部对象未解析。", shape.kind),
            );
        }
        let fill = preview_color(shape.fill.as_deref(), theme_colors).unwrap_or_else(|| {
            if shape
                .fill
                .as_deref()
                .is_some_and(|value| value.starts_with("scheme:"))
            {
                push_preview_limitation(
                    &mut limitations,
                    "部分主题色未解析，预览以中性灰代替。".to_owned(),
                );
            }
            "#f3f4f6".to_owned()
        });
        let stroke = preview_color(shape.line.as_deref(), theme_colors)
            .unwrap_or_else(|| "#6b7280".to_owned());
        svg.push_str(&format!(
            "<rect x=\"{x}\" y=\"{y}\" width=\"{width}\" height=\"{height}\" fill=\"{}\" stroke=\"{}\"/>",
            if unsupported { "#fff7ed" } else { &fill },
            if unsupported { "#c2410c" } else { &stroke }
        ));
        if !shape.text.is_empty() {
            let font_size = shape
                .font_sizes
                .iter()
                .copied()
                .max()
                .unwrap_or(1800)
                .min(7200) as u64
                * 127;
            let text_x = x.saturating_add(38_100);
            let first_baseline =
                y.saturating_add(i64::try_from(font_size.max(152_400)).unwrap_or(i64::MAX));
            let line_height = font_size.saturating_mul(6) / 5;
            svg.push_str(&format!("<text x=\"{text_x}\" y=\"{first_baseline}\" font-family=\"sans-serif\" font-size=\"{font_size}\" fill=\"#111827\">"));
            for (line_index, line) in shape.text.split('\n').enumerate() {
                let dy = if line_index == 0 { 0 } else { line_height };
                svg.push_str(&format!(
                    "<tspan x=\"{text_x}\" dy=\"{dy}\">{}</tspan>",
                    escape_xml_text(line)
                ));
            }
            svg.push_str("</text>");
        }
    }
    svg.push_str("</svg>");
    deduplicate(&mut limitations);
    Ok(RepresentativeSlidePreview {
        source_sha256: source_sha256.to_owned(),
        variant_id: variant_id.to_owned(),
        slide_part: slide_part.to_owned(),
        width_emu,
        height_emu,
        format: "svg".to_owned(),
        svg,
        limitations,
    })
}

fn preview_color(value: Option<&str>, theme_colors: &[ThemeColor]) -> Option<String> {
    let value = value?;
    let color = if let Some(color) = value.strip_prefix('#') {
        color.to_owned()
    } else if let Some(slot) = value.strip_prefix("scheme:") {
        theme_colors
            .iter()
            .find(|theme_color| theme_color.slot == slot)?
            .value
            .strip_prefix('#')?
            .to_owned()
    } else {
        return None;
    };
    (color.len() == 6 && color.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| format!("#{color}"))
}

fn push_preview_limitation(limitations: &mut Vec<String>, limitation: String) {
    if !limitations.contains(&limitation) {
        limitations.push(limitation);
    }
}

fn read_presentation(package: &Package) -> Result<Presentation, String> {
    let root_rels = package
        .get("_rels/.rels")
        .ok_or_else(|| "PPTX 缺少包级 _rels/.rels。".to_owned())?;
    let office_document = parse_relationships(root_rels)?
        .into_iter()
        .find(|relation| {
            relation.kind.ends_with("/officeDocument") && relation.target_mode.is_none()
        })
        .ok_or_else(|| "PPTX 包级关系没有 officeDocument 入口。".to_owned())?;
    let presentation_part = resolve_target("", &office_document.target)?;
    let presentation_xml = package
        .get(&presentation_part)
        .ok_or_else(|| format!("PPTX presentation 部件不存在：{presentation_part}"))?;
    let presentation_rels = parse_relationships(
        package
            .get(&relationship_part(&presentation_part))
            .ok_or_else(|| "PPTX 缺少 presentation 关系文件。".to_owned())?,
    )?;
    let mut relation_by_id = HashMap::new();
    for relation in &presentation_rels {
        relation_by_id.insert(relation.id.as_str(), relation);
    }
    let mut slides = Vec::new();
    let mut reader = Reader::from_reader(presentation_xml);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut events = 0usize;
    loop {
        events += 1;
        if events > MAX_XML_EVENTS {
            return Err("presentation.xml 标签数量超过安全上限。".to_owned());
        }
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(event) | Event::Empty(event))
                if local_name(event.name().as_ref()) == "sldId" =>
            {
                let attrs = read_attrs(&event)?;
                let slide_id = attrs
                    .get("id")
                    .cloned()
                    .ok_or_else(|| "presentation.xml 中 sldId 缺少 id。".to_owned())?;
                let rel_id = attrs
                    .iter()
                    .find(|(key, _)| key.ends_with(":id"))
                    .map(|(_, value)| value.clone())
                    .ok_or_else(|| "presentation.xml 中 sldId 缺少 r:id。".to_owned())?;
                let relation = relation_by_id
                    .get(rel_id.as_str())
                    .ok_or_else(|| format!("presentation.xml 引用了不存在的关系 {rel_id}"))?;
                if !relation.kind.ends_with("/slide") || relation.target_mode.is_some() {
                    return Err(format!("sldId {slide_id} 没有指向内部 slide 部件。"));
                }
                let part = resolve_target(&presentation_part, &relation.target)?;
                slides.push(SlideRecord { slide_id, part });
            }
            Ok(_) => {}
            Err(error) => return Err(format!("presentation.xml 无法解析：{error}")),
        }
        buffer.clear();
    }
    if slides.is_empty() {
        return Err("PPTX presentation 没有幻灯片。".to_owned());
    }
    for slide in &slides {
        if package.get(&slide.part).is_none() {
            return Err(format!("presentation 引用缺失 slide 部件：{}", slide.part));
        }
    }
    Ok(Presentation {
        part: presentation_part,
        relationships: presentation_rels,
        slides,
    })
}

fn parse_relationships(xml: &[u8]) -> Result<Vec<Relationship>, String> {
    let mut result = Vec::new();
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut events = 0usize;
    loop {
        events += 1;
        if events > MAX_XML_EVENTS {
            return Err("关系文件标签数量超过安全上限。".to_owned());
        }
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(event) | Event::Empty(event))
                if local_name(event.name().as_ref()) == "Relationship" =>
            {
                let attrs = read_attrs(&event)?;
                let id = attrs
                    .get("Id")
                    .cloned()
                    .ok_or_else(|| "Relationship 缺少 Id。".to_owned())?;
                let kind = attrs
                    .get("Type")
                    .cloned()
                    .ok_or_else(|| "Relationship 缺少 Type。".to_owned())?;
                let target = attrs
                    .get("Target")
                    .cloned()
                    .ok_or_else(|| "Relationship 缺少 Target。".to_owned())?;
                result.push(Relationship {
                    id,
                    kind,
                    target,
                    target_mode: attrs.get("TargetMode").cloned(),
                });
            }
            Ok(_) => {}
            Err(error) => return Err(format!("关系文件无法解析：{error}")),
        }
        buffer.clear();
    }
    Ok(result)
}

fn read_attrs(event: &BytesStart<'_>) -> Result<BTreeMap<String, String>, String> {
    let mut attrs = BTreeMap::new();
    for attribute in event.attributes().with_checks(false) {
        let attribute = attribute.map_err(|error| format!("XML 属性无效：{error}"))?;
        let key = attribute.key.as_ref().to_owned();
        let value = attribute
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|error| format!("XML 属性值无法解码：{error}"))?
            .into_owned();
        attrs.insert(key, value);
    }
    Ok(attrs)
}

fn local_name(name: &str) -> String {
    name.rsplit(':').next().unwrap_or(name).to_owned()
}

fn relationship_part(source_part: &str) -> String {
    match source_part.rsplit_once('/') {
        Some((directory, filename)) => format!("{directory}/_rels/{filename}.rels"),
        None => format!("_rels/{source_part}.rels"),
    }
}

fn resolve_target(source_part: &str, target: &str) -> Result<String, String> {
    if target.is_empty() || target.contains('?') || target.contains('#') || target.contains('\\') {
        return Err(format!("不支持的内部 OPC relationship target：{target}"));
    }
    let mut segments = if target.starts_with('/') {
        Vec::new()
    } else {
        source_part
            .rsplit_once('/')
            .map(|(directory, _)| {
                directory
                    .split('/')
                    .filter(|part| !part.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    for segment in target.trim_start_matches('/').split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.pop().is_none() {
                    return Err(format!("OPC relationship 越出包根目录：{target}"));
                }
            }
            value => segments.push(value.to_owned()),
        }
    }
    if segments.is_empty() {
        return Err(format!("OPC relationship target 为空：{target}"));
    }
    Ok(segments.join("/"))
}

fn relative_target(source_part: &str, target_part: &str) -> String {
    let base = source_part
        .rsplit_once('/')
        .map(|(directory, _)| {
            directory
                .split('/')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let target = target_part
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let common = base
        .iter()
        .zip(&target)
        .take_while(|(left, right)| left == right)
        .count();
    let mut result = vec![".."; base.len().saturating_sub(common)];
    result.extend(target[common..].iter().copied());
    result.join("/")
}

fn slide_size(xml: &[u8]) -> (Option<u64>, Option<u64>) {
    let mut reader = Reader::from_reader(xml);
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(Event::Start(event) | Event::Empty(event))
                if local_name(event.name().as_ref()) == "sldSz" =>
            {
                if let Ok(attrs) = read_attrs(&event) {
                    return (
                        attrs.get("cx").and_then(|value| value.parse().ok()),
                        attrs.get("cy").and_then(|value| value.parse().ok()),
                    );
                }
            }
            Ok(_) => {}
        }
        buffer.clear();
    }
    (None, None)
}

fn next_slide_part(package: &Package) -> Result<String, String> {
    let mut index = 1usize;
    loop {
        let candidate = format!("ppt/slides/slide{index}.xml");
        if !package.index.contains_key(&candidate) {
            return Ok(candidate);
        }
        index += 1;
        if index > MAX_PACKAGE_PARTS {
            return Err("无法分配唯一 slide 部件名。".to_owned());
        }
    }
}

fn slide_index(part: &str) -> Result<usize, String> {
    let filename = part
        .rsplit('/')
        .next()
        .ok_or_else(|| "slide part 路径无效。".to_owned())?;
    filename
        .strip_prefix("slide")
        .and_then(|value| value.strip_suffix(".xml"))
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| format!("slide part 名称无效：{part}"))
}

fn next_relationship_id(relations: &[Relationship]) -> String {
    let used: HashSet<&str> = relations
        .iter()
        .map(|relation| relation.id.as_str())
        .collect();
    let mut index = 1usize;
    loop {
        let candidate = format!("rId{index}");
        if !used.contains(candidate.as_str()) {
            return candidate;
        }
        index += 1;
    }
}

fn next_slide_id(xml: &[u8]) -> Result<String, String> {
    let mut reader = Reader::from_reader(xml);
    let mut buffer = Vec::new();
    let mut max = 255u64;
    let mut events = 0usize;
    loop {
        events += 1;
        if events > MAX_XML_EVENTS {
            return Err("presentation.xml 标签数量超过安全上限。".to_owned());
        }
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(event) | Event::Empty(event))
                if local_name(event.name().as_ref()) == "sldId" =>
            {
                let attrs = read_attrs(&event)?;
                if let Some(id) = attrs.get("id").and_then(|value| value.parse::<u64>().ok()) {
                    max = max.max(id);
                }
            }
            Ok(_) => {}
            Err(error) => return Err(format!("presentation.xml 无法解析：{error}")),
        }
        buffer.clear();
    }
    max.checked_add(1)
        .map(|id| id.to_string())
        .ok_or_else(|| "slide id 超出数值范围。".to_owned())
}

fn insert_slide_id_after(
    xml: &[u8],
    slide_id: &str,
    relationship_id: &str,
    insert_after_slide_id: Option<&str>,
) -> Result<Vec<u8>, String> {
    let slide_tag = qname_for(xml, "sldId")?.unwrap_or_else(|| "p:sldId".to_owned());
    let fragment = format!(
        "<{slide_tag} id=\"{}\" r:id=\"{}\"/>",
        escape_xml_attr(slide_id),
        escape_xml_attr(relationship_id)
    );
    let Some(after_id) = insert_after_slide_id else {
        return insert_before_end(xml, "sldIdLst", fragment.as_bytes());
    };
    let mut insertion = None;
    for range in xml_elements(xml, "sldId")? {
        let attrs = attributes_in_element(xml, &range)?;
        if attrs.get("id").is_some_and(|value| value == after_id) {
            if insertion.replace(range.element.end).is_some() {
                return Err("presentation.xml 中 slide ID 重复，无法确定插入位置。".to_owned());
            }
        }
    }
    let insertion =
        insertion.ok_or_else(|| format!("insert_after_slide_id 不属于当前 PPTX：{after_id}"))?;
    let mut output = Vec::with_capacity(xml.len() + fragment.len());
    output.extend_from_slice(&xml[..insertion]);
    output.extend_from_slice(fragment.as_bytes());
    output.extend_from_slice(&xml[insertion..]);
    Ok(output)
}

fn serialize_relationships(relations: &[Relationship]) -> String {
    let mut xml = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"{RELATIONSHIPS_NS}\">");
    for relation in relations {
        xml.push_str(&format!(
            "<Relationship Id=\"{}\" Type=\"{}\" Target=\"{}\"{} />",
            escape_xml_attr(&relation.id),
            escape_xml_attr(&relation.kind),
            escape_xml_attr(&relation.target),
            relation
                .target_mode
                .as_ref()
                .map(|mode| format!(" TargetMode=\"{}\"", escape_xml_attr(mode)))
                .unwrap_or_default()
        ));
    }
    xml.push_str("</Relationships>");
    xml
}

fn add_content_type_override(
    xml: &[u8],
    part_name: &str,
    content_type: &str,
) -> Result<Vec<u8>, String> {
    let existing = parse_content_types(xml)?;
    if existing
        .iter()
        .any(|(kind, name, _)| kind == "override" && name == part_name)
    {
        return Err(format!("Content_Types 中已存在相同部件覆盖项：{part_name}"));
    }
    let tag = qname_for(xml, "Override")?.unwrap_or_else(|| "Override".to_owned());
    let fragment = format!(
        "<{tag} PartName=\"{}\" ContentType=\"{}\"/>",
        escape_xml_attr(part_name),
        escape_xml_attr(content_type)
    );
    insert_before_end(xml, "Types", fragment.as_bytes())
}

fn add_default_content_type(
    xml: &[u8],
    extension: &str,
    content_type: &str,
) -> Result<Vec<u8>, String> {
    let existing = parse_content_types(xml)?;
    if let Some((_, _, found)) = existing
        .iter()
        .find(|(kind, name, _)| kind == "default" && name.eq_ignore_ascii_case(extension))
    {
        if found != content_type {
            return Err(format!(
                "Content_Types 中扩展名 {extension} 已绑定到不兼容的 MIME。"
            ));
        }
        return Ok(xml.to_vec());
    }
    let tag = qname_for(xml, "Default")?.unwrap_or_else(|| "Default".to_owned());
    let fragment = format!(
        "<{tag} Extension=\"{}\" ContentType=\"{}\"/>",
        escape_xml_attr(extension),
        escape_xml_attr(content_type)
    );
    insert_before_end(xml, "Types", fragment.as_bytes())
}

fn parse_content_types(xml: &[u8]) -> Result<Vec<(String, String, String)>, String> {
    let mut result = Vec::new();
    let mut reader = Reader::from_reader(xml);
    let mut buffer = Vec::new();
    let mut events = 0usize;
    loop {
        events += 1;
        if events > MAX_XML_EVENTS {
            return Err("Content_Types 标签数量超过安全上限。".to_owned());
        }
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(event) | Event::Empty(event)) => {
                let kind = local_name(event.name().as_ref());
                if kind == "Override" || kind == "Default" {
                    let attrs = read_attrs(&event)?;
                    let name = if kind == "Override" {
                        "PartName"
                    } else {
                        "Extension"
                    };
                    let name = attrs
                        .get(name)
                        .ok_or_else(|| format!("Content_Types 的 {kind} 缺少名称属性。"))?;
                    let content_type = attrs
                        .get("ContentType")
                        .ok_or_else(|| format!("Content_Types 的 {kind} 缺少 ContentType。"))?;
                    result.push((
                        kind.to_ascii_lowercase(),
                        name.clone(),
                        content_type.clone(),
                    ));
                }
            }
            Ok(_) => {}
            Err(error) => return Err(format!("Content_Types 无法解析：{error}")),
        }
        buffer.clear();
    }
    Ok(result)
}

fn qname_for(xml: &[u8], wanted: &str) -> Result<Option<String>, String> {
    let mut reader = Reader::from_reader(xml);
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => return Ok(None),
            Ok(Event::Start(event) | Event::Empty(event))
                if local_name(event.name().as_ref()) == wanted =>
            {
                return Ok(Some(event.name().as_ref().to_owned()));
            }
            Ok(_) => {}
            Err(error) => return Err(format!("XML 无法解析：{error}")),
        }
        buffer.clear();
    }
}

fn insert_before_end(
    xml: &[u8],
    parent_local_name: &str,
    fragment: &[u8],
) -> Result<Vec<u8>, String> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut events = 0usize;
    loop {
        events += 1;
        if events > MAX_XML_EVENTS {
            return Err("XML 标签数量超过安全上限。".to_owned());
        }
        let start = reader.buffer_position() as usize;
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::End(event)) if local_name(event.name().as_ref()) == parent_local_name => {
                let mut output = Vec::with_capacity(xml.len() + fragment.len());
                output.extend_from_slice(&xml[..start]);
                output.extend_from_slice(fragment);
                output.extend_from_slice(&xml[start..]);
                return Ok(output);
            }
            Ok(_) => {}
            Err(error) => return Err(format!("XML 插入目标无法解析：{error}")),
        }
        buffer.clear();
    }
    Err(format!("XML 中缺少结束标签 {parent_local_name}。"))
}

fn escape_xml_attr(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn deduplicate(values: &mut Vec<String>) {
    let mut seen = HashSet::new();
    values.retain(|value| seen.insert(value.clone()));
}

fn parse_theme(xml: &[u8]) -> Result<ParsedTheme, String> {
    let mut parsed = ParsedTheme::default();
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut stack = Vec::<String>::new();
    let mut active_color: Option<String> = None;
    let mut events = 0usize;
    loop {
        events += 1;
        if events > MAX_XML_EVENTS {
            return Err("theme.xml 标签数量超过安全上限。".to_owned());
        }
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(event)) => {
                let local = local_name(event.name().as_ref());
                let attrs = read_attrs(&event)?;
                if stack.iter().any(|part| part == "clrScheme")
                    && matches!(
                        local.as_str(),
                        "dk1"
                            | "lt1"
                            | "dk2"
                            | "lt2"
                            | "accent1"
                            | "accent2"
                            | "accent3"
                            | "accent4"
                            | "accent5"
                            | "accent6"
                            | "hlink"
                            | "folHlink"
                    )
                {
                    active_color = Some(local.clone());
                }
                collect_theme_element(&mut parsed, &stack, &local, &attrs, active_color.as_deref());
                stack.push(local);
            }
            Ok(Event::Empty(event)) => {
                let local = local_name(event.name().as_ref());
                let attrs = read_attrs(&event)?;
                collect_theme_element(&mut parsed, &stack, &local, &attrs, active_color.as_deref());
            }
            Ok(Event::End(event)) => {
                let local = local_name(event.name().as_ref());
                if local == "clrScheme" {
                    active_color = None;
                }
                stack.pop();
            }
            Ok(_) => {}
            Err(error) => return Err(format!("theme.xml 无法解析：{error}")),
        }
        buffer.clear();
    }
    Ok(parsed)
}

fn collect_theme_element(
    parsed: &mut ParsedTheme,
    stack: &[String],
    local: &str,
    attrs: &BTreeMap<String, String>,
    active_color: Option<&str>,
) {
    if stack.iter().any(|part| part == "clrScheme") && matches!(local, "srgbClr" | "sysClr") {
        let value = if local == "srgbClr" {
            attrs.get("val")
        } else {
            attrs.get("lastClr").or_else(|| attrs.get("val"))
        };
        if let (Some(slot), Some(value)) = (active_color, value) {
            parsed.colors.push(ThemeColor {
                slot: slot.to_owned(),
                value: value.to_owned(),
            });
        }
    }
    if matches!(local, "latin" | "ea" | "cs") {
        let scheme = if stack.iter().any(|part| part == "majorFont") {
            "major"
        } else if stack.iter().any(|part| part == "minorFont") {
            "minor"
        } else {
            "other"
        };
        if let Some(typeface) = attrs.get("typeface") {
            parsed.fonts.push(ThemeFont {
                scheme: scheme.to_owned(),
                script: local.to_owned(),
                typeface: typeface.to_owned(),
            });
        }
    }
}

fn extract_placeholders(
    package: &Package,
    master_part: &str,
    layout_part: &str,
    slide_part: &str,
) -> Result<Vec<PlaceholderFact>, String> {
    let mut placeholders = Vec::new();
    for (part, source) in [
        (master_part, "master"),
        (layout_part, "layout"),
        (slide_part, "slide"),
    ] {
        let xml = package
            .get(part)
            .ok_or_else(|| format!("PPTX 缺少样式来源部件：{part}"))?;
        for shape in parse_shapes(xml)? {
            if let Some(placeholder_type) = shape.placeholder_type {
                placeholders.push(PlaceholderFact {
                    placeholder_type,
                    index: shape.placeholder_index,
                    shape_name: shape.name,
                    inheritance_source: format!("{source}:{part}"),
                    x: shape.x,
                    y: shape.y,
                    width: shape.width,
                    height: shape.height,
                });
            }
        }
    }
    Ok(placeholders)
}

fn object_fact(shape: ShapeFact) -> PresentationObjectFact {
    PresentationObjectFact {
        kind: shape.kind,
        name: shape.name,
        placeholder_type: shape.placeholder_type,
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
        fill: shape.fill,
        line: shape.line,
        font_sizes_hundredth_pt: shape.font_sizes,
        text_run_count: shape.text_run_count,
    }
}

fn parse_shapes(xml: &[u8]) -> Result<Vec<ShapeFact>, String> {
    let mut shapes = Vec::new();
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut stack = Vec::<String>::new();
    let mut current: Option<ShapeFact> = None;
    let mut shape_depth = 0usize;
    let mut events = 0usize;
    loop {
        events += 1;
        if events > MAX_XML_EVENTS {
            return Err("slide/layout/master XML 标签数量超过安全上限。".to_owned());
        }
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(event)) => {
                let local = local_name(event.name().as_ref());
                let attrs = read_attrs(&event)?;
                if current.is_none()
                    && matches!(
                        local.as_str(),
                        "sp" | "pic" | "graphicFrame" | "cxnSp" | "grpSp"
                    )
                {
                    current = Some(ShapeFact {
                        kind: local.clone(),
                        name: None,
                        placeholder_type: None,
                        placeholder_index: None,
                        x: None,
                        y: None,
                        width: None,
                        height: None,
                        fill: None,
                        line: None,
                        font_sizes: Vec::new(),
                        text_run_count: 0,
                        text: String::new(),
                        image_embed_id: None,
                    });
                    shape_depth = 1;
                } else if let Some(shape) = current.as_mut() {
                    if local == "p"
                        && stack.iter().any(|part| part == "txBody")
                        && !shape.text.is_empty()
                    {
                        shape.text.push('\n');
                    }
                    shape_depth += 1;
                    collect_shape_element(shape, &stack, &local, &attrs);
                }
                stack.push(local);
            }
            Ok(Event::Empty(event)) => {
                let local = local_name(event.name().as_ref());
                let attrs = read_attrs(&event)?;
                if let Some(shape) = current.as_mut() {
                    collect_shape_element(shape, &stack, &local, &attrs);
                } else if matches!(
                    local.as_str(),
                    "sp" | "pic" | "graphicFrame" | "cxnSp" | "grpSp"
                ) {
                    let mut shape = empty_shape(local.clone());
                    collect_shape_element(&mut shape, &stack, &local, &attrs);
                    shapes.push(shape);
                }
            }
            Ok(Event::End(event)) => {
                let local = local_name(event.name().as_ref());
                if current.is_some() {
                    shape_depth = shape_depth.saturating_sub(1);
                    if shape_depth == 0 {
                        if let Some(shape) = current.take() {
                            shapes.push(shape);
                        }
                    }
                }
                stack.pop();
                let _ = local;
            }
            Ok(Event::Text(text)) if stack.last().is_some_and(|part| part == "t") => {
                if let Some(shape) = current.as_mut() {
                    shape.text.push_str(&text.xml10_content());
                }
            }
            Ok(Event::GeneralRef(reference)) if stack.last().is_some_and(|part| part == "t") => {
                if let Some(shape) = current.as_mut() {
                    let entity = reference.xml10_content();
                    let raw = format!("&{entity};");
                    shape.text.push_str(
                        quick_xml::escape::unescape(&raw)
                            .map(|value| value.into_owned())
                            .unwrap_or(raw)
                            .as_str(),
                    );
                }
            }
            Ok(_) => {}
            Err(error) => return Err(format!("PPTX shape XML 无法解析：{error}")),
        }
        buffer.clear();
    }
    Ok(shapes)
}

fn empty_shape(kind: String) -> ShapeFact {
    ShapeFact {
        kind,
        name: None,
        placeholder_type: None,
        placeholder_index: None,
        x: None,
        y: None,
        width: None,
        height: None,
        fill: None,
        line: None,
        font_sizes: Vec::new(),
        text_run_count: 0,
        text: String::new(),
        image_embed_id: None,
    }
}

fn collect_shape_element(
    shape: &mut ShapeFact,
    stack: &[String],
    local: &str,
    attrs: &BTreeMap<String, String>,
) {
    match local {
        "cNvPr" => shape.name = attrs.get("name").cloned(),
        "ph" => {
            shape.placeholder_type = attrs
                .get("type")
                .cloned()
                .or_else(|| Some("obj".to_owned()));
            shape.placeholder_index = attrs.get("idx").cloned();
        }
        "off" if shape.x.is_none() && shape.y.is_none() => {
            shape.x = attrs.get("x").and_then(|value| value.parse().ok());
            shape.y = attrs.get("y").and_then(|value| value.parse().ok());
        }
        "ext" if shape.width.is_none() && shape.height.is_none() => {
            shape.width = attrs.get("cx").and_then(|value| value.parse().ok());
            shape.height = attrs.get("cy").and_then(|value| value.parse().ok());
        }
        "rPr" | "defRPr" | "endParaRPr" => {
            if let Some(size) = attrs.get("sz").and_then(|value| value.parse().ok()) {
                shape.font_sizes.push(size);
            }
        }
        "t" => shape.text_run_count += 1,
        "srgbClr" => {
            let value = attrs.get("val").map(|value| format!("#{value}"));
            if stack.iter().any(|part| part == "ln") {
                shape
                    .line
                    .get_or_insert_with(|| value.clone().unwrap_or_default());
            } else {
                shape
                    .fill
                    .get_or_insert_with(|| value.clone().unwrap_or_default());
            }
        }
        "schemeClr" => {
            let value = attrs.get("val").map(|value| format!("scheme:{value}"));
            if stack.iter().any(|part| part == "ln") {
                shape
                    .line
                    .get_or_insert_with(|| value.clone().unwrap_or_default());
            } else {
                shape
                    .fill
                    .get_or_insert_with(|| value.clone().unwrap_or_default());
            }
        }
        "blip" => {
            shape.image_embed_id = attrs
                .iter()
                .find(|(key, _)| key.ends_with(":embed"))
                .map(|(_, value)| value.clone());
        }
        _ => {}
    }
}

fn xml_elements(xml: &[u8], wanted: &str) -> Result<Vec<XmlRange>, String> {
    let mut ranges = Vec::new();
    let mut stack = Vec::<(String, String, usize, usize)>::new();
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut events = 0usize;
    loop {
        events += 1;
        if events > MAX_XML_EVENTS {
            return Err("XML 标签数量超过安全上限。".to_owned());
        }
        let start = reader.buffer_position() as usize;
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(event)) => {
                let qname = event.name().as_ref().to_owned();
                let local = local_name(event.name().as_ref());
                let content_start = reader.buffer_position() as usize;
                stack.push((local, qname, start, content_start));
            }
            Ok(Event::Empty(event)) => {
                let qname = event.name().as_ref().to_owned();
                if local_name(event.name().as_ref()) == wanted {
                    let end = reader.buffer_position() as usize;
                    ranges.push(XmlRange {
                        element: start..end,
                        inner: end..end,
                        qname,
                        empty: true,
                    });
                }
            }
            Ok(Event::End(_event)) => {
                let end = reader.buffer_position() as usize;
                if let Some((local, qname, element_start, inner_start)) = stack.pop() {
                    if local == wanted {
                        let end_start = start;
                        ranges.push(XmlRange {
                            element: element_start..end,
                            inner: inner_start..end_start,
                            qname,
                            empty: false,
                        });
                    }
                }
            }
            Ok(_) => {}
            Err(error) => return Err(format!("XML 无法解析：{error}")),
        }
        buffer.clear();
    }
    ranges.sort_by_key(|range| range.element.start);
    Ok(ranges)
}

fn replace_text_nodes(xml: &[u8], text: &str) -> Result<Vec<u8>, String> {
    let ranges = xml_elements(xml, "t")?;
    if ranges.is_empty() {
        return Err("模板文本框没有可替换的 DrawingML 文本运行。".to_owned());
    }
    let mut output = xml.to_vec();
    for (index, range) in ranges.into_iter().enumerate().rev() {
        let replacement = if index == 0 {
            escape_xml_text(text)
        } else {
            String::new()
        };
        output.splice(range.inner, replacement.bytes());
    }
    Ok(output)
}

fn replace_slide_text(xml: &[u8], spec: &ValidatedSlideSpec) -> Result<Vec<u8>, String> {
    let shape_ranges = xml_elements(xml, "sp")?;
    let mut shapes = Vec::<(XmlRange, ShapeFact)>::new();
    for range in shape_ranges {
        let fact = parse_shapes(&xml[range.element.clone()])?
            .into_iter()
            .next()
            .unwrap_or_else(|| empty_shape("sp".to_owned()));
        if fact.text_run_count > 0 {
            shapes.push((range, fact));
        }
    }
    let title_index = shapes
        .iter()
        .position(|(_, shape)| {
            shape
                .placeholder_type
                .as_deref()
                .is_some_and(|kind| matches!(kind, "title" | "ctrTitle" | "subTitle"))
                || shape.name.as_deref().is_some_and(|name| {
                    let name = name.to_ascii_lowercase();
                    name.contains("title") || name.contains("heading") || name.contains("标题")
                })
        })
        .or_else(|| (!shapes.is_empty()).then_some(0));
    if !spec.title.is_empty() && title_index.is_none() {
        return Err("模板代表页没有可替换的标题文本框。".to_owned());
    }
    let body_candidates = shapes
        .iter()
        .enumerate()
        .filter(|(index, (_, shape))| {
            if Some(*index) == title_index {
                return false;
            }
            let name = shape
                .name
                .as_deref()
                .unwrap_or_default()
                .to_ascii_lowercase();
            shape
                .placeholder_type
                .as_deref()
                .is_some_and(|kind| matches!(kind, "body" | "obj" | "subTitle"))
                || name.contains("paragraph")
                || name.contains("body")
                || name.contains("content")
                || name.contains("正文")
                || name.contains("段落")
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let body_candidates = if body_candidates.is_empty() {
        shapes
            .iter()
            .enumerate()
            .filter(|(index, _)| Some(*index) != title_index)
            .map(|(index, _)| index)
            .collect::<Vec<_>>()
    } else {
        body_candidates
    };
    if !spec.body.is_empty() && body_candidates.is_empty() {
        return Err("模板代表页没有可替换的正文文本框。".to_owned());
    }

    let mut replacements = HashMap::<usize, Vec<SlideBodyItem>>::new();
    for (position, body_shape_index) in body_candidates.iter().enumerate() {
        let items = if position + 1 == body_candidates.len() {
            spec.body.iter().skip(position).cloned().collect::<Vec<_>>()
        } else {
            spec.body.get(position).cloned().into_iter().collect()
        };
        replacements.insert(*body_shape_index, items);
    }

    let mut output = xml.to_vec();
    let mut ordered = Vec::<(Range<usize>, Vec<u8>)>::new();
    if let Some(index) = title_index {
        let (range, _) = &shapes[index];
        let updated = replace_shape_paragraphs(
            &xml[range.element.clone()],
            &[SlideBodyItem {
                kind: SlideBodyKind::Paragraph,
                text: spec.title.clone(),
            }],
        )?;
        ordered.push((range.element.clone(), updated));
    }
    for index in 0..shapes.len() {
        if Some(index) == title_index {
            continue;
        }
        let (range, _) = &shapes[index];
        // Keep unrelated text shapes (for example image captions) intact.
        // Only shapes selected as body placeholders are replaced.
        if let Some(items) = replacements.get(&index) {
            let updated = replace_shape_paragraphs(&xml[range.element.clone()], items)?;
            ordered.push((range.element.clone(), updated));
        }
    }
    ordered.sort_by_key(|(range, _)| range.start);
    for (range, replacement) in ordered.into_iter().rev() {
        output.splice(range, replacement);
    }
    Ok(output)
}

fn replace_shape_paragraphs(shape_xml: &[u8], items: &[SlideBodyItem]) -> Result<Vec<u8>, String> {
    let tx_body = xml_elements(shape_xml, "txBody")?
        .into_iter()
        .next()
        .ok_or_else(|| "模板文本框没有可替换的 txBody。".to_owned())?;
    let tx_body_xml = &shape_xml[tx_body.element.clone()];
    let paragraphs = xml_elements(tx_body_xml, "p")?;
    let source_paragraph = paragraphs
        .iter()
        .find(|range| {
            !xml_elements(&tx_body_xml[range.element.clone()], "t")
                .unwrap_or_default()
                .is_empty()
        })
        .ok_or_else(|| "模板文本框没有可复制的段落样式。".to_owned())?;
    let effective_items = if items.is_empty() {
        vec![SlideBodyItem {
            kind: SlideBodyKind::Paragraph,
            text: String::new(),
        }]
    } else {
        items.to_vec()
    };
    let mut new_paragraphs = Vec::with_capacity(effective_items.len());
    for item in effective_items {
        let paragraph = &tx_body_xml[source_paragraph.element.clone()];
        let with_text = replace_text_nodes(paragraph, &item.text)?;
        new_paragraphs.push(set_paragraph_kind(&with_text, &item.kind)?);
    }
    let mut new_tx_body = tx_body_xml.to_vec();
    let first = paragraphs
        .first()
        .ok_or_else(|| "模板文本框 txBody 中没有段落。".to_owned())?;
    let last = paragraphs.last().unwrap();
    let replace_range = first.element.start..last.element.end;
    new_tx_body.splice(replace_range, new_paragraphs.concat());
    let mut output = shape_xml.to_vec();
    output.splice(tx_body.element, new_tx_body);
    Ok(output)
}

fn set_paragraph_kind(paragraph: &[u8], kind: &SlideBodyKind) -> Result<Vec<u8>, String> {
    let prefix = qname_for(paragraph, "t")?
        .and_then(|name| name.split_once(':').map(|(prefix, _)| prefix.to_owned()))
        .unwrap_or_else(|| "a".to_owned());
    let mut output = paragraph.to_vec();
    let bullet_tags = ["buChar", "buAutoNum", "buNone"];
    for local in bullet_tags {
        let ranges = xml_elements(&output, local)?;
        for range in ranges.into_iter().rev() {
            output.splice(range.element, std::iter::empty());
        }
    }
    let child = match kind {
        SlideBodyKind::Bullet => format!("<{prefix}:buChar char=\"•\"/>"),
        SlideBodyKind::Paragraph => format!("<{prefix}:buNone/>"),
    };
    let p_pr = xml_elements(&output, "pPr")?.into_iter().next();
    if let Some(p_pr) = p_pr {
        if p_pr.empty {
            let expanded = format!("<{}>{child}</{}>", p_pr.qname, p_pr.qname);
            output.splice(p_pr.element, expanded.bytes());
        } else {
            output = insert_before_end(&output, "pPr", child.as_bytes())?;
        }
    } else {
        let after_open =
            start_tag_end(&output, "p")?.ok_or_else(|| "模板段落标签损坏。".to_owned())?;
        output.splice(
            after_open..after_open,
            format!("<{prefix}:pPr>{child}</{prefix}:pPr>").bytes(),
        );
    }
    Ok(output)
}

fn start_tag_end(xml: &[u8], wanted: &str) -> Result<Option<usize>, String> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => return Ok(None),
            Ok(Event::Start(event)) if local_name(event.name().as_ref()) == wanted => {
                return Ok(Some(reader.buffer_position() as usize));
            }
            Ok(_) => {}
            Err(error) => return Err(format!("XML 开始标签无法解析：{error}")),
        }
        buffer.clear();
    }
}

#[derive(Debug, Default)]
struct ImageAdditions {
    content_types: Vec<(String, String)>,
}

fn add_resolved_images(
    package: &mut Package,
    slide_xml: &mut Vec<u8>,
    slide_rels: &mut Vec<Relationship>,
    new_slide_part: &str,
    new_slide_index: usize,
    images: &[ResolvedPresentationImage],
) -> Result<ImageAdditions, String> {
    if images.is_empty() {
        return Ok(ImageAdditions::default());
    }
    let picture_ranges = xml_elements(slide_xml, "pic")?;
    if images.len() > picture_ranges.len() {
        return Err(format!(
            "模板代表页只有 {} 个可复用图片位置，SlideSpec 引用了 {} 张新图。",
            picture_ranges.len(),
            images.len()
        ));
    }
    let mut result = ImageAdditions::default();
    let mut xml_replacements = Vec::<(Range<usize>, Vec<u8>)>::new();
    for (index, (image, picture_range)) in images.iter().zip(picture_ranges).enumerate() {
        let media_name = unique_media_name(package, new_slide_index, index, &image.extension)?;
        let extension = media_name.rsplit('.').next().unwrap_or_default().to_owned();
        let relationship_id = next_relationship_id(slide_rels);
        let picture_xml = &slide_xml[picture_range.element.clone()];
        let picture_xml = replace_attribute_value(picture_xml, "blip", "embed", &relationship_id)?;
        xml_replacements.push((picture_range.element, picture_xml));
        package.insert(media_name.clone(), image.bytes.clone(), false)?;
        slide_rels.push(Relationship {
            id: relationship_id,
            kind: format!("{OFFICE_REL_NS}/image"),
            target: relative_target(new_slide_part, &media_name),
            target_mode: None,
        });
        result
            .content_types
            .push((extension, image.content_type.clone()));
    }
    for (range, replacement) in xml_replacements.into_iter().rev() {
        slide_xml.splice(range, replacement);
    }
    Ok(result)
}

fn unique_media_name(
    package: &Package,
    slide_index: usize,
    image_index: usize,
    extension: &str,
) -> Result<String, String> {
    let normalized = match extension.to_ascii_lowercase().as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        _ => return Err("只支持 PNG/JPEG 图片扩展名。".to_owned()),
    };
    let mut candidate_index = image_index + 1;
    loop {
        let candidate =
            format!("ppt/media/workbench-slide{slide_index}-image{candidate_index}.{normalized}");
        if !package.index.contains_key(&candidate) {
            return Ok(candidate);
        }
        candidate_index += 1;
        if candidate_index > MAX_PACKAGE_PARTS {
            return Err("无法为新图分配唯一 media 部件名。".to_owned());
        }
    }
}

fn replace_attribute_value(
    xml: &[u8],
    element_local: &str,
    attribute_local: &str,
    value: &str,
) -> Result<Vec<u8>, String> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    loop {
        let start = reader.buffer_position() as usize;
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(event) | Event::Empty(event))
                if local_name(event.name().as_ref()) == element_local =>
            {
                for attribute in event.attributes().with_checks(false) {
                    let attribute =
                        attribute.map_err(|error| format!("图片关系属性无效：{error}"))?;
                    if local_name(attribute.key.as_ref()) != attribute_local {
                        continue;
                    }
                    let end = reader.buffer_position() as usize;
                    let mut tag = xml[start..end].to_vec();
                    let key = attribute.key.as_ref();
                    let key_start = find_bytes(&tag, key.as_bytes())
                        .ok_or_else(|| "图片关系属性范围无法定位。".to_owned())?;
                    let mut value_start = key_start + key.len();
                    while tag.get(value_start).is_some_and(u8::is_ascii_whitespace) {
                        value_start += 1;
                    }
                    if tag.get(value_start) != Some(&b'=') {
                        return Err("图片关系属性格式无效。".to_owned());
                    }
                    value_start += 1;
                    while tag.get(value_start).is_some_and(u8::is_ascii_whitespace) {
                        value_start += 1;
                    }
                    let quote = *tag
                        .get(value_start)
                        .ok_or_else(|| "图片关系属性缺少引号。".to_owned())?;
                    if quote != b'\'' && quote != b'"' {
                        return Err("图片关系属性引号无效。".to_owned());
                    }
                    value_start += 1;
                    let value_end = tag[value_start..]
                        .iter()
                        .position(|byte| *byte == quote)
                        .map(|offset| value_start + offset)
                        .ok_or_else(|| "图片关系属性未闭合。".to_owned())?;
                    let escaped = escape_xml_attr(value);
                    tag.splice(value_start..value_end, escaped.bytes());
                    let mut output = xml.to_vec();
                    output.splice(start..end, tag);
                    return Ok(output);
                }
                return Err(format!(
                    "模板图片缺少 {element_local} 的 {attribute_local} 关系属性。"
                ));
            }
            Ok(_) => {}
            Err(error) => return Err(format!("图片 XML 无法解析：{error}")),
        }
        buffer.clear();
    }
    Err(format!("模板中缺少 {element_local} 标签。"))
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[derive(Debug, Default)]
struct NotesAddition {
    content_types: Vec<(String, String)>,
}

fn add_notes_if_supported(
    package: &mut Package,
    presentation: &mut Presentation,
    slide_rels: &mut Vec<Relationship>,
    new_slide_part: &str,
    theme_part: Option<&str>,
    spec: &ValidatedSlideSpec,
) -> Result<NotesAddition, String> {
    // A copied representative slide may have a notes relationship. It must not
    // leak the old presenter text onto the generated page.
    slide_rels.retain(|relation| !relation.kind.ends_with("/notesSlide"));
    if spec.speaker_notes.trim().is_empty() {
        return Ok(NotesAddition::default());
    }
    let (notes_master_part, mut content_types) =
        ensure_notes_master(package, presentation, theme_part)?;
    let new_notes_part = next_named_part(package, "ppt/notesSlides/notesSlide", ".xml")?;
    package.insert(
        new_notes_part.clone(),
        notes_slide_xml(&spec.speaker_notes),
        false,
    )?;
    let notes_rels = vec![
        Relationship {
            id: "rId1".to_owned(),
            kind: format!("{OFFICE_REL_NS}/notesMaster"),
            target: relative_target(&new_notes_part, &notes_master_part),
            target_mode: None,
        },
        Relationship {
            id: "rId2".to_owned(),
            kind: format!("{OFFICE_REL_NS}/slide"),
            target: relative_target(&new_notes_part, new_slide_part),
            target_mode: None,
        },
    ];
    package.insert(
        relationship_part(&new_notes_part),
        serialize_relationships(&notes_rels).into_bytes(),
        false,
    )?;

    let new_relation_id = next_relationship_id(slide_rels);
    slide_rels.push(Relationship {
        id: new_relation_id,
        kind: format!("{OFFICE_REL_NS}/notesSlide"),
        target: relative_target(new_slide_part, &new_notes_part),
        target_mode: None,
    });
    content_types.push((
        new_notes_part,
        "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml".to_owned(),
    ));
    Ok(NotesAddition { content_types })
}

fn ensure_notes_master(
    package: &mut Package,
    presentation: &mut Presentation,
    theme_part: Option<&str>,
) -> Result<(String, Vec<(String, String)>), String> {
    let mut content_types = Vec::new();
    let mut presentation_xml = package
        .get(&presentation.part)
        .ok_or_else(|| "PPTX presentation.xml 不存在。".to_owned())?
        .to_vec();
    let notes_master_ids = xml_elements(&presentation_xml, "notesMasterId")?;
    if notes_master_ids.len() > 1 {
        return Err("presentation.xml 含多个 notesMasterId，无法安全追加备注。".to_owned());
    }
    let mut relation = if let Some(range) = notes_master_ids.first() {
        let attrs = attributes_in_element(&presentation_xml, range)?;
        let id = attrs
            .iter()
            .find(|(key, _)| key.ends_with(":id"))
            .map(|(_, value)| value)
            .ok_or_else(|| "notesMasterId 缺少 r:id。".to_owned())?;
        presentation
            .relationships
            .iter()
            .find(|relation| relation.id == *id)
            .filter(|relation| {
                relation.kind.ends_with("/notesMaster") && relation.target_mode.is_none()
            })
            .cloned()
            .ok_or_else(|| "notesMasterId 没有有效的内部 notesMaster 关系。".to_owned())?
    } else {
        let mut relations = presentation.relationships.iter().filter(|relation| {
            relation.kind.ends_with("/notesMaster") && relation.target_mode.is_none()
        });
        let found = relations.next().cloned();
        if relations.next().is_some() {
            return Err("presentation.xml 含多个 notesMaster 关系，无法安全追加备注。".to_owned());
        }
        found.unwrap_or_else(|| Relationship {
            id: next_relationship_id(&presentation.relationships),
            kind: format!("{OFFICE_REL_NS}/notesMaster"),
            target: String::new(),
            target_mode: None,
        })
    };

    let master_part = if relation.target.is_empty() {
        let master_part = next_named_part(package, "ppt/notesMasters/notesMaster", ".xml")?;
        let mut master_rels = Vec::new();
        if let Some(theme_part) = theme_part.filter(|part| package.get(part).is_some()) {
            master_rels.push(Relationship {
                id: "rId1".to_owned(),
                kind: format!("{OFFICE_REL_NS}/theme"),
                target: relative_target(&master_part, theme_part),
                target_mode: None,
            });
        }
        package.insert(master_part.clone(), notes_master_xml(), false)?;
        package.insert(
            relationship_part(&master_part),
            serialize_relationships(&master_rels).into_bytes(),
            false,
        )?;
        content_types.push((
            master_part.clone(),
            "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"
                .to_owned(),
        ));
        relation.target = relative_target(&presentation.part, &master_part);
        presentation.relationships.push(relation.clone());
        presentation_xml = set_notes_master_id(&presentation_xml, &relation.id)?;
        package.insert(presentation.part.clone(), presentation_xml, false)?;
        master_part
    } else {
        let master_part = resolve_target(&presentation.part, &relation.target)?;
        if package.get(&master_part).is_none() {
            return Err(format!(
                "presentation 关系引用了缺失的 notesMaster：{master_part}"
            ));
        }
        if notes_master_ids.is_empty() {
            presentation_xml = set_notes_master_id(&presentation_xml, &relation.id)?;
            package.insert(presentation.part.clone(), presentation_xml, false)?;
        }
        master_part
    };
    Ok((master_part, content_types))
}

fn set_notes_master_id(xml: &[u8], relationship_id: &str) -> Result<Vec<u8>, String> {
    let notes_ids = xml_elements(xml, "notesMasterId")?;
    if notes_ids.iter().any(|range| {
        attributes_in_element(xml, range).ok().is_some_and(|attrs| {
            attrs
                .iter()
                .any(|(key, value)| key.ends_with(":id") && value == relationship_id)
        })
    }) {
        return Ok(xml.to_vec());
    }
    if !notes_ids.is_empty() {
        return Err("presentation.xml 的 notesMasterId 与目标关系不一致。".to_owned());
    }
    let relation_prefix = xml_elements(xml, "sldId")?
        .first()
        .and_then(|range| attributes_in_element(xml, range).ok())
        .and_then(|attrs| attrs.keys().find(|key| key.ends_with(":id")).cloned())
        .and_then(|key| key.rsplit_once(':').map(|(prefix, _)| prefix.to_owned()))
        .unwrap_or_else(|| "r".to_owned());
    if let Some(list) = xml_elements(xml, "notesMasterIdLst")?.first() {
        let tag = qname_for(xml, "notesMasterId")?.unwrap_or_else(|| {
            let prefix = list
                .qname
                .rsplit_once(':')
                .map(|(prefix, _)| prefix)
                .unwrap_or("p");
            format!("{prefix}:notesMasterId")
        });
        let fragment = format!(
            "<{tag} {relation_prefix}:id=\"{}\"/>",
            escape_xml_attr(relationship_id)
        );
        return insert_before_end(xml, "notesMasterIdLst", fragment.as_bytes());
    }
    let slide_lists = xml_elements(xml, "sldIdLst")?;
    let slide_list = slide_lists
        .first()
        .ok_or_else(|| "presentation.xml 缺少 sldIdLst。".to_owned())?;
    let prefix = slide_list
        .qname
        .rsplit_once(':')
        .map(|(prefix, _)| prefix)
        .unwrap_or("p");
    let list_tag = format!("{prefix}:notesMasterIdLst");
    let id_tag = format!("{prefix}:notesMasterId");
    let fragment = format!(
        "<{list_tag}><{id_tag} {relation_prefix}:id=\"{}\"/></{list_tag}>",
        escape_xml_attr(relationship_id)
    );
    let position = xml_elements(xml, "sldIdLst")?
        .first()
        .ok_or_else(|| "presentation.xml 缺少 sldIdLst。".to_owned())?
        .element
        .start;
    let mut output = Vec::with_capacity(xml.len() + fragment.len());
    output.extend_from_slice(&xml[..position]);
    output.extend_from_slice(fragment.as_bytes());
    output.extend_from_slice(&xml[position..]);
    Ok(output)
}

fn attributes_in_element(xml: &[u8], range: &XmlRange) -> Result<BTreeMap<String, String>, String> {
    let mut reader = Reader::from_reader(&xml[range.element.clone()]);
    let mut buffer = Vec::new();
    match reader.read_event_into(&mut buffer) {
        Ok(Event::Start(event) | Event::Empty(event)) => read_attrs(&event),
        Ok(_) => Err("XML 元素缺少起始标签。".to_owned()),
        Err(error) => Err(format!("XML 元素属性无法解析：{error}")),
    }
}

fn notes_master_xml() -> Vec<u8> {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:notesMaster xmlns:a=\"{A_NS}\" xmlns:r=\"{OFFICE_REL_NS}\" xmlns:p=\"{P_NS}\"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Notes Body\"/><p:cNvSpPr/><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1=\"lt1\" bg2=\"lt2\" tx1=\"dk1\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/></p:notesMaster>"
    )
    .into_bytes()
}

fn notes_slide_xml(text: &str) -> Vec<u8> {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:notes xmlns:a=\"{A_NS}\" xmlns:r=\"{OFFICE_REL_NS}\" xmlns:p=\"{P_NS}\"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Notes Body\"/><p:cNvSpPr/><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr wrap=\"square\"/><a:lstStyle/><a:p><a:r><a:rPr lang=\"en-US\"/><a:t xml:space=\"preserve\">{}</a:t></a:r><a:endParaRPr lang=\"en-US\"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>" ,
        escape_xml_text(text)
    )
    .into_bytes()
}

fn next_named_part(package: &Package, prefix: &str, suffix: &str) -> Result<String, String> {
    let mut index = 1usize;
    loop {
        let candidate = format!("{prefix}{index}{suffix}");
        if !package.index.contains_key(&candidate) {
            return Ok(candidate);
        }
        index += 1;
        if index > MAX_PACKAGE_PARTS {
            return Err("无法分配唯一 notesSlide 部件名。".to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const COURSE_FIXTURE: &[u8] =
        include_bytes!("../../deliverables/v0.2.0/paged-course/full-course-3pages.pptx");

    fn read_entry(bytes: &[u8], name: &str) -> Vec<u8> {
        let mut archive = ZipArchive::new(Cursor::new(bytes)).expect("valid PPTX ZIP");
        let mut file = archive.by_name(name).expect("PPTX part exists");
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).expect("PPTX part readable");
        bytes
    }

    fn spec(
        layout_ref: String,
        title: &str,
        body: Vec<SlideBodyItem>,
        images: Vec<String>,
    ) -> ValidatedSlideSpec {
        ValidatedSlideSpec {
            layout_ref,
            title: title.to_owned(),
            body,
            image_asset_ids: images,
            source_ids: Vec::new(),
            speaker_notes: String::new(),
        }
    }

    fn style_tokens(
        report: &StyleExtractionReport,
        editable_rules: EditableStyleRules,
    ) -> PresentationStyleTokens {
        let variant = &report.variants[0];
        PresentationStyleTokens {
            slide_size_emu: SlideSizeEmu {
                width: report.slide_width_emu.map(|value| value as i64),
                height: report.slide_height_emu.map(|value| value as i64),
            },
            theme_colors: variant.theme_colors.clone(),
            theme_fonts: variant.theme_fonts.clone(),
            placeholders: variant.placeholders.clone(),
            representative_objects: variant.representative_objects.clone(),
            editable_rules,
        }
    }

    #[test]
    fn inspect_pptx_extracts_size_theme_layouts_and_object_geometry() {
        let report =
            inspect_pptx(COURSE_FIXTURE).expect("fixture is a valid PresentationML package");
        assert_eq!(report.slide_count, 3);
        assert_eq!(report.ordered_slides.len(), 3);
        for (index, slide) in report.ordered_slides.iter().enumerate() {
            assert_eq!(slide.order, index + 1);
            assert_eq!(slide.part, format!("ppt/slides/slide{}.xml", index + 1));
            assert!(!slide.slide_id.is_empty());
        }
        let preview = &report.representative_previews[0];
        assert_eq!(preview.source_sha256, report.source_sha256);
        assert_eq!(preview.variant_id, report.variants[0].id);
        assert_eq!(
            preview.slide_part,
            report.variants[0].representative_slide_part
        );
        assert_eq!(preview.format, "svg");
        assert!(preview.svg.contains("双语城市导览"));
        assert!(preview.svg.contains("data:image/png;base64,"));
        assert!(!preview.svg.contains("<script"));
        assert!(preview
            .limitations
            .iter()
            .any(|text| text.contains("不是 PowerPoint 的实际渲染")));
        assert_eq!(report.slide_width_emu, Some(12_192_000));
        assert_eq!(report.slide_height_emu, Some(6_858_000));
        assert_eq!(report.source_sha256.len(), 64);
        assert_eq!(report.variants.len(), 1);
        let variant = &report.variants[0];
        assert_eq!(variant.layout_part, "ppt/slideLayouts/slideLayout1.xml");
        assert!(variant
            .representative_slide_part
            .starts_with("ppt/slides/slide"));
        assert!(variant
            .theme_colors
            .iter()
            .any(|color| color.slot == "accent1"));
        assert!(variant
            .theme_fonts
            .iter()
            .any(|font| font.scheme == "major"));
        assert!(variant.representative_objects.iter().any(|object| {
            object
                .name
                .as_deref()
                .is_some_and(|name| name.contains("heading"))
                && object.width == Some(12_192_000)
        }));
        assert!(report
            .limitations
            .iter()
            .any(|text| text.contains("视觉检查")));
    }

    #[test]
    fn discovery_text_uses_actual_slide_order_and_text_shapes() {
        let rows = extract_slide_text(COURSE_FIXTURE).expect("fixture text should be readable");
        assert!(!rows.is_empty());
        assert!(rows
            .iter()
            .all(|(slide, text)| (1..=3).contains(slide) && !text.is_empty()));
        assert!(rows
            .iter()
            .any(|(slide, text)| *slide == 1 && text.contains("双语城市导览")));
    }

    #[test]
    fn sequential_append_preserves_source_parts_and_adds_resolved_image_relationships() {
        let original_report = inspect_pptx(COURSE_FIXTURE).expect("fixture report");
        let template = original_report.variants[0]
            .representative_slide_part
            .clone();
        let variant_id = original_report.variants[0].id.clone();
        let original_slide = read_entry(COURSE_FIXTURE, &template);
        let original_theme = read_entry(COURSE_FIXTURE, "ppt/theme/theme1.xml");
        let image_bytes = read_entry(COURSE_FIXTURE, "ppt/media/image-2.jpg");
        let source_hash = sha256_hex(COURSE_FIXTURE);
        let tokens = style_tokens(&original_report, EditableStyleRules::default());

        let first_spec = spec(
            variant_id.clone(),
            "First added title",
            vec![
                SlideBodyItem {
                    kind: SlideBodyKind::Paragraph,
                    text: "First body paragraph".to_owned(),
                },
                SlideBodyItem {
                    kind: SlideBodyKind::Bullet,
                    text: "Second body bullet".to_owned(),
                },
            ],
            vec!["asset-first".to_owned()],
        );
        let first = append_slide_copy(
            COURSE_FIXTURE,
            &template,
            &first_spec,
            &tokens,
            &[ResolvedPresentationImage {
                asset_id: "asset-first".to_owned(),
                bytes: image_bytes.clone(),
                content_type: "image/jpeg".to_owned(),
                extension: "jpg".to_owned(),
            }],
        )
        .expect("first page append succeeds");
        assert_eq!(
            sha256_hex(COURSE_FIXTURE),
            source_hash,
            "the source byte slice remains unchanged"
        );

        let second_spec = spec(
            variant_id,
            "Second added title",
            vec![SlideBodyItem {
                kind: SlideBodyKind::Paragraph,
                text: "Second page body".to_owned(),
            }],
            Vec::new(),
        );
        let second = append_slide_copy(&first, &template, &second_spec, &tokens, &[])
            .expect("second append continues from the accepted copy");
        let report = inspect_pptx(&second).expect("N+2 package reparses");
        assert_eq!(
            report.slide_count, 5,
            "three source pages plus two sequential copies"
        );

        for part in [
            "ppt/slides/slide1.xml",
            "ppt/slides/slide2.xml",
            "ppt/slides/slide3.xml",
        ] {
            assert_eq!(
                read_entry(&second, part),
                read_entry(COURSE_FIXTURE, part),
                "original part preserved: {part}"
            );
        }
        assert_eq!(read_entry(&second, "ppt/theme/theme1.xml"), original_theme);
        assert_eq!(read_entry(&second, &template), original_slide);

        let added_slide = read_entry(&second, "ppt/slides/slide4.xml");
        let added_slide_xml = std::str::from_utf8(&added_slide).expect("slide XML UTF-8");
        assert!(added_slide_xml.contains("First added title"));
        assert!(added_slide_xml.contains("First body paragraph"));
        assert!(added_slide_xml.contains("Second body bullet"));
        assert!(!added_slide_xml.contains("双语城市导览"));
        let added_rels =
            parse_relationships(&read_entry(&second, "ppt/slides/_rels/slide4.xml.rels"))
                .expect("new slide rels parse");
        let embed_marker = "r:embed=\"";
        let embed_start = added_slide_xml
            .find(embed_marker)
            .expect("embedded image relationship")
            + embed_marker.len();
        let embed_end = embed_start
            + added_slide_xml[embed_start..]
                .find('"')
                .expect("relationship id closes");
        let embedded_relationship_id = &added_slide_xml[embed_start..embed_end];
        let image_relation = added_rels
            .iter()
            .find(|relation| relation.id == embedded_relationship_id)
            .expect("editable image relation");
        let image_part = resolve_target("ppt/slides/slide4.xml", &image_relation.target)
            .expect("media target resolves");
        assert_eq!(
            sha256_hex(&read_entry(&second, &image_part)),
            sha256_hex(&image_bytes)
        );
        assert!(added_slide_xml.contains(&format!("r:embed=\"{}\"", image_relation.id)));
        assert_package_relationships_resolve(&second);
    }

    #[test]
    fn insert_after_slide_id_preserves_order_and_supports_continuous_n_plus_two() {
        let source_report = inspect_pptx(COURSE_FIXTURE).expect("source report");
        let template = source_report.variants[0].representative_slide_part.clone();
        let variant_id = source_report.variants[0].id.clone();
        let tokens = style_tokens(&source_report, EditableStyleRules::default());
        let original_parts = source_report
            .ordered_slides
            .iter()
            .map(|slide| slide.part.clone())
            .collect::<Vec<_>>();
        let original_ids = source_report
            .ordered_slides
            .iter()
            .map(|slide| slide.slide_id.clone())
            .collect::<Vec<_>>();

        let first_spec = spec(variant_id.clone(), "Inserted one", Vec::new(), Vec::new());
        let first = insert_slide_copy(
            COURSE_FIXTURE,
            &template,
            &first_spec,
            &tokens,
            &[],
            Some(&original_ids[0]),
        )
        .expect("insert after the first original slide");
        let first_report = inspect_pptx(&first).expect("N+1 package reparses");
        assert_eq!(first_report.slide_count, 4);
        assert_eq!(first_report.ordered_slides[0].slide_id, original_ids[0]);
        assert_eq!(first_report.ordered_slides[1].part, "ppt/slides/slide4.xml");
        assert_eq!(first_report.ordered_slides[2].slide_id, original_ids[1]);
        assert_eq!(first_report.ordered_slides[3].slide_id, original_ids[2]);

        let second_spec = spec(variant_id, "Inserted two", Vec::new(), Vec::new());
        let second = insert_slide_copy(
            &first,
            &template,
            &second_spec,
            &tokens,
            &[],
            Some(&first_report.ordered_slides[1].slide_id),
        )
        .expect("insert after the prior generated slide");
        let second_report = inspect_pptx(&second).expect("N+2 package reparses");
        assert_eq!(second_report.slide_count, 5);
        assert_eq!(
            second_report.ordered_slides[1].slide_id,
            first_report.ordered_slides[1].slide_id
        );
        assert_eq!(
            second_report.ordered_slides[2].part,
            "ppt/slides/slide5.xml"
        );
        assert_eq!(second_report.ordered_slides[3].slide_id, original_ids[1]);
        assert_eq!(second_report.ordered_slides[4].slide_id, original_ids[2]);
        for part in &original_parts {
            assert_eq!(read_entry(&second, part), read_entry(COURSE_FIXTURE, part));
            let rels = relationship_part(part);
            assert_eq!(
                read_entry(&second, &rels),
                read_entry(COURSE_FIXTURE, &rels)
            );
        }
        assert_package_relationships_resolve(&second);
        assert!(insert_slide_copy(
            COURSE_FIXTURE,
            &template,
            &first_spec,
            &tokens,
            &[],
            Some("missing-slide-id"),
        )
        .is_err());

        let single = single_slide_copy_after(
            COURSE_FIXTURE,
            &template,
            &first_spec,
            &tokens,
            &[],
            Some(&original_ids[1]),
        )
        .expect("single accepts the same insertion selection before trimming");
        let single_report = inspect_pptx(&single).expect("single package reparses");
        assert_eq!(single_report.slide_count, 1);
        assert_eq!(single_report.ordered_slides[0].order, 1);
    }

    #[test]
    fn shared_style_markdown_tokens_deserialize_strictly_and_drive_import_rules() {
        const STYLE_MARKDOWN: &str =
            include_str!("../../tests/fixtures/presentation_style_markdown.md");
        let json = STYLE_MARKDOWN
            .split_once("```workbench-style")
            .expect("shared fixture contains the machine block")
            .1
            .split_once("\n```")
            .expect("shared machine block is fenced")
            .0
            .trim();
        let parsed: PresentationStyleTokens =
            serde_json::from_str(json).expect("shared style tokens match Rust DTO");
        assert!(parsed.editable_rules.title.font_size_hundredth_pt.is_none());
        assert!(parsed.editable_rules.body.color.is_none());

        let report = inspect_pptx(COURSE_FIXTURE).expect("source report");
        let template = report.variants[0].representative_slide_part.clone();
        let variant_id = report.variants[0].id.clone();
        let tokens = style_tokens(&report, parsed.editable_rules);
        let planned = spec(variant_id, "Shared Markdown style", Vec::new(), Vec::new());
        let output = append_slide_copy(COURSE_FIXTURE, &template, &planned, &tokens, &[])
            .expect("shared block rules apply to a generated slide");
        assert!(
            std::str::from_utf8(&read_entry(&output, "ppt/slides/slide4.xml"))
                .unwrap()
                .contains("Shared Markdown style")
        );

        let mut unknown: serde_json::Value = serde_json::from_str(json).unwrap();
        unknown["editable_rules"]["title"]["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<PresentationStyleTokens>(unknown).is_err());
    }

    #[test]
    fn current_style_tokens_change_only_the_generated_slide_and_preview() {
        let report = inspect_pptx(COURSE_FIXTURE).expect("fixture report");
        let template = report.variants[0].representative_slide_part.clone();
        let original_slide = read_entry(COURSE_FIXTURE, &template);
        let variant_id = report.variants[0].id.clone();
        let mut rules = EditableStyleRules::default();
        rules.title = EditableStyleRule {
            font_size_hundredth_pt: Some(4_600),
            color: Some("#112233".to_owned()),
            x: Some(100_000),
            y: Some(120_000),
            width: Some(11_000_000),
            height: Some(900_000),
        };
        let tokens = style_tokens(&report, rules);
        let new_spec = spec(variant_id, "Styled title", Vec::new(), Vec::new());
        let output = append_slide_copy(COURSE_FIXTURE, &template, &new_spec, &tokens, &[])
            .expect("current markdown-derived style is applied");
        assert_eq!(read_entry(&output, &template), original_slide);
        let new_slide = read_entry(&output, "ppt/slides/slide4.xml");
        let new_slide_xml = std::str::from_utf8(&new_slide).expect("new slide XML is UTF-8");
        assert!(new_slide_xml.contains("Styled title"));
        assert!(new_slide_xml.contains("sz=\"4600\""));
        assert!(new_slide_xml.contains("srgbClr val=\"112233\""));
        assert!(new_slide_xml.contains("off x=\"100000\" y=\"120000\""));
        assert!(new_slide_xml.contains("ext cx=\"11000000\" cy=\"900000\""));

        let preview = preview_slide_copy(COURSE_FIXTURE, &template, &new_spec, &tokens, &[])
            .expect("candidate preview uses the same styled append path");
        assert_eq!(preview.format, "svg");
        assert!(preview.svg.contains("Styled title"));
        assert!(preview
            .limitations
            .iter()
            .any(|text| text.contains("不是 PowerPoint")));

        let mut invalid_tokens = tokens;
        invalid_tokens.editable_rules.title.x = Some(12_000_000);
        assert!(
            append_slide_copy(COURSE_FIXTURE, &template, &new_spec, &invalid_tokens, &[])
                .expect_err("off-canvas geometry must be rejected")
                .contains("超出画布")
        );
    }

    #[test]
    fn single_export_keeps_only_new_slide_dependency_graph_and_drops_old_notes_and_media() {
        let report = inspect_pptx(COURSE_FIXTURE).expect("fixture report");
        let template = report.variants[0].representative_slide_part.clone();
        let variant_id = report.variants[0].id.clone();
        let tokens = style_tokens(&report, EditableStyleRules::default());
        let mut old_page = spec(variant_id.clone(), "Old page", Vec::new(), Vec::new());
        old_page.speaker_notes = "Source note that must not survive".to_owned();
        let mut source_with_notes =
            append_slide_copy(COURSE_FIXTURE, &template, &old_page, &tokens, &[])
                .expect("seed package with a prior notes slide");
        let mut source_package = read_package(&source_with_notes).expect("seed package reads");
        let mut root_relationships =
            parse_relationships(source_package.get("_rels/.rels").unwrap())
                .expect("package relationships parse");
        root_relationships.extend([
            Relationship {
                id: "rId-metadata".to_owned(),
                kind: format!("{OFFICE_REL_NS}/extended-properties"),
                target: "docProps/app.xml".to_owned(),
                target_mode: None,
            },
            Relationship {
                id: "rId-thumbnail".to_owned(),
                kind: format!("{OFFICE_REL_NS}/thumbnail"),
                target: "docProps/thumbnail.png".to_owned(),
                target_mode: None,
            },
            Relationship {
                id: "rId-custom".to_owned(),
                kind: format!("{OFFICE_REL_NS}/customXml"),
                target: "customXml/item1.xml".to_owned(),
                target_mode: None,
            },
        ]);
        source_package
            .insert(
                "_rels/.rels".to_owned(),
                serialize_relationships(&root_relationships).into_bytes(),
                false,
            )
            .unwrap();
        source_package
            .insert(
                "docProps/app.xml".to_owned(),
                b"<Properties><TitlesOfParts>OLD-COURSE-TITLE-SENTINEL</TitlesOfParts></Properties>".to_vec(),
                false,
            )
            .unwrap();
        source_package
            .insert(
                "docProps/thumbnail.png".to_owned(),
                b"OLD-THUMBNAIL-SENTINEL".to_vec(),
                false,
            )
            .unwrap();
        source_package
            .insert(
                "customXml/item1.xml".to_owned(),
                b"<custom>OLD-CUSTOM-XML-SENTINEL</custom>".to_vec(),
                false,
            )
            .unwrap();
        let mut content_types = source_package.get("[Content_Types].xml").unwrap().to_vec();
        for part in [
            "docProps/app.xml",
            "docProps/thumbnail.png",
            "customXml/item1.xml",
        ] {
            content_types = add_content_type_override(
                &content_types,
                &format!("/{part}"),
                if part.ends_with(".png") {
                    "image/png"
                } else {
                    "application/xml"
                },
            )
            .unwrap();
        }
        source_package
            .insert("[Content_Types].xml".to_owned(), content_types, false)
            .unwrap();
        source_with_notes =
            write_package(source_package).expect("metadata sentinel package writes");
        let old_notes_part = read_presentation(&read_package(&source_with_notes).unwrap())
            .unwrap()
            .slides
            .last()
            .and_then(|slide| {
                let package = read_package(&source_with_notes).unwrap();
                parse_relationships(package.get(&relationship_part(&slide.part)).unwrap())
                    .unwrap()
                    .into_iter()
                    .find(|relation| relation.kind.ends_with("/notesSlide"))
                    .and_then(|relation| resolve_target(&slide.part, &relation.target).ok())
            })
            .expect("seed notes slide exists");

        let new_spec = spec(variant_id, "Only exported page", Vec::new(), Vec::new());
        let output = single_slide_copy(&source_with_notes, &template, &new_spec, &tokens, &[])
            .expect("single export trims to the generated page");
        let package = read_package(&output).expect("single package reads");
        let presentation = read_presentation(&package).expect("single presentation reads");
        assert_eq!(presentation.slides.len(), 1);
        let new_slide_part = &presentation.slides[0].part;
        assert_ne!(new_slide_part, &template);
        assert!(!package.index.contains_key("ppt/slides/slide1.xml"));
        assert!(!package.index.contains_key("ppt/slides/slide2.xml"));
        assert!(!package.index.contains_key("ppt/slides/slide3.xml"));
        assert!(!package.index.contains_key("ppt/slides/slide4.xml"));
        assert!(!package.index.contains_key(&old_notes_part));
        assert!(!package
            .parts
            .iter()
            .any(|part| part.name.starts_with("ppt/notesSlides/notesSlide")));
        assert!(!package.parts.iter().any(|part| {
            part.name.starts_with("docProps/") || part.name.starts_with("customXml/")
        }));
        for sentinel in [
            b"OLD-COURSE-TITLE-SENTINEL".as_slice(),
            b"OLD-THUMBNAIL-SENTINEL".as_slice(),
            b"OLD-CUSTOM-XML-SENTINEL".as_slice(),
        ] {
            assert!(package.parts.iter().all(|part| {
                !part
                    .bytes
                    .windows(sentinel.len())
                    .any(|window| window == sentinel)
            }));
        }
        let package_relationships = parse_relationships(package.get("_rels/.rels").unwrap())
            .expect("trimmed root rels parse");
        assert_eq!(package_relationships.len(), 1);
        assert!(package_relationships[0].kind.ends_with("/officeDocument"));
        assert!(
            parse_content_types(package.get("[Content_Types].xml").unwrap())
                .unwrap()
                .iter()
                .all(|(_, name, _)| !name.starts_with("/docProps/")
                    && !name.starts_with("/customXml/"))
        );
        assert!(package
            .index
            .contains_key("ppt/slideMasters/slideMaster1.xml"));
        assert!(package
            .index
            .contains_key("ppt/slideLayouts/slideLayout1.xml"));
        assert!(package.index.contains_key("ppt/theme/theme1.xml"));
        assert!(package.index.contains_key("ppt/media/image-1.png"));
        assert!(!package.index.contains_key("ppt/media/image-2.jpg"));
        let new_slide_rels =
            parse_relationships(package.get(&relationship_part(new_slide_part)).unwrap())
                .expect("generated slide rels parse");
        assert!(!new_slide_rels
            .iter()
            .any(|relation| relation.kind.ends_with("/notesSlide")));
        assert_package_relationships_resolve(&output);
    }

    #[test]
    fn append_rejects_unresolved_images_and_writes_notes_without_a_source_notes_master() {
        let report = inspect_pptx(COURSE_FIXTURE).expect("fixture report");
        let template = report.variants[0].representative_slide_part.clone();
        let variant = report.variants[0].id.clone();
        let tokens = style_tokens(&report, EditableStyleRules::default());
        let unresolved = spec(
            variant.clone(),
            "Title",
            Vec::new(),
            vec!["asset-id".to_owned()],
        );
        assert!(append_slide_copy(COURSE_FIXTURE, &template, &unresolved, &tokens, &[]).is_err());
        let mut with_notes = spec(variant, "Title", Vec::new(), Vec::new());
        with_notes.speaker_notes = "Presenter notes & <reviewed>".to_owned();
        let output = append_slide_copy(COURSE_FIXTURE, &template, &with_notes, &tokens, &[])
            .expect("speaker notes create a notes master and notes slide");
        assert_eq!(
            sha256_hex(COURSE_FIXTURE),
            report.source_sha256,
            "source bytes are untouched"
        );

        let package = read_package(&output).expect("output package reads");
        let presentation = read_presentation(&package).expect("presentation still reads");
        let presentation_xml = package
            .get(&presentation.part)
            .expect("presentation XML exists");
        assert!(std::str::from_utf8(presentation_xml)
            .unwrap()
            .contains("notesMasterIdLst"));
        let master_relation = presentation
            .relationships
            .iter()
            .find(|relation| relation.kind.ends_with("/notesMaster"))
            .expect("presentation references a notes master");
        let master_part = resolve_target(&presentation.part, &master_relation.target)
            .expect("master target resolves");
        assert!(
            package.get(&master_part).is_some(),
            "generated notes master exists"
        );

        let slide_part = presentation
            .slides
            .last()
            .expect("new slide exists")
            .part
            .clone();
        let slide_rels = parse_relationships(package.get(&relationship_part(&slide_part)).unwrap())
            .expect("new slide relationships parse");
        let notes_relation = slide_rels
            .iter()
            .find(|relation| relation.kind.ends_with("/notesSlide"))
            .expect("new slide points to its own notes slide");
        let notes_part = resolve_target(&slide_part, &notes_relation.target)
            .expect("notes slide target resolves");
        let notes_xml =
            std::str::from_utf8(package.get(&notes_part).expect("notes slide exists")).unwrap();
        assert!(
            notes_xml.contains("Presenter notes &amp; &lt;reviewed&gt;"),
            "notes text is XML-escaped"
        );
        let notes_rels = parse_relationships(package.get(&relationship_part(&notes_part)).unwrap())
            .expect("notes slide relationships parse");
        assert!(
            notes_rels.iter().any(|relation| {
                relation.kind.ends_with("/notesMaster")
                    && resolve_target(&notes_part, &relation.target).as_deref()
                        == Ok(master_part.as_str())
            }),
            "notes slide points back to the master"
        );
        assert!(
            notes_rels.iter().any(|relation| {
                relation.kind.ends_with("/slide")
                    && resolve_target(&notes_part, &relation.target).as_deref()
                        == Ok(slide_part.as_str())
            }),
            "notes slide points back to its slide"
        );
        assert_package_relationships_resolve(&output);
    }

    fn assert_package_relationships_resolve(bytes: &[u8]) {
        let package = read_package(bytes).expect("output package reads");
        for part in package
            .parts
            .iter()
            .filter(|part| part.name.ends_with(".rels"))
        {
            let relationships = parse_relationships(&part.bytes).expect("relationship XML parses");
            let source_part = if part.name == "_rels/.rels" {
                String::new()
            } else {
                let (parent, rel_filename) = part
                    .name
                    .rsplit_once("/_rels/")
                    .expect("relationship part path");
                let filename = rel_filename
                    .strip_suffix(".rels")
                    .expect("relationship suffix");
                format!("{parent}/{filename}")
            };
            for relationship in relationships {
                if relationship.target_mode.as_deref() == Some("External") {
                    continue;
                }
                let target = resolve_target(&source_part, &relationship.target)
                    .expect("internal target resolves syntactically");
                assert!(
                    package.index.contains_key(&target),
                    "{} points to missing {target}",
                    part.name
                );
            }
        }
    }
}
