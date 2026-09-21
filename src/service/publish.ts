import type {
  Asset,
  AssetType,
  BlockType,
  ContentItem,
  ProjectData,
} from "../domain/types.ts";
import { assertValidProjectData } from "../domain/store.ts";

/**
 * Read-only boundary shared by Preview and every publish adapter.
 * Platform markup never enters Canonical; adapters consume this projection.
 */
export type PublishScope = "lesson" | "course";

export interface PublishMedia {
  id: string;
  type: AssetType;
  title: string;
  filename: string;
  source_path: string;
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
}

export interface PublishLesson {
  id: string;
  code: string;
  title: string;
  blocks: PublishBlock[];
  attachments: PublishMedia[];
  layout: {
    mode: "flow" | "grid";
    name: string;
    sections: string[];
    placed_block_ids: string[];
  } | null;
}

export interface PublishProjection {
  schema_version: "1";
  project_id: string;
  title: string;
  language: string;
  scope: PublishScope;
  content_item_id: string | null;
  generated_from_updated_at: string;
  lessons: PublishLesson[];
  media: PublishMedia[];
}

const MEDIA_BLOCKS = new Set<BlockType>([
  "image",
  "gif",
  "video",
  "audio",
  "embed",
  "gallery",
]);

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function safeName(value: string, fallback: string): string {
  const cleaned = value.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "").trim();
  return cleaned || fallback;
}

function safeRelativePath(value: string): boolean {
  const path = value.replaceAll("\\", "/");
  return Boolean(path) && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) &&
    !path.split("/").some((part) => !part || part === "." || part === "..");
}

function mediaOutputPath(asset: Asset): string {
  if (safeRelativePath(asset.storage_path)) return asset.storage_path.replaceAll("\\", "/");
  return `assets/${asset.id}-${safeName(asset.filename, "asset")}`;
}

function mediaFor(asset: Asset, inline: boolean): PublishMedia {
  return {
    id: asset.id,
    type: asset.type,
    title: asset.title || asset.filename,
    filename: asset.filename,
    source_path: asset.storage_path,
    output_path: mediaOutputPath(asset),
    mime_type: asset.mime_type || "application/octet-stream",
    source_url: asset.source_url,
    inline,
  };
}

function resolveBlockAsset(
  data: ProjectData,
  item: ContentItem,
  block: ProjectData["blocks"][number],
): Asset | null {
  const linked = typeof block.settings.asset_id === "string"
    ? block.settings.asset_id
    : null;
  const usage = data.asset_usages.find((candidate) =>
    candidate.content_item_id === item.id && candidate.block_id === block.id
  );
  const reference = textOf(block.content).trim();
  return data.assets.find((asset) =>
    !asset.archived &&
    (asset.id === linked || asset.id === usage?.asset_id ||
      asset.filename === reference || asset.storage_path === reference)
  ) ?? null;
}

function lessonProjection(data: ProjectData, item: ContentItem): PublishLesson {
  const blocks = data.blocks.filter((block) => block.document_id === item.document_id)
    .sort((a, b) => (a.order_index - b.order_index) || a.id.localeCompare(b.id));
  const layoutOnly = new Set(data.requirements.filter((requirement) =>
    requirement.content_item_id === item.id && requirement.scope === "layout"
  ).map((requirement) => requirement.anchor_block_id).filter((id): id is string => Boolean(id)));
  const inlineIds = new Set<string>();
  const projectedBlocks: PublishBlock[] = [];
  for (const block of blocks) {
    // Placeholders and layout-only anchors are workflow state, not published prose.
    if (block.type === "placeholder" || layoutOnly.has(block.id)) continue;
    const asset = MEDIA_BLOCKS.has(block.type)
      ? resolveBlockAsset(data, item, block)
      : null;
    if (asset) inlineIds.add(asset.id);
    projectedBlocks.push({
      id: block.id,
      type: block.type,
      text: textOf(block.content),
      heading_level: block.type === "heading"
        ? Math.max(1, Math.min(6, Number(block.settings.level) || 2))
        : null,
      media: asset ? mediaFor(asset, true) : null,
    });
  }
  const usedIds = new Set(data.asset_usages.filter((usage) =>
    usage.content_item_id === item.id
  ).map((usage) => usage.asset_id));
  for (const requirement of data.requirements.filter((candidate) =>
    candidate.content_item_id === item.id && candidate.resolved_asset_id
  )) usedIds.add(requirement.resolved_asset_id!);
  const attachments = data.assets.filter((asset) =>
    !asset.archived && usedIds.has(asset.id) && !inlineIds.has(asset.id)
  ).sort((a, b) => a.filename.localeCompare(b.filename) || a.id.localeCompare(b.id))
    .map((asset) => mediaFor(asset, false));
  const layout = data.layout_instances.find((candidate) =>
    candidate.content_item_id === item.id
  ) ?? null;
  return {
    id: item.id,
    code: item.code,
    title: item.title,
    blocks: projectedBlocks,
    attachments,
    layout: layout
      ? {
        mode: layout.mode,
        name: layout.name,
        sections: data.layout_sections.filter((section) =>
          section.layout_instance_id === layout.id
        ).sort((a, b) => (a.order_index - b.order_index) || a.id.localeCompare(b.id))
          .map((section) => section.name),
        placed_block_ids: data.placements.filter((placement) =>
          placement.layout_instance_id === layout.id
        ).map((placement) => placement.block_id),
      }
      : null,
  };
}

export function buildPublishProjection(
  data: ProjectData,
  options: { content_item_id?: string | null } = {},
): PublishProjection {
  assertValidProjectData(data);
  const contentItemId = options.content_item_id ?? null;
  const items = data.content_items.filter((item) =>
    !item.archived && (!contentItemId || item.id === contentItemId)
  ).sort((a, b) => (a.order_index - b.order_index) || a.id.localeCompare(b.id));
  if (contentItemId && !items.length) throw new Error("指定的导出课程不存在");
  const lessons = items.map((item) => lessonProjection(data, item));
  const mediaById = new Map<string, PublishMedia>();
  for (const lesson of lessons) {
    for (const block of lesson.blocks) {
      if (block.media) mediaById.set(block.media.id, block.media);
    }
    for (const media of lesson.attachments) mediaById.set(media.id, media);
  }
  return {
    schema_version: "1",
    project_id: data.project.id,
    title: data.project.title,
    language: data.project.language || "zh-CN",
    scope: contentItemId ? "lesson" : "course",
    content_item_id: contentItemId,
    generated_from_updated_at: data.project.updated_at,
    lessons,
    media: [...mediaById.values()].sort((a, b) =>
      a.output_path.localeCompare(b.output_path) || a.id.localeCompare(b.id)
    ),
  };
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

function lessonHtml(lesson: PublishLesson, heading: 1 | 2, migration: boolean): string {
  const blocks = lesson.blocks.map((block) => {
    if (block.media) return mediaHtml(block.media, migration);
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
  return `<!doctype html>\n<html lang="${escapeHtml(projection.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:light}body{max-width:820px;margin:0 auto;padding:32px 24px;color:#20242b;background:#fff;font:16px/1.75 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}main>h1{font-size:2rem}article{margin:2.5rem 0}img,video{display:block;max-width:100%;height:auto;margin:auto}audio{width:100%}figure{margin:1.5rem 0}figcaption{color:#68707c;font-size:.875rem}blockquote{margin-left:0;border-left:4px solid #aab3bf;padding-left:1rem;color:#4c5562}pre{overflow:auto;background:#f5f6f8;padding:1rem;border-radius:.5rem}.media-card,.migration-note{border:1px solid #d8dde5;border-radius:.5rem;padding:1rem;margin:1rem 0;background:#f8f9fb}.media-card p{margin:.35rem 0}.attachments{border-top:1px solid #ddd;margin-top:2rem}a{color:#175cd3}</style></head><body><main><h1>${title}</h1>${notice}${body}</main></body></html>\n`;
}

/** Small deterministic PDF used by the service path; desktop may print the same HTML with WebKit/Chrome. */
export function renderPublishPdf(projection: PublishProjection): Uint8Array {
  const textLines = [projection.title, ...projection.lessons.flatMap((lesson) => [
    `${lesson.code} ${lesson.title}`,
    ...lesson.blocks.map((block) => block.media ? `${block.media.type}：${block.media.title}` : block.text),
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
