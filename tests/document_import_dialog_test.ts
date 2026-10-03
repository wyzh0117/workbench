/**
 * §18 — the body-document dialog that follows a confirmed Mapping Plan.
 *
 * After the user confirms which folder maps to which course object, a second
 * window decides *which text/document files become lesson body content*.  This
 * file proves the product shape: the window opens exactly when candidates exist
 * (media keeps its single click), it groups by the original relative directory,
 * every row is a hit target, an unchecked file never reaches `folder.adopt`, the
 * confirmed plan's mapping/destination are forwarded untouched (§19), the §28
 * tally renders from whatever the shell answered — including a shell that answers
 * nothing at all — and 取消 writes nothing.
 *
 * The last two cases run the browser/HTTP twin on a real temporary folder, which
 * is where the honesty rule lives: that pipeline has no `.docx` / `.pdf` parser
 * and must say so per file instead of failing or silently inventing content.
 */
import { createEmptyProjectData } from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";
import {
  applyDocumentImportDeselection,
  buildImportMappingPlan,
  collectDocumentImportCandidates,
  confirmImportMappingPlan,
  DOCUMENT_IMPORT_EXTENSIONS as SERVICE_DOCUMENT_EXTENSIONS,
  setImportMappingRole,
  type ImportMappingPlan,
} from "../src/service/folder_mapping.ts";
import { scanFolder } from "../src/service/folder_scan.ts";
import { confirmFolderAdoption } from "../src/service/folder_adoption.ts";
import {
  applyDocumentImportDeselection as applyShellDeselection,
  collectDocumentImportCandidates as collectShellCandidates,
  DOCUMENT_IMPORT_EXTENSIONS,
  normalizeDocumentImportReport,
} from "../app/constants.js";
import { createViews } from "../app/views.js";
import { mappingRowClickToggles } from "../app/canvas.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

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

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assert(
    sameValue(actual, expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function assertContains(text: string, needle: string, label: string): void {
  assert(
    text.includes(needle),
    `${label}: expected ${JSON.stringify(needle)} in ${JSON.stringify(text.slice(0, 4000))}`,
  );
}

function assertLacks(text: string, needle: string, label: string): void {
  assert(
    !text.includes(needle),
    `${label}: found forbidden ${JSON.stringify(needle)}`,
  );
}

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The repo checks with `noUncheckedIndexedAccess`, so a bump needs a word. */
function must<T>(value: T | undefined, label: string): T {
  assert(value !== undefined && value !== null, `${label} is missing`);
  return value;
}

type LooseRecord = Record<string, any>;
type Call = { name: string; payload: LooseRecord };

const ROOT = "/tmp/acw-document-import";
const CURRENT = createEmptyProjectData("文档导入测试课程");

/** One plan row, spelled out so a test can change exactly the field it is about. */
function item(overrides: LooseRecord = {}): LooseRecord {
  return {
    relative_path: "s01-00/notes.txt",
    kind: "file",
    mime: "text/plain",
    size: 1024,
    suggested: "lesson",
    mapping: "lesson",
    selected: true,
    is_suggestion: true,
    error: null,
    destination: { kind: "unassigned_lesson" },
    markdown_dependency_preview: null,
    markdown_source_match: null,
    allow_duplicate: false,
    ...overrides,
  };
}

function plan(items: LooseRecord[], confirmed = true): LooseRecord {
  return {
    root: ROOT,
    items,
    confirmed,
    confirmed_at: confirmed ? "2026-10-01T08:00:00.000Z" : null,
  };
}

/** The adopt answer both shells send: a project plus the §28 document tally. */
function adoptAnswer(documentImport?: unknown): LooseRecord {
  const value: LooseRecord = {
    data: structuredClone(CURRENT),
    root: ROOT,
    stage_ids: [],
    content_item_ids: ["lesson-imported"],
    asset_ids: [],
    source_ids: [],
    reused_asset_ids: [],
    warnings: [],
    copied_files: [],
  };
  if (documentImport !== undefined) value.document_import = documentImport;
  return value;
}

/**
 * §16 runs a Markdown image-dependency preview *before* a plan can be confirmed.
 * The harness answers that read so a `.md` row behaves like a real one here; the
 * preview itself belongs to `tests/t04_adoption_test.ts`.
 */
async function markdownSourceAnswer(relativePath: string): Promise<LooseRecord> {
  const text = `# ${relativePath}\n第一段正文。\n`;
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    relative_path: relativePath,
    size: bytes.length,
    sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    text,
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
  adoptCalls: () => Call[];
  setAnswer: (name: string, answer: unknown) => void;
  overlayMarkup: () => string;
  mappingMarkup: () => string;
  restore: () => void;
};

async function bootDocumentHarness(
  options: { plan?: LooseRecord | null; answers?: LooseRecord } = {},
): Promise<Harness> {
  const restore = stubDocument();
  const calls: Call[] = [];
  const answers: LooseRecord = {
    "folder.adopt": adoptAnswer(),
    "folder.append": adoptAnswer(),
    "ai.execution.list": { records: [] },
    "folder.read_source": (input: LooseRecord) =>
      markdownSourceAnswer(String(input.relativePath || "")),
    ...options.answers,
  };
  bootCount += 1;
  const module = await import(`../app/main.js?document-import-${bootCount}`) as LooseRecord;
  const bridge = {
    projectDir: null,
    projectDirFromUrl: false,
    isNative: () => true,
    currentProject: () => CURRENT,
    loadSession: async () => null,
    readProject: async () => structuredClone(CURRENT),
    writeProject: async () => {},
    readRecoveryJournal: async () => null,
    writeRecoveryJournal: async () => {},
    clearRecoveryJournal: async () => {},
    saveSession: async () => {},
    createSnapshot: async () => ({}),
    setProjectDir: (value: string) => value,
    restoreProjectDir: () => {},
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
  store.data = structuredClone(CURRENT);
  // The adopt path re-opens the folder it just wrote.  This file is about what
  // goes into the command and what comes back out of it, not the open pipeline.
  store.openProject = async () => {};
  if (options.plan) store.ui.importMappingPlan = options.plan;
  store.ui.importFolderRoot = ROOT;
  store.ui.route = "mapping";
  store.ui.screen = "project";
  const views = createViews(store as never) as LooseRecord;
  return {
    store,
    calls,
    adoptCalls: () => calls.filter((call) => call.name === "folder.adopt"),
    setAnswer: (name, answer) => {
      answers[name] = answer;
    },
    overlayMarkup: () => (views.overlayView?.() ?? "") as string,
    mappingMarkup: () => {
      store.ui.route = "mapping";
      return views.shellView() as string;
    },
    restore,
  };
}

// ---------------------------------------------------------------------------
// §16 / §18 — when the dialog appears
// ---------------------------------------------------------------------------

Deno.test("a confirmed plan with document candidates stops at the body dialog", async () => {
  const { store, calls, adoptCalls, overlayMarkup, restore } = await bootDocumentHarness({
    plan: plan([
      item({ relative_path: "s01-00/outline.md", mime: "text/markdown" }),
      item({ relative_path: "s01-00/reading.pdf", mime: "application/pdf", size: 4096 }),
    ]),
  });
  try {
    // §16's preview gate runs first, exactly as it does on the mapping page.
    await store.refreshMarkdownDependencyPreviews();
    await store.confirmImportMapping();
    assertEqual(adoptCalls().length, 0, "confirm adopts nothing before the body choice is made");
    assertEqual(
      [...new Set(calls.map((call) => call.name))].filter((name) => name !== "folder.read_source"),
      [],
      "the §18 dialog asks the shell for nothing new",
    );
    assert(store.ui.documentImportDialog, "the §18 dialog opened");
    assertEqual(
      (store.ui.documentImportDialog.items as LooseRecord[]).map((row) => row.relative_path),
      ["s01-00/outline.md", "s01-00/reading.pdf"],
      "the dialog lists the plan's document candidates",
    );
    const markup = overlayMarkup();
    assertContains(markup, "选择要导入为正文的文档", "the title is the doc's own words");
    assertContains(markup, 'data-action="document-import-confirm"', "导入所选正文");
    assertContains(markup, 'data-action="document-import-cancel"', "取消");
    assertContains(markup, "导入所选正文", "the primary button is labelled in Chinese");
    assert(
      store.ui.importMappingPlan.confirmed === true,
      "the plan stays confirmed while the dialog is the pending step",
    );
  } finally {
    restore();
  }
});

Deno.test("a media-only folder keeps its single confirm click and imports at once", async () => {
  const { store, calls, adoptCalls, restore } = await bootDocumentHarness({
    plan: plan([
      item({
        relative_path: "s01-00",
        kind: "directory",
        mapping: "stage",
        mime: null,
        size: null,
        destination: null,
      }),
      // §17: media auto-imports; it never waits for a body decision.
      item({ relative_path: "s01-00/demo.png", kind: "image", mime: "image/png", mapping: "asset" }),
      item({ relative_path: "s01-00/clip.mp4", kind: "video", mime: "video/mp4", mapping: "asset" }),
      // A document the user mapped to something other than 正文 is not a candidate.
      item({ relative_path: "总体说明.pdf", mime: "application/pdf", mapping: "reference" }),
    ]),
  });
  try {
    await store.confirmImportMapping();
    assertEqual(store.ui.documentImportDialog, null, "no candidates, no second window");
    const adopted = adoptCalls();
    assertEqual(adopted.length, 1, "the import proceeds exactly as it does today");
    assertEqual(must(adoptCalls()[0], "the adopt call").payload.plan.items.length, 4, "the confirmed plan is forwarded whole");
    assert(
      calls.every((call) => call.name !== "folder.read_source"),
      "nothing extra is asked of the shell for a folder without documents",
    );
    assertEqual(store.ui.route, "map", "and the user lands back on the course map");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// §18.2 / §18.3 — the list itself
// ---------------------------------------------------------------------------

Deno.test("candidates are grouped by their original directory, never flattened", async () => {
  const { store, overlayMarkup, restore } = await bootDocumentHarness({
    plan: plan([
      item({ relative_path: "s01-00/outline.md" }),
      item({ relative_path: "s01-00/reading.pdf", mime: "application/pdf" }),
      item({ relative_path: "s01-01/intro.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
      item({ relative_path: "s01-01/notes.txt" }),
      item({ relative_path: "说明.text" }),
    ]),
  });
  try {
    store.openDocumentImportDialog(store.ui.importMappingPlan);
    const markup = overlayMarkup();
    assertContains(markup, "s01-00/", "the first source folder is a group of its own");
    assertContains(markup, "s01-01/", "and the second one is not merged into it");
    assertContains(markup, "根目录", "a file at the root sits under its own heading");
    const firstGroup = markup.indexOf("s01-00/");
    const secondGroup = markup.indexOf("s01-01/");
    const outline = markup.indexOf("s01-00/outline.md");
    const intro = markup.indexOf("s01-01/intro.docx");
    assert(
      firstGroup < outline && outline < secondGroup && secondGroup < intro,
      `each row stays inside its own group (markup order: ${firstGroup}/${outline}/${secondGroup}/${intro})`,
    );
    assertEqual(
      (markup.match(/class="document-import-group"/g) ?? []).length,
      3,
      "three source directories, three groups",
    );
  } finally {
    restore();
  }
});

Deno.test("every candidate row shows name, relative path, type and size", async () => {
  const { store, overlayMarkup, restore } = await bootDocumentHarness({
    plan: plan([
      item({ relative_path: "s01-00/导论.md", size: 2048, mime: "text/markdown" }),
      item({ relative_path: "s01-00/slides.pdf", size: 1_500_000, mime: "application/pdf" }),
    ]),
  });
  try {
    store.openDocumentImportDialog(store.ui.importMappingPlan);
    const markup = overlayMarkup();
    assertContains(markup, ">导论.md<", "the file name is the row's headline");
    assertContains(markup, "s01-00/导论.md · Markdown · 2 KB", "§18.3 metadata: path, type, size");
    assertContains(markup, "s01-00/slides.pdf · PDF · 1.4 MB", "a PDF is labelled as what it is");
    assertContains(markup, 'aria-label="将 slides.pdf 导入为正文"', "the checkbox is announced");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// §18.1 — the selection controls
// ---------------------------------------------------------------------------

Deno.test("全选 and 取消全选 move every candidate together", async () => {
  const { store, overlayMarkup, restore } = await bootDocumentHarness({
    plan: plan([
      item({ relative_path: "s01-00/a.txt" }),
      item({ relative_path: "s01-00/b.txt" }),
      item({ relative_path: "s01-01/c.txt" }),
    ]),
  });
  try {
    store.openDocumentImportDialog(store.ui.importMappingPlan);
    assertContains(overlayMarkup(), "已选 3 / 3 项", "the dialog opens with the plan's own selection");
    store.setAllDocumentImportSelected(false);
    let markup = overlayMarkup();
    assertContains(markup, "已选 0 / 3 项", "取消全选 clears the rows");
    assertContains(markup, "deselected", "and a cleared row looks cleared");
    assertEqual(
      (markup.match(/data-document-import-select[^>]*checked/g) ?? []).length,
      0,
      "no checkbox is still ticked",
    );
    store.setAllDocumentImportSelected(true);
    markup = overlayMarkup();
    assertContains(markup, "已选 3 / 3 项", "全选 brings them all back");
    assertEqual(
      (markup.match(/data-document-import-select[^>]*checked/g) ?? []).length,
      3,
      "every row is ticked again",
    );
    assertContains(markup, 'data-action="document-import-all"', "全选 is a real control");
    assertContains(markup, 'data-action="document-import-none"', "取消全选 is a real control");
  } finally {
    restore();
  }
});

Deno.test("clicking the row — not only its checkbox — toggles that document", async () => {
  const mainSource = await Deno.readTextFile(new URL("../app/main.js", import.meta.url));
  const { store, overlayMarkup, restore } = await bootDocumentHarness({
    plan: plan([item({ relative_path: "s01-00/a.txt" }), item({ relative_path: "s01-00/b.txt" })]),
  });
  try {
    store.openDocumentImportDialog(store.ui.importMappingPlan);
    // The whole row is the hit target: it carries the path and its current state,
    // and the shell binds a click on the row to the same selection call the
    // checkbox makes — with the shared predicate that ignores real controls.
    assertContains(
      mainSource,
      'root.querySelectorAll("[data-document-import-row]")',
      "the shell binds clicks on the row itself",
    );
    assertContains(
      mainSource,
      "store.setDocumentImportSelected(\n        row.dataset.path || \"\",\n        row.dataset.selected !== \"true\",\n      )",
      "a row click flips the row's own state",
    );
    const markup = overlayMarkup();
    assertContains(markup, 'data-document-import-row data-path="s01-00/a.txt" data-selected="true"', "the row is addressable");
    assert(
      mappingRowClickToggles({ closest: () => null }) === true,
      "a click on the row background toggles",
    );
    assert(
      mappingRowClickToggles({
        closest: (selector: string) => selector.includes("input") ? {} : null,
      }) === false,
      "the checkbox keeps its own change handler, so one click is one toggle"
    );
    // What that click does.
    store.setDocumentImportSelected("s01-00/a.txt", false);
    assertEqual(
      (store.ui.documentImportDialog.items as LooseRecord[]).map((row) => row.selected),
      [false, true],
      "only the clicked row changed",
    );
    const after = overlayMarkup();
    assertContains(after, 'data-path="s01-00/a.txt" data-selected="false"', "the row now reads as unselected");
    assertContains(after, "已选 1 / 2 项", "and the counter follows");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// §19 / §31 — what the choice means for the import
// ---------------------------------------------------------------------------

Deno.test("an unchecked document is never sent to folder.adopt", async () => {
  const { store, adoptCalls, restore } = await bootDocumentHarness({
    plan: plan([
      item({ relative_path: "s01-00/keep.txt" }),
      item({ relative_path: "s01-00/drop.txt" }),
      item({
        relative_path: "s01-00",
        kind: "directory",
        mapping: "stage",
        destination: null,
      }),
    ]),
  });
  try {
    await store.confirmImportMapping();
    store.setDocumentImportSelected("s01-00/drop.txt", false);
    await store.confirmDocumentImportSelection();
    const adopted = adoptCalls();
    assertEqual(adopted.length, 1, "one import runs, from the dialog's own button");
    const sent = (must(adopted[0], "the adopt call").payload.plan.items as LooseRecord[]).filter((row) =>
      row.kind === "file"
    );
    assertEqual(
      sent.map((row) => [row.relative_path, row.selected]),
      [["s01-00/keep.txt", true], ["s01-00/drop.txt", false]],
      "the unchecked file is deselected, so the shell skips it entirely",
    );
    assertEqual(store.ui.documentImportDialog, null, "the dialog closed on the answer");
    assert(store.ui.toast.includes("已原地接管"), `the import reported itself (toast=${store.ui.toast})`);
  } finally {
    restore();
  }
});

Deno.test("the confirmed plan's mapping and destination are forwarded unchanged", async () => {
  const mapped = item({
    relative_path: "s01-01/案例.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 3300,
    suggested: "reference",
    mapping: "lesson",
    destination: { kind: "existing_lesson", content_item_id: "lesson-9" },
    allow_duplicate: true,
  });
  const untouched = item({
    relative_path: "s01-01/讲义.txt",
    mapping: "source",
    destination: null,
  });
  const original = structuredClone([mapped, untouched]);
  const { store, adoptCalls, restore } = await bootDocumentHarness({
    plan: plan([mapped, untouched]),
  });
  try {
    await store.confirmImportMapping();
    // The dialog only offered the .docx: `source` is not a body mapping.
    assertEqual(
      (store.ui.documentImportDialog.items as LooseRecord[]).map((row) => row.relative_path),
      ["s01-01/案例.docx"],
      "only lesson-bound documents are offered",
    );
    await store.confirmDocumentImportSelection();
    const sent = must(adoptCalls()[0], "the adopt call").payload.plan.items as LooseRecord[];
    // The dialog filters; it does not translate.  Every confirmed field except the
    // one the user just changed must arrive byte-for-byte the same (§19).
    const withoutSelection = (rows: LooseRecord[]) =>
      rows.map((row) => {
        const { selected: _ignored, ...rest } = row;
        return rest;
      });
    assertEqual(
      withoutSelection(sent),
      withoutSelection(original),
      "every confirmed field survives verbatim (no second Stage/Lesson inference)",
    );
    assertEqual(
      sent.map((row) => row.destination),
      [{ kind: "existing_lesson", content_item_id: "lesson-9" }, null],
      "the destination the user picked in the preview is what the shell gets",
    );
    assertEqual(must(sent[0], "the .docx row").allow_duplicate, true, "an acknowledged duplicate stays acknowledged");
    assertEqual(must(sent[0], "the .docx row").mapping, "lesson", "the dialog did not re-map anything");
    assertEqual(must(sent[0], "the .docx row").selected, true, "the checked row keeps its place in the batch");
    assertEqual(must(sent[1], "the row outside the dialog").mapping, "source", "the row outside the dialog is untouched");
  } finally {
    restore();
  }
});

Deno.test("cancelling the dialog sends nothing and leaves the plan un-adopted", async () => {
  const { store, calls, overlayMarkup, restore } = await bootDocumentHarness({
    plan: plan([item({ relative_path: "s01-00/intro.txt" })]),
  });
  try {
    await store.confirmImportMapping();
    assert(overlayMarkup().includes("document-import-modal"), "the dialog is open");
    calls.length = 0;
    store.cancelDocumentImportSelection();
    assertEqual(calls.length, 0, "取消 sends nothing at all");
    assertEqual(store.ui.documentImportDialog, null, "the dialog is closed");
    assertEqual(store.ui.importMappingPlan.confirmed, false, "the plan is back to a preview");
    const notice = String(store.ui.importMappingError);
    assertContains(notice, "没有写入任何课程内容", "and it says so in plain Chinese");
    assertContains(notice, "源文件仍在原处", "naming the thing the user actually worries about");
    assertLacks(overlayMarkup(), "document-import-modal", "the modal is gone from the markup");
    assertContains(store.ui.importMappingError, "映射预览", "and the way back is named");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// §28 — what came back
// ---------------------------------------------------------------------------

Deno.test("the §28 tally renders from the shell's document_import", async () => {
  const report = {
    succeeded: 2,
    degraded: 1,
    skipped: 0,
    failed: 1,
    files: [
      { relative_path: "s01-00/intro.txt", outcome: "succeeded", reason: "" },
      { relative_path: "s01-00/outline.md", outcome: "succeeded", reason: "" },
      {
        relative_path: "s01-01/deck.docx",
        outcome: "degraded",
        reason: "浮动图片与页眉已省略，标题与表格保留",
      },
      {
        relative_path: "s01-02/scan.pdf",
        outcome: "failed",
        reason: "无法解析文字层，已保留为来源参考",
      },
    ],
  };
  const { store, mappingMarkup, restore } = await bootDocumentHarness({
    plan: plan([
      item({ relative_path: "s01-00/intro.txt" }),
      item({ relative_path: "s01-01/deck.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
      item({ relative_path: "s01-02/scan.pdf", mime: "application/pdf" }),
    ]),
    answers: { "folder.adopt": adoptAnswer(report) },
  });
  try {
    await store.confirmImportMapping();
    await store.confirmDocumentImportSelection();
    assertEqual(
      [
        store.ui.documentImportReport.succeeded,
        store.ui.documentImportReport.degraded,
        store.ui.documentImportReport.skipped,
        store.ui.documentImportReport.failed,
      ],
      [2, 1, 0, 1],
      "the shell's own numbers are what is shown",
    );
    assertEqual(
      store.ui.documentImportReport.files.map((row: LooseRecord) => row.relative_path),
      ["s01-00/intro.txt", "s01-00/outline.md", "s01-01/deck.docx", "s01-02/scan.pdf"],
      "the per-file list arrives in the shell's order",
    );
    const markup = mappingMarkup();
    assertContains(markup, "正文导入结果", "the tally has a home beside the import warnings");
    assertContains(markup, "成功 2 · 降级 1 · 跳过 0 · 失败 1", "§28 headline, verbatim");
    assertContains(markup, "s01-02/scan.pdf", "the failed file is named");
    assertContains(markup, "无法解析文字层，已保留为来源参考", "with the shell's reason for display");
    assertContains(markup, "浮动图片与页眉已省略", "a degraded file explains what was dropped");
    // One file failing must not read as nothing happened, nor as a dead import.
    assertContains(store.ui.toast, "正文导入：成功 2 · 降级 1 · 跳过 0 · 失败 1", "the toast carries the tally");
    assertContains(store.ui.toast, "未进入正文：s01-02/scan.pdf", "and names what did not come in");
    assertContains(store.ui.toast, "已原地接管", "while still reporting the import that did happen");
  } finally {
    restore();
  }
});

Deno.test("a shell with no document_import still reports the import, without a tally", async () => {
  const { store, mappingMarkup, restore } = await bootDocumentHarness({
    plan: plan([item({ relative_path: "s01-00/intro.txt" })]),
    answers: {
      "folder.adopt": { ...adoptAnswer(), warnings: ["s01-00/intro.txt: 图片依赖缺失"] },
    },
  });
  try {
    await store.confirmImportMapping();
    await store.confirmDocumentImportSelection();
    assertEqual(store.ui.documentImportReport, null, "nothing is invented for a silent shell");
    const markup = mappingMarkup();
    assertLacks(markup, "正文导入结果", "no empty tally panel appears");
    assertLacks(markup, "成功 0 · 降级 0 · 跳过 0 · 失败 0", "no fabricated zeros");
    assertContains(store.ui.toast, "图片依赖缺失", "the ordinary warning list still speaks");
    assertContains(store.ui.toast, "已原地接管", "and the import itself is reported");
  } finally {
    restore();
  }
});

Deno.test("a document_import with only rows still counts honestly", async () => {
  const { store, restore } = await bootDocumentHarness({
    plan: plan([item({ relative_path: "s01-00/a.txt" }), item({ relative_path: "s01-00/b.txt" })]),
    answers: {
      "folder.adopt": adoptAnswer({
        files: [
          { relative_path: "s01-00/a.txt", outcome: "succeeded" },
          { relative_path: "s01-00/b.txt", outcome: "skipped", reason: "同一来源已导入" },
        ],
      }),
    },
  });
  try {
    await store.confirmImportMapping();
    await store.confirmDocumentImportSelection();
    assertEqual(
      store.ui.documentImportReport,
      {
        succeeded: 1,
        degraded: 0,
        skipped: 1,
        failed: 0,
        total: 2,
        files: [
          {
            relative_path: "s01-00/a.txt",
            outcome: "succeeded",
            outcome_label: "成功",
            reason: "",
          },
          {
            relative_path: "s01-00/b.txt",
            outcome: "skipped",
            outcome_label: "跳过",
            reason: "同一来源已导入",
          },
        ],
      },
      "the per-file rows are counted, not the headline",
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

Deno.test("long and hostile document names are escaped, never injected", async () => {
  const hostile = '"><script>alert(1)</script>.docx';
  const long = `${"很长的章节名称".repeat(12)}.txt`;
  const { store, overlayMarkup, mappingMarkup, restore } = await bootDocumentHarness({
    plan: plan([
      item({ relative_path: `s01-00/${hostile}`, size: 220 }),
      item({ relative_path: `s01-99/${long}`, size: 61 }),
    ]),
    answers: {
      "folder.adopt": adoptAnswer({
        succeeded: 0,
        degraded: 0,
        skipped: 0,
        failed: 1,
        files: [{ relative_path: hostile, outcome: "failed", reason: "<img src=x onerror=alert(2)>" }],
      }),
    },
  });
  try {
    await store.confirmImportMapping();
    const markup = overlayMarkup();
    assertLacks(markup, "<script>alert(1)</script>", "a filename is not a way to write markup");
    assertLacks(markup, "<script", "and it cannot break out of the attribute it landed in");
    assertContains(markup, "&quot;&gt;&lt;script&gt;", "the quote and the angle brackets all arrive as text");
    const rows = store.ui.documentImportDialog.items as LooseRecord[];
    assertEqual(rows.map((row) => row.relative_path).length, 2, "both hostile rows are still selectable");
    assertEqual((markup.match(/data-document-import-row/g) ?? []).length, 2, "one row each");
    assertContains(markup, `很长的章节名称`.repeat(12), "a long name is shown, not truncated away");
    await store.confirmDocumentImportSelection();
    const result = mappingMarkup();
    assertLacks(result, "<img src=x onerror=alert(2)>", "a shell-supplied reason is escaped");
    assertLacks(result, "<script>", "no markup from the report at all");
    assertContains(result, "&lt;img src=x onerror=alert(2)&gt;", "and it reads as the text it is");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The two shells agree on the §18 format list
// ---------------------------------------------------------------------------

Deno.test("the shell and the service agree on the §18 document formats", () => {
  assertEqual(
    DOCUMENT_IMPORT_EXTENSIONS,
    SERVICE_DOCUMENT_EXTENSIONS,
    "one list of nine formats, one behaviour",
  );
  const items = [
    item({ relative_path: "s01-00/a.tex" }),
    item({ relative_path: "s01-00/b.latex" }),
    item({ relative_path: "s01-00/c.epub", mime: "application/epub+zip" }),
    item({ relative_path: "s01-00/d.text" }),
    item({ relative_path: "s01-00/e.png", kind: "image", mapping: "asset", mime: "image/png" }),
    item({ relative_path: "s01-00/f.doc", mapping: "source" }),
    item({ relative_path: "s01-00/g.txt", selected: false }),
    item({ relative_path: "s01-00/h.md", error: "无法读取" }),
  ];
  assertEqual(
    collectShellCandidates(plan(items)).map((row: LooseRecord) => row.relative_path),
    ["s01-00/a.tex", "s01-00/b.latex", "s01-00/c.epub", "s01-00/d.text"],
    "media, non-body mappings, deselected and unreadable rows stay out",
  );
  assertEqual(
    collectDocumentImportCandidates(plan(items) as unknown as ImportMappingPlan).map((row) => row.relative_path),
    ["s01-00/a.tex", "s01-00/b.latex", "s01-00/c.epub", "s01-00/d.text"],
    "the service twin selects the same rows",
  );
});

Deno.test("deselecting in the service twin keeps the plan confirmed and the rest intact", () => {
  const base = plan([
    item({ relative_path: "s01-00/a.txt" }),
    item({ relative_path: "s01-00/b.txt" }),
    item({ relative_path: "s01-00", kind: "directory", mapping: "stage", destination: null }),
  ]) as unknown as ImportMappingPlan;
  const next = applyDocumentImportDeselection(base, ["s01-00/a.txt"]);
  assertEqual(next.confirmed, true, "the body answer is itself a confirmation");
  assertEqual(next.confirmed_at, base.confirmed_at, "and does not stamp a new one");
  assertEqual(
    next.items.map((row) => row.selected),
    [false, true, true],
    "only the chosen row is switched off",
  );
  assertEqual(must(base.items[0], "the first row").selected, true, "the original plan is not written through");
  const refused = applyDocumentImportDeselection(base, ["s01-00", "s01-00/b.txt", ""]);
  assertEqual(
    refused.items.map((row) => row.selected),
    [true, false, true],
    "a stage row cannot be switched off from the document dialog",
  );
  const shellNext = applyShellDeselection(base, ["s01-00/a.txt"]);
  assertEqual(shellNext, JSON.parse(JSON.stringify(next)), "the shell's copy behaves the same");
});

// ---------------------------------------------------------------------------
// §28 in the browser shell — honest about what it cannot parse
// ---------------------------------------------------------------------------

Deno.test("the browser shell fails unsupported documents without losing the batch", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-document-import-browser-" });
  try {
    await Deno.writeTextFile(`${root}/outline.md`, "# 大纲\n第一段\n");
    await Deno.writeTextFile(`${root}/notes.txt`, "纯文本讲义\n第二段\n`code`\n");
    await Deno.writeFile(`${root}/scan.pdf`, new Uint8Array([37, 80, 68, 70, 0, 1, 2, 3]));
    const report = await scanFolder(root);
    let base = buildImportMappingPlan(report.root, report.entries);
    base = setImportMappingRole(base, "scan.pdf", "lesson");
    const confirmed = confirmImportMappingPlan(base);
    assertEqual(
      collectDocumentImportCandidates(confirmed).map((row) => row.relative_path).sort(),
      ["notes.txt", "outline.md", "scan.pdf"],
      "all three are body candidates for the dialog",
    );
    const result = await confirmFolderAdoption(confirmed, { project_root: root });
    const documentImport = result.document_import;
    assert(documentImport, "the browser result carries the same §28 key the native shell sends");
    const byPath = new Map(documentImport.files.map((file) => [file.relative_path, file]));
    assertEqual(byPath.get("notes.txt")?.outcome, "succeeded", "the text path really is imported");
    assertEqual(byPath.get("outline.md")?.outcome, "succeeded", "and the Markdown path too");
    assertEqual(byPath.get("scan.pdf")?.outcome, "failed", "the PDF is not silently accepted");
    assertContains(byPath.get("scan.pdf")?.reason ?? "", "桌面应用", "the reason names what to do instead");
    assertEqual(
      [documentImport.succeeded, documentImport.degraded, documentImport.skipped, documentImport.failed],
      [2, 0, 0, 1],
      "one unsupported file never fails the whole batch",
    );
    const lessons = result.data.content_items.filter((row) => !row.archived);
    assert(
      lessons.some((row) => row.title === "notes") && lessons.some((row) => row.title === "outline"),
      `the two parseable documents still became lessons (${lessons.map((row) => row.title).join("、")})`,
    );
    assert(
      !lessons.some((row) => row.title === "scan"),
      "no lesson was built out of undecodable PDF bytes",
    );
    assert(
      await Deno.readFile(`${root}/scan.pdf`).then((bytes) => bytes.length === 8),
      "the source file is untouched (§29)",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a browser import with no documents sends no document tally", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-document-import-media-" });
  try {
    await Deno.writeFile(`${root}/photo.png`, new Uint8Array([137, 80, 78, 71]));
    const report = await scanFolder(root);
    const result = await confirmFolderAdoption(confirmImportMappingPlan(buildImportMappingPlan(report.root, report.entries)), {
      project_root: root,
    });
    assertEqual(
      "document_import" in result,
      false,
      "no candidates, no key: the caller keeps showing the warning list",
    );
    const shell = normalizeDocumentImportReport((result as LooseRecord).document_import);
    assertEqual(shell, null, "and the frontend's own normaliser reads the same absence: nothing to show");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
