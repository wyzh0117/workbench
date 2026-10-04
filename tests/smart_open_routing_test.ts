/**
 * Item 1 — smart open (§3.2, §3.3, §3.4).
 *
 * The classifier in `smart_project_inspect_test.ts` proves the shell can tell the
 * folder shapes apart.  This file proves the *product* acts on that: one folder
 * pick routes a plain folder into import, shows a broken `project.json` with its
 * real first failure, asks before touching that file, and never once says
 * "没有找到有效的 project.json" about a folder that contains one.
 */
import { createEmptyProjectData } from "../src/domain/index.ts";
import { createViews } from "../app/views.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assert(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function assertContains(text: string, needle: string, label: string): void {
  assert(
    text.includes(needle),
    `${label}: expected ${JSON.stringify(needle)} in ${JSON.stringify(text)}`,
  );
}

function assertLacks(text: string, needle: string, label: string): void {
  assert(
    !text.includes(needle),
    `${label}: found forbidden ${JSON.stringify(needle)} in ${JSON.stringify(text)}`,
  );
}

type LooseRecord = Record<string, any>;

type LooseStore = {
  ui: LooseRecord;
  data: any;
  bridge: any;
  initialize(): Promise<void>;
  routeFolderInspection(dir: string, inspection: any): Promise<void>;
  dismissProjectProblem(): void;
  reimportProjectProblemFolder(options?: { replaceInvalid?: boolean }): Promise<void>;
  applyFolderAdoption(): Promise<void>;
};

type Harness = {
  store: LooseStore;
  calls: Array<{ name: string; payload: LooseRecord }>;
  describeFailure(error: unknown, hints?: LooseRecord): string;
  restore: () => void;
};

const NO_PROJECT = {
  status: "no_project_json",
  schema_version: null,
  supported_schema_version: "0.2.3",
  problem: {
    code: "project_json_missing",
    path: "project.json",
    message: "这个文件夹里还没有 project.json，因此它还不是 Workbench 项目。你可以把它作为已有文件夹导入。",
    expected: "所选文件夹根目录中存在 project.json",
    actual: "project.json 不存在",
  },
  project: null,
};

const BROKEN_CANONICAL = {
  status: "invalid",
  schema_version: "0.2.3",
  supported_schema_version: "0.2.3",
  problem: {
    code: "missing_document",
    path: "content_items[0].document_id",
    message: "正文文档不存在",
    expected: "documents 中存在该 id",
    actual: "d-missing",
  },
  project: null,
};

const NEWER_PROJECT = {
  status: "invalid",
  schema_version: "0.9.9",
  supported_schema_version: "0.2.3",
  problem: {
    code: "unsupported_schema",
    path: "schema_version",
    message: "项目文件由更高版本创建",
    expected: "不高于当前版本",
    actual: "0.9.9",
  },
  project: null,
};

const SCAN = {
  root: "/Users/youngi/Documents/MiniWork/AI学习课程",
  entries: [
    { relative_path: "s01-00", kind: "directory", size: null, mime: null },
    { relative_path: "s01-00/lesson.md", kind: "file", size: 10, mime: "text/markdown" },
  ],
  warnings: [],
  errors: [],
};

let bootCount = 0;

/** `app/main.js` boots a live store on import, so it is only ever loaded stubbed. */
function stubDocument(): () => void {
  const runtime = globalThis as unknown as LooseRecord;
  const previous = runtime.document;
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {},
    dataset: {},
  };
  runtime.document = {
    querySelector: () => root,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  return () => {
    runtime.document = previous;
  };
}

async function bootRoutingStore(): Promise<Harness> {
  const data = createEmptyProjectData("当前课程");
  const state: { project: ReturnType<typeof createEmptyProjectData> | null; revision: number } = {
    project: null,
    revision: 0,
  };
  const missingFingerprint = { exists: false, mtime_ms: null, size: null, hash: null };
  const fingerprintFor = (project: ReturnType<typeof createEmptyProjectData>, revision: number) => ({
    exists: true,
    mtime_ms: 1_780_000_000_000 + revision,
    size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
    hash: revision.toString(16).padStart(64, "0"),
  });
  const currentFingerprint = () => state.project
    ? fingerprintFor(state.project, state.revision)
    : missingFingerprint;
  const restore = stubDocument();
  const calls: Array<{ name: string; payload: LooseRecord }> = [];
  bootCount += 1;
  const module = await import(`../app/main.js?smart-open-${bootCount}`) as LooseRecord;
  const bridge = {
    projectDir: null,
    projectDirFromUrl: false,
    isNative: () => false,
    currentProject: () => data,
    loadSession: async () => null,
    readProject: async () => state.project ? structuredClone(state.project) : null,
    readProjectState: async () => ({
      project: state.project ? structuredClone(state.project) : null,
      fingerprint: currentFingerprint(),
    }),
    writeProject: async (
      project: ReturnType<typeof createEmptyProjectData>,
      expectedFingerprint: unknown,
    ) => {
      if (!state.project || JSON.stringify(expectedFingerprint) !== JSON.stringify(currentFingerprint())) {
        throw new Error("external_modification_conflict");
      }
      state.project = structuredClone(project);
      state.revision += 1;
      return { fingerprint: currentFingerprint(), recovery_warning: null };
    },
    readRecoveryJournal: async () => null,
    writeRecoveryJournal: async () => {},
    clearRecoveryJournal: async () => {},
    saveSession: async () => {},
    createSnapshot: async () => ({}),
    setProjectDir: () => {},
    restoreProjectDir: () => {},
    projectIdentity: async () => data.project.id,
    listenNativeDrops: async () => () => {},
    command: async (name: string, payload: LooseRecord) => {
      calls.push({ name, payload });
      if (name === "folder.scan") return structuredClone(SCAN);
      if (name === "folder.adopt") {
        state.project = createEmptyProjectData("重新导入的课程");
        state.revision += 1;
        return { data: structuredClone(state.project) };
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
  const store = new module.WorkbenchStore(bridge) as LooseStore;
  await store.initialize();
  return {
    store,
    calls,
    describeFailure: module.describeProjectOpenFailure,
    restore: () => {
      restore();
    },
  };
}

/** Only these two commands can touch the picked folder; boot chatter is ignored. */
function folderCalls(calls: Array<{ name: string; payload: LooseRecord }>): string[] {
  return calls.filter((call) => call.name === "folder.scan" || call.name === "folder.adopt")
    .map((call) => call.name);
}

function launcherMarkup(store: LooseStore): string {
  return createViews(store as never).launcherView() as string;
}

// ---------------------------------------------------------------------------
// §3.2 Case D — no project.json goes straight to import, no rejection shown
// ---------------------------------------------------------------------------

Deno.test("a folder without project.json is routed into the import scan", async () => {
  const { store, calls, restore } = await bootRoutingStore();
  try {
    await store.routeFolderInspection(SCAN.root, NO_PROJECT);
    assertEqual(store.ui.projectProblem, null, "no diagnosis overlay for an ordinary folder");
    assertEqual(store.ui.importMode, "adopt", "routed as a fresh adoption");
    assert(store.ui.folderScan, "the scan report is shown");
    assertEqual(store.ui.screen, "project", "the user lands in the import flow");
    assertEqual(store.ui.route, "explorer", "mapping preview is the next step");
    const scan = calls.find((call) => call.name === "folder.scan");
    assert(scan, "the scan ran without asking the user to choose a pipeline");
    assertEqual(scan.payload.path, SCAN.root, "the folder the user just picked");
    assertLacks(String(store.ui.toast), "还不是 AI Course Workbench 项目", "no generic rejection");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// §3.2 Case C — project.json exists but is unusable
// ---------------------------------------------------------------------------

Deno.test("an unusable project.json shows its real first failure, not a missing file", async () => {
  const { store, calls, restore } = await bootRoutingStore();
  try {
    await store.routeFolderInspection("/tmp/broken", BROKEN_CANONICAL);
    assert(store.ui.projectProblem, "the diagnosis overlay is shown");
    assertEqual(store.ui.projectProblem.dir, "/tmp/broken", "the overlay knows which folder it is about");
    assertEqual(store.ui.projectProblem.status, "invalid", "the detected category");
    assertEqual(store.ui.projectProblem.problem.code, "missing_document", "the first actionable failure");
    assertContains(store.ui.toast, "检测到 project.json", "the copy admits the file exists");
    assertContains(store.ui.toast, "正文文档不存在", "and names the failure");
    assertLacks(store.ui.toast, "没有找到有效的 project.json", "§3.4: no generic not-a-project message");
    assertLacks(store.ui.toast, "V1-T04", "no internal task jargon in user copy");
    assertEqual(folderCalls(calls).length, 0, "nothing is imported silently");
  } finally {
    restore();
  }
});

Deno.test("the diagnosis overlay offers 查看具体问题, 返回 and a confirmed re-import", async () => {
  const { store, restore } = await bootRoutingStore();
  try {
    await store.routeFolderInspection("/tmp/broken", BROKEN_CANONICAL);
    const html = launcherMarkup(store);
    assertContains(html, "检测到 project.json，但项目数据无法通过校验。", "headline states the category");
    assertContains(html, "正文文档不存在", "the first failure is visible without a click");
    assertContains(html, "查看具体问题", "detail is available on demand");
    assertContains(html, "content_items[0].document_id", "the detail names the field path");
    assertContains(html, "d-missing", "the detail shows what was found");
    assertContains(html, "/tmp/broken", "the detail shows which folder");
    assertContains(html, 'data-action="dismiss-project-problem"', "返回");
    assertContains(html, 'data-action="reimport-project-folder"', "作为普通资料文件夹重新导入");
    assertContains(html, "不会覆盖原来的 project.json", "the promise not to overwrite");
    assertLacks(html, "没有找到有效的 project.json", "§3.4: no generic message in markup");
    assertLacks(html, 'data-action="confirm-reimport-project-folder"', "confirmation is a second step");
  } finally {
    restore();
  }
});

Deno.test("re-importing asks for confirmation before the existing file is touched", async () => {
  const { store, calls, restore } = await bootRoutingStore();
  try {
    await store.routeFolderInspection("/tmp/broken", BROKEN_CANONICAL);
    await store.reimportProjectProblemFolder();
    assertEqual(store.ui.projectProblem.confirmReimport, true, "the overlay switched to a confirmation");
    assertEqual(store.ui.replaceInvalidProject, false, "nothing may be replaced yet");
    assertEqual(folderCalls(calls).length, 0, "the folder is untouched");
    const html = launcherMarkup(store);
    assertContains(html, "完整保留为一个带时间戳的备份文件", "the confirmation says the file survives");
    assertContains(html, "不会删除", "and is never deleted");
    assertContains(html, 'data-action="confirm-reimport-project-folder"', "explicit confirm control");
  } finally {
    restore();
  }
});

Deno.test("confirmed re-import scans the folder and arms the manifest backup once", async () => {
  const { store, calls, restore } = await bootRoutingStore();
  try {
    await store.routeFolderInspection("/tmp/broken", BROKEN_CANONICAL);
    await store.reimportProjectProblemFolder();
    await store.reimportProjectProblemFolder({ replaceInvalid: true });
    assertEqual(store.ui.projectProblem, null, "the diagnosis is done with");
    assertEqual(store.ui.replaceInvalidProject, true, "the adoption may back the manifest up");
    const scan = calls.find((call) => call.name === "folder.scan");
    assert(scan, "the confirmed import scanned the folder");
    assertEqual(scan.payload.path, "/tmp/broken", "the same folder the user picked");

    // The confirmation is consumed by the adoption it started, and by nothing else.
    store.ui.importMappingPlan = {
      root: "/tmp/broken",
      confirmed: true,
      confirmed_at: "2026-10-01T00:00:00.000Z",
      items: [{
        relative_path: "cover.png",
        kind: "file",
        mime: "image/png",
        size: 3,
        suggested: "asset",
        mapping: "asset",
        selected: true,
        is_suggestion: true,
      }],
    };
    await store.applyFolderAdoption();
    const adopt = calls.find((call) => call.name === "folder.adopt");
    assert(adopt, "the adoption ran");
    assertEqual(adopt.payload.replace_invalid_project, true, "the shell was told to keep the old manifest");
    assertEqual(store.ui.replaceInvalidProject, false, "the confirmation is one-shot");

    await store.applyFolderAdoption();
    const second = calls.filter((call) => call.name === "folder.adopt")[1];
    assert(second, "the second adoption ran");
    assertEqual(
      second.payload.replace_invalid_project,
      false,
      "a later import of another folder never inherits the confirmation",
    );
  } finally {
    restore();
  }
});

Deno.test("返回 leaves the folder exactly as it was", async () => {
  const { store, calls, restore } = await bootRoutingStore();
  try {
    await store.routeFolderInspection("/tmp/broken", BROKEN_CANONICAL);
    store.dismissProjectProblem();
    assertEqual(store.ui.projectProblem, null, "the overlay is gone");
    assertContains(store.ui.toast, "没有被修改", "the user is told nothing happened");
    assertEqual(folderCalls(calls).length, 0, "and nothing actually happened");
    assertLacks(launcherMarkup(store), "project-problem-modal", "no overlay is rendered afterwards");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// §3.4 — the copy layer, including the paths with no diagnosis at all
// ---------------------------------------------------------------------------

Deno.test("corrupted JSON is reported as corrupted, never as missing", async () => {
  const { describeFailure, restore } = await bootRoutingStore();
  try {
    const text = describeFailure(null, { diagnosis: "malformed_json" });
    assertContains(text, "project.json", "the file is acknowledged");
    assertContains(text, "解析", "and its real condition");
    assertLacks(text, "没有找到有效的 project.json", "§3.4");
    assertLacks(text, "还没有 project.json", "it is not described as absent");
  } finally {
    restore();
  }
});

Deno.test("every diagnosis gets its own copy with no generic fallback", async () => {
  const { describeFailure, restore } = await bootRoutingStore();
  try {
    const cases = [
      ["invalid", "通过校验", ""],
      ["malformed_json", "解析", ""],
      ["no_project_json", "导入", ""],
      ["unreadable", "读取", ""],
      ["invalid", "更高版本", "unsupported_schema"],
    ] as const;
    for (const [diagnosis, needle, problemCode] of cases) {
      const text = describeFailure(null, { diagnosis, problemCode });
      assertContains(text, needle, `${diagnosis}/${problemCode || "general"} copy`);
      assertLacks(text, "没有找到有效的 project.json", `${diagnosis}/${problemCode || "general"} copy`);
    }
  } finally {
    restore();
  }
});

Deno.test("a project from a newer version is never offered for re-import", async () => {
  const { store, calls, restore } = await bootRoutingStore();
  try {
    await store.routeFolderInspection("/tmp/newer", NEWER_PROJECT);
    const html = launcherMarkup(store);
    assertContains(html, "这个项目由更高版本的 Workbench 创建。", "headline names the real cause");
    assertContains(html, "当前版本支持到 0.2.3", "the supported range is stated");
    assertLacks(html, 'data-action="reimport-project-folder"', "no offer to move the file aside");
    assertContains(html, 'data-action="dismiss-project-problem"', "返回 is still available");

    await store.reimportProjectProblemFolder({ replaceInvalid: true });
    assertEqual(store.ui.replaceInvalidProject, false, "the shell is never armed for a newer project");
    assertEqual(folderCalls(calls).length, 0, "and nothing was scanned or written");
  } finally {
    restore();
  }
});

Deno.test("with no diagnosis the copy stays honest about what is unknown", async () => {
  const { describeFailure, restore } = await bootRoutingStore();
  try {
    const text = describeFailure(new Error("project.json 无效"), {});
    assertLacks(text, "没有找到有效的 project.json", "an unknown cause is not reported as a missing file");
    assertContains(text, "你可以：", "next steps are always offered");
  } finally {
    restore();
  }
});

Deno.test("legacy error strings still classify when the shell gave no payload", async () => {
  const { describeFailure, restore } = await bootRoutingStore();
  try {
    assertContains(
      describeFailure(new Error("项目 json 无效: Expected property name"), {}),
      "解析",
      "corrupted JSON from a string error",
    );
    assertContains(
      describeFailure(new Error("顶层必须是 JSON 对象"), {}),
      "通过校验",
      "non-project JSON from a string error",
    );
  } finally {
    restore();
  }
});
