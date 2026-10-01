use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const EMU_PER_POINT: f64 = 12_700.0;
const DEFAULT_PAGE_WIDTH_PT: f64 = 595.2756;
const DEFAULT_PAGE_HEIGHT_PT: f64 = 841.8898;
pub(crate) const EXPLICIT_TARGET_PAGE_SIZE_REQUIRED: &str = "explicit_target_page_size_required";

#[derive(Clone, Copy, Debug)]
struct PageSize {
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

struct Page<'a> {
    lesson: &'a Value,
    value: &'a Value,
}

pub(crate) fn legacy_grid_section_notices(
    project: &Value,
    content_item_id: Option<&str>,
    selected_layout_id: Option<&str>,
) -> Result<Vec<Value>, String> {
    let layout_ids = if let Some(layout_id) = selected_layout_id {
        vec![layout_id.to_owned()]
    } else {
        let mut items = project
            .get("content_items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|item| {
                item.get("archived").and_then(Value::as_bool) != Some(true)
                    && content_item_id.map_or(true, |id| {
                        item.get("id").and_then(Value::as_str) == Some(id)
                    })
            })
            .collect::<Vec<_>>();
        items.sort_by(|left, right| {
            left.get("order_index")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .cmp(
                    &right
                        .get("order_index")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                )
                .then_with(|| {
                    left.get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .cmp(right.get("id").and_then(Value::as_str).unwrap_or(""))
                })
        });
        let layouts = project
            .get("layout_instances")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        items
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .filter_map(|item_id| {
                layouts
                    .iter()
                    .find(|layout| {
                        layout.get("content_item_id").and_then(Value::as_str) == Some(item_id)
                    })
                    .and_then(|layout| layout.get("id").and_then(Value::as_str))
            })
            .map(str::to_owned)
            .collect()
    };
    legacy_grid_section_notices_for_layouts(project, &layout_ids)
}

fn legacy_grid_section_notices_for_layouts(
    project: &Value,
    layout_ids: &[String],
) -> Result<Vec<Value>, String> {
    let mut notices = Vec::new();
    for layout_id in layout_ids {
        let layout = project
            .get("layout_instances")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|layout| layout.get("id").and_then(Value::as_str) == Some(layout_id))
            .ok_or("投影引用的排版版本不存在")?;
        if layout.get("mode").and_then(Value::as_str) != Some("grid")
            || layout
                .get("pagination_mode")
                .and_then(Value::as_str)
                .unwrap_or("continuous")
                != "continuous"
        {
            continue;
        }
        let mut sections = project
            .get("layout_sections")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|section| {
                section.get("layout_instance_id").and_then(Value::as_str)
                    == Some(layout_id.as_str())
            })
            .collect::<Vec<_>>();
        sections.sort_by(|left, right| {
            left.get("order_index")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .cmp(
                    &right
                        .get("order_index")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                )
                .then_with(|| {
                    left.get("page_index")
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                        .cmp(&right.get("page_index").and_then(Value::as_i64).unwrap_or(0))
                })
                .then_with(|| {
                    left.get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .cmp(right.get("id").and_then(Value::as_str).unwrap_or(""))
                })
        });
        let section_ids = sections
            .iter()
            .filter_map(|section| section.get("id").and_then(Value::as_str))
            .collect::<HashSet<_>>();
        let mut used_sections = HashSet::new();
        let mut includes_unsectioned = false;
        for placement in project
            .get("placements")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|placement| {
                placement.get("layout_instance_id").and_then(Value::as_str)
                    == Some(layout_id.as_str())
            })
        {
            match placement.get("section_id") {
                None | Some(Value::Null) => includes_unsectioned = true,
                Some(Value::String(section_id)) if section_ids.contains(section_id.as_str()) => {
                    used_sections.insert(section_id.as_str());
                }
                _ => return Err("排版正文引用了不属于该版本的分区。".into()),
            }
        }
        if used_sections.len() + usize::from(includes_unsectioned) <= 1 {
            continue;
        }
        let ordered_section_ids = sections
            .iter()
            .filter_map(|section| section.get("id").and_then(Value::as_str))
            .filter(|section_id| used_sections.contains(section_id))
            .collect::<Vec<_>>();
        notices.push(json!({
            "code": "legacy_grid_sections_require_pagination",
            "layout_instance_id": layout_id,
            "section_ids": ordered_section_ids,
            "includes_unsectioned": includes_unsectioned,
            "message": "旧版连续 Grid 的多个分区或根级正文没有唯一页面边界，请先启用分页。"
        }));
    }
    Ok(notices)
}

pub(crate) fn validate_projection(
    projection: &Value,
    project: &Value,
    content_item_id: Option<&str>,
    format: &str,
) -> Result<(), String> {
    let projection_value = projection;
    let projection = projection_value
        .as_object()
        .ok_or("布局导出缺少结构化投影")?;
    if projection.get("schema_version").and_then(Value::as_str) != Some("2") {
        return Err("布局导出投影版本不受支持，请重新预检。".into());
    }
    let project_id = project
        .get("project")
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .ok_or("课程项目缺少稳定 ID")?;
    let current_updated_at = project
        .get("project")
        .and_then(|value| value.get("updated_at"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if projection.get("project_id").and_then(Value::as_str) != Some(project_id)
        || projection
            .get("generated_from_updated_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            != current_updated_at
    {
        return Err("导出投影与当前课程版本不一致，请重新预检后再试。".into());
    }
    if projection.get("content_item_id").and_then(Value::as_str) != content_item_id {
        return Err("导出投影的课时范围与当前选择不一致。".into());
    }
    let expected_scope = if content_item_id.is_some() {
        "lesson"
    } else {
        "course"
    };
    if projection.get("scope").and_then(Value::as_str) != Some(expected_scope) {
        return Err("导出投影的范围标记与当前选择不一致。".into());
    }

    let selection = projection
        .get("selection")
        .and_then(Value::as_object)
        .ok_or("导出投影缺少页面范围")?;
    if selection.get("content_item_id").and_then(Value::as_str) != content_item_id {
        return Err("导出页面范围与当前课时不一致。".into());
    }
    let selected_layout = selection.get("layout_instance_id").and_then(Value::as_str);
    if selected_layout.is_some() && content_item_id.is_none() {
        return Err("跨课时导出不能指定单个排版。".into());
    }
    if let Some(selected_layout) = selected_layout {
        let canonical = project
            .get("layout_instances")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|layout| layout.get("id").and_then(Value::as_str) == Some(selected_layout));
        if canonical.is_none_or(|layout| {
            layout.get("content_item_id").and_then(Value::as_str) != content_item_id
        }) {
            return Err("指定的排版不属于当前导出课时。".into());
        }
    }
    let requested_page_ids = match selection.get("page_ids") {
        None | Some(Value::Null) => None,
        Some(Value::Array(values)) => {
            let mut seen = HashSet::new();
            let mut ids = Vec::with_capacity(values.len());
            for value in values {
                let id = value
                    .as_str()
                    .filter(|id| !id.trim().is_empty())
                    .ok_or("页面范围包含无效的页面 ID")?;
                if !seen.insert(id.to_owned()) {
                    return Err("页面范围包含重复页面 ID。".into());
                }
                ids.push(id.to_owned());
            }
            Some(ids)
        }
        _ => return Err("页面范围必须是页面 ID 列表或 null。".into()),
    };
    if requested_page_ids.as_ref().is_some_and(Vec::is_empty) {
        return Err("页面范围至少要包含一页。".into());
    }

    let lessons = projection
        .get("lessons")
        .and_then(Value::as_array)
        .ok_or("导出投影缺少课时")?;
    let mut expected_lessons = project
        .get("content_items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            item.get("archived").and_then(Value::as_bool) != Some(true)
                && content_item_id.map_or(true, |id| {
                    item.get("id").and_then(Value::as_str) == Some(id)
                })
        })
        .collect::<Vec<_>>();
    expected_lessons.sort_by(|left, right| {
        left.get("order_index")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .cmp(
                &right
                    .get("order_index")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
            )
            .then_with(|| {
                left.get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .cmp(right.get("id").and_then(Value::as_str).unwrap_or(""))
            })
    });
    let expected_ids = expected_lessons
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let projected_ids = lessons
        .iter()
        .filter_map(|lesson| lesson.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    if expected_ids != projected_ids {
        return Err("导出投影课时与当前课程范围不一致，请重新预检。".into());
    }
    let mut all_page_ids = HashSet::new();
    let mut selected_page_ids = HashSet::new();
    let mut selected_pages = Vec::new();
    let mut has_flow = false;
    let mut matched_layout = selected_layout.is_none();
    for lesson in lessons {
        let layout = lesson.get("layout").unwrap_or(&Value::Null);
        let lesson_id = lesson.get("id").and_then(Value::as_str).unwrap_or("");
        let layout_id = layout.get("layout_instance_id").and_then(Value::as_str);
        let expected_layout_id = project
            .get("layout_instances")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|candidate| {
                candidate.get("content_item_id").and_then(Value::as_str) == Some(lesson_id)
                    && selected_layout
                        .is_none_or(|id| candidate.get("id").and_then(Value::as_str) == Some(id))
            })
            .and_then(|candidate| candidate.get("id").and_then(Value::as_str));
        if expected_layout_id != layout_id {
            return Err("课时投影没有使用课程当前默认排版版本。".into());
        }
        let canonical_layout = layout_id.and_then(|id| {
            project
                .get("layout_instances")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(id))
        });
        if !layout.is_null() && (layout_id.is_none() || canonical_layout.is_none()) {
            return Err("课时投影引用了不存在的排版版本。".into());
        }
        if let Some(canonical) = canonical_layout {
            if canonical.get("content_item_id").and_then(Value::as_str) != Some(lesson_id)
                || canonical.get("mode").and_then(Value::as_str)
                    != layout.get("mode").and_then(Value::as_str)
                || canonical
                    .get("pagination_mode")
                    .and_then(Value::as_str)
                    .unwrap_or("continuous")
                    != layout
                        .get("pagination_mode")
                        .and_then(Value::as_str)
                        .unwrap_or("continuous")
            {
                return Err("课时投影的排版版本与课程数据不一致。".into());
            }
        }
        if let Some(selected_layout) = selected_layout {
            if layout_id != Some(selected_layout) {
                continue;
            }
            matched_layout = true;
        }
        if layout.is_null() || layout.get("mode").and_then(Value::as_str) == Some("flow") {
            has_flow = true;
            continue;
        }
        let pages = layout
            .get("pages")
            .and_then(Value::as_array)
            .ok_or("网格排版缺少页面投影")?;
        let paged = layout.get("pagination_mode").and_then(Value::as_str) == Some("paged");
        if !paged && requested_page_ids.is_some() {
            return Err("连续排版没有稳定页面 ID，不能按页筛选。".into());
        }
        if paged {
            let mut canonical_pages = project
                .get("layout_pages")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|page| page.get("layout_instance_id").and_then(Value::as_str) == layout_id)
                .collect::<Vec<_>>();
            canonical_pages.sort_by(|left, right| {
                left.get("order_index")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .cmp(
                        &right
                            .get("order_index")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                    )
                    .then_with(|| {
                        left.get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .cmp(right.get("id").and_then(Value::as_str).unwrap_or(""))
                    })
            });
            let selected: Vec<&str> = canonical_pages
                .iter()
                .filter_map(|page| page.get("id").and_then(Value::as_str))
                .filter(|id| {
                    requested_page_ids
                        .as_ref()
                        .is_none_or(|requested| requested.contains(&id.to_string()))
                })
                .collect();
            let actual: Vec<&str> = pages
                .iter()
                .filter_map(|page| page.get("page_id").and_then(Value::as_str))
                .collect();
            if actual != selected {
                return Err("页面投影与课程页面顺序不一致，请重新预检。".into());
            }
        } else if pages.len() != 1 {
            return Err("连续排版应只投影一个逻辑页面。".into());
        }
        for (page_index, page) in pages.iter().enumerate() {
            let raw_id = page
                .get("page_id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty());
            let page_key = if paged {
                raw_id.ok_or("页面投影缺少稳定 ID")?.to_owned()
            } else {
                format!(
                    "legacy:{}:{}",
                    layout_id.unwrap_or("unknown"),
                    page_index + 1
                )
            };
            if paged && !all_page_ids.insert(page_key.clone()) {
                return Err("页面投影包含重复页面 ID。".into());
            }
            validate_page(page)?;
            let include = !paged
                || requested_page_ids.as_ref().map_or(true, |ids| {
                    raw_id.is_some_and(|page_id| ids.iter().any(|id| id == page_id))
                });
            if include {
                if paged {
                    selected_page_ids.insert(page_key);
                }
                selected_pages.push(Page {
                    lesson,
                    value: page,
                });
            }
        }
    }
    if !matched_layout {
        return Err("指定的排版不属于当前导出课时。".into());
    }
    let projected_layout_ids = lessons
        .iter()
        .filter_map(|lesson| {
            lesson
                .get("layout")
                .and_then(|layout| layout.get("layout_instance_id"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    validate_projection_notices(projection_value, project, &projected_layout_ids)?;
    if let Some(ids) = requested_page_ids {
        if ids.iter().any(|id| !selected_page_ids.contains(id)) {
            return Err("页面范围包含当前排版中不存在的页面。".into());
        }
    }
    if selected_pages.is_empty() && !has_flow {
        return Err("当前范围没有可导出的页面。".into());
    }
    if format == "pptx" && has_flow {
        let titles = lessons
            .iter()
            .filter(|lesson| {
                lesson.get("layout").is_none_or(|layout| {
                    layout.is_null() || layout.get("mode").and_then(Value::as_str) == Some("flow")
                })
            })
            .filter_map(|lesson| lesson.get("title").and_then(Value::as_str))
            .collect::<Vec<_>>();
        return Err(format!(
            "PPTX 不能自动把连续课时转换为幻灯片；请先选择已排版课时。{}",
            if titles.is_empty() {
                String::new()
            } else {
                format!(" 不兼容课时：{}。", titles.join("、"))
            }
        ));
    }
    if format == "pptx" && selected_pages.is_empty() {
        return Err("PPTX 导出范围没有可用页面。".into());
    }
    if matches!(format, "pdf" | "pptx")
        && projection
            .get("target_page_size")
            .is_none_or(Value::is_null)
        && selected_pages.first().is_some_and(|first| {
            let width = first.value.get("logical_width_pt").and_then(Value::as_f64);
            let height = first.value.get("logical_height_pt").and_then(Value::as_f64);
            selected_pages.iter().skip(1).any(|page| {
                let other_width = page.value.get("logical_width_pt").and_then(Value::as_f64);
                let other_height = page.value.get("logical_height_pt").and_then(Value::as_f64);
                width
                    .zip(other_width)
                    .is_none_or(|(a, b)| (a - b).abs() > 0.01)
                    || height
                        .zip(other_height)
                        .is_none_or(|(a, b)| (a - b).abs() > 0.01)
            })
        })
    {
        return Err(EXPLICIT_TARGET_PAGE_SIZE_REQUIRED.into());
    }
    page_size_from_target(projection.get("target_page_size"), &selected_pages)?;

    let mut media_ids = HashSet::new();
    if let Some(media) = projection.get("media").and_then(Value::as_array) {
        for entry in media {
            let id = entry
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or("导出投影包含无效素材 ID")?;
            if !media_ids.insert(id.to_owned()) {
                return Err("导出投影包含重复素材 ID。".into());
            }
            if [
                "source_path",
                "storage_path",
                "absolute_path",
                "bytes",
                "bytes_base64",
            ]
            .iter()
            .any(|key| entry.get(*key).is_some())
            {
                return Err("导出投影不得包含素材绝对路径或原始字节。".into());
            }
            let path = entry
                .get("output_path")
                .and_then(Value::as_str)
                .ok_or("导出投影素材缺少输出路径")?;
            validate_relative_path(path)?;
        }
    }
    for page in selected_pages {
        if let Some(items) = page.value.get("items").and_then(Value::as_array) {
            for item in items {
                if let Some(media_id) = item
                    .get("media")
                    .and_then(|media| media.get("id"))
                    .and_then(Value::as_str)
                {
                    if !media_ids.contains(media_id) {
                        return Err("页面引用了未包含在投影中的素材。".into());
                    }
                }
            }
        }
    }
    for lesson in lessons {
        for block in lesson
            .get("blocks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .chain(
                lesson
                    .get("attachments")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten(),
            )
        {
            if let Some(media) = block.get("media").filter(|value| !value.is_null()) {
                let id = media
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or("课时素材缺少稳定 ID")?;
                if !media_ids.contains(id) {
                    return Err("课时引用了未包含在投影中的素材。".into());
                }
                if [
                    "source_path",
                    "storage_path",
                    "absolute_path",
                    "bytes",
                    "bytes_base64",
                ]
                .iter()
                .any(|key| media.get(*key).is_some())
                {
                    return Err("导出投影不得包含素材绝对路径或原始字节。".into());
                }
            }
        }
    }
    Ok(())
}

fn validate_projection_notices(
    projection: &Value,
    project: &Value,
    layout_ids: &[String],
) -> Result<(), String> {
    let expected = legacy_grid_section_notices_for_layouts(project, layout_ids)?;
    let actual_value = projection.get("notices");
    if !expected.is_empty() && actual_value.is_none() {
        return Err("导出投影缺少连续 Grid 分区歧义提示。".into());
    }
    let actual: &[Value] = match actual_value {
        None | Some(Value::Null) => &[],
        Some(Value::Array(values)) => values,
        _ => return Err("导出投影提示格式无效。".into()),
    };
    let read_notice = |notice: &Value| -> Result<(String, Vec<String>, bool), String> {
        let code = notice
            .get("code")
            .and_then(Value::as_str)
            .ok_or("导出投影提示缺少代码")?;
        if code != "legacy_grid_sections_require_pagination" {
            return Err("导出投影包含未知提示。".into());
        }
        let layout_id = notice
            .get("layout_instance_id")
            .and_then(Value::as_str)
            .ok_or("导出投影提示缺少排版版本")?;
        let section_ids = notice
            .get("section_ids")
            .and_then(Value::as_array)
            .ok_or("导出投影提示缺少分区 ID")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "导出投影提示包含无效分区 ID".into())
            })
            .collect::<Result<Vec<_>, String>>()?;
        let includes_unsectioned = notice
            .get("includes_unsectioned")
            .and_then(Value::as_bool)
            .ok_or("导出投影提示缺少根级正文标记")?;
        if notice.get("message").and_then(Value::as_str).is_none() {
            return Err("导出投影提示缺少说明。".into());
        }
        Ok((layout_id.to_owned(), section_ids, includes_unsectioned))
    };
    let mut expected_keys = HashSet::new();
    for notice in &expected {
        expected_keys.insert(read_notice(notice)?);
    }
    let mut actual_keys = HashSet::new();
    for notice in actual {
        let key = read_notice(notice)?;
        if !actual_keys.insert(key) {
            return Err("导出投影包含重复歧义提示。".into());
        }
    }
    if expected_keys != actual_keys {
        return Err("导出投影的 Grid 分区歧义提示与课程数据不一致。".into());
    }
    Ok(())
}

pub(crate) fn selected_media_ids(projection: &Value) -> Vec<String> {
    let mut ids = HashSet::new();
    let selected_pages = collect_pages(projection);
    for page in selected_pages {
        if let Some(items) = page.value.get("items").and_then(Value::as_array) {
            for item in items {
                if let Some(id) = item
                    .get("media")
                    .and_then(|media| media.get("id"))
                    .and_then(Value::as_str)
                {
                    ids.insert(id.to_owned());
                }
                for media in item
                    .get("inline_media")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(id) = media.get("id").and_then(Value::as_str) {
                        ids.insert(id.to_owned());
                    }
                }
            }
        }
    }
    if let Some(lessons) = projection.get("lessons").and_then(Value::as_array) {
        for lesson in lessons {
            let layout = lesson.get("layout").unwrap_or(&Value::Null);
            let paged = layout.get("pages").and_then(Value::as_array).is_some();
            let blocks = if paged {
                None
            } else {
                lesson.get("blocks").and_then(Value::as_array)
            };
            for media in blocks
                .into_iter()
                .flatten()
                .filter_map(|block| block.get("media"))
                .chain(
                    lesson
                        .get("attachments")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten(),
                )
            {
                if let Some(id) = media.get("id").and_then(Value::as_str) {
                    ids.insert(id.to_owned());
                }
            }
            for media in blocks.into_iter().flatten().flat_map(|block| {
                block
                    .get("inline_media")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            }) {
                if let Some(id) = media.get("id").and_then(Value::as_str) {
                    ids.insert(id.to_owned());
                }
            }
        }
    }
    let mut result = ids.into_iter().collect::<Vec<_>>();
    result.sort();
    result
}

pub(crate) fn has_simplified_pptx_semantics(projection: &Value) -> bool {
    fn complex(blocks: &[Value], list_depth: usize) -> bool {
        blocks.iter().any(|block| {
            let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
            if kind == "table" || (kind == "list" && list_depth > 0) {
                return true;
            }
            if let Some(children) = block.get("children").and_then(Value::as_array) {
                if complex(children, list_depth) {
                    return true;
                }
            }
            if let Some(items) = block.get("items").and_then(Value::as_array) {
                for item in items {
                    if item
                        .get("children")
                        .and_then(Value::as_array)
                        .is_some_and(|children| complex(children, list_depth + 1))
                    {
                        return true;
                    }
                }
            }
            false
        })
    }
    for page in collect_pages(projection) {
        if page
            .value
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|item| {
                item.get("rich_text")
                    .and_then(Value::as_array)
                    .is_some_and(|nodes| complex(nodes, 0))
            })
        {
            return true;
        }
    }
    projection
        .get("lessons")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|lesson| {
            let has_pages = lesson
                .get("layout")
                .and_then(|layout| layout.get("pages"))
                .and_then(Value::as_array)
                .is_some_and(|pages| !pages.is_empty());
            !has_pages
                && lesson
                    .get("blocks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .any(|block| {
                        block
                            .get("rich_text")
                            .and_then(Value::as_array)
                            .is_some_and(|nodes| complex(nodes, 0))
                    })
        })
}

pub(crate) fn unplaced_block_ids(projection: &Value) -> Vec<String> {
    if projection
        .get("selection")
        .and_then(|selection| selection.get("page_ids"))
        .is_some_and(|page_ids| !page_ids.is_null())
    {
        return Vec::new();
    }
    let selection = projection.get("selection").unwrap_or(&Value::Null);
    let selected_layout = selection.get("layout_instance_id").and_then(Value::as_str);
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for lesson in projection
        .get("lessons")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let layout = lesson.get("layout").unwrap_or(&Value::Null);
        if selected_layout
            .is_some_and(|id| layout.get("layout_instance_id").and_then(Value::as_str) != Some(id))
        {
            continue;
        }
        for block_id in layout
            .get("unplaced_block_ids")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if seen.insert(block_id.to_owned()) {
                result.push(block_id.to_owned());
            }
        }
    }
    result
}

pub(crate) fn unplaced_attachment_ids(projection: &Value) -> Vec<String> {
    let mut seen = HashSet::new();
    projection
        .get("lessons")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|lesson| {
            lesson
                .get("attachments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|media| media.get("id").and_then(Value::as_str))
        .filter(|id| seen.insert((*id).to_owned()))
        .map(str::to_owned)
        .collect()
}

pub(crate) fn render_html(
    projection: &Value,
    media_sources: &HashMap<String, String>,
    print_mode: bool,
) -> Result<String, String> {
    let pages = collect_pages(projection);
    let size = page_size(projection, &pages)?;
    let fit_to_target = projection
        .get("target_page_size")
        .is_some_and(|value| !value.is_null());
    let title = esc_html(
        projection
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("课程"),
    );
    let mut body = String::new();
    let lessons = projection
        .get("lessons")
        .and_then(Value::as_array)
        .ok_or("导出投影缺少课时")?;
    let mut page_index = 0;
    for lesson in lessons {
        let layout = lesson.get("layout").unwrap_or(&Value::Null);
        let layout_pages = layout.get("pages").and_then(Value::as_array);
        let lesson_id = lesson.get("id").and_then(Value::as_str);
        let matching: Vec<&Value> = pages
            .iter()
            .filter(|page| page.lesson.get("id").and_then(Value::as_str) == lesson_id)
            .map(|page| page.value)
            .collect();
        if !matching.is_empty() {
            for page in matching {
                page_index += 1;
                body.push_str(&render_page_html(
                    page,
                    size,
                    media_sources,
                    print_mode,
                    fit_to_target,
                )?);
            }
            if let Some(attachments) = lesson.get("attachments").and_then(Value::as_array) {
                if !attachments.is_empty() {
                    body.push_str("<section class=\"attachments\"><h2>附件</h2>");
                    for media in attachments {
                        body.push_str(&render_media_html(media, media_sources, print_mode));
                    }
                    body.push_str("</section>");
                }
            }
        } else if layout_pages.is_none()
            || layout_pages.is_some_and(|values| values.is_empty())
            || layout.get("mode").and_then(Value::as_str) == Some("flow")
        {
            body.push_str(&render_flow_lesson(lesson, media_sources, print_mode));
        }
    }
    if page_index == 0 && body.is_empty() {
        return Err("当前范围没有可导出的内容。".into());
    }
    Ok(format!(
        "<!doctype html><html lang=\"{}\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>{}</style></head><body><main>{}</main></body></html>\n",
        esc_html(projection.get("language").and_then(Value::as_str).unwrap_or("zh-CN")),
        title,
        page_css(size),
        body
    ))
}

pub(crate) fn render_pptx(
    projection: &Value,
    media_bytes: &HashMap<String, (String, Vec<u8>)>,
) -> Result<Vec<u8>, String> {
    let pages = collect_pages(projection);
    let size = page_size(projection, &pages)?;
    if pages.is_empty() {
        return Err("PPTX 导出范围没有可用页面。".into());
    }
    let mut zip = ZipWriter::default();
    let mut slide_parts = Vec::with_capacity(pages.len());
    let mut media_parts = Vec::new();
    let mut image_names = HashMap::<String, String>::new();
    for (slide_index, page) in pages.iter().enumerate() {
        let (slide, rels) =
            render_slide(page, size, media_bytes, &mut image_names, &mut media_parts)?;
        add_slide(&mut zip, &mut slide_parts, slide_index, &slide, &rels)?;
    }
    for (path, bytes, _) in &media_parts {
        zip.add(path, bytes)?;
    }
    zip.add(
        "[Content_Types].xml",
        content_types(&slide_parts, &media_parts).as_bytes(),
    )?;
    zip.add("_rels/.rels", ROOT_RELS.as_bytes())?;
    zip.add(
        "ppt/presentation.xml",
        presentation_xml(size, slide_parts.len()).as_bytes(),
    )?;
    zip.add(
        "ppt/_rels/presentation.xml.rels",
        presentation_rels(slide_parts.len()).as_bytes(),
    )?;
    zip.add("ppt/slideMasters/slideMaster1.xml", SLIDE_MASTER.as_bytes())?;
    zip.add(
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        SLIDE_MASTER_RELS.as_bytes(),
    )?;
    zip.add("ppt/slideLayouts/slideLayout1.xml", SLIDE_LAYOUT.as_bytes())?;
    zip.add(
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        SLIDE_LAYOUT_RELS.as_bytes(),
    )?;
    zip.add("ppt/theme/theme1.xml", THEME.as_bytes())?;
    zip.finish()
}

fn add_slide(
    zip: &mut ZipWriter,
    slide_parts: &mut Vec<String>,
    slide_index: usize,
    slide: &str,
    rels: &str,
) -> Result<(), String> {
    let slide_path = format!("ppt/slides/slide{}.xml", slide_index + 1);
    zip.add(&slide_path, slide.as_bytes())?;
    zip.add(
        &format!("ppt/slides/_rels/slide{}.xml.rels", slide_index + 1),
        rels.as_bytes(),
    )?;
    slide_parts.push(slide_path);
    Ok(())
}

fn collect_pages(projection: &Value) -> Vec<Page<'_>> {
    let Some(lessons) = projection.get("lessons").and_then(Value::as_array) else {
        return Vec::new();
    };
    let selection = projection.get("selection").unwrap_or(&Value::Null);
    let selected_layout = selection.get("layout_instance_id").and_then(Value::as_str);
    let requested: Option<HashSet<&str>> = selection
        .get("page_ids")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect());
    let mut result = Vec::new();
    for lesson in lessons {
        let Some(layout) = lesson.get("layout").filter(|value| !value.is_null()) else {
            continue;
        };
        if selected_layout
            .is_some_and(|id| layout.get("layout_instance_id").and_then(Value::as_str) != Some(id))
        {
            continue;
        }
        let Some(pages) = layout.get("pages").and_then(Value::as_array) else {
            continue;
        };
        for page in pages {
            let id = page.get("page_id").and_then(Value::as_str).unwrap_or("");
            if requested.as_ref().is_some_and(|ids| !ids.contains(id)) {
                continue;
            }
            result.push(Page {
                lesson,
                value: page,
            });
        }
    }
    result
}

fn page_size(projection: &Value, pages: &[Page<'_>]) -> Result<PageSize, String> {
    page_size_from_target(projection.get("target_page_size"), pages)
}

fn page_size_from_target(target: Option<&Value>, pages: &[Page<'_>]) -> Result<PageSize, String> {
    if let Some(target) = target.filter(|value| !value.is_null()) {
        let size = PageSize {
            width: number(target.get("width_pt"), "目标页面宽度")?,
            height: number(target.get("height_pt"), "目标页面高度")?,
        };
        validate_size(size)?;
        return Ok(size);
    }
    let chosen = if let Some(page) = pages.first() {
        PageSize {
            width: number(page.value.get("logical_width_pt"), "页面宽度")?,
            height: number(page.value.get("logical_height_pt"), "页面高度")?,
        }
    } else {
        PageSize {
            width: DEFAULT_PAGE_WIDTH_PT,
            height: DEFAULT_PAGE_HEIGHT_PT,
        }
    };
    validate_size(chosen)?;
    Ok(chosen)
}

fn validate_size(size: PageSize) -> Result<(), String> {
    if !size.width.is_finite()
        || !size.height.is_finite()
        || size.width <= 0.0
        || size.height <= 0.0
        || size.width > 4032.0
        || size.height > 4032.0
    {
        return Err("页面尺寸无效；请设置不超过 56 英寸的有效页面尺寸。".into());
    }
    Ok(())
}

fn validate_page(page: &Value) -> Result<(), String> {
    let width = number(page.get("logical_width_pt"), "页面宽度")?;
    let height = number(page.get("logical_height_pt"), "页面高度")?;
    validate_size(PageSize { width, height })?;
    let Some(items) = page.get("items").and_then(Value::as_array) else {
        return Err("页面投影缺少内容区块。".into());
    };
    for item in items {
        let rect = item.get("rect").ok_or("页面区块缺少位置")?;
        let rect = parse_rect(rect)?;
        let tolerance = 0.01;
        if rect.x < -tolerance
            || rect.y < -tolerance
            || rect.x + rect.width > width + tolerance
            || rect.y + rect.height > height + tolerance
        {
            return Err("页面区块超出画布范围；已阻止生成可能被裁切的文件。".into());
        }
    }
    Ok(())
}

fn parse_rect(value: &Value) -> Result<Rect, String> {
    Ok(Rect {
        x: number(value.get("x_pt"), "区块横坐标")?,
        y: number(value.get("y_pt"), "区块纵坐标")?,
        width: number(value.get("width_pt"), "区块宽度")?,
        height: number(value.get("height_pt"), "区块高度")?,
    })
}

fn number(value: Option<&Value>, label: &str) -> Result<f64, String> {
    let number = value
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{label}无效。"))?;
    if !number.is_finite()
        || number <= 0.0 && !label.ends_with("横坐标") && !label.ends_with("纵坐标")
    {
        return Err(format!("{label}无效。"));
    }
    Ok(number)
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    let candidate = std::path::Path::new(path);
    if path.trim().is_empty()
        || candidate.is_absolute()
        || candidate
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("投影素材必须使用项目内安全相对路径。".into());
    }
    Ok(())
}

fn render_page_html(
    page: &Value,
    target: PageSize,
    media_sources: &HashMap<String, String>,
    print_mode: bool,
    fit_to_target: bool,
) -> Result<String, String> {
    let source = PageSize {
        width: number(page.get("logical_width_pt"), "页面宽度")?,
        height: number(page.get("logical_height_pt"), "页面高度")?,
    };
    let destination = if fit_to_target { target } else { source };
    let (scale, offset_x, offset_y) = fit_page(source, destination);
    let title = esc_html(page.get("title").and_then(Value::as_str).unwrap_or(""));
    let mut result = format!(
        "<section class=\"page\" aria-label=\"{}\" data-page-id=\"{}\" style=\"width:{:.3}pt;height:{:.3}pt\">",
        title,
        esc_html(page.get("page_id").and_then(Value::as_str).unwrap_or("")),
        destination.width,
        destination.height
    );
    if let Some(items) = page.get("items").and_then(Value::as_array) {
        for item in items {
            let rect = parse_rect(item.get("rect").ok_or("页面区块缺少位置")?)?;
            let x = offset_x + rect.x * scale;
            let y = offset_y + rect.y * scale;
            let width = rect.width * scale;
            let height = rect.height * scale;
            let style = item.get("style").unwrap_or(&Value::Null);
            let z = style.get("z_index").and_then(Value::as_i64).unwrap_or(0);
            let padding = padding_css(style.get("padding"), scale);
            let align = horizontal_alignment(style);
            let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
            let default_font_size = if kind == "heading" { 24.0 } else { 18.0 };
            let font_size = style
                .get("font_size_pt")
                .and_then(Value::as_f64)
                .unwrap_or(default_font_size)
                .clamp(6.0, 144.0)
                * scale;
            let line_height = style
                .get("line_height")
                .and_then(Value::as_f64)
                .unwrap_or(1.2)
                .clamp(0.8, 3.0);
            let image_fit = match style.get("fit_mode").and_then(Value::as_str) {
                Some("cover") => "cover",
                Some("stretch") => "fill",
                _ => "contain",
            };
            let text = item.get("text").and_then(Value::as_str).unwrap_or("");
            let media = item.get("media");
            let content = if let Some(media) = media.filter(|value| !value.is_null()) {
                render_media_html(media, media_sources, print_mode)
            } else {
                render_semantic_html(item, media_sources)
                    .unwrap_or_else(|| render_text_html(item, text))
            };
            result.push_str(&format!(
                "<div class=\"placement\" data-block-id=\"{}\" style=\"left:{x:.3}pt;top:{y:.3}pt;width:{width:.3}pt;height:{height:.3}pt;z-index:{z};padding:{padding};text-align:{align};font-size:{font_size:.3}pt;line-height:{line_height};--image-fit:{image_fit}\">{content}</div>",
                esc_html(item.get("block_id").and_then(Value::as_str).unwrap_or(""))
            ));
        }
    }
    result.push_str("</section>");
    Ok(result)
}

fn horizontal_alignment(style: &Value) -> &'static str {
    let alignment = style.get("alignment");
    match alignment
        .and_then(|value| value.get("horizontal").or_else(|| value.get("text")))
        .and_then(Value::as_str)
        .or_else(|| alignment.and_then(Value::as_str))
    {
        Some("center") => "center",
        Some("right") => "right",
        Some("justify") => "justify",
        _ => "left",
    }
}

fn padding_css(value: Option<&Value>, scale: f64) -> String {
    let default = 4.0;
    let side = |key: &str| {
        value
            .and_then(|value| value.get(key))
            .and_then(Value::as_f64)
            .or_else(|| value.and_then(Value::as_f64))
            .unwrap_or(default)
            .clamp(0.0, 64.0)
            * scale
    };
    format!(
        "{:.3}pt {:.3}pt {:.3}pt {:.3}pt",
        side("top"),
        side("right"),
        side("bottom"),
        side("left")
    )
}

fn render_flow_lesson(
    lesson: &Value,
    media_sources: &HashMap<String, String>,
    print_mode: bool,
) -> String {
    let title = esc_html(lesson.get("title").and_then(Value::as_str).unwrap_or(""));
    let code = esc_html(lesson.get("code").and_then(Value::as_str).unwrap_or(""));
    let mut out = format!("<article class=\"flow-lesson\"><h2>{code} {title}</h2>");
    if let Some(blocks) = lesson.get("blocks").and_then(Value::as_array) {
        for block in blocks {
            if let Some(media) = block.get("media").filter(|value| !value.is_null()) {
                out.push_str(&render_media_html(media, media_sources, print_mode));
            } else {
                out.push_str(
                    &render_semantic_html(block, media_sources).unwrap_or_else(|| {
                        render_text_html(
                            block,
                            block.get("text").and_then(Value::as_str).unwrap_or(""),
                        )
                    }),
                );
            }
        }
    }
    if let Some(attachments) = lesson.get("attachments").and_then(Value::as_array) {
        for media in attachments {
            out.push_str(&render_media_html(media, media_sources, print_mode));
        }
    }
    out.push_str("</article>");
    out
}

fn render_text_html(item: &Value, text: &str) -> String {
    let escaped = esc_html(text).replace('\n', "<br>");
    match item
        .get("kind")
        .or_else(|| item.get("type"))
        .and_then(Value::as_str)
    {
        Some("heading") => format!("<strong>{escaped}</strong>"),
        Some("quote") => format!("<blockquote>{escaped}</blockquote>"),
        Some("code") => format!("<pre>{}</pre>", esc_html(text)),
        Some("divider") => "<hr>".into(),
        _ => format!("<p>{escaped}</p>"),
    }
}

fn render_semantic_html(item: &Value, media_sources: &HashMap<String, String>) -> Option<String> {
    let blocks = item.get("rich_text")?.as_array()?;
    if blocks.is_empty() {
        return None;
    }
    let inline_media = item.get("inline_media").and_then(Value::as_array);
    Some(semantic_blocks_html(blocks, inline_media, media_sources))
}

fn semantic_blocks_html(
    blocks: &[Value],
    inline_media: Option<&Vec<Value>>,
    media_sources: &HashMap<String, String>,
) -> String {
    blocks
        .iter()
        .map(|block| {
            let children = || {
                semantic_blocks_html(
                    block
                        .get("children")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                    inline_media,
                    media_sources,
                )
            };
            match block.get("type").and_then(Value::as_str).unwrap_or("") {
                "paragraph" => format!(
                    "<p>{}</p>",
                    semantic_inline_html(
                        block.get("children").and_then(Value::as_array),
                        inline_media,
                        media_sources
                    )
                ),
                "heading" => {
                    let level = block
                        .get("level")
                        .and_then(Value::as_u64)
                        .unwrap_or(2)
                        .clamp(1, 6);
                    format!(
                        "<h{level}>{}</h{level}>",
                        semantic_inline_html(
                            block.get("children").and_then(Value::as_array),
                            inline_media,
                            media_sources
                        )
                    )
                }
                "quote" => format!("<blockquote>{}</blockquote>", children()),
                "callout" => format!(
                    "<aside class=\"markdown-callout\">{}</aside>",
                    semantic_inline_html(
                        block.get("children").and_then(Value::as_array),
                        inline_media,
                        media_sources
                    )
                ),
                "list" => {
                    let ordered = block
                        .get("ordered")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let tag = if ordered { "ol" } else { "ul" };
                    let start = block
                        .get("start")
                        .and_then(Value::as_u64)
                        .unwrap_or(1)
                        .clamp(1, 999_999);
                    let start_attr = if ordered && start > 1 {
                        format!(" start=\"{start}\"")
                    } else {
                        String::new()
                    };
                    let items = block
                        .get("items")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .map(|item| {
                            let marker = match item.get("checked").and_then(Value::as_bool) {
                                Some(true) => "<span class=\"task-marker\">☑ </span>",
                                Some(false) => "<span class=\"task-marker\">☐ </span>",
                                None => "",
                            };
                            let item_blocks = item
                                .get("children")
                                .and_then(Value::as_array)
                                .map(Vec::as_slice)
                                .unwrap_or(&[]);
                            format!(
                                "<li>{marker}{}</li>",
                                semantic_blocks_html(item_blocks, inline_media, media_sources)
                            )
                        })
                        .collect::<String>();
                    format!("<{tag}{start_attr}>{items}</{tag}>")
                }
                "code" => format!(
                    "<pre><code>{}</code></pre>",
                    esc_html(block.get("text").and_then(Value::as_str).unwrap_or(""))
                ),
                "divider" => "<hr>".into(),
                "table" => {
                    let align = block.get("align").and_then(Value::as_array);
                    let render_row = |cells: &[Value], header: bool| {
                        let tag = if header { "th" } else { "td" };
                        let cells = cells
                            .iter()
                            .enumerate()
                            .map(|(index, cell)| {
                                let alignment = align
                                    .and_then(|items| items.get(index))
                                    .and_then(Value::as_str);
                                let style = match alignment {
                                    Some(alignment @ ("left" | "center" | "right")) => {
                                        format!(" style=\"text-align:{alignment}\"")
                                    }
                                    _ => String::new(),
                                };
                                let contents = semantic_inline_html(
                                    cell.as_array(),
                                    inline_media,
                                    media_sources,
                                );
                                format!("<{tag}{style}>{contents}</{tag}>")
                            })
                            .collect::<String>();
                        format!("<tr>{cells}</tr>")
                    };
                    let header = block
                        .get("header")
                        .and_then(Value::as_array)
                        .map(|cells| render_row(cells, true))
                        .unwrap_or_default();
                    let rows = block
                        .get("rows")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .map(|row| {
                            render_row(row.as_array().map(Vec::as_slice).unwrap_or(&[]), false)
                        })
                        .collect::<String>();
                    format!("<table><thead>{header}</thead><tbody>{rows}</tbody></table>")
                }
                _ => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn semantic_inline_html(
    nodes: Option<&Vec<Value>>,
    inline_media: Option<&Vec<Value>>,
    media_sources: &HashMap<String, String>,
) -> String {
    nodes
        .into_iter()
        .flatten()
        .map(|node| {
            let children = || {
                semantic_inline_html(
                    node.get("children").and_then(Value::as_array),
                    inline_media,
                    media_sources,
                )
            };
            match node.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => esc_html(node.get("text").and_then(Value::as_str).unwrap_or("")),
                "break" => "<br>".into(),
                "code" => format!(
                    "<code>{}</code>",
                    esc_html(node.get("text").and_then(Value::as_str).unwrap_or(""))
                ),
                "strong" => format!("<strong>{}</strong>", children()),
                "em" => format!("<em>{}</em>", children()),
                "del" => format!("<del>{}</del>", children()),
                "link" => {
                    let href = node.get("href").and_then(Value::as_str).unwrap_or("");
                    if (href.starts_with("https://")
                        || href.starts_with("http://")
                        || href.starts_with("mailto:"))
                        && !href.chars().any(char::is_control)
                        && !href.chars().any(char::is_whitespace)
                    {
                        format!(
                            "<a href=\"{}\" rel=\"noopener noreferrer\">{}</a>",
                            esc_html(href),
                            children()
                        )
                    } else {
                        children()
                    }
                }
                "image" => {
                    let id = node.get("asset_id").and_then(Value::as_str).unwrap_or("");
                    let alt = esc_html(node.get("alt").and_then(Value::as_str).unwrap_or(""));
                    let allowed = inline_media.into_iter().flatten().any(|media| {
                        media.get("id").and_then(Value::as_str) == Some(id)
                            && matches!(
                                media.get("type").and_then(Value::as_str),
                                Some("image" | "gif")
                            )
                    });
                    match (allowed, media_sources.get(id)) {
                        (true, Some(source)) => format!(
                            "<img class=\"publication-inline-image\" src=\"{}\" alt=\"{alt}\">",
                            esc_html(source)
                        ),
                        _ => alt,
                    }
                }
                _ => String::new(),
            }
        })
        .collect::<String>()
}

fn render_media_html(media: &Value, sources: &HashMap<String, String>, print_mode: bool) -> String {
    let id = media.get("id").and_then(Value::as_str).unwrap_or("");
    let kind = media.get("type").and_then(Value::as_str).unwrap_or("other");
    let title = esc_html(media.get("title").and_then(Value::as_str).unwrap_or("素材"));
    let source = sources.get(id).map(|value| esc_html(value));
    match (kind, source) {
        ("image" | "gif", Some(source)) => format!("<figure><img src=\"{source}\" alt=\"{title}\"><figcaption>{title}</figcaption></figure>"),
        ("video", Some(source)) if !print_mode => format!("<figure><video controls preload=\"metadata\" src=\"{source}\"></video><figcaption>{title}</figcaption></figure>"),
        ("audio", Some(source)) if !print_mode => format!("<figure><audio controls preload=\"metadata\" src=\"{source}\"></audio><figcaption>{title}</figcaption></figure>"),
        ("video", _) if print_mode => format!("<aside class=\"media-card\"><strong>视频附件：{title}</strong><p>PDF 不提供媒体播放。</p></aside>"),
        ("audio", _) if print_mode => format!("<aside class=\"media-card\"><strong>音频附件：{title}</strong><p>PDF 不提供媒体播放。</p></aside>"),
        (_, Some(source)) => format!("<aside class=\"media-card\"><strong>{title}</strong><a href=\"{source}\">打开素材</a></aside>"),
        (_, None) => format!("<aside class=\"media-card\"><strong>{title}</strong></aside>"),
    }
}

fn page_css(size: PageSize) -> String {
    format!(
        "@page{{size:{:.3}pt {:.3}pt;margin:0}}*{{box-sizing:border-box}}body{{margin:0;color:#20242b;background:#eef0f3;font:12pt/1.45 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif}}main{{display:flex;flex-direction:column;align-items:center;gap:16pt;padding:16pt}}.page{{position:relative;width:{:.3}pt;height:{:.3}pt;overflow:hidden;background:#fff;box-shadow:0 2pt 14pt #0002;break-after:page;page-break-after:always}}.page:last-child{{break-after:auto;page-break-after:auto}}.placement{{position:absolute;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}}.placement p,.placement blockquote,.placement pre{{margin:0}}.placement figure{{display:flex;flex-direction:column;width:100%;height:100%;margin:0}}.placement img:not(.publication-inline-image),.placement video{{display:block;width:100%;height:100%;min-height:0;object-fit:var(--image-fit,contain)}}.publication-inline-image{{display:inline-block;width:auto;height:auto;max-width:100%;max-height:60pt;object-fit:contain;vertical-align:middle}}.placement figcaption{{flex:0 0 auto;text-align:center;font-size:9pt}}.media-card{{border:1px solid #c9ced6;padding:8pt}}.flow-lesson{{width:min(820px,100%);min-height:{:.3}pt;margin:0 auto;background:#fff;padding:36pt 42pt;break-after:page;page-break-after:always}}.flow-lesson h2{{margin-top:0}}.flow-lesson table{{border-collapse:collapse}}.flow-lesson th,.flow-lesson td{{border:1px solid #c9ced6;padding:4pt}}.markdown-callout{{border-left:3pt solid #175cd3;padding:6pt 10pt;background:#f5f8ff}}.flow-lesson img,.flow-lesson video{{max-width:100%;height:auto}}.flow-lesson pre{{white-space:pre-wrap}}@media print{{body{{background:#fff}}main{{display:block;padding:0}}.page{{margin:0;box-shadow:none}}.flow-lesson{{width:auto;min-height:0;margin:0}}}}",
        size.width, size.height, size.width, size.height, size.height
    )
}

fn fit_page(source: PageSize, target: PageSize) -> (f64, f64, f64) {
    let scale = (target.width / source.width).min(target.height / source.height);
    let offset_x = (target.width - source.width * scale) / 2.0;
    let offset_y = (target.height - source.height * scale) / 2.0;
    (scale, offset_x, offset_y)
}

fn render_slide(
    page: &Page<'_>,
    target: PageSize,
    media_bytes: &HashMap<String, (String, Vec<u8>)>,
    image_names: &mut HashMap<String, String>,
    media_parts: &mut Vec<(String, Vec<u8>, String)>,
) -> Result<(String, String), String> {
    let source = PageSize {
        width: number(page.value.get("logical_width_pt"), "页面宽度")?,
        height: number(page.value.get("logical_height_pt"), "页面高度")?,
    };
    let (scale, offset_x, offset_y) = fit_page(source, target);
    let slide_number = media_parts.len() + 1;
    let mut shapes = String::new();
    let mut relationships = vec![(
        "rId1".to_owned(),
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
            .to_owned(),
        "../slideLayouts/slideLayout1.xml".to_owned(),
    )];
    let mut next_rel = 2;
    let mut next_shape = 2;
    if let Some(items) = page.value.get("items").and_then(Value::as_array) {
        for item in items {
            let rect = parse_rect(item.get("rect").ok_or("页面区块缺少位置")?)?;
            let fitted = Rect {
                x: offset_x + rect.x * scale,
                y: offset_y + rect.y * scale,
                width: rect.width * scale,
                height: rect.height * scale,
            };
            let text = item.get("text").and_then(Value::as_str).unwrap_or("");
            if let Some(media) = item.get("media").filter(|value| !value.is_null()) {
                let id = media
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or("页面素材缺少 ID")?;
                let kind = media.get("type").and_then(Value::as_str).unwrap_or("other");
                if kind == "image" {
                    let (mime, bytes) = media_bytes.get(id).ok_or("页面图片素材不存在")?;
                    let extension = image_extension(mime, bytes)?;
                    let name = if let Some(name) = image_names.get(id) {
                        name.clone()
                    } else {
                        let name = format!("image-{}.{}", image_names.len() + 1, extension);
                        let path = format!("ppt/media/{name}");
                        image_names.insert(id.to_owned(), name.clone());
                        media_parts.push((path, bytes.clone(), mime.to_owned()));
                        name
                    };
                    let rel_id = format!("rId{next_rel}");
                    next_rel += 1;
                    let target = format!("../media/{name}");
                    relationships.push((
                        rel_id.clone(),
                        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
                            .into(),
                        target,
                    ));
                    let fit_mode = item
                        .get("style")
                        .and_then(|v| v.get("fit_mode"))
                        .and_then(Value::as_str);
                    let (image_rect, crop) = image_rect_and_crop(fitted, bytes, fit_mode);
                    shapes.push_str(&picture_shape(
                        next_shape,
                        &rel_id,
                        image_rect,
                        crop,
                        media.get("title").and_then(Value::as_str).unwrap_or("图片"),
                    )?);
                    next_shape += 1;
                    if !text.trim().is_empty() {
                        let caption = Rect {
                            x: fitted.x,
                            y: fitted.y + fitted.height * 0.82,
                            width: fitted.width,
                            height: fitted.height * 0.18,
                        };
                        shapes.push_str(&text_shape(next_shape, text, caption, item, true));
                        next_shape += 1;
                    }
                } else {
                    let label = match kind {
                        "gif" => "GIF（静态预览）",
                        "video" => "视频附件",
                        "audio" => "音频附件",
                        _ => "附件",
                    };
                    let title = media.get("title").and_then(Value::as_str).unwrap_or("素材");
                    let description = if kind == "gif" {
                        format!("{label}：{title}\n此版本仅保留素材说明。")
                    } else {
                        format!("{label}：{title}\n此演示文稿不提供媒体播放。")
                    };
                    shapes.push_str(&text_shape(next_shape, &description, fitted, item, false));
                    next_shape += 1;
                }
            } else if !text.is_empty() {
                let inline_images = semantic_image_refs(item);
                if inline_images.is_empty() {
                    shapes.push_str(&text_shape(next_shape, text, fitted, item, false));
                    next_shape += 1;
                } else {
                    let image_band = (fitted.height * 0.32).min(96.0).min(fitted.height * 0.6);
                    let text_rect = Rect {
                        height: (fitted.height - image_band).max(1.0),
                        ..fitted
                    };
                    shapes.push_str(&text_shape(next_shape, text, text_rect, item, false));
                    next_shape += 1;
                    let columns = (inline_images.len() as f64).sqrt().ceil().max(1.0) as usize;
                    let rows = inline_images.len().div_ceil(columns);
                    for (index, (id, alt)) in inline_images.iter().enumerate() {
                        let (mime, bytes) = media_bytes.get(id).ok_or("Markdown图片素材不存在")?;
                        let extension = image_extension(mime, bytes)?;
                        let name = if let Some(name) = image_names.get(id) {
                            name.clone()
                        } else {
                            let name = format!("image-{}.{}", image_names.len() + 1, extension);
                            media_parts.push((
                                format!("ppt/media/{name}"),
                                bytes.clone(),
                                mime.to_owned(),
                            ));
                            image_names.insert(id.clone(), name.clone());
                            name
                        };
                        let rel_id = format!("rId{next_rel}");
                        next_rel += 1;
                        relationships.push((
                            rel_id.clone(),
                            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image".into(),
                            format!("../media/{name}"),
                        ));
                        let column = index % columns;
                        let row = index / columns;
                        let tile = Rect {
                            x: fitted.x + fitted.width * column as f64 / columns as f64,
                            y: fitted.y + text_rect.height + image_band * row as f64 / rows as f64,
                            width: fitted.width / columns as f64,
                            height: image_band / rows as f64,
                        };
                        let (image_rect, crop) = image_rect_and_crop(tile, bytes, Some("contain"));
                        shapes
                            .push_str(&picture_shape(next_shape, &rel_id, image_rect, crop, alt)?);
                        next_shape += 1;
                    }
                }
            }
        }
    }
    let title = esc_xml(
        page.value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let slide = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:cSld name=\"{title}\"><p:spTree>{GROUP_SHAPE}{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
    );
    let rels = relationship_xml(&relationships);
    let _ = slide_number;
    Ok((slide, rels))
}

fn semantic_image_refs(item: &Value) -> Vec<(String, String)> {
    fn visit(
        nodes: &[Value],
        allowed: &HashMap<String, String>,
        result: &mut Vec<(String, String)>,
    ) {
        for node in nodes {
            if node.get("type").and_then(Value::as_str) == Some("image") {
                let id = node.get("asset_id").and_then(Value::as_str).unwrap_or("");
                if !id.is_empty() && allowed.contains_key(id) {
                    result.push((
                        id.to_owned(),
                        node.get("alt")
                            .and_then(Value::as_str)
                            .unwrap_or("图片")
                            .to_owned(),
                    ));
                }
            }
            if let Some(children) = node.get("children").and_then(Value::as_array) {
                visit(children, allowed, result);
            }
            if let Some(items) = node.get("items").and_then(Value::as_array) {
                for item in items {
                    if let Some(children) = item.get("children").and_then(Value::as_array) {
                        visit(children, allowed, result);
                    }
                }
            }
            if let Some(rows) = node.get("rows").and_then(Value::as_array) {
                for row in rows {
                    for cell in row.as_array().into_iter().flatten() {
                        visit(
                            cell.as_array()
                                .map(Vec::as_slice)
                                .unwrap_or(std::slice::from_ref(cell)),
                            allowed,
                            result,
                        );
                    }
                }
            }
            if let Some(header) = node.get("header").and_then(Value::as_array) {
                for cell in header {
                    visit(
                        cell.as_array()
                            .map(Vec::as_slice)
                            .unwrap_or(std::slice::from_ref(cell)),
                        allowed,
                        result,
                    );
                }
            }
        }
    }
    let allowed = item
        .get("inline_media")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|media| media.get("type").and_then(Value::as_str) == Some("image"))
        .filter_map(|media| {
            media
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_owned(), id.to_owned()))
        })
        .collect::<HashMap<_, _>>();
    let mut result = Vec::new();
    if let Some(blocks) = item.get("rich_text").and_then(Value::as_array) {
        visit(blocks, &allowed, &mut result);
    }
    result
}

fn text_shape(id: u32, text: &str, rect: Rect, item: &Value, caption: bool) -> String {
    let heading_level = item
        .get("heading_level")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
    let style = item.get("style").unwrap_or(&Value::Null);
    let default_font_size = if heading_level > 0 || kind == "heading" {
        24.0
    } else {
        18.0
    };
    let font_size = if caption {
        800
    } else {
        (style
            .get("font_size_pt")
            .and_then(Value::as_f64)
            .unwrap_or(default_font_size)
            .clamp(6.0, 144.0)
            * 100.0)
            .round() as u32
    };
    let line_height = (style
        .get("line_height")
        .and_then(Value::as_f64)
        .unwrap_or(1.2)
        .clamp(0.8, 3.0)
        * 100_000.0)
        .round() as u32;
    let bold = if heading_level > 0 || kind == "heading" {
        " b=\"1\""
    } else {
        ""
    };
    let italic = if kind == "quote" { " i=\"1\"" } else { "" };
    let font_face = if kind == "code" { "Menlo" } else { "Aptos" };
    let align = match horizontal_alignment(style) {
        "center" => "ctr",
        "right" => "r",
        "justify" => "just",
        _ => "l",
    };
    let anchor = match style
        .get("alignment")
        .and_then(|value| value.get("vertical"))
        .and_then(Value::as_str)
    {
        Some("center") | Some("middle") => "ctr",
        Some("bottom") => "b",
        _ => "t",
    };
    let padding = style.get("padding");
    let inset = |key: &str| {
        let points = padding
            .and_then(|value| value.get(key))
            .and_then(Value::as_f64)
            .or_else(|| padding.and_then(Value::as_f64))
            .unwrap_or(4.0)
            .clamp(0.0, 64.0);
        (points * 12_700.0).round() as u64
    };
    let label = esc_xml(if caption { "图片说明" } else { kind });
    let paragraphs = item
        .get("rich_text")
        .and_then(Value::as_array)
        .filter(|nodes| !nodes.is_empty())
        .map(|nodes| semantic_pptx_paragraphs(nodes, font_size, line_height, align, bold, italic))
        .unwrap_or_else(|| text.split('\n').map(|line| format!("<a:p><a:pPr algn=\"{align}\"><a:lnSpc><a:spcPct val=\"{line_height}\"/></a:lnSpc></a:pPr><a:r><a:rPr lang=\"zh-CN\" sz=\"{font_size}\"{bold}{italic}><a:latin typeface=\"{font_face}\"/><a:ea typeface=\"Microsoft YaHei\"/></a:rPr><a:t xml:space=\"preserve\">{}</a:t></a:r><a:endParaRPr lang=\"zh-CN\"/></a:p>", esc_xml(line))).collect::<String>());
    let x = to_emu(rect.x);
    let y = to_emu(rect.y);
    let width = to_emu(rect.width.max(1.0));
    let height = to_emu(rect.height.max(1.0));
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{} {id}\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{width}\" cy=\"{height}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap=\"square\" anchor=\"{anchor}\" lIns=\"{}\" rIns=\"{}\" tIns=\"{}\" bIns=\"{}\"><a:noAutofit/></a:bodyPr><a:lstStyle/>{paragraphs}</p:txBody></p:sp>",
        label,
        inset("left"),
        inset("right"),
        inset("top"),
        inset("bottom")
    )
}

fn semantic_pptx_paragraphs(
    blocks: &[Value],
    font_size: u32,
    line_height: u32,
    align: &str,
    base_bold: &str,
    base_italic: &str,
) -> String {
    fn run(text: &str, size: u32, bold: bool, italic: bool, strike: bool, code: bool) -> String {
        let bold = if bold { " b=\"1\"" } else { "" };
        let italic = if italic { " i=\"1\"" } else { "" };
        let strike = if strike { " strike=\"sngStrike\"" } else { "" };
        let face = if code { "Menlo" } else { "Aptos" };
        format!("<a:r><a:rPr lang=\"zh-CN\" sz=\"{size}\"{bold}{italic}{strike}><a:latin typeface=\"{face}\"/><a:ea typeface=\"Microsoft YaHei\"/></a:rPr><a:t xml:space=\"preserve\">{}</a:t></a:r>", esc_xml(text))
    }
    fn inline(
        nodes: &[Value],
        size: u32,
        bold: bool,
        italic: bool,
        strike: bool,
        code: bool,
        out: &mut Vec<String>,
    ) {
        for node in nodes {
            match node.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => out.push(run(
                    node.get("text").and_then(Value::as_str).unwrap_or(""),
                    size,
                    bold,
                    italic,
                    strike,
                    code,
                )),
                "code" => out.push(run(
                    node.get("text").and_then(Value::as_str).unwrap_or(""),
                    size,
                    bold,
                    italic,
                    strike,
                    true,
                )),
                "break" => out.push("<a:br/>".into()),
                "strong" | "em" | "del" | "link" => {
                    let kind = node.get("type").and_then(Value::as_str).unwrap_or("");
                    inline(
                        node.get("children")
                            .and_then(Value::as_array)
                            .map(Vec::as_slice)
                            .unwrap_or(&[]),
                        size,
                        bold || kind == "strong",
                        italic || kind == "em",
                        strike || kind == "del",
                        code,
                        out,
                    );
                }
                "image" => {
                    let alt = node.get("alt").and_then(Value::as_str).unwrap_or("图片");
                    out.push(run(&format!("[{alt}]"), size, bold, italic, strike, code));
                }
                _ => {}
            }
        }
    }
    fn paragraphs(
        blocks: &[Value],
        depth: usize,
        size: u32,
        base_bold: bool,
        base_italic: bool,
        out: &mut Vec<Vec<String>>,
    ) {
        for block in blocks {
            let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
            match kind {
                "paragraph" | "heading" | "callout" | "quote" => {
                    let mut runs = Vec::new();
                    inline(
                        block
                            .get("children")
                            .and_then(Value::as_array)
                            .map(Vec::as_slice)
                            .unwrap_or(&[]),
                        size,
                        base_bold || kind == "heading",
                        base_italic || kind == "quote",
                        false,
                        false,
                        &mut runs,
                    );
                    if !runs.is_empty() {
                        out.push(runs);
                    }
                    if kind == "quote" {
                        paragraphs(
                            block
                                .get("children")
                                .and_then(Value::as_array)
                                .map(Vec::as_slice)
                                .unwrap_or(&[]),
                            depth,
                            size,
                            base_bold,
                            true,
                            out,
                        );
                    }
                }
                "list" => {
                    let ordered = block
                        .get("ordered")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let start = block.get("start").and_then(Value::as_u64).unwrap_or(1);
                    for (index, item) in block
                        .get("items")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .enumerate()
                    {
                        let marker = match item.get("checked").and_then(Value::as_bool) {
                            Some(true) => "☑ ".to_owned(),
                            Some(false) => "☐ ".to_owned(),
                            None if ordered => {
                                format!("{}{}. ", "  ".repeat(depth), start + index as u64)
                            }
                            None => format!("{}• ", "  ".repeat(depth)),
                        };
                        let mut runs =
                            vec![run(&marker, size, base_bold, base_italic, false, false)];
                        let children = item
                            .get("children")
                            .and_then(Value::as_array)
                            .map(Vec::as_slice)
                            .unwrap_or(&[]);
                        for child in children {
                            if child.get("type").and_then(Value::as_str) == Some("list") {
                                if !runs.is_empty() {
                                    out.push(runs);
                                    runs = Vec::new();
                                }
                                paragraphs(
                                    std::slice::from_ref(child),
                                    depth + 1,
                                    size,
                                    base_bold,
                                    base_italic,
                                    out,
                                );
                            } else {
                                inline(
                                    child
                                        .get("children")
                                        .and_then(Value::as_array)
                                        .map(Vec::as_slice)
                                        .unwrap_or(&[]),
                                    size,
                                    base_bold,
                                    base_italic,
                                    false,
                                    false,
                                    &mut runs,
                                );
                            }
                        }
                        if !runs.is_empty() {
                            out.push(runs);
                        }
                    }
                }
                "code" => {
                    let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                    out.push(vec![run(text, size, base_bold, base_italic, false, true)]);
                }
                "divider" => out.push(vec![run(
                    "────────",
                    size,
                    base_bold,
                    base_italic,
                    false,
                    false,
                )]),
                "table" => {
                    let render_row = |cells: &[Value]| {
                        let mut runs = Vec::new();
                        for (index, cell) in cells.iter().enumerate() {
                            if index > 0 {
                                runs.push(run(" | ", size, false, false, false, false));
                            }
                            inline(
                                cell.as_array().map(Vec::as_slice).unwrap_or(&[]),
                                size,
                                base_bold,
                                base_italic,
                                false,
                                false,
                                &mut runs,
                            );
                        }
                        runs
                    };
                    if let Some(header) = block.get("header").and_then(Value::as_array) {
                        out.push(render_row(header));
                    }
                    for row in block
                        .get("rows")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        out.push(render_row(row.as_array().map(Vec::as_slice).unwrap_or(&[])));
                    }
                }
                _ => {}
            }
        }
    }
    let mut paragraphs_out = Vec::new();
    paragraphs(
        blocks,
        0,
        font_size,
        base_bold.contains("b=\"1\""),
        base_italic.contains("i=\"1\""),
        &mut paragraphs_out,
    );
    if paragraphs_out.is_empty() {
        paragraphs_out.push(vec![run("", font_size, false, false, false, false)]);
    }
    paragraphs_out.into_iter().map(|runs| {
        format!("<a:p><a:pPr algn=\"{align}\"><a:lnSpc><a:spcPct val=\"{line_height}\"/></a:lnSpc></a:pPr>{}<a:endParaRPr lang=\"zh-CN\"/></a:p>", runs.join(""))
    }).collect()
}

fn picture_shape(
    id: u32,
    rel_id: &str,
    rect: Rect,
    crop: Option<(u32, u32, u32, u32)>,
    name: &str,
) -> Result<String, String> {
    let x = to_emu(rect.x);
    let y = to_emu(rect.y);
    let width = to_emu(rect.width.max(1.0));
    let height = to_emu(rect.height.max(1.0));
    let crop = crop.map_or_else(String::new, |(left, top, right, bottom)| {
        format!("<a:srcRect l=\"{left}\" t=\"{top}\" r=\"{right}\" b=\"{bottom}\"/>")
    });
    Ok(format!(
        "<p:pic><p:nvPicPr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed=\"{rel_id}\"/>{crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{width}\" cy=\"{height}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>",
        esc_xml(name)
    ))
}

fn image_rect_and_crop(
    rect: Rect,
    bytes: &[u8],
    fit_mode: Option<&str>,
) -> (Rect, Option<(u32, u32, u32, u32)>) {
    let Some((image_width, image_height)) = image_dimensions(bytes) else {
        return (rect, None);
    };
    let image_ratio = image_width as f64 / image_height as f64;
    let box_ratio = rect.width / rect.height;
    if fit_mode == Some("stretch") {
        return (rect, None);
    }
    if fit_mode == Some("cover") {
        let crop = if image_ratio > box_ratio {
            let visible_width = box_ratio / image_ratio;
            let side = ((1.0 - visible_width) / 2.0 * 100_000.0).round() as u32;
            (side, 0, side, 0)
        } else if image_ratio < box_ratio {
            let visible_height = image_ratio / box_ratio;
            let side = ((1.0 - visible_height) / 2.0 * 100_000.0).round() as u32;
            (0, side, 0, side)
        } else {
            (0, 0, 0, 0)
        };
        return (rect, Some(crop));
    }
    if image_ratio > box_ratio {
        let height = rect.width / image_ratio;
        (
            Rect {
                x: rect.x,
                y: rect.y + (rect.height - height) / 2.0,
                width: rect.width,
                height,
            },
            None,
        )
    } else {
        let width = rect.height * image_ratio;
        (
            Rect {
                x: rect.x + (rect.width - width) / 2.0,
                y: rect.y,
                width,
                height: rect.height,
            },
            None,
        )
    }
}

fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 {
        return Some((
            u32::from_be_bytes(bytes[16..20].try_into().ok()?),
            u32::from_be_bytes(bytes[20..24].try_into().ok()?),
        ));
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut index = 2;
        while index + 4 <= bytes.len() {
            if bytes[index] != 0xff {
                index += 1;
                continue;
            }
            let marker = bytes[index + 1];
            index += 2;
            if matches!(marker, 0xd8 | 0xd9 | 0x01 | 0xd0..=0xd7) {
                continue;
            }
            if index + 2 > bytes.len() {
                return None;
            }
            let segment_len = u16::from_be_bytes([bytes[index], bytes[index + 1]]) as usize;
            if segment_len < 2 || index + segment_len > bytes.len() {
                return None;
            }
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
                if segment_len < 7 {
                    return None;
                }
                let height = u16::from_be_bytes([bytes[index + 3], bytes[index + 4]]) as u32;
                let width = u16::from_be_bytes([bytes[index + 5], bytes[index + 6]]) as u32;
                return Some((width, height));
            }
            index += segment_len;
        }
    }
    None
}

fn image_extension(mime: &str, bytes: &[u8]) -> Result<&'static str, String> {
    if mime == "image/png" && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("png")
    } else if mime == "image/jpeg" && bytes.starts_with(&[0xff, 0xd8]) {
        Ok("jpg")
    } else {
        Err("PPTX 目前只支持 PNG/JPEG 图片对象；请先转换其他图片格式。".into())
    }
}

fn content_types(slides: &[String], media: &[(String, Vec<u8>, String)]) -> String {
    let mut defaults = String::from(
        "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>",
    );
    let has_png = media.iter().any(|(_, _, mime)| mime == "image/png");
    let has_jpg = media.iter().any(|(_, _, mime)| mime == "image/jpeg");
    if has_png {
        defaults.push_str("<Default Extension=\"png\" ContentType=\"image/png\"/>");
    }
    if has_jpg {
        defaults.push_str("<Default Extension=\"jpg\" ContentType=\"image/jpeg\"/><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/>");
    }
    let slides = slides
        .iter()
        .map(|path| format!("<Override PartName=\"/{path}\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"))
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">{defaults}<Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/><Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/><Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/><Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>{slides}</Types>"
    )
}

fn presentation_xml(size: PageSize, slide_count: usize) -> String {
    let slide_ids = (0..slide_count)
        .map(|index| {
            format!(
                "<p:sldId id=\"{}\" r:id=\"rId{}\"/>",
                256 + index,
                index + 2
            )
        })
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:presentation xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst>{slide_ids}</p:sldIdLst><p:sldSz cx=\"{}\" cy=\"{}\" type=\"custom\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>",
        to_emu(size.width), to_emu(size.height)
    )
}

fn presentation_rels(slide_count: usize) -> String {
    let mut relationships = String::from(
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>",
    );
    for index in 0..slide_count {
        relationships.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{}.xml\"/>",
            index + 2,
            index + 1
        ));
    }
    relationship_xml_body(&relationships)
}

fn relationship_xml(relationships: &[(String, String, String)]) -> String {
    let entries = relationships
        .iter()
        .map(|(id, kind, target)| {
            format!(
                "<Relationship Id=\"{}\" Type=\"{}\" Target=\"{}\"/>",
                esc_xml(id),
                esc_xml(kind),
                esc_xml(target)
            )
        })
        .collect::<String>();
    relationship_xml_body(&entries)
}

fn relationship_xml_body(entries: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{entries}</Relationships>"
    )
}

fn to_emu(points: f64) -> u64 {
    (points * EMU_PER_POINT).round().max(0.0) as u64
}

fn esc_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn esc_xml(value: &str) -> String {
    let valid = value
        .chars()
        .filter(|character| match *character as u32 {
            0x9 | 0xA | 0xD => true,
            0x20..=0xD7FF | 0xE000..=0xFFFD | 0x10000..=0x10FFFF => true,
            _ => false,
        })
        .collect::<String>();
    esc_html(&valid)
}

struct ZipEntry {
    name: String,
    bytes: Vec<u8>,
    crc32: u32,
    offset: u32,
}

#[derive(Default)]
struct ZipWriter {
    entries: Vec<ZipEntry>,
    bytes: Vec<u8>,
}

impl ZipWriter {
    fn add(&mut self, name: &str, contents: &[u8]) -> Result<(), String> {
        let name_bytes = name.as_bytes();
        let size = u32::try_from(contents.len()).map_err(|_| "PPTX 文件过大")?;
        if name_bytes.len() > u16::MAX as usize {
            return Err("PPTX 内部文件名过长".into());
        }
        let offset = u32::try_from(self.bytes.len()).map_err(|_| "PPTX 文件过大")?;
        let crc32 = crc32(contents);
        push_u32(&mut self.bytes, 0x0403_4b50);
        push_u16(&mut self.bytes, 20);
        push_u16(&mut self.bytes, 0x0800);
        push_u16(&mut self.bytes, 0);
        push_u16(&mut self.bytes, 0);
        push_u16(&mut self.bytes, 0x0021);
        push_u32(&mut self.bytes, crc32);
        push_u32(&mut self.bytes, size);
        push_u32(&mut self.bytes, size);
        push_u16(&mut self.bytes, name_bytes.len() as u16);
        push_u16(&mut self.bytes, 0);
        self.bytes.extend_from_slice(name_bytes);
        self.bytes.extend_from_slice(contents);
        self.entries.push(ZipEntry {
            name: name.to_owned(),
            bytes: contents.to_vec(),
            crc32,
            offset,
        });
        Ok(())
    }

    fn finish(mut self) -> Result<Vec<u8>, String> {
        let directory_offset = u32::try_from(self.bytes.len()).map_err(|_| "PPTX 文件过大")?;
        for entry in &self.entries {
            let name = entry.name.as_bytes();
            let size = u32::try_from(entry.bytes.len()).map_err(|_| "PPTX 文件过大")?;
            push_u32(&mut self.bytes, 0x0201_4b50);
            push_u16(&mut self.bytes, 20);
            push_u16(&mut self.bytes, 20);
            push_u16(&mut self.bytes, 0x0800);
            push_u16(&mut self.bytes, 0);
            push_u16(&mut self.bytes, 0);
            push_u16(&mut self.bytes, 0x0021);
            push_u32(&mut self.bytes, entry.crc32);
            push_u32(&mut self.bytes, size);
            push_u32(&mut self.bytes, size);
            push_u16(&mut self.bytes, name.len() as u16);
            push_u16(&mut self.bytes, 0);
            push_u16(&mut self.bytes, 0);
            push_u16(&mut self.bytes, 0);
            push_u16(&mut self.bytes, 0);
            push_u32(&mut self.bytes, 0);
            push_u32(&mut self.bytes, entry.offset);
            self.bytes.extend_from_slice(name);
        }
        let directory_size = u32::try_from(self.bytes.len())
            .map_err(|_| "PPTX 文件过大")?
            .checked_sub(directory_offset)
            .ok_or("PPTX ZIP 目录无效")?;
        let entry_count = u16::try_from(self.entries.len()).map_err(|_| "PPTX 页面过多")?;
        push_u32(&mut self.bytes, 0x0605_4b50);
        push_u16(&mut self.bytes, 0);
        push_u16(&mut self.bytes, 0);
        push_u16(&mut self.bytes, entry_count);
        push_u16(&mut self.bytes, entry_count);
        push_u32(&mut self.bytes, directory_size);
        push_u32(&mut self.bytes, directory_offset);
        push_u16(&mut self.bytes, 0);
        Ok(self.bytes)
    }
}

fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for byte in bytes {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & (0_u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

#[cfg(test)]
fn zip_stored_entry<'a>(bytes: &'a [u8], wanted: &str) -> Option<&'a [u8]> {
    let mut cursor = 0;
    while cursor + 30 <= bytes.len() {
        if read_u32(bytes, cursor)? != 0x0403_4b50 {
            return None;
        }
        let name_len = read_u16(bytes, cursor + 26)? as usize;
        let extra_len = read_u16(bytes, cursor + 28)? as usize;
        let size = read_u32(bytes, cursor + 18)? as usize;
        let name_start = cursor + 30;
        let data_start = name_start.checked_add(name_len)?.checked_add(extra_len)?;
        let data_end = data_start.checked_add(size)?;
        if data_end > bytes.len() {
            return None;
        }
        let name = std::str::from_utf8(bytes.get(name_start..name_start + name_len)?).ok()?;
        if name == wanted {
            return bytes.get(data_start..data_end);
        }
        cursor = data_end;
    }
    None
}

#[cfg(test)]
fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

#[cfg(test)]
fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

const GROUP_SHAPE: &str = "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>";

const ROOT_RELS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"ppt/presentation.xml\"/></Relationships>";

const SLIDE_MASTER: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:sldMaster xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/><p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>";

const SLIDE_MASTER_RELS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"../theme/theme1.xml\"/></Relationships>";

const SLIDE_LAYOUT: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:sldLayout xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" type=\"blank\" preserve=\"1\"><p:cSld name=\"Blank\"><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";

const SLIDE_LAYOUT_RELS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/></Relationships>";

const THEME: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"AI Course Workbench\"><a:themeElements><a:clrScheme name=\"Workbench\"><a:dk1><a:srgbClr val=\"20242B\"/></a:dk1><a:lt1><a:srgbClr val=\"FFFFFF\"/></a:lt1><a:dk2><a:srgbClr val=\"44546A\"/></a:dk2><a:lt2><a:srgbClr val=\"E7E6E6\"/></a:lt2><a:accent1><a:srgbClr val=\"175CD3\"/></a:accent1><a:accent2><a:srgbClr val=\"00A3A3\"/></a:accent2><a:accent3><a:srgbClr val=\"ED7D31\"/></a:accent3><a:accent4><a:srgbClr val=\"70AD47\"/></a:accent4><a:accent5><a:srgbClr val=\"A5A5A5\"/></a:accent5><a:accent6><a:srgbClr val=\"FFC000\"/></a:accent6><a:hlink><a:srgbClr val=\"0563C1\"/></a:hlink><a:folHlink><a:srgbClr val=\"954F72\"/></a:folHlink></a:clrScheme><a:fontScheme name=\"Workbench\"><a:majorFont><a:latin typeface=\"Aptos Display\"/><a:ea typeface=\"Microsoft YaHei\"/><a:cs typeface=\"Aptos Display\"/></a:majorFont><a:minorFont><a:latin typeface=\"Aptos\"/><a:ea typeface=\"Microsoft YaHei\"/><a:cs typeface=\"Aptos\"/></a:minorFont></a:fontScheme><a:fmtScheme name=\"Workbench\"><a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w=\"6350\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/><a:round/></a:ln><a:ln w=\"25400\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/><a:round/></a:ln><a:ln w=\"38100\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/><a:round/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>";

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use serde_json::json;

    fn sample_projection() -> Value {
        serde_json::from_str(
            r#"{
              "schema_version":"2","project_id":"p1","title":"课程","language":"zh-CN",
              "scope":"lesson","content_item_id":"lesson-1","generated_from_updated_at":"2026-01-01T00:00:00Z",
              "selection":{"content_item_id":"lesson-1","layout_instance_id":"layout-1","page_ids":null},
              "target_page_size":{"width_pt":960.0,"height_pt":540.0},
              "media":[{"id":"asset-1","type":"image","title":"照片","filename":"photo.png","output_path":"assets/photo.png","mime_type":"image/png","inline":true}],
              "lessons":[{"id":"lesson-1","code":"01","title":"第一页","blocks":[],"attachments":[],"layout":{
                "layout_instance_id":"layout-1","mode":"grid","pagination_mode":"paged","pages":[{"page_id":"page-1","title":"第一页","order":0,
                  "logical_width_pt":960.0,"logical_height_pt":540.0,"items":[
                    {"placement_id":"place-1","block_id":"block-1","kind":"heading","text":"可编辑中文","heading_level":1,
                      "rect":{"x_pt":20.0,"y_pt":20.0,"width_pt":400.0,"height_pt":100.0},"style":{"alignment":{"horizontal":"center","vertical":"middle"},"fit_mode":"natural","padding":{"top":2.0,"right":6.0,"bottom":3.0,"left":5.0},"z_index":0,"font_size_pt":24.0,"line_height":1.5},"media":null},
                    {"placement_id":"place-2","block_id":"block-2","kind":"image","text":"","rect":{"x_pt":450.0,"y_pt":20.0,"width_pt":300.0,"height_pt":250.0},
                      "style":{"alignment":{"horizontal":"left"},"fit_mode":"cover","padding":{"top":4.0,"right":4.0,"bottom":4.0,"left":4.0},"z_index":1,"font_size_pt":18.0,"line_height":1.2},"media":{"id":"asset-1","type":"image","title":"照片","filename":"photo.png","output_path":"assets/photo.png","mime_type":"image/png","inline":true}}
                  ]}]
              }}]
            }"#,
        )
        .expect("sample projection should be valid JSON")
    }

    fn sample_png() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvtcAAAAASUVORK5CYII=")
            .expect("fixture PNG should decode")
    }

    #[test]
    fn paged_html_keeps_text_live_and_positions_real_media() {
        let projection = sample_projection();
        let html = render_html(
            &projection,
            &HashMap::from([("asset-1".into(), "assets/photo.png".into())]),
            false,
        )
        .expect("paged HTML should render");
        assert!(html.contains("@page{size:960.000pt 540.000pt;margin:0}"));
        assert!(html.contains("可编辑中文"));
        assert!(html.contains("<img src=\"assets/photo.png\""));
        assert!(html.contains("left:20.000pt;top:20.000pt"));
        assert!(html.contains("text-align:center;font-size:24.000pt;line-height:1.5"));
        assert!(html.contains("padding:2.000pt 6.000pt 3.000pt 5.000pt"));
    }

    #[test]
    fn semantic_export_keeps_editable_runs_and_inline_asset_images() {
        let mut projection = sample_projection();
        let inline_media = projection["media"][0].clone();
        let item = &mut projection["lessons"][0]["layout"]["pages"][0]["items"][0];
        item["rich_text"] = json!([{
            "type":"paragraph","children":[
                {"type":"text","text":"可编辑 "},
                {"type":"strong","children":[{"type":"text","text":"粗体"}]},
                {"type":"del","children":[{"type":"text","text":"删除线"}]},
                {"type":"text","text":" "},
                {"type":"image","asset_id":"asset-1","alt":"封面","title":null}
            ]
        }]);
        item["inline_media"] = json!([inline_media]);
        projection["lessons"][0]["layout"]["pages"][0]["items"][1]["media"] = Value::Null;
        let sources = HashMap::from([("asset-1".into(), "assets/photo.png".into())]);
        let html = render_html(&projection, &sources, false).expect("semantic HTML should render");
        assert!(html.contains("<strong>粗体</strong>"));
        assert!(html
            .contains("class=\"publication-inline-image\" src=\"assets/photo.png\" alt=\"封面\""));
        assert_eq!(selected_media_ids(&projection), vec!["asset-1"]);
        let pdf_html =
            render_html(&projection, &sources, true).expect("semantic PDF source should render");
        assert!(
            pdf_html.contains("<strong>粗体</strong>")
                && pdf_html.contains("publication-inline-image")
        );

        let pptx = render_pptx(
            &projection,
            &HashMap::from([("asset-1".into(), ("image/png".into(), sample_png()))]),
        )
        .expect("semantic PPTX should render");
        if let Some(path) = std::env::var_os("ACW_PPTX_SEMANTIC_PROBE_PATH") {
            std::fs::write(path, &pptx).expect("semantic PPTX probe should be written");
        }
        let slide =
            std::str::from_utf8(zip_stored_entry(&pptx, "ppt/slides/slide1.xml").unwrap()).unwrap();
        assert!(
            slide.contains("粗体") && slide.contains("b=\"1\""),
            "inline emphasis should remain editable text runs"
        );
        assert!(slide.contains("strike=\"sngStrike\""));
        assert!(
            slide.contains("<p:pic>"),
            "controlled inline image should remain a native picture shape"
        );

        projection["lessons"][0]["layout"]["pages"][0]["items"][0]["rich_text"] = json!([
            {"type":"list","ordered":false,"start":1,"items":[{"checked":null,"children":[{"type":"list","ordered":false,"start":1,"items":[]}]}]},
            {"type":"table","align":[],"header":[],"rows":[]}
        ]);
        assert!(
            has_simplified_pptx_semantics(&projection),
            "flattened tables and nested lists need a fidelity warning"
        );
    }

    #[test]
    fn pptx_has_editable_text_image_shapes_and_valid_package_relationships() {
        let mut projection = sample_projection();
        let pages = projection["lessons"][0]["layout"]["pages"]
            .as_array_mut()
            .unwrap();
        let first_page = pages[0].clone();
        for order in 1..3 {
            let mut page = first_page.clone();
            page["page_id"] = json!(format!("page-{}", order + 1));
            page["title"] = json!(format!("第{}页", order + 1));
            page["order"] = json!(order);
            pages.push(page);
        }
        let bytes = render_pptx(
            &projection,
            &HashMap::from([("asset-1".into(), ("image/png".into(), sample_png()))]),
        )
        .expect("PPTX should be generated");
        // Optional output lets an external Office reader inspect this exact renderer package.
        if let Some(path) = std::env::var_os("ACW_PPTX_PROBE_PATH") {
            std::fs::write(path, &bytes).expect("reader probe should be written");
        }
        let slide = std::str::from_utf8(zip_stored_entry(&bytes, "ppt/slides/slide1.xml").unwrap())
            .expect("slide XML should be UTF-8");
        let rels = std::str::from_utf8(
            zip_stored_entry(&bytes, "ppt/slides/_rels/slide1.xml.rels").unwrap(),
        )
        .expect("slide relationship XML should be UTF-8");
        assert!(slide.contains("可编辑中文"));
        assert!(slide.contains("<p:sp>"));
        assert!(slide.contains("<p:pic>"));
        assert!(slide.contains("r:embed=\"rId2\""));
        assert!(slide.contains("sz=\"2400\""));
        assert!(slide.contains("spcPct val=\"150000\""));
        assert!(slide.contains("srcRect l=\"0\" t=\"8333\" r=\"0\" b=\"8333\""));
        assert!(rels.contains("../media/image-1.png"));
        for part in [
            "[Content_Types].xml",
            "_rels/.rels",
            "ppt/presentation.xml",
            "ppt/_rels/presentation.xml.rels",
            "ppt/slideMasters/slideMaster1.xml",
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            "ppt/slideLayouts/slideLayout1.xml",
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            "ppt/theme/theme1.xml",
            "ppt/slides/_rels/slide1.xml.rels",
            "ppt/slides/slide1.xml",
            "ppt/slides/slide2.xml",
            "ppt/slides/slide3.xml",
            "ppt/slides/_rels/slide2.xml.rels",
            "ppt/slides/_rels/slide3.xml.rels",
            "ppt/media/image-1.png",
        ] {
            assert!(
                zip_stored_entry(&bytes, part).is_some(),
                "missing OPC part {part}"
            );
        }

        let master = std::str::from_utf8(
            zip_stored_entry(&bytes, "ppt/slideMasters/slideMaster1.xml").unwrap(),
        )
        .unwrap();
        assert!(master.contains("<p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/>"));
        assert!(master
            .contains("<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>"));
        let types =
            std::str::from_utf8(zip_stored_entry(&bytes, "[Content_Types].xml").unwrap()).unwrap();
        for slide_index in 1..=3 {
            assert!(types.contains(&format!("/ppt/slides/slide{slide_index}.xml\"")));
        }
        assert!(types.contains("Extension=\"png\" ContentType=\"image/png\""));
        let presentation =
            std::str::from_utf8(zip_stored_entry(&bytes, "ppt/presentation.xml").unwrap()).unwrap();
        assert_eq!(presentation.matches("<p:sldId ").count(), 3);
        let presentation_rels = std::str::from_utf8(
            zip_stored_entry(&bytes, "ppt/_rels/presentation.xml.rels").unwrap(),
        )
        .unwrap();
        assert!(presentation_rels.contains("Target=\"slides/slide3.xml\""));
        assert!(rels.contains("Target=\"../slideLayouts/slideLayout1.xml\""));
        assert!(rels.contains("Target=\"../media/image-1.png\""));

        let theme =
            std::str::from_utf8(zip_stored_entry(&bytes, "ppt/theme/theme1.xml").unwrap()).unwrap();
        let format_scheme = theme
            .split_once("<a:fmtScheme")
            .unwrap()
            .1
            .split_once("</a:fmtScheme>")
            .unwrap()
            .0;
        for (list_name, entry_name) in [
            ("fillStyleLst", "<a:solidFill>"),
            ("lnStyleLst", "<a:ln "),
            ("effectStyleLst", "<a:effectStyle>"),
            ("bgFillStyleLst", "<a:solidFill>"),
        ] {
            let list = format!("<a:{list_name}>");
            let close = format!("</a:{list_name}>");
            let entries = format_scheme
                .split_once(&list)
                .unwrap_or_else(|| panic!("missing DrawingML style list {list_name}"))
                .1
                .split_once(&close)
                .unwrap()
                .0;
            assert_eq!(
                entries.matches(entry_name).count(),
                3,
                "{list_name} needs three entries"
            );
        }
    }

    #[test]
    fn projection_validation_rejects_stale_and_out_of_bounds_pages() {
        let mut projection = sample_projection();
        let project = json!({
            "project": { "id": "p1", "updated_at": "2026-01-01T00:00:00Z" },
            "content_items": [{ "id": "lesson-1", "order_index": 0, "archived": false }],
            "layout_instances": [{
                "id": "layout-1", "content_item_id": "lesson-1", "mode": "grid",
                "pagination_mode": "paged"
            }],
            "layout_pages": [{ "id": "page-1", "layout_instance_id": "layout-1", "order_index": 0 }]
        });
        assert!(validate_projection(&projection, &project, Some("lesson-1"), "pdf").is_ok());
        projection["lessons"][0]["layout"]["pages"][0]["items"][0]["rect"]["x_pt"] = json!(1000.0);
        assert!(validate_projection(&projection, &project, Some("lesson-1"), "pdf").is_err());
        projection["lessons"][0]["layout"]["pages"][0]["items"][0]["rect"]["x_pt"] = json!(20.0);
        projection["generated_from_updated_at"] = json!("stale");
        assert!(validate_projection(&projection, &project, Some("lesson-1"), "pdf").is_err());
    }

    #[test]
    fn legacy_grid_notice_uses_canonical_section_and_root_placement_buckets() {
        let project = json!({
            "content_items": [{"id":"lesson-1","order_index":0}],
            "layout_instances": [{
                "id":"layout-1","content_item_id":"lesson-1","mode":"grid"
            }],
            "layout_sections": [
                {"id":"section-b","layout_instance_id":"layout-1","order_index":1,"page_index":0},
                {"id":"section-a","layout_instance_id":"layout-1","order_index":0,"page_index":1}
            ],
            "placements": [
                {"layout_instance_id":"layout-1","section_id":"section-b"},
                {"layout_instance_id":"layout-1","section_id":"section-a"},
                {"layout_instance_id":"layout-1","section_id":null}
            ]
        });
        let notices = legacy_grid_section_notices(&project, Some("lesson-1"), None).unwrap();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0]["section_ids"], json!(["section-a", "section-b"]));
        assert_eq!(notices[0]["includes_unsectioned"], json!(true));

        let mut paged = project.clone();
        paged["layout_instances"][0]["pagination_mode"] = json!("paged");
        assert!(legacy_grid_section_notices(&paged, Some("lesson-1"), None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn projection_notices_must_match_canonical_legacy_grid_ambiguity() {
        let mut project = json!({
            "content_items": [{"id":"lesson-1","order_index":0}],
            "layout_instances": [{"id":"layout-1","content_item_id":"lesson-1","mode":"grid"}],
            "layout_sections": [
                {"id":"section-1","layout_instance_id":"layout-1","order_index":0,"page_index":0},
                {"id":"section-2","layout_instance_id":"layout-1","order_index":1,"page_index":0}
            ],
            "placements": [
                {"layout_instance_id":"layout-1","section_id":"section-1"},
                {"layout_instance_id":"layout-1","section_id":"section-2"}
            ]
        });
        let notice = legacy_grid_section_notices(&project, Some("lesson-1"), None)
            .unwrap()
            .remove(0);
        let mut projection = sample_projection();
        projection["notices"] = json!([notice]);
        validate_projection_notices(&projection, &project, &["layout-1".into()])
            .expect("canonical ambiguity notice should validate");
        projection["notices"] = json!([]);
        assert!(validate_projection_notices(&projection, &project, &["layout-1".into()]).is_err());

        project["placements"][1]["section_id"] = json!("section-404");
        assert!(legacy_grid_section_notices(&project, Some("lesson-1"), None).is_err());
    }

    #[test]
    fn zip_writer_uses_stored_entries_with_crc32() {
        let mut zip = ZipWriter::default();
        zip.add("a.txt", b"hello").unwrap();
        let bytes = zip.finish().unwrap();
        assert_eq!(zip_stored_entry(&bytes, "a.txt"), Some(&b"hello"[..]));
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn xml_text_drops_invalid_control_characters() {
        assert_eq!(esc_xml("a\u{0}b"), "ab");
        assert_eq!(esc_xml("<中文>"), "&lt;中文&gt;");
    }
}
