/**
 * V1 Item 14 (§15.1-§15.4) — the Grid pointer chain, tested the way the browser
 * drives it.
 *
 * The regression this guards is not "a handler is missing": it is a click that
 * reaches nothing because the listener sat on a node `render()` had already
 * thrown away, or because an invisible overlay ate the pointer.  So every case
 * here dispatches a synthetic `pointerdown` / `click` / `contextmenu` against
 * the markup `views.shellView()` ACTUALLY renders (the file parses real HTML
 * into a small DOM stand-in that bubbles events through a parent chain), and
 * asserts the canonical data changed.  Nothing asserts "a function exists".
 *
 * Covered (§15.4):
 *   unplaced -> left-click place
 *   placed   -> left-click move mode
 *   cell     -> commit move
 *   placed   -> right-click remove (undoable, content untouched)
 *   Escape   -> cancel move
 *   rerender -> interactions still work
 *   hover overlay visible -> the underlying intended action still works
 *   pagination page switch -> interactions still work
 *   save / restart -> placement persists
 * plus the two root causes §15.2 names: re-bound-per-node listeners and
 * `stopPropagation` / `pointer-events` swallowing the delegated handler.
 */

import {
  appendBlock,
  createDocument,
  createEmptyProjectData,
  initializeContentStatuses,
} from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";
import { freeCellsFor } from "../app/authoring.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------ *
 * A DOM stand-in that really bubbles
 * ------------------------------------------------------------------ */

type Listener = (event: any) => void;

interface Registration {
  fn: Listener;
  capture: boolean;
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
}

interface Chain {
  combinator: " " | ">";
  compound: Compound;
}

/** Attribute / tag / class / id only — pseudo classes are not modelled. */
function parseCompound(text: string): Compound {
  const compound: Compound = { tag: null, id: null, classes: [], attrs: [] };
  let rest = text;
  while (rest.length > 0) {
    const tag = /^[a-zA-Z][\w-]*/.exec(rest);
    if (tag && !compound.tag) {
      compound.tag = tag[0].toLowerCase();
      rest = rest.slice(tag[0].length);
      continue;
    }
    const id = /^#[\w-]+/.exec(rest);
    if (id && !compound.id) {
      compound.id = id[0].slice(1);
      rest = rest.slice(id[0].length);
      continue;
    }
    const cls = /^\.[\w-]+/.exec(rest);
    if (cls) {
      compound.classes.push(cls[0].slice(1));
      rest = rest.slice(cls[0].length);
      continue;
    }
    const attr = /^\[[^\]]+\]/.exec(rest);
    if (attr) {
      const body = attr[0].slice(1, -1);
      const eq = body.indexOf("=");
      if (eq < 0) compound.attrs.push({ name: body.trim().toLowerCase(), value: null });
      else {
        compound.attrs.push({
          name: body.slice(0, eq).trim().toLowerCase(),
          value: body.slice(eq + 1).trim().replace(/^['"]|['"]$/g, ""),
        });
      }
      rest = rest.slice(attr[0].length);
      continue;
    }
    throw new Error(`unsupported selector fragment: ${rest}`);
  }
  if (!compound.tag && !compound.id && !compound.classes.length && !compound.attrs.length) {
    throw new Error(`empty selector fragment: ${text}`);
  }
  return compound;
}

const chainCache = new Map<string, Chain[][]>();

/**
 * Splits a selector list on top-level commas, then each selector into compound
 * parts with the combinator that precedes it.  Attribute values may contain
 * commas, spaces and `>`, so this walks the string instead of regexing it.
 */
function parseSelector(selector: string): Chain[][] {
  const cached = chainCache.get(selector);
  if (cached) return cached;
  const groups: string[][] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (const ch of selector) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[") depth += 1;
    if (ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      groups.push(splitCombinators(current));
      current = "";
      continue;
    }
    current += ch;
  }
  groups.push(splitCombinators(current));
  const list = groups.filter((parts) => parts.length > 0).map((parts) => {
    const chain: Chain[] = [];
    let combinator: " " | ">" = " ";
    for (const part of parts) {
      if (part === ">") {
        combinator = ">";
        continue;
      }
      chain.push({
        combinator: chain.length === 0 ? " " : combinator,
        compound: parseCompound(part),
      });
      combinator = " ";
    }
    if (!chain.length) throw new Error(`empty selector: ${selector}`);
    return chain;
  });
  if (!list.length) throw new Error(`empty selector: ${selector}`);
  chainCache.set(selector, list);
  return list;
}

function splitCombinators(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  const push = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[") depth += 1;
    if (ch === "]") depth -= 1;
    if (depth === 0 && ch === ">") {
      push();
      parts.push(">");
      continue;
    }
    // A space is only a descendant combinator marker; `matchChain` treats an
    // unmarked step as a descendant, so whitespace itself is dropped.
    if (depth === 0 && /\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  if (parts[0] === ">") parts.shift();
  return parts;
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

class FakeNode {
  tagName: string;
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  listeners = new Map<string, Registration[]>();
  nodeType = 1;
  value = "";
  checked = false;
  hidden = false;
  disabled = false;
  scrollTop = 0;
  scrollLeft = 0;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selectionDirection = "none";
  focused = 0;
  style: Record<string, string> = {};
  /** Offsets into the html this node was parsed from. */
  source = "";
  start = 0;
  openEnd = 0;
  closeStart = 0;
  closeEnd = 0;
  innerOverride: string | null = null;

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    this.setAttrs(attrs);
  }

  setAttrs(attrs: Record<string, string>) {
    this.attrs = { ...attrs };
    this.dataset = {};
    for (const [name, value] of Object.entries(this.attrs)) {
      if (!name.startsWith("data-")) continue;
      const key = name.slice(5).split("-").map((part, index) =>
        index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
      ).join("");
      this.dataset[key] = value;
    }
    this.value = this.attrs.value ?? this.value;
    this.checked = this.attrs.checked !== undefined ? this.attrs.checked !== "false" : this.checked;
    this.disabled = this.attrs.disabled !== undefined;
    this.hidden = this.attrs.hidden !== undefined;
  }

  get id() {
    return this.attrs.id ?? "";
  }
  get className() {
    return this.attrs.class ?? "";
  }
  get classList() {
    const node = this;
    const list = () => String(node.attrs.class ?? "").split(/\s+/).filter(Boolean);
    const write = (values: string[]) => {
      node.attrs.class = values.join(" ");
    };
    return {
      contains: (name: string) => list().includes(name),
      add: (name: string) => write([...new Set([...list(), name])]),
      remove: (name: string) => write(list().filter((value) => value !== name)),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !list().includes(name);
        write(on ? [...new Set([...list(), name])] : list().filter((value) => value !== name));
        return on;
      },
    };
  }
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  get isConnected() {
    return true;
  }
  get parentElement() {
    return this.parent;
  }

  getAttribute(name: string) {
    const value = this.attrs[name.toLowerCase()];
    return value === undefined ? null : value;
  }
  setAttribute(name: string, value: string) {
    this.setAttrs({ ...this.attrs, [name.toLowerCase()]: String(value) });
  }
  hasAttribute(name: string) {
    return this.attrs[name.toLowerCase()] !== undefined;
  }
  removeAttribute(name: string) {
    const next = { ...this.attrs };
    delete next[name.toLowerCase()];
    this.setAttrs(next);
  }

  get textContent(): string {
    if (this.innerOverride !== null) return stripTags(this.innerOverride);
    return stripTags(this.source.slice(this.openEnd, this.closeStart));
  }
  set textContent(value: string) {
    this.children = [];
    this.innerOverride = value;
  }

  get innerHTML(): string {
    if (this.innerOverride !== null) return this.innerOverride;
    return this.source.slice(this.openEnd, this.closeStart);
  }
  set innerHTML(value: string) {
    const html = String(value ?? "");
    // A real element *replaces* its children; keeping the old ones would make
    // every re-render double the tree and hide stale nodes from the walk.
    for (const child of this.children) child.parent = null;
    this.children = [];
    for (const child of parseHtml(html)) this.adopt(child);
    this.innerOverride = html;
  }

  get outerHTML(): string {
    return this.source.slice(this.sourceStart(), this.closeEnd);
  }
  set outerHTML(value: string) {
    const parsed = parseHtml(String(value ?? ""));
    const parent = this.parent;
    if (!parent) {
      this.innerHTML = String(value ?? "");
      return;
    }
    const index = parent.children.indexOf(this);
    if (index < 0) return;
    parent.children.splice(index, 1, ...parsed);
    for (const node of parsed) node.parent = parent;
    if (parent.innerOverride !== null) parent.innerOverride = null;
  }

  sourceStart() {
    return this.closeStart === 0 && this.openEnd === 0 ? 0 : this.openEnd - 1;
  }

  adopt(child: FakeNode) {
    child.parent = this;
    this.children.push(child);
  }

  addEventListener(type: string, handler: Listener, options?: unknown) {
    const capture = options === true
      ? true
      : Boolean((options as { capture?: boolean } | undefined)?.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn: handler, capture });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, handler: Listener) {
    const list = this.listeners.get(type) ?? [];
    const index = list.findIndex((entry) => entry.fn === handler);
    if (index >= 0) list.splice(index, 1);
  }
  listenerCount(type: string, capture = false) {
    return (this.listeners.get(type) ?? []).filter((entry) => entry.capture === capture).length;
  }

  matches(selector: string) {
    return matchSelector(this, selector);
  }
  closest(selector: string): FakeNode | null {
    let current: FakeNode | null = this;
    while (current) {
      if (matchSelector(current, selector)) return current;
      current = current.parent;
    }
    return null;
  }
  contains(node: FakeNode | null) {
    let current: FakeNode | null = node;
    while (current) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  }
  querySelectorAll(selector: string): FakeNode[] {
    const found: FakeNode[] = [];
    const walk = (node: FakeNode) => {
      for (const child of node.children) {
        if (matchSelector(child, selector)) found.push(child);
        walk(child);
      }
    };
    try {
      walk(this);
    } catch {
      return [];
    }
    return found;
  }
  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  appendChild(child: FakeNode) {
    this.adopt(child);
    return child;
  }
  remove() {
    const parent = this.parent;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parent = null;
  }
  focus() {
    this.focused += 1;
    activeDocument?.setActive(this);
  }
  blur() {
    if (activeDocument?.activeElement === this) activeDocument.setActive(null);
  }
  select() {}
  setSelectionRange(start: number, end: number, direction?: string) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction ?? "none";
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 120, bottom: 90, width: 120, height: 90 };
  }
  scrollIntoView() {}
  click() {
    activeDom?.dispatch(this, "click", { button: 0 });
  }
}

function stripTags(html: string) {
  return decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function matchCompound(node: FakeNode, compound: Compound) {
  if (compound.tag && node.tagName !== compound.tag.toUpperCase()) return false;
  if (compound.id && node.attrs.id !== compound.id) return false;
  const classes = String(node.attrs.class ?? "").split(/\s+/);
  for (const name of compound.classes) if (!classes.includes(name)) return false;
  for (const attr of compound.attrs) {
    const value = node.attrs[attr.name];
    if (value === undefined) return false;
    if (attr.value !== null && value !== attr.value) return false;
  }
  return true;
}

function matchSelector(node: FakeNode, selector: string) {
  let chains: Chain[][];
  try {
    chains = parseSelector(selector);
  } catch {
    return false;
  }
  return chains.some((chain) => matchChain(node, chain));
}

function matchChain(node: FakeNode, chain: Chain[]) {
  if (!matchCompound(node, chain[chain.length - 1]!.compound)) return false;
  let current: FakeNode | null = node;
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    const step = chain[index + 1]!.combinator;
    const parent: FakeNode | null = current?.parent ?? null;
    if (step === ">") {
      if (!parent || !matchCompound(parent, chain[index]!.compound)) return false;
      current = parent;
      continue;
    }
    let ancestor: FakeNode | null = parent;
    let hit: FakeNode | null = null;
    while (ancestor) {
      if (matchCompound(ancestor, chain[index]!.compound)) {
        hit = ancestor;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (!hit) return false;
    current = hit;
  }
  return true;
}

/** A forgiving HTML parser: enough of the markup `views.js` emits to walk it. */
function parseHtml(html: string): FakeNode[] {
  const roots: FakeNode[] = [];
  const stack: FakeNode[] = [];
  const open = (node: FakeNode) => {
    const parent = stack[stack.length - 1];
    if (parent) parent.adopt(node);
    else roots.push(node);
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html[lt + 1] === "/") {
      const gt = html.indexOf(">", lt);
      const name = html.slice(lt + 2, gt < 0 ? html.length : gt).trim().toLowerCase();
      const index = [...stack].reverse().findIndex((node) => node.tagName.toLowerCase() === name);
      if (index >= 0) {
        const depth = stack.length - 1 - index;
        const end = gt < 0 ? html.length : gt + 1;
        for (const node of stack.slice(depth)) {
          node.closeStart = lt;
          node.closeEnd = end;
        }
        stack.length = depth;
      }
      i = gt < 0 ? html.length : gt + 1;
      continue;
    }
    const nameMatch = /^[a-zA-Z][\w-]*/.exec(html.slice(lt + 1));
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const tagName = nameMatch[0].toLowerCase();
    let cursor = lt + 1 + nameMatch[0].length;
    const attrs: Record<string, string> = {};
    let selfClose = false;
    let gt = cursor;
    while (gt < html.length) {
      while (gt < html.length && /\s/.test(html[gt]!)) gt += 1;
      if (gt >= html.length) break;
      if (html[gt] === "/") {
        selfClose = true;
        gt += 1;
        continue;
      }
      if (html[gt] === ">") break;
      let name = "";
      while (gt < html.length && !/[\s=>/]/.test(html[gt]!)) name += html[gt++];
      if (!name) {
        gt += 1;
        continue;
      }
      while (gt < html.length && /\s/.test(html[gt]!)) gt += 1;
      let value = "";
      if (html[gt] === "=") {
        gt += 1;
        while (gt < html.length && /\s/.test(html[gt]!)) gt += 1;
        const quote = html[gt];
        if (quote === '"' || quote === "'") {
          gt += 1;
          const end = html.indexOf(quote, gt);
          value = html.slice(gt, end < 0 ? html.length : end);
          gt = end < 0 ? html.length : end + 1;
        } else {
          const start = gt;
          while (gt < html.length && !/[\s>]/.test(html[gt]!)) gt += 1;
          value = html.slice(start, gt);
        }
      }
      attrs[name.toLowerCase()] = decode(value);
    }
    if (gt >= html.length) gt = html.length - 1;
    cursor = gt + 1;
    const node = new FakeNode(tagName, attrs);
    node.source = html;
    node.openEnd = cursor;
    node.closeStart = cursor;
    node.closeEnd = cursor;
    open(node);
    if (tagName === "script" || tagName === "style") {
      const lower = html.toLowerCase();
      const end = lower.indexOf(`</${tagName}`, cursor);
      const closeTagStart = end < 0 ? html.length : end;
      node.closeStart = closeTagStart;
      node.closeEnd = end < 0 ? html.length : lower.indexOf(">", closeTagStart) + 1;
      i = node.closeEnd;
      continue;
    }
    if (VOID_TAGS.has(tagName) || selfClose) {
      i = cursor;
      continue;
    }
    stack.push(node);
    i = cursor;
  }
  for (const node of stack) {
    node.closeStart = html.length;
    node.closeEnd = html.length;
  }
  return roots;
}

interface TraceEntry {
  type: string;
  target: FakeNode;
  reachedRoot: boolean;
  defaultPrevented: boolean;
  swallowedAt: FakeNode | null;
}

function createDom() {
  const documentNode = new FakeNode("#document");
  const html = new FakeNode("html");
  const body = new FakeNode("body");
  const app = new FakeNode("div", { id: "app" });
  documentNode.adopt(html);
  html.adopt(body);
  body.adopt(app);
  const documentLike = documentNode as any;
  // `focus()` on any node routes through `activeDocument.setActive`, so the
  // stand-in document has to carry it the way a real Document does.
  documentLike.setActive = (node: FakeNode | null) => {
    documentLike.activeElement = node;
  };
  documentLike.activeElement = null;
  documentLike.documentElement = html;
  documentLike.scrollingElement = html;
  documentLike.createElement = (tag: string) => new FakeNode(tag);
  documentLike.querySelector = (selector: string) => {
    if (selector === "#app") return app;
    return documentNode.querySelector(selector);
  };
  documentLike.querySelectorAll = (selector: string) => documentNode.querySelectorAll(selector);

  const trace: TraceEntry[] = [];
  const dom = {
    root: app,
    document: documentLike,
    trace,
    renders: 0,
    html: () => app.innerHTML,
    setActive: (node: FakeNode | null) => {
      documentLike.activeElement = node;
    },
    dispatch(target: FakeNode, type: string, init: Record<string, unknown> = {}) {
      const path: FakeNode[] = [];
      let walker: FakeNode | null = target;
      while (walker) {
        path.push(walker);
        walker = walker.parent;
      }
      const event: any = {
        type,
        target,
        button: 0,
        buttons: type === "pointerdown" ? 1 : 0,
        clientX: 10,
        clientY: 10,
        key: "",
        code: "",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        isComposing: false,
        defaultPrevented: false,
        bubbles: true,
        cancelable: true,
        _stopped: false,
        _immediate: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        stopPropagation() {
          event._stopped = true;
        },
        stopImmediatePropagation() {
          event._stopped = true;
          event._immediate = true;
        },
        ...init,
      };
      const entry: TraceEntry = {
        type,
        target,
        reachedRoot: false,
        defaultPrevented: false,
        swallowedAt: null,
      };
      const run = (node: FakeNode, capture: boolean) => {
        const registrations = (node.listeners.get(type) ?? []).filter(
          (item) => item.capture === capture,
        );
        for (const registration of [...registrations]) {
          event.currentTarget = node;
          registration.fn(event);
          if (event._immediate) return false;
        }
        return true;
      };
      for (const node of [...path].reverse()) {
        if (!run(node, true)) break;
        if (event._stopped && node !== target) {
          entry.swallowedAt = node;
          break;
        }
      }
      if (!event._stopped) {
        for (const node of path) {
          if (node === documentNode) break;
          if (!run(node, false)) break;
          if (event._stopped) {
            entry.swallowedAt = node;
            break;
          }
        }
        // "Reached the root" has to mean the *live* root: a node left over from
        // an earlier render still bubbles inside its own detached subtree, and
        // claiming it reached the document would hide a stale-reference bug.
        if (!event._stopped && path.includes(documentNode)) {
          entry.reachedRoot = true;
          run(documentNode, false);
        }
      }
      entry.defaultPrevented = event.defaultPrevented;
      trace.push(entry);
      return event;
    },
  };
  activeDocument = documentLike;
  activeDom = dom;
  return dom;
}

let activeDocument: any = null;
let activeDom: any = null;

/* ------------------------------------------------------------------ *
 * Boot: the real app, with a fake native bridge
 * ------------------------------------------------------------------ */

interface Harness {
  store: any;
  dom: ReturnType<typeof createDom>;
  projects: Record<string, ProjectData>;
  saved: ProjectData[];
  click: (node: FakeNode) => TraceEvent;
  press: (node: FakeNode) => TraceEvent;
  rightClick: (node: FakeNode) => TraceEvent;
  find: (selector: string) => FakeNode | null;
  all: (selector: string) => FakeNode[];
  render: () => string;
  restore: () => void;
}

type TraceEvent = {
  defaultPrevented: boolean;
  reachedRoot: boolean;
  swallowedAt: FakeNode | null;
};

let importCounter = 0;

function projectFixture(title: string): ProjectData {
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  initializeContentStatuses(data, contentId);
  appendBlock(data, contentId, "paragraph", "第一段正文");
  appendBlock(data, contentId, "paragraph", "第二段正文");
  appendBlock(data, contentId, "paragraph", "第三段正文");
  return data;
}

async function bootGridHarness(
  data: ProjectData,
  options: { gridEditing?: boolean } = {},
): Promise<Harness> {
  const projects: Record<string, ProjectData> = { "/tmp/grid": structuredClone(data) };
  const saved: ProjectData[] = [];
  const bridge: any = {
    projectDir: "/tmp/grid",
    projectDirFromUrl: false,
    isNative: () => true,
    currentProject: () => projects["/tmp/grid"],
    setProjectDir: (value: string) => {
      bridge.projectDir = value;
    },
    restoreProjectDir: () => {},
    selectFolder: async () => null,
    openProject: async () => structuredClone(projects["/tmp/grid"]),
    readProject: async () => structuredClone(projects["/tmp/grid"]),
    readRecoveryJournal: async () => null,
    writeRecoveryJournal: async () => {},
    clearRecoveryJournal: async () => {},
    writeProject: async (project: ProjectData) => {
      projects["/tmp/grid"] = structuredClone(project);
      saved.push(structuredClone(project));
    },
    projectIdentity: async () => projects["/tmp/grid"]?.project.id ?? null,
    saveSession: async () => {},
    loadSession: async () => null,
    listenNativeDrops: async () => () => {},
    closeProject: async () => {},
    command: async () => ({}),
    confirmClose: async () => true,
    readAssetBytes: async () => {
      throw new Error("no assets in this fixture");
    },
  };

  const dom = createDom();
  const runtime = globalThis as typeof globalThis & {
    document?: unknown;
    __TAURI__?: unknown;
    __workbench?: unknown;
    __workbenchReady?: unknown;
    getSelection?: unknown;
    IntersectionObserver?: unknown;
  };
  const previous = {
    document: runtime.document,
    tauri: runtime.__TAURI__,
    workbench: runtime.__workbench,
    ready: runtime.__workbenchReady,
    getSelection: runtime.getSelection,
    fetch: globalThis.fetch,
  };
  runtime.document = dom.document;
  runtime.__TAURI__ = undefined;
  runtime.getSelection = () => ({ toString: () => selectionText });
  globalThis.fetch = async () => {
    throw new Error("test fetch disabled");
  };
  let selectionText = "";
  importCounter += 1;
  await import(`../app/main.js?grid-pointer-${importCounter}`);
  const store = runtime.__workbench as any;
  assert(store, "the running workbench must be reachable as __workbench");
  try {
    await runtime.__workbenchReady;
  } catch { /* the launcher is a fine place to start */ }

  store.bridge = bridge;
  store.data = structuredClone(projects["/tmp/grid"]);
  store.ui.screen = "project";
  store.ui.route = "free-layout";
  store.ui.mode = "writing";
  store.ui.activeId = store.data.content_items[0]?.id ?? null;
  store.ui.gridEditing = options.gridEditing ?? false;
  store.createLayout("grid");

  const harness: Harness = {
    store,
    dom,
    projects,
    saved,
    find: (selector) => dom.root.querySelector(selector),
    all: (selector) => dom.root.querySelectorAll(selector),
    render: () => dom.html(),
    click: (node) => {
      const press = dom.dispatch(node, "pointerdown", { button: 0 });
      const event = dom.dispatch(node, "click", { button: 0, detail: 1 });
      return {
        defaultPrevented: event.defaultPrevented,
        reachedRoot: event._stopped === false,
        swallowedAt: (event as any)._swallowedAt ?? null,
        press,
      } as TraceEvent;
    },
    press: (node) => {
      const event = dom.dispatch(node, "pointerdown", { button: 0 });
      return {
        defaultPrevented: event.defaultPrevented,
        reachedRoot: event._stopped === false,
        swallowedAt: null,
      };
    },
    rightClick: (node) => {
      const event = dom.dispatch(node, "contextmenu", { button: 2 });
      return {
        defaultPrevented: event.defaultPrevented,
        reachedRoot: event._stopped === false,
        swallowedAt: null,
      };
    },
    restore: () => {
      runtime.document = previous.document;
      runtime.__TAURI__ = previous.tauri;
      runtime.__workbench = previous.workbench;
      runtime.__workbenchReady = previous.ready;
      runtime.getSelection = previous.getSelection;
      globalThis.fetch = previous.fetch;
      clearTimeout(store.saveTimer);
      clearTimeout(store.sessionTimer);
    },
  };
  (harness as any).setSelection = (text: string) => {
    selectionText = text;
  };
  store.notify();
  return harness;
}

/** Counts how often one store method runs, to prove a click is dispatched ONCE. */
function spyOn(store: any, method: string): { calls: any[][]; restore: () => void } {
  const original = store[method].bind(store);
  const calls: any[][] = [];
  store[method] = (...args: any[]) => {
    calls.push(args);
    return original(...args);
  };
  return { calls, restore: () => {
    store[method] = original;
  } };
}

function placementNode(dom: ReturnType<typeof createDom>, placementId: string) {
  return dom.root.querySelector(`[data-placement="${placementId}"]`);
}

/* ------------------------------------------------------------------ *
 * §15.3 — one delegated surface, and the per-node listeners it replaces
 * ------------------------------------------------------------------ */

Deno.test("the Grid binds ONE delegated pointer/click/contextmenu surface that survives re-render", async () => {
  const data = projectFixture("委托监听");
  const h = await bootGridHarness(data);
  try {
    const { store, dom } = h;
    const blocks = store.blocks();
    store.placeBlock(blocks[0]!.id);
    store.notify();
    store.notify();
    const html = dom.html();
    assert(html.includes('data-grid-surface="grid"'), "the canvas must declare its surface");
    assert(html.includes('data-grid-surface="unplaced"'), "the strip must declare its surface");
    assert(
      dom.root.listenerCount("pointerdown") === 1,
      "the surface must hold exactly one delegated pointerdown listener",
    );
    assert(
      dom.root.listenerCount("click") === 1,
      "the surface must hold exactly one delegated click listener",
    );
    assert(
      dom.root.listenerCount("contextmenu") === 1,
      "the surface must hold exactly one delegated contextmenu listener",
    );
    // The per-node listeners this architecture replaces must be gone, or every
    // grid gesture would be dispatched twice — once per node, once delegated.
    const node = placementNode(dom, store.data.placements[0]!.id);
    assert(node, "the placed block must be in the rendered markup");
    assert(
      (node!.listeners.get("click") ?? []).length === 0,
      "a placement must carry no per-node click listener of its own",
    );
    assert(
      (node!.listeners.get("contextmenu") ?? []).length === 0,
      "a placement must carry no per-node contextmenu listener of its own",
    );
  } finally {
    h.restore();
  }
});

/* ------------------------------------------------------------------ *
 * §15.4 unplaced -> left-click place
 * ------------------------------------------------------------------ */

Deno.test("left click on an unplaced block puts it into the first valid cell — exactly once", async () => {
  const data = projectFixture("上格");
  const h = await bootGridHarness(data);
  try {
    const { store } = h;
    const blocks = store.blocks();
    const place = h.find('[data-action="place-block"]');
    assert(place, "the strip must offer the unplaced block");
    assert(place!.dataset.id === blocks[0]!.id, "the first strip button names the first unplaced block");
    const spy = spyOn(store, "placeBlock");
    const event = h.click(place!);
    assert(event.reachedRoot, "nothing may swallow the strip click before the delegated surface");
    assert(store.data.placements.length === 1, "the block must be on the canvas");
    assert(
      store.data.placements[0]!.block_id === place!.dataset.id,
      "the click must place exactly the block its own button names",
    );
    assert(spy.calls.length === 1, "the place action must be dispatched exactly once");
    const placement = store.data.placements[0]!;
    const grid = store.data.layout_instances[0]!.grid_definition;
    const expected = freeCellsFor(grid, [], {
      rowSpan: placement.row_end - placement.row_start,
      columnSpan: placement.column_end - placement.column_start,
      exceptId: placement.id,
    })[0]!;
    assert(
      placement.row_start === expected.row && placement.column_start === expected.column,
      "the drop must land on the first valid cell the grid offers",
    );
    spy.restore();
  } finally {
    h.restore();
  }
});

/* ------------------------------------------------------------------ *
 * §15.4 placed -> left-click move mode, cell -> commit
 * ------------------------------------------------------------------ */

Deno.test("left click on a placed block enters move state; clicking a highlighted cell commits it", async () => {
  const data = projectFixture("移动");
  const h = await bootGridHarness(data);
  try {
    const { store, dom } = h;
    const blocks = store.blocks();
    store.placeBlock(blocks[0]!.id);
    const placement = store.data.placements[0]!;
    const node = placementNode(dom, placement.id)!;
    const startSpy = spyOn(store, "startMovePlacement");
    const event = h.click(node);
    assert(event.reachedRoot, "the block click must reach the delegated surface");
    assert(store.ui.movingPlacementId === placement.id, "left click must enter the move state");
    assert(startSpy.calls.length === 1, "the move command must be dispatched exactly once");
    assert(
      store.data.placements[0]!.row_start === placement.row_start,
      "entering move state must not move anything yet",
    );
    startSpy.restore();

    // The re-render for the move state must produce the cell buttons.
    const targets = h.all('[data-action="grid-move-to"]').filter(
      (cell) => cell.dataset.current !== "true",
    );
    assert(targets.length > 0, "the move state must show where the block can go");
    const target = targets.at(-1)!;
    // What the screen is told, not just what the model ends up with: the store
    // renders inside `commit`, so a move state cleared afterwards still drew the
    // "正在移动" banner and its 「放这里」 cells, and a click on a leftover cell moved
    // the block a second time.
    const renderedMoveState: unknown[] = [];
    store.subscribe((kind: string) => {
      if (kind !== "chrome") renderedMoveState.push(store.ui.movingPlacementId);
    });
    const moveSpy = spyOn(store, "movePlacementTo");
    h.click(target);
    assert(moveSpy.calls.length === 1, "a cell click must commit exactly once");
    const moved = store.data.placements.find((candidate: { id: string }) =>
      candidate.id === placement.id
    )!;
    assert(
      moved.row_start === Number(target.dataset.row) &&
        moved.column_start === Number(target.dataset.col),
      "the committed cell must be the one that was clicked",
    );
    assert(store.ui.movingPlacementId === null, "a committed move leaves the move state");
    assert(
      renderedMoveState.length > 0 && renderedMoveState.at(-1) === null,
      `the render that draws the moved block must already be out of the move state: ${
        JSON.stringify(renderedMoveState)
      }`,
    );
    moveSpy.restore();
  } finally {
    h.restore();
  }
});

Deno.test("the current cell is not a disabled button and commits nothing", async () => {
  const data = projectFixture("当前格");
  const h = await bootGridHarness(data);
  try {
    const { store } = h;
    const blocks = store.blocks();
    store.placeBlock(blocks[0]!.id);
    const placement = store.data.placements[0]!;
    store.startMovePlacement(placement.id);
    const current = h.all('[data-action="grid-move-to"]').find(
      (cell) => cell.dataset.current === "true",
    );
    assert(current, "the cell the block already occupies must be marked as current");
    assert(
      !current!.hasAttribute("disabled"),
      "a disabled control swallows the pointer, so the current cell must not be one",
    );
    assert(
      current!.getAttribute("aria-disabled") === "true",
      "the current cell still has to say it is unusable",
    );
    const before = { ...store.data.placements.find((c: { id: string }) => c.id === placement.id)! };
    const spy = spyOn(store, "movePlacementTo");
    h.click(current!);
    assert(spy.calls.length === 0, "clicking the current cell must not commit a move");
    spy.restore();
    const after = store.data.placements.find((c: { id: string }) => c.id === placement.id)!;
    assert(
      after.row_start === before.row_start && after.column_start === before.column_start,
      "the current cell must leave the placement exactly where it was",
    );
  } finally {
    h.restore();
  }
});

/* ------------------------------------------------------------------ *
 * §15.4 placed -> right-click remove
 * ------------------------------------------------------------------ */

Deno.test("right click on a placed block removes it from the Grid, undoably, and touches no content", async () => {
  const data = projectFixture("右键移出");
  const h = await bootGridHarness(data);
  try {
    const { store, dom } = h;
    const blocks = store.blocks();
    store.placeBlock(blocks[0]!.id);
    const placement = store.data.placements[0]!;
    const blockId = placement.block_id;
    const textBefore = String(store.data.blocks.find((b: { id: string }) => b.id === blockId)?.content ?? "");
    const node = placementNode(dom, placement.id)!;
    const event = h.rightClick(node);
    assert(event.defaultPrevented, "the Grid must claim the right click so the browser menu stays away");
    assert(event.reachedRoot, "nothing may swallow the contextmenu before the delegated surface");
    assert(
      store.data.placements.length === 0,
      "right click must take the block off the canvas",
    );
    assert(
      store.data.blocks.length === blocks.length,
      "移出网格 must never delete the content block",
    );
    assert(
      String(store.data.blocks.find((b: { id: string }) => b.id === blockId)?.content) === textBefore,
      "the block's text must be untouched by a right click",
    );
    assert(
      store.data.blocks.some((block: { id: string }) => block.id === blockId),
      "the block must return to the unplaced content",
    );
    assert(
      h.find('[data-stop-click="true"]') === null,
      "the removal is undoable, so no confirmation dialog may appear",
    );
    assert(/移出网格/.test(String(store.ui.toast)), "the toast must name what happened");
    store.undo();
    const restored = store.data.placements.find((c: { block_id: string }) => c.block_id === blockId);
    assert(restored, "one Ctrl+Z must put the block back on the Grid");
    assert(
      restored!.row_start === placement.row_start && restored!.column_start === placement.column_start,
      "undo must restore the same cell, not a re-placed guess",
    );
  } finally {
    h.restore();
  }
});

/* ------------------------------------------------------------------ *
 * §15.4 Escape -> cancel
 * ------------------------------------------------------------------ */

Deno.test("Escape cancels the armed move without changing the placement", async () => {
  const data = projectFixture("取消");
  const h = await bootGridHarness(data);
  try {
    const { store, dom } = h;
    const blocks = store.blocks();
    store.placeBlock(blocks[0]!.id);
    const placement = store.data.placements[0]!;
    h.click(placementNode(dom, placement.id)!);
    assert(store.ui.movingPlacementId === placement.id, "the click must arm the move");
    dom.dispatch(dom.document, "keydown", { key: "Escape" });
    assert(store.ui.movingPlacementId === null, "Escape must leave the move state");
    const still = store.data.placements.find((c: { id: string }) => c.id === placement.id)!;
    assert(
      still.row_start === placement.row_start && still.column_start === placement.column_start,
      "cancelling must not move the block",
    );
    assert(store.data.placements.length === 1, "cancelling must not remove the block either");
  } finally {
    h.restore();
  }
});

Deno.test("clicking the canvas itself while a move is armed cancels it instead of stranding the user", async () => {
  const data = projectFixture("点空白");
  const h = await bootGridHarness(data);
  try {
    const { store, dom } = h;
    const blocks = store.blocks();
    store.placeBlock(blocks[0]!.id);
    const placement = store.data.placements[0]!;
    h.click(placementNode(dom, placement.id)!);
    // Re-query after the render the arming click caused: the canvas the user
    // presses is the one currently in the document.
    const canvas = h.find('[data-grid-surface="grid"]')!;
    // A real browser hit-tests a click on the empty canvas area to the canvas
    // itself; the delegated surface must treat that as "put it back".
    dom.dispatch(canvas, "click", { button: 0 });
    assert(!store.ui.movingPlacementId, "an empty-canvas click must end the move state");
    assert(store.data.placements.length === 1, "and it must not remove the block");
  } finally {
    h.restore();
  }
});

Deno.test("a text-selection drag inside a block is not read as a move command", async () => {
  const data = projectFixture("选字");
  const h = await bootGridHarness(data);
  try {
    const { store, dom } = h;
    const blocks = store.blocks();
    store.placeBlock(blocks[0]!.id);
    const placement = store.data.placements[0]!;
    const node = placementNode(dom, placement.id)!;
    const setSelection = (h as any).setSelection as (text: string) => void;
    setSelection("");
    dom.dispatch(node, "pointerdown", { button: 0 });
    setSelection("第一段");
    dom.dispatch(node, "click", { button: 0 });
    assert(
      !store.ui.movingPlacementId,
      "selecting text must not silently arm a move",
    );
    setSelection("");
    h.click(node);
    assert(store.ui.movingPlacementId === placement.id, "a real click still arms the move");
  } finally {
    h.restore();
  }
});

/* ------------------------------------------------------------------ *
 * §15.4 hover overlay
 * ------------------------------------------------------------------ */

Deno.test("the hover overlay keeps its own controls working and never blocks the block beneath it", async () => {
  const data = projectFixture("浮层");
  const h = await bootGridHarness(data);
  try {
    const { store, dom } = h;
    const blocks = store.blocks();
    store.placeBlock(blocks[0]!.id);
    const placement = store.data.placements[0]!;
    // `#app` is rebuilt on every notify: a node read from the previous render is
    // detached from `#app` even though its own parent chain still looks intact,
    // so every press re-reads the live node.
    const overlayIn = (id: string) =>
      placementNode(dom, id)!.querySelector(".placement-actions")!;
    const buttonIn = (id: string, action: string) =>
      overlayIn(id).querySelector(`[data-action="${action}"]`)!;

    assert(overlayIn(placement.id), "the hover overlay markup must be present");
    assert(
      (overlayIn(placement.id).listeners.get("click") ?? []).length === 0 &&
        (overlayIn(placement.id).listeners.get("contextmenu") ?? []).length === 0,
      "the overlay must hold no listener that could stop propagation",
    );
    assert(
      !overlayIn(placement.id).hasAttribute("data-stop-click"),
      "the overlay must not claim the click as a dialog",
    );

    // A click that lands on the overlay's own padding must still reach the
    // block it sits on — the identity contract resolves upward, exactly as the
    // `pointer-events: none` container lets a real browser hit-test through it.
    const startSpy = spyOn(store, "startMovePlacement");
    const gapClick = h.click(overlayIn(placement.id));
    assert(gapClick.reachedRoot, "the overlay gap must be part of the live tree");
    assert(startSpy.calls.length === 1, "the overlay gap must not eat the block click");
    assert(store.ui.movingPlacementId === placement.id, "the block must enter move state");
    startSpy.restore();
    store.cancelMovePlacement();

    // The overlay's buttons keep their own, single-dispatch behaviour.
    assert(buttonIn(placement.id, "unplace-block"), "the overlay must expose 移出");
    h.click(buttonIn(placement.id, "unplace-block"));
    assert(store.data.placements.length === 0, "the overlay 移出 button must still work");
    assert(store.data.blocks.length === blocks.length, "and must still keep the content");

    // 编辑 leaves the Grid for the writing view, so it is proven on its own
    // placement, last.
    store.placeBlock(blocks[1]!.id);
    const again = store.data.placements[0]!;
    const selectSpy = spyOn(store, "selectBlock");
    const editClick = h.click(buttonIn(again.id, "select-block"));
    assert(editClick.reachedRoot, "the overlay button must be part of the live tree");
    assert(selectSpy.calls.length === 1, "an overlay button must dispatch once, not twice");
    selectSpy.restore();
  } finally {
    h.restore();
  }
});

Deno.test("the overlay's pointer-events are declared once, on the buttons only", async () => {
  const css = await Deno.readTextFile(new URL("../app/styles.css", import.meta.url));
  const block = /\/\* Item 14[\s\S]*?\n\.placement-actions button \{[^}]*\}/.exec(css)?.[0] ?? "";
  assert(block.length > 0, "the Item 14 pointer-events block must exist in styles.css");
  const containerRules = [...css.matchAll(/\.placement-actions\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert(containerRules.length >= 1, "the overlay container must be styled");
  for (const rule of containerRules) {
    if (/\.placement-actions\s+button/.test(rule)) continue;
    assert(
      !rule.includes("pointer-events: auto"),
      `the overlay container must never take the pointer: ${rule}`,
    );
  }
  assert(
    /\.placement-actions\s*\{[^}]*pointer-events: none/.test(css),
    "the overlay container must declare pointer-events: none",
  );
  assert(
    /\.placement-actions button \{[^}]*pointer-events: auto/.test(css),
    "the overlay buttons must be the only part that takes the pointer",
  );
  assert(
    /\.grid-cell-target\.current[^{]*\{[^}]*pointer-events: none/.test(css),
    "the current move-target cell must let the pointer fall through to the block",
  );
  assert(
    !/\.placement(\.selected)?[^{]*\.placement-actions\s*\{[^}]*pointer-events:\s*auto/.test(css),
    "no reveal rule may hand the pointer back to the overlay container",
  );
});

/* ------------------------------------------------------------------ *
 * §15.4 rerender + page switch
 * ------------------------------------------------------------------ */

Deno.test("a re-render that replaces every grid node keeps every gesture alive", async () => {
  const data = projectFixture("重渲染");
  const h = await bootGridHarness(data);
  try {
    const { store, dom } = h;
    const blocks = store.blocks();
    store.placeBlock(blocks[0]!.id);
    for (const _round of [0, 1, 2]) {
      const placement = store.data.placements[0]!;
      const node = placementNode(dom, placement.id);
      assert(node, "the placement must be re-rendered, not left dangling");
      h.click(node!);
      assert(
        store.ui.movingPlacementId === placement.id,
        "the click must still arm the move after a rebuild",
      );
      const target = h.all('[data-action="grid-move-to"]').find(
        (cell) => cell.dataset.current !== "true",
      )!;
      h.click(target!);
      store.cancelMovePlacement();
      store.notify();
    }
    const moved = store.data.placements[0]!;
    h.rightClick(placementNode(dom, moved.id)!);
    assert(store.data.placements.length === 0, "the right click still removes after 3 rebuilds");
    assert(
      dom.root.listenerCount("click") === 1,
      "rebuilds must not accumulate delegated listeners on the surface",
    );
  } finally {
    h.restore();
  }
});

Deno.test("a pagination page switch keeps the gestures and honours the read-only canvas", async () => {
  const data = projectFixture("分页");
  const h = await bootGridHarness(data);
  try {
    const { store } = h;
    const blocks = store.blocks();
    store.placeBlock(blocks[0]!.id);
    const firstPlacement = store.data.placements[0]!;
    store.confirmPaginationConversion();
    store.addLayoutPage();
    const pages = store.layoutPages();
    assert(pages.length >= 2, "the fixture must have two pages to switch between");

    // View mode: the canvas is read-only, so a left click must NOT arm a move
    // and a right click must NOT remove anything.  Adding a page moves the view
    // to it, so go back to the page that actually holds the block.
    store.selectLayoutPage(pages[0]!.id);
    store.ui.paginationEditing = false;
    store.notify();
    const readonly = placementNode(h.dom, firstPlacement.id)!;
    assert(readonly, "the placed block must be on the page being viewed");
    assert(
      readonly.dataset.pageReadonly === "true",
      "the read-only canvas must say so in the markup",
    );
    h.click(readonly);
    assert(!store.ui.movingPlacementId, "a read-only page must not enter move state");
    const right = h.rightClick(readonly);
    assert(!right.defaultPrevented, "a read-only page must not even claim the right click");
    assert(store.data.placements.length === 1, "and must not remove the block");

    // Editing mode through the real control, then switch pages through the real
    // tab button: both are grid-surface clicks, so the delegated path must work
    // on the freshly rebuilt canvas without any re-binding.
    const toggle = h.find('[data-action="toggle-pagination-edit"]');
    assert(toggle, "the pagination edit control must be rendered");
    h.click(toggle!);
    assert(store.ui.paginationEditing === true, "the control must switch into editing mode");
    const live = placementNode(h.dom, firstPlacement.id)!;
    h.click(live!);
    assert(store.ui.movingPlacementId === firstPlacement.id, "editing mode must arm the move");
    store.cancelMovePlacement();

    const second = pages[1]!;
    const tab = h.find(`[data-action="select-layout-page"][data-id="${second.id}"]`);
    assert(tab, "the page tab must be reachable");
    h.click(tab!);
    assert(store.ui.layoutPageId === second.id, "the page must really switch");
    const otherBlocks = store.blocks();
    const place = h.find('[data-action="place-block"]');
    assert(place, "the new page must still offer the unplaced strip");
    h.click(place!);
    assert(
      store.data.placements.length === 2,
      "placing on the switched page must work through the same surface",
    );
    const placed = store.data.placements.at(-1)!;
    assert(placed.page_id === second.id, "the block must land on the page being viewed");
    h.rightClick(placementNode(h.dom, placed.id)!);
    assert(store.data.placements.length === 1, "and the right click must still remove it");
  } finally {
    h.restore();
  }
});

/* ------------------------------------------------------------------ *
 * §15.4 save / restart
 * ------------------------------------------------------------------ */

Deno.test("the grid arranged by clicks is what gets saved and reopens unchanged", async () => {
  const data = projectFixture("重启");
  const h = await bootGridHarness(data);
  try {
    const { store, dom } = h;
    const blocks = store.blocks();
    store.placeBlock(blocks[0]!.id);
    const placement = store.data.placements[0]!;
    h.click(placementNode(dom, placement.id)!);
    const target = h.all('[data-action="grid-move-to"]').find(
      (cell) => cell.dataset.current !== "true",
    )!;
    h.click(target!);
    const moved = store.data.placements.find((c: { id: string }) => c.id === placement.id)!;
    await store.flush();
    assert(h.saved.length >= 1, "the arranged grid must reach the bridge");
    const onDisk = h.saved.at(-1)!;
    const savedPlacement = onDisk.placements.find((c) => c.id === placement.id)!;
    assert(
      savedPlacement.row_start === moved.row_start &&
        savedPlacement.column_start === moved.column_start,
      "the saved file must carry the clicked position",
    );

    // Restart: a brand new app instance boots from what the bridge wrote, and
    // the very first click on the restored block must already work.
    const reloaded = structuredClone(onDisk);
    h.restore();
    const fresh = await bootGridHarness(reloaded);
    try {
      const restoredPlacement = fresh.store.data.placements[0]!;
      assert(
        restoredPlacement.row_start === moved.row_start &&
          restoredPlacement.column_start === moved.column_start,
        "the placement must survive the restart",
      );
      fresh.click(placementNode(fresh.dom, restoredPlacement.id)!);
      assert(
        fresh.store.ui.movingPlacementId === restoredPlacement.id,
        "a restarted Grid must be clickable without any extra wiring",
      );
      fresh.rightClick(placementNode(fresh.dom, restoredPlacement.id)!);
      assert(fresh.store.data.placements.length === 0, "the right click works after a restart");
    } finally {
      fresh.restore();
    }
  } finally {
    // The second harness restores the shared globals; the first is already gone.
  }
});
