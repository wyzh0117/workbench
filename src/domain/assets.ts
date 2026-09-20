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
