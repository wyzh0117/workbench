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

Deno.test("WorkbenchStore surfaces autosave conflicts and reload establishes a usable state", async () => {
  const runtime = globalThis as typeof globalThis & { document?: unknown };
  const previousDocument = runtime.document;
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
  globalThis.fetch = async () => { throw new Error("test fetch disabled"); };
  try {
    const { WorkbenchStore } = await import("../app/main.js?external-conflict-ui-test");
    let shouldConflict = true;
    let store: InstanceType<typeof WorkbenchStore>;
    const bridge = {
      isNative: () => false,
      writeRecoveryJournal: async () => {},
      writeProject: async () => {
        if (shouldConflict) {
          const failure = new Error("保存已阻止") as Error & { code: string };
          failure.code = "external_modification_conflict";
          throw failure;
        }
      },
      inspectExternalModification: async () => ({
        changed: true,
        current: { exists: true, mtime_ms: 1, size: 2, hash: "external" },
        external_diff: { changed: true, entries: [{ path: "project.title" }] },
        local_diff: { changed: true, entries: [{ path: "project.description" }] },
      }),
      reloadExternalProject: async () => {
        const project = structuredClone(store.data);
        project.project.title = "磁盘版本";
        return project;
      },
      clearRecoveryJournal: async () => {},
      saveSession: async () => {},
    };
    store = new WorkbenchStore(bridge);
    assert(!(await store.flush()), "autosave must report a blocked write");
    assert(store.externalConflict?.changed, "the UI must retain structured conflict state");
    assert(store.saveStatus === "外部修改冲突", "conflict must not look like a successful save");
    shouldConflict = false;
    await store.resolveExternalConflict("reload");
    assert(store.data.project.title === "磁盘版本", "reload must replace stale in-memory state");
    assert(!store.externalConflict, "reload must clear the resolved conflict");
    assert(await store.flush(), "saving after reload must succeed");
  } finally {
    runtime.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});

Deno.test("pending recovery keeps canonical data until restore snapshots it", async () => {
  const runtime = globalThis as typeof globalThis & { document?: unknown };
  const previousDocument = runtime.document;
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
  globalThis.fetch = async () => { throw new Error("test fetch disabled"); };
  try {
    const { WorkbenchStore } = await import("../app/main.js?pending-recovery-test");
    const backups: Array<{ project: { project: { title: string } } }> = [];
    const writes: Array<{ project: { title: string }; snapshots: Array<{ name: string }> }> = [];
    let clearCount = 0;
    let persisted: Record<string, unknown> | null = null;
    let journal: Record<string, unknown> | null = null;
    const bridge = {
      projectDir: "/tmp/recovery-project",
      isNative: () => true,
      loadSession: async () => null,
      readProject: async () => structuredClone(persisted),
      readRecoveryJournal: async () => structuredClone(journal),
      listenNativeDrops: async () => () => {},
      writeRecoveryJournal: async () => {},
      writeProject: async (project: typeof writes[number]) => { writes.push(structuredClone(project)); },
      createSnapshot: async (input: typeof backups[number]) => {
        backups.push(structuredClone(input));
        return { id: "recovery-before", name: "恢复前备份", note: "backup", created_at: "2026-09-21T00:00:00.000Z" };
      },
      clearRecoveryJournal: async () => { clearCount += 1; },
      saveSession: async () => {},
    };
    const store = new WorkbenchStore(bridge);
    const canonical = structuredClone(store.data);
    canonical.project.title = "磁盘版本";
    const recovered = structuredClone(canonical);
    recovered.project.title = "自动保存版本";
    persisted = canonical;
    journal = { project: recovered, saved_at: "2999-09-21T00:00:00.000Z" };
    await store.initialize();
    assert(store.data.project.title === "磁盘版本", "startup must keep canonical data visible");
    assert(store.pendingRecovery?.project.project.title === "自动保存版本", "startup must retain the newer recovery candidate");
    assert(!(await store.flush()), "pending recovery must block an ordinary flush");
    await store.resolvePendingRecovery("restore");
    assert(String(store.data.project.title) === "自动保存版本", "restore must install the journal project");
    assert(writes.at(-1)?.project.title === "自动保存版本", "restore must persist the journal project");
    const backup = backups.at(0);
    assert(backup && backup.project.project.title === "磁盘版本", "restore must snapshot canonical data first");
    assert(writes.at(-1)?.snapshots[0]?.name === "恢复前备份", "restore must retain the before-backup metadata");
    assert(clearCount === 1 && !store.pendingRecovery, "restore must clear the journal and pending state");
    store.pendingRecovery = { project: recovered, canonical: store.data, saved_at: "2999-09-21T00:00:00.000Z" };
    await store.resolvePendingRecovery("discard");
    assert(Number(clearCount) === 2 && !store.pendingRecovery, "discard must only clear the journal and pending state");
    assert(String(store.data.project.title) === "自动保存版本", "discard must keep the canonical project untouched");
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

Deno.test("native open releases a provisional lease when project data is malformed", async () => {
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
  globalThis.fetch = async () => { throw new Error("test fetch disabled"); };
  try {
    const { WorkbenchStore } = await import("../app/main.js?native-open-rollback-test");
    const closes: string[] = [];
    let projectDir = "A";
    const bridge = {
      projectDir,
      projectDirFromUrl: false,
      isNative: () => true,
      setProjectDir: (value: string) => { projectDir = value; bridge.projectDir = value; },
      restoreProjectDir: (value: string | null) => { projectDir = value || ""; bridge.projectDir = projectDir; },
      openProject: async () => ({ malformed: true }),
      readProject: async () => ({ malformed: true }),
      closeProject: async (value: string) => { closes.push(value); },
      saveSession: async () => {},
    };
    const store = new WorkbenchStore(bridge);
    await store.openProject("B");
    assert(closes.join(",") === "B", "malformed open must release the provisional target lease");
    assert(!store.hasNativeLease("B"), "failed open must clear the target lease bookkeeping");
    assert(projectDir === "", "failed open must restore the unselected project path");
  } finally {
    runtime.document = previousDocument;
    runtime.__TAURI__ = previousTauri;
    globalThis.fetch = previousFetch;
  }
});

Deno.test("native open does not close a lease when project_open rejects", async () => {
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
  globalThis.fetch = async () => { throw new Error("test fetch disabled"); };
  try {
    const { WorkbenchStore } = await import("../app/main.js?native-open-error-test");
    const closes: string[] = [];
    let projectDir = "A";
    const bridge = {
      projectDir,
      projectDirFromUrl: false,
      isNative: () => true,
      setProjectDir: (value: string) => { projectDir = value; bridge.projectDir = value; },
      restoreProjectDir: (value: string | null) => { projectDir = value || ""; bridge.projectDir = projectDir; },
      openProject: async () => { throw new Error("项目被其他实例占用"); },
      closeProject: async (value: string) => { closes.push(value); },
      saveSession: async () => {},
    };
    const store = new WorkbenchStore(bridge);
    await store.openProject("B");
    assert(closes.length === 0, "a rejected project_open must not release an unowned lease");
    assert(!store.hasNativeLease("B"), "a rejected project_open must not mark a lease");
    assert(projectDir === "", "failed open must restore the unselected project path");
  } finally {
    runtime.document = previousDocument;
    runtime.__TAURI__ = previousTauri;
    globalThis.fetch = previousFetch;
  }
});

Deno.test("native open keeps a null project result unleased", async () => {
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
  globalThis.fetch = async () => { throw new Error("test fetch disabled"); };
  try {
    const { WorkbenchStore } = await import("../app/main.js?native-open-null-test");
    const closes: string[] = [];
    let projectDir = "A";
    const bridge = {
      projectDir,
      projectDirFromUrl: false,
      isNative: () => true,
      setProjectDir: (value: string) => { projectDir = value; bridge.projectDir = value; },
      restoreProjectDir: (value: string | null) => { projectDir = value || ""; bridge.projectDir = projectDir; },
      openProject: async () => null,
      readProject: async () => null,
      closeProject: async (value: string) => { closes.push(value); },
      saveSession: async () => {},
    };
    const store = new WorkbenchStore(bridge);
    await store.openProject("B");
    assert(closes.length === 0, "a null project_open result must not trigger close");
    assert(!store.hasNativeLease("B"), "a null project_open result must not mark a lease");
    assert(projectDir === "", "failed open must restore the unselected project path");
  } finally {
    runtime.document = previousDocument;
    runtime.__TAURI__ = previousTauri;
    globalThis.fetch = previousFetch;
  }
});
