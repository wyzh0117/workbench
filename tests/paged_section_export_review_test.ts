import {
  addLayoutSection,
  addPlacement,
  addAsset,
  addAssetUsage,
  appendBlock,
  buildBlueprintDraft,
  confirmBlueprint,
  createCourseSeed,
  createEmptyProjectData,
  createExportPreset,
  createLayoutInstance,
  DesktopService,
  validateProjectData,
} from "../src/domain/index.ts";
import { migrateProject } from "../src/domain/store.ts";
import { lessonView } from "../app/authoring.js";
import {
  buildPublicationProjection,
  getAvailablePublicationAdapters,
  getPublicationCapabilities,
} from "../app/publication.js";
import { createViews } from "../app/views.js";
import {
  addLayoutPage,
  createPagedLayout,
  duplicateLayoutPage,
} from "../app/layout_pages.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("legacy section projects migrate without page data or layout loss", () => {
  const data = createEmptyProjectData("旧分区兼容");
  const seed = createCourseSeed(data, {
    source_type: "blank",
    raw_text: "# 阶段一\n\n## 第一课\n\n正文",
  });
  confirmBlueprint(data, buildBlueprintDraft(data, seed.id).id);
  const lesson = data.content_items[0];
  assert(lesson, "blueprint confirmation must create the lesson");
  const block = appendBlock(data, lesson.id, "paragraph", "旧分区正文");
  const layout = createLayoutInstance(data, lesson.id, {
    name: "旧连续网格",
    mode: "grid",
    grid_definition: { columns: [1], rows: [1] },
  });
  const section = addLayoutSection(data, layout.id, {
    name: "旧输出分区",
    grid_definition: { columns: [1], rows: [1] },
  });
  addPlacement(data, layout.id, block.id, {
    row_start: 0,
    row_end: 1,
    column_start: 0,
    column_end: 1,
    section_id: section.id,
  });

  const legacy = structuredClone(data) as unknown as Record<string, unknown>;
  delete legacy.layout_pages;
  const migrated = migrateProject(legacy);
  assert(migrated.layout_pages.length === 0, "old files gain an empty page collection");
  assert(
    migrated.layout_sections[0]?.id === section.id &&
      migrated.placements[0]?.section_id === section.id,
    "migration must retain the old section and its placement",
  );
});

Deno.test("page copy rebinds anchored requirements and reuses asset rows", () => {
  const data = createEmptyProjectData("分页副本关联");
  const seed = createCourseSeed(data, {
    source_type: "blank",
    raw_text: "# 阶段一\n\n## 第一课\n\n正文",
  });
  confirmBlueprint(data, buildBlueprintDraft(data, seed.id).id);
  const lesson = data.content_items[0];
  assert(lesson, "blueprint confirmation must create the lesson");
  const block = appendBlock(data, lesson.id, "paragraph", "带素材的待补正文");
  const layout = createLayoutInstance(data, lesson.id, {
    name: "分页网格",
    mode: "grid",
    grid_definition: { columns: [1], rows: [1] },
  });
  const sourcePage = createPagedLayout(data, layout.id)[0];
  assert(sourcePage, "paged layout must create an initial page");
  const placement = addPlacement(data, layout.id, block.id, {
    row_start: 0,
    row_end: 1,
    column_start: 0,
    column_end: 1,
  });
  placement.page_id = sourcePage.id;
  const asset = addAsset(data, data.project.id, {
    type: "image",
    filename: "photo.png",
    storage_path: "assets/photo.png",
    mime_type: "image/png",
    checksum: "review-photo-checksum",
    file_size: 1,
  }).asset;
  addAssetUsage(data, asset.id, lesson.id, {
    block_id: block.id,
    layout_instance_id: layout.id,
    role: "content",
  });
  const requirementId = "review-requirement";
  block.settings.requirement_id = requirementId;
  data.requirements.push({
    id: requirementId,
    content_item_id: lesson.id,
    anchor_block_id: block.id,
    type: "image",
    scope: "layout",
    layout_instance_id: layout.id,
    note: "选择配图",
    status: "open",
    priority: "normal",
    resolved_asset_id: null,
    resolved_block_id: null,
    created_at: "2026-09-27T00:00:00.000Z",
    resolved_at: null,
  });

  const copy = duplicateLayoutPage(data, sourcePage.id);
  const copiedPlacement = data.placements.find((candidate) =>
    candidate.page_id === copy.id
  );
  assert(copiedPlacement, "page copy must receive a new placement");
  const copiedBlock = data.blocks.find((candidate) =>
    candidate.id === copiedPlacement.block_id
  );
  assert(copiedBlock && copiedBlock.id !== block.id, "page copy must clone block identity");
  const copiedRequirement = data.requirements.find((candidate) =>
    candidate.id !== requirementId && candidate.anchor_block_id === copiedBlock.id
  );
  assert(copiedRequirement, "page copy must clone an anchored requirement");
  assert(
    copiedBlock.settings.requirement_id === copiedRequirement.id,
    "cloned block must reference its cloned requirement",
  );
  assert(
    data.asset_usages.some((usage) =>
      usage.id !== data.asset_usages[0]?.id && usage.block_id === copiedBlock.id &&
      usage.asset_id === asset.id
    ),
    "cloned block must reuse the same asset through a new usage row",
  );
  assert(
    validateProjectData(data).length === 0,
    "page copy must leave canonical references valid",
  );
});

Deno.test("legacy continuous Grid editor preview still shows each section", () => {
  const data = createEmptyProjectData("旧分区预览");
  const seed = createCourseSeed(data, {
    source_type: "blank",
    raw_text: "# 阶段一\n\n## 第一课\n\n正文",
  });
  confirmBlueprint(data, buildBlueprintDraft(data, seed.id).id);
  const lesson = data.content_items[0];
  assert(lesson, "blueprint confirmation must create the lesson");
  const blockA = appendBlock(data, lesson.id, "paragraph", "LEGACY SECTION A BODY");
  const blockB = appendBlock(data, lesson.id, "paragraph", "LEGACY SECTION B BODY");
  const layout = createLayoutInstance(data, lesson.id, {
    name: "旧连续网格",
    mode: "grid",
    grid_definition: { columns: [1], rows: [1] },
  });
  const sectionA = addLayoutSection(data, layout.id, {
    name: "旧分区 A",
    grid_definition: { columns: [1], rows: [1] },
  });
  const sectionB = addLayoutSection(data, layout.id, {
    name: "旧分区 B",
    grid_definition: { columns: [1], rows: [1] },
  });
  addPlacement(data, layout.id, blockA.id, {
    row_start: 0,
    row_end: 1,
    column_start: 0,
    column_end: 1,
    section_id: sectionA.id,
  });
  addPlacement(data, layout.id, blockB.id, {
    row_start: 0,
    row_end: 1,
    column_start: 0,
    column_end: 1,
    section_id: sectionB.id,
  });

  const projection = buildPublicationProjection(data, {
    content_item_id: lesson.id,
    layout_instance_id: layout.id,
  });
  assert(
    projection.lessons[0]?.layout?.pages.length === 0 &&
      projection.notices.some((notice) =>
        notice.code === "legacy_grid_sections_require_pagination"
      ),
    "ambiguous layouts must never pretend their sections form one export page",
  );
  const store = {
    data,
    ui: {
      screen: "project",
      route: "editor",
      mode: "preview",
      activeId: lesson.id,
      selectedBlockId: null,
      focusRequirementId: null,
      leftCollapsed: false,
      rightCollapsed: true,
      editingProjectTitle: false,
      seedType: null,
      seedText: "",
      seedBusy: false,
      rightPanel: "properties",
      toast: "",
      showPreviewNotes: true,
      gridEditing: false,
      palette: false,
      capture: false,
      preflight: false,
      snapshot: false,
      assetPicker: null,
    },
    tabs: [{ content_item_id: lesson.id, pinned: false }],
    saveStatus: "已保存",
    assetPreview: new Map(),
    bridge: { isNative: () => false },
    currentItem: () => lesson,
    lesson: (item: typeof lesson) => lessonView(data, item.id),
    resumeLessonId: () => lesson.id,
  };
  const html = createViews(store).shellView();
  assert(html.includes("旧分区 A · 第 1 页"), "preview must label the first legacy section");
  assert(html.includes("旧分区 B · 第 2 页"), "preview must label the second legacy section");
  assert(html.includes("LEGACY SECTION A BODY"), "preview must render first-section text");
  assert(html.includes("LEGACY SECTION B BODY"), "preview must render second-section text");
  store.ui.mode = "layout";
  const editor = createViews(store).shellView();
  assert(editor.includes(`data-placement="${data.placements[0]?.id}"`), "legacy placements must remain editable");
  assert(editor.includes(`data-placement="${data.placements[1]?.id}"`), "all legacy placements must remain visible to the editor");
  assert(editor.includes("data-action=\"grid-new-section\""), "legacy section controls must remain available");
});

Deno.test("DesktopService exports the selected paged HTML projection end to end", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-paged-html-service-review-",
  });
  const desktop = new DesktopService(directory, {
    app_instance_id: "paged-html-service-review",
  });
  await desktop.open();
  try {
    const data = createEmptyProjectData("分页 HTML 服务桥验收");
    const seed = createCourseSeed(data, {
      source_type: "blank",
      raw_text: "# 阶段一\n\n## 第一课\n\n正文",
    });
    confirmBlueprint(data, buildBlueprintDraft(data, seed.id).id);
    const lesson = data.content_items[0];
    assert(lesson, "blueprint confirmation must create the lesson");
    const firstBlock = appendBlock(data, lesson.id, "paragraph", "PAGE ONE CONTENT");
    const secondBlock = appendBlock(data, lesson.id, "paragraph", "PAGE TWO CONTENT");
    const layout = createLayoutInstance(data, lesson.id, {
      name: "分页网格",
      mode: "grid",
      grid_definition: { columns: [1], rows: [1] },
    });
    const firstPage = createPagedLayout(data, layout.id)[0];
    assert(firstPage, "paged layout must create its first page");
    const secondPage = addLayoutPage(data, layout.id, {
      title: "第二页",
      grid_definition: { columns: [1], rows: [1] },
    });
    const firstPlacement = addPlacement(data, layout.id, firstBlock.id, {
      row_start: 0,
      row_end: 1,
      column_start: 0,
      column_end: 1,
    });
    firstPlacement.page_id = firstPage.id;
    const secondPlacement = addPlacement(data, layout.id, secondBlock.id, {
      row_start: 0,
      row_end: 1,
      column_start: 0,
      column_end: 1,
    });
    secondPlacement.page_id = secondPage.id;
    const preset = createExportPreset(data, {
      name: "分页网页",
      output_type: "html",
      platform: "web",
    });

    const saved = await desktop.commands.execute("project.save", { project: data });
    assert(!saved.error, "review fixture must be accepted by the project store");
    const options = {
      content_item_id: lesson.id,
      layout_instance_id: layout.id,
      page_ids: [secondPage.id],
    };
    const report = await desktop.queries.execute("export.preflight", {
      preset,
      options,
    }) as {
      ok?: boolean;
      blocking?: unknown[];
      warnings?: { code?: string }[];
      snapshot_revision?: string;
    };
    assert(report.ok, "paged HTML preflight must succeed through DesktopService");
    assert(!(report.blocking?.length), "selected-page export must not be blocked");
    const result = await desktop.commands.execute("export.run", {
      preset,
      options: {
        ...options,
        snapshot_revision: report.snapshot_revision,
        acknowledged_warnings: (report.warnings ?? []).flatMap((warning) =>
          warning.code ? [warning.code] : []
        ),
      },
    });
    assert(!result.error, "paged HTML export must run through DesktopService");
    const files = (result.value as { files: { relative_path: string; bytes: Uint8Array }[] }).files;
    const html = new TextDecoder().decode(files.find((file) => file.relative_path.endsWith(".html"))?.bytes);
    assert(html.includes(`data-page-id="${secondPage.id}"`), "output must retain the selected canonical page ID");
    assert(html.includes("PAGE TWO CONTENT"), "output must retain selected-page content");
    assert(!html.includes("PAGE ONE CONTENT"), "output must exclude unselected-page content");
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("whole-course native PDF and PPTX require a target for mixed page sizes", () => {
  const data = createEmptyProjectData("混合页面尺寸");
  const seed = createCourseSeed(data, {
    source_type: "blank",
    raw_text: "# 阶段一\n\n## 横向课\n\n正文\n\n## 纵向课\n\n正文",
  });
  confirmBlueprint(data, buildBlueprintDraft(data, seed.id).id);
  assert(data.content_items.length === 2, "fixture must contain two lessons");
  const sizes = [
    { preset: "16:9", width_pt: 960, height_pt: 540 },
    { preset: "a4-portrait", width_pt: 595.2756, height_pt: 841.8898 },
  ] as const;
  for (const [index, lesson] of data.content_items.entries()) {
    const layout = createLayoutInstance(data, lesson.id, {
      name: `分页网格 ${index + 1}`,
      mode: "grid",
      grid_definition: { columns: [1], rows: [1] },
    });
    createPagedLayout(data, layout.id);
    layout.page_size = { ...sizes[index]! };
  }
  const projection = buildPublicationProjection(data);
  assert(projection.target_page_size === null, "whole-course default must preserve the repro's unset target");
  assert(
    projection.lessons.map((lesson) => lesson.layout?.pages[0]?.logical_width_pt)
        .sort((left, right) => Number(left) - Number(right)).join(",") ===
      "595.2756,960",
    "whole-course projection must carry both source page sizes regardless of cross-stage tie ordering",
  );
  const nativeAdapters = getAvailablePublicationAdapters({ native: true });
  const missingTargetGates: string[] = [];
  for (const target of ["pdf", "pptx"] as const) {
    const withoutTarget = getPublicationCapabilities(projection, target, nativeAdapters);
    if (withoutTarget.status === "available") missingTargetGates.push(target.toUpperCase());
    const withTarget = getPublicationCapabilities({
      ...projection,
      target_page_size: { ...sizes[0]! },
    }, target, nativeAdapters);
    assert(withTarget.status === "available", `${target.toUpperCase()} should accept a chosen target size`);
  }
  assert(
    missingTargetGates.length === 0,
    `mixed-size whole-course output should require a selected target; still immediately available: ${missingTargetGates.join(", ")}`,
  );
});

Deno.test("DesktopService blocks ambiguous legacy section-local grid export", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-legacy-section-export-review-",
  });
  const desktop = new DesktopService(directory, {
    app_instance_id: "legacy-section-export-review",
  });
  await desktop.open();
  try {
    const data = createEmptyProjectData("旧分区导出验收");
    const seed = createCourseSeed(data, {
      source_type: "blank",
      raw_text: "# 阶段一\n\n## 第一课\n\n正文",
    });
    const draft = buildBlueprintDraft(data, seed.id);
    confirmBlueprint(data, draft.id);
    const lesson = data.content_items[0];
    assert(lesson, "blueprint confirmation must create the lesson");
    const blockA = appendBlock(data, lesson.id, "paragraph", "分区 A");
    const blockB = appendBlock(data, lesson.id, "paragraph", "分区 B");
    const layout = createLayoutInstance(data, lesson.id, {
      name: "旧连续网格",
      mode: "grid",
      grid_definition: { columns: [1], rows: [1] },
    });
    const sectionA = addLayoutSection(data, layout.id, {
      name: "A",
      grid_definition: { columns: [1], rows: [1] },
    });
    const sectionB = addLayoutSection(data, layout.id, {
      name: "B",
      grid_definition: { columns: [1], rows: [1] },
    });
    addPlacement(data, layout.id, blockA.id, {
      row_start: 0,
      row_end: 1,
      column_start: 0,
      column_end: 1,
      section_id: sectionA.id,
    });
    addPlacement(data, layout.id, blockB.id, {
      row_start: 0,
      row_end: 1,
      column_start: 0,
      column_end: 1,
      section_id: sectionB.id,
    });
    const preset = createExportPreset(data, {
      name: "网页",
      output_type: "html",
      platform: "web",
    });

    const saved = await desktop.commands.execute("project.save", {
      project: data,
    });
    assert(!saved.error, "review fixture must be accepted by the project store");
    const options = {
      content_item_id: lesson.id,
      layout_instance_id: layout.id,
    };
    const report = await desktop.queries.execute("export.preflight", {
      preset,
      options,
    }) as { blocking?: unknown[] };
    assert(
      (report.blocking?.length ?? 0) > 0,
      "separate legacy section grids need a conversion confirmation before export",
    );
    const result = await desktop.commands.execute("export.run", {
      preset,
      options,
    });
    assert(result.error, "the export command must not flatten ambiguous sections");
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true });
  }
});
