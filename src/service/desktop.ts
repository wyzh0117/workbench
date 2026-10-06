import { createEmptyProjectData } from "../domain/store.ts";
import { applyChangeDraft } from "../domain/ai.ts";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { join, normalize } from "node:path";
import type { AssetType, JsonObject, ProjectData } from "../domain/types.ts";
import { addAssetUsage } from "../domain/assets.ts";
import {
  buildBlueprintDraft,
  confirmBlueprint,
  createCourseSeed,
  discardBlueprint,
} from "../domain/course.ts";
import { createInboxItem, triageInboxItem } from "../domain/workflow.ts";
import { assignStatus } from "../domain/status.ts";
import { reorderBlocks } from "../domain/document.ts";
import { resolveRequirement } from "../domain/requirements.ts";
import {
  addLayoutSection,
  addPlacement,
  createLayoutInstance,
} from "../domain/layout.ts";
import { AiTransport, type AiTransportOptions } from "./ai_transport.ts";
import { AuditLog } from "./audit.ts";
import {
  BrowserSessionStore,
  type BrowserSessionCursor,
  type BrowserSessionSaveBinding,
  type BrowserSessionSaveResult,
} from "./browser_session.ts";
import { CommandBus, type CommandContext, QueryBus } from "./commands.ts";
import { EventBus } from "./events.ts";
import { error, ServiceError } from "./errors.ts";
import { JobManager } from "./jobs.ts";
import { MacKeychainSecretStore, type SecretStore } from "./security.ts";
import { DiagnosticLogger } from "./diagnostics.ts";
import {
  createSearchIndex,
  MemorySearchIndex,
  SearchService,
} from "./search.ts";
import {
  ConnectorRegistry,
  ImportedConversationConnector,
  syncSelectedConversations,
} from "./connectors.ts";
import {
  type FileFingerprint,
  type ProjectSaveBinding,
  inspectProjectDirectory,
  type ProjectDirectoryOptions,
  ProjectDirectoryStore,
} from "./storage.ts";
import {
  acquireExportStreamBuffer,
  confirmImport,
  exportProject,
  type ImportPreview,
  type ImportSource,
  ManualPublishAdapter,
  preflightExport,
  previewImport,
  recordExportDownloadRead,
} from "./import_export.ts";
import {
  inspectMarkdownImage,
  readFolderPreview,
  readFolderSource,
  scanFolder,
  scanMediaDescendants,
} from "./folder_scan.ts";
import { confirmFolderAdoption } from "./folder_adoption.ts";
import { ProjectRegistryStore } from "./project_registry.ts";
import type { ImportMappingPlan } from "./folder_mapping.ts";
import { scanFolderDocuments } from "./folder_mapping.ts";
import type { ExportPreset } from "../domain/types.ts";

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isFileFingerprint(value: unknown): value is FileFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fingerprint = value as Partial<FileFingerprint>;
  return typeof fingerprint.exists === "boolean" &&
    (fingerprint.mtime_ms === null ||
      typeof fingerprint.mtime_ms === "number") &&
    (fingerprint.size === null || typeof fingerprint.size === "number") &&
    (fingerprint.hash === null || typeof fingerprint.hash === "string");
}

const PREVIEW_ITEM_LIMIT = 8 * 1024 * 1024;
const PREVIEW_BATCH_LIMIT = 16 * 1024 * 1024;

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.exists === right.exists && left.mtime_ms === right.mtime_ms &&
    left.size === right.size && left.hash === right.hash;
}

function safeAssetStoragePath(path: unknown): path is string {
  if (typeof path !== "string" || !path || path.startsWith("/") ||
    path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function sameFileIdentity(left: Deno.FileInfo, right: Deno.FileInfo): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtime?.getTime() === right.mtime?.getTime();
}

async function assertRegularAssetPath(root: string, relativePath: string) {
  let path = root;
  const parts = relativePath.split("/");
  let stat: Deno.FileInfo | null = null;
  for (let index = 0; index < parts.length; index += 1) {
    path = join(path, parts[index]!);
    stat = await Deno.lstat(path);
    if (stat.isSymlink || (index === parts.length - 1 ? !stat.isFile : !stat.isDirectory)) {
      throw new Error("素材路径包含符号链接或非普通文件");
    }
  }
  if (!stat) throw new Error("素材路径无效");
  return { path, stat };
}

const assetPreviewBatchMetrics = {
  batches: 0,
  canonical_snapshot_reads: 0,
  source_file_opens: 0,
  source_read_operations: 0,
  source_read_bytes: 0,
  raw_bytes_returned: 0,
  base64_bytes_returned: 0,
  peak_open_handles_per_batch: 0,
};
let assetPreviewBatchDiagnosticsEnabled = false;

export function setAssetPreviewBatchDiagnosticsEnabled(enabled: boolean): void {
  assetPreviewBatchDiagnosticsEnabled = enabled;
  if (enabled) {
    assetPreviewBatchMetrics.batches = 0;
    assetPreviewBatchMetrics.canonical_snapshot_reads = 0;
    assetPreviewBatchMetrics.source_file_opens = 0;
    assetPreviewBatchMetrics.source_read_operations = 0;
    assetPreviewBatchMetrics.source_read_bytes = 0;
    assetPreviewBatchMetrics.raw_bytes_returned = 0;
    assetPreviewBatchMetrics.base64_bytes_returned = 0;
    assetPreviewBatchMetrics.peak_open_handles_per_batch = 0;
  }
}

export function getAssetPreviewBatchMetrics(): typeof assetPreviewBatchMetrics {
  return { ...assetPreviewBatchMetrics };
}

async function readAssetPreviewBatch(store: ProjectDirectoryStore, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw error("asset_preview_invalid", "素材预览请求无效。", "Expected batch object", {
      recoverable: false,
      recommended_action: null,
      details: { stage: "request_validate", commit_state: "not_committed", retryable: false },
    });
  }
  const request = input as Record<string, unknown>;
  if (typeof request.project_dir !== "string" ||
    normalize(request.project_dir) !== normalize(store.directory)) {
    throw error("project_path_mismatch", "素材预览与当前课程路径不匹配。", "Preview project directory mismatch", {
      recoverable: false,
      recommended_action: null,
      details: { stage: "project_identity", commit_state: "not_committed", retryable: false },
    });
  }
  if (typeof request.project_id !== "string" || !request.project_id ||
    !Number.isSafeInteger(request.request_generation) ||
    (request.request_generation as number) < 0 ||
    !Array.isArray(request.asset_ids) || request.asset_ids.length < 1 ||
    request.asset_ids.length > 8 ||
    request.asset_ids.some((assetId) => typeof assetId !== "string" || !assetId) ||
    new Set(request.asset_ids).size !== request.asset_ids.length ||
    !isFileFingerprint(request.fingerprint)) {
    throw error("asset_preview_invalid", "素材预览请求无效。", "Invalid preview batch bindings", {
      recoverable: false,
      recommended_action: null,
      details: { stage: "request_validate", commit_state: "not_committed", retryable: false },
    });
  }

  // One complete Canonical read/hash binds the whole batch; no stat-only alias.
  if (assetPreviewBatchDiagnosticsEnabled) assetPreviewBatchMetrics.batches += 1;
  const state = await store.readProjectSnapshot();
  if (assetPreviewBatchDiagnosticsEnabled) {
    assetPreviewBatchMetrics.canonical_snapshot_reads += 1;
  }
  if (!state.project || state.project.project.id !== request.project_id ||
    !sameFingerprint(state.fingerprint, request.fingerprint)) {
    throw error("asset_preview_stale", "课程内容已变化，请重新加载后预览素材。", "Preview batch fingerprint no longer matches Canonical", {
      recoverable: false,
      recommended_action: null,
      details: { stage: "canonical_validate", commit_state: "not_committed", retryable: false, fingerprint: state.fingerprint },
    });
  }

  const root = await Deno.realPath(store.directory);
  let rawBytes = 0;
  let batchOpenHandles = 0;
  const items: Array<Record<string, unknown>> = [];
  for (const assetId of request.asset_ids as string[]) {
    const asset = state.project.assets.find((candidate) => candidate.id === assetId);
    const itemError = (code: string, message: string) => ({
      asset_id: assetId,
      status: "error",
      error: { code, message },
    });
    if (!asset || asset.project_id !== request.project_id || asset.archived) {
      items.push(itemError("asset_missing", "找不到可预览的素材。"));
      continue;
    }
    if (
      (asset.type === "image" || asset.type === "gif") &&
      !asset.mime_type?.trim().toLowerCase().startsWith("image/")
    ) {
      items.push(itemError("asset_mime_mismatch", "素材类型与声明的 MIME 不匹配。"));
      continue;
    }
    if (!safeAssetStoragePath(asset.storage_path)) {
      items.push(itemError("asset_path_invalid", "素材路径无效。"));
      continue;
    }

    let file: Deno.FsFile | null = null;
    try {
      const before = await assertRegularAssetPath(root, asset.storage_path);
      if (before.stat.size > PREVIEW_ITEM_LIMIT) {
        items.push(itemError("asset_too_large", "素材超过单文件预览上限（8 MiB）。"));
        continue;
      }
      if (rawBytes + before.stat.size > PREVIEW_BATCH_LIMIT) {
        items.push({ asset_id: assetId, status: "deferred" });
        continue;
      }
      const realTarget = await Deno.realPath(before.path);
      if (realTarget !== root && !realTarget.startsWith(`${root}/`)) {
        items.push(itemError("asset_path_invalid", "素材路径越过课程目录。"));
        continue;
      }
      file = await Deno.open(before.path, { read: true });
      batchOpenHandles += 1;
      if (assetPreviewBatchDiagnosticsEnabled) {
        assetPreviewBatchMetrics.source_file_opens += 1;
        assetPreviewBatchMetrics.peak_open_handles_per_batch = Math.max(
          assetPreviewBatchMetrics.peak_open_handles_per_batch,
          batchOpenHandles,
        );
      }
      const opened = await file.stat();
      if (!sameFileIdentity(before.stat, opened)) {
        items.push(itemError("asset_changed", "预览期间素材文件发生变化。"));
        continue;
      }
      const bytes = new Uint8Array(Math.min(PREVIEW_ITEM_LIMIT + 1, before.stat.size + 1));
      let length = 0;
      while (length < bytes.byteLength) {
        const count = await file.read(bytes.subarray(length));
        if (count === null) break;
        if (count === 0) continue;
        length += count;
        if (assetPreviewBatchDiagnosticsEnabled) {
          assetPreviewBatchMetrics.source_read_operations += 1;
          assetPreviewBatchMetrics.source_read_bytes += count;
        }
      }
      if (length > PREVIEW_ITEM_LIMIT || length !== before.stat.size) {
        items.push(itemError(length > PREVIEW_ITEM_LIMIT ? "asset_too_large" : "asset_changed", "素材读取结果与预览描述不匹配。"));
        continue;
      }
      const after = await file.stat();
      const pathAfter = await assertRegularAssetPath(root, asset.storage_path);
      if (!sameFileIdentity(before.stat, after) || !sameFileIdentity(before.stat, pathAfter.stat)) {
        items.push(itemError("asset_changed", "预览期间素材文件发生变化。"));
        continue;
      }
      const payload = bytes.subarray(0, length);
      const checksum = createHash("sha256").update(payload).digest("hex");
      if (asset.checksum && asset.checksum.toLowerCase() !== checksum) {
        items.push(itemError("asset_checksum_mismatch", "素材校验值与课程记录不一致。"));
        continue;
      }
      rawBytes += payload.byteLength;
      const base64 = Buffer.from(payload).toString("base64");
      if (assetPreviewBatchDiagnosticsEnabled) {
        assetPreviewBatchMetrics.raw_bytes_returned += payload.byteLength;
        assetPreviewBatchMetrics.base64_bytes_returned += base64.length;
      }
      items.push({
        asset_id: assetId,
        status: "ok",
        bytes_base64: base64,
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "";
      const code = caught instanceof Deno.errors.NotFound
        ? "asset_missing"
        : /路径|符号链接|普通文件|越过/.test(message)
        ? "asset_path_invalid"
        : "asset_unavailable";
      items.push(itemError(code, "素材文件不可读或路径无效。"));
    } finally {
      if (file) {
        file.close();
        batchOpenHandles -= 1;
      }
    }
  }
  return {
    project_id: request.project_id,
    fingerprint: state.fingerprint,
    request_generation: request.request_generation,
    items,
  };
}

interface SnapshotCommandBinding {
  project_id: string;
  project_dir: string;
  lease_generation: string;
  editor_generation: number;
  operation_id: string;
  revision: number;
}

interface CanonicalMutationBinding extends SnapshotCommandBinding {
  expected_fingerprint: FileFingerprint;
}

const MUTATION_BINDING_KEYS = [
  "project_dir",
  "expected_project_id",
  "lease_generation",
  "editor_generation",
  "operation_id",
  "revision",
  "expected_fingerprint",
] as const;

function snapshotCommandBinding(
  input: unknown,
  store: ProjectDirectoryStore,
  activeProjectId: string | null,
): SnapshotCommandBinding {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw error(
      "snapshot_request_invalid",
      "历史版本请求无效。",
      "Snapshot command requires a request object",
      { recoverable: false, recommended_action: null, details: { stage: "request_validate", commit_state: "not_committed", retryable: false } },
    );
  }
  const candidate = input as Record<string, unknown>;
  if (
    typeof candidate.project_dir !== "string" ||
    normalize(candidate.project_dir) !== normalize(store.directory)
  ) {
    throw error(
      "project_path_mismatch",
      "历史版本请求与当前项目路径不匹配。",
      "Snapshot request project directory does not match the active store",
      { recoverable: false, recommended_action: null, details: { stage: "project_path_validate", commit_state: "not_committed", retryable: false } },
    );
  }
  if (
    !activeProjectId ||
    candidate.expected_project_id !== activeProjectId
  ) {
    throw error(
      "project_id_mismatch",
      "历史版本请求与当前课程身份不匹配。",
      "Snapshot request project id does not match the active project",
      { recoverable: false, recommended_action: null, details: { stage: "project_identity", commit_state: "not_committed", retryable: false } },
    );
  }
  const activeLease = store.leaseGeneration;
  if (
    !activeLease || typeof candidate.lease_generation !== "string" ||
    candidate.lease_generation !== activeLease
  ) {
    throw error(
      "project_lock_lost",
      "项目编辑租约已变化，历史版本操作已暂停。",
      "Snapshot request lease generation does not match the active writer lease",
      { recoverable: false, recommended_action: null, details: { stage: "lease_validate", commit_state: "not_committed", retryable: false } },
    );
  }
  if (
    !Number.isSafeInteger(candidate.editor_generation) ||
    (candidate.editor_generation as number) < 0 ||
    typeof candidate.operation_id !== "string" ||
    !candidate.operation_id ||
    candidate.operation_id.length > 256 ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0
  ) {
    throw error(
      "snapshot_binding_invalid",
      "历史版本请求绑定无效。",
      "Snapshot request has invalid editor generation, operation id, or revision",
      { recoverable: false, recommended_action: null, details: { stage: "request_binding", commit_state: "not_committed", retryable: false } },
    );
  }
  return {
    project_id: activeProjectId,
    project_dir: store.directory,
    lease_generation: activeLease,
    editor_generation: candidate.editor_generation as number,
    operation_id: candidate.operation_id,
    revision: candidate.revision as number,
  };
}

function canonicalMutationBinding(
  input: unknown,
  store: ProjectDirectoryStore,
  activeProjectId: string | null,
): CanonicalMutationBinding | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input as Record<string, unknown>;
  if (!MUTATION_BINDING_KEYS.some((key) => Object.hasOwn(candidate, key))) return null;
  const binding = snapshotCommandBinding(input, store, activeProjectId);
  if (!isFileFingerprint(candidate.expected_fingerprint) ||
    !candidate.expected_fingerprint.exists ||
    typeof candidate.expected_fingerprint.hash !== "string") {
    throw error(
      "mutation_binding_invalid",
      "课程修改绑定无效，请重新打开课程后重试。",
      "Canonical mutation requires an existing expected fingerprint",
      { recoverable: false, recommended_action: null, details: { stage: "fingerprint_validate", commit_state: "not_committed", retryable: false } },
    );
  }
  return { ...binding, expected_fingerprint: candidate.expected_fingerprint };
}

function projectSaveBinding(binding: CanonicalMutationBinding): ProjectSaveBinding {
  return {
    expected_project_id: binding.project_id,
    lease_generation: binding.lease_generation,
    editor_generation: binding.editor_generation,
    operation_id: binding.operation_id,
    revision: binding.revision,
    expected_fingerprint: binding.expected_fingerprint,
  };
}

function normalizeImportSources(value: unknown): ImportSource[] {
  if (!Array.isArray(value)) return [];
  return value.map((source) => {
    if (!source || typeof source !== "object") return source as ImportSource;
    const candidate = source as ImportSource & { bytes_base64?: unknown };
    if (typeof candidate.bytes_base64 === "string") {
      return {
        ...candidate,
        bytes: decodeBase64(candidate.bytes_base64),
      } as ImportSource;
    }
    return candidate;
  });
}

const IMPORT_PREVIEW_LIMIT = 8;
const IMPORT_PREVIEW_TTL_MS = 15 * 60 * 1000;
const EXPORT_ARTIFACT_LIMIT = 8;
const EXPORT_ARTIFACT_TTL_MS = 15 * 60 * 1000;

interface ExportArtifactFile {
  relative_path: string;
  mime_type: string;
  size: number;
  sha256: string;
  path: string;
}

interface ExportArtifactSlot {
  created_at: number;
  building: boolean;
  release_requested: boolean;
  root: string | null;
  files: ExportArtifactFile[];
  downloaded: Set<number>;
  active_finishes: Set<() => Promise<void>>;
  controller: AbortController;
  build_completion: Promise<unknown> | null;
  expiry_timer?: ReturnType<typeof setTimeout>;
}

export interface ExportDownloadHandle {
  file: Deno.FsFile;
  relative_path: string;
  mime_type: string;
  size: number;
  signal: AbortSignal;
  read(buffer: Uint8Array): Promise<number | null>;
  finish(success: boolean): Promise<void>;
}

interface ImportPreviewSlot {
  created_at: number;
  active: boolean;
  preview: ImportPreview | null;
  project_id: string | null;
  input_directory: string | null;
  controller: AbortController | null;
  completion: Promise<unknown> | null;
  release_requested: boolean;
  expiry_timer?: ReturnType<typeof setTimeout>;
}

function throwIfImportAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Import operation cancelled", "AbortError");
  }
}

async function writeImportInput(
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  const file = await Deno.open(path, { write: true, createNew: true });
  try {
    for (let offset = 0; offset < bytes.byteLength;) {
      throwIfImportAborted(signal);
      const end = Math.min(offset + 1024 * 1024, bytes.byteLength);
      let written = 0;
      while (offset + written < end) {
        const count = await file.write(bytes.subarray(offset + written, end));
        if (count === 0) throw new Error("导入来源暂存写入没有进展");
        written += count;
      }
      offset = end;
    }
    await file.sync();
  } finally {
    file.close();
  }
}

async function materializeImportSources(
  sources: ImportSource[],
  signal: AbortSignal,
): Promise<{ sources: ImportSource[]; input_directory: string | null }> {
  if (!sources.some((source) => source.bytes !== undefined)) {
    return { sources, input_directory: null };
  }
  const inputDirectory = await Deno.makeTempDir({
    prefix: "acw-import-preview-",
  });
  try {
    const materialized: ImportSource[] = [];
    for (let index = 0; index < sources.length; index += 1) {
      throwIfImportAborted(signal);
      const source = sources[index]!;
      if (source.bytes === undefined) {
        materialized.push(source);
        continue;
      }
      const bytes = typeof source.bytes === "string"
        ? new TextEncoder().encode(source.bytes)
        : source.bytes;
      const path = join(inputDirectory, `source-${index}.bin`);
      await writeImportInput(path, bytes, signal);
      const { bytes: _bytes, ...descriptor } = source;
      materialized.push({ ...descriptor, path });
    }
    return { sources: materialized, input_directory: inputDirectory };
  } catch (caught) {
    await Deno.remove(inputDirectory, { recursive: true });
    throw caught;
  }
}

/** Small composition root for the UI bridge; all system access stays behind it. */
export class DesktopService {
  readonly store: ProjectDirectoryStore;
  /** Browser reader metadata is separate from canonical project storage. */
  readonly browserSession: BrowserSessionStore;
  /**
   * §4 app-level project registry. Rebuildable convenience state, never
   * Canonical: id / path / title / last-opened only. The desktop shell keeps it
   * in app-local data; this shell owns one configured root, so it keeps the same
   * `.workspace/projects.json` beside that root like its session and AI side
   * files do.
   */
  readonly projectRegistry: ProjectRegistryStore;
  readonly events = new EventBus();
  readonly jobs = new JobManager();
  readonly audit = new AuditLog();
  readonly secrets: SecretStore;
  readonly diagnostics: DiagnosticLogger;
  readonly search: SearchService;
  readonly connectors = new ConnectorRegistry();
  readonly context: CommandContext;
  readonly commands: CommandBus;
  readonly queries: QueryBus;
  private readonly importPreviews = new Map<string, ImportPreviewSlot>();
  private readonly exportArtifacts = new Map<string, ExportArtifactSlot>();
  /** In-flight `ai.complete` requests, shared across project directories. */
  private readonly aiRequests = new Map<string, AbortController>();
  private readonly aiOptions: AiTransportOptions;
  private aiTransportInstance: AiTransport | null = null;
  private aiTransportDirectory: string | null = null;
  private closing = false;

  constructor(
    directory: string,
    options: ProjectDirectoryOptions = {},
    secrets: SecretStore = new MacKeychainSecretStore(),
    aiOptions: AiTransportOptions = {},
  ) {
    this.store = new ProjectDirectoryStore(directory, options);
    this.browserSession = new BrowserSessionStore(this.store.directory);
    this.projectRegistry = new ProjectRegistryStore(this.store.directory);
    this.aiOptions = aiOptions;
    this.diagnostics = new DiagnosticLogger(
      join(directory, ".workspace", "diagnostics"),
    );
    this.search = new SearchService(
      options.read_only
        ? new MemorySearchIndex()
        : createSearchIndex(join(directory, ".workspace")),
    );
    this.secrets = secrets;
    this.context = {
      project: null,
      eventBus: this.events,
      audit: this.audit,
      source: "user",
    };
    this.commands = new CommandBus(
      this.context,
      undefined,
      async (safe, command) => {
        await this.diagnostics.write(
          safe.severity === "fatal" ? "fatal" : "error",
          safe.code,
          safe.technical_message,
          { command, severity: safe.severity, ...safe.details },
        );
      },
    );
    this.queries = new QueryBus(this.context);
    this.registerCommands();
    this.registerQueries();
  }

  private async rebuildSearchAfterWrite(
    project: ProjectData,
  ): Promise<string | null> {
    try {
      await this.search.rebuild(project);
      return null;
    } catch {
      return "课程内容已保存，但搜索索引更新失败。";
    }
  }

  private assertServiceOpen(): void {
    if (this.closing) {
      throw error(
        "service_closed",
        "工作台服务正在关闭，请重新启动后重试。",
        "Import preview reservation resumed after service shutdown began",
        { recoverable: false, recommended_action: null, details: { stage: "service_shutdown", commit_state: "not_committed", retryable: false } },
      );
    }
  }

  private mutationAck(
    binding: CanonicalMutationBinding,
    project: ProjectData,
    fingerprint: FileFingerprint,
    outcome: "written" | "unchanged" = "written",
    recoveryWarning: string | null = null,
    durabilityWarning: string | null = null,
  ) {
    return {
      project: structuredClone(project),
      fingerprint: structuredClone(fingerprint),
      project_id: binding.project_id,
      project_dir: binding.project_dir,
      lease_generation: binding.lease_generation,
      editor_generation: binding.editor_generation,
      operation_id: binding.operation_id,
      revision: binding.revision,
      commit_state: "committed" as const,
      outcome,
      recovery_warning: recoveryWarning,
      durability_warning: durabilityWarning,
    };
  }

  private async commitCanonicalMutation(data: ProjectData, input: unknown) {
    const binding = canonicalMutationBinding(
      input,
      this.store,
      this.context.project?.project.id ?? null,
    );
    const saved = binding
      ? await this.store.saveBound(data, projectSaveBinding(binding))
      : await this.store.saveWithRecovery(data);
    const outcome: "written" | "unchanged" = "outcome" in saved &&
        (saved.outcome === "written" || saved.outcome === "unchanged")
      ? saved.outcome
      : "written";
    // Keep the active context object stable for command callers holding a
    // reference, while the report and mutation acknowledgement stay detached
    // from later handler edits.
    const project = structuredClone(saved.project);
    const activeProject = this.context.project?.project.id === project.project.id
      ? this.context.project
      : data;
    Object.assign(activeProject, structuredClone(project));
    this.context.project = activeProject;
    const searchWarning = await this.rebuildSearchAfterWrite(activeProject);
    const durabilityWarning = [saved.durability_warning, searchWarning]
      .filter(Boolean).join(" ") || null;
    const mutation_ack = binding
      ? this.mutationAck(
        binding,
        project,
        saved.fingerprint,
        outcome,
        saved.recovery_warning,
        durabilityWarning,
      )
      : undefined;
    return {
      project,
      fingerprint: saved.fingerprint,
      recovery_warning: saved.recovery_warning,
      durability_warning: durabilityWarning,
      outcome,
      ...(mutation_ack ? { mutation_ack } : {}),
    };
  }

  private registerCommands(): void {
    this.commands.register("project.read_state", async () => {
      const state = await this.store.readProjectSnapshot();
      return {
        value: {
          ...state,
          project_id: state.project?.project.id ?? null,
          project_dir: this.store.directory,
          lease_generation: null,
        },
      };
    });
    this.commands.register("project.open_state", async () => {
      const state = await this.store.readProjectState();
      const recovery_journal = await this.store.readRecoveryJournal(state.project);
      this.context.project = state.project;
      if (state.project) await this.rebuildSearchAfterWrite(state.project);
      return {
        value: {
          ...state,
          recovery_journal,
          project_id: state.project?.project.id ?? null,
          project_dir: this.store.directory,
          lease_generation: this.store.leaseGeneration,
        },
      };
    });
    this.commands.register("project.recovery.clear", async (input) => {
      const binding = canonicalMutationBinding(
        input,
        this.store,
        this.context.project?.project.id ?? null,
      );
      if (!binding) {
        throw error(
          "mutation_binding_required",
          "恢复记录请求绑定无效，请重新打开课程后重试。",
          "Recovery clear requires a complete project mutation binding",
          { recoverable: false, recommended_action: null, details: { stage: "request_binding", commit_state: "not_committed", retryable: false } },
        );
      }
      const candidate = input as Record<string, unknown>;
      if (
        typeof candidate.expected_transaction_id !== "string" ||
        !candidate.expected_transaction_id ||
        candidate.expected_transaction_id.length > 256
      ) {
        throw error(
          "recovery_binding_invalid",
          "恢复记录请求无效，请重新打开课程后重试。",
          "Recovery clear requires the exact visible journal transaction id",
          { recoverable: false, recommended_action: null, details: { stage: "recovery_binding", commit_state: "not_committed", retryable: false } },
        );
      }
      const outcome = await this.store.clearRecoveryJournal(
        projectSaveBinding(binding),
        candidate.expected_transaction_id,
      );
      return {
        value: {
          ...outcome,
          project_id: binding.project_id,
          project_dir: binding.project_dir,
          lease_generation: binding.lease_generation,
          editor_generation: binding.editor_generation,
          operation_id: binding.operation_id,
          revision: binding.revision,
        },
        audit: {
          object_type: "recovery_journal",
          object_id: outcome.transaction_id ?? candidate.expected_transaction_id,
          action: outcome.cleared ? "clear" : "already_clear",
          metadata: { durability_warning: outcome.durability_warning },
        },
      };
    });
    this.commands.register("project.open", async () => {
      try {
        this.context.project = await this.store.readProject();
      } catch (caught) {
        if (caught instanceof Deno.errors.NotFound) {
          this.context.project = null;
          return { value: null };
        }
        throw caught;
      }
      if (!this.context.project) return { value: null };
      await this.rebuildSearchAfterWrite(this.context.project);
      return {
        value: this.context.project,
        audit: {
          object_type: "project",
          object_id: this.context.project.project.id,
          action: "open",
        },
      };
    });
    // Read-only folder classification for the launcher. Mirrors the native
    // `project_inspect` command: no lock, no writes, structured `status` and
    // `problem` so the UI never has to parse an error string.
    this.commands.register("project.inspect", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as { path?: string; project_dir?: string; folder_path?: string }
        : {};
      const path = String(
        candidate.path ?? candidate.project_dir ?? candidate.folder_path ?? "",
      ).trim();
      if (!path) {
        throw new Error("project.inspect requires an absolute folder path");
      }
      const inspection = await inspectProjectDirectory(path);
      return {
        value: inspection,
        audit: {
          object_type: "project",
          action: "project_inspect",
          metadata: { status: inspection.status, path },
        },
      };
    });
    // ---- §4 project registry (browser twin of `registry.rs`) ---------------
    // App-level, rebuildable, and usable before any project is open: these four
    // commands carry id / path / title / a last-opened hint and nothing else.
    this.commands.register("registry.list", async () => {
      const listed = await this.projectRegistry.list();
      return {
        value: listed,
        audit: {
          object_type: "project_registry",
          action: "list",
          metadata: { project_count: listed.projects.length },
        },
      };
    });
    this.commands.register("registry.record", async (input) => {
      const outcome = await this.projectRegistry.record(input);
      return {
        value: outcome,
        audit: {
          object_type: "project_registry",
          object_id: outcome.project?.project_id ?? null,
          action: outcome.status,
        },
      };
    });
    this.commands.register("registry.remove", async (input) => {
      const result = await this.projectRegistry.remove(input);
      return {
        value: result,
        audit: {
          object_type: "project_registry",
          object_id: result.project_id,
          action: "remove",
          metadata: { removed: result.removed },
        },
      };
    });
    this.commands.register("registry.relocate", async (input) => {
      const result = await this.projectRegistry.relocate(input);
      return {
        value: { status: result.status, project: result.project },
        audit: {
          object_type: "project_registry",
          object_id: result.project.project_id,
          action: "relocate",
        },
      };
    });
    this.commands.register("project.create", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as { title?: string; description?: string; language?: string }
        : {};
      this.context.project = createEmptyProjectData(
        candidate.title ?? "未命名课程",
        candidate.description ?? "",
        candidate.language ?? "zh-CN",
      );
      await this.store.writeProject(this.context.project);
      await this.rebuildSearchAfterWrite(this.context.project);
      return {
        value: this.context.project,
        events: [EventBus.domainEvent({
          type: "ProjectChanged",
          project_id: this.context.project.project.id,
          entity_type: "project",
          entity_id: this.context.project.project.id,
          source: "user",
          metadata: { action: "created" },
        })],
        audit: {
          object_type: "project",
          object_id: this.context.project.project.id,
          action: "create",
        },
      };
    });
    this.commands.register("project.save", async (input) => {
      if (!input || typeof input !== "object") {
        throw new Error("project.save requires project data");
      }
      const envelope = input as {
        project_dir?: unknown;
        expected_project_id?: unknown;
        lease_generation?: unknown;
        editor_generation?: unknown;
        operation_id?: unknown;
        revision?: unknown;
        project?: unknown;
        expected_fingerprint?: unknown;
        recovery_metadata?: unknown;
      };
      const nested = envelope.project;
      const candidate = nested && typeof nested === "object" &&
          "project" in nested
        ? nested as ProjectData
        : input as ProjectData;
      const hasBoundFields = [
        "project_dir",
        "expected_project_id",
        "lease_generation",
        "editor_generation",
        "operation_id",
        "revision",
        "recovery_metadata",
      ].some((key) => Object.hasOwn(envelope, key));
      if (!hasBoundFields) {
        if (!isFileFingerprint(envelope.expected_fingerprint)) {
          throw error(
            "save_baseline_required",
            "保存基线已失效。请重新载入课程后再保存。",
            "project.save requires the fingerprint of the project snapshot loaded by this client",
            {
              recoverable: true,
              recommended_action: "重新载入磁盘版本或合并修改后再保存。",
              details: {},
            },
          );
        }
        const saved = await this.store.saveWithRecovery(
          candidate,
          envelope.expected_fingerprint,
        );
        this.context.project = saved.project;
        const searchWarning = await this.rebuildSearchAfterWrite(saved.project);
        return {
          value: {
            project: saved.project,
            fingerprint: saved.fingerprint,
            recovery_warning: saved.recovery_warning,
            durability_warning: [saved.durability_warning, searchWarning]
              .filter(Boolean).join(" ") || null,
          },
          audit: {
            object_type: "project",
            object_id: saved.project.project.id,
            action: "save",
          },
        };
      }
      if (!nested || typeof nested !== "object" || !("project" in nested)) {
        throw error(
          "save_binding_required",
          "保存绑定信息缺失，请重新打开课程后再保存。",
          "project.save requires a bound project envelope",
          { recoverable: true, recommended_action: null, details: { stage: "binding_validate", commit_state: "not_committed", retryable: false } },
        );
      }
      if (
        typeof envelope.project_dir !== "string" ||
        normalize(envelope.project_dir) !== this.store.directory ||
        typeof envelope.expected_project_id !== "string" ||
        !envelope.expected_project_id.trim() ||
        typeof envelope.lease_generation !== "string" ||
        !envelope.lease_generation.trim() ||
        typeof envelope.operation_id !== "string" ||
        !envelope.operation_id.trim() ||
        !Number.isSafeInteger(envelope.editor_generation) ||
        Number(envelope.editor_generation) < 0 ||
        !Number.isSafeInteger(envelope.revision) ||
        Number(envelope.revision) < 0 ||
        !isFileFingerprint(envelope.expected_fingerprint)
      ) {
        throw error(
          "save_binding_invalid",
          "保存绑定信息或课程目录无效，请重新打开课程后再保存。",
          "project.save requires the active project path plus valid project, lease, editor, operation, revision, and fingerprint bindings",
          {
            recoverable: true,
            recommended_action: "重新打开课程后再保存。",
            details: { stage: "binding_validate", commit_state: "not_committed", retryable: false },
          },
        );
      }
      const saved = await this.store.saveBound(candidate, {
        expected_project_id: envelope.expected_project_id,
        lease_generation: envelope.lease_generation,
        editor_generation: Number(envelope.editor_generation),
        operation_id: envelope.operation_id,
        revision: Number(envelope.revision),
        expected_fingerprint: envelope.expected_fingerprint,
        recovery_metadata: envelope.recovery_metadata,
      });
      this.context.project = candidate;
      const searchWarning = saved.outcome === "unchanged"
        ? null
        : await this.rebuildSearchAfterWrite(candidate);
      return {
        value: {
          fingerprint: saved.fingerprint,
          project_id: envelope.expected_project_id,
          project_dir: this.store.directory,
          lease_generation: this.store.leaseGeneration,
          editor_generation: Number(envelope.editor_generation),
          operation_id: envelope.operation_id,
          revision: Number(envelope.revision),
          outcome: saved.outcome,
          commit_state: "committed",
          recovery_warning: saved.recovery_warning,
          durability_warning: [saved.durability_warning, searchWarning]
            .filter(Boolean).join(" ") || null,
        },
        audit: {
          object_type: "project",
          object_id: candidate.project.id,
          action: "save",
        },
      };
    });
    this.commands.register("project.external.inspect", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as { project?: ProjectData }
        : {};
      return {
        value: await this.store.inspectExternalModification(
          candidate.project ?? this.context.project,
        ),
      };
    });
    this.commands.register("project.reload", async () => {
      const state = await this.store.readProjectState();
      this.context.project = state.project;
      if (state.project) await this.rebuildSearchAfterWrite(state.project);
      return {
        value: state,
        audit: {
          object_type: "project",
          object_id: state.project?.project.id,
          action: "reload_external",
        },
      };
    });
    this.commands.register("project.merge", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as { project?: ProjectData }
        : {};
      const local = candidate.project ?? this.context.project;
      if (!local) throw new Error("No project is open");
      return { value: await this.store.mergeExternalChanges(local) };
    });
    this.commands.register("project.resolve", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as {
          project?: ProjectData;
          expected_current?: FileFingerprint;
        }
        : {};
      if (!candidate.project || !candidate.expected_current) {
        throw new Error(
          "project.resolve requires project and expected_current",
        );
      }
      const binding = canonicalMutationBinding(
        input,
        this.store,
        this.context.project?.project.id ?? null,
      );
      if (
        binding &&
        !sameFingerprint(binding.expected_fingerprint, candidate.expected_current)
      ) {
        throw error(
          "mutation_binding_invalid",
          "冲突处理指纹与当前选择的磁盘版本不匹配。",
          "project.resolve expected_fingerprint must be the user-confirmed expected_current",
          { recoverable: false, recommended_action: null, details: { stage: "fingerprint_validate", commit_state: "not_committed", retryable: false } },
        );
      }
      const resolvedProject = structuredClone(candidate.project);
      const written = await this.store.resolveExternalChanges(
        resolvedProject,
        candidate.expected_current,
        binding ? projectSaveBinding(binding) : undefined,
      );
      this.context.project = resolvedProject;
      const searchWarning = await this.rebuildSearchAfterWrite(resolvedProject);
      const durabilityWarning = [written.durability_warning, searchWarning]
        .filter(Boolean).join(" ") || null;
      return {
        value: {
          project: resolvedProject,
          fingerprint: written.fingerprint,
          durability_warning: durabilityWarning,
        },
        ...(binding
          ? {
            mutation_ack: this.mutationAck(
              binding,
              resolvedProject,
              written.fingerprint,
              "written",
              null,
              durabilityWarning,
            ),
          }
          : {}),
        audit: {
          object_type: "project",
          object_id: resolvedProject.project.id,
          action: "resolve_external",
        },
      };
    });
    this.commands.register("course.seed.create", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const data = structuredClone(this.context.project);
      const candidate = input && typeof input === "object"
        ? input as {
          source_type?: Parameters<typeof createCourseSeed>[1]["source_type"];
          raw_text?: string | null;
          source_files?: Parameters<typeof createCourseSeed>[1]["source_files"];
          metadata?: Parameters<typeof createCourseSeed>[1]["metadata"];
        }
        : {};
      const seed = createCourseSeed(data, {
        source_type: candidate.source_type ?? "blank",
        raw_text: candidate.raw_text ?? null,
        source_files: candidate.source_files,
        metadata: candidate.metadata,
      });
      const committed = await this.commitCanonicalMutation(
        data,
        input,
      );
      return {
        value: seed,
        ...(committed.mutation_ack ? { mutation_ack: committed.mutation_ack } : {}),
        audit: {
          object_type: "course_seed",
          object_id: seed.id,
          action: "create",
        },
      };
    });
    this.commands.register("blueprint.build", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const data = structuredClone(this.context.project);
      const candidate = input && typeof input === "object"
        ? input as { course_seed_id?: string }
        : {};
      if (!candidate.course_seed_id) {
        throw new Error("blueprint.build requires course_seed_id");
      }
      const draft = buildBlueprintDraft(
        data,
        candidate.course_seed_id,
      );
      const committed = await this.commitCanonicalMutation(
        data,
        input,
      );
      return {
        value: {
          draft,
          nodes: committed.project.blueprint_nodes.filter((node) =>
            node.blueprint_id === draft.id
          ),
        },
        ...(committed.mutation_ack ? { mutation_ack: committed.mutation_ack } : {}),
        audit: {
          object_type: "blueprint_draft",
          object_id: draft.id,
          action: "build",
        },
      };
    });
    this.commands.register("blueprint.confirm", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as { blueprint_id?: string; draft_id?: string }
        : {};
      const draftId = candidate.blueprint_id ?? candidate.draft_id;
      if (!draftId) throw new Error("blueprint.confirm requires draft_id");
      confirmBlueprint(this.context.project, draftId);
      await this.store.saveWithRecovery(this.context.project);
      await this.rebuildSearchAfterWrite(this.context.project);
      return {
        value: this.context.project,
        audit: {
          object_type: "blueprint_draft",
          object_id: draftId,
          action: "confirm",
        },
      };
    });
    this.commands.register("blueprint.discard", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as { blueprint_id?: string; draft_id?: string }
        : {};
      const draftId = candidate.blueprint_id ?? candidate.draft_id;
      if (!draftId) throw new Error("blueprint.discard requires draft_id");
      discardBlueprint(this.context.project, draftId);
      await this.store.saveWithRecovery(this.context.project);
      await this.rebuildSearchAfterWrite(this.context.project);
      return {
        value: this.context.project.blueprint_drafts.find((draft) =>
          draft.id === draftId
        ),
        audit: {
          object_type: "blueprint_draft",
          object_id: draftId,
          action: "discard",
        },
      };
    });
    this.commands.register("asset.preview_batch", async (input) => ({
      value: await readAssetPreviewBatch(this.store, input),
    }));
    this.commands.register("asset.import", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const data = structuredClone(this.context.project);
      const binding = canonicalMutationBinding(
        input,
        this.store,
        data.project.id,
      );
      const candidate = input && typeof input === "object"
        ? input as {
          source_path?: string;
          type?: AssetType;
          filename?: string;
          mime_type?: string;
          title?: string;
          description?: string;
          content_item_id?: string | null;
          block_id?: string | null;
          layout_instance_id?: string | null;
          role?: string | null;
        }
        : {};
      let sourcePath = candidate.source_path;
      let temporaryPath: string | null = null;
      const withBytes = candidate as typeof candidate & {
        bytes_base64?: unknown;
      };
      if (!sourcePath && typeof withBytes.bytes_base64 === "string") {
        temporaryPath = await Deno.makeTempFile({ suffix: "-asset" });
        await Deno.writeFile(
          temporaryPath,
          decodeBase64(withBytes.bytes_base64),
        );
        sourcePath = temporaryPath;
      }
      if (!sourcePath) {
        throw new Error("asset.import requires source_path or bytes_base64");
      }
      let result;
      try {
        result = await this.store.importAssetFile(
          data,
          sourcePath,
          {
            type: candidate.type ?? "other",
            mime_type: candidate.mime_type ?? "application/octet-stream",
            title: candidate.title,
            description: candidate.description,
            filename: candidate.filename,
          },
          "existing",
          binding ? projectSaveBinding(binding) : undefined,
        );
      } finally {
        if (temporaryPath) {
          await Deno.remove(temporaryPath).catch(() => undefined);
        }
      }
      const contentItemId = typeof candidate.content_item_id === "string"
        ? candidate.content_item_id.trim()
        : "";
      const blockId = typeof candidate.block_id === "string" &&
          candidate.block_id.trim()
        ? candidate.block_id.trim()
        : null;
      const layoutInstanceId =
        typeof candidate.layout_instance_id === "string" &&
          candidate.layout_instance_id.trim()
          ? candidate.layout_instance_id.trim()
          : null;
      const role = typeof candidate.role === "string" && candidate.role.trim()
        ? candidate.role.trim()
        : "content";
      let commitAttempted = false;
      try {
        const usage = contentItemId
          ? addAssetUsage(data, result.asset.id, contentItemId, {
            block_id: blockId,
            layout_instance_id: layoutInstanceId,
            role,
          })
          : null;
        commitAttempted = true;
        const committed = await this.commitCanonicalMutation(data, input);
        return {
          value: { ...result, usage },
          ...(committed.mutation_ack
            ? { mutation_ack: committed.mutation_ack }
            : {}),
          audit: {
            object_type: "asset",
            object_id: result.asset.id,
            action: "import",
          },
        };
      } catch (caught) {
        const details = caught instanceof ServiceError
          ? caught.error.details
          : {};
        if (
          !result.duplicate && (!commitAttempted || details.commit_state === "not_committed")
        ) {
          await this.store.discardUncommittedAssetFile(
            result.asset.id,
            result.asset.storage_path,
          ).catch(() => undefined);
        }
        throw caught;
      }
    });
    // Item 13 — rename the managed asset file on disk and synchronise every
    // canonical reference. Reversible by calling again with the previous name,
    // which is how the frontend Undo/Redo layer drives it.
    this.commands.register("asset.rename", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const data = structuredClone(this.context.project);
      const binding = canonicalMutationBinding(
        input,
        this.store,
        data.project.id,
      );
      const candidate = input && typeof input === "object"
        ? input as {
          asset_id?: string;
          assetId?: string;
          new_name?: string;
          newName?: string;
        }
        : {};
      const assetId = String(candidate.asset_id ?? candidate.assetId ?? "")
        .trim();
      const newName = String(candidate.new_name ?? candidate.newName ?? "");
      if (!assetId) throw new Error("asset.rename requires asset_id");
      const outcome = await this.store.renameManagedAsset(
        data,
        assetId,
        newName,
        binding ? projectSaveBinding(binding) : undefined,
      );
      this.context.project = outcome.project;
      const searchWarning = outcome.outcome === "unchanged"
        ? null
        : await this.rebuildSearchAfterWrite(this.context.project);
      const durabilityWarning = [outcome.durability_warning, searchWarning]
        .filter(Boolean).join(" ") || null;
      const renamed = outcome.project.assets.find((asset) =>
        asset.id === assetId
      ) ?? null;
      return {
        value: {
          status: outcome.status,
          asset: renamed,
          // Parity with the native shell: the rename rewrites references across
          // collections, so the caller replaces its copy from this payload.
          project: outcome.project,
          rewritten: outcome.rewritten,
          old_storage_path: outcome.plan.old_storage_path,
          new_storage_path: outcome.plan.new_storage_path,
          old_filename: outcome.plan.old_filename,
          new_filename: outcome.plan.new_filename,
        },
        ...(binding && outcome.fingerprint
          ? {
            mutation_ack: this.mutationAck(
              binding,
              outcome.project,
              outcome.fingerprint,
              outcome.outcome ?? "written",
              null,
              durabilityWarning,
            ),
          }
          : {}),
        events: [EventBus.domainEvent({
          type: "ProjectChanged",
          project_id: this.context.project.project.id,
          entity_type: "asset",
          entity_id: assetId,
          source: "user",
          metadata: { action: "rename" },
        })],
        audit: {
          object_type: "asset",
          object_id: assetId,
          action: "rename",
        },
      };
    });
    this.commands.register("inbox.create", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          title?: string;
          body?: string;
          source_type?: string;
          asset_id?: string | null;
        }
        : {};
      const item = createInboxItem(this.context.project, {
        title: candidate.title ?? "快速收集",
        body: candidate.body ?? "",
        source_type: candidate.source_type,
        asset_id: candidate.asset_id,
      });
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: item,
        audit: {
          object_type: "inbox_item",
          object_id: item.id,
          action: "create",
        },
      };
    });
    this.commands.register("inbox.triage", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as { inbox_item_id?: string; content_item_id?: string | null }
        : {};
      if (!candidate.inbox_item_id) {
        throw new Error("inbox.triage requires inbox_item_id");
      }
      const item = triageInboxItem(
        this.context.project,
        candidate.inbox_item_id,
        candidate.content_item_id,
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: item,
        audit: {
          object_type: "inbox_item",
          object_id: item.id,
          action: "triage",
        },
      };
    });
    this.commands.register("inbox.assetize", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          inbox_item_id?: string;
          asset_id?: string;
          bytes_base64?: string;
          filename?: string;
          type?: AssetType;
          mime_type?: string;
        }
        : {};
      if (!candidate.inbox_item_id) {
        throw new Error("inbox.assetize requires inbox_item_id");
      }
      const item = this.context.project.inbox_items.find((entry) =>
        entry.id === candidate.inbox_item_id
      );
      if (!item) throw new Error("找不到收件箱条目");
      let asset = candidate.asset_id
        ? this.context.project.assets.find((entry) =>
          entry.id === candidate.asset_id
        )
        : null;
      if (candidate.asset_id && !asset) throw new Error("找不到要关联的素材");
      if (
        asset &&
        (asset.project_id !== this.context.project.project.id || asset.archived)
      ) {
        throw new Error("素材不能关联到当前项目");
      }
      if (!asset && typeof candidate.bytes_base64 === "string") {
        const temporaryPath = await Deno.makeTempFile({ suffix: "-asset" });
        try {
          await Deno.writeFile(
            temporaryPath,
            decodeBase64(candidate.bytes_base64),
          );
          asset = (await this.store.importAssetFile(
            this.context.project,
            temporaryPath,
            {
              type: candidate.type ?? "other",
              mime_type: candidate.mime_type ?? "application/octet-stream",
              filename: candidate.filename ?? item.title,
            },
            "existing",
          )).asset;
        } finally {
          await Deno.remove(temporaryPath).catch(() => undefined);
        }
      }
      if (!asset) throw new Error("收件箱条目没有可保存的素材内容");
      item.asset_id = asset.id;
      item.updated_at = new Date().toISOString();
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: { item, asset },
        audit: {
          object_type: "inbox_item",
          object_id: item.id,
          action: "assetize",
        },
      };
    });
    this.commands.register("status.assign", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          content_item_id?: string;
          dimension_key?: string;
          option_key?: string;
        }
        : {};
      if (
        !candidate.content_item_id || !candidate.dimension_key ||
        !candidate.option_key
      ) {
        throw new Error(
          "status.assign requires content_item_id, dimension_key, and option_key",
        );
      }
      const assignment = assignStatus(
        this.context.project,
        candidate.content_item_id,
        candidate.dimension_key,
        candidate.option_key,
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: assignment,
        audit: {
          object_type: "status_assignment",
          object_id: assignment.id,
          action: "assign",
        },
      };
    });
    this.commands.register("document.reorder", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as { content_item_id?: string; block_ids?: string[] }
        : {};
      if (!candidate.content_item_id || !Array.isArray(candidate.block_ids)) {
        throw new Error(
          "document.reorder requires content_item_id and block_ids",
        );
      }
      reorderBlocks(
        this.context.project,
        candidate.content_item_id,
        candidate.block_ids,
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: this.context.project.blocks.filter((block) =>
          candidate.block_ids?.includes(block.id)
        ).sort((a, b) => a.order_index - b.order_index),
        audit: {
          object_type: "document",
          object_id: candidate.content_item_id,
          action: "reorder",
        },
      };
    });
    this.commands.register("requirement.resolve", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          requirement_id?: string;
          resolved_asset_id?: string | null;
          resolved_block_id?: string | null;
        }
        : {};
      if (!candidate.requirement_id) {
        throw new Error("requirement.resolve requires requirement_id");
      }
      const requirement = resolveRequirement(
        this.context.project,
        candidate.requirement_id,
        candidate.resolved_asset_id ?? null,
        candidate.resolved_block_id ?? null,
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: requirement,
        audit: {
          object_type: "requirement",
          object_id: requirement.id,
          action: "resolve",
        },
      };
    });
    this.commands.register("layout.create", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          content_item_id?: string;
          name?: string;
          mode?: "flow" | "grid";
          grid_definition?: JsonObject;
        }
        : {};
      if (!candidate.content_item_id) {
        throw new Error("layout.create requires content_item_id");
      }
      const layout = createLayoutInstance(
        this.context.project,
        candidate.content_item_id,
        {
          name: candidate.name ?? "默认排版",
          mode: candidate.mode ?? "grid",
          grid_definition: candidate.grid_definition ??
            { columns: [1, 1, 1], rows: [1, 1, 1] },
        },
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: layout,
        audit: {
          object_type: "layout",
          object_id: layout.id,
          action: "create",
        },
      };
    });
    this.commands.register("layout.section.create", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          layout_instance_id?: string;
          name?: string;
          page_index?: number;
        }
        : {};
      if (!candidate.layout_instance_id) {
        throw new Error("layout.section.create requires layout_instance_id");
      }
      const section = addLayoutSection(
        this.context.project,
        candidate.layout_instance_id,
        {
          name: candidate.name ?? "新分区",
          page_index: candidate.page_index,
        },
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: section,
        audit: {
          object_type: "layout_section",
          object_id: section.id,
          action: "create",
        },
      };
    });
    this.commands.register("placement.create", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          layout_instance_id?: string;
          block_id?: string;
          section_id?: string | null;
          row_start?: number;
          row_end?: number;
          column_start?: number;
          column_end?: number;
        }
        : {};
      if (!candidate.layout_instance_id || !candidate.block_id) {
        throw new Error(
          "placement.create requires layout_instance_id and block_id",
        );
      }
      const placement = addPlacement(
        this.context.project,
        candidate.layout_instance_id,
        candidate.block_id,
        {
          section_id: candidate.section_id,
          row_start: candidate.row_start ?? 0,
          row_end: candidate.row_end ?? 1,
          column_start: candidate.column_start ?? 0,
          column_end: candidate.column_end ?? 1,
        },
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: placement,
        audit: {
          object_type: "placement",
          object_id: placement.id,
          action: "create",
        },
      };
    });
    this.commands.register("import.preview", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as {
          sources?: ImportSource[];
          mode?: "content" | "blueprint" | "asset" | "project";
          preview_id?: string;
        }
        : {};
      const id = candidate.preview_id?.trim() || crypto.randomUUID();
      const slot = await this.reserveImportPreview(
        id,
        this.context.project?.project.id ?? null,
      );
      const controller = slot.controller!;
      const operation = (async () => {
        const materialized = await materializeImportSources(
          normalizeImportSources(candidate.sources),
          controller.signal,
        );
        slot.input_directory = materialized.input_directory;
        throwIfImportAborted(controller.signal);
        return await previewImport(materialized.sources, {
          data: this.context.project,
          mode: candidate.mode,
          preview_id: id,
          signal: controller.signal,
        });
      })();
      slot.completion = operation.then(() => undefined, () => undefined);
      let preview: ImportPreview;
      try {
        preview = await operation;
        slot.preview = preview;
      } catch (caught) {
        slot.active = false;
        await this.disposeImportPreview(id, slot);
        throw caught;
      } finally {
        slot.active = false;
        slot.controller = null;
        slot.completion = null;
      }
      if (
        slot.release_requested ||
        Date.now() - slot.created_at >= IMPORT_PREVIEW_TTL_MS
      ) {
        await this.disposeImportPreview(id, slot);
        throw new Error("导入预览已取消或过期，请重新选择文件");
      }
      this.scheduleImportPreviewExpiry(
        id,
        slot,
        Math.max(1, IMPORT_PREVIEW_TTL_MS - (Date.now() - slot.created_at)),
      );
      return {
        value: preview,
        audit: {
          object_type: "import",
          action: "preview",
          metadata: { count: preview.items.length, mode: preview.mode },
        },
      };
    });
    this.commands.register("import.preview.release", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as { preview_id?: unknown }
        : {};
      const id = typeof candidate.preview_id === "string"
        ? candidate.preview_id
        : "";
      const released = id ? await this.releaseImportPreview(id) : false;
      return {
        value: { released },
        audit: {
          object_type: "import",
          action: "release_preview",
          metadata: { released },
        },
      };
    });
    // Read-only folder scan for 导入已有文件夹. Does not require an open
    // project and must not write project.json (V1-T04 Task 9).
    this.commands.register("folder.scan", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as { path?: string; folder_path?: string; root?: string }
        : {};
      const path = String(
        candidate.path ?? candidate.folder_path ?? candidate.root ?? "",
      ).trim();
      if (!path) {
        throw new Error("folder.scan requires an absolute folder path");
      }
      const report = await scanFolder(path);
      return {
        value: report,
        audit: {
          object_type: "import",
          action: "folder_scan",
          metadata: {
            count: report.entries.length,
            root: report.root,
          },
        },
      };
    });
    // Recursive visual-media discovery for one SELECTED directory row. The
    // Mapping Preview root listing stays direct-children-only; this command is
    // the only path that walks below a user-chosen folder.
    this.commands.register("folder.scan_media", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as {
          root?: string;
          path?: string;
          folder_path?: string;
          relative_dir?: string;
          relative_path?: string;
        }
        : {};
      const root = String(
        candidate.root ?? candidate.path ?? candidate.folder_path ?? "",
      ).trim();
      const relativeDir = String(
        candidate.relative_dir ?? candidate.relative_path ?? "",
      ).trim();
      if (!root) {
        throw new Error("folder.scan_media requires an absolute folder path");
      }
      const report = await scanMediaDescendants(root, relativeDir);
      return {
        value: report,
        audit: {
          object_type: "import",
          action: "folder_scan_media",
          metadata: {
            count: report.entries.length,
            root: report.root,
            relative_dir: report.relative_dir,
          },
        },
      };
    });
    this.commands.register("folder.scan_documents", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as { root?: string; plan?: ImportMappingPlan }
        : {};
      const root = String(candidate.root ?? candidate.plan?.root ?? "").trim();
      if (!root || !candidate.plan) {
        throw new Error(
          "folder.scan_documents requires a root and confirmed mapping plan",
        );
      }
      const report = await scanFolderDocuments(root, candidate.plan);
      return {
        value: report,
        audit: {
          object_type: "import",
          action: "folder_scan_documents",
          metadata: {
            count: report.groups.reduce(
              (total, group) => total + group.items.length,
              0,
            ),
            root: report.root,
          },
        },
      };
    });
    // Read-only preview for Workspace Explorer. Never writes project.json.
    this.commands.register("folder.read_preview", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as {
          root?: string;
          path?: string;
          relative_path?: string;
          relativePath?: string;
        }
        : {};
      const root = String(candidate.root ?? candidate.path ?? "").trim();
      const relativePath = String(
        candidate.relative_path ?? candidate.relativePath ?? "",
      ).trim();
      if (!root) {
        throw new Error("folder.read_preview requires the scanned root");
      }
      if (!relativePath) {
        throw new Error("folder.read_preview requires a relative_path");
      }
      const preview = await readFolderPreview(root, relativePath);
      return {
        value: preview,
        audit: {
          object_type: "import",
          action: "folder_read_preview",
          metadata: {
            root,
            relative_path: relativePath,
            preview_kind: preview.preview_kind,
          },
        },
      };
    });
    this.commands.register("folder.read_source", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as {
          root?: string;
          relative_path?: string;
          relativePath?: string;
        }
        : {};
      const root = String(candidate.root || "").trim();
      const relativePath = String(
        candidate.relative_path ?? candidate.relativePath ?? "",
      ).trim();
      if (!root || !relativePath) {
        throw new Error("folder.read_source requires root and relative_path");
      }
      const source = await readFolderSource(root, relativePath);
      return {
        value: source,
        audit: {
          object_type: "import",
          action: "folder_read_source",
          metadata: { root, relative_path: relativePath, size: source.size },
        },
      };
    });
    this.commands.register("folder.markdown_image_status", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as {
          root?: string;
          markdown_relative_path?: string;
          markdownRelativePath?: string;
          href?: string;
        }
        : {};
      const root = String(candidate.root || "").trim();
      const markdownRelativePath = String(
        candidate.markdown_relative_path ?? candidate.markdownRelativePath ??
          "",
      ).trim();
      const href = String(candidate.href || "");
      if (!root || !markdownRelativePath || !href) {
        throw new Error(
          "folder.markdown_image_status requires root, markdownRelativePath, and href",
        );
      }
      const status = await inspectMarkdownImage(
        root,
        markdownRelativePath,
        href,
      );
      return {
        value: status,
        audit: {
          object_type: "import",
          action: "folder_markdown_image_status",
          metadata: {
            root,
            relative_path: markdownRelativePath,
            status: status.status,
          },
        },
      };
    });
    // Strategy A in-place adoption. Requires a confirmed ImportMappingPlan.
    // Writes project.json + .workspace into plan.root; copies media to assets/.
    this.commands.register("folder.adopt", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as {
          plan?: ImportMappingPlan;
          duplicate_choice?: "existing" | "copy" | "cancel";
          document_paths?: string[];
          project_title?: string;
          replace_invalid_project?: boolean;
          editor_generation?: number;
          operation_id?: string;
          revision?: number;
        }
        : {};
      if (!candidate.plan) {
        throw new Error("folder.adopt requires a mapping plan");
      }
      if (candidate.plan.confirmed !== true) {
        throw new Error("只能对已确认的导入计划执行文件夹接管");
      }
      const hasTargetMutationCursor =
        Object.hasOwn(candidate, "editor_generation") ||
        Object.hasOwn(candidate, "operation_id") ||
        Object.hasOwn(candidate, "revision");
      if (hasTargetMutationCursor &&
        (!Number.isSafeInteger(candidate.editor_generation) ||
          (candidate.editor_generation as number) < 0 ||
          typeof candidate.operation_id !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.operation_id) ||
          !Number.isSafeInteger(candidate.revision) ||
          (candidate.revision as number) < 1)) {
        throw error(
          "mutation_binding_invalid",
          "文件夹接管请求绑定无效，请重新确认操作。",
          "folder.adopt requires a complete source editor generation, operation id and revision",
          { recoverable: false, recommended_action: null, details: { stage: "request_binding", commit_state: "not_committed", retryable: false } },
        );
      }
      const writeReceipt: {
        current: Awaited<ReturnType<ProjectDirectoryStore["writeProject"]>> | null;
      } = { current: null };
      const result = await confirmFolderAdoption(candidate.plan, {
        duplicate_choice: candidate.duplicate_choice,
        document_paths: candidate.document_paths,
        project_title: candidate.project_title,
        replace_invalid_project: candidate.replace_invalid_project === true,
        on_project_write: (report) => {
          writeReceipt.current = report;
        },
      });
      const writeReport = writeReceipt.current;
      // Adoption writes into plan.root (possibly ≠ this.store.directory).
      // Hand the adopted project to the caller; do not rebuild this service's
      // search index against the wrong workspace root.
      this.context.project = result.data;
      return {
        value: result,
        ...(hasTargetMutationCursor && writeReport
          ? {
            mutation_ack: {
              project: structuredClone(result.data),
              fingerprint: structuredClone(writeReport.fingerprint),
              project_id: result.data.project.id,
              project_dir: normalize(result.root),
              lease_generation: null,
              editor_generation: candidate.editor_generation,
              operation_id: candidate.operation_id,
              revision: candidate.revision,
              commit_state: "committed" as const,
              outcome: "written" as const,
              recovery_warning: null,
              durability_warning: writeReport.durability_warning,
            },
          }
          : {}),
        events: [EventBus.domainEvent({
          type: "ProjectChanged",
          project_id: result.data.project.id,
          entity_type: "project",
          entity_id: result.data.project.id,
          source: "user",
          metadata: { action: "folder_adopted" },
        })],
        audit: {
          object_type: "import",
          action: "folder_adopt",
          metadata: {
            root: result.root,
            stages: result.stage_ids.length,
            lessons: result.content_item_ids.length,
            assets: result.asset_ids.length,
            sources: result.source_ids.length,
            reused: result.reused_asset_ids.length,
          },
        },
      };
    });
    this.commands.register("folder.append", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as {
          plan?: ImportMappingPlan;
          duplicate_choice?: "existing" | "copy" | "cancel";
          document_paths?: string[];
        }
        : {};
      if (!candidate.plan) {
        throw new Error("folder.append requires a mapping plan");
      }
      if (candidate.plan.confirmed !== true) {
        throw new Error("只能对已确认的导入计划执行文件追加");
      }
      if (!this.context.project) {
        throw new Error("请先打开课程项目，再追加文件");
      }
      const data = structuredClone(this.context.project);
      const binding = canonicalMutationBinding(
        input,
        this.store,
        data.project.id,
      );
      const saveReceipt: { current: {
        project: ProjectData;
        fingerprint: FileFingerprint;
        recovery_warning?: string | null;
        durability_warning: string | null;
        outcome?: "written" | "unchanged";
      } | null } = { current: null };
      let fingerprint: FileFingerprint | null = null;
      let recoveryWarning: string | null = null;
      const result = await confirmFolderAdoption(candidate.plan, {
        data,
        project_root: this.store.directory,
        duplicate_choice: candidate.duplicate_choice,
        document_paths: candidate.document_paths,
        persist_project: async (project) => {
          saveReceipt.current = binding
            ? await this.store.saveBound(project, projectSaveBinding(binding))
            : await this.store.saveWithRecovery(project);
          fingerprint = saveReceipt.current.fingerprint;
          recoveryWarning = saveReceipt.current.recovery_warning ?? null;
        },
      });
      const saved = saveReceipt.current;
      const committedProject = saved?.project ?? result.data;
      this.context.project = committedProject;
      const searchWarning = await this.rebuildSearchAfterWrite(committedProject);
      const durabilityWarning = [saved?.durability_warning, searchWarning]
        .filter(Boolean).join(" ") || null;
      return {
        value: fingerprint
          ? {
            ...result,
            data: committedProject,
            fingerprint,
            recovery_warning: recoveryWarning,
            durability_warning: durabilityWarning,
          }
          : result,
        ...(binding && saved
          ? {
            mutation_ack: this.mutationAck(
              binding,
              saved.project,
              saved.fingerprint,
              saved.outcome ?? "written",
              saved.recovery_warning ?? null,
              durabilityWarning,
            ),
          }
          : {}),
        events: [EventBus.domainEvent({
          type: "ProjectChanged",
          project_id: result.data.project.id,
          entity_type: "project",
          entity_id: result.data.project.id,
          source: "user",
          metadata: { action: "files_appended" },
        })],
        audit: {
          object_type: "import",
          action: "folder_append",
          metadata: {
            source_root: candidate.plan.root,
            target_root: this.store.directory,
            lessons: result.content_item_ids.length,
            assets: result.asset_ids.length,
            sources: result.source_ids.length,
            reused: result.reused_asset_ids.length,
          },
        },
      };
    });
    this.commands.register("import.confirm", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          preview?: ImportPreview;
          preview_id?: string;
          options?: Parameters<typeof confirmImport>[2];
        }
        : {};
      const id = candidate.preview_id ?? candidate.preview?.id;
      if (!id) {
        throw new Error("import.confirm requires a preview");
      }
      await this.pruneImportPreviews();
      const slot = this.importPreviews.get(id);
      if (!slot?.preview) throw new Error("导入预览已释放或过期，请重新预览");
      if (slot.active) throw new Error("导入预览正在处理中，请稍后重试");
      if (slot.project_id !== this.context.project.project.id) {
        await this.disposeImportPreview(id, slot);
        throw new Error("当前项目已变化，请重新预览导入内容");
      }
      const preview = slot.preview;
      const controller = new AbortController();
      slot.controller = controller;
      slot.active = true;
      slot.release_requested = false;
      const operation = (async () => {
        const candidateProject = structuredClone(this.context.project!);
        const result = await confirmImport(
          candidateProject,
          preview,
          {
            ...(candidate.options ?? {}),
            project_root: this.store.directory,
            signal: controller.signal,
          },
        );
        throwIfImportAborted(controller.signal);
        const committedProject = result.project ?? candidateProject;
        const saved = await this.store.saveWithRecovery(
          committedProject,
          undefined,
          { allow_project_identity_change: Boolean(result.project) },
        );
        if (result.project) result.project = saved.project;
        this.context.project = saved.project;
        await this.search.rebuild(saved.project);
        return result;
      })();
      slot.completion = operation.then(() => undefined, () => undefined);
      let result: Awaited<typeof operation>;
      try {
        result = await operation;
      } catch (caught) {
        await this.disposeImportPreview(id, slot);
        throw caught;
      } finally {
        slot.active = false;
        slot.controller = null;
        slot.completion = null;
      }
      await this.disposeImportPreview(id, slot);
      return {
        value: result,
        audit: {
          object_type: "import",
          action: "confirm",
          metadata: { mode: result.mode },
        },
      };
    });
    this.commands.register("export.run", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const project = structuredClone(this.context.project);
      const candidate = input && typeof input === "object"
        ? input as {
          preset?: ExportPreset;
          preset_id?: string;
          export_id?: string;
          options?: Parameters<typeof exportProject>[2];
        }
        : {};
      const preset = candidate.preset
        ? structuredClone(candidate.preset)
        : project.export_presets.find((item) =>
          item.id === candidate.preset_id
        );
      if (!preset) throw new Error("export.run requires an export preset");
      const options = structuredClone(candidate.options ?? {});
      // The bridge exports canonical project files, not renderer-held bytes.
      delete options.asset_bytes;
      const [exportId, slot] = await this.reserveExportArtifact(candidate.export_id);
      const build = (async () => {
        const root = await Deno.makeTempDir({ prefix: "acw-export-download-" });
        slot.root = root;
        if (Deno.build.os !== "windows") await Deno.chmod(root, 0o700);
        return await exportProject(
          project,
          preset,
          {
            ...options,
            project_root: this.store.directory,
            output_dir: root,
            replace_existing: false,
            signal: slot.controller.signal,
          },
        );
      })();
      slot.build_completion = build.then(() => undefined, () => undefined);
      let result: Awaited<typeof build>;
      try {
        result = await build;
      } catch (caught) {
        slot.building = false;
        await this.disposeExportArtifact(exportId, slot).catch(() => undefined);
        throw caught;
      }
      slot.building = false;
      slot.created_at = Date.now();
      try {
        slot.files = result.files.map((file) => {
          const parts = file.relative_path.replaceAll("\\", "/").split("/");
          if (
            !slot.root || !file.relative_path || file.relative_path.startsWith("/") ||
            parts.some((part) => !part || part === "." || part === "..") ||
            !Number.isSafeInteger(file.size) || (file.size ?? -1) < 0 ||
            typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
          ) {
            throw error(
              "export_descriptor_invalid",
              "导出文件清单校验失败，未提供下载文件。",
              "export produced an unsafe file path or a file without a staged size and checksum",
              { recoverable: false, recommended_action: null, details: { stage: "descriptor", commit_state: "not_committed", retryable: false } },
            );
          }
          return {
            relative_path: file.relative_path,
            mime_type: file.mime_type,
            size: file.size!,
            sha256: file.sha256,
            path: join(slot.root, ...parts),
          };
        });
      } catch (caught) {
        await this.disposeExportArtifact(exportId, slot).catch(() => undefined);
        throw caught;
      }
      if (slot.files.length) this.scheduleExportArtifactExpiry(exportId, slot);
      else await this.disposeExportArtifact(exportId, slot);
      const files = result.files.map((file, index) => ({
        relative_path: file.relative_path,
        mime_type: file.mime_type,
        size: file.size,
        sha256: file.sha256,
        ...(file.asset_id ? { asset_id: file.asset_id } : {}),
        ...(file.bytes && !file.asset_id && file.bytes.byteLength <= 512 * 1024
          ? { bytes: file.bytes }
          : {}),
        ...(slot.files.length
          ? { download_url: `/api/export-file/${exportId}/${index}` }
          : {}),
      }));
      return {
        value: {
          ...result,
          ...(slot.files.length ? { export_id: exportId } : {}),
          files,
        },
        audit: {
          object_type: "export",
          object_id: preset.id,
          action: "run",
          metadata: { target: result.target, files: result.files.length },
        },
      };
    });
    this.commands.register("export.release", async (input) => {
      const exportId = input && typeof input === "object" &&
          typeof (input as { export_id?: unknown }).export_id === "string"
        ? (input as { export_id: string }).export_id
        : "";
      if (!/^[a-f0-9]{32}$/.test(exportId)) {
        throw error(
          "export_id_invalid",
          "导出文件引用无效或已过期。",
          "export.release requires a valid export id",
          { recoverable: true, recommended_action: null, details: { stage: "release", commit_state: "not_committed", retryable: false } },
        );
      }
      return { value: { released: await this.releaseExportArtifact(exportId) } };
    });
    this.commands.register("publication.record", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          content_item_id?: string;
          preset?: ExportPreset;
          preset_id?: string;
          options?: Parameters<typeof exportProject>[2];
          external_url?: string | null;
          version_label?: string;
          export_path?: string | null;
        }
        : {};
      const preset = candidate.preset ??
        this.context.project.export_presets.find((item) =>
          item.id === candidate.preset_id
        );
      if (!preset || !candidate.content_item_id) {
        throw new Error(
          "publication.record requires content_item_id and export preset",
        );
      }
      const data = structuredClone(this.context.project);
      const adapter = new ManualPublishAdapter(preset.platform);
      const request = {
        data,
        content_item_id: candidate.content_item_id,
        preset,
        options: {
          ...(candidate.options ?? {}),
          project_root: this.store.directory,
        },
        external_url: candidate.external_url,
        version_label: candidate.version_label,
        export_path: candidate.export_path,
      };
      const prepared = await adapter.prepare(request);
      const publication = await adapter.publish(request, prepared);
      const committed = await this.commitCanonicalMutation(data, input);
      return {
        value: publication,
        ...(committed.mutation_ack
          ? { mutation_ack: committed.mutation_ack }
          : {}),
        audit: {
          object_type: "publication",
          object_id: publication.id,
          action: "record",
          metadata: { platform: publication.platform },
        },
      };
    });
    this.commands.register("snapshot.create", async (input) => {
      const activeProjectId = this.context.project?.project.id ?? null;
      const binding = snapshotCommandBinding(input, this.store, activeProjectId);
      const candidate = input as Record<string, unknown>;
      const project = candidate.project && typeof candidate.project === "object" &&
          !Array.isArray(candidate.project)
        ? candidate.project as ProjectData
        : null;
      if (!project || project.project.id !== binding.project_id) {
        throw error(
          "project_id_mismatch",
          "历史版本内容与当前课程身份不匹配。",
          "Snapshot copy payload does not match the active project",
          { recoverable: false, recommended_action: null, details: { stage: "snapshot_identity", commit_state: "not_committed", retryable: false } },
        );
      }
      if (
        candidate.snapshot_id !== undefined &&
        typeof candidate.snapshot_id !== "string"
      ) {
        throw error(
          "snapshot_invalid",
          "历史版本编号无效。",
          "snapshot_id must be a string",
          { recoverable: false, recommended_action: null, details: { stage: "snapshot_id_validate", commit_state: "not_committed", retryable: false } },
        );
      }
      if (
        (candidate.name !== undefined && typeof candidate.name !== "string") ||
        (candidate.note !== undefined && typeof candidate.note !== "string")
      ) {
        throw error(
          "snapshot_metadata_invalid",
          "历史版本名称或备注无效。",
          "Snapshot name and note must be strings",
          { recoverable: false, recommended_action: null, details: { stage: "snapshot_metadata_validate", commit_state: "not_committed", retryable: false } },
        );
      }
      const snapshotId = typeof candidate.snapshot_id === "string"
        ? candidate.snapshot_id
        : crypto.randomUUID();
      const name = typeof candidate.name === "string" ? candidate.name : "未命名版本";
      const note = typeof candidate.note === "string" ? candidate.note : "";
      if (name.length > 200 || note.length > 2_000) {
        throw error(
          "snapshot_metadata_invalid",
          "历史版本名称或备注过长。",
          "Snapshot name or note exceeds the supported size",
          { recoverable: false, recommended_action: null, details: { stage: "snapshot_metadata_validate", commit_state: "not_committed", retryable: false } },
        );
      }
      const persisted = await this.store.writeSnapshotCopy(
        snapshotId,
        project,
        name,
        note,
      );
      return {
        value: {
          id: snapshotId,
          snapshot_id: snapshotId,
          persisted: true,
          outcome: persisted.outcome,
          content_hash: persisted.content_hash,
          created_at: persisted.created_at,
          durability_warning: persisted.durability_warning,
          project_id: binding.project_id,
          project_dir: binding.project_dir,
          lease_generation: binding.lease_generation,
          editor_generation: binding.editor_generation,
          operation_id: binding.operation_id,
          revision: binding.revision,
        },
        ...(persisted.outcome === "written"
          ? {
            events: [
              EventBus.domainEvent({
                type: "SnapshotCreated",
                project_id: binding.project_id,
                entity_type: "snapshot",
                entity_id: snapshotId,
                source: "user",
                metadata: {},
              }),
            ],
          }
          : {}),
        audit: {
          object_type: "snapshot",
          object_id: snapshotId,
          action: "create",
          metadata: { outcome: persisted.outcome },
        },
      };
    });
    this.commands.register("snapshot.list", async (input) => {
      const candidate = input && typeof input === "object" &&
          !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
      if (
        typeof candidate.project_dir !== "string" ||
        normalize(candidate.project_dir) !== normalize(this.store.directory)
      ) {
        throw error(
          "project_path_mismatch",
          "历史版本列表与当前项目路径不匹配。",
          "Snapshot list project directory does not match the active store",
          { recoverable: false, recommended_action: null, details: { stage: "project_path_validate", retryable: false } },
        );
      }
      if (
        candidate.expected_project_id !== undefined &&
        typeof candidate.expected_project_id !== "string"
      ) {
        throw error(
          "snapshot_binding_invalid",
          "历史版本列表请求绑定无效。",
          "Snapshot list expected project id must be a string",
          { recoverable: false, recommended_action: null, details: { stage: "request_binding", retryable: false } },
        );
      }
      const listed = await this.store.listSnapshotCopies(
        candidate.expected_project_id as string | undefined,
      );
      return { value: listed };
    });
    this.commands.register("snapshot.restore", async (input) => {
      const activeProjectId = this.context.project?.project.id ?? null;
      const candidate = input as Record<string, unknown>;
      const mutationBinding = candidate &&
          Object.hasOwn(candidate, "expected_fingerprint")
        ? canonicalMutationBinding(input, this.store, activeProjectId)
        : null;
      const binding = mutationBinding ??
        snapshotCommandBinding(input, this.store, activeProjectId);
      const snapshotId = typeof candidate.snapshot_id === "string"
        ? candidate.snapshot_id
        : "";
      if (!snapshotId) {
        throw error(
          "snapshot_invalid",
          "历史版本编号无效。",
          "snapshot.restore requires a snapshot id",
          { recoverable: false, recommended_action: null, details: { stage: "snapshot_id_validate", commit_state: "not_committed", retryable: false } },
        );
      }
      const currentState = await this.store.readProjectSnapshot();
      if (
        !currentState.project ||
        currentState.project.project.id !== binding.project_id
      ) {
        throw error(
          "project_id_mismatch",
          "当前磁盘课程与恢复请求不匹配。",
          "Canonical project owner changed before snapshot restore",
          { recoverable: false, recommended_action: null, details: { stage: "project_identity", commit_state: "not_committed", retryable: false } },
        );
      }
      const restored = await this.store.restoreSnapshot(
        currentState.project,
        snapshotId,
        mutationBinding ? projectSaveBinding(mutationBinding) : undefined,
      );
      this.context.project = restored.project;
      const searchWarning = await this.rebuildSearchAfterWrite(restored.project);
      const durabilityWarning = [restored.durability_warning, searchWarning]
        .filter(Boolean).join(" ") || null;
      return {
        value: {
          restored: true,
          snapshot_id: snapshotId,
          project: restored.project,
          fingerprint: restored.fingerprint,
          project_id: binding.project_id,
          project_dir: binding.project_dir,
          lease_generation: binding.lease_generation,
          editor_generation: binding.editor_generation,
          operation_id: binding.operation_id,
          revision: binding.revision,
          backup_snapshot_id: restored.backup.id,
          backup_persisted: true,
          commit_state: "committed",
          durability_warning: durabilityWarning,
        },
        ...(mutationBinding
          ? {
            mutation_ack: this.mutationAck(
              mutationBinding,
              restored.project,
              restored.fingerprint,
              "written",
              null,
              durabilityWarning,
            ),
          }
          : {}),
        audit: {
          object_type: "project",
          object_id: restored.project.project.id,
          action: "restore",
          metadata: { snapshot_id: snapshotId },
        },
      };
    });
    this.commands.register("connector.sync", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          source?: unknown;
          selected_ids?: string[];
          provider?: string;
          display_name?: string;
          account_label?: string;
        }
        : {};
      if (candidate.source === undefined) {
        throw new Error("connector.sync requires an explicit import source");
      }
      const connector = new ImportedConversationConnector(
        candidate.source as never,
        {
          provider: candidate.provider,
          display_name: candidate.display_name,
          account_label: candidate.account_label,
        },
      );
      this.connectors.register(
        candidate.provider ?? "local-import",
        connector,
      );
      await connector.sync();
      const selected = candidate.selected_ids ?? [];
      const result = selected.length
        ? await syncSelectedConversations(
          this.context.project,
          connector,
          selected,
        )
        : { source: null, conversations: [], messages: [] };
      if (selected.length) {
        await this.store.saveWithRecovery(this.context.project);
        await this.search.rebuild(this.context.project);
      }
      return {
        value: {
          metadata: await connector.get_metadata(),
          listed: await connector.listConversations(),
          imported: result,
        },
        audit: {
          object_type: "conversation",
          action: "sync",
          metadata: { selected_count: selected.length },
        },
      };
    });
    this.commands.register("ai.analyze", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      await Promise.resolve();
      const candidate = input && typeof input === "object"
        ? input as {
          selected_context?: unknown[];
          purpose?: string;
          target_content_item_id?: string | null;
        }
        : {};
      const selected = Array.isArray(candidate.selected_context)
        ? candidate.selected_context
        : [];
      // The service deliberately returns an analysis envelope only. Canonical
      // data is untouched until a user reviews a Suggestion/ChangeDraft.
      return {
        value: {
          status: "suggestion_pending",
          selected_count: selected.length,
          purpose: candidate.purpose ?? "分析当前内容",
          target_content_item_id: candidate.target_content_item_id ?? null,
        },
        audit: {
          object_type: "ai",
          action: "analyze",
          metadata: { selected_count: selected.length },
        },
      };
    });
    this.commands.register("suggestion.apply", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          change_draft_id?: string;
          confirmed?: boolean;
          patch_ids?: string[];
        }
        : {};
      if (!candidate.change_draft_id) {
        throw new Error("suggestion.apply requires change_draft_id");
      }
      const draft = applyChangeDraft(
        this.context.project,
        candidate.change_draft_id,
        {
          confirmed: candidate.confirmed === true,
          patch_ids: candidate.patch_ids,
        },
      );
      await this.store.saveWithRecovery(this.context.project);
      await this.search.rebuild(this.context.project);
      return {
        value: draft,
        audit: {
          object_type: "change_draft",
          object_id: draft.id,
          action: "apply",
        },
      };
    });
    this.commands.register("secret.set", async (input) => {
      const candidate = input as { provider?: string; value?: string };
      await this.secrets.set(candidate.provider ?? "", candidate.value ?? "");
      return {
        value: { provider: candidate.provider ?? "" },
        audit: {
          object_type: "secret",
          object_id: candidate.provider ?? null,
          action: "set",
        },
      };
    });
    this.commands.register("secret.delete", async (input) => {
      const provider = input && typeof input === "object" &&
          typeof (input as { provider?: unknown }).provider === "string"
        ? (input as { provider: string }).provider
        : "";
      await this.secrets.delete(provider);
      return {
        value: { provider },
        audit: { object_type: "secret", object_id: provider, action: "delete" },
      };
    });
    // ---- V0-T03 AI workflow (browser shell transport) ----------------------
    // `ai.analyze` / `suggestion.apply` / `secret.*` keep their existing
    // behaviour: these commands own provider connections and the live
    // transport, and they never place a credential in a result or an audit.
    this.commands.register("ai.connection.list", async () => {
      // The only AI command that stays usable before a project exists.
      if (!this.context.project) {
        return {
          value: { providers: [], configured: {} },
          audit: {
            object_type: "ai_connection",
            action: "list",
            metadata: { provider_count: 0 },
          },
        };
      }
      const connections = await this.aiTransport().listConnections();
      return {
        value: connections,
        audit: {
          object_type: "ai_connection",
          action: "list",
          metadata: { provider_count: connections.providers.length },
        },
      };
    });
    this.commands.register("ai.connection.save", async (input) => {
      this.assertAiProjectOpen();
      const saved = await this.aiTransport().saveConnection(input);
      return {
        value: saved,
        audit: {
          object_type: "ai_connection",
          object_id: saved.provider.id,
          action: "save",
        },
      };
    });
    this.commands.register("ai.connection.delete", async (input) => {
      this.assertAiProjectOpen();
      const providerId = input && typeof input === "object" &&
          typeof (input as { provider_id?: unknown }).provider_id === "string"
        ? (input as { provider_id: string }).provider_id
        : "";
      const result = await this.aiTransport().deleteConnection(providerId);
      return {
        value: result,
        audit: {
          object_type: "ai_connection",
          object_id: result.provider_id,
          action: "delete",
          metadata: { removed: result.removed },
        },
      };
    });
    for (
      const command of [
        "ai.subscription.start",
        "ai.subscription.status",
        "ai.subscription.cancel",
        "ai.subscription.logout",
      ] as const
    ) {
      this.commands.register(command, async () => {
        throw error(
          "subscription_native_only",
          "ChatGPT 订阅登录需要 macOS 桌面版的系统浏览器回调和系统钥匙串。",
          "Sign in with ChatGPT is supported by the native Tauri runtime only",
          {
            recoverable: false,
            recommended_action:
              "请在 macOS 桌面版 Workbench 的 AI 设置中管理订阅账户。",
            details: {},
          },
        );
      });
    }
    this.commands.register("ai.secret.set", async (input) => {
      this.assertAiProjectOpen();
      const candidate = input && typeof input === "object"
        ? input as { provider_id?: unknown; value?: unknown }
        : {};
      const providerId = typeof candidate.provider_id === "string"
        ? candidate.provider_id
        : "";
      const value = typeof candidate.value === "string" ? candidate.value : "";
      const result = await this.aiTransport().setCredential(providerId, value);
      // The credential value is deliberately absent from the result and audit.
      return {
        value: result,
        audit: {
          object_type: "ai_secret",
          object_id: result.provider_id,
          action: "set",
          metadata: { has_value: true },
        },
      };
    });
    this.commands.register("ai.secret.delete", async (input) => {
      this.assertAiProjectOpen();
      const providerId = input && typeof input === "object" &&
          typeof (input as { provider_id?: unknown }).provider_id === "string"
        ? (input as { provider_id: string }).provider_id
        : "";
      const result = await this.aiTransport().deleteCredential(providerId);
      return {
        value: result,
        audit: {
          object_type: "ai_secret",
          object_id: result.provider_id,
          action: "delete",
          metadata: { removed: result.removed },
        },
      };
    });
    this.commands.register("ai.models.list", async (input) => {
      this.assertAiProjectOpen();
      const result = await this.aiTransport().listAiModels(input);
      const candidate = input && typeof input === "object"
        ? input as { provider_id?: unknown }
        : {};
      return {
        value: result,
        audit: {
          object_type: "ai",
          object_id: typeof candidate.provider_id === "string"
            ? candidate.provider_id
            : null,
          action: "list_models",
          metadata: {
            provider_id: result.provider_id,
            count: result.models.length,
          },
        },
      };
    });
    this.commands.register("ai.models.probe", async (input) => {
      this.assertAiProjectOpen();
      const result = await this.aiTransport().probeAiModels(input);
      return {
        value: result,
        audit: {
          object_type: "ai",
          object_id: null,
          action: "probe_models",
          metadata: { count: result.models.length },
        },
      };
    });
    this.commands.register("ai.connection.test", async (input) => {
      this.assertAiProjectOpen();
      const result = await this.aiTransport().testAiConnection(input);
      return {
        value: result,
        audit: {
          object_type: "ai",
          object_id: result.provider_id,
          action: "test_connection",
          metadata: { provider_id: result.provider_id, model: result.model },
        },
      };
    });
    this.commands.register("ai.complete", async (input) => {
      this.assertAiProjectOpen();
      const result = await this.aiTransport().completeAiRequest(input, {});
      const candidate = input && typeof input === "object"
        ? input as { provider_id?: unknown; request_id?: unknown }
        : {};
      return {
        value: result,
        audit: {
          object_type: "ai",
          object_id: typeof candidate.request_id === "string"
            ? candidate.request_id
            : null,
          action: "complete",
          metadata: {
            provider_id: typeof candidate.provider_id === "string"
              ? candidate.provider_id
              : null,
            status: result.status,
            response_kind: result.response_kind,
          },
        },
      };
    });
    this.commands.register("ai.cancel", async (input) => {
      // Cancelling is idempotent and must never fail, even before a project is
      // open: the in-flight registry is shared across project directories.
      const requestId = input && typeof input === "object" &&
          typeof (input as { request_id?: unknown }).request_id === "string"
        ? (input as { request_id: string }).request_id
        : "";
      const result = this.aiTransport().cancelAiRequest(requestId);
      return {
        value: result,
        audit: {
          object_type: "ai",
          object_id: requestId || null,
          action: "cancel",
          metadata: { cancelled: result.cancelled },
        },
      };
    });
    this.commands.register("ai.execution.append", async (input) => {
      this.assertAiProjectOpen();
      const candidate = input && typeof input === "object"
        ? input as { record?: unknown }
        : {};
      const result = await this.aiTransport().appendExecutionRecord(
        candidate.record ?? input,
      );
      return {
        value: result,
        audit: {
          object_type: "ai_execution",
          object_id: result.id,
          action: "append",
        },
      };
    });
    this.commands.register("ai.execution.list", async (input) => {
      this.assertAiProjectOpen();
      const candidate = input && typeof input === "object"
        ? input as { limit?: unknown }
        : {};
      const records = await this.aiTransport().listExecutionRecords(
        typeof candidate.limit === "number" ? candidate.limit : undefined,
      );
      return {
        value: { records },
        audit: {
          object_type: "ai_execution",
          action: "list",
          metadata: { count: records.length },
        },
      };
    });
  }

  /** Structured failure used by every AI command that mutates project state. */
  private assertAiProjectOpen(): void {
    if (this.context.project) return;
    throw error(
      "project_not_open",
      "请先打开或新建一个课程项目，再使用 AI 功能。",
      "AI commands require an open project directory",
      {
        recoverable: true,
        recommended_action: "打开或新建课程项目后重试。",
        details: {},
      },
    );
  }

  /**
   * Read the current project directory on every call so a project switch moves
   * the AI files with it.  The transport itself is built lazily because the
   * directory is only known once the store exists.
   */
  private aiTransport(): AiTransport {
    const directory = this.store.directory;
    if (!this.aiTransportInstance || this.aiTransportDirectory !== directory) {
      this.aiTransportInstance = new AiTransport(directory, {
        ...this.aiOptions,
        read_only: this.store.options.read_only,
        requests: this.aiRequests,
      });
      this.aiTransportDirectory = directory;
    }
    return this.aiTransportInstance;
  }

  private registerQueries(): void {
    this.queries.register("project.get", () => this.context.project);
    this.queries.register(
      "snapshots.list",
      () => this.context.project?.snapshots ?? [],
    );
    this.queries.register("jobs.list", () => this.jobs.list());
    this.queries.register("course.tree", () => {
      if (!this.context.project) return null;
      return {
        stages: this.context.project.stages,
        content_items: this.context.project.content_items,
      };
    });
    this.queries.register("export.preflight", async (input) => {
      if (!this.context.project) return null;
      const candidate = input && typeof input === "object"
        ? input as {
          preset?: ExportPreset;
          preset_id?: string;
          options?: Parameters<typeof preflightExport>[2];
        }
        : {};
      const preset = candidate.preset ??
        this.context.project.export_presets.find((item) =>
          item.id === candidate.preset_id
        );
      if (!preset) {
        throw new Error("export.preflight requires an export preset");
      }
      return await preflightExport(
        this.context.project,
        preset,
        {
          ...(candidate.options ?? {}),
          project_root: this.store.directory,
        },
      );
    });
    this.queries.register("requirements.missing", (input) => {
      if (!this.context.project) return [];
      const candidate = input && typeof input === "object"
        ? input as { content_item_id?: string }
        : {};
      return this.context.project.requirements.filter((requirement) =>
        requirement.status === "open" &&
        (!candidate.content_item_id ||
          requirement.content_item_id === candidate.content_item_id)
      );
    });
    this.queries.register("search.query", async (input) => {
      const query = input && typeof input === "object" &&
          typeof (input as { query?: unknown }).query === "string"
        ? (input as { query: string }).query
        : "";
      return await this.search.search(
        query,
        input && typeof input === "object"
          ? input as { limit?: number; types?: never }
          : {},
      );
    });
    this.queries.register("assets.search", async (input) => {
      const query = input && typeof input === "object" &&
          typeof (input as { query?: unknown }).query === "string"
        ? (input as { query: string }).query
        : "";
      return await this.search.search(query, {
        limit: input && typeof input === "object"
          ? (input as { limit?: number }).limit
          : undefined,
        types: ["asset"],
      });
    });
    this.queries.register("connector.health", async () => {
      return await this.connectors.health();
    });
    this.queries.register("diagnostics.export", async () => {
      return await this.diagnostics.exportBundle();
    });
  }

  private scheduleExportArtifactExpiry(
    id: string,
    slot: ExportArtifactSlot,
    delay = EXPORT_ARTIFACT_TTL_MS,
  ): void {
    if (slot.expiry_timer !== undefined) clearTimeout(slot.expiry_timer);
    slot.expiry_timer = setTimeout(() => {
      void this.expireExportArtifact(id, slot).catch(() => {
        if (this.exportArtifacts.get(id) === slot) {
          this.scheduleExportArtifactExpiry(id, slot, 60_000);
        }
      });
    }, delay);
  }

  private async expireExportArtifact(
    id: string,
    slot: ExportArtifactSlot,
  ): Promise<void> {
    if (this.exportArtifacts.get(id) !== slot) return;
    const remaining = EXPORT_ARTIFACT_TTL_MS - (Date.now() - slot.created_at);
    if (remaining > 0) {
      this.scheduleExportArtifactExpiry(id, slot, remaining);
      return;
    }
    if (slot.building) {
      slot.release_requested = true;
      slot.controller.abort();
      await slot.build_completion;
    }
    await Promise.all([...slot.active_finishes].map((finish) => finish()));
    await this.disposeExportArtifact(id, slot);
  }

  private async pruneExportArtifacts(): Promise<void> {
    const now = Date.now();
    for (const [id, slot] of this.exportArtifacts) {
      if (!slot.building && now - slot.created_at >= EXPORT_ARTIFACT_TTL_MS) {
        await this.expireExportArtifact(id, slot);
      }
    }
  }

  private async reserveExportArtifact(
    requestedId?: string,
  ): Promise<[string, ExportArtifactSlot]> {
    await this.pruneExportArtifacts();
    if (this.exportArtifacts.size >= EXPORT_ARTIFACT_LIMIT) {
      throw error(
        "export_capacity",
        "已有太多导出文件等待下载，请先完成或释放后再导出。",
        `At most ${EXPORT_ARTIFACT_LIMIT} browser exports may be retained at once`,
        { recoverable: true, recommended_action: null, details: { stage: "reserve", commit_state: "not_committed", retryable: true } },
      );
    }
    const id = requestedId ?? crypto.randomUUID().replaceAll("-", "");
    if (!/^[a-f0-9]{32}$/.test(id) || this.exportArtifacts.has(id)) {
      throw error(
        "export_id_invalid",
        "导出请求编号无效或已被使用，请重新发起导出。",
        "export id must be a fresh 128-bit lowercase hex token",
        { recoverable: true, recommended_action: null, details: { stage: "reserve", commit_state: "not_committed", retryable: true } },
      );
    }
    const slot: ExportArtifactSlot = {
      created_at: Date.now(),
      building: true,
      release_requested: false,
      root: null,
      files: [],
      downloaded: new Set(),
      active_finishes: new Set(),
      controller: new AbortController(),
      build_completion: null,
    };
    this.exportArtifacts.set(id, slot);
    this.scheduleExportArtifactExpiry(id, slot);
    return [id, slot];
  }

  private async disposeExportArtifact(
    id: string,
    slot = this.exportArtifacts.get(id),
  ): Promise<void> {
    if (!slot || this.exportArtifacts.get(id) !== slot) return;
    if (slot.expiry_timer !== undefined) clearTimeout(slot.expiry_timer);
    if (slot.root) {
      try {
        await Deno.remove(slot.root, { recursive: true });
      } catch (caught) {
        if (!(caught instanceof Deno.errors.NotFound)) throw caught;
      }
    }
    if (this.exportArtifacts.get(id) === slot) this.exportArtifacts.delete(id);
    slot.root = null;
    slot.files = [];
  }

  private async releaseExportArtifact(id: string): Promise<boolean> {
    const slot = this.exportArtifacts.get(id);
    if (!slot) return false;
    slot.release_requested = true;
    slot.controller.abort();
    if (slot.building) {
      await slot.build_completion;
    }
    await Promise.all([...slot.active_finishes].map((finish) => finish()));
    await this.disposeExportArtifact(id, slot);
    return true;
  }

  async openExportDownload(
    exportId: string,
    fileIndex: number,
    requestSignal?: AbortSignal,
  ): Promise<ExportDownloadHandle> {
    await this.pruneExportArtifacts();
    const slot = /^[a-f0-9]{32}$/.test(exportId)
      ? this.exportArtifacts.get(exportId)
      : undefined;
    const unavailable = () => error(
      "export_expired",
      "导出文件引用无效或已过期，请重新导出。",
      "export download capability is missing or expired",
      { recoverable: true, recommended_action: null, details: { stage: "download", commit_state: "not_committed", retryable: false } },
    );
    if (!slot || slot.building || slot.release_requested) throw unavailable();
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex >= slot.files.length) {
      throw unavailable();
    }
    const descriptor = slot.files[fileIndex];
    if (!descriptor) throw unavailable();
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.lstat(descriptor.path);
    } catch {
      throw unavailable();
    }
    if (stat.isSymlink || !stat.isFile || stat.size !== descriptor.size) {
      throw unavailable();
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    slot.controller.signal.addEventListener("abort", abort, { once: true });
    requestSignal?.addEventListener("abort", abort, { once: true });
    if (slot.controller.signal.aborted || requestSignal?.aborted) controller.abort();
    let releaseBuffer: (() => void) | null = null;
    let file: Deno.FsFile | null = null;
    try {
      releaseBuffer = await acquireExportStreamBuffer(
        controller.signal,
        1024 * 1024,
        "download",
      );
      file = await Deno.open(descriptor.path, { read: true });
      if (controller.signal.aborted) throw unavailable();
    } catch (caught) {
      try {
        file?.close();
      } catch { /* close may race service shutdown */ }
      slot.controller.signal.removeEventListener("abort", abort);
      requestSignal?.removeEventListener("abort", abort);
      releaseBuffer?.();
      throw caught;
    }
    if (!file) throw unavailable();
    const openedFile = file;
    try {
      const openedStat = await openedFile.stat();
      if (
        !openedStat.isFile || openedStat.size !== descriptor.size ||
        controller.signal.aborted || slot.release_requested
      ) throw unavailable();
    } catch {
      try {
        openedFile.close();
      } catch { /* close may race service shutdown */ }
      slot.controller.signal.removeEventListener("abort", abort);
      requestSignal?.removeEventListener("abort", abort);
      releaseBuffer?.();
      throw unavailable();
    }
    slot.created_at = Date.now();
    this.scheduleExportArtifactExpiry(exportId, slot);
    let completed = false;
    let cancelFinish!: () => Promise<void>;
    const finish = async (success: boolean): Promise<void> => {
      if (completed) return;
      completed = true;
      try {
        openedFile.close();
      } catch {
        // A concurrent service shutdown may already have closed the handle.
      }
      slot.active_finishes.delete(cancelFinish);
      slot.controller.signal.removeEventListener("abort", abort);
      requestSignal?.removeEventListener("abort", abort);
      releaseBuffer?.();
      if (success) slot.downloaded.add(fileIndex);
      if (
        this.exportArtifacts.get(exportId) === slot &&
        (slot.release_requested || slot.downloaded.size === slot.files.length)
      ) {
        await this.disposeExportArtifact(exportId, slot);
      }
    };
    cancelFinish = () => finish(false);
    slot.active_finishes.add(cancelFinish);
    return {
      file: openedFile,
      relative_path: descriptor.relative_path,
      mime_type: descriptor.mime_type,
      size: descriptor.size,
      signal: controller.signal,
      read: async (buffer) => {
        if (controller.signal.aborted) {
          throw new DOMException("Export download cancelled", "AbortError");
        }
        const count = await openedFile.read(buffer);
        if (count !== null) recordExportDownloadRead(count);
        return count;
      },
      finish,
    };
  }

  private scheduleImportPreviewExpiry(
    id: string,
    slot: ImportPreviewSlot,
    delay = IMPORT_PREVIEW_TTL_MS,
  ): void {
    if (slot.expiry_timer !== undefined) clearTimeout(slot.expiry_timer);
    slot.expiry_timer = setTimeout(() => {
      void this.expireImportPreview(id, slot);
    }, delay);
  }

  private async expireImportPreview(
    id: string,
    slot: ImportPreviewSlot,
  ): Promise<void> {
    if (this.importPreviews.get(id) !== slot) return;
    if (slot.active) {
      this.scheduleImportPreviewExpiry(id, slot, 60_000);
      return;
    }
    const remaining = IMPORT_PREVIEW_TTL_MS - (Date.now() - slot.created_at);
    if (remaining > 0) {
      this.scheduleImportPreviewExpiry(id, slot, remaining);
      return;
    }
    await this.disposeImportPreview(id, slot);
  }

  private async disposeImportPreview(
    id: string,
    slot = this.importPreviews.get(id),
  ): Promise<void> {
    if (!slot) return;
    if (slot.expiry_timer !== undefined) clearTimeout(slot.expiry_timer);
    if (this.importPreviews.get(id) === slot) this.importPreviews.delete(id);
    if (slot.input_directory) {
      try {
        await Deno.remove(slot.input_directory, { recursive: true });
      } catch (caught) {
        if (!(caught instanceof Deno.errors.NotFound)) throw caught;
      }
      slot.input_directory = null;
    }
    slot.preview = null;
  }

  private async pruneImportPreviews(): Promise<void> {
    const now = Date.now();
    for (const [id, slot] of this.importPreviews) {
      if (!slot.active && now - slot.created_at >= IMPORT_PREVIEW_TTL_MS) {
        await this.disposeImportPreview(id, slot);
      }
    }
  }

  private async reserveImportPreview(
    id: string,
    projectId: string | null,
  ): Promise<ImportPreviewSlot> {
    this.assertServiceOpen();
    await this.pruneImportPreviews();
    this.assertServiceOpen();
    if (this.importPreviews.has(id)) {
      throw error(
        "import_preview_id_conflict",
        "导入预览标识已被使用，请重新开始预览。",
        "Import preview identifier is already active",
        {
          recoverable: true,
          recommended_action: "生成新的预览标识后重试。",
          details: {},
        },
      );
    }
    if (this.importPreviews.size >= IMPORT_PREVIEW_LIMIT) {
      throw error(
        "import_preview_limit",
        "导入预览缓存已达上限，请释放预览后稍后重试。",
        "Pending import preview cache reached its bounded capacity",
        {
          recoverable: true,
          recommended_action: "释放不再使用的预览后重试。",
          details: { limit: IMPORT_PREVIEW_LIMIT },
        },
      );
    }
    const slot: ImportPreviewSlot = {
      created_at: Date.now(),
      active: true,
      preview: null,
      project_id: projectId,
      input_directory: null,
      controller: new AbortController(),
      completion: null,
      release_requested: false,
    };
    this.importPreviews.set(id, slot);
    this.scheduleImportPreviewExpiry(id, slot);
    return slot;
  }

  private async releaseImportPreview(id: string): Promise<boolean> {
    const slot = this.importPreviews.get(id);
    if (!slot) return false;
    slot.release_requested = true;
    if (slot.active) {
      slot.controller?.abort();
      await slot.completion;
    }
    if (this.importPreviews.get(id) === slot) {
      await this.disposeImportPreview(id, slot);
    }
    return true;
  }

  /**
   * Read a browser resume pointer only after checking the current canonical
   * project. Missing, corrupt, stale, or inaccessible records are equivalent
   * to no pointer so the launcher remains usable.
   */
  async loadBrowserSession(): Promise<Record<string, unknown> | null> {
    let project: ProjectData | null;
    try {
      project = (await this.store.readProjectSnapshot()).project;
    } catch {
      return null;
    }
    const projectId = project?.project?.id;
    if (typeof projectId !== "string" || !projectId.trim()) return null;
    return await this.browserSession.load(projectId);
  }

  /** Explicitly advance the browser page epoch; reading the session stays pure. */
  async openBrowserSession(projectId: string): Promise<BrowserSessionCursor> {
    let project: ProjectData | null;
    try {
      project = (await this.store.readProjectSnapshot()).project;
    } catch (caught) {
      throw error(
        "browser_session_unavailable",
        "当前课程无法确认，阅读位置没有打开。",
        `Cannot validate browser session project: ${caught instanceof Error ? caught.message : "unknown failure"}`,
        {
          recoverable: true,
          recommended_action: "重新打开课程后重试。",
          details: { stage: "project_identity", commit_state: "not_committed", retryable: false },
        },
      );
    }
    if (!project || project.project.id !== projectId) {
      throw error(
        "project_id_mismatch",
        "阅读位置与当前课程不匹配。",
        "Refusing to open a browser session for a different project",
        {
          recoverable: false,
          recommended_action: null,
          details: { stage: "project_identity", commit_state: "not_committed", retryable: false },
        },
      );
    }
    return await this.browserSession.open(projectId);
  }

  /** Save UI-only browser metadata after resolving the canonical identity. */
  async saveBrowserSession(
    value: unknown,
    binding?: BrowserSessionSaveBinding,
  ): Promise<BrowserSessionSaveResult | void> {
    let project: ProjectData | null;
    try {
      project = (await this.store.readProjectSnapshot()).project;
    } catch (caught) {
      throw error(
        "browser_session_unavailable",
        "上次阅读位置暂时无法保存，但课程内容仍可继续使用。",
        `Cannot validate browser session project: ${
          caught instanceof Error ? caught.message : "unknown failure"
        }`,
        {
          recoverable: true,
          recommended_action: "重新打开项目后重试；课程内容不会因此改变。",
          details: {},
        },
      );
    }
    const projectId = project?.project?.id;
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw error(
        "browser_session_unavailable",
        "当前没有可识别的课程项目，阅读位置未保存。",
        "Cannot save browser session without a canonical project identity",
        {
          recoverable: true,
          recommended_action: "先打开一个有效的课程项目。",
          details: {},
        },
      );
    }
    const requestedProjectId = value && typeof value === "object" &&
        typeof (value as { project_id?: unknown }).project_id === "string"
      ? (value as { project_id: string }).project_id
      : projectId;
    if (requestedProjectId !== projectId) {
      throw error(
        "project_id_mismatch",
        "阅读位置与当前课程不匹配，未保存。",
        "Refusing to save browser session for a different project",
        {
          recoverable: false,
          recommended_action: null,
          details: { stage: "project_identity", commit_state: "not_committed", retryable: false },
        },
      );
    }
    try {
      return await this.browserSession.save(value, projectId, binding);
    } catch (caught) {
      if (caught instanceof ServiceError) throw caught;
      throw error(
        "browser_session_unavailable",
        "上次阅读位置暂时无法保存，但课程内容仍可继续使用。",
        `Cannot save browser session: ${
          caught instanceof Error ? caught.message : "unknown failure"
        }`,
        {
          recoverable: true,
          recommended_action: "检查项目目录权限后重试；课程内容不会因此改变。",
          details: {},
        },
      );
    }
  }

  async open(): Promise<ProjectData | null> {
    await this.store.open();
    try {
      this.context.project = await this.store.readProject();
      await this.search.rebuild(this.context.project);
      return this.context.project;
    } catch (caught) {
      if (caught instanceof Deno.errors.NotFound) return null;
      // A project directory may be newly created; a missing project file is not fatal.
      if (
        caught instanceof Error &&
        /No such file|not found/i.test(caught.message)
      ) return null;
      throw caught;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.commands.close();
    const previews = [...this.importPreviews.entries()];
    for (const [, slot] of previews) {
      slot.release_requested = true;
      if (slot.active) slot.controller?.abort();
    }
    await Promise.all(previews.map(([, slot]) => slot.completion));
    for (const [id, slot] of previews) {
      await this.disposeImportPreview(id, slot);
    }
    const exports = [...this.exportArtifacts.entries()];
    for (const [, slot] of exports) {
      slot.release_requested = true;
      slot.controller.abort();
    }
    await Promise.all(exports.map(([, slot]) => slot.build_completion));
    await Promise.all(
      exports.flatMap(([, slot]) => [...slot.active_finishes]).map((finish) => finish()),
    );
    await Promise.all(exports.map(([id, slot]) => this.disposeExportArtifact(id, slot)));
    await this.store.close();
  }
}
