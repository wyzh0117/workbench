import { createSerialQueue, recoveryWarning } from "../app/recovery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("UI recovery queue serializes saves and survives a failed task", async () => {
  const queue = createSerialQueue();
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const first = queue(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
    return "first";
  });
  const second = queue(async () => {
    events.push("second");
    return "second";
  });
  await Promise.resolve();
  assert(events.join(",") === "first:start", "queued save must wait for the active save");
  releaseFirst?.();
  assert(await first === "first", "first save should complete");
  assert(await second === "second", "second save should run after the first");
  assert(events.join(",") === "first:start,first:end,second", "save order must stay serialized");

  await queue(async () => { throw new Error("expected save failure"); }).catch(() => undefined);
  assert(await queue(async () => "after-failure") === "after-failure", "a failed save must not poison the queue");
});

Deno.test("UI surfaces backend recovery warnings from import results", () => {
  assert(
    recoveryWarning({ value: { recovery_warning: "恢复日志尚未清理" } }) === "恢复日志尚未清理",
    "wrapped recovery warnings must be extracted",
  );
  assert(
    recoveryWarning({ warnings: ["recovery journal cleanup pending"] }) === "recovery journal cleanup pending",
    "warning arrays must preserve recovery warnings",
  );
  assert(recoveryWarning({ warning: "普通提示" }) === "", "unrelated warnings must stay quiet");
});

Deno.test("WorkbenchStore flush retries a mutation that lands during save", async () => {
  const runtime = globalThis as typeof globalThis & { document?: unknown };
  const previousDocument = runtime.document;
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  runtime.document = {
    querySelector: () => root,
    addEventListener: () => undefined,
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("test fetch disabled");
  };
  try {
    const { WorkbenchStore } = await import("../app/main.js?recovery-test");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const journals: Array<{ saved_at: string; project: { project: { updated_at: string } } }> = [];
    const writes: Array<{ project: { title: string; updated_at: string } }> = [];
    let clearCount = 0;
    let sessionCount = 0;
    let store: InstanceType<typeof WorkbenchStore>;
    const bridge = {
      isNative: () => false,
      writeRecoveryJournal: async (journal: typeof journals[number]) => { journals.push(journal); },
      writeProject: async (snapshot: typeof writes[number]) => {
        writes.push(structuredClone(snapshot));
        if (writes.length === 1) {
          store.data.project.title = "最新标题";
          store.markDirty();
        }
      },
      clearRecoveryJournal: async () => { clearCount += 1; },
      saveSession: async () => { sessionCount += 1; },
    };
    store = new WorkbenchStore(bridge);
    const saved = await store.flush();
    clearTimeout(store.saveTimer);
    assert(saved, "flush must succeed after retrying the changed snapshot");
    assert(writes.length === 2, "a mutation during the first save must trigger a second write");
    const latestWrite = writes.at(-1);
    const latestJournal = journals.at(-1);
    assert(latestWrite && latestJournal, "stable save must produce a latest write and journal");
    assert(latestWrite.project.title === "最新标题", "the second write must contain the latest data");
    assert(
      latestWrite.project.updated_at === store.data.project.updated_at &&
        latestJournal.saved_at === latestWrite.project.updated_at,
      "canonical and recovery journal must share the latest revision",
    );
    assert(clearCount === 1 && sessionCount === 1, "only the stable save should clear and finish the session");
  } finally {
    runtime.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});

Deno.test("native startup clears a persisted project path when opening loses its lease", async () => {
  const runtime = globalThis as typeof globalThis & { document?: unknown; __TAURI__?: unknown };
  const previousDocument = runtime.document;
  const previousTauri = runtime.__TAURI__;
  const previousFetch = globalThis.fetch;
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  runtime.document = {
    querySelector: () => root,
    addEventListener: () => undefined,
  };
  runtime.__TAURI__ = undefined;
  globalThis.fetch = async () => {
    throw new Error("test fetch disabled");
  };
  try {
    const { WorkbenchStore } = await import("../app/main.js?native-session-recovery-test");
    let restoredPath: string | null | undefined = "/tmp/stale-project";
    let clearedSession: { project_dir: string | null } | null = null;
    const bridge = {
      projectDir: "/tmp/stale-project",
      projectDirFromUrl: false,
      isNative: () => true,
      loadSession: async () => ({ project_dir: "/tmp/stale-project" }),
      readProject: async () => { throw new Error("项目目录不存在"); },
      readRecoveryJournal: async () => null,
      restoreProjectDir: (value: string | null) => { restoredPath = value; },
      saveSession: async (session: { project_dir: string | null }) => { clearedSession = session; },
      listenNativeDrops: async () => () => {},
    };
    const store = new WorkbenchStore(bridge);
    await store.initialize();
    assert(restoredPath === null, "failed startup must clear the in-memory project path");
    const savedSession = clearedSession as { project_dir: string | null } | null;
    assert(savedSession?.project_dir === null, "failed startup must clear persisted session state");
    assert(store.nativeLeaseDirs.size === 0, "failed startup must not leave an active lease");
  } finally {
    runtime.document = previousDocument;
    runtime.__TAURI__ = previousTauri;
    globalThis.fetch = previousFetch;
  }
});

Deno.test("native project switching rolls back the target when the old lease cannot close", async () => {
  const runtime = globalThis as typeof globalThis & { document?: unknown; __TAURI__?: unknown };
  const previousDocument = runtime.document;
  const previousTauri = runtime.__TAURI__;
  const previousFetch = globalThis.fetch;
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  runtime.document = {
    querySelector: () => root,
    addEventListener: () => undefined,
  };
  runtime.__TAURI__ = undefined;
  globalThis.fetch = async () => {
    throw new Error("test fetch disabled");
  };
  try {
    const { WorkbenchStore } = await import("../app/main.js?native-switch-rollback-test");
    const calls: string[] = [];
    const sessions: Array<{ project_dir: string | null }> = [];
    let store: InstanceType<typeof WorkbenchStore>;
    const bridge = {
      projectDir: "A",
      projectDirFromUrl: false,
      isNative: () => true,
      setProjectDir: (value: string) => { bridge.projectDir = value; },
      restoreProjectDir: (value: string | null) => { bridge.projectDir = value || ""; },
      openProject: async () => {
        const project = structuredClone(store.data);
        project.project.title = "B";
        return project;
      },
      saveSession: async (session: { project_dir: string | null }) => { sessions.push(session); },
      writeRecoveryJournal: async () => {},
      writeProject: async () => {},
      clearRecoveryJournal: async () => {},
      closeProject: async (projectDir: string) => {
        calls.push(`close:${projectDir}`);
        if (projectDir === "A") throw new Error("old lease close failed");
      },
    };
    store = new WorkbenchStore(bridge);
    store.markNativeLease("A");
    await store.openProject("B");
    assert(calls.join(",") === "close:A,close:B", "switch failure must close the target rollback lease");
    assert(bridge.projectDir === "A", "switch failure must restore the original project path");
    assert(sessions.at(-1)?.project_dir === "A", "switch rollback must persist the original project path");
    assert(store.hasNativeLease("A") && !store.hasNativeLease("B"), "failed switch must not leave two active leases");
    assert(!store.nativeSwitchPending, "a successful target rollback must not leave a pending switch");
  } finally {
    runtime.document = previousDocument;
    runtime.__TAURI__ = previousTauri;
    globalThis.fetch = previousFetch;
  }
});
