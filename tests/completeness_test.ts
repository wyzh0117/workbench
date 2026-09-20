import {
  acceptSuggestedChanges,
  addAsset,
  analyzeForSuggestions,
  appendBlock,
  applyChangeDraft,
  assertValidProjectData,
  buildBlueprintDraft,
  confirmBlueprint,
  createBlockGroup,
  createContextPack,
  createCourseSeed,
  createEmptyProjectData,
  deriveGaps,
  DeterministicModelAdapter,
  FileSearchIndex,
  insertPlaceholder,
  moveBlock,
  ProjectDirectoryStore,
  reviewChangeDraft,
  validateProjectData,
  verifyAssetFile,
} from "../src/domain/index.ts";

function fixture() {
  const data = createEmptyProjectData("完整性测试");
  const seed = createCourseSeed(data, {
    source_type: "blank",
    raw_text: "# 阶段\n第一课",
  });
  confirmBlueprint(data, buildBlueprintDraft(data, seed.id).id);
  return data;
}

Deno.test("canonical validation fails closed on FK, enum, unique and cross-project errors", () => {
  const data = fixture();
  data.content_items[0]!.stage_id = "foreign-stage";
  data.content_items[0]!.type = "not-a-content-type" as never;
  const issues = validateProjectData(data);
  if (!issues.some((issue) => issue.code === "invalid_reference")) {
    throw new Error("missing FK validation");
  }
  if (!issues.some((issue) => issue.code === "invalid_enum")) {
    throw new Error("missing enum validation");
  }
  try {
    assertValidProjectData(data);
    throw new Error("expected canonical validation to reject");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("项目校验失败")) {
      throw error;
    }
  }
});

Deno.test("semantic groups and block move provide an inverse operation", () => {
  const data = fixture();
  const item = data.content_items[0]!;
  const first = appendBlock(data, item.id, "paragraph", "一");
  const second = appendBlock(data, item.id, "paragraph", "二");
  const group = createBlockGroup(
    data,
    item.id,
    [first.id, second.id],
    "正文组",
  );
  const change = moveBlock(data, {
    content_item_id: item.id,
    block_id: second.id,
    group_id: group.id,
    to_index: 0,
  });
  if (group.block_ids[0] !== second.id) throw new Error("block was not moved");
  change.undo();
  if (
    data.groups.find((candidate) => candidate.id === group.id)?.block_ids[0] !==
      first.id
  ) throw new Error("block undo failed");
});

Deno.test("asset bytes, checksum and requirement usage stay consistent", async () => {
  const data = fixture();
  const root = await Deno.makeTempDir({ prefix: "acw-integrity-" });
  await Deno.mkdir(`${root}/assets`, { recursive: true });
  await Deno.writeTextFile(`${root}/assets/a.txt`, "asset");
  const bytes = new TextEncoder().encode("asset");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const checksum = [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const asset = addAsset(data, data.project.id, {
    type: "document",
    filename: "a.txt",
    storage_path: "assets/a.txt",
    mime_type: "text/plain",
    checksum,
    file_size: bytes.length,
  }).asset;
  const integrity = await verifyAssetFile(root, asset);
  if (!integrity.ok) throw new Error("asset integrity check failed");
  const requirement = insertPlaceholder(data, data.content_items[0]!.id, {
    type: "other",
    note: "补资料",
  });
  (await import("../src/domain/requirements.ts")).resolveRequirement(
    data,
    requirement.id,
    asset.id,
  );
  if (
    deriveGaps(data, data.content_items[0]!.id).total_open !== 0 ||
    data.asset_usages.length !== 1
  ) throw new Error("requirement usage was not synchronized");
});

Deno.test("AI fake follows explicit context through ChangeDraft and Apply", async () => {
  const data = fixture();
  const item = data.content_items[0]!;
  const block = appendBlock(data, item.id, "paragraph", "原文");
  const pack = await createContextPack(data, {
    purpose: "改写",
    target_content_item_id: item.id,
    items: [{
      source_type: "document",
      source_id: item.document_id,
      label: "正文",
      content: "原文",
    }],
  });
  const analyzed = await analyzeForSuggestions(
    data,
    new DeterministicModelAdapter(),
    {
      purpose: "改写",
      context_pack_id: pack.pack.id,
      target_content_item_id: item.id,
      selected_context: [{
        source_type: "document",
        source_id: item.document_id,
        label: "正文",
        content: "原文",
      }],
      proposed_changes: [{
        block_id: block.id,
        before: "原文",
        after: "建议后",
      }],
    },
  );
  if (block.content !== "原文" || analyzed.suggestions.length !== 1) {
    throw new Error("analysis must not mutate canonical body");
  }
  const draft = acceptSuggestedChanges(data, analyzed.suggestions[0]!.id);
  reviewChangeDraft(data, draft.id);
  applyChangeDraft(data, draft.id, { confirmed: true });
  if (String(block.content) !== "建议后") {
    throw new Error("confirmed AI change was not applied");
  }
});

Deno.test("external branch merge and file index filtering are deterministic", async () => {
  const data = fixture();
  const directory = await Deno.makeTempDir({ prefix: "acw-merge-" });
  const store = new ProjectDirectoryStore(directory, {
    app_instance_id: "merge-test",
    heartbeat_ms: 1000,
  });
  await store.open();
  await store.writeProject(data);
  const local = structuredClone(data);
  local.project.title = "本地修改";
  const external = structuredClone(data);
  external.project.title = "外部修改";
  await Deno.writeTextFile(
    `${directory}/project.json`,
    JSON.stringify(external),
  );
  const report = await store.inspectExternalModification(local);
  if (
    !report.changed ||
    !report.external_diff.entries.some((entry) =>
      entry.path === "project.title"
    )
  ) throw new Error("external diff missing");
  let rejectedOverwrite = false;
  try {
    await store.writeProject(local);
  } catch {
    rejectedOverwrite = true;
  }
  if (!rejectedOverwrite) {
    throw new Error("external change was silently overwritten");
  }
  const merged = await store.mergeExternalChanges(local);
  if (merged.can_apply || merged.conflicts.length !== 1) {
    throw new Error("merge conflict was not surfaced");
  }
  await store.close();

  const index = new FileSearchIndex(directory);
  await index.rebuild(data);
  const filtered = await index.search("第一课", {
    filter: { content_item_id: data.content_items[0]!.id },
  });
  if (filtered.length === 0) {
    throw new Error("deterministic index filter missed content");
  }
});
