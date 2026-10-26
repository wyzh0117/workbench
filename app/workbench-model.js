/** Pure document and view-state operations shared by the native renderer and tests. */
export const newId = () =>
  globalThis.crypto?.randomUUID?.() ||
  `wb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (
      c,
    ) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]),
  );
export function pickPath(value) {
  if (typeof value === "string") {
    try {
      return pickPath(JSON.parse(value));
    } catch {
      return value || null;
    }
  }
  return value?.status === "cancelled"
    ? null
    : (typeof value?.path === "string" ? value.path : null);
}
export function sidebarWidth(side, value) {
  return Math.round(
    Math.max(
      side === "left" ? 200 : 280,
      Math.min(
        side === "left" ? 420 : 560,
        Number(value) || (side === "left" ? 244 : 350),
      ),
    ),
  );
}
export function normalizeWebUrl(value) {
  let text = String(value || "").trim();
  if (!text || /^(?:javascript|data|file|blob|about):/i.test(text)) return null;
  if (!/^[a-z][a-z\d+.-]*:/i.test(text)) text = "https://" + text;
  try {
    const url = new URL(text), host = url.hostname.toLowerCase();
    if (
      !["https:", "http:"].includes(url.protocol) || url.username ||
      url.password || !host || host === "localhost" ||
      host.endsWith(".localhost") || host.endsWith(".local") ||
      host.includes(":") ||
      /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
        host,
      )
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}
export function previewUrl(value) {
  const url = String(value || "");
  if (
    /^(?:asset:\/\/|https?:\/\/asset\.localhost\/|blob:|data:(?:image\/(?:png|jpeg|gif|webp|avif|bmp)|video\/(?:mp4|webm|ogg));base64,)/i
      .test(url)
  ) return url;
  return /^https:\/\//i.test(url) ? normalizeWebUrl(url) || "" : "";
}
function fenceAfter(line, fence) {
  const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!marker) return fence;
  if (!fence) return { character: marker[1][0], length: marker[1].length };
  return marker[1][0] === fence.character && marker[1].length >= fence.length &&
      !marker[2].trim()
    ? null
    : fence;
}
function parseBlock(markdown) {
  const image = markdown.match(/^!\[([^\]]*)\]\(([^\s]+?)(?:\s+"[^"]*")?\)$/);
  const link = markdown.match(/^\[([^\]]+)\]\((https?:\/\/[^\s]+|[^\s]+)\)$/);
  if (image) {
    return {
      id: newId(),
      type: "image",
      caption: image[1],
      originalCaption: image[1],
      originalUrl: image[2],
      url: image[2],
      markdown,
    };
  }
  if (link) {
    return {
      id: newId(),
      type: /\.(mp4|webm|mov|m4v|ogv)(?:[?#]|$)/i.test(link[2])
        ? "video"
        : "source",
      caption: link[1],
      originalCaption: link[1],
      originalUrl: link[2],
      url: link[2],
      markdown,
    };
  }
  return { id: newId(), type: "text", markdown };
}
export function blocksFromMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let chunk = [], fence = null;
  const flush = () => {
    const raw = chunk.join("\n").replace(/^\n+|\n+$/g, "");
    if (raw) blocks.push(parseBlock(raw));
    chunk = [];
  };
  for (const line of lines) {
    fence = fenceAfter(line, fence);
    if (!line.trim() && !fence) flush();
    else chunk.push(line);
  }
  flush();
  return blocks;
}
export function parseDocument(markdown = "", fallbackTitle = "未命名文档") {
  const source = String(markdown).replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  let title = fallbackTitle.replace(/\.[^.]+$/, ""),
    titleHeading = false,
    fence = null,
    current = null;
  const chapters = [], intro = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    fence = fenceAfter(line, fence);
    if (
      !fence && !titleHeading && !current && !intro.some((x) => x.trim()) &&
      /^#\s+/.test(line)
    ) {
      title = line.replace(/^#\s+/, "").trim();
      titleHeading = true;
      continue;
    }
    const heading = !fence && line.match(/^(#{1,2})\s+(.+)$/);
    if (heading) {
      current = {
        id: newId(),
        title: heading[2].trim(),
        level: heading[1].length,
        lines: [],
        implicit: false,
      };
      chapters.push(current);
    } else if (current) current.lines.push(line);
    else intro.push(line);
  }
  if (intro.some((line) => line.trim()) || !chapters.length) {
    chapters.unshift({
      id: newId(),
      title: chapters.length ? "导言" : "正文",
      level: 2,
      lines: intro,
      implicit: true,
    });
  }
  return {
    title,
    titleHeading,
    chapters: chapters.map(({ lines, ...chapter }) => ({
      ...chapter,
      blocks: blocksFromMarkdown(lines.join("\n")),
    })),
    sourceMarkdown: source,
  };
}
export function blockMarkdown(block) {
  if (
    block.type !== "text" && block.markdown &&
    block.caption === block.originalCaption && block.url === block.originalUrl
  ) return block.markdown;
  if (block.type === "text") return String(block.markdown || "");
  const caption = String(
    block.caption ||
      (block.type === "image"
        ? "图片"
        : block.type === "video"
        ? "视频"
        : "来源"),
  ).replace(/\]/g, "\\]");
  const url = String(block.url || "").replace(/ /g, "%20").replace(
    /\)/g,
    "%29",
  );
  return `${block.type === "image" ? "!" : ""}[${caption}](${url})`;
}
export function serializeDocument(doc) {
  const chunks = doc.titleHeading ? [`# ${doc.title}`] : [];
  for (const chapter of doc.chapters) {
    if (!chapter.implicit) {
      chunks.push(`${"#".repeat(chapter.level || 2)} ${chapter.title}`);
    }
    for (const block of chapter.blocks) {
      const text = blockMarkdown(block);
      if (text.trim()) chunks.push(text);
    }
  }
  return chunks.join("\n\n") + (chunks.length ? "\n" : "");
}
export function moveItem(items, id, direction) {
  const from = items.findIndex((x) => x.id === id), to = from + direction;
  if (from < 0 || to < 0 || to >= items.length) return false;
  items.splice(to, 0, items.splice(from, 1)[0]);
  return true;
}
export function insertBlock(chapter, block, afterId = null) {
  const item = { id: newId(), ...block };
  const index = chapter.blocks.findIndex((x) => x.id === afterId);
  chapter.blocks.splice(index < 0 ? chapter.blocks.length : index + 1, 0, item);
  return item;
}
export function removeBlock(chapter, id) {
  const index = chapter.blocks.findIndex((x) => x.id === id);
  if (index >= 0) chapter.blocks.splice(index, 1);
}
export function documentStats(doc) {
  const blocks = doc?.chapters?.flatMap((c) => c.blocks) || [];
  return {
    chapters: doc?.chapters?.length || 0,
    blocks: blocks.length,
    media: blocks.filter((b) => ["image", "video"].includes(b.type)).length,
    characters:
      serializeDocument(doc || { chapters: [] }).replace(/\s/g, "").length,
  };
}
