/**
 * Batch asset import (item 12).
 *
 * The native picker may return many files at once, so the whole batch must
 * behave as one unit: every readable file imports even when a sibling fails,
 * checksum reuse is reported as a duplicate instead of a failure, and the
 * landed rows are undone in a single history step.
 */
import {
  appendBlock,
  createDocument,
  createEmptyProjectData,
  initializeContentStatuses,
  now,
} from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";
import { PROJECT_FILE_PICKER } from "../app/constants.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function projectWith(title: string): ProjectData {
  const data = createEmptyProjectData(title);
  const stage = data.stages[0];
  const contentId = crypto.randomUUID();
  const document = createDocument(data, contentId);
  data.content_items.push({
    id: contentId,
    project_id: data.project.id,
    stage_id: stage?.id ?? null,
    code: "S01-01",
    title: `${title} 第一课`,
    type: "lesson",
    description: "",
    order_index: 0,
    document_id: document.id,
    archived: false,
    created_at: now(),
    updated_at: now(),
  });
  initializeContentStatuses(data, contentId);
  appendBlock(data, contentId, "paragraph", `${title} 的正文`);
  return data;
}

type ImportCall = { name: string; input: Record<string, unknown> };

const assetRow = (projectId: string, id: string, filename: string) => ({
  id,
  project_id: projectId,
  type: "image" as const,
  filename,
  storage_path: `assets/${id}-${filename}`,
  mime_type: "image/png",
  width: null,
  height: null,
  duration_ms: null,
  file_size: 12,
  checksum: `sum-${id}`,
  title: filename,
  description: "",
  source_type: "imported" as const,
  source_url: null,
  copyright_note: null,
  created_at: now(),
  archived: false,
});

/**
 * Native shell whose `asset.import` answers like the real adapters do:
 * `{status, duplicate, asset}` for a new file, `duplicate: true` with the
 * existing row on a checksum hit, and a thrown error for an unreadable path.
 */
function importBridge(options: {
  paths?: string[];
  failFor?: (path: string) => boolean;
  duplicates?: string[];
} = {}) {
  const project = projectWith("批量导入");
  for (const path of options.duplicates ?? []) {
    project.assets.push(assetRow(project.project.id, "asset-existing", path) as never);
  }
  const calls: ImportCall[] = [];
  const imported: string[] = [];
  const bridge: any = {
    projectDir: "/tmp/batch",
    projectDirFromUrl: false,
    isNative: () => true,
    importCalls: calls,
    selectFiles: async () => [...(options.paths ?? [])],
    selectFile: async () => (options.paths ?? [])[0] ?? null,
    currentProject: () => project,
    setProjectDir: () => {},
    restoreProjectDir: () => {},
    readProject: async () => structuredClone(project),
    readRecoveryJournal: async () => null,
    listenNativeDrops: async () => () => {},
    writeRecoveryJournal: async () => {},
    writeProject: async (value: ProjectData) => {
      project.assets = structuredClone(value.assets);
      project.asset_usages = structuredClone(value.asset_usages ?? []);
    },
    clearRecoveryJournal: async () => {},
    projectIdentity: async () => project.project.id,
    saveSession: async () => {},
    loadSession: async () => null,
    closeProject: async () => {},
    command: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      if (name !== "asset.import") return {};
      const key = String(input.source_path ?? input.filename ?? "");
      if (options.failFor?.(key)) throw new Error(`无法读取素材来源: ${key}`);
      if (options.duplicates?.includes(key)) {
        return {
          status: "existing",
          duplicate: true,
          asset: structuredClone(project.assets.find((asset) => asset.filename === key)),
        };
      }
      const assetId = `asset-${imported.length + 1}`;
      imported.push(key);
      return {
        status: "imported",
        duplicate: false,
        asset: assetRow(project.project.id, assetId, key),
      };
    },
  };
  return bridge;
}

let importCounter = 0;

async function bootStore(bridge: unknown) {
  importCounter += 1;
  const runtime = globalThis as typeof globalThis & { document?: unknown };
  const previousDocument = runtime.document;
  runtime.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  const { WorkbenchStore } = await import(
    `../app/main.js?asset-batch-${importCounter}`
  );
  const store = new (WorkbenchStore as new (bridge: unknown) => any)(bridge);
  store.data = structuredClone((bridge as any).currentProject());
  return {
    store,
    restore: () => {
      runtime.document = previousDocument;
      clearTimeout(store.saveTimer);
      clearTimeout(store.sessionTimer);
    },
  };
}

Deno.test("native multi-select import runs one batch and undoes as one step", async () => {
  const bridge = importBridge({ paths: ["/pick/a.png", "/pick/b.png", "/pick/c.png"] });
  const { store, restore } = await bootStore(bridge);
  try {
    await store.selectAndImportAsset();
    const imports = bridge.importCalls.filter((call: ImportCall) => call.name === "asset.import");
    assert(imports.length === 3, `three picked files must produce three imports, got ${imports.length}`);
    assert(
      imports.every((call: ImportCall) =>
        Object.keys(call.input).sort().join(",") === "filename,mime_type,source_path,type"
      ),
      "asset.import must keep its exact input shape without lesson context",
    );
    assert(
      imports.map((call: ImportCall) => call.input.source_path).join("|") === "/pick/a.png|/pick/b.png|/pick/c.png",
      "each import must carry the picked absolute path",
    );
    assert(store.data.assets.length === 3, "every picked file must land in the media library");
    assert(store.ui.route === "media" && store.ui.screen === "project", "the batch must land on the media library");
    assert(store.ui.toast.startsWith("已导入 3 个素材"), `toast must report the batch, got ${store.ui.toast}`);
    const batch = store.history.filter((entry: any) => entry.label === "批量导入素材");
    assert(batch.length === 1, "one batch must record exactly one undoable step");
    store.undo();
    assert(store.data.assets.length === 0, "one undo must remove the whole batch");
    store.redo();
    assert(store.data.assets.length === 3, "redo must restore the whole batch");
  } finally {
    restore();
  }
});

Deno.test("one unreadable file never cancels the rest of the batch", async () => {
  const bridge = importBridge({
    paths: ["/pick/good.png", "/pick/broken.png", "/pick/last.png"],
    failFor: (path) => path.includes("broken"),
  });
  const { store, restore } = await bootStore(bridge);
  try {
    await store.importNativeFiles(["/pick/good.png", "/pick/broken.png", "/pick/last.png"]);
    assert(
      bridge.importCalls.filter((call: ImportCall) => call.name === "asset.import").length === 3,
      "the files after a failure must still be attempted",
    );
    assert(store.data.assets.length === 2, `both survivors must import, got ${store.data.assets.length}`);
    assert(store.ui.toast.includes("已导入 2 个素材"), `successes must stay visible, got ${store.ui.toast}`);
    assert(store.ui.toast.includes("1 个失败"), `the failure must be counted, got ${store.ui.toast}`);
    assert(store.ui.toast.includes("broken.png"), `the failure must name the file, got ${store.ui.toast}`);
  } finally {
    restore();
  }
});

Deno.test("a checksum hit counts as a duplicate and adds no undo step", async () => {
  const bridge = importBridge({
    paths: ["/pick/again.png", "/pick/new.png"],
    duplicates: ["/pick/again.png"],
  });
  const { store, restore } = await bootStore(bridge);
  try {
    assert(store.data.assets.length === 1, "the reused asset is already in the library");
    await store.importNativeFiles(["/pick/again.png", "/pick/new.png"]);
    assert(store.data.assets.length === 2, "only the new file may add a row");
    assert(
      store.ui.toast.includes("已导入 1 个素材") &&
        store.ui.toast.includes("1 个已按 checksum 复用") &&
        !store.ui.toast.includes("失败"),
      `reuse must not be reported as failure, got ${store.ui.toast}`,
    );
    assert(
      store.history.some((entry: any) => entry.label === "批量导入素材"),
      "a mixed batch still has one undoable step",
    );
    store.undo();
    assert(store.data.assets.length === 1, "undo must keep the pre-existing reused row");
    const duplicateOnly = importBridge({ paths: ["/pick/again.png"], duplicates: ["/pick/again.png"] });
    const second = await bootStore(duplicateOnly);
    try {
      await second.store.importNativeFiles(["/pick/again.png"]);
      assert(second.store.data.assets.length === 1, "a checksum hit must not add a second row");
      assert(
        second.store.ui.toast.includes("1 个已按 checksum 复用") && !second.store.ui.toast.includes("失败"),
        `reuse alone must not read as failure, got ${second.store.ui.toast}`,
      );
      assert(
        second.store.history.every((entry: any) => entry.label !== "批量导入素材"),
        "a batch that only reused an asset has nothing to undo",
      );
    } finally {
      second.restore();
    }
  } finally {
    restore();
  }
});

Deno.test("an empty or cancelled selection imports nothing and changes nothing", async () => {
  const bridge = importBridge({ paths: [] });
  const { store, restore } = await bootStore(bridge);
  try {
    const before = structuredClone(store.data);
    await store.selectAndImportAsset();
    assert(bridge.importCalls.length === 0, "a cancelled picker must not import");
    assert(store.ui.toast.includes("没有选择素材文件"), `cancellation must be named, got ${store.ui.toast}`);
    assert(JSON.stringify(store.data) === JSON.stringify(before), "a cancelled picker must not touch data");
    await store.importNativeFiles(["", "  ", "/pick/only.png"]);
    assert(
      bridge.importCalls.filter((call: ImportCall) => call.name === "asset.import").length === 1,
      "blank entries must be ignored without dropping the real pick",
    );
    await store.importNativeFiles([]);
    assert(
      bridge.importCalls.filter((call: ImportCall) => call.name === "asset.import").length === 1,
      "an empty batch must return before touching the shell",
    );
  } finally {
    restore();
  }
});

Deno.test("the same file picked twice is skipped, not imported twice", async () => {
  const bridge = importBridge({ paths: ["/pick/twice.png", "/pick/twice.png"] });
  const { store, restore } = await bootStore(bridge);
  try {
    await store.importNativeFiles(["/pick/twice.png", "/pick/twice.png"]);
    assert(
      bridge.importCalls.filter((call: ImportCall) => call.name === "asset.import").length === 1,
      "a repeated path must be imported once",
    );
    assert(store.ui.toast.includes("1 个重复或不适用条目已跳过"), `the skip must be reported, got ${store.ui.toast}`);
  } finally {
    restore();
  }
});

Deno.test("the browser shell imports every dropped file as one batch", async () => {
  const bridge = importBridge({ paths: [] });
  bridge.isNative = () => false;
  const { store, restore } = await bootStore(bridge);
  try {
    const file = (name: string, type: string) => ({
      name,
      type,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    await store.importBrowserFiles([file("one.png", "image/png"), file("two.jpg", "image/jpeg")]);
    const imports = bridge.importCalls.filter((call: ImportCall) => call.name === "asset.import");
    assert(imports.length === 2, `both dropped files must import, got ${imports.length}`);
    assert(store.data.assets.length === 2, "both dropped assets must be listed");
    assert(store.ui.toast.includes("已将 2 个素材"), `the batch must be reported, got ${store.ui.toast}`);
    assert(
      store.history.some((entry: any) => entry.label === "批量导入素材"),
      "the browser batch must be undoable as one step",
    );
  } finally {
    restore();
  }
});

Deno.test("a failing browser drop still reports the files that landed", async () => {
  const bridge = importBridge({ paths: [] });
  const original = bridge.command;
  bridge.command = async (name: string, input: Record<string, unknown>) => {
    if (String(input.filename ?? "").includes("bad")) throw new Error("素材文件为空");
    return await original(name, input);
  };
  bridge.isNative = () => false;
  const { store, restore } = await bootStore(bridge);
  try {
    const file = (name: string) => ({
      name,
      type: "image/png",
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    await store.importBrowserFiles([file("ok.png"), file("bad.png")]);
    assert(store.data.assets.length === 1, "the readable file must still import");
    assert(store.ui.toast.includes("已将 1 个素材"), `success must stay visible, got ${store.ui.toast}`);
    assert(store.ui.toast.includes("1 个失败"), `failure must be counted, got ${store.ui.toast}`);
  } finally {
    restore();
  }
});

Deno.test("the hidden browser picker accepts multiple files", () => {
  assert(
    /<input[^>]*\bmultiple\b[^>]*data-project-file/.test(PROJECT_FILE_PICKER),
    "the browser file input must allow multi-select like the native picker",
  );
});
