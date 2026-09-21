// @ts-check
/*
 * Course Authoring projections.
 *
 * Every function here is a pure read over canonical ProjectData.  The course
 * map, the lesson editor, the preview and the completion badges all render
 * these same projections, so none of them can drift into a second source of
 * truth.  Nothing in this module mutates project data or writes to disk.
 *
 * The module lives under `app/` because both the browser renderer and the
 * Deno test suite must load the identical file without a build step.
 */

/** @typedef {import("../src/domain/types.ts").ProjectData} ProjectData */
/** @typedef {import("../src/domain/types.ts").Block} Block */
/** @typedef {import("../src/domain/types.ts").ContentItem} ContentItem */
/** @typedef {import("../src/domain/types.ts").Stage} Stage */
/** @typedef {import("../src/domain/types.ts").Requirement} Requirement */
/** @typedef {import("../src/domain/types.ts").Asset} Asset */
/** @typedef {import("../src/domain/types.ts").AssetUsage} AssetUsage */
/** @typedef {import("../src/domain/types.ts").LayoutInstance} LayoutInstance */
/** @typedef {import("../src/domain/types.ts").LayoutSection} LayoutSection */
/** @typedef {import("../src/domain/types.ts").Placement} Placement */

/**
 * Block types that carry a media reference instead of prose.  `embed` covers
 * Markdown/PDF/other attachments, so the preview and the media counter treat it
 * exactly like an image or a video slot.
 */
export const MEDIA_BLOCK_TYPES = ["image", "gif", "video", "audio", "embed"];
/** Block types that hold human-readable text. */
export const TEXT_BLOCK_TYPES = [
  "heading",
  "paragraph",
  "quote",
  "code",
  "callout",
  "exercise",
  "table",
  "chart",
  "placeholder",
];

/**
 * Status dimensions that decide whether a lesson is finished.  Publish and
 * update describe a lesson that is already authored, so they never block the
 * "this lesson is done" answer.
 */
export const COMPLETION_DIMENSIONS = ["content", "media", "layout", "review"];

/** @type {Record<string, string>} */
const DIMENSION_LABELS = {
  content: "正文",
  media: "媒体",
  layout: "排版",
  review: "审核",
  publish: "发布",
  update: "更新",
};

/** @type {Record<string, string>} */
const NEXT_STEP_LABELS = {
  content: "继续写正文",
  media: "补素材",
  layout: "安排排版",
  review: "等待审核",
  publish: "可以发布",
  update: "需要更新",
  start: "开始第一段正文",
};

/**
 * @param {unknown} value
 * @returns {string}
 */
export function textOf(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * A short single-line summary used by the course map, structure view and
 * block headers.  Media blocks summarise their reference instead of dumping
 * JSON into the UI.
 *
 * @param {Block} block
 * @param {Asset | null} [asset]
 * @returns {string}
 */
export function blockSummary(block, asset = null) {
  if (MEDIA_BLOCK_TYPES.includes(block.type)) {
    return asset ? asset.title || asset.filename : textOf(block.content);
  }
  const text = textOf(block.content).replace(/\s+/g, " ").trim();
  return text;
}

/**
 * @param {string} type
 * @returns {string}
 */
export function blockLabel(type) {
  return {
    heading: "标题",
    paragraph: "正文",
    quote: "引用",
    image: "图片",
    gallery: "图组",
    gif: "GIF",
    video: "视频",
    audio: "音频",
    table: "表格",
    chart: "图表",
    code: "代码",
    callout: "提示",
    exercise: "练习",
    divider: "分隔线",
    placeholder: "待补",
    embed: "嵌入",
  }[type] || type;
}

/**
 * @param {string} type
 * @returns {string}
 */
export function assetLabel(type) {
  return {
    image: "图片",
    gif: "GIF",
    video: "视频",
    audio: "音频",
    document: "文档",
    other: "附件",
  }[type] || "素材";
}

/**
 * Human readable byte size for the media panel and asset cards.
 * @param {unknown} value
 * @returns {string}
 */
export function formatBytes(value) {
  const size = Number(value) || 0;
  if (size <= 0) return "未知大小";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {string} key
 * @returns {string}
 */
export function dimensionLabel(key) {
  return DIMENSION_LABELS[key] || key;
}

/**
 * @param {ProjectData} data
 * @param {keyof ProjectData} key
 * @returns {any[]}
 */
function arrayOf(data, key) {
  const value = data && data[key];
  return Array.isArray(value) ? value : [];
}

/**
 * @param {ProjectData} data
 * @param {string | null | undefined} contentItemId
 * @returns {Block[]}
 */
export function blocksFor(data, contentItemId) {
  const item = arrayOf(data, "content_items").find((candidate) =>
    candidate.id === contentItemId
  );
  if (!item) return [];
  return arrayOf(data, "blocks")
    .filter((block) => block.document_id === item.document_id)
    .sort((left, right) =>
      (left.order_index ?? 0) - (right.order_index ?? 0) ||
      String(left.id).localeCompare(String(right.id))
    );
}

/**
 * @param {ProjectData} data
 * @param {string} contentItemId
 * @returns {LayoutInstance | null}
 */
export function layoutFor(data, contentItemId) {
  return arrayOf(data, "layout_instances").find((candidate) =>
    candidate.content_item_id === contentItemId
  ) || null;
}

/**
 * Sections of a layout in reading order.
 *
 * @param {ProjectData} data
 * @param {string} layoutInstanceId
 * @returns {LayoutSection[]}
 */
export function sectionsFor(data, layoutInstanceId) {
  return arrayOf(data, "layout_sections")
    .filter((section) => section.layout_instance_id === layoutInstanceId)
    .sort((left, right) =>
      (left.order_index ?? 0) - (right.order_index ?? 0) ||
      (left.page_index ?? 0) - (right.page_index ?? 0)
    );
}

/**
 * @param {ProjectData} data
 * @param {string} layoutInstanceId
 * @returns {Placement[]}
 */
export function placementsFor(data, layoutInstanceId) {
  return arrayOf(data, "placements").filter((placement) =>
    placement.layout_instance_id === layoutInstanceId
  );
}

/**
 * @param {ProjectData} data
 * @param {string} contentItemId
 * @returns {Requirement[]}
 */
export function requirementsFor(data, contentItemId) {
  return arrayOf(data, "requirements").filter((requirement) =>
    requirement.content_item_id === contentItemId
  );
}

/**
 * @param {ProjectData} data
 * @param {string} assetId
 * @returns {AssetUsage[]}
 */
export function usagesForAsset(data, assetId) {
  return arrayOf(data, "asset_usages").filter((usage) =>
    usage.asset_id === assetId
  );
}

/**
 * Resolve the asset a media block points at.  `settings.asset_id` is the
 * canonical link; the filename/storage-path fallback keeps projects authored
 * before the link existed readable instead of showing them as broken.
 *
 * @param {ProjectData} data
 * @param {Block | null | undefined} block
 * @returns {Asset | null}
 */
export function assetForBlock(data, block) {
  if (!block || !MEDIA_BLOCK_TYPES.includes(block.type)) return null;
  const assets = arrayOf(data, "assets");
  const settings = block.settings || {};
  const linked = typeof settings.asset_id === "string" ? settings.asset_id : "";
  if (linked) {
    const asset = assets.find((candidate) => candidate.id === linked);
    if (asset) return asset;
  }
  const reference = textOf(block.content).trim();
  if (!reference) return null;
  return assets.find((candidate) =>
    candidate.filename === reference ||
    candidate.storage_path === reference ||
    candidate.title === reference
  ) || null;
}

/**
 * @param {ProjectData} data
 * @param {string} blockId
 * @returns {AssetUsage[]}
 */
export function usagesForBlock(data, blockId) {
  return arrayOf(data, "asset_usages").filter((usage) =>
    usage.block_id === blockId
  );
}

/**
 * True when the asset has at least one reference outside the lesson being
 * inspected.  Used by the delete flow to explain the blast radius before the
 * user commits to it.
 *
 * @param {ProjectData} data
 * @param {string} assetId
 * @param {string | null} [exceptContentItemId]
 */
export function assetUsedElsewhere(data, assetId, exceptContentItemId = null) {
  return usagesForAsset(data, assetId).filter((usage) =>
    usage.content_item_id !== exceptContentItemId
  );
}

/**
 * Map an asset id to the lessons that reference it.
 *
 * @param {ProjectData} data
 * @returns {Map<string, string[]>}
 */
export function lessonsByAsset(data) {
  /** @type {Map<string, string[]>} */
  const map = new Map();
  for (const usage of arrayOf(data, "asset_usages")) {
    const list = map.get(usage.asset_id) || [];
    if (!list.includes(usage.content_item_id)) list.push(usage.content_item_id);
    map.set(usage.asset_id, list);
  }
  return map;
}

/**
 * @param {ProjectData} data
 * @param {string | null | undefined} optionId
 * @returns {string}
 */
function optionName(data, optionId) {
  if (!optionId) return "";
  const option = arrayOf(data, "status_options").find((candidate) =>
    candidate.id === optionId
  );
  return option ? option.name : "";
}

/**
 * @param {ProjectData} data
 * @param {string} contentItemId
 * @param {string} dimensionKey
 * @returns {{ key: string, name: string, option: string, terminal: boolean }}
 */
export function statusView(data, contentItemId, dimensionKey) {
  const dimension = arrayOf(data, "status_dimensions").find((candidate) =>
    candidate.key === dimensionKey
  );
  const assignment = arrayOf(data, "status_assignments").find((candidate) =>
    candidate.content_item_id === contentItemId &&
    (candidate.dimension_id === dimension?.id ||
      candidate.dimension_key === dimensionKey)
  );
  const optionId = assignment && assignment.option_id;
  const option = optionId
    ? arrayOf(data, "status_options").find((candidate) =>
      candidate.id === optionId
    )
    : null;
  const legacy = assignment && typeof assignment.option === "string"
    ? assignment.option
    : "";
  return {
    key: dimensionKey,
    name: dimension?.name || dimensionLabel(dimensionKey),
    option: option?.name || legacy || "",
    terminal: Boolean(option?.is_terminal),
  };
}

/**
 * @param {ProjectData} data
 * @param {string} contentItemId
 * @returns {Array<{ key: string, name: string, option: string, terminal: boolean }>}
 */
export function statusViews(data, contentItemId) {
  return COMPLETION_DIMENSIONS.concat(["publish", "update"]).map((key) =>
    statusView(data, contentItemId, key)
  );
}

/**
 * @param {ProjectData} data
 * @param {string} contentItemId
 */
export function gapCounts(data, contentItemId) {
  const open = requirementsFor(data, contentItemId).filter((requirement) =>
    requirement.status === "open"
  );
  const content = open.filter((requirement) => requirement.scope === "content");
  const layout = open.filter((requirement) => requirement.scope === "layout");
  /** @type {Record<string, number>} */
  const byType = {};
  for (const requirement of open) {
    byType[requirement.type] = (byType[requirement.type] ?? 0) + 1;
  }
  return {
    total: open.length,
    content: content.length,
    layout: layout.length,
    /** Per media/text type counts, used for the "图片：缺 N 张" counters. */
    by_type: byType,
    by_scope: { content: content.length, layout: layout.length },
    byPriority: {
      high: open.filter((requirement) => requirement.priority === "high").length,
      normal: open.filter((requirement) =>
        requirement.priority === "normal"
      ).length,
      low: open.filter((requirement) => requirement.priority === "low").length,
    },
  };
}

/**
 * The single derived answer to "is this lesson finished, and what is left?".
 * It is computed from real course data and never stored, so it cannot drift
 * from the content it describes.
 *
 * @param {ProjectData} data
 * @param {string} contentItemId
 */
export function lessonProgress(data, contentItemId) {
  const item = arrayOf(data, "content_items").find((candidate) =>
    candidate.id === contentItemId
  );
  const blocks = item ? blocksFor(data, contentItemId) : [];
  const gaps = gapCounts(data, contentItemId);
  const writable = blocks.filter((block) =>
    TEXT_BLOCK_TYPES.includes(block.type) && block.type !== "placeholder"
  );
  const unwritten = writable.filter((block) =>
    textOf(block.content).trim().length === 0
  ).length;
  const placeholders = blocks.filter((block) =>
    block.type === "placeholder"
  ).length;
  const layout = layoutFor(data, contentItemId);
  const statuses = statusViews(data, contentItemId);
  const unfinished = statuses
    .filter((status) =>
      COMPLETION_DIMENSIONS.includes(status.key) && !status.terminal
    )
    .map((status) => status.key);
  const reasons = [];
  if (!item) reasons.push("课程里还没有这一课");
  if (blocks.length === 0) reasons.push("还没有任何正文");
  if (unwritten > 0) reasons.push(`${unwritten} 段正文是空的`);
  // A placeholder is the visible half of a requirement; naming it separately
  // keeps the reason list readable without double-counting the same gap.
  if (gaps.total === 0 && placeholders > 0) {
    reasons.push(`${placeholders} 处占位符没有替换`);
  }
  if (gaps.total > 0) reasons.push(`${gaps.total} 项待补未完成`);
  if (!layout) reasons.push("还没有排版版本");
  for (const key of unfinished) {
    const status = statuses.find((candidate) => candidate.key === key);
    reasons.push(`${status ? status.name : dimensionLabel(key)}仍是「${
      status && status.option ? status.option : "未设置"
    }」`);
  }
  // Unwritten blocks and unresolved placeholders are outstanding work, so they
  // are added to the denominator rather than subtracted from the numerator.
  const mediaCount = blocks.filter((block) =>
    MEDIA_BLOCK_TYPES.includes(block.type)
  );
  const percentage = (() => {
    const total = blocks.length + unwritten + placeholders + gaps.total + 2;
    if (total === 0) return 0;
    const written = Math.max(
      0,
      blocks.length - unwritten - placeholders,
    );
    const done = written + (gaps.total === 0 ? 1 : 0) + (layout ? 1 : 0);
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  })();
  return {
    content_item_id: contentItemId,
    complete: Boolean(item) && reasons.length === 0,
    reasons,
    percentage,
    block_count: blocks.length,
    text_blocks: writable.length,
    empty_text_blocks: unwritten,
    placeholders,
    open_requirements: gaps.total,
    has_layout: Boolean(layout),
    /** Media slots with no resolvable asset, counted for the gap summary. */
    missing_media: mediaCount.filter((block) =>
      !assetForBlock(data, block)
    ).length,
    unfinished_dimensions: unfinished,
    statuses,
  };
}

/**
 * @param {ProjectData} data
 * @param {string} contentItemId
 */
function lessonSummary(data, contentItemId) {
  const item = arrayOf(data, "content_items").find((candidate) =>
    candidate.id === contentItemId
  );
  const progress = lessonProgress(data, contentItemId);
  const blocks = blocksFor(data, contentItemId).map((block) =>
    blockView(data, block)
  );
  const mediaBlocks = blocks.filter((block) => block.media);
  const layout = layoutFor(data, contentItemId);
  const status = statusView(data, contentItemId, "content");
  return {
    id: contentItemId,
    code: item ? item.code : "",
    title: item ? item.title : "未命名",
    type: item ? item.type : "lesson",
    description: item ? item.description : "",
    stage_id: item ? item.stage_id : null,
    order_index: item ? item.order_index ?? 0 : 0,
    archived: Boolean(item && item.archived),
    document_id: item ? item.document_id : "",
    blocks,
    block_count: blocks.length,
    media_count: mediaBlocks.filter((block) => block.asset).length,
    missing_media: mediaBlocks.filter((block) => !block.asset).length,
    requirements: requirementsFor(data, contentItemId),
    open_requirements: progress.open_requirements,
    gaps: gapCounts(data, contentItemId),
    summary: lessonSummaryLine(blocks),
    content_status: status.option,
    layout,
    layout_mode: layout && layout.mode === "flow" ? "flow" : "grid",
    placement_count: layout ? placementsFor(data, layout.id).length : 0,
    progress,
  };
}

/**
 * @param {ReturnType<typeof blockView>[]} blocks
 */
function lessonSummaryLine(blocks) {
  const prose = blocks.find((block) =>
    TEXT_BLOCK_TYPES.includes(block.type) && block.type !== "placeholder" &&
    block.text.trim().length > 0
  );
  if (prose) {
    const text = prose.text.replace(/\s+/g, " ").trim();
    return text.length > 42 ? `${text.slice(0, 42)}…` : text;
  }
  if (blocks.some((block) => block.type === "placeholder")) return "只有待补内容";
  if (blocks.length > 0) return "还没有正文";
  return "空课";
}

/**
 * One block as the editor needs it: identity, resolved media, and the label
 * the UI shows.  No DOM and no derived persistence.
 *
 * @param {ProjectData} data
 * @param {Block} block
 */
export function blockView(data, block) {
  const asset = assetForBlock(data, block);
  const media = MEDIA_BLOCK_TYPES.includes(block.type);
  return {
    id: block.id,
    type: block.type,
    order_index: block.order_index ?? 0,
    label: blockLabel(block.type),
    text: textOf(block.content),
    summary: blockSummary(block, asset),
    level: typeof (block.settings || {}).level === "number"
      ? Number(block.settings.level)
      : 2,
    settings: block.settings || {},
    media,
    asset,
    asset_missing: media && !asset,
    requirement_id: typeof (block.settings || {}).requirement_id === "string"
      ? String(block.settings.requirement_id)
      : null,
    updated_at: block.updated_at || null,
  };
}

/**
 * The lesson editor's read model.  Everything the writing, structure, layout
 * and preview views need, derived once per render.
 *
 * @param {ProjectData} data
 * @param {string | null | undefined} contentItemId
 */
export function lessonView(data, contentItemId) {
  if (!contentItemId) return null;
  const lesson = lessonSummary(data, contentItemId);
  const layout = lesson.layout;
  const placementByBlock = new Map(
    (layout ? placementsFor(data, layout.id) : []).map((placement) => [
      placement.block_id,
      placement,
    ]),
  );
  return {
    lesson,
    blocks: lesson.blocks,
    requirements: lesson.requirements,
    unplaced_blocks: lesson.blocks.filter((block) =>
      !placementByBlock.has(block.id)
    ),
    placements: layout ? placementsFor(data, layout.id) : [],
    sections: layout ? sectionsFor(data, layout.id) : [],
    placement_of: (/** @type {string} */ blockId) =>
      placementByBlock.get(blockId) || null,
    progress: lesson.progress,
  };
}

/**
 * @param {ProjectData} data
 * @param {ContentItem | null | undefined} item
 * @returns {Stage | null}
 */
function stageOf(data, item) {
  if (!item || !item.stage_id) return null;
  return arrayOf(data, "stages").find((stage) => stage.id === item.stage_id) ||
    null;
}

/**
 * Build the course map: the whole course, in reading order, with the derived
 * state each lesson needs to be identified without opening it.
 *
 * `currentId` only marks a position; it is never written back to canonical
 * data.
 *
 * @param {ProjectData} data
 * @param {string | null} [currentId]
 */
export function courseMap(data, currentId = null) {
  const items = arrayOf(data, "content_items").filter((item) => !item.archived);
  const stages = arrayOf(data, "stages")
    .filter((stage) => !stage.archived)
    .sort((left, right) =>
      (left.order_index ?? 0) - (right.order_index ?? 0)
    );
  /** @type {Array<{ id: string, code: string, title: string, description: string, learning_action: string, lessons: any[], lesson_count: number, open_requirements: number, complete_count: number, progress: number, current: boolean }>} */
  const sections = [];
  for (const stage of stages) {
    const lessons = items
      .filter((item) => item.stage_id === stage.id)
      .sort((left, right) => (left.order_index ?? 0) - (right.order_index ?? 0))
      .map((item) => lessonSummary(data, item.id));
    sections.push({
      id: stage.id,
      code: stage.code,
      title: stage.title,
      description: stage.description || "",
      learning_action: stage.learning_action || "",
      lessons,
      lesson_count: lessons.length,
      open_requirements: lessons.reduce((sum, lesson) =>
        sum + lesson.open_requirements, 0),
      complete_count: lessons.filter((lesson) => lesson.progress.complete)
        .length,
      progress: lessons.length === 0 ? 0 : Math.round(
        lessons.reduce((sum, lesson) => sum + lesson.progress.percentage, 0) /
          lessons.length,
      ),
      current: lessons.some((lesson) => lesson.id === currentId),
    });
  }
  const unassigned = items
    .filter((item) => !item.stage_id)
    .sort((left, right) => (left.order_index ?? 0) - (right.order_index ?? 0))
    .map((item) => lessonSummary(data, item.id));
  if (unassigned.length > 0) {
    sections.push({
      id: "",
      code: "—",
      title: "未分组",
      description: "还没有归入阶段的内容",
      learning_action: "",
      lessons: unassigned,
      lesson_count: unassigned.length,
      open_requirements: unassigned.reduce((sum, lesson) =>
        sum + lesson.open_requirements, 0),
      complete_count: unassigned.filter((lesson) => lesson.progress.complete)
        .length,
      progress: Math.round(
        unassigned.reduce((sum, lesson) => sum + lesson.progress.percentage, 0) /
          unassigned.length,
      ),
      current: unassigned.some((lesson) => lesson.id === currentId),
    });
  }
  const ordered = sections.flatMap((section) => section.lessons);
  const currentIndex = ordered.findIndex((lesson) => lesson.id === currentId);
  const lessonCount = ordered.length;
  const completeCount = ordered.filter((lesson) => lesson.progress.complete)
    .length;
  return {
    project_title: data.project ? data.project.title : "",
    stages: sections,
    sections,
    lessons: ordered,
    lesson_count: lessonCount,
    complete_count: completeCount,
    open_requirements: ordered.reduce((sum, lesson) =>
      sum + lesson.open_requirements, 0),
    missing_media: ordered.reduce((sum, lesson) =>
      sum + lesson.missing_media, 0),
    progress: lessonCount === 0 ? 0 : Math.round(
      ordered.reduce((sum, lesson) => sum + lesson.progress.percentage, 0) /
        lessonCount,
    ),
    current_id: currentId,
    current_index: currentIndex,
    previous_id: currentIndex > 0 ? ordered[currentIndex - 1].id : null,
    next_id: currentIndex >= 0 && currentIndex < lessonCount - 1
      ? ordered[currentIndex + 1].id
      : null,
    next_lesson_id: nextOpenLessonId(data, currentId),
  };
}

/**
 * The lesson a returning user should continue with: the one they were last
 * in when it still has work left, otherwise the first lesson with work left,
 * otherwise the first lesson.
 *
 * @param {ProjectData} data
 * @param {string | null} [lastId]
 * @returns {string | null}
 */
export function resumeLessonId(data, lastId = null) {
  const ordered = arrayOf(data, "content_items")
    .filter((item) => !item.archived)
    .sort(compareLessons(data));
  if (ordered.length === 0) return null;
  if (lastId) {
    const last = ordered.find((item) => item.id === lastId);
    if (last && !lessonProgress(data, last.id).complete) return last.id;
  }
  const open = ordered.find((item) =>
    !lessonProgress(data, item.id).complete
  );
  if (open) return open.id;
  if (lastId && ordered.some((item) => item.id === lastId)) return lastId;
  return ordered[0].id;
}

/**
 * @param {ProjectData} data
 * @param {string | null} [currentId]
 * @returns {string | null}
 */
export function nextOpenLessonId(data, currentId = null) {
  const ordered = arrayOf(data, "content_items")
    .filter((item) => !item.archived)
    .sort(compareLessons(data));
  const index = ordered.findIndex((item) => item.id === currentId);
  const after = index >= 0 ? ordered.slice(index + 1) : ordered;
  const candidate = after.find((item) =>
    !lessonProgress(data, item.id).complete
  );
  if (candidate) return candidate.id;
  return after.length > 0 ? after[0].id : null;
}

/** @param {ProjectData} data */
function compareLessons(data) {
  const stageOrder = new Map(
    arrayOf(data, "stages").map((stage) => [stage.id, stage.order_index ?? 0]),
  );
  return (/** @type {ContentItem} */ left, /** @type {ContentItem} */ right) =>
    (stageOrder.get(left.stage_id || "") ?? 1e9) -
      (stageOrder.get(right.stage_id || "") ?? 1e9) ||
    (left.order_index ?? 0) - (right.order_index ?? 0) ||
    String(left.code).localeCompare(String(right.code));
}

/**
 * @param {ProjectData} data
 * @returns {ContentItem | null}
 */
export function firstLesson(data) {
  return arrayOf(data, "content_items")
    .filter((item) => !item.archived)
    .sort(compareLessons(data))[0] || null;
}

/**
 * Requirements across the whole course, grouped for the backlog view.  The
 * course map uses the counts; the single-lesson panel uses the same objects.
 *
 * @param {ProjectData} data
 * @param {{ includeResolved?: boolean, contentItemId?: string | null }} [options]
 */
export function requirementBacklog(data, options = {}) {
  const includeResolved = options.includeResolved === true;
  const items = new Map(
    arrayOf(data, "content_items").map((item) => [item.id, item]),
  );
  const entries = arrayOf(data, "requirements")
    .filter((requirement) =>
      includeResolved || requirement.status === "open"
    )
    .filter((requirement) =>
      !options.contentItemId ||
      requirement.content_item_id === options.contentItemId
    )
    .map((requirement) => {
      const item = items.get(requirement.content_item_id);
      const block = requirement.anchor_block_id
        ? arrayOf(data, "blocks").find((candidate) =>
          candidate.id === requirement.anchor_block_id
        )
        : null;
      return {
        ...requirement,
        lesson_id: requirement.content_item_id,
        lesson_code: item ? item.code : "",
        lesson_title: item ? item.title : "未知内容",
        anchor_text: block ? blockSummary(block) : "",
        anchor_type: block ? block.type : "",
      };
    })
    .sort((left, right) =>
      String(left.lesson_code).localeCompare(String(right.lesson_code)) ||
      (left.created_at || "").localeCompare(right.created_at || "")
    );
  const byLesson = new Map();
  for (const entry of entries) {
    const list = byLesson.get(entry.lesson_id) || [];
    list.push(entry);
    byLesson.set(entry.lesson_id, list);
  }
  return { entries, by_lesson: byLesson, total: entries.length };
}

/**
 * @param {ProjectData} data
 * @param {string | null | undefined} contentItemId
 * @param {string} dimensionKey
 * @param {string} optionName
 * @returns {string | null} the canonical option id for that display name
 */
export function statusOptionId(data, contentItemId, dimensionKey, optionName) {
  const item = arrayOf(data, "content_items").find((candidate) =>
    candidate.id === contentItemId
  );
  const dimension = arrayOf(data, "status_dimensions").find((candidate) =>
    candidate.key === dimensionKey &&
    (!item || !candidate.project_id || candidate.project_id === item.project_id)
  );
  if (!dimension) return null;
  const option = arrayOf(data, "status_options").find((candidate) =>
    candidate.dimension_id === dimension.id && candidate.name === optionName
  );
  return option ? option.id : null;
}

/**
 * Human sentence for the status bar and the course map badge.
 *
 * @param {ReturnType<typeof lessonProgress>} progress
 */
export function completionSentence(progress) {
  if (progress.complete) return "这一课已经完成";
  if (progress.reasons.length === 0) return "还不能判断完成状态";
  return `还差 ${progress.reasons.length} 项：${progress.reasons[0]}`;
}

/**
 * @param {ReturnType<typeof lessonSummary>} lesson
 * @returns {string}
 */
export function nextStepLabel(lesson) {
  const progress = lesson.progress;
  for (const key of progress.unfinished_dimensions) {
    if (key === "content" && lesson.block_count === 0) {
      return NEXT_STEP_LABELS.start ?? "开始第一段正文";
    }
    const label = NEXT_STEP_LABELS[key];
    if (label) return label;
  }
  if (progress.open_requirements > 0) {
    return NEXT_STEP_LABELS.media ?? "补素材";
  }
  if (!progress.has_layout) return NEXT_STEP_LABELS.layout ?? "安排排版";
  return NEXT_STEP_LABELS.review ?? "等待审核";
}

/**
 * @param {ProjectData} data
 * @param {string} contentItemId
 * @returns {Asset[]}
 */
export function lessonAssets(data, contentItemId) {
  const ids = new Set(
    arrayOf(data, "asset_usages")
      .filter((usage) => usage.content_item_id === contentItemId)
      .map((usage) => usage.asset_id),
  );
  for (const block of blocksFor(data, contentItemId)) {
    const asset = assetForBlock(data, block);
    if (asset) ids.add(asset.id);
  }
  return arrayOf(data, "assets").filter((asset) => ids.has(asset.id));
}

/**
 * Convert a canonical placement into 1-based CSS grid lines.  Grid coordinates
 * stay canonical in the Placement row; this is display-only arithmetic.
 *
 * @param {Placement} placement
 * @param {import("../src/domain/types.ts").JsonObject} grid
 * @returns {{ row: string, column: string }}
 */
export function placementGrid(placement, grid) {
  const rows = Array.isArray(grid.rows) ? grid.rows.length : 1;
  const columns = Array.isArray(grid.columns) ? grid.columns.length : 1;
  const rowStart = Math.max(0, Math.min(rows - 1, placement.row_start));
  const rowEnd = Math.max(rowStart + 1, Math.min(rows, placement.row_end));
  const columnStart = Math.max(0, Math.min(columns - 1, placement.column_start));
  const columnEnd = Math.max(
    columnStart + 1,
    Math.min(columns, placement.column_end),
  );
  return {
    row: `${rowStart + 1}/${rowEnd + 1}`,
    column: `${columnStart + 1}/${columnEnd + 1}`,
  };
}

/**
 * Deterministic export/preview parity check used by tests and the preflight
 * panel: the preview must read exactly the blocks the export reads.
 *
 * @param {ProjectData} data
 * @param {string} contentItemId
 * @returns {string[]}
 */
export function previewBlockIds(data, contentItemId) {
  return blocksFor(data, contentItemId).map((block) => block.id);
}
