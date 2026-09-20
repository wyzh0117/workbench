import type {
  ProjectData,
  Requirement,
  RequirementScope,
  RequirementStatus,
  RequirementType,
} from "./types.ts";
import { assert, now } from "./util.ts";
import { touchProject } from "./store.ts";

function removeRequirementUsages(
  data: ProjectData,
  requirementId: string,
): void {
  const requirement = data.requirements.find((candidate) =>
    candidate.id === requirementId
  );
  if (!requirement) return;
  const blockId = requirement.anchor_block_id;
  const layoutId = requirement.layout_instance_id;
  data.asset_usages = data.asset_usages.filter((usage) =>
    !(usage.role === "requirement" &&
      usage.content_item_id === requirement.content_item_id &&
      usage.block_id === blockId &&
      usage.layout_instance_id === layoutId)
  );
}

export interface GapSummary {
  total_open: number;
  by_type: Partial<Record<RequirementType, number>>;
  by_scope: Record<RequirementScope, number>;
}

export function resolveRequirement(
  data: ProjectData,
  requirementId: string,
  resolvedAssetId: string | null = null,
  resolvedBlockId: string | null = null,
): Requirement {
  const requirement = data.requirements.find((candidate) =>
    candidate.id === requirementId
  );
  assert(requirement, `找不到待补: ${requirementId}`);
  if (resolvedAssetId !== null) {
    const asset = data.assets.find((candidate) =>
      candidate.id === resolvedAssetId
    );
    assert(asset, `找不到素材: ${resolvedAssetId}`);
    assert(!asset.archived, "已归档素材不能完成待补");
    const item = data.content_items.find((candidate) =>
      candidate.id === requirement.content_item_id
    );
    assert(item?.project_id === asset.project_id, "素材与内容不属于同一项目");
  }
  if (resolvedBlockId !== null) {
    const block = data.blocks.find((candidate) =>
      candidate.id === resolvedBlockId
    );
    assert(block, `找不到用于完成待补的正文区块: ${resolvedBlockId}`);
    const document = data.documents.find((candidate) =>
      candidate.id === block.document_id
    );
    assert(
      document?.content_item_id === requirement.content_item_id,
      "完成待补的正文区块与内容不匹配",
    );
  }
  removeRequirementUsages(data, requirement.id);
  requirement.status = "resolved";
  requirement.resolved_asset_id = resolvedAssetId;
  requirement.resolved_block_id = resolvedBlockId;
  requirement.resolved_at = now();
  if (resolvedAssetId !== null) {
    const alreadyTracked = data.asset_usages.some((usage) =>
      usage.asset_id === resolvedAssetId &&
      usage.content_item_id === requirement.content_item_id &&
      usage.block_id === requirement.anchor_block_id &&
      usage.layout_instance_id === requirement.layout_instance_id
    );
    if (!alreadyTracked) {
      data.asset_usages.push({
        id: crypto.randomUUID(),
        asset_id: resolvedAssetId,
        content_item_id: requirement.content_item_id,
        block_id: requirement.anchor_block_id,
        layout_instance_id: requirement.layout_instance_id,
        role: "requirement",
        created_at: now(),
      });
    }
  }
  touchProject(data);
  return requirement;
}

export function setRequirementStatus(
  data: ProjectData,
  requirementId: string,
  status: RequirementStatus,
): Requirement {
  const requirement = data.requirements.find((candidate) =>
    candidate.id === requirementId
  );
  assert(requirement, `找不到待补: ${requirementId}`);
  if (status !== "resolved") removeRequirementUsages(data, requirement.id);
  requirement.status = status;
  if (status === "resolved") requirement.resolved_at ??= now();
  if (status !== "resolved") {
    requirement.resolved_at = null;
    requirement.resolved_asset_id = null;
    requirement.resolved_block_id = null;
  }
  touchProject(data);
  return requirement;
}

export function deriveGaps(
  data: ProjectData,
  contentItemId?: string,
): GapSummary {
  const requirements = data.requirements.filter((requirement) =>
    (contentItemId === undefined ||
      requirement.content_item_id === contentItemId) &&
    requirement.status === "open"
  );
  const by_type: Partial<Record<RequirementType, number>> = {};
  const by_scope: Record<RequirementScope, number> = { content: 0, layout: 0 };
  for (const requirement of requirements) {
    by_type[requirement.type] = (by_type[requirement.type] ?? 0) + 1;
    by_scope[requirement.scope] += 1;
  }
  return { total_open: requirements.length, by_type, by_scope };
}

export function deriveCompletion(
  data: ProjectData,
  contentItemId: string,
): number {
  const requirements = data.requirements.filter((item) =>
    item.content_item_id === contentItemId
  );
  if (requirements.length === 0) return 1;
  const complete = requirements.filter((item) => item.status !== "open").length;
  return complete / requirements.length;
}
