/*
 * Course Authoring UI: canvas rendering helpers and the asset preview cache.
 *
 * Views live in `./views.js`; projections live in `./authoring.js`.  These
 * helpers only turn already-derived values into DOM, and the preview cache
 * only reads asset bytes that the native shell explicitly allows.
 */

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

/**
 * Render a restricted, deterministic subset of Markdown from a local bundle.
 * Raw project data is escaped first, so no canonical content can inject markup.
 */
function inlineMarkdown(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1");
}

export function markdownToHtml(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let list = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeList();
      out.push(inCode ? "</code></pre>" : '<pre class="md-code"><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`${esc(line)}\n`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length);
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const tag = ordered ? "ol" : "ul";
      if (list !== tag) {
        closeList();
        out.push(`<${tag}>`);
        list = tag;
      }
      out.push(
        `<li>${inlineMarkdown(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))}</li>`,
      );
      continue;
    }
    closeList();
    if (/^\s*>\s?/.test(line)) {
      out.push(`<blockquote>${inlineMarkdown(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      out.push("<hr />");
      continue;
    }
    if (line.trim() === "") continue;
    out.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

const BYTES_PER_MEGABYTE = 1024 * 1024;

/**
 * Bounded preview cache.
 *
 * Asset bytes are read only for assets the canonical project references, are
 * cached per asset id, and are never written back anywhere.  Webviews cannot
 * load `project/assets/...` directly, so small payloads use a data URL (which
 * the package CSP already allows) and larger media uses an object URL.
 */
export class AssetPreviewCache {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.dataUrlLimit = options.dataUrlLimit ?? 2 * BYTES_PER_MEGABYTE;
    this.mediaLimit = options.mediaLimit ?? 64 * BYTES_PER_MEGABYTE;
    this.entries = new Map();
    this.pending = new Map();
    this.failures = 0;
    this.urls = new Set();
    this.onChange = options.onChange ?? (() => {});
    this.notifyScheduled = false;
  }

  /** @returns {{url?: string, text?: string, failed?: boolean, error?: string}|undefined} */
  get(assetId) {
    if (!assetId) return undefined;
    const entry = this.entries.get(assetId);
    if (!entry) {
      void this.load(assetId);
      return undefined;
    }
    return entry;
  }

  isLoading(assetId) {
    return this.pending.has(assetId);
  }

  setOnChange(listener) {
    this.onChange = listener;
  }

  scheduleNotify() {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    const flush = () => {
      this.notifyScheduled = false;
      this.onChange();
    };
    if (typeof queueMicrotask === "function") queueMicrotask(flush);
    else setTimeout(flush, 0);
  }

  async load(assetId) {
    if (this.entries.has(assetId) || this.pending.has(assetId)) return;
    const asset = this.findAsset(assetId);
    if (!asset || asset.archived) return;
    const task = (async () => {
      try {
        const bytes = await this.bridge.readAssetBytes(assetId);
        if (!bytes || bytes.length === 0) {
          this.entries.set(assetId, {
            failed: true,
            error: "素材文件为空",
          });
        } else if (bytes.length > this.mediaLimit) {
          this.entries.set(assetId, {
            failed: true,
            error: "素材过大，无法在工作台内预览",
          });
        } else if (isTextAsset(asset)) {
          const text = new TextDecoder().decode(bytes);
          this.entries.set(assetId, { text, url: urlForBytes(bytes, asset) });
        } else {
          this.entries.set(assetId, { url: urlForBytes(bytes, asset) });
        }
        this.trackUrl(this.entries.get(assetId));
      } catch (error) {
        this.failures += 1;
        this.entries.set(assetId, {
          failed: true,
          error: error?.message || "素材不可读",
        });
      } finally {
        this.pending.delete(assetId);
        this.scheduleNotify();
      }
    })();
    this.pending.set(assetId, task);
    await task;
  }

  trackUrl(entry) {
    if (entry && typeof entry.url === "string" && entry.url.startsWith("blob:")) {
      this.urls.add(entry.url);
    }
  }

  findAsset(assetId) {
    const data = this.bridge.currentProject?.();
    if (!data || !Array.isArray(data.assets)) return null;
    return data.assets.find((candidate) => candidate.id === assetId) || null;
  }

  clear() {
    for (const url of this.urls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Revoking an already-released URL must never break the workbench.
      }
    }
    this.urls.clear();
    this.entries.clear();
    this.pending.clear();
  }
}

function isTextAsset(asset) {
  const mime = String(asset.mime_type || "");
  return mime.startsWith("text/") || /\.(md|markdown|txt|csv|json)$/i.test(
    String(asset.filename || ""),
  );
}

function urlForBytes(bytes, asset) {
  const mime = String(asset.mime_type || "application/octet-stream");
  const canInline = typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    (mime.startsWith("image/") || mime.startsWith("video/") ||
      mime.startsWith("audio/"));
  if (canInline) {
    try {
      return URL.createObjectURL(new Blob([bytes], { type: mime }));
    } catch {
      // Fall through to the data URL representation.
    }
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Basename of a ScanResult relative_path ( /-separated). */
export function explorerEntryName(relativePath) {
  const path = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!path) return "";
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * Preview kind for Workspace Explorer (§28). Recognition ≠ editable.
 * PDF/DOCX stay "reference" until a real parser exists.
 */
export function explorerPreviewKind(entry) {
  if (!entry) return "unsupported";
  if (entry.kind === "directory") return "directory";
  const mime = String(entry.mime || "").toLowerCase();
  const name = explorerEntryName(entry.relative_path || entry.path || "");
  if (mime.startsWith("text/") || /\.(md|markdown|txt|text)$/i.test(name)) {
    return "text";
  }
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name)) {
    return "image";
  }
  if (mime.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(name)) {
    return "video";
  }
  if (mime.startsWith("audio/") || /\.(mp3|wav|m4a|ogg)$/i.test(name)) {
    return "audio";
  }
  if (
    entry.suggested_role === "reference" ||
    mime === "application/pdf" ||
    /word|document/.test(mime) ||
    /\.(pdf|docx?|odt|rtf)$/i.test(name)
  ) {
    return "reference";
  }
  return "unsupported";
}

/** Chinese type label for the explorer file list (§27). */
export function explorerTypeLabel(entry) {
  const kind = explorerPreviewKind(entry);
  const name = explorerEntryName(entry?.relative_path || "");
  return {
    directory: "文件夹",
    text: /\.(md|markdown)$/i.test(name) ? "Markdown" : "TXT",
    image: "图片",
    video: "视频",
    audio: "音频",
    reference: /\.pdf$/i.test(name) ? "PDF" : "DOCX",
    unsupported: "未识别",
  }[kind] || "未识别";
}

/** Recognizable status label from ScanResult.suggested_role / error. */
export function explorerStatusLabel(entry) {
  if (!entry) return "未知";
  if (entry.error) return "无法读取";
  const role = entry.suggested_role;
  return {
    stage: "建议阶段",
    folder: "文件夹",
    lesson: "建议课文",
    asset: "建议素材",
    reference: "建议参考",
    unsupported: "暂不支持",
  }[role] || "已识别";
}

/**
 * Filename-only filter (§37). Keeps matching files and their ancestor folders.
 * @param {Array<{relative_path: string, kind?: string}>} entries
 * @param {string} query
 */
export function filterExplorerEntries(entries, query) {
  const list = Array.isArray(entries) ? entries : [];
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return list.slice();
  const matched = new Set();
  for (const entry of list) {
    const rel = String(entry.relative_path || "").replaceAll("\\", "/");
    const name = explorerEntryName(rel).toLowerCase();
    if (!name.includes(needle) && !rel.toLowerCase().includes(needle)) continue;
    matched.add(rel);
    const parts = rel.split("/").filter(Boolean);
    let prefix = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
      matched.add(prefix);
    }
  }
  return list.filter((entry) =>
    matched.has(String(entry.relative_path || "").replaceAll("\\", "/"))
  );
}

/**
 * Nest flat ScanResult rows into a folder tree for the explorer.
 * @param {Array<{relative_path: string, kind?: string}>} entries
 */
export function buildExplorerTree(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byPath = new Map();
  for (const entry of list) {
    const rel = String(entry.relative_path || "").replaceAll("\\", "/");
    if (!rel) continue;
    byPath.set(rel, {
      relative_path: rel,
      name: explorerEntryName(rel),
      kind: entry.kind === "directory" ? "directory" : "file",
      entry,
      children: [],
    });
  }
  const roots = [];
  for (const node of byPath.values()) {
    const slash = node.relative_path.lastIndexOf("/");
    if (slash < 0) {
      roots.push(node);
      continue;
    }
    const parentPath = node.relative_path.slice(0, slash);
    const parent = byPath.get(parentPath);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (nodes) => {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "zh");
    });
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}

/** Build a data/object URL for explorer media previews (reuse asset path). */
export function explorerUrlForBytes(bytes, mime) {
  return urlForBytes(bytes, { mime_type: mime || "application/octet-stream", filename: "" });
}

/** Editable mapping roles for import preview (§§30–31, 34). */
export const IMPORT_MAPPING_ROLES = [
  "stage",
  "lesson",
  "source",
  "asset",
  "reference",
  "ignore",
];

const IMPORT_MAPPING_ROLE_LABELS = {
  stage: "阶段",
  lesson: "课文",
  source: "源资料",
  asset: "素材",
  reference: "参考",
  ignore: "忽略",
};

/** Map ScanResult.suggested_role → editable mapping role. */
export function mappingRoleFromSuggested(role) {
  switch (role) {
    case "stage":
      return "stage";
    case "lesson":
      return "lesson";
    case "asset":
      return "asset";
    case "reference":
      return "reference";
    case "folder":
    case "unsupported":
    default:
      return "ignore";
  }
}

/**
 * Chinese label for a mapping role.
 * Pass `{ suggestion: true }` to prefix 建议 (advice, not fact).
 */
export function mappingRoleLabel(role, options = {}) {
  const base = IMPORT_MAPPING_ROLE_LABELS[role] || String(role || "");
  return options.suggestion ? `建议${base}` : base;
}

/**
 * Build an editable mapping preview from ScanResult rows.
 * Does not confirm and does not write Canonical.
 */
export function buildImportMappingPlan(root, entries) {
  const items = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const suggested = mappingRoleFromSuggested(entry.suggested_role);
      const hasError = Boolean(entry.error);
      const selected = !hasError && suggested !== "ignore";
      return {
        relative_path: String(entry.relative_path || "").replaceAll("\\", "/"),
        kind: entry.kind === "directory" ? "directory" : "file",
        mime: entry.mime ?? null,
        size: entry.size ?? null,
        suggested,
        mapping: suggested,
        selected,
        is_suggestion: true,
        error: entry.error ?? null,
      };
    })
    .filter((item) => item.relative_path.length > 0);
  return {
    root: String(root || ""),
    items,
    confirmed: false,
    confirmed_at: null,
  };
}

function cloneImportMappingPlan(plan) {
  return {
    root: plan?.root || "",
    confirmed: Boolean(plan?.confirmed),
    confirmed_at: plan?.confirmed_at ?? null,
    items: Array.isArray(plan?.items)
      ? plan.items.map((item) => ({ ...item }))
      : [],
  };
}

/** Toggle whether an entry is included. Does not confirm. */
export function setImportMappingSelected(plan, relativePath, selected) {
  const path = String(relativePath || "").replaceAll("\\", "/");
  const next = cloneImportMappingPlan(plan);
  next.confirmed = false;
  next.confirmed_at = null;
  for (const item of next.items) {
    if (item.relative_path === path) {
      item.selected = Boolean(selected);
      break;
    }
  }
  return next;
}

/** Change the mapping role for one entry. Does not confirm. */
export function setImportMappingRole(plan, relativePath, role) {
  const path = String(relativePath || "").replaceAll("\\", "/");
  const mapping = IMPORT_MAPPING_ROLES.includes(role) ? role : "ignore";
  const next = cloneImportMappingPlan(plan);
  next.confirmed = false;
  next.confirmed_at = null;
  for (const item of next.items) {
    if (item.relative_path === path) {
      item.mapping = mapping;
      if (mapping === "ignore") item.selected = false;
      else if (!item.selected) item.selected = true;
      break;
    }
  }
  return next;
}

/**
 * Collect the current plan as user-confirmed.
 * Does not write project.json / Canonical (Task 12).
 */
export function confirmImportMappingPlan(plan) {
  const next = cloneImportMappingPlan(plan);
  next.confirmed = true;
  next.confirmed_at = new Date().toISOString();
  return next;
}
