/**
 * V1-T02 Dogfooding regression tests (first implementation: P0 + P1).
 *
 * These cover the real-use failures the task card names, at the layer where
 * they actually happened:
 *
 *  - the project picker silently doing nothing on a second open,
 *  - focus / caret / IME being destroyed by an autosave re-render,
 *  - a dialog closing when its own content was clicked,
 *  - hint text leaking into canonical content,
 *  - the course title having no editing path,
 *  - a Requirement type that only one panel could change,
 *  - a preview that drew Grid content in Flow order.
 *
 * The store-level tests drive a constructed `WorkbenchStore`; the DOM-level
 * tests drive the running singleton (`globalThis.__workbench`) against a small
 * DOM stand-in that models exactly the parts `render()` touches: innerHTML
 * replacement, scroll positions, focus and capture-phase document events.
 */
import {
  appendBlock,
  createDocument,
  createEmptyProjectData,
  initializeContentStatuses,
  now,
} from "../src/domain/index.ts";
import { validateProjectData } from "../src/domain/store.ts";
import type { ProjectData } from "../src/domain/types.ts";
import {
  freeCellsFor,
  lessonView,
  occupiedCells,
  requirementBacklog,
} from "../app/authoring.js";
import { createViews } from "../app/views.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let importCounter = 0;

/* ------------------------------------------------------------------ *
 * DOM stand-in
 * ------------------------------------------------------------------ */

type Listener = (event: any) => void;

interface FakeNode {
  nodeType: number;
  dataset: Record<string, string>;
  value: string;
  innerHTML: string;
  outerHTML: string;
  scrollTop: number;
  scrollLeft: number;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: string;
  listeners: Map<string, Listener[]>;
  /** Whose subtree this node belongs to; `null` means "not in the app root". */
  parent: FakeNode | null;
  inRoot: boolean;
  focused: number;
  addEventListener(type: string, handler: Listener): void;
  closest(selector: string): FakeNode | null;
  focus(options?: unknown): void;
  select(): void;
  setSelectionRange(start: number, end: number, direction?: string): void;
  fire(type: string, event?: Record<string, unknown>): void;
}

/** The stand-in document installed by `bootDom`, used for focus bookkeeping. */
let activeDocument: any = null;

function createNode(
  dataset: Record<string, string> = {},
  options: { value?: string; inRoot?: boolean; parent?: FakeNode | null } = {},
): FakeNode {
  const node: FakeNode = {
    nodeType: 1,
    dataset,
    value: options.value ?? "",
    innerHTML: "",
    outerHTML: "",
    scrollTop: 0,
    scrollLeft: 0,
    selectionStart: null,
    selectionEnd: null,
    selectionDirection: "none",
    listeners: new Map(),
    parent: options.parent ?? null,
    inRoot: options.inRoot ?? true,
    focused: 0,
    addEventListener(type, handler) {
      const list = node.listeners.get(type) ?? [];
      list.push(handler);
      node.listeners.set(type, list);
    },
    closest(selector) {
      let current: FakeNode | null = node;
      while (current) {
        if (selector === "[data-stop-click='true']") {
          if (current.dataset.stopClick === "true") return current;
        } else if (selector === "[data-action]") {
          if (current.dataset.action) return current;
        } else if (selector.startsWith("[data-action=")) {
          const wanted = selector.slice(13, -1);
          if (current.dataset.action === wanted) return current;
        } else if (current === node && selector === "summary") {
          return current.dataset.node === "summary" ? current : null;
        }
        current = current.parent;
      }
      return null;
    },
    focus() {
      node.focused += 1;
      if (activeDocument?.activeElement && activeDocument.activeElement !== node) {
        activeDocument.activeElement.fire("focusout", {
          target: activeDocument.activeElement,
        });
      }
      if (activeDocument) activeDocument.activeElement = node;
    },
    select() {},
    setSelectionRange(start, end, direction) {
      node.selectionStart = start;
      node.selectionEnd = end;
      node.selectionDirection = direction ?? "none";
    },
    fire(type, event = {}) {
      // Only the newest listener runs: a real innerHTML replacement creates a
      // fresh element, so the handlers an earlier bindEvents pass attached to
      // the old node are gone.  Firing every accumulated handler instead would
      // multiply the action dispatch on each render.
      const handlers = node.listeners.get(type) ?? [];
      const handler = handlers.at(-1);
      if (handler) handler({ target: node, currentTarget: node, ...event });
    },
  };
  return node;
}

/**
 * Install the stand-in DOM and import a fresh `app/main.js`.
 *
 * `htmlWrites` records every full-shell render, which is how a test proves that
 * an autosave did *not* rebuild the editor.
 */
async function bootDom() {
  const htmlWrites: string[] = [];
  const documentListeners = new Map<string, Listener[]>();
  const rootListeners = new Map<string, Listener[]>();
  const registered = new Map<string, FakeNode>();
  const scrollNodes = new Map<string, FakeNode[]>();
  const actionNodes: FakeNode[] = [];
  const textEditors: FakeNode[] = [];
  let detachOnNextRender: FakeNode | null = null;
  let activeDialog: any = null;
  let dialogRendered = false;
  let currentHtml = "";

  const root: any = {
    get innerHTML() {
      return currentHtml;
    },
    set innerHTML(value: string) {
      currentHtml = value;
      dialogRendered = value.includes('role="dialog" aria-modal="true"');
      htmlWrites.push(value);
      if (detachOnNextRender) {
        detachOnNextRender.inRoot = false;
        detachOnNextRender = null;
      }
      // Replacing innerHTML throws the old subtree away, so every scroll
      // container starts at the top again — exactly what render() must undo.
      for (const nodes of scrollNodes.values()) {
        for (const node of nodes) {
          node.scrollTop = 0;
          node.scrollLeft = 0;
        }
      }
    },
    dataset: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: (type: string, handler: Listener) => {
      const list = rootListeners.get(type) ?? [];
      list.push(handler);
      rootListeners.set(type, list);
    },
    contains: (node: FakeNode | null) => Boolean(node && node.inRoot),
    querySelector: (selector: string) => {
      if (selector === '[role="dialog"][aria-modal="true"]') {
        return dialogRendered ? activeDialog : null;
      }
      return registered.get(selector) ?? null;
    },
    querySelectorAll: (selector: string) => {
      if (selector === "[data-action]") return actionNodes;
      if (selector === "textarea[data-block-id], input[data-block-id]") return textEditors;
      return scrollNodes.get(selector) ?? [];
    },
  };

  const document: any = {
    activeElement: null,
    querySelector: () => root,
    querySelectorAll: () => [],
    addEventListener: (type: string, handler: Listener, capture?: boolean) => {
      if (!capture && type !== "keydown") return;
      const list = documentListeners.get(type) ?? [];
      list.push(handler);
      documentListeners.set(type, list);
    },
  };

  const runtime = globalThis as typeof globalThis & {
    document?: unknown;
    __TAURI__?: unknown;
    __workbench?: unknown;
    __workbenchReady?: unknown;
  };
  const previous = {
    document: runtime.document,
    tauri: runtime.__TAURI__,
    workbench: runtime.__workbench,
    ready: runtime.__workbenchReady,
    fetch: globalThis.fetch,
  };
  runtime.document = document;
  activeDocument = document;
  runtime.__TAURI__ = undefined;
  globalThis.fetch = async () => {
    throw new Error("test fetch disabled");
  };
  importCounter += 1;
  await import(`../app/main.js?dogfooding-${importCounter}`);
  const store = runtime.__workbench as any;
  assert(store, "the running workbench must be reachable as __workbench");
  // The real browser boot may resolve a session and render once; wait for it so
  // a test's own assertions are not interleaved with startup work.
  try {
    await runtime.__workbenchReady;
  } catch { /* a failed boot degrades to the launcher, which is fine here */ }
  htmlWrites.length = 0;

  const fireDocument = (type: string, event: Record<string, unknown>) => {
    const handlers = documentListeners.get(type) ?? [];
    for (const handler of handlers) handler(event);
    return handlers.length;
  };

  const fireRoot = (type: string, event: Record<string, unknown>) => {
    const handlers = rootListeners.get(type) ?? [];
    for (const handler of handlers) handler(event);
    return handlers.length;
  };

  /** Show a project screen and render it, with the given selectors registered. */
  const renderProject = (data: ProjectData, ui: Record<string, unknown> = {}) => {
    store.data = data;
    store.ui.screen = "project";
    store.ui.route = "editor";
    store.ui.mode = "writing";
    store.ui.activeId = data.content_items[0]?.id ?? null;
    Object.assign(store.ui, ui);
    registered.clear();
    store.notify();
    return currentHtml;
  };

  return {
    store,
    root,
    document,
    htmlWrites,
    registered,
    scrollNodes,
    actionNodes,
    textEditors,
    createNode,
    detachOnNextRender: (node: FakeNode) => { detachOnNextRender = node; },
    renderProject,
    fireDocument,
    fireRoot,
    setActiveDialog: (dialog: unknown) => { activeDialog = dialog; },
    lastHtml: () => currentHtml,
    restore: () => {
      runtime.document = previous.document;
      runtime.__TAURI__ = previous.tauri;
      runtime.__workbench = previous.workbench;
      runtime.__workbenchReady = previous.ready;
      globalThis.fetch = previous.fetch;
      clearTimeout(store.saveTimer);
      clearTimeout(store.sessionTimer);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Store harness (no DOM): a native shell with two project folders
 * ------------------------------------------------------------------ */

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

function nativeBridge(
  projects: Record<string, ProjectData>,
  initialDir: string | null,
  picker: { next: string | null },
) {
  let currentDir = initialDir;
  let latestSession: any = null;
  const revisions = new Map(Object.keys(projects).map((dir) => [dir, 1]));
  const leases = new Map<string, string>();
  if (initialDir && projects[initialDir]) leases.set(initialDir, `lease:${initialDir}`);
  const fingerprintFor = (project: ProjectData, revision: number) => ({
    exists: true,
    mtime_ms: 1_780_000_000_000 + revision,
    size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
    hash: revision.toString(16).padStart(64, "0"),
  });
  const currentFingerprint = () => {
    const project = currentDir ? projects[currentDir] : null;
    if (!currentDir || !project) {
      return { exists: false, mtime_ms: null, size: null, hash: null };
    }
    return fingerprintFor(project, revisions.get(currentDir) ?? 1);
  };
  const calls: string[] = [];
  const bridge: any = {
    projectDir: currentDir,
    projectDirFromUrl: false,
    lastOpenedProjectState: initialDir && projects[initialDir]
      ? {
        project: structuredClone(projects[initialDir]),
        project_id: projects[initialDir]!.project.id,
        project_dir: initialDir,
        lease_generation: leases.get(initialDir),
        fingerprint: currentFingerprint(),
      }
      : null,
    isNative: () => true,
    currentProject: () => (currentDir ? projects[currentDir] : null),
    setProjectDir: (value: string) => {
      currentDir = value;
      bridge.projectDir = value;
    },
    restoreProjectDir: (value: string | null) => {
      currentDir = value;
      bridge.projectDir = value;
    },
    selectFolder: async () => {
      calls.push("pick");
      return picker.next;
    },
    openProject: async () => {
      const project = currentDir ? projects[currentDir] : null;
      if (!project) throw new Error("项目目录不存在");
      calls.push(`open:${currentDir}`);
      const lease = `lease:${currentDir}`;
      leases.set(currentDir!, lease);
      bridge.lastOpenedProjectState = {
        project: structuredClone(project),
        project_id: project.project.id,
        project_dir: currentDir,
        lease_generation: lease,
        fingerprint: currentFingerprint(),
      };
      return structuredClone(project);
    },
    readProject: async () =>
      currentDir && projects[currentDir] ? structuredClone(projects[currentDir]) : null,
    readProjectState: async () => {
      const project = currentDir && projects[currentDir]
        ? structuredClone(projects[currentDir])
        : null;
      const state = {
        project,
        project_id: project?.project.id ?? null,
        project_dir: currentDir,
        lease_generation: currentDir ? leases.get(currentDir) ?? null : null,
        fingerprint: currentFingerprint(),
      };
      if (state.lease_generation && state.project) bridge.lastOpenedProjectState = structuredClone(state);
      return state;
    },
    readRecoveryJournal: async () => null,
    listenNativeDrops: async () => () => {},
    writeRecoveryJournal: async () => {},
    writeProject: async (request: any) => {
      const dir = currentDir;
      if (
        !dir || !projects[dir] || request.project_dir !== dir ||
        request.expected_project_id !== projects[dir]!.project.id ||
        request.lease_generation !== leases.get(dir) ||
        JSON.stringify(request.expected_fingerprint) !== JSON.stringify(currentFingerprint())
      ) {
        throw new Error("external_modification_conflict");
      }
      const nextProject = structuredClone(request.project);
      projects[dir] = nextProject;
      const nextRevision = (revisions.get(dir) ?? 1) + 1;
      revisions.set(dir, nextRevision);
      const fingerprint = fingerprintFor(nextProject, nextRevision);
      return {
        project_id: request.expected_project_id,
        lease_generation: request.lease_generation,
        editor_generation: request.editor_generation,
        operation_id: request.operation_id,
        revision: request.revision,
        outcome: "written",
        commit_state: "committed",
        fingerprint,
        recovery_warning: null,
        durability_warning: null,
      };
    },
    clearRecoveryJournal: async () => {},
    projectIdentity: async () =>
      currentDir && projects[currentDir] ? projects[currentDir]!.project.id : null,
    saveSession: async () => {},
    loadSession: async () => latestSession,
    closeProject: async (dir: string) => {
      calls.push(`close:${dir}`);
    },
    command: async () => ({}),
  };
  return { bridge, calls };
}

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
    `../app/main.js?dogfooding-store-${importCounter}`
  );
  const store = new (WorkbenchStore as new (bridge: unknown) => any)(bridge);
  return {
    store,
    restore: () => {
      runtime.document = previousDocument;
      clearTimeout(store.saveTimer);
      clearTimeout(store.sessionTimer);
    },
  };
}

/* ------------------------------------------------------------------ *
 * P0-1 项目选择后无法再次打开项目
 * ------------------------------------------------------------------ */

Deno.test("the project picker opens A, B, and A again without going silent", async () => {
  const a = projectWith("课程 A");
  const b = projectWith("课程 B");
  const projects: Record<string, ProjectData> = { "/tmp/a": a, "/tmp/b": b };
  const picker = { next: "/tmp/a" as string | null };
  const { bridge, calls } = nativeBridge(projects, null, picker);
  const { store, restore } = await bootStore(bridge);
  try {
    // open A
    await store.openProjectFromPicker();
    assert(bridge.projectDir === "/tmp/a", "the first pick must open A");
    assert(store.data.project.title === "课程 A", "A must be the open project");
    assert(
      calls.filter((call) => call === "open:/tmp/a").length === 1,
      "opening A must really read it once",
    );

    // home
    store.returnToLauncher();
    assert(store.ui.screen === "launcher", "the launcher must be reachable again");

    // open B
    picker.next = "/tmp/b";
    await store.openProjectFromPicker();
    assert(bridge.projectDir === "/tmp/b", "the second pick must switch to B");
    assert(store.data.project.title === "课程 B", "B must replace A");

    // home, then open A again — the case that used to do nothing at all
    store.returnToLauncher();
    picker.next = "/tmp/a";
    await store.openProjectFromPicker();
    assert(bridge.projectDir === "/tmp/a", "re-opening A must set the project dir");
    assert(
      store.data.project.title === "课程 A",
      "re-opening A must show A again, not stay on B",
    );
    assert(
      calls.filter((call) => call === "open:/tmp/a").length === 2,
      "re-opening A must re-read it from disk instead of silently returning",
    );
    assert(
      !/无法打开项目/.test(String(store.ui.toast)),
      "re-opening A must not report a failure",
    );

    // A cancelled pick must say so instead of looking dead.
    store.returnToLauncher();
    picker.next = null;
    await store.openProjectFromPicker();
    assert(/没有选择文件夹/.test(String(store.ui.toast)), "a cancelled pick must explain itself");
    assert(bridge.projectDir === "/tmp/a", "a cancelled pick must not change the project");
    assert(
      !/project\.bak/.test(String(store.ui.toast)),
      "success and cancel paths must not require project.bak",
    );
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * V1-T03 — Valid project folder open-error contract (§7.3)
 * ------------------------------------------------------------------ */

const OPAQUE_ONLY =
  /^这个文件夹不是可用的课程项目，请选择正确的项目后再试。$/;

Deno.test("empty folder open explains missing project.json and next steps", async () => {
  const projects: Record<string, ProjectData> = {};
  const picker = { next: "/tmp/empty" as string | null };
  const { bridge } = nativeBridge(projects, null, picker);
  bridge.openProject = async () => null;
  const { store, restore } = await bootStore(bridge);
  try {
    await store.openProjectFromPicker();
    const toast = String(store.ui.toast);
    // §3.4: the copy names the actual condition — there is no project.json yet —
    // and points at the import that can use this folder as material.
    assert(/还没有 project\.json/.test(toast), `toast must say why: ${toast}`);
    assert(/资料文件夹导入/.test(toast), `toast must offer the import route: ${toast}`);
    assert(
      /选择其他|新建课程|导入已有文件夹/.test(toast),
      `toast must list next steps: ${toast}`,
    );
    assert(!OPAQUE_ONLY.test(toast), "toast must not collapse to the opaque-only sentence");
    assert(!/project\.bak/.test(toast), "missing-json copy must not require project.bak");
  } finally {
    restore();
  }
});

Deno.test("invalid project JSON open explains damage instead of opaque-only copy", async () => {
  const a = projectWith("仍打开的课程");
  const projects: Record<string, ProjectData> = { "/tmp/a": a };
  const picker = { next: "/tmp/broken" as string | null };
  const { bridge } = nativeBridge(projects, "/tmp/a", picker);
  const { store, restore } = await bootStore(bridge);
  try {
    assert(store.adoptProjectSnapshot(await bridge.readProjectState()), "A opens with its fingerprint");
    store.trackProjectIdentity();
    store.markNativeLease("/tmp/a");
    bridge.openProject = async () => {
      throw new Error("项目 JSON 无效: expected value at line 1 column 1");
    };
    await store.openProject("/tmp/broken", { reopen: true });
    const toast = String(store.ui.toast);
    assert(
      /损坏|无效/.test(toast),
      `invalid JSON toast must explain damage/invalidity: ${toast}`,
    );
    assert(/project\.json|项目 JSON/.test(toast), `toast must name the broken file: ${toast}`);
    assert(!OPAQUE_ONLY.test(toast), "invalid JSON must not collapse to opaque-only copy");
    assert(store.data.project.title === "仍打开的课程", "failed open must keep the old project");
    assert(!/必须.*project\.bak|需要.*project\.bak/.test(toast), "must not require project.bak");
  } finally {
    restore();
  }
});

Deno.test("malformed project payload open explains structure, not opaque-only copy", async () => {
  const a = projectWith("保留中的课程");
  const projects: Record<string, ProjectData> = { "/tmp/a": a };
  const picker = { next: "/tmp/bad-shape" as string | null };
  const { bridge } = nativeBridge(projects, "/tmp/a", picker);
  const { store, restore } = await bootStore(bridge);
  try {
    assert(store.adoptProjectSnapshot(await bridge.readProjectState()), "A opens with its fingerprint");
    store.trackProjectIdentity();
    store.markNativeLease("/tmp/a");
    bridge.openProject = async () => ({ malformed: true });
    await store.openProject("/tmp/bad-shape", { reopen: true });
    const toast = String(store.ui.toast);
    assert(
      /不是.*Workbench 项目|不是可用|无法识别|缺少|结构/.test(toast),
      `malformed payload toast must explain the problem: ${toast}`,
    );
    assert(
      /选择其他|新建课程|导入已有文件夹/.test(toast),
      `malformed payload toast must list next steps: ${toast}`,
    );
    assert(!OPAQUE_ONLY.test(toast), "malformed payload must not collapse to opaque-only copy");
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * P0-2 autosave / 渲染不打断输入
 * ------------------------------------------------------------------ */

Deno.test("autosave refreshes the chrome without rebuilding the editor", async () => {
  const dom = await bootDom();
  try {
    const data = projectWith("不打断输入");
    const savesBefore = dom.htmlWrites.length;
    dom.renderProject(data);
    dom.store.adoptProjectSnapshot({
      project: data,
      project_id: data.project.id,
      fingerprint: {
        exists: true,
        mtime_ms: 1,
        size: JSON.stringify(data).length,
        hash: "a".repeat(64),
      },
    });
    // This test is about the chrome patch, not the storage adapter; the real
    // scheduler and Bridge contract are exercised in persistence tests.
    dom.store.saveScheduler.enqueue = () => Promise.resolve({});
    assert(dom.htmlWrites.length === savesBefore + 1, "the first render must build the shell");
    const editorHtml = dom.lastHtml();

    // The save chip is part of the chrome and is patched in place.
    const chip = dom.createNode({ chrome: "save" });
    dom.registered.set("[data-chrome-save]", chip);
    const statusbar = dom.createNode({ chrome: "statusbar" });
    dom.registered.set("[data-chrome-statusbar]", statusbar);
    const toast = dom.createNode({ chrome: "toast" });
    dom.registered.set("[data-chrome-toast]", toast);
    const writesBefore = dom.htmlWrites.length;

    dom.store.saveStatus = "正在保存…";
    dom.store.scheduleSave();
    assert(
      dom.htmlWrites.length === writesBefore,
      "an autosave must not rebuild the editor DOM",
    );
    assert(chip.outerHTML.includes("正在保存…"), "the save chip must show the new state");
    assert(dom.lastHtml() === editorHtml, "the editor markup must be byte-identical after a save tick");

    // A toast is chrome as well: it must never cost the caret either.
    dom.store.say("已保存");
    assert(dom.htmlWrites.length === writesBefore, "a toast must not rebuild the editor DOM");
    assert(toast.innerHTML.includes("已保存"), "the toast slot must receive the message");
    assert(dom.lastHtml() === editorHtml, "the editor markup must survive a toast");
  } finally {
    dom.restore();
  }
});

Deno.test("an in-flight IME composition is never rebuilt underneath", async () => {
  const dom = await bootDom();
  try {
    const data = projectWith("输入法");
    dom.renderProject(data);
    // Let startup-only provider/session notifications settle before observing
    // editor renders; those chrome updates are independent of composition.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const blockId = data.blocks[0]!.id;
    const field = dom.createNode({ blockId, editProperty: "text" }, { value: "中文" });
    dom.registered.set(`textarea[data-block-id="${blockId}"], input[data-block-id="${blockId}"]`, field);
    dom.document.activeElement = field;
    const block = dom.store.data.blocks.find((candidate: { id: string }) => candidate.id === blockId)!;
    const originalContent = block.content;
    const historyBefore = dom.store.history.length;

    dom.fireDocument("compositionstart", { target: field });
    const writesBefore = dom.htmlWrites.length;
    dom.store.notify();
    assert(
      dom.htmlWrites.length === writesBefore,
      "a render during composition must be deferred, not applied",
    );

    // The committed text arrives, then the composition ends. The queued render
    // waits until the target's compositionend listener can serialize the final
    // DOM and close the one undo transaction.
    field.dataset.editBaseline = originalContent;
    field.value = "中文已完成";
    block.content = field.value;
    field.selectionStart = 5;
    field.selectionEnd = 5;
    dom.fireDocument("compositionend", { target: field });
    await Promise.resolve();
    assert(
      dom.htmlWrites.length === writesBefore + 1,
      "ending the composition must replay the deferred render exactly once",
    );
    assert(field.focused >= 1, "the field must get its focus back after the render");
    assert(field.value === "中文已完成", "the committed text must survive the render");
    assert(
      field.selectionStart === 5,
      "the caret must be restored to where the user left it",
    );
    assert(block.content === "中文已完成", "the complete IME text must reach canonical content before rendering");
    assert(dom.store.history.length === historyBefore + 1, "the composition must create one undo entry");
    dom.store.undo();
    const restored = dom.store.data.blocks.find((candidate: { id: string }) => candidate.id === blockId)!;
    assert(restored.id === blockId, "undo must preserve the stable block ID");
    assert(restored.content === originalContent, "undo must restore the content from before composition");
  } finally {
    dom.restore();
  }
});

Deno.test("a render keeps the scroll position of the editor panes", async () => {
  const dom = await bootDom();
  try {
    const data = projectWith("滚动位置");
    const center = dom.createNode();
    dom.scrollNodes.set(".center", [center]);
    dom.renderProject(data);
    center.scrollTop = 420;
    center.scrollLeft = 0;
    // An unrelated store change forces a real re-render.
    dom.store.ui.rightPanel = "properties";
    dom.store.notify();
    assert(
      center.scrollTop === 420,
      "a re-render must put the reading position back instead of jumping to the top",
    );
  } finally {
    dom.restore();
  }
});

/* ------------------------------------------------------------------ *
 * P0-3 弹窗生命周期：内容点击不关闭弹窗
 * ------------------------------------------------------------------ */

Deno.test("a click inside a dialog does not close it, a click on the backdrop does", async () => {
  const dom = await bootDom();
  try {
    const data = projectWith("弹窗");
    const overlay = dom.createNode({ action: "close-overlay" });
    const dialog = dom.createNode({ stopClick: "true" }, { parent: overlay });
    const cancel = dom.createNode({ action: "close-overlay" }, { parent: dialog });
    const summary = dom.createNode({ node: "summary" }, { parent: dialog });
    const field = dom.createNode({}, { parent: dialog, value: "正在输入" });
    dom.actionNodes.push(overlay, cancel);
    dom.renderProject(data);

    // 1. the backdrop itself closes the dialog
    dom.store.ui.preflight = true;
    overlay.fire("click", { target: overlay });
    assert(dom.store.ui.preflight === false, "a backdrop click must still close the dialog");

    // 2. a click on the dialog body must not bubble into a close
    dom.store.ui.preflight = true;
    overlay.fire("click", { target: field });
    assert(
      dom.store.ui.preflight === true,
      "clicking inside the dialog must never close it",
    );

    // 3. "显示技术信息" is a <summary> inside the dialog: the toggle must reach
    //    the element instead of the overlay, and the dialog must stay open.
    dom.store.ui.preflight = true;
    overlay.fire("click", { target: summary });
    assert(dom.store.ui.preflight === true, "展开技术信息 must not close the export dialog");

    // 4. a real action inside the dialog still works
    dom.store.ui.preflight = true;
    cancel.fire("click", { target: cancel });
    assert(dom.store.ui.preflight === false, "a dialog button must still run its action");

    // 5. the same guard applies to a nested dialog element without an action
    dom.store.ui.preflight = true;
    overlay.fire("click", { target: dialog });
    assert(dom.store.ui.preflight === true, "the dialog body must never behave like its backdrop");
  } finally {
    dom.restore();
  }
});

/* ------------------------------------------------------------------ *
 * P1-6 新建 Block 的提示文字必须是真 Placeholder
 * ------------------------------------------------------------------ */

Deno.test("hint text never reaches canonical content", async () => {
  const data = projectWith("占位提示");
  const { bridge } = nativeBridge({ "/tmp/a": data }, "/tmp/a", { next: null });
  const { store, restore } = await bootStore(bridge);
  try {
    store.data = data;
    store.ui.screen = "project";
    store.ui.activeId = data.content_items[0]!.id;
    const item = store.currentItem();
    const seeded = new Set(store.data.blocks.map((block: { id: string }) => block.id));
    for (const type of ["paragraph", "heading", "quote", "callout", "code"]) {
      store.addBlock(type);
    }
    const created = store.data.blocks.filter((
      block: { id: string; document_id: string; type: string; content: string },
    ) => block.document_id === item!.document_id && !seeded.has(block.id));
    for (const block of created) {
      assert(
        block.content === "",
        `a new ${block.type} block must start empty, got ${JSON.stringify(block.content)}`,
      );
    }
    const canonical = JSON.stringify(store.data);
    for (const hint of ["开始写点什么", "新的小节", "引用内容", "提示内容", "// 代码"]) {
      assert(!canonical.includes(hint), `the hint ${hint} must never be persisted`);
    }
    // The rich editor renders an accessible CSS placeholder, never editable text.
    const source = await Deno.readTextFile(new URL("../app/views.js", import.meta.url));
    assert(
      source.includes('data-placeholder="${esc(placeholder)}"') && source.includes('aria-placeholder="${esc(placeholder)}"'),
      "the paragraph editor must expose its own accessible placeholder",
    );
    const styles = await Deno.readTextFile(new URL("../app/styles.css", import.meta.url));
    assert(styles.includes('.markdown-rich-editor[data-empty="true"]::before'), "the hint must be a non-editable empty-state decoration");
  } finally {
    restore();
  }
});

Deno.test("a new block is selected and the properties panel opens without stealing focus", async () => {
  const data = projectWith("新建区块");
  const { bridge } = nativeBridge({ "/tmp/a": data }, "/tmp/a", { next: null });
  const { store, restore } = await bootStore(bridge);
  try {
    store.data = data;
    store.ui.screen = "project";
    store.ui.activeId = data.content_items[0]!.id;
    store.ui.rightPanel = "media";
    store.addBlock("paragraph");
    const created = store.data.blocks.at(-1)!;
    assert(store.ui.selectedBlockId === created.id, "the new block must be selected");
    assert(store.ui.rightPanel === "properties", "属性 must open for the new block");
    assert(store.ui.focusField === "", "creating a block must not request focus anywhere");
  } finally {
    restore();
  }
});

Deno.test("the render that creates a block already shows 属性", async () => {
  // The panel used to be assigned after `commit`, whose render had already
  // run: the store was right, the screen still showed the old panel.
  const dom = await bootDom();
  try {
    const data = projectWith("属性面板");
    dom.renderProject(data);
    const writesBefore = dom.htmlWrites.length;
    dom.store.addBlock("paragraph");
    assert(
      dom.htmlWrites.length > writesBefore,
      "creating a block must render exactly through its commit",
    );
    const html = dom.lastHtml();
    assert(
      html.includes(
        'class="right-tab active" data-action="right-panel" data-panel="properties"',
      ),
      "the render that adds the block must already show 属性 as the open panel",
    );
    assert(
      dom.store.ui.selectedBlockId === data.blocks.at(-1)!.id,
      "the new block must be selected in the same render",
    );
  } finally {
    dom.restore();
  }
});

Deno.test("every overlay hands the caret to its field when it opens", async () => {
  // A dialog whose input never takes focus swallows the first thing the user
  // types; the desktop walkthrough hit exactly that in 快速收集.  `focusField`
  // is consumed by the render it triggers, so the proof is the caret itself.
  const dom = await bootDom();
  try {
    const data = projectWith("弹窗聚焦");
    const capture = dom.createNode({ action: "capture" });
    const palette = dom.createNode({ action: "palette" });
    const saveVersion = dom.createNode({ action: "save-version" });
    dom.actionNodes.push(capture, palette, saveVersion);
    dom.renderProject(data);
    const cases: Array<[string, FakeNode, string, () => void]> = [
      ["capture", capture, "capture", () => {}],
      ["palette", palette, "palette", () => {}],
      ["save-version", saveVersion, "snapshot-name", () => {}],
      [
        "seed",
        null as unknown as FakeNode,
        "seed-text",
        () => {
          // The card lives on the map and only shows while the course is
          // still empty, which is exactly when a seed is useful.
          dom.store.data = createEmptyProjectData("还没有内容");
          dom.store.ui.screen = "project";
          dom.store.ui.route = "map";
          dom.store.pickSeed("outline");
        },
      ],
    ];
    for (const [name, node, key, open] of cases) {
      dom.store.ui.capture = dom.store.ui.palette = dom.store.ui.snapshot = false;
      dom.store.ui.seedType = null;
      dom.store.ui.route = "editor";
      if (node) node.fire("click", { target: node });
      else open();
      assert(
        dom.lastHtml().includes(`data-focus-key="${key}"`),
        `opening ${name} must render the ${key} field`,
      );
      const field = dom.createNode({ focusKey: key });
      dom.registered.set(`[data-focus-key="${key}"]`, field);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert(field.focused > 0, `opening ${name} must put the caret in the ${key} field`);
    }
  } finally {
    dom.restore();
  }
});

Deno.test("blur into an action keeps the editor and action alive until click dispatch", async () => {
  const dom = await bootDom();
  try {
    const data = projectWith("保存版本 blur 时序");
    const block = data.blocks[0];
    assert(block, "the project fixture must have an editable block");
    const editor = dom.createNode({ blockId: block.id }, { value: String(block.content ?? "") });
    const saveVersion = dom.createNode({ action: "save-version" });
    (editor as any).tagName = "TEXTAREA";
    dom.textEditors.push(editor);
    dom.actionNodes.push(saveVersion);
    dom.renderProject(data);

    editor.fire("focus");
    editor.value = `${String(block.content ?? "")} 新输入`;
    editor.fire("input");
    dom.document.activeElement = editor;
    // A real click moves focus before dispatching click. The blur commit calls
    // notify(), whose innerHTML replacement detaches the button under the
    // pointer; browsers then never dispatch click to that old node.
    dom.detachOnNextRender(saveVersion);
    editor.fire("blur", { relatedTarget: saveVersion });
    assert(
      saveVersion.inRoot,
      "blur toward an action must not replace that action before click dispatch",
    );
    saveVersion.fire("click", { target: saveVersion });
    assert(dom.store.ui.snapshot, "the original save-version action must open its dialog");
    assert(
      dom.lastHtml().includes('data-focus-key="snapshot-name"'),
      "the snapshot dialog must render after the pending edit is flushed",
    );
    assert(
      dom.store.history.some((entry: any) => entry.label === "编辑正文"),
      "the pending text edit must still be recorded before the action completes",
    );
  } finally {
    dom.restore();
  }
});

Deno.test("pointerdown preserves an action through native blur without relatedTarget", async () => {
  const dom = await bootDom();
  try {
    const data = projectWith("原生 blur 无 relatedTarget");
    const block = data.blocks[0];
    assert(block, "the project fixture must have an editable block");
    const editor = dom.createNode({ blockId: block.id }, { value: String(block.content ?? "") });
    const saveVersion = dom.createNode({ action: "save-version" });
    const expectedText = `${String(block.content ?? "")} Final7 FirstClick marker 2026-10-06`;
    (editor as any).tagName = "TEXTAREA";
    dom.textEditors.push(editor);
    dom.actionNodes.push(saveVersion);
    dom.renderProject(data);

    editor.fire("focus");
    editor.value = expectedText;
    editor.fire("input");
    dom.document.activeElement = editor;
    dom.detachOnNextRender(saveVersion);

    // WKWebView may report a null relatedTarget on pointer-driven blur. The
    // document capture witness records intent only; the action still runs on
    // the subsequent click event.
    dom.fireDocument("pointerdown", { target: saveVersion, button: 0, pointerId: 7 });
    editor.fire("blur", { relatedTarget: null });
    assert(
      saveVersion.inRoot,
      "null-relatedTarget blur must keep the clicked action mounted until click dispatch",
    );
    dom.fireDocument("pointerup", { target: saveVersion, button: 0, pointerId: 7 });
    dom.fireDocument("click", { target: saveVersion });
    saveVersion.fire("click", { target: saveVersion });
    assert(dom.store.ui.snapshot, "the original save-version action must open its dialog");
    assert(
      dom.lastHtml().includes('data-focus-key="snapshot-name"'),
      "the snapshot dialog must render after the pending edit is flushed",
    );
    assert(
      dom.store.history.some((entry: any) => entry.label === "编辑正文"),
      "the pending text edit must be recorded before the action completes",
    );
    assert(
      dom.store.data.blocks.find((candidate: any) => candidate.id === block.id)?.content === expectedText,
      "the full edit, including its final characters, must be committed before the snapshot action",
    );
  } finally {
    dom.restore();
  }
});

Deno.test("pointer cancellation releases a deferred editor blur without running the action", async () => {
  const dom = await bootDom();
  try {
    const data = projectWith("取消指针操作后普通 blur");
    const block = data.blocks[0];
    assert(block, "the project fixture must have an editable block");
    const editor = dom.createNode({ blockId: block.id }, { value: String(block.content ?? "") });
    const saveVersion = dom.createNode({ action: "save-version" });
    (editor as any).tagName = "TEXTAREA";
    dom.textEditors.push(editor);
    dom.actionNodes.push(saveVersion);
    dom.renderProject(data);

    editor.fire("focus");
    editor.value = `${String(block.content ?? "")} cancelled edit`;
    editor.fire("input");
    dom.document.activeElement = editor;
    dom.detachOnNextRender(saveVersion);
    dom.fireDocument("pointerdown", { target: saveVersion, button: 0, pointerId: 9 });
    editor.fire("blur", { relatedTarget: null });
    assert(saveVersion.inRoot, "the initial pointer blur should be held for click dispatch");
    dom.fireDocument("pointercancel", { target: saveVersion, pointerId: 9 });
    assert(!saveVersion.inRoot, "pointer cancellation should release the deferred render");
    assert(
      dom.store.history.some((entry: any) => entry.label === "编辑正文"),
      "cancellation must commit the edit without dispatching the action",
    );
    assert(!dom.store.ui.snapshot, "a canceled pointer must not open the snapshot dialog");

    editor.fire("focus");
    const afterKeyboard = `${String(block.content ?? "")} keyboard takeover`;
    editor.value = afterKeyboard;
    editor.fire("input");
    dom.document.activeElement = editor;
    dom.fireDocument("pointerdown", { target: saveVersion, button: 0, pointerId: 10 });
    dom.fireDocument("keydown", { target: editor, key: "ArrowLeft", code: "ArrowLeft" });
    dom.detachOnNextRender(editor);
    editor.fire("blur", { relatedTarget: null });
    assert(!editor.inRoot, "a keyboard event must clear an unconsumed pointer witness");
    assert(
      dom.store.data.blocks.find((candidate: any) => candidate.id === block.id)?.content === afterKeyboard,
      "keyboard takeover must fall back to an ordinary complete blur commit",
    );

    editor.fire("focus");
    const afterPointer = `${String(block.content ?? "")} non-action pointer`;
    editor.value = afterPointer;
    editor.fire("input");
    dom.document.activeElement = editor;
    dom.fireDocument("pointerdown", { target: saveVersion, button: 0, pointerId: 11 });
    dom.fireDocument("pointerdown", {
      target: dom.createNode({ focusKey: "outside-editor" }),
      button: 0,
      pointerId: 12,
    });
    dom.detachOnNextRender(editor);
    editor.fire("blur", { relatedTarget: null });
    assert(!editor.inRoot, "a later non-action pointer must clear the prior action witness");
    assert(
      dom.store.data.blocks.find((candidate: any) => candidate.id === block.id)?.content === afterPointer,
      "non-action pointer blur must commit all pending text immediately",
    );
  } finally {
    dom.restore();
  }
});

Deno.test("blur away from an action still commits the pending editor change", async () => {
  const dom = await bootDom();
  try {
    const data = projectWith("独立 blur 保存");
    const block = data.blocks[0];
    assert(block, "the project fixture must have an editable block");
    const editor = dom.createNode({ blockId: block.id }, { value: String(block.content ?? "") });
    (editor as any).tagName = "TEXTAREA";
    dom.textEditors.push(editor);
    dom.renderProject(data);

    editor.fire("focus");
    editor.value = `${String(block.content ?? "")} 离开编辑器`;
    editor.fire("input");
    const historyBefore = dom.store.history.length;
    dom.document.activeElement = editor;
    dom.detachOnNextRender(editor);
    editor.fire("blur", { relatedTarget: dom.createNode({ focusKey: "outside-editor" }) });

    assert(!editor.inRoot, "an ordinary blur may render and replace the editor immediately");
    assert(dom.store.history.length > historyBefore, "ordinary blur must record the edit");
    assert(
      dom.store.data.blocks.find((candidate: any) => candidate.id === block.id)?.content === editor.value,
      "ordinary blur must retain the text already entered into Canonical",
    );
  } finally {
    dom.restore();
  }
});

/* ------------------------------------------------------------------ *
 * P1-4 课程标题 inline edit
 * ------------------------------------------------------------------ */

Deno.test("the course title edits inline and survives a reload", async () => {
  const data = projectWith("原标题");
  const projects: Record<string, ProjectData> = { "/tmp/a": data };
  const { bridge } = nativeBridge(projects, "/tmp/a", { next: null });
  const { store, restore } = await bootStore(bridge);
  try {
    assert(store.adoptProjectSnapshot(await bridge.readProjectState()), "the opened course has its baseline");
    store.ui.screen = "project";
    store.editProjectTitle();
    assert(store.ui.editingProjectTitle === true, "clicking the title must open the editor");
    assert(store.ui.focusField === "project-title", "the editor must take the caret");

    store.commitProjectTitle("  改好的课程名  ");
    assert(store.ui.editingProjectTitle === false, "committing must close the editor");
    assert(store.data.project.title === "改好的课程名", "the title must reach canonical data");
    await store.flush();
    assert(
      projects["/tmp/a"]!.project.title === "改好的课程名",
      "the new title must be written to the project file",
    );

    // Esc keeps the old title; an empty commit keeps it too.
    store.editProjectTitle();
    store.cancelProjectTitle();
    assert(store.data.project.title === "改好的课程名", "cancelling must not change the title");
    store.editProjectTitle();
    store.commitProjectTitle("   ");
    assert(store.data.project.title === "改好的课程名", "an empty title must be refused");
    assert(validateProjectData(store.data).length === 0, "the project must stay canonical");
  } finally {
    restore();
  }
});

Deno.test("a real click on the course title opens the inline editor and it stays open", async () => {
  // The store method was already covered; this drives the click the topbar
  // really binds, because the desktop showed the title doing nothing.
  const dom = await bootDom();
  try {
    const data = projectWith("在线改名");
    const title = dom.createNode({ action: "edit-project-title" });
    dom.actionNodes.push(title);
    dom.renderProject(data);
    assert(dom.store.ui.editingProjectTitle === false, "the title starts as text");

    title.fire("click", { target: title });
    assert(dom.store.ui.editingProjectTitle === true, "the click must open the editor");
    assert(
      dom.lastHtml().includes("data-project-title") &&
        dom.lastHtml().includes('data-focus-key="project-title"'),
      "the render after the click must draw the input and hand it the caret",
    );

    // A focusout that the render itself caused must not silently commit and
    // close the editor the user just opened.
    const input = dom.createNode({ projectTitle: "true" }, { value: "在线改名" });
    dom.registered.set("[data-project-title]", input);
    input.focus();
    input.fire("focusout", { target: input });
    dom.store.notify();
    assert(
      dom.store.ui.editingProjectTitle === true,
      "an incidental focusout must not close the title editor",
    );
  } finally {
    dom.restore();
  }
});

/* ------------------------------------------------------------------ *
 * P1-5 Requirement 类型
 * ------------------------------------------------------------------ */

Deno.test("changing the requirement type in 属性 keeps every projection in agreement", async () => {
  const data = projectWith("待补类型");
  const { bridge } = nativeBridge({ "/tmp/a": data }, "/tmp/a", { next: null });
  const { store, restore } = await bootStore(bridge);
  try {
    store.data = data;
    store.ui.screen = "project";
    store.ui.activeId = data.content_items[0]!.id;
    store.addPlaceholder("text", "这里要一张流程图");
    const requirement = store.data.requirements.at(-1)!;
    assert(requirement.type === "text", "a new placeholder starts as a text requirement");

    store.updateRequirement(requirement.id, { type: "image" });
    assert(requirement.type === "image", "the type must reach canonical data");
    const anchor = store.data.blocks.find((
      block: { id: string; settings: Record<string, unknown> },
    ) => block.id === requirement.anchor_block_id)!;
    assert(
      anchor.settings.requirement_type === "image",
      "the placeholder block must mirror the new type",
    );

    // 正文, 待补总览 and 属性 all read the same canonical row.
    const view = lessonView(store.data, data.content_items[0]!.id)!;
    const block = view.blocks.find((candidate) => candidate.requirement_id === requirement.id)!;
    assert(block.type === "placeholder", "the anchor must still be a placeholder");
    const projected = view.requirements.find((candidate) => candidate.id === requirement.id)!;
    assert(projected.type === "image", "the lesson projection must carry the new type");
    const backlog = requirementBacklog(store.data);
    const entry = backlog.entries.find((candidate) => candidate.id === requirement.id)!;
    assert(entry.type === "image", "待补总览 must show the same type");

    // An unknown type is refused rather than written into canonical data.
    store.updateRequirement(requirement.id, { type: "not_a_type" });
    assert(requirement.type === "image", "an unknown type must never be persisted");
    assert(validateProjectData(store.data).length === 0, "the project must stay canonical");
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * P0-6 Grid Preview
 * ------------------------------------------------------------------ */

Deno.test("the preview draws the real grid geometry and lists unplaced content", async () => {
  const data = projectWith("网格预览");
  const item = data.content_items[0]!;
  appendBlock(data, item.id, "paragraph", "第二段正文");
  const { bridge } = nativeBridge({ "/tmp/a": data }, "/tmp/a", { next: null });
  const { store, restore } = await bootStore(bridge);
  try {
    store.data = data;
    store.ui.screen = "project";
    store.ui.activeId = item.id;
    store.createLayout("grid");
    store.changeGrid("column", 1); // 4 columns
    store.changeGrid("row", 1); // 4 rows
    const blocks = store.blocks(item);
    assert(blocks.length >= 2, "the lesson needs at least two blocks");
    store.placeBlock(blocks[0]!.id);
    store.placeBlock(blocks[1]!.id);
    const placements = store.data.placements;
    assert(placements.length === 2, "two blocks must be placed");
    const grid = store.data.layout_instances[0]!.grid_definition;
    const columns = grid.columns.length;
    const before = structuredClone(
      store.data.placements.find((entry: { id: string }) => entry.id === placements[1]!.id)!,
    );
    // Give the second placement a wider span and a cell of its own.
    store.resizePlacement(placements[1]!.id, 1, 1);
    const grown = store.data.placements.find((
      entry: { id: string },
    ) => entry.id === placements[1]!.id)!;
    assert(
      grown.column_end - grown.column_start === before.column_end - before.column_start + 1,
      "resizing must widen the placement by exactly one column",
    );
    assert(
      grown.row_end - grown.row_start === before.row_end - before.row_start + 1,
      "resizing must make the placement one row taller",
    );
    store.movePlacement(placements[1]!.id, 0, 1);
    const moved = store.data.placements.find((
      entry: { id: string },
    ) => entry.id === placements[1]!.id)!;
    const span = grown.column_end - grown.column_start;
    assert(
      moved.column_start === Math.min(grown.column_start + 1, columns - span),
      "moving right must shift the placement one column without leaving the canvas",
    );
    assert(
      moved.column_end === moved.column_start + span,
      "moving must preserve the placement's span",
    );
  } finally {
    restore();
  }
});

Deno.test("preview markup carries grid position, span, section and unplaced content", async () => {
  const dom = await bootDom();
  try {
    const data = projectWith("网格预览渲染");
    const item = data.content_items[0]!;
    appendBlock(data, item.id, "paragraph", "上画布的正文");
    appendBlock(data, item.id, "paragraph", "还没上画布的正文");
    // Build the layout through the store on the singleton so the canonical
    // rows are produced by the same code the app uses.
    dom.store.data = data;
    dom.store.ui.screen = "project";
    dom.store.ui.activeId = item.id;
    dom.store.createLayout("grid");
    dom.store.changeGrid("row", 1);
    const blocks = dom.store.blocks(item);
    dom.store.placeBlock(blocks[0]!.id);
    dom.store.addSection();
    const placement = dom.store.data.placements[0]!;
    dom.store.movePlacement(placement.id, 1, 1);
    dom.store.resizePlacement(placement.id, 1, 1);
    const section = dom.store.data.layout_sections.at(-1)!;
    dom.store.data.placements[0]!.section_id = section.id;
    dom.store.renameSection(section.id, "第一页");

    const html = dom.renderProject(data, { mode: "preview" });
    assert(html.includes("preview-paper-grid"), "Grid mode must use the grid paper");
    assert(html.includes("preview-grid-cell"), "each placement must render as a grid cell");
    assert(
      /grid-row:\d+\/\d+;grid-column:\d+\/\d+/.test(html),
      "the cell must carry the real row/column span",
    );
    const cell = html.slice(html.indexOf("preview-grid-cell"));
    assert(cell.includes("grid-column:2/4"), "the resized placement must show its span");
    assert(html.includes("第一页"), "the section must be named on its own canvas");
    assert(
      html.includes("还没有放进网格"),
      "content that is not on the canvas must be listed instead of drawn as flow",
    );
    assert(
      html.includes("还没上画布的正文"),
      "the unplaced block must be visible with its text",
    );
    // Flow mode still renders the plain paper.
    const flow = dom.renderProject(data, { mode: "preview", route: "editor" });
    dom.store.setLayoutMode("flow");
    const flowHtml = dom.renderProject(data, { mode: "preview" });
    assert(flow.includes("preview-paper"), "the preview must render at all");
    assert(!flowHtml.includes("preview-grid-cell"), "Flow mode must not draw grid cells");
  } finally {
    dom.restore();
  }
});

/* ------------------------------------------------------------------ *
 * P1-2 完成度展示
 * ------------------------------------------------------------------ */

/** The markup a real render would produce for the current store state. */
function shellMarkup(store: any): string {
  const views = createViews(store);
  return String(views.shellView());
}

/* ------------------------------------------------------------------ *
 * P2 — Provider discovery, Block height, Flow order, Grid interaction
 * ------------------------------------------------------------------ */

Deno.test("P2-3 Flow reordering writes the one canonical block order", async () => {
  const data = projectWith("顺序回归");
  const item = data.content_items[0]!;
  appendBlock(data, item.id, "paragraph", "第二段");
  appendBlock(data, item.id, "paragraph", "第三段");
  const { bridge } = nativeBridge({ "/tmp/p2f": data }, "/tmp/p2f", { next: null });
  const { store, restore } = await bootStore(bridge);
  try {
    store.data = data;
    store.ui.screen = "project";
    store.ui.activeId = item.id;
    const blocks = store.blocks(item);
    assert(blocks.length === 3, "the lesson needs three blocks");
    const [first, second] = blocks;
    store.moveBlock(second.id, "up");
    const after = store.blocks(item);
    assert(
      after[0]!.id === second.id && after[1]!.id === first.id,
      "上移 must swap the canonical order so every view reads the same sequence",
    );
    const orders = after.map((block: { order_index: number }) => block.order_index);
    assert(
      new Set(orders).size === orders.length,
      "reordering must leave every block with its own order_index",
    );
    // Structure and Preview read the same array, so they cannot disagree.
    const lesson = lessonView(store.data, item.id);
    assert(
      lesson !== null &&
        lesson.blocks.map((block: { id: string }) => block.id).join(",") ===
        after.map((block: { id: string }) => block.id).join(","),
      "结构视图与预览必须跟着 Flow 调整后的同一条顺序走",
    );
  } finally {
    restore();
  }
});

Deno.test("P2-4 a grid block lands on the first free cell and can be moved deliberately", async () => {
  const data = projectWith("网格交互");
  const item = data.content_items[0]!;
  appendBlock(data, item.id, "paragraph", "第二段");
  const { bridge } = nativeBridge({ "/tmp/p2g": data }, "/tmp/p2g", { next: null });
  const { store, restore } = await bootStore(bridge);
  try {
    store.data = data;
    store.ui.screen = "project";
    store.ui.activeId = item.id;
    store.createLayout("grid");
    const blocks = store.blocks(item);
    store.placeBlock(blocks[0]!.id);
    assert(store.data.placements.length === 1, "点正文必须让它上画布");
    const grid = store.data.layout_instances[0]!.grid_definition;
    const placement = store.data.placements[0]!;
    assert(
      placement.row_start === 0 && placement.column_start === 0,
      "the first drop must be the first predictable free cell",
    );
    const allowed = freeCellsFor(grid, store.data.placements, {
      rowSpan: placement.row_end - placement.row_start,
      columnSpan: placement.column_end - placement.column_start,
      exceptId: placement.id,
    });
    const target = allowed.find((cell) =>
      cell.row !== placement.row_start || cell.column !== placement.column_start
    );
    assert(target !== undefined, "a fresh 1x1 placement must have somewhere to go");
    store.startMovePlacement(placement.id);
    assert(
      store.ui.movingPlacementId === placement.id,
      "clicking a grid block enters move state",
    );
    store.movePlacementTo(placement.id, target!.row, target!.column);
    const moved = store.data.placements.find((entry: { id: string }) =>
      entry.id === placement.id
    )!;
    assert(
      moved.row_start === target!.row && moved.column_start === target!.column,
      "clicking a highlighted cell must write exactly that cell",
    );
    assert(store.ui.movingPlacementId === null, "a successful move leaves move state");
    store.placeBlock(blocks[1]!.id);
    const second = store.data.placements.find((entry: { id: string }) =>
      entry.id !== placement.id
    )!;
    const occupied = occupiedCells(store.data.placements, second.id);
    assert(
      occupied.has(`${moved.row_start}:${moved.column_start}`),
      "the taken cell must be reported as occupied",
    );
    const refused = store.movePlacementTo(second.id, moved.row_start, moved.column_start);
    assert(refused === false, "the store must refuse a cell the UI never offers");
    const stillThere = store.data.placements.find((entry: { id: string }) =>
      entry.id === second.id
    )!;
    assert(
      stillThere.row_start === second.row_start &&
        stillThere.column_start === second.column_start,
      "a refused move must not disturb either placement",
    );
    const blockCount = store.data.blocks.length;
    store.unplaceBlock(second.block_id);
    assert(
      store.data.placements.length === 1 && store.data.blocks.length === blockCount,
      "移出网格 must only drop the placement, never the content",
    );
    store.cancelMovePlacement();
    assert(store.ui.movingPlacementId === null, "cancelling clears the move state");
    // The grid the user arranged is what gets saved.
    const saved = JSON.parse(JSON.stringify(store.data.placements));
    assert(
      saved.length === 1 && saved[0].row_start === moved.row_start,
      "the arrangement must live in canonical data so it survives a save",
    );
  } finally {
    restore();
  }
});

Deno.test("P2-2 and P2-4 markup matches the interaction model it promises", async () => {
  const data = projectWith("交互外观");
  const item = data.content_items[0]!;
  appendBlock(data, item.id, "paragraph", "留在下面的第二段");
  const { bridge } = nativeBridge({ "/tmp/p2m": data }, "/tmp/p2m", { next: null });
  const { store, restore } = await bootStore(bridge);
  try {
    store.data = data;
    store.ui.screen = "project";
    store.ui.activeId = item.id;
    store.createLayout("grid");
    store.ui.mode = "writing";
    store.ui.route = "free-layout";
    const blocks = store.blocks(item);
    store.placeBlock(blocks[0]!.id);
    const placement = store.data.placements[0]!;
    store.startMovePlacement(placement.id);
    const movingHtml = shellMarkup(store);
    assert(
      String(movingHtml).includes("grid-moving-banner"),
      "the move state must say which block is moving",
    );
    assert(
      String(movingHtml).includes("grid-cell-target"),
      "the move state must show where the block can go",
    );
    store.cancelMovePlacement();
    const html = shellMarkup(store);
    assert(
      !html.includes("grid-cell-target"),
      "cell targets must disappear once the move is cancelled",
    );
    assert(
      html.includes("data-action=\"place-block\"") && html.includes("data-placement="),
      "the strip and the canvas must both be present",
    );
  } finally {
    restore();
  }
});

Deno.test("modal keyboard trap wraps Tab, skips hidden controls and Escape restores its trigger", async () => {
  const { store, document, registered, fireRoot, fireDocument, setActiveDialog, createNode, lastHtml, restore } = await bootDom();
  try {
    const makeControl = (focusKey: string, options: { disabled?: boolean; hidden?: boolean; ariaHidden?: string } = {}) => {
      const node: any = createNode({ focusKey });
      node.tagName = "BUTTON";
      node.disabled = options.disabled === true;
      node.hidden = options.hidden === true;
      node.getAttribute = (name: string) => name === "aria-hidden" ? options.ariaHidden ?? null : null;
      return node;
    };
    const disabled = makeControl("disabled", { disabled: true });
    const hidden = makeControl("hidden", { hidden: true });
    const ariaHidden = makeControl("aria-hidden", { ariaHidden: "true" });
    const first = makeControl("first");
    const last = makeControl("last");
    const controls = [disabled, hidden, ariaHidden, first, last];
    const dialog = {
      contains: (node: unknown) => controls.includes(node as any),
      querySelectorAll: (selector: string) => {
        assert(selector.includes(":not([disabled])"), "disabled controls must be excluded by the focusable selector");
        return controls.filter((control) => !control.disabled);
      },
      querySelector: (_selector: string) => first,
      focus: () => {},
    };
    setActiveDialog(dialog);
    const trigger: any = createNode({ action: "open-palette" });
    registered.set('[data-action="open-palette"]', trigger);
    trigger.focus();
    store.ui.palette = true;
    store.notify();
    assert(
      lastHtml().includes('class="palette modal" role="dialog" aria-modal="true"'),
      "the command palette must expose its modal semantics in the live view",
    );
    assert(document.activeElement === first, "opening the dialog must move focus inside it");

    const press = (shiftKey: boolean) => {
      let prevented = false;
      assert(fireRoot("keydown", {
        key: "Tab",
        shiftKey,
        preventDefault: () => { prevented = true; },
      }) > 0, "the app root must own a live dialog focus trap");
      assert(prevented, "Tab at the dialog edge must be intercepted");
    };
    press(true);
    assert(document.activeElement === last, "Shift+Tab at the first control must wrap to the last");
    press(false);
    assert(document.activeElement === first, "Tab at the last control must wrap to the first");
    assert(
      ![disabled, hidden, ariaHidden].includes(document.activeElement),
      "disabled and hidden controls must never receive wrapped focus",
    );

    fireDocument("keydown", { key: "Escape" });
    assert(!store.ui.palette, "Escape must close a dismissible dialog");
    assert(document.activeElement === trigger, "closing the dialog must restore focus to its opener");
  } finally {
    restore();
  }
});

Deno.test("mapping confirmation restores focus after its async document scan is escaped", async () => {
  const { store, document, registered, actionNodes, fireDocument, setActiveDialog, createNode, restore } = await bootDom();
  try {
    const project = projectWith("Mapping 焦点");
    store.data = project;
    store.ui.screen = "project";
    store.ui.route = "mapping";
    store.ui.activeId = project.content_items[0]?.id ?? null;
    store.ui.importFolderRoot = "/tmp/mapping-focus";
    store.ui.importMappingPlan = {
      root: "/tmp/mapping-focus",
      confirmed: false,
      confirmed_at: null,
      items: [{
        relative_path: "01 Stage",
        kind: "directory",
        selected: true,
        mapping: "stage",
        error: null,
      }],
    };

    let finishScan!: (value: unknown) => void;
    store.bridge.command = (name: string) => {
      assert(name === "folder.scan_documents", "opening the body chooser must scan selected directories");
      return new Promise((resolve) => { finishScan = resolve; });
    };

    const opener = createNode({ action: "confirm-import-mapping" });
    const unrelatedFocus = createNode({});
    const firstControl = createNode({ focusKey: "document-import-first" });
    registered.set('[data-action="confirm-import-mapping"]', opener);
    actionNodes.push(opener);
    document.activeElement = unrelatedFocus;
    const dialog = {
      contains: (node: unknown) => node === firstControl,
      querySelectorAll: () => [firstControl],
      querySelector: () => firstControl,
      focus: () => {},
    };
    setActiveDialog(dialog);
    store.notify();

    opener.fire("click");
    assert(store.ui.documentImportDialog?.loading, "the document chooser should open while its scan is pending");
    assert(document.activeElement === firstControl, "opening the chooser should focus its first control");
    finishScan({
      groups: [{
        directory: "01 Stage",
        mapping: "stage",
        items: [{ relative_path: "01 Stage/lesson.md", kind: "file", selected: true }],
      }],
      errors: [],
      warnings: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(!store.ui.documentImportDialog?.loading, "the chooser should finish after the async scan");

    fireDocument("keydown", { key: "Escape", preventDefault() {} });
    assert(!store.ui.documentImportDialog, "Escape should cancel the document chooser");
    assert(document.activeElement === opener, "Escape should return focus to the mapping confirmation button");
  } finally {
    restore();
  }
});

Deno.test("Escape safely dismisses rename, locked-project and duplicate-project dialogs", async () => {
  const { store, document, registered, fireDocument, setActiveDialog, createNode, restore } = await bootDom();
  try {
    const data = projectWith("Escape 取消");
    const assetId = "escape-rename-asset";
    data.assets.push({
      id: assetId,
      project_id: data.project.id,
      filename: "photo.png",
      title: "Photo",
      type: "image",
      mime_type: "image/png",
      storage_path: "assets/photo.png",
      file_size: 8,
      checksum: "0".repeat(64),
      archived: false,
      created_at: now(),
      updated_at: now(),
    } as any);
    const opener: any = createNode({ focusKey: "asset-menu-summary" });
    const renameInput: any = createNode({ focusKey: "asset-title" });
    registered.set('[data-focus-key="asset-menu-summary"]', opener);
    setActiveDialog({
      contains: (node: unknown) => node === renameInput,
      querySelector: () => renameInput,
      querySelectorAll: () => [renameInput],
      focus: () => {},
    });

    store.data = data;
    store.ui.screen = "project";
    store.ui.route = "media";
    opener.focus();
    store.ui.editingAssetId = assetId;
    store.ui.assetRenameValue = "photo.png";
    store.notify();
    assert(document.activeElement === renameInput, "the rename modal must receive focus");
    let prevented = false;
    fireDocument("keydown", { key: "Escape", preventDefault: () => { prevented = true; } });
    assert(prevented, "Escape must consume the modal key");
    assert(store.ui.editingAssetId === null, "Escape must cancel the rename without writing");
    assert(document.activeElement === opener, "Escape must return focus to the rename opener");
    assert(store.data.assets.find((asset: any) => asset.id === assetId)?.filename === "photo.png", "cancelling must preserve the asset filename");

    store.ui.projectProblem = {
      status: "locked",
      dir: "/tmp/locked-project",
      problem: { code: "project_locked", message: "另一个窗口正在使用。" },
    };
    store.notify();
    fireDocument("keydown", { key: "Escape", preventDefault: () => {} });
    assert(store.ui.projectProblem === null, "Escape must use the safe return path for a locked-project dialog");

    store.ui.registryCopy = {
      project_id: data.project.id,
      project_title: data.project.title,
      existing_path: "/tmp/registered-project",
      opened_path: "/tmp/opened-copy",
    };
    store.notify();
    fireDocument("keydown", { key: "Escape", preventDefault: () => {} });
    assert(store.ui.registryCopy === null, "Escape must choose the non-mutating duplicate-project dismissal");

    store.externalConflict = { external_diff: { entries: [] }, local_diff: { entries: [] }, merge: { conflicts: [] } };
    store.ui.editingAssetId = assetId;
    store.notify();
    fireDocument("keydown", { key: "Escape", preventDefault: () => {} });
    assert(store.externalConflict, "Escape must not make a conflict decision");
    assert(store.ui.editingAssetId === assetId, "Escape must not cancel a dialog hidden behind the conflict decision");
  } finally {
    restore();
  }
});

Deno.test("a single lesson reports gaps instead of a made-up percentage", async () => {
  const data = projectWith("完成度");
  const { bridge } = nativeBridge({ "/tmp/a": data }, "/tmp/a", { next: null });
  const { store, restore } = await bootStore(bridge);
  try {
    store.data = data;
    store.ui.screen = "project";
    const view = lessonView(store.data, data.content_items[0]!.id)!;
    assert(
      typeof view.progress.percentage === "number",
      "the underlying six-dimension state must stay intact",
    );
    const source = await Deno.readTextFile(new URL("../app/views.js", import.meta.url));
    const strip = source.slice(
      source.indexOf("function lessonStrip("),
      source.indexOf("function writingView("),
    );
    assert(
      !strip.includes("progress.percentage") && !strip.includes("progress-track"),
      "单课 must not show a percentage or a progress bar",
    );
    assert(strip.includes("待补"), "单课 must show its real gap counts");
    const mapItem = source.slice(
      source.indexOf("function mapItem("),
      source.indexOf("function editorView("),
    );
    assert(
      !mapItem.includes("progress.percentage"),
      "课程地图 的每一课 must not show a percentage either",
    );
  } finally {
    restore();
  }
});
