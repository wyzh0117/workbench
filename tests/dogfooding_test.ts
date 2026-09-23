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
  const registered = new Map<string, FakeNode>();
  const scrollNodes = new Map<string, FakeNode[]>();
  const actionNodes: FakeNode[] = [];
  let currentHtml = "";

  const root: any = {
    get innerHTML() {
      return currentHtml;
    },
    set innerHTML(value: string) {
      currentHtml = value;
      htmlWrites.push(value);
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
    addEventListener: () => {},
    contains: (node: FakeNode | null) => Boolean(node && node.inRoot),
    querySelector: (selector: string) => registered.get(selector) ?? null,
    querySelectorAll: (selector: string) =>
      selector === "[data-action]" ? actionNodes : (scrollNodes.get(selector) ?? []),
  };

  const document: any = {
    activeElement: null,
    querySelector: () => root,
    querySelectorAll: () => [],
    addEventListener: (type: string, handler: Listener, capture?: boolean) => {
      if (!capture) return;
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
    for (const handler of documentListeners.get(type) ?? []) handler(event);
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
    createNode,
    renderProject,
    fireDocument,
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
  const calls: string[] = [];
  const bridge: any = {
    projectDir: currentDir,
    projectDirFromUrl: false,
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
      return structuredClone(project);
    },
    readProject: async () =>
      currentDir && projects[currentDir] ? structuredClone(projects[currentDir]) : null,
    readRecoveryJournal: async () => null,
    listenNativeDrops: async () => () => {},
    writeRecoveryJournal: async () => {},
    writeProject: async (project: ProjectData) => {
      if (currentDir) projects[currentDir] = structuredClone(project);
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
    const blockId = data.blocks[0]!.id;
    const field = dom.createNode({ blockId, editProperty: "text" }, { value: "中文" });
    dom.registered.set(`textarea[data-block-id="${blockId}"], input[data-block-id="${blockId}"]`, field);
    dom.document.activeElement = field;

    dom.fireDocument("compositionstart", { target: field });
    const writesBefore = dom.htmlWrites.length;
    dom.store.notify();
    assert(
      dom.htmlWrites.length === writesBefore,
      "a render during composition must be deferred, not applied",
    );

    // The committed text arrives, then the composition ends: the queued render
    // runs and the caret comes back to the same field.
    field.value = "中文已完成";
    field.selectionStart = 5;
    field.selectionEnd = 5;
    dom.fireDocument("compositionend", { target: field });
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
    // The editor still shows a hint: it is the control's placeholder attribute.
    const source = await Deno.readTextFile(new URL("../app/views.js", import.meta.url));
    assert(
      source.includes('placeholder="开始写点什么…"'),
      "the paragraph control must carry the hint as its own placeholder",
    );
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

/* ------------------------------------------------------------------ *
 * P1-4 课程标题 inline edit
 * ------------------------------------------------------------------ */

Deno.test("the course title edits inline and survives a reload", async () => {
  const data = projectWith("原标题");
  const projects: Record<string, ProjectData> = { "/tmp/a": data };
  const { bridge } = nativeBridge(projects, "/tmp/a", { next: null });
  const { store, restore } = await bootStore(bridge);
  try {
    store.data = data;
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
    store.ui.mode = "layout";
    store.ui.route = "editor";
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