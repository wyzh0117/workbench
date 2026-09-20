import {
  type BlueprintDraft,
  type BlueprintNode,
  type ContentItemType,
  type CourseSeed,
  type CourseSeedSourceType,
  CURRENT_SCHEMA_VERSION,
  type ProjectData,
} from "./types.ts";
import { assert, id, now } from "./util.ts";
import { touchProject } from "./store.ts";
import { createDocument } from "./document.ts";
import { initializeContentStatuses } from "./status.ts";

export interface CourseSeedInput {
  source_type: CourseSeedSourceType;
  raw_text?: string | null;
  source_files?: CourseSeed["source_files"];
  metadata?: CourseSeed["metadata"];
}

export interface BlueprintNodeInput {
  node_type: "stage" | "content";
  title: string;
  suggested_type?: ContentItemType;
  parent_index?: number | null;
}

export const DEFAULT_CONTENT_TYPE: ContentItemType = "lesson";

export function createCourseSeed(
  data: ProjectData,
  input: CourseSeedInput,
): CourseSeed {
  const seed: CourseSeed = {
    id: id(),
    project_id: null,
    source_type: input.source_type,
    raw_text: input.raw_text ?? null,
    source_files: input.source_files ?? [],
    metadata: input.metadata ?? {},
    created_at: now(),
  };
  data.course_seeds.push(seed);
  touchProject(data);
  return seed;
}

function contentTypeFor(title: string): ContentItemType {
  const normalized = title.toLowerCase();
  if (/练习|exercise/.test(normalized)) return "exercise";
  if (/案例|case/.test(normalized)) return "case";
  if (/总结|summary/.test(normalized)) return "summary";
  if (/测验|考试|assessment/.test(normalized)) return "assessment";
  if (/参考|reference/.test(normalized)) return "reference";
  return DEFAULT_CONTENT_TYPE;
}

function linesToBlueprintNodes(rawText: string | null): BlueprintNodeInput[] {
  const lines = (rawText ?? "").split(/\r?\n/).map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return [
      { node_type: "stage", title: "开始", suggested_type: "stage_intro" },
      {
        node_type: "content",
        title: "第一课",
        suggested_type: DEFAULT_CONTENT_TYPE,
        parent_index: 0,
      },
    ];
  }

  const nodes: BlueprintNodeInput[] = [];
  let currentStageIndex: number | null = null;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6}|\d+[.)])\s*(.+)$/);
    if (heading) {
      currentStageIndex = nodes.length;
      nodes.push({
        node_type: "stage",
        title: (heading[2] ?? "").trim(),
        suggested_type: "stage_intro",
      });
      continue;
    }
    if (currentStageIndex === null) {
      currentStageIndex = nodes.length;
      nodes.push({
        node_type: "stage",
        title: "课程内容",
        suggested_type: "stage_intro",
      });
    }
    nodes.push({
      node_type: "content",
      title: line.replace(/^[-*+]\s*/, "").trim(),
      suggested_type: contentTypeFor(line),
      parent_index: currentStageIndex,
    });
  }
  return nodes;
}

export function buildBlueprintDraft(
  data: ProjectData,
  courseSeedId: string,
  explicitNodes?: BlueprintNodeInput[],
): BlueprintDraft {
  const seed = data.course_seeds.find((item) => item.id === courseSeedId);
  assert(seed, `找不到课程输入: ${courseSeedId}`);
  const titleFromMetadata = typeof seed.metadata.title === "string"
    ? seed.metadata.title
    : "";
  const title = titleFromMetadata || firstMeaningfulLine(seed.raw_text) ||
    "未命名课程";
  const draft: BlueprintDraft = {
    id: id(),
    course_seed_id: seed.id,
    title,
    status: "draft",
    created_at: now(),
    confirmed_at: null,
  };
  data.blueprint_drafts.push(draft);

  const inputs = explicitNodes ?? linesToBlueprintNodes(seed.raw_text);
  const nodeIds: string[] = [];
  inputs.forEach((input, index) => {
    const parent_id = input.parent_index == null
      ? null
      : nodeIds[input.parent_index] ?? null;
    const node: BlueprintNode = {
      id: id(),
      blueprint_id: draft.id,
      parent_id,
      node_type: input.node_type,
      title: input.title,
      suggested_type: input.suggested_type ??
        (input.node_type === "stage" ? "stage_intro" : DEFAULT_CONTENT_TYPE),
      order_index: index,
    };
    data.blueprint_nodes.push(node);
    nodeIds.push(node.id);
  });
  touchProject(data);
  return draft;
}

function firstMeaningfulLine(rawText: string | null): string {
  return (rawText ?? "").split(/\r?\n/).map((line) =>
    line.replace(/^#+\s*/, "").trim()
  ).find(Boolean) ?? "";
}

/**
 * Persist the confirmed map only at this explicit boundary. A draft has no
 * formal Stage/ContentItem rows until this function is called.
 */
export function confirmBlueprint(data: ProjectData, draftId: string): string {
  const draft = data.blueprint_drafts.find((item) => item.id === draftId);
  assert(draft, `找不到课程草稿: ${draftId}`);
  assert(draft.status === "draft", "只有待确认的课程草稿可以创建课程");
  const seed = data.course_seeds.find((item) =>
    item.id === draft.course_seed_id
  );
  assert(seed, `找不到课程输入: ${draft.course_seed_id}`);
  assert(seed.project_id === null, "课程输入已经确认过，不能重复创建课程");

  const project = data.project;
  project.title = draft.title;
  project.schema_version = CURRENT_SCHEMA_VERSION;
  seed.project_id = project.id;
  const nodes = data.blueprint_nodes.filter((node) =>
    node.blueprint_id === draft.id
  ).sort((a, b) => a.order_index - b.order_index);
  const stageIds = new Map<string, string>();
  let stageOrder = 0;
  const contentOrderByStage = new Map<string, number>();

  const stageNodes = nodes.filter((node) => node.node_type === "stage");
  for (const node of stageNodes) {
    const stageId = id();
    stageIds.set(node.id, stageId);
    data.stages.push({
      id: stageId,
      project_id: project.id,
      parent_stage_id: null,
      code: `S${String(stageOrder + 1).padStart(2, "0")}`,
      title: node.title,
      description: "",
      learning_action: "",
      order_index: stageOrder,
      archived: false,
      created_at: now(),
      updated_at: now(),
    });
    stageOrder += 1;
    contentOrderByStage.set(stageId, 0);
  }

  // Resolve parent links after every stage has an ID. Users may reorder the
  // map so a child can appear before its parent in the draft list.
  for (const node of stageNodes) {
    const stageId = stageIds.get(node.id);
    const stage = data.stages.find((item) => item.id === stageId);
    if (stage) {
      stage.parent_stage_id = node.parent_id
        ? stageIds.get(node.parent_id) ?? null
        : null;
    }
  }

  for (const node of nodes) {
    if (node.node_type !== "content") continue;
    const stageId = node.parent_id
      ? stageIds.get(node.parent_id) ?? null
      : null;
    const stage = data.stages.find((item) => item.id === stageId);
    const contentOrder = stageId
      ? contentOrderByStage.get(stageId) ?? 0
      : data.content_items.length;
    const contentId = id();
    const document = createDocument(data, contentId);
    data.content_items.push({
      id: contentId,
      project_id: project.id,
      stage_id: stageId,
      code: stage
        ? `${stage.code}-${String(contentOrder + 1).padStart(2, "0")}`
        : `C${String(contentOrder + 1).padStart(2, "0")}`,
      title: node.title,
      type: node.suggested_type === "stage_intro"
        ? DEFAULT_CONTENT_TYPE
        : node.suggested_type,
      description: "",
      order_index: contentOrder,
      document_id: document.id,
      archived: false,
      created_at: now(),
      updated_at: now(),
    });
    initializeContentStatuses(data, contentId);
    if (stageId) contentOrderByStage.set(stageId, contentOrder + 1);
  }

  draft.status = "confirmed";
  draft.confirmed_at = now();
  touchProject(data);
  return project.id;
}

export function discardBlueprint(data: ProjectData, draftId: string): void {
  const draft = data.blueprint_drafts.find((item) => item.id === draftId);
  assert(draft, `找不到课程草稿: ${draftId}`);
  assert(draft.status === "draft", "只能放弃待确认的课程草稿");
  draft.status = "discarded";
  touchProject(data);
}
