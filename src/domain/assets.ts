import {
  type Asset,
  type AssetSourceType,
  type AssetType,
  type AssetUsage,
  type ProjectData,
} from "./types.ts";
import { assert, id, now } from "./util.ts";
import { touchProject } from "./store.ts";

export interface AssetInput {
  type: AssetType;
  filename: string;
  storage_path: string;
  mime_type: string;
  checksum: string;
  file_size?: number;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  title?: string;
  description?: string;
  source_type?: AssetSourceType;
  source_url?: string | null;
  copyright_note?: string | null;
}

export interface AddAssetResult {
  asset: Asset;
  duplicate: boolean;
}

export function addAsset(
  data: ProjectData,
  projectId: string,
  input: AssetInput,
  keepDuplicate = false,
): AddAssetResult {
  assert(data.project.id === projectId, "素材只能加入所属项目");
  assert(input.checksum.length > 0, "素材必须提供 checksum 才能去重");
  assert(
    Number.isFinite(input.file_size ?? 0) && (input.file_size ?? 0) >= 0,
    "素材大小不能为负数",
  );
  const existing = data.assets.find((asset) =>
    asset.project_id === projectId && asset.checksum === input.checksum &&
    !asset.archived
  );
  if (existing && !keepDuplicate) return { asset: existing, duplicate: true };
  const asset: Asset = {
    id: id(),
    project_id: projectId,
    type: input.type,
    filename: input.filename,
    storage_path: input.storage_path,
    mime_type: input.mime_type,
    width: input.width ?? null,
    height: input.height ?? null,
    duration_ms: input.duration_ms ?? null,
    file_size: input.file_size ?? 0,
    checksum: input.checksum,
    title: input.title ?? input.filename,
    description: input.description ?? "",
    source_type: input.source_type ?? "imported",
    source_url: input.source_url ?? null,
    copyright_note: input.copyright_note ?? null,
    created_at: now(),
    archived: false,
  };
  data.assets.push(asset);
  touchProject(data);
  return { asset, duplicate: false };
}

export function addAssetUsage(
  data: ProjectData,
  assetId: string,
  contentItemId: string,
  options: {
    block_id?: string | null;
    layout_instance_id?: string | null;
    role?: string;
  } = {},
): AssetUsage {
  const asset = data.assets.find((candidate) => candidate.id === assetId);
  const item = data.content_items.find((candidate) =>
    candidate.id === contentItemId
  );
  assert(asset, `找不到素材: ${assetId}`);
  assert(item, `找不到内容: ${contentItemId}`);
  assert(item.project_id === data.project.id, "内容不属于当前项目");
  assert(!asset.archived, "已归档素材不能建立新引用");
  assert(asset.project_id === item.project_id, "素材与内容不属于同一项目");
  if (options.block_id) {
    const block = data.blocks.find((candidate) =>
      candidate.id === options.block_id
    );
    assert(block, `找不到正文区块: ${options.block_id}`);
    const document = data.documents.find((candidate) =>
      candidate.id === block.document_id
    );
    assert(
      document?.content_item_id === contentItemId,
      "素材正文引用与内容不匹配",
    );
  }
  if (options.layout_instance_id) {
    const layout = data.layout_instances.find((candidate) =>
      candidate.id === options.layout_instance_id
    );
    assert(layout?.content_item_id === contentItemId, "排版引用与内容不匹配");
  }
  const existing = data.asset_usages.find((candidate) =>
    candidate.asset_id === assetId &&
    candidate.content_item_id === contentItemId &&
    candidate.block_id === (options.block_id ?? null) &&
    candidate.layout_instance_id === (options.layout_instance_id ?? null) &&
    candidate.role === (options.role ?? "content")
  );
  if (existing) return existing;
  const usage: AssetUsage = {
    id: id(),
    asset_id: assetId,
    content_item_id: contentItemId,
    block_id: options.block_id ?? null,
    layout_instance_id: options.layout_instance_id ?? null,
    role: options.role ?? "content",
    created_at: now(),
  };
  data.asset_usages.push(usage);
  touchProject(data);
  return usage;
}

export function removeAssetUsage(data: ProjectData, usageId: string): void {
  const index = data.asset_usages.findIndex((usage) => usage.id === usageId);
  assert(index >= 0, `找不到素材引用: ${usageId}`);
  data.asset_usages.splice(index, 1);
  touchProject(data);
}

/**
 * Detach one asset from one content item, releasing every reference that
 * pointed at it there.  Media slots and grid placements stay in place so the
 * user still sees where the material used to be.
 */
export function detachAssetFromContent(
  data: ProjectData,
  assetId: string,
  contentItemId: string,
): number {
  const before = data.asset_usages.length;
  data.asset_usages = data.asset_usages.filter((usage) =>
    !(usage.asset_id === assetId && usage.content_item_id === contentItemId)
  );
  for (const block of data.blocks) {
    if (block.settings.asset_id !== assetId) continue;
    const document = data.documents.find((candidate) =>
      candidate.id === block.document_id
    );
    if (document?.content_item_id !== contentItemId) continue;
    delete block.settings.asset_id;
    block.content = "";
    block.updated_at = now();
  }
  for (const requirement of data.requirements) {
    if (
      requirement.content_item_id !== contentItemId ||
      requirement.resolved_asset_id !== assetId
    ) continue;
    requirement.resolved_asset_id = null;
    if (requirement.status === "resolved") requirement.status = "open";
  }
  touchProject(data);
  return before - data.asset_usages.length;
}

/**
 * Archive an asset and every reference to it.  Files on disk are never
 * deleted here: the canonical row is archived and the material stays
 * recoverable in the project's asset folder.
 */
export function removeAsset(
  data: ProjectData,
  assetId: string,
): { usages_removed: number } {
  const asset = data.assets.find((candidate) => candidate.id === assetId);
  assert(asset, `找不到素材: ${assetId}`);
  let removed = 0;
  for (
    const contentItemId of new Set(
      data.asset_usages.filter((usage) => usage.asset_id === assetId).map(
        (usage) => usage.content_item_id,
      ),
    )
  ) {
    removed += detachAssetFromContent(data, assetId, contentItemId);
  }
  for (const block of data.blocks) {
    if (block.settings.asset_id === assetId) {
      delete block.settings.asset_id;
      block.updated_at = now();
    }
  }
  for (const requirement of data.requirements) {
    if (requirement.resolved_asset_id === assetId) {
      requirement.resolved_asset_id = null;
      if (requirement.status === "resolved") requirement.status = "open";
    }
  }
  asset.archived = true;
  touchProject(data);
  return { usages_removed: removed };
}

/** Placement rows that point at a block that no longer exists. */

/** Every canonical asset reference must resolve to one project-owned target. */
export function validateAssetUsages(data: ProjectData): string[] {
  const errors: string[] = [];
  for (const usage of data.asset_usages) {
    const asset = data.assets.find((candidate) =>
      candidate.id === usage.asset_id
    );
    const item = data.content_items.find((candidate) =>
      candidate.id === usage.content_item_id
    );
    if (!asset) errors.push(`素材引用 ${usage.id} 指向不存在的素材`);
    if (!item) errors.push(`素材引用 ${usage.id} 指向不存在的内容`);
    if (asset && item && asset.project_id !== item.project_id) {
      errors.push(`素材引用 ${usage.id} 跨项目`);
    }
    if (usage.block_id) {
      const block = data.blocks.find((candidate) =>
        candidate.id === usage.block_id
      );
      const document = block &&
        data.documents.find((candidate) => candidate.id === block.document_id);
      if (!document || document.content_item_id !== usage.content_item_id) {
        errors.push(`素材引用 ${usage.id} 的正文区块不匹配`);
      }
    }
    if (usage.layout_instance_id) {
      const layout = data.layout_instances.find((candidate) =>
        candidate.id === usage.layout_instance_id
      );
      if (!layout || layout.content_item_id !== usage.content_item_id) {
        errors.push(`素材引用 ${usage.id} 的排版版本不匹配`);
      }
    }
  }
  return errors;
}

export function assetUsageCount(data: ProjectData, assetId: string): number {
  return data.asset_usages.filter((usage) => usage.asset_id === assetId).length;
}

/** Archive is intentionally blocked while references exist; callers must inspect usages first. */
export function archiveAsset(data: ProjectData, assetId: string): Asset {
  const asset = data.assets.find((candidate) => candidate.id === assetId);
  assert(asset, `找不到素材: ${assetId}`);
  assert(
    assetUsageCount(data, assetId) === 0,
    "素材仍被引用，不能直接删除或归档",
  );
  asset.archived = true;
  touchProject(data);
  return asset;
}

/**
 * Item 13 — physical rename reference synchronisation.
 *
 * A managed asset is stored at `assets/<asset.id>-<filename>` inside the project
 * directory. Its path is referenced from several places in the canonical object,
 * not only `assets[].storage_path`: media block bodies embed the raw managed path
 * in Markdown image syntax, layout placements copy it, and legacy exports resolve
 * the reference by filename/title text. Renaming the file therefore has to rewrite
 * every reference form in one atomic pass or previews and exports silently break.
 *
 * The helpers below are pure (no filesystem, no throw-on-collision): the storage
 * layer composes them into preflight → fs rename → canonical rewrite → save with
 * rollback, so the risky I/O ordering stays testable in isolation.
 */

/** A rename that cannot be applied because the requested name is not safe. */
export class InvalidAssetNameError extends Error {
  readonly code = "invalid_asset_name";
  readonly path: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = "InvalidAssetNameError";
    this.path = path;
  }
}

export interface AssetRenamePlan {
  asset_id: string;
  requested: string;
  /** Basename without extension as it will be written to disk. */
  new_basename: string;
  /** Lower-cased extension including the leading dot, or "" when none. */
  extension: string;
  /** New basename with the preserved extension. */
  new_filename: string;
  old_storage_path: string;
  new_storage_path: string;
  old_filename: string;
  new_display_title: string;
}

/** Extension (incl. dot) of a managed filename, or "" when the name has none. */
function managedExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return "";
  return filename.slice(dot);
}

/** Strip the leading `assets/` directory and any surrounding slashes. */
function storageDirectory(storagePath: string): string {
  const normalised = storagePath.replaceAll("\\", "/");
  const slash = normalised.lastIndexOf("/");
  return slash < 0 ? "" : normalised.slice(0, slash + 1);
}

/**
 * Validate the requested name and compute the rename plan. Rejects: empty names,
 * path separators (both `/` and `\`), `.`/`..` traversal, NUL bytes and any
 * control character. The file extension is preserved by default — the caller
 * supplies a basename only; if they include the same trailing extension we keep
 * it exactly once rather than duplicating it (`diagram.png` stays `.png`, not
 * `.png.png`).
 */
export function planAssetRename(
  data: ProjectData,
  assetId: string,
  requested: string,
): AssetRenamePlan {
  const asset = data.assets.find((candidate) => candidate.id === assetId);
  assert(asset, `找不到素材: ${assetId}`);
  if (!asset) throw new Error(`找不到素材: ${assetId}`);
  if (asset.archived) {
    throw new InvalidAssetNameError("已归档素材不能重命名。", asset.storage_path);
  }

  const raw = String(requested ?? "");
  if (raw.includes("\0")) {
    throw new InvalidAssetNameError("文件名不能包含空字节。", asset.storage_path);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new InvalidAssetNameError("文件名不能为空。", asset.storage_path);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") ||
      trimmed.includes(":")) {
    throw new InvalidAssetNameError(
      "文件名不能包含路径分隔符。",
      asset.storage_path,
    );
  }
  if (trimmed === "." || trimmed === "..") {
    throw new InvalidAssetNameError(
      "文件名不能是相对路径片段。",
      asset.storage_path,
    );
  }
  // Control characters (C0/C1) and the Unicode line separators are unsafe on the
  // file system and inside Markdown reference text.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(trimmed)) {
    throw new InvalidAssetNameError(
      "文件名不能包含控制字符。",
      asset.storage_path,
    );
  }

  const extension = managedExtension(asset.filename);
  // Preserve the extension by default: a name that already ends in the same
  // extension is used verbatim, otherwise the original extension is re-applied.
  let basename = trimmed;
  if (extension && trimmed.toLowerCase().endsWith(extension.toLowerCase())) {
    basename = trimmed.slice(0, trimmed.length - extension.length).trim();
    if (!basename) basename = trimmed;
  }
  const newFilename = basename + extension;
  const directory = storageDirectory(asset.storage_path);
  const newStoragePath = `${directory}${asset.id}-${newFilename}`;
  const newDisplayTitle = basename || newFilename;

  return {
    asset_id: asset.id,
    requested: trimmed,
    new_basename: basename,
    extension,
    new_filename: newFilename,
    old_storage_path: asset.storage_path,
    new_storage_path: newStoragePath,
    old_filename: asset.filename,
    new_display_title: newDisplayTitle,
  };
}

/** True when the plan is already satisfied (no on-disk work needed). */
export function isAssetRenameNoop(plan: AssetRenamePlan): boolean {
  return plan.old_storage_path === plan.new_storage_path &&
    plan.old_filename === plan.new_filename;
}

/**
 * Rewrite the canonical object for a planned rename. Assumes the physical file
 * move already succeeded (the storage layer enforces that ordering). Updates the
 * asset row plus every reference form:
 *   1. `assets[].storage_path` / `filename` / `title` for the renamed asset.
 *   2. Block bodies: media blocks store the managed path as Markdown image/link
 *      text (`![x](assets/<id>-file.png)`), inline code and plain captions. The
 *      old storage path is a unique, asset-id-bearing string, so it is replaced
 *      everywhere it appears; a bare old filename reference is only rewritten on
 *      a block that already links this asset by `settings.asset_id`.
 *   3. Any other string leaf (layout `settings`, requirement rows, block
 *      `settings`) that carries the managed path.
 * Returns the number of reference strings rewritten (the renamed asset row's own
 * storage_path counts once). Idempotent per leaf, so an old path that is a prefix
 * of the new one cannot cascade.
 */
export function applyAssetRename(
  data: ProjectData,
  plan: AssetRenamePlan,
): number {
  const asset = data.assets.find((candidate) => candidate.id === plan.asset_id);
  if (!asset) return 0;

  const oldPath = plan.old_storage_path;
  const newPath = plan.new_storage_path;
  const oldFilename = plan.old_filename;
  const newFilename = plan.new_filename;
  let rewritten = 0;

  // Pass 1: replace the unique managed path in every string leaf of the tree.
  // Done before touching the asset row so `storage_path` is rewritten by the same
  // walk and we never re-scan an already-new value.
  const replacePaths = (node: unknown): void => {
    if (typeof node === "string") return;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const child = node[index];
        if (typeof child === "string") {
          if (oldPath && child.includes(oldPath)) {
            node[index] = child.split(oldPath).join(newPath);
            rewritten += 1;
          }
        } else if (child && typeof child === "object") {
          replacePaths(child);
        }
      }
      return;
    }
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const child = record[key];
        if (typeof child === "string") {
          if (oldPath && child.includes(oldPath)) {
            record[key] = child.split(oldPath).join(newPath);
            rewritten += 1;
          }
        } else if (child && typeof child === "object") {
          replacePaths(child);
        }
      }
    }
  };
  replacePaths(data);

  // Pass 2: the asset row's non-path identity fields. `id` and `checksum` stay.
  asset.storage_path = newPath;
  asset.filename = newFilename;
  asset.title = plan.new_display_title;

  // Pass 3: bare old-filename text references, scoped to blocks that link THIS
  // asset, so an identical basename on another asset is never rewritten.
  for (const block of data.blocks) {
    if (block.settings?.asset_id !== plan.asset_id) continue;
    const content = block.content;
    if (typeof content !== "string" || !content || content.includes(oldPath)) continue;
    if (content.trim() === oldFilename) {
      block.content = content.split(oldFilename).join(newFilename);
      rewritten += 1;
    }
  }

  touchProject(data);
  return rewritten;
}


