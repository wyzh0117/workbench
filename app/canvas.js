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

export function stopPreviewMedia(scope = globalThis.document) {
  const media = scope?.matches?.("audio,video")
    ? [scope]
    : Array.from(scope?.querySelectorAll?.("audio,video") || []);
  for (const element of media) {
    try { element.pause(); } catch { /* media may already be detached */ }
    try { element.currentTime = 0; } catch { /* metadata may not be loaded */ }
    element.removeAttribute?.("src");
    try { element.load(); } catch { /* detached media cannot be reloaded */ }
  }
  return media.length;
}

/**
 * Bounded preview cache.
 *
 * Asset bytes are read only for assets the canonical project references, are
 * cached per project, asset identity, and content checksum, and are never
 * written back anywhere. Webviews cannot read project paths directly, so
 * media uses temporary object URLs allowed by the app's narrowly scoped CSP.
 */
export class AssetPreviewCache {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.mediaLimit = options.mediaLimit ?? 8 * BYTES_PER_MEGABYTE;
    this.maxCacheBytes = options.maxCacheBytes ?? 96 * BYTES_PER_MEGABYTE;
    this.maxEntries = options.maxEntries ?? 32;
    this.maxConcurrentLoads = options.maxConcurrentLoads ?? 2;
    this.activeLoads = 0;
    this.loadQueue = [];
    this.entries = new Map();
    this.pending = new Map();
    this.assetsByKey = new Map();
    this.observedElements = new Set();
    this.intersectionObserver = null;
    this.cacheBytes = 0;
    this.generation = 0;
    this.failures = 0;
    this.urls = new Set();
    this.onChange = options.onChange ?? (() => {});
    this.notifyScheduled = false;
  }

  /** @returns {{url?: string, text?: string, failed?: boolean, error?: string, loading?: boolean, pending?: boolean, key?: string}|undefined} */
  get(assetId, assetSnapshot = null) {
    if (!assetId) return undefined;
    const asset = assetSnapshot || this.findAsset(assetId);
    if (!asset || asset.archived) return undefined;
    const key = this.keyFor(asset);
    const cached = this.entries.get(key);
    if (cached) {
      // Map insertion order is the small LRU: recently used previews move to
      // the end, so scrolling through a large library cannot grow memory.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.value;
    }
    this.assetsByKey.set(key, asset);
    return { loading: true, pending: this.pending.has(key), key };
  }

  retry(assetId) {
    const asset = this.findAsset(assetId);
    if (!asset || asset.archived) return;
    const key = this.keyFor(asset);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const cached = this.entries.get(key);
    if (cached && !cached.value.failed) return;
    if (cached) {
      this.entries.delete(key);
      this.cacheBytes = Math.max(0, this.cacheBytes - cached.size);
      this.releaseEntry(cached.value);
    }
    this.assetsByKey.set(key, asset);
    const task = this.load(asset, key);
    this.scheduleNotify();
    return task;
  }

  observe(root) {
    if (!root?.querySelectorAll) return;
    const placeholders = [...root.querySelectorAll(
      "[data-asset-preview-key]",
    )];
    const activeKeys = new Set(placeholders.map((element) =>
      element.getAttribute("data-asset-preview-key") || ""
    ).filter(Boolean));

    for (const [key, asset] of this.assetsByKey) {
      if (!activeKeys.has(key) && !this.pending.has(key)) {
        this.assetsByKey.delete(key);
      } else if (activeKeys.has(key)) {
        const current = this.findAsset(asset.id);
        if (current) this.assetsByKey.set(key, current);
      }
    }

    if (typeof IntersectionObserver !== "function") {
      for (const key of activeKeys) void this.loadByKey(key);
      return;
    }
    if (!this.intersectionObserver) {
      this.intersectionObserver = new IntersectionObserver((records) => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          const key = record.target.getAttribute("data-asset-preview-key");
          this.intersectionObserver.unobserve(record.target);
          this.observedElements.delete(record.target);
          if (key) void this.loadByKey(key);
        }
      }, { rootMargin: "160px" });
    }
    for (const element of this.observedElements) {
      if (element.isConnected) continue;
      this.intersectionObserver.unobserve(element);
      this.observedElements.delete(element);
    }
    for (const element of placeholders) {
      const key = element.getAttribute("data-asset-preview-key");
      if (!key || this.entries.has(key) || this.pending.has(key) ||
        this.observedElements.has(element)) continue;
      this.observedElements.add(element);
      this.intersectionObserver.observe(element);
    }
  }

  loadByKey(key) {
    const asset = this.assetsByKey.get(key);
    if (asset && !this.entries.has(key) && !this.pending.has(key)) {
      void this.load(asset, key);
    }
  }

  isLoading(assetId) {
    const asset = this.findAsset(assetId);
    return Boolean(asset && this.pending.has(this.keyFor(asset)));
  }

  setOnChange(listener) {
    this.onChange = listener;
  }

  acquireLoadSlot(generation) {
    if (generation !== this.generation) return Promise.resolve(false);
    if (this.activeLoads < this.maxConcurrentLoads) {
      this.activeLoads += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.loadQueue.push({ generation, resolve });
    });
  }

  releaseLoadSlot() {
    this.activeLoads = Math.max(0, this.activeLoads - 1);
    while (this.loadQueue.length && this.activeLoads < this.maxConcurrentLoads) {
      const waiter = this.loadQueue.shift();
      if (waiter.generation !== this.generation) {
        waiter.resolve(false);
        continue;
      }
      this.activeLoads += 1;
      waiter.resolve(true);
    }
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

  keyFor(asset) {
    return JSON.stringify([
      asset.project_id || "",
      asset.id,
      asset.storage_path || "",
      asset.file_size ?? null,
      asset.checksum || "",
      asset.mime_type || "",
      asset.type || "",
    ]);
  }

  async load(assetOrId, knownKey = null) {
    const asset = typeof assetOrId === "object" && assetOrId
      ? assetOrId
      : this.findAsset(assetOrId);
    if (!asset || asset.archived) return;
    const assetId = asset.id;
    const key = knownKey || this.keyFor(asset);
    if (this.entries.has(key) || this.pending.has(key)) return;
    const current = this.findAsset(assetId);
    if (!current || current.archived || this.keyFor(current) !== key) return;
    const generation = this.generation;
    const task = (async () => {
      const acquired = await this.acquireLoadSlot(generation);
      if (!acquired) return;
      let entry;
      let sourceRelease = null;
      const ownedUrls = [];
      const keepUrl = (url) => {
        this.trackUrl({ url });
        if (url) ownedUrls.push(url);
        return url;
      };
      try {
        let bytes = null;
        let source = null;
        if (asset.type === "video") {
          if (!String(asset.mime_type || "").toLowerCase().startsWith("video/")) {
            throw new Error("素材类型与视频文件格式不匹配");
          }
          source = await this.bridge.previewAssetVideoSource(assetId);
          sourceRelease = source?.release || null;
        } else {
          bytes = await this.bridge.readAssetBytes(assetId, this.mediaLimit);
        }
        // Project switches and content edits invalidate reads already in
        // flight. Never let their late response repopulate the new cache.
        const current = this.findAsset(assetId);
        if (generation !== this.generation || !current ||
          this.keyFor(current) !== key) {
          try { sourceRelease?.(); } catch { /* source token may already be gone */ }
          sourceRelease = null;
          return;
        }
        if (source) {
          const frame = await decodeVideoFrame(source.url);
          if (frame.posterUrl) keepUrl(frame.posterUrl);
          entry = { url: source.url, ...frame, release: sourceRelease, loaded: true };
          sourceRelease = null;
        } else if (!bytes || bytes.length === 0) {
          entry = {
            failed: true,
            error: "素材文件为空",
          };
        } else if (bytes.length > this.mediaLimit) {
          entry = {
            failed: true,
            error: `素材超过单文件预览上限（${this.mediaLimit / BYTES_PER_MEGABYTE} MiB）`,
          };
        } else if (isTextAsset(asset)) {
          const text = new TextDecoder().decode(bytes);
          entry = { text, loaded: true };
        } else if (asset.type === "image" || asset.type === "gif") {
          if (!String(asset.mime_type || "").toLowerCase().startsWith("image/")) {
            throw new Error("素材类型与图片文件格式不匹配");
          }
          const url = keepUrl(urlForBytes(bytes, asset));
          const image = await loadImage(url);
          const thumbnailUrl = asset.type === "gif"
            ? keepUrl(await staticImagePoster(bytes, asset.mime_type))
            : keepUrl(await posterFromImage(image).catch(() => null));
          entry = {
            url,
            thumbnailUrl,
            width: image.naturalWidth,
            height: image.naturalHeight,
            loaded: true,
          };
        } else if (asset.type === "video") {
          entry = { failed: true, error: "视频来源不可用" };
        } else if (asset.type === "audio") {
          if (!String(asset.mime_type || "").toLowerCase().startsWith("audio/")) {
            throw new Error("素材类型与音频文件格式不匹配");
          }
          const url = keepUrl(urlForBytes(bytes, asset));
          const metadata = await decodeAudioMetadata(url);
          entry = { url, ...metadata, loaded: true };
        } else if (isPdfAsset(asset)) {
          if (!looksLikePdf(bytes)) {
            throw new Error("PDF 文件内容无效或不完整，无法显示第一页");
          }
          const url = keepUrl(urlForBytes(bytes, {
            ...asset,
            mime_type: "application/pdf",
          }));
          entry = { url, pdf: true, loaded: true };
        } else {
          // Documents such as DOCX remain reference attachments unless a
          // native thumbnail provider is available. Do not decode them as
          // editable body text.
          entry = { loaded: true };
        }
        const latest = this.findAsset(assetId);
        if (generation !== this.generation || !latest ||
          this.keyFor(latest) !== key) {
          this.releaseEntry(entry);
          return;
        }
        this.cache(key, entry, bytes?.byteLength || 0);
      } catch (error) {
        for (const url of ownedUrls) this.releaseEntry({ url });
        try { sourceRelease?.(); } catch { /* source token may already be gone */ }
        sourceRelease = null;
        if (generation !== this.generation) return;
        this.failures += 1;
        entry = {
          failed: true,
          error: error?.message || "素材不可读",
        };
        this.cache(key, entry, 0);
      } finally {
        this.releaseLoadSlot();
        if (generation === this.generation) {
          this.pending.delete(key);
          this.assetsByKey.delete(key);
          this.scheduleNotify();
        }
      }
    })();
    this.pending.set(key, task);
    await task;
  }

  cache(key, value, size) {
    this.entries.set(key, { value, size });
    this.cacheBytes += size;
    while (this.entries.size > this.maxEntries ||
      this.cacheBytes > this.maxCacheBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.cacheBytes -= oldest.size;
      this.releaseEntry(oldest.value);
    }
  }

  trackUrl(entry) {
    if (entry && typeof entry.url === "string" && entry.url.startsWith("blob:")) {
      this.urls.add(entry.url);
    }
  }

  releaseEntry(entry) {
    try { entry?.release?.(); } catch { /* source token may already be gone */ }
    for (const url of [entry?.url, entry?.posterUrl, entry?.thumbnailUrl]) {
      if (typeof url !== "string" || !url.startsWith("blob:")) continue;
      this.urls.delete(url);
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Revoking an already-released URL must never break the workbench.
      }
    }
  }

  findAsset(assetId) {
    const data = this.bridge.currentProject?.();
    if (!data || !Array.isArray(data.assets)) return null;
    return data.assets.find((candidate) => candidate.id === assetId) || null;
  }

  clear() {
    stopPreviewMedia(globalThis.document);
    this.generation += 1;
    for (const waiter of this.loadQueue.splice(0)) waiter.resolve(false);
    for (const cached of this.entries.values()) this.releaseEntry(cached.value);
    for (const url of this.urls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Revoking an already-released URL must never break the workbench.
      }
    }
    this.urls.clear();
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    this.observedElements.clear();
    this.entries.clear();
    this.pending.clear();
    this.assetsByKey.clear();
    this.cacheBytes = 0;
  }
}

function isTextAsset(asset) {
  const mime = String(asset.mime_type || "");
  return mime.startsWith("text/") || /\.(md|markdown|txt|csv|json)$/i.test(
    String(asset.filename || ""),
  );
}

function isPdfAsset(asset) {
  return String(asset.mime_type || "").toLowerCase() === "application/pdf" ||
    /\.pdf$/i.test(String(asset.filename || ""));
}

function looksLikePdf(bytes) {
  if (bytes.length < 16) return false;
  const decoder = new TextDecoder("ascii");
  const header = decoder.decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  const tail = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 1024)));
  return header.includes("%PDF-") && tail.includes("%%EOF");
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    if (typeof Image !== "function") {
      reject(new Error("当前 WebView 无法解码图片"));
      return;
    }
    const image = new Image();
    image.onload = () => image.naturalWidth && image.naturalHeight
      ? resolve(image)
      : reject(new Error("图片没有可显示的画面"));
    image.onerror = () => reject(new Error("图片解码失败，文件可能已损坏"));
    image.src = url;
    if (typeof image.decode === "function") {
      image.decode().then(() => {
        if (image.naturalWidth && image.naturalHeight) resolve(image);
      }).catch(() => reject(new Error("图片解码失败，文件可能已损坏")));
    }
  });
}

function canvasBlob(canvas, mime = "image/png") {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => blob
        ? resolve(blob)
        : reject(new Error("无法生成预览缩略图")), mime);
    } catch {
      reject(new Error("无法生成预览缩略图"));
    }
  });
}

async function posterFromImage(image) {
  if (typeof document === "undefined" || typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function") return null;
  const scale = Math.min(1, 320 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await canvasBlob(canvas);
  return URL.createObjectURL(blob);
}

/** Decode the static default/first frame from encoded animated image bytes. */
export async function staticImagePoster(bytes, mime = "image/gif") {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    throw new Error("当前 WebView 无法生成 GIF 首帧缩略图");
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  try {
    const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法生成 GIF 首帧缩略图");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return URL.createObjectURL(await canvasBlob(canvas));
  } finally {
    bitmap.close();
  }
}

export async function decodeVideoFrame(url) {
  if (typeof document === "undefined") {
    throw new Error("当前 WebView 无法解码视频");
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.crossOrigin = "anonymous";
  return await new Promise((resolve, reject) => {
    let settled = false;
    let captureInFlight = false;
    let frameCallbackId = null;
    let animationFrameId = null;
    let fallbackFrames = 0;
    const supportsVideoFrameCallback =
      typeof video.requestVideoFrameCallback === "function";
    const timeout = setTimeout(() => finish(
      new Error("视频解码超时，未取得可显示画面"),
    ), 15000);
    const cleanup = () => {
      clearTimeout(timeout);
      if (frameCallbackId !== null) {
        video.cancelVideoFrameCallback?.(frameCallbackId);
      }
      if (animationFrameId !== null) {
        globalThis.cancelAnimationFrame?.(animationFrameId);
      }
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("loadeddata", scheduleFallbackFrame);
      video.removeEventListener("seeked", onFrame);
      video.removeEventListener("error", onError);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const onError = () => {
      const code = Number(video.error?.code || 0);
      const reason = {
        1: "读取已取消",
        2: "读取媒体资源失败",
        3: "WebView 无法解码媒体",
        4: "媒体格式或资源协议不受支持",
      }[code] || "媒体读取或解码失败";
      finish(new Error(`${reason}（MediaError ${code || "unknown"}）`));
    };
    const onFrame = async () => {
      if (settled || captureInFlight) return;
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        scheduleFallbackFrame();
        return;
      }
      try {
        const scale = Math.min(
          1,
          320 / Math.max(video.videoWidth, video.videoHeight),
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法生成视频预览缩略图");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let hasVisiblePixel = false;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] !== 0) {
            hasVisiblePixel = true;
            break;
          }
        }
        if (!hasVisiblePixel) {
          scheduleFallbackFrame();
          return;
        }
        captureInFlight = true;
        const blob = await canvasBlob(canvas);
        // A timeout or project switch may settle the request while toBlob is
        // still pending; do not create an unowned URL after cleanup.
        if (settled) return;
        const posterUrl = URL.createObjectURL(blob);
        finish(null, {
          posterUrl,
          durationSeconds: Number.isFinite(video.duration)
            ? video.duration
            : null,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "SecurityError") {
          finish(new Error("视频帧受跨源安全策略阻止，无法生成缩略图（SecurityError）"));
        } else {
          finish(error instanceof Error ? error : new Error("无法生成视频预览缩略图"));
        }
      }
    };
    const scheduleFallbackFrame = () => {
      if (settled || animationFrameId !== null) return;
      if (fallbackFrames >= 30) {
        finish(new Error("WebView 未能合成视频首帧缩略图"));
        return;
      }
      if (typeof globalThis.requestAnimationFrame !== "function") {
        finish(new Error("当前 WebView 无法等待视频画面合成"));
        return;
      }
      fallbackFrames += 1;
      animationFrameId = globalThis.requestAnimationFrame(() => {
        animationFrameId = null;
        void onFrame();
      });
    };
    const onPresentedFrame = () => {
      frameCallbackId = null;
      void onFrame();
    };
    const onMetadata = () => {
      if (video.currentTime !== 0) {
        video.addEventListener("seeked", onFrame, { once: true });
        try { video.currentTime = 0; } catch { /* loadeddata still reports the first decoded frame */ }
      }
    };
    video.addEventListener("loadedmetadata", onMetadata, { once: true });
    if (!supportsVideoFrameCallback) {
      video.addEventListener("loadeddata", scheduleFallbackFrame, { once: true });
    }
    video.addEventListener("error", onError, { once: true });
    // WebKit can fire loadeddata before a video frame is paintable to canvas.
    // Register before loading the source so the callback marks compositor readiness.
    if (supportsVideoFrameCallback) {
      frameCallbackId = video.requestVideoFrameCallback(onPresentedFrame);
    }
    video.src = url;
    video.load();
  });
}

async function decodeAudioMetadata(url) {
  if (typeof document === "undefined") {
    throw new Error("当前 WebView 无法读取音频信息");
  }
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(
      new Error("音频信息读取超时"),
    ), 15000);
    const cleanup = () => {
      clearTimeout(timeout);
      audio.removeEventListener("loadedmetadata", onMetadata);
      audio.removeEventListener("error", onError);
      audio.removeAttribute("src");
      audio.load();
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const onMetadata = () => finish(null, {
      durationSeconds: Number.isFinite(audio.duration) ? audio.duration : null,
    });
    const onError = () => finish(
      new Error("音频无法解码，格式可能不受支持或文件已损坏"),
    );
    audio.addEventListener("loadedmetadata", onMetadata, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.src = url;
    audio.load();
  });
}

function urlForBytes(bytes, asset) {
  const mime = String(asset.mime_type || "application/octet-stream");
  const canInline = typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    (mime.startsWith("image/") || mime.startsWith("video/") ||
      mime.startsWith("audio/") || mime === "application/pdf");
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
 * PDF is an inline preview; DOCX stays "reference" until a real parser exists.
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
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (
    entry.suggested_role === "reference" ||
    /word|document/.test(mime) ||
    /\.(docx?|odt|rtf)$/i.test(name)
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
    pdf: "PDF",
    reference: "DOCX",
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

export function mappingRowClickToggles(target) {
  return Boolean(
    target && typeof target.closest === "function" &&
      !target.closest("input, select, button, a, label, details, summary, .mapping-source-match"),
  );
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
        destination: suggested === "lesson" ? { kind: "unassigned_lesson" } : null,
        markdown_dependency_preview: null,
        markdown_source_match: null,
        allow_duplicate: false,
      };
    })
    .filter((item) => item.relative_path.length > 0);
  for (const item of items) {
    if (item.mapping !== "lesson") continue;
    const hasMappedStageParent = items.some((candidate) =>
      candidate.kind === "directory" && candidate.selected && candidate.mapping === "stage" &&
      item.relative_path.startsWith(`${candidate.relative_path}/`)
    );
    item.destination = hasMappedStageParent ? null : { kind: "unassigned_lesson" };
  }
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
      ? plan.items.map((item) => ({
        ...item,
        destination: item.destination ? { ...item.destination } : null,
        markdown_dependency_preview: item.markdown_dependency_preview
          ? {
            ...item.markdown_dependency_preview,
            counts: { ...item.markdown_dependency_preview.counts },
            images: (item.markdown_dependency_preview.images || []).map((image) => ({ ...image })),
          }
          : null,
        markdown_source_match: item.markdown_source_match ? { ...item.markdown_source_match } : null,
      }))
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
      if (item.selected && item.mapping === "lesson" && /\.(md|markdown)$/i.test(item.relative_path)) {
        item.markdown_dependency_preview = null;
        item.markdown_source_match = null;
        item.allow_duplicate = false;
      }
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
      if (mapping === "lesson") {
        const hasMappedStageParent = next.items.some((candidate) =>
          candidate.kind === "directory" && candidate.selected && candidate.mapping === "stage" &&
          item.relative_path.startsWith(`${candidate.relative_path}/`)
        );
        item.destination = hasMappedStageParent ? null : (item.destination || { kind: "unassigned_lesson" });
      } else {
        item.destination = null;
        item.markdown_dependency_preview = null;
        item.markdown_source_match = null;
        item.allow_duplicate = false;
      }
      break;
    }
  }
  return next;
}

/** Set a lesson destination explicitly; the backend still validates its foreign key. */
export function setImportMappingDestination(plan, relativePath, destination) {
  const path = String(relativePath || "").replaceAll("\\", "/");
  const next = cloneImportMappingPlan(plan);
  next.confirmed = false;
  next.confirmed_at = null;
  for (const item of next.items) {
    if (item.relative_path !== path || item.mapping !== "lesson") continue;
    const value = destination && typeof destination === "object" ? destination : {};
    if (value.kind === "folder_structure") {
      item.destination = null;
    } else if (value.kind === "existing_stage" && typeof value.stage_id === "string") {
      item.destination = { kind: "existing_stage", stage_id: value.stage_id };
    } else if (value.kind === "existing_lesson" && typeof value.content_item_id === "string") {
      item.destination = { kind: "existing_lesson", content_item_id: value.content_item_id };
    } else {
      item.destination = { kind: "unassigned_lesson" };
    }
    break;
  }
  return next;
}

/** Explicitly acknowledge importing a Markdown source match as a new copy. */
export function setImportMappingAllowDuplicate(plan, relativePath, allow) {
  const path = String(relativePath || "").replaceAll("\\", "/");
  const next = cloneImportMappingPlan(plan);
  next.confirmed = false;
  next.confirmed_at = null;
  for (const item of next.items) {
    if (item.relative_path === path && item.mapping === "lesson") {
      item.allow_duplicate = Boolean(allow);
      break;
    }
  }
  return next;
}

/** Summarize refs emitted by the Markdown AST; callers authorize local paths separately. */
export function buildMarkdownDependencyPreview(sourceHash, parsed, statusByHref = {}) {
  const localRefs = new Set(
    (parsed?.explicitLocalImageRefs || []).map((ref) => `${ref.blockIndex}:${ref.tokenIndex}`),
  );
  const images = (parsed?.imageRefs || []).map((ref) => {
    const key = `${ref.blockIndex}:${ref.tokenIndex}`;
    const status = localRefs.has(key)
      ? statusByHref[ref.href]
      : "remote_or_unsafe";
    if (!new Set(["present", "missing", "outside_root", "remote_or_unsafe"]).has(status)) {
      throw new Error(`Markdown图片依赖状态缺失：${ref.href}`);
    }
    return { ...ref, status };
  });
  const counts = {
    total: images.length,
    local_readable: 0,
    missing: 0,
    outside_root: 0,
    remote_or_unsafe: 0,
  };
  for (const image of images) {
    if (image.status === "present") counts.local_readable += 1;
    else if (image.status === "missing") counts.missing += 1;
    else if (image.status === "outside_root") counts.outside_root += 1;
    else counts.remote_or_unsafe += 1;
  }
  return {
    state: "ready",
    source_hash: sourceHash,
    fingerprint: JSON.stringify({ source_hash: sourceHash, images }),
    counts,
    images,
  };
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
