import type { Block, JsonValue, ProjectData } from "./types.ts";
import { deriveGaps } from "./requirements.ts";
import { getStatusViews } from "./status.ts";
import { listBlocks } from "./document.ts";

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
      const gaps = deriveGaps(data, item.id);
      const status = getStatusViews(data, item.id).find((view) =>
        view.dimension_key === "content"
      );
      const suffix = gaps.total_open ? `｜待补 ${gaps.total_open}` : "｜待补 0";
      lines.push(
        `- ${item.code}｜${item.title}｜正文：${
          status?.option_name ?? "未设置"
        }${suffix}`,
      );
    }
    lines.push("");
  }
  const unassigned = data.content_items
    .filter((item) => item.stage_id === null && !item.archived)
    .sort((a, b) => a.order_index - b.order_index);
  if (unassigned.length > 0) {
    lines.push("## 未分组");
    for (const item of unassigned) {
      const gaps = deriveGaps(data, item.id);
      const status = getStatusViews(data, item.id).find((view) =>
        view.dimension_key === "content"
      );
      const suffix = gaps.total_open ? `｜待补 ${gaps.total_open}` : "｜待补 0";
      lines.push(
        `- ${item.code}｜${item.title}｜正文：${
          status?.option_name ?? "未设置"
        }${suffix}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
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
