use super::*;
use crate::resource_providers::{
    fetch_source, search_videos, search_web, RequestPermit, SourceFetchResult, VideoHit,
    WebSearchHit,
};
use std::sync::atomic::AtomicUsize;

const PLAN_TTL_MS: u128 = 15 * 60 * 1_000;
const MAX_RESOURCE_PLANS: usize = 32;
const MAX_RESOURCE_TASKS: usize = 8;
const RESOURCE_STATE_PATH: &str = ".workspace/resource-discovery.json";
const RESOURCE_STATE_MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
struct NativeResourcePlan {
    project_dir: PathBuf,
    lease_generation: String,
    value: Value,
    queries: Vec<Value>,
}

#[derive(Clone)]
struct NativeResourceTask {
    plan: NativeResourcePlan,
    value: Value,
    failed_queries: Vec<Value>,
    cancel: Arc<AtomicBool>,
}

static RESOURCE_PLANS: OnceLock<Mutex<HashMap<String, NativeResourcePlan>>> = OnceLock::new();
static RESOURCE_TASKS: OnceLock<Mutex<HashMap<String, NativeResourceTask>>> = OnceLock::new();
static RESOURCE_STATE_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn plans() -> &'static Mutex<HashMap<String, NativeResourcePlan>> {
    RESOURCE_PLANS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tasks() -> &'static Mutex<HashMap<String, NativeResourceTask>> {
    RESOURCE_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn persist_project_state(project_dir: &Path, project_id: &str) -> Result<Option<String>, String> {
    // ponytail: one process-wide write lock prevents older snapshots overwriting newer ones;
    // split by project only if concurrent project discovery becomes measurable.
    let _write = RESOURCE_STATE_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "资源状态写入锁不可用")?;
    let plans = plans()
        .lock()
        .map_err(|_| "资源计划锁不可用")?
        .values()
        .filter(|plan| {
            plan.project_dir == project_dir && plan.value["project_id"].as_str() == Some(project_id)
        })
        .map(|plan| {
            json!({
                "lease_generation": plan.lease_generation,
                "value": plan.value,
                "queries": plan.queries,
            })
        })
        .collect::<Vec<_>>();
    let tasks = tasks()
        .lock()
        .map_err(|_| "资源任务锁不可用")?
        .values()
        .filter(|task| {
            task.plan.project_dir == project_dir
                && task.plan.value["project_id"].as_str() == Some(project_id)
        })
        .map(|task| {
            json!({
                "plan": {
                    "lease_generation": task.plan.lease_generation,
                    "value": task.plan.value,
                    "queries": task.plan.queries,
                },
                "value": task.value,
                "failed_queries": task.failed_queries,
            })
        })
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&json!({
        "version": 1,
        "project_id": project_id,
        "plans": plans,
        "tasks": tasks,
    }))
    .map_err(|error| format!("无法编码资源发现恢复记录: {error}"))?;
    if bytes.len() > RESOURCE_STATE_MAX_BYTES {
        return Err("resource_state_too_large: 资源发现恢复记录超过 2 MiB。".into());
    }
    let contents = String::from_utf8(bytes).map_err(|error| error.to_string())?;
    let path = project_file(project_dir, RESOURCE_STATE_PATH)?;
    atomic_write_path_report(&path, &contents, false).map_err(|failure| failure.message)
}

fn receipt_plan(
    row: &Value,
    project_dir: &Path,
    project_id: &str,
) -> Result<NativeResourcePlan, String> {
    let value = row
        .get("value")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or("resource_state_invalid: plan value is missing")?;
    let lease_generation = row
        .get("lease_generation")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or("resource_state_invalid: plan lease is invalid")?
        .to_owned();
    let plan_id = value["plan_id"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or("resource_state_invalid: plan id is invalid")?;
    if value["project_id"].as_str() != Some(project_id)
        || !value["queries"].is_array()
        || value["queries"]
            .as_array()
            .is_some_and(|rows| rows.len() > 20)
    {
        return Err("resource_state_invalid: plan binding or query rows are invalid".into());
    }
    let queries = row
        .get("queries")
        .and_then(Value::as_array)
        .filter(|queries| queries.len() <= 20)
        .cloned()
        .ok_or("resource_state_invalid: plan queries are invalid")?;
    if value["queries"].as_array() != Some(&queries) {
        return Err("resource_state_invalid: plan queries do not match the plan payload".into());
    }
    let _ = plan_id;
    Ok(NativeResourcePlan {
        project_dir: project_dir.to_path_buf(),
        lease_generation,
        value,
        queries,
    })
}

fn load_project_state(project_dir: &Path, project: &Value) -> Result<Option<String>, String> {
    let path = project_file(project_dir, RESOURCE_STATE_PATH)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取资源发现恢复记录: {error}")),
    };
    if bytes.len() > RESOURCE_STATE_MAX_BYTES {
        return Err("resource_state_too_large: 资源发现恢复记录超过 2 MiB。".into());
    }
    let record: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "resource_state_invalid: 资源发现恢复记录不是有效 JSON。")?;
    let project_id = project_id_of(project)?;
    if record["version"] != 1 || record["project_id"].as_str() != Some(project_id.as_str()) {
        return Err("resource_state_invalid: 资源发现恢复记录与项目不匹配。".into());
    }
    let raw_plans = record["plans"]
        .as_array()
        .filter(|rows| rows.len() <= MAX_RESOURCE_PLANS)
        .ok_or("resource_state_invalid: plans 数组无效")?;
    let raw_tasks = record["tasks"]
        .as_array()
        .filter(|rows| rows.len() <= MAX_RESOURCE_TASKS)
        .ok_or("resource_state_invalid: tasks 数组无效")?;
    let mut loaded_plans = HashMap::new();
    for row in raw_plans {
        let plan = receipt_plan(row, project_dir, &project_id)?;
        let plan_id = plan.value["plan_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if loaded_plans.insert(plan_id, plan).is_some() {
            return Err("resource_state_invalid: 重复 plan id".into());
        }
    }
    let mut loaded_tasks = HashMap::new();
    let mut interrupted = false;
    for row in raw_tasks {
        let plan = receipt_plan(&row["plan"], project_dir, &project_id)?;
        let value = row
            .get("value")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or("resource_state_invalid: task value is missing")?;
        let task_id = value["task_id"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .ok_or("resource_state_invalid: task id is invalid")?
            .to_owned();
        let failed_queries = row["failed_queries"]
            .as_array()
            .filter(|queries| queries.len() <= 200)
            .cloned()
            .ok_or("resource_state_invalid: failed queries are invalid")?;
        let state = value["state"].as_str().unwrap_or_default().to_owned();
        if !matches!(
            state.as_str(),
            "queued"
                | "running"
                | "partial"
                | "completed"
                | "cancel_requested"
                | "cancelled"
                | "failed"
                | "stale"
                | "interrupted"
        ) || value["plan_id"] != plan.value["plan_id"]
            || value["snapshot"] != plan.value["snapshot"]
            || value["candidates"]
                .as_array()
                .is_none_or(|candidates| candidates.len() > 500)
        {
            return Err("resource_state_invalid: task payload is inconsistent".into());
        }
        let mut value = value;
        if matches!(state.as_str(), "queued" | "running" | "cancel_requested") {
            value["state"] = json!("interrupted");
            value["updated_at"] = json!(rfc3339_now());
            interrupted = true;
        }
        let task = NativeResourceTask {
            plan,
            value,
            failed_queries,
            cancel: Arc::new(AtomicBool::new(true)),
        };
        if loaded_tasks.insert(task_id, task).is_some() {
            return Err("resource_state_invalid: 重复 task id".into());
        }
    }

    // Replacing records also detaches any old worker-held cancel token.
    let mut all_tasks = tasks().lock().map_err(|_| "资源任务锁不可用")?;
    all_tasks.retain(|_, task| task.plan.project_dir != project_dir);
    all_tasks.extend(loaded_tasks);
    drop(all_tasks);
    let mut all_plans = plans().lock().map_err(|_| "资源计划锁不可用")?;
    all_plans.retain(|_, plan| plan.project_dir != project_dir);
    all_plans.extend(loaded_plans);
    drop(all_plans);
    if interrupted {
        return persist_project_state(project_dir, &project_id);
    }
    Ok(None)
}

pub(crate) fn recover_project_on_open(project_dir: &Path, project: &Value) -> Option<String> {
    let project_id = match project_id_of(project) {
        Ok(project_id) => project_id,
        Err(error) => return Some(error),
    };
    let has_memory = tasks().lock().ok().is_some_and(|all| {
        all.values()
            .any(|task| task.plan.project_dir == project_dir)
    }) || plans()
        .lock()
        .ok()
        .is_some_and(|all| all.values().any(|plan| plan.project_dir == project_dir));
    if has_memory {
        if let Ok(mut all) = tasks().lock() {
            for task in all
                .values_mut()
                .filter(|task| task.plan.project_dir == project_dir)
            {
                task.cancel.store(true, Ordering::Release);
                task.cancel = Arc::new(AtomicBool::new(true));
                if matches!(
                    task.value["state"].as_str(),
                    Some("queued" | "running" | "cancel_requested")
                ) {
                    task.value["state"] = json!("interrupted");
                    task.value["updated_at"] = json!(rfc3339_now());
                }
            }
        }
        return match persist_project_state(project_dir, &project_id) {
            Ok(warning) => warning,
            Err(error) => Some(error),
        };
    }
    match load_project_state(project_dir, project) {
        Ok(warning) => warning,
        Err(error) => Some(error),
    }
}

fn ensure_project_state_loaded(
    project_dir: &Path,
    project: &Value,
) -> Result<Option<String>, String> {
    let in_memory = tasks()
        .lock()
        .map_err(|_| "资源任务锁不可用")?
        .values()
        .any(|task| task.plan.project_dir == project_dir)
        || plans()
            .lock()
            .map_err(|_| "资源计划锁不可用")?
            .values()
            .any(|plan| plan.project_dir == project_dir);
    if in_memory {
        return Ok(None);
    }
    load_project_state(project_dir, project)
}

fn persist_task(task: &NativeResourceTask) -> Result<Option<String>, String> {
    let project_id = task.plan.value["project_id"]
        .as_str()
        .ok_or("resource_state_invalid: task project id is missing")?;
    persist_project_state(&task.plan.project_dir, project_id)
}

fn persist_live_task(task_id: &str) -> Result<Option<String>, String> {
    let task = {
        let mut all = tasks().lock().map_err(|_| "资源任务锁不可用")?;
        all.get_mut(task_id).map(|task| {
            task.value
                .as_object_mut()
                .map(|value| value.remove("resource_recovery_warning"));
            task.clone()
        })
    };
    let Some(task) = task else { return Ok(None) };
    match persist_task(&task) {
        Ok(warning) => {
            if let Some(warning) = warning.as_deref() {
                if let Ok(mut all) = tasks().lock() {
                    if let Some(task) = all.get_mut(task_id) {
                        task.value["resource_recovery_warning"] = json!(warning);
                    }
                }
            }
            Ok(warning)
        }
        Err(error) => {
            if let Ok(mut all) = tasks().lock() {
                if let Some(task) = all.get_mut(task_id) {
                    task.value["resource_recovery_warning"] = json!(error);
                }
            }
            Err(error)
        }
    }
}

fn task_value_for_project(
    project_dir: &Path,
    project: &Value,
    task_id: &str,
) -> Result<Value, String> {
    ensure_project_state_loaded(project_dir, project)?;
    Ok(tasks()
        .lock()
        .map_err(|_| "资源任务锁不可用")?
        .get(task_id)
        .filter(|task| task.plan.project_dir == project_dir)
        .map(|task| task.value.clone())
        .unwrap_or(Value::Null))
}

fn validate_task_for_accept(
    task: &NativeResourceTask,
    project: &Value,
    current_binding_valid: bool,
) -> Result<(), String> {
    if !current_binding_valid {
        return Err("stale_input: 需要当前项目打开后取得的新变更绑定。".into());
    }
    if task.plan.value["project_id"].as_str() != project_id_of(project).ok().as_deref()
        || !lesson_snapshots_match(project, &task.plan)
    {
        return Err("stale_input: 资源候选对应的课程内容已变化。".into());
    }
    match task.value["state"].as_str() {
        Some("interrupted" | "partial" | "completed" | "failed" | "cancelled") => Ok(()),
        Some("queued" | "running" | "cancel_requested") if project_still_matches(task) => Ok(()),
        _ => Err("stale_input: 任务绑定已过期，请重新搜索或重新打开任务。".into()),
    }
}

fn payload(request: &tauri::ipc::Request<'_>, command: &str) -> Result<Map<String, Value>, String> {
    strict_payload(&ai_invoke_args(request), command)
}

fn project_directory(input: &Map<String, Value>) -> Result<PathBuf, String> {
    let raw = required_string(input, &["project_dir", "projectDir"], "项目目录")?;
    explicit_project_dir(&raw, false)
}

fn hydrate_project_from_input(input: &Map<String, Value>) -> Result<PathBuf, String> {
    let project_dir = project_directory(input)?;
    let (project, _) = read_project_state(&project_dir)?;
    ensure_project_state_loaded(&project_dir, &project)?;
    Ok(project_dir)
}

fn normalized_text(value: &Value) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn numeric_generation(lease_generation: &str) -> u64 {
    u64::from_str_radix(&sha256_hex(lease_generation.as_bytes())[..16], 16).unwrap_or(0)
}

fn timestamp_after(delta_ms: u128) -> String {
    let total = unix_millis().saturating_add(delta_ms);
    let seconds = (total / 1_000) as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = super::civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        day_seconds / 3_600,
        day_seconds % 3_600 / 60,
        day_seconds % 60,
        total % 1_000,
    )
}

fn date_in_range(value: Option<&str>, preferences: &Map<String, Value>) -> bool {
    let Some(value) = value.and_then(|value| value.get(..10)) else {
        return true;
    };
    let after = preferences
        .get("published_after")
        .and_then(Value::as_str)
        .and_then(|value| value.get(..10));
    let before = preferences
        .get("published_before")
        .and_then(Value::as_str)
        .and_then(|value| value.get(..10));
    !after.is_some_and(|after| value < after) && !before.is_some_and(|before| value > before)
}

fn parse_date(value: Option<&str>) -> Option<String> {
    let value = value?;
    let date = value.get(..10)?;
    if date.len() != 10
        || !date.as_bytes().iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
    {
        return None;
    }
    Some(if value.len() == 10 {
        format!("{value}T00:00:00.000Z")
    } else {
        value.to_owned()
    })
}

fn build_context(project: &Value, lesson_id: &str) -> Result<(Value, String), String> {
    let item = project
        .get("content_items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("id").and_then(Value::as_str) == Some(lesson_id)
                    && item.get("archived") != Some(&Value::Bool(true))
            })
        })
        .ok_or_else(|| "stale_input: 所选课次已不存在，请重新准备资源发现。".to_owned())?;
    if item.get("type").and_then(Value::as_str) != Some("lesson") {
        return Err("invalid_lesson: 资源发现只能针对课次。".into());
    }
    let document_id = item
        .get("document_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let document = project
        .get("documents")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("id").and_then(Value::as_str) == Some(document_id))
        });
    let mut blocks = project
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("document_id").and_then(Value::as_str) == Some(document_id))
        .collect::<Vec<_>>();
    blocks.sort_by_key(|block| {
        block
            .get("order_index")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    });
    let source_blocks = blocks
        .iter()
        .copied()
        .filter(|block| {
            matches!(
                block.get("type").and_then(Value::as_str),
                Some("heading" | "paragraph" | "quote" | "callout")
            ) && !normalized_text(&block["content"]).is_empty()
        })
        .take(3)
        .collect::<Vec<_>>();
    let block_text = source_blocks
        .iter()
        .map(|block| normalized_text(&block["content"]))
        .collect::<Vec<_>>()
        .join(" ");
    let title = normalized_text(&item["title"]);
    let description = normalized_text(&item["description"]);
    let excerpt = format!("{title} {description} {block_text}")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let excerpt = excerpt.chars().take(240).collect::<String>();
    let revision = json!({
        "item": {
            "id": item.get("id"),
            "updated_at": item.get("updated_at"),
            "title": item.get("title"),
            "description": item.get("description"),
        },
        "document": document.map(|document| json!({ "id": document.get("id"), "updated_at": document.get("updated_at") })),
        "blocks": source_blocks.iter().map(|block| json!({
            "id": block.get("id"), "type": block.get("type"), "content": block.get("content"), "updated_at": block.get("updated_at")
        })).collect::<Vec<_>>(),
    });
    let existing_resources = project
        .get("resource_usages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|usage| usage.get("lesson_id").and_then(Value::as_str) == Some(lesson_id))
        .filter_map(|usage| {
            usage
                .get("resource_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect::<HashSet<_>>();
    let source_locators = source_blocks
        .iter()
        .map(|block| {
            let is_heading = block.get("type").and_then(Value::as_str) == Some("heading");
            let text = normalized_text(&block["content"]);
            json!({
                "block_id": block.get("id"),
                "section": is_heading.then_some(text.clone()),
                "paragraph": (!is_heading).then(|| text.chars().take(160).collect::<String>()),
            })
        })
        .collect::<Vec<_>>();
    Ok((
        json!({
            "content_item_id": lesson_id,
            "title": title,
            "excerpt": excerpt,
            "existing_resource_ids": existing_resources.into_iter().collect::<Vec<_>>(),
            "source_locators": source_locators,
            "revision": revision,
        }),
        excerpt,
    ))
}

fn build_plan(
    project: &Value,
    input: &Map<String, Value>,
    project_dir: PathBuf,
) -> Result<NativeResourcePlan, String> {
    let project_id = project_id_of(project)?;
    let items = input
        .get("content_item_ids")
        .and_then(Value::as_array)
        .ok_or("invalid_input: content_item_ids 必须是数组")?;
    let search_types = input
        .get("search_types")
        .and_then(Value::as_array)
        .ok_or("invalid_input: search_types 必须是数组")?;
    let preferences = input
        .get("preferences")
        .and_then(Value::as_object)
        .ok_or("invalid_input: preferences 必须是对象")?;
    let request_budget = input
        .get("request_budget")
        .and_then(Value::as_u64)
        .filter(|value| (1..=200).contains(value))
        .ok_or("invalid_input: 网络请求预算需为 1 到 200。")?;
    if items.is_empty() || items.len() > 20 || search_types.is_empty() {
        return Err("invalid_input: 请至少选择一节课和一种资源类型。".into());
    }
    let mut item_ids = Vec::new();
    for value in items {
        let id = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("invalid_input: content_item_ids 含无效 ID")?;
        if !item_ids.iter().any(|current| current == id) {
            item_ids.push(id.to_owned());
        }
    }
    let mut kinds = Vec::new();
    for value in search_types {
        let kind = value
            .as_str()
            .ok_or("invalid_input: search_types 含无效值")?;
        if !matches!(kind, "web" | "video") {
            return Err("invalid_input: 不支持的资源类型。".into());
        }
        if !kinds.iter().any(|current| current == kind) {
            kinds.push(kind.to_owned());
        }
    }
    let per_lesson_limit = preferences
        .get("per_lesson_limit")
        .and_then(Value::as_u64)
        .filter(|value| (1..=20).contains(value))
        .ok_or("invalid_input: per_lesson_limit 必须是 1 到 20。")?
        as usize;
    let mut queries = Vec::new();
    let mut previews = Vec::new();
    let mut lesson_revisions = Map::new();
    for lesson_id in &item_ids {
        let (context, excerpt) = build_context(project, lesson_id)?;
        let title = context["title"].as_str().unwrap_or_default();
        let base = if excerpt.is_empty() {
            title.to_owned()
        } else {
            excerpt.clone()
        };
        let suffix = ["language", "learner_level"]
            .into_iter()
            .filter_map(|key| preferences.get(key).and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let case_types = preferences
            .get("case_types")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" ");
        let source_preferences = preferences
            .get("source_preference")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" ");
        let date_terms = [
            preferences
                .get("published_after")
                .and_then(Value::as_str)
                .map(|value| format!("after:{}", &value[..value.len().min(10)])),
            preferences
                .get("published_before")
                .and_then(Value::as_str)
                .map(|value| format!("before:{}", &value[..value.len().min(10)])),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
        let query = format!("{base} {suffix} {case_types} {source_preferences} {date_terms}")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let query = query.chars().take(500).collect::<String>();
        let query_rows = kinds
            .iter()
            .map(|kind| {
                json!({
                    "kind": kind,
                    "query": query,
                    "request_budget_upper_bound": if kind == "web" { 1 + per_lesson_limit.min(3) } else { 4 },
                })
            })
            .collect::<Vec<_>>();
        lesson_revisions.insert(lesson_id.clone(), context["revision"].clone());
        previews.push(json!({ "content_item_id": lesson_id, "title": title, "excerpt": excerpt }));
        queries.push(json!({
            "lesson_id": lesson_id,
            "need": base,
            "existing_resource_ids": context["existing_resource_ids"],
            "source_locators": context["source_locators"],
            "queries": query_rows,
        }));
    }
    let lease_generation = active_lease_generation(&project_dir)?;
    let generation = numeric_generation(&lease_generation);
    let input_hash_value = json!({
        "project_id": project_id,
        "generation": generation,
        "lesson_revisions": lesson_revisions,
        "content_item_ids": item_ids,
        "search_types": kinds,
        "request_budget": request_budget,
        "preferences": preferences,
        "queries": queries,
    });
    let input_hash =
        sha256_hex(&serde_json::to_vec(&input_hash_value).map_err(|error| error.to_string())?);
    let required_upper_bound = queries
        .iter()
        .flat_map(|row| row["queries"].as_array().into_iter().flatten())
        .map(|query| query["request_budget_upper_bound"].as_u64().unwrap_or(0))
        .sum::<u64>();
    let plan_id = native_id("resource-plan");
    let created_at = rfc3339_now();
    let value = json!({
        "plan_id": plan_id,
        "project_id": project_id,
        "input_hash": input_hash,
        "snapshot": {
            "project_id": project_id,
            "generation": generation,
            "input_hash": input_hash,
            "lesson_revisions": lesson_revisions,
        },
        "content_item_ids": item_ids,
        "preferences": preferences,
        "queries": queries,
        "context_preview": {
            "items": previews,
            "character_count": previews.iter().map(|item| item["excerpt"].as_str().unwrap_or_default().chars().count()).sum::<usize>(),
        },
        "budget": { "max_requests": request_budget, "required_upper_bound": required_upper_bound },
        "created_at": created_at,
        "expires_at": timestamp_after(PLAN_TTL_MS),
    });
    let plan = NativeResourcePlan {
        project_dir,
        lease_generation,
        value,
        queries,
    };
    Ok(plan)
}

fn lesson_snapshots_match(project: &Value, plan: &NativeResourcePlan) -> bool {
    let Some(expected) = plan.value["snapshot"]["lesson_revisions"].as_object() else {
        return false;
    };
    expected.iter().all(|(lesson_id, revision)| {
        build_context(project, lesson_id)
            .map(|(context, _)| context["revision"] == *revision)
            .unwrap_or(false)
    })
}

fn current_result_task<'a>(
    all: &'a mut HashMap<String, NativeResourceTask>,
    task_id: &str,
    expected: &NativeResourceTask,
    project_matches: impl FnOnce() -> bool,
) -> Option<&'a mut NativeResourceTask> {
    let task = all.get_mut(task_id)?;
    if !Arc::ptr_eq(&task.cancel, &expected.cancel)
        || expected.cancel.load(Ordering::Acquire)
        || !matches!(task.value["state"].as_str(), Some("queued" | "running"))
    {
        return None;
    }
    if !project_matches() {
        task.cancel.store(true, Ordering::Release);
        task.value["state"] = json!("stale");
        task.value["updated_at"] = json!(rfc3339_now());
        return None;
    }
    Some(task)
}

fn provider_failure(error: &str) -> (String, String) {
    let parsed = serde_json::from_str::<Value>(error).unwrap_or(Value::Null);
    (
        parsed
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("provider_unavailable")
            .to_owned(),
        parsed
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("资源服务暂时不可用，请稍后重试。".into())
            .to_owned(),
    )
}

fn add_candidate(task_id: &str, expected: &NativeResourceTask, candidate: Value) {
    add_candidate_with_check(task_id, expected, candidate, || {
        project_still_matches(expected)
    });
}

fn add_candidate_with_check(
    task_id: &str,
    expected: &NativeResourceTask,
    candidate: Value,
    project_matches: impl FnOnce() -> bool,
) {
    let Ok(mut all) = tasks().lock() else { return };
    if let Some(task) = current_result_task(&mut all, task_id, expected, project_matches) {
        if let Some(candidates) = task.value["candidates"].as_array_mut() {
            let lesson_id = candidate["lesson_id"].as_str();
            let key = candidate["video"]["provider_video_id"]
                .as_str()
                .map(|id| format!("youtube:{id}"))
                .or_else(|| {
                    candidate["url"]
                        .as_str()
                        .map(|url| format!("url:{}", canonical_url(url)))
                });
            let existing = key.as_deref().and_then(|key| {
                candidates.iter_mut().find(|existing| {
                    let existing_key = existing["video"]["provider_video_id"]
                        .as_str()
                        .map(|id| format!("youtube:{id}"))
                        .or_else(|| {
                            existing["url"]
                                .as_str()
                                .map(|url| format!("url:{}", canonical_url(url)))
                        });
                    existing.get("lesson_id").and_then(Value::as_str) == lesson_id
                        && existing_key.as_deref() == Some(key)
                })
            });
            if let Some(existing) = existing {
                let known = existing["source_evidence"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|evidence| {
                        Some((
                            evidence["provider_id"].as_str()?.to_owned(),
                            evidence["request_id"].as_str()?.to_owned(),
                            evidence["url"].as_str()?.to_owned(),
                        ))
                    })
                    .collect::<HashSet<_>>();
                for evidence in candidate["source_evidence"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    let evidence_key = (
                        evidence["provider_id"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        evidence["request_id"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        evidence["url"].as_str().unwrap_or_default().to_owned(),
                    );
                    if !known.contains(&evidence_key) {
                        existing["source_evidence"]
                            .as_array_mut()
                            .map(|items| items.push(evidence.clone()));
                    }
                }
            } else if candidates.len() < 200 {
                candidates.push(candidate);
            }
            task.value["updated_at"] = json!(rfc3339_now());
        }
    }
    drop(all);
    let _ = persist_live_task(task_id);
}

fn canonical_url(value: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(value) else {
        return value.trim().to_owned();
    };
    url.set_fragment(None);
    let pairs = url
        .query_pairs()
        .filter(|(key, _)| {
            !key.to_ascii_lowercase().starts_with("utm_")
                && !matches!(key.to_ascii_lowercase().as_str(), "ref" | "source")
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    if !pairs.is_empty() {
        url.query_pairs_mut().extend_pairs(pairs);
    }
    url.as_str().trim_end_matches('/').to_owned()
}

fn web_candidate(
    task_id: &str,
    lesson_id: &str,
    hit: &WebSearchHit,
    fetched: Option<&SourceFetchResult>,
    failure: Option<&str>,
) -> Value {
    let evidence_id = native_id("evidence");
    let published = parse_date(hit.published_at.as_deref());
    let summary = fetched
        .and_then(|row| row.excerpt.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| hit.description.clone());
    let mut limitations = fetched
        .map(|row| row.limitations.clone())
        .unwrap_or_default();
    if let Some(failure) = failure {
        let (code, _) = provider_failure(failure);
        limitations.push(format!(
            "来源正文读取失败 ({code})；搜索结果元数据不作为来源正文。"
        ));
    }
    if hit.published_at.is_some() && published.is_none() {
        limitations.push("来源发布时间无法标准化，事件日期保持未知。".into());
    }
    let evidence = json!({
        "id": evidence_id,
        "project_id": "",
        "provider_id": hit.provider_id,
        "request_id": fetched.map(|row| row.request_id.as_str()).unwrap_or(&hit.request_id),
        "query": hit.query,
        "requested_at": fetched.map(|row| row.requested_at.as_str()).unwrap_or(&hit.requested_at),
        "url": hit.url,
        "title": fetched.map(|row| row.title.as_str()).unwrap_or(&hit.title),
        "publisher": fetched.and_then(|row| row.publisher.as_ref()).or(hit.publisher.as_ref()),
        "event_date": null,
        "published_at": published.clone(),
        "fetched_at": fetched.map(|row| row.fetched_at.as_str()).unwrap_or(&hit.fetched_at),
        "excerpt": fetched.and_then(|row| row.excerpt.as_ref()),
        "evidence_access": fetched.map(|row| row.evidence_access.as_str()).unwrap_or("unavailable"),
        "fact_check": "unchecked",
        "content_hash": fetched.and_then(|row| row.content_hash.as_ref()),
        "limitations": limitations,
    });
    let claims = if summary.trim().is_empty() {
        Vec::new()
    } else {
        vec![json!({ "text": summary, "evidence_ids": [evidence_id] })]
    };
    json!({
        "id": native_id("candidate"),
        "task_id": task_id,
        "lesson_id": lesson_id,
        "medium": "text",
        "narrative_case_type": null,
        "title": fetched.map(|row| row.title.as_str()).unwrap_or(&hit.title),
        "event_subject": null,
        "event_date": null,
        "published_at": published,
        "publisher": fetched.and_then(|row| row.publisher.as_ref()).or(hit.publisher.as_ref()),
        "url": hit.url,
        "fetched_at": fetched.map(|row| row.fetched_at.as_str()).unwrap_or(&hit.fetched_at),
        "factual_summary": summary,
        "claims": claims,
        "source_evidence": [evidence],
        "video": null,
        "duration_class": "unknown",
        "status": "pending",
        "limitations": limitations,
    })
}

fn video_candidate(task_id: &str, lesson_id: &str, hit: &VideoHit) -> Value {
    let evidence_id = native_id("evidence");
    let published = parse_date(hit.published_at.as_deref());
    let summary = hit.description.clone();
    let mut limitations = hit.metadata_limitations.clone();
    if hit.captions_available.is_none() {
        limitations.push("字幕语言和逐字稿未通过公开 API key 核验。".into());
    }
    let evidence = json!({
        "id": evidence_id,
        "project_id": "",
        "provider_id": hit.provider_id,
        "request_id": hit.request_id,
        "query": hit.query,
        "requested_at": hit.requested_at,
        "url": hit.url,
        "title": hit.title,
        "publisher": hit.channel_title,
        "event_date": null,
        "published_at": published.clone(),
        "fetched_at": hit.fetched_at,
        "excerpt": null,
        "evidence_access": "metadata_only",
        "fact_check": "unchecked",
        "content_hash": null,
        "limitations": limitations,
    });
    let video = json!({
        "provider_id": hit.provider_id,
        "provider_video_id": hit.provider_video_id,
        "total_duration_sec": hit.total_duration_sec,
        "duration_evidence_id": hit.total_duration_sec.map(|_| evidence_id.clone()),
        "spoken_language": hit.spoken_language,
        "subtitle_languages": null,
        "language_evidence_ids": [],
        "caption_state": hit.captions_available.map(|available| if available { "available" } else { "unavailable" }).unwrap_or("unknown"),
        "embeddable": hit.embeddable,
        "region_availability": hit.region_availability,
        "metadata_limitations": limitations,
    });
    let claims = if summary.trim().is_empty() {
        Vec::new()
    } else {
        vec![json!({ "text": summary, "evidence_ids": [evidence_id] })]
    };
    json!({
        "id": native_id("candidate"),
        "task_id": task_id,
        "lesson_id": lesson_id,
        "medium": "video",
        "narrative_case_type": null,
        "title": hit.title,
        "event_subject": null,
        "event_date": null,
        "published_at": published,
        "publisher": hit.channel_title,
        "url": hit.url,
        "fetched_at": hit.fetched_at,
        "factual_summary": summary,
        "claims": claims,
        "source_evidence": [evidence],
        "video": video,
        "duration_class": hit.duration_class,
        "status": "pending",
        "limitations": limitations,
    })
}

fn add_task_error(task_id: &str, expected: &NativeResourceTask, query: &Value, error: &str) {
    add_task_error_with_check(task_id, expected, query, error, || {
        project_still_matches(expected)
    });
}

fn add_task_error_with_check(
    task_id: &str,
    expected: &NativeResourceTask,
    query: &Value,
    error: &str,
    project_matches: impl FnOnce() -> bool,
) {
    let (code, message) = provider_failure(error);
    let Ok(mut all) = tasks().lock() else { return };
    if let Some(task) = current_result_task(&mut all, task_id, expected, project_matches) {
        let mut value = json!({ "code": code, "message": message });
        if let Some(query) = query["query"].as_str() {
            value["query"] = json!(query);
        }
        task.value["errors"]
            .as_array_mut()
            .map(|errors| errors.push(value));
        if !task.failed_queries.iter().any(|row| row == query) {
            task.failed_queries.push(query.clone());
        }
        task.value["updated_at"] = json!(rfc3339_now());
    }
    drop(all);
    let _ = persist_live_task(task_id);
}

fn mark_task_stale_if_current(task_id: &str, expected: &NativeResourceTask) {
    if let Ok(mut all) = tasks().lock() {
        if let Some(task) = all.get_mut(task_id) {
            if Arc::ptr_eq(&task.cancel, &expected.cancel)
                && !expected.cancel.load(Ordering::Acquire)
                && matches!(task.value["state"].as_str(), Some("queued" | "running"))
            {
                task.cancel.store(true, Ordering::Release);
                task.value["state"] = json!("stale");
                task.value["updated_at"] = json!(rfc3339_now());
            }
        }
    }
    let _ = persist_live_task(task_id);
}

fn project_still_matches(task: &NativeResourceTask) -> bool {
    let Ok(lease) = active_lease_generation(&task.plan.project_dir) else {
        return false;
    };
    if lease != task.plan.lease_generation {
        return false;
    }
    read_project_value(&task.plan.project_dir)
        .map(|project| {
            project_id_of(&project).ok().as_deref() == task.plan.value["project_id"].as_str()
                && lesson_snapshots_match(&project, &task.plan)
        })
        .unwrap_or(false)
}

fn spend_request(
    task_id: String,
    task: NativeResourceTask,
    completed: Arc<AtomicUsize>,
) -> RequestPermit {
    Arc::new(move || {
        if task.cancel.load(Ordering::Acquire) {
            return Err(
                serde_json::json!({ "code": "cancelled", "message": "资源服务请求已取消。" })
                    .to_string(),
            );
        }
        if !project_still_matches(&task) {
            if let Ok(mut all) = tasks().lock() {
                if let Some(live) = all.get_mut(&task_id) {
                    if Arc::ptr_eq(&live.cancel, &task.cancel)
                        && !task.cancel.load(Ordering::Acquire)
                        && matches!(live.value["state"].as_str(), Some("queued" | "running"))
                    {
                        task.cancel.store(true, Ordering::Release);
                        live.value["state"] = json!("stale");
                        live.value["updated_at"] = json!(rfc3339_now());
                    }
                }
            }
            return Err(serde_json::json!({ "code": "stale_input", "message": "课程已切换或修改，请重新准备资源发现。" }).to_string());
        }
        let max = task.value["budget"]["max_requests"].as_u64().unwrap_or(0) as usize;
        loop {
            let current = completed.load(Ordering::Acquire);
            if current >= max {
                return Err(serde_json::json!({ "code": "budget_exhausted", "message": "网络请求预算已用完。" }).to_string());
            }
            if completed
                .compare_exchange(current, current + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                break;
            }
        }
        let updated_task = if let Ok(mut all) = tasks().lock() {
            if let Some(live) = all.get_mut(&task_id) {
                if Arc::ptr_eq(&live.cancel, &task.cancel) {
                    let completed = all_request_count(&live.value).saturating_add(1);
                    live.value["budget"]["completed_requests"] = json!(completed);
                    live.value["budget"]["remaining_requests"] =
                        json!(max.saturating_sub(completed as usize));
                    live.value["updated_at"] = json!(rfc3339_now());
                    Some(live.clone())
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        if let Some(updated_task) = updated_task {
            if let Err(error) = persist_task(&updated_task) {
                return Err(serde_json::json!({
                    "code": "resource_state_write_failed",
                    "message": error,
                })
                .to_string());
            }
        }
        Ok(())
    })
}

fn all_request_count(task: &Value) -> u64 {
    task["budget"]["completed_requests"].as_u64().unwrap_or(0)
}

fn update_progress(task_id: &str, expected: &NativeResourceTask, query_complete: bool) {
    let updated_task = if let Ok(mut all) = tasks().lock() {
        if let Some(task) = all.get_mut(task_id) {
            if !Arc::ptr_eq(&task.cancel, &expected.cancel)
                || expected.cancel.load(Ordering::Acquire)
                || task.value["state"] != "running"
            {
                None
            } else {
                if query_complete {
                    task.value["progress"]["completed_queries"] = json!(
                        task.value["progress"]["completed_queries"]
                            .as_u64()
                            .unwrap_or(0)
                            + 1
                    );
                }
                task.value["updated_at"] = json!(rfc3339_now());
                Some(task.clone())
            }
        } else {
            None
        }
    } else {
        None
    };
    if let Some(task) = updated_task {
        let _ = persist_task(&task);
    }
}

async fn run_queries(task_id: String, rows: Vec<Value>) {
    let task = match tasks()
        .lock()
        .ok()
        .and_then(|all| all.get(&task_id).cloned())
    {
        Some(task) => task,
        None => return,
    };
    let project = match read_project_value(&task.plan.project_dir) {
        Ok(project) => project,
        Err(_) => {
            mark_task_stale_if_current(&task_id, &task);
            return;
        }
    };
    if !lesson_snapshots_match(&project, &task.plan) || !project_still_matches(&task) {
        mark_task_stale_if_current(&task_id, &task);
        return;
    }
    let started = if let Ok(mut all) = tasks().lock() {
        if let Some(live) = all.get_mut(&task_id) {
            if !Arc::ptr_eq(&live.cancel, &task.cancel)
                || task.cancel.load(Ordering::Acquire)
                || live.value["state"] != "queued"
            {
                false
            } else {
                live.value["state"] = json!("running");
                live.value["updated_at"] = json!(rfc3339_now());
                true
            }
        } else {
            false
        }
    } else {
        false
    };
    if !started {
        return;
    }
    let _ = persist_live_task(&task_id);
    let completed = Arc::new(AtomicUsize::new(
        task.value["budget"]["completed_requests"]
            .as_u64()
            .unwrap_or(0) as usize,
    ));
    for row in rows {
        let task = match tasks()
            .lock()
            .ok()
            .and_then(|all| all.get(&task_id).cloned())
        {
            Some(task) => task,
            None => return,
        };
        if task.cancel.load(Ordering::Acquire) {
            break;
        }
        if !project_still_matches(&task) {
            mark_task_stale_if_current(&task_id, &task);
            break;
        }
        let query = row["queries"]
            .as_array()
            .and_then(|values| values.first())
            .cloned()
            .unwrap_or(Value::Null);
        let query_text = query["query"].as_str().unwrap_or_default();
        let kind = query["kind"].as_str().unwrap_or_default();
        let prefs = task.plan.value["preferences"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        let request_id = native_id("resource-request");
        let requested_at = rfc3339_now();
        let permit = spend_request(task_id.clone(), task.clone(), completed.clone());
        let cancel = task.cancel.clone();
        if kind == "web" {
            let key = match resource_credential_store().get("brave_search") {
                Ok(Some(value)) if !value.trim().is_empty() => value,
                Ok(_) => {
                    add_task_error(&task_id, &task, &query, &serde_json::json!({"code":"auth_required","message":"请先配置此资源服务的专用 API Key。"}).to_string());
                    update_progress(&task_id, &task, true);
                    continue;
                }
                Err(_) => {
                    add_task_error(&task_id, &task, &query, &serde_json::json!({"code":"keychain_unavailable","message":"无法读取资源服务凭据。"}).to_string());
                    update_progress(&task_id, &task, true);
                    continue;
                }
            };
            let count = prefs
                .get("per_lesson_limit")
                .and_then(Value::as_u64)
                .unwrap_or(3)
                .min(3) as usize;
            let country = prefs.get("country").and_then(Value::as_str);
            let language = prefs.get("language").and_then(Value::as_str);
            match search_web(
                &key,
                query_text,
                count,
                country,
                language,
                &request_id,
                &requested_at,
                cancel.clone(),
                permit.clone(),
            )
            .await
            {
                Ok(hits) => {
                    for hit in hits {
                        if task.cancel.load(Ordering::Acquire) {
                            break;
                        }
                        if !date_in_range(hit.published_at.as_deref(), &prefs) {
                            continue;
                        }
                        let fetch_request_id = native_id("resource-fetch");
                        let fetch_requested_at = rfc3339_now();
                        let fetched = fetch_source(
                            &hit.url,
                            query_text,
                            &fetch_request_id,
                            &fetch_requested_at,
                            cancel.clone(),
                            permit.clone(),
                        )
                        .await;
                        let (fetched, failure) = match fetched {
                            Ok(value) => (Some(value), None),
                            Err(error) => (None, Some(error)),
                        };
                        let candidate = web_candidate(
                            &task_id,
                            row["lesson_id"].as_str().unwrap_or_default(),
                            &hit,
                            fetched.as_ref(),
                            failure.as_deref(),
                        );
                        add_candidate(&task_id, &task, candidate);
                    }
                }
                Err(error) => add_task_error(&task_id, &task, &query, &error),
            }
        } else if kind == "video" {
            let key = match resource_credential_store().get("youtube_data_api") {
                Ok(Some(value)) if !value.trim().is_empty() => value,
                Ok(_) => {
                    add_task_error(&task_id, &task, &query, &serde_json::json!({"code":"auth_required","message":"请先配置此资源服务的专用 API Key。"}).to_string());
                    update_progress(&task_id, &task, true);
                    continue;
                }
                Err(_) => {
                    add_task_error(&task_id, &task, &query, &serde_json::json!({"code":"keychain_unavailable","message":"无法读取资源服务凭据。"}).to_string());
                    update_progress(&task_id, &task, true);
                    continue;
                }
            };
            let count = prefs
                .get("per_lesson_limit")
                .and_then(Value::as_u64)
                .unwrap_or(5)
                .min(10) as usize;
            let country = prefs.get("country").and_then(Value::as_str);
            let language = prefs.get("language").and_then(Value::as_str);
            let after = prefs.get("published_after").and_then(Value::as_str);
            let before = prefs.get("published_before").and_then(Value::as_str);
            let first = search_videos(
                &key,
                query_text,
                count,
                "target",
                country,
                language,
                after,
                before,
                &request_id,
                &requested_at,
                cancel.clone(),
                permit.clone(),
            )
            .await;
            match first {
                Ok(mut hits) => {
                    if hits.is_empty() && !task.cancel.load(Ordering::Acquire) {
                        match search_videos(
                            &key,
                            query_text,
                            count,
                            "short_fallback",
                            country,
                            language,
                            after,
                            before,
                            &native_id("resource-request"),
                            &rfc3339_now(),
                            cancel.clone(),
                            permit.clone(),
                        )
                        .await
                        {
                            Ok(fallback) => hits.extend(fallback),
                            Err(error) => add_task_error(&task_id, &task, &query, &error),
                        }
                    }
                    for hit in hits {
                        if !date_in_range(hit.published_at.as_deref(), &prefs) {
                            continue;
                        }
                        add_candidate(
                            &task_id,
                            &task,
                            video_candidate(
                                &task_id,
                                row["lesson_id"].as_str().unwrap_or_default(),
                                &hit,
                            ),
                        );
                    }
                }
                Err(error) => add_task_error(&task_id, &task, &query, &error),
            }
        } else {
            add_task_error(
                &task_id,
                &task,
                &query,
                &serde_json::json!({"code":"invalid_input","message":"不支持的资源类型。"})
                    .to_string(),
            );
        }
        update_progress(&task_id, &task, true);
    }
    if let Ok(mut all) = tasks().lock() {
        if let Some(task) = all.get_mut(&task_id) {
            let state = if task.value["state"] == "stale" {
                "stale"
            } else if task.cancel.load(Ordering::Acquire) {
                "cancelled"
            } else if task.value["errors"]
                .as_array()
                .is_some_and(|errors| !errors.is_empty())
            {
                if task.value["candidates"]
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
                {
                    "partial"
                } else {
                    "failed"
                }
            } else {
                "completed"
            };
            task.value["state"] = json!(state);
            task.value["updated_at"] = json!(rfc3339_now());
        }
    }
    let _ = persist_live_task(&task_id);
}

#[tauri::command]
pub(crate) fn resource_discovery_prepare(
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    let input = payload(&request, "resource_discovery_prepare")?;
    let project_dir = project_directory(&input)?;
    let (project, _) = read_project_state(&project_dir)?;
    let plan = build_plan(&project, &input, project_dir.clone())?;
    let value = plan.value.clone();
    {
        let mut plans = plans().lock().map_err(|_| "资源计划锁不可用")?;
        while plans.len() >= MAX_RESOURCE_PLANS {
            if let Some(oldest) = plans.keys().next().cloned() {
                plans.remove(&oldest);
            } else {
                break;
            }
        }
        plans.insert(
            value["plan_id"].as_str().unwrap_or_default().to_owned(),
            plan,
        );
    }
    let project_id = value["project_id"].as_str().unwrap_or_default();
    let warning = match persist_project_state(&project_dir, project_id) {
        Ok(warning) => warning,
        Err(error) => {
            plans()
                .lock()
                .map_err(|_| "资源计划锁不可用")?
                .remove(value["plan_id"].as_str().unwrap_or_default());
            return Err(error);
        }
    };
    let mut response = value;
    if let Some(warning) = warning {
        response["resource_recovery_warning"] = json!(warning);
    }
    Ok(response)
}

#[tauri::command]
pub(crate) async fn resource_discovery_start(
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    let input = payload(&request, "resource_discovery_start")?;
    if input.get("authorized") != Some(&Value::Bool(true)) {
        return Err("explicit_authorization_required: 开始联网前必须由用户明确确认。".into());
    }
    let plan_id = required_string(&input, &["plan_id"], "plan_id")?;
    let project_dir = project_directory(&input)?;
    let (project, _) = read_project_state(&project_dir)?;
    ensure_project_state_loaded(&project_dir, &project)?;
    let plan = plans()
        .lock()
        .map_err(|_| "资源计划锁不可用")?
        .get(&plan_id)
        .cloned()
        .ok_or("plan_missing: 资源计划已过期，请重新准备。")?;
    if plan.project_dir != project_dir {
        return Err("project_path_mismatch: 计划与当前项目路径不匹配。".into());
    }
    if input.get("input_hash").and_then(Value::as_str) != plan.value["input_hash"].as_str() {
        return Err("stale_input: 搜索计划内容已变化，请重新准备。".into());
    }
    if !project_still_matches(&NativeResourceTask {
        plan: plan.clone(),
        value: Value::Null,
        failed_queries: Vec::new(),
        cancel: Arc::new(AtomicBool::new(false)),
    }) {
        return Err("stale_input: 课程已切换或修改，请重新准备资源发现。".into());
    }
    if plan.value["expires_at"].as_str().unwrap_or_default() <= rfc3339_now().as_str() {
        return Err("plan_expired: 资源计划已过期，请重新准备。".into());
    }
    let max_requests = plan.value["budget"]["max_requests"].as_u64().unwrap_or(0);
    let reserved = plan.value["budget"]["required_upper_bound"]
        .as_u64()
        .unwrap_or(0);
    if reserved > max_requests {
        return Err("budget_exhausted: 网络请求预算不足以覆盖所选任务的请求上界。".into());
    }
    let task_id = native_id("resource-task");
    let now = rfc3339_now();
    let value = json!({
        "task_id": task_id,
        "state": "queued",
        "snapshot": plan.value["snapshot"],
        "plan_id": plan_id,
        "progress": { "completed_queries": 0, "total_queries": plan.queries.iter().map(|row| row["queries"].as_array().map(Vec::len).unwrap_or(0)).sum::<usize>() },
        "budget": { "max_requests": max_requests, "reserved_requests": reserved, "completed_requests": 0, "remaining_requests": max_requests },
        "candidates": [],
        "errors": [],
        "created_at": now,
        "updated_at": now,
    });
    let task = NativeResourceTask {
        plan: plan.clone(),
        value: value.clone(),
        failed_queries: Vec::new(),
        cancel: Arc::new(AtomicBool::new(false)),
    };
    {
        let mut tasks = tasks().lock().map_err(|_| "资源任务锁不可用")?;
        while tasks.len() >= MAX_RESOURCE_TASKS {
            if let Some(oldest) = tasks.keys().next().cloned() {
                if tasks.get(&oldest).is_some_and(|task| {
                    !matches!(
                        task.value["state"].as_str(),
                        Some("queued" | "running" | "cancel_requested")
                    )
                }) {
                    tasks.remove(&oldest);
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        tasks.insert(task_id.clone(), task);
    }
    let warning = match persist_project_state(
        &project_dir,
        plan.value["project_id"].as_str().unwrap_or_default(),
    ) {
        Ok(warning) => warning,
        Err(error) => {
            tasks()
                .lock()
                .map_err(|_| "资源任务锁不可用")?
                .remove(&task_id);
            return Err(error);
        }
    };
    let rows = plan
        .queries
        .iter()
        .flat_map(|row| {
            row["queries"]
                .as_array()
                .into_iter()
                .flatten()
                .map(move |query| json!({ "lesson_id": row["lesson_id"], "queries": [query] }))
        })
        .collect::<Vec<_>>();
    tokio::spawn(run_queries(task_id, rows));
    let mut response = value;
    if let Some(warning) = warning {
        response["resource_recovery_warning"] = json!(warning);
    }
    Ok(response)
}

#[tauri::command]
pub(crate) fn resource_discovery_cancel(request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let input = payload(&request, "resource_discovery_cancel")?;
    let task_id = required_string(&input, &["task_id"], "task_id")?;
    let project_dir = hydrate_project_from_input(&input)?;
    let task = {
        let mut all = tasks().lock().map_err(|_| "资源任务锁不可用")?;
        let task = all
            .get_mut(&task_id)
            .filter(|task| task.plan.project_dir == project_dir)
            .ok_or("task_missing: 资源发现任务已不存在。")?;
        if matches!(task.value["state"].as_str(), Some("queued" | "running")) {
            task.value["state"] = json!("cancel_requested");
            task.value["updated_at"] = json!(rfc3339_now());
            task.cancel.store(true, Ordering::Release);
        }
        task.clone()
    };
    let mut response = task.value.clone();
    if let Err(error) = persist_task(&task) {
        response["resource_recovery_warning"] = json!(error);
    }
    Ok(response)
}

#[tauri::command]
pub(crate) async fn resource_discovery_retry(
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    let input = payload(&request, "resource_discovery_retry")?;
    let task_id = required_string(&input, &["task_id"], "task_id")?;
    let project_dir = hydrate_project_from_input(&input)?;
    let candidate_id = input.get("candidate_id").and_then(Value::as_str);
    let rows = {
        let mut all = tasks().lock().map_err(|_| "资源任务锁不可用")?;
        let task = all
            .get_mut(&task_id)
            .filter(|task| task.plan.project_dir == project_dir)
            .ok_or("task_missing: 资源发现任务已不存在。")?;
        if !matches!(
            task.value["state"].as_str(),
            Some("partial" | "failed" | "completed")
        ) {
            return Err("invalid_task_state: 当前任务还不能重试。".into());
        }
        let selected = if let Some(candidate_id) = candidate_id {
            let lesson_id = task.value["candidates"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|candidate| candidate["id"] == candidate_id)
                .and_then(|candidate| candidate["lesson_id"].as_str())
                .unwrap_or_default();
            task.failed_queries
                .iter()
                .filter(|row| row["lesson_id"].as_str() == Some(lesson_id))
                .cloned()
                .collect::<Vec<_>>()
        } else {
            task.failed_queries.clone()
        };
        if selected.is_empty() {
            return Err("no_retryable_work: 没有可重试的失败请求。".into());
        }
        let upper_bound = selected
            .iter()
            .map(|row| {
                row["queries"]
                    .as_array()
                    .and_then(|values| values.first())
                    .and_then(|query| query["request_budget_upper_bound"].as_u64())
                    .unwrap_or(0)
            })
            .sum::<u64>();
        let completed = task.value["budget"]["completed_requests"]
            .as_u64()
            .unwrap_or(0);
        let max = task.value["budget"]["max_requests"].as_u64().unwrap_or(0);
        if completed.saturating_add(upper_bound) > max {
            return Err("budget_exhausted: 剩余预算不足以完成所选重试。".into());
        }
        if let Some(candidate_id) = candidate_id {
            task.value["candidates"]
                .as_array_mut()
                .map(|items| items.retain(|candidate| candidate["id"] != candidate_id));
        }
        task.value["errors"]
            .as_array_mut()
            .map(|items| items.clear());
        task.failed_queries.clear();
        task.value["progress"]["total_queries"] = json!(
            task.value["progress"]["total_queries"]
                .as_u64()
                .unwrap_or(0)
                + selected.len() as u64
        );
        task.value["budget"]["reserved_requests"] = json!(
            task.value["budget"]["reserved_requests"]
                .as_u64()
                .unwrap_or(0)
                + upper_bound
        );
        task.value["state"] = json!("queued");
        task.value["updated_at"] = json!(rfc3339_now());
        task.cancel = Arc::new(AtomicBool::new(false));
        selected
    };
    let task = tasks()
        .lock()
        .map_err(|_| "资源任务锁不可用")?
        .get(&task_id)
        .filter(|task| task.plan.project_dir == project_dir)
        .cloned()
        .ok_or("task_missing")?;
    let warning = match persist_task(&task) {
        Ok(warning) => warning,
        Err(error) => {
            if let Ok(mut all) = tasks().lock() {
                if let Some(live) = all.get_mut(&task_id) {
                    live.cancel.store(true, Ordering::Release);
                    live.cancel = Arc::new(AtomicBool::new(true));
                    live.value["state"] = json!("interrupted");
                    live.value["updated_at"] = json!(rfc3339_now());
                }
            }
            return Err(error);
        }
    };
    tokio::spawn(run_queries(task_id, rows));
    let mut value = task.value.clone();
    if let Some(warning) = warning {
        value["resource_recovery_warning"] = json!(warning);
    }
    Ok(value)
}

#[tauri::command]
pub(crate) fn resource_discovery_plan(request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let input = payload(&request, "resource_discovery_plan")?;
    let plan_id = required_string(&input, &["plan_id"], "plan_id")?;
    let project_dir = hydrate_project_from_input(&input)?;
    Ok(plans()
        .lock()
        .map_err(|_| "资源计划锁不可用")?
        .get(&plan_id)
        .filter(|plan| plan.project_dir == project_dir)
        .map(|plan| plan.value.clone())
        .unwrap_or(Value::Null))
}

#[tauri::command]
pub(crate) fn resource_discovery_get(request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let input = payload(&request, "resource_discovery_get")?;
    resource_discovery_get_input(input)
}

fn resource_discovery_get_input(input: Map<String, Value>) -> Result<Value, String> {
    let task_id = required_string(&input, &["task_id"], "task_id")?;
    let project_dir = project_directory(&input)?;
    let (project, _) = read_project_state(&project_dir)?;
    task_value_for_project(&project_dir, &project, &task_id)
}

fn manual_video_timing_evidence(
    input: &Map<String, Value>,
    candidate: &Value,
    project_id: &str,
    remapped_evidence: &HashMap<String, String>,
    project: &Value,
) -> Result<Option<(f64, f64, Value)>, String> {
    let Some(raw) = input.get("manual_video_timing") else {
        return Ok(None);
    };
    let start = raw["start_sec"].as_f64().filter(|value| value.is_finite());
    let end = raw["end_sec"].as_f64().filter(|value| value.is_finite());
    let (Some(start), Some(end)) = (start, end) else {
        return Err("invalid_input: 人工视频时间必须是有限数值。".into());
    };
    if raw["confirmed"] != Value::Bool(true) {
        return Err("manual_confirmation_required: 请确认已在视频中人工核对片段时间。".into());
    }
    let video = &candidate["video"];
    let video_id = video["provider_video_id"].as_str().unwrap_or_default();
    let url = candidate["url"].as_str().unwrap_or_default();
    let expected_url = format!("https://www.youtube.com/watch?v={video_id}");
    let duration = video["total_duration_sec"]
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0);
    let duration_evidence_id = video["duration_evidence_id"].as_str();
    let candidate_duration_evidence = candidate["source_evidence"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|evidence| {
            duration_evidence_id.is_some_and(|id| evidence["id"].as_str() == Some(id))
        });
    let canonical_duration_id = duration_evidence_id
        .and_then(|id| remapped_evidence.get(id))
        .map(String::as_str);
    let canonical_duration_evidence = canonical_duration_id.and_then(|id| {
        project["source_evidence"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|evidence| evidence["id"].as_str() == Some(id))
    });
    if candidate["medium"] != "video"
        || video["provider_id"] != "youtube_data_api"
        || video_id.len() != 11
        || !video_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        || url != expected_url
        || duration.is_none()
        || start < 0.0
        || start >= end
        || end > duration.unwrap_or_default()
        || candidate_duration_evidence.is_none_or(|evidence| {
            evidence["provider_id"] != "youtube_data_api"
                || evidence["url"].as_str() != Some(url)
                || evidence["evidence_access"] != "metadata_only"
        })
        || canonical_duration_evidence.is_none_or(|evidence| {
            evidence["provider_id"] != "youtube_data_api"
                || evidence["url"].as_str() != Some(url)
                || evidence["evidence_access"] != "metadata_only"
        })
    {
        return Err("timing_evidence_required: 无法用有效的视频来源与时长元数据验证片段。".into());
    }
    let evidence_id = native_id("manual-video-timing");
    let evidence = json!({
        "id": evidence_id,
        "project_id": project_id,
        "provider_id": "youtube_data_api",
        "request_id": native_id("manual-timing-request"),
        "url": url,
        "title": format!("人工确认视频片段 {start}–{end} 秒"),
        "publisher": candidate["publisher"],
        "event_date": null,
        "published_at": candidate["published_at"],
        "fetched_at": rfc3339_now(),
        "locator": { "start_sec": start, "end_sec": end },
        "excerpt": null,
        "evidence_access": "metadata_only",
        "fact_check": "unchecked",
        "content_hash": null,
        "limitations": ["用户人工查看并记录了片段时间；未校验字幕或文字稿。"],
        "evidence_method": "manual_video_timing",
        "confirmed_by_user": true,
    });
    Ok(Some((start, end, evidence)))
}

fn video_selection_conflicts_with_manual_timing(
    selection: &Value,
    start: f64,
    end: f64,
    candidate: &Value,
    project: &Value,
) -> bool {
    if selection["mode"] != "clip"
        || selection["start_sec"].as_f64() != Some(start)
        || selection["end_sec"].as_f64() != Some(end)
    {
        return true;
    }
    let Some(timing_id) = selection["timing_evidence_id"].as_str() else {
        return !selection["timing_evidence_id"].is_null();
    };
    let url = candidate["url"].as_str();
    project["source_evidence"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|evidence| evidence["id"].as_str() == Some(timing_id))
        .is_none_or(|evidence| {
            evidence["provider_id"] != candidate["video"]["provider_id"]
                || evidence["url"].as_str() != url
                || evidence["locator"]["start_sec"].as_f64() != Some(start)
                || evidence["locator"]["end_sec"].as_f64() != Some(end)
        })
}

#[tauri::command]
pub(crate) fn resource_candidate_accept(request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let input = payload(&request, "resource_candidate_accept")?;
    resource_candidate_accept_input(input)
}

fn resource_candidate_accept_input(input: Map<String, Value>) -> Result<Value, String> {
    let task_id = required_string(&input, &["task_id"], "task_id")?;
    let candidate_id = required_string(&input, &["candidate_id"], "candidate_id")?;
    let lesson_id = required_string(&input, &["lesson_id"], "lesson_id")?;
    let project_dir = project_directory(&input)?;
    let (mut project, current_fingerprint) = read_project_state(&project_dir)?;
    ensure_project_state_loaded(&project_dir, &project)?;
    let project_id = project_id_of(&project)?;
    let binding = parse_canonical_mutation_binding(&input)?
        .ok_or("invalid_mutation_binding: 变更请求需要完整的项目、租约和编辑代次绑定。")?;
    if binding.expected_project_id != project_id {
        return Err("project_id_mismatch: 请求与当前项目身份不匹配。".into());
    }
    let active_generation = verify_lease_generation(&project_dir, Some(&binding.lease_generation))?;
    validate_canonical_mutation_binding(
        Some(&binding),
        &project,
        &current_fingerprint,
        &active_generation,
    )?;
    let task = tasks()
        .lock()
        .map_err(|_| "资源任务锁不可用")?
        .get(&task_id)
        .filter(|task| task.plan.project_dir == project_dir)
        .cloned()
        .ok_or("task_missing: 资源发现任务已不存在。")?;
    let candidate = task.value["candidates"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == candidate_id))
        .cloned()
        .ok_or("candidate_missing: 候选已不存在，请重新搜索。")?;
    if !task.plan.value["content_item_ids"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(lesson_id.as_str())))
    {
        return Err("invalid_lesson: 目标课次不属于本次任务。".into());
    }
    validate_task_for_accept(&task, &project, true)?;
    let lesson = project["content_items"]
        .as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item["id"].as_str() == Some(lesson_id.as_str()) && item["archived"] != true
            })
        })
        .cloned()
        .ok_or("stale_input: 目标课次已不存在。")?;
    let action = required_string(&input, &["action"], "action")?;
    if !matches!(action.as_str(), "keep" | "insert_citation") {
        return Err("invalid_input: 不支持的资源接受操作。".into());
    }
    let teaching_use = normalized_text(input.get("teaching_use").unwrap_or(&Value::Null));
    if teaching_use.is_empty() || teaching_use.chars().count() > 2_000 {
        return Err("invalid_input: 教学用法不能为空且不超过 2000 个字符。".into());
    }
    let questions = input
        .get("discussion_questions")
        .and_then(Value::as_array)
        .ok_or("invalid_input: discussion_questions 必须是数组。")?;
    if questions.len() > 20 {
        return Err("invalid_input: 讨论题最多 20 条。".into());
    }
    let discussion_questions = questions
        .iter()
        .map(normalized_text)
        .filter(|value| !value.is_empty())
        .map(|value| Value::String(value.chars().take(2_000).collect()))
        .collect::<Vec<_>>();

    let explicit_resource = input.get("existing_resource_id").and_then(Value::as_str);
    let merge_confirmed = input.get("merge_confirmed");
    if merge_confirmed.is_some_and(|value| !value.is_boolean()) {
        return Err("invalid_input: merge_confirmed 必须是布尔值。".into());
    }
    if explicit_resource.is_some() != (merge_confirmed == Some(&Value::Bool(true))) {
        return Err("merge_confirmation_required: 选择合并目标并确认后才能合并来源。".into());
    }
    let bound_resource = candidate["accepted_resource_id"].as_str();
    if bound_resource
        .is_some_and(|bound| explicit_resource.is_some_and(|selected| selected != bound))
    {
        return Err("invalid_resource_merge: 此候选已绑定到另一资源，不能重新绑定。".into());
    }
    let mut resource_index = None;
    if let Some(resource_id) = bound_resource.or(explicit_resource) {
        resource_index = project["resource_items"].as_array().and_then(|items| {
            items
                .iter()
                .position(|item| item["id"].as_str() == Some(resource_id))
        });
        if resource_index.is_none() {
            return Err("invalid_resource_merge: 合并目标不属于当前项目。".into());
        }
    }
    if resource_index.is_none() {
        if let Some(video_id) = candidate["video"]["provider_video_id"].as_str() {
            let provider_id = candidate["video"]["provider_id"].as_str();
            resource_index = project["resource_items"].as_array().and_then(|items| {
                items.iter().position(|item| {
                    item["medium"] == candidate["medium"]
                        && item["video"]["provider_id"].as_str() == provider_id
                        && item["video"]["provider_video_id"].as_str() == Some(video_id)
                })
            });
        }
    }
    if resource_index.is_none() {
        if let Some(url) = candidate["url"].as_str() {
            let canonical = canonical_url(url);
            let matching_evidence = project["source_evidence"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| {
                    item["url"]
                        .as_str()
                        .is_some_and(|value| canonical_url(value) == canonical)
                })
                .filter_map(|item| item["id"].as_str())
                .collect::<HashSet<_>>();
            resource_index = project["resource_items"].as_array().and_then(|items| {
                items.iter().position(|item| {
                    item["medium"] == candidate["medium"]
                        && item["source_ids"].as_array().is_some_and(|ids| {
                            ids.iter().any(|id| {
                                id.as_str().is_some_and(|id| matching_evidence.contains(id))
                            })
                        })
                })
            });
        }
    }
    if let Some(index) = resource_index {
        let resource = &project["resource_items"][index];
        if resource["medium"] != candidate["medium"] {
            return Err("invalid_resource_merge: 只能将同类素材的来源合并到一起。".into());
        }
        if resource["video"].is_object()
            && candidate["video"].is_object()
            && (resource["video"]["provider_id"] != candidate["video"]["provider_id"]
                || resource["video"]["provider_video_id"]
                    != candidate["video"]["provider_video_id"])
        {
            return Err(
                "invalid_resource_merge: 该视频资源已绑定到另一条视频，请保留为独立资源。".into(),
            );
        }
    }

    let candidate_evidence = candidate["source_evidence"]
        .as_array()
        .cloned()
        .ok_or("invalid_candidate: 候选缺少来源证据。")?;
    let mut remapped_evidence = HashMap::new();
    let mut fresh_evidence = Vec::new();
    for mut evidence in candidate_evidence {
        let original_id = evidence["id"].as_str().unwrap_or_default().to_owned();
        let existing_id = project["source_evidence"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|existing| {
                existing["provider_id"] == evidence["provider_id"]
                    && existing["request_id"] == evidence["request_id"]
                    && existing["url"] == evidence["url"]
            })
            .and_then(|existing| existing["id"].as_str())
            .map(str::to_owned);
        if let Some(existing_id) = existing_id {
            remapped_evidence.insert(original_id, existing_id);
            continue;
        }
        let id_collision = project["source_evidence"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|existing| existing["id"].as_str() == Some(original_id.as_str()));
        let evidence_id = if original_id.is_empty() || id_collision {
            native_id("evidence")
        } else {
            original_id.clone()
        };
        evidence["id"] = json!(evidence_id);
        evidence["project_id"] = json!(project_id);
        remapped_evidence.insert(original_id, evidence_id);
        fresh_evidence.push(evidence);
    }
    if !project["source_evidence"].is_array() {
        project["source_evidence"] = json!([]);
    }
    project["source_evidence"]
        .as_array_mut()
        .unwrap()
        .extend(fresh_evidence);
    let mut source_ids = Vec::new();
    let mut seen_source_ids = HashSet::new();
    for id in candidate["source_evidence"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|evidence| evidence["id"].as_str())
        .filter_map(|id| remapped_evidence.get(id))
    {
        if seen_source_ids.insert(id.clone()) {
            source_ids.push(id.clone());
        }
    }
    let mut claims = candidate["claims"].as_array().cloned().unwrap_or_default();
    for claim in &mut claims {
        if let Some(ids) = claim["evidence_ids"].as_array_mut() {
            for evidence_id in ids.iter_mut() {
                if let Some(replacement) = evidence_id
                    .as_str()
                    .and_then(|id| remapped_evidence.get(id))
                    .cloned()
                {
                    *evidence_id = json!(replacement);
                }
            }
            ids.retain(|evidence_id| {
                evidence_id.as_str().is_some_and(|id| {
                    project["source_evidence"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|source| source["id"].as_str() == Some(id))
                })
            });
        }
    }
    let mut candidate_video = candidate["video"].clone();
    if let Some(original_id) = candidate_video["duration_evidence_id"].as_str() {
        let replacement = remapped_evidence
            .get(original_id)
            .cloned()
            .ok_or("invalid_candidate: 视频时长缺少对应来源证据。")?;
        candidate_video["duration_evidence_id"] = json!(replacement);
    }

    if !project["resource_items"].is_array() {
        project["resource_items"] = json!([]);
    }
    let timestamp = rfc3339_now();
    if resource_index.is_none() {
        let resource_id = native_id("resource");
        let mut resource = json!({
            "contract_version": 1,
            "id": resource_id,
            "project_id": project_id,
            "medium": candidate["medium"],
            "title": candidate["title"],
            "source_ids": source_ids,
            "factual_summary": candidate["factual_summary"],
            "claims": claims,
            "revision": 1,
            "created_at": timestamp,
            "updated_at": timestamp,
        });
        if candidate["narrative_case_type"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
        {
            resource["narrative_case_type"] = candidate["narrative_case_type"].clone();
        }
        if candidate_video.is_object() {
            resource["video"] = candidate_video.clone();
        }
        project["resource_items"]
            .as_array_mut()
            .unwrap()
            .push(resource);
        resource_index = Some(project["resource_items"].as_array().unwrap().len() - 1);
    } else {
        let resource =
            &mut project["resource_items"].as_array_mut().unwrap()[resource_index.unwrap()];
        if !resource["source_ids"].is_array() {
            resource["source_ids"] = json!([]);
        }
        let mut additions = 0_u64;
        for evidence_id in source_ids {
            if !resource["source_ids"]
                .as_array()
                .unwrap()
                .iter()
                .any(|existing| existing.as_str() == Some(evidence_id.as_str()))
            {
                resource["source_ids"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(evidence_id));
                additions += 1;
            }
        }
        if !resource["claims"].is_array() {
            resource["claims"] = json!([]);
        }
        for claim in claims {
            if !resource["claims"].as_array().unwrap().contains(&claim) {
                resource["claims"].as_array_mut().unwrap().push(claim);
            }
        }
        if !resource.get("video").is_some_and(Value::is_object) && candidate_video.is_object() {
            resource["video"] = candidate_video.clone();
        } else if resource["video"]["total_duration_sec"].is_null()
            && candidate_video["total_duration_sec"].is_number()
        {
            resource["video"] = candidate_video.clone();
        }
        if resource["factual_summary"]
            .as_str()
            .unwrap_or_default()
            .is_empty()
            && !candidate["factual_summary"]
                .as_str()
                .unwrap_or_default()
                .is_empty()
        {
            resource["factual_summary"] = candidate["factual_summary"].clone();
        }
        if additions > 0 {
            resource["revision"] = json!(resource["revision"].as_u64().unwrap_or(1) + 1);
        }
        resource["updated_at"] = json!(timestamp);
    }
    let mut resource =
        project["resource_items"].as_array().unwrap()[resource_index.unwrap()].clone();
    let resource_id = resource["id"].as_str().unwrap_or_default().to_owned();
    let existing_usage = project["resource_usages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|usage| {
            usage["resource_id"].as_str() == Some(resource_id.as_str())
                && usage["lesson_id"].as_str() == Some(lesson_id.as_str())
                && if action == "insert_citation" {
                    !usage["block_id"].is_null()
                } else {
                    usage["block_id"].is_null()
                }
        })
        .cloned();
    let manual_timing = manual_video_timing_evidence(
        &input,
        &candidate,
        &project_id,
        &remapped_evidence,
        &project,
    )?;
    let supplied_selection = input.get("video_selection");
    if let (Some(selection), Some((start, end, _))) = (supplied_selection, manual_timing.as_ref()) {
        if video_selection_conflicts_with_manual_timing(
            selection, *start, *end, &candidate, &project,
        ) {
            return Err("invalid_video_selection: 人工记录的时间与其他片段选择冲突。".into());
        }
    }
    let mut video_selection = supplied_selection.cloned();
    if let Some((start, end, timing_evidence)) = manual_timing {
        if let Some(existing) = existing_usage.as_ref() {
            let old_selection = &existing["video_selection"];
            let old_timing = old_selection["timing_evidence_id"].as_str().and_then(|id| {
                project["source_evidence"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|evidence| evidence["id"].as_str() == Some(id))
            });
            if old_selection["mode"] != "clip"
                || old_selection["start_sec"].as_f64() != Some(start)
                || old_selection["end_sec"].as_f64() != Some(end)
                || old_timing.is_none_or(|evidence| {
                    evidence["evidence_method"] != "manual_video_timing"
                        || evidence["confirmed_by_user"] != true
                })
            {
                return Err(
                    "usage_conflict: 该课次已保存另一种视频选择，不能用不同片段覆盖。".into(),
                );
            }
            video_selection = Some(old_selection.clone());
        } else {
            let evidence_id = timing_evidence["id"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            project["source_evidence"]
                .as_array_mut()
                .ok_or("invalid_project: source_evidence 必须是数组。")?
                .push(timing_evidence);
            let row =
                &mut project["resource_items"].as_array_mut().unwrap()[resource_index.unwrap()];
            if !row["source_ids"].is_array() {
                row["source_ids"] = json!([]);
            }
            if !row["source_ids"]
                .as_array()
                .unwrap()
                .iter()
                .any(|id| id.as_str() == Some(evidence_id.as_str()))
            {
                row["source_ids"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(evidence_id));
                row["revision"] = json!(row["revision"].as_u64().unwrap_or(1) + 1);
            }
            row["updated_at"] = json!(rfc3339_now());
            resource = row.clone();
            video_selection = Some(json!({
                "mode": "clip",
                "start_sec": start,
                "end_sec": end,
                "timing_evidence_id": evidence_id,
            }));
        }
    }
    if candidate["medium"] == "video" {
        if let Some(selection) = video_selection.as_ref().filter(|value| value.is_object()) {
            if selection["mode"] == "clip" {
                let start = selection["start_sec"]
                    .as_f64()
                    .filter(|value| value.is_finite());
                let end = selection["end_sec"]
                    .as_f64()
                    .filter(|value| value.is_finite());
                let total = resource["video"]["total_duration_sec"]
                    .as_f64()
                    .filter(|value| value.is_finite() && *value > 0.0);
                let timing = selection["timing_evidence_id"].as_str().and_then(|id| {
                    project["source_evidence"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|evidence| evidence["id"].as_str() == Some(id))
                });
                let is_manual = timing.is_some_and(|evidence| {
                    evidence["evidence_method"] == "manual_video_timing"
                        && evidence["confirmed_by_user"] == true
                        && evidence["evidence_access"] == "metadata_only"
                        && evidence["locator"]["start_sec"].as_f64() == start
                        && evidence["locator"]["end_sec"].as_f64() == end
                });
                let is_transcript = timing.is_some_and(|evidence| {
                    evidence["evidence_access"] == "timed_transcript"
                        && evidence["locator"]["start_sec"].as_f64().is_some()
                        && evidence["locator"]["end_sec"].as_f64().is_some()
                });
                if (!is_manual && !is_transcript)
                    || start.is_none_or(|start| start < 0.0)
                    || end.is_none_or(|end| start.unwrap_or(0.0) >= end)
                    || total.is_none_or(|total| end.unwrap_or(f64::INFINITY) > total)
                {
                    return Err("timing_evidence_required: 没有可核验的时间证据或视频总时长，无法保存片段建议。".into());
                }
            }
        }
    }
    let mut block_id = existing_usage
        .as_ref()
        .and_then(|usage| usage["block_id"].as_str())
        .map(str::to_owned);
    if action == "insert_citation" && existing_usage.is_none() {
        let document_id = lesson["document_id"]
            .as_str()
            .ok_or("invalid_lesson: 课次正文不存在。")?;
        let blocks = project["blocks"]
            .as_array()
            .ok_or("invalid_project: blocks 必须是数组。")?;
        let target_index = if let Some(target_id) = input.get("block_id").and_then(Value::as_str) {
            let target = blocks
                .iter()
                .find(|block| block["id"].as_str() == Some(target_id))
                .ok_or("invalid_block: 引用目标正文区块不存在。")?;
            if target["document_id"].as_str() != Some(document_id) {
                return Err("invalid_block: 引用目标正文区块不属于所选课次。".into());
            }
            target["order_index"].as_u64().unwrap_or(0) as usize + 1
        } else {
            blocks
                .iter()
                .filter(|block| block["document_id"].as_str() == Some(document_id))
                .count()
        };
        let title = candidate["title"].as_str().unwrap_or("资源引用");
        let url = candidate["url"].as_str().unwrap_or_default();
        let content = format!("引用：{title}\n{url}");
        let new_id = native_id("block");
        let updated = rfc3339_now();
        for block in project["blocks"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .filter(|block| block["document_id"].as_str() == Some(document_id))
        {
            if block["order_index"].as_u64().unwrap_or(0) as usize >= target_index {
                block["order_index"] = json!(block["order_index"].as_u64().unwrap_or(0) + 1);
                block["updated_at"] = json!(updated);
            }
        }
        project["blocks"].as_array_mut().unwrap().push(json!({
            "id": new_id,
            "document_id": document_id,
            "parent_block_id": null,
            "type": "paragraph",
            "order_index": target_index,
            "content": content,
            "settings": { "resource_id": resource_id },
            "created_at": updated,
            "updated_at": updated,
        }));
        if let Some(document) = project["documents"].as_array_mut().and_then(|docs| {
            docs.iter_mut()
                .find(|document| document["id"].as_str() == Some(document_id))
        }) {
            document["updated_at"] = json!(updated);
        }
        if let Some(lesson) = project["content_items"].as_array_mut().and_then(|items| {
            items
                .iter_mut()
                .find(|item| item["id"].as_str() == Some(lesson_id.as_str()))
        }) {
            lesson["updated_at"] = json!(updated);
        }
        block_id = Some(new_id);
    }
    if !project["resource_usages"].is_array() {
        project["resource_usages"] = json!([]);
    }
    let usage = existing_usage.unwrap_or_else(|| {
        let mut usage = json!({
            "contract_version": 1,
            "id": native_id("resource-usage"),
            "project_id": project_id,
            "resource_id": resource_id,
            "lesson_id": lesson_id,
            "block_id": block_id,
            "teaching_use": teaching_use,
            "discussion_questions": discussion_questions,
            "created_at": rfc3339_now(),
        });
        if let Some(selection) = video_selection {
            usage["video_selection"] = selection;
        }
        usage
    });
    if !project["resource_usages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|existing| existing["id"] == usage["id"])
    {
        project["resource_usages"]
            .as_array_mut()
            .unwrap()
            .push(usage.clone());
    }
    project["project"]["updated_at"] = json!(rfc3339_now());
    let evidence_ids = resource["source_ids"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let evidence = project["source_evidence"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| evidence_ids.iter().any(|id| id == &item["id"]))
        .cloned()
        .collect::<Vec<_>>();
    let result = json!({ "resource": resource, "evidence": evidence, "usage": usage, "block_id": block_id, "candidate_id": candidate_id });
    let saved = project_save(
        project_dir.to_string_lossy().into_owned(),
        binding.expected_fingerprint.clone(),
        None,
        project.clone(),
        Some(binding.expected_project_id.clone()),
        Some(binding.lease_generation.clone()),
        Some(binding.editor_generation),
        Some(binding.operation_id.clone()),
        Some(binding.revision),
        None,
    )?;
    let fingerprint = serde_json::from_value::<FileFingerprint>(saved["fingerprint"].clone())
        .map_err(|error| format!("canonical mutation ack fingerprint invalid: {error}"))?;
    let outcome = saved["outcome"].as_str().unwrap_or("written");
    let durability_warning = saved["durability_warning"].as_str();
    let recovery_warning = saved["recovery_warning"].as_str();
    let ack = canonical_mutation_ack(
        Some(&binding),
        &project,
        &fingerprint,
        &project_dir,
        &active_generation,
        outcome,
        durability_warning,
        recovery_warning,
    );
    let updated_task = if let Ok(mut all) = tasks().lock() {
        if let Some(task) = all.get_mut(&task_id) {
            if let Some(candidate) = task.value["candidates"]
                .as_array_mut()
                .and_then(|items| items.iter_mut().find(|item| item["id"] == candidate_id))
            {
                candidate["status"] = json!("accepted");
                candidate["accepted_resource_id"] = json!(resource_id);
            }
            task.value["updated_at"] = json!(rfc3339_now());
            Some(task.clone())
        } else {
            None
        }
    } else {
        None
    };
    let mut response = json!({ "value": result, "mutation_ack": ack });
    if let Some(updated_task) = updated_task {
        match persist_task(&updated_task) {
            Ok(Some(warning)) => response["resource_recovery_warning"] = json!(warning),
            Err(error) => response["resource_recovery_warning"] = json!(error),
            Ok(None) => {}
        }
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_task() -> NativeResourceTask {
        NativeResourceTask {
            plan: NativeResourcePlan {
                project_dir: PathBuf::new(),
                lease_generation: "test-lease".into(),
                value: json!({
                    "project_id": "test-project",
                    "preferences": {},
                    "snapshot": { "lesson_revisions": {} }
                }),
                queries: Vec::new(),
            },
            value: json!({
                "state": "running",
                "candidates": [],
                "errors": [],
                "updated_at": ""
            }),
            failed_queries: Vec::new(),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    fn test_candidate() -> Value {
        json!({
            "id": "candidate-test",
            "url": "https://example.test/case",
            "source_evidence": [{
                "provider_id": "brave_search",
                "request_id": "request-test",
                "url": "https://example.test/case"
            }]
        })
    }

    #[test]
    fn native_reopen_get_and_accept_commit_candidate_with_fresh_binding() {
        let project_dir = std::env::temp_dir().join(format!(
            "workbench-resource-reopen-{}-{}",
            std::process::id(),
            native_id("test")
        ));
        fs::create_dir_all(&project_dir).expect("temporary project directory");
        let project_id = native_id("project");
        let project = json!({
            "schema_version": "1.1.0",
            "project": { "id": project_id, "title": "Resource reopen", "schema_version": "1.1.0" },
            "content_items": [{
                "id": "lesson-1",
                "type": "lesson",
                "document_id": "document-1",
                "title": "Stable lesson",
                "description": "Original source context",
                "updated_at": "2026-10-21T00:00:00Z"
            }],
            "documents": [{ "id": "document-1", "updated_at": "2026-10-21T00:00:00Z" }],
            "blocks": [],
            "assets": [],
            "asset_usages": [],
            "resource_usages": [],
            "resource_items": [],
            "source_evidence": [],
            "style_profiles": [],
            "presentation_documents": [],
            "slide_plans": []
        });
        let project_dir_string = project_dir.to_string_lossy().into_owned();
        project_create(project_dir_string.clone(), project.clone())
            .expect("create canonical temporary project");
        let old_lease = active_lease_generation(&project_dir).expect("initial writer lease");
        let (context, _) = build_context(&project, "lesson-1").expect("lesson snapshot");
        let plan_value = json!({
            "plan_id": "plan-reopen",
            "project_id": project_id,
            "snapshot": { "project_id": project_id, "lesson_revisions": { "lesson-1": context["revision"] } },
            "content_item_ids": ["lesson-1"],
            "queries": []
        });
        let plan = NativeResourcePlan {
            project_dir: project_dir.clone(),
            lease_generation: old_lease.clone(),
            value: plan_value.clone(),
            queries: Vec::new(),
        };
        let task_id = native_id("task-reopen");
        let candidate_id = native_id("candidate-reopen");
        let candidate_url = "https://example.org/reviewed-case";
        let candidate_evidence_id = native_id("evidence-reopen");
        let task = NativeResourceTask {
            plan: plan.clone(),
            value: json!({
                "task_id": task_id,
                "plan_id": plan_value["plan_id"],
                "state": "running",
                "snapshot": plan_value["snapshot"],
                "candidates": [{
                    "id": candidate_id,
                    "task_id": task_id,
                    "lesson_id": "lesson-1",
                    "medium": "text",
                    "narrative_case_type": null,
                    "title": "Reviewed case",
                    "event_subject": null,
                    "event_date": null,
                    "published_at": null,
                    "publisher": "Example",
                    "url": candidate_url,
                    "fetched_at": "2026-10-21T00:00:00Z",
                    "factual_summary": "Observed public case details.",
                    "claims": [],
                    "source_evidence": [{
                        "id": candidate_evidence_id,
                        "provider_id": "brave_search",
                        "request_id": "request-reopen",
                        "requested_at": "2026-10-21T00:00:00Z",
                        "fetched_at": "2026-10-21T00:00:00Z",
                        "url": candidate_url,
                        "transport": "live",
                        "evidence_access": "metadata_only",
                        "locator": null,
                        "metadata": { "title": "Reviewed case" }
                    }],
                    "video": null,
                    "status": "pending",
                    "limitations": []
                }],
                "errors": [],
                "budget": { "max_requests": 1, "reserved_requests": 1, "completed_requests": 1, "remaining_requests": 0 },
                "progress": { "completed_queries": 0, "total_queries": 1 },
                "created_at": "2026-10-21T00:00:00Z",
                "updated_at": "2026-10-21T00:00:00Z"
            }),
            failed_queries: Vec::new(),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        plans().lock().unwrap().insert("plan-reopen".into(), plan);
        tasks()
            .lock()
            .unwrap()
            .insert(task_id.clone(), task.clone());
        persist_project_state(&project_dir, &project_id).expect("write bounded receipt");
        project_close(project_dir_string.clone()).expect("close before simulated restart");
        plans().lock().unwrap().remove("plan-reopen");
        tasks().lock().unwrap().remove(&task_id);

        let open_state = project_open_state(project_dir_string.clone())
            .expect("production project open route")
            .expect("reopened canonical project");
        assert_ne!(open_state["lease_generation"], old_lease);
        let get_input = serde_json::from_value::<Map<String, Value>>(json!({
            "project_dir": project_dir_string,
            "task_id": task_id
        }))
        .unwrap();
        let reopened =
            resource_discovery_get_input(get_input).expect("production resource get inner");
        assert_eq!(reopened["state"], "interrupted");
        let restored = tasks().lock().unwrap().get(&task_id).unwrap().clone();
        let old_worker = task.clone();
        add_candidate_with_check(&task_id, &old_worker, test_candidate(), || {
            panic!("a worker from before open must not reread current inputs")
        });
        assert_eq!(
            tasks().lock().unwrap().get(&task_id).unwrap().value["candidates"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let mut changed = open_state["project"].clone();
        changed["content_items"][0]["title"] = json!("Changed source");
        changed["content_items"][0]["updated_at"] = json!("2026-10-21T00:01:00Z");
        assert!(validate_task_for_accept(&restored, &changed, true).is_err());

        let current_fingerprint = open_state["fingerprint"].clone();
        let current_lease = open_state["lease_generation"].as_str().unwrap();
        let accept_input = serde_json::from_value::<Map<String, Value>>(json!({
            "project_dir": project_dir.to_string_lossy(),
            "task_id": task_id,
            "candidate_id": candidate_id,
            "lesson_id": "lesson-1",
            "action": "keep",
            "teaching_use": "课堂案例讨论",
            "discussion_questions": [],
            "expected_project_id": project_id,
            "expected_fingerprint": current_fingerprint,
            "lease_generation": current_lease,
            "editor_generation": 1,
            "operation_id": native_id("resource-accept"),
            "revision": 1
        }))
        .unwrap();
        let accepted = resource_candidate_accept_input(accept_input)
            .expect("production accept inner commits after reopen");
        assert_eq!(accepted["value"]["usage"]["lesson_id"], "lesson-1");
        let (committed, _) = read_project_state(&project_dir).expect("canonical after accept");
        assert_eq!(committed["resource_items"].as_array().unwrap().len(), 1);
        assert_eq!(committed["resource_usages"].as_array().unwrap().len(), 1);
        assert_eq!(committed["source_evidence"].as_array().unwrap().len(), 1);
        assert_eq!(
            committed["resource_items"][0]["source_ids"][0],
            candidate_evidence_id
        );
        assert_eq!(
            tasks().lock().unwrap().get(&task_id).unwrap().value["candidates"][0]["status"],
            "accepted"
        );
        let old_binding_input = serde_json::from_value::<Map<String, Value>>(json!({
            "project_dir": project_dir.to_string_lossy(),
            "task_id": task_id,
            "candidate_id": candidate_id,
            "lesson_id": "lesson-1",
            "action": "keep",
            "teaching_use": "课堂案例讨论",
            "discussion_questions": [],
            "expected_project_id": project_id,
            "expected_fingerprint": current_fingerprint,
            "lease_generation": old_lease,
            "editor_generation": 1,
            "operation_id": native_id("resource-accept-stale"),
            "revision": 2
        }))
        .unwrap();
        assert!(resource_candidate_accept_input(old_binding_input).is_err());

        project_close(project_dir_string.clone()).expect("close accepted project");
        let reopened_again = project_open_state(project_dir_string.clone())
            .expect("reopen committed project")
            .expect("reopened committed state");
        assert_eq!(
            reopened_again["project"]["resource_usages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let get_input = serde_json::from_value::<Map<String, Value>>(json!({
            "project_dir": project_dir_string,
            "task_id": task_id
        }))
        .unwrap();
        let accepted_task = resource_discovery_get_input(get_input).unwrap();
        assert_eq!(accepted_task["candidates"][0]["status"], "accepted");
        let receipt = fs::read(project_dir.join(RESOURCE_STATE_PATH)).unwrap();
        assert!(receipt.len() <= RESOURCE_STATE_MAX_BYTES);
        assert!(!String::from_utf8_lossy(&receipt).contains("api_key"));
        tasks().lock().unwrap().remove(&task_id);
        plans().lock().unwrap().remove("plan-reopen");
        project_close(project_dir_string).expect("final close");
        let _ = fs::remove_dir_all(project_dir);
    }

    #[test]
    fn delayed_results_cannot_mutate_cancelled_stale_or_retried_tasks() {
        let task_id = native_id("resource-workflow-test");
        let task = test_task();
        tasks()
            .lock()
            .expect("task map lock")
            .insert(task_id.clone(), task.clone());
        let expected = task.clone();
        let delayed_id = task_id.clone();
        let (release, delayed) = std::sync::mpsc::channel::<()>();
        let worker = std::thread::spawn(move || {
            delayed.recv().expect("delayed provider response release");
            add_candidate_with_check(&delayed_id, &expected, test_candidate(), || true);
            add_task_error_with_check(
                &delayed_id,
                &expected,
                &json!({ "query": "late query" }),
                "late provider failure",
                || true,
            );
        });
        {
            let mut all = tasks().lock().expect("task map lock");
            let live = all.get_mut(&task_id).expect("live task");
            live.value["state"] = json!("cancel_requested");
            live.cancel.store(true, Ordering::Release);
        }
        release.send(()).expect("release delayed response");
        worker.join().expect("delayed response worker");
        {
            let mut all = tasks().lock().expect("task map lock");
            let live = all.get_mut(&task_id).expect("live task");
            assert_eq!(live.value["state"], "cancel_requested");
            assert!(live.value["candidates"].as_array().unwrap().is_empty());
            assert!(live.value["errors"].as_array().unwrap().is_empty());
            live.value["state"] = json!("running");
            live.cancel = Arc::new(AtomicBool::new(false));
        }
        add_candidate_with_check(&task_id, &task, test_candidate(), || {
            panic!("a response from an earlier retry must fail before snapshot access")
        });
        {
            let mut all = tasks().lock().expect("task map lock");
            let live = all.get_mut(&task_id).expect("live task");
            assert!(live.value["candidates"].as_array().unwrap().is_empty());
        }
        tasks().lock().expect("task map lock").remove(&task_id);

        let stale_id = native_id("resource-workflow-stale-test");
        let stale_task = test_task();
        tasks()
            .lock()
            .expect("task map lock")
            .insert(stale_id.clone(), stale_task.clone());
        add_candidate_with_check(&stale_id, &stale_task, test_candidate(), || false);
        let all = tasks().lock().expect("task map lock");
        let live = all.get(&stale_id).expect("live stale task");
        assert_eq!(live.value["state"], "stale");
        assert!(live.value["candidates"].as_array().unwrap().is_empty());
        drop(all);
        tasks().lock().expect("task map lock").remove(&stale_id);
    }
}
