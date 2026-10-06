/**
 * Media Library scroll stability — the reported 120-asset flash/twitch bug.
 *
 * Reproducing it needs the pieces that were actually in the loop, so this file
 * drives the real preview cache against the real view layer with a hand-written
 * DOM, a `IntersectionObserver` that behaves like the browser's (a newly
 * observed target always gets an initial record), and a scroll position that
 * moves.
 *
 * What used to happen, in order: `render()` replaced `root.innerHTML`, which
 * destroyed every card's element identity; `observe()` re-registered all of them;
 * each fresh intersect record read the asset again; each read cached an entry,
 * which evicted another entry that was STILL PAINTED and revoked the object URL
 * its `<img>` was using; the eviction notified, which re-rendered — a closed
 * cycle. Capacity was a fixed 32 against an unpaged grid of 120+ cards, and
 * `get()` reordered the LRU on every read, so eviction followed the scroll
 * direction. Scrolling back up hit it hardest because the cards that had just
 * loaded were the ones at the head of that order. The screen flashed, and clicks
 * stopped landing because the element under the pointer was replaced mid-press
 * by the next rebuild.
 *
 * These tests pin the end state: painted cards pin their entry, a settled
 * preview patches one frame in place, completions never rebuild the screen, the
 * queue is bounded, an object URL is only revoked once no connected node paints
 * it, a superseded attempt cannot write over the newer one, the button a user
 * actually sees is bound by the real patch path, and a card the user is pressing
 * keeps its element identity — and its click — across the storm.
 */
import { AssetPreviewCache } from "../app/canvas.js";
import { createViews } from "../app/views.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10]);
const ASSET_COUNT = 120;
/** How many cards the simulated viewport holds at once. */
const PAGE = 8;
/** A preview of the size a real 1-2 MiB photo decodes to, in bytes. */
const MEGABYTE = 1024 * 1024;

const delay = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Let queued microtasks, slot hand-offs and observer records all land. */
async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) await delay();
}

type Asset = {
  id: string;
  project_id: string;
  type: string;
  filename: string;
  storage_path: string;
  mime_type: string;
  file_size: number;
  checksum: string;
  title: string;
  archived: boolean;
};

function imageAsset(index: number, size = PNG_BYTES.length): Asset {
  const name = `media-${String(index).padStart(3, "0")}.png`;
  return {
    id: `asset-${name}`,
    project_id: "project",
    type: "image",
    filename: name,
    storage_path: `assets/${name}`,
    mime_type: "image/png",
    file_size: size,
    checksum: `sum-${name}`,
    title: name,
    archived: false,
  };
}

/** The state a painted frame is showing, read back out of its own markup. */
function stateOf(html: string): string {
  if (html.includes("预览失败")) return "error";
  if (html.includes("缩略图已释放")) return "released";
  if (html.includes("asset-image")) return "ready";
  if (html.includes("正在读取")) return "reading";
  if (html.includes("等待加载")) return "waiting";
  if (html.includes("预览未加载")) return "unloaded";
  return "other";
}

type Handler = (event: Record<string, unknown>) => void;

/**
 * One control a user can actually press, parsed out of a frame's markup.
 *
 * Rewriting `innerHTML` replaces its children, so a listener bound to the
 * previous render goes away with the node it was bound to — that is the whole
 * reason a rebuild under the pointer eats a click, and why these objects are
 * rebuilt on every write instead of being reused.
 */
type Control = {
  tag: string;
  action: string;
  dataset: Record<string, string>;
  listeners: Map<string, Handler[]>;
  readonly isConnected: boolean;
  addEventListener: (type: string, handler: Handler) => void;
};

type Frame = {
  key: string;
  assetId: string;
  surface: string;
  isConnected: boolean;
  innerHTML: string;
  controls: Control[];
  getAttribute: (name: string) => string | null;
};

/** `data-action` / `data-asset` in markup order — what `querySelectorAll` finds. */
function controlsIn(html: string) {
  const found: { tag: string; attrs: Record<string, string> }[] = [];
  for (const match of html.matchAll(/<([a-z0-9]+)([^>]*)>/gi)) {
    const attrText = String(match[2] || "");
    if (!attrText.includes("data-action")) continue;
    const attrs: Record<string, string> = {};
    for (const pair of attrText.matchAll(/([a-z0-9_-]+)(?:="([^"]*)")?/gi)) {
      attrs[String(pair[1] || "").toLowerCase()] = pair[2] ?? "";
    }
    found.push({ tag: String(match[1] || "").toLowerCase(), attrs });
  }
  return found;
}

/** The `element.dataset` a bound handler reads, keys and all. */
function datasetOf(attrs: Record<string, string>) {
  const dataset: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (!name.startsWith("data-")) continue;
    const key = name.slice(5).split("-").map((part, index) =>
      index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
    ).join("");
    dataset[key] = value;
  }
  return dataset;
}

type FakeObserver = {
  targets: Set<Frame>;
  deliver: () => void;
  observe: (element: Frame) => void;
  unobserve: (element: Frame) => void;
  disconnect: () => void;
};

type Harness = {
  cache: AssetPreviewCache;
  assets: Asset[];
  frames: () => Frame[];
  render: (paint?: Asset[], options?: RenderOptions) => void;
  scrollTo: (top: number, span?: number) => void;
  showAll: () => void;
  gate: (promise: Promise<void> | null) => void;
  gateAsset: (assetId: string, promise: Promise<void>) => void;
  holdImageDecode: (promise: Promise<void> | null) => void;
  failNextReadFor: (assetId: string) => void;
  controlOf: (frame: Frame, action: string) => Control | undefined;
  press: (control: Control) => Control;
  tap: () => boolean;
  pressState: () => { interrupted: boolean; done: boolean };
  stats: {
    reads: number;
    readsByAsset: Map<string, number>;
    renders: number;
    rebuilds: number;
    patches: number;
    revoked: string[];
    revocations: Map<string, number>;
    revokedWhilePainted: string[];
    concurrentSameAsset: string[];
    states: Map<string, string[]>;
    actions: Map<string, number>;
    pressInterrupted: number;
    clicksLanded: number;
    clicksLost: number;
  };
  restore: () => void;
};

type RenderOptions = {
  /**
   * Put the viewport back at this offset after the rebuild, the way
   * `restoreScrollState()` does. Without it a render leaves visibility alone.
   */
  restoreTo?: number;
  /** Hand the observer the frames BEFORE that restore (the pre-fix ordering). */
  observeFirst?: boolean;
};

/**
 * The whole loop under test: a document that only holds frames, an observer that
 * reports what the scroll position actually shows, and a cache wired exactly the
 * way `main.js` wires it — `onChange` as the rebuild fallback, `onPatch` as the
 * in-place repaint.
 */
function harness(
  count: number,
  rawOptions: Record<string, unknown> = {},
): Harness {
  const { previewBytes, rebuildRerenders, patchFrames, ...options } = rawOptions;
  const previewSize = Number(previewBytes ?? PNG_BYTES.length);
  const previewPayload = previewSize === PNG_BYTES.length
    ? PNG_BYTES
    : new Uint8Array(previewSize);
  const assets = Array.from({ length: count }, (_unused, index) =>
    imageAsset(index, previewSize));
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: Object.getOwnPropertyDescriptor(globals, "document"),
    Image: Object.getOwnPropertyDescriptor(globals, "Image"),
    IntersectionObserver: Object.getOwnPropertyDescriptor(
      globals,
      "IntersectionObserver",
    ),
    createObjectURL: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
    revokeObjectURL: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
  };
  const stats = {
    reads: 0,
    readsByAsset: new Map<string, number>(),
    renders: 0,
    rebuilds: 0,
    patches: 0,
    revoked: [] as string[],
    revocations: new Map<string, number>(),
    revokedWhilePainted: [] as string[],
    concurrentSameAsset: [] as string[],
    states: new Map<string, string[]>(),
    actions: new Map<string, number>(),
    pressInterrupted: 0,
    clicksLanded: 0,
    clicksLost: 0,
  };
  const inFlight = new Set<string>();
  const failedReads = new Set<string>();
  /** One outstanding read held per asset, released by whoever armed it. */
  const assetHolds = new Map<string, Promise<void>>();
  const observers = new Set<FakeObserver>();
  let painted: Frame[] = [];
  let visible = new Set<string>();
  let gate: Promise<void> | null = null;
  let imageHold: Promise<void> | null = null;
  let urlCount = 0;
  let press: { control: Control; interrupted: boolean; done: boolean } | null =
    null;

  Object.defineProperty(globals, "document", {
    configurable: true,
    writable: true,
    value: {
      querySelectorAll: () => [],
      createElement: () => ({
        getContext: () => null,
        toBlob: () => {},
      }),
    },
  });
  Object.defineProperty(globals, "Image", {
    configurable: true,
    writable: true,
    value: function FakeImage() {
      const image = {
        naturalWidth: 64,
        naturalHeight: 48,
        src: "",
        onload: null as (() => void) | null,
        onerror: null as (() => void) | null,
        decode: () => imageHold
          ? imageHold.then(() => undefined)
          : Promise.resolve(),
      };
      // A WebView decodes on its own clock; holding this open is how a test parks
      // an attempt between "the object URL exists" and "the entry is written".
      const complete = () => queueMicrotask(() => image.onload?.());
      if (imageHold) void imageHold.then(complete);
      else complete();
      return image;
    },
  });
  Object.defineProperty(globals, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: function FakeIntersectionObserver(
      this: FakeObserver,
      callback: (records: unknown[], observer: FakeObserver) => void,
    ) {
      const observer: FakeObserver = {
        targets: new Set(),
        observe(element: Frame) {
          observer.targets.add(element);
          // A browser always hands a newly observed target an initial record.
          queueMicrotask(() => observer.deliver());
        },
        unobserve(element: Frame) {
          observer.targets.delete(element);
        },
        disconnect() {
          observer.targets.clear();
          observers.delete(observer);
        },
        deliver() {
          const records: { target: Frame; isIntersecting: boolean }[] = [];
          for (const target of observer.targets) {
            if (!target.isConnected) {
              observer.targets.delete(target);
              continue;
            }
            records.push({
              target,
              isIntersecting: visible.has(target.assetId),
            });
          }
          if (records.length) callback(records, observer);
        },
      };
      observers.add(observer);
      return observer;
    },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    // Zero-padded so no url is a prefix of another: the painted-markup check
    // below matches by substring.
    value: () => `blob:preview-${String(++urlCount).padStart(5, "0")}`,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: (url: string) => {
      stats.revoked.push(url);
      stats.revocations.set(url, (stats.revocations.get(url) || 0) + 1);
      // The rule under test: a URL is never revoked while a connected node is
      // still painting it.
      const stillShown = painted.filter((frame) =>
        frame.isConnected && frame.innerHTML.includes(`"${url}"`));
      for (const frame of stillShown) {
        stats.revokedWhilePainted.push(
          `${url} while ${frame.assetId} still paints ${stateOf(frame.innerHTML)}`,
        );
      }
    },
  });

  const cache = new AssetPreviewCache({
    currentProject: () => ({ id: "project", assets }),
    readAssetBytes: async (assetId: string) => {
      stats.reads += 1;
      stats.readsByAsset.set(
        assetId,
        (stats.readsByAsset.get(assetId) || 0) + 1,
      );
      if (failedReads.has(assetId)) {
        failedReads.delete(assetId);
        throw new Error("素材文件不可读");
      }
      if (inFlight.has(assetId)) stats.concurrentSameAsset.push(assetId);
      inFlight.add(assetId);
      try {
        if (gate) await gate;
        const hold = assetHolds.get(assetId);
        if (hold) {
          assetHolds.delete(assetId);
          await hold;
        }
        await delay();
      } finally {
        inFlight.delete(assetId);
      }
      return previewPayload;
    },
  }, {
    maxConcurrentLoads: 4,
    onChange: () => {
      stats.rebuilds += 1;
      // The pre-fix shape of this callback: `store.notify()` → `render()` →
      // `root.innerHTML = …`, which is what destroyed the pressed element.
      if (rebuildRerenders === true) render();
    },
    ...options,
  });

  const viewApi = createViews({ assetPreview: cache } as never) as unknown as {
    assetPreviewFrameInner: (
      asset: unknown,
      surface: string,
      block?: unknown,
    ) => string | null;
  };

  function record(key: string, state: string) {
    const history = stats.states.get(key);
    if (history) history.push(state);
    else stats.states.set(key, [state]);
  }

  /**
   * The test's stand-in for `main.js#bindActionControls`: every `[data-action]`
   * control in a freshly painted or patched frame gets a click listener of its
   * own. The listener is bound to the node, so only an unbroken node can take a
   * click — that is the property these tests assert, and the real binder is
   * driven directly by `the 重试预览 button a user sees …` below.
   */
  function bindActionControls(frame: Frame) {
    for (const control of frame.controls) {
      if (!control.action) continue;
      control.addEventListener("click", () => {
        stats.actions.set(
          control.action,
          (stats.actions.get(control.action) || 0) + 1,
        );
      });
    }
  }

  /** `innerHTML = …`: the old children are gone, and so are their listeners. */
  function writeFrame(frame: Frame, html: string) {
    frame.innerHTML = html;
    frame.controls = controlsIn(html).map((spec) => {
      const listeners = new Map<string, Handler[]>();
      const control: Control = {
        tag: spec.tag,
        action: spec.attrs["data-action"] || "",
        dataset: datasetOf(spec.attrs),
        listeners,
        get isConnected() {
          return frame.isConnected;
        },
        addEventListener(type: string, handler: Handler) {
          const list = listeners.get(type) || [];
          list.push(handler);
          listeners.set(type, list);
        },
      };
      return control;
    });
    bindActionControls(frame);
  }

  /** What the shell render paints into a brand-new card. */
  function paintFrame(frame: Frame) {
    const asset = byId.get(frame.assetId);
    assert(asset, "a painted card names a real asset");
    const inner = viewApi.assetPreviewFrameInner(asset, frame.surface, null);
    assert(
      inner !== null,
      "a media library card must have an in-place renderer",
    );
    writeFrame(frame, inner);
    record(frame.key, stateOf(inner));
  }

  /** What `main.js` does when a preview settles: repaint that frame only. */
  function patch(key: string) {
    let patched = 0;
    for (const frame of painted) {
      if (!frame.isConnected || frame.key !== key) continue;
      const asset = cache.assetFor(key, frame);
      if (!asset || cache.keyFor(asset) !== key) continue;
      const inner = viewApi.assetPreviewFrameInner(asset, frame.surface, null);
      if (inner === null) continue;
      writeFrame(frame, inner);
      record(key, stateOf(inner));
      patched += 1;
      stats.patches += 1;
    }
    return patched;
  }

  function makeFrame(asset: Asset): Frame {
    const key = cache.keyFor(asset);
    const attrs: Record<string, string> = {
      "data-asset-preview-key": key,
      "data-asset-preview-asset": asset.id,
      "data-asset-preview-surface": "card",
    };
    return {
      key,
      assetId: asset.id,
      surface: "card",
      isConnected: true,
      innerHTML: "",
      controls: [],
      getAttribute: (name: string) => attrs[name] ?? null,
    };
  }

  const root = {
    querySelectorAll(selector: string) {
      if (selector !== "[data-asset-preview-key]") return [];
      return painted.filter((frame) => frame.isConnected && frame.key !== "");
    },
  };

  function setVisible(offset: number, span = PAGE) {
    visible = new Set(
      painted.slice(offset, offset + span).map((frame) => frame.assetId),
    );
  }

  function report() {
    for (const observer of observers) observer.deliver();
  }

  function render(paint = assets, opts: RenderOptions = {}) {
    stats.renders += 1;
    // `render()` interrupts the live pointer gesture before it replaces the DOM
    // under the user's finger (`cancelActivePointerDrag?.()` in `app/main.js`)
    // and every card below loses its identity with `root.innerHTML = …`.
    if (press && !press.done) {
      press.interrupted = true;
      stats.pressInterrupted += 1;
    }
    for (const frame of painted) frame.isConnected = false;
    painted = paint.map((asset) => makeFrame(asset));
    for (const frame of painted) paintFrame(frame);
    const restoring = opts.restoreTo !== undefined;
    if (restoring) {
      // A brand-new container sits at the top of the list until the restore puts
      // it back; that is the geometry an observer armed too early judges every
      // card against, and why the head of the library all read at once.
      setVisible(0);
    }
    const arm = () => {
      cache.observe(root);
      for (const observer of observers) {
        queueMicrotask(() => observer.deliver());
      }
    };
    if (opts.observeFirst) {
      cache.observe(root);
      // A browser hands a freshly registered target its initial record on its own
      // timing; reported now, it is judged against the position still in effect.
      report();
    } else {
      arm();
    }
    // The order this app ships: restore first, then observe.
    if (restoring) setVisible(opts.restoreTo as number);
    if (opts.observeFirst) cache.observe(root);
    if (restoring) report();
  }

  cache.setOnPatch(patchFrames === false ? () => 0 : (key: string) => patch(
    String(key),
  ));

  return {
    cache,
    assets,
    frames: () => painted,
    render,
    scrollTo(offset: number, span = PAGE) {
      setVisible(offset, span);
      report();
    },
    showAll() {
      visible = new Set(painted.map((frame) => frame.assetId));
      report();
    },
    gate(promise: Promise<void> | null) {
      gate = promise;
    },
    gateAsset(assetId: string, promise: Promise<void>) {
      assetHolds.set(assetId, promise);
    },
    holdImageDecode(promise: Promise<void> | null) {
      imageHold = promise;
    },
    failNextReadFor(assetId: string) {
      failedReads.add(assetId);
    },
    controlOf(frame: Frame, action: string) {
      return frame.controls.find((control) => control.action === action);
    },
    press(control: Control) {
      press = { control, interrupted: false, done: false };
      for (const handler of control.listeners.get("pointerdown") || []) {
        handler({ target: control });
      }
      return control;
    },
    tap() {
      if (!press) throw new Error("no pointer press is in flight");
      press.done = true;
      const control = press.control;
      const handlers = control.listeners.get("click") || [];
      if (!control.isConnected || !handlers.length) {
        // The browser resolves a click on a replaced node to the nearest common
        // ancestor, where `[data-action]` is not: nothing was ever bound.
        stats.clicksLost += 1;
        return false;
      }
      for (const handler of handlers) handler({ target: control });
      stats.clicksLanded += 1;
      return true;
    },
    pressState() {
      return {
        interrupted: Boolean(press && press.interrupted),
        done: Boolean(press && press.done),
      };
    },
    stats,
    restore() {
      for (const observer of observers) observer.disconnect();
      cache.clear();
      for (const [name, descriptor] of Object.entries(saved)) {
        if (name === "createObjectURL" || name === "revokeObjectURL") {
          if (descriptor) {
            Object.defineProperty(URL, name, descriptor);
          } else {
            delete (URL as unknown as Record<string, unknown>)[name];
          }
          continue;
        }
        if (descriptor) Object.defineProperty(globals, name, descriptor);
        else delete globals[name];
      }
    },
  };
}

/** Every state each card ever showed, in the order it showed them. */
function regressions(stats: Harness["stats"]) {
  const found: string[] = [];
  for (const [key, history] of stats.states) {
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1];
      const current = history[index];
      if (previous === "ready" && (current === "waiting" || current === "reading")) {
        found.push(`${key}: ready → ${current} at step ${index}`);
      }
    }
  }
  return found;
}

Deno.test("scrolling a 120-card library top → bottom → top never regresses a loaded preview", async () => {
  const run = harness(ASSET_COUNT);
  try {
    run.scrollTo(0);
    run.render();
    // Three full passes: down to the last card and straight back up.
    for (let pass = 0; pass < 3; pass += 1) {
      for (let top = 0; top < ASSET_COUNT; top += PAGE) {
        run.scrollTo(top);
        await settle(3);
      }
      for (let top = ASSET_COUNT - PAGE; top >= 0; top -= PAGE) {
        run.scrollTo(top);
        await settle(3);
      }
    }
    await settle(20);

    const loaded = run.assets.filter((asset) =>
      run.cache.get(asset.id, asset)?.loaded === true);
    assert(
      loaded.length === ASSET_COUNT,
      `every card must settle exactly once, got ${loaded.length}/${ASSET_COUNT}`,
    );
    assert(
      regressions(run.stats).length === 0,
      `a settled preview must stay settled: ${regressions(run.stats).slice(0, 3).join(" | ")}`,
    );
    // One read per asset, for the whole three-pass scroll. Never two at once.
    assert(
      run.stats.reads === ASSET_COUNT,
      `bounded work means ${ASSET_COUNT} reads for ${ASSET_COUNT} assets, got ${run.stats.reads}`,
    );
    assert(
      run.stats.concurrentSameAsset.length === 0,
      `two concurrent loads of one asset: ${run.stats.concurrentSameAsset.slice(0, 3).join(",")}`,
    );
    // The loop is gone: completions patched 120 frames and rebuilt nothing.
    assert(
      run.stats.rebuilds === 0,
      `a settling preview must not schedule a screen rebuild, got ${run.stats.rebuilds}`,
    );
    assert(
      run.stats.patches === ASSET_COUNT,
      `each settled preview repaints its own frame once, got ${run.stats.patches}`,
    );
    assert(
      run.stats.renders === 1,
      `the test drove ${run.stats.renders} renders; scrolling must not add any`,
    );
    // Nothing was evicted, so nothing was revoked while on screen.
    assert(
      run.stats.revoked.length === 0,
      `no preview should be released during a scroll pass, revoked ${run.stats.revoked.length}: ${run.stats.revoked.slice(0, 3).join(",")}`,
    );
    assert(
      run.stats.revokedWhilePainted.length === 0,
      "an object URL must never be revoked while a connected card paints it",
    );
    assert(
      run.cache.loadQueue.length === 0 && run.cache.deferred.size === 0,
      "a settled library leaves no queued or deferred work behind",
    );
  } finally {
    run.restore();
  }
});

Deno.test("a burst of newly visible cards keeps the load queue bounded and drops doomed reads", async () => {
  const total = 200;
  const queued = 8;
  const run = harness(total, {
    maxConcurrentLoads: 1,
    maxQueuedLoads: queued,
  });
  try {
    run.scrollTo(0);
    run.render();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => release = resolve);
    run.gate(hold);
    // One giant viewport: every card reports intersecting at the same moment.
    run.showAll();
    await settle(6);
    const inFlightAndQueued = run.cache.activeLoads + run.cache.loadQueue.length;
    assert(
      run.stats.reads <= 1 + queued,
      `a burst must not start more than one read plus ${queued} queued, got ${run.stats.reads}`,
    );
    assert(
      run.cache.loadQueue.length <= queued,
      `the queue is bounded at ${queued}, got ${run.cache.loadQueue.length}`,
    );
    assert(
      inFlightAndQueued <= 1 + queued,
      `in-flight plus queued stays bounded, got ${inFlightAndQueued}`,
    );

    // The user leaves the library: only the first twelve cards are painted now.
    // Everything queued or deferred for the other 188 is doomed on the spot —
    // waiting for a slot only makes sense for a card the user can still reach.
    const readsBefore = run.stats.reads;
    run.gate(null);
    run.render(run.assets.slice(0, 12));
    assert(
      run.cache.loadQueue.length <= 12,
      `a re-render may not keep more waiters than there are painted cards, got ${run.cache.loadQueue.length}`,
    );
    assert(
      run.cache.deferred.size <= 12,
      `nothing doomed keeps waiting for a slot, got ${run.cache.deferred.size} deferred`,
    );
    // The one blocked read finishes, and the freed slots go to live cards only.
    release();
    await settle(40);
    const after = run.stats.reads - readsBefore;
    assert(
      after <= 12,
      `loads for cards that are no longer painted are dropped, not read: ${after} extra reads`,
    );
    assert(
      run.cache.loadQueue.length === 0 && run.cache.deferred.size === 0,
      `the bounded queue drains completely; ${run.cache.loadQueue.length} queued, ${run.cache.deferred.size} deferred`,
    );
    // Dropping doomed work must not starve the cards that are still on screen.
    const served = run.assets.slice(0, 12).filter((asset) =>
      run.cache.get(asset.id)?.loaded === true);
    assert(
      served.length === 12,
      `the freed slots belong to the painted cards, got ${served.length}/12 settled`,
    );
    assert(
      run.stats.revokedWhilePainted.length === 0,
      "no object URL is revoked while a connected card paints it",
    );
    assert(
      run.stats.concurrentSameAsset.length === 0,
      "a dropped attempt never races a newer one for the same asset",
    );
  } finally {
    run.restore();
  }
});

Deno.test("holding the byte budget drops a painted card only after repainting it", async () => {
  // Each fixture preview is PNG_BYTES.length bytes, so a 10-byte budget fits one.
  const run = harness(3, { maxCacheBytes: PNG_BYTES.length * 2 });
  try {
    run.scrollTo(0);
    run.render();
    run.showAll();
    await settle(30);
    assert(
      run.stats.revoked.length > 0,
      "a cache held over its byte budget must release something",
    );
    assert(
      run.stats.revokedWhilePainted.length === 0,
      "a released preview must have been repainted before its URL was revoked",
    );
    assert(
      run.stats.rebuilds === 0,
      `releasing a painted card repaints its frame, it does not rebuild the screen (${run.stats.rebuilds} rebuilds)`,
    );
    assert(
      run.stats.concurrentSameAsset.length === 0,
      "even a bounded eviction never reads the same asset twice at once",
    );
    // This is the one place a settled card may go back to waiting, and it says
    // so in its own state history.
    const bounced = [...run.stats.states.values()].filter((history) =>
      history.some((state, index) =>
        index > 0 && state !== "ready" && history[index - 1] === "ready"));
    assert(
      bounced.length > 0,
      "the bounded-eviction path must be the one exercised here",
    );
  } finally {
    run.restore();
  }
});

Deno.test("a card the byte budget took over says 已释放 and returns on the user's retry", async () => {
  const run = harness(3, { maxCacheBytes: PNG_BYTES.length * 2 });
  try {
    run.scrollTo(0);
    run.render();
    run.showAll();
    await settle(30);
    const released = [...run.stats.states.values()].filter((history) =>
      history.includes("released"));
    assert(
      released.length > 0,
      "an over-budget library must mark the card it released",
    );
    for (const history of released) {
      const last = history[history.length - 1];
      assert(
        last !== "waiting" && last !== "reading",
        `a released card must not claim it is still loading (${last})`,
      );
    }
    // Only the user takes a released card back to loading (§9), so this cannot
    // restart the loop on its own.
    const frame = run.frames().find((candidate) =>
      (run.stats.states.get(candidate.key) || []).includes("released"));
    assert(frame, "the released card is still painted");
    run.cache.retry(frame!.assetId);
    await settle(30);
    const history = run.stats.states.get(frame!.key) || [];
    assert(
      history[history.length - 1] === "ready",
      `retrying a released preview brings the picture back (${history.join(" → ")})`,
    );
    assert(
      run.stats.rebuilds === 0,
      "releasing and retrying never rebuilds the screen",
    );
  } finally {
    run.restore();
  }
});

Deno.test("reading a preview does not reorder the eviction queue", () => {
  const run = harness(3);
  try {
    const order = run.assets.map((asset) => run.cache.keyFor(asset));
    for (const key of order) {
      run.cache.entries.set(key, { value: { loaded: true, key }, size: 0, used: 1 });
    }
    // Twelve reads of the OLDEST entry — what one render of twelve cards does.
    for (let index = 0; index < 12; index += 1) {
      run.cache.get(run.assets[0]!.id, run.assets[0]!);
    }
    assert(
      [...run.cache.entries.keys()].join("|") === order.join("|"),
      "get() must be side-effect free: eviction order cannot follow read order",
    );
  } finally {
    run.restore();
  }
});

Deno.test("a late response is discarded instead of writing over newer state", async () => {
  const run = harness(1);
  try {
    run.scrollTo(0);
    run.render();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => release = resolve);
    run.gate(hold);
    run.showAll();
    await settle(4);
    assert(run.stats.reads === 1, "the read is in flight");
    // The user closes the project while that read is outstanding.
    run.cache.clear();
    run.gate(null);
    release();
    await settle(20);
    assert(
      run.cache.entries.size === 0,
      "a response to a cleared cache must not repopulate it",
    );
    assert(
      run.stats.revokedWhilePainted.length === 0,
      "clearing repaints the cards it is releasing",
    );
  } finally {
    run.restore();
  }
});

/** Run the load pipeline until nothing is in flight, queued or deferred. */
async function drain(run: Harness, rounds = 80) {
  for (let round = 0; round < rounds; round += 1) {
    await settle(10);
    const cache = run.cache;
    if (!cache.activeLoads && !cache.loadQueue.length && !cache.deferred.size) {
      return;
    }
  }
  throw new Error(
    `the load pipeline never went quiet: ${run.cache.activeLoads} active, ${run.cache.loadQueue.length} queued, ${run.cache.deferred.size} deferred`,
  );
}

/**
 * The read counter behind a call: `asserts` narrows a property access to the
 * literal it was compared with, and a counter measured in one place must not be
 * frozen at that value for the rest of the test.
 */
function readsOf(run: Harness) {
  return run.stats.reads;
}

/* ------------------------------------------------------------------ *
 * Gap §32.3: "no input lock / buttons remain clickable".
 * ------------------------------------------------------------------ */

Deno.test("a card the user is pressing keeps its identity and takes the click across the storm", async () => {
  const total = 24;
  const run = harness(total);
  try {
    run.render(run.assets, { restoreTo: 0 });
    await settle(40);
    // The first page is settled; the user puts the pointer down on a card they
    // can see while the rest of the library is still reading.
    const pressed = run.frames()[3];
    assert(pressed, "card 4 is painted");
    const zoom = run.controlOf(pressed!, "open-asset-image");
    assert(zoom, "a settled media card paints the control the user presses");
    run.press(zoom!);

    for (let pass = 0; pass < 2; pass += 1) {
      for (let index = 0; index < total; index += PAGE) {
        run.scrollTo(index);
        await settle(4);
      }
      for (let index = total - PAGE; index >= 0; index -= PAGE) {
        run.scrollTo(index);
        await settle(4);
      }
    }
    await settle(40);

    assert(
      run.frames()[3] === pressed,
      "the card under the pointer must be the same element the user pressed",
    );
    assert(
      run.controlOf(pressed!, "open-asset-image") === zoom,
      "its control must not have been replaced under the press",
    );
    assert(
      !run.pressState().interrupted,
      "preview churn must not interrupt a live pointer gesture",
    );
    assert(
      run.stats.pressInterrupted === 0,
      `nothing cancelled the press: ${run.stats.pressInterrupted} interrupts`,
    );
    assert(
      run.tap() === true,
      "the click must land on the control the user pressed",
    );
    assert(
      run.stats.actions.get("open-asset-image") === 1,
      `the action runs exactly once, got ${run.stats.actions.get("open-asset-image")}`,
    );
    assert(
      run.stats.rebuilds === 0 && run.stats.renders === 1,
      `a settling preview must not rebuild the screen (${run.stats.rebuilds} rebuilds, ${run.stats.renders} renders)`,
    );
  } finally {
    run.restore();
  }

  // Control run, so the assertions above can be seen to bite: with the in-place
  // patch taken away, every completion falls back to the rebuild the cache used
  // to do on every read — `store.notify()` → `root.innerHTML = …`. The very same
  // scenario then eats the press and loses the click.
  const broken = harness(total, {
    patchFrames: false,
    rebuildRerenders: true,
  });
  try {
    broken.render(broken.assets, { restoreTo: 0 });
    await settle(40);
    const pressed = broken.frames()[3];
    assert(pressed, "card 4 is painted");
    const zoom = broken.controlOf(pressed!, "open-asset-image");
    assert(zoom, "the control exists before the press");
    broken.press(zoom!);
    for (let index = 0; index < total; index += PAGE) {
      broken.scrollTo(index);
      await settle(4);
    }
    for (let index = total - PAGE; index >= 0; index -= PAGE) {
      broken.scrollTo(index);
      await settle(4);
    }
    await settle(40);
    assert(
      broken.stats.rebuilds > 0,
      "the control run must actually rebuild, or it proves nothing",
    );
    assert(
      broken.pressState().interrupted,
      "a rebuild under the pointer interrupts the press (cancelActivePointerDrag)",
    );
    assert(
      broken.frames()[3] !== pressed,
      "a rebuild replaces the pressed card with a new element",
    );
    assert(
      broken.tap() === false,
      "the click on the replaced node must not reach a bound handler",
    );
    assert(
      broken.stats.clicksLost > 0,
      "the lost click is what the user feels as an unresponsive screen",
    );
  } finally {
    broken.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Gap §10: the per-key token, not only the generation.
 * ------------------------------------------------------------------ */

Deno.test("a superseded attempt for one key cannot write over the newer preview", async () => {
  const run = harness(2);
  try {
    const joined = run.assets[0]!;
    const retried = run.assets[1]!;
    const joinedKey = run.cache.keyFor(joined);
    const retriedKey = run.cache.keyFor(retried);
    // One read hangs, the other fails outright: the card that failed is the one
    // a user can send a second attempt after.
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => releaseHold = resolve);
    run.gateAsset(joined.id, hold);
    run.failNextReadFor(retried.id);
    run.render(run.assets, { restoreTo: 0 });
    await settle(6);
    assert(readsOf(run) === 2, "each card armed exactly one read");

    // §10's first rule, on the real path: a retry pressed while a read is
    // outstanding joins that read; it starts no second attempt and it does not
    // retire the write token of the one already running.
    const outstanding = run.cache.pending.get(joinedKey) as unknown;
    assert(outstanding, "the first card's read is in flight");
    const liveToken = run.cache.tokenFor(joinedKey);
    assert(
      run.cache.retry(joined.id) === outstanding,
      "retrying an in-flight preview joins the attempt already running",
    );
    assert(
      run.cache.tokenFor(joinedKey) === liveToken,
      "joining an attempt must not advance the token of a live one",
    );
    await settle(20);
    assert(
      stateOf(run.frames()[1]!.innerHTML) === "error",
      "the failed card paints the failure, not a spinner",
    );
    releaseHold();
    await settle(20);
    assert(
      run.cache.get(joined.id, joined)?.loaded === true,
      "the joined attempt still lands",
    );
    assert(
      run.stats.readsByAsset.get(joined.id) === 1,
      "one attempt, one read",
    );

    // Now the token's own job. The retry re-reads the failed asset and parks
    // inside the image decode, holding an object URL it made for itself; a newer
    // attempt then takes the SAME key over — that is exactly what `bumpToken()`
    // in `retry()` and in `evict()` means — and the older response arrives
    // afterwards. Two attempts can never be live at once (asserted above), so
    // the newer attempt's bookkeeping is applied at that seam directly.
    const settledUrl = new Set([...run.cache.urls].map(String));
    let releaseDecode!: () => void;
    const decode = new Promise<void>((resolve) => releaseDecode = resolve);
    run.holdImageDecode(decode);
    run.cache.retry(retried.id);
    await settle(6);
    assert(
      run.cache.pending.get(retriedKey),
      "the retried read is in flight under the token it claimed",
    );
    const inFlightToken = run.cache.tokenFor(retriedKey);
    const fresh = [...run.cache.urls].map(String).filter((url) =>
      !settledUrl.has(url));
    assert(
      fresh.length === 1,
      `the parked attempt owns exactly one object URL, got ${fresh.join(",")}`,
    );
    const staleUrl = fresh[0]!;
    const newerUrl = "blob:newer-attempt";
    run.cache.bumpToken(retriedKey);
    assert(
      run.cache.tokenFor(retriedKey) !== inFlightToken,
      "the newer attempt retired the running one",
    );
    run.cache.entries.set(retriedKey, {
      value: { loaded: true, key: retriedKey, url: newerUrl },
      size: 0,
      used: 1,
    });
    // A successful newer attempt patches the existing frame in place; the
    // direct cache insertion above stands in for that committed entry.
    run.cache.repaint(retriedKey);
    releaseDecode();
    await settle(20);

    const after = run.cache.get(retried.id, retried);
    assert(
      after?.url === newerUrl,
      `a late response must not overwrite newer state, wrote ${after?.url}`,
    );
    assert(
      run.stats.revocations.get(staleUrl) === 1,
      `the discarded response releases its own URL exactly once, got ${run.stats.revocations.get(staleUrl) || 0}`,
    );
    assert(
      !run.cache.urls.has(staleUrl),
      "a discarded response must not keep holding its object URL",
    );
    assert(
      !run.stats.revocations.has(newerUrl),
      "a discarded response never revokes the newer preview",
    );
    assert(
      run.stats.rebuilds === 0,
      `a discarded response schedules no rebuild, got ${run.stats.rebuilds}`,
    );
    assert(
      readsOf(run) === 3,
      `a discarded response starts no further read, got ${run.stats.reads}`,
    );
    assert(
      stateOf(run.frames()[1]!.innerHTML) === "ready",
      "the patched card shows the newer preview",
    );
    assert(
      run.stats.revokedWhilePainted.length === 0,
      "nothing was revoked out from under a painted card",
    );
  } finally {
    run.holdImageDecode(null);
    run.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Gap §11 / §32.3: eviction past `maxTotalEntries` at production sizes.
 * ------------------------------------------------------------------ */

Deno.test("a library larger than the entry ceiling releases painted cards only after repainting them, and never re-arms one", async () => {
  // More cards than the shipped `maxTotalEntries`, at a size a real photo
  // decodes to: the ceilings under test are the ones v0.2.5 actually runs with.
  const total = 260;
  const bytes = 512 * 1024;
  const run = harness(total, { previewBytes: bytes });
  try {
    run.render(run.assets, { restoreTo: 0 });
    run.showAll();
    await drain(run);
    const cache = run.cache;
    assert(
      cache.maxTotalEntries === 240 && cache.maxCacheBytes === 96 * MEGABYTE,
      "the test runs against the shipped ceilings",
    );
    assert(
      readsOf(run) === total,
      `every painted card reads once, got ${run.stats.reads}/${total}`,
    );
    assert(
      cache.entries.size <= cache.maxTotalEntries,
      `the entry ceiling holds at ${cache.maxTotalEntries}, holding ${cache.entries.size}`,
    );
    assert(
      cache.cacheBytes <= cache.maxCacheBytes,
      `the byte budget holds, holding ${cache.cacheBytes} of ${cache.maxCacheBytes}`,
    );
    const released = [...cache.released].map(String);
    assert(
      released.length > 0,
      "a library over the ceiling must hand painted cards back",
    );
    for (const key of released) {
      const history = run.stats.states.get(key) || [];
      assert(
        history.at(-1) === "released",
        `a released card settles on 已释放, its states were ${history.join(" → ")}`,
      );
      const view = cache.get(cache.assetIdFor(key));
      assert(
        view?.released === true && !view.loading,
        "§9/§11: a released preview reports released, never a load that will not come",
      );
      const frame = run.frames().find((candidate) => candidate.key === key);
      assert(frame, "the released card is still painted");
      assert(
        stateOf(frame!.innerHTML) === "released",
        "the card says 缩略图已释放 before its URL goes",
      );
      assert(
        run.controlOf(frame!, "retry-asset-preview"),
        "and it paints the control that brings it back",
      );
    }
    assert(
      run.stats.revokedWhilePainted.length === 0,
      `an object URL is revoked only once no connected card paints it: ${run.stats.revokedWhilePainted.slice(0, 3).join(" | ")}`,
    );
    assert(
      run.stats.rebuilds === 0,
      `handing cards back repaints those frames, it does not rebuild the screen (${run.stats.rebuilds} rebuilds)`,
    );

    // The loop this whole file exists for, at production scale: a released card
    // must wait for the user. Three re-renders at three scroll offsets, with the
    // whole library visible, may not start one read.
    const settled = readsOf(run);
    for (const offset of [8, 24, 0]) {
      run.render(run.assets, { restoreTo: offset });
      run.showAll();
      await settle(30);
      assert(
        readsOf(run) === settled,
        `a released card started ${run.stats.reads - settled} load(s) of its own after a re-render at ${offset}`,
      );
      assert(
        regressions(run.stats).length === 0,
        `a settled preview must stay settled: ${regressions(run.stats).slice(0, 3).join(" | ")}`,
      );
    }
    assert(
      [...cache.released].map(String).join("|") === released.join("|"),
      "re-rendering does not quietly un-release the cards that are still painted",
    );
    assert(
      run.stats.revokedWhilePainted.length === 0,
      "still no URL revoked under a painted card",
    );

    // And the user's retry does bring the picture back.
    const key = released[0]!;
    run.cache.retry(run.cache.assetIdFor(key));
    await settle(40);
    const frame = run.frames().find((candidate) => candidate.key === key);
    assert(
      frame && stateOf(frame.innerHTML) === "ready",
      "retrying a released card at the ceiling brings its preview back",
    );
    assert(
      run.stats.revokedWhilePainted.length === 0,
      "and the room it needed came from another card's repaint, not its URL",
    );
  } finally {
    run.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Gap §8/§10: `observe()` after the scroll restore.
 * ------------------------------------------------------------------ */

Deno.test("a re-render re-arms no load for a card that already has a ready preview", async () => {
  const total = 40;
  const run = harness(total);
  try {
    run.render(run.assets, { restoreTo: 0 });
    await settle(30);
    assert(
      readsOf(run) === PAGE,
      `the first paint reads the page in view, got ${run.stats.reads}`,
    );
    run.showAll();
    await settle(40);
    assert(readsOf(run) === total, "the whole library settles once");

    // A re-render at a different offset is what any unrelated `notify()` does to
    // the library: every card node is replaced, so the only thing standing between
    // this and the flash storm is `observe()` refusing to re-arm a settled key.
    const settled = readsOf(run);
    for (const offset of [8, 24, 0]) {
      run.render(run.assets, { restoreTo: offset });
      await settle(20);
      assert(
        readsOf(run) === settled,
        `restoring to ${offset} re-armed ${run.stats.reads - settled} load(s)`,
      );
      assert(
        regressions(run.stats).length === 0,
        `a settled preview must stay settled: ${regressions(run.stats).slice(0, 3).join(" | ")}`,
      );
      assert(
        run.cache.observedElements.size === 0,
        `no settled frame may stay registered with the observer, ${run.cache.observedElements.size} still watched`,
      );
    }
    assert(
      run.stats.revoked.length === 0 && run.stats.rebuilds === 0,
      "nothing was handed back and nothing rebuilt",
    );
  } finally {
    run.restore();
  }

  // What the ordering is worth. The cache reads what the observer reports, so
  // which viewport the frames are judged against when they are registered
  // decides which cards read at once.
  const restored = harness(total);
  try {
    // restore → observe: one page reads, the page the user is actually on.
    restored.render(restored.assets, { restoreTo: 24 });
    await settle(30);
    const inPage = restored.assets.slice(24, 24 + PAGE).map((asset) =>
      asset.id);
    const read = [...restored.stats.readsByAsset.keys()];
    assert(
      readsOf(restored) === PAGE,
      `arming after the restore reads exactly the visible page, got ${restored.stats.reads}`,
    );
    assert(
      read.every((id) => inPage.includes(id)),
      `only the page in view read: ${read.join(",")}`,
    );
  } finally {
    restored.restore();
  }

  const armedFirst = harness(total);
  try {
    // observe → restore: the head of the library is judged against the
    // pre-restore position and reads too — the burst the shipped order avoids.
    armedFirst.render(armedFirst.assets, {
      restoreTo: 24,
      observeFirst: true,
    });
    await settle(30);
    assert(
      readsOf(armedFirst) === PAGE * 2,
      `arming before the restore reads the head of the list as well, got ${armedFirst.stats.reads}`,
    );
    assert(
      armedFirst.stats.readsByAsset.get(armedFirst.assets[0]!.id) === 1,
      "the card at the top of the list read although the user is nowhere near it",
    );
  } finally {
    armedFirst.restore();
  }
});

Deno.test("every preview state paints the same frame box, with no per-state geometry", async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const savedObserver = Object.getOwnPropertyDescriptor(
    globals,
    "IntersectionObserver",
  );
  Object.defineProperty(globals, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  const viewApi = createViews({
    assetPreview: {
      keyFor: (asset: Asset) => `key-${asset.id}`,
      get: (_id: string, asset: Asset) => viewApiStates.get(String(asset.id)),
    },
  } as never) as unknown as {
    assetPreviewFrameInner: (
      asset: unknown,
      surface: string,
      block?: unknown,
    ) => string | null;
  };
  const asset = (type: string, filename: string, mime: string): Asset => ({
    id: `asset-${filename}`,
    project_id: "project",
    type,
    filename,
    storage_path: `assets/${filename}`,
    mime_type: mime,
    file_size: 12,
    checksum: `sum-${filename}`,
    title: filename,
    archived: false,
  });
  const viewApiStates = new Map<string, Record<string, unknown>>([]);
  try {
    const png = asset("image", "cover.png", "image/png");
    viewApiStates.set(png.id, { loading: true, pending: false, key: `key-${png.id}` });
    const waiting = viewApi.assetPreviewFrameInner(png, "card", null) ?? "";
    viewApiStates.set(png.id, {
      loaded: true,
      key: `key-${png.id}`,
      url: "blob:cover",
      thumbnailUrl: "blob:cover",
      width: 64,
      height: 48,
    });
    const ready = viewApi.assetPreviewFrameInner(png, "card", null) ?? "";
    viewApiStates.set(png.id, { loading: true, pending: true, key: `key-${png.id}` });
    const reading = viewApi.assetPreviewFrameInner(png, "card", null) ?? "";
    viewApiStates.set(png.id, {
      failed: true,
      key: `key-${png.id}`,
      error: "文件不可读",
    });
    const failed = viewApi.assetPreviewFrameInner(png, "card", null) ?? "";

    // A settled preview replaces the frame's CONTENT and nothing else. The box,
    // its geometry and its key attributes come from `previewFrame`, which no
    // state branch can reach — that is what makes "waiting, reading, ready and
    // failed are the same size" structural instead of four separate fixes.
    const css = await Deno.readTextFile(
      new URL("../app/styles.css", import.meta.url),
    );
    const fillRules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .map(([, selector, body]) => ({
        classes: [...String(selector).matchAll(
          /\.asset-preview-frame\s+\.([a-z0-9_-]+)/g,
        )].map((match) => String(match[1] || "")),
        fills: /height:\s*100%/.test(String(body)) &&
          /width:\s*100%/.test(String(body)),
      }))
      .filter((rule) => rule.classes.length > 0);
    assert(
      fillRules.some((rule) => rule.fills),
      "styles.css must stretch a preview state's root over the whole frame",
    );
    const filling = new Set(
      fillRules.filter((rule) => rule.fills).flatMap((rule) => rule.classes),
    );
    const rootClass = (html: string) =>
      html.match(/^\s*<[a-z]+[^>]*class="([^"]*)"/)?.[1]?.split(" ")[0] || "";
    assert(
      rootClass(waiting) && rootClass(reading) && rootClass(ready) &&
        rootClass(failed),
      `every state must open with one element, got ${rootClass(
        waiting,
      )}/${rootClass(reading)}/${rootClass(ready)}/${rootClass(failed)}`,
    );
    for (const [name, html] of [
      ["waiting", waiting],
      ["reading", reading],
      ["ready", ready],
      ["failed", failed],
    ] as const) {
      assert(
        filling.has(rootClass(html)),
        `the ${name} state paints .${
          rootClass(html)
        }, which styles.css must size like every other state, or the card resizes`,
      );
    }
    const cardBox = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) =>
      /\.asset-card-media\s*>\s*\.asset-preview-frame/.test(String(sel))
    );
    assert(
      cardBox && /height:\s*100%/.test(String(cardBox[2])),
      "a media card hands the frame its whole box, so no state can change its height",
    );
    // The single place the identity attributes are written.
    const viewsSource = await Deno.readTextFile(
      new URL("../app/views.js", import.meta.url),
    );
    const frameHelper = viewsSource.match(
      /const previewFrame = \(asset, surface, inner, attrs = ""\) => \{[\s\S]*?\n {2}\};/,
    )?.[0] || "";
    assert(
      frameHelper.includes('data-asset-preview-key="${esc(key)}"') &&
        frameHelper.includes("data-asset-preview-surface="),
      "the frame helper is what advertises a preview's identity",
    );
    const keyEmitters = [...viewsSource.matchAll(/data-asset-preview-key=/g)]
      .length;
    assert(
      keyEmitters === 1,
      `only the frame may carry the preview key, so no state can drop it; found ${keyEmitters}`,
    );

    // PDF: the inline 180px height used to override the frame's own height.
    const pdf = asset("document", "handout.pdf", "application/pdf");
    viewApiStates.set(pdf.id, {
      loaded: true,
      key: `key-${pdf.id}`,
      url: "blob:handout",
      pdf: true,
    });
    const pdfHtml = viewApi.assetPreviewFrameInner(pdf, "card", null) ?? "";
    assert(
      pdfHtml.includes("asset-pdf-preview"),
      "a PDF paints its first page preview",
    );
    assert(
      !/style="[^"]*height:/.test(pdfHtml),
      `the PDF preview must not carry an inline height: ${pdfHtml}`,
    );

    // Video with a duration used to wrap in a bare <div> that fell out of the
    // frame's geometry; audio had the same problem.
    const movie = asset("video", "clip.mp4", "video/mp4");
    viewApiStates.set(movie.id, {
      loaded: true,
      key: `key-${movie.id}`,
      url: "blob:clip",
      posterUrl: "blob:clip-poster",
      durationSeconds: 75,
    });
    const movieHtml = viewApi.assetPreviewFrameInner(movie, "card", null) ?? "";
    assert(
      movieHtml.includes("asset-media-duration"),
      `a video with a duration must use the filling wrapper, got: ${movieHtml}`,
    );
    const clip = asset("audio", "voice.mp3", "audio/mpeg");
    viewApiStates.set(clip.id, {
      loaded: true,
      key: `key-${clip.id}`,
      url: "blob:voice",
      durationSeconds: 12,
    });
    assert(
      (viewApi.assetPreviewFrameInner(clip, "card", null) ?? "")
        .includes("asset-media-duration"),
      "an audio player with a duration uses the same filling wrapper",
    );
  } finally {
    if (savedObserver) {
      Object.defineProperty(globals, "IntersectionObserver", savedObserver);
    } else delete globals.IntersectionObserver;
  }
});

/* ------------------------------------------------------------------ *
 * Gap §32.3 / §9: the 「重试预览」 button a user actually sees.
 *
 * Everything above drives the cache with the test's own stand-in binder. This
 * one boots the real `app/main.js` — whose `patchAssetPreviewFrames()` and
 * `bindActionControls()` are module-private, so the shipped wiring can only be
 * reached by importing the module — and presses the button that real code
 * painted. A frame patched without rebinding is the "visible but dead button"
 * bug this app has fought before; a frame patched by a full rebuild is the
 * flicker this bug report is about.
 * ------------------------------------------------------------------ */

/** A node the real `bindActionControls` can attach a listener to. */
class LiveControl {
  frame: LiveFrame;
  tag: string;
  action: string;
  dataset: Record<string, string>;
  listeners = new Map<string, Handler[]>();

  constructor(
    frame: LiveFrame,
    spec: { tag: string; attrs: Record<string, string> },
  ) {
    this.frame = frame;
    this.tag = spec.tag;
    this.action = spec.attrs["data-action"] || "";
    this.dataset = datasetOf(spec.attrs);
  }

  addEventListener(type: string, handler: Handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  /** None of these controls is a `select`/`input`, and none sits in a Grid. */
  matches() {
    return false;
  }

  closest() {
    return null;
  }

  get isConnected() {
    return this.frame.isConnected;
  }

  /** How many listeners the real binder put on THIS node. */
  bound(type: string) {
    return (this.listeners.get(type) || []).length;
  }

  /** The browser's click: only a listener bound to this live node runs. */
  click() {
    const handlers = this.listeners.get("click") || [];
    for (const handler of handlers) {
      handler({
        type: "click",
        target: this,
        currentTarget: this,
        stopPropagation: () => {},
        preventDefault: () => {},
      });
    }
    return handlers.length;
  }
}

/** One `[data-asset-preview-key]` frame `main.js` may repaint in place. */
class LiveFrame {
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  isConnected = true;
  html = "";
  writes: string[] = [];
  controls: LiveControl[] = [];

  constructor(attrs: Record<string, string>) {
    this.attrs = attrs;
    this.dataset = datasetOf(attrs);
  }

  get innerHTML() {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    this.writes.push(value);
    // Replacing the markup replaces the children, so the controls — and any
    // listener bound to the previous ones — are gone with them.
    this.controls = controlsIn(value).map((spec) => new LiveControl(this, spec));
  }

  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }

  querySelectorAll(selector: string) {
    return selector.includes("data-action") ? [...this.controls] : [];
  }

  querySelector() {
    return null;
  }

  addEventListener() {}
}

/** `#app`. A write to `innerHTML` is a rebuild, and a rebuild kills the frames. */
class LiveRoot {
  frames: LiveFrame[] = [];
  writes: string[] = [];
  stacks: string[] = [];
  html = "";
  dataset: Record<string, string> = {};
  classList = { add: () => {}, remove: () => {}, toggle: () => {} };
  scrollTop = 0;
  scrollLeft = 0;

  get innerHTML() {
    return this.html;
  }

  set innerHTML(value: string) {
    this.writes.push(value);
    this.stacks.push(new Error(String(value.length)).stack ?? "");
    this.html = value;
    for (const frame of this.frames) frame.isConnected = false;
    this.frames = [];
  }

  querySelectorAll(selector: string) {
    if (selector === "[data-asset-preview-key]") {
      return this.frames.filter((frame) => frame.isConnected);
    }
    if (selector.includes("data-action")) {
      return this.frames.flatMap((frame) => frame.controls);
    }
    return [];
  }

  querySelector() {
    return null;
  }

  addEventListener() {}

  contains() {
    return false;
  }
}

let mainBootCount = 0;

/** A preview of a known size, so the byte budget can be pinned exactly. */
const PREVIEW_PAYLOAD = new Uint8Array(4096);

Deno.test("the 重试预览 button the real patch paints is bound by the real binder and takes the click", async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: Object.getOwnPropertyDescriptor(globals, "document"),
    Image: Object.getOwnPropertyDescriptor(globals, "Image"),
    IntersectionObserver: Object.getOwnPropertyDescriptor(
      globals,
      "IntersectionObserver",
    ),
    workbench: Object.getOwnPropertyDescriptor(globals, "__workbench"),
    ready: Object.getOwnPropertyDescriptor(globals, "__workbenchReady"),
    fetch: Object.getOwnPropertyDescriptor(globals, "fetch"),
    createObjectURL: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
    revokeObjectURL: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
  };
  const root = new LiveRoot();
  const reads: string[] = [];
  const failing = new Set<string>();
  const revoked: string[] = [];
  const revokedWhilePainted: string[] = [];
  let urlCount = 0;

  Object.defineProperty(globals, "document", {
    configurable: true,
    writable: true,
    value: {
      activeElement: null,
      querySelector: (selector: string) => selector === "#app" ? root : null,
      querySelectorAll: () => [],
      createElement: () => ({ getContext: () => null, toBlob: () => {} }),
      addEventListener: () => {},
    },
  });
  Object.defineProperty(globals, "Image", {
    configurable: true,
    writable: true,
    value: function FakeImage() {
      const image = {
        naturalWidth: 64,
        naturalHeight: 48,
        src: "",
        onload: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => image.onload?.());
      return image;
    },
  });
  // No observer: `observe()` then arms every painted key itself, which is the
  // same call the shipped `render()` makes right after restoring the scroll.
  Object.defineProperty(globals, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => `blob:preview-${String(++urlCount).padStart(5, "0")}`,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: (url: string) => {
      revoked.push(String(url));
      for (const frame of root.frames) {
        if (frame.isConnected && frame.innerHTML.includes(`"${String(url)}"`)) {
          revokedWhilePainted.push(
            `${url} while a card still paints ${stateOf(frame.innerHTML)}`,
          );
        }
      }
    },
  });
  Object.defineProperty(globals, "__TAURI__", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  globalThis.fetch = async () => {
    throw new Error("test fetch disabled");
  };

  mainBootCount += 1;
  await import(`../app/main.js?media-preview-binding-${mainBootCount}`);
  const store = globals.__workbench as Record<string, any>;
  assert(
    store && store.assetPreview,
    "the running workbench must expose the preview cache it was built with",
  );
  const cache = store.assetPreview as AssetPreviewCache;
  try {
    await globals.__workbenchReady;
  } catch { /* a failed browser boot degrades to the launcher, which is fine */ }

  // The boot's own shell render is not part of what this test measures.
  // `store.initialize()` fires `loadRegistryRows()` and a session read that
  // notify after it resolves, so wait those out before starting the count.
  await settle(20);
  root.writes.length = 0;
  root.stacks.length = 0;
  root.html = "";
  store.ui.toast = "";
  store.data = {
    id: "project",
    project: { id: "project", title: "预览绑定" },
    assets: [] as Asset[],
    blocks: [],
    content_items: [],
  };
  const bridge = store.bridge as Record<string, any>;
  assert(
    bridge === (cache as unknown as Record<string, unknown>).bridge,
    "the cache must read through the store's own bridge, or this proves nothing",
  );
  bridge.readAssetBytes = async (assetId: string) => {
    reads.push(assetId);
    if (failing.has(assetId)) {
      failing.delete(assetId);
      throw new Error("素材文件不可读");
    }
    return PREVIEW_PAYLOAD;
  };

  const assets = [imageAsset(0), imageAsset(1), imageAsset(2)];
  store.data.assets = assets;
  // The middle card's file is unreadable: that is the state whose button a user
  // presses, and the only one the cache re-arms on its own without.
  failing.add(assets[1]!.id);
  const frames = assets.map((asset) =>
    new LiveFrame({
      "data-asset-preview-key": cache.keyFor(asset),
      "data-asset-preview-asset": asset.id,
      "data-asset-preview-surface": "card",
    })
  );
  // What the shell render paints before any preview exists: no button at all.
  const idleViews = createViews({ assetPreview: cache } as never) as unknown as {
    assetPreviewFrameInner: (
      asset: unknown,
      surface: string,
      block?: unknown,
    ) => string | null;
  };
  for (const [index, frame] of frames.entries()) {
    frame.innerHTML = idleViews.assetPreviewFrameInner(
      assets[index],
      "card",
      null,
    ) ?? "";
    assert(
      frame.controls.length === 0,
      "an idle card has no control for the real binder to miss",
    );
  }
  root.frames = frames;

  try {
    cache.observe(root);
    await settle(24);

    assert(
      root.writes.length === 0,
      `a settling preview must never rebuild the shell, got ${root.writes.length} rebuild(s) from: ${
        root.stacks.map((stack) =>
          stack.split("\n").slice(1, 4).join(" <= ")
        ).slice(0, 3).join(" /// ")
      }`,
    );
    assert(
      stateOf(frames[0]!.innerHTML) === "ready" &&
        stateOf(frames[2]!.innerHTML) === "ready",
      "the readable previews land",
    );
    assert(
      stateOf(frames[1]!.innerHTML) === "error",
      `the unreadable asset paints its failure, got ${stateOf(frames[1]!.innerHTML)}`,
    );
    assert(
      frames[1]!.innerHTML.includes("重试预览"),
      `the failed card offers the real retry button, got ${frames[1]!.innerHTML}`,
    );
    const retryButton = frames[1]!.controls.find((control) =>
      control.action === "retry-asset-preview"
    );
    assert(retryButton, "the failed card's retry control is findable");
    assert(
      retryButton!.dataset.asset === assets[1]!.id,
      "the button carries the asset it belongs to",
    );
    // The whole point of the gap: `patchAssetPreviewFrames` has to hand its
    // brand-new controls to `bindActionControls(frame)`, or the button is paint
    // with no behaviour behind it.
    assert(
      retryButton!.bound("click") === 1,
      `the real patch path must bind the button it just painted exactly once, got ${retryButton!.bound("click")}`,
    );

    reads.length = 0;
    assert(
      retryButton!.click() === 1,
      "pressing the button runs the listener the real binder put there",
    );
    await settle(24);
    assert(
      reads.length === 1 && reads[0] === assets[1]!.id,
      `the click must issue exactly one fresh read for that asset, got ${reads.join(",")}`,
    );
    assert(
      stateOf(frames[1]!.innerHTML) === "ready",
      `the retried card shows its preview, got ${stateOf(frames[1]!.innerHTML)}`,
    );
    assert(
      root.writes.length === 0,
      "a retry repaints its own card; the shell is never rebuilt for it",
    );
    assert(
      frames[1]!.writes.length >= 2,
      "the same frame element was rewritten in place, not replaced",
    );

    // Now the state §11 creates under memory pressure, through the same wiring:
    // the byte budget takes a painted card back, the card must say 已释放 with a
    // working button, and it must NOT quietly re-read itself when the next
    // render arms the visible keys again.
    cache.maxCacheBytes = PREVIEW_PAYLOAD.byteLength * 2;
    const before = reads.length;
    const readyUrls = new Map<LiveFrame, string>(
      frames.map((frame): [LiveFrame, string] => [
        frame,
        (frame.innerHTML.match(/src="(blob:[^"]+)"/) ?? [])[1] ?? "",
      ]),
    );
    cache.observe(root);
    await settle(24);

    const released = frames.filter((frame) =>
      stateOf(frame.innerHTML) === "released"
    );
    assert(
      released.length >= 1,
      "over the byte budget a painted card is taken back rather than left holding memory",
    );
    assert(
      reads.length === before,
      `a released card started ${reads.length - before} load(s) of its own; only the user may re-arm it`,
    );
    assert(
      revokedWhilePainted.length === 0,
      `a released card had its URL taken back while still painting it: ${revokedWhilePainted.join("; ")}`,
    );
    const dropped = released[0]!;
    assert(
      readyUrls.get(dropped) !== "",
      "the released card was showing a preview before the budget took it",
    );
    assert(
      revoked.includes(String(readyUrls.get(dropped))),
      "the released card's object URL is given back",
    );
    const releasedButton = dropped.controls.find((control) =>
      control.action === "retry-asset-preview"
    );
    assert(
      releasedButton,
      `a released card must offer a way back, got ${dropped.innerHTML}`,
    );
    assert(
      releasedButton!.bound("click") === 1,
      `the real patch path must bind the released card's button, got ${releasedButton!.bound("click")} listener(s)`,
    );
    reads.length = 0;
    assert(
      releasedButton!.click() === 1,
      "the released card's button is pressable",
    );
    await settle(24);
    assert(
      reads.filter((id) => id === dropped.attrs["data-asset-preview-asset"])
        .length === 1,
      `the user's retry must re-read exactly that asset, got ${reads.join(",")}`,
    );
    assert(
      stateOf(dropped.innerHTML) === "ready",
      `the retried card paints its preview again, got ${stateOf(dropped.innerHTML)}`,
    );
    assert(
      root.writes.length === 0,
      "not one rebuild happened across the whole storm of patches",
    );
    assert(
      revokedWhilePainted.length === 0,
      `a retry that pushed another card over the budget revoked a live URL: ${revokedWhilePainted.join("; ")}`,
    );

    // The honest next render: the user navigates, the shell paints fresh cards
    // — the released one among them, still 已释放 — and arms them again. That
    // arming is exactly where a released card used to read itself back to life,
    // overflow the budget again and hand another card over.
    const settledReads = reads.length;
    const rerendered = frames.map((frame) => new LiveFrame(frame.attrs));
    for (const [index, frame] of rerendered.entries()) {
      frame.innerHTML = idleViews.assetPreviewFrameInner(
        assets[index],
        "card",
        null,
      ) ?? "";
    }
    for (const old of frames) old.isConnected = false;
    root.frames = rerendered;
    cache.observe(root);
    await settle(24);
    assert(
      reads.length === settledReads,
      `the re-render re-armed ${reads.length - settledReads} released card(s) by itself; only 重试预览 may`,
    );
    assert(
      rerendered.some((frame) => stateOf(frame.innerHTML) === "released"),
      "a re-render keeps a released card released, not waiting for a load that never comes",
    );
    assert(
      revokedWhilePainted.length === 0,
      `the re-render revoked a URL a fresh card was painting: ${revokedWhilePainted.join("; ")}`,
    );
    assert(
      root.writes.length === 0,
      "the whole run never rebuilt the shell, so no press was ever interrupted",
    );
  } finally {
    clearTimeout(store.saveTimer);
    clearTimeout(store.sessionTimer);
    clearTimeout(store.toastTimer);
    for (const [name, descriptor] of Object.entries(saved)) {
      if (name === "createObjectURL" || name === "revokeObjectURL") {
        if (descriptor) {
          Object.defineProperty(URL, name, descriptor);
        } else {
          delete (URL as unknown as Record<string, unknown>)[name];
        }
        continue;
      }
      if (descriptor) Object.defineProperty(globals, name, descriptor);
      else delete globals[name];
    }
    cache.clear();
  }
});
