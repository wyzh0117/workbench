import { buildImportMappingPlan } from "../app/canvas.js";

const ROOT = "/tmp/acw-mapping-runtime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(label + " is missing");
  return value;
}

class FakeControl extends EventTarget {
  checked: boolean;
  value = "";
  disabled = false;

  constructor(checked = false) {
    super();
    this.checked = checked;
  }

  matches(selector: string): boolean {
    return selector.includes("data-mapping-select");
  }

  focus(): void {}
}

class FakeRow extends EventTarget {
  dataset: Record<string, string>;
  classList = { toggle: (_name: string, _enabled: boolean) => {} };
  checkbox: FakeControl;
  role = new FakeControl();
  destination = new FakeControl();
  duplicate = new FakeControl();

  constructor(readonly root: FakeRoot, path: string, selected: boolean) {
    super();
    this.dataset = { path, rowKey: path, selected: selected ? "true" : "false" };
    this.checkbox = new FakeControl(selected);
  }

  querySelector(selector: string): FakeControl | null {
    if (selector.includes("data-mapping-select")) return this.checkbox;
    if (selector.includes("data-mapping-role")) return this.role;
    if (selector.includes("data-mapping-destination")) return this.destination;
    if (selector.includes("data-mapping-duplicate")) return this.duplicate;
    return null;
  }

  contains(node: unknown): boolean {
    return node === this.checkbox || node === this.role || node === this.destination ||
      node === this.duplicate;
  }

  replaceWith(replacement: FakeRow): void {
    const index = this.root.rows.indexOf(this);
    if (index >= 0) this.root.rows[index] = replacement;
  }
}

class FakeRoot extends EventTarget {
  rows: FakeRow[] = [];
  renderCount = 0;
  classList = { add: (_name: string) => {}, remove: (_name: string) => {}, toggle: (_name: string, _enabled: boolean) => {} };
  dataset = {};
  private markup = "";

  set innerHTML(value: string) {
    this.markup = value;
    this.renderCount += 1;
    this.rows = this.parseRows(value);
  }

  get innerHTML(): string {
    return this.markup;
  }

  querySelectorAll(selector: string): FakeRow[] {
    return selector === "tr[data-mapping-row]" ? this.rows : [];
  }

  querySelector(_selector: string): null {
    return null;
  }

  contains(_node: unknown): boolean {
    return false;
  }

  parseRows(markup: string): FakeRow[] {
    return [...markup.matchAll(/<tr\b[^>]*data-mapping-row[^>]*>/g)].flatMap((match) => {
      const tag = match[0];
      const path = tag.match(/data-row-key="([^"]*)"/)?.[1];
      if (!path) return [];
      return [new FakeRow(this, path, tag.includes('data-selected="true"'))];
    });
  }
}

Deno.test("Mapping checkbox uses a real change event and patches only its stable row; native adapter preserves empty document choices", async () => {
  const runtime = globalThis as unknown as Record<string, any>;
  const previousDocument = runtime.document;
  const previousFetch = runtime.fetch;
  const previousTauri = runtime.__TAURI__;
  const previousWorkbench = runtime.__workbench;
  const previousReady = runtime.__workbenchReady;
  const root = new FakeRoot();
  runtime.document = {
    activeElement: null,
    querySelector: (selector: string) => selector === "#app" ? root : null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({
      row: null as FakeRow | null,
      set innerHTML(value: string) {
        this.row = root.parseRows(value)[0] || null;
      },
      querySelector(this: { row: FakeRow | null }) {
        return this.row;
      },
    }),
  };
  runtime.fetch = async () =>
    new Response(JSON.stringify({ value: null }), { headers: { "content-type": "application/json" } });

  try {
    const module = await import("../app/main.js?mapping-ui-runtime") as Record<string, any>;
    await runtime.__workbenchReady?.catch(() => undefined);
    const store = runtime.__workbench;
    const entries = [
      { relative_path: "a.md", kind: "file", mime: "text/markdown", size: 8, suggested_role: "lesson", error: null },
      { relative_path: "b.md", kind: "file", mime: "text/markdown", size: 9, suggested_role: "lesson", error: null },
    ];
    store.ui.screen = "project";
    store.ui.route = "mapping";
    store.ui.importFolderRoot = ROOT;
    store.ui.folderScan = { root: ROOT, entries };
    store.ui.mappingScanSnapshot = { id: 1, root: ROOT, entries: structuredClone(entries) };
    store.ui.importMappingPlan = buildImportMappingPlan(ROOT, entries);
    store.notify();

    assertEqual(root.rows.length, 2, "the real Mapping view renders both rows");
    const first = required(root.rows[0], "first mapping row");
    const sibling = required(root.rows[1], "sibling mapping row");
    const renderCount = root.renderCount;
    first.checkbox.checked = false;
    first.checkbox.dispatchEvent(new Event("change"));

    assert(store.ui.importMappingPlan.items[0].selected === false, "the genuine change event updates store selection");
    assert(root.rows[0] !== first, "the changed row is replaced from the current plan");
    assert(root.rows[1] === sibling, "the sibling row keeps its DOM identity");
    assert(required(root.rows[0], "patched mapping row").checkbox.checked === false, "the replacement checkbox reflects the new selection");
    assertEqual(root.renderCount, renderCount, "a checkbox change does not remount the Mapping page");

    runtime.__TAURI__ = { core: { invoke: async () => null } };
    const bridge = new module.DesktopBridge();
    bridge.setProjectDir("/tmp/acw-mapping-destination");
    assertEqual(bridge.nativeCommand("folder.scan_documents"), "folder_scan_documents", "native document scan command is mapped");
    assertEqual(bridge.nativeCommand("folder.adopt"), "folder_adopt_with_documents", "adoption uses the compatible wrapper");
    assertEqual(
      bridge.nativeInput("folder.adopt", { root: ROOT, plan: {}, document_paths: [] }),
      { root: ROOT, plan: {}, documentPaths: [] },
      "an empty child-document choice crosses IPC explicitly",
    );
    assertEqual(
      bridge.nativeInput("folder.append", { root: ROOT, plan: {}, document_paths: [], duplicate_choice: "skip" }),
      { root: ROOT, plan: {}, projectDir: "/tmp/acw-mapping-destination", documentPaths: [], duplicateChoice: "skip" },
      "append payload uses Tauri camelCase keys",
    );
  } finally {
    runtime.document = previousDocument;
    runtime.fetch = previousFetch;
    if (previousTauri === undefined) delete runtime.__TAURI__;
    else runtime.__TAURI__ = previousTauri;
    if (previousWorkbench === undefined) delete runtime.__workbench;
    else runtime.__workbench = previousWorkbench;
    if (previousReady === undefined) delete runtime.__workbenchReady;
    else runtime.__workbenchReady = previousReady;
  }
});
