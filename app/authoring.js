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

/**
 * The nine course-input sources the schema defines (`course_seeds.source_type`).
 * The launcher's "你现在有什么？" entries are these, so a chip can never claim a
 * capability the Domain does not have.
 */
export const SEED_SOURCE_TYPES = [
  "overview",
  "outline",
  "toc",
  "articles",
  "folder",
  "spreadsheet",
  "conversations",
  "wizard",
  "blank",
];

/** Which of them can be turned into a course map from pasted text. */
export const SEED_TEXT_SOURCES = [
  "overview",
  "outline",
  "toc",
  "articles",
  "spreadsheet",
  "conversations",
];

/** @type {Record<string, { label: string, hint: string, placeholder: string }>} */
export const SEED_SOURCE_HINTS = {
  overview: {
    label: "课程概论",
    hint: "先写清楚这门课要讲什么；每个换行会成为一节课。想让某一行成为阶段，用「#」或「1.」开头。",
    placeholder: "例如：这是一门给新同事看的入职课程，先讲公司怎么运转，再讲日常工具……\n# 第一阶段 入门\n第一课 认识界面",
  },
  outline: {
    label: "课程大纲",
    hint: "粗纲就够：用「#」或「1.」开头的行是阶段，其余每行是一节课。",
    placeholder: "# 第一阶段 入门\n第一课 认识界面\n第二课 第一个作品\n# 第二阶段 进阶",
  },
  toc: {
    label: "教材目录",
    hint: "把教材目录整段粘进来即可；章节行用「#」或「1.」开头会变成阶段，其余行成为课。",
    placeholder: "# 第一章 认识 AI\n第一节 它和过去的工具哪里不同\n第二节 什么值得交给 AI",
  },
  articles: {
    label: "已有文章",
    hint: "粘贴文章标题或正文，一行一篇会拆成多课；阶段行请用「#」或「1.」开头。",
    placeholder: "如何写好开场\n怎么讲清一个概念\n练习题怎么设计",
  },
  folder: {
    label: "资料文件夹",
    hint: "导入文件夹还没有实现；先把目录里的文件名粘贴到「教材目录」里。",
    placeholder: "",
  },
  spreadsheet: {
    label: "表格",
    hint: "从表格里复制一列课名粘贴进来，一行一课；阶段行请用「#」或「1.」开头。",
    placeholder: "第一课……\n第二课……",
  },
  conversations: {
    label: "AI 对话",
    hint: "把和 AI 聊出来的结构粘贴进来，和课程大纲一样按行拆分：用「#」或「1.」开头的行是阶段。",
    placeholder: "粘贴对话里那段课程结构……\n# 第一阶段 入门\n第一课 认识界面",
  },
  wizard: {
    label: "一步步创建",
    hint: "先建空课程，在课程地图里一课一课加。",
    placeholder: "",
  },
  blank: {
    label: "空白课程",
    hint: "完全空白开始。",
    placeholder: "",
  },
};

/**
 * The Requirement types the Domain supports.  This mirrors
 * `ENUMS.requirement_type` in `src/domain/store.ts` (canonical validation
 * rejects anything else) and is the one list every surface reads, so the
 * properties panel, the 待补 backlog, the course map and the AI draft
 * validator cannot drift from each other.
 */
export const REQUIREMENT_TYPES = [
  "text",
  "image",
  "gif",
  "video",
  "audio",
  "table",
  "chart",
  "quote",
  "case",
  "link",
  "data",
  "other",
];

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
 * Block sizing, the second implementation's height system (P2-2).
 *
 * A block frame is the only size container: it grows with its content up to a
 * tier ceiling, and past that ceiling the frame itself scrolls.  There is no
 * manual resize and no second scroll box inside the frame, so the tier is a
 * pure function of the block's type and text — which is also why it can be
 * tested without a layout engine.
 */
export const SHORT_BLOCK_TYPES = [
  "heading",
  "quote",
  "callout",
  "divider",
  "placeholder",
];
export const LONG_BLOCK_TYPES = ["paragraph", "code", "list", "exercise"];
/**
 * Ceilings: short blocks stop at Medium, long blocks stop at Large.
 * @type {{ short: "medium" | "large", long: "medium" | "large" }}
 */
export const BLOCK_SIZE_CEILING = { short: "medium", long: "large" };
/**
 * Default tier before any content arrives.
 * @type {{ short: "small" | "medium" | "large", long: "small" | "medium" | "large" }}
 */
export const BLOCK_SIZE_BASE = {
  short: "small",
  long: "medium",
};
/**
 * Lines a block can show before it steps up a tier.  A "line" is either a hard
 * newline or roughly one wrapped line of the writing column.
 */
/** @type {{ short: number, long: number }} */
export const BLOCK_TIER_LINES = { short: 2, long: 6 };
/** Characters that still fit on one wrapped line of the writing column. */
export const BLOCK_LINE_CHARS = 34;

/**
 * Short blocks (a heading, a quote) and long blocks (body text, code) grow
 * differently: a heading may only ever become Medium, body text may only ever
 * shrink back to Medium.
 *
 * @param {string} type
 * @returns {"short" | "long"}
 */
export function blockSizeKind(type) {
  return LONG_BLOCK_TYPES.includes(String(type)) ? "long" : "short";
}

/**
 * How many display lines a block's text needs, without touching the DOM.
 *
 * @param {unknown} text
 * @returns {number}
 */
export function estimateBlockLines(text) {
  const raw = typeof text === "string" ? text : textOf(text);
  if (!raw) return 1;
  const hard = raw.split("\n").length;
  const wrapped = Math.ceil(raw.length / BLOCK_LINE_CHARS);
  return Math.max(1, hard, wrapped);
}

/**
 * The tier a block's frame should use right now.  Monotonic in the amount of
 * content: growth steps up, shrinking steps back down, and the ceiling holds.
 *
 * @param {string} type
 * @param {unknown} text
 * @returns {"small" | "medium" | "large"}
 */
export function blockSizeTier(type, text) {
  return blockSizeTierForLines(blockSizeKind(type), estimateBlockLines(text));
}

/**
 * The same rule, expressed in measured lines.  The editor knows the real line
 * count once the field is laid out, so live typing uses this instead of the
 * text-length estimate and both paths stay on one rule.
 *
 * @param {"short" | "long"} kind
 * @param {number} lines
 * @returns {"small" | "medium" | "large"}
 */
export function blockSizeTierForLines(kind, lines) {
  const count = Number.isFinite(lines) ? Number(lines) : 0;
  /** @type {"small" | "medium" | "large"} */
  const tier = count > BLOCK_TIER_LINES[kind]
    ? grownTier(kind)
    : BLOCK_SIZE_BASE[kind];
  return tier;
}

/**
 * The tier a block reaches once its content outgrows the first step.
 *
 * @param {"short" | "long"} kind
 * @returns {"medium" | "large"}
 */
export function grownTier(kind) {
  return kind === "long" ? "large" : "medium";
}

/**
 * Everything the block frame needs for sizing, derived from the block itself.
 *
 * @param {{ type: string, text?: unknown } | null | undefined} block
 * @returns {{ kind: "short" | "long", tier: "small" | "medium" | "large", lines: number, ceiling: string }}
 */
export function blockSizeView(block) {
  const type = block ? String(block.type) : "paragraph";
  const text = block ? block.text : "";
  const kind = blockSizeKind(type);
  return {
    kind,
    tier: blockSizeTier(type, text),
    lines: estimateBlockLines(text),
    ceiling: BLOCK_SIZE_CEILING[kind],
  };
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
  const text = textOf(block.content);
  return {
    id: block.id,
    type: block.type,
    order_index: block.order_index ?? 0,
    label: blockLabel(block.type),
    text,
    summary: blockSummary(block, asset),
    level: typeof (block.settings || {}).level === "number"
      ? Number(block.settings.level)
      : 2,
    settings: block.settings || {},
    media,
    asset,
    /** P2-2: the frame's tier, derived from this block's own text. */
    size: blockSizeView({ type: block.type, text }),
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
 * Every cell of a grid, in reading order.
 *
 * @param {import("../src/domain/types.ts").JsonObject} grid
 * @returns {Array<{ row: number, column: number }>}
 */
export function gridCells(grid) {
  const rows = Math.max(1, Array.isArray(grid.rows) ? grid.rows.length : 1);
  const columns = Math.max(1, Array.isArray(grid.columns) ? grid.columns.length : 1);
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) cells.push({ row, column });
  }
  return cells;
}

/**
 * Cells already occupied by placements, as `row:column` keys.  `exceptId`
 * leaves one placement out, so a block being moved never blocks itself.
 *
 * @param {Array<{ id?: string, row_start: number, row_end: number, column_start: number, column_end: number }>} placements
 * @param {string | null} [exceptId]
 * @returns {Set<string>}
 */
export function occupiedCells(placements, exceptId = null) {
  const taken = new Set();
  for (const placement of placements || []) {
    if (exceptId && placement.id === exceptId) continue;
    for (let row = placement.row_start; row < placement.row_end; row += 1) {
      for (let column = placement.column_start; column < placement.column_end; column += 1) {
        taken.add(`${row}:${column}`);
      }
    }
  }
  return taken;
}

/**
 * The cells a block of the given span can be dropped into right now, in
 * reading order.  This is what highlights "可放置 Cell" during a move and what
 * the store validates against, so the highlight and the write can never
 * disagree.
 *
 * @param {import("../src/domain/types.ts").JsonObject} grid
 * @param {Array<{ id?: string, row_start: number, row_end: number, column_start: number, column_end: number }>} placements
 * @param {{ rowSpan?: number, columnSpan?: number, exceptId?: string | null }} [options]
 * @returns {Array<{ row: number, column: number }>}
 */
export function freeCellsFor(grid, placements, options = {}) {
  const rows = Math.max(1, Array.isArray(grid.rows) ? grid.rows.length : 1);
  const columns = Math.max(1, Array.isArray(grid.columns) ? grid.columns.length : 1);
  const rowSpan = Math.max(1, Math.min(rows, Number(options.rowSpan) || 1));
  const columnSpan = Math.max(1, Math.min(columns, Number(options.columnSpan) || 1));
  const taken = occupiedCells(placements, options.exceptId ?? null);
  const free = [];
  for (const cell of gridCells(grid)) {
    if (cell.row + rowSpan > rows || cell.column + columnSpan > columns) continue;
    let fits = true;
    for (let row = cell.row; row < cell.row + rowSpan && fits; row += 1) {
      for (let column = cell.column; column < cell.column + columnSpan; column += 1) {
        if (taken.has(`${row}:${column}`)) { fits = false; break; }
      }
    }
    if (fits) free.push(cell);
  }
  return free;
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
