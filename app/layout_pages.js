// @ts-check
/** @typedef {import("../src/domain/types.ts").ProjectData} ProjectData */
/** @typedef {import("../src/domain/types.ts").Block} Block */
/** @typedef {import("../src/domain/types.ts").JsonObject} JsonObject */
/** @typedef {import("../src/domain/types.ts").LayoutInstance} LayoutInstance */
/** @typedef {import("../src/domain/types.ts").LayoutPage} LayoutPage */
/** @typedef {import("../src/domain/types.ts").LayoutPageSize} LayoutPageSize */
/** @typedef {import("../src/domain/types.ts").LayoutSection} LayoutSection */
/** @typedef {import("../src/domain/types.ts").Placement} Placement */
/** @typedef {import("../src/domain/types.ts").Requirement} Requirement */
/** @typedef {{after_page_id?: string | null, title?: string, grid_definition?: JsonObject}} AddPageOptions */
/** @typedef {{page_size?: LayoutPageSize}} ConvertPageOptions */
/** @typedef {{row_start: number, row_end: number, column_start: number, column_end: number}} PlacementCoordinates */
/** @typedef {{title?: string}} DuplicatePageOptions */

const DEFAULT_PAGE_SIZE = Object.freeze({
  preset: "16:9", width_pt: 960, height_pt: 540,
});

function id() {
  return crypto.randomUUID();
}

function timestamp() {
  return new Date().toISOString();
}

/** @template T @param {T} value @returns {T} */
function clone(value) {
  return structuredClone(value);
}

/** @template T @param {T | null | undefined} value @returns {value is T} */
function isPresent(value) {
  return value !== null && value !== undefined;
}

/** @param {ProjectData} data @param {string} layoutId @returns {LayoutInstance} */
function layoutFor(data, layoutId) {
  const layout = data.layout_instances.find((candidate) => candidate.id === layoutId);
  if (!layout) throw new Error(`找不到排版版本: ${layoutId}`);
  return layout;
}

/** @param {ProjectData} data @param {string} pageId @returns {LayoutPage} */
function pageFor(data, pageId) {
  const page = data.layout_pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`找不到页面: ${pageId}`);
  return page;
}

/** @param {ProjectData} data @param {string} layoutId @returns {LayoutPage[]} */
function pagesFor(data, layoutId) {
  return data.layout_pages.filter((page) => page.layout_instance_id === layoutId)
    .sort((left, right) => (left.order_index - right.order_index) ||
      left.id.localeCompare(right.id));
}

/** @param {ProjectData} data @param {string} layoutId */
function renumber(data, layoutId) {
  pagesFor(data, layoutId).forEach((page, index) => page.order_index = index);
}

/** @param {ProjectData} data @param {LayoutInstance} layout */
function touch(data, layout) {
  const changedAt = timestamp();
  layout.updated_at = changedAt;
  data.project.updated_at = changedAt;
}

/** @param {ProjectData} data @param {LayoutInstance} layout @param {string} title @param {JsonObject} gridDefinition @returns {LayoutPage} */
function makePage(data, layout, title, gridDefinition) {
  const pages = pagesFor(data, layout.id);
  const page = {
    id: id(),
    layout_instance_id: layout.id,
    title,
    order_index: pages.length,
    grid_definition: clone(gridDefinition ?? layout.grid_definition),
  };
  data.layout_pages.push(page);
  return page;
}

/** @param {JsonObject} grid @param {"rows" | "columns"} key */
function trackCount(grid, key) {
  const value = grid?.[key];
  return Array.isArray(value) && value.length > 0 ? value.length : 1;
}

/** @param {LayoutPage} page @param {Placement} placement @param {Placement[]} existing */
function fits(page, placement, existing) {
  const grid = page.grid_definition;
  if (
    ![placement.row_start, placement.row_end, placement.column_start, placement.column_end]
      .every(Number.isInteger) || placement.row_start < 0 || placement.column_start < 0 ||
    placement.row_end <= placement.row_start ||
    placement.column_end <= placement.column_start ||
    placement.row_end > trackCount(grid, "rows") ||
    placement.column_end > trackCount(grid, "columns")
  ) return false;
  return !existing.some((candidate) =>
    candidate.page_id === page.id && candidate.id !== placement.id &&
    placement.row_start < candidate.row_end &&
    placement.row_end > candidate.row_start &&
    placement.column_start < candidate.column_end &&
    placement.column_end > candidate.column_start
  );
}

/** Add and select a new page after the requested page (or at the end). */
/** @param {ProjectData} data @param {string} layoutId @param {AddPageOptions} [input] @returns {LayoutPage} */
export function addLayoutPage(data, layoutId, input = {}) {
  const layout = layoutFor(data, layoutId);
  if (layout.mode !== "grid") throw new Error("分页只能用于 Grid 排版");
  if (!layout.page_size) layout.page_size = clone(DEFAULT_PAGE_SIZE);
  const pages = pagesFor(data, layoutId);
  const after = input.after_page_id
    ? pages.findIndex((page) => page.id === input.after_page_id)
    : pages.length - 1;
  if (input.after_page_id && after < 0) throw new Error("目标页面不属于该排版");
  const title = String(input.title ?? `第 ${pages.length + 1} 页`).trim();
  if (!title) throw new Error("页面标题不能为空");
  const page = makePage(
    data,
    layout,
    title,
    input.grid_definition ?? layout.grid_definition,
  );
  const ordered = pagesFor(data, layoutId).filter((candidate) => candidate.id !== page.id);
  ordered.splice(after + 1, 0, page);
  ordered.forEach((candidate, index) => candidate.order_index = index);
  layout.pagination_mode = "paged";
  touch(data, layout);
  return page;
}

/** Explicitly convert legacy output Sections to real, stable Page identities. */
/** @param {ProjectData} data @param {string} layoutId @param {ConvertPageOptions} [options] @returns {LayoutPage[]} */
export function convertSectionsToPages(data, layoutId, options = {}) {
  const layout = layoutFor(data, layoutId);
  if (layout.mode !== "grid") throw new Error("只有 Grid 排版可以转换为分页");
  const existing = pagesFor(data, layoutId);
  if (existing.length) {
    layout.pagination_mode = "paged";
    const sections = data.layout_sections.filter((section) =>
      section.layout_instance_id === layoutId
    ).sort((left, right) => left.order_index - right.order_index ||
      left.page_index - right.page_index || left.id.localeCompare(right.id));
    const pageBySection = new Map(sections.map((section, index) =>
      [section.id, existing[index]?.id]
    ));
    const pageIds = new Set(existing.map((page) => page.id));
    const first = existing[0];
    if (!first) throw new Error("分页布局至少需要一页");
    for (const placement of data.placements.filter((candidate) =>
      candidate.layout_instance_id === layoutId
    )) {
      if (!placement.page_id || !pageIds.has(placement.page_id)) {
        placement.page_id = (placement.section_id
          ? pageBySection.get(placement.section_id)
          : undefined) ?? first.id;
      }
    }
    if (options.page_size) layout.page_size = clone(options.page_size);
    else if (!layout.page_size) {
      const maxRows = Math.max(3, ...existing.map((page) => trackCount(page.grid_definition, "rows")));
      layout.page_size = { preset: "legacy", width_pt: 960, height_pt: maxRows * 180 };
    }
    touch(data, layout);
    return existing;
  }
  const sections = data.layout_sections.filter((section) =>
    section.layout_instance_id === layoutId
  ).sort((left, right) => (left.order_index - right.order_index) ||
    (left.page_index - right.page_index) || left.id.localeCompare(right.id));
  const sourcePages = sections.length ? sections : [{
    id: null,
    name: "第 1 页",
    grid_definition: layout.grid_definition,
  }];
  const pages = sourcePages.map((section, index) => ({
    id: id(),
    layout_instance_id: layoutId,
    title: String(section.name || `第 ${index + 1} 页`),
    order_index: index,
    grid_definition: clone(section.grid_definition ?? layout.grid_definition),
  }));
  data.layout_pages.push(...pages);
  const pageBySection = new Map(sections.map((section, index) => [section.id, pages[index]]));
  const first = pages[0];
  if (!first) throw new Error("无法创建分页布局");
  for (const placement of data.placements.filter((candidate) =>
    candidate.layout_instance_id === layoutId
  )) {
    placement.page_id = (placement.section_id
      ? pageBySection.get(placement.section_id)?.id
      : undefined) ?? first.id;
  }
  if (!options.page_size) {
    const maxRows = Math.max(3, ...pages.map((page) => trackCount(page.grid_definition, "rows")));
    layout.page_size = { preset: "legacy", width_pt: 960, height_pt: maxRows * 180 };
  } else {
    layout.page_size = clone(options.page_size);
  }
  layout.pagination_mode = "paged";
  touch(data, layout);
  return pages;
}

/** Rename a page without changing its identity or position. */
/** @param {ProjectData} data @param {string} pageId @param {string} title @returns {LayoutPage} */
export function renameLayoutPage(data, pageId, title) {
  const page = pageFor(data, pageId);
  const nextTitle = String(title ?? "").trim();
  if (!nextTitle) throw new Error("页面标题不能为空");
  page.title = nextTitle;
  touch(data, layoutFor(data, page.layout_instance_id));
  return page;
}

/** Move a page to a zero-based position while keeping IDs and placements stable. */
/** @param {ProjectData} data @param {string} pageId @param {number} orderIndex @returns {LayoutPage} */
export function reorderLayoutPage(data, pageId, orderIndex) {
  const page = pageFor(data, pageId);
  const pages = pagesFor(data, page.layout_instance_id);
  if (!Number.isInteger(orderIndex) || orderIndex < 0 || orderIndex >= pages.length) {
    throw new Error("页面顺序超出范围");
  }
  const previous = pages.indexOf(page);
  pages.splice(previous, 1);
  pages.splice(orderIndex, 0, page);
  pages.forEach((candidate, index) => candidate.order_index = index);
  touch(data, layoutFor(data, page.layout_instance_id));
  return page;
}

/** Delete layout relations only; the canonical content blocks remain intact. */
/** @param {ProjectData} data @param {string} pageId @returns {{deleted_page: LayoutPage, unplaced_block_ids: string[]}} */
export function deleteLayoutPage(data, pageId) {
  const page = pageFor(data, pageId);
  const layout = layoutFor(data, page.layout_instance_id);
  const pages = pagesFor(data, layout.id);
  if (pages.length < 2) throw new Error("分页布局至少保留一页");
  const removedBlockIds = new Set(data.placements.filter((placement) =>
    placement.page_id === page.id
  ).map((placement) => placement.block_id));
  data.placements = data.placements.filter((placement) =>
    placement.page_id !== page.id
  );
  data.layout_pages = data.layout_pages.filter((candidate) => candidate.id !== page.id);
  renumber(data, layout.id);
  const remainingPlaced = new Set(data.placements.filter((placement) =>
    placement.layout_instance_id === layout.id
  ).map((placement) => placement.block_id));
  const unplaced_block_ids = [...removedBlockIds].filter((blockId) =>
    !remainingPlaced.has(blockId)
  );
  touch(data, layout);
  return { deleted_page: page, unplaced_block_ids };
}

/** Move an existing placement to a page, preserving its block identity. */
/** @param {ProjectData} data @param {string} placementId @param {string} pageId @param {PlacementCoordinates | null} [coordinates] @returns {Placement} */
export function movePlacementToPage(data, placementId, pageId, coordinates = null) {
  const placement = data.placements.find((candidate) => candidate.id === placementId);
  if (!placement) throw new Error(`找不到正文放置: ${placementId}`);
  const page = pageFor(data, pageId);
  if (page.layout_instance_id !== placement.layout_instance_id) {
    throw new Error("页面不属于该排版");
  }
  const candidate = { ...placement, ...(coordinates ?? {}), page_id: page.id };
  if (!fits(page, candidate, data.placements)) {
    throw new Error("目标位置超出页面或与已有内容重叠");
  }
  Object.assign(placement, candidate);
  touch(data, layoutFor(data, placement.layout_instance_id));
  return placement;
}

/** Copy page content into independent canonical blocks, reusing referenced assets. */
/** @param {ProjectData} data @param {string} pageId @param {DuplicatePageOptions} [input] @returns {LayoutPage} */
export function duplicateLayoutPage(data, pageId, input = {}) {
  const source = pageFor(data, pageId);
  const layout = layoutFor(data, source.layout_instance_id);
  if (layout.pagination_mode !== "paged") throw new Error("请先启用分页");
  const sourcePlacements = data.placements.filter((placement) =>
    placement.page_id === source.id
  ).sort((left, right) => (left.z_index ?? 0) - (right.z_index ?? 0) ||
    left.id.localeCompare(right.id));
  const sourceBlockIds = [...new Set(sourcePlacements.map((placement) => placement.block_id))];
  const sourceBlocks = sourceBlockIds.map((blockId) =>
    data.blocks.find((block) => block.id === blockId)
  ).filter(isPresent);
  const document = data.documents.find((candidate) =>
    candidate.content_item_id === layout.content_item_id
  );
  if (sourceBlocks.length && !document) throw new Error("课时正文文档不存在");
  const blockIdMap = new Map(sourceBlocks.map((block) => [block.id, id()]));
  const anchorRequirements = data.requirements.filter((requirement) =>
    requirement.anchor_block_id && blockIdMap.has(requirement.anchor_block_id)
  );
  const requirementIdMap = new Map(anchorRequirements.map((requirement) =>
    [requirement.id, id()]
  ));
  const page = makePage(
    data,
    layout,
    String(input.title ?? `${source.title} 副本`).trim(),
    source.grid_definition,
  );
  const pageList = pagesFor(data, layout.id);
  const sourceIndex = pageList.findIndex((candidate) => candidate.id === source.id);
  pageList.splice(pageList.indexOf(page), 1);
  pageList.splice(sourceIndex + 1, 0, page);
  pageList.forEach((candidate, index) => candidate.order_index = index);

  const nextOrder = Math.max(-1, ...data.blocks.filter((block) =>
    block.document_id === document?.id
  ).map((block) => block.order_index)) + 1;
  const copiedAt = timestamp();
  /** @type {Block[]} */
  const blockCopies = sourceBlocks.map((block, index) => ({
    ...clone(block),
    id: blockIdMap.get(block.id) ?? block.id,
    parent_block_id: block.parent_block_id
      ? blockIdMap.get(block.parent_block_id) ?? block.parent_block_id
      : null,
    order_index: nextOrder + index,
    created_at: copiedAt,
    updated_at: copiedAt,
  }));
  const requirementCopies = anchorRequirements.map((requirement) => ({
    ...clone(requirement),
    id: requirementIdMap.get(requirement.id) ?? requirement.id,
    anchor_block_id: requirement.anchor_block_id
      ? blockIdMap.get(requirement.anchor_block_id) ?? requirement.anchor_block_id
      : null,
    resolved_block_id: requirement.resolved_block_id
      ? blockIdMap.get(requirement.resolved_block_id) ?? requirement.resolved_block_id
      : null,
    created_at: copiedAt,
    updated_at: copiedAt,
  }));
  for (const block of blockCopies) {
    if (typeof block.settings?.requirement_id === "string") {
      block.settings.requirement_id = requirementIdMap.get(block.settings.requirement_id) ??
        block.settings.requirement_id;
    }
  }
  data.blocks.push(...blockCopies);
  data.requirements.push(...requirementCopies);
  for (const group of data.groups) {
    const members = [...(group.block_ids ?? [])];
    for (const [index, blockId] of members.entries()) {
      const copiedId = blockIdMap.get(blockId);
      if (copiedId) members.splice(index + 1, 0, copiedId);
    }
    group.block_ids = members;
  }
  const usageCopies = data.asset_usages.flatMap((usage) => {
    if (
      usage.content_item_id !== layout.content_item_id || !usage.block_id ||
      !blockIdMap.has(usage.block_id)
    ) return [];
    return [{
      ...clone(usage),
      id: id(),
      block_id: blockIdMap.get(usage.block_id) ?? usage.block_id,
      created_at: copiedAt,
    }];
  });
  data.asset_usages.push(...usageCopies);
  const placementCopies = sourcePlacements.map((placement) => ({
    ...clone(placement),
    id: id(),
    block_id: blockIdMap.get(placement.block_id) ?? placement.block_id,
    page_id: page.id,
  }));
  data.placements.push(...placementCopies);
  layout.pagination_mode = "paged";
  touch(data, layout);
  return page;
}

/** Set only the canonical logical size; callers own the impact confirmation. */
/** @param {ProjectData} data @param {string} layoutId @param {LayoutPageSize} pageSize @returns {LayoutPageSize} */
export function setLayoutPageSize(data, layoutId, pageSize) {
  const layout = layoutFor(data, layoutId);
  if (!pageSize || !Number.isFinite(pageSize.width_pt) ||
    !Number.isFinite(pageSize.height_pt) || pageSize.width_pt <= 0 ||
    pageSize.height_pt <= 0) {
    throw new Error("页面尺寸必须是有限的正数");
  }
  layout.page_size = clone(pageSize);
  touch(data, layout);
  return layout.page_size;
}

/** Begin pagination with one blank page and a standard landscape canvas. */
/** @param {ProjectData} data @param {string} layoutId @param {LayoutPageSize} [pageSize] @returns {LayoutPage[]} */
export function createPagedLayout(data, layoutId, pageSize = DEFAULT_PAGE_SIZE) {
  const layout = layoutFor(data, layoutId);
  if (layout.mode !== "grid") throw new Error("分页只能用于 Grid 排版");
  layout.page_size = clone(pageSize);
  layout.pagination_mode = "paged";
  if (!pagesFor(data, layoutId).length) {
    makePage(data, layout, "第 1 页", layout.grid_definition);
  }
  touch(data, layout);
  return pagesFor(data, layoutId);
}
