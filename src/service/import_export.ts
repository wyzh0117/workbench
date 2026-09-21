import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
} from "node:path";
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
  ProjectData,
  Publication,
} from "../domain/types.ts";
import { migrateProject } from "../domain/store.ts";
import { renderCourseMap } from "../domain/views.ts";
import { sha256Bytes } from "../domain/util.ts";
import {
  exportProjectJson,
  sanitizeHtml,
  sanitizeProjectForExport,
} from "./security.ts";

/**
 * Import, export, and publication are deliberately kept behind one service
 * boundary.  The UI receives previews/results, never raw filesystem handles.
 */

export type ImportMode = "content" | "blueprint" | "asset" | "project";
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
  /** Kept in memory between preview and confirm; never serialized to a project. */
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
    | "unsupported_format";
  message: string;
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
  counts: {
    content_requirements: number;
    layout_requirements: number;
    missing_assets: number;
    overflow: number;
    text_overflow: number;
    missing_fonts: number;
    external_references: number;
  };
}

export interface ExportFile {
  relative_path: string;
  mime_type: string;
  bytes: Uint8Array;
}

export interface ExportOptions {
  content_item_id?: string | null;
  project_root?: string;
  output_dir?: string;
  include_private_conversations?: boolean;
  asset_bytes?: Record<string, Uint8Array>;
  force_warnings?: boolean;
}

export interface ExportResult {
  files: ExportFile[];
  preflight: ExportPreflightReport;
  target: ExportTarget;
}

export class ExportBlockedError extends Error {
  readonly report: ExportPreflightReport;

  constructor(report: ExportPreflightReport) {
    super("导出前检查发现无法生成的严重问题");
    this.name = "ExportBlockedError";
    this.report = report;
  }
}

export class ExportCapabilityError extends Error {
  constructor(format: string) {
    super(
      `${format.toUpperCase()} 导出当前不可用；请先导出 Markdown、HTML 或 SVG。`,
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

async function sourceBytes(
  source: ImportSource,
): Promise<{ bytes: Uint8Array; path: string | null; name: string }> {
  if (source.bytes !== undefined) {
    return {
      bytes: toBytes(source.bytes),
      path: null,
      name: cleanName(source.name ?? "导入内容"),
    };
  }
  if (!source.path) throw new Error("导入需要文件内容或路径");
  const stat = await Deno.lstat(source.path);
  if (stat.isSymlink) {
    throw new Error("为避免越过项目边界，导入不支持符号链接文件");
  }
  if (stat.isDirectory) throw new Error("文件夹需要通过文件夹入口导入");
  return {
    bytes: await Deno.readFile(source.path),
    path: source.path,
    name: cleanName(source.name ?? basename(source.path)),
  };
}

async function listFiles(
  path: string,
  visited = new Set<string>(),
): Promise<string[]> {
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
    if (entry.name.startsWith(".")) continue;
    const child = join(path, entry.name);
    if (entry.isSymlink) continue;
    if (entry.isDirectory) result.push(...await listFiles(child, visited));
    else if (entry.isFile) result.push(child);
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
): Promise<ImportItemPreview> {
  if (source.path) {
    const stat = await Deno.lstat(source.path);
    if (stat.isSymlink) {
      throw new Error("为避免越过项目边界，导入不支持符号链接路径");
    }
    if (stat.isDirectory) {
      const children: ImportItemPreview[] = [];
      for (const path of await listFiles(source.path)) {
        children.push(await previewOne({ path }, data, mode));
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
      };
    }
  }
  const loaded = await sourceBytes(source);
  const format = formatFor(
    loaded.name,
    source.mime_type ?? mimeFor(loaded.name),
  );
  const checksum = await sha256Bytes(loaded.bytes);
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
    size: loaded.bytes.byteLength,
    checksum,
    duplicate_asset_id: duplicate?.id ?? null,
    source_path: loaded.path,
    title: inferTitle(loaded.name, null),
    text: null,
    blocks: [],
    warnings: [],
    errors: [],
    children: [],
    payload: loaded.bytes,
  };
  if (SCRIPT_EXTENSIONS.has(extension(loaded.name))) {
    item.supported = false;
    item.errors.push(
      "脚本和可执行文件只允许作为普通文件查看，导入过程不会执行它。",
    );
    return item;
  }
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
  if (format === "unsupported") {
    item.supported = false;
    item.errors.push("该文件类型暂不支持导入。");
    return item;
  }
  const text = textDecoder(loaded.bytes);
  item.text = text;
  item.title = inferTitle(loaded.name, text);
  if (format === "json") {
    try {
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
  options: { data?: ProjectData | null; mode?: ImportMode } = {},
): Promise<ImportPreview> {
  const mode = options.mode ?? "content";
  const items: ImportItemPreview[] = [];
  for (const source of sources) {
    try {
      items.push(await previewOne(source, options.data ?? null, mode));
    } catch (caught) {
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
      });
    }
  }
  const all = flatten(items);
  const duplicates =
    all.filter((item) => item.duplicate_asset_id !== null).length;
  return {
    id: uuid(),
    mode,
    items,
    counts: countItems(items),
    duplicate_count: duplicates,
    warnings: all.flatMap((item) => item.warnings),
    errors: all.flatMap((item) => item.errors),
    requires_confirmation: true,
  };
}

async function writeAsset(
  root: string | undefined,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!root) return;
  if (!relativeSafePath(relativePath)) {
    throw new Error("素材路径必须是项目内相对路径");
  }
  const rootPath = normalize(root);
  await assertNoSymlinkEscape(rootPath, relativePath);
  const target = join(rootPath, relativePath);
  await Deno.mkdir(dirname(target), { recursive: true });
  await Deno.writeFile(target, bytes);
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

async function confirmOne(
  data: ProjectData,
  item: ImportItemPreview,
  options: ImportConfirmOptions,
  result: ImportConfirmationResult,
): Promise<void> {
  if (item.children.length) {
    for (const child of item.children) {
      await confirmOne(data, child, options, result);
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
    await writeAsset(
      options.project_root,
      storagePath,
      item.payload ?? new Uint8Array(),
    );
    const added = addAsset(data, data.project.id, {
      type: "document",
      filename,
      storage_path: storagePath,
      mime_type: mimeFor(filename),
      checksum: item.checksum ?? "",
      file_size: item.size,
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
    await writeAsset(
      options.project_root,
      storagePath,
      item.payload ?? new Uint8Array(),
    );
    const added = addAsset(data, data.project.id, {
      type: assetTypeFor(filename, mimeFor(filename)),
      filename,
      storage_path: storagePath,
      mime_type: mimeFor(filename),
      checksum: item.checksum ?? "",
      file_size: item.size,
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
  for (const item of preview.items) {
    await confirmOne(data, item, effectiveOptions, result);
  }
  return result;
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
    },
  };
}

async function assetExists(
  _data: ProjectData,
  asset: ProjectData["assets"][number],
  options: ExportOptions,
): Promise<boolean> {
  if (options.asset_bytes?.[asset.id]) return true;
  if (!relativeSafePath(asset.storage_path) || !options.project_root) {
    return false;
  }
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
  const report = emptyReport();
  const target = resolveTarget(preset);
  const allowed: ExportTarget[] = [
    "markdown",
    "html",
    "json",
    "image",
    "pdf",
    "asset_package",
    "full_project",
    "custom",
  ];
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
    target === "pdf" ||
    (presetFormat === "png" || presetFormat === "jpg" ||
      presetFormat === "jpeg")
  ) {
    reportIssue(report, {
      severity: "blocking",
      code: "unsupported_format",
      message: `${
        target === "pdf" ? "PDF" : "位图"
      } 导出当前没有可靠的本地渲染能力。`,
    });
  }
  const itemIds = new Set(
    semanticItems(data, options.content_item_id).map((item) => item.id),
  );
  const layoutId = preset.layout_instance_id;
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
  const checkedMissingAssets = new Set<string>();
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
  const layouts = layoutId
    ? data.layout_instances.filter((layout) =>
      layout.id === layoutId && itemIds.has(layout.content_item_id)
    )
    : [];
  for (const layout of layouts) {
    const grid = layout.grid_definition as Record<string, unknown>;
    const columns = Array.isArray(grid.columns) ? grid.columns.length : 1;
    const rows = Array.isArray(grid.rows) ? grid.rows.length : 1;
    for (
      const placement of data.placements.filter((candidate) =>
        candidate.layout_instance_id === layout.id
      )
    ) {
      const section = placement.section_id
        ? data.layout_sections.find((candidate) =>
          candidate.id === placement.section_id &&
          candidate.layout_instance_id === layout.id
        )
        : null;
      const sectionGrid = (section?.grid_definition ?? grid) as Record<
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
  report.ok = report.blocking.length === 0;
  return report;
}

async function bytesForAsset(
  _data: ProjectData,
  asset: ProjectData["assets"][number],
  options: ExportOptions,
): Promise<Uint8Array | null> {
  const supplied = options.asset_bytes?.[asset.id];
  if (supplied) return supplied;
  if (!options.project_root || !relativeSafePath(asset.storage_path)) {
    return null;
  }
  if (await hasSymlinkComponent(options.project_root, asset.storage_path)) {
    return null;
  }
  try {
    return await Deno.readFile(
      join(normalize(options.project_root), asset.storage_path),
    );
  } catch {
    return null;
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
  files: ExportFile[],
  outputDir: string | undefined,
): Promise<void> {
  if (!outputDir) return;
  for (const file of files) {
    if (!relativeSafePath(file.relative_path)) {
      throw new Error("导出文件名必须是项目内相对路径");
    }
    const rootPath = normalize(outputDir);
    await assertNoSymlinkEscape(rootPath, file.relative_path);
    const target = join(rootPath, file.relative_path);
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.writeFile(target, file.bytes);
  }
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
  const target = resolveTarget(preset);
  const preflight = await preflightExport(data, preset, options);
  const presetFormat = preset.format ?? preset.settings.format;
  if (
    target === "pdf" ||
    (presetFormat === "png" || presetFormat === "jpg" ||
      presetFormat === "jpeg")
  ) throw new ExportCapabilityError(target === "pdf" ? "pdf" : "bitmap");
  // Warnings may be acknowledged by the caller; a blocking issue must never
  // be bypassed because that would create a known damaged export.
  if (preflight.blocking.length) throw new ExportBlockedError(preflight);
  const files: ExportFile[] = [];
  const items = semanticItems(data, options.content_item_id);
  if (target === "markdown") {
    items.forEach((item, index) =>
      files.push({
        relative_path: renderName(preset, item, "正文", index, "md"),
        mime_type: "text/markdown",
        bytes: textBytes(renderMarkdownWithoutLayoutRequirements(data, item)),
      })
    );
  } else if (target === "html") {
    items.forEach((item, index) =>
      files.push({
        relative_path: renderName(preset, item, "正文", index, "html"),
        mime_type: "text/html",
        bytes: textBytes(
          renderSemanticHtml(data, item, preset.layout_instance_id),
        ),
      })
    );
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
    const manifest = {
      schema_version: data.schema_version,
      project_id: data.project.id,
      assets: data.assets.filter((asset) => !asset.archived).map((asset) => ({
        id: asset.id,
        filename: cleanName(asset.filename),
        type: asset.type,
        mime_type: asset.mime_type,
        checksum: asset.checksum,
        path: relativeSafePath(asset.storage_path) ? asset.storage_path : null,
      })),
    };
    files.push({
      relative_path: "assets-manifest.json",
      mime_type: "application/json",
      bytes: jsonBytes(manifest),
    });
    for (
      const asset of data.assets.filter((candidate) => !candidate.archived)
    ) {
      const bytes = await bytesForAsset(data, asset, options);
      if (bytes && relativeSafePath(asset.storage_path)) {
        files.push({
          relative_path: asset.storage_path,
          mime_type: asset.mime_type || mimeFor(asset.filename),
          bytes,
        });
      }
    }
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
      bytes: textBytes(exportProjectJson(sanitized)),
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
      const bytes = await bytesForAsset(data, asset, options);
      if (bytes && relativeSafePath(asset.storage_path)) {
        files.push({
          relative_path: asset.storage_path,
          mime_type: asset.mime_type || mimeFor(asset.filename),
          bytes,
        });
      }
    }
  } else {
    throw new ExportCapabilityError(String(target));
  }
  makeExportPathsUnique(files);
  files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  await writeOutput(files, options.output_dir);
  return { files, preflight, target };
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
