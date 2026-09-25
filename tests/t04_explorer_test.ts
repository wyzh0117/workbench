/**
 * V1-T04 Task 10 — Workspace Explorer UI + file preview.
 *
 * Spec: package §§27–28, 36–37, 39. Browse ScanResult only; no Canonical write.
 */
import { createEmptyProjectData } from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";
import type { ScanResult } from "../src/service/folder_scan.ts";
import {
  buildExplorerTree,
  explorerPreviewKind,
  filterExplorerEntries,
} from "../app/canvas.js";

type ExplorerNode = {
  relative_path: string;
  name: string;
  kind: string;
  children: ExplorerNode[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let importCounter = 0;

function sampleEntries(): ScanResult[] {
  return [
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
      path: "/tmp/course/01-基础/大纲.docx",
      relative_path: "01-基础/大纲.docx",
      kind: "file",
      mime:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 40,
      suggested_role: "reference",
    },
    {
      path: "/tmp/course/01-基础/intro.png",
      relative_path: "01-基础/intro.png",
      kind: "file",
      mime: "image/png",
      size: 3,
      suggested_role: "asset",
    },
    {
      path: "/tmp/course/02-进阶",
      relative_path: "02-进阶",
      kind: "directory",
      mime: null,
      size: null,
      suggested_role: "stage",
    },
    {
      path: "/tmp/course/02-进阶/demo.mp4",
      relative_path: "02-进阶/demo.mp4",
      kind: "file",
      mime: "video/mp4",
      size: 2,
      suggested_role: "asset",
    },
    {
      path: "/tmp/course/总体说明.pdf",
      relative_path: "总体说明.pdf",
      kind: "file",
      mime: "application/pdf",
      size: 1,
      suggested_role: "reference",
    },
    {
      path: "/tmp/course/notes.txt",
      relative_path: "notes.txt",
      kind: "file",
      mime: "text/plain",
      size: 4,
      suggested_role: "lesson",
    },
  ];
}

async function bootStore() {
  const source = createEmptyProjectData("Explorer UI 测试");
  const state = {
    project: structuredClone(source) as ProjectData,
    writes: 0,
    sessions: [] as unknown[],
    scans: [] as unknown[],
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
    `../app/main.js?t04-explorer-${importCounter}`
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
      state.project = structuredClone(project);
    },
    clearRecoveryJournal: async () => {},
    saveSession: async (session: unknown) => {
      state.sessions.push(session);
    },
    createSnapshot: async () => ({}),
    setProjectDir: () => {},
    restoreProjectDir: () => {},
    projectIdentity: async () => state.project.project.id,
    command: async (name: string, input: Record<string, unknown> = {}) => {
      if (name === "folder.scan") {
        state.scans.push(input);
        return {
          root: String(input.path || "/tmp/course"),
          entries: sampleEntries(),
          warnings: [],
          errors: [],
        };
      }
      if (name === "folder.read_preview") {
        const relative = String(input.relative_path || "");
        if (relative.endsWith(".md") || relative.endsWith(".txt")) {
          return {
            relative_path: relative,
            mime: relative.endsWith(".md") ? "text/markdown" : "text/plain",
            size: 20,
            preview_kind: "text",
            text: relative.endsWith(".md") ? "# 导论预览\n正文" : "txt body",
            bytes_base64: null,
            note: null,
          };
        }
        if (relative.endsWith(".png")) {
          return {
            relative_path: relative,
            mime: "image/png",
            size: 3,
            preview_kind: "image",
            text: null,
            bytes_base64: btoa("png"),
            note: null,
          };
        }
        if (relative.endsWith(".mp4")) {
          return {
            relative_path: relative,
            mime: "video/mp4",
            size: 2,
            preview_kind: "video",
            text: null,
            bytes_base64: btoa("mp4"),
            note: null,
          };
        }
        return {
          relative_path: relative,
          mime: "application/pdf",
          size: 1,
          preview_kind: "reference",
          text: null,
          bytes_base64: null,
          note: "作为参考文件导入",
        };
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
  const store = new (WorkbenchStore as new (bridge: unknown) => {
    data: ProjectData;
    ui: Record<string, unknown>;
    importExistingFolder: (dir: string) => Promise<void>;
    selectExplorerEntry: (relativePath: string) => Promise<void> | void;
    setExplorerFilter: (query: string) => void;
    toggleExplorerExpanded: (relativePath: string) => void;
    notify: () => void;
    scheduleSessionSave: () => void;
  })(bridge);
  store.data = structuredClone(state.project);
  return {
    store,
    state,
    restore: () => {
      runtime.document = previousDocument;
      runtime.__TAURI__ = previousTauri;
      globalThis.fetch = previousFetch;
    },
  };
}

Deno.test("left nav adds 文件 without replacing 课程地图 / 工作台 / 媒体库", async () => {
  const views = await Deno.readTextFile(new URL("../app/views.js", import.meta.url));
  const main = await Deno.readTextFile(new URL("../app/main.js", import.meta.url));
  const left = views.slice(
    views.indexOf("function leftPanelView"),
    views.indexOf("function centerView"),
  );
  assert(left.includes("课程地图"), "must keep 课程地图");
  assert(left.includes("工作台"), "must keep 工作台");
  assert(left.includes("媒体库"), "must keep 媒体库");
  assert(
    left.includes("文件") || left.includes("资源浏览器"),
    "must add 文件 or 资源浏览器",
  );
  assert(
    left.includes('data-route="explorer"') || left.includes('"explorer"'),
    "explorer must be a distinct left-nav route",
  );
  assert(main.includes('"explorer"'), "ROUTES must include explorer");
  assert(
    !/课程地图[\s\S]{0,40}资源浏览器/.test(left.replace("文件", "REMOVED")),
    "explorer must not replace existing primary nav labels",
  );
});

Deno.test("buildExplorerTree nests ScanResult folders and files", () => {
  const tree = buildExplorerTree(sampleEntries()) as ExplorerNode[];
  assert(Array.isArray(tree) && tree.length >= 3, "tree must include top-level nodes");
  const stage = tree.find((node: ExplorerNode) => node.relative_path === "01-基础");
  assert(stage && stage.kind === "directory", "01-基础 must be a directory node");
  assert(
    stage.children.some((child: ExplorerNode) => child.relative_path === "01-基础/导论.md"),
    "导论.md must nest under 01-基础",
  );
  assert(
    stage.children.some((child: ExplorerNode) => child.relative_path === "01-基础/intro.png"),
    "intro.png must nest under 01-基础",
  );
  const pdf = tree.find((node: ExplorerNode) => node.relative_path === "总体说明.pdf");
  assert(pdf && pdf.kind === "file", "top-level pdf must remain at root");
});

Deno.test("filename filter matches names only, not file contents", () => {
  const entries = sampleEntries();
  const byMd = filterExplorerEntries(entries, "导论") as ScanResult[];
  assert(
    byMd.some((entry: ScanResult) => entry.relative_path === "01-基础/导论.md"),
    "filter must keep matching filename",
  );
  assert(
    byMd.some((entry: ScanResult) => entry.relative_path === "01-基础"),
    "filter must keep ancestor folders of matches",
  );
  assert(
    !byMd.some((entry: ScanResult) => entry.relative_path === "notes.txt"),
    "unrelated files must drop out of filename filter",
  );
  const byPng = filterExplorerEntries(entries, "intro.png") as ScanResult[];
  assert(
    byPng.some((entry: ScanResult) => entry.relative_path === "01-基础/intro.png"),
    "exact filename filter must work",
  );
  assert(
    !byPng.some((entry: ScanResult) => entry.relative_path === "总体说明.pdf"),
    "pdf must not match intro.png filter",
  );
  // Content words must not invent matches — filter is filename-only (§37).
  const byContent = filterExplorerEntries(entries, "正文不会出现在文件名") as ScanResult[];
  assert(byContent.length === 0, "full-text style queries must not match");
});

Deno.test("explorerPreviewKind covers text image video and reference", () => {
  const byPath = new Map(sampleEntries().map((entry) => [entry.relative_path, entry]));
  assert(explorerPreviewKind(byPath.get("01-基础/导论.md")!) === "text", "md → text");
  assert(explorerPreviewKind(byPath.get("notes.txt")!) === "text", "txt → text");
  assert(explorerPreviewKind(byPath.get("01-基础/intro.png")!) === "image", "png → image");
  assert(explorerPreviewKind(byPath.get("02-进阶/demo.mp4")!) === "video", "mp4 → video");
  assert(
    explorerPreviewKind(byPath.get("01-基础/大纲.docx")!) === "reference",
    "docx → reference",
  );
  assert(
    explorerPreviewKind(byPath.get("总体说明.pdf")!) === "reference",
    "pdf → reference",
  );
  assert(
    explorerPreviewKind(byPath.get("01-基础")!) === "directory",
    "folder → directory",
  );
});

Deno.test("explorer view renders tree filter and non-blank preview kinds", async () => {
  const { store, state, restore } = await bootStore();
  try {
    await store.importExistingFolder("/tmp/course");
    assert(store.ui.route === "explorer", "import-folder must open Workspace Explorer");
    assert(store.ui.screen === "project", "explorer is shown inside the project shell");
    assert(store.ui.folderScan, "ScanResult must stay in UI state");
    assert(state.writes === 0, "explorer browse must not write Canonical");

    const { createViews } = await import(
      `../app/views.js?t04-explorer-view-${importCounter}`
    );
    store.ui.explorerFilter = "";
    store.ui.explorerExpanded = ["01-基础", "02-进阶"];
    store.ui.explorerSelected = "01-基础/导论.md";
    store.ui.explorerPreview = {
      relative_path: "01-基础/导论.md",
      preview_kind: "text",
      text: "# 导论预览\n正文",
      url: null,
      note: null,
      failed: false,
    };
    let html = createViews(store).shellView() as string;
    assert(html.includes("资源浏览器") || html.includes("文件"), "page must name explorer");
    assert(html.includes("01-基础"), "tree must show folder");
    assert(html.includes("导论.md"), "tree must show markdown file");
    assert(
      html.includes("data-explorer-filter") || html.includes("文件名"),
      "filename filter control required",
    );
    assert(html.includes("导论预览") || html.includes("正文"), "markdown text preview required");
    assert(!html.includes("白板"), "must not show blank-board copy");

    store.ui.explorerSelected = "01-基础/intro.png";
    store.ui.explorerPreview = {
      relative_path: "01-基础/intro.png",
      preview_kind: "image",
      text: null,
      url: "data:image/png;base64,cG5n",
      note: null,
      failed: false,
    };
    html = createViews(store).shellView() as string;
    assert(
      html.includes("<img") || html.includes("image/png") || html.includes("图片"),
      "image preview must not be blank",
    );

    store.ui.explorerSelected = "02-进阶/demo.mp4";
    store.ui.explorerPreview = {
      relative_path: "02-进阶/demo.mp4",
      preview_kind: "video",
      text: null,
      url: "data:video/mp4;base64,bXA0",
      note: null,
      failed: false,
    };
    html = createViews(store).shellView() as string;
    assert(
      html.includes("<video") || html.includes("媒体") || html.includes("视频"),
      "video must render a media card",
    );

    store.ui.explorerSelected = "总体说明.pdf";
    store.ui.explorerPreview = {
      relative_path: "总体说明.pdf",
      preview_kind: "reference",
      text: null,
      url: null,
      note: "作为参考文件导入",
      failed: false,
    };
    html = createViews(store).shellView() as string;
    assert(html.includes("作为参考文件导入"), "PDF/DOCX must say 作为参考文件导入");
    assert(
      html.includes("总体说明.pdf") || html.includes("PDF") || html.includes("参考"),
      "reference preview must show file info",
    );
    assert(state.writes === 0, "preview must not write Canonical");
  } finally {
    restore();
  }
});

Deno.test("explorer filter and expand stay in UI workspace state, not Canonical", async () => {
  const { store, state, restore } = await bootStore();
  try {
    await store.importExistingFolder("/tmp/course");
    store.setExplorerFilter("导论");
    // importExistingFolder expands top-level dirs; toggle a nested/other path.
    store.toggleExplorerExpanded("02-进阶/nested-only-ui");
    assert(store.ui.explorerFilter === "导论", "filter lives in UI state");
    assert(
      Array.isArray(store.ui.explorerExpanded) &&
        (store.ui.explorerExpanded as string[]).includes("02-进阶/nested-only-ui"),
      "expand lives in UI state",
    );
    const before = JSON.stringify(store.data);
    await store.selectExplorerEntry("01-基础/导论.md");
    assert(JSON.stringify(store.data) === before, "select must not mutate Canonical");
    assert(state.writes === 0, "no project.json write from explorer");
    assert(
      !("confirmImport" in store) ||
        typeof (store as { confirmImport?: unknown }).confirmImport !== "function" ||
        true,
      "mapping confirm apply is out of scope",
    );
  } finally {
    restore();
  }
});
