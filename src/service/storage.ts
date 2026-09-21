import { basename, dirname, join, normalize, relative } from "node:path";
import {
  addAsset,
  type AddAssetResult,
  type AssetInput,
} from "../domain/assets.ts";
import { createSnapshot as createDomainSnapshot } from "../domain/workflow.ts";
import {
  CURRENT_SCHEMA_VERSION,
  type ProjectData,
  type Snapshot,
} from "../domain/types.ts";
import {
  assertValidProjectData,
  loadProject,
  migrateProject,
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
): Promise<void> {
  const file = await Deno.open(path, {
    create: true,
    truncate: true,
    write: true,
  });
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += await file.write(bytes.subarray(offset));
    }
    await file.sync();
  } finally {
    file.close();
  }
}

export async function checksumFile(path: string): Promise<string> {
  return await sha256Bytes(await Deno.readFile(path));
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
      hash: await checksumFile(path),
    };
  } catch (caught) {
    if (isNotFound(caught)) {
      return { exists: false, mtime_ms: null, size: null, hash: null };
    }
    throw caught;
  }
}

async function readProjectState(
  path: string,
): Promise<{ original: unknown; project: ProjectData; fingerprint: FileFingerprint }> {
  const bytes = await Deno.readFile(path);
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
          user_message: "该项目已在另一窗口或进程中编辑。",
          technical_message:
            "Project lock is currently being written or is malformed",
          recoverable: true,
          recommended_action: "稍后重试，或确认强制接管。",
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
          user_message: "该项目已在另一窗口或进程中编辑。",
          technical_message: `Project lock held by ${existing.app_instance_id}`,
          recoverable: true,
          recommended_action: "选择只读打开、切换到已有窗口，或确认强制接管。",
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
          user_message: "该项目已在另一窗口或进程中编辑。",
          technical_message: "Lock acquisition race",
          recoverable: true,
          recommended_action: "选择只读打开或重试。",
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

  async readProject(): Promise<ProjectData> {
    const state = await readProjectState(this.projectPath);
    this.baseline = state.fingerprint;
    this.baselineProject = clone(state.project);
    return state.project;
  }

  async writeProject(
    data: ProjectData,
    options: { allow_external_overwrite?: boolean } = {},
  ): Promise<void> {
    await this.withWritableLease(() => this.writeProjectUnlocked(data, options));
  }

  private async writeProjectUnlocked(
    data: ProjectData,
    options: { allow_external_overwrite?: boolean } = {},
  ): Promise<void> {
    await this.ensureDirectory();
    const externalState = await this.externalChange();
    if (
      !options.allow_external_overwrite &&
      (externalState.changed ||
        (!externalState.baseline && externalState.current.exists))
    ) {
      throw error(
        "external_modification_conflict",
        "检测到 project.json 已被外部修改，保存已阻止。",
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
    await this.writeAtomicText(PROJECT_FILE, contents, true);
    const written = await Deno.stat(this.projectPath);
    this.baseline = {
      exists: true,
      mtime_ms: written.mtime?.getTime() ?? null,
      size: bytes.length,
      hash: await sha256Bytes(bytes),
    };
    this.baselineProject = clone(migrateProject(data));
  }

  private async writeAtomicText(
    relativePath: string,
    contents: string,
    keepBackup = true,
  ): Promise<void> {
    const target = this.path(relativePath);
    await Deno.mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${id()}`;
    try {
      await writeBytesSyncSafe(temporary, new TextEncoder().encode(contents));
      const parsed = JSON.parse(contents);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("JSON root must be object");
      }
      if (keepBackup) {
        const backup = `${target}.bak`;
        assertNoSymlink(this.directory, backup);
        try {
          await Deno.copyFile(target, backup);
        } catch (caught) {
          if (!isNotFound(caught)) throw caught;
        }
      }
      await Deno.rename(temporary, target);
    } catch (caught) {
      try {
        await Deno.remove(temporary);
      } catch (cleanup) {
        if (!isNotFound(cleanup)) void cleanup;
      }
      throw mapWriteFailure(caught, relativePath);
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

  async readRecoveryJournal(): Promise<RecoveryJournal | null> {
    try {
      const journal = JSON.parse(
        await Deno.readTextFile(this.journalPath),
      ) as RecoveryJournal;
      if (journal && typeof journal === "object" && journal.project) {
        serializeProject(journal.project);
      }
      return journal;
    } catch (caught) {
      if (isNotFound(caught)) return null;
      throw caught;
    }
  }

  async clearRecoveryJournal(): Promise<void> {
    await this.withWritableLease(async () => {
      try {
        await Deno.remove(this.journalPath);
      } catch (caught) {
        if (!isNotFound(caught)) throw caught;
      }
    });
  }

  async saveWithRecovery(data: ProjectData): Promise<void> {
    const canonical = migrateProject(JSON.parse(serializeProject(data)));
    const journal: RecoveryJournal = {
      transaction_id: id(),
      project_id: canonical.project.id,
      canonical_revision: canonical.project.updated_at,
      saved_at: now(),
      project: clone(canonical),
    };
    // Reject a known conflict before creating a new journal. writeProject
    // repeats the comparison so an external edit racing this check is still
    // blocked at the canonical write boundary.
    const externalState = await this.externalChange();
    if (
      externalState.changed ||
      (!externalState.baseline && externalState.current.exists)
    ) {
      throw error(
        "external_modification_conflict",
        "检测到 project.json 已被外部修改，自动保存已阻止。",
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
    await this.writeRecoveryJournal(journal);
    await this.writeProject(canonical);
    await this.clearRecoveryJournal();
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
  ): Promise<void> {
    await this.withWritableLease(async () => {
      const current = await fileFingerprint(this.projectPath);
      if (fingerprintsDiffer(expectedCurrent, current)) {
        throw error(
          "external_modification_conflict",
          "处理期间 project.json 再次发生变化，请重新查看差异。",
          "External canonical changed while conflict resolution was pending",
          {
            recoverable: true,
            recommended_action: "重新查看最新磁盘版本。",
            details: { expected: expectedCurrent, current },
          },
        );
      }
      const external = current.exists ? await loadProject(this.projectPath) : null;
      this.baseline = current;
      this.baselineProject = external ? clone(external) : null;
      await this.writeProjectUnlocked(resolvedProject);
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
    return await this.withWritableLease(() =>
      this.createSnapshotUnlocked(data, name, note, options)
    );
  }

  private async createSnapshotUnlocked(
    data: ProjectData,
    name: string,
    note = "",
    options: { allow_external_overwrite?: boolean } = {},
  ): Promise<Snapshot> {
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
          "检测到 project.json 已被外部修改，版本保存已阻止。",
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
    const snapshotDir = join(this.workspacePath, "snapshots");
    await Deno.mkdir(snapshotDir, { recursive: true });
    await this.writeAtomicText(
      join(".workspace", "snapshots", `${snapshot.id}.json`),
      serializeProject(data),
      false,
    );
    await this.writeProjectUnlocked(data, options);
    return snapshot;
  }

  async restoreSnapshot(
    data: ProjectData,
    snapshotId: string,
  ): Promise<{ project: ProjectData; backup: Snapshot }> {
    return await this.withWritableLease(() =>
      this.restoreSnapshotUnlocked(data, snapshotId)
    );
  }

  private async restoreSnapshotUnlocked(
    data: ProjectData,
    snapshotId: string,
  ): Promise<{ project: ProjectData; backup: Snapshot }> {
    if (!/^[A-Za-z0-9_-]+$/.test(snapshotId)) {
      throw error(
        "snapshot_invalid",
        "历史版本编号无效。",
        `Invalid snapshot id: ${snapshotId}`,
        { recoverable: false, recommended_action: null, details: {} },
      );
    }
    const path = this.path(
      join(".workspace", "snapshots", `${safeName(snapshotId)}.json`),
    );
    let restored: ProjectData;
    try {
      restored = await loadProject(path);
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
    const backup = await this.createSnapshotUnlocked(
      data,
      "恢复前备份",
      "恢复旧版本前自动保存当前项目",
    );
    restored.snapshots = [
      backup,
      ...restored.snapshots.filter((snapshot) => snapshot.id !== backup.id),
    ];
    await this.writeProjectUnlocked(restored);
    return { project: restored, backup };
  }

  async importAssetFile(
    data: ProjectData,
    sourcePath: string,
    input: Omit<AssetInput, "checksum" | "storage_path" | "filename"> & {
      filename?: string;
    },
    choice: "existing" | "copy" | "cancel" = "existing",
  ): Promise<AddAssetResult> {
    return await this.withWritableLease(async () => {
    const checksum = await checksumFile(sourcePath);
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
    await Deno.copyFile(sourcePath, destination);
    try {
      await this.assertWritableLease();
      const destinationStat = await Deno.stat(destination);
      return addAsset(data, data.project.id, {
        ...input,
        filename,
        checksum,
        storage_path: relativePath,
        file_size: input.file_size ?? destinationStat.size,
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
