#[path = "../src/presentation_import.rs"]
mod presentation_import;

use std::fs;
use std::io::{Cursor, Read, Write};

use presentation_import::{
    append_slide_copy, insert_slide_copy, inspect_pptx, single_slide_copy_after, EditableStyleRule,
    EditableStyleRules, PresentationStyleTokens, ResolvedPresentationImage, SlideBodyItem,
    SlideBodyKind, ValidatedSlideSpec,
};
use sha2::Digest;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const COURSE_FIXTURE: &[u8] =
    include_bytes!("../../deliverables/v0.2.0/paged-course/full-course-3pages.pptx");

fn zip_entry(bytes: &[u8], name: &str) -> Vec<u8> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).expect("valid fixture ZIP");
    let mut file = archive.by_name(name).expect("fixture part exists");
    let mut contents = Vec::new();
    file.read_to_end(&mut contents).expect("read fixture part");
    contents
}

fn add_second_layout_on_same_master(bytes: &[u8]) -> Vec<u8> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).expect("valid fixture ZIP");
    let mut parts = Vec::<(String, Vec<u8>)>::new();
    let mut layout_xml = None;
    let mut layout_rels = None;
    let mut master_xml = None;
    let mut master_rels = None;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).expect("fixture ZIP entry");
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_owned();
        let mut contents = Vec::new();
        entry
            .read_to_end(&mut contents)
            .expect("read fixture entry");
        match name.as_str() {
            "ppt/slideLayouts/slideLayout1.xml" => layout_xml = Some(contents.clone()),
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels" => layout_rels = Some(contents.clone()),
            "ppt/slideMasters/slideMaster1.xml" => {
                let xml = String::from_utf8(contents).expect("master XML UTF-8");
                contents = xml
                    .replace(
                        "</p:sldLayoutIdLst>",
                        "<p:sldLayoutId id=\"2147483650\" r:id=\"rId3\"/></p:sldLayoutIdLst>",
                    )
                    .into_bytes();
                master_xml = Some(contents.clone());
            }
            "ppt/slideMasters/_rels/slideMaster1.xml.rels" => {
                let mut rels = String::from_utf8(contents).expect("master rels UTF-8");
                let end = rels
                    .rfind("</Relationships>")
                    .expect("master rels root closes");
                rels.insert_str(
                    end,
                    "<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout2.xml\"/>",
                );
                contents = rels.into_bytes();
                master_rels = Some(contents.clone());
            }
            "ppt/slides/_rels/slide2.xml.rels" => {
                let rels = String::from_utf8(contents).expect("slide rels UTF-8");
                contents = rels
                    .replace(
                        "../slideLayouts/slideLayout1.xml",
                        "../slideLayouts/slideLayout2.xml",
                    )
                    .into_bytes();
            }
            "[Content_Types].xml" => {
                let mut xml = String::from_utf8(contents).expect("content types UTF-8");
                let end = xml.rfind("</Types>").expect("content types root closes");
                xml.insert_str(
                    end,
                    "<Override PartName=\"/ppt/slideLayouts/slideLayout2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/>",
                );
                contents = xml.into_bytes();
            }
            _ => {}
        }
        parts.push((name, contents));
    }
    parts.push((
        "ppt/slideLayouts/slideLayout2.xml".to_owned(),
        layout_xml.expect("fixture layout XML"),
    ));
    parts.push((
        "ppt/slideLayouts/_rels/slideLayout2.xml.rels".to_owned(),
        layout_rels.expect("fixture layout relationships"),
    ));
    assert!(master_xml.is_some() && master_rels.is_some());
    let mut output = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, contents) in parts {
        output
            .start_file(name, options)
            .expect("write fixture part");
        output.write_all(&contents).expect("write fixture bytes");
    }
    output
        .finish()
        .expect("finish multi-layout ZIP")
        .into_inner()
}

fn review_spec(layout_ref: &str, title: &str) -> ValidatedSlideSpec {
    ValidatedSlideSpec {
        layout_ref: layout_ref.to_owned(),
        title: title.to_owned(),
        body: vec![SlideBodyItem {
            kind: SlideBodyKind::Paragraph,
            text: "临时验收样例，不是课程内容".to_owned(),
        }],
        image_asset_ids: Vec::new(),
        source_ids: Vec::new(),
        speaker_notes: String::new(),
    }
}

fn tokens_for(
    report: &presentation_import::StyleExtractionReport,
    variant_index: usize,
    rules: EditableStyleRules,
) -> PresentationStyleTokens {
    let variant = &report.variants[variant_index];
    PresentationStyleTokens {
        slide_size_emu: presentation_import::SlideSizeEmu {
            width: report.slide_width_emu.map(|value| value as i64),
            height: report.slide_height_emu.map(|value| value as i64),
        },
        theme_colors: variant.theme_colors.clone(),
        theme_fonts: variant.theme_fonts.clone(),
        placeholders: variant.placeholders.clone(),
        representative_objects: variant.representative_objects.clone(),
        editable_rules: rules,
    }
}

#[test]
#[ignore = "writes temporary PPTX packages for manual Office inspection"]
fn generate_office_review_samples() {
    let output_dir = std::env::var_os("ACW_PPTX_REVIEW_DIR")
        .expect("set ACW_PPTX_REVIEW_DIR to a temporary output directory");
    let output_dir = std::path::PathBuf::from(output_dir);
    fs::create_dir_all(&output_dir).expect("create sample output directory");

    let report = inspect_pptx(COURSE_FIXTURE).expect("real repository PPTX fixture parses");
    assert_eq!(report.slide_count, 3);
    assert_eq!(report.variants.len(), 1);
    let template = report.variants[0].representative_slide_part.as_str();
    let variant_id = report.variants[0].id.clone();
    let tokens = tokens_for(&report, 0, EditableStyleRules::default());
    fs::write(output_dir.join("n-source-fixture.pptx"), COURSE_FIXTURE).expect("write source copy");

    let first = append_slide_copy(
        COURSE_FIXTURE,
        template,
        &review_spec(&variant_id, "N+1 review slide"),
        &tokens,
        &[],
    )
    .expect("append N+1 sample");
    assert_eq!(inspect_pptx(&first).unwrap().slide_count, 4);
    fs::write(output_dir.join("n-plus-1.pptx"), &first).expect("write N+1 sample");
    let second = append_slide_copy(
        &first,
        template,
        &review_spec(&variant_id, "N+2 review slide"),
        &tokens,
        &[],
    )
    .expect("append N+2 sample");
    assert_eq!(inspect_pptx(&second).unwrap().slide_count, 5);
    fs::write(output_dir.join("n-plus-2.pptx"), &second).expect("write N+2 sample");

    let single = single_slide_copy_after(
        COURSE_FIXTURE,
        template,
        &review_spec(&variant_id, "Single review slide"),
        &tokens,
        &[],
        Some(&report.ordered_slides[0].slide_id),
    )
    .expect("single sample");
    assert_eq!(inspect_pptx(&single).unwrap().slide_count, 1);
    fs::write(output_dir.join("single.pptx"), &single).expect("write single sample");

    let mut styled_rules = EditableStyleRules::default();
    styled_rules.title = EditableStyleRule {
        font_size_hundredth_pt: Some(4_200),
        color: Some("#4E3B73".to_owned()),
        x: Some(100_000),
        y: Some(120_000),
        width: Some(11_000_000),
        height: Some(900_000),
    };
    let image = zip_entry(COURSE_FIXTURE, "ppt/media/image-2.jpg");
    let mut styled_spec = review_spec(&variant_id, "Style, image, notes review");
    styled_spec.image_asset_ids = vec!["review-image".to_owned()];
    styled_spec.speaker_notes = "Temporary Office review note.".to_owned();
    let styled = append_slide_copy(
        COURSE_FIXTURE,
        template,
        &styled_spec,
        &tokens_for(&report, 0, styled_rules),
        &[ResolvedPresentationImage {
            asset_id: "review-image".to_owned(),
            bytes: image,
            content_type: "image/jpeg".to_owned(),
            extension: "jpg".to_owned(),
        }],
    )
    .expect("styled image and notes sample");
    assert_eq!(inspect_pptx(&styled).unwrap().slide_count, 4);
    fs::write(output_dir.join("style-image-notes.pptx"), &styled)
        .expect("write style/image/notes sample");

    let multi_layout = add_second_layout_on_same_master(COURSE_FIXTURE);
    let multi_report = inspect_pptx(&multi_layout).expect("synthetic multi-layout package parses");
    assert_eq!(multi_report.variants.len(), 2);
    assert_eq!(
        multi_report.variants[0].master_part, multi_report.variants[1].master_part,
        "the synthetic layouts share one master"
    );
    fs::write(
        output_dir.join("multi-layout-source-synthetic.pptx"),
        &multi_layout,
    )
    .expect("write synthetic multi-layout source");
    let second_layout_variant = multi_report
        .variants
        .iter()
        .position(|variant| {
            variant
                .slide_parts
                .iter()
                .any(|part| part == "ppt/slides/slide2.xml")
        })
        .expect("slide 2 uses the second layout variant");
    let second_layout = &multi_report.variants[second_layout_variant];
    let selected = review_spec(&second_layout.id, "Insert after first original slide");
    let inserted = insert_slide_copy(
        &multi_layout,
        &second_layout.representative_slide_part,
        &selected,
        &tokens_for(
            &multi_report,
            second_layout_variant,
            EditableStyleRules::default(),
        ),
        &[],
        Some(&multi_report.ordered_slides[0].slide_id),
    )
    .expect("insert on second layout after first slide");
    let inserted_report = inspect_pptx(&inserted).expect("inserted multi-layout sample parses");
    assert_eq!(inserted_report.slide_count, 4);
    assert_eq!(
        inserted_report.ordered_slides[0].slide_id,
        multi_report.ordered_slides[0].slide_id
    );
    assert_eq!(
        inserted_report.ordered_slides[1].part,
        "ppt/slides/slide4.xml"
    );
    assert_eq!(
        inserted_report.ordered_slides[2].slide_id,
        multi_report.ordered_slides[1].slide_id
    );
    fs::write(
        output_dir.join("multi-layout-insert-after-first.pptx"),
        &inserted,
    )
    .expect("write multi-layout insertion sample");

    let hash = format!("{:x}", sha2::Sha256::digest(COURSE_FIXTURE));
    let manifest = format!(
        "Source: deliverables/v0.2.0/paged-course/full-course-3pages.pptx\nSource SHA-256: {hash}\nSource facts: 3 slides, 1 master, 1 layout, 1 extracted variant.\nMulti-layout sample is synthetic: it clones the fixture layout part, routes slide 2 through the clone, and keeps the same master. It has 1 master and 2 layouts.\nSamples: n-source-fixture.pptx (N=3), n-plus-1.pptx (N+1=4), n-plus-2.pptx (N+2=5), single.pptx (1), style-image-notes.pptx (N+1, style/image/notes), multi-layout-source-synthetic.pptx (N=3), multi-layout-insert-after-first.pptx (N+1, insert after first real slide ID).\n"
    );
    fs::write(output_dir.join("manifest.txt"), manifest).expect("write sample manifest");
    println!("PPTX review samples: {}", output_dir.display());
}
