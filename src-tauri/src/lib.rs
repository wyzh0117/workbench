use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);
const PROJECT_LOCK_RELATIVE_PATH: &str = ".workspace/project.lock";
const PROJECT_LOCK_GUARD_RELATIVE_PATH: &str = ".workspace/project.lock.guard";
const PROJECT_LOCK_STALE_MS: u128 = 30_000;
const PROJECT_LOCK_HEARTBEAT_MS: u64 = 5_000;
const PROJECT_LOCK_READ_ATTEMPTS: usize = 4;

static APP_INSTANCE_ID: OnceLock<String> = OnceLock::new();
static ACTIVE_PROJECT_LOCKS: OnceLock<Mutex<HashMap<PathBuf, LeaseHandle>>> = OnceLock::new();
static PROJECT_BASELINES: OnceLock<Mutex<HashMap<PathBuf, ProjectBaseline>>> = OnceLock::new();
static EXIT_READY: AtomicBool = AtomicBool::new(false);

/// Project directory requested on the command line (`--project-dir <path>`).
///
/// This is the standard "open a project from the shell" entry point: it skips
/// the folder picker but runs exactly the same validation, lease acquisition
/// and canonical read as the picker does.
static LAUNCH_PROJECT_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
/// The launch directory is offered as the session exactly once.
static LAUNCH_PROJECT_CONSUMED: AtomicBool = AtomicBool::new(false);
const CLOSE_REQUEST_EVENT: &str = "workbench://close-requested";
const WINDOW_CLOSE_REQUEST_EVENT: &str = "tauri://close-requested";

#[derive(Clone)]
struct LeaseHandle {
    app_instance_id: String,
    stop: Arc<AtomicBool>,
}

#[derive(Clone, Debug)]
struct ProjectLockRecord {
    app_instance_id: String,
    pid: u32,
    host: String,
    opened_at: String,
    heartbeat: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct FileFingerprint {
    exists: bool,
    mtime_ms: Option<u64>,
    size: Option<u64>,
    hash: Option<String>,
}

#[derive(Clone, Debug)]
struct ProjectBaseline {
    fingerprint: FileFingerprint,
    project: Option<Value>,
}

#[derive(Debug, Serialize)]
struct BridgeStatus {
    mode: &'static str,
    address: &'static str,
    token_configured: bool,
    message: &'static str,
}

/// 正在执行的 AI 传输任务：`request_id` → `JoinHandle`，供 `ai_cancel` 中止。
type AiRequestHandles = Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>;

struct BridgeState {
    token: String,
    ai_requests: AiRequestHandles,
}

impl BridgeState {
    fn new() -> Self {
        Self {
            token: bridge_token(),
            ai_requests: AiRequestHandles::default(),
        }
    }
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = (if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    }) / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year, month as u32, day as u32)
}

fn rfc3339_now() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = duration.as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    let millis = duration.subsec_millis();
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn system_random_hex(byte_count: usize) -> Option<String> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::fill(&mut bytes).ok()?;
    let mut value = String::with_capacity(byte_count * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(value, "{byte:02x}");
    }
    Some(value)
}

fn new_app_instance_id() -> String {
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let random = system_random_hex(24).unwrap_or_else(|| "no-system-random".into());
    format!(
        "app-p{}-{}-{counter}-{random}",
        std::process::id(),
        unix_millis()
    )
}

fn native_id(prefix: &str) -> String {
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{counter}", unix_millis())
}

fn bridge_token() -> String {
    // Use the platform random source when available. The fallback is only an
    // ephemeral pairing value; it is never persisted in the project or logs.
    if let Some(token) = system_random_hex(24) {
        return token;
    }
    // Never downgrade to a predictable token. Bridge requests stay disabled
    // until a secure token can be generated.
    String::new()
}

fn sensitive_key(key: &str) -> bool {
    let compact: String = key
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(*character, '_' | '-' | '.'))
        .collect();
    let normalized = compact.to_ascii_lowercase();
    let tokens = [
        "apikey",
        "accesstoken",
        "refreshtoken",
        "idtoken",
        "authtoken",
        "bearertoken",
        "token",
        "cookie",
        "password",
        "passphrase",
        "secret",
        "privatekey",
        "clientsecret",
        "authorization",
        "credential",
        "authreference",
        "credentialreference",
        "workspacelocal",
        "securelocal",
        "modelconnections",
        "userpreferences",
        "recovery",
        "cache",
        "privateconversationcache",
    ];
    let parts: Vec<String> = key
        .split(|character: char| character.is_whitespace() || matches!(character, '_' | '-' | '.'))
        .filter(|part| !part.is_empty())
        .map(|part| part.to_ascii_lowercase())
        .collect();
    if tokens
        .iter()
        .any(|needle| parts.iter().any(|part| part == needle))
    {
        return true;
    }
    tokens.iter().any(|needle| {
        let mut position = normalized.find(needle);
        while let Some(found) = position {
            let after = found + needle.len();
            let camel_boundary = compact
                .as_bytes()
                .get(after)
                .map(|byte| byte.is_ascii_uppercase())
                .unwrap_or(false);
            if after == normalized.len() || camel_boundary {
                return true;
            }
            position = normalized[found + 1..]
                .find(needle)
                .map(|next| found + 1 + next);
        }
        false
    })
}

fn reject_sensitive(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                if sensitive_key(key) {
                    return Err("项目数据不得包含凭据或本机私有字段".into());
                }
                reject_sensitive(child)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                reject_sensitive(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn require_object<'a>(value: &'a Value, command: &str) -> Result<&'a Map<String, Value>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{command} 需要结构化参数"))?;
    reject_sensitive(value)?;
    Ok(object)
}

fn field<'a>(object: &'a Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| object.get(*name))
}

fn required_string(
    object: &Map<String, Value>,
    names: &[&str],
    label: &str,
) -> Result<String, String> {
    field(object, names)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("{label}不能为空"))
}

fn reject_symlink(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!("{label}不能是符号链接")),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法检查{label}: {error}")),
    }
}

fn ensure_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path);
    match metadata {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!("{label}不能是符号链接"));
            }
            if !metadata.is_dir() {
                return Err(format!("{label}不是目录"));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| format!("{label}的父目录无效"))?;
            if parent != path {
                ensure_directory(parent, "父目录")?;
            }
            fs::create_dir(path).map_err(|error| format!("无法创建{label}: {error}"))?;
        }
        Err(error) => return Err(format!("无法检查{label}: {error}")),
    }
    fs::canonicalize(path).map_err(|error| format!("无法解析{label}: {error}"))
}

fn explicit_project_dir(raw: &str, create: bool) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() {
        return Err("项目目录不能为空".into());
    }
    if !path.is_absolute() {
        return Err("项目目录必须是用户明确选择的绝对路径".into());
    }
    if !create && !path.exists() {
        return Err("项目目录不存在".into());
    }
    ensure_directory(&path, "项目目录")
}

fn project_file(project_dir: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("项目文件路径无效".into());
    }
    let target = project_dir.join(relative_path);
    let parent = target.parent().ok_or("项目文件父目录无效")?;
    ensure_directory(parent, "项目内部目录")?;
    reject_symlink(&target, "项目文件")?;
    Ok(target)
}

fn active_project_locks() -> &'static Mutex<HashMap<PathBuf, LeaseHandle>> {
    ACTIVE_PROJECT_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn project_baselines() -> &'static Mutex<HashMap<PathBuf, ProjectBaseline>> {
    PROJECT_BASELINES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn current_app_instance_id() -> &'static str {
    APP_INSTANCE_ID.get_or_init(new_app_instance_id).as_str()
}

fn project_lock_path(project_dir: &Path) -> Result<PathBuf, String> {
    project_file(project_dir, PROJECT_LOCK_RELATIVE_PATH)
}

fn project_lock_guard_path(project_dir: &Path) -> Result<PathBuf, String> {
    project_file(project_dir, PROJECT_LOCK_GUARD_RELATIVE_PATH)
}

fn open_project_lock_guard(project_dir: &Path) -> Result<File, String> {
    let guard_path = project_lock_guard_path(project_dir)?;
    let guard = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(guard_path)
        .map_err(|error| format!("无法打开项目锁协调器: {error}"))?;
    guard
        .lock()
        .map_err(|error| format!("无法锁定项目锁协调器: {error}"))?;
    Ok(guard)
}

fn project_lock_value(lock: &ProjectLockRecord) -> Value {
    json!({
        "app_instance_id": lock.app_instance_id,
        "pid": lock.pid,
        "host": lock.host,
        "opened_at": lock.opened_at,
        "heartbeat": lock.heartbeat,
    })
}

fn parse_project_lock(value: &Value) -> Option<ProjectLockRecord> {
    let object = value.as_object()?;
    let pid = object
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .or_else(|| {
            object
                .get("pid")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<u32>().ok())
        })?;
    Some(ProjectLockRecord {
        app_instance_id: object.get("app_instance_id")?.as_str()?.to_owned(),
        pid,
        host: object.get("host")?.as_str()?.to_owned(),
        opened_at: object.get("opened_at")?.as_str()?.to_owned(),
        heartbeat: object.get("heartbeat")?.as_str()?.to_owned(),
    })
}

fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => return None,
    };
    if day == 0 || day > days_in_month {
        return None;
    }
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = (if year >= 0 { year } else { year - 399 }) / 400;
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

fn parse_rfc3339_millis(value: &str) -> Option<u128> {
    let value = value.trim();
    let value = value.strip_suffix('Z')?;
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year_text = date_parts.next()?;
    if year_text.len() != 4 || !year_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let year = year_text.parse::<i64>().ok()?;
    if year < 1970 {
        return None;
    }
    let month_text = date_parts.next()?;
    let day_text = date_parts.next()?;
    if month_text.len() != 2
        || day_text.len() != 2
        || !month_text.bytes().all(|byte| byte.is_ascii_digit())
        || !day_text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let month = month_text.parse::<u32>().ok()?;
    let day = day_text.parse::<u32>().ok()?;
    if date_parts.next().is_some() {
        return None;
    }
    let (clock, fraction) = time
        .split_once('.')
        .map_or((time, None), |(clock, fraction)| (clock, Some(fraction)));
    let mut clock_parts = clock.split(':');
    let hour_text = clock_parts.next()?;
    let minute_text = clock_parts.next()?;
    let second_text = clock_parts.next()?;
    if hour_text.len() != 2
        || minute_text.len() != 2
        || second_text.len() != 2
        || !hour_text.bytes().all(|byte| byte.is_ascii_digit())
        || !minute_text.bytes().all(|byte| byte.is_ascii_digit())
        || !second_text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let hour = hour_text.parse::<u32>().ok()?;
    let minute = minute_text.parse::<u32>().ok()?;
    let second = second_text.parse::<u32>().ok()?;
    if clock_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let mut millis = 0_u32;
    if let Some(fraction) = fraction {
        let mut digits = 0_u32;
        for character in fraction.chars() {
            let digit = character.to_digit(10)?;
            if digits < 3 {
                millis = millis * 10 + digit;
            }
            digits += 1;
        }
        if digits == 0 {
            return None;
        }
        while digits < 3 {
            millis *= 10;
            digits += 1;
        }
    }
    let days = days_from_civil(year, month, day)?;
    let total = i128::from(days) * 86_400_000
        + i128::from(hour) * 3_600_000
        + i128::from(minute) * 60_000
        + i128::from(second) * 1_000
        + i128::from(millis);
    (total >= 0).then_some(total as u128)
}

fn read_project_lock(lock_path: &Path) -> Result<Option<ProjectLockRecord>, String> {
    for attempt in 0..PROJECT_LOCK_READ_ATTEMPTS {
        match fs::read_to_string(lock_path) {
            Ok(contents) => {
                if let Ok(value) = serde_json::from_str::<Value>(&contents) {
                    if let Some(lock) = parse_project_lock(&value) {
                        return Ok(Some(lock));
                    }
                }
                if attempt + 1 < PROJECT_LOCK_READ_ATTEMPTS {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                }
                return Ok(None);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("无法读取项目锁: {error}")),
        }
    }
    Ok(None)
}

fn project_lock_exists(lock_path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(lock_path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("项目锁不能是符号链接".into());
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法检查项目锁: {error}")),
    }
}

fn project_lock_mtime_is_stale(lock_path: &Path, stale_after_ms: u128) -> Result<bool, String> {
    let metadata = match fs::metadata(lock_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(format!("无法读取项目锁状态: {error}")),
    };
    let age = SystemTime::now()
        .duration_since(metadata.modified().unwrap_or(UNIX_EPOCH))
        .unwrap_or_default()
        .as_millis();
    Ok(age > stale_after_ms)
}

fn project_lock_is_stale(
    lock_path: &Path,
    lock: Option<&ProjectLockRecord>,
    stale_after_ms: u128,
) -> Result<bool, String> {
    if let Some(lock) = lock {
        if let Some(heartbeat) = parse_rfc3339_millis(&lock.heartbeat) {
            return Ok(unix_millis().saturating_sub(heartbeat) > stale_after_ms);
        }
    }
    // A malformed/incomplete lock has no trustworthy heartbeat. Its mtime is
    // only a bounded recovery signal, so a fresh partial write remains safe.
    project_lock_mtime_is_stale(lock_path, stale_after_ms)
}

fn project_locked_error() -> String {
    "project_locked: 该项目已在另一窗口或进程中编辑。".into()
}

fn project_lock_lost_error() -> String {
    "project_lock_lost: 项目编辑锁已失效，请重新打开项目。".into()
}

fn project_lock_not_owned_error() -> String {
    "project_lock_not_owned: 当前实例不是该项目锁的持有者。".into()
}

fn unregister_project_lock(project_dir: &Path, expected: Option<&LeaseHandle>) {
    let mut active = active_project_locks().lock().unwrap();
    let should_remove = active.get(project_dir).is_some_and(|current| {
        expected.is_none_or(|expected| Arc::ptr_eq(&current.stop, &expected.stop))
    });
    if let Some(entry) = should_remove.then(|| active.remove(project_dir)).flatten() {
        entry.stop.store(true, Ordering::Relaxed);
        project_baselines().lock().unwrap().remove(project_dir);
    }
}

fn project_lock_registered(project_dir: &Path, app_instance_id: &str) -> bool {
    active_project_locks()
        .lock()
        .unwrap()
        .get(project_dir)
        .is_some_and(|entry| entry.app_instance_id == app_instance_id)
}

fn heartbeat_project_lock(project_dir: &Path, app_instance_id: &str) -> Result<bool, String> {
    let _guard = open_project_lock_guard(project_dir)?;
    let lock_path = project_lock_path(project_dir)?;
    let mut file = match OpenOptions::new().read(true).write(true).open(&lock_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("无法更新项目锁: {error}")),
    };
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|error| format!("无法读取项目锁心跳: {error}"))?;
    let Some(mut lock) = serde_json::from_str::<Value>(&contents)
        .ok()
        .and_then(|value| parse_project_lock(&value))
    else {
        return Ok(false);
    };
    if lock.app_instance_id != app_instance_id {
        return Ok(false);
    }
    lock.heartbeat = rfc3339_now();
    let encoded = serde_json::to_vec(&project_lock_value(&lock))
        .map_err(|error| format!("无法编码项目锁心跳: {error}"))?;
    file.set_len(0)
        .map_err(|error| format!("无法重置项目锁心跳: {error}"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("无法定位项目锁心跳: {error}"))?;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("无法写入项目锁心跳: {error}"))?;
    Ok(true)
}

fn register_project_lock(project_dir: &Path, lock: &ProjectLockRecord) {
    let stop = Arc::new(AtomicBool::new(false));
    let handle = LeaseHandle {
        app_instance_id: lock.app_instance_id.clone(),
        stop: Arc::clone(&stop),
    };
    {
        let mut active = active_project_locks().lock().unwrap();
        if let Some(existing) = active.insert(project_dir.to_owned(), handle.clone()) {
            existing.stop.store(true, Ordering::Relaxed);
        }
    }
    let project_dir = project_dir.to_owned();
    let app_instance_id = lock.app_instance_id.clone();
    thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(PROJECT_LOCK_HEARTBEAT_MS));
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match heartbeat_project_lock(&project_dir, &app_instance_id) {
                Ok(true) => {}
                Ok(false) | Err(_) => {
                    stop.store(true, Ordering::Relaxed);
                    unregister_project_lock(&project_dir, Some(&handle));
                    break;
                }
            }
        }
    });
}

fn acquire_project_lock_for(
    project_dir: &Path,
    app_instance_id: &str,
    stale_after_ms: u128,
) -> Result<ProjectLockRecord, String> {
    let project_dir = ensure_directory(project_dir, "项目目录")?;
    let lock_path = project_lock_path(&project_dir)?;
    for _ in 0..4 {
        let _guard = open_project_lock_guard(&project_dir)?;
        let exists = project_lock_exists(&lock_path)?;
        let existing = read_project_lock(&lock_path)?;
        if let Some(lock) = existing.as_ref() {
            if lock.app_instance_id == app_instance_id
                && !project_lock_is_stale(&lock_path, Some(lock), stale_after_ms)?
            {
                register_project_lock(&project_dir, lock);
                return Ok(lock.clone());
            }
            if lock.app_instance_id != app_instance_id
                && !project_lock_is_stale(&lock_path, Some(lock), stale_after_ms)?
            {
                return Err(project_locked_error());
            }
        } else if exists && !project_lock_is_stale(&lock_path, None, stale_after_ms)? {
            return Err(project_locked_error());
        }
        if exists {
            match fs::remove_file(&lock_path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("无法接管项目锁: {error}")),
            }
        }
        let now = rfc3339_now();
        let lock = ProjectLockRecord {
            app_instance_id: app_instance_id.to_owned(),
            pid: std::process::id(),
            host: std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".into()),
            opened_at: now.clone(),
            heartbeat: now,
        };
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                let encoded = serde_json::to_vec(&project_lock_value(&lock))
                    .map_err(|error| format!("无法编码项目锁: {error}"))?;
                if let Err(error) = file.write_all(&encoded).and_then(|_| file.sync_all()) {
                    let _ = fs::remove_file(&lock_path);
                    return Err(format!("无法写入项目锁: {error}"));
                }
                drop(file);
                register_project_lock(&project_dir, &lock);
                return Ok(lock);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法获取项目锁: {error}")),
        }
    }
    Err(project_locked_error())
}

fn acquire_project_lock(project_dir: &Path) -> Result<ProjectLockRecord, String> {
    acquire_project_lock_for(
        project_dir,
        current_app_instance_id(),
        PROJECT_LOCK_STALE_MS,
    )
}

fn verify_active_project_lock(project_dir: &Path) -> Result<(), String> {
    let lock_path = project_lock_path(project_dir)?;
    let active = active_project_locks().lock().unwrap();
    let owned = active
        .get(project_dir)
        .map(|entry| entry.app_instance_id == current_app_instance_id())
        .unwrap_or(false);
    drop(active);
    let Some(lock) = read_project_lock(&lock_path)? else {
        return Err(if owned {
            project_lock_lost_error()
        } else {
            "project_not_open: 项目尚未以编辑模式打开。".into()
        });
    };
    if !owned || lock.app_instance_id != current_app_instance_id() {
        unregister_project_lock(project_dir, None);
        return Err(project_lock_lost_error());
    }
    if project_lock_is_stale(&lock_path, Some(&lock), PROJECT_LOCK_STALE_MS)? {
        unregister_project_lock(project_dir, None);
        return Err(project_lock_lost_error());
    }
    Ok(())
}

fn require_active_project_lock(project_dir: &Path) -> Result<File, String> {
    let project_dir =
        fs::canonicalize(project_dir).map_err(|error| format!("无法解析项目目录: {error}"))?;
    let guard = open_project_lock_guard(&project_dir)?;
    verify_active_project_lock(&project_dir)?;
    Ok(guard)
}

fn release_project_lock_for(project_dir: &Path, app_instance_id: &str) -> Result<(), String> {
    let project_dir =
        fs::canonicalize(project_dir).map_err(|error| format!("无法解析项目目录: {error}"))?;
    let registered = {
        let active = active_project_locks().lock().unwrap();
        active.get(&project_dir).cloned()
    };
    // Releasing an unopened directory is an idempotent no-op. In particular,
    // do not create .workspace/project.lock.guard just to discover that this
    // process never owned a lease.
    let Some(registered) = registered else {
        return Ok(());
    };
    let _guard = open_project_lock_guard(&project_dir)?;
    let lock_path = project_lock_path(&project_dir)?;
    if registered.app_instance_id != app_instance_id {
        return Err(project_lock_not_owned_error());
    }
    let Some(lock) = read_project_lock(&lock_path)? else {
        unregister_project_lock(&project_dir, Some(&registered));
        return Ok(());
    };
    if lock.app_instance_id != app_instance_id {
        unregister_project_lock(&project_dir, Some(&registered));
        return Err(project_lock_not_owned_error());
    }
    unregister_project_lock(&project_dir, Some(&registered));
    match fs::remove_file(&lock_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法释放项目锁: {error}")),
    }
}

fn release_project_lock(project_dir: &Path) -> Result<(), String> {
    release_project_lock_for(project_dir, current_app_instance_id())
}

fn release_all_project_locks() {
    let entries: Vec<(PathBuf, LeaseHandle)> = {
        let mut active = active_project_locks().lock().unwrap();
        active.drain().collect()
    };
    project_baselines().lock().unwrap().clear();
    for (project_dir, entry) in entries {
        entry.stop.store(true, Ordering::Relaxed);
        let Ok(_guard) = open_project_lock_guard(&project_dir) else {
            continue;
        };
        let Ok(lock_path) = project_lock_path(&project_dir) else {
            continue;
        };
        if read_project_lock(&lock_path)
            .ok()
            .flatten()
            .is_some_and(|lock| lock.app_instance_id == entry.app_instance_id)
        {
            let _ = fs::remove_file(lock_path);
        }
    }
}

/// Parse `--project-dir <path>` / `--project-dir=<path>` (also `-p`).
///
/// Returns `None` when the flag is absent.  A malformed value is a startup
/// error rather than a silently ignored argument.
fn project_dir_from_args<I: IntoIterator<Item = String>>(
    args: I,
) -> Result<Option<PathBuf>, String> {
    let collected: Vec<String> = args.into_iter().collect();
    let mut index = 0;
    while index < collected.len() {
        let argument = collected[index].clone();
        let inline = argument
            .strip_prefix("--project-dir=")
            .or_else(|| argument.strip_prefix("-p="))
            .map(ToOwned::to_owned);
        let flag = argument == "--project-dir" || argument == "-p";
        let raw = if let Some(value) = inline {
            Some(value)
        } else if flag {
            // A flag with no following value is a usage error, and a following
            // value that is itself a flag is never a path.
            index += 1;
            match collected.get(index) {
                Some(value) if !value.starts_with('-') => Some(value.clone()),
                _ => return Err("--project-dir 需要一个目录路径".into()),
            }
        } else {
            None
        };
        if let Some(value) = raw {
            let trimmed = value.trim().to_owned();
            if trimmed.is_empty() {
                return Err("--project-dir 需要一个目录路径".into());
            }
            return explicit_project_dir(&trimmed, false).map(Some);
        }
        index += 1;
    }
    Ok(None)
}

fn app_local_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("本地工作台路径无效".into());
    }
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    let base = ensure_directory(&base, "工作台本地数据目录")?;
    let target = base.join(relative_path);
    let parent = target.parent().ok_or("本地文件父目录无效")?;
    ensure_directory(parent, "本地工作台目录")?;
    reject_symlink(&target, "本地工作台文件")?;
    Ok(target)
}

fn atomic_write_path(target: &Path, contents: &str, keep_backup: bool) -> Result<(), String> {
    let parent = target.parent().ok_or("写入目标没有父目录")?;
    ensure_directory(parent, "写入目标目录")?;
    reject_symlink(target, "写入目标")?;
    let file_name = target
        .file_name()
        .ok_or("写入目标文件名无效")?
        .to_string_lossy();
    let temporary = parent.join(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        native_id("write")
    ));
    reject_symlink(&temporary, "临时文件")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("无法创建临时文件: {error}"))?;
    if let Err(error) = file
        .write_all(contents.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法完成原子写入: {error}"));
    }
    drop(file);

    if keep_backup && target.exists() {
        let backup = target.with_extension("bak");
        reject_symlink(&backup, "备份文件")?;
        if let Err(error) = fs::copy(target, &backup) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("无法创建备份: {error}"));
        }
    }
    let result = fs::rename(&temporary, target);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("无法替换目标文件: {error}"))
}

fn atomic_write_bytes_path(target: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = target.parent().ok_or("写入目标没有父目录")?;
    ensure_directory(parent, "写入目标目录")?;
    reject_symlink(target, "写入目标")?;
    let file_name = target
        .file_name()
        .ok_or("写入目标文件名无效")?
        .to_string_lossy();
    let temporary = parent.join(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        native_id("write")
    ));
    reject_symlink(&temporary, "临时文件")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("无法创建临时文件: {error}"))?;
    if let Err(error) = file.write_all(contents).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法完成原子写入: {error}"));
    }
    drop(file);
    let result = fs::rename(&temporary, target);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("无法替换目标文件: {error}"))
}

fn clear_recovery_journal_path(project_dir: &Path) -> Result<bool, String> {
    let path = project_file(project_dir, ".workspace/recovery.json")?;
    reject_symlink(&path, "恢复日志")?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法清理恢复日志: {error}")),
    }
}

fn sha256_hex(contents: &[u8]) -> String {
    let digest = Sha256::digest(contents);
    let mut checksum = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(checksum, "{byte:02x}");
    }
    checksum
}

fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    let value = value.trim();
    let encoded = value
        .split_once(",")
        .filter(|(prefix, _)| prefix.to_ascii_lowercase().contains(";base64"))
        .map(|(_, body)| body)
        .unwrap_or(value);
    BASE64
        .decode(encoded)
        .map_err(|error| format!("素材字节不是有效的 base64: {error}"))
}

fn encode_base64(contents: &[u8]) -> String {
    BASE64.encode(contents)
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    reject_symlink(path, "项目文件")?;
    let contents =
        fs::read_to_string(path).map_err(|error| format!("无法读取项目文件: {error}"))?;
    let value: Value =
        serde_json::from_str(&contents).map_err(|error| format!("项目 JSON 无效: {error}"))?;
    reject_sensitive(&value)?;
    Ok(value)
}

fn validate_project(value: &Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("项目数据必须是 JSON 对象".into());
    }
    reject_sensitive(value)
}

fn read_project_state(project_dir: &Path) -> Result<(Value, FileFingerprint), String> {
    let path = project_file(project_dir, "project.json")?;
    if !path.exists() {
        return Err("项目目录中没有 project.json".into());
    }
    reject_symlink(&path, "项目文件")?;
    let contents = fs::read(&path).map_err(|error| format!("无法读取项目文件: {error}"))?;
    let value: Value =
        serde_json::from_slice(&contents).map_err(|error| format!("项目 JSON 无效: {error}"))?;
    validate_project(&value)?;
    let mtime_ms = fs::metadata(&path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64);
    let fingerprint = FileFingerprint {
        exists: true,
        mtime_ms,
        size: Some(contents.len() as u64),
        hash: Some(sha256_hex(&contents)),
    };
    Ok((value, fingerprint))
}

fn read_project_value(project_dir: &Path) -> Result<Value, String> {
    read_project_state(project_dir).map(|(project, _)| project)
}

fn project_fingerprint(project_dir: &Path) -> Result<FileFingerprint, String> {
    let path = project_file(project_dir, "project.json")?;
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileFingerprint {
                exists: false,
                mtime_ms: None,
                size: None,
                hash: None,
            })
        }
        Err(error) => return Err(format!("无法检查 project.json: {error}")),
    };
    let contents = fs::read(&path).map_err(|error| format!("无法读取 project.json: {error}"))?;
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64);
    Ok(FileFingerprint {
        exists: true,
        mtime_ms,
        size: Some(contents.len() as u64),
        hash: Some(sha256_hex(&contents)),
    })
}

fn fingerprints_differ(left: &FileFingerprint, right: &FileFingerprint) -> bool {
    left.exists != right.exists || left.size != right.size || left.hash != right.hash
}

fn store_project_baseline(
    project_dir: &Path,
    fingerprint: FileFingerprint,
    project: Option<Value>,
) -> Result<(), String> {
    let directory =
        fs::canonicalize(project_dir).map_err(|error| format!("无法解析项目目录: {error}"))?;
    project_baselines().lock().unwrap().insert(
        directory,
        ProjectBaseline {
            fingerprint,
            project,
        },
    );
    Ok(())
}

fn set_project_baseline(project_dir: &Path, project: Option<Value>) -> Result<(), String> {
    let fingerprint = project_fingerprint(project_dir)?;
    store_project_baseline(project_dir, fingerprint, project)
}

fn external_conflict_error(
    baseline: Option<&FileFingerprint>,
    current: &FileFingerprint,
) -> String {
    json!({
        "error": {
            "code": "external_modification_conflict",
            "user_message": "课程文件在其他地方发生了变化，保存已暂停以免覆盖内容。课程内容没有改变，你可以继续查看；请重新载入、自动合并，或明确保留本地版本。",
            "technical_message": "Refusing to overwrite an externally modified canonical project",
            "severity": "blocking",
            "recoverable": true,
            "recommended_action": "查看差异，然后重新载入或合并修改。",
            "details": { "baseline": baseline, "current": current },
        }
    })
    .to_string()
}

fn ensure_no_external_modification(project_dir: &Path) -> Result<FileFingerprint, String> {
    let directory =
        fs::canonicalize(project_dir).map_err(|error| format!("无法解析项目目录: {error}"))?;
    let current = project_fingerprint(&directory)?;
    let baseline = project_baselines().lock().unwrap().get(&directory).cloned();
    let changed = baseline
        .as_ref()
        .map(|value| fingerprints_differ(&value.fingerprint, &current))
        .unwrap_or(current.exists);
    if changed {
        return Err(external_conflict_error(
            baseline.as_ref().map(|value| &value.fingerprint),
            &current,
        ));
    }
    Ok(current)
}

fn diff_json_values(before: &Value, after: &Value, path: &str, entries: &mut Vec<Value>) {
    if before == after {
        return;
    }
    match (before, after) {
        (Value::Object(left), Value::Object(right)) => {
            let mut keys: Vec<&String> = left.keys().chain(right.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let child_path = if path.is_empty() {
                    key.to_owned()
                } else {
                    format!("{path}.{key}")
                };
                diff_json_values(
                    left.get(key).unwrap_or(&Value::Null),
                    right.get(key).unwrap_or(&Value::Null),
                    &child_path,
                    entries,
                );
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            let length = left.len().max(right.len());
            for index in 0..length {
                diff_json_values(
                    left.get(index).unwrap_or(&Value::Null),
                    right.get(index).unwrap_or(&Value::Null),
                    &format!("{path}[{index}]"),
                    entries,
                );
            }
        }
        _ => entries.push(json!({ "path": path, "before": before, "after": after })),
    }
}

fn project_diff(before: Option<&Value>, after: Option<&Value>) -> Value {
    let mut entries = Vec::new();
    match (before, after) {
        (Some(before), Some(after)) => diff_json_values(before, after, "", &mut entries),
        (None, None) => {}
        (before, after) => entries.push(json!({ "path": "", "before": before, "after": after })),
    }
    json!({ "changed": !entries.is_empty(), "entries": entries })
}

fn merge_json_values(
    base: &Value,
    local: &Value,
    external: &Value,
    path: &str,
    conflicts: &mut Vec<Value>,
) -> Value {
    if local == external {
        return local.clone();
    }
    if local == base {
        return external.clone();
    }
    if external == base {
        return local.clone();
    }
    // updated_at is derived merge metadata. It must not turn otherwise
    // independent local and external edits into a content conflict.
    if path == "project.updated_at" {
        return match (local.as_str(), external.as_str()) {
            (Some(local), Some(external)) if external > local => Value::String(external.into()),
            _ => local.clone(),
        };
    }
    if let (Value::Object(base), Value::Object(local), Value::Object(external)) =
        (base, local, external)
    {
        let mut keys: Vec<&String> = base
            .keys()
            .chain(local.keys())
            .chain(external.keys())
            .collect();
        keys.sort();
        keys.dedup();
        let mut merged = Map::new();
        for key in keys {
            let child_path = if path.is_empty() {
                key.to_owned()
            } else {
                format!("{path}.{key}")
            };
            let value = merge_json_values(
                base.get(key).unwrap_or(&Value::Null),
                local.get(key).unwrap_or(&Value::Null),
                external.get(key).unwrap_or(&Value::Null),
                &child_path,
                conflicts,
            );
            if !value.is_null() || local.contains_key(key) || external.contains_key(key) {
                merged.insert(key.to_owned(), value);
            }
        }
        return Value::Object(merged);
    }
    conflicts.push(json!({ "path": path, "base": base, "local": local, "external": external }));
    local.clone()
}

fn external_modification_report(
    project_dir: &Path,
    local: Option<&Value>,
) -> Result<Value, String> {
    let directory =
        fs::canonicalize(project_dir).map_err(|error| format!("无法解析项目目录: {error}"))?;
    let current = project_fingerprint(&directory)?;
    let baseline = project_baselines().lock().unwrap().get(&directory).cloned();
    let changed = baseline
        .as_ref()
        .map(|value| fingerprints_differ(&value.fingerprint, &current))
        .unwrap_or(current.exists);
    let external = if current.exists {
        read_project_value(&directory).ok()
    } else {
        None
    };
    Ok(json!({
        "changed": changed,
        "baseline": baseline.as_ref().map(|value| &value.fingerprint),
        "current": current,
        "external": external,
        "external_diff": project_diff(
            baseline.as_ref().and_then(|value| value.project.as_ref()),
            external.as_ref(),
        ),
        "local_diff": project_diff(
            baseline.as_ref().and_then(|value| value.project.as_ref()),
            local,
        ),
    }))
}

fn write_project_value_with_warning_unlocked(
    project_dir: &Path,
    project: &Value,
) -> Result<Option<String>, String> {
    validate_project(project)?;
    ensure_no_external_modification(project_dir)?;
    let contents = serde_json::to_string_pretty(project).map_err(|error| error.to_string())? + "\n";
    let path = project_file(project_dir, "project.json")?;
    // Compare again after serialization and immediately before replacement.
    ensure_no_external_modification(project_dir)?;
    atomic_write_path(&path, &contents, true)?;
    let mtime_ms = fs::metadata(&path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64);
    // Keep the identity of the exact bytes written. If an external process
    // races immediately after rename, the next write still compares against
    // our content hash instead of accidentally adopting the raced version.
    store_project_baseline(
        project_dir,
        FileFingerprint {
            exists: true,
            mtime_ms,
            size: Some(contents.len() as u64),
            hash: Some(sha256_hex(contents.as_bytes())),
        },
        Some(project.clone()),
    )?;
    // A successful canonical write makes the recovery copy stale.  Cleanup
    // failure is a warning because the canonical write already succeeded.
    match clear_recovery_journal_path(project_dir) {
        Ok(_) => Ok(None),
        Err(error) => Ok(Some(format!("恢复日志清理失败，但项目已保存：{error}"))),
    }
}

fn write_project_value_with_warning(
    project_dir: &Path,
    project: &Value,
) -> Result<Option<String>, String> {
    let _lease_guard = require_active_project_lock(project_dir)?;
    write_project_value_with_warning_unlocked(project_dir, project)
}

fn write_project_value_unlocked(project_dir: &Path, project: &Value) -> Result<(), String> {
    write_project_value_with_warning_unlocked(project_dir, project).map(|_| ())
}

fn write_project_value(project_dir: &Path, project: &Value) -> Result<(), String> {
    write_project_value_with_warning(project_dir, project).map(|_| ())
}

fn touch_project_updated_at(project: &mut Value) -> Result<(), String> {
    project
        .get_mut("project")
        .and_then(Value::as_object_mut)
        .ok_or("项目缺少 project 对象")?
        .insert("updated_at".into(), Value::String(rfc3339_now()));
    Ok(())
}

#[tauri::command]
fn project_open(project_dir: String) -> Result<Option<Value>, String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let already_open = project_lock_registered(&project_dir, current_app_instance_id());
    acquire_project_lock(&project_dir)?;
    let path = match project_file(&project_dir, "project.json") {
        Ok(path) => path,
        Err(error) => {
            if !already_open {
                let _ = release_project_lock(&project_dir);
            }
            return Err(error);
        }
    };
    if !path.exists() {
        if !already_open {
            let _ = release_project_lock(&project_dir);
        }
        return Ok(None);
    }
    match read_project_state(&project_dir) {
        Ok((project, fingerprint)) => {
            if let Err(error) =
                store_project_baseline(&project_dir, fingerprint, Some(project.clone()))
            {
                if !already_open {
                    let _ = release_project_lock(&project_dir);
                }
                return Err(error);
            }
            Ok(Some(project))
        }
        Err(error) => {
            if !already_open {
                let _ = release_project_lock(&project_dir);
            }
            Err(error)
        }
    }
}

/// Compatibility name for the browser shell. It still requires an explicit
/// project directory; it never falls back to app-local-data.
#[tauri::command]
fn read_project(project_dir: String) -> Result<Option<Value>, String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let path = project_file(&project_dir, "project.json")?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(read_project_value(&project_dir)?))
}

#[tauri::command]
fn project_save(project_dir: String, project: Value) -> Result<(), String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    write_project_value_unlocked(&project_dir, &project)
}

#[tauri::command]
fn project_create(project_dir: String, project: Value) -> Result<(), String> {
    let project_dir = explicit_project_dir(&project_dir, true)?;
    let already_open = project_lock_registered(&project_dir, current_app_instance_id());
    acquire_project_lock(&project_dir)?;
    if !already_open {
        let current = project_fingerprint(&project_dir)?;
        if current.exists {
            let _ = release_project_lock(&project_dir);
            return Err(external_conflict_error(None, &current));
        }
        set_project_baseline(&project_dir, None)?;
    }
    match write_project_value(&project_dir, &project) {
        Ok(()) => Ok(()),
        Err(error) => {
            if !already_open {
                let _ = release_project_lock(&project_dir);
            }
            Err(error)
        }
    }
}

#[tauri::command]
fn project_external_status(project_dir: String, project: Option<Value>) -> Result<Value, String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    external_modification_report(&project_dir, project.as_ref())
}

#[tauri::command]
fn project_reload(project_dir: String) -> Result<Value, String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    let (project, fingerprint) = read_project_state(&project_dir)?;
    store_project_baseline(&project_dir, fingerprint, Some(project.clone()))?;
    Ok(project)
}

#[tauri::command]
fn project_merge(project_dir: String, project: Value) -> Result<Value, String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    validate_project(&project)?;
    let directory =
        fs::canonicalize(&project_dir).map_err(|error| format!("无法解析项目目录: {error}"))?;
    let baseline = project_baselines()
        .lock()
        .unwrap()
        .get(&directory)
        .cloned()
        .ok_or("项目缺少打开时基线，请重新载入项目")?;
    let external = read_project_value(&directory)?;
    let base = baseline.project.ok_or("项目缺少可合并的打开时快照")?;
    let mut conflicts = Vec::new();
    let merged = merge_json_values(&base, &project, &external, "", &mut conflicts);
    validate_project(&merged)?;
    Ok(json!({
        "can_apply": conflicts.is_empty(),
        "conflicts": conflicts,
        "merged": merged,
    }))
}

#[tauri::command]
fn project_resolve(
    project_dir: String,
    project: Value,
    expected_current: Value,
) -> Result<Value, String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    validate_project(&project)?;
    let current = project_fingerprint(&project_dir)?;
    let expected_exists = expected_current
        .get("exists")
        .and_then(Value::as_bool)
        .ok_or("冲突处理缺少 expected_current.exists")?;
    let expected_hash = expected_current.get("hash").and_then(Value::as_str);
    if current.exists != expected_exists || current.hash.as_deref() != expected_hash {
        return Err(external_conflict_error(None, &current));
    }
    let external = if current.exists {
        Some(read_project_value(&project_dir)?)
    } else {
        None
    };
    project_baselines().lock().unwrap().insert(
        fs::canonicalize(&project_dir).map_err(|error| format!("无法解析项目目录: {error}"))?,
        ProjectBaseline {
            fingerprint: current,
            project: external,
        },
    );
    write_project_value_unlocked(&project_dir, &project)?;
    Ok(project)
}

#[tauri::command]
fn project_close(project_dir: String) -> Result<(), String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    release_project_lock(&project_dir)
}

#[tauri::command]
fn confirm_close(app: AppHandle) -> Result<(), String> {
    EXIT_READY.store(true, Ordering::Release);
    app.exit(0);
    Ok(())
}

fn picker_result(kind: &str, status: &str, path: Option<&Path>) -> Value {
    json!({
        "status": status,
        "kind": kind,
        "path": path.map(|value| value.to_string_lossy().into_owned()),
    })
}

fn picker_kind(command: &str) -> &'static str {
    match command {
        "select_file" => "file",
        "select_folder" => "folder",
        _ => "export",
    }
}

fn validate_picker_path(path: PathBuf, command: &str) -> Result<Value, String> {
    let kind = picker_kind(command);
    if !path.is_absolute() {
        return Err("选择路径必须是用户明确选择的绝对路径".into());
    }
    reject_symlink(&path, "选择路径")?;
    if command == "select_export_path" {
        let parent = path.parent().ok_or("导出目标父目录无效")?;
        let parent = ensure_directory(parent, "导出目标目录")?;
        if path.exists() {
            let metadata =
                fs::metadata(&path).map_err(|error| format!("无法读取导出目标: {error}"))?;
            if metadata.is_dir() {
                return Err("导出目标必须是文件路径".into());
            }
        }
        let target = parent.join(path.file_name().ok_or("导出目标文件名无效")?);
        reject_symlink(&target, "导出目标")?;
        return Ok(picker_result(kind, "selected", Some(&target)));
    }
    let metadata = fs::metadata(&path).map_err(|error| format!("无法读取选择路径: {error}"))?;
    let matches = if command == "select_file" {
        metadata.is_file()
    } else {
        metadata.is_dir()
    };
    if !matches {
        return Err(if command == "select_file" {
            "选择路径不是文件".into()
        } else {
            "选择路径不是目录".into()
        });
    }
    let canonical =
        fs::canonicalize(&path).map_err(|error| format!("无法解析选择路径: {error}"))?;
    reject_symlink(&canonical, "选择路径")?;
    Ok(picker_result(kind, "selected", Some(&canonical)))
}

fn has_explicit_picker_result(input: &Value) -> bool {
    input
        .as_object()
        .map(|object| {
            object.get("cancelled").is_some()
                || field(
                    object,
                    &[
                        "path",
                        "selected_path",
                        "file_path",
                        "folder_path",
                        "target_path",
                    ],
                )
                .is_some()
        })
        .unwrap_or(false)
}

fn picker_path(input: Option<Value>, command: &str) -> Result<Value, String> {
    let input = input.unwrap_or_else(|| json!({}));
    let object = require_object(&input, command)?;
    let kind = picker_kind(command);
    if object
        .get("cancelled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(picker_result(kind, "cancelled", None));
    }
    let path_value = field(
        object,
        &[
            "path",
            "selected_path",
            "file_path",
            "folder_path",
            "target_path",
        ],
    );
    let Some(raw) = path_value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(json!({
            "status": "unsupported",
            "kind": kind,
            "path": null,
            "error": {
                "code": "native_picker_unavailable",
                "user_message": "当前原生壳未安装系统文件选择器；请由上层选择器传入明确路径。",
                "recoverable": true,
            },
        }));
    };
    if raw.is_empty() {
        return Ok(picker_result(kind, "cancelled", None));
    }
    validate_picker_path(PathBuf::from(raw), command)
}

fn dialog_picker(app: &AppHandle, command: &str, input: &Value) -> Result<Value, String> {
    let selected = match command {
        "select_file" => app.dialog().file().blocking_pick_file(),
        "select_folder" => app.dialog().file().blocking_pick_folder(),
        "select_export_path" => {
            let mut builder = app.dialog().file();
            if let Some(object) = input.as_object() {
                if let Some(name) = field(object, &["default_name", "defaultName", "filename"])
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    builder = builder.set_file_name(safe_asset_filename(name));
                }
                if let Some(directory) = field(object, &["project_dir", "projectDir"])
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    let directory = Path::new(directory);
                    if directory.is_absolute()
                        && fs::metadata(directory)
                            .map(|metadata| metadata.is_dir())
                            .unwrap_or(false)
                        && reject_symlink(directory, "导出初始目录").is_ok()
                    {
                        builder = builder.set_directory(directory);
                    }
                }
            }
            builder.blocking_save_file()
        }
        _ => return Err(format!("未知选择器命令: {command}")),
    };
    let Some(selected) = selected else {
        return Ok(picker_result(picker_kind(command), "cancelled", None));
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("无法解析系统选择路径: {error}"))?;
    validate_picker_path(path, command)
}

/// Explicit paths remain a deterministic adapter for tests and headless
/// callers. Normal desktop calls use the Tauri dialog plugin below.
#[tauri::command]
async fn select_file(app: AppHandle, input: Option<Value>) -> Result<Value, String> {
    let input = input.unwrap_or_else(|| json!({}));
    if has_explicit_picker_result(&input) {
        return picker_path(Some(input), "select_file");
    }
    dialog_picker(&app, "select_file", &input)
}

#[tauri::command]
async fn select_folder(app: AppHandle, input: Option<Value>) -> Result<Value, String> {
    let input = input.unwrap_or_else(|| json!({}));
    if has_explicit_picker_result(&input) {
        return picker_path(Some(input), "select_folder");
    }
    dialog_picker(&app, "select_folder", &input)
}

#[tauri::command]
async fn select_export_path(app: AppHandle, input: Option<Value>) -> Result<Value, String> {
    let input = input.unwrap_or_else(|| json!({}));
    if has_explicit_picker_result(&input) {
        return picker_path(Some(input), "select_export_path");
    }
    dialog_picker(&app, "select_export_path", &input)
}

#[tauri::command]
fn bridge_status(state: State<'_, BridgeState>) -> BridgeStatus {
    BridgeStatus {
        mode: "tauri",
        address: "loopback-only",
        token_configured: !state.token.is_empty(),
        message: "仅接受本机、已配对来源和白名单动作",
    }
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(left.as_bytes().get(index).copied().unwrap_or(0))
            ^ usize::from(right.as_bytes().get(index).copied().unwrap_or(0));
    }
    difference == 0
}

fn allowed_origin(origin: &str) -> bool {
    let origin = origin.trim();
    if origin == "tauri://localhost" {
        return true;
    }
    let Some((scheme, authority)) = origin.split_once("://") else {
        return false;
    };
    if !matches!(scheme, "http" | "https")
        || authority.is_empty()
        || authority.contains('/')
        || authority.contains('@')
        || authority.contains('?')
        || authority.contains('#')
    {
        return false;
    }
    if authority == "localhost" || authority == "127.0.0.1" || authority == "[::1]" {
        return true;
    }
    if authority.starts_with("localhost:")
        || authority.starts_with("127.0.0.1:")
        || authority.starts_with("[::1]:")
    {
        let port = authority.rsplit(':').next().unwrap_or_default();
        return !port.is_empty() && port.chars().all(|character| character.is_ascii_digit());
    }
    false
}

fn require_bridge_request(
    state: &BridgeState,
    value: &Value,
    expected_action: &str,
) -> Result<(), String> {
    let object = value.as_object().ok_or("浏览器桥接请求必须是结构化对象")?;
    let token = required_string(object, &["token", "pairing_token"], "桥接令牌")?;
    if state.token.is_empty() {
        return Err("浏览器桥接令牌暂不可用".into());
    }
    if !constant_time_equal(&state.token, &token) {
        return Err("浏览器桥接令牌无效".into());
    }
    let origin = required_string(object, &["origin"], "来源")?;
    if !allowed_origin(&origin) {
        return Err("浏览器桥接只允许本机来源".into());
    }
    let action = required_string(object, &["action"], "动作")?;
    if action != expected_action {
        return Err("浏览器桥接动作不在白名单内".into());
    }
    for (key, child) in object {
        if !matches!(
            key.as_str(),
            "token" | "pairing_token" | "origin" | "action"
        ) {
            reject_sensitive(child)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn bridge_capture_page(state: State<'_, BridgeState>, input: Value) -> Result<Value, String> {
    require_bridge_request(&state, &input, "capture_page")?;
    Ok(json!({
        "status": "validated",
        "action": "capture_page",
        "performed": false,
        "message": "边界校验通过，页面捕获适配器尚未安装"
    }))
}

#[tauri::command]
fn bridge_send_selection(state: State<'_, BridgeState>, input: Value) -> Result<Value, String> {
    require_bridge_request(&state, &input, "send_selection")?;
    Ok(json!({
        "status": "validated",
        "action": "send_selection",
        "performed": false,
        "message": "边界校验通过，收件箱适配器尚未安装"
    }))
}

fn snapshot_directory(project_dir: &Path) -> Result<PathBuf, String> {
    ensure_directory(&project_dir.join(".workspace"), "项目工作区目录")
        .and_then(|workspace| ensure_directory(&workspace.join("snapshots"), "历史版本目录"))
}

fn valid_snapshot_id(snapshot_id: &str) -> bool {
    !snapshot_id.is_empty()
        && snapshot_id.len() <= 128
        && snapshot_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn snapshot_envelope(snapshot_id: String, name: String, note: String, project: Value) -> Value {
    json!({
        "id": snapshot_id,
        "name": name,
        "note": note,
        "created_at": unix_millis().to_string(),
        "project": project,
    })
}

fn write_snapshot_unlocked(
    project_dir: &Path,
    snapshot_id: String,
    name: String,
    note: String,
    project: Value,
) -> Result<Value, String> {
    if !valid_snapshot_id(&snapshot_id) {
        return Err("历史版本编号无效".into());
    }
    validate_project(&project)?;
    let envelope = snapshot_envelope(snapshot_id, name, note, project);
    reject_sensitive(&envelope)?;
    let directory = snapshot_directory(project_dir)?;
    let id = envelope
        .get("id")
        .and_then(Value::as_str)
        .ok_or("历史版本编号缺失")?;
    let path = directory.join(format!("{id}.json"));
    atomic_write_path(
        &path,
        &(serde_json::to_string_pretty(&envelope).map_err(|error| error.to_string())? + "\n"),
        false,
    )?;
    Ok(envelope)
}

fn write_snapshot(
    project_dir: &Path,
    snapshot_id: String,
    name: String,
    note: String,
    project: Value,
) -> Result<Value, String> {
    let _lease_guard = require_active_project_lock(project_dir)?;
    ensure_no_external_modification(project_dir)?;
    write_snapshot_unlocked(project_dir, snapshot_id, name, note, project)
}

#[tauri::command]
fn create_snapshot(
    project_dir: String,
    snapshot_id: Option<String>,
    name: String,
    note: String,
    project: Value,
) -> Result<Value, String> {
    let project_dir = explicit_project_dir(&project_dir, true)?;
    let id = snapshot_id.unwrap_or_else(|| native_id("snapshot"));
    write_snapshot(&project_dir, id, name, note, project)
}

fn read_snapshot_envelope(project_dir: &Path, snapshot_id: &str) -> Result<Option<Value>, String> {
    if !valid_snapshot_id(snapshot_id) {
        return Err("历史版本编号无效".into());
    }
    let directory = snapshot_directory(project_dir)?;
    let path = directory.join(format!("{snapshot_id}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let value = read_json_file(&path)?;
    if value.get("id").is_some() && value.get("name").is_some() && value.get("project").is_some() {
        let project = value.get("project").ok_or("历史版本缺少项目数据")?;
        validate_project(project)?;
        return Ok(Some(value));
    }
    // Accept the earlier raw-project snapshot format for migration/restore.
    validate_project(&value)?;
    Ok(Some(snapshot_envelope(
        snapshot_id.to_owned(),
        "历史版本".into(),
        "".into(),
        value,
    )))
}

#[tauri::command]
fn read_snapshot(project_dir: String, snapshot_id: String) -> Result<Option<Value>, String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    Ok(read_snapshot_envelope(&project_dir, &snapshot_id)?
        .and_then(|envelope| envelope.get("project").cloned()))
}

#[tauri::command]
fn list_snapshots(project_dir: String) -> Result<Value, String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let directory = snapshot_directory(&project_dir)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| format!("无法读取历史版本: {error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取历史版本条目: {error}"))?;
        let path = entry.path();
        reject_symlink(&path, "历史版本文件")?;
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(envelope) = read_snapshot_envelope(&project_dir, id)? else {
            continue;
        };
        entries.push(json!({
            "id": envelope.get("id").cloned().unwrap_or_else(|| json!(id)),
            "name": envelope.get("name").cloned().unwrap_or_else(|| json!("历史版本")),
            "note": envelope.get("note").cloned().unwrap_or_else(|| json!("")),
            "created_at": envelope.get("created_at").cloned().unwrap_or_else(|| json!("")),
        }));
    }
    entries.sort_by(|left, right| {
        right
            .get("created_at")
            .and_then(Value::as_str)
            .cmp(&left.get("created_at").and_then(Value::as_str))
    });
    Ok(Value::Array(entries))
}

#[tauri::command]
fn restore_snapshot(project_dir: String, snapshot_id: String) -> Result<Value, String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    ensure_no_external_modification(&project_dir)?;
    let current = read_project_value(&project_dir)?;
    let envelope =
        read_snapshot_envelope(&project_dir, &snapshot_id)?.ok_or("找不到这个历史版本")?;
    let mut restored = envelope
        .get("project")
        .cloned()
        .ok_or("历史版本缺少项目数据")?;
    let backup_id = native_id("restore-before");
    let backup = write_snapshot_unlocked(
        &project_dir,
        backup_id.clone(),
        "恢复前备份".into(),
        "恢复旧版本前自动创建".into(),
        current,
    )?;
    let restored_object = restored.as_object_mut().ok_or("历史版本项目数据格式无效")?;
    let snapshots = restored_object
        .entry("snapshots")
        .or_insert_with(|| Value::Array(Vec::new()));
    let snapshot_list = snapshots
        .as_array_mut()
        .ok_or("历史版本的 snapshots 格式无效")?;
    snapshot_list
        .retain(|snapshot| snapshot.get("id").and_then(Value::as_str) != Some(backup_id.as_str()));
    snapshot_list.insert(
        0,
        json!({
            "id": backup.get("id").cloned().unwrap_or_else(|| json!(backup_id)),
            "name": backup.get("name").cloned().unwrap_or_else(|| json!("恢复前备份")),
            "note": backup.get("note").cloned().unwrap_or_else(|| json!("恢复旧版本前自动创建")),
            "created_at": backup.get("created_at").cloned().unwrap_or_else(|| json!(unix_millis().to_string())),
        }),
    );
    write_project_value_unlocked(&project_dir, &restored)?;
    Ok(json!({ "restored": true, "snapshot_id": snapshot_id, "backup_snapshot_id": backup_id }))
}

fn source_path(value: &Value) -> Result<(PathBuf, PathBuf), String> {
    let object = value.as_object().ok_or("导入参数必须是结构化对象")?;
    let raw = required_string(object, &["path", "source_path"], "导入文件")?;
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("导入文件必须是用户明确选择的绝对路径".into());
    }
    reject_symlink(&path, "导入文件")?;
    let canonical =
        fs::canonicalize(&path).map_err(|error| format!("无法读取导入文件: {error}"))?;
    reject_symlink(&canonical, "导入文件")?;
    Ok((path, canonical))
}

fn file_kind(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" => "markdown",
        "txt" => "text",
        "json" => "json",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => "image",
        "mp4" | "mov" | "webm" => "video",
        "mp3" | "wav" | "m4a" => "audio",
        _ => "file",
    }
}

fn import_item(path: &Path) -> Result<Value, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取导入文件信息: {error}"))?;
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名输入");
    let kind = file_kind(path);
    let body = if matches!(kind, "markdown" | "text" | "json") && metadata.len() <= 10 * 1024 * 1024
    {
        fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    };
    Ok(json!({
        "name": path.file_name().and_then(|value| value.to_str()).unwrap_or("input"),
        "title": title,
        "kind": kind,
        "size_bytes": metadata.len(),
        "body": body,
    }))
}

fn preview_source(source: &Value) -> Result<Value, String> {
    let object = require_object(source, "import_preview")?;
    let (original, canonical) = source_path(source)?;
    let metadata =
        fs::metadata(&canonical).map_err(|error| format!("无法读取导入来源: {error}"))?;
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    if metadata.is_dir() {
        for entry in
            fs::read_dir(&canonical).map_err(|error| format!("无法读取导入目录: {error}"))?
        {
            let entry = entry.map_err(|error| format!("无法读取导入目录条目: {error}"))?;
            let path = entry.path();
            reject_symlink(&path, "导入目录条目")?;
            if path.is_file() {
                items.push(import_item(&path)?);
            }
        }
        warnings.push("目录导入只读取第一层文件，脚本和宏不会执行".to_owned());
    } else if metadata.is_file() {
        items.push(import_item(&canonical)?);
    } else {
        return Err("导入来源不是文件或目录".into());
    }
    Ok(json!({
        "requires_confirmation": true,
        "project_dir": field(object, &["project_dir", "projectDir"]).cloned().unwrap_or(Value::Null),
        "source_path": original,
        "items": items,
        "warnings": warnings,
        "errors": [],
    }))
}

#[tauri::command]
fn import_preview(source: Value) -> Result<Value, String> {
    preview_source(&source)
}

fn append_inbox_item(project: &mut Value, item: Value) -> Result<String, String> {
    let project_id = project
        .get("project")
        .and_then(|value| value.get("id"))
        .cloned()
        .unwrap_or(Value::Null);
    let object = project.as_object_mut().ok_or("项目数据必须是 JSON 对象")?;
    let list = object
        .entry("inbox_items")
        .or_insert_with(|| Value::Array(Vec::new()));
    let items = list.as_array_mut().ok_or("项目的收件箱数据格式无效")?;
    let id = native_id("inbox");
    let title = item
        .get("title")
        .cloned()
        .unwrap_or_else(|| json!("未命名输入"));
    let body = item.get("body").cloned().unwrap_or_else(|| json!(""));
    items.push(json!({
        "id": id,
        "project_id": project_id,
        "source_type": "file",
        "title": title,
        "body": body,
        "asset_id": null,
        "content_item_id": null,
        "status": "open",
        "created_at": unix_millis().to_string(),
        "updated_at": unix_millis().to_string(),
    }));
    Ok(id)
}

/// The Domain owns the seed/blueprint semantics (`src/domain/course.ts`), and
/// the browser shell reaches them through the service. The desktop shell has no
/// service process, so the two commands below mirror that module instead of
/// inventing a second product behaviour: same node derivation, same
/// content-type inference, and the same rule that a draft writes no formal
/// Stage/ContentItem rows.
fn uuid_v4() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("无法生成标识: {error}"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

fn seed_content_type(title: &str) -> &'static str {
    let normalized = title.to_lowercase();
    if normalized.contains("练习") || normalized.contains("exercise") {
        return "exercise";
    }
    if normalized.contains("案例") || normalized.contains("case") {
        return "case";
    }
    if normalized.contains("总结") || normalized.contains("summary") {
        return "summary";
    }
    if normalized.contains("测验") || normalized.contains("考试") || normalized.contains("assessment")
    {
        return "assessment";
    }
    if normalized.contains("参考") || normalized.contains("reference") {
        return "reference";
    }
    "lesson"
}

/// Mirrors `^(#{1,6}|\d+[.)])\s*(.+)$` from the Domain.
fn heading_title(line: &str) -> Option<String> {
    let hashes = line.chars().take_while(|value| *value == '#').count();
    if hashes >= 1 {
        let rest = line[hashes.min(6)..].trim_start();
        if !rest.is_empty() {
            return Some(rest.trim().to_string());
        }
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        let rest = &line[digits..];
        let mut chars = rest.chars();
        if matches!(chars.next(), Some('.') | Some(')')) {
            let tail = chars.as_str().trim_start();
            if !tail.is_empty() {
                return Some(tail.trim().to_string());
            }
        }
    }
    None
}

fn strip_list_marker(line: &str) -> String {
    let trimmed = line.trim();
    let mut chars = trimmed.chars();
    if let Some(first) = chars.next() {
        if matches!(first, '-' | '*' | '+') {
            return chars.as_str().trim_start().trim().to_string();
        }
    }
    trimmed.to_string()
}

fn first_meaningful_line(raw_text: &str) -> String {
    raw_text
        .split('\n')
        .map(|line| line.trim().trim_start_matches('#').trim())
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn seed_lines_to_nodes(raw_text: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw_text
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return vec![
            json!({
                "node_type": "stage",
                "title": "开始",
                "suggested_type": "stage_intro",
                "parent_index": Value::Null,
            }),
            json!({
                "node_type": "content",
                "title": "第一课",
                "suggested_type": "lesson",
                "parent_index": 0,
            }),
        ];
    }
    let mut nodes: Vec<Value> = Vec::new();
    let mut current_stage: Option<usize> = None;
    for line in lines {
        if let Some(title) = heading_title(line) {
            current_stage = Some(nodes.len());
            nodes.push(json!({
                "node_type": "stage",
                "title": title,
                "suggested_type": "stage_intro",
                "parent_index": Value::Null,
            }));
            continue;
        }
        let stage_index = match current_stage {
            Some(index) => index,
            None => {
                let index = nodes.len();
                nodes.push(json!({
                    "node_type": "stage",
                    "title": "课程内容",
                    "suggested_type": "stage_intro",
                    "parent_index": Value::Null,
                }));
                current_stage = Some(index);
                index
            }
        };
        nodes.push(json!({
            "node_type": "content",
            "title": strip_list_marker(line),
            "suggested_type": seed_content_type(line),
            "parent_index": stage_index,
        }));
    }
    nodes
}

#[tauri::command]
fn course_seed_create(input: Value) -> Result<Value, String> {
    let object = require_object(&input, "course_seed_create")?;
    let project_dir = required_string(object, &["project_dir", "projectDir"], "项目目录")?;
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    let source_type = required_string(object, &["source_type", "sourceType"], "课程输入类型")?;
    let raw_text = field(object, &["raw_text", "rawText"])
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut project = read_project_value(&project_dir)?;
    let seed = json!({
        "id": uuid_v4()?,
        // The Domain keeps the pointer empty until the map is confirmed.
        "project_id": Value::Null,
        "source_type": source_type,
        "raw_text": raw_text,
        "source_files": [],
        "metadata": {},
        "created_at": rfc3339_now(),
    });
    {
        let map = project.as_object_mut().ok_or("项目数据必须是 JSON 对象")?;
        map.entry("course_seeds")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or("项目的课程输入数据格式无效")?
            .push(seed.clone());
    }
    touch_project_updated_at(&mut project)?;
    write_project_value_unlocked(&project_dir, &project)?;
    Ok(seed)
}

#[tauri::command]
fn blueprint_build(input: Value) -> Result<Value, String> {
    let object = require_object(&input, "blueprint_build")?;
    let project_dir = required_string(object, &["project_dir", "projectDir"], "项目目录")?;
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    let course_seed_id = required_string(object, &["course_seed_id", "courseSeedId"], "课程输入")?;
    let mut project = read_project_value(&project_dir)?;
    let seed = project
        .get("course_seeds")
        .and_then(Value::as_array)
        .and_then(|seeds| {
            seeds.iter().find(|seed| {
                seed.get("id").and_then(Value::as_str) == Some(course_seed_id.as_str())
            })
        })
        .cloned()
        .ok_or_else(|| format!("找不到课程输入: {course_seed_id}"))?;
    let raw_text = seed
        .get("raw_text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let metadata_title = seed
        .get("metadata")
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let title = if !metadata_title.is_empty() {
        metadata_title
    } else {
        let first = first_meaningful_line(&raw_text);
        if first.is_empty() {
            "未命名课程".to_string()
        } else {
            first
        }
    };
    let draft_id = uuid_v4()?;
    let draft = json!({
        "id": draft_id.clone(),
        "course_seed_id": course_seed_id,
        "title": title,
        "status": "draft",
        "created_at": rfc3339_now(),
        "confirmed_at": Value::Null,
    });
    let mut node_ids: Vec<Value> = Vec::new();
    let mut nodes: Vec<Value> = Vec::new();
    for (index, node) in seed_lines_to_nodes(&raw_text).iter().enumerate() {
        let parent_id = node
            .get("parent_index")
            .and_then(Value::as_u64)
            .map(|parent| {
                node_ids
                    .get(parent as usize)
                    .cloned()
                    .unwrap_or(Value::Null)
            })
            .unwrap_or(Value::Null);
        let node_id = uuid_v4()?;
        nodes.push(json!({
            "id": node_id,
            "blueprint_id": draft_id,
            "parent_id": parent_id,
            "node_type": node.get("node_type").cloned().unwrap_or_else(|| json!("content")),
            "title": node.get("title").cloned().unwrap_or_else(|| json!("")),
            "suggested_type": node.get("suggested_type").cloned().unwrap_or_else(|| json!("lesson")),
            "order_index": index,
        }));
        node_ids.push(json!(node_id));
    }
    {
        let map = project.as_object_mut().ok_or("项目数据必须是 JSON 对象")?;
        map.entry("blueprint_drafts")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or("项目的课程草稿数据格式无效")?
            .push(draft.clone());
        map.entry("blueprint_nodes")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or("项目的课程节点数据格式无效")?
            .extend(nodes.iter().cloned());
    }
    touch_project_updated_at(&mut project)?;
    write_project_value_unlocked(&project_dir, &project)?;
    Ok(json!({ "draft": draft, "nodes": nodes }))
}

#[tauri::command]
fn import_confirm(preview: Value) -> Result<Value, String> {
    let object = require_object(&preview, "import_confirm")?;
    if !object
        .get("confirmed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("导入必须先确认预览结果".into());
    }
    let project_dir = required_string(object, &["project_dir", "projectDir"], "项目目录")?;
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    let source = preview_source(&json!({
        "project_dir": project_dir,
        "path": required_string(object, &["source_path", "path"], "导入文件")?,
    }))?;
    let source_path_value = source
        .get("source_path")
        .and_then(Value::as_str)
        .ok_or("导入来源缺失")?;
    let (_, canonical) = source_path(&json!({ "path": source_path_value }))?;
    let metadata =
        fs::metadata(&canonical).map_err(|error| format!("无法读取导入来源: {error}"))?;
    let mut project = read_project_value(&project_dir)?;
    let mut imported = Vec::new();
    if metadata.is_dir() {
        for entry in
            fs::read_dir(&canonical).map_err(|error| format!("无法读取导入目录: {error}"))?
        {
            let entry = entry.map_err(|error| format!("无法读取导入目录条目: {error}"))?;
            let path = entry.path();
            reject_symlink(&path, "导入目录条目")?;
            if path.is_file() {
                imported.push(append_inbox_item(&mut project, import_item(&path)?)?);
            }
        }
    } else {
        imported.push(append_inbox_item(&mut project, import_item(&canonical)?)?);
    }
    write_project_value_unlocked(&project_dir, &project)?;
    Ok(json!({ "status": "confirmed", "imported_ids": imported, "count": imported.len() }))
}

fn export_format(preset: &Value) -> Result<String, String> {
    let object = preset.as_object().ok_or("导出预设必须是结构化对象")?;
    let format = field(object, &["format", "output_type", "target_type"])
        .and_then(Value::as_str)
        .unwrap_or("json")
        .to_ascii_lowercase();
    let format = match format.as_str() {
        "json" | "project_json" | "json_project" => "json",
        "md" | "markdown" => "markdown",
        "html" | "semantic_html" => "html",
        "web" | "static_web" | "web_package" => "web",
        "wechat" | "wechat_html" | "rich_text" => "wechat",
        "pdf" => "pdf",
        "asset" | "assets" | "asset_package" => "asset_package",
        "package" | "full_package" | "full_project" => "full_project",
        _ => return Err("当前原生导出不支持这个格式".into()),
    };
    Ok(format.into())
}

fn output_filename(preset: &Value, project: &Value, format: &str) -> String {
    let requested = preset
        .get("filename")
        .or_else(|| preset.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            project
                .get("project")
                .and_then(|value| value.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("course")
        });
    let mut filename = String::new();
    for character in requested.chars() {
        if character.is_ascii_alphanumeric()
            || matches!(character, '-' | '_' | '.' | ' ' | '中'..='龥')
        {
            filename.push(character);
        } else {
            filename.push('_');
        }
    }
    let filename = filename.trim().trim_matches('.');
    let filename = if filename.is_empty() {
        "course"
    } else {
        filename
    };
    let extension = match format {
        "json" | "full_project" | "asset_package" => "json",
        "markdown" => "md",
        "pdf" => "pdf",
        "web" => "web",
        _ => "html",
    };
    if filename.ends_with(&format!(".{extension}")) {
        filename.to_owned()
    } else {
        format!("{filename}.{extension}")
    }
}

fn text_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn block_content(block: &Value) -> String {
    match block.get("content") {
        Some(Value::Object(object)) => field(object, &["text", "value", "markdown", "url"])
            .map(|value| text_value(Some(value)))
            .unwrap_or_else(|| serde_json::to_string(object).unwrap_or_default()),
        value => text_value(value),
    }
}

fn is_layout_only_requirement(project: &Value, block_id: &str) -> bool {
    project
        .get("requirements")
        .and_then(Value::as_array)
        .map(|requirements| {
            requirements.iter().any(|requirement| {
                requirement.get("scope").and_then(Value::as_str) == Some("layout")
                    && requirement.get("anchor_block_id").and_then(Value::as_str) == Some(block_id)
            })
        })
        .unwrap_or(false)
}

fn project_blocks<'a>(project: &'a Value, document_id: &str) -> Vec<&'a Value> {
    let mut blocks: Vec<&Value> = project
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("document_id").and_then(Value::as_str) == Some(document_id))
        .collect();
    blocks.sort_by_key(|block| {
        block
            .get("order_index")
            .and_then(Value::as_i64)
            .unwrap_or(0)
    });
    blocks
}

fn asset_selected_for_content(
    project: &Value,
    asset_id: &str,
    content_item_id: Option<&str>,
) -> bool {
    let used_by_content = project
        .get("asset_usages")
        .and_then(Value::as_array)
        .map(|usages| {
            usages.iter().any(|usage| {
                usage.get("asset_id").and_then(Value::as_str) == Some(asset_id)
                    && content_item_id.is_none_or(|content_item_id| {
                        usage.get("content_item_id").and_then(Value::as_str)
                            == Some(content_item_id)
                    })
            })
        })
        .unwrap_or(false);
    let resolved_by_content = project
        .get("requirements")
        .and_then(Value::as_array)
        .map(|requirements| {
            requirements.iter().any(|requirement| {
                requirement.get("resolved_asset_id").and_then(Value::as_str) == Some(asset_id)
                    && content_item_id.is_none_or(|content_item_id| {
                        requirement.get("content_item_id").and_then(Value::as_str)
                            == Some(content_item_id)
                    })
            })
        })
        .unwrap_or(false);
    used_by_content || resolved_by_content
}

fn block_asset<'a>(project: &'a Value, block: &Value) -> Option<&'a Value> {
    let linked = block
        .get("settings")
        .and_then(|value| value.get("asset_id"))
        .and_then(Value::as_str);
    let content = block_content(block);
    project
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|asset| {
            !asset
                .get("archived")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && (linked.is_some_and(|id| asset.get("id").and_then(Value::as_str) == Some(id))
                    || asset.get("filename").and_then(Value::as_str) == Some(content.as_str())
                    || asset.get("storage_path").and_then(Value::as_str) == Some(content.as_str()))
        })
}

fn asset_is_inline(project: &Value, document_id: &str, asset_id: &str) -> bool {
    project_blocks(project, document_id).iter().any(|block| {
        block_asset(project, block)
            .and_then(|asset| asset.get("id"))
            .and_then(Value::as_str)
            == Some(asset_id)
    })
}

fn referenced_assets_for_content<'a>(project: &'a Value, content_item_id: &str) -> Vec<&'a Value> {
    let mut assets: Vec<&Value> = project
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|asset| {
            !asset
                .get("archived")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter(|asset| {
            asset
                .get("id")
                .and_then(Value::as_str)
                .map(|asset_id| {
                    asset_selected_for_content(project, asset_id, Some(content_item_id))
                })
                .unwrap_or(false)
        })
        .filter(|asset| {
            asset
                .get("storage_path")
                .and_then(Value::as_str)
                .map(|path| {
                    let path = Path::new(path);
                    !path.is_absolute()
                        && path
                            .components()
                            .all(|component| matches!(component, Component::Normal(_)))
                })
                .unwrap_or(false)
        })
        .collect();
    assets.sort_by_key(|asset| {
        (
            asset
                .get("filename")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            asset.get("id").and_then(Value::as_str).unwrap_or_default(),
        )
    });
    assets
}

fn markdown_for_project(project: &Value, content_item_id: Option<&str>) -> String {
    let mut lines = Vec::new();
    let title = project
        .get("project")
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("未命名课程");
    lines.push(format!("# {title}"));
    lines.push(String::new());
    if let Some(items) = project.get("content_items").and_then(Value::as_array) {
        let mut items: Vec<&Value> = items
            .iter()
            .filter(|item| {
                !item
                    .get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    && content_item_id.map_or(true, |id| {
                        item.get("id").and_then(Value::as_str) == Some(id)
                    })
            })
            .collect();
        items.sort_by_key(|item| item.get("order_index").and_then(Value::as_i64).unwrap_or(0));
        for item in items {
            let item_title = item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("未命名内容");
            lines.push(format!("## {item_title}"));
            lines.push(String::new());
            if let Some(document_id) = item.get("document_id").and_then(Value::as_str) {
                for block in project_blocks(project, document_id) {
                    if block
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|id| is_layout_only_requirement(project, id))
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    let content = block_content(block);
                    if content.is_empty() {
                        continue;
                    }
                    let block_type = block
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("paragraph");
                    match block_type {
                        "heading" => {
                            let level = block
                                .get("settings")
                                .and_then(|value| value.get("level"))
                                .and_then(Value::as_i64)
                                .unwrap_or(3)
                                .clamp(1, 6);
                            lines.push(format!("{} {content}", "#".repeat(level as usize)));
                        }
                        "quote" => lines.push(format!("> {content}")),
                        "code" => {
                            lines.push("```".into());
                            lines.push(content);
                            lines.push("```".into());
                        }
                        "divider" => lines.push("---".into()),
                        "placeholder" => continue,
                        "image" | "gif" | "video" | "audio" | "embed" => {
                            if let Some(asset) = block_asset(project, block) {
                                let title = asset
                                    .get("title")
                                    .or_else(|| asset.get("filename"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("素材")
                                    .replace('[', "\\[")
                                    .replace(']', "\\]");
                                let path = asset
                                    .get("storage_path")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default();
                                let image = matches!(
                                    asset.get("type").and_then(Value::as_str),
                                    Some("image" | "gif")
                                );
                                lines.push(format!(
                                    "{}[{title}]({path})",
                                    if image { "!" } else { "" }
                                ));
                            } else if !content.is_empty() {
                                lines.push(content);
                            }
                        }
                        _ => lines.push(content),
                    }
                    lines.push(String::new());
                }
            }
            if let Some(item_id) = item.get("id").and_then(Value::as_str) {
                let assets: Vec<&Value> =
                    referenced_assets_for_content(project, item_id)
                        .into_iter()
                        .filter(|asset| {
                            !item.get("document_id").and_then(Value::as_str).is_some_and(
                                |document_id| {
                                    asset.get("id").and_then(Value::as_str).is_some_and(
                                        |asset_id| asset_is_inline(project, document_id, asset_id),
                                    )
                                },
                            )
                        })
                        .collect();
                if !assets.is_empty() {
                    lines.push("### 素材".into());
                    lines.push(String::new());
                    for asset in assets {
                        let title = asset
                            .get("title")
                            .or_else(|| asset.get("filename"))
                            .and_then(Value::as_str)
                            .unwrap_or("素材");
                        let path = asset
                            .get("storage_path")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let is_image = matches!(
                            asset.get("type").and_then(Value::as_str),
                            Some("image" | "gif")
                        );
                        lines.push(format!(
                            "{}[{}]({path})",
                            if is_image { "!" } else { "" },
                            title.replace('[', "\\[").replace(']', "\\]")
                        ));
                        lines.push(String::new());
                    }
                }
            }
        }
    }
    format!("{}\n", lines.join("\n").trim())
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn html_for_project(project: &Value, content_item_id: Option<&str>) -> String {
    let title = project
        .get("project")
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("未命名课程");
    let mut body = String::new();
    if let Some(items) = project.get("content_items").and_then(Value::as_array) {
        let mut items: Vec<&Value> = items
            .iter()
            .filter(|item| {
                !item
                    .get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    && content_item_id.map_or(true, |id| {
                        item.get("id").and_then(Value::as_str) == Some(id)
                    })
            })
            .collect();
        items.sort_by_key(|item| item.get("order_index").and_then(Value::as_i64).unwrap_or(0));
        for item in items {
            let item_title = item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("未命名内容");
            body.push_str(&format!("<section><h2>{}</h2>", escape_html(item_title)));
            if let Some(document_id) = item.get("document_id").and_then(Value::as_str) {
                for block in project_blocks(project, document_id) {
                    if block
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|id| is_layout_only_requirement(project, id))
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    let content = block_content(block);
                    let escaped = escape_html(&content);
                    let block_type = block
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("paragraph");
                    match block_type {
                        "heading" => {
                            let level = block
                                .get("settings")
                                .and_then(|value| value.get("level"))
                                .and_then(Value::as_i64)
                                .unwrap_or(3)
                                .clamp(1, 6);
                            body.push_str(&format!("<h{level}>{escaped}</h{level}>"));
                        }
                        "quote" => body.push_str(&format!("<blockquote>{escaped}</blockquote>")),
                        "code" => body.push_str(&format!("<pre><code>{escaped}</code></pre>")),
                        "divider" => body.push_str("<hr>"),
                        "placeholder" => continue,
                        "image" | "gif" | "video" | "audio" | "embed" => {
                            if let Some(asset) = block_asset(project, block) {
                                let title = escape_html(
                                    asset
                                        .get("title")
                                        .or_else(|| asset.get("filename"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("素材"),
                                );
                                let path = escape_html(
                                    asset
                                        .get("storage_path")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default(),
                                );
                                match asset.get("type").and_then(Value::as_str) {
                                    Some("image" | "gif") => body.push_str(&format!(
                                        "<figure><img src=\"{path}\" alt=\"{title}\"><figcaption>{title}</figcaption></figure>"
                                    )),
                                    Some("video") => body.push_str(&format!(
                                        "<figure><video controls src=\"{path}\"></video><figcaption>{title}</figcaption></figure>"
                                    )),
                                    Some("audio") => body.push_str(&format!(
                                        "<figure><audio controls src=\"{path}\"></audio><figcaption>{title}</figcaption></figure>"
                                    )),
                                    _ => body.push_str(&format!(
                                        "<aside><strong>附件：{title}</strong> <a href=\"{path}\">打开</a></aside>"
                                    )),
                                }
                            } else if !content.is_empty() {
                                body.push_str(&format!("<p>{escaped}</p>"));
                            }
                        }
                        _ => body.push_str(&format!("<p>{escaped}</p>")),
                    }
                }
            }
            if let Some(item_id) = item.get("id").and_then(Value::as_str) {
                let assets: Vec<&Value> =
                    referenced_assets_for_content(project, item_id)
                        .into_iter()
                        .filter(|asset| {
                            !item.get("document_id").and_then(Value::as_str).is_some_and(
                                |document_id| {
                                    asset.get("id").and_then(Value::as_str).is_some_and(
                                        |asset_id| asset_is_inline(project, document_id, asset_id),
                                    )
                                },
                            )
                        })
                        .collect();
                if !assets.is_empty() {
                    body.push_str("<div class=\"assets\"><h3>素材</h3>");
                    for asset in assets {
                        let title = escape_html(
                            asset
                                .get("title")
                                .or_else(|| asset.get("filename"))
                                .and_then(Value::as_str)
                                .unwrap_or("素材"),
                        );
                        let path = escape_html(
                            asset
                                .get("storage_path")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                        );
                        match asset.get("type").and_then(Value::as_str) {
                            Some("image" | "gif") => body.push_str(&format!(
                                "<figure><img src=\"{path}\" alt=\"{title}\"><figcaption>{title}</figcaption></figure>"
                            )),
                            Some("video") => body.push_str(&format!(
                                "<figure><video controls src=\"{path}\"></video><figcaption>{title}</figcaption></figure>"
                            )),
                            Some("audio") => body.push_str(&format!(
                                "<figure><audio controls src=\"{path}\"></audio><figcaption>{title}</figcaption></figure>"
                            )),
                            _ => body.push_str(&format!(
                                "<p><a href=\"{path}\">{title}</a></p>"
                            )),
                        }
                    }
                    body.push_str("</div>");
                }
            }
            body.push_str("</section>");
        }
    }
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>{}</title><style>body{{max-width:760px;margin:2rem auto;padding:0 1rem;font:16px/1.7 system-ui,sans-serif}}section{{margin:2rem 0}}blockquote{{border-left:3px solid #bbb;padding-left:1rem}}.待补内容{{padding:.75rem;background:#fff5dc}}</style></head><body><h1>{}</h1>{}</body></html>\n",
        escape_html(title),
        escape_html(title),
        body
    )
}

fn structured_boundary_error(code: &str, user_message: &str, details: Value) -> String {
    structured_ai_error(code, user_message, None, details)
}

/// 与 [`structured_boundary_error`] 完全同一形状，另外允许给出「下一步怎么做」的建议。
fn structured_ai_error(
    code: &str,
    user_message: &str,
    recommended_action: Option<&str>,
    details: Value,
) -> String {
    json!({
        "error": {
            "code": code,
            "user_message": user_message,
            "technical_message": user_message,
            "severity": "blocking",
            "recoverable": false,
            "recommended_action": recommended_action,
            "details": details,
        }
    })
    .to_string()
}

fn export_content_item_id(
    project: &Value,
    preset_object: &Map<String, Value>,
    options: Option<&Value>,
) -> Result<Option<String>, String> {
    let options_object = match options {
        None | Some(Value::Null) => None,
        Some(value) => Some(require_object(value, "export_options")?),
    };
    let raw = field(preset_object, &["content_item_id", "contentItemId"])
        .filter(|value| !value.is_null())
        .or_else(|| {
            options_object
                .and_then(|object| field(object, &["content_item_id", "contentItemId"]))
                .filter(|value| !value.is_null())
        });
    let Some(raw) = raw else {
        return Ok(None);
    };
    let Some(content_item_id) = raw
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err(structured_boundary_error(
            "invalid_content_item_id",
            "导出内容项 ID 必须是非空字符串。",
            json!({}),
        ));
    };
    let exists = project
        .get("content_items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .any(|item| item.get("id").and_then(Value::as_str) == Some(content_item_id))
        })
        .unwrap_or(false);
    if !exists {
        return Err(structured_boundary_error(
            "content_item_not_found",
            "指定的导出内容项不存在。",
            json!({ "content_item_id": content_item_id }),
        ));
    }
    Ok(Some(content_item_id.to_owned()))
}

fn export_preflight_report(
    preset: &Value,
    options: Option<&Value>,
) -> Result<(Value, Value, PathBuf, String), String> {
    let object = require_object(preset, "export_preflight")?;
    let project_dir = required_string(object, &["project_dir", "projectDir"], "项目目录")?;
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let project = read_project_value(&project_dir)?;
    let content_item_id = export_content_item_id(&project, object, options)?;
    let format = export_format(preset)?;
    let filename = output_filename(preset, &project, &format);
    let output_path = if let Some(raw) = field(
        object,
        &["output_path", "outputPath", "target_path", "targetPath"],
    )
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    {
        let path = PathBuf::from(raw);
        if !path.is_absolute() {
            return Err("导出目标必须是用户明确选择的绝对路径".into());
        }
        let parent = path.parent().ok_or("导出目标父目录无效")?;
        let parent = ensure_directory(parent, "导出目标目录")?;
        if path.exists()
            && fs::metadata(&path)
                .map_err(|error| format!("无法读取导出目标: {error}"))?
                .is_dir()
        {
            return Err("导出目标必须是文件路径".into());
        }
        let target = parent.join(path.file_name().ok_or("导出目标文件名无效")?);
        reject_symlink(&target, "导出目标")?;
        target
    } else {
        let output_dir = required_string(object, &["output_dir", "outputDir"], "导出目录")?;
        explicit_project_dir(&output_dir, true)?.join(filename)
    };
    reject_symlink(&output_path, "导出目标")?;
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    if let Some(requirements) = project.get("requirements").and_then(Value::as_array) {
        let open = requirements
            .iter()
            .filter(|requirement| {
                requirement.get("status").and_then(Value::as_str) == Some("open")
                    && content_item_id.as_deref().map_or(true, |id| {
                        requirement.get("content_item_id").and_then(Value::as_str) == Some(id)
                    })
            })
            .count();
        if open > 0 {
            warnings.push(
                json!({ "code": "open_requirements", "count": open, "message": "仍有待补项目" }),
            );
        }
    }
    if let Some(assets) = project.get("assets").and_then(Value::as_array) {
        let include_all_assets = matches!(format.as_str(), "asset_package" | "full_project");
        for asset in assets {
            let Some(asset_id) = asset.get("id").and_then(Value::as_str) else {
                continue;
            };
            if !include_all_assets
                && !asset_selected_for_content(&project, asset_id, content_item_id.as_deref())
            {
                continue;
            }
            let asset_type = asset.get("type").and_then(Value::as_str).unwrap_or("other");
            let downgraded = matches!(format.as_str(), "markdown" | "pdf" | "wechat")
                && (matches!(asset_type, "video" | "audio" | "document" | "other")
                    || (format == "pdf" && asset_type == "gif"));
            if downgraded {
                warnings.push(json!({
                    "code": "media_downgrade",
                    "asset_id": asset_id,
                    "message": "该媒体在当前格式中将以非交互附件说明呈现"
                }));
            }
            if asset
                .get("source_url")
                .and_then(Value::as_str)
                .is_some_and(|url| url.starts_with("http://") || url.starts_with("https://"))
            {
                warnings.push(json!({
                    "code": "external_reference",
                    "asset_id": asset_id,
                    "message": "外部素材链接不会被验证"
                }));
            }
            let Some(storage_path) = asset.get("storage_path").and_then(Value::as_str) else {
                continue;
            };
            let path = Path::new(storage_path);
            if path.is_absolute()
                || path
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
            {
                errors.push(json!({ "code": "invalid_asset_path", "message": "项目素材必须使用项目内相对路径" }));
            } else {
                let resolved = project_dir.join(path);
                if reject_symlink(&resolved, "项目素材").is_err() || !resolved.exists() {
                    errors.push(json!({ "code": "missing_asset", "message": "项目素材文件不存在", "path": storage_path }));
                }
            }
        }
    }
    let report = json!({
        "ok": errors.is_empty(),
        "errors": errors,
        "warnings": warnings,
        "format": format,
        "content_item_id": content_item_id,
        "output_path": output_path,
        "target_path": output_path,
    });
    Ok((project, report, output_path, format))
}

#[tauri::command]
fn export_preflight(preset: Value, options: Option<Value>) -> Result<Value, String> {
    let (_, report, _, _) = export_preflight_report(&preset, options.as_ref())?;
    Ok(report)
}

fn selected_export_assets<'a>(
    project: &'a Value,
    content_item_id: Option<&str>,
    include_all: bool,
) -> Vec<&'a Value> {
    project
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|asset| {
            !asset
                .get("archived")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter(|asset| {
            include_all
                || asset
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| {
                        if let Some(content_item_id) = content_item_id {
                            asset_selected_for_content(project, id, Some(content_item_id))
                        } else {
                            project
                                .get("asset_usages")
                                .and_then(Value::as_array)
                                .is_some_and(|usages| {
                                    usages.iter().any(|usage| {
                                        usage.get("asset_id").and_then(Value::as_str) == Some(id)
                                    })
                                })
                                || project
                                    .get("requirements")
                                    .and_then(Value::as_array)
                                    .is_some_and(|requirements| {
                                        requirements.iter().any(|requirement| {
                                            requirement
                                                .get("resolved_asset_id")
                                                .and_then(Value::as_str)
                                                == Some(id)
                                        })
                                    })
                        }
                    })
                    .unwrap_or(false)
        })
        .collect()
}

fn copy_export_assets(
    project: &Value,
    project_dir: &Path,
    destination_root: &Path,
    content_item_id: Option<&str>,
    include_all: bool,
) -> Result<Vec<String>, String> {
    let mut copied = Vec::new();
    for asset in selected_export_assets(project, content_item_id, include_all) {
        let storage_path = asset
            .get("storage_path")
            .and_then(Value::as_str)
            .ok_or("素材缺少项目内路径")?;
        let relative = Path::new(storage_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("项目素材必须使用安全的项目内相对路径".into());
        }
        let source = project_dir.join(relative);
        reject_symlink(&source, "项目素材")?;
        if !source.is_file() {
            return Err(format!("项目素材文件不存在：{storage_path}"));
        }
        let target = destination_root.join(relative);
        let same_file = source == target
            || (target.exists()
                && fs::canonicalize(&source).ok() == fs::canonicalize(&target).ok());
        if same_file {
            // A single-file export beside the project may already reference the
            // canonical assets directory. Copying a file onto itself truncates
            // it on macOS; skip it so export remains strictly read-only.
            copied.push(storage_path.replace('\\', "/"));
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建素材导出目录: {error}"))?;
        }
        fs::copy(&source, &target).map_err(|error| format!("无法复制导出素材: {error}"))?;
        copied.push(storage_path.replace('\\', "/"));
    }
    copied.sort();
    copied.dedup();
    Ok(copied)
}

fn unique_export_staging(target: &Path) -> Result<PathBuf, String> {
    let parent = target.parent().ok_or("导出目标父目录无效")?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("export");
    Ok(parent.join(format!(".{name}.acw-{}.tmp", native_id("export"))))
}

fn sanitized_project_package(project: &Value) -> Value {
    let mut value = project.clone();
    if let Some(object) = value.as_object_mut() {
        for key in [
            "conversation_sources",
            "conversations",
            "messages",
            "context_packs",
            "context_pack_items",
        ] {
            object.insert(key.into(), Value::Array(Vec::new()));
        }
    }
    value
}

fn chrome_binary() -> Option<PathBuf> {
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
}

fn print_html_pdf(
    html: &str,
    project: &Value,
    project_dir: &Path,
    output_path: &Path,
    content_item_id: Option<&str>,
) -> Result<(), String> {
    let chrome = chrome_binary()
        .ok_or("PDF 导出需要本机 Google Chrome/Chromium 打印引擎；请安装后重试，或先导出 HTML。")?;
    let staging = unique_export_staging(output_path)?;
    fs::create_dir_all(&staging).map_err(|error| format!("无法创建 PDF 临时目录: {error}"))?;
    let result = (|| {
        let html_path = staging.join("index.html");
        fs::write(&html_path, html).map_err(|error| format!("无法写入 PDF 临时页面: {error}"))?;
        copy_export_assets(project, project_dir, &staging, content_item_id, false)?;
        let pdf_path = staging.join("result.pdf");
        let file_url = format!("file://{}", html_path.to_string_lossy());
        let status = ProcessCommand::new(chrome)
            .args([
                "--headless=new",
                "--disable-gpu",
                "--allow-file-access-from-files",
                "--no-pdf-header-footer",
                &format!("--print-to-pdf={}", pdf_path.to_string_lossy()),
                &file_url,
            ])
            .status()
            .map_err(|error| format!("无法启动 PDF 打印引擎: {error}"))?;
        if !status.success() || !pdf_path.is_file() {
            return Err("PDF 打印引擎没有生成可用文件；未修改源项目，请重试或导出 HTML。".into());
        }
        let bytes = fs::read(&pdf_path).map_err(|error| format!("无法读取 PDF 输出: {error}"))?;
        if !bytes.starts_with(b"%PDF-") || bytes.len() < 1024 {
            return Err("PDF 输出验证失败；临时文件已清理。".into());
        }
        atomic_write_bytes_path(output_path, &bytes)
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

#[tauri::command]
fn export_run(preset: Value, options: Option<Value>) -> Result<Value, String> {
    let object = require_object(&preset, "export_run")?;
    let project_dir = required_string(object, &["project_dir", "projectDir"], "项目目录")?;
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    let (project, report, output_path, format) =
        export_preflight_report(&preset, options.as_ref())?;
    if !report.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return Err(structured_boundary_error(
            "export_blocked",
            "导出前检查发现严重问题，请先修复后重试。",
            report.clone(),
        ));
    }
    let content_item_id = report.get("content_item_id").and_then(Value::as_str);
    let mut exported_files: Vec<Value> = Vec::new();
    let mut total_bytes = 0_u64;
    match format.as_str() {
        "markdown" | "html" | "wechat" => {
            let contents = if format == "markdown" {
                markdown_for_project(&project, content_item_id)
            } else {
                let html = html_for_project(&project, content_item_id);
                if format == "wechat" {
                    html.replacen(
                        "<body>",
                        "<body><p style=\"padding:12px;border:1px solid #ddd\">富文本迁移版：图片/GIF 可复制；视频、音频和文档需在目标平台单独上传，平台可能调整字体与间距。</p>",
                        1,
                    )
                } else {
                    html
                }
            };
            atomic_write_path(&output_path, &contents, false)?;
            let parent = output_path.parent().ok_or("导出目标父目录无效")?;
            let copied =
                copy_export_assets(&project, &project_dir, parent, content_item_id, false)?;
            total_bytes = contents.len() as u64;
            exported_files.push(json!({
                "relative_path": output_path.file_name().and_then(|value| value.to_str()).unwrap_or("export"),
                "path": output_path,
                "mime_type": if format == "markdown" { "text/markdown" } else { "text/html" },
                "bytes": { "__bytes_base64": encode_base64(contents.as_bytes()) },
            }));
            exported_files.extend(copied.into_iter().map(|path| {
                json!({
                    "relative_path": path,
                    "mime_type": "application/octet-stream",
                })
            }));
        }
        "json" => {
            let safe = sanitized_project_package(&project);
            let contents =
                serde_json::to_string_pretty(&safe).map_err(|error| error.to_string())? + "\n";
            atomic_write_path(&output_path, &contents, false)?;
            total_bytes = contents.len() as u64;
            exported_files.push(json!({
                "relative_path": output_path.file_name().and_then(|value| value.to_str()).unwrap_or("project.json"),
                "path": output_path,
                "mime_type": "application/json",
                "bytes": { "__bytes_base64": encode_base64(contents.as_bytes()) },
            }));
        }
        "pdf" => {
            let html = html_for_project(&project, content_item_id);
            print_html_pdf(&html, &project, &project_dir, &output_path, content_item_id)?;
            total_bytes = fs::metadata(&output_path)
                .map_err(|error| format!("无法检查 PDF 输出: {error}"))?
                .len();
            exported_files.push(json!({
                "relative_path": output_path.file_name().and_then(|value| value.to_str()).unwrap_or("course.pdf"),
                "path": output_path,
                "mime_type": "application/pdf",
            }));
        }
        "web" | "asset_package" | "full_project" => {
            if output_path.exists() {
                return Err("导出目录已存在；为避免覆盖有效文件，请选择新的名称。".into());
            }
            let staging = unique_export_staging(&output_path)?;
            fs::create_dir_all(&staging)
                .map_err(|error| format!("无法创建导出临时目录: {error}"))?;
            let build = (|| -> Result<(), String> {
                let copied = copy_export_assets(
                    &project,
                    &project_dir,
                    &staging,
                    content_item_id,
                    format != "web",
                )?;
                if format == "web" {
                    let html = html_for_project(&project, content_item_id);
                    fs::write(staging.join("index.html"), html.as_bytes())
                        .map_err(|error| format!("无法写入网页入口: {error}"))?;
                    let manifest = json!({
                        "schema_version": 1,
                        "project_id": project.get("project").and_then(|value| value.get("id")),
                        "scope": if content_item_id.is_some() { "lesson" } else { "course" },
                        "content_item_id": content_item_id,
                        "entrypoint": "index.html",
                        "assets": copied,
                    });
                    fs::write(
                        staging.join("manifest.json"),
                        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("无法写入网页 manifest: {error}"))?;
                } else {
                    let manifest = json!({
                        "schema_version": 1,
                        "project_id": project.get("project").and_then(|value| value.get("id")),
                        "assets": copied,
                    });
                    fs::write(
                        staging.join("assets-manifest.json"),
                        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("无法写入素材 manifest: {error}"))?;
                    if format == "full_project" {
                        let safe = sanitized_project_package(&project);
                        fs::write(
                            staging.join("project.json"),
                            serde_json::to_vec_pretty(&safe).map_err(|error| error.to_string())?,
                        )
                        .map_err(|error| format!("无法写入项目包: {error}"))?;
                        fs::write(
                            staging.join("COURSE.md"),
                            markdown_for_project(&project, content_item_id),
                        )
                        .map_err(|error| format!("无法写入项目课程正文: {error}"))?;
                    }
                }
                Ok(())
            })();
            if let Err(error) = build {
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
            fs::rename(&staging, &output_path).map_err(|error| {
                let _ = fs::remove_dir_all(&staging);
                format!("无法提交导出目录: {error}")
            })?;
            for entry in
                fs::read_dir(&output_path).map_err(|error| format!("无法检查导出目录: {error}"))?
            {
                let entry = entry.map_err(|error| format!("无法检查导出文件: {error}"))?;
                exported_files.push(json!({
                    "relative_path": entry.file_name().to_string_lossy(),
                    "path": entry.path(),
                }));
            }
        }
        _ => return Err("不支持的导出格式".into()),
    }
    Ok(json!({
        "status": "completed",
        "format": format,
        "scope": if content_item_id.is_some() { "lesson" } else { "course" },
        "output_path": output_path,
        "target_path": output_path,
        "bytes": total_bytes,
        "files": exported_files,
        "preflight": report,
    }))
}

#[tauri::command]
fn reveal_export_path(path: String) -> Result<Value, String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() || !path.exists() {
        return Err("导出结果不存在，无法在 Finder 中定位。".into());
    }
    reject_symlink(&path, "导出结果")?;
    let mut command = ProcessCommand::new("/usr/bin/open");
    if path.is_file() {
        command.arg("-R");
    }
    let status = command
        .arg(&path)
        .status()
        .map_err(|error| format!("无法打开 Finder: {error}"))?;
    if !status.success() {
        return Err("Finder 未能打开导出结果。".into());
    }
    Ok(json!({ "status": "opened", "path": path }))
}

#[tauri::command]
fn publication_record(input: Value) -> Result<Value, String> {
    let object = require_object(&input, "publication_record")?;
    let project_dir = required_string(object, &["project_dir", "projectDir"], "项目目录")?;
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    let mut project = read_project_value(&project_dir)?;
    let publication = object.get("publication").cloned().unwrap_or_else(|| {
        let mut copy = object.clone();
        copy.remove("project_dir");
        copy.remove("projectDir");
        Value::Object(copy)
    });
    let publication = publication.as_object().ok_or("发布记录必须是结构化对象")?;
    if let Some(url) = publication.get("external_url").and_then(Value::as_str) {
        let lower = url.to_ascii_lowercase();
        if !(lower.starts_with("https://") || lower.starts_with("http://")) {
            return Err("发布链接必须使用 http 或 https".into());
        }
    }
    if let Some(path) = publication.get("export_path").and_then(Value::as_str) {
        if Path::new(path).is_absolute() || path.contains("..") {
            return Err("发布记录不能保存本机绝对路径".into());
        }
    }
    let mut record = Value::Object(publication.clone());
    let record_object = record.as_object_mut().ok_or("发布记录格式无效")?;
    record_object
        .entry("id")
        .or_insert_with(|| json!(native_id("publication")));
    record_object
        .entry("status")
        .or_insert_with(|| json!("published"));
    let list = project
        .as_object_mut()
        .ok_or("项目数据必须是 JSON 对象")?
        .entry("publications")
        .or_insert_with(|| Value::Array(Vec::new()));
    list.as_array_mut()
        .ok_or("项目的发布记录格式无效")?
        .push(record.clone());
    write_project_value_unlocked(&project_dir, &project)?;
    Ok(json!({ "status": "recorded", "publication": record }))
}

#[tauri::command]
fn save_session(app: AppHandle, session: Value) -> Result<(), String> {
    reject_sensitive(&session)?;
    let object = require_object(&session, "save_session")?;
    let contents = serde_json::to_string(&session).map_err(|error| error.to_string())?;
    let path = app_local_path(&app, ".workspace/session.json")?;
    let project_dir = field(object, &["project_dir", "projectDir"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(project_dir) = project_dir {
        let project_dir = explicit_project_dir(project_dir, false)?;
        let _lease_guard = require_active_project_lock(&project_dir)?;
        return atomic_write_path(&path, &contents, true);
    }
    atomic_write_path(&path, &contents, true)
}

#[tauri::command]
fn load_session(app: AppHandle) -> Result<Option<Value>, String> {
    // A directory passed on the command line wins for the first read, so
    // `workbench --project-dir <path>` opens that project immediately.
    if let Some(Some(directory)) = LAUNCH_PROJECT_DIR.get() {
        if !LAUNCH_PROJECT_CONSUMED.swap(true, Ordering::AcqRel) {
            return Ok(Some(json!({
                "project_dir": directory.to_string_lossy(),
            })));
        }
    }
    let path = app_local_path(&app, ".workspace/session.json")?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(read_json_file(&path)?))
}

#[tauri::command]
fn write_recovery_journal(project_dir: String, contents: String) -> Result<(), String> {
    let project_dir = explicit_project_dir(&project_dir, true)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    let value: Value = serde_json::from_str(&contents).map_err(|error| error.to_string())?;
    reject_sensitive(&value)?;
    let path = project_file(&project_dir, ".workspace/recovery.json")?;
    atomic_write_path(&path, &contents, true)
}

#[tauri::command]
fn read_recovery_journal(project_dir: String) -> Result<Option<Value>, String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let path = project_file(&project_dir, ".workspace/recovery.json")?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(read_json_file(&path)?))
}

/// Read-only asset access for previews.
///
/// The webview never receives filesystem access: the command resolves an asset
/// id against the open project's canonical metadata, refuses symlinked or
/// out-of-project storage paths, and returns at most `ASSET_READ_SIZE_LIMIT`
/// bytes.  It does not take an edit lease because it writes nothing.
const ASSET_READ_SIZE_LIMIT: u64 = 8 * 1024 * 1024;

#[tauri::command]
fn asset_read(input: Value) -> Result<Value, String> {
    let outer = require_object(&input, "asset_read")?;
    let payload = outer
        .get("input")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or(input);
    let object = require_object(&payload, "asset_read")?;
    let project_dir = required_string(object, &["project_dir", "projectDir"], "项目目录")?;
    let asset_id = required_string(object, &["asset_id", "assetId"], "素材 ID")?;
    let project_dir = explicit_project_dir(&project_dir, false)?;
    // This is a preview read only: it resolves one named asset inside the
    // project and writes nothing, so it deliberately takes no edit lease and
    // does not participate in the save-conflict protocol.
    let project = read_project_value(&project_dir)?;
    let project_object = project.as_object().ok_or("项目数据必须是 JSON 对象")?;
    let asset = project_object
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|assets| {
            assets
                .iter()
                .find(|asset| asset.get("id").and_then(Value::as_str) == Some(asset_id.as_str()))
        })
        .ok_or("找不到素材")?;
    if asset
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("素材已归档，无法读取".into());
    }
    let storage_path = asset
        .get("storage_path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("素材缺少存储路径")?;
    // A preview read is only ever for material, never for canonical data or
    // arbitrary project files, so the path must stay under `assets/`.
    let relative = Path::new(storage_path);
    let inside_assets = relative
        .components()
        .next()
        .map(|component| matches!(component, Component::Normal(name) if name == "assets"))
        .unwrap_or(false);
    if !inside_assets {
        return Err("素材路径必须位于 assets/ 目录内".into());
    }
    let target = project_file(&project_dir, storage_path)?;
    // Reject a symlinked target or a chain whose real path escapes the project.
    reject_symlink(&target, "素材文件")?;
    let real_root =
        fs::canonicalize(&project_dir).map_err(|error| format!("无法解析项目目录: {error}"))?;
    let real_target =
        fs::canonicalize(&target).map_err(|error| format!("无法读取素材: {error}"))?;
    if !real_target.starts_with(&real_root) {
        return Err("素材路径超出项目目录".into());
    }
    let metadata = fs::metadata(&real_target).map_err(|error| format!("无法读取素材: {error}"))?;
    if !metadata.is_file() {
        return Err("素材路径不是文件".into());
    }
    if metadata.len() > ASSET_READ_SIZE_LIMIT {
        return Err(format!(
            "素材过大，无法在工作台内预览（上限 {} MB）",
            ASSET_READ_SIZE_LIMIT / (1024 * 1024)
        ));
    }
    let bytes = fs::read(&real_target).map_err(|error| format!("无法读取素材字节: {error}"))?;
    let mime_type = asset
        .get("mime_type")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    Ok(json!({
        "asset_id": asset_id,
        "filename": asset.get("filename").and_then(Value::as_str).unwrap_or(""),
        "mime_type": mime_type,
        "file_size": bytes.len(),
        "bytes_base64": BASE64.encode(&bytes),
    }))
}

fn safe_asset_filename(value: &str) -> String {
    let name = Path::new(value)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("unnamed");
    let sanitized: String = name
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '/' | '\\') {
                '_'
            } else {
                character
            }
        })
        .collect();
    let sanitized = sanitized.trim();
    if sanitized.is_empty() {
        "unnamed".into()
    } else {
        sanitized.to_owned()
    }
}

fn mime_for_filename(filename: &str) -> &'static str {
    match Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        _ => "application/octet-stream",
    }
}

fn normalize_asset_type(raw: Option<&str>, filename: &str, mime_type: &str) -> String {
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "gif" {
        return "gif".into();
    }
    if mime_type.starts_with("video/") || matches!(extension.as_str(), "mp4" | "mov" | "webm") {
        return "video".into();
    }
    if mime_type.starts_with("audio/") || matches!(extension.as_str(), "mp3" | "wav" | "m4a") {
        return "audio".into();
    }
    if mime_type.starts_with("image/")
        || matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "svg")
    {
        return "image".into();
    }
    if matches!(extension.as_str(), "md" | "markdown" | "txt" | "json") {
        return "document".into();
    }
    match raw.unwrap_or_default().to_ascii_lowercase().as_str() {
        "image" | "gif" | "video" | "audio" | "document" | "other" => {
            raw.unwrap_or("other").to_ascii_lowercase()
        }
        _ => "other".into(),
    }
}

fn normalize_source_type(raw: Option<&str>) -> &'static str {
    match raw.unwrap_or_default().to_ascii_lowercase().as_str() {
        "original" => "original",
        "generated" => "generated",
        "external" => "external",
        "unknown" => "unknown",
        _ => "imported",
    }
}

fn append_asset_usage(
    project: &mut Value,
    input: &Map<String, Value>,
    asset_id: &str,
) -> Result<Option<Value>, String> {
    let Some(content_item_id) = field(input, &["content_item_id", "contentItemId"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
    else {
        return Ok(None);
    };
    let block_id = field(input, &["block_id", "blockId"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let layout_instance_id = field(input, &["layout_instance_id", "layoutInstanceId"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let role = field(input, &["role"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("content")
        .to_owned();
    let project_object = project.as_object().ok_or("项目数据必须是 JSON 对象")?;
    let project_id = project_object
        .get("project")
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .ok_or("项目缺少 project.id")?;
    let item = project_object
        .get("content_items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("id").and_then(Value::as_str) == Some(content_item_id.as_str())
            })
        })
        .ok_or("素材引用指向不存在的内容")?;
    if item.get("project_id").and_then(Value::as_str) != Some(project_id) {
        return Err("素材引用内容不属于当前项目".into());
    }
    if let Some(block_id) = block_id.as_deref() {
        let block = project_object
            .get("blocks")
            .and_then(Value::as_array)
            .and_then(|blocks| {
                blocks
                    .iter()
                    .find(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
            })
            .ok_or("素材引用指向不存在的正文区块")?;
        let document_id = block
            .get("document_id")
            .and_then(Value::as_str)
            .ok_or("素材引用正文区块缺少 document_id")?;
        let document = project_object
            .get("documents")
            .and_then(Value::as_array)
            .and_then(|documents| {
                documents.iter().find(|document| {
                    document.get("id").and_then(Value::as_str) == Some(document_id)
                })
            })
            .ok_or("素材引用正文区块缺少文档")?;
        if document.get("content_item_id").and_then(Value::as_str) != Some(content_item_id.as_str())
        {
            return Err("素材正文引用与内容不匹配".into());
        }
    }
    if let Some(layout_instance_id) = layout_instance_id.as_deref() {
        let layout = project_object
            .get("layout_instances")
            .and_then(Value::as_array)
            .and_then(|layouts| {
                layouts.iter().find(|layout| {
                    layout.get("id").and_then(Value::as_str) == Some(layout_instance_id)
                })
            })
            .ok_or("素材引用指向不存在的排版版本")?;
        if layout.get("content_item_id").and_then(Value::as_str) != Some(content_item_id.as_str()) {
            return Err("素材排版引用与内容不匹配".into());
        }
    }
    let usages = project
        .as_object_mut()
        .ok_or("项目数据必须是 JSON 对象")?
        .entry("asset_usages")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or("项目的 asset_usages 数据格式无效")?;
    if let Some(existing) = usages.iter().find(|usage| {
        usage.get("asset_id").and_then(Value::as_str) == Some(asset_id)
            && usage.get("content_item_id").and_then(Value::as_str)
                == Some(content_item_id.as_str())
            && usage.get("block_id").and_then(Value::as_str) == block_id.as_deref()
            && usage.get("layout_instance_id").and_then(Value::as_str)
                == layout_instance_id.as_deref()
            && usage.get("role").and_then(Value::as_str) == Some(role.as_str())
    }) {
        return Ok(Some(existing.clone()));
    }
    let usage = json!({
        "id": native_id("usage"),
        "asset_id": asset_id,
        "content_item_id": content_item_id,
        "block_id": block_id,
        "layout_instance_id": layout_instance_id,
        "role": role,
        "created_at": unix_millis().to_string(),
    });
    usages.push(usage.clone());
    Ok(Some(usage))
}

#[tauri::command]
fn clear_recovery_journal(project_dir: String) -> Result<Value, String> {
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    let cleared = clear_recovery_journal_path(&project_dir)?;
    Ok(json!({
        "status": if cleared { "cleared" } else { "missing" },
        "project_dir": project_dir,
    }))
}

#[tauri::command]
fn asset_import(input: Value) -> Result<Value, String> {
    let outer = require_object(&input, "asset_import")?;
    // Native callers historically wrapped asset input as { input: ... };
    // accept both shapes so the browser bridge and direct Tauri callers share
    // one adapter contract.
    let payload = outer
        .get("input")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or(input);
    let object = require_object(&payload, "asset_import")?;
    let project_dir = required_string(object, &["project_dir", "projectDir"], "项目目录")?;
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    let mut project = read_project_value(&project_dir)?;
    let project_id = project
        .get("project")
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("项目缺少 project.id")?
        .to_owned();

    let filename_hint = field(object, &["filename", "name"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let source_path = field(object, &["source_path", "sourcePath", "path"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let bytes_base64 = field(object, &["bytes_base64", "bytesBase64"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if source_path.is_some() && bytes_base64.is_some() {
        return Err("素材导入不能同时提供 source_path 和 bytes_base64".into());
    }
    let (filename, bytes) = if let Some(raw) = source_path {
        let path = PathBuf::from(raw);
        if !path.is_absolute() {
            return Err("素材来源必须是用户明确选择的绝对路径".into());
        }
        reject_symlink(&path, "素材来源")?;
        let canonical =
            fs::canonicalize(&path).map_err(|error| format!("无法读取素材来源: {error}"))?;
        reject_symlink(&canonical, "素材来源")?;
        let metadata =
            fs::metadata(&canonical).map_err(|error| format!("无法读取素材来源信息: {error}"))?;
        if !metadata.is_file() {
            return Err("素材来源必须是文件".into());
        }
        let filename = filename_hint
            .map(ToOwned::to_owned)
            .or_else(|| {
                canonical
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(ToOwned::to_owned)
            })
            .unwrap_or_else(|| "unnamed".into());
        let bytes = fs::read(&canonical).map_err(|error| format!("无法读取素材字节: {error}"))?;
        (filename, bytes)
    } else if let Some(encoded) = bytes_base64 {
        let filename = filename_hint.unwrap_or("unnamed").to_owned();
        (filename, decode_base64(encoded)?)
    } else {
        return Err("asset_import requires source_path or bytes_base64".into());
    };

    let filename = safe_asset_filename(&filename);
    let mime_type = field(object, &["mime_type", "mimeType"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| mime_for_filename(&filename).into());
    let asset_type = normalize_asset_type(
        field(object, &["type", "asset_type", "assetType"]).and_then(Value::as_str),
        &filename,
        &mime_type,
    );
    let checksum = sha256_hex(&bytes);
    let keep_duplicate = object
        .get("keep_duplicate")
        .or_else(|| object.get("keepDuplicate"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || object
            .get("duplicate_policy")
            .or_else(|| object.get("duplicatePolicy"))
            .and_then(Value::as_str)
            .map(|value| value.eq_ignore_ascii_case("copy"))
            .unwrap_or(false);

    let project_object = project.as_object_mut().ok_or("项目数据必须是 JSON 对象")?;
    let assets = project_object
        .entry("assets")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or("项目的 assets 数据格式无效")?;
    let existing = assets
        .iter()
        .find(|asset| {
            asset.get("project_id").and_then(Value::as_str) == Some(project_id.as_str())
                && asset.get("checksum").and_then(Value::as_str) == Some(checksum.as_str())
                && !asset
                    .get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
        .cloned();
    if existing.is_some() && !keep_duplicate {
        let asset = existing.ok_or("重复素材状态无效")?;
        let usage = append_asset_usage(
            &mut project,
            object,
            asset
                .get("id")
                .and_then(Value::as_str)
                .ok_or("素材缺少 id")?,
        )?;
        let mut warning = None;
        if usage.is_some() {
            touch_project_updated_at(&mut project)?;
            warning = write_project_value_with_warning_unlocked(&project_dir, &project)?;
        }
        return Ok(json!({
            "status": "existing",
            "duplicate": true,
            "asset": asset,
            "usage": usage,
            "checksum": checksum,
            "warning": warning,
        }));
    }

    let asset_id = native_id("asset");
    let relative_path = format!("assets/{asset_id}-{filename}");
    let destination = project_file(&project_dir, &relative_path)?;
    let asset = json!({
        "id": asset_id,
        "project_id": project_id,
        "type": asset_type,
        "filename": filename,
        "storage_path": relative_path,
        "mime_type": mime_type,
        "width": null,
        "height": null,
        "duration_ms": null,
        "file_size": bytes.len(),
        "checksum": checksum,
        "title": field(object, &["title"]).and_then(Value::as_str).unwrap_or_else(|| filename.as_str()),
        "description": field(object, &["description"]).and_then(Value::as_str).unwrap_or(""),
        "source_type": normalize_source_type(field(object, &["source_type", "sourceType"]).and_then(Value::as_str)),
        "source_url": field(object, &["source_url", "sourceUrl"]).cloned().unwrap_or(Value::Null),
        "copyright_note": field(object, &["copyright_note", "copyrightNote"]).cloned().unwrap_or(Value::Null),
        "created_at": unix_millis().to_string(),
        "archived": false,
    });
    assets.push(asset.clone());
    let usage = append_asset_usage(
        &mut project,
        object,
        asset
            .get("id")
            .and_then(Value::as_str)
            .ok_or("素材缺少 id")?,
    )?;
    if let Err(error) = verify_active_project_lock(&project_dir) {
        return Err(error);
    }
    if let Err(error) = atomic_write_bytes_path(&destination, &bytes) {
        return Err(error);
    }
    if let Err(error) = verify_active_project_lock(&project_dir) {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }
    if let Err(error) = touch_project_updated_at(&mut project) {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }
    let warning = match write_project_value_with_warning_unlocked(&project_dir, &project) {
        Ok(warning) => warning,
        Err(error) => {
            let _ = fs::remove_file(&destination);
            return Err(error);
        }
    };
    Ok(json!({
        "status": "imported",
        "duplicate": false,
        "asset": asset,
        "usage": usage,
        "checksum": checksum,
        "warning": warning,
    }))
}

#[tauri::command]
fn secret_set(_reference: String) -> Result<Value, String> {
    Err("unsupported: 当前原生壳未配置操作系统钥匙串，未保存任何凭据".into())
}

#[tauri::command]
fn secret_delete(_reference: String) -> Result<Value, String> {
    Err("unsupported: 当前原生壳未配置操作系统钥匙串，未删除或写入任何凭据".into())
}

#[tauri::command]
fn connector_sync(input: Value) -> Result<Value, String> {
    require_object(&input, "connector_sync")?;
    Err("unsupported: 当前原生壳未安装外部对话连接器".into())
}

#[tauri::command]
fn ai_analyze(input: Value) -> Result<Value, String> {
    require_object(&input, "ai_analyze")?;
    Err("unsupported: 当前原生壳未配置模型适配器，未生成建议且未修改正文".into())
}

#[tauri::command]
fn suggestion_apply(input: Value) -> Result<Value, String> {
    require_object(&input, "suggestion_apply")?;
    Err("unsupported: 修改草稿应用由工作台服务执行，原生壳未写入正文".into())
}

// ---------------------------------------------------------------------------
// V0-T03 / Workstream C —— AI 传输、Provider 配置与执行记录
//
// 这三块都**不是** Canonical：Provider 元数据与执行记录写在应用数据目录的
// `.workspace/ai/` 下，凭据写入 macOS 系统钥匙串，既不进 `project.json`，也不进导出包。
// 读接口只回传「是否已配置」的布尔值，任何返回值或错误文本都不会带上凭据本身。
// ---------------------------------------------------------------------------

/// 非 Canonical AI 存储目录（相对应用数据目录）。
const AI_STORE_DIR: &str = ".workspace/ai";
const AI_PROVIDERS_FILE: &str = "providers.json";
const AI_EXECUTIONS_FILE: &str = "executions.json";
/// 执行记录上限：新记录插到最前，超出即丢弃最旧的一条。
const AI_EXECUTION_LIMIT: usize = 200;
/// `ai_execution_list` 在调用方没有给 limit 时返回多少条
/// （与浏览器壳 `src/service/ai_transport.ts` 的 `DEFAULT_LIST_LIMIT` 保持一致）。
const AI_EXECUTION_DEFAULT_LIMIT: usize = 50;
/// 执行记录里的用户要求截断长度（字符数）。
const AI_INSTRUCTION_LIMIT: usize = 2000;
const AI_DEFAULT_TIMEOUT_MS: u64 = 60_000;
const AI_MAX_TIMEOUT_MS: u64 = 600_000;
/// Provider 错误正文进入 `details` 之前截断的长度（字符数）。
const AI_ERROR_TEXT_LIMIT: usize = 400;
/// 单条凭据的长度上限（与浏览器壳一致）。
const AI_CREDENTIAL_MAX_CHARS: usize = 8192;
/// 带 Content-Length 的响应超过这个大小就直接拒绝，避免被异常 Provider 拖垮内存。
const AI_RESPONSE_SIZE_LIMIT: u64 = 8 * 1024 * 1024;

/// `<app local data>/.workspace/ai`（缺失时创建）。
fn ai_store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app_local_path(app, AI_STORE_DIR)
}

/// 两个非 Canonical 存储文件的绝对路径；`base` 就是 [`ai_store_dir`] 的返回值。
struct AiStorePaths {
    providers: PathBuf,
    executions: PathBuf,
}

fn ai_store_paths(base: &Path) -> AiStorePaths {
    AiStorePaths {
        providers: base.join(AI_PROVIDERS_FILE),
        executions: base.join(AI_EXECUTIONS_FILE),
    }
}

#[cfg_attr(test, allow(dead_code))]
const AI_KEYCHAIN_SERVICE: &str = "com.ai-course-workbench.ai";

trait AiCredentialStore {
    fn set(&self, provider_id: &str, value: &str) -> Result<(), String>;
    fn get(&self, provider_id: &str) -> Result<Option<String>, String>;
    fn delete(&self, provider_id: &str) -> Result<bool, String>;
}

fn keychain_failure(operation: &str) -> String {
    let message = match operation {
        "get" => "无法访问 macOS 系统钥匙串，无法确认 API Key 是否已配置",
        "delete" => "无法访问 macOS 系统钥匙串，API Key 未删除",
        _ => "无法访问 macOS 系统钥匙串，API Key 未保存",
    };
    format!("keychain_unavailable: {message}（{operation}）")
}

#[cfg_attr(test, allow(dead_code))]
fn security_command(args: &[String]) -> Result<(i32, Vec<u8>), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = args;
        return Err(keychain_failure("unsupported-platform"));
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = ProcessCommand::new("/usr/bin/security");
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let output = command
            .output()
            .map_err(|_| keychain_failure("process"))?;
        Ok((output.status.code().unwrap_or(-1), output.stdout))
    }
}

/// `security add-generic-password` arguments for one provider credential.
///
/// The secret is the ARGUMENT of `-w` on purpose. `security` documents `-w` as
/// "Specify password to be added … Specify -w as the last option to be
/// prompted": a trailing bare `-w` makes the tool read the password from the
/// terminal, and with no TTY it stored an EMPTY password while still exiting 0.
/// That is exactly how an API Key could look saved and never be readable.
#[cfg_attr(test, allow(dead_code))]
fn keychain_add_args(account: &str, service: &str, value: &str) -> Vec<String> {
    vec![
        "add-generic-password".into(),
        "-a".into(),
        account.into(),
        "-s".into(),
        service.into(),
        // `-U` updates an existing item instead of failing, which also repairs
        // an item an earlier broken write left empty.
        "-U".into(),
        "-w".into(),
        value.into(),
    ]
}

#[cfg_attr(test, allow(dead_code))]
fn keychain_get_args(account: &str, service: &str) -> Vec<String> {
    vec![
        "find-generic-password".into(),
        "-a".into(),
        account.into(),
        "-s".into(),
        service.into(),
        "-w".into(),
    ]
}

#[cfg_attr(test, allow(dead_code))]
fn keychain_delete_args(account: &str, service: &str) -> Vec<String> {
    vec![
        "delete-generic-password".into(),
        "-a".into(),
        account.into(),
        "-s".into(),
        service.into(),
    ]
}

#[cfg_attr(test, allow(dead_code))]
struct MacKeychainStore {
    account_prefix: String,
}

#[cfg_attr(test, allow(dead_code))]
impl MacKeychainStore {
    fn for_base(base: &Path) -> Self {
        // The application-local base is not written as account metadata. A
        // stable digest keeps native and browser project credentials isolated.
        let digest = sha256_hex(base.to_string_lossy().as_bytes());
        Self {
            account_prefix: format!("project-{}:provider:", &digest[..32]),
        }
    }

    fn account(&self, provider_id: &str) -> String {
        format!("{}{}", self.account_prefix, provider_id)
    }
}

impl AiCredentialStore for MacKeychainStore {
    fn set(&self, provider_id: &str, value: &str) -> Result<(), String> {
        // See `keychain_add_args`: the value must be the argument of `-w`, and
        // the write has to be verified by reading it back before we report
        // success.
        let args = keychain_add_args(&self.account(provider_id), AI_KEYCHAIN_SERVICE, value);
        let (code, _) = security_command(&args)?;
        if code != 0 {
            return Err(keychain_failure("set"));
        }
        match self.get(provider_id)? {
            Some(stored) if stored == value.trim() => Ok(()),
            _ => Err(keychain_failure("set")),
        }
    }

    fn get(&self, provider_id: &str) -> Result<Option<String>, String> {
        let args = keychain_get_args(&self.account(provider_id), AI_KEYCHAIN_SERVICE);
        let (code, stdout) = security_command(&args)?;
        if code == 44 {
            return Ok(None);
        }
        if code != 0 {
            return Err(keychain_failure("get"));
        }
        let value = String::from_utf8(stdout)
            .map_err(|_| keychain_failure("get"))?
            .trim()
            .to_owned();
        Ok((!value.is_empty()).then_some(value))
    }

    fn delete(&self, provider_id: &str) -> Result<bool, String> {
        let args = keychain_delete_args(&self.account(provider_id), AI_KEYCHAIN_SERVICE);
        let (code, _) = security_command(&args)?;
        match code {
            0 => Ok(true),
            44 => Ok(false),
            _ => Err(keychain_failure("delete")),
        }
    }
}

#[cfg(test)]
static TEST_AI_CREDENTIALS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

#[cfg(test)]
struct TestAiCredentialStore {
    namespace: String,
}

#[cfg(test)]
impl AiCredentialStore for TestAiCredentialStore {
    fn set(&self, provider_id: &str, value: &str) -> Result<(), String> {
        TEST_AI_CREDENTIALS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| keychain_failure("test-lock"))?
            .insert(
                format!("{}:{provider_id}", self.namespace),
                value.to_owned(),
            );
        Ok(())
    }

    fn get(&self, provider_id: &str) -> Result<Option<String>, String> {
        Ok(TEST_AI_CREDENTIALS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| keychain_failure("test-lock"))?
            .get(&format!("{}:{provider_id}", self.namespace))
            .cloned())
    }

    fn delete(&self, provider_id: &str) -> Result<bool, String> {
        Ok(TEST_AI_CREDENTIALS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| keychain_failure("test-lock"))?
            .remove(&format!("{}:{provider_id}", self.namespace))
            .is_some())
    }
}

fn ai_credential_store(base: &Path) -> Box<dyn AiCredentialStore> {
    #[cfg(test)]
    {
        return Box::new(TestAiCredentialStore {
            namespace: sha256_hex(base.to_string_lossy().as_bytes()),
        });
    }
    #[cfg(not(test))]
    {
        Box::new(MacKeychainStore::for_base(base))
    }
}

/// 凭据只属于当前用户：文件写完立刻收成 0600（尽力而为，失败不阻断写入）。
fn restrict_ai_file_mode(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// 读取非 Canonical AI 存储；文件不存在时返回 `Value::Null`（绝不报错）。
fn ai_read_store(path: &Path, label: &str) -> Result<Value, String> {
    reject_symlink(path, label)?;
    match fs::read_to_string(path) {
        Ok(contents) => {
            if contents.trim().is_empty() {
                return Ok(Value::Null);
            }
            serde_json::from_str(&contents).map_err(|error| format!("无法解析{label}: {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(format!("无法读取{label}: {error}")),
    }
}

fn ai_write_store_with_backup(
    path: &Path,
    value: &Value,
    label: &str,
    keep_backup: bool,
) -> Result<(), String> {
    let mut contents = serde_json::to_string_pretty(value)
        .map_err(|error| format!("无法序列化{label}: {error}"))?;
    contents.push('\n');
    atomic_write_path(path, &contents, keep_backup)?;
    restrict_ai_file_mode(path);
    Ok(())
}

fn ai_write_store(path: &Path, value: &Value, label: &str) -> Result<(), String> {
    ai_write_store_with_backup(path, value, label, true)
}

fn ai_write_provider_store(path: &Path, value: &Value, label: &str) -> Result<(), String> {
    // Provider files contain metadata only; never create a plaintext backup.
    ai_write_store_with_backup(path, value, label, false)
}

fn ai_normalize_provider_store(value: Value) -> Result<Map<String, Value>, String> {
    let mut store = match value {
        Value::Null => Map::new(),
        Value::Object(map) => map,
        _ => return Err("AI Provider 配置格式无效".into()),
    };
    if !store.get("providers").map(Value::is_array).unwrap_or(false) {
        store.insert("providers".into(), Value::Array(Vec::new()));
    }
    Ok(store)
}

fn ai_read_provider_store(path: &Path) -> Result<Map<String, Value>, String> {
    ai_normalize_provider_store(ai_read_store(path, "AI Provider 配置")?)
}

fn ai_migration_failure(operation: &str) -> String {
    format!(
        "keychain_unavailable: 历史 API Key 未能安全迁移到 macOS 系统钥匙串（{operation}），原文件未删除"
    )
}

/// Read provider metadata and migrate historical plaintext credentials exactly
/// once. The old JSON and `providers.bak` survive every failure path.
fn ai_read_provider_store_secure(base: &Path) -> Result<Map<String, Value>, String> {
    let paths = ai_store_paths(base);
    let primary_exists = paths.providers.exists();
    let primary = ai_read_provider_store(&paths.providers)?;
    let backup_path = base.join("providers.bak");
    let backup_exists = backup_path.exists();
    let backup = if backup_exists {
        Some(ai_normalize_provider_store(ai_read_store(
            &backup_path,
            "AI Provider 配置备份",
        )?)?)
    } else {
        None
    };
    let mut store = if !primary_exists {
        backup.clone().unwrap_or(primary)
    } else {
        primary
    };
    if let Some(providers) = store.get("providers").and_then(Value::as_array) {
        for provider in providers {
            if ai_forbidden_field_path(provider, "", ai_credential_field_name).is_some()
                || ai_inline_credential_field(provider, "").is_some()
            {
                return Err(ai_migration_failure("provider-metadata"));
            }
        }
    }
    let has_extra_fields = store
        .keys()
        .any(|key| key != "providers" && key != "credentials");
    let mut legacy = Map::new();
    if let Some(credentials) = backup
        .as_ref()
        .and_then(|value| value.get("credentials"))
        .and_then(Value::as_object)
    {
        legacy.extend(credentials.clone());
    }
    if let Some(credentials) = store.get("credentials").and_then(Value::as_object) {
        legacy.extend(credentials.clone());
    }
    let needs_cleanup = !legacy.is_empty()
        || backup_exists
        || store.get("credentials").is_some()
        || has_extra_fields;
    if !needs_cleanup {
        return Ok(store);
    }

    let credential_store = ai_credential_store(base);
    for (provider_id, raw_value) in &legacy {
        let value = raw_value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ai_migration_failure("invalid-credential"))?;
        ai_validate_provider_id(provider_id)
            .map_err(|_| ai_migration_failure("invalid-provider"))?;
        credential_store
            .set(provider_id, value)
            .map_err(|_| ai_migration_failure("keychain-write"))?;
        let verified = credential_store
            .get(provider_id)
            .map_err(|_| ai_migration_failure("keychain-read"))?;
        if verified.as_deref() != Some(value) {
            return Err(ai_migration_failure("keychain-verification"));
        }
    }
    store.remove("credentials");
    store.retain(|key, _| key == "providers");
    ai_write_provider_store(
        &paths.providers,
        &Value::Object(store.clone()),
        "AI Provider 配置",
    )
    .map_err(|_| ai_migration_failure("metadata-write"))?;
    if backup_exists {
        fs::remove_file(&backup_path).map_err(|_| ai_migration_failure("backup-cleanup"))?;
    }
    Ok(store)
}

fn ai_read_execution_store(path: &Path) -> Result<Map<String, Value>, String> {
    let mut store = match ai_read_store(path, "AI 执行记录")? {
        Value::Null => Map::new(),
        Value::Object(map) => map,
        _ => return Err("AI 执行记录格式无效".into()),
    };
    if !store.get("records").map(Value::is_array).unwrap_or(false) {
        store.insert("records".into(), Value::Array(Vec::new()));
    }
    Ok(store)
}

fn ai_keychain_credential(base: &Path, provider_id: &str) -> Result<Option<String>, String> {
    ai_credential_store(base).get(provider_id)
}

/// 执行记录里必须丢弃的字段名：沿用 `sensitive_key` 的词表，再显式补上
/// 凭据 / 密码 / 授权三个词（含复数与 `xxx_credentials` 这类后缀写法），
/// 保证嵌套多深都不会把密钥写进执行历史。
fn ai_sensitive_key(key: &str) -> bool {
    if sensitive_key(key) {
        return true;
    }
    let compact: String = key
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(*character, '_' | '-' | '.'))
        .collect::<String>()
        .to_ascii_lowercase();
    [
        "credential",
        "credentials",
        "password",
        "passwords",
        "authorization",
        "authorizations",
    ]
    .iter()
    .any(|needle| compact.starts_with(needle) || compact.ends_with(needle))
}

fn ai_strip_sensitive(value: &Value, is_sensitive: fn(&str) -> bool) -> Value {
    match value {
        Value::Object(fields) => {
            let mut cleaned = Map::new();
            for (key, child) in fields {
                if is_sensitive(key) {
                    continue;
                }
                cleaned.insert(key.clone(), ai_strip_sensitive(child, is_sensitive));
            }
            Value::Object(cleaned)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| ai_strip_sensitive(item, is_sensitive))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// 落盘前的记录清洗：递归丢弃疑似凭据字段、擦掉自由文本里的密钥，
/// 并把 `instruction` 截断到 2000 字。
fn ai_sanitize_record(record: &Value, secrets: &[String]) -> Value {
    let mut cleaned = ai_sanitize_record_value(record, secrets);
    if let Some(object) = cleaned.as_object_mut() {
        let truncated = object
            .get("instruction")
            .and_then(Value::as_str)
            .filter(|text| text.chars().count() > AI_INSTRUCTION_LIMIT)
            .map(|text| text.chars().take(AI_INSTRUCTION_LIMIT).collect::<String>());
        if let Some(truncated) = truncated {
            object.insert("instruction".into(), Value::String(truncated));
        }
    }
    cleaned
}

fn ai_sanitize_record_value(value: &Value, secrets: &[String]) -> Value {
    match value {
        Value::Object(fields) => {
            let mut cleaned = Map::new();
            for (key, child) in fields {
                if ai_sensitive_key(key) {
                    continue;
                }
                // 用户可能把密钥粘进指令框，或错误信息里回显了密钥：
                // 自由文本按 Deno 的 scrubFreeText 规则擦一遍再落盘。
                if AI_FREE_TEXT_FIELDS.contains(&key.as_str()) {
                    if let Some(text) = child.as_str() {
                        cleaned.insert(
                            key.clone(),
                            Value::String(ai_scrub_free_text(text, secrets)),
                        );
                        continue;
                    }
                }
                cleaned.insert(key.clone(), ai_sanitize_record_value(child, secrets));
            }
            Value::Object(cleaned)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| ai_sanitize_record_value(item, secrets))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// 找出第一个被禁止的字段路径（形如 `body.messages[0].api_key`）；只回传字段名，
/// 绝不回传字段值。`is_forbidden` 由调用方给出：请求体用 `sensitive_key`，
/// Provider 配置用 [`ai_credential_field_name`]。
fn ai_forbidden_field_path(
    value: &Value,
    prefix: &str,
    is_forbidden: fn(&str) -> bool,
) -> Option<String> {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                if is_forbidden(key) {
                    return Some(path);
                }
                if let Some(found) = ai_forbidden_field_path(child, &path, is_forbidden) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                let path = format!("{prefix}[{index}]");
                if let Some(found) = ai_forbidden_field_path(child, &path, is_forbidden) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn ai_invalid_request(message: &str) -> String {
    structured_ai_error("invalid_request", message, None, json!({}))
}

/// 浏览器壳 `src/service/ai_transport.ts` 的 `CREDENTIAL_FIELD` 规则：
/// 字段名里出现 key / token / secret / credential / password / authorization
/// 就属于密钥形状，必须单独走 `ai_secret_set`，不得随 Provider 配置提交。
/// 两个壳必须拒绝同一批载荷，否则同一份配置会在其中一个壳里静默成功。
fn ai_credential_field_name(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    [
        "key",
        "token",
        "secret",
        "credential",
        "password",
        "authorization",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

/// A credential-shaped query parameter is secret even when the field itself is
/// the otherwise-safe `base_url` metadata field.
fn ai_inline_credential_field(value: &Value, prefix: &str) -> Option<String> {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                if key == "base_url" {
                    if let Some(url) = child.as_str() {
                        let query = url
                            .split_once('?')
                            .map(|(_, query)| {
                                query.split_once('#').map(|(part, _)| part).unwrap_or(query)
                            })
                            .unwrap_or("");
                        for parameter in query.split('&') {
                            let Some((name, raw_value)) = parameter.split_once('=') else {
                                continue;
                            };
                            let decoded_name =
                                ai_percent_decode(name).unwrap_or_else(|| name.to_owned());
                            if !raw_value.is_empty() && ai_credential_field_name(&decoded_name) {
                                return Some(format!("{path}[query:{decoded_name}]"));
                            }
                        }
                    }
                }
                if let Some(found) = ai_inline_credential_field(child, &path) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().enumerate().find_map(|(index, child)| {
            ai_inline_credential_field(child, &format!("{prefix}[{index}]"))
        }),
        _ => None,
    }
}

/// Provider ID 必须可用于文件名/键名：与浏览器壳的 `PROVIDER_ID_PATTERN` 一致。
fn ai_valid_provider_id(provider_id: &str) -> bool {
    let mut characters = provider_id.chars();
    match characters.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    provider_id.chars().count() <= 64
        && provider_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn ai_validate_provider_id(provider_id: &str) -> Result<String, String> {
    let trimmed = provider_id.trim();
    if trimmed.is_empty() {
        return Err(ai_invalid_request("Provider ID 不能为空。"));
    }
    if !ai_valid_provider_id(trimmed) {
        return Err(ai_invalid_request(
            "Provider ID 只能使用字母、数字、下划线或短横线，且必须以字母或数字开头（最长 64 个字符）。",
        ));
    }
    Ok(trimmed.to_owned())
}

/// 解开 `{ "input": { … } }` 调用信封（或直接用裸字段）并返回载荷对象，
/// **不**做凭据字段扫描：AI 载荷里 `body` 是任意模型请求体，`headers` 可能带
/// 别名字段，硬拒会把正常请求挡掉（`max_tokens` 这类标准参数会被 `sensitive_key`
/// 的“token 结尾”规则误伤吗？不会——它既不是分隔词，也不在词尾）。
fn ai_payload(input: &Value, command: &str) -> Result<Map<String, Value>, String> {
    if input.is_null() {
        return Ok(Map::new());
    }
    let outer = input
        .as_object()
        .ok_or_else(|| format!("{command} 需要结构化参数"))?;
    match outer.get("input") {
        Some(inner) if inner.is_object() => inner
            .as_object()
            .cloned()
            .ok_or_else(|| format!("{command} 需要结构化参数")),
        _ => Ok(outer.clone()),
    }
}

/// 同 [`ai_payload`]，但沿用 `require_object` 的凭据字段扫描：用于字段固定的命令。
fn strict_payload(input: &Value, command: &str) -> Result<Map<String, Value>, String> {
    if input.is_null() {
        return Ok(Map::new());
    }
    let outer = require_object(input, command)?;
    match outer.get("input") {
        Some(inner) if inner.is_object() => Ok(require_object(inner, command)?.clone()),
        _ => Ok(outer.clone()),
    }
}

/// 把可能很长的 Provider 文本截断到 `limit` 个字符，供 `details` 使用。
fn ai_error_text_limit(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_owned();
    }
    let head: String = trimmed.chars().take(limit).collect();
    format!("{head}…")
}

// ---------------------------------------------------------------------------
// 凭据擦除：与浏览器壳 `scrubFreeText` / `scrubProviderText`（`ai_transport.ts`）
// 及 `redactSecrets`（`errors.ts`）同一套规则。顺序固定为
// 精确值 → 标签/Bearer/sk- → 不透明串；Provider 正文先判「变形回显」并整段丢弃，
// 再解转义。两个壳必须给出同一结果，否则同一份 Provider 响应会在一个壳里泄露。
// ---------------------------------------------------------------------------

const AI_REDACTED: &str = "[REDACTED]";
/// 短于这个长度的凭据不做精确替换：会把普通文本也搅碎。
const AI_MIN_EXACT_SECRET_CHARS: usize = 4;
/// 被拆开的凭据至少要有这么长的片段才算命中。
const AI_MIN_SPLIT_FRAGMENT_CHARS: usize = 8;
/// 自由文本字段：用户可能把密钥粘进指令框，或错误信息里回显了密钥。
const AI_FREE_TEXT_FIELDS: [&str; 2] = ["instruction", "error_message"];
/// `errors.ts` 里认得的凭据标签（`.` 表示可选的一个 `-` / `_`）。
const AI_SECRET_LABELS: [&str; 21] = [
    "x.goog.api.key",
    "x.api.key",
    "api.key",
    "api.secret",
    "access.token",
    "refresh.token",
    "id.token",
    "auth.token",
    "bearer.token",
    "private.key",
    "client.secret",
    "secret.key",
    "passphrase",
    "password",
    "authorization",
    "bearer",
    "credential",
    "credentials",
    "cookie",
    "secret",
    "token",
];

/// 擦除素材：从系统钥匙串读取；无法确认所有凭据时，调用方必须拒绝读写。
#[derive(Default, Clone)]
struct AiSecrets {
    /// 精确替换用的形态：`<scheme> <value>` 与裸 `<value>`，长的在前。
    forms: Vec<String>,
    /// 有没有短到不能精确替换的凭据：有的话 Provider 正文一律不回显。
    has_short: bool,
}

fn ai_stored_secrets(base: &Path) -> Result<AiSecrets, String> {
    let store = ai_read_provider_store_secure(base)?;
    let providers = store
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let credential_store = ai_credential_store(base);
    let mut forms: Vec<String> = Vec::new();
    let mut has_short = false;
    for provider in providers {
        let Some(object) = provider.as_object() else {
            continue;
        };
        let Some(provider_id) = object.get("id").and_then(Value::as_str) else {
            continue;
        };
        let value = credential_store
            .get(provider_id)
            .map_err(|_| "无法安全读取系统钥匙串，未生成或读取 AI 执行记录".to_owned())?;
        let Some(value) = value else { continue };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if value.chars().count() < AI_MIN_EXACT_SECRET_CHARS {
            has_short = true;
        }
        let scheme = field(object, &["auth_scheme", "authScheme"])
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if !scheme.is_empty() {
            forms.push(format!("{scheme} {value}"));
        }
        forms.push(value.to_owned());
    }
    forms.sort_by(|left, right| right.chars().count().cmp(&left.chars().count()));
    forms.dedup();
    Ok(AiSecrets { forms, has_short })
}

/// 精确值替换；短于 4 个字符的交给标签规则（替换会搅碎普通文本）。
fn ai_exact_scrub(text: &str, secrets: &[String]) -> String {
    let mut output = text.to_owned();
    for secret in secrets {
        if secret.chars().count() < AI_MIN_EXACT_SECRET_CHARS {
            continue;
        }
        if output.contains(secret.as_str()) {
            output = output.replace(secret.as_str(), AI_REDACTED);
        }
    }
    output
}

fn ai_opaque_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=' | '_' | '-')
}

/// 不透明串：至少 16 个凭据字母表字符，且含数字或大写字母。
/// 普通标识符（`deepseek-reasoner`）因此能活下来，编码过的回显不能。
fn ai_redact_opaque_runs(text: &str) -> String {
    let characters: Vec<char> = text.chars().collect();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    while index < characters.len() {
        if !ai_opaque_character(characters[index]) {
            output.push(characters[index]);
            index += 1;
            continue;
        }
        let start = index;
        while index < characters.len() && ai_opaque_character(characters[index]) {
            index += 1;
        }
        let run = &characters[start..index];
        let shaped = run.len() >= 16
            && run
                .iter()
                .any(|character| character.is_ascii_digit() || character.is_ascii_uppercase());
        if shaped {
            output.push_str(AI_REDACTED);
        } else {
            output.extend(run);
        }
    }
    output
}

/// 标签匹配：`.` 代表一个可选的 `-` / `_`（`x-api-key` / `x_api_key` 都算）。
fn ai_match_secret_label(text: &[char], start: usize, label: &str) -> Option<usize> {
    let mut cursor = start;
    for pattern in label.chars() {
        if pattern == '.' {
            if matches!(text.get(cursor), Some('-' | '_')) {
                cursor += 1;
            }
            continue;
        }
        let character = text.get(cursor)?;
        if !character.eq_ignore_ascii_case(&pattern) {
            return None;
        }
        cursor += 1;
    }
    Some(cursor)
}

/// 值：`"…"` / `'…'` / 一直到换行、`,`、`;`、`&`、引号的裸串。
fn ai_match_secret_value(text: &[char], start: usize) -> Option<usize> {
    let quote = match text.get(start) {
        Some('"') => Some('"'),
        Some('\'') => Some('\''),
        Some(_) => None,
        None => return None,
    };
    match quote {
        Some(quote) => {
            let mut cursor = start + 1;
            while let Some(character) = text.get(cursor) {
                if *character == '\n' {
                    return None;
                }
                if *character == quote {
                    return Some(cursor + 1);
                }
                cursor += 1;
            }
            None
        }
        None => {
            let mut cursor = start;
            while let Some(character) = text.get(cursor) {
                if matches!(character, '\n' | ',' | ';' | '&' | '"' | '\'') {
                    break;
                }
                cursor += 1;
            }
            if cursor > start {
                Some(cursor)
            } else {
                None
            }
        }
    }
}

/// `authorization: Bearer <x>` / `api_key=<x>`：整段值换成 `[REDACTED]`，标签保留。
fn ai_redact_labelled_values(text: &str) -> String {
    let characters: Vec<char> = text.chars().collect();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    while index < characters.len() {
        let mut matched: Option<(usize, usize)> = None;
        for label in AI_SECRET_LABELS {
            let Some(after_label) = ai_match_secret_label(&characters, index, label) else {
                continue;
            };
            let mut cursor = after_label;
            if matches!(characters.get(cursor), Some('"' | '\'')) {
                cursor += 1;
            }
            while matches!(characters.get(cursor), Some(character) if character.is_whitespace()) {
                cursor += 1;
            }
            if !matches!(characters.get(cursor), Some(':' | '=')) {
                continue;
            }
            cursor += 1;
            while matches!(characters.get(cursor), Some(character) if character.is_whitespace()) {
                cursor += 1;
            }
            if let Some(end) = ai_match_secret_value(&characters, cursor) {
                matched = Some((end, cursor));
                break;
            }
        }
        match matched {
            Some((end, value_start)) => {
                output.extend(&characters[index..value_start]);
                output.push_str(AI_REDACTED);
                index = end;
            }
            None => {
                output.push(characters[index]);
                index += 1;
            }
        }
    }
    output
}

/// 没有标签引入的 `Bearer <token>`：整段抹掉。
fn ai_redact_bearer(text: &str) -> String {
    let characters: Vec<char> = text.chars().collect();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    while index < characters.len() {
        let word_start = index == 0
            || !(characters[index - 1].is_ascii_alphanumeric() || characters[index - 1] == '_');
        let matches_bearer = word_start
            && characters.len() >= index + 6
            && characters[index..index + 6]
                .iter()
                .zip("Bearer".chars())
                .all(|(left, right)| left.eq_ignore_ascii_case(&right));
        if !matches_bearer {
            output.push(characters[index]);
            index += 1;
            continue;
        }
        let mut cursor = index + 6;
        let whitespace_start = cursor;
        while matches!(characters.get(cursor), Some(character) if character.is_whitespace()) {
            cursor += 1;
        }
        if cursor == whitespace_start {
            output.push(characters[index]);
            index += 1;
            continue;
        }
        let value_start = cursor;
        while let Some(character) = characters.get(cursor) {
            if character.is_whitespace() || matches!(character, ',' | ';' | '&' | '"' | '\'') {
                break;
            }
            cursor += 1;
        }
        if cursor == value_start {
            output.push(characters[index]);
            index += 1;
            continue;
        }
        output.push_str(AI_REDACTED);
        index = cursor;
    }
    output
}

/// 自身就认得出来的密钥形状：`sk-…`。
fn ai_redact_prefixed_keys(text: &str) -> String {
    let characters: Vec<char> = text.chars().collect();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    while index < characters.len() {
        let word_start = index == 0
            || !(characters[index - 1].is_ascii_alphanumeric() || characters[index - 1] == '_');
        let matches_prefix = word_start
            && characters.len() >= index + 3
            && characters[index] == 's'
            && characters[index + 1] == 'k'
            && characters[index + 2] == '-';
        if !matches_prefix {
            output.push(characters[index]);
            index += 1;
            continue;
        }
        let mut cursor = index + 3;
        while let Some(character) = characters.get(cursor) {
            if !(character.is_ascii_alphanumeric() || matches!(character, '_' | '-')) {
                break;
            }
            cursor += 1;
        }
        if cursor - (index + 3) < 6 {
            output.push(characters[index]);
            index += 1;
            continue;
        }
        output.push_str(AI_REDACTED);
        index = cursor;
    }
    output
}

fn ai_redact_labelled(text: &str) -> String {
    let values = ai_redact_labelled_values(text);
    let bearer = ai_redact_bearer(&values);
    ai_redact_prefixed_keys(&bearer)
}

fn ai_compact_secret_text(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect()
}

/// 反转 / base64 / hex 三种「看起来不像密钥」的回显拼写。
fn ai_encoded_secret_forms(secret: &str) -> Vec<String> {
    let mut forms = Vec::new();
    let reversed: String = secret.chars().rev().collect();
    if reversed != secret && !reversed.is_empty() {
        forms.push(reversed);
    }
    let encoded = BASE64.encode(secret.as_bytes());
    if encoded != secret && !encoded.is_empty() {
        forms.push(encoded);
    }
    let hex: String = secret
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if hex != secret && !hex.is_empty() {
        forms.push(hex);
    }
    forms
}

/// 文本里是否出现了被拆分 / 反转 / 编码过的凭据。命中就无法安全保留任何摘要。
fn ai_contains_transformed_secret(text: &str, secrets: &[String]) -> bool {
    let compact = ai_compact_secret_text(text);
    if compact.is_empty() {
        return false;
    }
    for secret in secrets {
        let compact_secret = ai_compact_secret_text(secret);
        let characters: Vec<char> = compact_secret.chars().collect();
        if characters.len() < AI_MIN_SPLIT_FRAGMENT_CHARS {
            continue;
        }
        for form in ai_encoded_secret_forms(secret) {
            if text.contains(form.as_str())
                || compact.contains(ai_compact_secret_text(&form).as_str())
            {
                return true;
            }
        }
        let fragment = std::cmp::max(AI_MIN_SPLIT_FRAGMENT_CHARS, characters.len().div_ceil(2));
        for start in 0..=(characters.len() - fragment) {
            let window: String = characters[start..start + fragment].iter().collect();
            if compact.contains(window.as_str()) {
                return true;
            }
        }
    }
    false
}

fn ai_hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// `%NN` 全量解码；只要有一个 `%` 不是合法转义就保持原样（同 `decodeURIComponent`）。
fn ai_percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = ai_hex_digit(*bytes.get(index + 1)?)?;
            let low = ai_hex_digit(*bytes.get(index + 2)?)?;
            decoded.push(high * 16 + low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// 还原 Provider 正文可能使用的转义拼写：`%NN`、`\uXXXX`、`\xNN` 与常见简写。
fn ai_normalize_provider_text(text: &str) -> String {
    let decoded = ai_percent_decode(text).unwrap_or_else(|| text.to_owned());
    let characters: Vec<char> = decoded.chars().collect();
    let mut units: Vec<u16> = Vec::with_capacity(decoded.len());
    let mut buffer = [0_u16; 2];
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character != '\\' {
            units.extend_from_slice(character.encode_utf16(&mut buffer));
            index += 1;
            continue;
        }
        let escape = characters.get(index + 1).copied();
        if escape == Some('u') && characters.len() >= index + 6 {
            let digits = &characters[index + 2..index + 6];
            if let Some(value) = ai_hex_quad(digits) {
                units.push(value);
                index += 6;
                continue;
            }
        }
        if escape == Some('x') && characters.len() >= index + 4 {
            let digits = &characters[index + 2..index + 4];
            if let Some(value) = ai_hex_pair(digits) {
                units.push(value);
                index += 4;
                continue;
            }
        }
        if let Some(simple) = escape {
            let mapped = match simple {
                'n' => Some('\n'),
                'r' => Some('\r'),
                't' => Some('\t'),
                '"' => Some('"'),
                '\\' => Some('\\'),
                '/' => Some('/'),
                _ => None,
            };
            if let Some(mapped) = mapped {
                units.extend_from_slice(mapped.encode_utf16(&mut buffer));
                index += 2;
                continue;
            }
        }
        // 不认识的转义原样保留。
        units.extend_from_slice(character.encode_utf16(&mut buffer));
        index += 1;
    }
    String::from_utf16_lossy(&units)
}

fn ai_hex_quad(digits: &[char]) -> Option<u16> {
    let mut value: u16 = 0;
    for digit in digits {
        value = value.checked_mul(16)? + u16::from(ai_hex_digit(*digit as u8)?);
    }
    Some(value)
}

fn ai_hex_pair(digits: &[char]) -> Option<u16> {
    let high = ai_hex_digit(*digits.first()? as u8)?;
    let low = ai_hex_digit(*digits.get(1)? as u8)?;
    Some(u16::from(high) * 16 + u16::from(low))
}

/// 自由文本（指令、错误信息）的擦除顺序：精确值 → 标签/Bearer/sk- → 不透明串。
fn ai_scrub_free_text(text: &str, secrets: &[String]) -> String {
    ai_redact_opaque_runs(&ai_redact_labelled(&ai_exact_scrub(text, secrets)))
}

/// Provider 正文的完整擦除：先判变形回显并整段丢弃，再解转义、精确替换、
/// 标签规则与不透明串。
fn ai_scrub_provider_text(text: &str, secrets: &AiSecrets) -> String {
    if ai_contains_transformed_secret(text, &secrets.forms) {
        return AI_REDACTED.to_owned();
    }
    let decoded = ai_normalize_provider_text(text);
    let exact = ai_exact_scrub(&decoded, &secrets.forms);
    ai_redact_opaque_runs(&ai_redact_labelled(&exact))
}

/// 有效请求地址可能把密钥放在查询串里，所以它绝不进错误文本：统一用 `<url>` 占位。
fn ai_strip_request_url(text: &str, url: &str) -> String {
    let mut forms = vec![url.to_owned()];
    if let Ok(parsed) = reqwest::Url::parse(url) {
        let origin = parsed.origin().ascii_serialization();
        if !origin.is_empty() && origin != "null" {
            let path = parsed.path();
            forms.push(format!("{origin}{path}"));
            forms.push(format!("{origin}{path}/"));
        }
    }
    let mut output = text.to_owned();
    for form in forms {
        if form.is_empty() {
            continue;
        }
        if output.contains(form.as_str()) {
            output = output.replace(form.as_str(), "<url>");
        }
    }
    output
}

fn ai_body_kind(content_type: &str) -> &'static str {
    let lowered = content_type.to_ascii_lowercase();
    if lowered.contains("html") {
        "html"
    } else if lowered.contains("json") {
        "json"
    } else {
        "text"
    }
}

// ---- Provider 目录 -------------------------------------------------------

fn ai_provider_records(store: &Map<String, Value>) -> Vec<Value> {
    store
        .get("providers")
        .and_then(Value::as_array)
        .map(|providers| {
            providers
                .iter()
                .map(|provider| ai_sanitize_record(provider, &[]))
                .collect::<Vec<Value>>()
        })
        .unwrap_or_default()
}

/// Provider 列表 + `configured` 布尔表；**永远不含凭据本身**。
fn ai_connection_view(store: &Map<String, Value>, configured: Map<String, Value>) -> Value {
    let providers = ai_provider_records(store);
    json!({ "providers": providers, "configured": Value::Object(configured) })
}

fn ai_connection_list_at(base: &Path) -> Result<Value, String> {
    let store = ai_read_provider_store_secure(base)?;
    let credential_store = ai_credential_store(base);
    let mut configured = Map::new();
    for provider in ai_provider_records(&store) {
        if let Some(id) = provider.get("id").and_then(Value::as_str) {
            let present = credential_store.get(id)?.is_some();
            configured.insert(id.to_owned(), json!(present));
        }
    }
    Ok(ai_connection_view(&store, configured))
}

fn ai_connection_save_at(base: &Path, provider: &Value) -> Result<Value, String> {
    let object = provider
        .as_object()
        .ok_or_else(|| ai_invalid_request("Provider 配置必须是 JSON 对象。"))?;
    let raw_id = field(object, &["id", "provider_id", "providerId"])
        .and_then(Value::as_str)
        .unwrap_or("");
    let provider_id = ai_validate_provider_id(raw_id)?;
    // 与浏览器壳一致：密钥形状的字段一律拒绝（而不是静默丢弃），
    // 这样同一份配置在两个壳里的行为完全相同。
    if let Some(field_path) = ai_forbidden_field_path(provider, "", ai_credential_field_name) {
        let leaf = field_path.rsplit('.').next().unwrap_or(field_path.as_str());
        let hint = if leaf.eq_ignore_ascii_case("requires_credential") {
            "「requires_credential」是界面元数据，请勿随配置提交。"
        } else {
            "密钥请通过「保存密钥」单独提交。"
        };
        return Err(structured_ai_error(
            "invalid_request",
            &format!("Provider 配置中出现了不允许的字段「{field_path}」。"),
            Some(&format!(
                "{hint}允许的字段：id / label / kind / base_url / chat_path / auth_header / auth_scheme / default_model / models。"
            )),
            json!({ "field": field_path }),
        ));
    }
    if let Some(field_path) = ai_inline_credential_field(provider, "") {
        return Err(structured_ai_error(
            "invalid_request",
            &format!("Provider 配置中出现了不允许的密钥查询参数「{field_path}」。"),
            Some("API Key 必须通过「保存密钥」单独提交。"),
            json!({ "field": field_path }),
        ));
    }
    let mut record = match ai_strip_sensitive(provider, ai_sensitive_key) {
        Value::Object(map) => map,
        _ => return Err(ai_invalid_request("Provider 配置必须是 JSON 对象。")),
    };
    record.insert("id".into(), json!(provider_id));
    let record = Value::Object(record);

    let paths = ai_store_paths(base);
    let mut store = ai_read_provider_store_secure(base)?;
    let providers = store
        .get_mut("providers")
        .and_then(Value::as_array_mut)
        .ok_or("AI Provider 配置格式无效")?;
    match providers.iter().position(|existing| {
        existing.get("id").and_then(Value::as_str) == Some(provider_id.as_str())
    }) {
        Some(index) => providers[index] = record.clone(),
        None => providers.push(record.clone()),
    }
    ai_write_provider_store(&paths.providers, &Value::Object(store), "AI Provider 配置")?;
    Ok(json!({ "provider": record }))
}

fn ai_connection_delete_at(base: &Path, provider_id: &str) -> Result<Value, String> {
    let paths = ai_store_paths(base);
    let mut store = ai_read_provider_store_secure(base)?;
    let removed_provider = store
        .get_mut("providers")
        .and_then(Value::as_array_mut)
        .map(|providers| {
            let before = providers.len();
            providers
                .retain(|provider| provider.get("id").and_then(Value::as_str) != Some(provider_id));
            providers.len() != before
        })
        .unwrap_or(false);
    let removed_credential = ai_credential_store(base).get(provider_id)?.is_some();
    if removed_credential {
        ai_credential_store(base).delete(provider_id)?;
    }
    let removed = removed_provider || removed_credential;
    if removed {
        ai_write_provider_store(&paths.providers, &Value::Object(store), "AI Provider 配置")?;
    }
    Ok(json!({ "provider_id": provider_id, "removed": removed }))
}

/// 保存凭据。`value` 只出现在钥匙串写入内容里：返回值、错误文本、日志一行都不带它。
fn ai_secret_set_at(base: &Path, provider_id: &str, value: &str) -> Result<Value, String> {
    let provider_id = ai_validate_provider_id(provider_id)?;
    let value = value.trim();
    if value.is_empty() {
        return Err(ai_invalid_request("API Key 不能为空。"));
    }
    if value.chars().count() > AI_CREDENTIAL_MAX_CHARS {
        return Err(ai_invalid_request(
            "API Key 过长，请确认粘贴的内容是否正确。",
        ));
    }
    let store = ai_read_provider_store_secure(base)?;
    ai_credential_store(base).set(&provider_id, value)?;
    // Only metadata is persisted. A failed write leaves the Keychain value
    // available and never creates a plaintext fallback.
    let paths = ai_store_paths(base);
    ai_write_provider_store(&paths.providers, &Value::Object(store), "AI Provider 配置")?;
    Ok(json!({ "provider_id": provider_id }))
}

fn ai_secret_delete_at(base: &Path, provider_id: &str) -> Result<Value, String> {
    ai_validate_provider_id(provider_id)?;
    let store = ai_read_provider_store_secure(base)?;
    let removed = ai_credential_store(base).delete(provider_id)?;
    if removed {
        let paths = ai_store_paths(base);
        ai_write_provider_store(&paths.providers, &Value::Object(store), "AI Provider 配置")?;
    }
    Ok(json!({ "provider_id": provider_id, "removed": removed }))
}

// ---- AI 传输 -------------------------------------------------------------

struct AiRequestSpec {
    request_id: String,
    provider_id: String,
    url: String,
    headers: Vec<(String, String)>,
    /// 由本地存储注入的鉴权头（名称 + 完整值）；值里含凭据，绝不外泄。
    auth_header: Option<(String, String)>,
    /// 已经序列化好的请求体：JSON 用紧凑编码，字符串按原样发送。
    body: Vec<u8>,
    timeout_ms: u64,
    /// 擦除素材（所有已存凭据的形态）：Provider 回显的正文一律先过它。
    secrets: AiSecrets,
}

/// HTTP 头名称的合法字符集（与浏览器壳的 `HEADER_NAME_PATTERN` 一致）。
fn ai_valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(
                    character,
                    '!' | '#'
                        | '$'
                        | '%'
                        | '&'
                        | '\''
                        | '*'
                        | '+'
                        | '.'
                        | '^'
                        | '_'
                        | '`'
                        | '|'
                        | '~'
                        | '-'
                )
        })
}

/// 请求头归一化：丢弃渲染层的内部标记与 `fetch` 自管头，缺省补 content-type。
fn ai_normalize_headers(value: Option<&Value>) -> Result<Vec<(String, String)>, String> {
    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(value) = value {
        if !value.is_null() {
            let object = value.as_object().ok_or_else(|| {
                structured_ai_error("invalid_request", "AI 请求头格式无效。", None, json!({}))
            })?;
            for (name, raw) in object {
                let header = name.trim().to_ascii_lowercase();
                if !ai_valid_header_name(&header) {
                    return Err(structured_ai_error(
                        "invalid_request",
                        "AI 请求头名称无效。",
                        None,
                        json!({}),
                    ));
                }
                // `x-workbench-*` 是渲染层的分发标记，绝不发给 Provider。
                if header.starts_with("x-workbench-") {
                    continue;
                }
                // 这两个头由传输层自己负责，转发会破坏请求。
                if header == "content-length" || header == "host" {
                    continue;
                }
                let Some(text) = raw.as_str() else {
                    return Err(structured_ai_error(
                        "invalid_request",
                        &format!("AI 请求头「{header}」的值必须是文本。"),
                        None,
                        json!({}),
                    ));
                };
                match headers.iter_mut().find(|(existing, _)| *existing == header) {
                    Some(entry) => entry.1 = text.to_owned(),
                    None => headers.push((header, text.to_owned())),
                }
            }
        }
    }
    if !headers.iter().any(|(name, _)| name == "content-type") {
        headers.push(("content-type".into(), "application/json".into()));
    }
    Ok(headers)
}

/// `auth` 归一化：只有 `header` 是非空字符串时才注入；
/// 本地 / 自定义端点可以完全不带鉴权头（既不注入，也不要求密钥）。
fn ai_normalize_auth(value: Option<&Value>) -> Result<Option<(String, String)>, String> {
    let value = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(value) => value,
    };
    let object = value.as_object().ok_or_else(|| {
        structured_ai_error("invalid_request", "AI 鉴权配置无效。", None, json!({}))
    })?;
    let header = field(object, &["header"])
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if header.is_empty() {
        return Ok(None);
    }
    if !ai_valid_header_name(header) {
        return Err(structured_ai_error(
            "invalid_request",
            "AI 鉴权头名称无效。",
            None,
            json!({}),
        ));
    }
    let scheme = field(object, &["scheme"])
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    Ok(Some((header.to_ascii_lowercase(), scheme.to_owned())))
}

/// 请求体序列化：字符串按原样发送，其余走紧凑 JSON；缺 body 直接报错。
fn ai_serialize_body(value: Option<&Value>) -> Result<Vec<u8>, String> {
    match value {
        None | Some(Value::Null) => Err(structured_ai_error(
            "invalid_request",
            "AI 请求缺少 body。",
            None,
            json!({}),
        )),
        Some(Value::String(text)) => Ok(text.clone().into_bytes()),
        Some(value) => serde_json::to_vec(value).map_err(|error| {
            structured_ai_error(
                "invalid_request",
                "AI 请求 body 无法序列化为 JSON。",
                None,
                json!({ "reason": error.to_string() }),
            )
        }),
    }
}

/// 只允许 https；本地联调额外允许本机回环（`127.0.0.1` / `localhost` / `::1`）。
fn ai_validate_request_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| {
        structured_ai_error(
            "invalid_request",
            "AI 请求地址无效，无法解析。",
            Some("请检查服务商接口地址。"),
            json!({}),
        )
    })?;
    match parsed.scheme() {
        "https" => Ok(()),
        "http" => match parsed.host_str() {
            // 与浏览器壳同一套白名单：仅本机回环（IPv4 / IPv6 / localhost）。
            Some("127.0.0.1") | Some("localhost") | Some("::1") | Some("[::1]") => Ok(()),
            _ => Err(ai_url_scheme_error()),
        },
        _ => Err(ai_url_scheme_error()),
    }
}

fn ai_url_scheme_error() -> String {
    structured_ai_error(
        "invalid_request",
        "出于安全考虑，AI 请求只允许 https:// 地址（本机调试可用 http://127.0.0.1 或 http://localhost）。",
        Some("请把服务地址改为 https:// 开头的接口地址。"),
        json!({}),
    )
}

fn ai_request_spec(base: &Path, input: &Value) -> Result<AiRequestSpec, String> {
    let payload = ai_payload(input, "ai_complete")?;
    // 防御性检查：上下文装配一旦把凭据字段塞进请求（例如 `api_key`），
    // 这里给出可读的 invalid_request 并指明字段路径，而不是把密钥发给 Provider。
    if let Some(field_path) =
        ai_forbidden_field_path(&Value::Object(payload.clone()), "", sensitive_key)
    {
        return Err(structured_ai_error(
            "invalid_request",
            &format!(
                "AI 请求里出现了疑似凭据的字段「{field_path}」，为避免把密钥发给 Provider，本次请求未发出。"
            ),
            Some("请检查上下文装配：请求体只能包含课程内容与标准模型参数，不能包含 API Key、令牌或密码字段。"),
            json!({ "field": field_path }),
        ));
    }
    // 与浏览器壳一致：request_id 缺省时本地补一个，取消依然可用。
    let request_id = field(&payload, &["request_id", "requestId"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| native_id("ai-request"));
    let provider_id = field(&payload, &["provider_id", "providerId"])
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_owned();
    // 地址统一走校验（含空值）：任何不被允许的形状都是 invalid_request。
    let url = field(&payload, &["url"])
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_owned();
    ai_validate_request_url(&url)?;
    let timeout_ms = match field(&payload, &["timeout_ms", "timeoutMs"]) {
        None | Some(Value::Null) => AI_DEFAULT_TIMEOUT_MS,
        Some(value) => {
            let raw = value.as_u64().filter(|value| *value > 0).ok_or_else(|| {
                structured_ai_error("invalid_request", "AI 请求超时时间无效。", None, json!({}))
            })?;
            raw.clamp(1, AI_MAX_TIMEOUT_MS)
        }
    };
    let auth = ai_normalize_auth(field(&payload, &["auth"]))?;
    let headers = ai_normalize_headers(field(&payload, &["headers"]))?;
    let body = ai_serialize_body(field(&payload, &["body"]))?;
    let credential = match &auth {
        None => None,
        Some(_) => {
            if provider_id.is_empty() {
                return Err(structured_ai_error(
                    "not_configured",
                    "尚未选择 AI 服务商，无法取出密钥。",
                    Some("在 AI 面板中选择并保存一个服务商后重试。"),
                    json!({}),
                ));
            }
            ai_read_provider_store_secure(base)?;
            Some(ai_keychain_credential(base, &provider_id)?.ok_or_else(|| {
                structured_ai_error(
                    "missing_credential",
                    &format!("AI 服务商「{provider_id}」还没有配置 API Key。"),
                    Some("在 AI 面板点击该服务商的「保存密钥」，填入 API Key 后重试。"),
                    json!({ "provider_id": provider_id.clone() }),
                )
            })?)
        }
    };
    let auth_header = match (auth, credential.clone()) {
        (Some((header, scheme)), Some(credential)) => {
            let value = if scheme.is_empty() {
                credential
            } else {
                format!("{scheme} {credential}")
            };
            Some((header, value))
        }
        _ => None,
    };
    Ok(AiRequestSpec {
        request_id,
        provider_id,
        url,
        headers,
        auth_header,
        body,
        timeout_ms,
        // 存储里的每个凭据（含 `<scheme> <value>` 形态）都参与擦除，
        // 而不是只擦本次注入的那一个。
        secrets: ai_stored_secrets(base)?,
    })
}

fn ai_status_error(
    status: u16,
    text: &str,
    secrets: &AiSecrets,
    provider_id: &str,
    url: &str,
    content_type: &str,
) -> String {
    // 敌意或出错的 Provider 会在错误正文里回显请求（含地址与请求头）。
    // 摘要有四层：换掉有效地址 → 判变形回显并整段丢弃 → 解转义+精确值+模式擦除 → 截断。
    // 只要存有短到不能精确替换的凭据，就一个字都不回显：可读性比不上不泄露。
    let detail = if secrets.has_short {
        AI_REDACTED.to_owned()
    } else {
        ai_error_text_limit(
            &ai_scrub_provider_text(&ai_strip_request_url(text.trim(), url), secrets),
            AI_ERROR_TEXT_LIMIT,
        )
    };
    let details = json!({
        "provider_id": if provider_id.is_empty() { Value::Null } else { json!(provider_id) },
        "status": status,
        "body_kind": ai_body_kind(content_type),
        "body_chars": text.chars().count(),
        "detail": detail,
    });
    // 3xx：传输层不跟随跳转（自定义鉴权头不能被转发到别的站点）。
    if (300..400).contains(&status) {
        return structured_ai_error(
            "provider_error",
            "AI 服务商地址发生了跳转，为避免密钥被转发到其他站点，请求已停止。",
            Some("请把服务地址改为最终地址后重试。"),
            details,
        );
    }
    match status {
        401 => structured_ai_error(
            "missing_credential",
            "服务商拒绝了本次请求（401）：API Key 可能不正确、已过期或未授权。",
            Some("在 AI 面板重新保存该服务商的 API Key 后重试。"),
            details,
        ),
        403 => structured_ai_error(
            "permission_denied",
            "服务商拒绝了本次请求（403）：该密钥没有调用此模型或接口的权限。",
            Some("确认密钥权限、账号额度或更换模型后重试。"),
            details,
        ),
        429 => structured_ai_error(
            "rate_limited",
            "请求过于频繁（429），服务商已限流。",
            Some("等待一段时间后重试，或降低请求频率。"),
            details,
        ),
        _ if status >= 500 => structured_ai_error(
            "provider_error",
            &format!("AI 服务商暂时不可用（HTTP {status}）。"),
            Some("稍后重试；若持续失败，请查看服务商状态页。"),
            details,
        ),
        _ => structured_ai_error(
            "provider_error",
            &format!("AI 服务商返回错误（HTTP {status}）。"),
            Some("检查模型名称与服务地址后重试。"),
            details,
        ),
    }
}

fn ai_transport_error(
    error: reqwest::Error,
    timeout_ms: u64,
    url: &str,
    secrets: &AiSecrets,
    provider_id: &str,
) -> String {
    // reqwest 的错误文本会带上完整 URL（查询串里可能有密钥），
    // 所以先换掉地址，再按 Provider 正文的规则擦一遍。
    let raw = ai_error_text_limit(
        &ai_scrub_provider_text(&ai_strip_request_url(&error.to_string(), url), secrets),
        AI_ERROR_TEXT_LIMIT,
    );
    let provider = if provider_id.is_empty() {
        Value::Null
    } else {
        json!(provider_id)
    };
    if error.is_timeout() {
        let seconds = std::cmp::max(1, (timeout_ms as f64 / 1000.0).round() as u64);
        return structured_ai_error(
            "timeout",
            &format!("AI 服务商在 {seconds} 秒内没有响应，请求已结束。"),
            Some("稍后重试；如果持续超时，请换用响应更快的模型。"),
            json!({ "provider_id": provider, "timeout_ms": timeout_ms }),
        );
    }
    structured_ai_error(
        "transport_unavailable",
        "无法连接到 AI 服务商，请检查网络连接或服务地址。",
        Some("检查网络与服务地址后重试。"),
        json!({ "provider_id": provider, "reason": raw }),
    )
}

async fn ai_perform_request(spec: AiRequestSpec) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(spec.timeout_ms))
        // 不跟随重定向：跳转可能把自定义鉴权头转发到用户没有配置过的站点。
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| {
            structured_ai_error(
                "transport_unavailable",
                "无法初始化 AI 网络客户端。",
                Some("请重启工作台后重试。"),
                json!({ "reason": ai_error_text_limit(&error.to_string(), AI_ERROR_TEXT_LIMIT) }),
            )
        })?;
    let mut request = client.post(&spec.url);
    for (name, value) in &spec.headers {
        request = request.header(name.as_str(), value.as_str());
    }
    if let Some((name, value)) = &spec.auth_header {
        // 鉴权头最后写入：调用方即使传了同名头，也以本地保存的凭据为准。
        request = request.header(name.as_str(), value.as_str());
    }
    let response = request
        .body(spec.body.clone())
        .send()
        .await
        .map_err(|error| {
            ai_transport_error(
                error,
                spec.timeout_ms,
                &spec.url,
                &spec.secrets,
                &spec.provider_id,
            )
        })?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    if let Some(size) = response
        .content_length()
        .filter(|length| *length > AI_RESPONSE_SIZE_LIMIT)
    {
        return Err(structured_ai_error(
            "provider_error",
            "AI 服务商返回的内容过大，已停止处理。",
            Some("缩小上下文后重试。"),
            json!({
                "provider_id": if spec.provider_id.is_empty() { Value::Null } else { json!(spec.provider_id) },
                "size": size,
            }),
        ));
    }
    let bytes = response.bytes().await.map_err(|error| {
        ai_transport_error(
            error,
            spec.timeout_ms,
            &spec.url,
            &spec.secrets,
            &spec.provider_id,
        )
    })?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if !status.is_success() {
        return Err(ai_status_error(
            status.as_u16(),
            &text,
            &spec.secrets,
            &spec.provider_id,
            &spec.url,
            &content_type,
        ));
    }
    let content_type_value = json!(content_type);
    if content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
    {
        Ok(json!({
            "status": status.as_u16(),
            "headers": { "content-type": content_type_value },
            "body": text,
            "response_kind": "stream",
        }))
    } else {
        // 解析不了就按原文回传，由前端判定 malformed_response。
        let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
        Ok(json!({
            "status": status.as_u16(),
            "headers": { "content-type": content_type_value },
            "body": body,
            "response_kind": "json",
        }))
    }
}

/// P2-1：读取服务商自己的模型列表（GET `{base_url}/models`）。
///
/// 密钥只在本机从钥匙串取出并作为鉴权头发出，绝不回传给前端；读取失败返回
/// 结构化错误，由界面转成「手动填写 Model ID」，因此应用里不需要维护一份
/// 会过期的模型名表。
async fn ai_models_list_at(base: &Path, input: &Value) -> Result<Value, String> {
    let payload = ai_payload(input, "ai_models_list")?;
    let provider_id = field(&payload, &["provider_id", "providerId"])
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_owned();
    if provider_id.is_empty() {
        return Err(structured_ai_error(
            "not_configured",
            "还没有选择 AI 服务商，无法读取模型列表。",
            Some("先在 AI 面板里选择并保存一个服务商。"),
            json!({}),
        ));
    }
    let state = ai_read_provider_store_secure(base)?;
    let providers = state
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let provider = providers
        .iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(provider_id.as_str()))
        .cloned();
    let provider = match provider {
        Some(provider) => provider,
        None => {
            return Err(structured_ai_error(
                "not_configured",
                &format!("找不到服务商「{provider_id}」的配置。"),
                Some("先在 AI 面板里保存这个服务商，再读取模型列表。"),
                json!({ "provider_id": provider_id }),
            ))
        }
    };
    let credential = match ai_keychain_credential(base, &provider_id)? {
        Some(value) if !value.trim().is_empty() => value,
        _ => {
            return Err(structured_ai_error(
                "missing_credential",
                &format!("AI 服务商「{provider_id}」还没有配置 API Key。"),
                Some("先保存 API Key，再读取模型列表；也可以直接手动填写 Model ID。"),
                json!({ "provider_id": provider_id }),
            ))
        }
    };
    let base_url = field(&payload, &["base_url", "baseUrl"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            provider
                .get("base_url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
        .ok_or_else(|| {
            structured_ai_error(
                "invalid_request",
                "还没有填写 Base URL，无法读取模型列表。",
                Some("在服务商设置里填写 Base URL 后重试。"),
                json!({ "provider_id": provider_id }),
            )
        })?;
    let endpoint = format!("{}/models", base_url.trim_end_matches('/'));
    ai_validate_request_url(&endpoint)?;
    let header = provider
        .get("auth_header")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("authorization")
        .to_owned();
    let scheme = provider
        .get("auth_scheme")
        .and_then(Value::as_str)
        .unwrap_or("Bearer");
    // 只保留真正会出现在报文里的凭据形状；短凭据一律不回显 Provider 正文。
    let mut secret_forms: Vec<String> = vec![credential.trim().to_owned()];
    if !scheme.trim().is_empty() {
        secret_forms.push(format!("{} {}", scheme.trim(), credential.trim()));
    }
    let secrets = AiSecrets {
        forms: secret_forms,
        has_short: credential.trim().chars().count() < AI_MIN_EXACT_SECRET_CHARS,
    };
    let auth_value = if scheme.trim().is_empty() {
        credential.clone()
    } else {
        format!("{} {}", scheme.trim(), credential)
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(AI_DEFAULT_TIMEOUT_MS))
        // 与对话请求一致：不跟随重定向，避免把自定义鉴权头转发到别的站点。
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| {
            structured_ai_error(
                "transport_unavailable",
                "无法初始化 AI 网络客户端。",
                Some("请重启工作台后重试。"),
                json!({ "reason": ai_error_text_limit(&error.to_string(), AI_ERROR_TEXT_LIMIT) }),
            )
        })?;
    let response = client
        .get(&endpoint)
        .header("accept", "application/json")
        .header(header.as_str(), auth_value.as_str())
        .send()
        .await
        .map_err(|error| {
            ai_transport_error(
                error,
                AI_DEFAULT_TIMEOUT_MS,
                &endpoint,
                &secrets,
                &provider_id,
            )
        })?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = response.bytes().await.map_err(|error| {
        ai_transport_error(
            error,
            AI_DEFAULT_TIMEOUT_MS,
            &endpoint,
            &secrets,
            &provider_id,
        )
    })?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if !status.is_success() {
        return Err(ai_status_error(
            status.as_u16(),
            &text,
            &secrets,
            &provider_id,
            &endpoint,
            &content_type,
        ));
    }
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    let models = ai_model_ids_from_payload(&parsed);
    if models.is_empty() {
        return Err(structured_ai_error(
            "provider_error",
            "服务商没有返回可识别的模型名。",
            Some("可以在设置里手动填写 Model ID，不影响保存与运行。"),
            json!({ "provider_id": provider_id, "endpoint": endpoint }),
        ));
    }
    Ok(json!({
        "provider_id": provider_id,
        "models": models,
        "endpoint": endpoint,
    }))
}

/// 服务商实际返回的几种模型列表形状：`data[].id` / `models[].id|name` / 纯数组。
fn ai_model_ids_from_payload(payload: &Value) -> Vec<String> {
    let entries = match payload {
        Value::Array(entries) => entries.clone(),
        Value::Object(map) => map
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| map.get("models").and_then(Value::as_array))
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let mut ids: Vec<String> = entries
        .iter()
        .filter_map(|entry| match entry {
            Value::String(text) => Some(text.trim().to_owned()),
            Value::Object(map) => map
                .get("id")
                .or_else(|| map.get("name"))
                .or_else(|| map.get("model"))
                .and_then(Value::as_str)
                .map(|value| value.trim().to_owned()),
            _ => None,
        })
        .filter(|value| !value.is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// 发一次请求并把 `JoinHandle` 登记到 `requests`；取消时由 `ai_cancel_at` 中止。
async fn ai_complete_at(
    base: &Path,
    requests: &AiRequestHandles,
    input: &Value,
) -> Result<Value, String> {
    let spec = ai_request_spec(base, input)?;
    let request_id = spec.request_id.clone();
    let (sender, mut receiver) = tauri::async_runtime::channel::<Result<Value, String>>(1);
    let handle = tauri::async_runtime::spawn(async move {
        let outcome = ai_perform_request(spec).await;
        let _ = sender.send(outcome).await;
    });
    requests.lock().unwrap().insert(request_id.clone(), handle);
    let outcome = receiver.recv().await;
    requests.lock().unwrap().remove(&request_id);
    match outcome {
        Some(outcome) => outcome,
        // 被 abort 的任务连同发送端一起消失：这就是「已取消」。
        None => Err(structured_ai_error(
            "cancelled",
            "已取消这次 AI 请求",
            Some("可以重新发起请求；已取消的请求不会改动课程内容。"),
            json!({ "request_id": request_id }),
        )),
    }
}

fn ai_cancel_at(requests: &AiRequestHandles, input: &Value) -> Result<Value, String> {
    // 取消必须永不失败：空 / 未知 / 已结束的 id 都是空操作，重复点取消是正常操作。
    let payload = ai_payload(input, "ai_cancel")?;
    let request_id = field(&payload, &["request_id", "requestId"])
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let cancelled = if request_id.is_empty() {
        false
    } else {
        match requests.lock().unwrap().remove(request_id) {
            Some(handle) => {
                handle.abort();
                true
            }
            None => false,
        }
    };
    Ok(json!({ "cancelled": cancelled }))
}

// ---- 执行记录（非 Canonical，写失败不得影响课程保存） ---------------------

/// 执行记录写入失败时使用的结构化错误：只提示，绝不影响课程保存
/// （与浏览器壳 `ai_execution_record_failed` 同一 code）。
fn ai_execution_record_failed(reason: &str) -> String {
    structured_ai_error(
        "ai_execution_record_failed",
        "AI 执行记录未能写入，课程内容不受影响。",
        Some("可以继续编辑课程；如需保留记录，请确认工作台的本地数据目录可写。"),
        json!({ "operation": "ai.execution.append", "reason": reason }),
    )
}

/// 追加或按 `id` **就地替换**一条执行记录。
///
/// 同一次运行会先写一条 `pending`，用户随后做出决定（`applied` / `rejected`）时会
/// 再写一次：按 `id` 替换而不是再插一行，历史里只留一行，并且保留它原来的列表位置，
/// 所以调用方看到的最新在前顺序不会因为「补写决定」而改变。旧实现留下的同一个
/// `id` 的多余行，也会在这一次替换里一并清掉。
fn ai_execution_append_at(base: &Path, record: &Value) -> Result<Value, String> {
    // 无法确认全部凭据时拒绝写入，避免执行记录成为泄漏通道。
    let secrets = ai_stored_secrets(base)?;
    let mut cleaned = ai_sanitize_record(record, &secrets.forms);
    let object = cleaned
        .as_object_mut()
        .ok_or_else(|| ai_execution_record_failed("AI 执行记录必须是 JSON 对象"))?;
    let supplied_id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let id = supplied_id.clone().unwrap_or_else(|| native_id("ai-exec"));
    object.insert("id".into(), json!(id));
    let paths = ai_store_paths(base);
    let mut store = ai_read_execution_store(&paths.executions)
        .map_err(|error| ai_execution_record_failed(&error))?;
    let records = store
        .get_mut("records")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| ai_execution_record_failed("AI 执行记录格式无效"))?;
    let existing = supplied_id.as_deref().and_then(|id| {
        records
            .iter()
            .position(|existing| existing.get("id").and_then(Value::as_str) == Some(id))
    });
    match existing {
        Some(index) => {
            records[index] = cleaned;
            let mut cursor = index + 1;
            while cursor < records.len() {
                if records[cursor].get("id").and_then(Value::as_str) == Some(id.as_str()) {
                    records.remove(cursor);
                } else {
                    cursor += 1;
                }
            }
        }
        None => {
            records.insert(0, cleaned);
            records.truncate(AI_EXECUTION_LIMIT);
        }
    }
    // 这里刻意不取任何项目锁：执行记录写失败只能提示，不能影响 project_save。
    ai_write_store(&paths.executions, &Value::Object(store), "AI 执行记录")
        .map_err(|error| ai_execution_record_failed(&error))?;
    Ok(json!({ "id": id }))
}

fn ai_execution_list_at(base: &Path, limit: usize) -> Result<Value, String> {
    let paths = ai_store_paths(base);
    let store = ai_read_execution_store(&paths.executions)?;
    // 读取路径同样擦一遍（纵深防御）：无法确认全部凭据时拒绝返回记录。
    let secrets = ai_stored_secrets(base)?;
    let mut records: Vec<Value> = store
        .get("records")
        .and_then(Value::as_array)
        .map(|records| {
            records
                .iter()
                .map(|record| ai_sanitize_record(record, &secrets.forms))
                .collect()
        })
        .unwrap_or_default();
    // 新的在前；时间戳相同时保持写入顺序（稳定排序）。
    records.sort_by(|left, right| {
        let left = left.get("created_at").and_then(Value::as_str).unwrap_or("");
        let right = right
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("");
        right.cmp(left)
    });
    records.truncate(limit.clamp(1, AI_EXECUTION_LIMIT));
    Ok(json!({ "records": records }))
}

// ---- 命令入口（只在这里解析应用数据目录） ---------------------------------

/// 取原始 invoke 载荷。
///
/// 桌面壳的 `nativeInput` 不会给 AI 命令补 `input` 信封，而服务壳走的是
/// `{ "input": { … } }`；两种形状都必须能用，所以这里直接读原始载荷，
/// 再交给 [`ai_payload`] / [`strict_payload`] 统一拆封。
fn ai_invoke_args(request: &tauri::ipc::Request<'_>) -> Value {
    match request.body() {
        tauri::ipc::InvokeBody::Json(value) => value.clone(),
        _ => Value::Null,
    }
}

#[tauri::command]
fn ai_connection_list(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    strict_payload(&ai_invoke_args(&request), "ai_connection_list")?;
    ai_connection_list_at(&ai_store_dir(&app)?)
}

#[tauri::command]
fn ai_connection_save(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let payload = ai_payload(&ai_invoke_args(&request), "ai_connection_save")?;
    let provider = field(&payload, &["provider"])
        .cloned()
        .unwrap_or_else(|| Value::Object(payload.clone()));
    ai_connection_save_at(&ai_store_dir(&app)?, &provider)
}

#[tauri::command]
fn ai_connection_delete(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let payload = strict_payload(&ai_invoke_args(&request), "ai_connection_delete")?;
    let provider_id = required_string(&payload, &["provider_id", "providerId"], "Provider ID")?;
    ai_connection_delete_at(&ai_store_dir(&app)?, &provider_id)
}

#[tauri::command]
fn ai_secret_set(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    // 凭据值只在这里取一次，之后仅出现在写入内容里。
    let payload = strict_payload(&ai_invoke_args(&request), "ai_secret_set")?;
    let provider_id = required_string(&payload, &["provider_id", "providerId"], "Provider ID")?;
    let value = required_string(&payload, &["value"], "API Key")?;
    ai_secret_set_at(&ai_store_dir(&app)?, &provider_id, &value)
}

#[tauri::command]
fn ai_secret_delete(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let payload = strict_payload(&ai_invoke_args(&request), "ai_secret_delete")?;
    let provider_id = required_string(&payload, &["provider_id", "providerId"], "Provider ID")?;
    ai_secret_delete_at(&ai_store_dir(&app)?, &provider_id)
}

#[tauri::command]
async fn ai_models_list(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let base = ai_store_dir(&app)?;
    ai_models_list_at(&base, &ai_invoke_args(&request)).await
}

#[tauri::command]
async fn ai_complete(
    app: AppHandle,
    state: State<'_, BridgeState>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    let args = ai_invoke_args(&request);
    let base = ai_store_dir(&app)?;
    ai_complete_at(&base, &state.ai_requests, &args).await
}

#[tauri::command]
fn ai_cancel(
    state: State<'_, BridgeState>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    ai_cancel_at(&state.ai_requests, &ai_invoke_args(&request))
}

#[tauri::command]
fn ai_execution_append(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let payload = ai_payload(&ai_invoke_args(&request), "ai_execution_append")?;
    let record = field(&payload, &["record"])
        .cloned()
        .ok_or("AI 执行记录不能为空")?;
    ai_execution_append_at(&ai_store_dir(&app)?, &record)
}

#[tauri::command]
fn ai_execution_list(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let payload = strict_payload(&ai_invoke_args(&request), "ai_execution_list")?;
    let limit = field(&payload, &["limit"])
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(AI_EXECUTION_DEFAULT_LIMIT);
    ai_execution_list_at(&ai_store_dir(&app)?, limit)
}

#[cfg(test)]
mod tests {

    use super::*;

    fn test_directory(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "acw-native-lock-{label}-{}-{}",
            std::process::id(),
            native_id("test")
        ));
        fs::create_dir_all(&directory).expect("test directory should be created");
        directory
    }

    #[test]
    fn model_ids_parse_from_the_shapes_real_providers_return() {
        let openai = json!({ "data": [{ "id": "b" }, { "id": "a" }, { "id": "a" }] });
        assert_eq!(ai_model_ids_from_payload(&openai), vec!["a", "b"]);
        let ollama = json!({ "models": [{ "name": "llama3" }, { "id": "qwen" }] });
        assert_eq!(ai_model_ids_from_payload(&ollama), vec!["llama3", "qwen"]);
        let bare = json!(["only-one"]);
        assert_eq!(ai_model_ids_from_payload(&bare), vec!["only-one"]);
        // 没有模型名时返回空列表，绝不用本地表补一个猜测出来的名字。
        assert!(ai_model_ids_from_payload(&json!({ "data": [] })).is_empty());
        assert!(ai_model_ids_from_payload(&json!({})).is_empty());
        assert!(ai_model_ids_from_payload(&Value::Null).is_empty());
    }

    #[test]
    fn keychain_add_arguments_carry_the_secret_as_the_value_of_dash_w() {
        let args = keychain_add_args("project-abc:provider:deepseek", "com.example.app", "sk-secret");
        assert_eq!(args[0], "add-generic-password");
        assert_eq!(args[1], "-a");
        assert_eq!(args[2], "project-abc:provider:deepseek");
        assert_eq!(args[3], "-s");
        assert_eq!(args[4], "com.example.app");
        // `-U` repairs an item a previous broken write left behind.
        assert!(args.contains(&"-U".to_string()));
        // A trailing bare `-w` means "prompt me", which stores an EMPTY
        // password without a TTY. The secret must be its argument instead.
        let dash_w = args.iter().position(|arg| arg == "-w").expect("`-w` must be present");
        assert_eq!(
            args.get(dash_w + 1).map(String::as_str),
            Some("sk-secret"),
            "the secret must be the argument of `-w`",
        );
        assert_eq!(args.last().map(String::as_str), Some("sk-secret"));
    }

    #[test]
    fn keychain_read_and_delete_arguments_target_the_same_item_as_the_write() {
        let write = keychain_add_args("account", "service", "secret");
        let read = keychain_get_args("account", "service");
        let delete = keychain_delete_args("account", "service");
        for args in [&write, &read, &delete] {
            assert_eq!(args[1], "-a");
            assert_eq!(args[2], "account");
            assert_eq!(args[3], "-s");
            assert_eq!(args[4], "service");
        }
        // Reading prints only the password; a bare `-w` here is correct and is
        // how the store verifies that a write really landed.
        assert_eq!(read.last().map(String::as_str), Some("-w"));
        assert!(!delete.contains(&"-w".to_string()));
    }

    fn write_test_project(directory: &Path) -> Value {
        let project = json!({
            "schema_version": 4,
            "project": {
                "id": "project-native-seed",
                "title": "未命名课程",
                "created_at": rfc3339_now(),
                "updated_at": rfc3339_now(),
            },
            "stages": [],
            "content_items": [],
            "documents": [],
            "course_seeds": [],
            "blueprint_drafts": [],
            "blueprint_nodes": [],
        });
        fs::write(
            directory.join("project.json"),
            serde_json::to_string_pretty(&project).expect("fixture should serialize"),
        )
        .expect("fixture should be written");
        project
    }


    #[test]
    fn seed_outline_lines_become_stages_and_contents() {
        let nodes = seed_lines_to_nodes(
            "# 第一阶段 入门\n第一课 认识界面\n- 第二课 练习：第一次对话\n第三课 案例复盘",
        );
        let types: Vec<&str> = nodes
            .iter()
            .map(|node| {
                node.get("node_type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            })
            .collect();
        assert_eq!(types, vec!["stage", "content", "content", "content"]);
        assert_eq!(
            nodes[0].get("title").and_then(Value::as_str),
            Some("第一阶段 入门"),
            "a markdown heading opens a stage"
        );
        assert_eq!(
            nodes[2].get("title").and_then(Value::as_str),
            Some("第二课 练习：第一次对话"),
            "a leading bullet marker is not part of the lesson title"
        );
        assert_eq!(
            nodes[2].get("suggested_type").and_then(Value::as_str),
            Some("exercise"),
            "the Domain infers an exercise from the title"
        );
        assert_eq!(
            nodes[3].get("suggested_type").and_then(Value::as_str),
            Some("case")
        );
        for node in nodes.iter().skip(1) {
            assert_eq!(
                node.get("parent_index").and_then(Value::as_u64),
                Some(0),
                "every lesson stays under the stage it followed"
            );
        }
        let unmarked = seed_lines_to_nodes("第一阶段 入门\n第一课 认识界面");
        assert_eq!(
            unmarked[0].get("title").and_then(Value::as_str),
            Some("课程内容"),
            "lines without a stage marker land in one implicit stage"
        );
        assert_eq!(
            unmarked[1].get("title").and_then(Value::as_str),
            Some("第一阶段 入门"),
            "an unmarked line is a lesson, never a stage"
        );
    }

    #[test]
    fn heading_lines_open_a_new_stage_and_an_empty_input_still_starts_somewhere() {
        let nodes = seed_lines_to_nodes("## 第二阶段 进阶\n1. 让 AI 稳定理解需求\n2) 交付结果");
        let types: Vec<&str> = nodes
            .iter()
            .map(|node| {
                node.get("node_type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            })
            .collect();
        assert_eq!(
            types,
            vec!["stage", "stage", "stage"],
            "numbered lines are stage headings, exactly like the Domain regex"
        );
        assert_eq!(
            nodes[1].get("title").and_then(Value::as_str),
            Some("让 AI 稳定理解需求"),
            "the number and the dot are not part of the stage title"
        );
        assert_eq!(
            nodes[1].get("parent_index").cloned(),
            Some(Value::Null),
            "stage nodes stay at the top level"
        );
        let empty = seed_lines_to_nodes("   \n\n");
        assert_eq!(empty.len(), 2, "an empty input gets one stage and one lesson");
        assert_eq!(empty[0].get("title").and_then(Value::as_str), Some("开始"));
        assert_eq!(empty[1].get("title").and_then(Value::as_str), Some("第一课"));
        assert_eq!(
            first_meaningful_line("### AI 五阶段成长课程\n第二阶段"),
            "AI 五阶段成长课程",
            "the draft title drops the markdown marker"
        );
        assert_eq!(first_meaningful_line(""), "");
    }

    #[test]
    fn a_blueprint_draft_creates_no_formal_course_rows() {
        let directory = test_directory("seed");
        write_test_project(&directory);
        let project_dir = directory.to_string_lossy().into_owned();
        // Opening the project is what registers the lease and the save
        // baseline; the seed commands run against an open project only.
        project_open(project_dir.clone()).expect("the test project should open");
        let seed = course_seed_create(json!({
            "project_dir": project_dir,
            "source_type": "outline",
            "raw_text": "第一阶段 入门\n第一课 认识界面",
        }))
        .expect("creating a course seed should succeed");
        assert_eq!(
            seed.get("project_id"),
            Some(&Value::Null),
            "a seed stays unconfirmed until the map is confirmed"
        );
        let seed_id = seed
            .get("id")
            .and_then(Value::as_str)
            .expect("the seed needs an id")
            .to_string();
        let built = blueprint_build(json!({
            "project_dir": project_dir,
            "course_seed_id": seed_id,
        }))
        .expect("building the draft should succeed");
        assert_eq!(
            built
                .get("draft")
                .and_then(|draft| draft.get("status"))
                .and_then(Value::as_str),
            Some("draft")
        );
        assert_eq!(
            built
                .get("draft")
                .and_then(|draft| draft.get("confirmed_at"))
                .cloned(),
            Some(Value::Null)
        );
        let stored = read_project_value(&directory).expect("the project should be readable again");
        assert_eq!(
            stored
                .get("blueprint_nodes")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(3)
        );
        assert_eq!(
            stored.get("stages").and_then(Value::as_array).map(Vec::len),
            Some(0),
            "a draft must not create formal stages"
        );
        assert_eq!(
            stored
                .get("content_items")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0),
            "a draft must not create formal content items"
        );
        assert!(
            blueprint_build(json!({
                "project_dir": directory.to_string_lossy(),
                "course_seed_id": "missing-seed",
            }))
            .is_err(),
            "an unknown seed must be refused"
        );
    }

    #[test]
    fn active_lock_heartbeats_and_blocks_a_second_instance() {
        let directory = test_directory("active");
        let first = acquire_project_lock_for(&directory, "first", PROJECT_LOCK_STALE_MS)
            .expect("first instance should acquire the lock");
        let path = project_lock_path(&directory).expect("lock path should be valid");
        let before = read_project_lock(&path)
            .expect("lock should be readable")
            .expect("lock should exist");
        thread::sleep(Duration::from_millis(5));
        assert!(heartbeat_project_lock(&directory, "first").expect("heartbeat should work"));
        let after = read_project_lock(&path)
            .expect("lock should be readable")
            .expect("lock should exist");
        assert_ne!(before.heartbeat, after.heartbeat);
        let blocked = acquire_project_lock_for(&directory, "second", PROJECT_LOCK_STALE_MS)
            .expect_err("active lock must block a second instance");
        assert!(blocked.starts_with("project_locked:"));
        assert_eq!(first.app_instance_id, "first");
        release_project_lock_for(&directory, "first").expect("owner should release the lock");
        assert!(!path.exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn same_owner_reacquire_replaces_stopped_heartbeat_handle() {
        let directory = test_directory("reacquire");
        acquire_project_lock_for(&directory, "same", PROJECT_LOCK_STALE_MS)
            .expect("first owner should acquire the lock");
        let directory = fs::canonicalize(&directory).expect("test directory should canonicalize");
        let old = active_project_locks()
            .lock()
            .unwrap()
            .get(&directory)
            .cloned()
            .expect("first heartbeat should be registered");
        old.stop.store(true, Ordering::Release);
        acquire_project_lock_for(&directory, "same", PROJECT_LOCK_STALE_MS)
            .expect("same owner should refresh its heartbeat registration");
        let current = active_project_locks()
            .lock()
            .unwrap()
            .get(&directory)
            .cloned()
            .expect("replacement heartbeat should be registered");
        assert!(!Arc::ptr_eq(&old.stop, &current.stop));
        assert!(!current.stop.load(Ordering::Acquire));
        unregister_project_lock(&directory, Some(&old));
        assert!(project_lock_registered(&directory, "same"));
        assert!(heartbeat_project_lock(&directory, "same").expect("new heartbeat should work"));
        release_project_lock_for(&directory, "same").expect("owner should release the lock");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn app_instance_ids_are_pid_scoped_and_unique() {
        let first = new_app_instance_id();
        let second = new_app_instance_id();
        assert_ne!(first, second);
        assert!(first.contains(&format!("app-p{}-", std::process::id())));
        assert!(!first.ends_with("no-system-random"));
    }

    #[test]
    fn valid_heartbeat_controls_staleness_not_lock_mtime() {
        let directory = test_directory("heartbeat-time");
        let path = project_lock_path(&directory).expect("lock path should be valid");
        let old = ProjectLockRecord {
            app_instance_id: "old".into(),
            pid: 1,
            host: "test".into(),
            opened_at: "2000-01-01T00:00:00.000Z".into(),
            heartbeat: "2000-01-01T00:00:00.000Z".into(),
        };
        fs::write(
            &path,
            serde_json::to_vec(&project_lock_value(&old)).unwrap(),
        )
        .expect("lock should be writable");
        assert!(
            project_lock_is_stale(&path, Some(&old), PROJECT_LOCK_STALE_MS)
                .expect("old heartbeat should be stale")
        );
        let fresh = ProjectLockRecord {
            heartbeat: rfc3339_now(),
            ..old
        };
        assert!(
            !project_lock_is_stale(&path, Some(&fresh), PROJECT_LOCK_STALE_MS)
                .expect("fresh heartbeat should be active")
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn extreme_heartbeat_is_malformed_without_overflow() {
        let directory = test_directory("heartbeat-extreme");
        let path = project_lock_path(&directory).expect("lock path should be valid");
        let extreme = ProjectLockRecord {
            app_instance_id: "extreme".into(),
            pid: 1,
            host: "test".into(),
            opened_at: "0000-01-01T00:00:00.000Z".into(),
            heartbeat: "99999-99-99T99:99:99.999Z".into(),
        };
        fs::write(
            &path,
            serde_json::to_vec(&project_lock_value(&extreme)).unwrap(),
        )
        .expect("lock should be writable");
        assert!(parse_rfc3339_millis(&extreme.heartbeat).is_none());
        assert!(
            !project_lock_is_stale(&path, Some(&extreme), PROJECT_LOCK_STALE_MS)
                .expect("fresh malformed lock should use mtime")
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn heartbeat_parser_requires_trimmed_padded_post_epoch_dates() {
        assert_eq!(parse_rfc3339_millis(" 1970-01-01T00:00:00.000Z "), Some(0));
        for value in [
            "1969-12-31T23:59:59.999Z",
            "2026-3-01T00:00:00.000Z",
            "2026-03-01T0:00:00.000Z",
        ] {
            assert!(
                parse_rfc3339_millis(value).is_none(),
                "{value} should be malformed"
            );
        }
    }

    #[test]
    fn stale_takeover_stops_old_heartbeat_and_non_owner_cannot_release() {
        let directory = test_directory("stale");
        acquire_project_lock_for(&directory, "first", PROJECT_LOCK_STALE_MS)
            .expect("first instance should acquire the lock");
        thread::sleep(Duration::from_millis(5));
        let not_owned = release_project_lock_for(&directory, "second")
            .expect_err("non-owner must not release the lock");
        assert!(not_owned.starts_with("project_lock_not_owned:"));
        let second = acquire_project_lock_for(&directory, "second", 0)
            .expect("stale lock should be safely taken over");
        assert_eq!(second.app_instance_id, "second");
        assert!(!heartbeat_project_lock(&directory, "first").expect("old heartbeat should stop"));
        let old_release = release_project_lock_for(&directory, "first")
            .expect_err("old owner must not remove the replacement lock");
        assert!(old_release.starts_with("project_lock_not_owned:"));
        assert_eq!(
            read_project_lock(&project_lock_path(&directory).unwrap())
                .unwrap()
                .unwrap()
                .app_instance_id,
            "second"
        );
        release_project_lock_for(&directory, "second").expect("new owner should release the lock");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn malformed_fresh_lock_blocks_but_stale_lock_is_recoverable() {
        let directory = test_directory("malformed");
        let path = project_lock_path(&directory).expect("lock path should be valid");
        fs::write(&path, b"{not-json").expect("malformed lock should be writable");
        let blocked = acquire_project_lock_for(&directory, "second", PROJECT_LOCK_STALE_MS)
            .expect_err("a fresh malformed lock must remain protected");
        assert!(blocked.starts_with("project_locked:"));
        thread::sleep(Duration::from_millis(5));
        let recovered = acquire_project_lock_for(&directory, "second", 0)
            .expect("an old malformed lock should be recoverable");
        assert_eq!(recovered.app_instance_id, "second");
        release_project_lock_for(&directory, "second").expect("recovered owner should release");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn open_failure_rolls_back_new_lease_and_unopened_save_is_rejected() {
        let directory = test_directory("rollback");
        fs::write(directory.join("project.json"), b"not-json")
            .expect("invalid project should be writable");
        assert!(project_open(directory.to_string_lossy().into_owned()).is_err());
        let lock_path = project_lock_path(&directory).unwrap();
        assert!(!lock_path.exists());
        let empty = test_directory("unopened-save");
        let error = project_save(empty.to_string_lossy().into_owned(), json!({}))
            .expect_err("save must require an opened lease");
        assert!(error.starts_with("project_not_open:") || error.starts_with("project_lock_lost:"));
        assert!(!project_lock_path(&empty).unwrap().exists());
        let _ = fs::remove_dir_all(directory);
        let _ = fs::remove_dir_all(empty);
    }

    #[test]
    fn project_guard_blocks_release_until_write_scope_finishes() {
        let directory = test_directory("guard-scope");
        acquire_project_lock_for(&directory, "first", PROJECT_LOCK_STALE_MS)
            .expect("owner should acquire the lock");
        let guard = open_project_lock_guard(&directory).expect("guard should open");
        let (sender, receiver) = std::sync::mpsc::channel();
        let release_directory = directory.clone();
        let thread = thread::spawn(move || {
            let result = release_project_lock_for(&release_directory, "first");
            sender.send(result).expect("release result should be sent");
        });
        assert!(receiver.recv_timeout(Duration::from_millis(20)).is_err());
        drop(guard);
        assert!(receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("release should continue after the write scope")
            .is_ok());
        thread.join().expect("release thread should finish");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn exporting_beside_project_never_copies_an_asset_onto_itself() {
        let directory = test_directory("export-same-root");
        fs::create_dir_all(directory.join("assets")).unwrap();
        let asset_path = directory.join("assets/cover.png");
        fs::write(&asset_path, b"not-empty").unwrap();
        let project = json!({
            "assets": [{
                "id": "asset-1", "storage_path": "assets/cover.png",
                "archived": false
            }],
            "asset_usages": [{
                "asset_id": "asset-1", "content_item_id": "item-1"
            }],
            "requirements": []
        });
        let copied = copy_export_assets(&project, &directory, &directory, None, false).unwrap();
        assert_eq!(copied, vec!["assets/cover.png"]);
        assert_eq!(fs::read(&asset_path).unwrap(), b"not-empty");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn full_course_export_accepts_an_explicit_null_content_item() {
        let project = json!({ "content_items": [] });
        let preset = Map::new();
        let options = json!({ "content_item_id": null });
        assert_eq!(
            export_content_item_id(&project, &preset, Some(&options)).unwrap(),
            None
        );
    }

    #[test]
    fn native_markdown_and_html_export_used_asset_references() {
        let project = json!({
            "project": { "title": "Export" },
            "content_items": [{
                "id": "item-1", "title": "Lesson", "document_id": "doc-1",
                "order_index": 0, "archived": false
            }],
            "blocks": [{
                "id": "block-1", "document_id": "doc-1", "type": "paragraph",
                "content": "Body", "order_index": 0
            }],
            "requirements": [],
            "assets": [{
                "id": "asset-1", "filename": "cover.png", "title": "Cover",
                "type": "image", "storage_path": "assets/cover.png", "archived": false
            }],
            "asset_usages": [{ "asset_id": "asset-1", "content_item_id": "item-1" }]
        });
        let markdown = markdown_for_project(&project, Some("item-1"));
        let html = html_for_project(&project, Some("item-1"));
        assert!(markdown.contains("![Cover](assets/cover.png)"));
        assert!(html.contains("src=\"assets/cover.png\""));
    }

    #[test]
    fn external_modification_blocks_native_save_and_reload_refreshes_baseline() {
        let directory = test_directory("external-save");
        let initial = json!({ "project": { "id": "p1", "title": "base" }, "items": [] });
        project_create(directory.to_string_lossy().into_owned(), initial.clone())
            .expect("project should be created");
        let external = json!({ "project": { "id": "p1", "title": "external" }, "items": [] });
        fs::write(
            directory.join("project.json"),
            serde_json::to_vec_pretty(&external).unwrap(),
        )
        .expect("external edit should be written");
        let local = json!({ "project": { "id": "p1", "title": "local" }, "items": [] });
        let rejected = project_save(directory.to_string_lossy().into_owned(), local)
            .expect_err("native save must reject the external edit");
        assert!(rejected.contains("external_modification_conflict"));
        assert_eq!(read_project_value(&directory).unwrap(), external);
        let report =
            project_external_status(directory.to_string_lossy().into_owned(), Some(initial))
                .expect("conflict report should be available");
        assert_eq!(report.get("changed").and_then(Value::as_bool), Some(true));
        let mut reloaded = project_reload(directory.to_string_lossy().into_owned())
            .expect("reload should refresh the baseline");
        reloaded["project"]["title"] = json!("after-reload");
        project_save(directory.to_string_lossy().into_owned(), reloaded)
            .expect("save after reload should succeed");
        assert_eq!(
            read_project_value(&directory).unwrap()["project"]["title"],
            json!("after-reload")
        );
        project_close(directory.to_string_lossy().into_owned()).unwrap();
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn native_merge_resolution_requires_the_inspected_disk_fingerprint() {
        let directory = test_directory("external-merge");
        let base = json!({
            "project": {
                "id": "p1", "title": "base", "description": "base",
                "updated_at": "2026-01-01T00:00:00.000Z"
            },
            "items": []
        });
        project_create(directory.to_string_lossy().into_owned(), base.clone()).unwrap();
        let mut external = base.clone();
        external["project"]["description"] = json!("external");
        external["project"]["updated_at"] = json!("2026-01-03T00:00:00.000Z");
        fs::write(
            directory.join("project.json"),
            serde_json::to_vec(&external).unwrap(),
        )
        .unwrap();
        let mut local = base;
        local["project"]["title"] = json!("local");
        local["project"]["updated_at"] = json!("2026-01-02T00:00:00.000Z");
        let report = project_external_status(
            directory.to_string_lossy().into_owned(),
            Some(local.clone()),
        )
        .unwrap();
        let merge = project_merge(directory.to_string_lossy().into_owned(), local).unwrap();
        assert_eq!(merge.get("can_apply").and_then(Value::as_bool), Some(true));
        let merged = merge.get("merged").cloned().unwrap();
        project_resolve(
            directory.to_string_lossy().into_owned(),
            merged.clone(),
            report.get("current").cloned().unwrap(),
        )
        .expect("explicit resolution should write the merged branch");
        assert_eq!(read_project_value(&directory).unwrap(), merged);
        project_save(directory.to_string_lossy().into_owned(), merged)
            .expect("resolved baseline should allow a subsequent save");
        project_close(directory.to_string_lossy().into_owned()).unwrap();
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn asset_read_returns_project_asset_bytes_and_rejects_unsafe_paths() {
        let directory = test_directory("asset-read");
        let project_dir = directory.to_string_lossy().into_owned();
        let initial =
            json!({ "project": { "id": "p1", "title": "read" }, "assets": [], "items": [] });
        project_create(project_dir.clone(), initial).expect("project should be created");

        let payload = BASE64.encode(b"asset-bytes");
        let imported = asset_import(json!({
            "input": {
                "project_dir": project_dir,
                "filename": "封面.png",
                "mime_type": "image/png",
                "type": "image",
                "bytes_base64": payload,
            }
        }))
        .expect("asset import should succeed");
        let asset_id = imported["asset"]["id"].as_str().unwrap().to_owned();

        let read = asset_read(json!({
            "project_dir": project_dir,
            "asset_id": asset_id,
        }))
        .expect("preview read should return the stored bytes");
        assert_eq!(read["bytes_base64"], json!(BASE64.encode(b"asset-bytes")));
        assert_eq!(read["file_size"], json!(11));
        assert_eq!(read["mime_type"], json!("image/png"));

        let missing = asset_read(json!({
            "project_dir": project_dir,
            "asset_id": "asset-does-not-exist",
        }))
        .expect_err("unknown asset ids must be rejected");
        assert!(missing.contains("找不到素材"));

        // A tampered storage path must never resolve outside the project.
        let mut project = read_project_value(&directory).unwrap();
        project["assets"][0]["storage_path"] = json!("../../etc/hosts");
        fs::write(
            directory.join("project.json"),
            serde_json::to_vec_pretty(&project).unwrap(),
        )
        .unwrap();
        let escaped = asset_read(json!({
            "project_dir": directory.to_string_lossy().into_owned(),
            "asset_id": asset_id,
        }))
        .expect_err("path traversal must be rejected");
        assert!(
            escaped.contains("assets/") || escaped.contains("项目文件路径无效"),
            "got: {escaped}"
        );

        // Even inside assets/, a path with a parent component is refused.
        project["assets"][0]["storage_path"] = json!("assets/../../etc/hosts");
        fs::write(
            directory.join("project.json"),
            serde_json::to_vec_pretty(&project).unwrap(),
        )
        .unwrap();
        let nested_escape = asset_read(json!({
            "project_dir": directory.to_string_lossy().into_owned(),
            "asset_id": asset_id,
        }))
        .expect_err("a parent component must be rejected");
        assert!(!nested_escape.is_empty(), "got: {nested_escape}");

        // A tampered row pointing at canonical data must not be readable.
        project["assets"][0]["storage_path"] = json!("project.json");
        fs::write(
            directory.join("project.json"),
            serde_json::to_vec_pretty(&project).unwrap(),
        )
        .unwrap();
        let outside = asset_read(json!({
            "project_dir": directory.to_string_lossy().into_owned(),
            "asset_id": asset_id,
        }))
        .expect_err("only assets/ paths may be read");
        assert!(outside.contains("assets/"), "got: {outside}");
        project["assets"][0]["storage_path"] = json!("assets/missing.png");
        fs::write(
            directory.join("project.json"),
            serde_json::to_vec_pretty(&project).unwrap(),
        )
        .unwrap();
        let missing_file = asset_read(json!({
            "project_dir": directory.to_string_lossy().into_owned(),
            "asset_id": asset_id,
        }))
        .expect_err("a missing file must be reported");
        assert!(!missing_file.is_empty(), "got: {missing_file}");

        project_close(directory.to_string_lossy().into_owned()).unwrap();
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn session_payloads_carry_reader_position_but_never_credentials() {
        // The shell persists the reader's position (lesson, mode, panel, tabs)
        // next to the selected project directory.  It must stay free of any
        // credential-looking field, and an asset preview read must never be
        // allowed to return an unbounded amount of data.
        let session = json!({
            "project_dir": "/tmp/example-project",
            "project_id": "p1",
            "active_content_item_id": "c1",
            "mode": "writing",
            "right_panel": "requirements",
            "route": "editor",
            "selected_block_id": "b1",
            "left_collapsed": false,
            "right_collapsed": false,
            "tabs": [{ "content_item_id": "c1", "mode": "writing", "pinned": false, "scroll_top": 0 }]
        });
        reject_sensitive(&session).expect("a reader position contains no credentials");
        assert_eq!(
            session
                .get("active_content_item_id")
                .and_then(Value::as_str),
            Some("c1"),
            "the persisted session must keep the lesson the user was editing"
        );
        let with_secret = json!({
            "project_dir": "/tmp/example-project",
            "active_content_item_id": "c1",
            "api_key": "sk-should-never-be-written"
        });
        assert!(
            reject_sensitive(&with_secret).is_err(),
            "session writes must reject credential fields"
        );
        assert!(
            ASSET_READ_SIZE_LIMIT > 0 && ASSET_READ_SIZE_LIMIT <= 64 * 1024 * 1024,
            "asset preview reads must stay bounded"
        );
    }

    #[test]
    fn launch_project_dir_argument_is_parsed_and_validated() {
        let parse =
            |args: &[&str]| project_dir_from_args(args.iter().map(|value| (*value).to_owned()));
        assert!(parse(&[]).unwrap().is_none(), "no flag means no directory");
        assert!(
            parse(&["--other", "x"]).unwrap().is_none(),
            "unrelated arguments are ignored"
        );
        let directory = test_directory("launch-arg");
        // `explicit_project_dir` canonicalizes, so compare canonical paths.
        let expected = fs::canonicalize(&directory).unwrap();
        let path = directory.to_string_lossy().into_owned();
        assert_eq!(
            parse(&["--project-dir", &path]).unwrap(),
            Some(expected.clone()),
            "--project-dir <path> is accepted"
        );
        assert_eq!(
            parse(&[&format!("--project-dir={path}")]).unwrap(),
            Some(expected.clone()),
            "--project-dir=<path> is accepted"
        );
        assert_eq!(
            parse(&["-p", &path]).unwrap(),
            Some(expected.clone()),
            "-p <path> is accepted"
        );
        assert!(
            parse(&["--project-dir"]).is_err(),
            "a missing value is an error"
        );
        assert!(
            parse(&["--project-dir", "   "]).is_err(),
            "a blank value is an error"
        );
        assert!(
            parse(&["--project-dir", "relative/dir"]).is_err(),
            "a relative path is rejected: the picker only ever returns absolute paths"
        );
        assert!(
            parse(&["--project-dir", "/definitely/not/here/at/all"]).is_err(),
            "a missing directory is rejected before the window opens"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn release_without_registered_lease_has_no_side_effect() {
        let directory = test_directory("release-empty");
        let guard_path = directory.join(PROJECT_LOCK_GUARD_RELATIVE_PATH);
        release_project_lock_for(&directory, "nobody")
            .expect("releasing an unopened directory should be idempotent");
        assert!(!guard_path.exists());
        assert!(!directory.join(PROJECT_LOCK_RELATIVE_PATH).exists());
        let _ = fs::remove_dir_all(directory);
    }

    // ---- V0-T03 / Workstream C：AI 配置、传输与执行记录 --------------------

    /// 测试用的 AI 存储目录，与生产路径同形：`<base>/.workspace/ai`。
    fn ai_test_base(directory: &Path) -> PathBuf {
        directory.join(".workspace").join("ai")
    }

    fn ai_test_handles() -> AiRequestHandles {
        AiRequestHandles::default()
    }

    /// 只回答一次的最小 HTTP 服务：把收到的原始请求回传，并写死一个响应。
    fn serve_once(
        response: String,
    ) -> (
        u16,
        std::sync::mpsc::Receiver<String>,
        thread::JoinHandle<()>,
    ) {
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("loopback listener should bind");
        let port = listener
            .local_addr()
            .expect("listener should have an address")
            .port();
        let (sender, receiver) = std::sync::mpsc::channel();
        let handle = thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut buffer: Vec<u8> = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => {
                        buffer.extend_from_slice(&chunk[..read]);
                        let text = String::from_utf8_lossy(&buffer).into_owned();
                        if let Some(position) = text.find("\r\n\r\n") {
                            let length = text[..position]
                                .lines()
                                .find_map(|line| {
                                    let (name, value) = line.split_once(':')?;
                                    if name.eq_ignore_ascii_case("content-length") {
                                        value.trim().parse::<usize>().ok()
                                    } else {
                                        None
                                    }
                                })
                                .unwrap_or(0);
                            if buffer.len() >= position + 4 + length {
                                break;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            let _ = sender.send(String::from_utf8_lossy(&buffer).into_owned());
        });
        (port, receiver, handle)
    }

    fn http_response(status_line: &str, content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status_line}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// 起一个本地服务、把 `payload.url` 指过去，跑一次 `ai_complete_at`。
    fn run_ai_complete_once(
        base: &Path,
        mut payload: Value,
        response: String,
    ) -> (Result<Value, String>, String) {
        let (port, receiver, server) = serve_once(response);
        payload["url"] = json!(format!("http://127.0.0.1:{port}/v1/chat/completions"));
        let requests = ai_test_handles();
        let result = tauri::async_runtime::block_on(ai_complete_at(base, &requests, &payload));
        let request = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("测试服务应当收到请求");
        server.join().expect("测试服务线程应当结束");
        (result, request)
    }

    #[test]
    fn ai_connection_round_trip_reports_configured_without_the_key() {
        let directory = test_directory("ai-connection");
        let base = ai_test_base(&directory);
        let secret = "sk-round-trip-must-never-return";
        let saved = ai_connection_save_at(
            &base,
            &json!({
                "id": "deepseek",
                "label": "DeepSeek",
                "kind": "openai_compatible",
                "base_url": "https://api.deepseek.com",
                "chat_path": "/chat/completions",
                "auth_header": "authorization",
                "auth_scheme": "Bearer",
                "default_model": "deepseek-chat",
                "models": ["deepseek-chat"],
            }),
        )
        .expect("provider should save");
        assert_eq!(saved["provider"]["id"], json!("deepseek"));
        assert_eq!(
            saved["provider"]["base_url"],
            json!("https://api.deepseek.com")
        );

        ai_secret_set_at(&base, "deepseek", secret).expect("secret should save");
        let listed = ai_connection_list_at(&base).expect("list should read the store");
        assert_eq!(listed["configured"]["deepseek"], json!(true));
        assert_eq!(listed["providers"][0]["id"], json!("deepseek"));
        assert_eq!(listed["providers"][0]["models"][0], json!("deepseek-chat"));
        assert!(
            !listed.to_string().contains(secret),
            "读取路径绝不能回传凭据: {listed}"
        );
        assert!(
            !listed.to_string().contains("credentials"),
            "读取路径只暴露 configured 布尔表: {listed}"
        );

        // 覆盖保存同一个 id 不会产生第二份记录。
        ai_connection_save_at(&base, &json!({ "id": "deepseek", "label": "DeepSeek 2" }))
            .expect("re-saving should update in place");
        let listed = ai_connection_list_at(&base).unwrap();
        assert_eq!(listed["providers"].as_array().unwrap().len(), 1);
        assert_eq!(listed["providers"][0]["label"], json!("DeepSeek 2"));

        // 文件权限：凭据只属于当前用户。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(base.join(AI_PROVIDERS_FILE))
                .expect("store should exist")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "AI 存储必须是 0600");
            // Keychain adoption must never create a plaintext provider backup.
            assert!(
                !base.join("providers.bak").exists(),
                "AI metadata must not leave a plaintext backup"
            );
            let stored =
                fs::read_to_string(base.join(AI_PROVIDERS_FILE)).expect("metadata should exist");
            assert!(
                !stored.contains(secret),
                "providers.json must not contain the credential"
            );
        }

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_plaintext_provider_store_migrates_to_test_secure_store() {
        let directory = test_directory("ai-migration");
        let base = ai_test_base(&directory);
        let key = "sk-native-migration-test";
        let legacy = json!({
            "providers": [{ "id": "deepseek", "label": "DeepSeek" }],
            "credentials": { "deepseek": key },
        });
        fs::create_dir_all(&base).expect("AI base should exist");
        fs::write(
            base.join(AI_PROVIDERS_FILE),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .expect("legacy provider file should be writable");
        fs::write(
            base.join("providers.bak"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .expect("legacy backup should be writable");

        let listed = ai_connection_list_at(&base).expect("legacy values should migrate");
        assert_eq!(listed["configured"]["deepseek"], json!(true));
        let metadata = fs::read_to_string(base.join(AI_PROVIDERS_FILE)).unwrap();
        assert!(!metadata.contains(key), "metadata must not contain the key");
        assert!(
            !metadata.contains("credentials"),
            "metadata must not contain a credential map"
        );
        assert!(
            !base.join("providers.bak").exists(),
            "legacy backup must be removed after migration"
        );

        ai_secret_delete_at(&base, "deepseek").expect("test secure store should delete");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_plaintext_migration_failure_keeps_the_source_file() {
        let directory = test_directory("ai-migration-failure");
        let base = ai_test_base(&directory);
        let key = "sk-native-migration-failure";
        let legacy = serde_json::to_string(&json!({
            "providers": [{ "id": "deepseek", "label": "DeepSeek" }],
            "credentials": { "../invalid": key },
        }))
        .unwrap();
        fs::create_dir_all(&base).expect("AI base should exist");
        fs::write(base.join(AI_PROVIDERS_FILE), &legacy).expect("legacy file should be writable");
        let failed = ai_connection_list_at(&base).expect_err("invalid migration must fail closed");
        assert!(
            !failed.contains(key),
            "migration failure must not echo the key"
        );
        assert_eq!(
            fs::read_to_string(base.join(AI_PROVIDERS_FILE)).unwrap(),
            legacy
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_connection_list_on_an_empty_store_returns_empty_collections() {
        let directory = test_directory("ai-empty");
        let base = ai_test_base(&directory);
        let listed = ai_connection_list_at(&base).expect("缺少存储文件时不得报错");
        assert_eq!(listed["providers"], json!([]));
        assert_eq!(listed["configured"], json!({}));
        assert!(!base.join(AI_PROVIDERS_FILE).exists(), "只读不得创建文件");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_secret_set_never_echoes_the_value_on_any_path() {
        let directory = test_directory("ai-secret");
        let base = ai_test_base(&directory);
        let key = "sk-super-secret-value-42";

        let saved = ai_secret_set_at(&base, "deepseek", key).expect("secret should save");
        assert_eq!(saved["provider_id"], json!("deepseek"));
        assert!(
            !format!("{saved:?}").contains(key),
            "返回值不得包含密钥: {saved}"
        );

        let blank_provider =
            ai_secret_set_at(&base, "   ", key).expect_err("空 Provider ID 必须被拒绝");
        assert!(!format!("{blank_provider:?}").contains(key));
        assert!(blank_provider.contains("Provider ID"));

        let blank_value =
            ai_secret_set_at(&base, "deepseek", "   ").expect_err("空 API Key 必须被拒绝");
        assert!(blank_value.contains("API Key"));
        assert!(
            blank_value.contains("\"invalid_request\""),
            "got: {blank_value}"
        );

        // 真实写入失败路径：备份目标被目录占位，`value` 此刻仍在作用域里。
        let broken = test_directory("ai-secret-write-failure");
        let broken_base = ai_test_base(&broken);
        fs::create_dir_all(&broken_base).expect("broken store directory should be created");
        fs::write(
            broken_base.join(AI_PROVIDERS_FILE),
            br#"{"providers":[],"credentials":{}}"#,
        )
        .expect("store should be writable");
        fs::create_dir_all(broken_base.join("providers.bak"))
            .expect("backup placeholder should be created");
        let failed =
            ai_secret_set_at(&broken_base, "deepseek", key).expect_err("写入失败必须被上报");
        assert!(
            !format!("{failed:?}").contains(key),
            "写入失败的错误文本不得包含密钥: {failed}"
        );

        let _ = fs::remove_dir_all(directory);
        let _ = fs::remove_dir_all(broken);
    }

    #[test]
    fn ai_connection_and_secret_delete_report_removed() {
        let directory = test_directory("ai-delete");
        let base = ai_test_base(&directory);
        ai_connection_save_at(&base, &json!({ "id": "deepseek", "label": "DeepSeek" }))
            .expect("provider should save");
        ai_secret_set_at(&base, "deepseek", "sk-delete-me").expect("secret should save");
        assert_eq!(
            ai_connection_list_at(&base).unwrap()["configured"]["deepseek"],
            json!(true)
        );

        let removed_secret = ai_secret_delete_at(&base, "deepseek").expect("secret delete");
        assert_eq!(removed_secret["provider_id"], json!("deepseek"));
        assert_eq!(removed_secret["removed"], json!(true));
        let listed = ai_connection_list_at(&base).unwrap();
        assert_eq!(listed["configured"]["deepseek"], json!(false));
        assert_eq!(listed["providers"][0]["id"], json!("deepseek"));
        assert_eq!(
            ai_secret_delete_at(&base, "deepseek").unwrap()["removed"],
            json!(false),
            "重复删除必须是幂等的"
        );

        let removed_provider = ai_connection_delete_at(&base, "deepseek").expect("provider delete");
        assert_eq!(removed_provider["removed"], json!(true));
        assert_eq!(
            ai_connection_list_at(&base).unwrap()["providers"],
            json!([])
        );
        assert_eq!(
            ai_connection_delete_at(&base, "deepseek").unwrap()["removed"],
            json!(false)
        );

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_connection_save_rejects_credential_shaped_provider_fields() {
        let directory = test_directory("ai-provider-guard");
        let base = ai_test_base(&directory);
        // 与浏览器壳同一套规则：密钥形状的字段必须被拒绝（而不是被静默丢弃），
        // 否则同一份配置会在两个壳里得到不同结果。
        let credential_metadata = ai_connection_save_at(
            &base,
            &json!({ "id": "deepseek", "label": "DeepSeek", "requires_credential": true }),
        )
        .expect_err("requires_credential 属于凭据形状字段，必须被拒绝");
        assert!(
            credential_metadata.contains("\"invalid_request\""),
            "got: {credential_metadata}"
        );
        assert!(
            credential_metadata.contains("requires_credential"),
            "错误必须指明字段: {credential_metadata}"
        );

        let nested = ai_connection_save_at(
            &base,
            &json!({
                "id": "deepseek",
                "label": "DeepSeek",
                "headers": { "x-api-key": "sk-provider-must-not-leak" },
            }),
        )
        .expect_err("嵌套的密钥字段必须被拒绝");
        assert!(nested.contains("headers.x-api-key"), "got: {nested}");
        assert!(
            !nested.contains("sk-provider-must-not-leak"),
            "错误不得回显字段值: {nested}"
        );
        assert!(
            !base.join(AI_PROVIDERS_FILE).exists(),
            "被拒绝的配置不得落盘"
        );

        let inline = ai_connection_save_at(
            &base,
            &json!({
                "id": "inline-url",
                "base_url": "https://example.test/v1?api_key=sk-inline-must-not-save",
            }),
        )
        .expect_err("URL query credentials must be rejected");
        assert!(inline.contains("密钥查询参数"), "got: {inline}");
        assert!(
            !inline.contains("sk-inline-must-not-save"),
            "error must not echo key"
        );
        let encoded_inline = ai_connection_save_at(
            &base,
            &json!({
                "id": "encoded-inline-url",
                "base_url": "https://example.test/v1?%61pi_key=sk-encoded-must-not-save",
            }),
        )
        .expect_err("encoded URL query credentials must be rejected");
        assert!(encoded_inline.contains("api_key"), "got: {encoded_inline}");
        assert!(
            !encoded_inline.contains("sk-encoded-must-not-save"),
            "error must not echo encoded key"
        );

        let bad_id = ai_connection_save_at(&base, &json!({ "id": "../evil" }))
            .expect_err("非法 Provider ID 必须被拒绝");
        assert!(bad_id.contains("Provider ID"), "got: {bad_id}");

        // 安全字段必须原样保留（含 auth_header 这种名字里带 auth 的字段）。
        let saved = ai_connection_save_at(
            &base,
            &json!({
                "id": "custom-1",
                "label": "自定义",
                "kind": "openai_compatible",
                "base_url": "https://example.com",
                "chat_path": "/v1/chat/completions",
                "auth_header": "authorization",
                "auth_scheme": "Bearer",
                "default_model": "gpt-4o-mini",
                "models": ["gpt-4o-mini"],
            }),
        )
        .expect("安全字段必须全部保留");
        assert_eq!(saved["provider"]["models"][0], json!("gpt-4o-mini"));
        assert_eq!(saved["provider"]["auth_header"], json!("authorization"));
        assert_eq!(saved["provider"]["auth_scheme"], json!("Bearer"));
        assert_eq!(
            saved["provider"]["chat_path"],
            json!("/v1/chat/completions")
        );

        // 凭据长度上限与浏览器壳一致。
        let too_long =
            ai_secret_set_at(&base, "custom-1", &"x".repeat(9000)).expect_err("超长密钥必须被拒绝");
        assert!(too_long.contains("过长"), "got: {too_long}");
        assert!(!too_long.contains(&"x".repeat(64)), "错误不得回显密钥");

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_execution_append_sanitises_and_truncates_records() {
        let directory = test_directory("ai-exec-append");
        let base = ai_test_base(&directory);
        let long_instruction = "长".repeat(3000);
        let record = json!({
            "id": "exec-1",
            "created_at": "2026-01-01T00:00:00.000Z",
            "instruction": long_instruction,
            "context": { "item_count": 2, "chars": 128, "source_types": ["block"] },
            "provider": { "provider_id": "deepseek", "model": "deepseek-chat" },
            "meta": { "inner": { "api_key": "sk-nested-should-be-dropped", "note": "keep" } },
            "credentials": { "deepseek": "sk-also-dropped" },
        });
        let appended = ai_execution_append_at(&base, &record).expect("record should append");
        assert_eq!(appended["id"], json!("exec-1"));

        let listed = ai_execution_list_at(&base, 10).expect("list should read the store");
        let stored = &listed["records"][0];
        assert_eq!(stored["id"], json!("exec-1"));
        assert_eq!(stored["meta"]["inner"]["note"], json!("keep"));
        assert!(
            stored["meta"]["inner"].get("api_key").is_none(),
            "深层凭据字段必须被丢弃: {stored}"
        );
        assert!(stored.get("credentials").is_none());
        assert_eq!(stored["context"]["source_types"][0], json!("block"));
        assert_eq!(
            stored["instruction"].as_str().unwrap().chars().count(),
            AI_INSTRUCTION_LIMIT,
            "instruction 必须截断到 {AI_INSTRUCTION_LIMIT} 字"
        );

        let raw = fs::read_to_string(base.join(AI_EXECUTIONS_FILE)).expect("store should exist");
        assert!(!raw.contains("sk-nested-should-be-dropped"));
        assert!(!raw.contains("sk-also-dropped"));
        assert!(!raw.contains("api_key"), "磁盘上不得留下凭据字段名: {raw}");

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_execution_list_returns_newest_first_and_honours_limit() {
        let directory = test_directory("ai-exec-list");
        let base = ai_test_base(&directory);
        for (id, created_at) in [
            ("exec-a", "2026-01-01T00:00:00.000Z"),
            ("exec-b", "2026-01-02T00:00:00.000Z"),
            ("exec-c", "2026-01-03T00:00:00.000Z"),
        ] {
            ai_execution_append_at(
                &base,
                &json!({ "id": id, "created_at": created_at, "status": "succeeded" }),
            )
            .expect("record should append");
        }
        let all = ai_execution_list_at(&base, 10).expect("list should read the store");
        let ids: Vec<&str> = all["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|record| record["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec!["exec-c", "exec-b", "exec-a"],
            "最新的记录必须排最前"
        );

        let limited = ai_execution_list_at(&base, 2).unwrap();
        assert_eq!(limited["records"].as_array().unwrap().len(), 2);
        assert_eq!(limited["records"][0]["id"], json!("exec-c"));
        assert_eq!(
            AI_EXECUTION_DEFAULT_LIMIT, 50,
            "未指定 limit 时的条数必须与浏览器壳的 DEFAULT_LIST_LIMIT 一致"
        );
        assert_eq!(
            ai_execution_list_at(&base, 0).unwrap()["records"]
                .as_array()
                .unwrap()
                .len(),
            1,
            "limit 至少返回 1 条"
        );

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_execution_store_is_bounded_to_two_hundred_records() {
        let directory = test_directory("ai-exec-bound");
        let base = ai_test_base(&directory);
        // 真实存储是「新的在前」，这里按同样顺序铺满 200 条，最旧的一条排在最后。
        let seeded: Vec<Value> = (0..AI_EXECUTION_LIMIT)
            .rev()
            .map(|index| {
                json!({
                    "id": format!("old-{index}"),
                    "created_at": format!("2025-01-01T00:{:02}:{:02}.000Z", index / 60, index % 60),
                })
            })
            .collect();
        ai_write_store(
            &base.join(AI_EXECUTIONS_FILE),
            &json!({ "records": seeded }),
            "AI 执行记录",
        )
        .expect("seed store should be writable");

        ai_execution_append_at(
            &base,
            &json!({ "id": "newest", "created_at": "2026-01-01T00:00:00.000Z" }),
        )
        .expect("record should append");
        let listed = ai_execution_list_at(&base, AI_EXECUTION_LIMIT).unwrap();
        let records = listed["records"].as_array().unwrap();
        assert_eq!(records.len(), AI_EXECUTION_LIMIT, "执行记录必须有界");
        assert_eq!(records[0]["id"], json!("newest"));
        assert!(
            records.iter().all(|record| record["id"] != json!("old-0")),
            "最旧的一条必须被丢弃"
        );

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_execution_append_replaces_an_existing_record_by_id() {
        let directory = test_directory("ai-exec-upsert");
        let base = ai_test_base(&directory);
        for (id, created_at) in [
            ("exec-a", "2026-01-01T00:00:00.000Z"),
            ("exec-pending", "2026-01-02T00:00:00.000Z"),
            ("exec-c", "2026-01-03T00:00:00.000Z"),
        ] {
            ai_execution_append_at(
                &base,
                &json!({
                    "id": id,
                    "created_at": created_at,
                    "status": "succeeded",
                    "review": { "state": "pending", "decided_at": null },
                }),
            )
            .expect("record should append");
        }
        // 当前顺序（最新在前）：[exec-c, exec-pending, exec-a]。
        let before = ai_execution_list_at(&base, 10).expect("list should read the store");
        let ids: Vec<&str> = before["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|record| record["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["exec-c", "exec-pending", "exec-a"]);
        let neighbour_before = before["records"][2].clone();

        // 用户做出决定：同一个 id 只补写状态，不再多出一行。
        let appended = ai_execution_append_at(
            &base,
            &json!({
                "id": "exec-pending",
                "created_at": "2026-01-02T00:00:00.000Z",
                "status": "succeeded",
                "review": { "state": "applied", "decided_at": "2026-01-04T00:00:00.000Z" },
            }),
        )
        .expect("同一个 id 必须就地替换");
        assert_eq!(appended["id"], json!("exec-pending"));

        let after = ai_execution_list_at(&base, 10).unwrap();
        let records = after["records"].as_array().unwrap();
        assert_eq!(records.len(), 3, "替换不得增加历史行数");
        assert_eq!(
            records[1]["id"],
            json!("exec-pending"),
            "必须保留原来的位置"
        );
        assert_eq!(records[1]["review"]["state"], json!("applied"));
        assert_eq!(
            records[1]["review"]["decided_at"],
            json!("2026-01-04T00:00:00.000Z")
        );
        assert_eq!(records[0]["id"], json!("exec-c"), "前一条不得被挪动");
        assert_eq!(records[2], neighbour_before, "邻近记录不得被改动");
        let raw = fs::read_to_string(base.join(AI_EXECUTIONS_FILE)).expect("store should exist");
        assert_eq!(
            raw.matches("\"exec-pending\"").count(),
            1,
            "磁盘上同一个 id 只能有一行"
        );

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_execution_append_collapses_pre_existing_duplicate_ids() {
        let directory = test_directory("ai-exec-dedupe");
        let base = ai_test_base(&directory);
        // 旧实现（只追加不替换）为同一次运行留下两行：pending 在前，决定行更靠前。
        ai_write_store(
            &base.join(AI_EXECUTIONS_FILE),
            &json!({
                "records": [
                    { "id": "run-1", "review": { "state": "applied" } },
                    { "id": "run-2", "review": { "state": "pending" } },
                    { "id": "run-1", "review": { "state": "pending" } },
                    { "id": "run-0", "review": { "state": "applied" } },
                ]
            }),
            "AI 执行记录",
        )
        .expect("seed store should be writable");

        ai_execution_append_at(
            &base,
            &json!({ "id": "run-1", "review": { "state": "applied", "decided_at": "2026-01-05T00:00:00.000Z" } }),
        )
        .expect("replace should succeed");
        let listed = ai_execution_list_at(&base, 10).unwrap();
        let records = listed["records"].as_array().unwrap();
        assert_eq!(records.len(), 3, "同一次运行只保留一行");
        assert_eq!(records[0]["id"], json!("run-1"), "保留第一处匹配的位置");
        assert_eq!(records[0]["review"]["state"], json!("applied"));
        assert_eq!(records[1]["id"], json!("run-2"));
        assert_eq!(records[2]["id"], json!("run-0"));

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_execution_append_mints_an_id_when_none_is_supplied() {
        let directory = test_directory("ai-exec-mint");
        let base = ai_test_base(&directory);
        let first = ai_execution_append_at(&base, &json!({ "status": "succeeded" }))
            .expect("record without an id should append");
        let second = ai_execution_append_at(&base, &json!({ "status": "failed" }))
            .expect("record without an id should append");
        let first_id = first["id"].as_str().unwrap().to_owned();
        let second_id = second["id"].as_str().unwrap().to_owned();
        assert!(first_id.starts_with("ai-exec-"), "got: {first_id}");
        assert!(second_id.starts_with("ai-exec-"), "got: {second_id}");
        assert_ne!(first_id, second_id, "补出来的 id 必须互不相同");

        let listed = ai_execution_list_at(&base, 10).unwrap();
        let records = listed["records"].as_array().unwrap();
        assert_eq!(records.len(), 2, "没有 id 的记录一律追加");
        assert_eq!(records[0]["id"], json!(second_id));
        assert_eq!(records[0]["status"], json!("failed"));
        assert_eq!(records[1]["id"], json!(first_id));

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_execution_upsert_keeps_the_bound_and_newest_first_order() {
        let directory = test_directory("ai-exec-upsert-bound");
        let base = ai_test_base(&directory);
        let seeded: Vec<Value> = (0..AI_EXECUTION_LIMIT)
            .rev()
            .map(|index| {
                json!({
                    "id": format!("old-{index}"),
                    "created_at": format!("2025-01-01T00:{:02}:{:02}.000Z", index / 60, index % 60),
                })
            })
            .collect();
        ai_write_store(
            &base.join(AI_EXECUTIONS_FILE),
            &json!({ "records": seeded }),
            "AI 执行记录",
        )
        .expect("seed store should be writable");

        // 替换最旧的一条：总数与顺序都不变，位置也留在原地。
        ai_execution_append_at(
            &base,
            &json!({
                "id": "old-0",
                "created_at": "2025-01-01T00:00:00.000Z",
                "status": "rejected",
            }),
        )
        .expect("replace should succeed");
        let replaced = ai_execution_list_at(&base, AI_EXECUTION_LIMIT).unwrap();
        let records = replaced["records"].as_array().unwrap();
        assert_eq!(records.len(), AI_EXECUTION_LIMIT, "替换不得改变有界长度");
        assert_eq!(records[0]["id"], json!("old-199"), "最新在前的顺序不变");
        assert_eq!(records[AI_EXECUTION_LIMIT - 1]["id"], json!("old-0"));
        assert_eq!(records[AI_EXECUTION_LIMIT - 1]["status"], json!("rejected"));

        // 新 id 仍然按有界追加：最旧的一条被挤掉。
        ai_execution_append_at(
            &base,
            &json!({ "id": "brand-new", "created_at": "2026-01-01T00:00:00.000Z" }),
        )
        .expect("new record should append");
        let appended = ai_execution_list_at(&base, AI_EXECUTION_LIMIT).unwrap();
        let records = appended["records"].as_array().unwrap();
        assert_eq!(records.len(), AI_EXECUTION_LIMIT, "追加后仍然有界");
        assert_eq!(records[0]["id"], json!("brand-new"));
        assert!(
            records.iter().all(|record| record["id"] != json!("old-0")),
            "追加新记录时最旧的一条才被丢弃"
        );

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_execution_append_reports_a_log_failure_not_a_course_save_failure() {
        let directory = test_directory("ai-exec-failed");
        let base = ai_test_base(&directory);
        fs::create_dir_all(&base).expect("store directory should be created");
        fs::write(base.join(AI_EXECUTIONS_FILE), br#"{"records":[]}"#)
            .expect("store should be writable");
        // 备份目标被目录占位：原子写入必然失败。
        fs::create_dir_all(base.join("executions.bak"))
            .expect("backup placeholder should be created");
        let error = ai_execution_append_at(&base, &json!({ "id": "exec-1" }))
            .expect_err("写入失败必须被上报");
        assert!(
            error.contains("ai_execution_record_failed"),
            "失败必须是「记录未写入」，不能长得像课程保存失败: {error}"
        );
        assert!(error.contains("课程内容不受影响"), "got: {error}");
        assert!(error.contains("ai.execution.append"), "got: {error}");

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_execution_append_scrubs_pasted_credentials_from_free_text() {
        let directory = test_directory("ai-exec-free-text");
        let base = ai_test_base(&directory);
        let key = "sk-v0t03-do-not-leak-9f8e7d6c";
        ai_connection_save_at(&base, &json!({ "id": "deepseek", "auth_scheme": "Bearer" }))
            .expect("provider should save");
        ai_secret_set_at(&base, "deepseek", key).expect("secret should save");
        let encoded = BASE64.encode(key.as_bytes());
        assert_ne!(encoded, key);

        ai_execution_append_at(
            &base,
            &json!({
                "id": "exec-secret",
                "instruction": format!("请按 {key} 和 {encoded} 配置"),
                "error_message": format!("401 unauthorized: Bearer {key}"),
            }),
        )
        .expect("record should append");

        let raw = fs::read_to_string(base.join(AI_EXECUTIONS_FILE)).expect("store should exist");
        assert!(!raw.contains(key), "粘贴的密钥不得落盘: {raw}");
        assert!(!raw.contains(&encoded), "编码后的密钥不得落盘: {raw}");
        assert!(raw.contains("[REDACTED]"), "擦除位置必须留标记: {raw}");

        let listed = ai_execution_list_at(&base, 5).unwrap();
        let record = &listed["records"][0];
        assert!(
            record["instruction"]
                .as_str()
                .unwrap()
                .contains("[REDACTED]"),
            "got: {}",
            record["instruction"]
        );
        assert!(
            record["error_message"]
                .as_str()
                .unwrap()
                .contains("[REDACTED]"),
            "got: {}",
            record["error_message"]
        );

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_execution_append_keeps_short_credentials_from_shredding_text() {
        let directory = test_directory("ai-exec-short-secret");
        let base = ai_test_base(&directory);
        ai_connection_save_at(&base, &json!({ "id": "tiny", "auth_scheme": "Bearer" }))
            .expect("provider should save");
        ai_secret_set_at(&base, "tiny", "e").expect("short secret should save");

        let secrets = ai_stored_secrets(&base).expect("credential store should be readable");
        assert!(secrets.has_short, "1 字符凭据必须被识别为「不能精确替换」");

        ai_execution_append_at(
            &base,
            &json!({
                "id": "exec-tiny",
                "instruction": "evaluate every example",
                "error_message": "authorization: e",
            }),
        )
        .expect("record should append");

        let listed = ai_execution_list_at(&base, 5).unwrap();
        let record = &listed["records"][0];
        assert_eq!(
            record["instruction"],
            json!("evaluate every example"),
            "1 字符凭据不得搅碎普通文本"
        );
        assert_eq!(
            record["error_message"],
            json!("authorization: [REDACTED]"),
            "标签规则必须兜住短值"
        );

        // 存有短凭据时，Provider 正文一个字都不回显。
        let error = ai_status_error(
            500,
            "provider said the key is e",
            &secrets,
            "tiny",
            "https://example.com/v1/chat/completions",
            "application/json",
        );
        assert!(
            error.contains("\"[REDACTED]\""),
            "短凭据在场时 Provider 正文必须整段丢弃: {error}"
        );
        assert!(!error.contains("said the key"), "got: {error}");

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_provider_excerpts_keep_identifiers_but_drop_encoded_keys() {
        let directory = test_directory("ai-excerpt");
        let base = ai_test_base(&directory);
        let key = "sk-v0t03-excerpt-key-7d6c5b4a";
        ai_connection_save_at(&base, &json!({ "id": "deepseek", "auth_scheme": "Bearer" }))
            .expect("provider should save");
        ai_secret_set_at(&base, "deepseek", key).expect("secret should save");
        let secrets = ai_stored_secrets(&base).expect("credential store should be readable");
        assert!(!secrets.has_short);

        // 普通标识符（无数字、无大写）必须活下来。
        let kept = ai_scrub_provider_text(
            "model deepseek-reasoner is temporarily unavailable",
            &secrets,
        );
        assert!(kept.contains("deepseek-reasoner"), "got: {kept}");

        // 长得像 base64 的不透明串必须被抹掉，普通文字保留。
        let opaque = ai_scrub_provider_text("blob c2VjcmV0S2V5VmFsdWUxMjM0NTY3OA end", &secrets);
        assert!(
            !opaque.contains("c2VjcmV0S2V5VmFsdWUxMjM0NTY3OA"),
            "got: {opaque}"
        );
        assert!(opaque.contains("blob"), "got: {opaque}");
        assert!(opaque.contains("[REDACTED]"), "got: {opaque}");

        // 被拆成两半的密钥：任何摘要都不安全，整段丢弃。
        let split = format!("key half sk-v0t03-excerpt {}", "key-7d6c5b4a");
        assert_eq!(
            ai_scrub_provider_text(&split, &secrets),
            "[REDACTED]",
            "拆开的密钥必须整段丢弃"
        );
        // 编码成 base64 的回显同样整段丢弃。
        let encoded = BASE64.encode(key.as_bytes());
        assert_eq!(
            ai_scrub_provider_text(&format!("body {encoded} end"), &secrets),
            "[REDACTED]"
        );
        // 转义拼写要还原后再比对（%NN / \uXXXX / \xNN）。
        assert_eq!(ai_normalize_provider_text("\\u0073k-abc"), "sk-abc");
        assert_eq!(ai_normalize_provider_text("\\x73k-abc"), "sk-abc");
        assert_eq!(ai_normalize_provider_text("%73k-abc"), "sk-abc");
        assert_eq!(
            ai_normalize_provider_text("100% sure"),
            "100% sure",
            "孤立的 % 不是转义"
        );

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_errors_never_echo_the_request_url() {
        let url = "http://127.0.0.1:45678/v1/chat/completions?key=sk-query-secret";
        assert_eq!(
            ai_strip_request_url(&format!("failed for {url}"), url),
            "failed for <url>"
        );
        // origin + path 这一形态（没有查询串）同样要换掉；带尾斜杠时按 Deno 的
        // 替换顺序留下 `<url>/`。
        assert_eq!(
            ai_strip_request_url("failed for http://127.0.0.1:45678/v1/chat/completions", url),
            "failed for <url>"
        );
        assert_eq!(
            ai_strip_request_url(
                "failed for http://127.0.0.1:45678/v1/chat/completions/",
                url
            ),
            "failed for <url>/"
        );

        // Provider 正文里回显的地址同样进不了 details。
        let error = ai_status_error(
            500,
            &format!("upstream at {url} exploded"),
            &AiSecrets::default(),
            "deepseek",
            url,
            "text/plain",
        );
        assert!(error.contains("\"provider_error\""), "got: {error}");
        assert!(error.contains("<url>"), "got: {error}");
        assert!(!error.contains("sk-query-secret"), "got: {error}");
        assert!(!error.contains("127.0.0.1:45678"), "got: {error}");
        assert!(error.contains("\"body_kind\":\"text\""), "got: {error}");

        // 端到端：真实请求失败时，错误里既没有地址、也没有查询串里的密钥。
        // 用一个「接了就不说话」的服务端把请求逼到超时（纯本机回环，不需要外网）。
        let directory = test_directory("ai-url-echo");
        let base = ai_test_base(&directory);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        listener
            .set_nonblocking(true)
            .expect("listener should be non-blocking");
        let port = listener
            .local_addr()
            .expect("listener should have an address")
            .port();
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = Arc::clone(&stop);
        let server = thread::spawn(move || {
            let mut held = Vec::new();
            while !server_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => held.push(stream),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
            drop(held);
        });
        let requests = ai_test_handles();
        let error = tauri::async_runtime::block_on(ai_complete_at(
            &base,
            &requests,
            &json!({
                "request_id": "req-transport",
                "url": format!("http://127.0.0.1:{port}/v1/chat/completions?key=sk-query-leak"),
                "body": { "model": "m" },
                "timeout_ms": 1500,
            }),
        ))
        .expect_err("超时必须上报");
        assert!(error.contains("\"timeout\""), "got: {error}");
        assert!(!error.contains("sk-query-leak"), "got: {error}");
        assert!(
            !error.contains(&format!("127.0.0.1:{port}")),
            "got: {error}"
        );
        stop.store(true, Ordering::Release);
        server.join().expect("server thread should finish");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_complete_rejects_non_https_and_unparseable_urls() {
        let directory = test_directory("ai-url");
        let base = ai_test_base(&directory);
        let requests = ai_test_handles();
        for url in [
            "file:///etc/hosts",
            "ftp://example.com/chat",
            "http://example.com/v1/chat/completions",
            "/v1/chat/completions",
            "api.deepseek.com/chat/completions",
            "",
        ] {
            let error = tauri::async_runtime::block_on(ai_complete_at(
                &base,
                &requests,
                &json!({
                    "request_id": "req-url",
                    "provider_id": "deepseek",
                    "url": url,
                    "body": { "model": "m" },
                }),
            ))
            .expect_err("非 https / 非回环地址必须被拒绝");
            assert!(
                error.contains("\"invalid_request\""),
                "{url} 应当得到 invalid_request，实际: {error}"
            );
            assert!(
                !error.contains("example.com"),
                "错误里不得回显地址: {error}"
            );
        }
        assert!(requests.lock().unwrap().is_empty(), "被拒绝的请求不得登记");
        // 允许的两种形状：https 与本机回环 http（IPv6 回环与浏览器壳一致）。
        ai_validate_request_url("https://api.deepseek.com/chat/completions")
            .expect("https 地址必须允许");
        ai_validate_request_url("http://[::1]:8080/v1/chat/completions")
            .expect("IPv6 回环地址必须允许");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_complete_requires_a_stored_credential_when_auth_is_requested() {
        let directory = test_directory("ai-missing-credential");
        let base = ai_test_base(&directory);
        let requests = ai_test_handles();
        let error = tauri::async_runtime::block_on(ai_complete_at(
            &base,
            &requests,
            &json!({
                "request_id": "req-cred",
                "provider_id": "deepseek",
                "url": "https://api.deepseek.com/chat/completions",
                "auth": { "header": "authorization", "scheme": "Bearer" },
                "headers": { "content-type": "application/json" },
                "body": { "model": "deepseek-chat", "messages": [] },
            }),
        ))
        .expect_err("缺少密钥时必须失败");
        assert!(error.contains("\"missing_credential\""), "got: {error}");
        assert!(error.contains("recommended_action"), "got: {error}");
        assert!(
            error.contains("AI 面板"),
            "提示必须告诉用户去哪里配置: {error}"
        );
        assert!(!error.contains("Bearer"), "错误里不得出现注入头: {error}");
        assert!(
            !base.join(AI_PROVIDERS_FILE).exists(),
            "只读凭据不得创建存储文件"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_complete_rejects_credential_shaped_request_fields() {
        let directory = test_directory("ai-guard");
        let base = ai_test_base(&directory);
        // 词表规则本身：标准采样参数必须可用，凭据字段必须被识别。
        assert!(!sensitive_key("max_tokens"), "max_tokens 是标准模型参数");
        assert!(!sensitive_key("max_completion_tokens"));
        assert!(sensitive_key("api_key"));
        assert!(sensitive_key("requires_credential"));
        assert!(sensitive_key("authorization"));

        // 刻意不给 `AiRequestSpec` 实现 Debug：它持有凭据，测试失败信息也不该打印它。
        let error = match ai_request_spec(
            &base,
            &json!({
                "request_id": "req-guard",
                "provider_id": "deepseek",
                "url": "https://api.deepseek.com/chat/completions",
                "body": {
                    "model": "deepseek-chat",
                    "messages": [{ "role": "user", "content": "hi", "api_key": "sk-must-not-leak" }],
                },
            }),
        ) {
            Ok(_) => panic!("请求体里的凭据字段必须被拦下"),
            Err(error) => error,
        };
        assert!(error.contains("\"invalid_request\""), "got: {error}");
        assert!(
            error.contains("body.messages[0].api_key"),
            "错误必须指明字段路径: {error}"
        );
        assert!(
            !error.contains("sk-must-not-leak"),
            "错误里不得出现字段值: {error}"
        );

        let spec = ai_request_spec(
            &base,
            &json!({
                "request_id": "req-ok",
                "provider_id": "deepseek",
                "url": "https://api.deepseek.com/chat/completions",
                "body": { "model": "m", "messages": [], "max_tokens": 16 },
            }),
        )
        .expect("标准采样参数不得被误伤");
        assert_eq!(spec.timeout_ms, AI_DEFAULT_TIMEOUT_MS);
        assert!(spec.auth_header.is_none());
        assert!(spec.secrets.forms.is_empty(), "没有存过凭据时不带擦除素材");

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_payloads_accept_both_invoke_shapes() {
        // 服务壳发 `{ "input": { … } }`，桌面壳的 nativeInput 对 AI 命令直接发裸字段，
        // 两种形状都必须能解析出同一份载荷。
        for value in [
            json!({ "request_id": "r1", "provider_id": "deepseek" }),
            json!({ "input": { "request_id": "r1", "provider_id": "deepseek" } }),
        ] {
            let payload = ai_payload(&value, "ai_complete").expect("两种调用形状都必须可解析");
            assert_eq!(payload["request_id"], json!("r1"));
            assert_eq!(payload["provider_id"], json!("deepseek"));
        }
        assert!(ai_payload(&Value::Null, "ai_complete")
            .expect("无参数调用按空载荷处理")
            .is_empty());
        let strict = strict_payload(&json!({ "input": { "provider_id": "p" } }), "ai_secret_set")
            .expect("信封形状必须可解析");
        assert_eq!(strict["provider_id"], json!("p"));
        assert!(
            strict_payload(&json!({ "api_key": "sk-x" }), "ai_secret_set").is_err(),
            "字段固定的命令必须继续做凭据字段扫描"
        );
    }

    #[test]
    fn ai_complete_posts_with_the_injected_credential_and_parses_json() {
        let directory = test_directory("ai-complete-ok");
        let base = ai_test_base(&directory);
        ai_connection_save_at(&base, &json!({ "id": "local", "label": "Local" }))
            .expect("provider should save");
        ai_secret_set_at(&base, "local", "sk-loopback-test-key").expect("secret should save");

        let (result, request) = run_ai_complete_once(
            &base,
            json!({
                "request_id": "req-1",
                "provider_id": "local",
                "auth": { "header": "authorization", "scheme": "Bearer" },
                "headers": {
                    "content-type": "application/json",
                    // 渲染层的内部标记：绝不能发给 Provider。
                    "x-workbench-auth": "provider",
                    "x-workbench-provider": "local",
                },
                "body": { "model": "test", "messages": [{ "role": "user", "content": "你好" }] },
                "timeout_ms": 5000,
            }),
            http_response(
                "200 OK",
                "application/json",
                "{\"choices\":[{\"message\":\"hi\"}]}",
            ),
        );
        let result = result.expect("本机回环请求应当成功");
        assert_eq!(result["status"], json!(200));
        assert_eq!(result["response_kind"], json!("json"));
        assert_eq!(result["body"]["choices"][0]["message"], json!("hi"));
        assert_eq!(result["headers"]["content-type"], json!("application/json"));
        assert!(!result.to_string().contains("sk-loopback-test-key"));

        let lowered = request.to_ascii_lowercase();
        assert!(
            lowered.contains("authorization: bearer sk-loopback-test-key"),
            "本地凭据必须由原生侧注入: {request}"
        );
        assert!(
            lowered.contains("\"model\":\"test\""),
            "请求体必须原样发出: {request}"
        );
        assert!(
            !lowered.contains("x-workbench-"),
            "内部标记不得离开本进程: {request}"
        );
        assert!(lowered.starts_with("post /v1/chat/completions"));

        // 不给 headers 时必须补上 content-type，且不能带任何鉴权头。
        let (plain, plain_request) = run_ai_complete_once(
            &base,
            json!({
                "request_id": "req-2",
                "provider_id": "local",
                "body": { "model": "test" },
                "timeout_ms": 5000,
            }),
            http_response("200 OK", "application/json", "{\"ok\":true}"),
        );
        plain.expect("不带鉴权的请求应当成功");
        let plain_lowered = plain_request.to_ascii_lowercase();
        assert!(
            plain_lowered.contains("content-type: application/json"),
            "缺省请求头必须补 content-type: {plain_request}"
        );
        assert!(
            !plain_lowered.contains("authorization")
                && !plain_lowered.contains("sk-loopback-test-key"),
            "没有 auth 时不得注入凭据: {plain_request}"
        );

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_complete_skips_auth_for_endpoints_without_a_header() {
        let directory = test_directory("ai-complete-no-auth");
        let base = ai_test_base(&directory);
        ai_connection_save_at(&base, &json!({ "id": "custom-1", "label": "本地端点" }))
            .expect("provider should save");
        // 刻意不保存任何密钥：空 header 的预设不需要密钥，也不得报 missing_credential。
        for auth in [
            json!({ "header": "", "scheme": "Bearer" }),
            json!({ "scheme": "Bearer" }),
            json!(null),
        ] {
            let (result, request) = run_ai_complete_once(
                &base,
                json!({
                    "request_id": "req-no-auth",
                    "provider_id": "custom-1",
                    "auth": auth,
                    "body": { "model": "local" },
                    "timeout_ms": 5000,
                }),
                http_response("200 OK", "application/json", "{\"ok\":true}"),
            );
            result.expect("不需要密钥的端点必须能直接调用");
            assert!(
                !request.to_ascii_lowercase().contains("authorization"),
                "空 header 不得注入鉴权头: {request}"
            );
        }
        let _ = fs::remove_dir_all(directory);
    }

    /// `ai_request_spec` 的失败分支：刻意不打印载荷（里面可能有凭据）。
    fn expect_spec_error(base: &Path, payload: Value) -> String {
        match ai_request_spec(base, &payload) {
            Ok(_) => panic!("该请求形状必须被拒绝"),
            Err(error) => error,
        }
    }

    #[test]
    fn ai_complete_stops_redirects_and_rejects_bad_request_shapes() {
        let directory = test_directory("ai-complete-redirect");
        let base = ai_test_base(&directory);
        ai_connection_save_at(&base, &json!({ "id": "local", "label": "Local" }))
            .expect("provider should save");
        ai_secret_set_at(&base, "local", "sk-redirect-test-key").expect("secret should save");

        // 3xx：不跟随跳转（自定义鉴权头可能被转发到别的站点），直接停在原地。
        let (redirected, _) = run_ai_complete_once(
            &base,
            json!({
                "request_id": "req-redirect",
                "provider_id": "local",
                "auth": { "header": "authorization", "scheme": "Bearer" },
                "body": { "model": "test" },
                "timeout_ms": 5000,
            }),
            http_response("302 Found", "text/plain", ""),
        );
        let redirected = redirected.expect_err("3xx 必须失败");
        assert!(
            redirected.contains("\"provider_error\""),
            "got: {redirected}"
        );
        assert!(redirected.contains("跳转"), "got: {redirected}");
        assert!(!redirected.contains("sk-redirect-test-key"));

        // 请求形状错误：非文本请求头 / 非法头名 / 缺 body / 超时值非法。
        let header_value = expect_spec_error(
            &base,
            json!({ "url": "https://example.com/v1", "headers": { "x-extra": 7 }, "body": {} }),
        );
        assert!(header_value.contains("必须是文本"), "got: {header_value}");
        let header_name = expect_spec_error(
            &base,
            json!({ "url": "https://example.com/v1", "headers": { "bad header": "x" }, "body": {} }),
        );
        assert!(header_name.contains("请求头名称无效"), "got: {header_name}");
        let missing_body = expect_spec_error(&base, json!({ "url": "https://example.com/v1" }));
        assert!(missing_body.contains("缺少 body"), "got: {missing_body}");
        let bad_timeout = expect_spec_error(
            &base,
            json!({ "url": "https://example.com/v1", "body": {}, "timeout_ms": 0 }),
        );
        assert!(bad_timeout.contains("超时时间无效"), "got: {bad_timeout}");
        // 要注入凭据却没给 provider_id：与浏览器壳一致报 not_configured。
        let unconfigured = expect_spec_error(
            &base,
            json!({
                "url": "https://example.com/v1",
                "auth": { "header": "authorization" },
                "body": {},
            }),
        );
        assert!(
            unconfigured.contains("\"not_configured\""),
            "got: {unconfigured}"
        );

        // request_id 缺省时本地补一个，取消依然可用。
        let spec = ai_request_spec(
            &base,
            &json!({ "url": "https://example.com/v1", "body": {} }),
        )
        .expect("request_id 缺省时应当本地补一个");
        assert!(
            spec.request_id.starts_with("ai-request-"),
            "got: {}",
            spec.request_id
        );
        assert_eq!(spec.provider_id, "");
        assert_eq!(spec.timeout_ms, AI_DEFAULT_TIMEOUT_MS);

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_complete_maps_provider_statuses_and_stream_responses() {
        let directory = test_directory("ai-complete-status");
        let base = ai_test_base(&directory);
        ai_connection_save_at(&base, &json!({ "id": "local", "label": "Local" }))
            .expect("provider should save");
        ai_secret_set_at(&base, "local", "sk-status-test-key").expect("secret should save");
        let payload = || {
            json!({
                "request_id": "req-status",
                "provider_id": "local",
                "auth": { "header": "authorization", "scheme": "Bearer" },
                "headers": { "content-type": "application/json" },
                "body": { "model": "test", "messages": [] },
                "timeout_ms": 5000,
            })
        };

        let (unauthorized, _) = run_ai_complete_once(
            &base,
            payload(),
            http_response(
                "401 Unauthorized",
                "application/json",
                "{\"error\":\"bad key\"}",
            ),
        );
        let unauthorized = unauthorized.expect_err("401 必须失败");
        assert!(
            unauthorized.contains("\"missing_credential\""),
            "got: {unauthorized}"
        );
        assert!(!unauthorized.contains("sk-status-test-key"));

        let (forbidden, _) = run_ai_complete_once(
            &base,
            payload(),
            http_response(
                "403 Forbidden",
                "application/json",
                "{\"error\":\"no access\"}",
            ),
        );
        assert!(forbidden
            .expect_err("403 必须失败")
            .contains("\"permission_denied\""));

        let (limited, _) = run_ai_complete_once(
            &base,
            payload(),
            http_response(
                "429 Too Many Requests",
                "application/json",
                "{\"error\":\"slow down\"}",
            ),
        );
        let limited = limited.expect_err("429 必须失败");
        assert!(limited.contains("\"rate_limited\""), "got: {limited}");
        assert!(limited.contains("slow down"));

        let (failed, _) = run_ai_complete_once(
            &base,
            payload(),
            http_response(
                "500 Internal Server Error",
                "text/plain",
                "upstream exploded",
            ),
        );
        let failed = failed.expect_err("5xx 必须失败");
        assert!(failed.contains("\"provider_error\""), "got: {failed}");
        assert!(failed.contains("\"status\":500"), "got: {failed}");
        assert!(failed.contains("upstream exploded"), "got: {failed}");

        let (stream, _) = run_ai_complete_once(
            &base,
            payload(),
            http_response("200 OK", "text/event-stream", "data: {\"choices\":[]}\n\n"),
        );
        let stream = stream.expect("SSE 响应应当成功");
        assert_eq!(stream["response_kind"], json!("stream"));
        assert_eq!(stream["body"], json!("data: {\"choices\":[]}\n\n"));
        assert_eq!(
            stream["headers"]["content-type"],
            json!("text/event-stream")
        );

        let (malformed, _) = run_ai_complete_once(
            &base,
            payload(),
            http_response("200 OK", "application/json", "<html>not json</html>"),
        );
        let malformed = malformed.expect("非 JSON 正文按原文回传，由前端判定 malformed_response");
        assert_eq!(malformed["response_kind"], json!("json"));
        assert_eq!(malformed["body"], json!("<html>not json</html>"));

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ai_cancel_unknown_request_is_a_harmless_no_op() {
        let requests = ai_test_handles();
        let unknown = ai_cancel_at(&requests, &json!({ "request_id": "req-missing" }))
            .expect("取消未知请求不得报错");
        assert_eq!(unknown["cancelled"], json!(false));
        // 与浏览器壳一致：取消永不失败，空 id / 空载荷都只是空操作。
        let blank =
            ai_cancel_at(&requests, &json!({ "request_id": "   " })).expect("空请求 ID 也不得报错");
        assert_eq!(blank["cancelled"], json!(false));
        let empty = ai_cancel_at(&requests, &Value::Null).expect("无参数也不得报错");
        assert_eq!(empty["cancelled"], json!(false));
    }

    #[test]
    fn ai_cancel_aborts_a_registered_handle() {
        let requests = ai_test_handles();
        let handle = tauri::async_runtime::spawn(async {
            thread::sleep(Duration::from_millis(50));
        });
        requests.lock().unwrap().insert("req-sleep".into(), handle);
        let cancelled = ai_cancel_at(&requests, &json!({ "request_id": "req-sleep" }))
            .expect("取消已登记的句柄不得报错");
        assert_eq!(cancelled["cancelled"], json!(true));
        assert!(requests.lock().unwrap().is_empty(), "取消后必须摘掉句柄");
    }

    #[test]
    fn ai_complete_cancel_aborts_an_in_flight_request() {
        let directory = test_directory("ai-complete-cancel");
        let base = ai_test_base(&directory);
        ai_connection_save_at(&base, &json!({ "id": "local", "label": "Local" }))
            .expect("provider should save");
        ai_secret_set_at(&base, "local", "sk-cancel-test-key").expect("secret should save");

        // 只接受 TCP 连接、永不回应 TLS 握手的「服务端」：请求会一直挂在握手上，
        // 于是取消测试不需要任何外部网络，也不会因为网络抖动而不稳定。
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        listener
            .set_nonblocking(true)
            .expect("listener should be non-blocking");
        let port = listener
            .local_addr()
            .expect("listener should have an address")
            .port();
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = Arc::clone(&stop);
        let server = thread::spawn(move || {
            let mut held = Vec::new();
            while !server_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => held.push(stream),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
            drop(held);
        });

        let requests = Arc::new(ai_test_handles());
        let client_requests = Arc::clone(&requests);
        let client_base = base.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let client = thread::spawn(move || {
            let result = tauri::async_runtime::block_on(ai_complete_at(
                &client_base,
                &client_requests,
                &json!({
                    "request_id": "req-cancel",
                    "provider_id": "local",
                    "url": format!("https://127.0.0.1:{port}/v1/chat/completions"),
                    "auth": { "header": "authorization", "scheme": "Bearer" },
                    "headers": { "content-type": "application/json" },
                    "body": { "model": "test", "messages": [] },
                    "timeout_ms": 5000,
                }),
            ));
            let _ = sender.send(result);
        });

        let mut cancelled = false;
        let mut finished_early = None;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            let outcome = ai_cancel_at(&requests, &json!({ "request_id": "req-cancel" }))
                .expect("取消不得报错");
            if outcome["cancelled"] == json!(true) {
                cancelled = true;
                break;
            }
            if let Ok(result) = receiver.try_recv() {
                finished_early = Some(result);
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            cancelled,
            "in-flight 请求必须可取消（提前结束: {finished_early:?}）"
        );

        let result = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("取消后必须立刻返回");
        let error = result.expect_err("被取消的请求不得报告成功");
        assert!(error.contains("\"cancelled\""), "got: {error}");
        assert!(error.contains("已取消这次 AI 请求"), "got: {error}");
        assert!(!error.contains("sk-cancel-test-key"));

        assert_eq!(
            ai_cancel_at(&requests, &json!({ "request_id": "req-cancel" })).unwrap()["cancelled"],
            json!(false),
            "已经结束的请求再次取消必须是空操作"
        );
        client.join().expect("客户端线程应当结束");
        stop.store(true, Ordering::Release);
        server.join().expect("服务端线程应当结束");
        let _ = fs::remove_dir_all(directory);
    }
}

pub fn run() {
    // Resolve the optional launch directory before the window exists so a bad
    // path fails fast instead of leaving an empty workbench on screen.
    let launch_project_dir = match project_dir_from_args(std::env::args().skip(1)) {
        Ok(directory) => directory,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let _ = LAUNCH_PROJECT_DIR.set(launch_project_dir);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(BridgeState::new())
        .invoke_handler(tauri::generate_handler![
            project_open,
            project_create,
            project_save,
            project_external_status,
            project_reload,
            project_merge,
            project_resolve,
            project_close,
            confirm_close,
            bridge_status,
            bridge_capture_page,
            bridge_send_selection,
            read_project,
            save_session,
            load_session,
            write_recovery_journal,
            read_recovery_journal,
            clear_recovery_journal,
            create_snapshot,
            list_snapshots,
            read_snapshot,
            restore_snapshot,
            import_preview,
            import_confirm,
            course_seed_create,
            blueprint_build,
            asset_import,
            asset_read,
            select_file,
            select_folder,
            select_export_path,
            export_preflight,
            export_run,
            reveal_export_path,
            publication_record,
            secret_set,
            secret_delete,
            connector_sync,
            ai_analyze,
            suggestion_apply,
            ai_connection_list,
            ai_connection_save,
            ai_connection_delete,
            ai_secret_set,
            ai_secret_delete,
            ai_models_list,
            ai_complete,
            ai_cancel,
            ai_execution_append,
            ai_execution_list
        ])
        .build(tauri::generate_context!())
        .expect("error while building AI Course Workbench");
    app.run(|app_handle, event| match event {
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            if !EXIT_READY.load(Ordering::Acquire) {
                api.prevent_close();
                let _ = app_handle.emit(WINDOW_CLOSE_REQUEST_EVENT, ());
            }
        }
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !EXIT_READY.load(Ordering::Acquire) {
                api.prevent_exit();
                let _ = app_handle.emit(CLOSE_REQUEST_EVENT, ());
            }
        }
        tauri::RunEvent::Exit => {
            release_all_project_locks();
        }
        _ => {}
    });
}
