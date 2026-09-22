/**
 * Native (Tauri) boot-path tests.
 *
 * Importing `app/main.js` runs the same module-level boot the desktop window
 * runs, so these tests drive the *real* `DesktopBridge` through a fake
 * `__TAURI__.core.invoke` and then inspect the live store exposed as
 * `globalThis.__workbench`.  The browser build is covered separately; this file
 * only asserts what the desktop shell must do to satisfy
 * "打开课程 → … → 关闭 → 重启 → 继续工作".
 */
import {
  appendBlock,
  createDocument,
  createEmptyProjectData,
  initializeContentStatuses,
  now,
} from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
}

interface BridgeCall {
  command: string;
  args: Record<string, unknown>;
}

/** The reader position a native restart has to restore. */
interface SessionShape {
  project_dir?: string | null;
  project_id?: string | null;
  active_content_item_id?: string | null;
  mode?: string;
  route?: string;
  right_panel?: string;
}

/** The slice of the running store these tests need. */
interface NativeStore {
  data: ProjectData;
  ui: {
    activeId: string | null;
    mode: string;
    rightPanel: string;
    route: string;
    toast: unknown;
  };
  bridge: {
    projectDir: string | null;
    isNative: () => boolean;
    nativeInput: (command: string, args?: Record<string, unknown>) => unknown;
  };
  hasNativeLease: () => boolean;
  addMapItem: (title?: string) => void;
  enterProject: () => void;
  flush: () => Promise<unknown>;
}

let importCounter = 0;

/** Poll until `predicate` holds; UI boot is asynchronous by design. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`等待超时：${label}`);
}

/**
 * Boot the real module over a fake native shell.
 *
 * `launchProjectDir` stands in for `workbench --project-dir <path>`: the first
 * `load_session` returns it.  Passing `null` simulates a plain relaunch, where
 * the persisted session is the only thing pointing at a project.
 */
async function bootNative(options: {
  project: ProjectData;
  launchProjectDir: string | null;
  persistedSession?: SessionShape | null;
  /** When set, `project_open` fails with this shell message. */
  openError?: string;
}) {
  const state = {
    /** Last project the shell persisted through `project_save`. */
    project: structuredClone(options.project),
    /** `null` until `save_session` writes the file. */
    session: options.persistedSession ? structuredClone(options.persistedSession) : null,
    sessionWrites: 0,
    calls: [] as BridgeCall[],
    closeRequested: null as ((event: { preventDefault?: () => void }) => void) | null,
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
    location?: unknown;
  };
  const previous = {
    document: runtime.document,
    tauri: runtime.__TAURI__,
    location: runtime.location,
    workbench: runtime.__workbench,
    fetch: globalThis.fetch,
  };
  runtime.document = {
    querySelector: () => root,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  runtime.location = { href: "tauri://localhost/index.html" } as unknown as Location;
  globalThis.fetch = async () => {
    throw new Error("原生构建不得使用 fetch 存取项目");
  };

  let launchConsumed = false;
  runtime.__TAURI__ = {
    core: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        state.calls.push({ command, args });
        switch (command) {
          case "load_session": {
            if (!launchConsumed && options.launchProjectDir) {
              launchConsumed = true;
              return { project_dir: options.launchProjectDir };
            }
            return state.session ? structuredClone(state.session) : null;
          }
          case "project_open":
            // The shell resolves the directory before reading, so a directory
            // that is gone or leased elsewhere fails here.
            if (options.openError) throw new Error(options.openError);
            return structuredClone(state.project);
          case "read_recovery_journal":
            return null;
          case "clear_recovery_journal":
            return null;
          case "save_session": {
            // Rust writes an unlocked session when no directory is given, so
            // clearing the session is always allowed.
            const session = (args.session || {}) as SessionShape;
            state.session = structuredClone(session);
            state.sessionWrites += 1;
            return null;
          }
          case "project_save": {
            const project = args.project as ProjectData | undefined;
            if (project) state.project = structuredClone(project);
            return { saved_at: "2026-01-01T00:00:00.000Z" };
          }
          case "project_close":
            return null;
          case "project_external_status":
            return { changed: false, current: null };
          default:
            return null;
        }
      },
    },
    window: {
      getCurrentWindow: () => ({
        onCloseRequested: async (handler: (event: { preventDefault?: () => void }) => void) => {
          state.closeRequested = handler;
          return () => {};
        },
        onDragDropEvent: async () => () => {},
      }),
    },
    event: { listen: async () => () => {} },
  };

  importCounter += 1;
  await import(`../app/main.js?native-boot-${importCounter}`);
  const store = runtime.__workbench as unknown as NativeStore;
  assert(store && store.data && store.ui, "模块启动后必须暴露运行中的工作台");
  await (runtime as { __workbenchReady?: Promise<void> }).__workbenchReady;

  const restore = () => {
    runtime.document = previous.document;
    runtime.__TAURI__ = previous.tauri;
    runtime.location = previous.location;
    runtime.__workbench = previous.workbench;
    globalThis.fetch = previous.fetch;
  };

  return { store, state, root, restore };
}

/**
 * A two-lesson project, built through the real domain API.
 *
 * Deliberately pure data: booting a throwaway store to produce the fixture
 * would load a second instance of `app/main.js`, whose timers and globals
 * would then race the store under test.
 */
function seededProject(): ProjectData {
  const data = createEmptyProjectData("原生启动测试");
  const stage = data.stages[0];
  ["第一课", "第二课"].forEach((title, index) => {
    const contentId = crypto.randomUUID();
    const document = createDocument(data, contentId);
    data.content_items.push({
      id: contentId,
      project_id: data.project.id,
      stage_id: stage?.id ?? null,
      code: `S01-0${index + 1}`,
      title,
      type: "lesson",
      description: "",
      order_index: index,
      document_id: document.id,
      archived: false,
      created_at: now(),
      updated_at: now(),
    });
    initializeContentStatuses(data, contentId);
    appendBlock(data, contentId, "paragraph", `${title}的正文`);
  });
  assert(data.content_items.length === 2, "测试夹具必须包含两节课");
  return data;
}

Deno.test("native launch opens the --project-dir project and persists it", async () => {
  const { store, state, restore } = await bootNative({
    project: seededProject(),
    launchProjectDir: "/tmp/native-boot-project",
    persistedSession: { project_dir: "/tmp/some-old-project" },
  });
  try {
    await until(() => store.data.content_items.length >= 2, "载入课程内容");
    assert(
      state.calls.some((call) => call.command === "project_open"),
      "启动时必须打开 --project-dir 指向的项目",
    );
    assertEquals(store.bridge.projectDir, "/tmp/native-boot-project", "启动目录必须成为当前项目");
    assertEquals(state.session?.project_dir, "/tmp/native-boot-project", "会话必须记录新项目目录");
    assert(state.sessionWrites > 0, "启动流程必须把会话写回磁盘");
  } finally {
    restore();
  }
});

Deno.test("native close immediately flushes and releases the committed project session", async () => {
  const { store, state, restore } = await bootNative({
    project: seededProject(),
    launchProjectDir: "/tmp/native-close-project",
    persistedSession: null,
  });
  try {
    await until(() => store.data.content_items.length >= 2, "关闭测试载入课程");
    const lesson = store.data.content_items[1];
    assert(lesson != null, "关闭测试必须有可选课程");
    store.ui.activeId = lesson.id;
    store.ui.mode = "preview";
    store.ui.route = "media";
    state.closeRequested?.({ preventDefault: () => {} });
    await until(() => state.calls.some((call) => call.command === "confirm_close"), "完成原生关闭");
    const closeOrder = state.calls
      .filter((call) => ["project_save", "project_close", "confirm_close"].includes(call.command))
      .map((call) => call.command);
    assert(closeOrder.indexOf("project_save") >= 0, "立即关闭必须先保存 canonical 项目");
    assert(closeOrder.indexOf("project_close") > closeOrder.indexOf("project_save"), "立即关闭必须先写完再释放租约");
    assert(closeOrder.indexOf("confirm_close") > closeOrder.indexOf("project_close"), "立即关闭必须释放租约后再确认退出");
    assertEquals(state.session?.project_dir, "/tmp/native-close-project", "关闭保存不得丢失项目目录");
    assertEquals(state.session?.project_id, store.data.project.id, "关闭保存不得丢失项目标识");
    assertEquals(state.session?.active_content_item_id, lesson.id, "关闭保存必须保留当前课程");
    assertEquals(state.session?.mode, "preview", "关闭保存必须保留当前模式");
  } finally {
    restore();
  }
});

Deno.test("native session keeps the reader position for restart", async () => {
  const project = seededProject();
  const first = await bootNative({
    project,
    launchProjectDir: "/tmp/native-boot-project",
    persistedSession: null,
  });
  try {
    await until(() => first.store.data.content_items.length >= 2, "首次载入课程");
    const second = first.store.data.content_items[1];
    assert(second != null, "夹具必须提供第二节课");
    first.store.ui.mode = "structure";
    first.store.ui.activeId = second.id;
    first.store.ui.rightPanel = "media";
    first.store.ui.route = "media";
    await first.store.flush();
    // The reader position is persisted by the session timer, not by `flush`.
    await until(() => (first.state.session?.mode ?? "") === "structure", "写入读者位置");
    const saved: SessionShape | null = structuredClone(first.state.session);
    assertEquals(saved?.active_content_item_id, second.id, "会话必须记录当前课");
    assertEquals(saved?.right_panel, "media", "会话必须记录当前右栏");
    assertEquals(saved?.project_id, first.store.data.project.id, "会话必须记录项目标识");

    // A plain relaunch: only the persisted session points at the project.
    const relaunch = await bootNative({
      project: first.state.project,
      launchProjectDir: null,
      persistedSession: saved,
    });
    try {
      await until(() => relaunch.store.data.content_items.length >= 2, "重启后载入课程");
      assertEquals(
        relaunch.store.bridge.projectDir,
        "/tmp/native-boot-project",
        "重启后必须回到同一项目",
      );
      assertEquals(relaunch.store.ui.activeId, second.id, "重启后必须回到同一课");
      assertEquals(relaunch.store.ui.mode, "structure", "重启后必须回到同一模式");
      assertEquals(relaunch.store.ui.rightPanel, "media", "重启后必须回到同一右栏");
      assertEquals(relaunch.store.ui.route, "media", "重启后必须回到同一视图");
      // Booting must not persist empty defaults over the restored position:
      // quitting an untouched window has to keep the reader where it was.
      assertEquals(
        relaunch.state.session?.active_content_item_id,
        second.id,
        "启动不得用空位置覆盖会话里的当前课",
      );
      assertEquals(relaunch.state.session?.route, "media", "启动不得覆盖会话里的视图");
      assertEquals(relaunch.state.session?.mode, "structure", "启动不得覆盖会话里的模式");
      // The launcher must name the lesson it will resume, and resume the
      // restored view rather than resetting it to the editor.
      const launcher = relaunch.root.innerHTML;
      const card = launcher.slice(
        launcher.indexOf('class="recent-card"'),
        launcher.indexOf("seed-choices"),
      );
      assert(card.length > 0, "启动页必须渲染继续工作卡片");
      assert(
        card.includes('data-action="enter-project"'),
        "启动页的「继续工作」必须走会话恢复路径",
      );
      assert(
        !card.includes('data-action="open-item"'),
        "启动页不得再直接打开某一课而丢掉已恢复的视图",
      );
      assert(card.includes(second.title), "启动页卡片必须显示将恢复的那一课");
      // "继续工作" must not reset the restored view back to the editor.
      relaunch.store.enterProject();
      assertEquals(relaunch.store.ui.route, "media", "进入项目必须保留会话恢复的视图");
      assertEquals(relaunch.store.ui.activeId, second.id, "进入项目必须保留会话恢复的课");
    } finally {
      relaunch.restore();
    }
  } finally {
    first.restore();
  }
});

Deno.test("native boot degrades to the launcher when the project cannot open", async () => {
  const { store, state, restore } = await bootNative({
    project: seededProject(),
    launchProjectDir: "/tmp/native-boot-gone",
    // A real position must exist first, otherwise "was it cleared?" cannot be
    // observed: a null session would pass either way.
    persistedSession: {
      project_dir: "/tmp/native-boot-gone",
      project_id: "gone-project",
      active_content_item_id: "gone-lesson",
      mode: "preview",
      route: "media",
      right_panel: "media",
    },
    openError: "项目目录不存在",
  });
  try {
    await until(
      () => typeof store.ui.toast === "string" && store.ui.toast.length > 0,
      "启动失败提示",
    );
    assert(store.bridge.isNative(), "必须运行在原生模式");
    assertEquals(store.data.content_items.length, 0, "打不开的项目不得留下半个课程");
    assertEquals(store.bridge.projectDir, null, "打不开的项目不得留在会话里");
    assertEquals(state.session?.project_dir ?? null, null, "必须清空会话里的失效目录");
  } finally {
    restore();
  }
});

Deno.test("a project that is only leased elsewhere keeps its resume pointer", async () => {
  const project = seededProject();
  const pointer: SessionShape = {
    project_dir: "/tmp/native-boot-project",
    project_id: project.project.id,
    active_content_item_id: project.content_items[1]?.id ?? null,
    mode: "preview",
    route: "media",
    right_panel: "requirements",
  };
  const { store, state, restore } = await bootNative({
    project,
    launchProjectDir: "/tmp/native-boot-project",
    persistedSession: pointer,
    openError: "project_locked: 该项目已在另一窗口或进程中编辑。",
  });
  try {
    await until(
      () => typeof store.ui.toast === "string" && store.ui.toast.includes("正在其他窗口或进程中使用"),
      "锁冲突提示",
    );
    assert(!store.hasNativeLease(), "被拒绝时不得持有项目租约");
    // The window is still shutting down, not gone: erasing the pointer would
    // lose the reader position for good.
    assertEquals(state.session?.project_dir, "/tmp/native-boot-project", "锁冲突不得清空项目目录");
    assertEquals(state.session?.mode, "preview", "锁冲突不得清空阅读位置");
    assertEquals(state.session?.route, "media", "锁冲突不得清空所在视图");
  } finally {
    restore();
  }
});

Deno.test("asset.read carries the nested input the shell expects", async () => {
  const { store, restore } = await bootNative({
    project: seededProject(),
    launchProjectDir: "/tmp/native-boot-project",
    persistedSession: { project_dir: "/tmp/native-boot-project" },
  });
  try {
    const payload = store.bridge.nativeInput("asset.read", { asset_id: "asset-1" }) as {
      input?: { asset_id?: string; project_dir?: string };
      asset_id?: string;
    };
    // `fn asset_read(input: Value)` reads a nested struct: sending the keys
    // flat makes the shell reject every preview with "missing required key
    // input", which is exactly the bug this pins.
    assert(payload.input != null, "asset.read 必须把参数包在 input 里");
    assert(payload.asset_id === undefined, "asset.read 不得发送平铺参数");
    assertEquals(payload.input?.asset_id, "asset-1", "input 必须带素材 ID");
    assertEquals(
      payload.input?.project_dir,
      "/tmp/native-boot-project",
      "input 必须带项目目录",
    );
  } finally {
    restore();
  }
});
