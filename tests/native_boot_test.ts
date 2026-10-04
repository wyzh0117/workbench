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
  createLayoutInstance,
  initializeContentStatuses,
  now,
} from "../src/domain/index.ts";
import { renderMarkdown } from "../app/markdown.js";
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

interface FileFingerprint {
  exists: boolean;
  mtime_ms: number | null;
  size: number | null;
  hash: string | null;
}

/** The reader position a native restart has to restore. */
interface SessionShape {
  project_dir?: string | null;
  project_id?: string | null;
  active_content_item_id?: string | null;
  layout_page_id?: string | null;
  layout_zoom?: "fit" | "actual";
  mode?: string;
  route?: string;
  right_panel?: string;
}

/** The slice of the running store these tests need. */
interface NativeStore {
  data: ProjectData;
  projectFingerprint: FileFingerprint | null;
  projectFingerprintGeneration: number;
  ui: {
    activeId: string | null;
    layoutPageId: string | null;
    layoutZoom: "fit" | "actual";
    mode: string;
    rightPanel: string;
    route: string;
    toast: unknown;
    importFolderRoot?: string;
    folderScan?: { root: string; entries: Array<Record<string, unknown>> };
    explorerSelected?: string | null;
    explorerPreview?: Record<string, unknown>;
  };
  explorerMarkdownImageUrls?: Record<string, unknown>;
  bridge: {
    projectDir: string | null;
    isNative: () => boolean;
    nativeInput: (command: string, args?: Record<string, unknown>) => unknown;
    command: (name: string, input?: Record<string, unknown>) => Promise<unknown>;
    previewFolderVideoSource: (root: string, relativePath: string) => Promise<unknown>;
    previewAssetVideoSource: (assetId: string) => Promise<unknown>;
  };
  hasNativeLease: () => boolean;
  adoptProjectSnapshot: (state: unknown) => boolean;
  persistProjectSnapshot: (project: ProjectData) => Promise<unknown>;
  addMapItem: (title?: string) => void;
  enterProject: () => void;
  flush: () => Promise<unknown>;
  selectExplorerEntry: (relativePath: string) => Promise<void>;
  clearExplorerPreview: () => void;
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
  locationHref?: string;
  /** When set, the native open-state command fails with this shell message. */
  openError?: string;
}) {
  let fingerprintRevision = 1;
  const fingerprintFor = (project: ProjectData): FileFingerprint => ({
    exists: true,
    mtime_ms: 1_780_000_000_000 + fingerprintRevision,
    size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
    hash: fingerprintRevision.toString(16).padStart(64, "0"),
  });
  const state = {
    /** Last project the shell persisted through `project_save`. */
    project: structuredClone(options.project),
    /** Fingerprint paired with the persisted project snapshot. */
    fingerprint: fingerprintFor(options.project),
    /** `null` until `save_session` writes the file. */
    session: options.persistedSession ? structuredClone(options.persistedSession) : null,
    sessionWrites: 0,
    calls: [] as BridgeCall[],
    invokeOverrides: new Map<string, (args: Record<string, unknown>) => unknown>(),
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
  runtime.location = {
    href: options.locationHref ?? "tauri://localhost/index.html",
  } as unknown as Location;
  globalThis.fetch = async () => {
    throw new Error("原生构建不得使用 fetch 存取项目");
  };

  let launchConsumed = false;
  runtime.__TAURI__ = {
    core: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        state.calls.push({ command, args });
        if (state.invokeOverrides.has(command)) return await state.invokeOverrides.get(command)!(args);
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
          case "project_open_state":
            if (options.openError) throw new Error(options.openError);
            return {
              project: structuredClone(state.project),
              fingerprint: structuredClone(state.fingerprint),
            };
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
            assert(project, "native save must include canonical project data");
            assertEquals(
              args.expectedFingerprint,
              state.fingerprint,
              "native save must use the fingerprint paired with its loaded snapshot",
            );
            state.project = structuredClone(project);
            fingerprintRevision += 1;
            state.fingerprint = fingerprintFor(state.project);
            return {
              fingerprint: structuredClone(state.fingerprint),
              recovery_warning: null,
            };
          }
          case "project_close":
            return null;
          case "project_external_status":
            return { changed: false, current: null };
          case "folder_read_source":
            return { text: "# Native source\n", sha256: "a".repeat(64) };
          case "folder_markdown_image_status": {
            const href = String(args.href || "");
            if (href === "images/example.png") {
              return { status: "present", relative_path: "images/example.png", size: 68, mime: "image/png" };
            }
            if (href === "images/missing.png") {
              return { status: "missing", relative_path: null, size: null, mime: null };
            }
            if (href === "images/large.png") {
              return { status: "present", relative_path: "images/large.png", size: 16 * 1024 * 1024 + 1, mime: "image/png" };
            }
            return { status: "unsafe", relative_path: null, size: null, mime: null };
          }
          case "folder_read_preview":
            if (args.relativePath === "lesson.md") {
              return {
                relative_path: "lesson.md", mime: "text/markdown", size: 200,
                preview_kind: "text",
                text: "# Native source\n\n![present](images/example.png)\n\n![missing](images/missing.png)\n\n![large](images/large.png)\n\n![unsafe](../outside.png)\n\n![remote](https://remote.test/image.png)\n",
                bytes_base64: null, note: null,
              };
            }
            if (args.relativePath === "images/example.png") {
              return {
                relative_path: "images/example.png", mime: "image/png", size: 68,
                preview_kind: "image",
                bytes_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=",
                text: null, note: null,
              };
            }
            return {
              relative_path: "sample.gif",
              mime: "image/gif",
              size: 1,
              preview_kind: "image",
              text: null,
              bytes_base64: null,
              note: null,
            };
          case "folder_preview_source":
            return "/tmp/native-folder-video.mp4";
          case "asset_preview_source":
            return "/tmp/native-asset-video.mp4";
          default:
            return null;
        }
      },
      convertFileSrc: (path: string) => `asset://localhost${path}`,
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

function seededPagedProject(prefix = "page") {
  const data = seededProject();
  const item = data.content_items[0];
  assert(item, "分页夹具必须有当前课时");
  const layout = createLayoutInstance(data, item.id, {
    name: "三页排版",
    mode: "grid",
  });
  layout.pagination_mode = "paged";
  layout.page_size = { preset: "16:9", width_pt: 960, height_pt: 540 };
  const pageIds = [`${prefix}-1`, `${prefix}-2`, `${prefix}-3`];
  data.layout_pages.push(...pageIds.map((id, order_index) => ({
    id,
    layout_instance_id: layout.id,
    title: `第 ${order_index + 1} 页`,
    order_index,
    grid_definition: structuredClone(layout.grid_definition),
  })));
  return { data, itemId: item.id, pageIds };
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
      state.calls.some((call) => call.command === "project_open_state"),
      "启动时必须读取与项目同一快照的 fingerprint",
    );
    const opened = state.calls.find((call) => call.command === "project_open_state");
    assertEquals(
      opened?.args.projectDir,
      "/tmp/native-boot-project",
      "启动时必须为 --project-dir 打开原生项目",
    );
    assertEquals(
      store.projectFingerprint,
      state.fingerprint,
      "启动后 store 必须采用 open_state 返回的 fingerprint",
    );
    assertEquals(store.bridge.projectDir, "/tmp/native-boot-project", "启动目录必须成为当前项目");
    assertEquals(state.session?.project_dir, "/tmp/native-boot-project", "会话必须记录新项目目录");
    assert(state.sessionWrites > 0, "启动流程必须把会话写回磁盘");
  } finally {
    restore();
  }
});

Deno.test("a late save acknowledgement cannot replace a newer accepted project baseline", async () => {
  const { store, state, restore } = await bootNative({
    project: seededProject(),
    launchProjectDir: "/tmp/native-stale-ack-project",
    persistedSession: null,
  });
  try {
    await until(() => store.hasNativeLease(), "stale-ack test project lease");
    let revision = 100;
    const testFingerprint = (project: ProjectData): FileFingerprint => ({
      exists: true,
      mtime_ms: 1_780_000_000_000 + revision,
      size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
      hash: revision.toString(16).padStart(64, "0"),
    });
    let finishSave!: (value: unknown) => void;
    let markSaveStarted!: () => void;
    let staleFingerprint!: FileFingerprint;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    state.invokeOverrides.set("project_save", async (args) => {
      state.project = structuredClone(args.project as ProjectData);
      revision += 1;
      state.fingerprint = testFingerprint(state.project);
      staleFingerprint = structuredClone(state.fingerprint);
      markSaveStarted();
      return await new Promise((resolve) => {
        finishSave = resolve;
      });
    });

    const saving = store.persistProjectSnapshot(structuredClone(store.data));
    await saveStarted;
    const newerProject = structuredClone(state.project);
    newerProject.project.title = "已采用的新版本";
    state.project = structuredClone(newerProject);
    revision += 1;
    state.fingerprint = testFingerprint(state.project);
    const newerFingerprint = structuredClone(state.fingerprint);
    assert(
      store.adoptProjectSnapshot({ project: newerProject, fingerprint: newerFingerprint }),
      "a trusted read must adopt the newer project and fingerprint together",
    );
    const acceptedGeneration = store.projectFingerprintGeneration;

    finishSave({ fingerprint: staleFingerprint, recovery_warning: null });
    await saving;
    assertEquals(store.data.project.title, "已采用的新版本", "late ack must not replace accepted data");
    assertEquals(store.projectFingerprint, newerFingerprint, "late ack must not roll back the accepted fingerprint");
    assertEquals(store.projectFingerprintGeneration, acceptedGeneration, "late ack must not advance the newer generation");
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
    const priorFingerprint = structuredClone(first.store.projectFingerprint);
    await first.store.flush();
    assertEquals(
      first.store.projectFingerprint,
      first.state.fingerprint,
      "成功保存必须把新 fingerprint 与已保存项目一起采用",
    );
    assert(
      JSON.stringify(first.store.projectFingerprint) !== JSON.stringify(priorFingerprint),
      "成功保存必须推进 fingerprint",
    );
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

Deno.test("native launch locator restores the matching persisted layout page", async () => {
  const fixture = seededPagedProject();
  const projectDir = "/private/tmp/tauri-acceptance/project";
  const { store, state, restore } = await bootNative({
    project: fixture.data,
    launchProjectDir: projectDir,
    locationHref: "tauri://localhost/index.html?project_dir=%2Ftmp%2Ftauri-acceptance%2Fproject",
    persistedSession: {
      project_dir: projectDir,
      project_id: fixture.data.project.id,
      active_content_item_id: fixture.itemId,
      layout_page_id: fixture.pageIds[2],
      layout_zoom: "actual",
      mode: "layout",
      route: "editor",
    },
  });
  try {
    await until(() => state.sessionWrites > 0, "写回原生页面会话");
    assertEquals(store.ui.layoutPageId, fixture.pageIds[2], "启动 locator must not replace the saved page with the first page");
    assertEquals(store.ui.layoutZoom, "actual", "启动 locator must preserve layout zoom");
    assertEquals(store.bridge.projectDir, projectDir, "Rust canonical launch directory wins over the URL alias");
    assertEquals(state.session?.layout_page_id, fixture.pageIds[2], "startup session write must retain page three");
    assertEquals(
      state.calls.filter((call) => call.command === "load_session").length,
      2,
      "a launch locator requires one follow-up read of the app-data session",
    );
    const opened = state.calls.find((call) => call.command === "project_open_state");
    assertEquals(opened?.args.projectDir, projectDir, "project.open_state must use the canonical launch directory");
  } finally {
    restore();
  }
});

Deno.test("native launch does not inherit a different project's reader page", async () => {
  const savedProject = seededPagedProject("saved");
  const launchedProject = seededPagedProject("launched");
  const { store, state, restore } = await bootNative({
    project: launchedProject.data,
    launchProjectDir: "/private/tmp/other-project",
    persistedSession: {
      project_dir: "/private/tmp/saved-project",
      project_id: savedProject.data.project.id,
      active_content_item_id: savedProject.itemId,
      layout_page_id: savedProject.pageIds[2],
      mode: "layout",
    },
  });
  try {
    await until(() => state.sessionWrites > 0, "保存新打开项目的默认位置");
    assertEquals(store.ui.layoutPageId, launchedProject.pageIds[0], "a different directory must not inherit page three");
    assertEquals(state.session?.project_dir, "/private/tmp/other-project", "launch target becomes the session identity");
    assertEquals(state.session?.project_id, launchedProject.data.project.id, "launch target project id replaces the unrelated session");
  } finally {
    restore();
  }
});

Deno.test("native relaunch without a launch locator reads a full session once", async () => {
  const fixture = seededPagedProject();
  const projectDir = "/private/tmp/session-only-project";
  const { store, state, restore } = await bootNative({
    project: fixture.data,
    launchProjectDir: null,
    persistedSession: {
      project_dir: projectDir,
      project_id: fixture.data.project.id,
      active_content_item_id: fixture.itemId,
      layout_page_id: fixture.pageIds[2],
      mode: "layout",
    },
  });
  try {
    await until(() => state.sessionWrites > 0, "载入普通 session");
    assertEquals(store.ui.layoutPageId, fixture.pageIds[2], "session-only restart restores its selected page");
    assertEquals(
      state.calls.filter((call) => call.command === "load_session").length,
      1,
      "ordinary persisted sessions are read only once",
    );
  } finally {
    restore();
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

Deno.test("native import, media, and AI bridge calls match Tauri command argument names", async () => {
  const { store, state, restore } = await bootNative({
    project: seededProject(),
    launchProjectDir: "/tmp/native-bridge-project",
    persistedSession: { project_dir: "/tmp/native-bridge-project" },
  });
  try {
    const adoptPlan = {
      root: "/tmp/native-bridge-source",
      confirmed: true,
      items: [],
    };
    await store.bridge.command("folder.adopt", {
      plan: adoptPlan,
      document_paths: ["reading/lesson.md"],
    });
    assertEquals(
      state.calls.find((call) => call.command === "folder_adopt_with_documents")?.args,
      { plan: adoptPlan, documentPaths: ["reading/lesson.md"] },
      "native adoption sends the flat confirmed plan and the direct-child selection",
    );

    const appendPlan = { root: "/tmp/native-bridge-source", confirmed: true, items: [] };
    await store.bridge.command("folder.append", { plan: appendPlan, duplicate_choice: "keep" });
    assertEquals(
      state.calls.find((call) => call.command === "folder_append_with_documents")?.args,
      {
        plan: appendPlan,
        projectDir: "/tmp/native-bridge-project",
        documentPaths: [],
        duplicateChoice: "keep",
      },
      "folder.append's flat Rust parameters must receive Tauri camelCase projectDir and document paths",
    );

    await store.bridge.previewFolderVideoSource("/tmp/native-bridge-source", "clips/large.mp4");
    assertEquals(
      state.calls.find((call) => call.command === "folder_preview_source")?.args,
      { root: "/tmp/native-bridge-source", relativePath: "clips/large.mp4" },
      "folder.preview_source must receive relativePath",
    );
    await store.bridge.command("folder.markdown_image_status", {
      root: "/tmp/native-bridge-source",
      markdownRelativePath: "lesson.md",
      href: "images/example.png",
    });
    assertEquals(
      state.calls.find((call) => call.command === "folder_markdown_image_status")?.args,
      {
        root: "/tmp/native-bridge-source",
        markdownRelativePath: "lesson.md",
        href: "images/example.png",
      },
      "Markdown dependency status must match the native command's camelCase argument names",
    );
    store.ui.importFolderRoot = "/tmp/native-preview-root";
    store.ui.folderScan = {
      root: "/tmp/native-preview-root",
      entries: [{ relative_path: "sample.gif", kind: "file", mime: "image/gif", size: 1 }],
    };
    await store.selectExplorerEntry("sample.gif");
    assertEquals(
      state.calls.find((call) => call.command === "folder_read_preview")?.args,
      { root: "/tmp/native-preview-root", relativePath: "sample.gif" },
      "folder.read_preview must receive Tauri's relativePath argument for GIF/PDF/text previews",
    );
    assert(!store.ui.explorerPreview?.failed, "a valid native file preview must not fail its path check");
    await store.bridge.previewAssetVideoSource("video-1");
    assertEquals(
      state.calls.find((call) => call.command === "asset_preview_source")?.args,
      { input: { asset_id: "video-1", project_dir: "/tmp/native-bridge-project" } },
      "asset.preview_source takes its project-scoped payload under input",
    );

    const imageHost = globalThis as typeof globalThis & { Image?: unknown };
    const previousImage = imageHost.Image;
    class FakeImage {
      naturalWidth = 1;
      naturalHeight = 1;
      onload?: () => void;
      onerror?: () => void;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    imageHost.Image = FakeImage;
    try {
      store.ui.importFolderRoot = "/tmp/native-preview-root";
      store.ui.folderScan = {
        root: "/tmp/native-preview-root",
        entries: [{ relative_path: "lesson.md", kind: "file", mime: "text/markdown", size: 200 }],
      };
      await store.selectExplorerEntry("lesson.md");
      const markdownPreview = store.ui.explorerPreview;
      const markdownText = String(markdownPreview?.text || "");
      const resolvedImage = store.explorerMarkdownImageUrls?.["images/example.png"] as { url?: string };
      assert(resolvedImage?.url, "a present local image should receive a safe preview URL");
      assertEquals(
        state.calls.find((call) => call.command === "folder_markdown_image_status" &&
          call.args.root === "/tmp/native-preview-root" && call.args.href === "images/example.png")?.args,
        { root: "/tmp/native-preview-root", markdownRelativePath: "lesson.md", href: "images/example.png" },
        "Markdown image status must be scoped to the selected root and source file",
      );
      assert(
        state.calls.some((call) => call.command === "folder_read_preview" && call.args.relativePath === "images/example.png"),
        "only the validated referenced image should be read through the controlled preview command",
      );
      assert(
        !state.calls.some((call) => call.command === "folder_read_preview" && call.args.relativePath === "images/large.png"),
        "oversized referenced images must remain placeholders without loading bytes",
      );
      assert(
        !state.calls.some((call) => call.command === "folder_markdown_image_status" && call.args.href === "https://remote.test/image.png"),
        "remote image URLs must not be fetched",
      );
      const html = renderMarkdown(markdownText, {
        resolveImage: (href) => store.explorerMarkdownImageUrls?.[href] || null,
      });
      assert(html.includes(`<img src="${resolvedImage.url}"`), "the Markdown renderer should show the authorized local image");
      assert(html.includes("找不到本地图片"), "a missing image should retain a readable placeholder");
      assert(html.includes("16 MiB"), "oversized images should explain the preview limit");
      assert(html.includes("超出来源目录"), "unsafe paths should stay placeholders");

      let resolveStatus!: (value: unknown) => void;
      state.invokeOverrides.set("folder_markdown_image_status", () => new Promise((resolve) => {
        resolveStatus = resolve;
      }));
      const staleSelection = store.selectExplorerEntry("lesson.md");
      await until(() => typeof resolveStatus === "function", "等待资源图片授权检查开始");
      store.clearExplorerPreview();
      resolveStatus({ status: "present", relative_path: "images/example.png", size: 68, mime: "image/png" });
      await staleSelection;
      assertEquals(
        store.explorerMarkdownImageUrls,
        {},
        "a late dependency response must not repopulate a cleared preview",
      );
      assertEquals(
        state.calls.filter((call) => call.command === "folder_read_preview" && call.args.relativePath === "images/example.png").length,
        1,
        "a stale authorization result must not read image bytes",
      );
    } finally {
      imageHost.Image = previousImage;
    }

    const aiCalls: Array<[string, Record<string, unknown>]> = [
      ["ai.models.probe", { provider_id: "provider", api_key: "test-only-credential" }],
      ["ai.connection.test", { provider_id: "saved" }],
      ["ai.subscription.start", { provider_id: "account" }],
      ["ai.subscription.status", { attempt_id: "attempt" }],
      ["ai.subscription.cancel", { attempt_id: "attempt" }],
      ["ai.subscription.logout", { provider_id: "account" }],
    ];
    for (const [name, args] of aiCalls) await store.bridge.command(name, args);
    for (const [name, expected] of aiCalls) {
      const command = name.replaceAll(".", "_");
      const call = state.calls.find((candidate) => candidate.command === command);
      assert(call, `${name} must map to ${command}`);
      assertEquals(call.args, expected, `${name} must retain its native payload without project injection`);
    }
  } finally {
    restore();
  }
});
