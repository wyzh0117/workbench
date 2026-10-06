//! §4 — Application-level Project Registry.
//!
//! The registry is **app-local, rebuildable convenience state**. It is not
//! Canonical and must never become a second copy of a course: the only thing it
//! knows about a project is *which id lives at which path, under which title,
//! when it was last opened* (plus the optional reader hint). Course bodies,
//! API keys, AI tokens and any copy of `project.json` are deliberately outside
//! the record shape: every row is rebuilt field by field from the named inputs
//! below, unknown keys in an existing file are dropped rather than echoed, and
//! each command first runs the same `reject_sensitive` gate the project writer
//! uses, so a credential-shaped key is refused outright.
//!
//! `project.id` (src/domain/types.ts, `Project.id`) is the permanent identity.
//! This module never mints an id and never renews one on migration; it only
//! compares what is on disk with what it stored.

use crate::{
    app_local_path, atomic_write_path, inspect_project_directory, reject_sensitive, reject_symlink,
    rfc3339_now,
};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Same `.workspace` scheme the AI store and `session.json` already use.
pub const REGISTRY_RELATIVE_PATH: &str = ".workspace/projects.json";
const REGISTRY_LABEL: &str = "项目登记表";
/// Rows kept in the file: the most recent wins, older ones fall off the tail.
const REGISTRY_LIMIT: usize = 200;
/// File format marker (not a record field).
const REGISTRY_VERSION: i64 = 1;
/// Longest accepted title / path; a registry is not a place for arbitrary blobs.
const TITLE_LIMIT: usize = 200;
const PATH_LIMIT: usize = 4096;

/// The exact persisted field set from §4.1. Nothing else is ever written, and a
/// damaged file's extra keys are dropped rather than echoed back.
const RECORD_FIELDS: [&str; 5] = [
    "project_id",
    "project_path",
    "project_title",
    "last_opened_at",
    "last_content_item_id",
];

/// Absolute path of the registry file for this install.
pub fn registry_file(app: &AppHandle) -> Result<PathBuf, String> {
    app_local_path(app, REGISTRY_RELATIVE_PATH)
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/// Trim a value into the canonical row, keeping only the §4.1 fields.
///
/// Returns `None` for a record without a usable `project_id`: the identity is
/// the whole point of the row, so a row without it is not data worth keeping.
fn build_row(
    project_id: &str,
    project_path: &str,
    project_title: &str,
    last_content_item_id: Option<&str>,
    opened_at: &str,
) -> Option<Value> {
    let id = project_id.trim();
    if id.is_empty() {
        return None;
    }
    let title: String = project_title.trim().chars().take(TITLE_LIMIT).collect();
    let path: String = project_path.trim().chars().take(PATH_LIMIT).collect();
    let mut row = serde_json::Map::new();
    row.insert("project_id".into(), json!(id));
    row.insert("project_path".into(), json!(path));
    row.insert(
        "project_title".into(),
        json!(if title.is_empty() { path } else { title }),
    );
    row.insert("last_opened_at".into(), json!(opened_at));
    let position = last_content_item_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match position {
        Some(value) => {
            row.insert("last_content_item_id".into(), json!(value));
        }
        // §4.1 makes this field optional; an absent one stays absent rather
        // than being written as `null`, which would suggest a lost position.
        None => {}
    }
    Some(Value::Object(row))
}

/// Read one stored row out of an arbitrary (possibly damaged) JSON value.
fn row_from_value(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    if object
        .keys()
        .any(|key| !RECORD_FIELDS.contains(&key.as_str()))
    {
        return None;
    }
    build_row(
        object
            .get("project_id")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        object
            .get("project_path")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        object
            .get("project_title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        object.get("last_content_item_id").and_then(Value::as_str),
        object
            .get("last_opened_at")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
}

fn rows_of(store: &Value) -> Vec<Value> {
    store
        .get("projects")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(row_from_value).collect())
        .unwrap_or_default()
}

fn store_of(rows: Vec<Value>) -> Value {
    json!({ "version": REGISTRY_VERSION, "projects": rows })
}

/// `last_opened_at DESC`, with the id as a stable tiebreak so the launcher list
/// never reorders itself between two renders of the same data.
fn sort_rows(rows: &mut [Value]) {
    rows.sort_by(|left, right| {
        let key = |row: &Value| {
            (
                row.get("last_opened_at")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                row.get("project_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            )
        };
        key(right).cmp(&key(left))
    });
}

fn same_project(row: &Value, project_id: &str) -> bool {
    row.get("project_id").and_then(Value::as_str) == Some(project_id)
}

fn same_path(row: &Value, project_path: &str) -> bool {
    row.get("project_path").and_then(Value::as_str) == Some(project_path)
}

/// Ids that appear at more than one stored path (§4.4).
fn duplicated_ids(rows: &[Value]) -> Vec<String> {
    let mut seen: Vec<(String, usize)> = Vec::new();
    for row in rows {
        let Some(id) = row.get("project_id").and_then(Value::as_str) else {
            continue;
        };
        match seen.iter_mut().find(|(known, _)| known == id) {
            Some((_, count)) => *count += 1,
            None => seen.push((id.to_string(), 1)),
        }
    }
    seen.into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(id, _)| id)
        .collect()
}

/// Rows as the launcher sees them: the stored record plus two derived flags,
/// newest first. `available` / `copy` are computed per call and never persisted.
fn annotate_rows(rows: &[Value], path_live: &dyn Fn(&str) -> bool) -> Vec<Value> {
    let copies = duplicated_ids(rows);
    let mut annotated: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut object = row.as_object().cloned().unwrap_or_default();
            let path = row
                .get("project_path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            object.insert("available".into(), json!(path_live(path)));
            object.insert(
                "copy".into(),
                json!(copies.iter().any(|id| same_project(row, id))),
            );
            Value::Object(object)
        })
        .collect();
    sort_rows(&mut annotated);
    annotated
}

/// A reopen that carries no reader position must not forget the one on file:
/// §4.2 says such an open only refreshes `last_opened_at`.
fn keep_stored_position(existing: &Value, row: &Value) -> Value {
    if row
        .get("last_content_item_id")
        .and_then(Value::as_str)
        .is_some()
        || existing
            .get("last_content_item_id")
            .and_then(Value::as_str)
            .is_none()
    {
        return row.clone();
    }
    let mut merged = row.as_object().cloned().unwrap_or_default();
    if let Some(position) = existing.get("last_content_item_id") {
        merged.insert("last_content_item_id".into(), position.clone());
    }
    Value::Object(merged)
}

// ---------------------------------------------------------------------------
// File layer (tolerant by design: a damaged registry must never block startup)
// ---------------------------------------------------------------------------

/// Load the rows. A missing file is empty; a damaged file is set aside as
/// `.bak` and also reads as empty, so the launcher still opens.
fn load_rows(path: &Path) -> Result<Vec<Value>, String> {
    match fs::read_to_string(path) {
        Ok(contents) if contents.trim().is_empty() => Ok(Vec::new()),
        Ok(contents) => match serde_json::from_str::<Value>(&contents) {
            Ok(store) => Ok(rows_of(&store)),
            Err(_) => {
                backup_damaged(path)?;
                Ok(Vec::new())
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("无法读取{REGISTRY_LABEL}: {error}")),
    }
}

/// Copy an unreadable registry aside, preserving the previous backup name the
/// atomic writer already uses (`projects.bak`).
fn backup_damaged(path: &Path) -> Result<(), String> {
    reject_symlink(path, REGISTRY_LABEL)?;
    let backup = path.with_extension("bak");
    reject_symlink(&backup, "登记表备份")?;
    match fs::copy(path, &backup) {
        Ok(_) => Ok(()),
        // The damaged file is unusable either way; failing to keep a forensic
        // copy must not turn into a startup error.
        Err(_) => Ok(()),
    }
}

fn save_rows(path: &Path, rows: Vec<Value>) -> Result<(), String> {
    let mut rows = rows;
    sort_rows(&mut rows);
    rows.truncate(REGISTRY_LIMIT);
    let mut contents = serde_json::to_string_pretty(&store_of(rows))
        .map_err(|error| format!("无法序列化{REGISTRY_LABEL}: {error}"))?;
    contents.push('\n');
    atomic_write_path(path, &contents, true)
}

/// What the launcher may offer for a row (§4.3 / §5).
///
/// A closed project's lease file is removed, so it cannot indicate whether the
/// folder still exists. Keep this launcher probe read-only and cheap: require a
/// real directory and a regular `project.json`; opening performs full validation.
fn registry_project_available(path: &str) -> bool {
    if path.is_empty() || !Path::new(path).is_absolute() {
        return false;
    }
    let root = Path::new(path);
    if !fs::symlink_metadata(root)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        return false;
    }
    fs::symlink_metadata(root.join("project.json"))
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/// Outcome of an upsert-by-`project_id` (§4.2).
enum RecordOutcome {
    /// Same id, same path: only `last_opened_at` (and the hints) moved.
    Refreshed { row: Value },
    /// Same id, stored path is gone: the project moved and this open proves
    /// where it is now, so the path is updated in place.
    Relocated { row: Value, from: String },
    /// First time this id is seen: a new row.
    Added { row: Value },
    /// Same id at a second live path (§4.4). Nothing is written: the user has
    /// to say which meaning they intend.
    Duplicate { existing: Value },
}

/// Rows that still describe the folder at `path`.
///
/// One folder can only hold one `project.json`, so recording identity Y at a path
/// means any row that claimed a *different* id at that same path has stopped
/// being true — the folder was replaced, not renamed. Leaving it would put a
/// card on the start page that opens a different course than its title says,
/// which is exactly the identity break the registry exists to prevent. Only ever
/// a row: the folder itself is untouched.
fn drop_replaced(rows: Vec<Value>, id: &str, path: &str) -> Vec<Value> {
    rows.into_iter()
        .filter(|row| same_project(row, id) || !same_path(row, path))
        .collect()
}

fn record_rows(
    rows: &[Value],
    request: &Value,
    path_live: &dyn Fn(&str) -> bool,
    opened_at: &str,
) -> Result<(Vec<Value>, RecordOutcome), String> {
    let project_id = request
        .get("project_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let project_path = request
        .get("project_path")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let allow_second_copy = request
        .get("allow_second_copy")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let title = request
        .get("project_title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let position = request.get("last_content_item_id").and_then(Value::as_str);
    // A caller that knows the identity but not the location is refreshing the
    // row the registry already has, not moving the project: an empty path must
    // never overwrite a stored one, and a brand-new row with no location would
    // be a card the launcher can never open.
    let location = if project_path.is_empty() {
        match rows
            .iter()
            .find(|candidate| same_project(candidate, project_id))
            .and_then(|candidate| candidate.get("project_path"))
            .and_then(Value::as_str)
        {
            Some(stored) => stored,
            None => return Err(format!("{REGISTRY_LABEL}需要项目的文件夹路径")),
        }
    } else {
        project_path
    };
    let Some(row) = build_row(project_id, location, title, position, opened_at) else {
        return Err(format!("{REGISTRY_LABEL}需要项目的稳定标识"));
    };
    let id = row
        .get("project_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let path = row
        .get("project_path")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let mut next = rows.to_vec();
    if let Some(index) = next
        .iter()
        .position(|candidate| same_project(candidate, id) && same_path(candidate, path))
    {
        let stored = next[index].clone();
        let row = keep_stored_position(&stored, &row);
        next[index] = row.clone();
        return Ok((
            drop_replaced(next, id, path),
            RecordOutcome::Refreshed { row },
        ));
    }
    if let Some(index) = next
        .iter()
        .position(|candidate| same_project(candidate, id))
    {
        let existing = next[index].clone();
        let existing_path = existing
            .get("project_path")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if path_live(existing_path) && !allow_second_copy {
            return Ok((
                rows.to_vec(),
                RecordOutcome::Duplicate {
                    existing: existing.clone(),
                },
            ));
        }
        if !path_live(existing_path) && !allow_second_copy {
            // The stored folder is gone and this id just opened somewhere else:
            // that is a move, and identity already matched, so the row follows
            // the project instead of accumulating a second record.
            let from = existing_path.to_string();
            next[index] = row.clone();
            return Ok((
                drop_replaced(next, id, path),
                RecordOutcome::Relocated {
                    row: row.clone(),
                    from,
                },
            ));
        }
        // §4.4 「保留两条记录（标注副本）」: an explicit user decision, so both
        // paths stay visible and each row keeps saying which folder it is.
        next.push(row.clone());
        return Ok((
            drop_replaced(next, id, path),
            RecordOutcome::Added { row: row.clone() },
        ));
    }
    next.push(row.clone());
    Ok((drop_replaced(next, id, path), RecordOutcome::Added { row }))
}

fn remove_rows(
    rows: &[Value],
    project_id: &str,
    project_path: Option<&str>,
) -> (Vec<Value>, usize) {
    let id = project_id.trim();
    let target = project_path
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut removed = 0_usize;
    let kept = rows
        .iter()
        .filter(|row| {
            let matches = same_project(row, id)
                && match target {
                    Some(path) => same_path(row, path),
                    None => true,
                };
            if matches {
                removed += 1;
            }
            !matches
        })
        .cloned()
        .collect();
    (kept, removed)
}

/// What the shell found at the new location, already reduced to identity only.
struct RelocateEvidence {
    found_id: String,
    found_title: String,
}

/// §4.3 — point a stored row at a new folder, and only when the id matches.
fn relocate_rows(
    rows: &[Value],
    project_id: &str,
    new_path: &str,
    evidence: &RelocateEvidence,
    opened_at: &str,
) -> Result<(Vec<Value>, Value), String> {
    let id = project_id.trim();
    let new_path = new_path.trim();
    if id.is_empty() || new_path.is_empty() {
        return Err("重新定位需要项目标识与新的文件夹路径".into());
    }
    if evidence.found_id.trim() != id {
        // Never silently re-point a registry row at a different project.
        return Err(format!(
            "该文件夹里的项目标识与登记表记录不一致（{} ≠ {}），已拒绝重新定位。",
            evidence.found_id.trim(),
            id
        ));
    }
    let Some(index) = rows.iter().position(|row| same_project(row, id)) else {
        return Err("登记表里没有这个项目的记录。".into());
    };
    let existing = rows[index].clone();
    let old_path = existing
        .get("project_path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let title = if evidence.found_title.trim().is_empty() {
        existing
            .get("project_title")
            .and_then(Value::as_str)
            .unwrap_or_default()
    } else {
        evidence.found_title.trim()
    };
    let position = existing.get("last_content_item_id").and_then(Value::as_str);
    let Some(row) = build_row(id, new_path, title, position, opened_at) else {
        return Err("登记表记录无法更新".into());
    };
    let mut next = rows.to_vec();
    // The reader position belongs to the old folder; a different folder may
    // hold a different lesson, so the hint is dropped when the path changes.
    let row = if old_path == new_path {
        row
    } else {
        let mut cleaned = row.as_object().cloned().unwrap_or_default();
        cleaned.remove("last_content_item_id");
        Value::Object(cleaned)
    };
    match next
        .iter()
        .position(|candidate| same_project(candidate, id) && same_path(candidate, new_path))
    {
        // Same id at the same path twice is not two facts; collapse them. A
        // relocate that lands on the stored path is the same row, so it is
        // replaced in place rather than written and then removed as its own
        // duplicate.
        Some(other) if other != index => {
            next[other] = row.clone();
            next.remove(index);
        }
        _ => next[index] = row.clone(),
    }
    Ok((next, row))
}

/// Read `project.json` at `path` through the existing read-only classifier and
/// return its identity echo (`{id, title}`) — the one place §4.3 gets its
/// evidence, and it never takes a lock or writes anything.
fn identity_at(path: &str) -> Result<RelocateEvidence, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || !Path::new(trimmed).is_absolute() {
        return Err("项目文件夹必须是绝对路径".into());
    }
    let inspection = inspect_project_directory(Path::new(trimmed));
    let status = inspection
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(status, "valid" | "migratable") {
        let problem = inspection.get("problem");
        let message = problem
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("这个文件夹不是一个可用的 Workbench 项目。");
        return Err(format!("无法采用这个文件夹：{message}"));
    }
    let project = inspection.get("project");
    let found_id = project
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if found_id.trim().is_empty() {
        return Err("这个文件夹里的项目没有可读的标识。".into());
    }
    let found_title = project
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(RelocateEvidence {
        found_id,
        found_title,
    })
}

/// Read one string out of a payload that may arrive in either spelling — the
/// native shell's Tauri arguments are camelCase, the browser twin sends the
/// stored snake_case field names, and both are honest about the same record.
fn text_field(payload: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn bool_field(payload: &Value, keys: &[&str]) -> bool {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn record_input(payload: &Value) -> Value {
    let position = text_field(payload, &["lastContentItemId", "last_content_item_id"]);
    json!({
        "project_id": text_field(payload, &["projectId", "project_id"]),
        "project_path": text_field(payload, &["projectPath", "project_path"]),
        "project_title": text_field(payload, &["projectTitle", "project_title"]),
        "last_content_item_id": position,
        "allow_second_copy": bool_field(payload, &["allowSecondCopy", "allow_second_copy"]),
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Every project this install knows about, newest first (§5).
#[tauri::command]
pub fn registry_list(app: AppHandle) -> Result<Value, String> {
    let path = registry_file(&app)?;
    let rows = load_rows(&path)?;
    let mut rows = rows;
    sort_rows(&mut rows);
    Ok(json!({
        "version": REGISTRY_VERSION,
        "projects": annotate_rows(&rows, &registry_project_available),
    }))
}

/// Upsert one project by `project_id` after create / open / adopt (§4.2).
#[tauri::command]
pub fn registry_record(app: AppHandle, input: Value) -> Result<Value, String> {
    reject_sensitive(&input)?;
    let path = registry_file(&app)?;
    let rows = load_rows(&path)?;
    let request = record_input(&input);
    let (next, outcome) =
        record_rows(&rows, &request, &registry_project_available, &rfc3339_now())?;
    match &outcome {
        RecordOutcome::Duplicate { existing } => Ok(json!({
            "status": "duplicate",
            "message": "检测到同一个 Workbench 项目的两个副本。",
            "project": existing,
        })),
        _ => {
            save_rows(&path, next)?;
            let (status, row) = match outcome {
                RecordOutcome::Refreshed { row } => ("refreshed", row),
                RecordOutcome::Added { row } => ("added", row),
                RecordOutcome::Relocated { row, from } => {
                    return Ok(json!({
                        "status": "relocated",
                        "previous_path": from,
                        "project": row,
                    }))
                }
                RecordOutcome::Duplicate { .. } => unreachable!("handled above"),
            };
            Ok(json!({ "status": status, "project": row }))
        }
    }
}

/// Drop a row from the list. §5: this never deletes or edits the disk project.
#[tauri::command]
pub fn registry_remove(app: AppHandle, input: Value) -> Result<Value, String> {
    reject_sensitive(&input)?;
    let path = registry_file(&app)?;
    let rows = load_rows(&path)?;
    let project_id = text_field(&input, &["projectId", "project_id"]);
    if project_id.trim().is_empty() {
        return Err("移除登记表记录需要项目标识".into());
    }
    let project_path = text_field(&input, &["projectPath", "project_path"]);
    // The disk is deliberately untouched: no `project_file`, no lock, no write
    // outside the registry file itself.
    let (kept, removed) = remove_rows(&rows, &project_id, Some(project_path.as_str()));
    save_rows(&path, kept)?;
    Ok(json!({ "removed": removed, "project_id": project_id }))
}

/// §4.3 — re-point a row at the folder the user just chose, id must match.
#[tauri::command]
pub fn registry_relocate(app: AppHandle, input: Value) -> Result<Value, String> {
    reject_sensitive(&input)?;
    let path = registry_file(&app)?;
    let rows = load_rows(&path)?;
    let project_id = text_field(&input, &["projectId", "project_id"]);
    let new_path = text_field(
        &input,
        &["newPath", "new_path", "projectPath", "project_path"],
    );
    let evidence = identity_at(&new_path)?;
    let (next, row) = relocate_rows(&rows, &project_id, &new_path, &evidence, &rfc3339_now())?;
    save_rows(&path, next)?;
    Ok(json!({ "status": "relocated", "project": row }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_registry(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "workbench-registry-{name}-{}-{}",
            std::process::id(),
            crate::native_id("test")
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir.join("projects.json")
    }

    fn request(id: &str, path: &str, title: &str) -> Value {
        json!({
            "project_id": id,
            "project_path": path,
            "project_title": title,
            "last_content_item_id": null,
            "allow_second_copy": false,
        })
    }

    fn live_every_path(_: &str) -> bool {
        true
    }

    fn dead_every_path(_: &str) -> bool {
        false
    }

    #[test]
    fn a_recorded_project_roundtrips_through_the_file() {
        let path = temp_registry("roundtrip");
        let rows = load_rows(&path).expect("empty registry reads as empty");
        assert!(rows.is_empty());
        let (next, outcome) = record_rows(
            &rows,
            &request("proj-1", "/tmp/proj-1", "第一门课"),
            &live_every_path,
            "2026-03-01T08:00:00.000Z",
        )
        .expect("record");
        assert!(matches!(outcome, RecordOutcome::Added { .. }));
        save_rows(&path, next).expect("save");

        let stored: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let rows = rows_of(&stored);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["project_id"], json!("proj-1"));
        assert_eq!(rows[0]["project_path"], json!("/tmp/proj-1"));
        assert_eq!(rows[0]["project_title"], json!("第一门课"));
        assert_eq!(rows[0]["last_opened_at"], json!("2026-03-01T08:00:00.000Z"));
        assert_eq!(
            rows[0]
                .as_object()
                .expect("object")
                .keys()
                .collect::<Vec<_>>()
                .as_slice(),
            &[
                "last_opened_at",
                "project_id",
                "project_path",
                "project_title"
            ],
            "the persisted record holds exactly the §4.1 fields"
        );
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn reopening_the_same_project_refreshes_only_last_opened_at() {
        let rows = vec![build_row(
            "proj-1",
            "/tmp/proj-1",
            "第一门课",
            Some("c-9"),
            "2026-03-01T08:00:00.000Z",
        )
        .unwrap()];
        let (next, outcome) = record_rows(
            &rows,
            &request("proj-1", "/tmp/proj-1", "改过名字的课程"),
            &live_every_path,
            "2026-03-04T08:00:00.000Z",
        )
        .expect("upsert");
        assert!(matches!(outcome, RecordOutcome::Refreshed { .. }));
        assert_eq!(
            next.len(),
            1,
            "one record per project, never a duplicate row"
        );
        assert_eq!(next[0]["last_opened_at"], json!("2026-03-04T08:00:00.000Z"));
        assert_eq!(next[0]["project_title"], json!("改过名字的课程"));
        assert_eq!(next[0]["project_path"], json!("/tmp/proj-1"));
        assert_eq!(
            next[0]["last_content_item_id"],
            json!("c-9"),
            "the caller that has no position must not erase a stored hint"
        );
    }

    #[test]
    fn several_projects_sort_newest_first() {
        let path = temp_registry("sort");
        let mut rows: Vec<Value> = Vec::new();
        for (index, id) in ["a", "b", "c"].iter().enumerate() {
            let (next, _) = record_rows(
                &rows,
                &request(id, &format!("/tmp/{id}"), &format!("课程 {id}")),
                &live_every_path,
                &format!("2026-03-0{}T00:00:00.000Z", index + 1),
            )
            .expect("record");
            rows = next;
        }
        save_rows(&path, rows).expect("save");
        let stored: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let listed = rows_of(&stored);
        let mut listed = listed;
        sort_rows(&mut listed);
        let ids: Vec<&str> = listed
            .iter()
            .map(|row| row["project_id"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(ids, vec!["c", "b", "a"]);
        // A tie breaks on the id, descending, and both shells must agree on the
        // direction or the list can swap rows between two renders of one file.
        let mut tied = vec![
            build_row("x", "/tmp/x", "课 X", None, "2026-03-01T00:00:00.000Z").unwrap(),
            build_row("y", "/tmp/y", "课 Y", None, "2026-03-01T00:00:00.000Z").unwrap(),
        ];
        sort_rows(&mut tied);
        assert_eq!(
            tied.iter()
                .map(|row| row["project_id"].as_str().unwrap_or_default())
                .collect::<Vec<_>>(),
            vec!["y", "x"],
            "the tiebreak is the same descending-id order the browser twin produces"
        );
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn a_same_id_at_two_live_paths_is_reported_as_a_copy_and_never_merged() {
        let rows = vec![build_row(
            "proj-1",
            "/tmp/a",
            "第一门课",
            None,
            "2026-03-01T08:00:00.000Z",
        )
        .unwrap()];
        let (after, outcome) = record_rows(
            &rows,
            &request("proj-1", "/tmp/b", "第一门课"),
            &live_every_path,
            "2026-03-02T08:00:00.000Z",
        )
        .expect("record");
        assert!(matches!(outcome, RecordOutcome::Duplicate { .. }));
        assert_eq!(
            after, rows,
            "nothing is written without the user's decision"
        );

        // The user chose 「保留两条记录（标注副本）」.
        let mut explicit = request("proj-1", "/tmp/b", "第一门课");
        explicit["allow_second_copy"] = json!(true);
        let (both, outcome) = record_rows(
            &rows,
            &explicit,
            &live_every_path,
            "2026-03-02T08:00:00.000Z",
        )
        .expect("record");
        assert!(matches!(outcome, RecordOutcome::Added { .. }));
        assert_eq!(both.len(), 2);
        let annotated = annotate_rows(&both, &live_every_path);
        assert!(
            annotated.iter().all(|row| row["copy"] == json!(true)),
            "both rows are labelled as copies"
        );
        assert_eq!(
            annotated
                .iter()
                .map(|row| row["project_path"].as_str().unwrap_or_default())
                .collect::<Vec<_>>()
                .as_slice(),
            &["/tmp/b", "/tmp/a"],
            "both paths stay visible, newest first"
        );
    }

    #[test]
    fn reopening_a_moved_project_updates_the_stored_path() {
        let rows = vec![build_row(
            "proj-1",
            "/tmp/gone",
            "第一门课",
            None,
            "2026-03-01T08:00:00.000Z",
        )
        .unwrap()];
        let (next, outcome) = record_rows(
            &rows,
            &request("proj-1", "/tmp/moved", "第一门课"),
            &|candidate| candidate != "/tmp/gone",
            "2026-03-03T08:00:00.000Z",
        )
        .expect("record");
        assert!(matches!(outcome, RecordOutcome::Relocated { .. }));
        assert_eq!(next.len(), 1);
        assert_eq!(next[0]["project_path"], json!("/tmp/moved"));
    }

    #[test]
    fn relocate_follows_the_id_and_refuses_a_mismatch() {
        let rows = vec![build_row(
            "proj-1",
            "/tmp/gone",
            "第一门课",
            Some("c-1"),
            "2026-03-01T08:00:00.000Z",
        )
        .unwrap()];
        let mismatch = relocate_rows(
            &rows,
            "proj-1",
            "/tmp/other",
            &RelocateEvidence {
                found_id: "proj-2".into(),
                found_title: "别的课".into(),
            },
            "2026-03-05T08:00:00.000Z",
        );
        let message = match mismatch {
            Err(message) => message,
            Ok(_) => panic!("a different project id must never be adopted as this row's path"),
        };
        assert!(message.contains("不一致"));
        assert_eq!(
            rows[0]["project_path"],
            json!("/tmp/gone"),
            "old path intact"
        );

        let (next, row) = relocate_rows(
            &rows,
            "proj-1",
            "/tmp/found",
            &RelocateEvidence {
                found_id: "proj-1".into(),
                found_title: "第一门课".into(),
            },
            "2026-03-05T08:00:00.000Z",
        )
        .expect("relocate");
        assert_eq!(row["project_path"], json!("/tmp/found"));
        assert_eq!(next.len(), 1);
        assert_eq!(next[0]["project_path"], json!("/tmp/found"));
        assert!(
            next[0].get("last_content_item_id").is_none(),
            "the old folder's reader hint does not travel to a new folder"
        );
    }

    #[test]
    fn relocating_a_row_to_its_own_path_replaces_it_instead_of_deleting_it() {
        let rows = vec![build_row(
            "proj-1",
            "/tmp/found",
            "第一门课",
            Some("c-1"),
            "2026-03-01T08:00:00.000Z",
        )
        .unwrap()];
        let (next, row) = relocate_rows(
            &rows,
            "proj-1",
            "/tmp/found",
            &RelocateEvidence {
                found_id: "proj-1".into(),
                found_title: "第一门课".into(),
            },
            "2026-03-05T08:00:00.000Z",
        )
        .expect("relocate");
        assert_eq!(
            next.len(),
            1,
            "a relocate that lands on the stored path is the same row, not its own duplicate"
        );
        assert_eq!(next[0], row);
        assert_eq!(
            next[0]["last_content_item_id"],
            json!("c-1"),
            "the path did not change, so the reader hint stays"
        );
    }

    #[test]
    fn removing_a_row_touches_nothing_else_and_only_deletes_the_row() {
        let path = temp_registry("remove");
        let mut rows: Vec<Value> = Vec::new();
        for (index, id) in ["a", "b"].iter().enumerate() {
            let (next, _) = record_rows(
                &rows,
                &request(id, &format!("/tmp/{id}"), &format!("课程 {id}")),
                &live_every_path,
                &format!("2026-03-0{}T00:00:00.000Z", index + 1),
            )
            .expect("record");
            rows = next;
        }
        save_rows(&path, rows).expect("save");

        let stored: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let (kept, removed) = remove_rows(&rows_of(&stored), "a", None);
        assert_eq!(removed, 1);
        assert_eq!(kept.len(), 1);
        assert!(kept.iter().all(|row| row["project_id"] != json!("a")));
        save_rows(&path, kept).expect("save");
        let after: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let after = rows_of(&after);
        assert_eq!(after.len(), 1);
        assert_eq!(after[0]["project_id"], json!("b"));
        // §5: removal is a registry edit and nothing else. The registry
        // directory holds its own file (plus the atomic writer's backup) and no
        // project payload is ever written beside it.
        let dir = path.parent().expect("parent");
        let mut written: Vec<String> = fs::read_dir(dir)
            .expect("read registry dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        written.sort();
        assert_eq!(
            written,
            vec!["projects.bak".to_string(), "projects.json".to_string()],
            "the registry writer creates no other file"
        );
        assert!(
            !fs::read_to_string(&path)
                .unwrap()
                .contains("project.json 的内容"),
            "no course body ever enters the registry file"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_recorded_under_a_new_id_retires_the_row_that_claimed_it() {
        // One folder holds one `project.json`, so a second id arriving at the same
        // path means the folder was replaced. Leaving the old row up would put a
        // card on the start page that opens a different course than its title.
        let rows = vec![
            build_row(
                "proj-old",
                "/tmp/shared",
                "旧课程",
                None,
                "2026-03-01T08:00:00.000Z",
            )
            .unwrap(),
            build_row(
                "proj-keep",
                "/tmp/elsewhere",
                "别的课",
                None,
                "2026-03-02T08:00:00.000Z",
            )
            .unwrap(),
        ];
        let (next, outcome) = record_rows(
            &rows,
            &request("proj-new", "/tmp/shared", "新课程"),
            &live_every_path,
            "2026-03-08T08:00:00.000Z",
        )
        .expect("record");
        assert!(matches!(outcome, RecordOutcome::Added { .. }));
        let ids: Vec<&str> = next
            .iter()
            .map(|row| row["project_id"].as_str().unwrap_or_default())
            .collect();
        assert!(
            !ids.contains(&"proj-old"),
            "the stale claim on the replaced folder is gone: {ids:?}"
        );
        assert!(
            ids.contains(&"proj-keep"),
            "an unrelated row is not collateral"
        );
        assert_eq!(next.len(), 2);
        assert!(
            next.iter().any(|row| row["project_id"] == json!("proj-new")
                && row["project_path"] == json!("/tmp/shared")),
            "the new claim is what the folder now says"
        );
    }

    #[test]
    fn a_record_without_a_location_refreshes_the_stored_path() {
        let rows = vec![build_row(
            "proj-1",
            "/tmp/proj-1",
            "第一门课",
            Some("c-3"),
            "2026-03-01T08:00:00.000Z",
        )
        .unwrap()];
        let (next, outcome) = record_rows(
            &rows,
            &request("proj-1", "", "改过名字的课程"),
            &live_every_path,
            "2026-03-06T08:00:00.000Z",
        )
        .expect("record");
        assert!(matches!(outcome, RecordOutcome::Refreshed { .. }));
        assert_eq!(next.len(), 1);
        assert_eq!(
            next[0]["project_path"],
            json!("/tmp/proj-1"),
            "an empty path never wipes the stored location"
        );
        assert_eq!(next[0]["project_title"], json!("改过名字的课程"));
        assert_eq!(
            next[0]["last_content_item_id"],
            json!("c-3"),
            "a title-only refresh keeps the reader hint"
        );

        // A brand-new id with no location would be a card the launcher can never
        // open, so it is refused instead of persisted with an empty path.
        let unknown = request("proj-new", "", "没有位置的课");
        let error = match record_rows(
            &rows,
            &unknown,
            &live_every_path,
            "2026-03-07T08:00:00.000Z",
        ) {
            Err(message) => message,
            Ok(_) => panic!("a record with no identity and no location must not be stored"),
        };
        assert!(error.contains("文件夹路径"), "actual: {error}");
    }

    #[test]
    fn a_damaged_registry_reads_as_empty_and_keeps_a_backup() {
        let path = temp_registry("corrupt");
        fs::write(&path, "{ this is not json").expect("write damage");
        let rows = load_rows(&path).expect("a damaged registry must not block startup");
        assert!(rows.is_empty());
        let backup = path.with_extension("bak");
        assert!(backup.exists(), "the damaged file is kept for diagnosis");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "{ this is not json");
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn a_foreign_record_shape_is_dropped_rather_than_echoed() {
        let path = temp_registry("foreign");
        fs::write(
            &path,
            json!({
                "version": REGISTRY_VERSION,
                "projects": [
                    { "project_id": "a", "project_path": "/tmp/a", "project_title": "课",
                      "last_opened_at": "2026-03-01T00:00:00.000Z", "api_key": "sk-leak",
                      "project": { "content_items": [] } },
                    { "project_path": "/tmp/no-id", "project_title": "没有标识" },
                    { "project_id": "b", "project_path": "/tmp/b", "project_title": "课 B",
                      "last_opened_at": "2026-03-02T00:00:00.000Z" }
                ]
            })
            .to_string(),
        )
        .expect("seed");
        let seeded = fs::read_to_string(&path).unwrap();
        let rows = load_rows(&path).expect("read");
        assert_eq!(
            rows.len(),
            1,
            "a record with extra keys is not a registry row"
        );
        assert_eq!(rows[0]["project_id"], json!("b"));
        let keys: Vec<String> = rows[0]
            .as_object()
            .expect("row object")
            .keys()
            .cloned()
            .collect();
        assert!(
            keys.iter().all(|key| RECORD_FIELDS.contains(&key.as_str())),
            "the loaded row holds only the §4.1 fields: {keys:?}"
        );
        assert!(
            !rows.iter().any(|row| row.to_string().contains("sk-leak")),
            "a credential that was found in the file is never carried forward"
        );
        // Reading is read-only: the launcher's list pass never rewrites the file.
        assert_eq!(fs::read_to_string(&path).unwrap(), seeded);
        save_rows(&path, rows).expect("rewrite");
        let rewritten = fs::read_to_string(&path).unwrap();
        assert!(!rewritten.contains("api_key"), "a stray key never survives");
        assert!(!rewritten.contains("sk-leak"));
        assert!(!rewritten.contains("content_items"), "no course body echo");
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn availability_marks_a_missing_folder_for_the_launcher() {
        let rows = vec![
            build_row("a", "/tmp/gone", "课 A", None, "2026-03-01T00:00:00.000Z").unwrap(),
            build_row("b", "/tmp/here", "课 B", None, "2026-03-02T00:00:00.000Z").unwrap(),
        ];
        let annotated = annotate_rows(&rows, &|candidate| candidate == "/tmp/here");
        assert_eq!(annotated[0]["available"], json!(true));
        assert_eq!(annotated[1]["project_id"], json!("a"));
        assert_eq!(annotated[1]["available"], json!(false));
        assert!(
            annotated.iter().all(|row| row["copy"] == json!(false)),
            "distinct ids are not copies"
        );
        let _ = dead_every_path("/unused");
    }

    #[test]
    fn a_closed_native_project_remains_available_and_missing_canonical_does_not() {
        let registry_path = temp_registry("availability-after-close");
        let parent = registry_path.parent().expect("fixture parent");
        let project_dir = parent.join("course");
        let project_path = project_dir.to_string_lossy().into_owned();
        crate::project_create(
            project_path.clone(),
            json!({ "project": { "id": "registry-p1", "title": "最近项目" }, "items": [] }),
        )
        .expect("native open should create the Canonical project and acquire its lease");
        assert!(registry_project_available(&project_path));

        crate::project_close(project_path.clone()).expect("native close should release its lease");
        assert!(
            !crate::project_lock_path(&project_dir)
                .expect("lock path")
                .exists(),
            "close must remove the active lease marker"
        );
        assert!(
            registry_project_available(&project_path),
            "an existing Canonical project remains available after its writer lease closes"
        );

        let missing = parent.join("missing").to_string_lossy().into_owned();
        assert!(!registry_project_available(&missing));
        let empty_dir = parent.join("no-canonical");
        fs::create_dir_all(&empty_dir).expect("empty fixture directory");
        assert!(!registry_project_available(&empty_dir.to_string_lossy()));

        let spaced_dir = parent.join(" project root with edge spaces ");
        fs::create_dir_all(&spaced_dir).expect("spaced fixture directory");
        fs::write(spaced_dir.join("project.json"), "{}").expect("fixture Canonical file");
        assert!(registry_project_available(&spaced_dir.to_string_lossy()));

        #[cfg(unix)]
        {
            let root_symlink = parent.join("project-link");
            std::os::unix::fs::symlink(&spaced_dir, &root_symlink).expect("root symlink");
            assert!(!registry_project_available(&root_symlink.to_string_lossy()));

            let canonical_link_dir = parent.join("canonical-link");
            fs::create_dir_all(&canonical_link_dir).expect("Canonical symlink directory");
            std::os::unix::fs::symlink(
                spaced_dir.join("project.json"),
                canonical_link_dir.join("project.json"),
            )
            .expect("Canonical symlink");
            assert!(!registry_project_available(
                &canonical_link_dir.to_string_lossy()
            ));
        }
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn record_input_accepts_both_argument_spellings() {
        let camel = json!({ "projectId": "a", "projectPath": "/tmp/a", "projectTitle": "课" });
        let parsed = record_input(&camel);
        assert_eq!(parsed["project_id"], json!("a"));
        assert_eq!(parsed["project_path"], json!("/tmp/a"));
        assert_eq!(parsed["allow_second_copy"], json!(false));
        let snake = json!({
            "project_id": "b",
            "project_path": "/tmp/b",
            "project_title": "课 B",
            "last_content_item_id": "c-1",
            "allow_second_copy": true
        });
        let parsed = record_input(&snake);
        assert_eq!(parsed["last_content_item_id"], json!("c-1"));
        assert_eq!(parsed["allow_second_copy"], json!(true));
        assert_eq!(
            build_row("x", "/tmp/x", "", None, "2026-03-01T00:00:00.000Z").expect("row")
                ["project_title"],
            json!("/tmp/x"),
            "a row without a title still says which folder it is"
        );
    }
}
