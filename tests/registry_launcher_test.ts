/**
 * §4/§5 — the start page and the shell calls behind it.
 *
 * `project_registry_test.ts` proves the record rules.  This file proves the
 * product on top of them: the launcher really lists every project newest-first,
 * a row whose folder is gone offers 重新定位 instead of an 打开 that would lie,
 * removing a row is confirmed and sends nothing but a row deletion, and the
 * §4.4 copy question is asked instead of guessed.
 */
import { createEmptyProjectData } from "../src/domain/index.ts";
import { createViews } from "../app/views.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assert(
    sameValue(actual, expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/** Payloads are compared as records, because key order carries no meaning here. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(right);
    return Object.keys(left).length === keys.length &&
      keys.every((key) => sameValue(left[key], right[key]));
  }
  return false;
}

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

type Call = { name: string; payload: LooseRecord };

const CURRENT = createEmptyProjectData("当前课程");

function row(
  projectId: string,
  projectPath: string,
  openedAt: string,
  extra: LooseRecord = {},
): LooseRecord {
  return {
    project_id: projectId,
    project_path: projectPath,
    project_title: `课程 ${projectId}`,
    last_opened_at: openedAt,
    available: true,
    copy: false,
    ...extra,
  };
}

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

type Harness = {
  store: LooseRecord;
  calls: Call[];
  registryCalls: () => Call[];
  lastAnswerFor: (name: string, answer: unknown) => void;
  launcherMarkup: () => string;
  overlayMarkup: () => string;
  restore: () => void;
};

async function bootRegistryHarness(
  options: { rows?: LooseRecord[]; projectDir?: string | null; answers?: LooseRecord } = {},
): Promise<Harness> {
  const restore = stubDocument();
  const calls: Call[] = [];
  const answers: LooseRecord = {
    "registry.list": { version: 1, projects: options.rows ?? [] },
    "registry.record": { status: "added" },
    "registry.remove": { removed: 1, project_id: "proj-a" },
    // `initialize` reads the AI execution log for the side panel.  Left
    // unanswered it would raise its own toast on every boot and every test would
    // have to argue about a toast this file is not about.
    "ai.execution.list": { records: [] },
    ...options.answers,
  };
  bootCount += 1;
  const module = await import(`../app/main.js?registry-launcher-${bootCount}`) as LooseRecord;
  const projectDir = options.projectDir === undefined ? "/tmp/proj-current" : options.projectDir;
  const bridge = {
    projectDir,
    projectDirFromUrl: false,
    lastOpenedProjectState: null as LooseRecord | null,
    isNative: () => true,
    currentProject: () => CURRENT,
    loadSession: async () => null,
    readProject: async () => structuredClone(CURRENT),
    openProjectState: async () => {
      const state = {
        project: structuredClone(CURRENT),
        project_id: CURRENT.project.id,
        project_dir: bridge.projectDir,
        lease_generation: `lease:${bridge.projectDir}`,
        fingerprint: {
          exists: true,
          mtime_ms: 1,
          size: JSON.stringify(CURRENT).length,
          hash: "a".repeat(64),
        },
      };
      bridge.lastOpenedProjectState = state;
      return state;
    },
    readProjectState: async () => ({
      project: structuredClone(CURRENT),
      project_id: CURRENT.project.id,
      project_dir: bridge.projectDir,
      lease_generation: bridge.lastOpenedProjectState?.lease_generation ?? null,
      fingerprint: bridge.lastOpenedProjectState?.fingerprint ?? {
        exists: true,
        mtime_ms: 1,
        size: JSON.stringify(CURRENT).length,
        hash: "a".repeat(64),
      },
    }),
    writeProject: async () => {},
    readRecoveryJournal: async () => null,
    writeRecoveryJournal: async () => {},
    clearRecoveryJournal: async () => {},
    saveSession: async () => {},
    createSnapshot: async () => ({}),
    setProjectDir: (value: string) => {
      bridge.projectDir = value;
      return value;
    },
    restoreProjectDir: (value: string | null) => {
      bridge.projectDir = value;
    },
    projectIdentity: async () => CURRENT.project.id,
    listenNativeDrops: async () => () => {},
    selectFolder: async () => "",
    command: async (name: string, payload: LooseRecord) => {
      calls.push({ name, payload });
      if (name in answers) {
        const answer = answers[name];
        if (answer instanceof Error) throw answer;
        return typeof answer === "function" ? answer(payload) : answer;
      }
      throw new Error(`unexpected command ${name}`);
    },
    invoke: async (name: string, payload: LooseRecord) => bridge.command(name, payload),
  };
  const store = new module.WorkbenchStore(bridge) as LooseRecord;
  await store.initialize();
  // `initialize` reads the registry without awaiting it, so let that settle the
  // way the real window's first paint would.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const views = createViews(store as never) as LooseRecord;
  return {
    store,
    calls,
    registryCalls: () => calls.filter((call) => call.name.startsWith("registry.")),
    lastAnswerFor: (name, answer) => {
      answers[name] = answer;
    },
    launcherMarkup: () => views.launcherView() as string,
    overlayMarkup: () => (views.overlayView?.() ?? "") as string,
    restore,
  };
}

// ---------------------------------------------------------------------------
// §5 — the list
// ---------------------------------------------------------------------------

Deno.test("the start page lists every project this install has opened", async () => {
  // Relative stamps, so the humanised-time assertions cannot drift with the
  // calendar.  `ago()` adds an hour of slack so a floor() cannot land a unit
  // lower just because the runner took a few milliseconds.
  const ago = (days: number) => new Date(Date.now() - (days * 24 + 1) * 3600 * 1000).toISOString();
  // Read the same way the view does: env permission is not guaranteed here, and
  // the row must still abbreviate when the home directory is unknown.
  const home = (() => {
    try {
      return String(Deno.env.get("HOME") ?? "");
    } catch {
      return "";
    }
  })();
  const longPath = `${home}/Documents/MiniWork/workbench/projects/reading-course-2026/lesson-one`;
  const { store, launcherMarkup, registryCalls, restore } = await bootRegistryHarness({
    rows: [
      row("proj-a", "/tmp/proj-a", "2025-01-02T08:00:00.000Z"),
      row("proj-b", "/tmp/proj-b", new Date(Date.now() - 35 * 60000).toISOString()),
      row("proj-c", longPath, ago(3)),
      row("proj-now", "/tmp/proj-now", new Date().toISOString()),
    ],
  });
  try {
    assertEqual(registryCalls().map((call) => call.name), ["registry.list"], "the list is read once on boot");
    eqList(
      (store.ui.registryProjects as LooseRecord[]).map((candidate) => candidate.project_id),
      ["proj-now", "proj-b", "proj-c", "proj-a"],
      "newest first",
    );
    const markup = launcherMarkup();
    assertContains(markup, "最近打开", "the section is labelled");
    assertContains(markup, "课程 proj-b", "a stored title is shown");
    assertContains(markup, "课程 proj-a", "the oldest project is still shown");
    assertContains(markup, "刚刚打开", "a project opened moments ago does not read as a stale date");
    assertContains(markup, "35 分钟前打开", "the same day is counted in minutes");
    assertContains(markup, "3 天前打开", "recent history is counted, not raw ISO");
    assertContains(markup, "1 月 2 日打开 · 2025 年", "older history names the year");
    assertLacks(markup, "2025-01-02T08:00:00.000Z", "no ISO stamp is shown to the user");
    assertContains(markup, "…/reading-course-2026/lesson-one", "a long path shows its tail, where the project is");
    assertContains(markup, `title="${longPath}"`, "the full path stays reachable on the row");
    assertContains(markup, 'data-action="open-registry-project"', "a live row can be opened");
    assertEqual(
      (markup.match(/data-action="open-registry-project"/g) ?? []).length,
      4,
      "every available row gets its own open button",
    );
    assertContains(markup, "不会删除或改写磁盘上的课程文件", "the removal promise is stated where it is offered");
  } finally {
    restore();
  }
});

Deno.test("a row whose folder is gone offers 重新定位, never an 打开", async () => {
  const { launcherMarkup, restore } = await bootRegistryHarness({
    rows: [
      row("proj-gone", "/tmp/proj-gone", "2026-03-04T08:00:00.000Z", { available: false }),
      row("proj-here", "/tmp/proj-here", "2026-03-02T08:00:00.000Z"),
    ],
  });
  try {
    const markup = launcherMarkup();
    assertContains(markup, "找不到文件夹", "the stale row says what is wrong");
    assertContains(markup, 'data-action="relocate-registry-project"', "and offers the recovery step");
    assertContains(markup, 'data-project-path="/tmp/proj-gone"', "the stale row stays visible with its path");
    const staleRow = markup.slice(markup.indexOf('data-action="relocate-registry-project"') - 700, markup.indexOf('data-action="relocate-registry-project"'));
    assertLacks(staleRow, 'data-action="open-registry-project"', "a folder that is not there cannot be opened");
    assertContains(markup, 'data-action="open-registry-project"', "the available row still opens normally");
  } finally {
    restore();
  }
});

Deno.test("two live folders for one id are labelled as copies", async () => {
  const { launcherMarkup, restore } = await bootRegistryHarness({
    rows: [
      row("proj-a", "/tmp/copy-one", "2026-03-04T08:00:00.000Z", { copy: true }),
      row("proj-a", "/tmp/copy-two", "2026-03-03T08:00:00.000Z", { copy: true }),
    ],
  });
  try {
    const markup = launcherMarkup();
    assertEqual(
      (markup.match(/副本/g) ?? []).length,
      2,
      "both rows say they are copies, so neither looks authoritative",
    );
    assertContains(markup, "/tmp/copy-one", "each copy names the folder it is");
    assertContains(markup, "/tmp/copy-two", "and the other one is not hidden");
  } finally {
    restore();
  }
});

Deno.test("the project that is open now is marked, not duplicated by guesswork", async () => {
  const { launcherMarkup, restore } = await bootRegistryHarness({
    rows: [row(CURRENT.project.id, "/tmp/proj-current", "2026-03-06T08:00:00.000Z")],
  });
  try {
    const markup = launcherMarkup();
    assertContains(markup, "当前", "the row for the loaded course is identified");
    assertContains(markup, "继续工作", "and its button matches what the resume card does");
  } finally {
    restore();
  }
});

Deno.test("an empty registry leaves the start page usable instead of blank", async () => {
  const { launcherMarkup, restore } = await bootRegistryHarness({ rows: [] });
  try {
    const markup = launcherMarkup();
    assertContains(markup, "还没有最近项目", "the empty state explains itself");
    assertContains(markup, 'data-action="new-project"', "and the way in is still there");
    assertContains(markup, 'data-action="open-project-dir"', "including opening a folder directly");
    assertLacks(markup, 'data-action="open-registry-project"', "no row is invented");
  } finally {
    restore();
  }
});

Deno.test("a stored title is escaped where it is rendered", async () => {
  const hostile = '"><script>alert(1)</script>';
  const { launcherMarkup, restore } = await bootRegistryHarness({
    rows: [row("proj-x", "/tmp/proj-x", "2026-03-04T08:00:00.000Z", { project_title: hostile })],
  });
  try {
    const markup = launcherMarkup();
    assertLacks(markup, "<script>alert(1)</script>", "a registry row is not a way to inject markup");
    assertContains(markup, "&lt;script&gt;", "the title arrives as text");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// §4.2 / §4.3 / §4.4 / §5 — the shell calls
// ---------------------------------------------------------------------------

Deno.test("opening a project records identity, path, title and reader position", async () => {
  const { store, calls, restore } = await bootRegistryHarness({ projectDir: "/tmp/proj-current" });
  try {
    store.ui.activeId = "lesson-7";
    calls.length = 0;
    const outcome = await store.recordCurrentProject();
    assertEqual(outcome?.status, "added", "the answer is passed through");
    const recorded = calls.filter((call) => call.name === "registry.record");
    assertEqual(recorded.length, 1, "one record per open");
    assertEqual(
      first(recorded, "the record call").payload,
      {
        project_id: CURRENT.project.id,
        project_path: "/tmp/proj-current",
        project_title: "当前课程",
        last_content_item_id: "lesson-7",
      },
      "the payload is the §4.1 record and nothing else",
    );
    assertEqual(store.ui.registryCopy, null, "an ordinary open asks no question");
  } finally {
    restore();
  }
});

Deno.test("a project with no known folder is never recorded as a location-less row", async () => {
  const { store, calls, restore } = await bootRegistryHarness({ projectDir: null });
  try {
    calls.length = 0;
    const outcome = await store.recordCurrentProject();
    assertEqual(outcome, null, "nothing to record");
    eqList(calls.map((call) => call.name), [], "no registry command is sent for an unknown folder");
  } finally {
    restore();
  }
});

Deno.test("a failed record does not dress up as a failed open", async () => {
  const { store, restore } = await bootRegistryHarness({
    answers: { "registry.record": new Error("磁盘已满") },
  });
  try {
    const before = store.ui.toast;
    const outcome = await store.recordCurrentProject();
    assertEqual(outcome, null, "the registry is convenience state; the course is already open");
    assertEqual(
      store.ui.toast,
      before,
      `a failed record stays silent, got ${JSON.stringify(store.ui.toast)}`,
    );
  } finally {
    restore();
  }
});

Deno.test("the same id at two live folders asks the user instead of choosing", async () => {
  const { store, overlayMarkup, restore } = await bootRegistryHarness({
    answers: {
      "registry.record": {
        status: "duplicate",
        project: row("proj-current-id", "/tmp/old-place", "2026-03-01T08:00:00.000Z"),
      },
    },
  });
  try {
    await store.recordCurrentProject();
    const copy = store.ui.registryCopy as LooseRecord;
    assert(copy, "the §4.4 case surfaces instead of silently writing nothing");
    assertEqual(copy.existing_path, "/tmp/old-place", "the prompt names the row on file");
    assertEqual(copy.opened_path, "/tmp/proj-current", "and the folder opened this time");
    const markup = overlayMarkup();
    assertContains(markup, "检测到同一个 Workbench 项目的两个副本", "the prompt is the doc's sentence");
    assertContains(markup, 'data-action="registry-copy-update-location"', "更新项目位置");
    assertContains(markup, 'data-action="registry-copy-keep-both"', "保留两条记录");
    assertContains(markup, 'data-action="registry-copy-dismiss"', "and an answer that changes nothing");
  } finally {
    restore();
  }
});

Deno.test("choosing 保留两条记录 re-asks with the explicit decision", async () => {
  const { store, calls, lastAnswerFor, restore } = await bootRegistryHarness({
    answers: {
      "registry.record": {
        status: "duplicate",
        project: row("proj-current-id", "/tmp/old-place", "2026-03-01T08:00:00.000Z"),
      },
    },
  });
  try {
    await store.recordCurrentProject();
    calls.length = 0;
    lastAnswerFor("registry.record", { status: "added" });
    await store.resolveRegistryCopy("both");
    assertEqual(store.ui.registryCopy, null, "the prompt is answered, not left hanging");
    const again = calls.filter((call) => call.name === "registry.record");
    assertEqual(again.length, 1, "one retry with the decision attached");
    assertEqual(first(again, "the retry").payload.allow_second_copy, true, "the user's choice is what carries it");
    assertEqual(first(again, "the retry").payload.project_path, "/tmp/proj-current", "the new folder is the one recorded");
  } finally {
    restore();
  }
});

Deno.test("choosing 更新项目位置 relocates the row to this folder", async () => {
  const { store, calls, lastAnswerFor, restore } = await bootRegistryHarness({
    answers: {
      "registry.record": {
        status: "duplicate",
        project: row("proj-current-id", "/tmp/old-place", "2026-03-01T08:00:00.000Z"),
      },
    },
  });
  try {
    await store.recordCurrentProject();
    calls.length = 0;
    lastAnswerFor("registry.relocate", { status: "relocated", project: {} });
    await store.resolveRegistryCopy("relocate");
    const moved = calls.filter((call) => call.name === "registry.relocate");
    assertEqual(moved.length, 1, "the row is re-pointed through the relocate command");
    assertEqual(first(moved, "the relocate call").payload.new_path, "/tmp/proj-current", "at the folder just opened");
    assert(
      calls.some((call) => call.name === "registry.list"),
      "and the list is re-read so the page cannot show the old answer",
    );
  } finally {
    restore();
  }
});

Deno.test("removing a row is confirmed, then sends only the row", async () => {
  const runtime = globalThis as unknown as LooseRecord;
  const previousConfirm = runtime.confirm;
  const questions: string[] = [];
  const { store, calls, restore } = await bootRegistryHarness({
    rows: [row("proj-a", "/tmp/proj-a", "2026-03-04T08:00:00.000Z")],
  });
  try {
    runtime.confirm = (message: string) => {
      questions.push(message);
      return false;
    };
    calls.length = 0;
    await store.removeRegistryProject("proj-a", "/tmp/proj-a");
    assertEqual(calls.length, 0, "a declined confirmation sends nothing at all");
    assertContains(questions[0] ?? "", "不会被删除或修改", "the confirmation says what it will not do");

    runtime.confirm = () => true;
    calls.length = 0;
    await store.removeRegistryProject("proj-a", "/tmp/proj-a");
    const removed = calls.filter((call) => call.name === "registry.remove");
    assertEqual(removed.length, 1, "one row deletion");
    assertEqual(
      first(removed, "the removal call").payload,
      { project_id: "proj-a", project_path: "/tmp/proj-a" },
      "identity and path only — no project, no token",
    );
    assert(
      !calls.some((call) => call.name === "project.write" || call.name === "folder.scan"),
      "nothing else about the course is touched",
    );
    assertContains(store.ui.toast ?? "", "没有被改动", "the answer confirms the disk is intact");
  } finally {
    runtime.confirm = previousConfirm;
    restore();
  }
});

Deno.test("a refused relocation reports the mismatch instead of looking dead", async () => {
  const { store, calls, lastAnswerFor, restore } = await bootRegistryHarness();
  try {
    store.bridge.selectFolder = async () => "/tmp/other-course";
    lastAnswerFor("registry.relocate", new Error("该文件夹里的项目标识与登记表记录不一致（proj-b ≠ proj-a），已拒绝重新定位。"));
    calls.length = 0;
    await store.relocateRegistryProject("proj-a");
    assertContains(
      store.ui.toast ?? "",
      "不一致",
      `the user hears why it was refused (toast=${JSON.stringify(store.ui.toast)} calls=${JSON.stringify(calls)})`,
    );
    assert(
      calls.some((call) => call.name === "registry.list"),
      "and the list is re-read from the file that did not change",
    );
  } finally {
    restore();
  }
});

Deno.test("a cancelled relocation leaves the row alone and says so", async () => {
  const { store, calls, restore } = await bootRegistryHarness();
  try {
    store.bridge.selectFolder = async () => "";
    calls.length = 0;
    await store.relocateRegistryProject("proj-a");
    eqList(calls.map((call) => call.name), [], "no write is attempted on a cancelled pick");
    assertContains(store.ui.toast ?? "", "仍留在列表里", "the row is still there, and the page says so");
  } finally {
    restore();
  }
});

Deno.test("a row opens through the same route as the folder picker", async () => {
  const { store, calls, restore } = await bootRegistryHarness();
  try {
    // `openProject` is the whole open pipeline: read that folder's `project.json`,
    // classify it, take the lease.  「打开项目文件夹」 hands the picked folder to it
    // with `reopen: true`, so a row must hand over the folder exactly the same way
    // rather than trusting anything the registry stored about the project.
    const route: Array<{ dir: unknown; options: unknown }> = [];
    store.openProject = async (dir: string, options: { reopen?: boolean } = {}) => {
      route.push({ dir, options });
    };
    calls.length = 0;
    await store.openRegistryProject("/tmp/proj-picked");
    const [attempt] = route;
    assertEqual(route.length, 1, "the row opens once");
    assertEqual(attempt?.dir, "/tmp/proj-picked", "with the folder from the row");
    assertEqual(attempt?.options, { reopen: true }, "and the same reopen flag the picker passes");
    eqList(calls.map((call) => call.name), [], "opening a row writes nothing to the registry first");

    route.length = 0;
    await store.openRegistryProject("   ");
    assertEqual(route.length, 0, "a row with no folder is not an attempt to open the app's own directory");
  } finally {
    restore();
  }
});

function first<T>(items: readonly T[], label: string): T {
  const [head] = items;
  if (head === undefined) throw new Error(`${label} — got ${items.length} items`);
  return head;
}

function eqList(actual: readonly unknown[], expected: readonly unknown[], label: string): void {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), label);
}
