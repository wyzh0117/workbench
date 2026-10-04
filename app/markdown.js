import { marked, Renderer } from "./vendor/marked-18.0.7.esm.js";

const HTML_ESCAPE = /[&<>"']/g;
const HTML_ESCAPE_VALUES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** @typedef {"heading"|"paragraph"|"quote"|"list"|"code"|"divider"|"table"|"html"|"other"} MarkdownBlockType */

/**
 * @typedef {object} MarkdownBlock
 * @property {MarkdownBlockType} type
 * @property {string} raw
 * @property {string} text
 * @property {number|null} level
 * @property {string|null} language
 * @property {boolean|null} checked
 * @property {Array<{href:string,title:string|null,alt:string|null,tokenIndex:number,occurrence:number}>} imageRefs
 */

/** @typedef {Record<string, any>} MarkdownToken */
/** @typedef {{type:"text",text:string}|{type:"strong"|"em"|"del",children:MarkdownInlineNode[]}|{type:"code",text:string}|{type:"break"}|{type:"link",href:string,title:string|null,children:MarkdownInlineNode[]}|{type:"image",asset_id:string|null,alt:string,title:string|null}} MarkdownInlineNode */
/** @typedef {{type:"paragraph"|"callout",children:MarkdownInlineNode[]}|{type:"heading",level:number,children:MarkdownInlineNode[]}|{type:"quote",children:MarkdownSemanticBlock[]}|{type:"list",ordered:boolean,start:number,items:Array<{checked:boolean|null,children:MarkdownSemanticBlock[]}>}|{type:"code",text:string,language:string|null}|{type:"divider"}|{type:"table",align:Array<string|null>,header:MarkdownInlineNode[][],rows:MarkdownInlineNode[][][]}} MarkdownSemanticBlock */

const MARKED_OPTIONS = {
  async: false,
  breaks: false,
  gfm: true,
  pedantic: false,
  silent: false,
};

export function escapeHtml(value) {
  return String(value ?? "").replace(HTML_ESCAPE, (character) =>
    HTML_ESCAPE_VALUES[character]
  );
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function isLocalMarkdownImageHref(href) {
  const value = String(href ?? "").trim();
  if (!value || value.startsWith("#") || value.startsWith("//")) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return false;
  return !/[\u0000-\u001f\u007f]/.test(value);
}

function safeLinkHref(href) {
  const value = String(href ?? "").trim();
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (/^(?:https?:|mailto:)/i.test(value)) {
    try {
      const url = new URL(value);
      return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : null;
    } catch {
      return null;
    }
  }
  // Relative links stay inert in the app renderer; they remain editable source
  // data, and a caller may handle them through an authorized project reader.
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? null : value;
}

function isSafeResolvedImageUrl(value) {
  const url = String(value ?? "").trim();
  if (!url || /[\u0000-\u0020\u007f]/.test(url)) return false;
  if (url.startsWith("blob:")) return true;
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(url)) return true;
  // Export adapters may resolve an already-authorized project asset to a
  // relative output path. Absolute/parent traversal URLs are never accepted.
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("/") || url.includes("\\")) {
    return false;
  }
  return url.split(/[?#]/, 1)[0].split("/").every((part) => part && part !== "." && part !== "..");
}

function imagePlaceholder(href, alt, title, details = {}) {
  const label = alt || title || "图片";
  const pendingKey = details.pendingKey ? ` data-asset-preview-key="${escapeAttribute(details.pendingKey)}"` : "";
  const error = details.error ? ` · ${escapeHtml(details.error)}` : "";
  const state = details.error ? "markdown-image-error" : "markdown-image-placeholder";
  return `<span class="${state}" role="img" aria-label="${escapeAttribute(label)}" data-markdown-image-href="${escapeAttribute(href)}"${title ? ` data-markdown-image-title="${escapeAttribute(title)}"` : ""}${pendingKey}>${escapeHtml(label)}${error}</span>`;
}

function rendererFor(options = {}) {
  const resolveImage = typeof options.resolveImage === "function"
    ? options.resolveImage
    : null;
  const blockIndex = Number.isInteger(options.blockIndex) ? options.blockIndex : 0;
  const occurrences = new Map();
  let tokenIndex = 0;
  const renderer = new Renderer();
  renderer.html = function ({ text }) {
      // Marked deliberately does not sanitize HTML. Raw HTML is inert text here.
      return escapeHtml(text);
    };
  renderer.link = function ({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const safeHref = safeLinkHref(href);
      if (!safeHref) return label;
      const data = ` data-markdown-href="${escapeAttribute(safeHref)}"${title ? ` data-markdown-title="${escapeAttribute(title)}"` : ""}`;
      if (/^(?:https?:|mailto:)/i.test(safeHref)) {
        return `<a href="${escapeAttribute(safeHref)}"${title ? ` title="${escapeAttribute(title)}"` : ""} rel="noopener noreferrer"${data}>${label}</a>`;
      }
      return `<span class="markdown-inert-link"${data}>${label}</span>`;
    };
  renderer.image = function ({ href, title, text }) {
      const index = tokenIndex++;
      const occurrence = occurrences.get(href) || 0;
      occurrences.set(href, occurrence + 1);
      if (!isLocalMarkdownImageHref(href) || !resolveImage) {
        return imagePlaceholder(href, text, title);
      }
      let resolved = null;
      try {
        resolved = resolveImage(href, {
          blockIndex,
          tokenIndex: index,
          occurrence,
          alt: text || null,
          title: title || null,
        });
      } catch {
        resolved = null;
      }
      const imageState = typeof resolved === "string"
        ? { url: resolved }
        : resolved && typeof resolved === "object" ? resolved : {};
      if (!isSafeResolvedImageUrl(imageState.url)) {
        return imagePlaceholder(href, text, title, imageState);
      }
      return `<img src="${escapeAttribute(imageState.url)}" alt="${escapeAttribute(text)}" data-markdown-image-href="${escapeAttribute(href)}"${title ? ` title="${escapeAttribute(title)}" data-markdown-image-title="${escapeAttribute(title)}"` : ""} loading="lazy" />`;
    };
  return renderer;
}

/**
 * Parse and render CommonMark plus the GFM extensions built into Marked.
 * User HTML is escaped, links are protocol checked, and images require a
 * caller-supplied resolver so Markdown cannot read arbitrary local or remote files.
 * @param {string} source
 * @param {{resolveImage?: (href:string, metadata:{blockIndex:number,tokenIndex:number,occurrence:number,alt:string|null,title:string|null}) => string|null|{url?:string|null,pendingKey?:string|null,error?:string|null}, blockIndex?:number, inlineOnly?:boolean}} [options]
 */
export function renderMarkdown(source, options = {}) {
  const text = String(source ?? "");
  const renderer = rendererFor(options);
  if (options.inlineOnly) {
    return /** @type {string} */ (marked.parseInline(text, {
      ...MARKED_OPTIONS,
      renderer,
    }));
  }
  return /** @type {string} */ (marked.parse(text, {
    ...MARKED_OPTIONS,
    renderer,
  }));
}

/**
 * Parse Markdown once into a safe, serializable semantic tree for publication.
 * Images can only reference assets explicitly resolved by the caller; raw HTML
 * is inert text, and links are kept only when their protocol is safe.
 * @param {string} source
 * @param {{blockType?:string,headingLevel?:number,blockIndex?:number,resolveImage?: (href:string, metadata:{blockIndex:number,tokenIndex:number,occurrence:number,alt:string|null,title:string|null}) => {asset_id?:string|null}|null}} [options]
 * @returns {MarkdownSemanticBlock[]}
 */
export function markdownSemantics(source, options = {}) {
  const text = String(source ?? "");
  const blockType = String(options.blockType ?? "");
  const blockIndex = Number.isInteger(options.blockIndex) ? options.blockIndex : 0;
  let tokenIndex = 0;
  const occurrences = new Map();
  const inline = (tokens) => (Array.isArray(tokens) ? tokens : []).flatMap((token) => {
    if (!token || typeof token !== "object") return [];
    const children = () => inline(token.tokens);
    switch (token.type) {
      case "text":
      case "escape":
      case "html":
        return token.tokens?.length
          ? children()
          : [{ type: "text", text: String(token.text ?? token.raw ?? "") }];
      case "strong":
      case "em":
      case "del":
        return [{ type: token.type, children: children() }];
      case "codespan":
        return [{ type: "code", text: String(token.text ?? "") }];
      case "br":
        return [{ type: "break" }];
      case "link": {
        const href = safeLinkHref(token.href);
        return href
          ? [{ type: "link", href, title: token.title == null ? null : String(token.title), children: children() }]
          : children();
      }
      case "image": {
        const href = String(token.href ?? "");
        const index = tokenIndex++;
        const occurrence = occurrences.get(href) || 0;
        occurrences.set(href, occurrence + 1);
        const alt = String(token.text ?? "");
        const title = token.title == null ? null : String(token.title);
        let resolved = null;
        if (isLocalMarkdownImageHref(href) && typeof options.resolveImage === "function") {
          try {
            resolved = options.resolveImage(href, { blockIndex, tokenIndex: index, occurrence, alt: alt || null, title });
          } catch { resolved = null; }
        }
        const assetId = typeof resolved?.asset_id === "string" && resolved.asset_id.trim()
          ? resolved.asset_id.trim()
          : null;
        return [{ type: "image", asset_id: assetId, alt, title }];
      }
      default:
        return token.text != null
          ? [{ type: "text", text: String(token.text) }]
          : children();
    }
  });
  const blocks = (tokens) => (Array.isArray(tokens) ? tokens : []).flatMap((token) => {
    if (!token || typeof token !== "object" || ["space", "def"].includes(token.type)) return [];
    switch (token.type) {
      case "heading":
        return [{ type: "heading", level: Math.max(1, Math.min(6, Number(token.depth) || 1)), children: inline(token.tokens) }];
      case "paragraph":
        return [{ type: "paragraph", children: inline(token.tokens) }];
      case "blockquote":
        return [{ type: "quote", children: blocks(token.tokens) }];
      case "list":
        return [{
          type: "list",
          ordered: Boolean(token.ordered),
          start: Math.max(1, Number(token.start) || 1),
          items: (token.items || []).map((item) => ({
            checked: item.task ? Boolean(item.checked) : null,
            children: blocks(item.tokens),
          })),
        }];
      case "code":
        return [{ type: "code", text: String(token.text ?? ""), language: String(token.lang ?? "").trim().split(/[\s,]/, 1)[0] || null }];
      case "hr":
        return [{ type: "divider" }];
      case "table":
        return [{
          type: "table",
          align: (token.align || []).map((value) => value == null ? null : String(value)),
          header: (token.header || []).map((cell) => inline(cell.tokens)),
          rows: (token.rows || []).map((row) => row.map((cell) => inline(cell.tokens))),
        }];
      case "html":
      case "tag":
        return [{ type: "paragraph", children: [{ type: "text", text: String(token.text ?? token.raw ?? "") }] }];
      default:
        return [{ type: "paragraph", children: inline(token.tokens ?? [{ type: "text", text: String(token.text ?? token.raw ?? "") }]) }];
    }
  });
  if (blockType === "code") return [{ type: "code", text, language: null }];
  if (blockType === "divider") return [{ type: "divider" }];
  if (blockType === "heading") {
    const parsed = blocks(marked.lexer(text, { ...MARKED_OPTIONS }));
    const children = parsed.flatMap((block) => block.type === "heading" || block.type === "paragraph" ? block.children : []);
    return [{ type: "heading", level: Math.max(1, Math.min(6, Number(options.headingLevel) || 2)), children }];
  }
  const parsed = blocks(marked.lexer(text, { ...MARKED_OPTIONS }));
  if (blockType === "quote") return [{ type: "quote", children: parsed }];
  if (blockType === "callout") return [{ type: "callout", children: parsed.flatMap((block) => block.type === "paragraph" ? block.children : block.type === "heading" ? block.children : []) }];
  return parsed;
}

function collectImageTokens(token, result) {
  if (!token || typeof token !== "object") return;
  if (token.type === "image") {
    result.push(token);
    return;
  }
  for (const [key, value] of Object.entries(token)) {
    if (["raw", "text", "href", "title"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) collectImageTokens(child, result);
    } else if (value && typeof value === "object") {
      collectImageTokens(value, result);
    }
  }
}

function normalizedBlock(token) {
  /** @type {MarkdownBlockType} */
  let type = "other";
  let text = String(token.raw ?? "");
  let level = null;
  let language = null;
  let checked = null;
  switch (token.type) {
    case "heading":
      type = "heading";
      text = String(token.text ?? "");
      level = Number(token.depth) || 1;
      break;
    case "paragraph":
      type = "paragraph";
      text = String(token.text ?? "");
      break;
    case "blockquote":
      type = "quote";
      text = String(token.text ?? "");
      break;
    case "list":
      type = "list";
      text = String(token.raw ?? "");
      checked = token.items?.some((item) => item.task) ? Boolean(token.items?.some((item) => item.checked)) : null;
      break;
    case "code":
      type = "code";
      text = String(token.text ?? "");
      language = String(token.lang ?? "").trim().split(/[\s,]/, 1)[0] || null;
      break;
    case "hr":
      type = "divider";
      text = "";
      break;
    case "table":
      type = "table";
      text = String(token.raw ?? "");
      break;
    case "html":
    case "tag":
      type = "html";
      text = String(token.text ?? token.raw ?? "");
      break;
    case "space":
    case "def":
      return null;
    default:
      type = "other";
      text = String(token.raw ?? token.text ?? "");
  }
  return {
    type,
    raw: String(token.raw ?? text),
    text,
    level,
    language,
    checked,
    imageRefs: [],
  };
}

/**
 * Return stable, serializable top-level block semantics and explicit local
 * image dependencies. This function never reads or rewrites source files.
 * @param {string} source
 */
export function parseMarkdown(source) {
  const text = String(source ?? "");
  /** @type {MarkdownToken[]} */
  const tokens = marked.lexer(text, { ...MARKED_OPTIONS });
  /** @type {MarkdownBlock[]} */
  const blocks = [];
  /** @type {Array<{href:string,title:string|null,alt:string|null,tokenIndex:number,occurrence:number,blockIndex:number}>} */
  const imageRefs = [];
  /** @type {Array<{href:string,title:string|null,alt:string|null,tokenIndex:number,occurrence:number,blockIndex:number}>} */
  const explicitLocalImageRefs = [];
  /** @type {string[]} */
  const warnings = [];
  const occurrences = new Map();
  let tokenIndex = 0;

  for (const token of tokens) {
    const block = normalizedBlock(token);
    if (!block) continue;
    const blockIndex = blocks.length;
    const images = [];
    collectImageTokens(token, images);
    for (const image of images) {
      const currentTokenIndex = tokenIndex++;
      const href = String(image.href ?? "");
      const occurrence = occurrences.get(href) || 0;
      occurrences.set(href, occurrence + 1);
      const ref = {
        href,
        title: image.title == null ? null : String(image.title),
        alt: image.text == null ? null : String(image.text),
        tokenIndex: currentTokenIndex,
        occurrence,
        blockIndex,
      };
      imageRefs.push(ref);
      if (!isLocalMarkdownImageHref(href)) continue;
      block.imageRefs.push({
        href: ref.href,
        title: ref.title,
        alt: ref.alt,
        tokenIndex: ref.tokenIndex,
        occurrence: ref.occurrence,
      });
      explicitLocalImageRefs.push(ref);
    }
    if (token.type === "html" || token.type === "tag") {
      warnings.push("Markdown 中的原始 HTML 按纯文本显示，不会执行。");
    } else if (block.type === "other") {
      warnings.push(`无法识别的 Markdown 扩展已保留原文：${token.type || "unknown"}`);
    }
    blocks.push(block);
  }

  return {
    html: renderMarkdown(text),
    blocks,
    imageRefs,
    explicitLocalImageRefs,
    warnings: [...new Set(warnings)],
  };
}

function escapeMarkdownText(text) {
  return String(text ?? "").replace(/[\\`*_{}\[\]()#+\-.!>~|]/g, "\\$&");
}

/**
 * Exact inverse of `escapeMarkdownText`: every backslash it writes introduces one
 * character from that same class, so dropping only those backslashes loses nothing.
 */
function unescapeMarkdownText(text) {
  return String(text ?? "").replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, "$1");
}

export function editorValueChangedSinceBaseline(value, baseline) {
  return typeof baseline === "string" && baseline !== value;
}

function markdownCodeSpan(text) {
  const value = String(text ?? "").replace(/\n/g, " ");
  let ticks = "`";
  while (value.includes(ticks)) ticks += "`";
  const pad = value.startsWith("`") || value.endsWith("`") || /^ .*\S|\S.* $/.test(value)
    ? " "
    : "";
  return `${ticks}${pad}${value}${pad}${ticks}`;
}

function escapeCodeFence(text) {
  const matches = String(text ?? "").match(/`{3,}/g) || [];
  return "`".repeat(Math.max(3, ...matches.map((value) => value.length + 1)));
}

function safeEditableHref(value) {
  const href = String(value ?? "").trim();
  return safeLinkHref(href);
}

function childNodes(node) {
  return Array.from(node?.childNodes || []);
}

function nodeTag(node) {
  return String(node?.nodeName || "").toUpperCase();
}

function attr(node, name) {
  return node?.getAttribute?.(name) ?? null;
}

function inlineChildren(node) {
  return childNodes(node).map(serializeInlineNode).join("");
}

function markdownImageDestination(href) {
  const value = String(href ?? "");
  if (/[\s<>]/.test(value)) return `<${value.replaceAll(">", "%3E")}>`;
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function serializeImage(node, alt) {
  const href = attr(node, "data-markdown-image-href");
  if (!href) return "";
  const title = attr(node, "data-markdown-image-title") || attr(node, "title");
  const titleText = title
    ? ` "${String(title).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : "";
  return `![${escapeMarkdownText(alt || "")}](${markdownImageDestination(href)}${titleText})`;
}

function serializeInlineNode(node) {
  if (!node) return "";
  if (node.nodeType === 3) {
    return escapeMarkdownText((node.nodeValue ?? node.textContent ?? "").split(CARET_GUARD).join(""));
  }
  if (node.nodeType !== 1) return "";
  const tag = nodeTag(node);
  if (tag === "BR") return "  \n";
  if (tag === "IMG") return serializeImage(node, attr(node, "alt"));
  if (tag === "SPAN" && attr(node, "data-markdown-image-href")) {
    return serializeImage(node, attr(node, "aria-label") || node.textContent || "");
  }
  if (tag === "A" || (tag === "SPAN" && attr(node, "data-markdown-href"))) {
    const href = safeEditableHref(attr(node, "data-markdown-href") || attr(node, "href"));
    const label = inlineChildren(node);
    if (!href) return label;
    const title = attr(node, "data-markdown-title") || attr(node, "title");
    return `[${label}](${href}${title ? ` "${String(title).replaceAll('"', '\\"')}"` : ""})`;
  }
  const content = inlineChildren(node);
  if (tag === "STRONG" || tag === "B") return `**${content}**`;
  if (tag === "EM" || tag === "I") return `*${content}*`;
  if (tag === "DEL" || tag === "S" || tag === "STRIKE") return `~~${content}~~`;
  if (tag === "CODE") return markdownCodeSpan(node.textContent || "");
  if (["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE"].includes(tag)) {
    return serializeBlockNode(node, 0).trim();
  }
  if (tag === "INPUT") return "";
  return content;
}

function serializeList(node, depth = 0) {
  const ordered = nodeTag(node) === "OL";
  const start = Number(attr(node, "start") || node.start || 1);
  const indent = "  ".repeat(depth);
  const lines = [];
  let index = 0;
  for (const item of childNodes(node).filter((child) => nodeTag(child) === "LI")) {
    const task = item.querySelector?.("input[type='checkbox']");
    const marker = ordered ? `${start + index}.` : "-";
    const taskMark = task ? `[${task.checked ? "x" : " "}] ` : "";
    const nested = childNodes(item).filter((child) => ["UL", "OL"].includes(nodeTag(child)));
    const direct = childNodes(item).filter((child) => !["UL", "OL"].includes(nodeTag(child)));
    const content = direct.map((child) => {
      const tag = nodeTag(child);
      if (["P", "DIV"].includes(tag)) return inlineChildren(child);
      return serializeInlineNode(child);
    }).join("").trim();
    const wrapped = content.replace(/\n/g, `\n${indent}  `);
    lines.push(`${indent}${marker} ${taskMark}${wrapped}`.trimEnd());
    for (const child of nested) lines.push(serializeList(child, depth + 1));
    index += 1;
  }
  return lines.join("\n");
}

function serializeTable(node) {
  const rows = Array.from(node.querySelectorAll?.("tr") || []).map((row) =>
    Array.from(row.children || []).map((cell) => inlineChildren(cell).replace(/\n/g, " "))
  );
  if (!rows.length) return "";
  const width = Math.max(1, ...rows.map((row) => row.length));
  const format = (row) => `| ${Array.from({ length: width }, (_, index) => row[index] || "").join(" | ")} |`;
  return [format(rows[0]), format(Array(width).fill("---")), ...rows.slice(1).map(format)].join("\n");
}

function serializeBlockNode(node, depth = 0) {
  const tag = nodeTag(node);
  if (tag === "HR") return "---";
  if (tag === "PRE") {
    const code = node.querySelector?.("code");
    const text = String(code?.textContent ?? node.textContent ?? "").replace(/\n$/, "");
    const fence = escapeCodeFence(text);
    const language = code?.getAttribute?.("data-language") || code?.dataset?.language || "";
    return `${fence}${language}\n${text}\n${fence}`;
  }
  if (tag === "UL" || tag === "OL") return serializeList(node, depth);
  if (tag === "TABLE") return serializeTable(node);
  if (/^H[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    return `${"#".repeat(level)} ${inlineChildren(node)}`;
  }
  if (tag === "BLOCKQUOTE") {
    const body = serializeBlockChildren(node, depth).trim();
    return body.split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
  }
  if (["P", "DIV"].includes(tag)) return inlineChildren(node).trim();
  return inlineChildren(node).trim();
}

/** Elements that start their own Markdown chunk when they appear as siblings. */
const BLOCK_LEVEL_TAGS = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "UL",
  "OL",
  "BLOCKQUOTE",
  "PRE",
  "TABLE",
  "HR",
]);

function serializeBlockChildren(node, depth = 0) {
  const chunks = [];
  // The editor root is a bare DIV: text typed into an empty block has no <p>
  // wrapper, so its inline children are one paragraph, not one paragraph each.
  // Only real block elements start a new chunk.
  let inlineRun = "";
  const flush = () => {
    if (inlineRun.trim()) chunks.push(inlineRun.trim());
    inlineRun = "";
  };
  for (const child of childNodes(node)) {
    if (child.nodeType === 3) {
      inlineRun += serializeInlineNode(child);
      continue;
    }
    if (child.nodeType !== 1) continue;
    if (BLOCK_LEVEL_TAGS.has(nodeTag(child))) {
      flush();
      chunks.push(serializeBlockNode(child, depth));
      continue;
    }
    inlineRun += serializeInlineNode(child);
  }
  flush();
  return chunks.filter(Boolean).join("\n\n");
}

/** Serialize the supported CommonMark/GFM editing surface back to Markdown. */
export function markdownFromEditable(root) {
  if (!root) return "";
  return serializeBlockChildren(root).trim();
}

/** Inline closers the editor compiles as soon as the syntax is complete. */
const INLINE_COMPILERS = [
  { closer: "**", opener: "**", tag: "STRONG" },
  { closer: "~~", opener: "~~", tag: "DEL" },
  { closer: "*", opener: "*", tag: "EM" },
  { closer: "`", opener: "`", tag: "CODE" },
];

/**
 * Caret guard.  A collapsed caret at the boundary between an inline wrapper and
 * the text after it is an ambiguous position, and Blink resolves it *inside* the
 * wrapper, so the next character the user types silently joins the bold run.  A
 * zero-width character in front of the tail makes the position unambiguous; it
 * never reaches canonical storage because the serializer drops it and the caret
 * helpers count text without it.
 */
const CARET_GUARD = String.fromCharCode(0x200b);

/**
 * Block types whose whole body is Markdown text, so a structural conversion is
 * a type change rather than a content rewrite.  Media, placeholders and tables
 * hold their content elsewhere and are excluded.
 */
const CONVERTIBLE_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "quote",
  "callout",
  "exercise",
]);

/**
 * Text characters before the caret inside `root`, or null when the caret is
 * elsewhere (a lost caret must never be guessed back).  Caret guards are
 * layout, not content, so they are not counted.
 */
export function caretTextOffset(root) {
  const selection = globalThis.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return null;
  const probe = range.cloneRange();
  probe.selectNodeContents(root);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().split(CARET_GUARD).join("").length;
}

/**
 * Offset inside a text node counted in guard-free characters.
 */
function guardedNodeOffset(node, offset) {
  const value = node.nodeValue ?? "";
  if (!value.includes(CARET_GUARD)) return Math.max(0, Math.min(offset, value.length));
  const target = Math.max(0, offset);
  let seen = 0;
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    if (value[cursor] === CARET_GUARD) continue;
    if (seen === target) return cursor;
    seen += 1;
  }
  return value.length;
}

/** Put the caret back at `offset` plain-text characters into `root`. */
export function focusTextOffset(root, offset) {
  const selection = globalThis.getSelection?.();
  if (!root || !selection) return false;
  const range = document.createRange();
  if (typeof offset !== "number" || !Number.isFinite(offset)) {
    range.selectNodeContents(root);
    range.collapse(false);
  } else {
    let remaining = Math.max(0, Math.trunc(offset));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let placed = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.nodeValue ?? "").split(CARET_GUARD).join("");
      if (remaining <= text.length) {
        range.setStart(node, guardedNodeOffset(node, remaining));
        range.collapse(true);
        placed = true;
        break;
      }
      remaining -= text.length;
    }
    if (!placed) {
      range.selectNodeContents(root);
      range.collapse(false);
    }
  }
  root.focus?.({ preventScroll: true });
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Compile one completed Markdown shortcut in place: typing the closing `**` of
 * `**你好**` replaces that run with real bold instead of leaving the markers on
 * screen.  Only the finished run is rewritten, so the caret never jumps and an
 * in-progress IME composition is never touched.
 *
 * @param {HTMLElement} element
 * @returns {boolean} whether the DOM changed
 */
export function compileInlineAtCaret(element) {
  const selection = globalThis.getSelection?.();
  if (!element || !selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !element.contains(range.startContainer)) return false;
  const node = range.startContainer;
  if (node.nodeType !== 3) return false;
  const text = node.nodeValue ?? "";
  const caret = range.startOffset;
  // The longest marker wins a run of identical characters: while `**粗**` is
  // still being typed the trailing `*` of the opening `**` is not an emphasis
  // opener, and a closer followed by another `*` is a longer run than this
  // rule.  Without this the live compile turned `**x**` into `*<em>x</em>`.
  for (const rule of INLINE_COMPILERS) {
    if (!text.startsWith(rule.closer, caret - rule.closer.length)) continue;
    const bodyEnd = caret - rule.closer.length;
    if (text[caret] === rule.closer[0]) continue;
    const openerAt = text.lastIndexOf(rule.opener, bodyEnd - 1);
    if (openerAt < 0) continue;
    if (text[openerAt - 1] === rule.opener[0]) continue;
    // `a **b** c` must not swallow the space that separates two runs, and an
    // empty `****` is a literal the user is still typing.
    const body = text.slice(openerAt + rule.opener.length, bodyEnd);
    if (!body || body.includes(rule.opener)) continue;
    const wrapper = document.createElement(rule.tag);
    wrapper.textContent = body;
    const before = document.createTextNode(text.slice(0, openerAt));
    const after = document.createTextNode(CARET_GUARD + text.slice(caret));
    const parent = node.parentNode;
    if (!parent) return false;
    parent.insertBefore(before, node);
    parent.insertBefore(wrapper, node);
    parent.insertBefore(after, node);
    parent.removeChild(node);
    const next = globalThis.getSelection?.();
    const restored = document.createRange();
    // One past the guard: the caret has to sit in real text, not on the
    // wrapper boundary the engine would resolve back into the bold run.
    restored.setStart(after, 1);
    restored.collapse(true);
    next?.removeAllRanges();
    next?.addRange(restored);
    return true;
  }
  return false;
}

/**
 * Decide whether an entire block body is one unambiguous structural unit, and
 * what it should become.  Deliberately conservative: mixed content, unfinished
 * syntax and anything the Domain cannot represent losslessly returns null,
 * because a wrong conversion costs the user content while a missed conversion
 * only costs a keystroke.
 *
 * @param {string} source raw Canonical block content
 * @param {{type?:string,level?:number|null}} [current]
 * @returns {{type:string, level:number|null, content:string, offsetLoss:number, deferUntilBlur?:boolean}|null}
 */
export function structuralConversion(source, current = {}) {
  const text = String(source ?? "");
  if (!text.trim()) return null;
  if (!CONVERTIBLE_BLOCK_TYPES.has(current.type ?? "paragraph")) return null;
  // Canonical content escapes the literal `#`, `>` and `-` the user just typed, so
  // block syntax is invisible to the lexer.  The stored form is lexed first because
  // it is the only view in which a pasted fenced body stays verbatim; only when it
  // yields nothing does the converter re-lex the characters as they were typed.
  const converted = convertOnce(text, current) ?? convertOnce(unescapeMarkdownText(text), current);
  if (converted) return converted;
  if (current.type !== "paragraph") return null;

  const unescaped = unescapeMarkdownText(text);
  const tokens = marked.lexer(unescaped, MARKED_OPTIONS).filter((token) => token.type !== "space");
  if (!tokens.some((token) => token.type === "list")) return null;
  const content = text
    .replace(/^([ \t]*)\\([-+*])(?=[ \t])/gm, "$1$2")
    .replace(/^([ \t]*)([0-9]+)\\([.)])(?=[ \t])/gm, "$1$2$3");
  if (content === text) return null;
  // The Domain keeps editable prose as a paragraph; unescaping only the list
  // markers lets its Markdown renderer produce real list semantics without
  // inventing a new block type. Wait for blur so the cursor stays stable while
  // the editor is still text.
  return { type: "paragraph", level: null, content, offsetLoss: 0, deferUntilBlur: true };
}

function convertOnce(text, current) {
  const meaningful = marked.lexer(text, MARKED_OPTIONS).filter((token) => token.type !== "space");
  if (meaningful.length !== 1) return null;
  const [token] = meaningful;
  if (token.type === "hr") {
    return { type: "divider", level: null, content: "", offsetLoss: text.length };
  }
  if (token.type === "code") {
    return {
      type: "code",
      level: null,
      content: String(token.text ?? "").replace(/\n$/, ""),
      offsetLoss: leadingFenceWidth(text),
    };
  }
  if (token.type === "heading") {
    const level = Math.max(1, Math.min(6, Number(token.depth) || 1));
    const body = String(token.text ?? "");
    // A lone `#` is a heading the user is still typing, not an empty heading.
    if (!body.trim()) return null;
    if (current.type === "heading" && (current.level ?? 2) === level) return null;
    const match = /^(\s*#{1,6}\s+)/.exec(text);
    return {
      type: "heading",
      level,
      content: body,
      offsetLoss: match ? match[1].length : 0,
    };
  }
  if (token.type === "blockquote" && current.type !== "quote") {
    const body = String(token.text ?? "").trim();
    if (!body) return null;
    const match = /^(\s*(?:>\s?)+)/.exec(text);
    return {
      type: "quote",
      level: null,
      content: body,
      offsetLoss: match ? match[1].length : 0,
    };
  }
  if (token.type === "paragraph") {
    const inline = Array.isArray(token.tokens) ? token.tokens : [];
    // A lone `` `code` `` is a code block; `code` mixed with prose is not.
    if (inline.length === 1 && inline[0].type === "codespan") {
      const body = String(inline[0].text ?? "");
      if (!body.trim()) return null;
      return {
        type: "code",
        level: null,
        content: body,
        offsetLoss: 1,
      };
    }
    if (inline.length === 1 && inline[0].type === "br") return null;
    return null;
  }
  return null;
}

function leadingFenceWidth(text) {
  const match = /^\s*(?:```|~~~)[^\n]*\n/.exec(text);
  return match ? match[0].length : 0;
}
