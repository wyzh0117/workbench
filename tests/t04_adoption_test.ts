/**
 * V1-T04 Task 12 — In-place folder adoption after confirm (Strategy A).
 *
 * Spec: package §§32–35, 25. Confirm first; apply writes Canonical in-place.
 * Non-destructive: originals are never moved/renamed/deleted.
 */
import { join } from "node:path";
import { createEmptyProjectData } from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";
import { DesktopService } from "../src/service/desktop.ts";
import {
  buildImportMappingPlan,
  confirmImportMappingPlan,
  setImportMappingRole,
  setImportMappingSelected,
  type ImportMappingPlan,
} from "../src/service/folder_mapping.ts";
import { scanFolder } from "../src/service/folder_scan.ts";
import {
  confirmFolderAdoption,
  type FolderAdoptionResult,
} from "../src/service/folder_adoption.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function fingerprintOriginals(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === "project.json" || entry.name === ".workspace" ||
        entry.name === "assets")
      {
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
  await Deno.writeTextFile(join(root, "01-基础", "导论.md"), "# 导论\n第一课正文\n");
  await Deno.writeTextFile(join(root, "01-基础", "大纲.docx"), "docx-bytes");
  await Deno.writeFile(
    join(root, "01-基础", "intro.png"),
    new Uint8Array([1, 2, 3, 4]),
  );
  await Deno.writeTextFile(join(root, "02-进阶", "第二课.md"), "## 二\n进阶内容\n");
  await Deno.writeFile(
    join(root, "02-进阶", "demo.mp4"),
    new Uint8Array([9, 8, 7]),
  );
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

Deno.test("Strategy A in-place adoption writes project.json + .workspace; originals unchanged", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-adopt-inplace-" });
  try {
    await seedCourseFolder(root);
    const before = await fingerprintOriginals(root);
    const plan = await confirmedPlanFor(root, (p) =>
      setImportMappingSelected(p, "weird.bin", false));
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

Deno.test("selected+ignore and unselected files are not imported", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-adopt-ignore-" });
  try {
    await seedCourseFolder(root);
    const plan = await confirmedPlanFor(root, (p) => {
      let next = setImportMappingSelected(p, "01-基础/intro.png", false);
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
      !result.data.content_items.some((item) =>
        /weird|bin/i.test(item.title)
      ),
      "unsupported/unselected must stay out",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("same checksum reuses existing Asset; same name different bytes does not silent-overwrite", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-adopt-dup-" });
  try {
    await Deno.mkdir(join(root, "media"), { recursive: true });
    const bytesA = new Uint8Array([10, 20, 30, 40]);
    const bytesB = new Uint8Array([10, 20, 30, 99]); // same name later, different bytes
    await Deno.writeFile(join(root, "media", "shot.png"), bytesA);
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
    await Deno.writeFile(join(root, "media", "shot-copy.png"), bytesA);
    const report2 = await scanFolder(root);
    let plan2 = buildImportMappingPlan(report2.root, report2.entries);
    plan2 = setImportMappingSelected(plan2, "readme.md", false);
    plan2 = setImportMappingRole(plan2, "media/shot-copy.png", "asset");
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
    await Deno.mkdir(join(root, "media2"), { recursive: true });
    await Deno.writeFile(join(root, "media2", "shot.png"), bytesB);
    const report3 = await scanFolder(root);
    let plan3 = buildImportMappingPlan(report3.root, report3.entries);
    plan3 = setImportMappingRole(plan3, "media2/shot.png", "asset");
    plan3 = setImportMappingSelected(plan3, "media2/shot.png", true);
    // Deselect everything else to keep focus on conflict.
    for (const item of plan3.items) {
      if (item.relative_path !== "media2/shot.png") {
        plan3 = setImportMappingSelected(plan3, item.relative_path, false);
      }
    }
    plan3 = confirmImportMappingPlan(plan3);
    const conflicted = await confirmFolderAdoption(plan3, {
      data: reused.data,
      project_root: root,
      skip_project_write: true,
    });
    const originals = await Deno.readFile(join(root, "media", "shot.png"));
    assert(
      Array.from(originals).join(",") === Array.from(bytesA).join(","),
      "original media/shot.png bytes must stay intact",
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
        "01-基础/导论.md",
        "lesson",
      ));
    const result = await confirmFolderAdoption(plan);
    const lesson = result.data.content_items.find((item) =>
      item.title.includes("导论") || item.code.includes("01")
    );
    assert(lesson, "导论.md mapped as lesson must create a ContentItem");
    const blocks = result.data.blocks.filter((block) => {
      const doc = result.data.documents.find((d) =>
        d.id === block.document_id
      );
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

Deno.test("folder.adopt command applies confirmed plan into the chosen folder", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-adopt-cmd-" });
  const serviceRoot = await Deno.makeTempDir({ prefix: "acw-t04-adopt-svc-" });
  try {
    await seedCourseFolder(root);
    const before = await fingerprintOriginals(root);
    const plan = await confirmedPlanFor(root);
    const desktop = new DesktopService(serviceRoot);
    const executed = await desktop.commands.execute("folder.adopt", { plan });
    assert(!executed.error, `folder.adopt failed: ${JSON.stringify(executed.error)}`);
    const value = executed.value as FolderAdoptionResult;
    assert(value?.data?.project?.id, "folder.adopt must return adopted project");
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

async function bootStore() {
  const source = createEmptyProjectData("接管 UI 测试");
  const state: {
    project: ProjectData;
    writes: number;
    adopts: unknown[];
  } = {
    project: structuredClone(source) as ProjectData,
    writes: 0,
    adopts: [],
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
    readRecoveryJournal: async () => null,
    listenNativeDrops: async () => () => {},
    writeRecoveryJournal: async () => {},
    writeProject: async (project: ProjectData) => {
      state.writes += 1;
      state.project = structuredClone(project);
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
        return {
          root: String(input.path || "/tmp/course"),
          entries: [
            {
              path: "/tmp/course/01-基础",
              relative_path: "01-基础",
              kind: "directory",
              mime: null,
              size: null,
              suggested_role: "stage",
            },
            {
              path: "/tmp/course/01-基础/导论.md",
              relative_path: "01-基础/导论.md",
              kind: "file",
              mime: "text/markdown",
              size: 12,
              suggested_role: "lesson",
            },
            {
              path: "/tmp/course/01-基础/intro.png",
              relative_path: "01-基础/intro.png",
              kind: "file",
              mime: "image/png",
              size: 3,
              suggested_role: "asset",
            },
          ],
          warnings: [],
          errors: [],
        };
      }
      if (name === "folder.adopt") {
        state.adopts.push({ name, input });
        const plan = input.plan as ImportMappingPlan;
        assert(plan?.confirmed === true, "UI must only adopt confirmed plans");
        const adopted = createEmptyProjectData("已接管课程");
        adopted.stages.push({
          id: "stage-1",
          project_id: adopted.project.id,
          parent_stage_id: null,
          code: "S01",
          title: "01-基础",
          description: "",
          learning_action: "",
          order_index: 0,
          archived: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        state.project = adopted;
        state.writes += 1;
        return {
          data: adopted,
          root: plan.root,
          stage_ids: ["stage-1"],
          content_item_ids: [],
          asset_ids: [],
          source_ids: [],
          reused_asset_ids: [],
          warnings: [],
          copied_files: [],
        };
      }
      if (name === "ai.connection.list") return { providers: [] };
      if (name === "ai.execution.list") return { records: [] };
      throw new Error(`unexpected command ${name}`);
    },
  };
  const store = new (WorkbenchStore as new (bridge: unknown) => {
    data: ProjectData;
    ui: Record<string, unknown>;
    importExistingFolder: (dir: string) => Promise<void>;
    openImportMappingPreview: () => void;
    confirmImportMapping: () => void;
    applyFolderAdoption: () => Promise<void>;
    notify: () => void;
  })(bridge);
  store.data = structuredClone(state.project);
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

Deno.test("UI confirm then apply: apply consumes confirmed plan and writes Canonical", async () => {
  const { store, state, restore } = await bootStore();
  try {
    await store.importExistingFolder("/tmp/course");
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
      html.includes("确认导入计划"),
      "confirm control must remain available before apply",
    );

    store.confirmImportMapping();
    assert(
      (store.ui.importMappingPlan as ImportMappingPlan).confirmed === true,
      "confirm marks plan",
    );
    const adoptsBeforeApply = state.adopts.length;
    assert(adoptsBeforeApply === 0, "confirm alone must not adopt");

    html = createViews(store).shellView() as string;
    assert(
      html.includes("写入课程项目") || html.includes("开始接管") ||
        html.includes("data-action=\"apply-folder-adoption\""),
      "after confirm, UI must expose apply/adoption action",
    );

    await store.applyFolderAdoption();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const adoptsAfter = state.adopts.length;
    assert(
      adoptsAfter === 1,
      `apply must call folder.adopt once (got ${adoptsAfter})`,
    );
    assert(state.writes >= 1, "apply must persist Canonical project");
    assert(
      store.data.stages.some((stage) => stage.title === "01-基础"),
      "store must load adopted Canonical stages",
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
  }
});
