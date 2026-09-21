use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
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

struct BridgeState {
    token: String,
}

impl BridgeState {
    fn new() -> Self {
        Self {
            token: bridge_token(),
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
            "user_message": "检测到 project.json 已被外部修改，保存已阻止。",
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
        "html" | "web" => "html",
        _ => return Err("当前原生导出仅支持 JSON、Markdown、HTML".into()),
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
        "json" => "json",
        "markdown" => "md",
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
    let Some(content_item_id) = content_item_id else {
        return true;
    };
    let used_by_content = project
        .get("asset_usages")
        .and_then(Value::as_array)
        .map(|usages| {
            usages.iter().any(|usage| {
                usage.get("asset_id").and_then(Value::as_str) == Some(asset_id)
                    && usage.get("content_item_id").and_then(Value::as_str) == Some(content_item_id)
            })
        })
        .unwrap_or(false);
    let resolved_by_content = project
        .get("requirements")
        .and_then(Value::as_array)
        .map(|requirements| {
            requirements.iter().any(|requirement| {
                requirement.get("resolved_asset_id").and_then(Value::as_str) == Some(asset_id)
                    && requirement.get("content_item_id").and_then(Value::as_str)
                        == Some(content_item_id)
            })
        })
        .unwrap_or(false);
    used_by_content || resolved_by_content
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
                        "placeholder" => lines.push(format!("> 待补内容：{content}")),
                        _ => lines.push(content),
                    }
                    lines.push(String::new());
                }
            }
            if let Some(item_id) = item.get("id").and_then(Value::as_str) {
                let assets = referenced_assets_for_content(project, item_id);
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

fn safe_url(value: &str) -> String {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    if ["javascript:", "data:", "vbscript:", "file:"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        return "#".into();
    }
    trimmed.into()
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
                        "placeholder" => body.push_str(&format!(
                            "<aside class=\"待补内容\">待补内容：{escaped}</aside>"
                        )),
                        "image" | "gif" => body.push_str(&format!(
                            "<img alt=\"{escaped}\" src=\"{}\">",
                            escape_html(&safe_url(&content))
                        )),
                        _ => body.push_str(&format!("<p>{escaped}</p>")),
                    }
                }
            }
            if let Some(item_id) = item.get("id").and_then(Value::as_str) {
                let assets = referenced_assets_for_content(project, item_id);
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
    json!({
        "error": {
            "code": code,
            "user_message": user_message,
            "technical_message": user_message,
            "severity": "blocking",
            "recoverable": false,
            "recommended_action": null,
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
            options_object.and_then(|object| field(object, &["content_item_id", "contentItemId"]))
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
        for asset in assets {
            let Some(asset_id) = asset.get("id").and_then(Value::as_str) else {
                continue;
            };
            if !asset_selected_for_content(&project, asset_id, content_item_id.as_deref()) {
                continue;
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

#[tauri::command]
fn export_run(preset: Value, options: Option<Value>) -> Result<Value, String> {
    let object = require_object(&preset, "export_run")?;
    let project_dir = required_string(object, &["project_dir", "projectDir"], "项目目录")?;
    let project_dir = explicit_project_dir(&project_dir, false)?;
    let _lease_guard = require_active_project_lock(&project_dir)?;
    let (project, report, output_path, format) =
        export_preflight_report(&preset, options.as_ref())?;
    if report.get("ok").and_then(Value::as_bool).unwrap_or(false) == false {
        return Err("导出前检查发现严重问题，请先修复".into());
    }
    let content_item_id = report.get("content_item_id").and_then(Value::as_str);
    let contents = match format.as_str() {
        "json" => serde_json::to_string_pretty(&project).map_err(|error| error.to_string())? + "\n",
        "markdown" => markdown_for_project(&project, content_item_id),
        "html" => html_for_project(&project, content_item_id),
        _ => return Err("不支持的导出格式".into()),
    };
    atomic_write_path(&output_path, &contents, false)?;
    let filename = output_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("export");
    let mime_type = match format.as_str() {
        "json" => "application/json",
        "markdown" => "text/markdown",
        "html" => "text/html",
        _ => "application/octet-stream",
    };
    Ok(json!({
        "status": "completed",
        "format": format,
        "output_path": output_path,
        "target_path": output_path,
        "bytes": contents.len(),
        "files": [{
            "relative_path": filename,
            "path": output_path,
            "mime_type": mime_type,
            "bytes": { "__bytes_base64": encode_base64(contents.as_bytes()) },
        }],
    }))
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
    fn release_without_registered_lease_has_no_side_effect() {
        let directory = test_directory("release-empty");
        let guard_path = directory.join(PROJECT_LOCK_GUARD_RELATIVE_PATH);
        release_project_lock_for(&directory, "nobody")
            .expect("releasing an unopened directory should be idempotent");
        assert!(!guard_path.exists());
        assert!(!directory.join(PROJECT_LOCK_RELATIVE_PATH).exists());
        let _ = fs::remove_dir_all(directory);
    }
}

pub fn run() {
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
            asset_import,
            select_file,
            select_folder,
            select_export_path,
            export_preflight,
            export_run,
            publication_record,
            secret_set,
            secret_delete,
            connector_sync,
            ai_analyze,
            suggestion_apply
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
