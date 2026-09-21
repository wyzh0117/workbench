import {
  courseMap,
  gapCounts,
  lessonView,
  requirementBacklog,
  resumeLessonId,
  statusOptionId,
} from "../app/authoring.js";
import { markdownToHtml } from "../app/canvas.js";
import {
  addAsset,
  addLayoutSection,
  addPlacement,
  appendBlock,
  createEmptyProjectData,
  createLayoutInstance,
  deleteBlock,
  detachAssetFromContent,
  insertBlockAt,
  insertPlaceholder,
  removeAsset,
  resolveRequirement,
  setRequirementStatus,
  updateBlockContent,
} from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Two stages, three lessons, blocks and an asset — the authoring fixture. */
function authoringFixture(): ProjectData {
  const data = createEmptyProjectData("Course Authoring 测试");
  const projectId = data.project.id;
  const stageA = {
    id: "stage-a",
    project_id: projectId,
    parent_stage_id: null,
    code: "S01",
    title: "第一阶段",
    description: "",
    learning_action: "",
    order_index: 0,
    archived: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const stageB = { ...stageA, id: "stage-b", code: "S02", title: "第二阶段", order_index: 1 };
  data.stages.push(stageA, stageB);
  const makeLesson = (id: string, stageId: string, code: string, title: string, order: number) => {
    const documentId = `doc-${id}`;
    data.documents.push({
      id: documentId,
      content_item_id: id,
      schema_version: data.schema_version,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    data.content_items.push({
      id,
      project_id: projectId,
      stage_id: stageId,
      code,
      title,
      type: "lesson",
      description: "",
      order_index: order,
      document_id: documentId,
      archived: false,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  };
  makeLesson("lesson-1", "stage-a", "S01-01", "第一课", 0);
  makeLesson("lesson-2", "stage-a", "S01-02", "第二课", 1);
  makeLesson("lesson-3", "stage-b", "S02-01", "第三课", 0);
  appendBlock(data, "lesson-1", "heading", "开场", { level: 2 });
  appendBlock(data, "lesson-1", "paragraph", "这是第一课的正文。");
  appendBlock(data, "lesson-2", "paragraph", "第二课还没有素材。");
  return data;
}

function assetFixture(data: ProjectData, filename = "封面.png") {
  return addAsset(data, data.project.id, {
    type: "image",
    filename,
    storage_path: `assets/${filename}`,
    mime_type: "image/png",
    checksum: `checksum-${filename}`,
    file_size: 128,
  }).asset;
}

Deno.test("course map lists every lesson in reading order with derived state", () => {
  const data = authoringFixture();
  const map = courseMap(data, "lesson-2");
  assert(map.lesson_count === 3, "the map must expose all three lessons");
  assert(
    map.lessons.map((lesson) => lesson.id).join(",") ===
      "lesson-1,lesson-2,lesson-3",
    "lessons must follow stage then item order",
  );
  assert(map.sections.length === 2, "both stages must appear as sections");
  assert(map.current_index === 1, "the current lesson must be marked");
  assert(map.previous_id === "lesson-1" && map.next_id === "lesson-3", "neighbours must resolve");
  assert(
    map.lessons.every((lesson) => lesson.progress.complete === false),
    "an unfinished lesson must never report complete",
  );
  const moved = courseMap(data, null);
  assert(moved.current_index === -1, "no current lesson means no marker");
  assert(moved.next_lesson_id === "lesson-1", "the first unfinished lesson is the next action");
});

Deno.test("lesson view projects blocks, gaps and asset references from canonical data", () => {
  const data = authoringFixture();
  const asset = assetFixture(data);
  const view = lessonView(data, "lesson-1");
  assert(view && view.blocks.length === 2, "lesson one has two blocks");
  assert(view.lesson.progress.block_count === 2, "completion counts real blocks");
  assert(!view.lesson.progress.complete, "the lesson still lacks a layout");
  assert(view.lesson.progress.has_layout === false, "no layout instance exists yet");
  insertPlaceholder(data, "lesson-1", { type: "image", note: "补一张封面" });
  const withGap = lessonView(data, "lesson-1")!;
  assert(withGap.progress.open_requirements === 1, "the placeholder produces one open gap");
  assert(
    withGap.progress.reasons.some((reason) => reason.includes("待补")),
    "the reason list must name the placeholder",
  );
  const requirement = withGap.requirements[0]!;
  // Resolving through the domain links the usage; the shell also links
  // `settings.asset_id` on the anchor so preview/export can resolve it.
  resolveRequirement(data, requirement.id, asset.id);
  // The shell materialises the placeholder into the media slot it stood for.
  const anchorBlock = data.blocks.find((block) =>
    block.id === requirement.anchor_block_id
  )!;
  anchorBlock.type = "image";
  (anchorBlock.settings as Record<string, string>).asset_id = asset.id;
  // Re-read: projections are snapshots, so the editor must re-derive after a write.
  const linked = lessonView(data, "lesson-1")!;
  const resolved = lessonView(data, "lesson-1")!;
  assert(resolved.progress.open_requirements === 0, "resolving clears the gap");
  assert(
    linked.blocks.some((block) => block.asset && block.asset.id === asset.id),
    "the anchored block must resolve the asset through its canonical link",
  );
  assert(
    data.asset_usages.some((usage) =>
      usage.asset_id === asset.id && usage.role === "requirement"
    ),
    "resolving a requirement must create a real usage",
  );
});

Deno.test("completion state is derived, persistable and reflected in the course map", () => {
  const data = authoringFixture();
  const asset = assetFixture(data);
  const layout = createLayoutInstance(data, "lesson-1", {
    name: "默认网格",
    mode: "grid",
  });
  addLayoutSection(data, layout.id, { name: "第 1 段" });
  const blocks = lessonView(data, "lesson-1")!.blocks;
  addPlacement(data, layout.id, blocks[0]!.id, {
    row_start: 0,
    row_end: 1,
    column_start: 0,
    column_end: 2,
  });
  // Cover the media dimension with a real usage so every dimension is terminal.
  data.asset_usages.push({
    id: "usage-1",
    asset_id: asset.id,
    content_item_id: "lesson-1",
    block_id: blocks[1]!.id,
    layout_instance_id: null,
    role: "content",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  for (const dimension of data.status_dimensions) {
    // Terminal options decide completion, and "需修改" is intentionally not
    // the last option of the review dimension.
    const terminal = data.status_options.find((option) =>
      option.dimension_id === dimension.id && option.is_terminal
    )!;
    const existing = data.status_assignments.find((assignment) =>
      assignment.content_item_id === "lesson-1" &&
      assignment.dimension_id === dimension.id
    );
    if (existing) existing.option_id = terminal.id;
    else {
      data.status_assignments.push({
        id: `assignment-${dimension.key}`,
        content_item_id: "lesson-1",
        dimension_id: dimension.id,
        option_id: terminal.id,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
    }
  }
  const completion = lessonView(data, "lesson-1")!.progress;
  assert(completion.complete, `expected a complete lesson, reasons: ${completion.reasons.join("；")}`);
  assert(completion.percentage === 100, "a complete lesson reports full progress");
  const map = courseMap(data, "lesson-1");
  assert(map.complete_count === 1, "the map must reflect the derived completion");
  assert(map.sections[0]!.complete_count === 1, "the stage rollup must agree");
  assert(
    map.lessons.find((lesson) => lesson.id === "lesson-1")!.progress.complete,
    "the map lesson carries the same derived state",
  );
});

Deno.test("requirement backlog aggregates open work across lessons", () => {
  const data = authoringFixture();
  insertPlaceholder(data, "lesson-1", { type: "image", note: "第一课缺图" });
  insertPlaceholder(data, "lesson-3", { type: "text", note: "第三课缺文字" });
  const backlog = requirementBacklog(data);
  assert(backlog.total === 2, "both open requirements must be listed");
  assert(backlog.by_lesson.size === 2, "the backlog groups by lesson");
  const entry = backlog.entries.find((item) => item.lesson_id === "lesson-3")!;
  assert(entry.lesson_code === "S02-01", "the backlog names the lesson code");
  assert(entry.note === "第三课缺文字", "the backlog keeps the note");
  setRequirementStatus(data, entry.id, "ignored");
  assert(requirementBacklog(data).total === 1, "ignored work leaves the open backlog");
  assert(
    requirementBacklog(data, { includeResolved: true }).total === 2,
    "resolved/ignored work stays queryable",
  );
});

Deno.test("block mutations keep the document contiguous and cascade on delete", () => {
  const data = authoringFixture();
  const asset = assetFixture(data);
  const blocks = lessonView(data, "lesson-1")!.blocks;
  const startCount = blocks.length;
  const inserted = insertBlockAt(data, "lesson-1", "paragraph", "插在中间", 1);
  let ordered = lessonView(data, "lesson-1")!.blocks;
  assert(ordered.length === startCount + 1, "insert adds one block");
  assert(ordered[1]!.id === inserted.id, "insert lands at the requested index");
  assert(
    ordered.map((block) => block.order_index).join(",") === "0,1,2",
    "order_index stays contiguous after insert",
  );
  {
    const target = ordered[1]!;
    updateBlockContent(data, target.id, "改过的正文");
    assert(
      lessonView(data, "lesson-1")!.blocks[1]!.text === "改过的正文",
      "text edits are read back through the projection",
    );
    const layout = createLayoutInstance(data, "lesson-1", { name: "网格", mode: "grid" });
    addPlacement(data, layout.id, target.id, {
      row_start: 0,
      row_end: 1,
      column_start: 0,
      column_end: 1,
    });
    insertPlaceholder(data, "lesson-1", { type: "image", note: "给这一块补图" });
    const requirement = data.requirements.at(-1)!;
    const anchorId = requirement.anchor_block_id!;
    assert(anchorId !== target.id, "the placeholder is its own block, not the selected one");
    data.asset_usages.push({
      id: "usage-block",
      asset_id: asset.id,
      content_item_id: "lesson-1",
      block_id: anchorId,
      layout_instance_id: null,
      role: "content",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    assert(
      requirement.anchor_block_id === data.blocks.find((block) =>
        block.type === "placeholder"
      )!.id,
      "a content placeholder anchors its own requirement",
    );
    deleteBlock(data, requirement.anchor_block_id!);
    ordered = lessonView(data, "lesson-1")!.blocks;
    assert(
      ordered.length === startCount + 1,
      "deleting the placeholder removes exactly the placeholder block",
    );
    assert(
      ordered.map((block) => block.order_index).join(",") ===
        ordered.map((_, index) => index).join(","),
      "order_index stays contiguous after delete",
    );
    assert(
      !data.placements.some((placement) =>
        placement.block_id === requirement.anchor_block_id
      ),
      "placements pointing at the deleted block must be removed",
    );
    assert(
      data.placements.some((placement) => placement.block_id === target.id),
      "placements for surviving blocks must be preserved",
    );
    assert(
      !data.asset_usages.some((usage) => usage.block_id === anchorId),
      "asset usages pointing at the deleted block must be removed",
    );
    assert(
      !data.requirements.some((candidate) => candidate.id === requirement.id),
      "the requirement anchored to the deleted placeholder must be removed",
    );
    assert(
      data.requirements.every((candidate) =>
        data.blocks.some((block) => block.id === candidate.anchor_block_id) ||
        candidate.anchor_block_id === null
      ),
      "no requirement may keep a dangling anchor",
    );
  }
});

Deno.test("asset detach and delete keep blocks, requirements and usages consistent", () => {
  const data = authoringFixture();
  const asset = assetFixture(data);
  const block = lessonView(data, "lesson-2")!.blocks[0]!;
  insertPlaceholder(data, "lesson-2", { type: "image", note: "补图" });
  const requirement = data.requirements.at(-1)!;
  resolveRequirement(data, requirement.id, asset.id);
  assert(data.asset_usages.length === 1, "resolving creates one usage");
  const removed = detachAssetFromContent(data, asset.id, "lesson-2");
  assert(Number(removed) === 1, "detaching reports the released usage");
  assert(data.asset_usages.length as number === 0, "detaching clears the usage");
  assert(
    data.requirements.find((candidate) => candidate.id === requirement.id)!
      .status === "open",
    "detaching reopens the requirement it had resolved",
  );
  const afterDetach = lessonView(data, "lesson-2")!.blocks.find((candidate) =>
    candidate.id === block.id
  )!;
  assert(
    afterDetach.asset === null && afterDetach.asset_missing === false,
    "detaching clears the resolved asset without inventing a gap",
  );
  // Deleting must archive rather than unlink rows that would break validation.
  resolveRequirement(data, requirement.id, asset.id);
  removeAsset(data, asset.id);
  assert(asset.archived, "deleting an asset archives it");
  assert(data.asset_usages.length as number === 0, "deleting an asset releases every usage");
  assert(
    data.requirements.find((candidate) => candidate.id === requirement.id)!
      .resolved_asset_id === null,
    "deleting an asset clears requirement resolutions",
  );
  assert(
    lessonView(data, "lesson-2")!.blocks.every((candidate) => candidate.asset === null),
    "no block may keep pointing at a removed asset",
  );
});

Deno.test("flow and grid modes are canonical layout state, not UI state", () => {
  const data = authoringFixture();
  const layout = createLayoutInstance(data, "lesson-1", { name: "排版", mode: "grid" });
  const blocks = lessonView(data, "lesson-1")!.blocks;
  addPlacement(data, layout.id, blocks[0]!.id, {
    row_start: 0,
    row_end: 1,
    column_start: 0,
    column_end: 1,
  });
  assert(lessonView(data, "lesson-1")!.lesson.layout_mode === "grid", "grid mode reads from the layout");
  layout.mode = "flow";
  assert(lessonView(data, "lesson-1")!.lesson.layout_mode === "flow", "flow mode reads from the layout");
  assert(
    lessonView(data, "lesson-1")!.placements.length === 1,
    "switching modes must not drop placements",
  );
});

Deno.test("preview projection reads the same blocks the export reads", () => {
  const data = authoringFixture();
  const view = lessonView(data, "lesson-1")!;
  const ids = view.blocks.map((block) => block.id);
  const fromDomain = data.blocks
    .filter((block) => block.document_id === "doc-lesson-1")
    .sort((left, right) => left.order_index - right.order_index)
    .map((block) => block.id);
  assert(ids.join(",") === fromDomain.join(","), "preview and export share one block order");
  const html = markdownToHtml("# 标题\n\n正文 **加粗** 与 `代码`\n\n- 一\n- 二\n\n> 引用\n");
  assert(html.includes("<h1>标题</h1>"), "markdown headings render");
  assert(html.includes("<strong>加粗</strong>"), "markdown emphasis renders");
  assert(html.includes("<code>代码</code>"), "inline code renders");
  assert(html.includes("<ul>") && html.includes("<li>一</li>"), "markdown lists render");
  assert(html.includes("<blockquote>引用</blockquote>"), "markdown quotes render");
  const escaped = markdownToHtml('<img src=x onerror="alert(1)">');
  assert(!escaped.includes("<img"), "raw HTML from a bundle must be escaped");
});

Deno.test("resume picks the last lesson with work and status options resolve by name", () => {
  const data = authoringFixture();
  assert(resumeLessonId(data, null) === "lesson-1", "a fresh course resumes at the first lesson");
  assert(resumeLessonId(data, "lesson-2") === "lesson-2", "an unfinished last lesson wins");
  const block = lessonView(data, "lesson-1")!.blocks[0]!;
  insertPlaceholder(data, "lesson-1", { type: "text", note: "补文字" });
  const requirementId = data.requirements.at(-1)!.id;
  resolveRequirement(data, requirementId);
  assert(
    gapCounts(data, "lesson-1").total === 0,
    "a resolved requirement leaves the open gap count",
  );
  const optionId = statusOptionId(data, "lesson-1", "content", "已定稿");
  assert(typeof optionId === "string" && optionId.length > 0, "status options resolve by name");
  assert(
    statusOptionId(data, "lesson-1", "content", "不存在的状态") === null,
    "unknown status names must not resolve",
  );
});
