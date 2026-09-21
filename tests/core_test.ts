import {
  acceptSuggestion,
  addAsset,
  addAssetUsage,
  addPlacement,
  appendBlock,
  applyChangeDraft,
  archiveAsset,
  assignStatus,
  buildBlueprintDraft,
  confirmBlueprint,
  createContextPack,
  createCourseSeed,
  createEmptyProjectData,
  createExportPreset,
  createLayoutInstance,
  createLayoutTemplate,
  createSuggestion,
  deriveGaps,
  getStatusViews,
  insertPlaceholder,
  loadProject,
  migrateProject,
  type ProjectData,
  renderCourseMap,
  renderDocumentMarkdown,
  resolveRequirement,
  reviewChangeDraft,
  saveProject,
  serializeProject,
} from "../src/domain/index.ts";

function assert(
  condition: unknown,
  message = "expected condition to be true",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(
  actual: T,
  expected: T,
  message = "values differ",
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
}

function assertThrows(
  fn: () => unknown,
  message = "expected function to throw",
): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}

Deno.test("CourseSeed stays a draft until explicit blueprint confirmation", () => {
  const data = createEmptyProjectData();
  const seed = createCourseSeed(data, {
    source_type: "outline",
    raw_text: "# 入门\n第一课\n第二课",
  });
  const draft = buildBlueprintDraft(data, seed.id);
  assertEquals(data.stages.length, 0);
  assertEquals(data.content_items.length, 0);
  confirmBlueprint(data, draft.id);
  assertEquals(data.stages.length, 1);
  assertEquals(data.content_items.length, 2);
  assertEquals(draft.status, "confirmed");
  assertThrows(() => confirmBlueprint(data, draft.id));
  assert(
    data.content_items.every((item) =>
      data.documents.some((doc) => doc.id === item.document_id)
    ),
  );
  assert(
    getStatusViews(data, firstContent(data).id).length === 6,
    "new content receives six status dimensions",
  );
});

Deno.test("Blueprint confirmation keeps reordered stage parents and root content unassigned", () => {
  const data = createEmptyProjectData();
  const seed = createCourseSeed(data, {
    source_type: "blank",
    raw_text: null,
  });
  const draft = buildBlueprintDraft(data, seed.id, [
    { node_type: "stage", title: "子阶段", suggested_type: "stage_intro" },
    { node_type: "stage", title: "父阶段", suggested_type: "stage_intro" },
    { node_type: "content", title: "根内容", suggested_type: "lesson" },
  ]);
  const nodes = data.blueprint_nodes.filter((node) =>
    node.blueprint_id === draft.id
  );
  const child = nodes.find((node) => node.title === "子阶段");
  const parent = nodes.find((node) => node.title === "父阶段");
  assert(child && parent, "test fixture must create both stages");
  child.parent_id = parent.id;
  confirmBlueprint(data, draft.id);
  const childStage = data.stages.find((stage) => stage.title === "子阶段");
  const parentStage = data.stages.find((stage) => stage.title === "父阶段");
  assert(childStage && parentStage, "confirmed map must create both stages");
  assertEquals(childStage.parent_stage_id, parentStage.id);
  assertEquals(
    data.content_items.find((item) => item.title === "根内容")?.stage_id,
    null,
  );
  assert(renderCourseMap(data).includes("根内容"));
});

Deno.test("Requirement gaps are derived and assets cannot be archived while referenced", () => {
  const data = confirmedData();
  const content = firstContent(data);
  const requirement = insertPlaceholder(data, content.id, {
    type: "image",
    note: "补一张截图",
  });
  assertEquals(deriveGaps(data, content.id).by_type.image, 1);
  const result = addAsset(data, data.project.id, {
    type: "image",
    filename: "shot.png",
    storage_path: "assets/shot.png",
    mime_type: "image/png",
    checksum: "sha256:shot",
  });
  addAssetUsage(data, result.asset.id, content.id, {
    block_id: requirement.anchor_block_id,
  });
  assertThrows(() => {
    archiveAsset(data, result.asset.id);
  }, "referenced assets must not be deleted");
  // Resolution changes only the Requirement; the body remains block based.
  resolveRequirement(data, requirement.id, result.asset.id);
  assertEquals(deriveGaps(data, content.id).total_open, 0);
});

Deno.test("Status assignment is one row per content/dimension", () => {
  const data = confirmedData();
  const contentId = firstContent(data).id;
  const before = data.status_assignments.length;
  assignStatus(data, contentId, "content", "drafting");
  assignStatus(data, contentId, "content", "final");
  const matching = data.status_assignments.filter((item) =>
    item.content_item_id === contentId
  );
  assertEquals(data.status_assignments.length, before);
  assertEquals(
    matching.filter((item) =>
      data.status_dimensions.find((d) => d.id === item.dimension_id)?.key ===
        "content"
    ).length,
    1,
  );
  assertEquals(
    getStatusViews(data, contentId).find((item) =>
      item.dimension_key === "content"
    )?.option_key,
    "final",
  );
});

Deno.test("Layout placements own grid coordinates; Blocks do not", () => {
  const data = confirmedData();
  const content = firstContent(data);
  const block = appendBlock(data, content.id, "paragraph", "正文");
  const first = createLayoutInstance(data, content.id, {
    name: "公众号",
    mode: "flow",
  });
  assertEquals(first.schema_version, data.schema_version);
  const second = createLayoutInstance(data, content.id, {
    name: "3:4",
    mode: "grid",
  });
  addPlacement(data, first.id, block.id, {
    row_start: 0,
    row_end: 1,
    column_start: 0,
    column_end: 1,
  });
  assertThrows(() =>
    addPlacement(data, first.id, block.id, {
      row_start: 0.5,
      row_end: 1,
      column_start: 0,
      column_end: 1,
    })
  );
  addPlacement(data, second.id, block.id, {
    row_start: 1,
    row_end: 2,
    column_start: 0,
    column_end: 2,
  });
  assert(!("row_start" in block), "grid coordinates must stay outside Block");
  assertEquals(
    data.placements.filter((item) => item.block_id === block.id).length,
    2,
  );
});

Deno.test("Layout references cannot cross project ownership", () => {
  const data = confirmedData();
  const content = firstContent(data);
  const template = createLayoutTemplate(data, {
    name: "外部模板",
    mode: "grid",
  });
  template.project_id = "foreign-project";
  assertThrows(() =>
    createLayoutInstance(data, content.id, {
      name: "不应创建",
      mode: "grid",
      template_id: template.id,
    })
  );

  const layout = createLayoutInstance(data, content.id, {
    name: "待验证排版",
    mode: "grid",
  });
  content.project_id = "foreign-project";
  assertThrows(() =>
    // A preset must not bind to a layout whose content belongs elsewhere.
    createExportPreset(data, {
      name: "不应导出",
      output_type: "html",
      layout_instance_id: layout.id,
    })
  );
});

Deno.test("AI pipeline requires Diff review and explicit apply", async () => {
  const data = confirmedData();
  const content = firstContent(data);
  const block = appendBlock(data, content.id, "paragraph", "原文");
  const context = await createContextPack(data, {
    purpose: "检查当前正文",
    target_content_item_id: content.id,
    items: [{
      source_type: "document",
      source_id: content.document_id,
      label: "当前正文",
      content: "原文",
    }],
  });
  assertEquals(context.items.length, 1);
  const suggestion = createSuggestion(data, {
    target_content_item_id: content.id,
    context_pack_id: context.pack.id,
    type: "rewrite",
    title: "更清楚",
    description: "改写一句",
  });
  const draft = acceptSuggestion(data, suggestion.id, [{
    block_id: block.id,
    before: "原文",
    after: "修改后",
  }]);
  assertEquals(block.content, "原文");
  assertThrows(
    () => applyChangeDraft(data, draft.id, { confirmed: true }),
    "must review before apply",
  );
  reviewChangeDraft(data, draft.id);
  assertThrows(
    () => applyChangeDraft(data, draft.id, { confirmed: false }),
    "must explicitly confirm",
  );
  applyChangeDraft(data, draft.id, { confirmed: true });
  assertEquals(block.content, "修改后");
});

Deno.test("AI patches cannot cross content items and partial review preserves the remainder", async () => {
  const data = confirmedData();
  const first = firstContent(data);
  const secondSeed = createCourseSeed(data, {
    source_type: "blank",
    raw_text: "# 阶段二\n第二篇",
  });
  const secondDraft = buildBlueprintDraft(data, secondSeed.id);
  confirmBlueprint(data, secondDraft.id);
  const second = data.content_items.at(-1);
  assert(second, "test fixture must create two contents");
  const firstBlock = appendBlock(data, first.id, "paragraph", "第一篇");
  const secondBlock = appendBlock(data, second.id, "paragraph", "第二篇");
  const context = await createContextPack(data, {
    purpose: "测试安全边界",
    target_content_item_id: first.id,
    items: [{
      source_type: "document",
      source_id: first.document_id,
      label: "第一篇",
      content: "第一篇",
    }],
  });
  const suggestion = createSuggestion(data, {
    target_content_item_id: first.id,
    context_pack_id: context.pack.id,
    type: "rewrite",
    title: "改写",
    description: "改写正文",
  });
  assertThrows(() =>
    acceptSuggestion(data, suggestion.id, [{
      block_id: secondBlock.id,
      before: "第二篇",
      after: "不应被改写",
    }])
  );
  const validSuggestion = createSuggestion(data, {
    target_content_item_id: first.id,
    context_pack_id: context.pack.id,
    type: "rewrite",
    title: "改写两处",
    description: "局部接受",
  });
  const remainingBlock = appendBlock(data, first.id, "paragraph", "仍未改");
  const draft = acceptSuggestion(data, validSuggestion.id, [
    { block_id: firstBlock.id, before: "第一篇", after: "第一篇已改" },
    { block_id: remainingBlock.id, before: "仍未改", after: "剩余修改" },
  ]);
  reviewChangeDraft(data, draft.id);
  applyChangeDraft(data, draft.id, {
    confirmed: true,
    patch_ids: [firstBlock.id],
  });
  assertEquals(firstBlock.content, "第一篇已改");
  assertEquals(remainingBlock.content, "仍未改");
  const residual = data.change_drafts.find((item) => item.status === "draft");
  assert(residual, "partial acceptance must preserve unselected changes");
  reviewChangeDraft(data, residual.id);
  applyChangeDraft(data, residual.id, { confirmed: true });
  assertEquals(remainingBlock.content, "剩余修改");
});

Deno.test("Project serialization rejects camelCase secrets and local-only data", () => {
  const data = createEmptyProjectData();
  data.project.settings.authToken = "must-not-persist";
  assertThrows(() => serializeProject(data));
  delete data.project.settings.authToken;
  data.project.settings.userPreferences = { theme: "dark" };
  assertThrows(() => serializeProject(data));
  delete data.project.settings.userPreferences;
  (data as unknown as Record<string, unknown>).workspace_local = {
    user_preferences: { theme: "dark" },
  };
  assertThrows(() => serializeProject(data));
});

Deno.test("A project that built an AI context pack can still be saved", async () => {
  // `model_connection_id` matched the `model_connections` private-field token,
  // so every project that had ever built an AI context pack failed to
  // serialize — autosave threw and the AI workflow could not persist at all.
  const data = createEmptyProjectData("上下文包保存");
  await createContextPack(data, {
    purpose: "解释当前内容",
    items: [{
      source_type: "course_map",
      source_id: data.project.id,
      label: "整门课程",
      content: "课程结构摘要",
    }],
  });
  assertEquals(data.context_packs.length, 1);
  const serialized = serializeProject(data);
  assertEquals(JSON.parse(serialized).context_packs.length, 1);
  assertEquals(migrateProject(JSON.parse(serialized)).context_packs.length, 1);
  // The exemption is scoped: it must not open a hole for real credentials and
  // it must not relax any other collection.
  const withSecret = structuredClone(data) as ProjectData;
  (withSecret.context_packs[0] as unknown as Record<string, unknown>).api_key =
    "must-not-persist";
  assertThrows(() => serializeProject(withSecret));
  const elsewhere = structuredClone(data) as ProjectData;
  (elsewhere.project.settings as Record<string, unknown>).model_connection_id =
    "x";
  assertThrows(() => serializeProject(elsewhere));
  // The exemption is the exact `context_packs[].model_connection_id` column, not
  // a prefix: a same-named key nested deeper inside a pack row must still be
  // rejected, otherwise the scoped exemption would be a real hole.
  const nested = structuredClone(data) as ProjectData;
  (nested.context_packs[0] as unknown as Record<string, unknown>).settings = {
    model_connection_id: "x",
  };
  assertThrows(() => serializeProject(nested));
});

Deno.test("Migration fills schema versions for legacy documents and layouts", () => {
  const data = confirmedData();
  const content = firstContent(data);
  const template = createLayoutTemplate(data, { name: "旧模板", mode: "grid" });
  createLayoutInstance(data, content.id, {
    name: "旧排版",
    mode: "grid",
    template_id: template.id,
  });
  const legacy = structuredClone(data) as ProjectData;
  delete (legacy.documents[0] as unknown as Record<string, unknown>)
    .schema_version;
  delete (legacy.layout_templates[0] as unknown as Record<string, unknown>)
    .schema_version;
  delete (legacy.layout_instances[0] as unknown as Record<string, unknown>)
    .schema_version;
  const migrated = migrateProject(legacy);
  assertEquals(migrated.documents[0]?.schema_version, migrated.schema_version);
  assertEquals(
    migrated.layout_templates[0]?.schema_version,
    migrated.schema_version,
  );
  assertEquals(
    migrated.layout_instances[0]?.schema_version,
    migrated.schema_version,
  );
});

Deno.test("Migration rejects malformed canonical collections instead of dropping them", () => {
  const legacy = createEmptyProjectData("损坏项目") as unknown as Record<
    string,
    unknown
  >;
  legacy.blocks = { accidentally: "not-an-array" };
  assertThrows(
    () => migrateProject(legacy),
    "migration must not replace malformed canonical data with an empty array",
  );
});

Deno.test("JSON round-trip and Markdown are open, generated views", async () => {
  const data = confirmedData();
  const content = firstContent(data);
  appendBlock(data, content.id, "heading", "小节", { level: 2 });
  appendBlock(data, content.id, "paragraph", "可迁移正文");
  const serialized = serializeProject(data);
  assert(!/api[_-]?key|password|cookie/i.test(serialized));
  data.project.settings.api_key = "must-not-persist";
  assertThrows(
    () => serializeProject(data),
    "credential fields must be rejected",
  );
  delete data.project.settings.api_key;
  assert(renderDocumentMarkdown(data, content.id).includes("可迁移正文"));
  assert(renderCourseMap(data).includes(content.title));
  const file = await Deno.makeTempFile({ suffix: ".json" });
  await saveProject(data, file);
  const loaded = await loadProject(file);
  assertEquals(loaded.project.id, data.project.id);
  assertEquals(loaded.content_items.length, data.content_items.length);
  await Deno.remove(file);
});

function confirmedData(): ProjectData {
  const data = createEmptyProjectData("测试课程");
  const seed = createCourseSeed(data, {
    source_type: "blank",
    raw_text: "# 阶段一\n第一篇",
  });
  const draft = buildBlueprintDraft(data, seed.id);
  confirmBlueprint(data, draft.id);
  return data;
}

function firstContent(data: ProjectData) {
  const content = data.content_items[0];
  assert(content, "test fixture must create content");
  return content;
}
