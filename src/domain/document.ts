import {
  type Block,
  type BlockGroup,
  type BlockType,
  type Document,
  type JsonValue,
  type ProjectData,
  type Requirement,
  type RequirementPriority,
  type RequirementScope,
  type RequirementType,
} from "./types.ts";
import { assert, id, maxOrder, now, stableJson } from "./util.ts";
import { touchProject } from "./store.ts";

export interface MoveBlockInput {
  content_item_id: string;
  block_id: string;
  to_index: number;
  group_id?: string | null;
}

export interface UndoableDocumentChange<T> {
  value: T;
  undo(): void;
}

export function createDocument(
  data: ProjectData,
  contentItemId: string,
): Document {
  const document: Document = {
    id: id(),
    content_item_id: contentItemId,
    schema_version: data.schema_version,
    created_at: now(),
    updated_at: now(),
  };
  data.documents.push(document);
  return document;
}

function getContentItem(data: ProjectData, contentItemId: string) {
  const item = data.content_items.find((candidate) =>
    candidate.id === contentItemId
  );
  assert(item, `找不到内容: ${contentItemId}`);
  return item;
}

function getDocument(data: ProjectData, contentItemId: string): Document {
  const item = getContentItem(data, contentItemId);
  const document = data.documents.find((candidate) =>
    candidate.id === item.document_id
  );
  assert(document, `内容缺少正文文档: ${contentItemId}`);
  return document;
}

export function listBlocks(data: ProjectData, contentItemId: string): Block[] {
  const document = getDocument(data, contentItemId);
  return data.blocks.filter((block) => block.document_id === document.id).sort((
    a,
    b,
  ) => a.order_index - b.order_index);
}

export function appendBlock(
  data: ProjectData,
  contentItemId: string,
  type: BlockType,
  content: JsonValue = "",
  settings: Record<string, JsonValue> = {},
): Block {
  const document = getDocument(data, contentItemId);
  const timestamp = now();
  const block: Block = {
    id: id(),
    document_id: document.id,
    parent_block_id: null,
    type,
    order_index: maxOrder(listBlocks(data, contentItemId)) + 1,
    content,
    settings,
    created_at: timestamp,
    updated_at: timestamp,
  };
  data.blocks.push(block);
  document.updated_at = timestamp;
  getContentItem(data, contentItemId).updated_at = timestamp;
  touchProject(data);
  return block;
}

function groupsForDocument(
  data: ProjectData,
  documentId: string,
): BlockGroup[] {
  return data.groups.filter((group) => group.document_id === documentId);
}

function groupForBlock(data: ProjectData, blockId: string): BlockGroup | null {
  return data.groups.find((group) => group.block_ids.includes(blockId)) ?? null;
}

function normalizeGroupOrder(group: BlockGroup, data: ProjectData): void {
  const valid = group.block_ids.filter((blockId) =>
    data.blocks.some((block) =>
      block.id === blockId && block.document_id === group.document_id
    )
  );
  group.block_ids = [...new Set(valid)];
  group.block_ids.forEach((blockId, index) => {
    const block = data.blocks.find((candidate) => candidate.id === blockId);
    if (block) block.order_index = index;
  });
  group.updated_at = now();
}

/** Create a semantic group; grid coordinates remain owned by Layout. */
export function createBlockGroup(
  data: ProjectData,
  contentItemId: string,
  blockIds: string[] = [],
  title = "未命名分组",
  parentGroupId: string | null = null,
): BlockGroup {
  const document = getDocument(data, contentItemId);
  const blocks = listBlocks(data, contentItemId);
  const known = new Set(blocks.map((block) => block.id));
  assert(new Set(blockIds).size === blockIds.length, "分组区块不能重复");
  assert(
    blockIds.every((blockId) => known.has(blockId)),
    "分组只能包含同一正文的区块",
  );
  assert(
    blockIds.every((blockId) => !groupForBlock(data, blockId)),
    "区块已经属于其他分组",
  );
  if (parentGroupId !== null) {
    const parent = data.groups.find((candidate) =>
      candidate.id === parentGroupId
    );
    assert(parent?.document_id === document.id, "父分组不属于当前正文");
  }
  const timestamp = now();
  const group: BlockGroup = {
    id: id(),
    document_id: document.id,
    parent_group_id: parentGroupId,
    title,
    block_ids: [...blockIds],
    order_index: maxOrder(groupsForDocument(data, document.id)) + 1,
    collapsed: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
  data.groups.push(group);
  normalizeGroupOrder(group, data);
  touchProject(data);
  return group;
}

export const createGroup = createBlockGroup;

/**
 * Move one block between the document root and a semantic group.  The return
 * value carries a real inverse operation so CommandBus can expose Undo.
 */
export function moveBlock(
  data: ProjectData,
  input: MoveBlockInput,
): UndoableDocumentChange<Block> {
  assert(
    Number.isInteger(input.to_index) && input.to_index >= 0,
    "正文位置必须是非负整数",
  );
  const document = getDocument(data, input.content_item_id);
  const block = data.blocks.find((candidate) =>
    candidate.id === input.block_id
  );
  assert(block?.document_id === document.id, "正文区块不属于当前内容");
  const previousGroup = groupForBlock(data, block.id);
  const targetGroup = input.group_id
    ? data.groups.find((group) => group.id === input.group_id)
    : null;
  if (input.group_id) assert(targetGroup, `找不到正文分组: ${input.group_id}`);
  if (targetGroup) {
    assert(targetGroup.document_id === document.id, "正文分组不属于当前内容");
  }
  const previousState = {
    groups: structuredClone(
      data.groups.filter((group) => group.document_id === document.id),
    ),
    order: data.blocks.filter((candidate) =>
      candidate.document_id === document.id
    )
      .map((candidate) => ({
        id: candidate.id,
        order_index: candidate.order_index,
      })),
  };
  const sourceList = previousGroup?.block_ids ?? data.blocks
    .filter((candidate) =>
      candidate.document_id === document.id &&
      !groupForBlock(data, candidate.id)
    )
    .sort((left, right) => left.order_index - right.order_index)
    .map((candidate) => candidate.id);
  const sourceIndex = sourceList.indexOf(block.id);
  assert(sourceIndex >= 0, "正文区块未找到当前位置");
  sourceList.splice(sourceIndex, 1);
  if (previousGroup) previousGroup.block_ids = sourceList;
  const targetList = targetGroup?.block_ids ?? data.blocks
    .filter((candidate) =>
      candidate.document_id === document.id &&
      !groupForBlock(data, candidate.id)
    )
    .sort((left, right) => left.order_index - right.order_index)
    .map((candidate) => candidate.id)
    .filter((blockId) => blockId !== block.id);
  assert(input.to_index <= targetList.length, "正文位置超出范围");
  targetList.splice(input.to_index, 0, block.id);
  if (targetGroup) targetGroup.block_ids = targetList;
  const allGroups = groupsForDocument(data, document.id);
  for (const group of allGroups) normalizeGroupOrder(group, data);
  // Root blocks retain one deterministic semantic order; grouped blocks use
  // their local order for structure view without changing the block schema.
  const root = data.blocks.filter((candidate) =>
    candidate.document_id === document.id && !groupForBlock(data, candidate.id)
  ).sort((left, right) => left.order_index - right.order_index);
  root.forEach((candidate, index) => candidate.order_index = index);
  const timestamp = now();
  block.updated_at = timestamp;
  document.updated_at = timestamp;
  getContentItem(data, input.content_item_id).updated_at = timestamp;
  touchProject(data);
  return {
    value: block,
    undo: () => {
      data.groups = data.groups.filter((group) =>
        group.document_id !== document.id
      );
      data.groups.push(...structuredClone(previousState.groups));
      for (const previous of previousState.order) {
        const current = data.blocks.find((candidate) =>
          candidate.id === previous.id
        );
        if (current) current.order_index = previous.order_index;
      }
      touchProject(data);
    },
  };
}

export function moveGroup(
  data: ProjectData,
  groupId: string,
  toIndex: number,
): UndoableDocumentChange<BlockGroup> {
  assert(Number.isInteger(toIndex) && toIndex >= 0, "分组位置必须是非负整数");
  const group = data.groups.find((candidate) => candidate.id === groupId);
  assert(group, `找不到正文分组: ${groupId}`);
  const siblings = groupsForDocument(data, group.document_id).filter((
    candidate,
  ) => candidate.parent_group_id === group.parent_group_id).sort((
    left,
    right,
  ) => left.order_index - right.order_index);
  const previous = siblings.map((candidate) => ({
    id: candidate.id,
    order_index: candidate.order_index,
  }));
  const currentIndex = siblings.indexOf(group);
  assert(currentIndex >= 0, "分组未找到当前位置");
  siblings.splice(currentIndex, 1);
  assert(toIndex <= siblings.length, "分组位置超出范围");
  siblings.splice(toIndex, 0, group);
  siblings.forEach((candidate, index) => {
    candidate.order_index = index;
    candidate.updated_at = now();
  });
  touchProject(data);
  return {
    value: group,
    undo: () => {
      for (const item of previous) {
        const current = data.groups.find((candidate) =>
          candidate.id === item.id
        );
        if (current) current.order_index = item.order_index;
      }
      touchProject(data);
    },
  };
}

export function ungroupBlocks(
  data: ProjectData,
  groupId: string,
): BlockGroup {
  const index = data.groups.findIndex((candidate) => candidate.id === groupId);
  assert(index >= 0, `找不到正文分组: ${groupId}`);
  const [group] = data.groups.splice(index, 1);
  assert(group, `找不到正文分组: ${groupId}`);
  touchProject(data);
  return group;
}

export function reorderBlocks(
  data: ProjectData,
  contentItemId: string,
  orderedBlockIds: string[],
): void {
  const blocks = listBlocks(data, contentItemId);
  assert(blocks.length === orderedBlockIds.length, "正文排序必须包含全部区块");
  assert(
    new Set(orderedBlockIds).size === orderedBlockIds.length,
    "正文排序不能重复区块",
  );
  const known = new Set(blocks.map((block) => block.id));
  assert(
    orderedBlockIds.every((blockId) => known.has(blockId)),
    "正文排序包含其他内容的区块",
  );
  const timestamp = now();
  orderedBlockIds.forEach((blockId, index) => {
    const block = data.blocks.find((candidate) => candidate.id === blockId)!;
    block.order_index = index;
    block.updated_at = timestamp;
  });
  getDocument(data, contentItemId).updated_at = timestamp;
  getContentItem(data, contentItemId).updated_at = timestamp;
  touchProject(data);
}

export function updateBlockContent(
  data: ProjectData,
  blockId: string,
  content: JsonValue,
): Block {
  const block = data.blocks.find((candidate) => candidate.id === blockId);
  assert(block, `找不到正文区块: ${blockId}`);
  block.content = content;
  block.updated_at = now();
  const document = data.documents.find((candidate) =>
    candidate.id === block.document_id
  );
  assert(document, `正文区块缺少文档: ${blockId}`);
  document.updated_at = now();
  const item = data.content_items.find((candidate) =>
    candidate.document_id === document.id
  );
  assert(item, `正文文档缺少内容: ${document.id}`);
  item.updated_at = now();
  touchProject(data);
  return block;
}

export interface PlaceholderInput {
  type: RequirementType;
  note: string;
  priority?: RequirementPriority;
  scope?: RequirementScope;
  layout_instance_id?: string | null;
}

export function insertPlaceholder(
  data: ProjectData,
  contentItemId: string,
  input: PlaceholderInput,
): Requirement {
  const scope = input.scope ?? "content";
  const layoutInstanceId = input.layout_instance_id ?? null;
  if (scope === "layout") {
    assert(layoutInstanceId, "排版待补必须关联排版版本");
    const layout = data.layout_instances.find((candidate) =>
      candidate.id === layoutInstanceId
    );
    assert(
      layout?.content_item_id === contentItemId,
      "排版待补与正文不属于同一内容",
    );
  } else {
    assert(layoutInstanceId === null, "内容待补不能关联排版版本");
  }

  const block = scope === "content"
    ? appendBlock(data, contentItemId, "placeholder", input.note, {
      requirement_type: input.type,
      scope,
    })
    : null;
  const requirement: Requirement = {
    id: id(),
    content_item_id: contentItemId,
    anchor_block_id: block?.id ?? null,
    type: input.type,
    scope,
    layout_instance_id: layoutInstanceId,
    note: input.note,
    status: "open",
    priority: input.priority ?? "normal",
    resolved_asset_id: null,
    resolved_block_id: null,
    created_at: now(),
    resolved_at: null,
  };
  data.requirements.push(requirement);
  if (block) block.settings.requirement_id = requirement.id;
  return requirement;
}

/**
 * Insert a block at an explicit position.  Authoring inserts happen next to
 * the block the user is looking at, so append-only helpers are not enough.
 */
export function insertBlockAt(
  data: ProjectData,
  contentItemId: string,
  type: BlockType,
  content: JsonValue,
  toIndex: number,
  settings: Record<string, JsonValue> = {},
): Block {
  assert(
    Number.isInteger(toIndex) && toIndex >= 0,
    "正文位置必须是非负整数",
  );
  const document = getDocument(data, contentItemId);
  const existing = listBlocks(data, contentItemId);
  assert(toIndex <= existing.length, "正文位置超出范围");
  const timestamp = now();
  const block: Block = {
    id: id(),
    document_id: document.id,
    parent_block_id: null,
    type,
    order_index: toIndex,
    content,
    settings,
    created_at: timestamp,
    updated_at: timestamp,
  };
  data.blocks.push(block);
  const ordered = [...existing];
  ordered.splice(toIndex, 0, block);
  ordered.forEach((candidate, index) => {
    candidate.order_index = index;
    if (candidate.id !== block.id) candidate.updated_at = timestamp;
  });
  document.updated_at = timestamp;
  getContentItem(data, contentItemId).updated_at = timestamp;
  touchProject(data);
  return block;
}

/**
 * Remove one block together with every canonical row that pointed at it.
 *
 * Deleting a block is the highest-risk authoring action: an orphaned
 * Requirement, AssetUsage or Placement would keep a reference to a row that no
 * longer exists.  The cascade is therefore explicit here instead of relying on
 * the caller to remember each collection.
 */
export function deleteBlock(data: ProjectData, blockId: string): void {
  const index = data.blocks.findIndex((candidate) => candidate.id === blockId);
  assert(index >= 0, `找不到正文区块: ${blockId}`);
  const [block] = data.blocks.splice(index, 1);
  assert(block, `找不到正文区块: ${blockId}`);
  data.requirements = data.requirements.filter((requirement) =>
    requirement.anchor_block_id !== blockId
  );
  data.asset_usages = data.asset_usages.filter((usage) =>
    usage.block_id !== blockId
  );
  data.placements = data.placements.filter((placement) =>
    placement.block_id !== blockId
  );
  for (const group of data.groups) {
    group.block_ids = group.block_ids.filter((candidate) =>
      candidate !== blockId
    );
  }
  const timestamp = now();
  listBlocksByDocument(data, block.document_id).forEach((
    candidate,
    order,
  ) => {
    candidate.order_index = order;
  });
  for (const requirement of data.requirements) {
    if (requirement.resolved_block_id === blockId) {
      requirement.resolved_block_id = null;
    }
  }
  const document = data.documents.find((candidate) =>
    candidate.id === block.document_id
  );
  if (document) {
    document.updated_at = timestamp;
    const item = data.content_items.find((candidate) =>
      candidate.document_id === document.id
    );
    if (item) item.updated_at = timestamp;
  }
  touchProject(data);
}

function listBlocksByDocument(data: ProjectData, documentId: string): Block[] {
  return data.blocks.filter((block) => block.document_id === documentId).sort((
    left,
    right,
  ) => left.order_index - right.order_index);
}

export function documentRevision(
  data: ProjectData,
  contentItemId: string,
): string {
  return stableJson(
    listBlocks(data, contentItemId).map((block) => ({
      id: block.id,
      order_index: block.order_index,
      type: block.type,
      content: block.content,
    })),
  );
}
