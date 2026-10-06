import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { createHash } from "node:crypto";
import {
  addAsset,
  type AddAssetResult,
  type AssetInput,
  applyAssetRename,
  type AssetRenamePlan,
  isAssetRenameNoop,
  planAssetRename,
} from "../domain/assets.ts";
import { createSnapshot as createDomainSnapshot } from "../domain/workflow.ts";
import {
  CURRENT_SCHEMA_VERSION,
  type ProjectData,
  type Snapshot,
} from "../domain/types.ts";
import {
  assertValidProjectData,
  inspectProjectData,
  loadProject,
  migrateProject,
  type ProjectInspection,
  serializeProject,
} from "../domain/store.ts";
import { clone, id, now, sha256Bytes, stableJson } from "../domain/util.ts";
import { error, ServiceError } from "./errors.ts";

export interface FileFingerprint {
  exists: boolean;
  mtime_ms: number | null;
  size: number | null;
  hash: string | null;
}

export interface RecoveryJournal {
  transaction_id: string;
  project_id: string;
  canonical_revision: string;
  saved_at: string;
  project: ProjectData;
}

export interface ProjectSaveBinding {
  expected_project_id: string;
  lease_generation: string;
  editor_generation: number;
  operation_id: string;
  revision: number;
  expected_fingerprint: FileFingerprint;
  recovery_metadata?: unknown;
}

export interface ProjectWriteResult {
  fingerprint: FileFingerprint;
  durability_warning: string | null;
}

interface AtomicTextWriteResult {
  mtime_ms: number | null;
  durability_warning: string | null;
}

export interface SnapshotCopyWriteResult {
  content_hash: string;
  created_at: string;
  outcome: "written" | "unchanged";
  durability_warning: string | null;
}

export interface SnapshotListRow {
  id: string;
  name: string;
  note: string;
  created_at: string;
  status: "available" | "error";
  error?: { code: string; message: string };
  content_hash?: string;
}

interface SnapshotFileMetadata {
  version: 1;
  snapshot_id: string;
  name: string;
  note: string;
  created_at: string;
  content_hash: string;
}

export interface ProjectDiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

export interface ProjectDiff {
  changed: boolean;
  entries: ProjectDiffEntry[];
}

export interface ExternalModificationReport {
  changed: boolean;
  baseline: FileFingerprint | null;
  current: FileFingerprint;
  external: ProjectData | null;
  /** Difference between the last loaded baseline and the file on disk. */
  external_diff: ProjectDiff;
  /** Difference between the last loaded baseline and in-memory local edits. */
  local_diff: ProjectDiff | null;
}

export interface MergeConflict {
  path: string;
  base: unknown;
  local: unknown;
  external: unknown;
}

export interface MergeResult {
  merged: ProjectData;
  conflicts: MergeConflict[];
  can_apply: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function diffValues(
  before: unknown,
  after: unknown,
  path: string,
  entries: ProjectDiffEntry[],
): void {
  if (stableJson(before) === stableJson(after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const max = Math.max(before.length, after.length);
    for (let index = 0; index < max; index += 1) {
      diffValues(before[index], after[index], `${path}[${index}]`, entries);
    }
    return;
  }
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      diffValues(
        before[key],
        after[key],
        path ? `${path}.${key}` : key,
        entries,
      );
    }
    return;
  }
  entries.push({ path, before, after });
}

export function diffProjectData(
  before: ProjectData,
  after: ProjectData,
): ProjectDiff {
  const entries: ProjectDiffEntry[] = [];
  diffValues(before, after, "", entries);
  return { changed: entries.length > 0, entries };
}

export const diffCanonicalProject = diffProjectData;
export const diffProjects = diffProjectData;
export const diffSnapshots = diffProjectData;

function assignPath(value: unknown, path: string, replacement: unknown): void {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  if (!parts.length) return;
  let cursor: unknown = value;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    if (Array.isArray(cursor)) cursor = cursor[Number(part)];
    else if (isPlainRecord(cursor)) cursor = cursor[part];
    else return;
  }
  const leaf = parts.at(-1)!;
  if (Array.isArray(cursor)) {
    const index = Number(leaf);
    if (replacement === undefined) cursor.splice(index, 1);
    else cursor[index] = structuredClone(replacement);
  } else if (isPlainRecord(cursor)) {
    if (replacement === undefined) delete cursor[leaf];
    else cursor[leaf] = structuredClone(replacement);
  }
}

/** Three-way merge. Conflicting paths are returned instead of silently lost. */
export function mergeProjectData(
  base: ProjectData,
  local: ProjectData,
  external: ProjectData,
): MergeResult {
  const baseCanonical = migrateProject(base);
  const localCanonical = migrateProject(local);
  const externalCanonical = migrateProject(external);
  const localDiff = diffProjectData(baseCanonical, localCanonical);
  const externalDiff = diffProjectData(baseCanonical, externalCanonical);
  const byPath = new Map(localDiff.entries.map((entry) => [entry.path, entry]));
  const conflicts: MergeConflict[] = [];
  const merged = structuredClone(baseCanonical);
  for (const change of localDiff.entries) {
    assignPath(merged, change.path, change.after);
  }
  for (const change of externalDiff.entries) {
    const localChange = byPath.get(change.path);
    if (!localChange) {
      assignPath(merged, change.path, change.after);
      continue;
    }
    if (stableJson(localChange.after) === stableJson(change.after)) {
      assignPath(merged, change.path, change.after);
      continue;
    }
    // updated_at is derived merge metadata. Concurrent non-overlapping edits
    // should not become a content conflict only because both writers touched it.
    if (change.path === "project.updated_at") {
      const localUpdated = typeof localChange.after === "string"
        ? localChange.after
        : "";
      const externalUpdated = typeof change.after === "string"
        ? change.after
        : "";
      assignPath(
        merged,
        change.path,
        localUpdated >= externalUpdated ? localChange.after : change.after,
      );
      continue;
    }
    conflicts.push({
      path: change.path,
      base: change.before,
      local: localChange.after,
      external: change.after,
    });
    // Keep local edits in the preview; callers must resolve conflicts before
    // writing and can choose the external value explicitly.
    assignPath(merged, change.path, localChange.after);
  }
  assertValidProjectData(merged);
  return { merged, conflicts, can_apply: conflicts.length === 0 };
}

export const mergeProjects = mergeProjectData;

export interface ProjectLock {
  app_instance_id: string;
  generation?: string;
  pid: number;
  host: string;
  opened_at: string;
  heartbeat: string;
}

export interface ProjectDirectoryOptions {
  read_only?: boolean;
  force_takeover?: boolean;
  stale_after_ms?: number;
  heartbeat_ms?: number;
  app_instance_id?: string;
}

const PROJECT_FILE = "project.json";
const LOCK_FILE = ".workspace/project.lock";
const LOCK_GUARD_FILE = ".workspace/project.lock.guard";
const JOURNAL_FILE = ".workspace/recovery.json";
const storageIoMetrics = {
  project_full_read_operations: 0,
  project_full_read_bytes: 0,
  project_hash_passes: 0,
  project_hash_bytes: 0,
  project_temp_files_created: 0,
  project_temp_write_bytes: 0,
  project_backup_copy_operations: 0,
  project_backup_copy_read_bytes: 0,
  project_backup_copy_write_bytes: 0,
  project_file_sync_attempts: 0,
  project_file_sync_successes: 0,
  project_backup_renames: 0,
  project_promotions: 0,
  project_directory_sync_attempts: 0,
  project_directory_sync_successes: 0,
  recovery_journal_temp_files_created: 0,
  recovery_journal_temp_write_bytes: 0,
  recovery_journal_file_sync_attempts: 0,
  recovery_journal_file_sync_successes: 0,
  recovery_journal_promotions: 0,
  recovery_journal_removal_attempts: 0,
  recovery_journal_removal_successes: 0,
  recovery_directory_sync_attempts: 0,
  recovery_directory_sync_successes: 0,
};
let storageIoDiagnosticsEnabled = false;

export function setStorageIoDiagnosticsEnabled(enabled: boolean): void {
  storageIoDiagnosticsEnabled = enabled;
  if (!enabled) return;
  for (const key of Object.keys(storageIoMetrics) as Array<
    keyof typeof storageIoMetrics
  >) {
    storageIoMetrics[key] = 0;
  }
}

export function getStorageIoMetrics(): typeof storageIoMetrics {
  return { ...storageIoMetrics };
}

function isNotFound(caught: unknown): boolean {
  return caught instanceof Deno.errors.NotFound ||
    (caught instanceof Error && "code" in caught &&
      (caught as { code?: string }).code === "ENOENT");
}

function mapWriteFailure(caught: unknown, relativePath: string): unknown {
  if (caught instanceof ServiceError) return caught;
  const candidate = caught as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  const code = String(candidate?.code ?? "").toUpperCase();
  const name = String(candidate?.name ?? "");
  const message = String(candidate?.message ?? caught ?? "");
  if (
    code === "ENOSPC" || name === "QuotaExceededError" ||
    /(?:no space left|disk full|quota exceeded|not enough space)/i.test(message)
  ) {
    return error(
      "storage_full",
      "项目磁盘空间不足，尚未完成保存。",
      `Storage write failed for ${relativePath}: ${message}`,
      {
        recoverable: true,
        recommended_action: "清理磁盘空间后重试；最近一次恢复日志仍会保留。",
        details: { path: relativePath },
      },
    );
  }
  return caught;
}

function isSafeRetryableWriteFailure(caught: unknown): boolean {
  const nestedCode = caught instanceof ServiceError
    ? caught.error.details.write_error_code
    : undefined;
  const code = String(
    nestedCode ?? (caught as { code?: unknown })?.code ?? "",
  ).toUpperCase();
  return code === "EAGAIN" || code === "EBUSY" || code === "EINTR";
}

function writeFailure(
  caught: unknown,
  relativePath: string,
  stage: string,
  commitState: "not_committed" | "outcome_uncertain" | "committed",
): ServiceError {
  const mapped = mapWriteFailure(caught, relativePath);
  const retryable = commitState === "not_committed" &&
    isSafeRetryableWriteFailure(caught);
  const details = {
    ...(mapped instanceof ServiceError ? mapped.error.details : {}),
    path: relativePath,
    ...(String((caught as { code?: unknown })?.code ?? "")
      ? { write_error_code: String((caught as { code?: unknown }).code) }
      : {}),
    stage,
    commit_state: commitState,
    retryable,
  };
  if (mapped instanceof ServiceError) {
    return new ServiceError({ ...mapped.error, details });
  }
  return error(
    "storage_write_failed",
    "保存没有完成，请检查项目文件状态后重试。",
    mapped instanceof Error ? mapped.message : String(mapped),
    { recoverable: false, recommended_action: null, details },
  );
}

function assertRelative(relativePath: string, allowRoot = false): void {
  if (
    !relativePath || relativePath.includes("\\") ||
    relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)
  ) {
    throw error(
      "invalid_project_path",
      "项目文件路径无效。",
      `Expected relative project path: ${relativePath}`,
      { recoverable: false, recommended_action: null, details: {} },
    );
  }
  const parts = relativePath.split("/");
  if (
    (!allowRoot && parts.length === 0) ||
    parts.some((part) => part === ".." || part === "" && parts.length > 1)
  ) {
    throw error(
      "invalid_project_path",
      "项目文件路径无效。",
      `Path traversal rejected: ${relativePath}`,
      { recoverable: false, recommended_action: null, details: {} },
    );
  }
}

function safeName(value: string): string {
  const result = Array.from(basename(value), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f || "/\\".includes(character)
      ? "_"
      : character;
  }).join("").trim();
  return result || "unnamed";
}

function assertNoSymlink(root: string, target: string): void {
  try {
    if (Deno.lstatSync(root).isSymlink) {
      throw error(
        "invalid_project_path",
        "项目文件路径无效。",
        `Symlink project root rejected: ${root}`,
        { recoverable: false, recommended_action: null, details: {} },
      );
    }
  } catch (caught) {
    if (caught instanceof ServiceError) throw caught;
    if (!isNotFound(caught)) throw caught;
  }
  const relativePath = relative(root, target);
  let cursor = root;
  for (const part of relativePath.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if (Deno.lstatSync(cursor).isSymlink) {
        throw error(
          "invalid_project_path",
          "项目文件路径无效。",
          `Symlink path rejected: ${target}`,
          { recoverable: false, recommended_action: null, details: {} },
        );
      }
    } catch (caught) {
      if (caught instanceof ServiceError) throw caught;
      if (!isNotFound(caught)) throw caught;
      // A missing parent will be created by the caller; there cannot be a
      // pre-existing symlink deeper in that missing path.
      break;
    }
  }
}

async function writeBytesSyncSafe(
  path: string,
  bytes: Uint8Array,
  onCreate?: () => void,
  trackProjectTemp = false,
  trackRecoveryJournalTemp = false,
): Promise<void> {
  const file = await Deno.open(path, {
    createNew: true,
    write: true,
  });
  onCreate?.();
  if (trackProjectTemp && storageIoDiagnosticsEnabled) {
    storageIoMetrics.project_temp_files_created += 1;
  }
  if (trackRecoveryJournalTemp && storageIoDiagnosticsEnabled) {
    storageIoMetrics.recovery_journal_temp_files_created += 1;
  }
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = await file.write(bytes.subarray(offset));
      offset += written;
      if (trackProjectTemp && storageIoDiagnosticsEnabled) {
        storageIoMetrics.project_temp_write_bytes += written;
      }
      if (trackRecoveryJournalTemp && storageIoDiagnosticsEnabled) {
        storageIoMetrics.recovery_journal_temp_write_bytes += written;
      }
    }
    if (trackProjectTemp && storageIoDiagnosticsEnabled) {
      storageIoMetrics.project_file_sync_attempts += 1;
    }
    if (trackRecoveryJournalTemp && storageIoDiagnosticsEnabled) {
      storageIoMetrics.recovery_journal_file_sync_attempts += 1;
    }
    await file.sync();
    if (trackProjectTemp && storageIoDiagnosticsEnabled) {
      storageIoMetrics.project_file_sync_successes += 1;
    }
    if (trackRecoveryJournalTemp && storageIoDiagnosticsEnabled) {
      storageIoMetrics.recovery_journal_file_sync_successes += 1;
    }
  } finally {
    file.close();
  }
}

async function copyFileSyncSafe(
  source: string,
  destination: string,
  onCreate: () => void,
  trackProjectBackup = false,
): Promise<void> {
  const input = await Deno.open(source, { read: true });
  let output: Deno.FsFile | null = null;
  try {
    output = await Deno.open(destination, { createNew: true, write: true });
    onCreate();
    if (trackProjectBackup && storageIoDiagnosticsEnabled) {
      storageIoMetrics.project_backup_copy_operations += 1;
    }
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      const count = await input.read(buffer);
      if (count === null) break;
      if (trackProjectBackup && storageIoDiagnosticsEnabled) {
        storageIoMetrics.project_backup_copy_read_bytes += count;
      }
      let offset = 0;
      while (offset < count) {
        const written = await output.write(buffer.subarray(offset, count));
        offset += written;
        if (trackProjectBackup && storageIoDiagnosticsEnabled) {
          storageIoMetrics.project_backup_copy_write_bytes += written;
        }
      }
    }
    if (trackProjectBackup && storageIoDiagnosticsEnabled) {
      storageIoMetrics.project_file_sync_attempts += 1;
    }
    await output.sync();
    if (trackProjectBackup && storageIoDiagnosticsEnabled) {
      storageIoMetrics.project_file_sync_successes += 1;
    }
  } finally {
    output?.close();
    input.close();
  }
}

async function syncDirectoryPath(path: string): Promise<boolean> {
  let directory: Deno.FsFile | null = null;
  try {
    directory = await Deno.open(path, { read: true });
    await directory.sync();
    return true;
  } catch {
    return false;
  } finally {
    directory?.close();
  }
}

export async function checksumFile(
  path: string,
  trackProject = false,
): Promise<string> {
  const measure = storageIoDiagnosticsEnabled && trackProject;
  const input = await Deno.open(path, { read: true });
  if (measure) {
    storageIoMetrics.project_full_read_operations += 1;
    storageIoMetrics.project_hash_passes += 1;
  }
  const hash = createHash("sha256");
  const buffer = new Uint8Array(64 * 1024);
  try {
    while (true) {
      const count = await input.read(buffer);
      if (count === null) break;
      if (count) {
        hash.update(buffer.subarray(0, count));
        if (measure) {
          storageIoMetrics.project_full_read_bytes += count;
          storageIoMetrics.project_hash_bytes += count;
        }
      }
    }
  } finally {
    input.close();
  }
  return hash.digest("hex");
}

function sameFileIdentity(left: Deno.FileInfo, right: Deno.FileInfo): boolean {
  return left.isFile && right.isFile && left.dev === right.dev &&
    left.ino === right.ino && left.size === right.size &&
    left.mtime?.getTime() === right.mtime?.getTime();
}

async function copyAssetAndHash(
  source: string,
  destination: string,
): Promise<{ checksum: string; size: number }> {
  const sourcePathInfo = await Deno.lstat(source);
  if (sourcePathInfo.isSymlink || !sourcePathInfo.isFile) {
    throw error(
      "asset_source_unsafe",
      "素材源必须是普通文件。",
      `Asset import source is not a regular file: ${source}`,
      { recoverable: false, recommended_action: null, details: { stage: "source_validate", commit_state: "not_committed", retryable: false } },
    );
  }
  const input = await Deno.open(source, { read: true });
  let output: Deno.FsFile | null = null;
  let created = false;
  const hash = createHash("sha256");
  const buffer = new Uint8Array(64 * 1024);
  let size = 0;
  try {
    const opened = await input.stat();
    if (!sameFileIdentity(sourcePathInfo, opened)) {
      throw new Error("素材源在打开期间发生了变化");
    }
    output = await Deno.open(destination, { write: true, createNew: true });
    created = true;
    while (true) {
      const count = await input.read(buffer);
      if (count === null) break;
      if (!count) continue;
      const chunk = buffer.subarray(0, count);
      let offset = 0;
      while (offset < count) {
        const written = await output.write(chunk.subarray(offset));
        if (!written) throw new Error("素材复制写入没有前进");
        offset += written;
      }
      hash.update(chunk);
      size += count;
    }
    const [inputAfter, pathAfter, outputStat] = await Promise.all([
      input.stat(),
      Deno.lstat(source),
      output.stat(),
    ]);
    if (
      !sameFileIdentity(sourcePathInfo, inputAfter) ||
      !sameFileIdentity(sourcePathInfo, pathAfter) ||
      !outputStat.isFile || outputStat.size !== size
    ) {
      throw new Error("素材在复制期间发生了变化或复制结果不完整");
    }
    await output.sync();
    return { checksum: hash.digest("hex"), size };
  } catch (caught) {
    if (created) await Deno.remove(destination).catch(() => {});
    throw caught;
  } finally {
    output?.close();
    input.close();
  }
}

export interface AssetIntegrityResult {
  asset_id: string;
  path: string;
  exists: boolean;
  size: number | null;
  checksum: string | null;
  size_matches: boolean;
  checksum_matches: boolean;
  ok: boolean;
  error: string | null;
}

/** Verify actual project file bytes instead of trusting imported metadata. */
export async function verifyAssetFile(
  projectRoot: string,
  asset: ProjectData["assets"][number],
): Promise<AssetIntegrityResult> {
  const path = join(normalize(projectRoot), asset.storage_path);
  const base: AssetIntegrityResult = {
    asset_id: asset.id,
    path: asset.storage_path,
    exists: false,
    size: null,
    checksum: null,
    size_matches: false,
    checksum_matches: false,
    ok: false,
    error: null,
  };
  try {
    assertRelative(asset.storage_path);
    assertNoSymlink(normalize(projectRoot), path);
    const stat = await Deno.stat(path);
    if (!stat.isFile) throw new Error("素材路径不是文件");
    const checksum = await checksumFile(path);
    return {
      ...base,
      exists: true,
      size: stat.size,
      checksum,
      size_matches: stat.size === asset.file_size,
      checksum_matches: checksum === asset.checksum,
      ok: stat.size === asset.file_size && checksum === asset.checksum,
    };
  } catch (caught) {
    if (!isNotFound(caught)) base.error = String(caught);
    return base;
  }
}

export async function verifyProjectAssets(
  projectRoot: string,
  data: ProjectData,
): Promise<AssetIntegrityResult[]> {
  return await Promise.all(
    data.assets.filter((asset) => !asset.archived).map((asset) =>
      verifyAssetFile(projectRoot, asset)
    ),
  );
}

export const checkAssetIntegrity = verifyAssetFile;
export const verifyAssetChecksum = verifyAssetFile;

export async function fileFingerprint(path: string): Promise<FileFingerprint> {
  try {
    const stat = await Deno.stat(path);
    return {
      exists: true,
      mtime_ms: stat.mtime?.getTime() ?? null,
      size: stat.size,
      hash: await checksumFile(path, basename(path) === PROJECT_FILE),
    };
  } catch (caught) {
    if (isNotFound(caught)) {
      return { exists: false, mtime_ms: null, size: null, hash: null };
    }
    throw caught;
  }
}

function unreadableInspection(
  code: string,
  path: string,
  message: string,
  actual: string,
): ProjectInspection {
  return {
    status: "unreadable",
    schema_version: null,
    supported_schema_version: CURRENT_SCHEMA_VERSION,
    problem: {
      code,
      path,
      message,
      expected: "可读的项目目录中的 project.json",
      actual,
    },
    project: null,
  };
}

/**
 * Pure, side-effect-free classification of a candidate project folder. Mirrors
 * the native `project_inspect` command: it never takes the project lock, never
 * creates project.json and never mutates the folder.
 */
export async function inspectProjectDirectory(
  directory: string,
): Promise<ProjectInspection> {
  const trimmed = String(directory || "").trim();
  const root = normalize(trimmed);
  const path = join(root, PROJECT_FILE);
  if (!trimmed || !isAbsolute(root)) {
    return unreadableInspection(
      "invalid_path",
      PROJECT_FILE,
      "项目目录必须是用户明确选择的绝对路径。",
      trimmed || "空路径",
    );
  }
  let directoryStat: Deno.FileInfo;
  try {
    directoryStat = await Deno.lstat(root);
  } catch (caught) {
    if (isNotFound(caught)) {
      return unreadableInspection(
        "missing_directory",
        "",
        "项目目录不存在，可能已被移动或删除。",
        `${root} 不存在`,
      );
    }
    return unreadableInspection(
      "io_error",
      "",
      `无法检查项目目录：${caught instanceof Error ? caught.message : String(caught)}`,
      String(caught),
    );
  }
  if (directoryStat.isSymlink) {
    return unreadableInspection(
      "symlink_path",
      "",
      "为避免越过目录边界，项目目录不能是符号链接。",
      `${root} 是符号链接`,
    );
  }
  if (!directoryStat.isDirectory) {
    return unreadableInspection(
      "not_a_directory",
      "",
      "打开项目需要选择一个文件夹，而不是单个文件。",
      `${root} 不是目录`,
    );
  }

  let bytes: Uint8Array;
  try {
    const fileStat = await Deno.lstat(path);
    if (fileStat.isSymlink) {
      return unreadableInspection(
        "symlink_path",
        PROJECT_FILE,
        "为避免越过目录边界，project.json 不能是符号链接。",
        `${PROJECT_FILE} 是符号链接`,
      );
    }
    if (!fileStat.isFile) {
      return unreadableInspection(
        "not_a_file",
        PROJECT_FILE,
        "project.json 不是一个普通文件。",
        `${PROJECT_FILE} 不是文件`,
      );
    }
    bytes = await Deno.readFile(path);
  } catch (caught) {
    if (isNotFound(caught)) {
      return {
        status: "no_project_json",
        schema_version: null,
        supported_schema_version: CURRENT_SCHEMA_VERSION,
        problem: {
          code: "project_json_missing",
          path: PROJECT_FILE,
          message:
            "这个文件夹里还没有 project.json，因此它还不是 Workbench 项目。你可以把它作为已有文件夹导入。",
          expected: "所选文件夹根目录中存在 project.json",
          actual: "project.json 不存在",
        },
        project: null,
      };
    }
    const denied = caught instanceof Deno.errors.PermissionDenied;
    return unreadableInspection(
      denied ? "permission_denied" : "io_error",
      PROJECT_FILE,
      `无法读取 project.json：${caught instanceof Error ? caught.message : String(caught)}`,
      String(caught),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (caught) {
    return {
      status: "malformed_json",
      schema_version: null,
      supported_schema_version: CURRENT_SCHEMA_VERSION,
      problem: {
        code: "malformed_json",
        path: PROJECT_FILE,
        message: "project.json 存在，但内容无法解析，文件可能已损坏。",
        expected: "可解析的 JSON 对象",
        actual: caught instanceof Error ? caught.message : String(caught),
      },
      project: null,
    };
  }
  return inspectProjectData(parsed);
}

async function readProjectState(
  path: string,
): Promise<{ original: unknown; project: ProjectData; fingerprint: FileFingerprint }> {
  const bytes = await Deno.readFile(path);
  const measure = storageIoDiagnosticsEnabled && basename(path) === PROJECT_FILE;
  if (measure) {
    storageIoMetrics.project_full_read_operations += 1;
    storageIoMetrics.project_full_read_bytes += bytes.byteLength;
    storageIoMetrics.project_hash_passes += 1;
    storageIoMetrics.project_hash_bytes += bytes.byteLength;
  }
  const original: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const project = migrateProject(original);
  const stat = await Deno.stat(path);
  return {
    original,
    project,
    fingerprint: {
      exists: true,
      mtime_ms: stat.mtime?.getTime() ?? null,
      size: bytes.length,
      hash: await sha256Bytes(bytes),
    },
  };
}

/** Content identity is authoritative; mtime is diagnostic only. */
function fingerprintsDiffer(
  baseline: FileFingerprint,
  current: FileFingerprint,
): boolean {
  return baseline.exists !== current.exists || baseline.hash !== current.hash ||
    baseline.size !== current.size;
}

export class ProjectDirectoryStore {
  readonly directory: string;
  readonly options: Required<ProjectDirectoryOptions>;
  private lockTimer: ReturnType<typeof setInterval> | null = null;
  private lock: ProjectLock | null = null;
  private baseline: FileFingerprint | null = null;
  private baselineProject: ProjectData | null = null;

  constructor(directory: string, options: ProjectDirectoryOptions = {}) {
    this.directory = normalize(directory);
    this.options = {
      read_only: options.read_only ?? false,
      force_takeover: options.force_takeover ?? false,
      stale_after_ms: options.stale_after_ms ?? 30_000,
      heartbeat_ms: options.heartbeat_ms ?? 5_000,
      app_instance_id: options.app_instance_id ?? id(),
    };
  }

  get projectPath(): string {
    return join(this.directory, PROJECT_FILE);
  }
  get workspacePath(): string {
    return join(this.directory, ".workspace");
  }
  get lockPath(): string {
    return join(this.directory, LOCK_FILE);
  }
  get journalPath(): string {
    return join(this.directory, JOURNAL_FILE);
  }

  get leaseGeneration(): string | null {
    return this.lock?.generation ?? null;
  }

  private path(relativePath: string): string {
    assertRelative(relativePath);
    const target = join(this.directory, relativePath);
    assertNoSymlink(this.directory, target);
    return target;
  }

  private assertWritableLeaseConfigured(): void {
    if (this.options.read_only) {
      throw error(
        "read_only_project",
        "当前项目以只读方式打开。",
        "Cannot write a read-only project",
        {
          recoverable: false,
          recommended_action: "切换到编辑模式后重试。",
          details: {},
        },
      );
    }
    if (!this.lock) {
      throw error(
        "project_not_open",
        "项目尚未以编辑模式打开。",
        "A writable project lock is required before writing",
        {
          recoverable: true,
          recommended_action: "先打开项目后重试。",
          details: {},
        },
      );
    }
  }

  private async assertWritableLease(): Promise<void> {
    this.assertWritableLeaseConfigured();
    const ownedLock = this.lock;
    if (!ownedLock) return;
    const current = await this.readLock();
    if (!current || current.app_instance_id !== ownedLock.app_instance_id) {
      if (this.lockTimer !== null) clearInterval(this.lockTimer);
      this.lockTimer = null;
      this.lock = null;
      throw error(
        "project_lock_lost",
        "项目编辑锁已失效，请重新打开项目。",
        "The project lock is no longer owned by this instance",
        {
          recoverable: true,
          recommended_action: "重新打开项目。",
          details: {},
        },
      );
    }
  }

  private async assertMutationBaseline(
    binding: ProjectSaveBinding,
    projectId: string,
    stage: string,
  ): Promise<FileFingerprint> {
    await this.assertWritableLease();
    if (binding.lease_generation !== this.leaseGeneration) {
      throw error(
        "project_lock_lost",
        "项目编辑租约已变化，文件操作已暂停。",
        "Canonical mutation lease generation no longer matches the active writer",
        { recoverable: false, recommended_action: null, details: { stage: "lease_validate", commit_state: "not_committed", retryable: false } },
      );
    }
    const activeProjectId = this.baselineProject?.project.id ?? null;
    if (
      !activeProjectId || activeProjectId !== projectId ||
      projectId !== binding.expected_project_id
    ) {
      throw error(
        "project_id_mismatch",
        "文件操作与当前课程身份不匹配。",
        "Canonical mutation owner identity does not match the active project",
        { recoverable: false, recommended_action: null, details: { stage: "project_identity", commit_state: "not_committed", retryable: false } },
      );
    }
    const current = await fileFingerprint(this.projectPath);
    if (fingerprintsDiffer(binding.expected_fingerprint, current)) {
      throw error(
        "external_modification_conflict",
        "课程文件已发生变化，文件操作已暂停，请重新读取后重试。",
        "Canonical mutation expected fingerprint does not match disk",
        { recoverable: false, recommended_action: null, details: { stage, commit_state: "not_committed", retryable: false, fingerprint: current } },
      );
    }
    return current;
  }

  private async withLockGuard<T>(operation: () => Promise<T>): Promise<T> {
    const guardPath = this.path(LOCK_GUARD_FILE);
    const guard = await Deno.open(guardPath, {
      create: true,
      read: true,
      write: true,
    });
    try {
      await guard.lock();
      return await operation();
    } finally {
      try {
        await guard.unlock();
      } catch {
        // The OS releases the advisory lock when the descriptor closes.
      }
      guard.close();
    }
  }

  private async withWritableLease<T>(operation: () => Promise<T>): Promise<T> {
    this.assertWritableLeaseConfigured();
    return await this.withLockGuard(async () => {
      await this.assertWritableLease();
      return await operation();
    });
  }

  async ensureDirectory(): Promise<void> {
    // Validate the selected project root before mkdir/stat can follow it.
    this.path(".workspace");
    if (this.options.read_only) {
      const stat = await Deno.stat(this.directory);
      if (!stat.isDirectory) throw new Error("项目目录不是文件夹");
      return;
    }
    await Deno.mkdir(this.workspacePath, { recursive: true });
  }

  async open(): Promise<void> {
    await this.ensureDirectory();
    if (!this.options.read_only) await this.acquireLock();
    let projectExists = false;
    try {
      await Deno.stat(this.projectPath);
      projectExists = true;
    } catch (caught) {
      if (!isNotFound(caught)) {
        await this.close();
        throw caught;
      }
    }
    if (projectExists) {
      try {
        const opened = await readProjectState(this.projectPath);
        const original = opened.original;
        const migrated = opened.project;
        this.baseline = opened.fingerprint;
        this.baselineProject = clone(migrated);
        if (
          !this.options.read_only &&
          JSON.stringify(original) !== JSON.stringify(migrated)
        ) await this.migrate();
      } catch (caught) {
        // Keep the original file intact when migration/validation fails. The
        // caller still receives the structured failure while the lock closes.
        await this.close();
        throw caught;
      }
    } else this.baselineProject = null;
  }

  async close(): Promise<void> {
    if (this.lockTimer !== null) clearInterval(this.lockTimer);
    this.lockTimer = null;
    if (!this.lock) return;
    try {
      await this.withLockGuard(async () => {
        const current = await this.readLock();
        if (current?.app_instance_id === this.lock?.app_instance_id) {
          await Deno.remove(this.lockPath);
        }
      });
    } catch (caught) {
      if (!isNotFound(caught)) throw caught;
    } finally {
      this.lock = null;
    }
  }

  private async readLock(): Promise<ProjectLock | null> {
    // Heartbeats update the lock in place while holding a file handle.  A
    // concurrent reader may observe the tiny truncate/write window; retry it
    // instead of treating a transient partial JSON value as lock loss.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return JSON.parse(
          await Deno.readTextFile(this.lockPath),
        ) as ProjectLock;
      } catch (caught) {
        if (isNotFound(caught)) return null;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  private lockHeartbeatMillis(lock: ProjectLock | null): number | null {
    const value = lock?.heartbeat;
    const heartbeat = typeof value === "string" ? value.trim() : null;
    const match = heartbeat
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/.exec(heartbeat)
      : null;
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const fraction = match[7] || "";
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const maxDay = daysInMonth[month - 1];
    if (
      year < 1970 || maxDay === undefined || day < 1 || day > maxDay ||
      hour > 23 || minute > 59 || second > 59
    ) return null;
    const millis = Number(fraction.slice(0, 3).padEnd(3, "0")) || 0;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, millis);
    if (
      !Number.isFinite(date.getTime()) ||
      date.getTime() < 0 ||
      date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second ||
      date.getUTCMilliseconds() !== millis
    ) return null;
    return date.getTime();
  }

  isLockStale(
    lock: ProjectLock | null,
    at = Date.now(),
    mtimeMs: number | null = null,
  ): boolean {
    const heartbeat = this.lockHeartbeatMillis(lock);
    if (heartbeat !== null) return at - heartbeat > this.options.stale_after_ms;
    return mtimeMs === null
      ? !lock
      : at - mtimeMs > this.options.stale_after_ms;
  }

  async acquireLock(): Promise<ProjectLock> {
    await this.ensureDirectory();
    return await this.withLockGuard(async () => {
      const existing = await this.readLock();
      const lockStat = await Deno.stat(this.lockPath).catch((caught) => {
        if (isNotFound(caught)) return null;
        throw caught;
      });
      const lockMtimeMs = lockStat?.mtime?.getTime() ?? null;
      if (!existing && lockStat && !this.options.force_takeover &&
        !this.isLockStale(null, Date.now(), lockMtimeMs)) {
        throw new ServiceError({
          code: "project_locked",
          user_message: "这个项目正在其他窗口或进程中使用。为避免覆盖，当前操作没有写入；现有课程内容没有改变。",
          technical_message:
            "Project lock is currently being written or is malformed",
          recoverable: true,
          recommended_action: "关闭其他窗口后重试；如果确认无人使用，再重新打开项目。",
          details: {},
        });
      }
      if (
        existing && existing.app_instance_id !== this.options.app_instance_id &&
        !this.isLockStale(existing, Date.now(), lockMtimeMs) &&
        !this.options.force_takeover
      ) {
        throw new ServiceError({
          code: "project_locked",
          user_message: "这个项目正在其他窗口或进程中使用。为避免覆盖，当前操作没有写入；现有课程内容没有改变。",
          technical_message: `Project lock held by ${existing.app_instance_id}`,
          recoverable: true,
          recommended_action: "关闭其他窗口后重试；如果确认无人使用，再重新打开项目。",
          details: {
            app_instance_id: existing.app_instance_id,
            heartbeat: existing.heartbeat,
          },
        });
      }
      if (existing || lockStat) {
        try {
          await Deno.remove(this.lockPath);
        } catch (caught) {
          if (!isNotFound(caught)) throw caught;
        }
      }
      const lock: ProjectLock = {
      app_instance_id: this.options.app_instance_id,
      generation: crypto.randomUUID(),
      pid: Deno.pid,
      host: (() => {
        try {
          return typeof Deno.hostname === "function"
            ? Deno.hostname()
            : "localhost";
        } catch {
          return "localhost";
        }
      })(),
      opened_at: now(),
      heartbeat: now(),
      };
      try {
      const file = await Deno.open(this.lockPath, {
        createNew: true,
        write: true,
      });
      try {
        const bytes = new TextEncoder().encode(JSON.stringify(lock));
        let offset = 0;
        while (offset < bytes.length) {
          offset += await file.write(bytes.subarray(offset));
        }
        await file.sync();
      } finally {
        file.close();
      }
      } catch (caught) {
      if (caught instanceof Deno.errors.AlreadyExists) {
        throw new ServiceError({
          code: "project_locked",
          user_message: "这个项目正在其他窗口或进程中使用。为避免覆盖，当前操作没有写入；现有课程内容没有改变。",
          technical_message: "Lock acquisition race",
          recoverable: true,
          recommended_action: "关闭其他窗口后重试；如果确认无人使用，再重新打开项目。",
          details: {},
        });
      }
      throw caught;
      }
      this.lock = lock;
      this.lockTimer = setInterval(() => {
        void this.heartbeat().catch(() => undefined);
      }, this.options.heartbeat_ms);
      return structuredClone(lock);
    });
  }

  async heartbeat(): Promise<void> {
    if (!this.lock) return;
    await this.withLockGuard(async () => {
    const ownedLock = this.lock;
    if (!ownedLock) return;
    let file: Deno.FsFile | null = null;
    try {
      // Keep the lock file handle open while checking and updating it.  A
      // force takeover removes this inode before creating the new lock, so a
      // stale instance can never rename over the new owner's lock.
      file = await Deno.open(this.lockPath, { read: true, write: true });
      const stat = await file.stat();
      const bytes = new Uint8Array(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes.subarray(offset));
        if (read === null) break;
        offset += read;
      }
      const current = JSON.parse(
        new TextDecoder().decode(bytes.subarray(0, offset)),
      ) as ProjectLock;
      if (current.app_instance_id !== ownedLock.app_instance_id) {
        if (this.lockTimer !== null) clearInterval(this.lockTimer);
        this.lockTimer = null;
        this.lock = null;
        return;
      }
      ownedLock.heartbeat = now();
      const encoded = new TextEncoder().encode(JSON.stringify(ownedLock));
      await file.truncate(0);
      await file.seek(0, Deno.SeekMode.Start);
      let written = 0;
      while (written < encoded.length) {
        written += await file.write(encoded.subarray(written));
      }
      await file.sync();
    } catch (caught) {
      if (!isNotFound(caught)) throw caught;
      if (this.lockTimer !== null) clearInterval(this.lockTimer);
      this.lockTimer = null;
      this.lock = null;
    } finally {
      file?.close();
    }
    });
  }

  async inspectLock(): Promise<{ lock: ProjectLock | null; stale: boolean }> {
    const lock = await this.readLock();
    const stat = await Deno.stat(this.lockPath).catch((caught) => {
      if (isNotFound(caught)) return null;
      throw caught;
    });
    return {
      lock,
      stale: this.isLockStale(lock, Date.now(), stat?.mtime?.getTime() ?? null),
    };
  }

  async readProjectState(): Promise<{
    project: ProjectData | null;
    fingerprint: FileFingerprint;
  }> {
    return await this.withLockGuard(async () => {
      try {
        const state = await readProjectState(this.projectPath);
        this.baseline = state.fingerprint;
        this.baselineProject = clone(state.project);
        return { project: state.project, fingerprint: state.fingerprint };
      } catch (caught) {
        if (!isNotFound(caught)) throw caught;
        const fingerprint = await fileFingerprint(this.projectPath);
        if (fingerprint.exists) {
          const state = await readProjectState(this.projectPath);
          this.baseline = state.fingerprint;
          this.baselineProject = clone(state.project);
          return { project: state.project, fingerprint: state.fingerprint };
        }
        this.baseline = null;
        this.baselineProject = null;
        return { project: null, fingerprint };
      }
    });
  }

  /** Pure canonical snapshot read; it never adopts a save baseline or creates a lease. */
  async readProjectSnapshot(): Promise<{
    project: ProjectData | null;
    fingerprint: FileFingerprint;
  }> {
    assertNoSymlink(this.directory, this.projectPath);
    try {
      const stat = await Deno.lstat(this.projectPath);
      if (!stat.isFile) {
        throw error(
          "invalid_project_path",
          "项目文件路径无效。",
          `Canonical project path is not a regular file: ${this.projectPath}`,
          { recoverable: false, recommended_action: null, details: {} },
        );
      }
      const state = await readProjectState(this.projectPath);
      return { project: state.project, fingerprint: state.fingerprint };
    } catch (caught) {
      if (!isNotFound(caught)) throw caught;
      const fingerprint = await fileFingerprint(this.projectPath);
      if (fingerprint.exists) {
        const state = await readProjectState(this.projectPath);
        return { project: state.project, fingerprint: state.fingerprint };
      }
      return { project: null, fingerprint };
    }
  }

  async readProject(): Promise<ProjectData> {
    const state = await this.readProjectState();
    if (!state.project) throw new Deno.errors.NotFound("project.json is missing");
    return state.project;
  }

  async writeProject(
    data: ProjectData,
    options: { allow_external_overwrite?: boolean } = {},
  ): Promise<ProjectWriteResult> {
    return await this.withWritableLease(() =>
      this.writeProjectUnlocked(data, options)
    );
  }

  private async writeProjectUnlocked(
    data: ProjectData,
    options: {
      allow_external_overwrite?: boolean;
      expected_current?: FileFingerprint;
    } = {},
  ): Promise<ProjectWriteResult> {
    await this.ensureDirectory();
    const externalState = await this.externalChange();
    if (
      options.expected_current &&
      fingerprintsDiffer(options.expected_current, externalState.current)
    ) {
      throw error(
        "external_modification_conflict",
        "处理期间课程文件又发生了变化，当前选择没有写入。请重新查看最新版本后再试。",
        "Canonical changed after explicit project.resolve preflight",
        { recoverable: false, recommended_action: null, details: { stage: "final_recheck", commit_state: "not_committed", retryable: false, expected: options.expected_current, current: externalState.current } },
      );
    }
    if (
      !options.allow_external_overwrite &&
      (externalState.changed ||
        (!externalState.baseline && externalState.current.exists))
    ) {
      throw error(
        "external_modification_conflict",
        "课程文件在其他地方发生了变化，保存已暂停以免覆盖内容。课程内容没有改变，你可以继续查看；请重新载入、自动合并，或明确保留本地版本。",
        "Refusing to overwrite an externally modified canonical project",
        {
          recoverable: true,
          recommended_action: "查看差异，然后重新载入或合并修改。",
          details: {
            baseline: externalState.baseline,
            current: externalState.current,
          },
        },
      );
    }
    const contents = serializeProject(data);
    const bytes = new TextEncoder().encode(contents);
    let written: AtomicTextWriteResult;
    try {
      written = await this.writeAtomicText(PROJECT_FILE, contents, true);
    } catch (caught) {
      const details = caught instanceof ServiceError ? caught.error.details : {};
      if (details.commit_state !== "outcome_uncertain") throw caught;

      // A failed rename acknowledgement can happen after the filesystem moved
      // the staged file. Resolve that one ambiguous boundary from Canonical's
      // actual bytes; never ask the caller to blindly replay a committed write.
      const actual = await this.readProjectSnapshot().catch(() => null);
      const expectedHash = await sha256Bytes(bytes);
      if (
        actual?.project?.project.id === data.project.id &&
        actual.project.project.updated_at === data.project.updated_at &&
        actual.fingerprint.size === bytes.byteLength &&
        actual.fingerprint.hash === expectedHash
      ) {
        written = {
          mtime_ms: actual.fingerprint.mtime_ms,
          durability_warning: "保存已提交，但文件系统未确认原子替换结果。",
        };
      } else {
        throw writeFailure(
          caught,
          PROJECT_FILE,
          String(details.stage ?? "promote"),
          actual && this.baseline &&
              !fingerprintsDiffer(actual.fingerprint, this.baseline)
            ? "not_committed"
            : "outcome_uncertain",
        );
      }
    }
    this.baseline = {
      exists: true,
      mtime_ms: written.mtime_ms,
      size: bytes.length,
      hash: await sha256Bytes(bytes),
    };
    this.baselineProject = clone(migrateProject(data));
    return {
      fingerprint: clone(this.baseline),
      durability_warning: written.durability_warning,
    };
  }

  private async writeAtomicText(
    relativePath: string,
    contents: string,
    keepBackup = true,
  ): Promise<AtomicTextWriteResult> {
    const target = this.path(relativePath);
    const temporary = `${target}.tmp-${id()}`;
    const backup = `${target}.bak`;
    const backupTemporary = `${backup}.tmp-${id()}`;
    let stage = "directory_create";
    let promoted = false;
    let temporaryCreated = false;
    let backupTemporaryCreated = false;
    try {
      assertNoSymlink(this.directory, target);
      await Deno.mkdir(dirname(target), { recursive: true });
      assertNoSymlink(this.directory, target);
      stage = "temp_write";
      await writeBytesSyncSafe(
        temporary,
        new TextEncoder().encode(contents),
        () => temporaryCreated = true,
        relativePath === PROJECT_FILE,
        relativePath === JOURNAL_FILE,
      );
      stage = "temp_verify";
      const stagedStat = await Deno.stat(temporary);
      stage = "validate";
      const parsed = JSON.parse(contents);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("JSON root must be object");
      }
      if (keepBackup) {
        stage = "backup";
        assertNoSymlink(this.directory, backup);
        try {
          await copyFileSyncSafe(
            target,
            backupTemporary,
            () => backupTemporaryCreated = true,
            relativePath === PROJECT_FILE,
          );
          assertNoSymlink(this.directory, backup);
          await Deno.rename(backupTemporary, backup);
          if (relativePath === PROJECT_FILE && storageIoDiagnosticsEnabled) {
            storageIoMetrics.project_backup_renames += 1;
          }
          backupTemporaryCreated = false;
        } catch (caught) {
          if (!isNotFound(caught)) throw caught;
        }
      }
      stage = "promote";
      await Deno.rename(temporary, target);
      promoted = true;
      if (relativePath === PROJECT_FILE && storageIoDiagnosticsEnabled) {
        storageIoMetrics.project_promotions += 1;
        storageIoMetrics.project_directory_sync_attempts += 1;
      }
      if (relativePath === JOURNAL_FILE && storageIoDiagnosticsEnabled) {
        storageIoMetrics.recovery_journal_promotions += 1;
        storageIoMetrics.recovery_directory_sync_attempts += 1;
      }
      const durability_warning = await syncDirectoryPath(dirname(target))
        ? null
        : "文件已写入，但目录元数据同步失败。";
      if (relativePath === PROJECT_FILE && storageIoDiagnosticsEnabled && !durability_warning) {
        storageIoMetrics.project_directory_sync_successes += 1;
      }
      if (relativePath === JOURNAL_FILE && storageIoDiagnosticsEnabled && !durability_warning) {
        storageIoMetrics.recovery_directory_sync_successes += 1;
      }
      return {
        mtime_ms: stagedStat.mtime?.getTime() ?? null,
        durability_warning,
      };
    } catch (caught) {
      const ownedPaths = [
        ...(temporaryCreated ? [temporary] : []),
        ...(backupTemporaryCreated ? [backupTemporary] : []),
      ];
      for (const ownedPath of ownedPaths) {
        try {
          await Deno.remove(ownedPath);
        } catch (cleanup) {
          if (!isNotFound(cleanup)) void cleanup;
        }
      }
      throw writeFailure(
        caught,
        relativePath,
        stage,
        promoted ? "committed" : stage === "promote"
          ? "outcome_uncertain"
          : "not_committed",
      );
    }
  }

  async writeRecoveryJournal(journal: RecoveryJournal): Promise<void> {
    await this.withWritableLease(async () => {
      // Validate before the journal is written. Otherwise a later canonical
      // write rejection could leave credentials in recovery.json.
      serializeProject(journal.project);
      await this.writeAtomicText(JOURNAL_FILE, JSON.stringify(journal), false);
    });
  }

  /** Crash boundary: write the last canonical state before the shell exits. */
  async writeFatalRecoveryJournal(data: ProjectData): Promise<void> {
    const canonical = migrateProject(JSON.parse(serializeProject(data)));
    await this.writeRecoveryJournal({
      transaction_id: id(),
      project_id: canonical.project.id,
      canonical_revision: canonical.project.updated_at,
      saved_at: now(),
      project: clone(canonical),
    });
  }

  async readRecoveryJournal(
    canonicalProject?: ProjectData | null,
  ): Promise<RecoveryJournal | null> {
    try {
      const journal = JSON.parse(
        await Deno.readTextFile(this.journalPath),
      ) as RecoveryJournal;
      if (journal && typeof journal === "object" && journal.project) {
        serializeProject(journal.project);
      }
      const canonical = canonicalProject === undefined
        ? (await this.readProjectSnapshot()).project
        : canonicalProject;
      if (
        canonical && journal?.project &&
        journal.project_id === canonical.project.id &&
        journal.canonical_revision === canonical.project.updated_at &&
        serializeProject(journal.project) === serializeProject(canonical)
      ) {
        // A post-commit cleanup failure can leave this journal behind. Keep the
        // file for diagnosis/recovery, but don't offer content already committed.
        return null;
      }
      return journal;
    } catch (caught) {
      if (isNotFound(caught)) return null;
      throw caught;
    }
  }

  async clearRecoveryJournal(
    binding: ProjectSaveBinding,
    expectedTransactionId: string,
  ): Promise<{
    cleared: boolean;
    transaction_id: string | null;
    durability_warning: string | null;
    fingerprint: FileFingerprint;
  }> {
    return await this.withWritableLease(async () => {
      const fingerprint = await this.assertMutationBaseline(
        binding,
        binding.expected_project_id,
        "recovery_clear",
      );
      const target = this.path(JOURNAL_FILE);
      let journal: RecoveryJournal;
      try {
        journal = JSON.parse(await Deno.readTextFile(target)) as RecoveryJournal;
      } catch (caught) {
        if (isNotFound(caught)) {
          return {
            cleared: false,
            transaction_id: null,
            durability_warning: null,
            fingerprint,
          };
        }
        throw caught;
      }
      if (
        !journal || typeof journal !== "object" ||
        journal.transaction_id !== expectedTransactionId ||
        journal.project_id !== binding.expected_project_id
      ) {
        throw error(
          "recovery_journal_mismatch",
          "恢复记录已变化，请重新打开课程后选择处理方式。",
          "Recovery clear request does not match the visible pending journal",
          { recoverable: false, recommended_action: null, details: { stage: "recovery_binding", commit_state: "not_committed", retryable: false } },
        );
      }
      await Deno.remove(target);
      const durability_warning = await syncDirectoryPath(dirname(target))
        ? null
        : "恢复记录已清除，但目录元数据同步失败。";
      return {
        cleared: true,
        transaction_id: journal.transaction_id,
        durability_warning,
        fingerprint,
      };
    });
  }

  async saveWithRecovery(
    data: ProjectData,
    expectedFingerprint?: FileFingerprint,
    options: { allow_project_identity_change?: boolean } = {},
  ): Promise<{
    project: ProjectData;
    fingerprint: FileFingerprint;
    recovery_warning: string | null;
    durability_warning: string | null;
  }> {
    const canonical = migrateProject(JSON.parse(serializeProject(data)));
    const journal: RecoveryJournal = {
      transaction_id: id(),
      project_id: canonical.project.id,
      canonical_revision: canonical.project.updated_at,
      saved_at: now(),
      project: clone(canonical),
    };
    return await this.withWritableLease(async () => {
      const current = await fileFingerprint(this.projectPath);
      if (expectedFingerprint && fingerprintsDiffer(expectedFingerprint, current)) {
        throw error(
          "external_modification_conflict",
          "课程文件已由另一个写入更新，保存已暂停以免覆盖内容。请重新载入或合并修改。",
          "Refusing project save from a stale loaded fingerprint",
          {
            recoverable: true,
            recommended_action: "重新载入磁盘版本或合并修改后再保存。",
            details: { baseline: expectedFingerprint, current },
          },
        );
      }
      const externalState = await this.externalChange();
      if (
        externalState.changed ||
        (!externalState.baseline && externalState.current.exists)
      ) {
        throw error(
          "external_modification_conflict",
          "课程文件在其他地方发生了变化，自动保存已暂停以免覆盖内容。课程内容没有改变，你可以继续查看；请处理保存提示后再继续。",
          "Refusing autosave after an external canonical modification",
          {
            recoverable: true,
            recommended_action: "查看差异，然后重新载入或合并修改。",
            details: {
              baseline: externalState.baseline,
              current: externalState.current,
            },
          },
        );
      }
      if (
        !options.allow_project_identity_change &&
        this.baselineProject &&
        canonical.project.id !== this.baselineProject.project.id
      ) {
        throw error(
          "project_id_mismatch",
          "保存请求与当前课程身份不匹配。",
          "Refusing legacy project.save for a different baseline project",
          {
            recoverable: false,
            recommended_action: null,
            details: {
              stage: "project_identity",
              commit_state: "not_committed",
              retryable: false,
            },
          },
        );
      }
      // The compare and both writes share one OS lock. A sibling service
      // command cannot advance the canonical file between the CAS and rename.
      const journalWrite = await this.writeAtomicText(
        JOURNAL_FILE,
        JSON.stringify(journal),
        false,
      );
      const projectWrite = await this.writeProjectUnlocked(canonical);
      let recoveryWarning: string | null = null;
      let durabilityWarning = projectWrite.durability_warning ??
        journalWrite.durability_warning;
      try {
        if (storageIoDiagnosticsEnabled) {
          storageIoMetrics.recovery_journal_removal_attempts += 1;
        }
        await Deno.remove(this.journalPath);
        if (storageIoDiagnosticsEnabled) {
          storageIoMetrics.recovery_journal_removal_successes += 1;
        }
      } catch (caught) {
        if (!isNotFound(caught)) {
          recoveryWarning = "恢复日志清理失败，但课程内容已经保存。";
        }
      }
      if (!recoveryWarning) {
        if (storageIoDiagnosticsEnabled) {
          storageIoMetrics.recovery_directory_sync_attempts += 1;
        }
        if (!await syncDirectoryPath(this.workspacePath)) {
          durabilityWarning = durabilityWarning
            ? `${durabilityWarning}恢复目录元数据同步失败。`
            : "课程已保存，但恢复目录元数据同步失败。";
        } else if (storageIoDiagnosticsEnabled) {
          storageIoMetrics.recovery_directory_sync_successes += 1;
        }
      }
      return {
        project: clone(canonical),
        fingerprint: projectWrite.fingerprint,
        recovery_warning: recoveryWarning,
        durability_warning: durabilityWarning,
      };
    });
  }

  async saveBound(
    data: ProjectData,
    binding: ProjectSaveBinding,
  ): Promise<{
    project: ProjectData;
    fingerprint: FileFingerprint;
    recovery_warning: string | null;
    durability_warning: string | null;
    outcome: "written" | "unchanged";
  }> {
    const fail = (
      caught: unknown,
      stage: string,
      commitState: "not_committed" | "outcome_uncertain" | "committed",
      retryable: boolean,
    ): never => {
      const details = {
        ...(caught instanceof ServiceError ? caught.error.details : {}),
        stage,
        commit_state: commitState,
        retryable,
        project_id: binding.expected_project_id,
        project_dir: this.directory,
        editor_generation: binding.editor_generation,
        operation_id: binding.operation_id,
        revision: binding.revision,
        expected_hash: binding.expected_fingerprint.hash,
        ...(caught instanceof ServiceError && caught.error.details.fingerprint
          ? { fingerprint: caught.error.details.fingerprint }
          : {}),
      };
      if (caught instanceof ServiceError) {
        throw new ServiceError({ ...caught.error, details });
      }
      throw new ServiceError({
        code: "project_save_failed",
        user_message: "保存没有完成，请检查保存状态后重试。",
        technical_message: caught instanceof Error ? caught.message : String(caught),
        recoverable: retryable,
        details,
      });
    };

    let canonicalCommitted = false;
    try {
      return await this.withWritableLease(async () => {
        if (!binding.lease_generation || binding.lease_generation !== this.leaseGeneration) {
          throw error(
            "project_lock_lost",
            "项目编辑租约已变化，保存已暂停。",
            "project.save lease generation does not match the active writer lease",
            { recoverable: false, recommended_action: null, details: { stage: "lease_validate", commit_state: "not_committed", retryable: false } },
          );
        }
        const canonical = migrateProject(JSON.parse(serializeProject(data)));
        const activeProjectId = this.baselineProject?.project.id ?? null;
        if (
          !activeProjectId || binding.expected_project_id !== activeProjectId ||
          canonical.project.id !== activeProjectId
        ) {
          throw error(
            "project_id_mismatch",
            "保存请求与当前课程身份不匹配。",
            "project.save owner identity does not match the active canonical project",
            { recoverable: false, recommended_action: null, details: { stage: "project_identity", commit_state: "not_committed", retryable: false } },
          );
        }
        const expectedRecovery = binding.recovery_metadata;
        if (
          expectedRecovery && typeof expectedRecovery === "object" &&
          "project_id" in expectedRecovery &&
          (expectedRecovery as { project_id?: unknown }).project_id !== activeProjectId
        ) {
          throw error(
            "project_id_mismatch",
            "保存恢复元数据与当前课程身份不匹配。",
            "project.save recovery metadata owner does not match the active project",
            { recoverable: false, recommended_action: null, details: { stage: "recovery_validate", commit_state: "not_committed", retryable: false } },
          );
        }
        const current = await fileFingerprint(this.projectPath);
        if (fingerprintsDiffer(binding.expected_fingerprint, current)) {
          // An ACK can be lost after an atomic promote. If the current
          // Canonical bytes are exactly the requested project, the retry is
          // already satisfied; return that receipt without rewriting it.
          const actual = await this.readProjectSnapshot().catch(() => null);
          if (
            actual?.project?.project.id === canonical.project.id &&
            serializeProject(actual.project) === serializeProject(canonical)
          ) {
            this.baseline = structuredClone(actual.fingerprint);
            this.baselineProject = clone(actual.project);
            return {
              project: clone(actual.project),
              fingerprint: structuredClone(actual.fingerprint),
              recovery_warning: null,
              durability_warning: null,
              outcome: "unchanged",
            };
          }
          throw error(
            "external_modification_conflict",
            "课程文件已由另一个写入更新，保存已暂停以免覆盖内容。请重新载入或合并修改。",
            "Refusing project save from a stale loaded fingerprint",
            { recoverable: true, recommended_action: null, details: { stage: "fingerprint_preflight", commit_state: "not_committed", retryable: false, fingerprint: current } },
          );
        }
        if (
          !this.baseline ||
          fingerprintsDiffer(this.baseline, current)
        ) {
          throw error(
            "external_modification_conflict",
            "课程文件在其他地方发生了变化，保存已暂停以免覆盖内容。",
            "Refusing project save from a stale service baseline",
            { recoverable: true, recommended_action: null, details: { stage: "baseline_preflight", commit_state: "not_committed", retryable: false, fingerprint: current } },
          );
        }
        if (
          this.baselineProject &&
          serializeProject(canonical) === serializeProject(this.baselineProject)
        ) {
          return {
            project: clone(canonical),
            fingerprint: structuredClone(current),
            recovery_warning: null,
            durability_warning: null,
            outcome: "unchanged",
          };
        }
        const journal: RecoveryJournal = {
          transaction_id: binding.operation_id,
          project_id: canonical.project.id,
          canonical_revision: canonical.project.updated_at,
          saved_at: now(),
          project: clone(canonical),
        };
        let journalWrite!: AtomicTextWriteResult;
        try {
          journalWrite = await this.writeAtomicText(
            JOURNAL_FILE,
            JSON.stringify(journal),
            false,
          );
        } catch (caught) {
          const details = caught instanceof ServiceError
            ? caught.error.details
            : {};
          fail(
            caught,
            String(details.stage ?? "recovery_write"),
            details.commit_state === "outcome_uncertain"
              ? "outcome_uncertain"
              : "not_committed",
            details.retryable === true,
          );
        }
        let projectWrite!: ProjectWriteResult;
        try {
          projectWrite = await this.writeProjectUnlocked(canonical);
          canonicalCommitted = true;
        } catch (caught) {
          const details = caught instanceof ServiceError
            ? caught.error.details
            : {};
          fail(
            caught,
            String(details.stage ?? "canonical_write"),
            details.commit_state === "committed"
              ? "committed"
              : details.commit_state === "not_committed"
              ? "not_committed"
              : "outcome_uncertain",
            details.retryable === true,
          );
        }
        const fingerprint = projectWrite.fingerprint;
        this.baseline = structuredClone(fingerprint);
        this.baselineProject = clone(canonical);
        let durabilityWarning = projectWrite.durability_warning ??
          journalWrite.durability_warning;
        let recoveryWarning: string | null = null;
        try {
          if (storageIoDiagnosticsEnabled) {
            storageIoMetrics.recovery_journal_removal_attempts += 1;
          }
          await Deno.remove(this.journalPath);
          if (storageIoDiagnosticsEnabled) {
            storageIoMetrics.recovery_journal_removal_successes += 1;
          }
        } catch (caught) {
          if (!isNotFound(caught)) {
            recoveryWarning = "恢复日志清理失败，但课程内容已经保存。";
          }
        }
        if (!recoveryWarning) {
          if (storageIoDiagnosticsEnabled) {
            storageIoMetrics.recovery_directory_sync_attempts += 1;
          }
          if (!await syncDirectoryPath(this.workspacePath)) {
            durabilityWarning = durabilityWarning
              ? `${durabilityWarning}恢复目录元数据同步失败。`
              : "课程已保存，但恢复目录元数据同步失败。";
          } else if (storageIoDiagnosticsEnabled) {
            storageIoMetrics.recovery_directory_sync_successes += 1;
          }
        }
        return {
          project: clone(canonical),
          fingerprint,
          recovery_warning: recoveryWarning,
          durability_warning: durabilityWarning,
          outcome: "written",
        };
      });
    } catch (caught) {
      if (caught instanceof ServiceError && caught.error.details.commit_state) throw caught;
      const retryable = !canonicalCommitted && (
        (caught instanceof ServiceError && caught.error.details.retryable === true) ||
        isSafeRetryableWriteFailure(caught)
      );
      return fail(
        caught,
        "save_preflight",
        canonicalCommitted ? "committed" : "not_committed",
        retryable,
      );
    }
  }

  async externalChange(): Promise<
    {
      changed: boolean;
      baseline: FileFingerprint | null;
      current: FileFingerprint;
    }
  > {
    const current = await fileFingerprint(this.projectPath);
    const baseline = this.baseline;
    const changed = baseline
      ? fingerprintsDiffer(baseline, current)
      : current.exists;
    return { changed, baseline, current };
  }

  /** Read the external branch without overwriting local in-memory edits. */
  async inspectExternalModification(
    localProject: ProjectData | null = null,
  ): Promise<ExternalModificationReport> {
    const current = await fileFingerprint(this.projectPath);
    const baseline = this.baseline;
    const changed = baseline
      ? fingerprintsDiffer(baseline, current)
      : current.exists;
    let external: ProjectData | null = null;
    if (current.exists) {
      try {
        external = await loadProject(this.projectPath);
      } catch {
        // The caller still receives changed=true and can show the file-level
        // failure without replacing the in-memory project.
        external = null;
      }
    }
    const baselineProject = this.baselineProject;
    return {
      changed,
      baseline,
      current,
      external,
      external_diff: baselineProject && external
        ? diffProjectData(baselineProject, external)
        : { changed, entries: [] },
      local_diff: baselineProject && localProject
        ? diffProjectData(baselineProject, localProject)
        : null,
    };
  }

  detectExternalModification(
    localProject: ProjectData | null = null,
  ): Promise<ExternalModificationReport> {
    return this.inspectExternalModification(localProject);
  }

  /**
   * Build a three-way merge branch.  It intentionally does not write: callers
   * must inspect conflicts, then call writeProject with the selected result.
   */
  async mergeExternalChanges(localProject: ProjectData): Promise<MergeResult> {
    const report = await this.inspectExternalModification(localProject);
    if (!report.external) throw new Error("外部项目文件无法读取或校验");
    if (!this.baselineProject) {
      return { merged: clone(report.external), conflicts: [], can_apply: true };
    }
    return mergeProjectData(
      this.baselineProject,
      localProject,
      report.external,
    );
  }

  mergeExternal(localProject: ProjectData): Promise<MergeResult> {
    return this.mergeExternalChanges(localProject);
  }

  /** Explicitly accept the inspected disk revision and write a resolved branch. */
  async resolveExternalChanges(
    resolvedProject: ProjectData,
    expectedCurrent: FileFingerprint,
    binding?: ProjectSaveBinding,
  ): Promise<ProjectWriteResult> {
    return await this.withWritableLease(async () => {
      const current = await fileFingerprint(this.projectPath);
      if (
        fingerprintsDiffer(expectedCurrent, current) ||
        (binding &&
          fingerprintsDiffer(binding.expected_fingerprint, expectedCurrent))
      ) {
        throw error(
          "external_modification_conflict",
          "处理期间课程文件又发生了变化，当前选择没有写入。请重新查看最新版本后再试。",
          "External canonical changed while conflict resolution was pending",
          {
            recoverable: false,
            recommended_action: null,
            details: { stage: "fingerprint_preflight", commit_state: "not_committed", retryable: false, expected: expectedCurrent, current },
          },
        );
      }
      const external = current.exists ? await loadProject(this.projectPath) : null;
      if (
        binding &&
        (!binding.lease_generation || binding.lease_generation !== this.leaseGeneration ||
          external?.project.id !== binding.expected_project_id ||
          resolvedProject.project.id !== binding.expected_project_id)
      ) {
        throw error(
          "project_id_mismatch",
          "冲突处理请求与当前课程身份不匹配。",
          "project.resolve owner identity or lease changed before write",
          { recoverable: false, recommended_action: null, details: { stage: "project_identity", commit_state: "not_committed", retryable: false } },
        );
      }
      // This command is the explicit user decision to accept the inspected
      // external version. Bypass the stale in-memory baseline only after the
      // user-confirmed fingerprint was matched under the writer lock; the
      // successful write itself installs the new baseline.
      return await this.writeProjectUnlocked(resolvedProject, {
        allow_external_overwrite: true,
        expected_current: expectedCurrent,
      });
    });
  }

  /** Diff two persisted file snapshots without exposing Git primitives. */
  async diffSnapshots(
    firstSnapshotId: string,
    secondSnapshotId: string,
  ): Promise<ProjectDiff> {
    const readSnapshot = async (snapshotId: string): Promise<ProjectData> => {
      if (!/^[A-Za-z0-9_-]+$/.test(snapshotId)) {
        throw new Error("历史版本编号无效");
      }
      return await loadProject(
        this.path(
          join(".workspace", "snapshots", `${safeName(snapshotId)}.json`),
        ),
      );
    };
    return diffProjectData(
      await readSnapshot(firstSnapshotId),
      await readSnapshot(secondSnapshotId),
    );
  }

  /** Alias used by high-level snapshot queries. */
  snapshotDiff(
    firstSnapshotId: string,
    secondSnapshotId: string,
  ): Promise<ProjectDiff> {
    return this.diffSnapshots(firstSnapshotId, secondSnapshotId);
  }

  async migrate(): Promise<ProjectData> {
    return await this.withWritableLease(() => this.migrateUnlocked());
  }

  private async migrateUnlocked(): Promise<ProjectData> {
    const original = await Deno.readTextFile(this.projectPath);
    const migrated = migrateProject(JSON.parse(original));
    // All validation happens before the original is touched.
    const migratedText = serializeProject(migrated);
    if (
      JSON.stringify(JSON.parse(original)) !==
        JSON.stringify(JSON.parse(migratedText))
    ) {
      const backup =
        `${PROJECT_FILE}.migration-backup-${Date.now()}-${id()}.json`;
      await Deno.copyFile(this.projectPath, this.path(backup));
      await this.writeAtomicText(PROJECT_FILE, migratedText, true);
    }
    const state = await readProjectState(this.projectPath);
    this.baseline = state.fingerprint;
    this.baselineProject = clone(state.project);
    return state.project;
  }

  async moveToTrash(relativePath: string): Promise<string> {
    return await this.withWritableLease(async () => {
    assertRelative(relativePath);
    if (
      relativePath === PROJECT_FILE || relativePath === ".workspace" ||
      relativePath.startsWith(".workspace/")
    ) {
      throw error(
        "trash_protected",
        "该项目文件不能放入废纸篓。",
        `Protected path: ${relativePath}`,
        { recoverable: false, recommended_action: null, details: {} },
      );
    }
    const source = this.path(relativePath);
    const trash = join(this.directory, ".trash");
    await Deno.mkdir(trash, { recursive: true });
    const destination = join(
      trash,
      `${Date.now()}-${id()}-${safeName(relativePath)}`,
    );
    try {
      await Deno.rename(source, destination);
    } catch (caught) {
      if (isNotFound(caught)) {
        throw error(
          "trash_missing",
          "找不到要移入废纸篓的项目内容。",
          String(caught),
          { recoverable: false, recommended_action: null, details: {} },
        );
      }
      throw caught;
    }
    return destination;
    });
  }

  async createSnapshot(
    data: ProjectData,
    name: string,
    note = "",
    options: { allow_external_overwrite?: boolean } = {},
  ): Promise<Snapshot> {
    return await this.withWritableLease(async () =>
      (await this.createSnapshotUnlocked(data, name, note, options)).snapshot
    );
  }

  /** Store the caller's version copy without changing Canonical. */
  async writeSnapshotCopy(
    snapshotId: string,
    data: ProjectData,
    name = "未命名版本",
    note = "",
  ): Promise<SnapshotCopyWriteResult> {
    if (snapshotId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(snapshotId)) {
      throw error(
        "snapshot_invalid",
        "历史版本编号无效。",
        `Invalid snapshot id: ${snapshotId}`,
        { recoverable: false, recommended_action: null, details: {} },
      );
    }
    const canonical = migrateProject(JSON.parse(serializeProject(data)));
    const contents = serializeProject(canonical);
    return await this.withWritableLease(async () => {
      const externalState = await this.externalChange();
      if (
        externalState.changed ||
        (!externalState.baseline && externalState.current.exists)
      ) {
        throw error(
          "external_modification_conflict",
          "课程文件在其他地方发生了变化，历史版本保存已暂停。请先重新载入或合并修改后再试。",
          "Refusing snapshot copy after external modification",
          {
            recoverable: true,
            recommended_action: "重新载入磁盘版本或合并修改后再保存。",
            details: {
              baseline: externalState.baseline,
              current: externalState.current,
            },
          },
        );
      }
      if (canonical.project.id !== this.baselineProject?.project.id) {
        throw error(
          "project_id_mismatch",
          "历史版本与当前课程身份不匹配。",
          "Refusing to persist a snapshot copy for a different project",
          {
            recoverable: false,
            recommended_action: null,
            details: {
              stage: "project_identity",
              commit_state: "not_committed",
              retryable: false,
            },
          },
        );
      }

      const relativePath = join(
        ".workspace",
        "snapshots",
        snapshotId + ".json",
      );
      const metadataPath = join(
        ".workspace",
        "snapshots",
        snapshotId + ".meta.json",
      );
      const fullPath = this.path(relativePath);
      const metadataFullPath = this.path(metadataPath);
      const bytes = new TextEncoder().encode(contents);
      const contentHash = await sha256Bytes(bytes);
      let existingBytes: Uint8Array | null = null;
      try {
        const stat = await Deno.lstat(fullPath);
        if (!stat.isFile || stat.isSymlink) {
          throw error(
            "invalid_project_path",
            "历史版本文件路径无效。",
            "Snapshot target is not a regular file: " + fullPath,
            { recoverable: false, recommended_action: null, details: {} },
          );
        }
        existingBytes = await Deno.readFile(fullPath);
      } catch (caught) {
        if (!isNotFound(caught)) throw caught;
      }
      if (existingBytes && await sha256Bytes(existingBytes) !== contentHash) {
        throw error(
          "snapshot_id_conflict",
          "这个历史版本编号已经用于其他内容。",
          "Snapshot id " + snapshotId + " already refers to different bytes",
          {
            recoverable: false,
            recommended_action: null,
            details: {
              stage: "snapshot_id_validate",
              commit_state: "not_committed",
              retryable: false,
            },
          },
        );
      }

      let metadata: SnapshotFileMetadata | null = null;
      try {
        const stat = await Deno.lstat(metadataFullPath);
        if (!stat.isFile || stat.isSymlink) {
          throw error(
            "invalid_project_path",
            "历史版本索引路径无效。",
            "Snapshot metadata is not a regular file: " + metadataFullPath,
            { recoverable: false, recommended_action: null, details: {} },
          );
        }
        const value = JSON.parse(await Deno.readTextFile(metadataFullPath));
        if (
          !value || value.version !== 1 || value.snapshot_id !== snapshotId ||
          typeof value.name !== "string" || typeof value.note !== "string" ||
          typeof value.created_at !== "string" ||
          typeof value.content_hash !== "string" ||
          value.content_hash !== contentHash
        ) {
          throw error(
            "snapshot_metadata_invalid",
            "历史版本索引已损坏。",
            "Snapshot metadata does not match " + snapshotId,
            {
              recoverable: false,
              recommended_action: null,
              details: {
                stage: "snapshot_metadata_validate",
                commit_state: "not_committed",
                retryable: false,
              },
            },
          );
        }
        metadata = value as SnapshotFileMetadata;
      } catch (caught) {
        if (!isNotFound(caught)) throw caught;
      }

      const createdAt = metadata?.created_at ?? now();
      let durabilityWarning: string | null = null;
      if (!existingBytes) {
        durabilityWarning = (await this.writeAtomicText(
          relativePath,
          contents,
          false,
        )).durability_warning;
      }
      if (!metadata) {
        // This is the last directory sync for the snapshot pair; a successful
        // sync here also covers the JSON promotion above.
        durabilityWarning = (await this.writeAtomicText(
          metadataPath,
          JSON.stringify({
            version: 1,
            snapshot_id: snapshotId,
            name,
            note,
            created_at: createdAt,
            content_hash: contentHash,
          } satisfies SnapshotFileMetadata),
          false,
        )).durability_warning;
      }
      if (existingBytes && metadata) {
        // Re-try the parent sync on idempotent requests so a prior uncertain
        // directory sync cannot silently become a warning-free acknowledgement.
        durabilityWarning = await syncDirectoryPath(dirname(fullPath))
          ? null
          : "文件已写入，但目录元数据同步失败。";
      }
      return {
        content_hash: contentHash,
        created_at: createdAt,
        outcome: existingBytes ? "unchanged" : "written",
        durability_warning: durabilityWarning,
      };
    });
  }

  async listSnapshotCopies(expectedProjectId?: string): Promise<{
    project_id: string | null;
    snapshots: SnapshotListRow[];
  }> {
    const state = await this.readProjectSnapshot();
    const project = state.project;
    if (!project) return { project_id: null, snapshots: [] };
    if (
      expectedProjectId !== undefined &&
      expectedProjectId !== project.project.id
    ) {
      throw error(
        "project_id_mismatch",
        "历史版本列表与当前课程身份不匹配。",
        "Refusing to list snapshots for a different project",
        {
          recoverable: false,
          recommended_action: null,
          details: { stage: "project_identity", retryable: false },
        },
      );
    }

    const directory = this.path(join(".workspace", "snapshots"));
    try {
      const stat = await Deno.lstat(directory);
      if (!stat.isDirectory || stat.isSymlink) {
        throw error(
          "invalid_project_path",
          "历史版本目录路径无效。",
          "Snapshot directory is not a regular directory: " + directory,
          { recoverable: false, recommended_action: null, details: {} },
        );
      }
    } catch (caught) {
      if (isNotFound(caught)) {
        return { project_id: project.project.id, snapshots: [] };
      }
      throw caught;
    }

    const rows: SnapshotListRow[] = [];
    for await (const entry of Deno.readDir(directory)) {
      if (!entry.name.endsWith(".json") || entry.name.endsWith(".meta.json")) {
        continue;
      }
      const snapshotId = entry.name.slice(0, -".json".length);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(snapshotId)) continue;
      try {
        const relativePath = join(".workspace", "snapshots", entry.name);
        const fullPath = this.path(relativePath);
        const stat = await Deno.lstat(fullPath);
        if (!stat.isFile || stat.isSymlink) {
          throw error(
            "snapshot_invalid",
            "历史版本文件无法读取。",
            "Snapshot is not a regular file: " + fullPath,
            { recoverable: false, recommended_action: null, details: {} },
          );
        }
        const bytes = await Deno.readFile(fullPath);
        const snapshot = migrateProject(
          JSON.parse(new TextDecoder().decode(bytes)),
        );
        if (snapshot.project.id !== project.project.id) {
          throw error(
            "project_id_mismatch",
            "历史版本属于其他课程。",
            "Snapshot " + snapshotId + " belongs to a different project",
            { recoverable: false, recommended_action: null, details: {} },
          );
        }
        const contentHash = await sha256Bytes(bytes);
        const metadataPath = this.path(
          join(".workspace", "snapshots", snapshotId + ".meta.json"),
        );
        let metadata: SnapshotFileMetadata | null = null;
        try {
          const metadataStat = await Deno.lstat(metadataPath);
          if (!metadataStat.isFile || metadataStat.isSymlink) {
            throw error(
              "snapshot_metadata_invalid",
              "历史版本索引无法读取。",
              "Snapshot metadata is not a regular file: " + metadataPath,
              { recoverable: false, recommended_action: null, details: {} },
            );
          }
          const value = JSON.parse(await Deno.readTextFile(metadataPath));
          if (
            !value || value.version !== 1 ||
            value.snapshot_id !== snapshotId ||
            typeof value.name !== "string" || typeof value.note !== "string" ||
            typeof value.created_at !== "string" ||
            typeof value.content_hash !== "string" ||
            value.content_hash !== contentHash
          ) {
            throw error(
              "snapshot_metadata_invalid",
              "历史版本索引已损坏。",
              "Snapshot metadata does not match " + snapshotId,
              { recoverable: false, recommended_action: null, details: {} },
            );
          }
          metadata = value as SnapshotFileMetadata;
        } catch (caught) {
          if (!isNotFound(caught)) throw caught;
        }
        const legacyRow = project.snapshots.find((row) =>
          row.id === snapshotId
        );
        rows.push({
          id: snapshotId,
          name: metadata?.name ?? legacyRow?.name ?? snapshotId,
          note: metadata?.note ?? legacyRow?.note ?? "",
          created_at: metadata?.created_at ?? legacyRow?.created_at ??
            stat.mtime?.toISOString() ?? "",
          status: "available",
          content_hash: contentHash,
        });
      } catch (caught) {
        const code = caught instanceof ServiceError
          ? caught.error.code
          : "snapshot_invalid";
        rows.push({
          id: snapshotId,
          name: snapshotId,
          note: "",
          created_at: "",
          status: "error",
          error: { code, message: "历史版本文件或索引已损坏。" },
        });
      }
    }
    rows.sort((left, right) =>
      right.created_at.localeCompare(left.created_at)
    );
    return { project_id: project.project.id, snapshots: rows };
  }

  private async createSnapshotUnlocked(
    data: ProjectData,
    name: string,
    note = "",
    options: {
      allow_external_overwrite?: boolean;
      persist_canonical?: boolean;
    } = {},
  ): Promise<{ snapshot: Snapshot; durability_warning: string | null }> {
    // Detect before creating a snapshot side effect; the canonical write also
    // repeats this check immediately before replacement.
    if (!options.allow_external_overwrite) {
      const externalState = await this.externalChange();
      if (
        externalState.changed ||
        (!externalState.baseline && externalState.current.exists)
      ) {
        throw error(
          "external_modification_conflict",
          "课程文件在其他地方发生了变化，版本保存已暂停以免覆盖内容。课程内容没有改变，请先处理保存提示后再试。",
          "Refusing snapshot creation after external modification",
          {
            recoverable: true,
            recommended_action: "查看差异，然后重新载入或合并修改。",
            details: {
              baseline: externalState.baseline,
              current: externalState.current,
            },
          },
        );
      }
    }
    // Validate before createDomainSnapshot mutates the in-memory object.
    serializeProject(data);
    const snapshot = createDomainSnapshot(data, name, note, null);
    const contents = serializeProject(data);
    const contentHash = await sha256Bytes(new TextEncoder().encode(contents));
    await this.writeAtomicText(
      join(".workspace", "snapshots", snapshot.id + ".json"),
      contents,
      false,
    );
    const relativeSnapshotPath = join(
      ".workspace",
      "snapshots",
      snapshot.id + ".json",
    );
    let metadataWrite: AtomicTextWriteResult;
    try {
      metadataWrite = await this.writeAtomicText(
        join(".workspace", "snapshots", snapshot.id + ".meta.json"),
        JSON.stringify({
          version: 1,
          snapshot_id: snapshot.id,
          name: snapshot.name,
          note: snapshot.note,
          created_at: snapshot.created_at,
          content_hash: contentHash,
        } satisfies SnapshotFileMetadata),
        false,
      );
    } catch (caught) {
      try {
        await Deno.remove(this.path(relativeSnapshotPath));
      } catch (cleanup) {
        if (!isNotFound(cleanup)) void cleanup;
      }
      throw caught;
    }
    let durabilityWarning = metadataWrite.durability_warning;
    if (options.persist_canonical !== false) {
      const projectWrite = await this.writeProjectUnlocked(data, options);
      durabilityWarning = [durabilityWarning, projectWrite.durability_warning]
        .filter(Boolean).join(" ") || null;
    }
    return { snapshot, durability_warning: durabilityWarning };
  }

  async restoreSnapshot(
    data: ProjectData,
    snapshotId: string,
    binding?: ProjectSaveBinding,
  ): Promise<{
    project: ProjectData;
    backup: Snapshot;
    fingerprint: FileFingerprint;
    durability_warning: string | null;
  }> {
    return await this.withWritableLease(async () => {
      if (binding) {
        await this.assertMutationBaseline(
          binding,
          data.project.id,
          "snapshot_restore_preflight",
        );
      }
      return await this.restoreSnapshotUnlocked(data, snapshotId);
    });
  }

  private async restoreSnapshotUnlocked(
    data: ProjectData,
    snapshotId: string,
  ): Promise<{
    project: ProjectData;
    backup: Snapshot;
    fingerprint: FileFingerprint;
    durability_warning: string | null;
  }> {
    if (!/^[A-Za-z0-9_-]+$/.test(snapshotId)) {
      throw error(
        "snapshot_invalid",
        "历史版本编号无效。",
        `Invalid snapshot id: ${snapshotId}`,
        { recoverable: false, recommended_action: null, details: {} },
      );
    }
    const path = this.path(
      join(".workspace", "snapshots", safeName(snapshotId) + ".json"),
    );
    let restored: ProjectData;
    try {
      const bytes = await Deno.readFile(path);
      restored = migrateProject(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      const metadataPath = this.path(
        join(".workspace", "snapshots", safeName(snapshotId) + ".meta.json"),
      );
      try {
        const metadataStat = await Deno.lstat(metadataPath);
        if (!metadataStat.isFile || metadataStat.isSymlink) {
          throw error(
            "snapshot_metadata_invalid",
            "历史版本索引无法读取。",
            "Snapshot metadata is not a regular file: " + metadataPath,
            { recoverable: false, recommended_action: null, details: {} },
          );
        }
        const metadata = JSON.parse(await Deno.readTextFile(metadataPath));
        const contentHash = await sha256Bytes(bytes);
        if (
          !metadata || metadata.version !== 1 ||
          metadata.snapshot_id !== snapshotId ||
          typeof metadata.name !== "string" ||
          typeof metadata.note !== "string" ||
          typeof metadata.created_at !== "string" ||
          metadata.content_hash !== contentHash
        ) {
          throw error(
            "snapshot_metadata_invalid",
            "历史版本内容与索引不匹配。",
            "Snapshot metadata does not match " + snapshotId,
            { recoverable: false, recommended_action: null, details: {} },
          );
        }
      } catch (caught) {
        if (!isNotFound(caught)) throw caught;
      }
    } catch (caught) {
      if (isNotFound(caught)) {
        throw error(
          "snapshot_missing",
          "找不到这个历史版本。",
          `Snapshot not found: ${snapshotId}`,
          {
            recoverable: true,
            recommended_action: "选择其他历史版本。",
            details: {},
          },
        );
      }
      throw caught;
    }
    if (restored.project.id !== data.project.id) {
      throw error(
        "project_id_mismatch",
        "历史版本属于其他课程。",
        "Snapshot " + snapshotId + " belongs to a different project",
        { recoverable: false, recommended_action: null, details: {} },
      );
    }
    const backupWrite = await this.createSnapshotUnlocked(
      data,
      "恢复前备份",
      "恢复旧版本前自动保存当前项目",
      { persist_canonical: false },
    );
    const backup = backupWrite.snapshot;
    restored.snapshots = [
      backup,
      ...restored.snapshots.filter((snapshot) => snapshot.id !== backup.id),
    ];
    const committed = await this.writeProjectUnlocked(restored);
    return {
      project: restored,
      backup,
      fingerprint: committed.fingerprint,
      durability_warning: [
        backupWrite.durability_warning,
        committed.durability_warning,
      ].filter(Boolean).join(" ") || null,
    };
  }

  async importAssetFile(
    data: ProjectData,
    sourcePath: string,
    input: Omit<AssetInput, "checksum" | "storage_path" | "filename"> & {
      filename?: string;
    },
    choice: "existing" | "copy" | "cancel" = "existing",
    binding?: ProjectSaveBinding,
  ): Promise<AddAssetResult> {
    return await this.withWritableLease(async () => {
    if (binding) {
      await this.assertMutationBaseline(
        binding,
        data.project.id,
        "asset_import_preflight",
      );
    }
    const sourceInfo = await Deno.lstat(sourcePath);
    if (sourceInfo.isSymlink || !sourceInfo.isFile) {
      throw error(
        "asset_source_unsafe",
        "素材源必须是普通文件。",
        `Asset import source is not a regular file: ${sourcePath}`,
        { recoverable: false, recommended_action: null, details: { stage: "source_validate", commit_state: "not_committed", retryable: false } },
      );
    }
    const checksum = await checksumFile(sourcePath);
    if (!sameFileIdentity(sourceInfo, await Deno.lstat(sourcePath))) {
      throw error(
        "asset_source_changed",
        "素材在检查期间发生了变化，未完成导入。",
        "Asset source identity changed during duplicate preflight",
        { recoverable: false, recommended_action: null, details: { stage: "source_preflight", commit_state: "not_committed", retryable: false } },
      );
    }
    const existing = data.assets.find((asset) =>
      asset.project_id === data.project.id && asset.checksum === checksum &&
      !asset.archived
    );
    if (existing) {
      if (choice === "cancel") {
        throw error(
          "asset_duplicate_cancelled",
          "已取消重复素材导入。",
          "Duplicate asset import cancelled",
          { recoverable: true, recommended_action: null, details: {} },
        );
      }
      if (choice === "existing") return { asset: existing, duplicate: true };
    }
    const filename = safeName(input.filename ?? basename(sourcePath));
    const relativePath = join("assets", `${id()}-${filename}`);
    const destination = this.path(relativePath);
    await Deno.mkdir(dirname(destination), { recursive: true });
    await this.assertWritableLease();
    try {
      const copied = await copyAssetAndHash(sourcePath, destination);
      if (copied.checksum !== checksum) {
        await Deno.remove(destination).catch(() => {});
        throw error(
          "asset_source_changed",
          "素材在复制期间发生了变化，未完成导入。",
          "Hash of bytes copied to the managed destination differs from source preflight",
          { recoverable: false, recommended_action: null, details: { stage: "asset_destination_verify", commit_state: "not_committed", retryable: false } },
        );
      }
      return addAsset(data, data.project.id, {
        ...input,
        filename,
        checksum: copied.checksum,
        storage_path: relativePath,
        file_size: copied.size,
      }, Boolean(existing));
    } catch (caught) {
      try {
        await Deno.remove(destination);
      } catch (cleanup) {
        if (!isNotFound(cleanup)) void cleanup;
      }
      throw caught;
    }
    });
  }

  async discardUncommittedAssetFile(assetId: string, storagePath: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(assetId) ||
      !storagePath.startsWith(`assets/${assetId}-`)) {
      throw new Error("Only a transaction-owned imported asset can be removed");
    }
    await this.withWritableLease(async () => {
      if (this.baselineProject?.assets.some((asset) => asset.id === assetId)) return;
      const target = this.path(storagePath);
      try {
        const stat = await Deno.lstat(target);
        if (stat.isSymlink || !stat.isFile) {
          throw error(
            "asset_cleanup_unsafe",
            "导入失败，临时素材路径不是普通文件，已保留以避免删除其他数据。",
            `Refusing to remove unsafe uncommitted asset: ${storagePath}`,
            { recoverable: false, recommended_action: null, details: { stage: "asset_cleanup", commit_state: "not_committed", retryable: false } },
          );
        }
        await Deno.remove(target);
      } catch (caught) {
        if (!isNotFound(caught)) throw caught;
      }
    });
  }

  async verifyAsset(
    data: ProjectData,
    assetId: string,
  ): Promise<AssetIntegrityResult> {
    const asset = data.assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new Error(`找不到素材: ${assetId}`);
    return await verifyAssetFile(this.directory, asset);
  }

  async verifyAssets(data: ProjectData): Promise<AssetIntegrityResult[]> {
    return await verifyProjectAssets(this.directory, data);
  }

  /**
   * Item 13 — rename a managed asset by renaming its physical file inside the
   * project directory, then synchronising every canonical reference, then saving.
   *
   * Transaction order (spec §14.4): preflight → filesystem rename → canonical
   * rewrite → save. A save failure rolls the rename back. A failed rollback is
   * surfaced as a BLOCKING error quoting the exact original/new paths, and never
   * claims success. `data` is only mutated after the canonical write succeeds, so
   * a rejected rename leaves the caller's in-memory project untouched.
   */
  async renameManagedAsset(
    data: ProjectData,
    assetId: string,
    requestedName: string,
    binding?: ProjectSaveBinding,
  ): Promise<
    {
      status: "renamed" | "noop";
      plan: AssetRenamePlan;
      rewritten: number;
      project: ProjectData;
      fingerprint?: FileFingerprint;
      durability_warning?: string | null;
      outcome?: "written" | "unchanged";
    }
  > {
    const plan = planAssetRename(data, assetId, requestedName);
    if (isAssetRenameNoop(plan)) {
      if (!binding) return { status: "noop", plan, rewritten: 0, project: data };
      return await this.withWritableLease(async () => {
        const fingerprint = await this.assertMutationBaseline(
          binding,
          data.project.id,
          "asset_rename_preflight",
        );
        return {
          status: "noop" as const,
          plan,
          rewritten: 0,
          project: data,
          fingerprint,
          durability_warning: null,
          outcome: "unchanged" as const,
        };
      });
    }

    // Canonical-level collision: another live asset already owns the target path.
    const clash = data.assets.find((candidate) =>
      candidate.id !== assetId && !candidate.archived &&
      candidate.storage_path === plan.new_storage_path
    );
    if (clash) {
      throw error(
        "rename_collision",
        "已有一个素材使用这个文件名，请换一个名字后重试。",
        `Target managed path already used by asset ${clash.id}`,
        {
          severity: "recoverable",
          recoverable: true,
          recommended_action: "为文件选择一个未被占用的新名称。",
          details: {
            original_path: plan.old_storage_path,
            target_path: plan.new_storage_path,
          },
        },
      );
    }

    return await this.withWritableLease(async () => {
      if (binding) {
        await this.assertMutationBaseline(
          binding,
          data.project.id,
          "asset_rename_preflight",
        );
      }
      const oldAbsolute = this.path(plan.old_storage_path);
      const newAbsolute = this.path(plan.new_storage_path);

      let sourceStat: Deno.FileInfo;
      try {
        sourceStat = await Deno.lstat(oldAbsolute);
      } catch (caught) {
        if (isNotFound(caught)) {
          throw error(
            "rename_source_missing",
            "找不到要重命名的素材文件，它可能已被移动或删除。",
            `Managed asset file is missing: ${plan.old_storage_path}`,
            {
              recoverable: true,
              recommended_action: "重新载入项目后确认文件仍然存在。",
              details: { original_path: plan.old_storage_path },
            },
          );
        }
        throw caught;
      }
      if (sourceStat.isSymlink || !sourceStat.isFile) {
        throw error(
          "rename_source_unsafe",
          "素材文件不是可安全重命名的普通文件。",
          `Managed asset path is not a regular file: ${plan.old_storage_path}`,
          {
            recoverable: false,
            recommended_action: "检查素材文件后重试。",
            details: { original_path: plan.old_storage_path },
          },
        );
      }

      let targetExists = false;
      try {
        const targetStat = await Deno.lstat(newAbsolute);
        targetExists = true;
        if (targetStat.isSymlink) {
          throw error(
            "rename_target_symlink",
            "目标名称已存在一个符号链接，为避免越过目录边界已停止重命名。",
            `Rename target is a symlink: ${plan.new_storage_path}`,
            {
              recoverable: false,
              recommended_action: "更换文件名后重试。",
              details: { target_path: plan.new_storage_path },
            },
          );
        }
      } catch (caught) {
        if (caught instanceof ServiceError) throw caught;
        if (!isNotFound(caught)) throw caught;
      }
      if (targetExists) {
        throw error(
          "rename_collision",
          "已存在同名文件，请换一个名字后重试。",
          `Rename target already exists: ${plan.new_storage_path}`,
          {
            recoverable: true,
            recommended_action: "为文件选择一个未被占用的新名称。",
            details: {
              original_path: plan.old_storage_path,
              target_path: plan.new_storage_path,
            },
          },
        );
      }

      // Step 2 — filesystem rename.
      await Deno.rename(oldAbsolute, newAbsolute);

      // Steps 3+4 — canonical rewrite + save, with rollback of the fs move.
      const next = clone(data);
      try {
        const rewritten = applyAssetRename(next, plan);
        const committed = await this.writeProjectUnlocked(next);
        return {
          status: "renamed",
          plan,
          rewritten,
          project: next,
          fingerprint: committed.fingerprint,
          durability_warning: committed.durability_warning,
          outcome: "written" as const,
        };
      } catch (saveError) {
        const commitState = saveError instanceof ServiceError
          ? saveError.error.details.commit_state
          : undefined;
        if (commitState === "committed" || commitState === "outcome_uncertain") {
          const expectedBytes = new TextEncoder().encode(serializeProject(next));
          const expectedCommittedHash = await sha256Bytes(expectedBytes);
          throw error(
            "rename_outcome_uncertain",
            commitState === "committed"
              ? `素材重命名已提交，但后续确认失败。文件保留在「${plan.new_filename}」；请重新载入项目后继续。`
              : `素材重命名结果尚未核实。文件保留在「${plan.new_filename}」；请重新载入项目后继续，暂勿重试。`,
            `Canonical rename ended with ${commitState}; managed asset stays at ${plan.new_storage_path}`,
            {
              recoverable: false,
              recommended_action: "重新载入项目并核对素材；确认状态前不要重试重命名。",
              details: {
                stage: "asset_rename_commit",
                commit_state: commitState,
                retryable: false,
                project_id: binding?.expected_project_id ?? data.project.id,
                project_dir: this.directory,
                lease_generation: binding?.lease_generation ?? null,
                editor_generation: binding?.editor_generation ?? null,
                operation_id: binding?.operation_id ?? null,
                revision: binding?.revision ?? null,
                expected_fingerprint: binding
                  ? structuredClone(binding.expected_fingerprint)
                  : null,
                expected_committed_hash: expectedCommittedHash,
                expected_committed_size: expectedBytes.byteLength,
                asset_id: assetId,
                original_path: plan.old_storage_path,
                target_path: plan.new_storage_path,
              },
            },
          );
        }
        // Roll the physical file back to its original name.
        try {
          await Deno.rename(newAbsolute, oldAbsolute);
        } catch (rollbackError) {
          const original = saveError instanceof Error ? saveError.message : String(saveError);
          const rolled = rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
          throw error(
            "rename_rollback_failed",
            `重命名未能保存，且文件回滚也失败了。素材文件当前位于新名称「${plan.new_filename}」，` +
              `原名称「${plan.old_filename}」的内容仍在磁盘上，请勿手动移动以免数据错乱。`,
            `Canonical update failed (${original}) and rollback failed (${rolled})`,
            {
              severity: "blocking",
              recoverable: false,
              recommended_action: "备份项目目录后手动核对 project.json 与 assets/ 的一致性。",
              details: {
                original_path: plan.old_storage_path,
                renamed_path: plan.new_storage_path,
                original_absolute: oldAbsolute,
                renamed_absolute: newAbsolute,
                save_error: original,
                rollback_error: rolled,
              },
            },
          );
        }
        // Rollback succeeded: surface the original save error so the caller reloads.
        throw saveError;
      }
    });
  }
}

export async function openProjectDirectory(
  directory: string,
  options: ProjectDirectoryOptions = {},
): Promise<ProjectDirectoryStore> {
  const store = new ProjectDirectoryStore(directory, options);
  await store.open();
  return store;
}

export { CURRENT_SCHEMA_VERSION };
