import type { Block, ContentItem, JsonValue, ProjectData } from "./types.ts";
import { deriveGaps } from "./requirements.ts";
import { getStatusViews } from "./status.ts";
import { listBlocks } from "./document.ts";

/** Status dimensions that decide whether a lesson is finished. */
export const COMPLETION_DIMENSION_KEYS = [
  "content",
  "media",
  "layout",
  "review",
] as const;

const FALLBACK_DIMENSION_LABELS: Record<string, string> = {
  content: "正文",
  media: "媒体",
  layout: "排版",
  review: "审核",
  publish: "发布",
  update: "更新",
};

export interface LessonDimensionState {
  key: string;
  label: string;
  option: string;
  terminal: boolean;
}

export interface LessonProgress {
  content_item_id: string;
  complete: boolean;
  reasons: string[];
  percentage: number;
  block_count: number;
  empty_text_blocks: number;
  placeholders: number;
  open_requirements: number;
  missing_media: number;
  has_layout: boolean;
  content_dimension: string;
  dimensions: LessonDimensionState[];
}

/**
 * Derived lesson state.  This is the single answer to "is this lesson done and
 * what is left"; it is computed from canonical rows and never persisted, so a
 * second completion model cannot appear in a cache or a UI variable.
 */
export function lessonProgress(
  data: ProjectData,
  contentItemId: string,
): LessonProgress {
  const blocks = data.blocks
    .filter((block) =>
      data.documents.some((document) =>
        document.id === block.document_id &&
        document.content_item_id === contentItemId
      )
    )
    .sort((left, right) => left.order_index - right.order_index);
  const gaps = deriveGaps(data, contentItemId);
  const textBlocks = blocks.filter((block) =>
    block.type !== "placeholder" &&
    [
      "heading",
      "paragraph",
      "quote",
      "code",
      "callout",
      "exercise",
      "table",
      "chart",
    ].includes(block.type)
  );
  const emptyTextBlocks = textBlocks.filter((block) => {
    const value = block.content;
    return typeof value === "string"
      ? value.trim().length === 0
      : value === null || value === undefined;
  }).length;
  const placeholders = blocks.filter((block) =>
    block.type === "placeholder"
  ).length;
  const viewKeys = [
    ...COMPLETION_DIMENSION_KEYS,
    "publish",
    "update",
  ] as const;
  const dimensionByKey = new Map(
    data.status_dimensions.map((dimension) => [dimension.key, dimension]),
  );
  const dimensions: LessonDimensionState[] = viewKeys.map((key) => {
    const dimension = dimensionByKey.get(key);
    const assignment = data.status_assignments.find((candidate) =>
      candidate.content_item_id === contentItemId &&
      candidate.dimension_id === dimension?.id
    );
    const option = assignment
      ? data.status_options.find((candidate) =>
        candidate.id === assignment.option_id
      )
      : undefined;
    return {
      key,
      label: dimension?.name ?? FALLBACK_DIMENSION_LABELS[key] ?? key,
      option: option?.name ?? "",
      terminal: option?.is_terminal === true,
    };
  });
  const hasLayout = data.layout_instances.some((layout) =>
    layout.content_item_id === contentItemId
  );
  const mediaBlocks = blocks.filter((block) =>
    ["image", "gif", "video", "audio"].includes(block.type)
  );
  const missingMedia = mediaBlocks.filter((block) => {
    const linked = block.settings.asset_id;
    if (typeof linked === "string" && linked) {
      const asset = data.assets.find((candidate) => candidate.id === linked);
      return !asset || asset.archived;
    }
    return true;
  }).length;
  const unfinished = dimensions.filter((dimension) =>
    (COMPLETION_DIMENSION_KEYS as readonly string[]).includes(dimension.key) &&
    !dimension.terminal
  );
  const reasons: string[] = [];
  if (blocks.length === 0) reasons.push("还没有任何正文");
  if (emptyTextBlocks > 0) reasons.push(`${emptyTextBlocks} 段正文是空的`);
  if (placeholders > 0) reasons.push(`${placeholders} 处占位符没有替换`);
  if (gaps.by_scope.content > 0) {
    reasons.push(`文字类待补 ${gaps.by_scope.content} 项未完成`);
  }
  if (missingMedia > 0) reasons.push(`图片类待补 ${missingMedia} 项未完成`);
  if (!hasLayout) reasons.push("还没有排版版本");
  for (const dimension of unfinished) {
    reasons.push(
      `${dimension.label}仍是「${dimension.option || "未设置"}」`,
    );
  }
  const denominator = blocks.length + gaps.by_scope.content +
    gaps.by_scope.layout + 2;
  const numerator = blocks.length - emptyTextBlocks - placeholders +
    (gaps.by_scope.content + gaps.by_scope.layout === 0 ? 2 : 0) +
    (hasLayout ? 1 : 0);
  return {
    content_item_id: contentItemId,
    complete: reasons.length === 0,
    reasons,
    percentage: denominator === 0
      ? 0
      : Math.max(
        0,
        Math.min(100, Math.round((numerator / denominator) * 100)),
      ),
    block_count: blocks.length,
    empty_text_blocks: emptyTextBlocks,
    placeholders,
    open_requirements: gaps.total_open,
    missing_media: missingMedia,
    has_layout: hasLayout,
    content_dimension: dimensions.find((dimension) =>
      dimension.key === "content"
    )?.option ?? "",
    dimensions,
  };
}

export interface CourseMapLesson {
  id: string;
  code: string;
  title: string;
  type: ContentItem["type"];
  summary: string;
  progress: LessonProgress;
  current: boolean;
}

export interface CourseMapStage {
  id: string;
  code: string;
  title: string;
  lessons: CourseMapLesson[];
  complete_count: number;
  open_requirements: number;
  current: boolean;
}

export interface CourseMapView {
  project_title: string;
  stages: CourseMapStage[];
  lessons: CourseMapLesson[];
  complete_count: number;
  open_requirements: number;
  current_index: number;
  previous_id: string | null;
  next_id: string | null;
}

function lessonSummaryLine(data: ProjectData, item: ContentItem): string {
  const blocks = data.blocks.filter((block) =>
    block.document_id === item.document_id
  ).sort((left, right) => left.order_index - right.order_index);
  const prose = blocks.find((block) =>
    typeof block.content === "string" && block.content.trim().length > 0 &&
    block.type !== "placeholder"
  );
  if (prose && typeof prose.content === "string") {
    const text = prose.content.replace(/\s+/g, " ").trim();
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  }
  if (blocks.some((block) => block.type === "placeholder")) return "只有占位符";
  if (blocks.length > 0) return "还没有正文";
  return "空课";
}

/**
 * The course map as a derived view: navigation centre plus progress entry
 * point.  `currentId` only marks a position and is never written back.
 */
export function buildCourseMap(
  data: ProjectData,
  currentId: string | null = null,
): CourseMapView {
  const items = data.content_items.filter((item) => !item.archived);
  const stageOrder = new Map(
    data.stages.map((stage) => [stage.id, stage.order_index]),
  );
  const ordered = [...items].sort((left, right) =>
    (stageOrder.get(left.stage_id ?? "") ?? Number.MAX_SAFE_INTEGER) -
      (stageOrder.get(right.stage_id ?? "") ?? Number.MAX_SAFE_INTEGER) ||
    left.order_index - right.order_index ||
    left.code.localeCompare(right.code)
  );
  const toLesson = (item: ContentItem): CourseMapLesson => ({
    id: item.id,
    code: item.code,
    title: item.title,
    type: item.type,
    summary: lessonSummaryLine(data, item),
    progress: lessonProgress(data, item.id),
    current: item.id === currentId,
  });
  const stages: CourseMapStage[] = [...data.stages]
    .filter((stage) => !stage.archived)
    .sort((left, right) => left.order_index - right.order_index)
    .map((stage) => {
      const lessons = ordered
        .filter((item) => item.stage_id === stage.id)
        .map(toLesson);
      return {
        id: stage.id,
        code: stage.code,
        title: stage.title,
        lessons,
        complete_count: lessons.filter((lesson) => lesson.progress.complete)
          .length,
        open_requirements: lessons.reduce((sum, lesson) =>
          sum + lesson.progress.open_requirements, 0),
        current: lessons.some((lesson) => lesson.current),
      };
    });
  const unassigned = ordered.filter((item) => item.stage_id === null);
  if (unassigned.length > 0) {
    const lessons = unassigned.map(toLesson);
    stages.push({
      id: "",
      code: "—",
      title: "未分组",
      lessons,
      complete_count: lessons.filter((lesson) => lesson.progress.complete)
        .length,
      open_requirements: lessons.reduce((sum, lesson) =>
        sum + lesson.progress.open_requirements, 0),
      current: lessons.some((lesson) => lesson.current),
    });
  }
  const lessons = stages.flatMap((stage) => stage.lessons);
  const currentIndex = lessons.findIndex((lesson) => lesson.current);
  return {
    project_title: data.project.title,
    stages,
    lessons,
    complete_count: lessons.filter((lesson) => lesson.progress.complete).length,
    open_requirements: lessons.reduce((sum, lesson) =>
      sum + lesson.progress.open_requirements, 0),
    current_index: currentIndex,
    previous_id: currentIndex > 0 ? lessons[currentIndex - 1]!.id : null,
    next_id: currentIndex >= 0 && currentIndex < lessons.length - 1
      ? lessons[currentIndex + 1]!.id
      : null,
  };
}

function asText(content: JsonValue): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

function blockMarkdown(block: Block): string {
  const content = asText(block.content);
  switch (block.type) {
    case "heading": {
      const level = typeof block.settings.level === "number"
        ? Math.max(1, Math.min(6, block.settings.level))
        : 2;
      return `${"#".repeat(level)} ${content}`;
    }
    case "quote":
      return `> ${content}`;
    case "code":
      return `\`\`\`\n${content}\n\`\`\``;
    case "divider":
      return "---";
    case "placeholder":
      return `> 待补内容：${content}`;
    case "image":
    case "gif":
    case "video":
    case "audio":
    case "embed":
      return `[${block.type}] ${content}`;
    default:
      return content;
  }
}

export function renderDocumentMarkdown(
  data: ProjectData,
  contentItemId: string,
): string {
  const item = data.content_items.find((candidate) =>
    candidate.id === contentItemId
  );
  if (!item) throw new Error(`找不到内容: ${contentItemId}`);
  const body = listBlocks(data, contentItemId).map(blockMarkdown).filter(
    Boolean,
  ).join("\n\n");
  return `# ${item.title}\n\n${body}\n`;
}

/** COURSE_MAP is a generated view; it is never stored as canonical data. */
export function renderCourseMap(data: ProjectData): string {
  const lines = [`# ${data.project.title}`, ""];
  const stages = [...data.stages].filter((stage) => !stage.archived).sort((
    a,
    b,
  ) => a.order_index - b.order_index);
  for (const stage of stages) {
    lines.push(`## ${stage.code}｜${stage.title}`);
    const items = data.content_items
      .filter((item) => item.stage_id === stage.id && !item.archived)
      .sort((a, b) => a.order_index - b.order_index);
    for (const item of items) {
      lines.push(`- ${courseMapLessonLine(data, item)}`);
    }
    lines.push("");
  }
  const unassigned = data.content_items
    .filter((item) => item.stage_id === null && !item.archived)
    .sort((a, b) => a.order_index - b.order_index);
  if (unassigned.length > 0) {
    lines.push("## 未分组");
    for (const item of unassigned) {
      lines.push(`- ${courseMapLessonLine(data, item)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function courseMapLessonLine(data: ProjectData, item: ContentItem): string {
  const progress = lessonProgress(data, item.id);
  const gaps = deriveGaps(data, item.id);
  const byType = Object.entries(gaps.by_type)
    .map(([type, count]) => `${type}：缺 ${count}`)
    .join(" ");
  const state = progress.complete
    ? "已完成"
    : progress.reasons.length > 0
    ? progress.reasons[0]!
    : "未完成";
  return `${item.code}｜${item.title}｜正文：${
    progress.content_dimension || "未设置"
  }｜${state}${byType ? `｜${byType}` : ""}`;
}

export interface ProjectSummary {
  total_content_items: number;
  open_requirements: number;
  content_items_with_gaps: number;
  status_counts: Record<string, number>;
}

export function deriveProjectSummary(data: ProjectData): ProjectSummary {
  const status_counts: Record<string, number> = {};
  for (
    const item of data.content_items.filter((candidate) => !candidate.archived)
  ) {
    for (const status of getStatusViews(data, item.id)) {
      const key = `${status.dimension_key}:${status.option_key}`;
      status_counts[key] = (status_counts[key] ?? 0) + 1;
    }
  }
  const content_items_with_gaps =
    data.content_items.filter((item) =>
      !item.archived && deriveGaps(data, item.id).total_open > 0
    ).length;
  return {
    total_content_items:
      data.content_items.filter((item) => !item.archived).length,
    open_requirements: deriveGaps(data).total_open,
    content_items_with_gaps,
    status_counts,
  };
}
