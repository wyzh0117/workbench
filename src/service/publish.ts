import { buildPublicationProjection } from "../../app/publication.js";
import type {
  AssetType,
  BlockType,
  JsonObject,
  LayoutMode,
  LayoutPageSize,
  ProjectData,
} from "../domain/types.ts";
import { assertValidProjectData } from "../domain/store.ts";

/** Read-only canonical projection shared by preview and publish adapters. */
export type PublishScope = "lesson" | "course";
export interface PublishMedia {
  id: string;
  type: AssetType;
  title: string;
  filename: string;
  output_path: string;
  mime_type: string;
  source_url: string | null;
  inline: boolean;
}
export interface PublishBlock {
  id: string;
  type: BlockType;
  text: string;
  heading_level: number | null;
  media: PublishMedia | null;
  rich_text?: PublishSemanticBlock[];
  inline_media?: PublishMedia[];
}
export type PublishInline =
  | { type: "text"; text: string }
  | { type: "break" }
  | { type: "code"; text: string }
  | { type: "image"; asset_id: string | null; alt: string; title: string | null }
  | { type: "link"; href: string; title: string | null; children: PublishInline[] }
  | { type: "strong" | "em" | "del"; children: PublishInline[] };
export type PublishSemanticBlock =
  | { type: "paragraph" | "callout"; children: PublishInline[] }
  | { type: "heading"; level: number; children: PublishInline[] }
  | { type: "quote"; children: PublishSemanticBlock[] }
  | { type: "list"; ordered: boolean; start: number; items: Array<{ checked: boolean | null; children: PublishSemanticBlock[] }> }
  | { type: "code"; text: string; language: string | null }
  | { type: "divider" }
  | { type: "table"; align: Array<string | null>; header: PublishInline[][]; rows: PublishInline[][][] };
export interface PublishPageItem {
  placement_id: string;
  block_id: string;
  kind: BlockType;
  text: string;
  heading_level: number | null;
  rect: { x_pt: number; y_pt: number; width_pt: number; height_pt: number };
  style: {
    alignment: JsonObject;
    fit_mode: string;
    padding: JsonObject;
    z_index: number;
    font_size_pt: number;
    line_height: number;
  };
  media: PublishMedia | null;
  rich_text?: PublishSemanticBlock[];
  inline_media?: PublishMedia[];
}
export interface PublishPage {
  page_id: string | null;
  title: string;
  order: number;
  logical_width_pt: number;
  logical_height_pt: number;
  items: PublishPageItem[];
}
export interface PublishLayout {
  layout_instance_id: string;
  mode: LayoutMode;
  name: string;
  pagination_mode: "continuous" | "paged";
  page_size: LayoutPageSize;
  sections: string[];
  pages: PublishPage[];
  unplaced_block_ids: string[];
  placed_block_ids: string[];
}
export interface PublishLesson {
  id: string;
  code: string;
  title: string;
  blocks: PublishBlock[];
  attachments: PublishMedia[];
  layout: PublishLayout | null;
}
export interface PublishProjectionNotice {
  code: "legacy_grid_sections_require_pagination";
  layout_instance_id: string;
  section_ids: string[];
  includes_unsectioned: boolean;
  message: string;
}
export interface PublishProjection {
  schema_version: "2";
  project_id: string;
  title: string;
  language: string;
  scope: PublishScope;
  content_item_id: string | null;
  generated_from_updated_at: string;
  selection: {
    content_item_id: string | null;
    layout_instance_id: string | null;
    page_ids: string[] | null;
  };
  target_page_size: LayoutPageSize | null;
  lessons: PublishLesson[];
  notices: PublishProjectionNotice[];
  media: PublishMedia[];
}

export function buildPublishProjection(
  data: ProjectData,
  options: {
    content_item_id?: string | null;
    layout_instance_id?: string | null;
    page_ids?: string[] | null;
    target_page_size?: PublishProjection["target_page_size"];
  } = {},
): PublishProjection {
  assertValidProjectData(data);
  return buildPublicationProjection(data, options);
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function urlPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function markdownMedia(media: PublishMedia): string {
  const title = escapeMarkdown(media.title);
  const path = urlPath(media.output_path);
  return media.type === "image" || media.type === "gif"
    ? `![${title}](${path})`
    : `[${media.type === "video" ? "视频" : media.type === "audio" ? "音频" : "附件"}：${title}](${path})`;
}

export function renderPublishMarkdown(projection: PublishProjection): string {
  const lines: string[] = [`# ${projection.title}`, ""];
  for (const lesson of projection.lessons) {
    if (projection.scope === "course") lines.push(`## ${lesson.code}｜${lesson.title}`, "");
    else {
      lines.length = 0;
      lines.push(`# ${lesson.title}`, "");
    }
    for (const block of lesson.blocks) {
      if (block.media) lines.push(markdownMedia(block.media));
      else if (block.type === "heading") {
        lines.push(`${"#".repeat(block.heading_level ?? 2)} ${block.text}`);
      } else if (block.type === "quote") lines.push(`> ${block.text}`);
      else if (block.type === "code") lines.push(`\`\`\`\n${block.text}\n\`\`\``);
      else if (block.type === "divider") lines.push("---");
      else if (block.text) lines.push(block.text);
      if (block.media || block.text || block.type === "divider") lines.push("");
    }
    if (lesson.attachments.length) {
      lines.push(projection.scope === "course" ? "### 附件" : "## 附件", "");
      for (const media of lesson.attachments) lines.push(markdownMedia(media), "");
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function semanticPlainText(blocks: PublishSemanticBlock[]): string[] {
  const inline = (nodes: PublishInline[]): string => nodes.map((node) => {
    if (node.type === "text" || node.type === "code") return node.text;
    if (node.type === "break") return " ";
    if (node.type === "image") return node.alt ? `[${node.alt}]` : "[图片]";
    return inline(node.children ?? []);
  }).join("");
  return blocks.flatMap((block) => {
    if (block.type === "paragraph" || block.type === "heading" || block.type === "callout") return [inline(block.children)];
    if (block.type === "quote") return semanticPlainText(block.children);
    if (block.type === "list") return block.items.flatMap((item, index) => [
      `${item.checked === true ? "☑" : item.checked === false ? "☐" : block.ordered ? `${block.start + index}.` : "•"} ${semanticPlainText(item.children).join(" ")}`,
    ]);
    if (block.type === "code") return [block.text];
    if (block.type === "divider") return ["────────"];
    if (block.type === "table") return [
      ...[block.header, ...block.rows].map((row) => row.map(inline).join(" | ")),
    ];
    return [];
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character] ?? character));
}

function mediaHtml(media: PublishMedia, migration = false): string {
  const path = escapeHtml(urlPath(media.output_path));
  const title = escapeHtml(media.title);
  if (media.type === "image" || media.type === "gif") {
    return `<figure><img src="${path}" alt="${title}"><figcaption>${title}</figcaption></figure>`;
  }
  if (!migration && media.type === "video") {
    return `<figure><video controls preload="metadata" src="${path}"></video><figcaption>${title}</figcaption></figure>`;
  }
  if (!migration && media.type === "audio") {
    return `<figure><audio controls preload="metadata" src="${path}"></audio><figcaption>${title}</figcaption></figure>`;
  }
  const kind = media.type === "video" ? "视频" : media.type === "audio" ? "音频" : "附件";
  const hint = migration
    ? "复制到富文本后需单独上传此素材。"
    : "此素材以附件链接提供。";
  return `<aside class="media-card"><strong>${kind}：${title}</strong><p>${hint}</p><a href="${path}">打开 ${title}</a></aside>`;
}

function safePublicationLink(value: string): string | null {
  const href = value.trim();
  return /^(?:https?:|mailto:)/i.test(href) && !/[\u0000-\u0020]/.test(href)
    ? href
    : null;
}

function inlineSemanticHtml(nodes: PublishInline[], media: PublishMedia[]): string {
  const byId = new Map(media.map((item) => [item.id, item]));
  return nodes.map((node) => {
    if (node.type === "text") return escapeHtml(node.text);
    if (node.type === "break") return "<br>";
    if (node.type === "code") return `<code>${escapeHtml(node.text)}</code>`;
    if (node.type === "image") {
      const asset = node.asset_id ? byId.get(node.asset_id) : null;
      if (!asset || (asset.type !== "image" && asset.type !== "gif")) return escapeHtml(node.alt);
      return `<img class="publication-inline-image" src="${escapeHtml(urlPath(asset.output_path))}" alt="${escapeHtml(node.alt)}">`;
    }
    const children = inlineSemanticHtml(node.children ?? [], media);
    if (node.type === "strong") return `<strong>${children}</strong>`;
    if (node.type === "em") return `<em>${children}</em>`;
    if (node.type === "del") return `<del>${children}</del>`;
    if (node.type === "link") {
      const href = safePublicationLink(node.href);
      return href
        ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${children}</a>`
        : children;
    }
    return "";
  }).join("");
}

function semanticHtml(blocks: PublishSemanticBlock[], media: PublishMedia[]): string {
  return blocks.map((block) => {
    const inline = (nodes: PublishInline[]) => inlineSemanticHtml(nodes, media);
    switch (block.type) {
      case "paragraph": return `<p>${inline(block.children)}</p>`;
      case "heading": {
        const level = Math.max(1, Math.min(6, block.level));
        return `<h${level}>${inline(block.children)}</h${level}>`;
      }
      case "quote": return `<blockquote>${semanticHtml(block.children, media)}</blockquote>`;
      case "callout": return `<aside class="markdown-callout">${inline(block.children)}</aside>`;
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        const start = block.ordered && block.start > 1 ? ` start="${Math.max(1, Math.min(999999, Math.trunc(block.start)))}"` : "";
        const items = block.items.map((item) => {
          const marker = item.checked == null ? "" : `<span class="task-marker">${item.checked ? "☑" : "☐"} </span>`;
          return `<li>${marker}${semanticHtml(item.children, media)}</li>`;
        }).join("");
        return `<${tag}${start}>${items}</${tag}>`;
      }
      case "code": {
        const language = block.language && /^[\w+-]{1,40}$/.test(block.language)
          ? ` class="language-${escapeHtml(block.language)}"` : "";
        return `<pre><code${language}>${escapeHtml(block.text)}</code></pre>`;
      }
      case "divider": return "<hr>";
      case "table": {
        const row = (cells: PublishInline[][], header = false) => `<tr>${cells.map((cell, index) => {
          const tag = header ? "th" : "td";
          const align = block.align[index];
          const style = ["left", "center", "right"].includes(align || "") ? ` style="text-align:${align}"` : "";
          return `<${tag}${style}>${inline(cell)}</${tag}>`;
        }).join("")}</tr>`;
        return `<table><thead>${row(block.header, true)}</thead><tbody>${block.rows.map((cells) => row(cells)).join("")}</tbody></table>`;
      }
      default: return "";
    }
  }).join("\n");
}

function pageItemHtml(item: PublishPageItem, migration: boolean): string {
  const rect = item.rect;
  const alignment = item.style.alignment;
  const horizontal = ["left", "center", "right", "justify"].includes(
    String(alignment.horizontal ?? alignment.text ?? "left"),
  ) ? String(alignment.horizontal ?? alignment.text ?? "left") : "left";
  const imageFit = item.style.fit_mode === "cover"
    ? "cover"
    : item.style.fit_mode === "stretch" ? "fill" : "contain";
  const style = `left:${rect.x_pt}pt;top:${rect.y_pt}pt;width:${rect.width_pt}pt;height:${rect.height_pt}pt;z-index:${item.style.z_index};text-align:${horizontal};font-size:${item.style.font_size_pt}pt;line-height:${item.style.line_height};--page-image-fit:${imageFit};`;
  const content = item.media
    ? mediaHtml(item.media, migration)
    : item.rich_text?.length
    ? semanticHtml(item.rich_text, item.inline_media ?? [])
    : item.kind === "heading"
    ? `<h${item.heading_level ?? 2}>${escapeHtml(item.text)}</h${item.heading_level ?? 2}>`
    : item.kind === "quote"
    ? `<blockquote>${escapeHtml(item.text)}</blockquote>`
    : item.kind === "code"
    ? `<pre><code>${escapeHtml(item.text)}</code></pre>`
    : item.kind === "divider"
    ? "<hr>"
    : `<p>${escapeHtml(item.text)}</p>`;
  return `<div class="publication-page-item" data-block-id="${escapeHtml(item.block_id)}" style="${style}">${content}</div>`;
}

function publicationPagesHtml(lesson: PublishLesson, migration: boolean): string {
  const layout = lesson.layout;
  if (!layout?.pages.length) return "";
  const pages = layout.pages.map((page, index) => {
    const title = page.title
      ? `<h3 class="publication-page-label">${escapeHtml(page.title)}</h3>`
      : "";
    const items = page.items.map((item) => pageItemHtml(item, migration)).join("\n");
    return `${title}<section class="publication-page" data-page-id="${escapeHtml(page.page_id ?? "legacy-grid")}" data-page-order="${page.order}" style="width:${page.logical_width_pt}pt;height:${page.logical_height_pt}pt"><div class="publication-page-content">${items}</div></section>`;
  }).join("\n");
  return pages;
}

function lessonHtml(lesson: PublishLesson, heading: 1 | 2, migration: boolean): string {
  const pageContent = publicationPagesHtml(lesson, migration);
  if (pageContent) {
    const attachments = lesson.attachments.length
      ? `<section class="attachments"><h${Math.min(6, heading + 1)}>附件</h${Math.min(6, heading + 1)}>${lesson.attachments.map((media) => mediaHtml(media, migration)).join("\n")}</section>`
      : "";
    return `<article class="layout-lesson"><h${heading}>${escapeHtml(lesson.code ? `${lesson.code}｜${lesson.title}` : lesson.title)}</h${heading}>${pageContent}${attachments}</article>`;
  }
  const blocks = lesson.blocks.map((block) => {
    if (block.media) return mediaHtml(block.media, migration);
    if (block.rich_text?.length) return semanticHtml(block.rich_text, block.inline_media ?? []);
    const text = escapeHtml(block.text);
    if (block.type === "heading") {
      const level = Math.max(heading + 1, Math.min(6, block.heading_level ?? heading + 1));
      return `<h${level}>${text}</h${level}>`;
    }
    if (block.type === "quote") return `<blockquote>${text}</blockquote>`;
    if (block.type === "code") return `<pre><code>${text}</code></pre>`;
    if (block.type === "divider") return "<hr>";
    return text ? `<p>${text}</p>` : "";
  }).join("\n");
  const attachments = lesson.attachments.length
    ? `<section class="attachments"><h${Math.min(6, heading + 1)}>附件</h${Math.min(6, heading + 1)}>${lesson.attachments.map((media) => mediaHtml(media, migration)).join("\n")}</section>`
    : "";
  return `<article><h${heading}>${escapeHtml(lesson.code ? `${lesson.code}｜${lesson.title}` : lesson.title)}</h${heading}>${blocks}${attachments}</article>`;
}

export function renderPublishHtml(
  projection: PublishProjection,
  options: { migration?: boolean } = {},
): string {
  const migration = options.migration === true;
  const body = projection.lessons.map((lesson) =>
    lessonHtml(lesson, projection.scope === "course" ? 2 : 1, migration)
  ).join("\n");
  const title = escapeHtml(projection.title);
  const notice = migration
    ? "<p class=\"migration-note\">富文本迁移版：图片和 GIF 可随内容复制；视频、音频与文档需要在目标平台单独上传。目标平台可能调整字体与间距。</p>"
    : "";
  return `<!doctype html>\n<html lang="${escapeHtml(projection.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:light}body{margin:0;padding:32px 24px;color:#20242b;background:#f2f4f7;font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}main>h1{font-size:2rem;max-width:1000px;margin:0 auto 2rem}article{margin:2.5rem auto;max-width:1000px}.publication-page-label{max-width:1000px;margin:1rem auto .5rem;text-align:center;font-size:10pt;color:#667085}.publication-page{position:relative;box-sizing:border-box;margin:0 auto 1.5rem;background:white;border:1px solid #cbd1dc;box-shadow:0 2px 14px #18223018;overflow:hidden;break-after:page;page-break-after:always}.publication-page-content{position:absolute;inset:0}.publication-page-item{position:absolute;box-sizing:border-box;padding:4pt;overflow:auto;font-size:18pt;line-height:1.2}.publication-page-item h1,.publication-page-item h2,.publication-page-item h3,.publication-page-item h4,.publication-page-item h5,.publication-page-item h6,.publication-page-item p{margin:0;font-size:inherit}.publication-page-item img:not(.publication-inline-image){display:block;width:100%;height:100%;object-fit:var(--page-image-fit,contain)}.publication-inline-image{display:inline-block;width:auto;height:auto;max-width:100%;max-height:60pt;object-fit:contain;vertical-align:middle}.publication-page-item video{display:block;width:100%;height:100%;object-fit:var(--page-image-fit,contain)}.publication-page-item audio{width:100%}.publication-page-item figure{margin:0}.publication-page-item figcaption{font-size:8pt}.publication-page-item pre{white-space:pre-wrap;overflow-wrap:anywhere}img,video{max-width:100%;height:auto}audio{width:100%}figure{margin:1.5rem 0}figcaption{color:#68707c;font-size:.875rem}blockquote{margin-left:0;border-left:4px solid #aab3bf;padding-left:1rem;color:#4c5562}pre{overflow:auto;background:#f5f6f8;padding:1rem;border-radius:.5rem}.markdown-callout{border-left:3px solid #175cd3;padding:.5rem .8rem;background:#f5f8ff}.media-card,.migration-note{border:1px solid #d8dde5;border-radius:.5rem;padding:1rem;margin:1rem 0;background:#f8f9fb}.media-card p{margin:.35rem 0}.attachments{border-top:1px solid #ddd;margin-top:2rem}table{border-collapse:collapse}th,td{border:1px solid #cbd1dc;padding:.3rem .5rem}a{color:#175cd3}@media print{body{padding:0;background:white}.publication-page{margin:0;border:0;box-shadow:none}}</style></head><body><main><h1>${title}</h1>${notice}${body}</main></body></html>\n`;
}

/** Small deterministic PDF used by the service path; desktop may print the same HTML with WebKit/Chrome. */
export function renderPublishPdf(projection: PublishProjection): Uint8Array {
  const textLines = [projection.title, ...projection.lessons.flatMap((lesson) => [
    `${lesson.code} ${lesson.title}`,
    ...lesson.blocks.flatMap((block) => block.media
      ? [`${block.media.type}：${block.media.title}`]
      : block.rich_text?.length ? semanticPlainText(block.rich_text) : [block.text]),
    ...lesson.attachments.map((media) => `附件：${media.title}`),
  ])].filter(Boolean);
  const pages: string[][] = [];
  for (let index = 0; index < textLines.length; index += 34) pages.push(textLines.slice(index, index + 34));
  if (!pages.length) pages.push([projection.title]);
  const objects: string[] = [];
  const add = (value: string): number => (objects.push(value), objects.length);
  const catalog = add("");
  const pagesObject = add("");
  const font = add("<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>] >>");
  const pageIds: number[] = [];
  for (const pageLines of pages) {
    const stream = ["BT", "/F1 12 Tf", "50 790 Td", "18 TL", ...pageLines.flatMap((line, index) => {
      const hex = Array.from(line).map((character) => {
        const code = character.charCodeAt(0);
        return code.toString(16).padStart(4, "0");
      }).join("");
      return [`<${hex}> Tj`, index === pageLines.length - 1 ? "" : "T*"];
    }), "ET"].filter(Boolean).join("\n");
    const content = add(`<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`);
    const page = add(`<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
    pageIds.push(page);
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObject} 0 R >>`;
  objects[pagesObject - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  let body = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(new TextEncoder().encode(body).length);
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(body).length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(Array.from(body).map((character) => character.charCodeAt(0) & 0xff));
}
