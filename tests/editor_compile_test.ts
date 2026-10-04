/**
 * Distraction-free editor regression tests (items 3, 4, 5, 6).
 *
 * Four rules live here, each pinned at the layer that owns it:
 *
 *  - Item 4: a completed Markdown shortcut compiles in place at the caret.  The
 *    DOM is edited around the finished run instead of re-rendering the block, so
 *    the caret keeps its plain-text offset and an IME session is never broken.
 *  - Item 6: structural Markdown becomes a structural block only when the whole
 *    meaningful body is one unambiguous unit, and never mid-typing. Typed list
 *    markers stay in paragraph storage and become list semantics at blur.
 *  - Item 3/5: block chrome is markup the stylesheet can turn into an overlay,
 *    and the source/B/I/S editing surface is gone from the rendered shell.
 *  - Item 6/§6.5: one auto-format is one Undo step.
 */
import {
  appendBlock,
  createDocument,
  createEmptyProjectData,
  initializeContentStatuses,
  now,
} from "../src/domain/index.ts";
import type { BlockType, ProjectData } from "../src/domain/types.ts";
import { lessonView } from "../app/authoring.js";
import { createViews } from "../app/views.js";
import {
  caretTextOffset,
  compileInlineAtCaret,
  editorValueChangedSinceBaseline,
  focusTextOffset,
  markdownFromEditable,
  renderMarkdown,
  structuralConversion,
} from "../app/markdown.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Minimal DOM: the editor compiles against live text nodes and a collapsed
// selection, so the caret rules cannot be checked on strings alone.
// ---------------------------------------------------------------------------

class MiniText {
  readonly nodeType = 3 as const;
  nodeValue: string;
  parentNode: MiniElement | null = null;
  constructor(value: string) {
    this.nodeValue = value;
  }
}

class MiniElement {
  readonly nodeType = 1 as const;
  readonly tagName: string;
  readonly childNodes: (MiniText | MiniElement)[] = [];
  parentNode: MiniElement | null = null;
  focusCalls = 0;
  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }
  get textContent(): string {
    return this.childNodes
      .map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent)
      .join("");
  }
  /** A real element reports the same name through both properties. */
  get nodeName(): string {
    return this.tagName;
  }
  set textContent(value: string) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    this.appendChild(new MiniText(value));
  }
  appendChild(node: MiniText | MiniElement): void {
    node.parentNode = this;
    this.childNodes.push(node);
  }
  insertBefore(node: MiniText | MiniElement, reference: MiniText | MiniElement): void {
    const at = this.childNodes.indexOf(reference);
    node.parentNode = this;
    if (at < 0) this.childNodes.push(node);
    else this.childNodes.splice(at, 0, node);
  }
  removeChild(node: MiniText | MiniElement): void {
    const at = this.childNodes.indexOf(node);
    if (at >= 0) this.childNodes.splice(at, 1);
    node.parentNode = null;
  }
  contains(node: MiniText | MiniElement | null): boolean {
    if (!node) return false;
    if (node === (this as MiniText | MiniElement)) return true;
    return this.childNodes.some((child) =>
      child.nodeType === 1 ? child.contains(node) : child === node
    );
  }
  focus(): void {
    this.focusCalls += 1;
  }
}

type MiniNode = MiniText | MiniElement;

function textLength(node: MiniNode): number {
  return node.nodeType === 3
    ? node.nodeValue.length
    : node.childNodes.reduce((total, child) => total + textLength(child), 0);
}

/** Plain-text index of a DOM point, or -1 when the point is not inside `root`. */
function pointIndex(root: MiniNode, container: MiniNode, offset: number): number {
  let index = 0;
  let found = false;
  const visit = (node: MiniNode): void => {
    if (found) return;
    if (node === container) {
      if (node.nodeType === 3) index += offset;
      else {
        for (let child = 0; child < offset; child += 1) {
          index += textLength(node.childNodes[child]!);
        }
      }
      found = true;
      return;
    }
    if (node.nodeType === 3) {
      index += node.nodeValue.length;
      return;
    }
    for (const child of node.childNodes) {
      visit(child);
      if (found) return;
    }
  };
  visit(root);
  return found ? index : -1;
}

function rootOf(node: MiniNode): MiniNode {
  let current = node;
  while (current.parentNode) current = current.parentNode;
  return current;
}

class MiniRange {
  startContainer: MiniNode | null = null;
  startOffset = 0;
  endContainer: MiniNode | null = null;
  endOffset = 0;
  get collapsed(): boolean {
    return this.startContainer === this.endContainer &&
      this.startOffset === this.endOffset;
  }
  setStart(node: MiniNode, offset: number): void {
    this.startContainer = node;
    this.startOffset = offset;
  }
  setEnd(node: MiniNode, offset: number): void {
    this.endContainer = node;
    this.endOffset = offset;
  }
  collapse(toStart: boolean): void {
    if (toStart) this.setEnd(this.startContainer!, this.startOffset);
    else this.setStart(this.endContainer!, this.endOffset);
  }
  selectNodeContents(node: MiniNode): void {
    this.setStart(node, 0);
    this.setEnd(node, node.nodeType === 3 ? node.nodeValue.length : node.childNodes.length);
  }
  cloneRange(): MiniRange {
    const copy = new MiniRange();
    copy.startContainer = this.startContainer;
    copy.startOffset = this.startOffset;
    copy.endContainer = this.endContainer;
    copy.endOffset = this.endOffset;
    return copy;
  }
  toString(): string {
    if (!this.startContainer || !this.endContainer) return "";
    const root = rootOf(this.startContainer);
    const from = pointIndex(root, this.startContainer, this.startOffset);
    const to = pointIndex(root, this.endContainer, this.endOffset);
    if (from < 0 || to < 0) return "";
    return nodeText(root).slice(from, to);
  }
}

class MiniSelection {
  ranges: MiniRange[] = [];
  get rangeCount(): number {
    return this.ranges.length;
  }
  getRangeAt(index: number): MiniRange {
    return this.ranges[index]!;
  }
  removeAllRanges(): void {
    this.ranges = [];
  }
  addRange(range: MiniRange): void {
    this.ranges.push(range);
  }
}

// `textContent` is a property on the shim, so ranges read plain text through
// this helper for both node kinds.
function nodeText(node: MiniNode): string {
  return node.nodeType === 3 ? node.nodeValue : node.textContent;
}

function caretAt(node: MiniNode, offset: number): MiniRange {
  const range = new MiniRange();
  range.setStart(node, offset);
  range.collapse(true);
  return range;
}

function installMiniDom(): () => void {
  const selection = new MiniSelection();
  const runtime = globalThis as unknown as Record<string, unknown>;
  const previous = {
    document: runtime.document,
    NodeFilter: runtime.NodeFilter,
    getSelection: runtime.getSelection,
  };
  runtime.document = {
    createRange: () => new MiniRange(),
    createElement: (tag: string) => new MiniElement(tag),
    createTextNode: (value: string) => new MiniText(value),
    createTreeWalker: (root: MiniNode) => {
      const texts: MiniText[] = [];
      const collect = (node: MiniNode): void => {
        if (node.nodeType === 3) texts.push(node);
        else node.childNodes.forEach(collect);
      };
      collect(root);
      let cursor = 0;
      return { nextNode: () => texts[cursor++] ?? null };
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  runtime.NodeFilter = { SHOW_TEXT: 4 };
  runtime.getSelection = () => selection;
  return () => {
    runtime.document = previous.document;
    runtime.NodeFilter = previous.NodeFilter;
    runtime.getSelection = previous.getSelection;
  };
}

/** Element with one text node holding `source`, caret after the whole run. */
function typed(source: string): { root: MiniElement; text: MiniText } {
  const root = new MiniElement("DIV");
  const text = new MiniText(source);
  root.appendChild(text);
  return { root, text };
}

function compileAt(source: string, caret: number): MiniElement {
  const restore = installMiniDom();
  try {
    const { root, text } = typed(source);
    const selection = (globalThis as unknown as { getSelection: () => MiniSelection })
      .getSelection();
    selection.addRange(caretAt(text, caret));
    assert(compileInlineAtCaret(root), `${source} should compile at the caret`);
    return root;
  } finally {
    restore();
  }
}

function childTag(root: MiniElement, index: number): string {
  const child = root.childNodes[index];
  return child && child.nodeType === 1 ? child.tagName : "";
}

// The compiler leaves a zero-width caret guard in front of the tail so the next
// keystroke does not land inside the run; it is layout, never content.
const GUARD = String.fromCharCode(0x200b);

function plainText(node: MiniElement): string {
  return node.textContent.split(GUARD).join("");
}

// ---------------------------------------------------------------------------
// Item 4 — inline Markdown compiles into rich display (§6.2, §6.4, §6.5)
// ---------------------------------------------------------------------------

Deno.test("**你好** becomes bold text with the markers gone", () => {
  const root = compileAt("**你好**", 6);
  assert(plainText(root) === "你好", "markers must not stay on screen");
  assert(childTag(root, 1) === "STRONG", "the finished run becomes <strong>");
  assert((root.childNodes[1] as MiniElement).textContent === "你好", "body is the run");
});

Deno.test("each first-class inline mark compiles at its closing token", () => {
  const cases: [string, string, string][] = [
    ["*斜体*", "斜体", "EM"],
    ["~~删除~~", "删除", "DEL"],
    ["`code`", "code", "CODE"],
    ["**加粗**", "加粗", "STRONG"],
  ];
  for (const [source, body, tag] of cases) {
    const root = compileAt(source, source.length);
    assert(plainText(root) === body, `${source} keeps only its body text`);
    assert(childTag(root, 1) === tag, `${source} compiles to <${tag}>`);
  }
});

Deno.test("compiling leaves the caret exactly where the user was typing", () => {
  const restore = installMiniDom();
  try {
    const { root, text } = typed("**你好**继续");
    const selection = (globalThis as unknown as { getSelection: () => MiniSelection })
      .getSelection();
    selection.addRange(caretAt(text, 6));
    assert(compileInlineAtCaret(root), "the closed run compiles");
    assert(plainText(root) === "你好继续", "surrounding text survives");
    assert(caretTextOffset(root) === 2, "caret stays before 继续, not at the start");

    // A later paragraph keeps its caret after the compiled run too.
    const second = typed("前**重点**后");
    selection.removeAllRanges();
    selection.addRange(caretAt(second.text, 7));
    assert(compileInlineAtCaret(second.root), "second run compiles");
    assert(plainText(second.root) === "前重点后", "text order is preserved");
    assert(caretTextOffset(second.root) === 3, "caret lands right after 重点");
  } finally {
    restore();
  }
});

Deno.test("text around a compiled run keeps its spaces", () => {
  const root = compileAt("a **b** c", 7);
  assert(plainText(root) === "a b c", "the separating spaces are not swallowed");
  assert(childTag(root, 1) === "STRONG", "only the finished run is wrapped");
});

Deno.test("unfinished or degenerate syntax is left alone", () => {
  const restore = installMiniDom();
  try {
    for (const source of ["****", "**", "`", "a * b"]) {
      const { root, text } = typed(source);
      const selection = (globalThis as unknown as { getSelection: () => MiniSelection })
        .getSelection();
      selection.removeAllRanges();
      selection.addRange(caretAt(text, source.length));
      assert(
        !compileInlineAtCaret(root),
        `${JSON.stringify(source)} is still typing, so it must not compile`,
      );
      assert(plainText(root) === source, `${source} keeps its literal markers`);
    }
  } finally {
    restore();
  }
});

Deno.test("typing **bold** after text never reads the tail of ** as emphasis", () => {
  const restore = installMiniDom();
  try {
    const runtime = globalThis as unknown as { getSelection: () => MiniSelection };
    const selection = runtime.getSelection();
    const source = "前面**加粗**";

    // Every keystroke while typing fires an input event, so the intermediate
    // states are what the live compiler really sees.  `**x*` is an unfinished
    // strong run, not `*` + emphasis + a stray star.
    for (let caret = 1; caret < source.length; caret++) {
      const { root, text } = typed(source.slice(0, caret));
      selection.removeAllRanges();
      selection.addRange(caretAt(text, caret));
      assert(
        !compileInlineAtCaret(root),
        `${JSON.stringify(source.slice(0, caret))} is mid-typing and must not compile`,
      );
      assert(plainText(root) === source.slice(0, caret), "literal markers stay while typing");
    }

    const done = typed(source);
    selection.removeAllRanges();
    selection.addRange(caretAt(done.text, source.length));
    assert(compileInlineAtCaret(done.root), "the closing ** compiles");
    assert(childTag(done.root, 1) === "STRONG", "the finished run is bold, not italic");
    assert(plainText(done.root) === "前面加粗", "only the markers disappear");

    // The caret has to land *after* the wrapper.  On the bare boundary the
    // engine puts it inside the bold run instead, and the next character the
    // user types silently becomes bold text.
    const atEnd = typed("前面**加粗**");
    selection.removeAllRanges();
    selection.addRange(caretAt(atEnd.text, 8));
    assert(compileInlineAtCaret(atEnd.root), "a run at the end of the line compiles");
    const point = selection.getRangeAt(0);
    assert(
      point.startContainer !== (atEnd.root.childNodes[1] as MiniElement).childNodes[0],
      "the caret is not inside the bold run",
    );
    assert(caretTextOffset(atEnd.root) === 4, "the caret sits right after the bold run");
    assert(
      !markdownFromEditable(atEnd.root).includes(GUARD),
      "the caret guard never reaches canonical storage",
    );

    // A real emphasis run that starts after text still compiles on its `*`.
    const italic = typed("前面*斜体*");
    selection.removeAllRanges();
    selection.addRange(caretAt(italic.text, 6));
    assert(compileInlineAtCaret(italic.root), "the closing * compiles");
    assert(childTag(italic.root, 1) === "EM", "a single-star run stays italic");
    assert(plainText(italic.root) === "前面斜体", "the italic run keeps its body");
  } finally {
    restore();
  }
});

Deno.test("a selection the editor does not own never rewrites the block", () => {
  const restore = installMiniDom();
  try {
    const runtime = globalThis as unknown as { getSelection: () => MiniSelection };
    const { root, text } = typed("**你好**");
    const selection = runtime.getSelection();

    // No selection at all (blur, or a native menu took it).
    selection.removeAllRanges();
    assert(!compileInlineAtCaret(root), "no selection, no rewrite");

    // A range outside this block.
    const other = new MiniElement("P");
    const outside = new MiniText("**别的**");
    other.appendChild(outside);
    selection.addRange(caretAt(outside, 6));
    assert(!compileInlineAtCaret(root), "a caret in another block must not move here");
    assert(plainText(root) === "**你好**", "the other block is not touched");

    // A range inside this block that is not collapsed (the user selected text).
    selection.removeAllRanges();
    const selected = new MiniRange();
    selected.setStart(text, 0);
    selected.setEnd(text, 6);
    selection.addRange(selected);
    assert(!compileInlineAtCaret(root), "a live selection is not a finished token");

    // A caret on an element node rather than inside text.
    selection.removeAllRanges();
    selection.addRange(caretAt(root, 0));
    assert(!compileInlineAtCaret(root), "an element point is not an editing position");
  } finally {
    restore();
  }
});

Deno.test("focusTextOffset puts the caret back after a converting render", () => {
  const restore = installMiniDom();
  try {
    const root = new MiniElement("DIV");
    root.appendChild(new MiniText("前"));
    const strong = new MiniElement("STRONG");
    strong.textContent = "重点";
    root.appendChild(strong);
    root.appendChild(new MiniText("后"));
    const selection = (globalThis as unknown as { getSelection: () => MiniSelection })
      .getSelection();
    assert(focusTextOffset(root, 3), "the offset resolves inside the re-rendered block");
    assert(caretTextOffset(root) === 3, "caret sits right after 重点");
    assert(root.focusCalls === 1, "the editor keeps focus, so typing can continue");

    // An offset past the end clamps instead of throwing the caret away.
    selection.removeAllRanges();
    focusTextOffset(root, 99);
    assert(caretTextOffset(root) === nodeText(root).length, "out-of-range clamps to the end");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Item 6 — conservative structural conversion (§7.1-§7.4)
// ---------------------------------------------------------------------------

type Conversion = { type: string; level: number | null; content: string; offsetLoss: number; deferUntilBlur?: boolean };

function converted(source: string, current: { type: string; level?: number | null }): Conversion | null {
  return structuralConversion(source, current) as Conversion | null;
}

Deno.test("a lone inline code span becomes a code block, nothing else does", () => {
  const alone = converted('`print("Hello")`', { type: "paragraph" });
  assert(alone?.type === "code", "pure inline code converts to the code block type");
  assert(alone?.content === 'print("Hello")', "display keeps only the code");
  assert(alone?.offsetLoss === 1, "one leading marker is removed for the caret maths");

  assert(
    converted('`print("Hello")`你好', { type: "paragraph" }) === null,
    "code mixed with prose stays the block the user wrote",
  );
  assert(
    converted("普通正文", { type: "paragraph" }) === null,
    "plain prose never converts",
  );
  assert(
    converted("**加粗**", { type: "paragraph" }) === null,
    "a bold paragraph is still a paragraph",
  );
});

Deno.test("heading, quote and divider syntax convert to their block types", () => {
  const heading = converted("## 标题", { type: "paragraph" });
  assert(heading?.type === "heading" && heading.level === 2, "## 标题 → heading H2");
  assert(heading?.content === "标题", "the markers leave the canonical content");
  assert(heading?.offsetLoss === 3, "caret maths knows how wide `## ` was");

  const quote = converted("> 一段引用", { type: "paragraph" });
  assert(quote?.type === "quote" && quote?.content === "一段引用", "> 一段引用 → quote");

  const divider = converted("---", { type: "paragraph" });
  assert(divider?.type === "divider" && divider?.content === "", "--- → divider is lossless");

  const fenced = converted("```\nprint(1)\n```", { type: "paragraph" });
  assert(fenced?.type === "code", "a fenced block converts to the code type");
  assert(fenced?.content === "print(1)", "fence markers are stripped once");

  const deep = converted("##### 五级标题", { type: "paragraph" });
  assert(deep?.type === "heading" && deep?.level === 5, "H5 is representable in the Domain");
});

Deno.test("canonical escaping never hides the syntax the user typed", () => {
  // §7.3 in the shipped pipeline: the serializer escapes `#`, `>` and `-` so a
  // paragraph can hold them as literal text, and the converter is handed that
  // stored form.  The conversions have to survive the escaping round trip.
  const cases: [string, string, string, number][] = [
    ["## 标题", "heading", "标题", 3],
    ["> 一段引用", "quote", "一段引用", 2],
    ["---", "divider", "", 3],
  ];
  for (const [source, type, body, offsetLoss] of cases) {
    const stored = markdownFromEditable(typed(source).root);
    assert(stored.includes("\\"), `${source} really is stored escaped`);
    const result = converted(stored, { type: "paragraph" });
    assert(
      result?.type === type,
      `${JSON.stringify(source)} stored as ${JSON.stringify(stored)} must convert to ${type}`,
    );
    assert(result.content === body, `${source} keeps only its body in canonical content`);
    // The caret counts the characters on screen, so the marker width is the typed
    // prefix, never the wider escaped one.
    assert(result.offsetLoss === offsetLoss, `${source} caret maths follows the typed text`);
  }
});

Deno.test("a fenced body keeps its literal backslashes through conversion", () => {
  // The stored form is lexed before the unescaped view precisely so raw code never
  // passes through the inverse escaper.
  const pre = new MiniElement("PRE");
  pre.appendChild(new MiniText("let re = /a\\\\*b/;"));
  const root = new MiniElement("DIV");
  root.appendChild(pre);
  const result = converted(markdownFromEditable(root), { type: "paragraph" });
  assert(result?.type === "code", "a whole-block fence still converts");
  assert(result?.content === "let re = /a\\\\*b/;", `code body stays verbatim: ${result?.content}`);
});

Deno.test("conversion refuses ambiguous structures and enables typed list rendering", () => {
  const partials = ["`", "**", ">", "#", "# ", "-", "标题\n正文一行", "## 标题\n正文"];
  for (const source of partials) {
    assert(
      converted(source, { type: "paragraph" }) === null,
      `${JSON.stringify(source)} is not one finished structural unit`,
    );
  }
  const listSource = [
    markdownFromEditable(typed("- 项目一 *字面星号*").root),
    markdownFromEditable(typed("- 项目二").root),
  ].join("\n\n");
  const list = converted(listSource, { type: "paragraph" });
  assert(list?.type === "paragraph", "the Domain keeps a list inside the paragraph's Markdown");
  assert(list.content === "- 项目一 \\*字面星号\\*\n\n- 项目二", "only escaped list markers are restored");
  assert(list.deferUntilBlur, "list markup waits for blur so the live editor caret stays put");
  const renderedList = renderMarkdown(list.content);
  assert(renderedList.includes("<ul>") && renderedList.includes("<li><p>项目一 *字面星号*</p>"), "a typed list becomes a rendered list");
  assert(!renderedList.includes("<em>字面星号</em>"), "escaped punctuation inside list text stays literal");

  const ordered = converted(markdownFromEditable(typed("1. 有序项").root), { type: "paragraph" });
  assert(ordered?.content === "1. 有序项", "ordered list marker escapes are restored");
  const escapedLiteral = markdownFromEditable(typed(`${String.fromCharCode(92)}- literal`).root);
  assert(converted(escapedLiteral, { type: "paragraph" }) === null, "an intentionally escaped literal dash stays prose");
  assert(
    !editorValueChangedSinceBaseline(escapedLiteral, escapedLiteral),
    "focus and blur without editing existing escaped prose must not enable structural conversion",
  );
  assert(
    editorValueChangedSinceBaseline(escapedLiteral + "!", escapedLiteral),
    "typing during the focus session enables the structural boundary check",
  );
  assert(
    converted("[链接](https://example.com)", { type: "paragraph" }) === null,
    "a lone link stays a paragraph",
  );
});

Deno.test("conversion never rewrites a block that is already in that shape", () => {
  assert(
    converted("## 标题", { type: "heading", level: 2 }) === null,
    "an H2 written as `## 标题` is already an H2",
  );
  assert(
    converted("> 一段引用", { type: "quote" }) === null,
    "a quote block keeps its content intact",
  );
  const promote = converted("## 标题", { type: "heading", level: 3 });
  assert(
    promote?.type === "heading" && promote?.level === 2,
    "a different level is a real change",
  );
});

Deno.test("divider, media and placeholder blocks are not conversion inputs", () => {
  for (const type of ["divider", "media", "placeholder"]) {
    assert(
      converted("## 标题", { type }) === null,
      `${type} blocks hold their content elsewhere, so nothing converts`,
    );
  }
});

// ---------------------------------------------------------------------------
// Items 3 + 4 — the rendered block carries no source-mode or formatting UI
// ---------------------------------------------------------------------------

function projectForEditor(title: string, type: BlockType, content: string) {
  const data = createEmptyProjectData(title);
  const stage = data.stages[0];
  const contentId = crypto.randomUUID();
  const document = createDocument(data, contentId);
  data.content_items.push({
    id: contentId,
    project_id: data.project.id,
    stage_id: stage?.id ?? null,
    code: "S01-01",
    title: "第一课",
    type: "lesson",
    description: "",
    order_index: 0,
    document_id: document.id,
    archived: false,
    created_at: now(),
    updated_at: now(),
  });
  initializeContentStatuses(data, contentId);
  appendBlock(data, contentId, type, content);
  const item = data.content_items[0]!;
  return { data, item };
}

function editorShell(type: BlockType, content: string): string {
  const { data, item } = projectForEditor("无干扰编辑器", type, content);
  const block = data.blocks[0]!;
  const store = {
    data,
    ui: {
      screen: "project",
      route: "editor",
      mode: "writing",
      activeId: item.id,
      selectedBlockId: block.id,
      focusRequirementId: null,
      leftCollapsed: false,
      rightCollapsed: false,
      editingProjectTitle: false,
      seedType: null,
      seedText: "",
      seedBusy: false,
      rightPanel: "properties",
      toast: "",
      showPreviewNotes: true,
      gridEditing: false,
      palette: false,
      capture: false,
      preflight: false,
      snapshot: false,
      assetPicker: null,
    },
    tabs: [{ content_item_id: item.id, pinned: false }],
    saveStatus: "已保存",
    assetPreview: new Map(),
    bridge: { isNative: () => false },
    currentItem() {
      return data.content_items.find((candidate) => candidate.id === this.ui.activeId) ?? null;
    },
    lesson() {
      return lessonView(data, item.id);
    },
    resumeLessonId() {
      return item.id;
    },
  };
  return createViews(store).shellView();
}

Deno.test("the block UI has no B/I/S buttons and no Markdown source surface", () => {
  const html = editorShell("paragraph", "**你好**");
  for (const dead of [
    "toggle-markdown-source",
    "markdown-format",
    "markdown-inline-toolbar",
    "markdown-source-field",
    "data-source-mode",
  ]) {
    assert(!html.includes(dead), `${dead} is removed from the block UI, not hidden`);
  }
  assert(!html.includes(">源码<"), "no 源码 affordance is rendered");
  assert(!html.includes(">Markdown<"), "no Markdown affordance is rendered");
  assert(
    html.includes('class="markdown-rich-editor'),
    "the block renders straight into the rich surface",
  );
  assert(
    html.includes("<strong>你好</strong>"),
    "stored Markdown displays as rich content rather than as syntax",
  );
});

Deno.test("chrome stays in the markup so the stylesheet can overlay it", () => {
  const html = editorShell("heading", "标题");
  const card = html.match(/<article\s+class="block\b[^"]*"[\s\S]*?<\/article>/)?.[0] ?? "";
  assert(card.includes('class="block-head"'), "the overlay row exists in the DOM");
  assert(card.includes("block-handle"), "drag handle is available on hover");
  assert(card.includes("block-type-label"), "block type access is available on hover");
  assert(card.includes("block-order"), "sequence number is available on hover");
  assert(card.includes('data-action="insert-block-below"'), "insert stays reachable");
  assert(card.includes('class="block-more"'), "the … menu stays reachable");
  assert(html.includes(">H6</option>"), "heading levels 1-6 are selectable");
  assert(html.includes(">H1</option>"), "H1 is selectable");
});

Deno.test("the stylesheet hides block chrome by default and reveals it as an overlay", async () => {
  const css = await Deno.readTextFile(new URL("../app/styles.css", import.meta.url));
  const rules = [...css.matchAll(/\.block-head\s*\{([^}]*)\}/g)].map((match) => match[1] ?? "");
  assert(rules.length >= 2, "the base and the distraction-free .block-head rules both apply");
  const overlay = rules.find((rule) =>
    rule.includes("position: absolute") && rule.includes("visibility: hidden")
  );
  assert(overlay, "chrome is out of flow and hidden by default, so it costs no height");
  assert(overlay?.includes("opacity: 0"), "hidden chrome is not merely transparent");

  const reveal = /\.block:hover \.block-head,[\s\S]{0,200}?\.block:focus-within \.block-head[\s\S]*?\{[^}]*visibility: visible/;
  assert(reveal.test(css), "hover, selection and focus-within each reveal the overlay");

  assert(
    /\.block \{[^}]*background: transparent/.test(css),
    "blocks lose the white card container that made every paragraph a box",
  );
  assert(
    !/\.markdown-inline-toolbar|\.markdown-format-button|\.markdown-source-field/.test(css),
    "the removed source-mode UI leaves no orphan CSS behind",
  );
});

// ---------------------------------------------------------------------------
// §6.5 — one auto-format is one history operation
// ---------------------------------------------------------------------------

type CompileStore = {
  data: ProjectData;
  ui: Record<string, unknown>;
  history: { label: string }[];
  saveTimer: number;
  editTimer: number;
  initialize: () => Promise<void>;
  recordBlockTextEdit: (
    blockId: string,
    before: string,
    value: string,
    options?: { notify?: boolean; retype?: Conversion | null },
  ) => void;
  undo: () => void;
  redo: () => void;
};

let compileStoreCounter = 0;

async function bootCompileStore(content: string): Promise<{
  store: CompileStore;
  block: ProjectData["blocks"][number];
  restore: () => void;
}> {
  const { data, item } = projectForEditor("自动格式化历史", "paragraph", content);
  const runtime = globalThis as unknown as Record<string, unknown>;
  const previousDocument = runtime.document;
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
  compileStoreCounter += 1;
  const { WorkbenchStore } = await import(`../app/main.js?editor-compile-${compileStoreCounter}`);
  const bridge = {
    projectDir: null,
    isNative: () => false,
    currentProject: () => data,
    loadSession: async () => ({ active_id: item.id }),
    readProject: async () => structuredClone(data),
    writeProject: async () => {},
    readRecoveryJournal: async () => null,
    writeRecoveryJournal: async () => {},
    clearRecoveryJournal: async () => {},
    saveSession: async () => {},
    createSnapshot: async () => ({}),
    setProjectDir: () => {},
    restoreProjectDir: () => {},
    projectIdentity: async () => data.project.id,
    listenNativeDrops: async () => () => {},
  };
  const store = new (WorkbenchStore as unknown as new (bridge: unknown) => CompileStore)(bridge);
  await store.initialize();
  return {
    store,
    block: store.data.blocks.find((candidate) => candidate.content === content)!,
    restore: () => {
      runtime.document = previousDocument;
      clearTimeout(store.saveTimer as unknown as number);
      clearTimeout(store.editTimer as unknown as number);
    },
  };
}

Deno.test("typing ## 标题 converts the block and costs exactly one Undo step", async () => {
  const { store, block, restore } = await bootCompileStore("## 标题");
  try {
    const before = store.history.length;
    // Live typing wrote the raw syntax into canonical data; the stable edit
    // boundary now records the conversion against the value typing started at.
    block.content = "## 标题";
    store.recordBlockTextEdit(block.id, "原文", "## 标题", {
      notify: false,
      retype: { type: "heading", level: 2, content: "标题", offsetLoss: 3 },
    });
    assert(store.history.length === before + 1, "type change and marker removal share one entry");
    assert(block.type === "heading", "the block became a heading");
    assert(block.content === "标题", "the markers are gone from canonical content");
    assert(block.settings.level === 2, "the level travelled with the conversion");

    store.undo();
    const undone = store.data.blocks.find((candidate) => candidate.id === block.id)!;
    assert(undone.type === "paragraph", "one Undo returns the block to prose");
    assert(undone.content === "原文", "one Undo restores the text as it was before typing");

    store.redo();
    const redone = store.data.blocks.find((candidate) => candidate.id === block.id)!;
    assert(
      redone.type === "heading" && redone.content === "标题",
      "Redo re-applies the whole format action",
    );
  } finally {
    restore();
  }
});

Deno.test("typed Markdown lists keep paragraph storage, render as lists and stay undoable", async () => {
  const initial = "原文";
  const listSource = [
    markdownFromEditable(typed("- 第一项").root),
    markdownFromEditable(typed("- 第二项").root),
  ].join("\n\n");
  const retype = converted(listSource, { type: "paragraph" });
  assert(retype?.type === "paragraph" && retype.deferUntilBlur, "list normalization is a paragraph edit deferred until blur");
  const { store, block, restore } = await bootCompileStore(initial);
  try {
    const before = store.history.length;
    block.content = listSource;
    store.recordBlockTextEdit(block.id, initial, listSource, {
      notify: false,
      retype,
    });
    assert(store.history.length === before + 1, "marker normalization shares one undo entry with typing");
    assert(block.type === "paragraph", "list semantics do not invent a Domain list block");
    assert(block.content === retype.content, "canonical Markdown keeps list markers without the escaping slash");
    store.undo();
    assert(store.data.blocks.find((candidate) => candidate.id === block.id)!.content === initial, "one Undo restores the paragraph before typing");
    store.redo();
    assert(store.data.blocks.find((candidate) => candidate.id === block.id)!.content === retype.content, "Redo restores the formatted list source");
  } finally {
    restore();
  }
});

Deno.test("a conversion with no text change still lands as one entry", async () => {
  const { store, block, restore } = await bootCompileStore("`code`");
  try {
    const before = store.history.length;
    block.content = "`code`";
    store.recordBlockTextEdit(block.id, "`code`", "code", {
      notify: false,
      retype: { type: "code", level: null, content: "code", offsetLoss: 1 },
    });
    assert(store.history.length === before + 1, "one entry for the whole format");
    assert(block.type === "code", "the block type converted");
    store.undo();
    assert(
      store.data.blocks.find((candidate) => candidate.id === block.id)!.type === "paragraph",
      "Undo returns the type as well as the text",
    );
  } finally {
    restore();
  }
});
