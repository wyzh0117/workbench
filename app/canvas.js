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
 *
 * The state machine a card paints is `idle → loading → ready` and
 * `loading → error`, and it only moves forward: a preview that settled stays
 * settled while its card is in the document. `observe()` registers the painted
 * frames (`[data-asset-preview-key]`), and a frame with a connected element
 * PINS its entry — the entry budget is the painted set plus a bounded history,
 * so scrolling through a large library can no longer evict a card that is still
 * on screen and revoke the object URL its `<img>` is using.
 *
 * A preview that settles is written back through `onPatch`, which repaints that
 * one frame; the whole screen is rebuilt only for a key nothing can patch.
 * That is what breaks the render → observe → load → evict → render loop: a full
 * rebuild destroys every card, the observer re-registers all of them, each new
 * intersect record reads the asset again, and the loop repeats.
 */
function sameFingerprint(left, right) {
  return Boolean(left && right && left.exists === right.exists &&
    left.mtime_ms === right.mtime_ms && left.size === right.size &&
    left.hash === right.hash);
}

function samePreviewContext(left, right) {
  return Boolean(left && right && left.project_id === right.project_id &&
    left.project_dir === right.project_dir &&
    left.lease_generation === right.lease_generation &&
    left.editor_generation === right.editor_generation &&
    sameFingerprint(left.fingerprint, right.fingerprint));
}

function decodePreviewBase64(value, maxBytes) {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    throw new Error("素材批量预览返回了无效或过大的内容");
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new Error("素材批量预览返回了无效的 Base64 内容");
  }
  if (binary.length > maxBytes) throw new Error("素材超过单文件预览上限（8 MiB）");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export class AssetPreviewCache {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.mediaLimit = options.mediaLimit ?? 8 * BYTES_PER_MEGABYTE;
    this.maxCacheBytes = options.maxCacheBytes ?? 96 * BYTES_PER_MEGABYTE;
    /** Entries kept IN ADDITION to the ones currently painted. */
    this.maxEntries = options.maxEntries ?? 32;
    /** Hard ceiling on memory-holding entries, however many cards are painted. */
    this.maxTotalEntries = options.maxTotalEntries ?? 240;
    this.maxConcurrentLoads = options.maxConcurrentLoads ?? 2;
    /** Loads waiting for a slot, so a scroll burst cannot queue doomed reads. */
    this.maxQueuedLoads = options.maxQueuedLoads ?? 32;
    this.activeLoads = 0;
    this.loadQueue = [];
    this.previewBatchQueue = [];
    this.previewBatchScheduled = false;
    this.previewRequestGeneration = 0;
    /** Declined while saturated; retried when a slot frees or dropped if not. */
    this.deferred = new Set();
    this.deferredReasons = new Map();
    this.retryCapacityDeferred = false;
    /** Settled previews dropped by the byte budget while their card was painted. */
    this.released = new Set();
    this.entries = new Map();
    this.pending = new Map();
    /** Per-key write token: a response older than the current attempt is dropped. */
    this.tokens = new Map();
    this.assetsByKey = new Map();
    /** key -> the frame elements currently painting that preview. */
    this.frames = new Map();
    /** Keys painted as of the last `observe()`; null while no DOM is known. */
    this.renderedKeys = null;
    this.observedElements = new Set();
    this.intersectionObserver = null;
    this.cacheBytes = 0;
    this.generation = 0;
    /** Monotonic clock behind eviction order; advanced by visibility, not reads. */
    this.useClock = 0;
    this.failures = 0;
    this.urls = new Set();
    this.onChange = options.onChange ?? (() => {});
    this.onPatch = options.onPatch ?? null;
    this.notifyScheduled = false;
  }

  /**
   * @param {string} assetId
   * @param {{archived?: boolean, project_id?: string, storage_path?: string,
   *   checksum?: string}|null} [assetSnapshot] the row as the caller renders it,
   *   so a hot grid does not have to look it up again.
   * @returns {{url?: string, thumbnailUrl?: string, posterUrl?: string,
   *   text?: string, pdf?: boolean, width?: number, height?: number,
   *   durationSeconds?: number, loaded?: boolean, failed?: boolean,
   *   error?: string, loading?: boolean, pending?: boolean, released?: boolean,
   *   key?: string}
   *   |undefined}
   */
  get(assetId, assetSnapshot = null) {
    if (!assetId) return undefined;
    const asset = assetSnapshot || this.findAsset(assetId);
    if (!asset || asset.archived) return undefined;
    const key = this.keyFor(asset);
    const cached = this.entries.get(key);
    // Read-only on purpose. This runs once per painted card per render, so the
    // reordering it used to perform made eviction follow the scroll direction
    // instead of real staleness, and evicted cards that were still visible.
    if (cached) return cached.value;
    // A settled preview the byte budget had to give up is not "still loading":
    // saying so would leave the card waiting for something that never comes.
    if (this.released.has(key)) return { released: true, key };
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
      this.bumpToken(key);
      this.releaseEntry(cached.value);
    }
    this.assetsByKey.set(key, asset);
    this.released.delete(key);
    const task = this.load(asset, key);
    // An explicit retry is one of the three allowed ways back to `loading`.
    this.repaint(key);
    return task;
  }

  observe(root) {
    if (!root?.querySelectorAll) return;
    const placeholders = [...root.querySelectorAll(
      "[data-asset-preview-key]",
    )];
    const activeKeys = new Set();
    const frames = new Map();
    for (const element of placeholders) {
      const key = element.getAttribute("data-asset-preview-key") || "";
      if (!key) continue;
      activeKeys.add(key);
      const bucket = frames.get(key);
      if (bucket) bucket.add(element);
      else frames.set(key, new Set([element]));
      const asset = this.assetFor(key, element);
      if (asset && !asset.archived && !this.entries.has(key)) {
        this.assetsByKey.set(key, asset);
      }
    }
    this.frames = frames;
    this.renderedKeys = activeKeys;

    for (const key of [...this.assetsByKey.keys()]) {
      if (!activeKeys.has(key) && !this.pending.has(key)) {
        this.assetsByKey.delete(key);
      }
    }
    // Keys that stopped being painted have nothing left to wait for.
    for (const key of [...this.deferred]) {
      if (!activeKeys.has(key)) {
        this.deferred.delete(key);
        this.deferredReasons.delete(key);
      }
    }
    // A card that scrolled away and comes back may load again. A card that stays
    // on screen waits for the user to ask, otherwise the byte budget would evict
    // it and re-arm it on every render — the same loop at a slower tempo.
    for (const key of [...this.released]) {
      if (!activeKeys.has(key)) this.released.delete(key);
    }
    this.dropUnrenderedLoads();
    // Frames that left the document with the previous render release the entries
    // they were pinning; this is the only way history stops accumulating.
    this.trim();

    if (typeof IntersectionObserver !== "function") {
      for (const key of activeKeys) this.loadByKey(key);
      return;
    }
    if (!this.intersectionObserver) {
      this.intersectionObserver = new IntersectionObserver((records) => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          const key = record.target.getAttribute("data-asset-preview-key");
          if (!key) {
            this.unwatch(record.target);
            continue;
          }
          if (this.entries.has(key) || this.pending.has(key)) {
            this.unwatch(record.target);
            continue;
          }
          // Visibility — not a render — is what makes an entry young again.
          this.touch(key);
          // A declined load keeps its frame watched: the queue is bounded, so a
          // freed slot (or the next intersection) starts it instead of a doomed
          // read that would only re-render the screen later.
          if (this.loadByKey(key)) this.unwatch(record.target);
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
      // Settled and in-flight frames are never re-observed: re-observing hands
      // the target a fresh intersect record, which is what restarted the loop.
      if (!key || this.entries.has(key) || this.pending.has(key) ||
        this.observedElements.has(element)) continue;
      this.observedElements.add(element);
      this.intersectionObserver.observe(element);
    }
  }

  unwatch(element) {
    if (!element) return;
    this.intersectionObserver?.unobserve(element);
    this.observedElements.delete(element);
  }

  /** Start the load for a painted key; false when there is nothing to start. */
  loadByKey(key) {
    const asset = this.assetsByKey.get(key);
    if (!asset || this.entries.has(key) || this.pending.has(key)) return false;
    // A preview the byte budget took back stays taken back. `observe()` runs on
    // every render and a freshly registered target always gets an intersect
    // record, so without this the released card read itself again the moment the
    // screen re-rendered, overflowed the budget all over again, and handed yet
    // another card back — the eviction/re-render loop at a slower tempo. Only
    // `retry()` (§9's user action) may send a released key loading.
    if (this.released.has(key)) return false;
    this.deferred.delete(key);
    this.deferredReasons.delete(key);
    void this.load(asset, key);
    return true;
  }

  /**
   * The asset a painted frame belongs to, from its own attribute or its key.
   * @param {{getAttribute?: (name: string) => string|null}|null} [element]
   */
  assetFor(key, element = null) {
    const id = element?.getAttribute?.("data-asset-preview-asset") ||
      this.assetIdFor(key);
    return id ? this.findAsset(id) : null;
  }

  /** Keys are the asset's identity tuple; the second field is the asset id. */
  assetIdFor(key) {
    try {
      const parts = JSON.parse(key);
      return Array.isArray(parts) ? String(parts[1] || "") : "";
    } catch {
      return "";
    }
  }

  isLoading(assetId) {
    const asset = this.findAsset(assetId);
    return Boolean(asset && this.pending.has(this.keyFor(asset)));
  }

  setOnChange(listener) {
    this.onChange = listener;
  }

  /**
   * Route a settled preview into the DOM without rebuilding the screen.
   * @param {(key: string) => number} listener repaints every frame painting
   *   `key` and returns how many it rewrote.
   */
  setOnPatch(listener) {
    this.onPatch = typeof listener === "function" ? listener : null;
  }

  acquireLoadSlot(key, token, generation) {
    if (!this.canGrant(key, token, generation)) return Promise.resolve(false);
    if (this.activeLoads < this.maxConcurrentLoads) {
      this.activeLoads += 1;
      return Promise.resolve(true);
    }
    if (this.loadQueue.length >= this.maxQueuedLoads) {
      // Cheaper to hold the key outside the queue than to keep a doomed read.
      this.deferred.add(key);
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      this.loadQueue.push({ key, token, generation, resolve });
    });
  }

  previewRequestContext() {
    if (typeof this.bridge.readAssetBatch !== "function" ||
      typeof this.bridge.previewRequestContext !== "function") return null;
    const context = this.bridge.previewRequestContext();
    if (
      !context || typeof context.project_id !== "string" || !context.project_id ||
      typeof context.project_dir !== "string" || !context.project_dir ||
      !(typeof context.lease_generation === "string" && context.lease_generation ||
        Number.isSafeInteger(context.lease_generation)) ||
      !Number.isSafeInteger(context.editor_generation) || context.editor_generation < 0 ||
      !context.fingerprint || context.fingerprint.exists !== true ||
      !Number.isSafeInteger(context.fingerprint.size) ||
      typeof context.fingerprint.hash !== "string" || !context.fingerprint.hash
    ) return null;
    return {
      project_dir: context.project_dir,
      project_id: context.project_id,
      fingerprint: { ...context.fingerprint },
      lease_generation: context.lease_generation,
      editor_generation: context.editor_generation,
    };
  }

  schedulePreviewBatch() {
    if (this.previewBatchScheduled) return;
    this.previewBatchScheduled = true;
    const drain = () => {
      this.previewBatchScheduled = false;
      this.drainPreviewBatches();
    };
    if (typeof queueMicrotask === "function") queueMicrotask(drain);
    else setTimeout(drain, 0);
  }

  enqueuePreviewRead(asset, key, token, generation) {
    const context = this.previewRequestContext();
    if (!context) return null;
    if (this.previewBatchQueue.length >= this.maxQueuedLoads) {
      this.deferred.add(key);
      this.deferredReasons.set(key, "queue");
      return Promise.resolve({ deferred: true });
    }
    const result = new Promise((resolve, reject) => {
      this.previewBatchQueue.push({
        asset,
        key,
        token,
        generation,
        context,
        resolve,
        reject,
      });
    });
    this.deferred.delete(key);
    this.deferredReasons.delete(key);
    this.schedulePreviewBatch();
    return result;
  }

  drainPreviewBatches() {
    while (this.activeLoads < this.maxConcurrentLoads && this.previewBatchQueue.length) {
      let first = this.previewBatchQueue.shift();
      if (!first) return;
      if (!this.canGrant(first.key, first.token, first.generation)) {
        first.resolve({ stale: true });
        continue;
      }
      const batch = [first];
      for (let index = 0; index < this.previewBatchQueue.length && batch.length < 8;) {
        const candidate = this.previewBatchQueue[index];
        if (!candidate) break;
        if (
          !samePreviewContext(candidate.context, first.context) ||
          !this.canGrant(candidate.key, candidate.token, candidate.generation)
        ) {
          if (!this.canGrant(candidate.key, candidate.token, candidate.generation)) {
            this.previewBatchQueue.splice(index, 1);
            candidate.resolve({ stale: true });
          } else index += 1;
          continue;
        }
        batch.push(...this.previewBatchQueue.splice(index, 1));
      }
      this.activeLoads += 1;
      void this.runPreviewBatch(batch);
    }
  }

  async runPreviewBatch(batch) {
    const context = batch[0]?.context;
    const generation = batch[0]?.generation;
    const requestGeneration = ++this.previewRequestGeneration;
    const stale = () => {
      const current = this.previewRequestContext();
      return generation !== this.generation || !samePreviewContext(current, context);
    };
    try {
      if (!context || stale()) {
        for (const item of batch) item.resolve({ stale: true });
        return;
      }
      const response = await this.bridge.readAssetBatch({
        project_dir: context.project_dir,
        project_id: context.project_id,
        fingerprint: context.fingerprint,
        request_generation: requestGeneration,
        asset_ids: batch.map((item) => item.asset.id),
      });
      if (
        response?.project_id !== context.project_id ||
        response?.request_generation !== requestGeneration ||
        !sameFingerprint(response?.fingerprint, context.fingerprint) || stale()
      ) {
        for (const item of batch) item.resolve({ stale: true });
        return;
      }
      const byId = new Map();
      const requestedIds = new Set(batch.map((request) => request.asset.id));
      for (const item of response.items) {
        if (
          !item || typeof item.asset_id !== "string" || byId.has(item.asset_id) ||
          !requestedIds.has(item.asset_id)
        ) {
          throw new Error("素材批量预览返回了重复或无效的素材 ID");
        }
        byId.set(item.asset_id, item);
      }
      for (const request of batch) {
        if (!this.isCurrent(request.key, request.token, request.generation)) {
          request.resolve({ stale: true });
          continue;
        }
        const asset = this.findAsset(request.asset.id);
        if (!asset || this.keyFor(asset) !== request.key || stale()) {
          request.resolve({ stale: true });
          continue;
        }
        const item = byId.get(request.asset.id);
        if (!item) {
          request.reject(new Error("素材批量预览缺少素材结果"));
        } else if (item.status === "deferred") {
          this.deferred.add(request.key);
          this.deferredReasons.set(request.key, "capacity");
          request.resolve({ deferred: true });
        } else if (item.status === "error") {
          request.reject(new Error(item.error?.message || "素材不可读"));
        } else if (item.status === "ok") {
          request.resolve({ bytes: decodePreviewBase64(item.bytes_base64, this.mediaLimit) });
        } else {
          request.reject(new Error("素材批量预览返回了未知状态"));
        }
      }
      if (batch.some((request) => {
        const item = byId.get(request.asset.id);
        return item?.status === "ok" || item?.status === "error";
      })) this.retryCapacityDeferred = true;
    } catch (error) {
      if (stale()) {
        for (const item of batch) item.resolve({ stale: true });
      } else {
        for (const item of batch) item.reject(error);
      }
    } finally {
      this.releaseLoadSlot();
    }
  }

  /** A preview is only worth reading while its attempt — and its card — live. */
  canGrant(key, token, generation) {
    if (generation !== this.generation) return false;
    if (this.tokenFor(key) !== token) return false;
    // No DOM knowledge (a direct `load()`, a retry, a WebView without an
    // observer) means nothing to pin and nothing to drop.
    if (this.renderedKeys === null) return true;
    return this.renderedKeys.has(key) && this.isLive(key);
  }

  tokenFor(key) {
    return this.tokens.get(key) || 0;
  }

  bumpToken(key) {
    const next = this.tokenFor(key) + 1;
    this.tokens.set(key, next);
    return next;
  }

  /**
   * Hand back the queue slots held by keys that stopped being painted. Waiting
   * for a slot only makes sense for a card the user can still reach; leaving
   * the library must not leave hundreds of doomed reads behind the live ones.
   */
  dropUnrenderedLoads() {
    if (this.previewBatchQueue.length) {
      this.previewBatchQueue = this.previewBatchQueue.filter((waiter) => {
        if (this.canGrant(waiter.key, waiter.token, waiter.generation)) return true;
        waiter.resolve({ stale: true });
        return false;
      });
    }
    if (!this.loadQueue.length) return;
    const kept = [];
    for (const waiter of this.loadQueue) {
      if (this.canGrant(waiter.key, waiter.token, waiter.generation)) {
        kept.push(waiter);
        continue;
      }
      this.deferred.delete(waiter.key);
      waiter.resolve(false);
    }
    this.loadQueue = kept;
  }

  releaseLoadSlot() {
    this.activeLoads = Math.max(0, this.activeLoads - 1);
    this.drainPreviewBatches();
    while (this.loadQueue.length && this.activeLoads < this.maxConcurrentLoads) {
      const waiter = this.loadQueue.shift();
      if (!this.canGrant(waiter.key, waiter.token, waiter.generation)) {
        this.deferred.delete(waiter.key);
        waiter.resolve(false);
        continue;
      }
      this.activeLoads += 1;
      waiter.resolve(true);
    }
    if (this.activeLoads < this.maxConcurrentLoads && this.deferred.size) {
      this.drainDeferred();
    }
  }

  /** Retry only what is still painted; everything else is dropped for free. */
  drainDeferred() {
    let capacityStillPending = false;
    for (const key of [...this.deferred]) {
      const reason = this.deferredReasons.get(key) || "queue";
      if (reason === "capacity" && !this.retryCapacityDeferred) continue;
      if (this.entries.has(key)) {
        this.deferred.delete(key);
        this.deferredReasons.delete(key);
        continue;
      }
      if (this.pending.has(key)) {
        if (reason === "capacity") capacityStillPending = true;
        continue;
      }
      if (this.activeLoads >= this.maxConcurrentLoads) return;
      if (this.previewBatchQueue.length >= this.maxQueuedLoads) return;
      this.deferred.delete(key);
      this.deferredReasons.delete(key);
      if (!this.canGrantRendered(key)) continue;
      const asset = this.assetsByKey.get(key) ||
        this.assetFor(key, this.firstFrame(key));
      if (!asset) continue;
      this.assetsByKey.set(key, asset);
      this.loadByKey(key);
    }
    if (!capacityStillPending) this.retryCapacityDeferred = false;
  }

  canGrantRendered(key) {
    if (this.renderedKeys === null) return true;
    return this.renderedKeys.has(key) && this.isLive(key);
  }

  firstFrame(key) {
    for (const element of this.frames.get(key) || []) {
      if (element.isConnected) return element;
    }
    return null;
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
    if (!asset || asset.archived) return false;
    const assetId = asset.id;
    const key = knownKey || this.keyFor(asset);
    // At most one in-flight preview per asset, however often the same card was
    // re-observed by a scroll or a re-render.
    if (this.entries.has(key) || this.pending.has(key)) return false;
    const current = this.findAsset(assetId);
    if (!current || current.archived || this.keyFor(current) !== key) return false;
    const generation = this.generation;
    const token = this.bumpToken(key);
    let acquired = false;
    const task = (async () => {
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
          acquired = await this.acquireLoadSlot(key, token, generation);
          // The wait for a slot is where a doomed load leaves: its card may have
          // been un-painted, or a newer attempt took the key over.
          if (!acquired) return;
          if (!String(asset.mime_type || "").toLowerCase().startsWith("video/")) {
            throw new Error("素材类型与视频文件格式不匹配");
          }
          source = await this.bridge.previewAssetVideoSource(assetId);
          sourceRelease = source?.release || null;
        } else {
          const batched = this.enqueuePreviewRead(asset, key, token, generation);
          if (batched) {
            const result = await batched;
            if (result?.stale || result?.deferred) return;
            bytes = result?.bytes;
          } else {
            acquired = await this.acquireLoadSlot(key, token, generation);
            if (!acquired) return;
            bytes = await this.bridge.readAssetBytes(assetId, this.mediaLimit);
          }
        }
        // Project switches, content edits and released entries invalidate reads
        // already in flight. Never let a late response repopulate newer state.
        const current = this.findAsset(assetId);
        if (!this.isCurrent(key, token, generation) || !current ||
          this.keyFor(current) !== key) {
          for (const url of ownedUrls) this.releaseEntry({ url });
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
          const mime = String(asset.mime_type || "").toLowerCase();
          if (!mime.startsWith("image/")) {
            throw new Error("素材类型与图片文件格式不匹配");
          }
          const url = keepUrl(urlForBytes(bytes, asset));
          // A static image previews as ITSELF (§12.1).  Re-encoding it through
          // a 2-D canvas used to produce a second PNG that kept the alpha
          // channel, so a transparent or near-white cover painted as a blank
          // card with no error state anywhere.  Only an animated GIF needs a
          // decoded still frame, because the encoded bytes would otherwise
          // animate inside a thumbnail.
          const image = await loadImage(url);
          let thumbnailUrl = url;
          if (asset.type === "gif" || mime === "image/gif") {
            // The decoded still frame, or the GIF's own bytes if this WebView
            // cannot hand back a first frame — never a generic placeholder.
            const poster = await staticImagePoster(bytes, asset.mime_type)
              .catch(() => null);
            if (poster) {
              keepUrl(poster);
              thumbnailUrl = poster;
            }
          }
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
        if (!this.isCurrent(key, token, generation) || !latest ||
          this.keyFor(latest) !== key) {
          this.releaseEntry(entry);
          return;
        }
        this.cache(key, entry, bytes?.byteLength || 0);
      } catch (error) {
        for (const url of ownedUrls) this.releaseEntry({ url });
        try { sourceRelease?.(); } catch { /* source token may already be gone */ }
        sourceRelease = null;
        if (!acquired || generation !== this.generation ||
          this.tokenFor(key) !== token) return;
        this.failures += 1;
        entry = {
          failed: true,
          error: error?.message || "素材不可读",
        };
        this.cache(key, entry, 0);
      } finally {
        const stale = generation !== this.generation ||
          this.tokenFor(key) !== token;
        const ownsPending = this.pending.get(key) === task;
        const waiting = ownsPending && !stale && this.deferred.has(key);
        if (ownsPending) {
          this.pending.delete(key);
          if (stale) {
            this.deferred.delete(key);
            this.deferredReasons.delete(key);
          } else if (!waiting) {
            this.assetsByKey.delete(key);
            // Settled. Patch the one frame that paints this key; a full rebuild
            // here is what restarted the observe → load → evict cycle.
            this.repaint(key);
          }
        }
        if (acquired) this.releaseLoadSlot();
        // A batch can finish while an item's task still owns `pending`; the
        // earlier slot-release pass preserves this reason, so retry after the
        // item's promise has settled and freed its key.
        if (waiting && this.activeLoads < this.maxConcurrentLoads) this.drainDeferred();
      }
    })();
    this.pending.set(key, task);
    await task;
    return true;
  }

  isCurrent(key, token, generation) {
    return generation === this.generation && this.tokenFor(key) === token;
  }

  /** Cards painted in the document: their entries are pinned against eviction. */
  isLive(key) {
    for (const element of this.frames.get(key) || []) {
      if (element.isConnected) return true;
    }
    return false;
  }

  liveKeyCount() {
    let count = 0;
    for (const [key, elements] of this.frames) {
      let painted = false;
      for (const element of elements) {
        if (element.isConnected) {
          painted = true;
          break;
        }
      }
      if (painted && this.entries.has(key)) count += 1;
    }
    return count;
  }

  /** The painted set plus a bounded history, under a hard ceiling. */
  capacity() {
    const history = Math.max(0, this.maxEntries);
    return Math.min(
      Math.max(this.maxTotalEntries, history),
      this.liveKeyCount() + history,
    );
  }

  /** Visibility, not a lookup, is what makes an entry young again. */
  touch(key) {
    const entry = this.entries.get(key);
    if (entry) entry.used = ++this.useClock;
  }

  cache(key, value, size) {
    this.entries.delete(key);
    this.entries.set(key, {
      value: { ...value, key },
      size,
      used: ++this.useClock,
    });
    this.cacheBytes += size;
    this.trim();
  }

  /**
   * Release entries beyond the budget. Count pressure only ever touches cards
   * that are no longer painted, so scrolling cannot revoke a live object URL;
   * the byte budget may drop a painted card, but that card is repainted first
   * and no node is left holding a revoked URL.
   */
  trim() {
    let guard = this.entries.size + 1;
    while (guard-- > 0) {
      if (this.entries.size <= this.capacity() &&
        this.cacheBytes <= this.maxCacheBytes) break;
      const victim = this.pickVictim();
      if (!victim) break;
      this.evict(victim);
    }
  }

  pickVictim() {
    const detached = [];
    const painted = [];
    for (const [key, entry] of this.entries) {
      (this.isLive(key) ? painted : detached).push([key, entry.used]);
    }
    const pool = detached.length ? detached : painted;
    if (!pool.length) return null;
    pool.sort((left, right) => left[1] - right[1]);
    return pool[0][0];
  }

  evict(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.cacheBytes = Math.max(0, this.cacheBytes - entry.size);
    // Anything still reading this key is now stale by definition.
    this.bumpToken(key);
    // Repaint first: the frame stops using the URL before it is revoked.
    if (this.isLive(key)) {
      // Only the byte budget reaches here with a painted card; count pressure
      // never drops one. Record it so the card says "released", not "loading".
      this.released.add(key);
      this.repaint(key);
    }
    this.releaseEntry(entry.value);
    return true;
  }

  /**
   * Write a settled preview into the document in place. Returns true when the
   * cache owns the outcome: either the frame was patched, or a rebuild was
   * scheduled because nothing could patch it.
   */
  repaint(key) {
    const patched = this.onPatch ? Number(this.onPatch(key)) || 0 : 0;
    if (patched > 0) return true;
    // No painted frame to patch means no work. With no DOM knowledge at all (a
    // direct read, a WebView without an observer) a rebuild is the only way to
    // show the result, and it is what releases a revoked URL from the screen.
    if (this.renderedKeys === null) {
      this.scheduleNotify();
      return true;
    }
    if (this.renderedKeys.has(key)) this.scheduleNotify();
    return false;
  }

  trackUrl(entry) {
    if (entry && typeof entry.url === "string" && entry.url.startsWith("blob:")) {
      this.urls.add(entry.url);
    }
  }

  releaseEntry(entry) {
    try { entry?.release?.(); } catch { /* source token may already be gone */ }
    // A static image's thumbnail IS its preview URL (§12.1), so the same blob
    // can appear twice on one entry: revoke each owned URL exactly once.
    const owned = new Set(
      [entry?.url, entry?.posterUrl, entry?.thumbnailUrl].filter((url) =>
        typeof url === "string" && url.startsWith("blob:")),
    );
    for (const url of owned) {
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
    for (const waiter of this.previewBatchQueue.splice(0)) waiter.resolve({ stale: true });
    this.deferred.clear();
    this.deferredReasons.clear();
    this.retryCapacityDeferred = false;
    this.released.clear();
    for (const [key, entry] of [...this.entries]) {
      // Drop the entry first: a frame repainted below must read as waiting, and
      // a URL a painted card still shows must not be revoked before it is gone.
      this.entries.delete(key);
      if (this.isLive(key)) this.repaint(key);
      this.releaseEntry(entry.value);
    }
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
    this.tokens.clear();
    this.assetsByKey.clear();
    this.frames.clear();
    this.renderedKeys = null;
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

/**
 * Decode the static default/first frame from encoded animated image bytes.
 *
 * The canvas re-encode belongs HERE (and in `decodeVideoFrame`) only: it is how
 * an animated GIF or a not-yet-seeked video becomes a still.  Supported static
 * images (PNG/JPG/JPEG/WebP) must never pass through it, because the re-encoded
 * PNG keeps alpha and a transparent image then paints as an empty box.
 */
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
