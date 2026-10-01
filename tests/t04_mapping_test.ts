/**
 * V1-T04 Task 11 — Import mapping preview + user confirmation UI.
 *
 * Spec: package §§30–31, 34. Suggestions are 建议 not 事实.
 * Preview ≠ Confirm. The mapping helper collects the plan; the current UI confirm
 * also executes the authorized import and is covered in t04_adoption_test.ts.
 */
import { createEmptyProjectData } from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";
import type { ScanResult } from "../src/service/folder_scan.ts";
import { mappingRowClickToggles } from "../app/canvas.js";
import {
  buildImportMappingPlan,
  confirmImportMappingPlan,
  mappingRoleLabel,
  setImportMappingRole,
  setImportMappingSelected,
  type ImportMappingPlan,
  type MappingRole,
} from "../src/service/folder_mapping.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("mapping row details/summary clicks do not toggle the row selection", () => {
  const summaryTarget = {
    closest(selector: string) {
      return selector.split(",").map((part) => part.trim()).includes("summary")
        ? summaryTarget
        : null;
    },
  };
  assert(!mappingRowClickToggles(summaryTarget), "details summary should only expand its dependency list");
  assert(mappingRowClickToggles({ closest: () => null }), "clicking row background should still toggle selection");
});

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
      path: "/tmp/course/02-进阶/第二课.md",
      relative_path: "02-进阶/第二课.md",
      kind: "file",
      mime: "text/markdown",
      size: 8,
      suggested_role: "lesson",
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
    {
      path: "/tmp/course/weird.bin",
      relative_path: "weird.bin",
      kind: "file",
      mime: null,
      size: 1,
      suggested_role: "unsupported",
    },
  ];
}

function byPath(plan: ImportMappingPlan) {
  return new Map(plan.items.map((item) => [item.relative_path, item]));
}

Deno.test("Stage mapping suggests 01-基础 and 02-进阶 as Stage candidates (§30)", () => {
  const plan = buildImportMappingPlan("/tmp/course", sampleEntries());
  const map = byPath(plan);
  const stageA = map.get("01-基础");
  const stageB = map.get("02-进阶");
  assert(stageA, "01-基础 must appear in mapping plan");
  assert(stageB, "02-进阶 must appear in mapping plan");
  assert(stageA.suggested === "stage", "01-基础 suggested → stage");
  assert(stageB.suggested === "stage", "02-进阶 suggested → stage");
  assert(stageA.mapping === "stage", "01-基础 default mapping is stage");
  assert(stageB.mapping === "stage", "02-进阶 default mapping is stage");
  assert(stageA.selected === true, "stage candidates start selected");
  assert(stageB.selected === true, "stage candidates start selected");
  assert(stageA.is_suggestion === true, "must be marked as suggestion");
  assert(
    mappingRoleLabel(stageA.suggested, { suggestion: true }).includes("建议"),
    "Stage suggestion label must include 建议",
  );
  assert(
    map.get("01-基础/导论.md")?.suggested === "lesson",
    "md → Lesson suggestion",
  );
  assert(
    map.get("01-基础/intro.png")?.suggested === "asset",
    "media → Asset suggestion",
  );
  assert(
    map.get("总体说明.pdf")?.suggested === "reference",
    "pdf → Reference suggestion",
  );
  assert(
    map.get("01-基础/大纲.docx")?.suggested === "reference",
    "docx → Reference suggestion",
  );
  assert(
    map.get("weird.bin")?.selected === false,
    "unsupported starts deselected",
  );
  assert(plan.confirmed === false, "building a preview must not confirm");
});

Deno.test("user can deselect an item from the mapping plan (§31)", () => {
  const plan = buildImportMappingPlan("/tmp/course", sampleEntries());
  const next = setImportMappingSelected(plan, "01-基础/intro.png", false);
  const item = byPath(next).get("01-基础/intro.png");
  assert(item?.selected === false, "user deselect must stick");
  assert(next.confirmed === false, "deselect must not confirm");
  assert(
    byPath(plan).get("01-基础/intro.png")?.selected === true,
    "original plan must stay immutable",
  );
});

Deno.test("user can edit mapping role among Stage/Lesson/Source/Asset/ignore (§31, §34)", () => {
  const plan = buildImportMappingPlan("/tmp/course", sampleEntries());
  const asSource = setImportMappingRole(plan, "01-基础/导论.md", "source");
  assert(
    byPath(asSource).get("01-基础/导论.md")?.mapping === "source",
    "md may be remapped to Source",
  );
  const asIgnore = setImportMappingRole(asSource, "总体说明.pdf", "ignore");
  assert(
    byPath(asIgnore).get("总体说明.pdf")?.mapping === "ignore",
    "user may set ignore",
  );
  const asLesson = setImportMappingRole(plan, "notes.txt", "lesson");
  assert(
    byPath(asLesson).get("notes.txt")?.mapping === "lesson",
    "txt stays editable as Lesson",
  );
  const roles: MappingRole[] = [
    "stage",
    "lesson",
    "source",
    "asset",
    "reference",
    "ignore",
  ];
  for (const role of roles) {
    const label = mappingRoleLabel(role);
    assert(label.length > 0, `role ${role} needs a Chinese label`);
  }
  assert(asSource.confirmed === false, "editing mapping must not confirm");
});

Deno.test("preview does not call confirm; confirm collects plan without Canonical write", () => {
  const plan = buildImportMappingPlan("/tmp/course", sampleEntries());
  assert(plan.confirmed === false, "preview plan starts unconfirmed");
  // Simulating "open preview" again must still not confirm.
  const again = buildImportMappingPlan("/tmp/course", sampleEntries());
  assert(again.confirmed === false, "rebuilding preview must not confirm");

  const edited = setImportMappingSelected(
    setImportMappingRole(plan, "01-基础/导论.md", "source"),
    "weird.bin",
    false,
  );
  const confirmed = confirmImportMappingPlan(edited);
  assert(confirmed.confirmed === true, "confirm marks the plan confirmed");
  assert(
    byPath(confirmed).get("01-基础/导论.md")?.mapping === "source",
    "confirm preserves user edits",
  );
  assert(
    byPath(confirmed).get("01-基础")?.mapping === "stage",
    "confirm keeps Stage suggestions the user left alone",
  );
  assert(edited.confirmed === false, "confirm must not mutate the preview plan");
});

async function bootStore() {
  const source = createEmptyProjectData("Mapping UI 测试");
  const state = {
    project: structuredClone(source) as ProjectData,
    writes: 0,
    sessions: [] as unknown[],
    confirms: [] as unknown[],
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
    `../app/main.js?t04-mapping-${importCounter}`
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
        return {
          root: String(input.path || "/tmp/course"),
          entries: sampleEntries(),
          warnings: [],
          errors: [],
        };
      }
      if (name === "folder.read_source") {
        const text = "# 导论\n第一课正文\n";
        const digest = new Uint8Array(await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(text),
        ));
        return {
          relative_path: String(input.relativePath || "01-基础/导论.md"),
          size: new TextEncoder().encode(text).length,
          sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
          text,
        };
      }
      if (name === "folder.markdown_image_status") {
        return { status: "present", relative_path: "images/fixture.png", size: 1, mime: "image/png" };
      }
      if (name === "folder.read_preview") {
        return {
          relative_path: String(input.relative_path || ""),
          mime: "text/markdown",
          size: 12,
          preview_kind: "text",
          text: "# preview",
          bytes_base64: null,
          note: null,
        };
      }
      if (name === "folder.confirm_mapping" || name === "project.adopt") {
        state.confirms.push({ name, input });
        throw new Error("Task 11 must not call adoption/confirm apply commands");
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
  const store = new (WorkbenchStore as new (bridge: unknown) => {
    data: ProjectData;
    ui: Record<string, unknown>;
    importExistingFolder: (dir: string) => Promise<void>;
    openImportMappingPreview: () => void;
    setImportMappingSelected: (relativePath: string, selected: boolean) => void;
    setImportMappingRole: (relativePath: string, role: string) => void;
    confirmImportMapping: () => void;
    notify: () => void;
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

Deno.test("mapping preview UI labels 建议; deselect and edit; confirm is separate and does not write Canonical", async () => {
  const { store, state, restore } = await bootStore();
  try {
    await store.importExistingFolder("/tmp/course");
    assert(store.ui.route === "explorer", "scan still opens explorer first");

    const beforePreview = JSON.stringify(store.data);
    store.openImportMappingPreview();
    assert(
      String(store.ui.route) === "mapping",
      "openImportMappingPreview must open mapping route",
    );
    assert(store.ui.importMappingPlan, "preview must materialize a mapping plan");
    const plan = store.ui.importMappingPlan as ImportMappingPlan;
    assert(plan.confirmed === false, "preview must not confirm");
    assert(JSON.stringify(store.data) === beforePreview, "preview ≠ Canonical write");
    assert(state.writes === 0, "preview must not write project.json");
    assert(state.confirms.length === 0, "preview must not call confirm/apply commands");

    const { createViews } = await import(
      `../app/views.js?t04-mapping-view-${importCounter}`
    );
    let html = createViews(store).shellView() as string;
    assert(
      html.includes("映射") && html.includes("建议"),
      "mapping UI must show 建议 (not treat suggestions as facts)",
    );
    assert(html.includes("01-基础"), "Stage candidate 01-基础 must appear");
    assert(html.includes("02-进阶"), "Stage candidate 02-进阶 must appear");
    assert(
      html.includes("data-action=\"confirm-import-mapping\"") ||
        html.includes("确认导入计划"),
      "confirm must be a separate explicit action",
    );
    assert(
      !/data-action=\"open-import-mapping\"[^>]*>[\s\S]{0,80}confirm-import-mapping/.test(
        html,
      ),
      "preview control must not itself be the confirm action",
    );

    store.setImportMappingSelected("01-基础/intro.png", false);
    store.setImportMappingRole("01-基础/导论.md", "source");
    const edited = store.ui.importMappingPlan as ImportMappingPlan;
    assert(
      byPath(edited).get("01-基础/intro.png")?.selected === false,
      "UI deselect must update plan",
    );
    assert(
      byPath(edited).get("01-基础/导论.md")?.mapping === "source",
      "UI edit mapping must update plan",
    );
    assert(edited.confirmed === false, "edits must not auto-confirm");

    html = createViews(store).shellView() as string;
    assert(html.includes("建议"), "edited preview still labeled 建议");

    const beforeConfirm = JSON.stringify(store.data);
    const confirmed = confirmImportMappingPlan(edited);
    assert(confirmed.confirmed === true, "confirm collects/marks the plan");
    assert(
      byPath(confirmed).get("01-基础/导论.md")?.mapping === "source",
      "confirm keeps user mapping edits",
    );
    assert(
      byPath(confirmed).get("01-基础/intro.png")?.selected === false,
      "confirm keeps deselections",
    );
    assert(JSON.stringify(store.data) === beforeConfirm, "confirm must not mutate Canonical yet");
    assert(state.writes === 0, "Task 11 confirm must not write project.json");
    assert(state.confirms.length === 0, "Task 11 must not call adoption apply");
    assert(
      typeof store.ui.toast === "string" &&
        /尚未写入|未写入|后续|Task 12|正式接管|确认导入计划/.test(
          String(store.ui.toast),
        ),
      "toast should clarify Canonical apply is not done yet",
    );
  } finally {
    restore();
  }
});
