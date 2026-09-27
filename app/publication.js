// @ts-check
/** @typedef {import("../src/domain/types.ts").ProjectData} ProjectData */
/** @typedef {import("../src/domain/types.ts").Asset} Asset */
/** @typedef {import("../src/domain/types.ts").Block} Block */
/** @typedef {import("../src/domain/types.ts").BlockType} BlockType */
/** @typedef {import("../src/domain/types.ts").ContentItem} ContentItem */
/** @typedef {import("../src/domain/types.ts").JsonObject} JsonObject */
/** @typedef {import("../src/domain/types.ts").LayoutInstance} LayoutInstance */
/** @typedef {import("../src/domain/types.ts").LayoutPage} LayoutPage */
/** @typedef {import("../src/domain/types.ts").LayoutPageSize} LayoutPageSize */
/** @typedef {import("../src/domain/types.ts").LayoutSection} LayoutSection */
/** @typedef {import("../src/domain/types.ts").Placement} Placement */
/** @typedef {import("../src/domain/types.ts").LayoutMode} LayoutMode */
/**
 * @typedef {object} PublicationProjectionOptions
 * @property {string | null} [content_item_id]
 * @property {string | null} [layout_instance_id]
 * @property {string[] | null} [page_ids]
 * @property {LayoutPageSize | null} [target_page_size]
 */
/** @typedef {{x_pt: number, y_pt: number, width_pt: number, height_pt: number}} PageRect */
/** @typedef {Pick<LayoutPage, "layout_instance_id" | "grid_definition"> & {id: string | null, title?: string, order_index?: number}} ProjectionPageSource */
/** @typedef {{id: string, type: Asset["type"], title: string, filename: string, output_path: string, mime_type: string, source_url: string | null, inline: boolean}} PublicationMedia */
/** @typedef {{id: string, type: BlockType, text: string, heading_level: number | null, media: PublicationMedia | null}} PublicationBlock */
/** @typedef {{placement_id: string, block_id: string, kind: BlockType, text: string, heading_level: number | null, rect: PageRect, style: {alignment: JsonObject, fit_mode: string, padding: JsonObject, z_index: number, font_size_pt: number, line_height: number}, media: PublicationMedia | null}} PublicationPageItem */
/** @typedef {{page_id: string | null, title: string, order: number, logical_width_pt: number, logical_height_pt: number, items: PublicationPageItem[]}} PublicationPage */
/** @typedef {{layout_instance_id: string, mode: LayoutMode, name: string, pagination_mode: "continuous" | "paged", page_size: LayoutPageSize, sections: string[], pages: PublicationPage[], unplaced_block_ids: string[], placed_block_ids: string[]}} PublicationLayout */
/** @typedef {{code: "legacy_grid_sections_require_pagination", layout_instance_id: string, section_ids: string[], includes_unsectioned: boolean, message: string}} PublicationProjectionNotice */
/** @typedef {{id: string, code: string, title: string, blocks: PublicationBlock[], attachments: PublicationMedia[], layout: PublicationLayout | null}} PublicationLesson */
/** @typedef {{schema_version: "2", project_id: string, title: string, language: string, scope: "lesson" | "course", content_item_id: string | null, generated_from_updated_at: string, selection: {content_item_id: string | null, layout_instance_id: string | null, page_ids: string[] | null}, target_page_size: LayoutPageSize | null, lessons: PublicationLesson[], media: PublicationMedia[], notices: PublicationProjectionNotice[]}} PublicationProjection */
/** @typedef {{native?: boolean, service?: boolean}} PublicationEnvironment */
/** @typedef {Record<string, boolean | null | undefined | {available?: boolean, layout?: boolean}>} PublicationAdapters */
/** @typedef {{status: "available" | "unavailable" | "unsupported" | "lossy", code: string | null}} PublicationCapability */

export const PAGE_SIZE_PRESETS = Object.freeze({
  "16:9": Object.freeze({ preset: "16:9", width_pt: 960, height_pt: 540 }),
  "a4-portrait": Object.freeze({
    preset: "a4-portrait", width_pt: 595.2756, height_pt: 841.8898,
  }),
  "a4-landscape": Object.freeze({
    preset: "a4-landscape", width_pt: 841.8898, height_pt: 595.2756,
  }),
});

const MEDIA_BLOCKS = new Set([
  "image", "gif", "video", "audio", "embed", "gallery",
]);

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** @param {unknown} value @returns {string} */
function textOf(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** @param {unknown} value @param {string} fallback @returns {string} */
function safeName(value, fallback) {
  const cleaned = String(value ?? "").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "").trim();
  return cleaned || fallback;
}

/** @param {unknown} value @returns {boolean} */
function safeRelativePath(value) {
  const path = String(value ?? "").replaceAll("\\", "/");
  return Boolean(path) && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) &&
    !path.split("/").some((part) => !part || part === "." || part === "..");
}

/** @param {Asset} asset @param {boolean} inline @returns {PublicationMedia} */
function mediaFor(asset, inline) {
  const outputPath = safeRelativePath(asset.storage_path)
    ? asset.storage_path.replaceAll("\\", "/")
    : `assets/${asset.id}-${safeName(asset.filename, "asset")}`;
  return {
    id: asset.id,
    type: asset.type,
    title: asset.title || asset.filename,
    filename: asset.filename,
    output_path: outputPath,
    mime_type: asset.mime_type || "application/octet-stream",
    source_url: asset.source_url ?? null,
    inline,
  };
}

/** @param {ProjectData} data @param {ContentItem} item @param {Block} block @returns {Asset | null} */
function resolveBlockAsset(data, item, block) {
  const linked = typeof block.settings?.asset_id === "string"
    ? block.settings.asset_id
    : null;
  const usage = data.asset_usages.find((candidate) =>
    candidate.content_item_id === item.id && candidate.block_id === block.id
  );
  const reference = textOf(block.content).trim();
  return data.assets.find((asset) =>
    !asset.archived &&
    (asset.id === linked || asset.id === usage?.asset_id ||
      asset.filename === reference || asset.storage_path === reference)
  ) ?? null;
}

/** @template {{id: string, order_index?: number}} T @param {T} left @param {T} right @returns {number} */
function compareOrder(left, right) {
  return (left.order_index ?? 0) - (right.order_index ?? 0) ||
    String(left.id).localeCompare(String(right.id));
}

/** @param {ProjectData} data @param {string} layoutInstanceId */
export function getLayoutPages(data, layoutInstanceId) {
  return (Array.isArray(data.layout_pages) ? data.layout_pages : [])
    .filter((page) => page.layout_instance_id === layoutInstanceId)
    .sort(compareOrder);
}

/** Resolve one logical page size in PDF points. */
/** @param {LayoutInstance | null | undefined} layout @returns {LayoutPageSize} */
export function resolvePageSize(layout) {
  const configured = layout?.page_size;
  if (isRecord(configured) && Number.isFinite(configured.width_pt) &&
    Number.isFinite(configured.height_pt) && configured.width_pt > 0 &&
    configured.height_pt > 0) {
    return {
      preset: configured.preset || "custom",
      width_pt: configured.width_pt,
      height_pt: configured.height_pt,
    };
  }
  // Legacy continuous layouts never had a physical page size. This projection
  // uses A4 as an explicit export fallback without writing it into Canonical.
  return { ...PAGE_SIZE_PRESETS["a4-portrait"], preset: "legacy" };
}

/** A page inherits the layout grid unless it owns a per-page override. */
/** @param {LayoutInstance | null | undefined} layout @param {ProjectionPageSource | null | undefined} page @returns {JsonObject} */
export function pageGrid(layout, page) {
  return isRecord(page?.grid_definition) ? page.grid_definition :
    (isRecord(layout?.grid_definition) ? layout.grid_definition : {
      columns: [1], rows: [1],
    });
}

/** @param {JsonObject} grid @param {"rows" | "columns"} key @returns {number[]} */
function tracks(grid, key) {
  const values = grid?.[key];
  if (!Array.isArray(values) || !values.length) return [1];
  return values.map((value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1
  );
}

/** @param {number} startValue @param {number} endValue @param {number} count @returns {[number, number]} */
function boundedSpan(startValue, endValue, count) {
  const start = Math.max(0, Math.min(count - 1, Math.trunc(startValue) || 0));
  const end = Math.max(start + 1, Math.min(count, Math.trunc(endValue) || 0));
  return [start, end];
}

/** Convert existing grid-track coordinates to absolute logical page points. */
/** @param {Placement} placement @param {JsonObject} grid @param {LayoutPageSize} size @returns {PageRect} */
export function resolvePlacementRect(placement, grid, size) {
  const columns = tracks(grid, "columns");
  const rows = tracks(grid, "rows");
  const [columnStart, columnEnd] = boundedSpan(
    placement.column_start, placement.column_end, columns.length,
  );
  const [rowStart, rowEnd] = boundedSpan(
    placement.row_start, placement.row_end, rows.length,
  );
  /** @param {number[]} values @param {number} start @param {number} end @returns {number} */
  const sum = (values, start, end) => values.slice(start, end).reduce(
    (total, value) => total + value,
    0,
  );
  const columnTotal = columns.reduce((total, value) => total + value, 0);
  const rowTotal = rows.reduce((total, value) => total + value, 0);
  return {
    x_pt: size.width_pt * sum(columns, 0, columnStart) / columnTotal,
    y_pt: size.height_pt * sum(rows, 0, rowStart) / rowTotal,
    width_pt: size.width_pt * sum(columns, columnStart, columnEnd) / columnTotal,
    height_pt: size.height_pt * sum(rows, rowStart, rowEnd) / rowTotal,
  };
}

/** Fit a full page inside a target page without cropping or nonuniform stretch. */
/** @param {number} sourceWidthPt @param {number} sourceHeightPt @param {number} targetWidthPt @param {number} targetHeightPt @returns {{scale: number, x_pt: number, y_pt: number, width_pt: number, height_pt: number}} */
export function fitPageRect(sourceWidthPt, sourceHeightPt, targetWidthPt, targetHeightPt) {
  for (const value of [sourceWidthPt, sourceHeightPt, targetWidthPt, targetHeightPt]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("页面尺寸必须是有限的正数");
    }
  }
  const scale = Math.min(targetWidthPt / sourceWidthPt, targetHeightPt / sourceHeightPt);
  const width_pt = sourceWidthPt * scale;
  const height_pt = sourceHeightPt * scale;
  return {
    scale,
    x_pt: (targetWidthPt - width_pt) / 2,
    y_pt: (targetHeightPt - height_pt) / 2,
    width_pt,
    height_pt,
  };
}

/** Shared geometry projection consumed by the editor preview and output adapters. */
/** @param {LayoutInstance} layout @param {ProjectionPageSource} page @param {Placement[]} placements @returns {Omit<PublicationPage, "items"> & {items: Array<{placement_id: string, block_id: string, rect: PageRect, z_index: number}>}} */
export function projectPageGeometry(layout, page, placements) {
  const size = resolvePageSize(layout);
  const grid = pageGrid(layout, page);
  const pagePlacements = placements.filter((placement) =>
    page.id === null ? placement.page_id == null : placement.page_id === page.id
  ).sort((left, right) => (left.z_index ?? 0) - (right.z_index ?? 0) ||
    String(left.id).localeCompare(String(right.id)));
  return {
    page_id: page.id ?? null,
    title: page.title ?? "",
    order: page.order_index ?? 0,
    logical_width_pt: size.width_pt,
    logical_height_pt: size.height_pt,
    items: pagePlacements.map((placement) => ({
      placement_id: placement.id,
      block_id: placement.block_id,
      rect: resolvePlacementRect(placement, grid, size),
      z_index: placement.z_index ?? 0,
    })),
  };
}

/** Resolve deterministic text/image style values shared by HTML and native adapters. */
/** @param {Block} block @param {Placement | undefined} placement @returns {PublicationPageItem["style"]} */
export function resolvePageItemStyle(block, placement) {
  const configuredFontSize = block.settings.font_size_pt;
  const configuredLineHeight = block.settings.line_height;
  const fontSize = typeof configuredFontSize === "number" &&
      Number.isFinite(configuredFontSize)
    ? configuredFontSize
    : block.type === "heading" ? 24 : 18;
  const lineHeight = typeof configuredLineHeight === "number" &&
      Number.isFinite(configuredLineHeight)
    ? configuredLineHeight
    : 1.2;
  return {
    alignment: structuredClone(placement?.alignment ?? {}),
    fit_mode: placement?.fit_mode ?? "natural",
    padding: structuredClone(placement?.padding ?? {}),
    z_index: placement?.z_index ?? 0,
    font_size_pt: Math.max(6, Math.min(144, fontSize)),
    line_height: Math.max(0.8, Math.min(3, lineHeight)),
  };
}

/** @param {Block} block @param {PublicationMedia | null} media @returns {PublicationBlock} */
function blockProjection(block, media) {
  return {
    id: block.id,
    type: block.type,
    text: textOf(block.content),
    heading_level: block.type === "heading"
      ? Math.max(1, Math.min(6, Number(block.settings?.level) || 2))
      : null,
    media,
  };
}

/** @param {ProjectData} data @param {ContentItem} item @param {PublicationProjectionOptions} options @param {PublicationProjectionNotice[]} notices @returns {PublicationLesson} */
function lessonProjection(data, item, options, notices) {
  const blocks = data.blocks.filter((block) => block.document_id === item.document_id)
    .sort(compareOrder);
  const layoutOnly = new Set(data.requirements.filter((requirement) =>
    requirement.content_item_id === item.id && requirement.scope === "layout"
  ).map((requirement) => requirement.anchor_block_id).filter(Boolean));
  const inlineIds = new Set();
  const projectedBlocks = [];
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const mediaByBlockId = new Map();
  for (const block of blocks) {
    if (block.type === "placeholder" || layoutOnly.has(block.id)) continue;
    const asset = MEDIA_BLOCKS.has(block.type)
      ? resolveBlockAsset(data, item, block)
      : null;
    if (asset) {
      inlineIds.add(asset.id);
      mediaByBlockId.set(block.id, mediaFor(asset, true));
    }
    projectedBlocks.push(blockProjection(block, mediaByBlockId.get(block.id) ?? null));
  }
  const usedIds = new Set(data.asset_usages.filter((usage) =>
    usage.content_item_id === item.id
  ).map((usage) => usage.asset_id));
  for (const requirement of data.requirements) {
    if (requirement.content_item_id === item.id && requirement.resolved_asset_id) {
      usedIds.add(requirement.resolved_asset_id);
    }
  }
  const attachments = data.assets.filter((asset) =>
    !asset.archived && usedIds.has(asset.id) && !inlineIds.has(asset.id)
  ).sort((left, right) =>
    left.filename.localeCompare(right.filename) || left.id.localeCompare(right.id)
  ).map((asset) => mediaFor(asset, false));
  const layout = data.layout_instances.find((candidate) =>
    candidate.content_item_id === item.id &&
    (!options.layout_instance_id || candidate.id === options.layout_instance_id)
  ) ?? null;
  if (options.layout_instance_id && item.id === options.content_item_id && !layout) {
    throw new Error("指定的排版版本不属于当前课时");
  }
  if (options.page_ids != null && layout?.pagination_mode !== "paged") {
    throw new Error("只有分页排版可以按页面筛选导出");
  }
  /** @type {PublicationLayout | null} */
  let projectedLayout = null;
  if (layout) {
    const allPlacements = data.placements.filter((placement) =>
      placement.layout_instance_id === layout.id
    );
    /** @type {PublicationPage[]} */
    let pages = [];
    if (layout.pagination_mode === "paged") {
      const allPages = getLayoutPages(data, layout.id);
      const selectedIds = options.page_ids == null
        ? null
        : new Set(options.page_ids);
      if (selectedIds && options.page_ids && selectedIds.size !== options.page_ids.length) {
        throw new Error("所选页面不能重复");
      }
      if (selectedIds) {
        const unknown = [...selectedIds].filter((id) =>
          !allPages.some((page) => page.id === id)
        );
        if (unknown.length) throw new Error("所选页面不属于当前排版");
      }
      const selectedPages = selectedIds
        ? allPages.filter((page) => selectedIds.has(page.id))
        : allPages;
      pages = selectedPages.map((page) => {
        const geometry = projectPageGeometry(layout, page, allPlacements);
        const items = geometry.items.flatMap((geometryItem) => {
          const block = blockById.get(geometryItem.block_id);
          if (!block || block.type === "placeholder" || layoutOnly.has(block.id)) return [];
          const media = mediaByBlockId.get(block.id) ?? null;
          const placement = allPlacements.find((p) => p.id === geometryItem.placement_id);
          return [{
            placement_id: geometryItem.placement_id,
            block_id: block.id,
            kind: block.type,
            text: textOf(block.content),
            heading_level: block.type === "heading"
              ? Math.max(1, Math.min(6, Number(block.settings?.level) || 2))
              : null,
            rect: geometryItem.rect,
            style: {
              ...resolvePageItemStyle(block, placement),
              z_index: geometryItem.z_index,
            },
            media,
          }];
        });
        return { ...geometry, items };
      });
    } else if (layout.mode === "grid") {
      const sections = data.layout_sections.filter((section) =>
        section.layout_instance_id === layout.id
      ).sort((left, right) => (left.order_index - right.order_index) ||
        (left.page_index - right.page_index) || left.id.localeCompare(right.id));
      const sectionById = new Map(sections.map((section) => [section.id, section]));
      const usedSectionIds = new Set();
      let includesUnsectioned = false;
      for (const placement of allPlacements) {
        if (placement.section_id && sectionById.has(placement.section_id)) {
          usedSectionIds.add(placement.section_id);
        } else {
          includesUnsectioned = true;
        }
      }
      const usedSections = sections.filter((section) => usedSectionIds.has(section.id));
      const ambiguousSections = usedSections.length + Number(includesUnsectioned) > 1;
      if (ambiguousSections) {
        notices.push({
          code: "legacy_grid_sections_require_pagination",
          layout_instance_id: layout.id,
          section_ids: usedSections.map((section) => section.id),
          includes_unsectioned: includesUnsectioned,
          message: "旧版连续网格包含多个独立坐标区域；请先确认转换为分页，再进行保真导出。",
        });
      }
      if (ambiguousSections) {
        pages = [];
      } else {
        const activeSection = usedSections[0] ?? null;
        const scopedPlacements = activeSection
          ? allPlacements.filter((placement) => placement.section_id === activeSection.id)
          : allPlacements.filter((placement) =>
            !placement.section_id || !sectionById.has(placement.section_id)
          );
      const legacyPage = {
        id: null,
        layout_instance_id: layout.id,
        title: activeSection?.name ?? "",
        order_index: activeSection?.page_index ?? 0,
        grid_definition: activeSection?.grid_definition ?? layout.grid_definition,
      };
      const geometry = projectPageGeometry(layout, legacyPage, scopedPlacements);
      pages = [
        {
          ...geometry,
          items: geometry.items.flatMap((geometryItem) => {
            const block = blockById.get(geometryItem.block_id);
            if (!block || block.type === "placeholder" || layoutOnly.has(block.id)) return [];
            const placement = allPlacements.find((candidate) =>
              candidate.id === geometryItem.placement_id
            );
            return [{
              placement_id: geometryItem.placement_id,
              block_id: block.id,
              kind: block.type,
              text: textOf(block.content),
              heading_level: block.type === "heading"
                ? Math.max(1, Math.min(6, Number(block.settings?.level) || 2))
                : null,
              rect: geometryItem.rect,
              style: {
                ...resolvePageItemStyle(block, placement),
                z_index: geometryItem.z_index,
              },
              media: mediaByBlockId.get(block.id) ?? null,
            }];
          }),
        },
      ];
      }
    }
    const placedIds = new Set(allPlacements.map((placement) => placement.block_id));
    const unplacedBlockIds = projectedBlocks.map((block) => block.id)
      .filter((blockId) => !placedIds.has(blockId));
    projectedLayout = {
      mode: layout.mode,
      layout_instance_id: layout.id,
      name: layout.name,
      pagination_mode: layout.pagination_mode ?? "continuous",
      page_size: resolvePageSize(layout),
      sections: data.layout_sections.filter((section) =>
        section.layout_instance_id === layout.id
      ).sort(compareOrder).map((section) => section.name),
      pages,
      unplaced_block_ids: unplacedBlockIds,
      placed_block_ids: [...placedIds],
    };
  }
  return {
    id: item.id,
    code: item.code,
    title: item.title,
    blocks: projectedBlocks,
    attachments,
    layout: projectedLayout,
  };
}

/** @param {ProjectData} data */
/** @param {ProjectData} data @param {PublicationProjectionOptions} [options] @returns {PublicationProjection} */
export function buildPublicationProjection(data, options = {}) {
  const contentItemId = options.content_item_id ?? null;
  const items = data.content_items.filter((item) =>
    !item.archived && (!contentItemId || item.id === contentItemId)
  ).sort(compareOrder);
  if (contentItemId && !items.length) throw new Error("指定的导出课程不存在");
  const selectedLayoutId = options.layout_instance_id ?? null;
  if ((options.page_ids != null) && !selectedLayoutId) {
    throw new Error("选择页面时必须指定排版版本");
  }
  if (selectedLayoutId && !contentItemId) {
    throw new Error("选择排版版本时必须限定当前课时或显式选择整课布局");
  }
  if (options.page_ids != null && options.page_ids.length === 0) {
    throw new Error("至少选择一个页面");
  }
  if (options.target_page_size != null) {
    const { width_pt, height_pt } = options.target_page_size;
    if (!Number.isFinite(width_pt) || !Number.isFinite(height_pt) ||
      width_pt <= 0 || height_pt <= 0) {
      throw new Error("输出页面尺寸必须是有限的正数");
    }
  }
  /** @type {PublicationProjectionNotice[]} */
  const notices = [];
  const lessons = items.map((item) => lessonProjection(data, item, {
    ...options,
    content_item_id: contentItemId,
    layout_instance_id: selectedLayoutId,
  }, notices));
  const requestedPageIds = options.page_ids;
  const selectedPageIds = requestedPageIds == null ? null : new Set(requestedPageIds);
  const mediaById = new Map();
  for (const lesson of lessons) {
    for (const block of lesson.blocks) {
      if (block.media) mediaById.set(block.media.id, block.media);
    }
    for (const media of lesson.attachments) mediaById.set(media.id, media);
  }
  return {
    schema_version: "2",
    project_id: data.project.id,
    title: data.project.title,
    language: data.project.language || "zh-CN",
    scope: contentItemId ? "lesson" : "course",
    content_item_id: contentItemId,
    generated_from_updated_at: data.project.updated_at,
    selection: {
      content_item_id: contentItemId,
      layout_instance_id: selectedLayoutId,
      page_ids: selectedPageIds === null ? null : lessons[0]?.layout?.pages
        .flatMap((page) => page.page_id && selectedPageIds.has(page.page_id)
          ? [page.page_id]
          : []) ?? [],
    },
    target_page_size: options.target_page_size ?? null,
    lessons,
    notices,
    media: [...mediaById.values()].sort((left, right) =>
      left.output_path.localeCompare(right.output_path) || left.id.localeCompare(right.id)
    ),
  };
}

/** UI, preflight, and generation share this coarse capability decision. */
export const PUBLICATION_FORMATS = Object.freeze([
  "markdown", "html", "web", "wechat", "pdf", "pptx",
]);

/** @param {PublicationEnvironment} [environment] @returns {PublicationAdapters} */
export function getAvailablePublicationAdapters(environment = {}) {
  const native = environment.native === true;
  const service = environment.service === true;
  return {
    markdown: { available: native || service, layout: false },
    html: { available: native || service, layout: true },
    web: { available: native || service, layout: true },
    wechat: { available: native || service, layout: false },
    pdf: { available: native || service, layout: native },
    pptx: { available: native, layout: native },
  };
}

/** @param {PublicationProjection} projection @param {string} target @param {PublicationAdapters} [adapters] @returns {PublicationCapability} */
export function getPublicationCapabilities(projection, target, adapters = {}) {
  const adapter = adapters[target];
  const adapterInfo = typeof adapter === "object" && adapter !== null ? adapter : null;
  const available = adapter === true || adapterInfo?.available === true;
  const preservesLayout = adapter === true || adapterInfo?.layout === true;
  const hasPages = projection.lessons.some((lesson) =>
    lesson.layout?.pagination_mode === "paged"
  );
  const hasGrid = projection.lessons.some((lesson) =>
    lesson.layout?.mode === "grid"
  );
  const hasFlow = projection.lessons.some((lesson) =>
    lesson.layout?.mode === "flow" || !lesson.layout
  );
  if (!available) return { status: "unavailable", code: "adapter_unavailable" };
  if (
    preservesLayout && ["pdf", "pptx"].includes(target) &&
    !projection.target_page_size
  ) {
    const pageSizes = projection.lessons.flatMap((lesson) =>
      (lesson.layout?.pages || []).map((page) => ({
        width: page.logical_width_pt,
        height: page.logical_height_pt,
      }))
    );
    const firstSize = pageSizes[0];
    if (firstSize && pageSizes.some((size) =>
      Math.abs(size.width - firstSize.width) > 0.01 ||
      Math.abs(size.height - firstSize.height) > 0.01
    )) {
      return { status: "unsupported", code: "explicit_target_page_size_required" };
    }
  }
  if (target === "pptx" && hasFlow) {
    return { status: "unsupported", code: "flow_requires_canvas" };
  }
  if (
    ["html", "web", "pdf", "pptx"].includes(target) &&
    projection.notices.some((notice) =>
      notice.code === "legacy_grid_sections_require_pagination"
    )
  ) {
    return { status: "unsupported", code: "legacy_grid_sections_require_pagination" };
  }
  if (["markdown", "wechat"].includes(target) && (hasPages || hasGrid)) {
    return { status: "lossy", code: "layout_linearized" };
  }
  if ((hasPages || hasGrid) && !preservesLayout) {
    return { status: "unavailable", code: "layout_adapter_unavailable" };
  }
  return { status: "available", code: null };
}
