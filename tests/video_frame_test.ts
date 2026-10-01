import { decodeVideoFrame } from "../app/canvas.js";

type VideoFrameCallback = (
  now: number,
  metadata: { mediaTime: number },
) => void;
type FakeEventListener = EventListenerOrEventListenerObject;
type AnimationFrameCallback = (time: number) => void;

Deno.test("video poster waits for the compositor frame without autoplay", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  const originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "cancelAnimationFrame",
  );
  const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL",
  );
  const originalSetTimeout = Object.getOwnPropertyDescriptor(
    globalThis,
    "setTimeout",
  );

  const drawSawPresentedFrame: boolean[] = [];
  const animationFrames = new Map<number, AnimationFrameCallback>();
  const videos: FakeVideo[] = [];
  let nextAnimationFrameId = 1;
  let video: FakeVideo | null = null;
  let deferBlob = false;
  let deferredBlobCallback: ((blob: Blob | null) => void) | null = null;
  let pendingTimeoutCallback: (() => void) | null = null;
  let objectUrlCount = 0;
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

  class FakeVideo {
    #listeners = new Map<
      string,
      Array<{ listener: FakeEventListener; once: boolean }>
    >();
    src = "";
    readyState = 0;
    videoWidth = 320;
    videoHeight = 180;
    duration = 2;
    currentTime = 0;
    paused = true;
    framePresented = false;
    registeredBeforeSource = false;
    playCalls = 0;
    frameCallback: VideoFrameCallback | null = null;
    cancelledFrameIds: number[] = [];

    requestVideoFrameCallback(callback: VideoFrameCallback): number {
      this.registeredBeforeSource = !this.src;
      this.frameCallback = callback;
      return 42;
    }

    cancelVideoFrameCallback(id: number): void {
      this.cancelledFrameIds.push(id);
    }

    addEventListener(
      type: string,
      listener: FakeEventListener | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (!listener) return;
      const entries = this.#listeners.get(type) || [];
      entries.push({
        listener,
        once: typeof options === "object" && options.once === true,
      });
      this.#listeners.set(type, entries);
    }

    removeEventListener(
      type: string,
      listener: FakeEventListener | null,
    ): void {
      if (!listener) return;
      const entries = this.#listeners.get(type) || [];
      this.#listeners.set(
        type,
        entries.filter((entry) => entry.listener !== listener),
      );
    }

    dispatch(type: string): void {
      const entries = [...(this.#listeners.get(type) || [])];
      for (const entry of entries) {
        if (typeof entry.listener === "function") {
          entry.listener.call(this, new Event(type));
        } else entry.listener.handleEvent(new Event(type));
        if (entry.once) this.removeEventListener(type, entry.listener);
      }
    }

    load(): void {
      if (!this.src || this.readyState) return;
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatch("loadedmetadata");
        this.readyState = 4;
        this.dispatch("loadeddata");
      });
    }

    play(): Promise<void> {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    }

    pause(): void {
      this.paused = true;
    }

    removeAttribute(name: string): void {
      if (name === "src") this.src = "";
    }
  }

  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        drawImage(source: { framePresented: boolean }) {
          drawSawPresentedFrame.push(source.framePresented);
        },
        getImageData(_x: number, _y: number, width: number, height: number) {
          const data = new Uint8ClampedArray(width * height * 4);
          if (video?.framePresented) {
            for (let index = 3; index < data.length; index += 4) {
              data[index] = 255;
            }
          }
          return { data };
        },
      };
    },
    toBlob(callback: (blob: Blob | null) => void): void {
      if (deferBlob) deferredBlobCallback = callback;
      else callback(new Blob(["poster"]));
    },
  };
  const fakeDocument = {
    createElement(name: string) {
      if (name === "video") {
        video = new FakeVideo();
        videos.push(video);
        return video;
      }
      if (name === "canvas") return canvas;
      throw new Error(`unexpected element: ${name}`);
    },
  };

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: fakeDocument,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value(callback: AnimationFrameCallback) {
      const id = nextAnimationFrameId++;
      animationFrames.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value(id: number) {
      animationFrames.delete(id);
    },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => `blob:video-frame-test-${++objectUrlCount}`,
  });
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value(callback: () => void, delay?: number) {
      if (delay === 15000) {
        pendingTimeoutCallback = callback;
        return nativeSetTimeout(() => {}, 60000);
      }
      return nativeSetTimeout(callback, delay);
    },
  });

  try {
    const posterPromise = decodeVideoFrame("asset://localhost/selected.mp4");
    await Promise.resolve();
    const firstVideo = videos[0];
    if (!firstVideo) throw new Error("video element was not created");
    if (!firstVideo.registeredBeforeSource || !firstVideo.frameCallback) {
      throw new Error(
        "frame callback must be registered before loading the source",
      );
    }
    if (firstVideo.playCalls !== 0) {
      throw new Error("poster extraction must not autoplay");
    }

    firstVideo.framePresented = false;
    firstVideo.frameCallback(0, { mediaTime: 0 });
    const firstAnimationFrame = [...animationFrames.entries()][0];
    if (!firstAnimationFrame) {
      throw new Error(
        "transparent first sample should retry on the next paint",
      );
    }
    firstVideo.framePresented = true;
    animationFrames.delete(firstAnimationFrame[0]);
    firstAnimationFrame[1](0);
    const poster = await posterPromise;

    if (
      drawSawPresentedFrame[0] !== false ||
      drawSawPresentedFrame.at(-1) !== true
    ) {
      throw new Error(
        "canvas capture must retry until a compositor frame is presented",
      );
    }
    if (poster.posterUrl !== "blob:video-frame-test-1") {
      throw new Error(`unexpected poster URL: ${poster.posterUrl}`);
    }
    if (poster.durationSeconds !== 2) {
      throw new Error("video duration must be preserved");
    }
    if (firstVideo.playCalls !== 0 || !firstVideo.paused) {
      throw new Error("poster extraction must leave the video paused");
    }
    if (animationFrames.size !== 0) {
      throw new Error("fallback frame callbacks must be cancelled");
    }

    deferBlob = true;
    const latePosterPromise = decodeVideoFrame(
      "asset://localhost/late-selected.mp4",
    );
    await Promise.resolve();
    const lateVideo = videos[1];
    if (!lateVideo?.frameCallback) {
      throw new Error("second video did not register a frame callback");
    }
    lateVideo.framePresented = true;
    lateVideo.frameCallback(0, { mediaTime: 0 });
    const timeoutCallback = pendingTimeoutCallback as (() => void) | null;
    if (!timeoutCallback) {
      throw new Error("timeout callback was not registered");
    }
    timeoutCallback();
    const timeoutError = await latePosterPromise.then(
      () => null,
      (error: unknown) => error,
    );
    if (
      !(timeoutError instanceof Error) || !timeoutError.message.includes("超时")
    ) {
      throw new Error("slow poster capture should time out cleanly");
    }
    const deliverLateBlob = deferredBlobCallback as
      | ((blob: Blob | null) => void)
      | null;
    deliverLateBlob?.(new Blob(["late poster"]));
    await Promise.resolve();
    if (objectUrlCount !== 1) {
      throw new Error("late canvas blob must not create an unowned object URL");
    }
    if (animationFrames.size !== 0) {
      throw new Error("timeout cleanup must cancel a pending animation frame");
    }
  } finally {
    const restore = (
      target: object,
      key: PropertyKey,
      descriptor?: PropertyDescriptor,
    ) => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    };
    restore(globalThis, "document", originalDocument);
    restore(globalThis, "requestAnimationFrame", originalRequestAnimationFrame);
    restore(globalThis, "cancelAnimationFrame", originalCancelAnimationFrame);
    restore(URL, "createObjectURL", originalCreateObjectURL);
    restore(globalThis, "setTimeout", originalSetTimeout);
  }
});
