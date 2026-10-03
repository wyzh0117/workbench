/**
 * V1-T04 Task 12 — Strategy A in-place folder adoption after confirm.
 *
 * Spec §§32–35, 25. Writes project.json + .workspace into the chosen folder.
 * Copies confirmed media into assets/. Never moves/renames/deletes originals.
 * Requires ImportMappingPlan.confirmed === true.
 */
import { basename, dirname, extname, isAbsolute, join, normalize, relative } from "node:path";
import { addAsset, addAssetUsage } from "../domain/assets.ts";
import { addStage } from "../domain/course.ts";
import { appendBlock, createDocument } from "../domain/document.ts";
import { createEmptyProjectData } from "../domain/store.ts";
import { initializeContentStatuses } from "../domain/status.ts";
import type {
  AssetType,
  BlockType,
  ContentItem,
  JsonObject,
  JsonValue,
  ProjectData,
  SourceMaterialKind,
} from "../domain/types.ts";
import { id, now, sha256Bytes } from "../domain/util.ts";
import { createInboxItem } from "../domain/workflow.ts";
import { ADOPTABLE_FILE_KINDS, scanMediaDescendants } from "./folder_scan.ts";
import type { MediaDescendantScan } from "./folder_scan.ts";
import type {
  DocumentImportFile,
  DocumentImportOutcome,
  DocumentImportReport,
  ImportMappingItem,
  ImportMappingPlan,
  ImportMappingDestination,
  MappingRole,
} from "./folder_mapping.ts";
import {
  DOCUMENT_IMPORT_EXTENSIONS,
  documentImportReportFromFiles,
  isDocumentImportCandidate,
} from "./folder_mapping.ts";
import { ProjectDirectoryStore, inspectProjectDirectory } from "./storage.ts";
import { parseMarkdown } from "../../app/markdown.js";

export interface FolderAdoptionOptions {
  /** Existing project to extend; default creates empty project in plan.root. */
  data?: ProjectData;
  /** Override write root (defaults to plan.root). */
  project_root?: string;
  project_title?: string;
  duplicate_choice?: "existing" | "copy" | "cancel";
  /** When true, mutate data + copy assets but skip project.json write. */
  skip_project_write?: boolean;
  /** Persist through the caller's active project lease before promoting assets. */
  persist_project?: (data: ProjectData) => Promise<void>;
  /**
   * §3.2 Case C: the user confirmed that an existing `project.json` in this
   * folder is unusable and chose to re-import it. The old manifest is moved
   * aside, never deleted, and only after the import is otherwise ready to commit.
   */
  replace_invalid_project?: boolean;
}

export interface FolderAdoptionResult {
  data: ProjectData;
  root: string;
  stage_ids: string[];
  content_item_ids: string[];
  asset_ids: string[];
  /** Inbox ids used as Source / Reference material (§33). */
  source_ids: string[];
  reused_asset_ids: string[];
  warnings: string[];
  /** Relative paths written under assets/. */
  copied_files: string[];
  /** Always empty — originals are never relocated. */
  copied_original_paths?: string[];
  /**
   * §28 — per-document outcome of the body-content import, present only when the
   * confirmed plan actually carried document candidates. The same key the native
   * shell returns, so the dialog's result panel reads one shape from both.
   */
  document_import?: DocumentImportReport;
}

const TEXT_EXT = new Set([".md", ".markdown", ".txt"]);
/**
 * §18 formats this shell can genuinely turn into blocks. The rest of the §18
 * list (`tex` / `latex` / `docx` / `epub` / `pdf`) is NOT parsed here — no
 * TypeScript parser is faked for this report — so a lesson-mapped one records an
 * honest `failed` row instead of pushing binary bytes into a paragraph block.
 */
const BROWSER_BODY_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text"]);
// Mirrors `normalize_asset_type` / `mime_for_filename` in src-tauri/src/lib.rs
// and ASSET_EXTENSIONS in src/service/folder_scan.ts. Adding an extension here
// without adding it there makes a folder adopted in the browser and reopened in
// the native app classify differently.
const ASSET_EXT: Record<string, AssetType> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "gif",
  ".webp": "image",
  ".svg": "image",
  ".avif": "image",
  ".mp4": "video",
  ".webm": "video",
  ".mov": "video",
  ".m4v": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".ogg": "audio",
  ".pdf": "document",
  ".doc": "document",
  ".docx": "document",
};

function extension(name: string): string {
  return extname(name).toLowerCase();
}

function cleanName(value: string, fallback = "未命名"): string {
  const base = basename(String(value || "").replaceAll("\\", "/"));
  const cleaned = base.replace(/[^\w.\u4e00-\u9fff\-()+ ]+/g, "_").trim();
  return cleaned || fallback;
}

function entryTitle(relativePath: string): string {
  const name = basename(relativePath.replaceAll("\\", "/"));
  return name.replace(/\.[^.]+$/, "") || name || "未命名";
}

function mimeFor(name: string, fallback = "application/octet-stream"): string {
  const ext = extension(name);
  const map: Record<string, string> = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[ext] || fallback;
}

function assetTypeFor(name: string): AssetType {
  return ASSET_EXT[extension(name)] ?? "other";
}

function parseBlocks(
  text: string,
  format: "markdown" | "text",
): Array<{ type: BlockType; content: string; settings?: JsonObject }> {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Array<{ type: BlockType; content: string; settings?: JsonObject }> =
    [];
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
    }
    blocks.push({ type: "paragraph", content: value });
  }
  if (fenced && code.length) {
    blocks.push({ type: "code", content: code.join("\n") });
  }
  return blocks;
}

function isIncluded(item: ImportMappingItem): boolean {
  // selected + ignore → ignore (§ Task 12). Unselected → skip.
  if (item.mapping === "ignore") return false;
  if (!item.selected) return false;
  if (item.error) return false;
  return true;
}

function absPath(root: string, relativePath: string): string {
  const rel = relativePath.replaceAll("\\", "/");
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length || isAbsolute(rel) || parts.some((part) => part === ".." || part === ".")) {
    throw new Error("导入路径必须位于所选文件夹内");
  }
  const candidate = normalize(join(root, ...parts));
  const escaped = relative(normalize(root), candidate);
  if (escaped === ".." || escaped.startsWith(`..${Deno.build.os === "windows" ? "\\" : "/"}`) || isAbsolute(escaped)) {
    throw new Error("导入路径必须位于所选文件夹内");
  }
  return candidate;
}

async function sourceFilePath(root: string, relativePath: string): Promise<string> {
  const candidate = absPath(root, relativePath);
  let current = normalize(root);
  for (const part of relative(normalize(root), candidate).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const stat = await Deno.lstat(current);
    if (stat.isSymlink) throw new Error("导入路径包含符号链接");
  }
  const resolvedRoot = await Deno.realPath(root);
  const resolved = await Deno.realPath(candidate);
  const escaped = relative(resolvedRoot, resolved);
  if (escaped === ".." || escaped.startsWith(`..${Deno.build.os === "windows" ? "\\" : "/"}`) || isAbsolute(escaped)) {
    throw new Error("导入路径超出所选文件夹");
  }
  return resolved;
}

async function markdownImagePath(
  sourceRoot: string,
  markdownPath: string,
  href: string,
): Promise<string> {
  const imagePath = String(href || "").split(/[?#]/, 1)[0] || "";
  let decoded = imagePath;
  try {
    decoded = decodeURIComponent(imagePath);
  } catch {
    throw new Error("图片路径编码无效");
  }
  if (!decoded || decoded.startsWith("//") || isAbsolute(decoded) || /^[a-z][a-z\d+.-]*:/i.test(decoded)) {
    throw new Error("仅允许所选文件夹内的本地图片");
  }
  const markdownDir = dirname(markdownPath.replaceAll("\\", "/"));
  const joined = normalize(join(markdownDir === "." ? "" : markdownDir, decoded));
  return await sourceFilePath(sourceRoot, joined.replaceAll("\\", "/"));
}

function parentStageId(
  relativePath: string,
  stageByRel: Map<string, string>,
): string | null {
  const parts = relativePath.replaceAll("\\", "/").split("/");
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const prefix = parts.slice(0, i).join("/");
    const stageId = stageByRel.get(prefix);
    if (stageId) return stageId;
  }
  return null;
}

async function projectJsonExists(root: string): Promise<boolean> {
  try {
    const stat = await Deno.lstat(join(root, "project.json"));
    return stat.isFile && !stat.isSymlink;
  } catch (caught) {
    if (caught instanceof Deno.errors.NotFound) return false;
    throw caught;
  }
}

/**
 * §3.2 Case C: keep the unusable manifest under a name the folder scan already
 * ignores (`*.backup`) instead of letting the atomic write replace it. Mirrors
 * the native `project.json.<stamp>.invalid.backup` naming.
 */
async function quarantineInvalidManifest(root: string): Promise<string> {
  const original = join(root, "project.json");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "");
  let backup = join(root, `project.json.${stamp}.invalid.backup`);
  for (let attempt = 1; await pathExists(backup); attempt += 1) {
    if (attempt > 99) {
      throw new Error("无法为原有的 project.json 找到可用的备份文件名，导入已中止。");
    }
    backup = join(root, `project.json.${stamp}-${attempt}.invalid.backup`);
  }
  await Deno.rename(original, backup);
  return backup;
}

/** Put the manifest back under its original name when the commit failed. */
async function restoreQuarantinedManifest(root: string, backup: string): Promise<void> {
  try {
    await Deno.rename(backup, join(root, "project.json"));
  } catch {
    // The backup file still holds every byte; report through the caller's error.
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureWorkspace(root: string): Promise<void> {
  for (const path of [join(root, ".workspace"), join(root, ".workspace", "adopt-staging")]) {
    await ensureManagedDirectory(path);
  }
}

async function ensureManagedDirectory(path: string): Promise<void> {
  try {
    const stat = await Deno.lstat(path);
    if (stat.isSymlink || !stat.isDirectory) throw new Error(`导入管理目录不安全：${path}`);
  } catch (caught) {
    if (!(caught instanceof Deno.errors.NotFound)) throw caught;
    await Deno.mkdir(path).catch(async (error) => {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      const stat = await Deno.lstat(path);
      if (stat.isSymlink || !stat.isDirectory) throw new Error(`导入管理目录不安全：${path}`);
    });
  }
}

async function copyManagedAsset(
  root: string,
  sourceAbs: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = join(root, ...relativePath.split("/"));
  await Deno.mkdir(dirname(target), { recursive: true });
  // Prefer copyFile so we never truncate the original; fall back to write of
  // already-read bytes when source and destination differ.
  try {
    await Deno.copyFile(sourceAbs, target);
  } catch {
    await Deno.writeFile(target, bytes);
  }
}

async function cleanupStaging(
  root: string,
  staged: Array<{ staging: string; final: string }>,
  stagingRoot: string,
): Promise<void> {
  for (const pair of staged) {
    try {
      await Deno.remove(join(root, ...pair.staging.split("/")));
    } catch {
      // best-effort; never touch user originals
    }
  }
  try {
    await Deno.remove(join(root, ...stagingRoot.split("/")), { recursive: true });
  } catch {
    // ignore
  }
}

async function promoteStaging(
  root: string,
  staged: Array<{ staging: string; final: string }>,
): Promise<string[]> {
  if (!staged.length) return [];
  await ensureManagedDirectory(join(root, "assets"));
  const promoted: string[] = [];
  try {
    for (const pair of staged) {
      const from = join(root, ...pair.staging.split("/"));
      const to = join(root, ...pair.final.split("/"));
      await ensureManagedDirectory(dirname(to));
      const bytes = await Deno.readFile(from);
      const output = await Deno.open(to, { write: true, createNew: true });
      promoted.push(pair.final);
      try {
        let offset = 0;
        while (offset < bytes.length) offset += await output.write(bytes.subarray(offset));
      } finally {
        output.close();
      }
      await Deno.remove(from);
    }
    return promoted;
  } catch (caught) {
    await removePromoted(root, promoted);
    throw caught;
  }
}

async function removePromoted(root: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      await Deno.remove(join(root, ...path.split("/")));
    } catch {
      // Best effort: only remove this transaction's UUID-owned files.
    }
  }
}

function createLesson(
  data: ProjectData,
  input: {
    title: string;
    stage_id: string | null;
    text: string;
    format: "markdown" | "text";
    blocks?: Array<{ type: BlockType; content: string; settings?: JsonObject }>;
  },
): ContentItem {
  const contentId = id();
  const document = createDocument(data, contentId);
  const stage = input.stage_id
    ? data.stages.find((candidate) => candidate.id === input.stage_id)
    : null;
  const siblings = data.content_items.filter((item) =>
    !item.archived && item.stage_id === input.stage_id
  );
  const order = siblings.length;
  const content: ContentItem = {
    id: contentId,
    project_id: data.project.id,
    stage_id: input.stage_id,
    code: stage
      ? `${stage.code}-${String(order + 1).padStart(2, "0")}`
      : `C${String(order + 1).padStart(2, "0")}`,
    title: input.title,
    type: "lesson",
    description: "",
    order_index: order,
    document_id: document.id,
    archived: false,
    created_at: now(),
    updated_at: now(),
  };
  data.content_items.push(content);
  initializeContentStatuses(data, content.id);
  for (const block of input.blocks ?? parseBlocks(input.text, input.format)) {
    appendBlock(
      data,
      content.id,
      block.type,
      block.content,
      block.settings ?? {},
    );
  }
  return content;
}

function markdownSourceMatch(
  data: ProjectData,
  sourceRoot: string,
  relativePath: string,
  checksum: string,
): {
  state: "same_content" | "changed_source";
  item: ContentItem | null;
  title: string;
  sourcePath: string;
  previousHash: string;
} | null {
  const ledger = data.project.settings?.markdown_import_sources;
  if (Array.isArray(ledger)) {
    let changedLedgerEntry: ReturnType<typeof markdownSourceMatch> = null;
    let changedLedgerImportedAt = "";
    for (const candidate of ledger) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const source = candidate as JsonObject;
      const importedRoot = typeof source.source_root === "string" ? source.source_root : "";
      const importedPath = typeof source.relative_path === "string" ? source.relative_path : "";
      const importedHash = typeof source.source_hash === "string" ? source.source_hash : "";
      const itemId = typeof source.content_item_id === "string" ? source.content_item_id : "";
      if (!itemId || !importedRoot || !importedPath || !/^[a-f0-9]{64}$/i.test(importedHash)) continue;
      const item = data.content_items.find((entry) => entry.id === itemId) ?? null;
      if (item && (item.project_id !== data.project.id || item.type !== "lesson")) continue;
      const match = {
        state: "changed_source" as const,
        item,
        title: item?.title || (typeof source.title === "string" ? source.title : "已删除的课时"),
        sourcePath: `${importedRoot}/${importedPath}`,
        previousHash: importedHash,
      };
      if (importedHash === checksum) {
        return { ...match, state: "same_content" };
      }
      if (importedRoot === sourceRoot && importedPath === relativePath) {
        const importedAt = typeof source.imported_at === "string" ? source.imported_at : "";
        if (!changedLedgerEntry || importedAt >= changedLedgerImportedAt) {
          changedLedgerEntry = match;
          changedLedgerImportedAt = importedAt;
        }
      }
    }
    if (changedLedgerEntry) return changedLedgerEntry;
  }
  const contentByDocument = new Map(
    data.documents.map((document) => [document.id, document.content_item_id]),
  );
  let changedSource: ReturnType<typeof markdownSourceMatch> = null;
  for (const block of data.blocks) {
    const value = block.settings?.markdown_import;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const source = value as JsonObject;
    const importedRoot = typeof source.source_root === "string" ? source.source_root : "";
    const importedPath = typeof source.relative_path === "string" ? source.relative_path : "";
    const importedHash = typeof source.source_hash === "string" ? source.source_hash : "";
    const itemId = contentByDocument.get(block.document_id);
    const item = data.content_items.find((candidate) => candidate.id === itemId);
    if (!item || item.project_id !== data.project.id || item.type !== "lesson") continue;
    const sourcePath = `${importedRoot}/${importedPath}`;
    if (importedHash === checksum) {
      return { state: "same_content", item, title: item.title, sourcePath, previousHash: importedHash };
    }
    if (importedRoot === sourceRoot && importedPath === relativePath) {
      changedSource ??= { state: "changed_source", item, title: item.title, sourcePath, previousHash: importedHash };
    }
  }
  return changedSource;
}

function lessonDestination(
  data: ProjectData,
  destination: ImportMappingDestination | null | undefined,
  folderStageId: string | null,
): { item: ContentItem | null; stageId: string | null } {
  if (!destination) return { item: null, stageId: folderStageId };
  if (destination.kind === "unassigned_lesson") return { item: null, stageId: null };
  if (destination.kind === "existing_stage") {
    const stage = data.stages.find((candidate) =>
      candidate.id === destination.stage_id && candidate.project_id === data.project.id && !candidate.archived
    );
    if (!stage) throw new Error("导入目标阶段不属于当前课程或已不可用；请刷新目标列表后重试。");
    return { item: null, stageId: stage.id };
  }
  const item = data.content_items.find((candidate) =>
    candidate.id === destination.content_item_id && candidate.project_id === data.project.id &&
    candidate.type === "lesson" && !candidate.archived
  );
  if (!item) throw new Error("导入目标课时不属于当前课程或已不可用；请刷新目标列表后重试。");
  if (!data.documents.some((document) => document.id === item.document_id && document.content_item_id === item.id)) {
    throw new Error("目标课时正文文档无效，无法安全追加。");
  }
  return { item, stageId: item.stage_id };
}

function recordSource(
  data: ProjectData,
  kind: SourceMaterialKind,
  title: string,
  body: string,
  assetId: string | null = null,
): string {
  const inbox = createInboxItem(data, {
    title,
    body,
    source_type: kind,
    asset_id: assetId,
  });
  return inbox.id;
}

/**
 * §4.2/§4.3: a directory row the user selected contributes the visual media found
 * anywhere beneath it, as asset candidates. The Mapping Preview listing stays flat
 * (§4.1), so the sweep runs here, when the confirmed plan is applied. Descendants
 * become Assets only — never Lesson content, and never an `AssetUsage` created
 * merely because the folder was selected. Any path the preview already lists keeps
 * the user's own mapping instead of a synthesized row.
 */
async function expandSelectedDirectoryMedia(
  sourceRoot: string,
  items: ImportMappingItem[],
  warnings: string[],
): Promise<ImportMappingItem[]> {
  const claimed = new Set(
    items.map((item) => item.relative_path.replaceAll("\\", "/")),
  );
  const selectedDirs = items
    .filter(isIncluded)
    .filter((item) => item.kind === "directory")
    .map((item) =>
      item.relative_path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
    )
    .filter((rel) => rel.length > 0);

  const synthesized: ImportMappingItem[] = [];
  for (const rel of selectedDirs) {
    if (
      rel.includes("\0") || isAbsolute(rel) ||
      rel.split("/").some((part) => part === ".." || part === ".")
    ) {
      warnings.push(`${rel}: 非法路径已跳过`);
      continue;
    }
    let scan: MediaDescendantScan;
    try {
      scan = await scanMediaDescendants(sourceRoot, rel);
    } catch (caught) {
      // A directory that cannot be swept degrades to a warning: the rest of the
      // confirmed plan still applies.
      warnings.push(
        `${rel}: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
      continue;
    }
    warnings.push(...scan.warnings, ...scan.errors);
    for (const entry of scan.entries) {
      const candidate = entry.relative_path.replaceAll("\\", "/");
      if (!candidate || claimed.has(candidate)) continue;
      claimed.add(candidate);
      synthesized.push({
        relative_path: candidate,
        kind: entry.kind,
        mime: entry.mime,
        size: entry.size,
        suggested: "asset",
        mapping: "asset",
        selected: true,
        is_suggestion: true,
      });
    }
  }
  if (!synthesized.length) return items;
  warnings.push(
    `已从所选文件夹递归收录 ${synthesized.length} 个图片/视频素材，仅作为素材入库，没有写入课时正文。`,
  );
  return [...items, ...synthesized];
}

/**
 * Apply a user-confirmed mapping plan as Strategy A in-place adoption.
 * Throws if the plan is not confirmed.
 */
export async function confirmFolderAdoption(
  plan: ImportMappingPlan,
  options: FolderAdoptionOptions = {},
): Promise<FolderAdoptionResult> {
  if (!plan || plan.confirmed !== true) {
    throw new Error("只能对已确认的导入计划执行文件夹接管");
  }
  const selectedSourceRoot = normalize(String(plan.root || "").trim());
  const root = normalize(String(options.project_root || selectedSourceRoot || "").trim());
  if (!selectedSourceRoot || !root) throw new Error("导入需要有效的源文件夹和课程项目路径");
  const sourceRoot = await Deno.realPath(selectedSourceRoot);
  await Deno.stat(sourceRoot).then((stat) => {
    if (!stat.isDirectory) throw new Error("导入源必须是文件夹");
  });

  // Match native: never silently overwrite an existing Canonical project.
  let quarantineManifest = false;
  const freshAdoption = !options.data && !options.persist_project && !options.skip_project_write;
  if (freshAdoption && await projectJsonExists(root)) {
    if (!options.replace_invalid_project) {
      throw new Error(
        "该文件夹已有 project.json，不能重复原地接管。请先打开现有项目。",
      );
    }
    // The confirmation says "the file here is broken", not "overwrite whatever is
    // here": a readable or migratable project must still be opened, and a file we
    // cannot even read is never ours to move.
    const diagnosis = await inspectProjectDirectory(root);
    if (diagnosis.status === "valid" || diagnosis.status === "migratable") {
      throw new Error(
        "这个文件夹里的 project.json 是一个可用的课程项目。请直接「打开现有项目」，不要重新导入。",
      );
    }
    // A newer project is not a broken one: the fix is to upgrade, not to let an
    // older build rearrange someone's course.
    if (diagnosis.problem?.code === "unsupported_schema") {
      throw new Error(
        "这个项目由更高版本的 Workbench 创建，当前版本不会改写它。请升级后再打开；若确实要把它当作资料文件夹导入，请先自行改名或移除其中的 project.json。",
      );
    }
    if (diagnosis.status === "unreadable" ||
      (diagnosis.status !== "invalid" && diagnosis.status !== "malformed_json")) {
      throw new Error(
        `无法确认这个文件夹里的 project.json：${diagnosis.problem?.message || "文件不可读"}`,
      );
    }
    quarantineManifest = true;
  }

  const title = options.project_title ||
    cleanName(basename(root), "未命名课程");
  const data = options.data
    ? options.data
    : createEmptyProjectData(title);
  if (!options.data) {
    data.project.title = title;
  }

  const result: FolderAdoptionResult = {
    data,
    root,
    stage_ids: [],
    content_item_ids: [],
    asset_ids: [],
    source_ids: [],
    reused_asset_ids: [],
    warnings: [],
    copied_files: [],
    copied_original_paths: [],
  };
  const staged: Array<{ staging: string; final: string }> = [];
  const stagingRoot = `.workspace/adopt-staging/${crypto.randomUUID()}`;

  /**
   * §28 — one row per document the body dialog sent. Written only for rows that
   * were candidates, and one unreadable or unsupported file never aborts the
   * batch: it records its own outcome and the loop carries on.
   */
  const documentFiles: DocumentImportFile[] = [];
  const documentSeen = new Set<string>();
  const recordDocument = (
    item: ImportMappingItem,
    outcome: DocumentImportOutcome,
    reason = "",
  ): void => {
    if (!isDocumentImportCandidate(item)) return;
    const rel = item.relative_path.replaceAll("\\", "/");
    if (documentSeen.has(rel)) return;
    documentSeen.add(rel);
    documentFiles.push({ relative_path: rel, outcome, reason });
  };

  try {
  const items = await expandSelectedDirectoryMedia(
    sourceRoot,
    plan.items,
    result.warnings,
  );
  const included = items.filter(isIncluded);
  const stageByRel = new Map<string, string>();

  // Pass 1: stages (directories)
  for (const item of included) {
    if (item.mapping !== "stage" || item.kind !== "directory") continue;
    const stage = addStage(data, { title: entryTitle(item.relative_path) });
    // Prefer readable titles from folder names like 01-基础
    stage.title = entryTitle(item.relative_path) || stage.title;
    stageByRel.set(item.relative_path.replaceAll("\\", "/"), stage.id);
    result.stage_ids.push(stage.id);
  }

  const duplicateChoice = options.duplicate_choice ?? "existing";
  await ensureWorkspace(root);

  // Pass 2: files, including the image/video rows expandSelectedDirectoryMedia
  // appended for directories the user selected. Directories stay in pass 1 as
  // stages and are never swept in as documents here.
  for (const item of included) {
    if (!ADOPTABLE_FILE_KINDS.includes(item.kind)) continue;
    const role: MappingRole = item.mapping;
    const rel = item.relative_path.replaceAll("\\", "/");
    const sourceAbs = await sourceFilePath(sourceRoot, rel);
    const filename = cleanName(basename(rel));
    const fileTitle = entryTitle(rel);

    let bytes: Uint8Array;
    try {
      const stat = await Deno.lstat(sourceAbs);
      if (stat.isSymlink) {
        result.warnings.push(`${rel}: 已跳过符号链接`);
        recordDocument(item, "skipped", "符号链接已跳过，正文未写入；原文件保持原地。");
        continue;
      }
      bytes = await Deno.readFile(sourceAbs);
    } catch (caught) {
      result.warnings.push(
        `${rel}: 无法读取（${
          caught instanceof Error ? caught.message : String(caught)
        }）`,
      );
      recordDocument(
        item,
        "failed",
        `无法读取源文件（${caught instanceof Error ? caught.message : String(caught)}）；原文件保持原地。`,
      );
      continue;
    }
    const checksum = await sha256Bytes(bytes);
    const stageId = parentStageId(rel, stageByRel);

    if (role === "lesson") {
      const ext = extension(filename);
      // §18 / §28 honesty: this shell has no parser for the container formats in
      // the §18 list, and decoding their bytes into a paragraph would be a false
      // success. Record the one file as failed and keep going with the batch.
      if (
        !BROWSER_BODY_EXTENSIONS.has(ext) &&
        (DOCUMENT_IMPORT_EXTENSIONS as readonly string[]).includes(ext)
      ) {
        recordDocument(
          item,
          "failed",
          "浏览器版不解析这种文档格式，需要用桌面应用导入正文；这个文件没有写入，源文件保持原地。",
        );
        continue;
      }
      const format: "markdown" | "text" = TEXT_EXT.has(ext) &&
          ext !== ".txt"
        ? "markdown"
        : "text";
      // TXT is more conservative: still lesson body when user mapped lesson,
      // but parsed as plain text paragraphs.
      const text = new TextDecoder().decode(bytes);
      const parsed = format === "markdown" ? parseMarkdown(text) : null;
      const expectedHash = item.markdown_dependency_preview?.source_hash;
      if (parsed && expectedHash && expectedHash !== checksum) {
        throw new Error(`${rel}: Markdown源文件在确认后发生变化，请重新预览并确认。`);
      }
      if (parsed?.warnings.length) result.warnings.push(...parsed.warnings.map((warning) => `${rel}: ${warning}`));
      const sourceMatch = parsed
        ? markdownSourceMatch(data, sourceRoot, rel, checksum)
        : null;
      if (sourceMatch && !item.allow_duplicate) {
        result.warnings.push(sourceMatch.state === "same_content"
          ? `${rel}: SHA-256与${sourceMatch.item ? `已导入课时「${sourceMatch.title}」` : `曾导入来源「${sourceMatch.title}」（目标课时已删除）`}一致；默认跳过，已有编辑内容保持不变。`
          : `${rel}: 来源路径已有较旧导入「${sourceMatch.title}」${sourceMatch.item ? "" : "（目标课时已删除）"}（SHA-256 ${sourceMatch.previousHash.slice(0, 12)}）；默认跳过以避免静默替换，请明确选择“作为新版本导入”。`);
        recordDocument(
          item,
          "skipped",
          sourceMatch.state === "same_content"
            ? `内容与已导入来源「${sourceMatch.title}」相同（SHA-256 一致），默认跳过；已有正文没有被改写。`
            : `来源路径已有旧版导入「${sourceMatch.title}」，默认跳过以避免静默替换；可在映射预览里明确选择导入新版本。`,
        );
        continue;
      }
      if (sourceMatch) {
        result.warnings.push(sourceMatch.state === "same_content"
          ? sourceMatch.item
            ? `${rel}: 用户已明确选择再次导入与「${sourceMatch.title}」内容相同的Markdown；原课时正文不会被覆盖。`
            : `${rel}: 用户已明确重新导入曾删除课时「${sourceMatch.title}」的相同Markdown；按当前目标新建或追加。`
          : sourceMatch.item
          ? `${rel}: 用户已明确选择导入来源的新版本；「${sourceMatch.title}」及其编辑内容保持不变。`
          : `${rel}: 用户已明确导入曾删除课时「${sourceMatch.title}」的来源新版本；按当前目标新建或追加。`);
      }
      const refsByBlock = new Map<number, Array<{ href: string; asset_id: string }>>();
      for (const ref of parsed?.explicitLocalImageRefs ?? []) {
        let dependencyPath: string;
        try {
          dependencyPath = await markdownImagePath(sourceRoot, rel, ref.href);
        } catch (caught) {
          if (caught instanceof Deno.errors.NotFound) {
            result.warnings.push(
              `${rel}: 图片依赖「${ref.href}」不存在；已保留正文原文，未创建素材。`,
            );
            continue;
          }
          throw caught;
        }
        let dependencyBytes: Uint8Array;
        try {
          dependencyBytes = await Deno.readFile(dependencyPath);
        } catch (caught) {
          if (caught instanceof Deno.errors.NotFound) {
            result.warnings.push(
              `${rel}: 图片依赖「${ref.href}」不存在；已保留正文原文，未创建素材。`,
            );
            continue;
          }
          throw caught;
        }
        const dependencyName = cleanName(basename(dependencyPath));
        const dependencyId = await importBytesAsAsset(data, root, {
          filename: dependencyName,
          bytes: dependencyBytes,
          checksum: await sha256Bytes(dependencyBytes),
          mime: mimeFor(dependencyName),
          sourceAbs: dependencyPath,
          duplicateChoice,
          result,
          staged,
          stagingRoot,
        });
        if (!dependencyId) continue;
        const list = refsByBlock.get(ref.blockIndex) ?? [];
        if (!list.some((entry) => entry.href === ref.href)) {
          list.push({ href: ref.href, asset_id: dependencyId });
          refsByBlock.set(ref.blockIndex, list);
        }
      }
      const blocks = parsed?.blocks.map((block, index) => {
        const type: BlockType = block.type === "heading" || block.type === "quote" || block.type === "code" || block.type === "divider"
          ? block.type
          : "paragraph";
        const content = block.type === "heading" || block.type === "quote" || block.type === "code"
          ? block.text
          : block.type === "divider" ? "" : block.raw;
        const settings: JsonObject = {};
        if (block.type === "heading") settings.level = block.level ?? 2;
        if (block.type === "code" && block.language) settings.language = block.language;
        const markdownAssets = refsByBlock.get(index);
        if (markdownAssets?.length) settings.markdown_assets = markdownAssets;
        return { type, content, settings };
      });
      let lesson: ContentItem;
      let importedBlocks = [] as ProjectData["blocks"];
      if (parsed) {
        const provenance: JsonObject = {
          source_root: sourceRoot,
          relative_path: rel,
          source_hash: checksum,
        };
        const markdownBlocks = blocks ?? [];
        if (markdownBlocks.length === 0) {
          markdownBlocks.push({ type: "paragraph", content: "", settings: {} });
        }
        const firstMarkdownBlock = markdownBlocks[0];
        if (!firstMarkdownBlock) throw new Error("Markdown没有可写入的正文区块");
        firstMarkdownBlock.settings = {
          ...firstMarkdownBlock.settings,
          markdown_import: provenance,
        };
        const destination = lessonDestination(data, item.destination, stageId);
        if (destination.item) {
          lesson = destination.item;
          const document = data.documents.find((candidate) =>
            candidate.content_item_id === lesson.id && candidate.id === lesson.document_id
          );
          if (!document) throw new Error("目标课时正文文档无效，无法安全追加。");
          importedBlocks = markdownBlocks.map((block) =>
            appendBlock(data, lesson.id, block.type, block.content, block.settings)
          );
        } else {
          lesson = createLesson(data, {
            title: fileTitle,
            stage_id: destination.stageId,
            text,
            format,
            blocks: markdownBlocks,
          });
          importedBlocks = data.blocks.filter((block) => block.document_id === lesson.document_id);
        }
        for (const [blockIndex, refs] of refsByBlock) {
          const block = importedBlocks[blockIndex];
          if (!block) continue;
          for (const ref of refs) addAssetUsage(data, ref.asset_id, lesson.id, { block_id: block.id });
        }
        const provenanceRows = Array.isArray(data.project.settings.markdown_import_sources)
          ? data.project.settings.markdown_import_sources as JsonValue[]
          : [];
        const alreadyRecorded = provenanceRows.some((entry) =>
          Boolean(entry && typeof entry === "object" && !Array.isArray(entry) &&
            entry.source_root === sourceRoot && entry.relative_path === rel &&
            entry.source_hash === checksum && entry.content_item_id === lesson.id)
        );
        if (!alreadyRecorded) {
          provenanceRows.push({
            ...provenance,
            content_item_id: lesson.id,
            title: lesson.title,
            imported_at: now(),
          });
          data.project.settings.markdown_import_sources = provenanceRows;
        }
      } else {
        const destination = lessonDestination(data, item.destination, stageId);
        if (destination.item) {
          lesson = destination.item;
          appendBlock(data, lesson.id, "paragraph", text);
        } else {
          lesson = createLesson(data, {
            title: fileTitle,
            stage_id: destination.stageId,
            text,
            format: "text",
          });
        }
      }
      if (!result.content_item_ids.includes(lesson.id)) result.content_item_ids.push(lesson.id);
      recordDocument(
        item,
        parsed?.warnings.length ? "degraded" : "succeeded",
        parsed?.warnings.length
          ? `正文已导入，但有 ${parsed.warnings.length} 项格式未能原样保留：${parsed.warnings[0] ?? ""}`
          : "",
      );
      continue;
    }

    if (role === "source") {
      const ext = extension(filename);
      if (TEXT_EXT.has(ext)) {
        const text = new TextDecoder().decode(bytes);
        const sourceId = recordSource(
          data,
          "source",
          fileTitle,
          `源资料：${rel}\n\n${text}`,
        );
        result.source_ids.push(sourceId);
      } else {
        const assetId = await importBytesAsAsset(data, root, {
          filename,
          bytes,
          checksum,
          mime: item.mime || mimeFor(filename),
          sourceAbs,
          duplicateChoice,
          result,
          staged,
          stagingRoot,
        });
        if (assetId) {
          const sourceId = recordSource(
            data,
            "source",
            fileTitle,
            `源资料：${rel}`,
            assetId,
          );
          result.source_ids.push(sourceId);
        }
      }
      continue;
    }

    if (role === "reference") {
      const assetId = await importBytesAsAsset(data, root, {
        filename,
        bytes,
        checksum,
        mime: item.mime || mimeFor(filename),
        sourceAbs,
        duplicateChoice,
        result,
        forceType: "document",
        staged,
        stagingRoot,
      });
      if (assetId) {
        const sourceId = recordSource(
          data,
          "reference",
          fileTitle,
          `参考资料：${rel}`,
          assetId,
        );
        result.source_ids.push(sourceId);
      }
      continue;
    }

    if (role === "asset") {
      await importBytesAsAsset(data, root, {
        filename,
        bytes,
        checksum,
        mime: item.mime || mimeFor(filename),
        sourceAbs,
        duplicateChoice,
        result,
        staged,
        stagingRoot,
      });
      continue;
    }

    // stage-as-file or unknown → skip with warning
    result.warnings.push(`${rel}: 映射「${role}」在文件上已跳过`);
  }

  if (options.persist_project) {
    try {
      const promoted = await promoteStaging(root, staged);
      try {
      await options.persist_project(data);
      } catch (persistError) {
        await removePromoted(root, promoted);
        throw persistError;
      }
    } catch (caught) {
      await cleanupStaging(root, staged, stagingRoot);
      throw caught;
    }
    await cleanupStaging(root, staged, stagingRoot);
  } else if (!options.skip_project_write) {
    // §3.2 Case C: a corrupted manifest would fail the store's own read, so the
    // file moves aside before anything opens the folder — and every later failure
    // puts the name back, so an aborted import still changes nothing.
    let quarantined: string | null = null;
    if (quarantineManifest) quarantined = await quarantineInvalidManifest(root);
    const store = new ProjectDirectoryStore(root);
    try {
      await store.open();
      const promoted = await promoteStaging(root, staged);
      try {
        await store.writeProject(data);
      } catch (persistError) {
        await removePromoted(root, promoted);
        throw persistError;
      }
    } catch (caught) {
      await cleanupStaging(root, staged, stagingRoot);
      if (quarantined) await restoreQuarantinedManifest(root, quarantined);
      throw caught;
    } finally {
      await store.close().catch(() => {});
    }
    if (quarantined) {
      result.warnings.push(
        `原有的 project.json 已完整保留为「${basename(quarantined)}」，没有删除任何文件。`,
      );
    }
    await cleanupStaging(root, staged, stagingRoot);
  } else if (staged.length) {
    try {
      await promoteStaging(root, staged);
    } catch (caught) {
      await cleanupStaging(root, staged, stagingRoot);
      throw caught;
    }
    await cleanupStaging(root, staged, stagingRoot);
  } else {
    await cleanupStaging(root, staged, stagingRoot);
  }

  // §28 — the tally rides along with the import result under the same key the
  // native shell uses, so the dialog reads one shape from both. No document
  // candidates, no key: the caller keeps showing the ordinary warning list.
  if (documentFiles.length) {
    result.document_import = documentImportReportFromFiles(documentFiles);
  }

  return result;
  } finally {
    await cleanupStaging(root, staged, stagingRoot);
  }
}

async function importBytesAsAsset(
  data: ProjectData,
  root: string,
  input: {
    filename: string;
    bytes: Uint8Array;
    checksum: string;
    mime: string;
    sourceAbs: string;
    duplicateChoice: "existing" | "copy" | "cancel";
    result: FolderAdoptionResult;
    forceType?: AssetType;
    staged: Array<{ staging: string; final: string }>;
    stagingRoot: string;
  },
): Promise<string | null> {
  const existing = data.assets.find((asset) =>
    asset.project_id === data.project.id &&
    asset.checksum === input.checksum &&
    !asset.archived
  );
  if (existing) {
    if (input.duplicateChoice === "cancel") {
      throw new Error("已取消重复素材导入");
    }
    if (input.duplicateChoice === "existing") {
      input.result.reused_asset_ids.push(existing.id);
      input.result.asset_ids.push(existing.id);
      input.result.warnings.push(
        `素材「${input.filename}」checksum 已存在，已复用现有素材`,
      );
      return existing.id;
    }
    // "copy" → keep duplicate record below
  }

  const assetId = id();
  const storagePath = `assets/${assetId}-${input.filename}`;
  const stagingPath = `${input.stagingRoot}/${assetId}-${input.filename}`;
  await copyManagedAsset(root, input.sourceAbs, stagingPath, input.bytes);
  input.staged.push({ staging: stagingPath, final: storagePath });
  input.result.copied_files.push(storagePath);

  const added = addAsset(data, data.project.id, {
    type: input.forceType ?? assetTypeFor(input.filename),
    filename: input.filename,
    storage_path: storagePath,
    mime_type: input.mime,
    checksum: input.checksum,
    file_size: input.bytes.byteLength,
    source_type: "imported",
    title: input.filename,
  }, Boolean(existing && input.duplicateChoice === "copy"));
  input.result.asset_ids.push(added.asset.id);
  if (added.duplicate) {
    input.result.reused_asset_ids.push(added.asset.id);
  }
  return added.asset.id;
}
