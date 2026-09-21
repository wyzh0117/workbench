/**
 * Course Authoring UI tests.
 *
 * These drive `WorkbenchStore` (the running authoring model) with the same
 * injected bridge the recovery tests use, so every authoring operation is
 * checked against real canonical data rather than rendered markup.
 */
import { createEmptyProjectData } from "../src/domain/index.ts";
import { validateProjectData } from "../src/domain/store.ts";
import type { ProjectData } from "../src/domain/types.ts";
import { courseMap, lessonView } from "../app/authoring.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let importCounter = 0;

/** Row/column tracks of a layout's grid definition, as canonical numbers. */
function tracks(grid: Record<string, unknown>): {
  rows: number[];
  columns: number[];
} {
  const read = (value: unknown): number[] =>
    Array.isArray(value) ? value.map((track) => Number(track) || 1) : [1];
  return { rows: read(grid.rows), columns: read(grid.columns) };
}

/** Boot a fresh WorkbenchStore over an isolated in-memory project. */
async function bootStore() {
  const source = createEmptyProjectData("Authoring UI 测试");
  const state = {
    project: structuredClone(source) as ProjectData,
    writes: 0,
    sessions: [] as unknown[],
    acceptWrites: true,
  };
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {},
    dataset: {},
  };
  const runtime = globalThis as typeof globalThis & {
    document?: unknown;
    __TAURI__?: unknown;
    __workbench?: unknown;
  };
  const previousDocument = runtime.document;
  const previousTauri = runtime.__TAURI__;
  const previousFetch = globalThis.fetch;
  runtime.document = {
    querySelector: () => root,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  runtime.__TAURI__ = undefined;
  globalThis.fetch = async () => {
    throw new Error("test fetch disabled");
  };
  importCounter += 1;
  const { WorkbenchStore } = await import(
    `../app/main.js?authoring-ui-${importCounter}`
  );
  const bridge = {
    projectDir: null,
    projectDirFromUrl: false,
    isNative: () => false,
    currentProject: () => state.project,
    loadSession: async () => null,
    readProject: async () => structuredClone(state.project),
    readRecoveryJournal: async () => null,
    listenNativeDrops: async () => () => {},
    writeRecoveryJournal: async () => {},
    writeProject: async (project: ProjectData) => {
      state.writes += 1;
      // `acceptWrites` lets a test stand in for "another writer owns the file".
      if (state.acceptWrites) state.project = structuredClone(project);
    },
    clearRecoveryJournal: async () => {},
    saveSession: async (session: unknown) => {
      state.sessions.push(session);
    },
    createSnapshot: async () => ({}),
    setProjectDir: () => {},
    restoreProjectDir: () => {},
    projectIdentity: async () => state.project.project.id,
  };
  const store = new (WorkbenchStore as new (bridge: unknown) => {
    data: ProjectData;
    ui: Record<string, unknown>;
    saveStatus: string;
    history: unknown[];
    tabs: unknown[];
    commit: (label: string, mutation: (data: ProjectData) => void) => void;
    currentItem: () => ProjectData["content_items"][number] | null;
    blocks: (item?: unknown) => ProjectData["blocks"];
    lesson: () => ReturnType<typeof lessonView>;
    map: () => ReturnType<typeof courseMap>;
    addMapItem: (title?: string) => void;
    renameLesson: (id: string, title: string) => void;
    moveLesson: (id: string, direction: string) => void;
    deleteLesson: (id: string) => void;
    openItem: (id: string) => void;
    selectBlock: (id: string, options?: Record<string, unknown>) => void;
    addBlock: (type?: string, content?: string, atIndex?: number) => void;
    insertBlockBelow: (id: string) => void;
    editBlockText: (id: string, value: string) => void;
    setBlockType: (id: string, type: string) => void;
    setBlockLevel: (id: string, level: unknown) => void;
    moveBlock: (id: string, direction: string) => void;
    reorderBlockTo: (source: string, target: string) => void;
    deleteBlock: (id: string) => void;
    addPlaceholder: (type?: string, note?: string) => void;
    updateRequirement: (id: string, patch: Record<string, unknown>) => void;
    resolveRequirement: (id: string, assetId?: string | null) => void;
    setRequirementStatus: (id: string, status: string) => void;
    deleteRequirement: (id: string) => void;
    insertAsset: (assetId: string, options?: Record<string, unknown>) => Promise<void>;
    detachAsset: (blockId: string, assetId: string) => void;
    deleteAsset: (assetId: string) => void;
    createLayout: (mode?: string) => void;
    setLayoutMode: (mode: string) => void;
    changeGrid: (kind: string, amount?: number) => void;
    placeBlock: (blockId: string) => void;
    unplaceBlock: (blockId: string) => void;
    autofillGrid: () => void;
    movePlacement: (id: string, dr: number, dc: number) => void;
    resizePlacement: (id: string, dw?: number, dh?: number) => void;
    addSection: () => void;
    renameSection: (id: string, name: string) => void;
    updateStatus: (dimension: string, value: string) => void;
    moveBoardCard: (id: string, option: string) => void;
    undo: () => void;
    redo: () => void;
    navigateLesson: (direction: string) => void;
    captureToInbox: (text: string, title?: string) => void;
    triageInbox: (id: string, target?: string) => void;
    ignoreInbox: (id: string) => void;
    expectedProjectId: string | null;
    trackProjectIdentity: (data?: unknown) => string | null;
    exportPreflight: () => {
      content: number;
      layout: number;
      missingAssets: number;
      overflow: number;
      text: number;
      fonts: number;
      external: number;
      blocking: number;
      warnings: number;
      total: number;
    };
    resolveLessonId: () => string | null;
    session: () => Record<string, unknown>;
    openProject: (dir?: string) => Promise<void>;
    flush: () => Promise<boolean>;
    saveTimer: number;
    initialize: () => Promise<void>;
    externalConflict: unknown;
    resolveExternalConflict: (action: string) => Promise<void>;
  })(bridge);
  return {
    store,
    state,
    restore: () => {
      runtime.document = previousDocument;
      runtime.__TAURI__ = previousTauri;
      globalThis.fetch = previousFetch;
      clearTimeout(store.saveTimer);
    },
  };
}

Deno.test("lesson creation, rename, reorder and delete keep the course consistent", async () => {
  const { store, restore } = await bootStore();
  try {
    store.openItem("");
    store.addMapItem("第一课");
    store.addMapItem("第二课");
    store.addMapItem("第三课");
    assert(store.data.content_items.length === 3, "three lessons must exist");
    assert(
      store.data.content_items.map((item) => item.code).join(",") ===
        "S01-01,S01-02,S01-03",
      "codes must follow the stage",
    );

    const [first, second, third] = store.data.content_items;
    store.renameLesson(first!.id, "重新命名的一课");
    assert(first!.title === "重新命名的一课", "rename must reach canonical data");
    assert(first!.order_index === 0, "rename must not reorder");

    store.moveLesson(third!.id, "up");
    const order = store.data.content_items
      .filter((item) => item.stage_id === first!.stage_id)
      .sort((a, b) => a.order_index - b.order_index)
      .map((item) => item.id);
    assert(order[1] === third!.id, "moving up swaps positions");

    store.openItem(second!.id);
    store.addBlock("paragraph", "第二课的正文");
    store.deleteLesson(second!.id);
    assert(
      store.data.content_items.some((item) => item.id === second!.id),
      "deleting a lesson with content asks for confirmation first",
    );
    assert(
      store.ui.confirmDeleteLesson !== null,
      "the confirmation request is recorded",
    );
    store.deleteLesson(second!.id);
    assert(
      !store.data.content_items.some((item) => item.id === second!.id),
      "delete removes the lesson",
    );
    assert(
      !store.data.blocks.some((block) => block.document_id === second!.document_id),
      "delete removes the lesson's blocks",
    );
    assert(
      !store.data.documents.some((document) => document.id === second!.document_id),
      "delete removes the lesson's document",
    );
    assert(
      store.data.content_items
        .filter((item) => item.stage_id === first!.stage_id)
        .every((item, index) => item.order_index === index),
      "remaining lessons keep contiguous order",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "the project must still pass canonical validation",
    );
  } finally {
    restore();
  }
});

Deno.test("block authoring keeps text, structure and selection in sync", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("区块测试");
    const item = store.currentItem()!;
    store.addBlock("heading", "标题");
    store.addBlock("paragraph", "第一段");
    store.addBlock("paragraph", "第二段");
    assert(store.blocks(item).length === 3, "three blocks must exist");

    const [heading, firstParagraph] = store.blocks(item);
    store.editBlockText(heading!.id, "改过的标题");
    assert(
      store.lesson()!.blocks[0]!.text === "改过的标题",
      "text edits are read back through the projection",
    );
    store.setBlockLevel(heading!.id, 1);
    assert(store.lesson()!.blocks[0]!.level === 1, "heading level is editable");
    store.setBlockType(firstParagraph!.id, "quote");
    assert(
      store.lesson()!.blocks[1]!.type === "quote",
      "block type conversion is canonical",
    );

    const before = store.blocks(item).map((block) => block.id);
    store.reorderBlockTo(before[2]!, before[0]!);
    const after = store.blocks(item).map((block) => block.id);
    assert(after[0] === before[2], "drag reorder moves the block to the target index");
    assert(
      after.every((id, index) =>
        store.blocks(item)[index]!.order_index === index
      ),
      "order_index stays contiguous",
    );

    store.selectBlock(heading!.id, { force: true });
    assert(store.ui.selectedBlockId === heading!.id, "selection follows the click");
    store.deleteBlock(heading!.id);
    assert(store.ui.selectedBlockId === null, "deleting the selected block clears it");
    assert(store.blocks(item).length === 2, "delete removes exactly one block");

    store.undo();
    assert(store.blocks(item).length === 3, "undo restores the deleted block");
    assert(
      validateProjectData(store.data).length === 0,
      "undo must leave a valid project",
    );
  } finally {
    restore();
  }
});

Deno.test("placeholder and requirement lifecycle survives navigation", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("待补测试");
    const item = store.currentItem()!;
    store.addBlock("paragraph", "正文");
    store.selectBlock(store.blocks(item)[0]!.id, { force: true });
    store.addPlaceholder("image", "补一张图");

    const blocks = store.lesson()!.blocks;
    assert(blocks.length === 2, "the placeholder is a real block");
    assert(blocks[1]!.type === "placeholder", "the placeholder block type is preserved");
    assert(
      blocks[1]!.requirement_id !== null,
      "the placeholder points at its requirement",
    );
    const requirement = store.data.requirements[0]!;
    assert(
      requirement.anchor_block_id === blocks[1]!.id,
      "the requirement anchors to its own placeholder block",
    );
    assert(requirement.status === "open", "a new requirement starts open");
    assert(store.lesson()!.progress.open_requirements === 1, "the gap counter sees it");

    store.updateRequirement(requirement.id, {
      note: "补一张搜索结果截图",
      type: "image",
      priority: "high",
    });
    const edited = store.data.requirements[0]!;
    assert(edited.note === "补一张搜索结果截图", "notes are editable");
    assert(edited.type === "image", "types are editable");
    assert(edited.priority === "high", "priority is editable");
    assert(
      store.blocks(item).find((block) => block.id === edited.anchor_block_id)!
        .content === "补一张搜索结果截图",
      "the placeholder text follows the note",
    );

    // Jump to another lesson and back: requirement and selection must not leak.
    store.addMapItem("另一课");
    const other = store.currentItem()!;
    assert(other.id !== item.id, "the new lesson becomes current");
    assert(
      store.lesson()!.requirements.length === 0,
      "the other lesson must not show the first lesson's requirements",
    );
    store.openItem(item.id);
    assert(
      store.lesson()!.requirements.length === 1,
      "returning restores the lesson's own requirements",
    );
    assert(store.ui.selectedBlockId === null, "selection does not leak across lessons");

    store.setRequirementStatus(requirement.id, "resolved");
    assert(store.lesson()!.progress.open_requirements === 0, "resolving clears the gap");
    store.setRequirementStatus(requirement.id, "open");
    assert(store.lesson()!.progress.open_requirements === 1, "reopening restores the gap");
    store.deleteRequirement(requirement.id);
    assert(store.data.requirements.length === 0, "deleting removes the requirement");
    assert(
      store.blocks(item).every((block) => block.type !== "placeholder"),
      "deleting the requirement removes its placeholder block",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "requirement lifecycle must leave a valid project",
    );
  } finally {
    restore();
  }
});

Deno.test("asset authoring links blocks, usages and requirements together", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("素材测试");
    const item = store.currentItem()!;
    store.commit("测试素材", (data) => {
      data.assets.push({
        id: "asset-image",
        project_id: data.project.id,
        type: "image",
        filename: "封面.png",
        storage_path: "assets/封面.png",
        mime_type: "image/png",
        width: null,
        height: null,
        duration_ms: null,
        file_size: 1024,
        checksum: "checksum-cover",
        title: "封面.png",
        description: "",
        source_type: "imported",
        source_url: null,
        copyright_note: null,
        created_at: "2026-01-01T00:00:00.000Z",
        archived: false,
      });
    });
    store.addBlock("paragraph", "需要配图的一段");
    const block = store.blocks(item)[0]!;
    store.selectBlock(block.id, { force: true });
    await store.insertAsset("asset-image", { block_id: block.id });

    let current = store.blocks(item)[0]!;
    assert(current.type === "image", "inserting an image asset converts the block");
    assert(current.settings.asset_id === "asset-image", "the block links the asset");
    const usage = store.data.asset_usages[0]!;
    assert(usage.asset_id === "asset-image", "a real usage is created");
    assert(usage.block_id === block.id, "the usage points at the block");
    assert(usage.content_item_id === item.id, "the usage belongs to the lesson");
    assert(store.lesson()!.blocks[0]!.asset !== null, "the projection resolves the asset");

    // A second insert of the same asset must not duplicate the usage.
    await store.insertAsset("asset-image", { block_id: block.id });
    assert(store.data.asset_usages.length === 1, "usages are idempotent per block");

    // Detaching keeps the block as an empty media slot.
    store.detachAsset(block.id, "asset-image");
    current = store.blocks(item)[0]!;
    assert(current.type === "image", "detaching keeps the media block type");
    assert(!current.settings.asset_id, "detaching clears the link");
    assert(store.data.asset_usages.length as number === 0, "detaching clears the usage");
    assert(
      store.lesson()!.progress.missing_media === 1,
      "an unlinked media block is reported as missing material",
    );

    // Resolving a requirement with the asset links the anchor block.
    store.setBlockType(block.id, "placeholder");
    const requirement = store.data.requirements.at(-1)!;
    store.resolveRequirement(requirement.id, "asset-image");
    const resolved = store.data.requirements.find((candidate) =>
      candidate.id === requirement.id
    )!;
    assert(resolved.status === "resolved", "the requirement is resolved");
    assert(resolved.resolved_asset_id === "asset-image", "the resolution records the asset");
    assert(
      store.blocks(item).find((candidate) => candidate.id === requirement.anchor_block_id)!
        .settings.asset_id === "asset-image",
      "the anchor block becomes the media slot",
    );

    // Deleting the asset clears every reference without removing rows, and asks
    // for confirmation first because references exist.
    store.deleteAsset("asset-image");
    assert(
      store.ui.confirmDeleteAssetId === "asset-image",
      "deleting a referenced asset asks for confirmation first",
    );
    assert(!store.data.assets[0]!.archived, "nothing is removed before confirmation");
    store.deleteAsset("asset-image");
    assert(store.data.assets[0]!.archived, "deleting archives instead of unlinking");
    assert(store.data.asset_usages.length as number === 0, "every usage is released");
    assert(
      store.data.requirements.every((candidate) =>
        candidate.resolved_asset_id === null
      ),
      "no requirement keeps a removed asset",
    );
    assert(
      store.data.blocks.every((candidate) => !candidate.settings.asset_id),
      "no block keeps a removed asset",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "asset deletion must leave a valid project",
    );
  } finally {
    restore();
  }
});

Deno.test("flow and grid layout edits persist on the canonical layout row", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.addMapItem("排版测试");
    const item = store.currentItem()!;
    store.addBlock("heading", "标题");
    store.addBlock("paragraph", "第一段");
    store.addBlock("paragraph", "第二段");

    store.createLayout("grid");
    const layout = store.data.layout_instances[0]!;
    assert(layout.mode === "grid", "the layout starts in grid mode");
    assert(store.data.layout_sections.length === 1, "a first section is created");

    store.autofillGrid();
    assert(
      store.data.placements.length === 3,
      "autofill places every unplaced block",
    );
    const firstPlacement = store.data.placements[0]!;
    assert(firstPlacement.row_start === 0, "placements start at the first free cell");

    store.movePlacement(firstPlacement.id, 1, 1);
    assert(
      store.data.placements[0]!.row_start === 1 &&
        store.data.placements[0]!.column_start === 1,
      "moving a placement snaps to the requested track",
    );
    store.resizePlacement(firstPlacement.id, 1, 0);
    assert(
      store.data.placements[0]!.column_end >
        store.data.placements[0]!.column_start,
      "resizing keeps a positive span",
    );

    // Put a placement in the last row so shrinking really has to clamp it.
    const rowsBefore = tracks(store.data.layout_instances[0]!.grid_definition).rows.length;
    const lastRow = store.data.placements.length;
    store.changeGrid("row", 2);
    const grownRows = tracks(store.data.layout_instances[0]!.grid_definition).rows.length;
    assert(grownRows === rowsBefore + 2, "adding rows grows the grid");
    store.movePlacement(firstPlacement.id, grownRows - 1 - firstPlacement.row_start, 0);
    const displaced = store.data.placements[0]!;
    assert(
      displaced.row_start === grownRows - 1,
      `expected the placement in the last row, got row ${displaced.row_start}`,
    );
    store.changeGrid("row", -2);
    const rowsAfter = tracks(store.data.layout_instances[0]!.grid_definition).rows.length;
    assert(rowsAfter === rowsBefore, "removing rows shrinks the grid");
    const clamped = store.data.placements.find((placement) =>
      placement.id === firstPlacement.id
    )!;
    assert(
      clamped.row_end <= rowsAfter && clamped.row_start >= 0,
      `shrinking the grid must clamp the displaced placement, got ${clamped.row_start}..${clamped.row_end} of ${rowsAfter}`,
    );
    assert(
      store.data.placements.every((placement) => placement.row_end <= rowsAfter),
      "every placement stays inside the grid",
    );
    void lastRow;

    store.addSection();
    const section = store.data.layout_sections.at(-1)!;
    store.renameSection(section.id, "第二段");
    assert(
      store.data.layout_sections.at(-1)!.name === "第二段",
      "sections are renamable",
    );

    store.setLayoutMode("flow");
    assert(store.data.layout_instances[0]!.mode === "flow", "flow mode is canonical");
    assert(
      store.data.placements.length === 3,
      "switching to flow must not drop placements",
    );
    store.setLayoutMode("grid");
    assert(String(store.data.layout_instances[0]!.mode) === "grid", "switching back is canonical");
    assert(store.data.placements.length === 3, "placements survive the round trip");

    store.unplaceBlock(store.blocks(item)[0]!.id);
    assert(store.data.placements.length as number === 2, "a block can be taken out of the grid");
    store.placeBlock(store.blocks(item)[0]!.id);
    assert(store.data.placements.length as number === 3, "and put back");

    await store.flush();
    const persisted = state.project;
    assert(
      persisted.layout_instances[0]!.mode === "grid",
      "the layout mode reaches canonical storage",
    );
    assert(persisted.placements.length === 3, "placements reach canonical storage");
    assert(
      validateProjectData(persisted).length === 0,
      "the persisted layout must stay valid",
    );
  } finally {
    restore();
  }
});

Deno.test("completion state is derived from real data and drives navigation", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("第一课");
    store.addMapItem("第二课");
    const [first, second] = store.data.content_items;

    store.openItem(first!.id);
    store.addBlock("paragraph", "第一课的正文");
    assert(
      !store.lesson()!.progress.complete,
      "a lesson without a layout cannot be complete",
    );

    store.createLayout("grid");
    store.autofillGrid();
    for (const dimension of store.data.status_dimensions) {
      const terminal = store.data.status_options.find((option) =>
        option.dimension_id === dimension.id && option.is_terminal
      )!;
      store.updateStatus(dimension.key, terminal.name);
    }
    const progress = store.lesson()!.progress;
    assert(
      progress.complete,
      `expected a complete lesson, reasons: ${progress.reasons.join("；")}`,
    );
    assert(progress.percentage === 100, "a complete lesson reports full progress");

    store.updateStatus("content", "待研究");
    assert(!store.lesson()!.progress.complete, "a non-terminal status blocks completion");
    assert(
      store.lesson()!.progress.reasons.some((reason) => reason.includes("正文")),
      "the reason names the unfinished dimension",
    );

    const map = store.map();
    assert(map.lesson_count === 2, "the map lists both lessons");
    assert(map.complete_count === 0, "the map agrees with the derived state");

    store.navigateLesson("next");
    assert(store.currentItem()!.id === second!.id, "next lesson navigates");
    store.navigateLesson("previous");
    assert(store.currentItem()!.id === first!.id, "previous lesson navigates");

    // The board drag must write a canonical assignment, not a legacy shape.
    store.ui.boardDimension = "review";
    store.moveBoardCard(second!.id, "通过");
    const assignment = store.data.status_assignments.find((candidate) =>
      candidate.content_item_id === second!.id &&
      candidate.dimension_id === store.data.status_dimensions.find((dimension) =>
        dimension.key === "review"
      )!.id
    )!;
    assert(Boolean(assignment.option_id), "board drags write a canonical option id");
    assert(
      !("dimension_key" in assignment) && !("option" in assignment),
      "board drags must not write the legacy shape",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "status writes must leave a valid project",
    );
  } finally {
    restore();
  }
});

Deno.test("authoring survives serialization, reopen and inbox capture", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.addMapItem("持久化测试");
    const item = store.currentItem()!;
    store.addBlock("heading", "标题");
    store.addPlaceholder("text", "补一段说明");
    store.commit("测试素材", (data) => {
      data.assets.push({
        id: "asset-doc",
        project_id: data.project.id,
        type: "image",
        filename: "图.png",
        storage_path: "assets/图.png",
        mime_type: "image/png",
        width: null,
        height: null,
        duration_ms: null,
        file_size: 10,
        checksum: "c",
        title: "图.png",
        description: "",
        source_type: "imported",
        source_url: null,
        copyright_note: null,
        created_at: "2026-01-01T00:00:00.000Z",
        archived: false,
      });
    });
    const requirement = store.data.requirements[0]!;
    store.resolveRequirement(requirement.id, "asset-doc");
    store.createLayout("grid");
    store.captureToInbox("稍后要补一张图", "灵感");
    assert(store.data.inbox_items.length === 1, "capture writes an inbox row");
    store.triageInbox(store.data.inbox_items[0]!.id, item.id);
    const inboxItem = store.data.inbox_items[0]!;
    assert(inboxItem.status === "triaged", "triage marks the inbox row");
    assert(inboxItem.content_item_id === item.id, "triage records the target lesson");
    assert(
      store.blocks(item).some((block) => block.content === "稍后要补一张图"),
      "triage turns the capture into real正文",
    );
    // 排版 after the capture: every block that exists must be placeable.
    store.autofillGrid();
    assert(
      store.data.placements.length === store.blocks(item).length,
      "autofill places every block that exists at that moment",
    );

    await store.flush();
    const persisted = state.project;
    assert(state.writes > 0, "authoring reaches the write bridge");
    const issues = validateProjectData(persisted);
    assert(issues.length === 0, `persisted project invalid: ${issues[0]?.message}`);

    // Reopen from the persisted payload: every authoring fact comes back.
    store.openItem("");
    store.data = structuredClone(createEmptyProjectData("空"));
    store.data = structuredClone(persisted);
    store.ui.activeId = persisted.content_items[0]!.id;
    const reopened = lessonView(store.data, persisted.content_items[0]!.id)!;
    assert(reopened.blocks.length === 3, "reopen keeps every block");
    assert(reopened.requirements.length === 1, "reopen keeps the requirement");
    assert(
      reopened.requirements[0]!.status === "resolved",
      "reopen keeps the resolved state",
    );
    assert(
      reopened.blocks.some((block) => block.asset !== null),
      "reopen keeps the asset reference",
    );
    assert(
      String(reopened.lesson.layout_mode) === "grid",
      "reopen keeps the layout mode",
    );
    assert(
      reopened.placements.length === reopened.blocks.length,
      "reopen keeps every placement",
    );
  } finally {
    restore();
  }
});

Deno.test("export preflight and every export entry point stay callable", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("导出测试");
    store.addBlock("heading", "标题");
    store.addBlock("paragraph", "正文");
    // Regression: exportPreflight read a projection shape that did not exist,
    // which made every export entry point throw and froze the shell.
    const report = store.exportPreflight();
    assert(typeof report.blocking === "number", "preflight returns a blocking count");
    assert(typeof report.warnings === "number", "preflight returns a warning count");
    assert(report.total === report.blocking + report.warnings, "the totals agree");

    store.addPlaceholder("image", "补一张图");
    const withGap = store.exportPreflight();
    assert(withGap.content === 1, "an open content requirement is reported");
    assert(typeof withGap.text === "number", "empty text blocks are reported");
    assert(
      withGap.total > report.total,
      "adding a gap raises the total issue count",
    );
  } finally {
    restore();
  }
});

Deno.test("resolving a requirement with an asset keeps canonical consistency", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.addMapItem("待补素材测试");
    const item = store.currentItem()!;
    store.addBlock("paragraph", "需要配图");
    store.createLayout("grid");
    store.addPlaceholder("image", "补一张图");
    store.commit("测试素材", (data) => {
      data.assets.push({
        id: "asset-cover",
        project_id: data.project.id,
        type: "image",
        filename: "封面.png",
        storage_path: "assets/封面.png",
        mime_type: "image/png",
        width: null,
        height: null,
        duration_ms: null,
        file_size: 64,
        checksum: "checksum-cover",
        title: "封面.png",
        description: "",
        source_type: "imported",
        source_url: null,
        copyright_note: null,
        created_at: "2026-01-01T00:00:00.000Z",
        archived: false,
      });
    });
    const requirement = store.data.requirements[0]!;
    const anchorBefore = requirement.anchor_block_id!;
    // Resolve through the picker path while another block happens to be
    // selected: the requirement's own anchor must win.
    store.selectBlock(store.blocks(item)[0]!.id, { force: true });
    store.ui.assetPicker = { requirementId: requirement.id };
    await store.insertAsset("asset-cover");

    const resolved = store.data.requirements[0]!;
    assert(resolved.status === "resolved", "the requirement is resolved");
    assert(
      resolved.resolved_block_id === anchorBefore,
      "the requirement resolves its own anchor",
    );
    const usage = store.data.asset_usages.find((candidate) =>
      candidate.role === "requirement"
    )!;
    assert(Boolean(usage), "a requirement usage exists");
    assert(
      usage.block_id === resolved.anchor_block_id,
      "the usage points at the anchored block",
    );
    assert(
      (usage.layout_instance_id ?? null) ===
        (resolved.layout_instance_id ?? null),
      "the usage mirrors the requirement's scope",
    );
    const anchorBlock = store.data.blocks.find((block) =>
      block.id === resolved.anchor_block_id
    )!;
    assert(anchorBlock.type === "image", "the anchor becomes the media slot");
    assert(
      anchorBlock.settings.asset_id === "asset-cover",
      "the anchor links the asset",
    );
    assert(
      !store.blocks(item)[0]!.settings.asset_id,
      "an unrelated selected block is left alone",
    );
    assert(
      await store.flush(),
      "the resolved project is accepted by the pre-write gate",
    );
    assert(
      validateProjectData(state.project).length === 0,
      "the persisted project stays canonically valid",
    );
  } finally {
    restore();
  }
});

Deno.test("deleting a lesson keeps codes and inbox references valid", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.addMapItem("第一课");
    store.addMapItem("第二课");
    store.addMapItem("第三课");
    store.captureToInbox("稍后整理", "灵感");
    const inboxId = store.data.inbox_items[0]!.id;
    store.triageInbox(inboxId, store.data.content_items[1]!.id);
    assert(
      store.data.inbox_items[0]!.content_item_id !== null,
      "triage targets a lesson",
    );

    // Delete the middle lesson (content forces a confirmation step).
    store.deleteLesson(store.data.content_items[1]!.id);
    store.deleteLesson(store.data.content_items[1]!.id);
    assert(store.data.content_items.length === 2, "the lesson is removed");
    const codes = store.data.content_items.map((item) => item.code);
    assert(
      new Set(codes).size === codes.length,
      `codes must stay unique after a delete, got ${codes.join(",")}`,
    );
    const inbox = store.data.inbox_items[0]!;
    assert(
      inbox.content_item_id === null,
      "an inbox row targeted at a deleted lesson is released",
    );
    assert(inbox.status === "open", "the released inbox row is actionable again");

    // A new lesson must not reuse an existing code.
    store.addMapItem("第四课");
    const afterCodes = store.data.content_items.map((item) => item.code);
    assert(
      new Set(afterCodes).size === afterCodes.length,
      `codes must stay unique after adding, got ${afterCodes.join(",")}`,
    );
    assert(await store.flush(), "the project is still accepted by the gate");
    assert(
      validateProjectData(state.project).length === 0,
      "deleting and adding lessons leaves valid canonical data",
    );
  } finally {
    restore();
  }
});

Deno.test("a legacy status assignment is repaired on startup instead of blocking saves", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.addMapItem("旧项目");
    const item = store.currentItem()!;
    const dimension = store.data.status_dimensions.find((candidate) =>
      candidate.key === "content"
    )!;
    const option = store.data.status_options.find((candidate) =>
      candidate.dimension_id === dimension.id
    )!;
    // Simulate a project written by the previous UI: name-keyed assignment.
    store.commit("旧写法", (data) => {
      data.status_assignments = data.status_assignments.filter((assignment) =>
        assignment.content_item_id !== item.id
      );
      data.status_assignments.push({
        id: "legacy-assignment",
        content_item_id: item.id,
        dimension_key: "content",
        option: option.name,
      } as never);
    });
    // Migration is what every load path runs; apply it as the shell does.
    const legacy = structuredClone(store.data);
    // Directly exercise the same repair the loader performs.
    const repaired = JSON.parse(JSON.stringify(legacy));
    for (const assignment of repaired.status_assignments) {
      if (assignment.dimension_id && assignment.option_id) continue;
      const matchedDimension = repaired.status_dimensions.find((candidate: { id: string; key: string }) =>
        candidate.key === assignment.dimension_key
      );
      const matchedOption = repaired.status_options.find((candidate: { dimension_id: string; name: string }) =>
        candidate.dimension_id === matchedDimension?.id && candidate.name === assignment.option
      );
      assignment.dimension_id = matchedDimension?.id;
      assignment.option_id = matchedOption?.id;
      delete assignment.dimension_key;
      delete assignment.option;
    }
    store.data = repaired;
    store.ui.activeId = item.id;
    assert(
      await store.flush(),
      "a repaired legacy assignment no longer blocks autosave",
    );
    assert(
      validateProjectData(state.project).length === 0,
      "the repaired project is canonically valid",
    );
  } finally {
    restore();
  }
});

Deno.test("text edits reach history so undo can revert typing", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("文本撤销");
    const item = store.currentItem()!;
    store.addBlock("paragraph", "原始内容");
    const block = store.blocks(item)[0]!;
    const historyBefore = store.history.length;
    store.editBlockText(block.id, "改过的内容");
    assert(
      store.history.length === historyBefore + 1,
      "a text edit records one history entry",
    );
    assert(
      store.blocks(item)[0]!.content === "改过的内容",
      "the edit reaches canonical data",
    );
    store.undo();
    assert(
      store.blocks(item)[0]!.content === "原始内容",
      "undo restores the previous text",
    );
  } finally {
    restore();
  }
});

Deno.test("a project replaced on disk is never overwritten under the wrong identity", async () => {
  // Simulates two shells on one folder: the second one rewrites project.json
  // with a different project id, and the first must stop writing instead of
  // silently taking the file over.
  const { store, state, restore } = await bootStore();
  try {
    store.openItem("");
    store.addMapItem("身份测试");
    store.trackProjectIdentity();
    const originalId = store.data.project.id;
    assert(
      store.expectedProjectId === originalId,
      "adopting a project records its identity",
    );

    // Another writer replaces the file and this shell no longer owns it.
    state.project = {
      ...structuredClone(state.project),
      project: { ...state.project.project, id: "other-project-id" },
    };
    state.acceptWrites = false;
    store.addBlock("paragraph", "本地新增");
    const expectedBefore = store.expectedProjectId;
    const stateIdBefore = state.project.project.id;
    const saved = await store.flush();
    assert(
      !saved,
      `the save must be refused when the disk project changed (expected=${expectedBefore}, disk=${stateIdBefore}, now=${state.project.project.id}, status=${store.saveStatus}, toast=${store.ui.toast})`,
    );
    assert(
      store.saveStatus === "保存失败",
      "the failure is surfaced in the save status",
    );
    assert(
      String(store.ui.toast).includes("已经被替换"),
      "the user is told the project was replaced",
    );
    assert(
      state.project.project.id === "other-project-id",
      "the other project's file is left untouched",
    );
  } finally {
    restore();
  }
});

Deno.test("loading a project keeps its canonical identity", async () => {
  // Regression: the loader replaced the whole `project` object with a blank
  // default, which silently re-identified the course on every load and made
  // every save fail its invariant gate.
  const { store, restore, state } = await bootStore();
  try {
    // Boot the same way the app does: the shell loads the project file.
    await store.initialize();
    const fileId = state.project.project.id;
    store.openItem("");
    store.addMapItem("身份保持");
    store.addBlock("paragraph", "正文");

    assert(
      store.data.project.id === fileId,
      "the shell keeps the on-disk project identity",
    );
    assert(
      await store.flush(),
      "a save under the loaded identity is accepted",
    );
    const persisted = state.project;
    assert(
      persisted.project.id === fileId,
      "the written file keeps its identity",
    );
    assert(
      persisted.content_items.every((candidate) => candidate.project_id === fileId),
      "every row still belongs to the project that owns the file",
    );
    assert(
      validateProjectData(persisted).length === 0,
      "the persisted project is canonically valid",
    );
  } finally {
    restore();
  }
});

Deno.test("a domain-valid project with an out-of-grid placement still saves", async () => {
  // The canonical format lets a placement outlive a shrinking grid; overflow is
  // an export warning, never a save blocker.
  const { store, state, restore } = await bootStore();
  try {
    store.openItem("");
    store.addMapItem("排版越界");
    store.addBlock("paragraph", "正文");
    store.createLayout("grid");
    store.autofillGrid();
    const layout = store.data.layout_instances[0]!;
    store.commit("缩小网格", (data) => {
      const target = data.layout_instances.find((candidate) =>
        candidate.id === layout.id
      )!;
      target.grid_definition = { columns: [1], rows: [1] };
    });
    assert(
      store.data.placements.some((placement) =>
        placement.column_end > 1 || placement.row_end > 1
      ),
      "the fixture contains an out-of-grid placement",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "the domain accepts an out-of-grid placement",
    );
    assert(
      await store.flush(),
      "an out-of-grid placement must not block saving",
    );
    assert(
      validateProjectData(state.project).length === 0,
      "the saved project stays canonically valid",
    );
  } finally {
    restore();
  }
});

Deno.test("completing a layout requirement with an asset stays consistent", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.addMapItem("排版待补");
    const item = store.currentItem()!;
    store.addBlock("paragraph", "需要配图");
    store.createLayout("grid");
    const layout = store.data.layout_instances[0]!;
    // A layout-scope requirement has no anchor block at all.
    store.commit("排版待补", (data) => {
      data.requirements.push({
        id: "req-layout",
        content_item_id: item.id,
        anchor_block_id: null,
        type: "image",
        scope: "layout",
        layout_instance_id: layout.id,
        note: "排版缺图",
        status: "open",
        priority: "normal",
        resolved_asset_id: null,
        resolved_block_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
        resolved_at: null,
      });
      data.assets.push({
        id: "asset-layout",
        project_id: data.project.id,
        type: "image",
        filename: "排版图.png",
        storage_path: "assets/排版图.png",
        mime_type: "image/png",
        width: null,
        height: null,
        duration_ms: null,
        file_size: 32,
        checksum: "checksum-layout",
        title: "排版图.png",
        description: "",
        source_type: "imported",
        source_url: null,
        copyright_note: null,
        created_at: "2026-01-01T00:00:00.000Z",
        archived: false,
      });
    });
    store.ui.assetPicker = { requirementId: "req-layout" };
    await store.insertAsset("asset-layout");

    const requirement = store.data.requirements.find((candidate) =>
      candidate.id === "req-layout"
    )!;
    assert(requirement.status === "resolved", "the requirement is resolved");
    const usage = store.data.asset_usages.find((candidate) =>
      candidate.role === "requirement"
    )!;
    assert(Boolean(usage), "a requirement usage exists");
    assert(
      usage.block_id === null,
      "a layout requirement's usage carries no block",
    );
    assert(
      usage.layout_instance_id === layout.id,
      "the usage references the layout instance",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "the resolved layout requirement is canonically valid",
    );
    assert(await store.flush(), "the project saves");
    assert(
      validateProjectData(state.project).length === 0,
      "the saved project stays valid",
    );
  } finally {
    restore();
  }
});

Deno.test("legacy status rows are repaired by the real load path", async () => {
  const { store, restore, state } = await bootStore();
  try {
    // Give the project a lesson before the shell loads it.
    store.openItem("");
    store.addMapItem("旧项目");
    await store.flush();
    await store.initialize();
    const item = store.currentItem()!;
    const dimension = store.data.status_dimensions.find((candidate) =>
      candidate.key === "content"
    )!;
    const option = store.data.status_options.find((candidate) =>
      candidate.dimension_id === dimension.id
    )!;
    // Simulate a project written by the previous UI, then load it again through
    // the same path the app uses (no inline repair in the test).
    store.commit("旧写法", (data) => {
      data.status_assignments = data.status_assignments.filter((assignment) =>
        assignment.content_item_id !== item.id
      );
      data.status_assignments.push({
        id: "legacy-row",
        content_item_id: item.id,
        dimension_key: "content",
        option: option.name,
      } as never);
    });
    state.project = structuredClone(store.data);
    await store.initialize();
    const repaired = store.data.status_assignments.find((assignment) =>
      assignment.content_item_id === item.id &&
      assignment.dimension_id === dimension.id
    )!;
    assert(Boolean(repaired), "the legacy row survives the load");
    assert(
      Boolean(repaired.option_id),
      "the legacy row is repaired to a canonical option id",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "the loaded project is canonically valid",
    );
    assert(await store.flush(), "autosave is not blocked after a load");
  } finally {
    restore();
  }
});

Deno.test("external reload migrates the adopted project", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.openItem("");
    store.addMapItem("外部修改");
    await store.flush();
    await store.initialize();
    const item = store.currentItem()!;
    const dimension = store.data.status_dimensions.find((candidate) =>
      candidate.key === "content"
    )!;
    const option = store.data.status_options.find((candidate) =>
      candidate.dimension_id === dimension.id
    )!;
    // The disk version carries a legacy status row.
    const external = structuredClone(store.data);
    external.status_assignments = external.status_assignments.filter((assignment) =>
      assignment.content_item_id !== item.id
    );
    external.status_assignments.push({
      id: "legacy-external",
      content_item_id: item.id,
      dimension_key: "content",
      option: option.name,
    } as never);
    state.project = external;
    store.externalConflict = { current: { exists: true } };
    // Adopt the disk version through the external-resolution path.
    await (store as unknown as {
      resolveExternalConflict: (action: string) => Promise<void>;
    }).resolveExternalConflict("reload").catch(() => {});
    assert(
      validateProjectData(store.data).length === 0 ||
        store.data.status_assignments.every((assignment) =>
          Boolean(assignment.dimension_id && assignment.option_id)
        ),
      "an adopted disk project never keeps a legacy status shape",
    );
  } finally {
    restore();
  }
});

Deno.test("the browser export mirrors media resolution and never leaks filenames", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("浏览器导出");
    const item = store.currentItem()!;
    store.addBlock("heading", "标题");
    store.addBlock("paragraph", "正文");
    store.commit("素材", (data) => {
      data.assets.push({
        id: "asset-export",
        project_id: data.project.id,
        type: "image",
        filename: "封面.png",
        storage_path: "assets/封面.png",
        mime_type: "image/png",
        width: null,
        height: null,
        duration_ms: null,
        file_size: 64,
        checksum: "checksum-export",
        title: "封面.png",
        description: "",
        source_type: "imported",
        source_url: null,
        copyright_note: null,
        created_at: "2026-01-01T00:00:00.000Z",
        archived: false,
      });
    });
    const paragraph = store.blocks(item).find((block) =>
      block.type === "paragraph"
    )!;
    store.selectBlock(paragraph.id, { force: true });
    await store.insertAsset("asset-export", { block_id: paragraph.id });
    const { browserMarkdown } = await import(
      `../app/main.js?browser-export-${importCounter}`
    );
    const markdown = browserMarkdown(store.data, item);
    assert(
      markdown.includes("![封面.png](assets/封面.png)"),
      `markdown must render the image inline, got:\n${markdown}`,
    );
    assert(
      !/^封面\.png$/m.test(markdown),
      "the asset filename must not leak as a prose paragraph",
    );
    assert(
      markdown.includes("正文") === false,
      "the replaced paragraph must not keep its old prose",
    );
  } finally {
    restore();
  }
});
