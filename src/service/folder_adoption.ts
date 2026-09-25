/**
 * V1-T04 Task 12 — Strategy A in-place folder adoption after confirm.
 *
 * Spec §§32–35, 25. Writes project.json + .workspace into the chosen folder.
 * Copies confirmed media into assets/. Never moves/renames/deletes originals.
 * Requires ImportMappingPlan.confirmed === true.
 */
import { basename, dirname, extname, join, normalize } from "node:path";
import { addAsset } from "../domain/assets.ts";
import { addStage } from "../domain/course.ts";
import { appendBlock, createDocument } from "../domain/document.ts";
import { createEmptyProjectData } from "../domain/store.ts";
import { initializeContentStatuses } from "../domain/status.ts";
import type {
  AssetType,
  BlockType,
  ContentItem,
  JsonObject,
  ProjectData,
  SourceMaterialKind,
} from "../domain/types.ts";
import { id, now, sha256Bytes } from "../domain/util.ts";
import { createInboxItem } from "../domain/workflow.ts";
import type {
  ImportMappingItem,
  ImportMappingPlan,
  MappingRole,
} from "./folder_mapping.ts";
import { ProjectDirectoryStore } from "./storage.ts";

export interface FolderAdoptionOptions {
  /** Existing project to extend; default creates empty project in plan.root. */
  data?: ProjectData;
  /** Override write root (defaults to plan.root). */
  project_root?: string;
  project_title?: string;
  duplicate_choice?: "existing" | "copy" | "cancel";
  /** When true, mutate data + copy assets but skip project.json write. */
  skip_project_write?: boolean;
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
}

const TEXT_EXT = new Set([".md", ".markdown", ".txt"]);
const ASSET_EXT: Record<string, AssetType> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "gif",
  ".webp": "image",
  ".svg": "image",
  ".mp4": "video",
  ".webm": "video",
  ".mov": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".m4a": "audio",
  ".aac": "audio",
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
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
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
  if (rel.includes("..")) throw new Error("导入路径不能包含 ..");
  return join(normalize(root), ...rel.split("/").filter(Boolean));
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

async function ensureWorkspace(root: string): Promise<void> {
  await Deno.mkdir(join(root, ".workspace"), { recursive: true });
  await Deno.mkdir(join(root, ".workspace", "adopt-staging"), {
    recursive: true,
  });
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
): Promise<void> {
  for (const pair of staged) {
    try {
      await Deno.remove(join(root, ...pair.staging.split("/")));
    } catch {
      // best-effort; never touch user originals
    }
  }
  try {
    await Deno.remove(join(root, ".workspace", "adopt-staging"), {
      recursive: true,
    });
  } catch {
    // ignore
  }
}

async function promoteStaging(
  root: string,
  staged: Array<{ staging: string; final: string }>,
): Promise<void> {
  await Deno.mkdir(join(root, "assets"), { recursive: true });
  for (const pair of staged) {
    const from = join(root, ...pair.staging.split("/"));
    const to = join(root, ...pair.final.split("/"));
    await Deno.mkdir(dirname(to), { recursive: true });
    try {
      await Deno.rename(from, to);
    } catch {
      await Deno.copyFile(from, to);
      try {
        await Deno.remove(from);
      } catch {
        // ignore
      }
    }
  }
  try {
    await Deno.remove(join(root, ".workspace", "adopt-staging"), {
      recursive: true,
    });
  } catch {
    // ignore
  }
}

function createLesson(
  data: ProjectData,
  input: {
    title: string;
    stage_id: string | null;
    text: string;
    format: "markdown" | "text";
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
  for (const block of parseBlocks(input.text, input.format)) {
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
  const root = normalize(String(options.project_root || plan.root || "").trim());
  if (!root) throw new Error("接管需要有效的文件夹路径");

  // Match native: never silently overwrite an existing Canonical project.
  if (!options.skip_project_write && await projectJsonExists(root)) {
    throw new Error(
      "该文件夹已有 project.json，不能重复原地接管。请先打开现有项目。",
    );
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

  const included = plan.items.filter(isIncluded);
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

  // Pass 2: files
  for (const item of included) {
    if (item.kind !== "file") continue;
    const role: MappingRole = item.mapping;
    const rel = item.relative_path.replaceAll("\\", "/");
    const sourceAbs = absPath(root, rel);
    const filename = cleanName(basename(rel));
    const fileTitle = entryTitle(rel);

    let bytes: Uint8Array;
    try {
      const stat = await Deno.lstat(sourceAbs);
      if (stat.isSymlink) {
        result.warnings.push(`${rel}: 已跳过符号链接`);
        continue;
      }
      bytes = await Deno.readFile(sourceAbs);
    } catch (caught) {
      result.warnings.push(
        `${rel}: 无法读取（${
          caught instanceof Error ? caught.message : String(caught)
        }）`,
      );
      continue;
    }
    const checksum = await sha256Bytes(bytes);
    const stageId = parentStageId(rel, stageByRel);

    if (role === "lesson") {
      const ext = extension(filename);
      const format: "markdown" | "text" = TEXT_EXT.has(ext) &&
          ext !== ".txt"
        ? "markdown"
        : "text";
      // TXT is more conservative: still lesson body when user mapped lesson,
      // but parsed as plain text paragraphs.
      const text = new TextDecoder().decode(bytes);
      const lesson = createLesson(data, {
        title: fileTitle,
        stage_id: stageId,
        text,
        format: ext === ".txt" ? "text" : format,
      });
      result.content_item_ids.push(lesson.id);
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
      });
      continue;
    }

    // stage-as-file or unknown → skip with warning
    result.warnings.push(`${rel}: 映射「${role}」在文件上已跳过`);
  }

  if (!options.skip_project_write) {
    await ensureWorkspace(root);
    const store = new ProjectDirectoryStore(root);
    await store.open();
    try {
      await store.writeProject(data);
      await promoteStaging(root, staged);
    } catch (caught) {
      await cleanupStaging(root, staged);
      throw caught;
    } finally {
      await store.close().catch(() => {});
    }
  } else if (staged.length) {
    try {
      await promoteStaging(root, staged);
    } catch (caught) {
      await cleanupStaging(root, staged);
      throw caught;
    }
  }

  return result;
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
  const stagingPath = `.workspace/adopt-staging/${assetId}-${input.filename}`;
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
