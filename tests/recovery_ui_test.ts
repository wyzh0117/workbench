import {
  appendBlock,
  createDocument,
  createEmptyProjectData,
  initializeContentStatuses,
  now,
} from "../src/domain/index.ts";
import { createSerialQueue, recoveryWarning } from "../app/recovery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function switchProject(title: string): any {
  const data = createEmptyProjectData(title);
  const stage = data.stages[0];
  const contentId = crypto.randomUUID();
  const document = createDocument(data, contentId);
  data.content_items.push({
    id: contentId,
    project_id: data.project.id,
    stage_id: stage?.id ?? null,
    code: "S01-01",
    title: `${title} 第一课`,
    type: "lesson",
    description: "",
    order_index: 0,
    document_id: document.id,
    archived: false,
    created_at: now(),
    updated_at: now(),
  });
  initializeContentStatuses(data, contentId);
  appendBlock(data, contentId, "paragraph", `${title} 正文`);
  return data;
}

function nativeSwitchBridge(
  projects: Record<string, any>,
  initialDir: string | null,
  persistedSession: any = null,
) {
  let currentDir = initialDir;
  let latestSession = persistedSession ? structuredClone(persistedSession) : null;
  const sessions: any[] = [];
  const calls: string[] = [];
  const locked = new Set<string>();
  const bridge: any = {
    projectDir: currentDir,
    projectDirFromUrl: false,
    isNative: () => true,
    setProjectDir: (value: string) => {
      currentDir = value;
      bridge.projectDir = value;
    },
    restoreProjectDir: (value: string | null) => {
      currentDir = value;
      bridge.projectDir = value;
    },
    openProject: async () => {
      if (currentDir && locked.has(currentDir)) throw new Error("project_locked: 项目已被占用");
      const project = currentDir ? projects[currentDir] : null;
      if (!project) throw new Error("项目目录不存在");
      return structuredClone(project);
    },
    readProject: async () => currentDir && projects[currentDir]
      ? structuredClone(projects[currentDir])
      : null,
    readRecoveryJournal: async () => null,
    listenNativeDrops: async () => () => {},
    writeRecoveryJournal: async () => {},
    writeProject: async (project: any) => {
      if (currentDir) projects[currentDir] = structuredClone(project);
    },
    clearRecoveryJournal: async () => {},
    projectIdentity: async () => currentDir && projects[currentDir]
      ? projects[currentDir].project.id
      : null,
    saveSession: async (session: any) => {
      const payload = structuredClone(session);
      if (payload.project_dir) {
        const project = projects[payload.project_dir];
        assert(project != null, `session must not point at an unknown directory: ${payload.project_dir}`);
        assert(
          payload.project_id === project.project.id,
          `session identity mismatch for ${payload.project_dir}`,
        );
      }
      sessions.push(payload);
      latestSession = payload;
    },
    loadSession: async () => {
      if (!currentDir && latestSession?.project_dir) {
        currentDir = latestSession.project_dir;
        bridge.projectDir = currentDir;
      }
      return latestSession ? structuredClone(latestSession) : null;
    },
    closeProject: async (projectDir: string) => {
      calls.push(`close:${projectDir}`);
    },
    command: async () => ({}),
  };
  return { bridge, sessions, calls, locked };
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

Deno.test("native project transitions keep A to B to A reader positions and session identities", async () => {
  const runtime = globalThis as typeof globalThis & { document?: unknown; __TAURI__?: unknown };
  const previousDocument = runtime.document;
  const previousTauri = runtime.__TAURI__;
  const previousFetch = globalThis.fetch;
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
  };
  runtime.document = {
    querySelector: () => root,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  runtime.__TAURI__ = undefined;
  globalThis.fetch = async () => { throw new Error("test fetch disabled"); };
  try {
    const { WorkbenchStore } = await import("../app/main.js?native-transition-identity-test");
    const projects: Record<"A" | "B", any> = { A: switchProject("项目 A"), B: switchProject("项目 B") };
    const first = nativeSwitchBridge(projects, "A");
    const store: any = new WorkbenchStore(first.bridge);
    store.data = structuredClone(projects.A);
    store.trackProjectIdentity();
    store.ui.screen = "project";
    store.ui.activeId = projects.A.content_items[0].id;
    store.ui.mode = "structure";
    store.ui.rightPanel = "media";
    store.ui.route = "media";
    store.tabs = [{ content_item_id: store.ui.activeId, mode: "structure", pinned: true, scroll_top: 42 }];
    store.markNativeLease("A");
    await store.persistSession(store.session());

    await store.openProject("B");
    assert(first.bridge.projectDir === "B", "successful switch must point at B");
    assert(store.data.project.id === projects.B.project.id, "B must be canonical in memory after the switch");
    assert(store.ui.activeId === projects.B.content_items[0].id, "B must not inherit A's active lesson");
    assert(store.ui.mode === "writing", "B without a saved position must use its default mode");

    store.ui.mode = "preview";
    store.ui.rightPanel = "status";
    store.ui.route = "publish";
    store.ui.activeId = projects.B.content_items[0].id;
    await store.flush();
    await store.openProject("A");
    assert(first.bridge.projectDir === "A", "second switch must return to A");
    assert(store.data.project.id === projects.A.project.id, "A must be canonical after returning");
    assert(store.ui.activeId === projects.A.content_items[0].id, "A's saved lesson must return");
    assert(store.ui.mode === "structure", "A's saved mode must return");
    assert(store.ui.rightPanel === "media", "A's saved panel must return");
    assert(store.ui.route === "media", "A's saved route must return");
    assert(store.tabs[0]?.pinned === true && store.tabs[0]?.scroll_top === 42, "A's saved tab position must return");

    // Immediate save and close must continue to use the committed A identity.
    await store.flush();
    assert(first.sessions.at(-1)?.project_dir === "A", "immediate save must persist A, not the previous target");
    assert(first.sessions.at(-1)?.project_id === projects.A.project.id, "immediate save must persist A's ID");
    await store.closeNativeProject("A");
    assert(!store.hasNativeLease("A"), "immediate close must release only A's owned lease");

    for (const payload of first.sessions) {
      if (!payload.project_dir) continue;
      const project = projects[payload.project_dir as "A" | "B"];
      assert(project != null, "every persisted directory must be a known project");
      assert(payload.project_id === project.project.id, "every persisted top-level session must match its directory");
      for (const [id, record] of Object.entries(payload.project_sessions || {}) as Array<[string, any]>) {
        const recordProject = projects[record.project_dir as "A" | "B"];
        assert(recordProject != null, "nested session records must point at known projects");
        assert(id === record.project_id, "nested session key must match project_id");
        assert(record.project_id === recordProject.project.id, "nested session identity must match its directory");
      }
    }

    const restart = nativeSwitchBridge(projects, null, first.sessions.at(-1));
    const restarted: any = new WorkbenchStore(restart.bridge);
    await restarted.initialize();
    assert(restart.bridge.projectDir === "A", "restart must select the last committed project");
    assert(restarted.data.project.id === projects.A.project.id, "restart must load the committed project");
    assert(restarted.ui.activeId === projects.A.content_items[0].id, "restart must restore A's reading position");
    assert(restarted.ui.mode === "structure" && restarted.ui.route === "media", "restart must restore A's mode and view");
  } finally {
    runtime.document = previousDocument;
    runtime.__TAURI__ = previousTauri;
    globalThis.fetch = previousFetch;
  }
});

Deno.test("native failed transitions keep the old session for missing, invalid, and locked targets", async () => {
  const runtime = globalThis as typeof globalThis & { document?: unknown; __TAURI__?: unknown };
  const previousDocument = runtime.document;
  const previousTauri = runtime.__TAURI__;
  const previousFetch = globalThis.fetch;
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
  };
  runtime.document = {
    querySelector: () => root,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  runtime.__TAURI__ = undefined;
  globalThis.fetch = async () => { throw new Error("test fetch disabled"); };
  try {
    const { WorkbenchStore } = await import("../app/main.js?native-transition-failure-test");
    const projects: Record<"A" | "B", any> = { A: switchProject("项目 A"), B: switchProject("项目 B") };
    const first = nativeSwitchBridge(projects, "A");
    first.locked.add("B");
    const store: any = new WorkbenchStore(first.bridge);
    store.data = structuredClone(projects.A);
    store.trackProjectIdentity();
    store.ui.activeId = projects.A.content_items[0].id;
    store.ui.mode = "preview";
    store.ui.route = "media";
    store.markNativeLease("A");
    await store.persistSession(store.session());

    await store.openProject("B");
    await store.openProject("missing");
    assert(first.bridge.projectDir === "A", "missing or locked targets must restore the old path");
    assert(store.data.project.id === projects.A.project.id, "missing or locked targets must keep old data");
    assert(first.calls.every((call: string) => call !== "close:B" && call !== "close:missing"), "unopened targets must never be closed");
    assert(first.sessions.at(-1)?.project_dir === "A", "failed target opens must retain the old directory");
    assert(first.sessions.at(-1)?.project_id === projects.A.project.id, "failed target opens must retain the old identity");

    first.locked.delete("B");
    first.bridge.openProject = async () => ({ malformed: true });
    await store.openProject("B");
    assert(first.bridge.projectDir === "A", "malformed target data must roll back the old path");
    assert(first.calls.at(-1) === "close:B", "malformed target data must release its provisional target lease");
    assert(first.sessions.at(-1)?.project_dir === "A", "rollback must restore the complete old session");
    assert(first.sessions.at(-1)?.project_id === projects.A.project.id, "rollback must restore the old project ID");
    assert(first.sessions.at(-1)?.mode === "preview" && first.sessions.at(-1)?.route === "media", "rollback must restore old reader state");
    assert(store.data.project.id === projects.A.project.id && store.ui.mode === "preview", "rollback must keep old in-memory reader state");
  } finally {
    runtime.document = previousDocument;
    runtime.__TAURI__ = previousTauri;
    globalThis.fetch = previousFetch;
  }
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
