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
