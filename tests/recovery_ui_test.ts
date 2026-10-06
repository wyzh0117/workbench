import {
  appendBlock,
  createDocument,
  createEmptyProjectData,
  initializeContentStatuses,
  now,
  type ProjectData,
} from "../src/domain/index.ts";
import { createSerialQueue, recoveryWarning } from "../app/recovery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type TestFingerprint = {
  exists: boolean;
  mtime_ms: number | null;
  size: number | null;
  hash: string | null;
};

function fingerprintFor(project: unknown, revision: number): TestFingerprint {
  return {
    exists: true,
    mtime_ms: 1_780_000_000_000 + revision,
    size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
    hash: revision.toString(16).padStart(64, "0"),
  };
}

function boundSaveAck(request: any, fingerprint: TestFingerprint) {
  return {
    project: structuredClone(request.project),
    fingerprint: structuredClone(fingerprint),
    recovery_warning: null,
    durability_warning: null,
    outcome: "written",
    commit_state: "committed",
    project_id: request.expected_project_id,
    project_dir: request.project_dir,
    lease_generation: request.lease_generation,
    editor_generation: request.editor_generation,
    operation_id: request.operation_id,
    revision: request.revision,
  };
}

function recoveryClearAck(request: any, fingerprint: TestFingerprint, cleared = true) {
  return {
    cleared,
    transaction_id: cleared ? request.expected_transaction_id : null,
    durability_warning: null,
    project_id: request.expected_project_id,
    project_dir: request.project_dir,
    lease_generation: request.lease_generation,
    editor_generation: request.editor_generation,
    operation_id: request.operation_id,
    revision: request.revision,
    fingerprint: structuredClone(fingerprint),
  };
}

const missingFingerprint: TestFingerprint = {
  exists: false,
  mtime_ms: null,
  size: null,
  hash: null,
};

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
  const revisions = new Map(Object.keys(projects).map((dir) => [dir, 1]));
  const leases = new Map<string, string>();
  const leaseFor = (dir: string | null) => dir ? leases.get(dir) ?? null : null;
  const getFingerprint = (dir: string | null): TestFingerprint => {
    if (!dir || !projects[dir]) return structuredClone(missingFingerprint);
    return fingerprintFor(projects[dir], revisions.get(dir) ?? 1);
  };
  const bridge: any = {
    projectDir: currentDir,
    projectDirFromUrl: false,
    lastOpenedProjectState: null,
    isNative: () => true,
    setProjectDir: (value: string) => {
      currentDir = value;
      bridge.projectDir = value;
    },
    restoreProjectDir: (value: string | null, _fromUrl = false, openedState: any = null) => {
      currentDir = value;
      bridge.projectDir = value;
      bridge.lastOpenedProjectState = openedState && openedState.project_dir === value
        ? structuredClone(openedState)
        : null;
    },
    openProjectState: async () => {
      if (currentDir && locked.has(currentDir)) throw new Error("project_locked: 项目已被占用");
      const project = currentDir ? projects[currentDir] : null;
      if (!project) throw new Error("项目目录不存在");
      const leaseGeneration = `lease:${currentDir}`;
      leases.set(currentDir!, leaseGeneration);
      const state = {
        project: structuredClone(project),
        project_id: project.project.id,
        project_dir: currentDir,
        lease_generation: leaseGeneration,
        fingerprint: getFingerprint(currentDir),
      };
      bridge.lastOpenedProjectState = structuredClone(state);
      return state;
    },
    openProject: async () => {
      const state = await bridge.openProjectState();
      return structuredClone(state.project);
    },
    readProject: async () => currentDir && projects[currentDir]
      ? structuredClone(projects[currentDir])
      : null,
    readProjectState: () => {
      const project = currentDir && projects[currentDir]
        ? structuredClone(projects[currentDir])
        : null;
      return {
        project,
        project_id: project?.project.id ?? null,
        project_dir: currentDir,
        lease_generation: bridge.lastOpenedProjectState?.project_dir === currentDir
          ? leaseFor(currentDir)
          : null,
        fingerprint: getFingerprint(currentDir),
      };
    },
    readRecoveryJournal: async () => null,
    listenNativeDrops: async () => () => {},
    writeRecoveryJournal: async () => {},
    writeProject: async (request: any) => {
      const project = request?.project;
      assert(currentDir && projects[currentDir], "bound save must target an opened project");
      assert(request.project_dir === currentDir, "save request must bind the active directory");
      assert(request.expected_project_id === projects[currentDir].project.id, "save request must bind the active project id");
      assert(request.lease_generation === leaseFor(currentDir), "save request must bind the active lease generation");
      assert(Number.isSafeInteger(request.editor_generation), "save request must carry its editor generation");
      assert(typeof request.operation_id === "string" && request.operation_id, "save request must carry its operation id");
      assert(Number.isSafeInteger(request.revision) && request.revision > 0, "save request must carry its revision");
      assert(request.recovery_metadata?.project_id === request.expected_project_id, "recovery metadata must bind the same project");
      assert(
        JSON.stringify(request.expected_fingerprint) === JSON.stringify(getFingerprint(currentDir)),
        "save request must compare against the current disk fingerprint",
      );
      assert(project?.project?.id === request.expected_project_id, "save body must match its bound project id");
      projects[currentDir] = structuredClone(project);
      revisions.set(currentDir, (revisions.get(currentDir) ?? 1) + 1);
      return boundSaveAck(request, getFingerprint(currentDir));
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
      leases.delete(projectDir);
    },
    command: async () => ({}),
  };
  if (currentDir && projects[currentDir]) {
    const leaseGeneration = `lease:${currentDir}`;
    leases.set(currentDir, leaseGeneration);
    bridge.lastOpenedProjectState = {
      project: structuredClone(projects[currentDir]),
      project_id: projects[currentDir].project.id,
      project_dir: currentDir,
      lease_generation: leaseGeneration,
      fingerprint: getFingerprint(currentDir),
    };
  }
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
    store.projectFingerprint = first.bridge.readProjectState().fingerprint;
    store.projectFingerprintGeneration = 1;
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
    store.projectFingerprint = first.bridge.readProjectState().fingerprint;
    store.projectFingerprintGeneration = 1;
    await store.persistSession(store.session());

    await store.openProject("B");
    await store.openProject("missing");
    assert(first.bridge.projectDir === "A", "missing or locked targets must restore the old path");
    assert(store.data.project.id === projects.A.project.id, "missing or locked targets must keep old data");
    assert(first.calls.every((call: string) => call !== "close:B" && call !== "close:missing"), "unopened targets must never be closed");
    assert(first.sessions.at(-1)?.project_dir === "A", "failed target opens must retain the old directory");
    assert(first.sessions.at(-1)?.project_id === projects.A.project.id, "failed target opens must retain the old identity");

    first.locked.delete("B");
    first.bridge.openProject = async () => {
      await first.bridge.openProjectState();
      return { malformed: true };
    };
    await store.openProject("B");
    assert(first.bridge.projectDir === "A", "malformed target data must roll back the old path");
    assert(first.calls.at(-1) === "close:B", "malformed target data must release its provisional target lease");
    assert(first.sessions.at(-1)?.project_dir === "A", "rollback must restore the complete old session");
    assert(first.sessions.at(-1)?.project_id === projects.A.project.id, "rollback must restore the old project ID");
    assert(first.sessions.at(-1)?.mode === "preview" && first.sessions.at(-1)?.route === "media", "rollback must restore old reader state");
    assert(first.bridge.lastOpenedProjectState?.project_dir === "A" && first.bridge.lastOpenedProjectState?.lease_generation === "lease:A", "rollback must restore the original live lease identity");
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
    const journals: Array<{ saved_at: string; canonical_revision: string; project: ProjectData }> = [];
    const writes: Array<Record<string, any>> = [];
    let sessionCount = 0;
    let store: InstanceType<typeof WorkbenchStore>;
    const bridge = {
      isNative: () => false,
      writeRecoveryJournal: async () => {},
      writeProject: async (request: typeof writes[number]) => {
        const snapshot = request.project;
        const journal = {
          ...request.recovery_metadata,
          project: structuredClone(snapshot),
        } as typeof journals[number];
        assert(request.expected_project_id === snapshot.project.id, "save request must bind the current project id");
        assert(typeof request.operation_id === "string" && request.operation_id, "save request must include an operation id");
        assert(Number.isSafeInteger(request.revision) && request.revision > 0, "save request must include a revision");
        writes.push(structuredClone(request));
        journals.push(structuredClone(journal));
        if (writes.length === 1) {
          store.data.project.title = "最新标题";
          store.markDirty();
        }
        return boundSaveAck(request, fingerprintFor(snapshot, writes.length));
      },
      clearRecoveryJournal: async () => {},
      saveSession: async () => { sessionCount += 1; },
    };
    store = new WorkbenchStore(bridge);
    store.data = switchProject("保存重试项目");
    store.trackProjectIdentity();
    store.projectFingerprint = structuredClone(missingFingerprint);
    store.projectFingerprintGeneration = 1;
    const saved = await store.flush();
    clearTimeout(store.saveTimer);
    assert(saved, `flush must succeed after retrying the changed snapshot (status=${store.saveStatus}, toast=${store.ui.toast}, writes=${writes.length})`);
    assert(writes.length === 2, "a mutation during the first save must trigger a second write");
    const latestWrite = writes.at(-1);
    const latestJournal = journals.at(-1);
    assert(latestWrite && latestJournal, "stable save must produce a latest write and journal");
    assert(latestWrite.project.project.title === "最新标题", "the second write must contain the latest data");
    assert(
      latestWrite.project.project.updated_at === store.data.project.updated_at &&
        latestJournal.canonical_revision === latestWrite.project.project.updated_at,
      "canonical and recovery journal metadata must share the latest revision",
    );
    assert(
      journals.length === writes.length &&
        journals.every((journal, index) =>
          journal.project.project.updated_at === writes[index]?.project.project.updated_at
        ),
      "each canonical retry must carry its matching recovery journal",
    );
    assert(sessionCount === 1, "only the stable save should finish the session");
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
    let fingerprint = structuredClone(missingFingerprint);
    let externalFingerprint = fingerprintFor(switchProject("外部磁盘项目"), 2);
    let store: InstanceType<typeof WorkbenchStore>;
    const bridge = {
      isNative: () => false,
      writeRecoveryJournal: async () => {},
      writeProject: async (request: any) => {
        assert(request.project?.project?.id === request.expected_project_id, "save body and expected project id must match");
        assert(typeof request.operation_id === "string" && request.operation_id, "save request must carry an operation id");
        assert(Number.isSafeInteger(request.revision) && request.revision > 0, "save request must carry its revision");
        if (shouldConflict) {
          const failure = new Error("保存已阻止") as Error & { code: string; details: Record<string, unknown> };
          failure.code = "external_modification_conflict";
          failure.details = {
            stage: "canonical_compare",
            commit_state: "not_committed",
            retryable: false,
            project_id: request.expected_project_id,
            project_dir: request.project_dir,
            editor_generation: request.editor_generation,
            operation_id: request.operation_id,
            revision: request.revision,
            expected_fingerprint: request.expected_fingerprint,
            fingerprint: externalFingerprint,
          };
          throw failure;
        }
        fingerprint = fingerprintFor(request.project, 3);
        return boundSaveAck(request, fingerprint);
      },
      inspectExternalModification: async () => ({
        changed: true,
        current: structuredClone(externalFingerprint),
        external_diff: { changed: true, entries: [{ path: "project.title" }] },
        local_diff: { changed: true, entries: [{ path: "project.description" }] },
      }),
      reloadExternalProject: async () => {
        const project = structuredClone(store.data);
        project.project.title = "磁盘版本";
        fingerprint = fingerprintFor(project, 2);
        externalFingerprint = structuredClone(fingerprint);
        return {
          project,
          project_id: project.project.id,
          fingerprint: structuredClone(fingerprint),
        };
      },
      clearRecoveryJournal: async () => {},
      saveSession: async () => {},
    };
    store = new WorkbenchStore(bridge);
    store.data = switchProject("本地项目");
    store.trackProjectIdentity();
    store.projectFingerprint = fingerprintFor(store.data, 1);
    store.projectFingerprintGeneration = 1;
    assert(!(await store.flush()), "autosave must report a blocked write");
    assert(store.externalConflict?.changed, "the UI must retain structured conflict state");
    assert(store.saveStatus === "外部修改冲突", "conflict must not look like a successful save");
    shouldConflict = false;
    await store.resolveExternalConflict("reload");
    assert(store.data.project.title === "磁盘版本", "reload must replace stale in-memory state");
    assert(!store.externalConflict, `reload must clear the resolved conflict (status=${store.saveStatus}, toast=${store.ui.toast})`);
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
    const backups: Array<Record<string, any>> = [];
    const writes: Array<Record<string, any>> = [];
    const clearRequests: Array<Record<string, any>> = [];
    let persisted: ProjectData | null = null;
    let journal: Record<string, unknown> | null = null;
    let allowBackup = false;
    let failCanonicalSave = false;
    let failClear = false;
    let diskFingerprint = structuredClone(missingFingerprint);
    let fingerprintRevision = 1;
    const leaseGeneration = "lease:recovery-project";
    const bridge: any = {
      projectDir: "/tmp/recovery-project",
      lastOpenedProjectState: null,
      isNative: () => true,
      loadSession: async () => null,
      readProject: async () => structuredClone(persisted),
      readProjectState: async () => ({
        project: structuredClone(persisted),
        project_id: (persisted as ProjectData | null)?.project.id ?? null,
        project_dir: "/tmp/recovery-project",
        lease_generation: bridge.lastOpenedProjectState?.lease_generation ?? null,
        fingerprint: structuredClone(diskFingerprint),
      }),
      openProjectState: async () => {
        const state = {
          project: structuredClone(persisted),
          project_id: (persisted as ProjectData | null)?.project.id ?? null,
          project_dir: "/tmp/recovery-project",
          lease_generation: leaseGeneration,
          fingerprint: structuredClone(diskFingerprint),
        };
        bridge.lastOpenedProjectState = structuredClone(state);
        return state;
      },
      restoreProjectDir: (value: string | null) => { bridge.projectDir = value; },
      readRecoveryJournal: async () => structuredClone(journal),
      listenNativeDrops: async () => () => {},
      writeRecoveryJournal: async () => {},
      writeProject: async (request: typeof writes[number] & Record<string, any>) => {
        const project = request.project;
        assert(
          JSON.stringify(request.expected_fingerprint) === JSON.stringify(diskFingerprint),
          "recovery restore must save from the adopted canonical baseline",
        );
        assert(request.project_dir === "/tmp/recovery-project", "recovery save must bind its project directory");
        assert(request.expected_project_id === project.project.id, "recovery save must bind its project id");
        assert(request.lease_generation === leaseGeneration, "recovery save must bind its active lease");
        assert(request.recovery_metadata?.project_id === project.project.id, "recovery journal metadata must bind the project");
        writes.push(structuredClone(request));
        if (failCanonicalSave) {
          const error = new Error("故障注入：正文保存未提交") as Error & {
            code: string;
            commit_state: string;
            retryable: boolean;
          };
          error.code = "save_io_failed";
          error.commit_state = "not_committed";
          error.retryable = true;
          throw error;
        }
        persisted = structuredClone(project);
        journal = null;
        diskFingerprint = fingerprintFor(project, ++fingerprintRevision);
        return boundSaveAck(request, diskFingerprint);
      },
      createSnapshot: async (input: typeof backups[number]) => {
        backups.push(structuredClone(input));
        if (!allowBackup) return { id: input.snapshot_id };
        return {
          id: input.snapshot_id,
          snapshot_id: input.snapshot_id,
          name: input.name,
          note: input.note,
          created_at: "2026-09-21T00:00:00.000Z",
          content_hash: "a".repeat(64),
          project_id: input.expected_project_id,
          project_dir: input.project_dir,
          lease_generation: input.lease_generation,
          editor_generation: input.editor_generation,
          operation_id: input.operation_id,
          revision: input.revision,
          persisted: true,
          outcome: "written",
        };
      },
      clearRecoveryJournal: async (request: Record<string, any>) => {
        clearRequests.push(structuredClone(request));
        assert(request.project_dir === "/tmp/recovery-project", "journal clear must bind its project directory");
        assert(request.expected_project_id === canonical.project.id, "journal clear must bind its project id");
        assert(request.lease_generation === leaseGeneration, "journal clear must bind its live lease");
        assert(typeof request.operation_id === "string" && request.operation_id, "journal clear must bind its operation id");
        assert(Number.isSafeInteger(request.editor_generation) && Number.isSafeInteger(request.revision), "journal clear must bind editor generation and revision");
        assert(request.expected_fingerprint.hash === diskFingerprint.hash, "journal clear must CAS the current canonical fingerprint");
        if (failClear) throw new Error("故障注入：日志未清理");
        assert(request.expected_transaction_id === journal?.transaction_id, "journal clear must match the exact visible transaction");
        journal = null;
        diskFingerprint = { ...diskFingerprint, mtime_ms: (diskFingerprint.mtime_ms ?? 0) + 1 };
        return recoveryClearAck(request, diskFingerprint);
      },
      saveSession: async () => {},
    };
    const store = new WorkbenchStore(bridge);
    const canonical = structuredClone(store.data);
    canonical.project.title = "磁盘版本";
    const recovered = structuredClone(canonical);
    recovered.project.title = "自动保存版本";
    persisted = canonical;
    diskFingerprint = fingerprintFor(canonical, fingerprintRevision);
    journal = {
      transaction_id: "recovery-txn-1",
      project_id: canonical.project.id,
      canonical_revision: canonical.project.updated_at,
      project: recovered,
      saved_at: "2999-09-21T00:00:00.000Z",
    };
    await store.initialize();
    assert(store.data.project.title === "磁盘版本", "startup must keep canonical data visible");
    assert(store.pendingRecovery?.project.project.title === "自动保存版本", "startup must retain the newer recovery candidate");
    assert(!(await store.flush()), "pending recovery must block an ordinary flush");
    await store.resolvePendingRecovery("restore");
    assert(String(store.data.project.title) === "磁盘版本", "an unconfirmed backup must not install the journal project");
    assert(writes.length === 0 && store.pendingRecovery, "an unconfirmed backup must leave canonical data and the recovery choice intact");
    const failedBackupRequest = structuredClone(backups[0]!);
    allowBackup = true;
    failCanonicalSave = true;
    await store.resolvePendingRecovery("restore");
    assert(String(store.data.project.title) === "自动保存版本", "a confirmed backup may install the journal project in memory");
    assert(Number(writes.length) === 1 && store.pendingRecovery, "a failed canonical write must keep the recovery decision pending");
    assert(journal?.transaction_id === "recovery-txn-1", "a failed canonical write must leave the exact recovery journal in place");
    assert(store.saveStatus === "保存失败", "a failed restore write must remain visibly unsaved");
    const failedRestoreWrite = structuredClone(writes.at(-1));
    assert(failedRestoreWrite, "the failed restore must retain its exact save request");
    const backup = backups.at(0);
    assert(backup && backup.project.project.title === "磁盘版本", "restore must snapshot canonical data first");
    const persistedBackupRequest = backups.at(-1);
    assert(persistedBackupRequest?.snapshot_id === failedBackupRequest.snapshot_id && persistedBackupRequest?.operation_id === failedBackupRequest.operation_id, "backup retries must reuse the stable operation identity");
    assert(persistedBackupRequest?.expected_project_id === canonical.project.id && persistedBackupRequest?.lease_generation === leaseGeneration, "backup create must bind the opened project and lease");
    assert(writes.at(-1)?.project.snapshots[0]?.name === "恢复前备份", "restore must retain the before-backup metadata");
    store.data.project.title = "恢复失败后新增的草稿";
    const writesBeforeChangedDraftRetry = writes.length;
    await store.resolvePendingRecovery("restore");
    assert(writes.length === writesBeforeChangedDraftRetry, "a changed draft must not be sent as a retry of the failed recovery write");
    assert(store.data.project.title === "恢复失败后新增的草稿" && store.pendingRecovery, "a stale recovery retry must preserve the newer local draft and pending journal");
    store.data = structuredClone(failedRestoreWrite.project);
    failCanonicalSave = false;
    await store.resolvePendingRecovery("restore");
    assert(writes.at(-1)?.project.project.title === "自动保存版本", "retry must persist the recovered project");
    assert(writes.at(-1)?.operation_id === failedRestoreWrite.operation_id, "retry must replay the same write operation");
    assert(writes.at(-1)?.revision === failedRestoreWrite.revision, "retry must keep the same monotonic draft revision");
    assert(writes.at(-1)?.editor_generation === failedRestoreWrite.editor_generation, "retry must stay in the same editor generation");
    assert(JSON.stringify(writes.at(-1)?.expected_fingerprint) === JSON.stringify(failedRestoreWrite.expected_fingerprint), "retry must preserve the original CAS fingerprint");
    assert(JSON.stringify(writes.at(-1)?.project) === JSON.stringify(failedRestoreWrite.project), "retry must replay the exact failed project snapshot");
    assert(backups.length === 2, "retrying the write must not create a second backup");
    assert(!store.pendingRecovery && journal === null, `successful restore must save and clear pending (pending=${Boolean(store.pendingRecovery)}, journal=${journal?.transaction_id}, status=${store.saveStatus}, toast=${store.ui.toast}, writes=${writes.length})`);

    const preserved = structuredClone(store.data);
    const keepCandidate = structuredClone(preserved);
    keepCandidate.project.title = "另一个暂存候选";
    journal = {
      transaction_id: "recovery-txn-2",
      project_id: canonical.project.id,
      canonical_revision: preserved.project.updated_at,
      project: keepCandidate,
      saved_at: "2999-09-22T00:00:00.000Z",
    };
    store.pendingRecovery = {
      project: keepCandidate,
      canonical: structuredClone(preserved),
      transaction_id: "recovery-txn-2",
      project_id: canonical.project.id,
      canonical_revision: preserved.project.updated_at,
      saved_at: "2999-09-22T00:00:00.000Z",
    };
    failClear = true;
    const writeCountBeforeClear = writes.length;
    await store.resolvePendingRecovery("discard");
    assert(store.pendingRecovery && journal?.transaction_id === "recovery-txn-2", "a failed clear acknowledgment must keep the prompt and exact journal");
    assert(JSON.stringify(store.data) === JSON.stringify(preserved), "failed clear must not change in-memory canonical data");
    failClear = false;
    await store.resolvePendingRecovery("discard");
    assert(clearRequests.at(-1)?.expected_transaction_id === "recovery-txn-2", "discard must clear only the visible journal transaction");
    assert(writes.length === writeCountBeforeClear, "discard must not write Canonical");
    assert(!store.pendingRecovery && journal === null, "a matching clear acknowledgment must close the prompt");
    assert(String(store.saveStatus) === "已保存", "keeping the disk version without editing must retain the saved status");
    assert(store.projectFingerprint.mtime_ms === diskFingerprint.mtime_ms, "a matching clear ack must adopt the actual locked fingerprint even when only mtime changed");
    assert(String(store.data.project.title) === "自动保存版本", "discard must keep the committed Canonical project untouched");
  } finally {
    runtime.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});

Deno.test("browser startup keeps the recovery journal returned with open state", async () => {
  const runtime = globalThis as typeof globalThis & { document?: unknown; __TAURI__?: unknown };
  const previousDocument = runtime.document;
  const previousTauri = runtime.__TAURI__;
  const previousFetch = globalThis.fetch;
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  runtime.document = { querySelector: () => root, addEventListener: () => undefined };
  runtime.__TAURI__ = undefined;
  globalThis.fetch = async () => { throw new Error("test fetch disabled"); };
  try {
    const { WorkbenchStore } = await import("../app/main.js?browser-open-recovery-state-test");
    const canonical = switchProject("浏览器磁盘版本");
    const recovered = structuredClone(canonical);
    recovered.project.title = "浏览器暂存版本";
    const journal = {
      project_id: canonical.project.id,
      canonical_revision: canonical.project.updated_at,
      saved_at: "2999-09-21T00:00:00.000Z",
      project: recovered,
    };
    let recoveryFallbackCalls = 0;
    const bridge: any = {
      projectDir: "/tmp/browser-recovery-project",
      isNative: () => false,
      openProjectState: async () => ({
        project: structuredClone(canonical),
        project_id: canonical.project.id,
        project_dir: "/tmp/browser-recovery-project",
        lease_generation: "browser-lease",
        fingerprint: fingerprintFor(canonical, 1),
        recovery_journal: structuredClone(journal),
      }),
      openSession: async () => ({ session: null, session_generation: 1, revision: 0 }),
      loadSession: async () => null,
      readRecoveryJournal: async () => {
        recoveryFallbackCalls += 1;
        return null;
      },
      command: async (name: string) => {
        if (name === "registry.list") return { projects: [] };
        if (name === "ai.connection.list") return { providers: [] };
        if (name === "ai.execution.list") return [];
        return {};
      },
    };
    const store: any = new WorkbenchStore(bridge);
    await store.initialize();
    assert(store.data.project.title === "浏览器磁盘版本", "startup must keep the canonical project visible");
    assert(
      store.pendingRecovery?.project.project.title === "浏览器暂存版本",
      "startup must retain the recovery journal from the same open-state snapshot",
    );
    assert(recoveryFallbackCalls === 0, "a returned recovery_journal must not be replaced by a second read");
    assert(!(await store.flush()), "the visible recovery choice must block an ordinary save");
    clearTimeout(store.saveTimer);
    clearTimeout(store.sessionTimer);
  } finally {
    runtime.document = previousDocument;
    runtime.__TAURI__ = previousTauri;
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
    let currentDir = "A";
    const projectA = switchProject("项目 A");
    const projectB = switchProject("项目 B");
    const projects = { A: projectA, B: projectB };
    const leases = new Map<string, string>([["A", "lease:A"]]);
    const bridge: any = {
      projectDir: "A",
      projectDirFromUrl: false,
      lastOpenedProjectState: {
        project: structuredClone(projectA),
        project_id: projectA.project.id,
        project_dir: "A",
        lease_generation: "lease:A",
        fingerprint: fingerprintFor(projectA, 1),
      },
      isNative: () => true,
      setProjectDir: (value: string) => { currentDir = value; bridge.projectDir = value; },
      restoreProjectDir: (value: string | null, _fromUrl = false, openedState: any = null) => {
        currentDir = value || "";
        bridge.projectDir = currentDir;
        bridge.lastOpenedProjectState = openedState && openedState.project_dir === currentDir
          ? structuredClone(openedState)
          : null;
      },
      openProjectState: async () => {
        const project = projects[currentDir as "A" | "B"];
        const leaseGeneration = `lease:${currentDir}`;
        leases.set(currentDir, leaseGeneration);
        const state = {
          project: structuredClone(project),
          project_id: project.project.id,
          project_dir: currentDir,
          lease_generation: leaseGeneration,
          fingerprint: fingerprintFor(project, currentDir === "B" ? 2 : 1),
        };
        bridge.lastOpenedProjectState = structuredClone(state);
        return state;
      },
      openProject: async () => {
        const state = await bridge.openProjectState();
        return structuredClone(state.project);
      },
      readProjectState: async () => {
        const project = structuredClone(projects[currentDir as "A" | "B"]);
        return {
          project,
          project_id: project.project.id,
          project_dir: currentDir,
          lease_generation: bridge.lastOpenedProjectState?.project_dir === currentDir
            ? leases.get(currentDir)
            : null,
          fingerprint: fingerprintFor(project, currentDir === "B" ? 2 : 1),
        };
      },
      saveSession: async (session: { project_dir: string | null }) => { sessions.push(session); },
      writeRecoveryJournal: async () => {},
      writeProject: async (request: any) => {
        assert(request.project_dir === currentDir, "save must target the active directory");
        assert(request.expected_project_id === request.project.project.id, "save must bind the project id");
        assert(request.lease_generation === leases.get(currentDir), "save must bind the active lease generation");
        const project = structuredClone(request.project);
        return boundSaveAck(request, fingerprintFor(project, 3));
      },
      clearRecoveryJournal: async () => {},
      closeProject: async (projectDir: string) => {
        calls.push(`close:${projectDir}`);
        if (projectDir === "A") throw new Error("old lease close failed");
        leases.delete(projectDir);
      },
    };
    store = new WorkbenchStore(bridge);
    store.data = structuredClone(projectA);
    store.trackProjectIdentity();
    store.markNativeLease("A");
    store.projectFingerprint = fingerprintFor(store.data, 1);
    store.projectFingerprintGeneration = 1;
    await store.openProject("B");
    assert(calls.join(",") === "close:A,close:B", "switch failure must close the target rollback lease");
    assert(bridge.projectDir === "A", "switch failure must restore the original project path");
    assert(sessions.at(-1)?.project_dir === "A", "switch rollback must persist the original project path");
    assert(store.hasNativeLease("A") && !store.hasNativeLease("B"), "failed switch must not leave two active leases");
    assert(store.saveIdentity().lease_generation === "lease:A", "rollback must restore A's captured lease generation");
    assert(!store.nativeSwitchPending, "a successful target rollback must not leave a pending switch");
    assert(await store.flush(), "the restored A lease must permit the next bound save");
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
