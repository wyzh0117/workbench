// deno-fmt-ignore-file
/*
 * Rendering layer for the dependency-free desktop-first renderer.
 *
 * Every view is a pure function of the store's canonical data plus its UI
 * state.  The course map, the lesson editor, the preview and the completion
 * badges all read `app/authoring.js` projections, so no view can grow its own
 * copy of the course state.  Views never mutate project data: they only emit
 * `data-action` attributes that `main.js` binds.
 */

import {
  DOCUMENT_IMPORT_TYPE_LABELS,
  PROJECT_FILE_PICKER,
  documentImportExtension,
  documentImportTallyText,
  groupDocumentImportCandidates,
} from "./constants.js";
import { parseMarkdown, renderMarkdown } from "./markdown.js";
import {
  MEDIA_REQUIREMENT_TYPES,
  REQUIREMENT_TYPES,
  SEED_SOURCE_HINTS,
  SEED_TEXT_SOURCES,
  assetLabel,
  blockLabel,
  blockSizeView,
  courseMap,
  freeCellsFor,
  formatBytes,
  lessonView,
  placementGrid,
  nextStepLabel,
  requirementAnchorLabel,
  requirementBacklog,
  usagesForAsset,
} from "./authoring.js";
import {
  AI_OFFLINE_PROVIDER_ID,
  aiApiProtocolChoices,
  aiChangeDraftDiffRows,
  aiContextPreviewLines,
  aiIsOfflineConnection,
} from "./ai.js";
import {
  buildExplorerTree,
  explorerEntryName,
  explorerStatusLabel,
  explorerTypeLabel,
  filterExplorerEntries,
  IMPORT_MAPPING_ROLES,
  mappingRoleLabel,
  markdownToHtml,
} from "./canvas.js";
import {
  buildPublicationProjection,
  fitPageRect,
  getAvailablePublicationAdapters,
  getPublicationCapabilities,
  PAGE_SIZE_PRESETS,
  pageGrid,
  projectPageGeometry,
  resolvePageSize,
} from "./publication.js";

const EDITOR_MODES = [
  ["writing", "正文"],
  ["structure", "结构"],
  ["layout", "排版"],
  ["preview", "预览"],
];
const RIGHT_PANELS = [
  ["media", "媒体"],
  ["requirements", "待补"],
  ["status", "状态"],
  ["assistant", "AI 助手"],
  ["properties", "属性"],
  ["versions", "版本"],
];
const BLOCK_PALETTE = [
  ["paragraph", "正文"],
  ["heading", "标题"],
  ["quote", "引用"],
  ["callout", "提示"],
  ["code", "代码"],
  ["divider", "分隔线"],
  ["media", "媒体"],
  ["placeholder", "占位符"],
];
const RIGHT_PANEL_LABELS = Object.fromEntries(RIGHT_PANELS);
const MODE_LABELS = Object.fromEntries(EDITOR_MODES);

/**
 * The user's home directory, or "" — a path label is a nicety, never a failure.
 *
 * `Deno.env.get` does not return undefined when the process lacks env
 * permission, it throws, so an optional-looking read here can blank the whole
 * start page. The browser and the Tauri webview have no `Deno` at all.
 */
function readHomeDirectory() {
  try {
    return String(globalThis.Deno?.env?.get?.("HOME") || globalThis.process?.env?.HOME || "");
  } catch {
    return "";
  }
}

export function createViews(store) {
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  const assetPreview = (asset) =>
    store.assetPreview.get(asset && asset.id, asset);
  const retryAssetPreviewButton = (asset, compact = false) =>
    `<button type="button" class="${compact ? "icon-button" : "text-button"}" data-action="retry-asset-preview" data-asset="${esc(asset.id)}" aria-label="重试预览：${esc(asset.title || asset.filename)}" title="重试预览">${compact ? "↻" : "重试预览"}</button>`;
  const previewUrl = (asset) => {
    const preview = assetPreview(asset);
    return preview && preview.url ? preview.url : "";
  };
  const previewText = (asset) => {
    const preview = assetPreview(asset);
    return preview && typeof preview.text === "string" ? preview.text : "";
  };
  const mediaDuration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const rest = String(total % 60).padStart(2, "0");
    return minutes >= 60
      ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${rest}`
      : `${minutes}:${rest}`;
  };
  const isImageLike = (asset) =>
    asset && (asset.type === "image" || asset.type === "gif");
  const isAttachmentAsset = (asset) => {
    if (!asset) return false;
    const name = String(asset.filename || "");
    const mime = String(asset.mime_type || "");
    return /\.(pdf|docx?|xlsx?|pptx?|zip)$/i.test(name) ||
      /application\/(pdf|.*word|.*document|.*sheet|.*presentation|zip)/i.test(
        mime,
      ) ||
      (asset.type === "document" && !previewText(asset) &&
        !/\.(md|markdown|txt|csv|json)$/i.test(name));
  };
  /**
   * The one click-to-enlarge control for every media surface (§12.4).  Its
   * geometry lives in `styles.css` (`.asset-image-zoom`) so a card can size the
   * frame it owns instead of fighting an inline `object-fit: cover`.
   */
  const mediaOpenButton = (asset, src, label, alt = label, focusKey = `asset-view-${asset.id}`) =>
    `<button type="button" class="asset-image-zoom" data-focus-key="${esc(focusKey)}" data-action="open-asset-image" data-asset="${esc(asset.id)}" aria-label="放大查看 ${esc(label)}" title="点击查看大图"><img class="asset-image" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" /></button>`;
  /**
   * A real trash glyph.  The emoji (U+1F5D1) depends on an emoji font being
   * installed and inherited `color`, which is how a delete control could end
   * up invisible; an inline SVG always renders and follows `currentColor`.
   */
  const TRASH_ICON = `<svg class="trash-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6.2 1.8h3.6l.5 1.1H13v1.5H3V2.9h2.7l.5-1.1ZM4.4 5.6h7.2l-.55 7.9a1.1 1.1 0 0 1-1.1 1.03H6.05A1.1 1.1 0 0 1 4.95 13.5L4.4 5.6Z"/></svg>`;
  const PREFLIGHT_ISSUE_LABELS = {
    canonical_invalid: "课程内容不完整",
    missing_asset: "引用的素材文件找不到",
    unsafe_path: "素材位置不安全",
    unsupported_format: "当前格式暂不支持",
    open_requirements: "还有待补内容",
    media_downgrade: "部分媒体会降级为附件说明",
    layout_overflow: "内容超出排版范围",
  };
  const issueMessage = (issue) => {
    const message = typeof issue?.message === "string" ? issue.message.trim() : "";
    return message || PREFLIGHT_ISSUE_LABELS[issue?.code] || "导出前检查发现一项需要处理的问题";
  };
  const issueDiagnostics = (issue) => {
    const code = typeof issue?.code === "string" ? issue.code.trim() : "";
    const path = typeof issue?.path === "string" ? issue.path.trim() : "";
    if (!code && !path) return "";
    const lines = [code ? `代码：${code}` : "", path ? `位置：${path}` : ""].filter(Boolean).join("\n");
    return `<details class="diagnostic"><summary>显示技术信息</summary><code>${esc(lines)}</code></details>`;
  };

  /**
   * The identity of the preview a card paints. Emitted on the frame in EVERY
   * state — waiting, loading, ready and error — because a frame that stops
   * advertising its key cannot be found again to be repainted, and the preview
   * cache pins an entry to the card that is showing it.
   */
  const previewKey = (asset) =>
    asset && asset.id && typeof store.assetPreview.keyFor === "function"
      ? store.assetPreview.keyFor(asset)
      : "";

  /**
   * The one box every preview state paints inside.
   *
   * Waiting, reading, ready and failed are its *content*, so a card's height is
   * the frame's height and never changes when a preview settles — a changing
   * card height moved the scroll offset and the observer boundaries, which is
   * half of the twitching. The two data attributes are also how `main.js`
   * repaints just this frame when a preview settles instead of rebuilding the
   * whole screen, and how the cache knows which entries are still on screen.
   */
  const previewFrame = (asset, surface, inner, attrs = "") => {
    const key = previewKey(asset);
    return `<div class="asset-preview-frame asset-preview-frame--${surface}"${
      key
        ? ` data-asset-preview-key="${esc(key)}" data-asset-preview-asset="${
          esc(asset.id)
        }"`
        : ""
    } data-asset-preview-surface="${surface}"${attrs}>${inner}</div>`;
  };

  /**
   * Thumbnails: images/GIF as <img>, video as a muted poster card, Markdown as
   * text, PDF/DOCX as attachment cards — never a blank board.
   */
  const assetThumb = (asset) => {
    const preview = assetPreview(asset);
    const label = asset.title || asset.filename || "素材";
    if (preview && preview.failed) {
      return `<span class="asset-thumb" role="img" aria-label="${esc(label)}预览失败">⚠<small>预览失败</small><small>${esc(preview.error || "素材不可读")}</small><small>请检查文件或重新导入</small></span>`;
    }
    if (preview?.released) {
      // Memory budget took this settled thumbnail back. It is not "coming soon",
      // so offer the one thing that is true: load it again on request.
      return `<span class="asset-thumb" title="为了控制内存，这张缩略图已释放" style="flex-direction:column;gap:3px;padding:6px">${esc(label)}<small>缩略图已释放</small>${retryAssetPreviewButton(asset, true)}</span>`;
    }
    if (!preview || preview.loading) {
      const pending = Boolean(preview?.pending);
      return `<span class="asset-thumb" title="${pending ? "正在读取素材预览" : "靠近素材时加载预览"}">${preview?.loading ? pending ? "正在读取" : "等待加载" : "预览未加载"}</span>`;
    }
    const url = preview.url || "";
    if (url && isImageLike(asset)) {
      return `<img class="asset-image" src="${esc(preview.thumbnailUrl || url)}" alt="${
        esc(label)
      }" loading="lazy" />`;
    }
    if (url && asset.type === "video" && preview.posterUrl) {
      return `<img class="asset-image asset-video" src="${
        esc(preview.posterUrl)
      }" alt="${esc(label)} · 视频封面" loading="lazy" />`;
    }
    const text = preview.text;
    if (typeof text === "string") {
      return `<span class="asset-doc" title="打开媒体库查看完整内容">${
        esc(text.replace(/\s+/g, " ").trim().slice(0, 60) || "空文档")
      }</span>`;
    }
    if (isAttachmentAsset(asset) || asset.type === "document" ||
      asset.type === "other" || asset.type === "audio") {
      const ext = String(asset.filename || "").split(".").pop() ||
        assetLabel(asset.type);
      return `<span class="asset-attachment" title="${
        esc(label)
      }"><span class="asset-attachment-icon">📎</span><small>${
        esc(String(ext).toUpperCase())
      }</small><span>${esc(label)}</span>${
        isAttachmentAsset(asset)
          ? "<small>参考文件 · 当前环境没有内嵌缩略图</small>"
          : asset.type === "other"
          ? "<small>当前格式不支持内嵌预览</small>"
          : ""
      }</span>`;
    }
    return `<span class="asset-thumb" title="当前格式暂不支持预览">${assetLabel(asset.type)} · 暂无预览</span>`;
  };

  const mediaLibraryPreview = (asset) => {
    const preview = assetPreview(asset);
    const label = asset.title || asset.filename || "素材";
    const url = preview?.url || "";
    if (preview?.failed) {
      return `<div class="asset-thumb asset-preview-error" role="group" aria-label="${esc(label)} · ${esc(assetLabel(asset.type))} 预览失败" style="flex-direction:column;gap:3px;padding:6px"><b>${esc(label)} · ${esc(assetLabel(asset.type))} 预览失败</b><small>${esc(preview.error || "素材不可读")}</small>${retryAssetPreviewButton(asset)}</div>`;
    }
    if (isImageLike(asset) && url) {
      return mediaOpenButton(asset, preview.thumbnailUrl || url, label, label, `asset-card-view-${asset.id}`);
    }
    if (preview?.pdf && url) {
      // No inline height: the frame owns it, so a PDF card is exactly as tall as
      // the placeholder it replaces.
      return `<iframe class="asset-pdf-preview" src="${esc(url)}" title="${esc(label)} · PDF 第一页预览" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
    }
    if (asset.type === "video" && url && preview.posterUrl) {
      const duration = mediaDuration(preview.durationSeconds);
      const poster = mediaOpenButton(asset, preview.posterUrl, label, `${label} · 视频首帧`, `asset-card-view-${asset.id}`);
      return duration
        ? `<div class="asset-media-duration">${poster}<small class="muted">${duration}</small></div>`
        : poster;
    }
    if (asset.type === "audio" && url) {
      const player = `<audio class="asset-audio" src="${esc(url)}" controls preload="metadata" aria-label="${esc(label)}"></audio>`;
      const duration = mediaDuration(preview.durationSeconds);
      return duration
        ? `<div class="asset-media-duration">${player}<small class="muted">${duration}</small></div>`
        : player;
    }
    return assetThumb(asset);
  };

  /**
   * The media body of one editor block, on its own so a settled preview can be
   * written back into the frame that already exists.
   */
  const mediaSlotBody = (asset, blockId = "") => {
    const preview = assetPreview(asset);
    const url = preview?.url || "";
    const text = preview?.text;
    if (asset.type === "video" && url && preview.posterUrl) {
      return mediaOpenButton(asset, preview.posterUrl, asset.title || asset.filename, `${asset.filename} · 视频首帧`, `asset-slot-view-${blockId || asset.id}`);
    }
    if (asset.type === "audio" && url) {
      return `<audio class="asset-audio" src="${esc(url)}" controls preload="metadata"></audio>`;
    }
    if ((asset.type === "image" || asset.type === "gif") && url) {
      return mediaOpenButton(asset, asset.type === "gif" ? preview.thumbnailUrl : url, asset.title || asset.filename, asset.title || asset.filename, `asset-slot-view-${blockId || asset.id}`);
    }
    if (preview?.pdf && url) {
      return `<iframe class="media-pdf-preview" src="${esc(url)}" title="${esc(asset.title || asset.filename)} · PDF 第一页预览" loading="lazy" referrerpolicy="no-referrer" style="display:block;width:100%;height:420px;border:0;background:#f4f4f4"></iframe>`;
    }
    // Markdown and other text bundles are material too: show the beginning
    // of the real file instead of an empty slot.
    if (typeof text === "string") {
      return `<pre class="media-document">${
        esc(text.slice(0, 1200) || "（空文档）")
      }</pre>`;
    }
    if (preview && preview.failed) {
      return `<div class="media-slot failed"><b>${esc(asset.filename)} · ${esc(assetLabel(asset.type))} 预览失败</b><small>${esc(preview.error || "素材不可读")}</small><small>请检查文件内容，或在媒体库替换为可读取的文件。</small>${retryAssetPreviewButton(asset)}</div>`;
    }
    if (preview?.loaded) {
      // This file is readable, but the current WebView has no renderer.
      return `<div class="media-slot attachment">📎 ${
        esc(asset.title || asset.filename)
      }（${esc(assetLabel(asset.type))} · ${esc(asset.type === "other" ? "当前格式不支持内嵌预览" : "参考文件，当前没有正文解析")})</div>`;
    }
    if (preview?.released) {
      return `<div class="media-slot loading">缩略图已释放${retryAssetPreviewButton(asset)}</div>`;
    }
    if (preview?.loading) {
      return `<div class="media-slot loading">${preview.pending ? "正在读取素材预览…" : "靠近素材时加载预览…"}</div>`;
    }
    return `<div class="media-slot failed"><b>${esc(asset.filename)} 暂不可用</b><small>${asset.archived ? "素材已归档" : "找不到可读取的素材预览"}；请在媒体库检查或重新添加。</small></div>`;
  };

  const previewMediaBody = (asset, block = null) => {
    const preview = assetPreview(asset);
    const url = preview?.url || "";
    if (preview?.failed) {
      return `<div class="preview-media-failed"><b>${esc(asset.filename)} · ${esc(assetLabel(asset.type))} 预览失败</b><p>${esc(preview.error || "素材不可读")}</p><p class="muted">请检查文件内容，或在媒体库替换为可读取的文件。</p>${retryAssetPreviewButton(asset)}</div>`;
    }
    if (preview?.released) {
      return `<div class="preview-placeholder">缩略图已释放，可重新读取 ${esc(asset.filename)}${retryAssetPreviewButton(asset)}</div>`;
    }
    if (preview?.loading) {
      return `<div class="preview-placeholder">${preview.pending ? "正在读取" : "等待加载"} ${esc(asset.filename)}…</div>`;
    }
    if ((asset.type === "image" || asset.type === "gif") && url) {
      const label = asset.title || asset.filename;
      return `<figure>${mediaOpenButton(asset, asset.type === "gif" ? preview.thumbnailUrl : url, label, label, `asset-preview-view-${block?.id || asset.id}`)}<figcaption>${esc(label)}</figcaption></figure>`;
    }
    if (asset.type === "video" && url && preview.posterUrl) {
      return `<figure>${mediaOpenButton(asset, preview.posterUrl, asset.title || asset.filename, `${asset.filename} · 视频首帧`, `asset-preview-view-${block?.id || asset.id}`)}<figcaption>${
        esc(asset.title || asset.filename)
      }</figcaption></figure>`;
    }
    if (asset.type === "audio" && url) {
      return `<figure><audio src="${esc(url)}" controls preload="metadata"></audio><figcaption>${
        esc(asset.title || asset.filename)
      }</figcaption></figure>`;
    }
    if (preview?.pdf && url) {
      return `<figure class="preview-pdf"><iframe src="${esc(url)}" title="${esc(asset.title || asset.filename)} · PDF 第一页预览" loading="lazy" referrerpolicy="no-referrer" style="display:block;width:100%;height:560px;border:0;background:#f4f4f4"></iframe><figcaption>${esc(asset.title || asset.filename)} · PDF 第一页</figcaption></figure>`;
    }
    const text = preview?.text;
    if (typeof text === "string") {
      const sample = text.slice(0, 4000);
      const isMarkdown = asset.mime_type === "text/markdown" || /\.(md|markdown)$/i.test(asset.filename || "");
      return `<figure class="preview-document"><figcaption>${
        esc(asset.title || asset.filename)
      } · ${isMarkdown ? "Markdown 摘要" : "文本摘要"}</figcaption>${
        isMarkdown
          ? `<div class="preview-markdown">${renderMarkdown(sample, { resolveImage: markdownImageResolver(block || { settings: {} }) })}</div>`
          : `<pre class="preview-markdown">${esc(sample || "（空文档）")}</pre>`
      }</figure>`;
    }
    if (preview?.loaded) return `<p class="preview-attachment">📎 ${
      esc(asset.title || asset.filename)
    }（${esc(assetLabel(asset.type))} · ${esc(asset.type === "other" ? "当前格式不支持内嵌预览" : "参考文件，当前没有正文解析")})</p>`;
    return `<div class="preview-media-failed"><b>${esc(asset.filename)} 暂不可用</b><p>${asset.archived ? "素材已归档" : "找不到可读取的素材预览"}；请在媒体库检查或重新添加。</p></div>`;
  };

  /**
   * The enlarged media modal's body, on its own so a video or image that
   * finishes loading paints itself without rebuilding the screen behind it.
   */
  const overlayMediaBody = (asset) => {
    const label = asset.title || asset.filename || "素材";
    const canPreview = !asset.archived &&
      (isImageLike(asset) || asset.type === "video");
    const preview = canPreview ? assetPreview(asset) : null;
    if (!canPreview) return `<p class="preview-media-failed">素材当前不可用。</p>`;
    const viewerSource = store.ui.assetImagePreviewSource?.asset_id === asset.id
      ? store.ui.assetImagePreviewSource.url
      : "";
    if (asset.type === "video" && viewerSource) {
      const poster = !preview?.failed ? preview?.posterUrl : "";
      return `<div class="asset-video-stage" style="display:grid;place-items:center;position:relative"><video class="asset-preview-video" src="${esc(viewerSource)}"${poster ? ` poster="${esc(poster)}"` : ""} controls preload="none" playsinline aria-label="${esc(label)}" style="display:block;margin:12px auto;max-height:72vh;max-width:100%"></video><button type="button" class="asset-video-play" data-action="play-asset-video" aria-label="播放视频" title="播放视频" style="align-items:center;background:#111b;border:0;border-radius:50%;color:white;cursor:pointer;display:flex;font-size:28px;height:64px;justify-content:center;left:50%;position:absolute;top:50%;transform:translate(-50%,-50%);width:64px">▶</button></div>${
        !preview?.failed && preview?.width && preview?.height
          ? `<small class="muted" style="text-align:center">${preview.width} × ${preview.height}</small>`
          : ""
      }`;
    }
    if (preview?.failed) {
      return `<div class="preview-media-failed"><b>${esc(asset.filename)} · ${esc(assetLabel(asset.type))} 预览失败</b><p>${esc(preview.error || "素材不可读")}</p>${retryAssetPreviewButton(asset)}</div>`;
    }
    if (preview?.loading) {
      return `<div class="preview-placeholder">正在读取 ${esc(label)}…</div>`;
    }
    if (asset.type === "video" && preview?.url && preview.posterUrl) {
      return `<div class="asset-video-stage" style="display:grid;place-items:center;position:relative"><video class="asset-preview-video" src="${esc(preview.url)}" poster="${esc(preview.posterUrl)}" controls preload="none" playsinline aria-label="${esc(label)}" style="display:block;margin:12px auto;max-height:72vh;max-width:100%"></video><button type="button" class="asset-video-play" data-action="play-asset-video" aria-label="播放视频" title="播放视频" style="align-items:center;background:#111b;border:0;border-radius:50%;color:white;cursor:pointer;display:flex;font-size:28px;height:64px;justify-content:center;left:50%;position:absolute;top:50%;transform:translate(-50%,-50%);width:64px">▶</button></div>${
        preview.width && preview.height
          ? `<small class="muted" style="text-align:center">${preview.width} × ${preview.height}</small>`
          : ""
      }`;
    }
    if (preview?.url) {
      return `<img class="asset-image ${asset.type === "gif" ? "asset-gif-preview" : ""}" ${asset.type === "gif" ? 'data-animated-preview="true"' : ""} src="${esc(preview.url)}" alt="${esc(label)}" style="display:block;margin:12px auto;max-height:72vh;max-width:100%;object-fit:contain" />${
        preview.width && preview.height
          ? `<small class="muted" style="text-align:center">${preview.width} × ${preview.height}</small>`
          : ""
      }`;
    }
    return `<p class="preview-media-failed">${esc(label)} 暂无可显示的预览。</p>`;
  };

  /**
   * The surfaces that paint an asset preview, keyed by the
   * `data-asset-preview-surface` written on their frame. `main.js` repaints a
   * settled preview through this table; a surface that is not here (a Markdown
   * image inside a rich editor, whose markup `markdown.js` owns) is left to the
   * ordinary rebuild path.
   */
  const assetPreviewSurfaces = {
    card: (asset) => mediaLibraryPreview(asset),
    thumb: (asset) => assetThumb(asset),
    block: (asset) => mediaSlotBody(asset),
    preview: (asset, block) => previewMediaBody(asset, block),
    overlay: (asset) => overlayMediaBody(asset),
  };

  /**
   * Frame content for one asset on one surface, or null when that surface has
   * no in-place renderer. Null is what makes the cache fall back to `notify()`
   * for it — and only for it.
   */
  function assetPreviewFrameInner(asset, surface, block = null) {
    const render = assetPreviewSurfaces[surface];
    if (!render || !asset) return null;
    return render(asset, block);
  }

  /* ---------------------------------------------------------------- shell */

  /** `last_opened_at` as the start page reads it: recent, then dated. */
  function registryTimeLabel(value) {
    const stamp = Date.parse(String(value || ""));
    if (!Number.isFinite(stamp)) return "上次打开时间未知";
    const minutes = Math.floor((Date.now() - stamp) / 60000);
    if (minutes < 1) return "刚刚打开";
    if (minutes < 60) return `${minutes} 分钟前打开`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前打开`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前打开`;
    const date = new Date(stamp);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日打开${sameYear ? "" : ` · ${date.getFullYear()} 年`}`;
  }

  /** A path the row can show without overflowing: home is `~`, the tail wins. */
  function shortRegistryPath(value) {
    const raw = String(value || "").trim();
    if (!raw) return "位置未知";
    const home = readHomeDirectory();
    const shown = home && raw.startsWith(home) ? `~${raw.slice(home.length)}` : raw;
    const parts = shown.split("/").filter(Boolean);
    if (shown.length <= 46 || parts.length < 3) return shown;
    return `…/${parts.slice(-2).join("/")}`;
  }

  /**
   * §5 — every project this install has opened, newest first.
   *
   * The list is the registry, not a scan: a row whose folder no longer answers
   * stays visible and offers 重新定位, because forgetting a project the user
   * worked on is worse than showing a stale one. Opening a row reads that
   * folder's `project.json` and checks its id — the same route 「打开项目文件夹」
   * takes — so a moved or replaced folder cannot be adopted under this title.
   */
  function registryListView(esc) {
    const rows = store.ui.registryProjects || [];
    const currentId = store.data.project?.id || "";
    if (!rows.length) {
      return `<section class="project-library"><div class="library-head"><div><span class="eyebrow">项目库</span><h2>最近打开</h2></div><span class="muted small">本机项目</span></div>
        <div class="library-empty"><span class="empty-icon" aria-hidden="true">⌂</span><div><b>还没有最近项目</b><p class="small muted">新建课程，或打开一个已有的 Workbench 项目文件夹。项目文件始终保存在本机。</p></div></div>
      </section>`;
    }
    return `<section class="project-library">
      <div class="library-head"><div><span class="eyebrow">项目库</span><h2>最近打开</h2></div><small class="muted">${rows.length} 个项目 · 按最近打开排序</small></div>
      <ul class="library-list">${
      rows.map((row) => {
        const path = String(row.project_path || "");
        const isCurrent = row.project_id && row.project_id === currentId;
        return `<li class="library-row${row.available ? "" : " is-stale"}">
          <div class="library-row-main">
            <div class="library-row-title"><b class="library-title">${esc(row.project_title || shortRegistryPath(path))}${
          isCurrent ? '<span class="library-badge">当前</span>' : ""
        }${row.copy ? '<span class="library-badge copy">副本</span>' : ""}</b><small class="library-time">${
          row.available ? esc(registryTimeLabel(row.last_opened_at)) : "找不到文件夹"
        }</small></div>
            <small class="library-path" title="${esc(path)}">${esc(shortRegistryPath(path))}</small>
          </div>
          <div class="library-row-actions">${
          row.available
            ? `<button class="primary" data-action="open-registry-project" data-project-path="${
                esc(path)
              }">${isCurrent ? "继续工作" : "打开"}</button>`
            : `<button class="secondary" data-action="relocate-registry-project" data-project-id="${
                esc(row.project_id)
              }">重新定位</button>`
        }<button class="text-button" data-action="remove-registry-project" data-project-id="${
          esc(row.project_id)
        }" data-project-path="${esc(path)}">从列表移除</button></div>
        </li>`;
      }).join("")
    }
      </ul>
      <p class="small muted">「从列表移除」只是把这一条从启动页去掉，不会删除或改写磁盘上的课程文件。</p>
    </section>`;
  }

  /**
   * §4.4 — one `project.id` found at two live folders.
   *
   * The registry refuses to guess which one the user meant, so the choice is
   * asked for outright: keeping the row pointed at the old folder, moving it to
   * the new one, or keeping both labelled as copies. Nothing here edits a
   * course — the identity is the only thing at stake.
   */
  function registryCopyModal(esc) {
    const copy = store.ui.registryCopy;
    if (!copy) return "";
    return `<div class="overlay"><div class="conflict-modal modal" role="dialog" aria-modal="true" aria-labelledby="registry-copy-title" tabindex="-1" data-stop-click="true">
      <div class="modal-head"><div><span class="eyebrow">项目身份检查</span><h2 id="registry-copy-title">检测到同一个 Workbench 项目的两个副本</h2></div></div>
      <p class="muted">同一个项目标识出现在两个文件夹，登记表不会替你决定哪一个才是你要用的那个。</p>
      <p class="small muted"><b>${esc(copy.project_title || copy.project_id || "")}</b></p>
      <ul class="library-copy-paths">
        <li><span>登记表里记录的位置</span><code title="${esc(copy.existing_path || "")}">${esc(shortRegistryPath(copy.existing_path))}</code></li>
        <li><span>这次打开的位置</span><code title="${esc(copy.opened_path || "")}">${esc(shortRegistryPath(copy.opened_path))}</code></li>
      </ul>
      <div class="modal-actions">
        <button class="secondary" data-action="registry-copy-update-location">更新项目位置</button>
        <button class="secondary" data-action="registry-copy-keep-both">保留两条记录（标注副本）</button>
        <button class="primary" data-action="registry-copy-dismiss">先不动登记表</button>
      </div>
    </div></div>`;
  }

  function launcherView(esc) {
    const project = store.data.project;
    const map = courseMap(store.data, store.ui.activeId);
    // "继续工作" must name the lesson it will actually resume: the position the
    // session restored when there is one, otherwise the first unfinished lesson.
    const restoredId = map.lessons.some((lesson) => lesson.id === store.ui.activeId)
      ? store.ui.activeId
      : null;
    const resumeId = restoredId || store.resumeLessonId();
    const resume = map.lessons.find((lesson) => lesson.id === resumeId) || null;
    const native = store.bridge.isNative();
    return `<section class="launcher">
      <header class="launcher-intro"><div class="launcher-orb" aria-hidden="true">✦</div><div><p class="eyebrow">AI COURSE WORKBENCH</p><h1>把一套课程，从想法做到发布</h1><p class="muted launcher-copy">课程内容保存在本机；正文、待补、素材、排版和版本都在同一个工作台里。</p></div></header>
      <section class="launcher-resume" aria-labelledby="launcher-resume-title"><div class="launcher-section-head"><div><span class="eyebrow">当前项目</span><h2 id="launcher-resume-title">继续你上次的工作</h2></div></div><div class="recent-card"><div><span class="eyebrow">${esc(project.title)}</span><h3>${resume ? `${esc(resume.code)}｜${esc(resume.title)}` : "课程内容尚未开始"}</h3><p class="muted">${
      resume
        ? `${resume.progress.complete
            ? "这一课已完成"
            : esc(resume.progress.reasons[0] || "可以继续编辑")
        }`
        : "新建课程或导入资料后，当前工作会显示在这里。"
    }</p>${map.lesson_count ? `<div class="progress-track"><span style="width:${map.progress}%"></span></div><small class="muted">整门课程 ${map.complete_count}/${map.lesson_count} 课完成 · 待补 ${map.open_requirements} 项</small>` : ""}</div><button class="primary" data-action="enter-project">继续工作 <span aria-hidden="true">→</span></button></div></section>
      <section class="launcher-start" aria-labelledby="launcher-start-title"><div class="launcher-section-head"><div><span class="eyebrow">项目入口</span><h2 id="launcher-start-title">新建、打开或导入</h2><p class="muted">先选项目入口，再决定要继续编辑的课程内容。</p></div></div><div class="launcher-choice-grid"><article class="launcher-choice"><span class="launcher-choice-index">01 · 从头开始</span><h3>新建课程</h3><p class="muted">创建一个本机 Workbench 项目，再从课程地图搭建结构。</p><button class="primary big" data-action="new-project">新建课程</button></article><article class="launcher-choice"><span class="launcher-choice-index">02 · 已有项目</span><h3>${native ? "打开项目文件夹" : "打开现有项目"}</h3><p class="muted">继续一个已经创建的 Workbench 项目；不会覆盖其他项目。</p><button class="secondary big" data-action="${native ? "open-project-dir" : "open-file"}">${native ? "选择项目文件夹" : "打开项目文件"}</button>${native ? "" : PROJECT_FILE_PICKER}</article><article class="launcher-choice"><span class="launcher-choice-index">03 · 导入资料</span><h3>从文件夹开始</h3><p class="muted">只读扫描原始资料，确认映射后才会导入选中的内容。</p><button class="secondary big" data-action="import-folder">选择资料文件夹</button></article></div></section>
      ${registryListView(esc)}
      <p class="small muted launcher-footnote">${
      native
        ? "可以选择新建课程、打开已有 Workbench 项目，或导入已有文件夹（只读扫描，确认前不会改写原文件）。"
        : "可以打开现有课程，也可以先新建一门课程。导入已有文件夹请使用桌面应用。"
    } 手上已经有课程概论、大纲、教材目录、文章、表格或 AI 对话时：进入课程后打开「课程地图」，粘贴进去先生成课程地图草稿，确认后才创建正式内容。</p>
    </section>${overlay()}<div class="toast-slot" data-chrome-toast>${toast()}</div>`;
  }

  const launcher = () => launcherView(esc);
  const overlay = () => overlayView(esc);
  const toast = () => toastView(esc);

  function shellView() {
    const item = store.currentItem();
    const readingMode = store.ui.route === "editor" && store.ui.mode === "preview";
    return `<div class="shell ${
      store.ui.leftCollapsed ? "left-collapsed" : ""
    } ${store.ui.rightCollapsed ? "right-collapsed" : ""} ${readingMode ? "reading-mode" : ""}">
      ${topbarView(item)}
      <div class="workspace">
        ${leftPanelView()}
        <main class="center" tabindex="-1">${centerView()}</main>
        ${rightPanelView()}
      </div>
      ${statusbarView(item)}
    </div>${overlay()}<div class="toast-slot" data-chrome-toast>${toast()}</div>`;
  }

  /**
   * The save indicator on its own, so an autosave can refresh just this chip
   * (`patchChrome`) instead of rebuilding the editor the user is typing in.
   */
  function saveStateView() {
    const saveHint = store.saveStatus === "已保存"
      ? "课程内容已保存"
      : store.saveStatus === "正在保存…"
      ? "正在保存课程内容"
      : store.saveStatus === "外部修改冲突"
      ? "保存已暂停；课程文件与当前编辑内容存在差异，请先处理提示"
      : store.saveStatus === "保存结果待核验"
      ? "保存结果暂时无法确认；自动保存已暂停，请核验磁盘结果"
      : store.saveStatus === "保存失败"
      ? "这次没有保存成功；请查看提示后重试"
      : "课程内容的保存状态";
    return `<span class="save-state ${
      store.saveStatus === "保存失败" || store.saveStatus === "外部修改冲突" || store.saveStatus === "保存结果待核验"
        ? "error"
        : ""
    }" data-chrome-save title="${saveHint}">${
      store.saveStatus === "已保存" ? "✓ " : ""
    }${esc(store.saveStatus)}${store.uncertainMutation ? ` <button type="button" class="text-button" data-action="verify-save-result" aria-label="核验磁盘结果" ${store.uncertainMutationPending ? "disabled" : ""}>${store.uncertainMutationPending ? "正在核验…" : "核验磁盘结果"}</button>` : ""}</span>`;
  }

  function topbarView(item) {
    const map = courseMap(store.data, item ? item.id : null);
    const editLessonInWorkbench = item &&
      store.ui.editingLessonTitleId === item.id &&
      store.ui.editingLessonTitleSurface === "workbench";
    return `<header class="topbar"><div class="brand"><button class="secondary launcher-return" data-action="return-launcher" aria-label="返回项目选择；当前项目不会关闭" title="返回项目选择；当前项目不会关闭">⌂ <span>项目选择</span></button><span class="brand-mark" aria-hidden="true">✦</span><span class="brand-title">AI Course Workbench</span></div>${
      store.ui.editingProjectTitle && store.ui.editingProjectTitleSurface === "topbar"
        ? `<div class="project-name editing"><span class="dot"></span><input class="project-title-input" data-project-title data-focus-key="project-title" value="${
          esc(store.data.project.title)
        }" aria-label="课程标题" /><span class="project-title-hint">Enter 保存 · Esc 取消</span></div>`
        : `<div class="project-name" data-action="edit-project-title" role="button" tabindex="0" title="点击修改课程标题"><span class="dot"></span><span class="project-title-text">${
          esc(store.data.project.title)
        }</span><span class="chevron">⌄</span></div>`
    }<div class="lesson-switch">${
      item
        ? `<button class="icon-button" data-action="prev-lesson" aria-label="打开上一课" title="打开上一课" ${
          map.previous_id ? "" : "disabled"
        }>‹</button>${editLessonInWorkbench
          ? `<input class="lesson-title-inline" data-lesson-title-inline data-id="${item.id}" data-focus-key="lesson-title-inline" aria-label="课程标题" value="${esc(item.title)}" />`
          : `<button class="lesson-pill" data-action="rename-lesson" data-title-surface="workbench" data-id="${item.id}" title="点击修改当前课程标题">${esc(item.code)}｜${esc(item.title)}</button>`
        }<button class="icon-button" data-action="next-lesson" aria-label="打开下一课" title="打开下一课" ${
          map.next_id ? "" : "disabled"
        }>›</button>`
        : ""
    }</div><div class="top-actions">${saveStateView()}<button class="icon-button" data-action="undo" aria-label="撤销上一次编辑" title="撤销上一次编辑">↶</button><button class="icon-button" data-action="redo" aria-label="恢复上一次编辑" title="恢复上一次编辑">↷</button><button class="secondary" data-action="ai-toggle-settings" aria-haspopup="dialog">设置</button><button class="secondary" data-action="save-project">保存</button><button class="secondary" data-action="save-version">保存版本</button><button class="secondary" data-action="preview">预览</button><button class="primary" data-action="preflight">导出</button></div></header>
    <div class="tabs"><button class="tab home-tab ${
      store.ui.route === "overview" ? "active" : ""
    }" data-action="route" data-route="overview">项目概览</button>${
      store.tabs.map((tab) => {
        const target = store.data.content_items.find((candidate) =>
          candidate.id === tab.content_item_id
        );
        if (!target) return "";
        const active = target.id === (item && item.id);
        return `<div class="tab-item ${active ? "active" : ""}"><button class="tab" data-action="open-item" data-id="${target.id}" aria-label="打开课程：${esc(target.code)} ${esc(target.title)}">${
          esc(target.code)
        }｜${esc(target.title)}</button><button type="button" class="icon-button tab-close" data-action="close-tab" data-id="${target.id}" aria-label="关闭课程标签：${esc(target.code)} ${esc(target.title)}" title="关闭课程标签">×</button></div>`;
      }).join("")
    }</div>`;
  }

  function leftPanelView() {
    const map = courseMap(store.data, store.ui.activeId);
    const openInbox = store.data.inbox_items.filter((item) =>
      item.status === "open"
    ).length;
    const nav = [
      ["overview", "项目概览", "⌂"],
      ["map", "课程地图", "▦"],
      ["workbench", "工作台", "✎"],
      ["free-layout", "自由排版", "▧"],
      ["explorer", "文件", "📂"],
      ["inbox", "收件箱", "↓"],
      ["board", "制作看板", "▤"],
      ["media", "媒体库", "◈"],
      ["backlog", "待补总览", "!="],
      ["updates", "更新中心", "✦"],
      ["publish", "发布中心", "↗"],
      ["versions", "版本历史", "◷"],
      ["settings", "项目设置", "⚙"],
    ];
    return `<aside class="left-panel panel"><div class="panel-heading"><span>项目导航</span><button class="icon-button" data-action="toggle-left" title="${store.ui.leftCollapsed ? "展开左栏" : "收起左栏"}" aria-label="${store.ui.leftCollapsed ? "展开左栏" : "收起左栏"}">${store.ui.leftCollapsed ? "☰" : "‹"}</button></div><nav aria-label="项目页面">${
      nav.map(([route, label, icon]) => {
        const isWorkbench = route === "workbench";
        const active = isWorkbench
          ? store.ui.route === "editor"
          : store.ui.route === route;
        const action = isWorkbench
          ? 'data-action="open-workbench"'
          : `data-action="route" data-route="${route}"`;
        return `<button class="nav-item ${
          active ? "active" : ""
        }" ${action}><span class="nav-icon">${icon}</span><span>${label}</span>${
          route === "inbox" && openInbox ? `<b class="count">${openInbox}</b>` : ""
        }${
          route === "backlog" && map.open_requirements
            ? `<b class="count">${map.open_requirements}</b>`
            : ""
        }</button>`;
      }).join("")
    }</nav><div class="panel-footer">${
      map.lessons.length
        ? `<div class="side-head compact"><span class="eyebrow">本课程</span><span class="muted small">${
          map.complete_count
        }/${map.lesson_count} 课完成</span></div><div class="left-lessons">${
          map.stages.map((stage) =>
            `<div class="left-stage"><span class="left-stage-code">${
              esc(stage.code)
            }</span><span class="left-stage-title">${
              esc(stage.title)
            }</span></div>${
              stage.lessons.map((lesson) =>
                `<button class="left-lesson ${
                  lesson.current ? "active" : ""
                }" data-action="open-item" data-id="${lesson.id}" title="${
                  esc(lesson.title)
                }"><span class="left-lesson-code">${
                  esc(lesson.code)
                }</span><span class="left-lesson-title">${
                  esc(lesson.title)
                }</span><span class="lesson-dot ${
                  lesson.progress.complete ? "done" : "open"
                }"></span></button>`
              ).join("")
            }`
          ).join("")
        }</div>`
        : ""
    }<button class="nav-item" data-action="capture"><span class="nav-icon">＋</span><span>快速收集</span><kbd>⌘⇧空格</kbd></button><button class="nav-item" data-action="palette"><span class="nav-icon">⌕</span><span>搜索与命令</span><kbd>⌘K</kbd></button></div></aside>`;
  }

  function centerView() {
    if (store.ui.route === "editor") return editorView();
    if (store.ui.route === "free-layout") return freeLayoutView();
    if (store.ui.route === "map") return mapView();
    if (store.ui.route === "explorer") return explorerView();
    if (store.ui.route === "mapping") return mappingView();
    if (store.ui.route === "inbox") return inboxView();
    if (store.ui.route === "board") return boardView();
    if (store.ui.route === "media") return mediaView();
    if (store.ui.route === "backlog") return backlogView();
    if (store.ui.route === "versions") return versionsView();
    if (store.ui.route === "updates") return updatesView();
    if (store.ui.route === "publish") return publishView();
    if (store.ui.route === "settings") return settingsView();
    return overviewView();
  }

  /* --------------------------------------------------------- course map */

  /**
   * "你现在有什么？" — every button here maps to a real course-input source the
   * Domain supports, and the ones that cannot work yet say so instead of
   * pretending.  Nothing is created until the user confirms the draft.
   */
  function seedCard() {
    const active = store.ui.seedType;
    const hint = active ? SEED_SOURCE_HINTS[active] : null;
    return `<div class="card seed-card"><span class="eyebrow">你现在有什么？</span><h2>把已有的内容变成课程地图</h2><p class="muted">选中一类你手上已有的内容，粘贴进来，先生成一份课程地图草稿。确认草稿前不会创建正式阶段与内容。</p><div class="seed-grid">${
      SEED_TEXT_SOURCES.map((type) => {
        const entry = SEED_SOURCE_HINTS[type];
        return `<button class="${
          active === type ? "primary" : "secondary"
        }" data-action="pick-seed" data-type="${type}" title="${
          esc(entry.hint)
        }">${esc(entry.label)}</button>`;
      }).join("")
    }<button class="secondary" disabled title="${
      esc(SEED_SOURCE_HINTS.folder.hint)
    }">资料文件夹（暂不支持）</button></div>${
      hint
        ? `<div class="seed-input"><label class="field-label">${
          esc(hint.hint)
        }<textarea data-seed-text data-focus-key="seed-text" placeholder="${
          esc(hint.placeholder)
        }">${esc(store.ui.seedText || "")}</textarea></label><div class="modal-actions"><button class="primary" data-action="build-blueprint" ${
          store.ui.seedBusy ? "disabled" : ""
        }>${store.ui.seedBusy ? "正在生成…" : "生成课程地图草稿"}</button><button class="text-button" data-action="cancel-seed">取消</button></div></div>`
        : ""
    }</div>`;
  }

  function mapView() {
    const draft = (store.data.blueprint_drafts || []).find((candidate) =>
      candidate.status === "draft"
    );
    const draftNodes = draft
      ? (store.data.blueprint_nodes || []).filter((node) =>
        node.blueprint_id === draft.id
      ).sort((a, b) => a.order_index - b.order_index)
      : [];
    const draftCard = draft
      ? `<div class="card blueprint-confirm"><span class="eyebrow">待确认的课程地图</span><h2>${
        esc(draft.title)
      }</h2><p class="muted">确认前只保存课程输入和草稿，确认后才创建正式阶段与内容。</p><div class="blueprint-nodes">${
        draftNodes.map((node) =>
          `<div class="structure-row"><span class="order">${
            node.node_type === "stage" ? "阶段" : "内容"
          }</span><span>${esc(node.title)}</span></div>`
        ).join("")
      }</div><div class="modal-actions"><button class="secondary" data-action="discard-blueprint" data-id="${
        draft.id
      }">放弃这份草稿</button><button class="primary" data-action="confirm-blueprint" data-id="${
        draft.id
      }">确认课程地图并创建内容</button></div></div>`
      : "";
    const map = courseMap(store.data, store.ui.activeId);
    const realStages = map.stages.filter((stage) => stage.id);
    const mapProjectTitle = store.ui.editingProjectTitle &&
        store.ui.editingProjectTitleSurface === "map"
      ? `<input class="project-title-input map-project-title-input" data-project-title data-focus-key="project-title" value="${esc(store.data.project.title)}" aria-label="课程标题" />`
      : `<button class="inline-title-button map-project-title" data-action="edit-project-title" data-title-surface="map" title="点击修改课程标题">${esc(map.project_title)}</button>`;
    if (map.lesson_count === 0 && realStages.length === 0 && !draft) {
      return `<section class="page course-map-page is-empty map-empty-page"><div class="page-head"><div><span class="eyebrow">课程地图 · 结构与进度</span><h1>${mapProjectTitle}</h1><p class="muted">课程还没有内容。先用草稿生成结构，或直接新建第一课。</p></div><div class="map-actions"><button class="secondary" data-action="select-project-properties">项目属性</button><button class="secondary" data-action="add-stage">＋ 新阶段</button><button class="primary" data-action="add-map-item">＋ 新建第一课</button></div></div>${
        seedCard()
      }<div class="empty-state"><div class="empty-icon">▦</div><h2>还没有课程内容</h2><p class="muted">现在可以新建第一课，或先加一个阶段；课程地图会保留你的后续编辑。</p><div class="modal-actions"><button class="secondary" data-action="add-stage">＋ 新阶段</button><button class="primary" data-action="add-map-item">新建第一课</button></div></div></section>`;
    }
    return `<section class="page course-map-page"><div class="page-head map-page-head"><div class="map-page-title"><span class="eyebrow">课程地图 · 阶段与课时</span><h1>${
      mapProjectTitle
    }</h1><p class="muted">${
      map.lesson_count ? "按阶段组织课时；拖动课时即可调整顺序或归属。" : "还没有内容，可以先新建第一课或新阶段"
    }</p></div><div class="map-actions"><button class="secondary" data-action="select-project-properties">项目属性</button>${store.currentItem() ? `<button class="secondary" data-action="locate-current-lesson">定位当前课</button>` : ""}<button class="secondary" data-action="add-stage">＋ 新阶段</button><button class="secondary" data-action="add-map-item">＋ 新建课程内容</button>${
      map.next_lesson_id
        ? `<button class="primary" data-action="open-item" data-id="${map.next_lesson_id}">继续下一处未完成 <span aria-hidden="true">→</span></button>`
        : ""
    }</div></div><div class="map-progress-summary" aria-label="课程完成情况"><div><strong>${map.lesson_count}</strong><span>课时</span></div><div><strong>${map.complete_count}</strong><span>已完成</span></div><div><strong>${map.open_requirements}</strong><span>待补</span></div><div><strong>${map.missing_media}</strong><span>缺素材</span></div><div class="map-progress-track"><span style="width:${map.progress}%"></span></div></div>${draftCard}<div class="course-map">${
      map.stages.map((stage, stageIndex) =>
        stageCard(stage, stageIndex, realStages.length)
      ).join("")
    }</div></section>`;
  }

  function stageCard(stage, stageIndex, stageCount) {
    const manageable = Boolean(stage.id);
    const collapsed = manageable && store.ui.collapsedStageIds.includes(stage.id);
    const editing = manageable && store.ui.editingStageTitleId === stage.id;
    const tools = manageable
      ? `<div class="stage-tools"><button class="icon-button stage-collapse-toggle" data-action="toggle-stage-collapse" data-id="${
        stage.id
      }" aria-label="${collapsed ? "展开阶段" : "折叠阶段"}：${esc(stage.title)}" aria-expanded="${!collapsed}" title="${collapsed ? "展开阶段" : "折叠阶段"}">${collapsed ? "▸" : "⌄"}</button><button class="icon-button" data-action="rename-stage" data-id="${
        stage.id
      }" aria-label="重命名阶段：${esc(stage.title)}" title="重命名阶段">✎</button><button class="icon-button" data-action="move-stage" data-id="${
        stage.id
      }" data-direction="up" aria-label="上移阶段：${esc(stage.title)}" title="上移阶段" ${
        stageIndex === 0 ? "disabled" : ""
      }>↑</button><button class="icon-button" data-action="move-stage" data-id="${
        stage.id
      }" data-direction="down" aria-label="下移阶段：${esc(stage.title)}" title="下移阶段" ${
        stageIndex >= stageCount - 1 ? "disabled" : ""
      }>↓</button><details class="stage-more"><summary class="icon-button" aria-label="更多阶段操作：${esc(stage.title)}" title="更多阶段操作">⋯</summary><div class="stage-more-menu"><button type="button" class="stage-more-item" data-action="add-stage" title="在课程地图新增阶段">＋ 新阶段</button><button type="button" class="stage-more-item" data-action="rename-stage" data-id="${
        stage.id
      }" title="重命名阶段">重命名</button><button type="button" class="stage-more-item danger" data-action="delete-stage" data-id="${
        stage.id
      }" title="删除阶段（空阶段需确认；有课时会先提示移动）">${TRASH_ICON} 删除阶段</button></div></details></div>`
      : "";
    const selectedPropertyStage = store.ui.propertyTarget?.kind === "stage" &&
      store.ui.propertyTarget.id === stage.id;
    return `<div class="stage-card ${stage.current ? "current" : ""}${collapsed ? " collapsed" : ""}" data-stage-id="${esc(stage.id)}" data-collapsed="${collapsed}"><div class="stage-head"><button type="button" class="stage-code stage-property-target ${selectedPropertyStage ? "selected" : ""}" data-action="select-stage-properties" data-id="${esc(stage.id)}" aria-pressed="${selectedPropertyStage}" title="查看阶段属性">${
      esc(stage.code)
    }</span><h2>${editing
      ? `<input class="stage-title-inline" data-stage-title-inline data-id="${stage.id}" data-focus-key="stage-title" aria-label="阶段名称" value="${esc(stage.title)}" />`
      : `<button class="inline-title-button stage-title-button" data-action="rename-stage" data-id="${stage.id}" title="点击修改阶段名称">${esc(stage.title)}</button>`
    }</h2><span class="stage-count">${
      stage.lessons.length
    } 课 · 完成 ${stage.complete_count}${
      stage.open_requirements ? ` · 待补 ${stage.open_requirements}` : ""
    }</span>${tools}</div><div class="map-items">${
      stage.lessons.length
        ? stage.lessons.map(mapItem).join("")
        : `<div class="side-empty map-empty-drop">这个阶段还没有内容；可以新建一课，或把课时拖到这里。</div>`
    }<div class="lesson-drop-end" aria-hidden="true">放入${esc(stage.title)}末尾</div></div></div>`;
  }

  /**
   * What is still missing in one lesson.  A per-lesson percentage was a made-up
   * number (it mixed six dimensions into one figure) and is replaced by the
   * gap counts the course actually tracks.
   */
  function lessonGapLabel(lesson) {
    const gaps = lesson.gaps || {};
    const missing = lesson.progress?.missing_media || 0;
    if (lesson.progress?.complete) return "已完成";
    const parts = [];
    if (gaps.total) parts.push(`待补 ${gaps.total} 项`);
    if (missing) parts.push(`缺素材 ${missing} 项`);
    if (!parts.length) parts.push("无待补");
    return parts.join(" · ");
  }

  function mapItem(lesson) {
    const progress = lesson.progress;
    const nextStep = nextStepLabel(lesson);
    const editing = store.ui.editingLessonTitleId === lesson.id &&
      store.ui.editingLessonTitleSurface === "map";
    const content = editing
      ? `<div class="map-open map-open-editing"><span class="map-item-code">${esc(lesson.code)}</span><span class="map-item-body"><input class="lesson-title-inline" data-lesson-title-inline data-id="${lesson.id}" data-focus-key="lesson-title-inline" aria-label="课程标题" value="${esc(lesson.title)}" /><small>${esc(lesson.summary)}</small></span><span class="map-item-meta"><span class="badge ${progress.complete ? "done" : "open"}">${lessonGapLabel(lesson)}</span><span class="map-item-state">${lesson.current ? "正在编辑" : progress.complete ? "已完成" : esc(progress.reasons[0] || nextStep)}</span></span><span class="map-arrow">›</span></div>`
      : `<button class="map-open" data-action="open-item" data-id="${lesson.id}"><span class="map-item-code">${esc(lesson.code)}</span><span class="map-item-body"><b>${esc(lesson.title)}</b><small>${esc(lesson.summary)}</small></span><span class="map-item-meta"><span class="badge ${progress.complete ? "done" : "open"}">${lessonGapLabel(lesson)}</span><span class="map-item-state">${lesson.current ? "正在编辑" : progress.complete ? "已完成" : esc(progress.reasons[0] || nextStep)}</span></span><span class="map-arrow">›</span></button>`;
    return `<div class="map-item ${lesson.current ? "current" : ""}" data-map-lesson="${lesson.id}"><button type="button" class="lesson-drag-handle" data-lesson-drag-handle="${lesson.id}" aria-label="拖动${esc(lesson.title)}">⠿</button>${content}<div class="map-item-tools"><button class="icon-button" data-action="rename-lesson" data-title-surface="map" data-id="${lesson.id}" aria-label="重命名课程：${esc(lesson.title)}" title="重命名这一课">✎</button><button class="icon-button" data-action="move-lesson" data-id="${lesson.id}" data-direction="up" aria-label="上移课程：${esc(lesson.title)}" title="上移这一课" ${lesson.order_index === 0 ? "disabled" : ""}>↑</button><button class="icon-button" data-action="move-lesson" data-id="${lesson.id}" data-direction="down" aria-label="下移课程：${esc(lesson.title)}" title="下移这一课">↓</button><button class="icon-button danger" data-action="delete-lesson" data-id="${lesson.id}" aria-label="删除课程：${esc(lesson.title)}" title="删除这一课（会先确认；可以用撤销恢复）">${TRASH_ICON}</button></div></div>`;
  }

  /* ------------------------------------------------------ lesson editor */

  function editorView() {
    const item = store.currentItem();
    if (!item) {
      return emptyState(
        "还没有课程内容",
        "课程还没有可编辑的内容。打开课程地图新建一项，就可以继续。",
        "map",
        "打开课程地图",
      );
    }
    const view = store.lesson(item);
    const lesson = view ? view.lesson : null;
    const map = courseMap(store.data, item.id);
    const stage = store.data.stages.find((candidate) =>
      candidate.id === item.stage_id
    );
    const mode = store.ui.mode === "structure" ? "structure"
      : store.ui.mode === "preview" ? "preview"
      : "writing";
    const workbenchTabs = [
      ["writing", "正文", "01"],
      ["structure", "Flow", "02"],
      ["preview", "Preview", "03"],
    ];
    return `<section class="editor-page workbench-page mode-${mode}"><div class="breadcrumbs"><button class="text-button" data-action="route" data-route="map">课程地图</button><b>/</b><span>${
      esc(stage ? stage.title : "未分组")
    }</span><b>/</b><strong>${esc(item.code)} ${esc(item.title)}</strong></div><div class="workbench-head"><div class="workbench-heading"><span class="eyebrow">工作台 · ${esc(item.code)}</span><h1>${esc(item.title)}</h1><p class="muted">沿正文写作、检查内容流程，或阅读最终预览。</p></div><div class="workbench-status"><span class="status-mark"></span><span>${esc(view?.progress?.complete ? "本课已完成" : "持续编辑中")}</span></div></div><nav class="workbench-tabs" role="tablist" aria-label="工作台视图">${
      workbenchTabs.map(([value, label, number]) =>
        `<button role="tab" aria-selected="${mode === value}" class="workbench-tab ${
          mode === value ? "active" : ""
        }" data-action="mode" data-mode="${value}"><span class="workbench-tab-index">${number}</span><span>${label}</span></button>`
      ).join("")
    }</nav><div class="workbench-lesson-meta"><span class="eyebrow">${
      esc(item.code)
    } · ${esc(item.type)} · 第 ${
      map.current_index + 1
    }/${map.lesson_count} 课</span><div class="lesson-strip">${
      lessonStrip(item, lesson)
    }</div></div><div class="editor-body">${
      mode === "writing"
        ? writingView(item, view)
        : mode === "structure"
        ? flowView(item, view)
        : previewView(item, view)
    }</div><div class="lesson-nav"><button class="secondary" data-action="prev-lesson" ${
      map.previous_id ? "" : "disabled"
    }>← 上一课</button><span class="muted small">${
      map.previous_id || map.next_id
        ? "跳课不会丢失未保存内容"
        : "这是唯一的一课"
    }</span><button class="secondary" data-action="next-lesson" ${
      map.next_id ? "" : "disabled"
    }>下一课 →</button></div></section>`;
  }

  function lessonStrip(item, lesson) {
    if (!lesson) return "";
    const progress = lesson.progress;
    const gaps = lesson.gaps;
    return `<div class="lesson-state"><span class="badge ${
      progress.complete ? "done" : "open"
    }">这一课${
      progress.complete ? "已完成" : "还没完成"
    }</span><div class="gap-counter">${
      gaps.by_type.image ? `<span>图片：缺 ${gaps.by_type.image} 张</span>` : ""
    }${gaps.by_type.gif ? `<span>GIF：缺 ${gaps.by_type.gif} 个</span>` : ""}${
      gaps.by_type.video ? `<span>视频：缺 ${gaps.by_type.video} 个</span>` : ""
    }${
      gaps.by_type.text
        ? `<span>文字：缺 ${gaps.by_type.text} 段</span>`
        : ""
    }${
      gaps.layout
        ? `<span>排版待补：${gaps.layout} 项</span>`
        : ""
    }${
      progress.missing_media
        ? `<span class="warning">素材缺失：${progress.missing_media} 处</span>`
        : ""
    }${
      gaps.total === 0 && !progress.missing_media
        ? `<span class="ok">待补：已齐</span>`
        : ""
    }</div><span class="lesson-next">下一步：${
      esc(nextStepLabel(lesson))
    }</span></div>${
      progress.complete
        ? ""
        : `<p class="side-note">${
          esc(progress.reasons.slice(0, 3).join("；"))
        }</p>`
    }`;
  }

  function writingView(item, view) {
    if (!view || view.blocks.length === 0) {
      return `${blockToolbar()}<div class="empty-state inline"><div class="empty-icon">✎</div><h2>这一课还没有正文</h2><p class="muted">课程内容还可以继续编辑。先写一段正文，也可以先加标题或留下待补项。</p><div class="modal-actions"><button class="primary" data-action="add-block">＋ 正文</button><button class="secondary" data-action="add-heading">＋ 标题</button><button class="secondary" data-action="add-placeholder">＋ 占位符</button></div></div>`;
    }
    return `${blockToolbar()}<div class="block-list">${
      view.blocks.map((block, index) => blockCard(block, index)).join("")
    }</div><button class="add-block-line" data-action="add-block-below" data-id="${
      view.blocks[view.blocks.length - 1].id
    }">＋ 继续写作</button>`;
  }

  function blockToolbar() {
    return `<details class="writing-insert-menu"><summary class="writing-insert-summary"><span aria-hidden="true">＋</span> 插入内容</summary><div class="writing-toolbar">${
      BLOCK_PALETTE.map(([type, label]) =>
        `<button class="secondary" data-action="insert-block" data-type="${type}">＋ ${label}</button>`
      ).join("")
    }<span class="toolbar-hint">正文顺序决定语义；排版只负责空间位置</span></div></details>`;
  }

  function blockCard(block, index) {
    const selected = store.ui.selectedBlockId === block.id;
    const focused = block.requirement_id &&
      block.requirement_id === store.ui.focusRequirementId;
    const requirement = block.requirement_id
      ? store.data.requirements.find((candidate) =>
        candidate.id === block.requirement_id
      )
      : null;
    const size = block.size || blockSizeView(block);
    const typeLabel = esc(block.label || blockLabel(block.type));
    return `<article class="block block-${block.type} block-size-${
      size.tier
    } block-kind-${size.kind}${
      selected ? " selected" : ""
    }${focused ? " focused" : ""}" data-block-id="${block.id}" data-block-size="${
      size.tier
    }" data-requirement-id="${
      block.requirement_id || ""
    }"><div class="block-head"><span class="block-handle" title="按住拖动以调整正文顺序">⠿</span><span class="block-type-label">${typeLabel}</span><span class="block-order">${
      String(index + 1).padStart(2, "0")
    }</span><div class="block-head-actions"><button class="icon-button" data-action="insert-block-below" data-id="${
      block.id
    }" aria-label="在${typeLabel}下方插入正文区块" title="在这块正文下方插入">＋</button><details class="block-more"><summary class="icon-button" aria-label="更多正文区块操作：${typeLabel}" title="更多操作">⋯</summary><div class="block-more-menu"><button type="button" class="block-more-item" data-action="select-block" data-id="${
      block.id
    }" title="选中这块正文">◎ 选中</button><button type="button" class="block-more-item" data-action="move-block" data-id="${
      block.id
    }" data-direction="up" title="上移这块正文" ${
      index === 0 ? "disabled" : ""
    }>↑ 上移</button><button type="button" class="block-more-item" data-action="move-block" data-id="${
      block.id
    }" data-direction="down" title="下移这块正文">↓ 下移</button><button type="button" class="block-more-item danger" data-action="delete-block" data-id="${
      block.id
    }" title="删除这块正文（可以用撤销恢复）">${TRASH_ICON} 删除</button></div></details></div></div><div class="block-main">${
      blockBody(block, requirement)
    }</div></article>`;
  }

  function blockBody(block, requirement) {
    switch (block.type) {
      case "heading": {
        return markdownEditor(block);
      }
      case "divider":
        return `<hr class="block-divider" /><span class="block-hint">分隔线</span>`;
      case "placeholder":
        return `<div class="placeholder-body"><span class="placeholder-icon">□</span><div><span class="eyebrow">${
          requirement ? `${requirementTypeLabel(requirement.type)}待补` : "待补"
        }</span><p>${esc(block.text || "待补内容")}</p><small class="muted">${
          esc(requirement ? requirement.note : "还没有填写备注")
        } · ${
          requirement && requirement.status !== "open" ? "已完成" : "未完成"
        }</small></div><div class="placeholder-actions"><button class="secondary" data-action="pick-asset-for-requirement" data-id="${
          block.requirement_id || ""
        }">选择素材</button><button class="secondary" data-action="route" data-route="media">去媒体库</button><button class="secondary" data-action="edit-requirement" data-id="${
          block.requirement_id || ""
        }">改备注</button><button class="text-button" data-action="delete-requirement" data-id="${
          block.requirement_id || ""
        }">删除</button></div></div>`;
      case "image":
      case "gif":
      case "video":
      case "audio":
      case "embed":
        return mediaBody(block);
      case "callout":
      case "quote":
        return markdownEditor(block);
      case "code":
        return `<textarea class="block-text block-code" data-block-id="${block.id}" aria-label="代码内容" placeholder="代码">${
          esc(block.text)
        }</textarea><span class="block-hint">代码</span>`;
      default:
        return markdownEditor(block);
    }
  }

  function markdownImageResolver(block) {
    return (href) => {
      const mappings = Array.isArray(block.settings?.markdown_assets)
        ? block.settings.markdown_assets
        : [];
      const mapping = mappings.find((entry) => entry?.href === href);
      if (!mapping?.asset_id) {
        return { error: mapping?.missing ? "未找到本地图片" : "图片尚未纳入素材库" };
      }
      const asset = store.data.assets.find((candidate) =>
        candidate.id === mapping.asset_id && !candidate.archived
      );
      if (!asset) return { error: "图片素材已归档或不存在" };
      if (asset.type !== "image" && asset.type !== "gif") {
        return { error: "Markdown 图片语法只支持图片和 GIF。请从媒体库插入视频区块。" };
      }
      const preview = assetPreview(asset);
      if (preview?.failed) return { error: preview.error || "图片读取失败" };
      if (preview?.loading) return { pendingKey: preview.key || null };
      const url = preview?.thumbnailUrl || preview?.url || null;
      return url ? { url } : { error: "图片暂不可预览" };
    };
  }

  function markdownBlockHtml(block) {
    const text = String(block.text ?? "");
    const options = { resolveImage: markdownImageResolver(block) };
    if (block.type === "heading") {
      const level = Math.max(1, Math.min(6, block.level || 2));
      return `<h${level}>${renderMarkdown(text, { ...options, inlineOnly: true })}</h${level}>`;
    }
    if (block.type === "quote") return `<blockquote>${renderMarkdown(text, options)}</blockquote>`;
    if (block.type === "callout") {
      return `<aside class="markdown-callout">${renderMarkdown(text, options)}</aside>`;
    }
    return renderMarkdown(text, options);
  }

  function markdownEditor(block) {
    const label = block.type === "heading" ? "标题" : block.type === "quote" ? "引用内容" : "正文内容";
    const options = { resolveImage: markdownImageResolver(block) };
    const headingLevel = Math.max(1, Math.min(6, block.level || 2));
    const editorHtml = block.type === "heading"
      ? renderMarkdown(block.text, { ...options, inlineOnly: true })
      : renderMarkdown(block.text, options);
    const editorClass = block.type === "heading"
      ? `markdown-editor-heading markdown-heading-level-${headingLevel}`
      : `markdown-editor-${block.type}`;
    const placeholder = block.type === "heading" ? "新标题" : block.type === "quote" ? "引用内容" : "开始写点什么…";
    // Markdown syntax is compiled while typing, so there is no source view and
    // no formatting buttons to reach for: the shortcuts do the work.
    return `<div class="markdown-editor-shell"><div class="markdown-rich-editor ${editorClass}" contenteditable="true" data-rich-editor="true" data-block-id="${esc(block.id)}" data-edit-property="text" data-empty="${!String(block.text || "").trim()}" data-placeholder="${esc(placeholder)}" role="textbox" aria-multiline="true" aria-label="${label}" aria-placeholder="${esc(placeholder)}" spellcheck="true">${editorHtml}</div></div>`;
  }

  function mediaBody(block) {
    const asset = block.asset;
    if (!asset) {
      return `<div class="media-slot empty"><span class="media-slot-icon">🖼</span><div><b>${
        esc(block.label)
      }还没有指向素材</b><small class="muted">选择或拖入素材后，这里会建立真实引用。</small></div><button class="secondary" data-action="pick-asset-for-block" data-id="${
        block.id
      }">选择素材</button></div>`;
    }
    // The preview paints inside its own frame, so a preview that settles later
    // rewrites this frame and nothing else (§12.4).
    return `<div class="media-slot" data-block-id="${block.id}">${
      previewFrame(asset, "block", mediaSlotBody(asset, block.id))
    }<div class="media-meta"><span class="badge">${
      assetLabel(asset.type)
    }</span><b>${esc(asset.title || asset.filename)}</b><small class="muted">${
      esc(asset.source_type)
    } · ${formatBytes(asset.file_size)}${
      asset.archived ? " · 已归档" : ""
    }</small></div><div class="media-actions"><button class="secondary" data-action="pick-asset-for-block" data-id="${
      block.id
    }">替换素材</button><button class="secondary" data-action="detach-asset" data-id="${
      block.id
    }" data-asset="${asset.id}">解除引用</button><button class="text-button" data-action="route" data-route="media">在媒体库查看</button></div></div>`;
  }

  function requirementTypeLabel(type) {
    return {
      text: "文字",
      image: "图片",
      gif: "GIF",
      video: "视频",
      audio: "音频",
      table: "表格",
      chart: "图表",
      quote: "引用",
      case: "案例",
      link: "链接",
      data: "数据",
      other: "其他",
    }[type] || "内容";
  }

  function flowView(item, view) {
    if (!view || view.blocks.length === 0) {
      return `<div class="empty-state inline flow-empty"><span class="eyebrow">FLOW</span><h2>正文还没有内容</h2><p class="muted">写下第一段后，Flow 会按正文顺序列出每个区块。</p><button class="primary" data-action="mode" data-mode="writing">开始写正文</button></div>`;
    }
    const first = view.blocks[0]?.id || "";
    const last = view.blocks.at(-1)?.id || "";
    return `<div class="flow-view"><div class="flow-toolbar"><div><span class="eyebrow">CANONICAL ORDER</span><h2>内容流程</h2><p class="muted">拖动左侧手柄调整顺序；选择条目可回到正文定位。</p></div><span class="flow-count">${view.blocks.length} 个区块</span></div><div class="flow-list">${
      view.blocks.map((block, index) => {
        const requirement = block.requirement_id
          ? store.data.requirements.find((candidate) =>
            candidate.id === block.requirement_id
          )
          : null;
        const label = block.label || blockLabel(block.type);
        return `<article class="flow-placement ${
          store.ui.selectedBlockId === block.id ? "selected" : ""
        }${block.asset_missing ? " has-gap" : ""}" data-structure-block="${block.id}" data-block-id="${block.id}"><button type="button" class="flow-jump" data-action="flow-select-block" data-id="${
          block.id
        }" aria-label="${esc(label)}，${esc(block.summary || "空内容")}，点击跳转到正文"><span class="flow-order">${
          String(index + 1).padStart(2, "0")
        }</span><span class="flow-copy"><span class="flow-kind">${esc(label)}</span><b>${
          esc(block.summary || "（空）")
        }</b><span class="flow-flags">${
          block.asset_missing ? `<span class="badge warning">缺素材</span>` : ""
        }${
          requirement && requirement.status === "open"
            ? `<span class="badge open">待补</span>`
            : ""
        }</span></span><span class="flow-open-hint">查看正文 ↗</span></button><button type="button" class="flow-drag-handle" data-flow-drag-handle="${block.id}" aria-label="拖动以调整${esc(label)}顺序" title="按住拖动以调整顺序">⠿</button><div class="flow-move"><button type="button" class="icon-button" data-action="move-block" data-id="${block.id}" data-direction="up" aria-label="上移${esc(label)}" title="上移" ${block.id === first ? "disabled" : ""}>↑</button><button type="button" class="icon-button" data-action="move-block" data-id="${block.id}" data-direction="down" aria-label="下移${esc(label)}" title="下移" ${block.id === last ? "disabled" : ""}>↓</button></div></article>`;
      }).join("")
    }<div class="flow-drop-end" data-flow-drop-end aria-hidden="true"></div></div><p class="flow-footnote">正文、Flow、Preview 与导出共用同一顺序。每次调整都可用撤销恢复。</p></div>`;
  }

  /* ------------------------------------------------------------- layout */

  function freeLayoutView() {
    const item = store.currentItem();
    if (!item) {
      const hasLessons = store.data.content_items.some((candidate) => !candidate.archived);
      return `<section class="page free-layout-page canvas-first-page"><div class="canvas-page-intro"><div><span class="eyebrow">FREE LAYOUT · 独立画布</span><h1>自由排版</h1><p class="muted">Canvas 用于安排内容位置与页面；正文继续保存在工作台。</p></div></div><div class="free-layout-empty empty-state"><span class="empty-icon">▧</span><h2>先选择一课</h2><p class="muted">${hasLessons ? "打开工作台后，当前课程会显示在这里。" : "课程还没有内容，先从课程地图创建第一课。"}</p><button class="primary" data-action="${hasLessons ? "open-workbench" : "route"}" ${hasLessons ? "" : 'data-route="map"'}>${hasLessons ? "打开当前课程" : "打开课程地图"}</button></div></section>`;
    }
    const view = store.lesson(item);
    const layout = view?.lesson?.layout || null;
    const body = !layout
      ? `<div class="free-layout-empty empty-state"><span class="empty-icon">▧</span><h2>为 ${esc(item.code)} 创建网格</h2><p class="muted">创建后可以安排区块、调整尺寸与跨格，并按需要启用分页。</p><button class="primary" data-action="create-layout">创建 Grid 画布</button></div>`
      : layout.mode === "flow"
      ? `<div class="free-layout-transition"><span class="eyebrow">当前版本 · Flow</span><h2>此课当前使用连续正文顺序</h2><p class="muted">切换为 Grid 后，现有正文继续保留；自由排版会使用同一份内容建立空间位置。</p><button class="primary" data-action="layout-mode" data-layout-mode="grid">切换到 Grid</button></div>`
      : layoutView(item, view);
    return `<section class="page free-layout-page canvas-first-page"><div class="canvas-page-intro"><div><span class="eyebrow">FREE LAYOUT · ${esc(item.code)}</span><h1>自由排版</h1><p class="muted">${esc(item.title)} · Canvas 位置与页面设置。</p></div><button class="secondary" data-action="open-workbench">返回工作台</button></div>${body}</section>`;
  }

  function layoutView(item, view) {
    const layout = view ? view.lesson.layout : null;
    if (!layout) {
      return `<div class="empty-state"><div class="empty-icon">▦</div><h2>还没有排版版本</h2><p class="muted">正文还没有排版位置。创建一个版本后，就可以继续安排内容。</p><button class="primary" data-action="create-layout">创建排版版本</button></div>`;
    }
    const paged = layout.pagination_mode === "paged";
    const paginationEditing = paged && Boolean(store.ui.paginationEditing);
    const gridEditing = Boolean(store.ui.gridEditing && (!paged || paginationEditing));
    const grid = view.page_grid || layout.grid_definition;
    const pageSize = resolvePageSize(layout);
    const toolbar = `<div class="layout-toolbar"><span class="layout-mode-pill"><span></span> GRID CANVAS</span>${
      `${paged ? paginationEditing ? `<button class="secondary ${gridEditing ? "active-tool" : ""}" data-action="grid-toggle-edit" title="行列结构会影响当前画布里的放置">${gridEditing ? "完成编辑网格" : "编辑网格"}</button>` : "" : `<button class="secondary ${gridEditing ? "active-tool" : ""}" data-action="grid-toggle-edit" title="行列结构会影响当前画布里的放置">${
        gridEditing ? "完成编辑网格" : "编辑网格"
      }</button>`}${
        gridEditing
          ? `<button class="secondary" data-action="grid-add-col">＋ 列</button><button class="secondary" data-action="grid-add-row">＋ 行</button><button class="secondary" data-action="grid-remove-col">− 列</button><button class="secondary" data-action="grid-remove-row">− 行</button><span class="toolbar-hint">正在编辑${paged ? "当前页" : "网格"}行列；已有放置会按现有规则调整。</span>`
          : `<span class="toolbar-hint">${grid.columns.length} 列 × ${grid.rows.length} 行${paged ? " · 有限页面" : " · 连续画布"}；修改行列前先点「编辑网格」。</span>`
      }${paged ? paginationEditing ? `<button class="secondary" data-action="grid-autofill">排入当前页</button>` : "" : `<button class="secondary" data-action="pagination-conversion">启用分页</button><button class="secondary" data-action="grid-autofill">一键排版全部正文</button>`}`
    }</div>`;
    const meta = `<div class="layout-meta"><span><b>${
      esc(layout.name)
    }</b> · ${paged ? "分页 Grid" : "连续 Grid"}</span><span>${
      paged
        ? `${view.pages.length} 页 · ${pageSize.width_pt} × ${pageSize.height_pt} pt · 页面尺寸与屏幕缩放分开`
        : `${grid.columns.length} 列 × ${grid.rows.length} 行 · 同一份正文只保存一次位置`
    }</span><button class="text-button" data-action="rename-layout">重命名排版</button></div>`;
    const page = view.active_page;
    const placements = view.placements;
    const unplaced = view.unplaced_blocks;
    const gridTracks = (tracks) => tracks.map((track) => `minmax(0, ${Number(track) || 1}fr)`).join(" ");
    const pageGeometry = paged && page
      ? projectPageGeometry(layout, page, view.all_placements)
      : null;
    const zoomWidth = store.ui.layoutZoom === "actual"
      ? `${pageSize.width_pt * 4 / 3}px`
      : `min(100%, 900px, ${Math.min(68, 68 * pageSize.width_pt / pageSize.height_pt)}vh)`;
    const canvasStyle = paged
      ? `style="--cols:${grid.columns.length};--rows:${grid.rows.length};width:${zoomWidth};aspect-ratio:${pageSize.width_pt}/${pageSize.height_pt};grid-template-columns:${gridTracks(grid.columns)};grid-template-rows:${gridTracks(grid.rows)}"`
      : `style="--cols:${grid.columns.length};--rows:${grid.rows.length};"`;
    const pageOverflow = placements.filter((placement) =>
      placement.row_end > grid.rows.length || placement.column_end > grid.columns.length
    ).length;
    // P2-4: while a block is being moved the canvas highlights every cell it
    // can land in, and clicking one writes the new position.
    const movingId = paged && !paginationEditing ? "" : store.ui.movingPlacementId || "";
    const moving = movingId
      ? placements.find((placement) => placement.id === movingId) || null
      : null;
    const blockOf = (placement) =>
      placement
        ? view.blocks.find((block) => block.id === placement.block_id) || null
        : null;
    const activePageIndex = page ? view.pages?.findIndex((candidate) => candidate.id === page.id) ?? -1 : -1;
    // The legacy `输出分区` editor stays hidden until pagination is enabled:
    // `view.sections` is still maintained and still drives legacy export, but a
    // continuous grid must not offer a second, competing grouping control.
    return `${toolbar}${meta}${paged ? pageNavigation(view, layout, paginationEditing) : ""}${store.ui.paginationConversionPreview ? paginationConversionPreview(view, layout) : ""}${store.ui.pageSizePreview && !store.ui.pageSizePreview.conversion ? pageSizePreview(layout) : ""}<div class="grid-wrap ${
      gridEditing ? "editing" : ""
    }${paged ? " paged-canvas-wrap" : ""}">${paged && !page ? `<p class="layout-note">当前分页布局还没有页面，请新建页面后继续。</p>` : ""}${pageGeometry ? `<span class="page-canvas-size" data-page-id="${pageGeometry.page_id}" data-width-pt="${pageGeometry.logical_width_pt}" data-height-pt="${pageGeometry.logical_height_pt}">${activePageIndex + 1} / ${view.pages?.length || 0} · ${pageGeometry.logical_width_pt} × ${pageGeometry.logical_height_pt} pt · ${store.ui.layoutZoom === "actual" ? "实际尺寸" : "适合窗口"}</span>` : ""}${pageOverflow ? `<div class="page-overflow-warning">${pageOverflow} 块内容超出当前网格范围；页面保留了原放置，请调整网格或位置。</div>` : ""}${
      movingId ? movingBanner(moving, blockOf(moving)) : ""
    }<div class="grid-canvas${paged ? " paged-grid-canvas" : ""}" data-grid-surface="grid" ${canvasStyle}>${
      gridEditing ? gridLabels(grid) : ""
    }${
      placements.map((placement) => {
        const block = view.blocks.find((candidate) =>
          candidate.id === placement.block_id
        );
        if (!block) return "";
        const cell = placementGrid(placement, grid);
        const isMoving = movingId === placement.id;
        return `<div class="placement${paged && !paginationEditing ? " page-readonly" : ""}${
          store.ui.selectedBlockId === block.id ? " selected" : ""
        }${isMoving ? " moving" : ""}" style="grid-row:${cell.row};grid-column:${
          cell.column
        };" data-placement="${placement.id}" data-grid-role="placement" data-page-readonly="${paged && !paginationEditing ? "true" : "false"}" data-structure-block="${
          placement.block_id
        }" data-row="${placement.row_start}" data-col="${
          placement.column_start
        }" tabindex="${paged && !paginationEditing ? "-1" : "0"}" title="${paged && !paginationEditing ? "分页查看模式；点击‘编辑分页’后可调整位置" : "左键点击：移动这块内容 · 右键点击：移出网格"}"><span class="placement-label">${
          esc(block.label)
        }</span><span class="placement-text">${
          esc(block.summary || "（空）")
        }</span><span class="placement-cell">R${
          placement.row_start + 1
        }C${placement.column_start + 1}</span>${paged && !paginationEditing ? "" : `<div class="placement-actions"><button data-action="select-block" data-id="${
          placement.block_id
        }" title="编辑这块内容">✎</button>${paged && view.pages.length > 1 ? `<button data-action="start-page-move" data-id="${placement.id}" title="移动到其他页面">↗</button>` : ""}<button data-action="resize-placement" data-id="${
          placement.id
        }" data-dw="1" title="加宽一列">＋宽</button><button data-action="resize-placement" data-id="${
          placement.id
        }" data-dw="-1" title="减宽一列">−宽</button><button data-action="resize-placement" data-id="${
          placement.id
        }" data-dh="1" title="加高一行">＋高</button><button data-action="resize-placement" data-id="${
          placement.id
        }" data-dh="-1" title="减高一行">−高</button><button data-action="unplace-block" data-id="${
          placement.block_id
        }" title="移出网格（也可以直接右键）">✕</button></div>`}</div>`;
      }).join("")
    }${
      movingId ? moveTargets(view, grid, moving) : ""
    }</div></div><div class="unplaced-strip" data-grid-surface="unplaced"><span class="eyebrow" title="左键点击一块正文，它会落到第一个可用格子">还没有放进网格的正文</span>${
      unplaced.length
        ? `<div class="unplaced-list">${
          unplaced.map((block) =>
            `<button class="secondary unplaced-block" ${paged && !paginationEditing ? "disabled" : `data-action="place-block"`} data-id="${
              block.id
            }" title="${paged && !paginationEditing ? "编辑分页后可安排位置" : "左键点击：放进第一个可用格子"}">＋ ${esc(block.label)}：${
              esc((block.summary || "（空）").slice(0, 18))
            }</button>`
          ).join("")
        }</div>`
        : `<span class="muted small">全部正文都已经放进网格</span>`
    }</div>${paged && view.placed_elsewhere_blocks?.length ? `<div class="placed-elsewhere"><span class="eyebrow">其他页面（${view.placed_elsewhere_blocks.length} 块）</span>${view.placed_elsewhere_blocks.map((block) => { const placement = view.placement_of(block.id); const pageTitle = view.pages.find((candidate) => candidate.id === placement?.page_id)?.title || "其他页面"; return `<button class="secondary" data-action="select-layout-page" data-id="${placement?.page_id || ""}">${esc(block.label)} · ${esc(pageTitle)}</button>`; }).join("")}</div>` : ""}${paged ? `<p class="compatibility-note">旧版工作台不识别独立页面；重新打开时会按连续网格显示，不会删除当前分页数据。</p>` : ""}<p class="layout-note">${paged && !paginationEditing ? "页面当前为查看状态；页面与位置保持原样。点击“编辑分页”后可安排页面内容。" : "左键点正文上画布、左键点格子移动、右键移出；↑↓←→ 不再用于移动。网格只保存位置，正文、素材引用和待补仍然保存在原来的地方。"}</p>`;
  }

  function pageNavigation(view, layout, paginationEditing) {
    const pages = view.pages || [];
    const current = view.active_page;
    const currentIndex = pages.findIndex((page) => page.id === current?.id);
    const preset = layout.page_size?.preset || "legacy";
    const sizeOptions = [
      ["16:9", "16:9 横向"],
      ["a4-portrait", "A4 纵向"],
      ["a4-landscape", "A4 横向"],
      ...(preset === "legacy" ? [["legacy", "继承旧尺寸"]] : []),
    ];
    const pageActions = paginationEditing
      ? `<button class="secondary" data-action="page-rename" data-id="${current?.id || ""}" ${!current ? "disabled" : ""}>重命名</button><button class="secondary" data-action="page-reorder" data-id="${current?.id || ""}" data-direction="up" ${currentIndex <= 0 ? "disabled" : ""}>↑ 上移</button><button class="secondary" data-action="page-reorder" data-id="${current?.id || ""}" data-direction="down" ${currentIndex < 0 || currentIndex >= pages.length - 1 ? "disabled" : ""}>↓ 下移</button><button class="secondary" data-action="page-duplicate" data-id="${current?.id || ""}" ${!current ? "disabled" : ""}>复制页</button><button class="secondary" data-action="page-delete" data-id="${current?.id || ""}" ${pages.length <= 1 ? "disabled title=\"至少保留一页\"" : ""}>删除页</button>`
      : "";
    const pageSizeControl = paginationEditing
      ? `<label class="page-size-control">页面尺寸<select class="select" data-action="page-size-preview">${sizeOptions.map(([value, label]) => `<option value="${value}" ${preset === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>`
      : "";
    return `<div class="paged-page-tools"><div class="page-tabs" role="tablist" aria-label="页面导航">${pages.map((page, index) => `<button role="tab" aria-selected="${page.id === current?.id}" class="page-tab ${page.id === current?.id ? "active" : ""}" data-action="select-layout-page" data-id="${page.id}"><span>${esc(page.title)}</span><small>${index + 1} / ${pages.length}</small></button>`).join("")}${paginationEditing ? `<button class="secondary page-add" data-action="page-add">＋ 新建页</button>` : ""}</div><div class="page-action-row"><div class="page-actions">${pageActions}</div><div class="page-view-controls">${pageSizeControl}<button class="secondary ${store.ui.layoutZoom === "fit" ? "active-tool" : ""}" data-action="layout-zoom" data-zoom="fit">适合窗口</button><button class="secondary ${store.ui.layoutZoom === "actual" ? "active-tool" : ""}" data-action="layout-zoom" data-zoom="actual">实际尺寸</button></div></div><div class="pagination-edit-bar"><span>${paginationEditing ? "正在编辑本页 · 可调整页面与内容位置" : "分页画布处于查看模式；页面结构与内容位置不会被误改。"}</span><button class="secondary ${paginationEditing ? "active-tool" : ""}" data-action="toggle-pagination-edit">${paginationEditing ? "退出分页编辑" : "编辑分页"}</button></div>${paginationEditing && store.ui.movingPlacementTargetPageId ? pageMovePanel(view, layout) : ""}</div>`;
  }

  function paginationConversionPreview(view, layout) {
    const sections = view.sections || [];
    const placements = view.all_placements || view.placements;
    const loose = placements.filter((placement) => !sections.some((section) => section.id === placement.section_id)).length;
    const pending = store.ui.pageSizePreview || {};
    const size = pending.size || resolvePageSize(layout);
    const options = [["legacy", "保留旧布局几何"], ["16:9", "16:9 横向"], ["a4-portrait", "A4 纵向"], ["a4-landscape", "A4 横向"]];
    return `<div class="page-conversion-preview"><b>转换预览：${sections.length ? `${sections.length} 个输出分区各生成一页` : "现有网格生成一页"}</b><span>已有 ${placements.length} 块放置会保留网格位置；${loose ? `${loose} 块未分组放置会归到第一页；` : ""}未放置正文继续留在未放置列表。转换可以撤销。</span><label>页面尺寸<select class="select" data-action="conversion-page-size">${options.map(([value, label]) => `<option value="${value}" ${pending.preset === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><small>${sections.length || 1} 页 · ${size.width_pt} × ${size.height_pt} pt · 页面标题和跨格位置保留</small><div class="page-confirm-actions"><button class="secondary" data-action="cancel-pagination-conversion">取消</button><button class="primary" data-action="confirm-pagination-conversion">确认启用分页</button></div></div>`;
  }

  function pageSizePreview(layout) {
    const pending = store.ui.pageSizePreview;
    const current = resolvePageSize(layout);
    const next = pending.size || current;
    return `<div class="page-size-preview"><span>全部 ${store.layoutPages().length} 页将从 ${current.width_pt} × ${current.height_pt} pt 调整为 ${next.width_pt} × ${next.height_pt} pt。页面内相对位置和跨格保持，屏幕缩放不变。</span><div class="page-confirm-actions"><button class="secondary" data-action="cancel-page-size">取消</button><button class="primary" data-action="confirm-page-size">确认并保存到历史</button></div></div>`;
  }

  function pageMovePanel(view, layout) {
    const pending = store.ui.movingPlacementTargetPageId;
    const placement = view.all_placements.find((candidate) => candidate.id === pending.placementId);
    if (!placement) return `<div class="page-move-panel"><span>这块放置已经不存在。</span><button class="text-button" data-action="cancel-page-move">关闭</button></div>`;
    const block = view.blocks.find((candidate) => candidate.id === placement.block_id);
    if (!pending.targetPageId) {
      return `<div class="page-move-panel"><b>移动「${esc(block?.label || "正文")}」到…</b>${view.pages.filter((page) => page.id !== placement.page_id).map((page) => `<button class="secondary" data-action="choose-page-move-target" data-id="${page.id}">${esc(page.title)}</button>`).join("")}<button class="text-button" data-action="cancel-page-move">取消</button></div>`;
    }
    const targetPage = view.pages.find((page) => page.id === pending.targetPageId);
    if (!targetPage) return "";
    const grid = pageGrid(layout, targetPage);
    const rowSpan = Math.max(1, placement.row_end - placement.row_start);
    const columnSpan = Math.max(1, placement.column_end - placement.column_start);
    const occupied = view.all_placements.filter((candidate) => candidate.page_id === targetPage.id);
    const targets = freeCellsFor(grid, occupied, { rowSpan, columnSpan });
    return `<div class="page-move-panel"><b>选择「${esc(targetPage.title)}」里的可用位置（跨 ${rowSpan} 行 × ${columnSpan} 列）</b>${targets.length ? targets.map((cell) => `<button class="secondary" data-action="move-placement-page-cell" data-id="${placement.id}" data-page-id="${targetPage.id}" data-row="${cell.row}" data-col="${cell.column}">R${cell.row + 1} · C${cell.column + 1}</button>`).join("") : `<span class="muted small">目标页没有能容纳此内容的空位；原放置保持不变。</span>`}<button class="text-button" data-action="cancel-page-move">取消</button></div>`;
  }

  /** The banner that names the block currently being moved (P2-4). */
  function movingBanner(placement, block) {
    return `<div class="grid-moving-banner" data-moving-placement="${
      placement ? placement.id : ""
    }"><b>正在移动：${
      esc(block ? block.label : "这块内容")
    }</b><span>点一个高亮格子放下，或按 Esc 取消。</span><button class="text-button" data-action="grid-cancel-move">取消移动</button></div>`;
  }

  /** Every cell the moving block can land in, highlighted and clickable. */
  function moveTargets(view, grid, placement) {
    if (!placement) return "";
    const rowSpan = Math.max(1, placement.row_end - placement.row_start);
    const columnSpan = Math.max(1, placement.column_end - placement.column_start);
    const allowed = freeCellsFor(grid, view.placements, {
      rowSpan,
      columnSpan,
      exceptId: placement.id,
    });
    return allowed.map((cell) => {
      const current = cell.row === placement.row_start &&
        cell.column === placement.column_start;
      // The cell the block already occupies is NOT a `disabled` button: a
      // disabled control swallows the pointer entirely, so the block under it
      // could no longer be clicked (or clicked out of move mode).  It stays
      // non-interactive through CSS (`pointer-events: none`) and tells the
      // right thing to assistive tech.
      return `<button class="grid-cell-target${
        current ? " current" : ""
      }" style="grid-row:${cell.row + 1};grid-column:${
        cell.column + 1
      };" data-action="grid-move-to" data-grid-role="move-target" data-id="${placement.id}" data-row="${
        cell.row
      }" data-col="${cell.column}"${
        current ? ' data-current="true" aria-disabled="true"' : ""
      } title="${
        current ? "这块内容现在就在这里" : "把这块内容放到这里"
      }">${current ? "当前" : "放这里"}</button>`;
    }).join("");
  }

  function gridLabels(grid) {
    return `<div class="track-labels cols">${
      grid.columns.map((_, i) => `<span>C${i + 1}</span>`).join("")
    }</div><div class="track-labels rows">${
      grid.rows.map((_, i) => `<span>R${i + 1}</span>`).join("")
    }</div>`;
  }

  /* ------------------------------------------------------------ preview */

  /**
   * One block, rendered as preview HTML.  Flow and Grid both come through here,
   * so a block can never look different depending on the layout mode.
   */
  function previewBlockHtml(block, showNotes) {
    {
      switch (block.type) {
        case "heading": {
          return markdownBlockHtml(block);
        }
        case "quote":
          return markdownBlockHtml(block);
        case "code":
          return `<pre class="preview-code"><code>${
            esc(block.text)
          }</code></pre>`;
        case "divider":
          return `<hr />`;
        case "callout":
          return markdownBlockHtml(block);
        case "placeholder":
          return showNotes
            ? `<div class="preview-placeholder">占位符：${
              esc(block.text)
            }（不在正式内容中）</div>`
            : "";
        case "image":
        case "gif":
        case "video":
        case "audio":
        case "embed":
          return previewMedia(block, showNotes);
        default:
          return block.text.trim()
            ? markdownBlockHtml(block)
            : showNotes
            ? `<div class="preview-placeholder">这一段还是空的</div>`
            : "";
      }
    }
  }

  /**
   * A canvas extent that never clips content: a placement saved before the grid
   * definition shrank must still be visible in the preview (the preflight
   * reports the same case as a blocking `canvas_overflow`).
   */
  function previewExtent(placements, grid) {
    let rows = Array.isArray(grid?.rows) ? grid.rows.length : 1;
    let columns = Array.isArray(grid?.columns) ? grid.columns.length : 1;
    for (const placement of placements) {
      rows = Math.max(rows, Number(placement.row_end) || 1);
      columns = Math.max(columns, Number(placement.column_end) || 1);
    }
    return { rows: Math.max(1, rows), columns: Math.max(1, columns) };
  }

  /**
   * Grid projection: the same canonical blocks and the same LayoutInstance the
   * export reads, drawn at their real row/column/span.  Sections are separate
   * canvases because that is what a multi-page export does with them.
   */
  function previewGridHtml(view, layout, showNotes) {
    const grid = layout.grid_definition || { columns: [1], rows: [1] };
    const sections = view.sections || [];
    const inSection = (placement, sectionId) => placement.section_id === sectionId;
    const groups = [];
    for (const section of sections) {
      const placements = view.placements.filter((placement) =>
        inSection(placement, section.id)
      );
      if (placements.length) {
        groups.push({
          title: `${section.name} · 第 ${section.page_index + 1} 页`,
          grid: section.grid_definition || grid,
          placements,
        });
      }
    }
    const loose = view.placements.filter((placement) =>
      !sections.some((section) => inSection(placement, section.id))
    );
    if (loose.length) {
      groups.push({
        title: sections.length ? "未分区" : "",
        grid,
        placements: loose,
      });
    }
    if (!groups.length) {
      groups.push({ title: "", grid, placements: view.placements });
    }
    const canvases = groups.map((group) => {
      const extent = previewExtent(group.placements, group.grid);
      const cells = group.placements.map((placement) => {
        const block = view.blocks.find((candidate) =>
          candidate.id === placement.block_id
        );
        if (!block) return "";
        const cell = placementGrid(placement, {
          columns: new Array(extent.columns).fill(1),
          rows: new Array(extent.rows).fill(1),
        });
        return `<div class="preview-grid-cell" style="grid-row:${
          cell.row
        };grid-column:${cell.column};" data-preview-block="${
          block.id
        }">${previewBlockHtml(block, showNotes)}</div>`;
      }).join("");
      return `<section class="preview-canvas">${
        group.title
          ? `<span class="preview-section-tag">${esc(group.title)}</span>`
          : ""
      }<div class="preview-grid" style="--cols:${extent.columns};--rows:${
        extent.rows
      };">${cells}</div></section>`;
    }).join("");
    const placedIds = new Set(view.placements.map((placement) => placement.block_id));
    const unplaced = view.blocks.filter((block) => !placedIds.has(block.id));
    const unplacedHtml = unplaced.length
      ? `<div class="preview-unplaced"><span class="eyebrow" title="这些正文还没有网格位置；导出时它们排在正文顺序的末尾">还没有放进网格（${
        unplaced.length
      } 块）</span>${
        unplaced.map((block) =>
          `<div class="preview-unplaced-item" data-preview-block="${
            block.id
          }">${previewBlockHtml(block, showNotes)}</div>`
        ).join("")
      }</div>`
      : "";
    return {
      html: `${canvases}${unplacedHtml}`,
      unplacedCount: unplaced.length,
      grid,
    };
  }

  function previewPagedHtml(item, view, layout, showNotes) {
    const pages = view.pages || [];
    const page = view.active_page || pages[0];
    if (!page) return { html: `<div class="empty-state"><h2>还没有页面</h2><p>回到排版画布新建页面。</p></div>`, unplacedCount: view.blocks.length, grid: view.page_grid };
    const projection = buildPublicationProjection(store.data, {
      content_item_id: item.id,
      layout_instance_id: layout.id,
      page_ids: [page.id],
    });
    const projectedLayout = projection.lessons[0]?.layout;
    const projectedPage = projectedLayout?.pages?.[0];
    if (!projectedPage) return { html: "", unplacedCount: 0, grid: view.page_grid };
    const width = projectedPage.logical_width_pt;
    const height = projectedPage.logical_height_pt;
    const ratio = width / height;
    const displayWidth = store.ui.layoutZoom === "actual"
      ? `${width * 4 / 3}px`
      : `min(100%, 900px, ${Math.min(68, 68 * ratio)}vh)`;
    const blockById = new Map(view.blocks.map((block) => [block.id, block]));
    const items = projectedPage.items.map((entry) => {
      const block = blockById.get(entry.block_id);
      if (!block) return "";
      const rect = entry.rect;
      const style = `left:${rect.x_pt / width * 100}%;top:${rect.y_pt / height * 100}%;width:${rect.width_pt / width * 100}%;height:${rect.height_pt / height * 100}%;z-index:${entry.style.z_index};text-align:${esc(entry.style.alignment?.horizontal || "left")};`;
      return `<div class="page-preview-item" data-preview-block="${block.id}" style="${style}">${previewBlockHtml(block, showNotes)}</div>`;
    }).join("");
    const pageIndex = pages.findIndex((candidate) => candidate.id === page.id);
    const pageNav = `<div class="page-preview-tabs" role="tablist" aria-label="预览页面">${pages.map((candidate) => `<button role="tab" aria-selected="${candidate.id === page.id}" class="page-tab ${candidate.id === page.id ? "active" : ""}" data-action="select-layout-page" data-id="${candidate.id}">${esc(candidate.title)}</button>`).join("")}</div><div class="page-preview-controls"><span>${pageIndex + 1} / ${pages.length} · ${width} × ${height} pt</span><button class="secondary" data-action="layout-zoom" data-zoom="fit">适合窗口</button><button class="secondary" data-action="layout-zoom" data-zoom="actual">实际尺寸</button></div>`;
    const unplaced = (projectedLayout.unplaced_block_ids || []).map((blockId) => blockById.get(blockId)).filter(Boolean);
    const unplacedHtml = unplaced.length
      ? `<div class="preview-unplaced"><span class="eyebrow">还没有放在页面上（${unplaced.length} 块）</span>${unplaced.map((block) => `<div class="preview-unplaced-item" data-preview-block="${block.id}">${previewBlockHtml(block, showNotes)}</div>`).join("")}</div>`
      : "";
    return {
      html: `${pageNav}<div class="page-preview-viewport ${store.ui.layoutZoom === "actual" ? "actual" : "fit"}"><section class="page-preview-sheet" style="width:${displayWidth};aspect-ratio:${width}/${height}"><div class="page-preview-content">${items}</div></section></div>${unplacedHtml}`,
      unplacedCount: unplaced.length,
      grid: view.page_grid,
    };
  }

  function previewView(item, view) {
    if (!view) return "";
    const showNotes = store.ui.showPreviewNotes !== false;
    // Explicit media blocks and resolved Markdown image references both render
    // inline. Deduplicate by asset so the summary agrees with what the lesson uses.
    const galleryById = new Map();
    for (const block of view.blocks) {
      if (block.asset) galleryById.set(block.asset.id, block.asset);
      const mappings = Array.isArray(block.settings?.markdown_assets)
        ? block.settings.markdown_assets
        : [];
      if (!mappings.length) continue;
      const referencedHrefs = new Set(
        parseMarkdown(block.text).explicitLocalImageRefs.map((reference) => reference.href),
      );
      for (const mapping of mappings) {
        if (!referencedHrefs.has(mapping?.href)) continue;
        const asset = store.data.assets.find((candidate) =>
          candidate.id === mapping?.asset_id && !candidate.archived
        );
        if (asset && (asset.type === "image" || asset.type === "gif")) {
          galleryById.set(asset.id, asset);
        }
      }
    }
    const gallery = [...galleryById.values()];
    const layout = view.lesson.layout;
    const pagedMode = Boolean(layout?.mode === "grid" && layout.pagination_mode === "paged");
    const gridMode = Boolean(
      layout && layout.mode === "grid" && (pagedMode || view.placements.length),
    );
    const projected = pagedMode
      ? previewPagedHtml(item, view, layout, showNotes)
      : gridMode
      ? previewGridHtml(view, layout, showNotes)
      : null;
    const body = gridMode ? "" : view.blocks.map((block) =>
      previewBlockHtml(block, showNotes)
    ).join("");
    const placedCount = view.placements.length;
    return `<div class="preview-toolbar"><span>预览只读取同一份正文与素材引用，编辑时实时更新。</span><label class="checkbox-inline"><input type="checkbox" data-preview-notes data-focus-key="preview-notes" ${
      showNotes ? "checked" : ""
    } /> 显示待补与空段落</label><button class="secondary" data-action="preflight">导出前检查</button></div><div class="preview-meta"><span>排版：${
      layout ? `${esc(layout.name)} · ${layout.mode === "flow" ? "Flow" : "Grid"}` : "未设置"
    }</span><span>${
      gridMode
        ? `${projected.grid.columns.length} 列 × ${projected.grid.rows.length} 行 · 已放置 ${placedCount} 块${
          projected.unplacedCount ? ` · 未上画布 ${projected.unplacedCount} 块` : ""
        }`
        : placedCount
        ? `Flow 按正文顺序输出（${placedCount} 块已放置，不影响顺序）`
        : "还没有网格放置"
    }</span><span>正文 ${view.blocks.length} 块</span></div><article class="preview-paper${
      gridMode || pagedMode ? " preview-paper-grid" : ""
    }">${
      gridMode
        ? projected.html
        : body ||
          `<p class="muted">这一课还没有正文。回到正文视图写一段，预览会自动更新。</p>`
    }</article><div class="preview-assets"><span class="eyebrow">本课引用的素材（${
      gallery.length
    } 个已在正文中显示）</span>${
      gallery.length
      ? `<div class="preview-asset-list">${
          gallery.map((asset) =>
            `<span class="badge">${
              esc(asset.title || asset.filename)
            } · ${esc(assetLabel(asset.type))}</span>`
          ).join("")
        }</div>`
        : `<span class="muted small">这一课还没有使用素材，可以继续写正文。</span>`
    }</div>`;
  }

  function previewMedia(block, showNotes) {
    const asset = block.asset;
    if (!asset) {
      return showNotes
        ? `<div class="preview-placeholder">${
          esc(block.label)
        }：还没有选择素材。你可以继续编辑，或回到媒体库添加。</div>`
        : "";
    }
    // Markdown and other text bundles render their real content, which is the
    // whole point of importing them as material. The frame is what a settled
    // preview rewrites, so the block id travels with it.
    return previewFrame(
      asset,
      "preview",
      previewMediaBody(asset, block),
      ` data-block-id="${esc(block.id || "")}"`,
    );
  }

  /* ------------------------------------------------------------ backlog */

  function backlogView() {
    const backlog = requirementBacklog(store.data);
    const map = courseMap(store.data, store.ui.activeId);
    const groups = [...backlog.by_lesson.entries()];
    const entries = groups.flatMap(([, group]) => group);
    const priorityCount = entries.filter((entry) => entry.priority === "high").length;
    const next = entries.find((entry) => entry.priority === "high") || entries[0] || null;
    if (backlog.total === 0) {
      return `<section class="page backlog-page is-empty"><div class="page-head"><div><span class="eyebrow">课程维护</span><h1>待补总览</h1><p class="muted">所有需要补充的内容都会按课次集中在这里。</p></div></div><div class="empty-state backlog-empty"><span class="empty-icon" aria-hidden="true">✓</span><h2>目前没有待补内容</h2><p class="muted">课程可以继续写作、检查排版或准备发布。</p><div class="action-row"><button class="primary" data-action="route" data-route="map">打开课程地图</button><button class="secondary" data-action="route" data-route="publish">准备发布</button></div></div></section>`;
    }
    return `<section class="page backlog-page"><div class="page-head"><div><span class="eyebrow">课程维护</span><h1>待补总览 <sup>${
      backlog.total
    }</sup></h1><p class="muted">按课次查看类型、备注和正文位置，直接跳到需要处理的内容。</p></div><div class="page-head-actions">${next ? `<button class="primary" data-action="focus-requirement" data-id="${esc(next.id)}">定位优先项</button>` : ""}<button class="secondary" data-action="route" data-route="map">课程地图</button></div></div><div class="summary-grid backlog-summary" aria-label="待补概况"><article class="summary-card"><span>待补项目</span><strong>${backlog.total}</strong><small>需要处理的内容</small></article><article class="summary-card"><span>涉及课次</span><strong>${groups.length}</strong><small>按课次分组</small></article><article class="summary-card ${priorityCount ? "warning" : ""}"><span>优先处理</span><strong>${priorityCount}</strong><small>${priorityCount ? "重要待补项" : "没有标记为重要的项目"}</small></article></div><div class="backlog-list">${
      groups.map(([lessonId, entries]) => {
        const lesson = map.lessons.find((candidate) => candidate.id === lessonId);
        return `<section class="backlog-group page-section surface-card"><div class="backlog-head"><div><span class="eyebrow">课次 · ${entries.length} 项</span><h2>${
          esc(lesson ? `${lesson.code}｜${lesson.title}` : "未知内容")
        }</h2></div><button class="text-button" data-action="open-item" data-id="${
          esc(lessonId)
        }">进入这一课 →</button></div><div class="backlog-rows" role="list">${
          entries.map((entry) =>
            `<article class="backlog-row list-row" role="listitem"><span class="req-dot open" aria-hidden="true">!</span><div class="backlog-note"><div class="backlog-row-title"><b>${
              esc(requirementTypeLabel(entry.type))
            }</b><span class="status-pill ${entry.priority === "high" ? "is-warning" : "is-open"}">${
              entry.priority === "high" ? "优先处理" : "待补"
            }</span></div><p>${esc(entry.note || "尚未添加备注")}</p><small class="backlog-location">${
              entry.anchor_text
                ? `正文位置：${esc(entry.anchor_text.slice(0, 80))}`
                : entry.block_id
                ? "正文位置：已关联正文区块"
                : "正文位置：整课"
            }</small></div><div class="action-row backlog-actions"><button class="secondary" data-action="focus-requirement" data-id="${
              esc(entry.id)
            }">定位并处理</button></div></article>`
          ).join("")
        }</div></section>`;
      }).join("")
    }</div></section>`;
  }

  /* ------------------------------------------------------------ overview */

  function overviewView() {
    const map = courseMap(store.data, store.ui.activeId);
    const openInbox = store.data.inbox_items.filter((item) =>
      item.status === "open"
    ).length;
    const resumeId = store.resumeLessonId();
    const resume = map.lessons.find((lesson) => lesson.id === resumeId) || null;
    const backlog = requirementBacklog(store.data);
    const recentEdits = store.data.content_items.filter((item) => !item.archived)
      .slice().sort((left, right) =>
        (Date.parse(right.updated_at || right.created_at || "") || 0) -
        (Date.parse(left.updated_at || left.created_at || "") || 0)
      ).slice(0, 4);
    const editTime = (item) => {
      const value = Date.parse(item.updated_at || item.created_at || "");
      return Number.isFinite(value)
        ? new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })
        : "已有内容";
    };
    return `<section class="page overview-page"><div class="page-head"><div><span class="eyebrow">项目概览</span><h1>${
      esc(store.data.project.title)
    }</h1><p class="muted">从想法到发布，今天继续完成一小步。</p></div><div class="page-head-actions"><button class="primary" data-action="route" data-route="map">打开课程地图 →</button>${
      store.bridge.isNative()
        ? `<button class="secondary" data-action="append-files">导入文件</button><button class="secondary" data-action="append-folder">导入文件夹</button>`
        : ""
    }</div></div><div class="summary-grid"><div class="summary-card"><span>课程内容</span><strong>${
      map.lesson_count
    }</strong><small>已完成 ${map.complete_count} 课</small></div><div class="summary-card ${
      map.open_requirements ? "warning" : ""
    }"><span>待补内容</span><strong>${
      map.open_requirements
    }</strong><small>${backlog.by_lesson.size} 课涉及</small></div><div class="summary-card"><span>收件箱</span><strong>${openInbox}</strong><small>条待处理输入</small></div><div class="summary-card"><span>媒体</span><strong>${
      store.data.assets.filter((asset) => !asset.archived).length
    }</strong><small>个项目素材</small></div></div><div class="overview-grid"><div class="card"><div class="card-head"><h2>继续工作</h2>${
      resume
        ? `<button class="text-button" data-action="open-item" data-id="${resume.id}">打开 →</button>`
        : ""
    }</div>${
      resume
        ? `<div class="continue-row"><span class="continue-code">${
          esc(resume.code)
        }</span><div><b>${esc(resume.title)}</b><p class="muted">${
          esc(resume.summary)
        }</p><div class="progress-track"><span style="width:${
          resume.progress.percentage
        }%"></span></div><small class="muted">${
          resume.progress.complete
            ? "这一课已经完成"
            : esc(resume.progress.reasons.slice(0, 2).join("；"))
        }</small></div></div>`
        : `<div class="side-empty">还没有课程内容。打开课程地图新建一课，就可以继续。</div>`
    }</div><div class="card"><div class="card-head"><h2>待处理</h2><button class="text-button" data-action="route" data-route="backlog">查看全部 →</button></div><ul class="task-list"><li><span class="task-dot orange"></span><span>收件箱</span><b>${openInbox}</b></li><li><span class="task-dot purple"></span><span>待补内容</span><b>${
      map.open_requirements
    }</b></li><li><span class="task-dot blue"></span><span>缺素材</span><b>${
      map.missing_media
    }</b></li></ul></div></div><section class="card overview-activity"><div class="card-head"><div><span class="eyebrow">最近修改</span><h2>最近编辑的课时</h2></div><button class="text-button" data-action="route" data-route="map">查看课程地图 →</button></div>${
      recentEdits.length
        ? `<ul class="overview-activity-list">${recentEdits.map((item) =>
          `<li><button type="button" data-action="open-item" data-id="${item.id}" aria-label="打开${esc(item.code)} ${esc(item.title)}"><span class="continue-code">${esc(item.code)}</span><span class="overview-activity-title"><b>${esc(item.title)}</b><small class="muted">${esc(item.type || "课程内容")}</small></span><time class="muted small">${esc(editTime(item))}</time></button></li>`
        ).join("")}</ul>`
        : `<div class="overview-activity-empty side-empty">还没有最近修改。新建第一课后，编辑记录会显示在这里。</div>`
    }</section></section>`;
  }

  /* --------------------------------------------------------------- inbox */

  function inboxView() {
    const items = store.data.inbox_items.filter((item) =>
      item.status !== "archived"
    );
    const pending = items.filter((item) => item.status !== "triaged" && !item.asset_id);
    const assetized = items.filter((item) => Boolean(item.asset_id));
    const savedAsAsset = assetized.filter((item) => item.status !== "triaged");
    const assigned = items.filter((item) => item.status === "triaged");
    const cardView = (item) => {
      const state = item.status === "triaged"
        ? ["已分配到课程", "is-done"]
        : item.asset_id
        ? ["已保存为素材", "is-done"]
        : ["尚未决定用途", "is-open"];
      return `<article class="inbox-card list-row surface-card"><span class="inbox-type" aria-hidden="true">${
            item.source_type === "web" ? "🔗" : item.asset_id ? "🖼" : "📝"
          }</span><div class="inbox-main"><div class="inbox-row-meta"><span class="eyebrow">${
            esc(item.source_type === "web" ? "网页" : "灵感")
          }</span><span class="status-pill ${state[1]}">${state[0]}</span>${item.status === "triaged" && item.asset_id ? '<span class="status-pill is-done">已保存为素材</span>' : ""}</div><h2>${esc(item.title || "未命名输入")}</h2><p>${
            esc(item.body || "没有正文内容")
          }</p></div><div class="inbox-actions action-row"><button class="secondary" data-action="triage-inbox" data-id="${
            esc(item.id)
          }" ${
            store.ui.activeId ? "" : "disabled"
          } aria-label="将 ${esc(item.title || "这条输入")} 加入当前课程">加入当前课程</button>${
            item.asset_id
              ? ""
              : `<button class="secondary" data-action="assetize-inbox" data-id="${esc(item.id)}">保存为素材</button>`
          }<button class="text-button" data-action="ignore-inbox" data-id="${
            esc(item.id)
          }">忽略</button></div></article>`;
    };
    const section = (id, title, description, rows, empty) => `<section class="page-section inbox-section" aria-labelledby="${id}"><div class="inbox-section-head"><div><h2 id="${id}">${title}</h2><p class="muted">${description}</p></div><span class="status-pill">${rows.length}</span></div>${rows.length ? `<div class="inbox-list" role="list">${rows.map((item) => cardView(item)).join("")}</div>` : `<p class="inbox-section-empty">${empty}</p>`}</section>`;
    return `<section class="page inbox-page"><div class="page-head"><div><span class="eyebrow">项目级输入</span><h1>收件箱 <sup>${
      items.length
    }</sup></h1><p class="muted">先收集，再分配到课程或保存为素材。每条输入都保留自己的处理状态。</p></div><div class="page-head-actions"><button class="primary" data-action="capture">＋ 快速收集</button></div></div><div class="summary-grid inbox-summary" aria-label="收件箱状态"><article class="summary-card ${pending.length ? "warning" : ""}"><span>待决定</span><strong>${pending.length}</strong><small>尚未分配用途</small></article><article class="summary-card"><span>已分配</span><strong>${assigned.length}</strong><small>已加入课程</small></article><article class="summary-card"><span>已保存素材</span><strong>${assetized.length}</strong><small>可在媒体库查看</small></article></div>${
      !store.ui.activeId && pending.length
        ? `<p class="inbox-context-note" role="status">选择一课后即可将待处理输入加入正文；保存为素材和忽略操作不受影响。</p>`
        : ""
    }${
      items.length
        ? `${section("inbox-pending", "待决定", "选择加入当前课程、保存为素材，或忽略。", pending, "没有等待分配的输入。")}${section("inbox-assets", "已保存为素材", "这些输入已进入媒体库，可继续在课程中引用。", savedAsAsset, "还没有从收件箱保存素材。")}${section("inbox-assigned", "已分配到课程", "已经加入课程的输入仍保留在这里，便于回看来源。", assigned, "还没有分配到课程的输入。")}`
        : `<div class="empty-state inbox-empty"><span class="empty-icon" aria-hidden="true">↓</span><h2>收件箱是空的</h2><p class="muted">快速收集一句话、网页或截图，稍后再决定怎么处理。</p><button class="secondary" data-action="capture">快速收集</button></div>`
    }</section>`;
  }

  /* --------------------------------------------------------------- board */

  function boardView() {
    const dimension = store.ui.boardDimension || "content";
    const map = courseMap(store.data, store.ui.activeId);
    const configuredOptions = store.statusOptions(dimension);
    const options = Array.isArray(configuredOptions) && configuredOptions.length
      ? configuredOptions
      : ["未设置"];
    const selectedOf = (lesson) => {
      const status = lesson.progress.statuses.find((candidate) =>
        candidate.key === dimension
      );
      return status && status.option ? status.option : options[0];
    };
    const dimensions = [
      ["content", "正文"],
      ["media", "媒体"],
      ["layout", "排版"],
      ["review", "审核"],
      ["publish", "发布"],
      ["update", "更新"],
    ];
    const cards = options.map((option) => {
      const lessons = map.lessons.filter((lesson) => selectedOf(lesson) === option);
      return `<section class="kanban-column board-column page-section surface-card" data-board-option="${
        esc(option)
      }" aria-label="${esc(option)}，${lessons.length} 课"><header class="kanban-head board-column-head"><h2>${esc(option)}</h2><span class="status-pill">${lessons.length} 课</span></header>${
        lessons.length
          ? `<div class="board-card-list">${lessons.map((lesson) =>
            `<button draggable="true" class="kanban-card board-card list-row ${
              lesson.current ? "current" : ""
            }" data-action="open-item" data-board-id="${esc(lesson.id)}" data-id="${
              esc(lesson.id)
            }" aria-label="打开 ${esc(lesson.code)} ${esc(lesson.title)}，${lesson.progress.complete ? "已完成" : `待补 ${lesson.progress.open_requirements} 项`}"><span class="board-card-code">${
              esc(lesson.code)
            }</span><b>${esc(lesson.title)}</b><span class="board-card-meta"><span class="status-pill ${lesson.progress.complete ? "is-done" : "is-open"}">${
              lesson.progress.complete ? "已完成" : `待补 ${lesson.progress.open_requirements} 项`
            }</span><span>${lesson.progress.percentage}%</span></span></button>`
          ).join("")}</div>`
          : `<p class="board-column-empty">当前状态下还没有课时。</p>`
      }</section>`;
    }).join("");
    return `<section class="page board-page"><div class="page-head"><div><span class="eyebrow">课程执行</span><h1>制作看板</h1><p class="muted">按一个状态维度浏览课程进度；拖动课时即可更新该维度。</p></div><div class="page-head-actions"><label class="field-label board-dimension">状态维度<select class="select" data-board-dimension aria-label="正在修改的状态维度">${
      [
      ...dimensions,
      ].map(([key, label]) =>
        `<option value="${key}" ${
          dimension === key ? "selected" : ""
        }>${label}</option>`
      ).join("")
    }</select></label><button class="${map.lesson_count ? "secondary" : "primary"}" data-action="${map.lesson_count ? "open-workbench" : "route"}" ${map.lesson_count ? "" : 'data-route="map"'}>${map.lesson_count ? "打开当前课" : "创建第一课"}</button></div></div><div class="summary-grid board-summary" aria-label="课程进度概况"><article class="summary-card"><span>课程内容</span><strong>${map.lesson_count}</strong><small>当前课程课次</small></article><article class="summary-card"><span>已完成</span><strong>${map.complete_count}</strong><small>${map.lesson_count ? `${Math.round(map.complete_count / map.lesson_count * 100)}% 完成` : "还没有课程内容"}</small></article><article class="summary-card ${map.open_requirements ? "warning" : ""}"><span>待补内容</span><strong>${map.open_requirements}</strong><small>跨课次累计</small></article></div>${
      map.lesson_count
        ? `<div class="kanban board-columns" aria-label="${dimensions.find(([key]) => key === dimension)?.[1] || "状态"}状态分组">${cards}</div>`
        : `<div class="empty-state board-empty"><span class="empty-icon" aria-hidden="true">▤</span><h2>课程还没有课时</h2><p class="muted">先在课程地图建立阶段和课时，再回来按状态跟进制作进度。</p><button class="primary" data-action="route" data-route="map">打开课程地图</button></div>`
    }</section>`;
  }

  /* --------------------------------------------------------------- media */

  function explorerView() {
    const report = store.ui.folderScan;
    const rootLabel = store.ui.importFolderRoot || report?.root || "";
    const entries = Array.isArray(report?.entries) ? report.entries : [];
    const filter = String(store.ui.explorerFilter || "");
    const filtered = filterExplorerEntries(entries, filter);
    const tree = buildExplorerTree(filtered);
    const expanded = new Set(
      Array.isArray(store.ui.explorerExpanded) ? store.ui.explorerExpanded : [],
    );
    const selected = store.ui.explorerSelected || "";
    const preview = store.ui.explorerPreview;
    const fileCount = entries.filter((entry) => entry.kind !== "directory").length;
    const folderCount = entries.filter((entry) => entry.kind === "directory").length;

    const renderNode = (node, depth) => {
      const isDir = node.kind === "directory";
      const isOpen = expanded.has(node.relative_path);
      const isSelected = selected === node.relative_path;
      const entry = node.entry || {};
      const type = explorerTypeLabel(entry);
      const status = explorerStatusLabel(entry);
      const size = isDir || entry.size == null ? "—" : formatBytes(entry.size);
      const toggle = isDir
        ? `<button class="explorer-toggle" data-action="explorer-toggle" data-path="${
          esc(node.relative_path)
        }" title="${isOpen ? "折叠" : "展开"}" aria-label="${isOpen ? "折叠" : "展开"}文件夹：${esc(node.name)}" aria-expanded="${isOpen ? "true" : "false"}">${
          isOpen ? "▾" : "▸"
        }</button>`
        : `<span class="explorer-toggle spacer"></span>`;
      const children = isDir && isOpen
        ? node.children.map((child) => renderNode(child, depth + 1)).join("")
        : "";
      return `<div class="explorer-row ${isSelected ? "selected" : ""} ${
        entry.error ? "degraded" : ""
      }" style="--explorer-depth:${depth}">${toggle}<button type="button" class="explorer-entry" data-action="explorer-select" data-path="${
        esc(node.relative_path)
      }" aria-pressed="${isSelected}" aria-label="预览${isDir ? "文件夹" : "文件"}：${esc(node.name)}"><span class="explorer-name" title="${
        esc(node.relative_path)
      }"><span class="explorer-item-icon" aria-hidden="true">${isDir ? "▰" : "▤"}</span><span>${esc(node.name)}</span></span><span class="explorer-type">${
        esc(type)
      }</span><span class="explorer-meta"><span class="explorer-status">${esc(status)}</span><small class="explorer-size">${esc(size)}</small></span></button></div>${children}`;
    };

    const previewPane = () => {
      if (!selected || !preview) {
        return `<div class="explorer-preview-empty"><div class="empty-icon" aria-hidden="true">▤</div><span class="eyebrow">只读预览</span><h2>从资料列表选择一项</h2><p class="muted">支持 Markdown、TXT、图片、视频、音频与 PDF 预览；DOCX 显示文件信息。浏览不会导入素材或改写项目。</p></div>`;
      }
      const name = explorerEntryName(preview.relative_path || selected);
      const meta = [
        explorerTypeLabel({
          relative_path: preview.relative_path || selected,
          mime: preview.mime,
          kind: preview.preview_kind === "directory" ? "directory" : "file",
          suggested_role: preview.preview_kind === "reference" ? "reference" : null,
        }),
        preview.size != null ? formatBytes(preview.size) : null,
        preview.mime || null,
      ].filter(Boolean).join(" · ");
      const head =
        `<div class="explorer-preview-head"><span class="eyebrow">文件预览</span><h2>${
          esc(name)
        }</h2><p class="muted">${esc(meta || selected)}</p></div>`;
      if (preview.loading) {
        return `${head}<div class="explorer-preview-body loading"><p class="muted">正在读取预览…</p></div>`;
      }
      if (preview.failed) {
        return `${head}<div class="explorer-preview-body failed"><p>${
          esc(preview.error || preview.note || "无法预览该文件")
        }</p><button class="text-button" data-action="explorer-retry">重试读取</button></div>`;
      }
      if (preview.preview_kind === "text" && typeof preview.text === "string") {
        const isMd = /\.(md|markdown)$/i.test(name);
        return `${head}<div class="explorer-preview-body text">${
          isMd
            ? `<div class="explorer-md">${renderMarkdown(preview.text, { resolveImage: (href) => store.explorerMarkdownImageUrls?.[href] || null })}</div>`
            : `<pre class="explorer-text">${esc(preview.text)}</pre>`
        }</div>`;
      }
      if (preview.preview_kind === "image" && preview.url) {
        return `${head}<div class="explorer-preview-body media"><img class="explorer-image" src="${
          esc(preview.posterUrl || preview.url)
        }" alt="${esc(name)}" /></div>`;
      }
      if (preview.preview_kind === "video" && preview.url) {
        return `${head}<div class="explorer-preview-body media"><div class="explorer-media-card" style="display:grid;place-items:center;position:relative"><video class="explorer-video" src="${
          esc(preview.url)
        }" poster="${esc(preview.posterUrl || "")}" controls preload="none" playsinline></video><button class="asset-video-play" type="button" data-action="play-explorer-video" aria-label="播放视频" title="播放视频" style="align-items:center;background:#111b;border:0;border-radius:50%;color:white;cursor:pointer;font-size:28px;height:64px;left:50%;position:absolute;top:50%;transform:translate(-50%,-50%);width:64px">▶</button><small>视频预览 · 播放前不会启动</small></div></div>`;
      }
      if (preview.preview_kind === "audio" && preview.url) {
        return `${head}<div class="explorer-preview-body media"><div class="explorer-media-card"><audio class="explorer-audio" src="${
          esc(preview.url)
        }" controls preload="metadata"></audio><small>音频</small></div></div>`;
      }
      if (preview.preview_kind === "pdf" && preview.url) {
        return `${head}<div class="explorer-preview-body media"><iframe class="explorer-pdf" src="${esc(preview.url)}" title="${esc(name)} · PDF 第一页预览" loading="lazy" referrerpolicy="no-referrer" style="display:block;width:100%;height:560px;border:0;background:#f4f4f4"></iframe></div>`;
      }
      if (preview.preview_kind === "reference") {
        return `${head}<div class="explorer-preview-body reference"><div class="explorer-reference-card"><span class="asset-attachment-icon">📎</span><div><b>${
          esc(name)
        }</b><p class="muted">文件信息 · ${
          esc(meta || "参考文件")
        }</p><p><strong>参考文件 · 仅显示文件信息</strong></p><p class="muted">当前版本不解析 DOCX 正文；浏览不会导入素材或改写原文件。</p></div></div></div>`;
      }
      if (preview.preview_kind === "directory") {
        return `${head}<div class="explorer-preview-body"><p class="muted">这是一个文件夹。展开左侧树可浏览其中的文件。</p></div>`;
      }
      return `${head}<div class="explorer-preview-body"><p class="muted">${
        esc(preview.note || "当前版本暂不支持预览此类型")
      }</p></div>`;
    };

    if (!report) {
      return `<section class="page explorer-page"><div class="page-head explorer-page-head"><div><span class="eyebrow">项目资料</span><h1>文件浏览</h1><p class="muted">先选择一个资料文件夹，再预览内容并挑选要导入的材料。</p></div><button class="primary" data-action="import-folder-again">选择资料文件夹</button></div><div class="explorer-empty-state empty-state"><div class="empty-icon" aria-hidden="true">▤</div><h2>尚未连接资料文件夹</h2><p class="muted">扫描只读访问所选文件夹。确认导入前，原始文件不会移动或改写。</p><button class="primary" data-action="import-folder-again">浏览本机文件夹</button></div></section>`;
    }

    return `<section class="page explorer-page"><div class="page-head explorer-page-head"><div><span class="eyebrow">项目资料</span><h1>文件浏览</h1><p class="muted">只读浏览本机资料；选择文件即可预览，再进入映射预览决定导入内容。</p></div><div class="page-head-actions"><button class="secondary" data-action="import-folder-again">更换资料文件夹</button><button class="primary" data-action="open-import-mapping">继续：预览导入</button></div></div><div class="explorer-source-summary"><div><small>资料位置</small><b title="${esc(rootLabel || "已扫描文件夹")}">${esc(rootLabel || "已扫描文件夹")}</b></div><span><b>${folderCount}</b> 个文件夹</span><span><b>${fileCount}</b> 个文件</span></div><div class="explorer-layout"><div class="explorer-tree-pane"><div class="explorer-list-head"><div><span class="eyebrow">资料列表</span><b>浏览文件与文件夹</b></div><label class="explorer-search"><span>筛选</span><input class="select" data-explorer-filter data-focus-key="explorer-filter" placeholder="查找文件名" value="${
      esc(filter)
    }" /></label></div><div class="explorer-columns"><span></span><span>名称</span><span>格式</span><span>识别与大小</span></div><div class="explorer-tree" role="list" aria-label="扫描到的资料">${
      tree.length
        ? tree.map((node) => renderNode(node, 0)).join("")
        : `<div class="side-empty">没有匹配「${esc(filter)}」的文件名</div>`
    }</div></div><div class="explorer-preview-pane">${previewPane()}</div></div></section>`;
  }

  /**
   * §28 — the per-document outcome of the last body import, rendered where the
   * import warnings already surface.  `null` (a shell that sends no tally, or an
   * import without documents) renders nothing, so the ordinary warning copy stays
   * the only voice instead of a panel full of invented zeros.
   */
  function documentImportResultView(esc) {
    const report = store.ui.documentImportReport;
    if (!report || typeof report !== "object") return "";
    const files = Array.isArray(report.files) ? report.files : [];
    const rows = files.map((file) =>
      `<li class="document-import-outcome ${esc(String(file?.outcome || ""))}"><b>${
        esc(file?.outcome_label || file?.outcome || "未识别")
      }</b><code title="${esc(String(file?.relative_path || ""))}">${
        esc(String(file?.relative_path || ""))
      }</code>${file?.reason ? `<small>${esc(String(file.reason))}</small>` : ""}</li>`
    ).join("");
    return `<div class="document-import-result" role="status"><div class="document-import-result-head"><b>正文导入结果</b><span class="document-import-tally">${
      esc(documentImportTallyText(report))
    }</span></div><ul>${rows || `<li class="muted">这次没有逐文件明细，请按上方数量核对正文。</li>`}</ul><p class="muted">未进入正文的文件仍留在原处；源文件没有被移动、重命名、删除或覆盖。</p></div>`;
  }

  /** §18.3 `类型` — the format name, not a MIME string. */
  function documentImportTypeLabel(relativePath) {
    return DOCUMENT_IMPORT_TYPE_LABELS[documentImportExtension(relativePath)] || "文档";
  }

  /**
   * §18.3 optional state line.  It says what *this* shell can honestly do with
   * the file: the browser build has no parser for the container formats, and the
   * desktop build reads them but flattens decoration (§21), so a PDF is a
   * 可能降级 row rather than a promise of a faithful copy.
   */
  function documentImportStateHint(relativePath) {
    const extension = documentImportExtension(relativePath);
    const native = store.bridge.isNative();
    if (".md,.markdown,.txt,.text".split(",").includes(extension)) {
      return native ? "可读取" : "可读取";
    }
    if (!native) return "需桌面应用解析";
    if (extension === ".pdf") return "可能降级 · 无文字层时保留为来源参考";
    if (extension === ".docx") return "结构可解析 · 样式会简化";
    if (extension === ".epub") return "结构可解析 · 可能降级";
    return "结构可解析 · 可能降级";
  }

  /**
   * §18 — the body-document dialog.  It opens on a plan the user has already
   * confirmed and only decides which of that plan's document rows are sent:
   * mappings, destinations and duplicate choices are forwarded as they were
   * confirmed, because this window must not grow a second Stage / Lesson
   * inference of its own (§19).  Media is absent — §17 already imported it.
   */
  function documentImportModalView(esc) {
    const dialog = store.ui.documentImportDialog;
    const items = Array.isArray(dialog?.items) ? dialog.items : [];
    if (!dialog) return "";
    const selectedCount = items.filter((item) => item?.selected === true).length;
    const loading = dialog.loading === true;
    const rowView = (item) => {
      const path = String(item?.relative_path ?? "");
      const name = explorerEntryName(path) || path;
      const selected = item?.selected === true;
      return `<div class="document-import-row ${
        selected ? "" : "deselected"
      }" data-document-import-row data-path="${esc(path)}" data-selected="${
        selected ? "true" : "false"
      }" title="${esc(path)}"><input type="checkbox" data-document-import-select data-path="${
        esc(path)
      }" ${selected ? "checked" : ""} ${loading || item?.error ? "disabled" : ""} aria-label="将 ${esc(name)} 导入为正文" /><b class="document-import-name">${
        esc(name)
      }</b><small class="document-import-meta">${esc(path)} · ${
        esc(documentImportTypeLabel(path))
      } · ${esc(formatBytes(item?.size))}</small><small class="document-import-state">${
        esc(documentImportStateHint(path))
      }</small></div>`;
    };
    const groups = (Array.isArray(dialog.groups) && dialog.groups.length
      ? dialog.groups
      : groupDocumentImportCandidates(items)).map((group) => {
      const mapping = group.mapping
        ? `已确认映射：${mappingRoleLabel(group.mapping)}`
        : "按根级文档的已确认映射计划导入";
      const target = group.mapping === "stage"
        ? "；所选文档各自成为该阶段下的课时"
        : group.mapping === "lesson"
        ? "；按该文件夹已确认的课时目标导入"
        : "";
      return `<section class="document-import-group"><h3 class="document-import-directory">${
        esc(group.directory ? `${group.directory}/` : "根目录")
      }</h3><small class="document-import-mapping">${esc(`${mapping}${target}`)}</small>${
        group.items.map(rowView).join("")
      }</section>`;
    }).join("");
    const scanErrors = Array.isArray(dialog.errors) ? dialog.errors : [];
    const scanWarnings = Array.isArray(dialog.warnings) ? dialog.warnings : [];
    const feedback = loading
      ? `<p class="document-import-feedback" role="status">正在读取已选文件夹的直接子文档…</p>`
      : scanErrors.length
      ? `<div class="document-import-feedback" role="alert"><b>文档扫描没有完成</b><p>${
        scanErrors.map((error) => esc(error?.message || error)).join("；")
      }</p><p>请重试读取，成功后再继续导入。</p><button type="button" class="secondary" data-action="document-import-retry">重试读取</button>${
        scanWarnings.length
          ? `<p>${scanWarnings.map((warning) => esc(warning?.message || warning)).join("；")}</p>`
          : ""
      }</div>`
      : scanWarnings.length
      ? `<div class="document-import-feedback" role="status"><p>${
        scanWarnings.map((warning) => esc(warning?.message || warning)).join("；")
      }</p></div>`
      : "";
    const empty = !loading && !items.length
      ? `<div class="document-import-empty">没有可选的正文文档。继续后只会导入已选媒体素材。</div>`
      : "";
    return `<div class="overlay" data-action="document-import-cancel"><div class="document-import-modal modal" role="dialog" aria-modal="true" aria-labelledby="document-import-title" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">导入正文</span><h2 id="document-import-title">选择要导入为正文的文档</h2></div><button type="button" class="icon-button" data-action="document-import-cancel" aria-label="取消正文选择" title="取消">×</button></div><p class="muted">媒体素材会按已确认映射自动进入媒体库；这里只决定哪些文档写入课文正文。${
      dialog.appending ? `导入到：${esc(store.data?.project?.title || "当前课程")}。` : ""
    }取消不会写入任何课程内容。</p><div class="document-import-tools"><button class="secondary" data-action="document-import-all" ${loading || !items.length ? "disabled" : ""}>全选</button><button class="secondary" data-action="document-import-none" ${loading || !items.length ? "disabled" : ""}>取消全选</button><span class="document-import-count" data-document-import-count>已选 ${
      selectedCount
    } / ${items.length} 项</span></div>${feedback}<div class="document-import-groups">${groups}</div>${empty}<p class="document-import-foot">未勾选的文件不会被导入，会原样留在所选文件夹里；源文件不会被移动、重命名、删除或覆盖。</p><div class="modal-actions"><button class="secondary" data-action="document-import-cancel">取消</button><button class="primary" data-action="document-import-confirm" ${loading || scanErrors.length ? "disabled" : ""}>${items.length ? "导入所选正文" : "继续导入已选内容"}</button></div></div></div>`;
  }

  function mappingRowView(relativePath) {
    const plan = store.ui.importMappingPlan;
    const path = String(relativePath || "").replaceAll("\\", "/");
    const item = (Array.isArray(plan?.items) ? plan.items : []).find((row) =>
      String(row?.relative_path || "").replaceAll("\\", "/") === path
    );
    if (!item) return "";
    const name = explorerEntryName(path) || path;
    const appending = store.ui.importMode === "append";
    const locked = store.ui.importingMapping === true || Boolean(plan?.confirmed);
    const disabled = Boolean(item.error || locked);
    const roleOptions = IMPORT_MAPPING_ROLES.map((role) =>
      `<option value="${role}" ${role === item.mapping ? "selected" : ""}>${esc(mappingRoleLabel(role))}</option>`
    ).join("");
    const existingStages = (store.data?.stages || []).filter((stage) => !stage.archived);
    const existingLessons = (store.data?.content_items || []).filter((lesson) =>
      !lesson.archived && lesson.project_id === store.data.project.id
    );
    const current = item.destination?.kind === "existing_stage"
      ? `existing_stage:${item.destination.stage_id}`
      : item.destination?.kind === "existing_lesson"
      ? `existing_lesson:${item.destination.content_item_id}`
      : "unassigned_lesson";
    const destinationOptions = [`<option value="unassigned_lesson" ${current === "unassigned_lesson" ? "selected" : ""}>新建未分组课时</option>`]
      .concat(existingStages.map((stage) => {
        const value = `existing_stage:${stage.id}`;
        return `<option value="${esc(value)}" ${current === value ? "selected" : ""}>阶段：${esc(stage.title)}</option>`;
      }), existingLessons.map((lesson) => {
        const value = `existing_lesson:${lesson.id}`;
        return `<option value="${esc(value)}" ${current === value ? "selected" : ""}>已有课：${esc(lesson.code)} ${esc(lesson.title)}</option>`;
      })).join("");
    const destination = item.mapping === "lesson" && appending
      ? `<select class="select mapping-destination" data-mapping-destination data-path="${esc(path)}" aria-label="${esc(name)} 的导入目标" ${disabled || !item.selected ? "disabled" : ""}>${destinationOptions}</select>`
      : "";
    return `<tr class="mapping-row ${item.selected ? "" : "deselected"}${item.error ? " degraded" : ""}" data-mapping-row data-row-key="${esc(path)}" data-path="${esc(path)}" data-selected="${item.selected ? "true" : "false"}"><td class="mapping-select-cell"><input type="checkbox" data-mapping-select data-path="${esc(path)}" aria-label="导入 ${esc(name)}" ${item.selected ? "checked" : ""} ${disabled ? "disabled" : ""} /></td><td class="mapping-object" title="${esc(path)}"><span class="mapping-object-kind" aria-hidden="true">${item.kind === "directory" ? "▰" : "▤"}</span><span class="mapping-object-name">${esc(name)}</span><small>${esc(path)}</small>${item.error ? `<small class="mapping-row-error">${esc(item.error)}</small>` : ""}</td><td class="mapping-target"><select class="select mapping-role" data-mapping-role data-path="${esc(path)}" aria-label="${esc(name)} 的映射目标" ${disabled ? "disabled" : ""}>${roleOptions}</select><span data-mapping-destination-slot>${destination}</span></td></tr>`;
  }
  function mappingView() {
    const plan = store.ui.importMappingPlan;
    const report = store.ui.folderScan;
    const appending = store.ui.importMode === "append";
    const rootLabel = store.ui.importFolderRoot || plan?.root || report?.root || "";
    if (!report && !plan) return `<section class="page mapping-page"><div class="page-head"><div><span class="eyebrow">导入映射</span><h1>映射预览</h1><p class="muted">选择根目录中的对象并确认导入目标。</p></div><button class="primary" data-action="${appending ? "append-folder" : "import-folder-again"}">${appending ? "选择文件夹" : "导入已有文件夹"}</button></div><div class="empty-state mapping-empty"><h2>还没有扫描快照</h2><p class="muted">请先选择文件夹并完成一次只读扫描。</p></div></section>`;
    const items = Array.isArray(plan?.items) ? plan.items : [];
    const selectedCount = items.filter((item) => item.selected).length;
    const importing = store.ui.importingMapping === true;
    const committed = Boolean(plan?.confirmed && !importing);
    const needsReopen = Boolean(store.ui.pendingAdoptedProjectRoot);
    const rows = items.map((item) => mappingRowView(item.relative_path)).join("");
    const target = appending ? `追加到 ${esc(store.data?.project?.title || "当前课程")}` : "导入到新课程";
    const status = importing ? "正在处理已选对象；原文件不会移动或删除。"
      : needsReopen ? "课程项目已经创建，正在等待重新打开。"
      : committed ? "资料已经写入。为避免重复导入，请返回课程地图核对。"
      : "选择要导入的根级对象，并确认映射目标。";
    const error = String(store.ui.importMappingError || "").trim();
    const actions = importing
      ? `<button class="secondary" data-action="route" data-route="explorer" disabled>返回资源浏览器</button><button class="primary" disabled>正在导入…</button>`
      : needsReopen
      ? `<button class="secondary" data-action="route" data-route="explorer">返回资源浏览器</button><button class="primary" data-action="retry-open-adopted-project">重新打开已创建的课程</button>`
      : committed
      ? `<button class="secondary" data-action="route" data-route="map">返回课程地图</button><button class="primary" disabled>已写入 · 不可重复导入</button>`
      : `<button class="secondary" data-action="route" data-route="explorer">返回资源浏览器</button><button class="primary" data-action="confirm-import-mapping">${appending ? "确认并追加到当前课程" : "确认导入计划并打开"}</button>`;
    return `<section class="page mapping-page"><div class="page-head"><div><span class="eyebrow">导入映射</span><h1>映射预览</h1><p class="muted">仅显示所选文件夹的根目录一级 · ${esc(rootLabel || "已扫描文件夹")}</p></div><div class="page-head-actions">${actions}</div></div><div class="mapping-status" data-mapping-status-container><p>${target} · <span class="mapping-selection-count" data-mapping-selection-count>已选 ${selectedCount} / ${items.length} 项</span></p><small>${status}</small>${error ? `<div class="mapping-error" role="alert"><b>导入状态</b><p>${esc(error)}</p></div>` : ""}</div><div class="mapping-table-wrap"><table class="mapping-table"><thead><tr><th>加入</th><th>根目录对象</th><th>映射目标</th></tr></thead><tbody>${rows || `<tr class="mapping-empty"><td colspan="3" class="side-empty">根目录没有可映射对象</td></tr>`}</tbody></table></div></section>`;
  }
  function mediaView() {
    const assets = store.data.assets.filter((asset) => !asset.archived);
    const usedCount = assets.filter((asset) => usagesForAsset(store.data, asset.id).length).length;
    return `<section class="page media-page"><div class="page-head media-page-head"><div><span class="eyebrow">项目资料 · ${usedCount} 个已引用</span><h1>媒体库 <sup>${
      assets.length
    }</sup></h1><p class="muted">预览素材、查看引用位置；选中一课后可直接插入，插入会建立真实引用。</p></div><button class="primary" data-action="open-file">＋ 添加素材</button></div>${PROJECT_FILE_PICKER}<div class="media-library-tools"><div class="drop-zone" data-drop-zone="assets"><span class="drop-icon" aria-hidden="true">⇧</span><div><b>添加项目素材</b><small>拖入文件，或用上方按钮选择图片、GIF、视频、音频、Markdown 与附件。</small></div></div><div class="media-library-note"><span class="eyebrow">素材状态</span><p class="small muted">未引用素材仍保留在媒体库；删除会从课程项目中移除这项素材。</p></div></div><div class="asset-grid">${
      assets.length
        ? assets.map((asset) => {
          const usages = usagesForAsset(store.data, asset.id);
          const lessons = [...new Set(usages.map((usage) =>
            usage.content_item_id
          ))].map((id) =>
            store.data.content_items.find((item) => item.id === id)
          ).filter(Boolean);
          const displayName = asset.title || asset.filename;
          const usageLabel = usages.length
            ? `已使用 ${usages.length} 处`
            : "尚未引用";
          const usageTitle = usages.length
            ? ` title="使用位置：${esc(lessons.map((item) => item.code).join("、"))}"`
            : "";
          return `<article class="asset-card media-tile" data-asset-id="${
            asset.id
          }"><div class="asset-card-media">${
            previewFrame(asset, "card", mediaLibraryPreview(asset))
          }</div><div class="asset-card-body"><b class="asset-card-name" title="${esc(displayName)}">${
            esc(displayName)
          }</b><div class="asset-card-meta"><span class="asset-type-label">${esc(assetLabel(asset.type))}</span><small>${formatBytes(asset.file_size)}</small><span class="asset-usage-label"${usageTitle}>${usageLabel}</span></div></div><div class="asset-card-actions">${
            store.ui.activeId
              ? `<button class="secondary asset-insert-action" data-action="insert-asset" data-id="${asset.id}" aria-label="插入素材：${esc(displayName)}" title="插入到当前位置">插入</button>`
              : ""
          }<details class="asset-card-menu"><summary class="icon-button" data-focus-key="asset-menu-${esc(asset.id)}" aria-label="更多素材操作：${esc(displayName)}" title="更多素材操作">⋯</summary><div class="asset-card-menu-list"><button type="button" data-action="rename-asset" data-id="${esc(asset.id)}" aria-label="重命名素材文件并同步更新磁盘文件名：${esc(displayName)}" title="重命名素材文件（磁盘文件同步改名）">重命名</button><button type="button" class="danger" data-action="delete-asset" data-id="${esc(asset.id)}" aria-label="删除素材：${esc(displayName)}">${TRASH_ICON} 删除</button></div></details></div></article>`;
        }).join("")
        : `<div class="empty-state inline media-empty"><div class="empty-icon" aria-hidden="true">▧</div><h2>媒体库暂时为空</h2><p class="muted">添加后的素材会在这里生成静态缩略图与使用状态。GIF 和视频在明确打开后才播放。</p><button class="primary" data-action="open-file">添加第一项素材</button></div>`
    }</div></section>`;
  }

  function versionsView() {
    const snapshots = Array.isArray(store.snapshotRows) ? store.snapshotRows : [];
    const available = snapshots.filter((snapshot) => snapshot.status === "available");
    const savedAt = (value) => {
      const time = Date.parse(String(value || ""));
      return Number.isFinite(time) ? new Date(time).toLocaleString("zh-CN") : "保存时间未知";
    };
    return `<section class="page versions-page"><div class="page-head"><div><span class="eyebrow">安全恢复</span><h1>版本历史</h1><p class="muted">版本记录保存课程正文、排版与引用关系，不复制素材文件；恢复不会找回已删除或改写的素材，也不会还原素材文件名。</p></div><div class="page-head-actions"><button class="primary" data-action="save-version">保存当前版本</button><button class="secondary" data-action="refresh-snapshots" ${store.snapshotLoading ? "disabled" : ""}>刷新</button></div></div><div class="summary-grid versions-summary" aria-label="版本概况"><article class="summary-card"><span>已保存版本</span><strong>${available.length}</strong><small>可随时恢复</small></article><article class="summary-card"><span>自动保存</span><strong>开启</strong><small>编辑内容持续保存</small></article><article class="summary-card"><span>恢复保护</span><strong>启用</strong><small>恢复前备份会先持久保存</small></article></div>${store.snapshotLoadError ? `<p class="error-text" role="alert">${esc(store.snapshotLoadError)}</p>` : ""}${store.snapshotLoading ? `<p class="muted" role="status">正在读取已保存版本…</p>` : ""}<section class="page-section versions-section"><div class="versions-section-head"><div><h2>命名版本</h2><p class="muted">为发布、审核或大幅修改前保存一个清楚的回退点。</p></div><span class="status-pill">${available.length}</span></div>${
      snapshots.length
        ? `<div class="version-list" role="list">${snapshots.map((snapshot) =>
          `<article class="version-card list-row surface-card ${snapshot.status === "error" ? "degraded" : ""}" role="listitem"><span class="version-icon" aria-hidden="true">◷</span><div class="version-main"><div class="version-row-title"><h3>${
            esc(snapshot.name || "未命名版本")
          }</h3><span class="status-pill ${snapshot.status === "error" ? "is-warning" : "is-done"}">${snapshot.status === "error" ? "无法读取" : "已保存"}</span></div><p>${esc(snapshot.error || snapshot.note || "没有备注")}</p><small>${
            savedAt(snapshot.created_at)
          }</small></div><div class="action-row"><button class="secondary" data-action="restore-version" data-id="${
            esc(snapshot.id || "")
          }" ${snapshot.status !== "available" || !snapshot.id || store.snapshotRestoringId ? "disabled" : ""}>${store.snapshotRestoringId === snapshot.id ? "正在恢复…" : "恢复此版本"}</button></div></article>`
        ).join("")}</div>`
        : `<div class="empty-state versions-empty"><span class="empty-icon" aria-hidden="true">◷</span><h2>${store.snapshotLoading ? "正在读取版本" : "还没有命名版本"}</h2><p class="muted">保存确认成功的版本才会显示在这里。</p><button class="primary" data-action="save-version">保存第一个版本</button></div>`
    }</section></section>`;
  }

  function publishView() {
    const item = store.currentItem();
    const courseScope = store.ui.publishScope === "course";
    const publications = (store.data.publications || []).filter((publication) =>
      courseScope || publication.content_item_id === (item && item.id)
    );
    const view = item ? store.lesson(item) : null;
    const layout = !courseScope && item ? store.layout(item) : null;
    const adapters = getAvailablePublicationAdapters({
      native: store.bridge.isNative(),
      service: !store.bridge.isNative(),
    });
    const formats = [
      ["markdown", "Markdown", "可编辑文本与稳定相对素材引用"],
      ["html", "Semantic HTML", "无需 Workbench 即可独立阅读"],
      ["web", "Static Web Package", "index.html + 实际使用的素材"],
      ["pdf", "PDF", "交付、阅读与留档"],
      ["pptx", "PowerPoint", "按页面尺寸生成演示文稿"],
      ["wechat", "微信 / 富文本", "保守样式与媒体迁移提示"],
      ["json", "Project JSON", "去除私有会话的结构化备份"],
      ["asset_package", "素材包", "素材文件与 manifest"],
      ["full_project", "完整项目包", "可恢复课程数据、正文与素材"],
    ];
    const projection = (() => {
      try { return store.publicationProjection(); } catch { return null; }
    })();
    const targetSize = store.ui.publishTargetPageSize;
    const adapter = adapters[store.ui.publishFormat];
    const supportsLayout = adapter?.layout === true;
    const canChooseTargetSize = supportsLayout ||
      ["html", "web", "pdf", "pptx"].some((format) =>
        adapters[format]?.available && adapters[format]?.layout
      );
    const showLayoutControls = courseScope || layout?.mode === "grid";
    const selectedCapability = projection
      ? store.publicationCapability(store.ui.publishFormat, projection)
      : { status: "unavailable", code: null };
    const requiresTargetSize = projection && ["pdf", "pptx"].some((format) =>
      store.publicationCapability(format, projection).code === "explicit_target_page_size_required"
    );
    const targetSizeNotice = requiresTargetSize
      ? `<p class="publish-size-warning" role="status">全课程页面尺寸不同。PDF 和 PowerPoint 需要统一目标尺寸；请选择输出尺寸后查看逐页适配预览。</p>`
      : "";
    const originalSizeLabel = requiresTargetSize
      ? "页面尺寸不同，需选择统一尺寸"
      : "各课保持原尺寸";
    const fitPages = targetSize && projection
      ? projection.lessons.flatMap((lesson) => (lesson.layout?.pages || []).map((page) => {
        const fit = fitPageRect(
          page.logical_width_pt,
          page.logical_height_pt,
          targetSize.width_pt,
          targetSize.height_pt,
        );
        return { lesson, page, fit };
      }))
      : [];
    const pageRange = layout?.pagination_mode === "paged" && view && supportsLayout
      ? `<div class="publish-layout-controls"><b>页面范围</b><div class="publish-page-options">${[
        ["all", "全部页面"], ["current", "当前页"], ["selected", "选定页面"],
      ].map(([mode, label]) => `<button class="secondary ${store.ui.publishPageMode === mode ? "active-tool" : ""}" data-action="publish-page-mode" data-mode="${mode}" aria-pressed="${store.ui.publishPageMode === mode}">${label}</button>`).join("")}</div>${store.ui.publishPageMode === "selected" ? `<div class="publish-page-options">${view.pages.map((page, index) => `<label><input type="checkbox" data-action="publish-page-toggle" data-id="${page.id}" ${store.ui.publishSelectedPageIds.includes(page.id) ? "checked" : ""}/>第 ${index + 1} 页 · ${esc(page.title)}</label>`).join("")}</div>` : ""}<small class="muted">导出页序遵循排版页面顺序；不改变课程内容。</small></div>`
      : "";
    const targetSizeControl = canChooseTargetSize
      ? `<label class="page-size-control">输出页面尺寸<select class="select" data-action="publish-target-size"><option value="original" ${!targetSize ? "selected" : ""}>${originalSizeLabel}</option>${[["16:9", "16:9 横向"], ["a4-portrait", "A4 纵向"], ["a4-landscape", "A4 横向"], ["custom", "自定义尺寸"]].map(([preset, label]) => `<option value="${preset}" ${targetSize?.preset === preset ? "selected" : ""}>${label}</option>`).join("")}</select></label>${targetSize?.preset === "custom" ? `<div class="publish-page-options"><label>宽度 (pt)<input class="select" type="number" min="1" max="100000" step="1" data-action="publish-target-size-value" data-axis="width_pt" value="${targetSize.width_pt}"/></label><label>高度 (pt)<input class="select" type="number" min="1" max="100000" step="1" data-action="publish-target-size-value" data-axis="height_pt" value="${targetSize.height_pt}"/></label></div>` : ""}`
      : `<span class="muted small">当前格式不保留页面尺寸或位置。</span>`;
    const fitPreview = canChooseTargetSize && targetSize && fitPages.length
      ? `<div class="publish-fit-preview"><b>等比适配预览</b><div class="publish-fit-pages">${fitPages.slice(0, 8).map(({ lesson, page, fit }) => `<div class="publish-fit-page-card"><div class="fit-target-page" style="aspect-ratio:${targetSize.width_pt}/${targetSize.height_pt}"><div class="fit-source-page" style="left:${fit.x_pt / targetSize.width_pt * 100}%;top:${fit.y_pt / targetSize.height_pt * 100}%;width:${fit.width_pt / targetSize.width_pt * 100}%;height:${fit.height_pt / targetSize.height_pt * 100}%"></div></div><small>${esc(lesson.code)} · ${esc(page.title || `第 ${page.order + 1} 页`)} · ${fit.scale.toFixed(3)}×</small></div>`).join("")}</div><span>整页等比缩放并居中，不裁切；目标尺寸只用于本次输出。${fitPages.length > 8 ? `显示前 8 页，共 ${fitPages.length} 页。` : ""}</span></div>`
      : canChooseTargetSize && targetSize
      ? `<div class="publish-fit-preview">所选范围没有已排版页面可供尺寸适配预览。</div>`
      : canChooseTargetSize && projection?.lessons.some((lesson) => lesson.layout?.pages?.length > 1)
      ? `<div class="publish-fit-preview">不同课程可保留各自页面尺寸；选择统一目标尺寸后会显示等比缩放与居中预览，不会裁切。</div>`
      : "";
    const last = store.ui.lastExport;
    const selectedFormat = formats.find(([key]) => key === store.ui.publishFormat);
    const selectedFormatLabel = selectedFormat?.[1] || "未选择格式";
    const selectedCapabilityLabel = selectedCapability.status === "available"
      ? adapters[store.ui.publishFormat]?.layout ? "页面布局保留" : "格式可用"
      : selectedCapability.status === "lossy"
      ? "输出会降级"
      : selectedCapability.code === "explicit_target_page_size_required"
      ? "需要统一页面尺寸"
      : selectedCapability.status === "unsupported"
      ? "当前排版不支持"
      : "此环境暂不可用";
    const selectedCapabilityClass = selectedCapability.status === "available"
      ? "is-done"
      : selectedCapability.status === "lossy" || selectedCapability.code === "explicit_target_page_size_required"
      ? "is-warning"
      : "is-error";
    const projectionFeedback = !projection
      ? `<div class="publish-feedback is-error" role="alert"><b>无法生成发布预览</b><p>请先打开课程项目并检查内容，再运行导出前检查获取具体原因。</p></div>`
      : selectedCapability.status === "lossy"
      ? `<div class="publish-feedback is-warning" role="status"><b>${esc(selectedFormatLabel)} 会调整页面布局</b><p>预检会列出降级项目；确认后再继续导出。</p></div>`
      : "";
    const courseCount = store.data.content_items.filter((candidate) => !candidate.archived).length;
    return `<section class="page publish-page"><div class="page-head"><div><span class="eyebrow">交付课程内容</span><h1>发布中心</h1><p class="muted">确认输出范围、页面适配和格式兼容性，再检查并导出课程内容。</p></div><div class="page-head-actions">${store.ui.publishReturnContext ? `<button class="secondary" data-action="return-publish-source">返回来源页面</button>` : ""}<button class="primary" data-action="preflight">运行导出前检查</button></div></div>
      <div class="publish-status-strip page-toolbar" aria-label="当前发布设置"><span><small>输出范围</small><b>${courseScope ? `整门课程 · ${courseCount} 课` : item ? `当前课 · ${esc(item.code)}` : "当前课 · 尚未选择"}</b></span><span><small>输出格式</small><b>${esc(selectedFormatLabel)}</b></span><span><small>兼容性</small><b class="status-pill ${selectedCapabilityClass}">${esc(selectedCapabilityLabel)}</b></span></div>
      ${!courseScope && !item ? `<div class="publish-context-empty" role="status"><div><b>当前没有选中的课时</b><p class="muted">可以先选择整门课程，或打开课程地图选择一课。</p></div><button class="secondary" data-action="route" data-route="map">打开课程地图</button></div>` : ""}
      ${projectionFeedback}
      <section class="page-section card publish-card publish-section" aria-labelledby="publish-scope-heading"><div class="publish-section-heading"><span class="publish-step">01</span><div><h2 id="publish-scope-heading">1. 选择输出范围</h2><p class="muted">决定导出当前课，还是整门课程。</p></div></div><div class="segmented" role="group" aria-label="选择发布范围"><button class="${courseScope ? "" : "active"}" data-action="publish-scope" data-scope="lesson" aria-pressed="${!courseScope}">当前课${item ? ` · ${esc(item.code)}` : ""}</button><button class="${courseScope ? "active" : ""}" data-action="publish-scope" data-scope="course" aria-pressed="${courseScope}">整门课程</button></div><p class="publish-scope-detail">${courseScope ? `整门课程 · ${courseCount} 课` : view ? `${esc(item.title)} · 完成 ${view.progress.percentage}% · 待补 ${view.progress.open_requirements} 项` : "尚未选择课程"}</p></section>
      ${showLayoutControls ? `<section class="page-section card publish-card publish-section" aria-labelledby="publish-layout-heading"><div class="publish-section-heading"><span class="publish-step">02</span><div><h2 id="publish-layout-heading">2. 输出布局与页面</h2><p class="muted">页码范围与目标尺寸只影响本次输出。</p></div></div><div class="publish-layout-controls">${pageRange}${layout?.pagination_mode === "paged" && !supportsLayout ? `<p class="muted publish-format-note">当前格式不会保留页面布局，因此无法按页筛选。</p>` : ""}<div class="page-action-row">${targetSizeControl}</div>${targetSizeNotice}${fitPreview}</div><p class="publish-layout-note">页面筛选与目标尺寸仅影响本次导出；尺寸不同的课时会按同一比例居中适配，不裁掉页面内容。</p></section>` : ""}
      <section class="page-section card publish-card publish-section" aria-labelledby="publish-format-heading"><div class="publish-section-heading"><span class="publish-step">03</span><div><h2 id="publish-format-heading">3. 选择格式</h2><p class="muted">每种格式都会说明可用性和布局处理方式。</p></div></div><div class="format-grid">${formats.map(([key, label, detail]) => { let capability = { status: "unavailable" }; try { capability = store.publicationCapability(key); } catch { /* selection validation is shown in preflight */ } const unavailable = ["unavailable", "unsupported"].includes(capability.status); const capabilityLabel = capability.code === "explicit_target_page_size_required" ? "请先选择统一尺寸" : capability.status === "available" ? (adapters[key]?.layout ? "页面布局保留" : "可用") : capability.status === "lossy" ? "页面布局会线性化" : capability.status === "unsupported" ? "当前排版不支持" : "此环境不可用"; return `<button class="format-card ${store.ui.publishFormat === key ? "active" : ""}" data-action="publish-format" data-format="${key}" aria-pressed="${store.ui.publishFormat === key}" ${unavailable ? "disabled" : ""}><b>${label}</b><small>${detail}</small><small class="format-capability">${capabilityLabel}</small></button>`; }).join("")}</div><div class="action-row publish-preflight-action"><button class="secondary" data-action="preflight">运行导出前检查</button></div></section>
      ${store.ui.preflight ? publishPreflightView() : ""}
      ${last ? `<section class="page-section card publish-card publish-last-export"><div class="publish-section-heading"><span class="publish-step" aria-hidden="true">✓</span><div><h2>最近一次导出</h2><p class="muted">${store.bridge.isNative() ? "导出已经完成，以下是实际保存位置。" : "文件已交给浏览器下载；完成情况请查看浏览器下载列表。"}</p></div><span class="status-pill is-done">${store.bridge.isNative() ? "已完成" : "已交给浏览器"}</span></div><p><b>${esc(last.format)}</b> · ${last.scope === "course" ? "整门课程" : "当前课"} · ${last.files} 个文件</p><p class="muted">${store.bridge.isNative() ? "实际位置" : "交付方式"}：<code>${esc(last.path)}</code></p>${store.bridge.isNative() ? `<p class="muted">输出不依赖 Workbench 运行。</p><div class="action-row"><button class="secondary" data-action="reveal-export">在 Finder 中显示</button></div>` : ""}</section>` : ""}
      <section class="page-section card publish-card publish-history" aria-labelledby="publish-history-heading"><div class="publish-section-heading"><div><h2 id="publish-history-heading">发布记录</h2><p class="muted">只记录你确认过的发布节点，不会改变课程内容。</p></div><button class="secondary" data-action="record-publication">记录已发布</button></div>${publications.length ? `<div class="version-list" role="list">${publications.map((publication) => `<article class="version-card list-row" role="listitem"><span class="version-icon" aria-hidden="true">↗</span><div><b>${esc(publication.version_label)}</b><p>${esc(publication.platform)} · ${esc(publication.status)}</p><small>${esc(publication.published_at || "")}</small></div></article>`).join("")}</div>` : `<div class="empty-state publish-history-empty"><h3>还没有发布记录</h3><p class="muted">导出并实际迁移后，可以记录这个发布节点；课程内容不会因此改变。</p></div>`}</section></section>`;
  }

  function publishPreflightView() {
    const report = store.ui.preflightReport || store.exportPreflight();
    const issues = Array.isArray(report.issues) ? report.issues : [];
    const warningIssues = issues.filter((issue) => issue.severity === "warning" && issue.code);
    const requiredCodes = new Set(warningIssues.map((issue) => issue.code));
    const acknowledged = new Set(store.ui.acknowledgedWarnings || []);
    const allWarningsAcknowledged = [...requiredCodes].every((code) => acknowledged.has(code)) &&
      !(report.warnings > 0 && !requiredCodes.size);
    const selection = store.publicationOptions();
    const frozen = store.ui.preflightOptions;
    const sameSelection = frozen && ["content_item_id", "layout_instance_id", "page_ids", "target_page_size"].every((key) =>
      JSON.stringify(frozen[key] ?? null) === JSON.stringify(selection[key] ?? null)
    );
    const current = Boolean(
      sameSelection &&
      store.ui.preflightRevision === store.data.project.updated_at &&
      store.ui.preflightFormat === store.ui.publishFormat
    );
    return `<div class="card publish-card publish-preflight" aria-live="polite"><h2>4. 导出前检查</h2><p class="muted">先检查课程内容与素材。必须修复的问题会阻止导出；逐项确认提示后才会生成文件。此检查不会修改课程，也不会调用 AI。</p>${store.ui.preflightPending ? `<p class="preflight-pending" role="status">正在检查当前课程快照…</p>` : ""}<div class="check-list">${[
      ["内容级待补", report.content, false],
      ["当前排版待补", report.layout, false],
      ["缺失素材文件", report.missingAssets, true],
      ["超出画布", report.overflow, true],
      ["空正文 / 文字提醒", report.text, false],
      ["未加载字体", report.fonts, false],
      ["外部引用", report.external, false],
      ["媒体降级", report.mediaDowngrades || 0, false],
    ].map(([label, count, blocking]) => `<div><span class="check ${count ? blocking ? "danger" : "warning" : "ok"}">${count || "✓"}</span><span>${label}</span><b>${count}</b></div>`).join("")}</div>${issues.length ? `<div class="issue-list">${issues.map((issue) => `<article class="${issue.severity === "blocking" ? "issue-blocking" : "issue-warning"}"><b>${issue.severity === "blocking" ? "必须修复" : "提示"}</b><span>${esc(issueMessage(issue))}</span>${issueDiagnostics(issue)}</article>`).join("")}</div>` : ""}${warningIssues.length ? `<div class="warning-ack-list"><b>逐项确认本次输出提示</b>${warningIssues.map((issue) => `<label><input type="checkbox" data-action="acknowledge-export-warning" data-code="${esc(issue.code)}" ${acknowledged.has(issue.code) ? "checked" : ""}/><span>${esc(issueMessage(issue))}${issue.count > 1 ? `（${issue.count} 项）` : ""}</span></label>`).join("")}</div>` : ""}<div class="preflight-total">必须修复 <strong>${report.blocking}</strong> · 提示 <strong>${report.warnings}</strong></div>${!current && !store.ui.preflightPending ? `<p class="warning-text">课程或输出范围在检查后发生变化，请重新运行检查后再导出。</p>` : ""}${report.blocking ? `<p class="error-text">当前不能导出：请先修复上面标为“必须修复”的问题。不会生成半成品，也不会修改源课程。</p>` : report.warnings ? `<p class="muted">未放置正文、线性化或媒体降级会按上方说明处理；确认提示后才会继续生成。</p>` : `<p class="success-text">检查通过，可以生成输出；源课程不会被修改。</p>`}<div class="modal-actions"><button class="secondary" data-action="preflight" ${store.ui.preflightPending ? "disabled" : ""}>重新运行检查</button><button class="primary" data-action="export-format" data-format="${esc(store.ui.publishFormat)}" ${!current || store.ui.preflightPending || report.blocking || !allWarningsAcknowledged ? "disabled" : ""}>${report.warnings ? "确认提示并导出" : "开始导出"}</button></div></div>`;
  }

  function simplePage(title, description, icon) {
    const item = store.currentItem();
    return `<section class="page simple-page"><div class="simple-icon">${icon}</div><span class="eyebrow">项目工作台</span><h1>${title}</h1><p class="muted">${description}</p>${
      item
        ? `<button class="primary" data-action="open-item" data-id="${item.id}">继续编辑 ${
          esc(item.code)
        } →</button>`
        : `<button class="primary" data-action="route" data-route="map">打开课程地图</button>`
    }</section>`;
  }

  function updatesView() {
    const drafts = (store.data.change_drafts || []).filter((draft) =>
      draft.status === "draft" || draft.status === "reviewing"
    );
    const suggestions = (store.data.suggestions || []).filter((suggestion) =>
      suggestion.status === "pending"
    );
    return `<section class="page updates-page"><div class="page-head"><div><span class="eyebrow">建议与修订</span><h1>更新中心</h1><p class="muted">AI 建议先保存为可审核内容。只有你确认应用后，正文才会发生变化。</p></div><button class="primary" data-action="right-panel" data-panel="assistant">打开 AI 助手</button></div><div class="update-summary-grid"><article class="update-summary"><span class="eyebrow">待审核修改</span><strong>${drafts.length}</strong><p>修改前后对照会显示在 AI 助手中。</p></article><article class="update-summary"><span class="eyebrow">待处理建议</span><strong>${suggestions.length}</strong><p>建议可以继续保留，正文不会自动变化。</p></article></div><section class="update-guidance"><span class="update-step">01</span><div><h2>先检查，再决定</h2><p class="muted">打开工作台的 AI 助手查看生成记录、修改对照和校验结果。应用前可逐项审核；应用后仍可撤销。</p></div><button class="secondary" data-action="open-workbench">进入工作台</button></section></section>`;
  }

  function settingsView() {
    const project = store.data.project;
    const providers = Array.isArray(store.ui.aiProviders) ? store.ui.aiProviders : [];
    const configured = aiConfiguredMap();
    const selected = providers.find((provider) => provider.id === store.ui.aiProviderId);
    const selectedModel = store.ui.aiModel || selected?.default_model || "未选择";
    const modelRows = providers.flatMap((provider) => {
      const models = Array.isArray(provider.models) ? provider.models : [];
      return models.map((model) => ({
        provider: provider.label || provider.id,
        id: typeof model === "string" ? model : model?.id || model?.name || "",
        connected: configured[provider.id] === true,
      })).filter((model) => model.id);
    });
    const modelList = modelRows.length
      ? `<ul class="settings-model-list">${modelRows.slice(0, 8).map((model) => `<li><span>${esc(model.id)}</span><small>${esc(model.provider)} · ${model.connected ? "已连接" : "未连接"}</small></li>`).join("")}</ul>`
      : `<p class="muted">尚未读取模型列表。连接服务商后可以在 AI 设置中发现并选择模型。</p>`;
    return `<section class="page settings-page"><div class="page-head"><div><span class="eyebrow">项目偏好与账户</span><h1>项目设置</h1><p class="muted">在一个页面查看常用配置；密钥仍由现有连接管理器安全保存。</p></div><button class="secondary" data-action="select-project-properties">项目属性</button></div><nav class="settings-nav" aria-label="设置分类"><a href="#settings-general">常规</a><a href="#settings-ai">AI 连接</a><a href="#settings-models">模型</a><a href="#settings-accounts">账户</a><a href="#settings-project">项目</a></nav><section class="settings-section" id="settings-general"><div class="settings-section-head"><span class="settings-index">01</span><div><h2>常规</h2><p class="muted">保存行为与当前工作环境</p></div></div><div class="settings-cards"><article class="settings-card"><span class="eyebrow">保存方式</span><b>本地优先 · 自动保存</b><p class="muted">课程数据保存在当前项目中。顶部保存状态会显示写入结果。</p></article><article class="settings-card"><span class="eyebrow">当前界面</span><b>${store.bridge.isNative() ? "桌面应用" : "浏览器服务壳"}</b><p class="muted">应用布局会适配窗口宽度和系统缩放。</p></article></div></section><section class="settings-section" id="settings-ai"><div class="settings-section-head"><span class="settings-index">02</span><div><h2>AI 连接</h2><p class="muted">管理服务商、连接状态和凭据</p></div></div><article class="settings-card settings-ai-card"><div><span class="eyebrow">当前选择</span><b>${esc(selected?.label || selected?.id || "尚未选择服务商")}</b><p class="muted">模型：${esc(selectedModel)} · ${selected && configured[selected.id] ? "凭据已保存在本机" : "连接尚未配置"}</p></div><div class="settings-card-actions"><button class="secondary" data-focus-key="settings-ai-connections" data-action="ai-toggle-settings" aria-haspopup="dialog">管理连接</button><button class="text-button" data-action="right-panel" data-panel="assistant">打开 AI 助手</button></div></article></section><section class="settings-section" id="settings-models"><div class="settings-section-head"><span class="settings-index">03</span><div><h2>模型</h2><p class="muted">当前连接提供的可用模型</p></div><button class="secondary" data-focus-key="settings-ai-models" data-action="ai-toggle-settings" aria-haspopup="dialog">发现或选择模型</button></div><article class="settings-card">${modelList}</article></section><section class="settings-section" id="settings-accounts"><div class="settings-section-head"><span class="settings-index">04</span><div><h2>账户</h2><p class="muted">订阅授权与 API Key 彼此独立</p></div></div><article class="settings-card settings-account-card">${aiSubscriptionSettingsView(store, configured)}</article><p class="settings-security-note">Access Token 与 Refresh Token 只保存在本机系统钥匙串；API Key 仅通过已配置的连接管理器保存，页面不会显示密钥。</p></section><section class="settings-section" id="settings-project"><div class="settings-section-head"><span class="settings-index">05</span><div><h2>项目</h2><p class="muted">当前课程项目的本地身份</p></div></div><article class="settings-card settings-project-card"><dl><dt>项目名称</dt><dd>${esc(project.title)}</dd><dt>项目编号</dt><dd><code>${esc(project.id)}</code></dd><dt>数据格式</dt><dd>${esc(String(project.schema_version))}</dd><dt>课程语言</dt><dd>${esc(project.language || "未设置")}</dd></dl><button class="secondary" data-action="route" data-route="map">在课程地图编辑项目名称</button></article></section></section>`;
  }

  function emptyState(title, description, action, label) {
    const attributes = action === "capture"
      ? 'data-action="capture"'
      : action === "map"
      ? 'data-action="route" data-route="map"'
      : action === "writing"
      ? 'data-action="mode" data-mode="writing"'
      : 'data-action="add-block"';
    return `<div class="empty-state"><div class="empty-icon">✦</div><h2>${title}</h2><p class="muted">${description}</p><button class="primary" ${attributes}>${label}</button></div>`;
  }

  /* --------------------------------------------------------- right rail */

  function propertyTargetInfo() {
    const target = store.ui.propertyTarget;
    if (target?.kind === "project") {
      return { kind: "project", project: store.data.project };
    }
    if (target?.kind === "stage") {
      const stage = store.data.stages.find((candidate) =>
        candidate.id === target.id && !candidate.archived
      );
      if (stage) return { kind: "stage", stage };
    }
    const item = store.ui.activeId
      ? store.data.content_items.find((candidate) =>
        candidate.id === store.ui.activeId && !candidate.archived
      ) || null
      : null;
    return item
      ? { kind: "lesson", item }
      : { kind: "project", project: store.data.project };
  }

  function rightPanelView() {
    const item = store.currentItem();
    const view = item ? lessonView(store.data, item.id) : null;
    const target = propertyTargetInfo();
    const selectedBlock = view && store.ui.selectedBlockId
      ? view.blocks.find((block) => block.id === store.ui.selectedBlockId)
      : null;
    const scope = store.ui.rightPanel === "properties"
      ? selectedBlock
        ? `区块 · ${selectedBlock.label}`
        : target.kind === "stage"
        ? `阶段 · ${target.stage.code} ${target.stage.title}`
        : target.kind === "project"
        ? `项目 · ${target.project.title}`
        : `课时 · ${target.item.code} ${target.item.title}`
      : item
      ? `${item.code}｜${item.title}`
      : "未选择课程";
    return `<aside class="right-panel panel"><div class="right-tabs">${
      RIGHT_PANELS.map(([key, label]) =>
        `<button class="right-tab ${
          store.ui.rightPanel === key ? "active" : ""
        }" data-action="right-panel" data-panel="${key}">${label}${
          key === "requirements" && view && view.progress.open_requirements
            ? `<sup>${view.progress.open_requirements}</sup>`
            : ""
        }</button>`
      ).join("")
    }<button class="icon-button collapse-right" data-action="toggle-right" aria-label="${store.ui.rightCollapsed ? "展开右栏" : "收起右栏"}" title="${store.ui.rightCollapsed ? "展开右栏" : "收起右栏"}">${store.ui.rightCollapsed ? "☰" : "›"}</button></div><div class="right-content" data-panel-scope="${
      esc(scope)
    }"><div class="scope-banner">作用对象：<b>${esc(scope)}</b></div>${
      store.ui.rightPanel === "media"
        ? mediaPanel(view)
        : store.ui.rightPanel === "requirements"
        ? requirementsPanel(view)
        : store.ui.rightPanel === "status"
        ? statusPanel(view)
        : store.ui.rightPanel === "assistant"
        ? assistantPanel()
        : store.ui.rightPanel === "properties"
        ? propertiesPanel(view)
        : versionsPanel()
    }</div></aside>`;
  }

  function mediaPanel(view) {
    const assets = store.data.assets.filter((asset) => !asset.archived);
    const query = String(store.ui.assetQuery || "").trim().toLowerCase();
    const visibleAssets = assets.filter((asset) =>
      !query ||
      asset.filename.toLowerCase().includes(query) ||
      String(asset.title).toLowerCase().includes(query)
    );
    const used = view ? view.lesson.media_count : 0;
    const insertAnchor = store.ui.selectedBlockId
      ? "会插入到当前选中区块之后"
      : "会追加到当前课末尾";
    return `<div class="side-head"><div><span class="eyebrow">当前课程</span><h2>媒体库</h2></div><button class="icon-button" data-action="open-file" aria-label="添加素材" title="添加素材">＋</button></div><label class="field-label">搜索素材<input class="select" data-asset-search placeholder="输入文件名" value="${
      esc(store.ui.assetQuery || "")
    }" /></label>${PROJECT_FILE_PICKER}<p class="side-note">本课已引用 ${used} 个素材。选择素材${insertAnchor}。</p><div class="side-list">${
      visibleAssets.length
        ? visibleAssets.map((asset) => {
          const usages = usagesForAsset(store.data, asset.id);
          const displayName = asset.title || asset.filename;
          const preview = assetPreview(asset);
          return `<div class="side-item asset-row" data-asset-id="${
            asset.id
          }"><span class="side-thumb-wrap">${
            previewFrame(asset, "thumb", assetThumb(asset))
          }</span><span class="side-item-body"><b>${
            esc(displayName)
          }</b><small>${esc(assetLabel(asset.type))} · ${
            usages.length ? `已使用 ${usages.length} 处` : "还没有被引用"
          }</small></span><span class="side-item-tools">${preview?.failed ? retryAssetPreviewButton(asset, true) : ""}<button class="icon-button" data-action="insert-asset" data-id="${
            asset.id
          }" aria-label="插入素材：${esc(asset.filename)}" title="插入到当前位置">＋</button><button class="icon-button" data-action="rename-asset" data-id="${
            asset.id
          }" aria-label="修改显示名称：${esc(asset.filename)}" title="修改显示名称">✎</button><button class="icon-button" data-action="show-asset-usage" data-id="${
            asset.id
          }" aria-label="查看素材使用位置：${esc(asset.filename)}" title="查看这个素材的使用位置">?</button></span></div>`;
        }).join("")
        : assets.length
        ? `<div class="side-empty">没有找到匹配的素材。换一个文件名继续搜索。</div>`
        : `<div class="side-empty">还没有素材。点击“添加素材”导入第一个文件。</div>`
    }</div>${
      store.ui.assetUsageId ? assetUsagePanel(store.ui.assetUsageId) : ""
    }`;
  }

  function assetUsagePanel(assetId) {
    const asset = store.data.assets.find((candidate) =>
      candidate.id === assetId
    );
    if (!asset) return "";
    const usages = usagesForAsset(store.data, assetId);
    return `<div class="usage-box"><div class="side-head"><b>使用位置</b><button class="icon-button" data-action="hide-asset-usage" aria-label="关闭使用位置" title="关闭使用位置">×</button></div>${
      usages.length
        ? usages.map((usage) => {
          const item = store.data.content_items.find((candidate) =>
            candidate.id === usage.content_item_id
          );
          const block = usage.block_id
            ? store.data.blocks.find((candidate) =>
              candidate.id === usage.block_id
            )
            : null;
          return `<button class="side-item" data-action="focus-usage" data-id="${
            usage.content_item_id
          }" data-block="${
            usage.block_id || ""
          }"><span>${esc(item ? item.code : "未知")}</span><small>${
            esc(block ? blockLabel(block.type) : "整课引用")
          } · ${esc(usage.role)}</small></button>`;
        }).join("")
        : `<p class="side-note">还没有被引用。</p>`
    }<button class="text-button danger" data-action="delete-asset" data-id="${
      asset.id
    }">删除这个素材</button></div>`;
  }

  function requirementsPanel(view) {
    if (!view) return `<div class="side-empty">还没有选中课程。先在左侧选择一课，就可以继续。</div>`;
    const gaps = view.lesson.gaps;
    const requirements = view.requirements;
    const open = requirements.filter((requirement) =>
      requirement.status === "open"
    );
    const done = requirements.filter((requirement) =>
      requirement.status !== "open"
    );
    return `<div class="side-head"><div><span class="eyebrow">完成这一课</span><h2>待补 <sup>${
      open.length
    }</sup></h2></div><button class="icon-button" data-action="add-placeholder" aria-label="新增待补占位符" title="新增待补占位符">＋</button></div><div class="gap-summary"><div><b>${
      gaps.content
    }</b><span>内容待补</span></div><div><b>${
      gaps.layout
    }</b><span>排版待补</span></div><div><b>${
      view.progress.missing_media
    }</b><span>缺素材</span></div></div><div class="modal-actions compact"><button class="secondary" data-action="add-requirement-text">＋ 文字待补</button><button class="secondary" data-action="add-requirement-image">＋ 图片待补</button></div><div class="side-list">${
      open.length
        ? open.map((requirement) => requirementRow(requirement)).join("")
        : `<div class="side-empty">这一课没有未完成的待补内容，可以继续写正文或查看预览。</div>`
    }</div>${
      done.length
        ? `<details class="done-group"><summary>已完成 ${done.length} 项</summary>${
          done.map((requirement) => requirementRow(requirement)).join("")
        }</details>`
        : ""
    }<p class="side-note">待补会一直保存，重开项目后仍然可以定位到这里。</p>`;
  }

  function requirementRow(requirement) {
    const editing = store.ui.editingRequirementId === requirement.id;
    const block = requirement.anchor_block_id
      ? store.data.blocks.find((candidate) =>
        candidate.id === requirement.anchor_block_id
      )
      : null;
    const asset = requirement.resolved_asset_id
      ? store.data.assets.find((candidate) =>
        candidate.id === requirement.resolved_asset_id
      )
      : null;
    const anchor = requirementAnchorLabel(store.data, requirement);
    const mediaRequirement = MEDIA_REQUIREMENT_TYPES.includes(requirement.type);
    if (editing) {
      return `<div class="requirement-item editing" data-requirement-id="${
        requirement.id
      }"><label class="field-label">备注<input class="select" data-requirement-note data-id="${
        requirement.id
      }" value="${esc(requirement.note)}" /></label><label class="field-label">类型<select class="select" data-requirement-type data-id="${
        requirement.id
      }">${
        REQUIREMENT_TYPES.map((type) =>
          `<option value="${type}" ${
            requirement.type === type ? "selected" : ""
          }>${requirementTypeLabel(type)}</option>`
        ).join("")
      }</select></label><label class="field-label">优先级<select class="select" data-requirement-priority data-id="${
        requirement.id
      }">${
        [["low", "低"], ["normal", "普通"], ["high", "重要"]].map((
          [key, label],
        ) =>
          `<option value="${key}" ${
            requirement.priority === key ? "selected" : ""
          }>${label}</option>`
        ).join("")
      }</select></label><div class="modal-actions"><button class="secondary" data-action="cancel-requirement-edit">取消</button><button class="primary" data-action="save-requirement" data-id="${
        requirement.id
      }">保存</button></div></div>`;
    }
    const openActions = mediaRequirement
      ? `<button class="secondary" data-action="pick-asset-for-requirement" data-id="${requirement.id}">选择素材</button><button class="secondary" data-action="pick-asset-for-requirement" data-id="${requirement.id}">用素材完成</button>${
        block
          ? `<button class="text-button" data-action="focus-requirement" data-id="${requirement.id}">定位</button>`
          : ""
      }`
      : `${
        block
          ? `<button class="text-button" data-action="focus-requirement" data-id="${requirement.id}">定位</button>`
          : ""
      }<button class="text-button" data-action="edit-requirement" data-id="${requirement.id}">改备注</button><button class="secondary" data-action="resolve-requirement" data-id="${requirement.id}">完成</button>`;
    return `<div class="requirement-item ${
      requirement.status === "open" ? "open" : "resolved"
    }" data-requirement-id="${requirement.id}"><span class="req-dot ${
      requirement.status === "open" ? "open" : "done"
    }">${requirement.status === "open" ? "!" : "✓"}</span><div class="requirement-body"><b>${
      esc(requirementTypeLabel(requirement.type))
    }${requirement.priority === "high" ? " · 重要" : ""}${
      requirement.scope === "layout" ? " · 排版" : ""
    }</b><span>${esc(requirement.note || "没有备注")}</span><small class="muted">位置：${
      esc(anchor)
    }${
      asset
        ? ` · 已关联素材：${esc(asset.title || asset.filename)}`
        : ""
    }</small><div class="requirement-actions">${
      requirement.status === "open"
        ? openActions
        : `<button class="secondary" data-action="reopen-requirement" data-id="${
          requirement.id
        }">重新打开</button><button class="text-button" data-action="edit-requirement" data-id="${
          requirement.id
        }">改备注</button>${
          block
            ? `<button class="text-button" data-action="focus-requirement" data-id="${requirement.id}">定位</button>`
            : ""
        }`
    }<button class="text-button danger" data-action="delete-requirement" data-id="${
      requirement.id
    }">删除</button></div></div></div>`;
  }

  /**
   * Which six-dimensional status a select edits, and on which lesson.  The
   * dimension name comes from the project's own `status_dimensions` row
   * (through the authoring projection), never from a guess in the view.
   */
  function dimensionLabel(status) {
    return status.label || status.name || status.key || "";
  }

  function statusPanel(view) {
    if (!view) return `<div class="side-empty">还没有选中课程。先在左侧选择一课，就可以继续。</div>`;
    return `<div class="side-head"><div><span class="eyebrow">正在修改</span><h2>制作状态</h2><p class="side-note">作用对象：<b>${
      esc(view.lesson.code)
    }｜${esc(view.lesson.title)}</b>。下面每行是一个状态维度。</p></div></div><label class="field-label">课程标题<input class="select" data-lesson-title value="${
      esc(view.lesson.title)
    }" /></label><div class="status-list">${
      view.progress.statuses.map((status) =>
        `<label class="status-row" title="状态维度：${
          esc(dimensionLabel(status))
        }"><span>${esc(dimensionLabel(status))}${
          status.terminal ? " ✓" : ""
        }</span><select data-status-dim="${status.key}" aria-label="${
          esc(dimensionLabel(status))
        }状态">${
          store.statusOptions(status.key).map((option) =>
            `<option ${
              option === status.option ? "selected" : ""
            }>${esc(option)}</option>`
          ).join("")
        }</select></label>`
      ).join("")
    }</div><p class="side-note">状态和完整度是两件事：正文可以已定稿，同时仍有图片待补。</p>`;
  }

  /* ------------------------------------------------------- AI workflow */

  const AI_SCOPE_LABELS = { course: "课程", lesson: "当前课次", block: "当前区块" };
  const AI_STATUS_LABELS = {
    idle: "尚未运行",
    assembling: "正在整理上下文",
    running: "正在请求模型",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  const AI_EXECUTION_STATUS_LABELS = { succeeded: "成功", failed: "失败", cancelled: "已取消" };
  const AI_EXECUTION_OUTCOME_LABELS = {
    answer: "只生成回答",
    suggestion: "已存为建议",
    change_draft: "已生成修改草稿",
    none: "没有产出",
  };
  const AI_REVIEW_LABELS = { pending: "待审核", rejected: "已拒绝", applied: "已应用", apply_failed: "应用失败" };
  const AI_DRAFT_STATUS_LABELS = { reviewing: "待审核", applied: "已应用", discarded: "已拒绝" };
  const AI_OPERATION_LABELS = {
    replace_block: "替换正文",
    insert_block: "新增区块",
    create_requirement: "新增待补",
    move_block: "调整顺序",
  };
  const AI_INCLUDE_KEYS = [
    ["requirements", "待补要求"],
    ["assets", "素材信息"],
    ["completion", "完成度与状态"],
    ["nearby", "相邻内容"],
  ];

  /**
   * Connections the assistant can offer: exactly what `ai.connection.list`
   * returned (§9.2).  Workbench ships no provider templates and invents no
   * defaults, so an id the shell does not hold is not a choice — with no saved
   * connection the assistant shows「配置 AI」instead of a pretend provider.
   *
   * The deterministic offline connector joins only while a session has
   * explicitly selected it (that is how the automated runs drive it), and it is
   * never offered as a template card in Settings → Models.
   */
  function aiProviderChoices() {
    const saved = Array.isArray(store.ui.aiProviders) ? store.ui.aiProviders : [];
    const choices = saved
      .map((entry) => (typeof store.connectionRecord === "function"
        ? store.connectionRecord(entry)
        : { ...entry }))
      .filter((entry) => String(entry?.id || "").trim());
    const currentId = String(store.ui.aiProviderId || "").trim();
    if (currentId === AI_OFFLINE_PROVIDER_ID &&
      !choices.some((entry) => entry.id === currentId)) {
      choices.unshift({
        id: AI_OFFLINE_PROVIDER_ID,
        label: "本地确定性连接器（离线）",
        kind: "fake",
        api_protocol: "openai-completions",
        base_url: "",
        chat_path: "",
        auth_header: "",
        auth_scheme: "",
        default_model: "fake-deterministic",
        models: ["fake-deterministic"],
        requires_credential: false,
      });
    }
    // Whatever is selected leads, so the selector can never misreport a run.
    return choices.sort((left, right) =>
      left.id === currentId ? -1 : right.id === currentId ? 1 : 0
    );
  }

  function aiConfiguredMap() {
    return store.ui.aiConfigured && typeof store.ui.aiConfigured === "object"
      ? store.ui.aiConfigured
      : {};
  }

  function aiIncludeToggles() {
    const include = store.ui.aiInclude && typeof store.ui.aiInclude === "object"
      ? store.ui.aiInclude
      : {};
    return `<div class="ai-include-row">${
      AI_INCLUDE_KEYS.map(([key, label]) => {
        const on = include[key] !== false;
        return `<button class="ai-toggle" data-action="ai-toggle-context" data-key="${key}" aria-pressed="${on}">${
          on ? "✓ " : "○ "
        }${label}</button>`;
      }).join("")
    }</div>`;
  }

  function aiContextPreview() {
    if (!store.ui.aiContextOpen || !store.ui.aiContext) return "";
    const context = store.ui.aiContext;
    const lines = aiContextPreviewLines(context);
    const excluded = Array.isArray(context.excluded) ? context.excluded : [];
    return `<div class="ai-context">
      <p class="ai-context-total">本次共发送 <b>${lines.length}</b> 项、<b>${
      Number(context.payload_chars) || 0
    }</b> 字。范围：${esc(context.scope ? context.scope.label : "未指定")}</p>
      ${
      lines.length
        ? `<ul class="ai-context-list">${
          lines.map((line) =>
            `<li><b>${esc(line.label)}</b><small>${esc(line.source_type)} · ${
              Number(line.chars) || 0
            } 字</small></li>`
          ).join("")
        }</ul>`
        : `<p class="ai-hint">按当前勾选，这次不会发送任何课程内容。请选择至少一项内容后再预览或运行。</p>`
    }
      <div class="ai-excluded"><b>不会发送</b>${
      excluded.length
        ? `<ul>${
          excluded.map((entry) =>
            `<li>${esc(entry.source_type)}｜${esc(entry.reason)}${
              entry.source_id ? `（${esc(entry.source_id)}）` : ""
            }</li>`
          ).join("")
        }</ul>`
        : `<p class="ai-hint">没有需要排除的内容。</p>`
    }</div>
    </div>`;
  }

  /**
   * §9.3 — the existing-connections list.  Rows come from saved connections
   * only: no Volcengine/Doubao, OpenAI, Anthropic or DeepSeek template cards
   * (§9.2).  Each row carries the full field set the spec names — display name,
   * Provider ID, Base URL, protocol, credential state, configured models and
   * default model — and never renders a secret value.
   */
  function aiConnectionManagerView(choices, configured) {
    const savedIds = new Set(
      (Array.isArray(store.ui.aiProviders) ? store.ui.aiProviders : [])
        .map((provider) => String(provider?.id || "").trim())
        .filter(Boolean),
    );
    const connections = choices.filter((choice) =>
      !aiIsOfflineConnection(choice) &&
      String(choice.kind || "") !== "openai_chatgpt_subscription");
    const protocolLabels = aiApiProtocolChoices();
    return `<section class="ai-connection-manager" id="ai-connection-manager">
      <div class="ai-block-head"><div><b>已有模型服务商</b><small>只显示你创建的 API 连接与已保存的订阅账户；API Key 只显示是否已配置，不会回显。</small></div><button class="primary" data-action="ai-create-connection">+ 添加模型服务商</button></div>
      <div class="ai-connection-list">${connections.length
        ? connections.map((choice) => {
          const id = String(choice.id || "");
          const active = id === String(store.ui.aiProviderId || "");
          const configuredKey = configured[id] === true;
          const saved = savedIds.has(id);
          const models = (Array.isArray(choice.models) ? choice.models : []).filter(Boolean);
          const protocol = String(choice.api_protocol || "openai-completions");
          const protocolLabel = protocolLabels.find((entry) => entry.id === protocol)?.label || protocol;
          const defaultModel = String(choice.default_model || "");
          return `<article class="ai-connection-row${active ? " active" : ""}" data-provider-id="${esc(id)}">
            <div class="ai-connection-info">
              <div class="ai-connection-title"><b>${esc(choice.label || id)}</b>${active
                ? `<span class="ai-key-state active">当前使用</span>`
                : ""}<span class="ai-key-state ${configuredKey ? "set" : "unset"}">${
                  configuredKey ? "凭据已配置" : "未配置凭据"
                }</span></div>
              <small>Provider ID：${esc(id)}</small>
              <small>Base URL：${esc(choice.base_url || "尚未设置")}</small>
              <small>协议：${esc(protocolLabel)}</small>
              <small data-ai-connection-models>已配置模型：${
                models.length ? esc(models.join("、")) : "无（可手动填写 Model ID）"
              }</small>
              <small>默认模型：${esc(defaultModel || "未设置")}</small>
            </div>
            <div class="ai-connection-actions"><button class="text-button" data-action="ai-use-provider" data-id="${esc(id)}" ${active ? "disabled" : ""}>${active ? "当前连接" : "使用"}</button><button class="text-button" data-action="ai-edit-connection" data-id="${esc(id)}">编辑</button>${saved ? `<button class="text-button danger" data-action="ai-delete-connection" data-id="${esc(id)}">删除</button>` : ""}</div>
          </article>`;
        }).join("")
        : `<p class="ai-hint">还没有 API 连接。点「+ 添加模型服务商」新建一个，填写 Provider ID、Base URL、协议与模型即可。</p>`}</div>
    </section>`;
  }

  function aiSubscriptionSettingsView(store, configured) {
    const native = Boolean(store.bridge?.isNative?.());
    const accounts = (Array.isArray(store.ui.aiProviders) ? store.ui.aiProviders : [])
      .filter((provider) => provider?.kind === "openai_chatgpt_subscription");
    const attempt = store.ui.aiSubscriptionAttempt || null;
    const pending = attempt?.status === "pending";
    const statusLine = attempt?.message
      ? `<p class="ai-subscription-status ${esc(attempt.status || "")}" aria-live="polite">${esc(attempt.message)}</p>`
      : `<p class="ai-hint">授权由你在系统浏览器中完成；Access/Refresh Token 只保存在本机系统钥匙串。</p>`;
    return `<section class="ai-subscription-settings">
      <div class="ai-block-head"><div><b>ChatGPT 订阅登录</b><small>OpenAI SIWC · 独立于 API Key</small></div></div>
      ${native
        ? `<p class="ai-hint">首次登录会为 Workbench 动态注册独立客户端身份。Workbench 不读取其他应用的会话，也不会用环境 API Key 代替订阅授权。</p><div class="ai-run-row"><button class="secondary" data-action="ai-subscription-start" ${pending ? "disabled" : ""}>Continue with ChatGPT</button>${pending ? `<button class="text-button" data-action="ai-subscription-cancel">取消登录</button>` : ""}</div>${statusLine}`
        : `<p class="ai-hint">当前浏览器服务壳不支持订阅登录；请在 macOS 桌面版使用系统浏览器回调与系统钥匙串。这里不会模拟成功状态。</p>`}
      <div class="ai-subscription-list">${accounts.length
        ? accounts.map((provider) => {
          const id = String(provider.id || "");
          const connected = configured[id] === true;
          return `<article class="ai-subscription-row"><div><b>${esc(provider.label || provider.siwc_email || "ChatGPT 账户")}</b><small>${connected ? "已授权" : "未登录"} · ${esc(id)}</small><small>默认模型：${esc(provider.default_model || "尚未读取模型")}</small></div>${native ? `<div class="ai-connection-actions">${connected ? `<button class="text-button" data-action="ai-subscription-logout" data-id="${esc(id)}">退出登录</button>` : `<button class="text-button" data-action="ai-subscription-start" data-id="${esc(id)}" ${pending ? "disabled" : ""}>重新登录</button>`}<button class="text-button danger" data-action="ai-delete-connection" data-id="${esc(id)}">删除</button></div>` : ""}</article>`;
        }).join("")
        : `<p class="ai-hint">尚未添加 ChatGPT 订阅账户。</p>`}</div>
    </section>`;
  }

  /**
   * Provider/base-url/model form.  It never renders a credential value: the
   * key field is a masked, unbound `<input type="password">` whose text lives
   * only in the DOM until 保存密钥 reads it.
   *
   * Every field carries a `data-focus-key` so a render that lands mid-typing
   * can put the caret (and the typed text) back where it was.
   */
  function aiProviderFormView(descriptor, configured) {
    const form = store.ui.aiProviderForm;
    if (!form) return "";
    const providerId = String(form.id || descriptor?.id || "").trim();
    const isFake = aiIsOfflineConnection(providerId);
    const isNew = form.isNew === true;
    const configSaved = (Array.isArray(store.ui.aiProviders) ? store.ui.aiProviders : []).some((provider) => provider?.id === providerId);
    const discovered = Array.isArray(store.ui.aiModelOptions)
      ? store.ui.aiModelOptions
      : [];
    const chosen = String(store.ui.aiChosenModel || form.default_model || "");
    const manual = String(store.ui.aiManualModel || "");
    const busy = store.ui.aiModelsBusy === true;
    const failure = String(store.ui.aiModelsError || "");
    const source = String(store.ui.aiModelSource || "");
    const query = String(store.ui.aiModelQuery || "").trim().toLowerCase();
    const visibleModels = discovered.filter((id) => !query || id.toLowerCase().includes(query));
    // §9.6: the catalog is multi-select; ticking is only form state until
    // 「加入所选模型」and nothing at all persists before 保存连接.
    const ticked = new Set(
      (Array.isArray(store.ui.aiModelSelection) ? store.ui.aiModelSelection : [])
        .map((model) => String(model || "")),
    );
    const addedModels = (Array.isArray(form.models) ? form.models : [])
      .map((model) => String(model || "").trim())
      .filter(Boolean);
    const protocolChoices = aiApiProtocolChoices();
    return `<div class="ai-provider-form">
      <label class="field-label">Provider ID<input class="select" data-ai-provider-id data-focus-key="ai-provider-id" placeholder="例如 my-openai-key" value="${
      esc(providerId)
    }" ${isFake || configSaved ? "disabled" : ""} autocomplete="off" /></label>
      ${configSaved
        ? `<p class="ai-hint">Provider ID 创建后永久固定，不能再修改；显示名称可以随时改。</p>`
        : `<p class="ai-hint">保存后这个 ID 就永久固定，之后只能改显示名称。</p>`}
      <label class="field-label">显示名称<input class="select" data-ai-provider-label data-focus-key="ai-provider-label" value="${
      esc(form.label || descriptor?.label || "")
    }" /></label>
      <label class="field-label">Base URL<input class="select" data-ai-base-url data-focus-key="ai-base-url" placeholder="https://api.example.com/v1" value="${
      esc(form.base_url || "")
    }" ${isFake ? "disabled" : ""} /></label>
      ${isFake ? "" : `<label class="field-label">API 协议<select class="select" data-ai-api-protocol data-focus-key="ai-api-protocol">${
    protocolChoices.map((choice) =>
      `<option value="${esc(choice.id)}" ${
        String(form.api_protocol || "openai-completions") === choice.id ? "selected" : ""
      }>${esc(choice.label)}</option>`).join("")
  }</select></label>`}
      ${
      isFake
        ? `<p class="ai-hint">「本地确定性连接器」是完全离线的自动化测试通道，不需要地址或密钥，也没有可保存的配置；它不会出现在连接列表里。</p>`
        : `<p class="ai-hint">这里保存的是地址与模型名，不是密钥；密钥用下面的「保存密钥」单独写入。</p>
      <div class="ai-run-row">
        <button class="secondary" data-action="ai-discover-models" data-focus-key="ai-discover" ${
          busy ? "disabled" : ""
        }>${busy ? "正在读取模型…" : "读取模型"}</button>
        <span class="ai-model-source">${
          source === "remote"
            ? `已从服务商读取到 ${discovered.length} 个模型`
            : source === "manual"
            ? "改为手动填写 Model ID"
            : "还没有读取过模型"
        }</span>
      </div>
      ${
          failure
            ? `<p class="ai-hint warning" data-ai-models-error>读取模型失败：${
              esc(failure)
            }。可以直接在下面手动填写 Model ID，不影响保存。</p>`
            : ""
        }
      ${
          discovered.length
            ? `<label class="field-label">搜索模型<input class="select" data-ai-model-search data-focus-key="ai-model-search" placeholder="搜索 Model ID" /></label>
      <p class="ai-hint">勾选想要的模型再点「加入所选模型」；这一步只改表单，保存连接之前不会写入任何配置。</p>
      <div class="ai-model-list" data-ai-model-list>${
              visibleModels.map((id) =>
                `<button class="ai-model-chip${
                  ticked.has(id) ? " active" : ""
                }" data-action="ai-toggle-model-selection" data-id="${
                  esc(id)
                }" aria-pressed="${ticked.has(id)}">${esc(store.ui.aiModelLabels?.[id] || id)}${store.ui.aiModelLabels?.[id] ? ` <small>${esc(id)}</small>` : ""}</button>`
              ).join("")
            }</div>
      <div class="ai-run-row"><button class="secondary" data-action="ai-add-selected-models" ${
              ticked.size ? "" : "disabled"
            }>加入所选模型${ticked.size ? `（${ticked.size}）` : ""}</button></div>`
            : ""
        }
      ${
          addedModels.length
            ? `<p class="ai-hint">这个连接将拥有的模型（点一个设为默认模型）：</p><div class="ai-model-list ai-model-list-added">${
              addedModels.map((id) =>
                `<button class="ai-model-chip${
                  chosen === id && !manual ? " active" : ""
                }" data-action="ai-pick-model" data-id="${
                  esc(id)
                }" aria-pressed="${chosen === id && !manual}">${
                  esc(store.ui.aiModelLabels?.[id] || id)
                }${chosen === id && !manual ? " <small>默认</small>" : ""}</button>`
              ).join("")
            }</div>`
            : `<p class="ai-hint">还没有加入任何模型；读取失败时也可以直接手动填写 Model ID。</p>`
        }
      <label class="field-label">手动输入 Model ID（读取失败或需要未列出的模型时使用）<input class="select" data-ai-model-manual data-focus-key="ai-model-manual" placeholder="例如 deepseek-chat" value="${
          esc(manual || (discovered.length ? "" : chosen))
        }" /></label>
      <p class="ai-hint">将要使用的模型：<b data-ai-model-preview>${
          esc(manual || chosen || "（还没有选择）")
        }</b><span data-ai-model-preview-note>${
          manual ? "（手动填写）" : discovered.length ? "（来自读取结果）" : ""
        }</span></p>`
    }
      <div class="ai-run-row">
        <button class="primary" data-action="ai-save-provider" ${
      isFake ? "disabled" : ""
    }>保存配置</button>
        <button class="secondary" data-action="ai-cancel-provider">取消</button>
      </div>
      ${isFake ? "" : `<div class="ai-run-row"><button class="secondary" data-action="ai-test-connection" ${store.ui.aiConnectionTestStatus?.state === "busy" ? "disabled" : ""}>${store.ui.aiConnectionTestStatus?.state === "busy" ? "正在测试…" : "测试连接"}</button><span class="ai-connection-test ${esc(store.ui.aiConnectionTestStatus?.state || "")}" data-ai-connection-test>${esc(store.ui.aiConnectionTestStatus?.message || "测试使用固定短提示，不会读取课程内容。")}</span></div>`}
      <p class="ai-hint">配置状态：${configSaved ? "连接配置已保存" : "连接配置尚未保存"}</p>
      <p class="ai-hint">凭据状态：${
      isFake
        ? "不需要密钥（离线连接器）。"
        : configured[providerId]
        ? "已配置密钥。"
        : "未配置密钥；运行时会以「缺少密钥」提示，不会伪造回答。"
    }</p>
      ${
      isFake ? "" : `<div class="ai-run-row">
        <input class="select" type="password" data-ai-secret data-provider-id="${esc(providerId)}" data-focus-key="ai-secret" autocomplete="off" placeholder="${configured[providerId] ? "粘贴新 API Key 以替换本机密钥" : "粘贴 API Key（不会回显）"}" />
        <button class="secondary" data-action="ai-save-secret" data-provider-id="${esc(providerId)}">保存密钥</button>
      </div>
      <div class="ai-run-row"><button class="text-button danger" data-action="ai-delete-secret" data-provider-id="${esc(providerId)}" ${
        configured[providerId] ? "" : "disabled"
      }>删除本机保存的密钥</button></div>`
    }
    </div>`;
  }

  function aiResultView() {
    const result = store.ui.aiResult;
    if (!result || !result.answer) return "";
    const pendingDraft = result.change_draft_id && store.ui.aiDraftId !== result.change_draft_id
      ? String(result.change_draft_id)
      : "";
    return `<div class="ai-block">
      <div class="ai-block-head"><b>AI 回答</b><button class="icon-button" data-action="ai-close-result" aria-label="收起 AI 回答" title="收起回答">×</button></div>
      <pre class="ai-answer">${esc(result.answer)}</pre>
      ${
      pendingDraft
        ? `<button class="primary full" data-action="ai-open-draft" data-id="${esc(pendingDraft)}">打开修改对照</button>`
        : ""
    }
      <p class="ai-hint">${
      result.change_draft_id
        ? "这次回答带有可审核的修改，下面会显示修改前后；确认前课程内容不会改变。"
        : result.suggestion_id
        ? "这次回答已保存为建议，正文没有改动。"
        : "这次没有生成可保存的建议；你仍可继续编辑。"
    }</p>
    </div>`;
  }

  function aiDraftView() {
    const draftId = store.ui.aiDraftId;
    if (!draftId) return "";
    const draft = (store.data.change_drafts || []).find((candidate) => candidate.id === draftId) || null;
    if (!draft) return "";
    let rows = [];
    try {
      rows = aiChangeDraftDiffRows(store.data, draftId);
    } catch {
      rows = [];
    }
    const operations = Array.isArray(draft.operations) ? draft.operations : [];
    const validation = draft.validation || null;
    const reviewing = draft.status === "reviewing";
    return `<div class="ai-block ai-diff">
      <div class="ai-block-head"><b>修改草稿 · 修改对照</b><span class="badge ${
      draft.status === "applied" ? "done" : draft.status === "discarded" ? "warning" : "open"
    }">${esc(AI_DRAFT_STATUS_LABELS[draft.status] || draft.status)}</span></div>
      <p class="ai-hint">下面列出修改前后内容。逐条看过后再决定；应用后可以用“撤销”回到应用前。</p>
      ${
      rows.map((row, index) => {
        const reason = operations[index] ? String(operations[index].reason || "") : "";
        const lines = (list) =>
          list.length
            ? `<pre class="ai-diff-lines">${
              list.map((line, position) => `${position + 1}. ${esc(line)}`).join("\n")
            }</pre>`
            : `<p class="ai-diff-empty">（无）</p>`;
        return `<article class="ai-diff-row">
          <header><b>${esc(row.label)}</b><span class="badge">${
          esc(AI_OPERATION_LABELS[row.op] || row.op)
        }</span></header>
          <p class="ai-diff-reason">理由：${esc(reason || "模型没有说明理由")}</p>
          <div class="ai-diff-sides">
            <div class="ai-diff-side before"><span class="eyebrow">修改前</span>${
          lines(row.before_lines)
        }</div>
            <div class="ai-diff-side after"><span class="eyebrow">修改后</span>${
          lines(row.after_lines)
        }</div>
          </div>
        </article>`;
      }).join("")
    }
      ${
      validation && validation.ok === false && Array.isArray(validation.issues) && validation.issues.length
        ? `<div class="ai-error"><b>上次校验未通过</b>${
          validation.issues.map((issue) => `<p>${esc(issue)}</p>`).join("")
        }</div>`
        : ""
    }
      <div class="ai-diff-actions">
        <button class="primary" data-action="ai-apply-draft" ${
      reviewing ? "" : "disabled"
    }>应用这些修改</button>
        <button class="secondary" data-action="ai-reject-draft" ${
      reviewing ? "" : "disabled"
    }>拒绝</button>
        <button class="text-button" data-action="ai-dismiss-draft">关闭修改对照</button>
      </div>
    </div>`;
  }

  function aiExecutionsView() {
    const records = Array.isArray(store.ui.aiExecutions) ? store.ui.aiExecutions : [];
    const open = store.ui.aiExecutionsOpen === true;
    const row = (record) => {
      const created = record.created_at ? new Date(record.created_at) : null;
      const when = created && !Number.isNaN(created.getTime())
        ? created.toLocaleString("zh-CN")
        : "时间未知";
      const scope = record.scope || {};
      const provider = record.provider || {};
      const review = record.review || {};
      const providerText = [provider.label || provider.provider_id, provider.model]
        .filter(Boolean).join(" · ") || "未记录服务商";
      const draftId = record.change_draft_id &&
          (store.data.change_drafts || []).some((draft) =>
            draft.id === record.change_draft_id
          )
        ? String(record.change_draft_id)
        : "";
      return `<article class="ai-execution">
        <div class="ai-execution-head"><b>${esc(when)}</b><span class="badge ${
        record.status === "succeeded" ? "done" : record.status === "failed" ? "warning" : "open"
      }">${esc(AI_EXECUTION_STATUS_LABELS[record.status] || record.status || "未知状态")}</span></div>
        <dl><dt>范围</dt><dd>${esc(scope.label || scope.kind || "未记录范围")}</dd>
        <dt>服务商</dt><dd>${esc(providerText)}</dd>
        <dt>结果</dt><dd>${esc(AI_EXECUTION_OUTCOME_LABELS[record.outcome] || record.outcome || "未记录")}${
        review.state ? ` · 审核：${esc(AI_REVIEW_LABELS[review.state] || review.state)}` : ""
      }</dd>${
        record.error_code
          ? `<dt>状态</dt><dd>这次执行没有完成${
            record.error_message ? `：${esc(record.error_message)}` : "，可以检查设置后再试"
          }</dd>`
          : ""
      }</dl>
        ${
        draftId
          ? `<button class="text-button" data-action="ai-open-draft" data-id="${esc(draftId)}">打开这次修改对照</button>`
          : ""
      }
      </article>`;
    };
    return `<div class="ai-block ai-executions">
      <div class="ai-block-head">
        <button class="text-button" data-action="ai-toggle-executions" aria-expanded="${open}">执行记录（${records.length}）${
      open ? " ▾" : " ▸"
    }</button>
        <button class="icon-button" data-action="ai-refresh-executions" aria-label="重新读取 AI 执行记录" title="重新读取执行记录">↻</button>
      </div>
      ${
      open
        ? records.length
          ? `<div class="ai-execution-list">${records.map(row).join("")}</div>`
          : `<p class="side-note">还没有这门课程的执行记录。运行一次 AI 后，这里会显示时间、范围、服务商和结果；这些记录不属于课程内容。</p>`
        : ""
    }
    </div>`;
  }

  function assistantPanel() {
    const item = store.currentItem();
    const lessons = courseMap(store.data, store.ui.activeId).lessons;
    // The lesson read model is what carries the human label for a block, so the
    // panel names its target exactly like the editor does.
    const lesson = item ? lessonView(store.data, item.id) : null;
    const lessonBlocks = lesson ? lesson.blocks : [];
    const selected = lessonBlocks.find((block) => block.id === store.ui.selectedBlockId) || null;
    const bound = lessonBlocks.find((block) => block.id === store.ui.aiBlockId) || null;
    const targetBlock = selected || bound;
    const choices = aiProviderChoices();
    const configured = aiConfiguredMap();
    const currentProviderId = String(store.ui.aiProviderId || "").trim();
    // §9.7: the panel runs exactly the connection the user selected, never a
    // stand-in.  Falling back to "the first item" or to the offline connector
    // would let a run start against a connection nobody chose.
    const descriptor = choices.find((choice) => choice.id === currentProviderId) || null;
    const providerId = currentProviderId || (descriptor ? descriptor.id : "");
    const models = descriptor && Array.isArray(descriptor.models) ? descriptor.models : [];
    const model = store.ui.aiModel || (descriptor ? descriptor.default_model : "") || models[0] || "";
    const status = String(store.ui.aiStatus || "idle");
    const error = store.ui.aiError;
    const errorCode = String(error?.code || "");
    const errorTitle = errorCode === "authentication_failed"
      ? "服务商认证失败（401）"
      : errorCode === "missing_credential"
      ? "本机尚未保存 API Key"
      : "这次 AI 没有完成";
    const errorHint = errorCode === "authentication_failed"
      ? "本机已取到这条连接的凭据，但服务商拒绝了认证。请检查 Base URL、认证头和方案，确认后再更新密钥。"
      : errorCode === "missing_credential"
      ? "本机没有这条连接的凭据。请在连接管理中单独保存 API Key。"
      : "课程内容没有改动，你可以检查设置后重试。";
    const running = status === "running";
    const form = store.ui.aiProviderForm;
    const formDescriptor = form
      ? choices.find((choice) => choice.id === form.id) || store.aiDescriptor(form.id)
      : descriptor;

    // Block scope is only offered when the editor has a block to point at;
    // when both exist the live selection wins, and `aiBlockId` is the fallback
    // remembered across a cleared selection.
    const blockUsable = Boolean(targetBlock);
    // Course scope really does send every lesson's body (app/ai.js pushes one
    // `document` item per lesson), so the summary has to say that instead of
    // claiming the opposite.
    const scopeHint = lessons.length === 0
      ? "这门课程还没有课次：先建一课，AI 才能读到上下文。"
      : store.ui.aiScope === "block" && !blockUsable
      ? "先在正文或结构里点选一个区块，才能使用「当前区块」范围。"
      : store.ui.aiScope === "block" && targetBlock
      ? `区块范围只发送本课结构摘要与这一段的全文：${esc(targetBlock.label)}。`
      : store.ui.aiScope === "course"
      ? "课程范围会发送整门课程：课程地图、各课结构摘要与各课正文全文。只想改一段时请切换到「当前区块」，或关掉不需要的类别后先预览。"
      : "课级范围只发送当前课的结构、正文与待补、素材元数据，不发送其他课次的正文。";
    const capabilities = store.aiCapabilities ? store.aiCapabilities() : null;
    const noExtraCapabilities = capabilities &&
      (capabilities.tools || []).length === 0 &&
      (capabilities.mcp || []).length === 0 &&
      (capabilities.skills || []).length === 0;
    const capabilityLine = noExtraCapabilities
      ? "本次只调用所选服务商的对话接口：不会调用任何 Tool、MCP 或 Skill。"
      : capabilities
      ? `本次会调用：Tool ${(capabilities.tools || []).length} 个、MCP ${(capabilities.mcp || []).length} 个、Skill ${(capabilities.skills || []).length} 个。`
      : "";

    const hasLocalOutput = Boolean(
      store.ui.aiResult || store.ui.aiError || store.ui.aiDraftId ||
      (Array.isArray(store.ui.aiExecutions) && store.ui.aiExecutions.length),
    );
    const hasUsableConnection = Boolean(
      descriptor && (aiIsOfflineConnection(descriptor)
        ? hasLocalOutput
        : configured[providerId] === true && model),
    );
    if (!hasUsableConnection) {
      return `<div class="side-head"><div><span class="eyebrow">本地优先 · 只生成可审核建议</span><h2>AI 助手</h2></div></div><div class="ai-empty-state">${error ? `<div class="ai-error"><b>${esc(errorTitle)}</b><p>${esc(error.message || "请求没有完成。")}</p>${error.recommended_action ? `<p>${esc(error.recommended_action)}</p>` : ""}</div>` : ""}<b>还没有可用的模型连接</b><p>在设置中添加 API 连接或订阅账户，并保存至少一个可用模型后即可开始。</p><button class="primary" data-action="ai-toggle-settings">配置 AI</button><small>右上角“设置”也可随时打开模型管理。</small></div>`;
    }

    return `<div class="side-head"><div><span class="eyebrow">本地优先 · 只生成可审核建议</span><h2>AI 助手</h2></div><button class="icon-button" data-action="ai-refresh-executions" aria-label="重新读取 AI 执行记录" title="重新读取执行记录">↻</button></div>

    <div class="ai-block">
      <span class="field-label">上下文范围</span>
      <div class="ai-scope-row">${
      ["course", "lesson", "block"].map((scope) => {
        const disabled = scope === "course"
          ? lessons.length === 0
          : scope === "lesson"
          ? !item
          : !blockUsable;
        return `<button class="ai-scope" data-action="ai-scope" data-scope="${scope}" aria-pressed="${
          store.ui.aiScope === scope
        }" ${disabled ? "disabled" : ""}>${AI_SCOPE_LABELS[scope]}</button>`;
      }).join("")
    }</div>
      <p class="ai-hint">${scopeHint}</p>
    </div>

    <div class="ai-block">
      <div class="ai-block-head"><b>将发送的上下文</b><button class="text-button" data-action="ai-preview-context">${
      store.ui.aiContextOpen && store.ui.aiContext ? "重新预览" : "预览"
    }</button></div>
      ${aiIncludeToggles()}
      ${aiContextPreview()}
    </div>

    <div class="ai-block">
      <label class="field-label">服务商<select class="select" data-ai-provider>${
      choices.map((choice) =>
        `<option value="${esc(choice.id)}" ${
          choice.id === providerId ? "selected" : ""
        }>${esc(choice.label || choice.id)}${
          choice.requires_credential === false ? "（离线，无需密钥）" : ""
        }</option>`
      ).join("")
    }</select></label>
      <label class="field-label">模型<select class="select" data-ai-model>${
      models.length
        ? models.map((candidate) =>
          `<option value="${esc(candidate)}" ${
            candidate === model ? "selected" : ""
          }>${esc(candidate)}</option>`
        ).join("")
        : `<option value="">${esc(model || "还没有可用模型，请先在设置中添加")}</option>`
    }</select></label>
      <div class="ai-provider-state"><span class="ai-key-state ${configured[providerId] ? "set" : "unset"}">${descriptor?.kind === "openai_chatgpt_subscription" ? (configured[providerId] ? "ChatGPT 订阅已授权" : "ChatGPT 订阅未登录") : (configured[providerId] ? "已保存 API Key" : "未保存 API Key")}</span><span class="ai-current-model">${esc(descriptor?.label || providerId)} · ${esc(model || "未设置模型")}</span></div>
      <p class="side-note">连接与模型在右上角“设置”中管理。API Key 与订阅令牌保存在本机系统钥匙串，不写入课程文件。</p>
    </div>

    <div class="ai-block">
      <label class="field-label">指令<textarea class="select ai-instruction" rows="3" data-ai-instruction value="${
      esc(store.ui.aiInstruction)
    }">${esc(store.ui.aiInstruction)}</textarea></label>
      <button class="ai-toggle" data-action="ai-toggle-changes" aria-pressed="${
      store.ui.aiWantsChanges === true
    }">${store.ui.aiWantsChanges === true ? "✓" : "○"} 要求修改课程内容</button>
      <p class="ai-hint">${
      store.ui.aiWantsChanges === true
        ? "会要求模型给出可审核的修改；仍然只会生成修改对照，确认后才写入正文。"
        : "默认只让模型解释、提问或给建议，不要求它改正文。"
    }</p>
      <div class="ai-run-row">
        <button class="primary" data-action="ai-run" ${running ? "disabled" : ""}>${
      running ? "正在运行…" : "运行 AI"
    }</button>
        <button class="secondary" data-action="ai-cancel" ${
      running ? "" : "disabled"
    }>取消</button>
      </div>
      <p class="ai-hint" data-ai-capabilities="true">${esc(capabilityLine)}</p>
      ${
      running
        ? `<p class="ai-hint">请求已经发出。取消只会通知本机服务停止这次请求；在它结束前界面不会改动课程内容。</p>`
        : ""
    }
    </div>

    <div class="ai-block">
      <div class="ai-block-head"><b>状态</b><span class="badge ${
      status === "failed"
        ? "warning"
        : status === "done"
        ? "done"
        : status === "running" || status === "assembling"
        ? "open"
        : ""
    }">${esc(AI_STATUS_LABELS[status] || status)}</span></div>
      ${
      error
        ? `<div class="ai-error"><b>${esc(errorTitle)}</b><p>${
          esc(error.message || "这次请求没有成功。")
        }</p><p>${esc(errorHint)} 课程内容没有改动。</p>${
          error.recommended_action
            ? `<p class="muted">下一步：${esc(error.recommended_action)}</p>`
            : ""
        }</div>`
        : `<p class="ai-hint">${
          status === "idle"
            ? "还没有运行过。开始运行后，结果会显示在这里；课程内容不会自动改动。"
            : "当前没有错误，可以继续。"
        }</p>`
    }
    </div>

    ${aiResultView()}
    ${aiDraftView()}
    ${aiExecutionsView()}`;
  }

  function propertiesPanel(view) {
    const target = propertyTargetInfo();
    if (target.kind === "project") {
      const project = target.project;
      const activeStages = store.data.stages.filter((stage) => !stage.archived);
      const activeLessons = store.data.content_items.filter((lesson) => !lesson.archived);
      return `<div class="side-head"><div><span class="eyebrow">当前选择</span><h2>${esc(project.title || "课程项目")}</h2></div></div><dl class="properties"><dt>对象</dt><dd>课程项目</dd><dt>阶段</dt><dd>${activeStages.length}</dd><dt>课程内容</dt><dd>${activeLessons.length}</dd></dl><p class="side-note">选择一个课时或正文区块后，可以查看它的详细属性。</p>`;
    }
    if (target.kind === "stage") {
      const stage = target.stage;
      const lessons = store.data.content_items.filter((lesson) =>
        !lesson.archived && lesson.stage_id === stage.id
      );
      return `<div class="side-head"><div><span class="eyebrow">当前阶段</span><h2>${esc(stage.code)}｜${esc(stage.title)}</h2></div></div><dl class="properties"><dt>对象</dt><dd>阶段</dd><dt>编号</dt><dd>${esc(stage.code)}</dd><dt>标题</dt><dd>${esc(stage.title)}</dd><dt>课程内容</dt><dd>${lessons.length}</dd></dl><p class="side-note">在课程地图中可以重命名阶段，或把课时拖入此阶段。</p>`;
    }
    if (!view) return "";
    const lesson = view.lesson;
    const item = store.currentItem();
    const stage = store.data.stages.find((candidate) =>
      candidate.id === item?.stage_id
    );
    const selected = store.ui.selectedBlockId
      ? view.blocks.find((block) => block.id === store.ui.selectedBlockId)
      : null;
    const requirement = selected && selected.requirement_id
      ? view.requirements.find((candidate) =>
        candidate.id === selected.requirement_id
      ) || null
      : null;
    return `<div class="side-head"><div><span class="eyebrow">${selected ? "当前区块" : "当前课时"}</span><h2>${
      selected ? esc(selected.label) : `${esc(lesson.code)}｜${esc(lesson.title)}`
    }</h2>${selected ? `<p class="side-note">所属课时：<b>${esc(lesson.code)}｜${esc(lesson.title)}</b></p>` : ""}</div></div>${
      selected
        ? `<div class="properties-box"><label class="field-label">内容<input class="select" data-block-text data-block-id="${
          selected.id
        }" value="${esc(selected.text)}" /></label>${
          selected.type === "heading"
            ? `<label class="field-label">级别<select class="select" data-block-level data-block-id="${
              selected.id
            }">${
              [1, 2, 3, 4, 5, 6].map((level) =>
                `<option value="${level}" ${
                  selected.level === level ? "selected" : ""
                }>H${level}</option>`
              ).join("")
            }</select></label>`
            : `<label class="field-label">区块类型<select class="select" data-block-type data-block-id="${
              selected.id
            }">${
              BLOCK_PALETTE.filter(([type]) => type !== "media").map(([type, label]) =>
                `<option value="${type}" ${
                  selected.type === type ? "selected" : ""
                }>${label}</option>`
              ).join("")
            }</select></label>`
        }<dl class="properties"><dt>类型</dt><dd>${
          esc(selected.label)
        }</dd><dt>素材</dt><dd>${
          selected.asset
            ? esc(selected.asset.filename)
            : selected.media
            ? "缺失，请到媒体库重新选择"
            : "—"
        }</dd><dt>待补</dt><dd>${
          selected.requirement_id ? "有" : "无"
        }</dd></dl>${
          selected.requirement_id && requirement
            ? `<div class="properties-box properties-requirement"><span class="eyebrow">这块内容对应的待补</span><label class="field-label">待补类型<select class="select" data-block-requirement-type data-block-id="${
              selected.id
            }" data-id="${
              selected.requirement_id
            }" data-focus-key="block-requirement-type" title="和「待补」面板、课程地图、待补总览使用同一个类型">${
              REQUIREMENT_TYPES.map((type) =>
                `<option value="${type}" ${
                  requirement.type === type ? "selected" : ""
                }>${requirementTypeLabel(type)}</option>`
              ).join("")
            }</select></label><label class="field-label">待补备注<input class="select" data-requirement-note data-id="${
              selected.requirement_id
            }" value="${esc(requirement.note)}" /></label></div>`
            : ""
        }<div class="modal-actions"><button class="secondary" data-action="delete-block" data-id="${
          selected.id
        }">删除这一块</button><button class="text-button" data-action="clear-block-selection">取消选择</button></div></div>`
        : `<dl class="properties"><dt>编号</dt><dd>${
          esc(lesson.code)
        }</dd><dt>标题</dt><dd>${esc(lesson.title)}</dd><dt>类型</dt><dd>${
          esc(lesson.type)
        }</dd><dt>所属阶段</dt><dd>${
          esc(stage ? stage.title : "未分组")
        }</dd><dt>正文块</dt><dd>${lesson.block_count}</dd><dt>素材</dt><dd>${
          lesson.media_count
        }</dd><dt>当前排版</dt><dd>${
          esc(lesson.layout ? lesson.layout.name : "未设置")
        }</dd><dt>待补</dt><dd>${
          lesson.gaps.total ? `${lesson.gaps.total} 项` : "无"
        }</dd><dt>缺素材</dt><dd>${
          lesson.progress.missing_media || 0
        } 项</dd></dl><p class="side-note">点选一个正文区块后可以在这里改类型和内容。</p>`
    }`;
  }

  function versionsPanel() {
    const snapshots = (store.snapshotRows || []).filter((snapshot) => snapshot.status === "available");
    return `<div class="side-head"><div><span class="eyebrow">安全恢复</span><h2>版本历史</h2></div><button class="icon-button" data-action="save-version" aria-label="保存版本" title="保存版本">＋</button></div><p class="side-note">恢复旧版本前会自动保留“恢复前备份”。</p>${
      snapshots.slice(0, 4).map((snapshot) =>
        `<button class="side-item" data-action="restore-version" data-id="${
          snapshot.id
        }"><span class="version-icon">◷</span><span><b>${
          esc(snapshot.name)
        }</b><small>${esc(snapshot.note || "查看版本")}</small></span></button>`
      ).join("")
    }`;
  }

  function statusbarView(item) {
    // The status bar renders before a lesson is selected (empty course, course
    // map, launcher), so it must never assume a current item.
    const view = item ? lessonView(store.data, item.id) : null;
    if (!item || !view) {
      return `<footer class="statusbar" data-chrome-statusbar><span class="status-code">未选择课程</span><span>课程地图可进入任意一课</span><span class="status-spacer"></span><span>本地优先 · 自动保存</span></footer>`;
    }
    const completion = view.progress;
    const gaps = view.lesson.gaps;
    const parts = [];
    if (gaps.by_type.text) parts.push(`文字：缺 ${gaps.by_type.text} 段`);
    if (gaps.by_type.image) parts.push(`图片：缺 ${gaps.by_type.image} 张`);
    if (gaps.by_type.gif) parts.push(`GIF：缺 ${gaps.by_type.gif} 个`);
    if (gaps.by_type.video) parts.push(`视频：缺 ${gaps.by_type.video} 个`);
    if (completion.missing_media) {
      parts.push(`素材缺失：${completion.missing_media}`);
    }
    return `<footer class="statusbar" data-chrome-statusbar><span class="status-code">${
      esc(item.code)
    }｜${esc(item.title)}</span><span>正文：${
      esc(view.lesson.content_status || "待研究")
    }</span><span>${parts.length ? esc(parts.join(" · ")) : "待补：已齐"}</span><span>排版：${
      esc(view.lesson.layout ? (view.lesson.layout.mode === "flow" ? "Flow" : "Grid") : "未开始")
    }</span><span>完成度：${
      completion.complete ? "已完成" : `${completion.percentage}%`
    }</span><span class="status-spacer"></span><span>本地优先 · 自动保存</span></footer>`;
  }

  /* ------------------------------------------------------------ overlays */

  /**
   * §3.2 Case C: the folder does have a project.json, but Workbench cannot use
   * it. The first actionable failure is visible without a click, "查看具体问题"
   * reveals the raw field paths, and re-importing is offered twice — once to ask,
   * once to confirm — because the existing file is never replaced silently.
   */
  function projectProblemModal(esc) {
    const problem = store.ui.projectProblem;
    if (!problem) return "";
    const detail = problem.problem || {};
    if (problem.status === "locked" || detail.code === "project_locked") {
      return `<div class="overlay"><section class="conflict-modal modal project-problem-modal project-lock-modal" role="dialog" aria-modal="true" aria-labelledby="project-lock-title" aria-describedby="project-lock-description" tabindex="-1" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">项目正在使用</span><h2 id="project-lock-title">这个项目暂时无法打开</h2></div></div><p class="muted" id="project-lock-description">${esc(detail.message || "该项目已在另一窗口或进程中编辑。为避免覆盖，Workbench 没有接管项目锁，也没有修改项目内容。")}</p><div class="project-lock-details"><span>项目文件夹</span><code title="${esc(problem.dir || "")}">${esc(problem.dir || "未知位置")}</code></div><p class="small muted">关闭正在编辑这个项目的其他窗口后，可以安全重试；如果它仍在使用，请返回当前项目或项目列表。</p><div class="modal-actions"><button class="secondary" data-action="dismiss-project-problem">返回</button><button class="primary" data-action="retry-locked-project">重试打开</button></div></section></div>`;
    }
    const headline = detail.code === "unsupported_schema"
      ? "这个项目由更高版本的 Workbench 创建。"
      : "检测到 project.json，但项目数据无法通过校验。";
    const statusCopy = problem.status === "malformed_json"
      ? "文件存在但无法解析，可能已损坏。"
      : problem.status === "unreadable"
      ? "文件存在，但 Workbench 无法读取它。"
      : "";
    const versionCopy = detail.code === "unsupported_schema" && problem.supportedSchemaVersion
      ? `当前版本支持到 ${esc(String(problem.supportedSchemaVersion))}。`
      : "";
    const confirm = problem.confirmReimport;
    // A newer project is not a broken one: re-importing it would move the user's
    // own file aside for nothing, so the only honest next step is 返回 + upgrade.
    const tooNew = detail.code === "unsupported_schema";
    return `<div class="overlay"><div class="conflict-modal modal project-problem-modal" role="dialog" aria-modal="true" aria-labelledby="project-problem-title" tabindex="-1" data-stop-click="true">
      <div class="modal-head"><div><span class="eyebrow">打开项目未完成</span><h2 id="project-problem-title">${esc(headline)}</h2></div></div>
      <p class="muted">${esc([statusCopy, detail.message || "项目内容无法载入。", versionCopy].filter(Boolean).join(" "))}</p>
      <p class="small muted">${tooNew
        ? "当前版本不会改写这个文件。请使用创建该项目的 Workbench 版本打开。"
        : confirm
        ? "导入会把原来的 project.json 完整保留为一个带时间戳的备份文件（不会删除），然后按普通资料文件夹重新扫描、映射。"
        : "你可以返回并修改这个文件，也可以把它当作普通资料文件夹重新导入。重新导入不会覆盖原来的 project.json。"}</p>
      <details class="diagnostic"><summary>查看具体问题</summary><div class="project-problem-detail">
        <p><b>${esc(detail.path || "project.json")}</b></p>
        <p>期望：${esc(detail.expected || "可载入的课程项目")}</p>
        <p>实际：${esc(detail.actual || "无法载入")}</p>
        <p>状态码：${esc(detail.code || problem.status || "unknown")}</p>
        <p class="project-problem-path">${esc(problem.dir || "")}</p>
      </div></details>
      <div class="modal-actions">${tooNew
        ? `<button class="primary" data-action="dismiss-project-problem">返回</button>`
        : confirm
        ? `<button class="secondary" data-action="dismiss-project-problem">返回</button><button class="primary danger" data-action="confirm-reimport-project-folder">确认重新导入</button>`
        : `<button class="secondary" data-action="dismiss-project-problem">返回</button><button class="secondary" data-action="reimport-project-folder">作为普通资料文件夹重新导入</button>`}</div>
    </div></div>`;
  }

  function overlayView(esc) {
    const projectProblem = projectProblemModal(esc);
    if (projectProblem) return projectProblem;
    const registryCopy = registryCopyModal(esc);
    if (registryCopy) return registryCopy;
    const documentImport = documentImportModalView(esc);
    if (documentImport) return documentImport;
    if (store.ui.pendingDeleteConfirmation) {
      const confirmation = store.ui.pendingDeleteConfirmation;
      return `<div class="overlay" data-action="delete-confirm-cancel"><section class="conflict-modal modal delete-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title" aria-describedby="delete-confirm-description" tabindex="-1" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">确认删除</span><h2 id="delete-confirm-title">${esc(confirmation.title)}</h2></div></div><p class="delete-confirm-impact" id="delete-confirm-description">${esc(confirmation.description)}</p><div class="modal-actions"><button class="secondary" data-action="delete-confirm-cancel">取消</button><button class="primary danger" data-action="delete-confirm-accept">确认删除</button></div></section></div>`;
    }
    if (store.externalConflict) {
      const conflict = store.externalConflict;
      const externalEntries = conflict.external_diff?.entries || [];
      const localEntries = conflict.local_diff?.entries || [];
      const mergeConflicts = conflict.merge?.conflicts || [];
      return `<div class="overlay"><div class="conflict-modal modal" role="dialog" aria-modal="true" aria-labelledby="external-conflict-title" tabindex="-1" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">保存已暂停</span><h2 id="external-conflict-title">课程文件与当前编辑内容存在差异</h2></div></div><p class="muted">为避免覆盖，手动保存和自动保存都已暂停。你可以继续查看；下一步请选择重新载入、自动合并，或在确认后保留本地版本。</p>${
        conflict.inspection_error
          ? `<p class="conflict-error">暂时无法读取磁盘差异。你仍可重新载入，或明确保留本地版本。</p><details class="diagnostic"><summary>显示技术信息</summary><code>${esc(conflict.inspection_error)}</code></details>`
          : ""
      }<div class="conflict-summary"><span>磁盘变化 <b>${
        externalEntries.length
      }</b></span><span>本地变化 <b>${
        localEntries.length
      }</b></span><span>合并冲突 <b>${
        mergeConflicts.length
      }</b></span></div><div class="conflict-list">${
        (mergeConflicts.length ? mergeConflicts : externalEntries).slice(0, 12)
          .map((entry) =>
            `<div><code>${
              esc(entry.path || "课程数据")
            }</code><small>${
              mergeConflicts.length ? "本地与外部都修改了此处" : "磁盘版本已变化"
            }</small></div>`
          ).join("") ||
        `<div><span>课程文件</span><small>文件内容或是否存在发生变化</small></div>`
      }</div><div class="modal-actions"><button class="secondary" data-action="external-reload">重新载入磁盘版本</button><button class="secondary" data-action="external-merge">预览并自动合并</button>${
        mergeConflicts.length
          ? `<button class="primary danger" data-action="external-keep-local">明确保留本地版本</button>`
          : ""
      }</div></div></div>`;
    }
    if (store.pendingRecovery) {
      const pending = store.pendingRecovery;
      const recoveredBlocks = pending.project?.blocks?.length || 0;
      const savedAt = pending.saved_at
        ? new Date(pending.saved_at).toLocaleString("zh-CN")
        : "未知时间";
      return `<div class="overlay"><div class="conflict-modal modal" role="dialog" aria-modal="true" aria-labelledby="recovery-title" tabindex="-1" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">恢复</span><h2 id="recovery-title">发现未完成的保存</h2></div></div><p class="muted">上次保存没有完成，磁盘版本没有改变。暂存内容来自 ${esc(savedAt)}，包含 ${recoveredBlocks} 个正文区块。请选择恢复暂存内容，或保留磁盘版本继续工作。</p><div class="modal-actions"><button class="secondary" data-action="recovery-discard">保留磁盘版本</button><button class="primary" data-action="recovery-restore">恢复暂存内容</button></div></div></div>`;
    }
    if (store.ui.editingAssetId) {
      const asset = store.data.assets.find((candidate) =>
        candidate.id === store.ui.editingAssetId && !candidate.archived
      );
      if (asset) {
        const value = store.ui.assetRenameValue ?? asset.filename;
        const error = String(store.ui.assetRenameError || "");
        return `<div class="overlay"><section class="conflict-modal modal asset-rename-modal" role="dialog" aria-modal="true" aria-labelledby="asset-rename-title" aria-describedby="asset-rename-description${error ? " asset-rename-error" : ""}" tabindex="-1" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">媒体库 · ${esc(assetLabel(asset.type))}</span><h2 id="asset-rename-title">重命名素材文件</h2></div></div><p class="small muted">当前文件：<b>${esc(asset.filename)}</b></p><label class="field-label" for="asset-rename-input">新文件名<input id="asset-rename-input" class="select asset-rename-input" data-asset-title data-focus-key="asset-title" data-id="${asset.id}" aria-describedby="asset-rename-description${error ? " asset-rename-error" : ""}" value="${esc(value)}" autocomplete="off" /></label><p class="small muted" id="asset-rename-description">这会重命名项目 assets 文件夹里的托管文件，并同步更新正文引用；素材内容与身份保持不变。原有扩展名会保留。</p>${error ? `<p class="form-error" id="asset-rename-error" role="alert">${esc(error)}</p>` : ""}${store.uncertainMutation ? `<div class="modal-actions"><button class="secondary" data-action="verify-save-result" ${store.uncertainMutationPending ? "disabled" : ""}>${store.uncertainMutationPending ? "正在核验…" : "核验磁盘结果"}</button></div>` : ""}<div class="modal-actions"><button class="secondary" data-action="cancel-rename-asset">取消</button><button class="primary" data-action="confirm-rename-asset" data-id="${asset.id}">保存新文件名</button></div></section></div>`;
      }
    }
    if (store.ui.assetImagePreviewId) {
      const asset = store.data.assets.find((candidate) =>
        candidate.id === store.ui.assetImagePreviewId
      );
      const label = asset?.title || asset?.filename || "素材";
      // The frame is what a settled preview rewrites while this modal is open,
      // instead of rebuilding the whole window behind it (§12.4).
      const content = !asset
        ? `<p class="preview-media-failed">素材当前不可用。</p>`
        : asset.type === "video" && store.ui.assetImagePreviewLoading
        ? `<p class="preview-placeholder" role="status">正在准备视频预览…</p>`
        : asset.type === "video" && store.ui.assetImagePreviewError
        ? `<p class="preview-media-failed" role="alert">${esc(store.ui.assetImagePreviewError)}</p>`
        : previewFrame(asset, "overlay", overlayMediaBody(asset))
      return `<div class="overlay" data-action="close-overlay"><div class="image-preview-modal modal asset-media-preview-modal" role="dialog" aria-modal="true" aria-label="媒体预览：${esc(label)}" data-stop-click="true" style="max-height:84vh;overflow:auto;padding:18px;width:min(92vw,1200px)"><div class="modal-head"><div><span class="eyebrow">媒体预览</span><h2>${esc(label)}</h2></div><button type="button" class="icon-button" data-action="close-overlay" aria-label="关闭媒体预览" title="关闭媒体预览">×</button></div>${content}</div></div>`;
    }
    if (store.ui.assetPicker) {
      const target = store.ui.assetPicker;
      const assets = store.data.assets.filter((asset) => !asset.archived);
      const context = target.blockId
        ? "链接到指定的正文区块"
        : target.requirementId
        ? "用素材完成这条待补"
        : store.ui.selectedBlockId
        ? "插入到当前选中区块之后"
        : "追加到当前课末尾";
      return `<div class="overlay" data-action="close-overlay"><div class="asset-picker modal" role="dialog" aria-modal="true" aria-labelledby="asset-picker-title" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">MEDIA PICKER</span><h2 id="asset-picker-title">选择素材</h2></div><button class="icon-button" data-action="close-overlay" aria-label="关闭素材选择" title="关闭素材选择">×</button></div><p class="muted">${context}。选择后会建立真实引用，可以在媒体库看到使用位置。</p>${
        assets.length
          ? `<div class="picker-grid">${
            assets.map((asset) =>
              `<button class="picker-card" data-action="choose-asset" data-id="${
                asset.id
              }"><span class="picker-thumb">${
                previewFrame(asset, "thumb", assetThumb(asset))
              }</span><b>${
                esc(asset.filename)
              }</b><small>${esc(assetLabel(asset.type))}</small></button>`
            ).join("")
          }</div>`
          : `<div class="side-empty">媒体库还没有素材。<button class="text-button" data-action="pick-asset-import">现在导入</button></div>`
      }</div></div>`;
    }
    if (store.ui.palette) {
      return `<div class="overlay" data-action="close-overlay"><div class="palette modal" role="dialog" aria-modal="true" aria-label="搜索课程、素材和命令" data-stop-click="true"><div class="palette-input"><span aria-hidden="true">⌕</span><input autofocus data-palette-input data-focus-key="palette" aria-label="搜索课程、素材和命令" placeholder="搜索课程、素材、命令……" /></div><div class="palette-results">${
        paletteResults("")
      }</div><div class="palette-hint"><kbd>↑↓</kbd> 选择 <kbd>↵</kbd> 打开 <kbd>Esc</kbd> 关闭</div></div></div>`;
    }
    if (store.ui.capture) {
      return `<div class="overlay" data-action="close-overlay"><div class="capture modal" role="dialog" aria-modal="true" aria-labelledby="quick-capture-title" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">QUICK CAPTURE</span><h2 id="quick-capture-title">快速收集</h2></div><button class="icon-button" data-action="close-overlay" aria-label="关闭快速收集" title="关闭快速收集">×</button></div><textarea autofocus data-capture-input data-focus-key="capture" placeholder="写点什么，或粘贴网页链接……"></textarea><label class="field-label">放入<select class="select"><option>${
        esc(store.data.project.title)
      }</option></select></label><div class="modal-actions"><button class="secondary" data-action="close-overlay">取消</button><button class="primary" data-action="submit-capture">放入收件箱</button></div></div></div>`;
    }
    if (store.ui.preflight && store.ui.route !== "publish") {
      const report = store.ui.preflightReport || store.exportPreflight();
      const issues = Array.isArray(report.issues) ? report.issues : [];
      const formatNames = { markdown: "Markdown", html: "Semantic HTML", web: "Static Web Package", pdf: "PDF", pptx: "PowerPoint", wechat: "微信 / 富文本", json: "Project JSON", asset_package: "素材包", full_project: "完整项目包" };
      const warningIssues = issues.filter((issue) => issue.severity === "warning" && issue.code);
      const requiredCodes = new Set(warningIssues.map((issue) => issue.code));
      const acknowledged = new Set(store.ui.acknowledgedWarnings || []);
      const allWarningsAcknowledged = [...requiredCodes].every((code) => acknowledged.has(code)) && !(report.warnings > 0 && !requiredCodes.size);
      return `<div class="overlay" data-action="close-overlay"><div class="preflight modal" role="dialog" aria-modal="true" aria-labelledby="publish-preflight-title" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">导出前检查</span><h2 id="publish-preflight-title">导出前检查</h2></div><button class="icon-button" data-action="close-overlay" aria-label="关闭导出前检查" title="关闭导出前检查">×</button></div><p><b>${store.ui.publishScope === "course" ? "整门课程" : "当前课"}</b> → <b>${esc(formatNames[store.ui.publishFormat] || store.ui.publishFormat)}</b></p><p class="muted">先检查课程内容和素材。标为“必须修复”的问题会阻止导出；每项提示都需要你明确确认。检查不会修改课程，也不会调用 AI。</p><div class="check-list">${[
        ["内容级待补", report.content, false],
        ["当前排版待补", report.layout, false],
        ["缺失素材文件", report.missingAssets, true],
        ["超出画布", report.overflow, true],
        ["空正文 / 文字提醒", report.text, false],
        ["未加载字体", report.fonts, false],
        ["外部引用", report.external, false],
        ["媒体降级", report.mediaDowngrades || 0, false],
      ].map(([label, count, blocking]) => `<div><span class="check ${count ? blocking ? "danger" : "warning" : "ok"}">${count || "✓"}</span><span>${label}</span><b>${count}</b></div>`).join("")}</div>${issues.length ? `<div class="issue-list">${issues.map((issue) => `<article class="${issue.severity === "blocking" ? "issue-blocking" : "issue-warning"}"><b>${issue.severity === "blocking" ? "必须修复" : "提示"}</b><span>${esc(issueMessage(issue))}</span>${issueDiagnostics(issue)}</article>`).join("")}</div>` : ""}${warningIssues.length ? `<div class="warning-ack-list"><b>逐项确认本次输出提示</b>${warningIssues.map((issue) => `<label><input type="checkbox" data-action="acknowledge-export-warning" data-code="${esc(issue.code)}" ${acknowledged.has(issue.code) ? "checked" : ""}/><span>${esc(issueMessage(issue))}${issue.count > 1 ? `（${issue.count} 项）` : ""}</span></label>`).join("")}</div>` : ""}<div class="preflight-total">必须修复 <strong>${report.blocking}</strong> · 提示 <strong>${report.warnings}</strong></div>${report.blocking ? `<p class="error-text">当前不能导出：请先修复上面标为“必须修复”的问题。不会生成半成品，也不会修改源课程。</p>` : report.warnings ? `<p class="muted">仅在勾选确认全部提示后才会继续生成；未放置正文、线性化或媒体降级会按上方说明处理。</p>` : `<p class="success-text">检查通过，可以生成输出；源课程不会被修改。</p>`}<div class="modal-actions"><button class="secondary" data-action="close-overlay">返回继续修复</button><button class="primary" data-action="export-format" data-format="${esc(store.ui.publishFormat)}" ${report.blocking || !allWarningsAcknowledged ? "disabled" : ""}>${report.warnings ? "确认提示并导出" : "开始导出"}</button></div></div></div>`;
    }
    if (store.ui.snapshot) {
      return `<div class="overlay" data-action="close-overlay"><div class="capture modal" role="dialog" aria-modal="true" aria-labelledby="save-version-title" aria-busy="${store.snapshotSaving}" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">长期历史</span><h2 id="save-version-title">保存版本</h2></div><button class="icon-button" data-action="close-overlay" aria-label="关闭保存版本" title="关闭保存版本">×</button></div><label class="field-label">版本名称<input data-snapshot-name data-focus-key="snapshot-name" value="${esc(store.snapshotName)}" placeholder="例如：第一课正文定稿" /></label><label class="field-label">备注<textarea data-snapshot-note data-focus-key="snapshot-note" placeholder="记录这个节点为什么重要">${esc(store.snapshotNote)}</textarea></label>${store.snapshotError ? `<p class="error-text" role="alert">${esc(store.snapshotError)}</p>` : store.snapshotSaving ? `<p class="muted" role="status">正在写入并确认历史版本…</p>` : ""}<div class="modal-actions"><button class="secondary" data-action="close-overlay">取消</button><button class="primary" data-action="submit-snapshot" ${store.snapshotSaving ? "disabled" : ""}>${store.snapshotSaving ? "正在保存…" : store.snapshotError ? "重试保存" : "保存版本"}</button></div></div></div>`;
    }
    if (store.ui.aiSettingsOpen) {
      const choices = aiProviderChoices();
      const configured = aiConfiguredMap();
      const editableChoices = choices.filter((choice) => choice.kind !== "openai_chatgpt_subscription" && !aiIsOfflineConnection(choice));
      const form = store.ui.aiProviderForm;
      // A brand-new connection exists only as form state (§9.4): it is not in
      // `ai.connection.list` yet, so the editor renders from the form itself.
      const formDescriptor = form
        ? editableChoices.find((choice) => choice.id === String(form.id || "").trim()) ||
          (form.isNew === true ? form : null)
        : null;
      return `<div class="overlay ai-settings-overlay" data-action="ai-settings-backdrop"><section class="modal ai-settings-modal" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title" data-stop-click="true"><header class="modal-head"><div><span class="eyebrow">应用设置 · 模型</span><h2 id="ai-settings-title">AI 模型</h2></div><button class="icon-button" data-action="ai-close-settings" aria-label="关闭设置" title="关闭设置">×</button></header><p class="muted">设置连接、协议、模型与本机凭据。配置保存、模型发现和连接测试分别显示状态。</p>${formDescriptor ? aiProviderFormView(formDescriptor, configured) : ""}${aiConnectionManagerView(choices, configured)}${aiSubscriptionSettingsView(store, configured)}${formDescriptor ? "" : `<p class="ai-hint">选择一个 API 连接进行管理，或新建连接。</p>`}<div class="ai-settings-foot"><span>AI 配置仅保存连接元数据；密钥和订阅令牌写入${esc(store.aiStorageLabel ? store.aiStorageLabel() : "本机系统钥匙串")}，课程文件不含凭据。</span><button class="secondary" data-action="ai-close-settings">完成</button></div></section></div>`;
    }
    return "";
  }

  function paletteResults(query) {
    const q = String(query).toLowerCase();
    const results = [];
    for (const lesson of courseMap(store.data, store.ui.activeId).lessons) {
      if (
        !q ||
        `${lesson.code}${lesson.title}`.toLowerCase().includes(q)
      ) {
        results.push({
          type: "课程",
          label: `${lesson.code}｜${lesson.title}`,
          action: "open-item",
          id: lesson.id,
        });
      }
    }
    for (const asset of store.data.assets) {
      if (!q || asset.filename.toLowerCase().includes(q)) {
        results.push({
          type: "素材",
          label: asset.filename,
          action: "route",
          route: "media",
        });
      }
    }
    for (const entry of requirementBacklog(store.data).entries) {
      if (
        q &&
        `${entry.lesson_code}${entry.lesson_title}${entry.note}`.toLowerCase()
          .includes(q)
      ) {
        results.push({
          type: "待补",
          label: `${entry.lesson_code}｜${entry.note || entry.type}`,
          action: "focus-requirement",
          id: entry.id,
        });
      }
    }
    for (
      const [label, route] of [
        ["打开工作台", "workbench"],
        ["打开课程地图", "map"],
        ["打开资源浏览器", "explorer"],
        ["打开映射预览", "mapping"],
        ["打开收件箱", "inbox"],
        ["打开制作看板", "board"],
        ["打开待补总览", "backlog"],
        ["打开媒体库", "media"],
        ["打开版本历史", "versions"],
        ["保存版本", "save-version"],
        ["快速收集", "capture"],
        ["显示所有缺素材的课", "missing-media"],
      ]
    ) {
      if (!q || label.toLowerCase().includes(q)) {
        results.push({
          type: "命令",
          label,
          action: route === "save-version" || route === "capture"
            ? route
            : route === "missing-media"
            ? "missing-media"
            : route === "workbench"
            ? "open-workbench"
            : route === "mapping"
            ? "open-import-mapping"
            : "route",
          route: route,
        });
      }
    }
    return results.slice(0, 10).map((result, index) =>
      `<button class="palette-result ${
        index === store.ui.paletteIndex ? "selected" : ""
      }" data-action="palette-run" data-palette-action="${
        result.action
      }" data-id="${result.id || ""}" data-route="${
        result.route || ""
      }"><span class="result-type">${result.type}</span><b>${
        esc(result.label)
      }</b><span>↵</span></button>`
    ).join("") || `<div class="no-results">没有找到匹配内容。换一个关键词，或按 Esc 关闭搜索。</div>`;
  }

  function toastView(esc) {
    return store.ui.toast
      ? `<div class="toast" role="status">${
        esc(store.ui.toast)
      }<button class="icon-button" data-action="clear-toast" aria-label="关闭提示">×</button></div>`
      : "";
  }

  return {
    launcherView: launcher,
    shellView,
    overlayView: overlay,
    toastView: toast,
    statusbarView: () => statusbarView(store.currentItem()),
    saveStateView,
    paletteResults,
    assetPreviewFrameInner,
    mappingRowView,
  };
}
