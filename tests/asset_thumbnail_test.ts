/**
 * Media thumbnails (item 11a) — the §12.1 pipeline matrix.
 *
 * A PNG/JPG/WebP must preview as *itself*: the old path re-encoded it through a
 * 2-D canvas whose default `image/png` serialisation kept alpha, so a
 * transparent or mostly-white image produced an invisible poster with no error
 * state.  An animated GIF and an MP4 are the only still-poster cases that may
 * touch a canvas, because their encoded bytes are not a still picture.
 *
 *   PNG / JPG / WebP → the asset's own decoded bytes
 *   GIF              → one static first frame
 *   MP4              → one static first frame, never inside a <img> re-encode
 */
import { AssetPreviewCache } from "../app/canvas.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type FakeCanvasInstance = {
  width: number;
  height: number;
  ops: string[];
};

type FakeVideoInstance = {
  src: string;
  ops: string[];
};

type Recorder = {
  elements: string[];
  canvases: FakeCanvasInstance[];
  videos: FakeVideoInstance[];
  blobs: { url: string; type: string; byteLength: number }[];
  revoked: string[];
  bitmapCalls: number;
  /** How many times the `<img>`/loadImage decode path was constructed. */
  imageCalls: number;
  /** Install the stand-ins; returns the teardown that restores the globals. */
  restore: () => void;
};

function fakeMediaRuntime(): Recorder {
  const recorder: Recorder = {
    elements: [],
    canvases: [],
    videos: [],
    blobs: [],
    revoked: [],
    bitmapCalls: 0,
    imageCalls: 0,
    restore: () => {},
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const descriptors = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    Image: Object.getOwnPropertyDescriptor(globalThis, "Image"),
    createImageBitmap: Object.getOwnPropertyDescriptor(
      globalThis,
      "createImageBitmap",
    ),
    IntersectionObserver: Object.getOwnPropertyDescriptor(
      globalThis,
      "IntersectionObserver",
    ),
    createObjectURL: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
    revokeObjectURL: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
  };
  let urlCount = 0;

  class FakeCanvas {
    width = 0;
    height = 0;
    ops: string[] = [];
    getContext(kind: string) {
      assert(kind === "2d", "posters use a 2-D context");
      return {
        ops: this.ops,
        fillStyle: "",
        drawImage: () => this.ops.push("drawImage"),
        fillRect: () => this.ops.push("fillRect"),
        // A decoded frame is opaque: `decodeVideoFrame` refuses to paint a
        // poster whose every alpha byte is zero.
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let index = 3; index < data.length; index += 4) data[index] = 255;
          this.ops.push("getImageData");
          return { data };
        },
      };
    }
    toBlob(callback: (blob: Blob | null) => void, mime = "image/png") {
      this.ops.push(`toBlob:${mime}`);
      callback(new Blob(["re-encoded"], { type: mime }));
    }
  }

  class FakeImage {
    naturalWidth = 640;
    naturalHeight = 360;
    src = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decode(): Promise<void> {
      return Promise.resolve();
    }
  }

  class FakeVideo {
    muted = false;
    playsInline = false;
    preload = "";
    crossOrigin = "";
    readyState = 2;
    videoWidth = 640;
    videoHeight = 360;
    duration = 12.5;
    currentTime = 0;
    error = null;
    src = "";
    ops: string[] = [];
    listeners = new Map<string, { fn: () => void; once: boolean }[]>();
    frameCallback: (() => void) | null = null;

    addEventListener(
      type: string,
      handler: () => void,
      options?: { once?: boolean },
    ) {
      this.ops.push(`listen:${type}`);
      const list = this.listeners.get(type) ?? [];
      list.push({ fn: handler, once: Boolean(options?.once) });
      this.listeners.set(type, list);
    }

    removeEventListener(type: string, handler: () => void) {
      const kept = (this.listeners.get(type) ?? []).filter((entry) =>
        entry.fn !== handler
      );
      this.listeners.set(type, kept);
    }

    emit(type: string) {
      for (const entry of this.listeners.get(type) ?? []) {
        entry.fn();
        if (entry.once) this.removeEventListener(type, entry.fn);
      }
    }

    requestVideoFrameCallback(callback: () => void) {
      this.frameCallback = callback;
      return 1;
    }

    cancelVideoFrameCallback(_id: number) {
      this.frameCallback = null;
    }

    pause() {
      this.ops.push("pause");
    }

    load() {
      this.ops.push("load");
      // The compositor presents a frame for the source that was just set.
      queueMicrotask(() => {
        this.emit("loadedmetadata");
        const callback = this.frameCallback;
        this.frameCallback = null;
        callback?.();
      });
    }

    removeAttribute(name: string) {
      this.ops.push(`removeAttribute:${name}`);
    }
  }

  Object.defineProperty(globals, "document", {
    configurable: true,
    writable: true,
    value: {
      createElement: (name: string) => {
        recorder.elements.push(name);
        if (name === "canvas") {
          const canvas = new FakeCanvas();
          recorder.canvases.push(canvas);
          return canvas;
        }
        if (name === "video") {
          const video = new FakeVideo();
          recorder.videos.push(video);
          return video;
        }
        throw new Error(`unexpected element: ${name}`);
      },
      querySelectorAll: () => [],
    },
  });
  Object.defineProperty(globals, "Image", {
    configurable: true,
    writable: true,
    value: function FakeImageConstructor() {
      recorder.imageCalls += 1;
      const image = new FakeImage();
      // `loadImage` assigns `src` afterwards; resolve it on the next microtask.
      queueMicrotask(() => image.onload?.());
      return image;
    },
  });
  Object.defineProperty(globals, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: async () => {
      recorder.bitmapCalls += 1;
      return {
        width: 4,
        height: 3,
        close() {},
      };
    },
  });
  Object.defineProperty(globals, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      const url = `blob:thumbnail-${++urlCount}`;
      recorder.blobs.push({
        url,
        type: blob.type,
        byteLength: blob.size,
      });
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: (url: string) => {
      recorder.revoked.push(url);
    },
  });

  recorder.restore = () => {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (name === "createObjectURL" || name === "revokeObjectURL") {
        if (descriptor) Object.defineProperty(URL, name, descriptor);
        else delete (URL as unknown as Record<string, unknown>)[name];
        continue;
      }
      if (descriptor) Object.defineProperty(globals, name, descriptor);
      else delete globals[name];
    }
  };
  return recorder;
}

function imageAsset(kind: "image" | "gif" | "video", filename: string, mime: string) {
  return {
    // One id per file: the cache is addressed by asset id, so two fixtures that
    // share an id would silently resolve to the first one.
    id: `asset-${filename}`,
    project_id: "project",
    type: kind,
    filename,
    storage_path: `assets/${filename}`,
    mime_type: mime,
    file_size: 6,
    checksum: `sum-${filename}`,
    title: filename,
    archived: false,
  };
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10]);

type CacheHooks = {
  readAssetBytes?: (assetId: string, limit: number) => Promise<Uint8Array>;
  mediaLimit?: number;
};

/** Which native entry points the cache actually reached for a load. */
type CacheStats = { videoSourceCalls: number; readBytesCalls: number };

function cacheStats(): CacheStats {
  return { videoSourceCalls: 0, readBytesCalls: 0 };
}

function cacheFor(
  assets: unknown[],
  options = {},
  recorder?: Recorder,
  hooks: CacheHooks = {},
  stats: CacheStats = cacheStats(),
) {
  const cache = new AssetPreviewCache({
    currentProject: () => ({ id: "project", assets }),
    readAssetBytes: async (assetId: string, limit: number) => {
      stats.readBytesCalls += 1;
      return hooks.readAssetBytes
        ? await hooks.readAssetBytes(assetId, limit)
        : PNG_BYTES;
    },
    previewAssetVideoSource: async () => {
      stats.videoSourceCalls += 1;
      return { url: "blob:video-source" };
    },
  }, {
    maxEntries: 32,
    maxConcurrentLoads: 4,
    ...(hooks.mediaLimit ? { mediaLimit: hooks.mediaLimit } : {}),
    ...options,
  });
  if (recorder) {
    recorder.canvases.length = 0;
    recorder.videos.length = 0;
    recorder.elements.length = 0;
    recorder.bitmapCalls = 0;
    recorder.imageCalls = 0;
  }
  return cache;
}

Deno.test("PNG previews from its own bytes instead of an alpha-keeping canvas re-encode", async () => {
  const runtime = fakeMediaRuntime();
  try {
    const stats = cacheStats();
    const asset = imageAsset("image", "cover.png", "image/png");
    const cache = cacheFor([asset], {}, runtime, {}, stats);
    await cache.load(asset.id);
    const preview = cache.get(asset.id);
    assert(preview && !preview.failed, `preview must not fail: ${preview?.error}`);
    assert(stats.videoSourceCalls === 0, "a static image must never ask for a native video source (§12.1)");
    assert(!runtime.elements.includes("video"), "a static image must never enter video-frame extraction");
    assert(runtime.bitmapCalls === 0, "a static image must not go through the GIF/ImageBitmap poster path");
    assert(runtime.imageCalls === 1, "the static image decodes once through the <img> path");
    assert(
      runtime.canvases.length === 0,
      `a static image must not be re-encoded through a canvas (got ${runtime.canvases.length})`,
    );
    const source = runtime.blobs.find((blob) => blob.url === preview!.url);
    assert(source?.type === "image/png", "the preview URL carries the real PNG bytes");
    assert(
      source?.byteLength === PNG_BYTES.length,
      "the preview is the asset's own bytes, not a re-encoded substitute",
    );
    assert(
      preview!.thumbnailUrl === preview!.url,
      "the thumbnail IS the original image, not a second transparent poster",
    );
    assert(preview!.width === 640 && preview!.height === 360, "the real image dimensions survive");
    // Object-URL lifecycle: the card paints one URL and releasing it revokes
    // exactly once — a `thumbnailUrl === url` entry must not double-revoke.
    cache.clear();
    const owned = runtime.revoked.filter((url) => url === preview!.url);
    assert(
      owned.length === 1,
      `the image URL is released once, got ${owned.length} revocations of ${preview!.url}`,
    );
  } finally {
    runtime.restore();
  }
});

Deno.test("JPG and WebP take the same static-image path", async () => {
  const runtime = fakeMediaRuntime();
  try {
    const assets = [
      imageAsset("image", "photo.jpg", "image/jpeg"),
      imageAsset("image", "photo.webp", "image/webp"),
    ];
    const stats = cacheStats();
    const cache = cacheFor(assets, {}, runtime, {}, stats);
    for (const asset of assets) await cache.load(asset.id);
    assert(stats.videoSourceCalls === 0, "no static image may ask for a native video source (§12.1)");
    assert(!runtime.elements.includes("video"), "no static image may use video-frame extraction");
    assert(runtime.bitmapCalls === 0, "no static image may use the GIF poster path");
    assert(runtime.imageCalls === assets.length, "each static image decodes once through the <img> path");
    assert(runtime.canvases.length === 0, "no static image may be re-encoded through a canvas");
    for (const asset of assets) {
      const preview = cache.get(asset.id);
      assert(preview && !preview.failed && preview.url, "both images must preview");
      const blob = runtime.blobs.find((entry) => entry.url === preview!.url);
      assert(
        blob?.type === asset.mime_type,
        `the ${asset.mime_type} preview must keep its own bytes`,
      );
      assert(
        blob?.byteLength === PNG_BYTES.length,
        `the ${asset.mime_type} preview must not be a re-encoded substitute`,
      );
      assert(
        preview!.thumbnailUrl === preview!.url,
        `the ${asset.mime_type} thumbnail must be the image itself`,
      );
    }
  } finally {
    runtime.restore();
  }
});

Deno.test("a GIF still becomes a static first-frame thumbnail", async () => {
  const runtime = fakeMediaRuntime();
  try {
    const stats = cacheStats();
    const asset = imageAsset("gif", "loop.gif", "image/gif");
    const cache = cacheFor([asset], {}, runtime, {}, stats);
    await cache.load(asset.id);
    const preview = cache.get(asset.id);
    assert(preview && !preview.failed, "the GIF must still preview");
    assert(stats.videoSourceCalls === 0, "a GIF is not a video: it must not use the video source");
    assert(stats.readBytesCalls === 1, "a GIF is read as image bytes");
    assert(!runtime.elements.includes("video"), "a GIF is not a video");
    assert(runtime.imageCalls === 1, "the GIF itself is decoded once for its dimensions");
    assert(runtime.bitmapCalls === 1, "the GIF first frame comes from the static decoder");
    assert(
      runtime.canvases[0]?.ops.includes("toBlob:image/png") === true,
      "the GIF frame is serialised once from its opaque decoded frame",
    );
    assert(
      preview!.thumbnailUrl && preview!.thumbnailUrl !== preview!.url,
      "the card shows the decoded first frame while the overlay keeps the animation",
    );
    const poster = runtime.blobs.find((entry) => entry.url === preview!.thumbnailUrl);
    assert(poster?.type === "image/png", "the first frame is a still PNG poster");
    const animated = runtime.blobs.find((entry) => entry.url === preview!.url);
    assert(animated?.type === "image/gif", "the enlarged preview keeps the animated bytes");
  } finally {
    runtime.restore();
  }
});

Deno.test("an MP4 still becomes a static first frame through frame extraction", async () => {
  const runtime = fakeMediaRuntime();
  try {
    const stats = cacheStats();
    const asset = imageAsset("video", "lesson-mp4.mp4", "video/mp4");
    const cache = cacheFor([asset], {}, runtime, {}, stats);
    await cache.load(asset.id);
    const preview = cache.get(asset.id);
    assert(
      preview && !preview.failed,
      `the video first frame must be produced: ${preview?.error}`,
    );
    assert(stats.videoSourceCalls === 1, "MP4 must go through the native video source exactly once");
    assert(stats.readBytesCalls === 0, "MP4 must never be read as static image bytes");
    assert(runtime.imageCalls === 0, "MP4 must never run through the static <img> decode path");
    assert(runtime.bitmapCalls === 0, "MP4 must never use the GIF ImageBitmap poster path");
    assert(runtime.elements.filter((name) => name === "video").length === 1, "frame extraction runs on one video element");
    assert(runtime.videos[0]?.src === "blob:video-source", "the frame comes from the native video source");
    assert(
      runtime.canvases[0]?.ops.includes("toBlob:image/png") === true,
      "the video frame is serialised as a still poster",
    );
    assert(
      runtime.canvases[0]?.ops.includes("getImageData") === true,
      "an all-transparent frame is rejected instead of painted as a blank card",
    );
    const poster = runtime.blobs.find((entry) => entry.url === preview!.posterUrl);
    assert(poster?.type === "image/png", "the video card paints a still first frame");
    assert(
      typeof preview!.posterUrl === "string" && preview!.posterUrl !== preview!.url,
      "the still first frame is a separate poster URL, not the video stream",
    );
    assert(preview!.url === "blob:video-source", "the enlarged overlay keeps the real video source");
  } finally {
    runtime.restore();
  }
});

Deno.test("a PNG that cannot be decoded reports the real failure, not a placeholder", async () => {
  const runtime = fakeMediaRuntime();
  const previousImage = (globalThis as unknown as Record<string, unknown>).Image;
  try {
    // No canvas substitute is installed below, so any re-encode attempt throws:
    // a broken image must surface its decode error rather than a fake poster.
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      writable: true,
      value: function BrokenImage() {
        const image = {
          naturalWidth: 0,
          naturalHeight: 0,
          src: "",
          onload: null as (() => void) | null,
          onerror: null as (() => void) | null,
        };
        queueMicrotask(() => image.onerror?.());
        return image;
      },
    });
    const asset = imageAsset("image", "broken.png", "image/png");
    const cache = cacheFor([asset], {}, runtime);
    await cache.load(asset.id);
    const preview = cache.get(asset.id);
    assert(preview?.failed === true, "an undecodable PNG must be reported as failed");
    assert(
      String(preview?.error || "").includes("解码") ||
      String(preview?.error || "").includes("画面"),
      `the error must name the real decode failure, got: ${preview?.error}`,
    );
    assert(runtime.canvases.length === 0, "a failed image must not fall through a canvas re-encode");
  } finally {
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      writable: true,
      value: previousImage,
    });
    runtime.restore();
  }
});

Deno.test("evicting a preview re-notifies so no painted card keeps a revoked URL", async () => {
  const runtime = fakeMediaRuntime();
  try {
    const first = imageAsset("image", "first.png", "image/png");
    const second = imageAsset("image", "second.png", "image/png");
    let changes = 0;
    const cache = cacheFor([first, second], { maxEntries: 1 }, runtime);
    cache.setOnChange(() => {
      changes += 1;
    });
    await cache.load(first.id);
    const firstUrl = cache.get(first.id)?.url;
    await cache.load(second.id);
    const evicted = cache.get(first.id);
    assert(evicted?.loading === true, "the evicted asset must fall back to a placeholder");
    assert(
      !cache.entries.has(JSON.stringify([
        "project",
        first.id,
        first.storage_path,
        first.file_size,
        first.checksum,
        first.mime_type,
        first.type,
      ])),
      "the evicted entry must really be gone from the cache",
    );
    assert(changes > 0, "eviction must re-render the shell instead of leaving a dead <img> painted");
    assert(
      typeof firstUrl === "string" && runtime.revoked.filter((url) => url === firstUrl).length === 1,
      `the evicted URL must be revoked exactly once, revoked: ${runtime.revoked.join(",")}`,
    );
    const survivor = cache.get(second.id)?.url;
    assert(
      typeof survivor === "string" && !runtime.revoked.includes(survivor),
      "evicting one card must not revoke another live card's URL",
    );
  } finally {
    runtime.restore();
  }
});

Deno.test("when a GIF poster cannot be produced the card keeps the GIF's own bytes", async () => {
  const runtime = fakeMediaRuntime();
  try {
    // This WebView cannot hand back a decoded still frame. §12.2 forbids
    // papering over that with a placeholder, so the thumbnail degrades to the
    // animated bytes themselves and never reaches the canvas.
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: async () => {
        runtime.bitmapCalls += 1;
        throw new Error("当前 WebView 无法解码 GIF 首帧");
      },
    });
    const stats = cacheStats();
    const asset = imageAsset("gif", "broken-loop.gif", "image/gif");
    const cache = cacheFor([asset], {}, runtime, {}, stats);
    await cache.load(asset.id);
    const preview = cache.get(asset.id);
    assert(preview && !preview.failed, "the GIF must still preview even without a poster");
    assert(
      preview!.thumbnailUrl === preview!.url,
      "the thumbnail degrades to the GIF's own bytes, not a placeholder",
    );
    assert(runtime.canvases.length === 0, "a failed poster must not paint a blank canvas");
    const animated = runtime.blobs.find((entry) => entry.url === preview!.url);
    assert(animated?.type === "image/gif", "the surviving URL is the real animated GIF");
    assert(stats.videoSourceCalls === 0, "a GIF must never touch the video-frame path");
  } finally {
    runtime.restore();
  }
});

Deno.test("releasing a GIF revokes both owned URLs exactly once", async () => {
  const runtime = fakeMediaRuntime();
  try {
    const asset = imageAsset("gif", "loop.gif", "image/gif");
    const cache = cacheFor([asset], {}, runtime);
    await cache.load(asset.id);
    const preview = cache.get(asset.id);
    assert(preview && !preview.failed, "the GIF must preview before release");
    const animated = preview!.url;
    const poster = preview!.thumbnailUrl;
    assert(
      typeof animated === "string" && typeof poster === "string" && animated !== poster,
      "a successful GIF owns two distinct blob URLs",
    );
    cache.clear();
    assert(
      runtime.revoked.filter((url) => url === animated).length === 1,
      `the animated URL is revoked exactly once, revoked: ${runtime.revoked.join(",")}`,
    );
    assert(
      runtime.revoked.filter((url) => url === poster).length === 1,
      `the poster URL is revoked exactly once, revoked: ${runtime.revoked.join(",")}`,
    );
    assert(
      new Set(runtime.revoked).size === runtime.revoked.length,
      `no owned URL is double-revoked: ${runtime.revoked.join(",")}`,
    );
    assert(cache.urls.size === 0, "every owned URL leaves the tracking set, nothing leaks");
  } finally {
    runtime.restore();
  }
});

Deno.test("empty asset bytes report 素材文件为空, never a silent blank card", async () => {
  const runtime = fakeMediaRuntime();
  try {
    const asset = imageAsset("image", "blank.png", "image/png");
    const cache = cacheFor(
      [asset],
      {},
      runtime,
      { readAssetBytes: async () => new Uint8Array(0) },
    );
    await cache.load(asset.id);
    const preview = cache.get(asset.id);
    assert(preview?.failed === true, "empty bytes must fail");
    assert(
      preview?.error === "素材文件为空",
      `expected the empty-file message, got: ${preview?.error}`,
    );
    assert(
      runtime.canvases.length === 0 && runtime.imageCalls === 0,
      "a failed read must not fall through to a decode or a placeholder",
    );
  } finally {
    runtime.restore();
  }
});

Deno.test("oversize asset bytes report the preview-cap failure with its unit", async () => {
  const runtime = fakeMediaRuntime();
  try {
    const asset = imageAsset("image", "huge.png", "image/png");
    const cache = cacheFor(
      [asset],
      {},
      runtime,
      { readAssetBytes: async () => new Uint8Array(64), mediaLimit: 16 },
    );
    await cache.load(asset.id);
    const preview = cache.get(asset.id);
    assert(preview?.failed === true, "oversize bytes must fail");
    assert(
      String(preview?.error).includes("素材超过单文件预览上限"),
      `expected the cap message, got: ${preview?.error}`,
    );
    assert(
      String(preview?.error).includes("MiB"),
      `the cap message must name the unit, got: ${preview?.error}`,
    );
    assert(
      runtime.canvases.length === 0 && runtime.imageCalls === 0,
      "an oversize asset must not fall through to a re-encode",
    );
  } finally {
    runtime.restore();
  }
});

Deno.test("a non-image MIME on an image asset surfaces 素材类型与图片文件格式不匹配", async () => {
  const runtime = fakeMediaRuntime();
  try {
    const stats = cacheStats();
    const asset = imageAsset("image", "data.bin", "application/octet-stream");
    const cache = cacheFor([asset], {}, runtime, {}, stats);
    await cache.load(asset.id);
    const preview = cache.get(asset.id);
    assert(preview?.failed === true, "a mismatched asset must fail instead of previewing");
    assert(
      preview?.error === "素材类型与图片文件格式不匹配",
      `expected the type-mismatch message, got: ${preview?.error}`,
    );
    assert(stats.videoSourceCalls === 0, "a mismatched image must not be routed to the video path");
    assert(
      runtime.canvases.length === 0 && runtime.imageCalls === 0,
      "the mismatch must throw before any decode or placeholder",
    );
  } finally {
    runtime.restore();
  }
});
