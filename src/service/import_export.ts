import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
} from "node:path";
import { createHash } from "node:crypto";
import { addAsset } from "../domain/assets.ts";
import { createInboxItem, createPublication } from "../domain/workflow.ts";
import { buildBlueprintDraft, createCourseSeed } from "../domain/course.ts";
import { appendBlock, createDocument } from "../domain/document.ts";
import type {
  AssetType,
  BlockType,
  ContentItem,
  ExportPreset,
  JsonObject,
  LayoutPageSize,
  ProjectData,
  Publication,
} from "../domain/types.ts";
import { migrateProject, validateProjectData } from "../domain/store.ts";
import { renderCourseMap } from "../domain/views.ts";
import { sha256Bytes } from "../domain/util.ts";
import { structuredError } from "./errors.ts";
import {
  exportProjectJson,
  sanitizeHtml,
  sanitizeProjectForExport,
} from "./security.ts";
import {
  buildPublishProjection,
  renderPublishHtml,
  renderPublishMarkdown,
  renderPublishPdf,
} from "./publish.ts";
import type { PublishProjection } from "./publish.ts";

/**
 * Import, export, and publication are deliberately kept behind one service
 * boundary.  The UI receives previews/results, never raw filesystem handles.
 */

export type ImportMode = "content" | "blueprint" | "asset" | "project";
export const IMPORT_PREVIEW_SUMMARY_BYTES = 512 * 1024;
export const IMPORT_IO_CHUNK_BYTES = 1024 * 1024;

export interface ImportSourceState {
  size: number;
  modified_ms: number | null;
  device: number | null;
  inode: number | null;
  summary_bytes: number;
  summary_checksum: string | null;
}

export type ImportFormat =
  | "markdown"
  | "text"
  | "json"
  | "asset"
  | "folder"
  | "word"
  | "pdf"
  | "unsupported";

export interface ImportSource {
  name?: string;
  path?: string;
  mime_type?: string;
  bytes?: Uint8Array | string;
}

export interface ImportBlockPreview {
  type: BlockType;
  content: string;
  settings?: JsonObject;
}

export interface ImportItemPreview {
  id: string;
  name: string;
  format: ImportFormat;
  mode: ImportMode;
  supported: boolean;
  size: number;
  checksum: string | null;
  duplicate_asset_id: string | null;
  source_path: string | null;
  title: string;
  text: string | null;
  blocks: ImportBlockPreview[];
  warnings: string[];
  errors: string[];
  children: ImportItemPreview[];
  source_state?: ImportSourceState;
  summary_truncated?: boolean;
  /** Only bounded in-memory inputs may be held between preview and confirm. */
  payload?: Uint8Array;
}

export interface ImportPreview {
  id: string;
  mode: ImportMode;
  items: ImportItemPreview[];
  counts: Record<string, number>;
  duplicate_count: number;
  warnings: string[];
  errors: string[];
  requires_confirmation: true;
}

export interface ImportConfirmOptions {
  mode?: ImportMode;
  /** Content imports intentionally default to Inbox instead of creating a course. */
  content_target?: "inbox" | "content_item";
  /** Append a content import to an existing document after preview/confirmation. */
  target_content_item_id?: string;
  /** Word/PDF remain non-editable, but may be retained as reference assets. */
  accept_as_reference?: boolean;
  duplicate_choice?: "existing" | "copy" | "cancel";
  duplicate_choices?: Record<string, "existing" | "copy" | "cancel">;
  project_root?: string;
  signal?: AbortSignal;
}

export interface ImportConfirmationResult {
  mode: ImportMode;
  inbox_ids: string[];
  content_item_ids: string[];
  course_seed_ids: string[];
  blueprint_draft_ids: string[];
  asset_ids: string[];
  project: ProjectData | null;
  warnings: string[];
}

export type ExportTarget =
  | "markdown"
  | "html"
  | "json"
  | "image"
  | "pdf"
  | "asset_package"
  | "full_project"
  | "web"
  | "wechat"
  | "custom";

export interface ExportIssue {
  severity: "blocking" | "warning";
  code:
    | "content_requirement"
    | "layout_requirement"
    | "missing_asset"
    | "canvas_overflow"
    | "text_overflow"
    | "missing_font"
    | "external_reference"
    | "unsafe_path"
    | "canonical_invalid"
    | "media_downgrade"
    | "unplaced_content"
    | "layout_linearized"
    | "legacy_grid_sections_require_pagination"
    | "stale_snapshot"
    | "projection_mismatch"
    | "layout_export_unsupported"
    | "pdf_inline_images_omitted"
    | "unsupported_format";
  message: string;
  count?: number;
  block_ids?: string[];
  content_item_id?: string;
  requirement_id?: string;
  asset_id?: string;
  layout_instance_id?: string;
}

export interface ExportPreflightReport {
  issues: ExportIssue[];
  blocking: ExportIssue[];
  warnings: ExportIssue[];
  ok: boolean;
  snapshot_revision: string;
  counts: {
    content_requirements: number;
    layout_requirements: number;
    missing_assets: number;
    overflow: number;
    text_overflow: number;
    missing_fonts: number;
    external_references: number;
    media_downgrades: number;
    unplaced_content: number;
  };
}

export interface ExportFile {
  relative_path: string;
  mime_type: string;
  size?: number;
  sha256?: string;
  asset_id?: string;
  download_url?: string;
  bytes?: Uint8Array;
}

interface InternalExportFile extends ExportFile {
  source_path?: string;
  source_state?: string;
  expected_sha256?: string;
  build_after_stream?: (files: InternalExportFile[]) => Uint8Array;
}

export interface ExportOptions {
  content_item_id?: string | null;
  layout_instance_id?: string | null;
  page_ids?: string[] | null;
  target_page_size?: LayoutPageSize | null;
  projection?: PublishProjection;
  snapshot_revision?: string;
  acknowledged_warnings?: string[];
  project_root?: string;
  output_dir?: string;
  include_private_conversations?: boolean;
  asset_bytes?: Record<string, Uint8Array>;
  force_warnings?: boolean;
  replace_existing?: boolean;
  signal?: AbortSignal;
}

export interface ExportResult {
  files: ExportFile[];
  preflight: ExportPreflightReport;
  target: ExportTarget;
  warnings?: string[];
}

const EXPORT_IO_CHUNK_BYTES = 1024 * 1024;
const EXPORT_INLINE_BYTES = 512 * 1024;

const exportStreamMetrics = {
  asset_bytes_read: 0,
  asset_bytes_written: 0,
  generated_bytes_written: 0,
  asset_active_streams: 0,
  peak_asset_active_streams: 0,
  asset_buffered_bytes: 0,
  peak_asset_buffered_bytes: 0,
  download_active_streams: 0,
  peak_download_active_streams: 0,
  download_bytes_read: 0,
  download_buffered_bytes: 0,
  peak_download_buffered_bytes: 0,
  export_active_streams: 0,
  peak_export_active_streams: 0,
  export_buffered_bytes: 0,
  peak_export_buffered_bytes: 0,
  commit_rollbacks: 0,
};
const MAX_ACTIVE_ASSET_STREAMS = 2;
let activeAssetStreams = 0;
const assetStreamWaiters: Array<{ grant(): boolean; cancel(): void }> = [];

async function acquireAssetStream(signal?: AbortSignal): Promise<() => void> {
  throwIfExportAborted(signal, "read_source");
  if (activeAssetStreams < MAX_ACTIVE_ASSET_STREAMS) {
    activeAssetStreams += 1;
  } else {
    await new Promise<void>((resolve, reject) => {
      let waiting = true;
      const waiter = {
        grant: () => {
          if (!waiting) return false;
          waiting = false;
          signal?.removeEventListener("abort", cancel);
          activeAssetStreams += 1;
          resolve();
          return true;
        },
        cancel: () => {
          if (!waiting) return;
          waiting = false;
          const index = assetStreamWaiters.indexOf(waiter);
          if (index >= 0) assetStreamWaiters.splice(index, 1);
          try {
            throwIfExportAborted(signal, "read_source");
          } catch (caught) {
            reject(caught);
          }
        },
      };
      const cancel = () => waiter.cancel();
      assetStreamWaiters.push(waiter);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeAssetStreams -= 1;
    while (assetStreamWaiters.length > 0) {
      if (assetStreamWaiters.shift()!.grant()) break;
    }
  };
}

export async function acquireExportStreamBuffer(
  signal?: AbortSignal,
  bytes = EXPORT_IO_CHUNK_BYTES,
  kind: "asset" | "download" = "asset",
): Promise<() => void> {
  const releaseSlot = await acquireAssetStream(signal);
  exportStreamMetrics.export_active_streams += 1;
  exportStreamMetrics.peak_export_active_streams = Math.max(
    exportStreamMetrics.peak_export_active_streams,
    exportStreamMetrics.export_active_streams,
  );
  if (kind === "asset") {
    exportStreamMetrics.asset_active_streams += 1;
    exportStreamMetrics.peak_asset_active_streams = Math.max(
      exportStreamMetrics.peak_asset_active_streams,
      exportStreamMetrics.asset_active_streams,
    );
    exportStreamMetrics.asset_buffered_bytes += bytes;
    exportStreamMetrics.peak_asset_buffered_bytes = Math.max(
      exportStreamMetrics.peak_asset_buffered_bytes,
      exportStreamMetrics.asset_buffered_bytes,
    );
  } else {
    exportStreamMetrics.download_active_streams += 1;
    exportStreamMetrics.peak_download_active_streams = Math.max(
      exportStreamMetrics.peak_download_active_streams,
      exportStreamMetrics.download_active_streams,
    );
    exportStreamMetrics.download_buffered_bytes += bytes;
    exportStreamMetrics.peak_download_buffered_bytes = Math.max(
      exportStreamMetrics.peak_download_buffered_bytes,
      exportStreamMetrics.download_buffered_bytes,
    );
  }
  exportStreamMetrics.export_buffered_bytes += bytes;
  exportStreamMetrics.peak_export_buffered_bytes = Math.max(
    exportStreamMetrics.peak_export_buffered_bytes,
    exportStreamMetrics.export_buffered_bytes,
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    exportStreamMetrics.export_active_streams -= 1;
    if (kind === "asset") {
      exportStreamMetrics.asset_active_streams -= 1;
      exportStreamMetrics.asset_buffered_bytes -= bytes;
    } else {
      exportStreamMetrics.download_active_streams -= 1;
      exportStreamMetrics.download_buffered_bytes -= bytes;
    }
    exportStreamMetrics.export_buffered_bytes -= bytes;
    releaseSlot();
  };
}

export function recordExportDownloadRead(bytes: number): void {
  exportStreamMetrics.download_bytes_read += bytes;
}

export function getExportStreamMetrics(): typeof exportStreamMetrics {
  return { ...exportStreamMetrics };
}

export class ExportBlockedError extends Error {
  readonly report: ExportPreflightReport;

  constructor(report: ExportPreflightReport) {
    super("导出前检查发现无法生成的严重问题");
    this.name = "ExportBlockedError";
    this.report = report;
  }
}

export class ExportWarningConfirmationError extends Error {
  readonly warning_codes: string[];
  readonly report: ExportPreflightReport;

  constructor(report: ExportPreflightReport, warningCodes: string[]) {
    super("导出包含尚未确认的保真度警告");
    this.name = "ExportWarningConfirmationError";
    this.warning_codes = warningCodes;
    this.report = report;
  }
}

export class ExportCapabilityError extends Error {
  constructor(format: string) {
    super(
      `${format.toUpperCase()} 导出当前不可用；请改用 Markdown、HTML、Web Package 或 PDF。`,
    );
    this.name = "ExportCapabilityError";
  }
}

export interface PublishRequest {
  data: ProjectData;
  content_item_id: string;
  preset: ExportPreset;
  options?: ExportOptions;
  version_label?: string;
  external_url?: string | null;
  export_path?: string | null;
}

export interface PublishValidation {
  ok: boolean;
  preflight: ExportPreflightReport;
  message?: string;
}

export interface PublishPrepared {
  export: ExportResult;
}

export interface PublishStatus {
  publication: Publication | null;
  state: "unpublished" | "ready" | "published" | "failed";
}

/** Platform adapters are intentionally small; platform-specific behavior stays outside the editor. */
export interface PublishAdapter {
  readonly platform: string;
  validate(request: PublishRequest): Promise<PublishValidation>;
  prepare(request: PublishRequest): Promise<PublishPrepared>;
  publish(
    request: PublishRequest,
    prepared: PublishPrepared,
  ): Promise<Publication>;
  update(
    request: PublishRequest,
    prepared: PublishPrepared,
  ): Promise<Publication>;
  getStatus(data: ProjectData, contentItemId: string): Promise<PublishStatus>;
}

const SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".bat",
  ".cmd",
  ".ps1",
  ".exe",
  ".app",
  ".com",
  ".dll",
]);
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text"]);
const WORD_EXTENSIONS = new Set([".doc", ".docx", ".odt", ".rtf"]);
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
  ".avif",
]);
const ASSET_EXTENSIONS: Record<string, AssetType> = {
  ".gif": "gif",
  ".mp4": "video",
  ".webm": "video",
  ".mov": "video",
  ".m4v": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".m4a": "audio",
  ".ogg": "audio",
  ".pdf": "document",
  ".doc": "document",
  ".docx": "document",
};

function uuid(): string {
  return crypto.randomUUID();
}

function textDecoder(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(
    /^\uFEFF/,
    "",
  );
}

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function extension(name: string): string {
  return extname(name).toLowerCase();
}

function cleanName(value: string, fallback = "未命名"): string {
  const stripped = basename(value)
    .split("")
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f || '<>:"/\\|?*'.includes(character)
        ? "_"
        : character;
    })
    .join("")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const result = stripped || fallback;
  const resultDot = result.lastIndexOf(".");
  const resultStem = resultDot > 0 ? result.slice(0, resultDot) : result;
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(resultStem)
    ? `_${result}`
    : result;
  // Keep generated paths below common cross-platform filename limits while
  // retaining an extension when one is present.  Truncate by UTF-8 bytes so
  // Chinese names are safe on filesystems that count bytes, not characters.
  const truncateUtf8 = (input: string, maxBytes: number): string => {
    const encoder = new TextEncoder();
    if (encoder.encode(input).byteLength <= maxBytes) return input;
    let output = "";
    for (const character of Array.from(input)) {
      const next = output + character;
      if (encoder.encode(next).byteLength > maxBytes) break;
      output = next;
    }
    return output || "_";
  };
  const dot = reserved.lastIndexOf(".");
  const extensionPart = dot > 0 ? reserved.slice(dot) : "";
  const stem = dot > 0 ? reserved.slice(0, dot) : reserved;
  const maxNameBytes = 180;
  const extensionBytes = new TextEncoder().encode(extensionPart).byteLength;
  const safeStem = truncateUtf8(
    stem,
    Math.max(1, maxNameBytes - extensionBytes),
  );
  return truncateUtf8(`${safeStem}${extensionPart}`, maxNameBytes);
}

function relativeSafePath(value: string): boolean {
  const hasUnsafeCharacter = Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || '<>:"|?*'.includes(character);
  });
  if (
    !value || hasUnsafeCharacter || isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) || value.startsWith("\\\\")
  ) return false;
  const normalized = normalize(value).replaceAll("\\", "/");
  return normalized !== "." && normalized !== ".." &&
    !normalized.includes("\0") && !normalized.split("/").includes("..");
}

function mimeFor(name: string, fallback = "application/octet-stream"): string {
  const ext = extension(name);
  const known: Record<string, string> = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".html": "text/html",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return known[ext] ?? fallback;
}

function formatFor(name: string, mimeType = ""): ImportFormat {
  const ext = extension(name);
  if (SCRIPT_EXTENSIONS.has(ext)) return "unsupported";
  if (ext === ".json" || mimeType.includes("json")) return "json";
  if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith("text/")) {
    return ext === ".txt" || ext === ".text" ? "text" : "markdown";
  }
  if (
    WORD_EXTENSIONS.has(ext) || mimeType.includes("word") ||
    mimeType.includes("officedocument")
  ) return "word";
  if (ext === ".pdf" || mimeType === "application/pdf") return "pdf";
  if (
    IMAGE_EXTENSIONS.has(ext) || ASSET_EXTENSIONS[ext] ||
    mimeType.startsWith("image/") || mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/")
  ) return "asset";
  return "unsupported";
}

function assetTypeFor(name: string, mimeType: string): AssetType {
  const ext = extension(name);
  if (ASSET_EXTENSIONS[ext]) return ASSET_EXTENSIONS[ext];
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.includes("pdf") || mimeType.includes("document")) {
    return "document";
  }
  return "other";
}

function inferTitle(name: string, text: string | null): string {
  const first = (text ?? "").split(/\r?\n/).map((line) =>
    line.replace(/^\s*#+\s*/, "").trim()
  ).find(Boolean);
  return first || cleanName(name).replace(/\.[^.]+$/, "") || "未命名内容";
}

function parseBlocks(
  text: string,
  format: "markdown" | "text",
): ImportBlockPreview[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ImportBlockPreview[] = [];
  let fenced = false;
  let code: string[] = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (fenced) {
        blocks.push({ type: "code", content: code.join("\n") });
        code = [];
      }
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      code.push(line);
      continue;
    }
    const value = line.trim();
    if (!value) continue;
    if (format === "markdown") {
      const heading = value.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        blocks.push({
          type: "heading",
          content: heading[2] ?? "",
          settings: { level: heading[1]?.length ?? 1 },
        });
        continue;
      }
      const quote = value.match(/^>\s?(.*)$/);
      if (quote) {
        blocks.push({ type: "quote", content: quote[1] ?? "" });
        continue;
      }
      const image = value.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (image) {
        blocks.push({ type: "image", content: image[2] ?? image[1] ?? "" });
        continue;
      }
    }
    blocks.push({ type: "paragraph", content: value });
  }
  if (fenced && code.length) {
    blocks.push({ type: "code", content: code.join("\n") });
  }
  return blocks;
}

interface PreviewReadBudget {
  remaining_bytes: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Import operation cancelled", "AbortError");
  }
}

function fileState(stat: Deno.FileInfo, checksum = ""): ImportSourceState {
  const extended = stat as Deno.FileInfo & { dev?: number; ino?: number };
  return {
    size: stat.size,
    modified_ms: stat.mtime?.getTime() ?? null,
    device: typeof extended.dev === "number" ? extended.dev : null,
    inode: typeof extended.ino === "number" ? extended.ino : null,
    summary_bytes: 0,
    summary_checksum: checksum || null,
  };
}

function sameFileState(
  left: ImportSourceState,
  right: ImportSourceState,
): boolean {
  return left.size === right.size &&
    (left.modified_ms === null || right.modified_ms === left.modified_ms) &&
    (left.device === null || right.device === left.device) &&
    (left.inode === null || right.inode === left.inode);
}

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readSourceSnapshot(
  source: ImportSource,
  summaryLimit: number,
  signal?: AbortSignal,
): Promise<{
  bytes: Uint8Array;
  name: string;
  path: string | null;
  source_state: ImportSourceState;
  payload?: Uint8Array;
}> {
  if (source.bytes !== undefined) {
    const bytes = toBytes(source.bytes);
    if (bytes.byteLength > IMPORT_PREVIEW_SUMMARY_BYTES) {
      throw new Error(
        "大于 512 KiB 的内存导入来源无法安全保留预览；请通过文件路径选择该文件。",
      );
    }
    const checksum = await sha256Bytes(bytes);
    return {
      bytes: bytes.subarray(0, Math.min(bytes.byteLength, summaryLimit))
        .slice(),
      name: cleanName(source.name ?? "导入内容"),
      path: null,
      source_state: {
        size: bytes.byteLength,
        modified_ms: null,
        device: null,
        inode: null,
        summary_bytes: bytes.byteLength,
        summary_checksum: checksum,
      },
      payload: bytes,
    };
  }
  if (!source.path) throw new Error("导入需要文件内容或路径");
  const before = await Deno.lstat(source.path);
  if (before.isSymlink) {
    throw new Error("为避免越过项目边界，导入不支持符号链接文件");
  }
  if (before.isDirectory) throw new Error("文件夹需要通过文件夹入口导入");
  if (!before.isFile) throw new Error("导入来源不是普通文件");
  const expectedState = fileState(before);
  if (summaryLimit <= 0) {
    return {
      bytes: new Uint8Array(),
      name: cleanName(source.name ?? basename(source.path)),
      path: source.path,
      source_state: expectedState,
    };
  }
  const file = await Deno.open(source.path, { read: true });
  const summaryParts: Uint8Array[] = [];
  let summaryBytes = 0;
  let totalBytes = 0;
  try {
    const opened = fileState(await file.stat());
    if (!sameFileState(expectedState, opened)) {
      throw new Error("预览来源在打开时发生变化，请重新选择文件");
    }
    const buffer = new Uint8Array(
      Math.min(IMPORT_IO_CHUNK_BYTES, summaryLimit),
    );
    while (true) {
      throwIfAborted(signal);
      const count = await file.read(buffer);
      if (count === null) break;
      if (count === 0) continue;
      const chunk = buffer.subarray(0, count);
      totalBytes += count;
      const take = Math.min(count, Math.max(0, summaryLimit - summaryBytes));
      if (take > 0) {
        summaryParts.push(chunk.subarray(0, take).slice());
        summaryBytes += take;
      }
      if (summaryBytes >= summaryLimit) break;
    }
    const openedAfter = fileState(await file.stat());
    const pathAfter = await Deno.lstat(source.path);
    if (
      pathAfter.isSymlink || !pathAfter.isFile ||
      (summaryBytes < summaryLimit && totalBytes !== expectedState.size) ||
      !sameFileState(expectedState, openedAfter) ||
      !sameFileState(expectedState, fileState(pathAfter))
    ) {
      throw new Error("源文件在预览读取期间发生变化，请重新选择文件");
    }
  } finally {
    file.close();
  }
  const summary = joinChunks(summaryParts, summaryBytes);
  const summaryChecksum = summaryBytes > 0 ? await sha256Bytes(summary) : null;
  return {
    bytes: summary,
    name: cleanName(source.name ?? basename(source.path)),
    path: source.path,
    source_state: {
      ...expectedState,
      summary_bytes: summaryBytes,
      summary_checksum: summaryChecksum,
    },
  };
}

async function listFiles(
  path: string,
  visited = new Set<string>(),
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  const stat = await Deno.lstat(path);
  // Symlinks are deliberately skipped instead of followed.  This prevents
  // both circular folder links and imports that escape the selected folder.
  if (stat.isSymlink) return [];
  if (!stat.isDirectory) return [path];
  let identity = normalize(path);
  try {
    identity = await Deno.realPath(path);
  } catch { /* the read below reports the useful error */ }
  if (visited.has(identity)) return [];
  visited.add(identity);
  const result: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    throwIfAborted(signal);
    if (entry.name.startsWith(".")) continue;
    const child = join(path, entry.name);
    if (entry.isSymlink) continue;
    if (entry.isDirectory) {
      result.push(...await listFiles(child, visited, signal));
    } else if (entry.isFile) result.push(child);
  }
  return result.sort();
}

function countItems(items: ImportItemPreview[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const visit = (item: ImportItemPreview): void => {
    if (item.format !== "folder") {
      counts[item.format] = (counts[item.format] ?? 0) + 1;
    }
    item.children.forEach(visit);
  };
  items.forEach(visit);
  return counts;
}

function flatten(items: ImportItemPreview[]): ImportItemPreview[] {
  return items.flatMap((item) => [item, ...flatten(item.children)]);
}

async function previewOne(
  source: ImportSource,
  data: ProjectData | null,
  mode: ImportMode,
  budget: PreviewReadBudget,
  signal?: AbortSignal,
): Promise<ImportItemPreview> {
  throwIfAborted(signal);
  const displayName = cleanName(
    source.name ?? (source.path ? basename(source.path) : "导入内容"),
  );
  if (source.path) {
    const stat = await Deno.lstat(source.path);
    if (stat.isSymlink) {
      throw new Error("为避免越过项目边界，导入不支持符号链接路径");
    }
    if (stat.isDirectory) {
      const children: ImportItemPreview[] = [];
      for (const path of await listFiles(source.path, new Set(), signal)) {
        children.push(await previewOne({ path }, data, mode, budget, signal));
      }
      return {
        id: uuid(),
        name: cleanName(source.name ?? basename(source.path)),
        format: "folder",
        mode,
        supported: children.every((child) => child.supported),
        size: children.reduce((sum, child) => sum + child.size, 0),
        checksum: null,
        duplicate_asset_id: null,
        source_path: source.path,
        title: cleanName(source.name ?? basename(source.path)),
        text: null,
        blocks: [],
        warnings: children.flatMap((child) => child.warnings),
        errors: children.flatMap((child) => child.errors),
        children,
        summary_truncated: children.some((child) => child.summary_truncated),
      };
    }
  }
  const format = formatFor(
    displayName,
    source.mime_type ?? mimeFor(displayName),
  );
  const isScript = SCRIPT_EXTENSIONS.has(extension(displayName));
  if (isScript || format === "unsupported") {
    let size = 0;
    if (source.path) {
      const stat = await Deno.lstat(source.path);
      if (stat.isSymlink) {
        throw new Error("为避免越过项目边界，导入不支持符号链接文件");
      }
      if (stat.isDirectory || !stat.isFile) {
        throw new Error("导入来源不是普通文件");
      }
      size = stat.size;
    } else if (source.bytes !== undefined) {
      size = toBytes(source.bytes).byteLength;
    } else {
      throw new Error("导入需要文件内容或路径");
    }
    return {
      id: uuid(),
      name: displayName,
      format,
      mode,
      supported: false,
      size,
      checksum: null,
      duplicate_asset_id: null,
      source_path: source.path ?? null,
      title: inferTitle(displayName, null),
      text: null,
      blocks: [],
      warnings: [],
      errors: [
        isScript
          ? "脚本和可执行文件只允许作为普通文件查看，导入过程不会执行它。"
          : "该文件类型暂不支持导入。",
      ],
      children: [],
      summary_truncated: false,
    };
  }
  const needsTextSummary = format === "markdown" || format === "text" ||
    format === "json";
  if (
    source.bytes !== undefined &&
    toBytes(source.bytes).byteLength > budget.remaining_bytes
  ) {
    throw new Error(
      "预览缓存已达到 512 KiB 上限；请改用文件路径导入或减少同时选择的内存内容。",
    );
  }
  const summaryLimit = needsTextSummary ? budget.remaining_bytes : 0;
  const loaded = await readSourceSnapshot(source, summaryLimit, signal);
  const checksum = loaded.source_state.summary_bytes ===
      loaded.source_state.size
    ? loaded.source_state.summary_checksum
    : null;
  const summaryTruncated = needsTextSummary &&
    loaded.source_state.size > loaded.bytes.byteLength;
  const retainedBytes = loaded.payload?.byteLength ?? loaded.bytes.byteLength;
  budget.remaining_bytes = Math.max(0, budget.remaining_bytes - retainedBytes);
  const duplicate =
    data?.assets.find((asset) =>
      asset.checksum === checksum && !asset.archived
    ) ?? null;
  const item: ImportItemPreview = {
    id: uuid(),
    name: loaded.name,
    format,
    mode,
    supported: true,
    size: loaded.source_state.size,
    checksum,
    duplicate_asset_id: duplicate?.id ?? null,
    source_path: loaded.path,
    title: inferTitle(loaded.name, null),
    text: null,
    blocks: [],
    warnings: [],
    errors: [],
    children: [],
    source_state: loaded.source_state,
    summary_truncated: summaryTruncated,
    ...(loaded.payload ? { payload: loaded.payload } : {}),
  };
  if (format === "word") {
    item.supported = false;
    item.warnings.push(
      "当前版本不提供 Word 完整解析；请先另存为 Markdown/TXT，或将其作为参考素材导入。",
    );
    return item;
  }
  if (format === "pdf") {
    item.supported = false;
    item.warnings.push(
      "当前版本不提供 PDF 完整解析；可作为参考素材导入，不会伪称为可编辑正文。",
    );
    return item;
  }
  if (format === "asset") {
    item.title = cleanName(loaded.name).replace(/\.[^.]+$/, "");
    return item;
  }
  const text = textDecoder(loaded.bytes);
  item.text = text;
  item.title = inferTitle(loaded.name, text);
  if (summaryTruncated) {
    item.warnings.push(
      "当前只显示不超过 512 KiB 的预览摘要；确认时会重新读取并完整处理源文件。",
    );
  }
  if (format === "json") {
    try {
      if (summaryTruncated) return item;
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && "project" in parsed) {
        migrateProject(parsed);
        item.mode = "project";
        item.warnings.push("这是项目数据导入预览；确认前不会覆盖当前项目。");
      } else {
        item.mode = mode;
        item.warnings.push("JSON 不是完整项目数据，将作为文本参考导入。");
        item.blocks = [{ type: "code", content: text }];
      }
    } catch (caught) {
      item.supported = false;
      item.errors.push(
        `JSON 项目数据无效：${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    }
  } else {
    item.blocks = parseBlocks(text, format === "text" ? "text" : "markdown");
  }
  return item;
}

export async function previewImport(
  sources: ImportSource[],
  options: {
    data?: ProjectData | null;
    mode?: ImportMode;
    preview_id?: string;
    signal?: AbortSignal;
  } = {},
): Promise<ImportPreview> {
  const mode = options.mode ?? "content";
  const budget: PreviewReadBudget = {
    remaining_bytes: IMPORT_PREVIEW_SUMMARY_BYTES,
  };
  const items: ImportItemPreview[] = [];
  for (const source of sources) {
    try {
      throwIfAborted(options.signal);
      items.push(
        await previewOne(
          source,
          options.data ?? null,
          mode,
          budget,
          options.signal,
        ),
      );
    } catch (caught) {
      throwIfAborted(options.signal);
      const name = cleanName(
        source.name ?? (source.path ? basename(source.path) : "导入内容"),
      );
      items.push({
        id: uuid(),
        name,
        format: formatFor(name, source.mime_type ?? ""),
        mode,
        supported: false,
        size: 0,
        checksum: null,
        duplicate_asset_id: null,
        source_path: source.path ?? null,
        title: inferTitle(name, null),
        text: null,
        blocks: [],
        warnings: [],
        errors: [
          `无法读取导入内容：${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        ],
        children: [],
        summary_truncated: false,
      });
    }
  }
  const all = flatten(items);
  const duplicates =
    all.filter((item) => item.duplicate_asset_id !== null).length;
  return {
    id: options.preview_id ?? uuid(),
    mode,
    items,
    counts: countItems(items),
    duplicate_count: duplicates,
    warnings: all.flatMap((item) => item.warnings),
    errors: all.flatMap((item) => item.errors),
    requires_confirmation: true,
  };
}

/** Reject writes through an existing symlink component in an import/export root. */
async function assertNoSymlinkEscape(
  root: string,
  relativePath: string,
): Promise<void> {
  await Deno.mkdir(root, { recursive: true });
  let cursor = root;
  try {
    if ((await Deno.lstat(cursor)).isSymlink) {
      throw new Error("目标目录不能是符号链接");
    }
  } catch (caught) {
    if (
      caught instanceof Error && caught.message === "目标目录不能是符号链接"
    ) throw caught;
    if (!(caught instanceof Deno.errors.NotFound)) throw caught;
  }
  const parts = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  // Check the final component too.  A pre-existing symlink at the target
  // file would otherwise be followed by writeFile and could escape root.
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      if ((await Deno.lstat(cursor)).isSymlink) {
        throw new Error("目标路径不能穿过符号链接");
      }
    } catch (caught) {
      if (
        caught instanceof Error && caught.message === "目标路径不能穿过符号链接"
      ) throw caught;
      if (!(caught instanceof Deno.errors.NotFound)) throw caught;
      // Missing parent directories are safe; writeOutput/writeAsset creates them.
    }
  }
}

async function hasSymlinkComponent(
  root: string,
  relativePath: string,
): Promise<boolean> {
  let cursor = normalize(root);
  try {
    if ((await Deno.lstat(cursor)).isSymlink) return true;
  } catch (caught) {
    if (!(caught instanceof Deno.errors.NotFound)) throw caught;
    return false;
  }
  for (
    const part of relativePath.replaceAll("\\", "/").split("/").filter(Boolean)
  ) {
    cursor = join(cursor, part);
    try {
      if ((await Deno.lstat(cursor)).isSymlink) return true;
    } catch (caught) {
      if (caught instanceof Deno.errors.NotFound) return false;
      throw caught;
    }
  }
  return false;
}

function blocksFromPreview(
  data: ProjectData,
  contentItemId: string,
  item: ImportItemPreview,
): void {
  const document = data.documents.find((candidate) =>
    candidate.content_item_id === contentItemId
  );
  if (!document) return;
  item.blocks.forEach((block, index) => {
    appendBlock(
      data,
      contentItemId,
      block.type,
      block.content,
      block.settings ?? {},
    );
    // appendBlock owns order indexes.  The index is intentionally retained in
    // preview only; no layout coordinate is ever written to a Block.
    void index;
  });
}

function contentItemFromImport(
  data: ProjectData,
  item: ImportItemPreview,
): ContentItem {
  const contentId = uuid();
  const document = createDocument(data, contentId);
  const content: ContentItem = {
    id: contentId,
    project_id: data.project.id,
    stage_id: null,
    code: `IMPORT-${String(data.content_items.length + 1).padStart(2, "0")}`,
    title: item.title,
    type: "reference",
    description: "导入草稿，待用户归档到课程地图。",
    order_index: data.content_items.length,
    document_id: document.id,
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  data.content_items.push(content);
  blocksFromPreview(data, content.id, item);
  return content;
}

function projectRootStoragePath(
  root: string | undefined,
  filename: string,
  idValue: string,
): string {
  // IDs make repeated imports deterministic within a preview/confirm cycle,
  // while the visible filename remains readable.
  void root;
  return `assets/${idValue}-${cleanName(filename)}`;
}

interface PreparedImportAsset {
  item_id: string;
  staged_path: string | null;
  relative_path: string;
  size: number;
  checksum: string;
}

interface StagedImportAsset extends PreparedImportAsset {
  staged_path: string;
}

interface ImportAssetTransaction {
  root: string | undefined;
  staging_root: string | null;
  prepared: Map<string, PreparedImportAsset>;
  staged: StagedImportAsset[];
}

function assetNeedsImport(
  item: ImportItemPreview,
  options: ImportConfirmOptions,
) {
  return item.supported && item.format === "asset" ||
    (item.format === "word" || item.format === "pdf") &&
      options.accept_as_reference !== false;
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = await file.write(bytes.subarray(offset));
    if (count === 0) throw new Error("导入暂存文件写入没有进展");
    offset += count;
  }
}

async function readConfirmedSource(
  item: ImportItemPreview,
  signal: AbortSignal | undefined,
  onChunk: (chunk: Uint8Array) => Promise<void>,
  collect: boolean,
): Promise<{ checksum: string; size: number; text?: string }> {
  const expected = item.source_state;
  if (!item.source_path) {
    if (!item.payload) throw new Error("预览来源已经释放，请重新选择文件");
    const bytes = item.payload;
    throwIfAborted(signal);
    const checksum = await sha256Bytes(bytes);
    if (
      expected?.summary_checksum &&
      expected.summary_bytes === bytes.byteLength &&
      checksum !== expected.summary_checksum
    ) throw new Error("预览来源内容已变化，请重新预览");
    await onChunk(bytes);
    return {
      checksum,
      size: bytes.byteLength,
      ...(collect ? { text: textDecoder(bytes) } : {}),
    };
  }
  if (!expected) throw new Error("预览缺少来源身份，请重新选择文件");
  const before = await Deno.lstat(item.source_path);
  if (before.isSymlink || !before.isFile) {
    throw new Error("导入来源已变为符号链接或非普通文件");
  }
  if (!sameFileState(expected, fileState(before))) {
    throw new Error("预览来源的大小、时间或文件身份已变化，请重新预览");
  }
  const file = await Deno.open(item.source_path, { read: true });
  const fullHash = createHash("sha256");
  const summaryHash = expected.summary_bytes > 0 ? createHash("sha256") : null;
  const textParts: string[] = [];
  const textDecoderStream = collect
    ? new TextDecoder("utf-8", { fatal: false })
    : null;
  let summaryBytes = 0;
  let totalBytes = 0;
  try {
    if (!sameFileState(expected, fileState(await file.stat()))) {
      throw new Error("预览来源在打开时发生变化，请重新预览");
    }
    const buffer = new Uint8Array(IMPORT_IO_CHUNK_BYTES);
    while (true) {
      throwIfAborted(signal);
      const count = await file.read(buffer);
      if (count === null) break;
      if (count === 0) continue;
      const chunk = buffer.subarray(0, count);
      fullHash.update(chunk);
      const prefixLength = Math.min(
        chunk.byteLength,
        Math.max(0, expected.summary_bytes - summaryBytes),
      );
      if (prefixLength > 0) {
        summaryHash?.update(chunk.subarray(0, prefixLength));
        summaryBytes += prefixLength;
      }
      if (textDecoderStream) {
        textParts.push(textDecoderStream.decode(chunk, { stream: true }));
      }
      await onChunk(chunk);
      totalBytes += count;
    }
    const afterOpen = fileState(await file.stat());
    const afterPath = await Deno.lstat(item.source_path);
    if (
      afterPath.isSymlink || !afterPath.isFile ||
      totalBytes !== expected.size ||
      !sameFileState(expected, afterOpen) ||
      !sameFileState(expected, fileState(afterPath))
    ) throw new Error("源文件在确认读取期间发生变化，请重新预览");
  } finally {
    file.close();
  }
  if (
    expected.summary_checksum &&
    (summaryBytes !== expected.summary_bytes ||
      summaryHash?.digest("hex") !== expected.summary_checksum)
  ) throw new Error("预览摘要已变化，请重新预览后确认");
  if (textDecoderStream) textParts.push(textDecoderStream.decode());
  return {
    checksum: fullHash.digest("hex"),
    size: totalBytes,
    ...(textDecoderStream
      ? {
        text: textParts.join("").replace(/\r\n?/g, "\n").replace(/^\uFEFF/, ""),
      }
      : {}),
  };
}

async function prepareImportAssets(
  preview: ImportPreview,
  data: ProjectData,
  options: ImportConfirmOptions,
): Promise<ImportAssetTransaction> {
  const transaction: ImportAssetTransaction = {
    root: options.project_root,
    staging_root: null,
    prepared: new Map(),
    staged: [],
  };
  if (options.project_root) {
    const root = normalize(options.project_root);
    const stageRelative = `.workspace/import-staging/${uuid()}`;
    await assertNoSymlinkEscape(root, `${stageRelative}/probe`);
    transaction.staging_root = join(root, stageRelative);
    await Deno.mkdir(transaction.staging_root, { recursive: true });
    await assertNoSymlinkEscape(root, `${stageRelative}/probe`);
  }
  let index = 0;
  const visit = async (items: ImportItemPreview[]): Promise<void> => {
    for (const item of items) {
      throwIfAborted(options.signal);
      if (item.children.length) {
        await visit(item.children);
        continue;
      }
      if (!assetNeedsImport(item, options)) continue;
      const relativePath = projectRootStoragePath(
        options.project_root,
        cleanName(item.name),
        item.id,
      );
      if (!relativeSafePath(relativePath)) {
        throw new Error("素材路径必须是项目内相对路径");
      }
      const stagedPath = transaction.staging_root
        ? join(transaction.staging_root, `${index++}.asset`)
        : null;
      const stageHandle = stagedPath
        ? await Deno.open(stagedPath, { write: true, createNew: true })
        : null;
      let verified: { checksum: string; size: number };
      try {
        verified = await readConfirmedSource(
          item,
          options.signal,
          async (chunk) => {
            if (stageHandle) await writeAll(stageHandle, chunk);
          },
          false,
        );
        await stageHandle?.sync();
      } finally {
        stageHandle?.close();
      }
      item.checksum = verified.checksum;
      item.size = verified.size;
      const duplicate = data.assets.find((asset) =>
        !asset.archived && asset.checksum === verified.checksum
      );
      item.duplicate_asset_id = duplicate?.id ?? null;
      const duplicateChoice = options.duplicate_choices?.[item.id] ??
        options.duplicate_choice ?? "existing";
      if (duplicate && duplicateChoice === "cancel") {
        throw new Error("已取消重复素材导入");
      }
      const prepared: PreparedImportAsset = {
        item_id: item.id,
        staged_path: duplicate && duplicateChoice === "existing"
          ? null
          : stagedPath,
        relative_path: relativePath,
        size: verified.size,
        checksum: verified.checksum,
      };
      transaction.prepared.set(item.id, prepared);
      if (stagedPath && prepared.staged_path) {
        transaction.staged.push(prepared as StagedImportAsset);
      } else if (stagedPath) {
        await Deno.remove(stagedPath);
      }
    }
  };
  try {
    await visit(preview.items);
  } catch (caught) {
    await removeImportStaging(transaction);
    throw caught;
  }
  return transaction;
}

async function removeImportStaging(
  transaction: ImportAssetTransaction,
): Promise<void> {
  if (!transaction.staging_root) return;
  try {
    await Deno.remove(transaction.staging_root, { recursive: true });
  } catch (caught) {
    if (!(caught instanceof Deno.errors.NotFound)) throw caught;
  }
}

async function commitImportAssets(
  transaction: ImportAssetTransaction,
  options: ImportConfirmOptions,
): Promise<string[]> {
  if (!transaction.root) return [];
  const root = normalize(transaction.root);
  const promoted: Array<{
    target: string;
    checksum: string;
    backup: string | null;
  }> = [];
  let index = 0;
  try {
    for (const asset of transaction.staged) {
      throwIfAborted(options.signal);
      const targetRelative = asset.relative_path;
      await assertNoSymlinkEscape(root, targetRelative);
      const target = join(root, targetRelative);
      await Deno.mkdir(dirname(target), { recursive: true });
      let backup: string | null = null;
      try {
        const targetStat = await Deno.lstat(target);
        if (targetStat.isSymlink || !targetStat.isFile) {
          throw new Error("已有素材目标不是普通文件，无法安全替换");
        }
        backup = join(transaction.staging_root!, `backup-${index}`);
        await Deno.rename(target, backup);
      } catch (caught) {
        if (!(caught instanceof Deno.errors.NotFound)) throw caught;
      }
      try {
        await Deno.rename(asset.staged_path, target);
      } catch (caught) {
        if (backup) await Deno.rename(backup, target);
        throw caught;
      }
      promoted.push({ target, checksum: asset.checksum, backup });
      index += 1;
    }
  } catch (caught) {
    const rollbackErrors: string[] = [];
    for (const entry of promoted.reverse()) {
      try {
        const targetStat = await Deno.lstat(entry.target);
        if (targetStat.isSymlink || !targetStat.isFile) {
          throw new Error("提交目标已被替换，拒绝删除外部文件");
        }
        const actual = await hashFile(entry.target);
        if (actual !== entry.checksum) {
          throw new Error("提交目标内容已被外部修改，拒绝覆盖");
        }
        await Deno.remove(entry.target);
        if (entry.backup) await Deno.rename(entry.backup, entry.target);
      } catch (rollbackCaught) {
        rollbackErrors.push(
          rollbackCaught instanceof Error
            ? rollbackCaught.message
            : String(rollbackCaught),
        );
      }
    }
    if (rollbackErrors.length) {
      throw new Error(
        `导入提交失败，且回滚未完全完成；恢复文件保留在 ${transaction.staging_root}: ${
          rollbackErrors.join("；")
        }`,
        { cause: caught },
      );
    }
    await removeImportStaging(transaction);
    throw caught;
  }
  const warnings: string[] = [];
  try {
    await removeImportStaging(transaction);
  } catch (caught) {
    warnings.push(
      `导入已提交，但暂存/备份清理失败：${
        caught instanceof Error ? caught.message : String(caught)
      }`,
    );
  }
  return warnings;
}

async function hashFile(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  const hash = createHash("sha256");
  const buffer = new Uint8Array(IMPORT_IO_CHUNK_BYTES);
  try {
    while (true) {
      const count = await file.read(buffer);
      if (count === null) break;
      if (count > 0) hash.update(buffer.subarray(0, count));
    }
  } finally {
    file.close();
  }
  return hash.digest("hex");
}

async function hydrateTextItems(
  items: ImportItemPreview[],
  options: ImportConfirmOptions,
): Promise<void> {
  for (const item of items) {
    throwIfAborted(options.signal);
    if (item.children.length) {
      await hydrateTextItems(item.children, options);
      continue;
    }
    if (
      !item.supported || !["markdown", "text", "json"].includes(item.format)
    ) {
      continue;
    }
    if (!item.source_path && !item.payload) {
      throw new Error("预览来源已经释放，请重新选择文件");
    }
    const verified = await readConfirmedSource(
      item,
      options.signal,
      async () => {},
      true,
    );
    const text = verified.text ?? "";
    item.text = text;
    item.title = inferTitle(item.name, text);
    if (item.format === "json") {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && "project" in parsed) {
          migrateProject(parsed);
          item.mode = "project";
        } else {
          item.blocks = [{ type: "code", content: text }];
        }
      } catch (caught) {
        throw new Error(
          `JSON 导入内容无效：${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        );
      }
    } else {
      item.blocks = parseBlocks(
        text,
        item.format === "text" ? "text" : "markdown",
      );
    }
    item.checksum = verified.checksum;
    item.size = verified.size;
  }
}

async function confirmOne(
  data: ProjectData,
  item: ImportItemPreview,
  options: ImportConfirmOptions,
  result: ImportConfirmationResult,
  preparedAssets: Map<string, PreparedImportAsset>,
): Promise<void> {
  if (item.children.length) {
    for (const child of item.children) {
      await confirmOne(data, child, options, result, preparedAssets);
    }
    return;
  }
  if (
    (item.format === "word" || item.format === "pdf") &&
    options.accept_as_reference !== false
  ) {
    const filename = cleanName(item.name);
    const storagePath = projectRootStoragePath(
      options.project_root,
      filename,
      item.id,
    );
    const prepared = preparedAssets.get(item.id);
    const added = addAsset(data, data.project.id, {
      type: "document",
      filename,
      storage_path: storagePath,
      mime_type: mimeFor(filename),
      checksum: prepared?.checksum ?? item.checksum ?? "",
      file_size: prepared?.size ?? item.size,
      source_type: "imported",
    }, false);
    result.asset_ids.push(added.asset.id);
    result.warnings.push(...item.warnings);
    return;
  }
  if (!item.supported) {
    result.warnings.push(...item.warnings, ...item.errors);
    return;
  }
  if (item.format === "asset") {
    const choice = options.duplicate_choices?.[item.id] ??
      options.duplicate_choice ?? "existing";
    if (item.duplicate_asset_id && choice === "cancel") {
      throw new Error("已取消重复素材导入");
    }
    if (item.duplicate_asset_id && choice === "existing") {
      result.asset_ids.push(item.duplicate_asset_id);
      return;
    }
    const filename = cleanName(item.name);
    const storagePath = projectRootStoragePath(
      options.project_root,
      filename,
      item.id,
    );
    const prepared = preparedAssets.get(item.id);
    const added = addAsset(data, data.project.id, {
      type: assetTypeFor(filename, mimeFor(filename)),
      filename,
      storage_path: storagePath,
      mime_type: mimeFor(filename),
      checksum: prepared?.checksum ?? item.checksum ?? "",
      file_size: prepared?.size ?? item.size,
      source_type: "imported",
    }, Boolean(item.duplicate_asset_id && choice === "copy"));
    result.asset_ids.push(added.asset.id);
    return;
  }
  if (item.format === "json" && item.mode === "project" && item.text) {
    try {
      result.project = migrateProject(JSON.parse(item.text));
      return;
    } catch (caught) {
      result.warnings.push(
        `项目数据未导入：${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
      return;
    }
  }
  if ((options.mode ?? "content") === "blueprint") {
    const seed = createCourseSeed(data, {
      source_type: "outline",
      raw_text: item.text ?? "",
      metadata: { title: item.title },
    });
    const draft = buildBlueprintDraft(data, seed.id);
    result.course_seed_ids.push(seed.id);
    result.blueprint_draft_ids.push(draft.id);
    return;
  }
  if ((options.content_target ?? "inbox") === "content_item") {
    const existing = options.target_content_item_id
      ? data.content_items.find((candidate) =>
        candidate.id === options.target_content_item_id
      )
      : null;
    if (options.target_content_item_id && !existing) {
      throw new Error("导入目标内容不存在");
    }
    const content = existing ?? contentItemFromImport(data, item);
    if (existing) blocksFromPreview(data, existing.id, item);
    result.content_item_ids.push(content.id);
    return;
  }
  const inbox = createInboxItem(data, {
    title: item.title,
    body: item.text ?? "",
    source_type: item.format,
  });
  result.inbox_ids.push(inbox.id);
}

export async function confirmImport(
  data: ProjectData,
  preview: ImportPreview,
  options: ImportConfirmOptions = {},
): Promise<ImportConfirmationResult> {
  if (!preview.requires_confirmation) throw new Error("导入预览已失效");
  const effectiveOptions: ImportConfirmOptions = {
    ...options,
    mode: options.mode ?? preview.mode,
  };
  const result: ImportConfirmationResult = {
    mode: effectiveOptions.mode ?? preview.mode,
    inbox_ids: [],
    content_item_ids: [],
    course_seed_ids: [],
    blueprint_draft_ids: [],
    asset_ids: [],
    project: null,
    warnings: [...preview.warnings],
  };
  const confirmedPreview = structuredClone(preview);
  const workingData = structuredClone(data);
  const transaction = await prepareImportAssets(
    confirmedPreview,
    workingData,
    effectiveOptions,
  );
  try {
    await hydrateTextItems(confirmedPreview.items, effectiveOptions);
    for (const item of confirmedPreview.items) {
      await confirmOne(
        workingData,
        item,
        effectiveOptions,
        result,
        transaction.prepared,
      );
    }
    if (!result.project) {
      result.warnings.push(
        ...await commitImportAssets(transaction, effectiveOptions),
      );
      Object.assign(data, workingData);
    } else {
      await removeImportStaging(transaction);
    }
    return result;
  } catch (caught) {
    await removeImportStaging(transaction);
    throw caught;
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function blockText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (
      char,
    ) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char] ?? char),
  );
}

function safeExternalUrl(value: string): string {
  const trimmed = value.trim();
  if (/^(?:https?:|mailto:|\/|\.?\.?\/)/i.test(trimmed)) {
    return escapeHtml(trimmed);
  }
  return "";
}

function htmlBlock(
  data: ProjectData,
  block: ProjectData["blocks"][number],
): string {
  const content = blockText(block.content);
  switch (block.type) {
    case "heading": {
      const level = typeof block.settings.level === "number"
        ? Math.max(1, Math.min(6, block.settings.level))
        : 2;
      return `<h${level}>${escapeHtml(content)}</h${level}>`;
    }
    case "quote":
      return `<blockquote>${escapeHtml(content)}</blockquote>`;
    case "code":
      return `<pre><code>${escapeHtml(content)}</code></pre>`;
    case "divider":
      return "<hr>";
    case "placeholder":
      return `<aside class="待补内容">待补内容：${escapeHtml(content)}</aside>`;
    case "image": {
      const asset = data.assets.find((candidate) =>
        candidate.filename === content || candidate.storage_path === content
      );
      const src = asset && relativeSafePath(asset.storage_path)
        ? asset.storage_path
        : safeExternalUrl(content);
      return src
        ? `<figure><img src="${escapeHtml(src)}" alt="${
          escapeHtml(asset?.title ?? content)
        }"></figure>`
        : `<p>${escapeHtml(content)}</p>`;
    }
    case "video":
      return `<p>视频：${escapeHtml(content)}</p>`;
    case "audio":
      return `<p>音频：${escapeHtml(content)}</p>`;
    case "embed":
      return `<p>${sanitizeHtml(content)}</p>`;
    default:
      return `<p>${escapeHtml(content)}</p>`;
  }
}

function semanticItems(
  data: ProjectData,
  contentItemId?: string | null,
): ContentItem[] {
  return data.content_items.filter((item) =>
    !item.archived && (!contentItemId || item.id === contentItemId)
  ).sort((a, b) => (a.order_index - b.order_index) || a.id.localeCompare(b.id));
}

function referencedAssets(data: ProjectData, item: ContentItem) {
  const ids = new Set(
    data.asset_usages
      .filter((usage) => usage.content_item_id === item.id)
      .map((usage) => usage.asset_id),
  );
  return data.assets
    .filter((asset) => ids.has(asset.id) && !asset.archived)
    .filter((asset) => relativeSafePath(asset.storage_path))
    .sort((a, b) =>
      a.filename.localeCompare(b.filename) || a.id.localeCompare(b.id)
    );
}

function renderAssetHtml(data: ProjectData, item: ContentItem): string {
  const assets = referencedAssets(data, item);
  if (!assets.length) return "";
  const body = assets.map((asset) => {
    const path = escapeHtml(asset.storage_path);
    const title = escapeHtml(asset.title || asset.filename);
    if (asset.type === "image" || asset.type === "gif") {
      return `<figure><img src="${path}" alt="${title}"><figcaption>${title}</figcaption></figure>`;
    }
    if (asset.type === "video") {
      return `<figure><video controls src="${path}"></video><figcaption>${title}</figcaption></figure>`;
    }
    if (asset.type === "audio") {
      return `<figure><audio controls src="${path}"></audio><figcaption>${title}</figcaption></figure>`;
    }
    return `<p><a href="${path}">${title}</a></p>`;
  }).join("\n");
  return `<section class="assets"><h2>素材</h2>\n${body}\n</section>`;
}

function renderSemanticHtml(
  data: ProjectData,
  item: ContentItem,
  layoutInstanceId: string | null = null,
): string {
  const blocks = data.blocks.filter((block) =>
    data.documents.some((doc) =>
      doc.id === block.document_id && doc.content_item_id === item.id
    )
  ).sort((a, b) => (a.order_index - b.order_index) || a.id.localeCompare(b.id));
  const sections = layoutInstanceId
    ? data.layout_sections.filter((section) =>
      section.layout_instance_id === layoutInstanceId
    ).sort((a, b) =>
      (a.order_index - b.order_index) || (a.page_index - b.page_index) ||
      a.id.localeCompare(b.id)
    )
    : [];
  const placementSection = new Map(
    data.placements.filter((placement) =>
      placement.layout_instance_id === layoutInstanceId && placement.section_id
    ).map((placement) => [placement.block_id, placement.section_id!]),
  );
  const body = sections.length
    ? sections.map((section) => {
      const sectionBlocks = blocks.filter((block) =>
        placementSection.get(block.id) === section.id
      );
      if (!sectionBlocks.length) {
        return `<section><h2>${escapeHtml(section.name)}</h2></section>`;
      }
      return `<section><h2>${escapeHtml(section.name)}</h2>\n${
        sectionBlocks.map((block) => htmlBlock(data, block)).join("\n")
      }\n</section>`;
    }).concat([(() => {
      const unsectioned = blocks.filter((block) =>
        !placementSection.has(block.id)
      );
      return unsectioned.length
        ? `<section>\n${
          unsectioned.map((block) => htmlBlock(data, block)).join("\n")
        }\n</section>`
        : "";
    })()]).filter(Boolean).join("\n")
    : blocks.map((block) => htmlBlock(data, block)).join("\n");
  const assets = renderAssetHtml(data, item);
  return `<!doctype html>\n<html lang="${
    escapeHtml(data.project.language || "zh-CN")
  }">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${
    escapeHtml(item.title)
  }</title><style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font:16px/1.7 system-ui,sans-serif}img,video{max-width:100%;height:auto}blockquote{border-left:3px solid #bbb;padding-left:1rem;color:#555}.待补内容{padding:.75rem;background:#fff5dc}</style></head>\n<body><article><h1>${
    escapeHtml(item.title)
  }</h1>\n${body}${assets ? `\n${assets}` : ""}\n</article></body></html>\n`;
}

function renderMarkdownWithoutLayoutRequirements(
  data: ProjectData,
  item: ContentItem,
): string {
  const layoutOnlyAnchors = new Set(
    data.requirements
      .filter((requirement) =>
        requirement.content_item_id === item.id &&
        requirement.scope === "layout"
      )
      .map((requirement) => requirement.anchor_block_id)
      .filter((blockId): blockId is string => Boolean(blockId)),
  );
  const blocks = data.blocks
    .filter((block) =>
      block.document_id === item.document_id && !layoutOnlyAnchors.has(block.id)
    )
    .sort((a, b) =>
      (a.order_index - b.order_index) || a.id.localeCompare(b.id)
    );
  const lines = [`# ${item.title}`, ""];
  for (const block of blocks) {
    const content = blockText(block.content);
    if (!content) continue;
    if (block.type === "heading") {
      const level = typeof block.settings.level === "number"
        ? Math.max(1, Math.min(6, block.settings.level))
        : 2;
      lines.push(`${"#".repeat(level)} ${content}`);
    } else if (block.type === "quote") lines.push(`> ${content}`);
    else if (block.type === "code") lines.push("```\n" + content + "\n```");
    else if (block.type === "divider") lines.push("---");
    else if (block.type === "placeholder") lines.push(`> 待补内容：${content}`);
    else lines.push(content);
    lines.push("");
  }
  const assets = referencedAssets(data, item);
  if (assets.length) {
    lines.push("## 素材", "");
    for (const asset of assets) {
      const title = asset.title || asset.filename;
      if (asset.type === "image" || asset.type === "gif") {
        lines.push(`![${title}](${asset.storage_path})`);
      } else {
        lines.push(`[${title}](${asset.storage_path})`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function resolveTarget(preset: ExportPreset): ExportTarget {
  const settings = preset.settings as Record<string, unknown>;
  const target = preset.target_type ?? settings.target_type ??
    settings.targetType ?? preset.output_type;
  if (target === "project_json" || target === "json_project") return "json";
  if (target === "asset" || target === "assets") return "asset_package";
  if (target === "package" || target === "full_package") return "full_project";
  if (target === "static_web" || target === "web_package" || target === "web") {
    return "web";
  }
  if (
    target === "rich_text" || target === "wechat" || target === "wechat_html"
  ) return "wechat";
  return target as ExportTarget;
}

function renderName(
  preset: ExportPreset,
  item: ContentItem | null,
  section: string,
  index: number,
  ext: string,
): string {
  const settings = preset.settings as Record<string, unknown>;
  const template = preset.naming_rule ??
    (typeof settings.naming_rule === "string"
      ? settings.naming_rule
      : "{code}_{title}_{section}_{index}");
  const raw = template.replaceAll("{code}", item?.code ?? "project").replaceAll(
    "{title}",
    item?.title ?? "项目",
  ).replaceAll("{section}", section || "正文").replaceAll(
    "{index}",
    String(index + 1),
  );
  return `${cleanName(raw, "export")}.${ext}`;
}

function reportIssue(report: ExportPreflightReport, issue: ExportIssue): void {
  report.issues.push(issue);
  (issue.severity === "blocking" ? report.blocking : report.warnings).push(
    issue,
  );
}

function emptyReport(): ExportPreflightReport {
  return {
    issues: [],
    blocking: [],
    warnings: [],
    ok: true,
    counts: {
      content_requirements: 0,
      layout_requirements: 0,
      missing_assets: 0,
      overflow: 0,
      text_overflow: 0,
      missing_fonts: 0,
      external_references: 0,
      media_downgrades: 0,
      unplaced_content: 0,
    },
    snapshot_revision: "",
  };
}

function exportProjectionOptions(options: ExportOptions) {
  return {
    content_item_id: options.content_item_id,
    layout_instance_id: options.layout_instance_id,
    page_ids: options.page_ids,
    target_page_size: options.target_page_size,
  };
}

function projectionForExport(
  data: ProjectData,
  options: ExportOptions,
): PublishProjection {
  const expected = buildPublishProjection(
    data,
    exportProjectionOptions(options),
  );
  if (
    options.projection &&
    JSON.stringify(options.projection) !== JSON.stringify(expected)
  ) {
    throw new Error("预检与导出使用的页面投影不一致，请重新预检。");
  }
  return options.projection ?? expected;
}

async function exportSnapshotRevision(data: ProjectData): Promise<string> {
  return await sha256Bytes(new TextEncoder().encode(JSON.stringify(data)));
}

async function assetExists(
  _data: ProjectData,
  asset: ProjectData["assets"][number],
  options: ExportOptions,
): Promise<boolean> {
  if (!relativeSafePath(asset.storage_path)) return false;
  if (options.asset_bytes?.[asset.id]) return true;
  if (!options.project_root) return false;
  if (await hasSymlinkComponent(options.project_root, asset.storage_path)) {
    return false;
  }
  try {
    const stat = await Deno.stat(
      join(normalize(options.project_root), asset.storage_path),
    );
    return stat.isFile;
  } catch {
    return false;
  }
}

/** Deterministic, non-AI export checks. */
export async function preflightExport(
  data: ProjectData,
  preset: ExportPreset,
  options: ExportOptions = {},
): Promise<ExportPreflightReport> {
  data = structuredClone(data);
  const report = emptyReport();
  report.snapshot_revision = await exportSnapshotRevision(data);
  if (
    options.snapshot_revision &&
    options.snapshot_revision !== report.snapshot_revision
  ) {
    reportIssue(report, {
      severity: "blocking",
      code: "stale_snapshot",
      message: "课程内容在预检后发生变化，请重新预检并确认警告。",
    });
  }
  const target = resolveTarget(preset);
  const allowed: ExportTarget[] = [
    "markdown",
    "html",
    "json",
    "image",
    "pdf",
    "asset_package",
    "full_project",
    "web",
    "wechat",
    "custom",
  ];
  for (const issue of validateProjectData(data)) {
    reportIssue(report, {
      severity: "blocking",
      code: "canonical_invalid",
      message: `项目数据无法安全导出：${issue.message}`,
    });
  }
  if (!allowed.includes(target)) {
    reportIssue(report, {
      severity: "blocking",
      code: "unsupported_format",
      message: "导出预设格式不可识别。",
    });
  }
  const presetFormat = preset.format ??
    (preset.settings as Record<string, unknown>).format;
  if (
    presetFormat === "png" || presetFormat === "jpg" ||
    presetFormat === "jpeg"
  ) {
    reportIssue(report, {
      severity: "blocking",
      code: "unsupported_format",
      message: "位图导出当前没有可靠的本地渲染能力。",
    });
  }
  const itemIds = new Set(
    semanticItems(data, options.content_item_id).map((item) => item.id),
  );
  const layoutId = options.layout_instance_id ?? preset.layout_instance_id;
  const projectionOptions = {
    ...options,
    layout_instance_id: options.layout_instance_id ??
      preset.layout_instance_id ?? null,
  };
  let publicationProjection: PublishProjection | null = null;
  const checkedMissingAssets = new Set<string>();
  if (["markdown", "html", "web", "wechat", "pdf"].includes(target)) {
    try {
      publicationProjection = projectionForExport(data, projectionOptions);
      for (const media of publicationProjection.media) {
        const asset = data.assets.find((candidate) =>
          candidate.id === media.id
        );
        if (!asset || checkedMissingAssets.has(media.id)) continue;
        if (!relativeSafePath(asset.storage_path)) {
          checkedMissingAssets.add(media.id);
          report.counts.missing_assets += 1;
          reportIssue(report, {
            severity: "blocking",
            code: "unsafe_path",
            message: `素材路径不安全，无法生成稳定引用：${media.filename}`,
            asset_id: media.id,
          });
        } else if (!(await assetExists(data, asset, options))) {
          checkedMissingAssets.add(media.id);
          report.counts.missing_assets += 1;
          reportIssue(report, {
            severity: "blocking",
            code: "missing_asset",
            message: `引用的素材文件不存在：${media.filename}`,
            asset_id: media.id,
          });
        }
      }
      if (
        target === "pdf" &&
        publicationProjection.media.some((media) =>
          media.type === "image" || media.type === "gif"
        )
      ) {
        reportIssue(report, {
          severity: "warning",
          code: "pdf_inline_images_omitted",
          message:
            "当前服务版 PDF 保留可选择文字，但不嵌入图片；请使用 HTML/Web 导出保留图片。",
        });
      }
    } catch (caught) {
      reportIssue(report, {
        severity: "blocking",
        code: options.projection ? "projection_mismatch" : "canonical_invalid",
        message: caught instanceof Error ? caught.message : "无法建立发布投影",
      });
    }
  }
  for (
    const requirement of data.requirements.filter((candidate) =>
      candidate.status === "open" && itemIds.has(candidate.content_item_id)
    )
  ) {
    if (requirement.scope === "content") {
      report.counts.content_requirements += 1;
      reportIssue(report, {
        severity: "warning",
        code: "content_requirement",
        message: `仍有待补内容：${requirement.note || requirement.type}`,
        content_item_id: requirement.content_item_id,
        requirement_id: requirement.id,
      });
    } else if (
      (layoutId && requirement.layout_instance_id === layoutId) ||
      (!layoutId && requirement.layout_instance_id === null)
    ) {
      report.counts.layout_requirements += 1;
      reportIssue(report, {
        severity: "warning",
        code: "layout_requirement",
        message: `仍有待补排版：${requirement.note || requirement.type}`,
        content_item_id: requirement.content_item_id,
        requirement_id: requirement.id,
        layout_instance_id: requirement.layout_instance_id ?? undefined,
      });
    }
    if (requirement.resolved_asset_id) {
      const asset = data.assets.find((candidate) =>
        candidate.id === requirement.resolved_asset_id
      );
      if (
        !asset || asset.archived || !(await assetExists(data, asset, options))
      ) {
        report.counts.missing_assets += 1;
        reportIssue(report, {
          severity: "blocking",
          code: "missing_asset",
          message: "待补内容引用的素材文件不存在。",
          content_item_id: requirement.content_item_id,
          requirement_id: requirement.id,
          asset_id: requirement.resolved_asset_id,
        });
      }
    }
  }
  const referencedAssets = data.asset_usages.filter((usage) =>
    itemIds.has(usage.content_item_id)
  );
  const warnedMedia = new Set<string>();
  for (const usage of referencedAssets) {
    const asset = data.assets.find((candidate) =>
      candidate.id === usage.asset_id
    );
    if (!asset || warnedMedia.has(asset.id)) continue;
    const needsDowngrade =
      ((target === "markdown" || target === "pdf" || target === "wechat") &&
        ["video", "audio", "document", "other"].includes(asset.type)) ||
      (target === "pdf" && asset.type === "gif");
    if (needsDowngrade) {
      warnedMedia.add(asset.id);
      report.counts.media_downgrades += 1;
      reportIssue(report, {
        severity: "warning",
        code: "media_downgrade",
        message: `${asset.filename} 在当前格式中将以非交互附件说明呈现。`,
        content_item_id: usage.content_item_id,
        asset_id: asset.id,
      });
    }
  }
  for (const usage of referencedAssets) {
    const asset = data.assets.find((candidate) =>
      candidate.id === usage.asset_id
    );
    if (
      !asset || asset.archived || !(await assetExists(data, asset, options))
    ) {
      const key = asset?.id ?? usage.asset_id;
      if (!checkedMissingAssets.has(key)) {
        checkedMissingAssets.add(key);
        report.counts.missing_assets += 1;
        reportIssue(report, {
          severity: "blocking",
          code: "missing_asset",
          message: `引用的素材文件不存在：${asset?.filename ?? usage.asset_id}`,
          content_item_id: usage.content_item_id,
          asset_id: asset?.id ?? usage.asset_id,
        });
      }
    }
    if (asset?.source_url && /^https?:\/\//i.test(asset.source_url)) {
      report.counts.external_references += 1;
      reportIssue(report, {
        severity: "warning",
        code: "external_reference",
        message: `外部素材链接不会被验证：${asset.source_url}`,
        content_item_id: usage.content_item_id,
        asset_id: asset.id,
      });
    }
  }
  for (const item of semanticItems(data, options.content_item_id)) {
    for (
      const block of data.blocks.filter((candidate) =>
        candidate.document_id === item.document_id
      )
    ) {
      if (/https?:\/\//i.test(blockText(block.content))) {
        report.counts.external_references += 1;
        reportIssue(report, {
          severity: "warning",
          code: "external_reference",
          message: "正文包含外部引用，导出时不会验证其可访问性。",
          content_item_id: item.id,
        });
      }
    }
  }
  // Markdown is semantic-only.  A layout is checked only when the preset
  // names the current layout instance; its grid cannot block a prose export.
  const layoutAwareTarget = ["html", "web", "pdf"].includes(target);
  const layouts = data.layout_instances.filter((layout) =>
    itemIds.has(layout.content_item_id) &&
    (layoutId ? layout.id === layoutId : layoutAwareTarget)
  );
  const selectedPageIds = options.page_ids == null
    ? null
    : new Set(options.page_ids);
  for (const layout of layouts) {
    const grid = layout.grid_definition as Record<string, unknown>;
    const columns = Array.isArray(grid.columns) ? grid.columns.length : 1;
    const rows = Array.isArray(grid.rows) ? grid.rows.length : 1;
    for (
      const placement of data.placements.filter((candidate) =>
        candidate.layout_instance_id === layout.id &&
        (!selectedPageIds ||
          (candidate.page_id != null && selectedPageIds.has(candidate.page_id)))
      )
    ) {
      const page = placement.page_id
        ? data.layout_pages.find((candidate) =>
          candidate.id === placement.page_id &&
          candidate.layout_instance_id === layout.id
        )
        : null;
      const section = placement.section_id
        ? data.layout_sections.find((candidate) =>
          candidate.id === placement.section_id &&
          candidate.layout_instance_id === layout.id
        )
        : null;
      const sectionGrid =
        (page?.grid_definition ?? section?.grid_definition ?? grid) as Record<
          string,
          unknown
        >;
      const sectionColumns = Array.isArray(sectionGrid.columns)
        ? sectionGrid.columns.length
        : columns;
      const sectionRows = Array.isArray(sectionGrid.rows)
        ? sectionGrid.rows.length
        : rows;
      if (
        placement.row_end > sectionRows ||
        placement.column_end > sectionColumns || placement.row_start < 0 ||
        placement.column_start < 0
      ) {
        report.counts.overflow += 1;
        reportIssue(report, {
          severity: "blocking",
          code: "canvas_overflow",
          message: "排版内容超出画布范围。",
          content_item_id: layout.content_item_id,
          layout_instance_id: layout.id,
        });
      }
    }
    const settings = layout.settings as Record<string, unknown>;
    const textOverflow = Number(
      settings.text_overflow ?? settings.textOverflow ?? 0,
    );
    if (Number.isFinite(textOverflow) && textOverflow > 0) {
      report.counts.text_overflow += textOverflow;
      reportIssue(report, {
        severity: "warning",
        code: "text_overflow",
        message: `有 ${textOverflow} 处文字可能溢出。`,
        content_item_id: layout.content_item_id,
        layout_instance_id: layout.id,
      });
    }
    const missingFonts = Array.isArray(settings.missing_fonts)
      ? settings.missing_fonts
      : [];
    for (const font of missingFonts) {
      report.counts.missing_fonts += 1;
      reportIssue(report, {
        severity: "warning",
        code: "missing_font",
        message: `字体不可用，将使用替代字体：${String(font)}`,
        content_item_id: layout.content_item_id,
        layout_instance_id: layout.id,
      });
    }
    const externalRefs = Array.isArray(settings.external_refs)
      ? settings.external_refs
      : [];
    for (const ref of externalRefs) {
      report.counts.external_references += 1;
      reportIssue(report, {
        severity: "warning",
        code: "external_reference",
        message: `外部引用不会被验证：${String(ref)}`,
        content_item_id: layout.content_item_id,
        layout_instance_id: layout.id,
      });
    }
  }
  if (target === "asset_package" || target === "full_project") {
    for (
      const asset of data.assets.filter((candidate) =>
        !candidate.archived && candidate.project_id === data.project.id
      )
    ) {
      if (!relativeSafePath(asset.storage_path)) {
        reportIssue(report, {
          severity: "blocking",
          code: "unsafe_path",
          message: `素材路径不是项目内相对路径：${asset.filename}`,
          asset_id: asset.id,
        });
      } else if (!(await assetExists(data, asset, options))) {
        report.counts.missing_assets += 1;
        reportIssue(report, {
          severity: "blocking",
          code: "missing_asset",
          message: `素材文件不存在：${asset.filename}`,
          asset_id: asset.id,
        });
      }
    }
  }
  const hasGridLayout =
    publicationProjection?.lessons.some((lesson) =>
      lesson.layout?.mode === "grid"
    ) ?? false;
  if (options.target_page_size) {
    reportIssue(report, {
      severity: "blocking",
      code: "layout_export_unsupported",
      message:
        "浏览器服务的导出适配器不支持统一输出页面尺寸；请在桌面版使用原生 PDF/PPTX 导出。",
    });
  }
  if (target === "pdf" && hasGridLayout) {
    reportIssue(report, {
      severity: "blocking",
      code: "layout_export_unsupported",
      message:
        "浏览器服务的 PDF 适配器不保留页面布局；请在桌面版使用原生分页导出。",
    });
  }
  const ambiguousLegacyGrid = publicationProjection?.notices.find((notice) =>
    notice.code === "legacy_grid_sections_require_pagination"
  );
  if (ambiguousLegacyGrid && ["html", "web", "pdf"].includes(target)) {
    reportIssue(report, {
      severity: "blocking",
      code: "legacy_grid_sections_require_pagination",
      layout_instance_id: ambiguousLegacyGrid.layout_instance_id,
      message: ambiguousLegacyGrid.message,
    });
  }
  if (
    publicationProjection && hasGridLayout &&
    ["markdown", "wechat"].includes(target)
  ) {
    reportIssue(report, {
      severity: "warning",
      code: "layout_linearized",
      count: 1,
      message: "此格式会把页面布局线性化，位置、页面尺寸和分页不会保留。",
    });
  }
  if (
    publicationProjection && ["html", "web"].includes(target) &&
    options.page_ids == null
  ) {
    const unplaced = publicationProjection.lessons.flatMap((lesson) =>
      lesson.layout?.mode === "grid" ? lesson.layout.unplaced_block_ids : []
    );
    if (unplaced.length) {
      report.counts.unplaced_content = unplaced.length;
      reportIssue(report, {
        severity: "warning",
        code: "unplaced_content",
        count: unplaced.length,
        block_ids: unplaced,
        message:
          `仍有 ${unplaced.length} 块正文尚未放置；本次仅输出已排版内容。`,
      });
    }
  }
  report.ok = report.blocking.length === 0;
  return report;
}

function exportFileState(stat: Deno.FileInfo): string {
  return [
    stat.size,
    stat.mtime?.getTime() ?? null,
    stat.dev,
    stat.ino,
  ].join(":");
}

function canonicalSha256(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

async function exportAssetFile(
  asset: ProjectData["assets"][number],
  options: ExportOptions,
  relativePath = asset.storage_path,
): Promise<InternalExportFile | null> {
  const file: InternalExportFile = {
    relative_path: relativePath,
    mime_type: asset.mime_type || mimeFor(asset.filename),
    asset_id: asset.id,
    expected_sha256: canonicalSha256(asset.checksum),
  };
  const supplied = options.asset_bytes?.[asset.id];
  if (supplied) {
    file.bytes = supplied;
    file.size = supplied.byteLength;
    return file;
  }
  if (!options.project_root || !relativeSafePath(asset.storage_path)) {
    return null;
  }
  if (await hasSymlinkComponent(options.project_root, asset.storage_path)) {
    return null;
  }
  try {
    const sourcePath = join(normalize(options.project_root), asset.storage_path);
    const stat = await Deno.lstat(sourcePath);
    if (stat.isSymlink || !stat.isFile) return null;
    file.source_path = sourcePath;
    file.source_state = exportFileState(stat);
    file.size = stat.size;
    return file;
  } catch {
    return null;
  }
}

function exportSourceChanged(stage: string, relativePath: string): Error {
  return structuredError(
    "export_source_changed",
    "导出素材在预检后发生变化，请重新预检并导出。",
    `asset source changed during ${stage}: ${relativePath}`,
    { details: { stage, commit_state: "not_committed", retryable: false } },
  );
}

async function streamExportFile(
  file: InternalExportFile,
  destination?: Deno.FsFile,
  signal?: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  throwIfExportAborted(signal, "read_source");
  const releaseAssetStream = file.asset_id && file.source_path
    ? await acquireExportStreamBuffer(signal)
    : null;
  const hash = createHash("sha256");
  const buffer = file.source_path
    ? new Uint8Array(EXPORT_IO_CHUNK_BYTES)
    : null;
  let size = 0;
  const writeChunk = async (chunk: Uint8Array) => {
    if (!destination) return;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const written = await destination.write(chunk.subarray(offset));
      if (!written) throw new Error("导出文件写入没有前进");
      offset += written;
      if (file.asset_id) exportStreamMetrics.asset_bytes_written += written;
      else exportStreamMetrics.generated_bytes_written += written;
    }
  };
  try {
    if (file.source_path) {
      let before: Deno.FileInfo;
      try {
        before = await Deno.lstat(file.source_path);
      } catch {
        throw exportSourceChanged("read_source", file.relative_path);
      }
      if (
        before.isSymlink || !before.isFile ||
        (file.source_state && exportFileState(before) !== file.source_state)
      ) {
        throw exportSourceChanged("read_source", file.relative_path);
      }
      let input: Deno.FsFile;
      try {
        input = await Deno.open(file.source_path, { read: true });
      } catch {
        throw exportSourceChanged("read_source", file.relative_path);
      }
      try {
        if (exportFileState(await input.stat()) !== exportFileState(before)) {
          throw exportSourceChanged("read_source", file.relative_path);
        }
        while (true) {
          throwIfExportAborted(signal, "read_source");
          const count = await input.read(buffer!);
          if (count === null) break;
          if (!count) continue;
          const chunk = buffer!.subarray(0, count);
          hash.update(chunk);
          await writeChunk(chunk);
          size += count;
          exportStreamMetrics.asset_bytes_read += count;
        }
        const after = await input.stat();
        let pathAfter: Deno.FileInfo;
        try {
          pathAfter = await Deno.lstat(file.source_path);
        } catch {
          throw exportSourceChanged("verify_source", file.relative_path);
        }
        if (
          exportFileState(after) !== exportFileState(before) ||
          pathAfter.isSymlink || !pathAfter.isFile ||
          exportFileState(pathAfter) !== exportFileState(before) ||
          size !== before.size
        ) {
          throw exportSourceChanged("verify_source", file.relative_path);
        }
      } finally {
        input.close();
      }
    } else if (file.bytes) {
      for (
        let offset = 0;
        offset < file.bytes.byteLength;
        offset += EXPORT_IO_CHUNK_BYTES
      ) {
        throwIfExportAborted(signal, "read_source");
        const chunk = file.bytes.subarray(
          offset,
          Math.min(file.bytes.byteLength, offset + EXPORT_IO_CHUNK_BYTES),
        );
        hash.update(chunk);
        await writeChunk(chunk);
        size += chunk.byteLength;
        if (file.asset_id) {
          exportStreamMetrics.asset_bytes_read += chunk.byteLength;
        }
      }
    } else {
      throw new Error(`导出文件缺少内容来源：${file.relative_path}`);
    }
    const sha256 = hash.digest("hex");
    if (file.expected_sha256 && sha256 !== file.expected_sha256) {
      throw structuredError(
        "export_asset_checksum_mismatch",
        "素材校验失败，导出已停止。",
        `asset checksum does not match streamed bytes: ${file.relative_path}`,
        { details: { stage: "verify_source", commit_state: "not_committed", retryable: false } },
      );
    }
    file.size = size;
    file.sha256 = sha256;
    return { size, sha256 };
  } finally {
    if (buffer && releaseAssetStream) {
      releaseAssetStream();
    }
  }
}

function throwIfExportAborted(signal: AbortSignal | undefined, stage: string): void {
  if (!signal?.aborted) return;
  throw structuredError(
    "export_cancelled",
    "导出已取消，目标目录未提交任何新文件。",
    "export operation cancelled",
    { details: { stage, commit_state: "not_committed", retryable: true } },
  );
}

async function measureExportFiles(
  files: InternalExportFile[],
  signal?: AbortSignal,
): Promise<void> {
  for (const file of files) {
    throwIfExportAborted(signal, "read_source");
    if (file.build_after_stream) continue;
    await streamExportFile(file, undefined, signal);
  }
  for (const file of files) {
    throwIfExportAborted(signal, "build_manifest");
    if (!file.build_after_stream) continue;
    file.bytes = file.build_after_stream(files);
    delete file.build_after_stream;
    await streamExportFile(file, undefined, signal);
  }
}

function blocksForItem(
  data: ProjectData,
  item: ContentItem,
): ProjectData["blocks"] {
  return data.blocks
    .filter((block) =>
      data.documents.some((doc) =>
        doc.id === block.document_id && doc.content_item_id === item.id
      )
    )
    .sort((a, b) =>
      (a.order_index - b.order_index) || a.id.localeCompare(b.id)
    );
}

function svgForItem(
  data: ProjectData,
  item: ContentItem,
  selectedBlocks = blocksForItem(data, item),
  title = item.title,
): string {
  const blocks = selectedBlocks;
  const lines = [
    title,
    ...blocks.map((block) => blockText(block.content)).filter(Boolean),
  ];
  const height = Math.max(180, 50 + lines.length * 28);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}"><rect width="100%" height="100%" fill="white"/><style>text{font-family:system-ui,sans-serif;fill:#1f2430}</style>${
    lines.map((line, index) =>
      `<text x="48" y="${54 + index * 28}" font-size="${
        index === 0 ? 28 : 18
      }">${escapeHtml(line.slice(0, 180))}</text>`
    ).join("")
  }</svg>\n`;
}

async function writeOutput(
  files: InternalExportFile[],
  outputDir: string | undefined,
  replaceExisting = false,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!outputDir) {
    await measureExportFiles(files, signal);
    return [];
  }
  const rootPath = normalize(outputDir);
  await Deno.mkdir(rootPath, { recursive: true });
  const rootStat = await Deno.lstat(rootPath);
  if (rootStat.isSymlink || !rootStat.isDirectory) {
    throw new Error("导出目录必须是普通文件夹，不能是符号链接");
  }
  for (const file of files) {
    if (!relativeSafePath(file.relative_path)) {
      throw new Error("导出文件名必须是项目内相对路径");
    }
    await assertNoSymlinkEscape(rootPath, file.relative_path);
    const target = join(rootPath, file.relative_path);
    try {
      const existing = await Deno.lstat(target);
      if (existing.isSymlink || !existing.isFile) {
        throw new Error(`导出目标不是普通文件：${file.relative_path}`);
      }
      if (!replaceExisting) {
        throw new Error(`导出目标已存在：${file.relative_path}`);
      }
    } catch (caught) {
      if (!(caught instanceof Deno.errors.NotFound)) throw caught;
    }
  }
  const stagingName = `.acw-export-${crypto.randomUUID()}.tmp`;
  const staging = join(rootPath, stagingName);
  await Deno.mkdir(staging);
  const stagedRoot = join(staging, "files");
  const backupRoot = join(staging, "backups");
  const installed: string[] = [];
  const backedUp: Array<{ backup: string; target: string }> = [];
  const cleanupWarnings: string[] = [];
  let commitStarted = false;
  let commitFinished = false;
  try {
    await Deno.mkdir(stagedRoot);
    const writeStaged = async (file: InternalExportFile) => {
      throwIfExportAborted(signal, "write_staging");
      if (!relativeSafePath(file.relative_path)) {
        throw new Error("导出文件名必须是项目内相对路径");
      }
      const target = join(stagedRoot, file.relative_path);
      await Deno.mkdir(dirname(target), { recursive: true });
      const output = await Deno.open(target, { write: true, createNew: true });
      try {
        await streamExportFile(file, output, signal);
        await output.sync();
        const stat = await output.stat();
        if (!stat.isFile || stat.size !== file.size) {
          throw new Error(`导出暂存文件校验失败：${file.relative_path}`);
        }
      } catch (caught) {
        output.close();
        await Deno.remove(target).catch(() => {});
        throw caught;
      }
      output.close();
    };
    for (const file of files) {
      throwIfExportAborted(signal, "write_staging");
      if (!file.build_after_stream) await writeStaged(file);
    }
    for (const file of files) {
      throwIfExportAborted(signal, "build_manifest");
      if (!file.build_after_stream) continue;
      file.bytes = file.build_after_stream(files);
      delete file.build_after_stream;
      await writeStaged(file);
    }
    commitStarted = true;
    for (const file of files) {
      throwIfExportAborted(signal, "commit");
      const target = join(rootPath, file.relative_path);
      await Deno.mkdir(dirname(target), { recursive: true });
      if (replaceExisting) {
        try {
          const existing = await Deno.lstat(target);
          if (existing.isSymlink || !existing.isFile) {
            throw new Error(`导出目标不是普通文件：${file.relative_path}`);
          }
          const backup = join(backupRoot, file.relative_path);
          await Deno.mkdir(dirname(backup), { recursive: true });
          await Deno.rename(target, backup);
          backedUp.push({ backup, target });
        } catch (caught) {
          if (!(caught instanceof Deno.errors.NotFound)) throw caught;
        }
        await Deno.rename(join(stagedRoot, file.relative_path), target);
        installed.push(target);
      } else {
        // link() is atomic and fails if another writer created the target
        // after the collision pass; rename() would silently replace it.
        await Deno.link(join(stagedRoot, file.relative_path), target);
        installed.push(target);
        await Deno.remove(join(stagedRoot, file.relative_path));
      }
    }
    commitFinished = true;
  } finally {
    if (commitStarted && !commitFinished) {
      exportStreamMetrics.commit_rollbacks += 1;
      const rollbackErrors: string[] = [];
      for (const target of installed.reverse()) {
        try {
          await Deno.remove(target);
        } catch (caught) {
          if (!(caught instanceof Deno.errors.NotFound)) {
            rollbackErrors.push(caught instanceof Error ? caught.message : String(caught));
          }
        }
      }
      for (const pair of backedUp.reverse()) {
        try {
          try {
            await Deno.lstat(pair.target);
            rollbackErrors.push(`rollback target was recreated: ${pair.target}`);
            continue;
          } catch (caught) {
            if (!(caught instanceof Deno.errors.NotFound)) throw caught;
          }
          await Deno.mkdir(dirname(pair.target), { recursive: true });
          await Deno.rename(pair.backup, pair.target);
        } catch (caught) {
          rollbackErrors.push(caught instanceof Error ? caught.message : String(caught));
        }
      }
      if (rollbackErrors.length) {
        throw structuredError(
          "export_commit_uncertain",
          "导出提交失败，部分旧输出已保留以便恢复。请先检查输出目录。",
          rollbackErrors.join("; "),
          {
            recoverable: false,
            details: {
              stage: "commit",
              commit_state: "outcome_uncertain",
              retryable: false,
              backup_preserved: true,
            },
          },
        );
      }
      await Deno.remove(staging, { recursive: true }).catch(() => {});
      if (signal?.aborted) throw structuredError(
        "export_cancelled",
        "导出已取消，已有输出已恢复。",
        "export operation cancelled and previous outputs were restored",
        { details: { stage: "commit_rollback", commit_state: "not_committed", retryable: true } },
      );
      throw structuredError(
        "export_commit_failed",
        "导出提交失败，已有输出已恢复。",
        "export commit failed; previous output files were restored",
        {
          details: {
            stage: "commit",
            commit_state: "not_committed",
            retryable: true,
          },
        },
      );
    }
    if (!commitStarted || commitFinished) {
      try {
        await Deno.remove(staging, { recursive: true });
      } catch (caught) {
        if (!(caught instanceof Deno.errors.NotFound) && commitFinished) {
          cleanupWarnings.push(
            `导出已提交，但暂存清理失败：${caught instanceof Error ? caught.message : String(caught)}`,
          );
        }
      }
    }
  }
  return cleanupWarnings;
}

function makeExportPathsUnique(files: ExportFile[]): void {
  const used = new Set<string>();
  for (const file of files) {
    const original = file.relative_path;
    if (!used.has(original)) {
      used.add(original);
      continue;
    }
    const folder = dirname(original);
    const name = basename(original);
    const suffix = extname(name);
    const stem = suffix ? name.slice(0, -suffix.length) : name;
    let index = 2;
    let candidate = join(folder, `${stem}-${index}${suffix}`).replaceAll(
      "\\",
      "/",
    );
    while (used.has(candidate)) {
      candidate = join(folder, `${stem}-${++index}${suffix}`).replaceAll(
        "\\",
        "/",
      );
    }
    file.relative_path = candidate;
    used.add(candidate);
  }
}

export async function exportProject(
  data: ProjectData,
  preset: ExportPreset,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const signal = options.signal;
  data = structuredClone(data);
  const cloneableOptions = { ...options };
  delete cloneableOptions.signal;
  options = structuredClone(cloneableOptions);
  throwIfExportAborted(signal, "preflight");
  options.layout_instance_id ??= preset.layout_instance_id ?? null;
  const target = resolveTarget(preset);
  const preflight = await preflightExport(data, preset, options);
  throwIfExportAborted(signal, "preflight");
  const presetFormat = preset.format ?? preset.settings.format;
  if (
    presetFormat === "png" || presetFormat === "jpg" ||
    presetFormat === "jpeg"
  ) throw new ExportCapabilityError("bitmap");
  // Warnings may be acknowledged by the caller; a blocking issue must never
  // be bypassed because that would create a known damaged export.
  if (preflight.blocking.length) throw new ExportBlockedError(preflight);
  const requiredWarnings = [
    ...new Set(preflight.warnings.map((issue) => issue.code)),
  ];
  const acknowledgedWarnings = new Set(options.acknowledged_warnings ?? []);
  const missingWarnings = requiredWarnings.filter((code) =>
    !acknowledgedWarnings.has(code)
  );
  if (missingWarnings.length) {
    throw new ExportWarningConfirmationError(preflight, missingWarnings);
  }
  const files: InternalExportFile[] = [];
  const items = semanticItems(data, options.content_item_id);
  const projectionTargets: ExportTarget[] = [
    "markdown",
    "html",
    "web",
    "wechat",
    "pdf",
  ];
  const projection = projectionTargets.includes(target)
    ? projectionForExport(data, options)
    : null;
  if (target === "markdown" && projection) {
    files.push({
      relative_path: options.content_item_id && items[0]
        ? renderName(preset, items[0], "正文", 0, "md")
        : renderName(preset, null, "整门课程", 0, "md"),
      mime_type: "text/markdown",
      bytes: textBytes(renderPublishMarkdown(projection)),
    });
  } else if (target === "html" && projection) {
    files.push({
      relative_path: options.content_item_id && items[0]
        ? renderName(preset, items[0], "正文", 0, "html")
        : renderName(preset, null, "整门课程", 0, "html"),
      mime_type: "text/html",
      bytes: textBytes(renderPublishHtml(projection)),
    });
  } else if (target === "web" && projection) {
    files.push({
      relative_path: "index.html",
      mime_type: "text/html",
      bytes: textBytes(renderPublishHtml(projection)),
    }, {
      relative_path: "manifest.json",
      mime_type: "application/json",
      bytes: jsonBytes({
        schema_version: 1,
        project_id: projection.project_id,
        title: projection.title,
        scope: projection.scope,
        content_item_id: projection.content_item_id,
        generated_from_updated_at: projection.generated_from_updated_at,
        entrypoint: "index.html",
        assets: projection.media.map((media) => media.output_path),
      }),
    });
  } else if (target === "wechat" && projection) {
    files.push({
      relative_path: "wechat-rich-text.html",
      mime_type: "text/html",
      bytes: textBytes(renderPublishHtml(projection, { migration: true })),
    });
  } else if (target === "pdf" && projection) {
    files.push({
      relative_path: options.content_item_id && items[0]
        ? renderName(preset, items[0], "正文", 0, "pdf")
        : `${cleanName(data.project.title, "course")}-course.pdf`,
      mime_type: "application/pdf",
      bytes: renderPublishPdf(projection),
    });
  } else if (target === "json") {
    const sanitized = sanitizeProjectForExport(
      options.include_private_conversations ? data : (() => {
        const copy = structuredClone(data) as
          & ProjectData
          & Record<string, unknown>;
        copy.conversations = [];
        copy.messages = [];
        copy.conversation_sources = [];
        copy.context_packs = [];
        copy.context_pack_items = [];
        return copy;
      })(),
    );
    files.push({
      relative_path: "project.json",
      mime_type: "application/json",
      bytes: textBytes(exportProjectJson(sanitized)),
    });
  } else if (target === "image") {
    const settings = preset.settings as Record<string, unknown>;
    const sectionPagination = preset.page_mode === "multi_page" ||
      preset.pagination_mode === "section" ||
      settings.pagination_mode === "section";
    items.forEach((item, itemIndex) => {
      const sections = preset.layout_instance_id
        ? data.layout_sections
          .filter((section) =>
            section.layout_instance_id === preset.layout_instance_id
          )
          .sort((a, b) =>
            (a.order_index - b.order_index) || (a.page_index - b.page_index) ||
            a.id.localeCompare(b.id)
          )
        : [];
      if (!sectionPagination || !sections.length) {
        files.push({
          relative_path: renderName(preset, item, "正文", itemIndex, "svg"),
          mime_type: "image/svg+xml",
          bytes: textBytes(svgForItem(data, item)),
        });
        return;
      }
      const blocks = blocksForItem(data, item);
      const placements = data.placements.filter((placement) =>
        placement.layout_instance_id === preset.layout_instance_id
      );
      const placedBlockIds = new Set<string>();
      sections.forEach((section, sectionIndex) => {
        const sectionBlockIds = new Set(
          placements.filter((placement) => placement.section_id === section.id)
            .map((placement) => placement.block_id),
        );
        sectionBlockIds.forEach((blockId) => placedBlockIds.add(blockId));
        const sectionBlocks = blocks.filter((block) =>
          sectionBlockIds.has(block.id)
        );
        files.push({
          relative_path: renderName(
            preset,
            item,
            section.name,
            itemIndex * sections.length + sectionIndex,
            "svg",
          ),
          mime_type: "image/svg+xml",
          bytes: textBytes(svgForItem(data, item, sectionBlocks, section.name)),
        });
      });
      const unsectioned = blocks.filter((block) =>
        !placedBlockIds.has(block.id)
      );
      if (unsectioned.length) {
        files.push({
          relative_path: renderName(
            preset,
            item,
            "正文",
            itemIndex * sections.length + sections.length,
            "svg",
          ),
          mime_type: "image/svg+xml",
          bytes: textBytes(svgForItem(data, item, unsectioned)),
        });
      }
    });
  } else if (target === "asset_package") {
    const packageAssets = data.assets.filter((asset) => !asset.archived);
    for (const asset of packageAssets) {
      if (!relativeSafePath(asset.storage_path)) continue;
      const file = await exportAssetFile(asset, options);
      if (file) files.push(file);
    }
    files.push({
      relative_path: "assets-manifest.json",
      mime_type: "application/json",
      build_after_stream: (streamed) => jsonBytes({
        schema_version: data.schema_version,
        project_id: data.project.id,
        assets: packageAssets.map((asset) => ({
          id: asset.id,
          filename: cleanName(asset.filename),
          type: asset.type,
          mime_type: asset.mime_type,
          checksum: streamed.find((file) => file.asset_id === asset.id)?.sha256 ?? null,
          path: relativeSafePath(asset.storage_path) ? asset.storage_path : null,
        })),
      }),
    });
  } else if (target === "full_project") {
    const sanitized = sanitizeProjectForExport(
      options.include_private_conversations ? data : (() => {
        const copy = structuredClone(data) as ProjectData;
        copy.conversations = [];
        copy.messages = [];
        copy.conversation_sources = [];
        copy.context_packs = [];
        copy.context_pack_items = [];
        return copy;
      })(),
    );
    files.push({
      relative_path: "project.json",
      mime_type: "application/json",
      build_after_stream: (streamed) => {
        const project = structuredClone(sanitized);
        for (const asset of project.assets) {
          const actual = streamed.find((file) => file.asset_id === asset.id)?.sha256;
          if (actual) asset.checksum = actual;
        }
        return textBytes(exportProjectJson(project));
      },
    });
    files.push({
      relative_path: "COURSE_MAP.md",
      mime_type: "text/markdown",
      bytes: textBytes(renderCourseMap(data)),
    });
    for (const [index, item] of items.entries()) {
      files.push({
        relative_path: `contents/${
          renderName(preset, item, "正文", index, "md")
        }`,
        mime_type: "text/markdown",
        bytes: textBytes(renderMarkdownWithoutLayoutRequirements(data, item)),
      });
    }
    files.push({
      relative_path: "publications.json",
      mime_type: "application/json",
      bytes: jsonBytes(sanitizeProjectForExport(data.publications)),
    });
    for (
      const asset of data.assets.filter((candidate) => !candidate.archived)
    ) {
      if (!relativeSafePath(asset.storage_path)) continue;
      const file = await exportAssetFile(asset, options);
      if (file) files.push(file);
    }
  } else {
    throw new ExportCapabilityError(String(target));
  }
  if (projection && target !== "pdf") {
    for (const media of projection.media) {
      const asset = data.assets.find((candidate) => candidate.id === media.id);
      if (
        !asset || files.some((file) => file.relative_path === media.output_path)
      ) continue;
      const file = await exportAssetFile(asset, options, media.output_path);
      if (file) {
        file.mime_type = media.mime_type;
        files.push(file);
      }
    }
  }
  makeExportPathsUnique(files);
  files.sort((a, b) => {
    const aAsset = a.relative_path.startsWith("assets/") ? 1 : 0;
    const bAsset = b.relative_path.startsWith("assets/") ? 1 : 0;
    return (aAsset - bAsset) || a.relative_path.localeCompare(b.relative_path);
  });
  const warnings = await writeOutput(
    files,
    options.output_dir,
    options.replace_existing === true,
    signal,
  );
  const publicFiles = files.map((file): ExportFile => {
    const {
      source_path: _sourcePath,
      source_state: _sourceState,
      expected_sha256: _expectedSha256,
      build_after_stream: _buildAfterStream,
      ...publicFile
    } = file;
    if (file.asset_id || (file.bytes && file.bytes.byteLength > EXPORT_INLINE_BYTES)) {
      delete publicFile.bytes;
    }
    return publicFile;
  });
  return { files: publicFiles, preflight, target, ...(warnings.length ? { warnings } : {}) };
}

export class ManualPublishAdapter implements PublishAdapter {
  readonly platform: string;

  constructor(platform = "手动发布") {
    this.platform = platform;
  }

  async validate(request: PublishRequest): Promise<PublishValidation> {
    const preflight = await preflightExport(request.data, request.preset, {
      ...(request.options ?? {}),
      content_item_id: request.content_item_id,
    });
    return {
      ok: preflight.ok,
      preflight,
      message: preflight.ok ? "可以导出并手动发布" : "请先处理导出前的严重问题",
    };
  }

  async prepare(request: PublishRequest): Promise<PublishPrepared> {
    return {
      export: await exportProject(request.data, request.preset, {
        ...(request.options ?? {}),
        content_item_id: request.content_item_id,
      }),
    };
  }

  publish(
    request: PublishRequest,
    prepared: PublishPrepared,
  ): Promise<Publication> {
    const publication = createPublication(request.data, {
      content_item_id: request.content_item_id,
      platform: request.preset.platform || this.platform,
      layout_instance_id: request.preset.layout_instance_id,
      status: "published",
      version_label: request.version_label ?? "手动发布",
      export_path: request.export_path ??
        prepared.export.files[0]?.relative_path ?? null,
    });
    publication.published_at = new Date().toISOString();
    publication.external_url = request.external_url ?? null;
    return Promise.resolve(publication);
  }

  update(
    request: PublishRequest,
    prepared: PublishPrepared,
  ): Promise<Publication> {
    const existing = request.data.publications
      .filter((candidate) =>
        candidate.content_item_id === request.content_item_id &&
        candidate.platform === (request.preset.platform || this.platform)
      )
      .sort((a, b) =>
        (b.published_at ?? "").localeCompare(a.published_at ?? "")
      )[0];
    if (!existing) return this.publish(request, prepared);
    existing.status = "published";
    existing.version_label = request.version_label ?? existing.version_label;
    existing.export_path = request.export_path ??
      prepared.export.files[0]?.relative_path ?? existing.export_path;
    existing.external_url = request.external_url ?? existing.external_url;
    existing.published_at = new Date().toISOString();
    return Promise.resolve(existing);
  }

  getStatus(data: ProjectData, contentItemId: string): Promise<PublishStatus> {
    const publication =
      data.publications.filter((candidate) =>
        candidate.content_item_id === contentItemId
      ).sort((a, b) =>
        (b.published_at ?? "").localeCompare(a.published_at ?? "")
      ).at(0) ?? null;
    return Promise.resolve({
      publication,
      state: publication?.status ?? "unpublished",
    });
  }
}
