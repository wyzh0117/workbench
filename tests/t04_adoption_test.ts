/**
 * V1-T04 Task 12 — In-place folder adoption after confirm (Strategy A).
 *
 * Spec: package §§32–35, 25. Confirm first; apply writes Canonical in-place.
 * Non-destructive: originals are never moved/renamed/deleted.
 */
import { join } from "node:path";
import {
  addPlacement,
  appendBlock,
  buildBlueprintDraft,
  confirmBlueprint,
  createEmptyProjectData,
  createExportPreset,
  createCourseSeed,
  createLayoutInstance,
  exportProject,
  movePlacementToPage,
  preflightExport,
} from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";
import { DesktopService } from "../src/service/desktop.ts";
import {
  buildImportMappingPlan,
  confirmImportMappingPlan,
  scanFolderDocuments,
  type ImportMappingPlan,
  setImportMappingAllowDuplicate,
  setImportMappingDestination,
  setImportMappingRole,
  setImportMappingSelected,
} from "../src/service/folder_mapping.ts";
import { scanFolder } from "../src/service/folder_scan.ts";
import {
  confirmFolderAdoption,
  type FolderAdoptionResult,
} from "../src/service/folder_adoption.ts";
import { addLayoutPage, createPagedLayout } from "../app/layout_pages.js";
import { buildPublicationProjection } from "../app/publication.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function fingerprintOriginals(
  root: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      if (
        entry.name === "project.json" || entry.name === ".workspace" ||
        entry.name === "assets"
      ) {
        continue;
      }
      const path = join(dir, entry.name);
      const rel = path.slice(root.length).replace(/^[\\/]/, "").replaceAll(
        "\\",
        "/",
      );
      if (entry.isSymlink) {
        out.set(rel, `symlink:${await Deno.readLink(path)}`);
        continue;
      }
      if (entry.isDirectory) {
        out.set(rel, "dir");
        await walk(path);
        continue;
      }
      if (entry.isFile) {
        const bytes = await Deno.readFile(path);
        const stat = await Deno.lstat(path);
        out.set(rel, `file:${stat.size}:${Array.from(bytes).join(",")}`);
      }
    }
  }
  await walk(root);
  return out;
}

async function seedCourseFolder(root: string): Promise<void> {
  await Deno.mkdir(join(root, "01-基础"), { recursive: true });
  await Deno.mkdir(join(root, "02-进阶"), { recursive: true });
  // Root-level files are the selected plan. Nested children remain present to
  // assert that shallow scans never pull them in implicitly.
  await Deno.writeTextFile(join(root, "导论.md"), "# 导论\n第一课正文\n");
  await Deno.writeTextFile(join(root, "大纲.docx"), "docx-bytes");
  await Deno.writeFile(join(root, "intro.png"), new Uint8Array([1, 2, 3, 4]));
  await Deno.writeTextFile(join(root, "第二课.md"), "## 二\n进阶内容\n");
  await Deno.writeFile(join(root, "demo.mp4"), new Uint8Array([9, 8, 7]));
  await Deno.writeTextFile(join(root, "01-基础", "内部.md"), "不能默认导入");
  await Deno.writeTextFile(join(root, "02-进阶", "内部.md"), "不能默认导入");
  await Deno.writeFile(join(root, "总体说明.pdf"), new Uint8Array([6, 6, 6]));
  await Deno.writeTextFile(join(root, "notes.txt"), "纯文本笔记");
  await Deno.writeTextFile(join(root, "weird.bin"), "bin");
}

async function confirmedPlanFor(
  root: string,
  edit?: (plan: ImportMappingPlan) => ImportMappingPlan,
): Promise<ImportMappingPlan> {
  const report = await scanFolder(root);
  let plan = buildImportMappingPlan(report.root, report.entries);
  if (edit) plan = edit(plan);
  return confirmImportMappingPlan(plan);
}

Deno.test("unconfirmed plan must not be applied (§31/§32)", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-adopt-unconfirmed-" });
  try {
    await seedCourseFolder(root);
    const report = await scanFolder(root);
    const plan = buildImportMappingPlan(report.root, report.entries);
    assert(plan.confirmed === false, "fixture starts unconfirmed");
    let threw = false;
    try {
      await confirmFolderAdoption(plan);
    } catch {
      threw = true;
    }
    assert(threw, "unconfirmed plan must throw and not apply");
    assert(
      !(await Deno.stat(join(root, "project.json")).then(() => true).catch(() =>
        false
      )),
      "unconfirmed apply must not write project.json",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Deno adopt refuses when project.json already exists (matches native)", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-adopt-exists-" });
  try {
    await seedCourseFolder(root);
    const first = await confirmedPlanFor(
      root,
      (p) => setImportMappingSelected(p, "weird.bin", false),
    );
    await confirmFolderAdoption(first);
    assert(
      await Deno.stat(join(root, "project.json")).then((s) => s.isFile),
      "first adopt writes project.json",
    );
    const again = await confirmedPlanFor(
      root,
      (p) => setImportMappingSelected(p, "weird.bin", false),
    );
    let threw = false;
    let message = "";
    try {
      await confirmFolderAdoption(again);
    } catch (caught) {
      threw = true;
      message = caught instanceof Error ? caught.message : String(caught);
    }
    assert(threw, "second adopt into existing project.json must fail");
    assert(
      /已有 project\.json|不能重复|打开现有项目/.test(message),
      `must mention existing project.json (got: ${message})`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Strategy A in-place adoption writes project.json + .workspace; originals unchanged", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-adopt-inplace-" });
  try {
    await seedCourseFolder(root);
    const before = await fingerprintOriginals(root);
    const plan = await confirmedPlanFor(
      root,
      (p) => setImportMappingSelected(p, "weird.bin", false),
    );
    const result = await confirmFolderAdoption(plan);
    const after = await fingerprintOriginals(root);

    assert(
      await Deno.stat(join(root, "project.json")).then((s) => s.isFile),
      "Strategy A must write project.json in the chosen folder",
    );
    assert(
      await Deno.stat(join(root, ".workspace")).then((s) => s.isDirectory),
      "Strategy A must create .workspace metadata",
    );
    assert(
      JSON.stringify([...before.entries()].sort()) ===
        JSON.stringify([...after.entries()].sort()),
      "original user files must not be moved/renamed/deleted or rewritten",
    );
    assert(result.data.stages.length >= 2, "selected stages become Canonical");
    assert(
      result.data.content_items.some((item) => item.type === "lesson"),
      "selected lessons become Canonical content",
    );
    assert(
      result.data.assets.some((asset) => asset.type === "image"),
      "selected media become managed Assets",
    );
    assert(
      result.data.inbox_items.some((item) =>
        item.source_type === "source" || item.source_type === "reference"
      ),
      "Source/Reference must be recorded (not silent Canonical lessons)",
    );
    assert(
      !result.copied_original_paths?.length,
      "adoption must not report originals as copied-away",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("adopted folder can page and export while source files stay unchanged (§12.2)", async () => {
  const root = await Deno.makeTempDir({
    prefix: "acw-t04-adopt-paged-export-",
  });
  try {
    await seedCourseFolder(root);
    const before = await fingerprintOriginals(root);
    const adopted = await confirmFolderAdoption(await confirmedPlanFor(root));
    const data = adopted.data;
    const lesson = data.content_items.find((item) => item.type === "lesson");
    assert(lesson, "folder adoption must create a lesson for pagination");

    const block = appendBlock(
      data,
      lesson.id,
      "paragraph",
      "接管后分页导出正文",
    );
    const layout = createLayoutInstance(data, lesson.id, {
      name: "接管后分页布局",
      mode: "grid",
      grid_definition: { columns: [1], rows: [1] },
    });
    const firstPage = createPagedLayout(data, layout.id)[0];
    assert(firstPage, "paged layout must create its first page");
    const secondPage = addLayoutPage(data, layout.id, {
      title: "接管后第二页",
      grid_definition: { columns: [1], rows: [1] },
    });
    const placement = addPlacement(data, layout.id, block.id, {
      row_start: 0,
      row_end: 1,
      column_start: 0,
      column_end: 1,
    });
    movePlacementToPage(data, placement.id, secondPage.id);

    const preset = createExportPreset(data, {
      name: "接管后分页 HTML",
      output_type: "html",
      platform: "网页",
    });
    const selection = {
      content_item_id: lesson.id,
      layout_instance_id: layout.id,
    };
    const projection = buildPublicationProjection(data, selection);
    const pages = projection.lessons[0]?.layout?.pages;
    assert(
      pages?.length === 2 && pages[1]?.items[0]?.block_id === block.id,
      "shared page mutation must appear in the export projection",
    );
    const report = await preflightExport(data, preset, {
      ...selection,
      project_root: root,
      projection,
    });
    assert(
      report.ok && report.blocking.length === 0,
      "adopted paged HTML preflight must pass",
    );
    const exported = await exportProject(data, preset, {
      ...selection,
      project_root: root,
      projection,
      snapshot_revision: report.snapshot_revision,
      acknowledged_warnings: [
        ...new Set(report.warnings.map((issue) => issue.code)),
      ],
    });
    assert(
      new TextDecoder().decode(exported.files[0]!.bytes).includes(
        "接管后分页导出正文",
      ),
      "HTML export must include the placed block from the adopted project",
    );

    const after = await fingerprintOriginals(root);
    assert(
      JSON.stringify([...before.entries()].sort()) ===
        JSON.stringify([...after.entries()].sort()),
      "pagination and export must leave all original folder paths and bytes unchanged",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("selected+ignore and unselected files are not imported", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-adopt-ignore-" });
  try {
    await seedCourseFolder(root);
    const plan = await confirmedPlanFor(root, (p) => {
      let next = setImportMappingSelected(p, "intro.png", false);
      next = setImportMappingRole(next, "notes.txt", "ignore");
      // selected + ignore must still be treated as ignore
      next = setImportMappingSelected(next, "notes.txt", true);
      next = setImportMappingRole(next, "notes.txt", "ignore");
      return next;
    });
    const notes = plan.items.find((item) => item.relative_path === "notes.txt");
    assert(notes?.mapping === "ignore", "notes mapped ignore");
    assert(
      notes?.selected === false || notes?.mapping === "ignore",
      "ignore mapping must exclude the file",
    );

    const result = await confirmFolderAdoption(plan);
    assert(
      !result.data.assets.some((asset) => asset.filename === "intro.png"),
      "deselected asset must not be imported",
    );
    assert(
      !result.data.content_items.some((item) => item.title.includes("notes")),
      "ignore-mapped txt must not become a lesson",
    );
    assert(
      !result.data.inbox_items.some((item) => item.title.includes("notes")),
      "ignore-mapped txt must not become a Source either",
    );
    assert(
      !result.data.content_items.some((item) => /weird|bin/i.test(item.title)),
      "unsupported/unselected must stay out",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("same checksum reuses existing Asset; same name different bytes does not silent-overwrite", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-adopt-dup-" });
  try {
    const bytesA = new Uint8Array([10, 20, 30, 40]);
    const bytesB = new Uint8Array([10, 20, 30, 99]); // same name later, different bytes
    await Deno.writeFile(join(root, "shot.png"), bytesA);
    await Deno.writeTextFile(join(root, "readme.md"), "# hi\n");

    // First adoption seeds an asset.
    const plan1 = await confirmedPlanFor(root);
    const first = await confirmFolderAdoption(plan1);
    const existing = first.data.assets.find((asset) =>
      asset.filename === "shot.png"
    );
    assert(existing, "first adoption must import shot.png");
    const storage1 = existing.storage_path;
    assert(
      storage1.startsWith("assets/") && storage1.includes("shot.png"),
      "asset path must be assets/{id}-{filename}",
    );

    // Second adoption into the same project data: identical checksum → reuse.
    await Deno.writeFile(join(root, "shot-copy.png"), bytesA);
    const report2 = await scanFolder(root);
    let plan2 = buildImportMappingPlan(report2.root, report2.entries);
    plan2 = setImportMappingSelected(plan2, "readme.md", false);
    plan2 = setImportMappingRole(plan2, "shot-copy.png", "asset");
    plan2 = confirmImportMappingPlan(plan2);
    const reused = await confirmFolderAdoption(plan2, {
      data: first.data,
      project_root: root,
      skip_project_write: true,
    });
    const copyAsset = reused.data.assets.find((asset) =>
      asset.filename === "shot-copy.png" ||
      (asset.checksum === existing.checksum && asset.id === existing.id)
    );
    assert(
      reused.reused_asset_ids.includes(existing.id) ||
        (copyAsset && copyAsset.id === existing.id),
      "identical checksum must reuse existing Asset",
    );
    assert(
      reused.warnings.some((w) => /复用|已存在|checksum/i.test(w)),
      "reuse must be surfaced as a warning/prompt signal",
    );

    // Same filename, different bytes → new assets/{id}-shot.png, no overwrite.
    const otherSource = await Deno.makeTempDir({ prefix: "acw-t04-adopt-dup-source-" });
    await Deno.writeFile(join(otherSource, "shot.png"), bytesB);
    const report3 = await scanFolder(otherSource);
    let plan3 = buildImportMappingPlan(report3.root, report3.entries);
    plan3 = setImportMappingRole(plan3, "shot.png", "asset");
    plan3 = setImportMappingSelected(plan3, "shot.png", true);
    // Deselect everything else to keep focus on conflict.
    for (const item of plan3.items) {
      if (item.relative_path !== "shot.png") {
        plan3 = setImportMappingSelected(plan3, item.relative_path, false);
      }
    }
    plan3 = confirmImportMappingPlan(plan3);
    const conflicted = await confirmFolderAdoption(plan3, {
      data: reused.data,
      project_root: root,
      skip_project_write: true,
    });
    const originals = await Deno.readFile(join(root, "shot.png"));
    assert(
      Array.from(originals).join(",") === Array.from(bytesA).join(","),
      "original shot.png bytes must stay intact",
    );
    const managed = await Deno.readFile(join(root, storage1));
    assert(
      Array.from(managed).join(",") === Array.from(bytesA).join(","),
      "first managed asset must not be silently overwritten",
    );
    const newAsset = conflicted.data.assets.find((asset) =>
      asset.checksum !== existing.checksum && asset.filename === "shot.png"
    );
    assert(newAsset, "different bytes must create a distinct Asset record");
    assert(
      newAsset.storage_path !== storage1,
      "same name different bytes → distinct assets/{id}-{filename}",
    );
    assert(
      newAsset.storage_path.startsWith("assets/") &&
        newAsset.storage_path.includes("-shot.png"),
      "collision path must keep id-prefixed filename",
    );
    await Deno.remove(otherSource, { recursive: true });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("markdown lesson becomes Canonical blocks; docx/pdf stay Source/Reference", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-adopt-roles-" });
  try {
    await seedCourseFolder(root);
    const plan = await confirmedPlanFor(root, (p) =>
      setImportMappingRole(
        setImportMappingSelected(p, "weird.bin", false),
        "导论.md",
        "lesson",
      ));
    const result = await confirmFolderAdoption(plan);
    const lesson = result.data.content_items.find((item) =>
      item.title.includes("导论") || item.code.includes("01")
    );
    assert(lesson, "导论.md mapped as lesson must create a ContentItem");
    const blocks = result.data.blocks.filter((block) => {
      const doc = result.data.documents.find((d) => d.id === block.document_id);
      return doc?.content_item_id === lesson.id;
    });
    assert(blocks.length > 0, "lesson markdown must become Canonical blocks");
    assert(
      result.data.assets.some((asset) =>
        asset.filename.endsWith(".docx") || asset.filename.endsWith(".pdf") ||
        asset.type === "document"
      ) ||
        result.data.inbox_items.some((item) =>
          item.source_type === "reference"
        ),
      "docx/pdf default to Source/Reference, not Lesson body",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("asset promotion failure leaves Canonical manifest uncommitted", async () => {
  const root = await Deno.makeTempDir({
    prefix: "acw-t04-adopt-promote-fail-",
  });
  try {
    await Deno.writeFile(
      join(root, "shot.png"),
      new Uint8Array([1, 2, 3]),
    );
    await Deno.writeTextFile(join(root, "readme.md"), "# hi\n");
    // Block assets/ so promotion fails before the Canonical manifest commit.
    await Deno.writeTextFile(join(root, "assets"), "not-a-directory");

    const plan = await confirmedPlanFor(root);
    let threw = false;
    let message = "";
    try {
      await confirmFolderAdoption(plan);
    } catch (caught) {
      threw = true;
      message = caught instanceof Error ? caught.message : String(caught);
    }
    assert(threw, "promote failure must surface");
    assert(
      /assets/.test(message),
      `promotion error must be surfaced (got: ${message})`,
    );
    assert(
      await Deno.stat(join(root, "project.json")).then(() => false).catch(() => true),
      "project.json must not be committed when assets cannot be promoted",
    );
    const stagingDir = join(root, ".workspace", "adopt-staging");
    let stagedTransactions = 0;
    try {
      for await (const _ of Deno.readDir(stagingDir)) stagedTransactions += 1;
    } catch {
      // Empty staging parent may be removed eagerly.
    }
    assert(stagedTransactions === 0, "the failed transaction's staging must be cleaned");
    assert(
      Array.from(await Deno.readFile(join(root, "shot.png"))).join(",") === "1,2,3",
      "promotion failure must preserve original source bytes",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("append commit failure removes only transaction-owned promoted assets", async () => {
  const target = await Deno.makeTempDir({ prefix: "acw-t04-append-target-" });
  const source = await Deno.makeTempDir({ prefix: "acw-t04-append-source-" });
  try {
    await Deno.writeFile(join(target, "old.png"), new Uint8Array([4, 5, 6]));
    const initialPlan = await confirmedPlanFor(target);
    const initial = await confirmFolderAdoption(initialPlan);
    const oldAsset = initial.data.assets.find((asset) => asset.filename === "old.png");
    assert(oldAsset, "initial project has old asset");
    const oldBytes = await Deno.readFile(join(target, oldAsset.storage_path));
    const manifestBefore = await Deno.readTextFile(join(target, "project.json"));

    await Deno.writeFile(join(source, "new.png"), new Uint8Array([7, 8, 9]));
    const plan = await confirmedPlanFor(source);
    const appendData = structuredClone(initial.data);
    let threw = false;
    try {
      await confirmFolderAdoption(plan, {
        data: appendData,
        project_root: target,
        persist_project: async () => {
          throw new Error("simulated external modification conflict");
        },
      });
    } catch {
      threw = true;
    }
    assert(threw, "failed canonical commit must surface");
    assert(
      await Deno.readTextFile(join(target, "project.json")) === manifestBefore,
      "failed append must leave the old Canonical manifest unchanged",
    );
    assert(
      Array.from(await Deno.readFile(join(target, oldAsset.storage_path))).join(",") === Array.from(oldBytes).join(","),
      "failed append must preserve old managed assets",
    );
    assert(
      Array.from(await Deno.readFile(join(source, "new.png"))).join(",") === "7,8,9",
      "failed append must preserve the source file",
    );
    const newAsset = appendData.assets.find((asset) => asset.filename === "new.png");
    assert(newAsset, "failed in-memory candidate records its owned asset");
    assert(
      await Deno.stat(join(target, newAsset.storage_path)).then(() => false).catch(() => true),
      "failed append must roll back its transaction-owned promoted asset",
    );
    const staging = join(target, ".workspace", "adopt-staging");
    let stagedTransactions = 0;
    try {
      for await (const _ of Deno.readDir(staging)) stagedTransactions += 1;
    } catch {
      // An empty parent may be absent on a platform that removes it eagerly.
    }
    assert(stagedTransactions === 0, "failed append must clean only its own staging directory");
  } finally {
    await Deno.remove(target, { recursive: true });
    await Deno.remove(source, { recursive: true });
  }
});

Deno.test("folder.adopt command applies confirmed plan into the chosen folder", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-adopt-cmd-" });
  const serviceRoot = await Deno.makeTempDir({ prefix: "acw-t04-adopt-svc-" });
  try {
    await seedCourseFolder(root);
    const before = await fingerprintOriginals(root);
    const plan = await confirmedPlanFor(root);
    const desktop = new DesktopService(serviceRoot);
    const executed = await desktop.commands.execute("folder.adopt", { plan });
    assert(
      !executed.error,
      `folder.adopt failed: ${JSON.stringify(executed.error)}`,
    );
    const value = executed.value as FolderAdoptionResult;
    assert(
      value?.data?.project?.id,
      "folder.adopt must return adopted project",
    );
    assert(
      await Deno.stat(join(root, "project.json")).then((s) => s.isFile),
      "command must write project.json in plan.root",
    );
    const after = await fingerprintOriginals(root);
    assert(
      JSON.stringify([...before.entries()].sort()) ===
        JSON.stringify([...after.entries()].sort()),
      "command must leave originals unchanged",
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
    await Deno.remove(serviceRoot, { recursive: true }).catch(() => {});
  }
});

let importCounter = 0;

async function createUiLessonFolder(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "acw-adoption-ui-source-" });
  await Deno.mkdir(join(root, "01-基础"));
  await Deno.writeTextFile(
    join(root, "01-基础", "导论.md"),
    "# 导论\n\n第一课正文\n",
  );
  return root;
}

/**
 * §18 inserts a body-document dialog between confirming the mapping plan and
 * writing anything, so a plan that carries document candidates now needs a second
 * click. These tests assert the import behind that click, so the dialog is answered
 * with its default — every row already selected — which leaves the plan byte-for-byte
 * what the preview confirmed.
 */
async function acceptDocumentImportDialog(store: {
  ui: Record<string, unknown>;
  confirmDocumentImportSelection: () => Promise<void>;
}) {
  if (!store.ui.documentImportDialog) return;
  await store.confirmDocumentImportSelection();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function bootStore(projectRoot = "") {
  const source = createEmptyProjectData("接管 UI 测试");
  const seed = createCourseSeed(source, {
    source_type: "blank",
    raw_text: "# 原有课程\n已有正文",
  });
  const draft = buildBlueprintDraft(source, seed.id);
  confirmBlueprint(source, draft.id);
  const existingItem = source.content_items[0];
  if (existingItem) appendBlock(source, existingItem.id, "paragraph", "稳定的既有内容");
  const state: {
    project: ProjectData;
    writes: number;
    adopts: unknown[];
    appends: unknown[];
    adoptFailure: string;
  } = {
    project: structuredClone(source) as ProjectData,
    writes: 0,
    adopts: [],
    appends: [],
    adoptFailure: "",
  };
  let revision = 1;
  const fingerprintFor = (project: ProjectData, version: number) => ({
    exists: true,
    mtime_ms: 1_780_000_000_000 + version,
    size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
    hash: version.toString(16).padStart(64, "0"),
  });
  const currentFingerprint = () => fingerprintFor(state.project, revision);
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
    `../app/main.js?t04-adoption-${importCounter}`
  );
  const bridge = {
    projectDir: null as string | null,
    projectDirFromUrl: false,
    isNative: () => false,
    currentProject: () => state.project,
    loadSession: async () => null,
    readProject: async () => structuredClone(state.project),
    readProjectState: async () => ({
      project: structuredClone(state.project),
      fingerprint: currentFingerprint(),
    }),
    readRecoveryJournal: async () => null,
    listenNativeDrops: async () => () => {},
    writeRecoveryJournal: async () => {},
    writeProject: async (project: ProjectData, expectedFingerprint: unknown) => {
      if (JSON.stringify(expectedFingerprint) !== JSON.stringify(currentFingerprint())) {
        throw new Error("external_modification_conflict");
      }
      state.writes += 1;
      state.project = structuredClone(project);
      revision += 1;
      return { fingerprint: currentFingerprint(), recovery_warning: null };
    },
    clearRecoveryJournal: async () => {},
    saveSession: async () => {},
    createSnapshot: async () => ({}),
    setProjectDir: (dir: string) => {
      bridge.projectDir = dir;
    },
    restoreProjectDir: () => {},
    projectIdentity: async () => state.project.project.id,
    command: async (name: string, input: Record<string, unknown> = {}) => {
      if (name === "folder.scan") {
        return await scanFolder(String(input.path || input.root || ""));
      }
      if (name === "folder.scan_documents") {
        return await scanFolderDocuments(
          String(input.root || ""),
          input.plan as ImportMappingPlan,
        );
      }
      if (name === "folder.adopt") {
        state.adopts.push({ name, input });
        if (state.adoptFailure) throw new Error(state.adoptFailure);
        const plan = input.plan as ImportMappingPlan;
        assert(plan?.confirmed === true, "UI must only adopt confirmed plans");
        const result = await confirmFolderAdoption(plan, {
          document_paths: Array.isArray(input.document_paths)
            ? input.document_paths.map(String)
            : [],
        });
        state.project = structuredClone(result.data);
        state.writes += 1;
        revision += 1;
        return result;
      }
      if (name === "folder.append") {
        state.appends.push({ name, input });
        const plan = input.plan as ImportMappingPlan;
        assert(plan?.confirmed === true, "append UI must only write a confirmed plan");
        return await confirmFolderAdoption(plan, {
          data: structuredClone(state.project),
          project_root: projectRoot || plan.root,
          document_paths: Array.isArray(input.document_paths)
            ? input.document_paths.map(String)
            : [],
          persist_project: async (project) => {
            state.project = structuredClone(project);
            state.writes += 1;
            revision += 1;
          },
        });
      }
      if (name === "ai.connection.list") return { providers: [] };
      if (name === "ai.execution.list") return { records: [] };
      throw new Error(`unexpected command ${name}`);
    },
  };
  const store = new (WorkbenchStore as new (bridge: unknown) => {
    data: ProjectData;
    ui: Record<string, unknown>;
    importExistingFolder: (dir: string, mode?: string) => Promise<void>;
    openImportMappingPreview: () => void;
    confirmImportMapping: () => Promise<void>;
    applyFolderAdoption: () => Promise<void>;
    confirmDocumentImportSelection: () => Promise<void>;
    undo: () => void;
    redo: () => void;
    adoptProjectSnapshot: (state: unknown) => boolean;
    flush: () => Promise<boolean>;
    history: unknown[];
    future: unknown[];
    blocks: (item?: unknown) => ProjectData["blocks"];
    notify: () => void;
  })(bridge);
  if (!store.adoptProjectSnapshot({
    project: structuredClone(state.project),
    fingerprint: currentFingerprint(),
  })) {
    throw new Error("test bridge must seed a valid project/fingerprint pair");
  }
  return {
    store,
    state,
    bridge,
    restore: () => {
      runtime.document = previousDocument;
      runtime.__TAURI__ = previousTauri;
      globalThis.fetch = previousFetch;
    },
  };
}

Deno.test("UI confirmation performs one adopt action and keeps row controls distinct", async () => {
  const sourceRoot = await createUiLessonFolder();
  const { store, state, restore } = await bootStore();
  try {
    await store.importExistingFolder(sourceRoot);
    store.openImportMappingPreview();
    assert(store.ui.importMappingPlan, "preview must exist");
    assert(
      (store.ui.importMappingPlan as ImportMappingPlan).confirmed === false,
      "preview unconfirmed",
    );

    const { createViews } = await import(
      `../app/views.js?t04-adoption-view-${importCounter}`
    );
    let html = createViews(store).shellView() as string;
    assert(
      html.includes("确认并追加到当前课程") || html.includes("确认导入计划并打开"),
      "single final confirm control must be available",
    );
    assert(
      html.includes("data-mapping-row") && html.includes("data-mapping-select"),
      "mapping rows and keyboard checkbox control must both be present",
    );

    await store.confirmImportMapping();
    assert(
      (store.ui.importMappingPlan as ImportMappingPlan).confirmed === true,
      "confirm marks the plan before executing it",
    );
    await acceptDocumentImportDialog(store);
    const adoptsAfter = state.adopts.length;
    assert(
      adoptsAfter === 1,
      `one confirm must call folder.adopt once (got ${adoptsAfter})`,
    );
    assert(
      JSON.stringify((state.adopts[0] as { input: Record<string, unknown> }).input.document_paths) ===
        JSON.stringify(["01-基础/导论.md"]),
      "the chooser's checked direct-child path must reach the executor",
    );
    assert(state.writes >= 1, "apply must persist Canonical project");
    assert(
      store.data.stages.some((stage) => stage.title === "01-基础"),
      "store must load adopted Canonical stages",
    );
    const lesson = store.data.content_items.find((item) => item.title === "导论");
    assert(lesson, "the executor must create the selected document as a Lesson");
    const importedBlocks = store.data.blocks.filter((block) =>
      block.document_id === lesson.document_id
    );
    assert(
      importedBlocks.some((block) => block.type === "heading" && block.content === "导论") &&
        importedBlocks.some((block) => block.type === "paragraph" && String(block.content ?? "").trim() === "第一课正文"),
      "the actual executor parse must preserve Markdown heading and paragraph blocks",
    );
    assert(
      typeof store.ui.toast === "string" &&
        /接管|写入|已导入|课程项目/.test(String(store.ui.toast)),
      `toast should confirm in-place adoption completed (got: ${
        JSON.stringify(store.ui.toast)
      })`,
    );
  } finally {
    restore();
    await Deno.remove(sourceRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test("failed import keeps the editable plan, shows a persistent safe reason, and can retry", async () => {
  const sourceRoot = await createUiLessonFolder();
  const { store, state, restore } = await bootStore();
  try {
    await store.importExistingFolder(sourceRoot);
    store.openImportMappingPreview();
    const originalItems = structuredClone(
      (store.ui.importMappingPlan as ImportMappingPlan).items,
    );
    state.adoptFailure = "permission denied";

    await store.confirmImportMapping();
    await acceptDocumentImportDialog(store);

    const plan = store.ui.importMappingPlan as ImportMappingPlan;
    assert(!plan.confirmed, "a failed pre-commit import must unlock the plan");
    assert(!store.ui.importingMapping, "busy state must clear after failure");
    assert(
      JSON.stringify(plan.items) === JSON.stringify(originalItems),
      "failure must keep the user's plan choices",
    );
    assert(
      String(store.ui.importMappingError).includes("检查项目目录权限"),
      "the actionable error must remain in UI state after the toast expires",
    );

    const { createViews } = await import(
      `../app/views.js?t04-adoption-retry-view-${importCounter}`
    );
    const failedHtml = createViews(store).shellView() as string;
    assert(failedHtml.includes('role="alert"'), "the error must be announced accessibly");
    assert(
      failedHtml.includes("确认导入计划并打开"),
      "the error state must leave the original confirmation action available for retry",
    );
    assert(
      failedHtml.includes('data-action="confirm-import-mapping"'),
      "the confirmation action must be restored after failure",
    );
    assert(
      !failedHtml.includes("data-action=\"confirm-import-mapping\" disabled"),
      "the failed import must not strand the confirmation button",
    );

    state.adoptFailure = "";
    await store.confirmImportMapping();
    await acceptDocumentImportDialog(store);
    assert(state.adopts.length === 2, "a second confirmation must retry the same plan");
    assert(String(store.ui.route) === "map", "successful retry must open the course map");
    assert(!store.ui.importMappingError, "success must clear the persistent error");
    assert(
      store.data.blocks.some((block) => block.type === "heading" && block.content === "导论") &&
        store.data.blocks.some((block) => block.type === "paragraph" && String(block.content ?? "").trim() === "第一课正文"),
      "the successful retry must execute the real Markdown parser and write its blocks",
    );
  } finally {
    restore();
    await Deno.remove(sourceRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test("folder append is one undoable Canonical change and never removes source files", async () => {
  const sourceRoot = await Deno.makeTempDir({ prefix: "acw-append-undo-source-" });
  const projectRoot = await Deno.makeTempDir({ prefix: "acw-append-undo-project-" });
  const sourceFile = join(sourceRoot, "lesson.md");
  await Deno.writeTextFile(sourceFile, "# 追加正文\n\n来源文件保留\n");
  const { store, state, restore } = await bootStore(projectRoot);
  try {
    const existing = store.data.blocks.at(-1)!;
    const original = structuredClone(store.data);
    const existingId = existing.id;
    const selectedId = existing.id;
    store.ui.selectedBlockId = selectedId;
    const historyBefore = store.history.length;

    await store.importExistingFolder(sourceRoot, "append");
    store.openImportMappingPreview();
    await store.confirmImportMapping();
    await acceptDocumentImportDialog(store);

    assert(state.appends.length === 1, "confirmed append should execute once");
    const imported = store.data.blocks.find((block) =>
      block.type === "heading" && block.content === "追加正文"
    );
    assert(imported, "the execution-time Markdown parse should append its heading to Canonical");
    const importedId = imported.id;
    assert(store.history.length === historyBefore + 1, "append should add exactly one undo entry");
    assert((store.history.at(-1) as { label: string }).label === "追加文件夹资料", "undo history should explain the append");

    store.undo();
    await store.flush();
    assert(store.data.blocks.some((block) => block.id === existingId), "undo should retain prior IDs");
    assert(!store.data.blocks.some((block) => block.id === importedId), "undo should remove the imported rows from Canonical");
    assert(store.ui.selectedBlockId === selectedId, "undo should keep a still-valid selection");
    assert(store.data.project.id === original.project.id, "undo should keep the project identity");
    assert(!state.project.blocks.some((block) => block.id === importedId), "undo should persist the old Canonical project");
    assert((await Deno.stat(sourceFile)).isFile, "undo must not delete the original source file");

    store.redo();
    await store.flush();
    assert(store.data.blocks.some((block) => block.id === importedId), "redo should restore the same imported block ID");
    assert(state.project.blocks.some((block) => block.id === importedId), "redo should persist the appended project");
    assert((await Deno.stat(sourceFile)).isFile, "redo must leave the original source file untouched");
    assert(
      await Deno.readTextFile(sourceFile) === "# 追加正文\n\n来源文件保留\n",
      "the executor must parse a copy while keeping source bytes unchanged",
    );
  } finally {
    restore();
    await Deno.remove(sourceRoot, { recursive: true }).catch(() => {});
    await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test("Markdown import keeps missing local image refs visible and cleans only its own staging on failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-adopt-md-missing-" });
  try {
    await Deno.mkdir(join(root, "images"), { recursive: true });
    await Deno.writeFile(join(root, "images/present.png"), new Uint8Array([1, 2, 3]));
    const markdown = "# Lesson\n\n![present](images/present.png)\n\n![missing](images/missing.png)\n";
    await Deno.writeTextFile(join(root, "lesson.md"), markdown);
    const plan = await confirmedPlanFor(root, (current) => {
      current = setImportMappingRole(current, "lesson.md", "lesson");
      return setImportMappingRole(current, "images", "ignore");
    });
    const result = await confirmFolderAdoption(plan);
    assert(result.asset_ids.length === 1, "only the existing referenced image becomes an asset");
    assert(result.data.asset_usages.length === 1, "only the existing image receives an usage");
    assert(
      result.warnings.some((warning) => warning.includes("images/missing.png")),
      "missing href is reported with its original relative path",
    );
    assert(
      result.data.blocks.some((block) => typeof block.content === "string" && block.content.includes("images/missing.png")),
      "unresolved image Markdown remains in the authored block",
    );
    assert(await Deno.readTextFile(join(root, "lesson.md")) === markdown, "source Markdown is unchanged");

    const failingRoot = await Deno.makeTempDir({ prefix: "acw-adopt-md-unsafe-" });
    try {
      await Deno.mkdir(join(failingRoot, "images"), { recursive: true });
      await Deno.mkdir(join(failingRoot, ".workspace/adopt-staging"), { recursive: true });
      await Deno.writeTextFile(join(failingRoot, ".workspace/adopt-staging/legacy.keep"), "old");
      await Deno.writeFile(join(failingRoot, "images/present.png"), new Uint8Array([4, 5, 6]));
      const unsafeMarkdown = "![present](images/present.png)\n\n![escape](../../outside.png)\n";
      await Deno.writeTextFile(join(failingRoot, "lesson.md"), unsafeMarkdown);
      const unsafePlan = await confirmedPlanFor(failingRoot, (current) => {
        current = setImportMappingRole(current, "lesson.md", "lesson");
        return setImportMappingRole(current, "images", "ignore");
      });
      let failed = false;
      try {
        await confirmFolderAdoption(unsafePlan);
      } catch {
        failed = true;
      }
      assert(failed, "path traversal remains a hard failure");
      assert(!(await Deno.stat(join(failingRoot, "project.json")).then(() => true).catch(() => false)), "failed transaction writes no manifest");
      const remaining = [];
      for await (const entry of Deno.readDir(join(failingRoot, ".workspace/adopt-staging"))) remaining.push(entry.name);
      assert(remaining.length === 1 && remaining[0] === "legacy.keep", "only this transaction's UUID staging is removed");
      assert(await Deno.readTextFile(join(failingRoot, "lesson.md")) === unsafeMarkdown, "failure never changes source Markdown");
    } finally {
      await Deno.remove(failingRoot, { recursive: true });
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("append targets a lesson, preserves its edits/pages, and skips Markdown duplicates unless acknowledged", async () => {
  const targetRoot = await Deno.makeTempDir({ prefix: "acw-append-target-destination-" });
  const sourceRoot = await Deno.makeTempDir({ prefix: "acw-append-source-destination-" });
  try {
    await Deno.writeTextFile(join(targetRoot, "existing.md"), "# Existing\n");
    const initial = await confirmFolderAdoption(await confirmedPlanFor(targetRoot));
    const data = initial.data;
    const lesson = data.content_items.find((item) => item.type === "lesson");
    assert(lesson, "target project starts with one lesson");
    appendBlock(data, lesson.id, "paragraph", "用户已经编辑的内容");
    const originalBlockIds = data.blocks.filter((block) =>
      data.documents.find((document) => document.id === block.document_id)?.content_item_id === lesson.id
    ).map((block) => block.id);
    const layout = createLayoutInstance(data, lesson.id, {
      name: "保留分页",
      mode: "grid",
      grid_definition: { columns: [1], rows: [1] },
    });
    createPagedLayout(data, layout.id);
    const secondPage = addLayoutPage(data, layout.id, {
      title: "第二页",
      grid_definition: { columns: [1], rows: [1] },
    });
    const originalPages = structuredClone(data.layout_pages);

    await Deno.mkdir(join(sourceRoot, "images"), { recursive: true });
    const markdown = "# Imported\n\n![diagram](images/diagram.png)\n";
    const imageBytes = new Uint8Array([12, 34, 56]);
    await Deno.writeTextFile(join(sourceRoot, "lesson.md"), markdown);
    await Deno.writeFile(join(sourceRoot, "images/diagram.png"), imageBytes);

    const appendPlan = async (relativePath: string, allowDuplicate = false) =>
      await confirmedPlanFor(sourceRoot, (plan) => {
        for (const entry of plan.items) {
          if (entry.kind === "directory") {
            plan = setImportMappingRole(plan, entry.relative_path, "ignore");
          } else if (entry.relative_path !== relativePath) {
            plan = setImportMappingSelected(plan, entry.relative_path, false);
          }
        }
        plan = setImportMappingRole(plan, relativePath, "lesson");
        plan = setImportMappingDestination(plan, relativePath, {
          kind: "existing_lesson",
          content_item_id: lesson.id,
        });
        if (allowDuplicate) plan = setImportMappingAllowDuplicate(plan, relativePath, true);
        return plan;
      });

    const first = await confirmFolderAdoption(await appendPlan("lesson.md"), {
      data,
      project_root: targetRoot,
      skip_project_write: true,
    });
    assert(first.data.project.id === data.project.id, "append keeps project identity");
    assert(first.data.content_items.length === 1, "existing lesson target does not create another lesson");
    assert(first.data.blocks.some((block) => block.content === "用户已经编辑的内容"), "existing edits remain");
    for (const blockId of originalBlockIds) {
      assert(first.data.blocks.some((block) => block.id === blockId), "existing block identity remains");
    }
    assert(JSON.stringify(first.data.layout_pages) === JSON.stringify(originalPages), "all existing pages remain unchanged");
    assert(first.data.layout_pages.some((page) => page.id === secondPage.id), "second page identity survives append");
    const provenanceBlock = first.data.blocks.find((block) => {
      const provenance = block.settings.markdown_import;
      return Boolean(provenance && typeof provenance === "object" && !Array.isArray(provenance) && provenance.source_hash);
    });
    assert(provenanceBlock, "imported block stores compatibility source hash provenance");
    const blockProvenance = provenanceBlock.settings.markdown_import as Record<string, unknown>;
    const ledger = first.data.project.settings.markdown_import_sources;
    assert(Array.isArray(ledger) && ledger.some((source) =>
      source && typeof source === "object" && !Array.isArray(source) &&
      source.source_hash === blockProvenance.source_hash
    ), "project-level import ledger records source provenance");
    const firstSourceHash = String(blockProvenance.source_hash);
    assert(first.data.asset_usages.some((usage) => usage.content_item_id === lesson.id), "imported Markdown image usage points at target lesson");
    assert(await Deno.readTextFile(join(sourceRoot, "lesson.md")) === markdown, "source stays untouched");

    // The durable project ledger survives editing away the compatibility block copy.
    first.data.blocks = first.data.blocks.filter((block) => block.id !== provenanceBlock.id);
    const beforeDuplicate = structuredClone(first.data);
    const renamedMarkdown = "# Imported\n\n![diagram](images/diagram.png)\n";
    await Deno.writeTextFile(join(sourceRoot, "renamed.md"), renamedMarkdown);
    const duplicate = await confirmFolderAdoption(await appendPlan("renamed.md"), {
      data: first.data,
      project_root: targetRoot,
      skip_project_write: true,
    });
    assert(duplicate.data.blocks.length === beforeDuplicate.blocks.length, "same SHA still skips after deleting the provenance block");
    assert(duplicate.warnings.some((warning) => warning.includes("SHA-256") && warning.includes("默认跳过")), "duplicate skip explains its source match");

    const deletedLesson = structuredClone(duplicate.data);
    const deletedDocumentIds = new Set(deletedLesson.documents
      .filter((document) => document.content_item_id === lesson.id)
      .map((document) => document.id));
    const deletedBlockIds = new Set(deletedLesson.blocks
      .filter((block) => deletedDocumentIds.has(block.document_id))
      .map((block) => block.id));
    const deletedLayoutIds = new Set(deletedLesson.layout_instances
      .filter((layout) => layout.content_item_id === lesson.id)
      .map((layout) => layout.id));
    deletedLesson.blocks = deletedLesson.blocks.filter((block) => !deletedDocumentIds.has(block.document_id));
    deletedLesson.documents = deletedLesson.documents.filter((document) => !deletedDocumentIds.has(document.id));
    deletedLesson.content_items = deletedLesson.content_items.filter((item) => item.id !== lesson.id);
    deletedLesson.requirements = deletedLesson.requirements.filter((requirement) =>
      requirement.content_item_id !== lesson.id && !deletedBlockIds.has(requirement.anchor_block_id || "")
    );
    deletedLesson.asset_usages = deletedLesson.asset_usages.filter((usage) =>
      usage.content_item_id !== lesson.id && !deletedBlockIds.has(usage.block_id || "")
    );
    deletedLesson.placements = deletedLesson.placements.filter((placement) =>
      !deletedLayoutIds.has(placement.layout_instance_id) && !deletedBlockIds.has(placement.block_id)
    );
    deletedLesson.layout_sections = deletedLesson.layout_sections.filter((section) =>
      !deletedLayoutIds.has(section.layout_instance_id)
    );
    deletedLesson.layout_pages = deletedLesson.layout_pages.filter((page) =>
      !deletedLayoutIds.has(page.layout_instance_id)
    );
    deletedLesson.layout_instances = deletedLesson.layout_instances.filter((layout) => layout.content_item_id !== lesson.id);
    deletedLesson.groups = deletedLesson.groups.filter((group) => !deletedDocumentIds.has(group.document_id));
    deletedLesson.status_assignments = deletedLesson.status_assignments.filter((assignment) =>
      assignment.content_item_id !== lesson.id
    );
    deletedLesson.publications = deletedLesson.publications.filter((publication) =>
      publication.content_item_id !== lesson.id
    );
    const afterLessonDelete = await confirmFolderAdoption(await appendPlan("renamed.md"), {
      data: deletedLesson,
      project_root: targetRoot,
      skip_project_write: true,
    });
    assert(afterLessonDelete.data.content_items.length === 0, "the project ledger survives whole-lesson deletion");
    assert(afterLessonDelete.data.blocks.length === 0, "a deleted lesson stays deleted on duplicate detection");
    assert(afterLessonDelete.warnings.some((warning) => warning.includes("目标课时已删除")), "deleted lesson source match is explained");
    const explicitReimport = await confirmedPlanFor(sourceRoot, (plan) => {
      for (const entry of plan.items) {
        if (entry.kind === "directory") plan = setImportMappingRole(plan, entry.relative_path, "ignore");
        else if (entry.relative_path !== "renamed.md") plan = setImportMappingSelected(plan, entry.relative_path, false);
      }
      plan = setImportMappingRole(plan, "renamed.md", "lesson");
      plan = setImportMappingDestination(plan, "renamed.md", { kind: "unassigned_lesson" });
      return setImportMappingAllowDuplicate(plan, "renamed.md", true);
    });
    const reimported = await confirmFolderAdoption(explicitReimport, {
      data: afterLessonDelete.data,
      project_root: targetRoot,
      skip_project_write: true,
    });
    assert(reimported.data.content_items.length === 1, "explicit duplicate choice can recreate a deliberately deleted lesson");
    assert(reimported.warnings.some((warning) => warning.includes("按当前目标新建或追加")), "deleted-target reimport warning describes the actual destination action");
    await Deno.writeTextFile(join(sourceRoot, "lesson.md"), "# Revision after deletion\n");
    const deletedTargetRevisionPlan = await confirmedPlanFor(sourceRoot, (plan) => {
      for (const entry of plan.items) {
        if (entry.kind === "directory") plan = setImportMappingRole(plan, entry.relative_path, "ignore");
        else if (entry.relative_path !== "lesson.md") plan = setImportMappingSelected(plan, entry.relative_path, false);
      }
      plan = setImportMappingRole(plan, "lesson.md", "lesson");
      plan = setImportMappingDestination(plan, "lesson.md", { kind: "unassigned_lesson" });
      return setImportMappingAllowDuplicate(plan, "lesson.md", true);
    });
    const reimportedRevision = await confirmFolderAdoption(deletedTargetRevisionPlan, {
      data: reimported.data,
      project_root: targetRoot,
      skip_project_write: true,
    });
    assert(reimportedRevision.warnings.some((warning) => warning.includes("曾删除课时") && warning.includes("按当前目标新建或追加")), "explicit changed-source reimport must describe the deleted target accurately");

    const changed = "# Imported revision\n";
    await Deno.writeTextFile(join(sourceRoot, "lesson.md"), changed);
    const changedPlan = await appendPlan("lesson.md");
    const skippedRevision = await confirmFolderAdoption(changedPlan, {
      data: first.data,
      project_root: targetRoot,
      skip_project_write: true,
    });
    assert(skippedRevision.data.blocks.length === beforeDuplicate.blocks.length, "changed source defaults to no replacement or append");
    assert(skippedRevision.warnings.some((warning) => warning.includes("来源路径已有较旧导入")), "changed source is reported for explicit handling");

    const explicitRevision = await confirmFolderAdoption(await appendPlan("lesson.md", true), {
      data: first.data,
      project_root: targetRoot,
      skip_project_write: true,
    });
    assert(explicitRevision.data.content_items.length === 1, "explicit revision still targets the selected lesson");
    assert(explicitRevision.data.blocks.some((block) => block.content === "用户已经编辑的内容"), "explicit new version never overwrites manual edits");
    assert(explicitRevision.data.blocks.some((block) => block.content === "Imported revision"), "explicit new version appends parsed content");
    assert(explicitRevision.warnings.some((warning) => warning.includes("用户已明确选择导入来源的新版本")), "explicit revision records the user's choice");

    const revisionLedger = explicitRevision.data.project.settings.markdown_import_sources;
    assert(Array.isArray(revisionLedger), "version ledger is an array");
    const latestImported = revisionLedger.at(-1);
    assert(latestImported && typeof latestImported === "object" && !Array.isArray(latestImported), "version ledger retains the latest source record");
    const secondSourceHash = String((latestImported as Record<string, unknown>).source_hash || "");
    const thirdRevision = "# Imported third revision\n";
    await Deno.writeTextFile(join(sourceRoot, "lesson.md"), thirdRevision);
    const thirdVersion = await confirmFolderAdoption(await appendPlan("lesson.md"), {
      data: explicitRevision.data,
      project_root: targetRoot,
      skip_project_write: true,
    });
    assert(thirdVersion.data.blocks.length === explicitRevision.data.blocks.length, "third source version defaults to skip");
    const thirdWarning = thirdVersion.warnings.find((warning) => warning.includes("来源路径已有较旧导入")) || "";
    assert(thirdWarning.includes(secondSourceHash.slice(0, 12)), "changed-source warning names the latest explicitly imported SHA");
    assert(!thirdWarning.includes(firstSourceHash.slice(0, 12)), "changed-source warning does not report the stale v1 SHA");
  } finally {
    await Deno.remove(targetRoot, { recursive: true }).catch(() => {});
    await Deno.remove(sourceRoot, { recursive: true }).catch(() => {});
  }
});
