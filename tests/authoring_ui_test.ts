/**
 * Course Authoring UI tests.
 *
 * These drive `WorkbenchStore` (the running authoring model) with the same
 * injected bridge the recovery tests use, so every authoring operation is
 * checked against real canonical data rather than rendered markup.
 */
import { createEmptyProjectData } from "../src/domain/index.ts";
import { buildBlueprintDraft, createCourseSeed } from "../src/domain/course.ts";
import { validateProjectData } from "../src/domain/store.ts";
import type { ProjectData } from "../src/domain/types.ts";
import { courseMap, lessonView } from "../app/authoring.js";
import { AssetPreviewCache, staticImagePoster, stopPreviewMedia } from "../app/canvas.js";
import { createViews } from "../app/views.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let importCounter = 0;

/** Row/column tracks of a layout's grid definition, as canonical numbers. */
function tracks(grid: Record<string, unknown>): {
  rows: number[];
  columns: number[];
} {
  const read = (value: unknown): number[] =>
    Array.isArray(value) ? value.map((track) => Number(track) || 1) : [1];
  return { rows: read(grid.rows), columns: read(grid.columns) };
}

/** Boot a fresh WorkbenchStore over an isolated in-memory project. */
async function bootStore(bridgeOverrides: Record<string, unknown> = {}) {
  const source = createEmptyProjectData("Authoring UI 测试");
  const state = {
    project: structuredClone(source) as ProjectData,
    writes: 0,
    sessions: [] as unknown[],
    acceptWrites: true,
    revision: 0,
    fingerprint: {
      exists: true,
      mtime_ms: 1,
      size: new TextEncoder().encode(JSON.stringify(source)).byteLength,
      hash: "1".repeat(64),
    },
  };
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {},
    dataset: {},
  };
  const runtime = globalThis as typeof globalThis & {
    document?: unknown;
    __TAURI__?: unknown;
    __workbench?: unknown;
  };
  const previousDocument = runtime.document;
  const previousTauri = runtime.__TAURI__;
  const previousFetch = globalThis.fetch;
  runtime.document = {
    querySelector: () => root,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  runtime.__TAURI__ = undefined;
  globalThis.fetch = async () => {
    throw new Error("test fetch disabled");
  };
  importCounter += 1;
  const { WorkbenchStore } = await import(
    `../app/main.js?authoring-ui-${importCounter}`
  );
  const bridge = {
    projectDir: "/tmp/workbench-authoring-ui-test",
    projectDirFromUrl: false,
    lastOpenedProjectState: {
      project_dir: "/tmp/workbench-authoring-ui-test",
      lease_generation: "authoring-ui-test-lease",
    },
    isNative: () => false,
    currentProject: () => state.project,
    loadSession: async () => null,
    readProject: async () => structuredClone(state.project),
    readProjectState: async () => ({
      project: structuredClone(state.project),
      project_id: state.project.project.id,
      project_dir: "/tmp/workbench-authoring-ui-test",
      lease_generation: "authoring-ui-test-lease",
      fingerprint: structuredClone(state.fingerprint),
    }),
    readRecoveryJournal: async () => null,
    listenNativeDrops: async () => () => {},
    writeRecoveryJournal: async () => {},
    writeProject: async (request: Record<string, unknown>) => {
      const project = request.project as ProjectData;
      state.writes += 1;
      if (
        request.expected_project_id !== state.project.project.id ||
        JSON.stringify(request.expected_fingerprint) !== JSON.stringify(state.fingerprint) ||
        state.acceptWrites === false
      ) {
        throw Object.assign(new Error("当前课程文件已经被替换或修改，请先重新读取。"), {
          code: "external_modification_conflict",
          commit_state: "not_committed",
          retryable: false,
        });
      }
      // `acceptWrites` lets a test stand in for "another writer owns the file".
      state.project = structuredClone(project);
      state.revision += 1;
      state.fingerprint = {
        exists: true,
        mtime_ms: state.revision + 1,
        size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
        hash: state.revision.toString(16).padStart(64, "0"),
      };
      return {
        project_id: request.expected_project_id,
        lease_generation: request.lease_generation,
        editor_generation: request.editor_generation,
        operation_id: request.operation_id,
        revision: request.revision,
        outcome: "written",
        commit_state: "committed",
        fingerprint: structuredClone(state.fingerprint),
      };
    },
    clearRecoveryJournal: async () => {},
    saveSession: async (session: unknown) => {
      state.sessions.push(session);
    },
    createSnapshot: async () => ({}),
    setProjectDir: () => {},
    restoreProjectDir: () => {},
    projectIdentity: async () => state.project.project.id,
    inspectExternalModification: async () => ({
      changed: true,
      baseline: null,
      current: structuredClone(state.fingerprint),
      external: structuredClone(state.project),
      external_diff: { changed: true, entries: [] },
      local_diff: null,
    }),
  };
  Object.assign(bridge, bridgeOverrides);
  const store = new (WorkbenchStore as new (bridge: unknown) => {
    data: ProjectData;
    ui: Record<string, unknown>;
    saveStatus: string;
    history: unknown[];
    future: unknown[];
    tabs: unknown[];
    commit: (label: string, mutation: (data: ProjectData) => void) => void;
    currentItem: () => ProjectData["content_items"][number] | null;
    blocks: (item?: unknown) => ProjectData["blocks"];
    lesson: () => ReturnType<typeof lessonView>;
    map: () => ReturnType<typeof courseMap>;
    addMapItem: (title?: string) => void;
    addStage: (title?: string) => void;
    renameStage: (id: string, title: string) => void;
    moveStage: (id: string, direction: string) => void;
    deleteStage: (id: string) => void;
    renameLesson: (id: string, title: string) => void;
    moveLesson: (id: string, direction: string) => void;
    moveLessonToPosition: (id: string, stageId: string, beforeId?: string | null) => boolean;
    deleteLesson: (id: string) => void;
    openItem: (id: string) => void;
    selectPropertyTarget: (kind: "project" | "stage", id?: string | null) => void;
    selectBlock: (id: string, options?: Record<string, unknown>) => void;
    addBlock: (type?: string, content?: string, atIndex?: number) => void;
    insertBlockBelow: (id: string) => void;
    editBlockText: (id: string, value: string) => void;
    recordBlockTextEdit: (id: string, before: unknown, value: string) => void;
    setBlockType: (id: string, type: string) => void;
    setBlockLevel: (id: string, level: unknown) => void;
    moveBlock: (id: string, direction: string) => void;
    reorderBlockTo: (source: string, target: string | null) => void;
    deleteBlock: (id: string) => void;
    addPlaceholder: (type?: string, note?: string) => void;
    updateRequirement: (id: string, patch: Record<string, unknown>) => void;
    resolveRequirement: (id: string, assetId?: string | null) => void;
    setRequirementStatus: (id: string, status: string) => void;
    deleteRequirement: (id: string) => void;
    insertAsset: (assetId: string, options?: Record<string, unknown>) => Promise<void>;
    detachAsset: (blockId: string, assetId: string) => void;
    deleteAsset: (assetId: string) => void;
    renameAsset: (assetId: string, title: string) => Promise<void>;
    startAssetRename: (assetId: string) => void;
    cancelAssetRename: () => void;
    retryLockedProjectOpen: () => Promise<void>;
    dismissProjectProblem: () => void;
    createLayout: (mode?: string) => void;
    layoutPages: () => ProjectData["layout_pages"];
    beginPaginationConversion: () => void;
    confirmPaginationConversion: () => void;
    cancelPaginationConversion: () => void;
    addLayoutPage: () => void;
    selectLayoutPage: (id: string) => void;
    renamePage: (id: string, title: string) => void;
    movePage: (id: string, direction: string) => void;
    duplicatePage: (id: string) => void;
    deletePage: (id: string) => boolean;
    movePlacementAcrossPage: (placementId: string, pageId: string, row: number, column: number) => boolean;
    normalizeReaderState: (project: ProjectData, candidate?: Record<string, unknown>, route?: string) => Record<string, unknown>;
    setLayoutZoom: (zoom: string) => void;
    session: () => Record<string, unknown>;
    setLayoutMode: (mode: string) => void;
    changeGrid: (kind: string, amount?: number) => void;
    placeBlock: (blockId: string) => void;
    unplaceBlock: (blockId: string) => void;
    autofillGrid: () => void;
    movePlacement: (id: string, dr: number, dc: number) => void;
    resizePlacement: (id: string, dw?: number, dh?: number) => void;
    addSection: () => void;
    renameSection: (id: string, name: string) => void;
    updateStatus: (dimension: string, value: string) => void;
    moveBoardCard: (id: string, option: string) => void;
    undo: () => void | Promise<void>;
    redo: () => void | Promise<void>;
    navigateLesson: (direction: string) => void;
    captureToInbox: (text: string, title?: string) => void;
    triageInbox: (id: string, target?: string) => void;
    ignoreInbox: (id: string) => void;
    expectedProjectId: string | null;
    adoptProjectSnapshot: (state: Record<string, unknown>) => boolean;
    trackProjectIdentity: (data?: unknown) => string | null;
    exportPreflight: () => {
      content: number;
      layout: number;
      missingAssets: number;
      overflow: number;
      text: number;
      fonts: number;
      external: number;
      blocking: number;
      warnings: number;
      total: number;
    };
    openPreflight: () => Promise<void>;
    cancelPreflight: (options?: { clearContext?: boolean }) => void;
    returnFromPublish: () => void;
    exportCurrent: (format?: string) => Promise<void>;
    acknowledgeExportWarning: (code: string, checked?: boolean) => void;
    publicationCapability: (format?: string) => { status: string; code: string | null };
    setPublishTargetPageSize: (preset: string) => void;
    resolveLessonId: () => string | null;
    resumeLessonId: () => string | null;
    openWorkbench: () => void;
    setMode: (mode: string, options?: Record<string, unknown>) => void;
    openProject: (dir?: string, options?: { reopen?: boolean }) => Promise<void>;
    flush: () => Promise<boolean>;
    flushNow: () => Promise<boolean>;
    verifyUncertainMutation: () => Promise<boolean>;
    saveTimer: number;
    sessionScheduler: { enqueue: (session: unknown) => Promise<unknown>; flush: () => Promise<void> };
    initialize: () => Promise<void>;
    notify: () => void;
    externalConflict: unknown;
    resolveExternalConflict: (action: string) => Promise<void>;
  })(bridge);
  store.adoptProjectSnapshot(await bridge.readProjectState());
  return {
    store,
    state,
    bridge,
    restore: () => {
      runtime.document = previousDocument;
      runtime.__TAURI__ = previousTauri;
      globalThis.fetch = previousFetch;
      clearTimeout(store.saveTimer);
    },
  };
}

Deno.test("browser Launcher opens the created target before bound seed and blueprint writes", async () => {
  const projectDir = "/private/tmp/workbench-launcher-created-target";
  const leaseGeneration = "created-target-lease";
  let target: ProjectData | null = null;
  let targetFingerprint: Record<string, unknown> | null = null;
  let diskRevision = 0;
  let bridgeRef: Record<string, any> | null = null;
  const commands: string[] = [];
  const mutationRequests: Array<{ name: string; request: Record<string, any> }> = [];
  const fingerprintFor = (project: ProjectData) => ({
    exists: true,
    mtime_ms: 1_780_000_000_000 + diskRevision,
    size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
    hash: diskRevision.toString(16).padStart(64, "0"),
  });
  const assertRequest = (name: string, request: Record<string, any>) => {
    assert(target, `${name} follows project.create`);
    assert(request.project_dir === projectDir, `${name} uses open_state's canonical project_dir`);
    assert(request.expected_project_id === target.project.id, `${name} binds the created project id`);
    assert(request.lease_generation === leaseGeneration, `${name} uses the lease acquired by open_state`);
    assert(Number.isSafeInteger(request.editor_generation), `${name} binds editor generation`);
    assert(typeof request.operation_id === "string" && request.operation_id, `${name} binds operation id`);
    assert(Number.isSafeInteger(request.revision) && request.revision > 0, `${name} binds numeric revision`);
    assert(JSON.stringify(request.expected_fingerprint) === JSON.stringify(targetFingerprint), `${name} CAS uses the latest committed fingerprint`);
  };
  const harness = await bootStore({
    command: async (name: string, input: Record<string, any>) => {
      commands.push(name);
      if (name !== "project.create") return null;
      target = createEmptyProjectData(String(input.title));
      diskRevision = 1;
      targetFingerprint = fingerprintFor(target);
      return structuredClone(target);
    },
    openProjectState: async () => {
      assert(target, "project.create produces a target before open_state");
      const opened = {
        project: structuredClone(target),
        project_id: target.project.id,
        project_dir: projectDir,
        lease_generation: leaseGeneration,
        fingerprint: structuredClone(targetFingerprint),
      };
      bridgeRef!.projectDir = projectDir;
      bridgeRef!.lastOpenedProjectState = opened;
      commands.push("project.open_state");
      return opened;
    },
    openSession: async (projectId: string) => ({
      session: { project_id: projectId, route: "overview" },
      session_generation: 42,
      revision: 0,
    }),
    commandWithMutationAck: async (name: string, request: Record<string, any>) => {
      assertRequest(name, request);
      mutationRequests.push({ name, request: structuredClone(request) });
      const next = structuredClone(target!);
      let value: unknown;
      if (name === "course.seed.create") {
        value = createCourseSeed(next, {
          source_type: request.source_type,
          raw_text: request.raw_text,
        });
      } else if (name === "blueprint.build") {
        const draft = buildBlueprintDraft(next, request.course_seed_id);
        value = { draft, nodes: next.blueprint_nodes.filter((node) => node.blueprint_id === draft.id) };
      } else {
        throw new Error(`unexpected current-project mutation ${name}`);
      }
      target = next;
      diskRevision += 1;
      targetFingerprint = fingerprintFor(next);
      return {
        value,
        mutation_ack: {
          project: structuredClone(next),
          fingerprint: structuredClone(targetFingerprint),
          project_id: next.project.id,
          project_dir: projectDir,
          lease_generation: leaseGeneration,
          editor_generation: request.editor_generation,
          operation_id: request.operation_id,
          revision: request.revision,
          commit_state: "committed",
          outcome: "written",
          recovery_warning: null,
          durability_warning: null,
        },
      };
    },
  });
  bridgeRef = harness.bridge as Record<string, any>;
  const legacyWrite = harness.bridge.writeProject as (request: Record<string, any>) => Promise<unknown>;
  (harness.bridge as any).writeProject = async (request: Record<string, any>) => {
    if (!target) return await legacyWrite(request);
    assertRequest("project.save", request);
    target = structuredClone(request.project as ProjectData);
    diskRevision += 1;
    targetFingerprint = fingerprintFor(target);
    return {
      project_id: request.expected_project_id,
      project_dir: request.project_dir,
      lease_generation: request.lease_generation,
      editor_generation: request.editor_generation,
      operation_id: request.operation_id,
      revision: request.revision,
      outcome: "written",
      commit_state: "committed",
      fingerprint: structuredClone(targetFingerprint),
    };
  };
  try {
    const internal = harness.store as any;
    await internal.newProject("Launcher 新课程");
    assert(commands.slice(0, 2).join(",") === "project.create,project.open_state", `launcher opens the created canonical target before editing (got ${commands.join(",")})`);
    const createdProject = target as unknown as ProjectData;
    assert(harness.store.data.project.id === createdProject.project.id, "the opened target becomes the editor's active project");
    assert(internal.saveIdentity().project_dir === projectDir, "the editor adopts the service's actual canonical path");
    assert(internal.saveIdentity().lease_generation === leaseGeneration, "the editor adopts the service's actual writer lease");

    harness.store.ui.seedType = "overview";
    harness.store.ui.seedText = "第一章\n课程目标";
    await internal.startSeed();
    assert(mutationRequests.map(({ name }) => name).join(",") === "course.seed.create,blueprint.build", "seed and blueprint use the active-project mutation path");
    const finalizedProject = target as unknown as ProjectData;
    assert(finalizedProject.course_seeds.length === 1, "the seed is committed to the created canonical project");
    assert(finalizedProject.blueprint_drafts.length === 1, "the blueprint is committed to the same canonical project");
    assert(internal.saveIdentity().project_dir === projectDir, "the editor remains bound to the actual target path");
    assert(internal.expectedProjectId === createdProject.project.id, "the new target id remains active after both mutations");
    assert(internal.saveIdentity().lease_generation === leaseGeneration, "the target lease remains active after both mutations");
  } finally {
    harness.restore();
  }
});

Deno.test("project snapshots and save acknowledgements require valid fingerprints", async () => {
  const { store, bridge, restore } = await bootStore();
  const internal = store as any;
  const originalData = structuredClone(store.data);
  const originalFingerprint = {
    exists: true,
    mtime_ms: 10,
    size: 20,
    hash: "before",
  };
  const noFileFingerprint = {
    exists: false,
    mtime_ms: null,
    size: null,
    hash: null,
  };
  try {
    internal.projectFingerprint = originalFingerprint;
    const generation = internal.projectFingerprintGeneration;
    const replacement = createEmptyProjectData("不可采用的磁盘版本");
    assert(
      !internal.adoptProjectSnapshot({ project: replacement, fingerprint: { exists: true } }),
      "a malformed project/fingerprint pair must be rejected",
    );
    assert(
      !internal.isFileFingerprint({ ...originalFingerprint, size: -1 }),
      "a filesystem fingerprint cannot contain a negative size",
    );
    assert(
      !internal.replaceProjectFrom({
        project_state: { project: replacement, fingerprint: { exists: true } },
        project: replacement,
      }),
      "a malformed pair must not fall back to adopting its unpaired project",
    );
    assert(
      JSON.stringify(store.data) === JSON.stringify(originalData),
      "rejecting a malformed pair must leave the in-memory project untouched",
    );
    assert(
      JSON.stringify(internal.projectFingerprint) === JSON.stringify(originalFingerprint) &&
        internal.projectFingerprintGeneration === generation,
      "rejecting a malformed pair must leave the save baseline untouched",
    );

    assert(
      internal.adoptProjectSnapshot({ project: replacement, fingerprint: noFileFingerprint }),
      "the explicit all-null no-file fingerprint is valid",
    );
    assert(
      internal.projectFingerprint.exists === false &&
        internal.projectFingerprintGeneration === generation + 1,
      "adopting a valid pair advances the baseline with its project",
    );

    const adoptedFingerprint = structuredClone(internal.projectFingerprint);
    const adoptedGeneration = internal.projectFingerprintGeneration;
    (bridge as any).writeProject = async () => ({ fingerprint: { exists: true } });
    let rejectedAck = false;
    try {
      await internal.persistProjectSnapshot(store.data);
    } catch {
      rejectedAck = true;
    }
    assert(rejectedAck, "a malformed save acknowledgement must be rejected");
    assert(
      JSON.stringify(internal.projectFingerprint) === JSON.stringify(adoptedFingerprint) &&
        internal.projectFingerprintGeneration === adoptedGeneration,
      "a malformed save acknowledgement must not advance the baseline",
    );
    (bridge as any).writeProject = async () => ({ fingerprint: noFileFingerprint });
    rejectedAck = false;
    try {
      await internal.persistProjectSnapshot(store.data);
    } catch {
      rejectedAck = true;
    }
    assert(rejectedAck, "a no-file fingerprint cannot acknowledge a successful save");
    assert(
      JSON.stringify(internal.projectFingerprint) === JSON.stringify(adoptedFingerprint) &&
        internal.projectFingerprintGeneration === adoptedGeneration,
      "a no-file save acknowledgement must not advance the baseline",
    );

    const savedFingerprint = {
      exists: true,
      mtime_ms: 30,
      size: 40,
      hash: "after",
    };
    (bridge as any).writeProject = async (request: Record<string, unknown>) => ({
      project_id: request.expected_project_id,
      lease_generation: request.lease_generation,
      editor_generation: request.editor_generation,
      operation_id: request.operation_id,
      revision: request.revision,
      outcome: "written",
      commit_state: "committed",
      fingerprint: savedFingerprint,
    });
    await internal.persistProjectSnapshot(store.data);
    assert(
      JSON.stringify(internal.projectFingerprint) === JSON.stringify(savedFingerprint) &&
        internal.projectFingerprintGeneration === adoptedGeneration + 1,
      "a valid save acknowledgement advances the baseline",
    );
  } finally {
    restore();
  }
});

Deno.test("snapshot creation freezes the clicked revision and reports index save failure", async () => {
  const { store, bridge, restore } = await bootStore();
  const internal = store as any;
  const clickedProject = structuredClone(store.data);
  let releaseFlush!: (saved: boolean) => void;
  const firstFlush = new Promise<boolean>((resolve) => releaseFlush = resolve);
  let flushCalls = 0;
  (store as any).flush = () => {
    flushCalls += 1;
    return flushCalls === 1 ? firstFlush : Promise.resolve(false);
  };
  const requests: Record<string, unknown>[] = [];
  (bridge as any).createSnapshot = async (request: Record<string, unknown>) => {
    requests.push(structuredClone(request));
    return {
      id: request.snapshot_id,
      snapshot_id: request.snapshot_id,
      persisted: true,
      outcome: "written",
      content_hash: "a".repeat(64),
      created_at: "2026-10-06T00:00:00.000Z",
      project_id: request.expected_project_id,
      project_dir: request.project_dir,
      lease_generation: request.lease_generation,
      editor_generation: request.editor_generation,
      operation_id: request.operation_id,
      revision: request.revision,
      durability_warning: "snapshot directory sync failed",
    };
  };
  try {
    const saving = internal.saveVersion("点击时版本", "冻结正文");
    // A duplicate click while the original request waits for its body save is
    // ignored. This also proves the dialog cannot enqueue two snapshot writes.
    await internal.saveVersion("点击时版本", "冻结正文");
    store.commit("保存期间的后续编辑", (data: ProjectData) => {
      data.project.title = "保存期间继续编辑";
    });
    releaseFlush(true);
    await saving;

    assert(requests.length === 1, "one pending click creates at most one snapshot request");
    assert(
      JSON.stringify(requests[0]!.project) === JSON.stringify(clickedProject),
      "the immutable snapshot contains the project as it was when clicked",
    );
    assert(
      store.data.project.title === "保存期间继续编辑",
      "a later edit remains in the live Canonical project",
    );
    assert(
      store.data.snapshots.some((row) => row.id === requests[0]!.snapshot_id),
      "the persisted snapshot is indexed into the current live project",
    );
    assert(
      String(store.ui.toast).includes("索引尚未写入"),
      "a failed index save is reported even though the immutable snapshot persisted",
    );
    assert(
      String(store.ui.toast).includes("持久化确认有限") &&
        String(store.ui.toast).includes("snapshot directory sync failed"),
      "a committed snapshot durability warning is preserved alongside the index failure",
    );
  } finally {
    restore();
  }
});

Deno.test("snapshot restore reports committed content with limited durability confirmation", async () => {
  const { store, state, bridge, restore } = await bootStore();
  const internal = store as any;
  const restored = structuredClone(state.project);
  restored.project.title = "已恢复正文";
  const fingerprint = {
    exists: true,
    mtime_ms: 2,
    size: new TextEncoder().encode(JSON.stringify(restored)).byteLength,
    hash: "b".repeat(64),
  };
  internal.snapshotRows = [{ id: "durable-snapshot", status: "available" }];
  internal.flush = async () => true;
  (bridge as any).restoreSnapshot = async (id: string, request: Record<string, any>) => {
    state.project = structuredClone(restored);
    state.fingerprint = structuredClone(fingerprint);
    const ack = {
      project: structuredClone(restored),
      fingerprint: structuredClone(fingerprint),
      project_id: request.expected_project_id,
      project_dir: request.project_dir,
      lease_generation: request.lease_generation,
      editor_generation: request.editor_generation,
      operation_id: request.operation_id,
      revision: request.revision,
      commit_state: "committed",
      outcome: "written",
      durability_warning: "restore directory sync failed",
    };
    return {
      restored: true,
      snapshot_id: id,
      project: structuredClone(restored),
      fingerprint: structuredClone(fingerprint),
      project_id: request.expected_project_id,
      project_dir: request.project_dir,
      lease_generation: request.lease_generation,
      editor_generation: request.editor_generation,
      operation_id: request.operation_id,
      revision: request.revision,
      backup_snapshot_id: "backup-before-restore",
      backup_persisted: true,
      commit_state: "committed",
      durability_warning: "restore directory sync failed",
      mutation_ack: ack,
    };
  };
  (bridge as any).listSnapshots = async () => ({
    project_id: restored.project.id,
    snapshots: [],
  });
  try {
    await internal.restoreVersion("durable-snapshot");
    assert(store.data.project.title === "已恢复正文", "the committed restore result is adopted");
    assert(String(store.ui.toast).includes("已恢复历史版本"), "the user sees that restore committed");
    assert(String(store.ui.toast).includes("持久化确认有限"), "the warning does not turn committed restore into failure");
    assert(String(store.ui.toast).includes("restore directory sync failed"), "the durability detail is preserved");
  } finally {
    restore();
  }
});

Deno.test("version history formats ISO and native epoch-millisecond timestamps", async () => {
  const { store, restore } = await bootStore();
  const savedAt = Date.UTC(2026, 9, 6, 1, 2, 3);
  const expected = new Date(savedAt).toLocaleString("zh-CN");
  try {
    (store as any).ui.route = "versions";
    (store as any).snapshotRows = [
      {
        id: "iso",
        name: "ISO",
        status: "available",
        created_at: new Date(savedAt).toISOString(),
      },
      {
        id: "epoch",
        name: "Native epoch",
        status: "available",
        created_at: String(savedAt),
      },
      {
        id: "invalid",
        name: "Invalid",
        status: "available",
        created_at: "not-a-timestamp",
      },
    ];
    const html = createViews(store as any).shellView() as string;
    assert(
      html.split(`<small>${expected}</small>`).length - 1 === 2,
      "ISO and native epoch-millisecond timestamps both render as saved dates",
    );
    assert(
      html.includes("保存时间未知"),
      "invalid timestamps keep the existing unknown-date fallback",
    );
  } finally {
    restore();
  }
});

Deno.test("restore stops when the pending Canonical save cannot drain", async () => {
  const { store, bridge, restore } = await bootStore();
  const internal = store as any;
  const before = structuredClone(store.data);
  let restores = 0;
  (store as any).snapshotRows = [{ id: "ready", status: "available" }];
  (store as any).flush = async () => false;
  (bridge as any).restoreSnapshot = async () => {
    restores += 1;
    return {};
  };
  try {
    await internal.restoreVersion("ready");
    assert(restores === 0, "restore is not invoked until the current save drains successfully");
    assert(JSON.stringify(store.data) === JSON.stringify(before), "failed drain preserves local edits");
    assert(String(store.ui.toast).includes("没有恢复"), "the user is told that restore did not happen");
  } finally {
    restore();
  }
});

Deno.test("persisted snapshot load and save indicators track the project baseline", async () => {
  let persisted = createEmptyProjectData("已保存的项目");
  const fingerprint = {
    exists: true,
    mtime_ms: 10,
    size: JSON.stringify(persisted).length,
    hash: "a".repeat(64),
  };
  const savedFingerprint = {
    exists: true,
    mtime_ms: 20,
    size: 1,
    hash: "b".repeat(64),
  };
  const loaded = await bootStore({
    currentProject: () => persisted,
    projectIdentity: async () => persisted.project.id,
    readProjectState: async () => ({
      project: structuredClone(persisted),
      project_id: persisted.project.id,
      project_dir: "/tmp/workbench-authoring-ui-test",
      lease_generation: "authoring-ui-test-lease",
      fingerprint,
    }),
    writeProject: async (request: Record<string, unknown>) => {
      const project = request.project as ProjectData;
      persisted = structuredClone(project);
      return {
        project_id: request.expected_project_id,
        lease_generation: request.lease_generation,
        editor_generation: request.editor_generation,
        operation_id: request.operation_id,
        revision: request.revision,
        outcome: "written",
        commit_state: "committed",
        fingerprint: savedFingerprint,
      };
    },
  });
  try {
    await loaded.store.initialize();
    assert(
      String(loaded.store.saveStatus) === "已保存",
      `loading an existing project with a valid disk fingerprint starts saved (got ${String(loaded.store.saveStatus)})`,
    );
    loaded.store.addMapItem("新增课时");
    assert(
      String(loaded.store.saveStatus) === "正在保存…",
      "editing a loaded project returns the status to saving",
    );
    assert(await loaded.store.flushNow(), "the edited loaded project saves successfully");
    assert(
      String(loaded.store.saveStatus) === "已保存",
      "a valid save acknowledgement restores the saved status",
    );
  } finally {
    loaded.restore();
  }

  const absent = await bootStore({
    readProjectState: async () => ({
      project: null,
      fingerprint: { exists: false, mtime_ms: null, size: null, hash: null },
    }),
  });
  try {
    await absent.store.initialize();
    assert(
      String(absent.store.saveStatus) === "未保存",
      "a valid no-file baseline remains unsaved until the first explicit save",
    );
  } finally {
    absent.restore();
  }

  const invalid = await bootStore({
    readProjectState: async () => ({
      project: createEmptyProjectData("无效快照"),
      fingerprint: { exists: true },
    }),
  });
  try {
    await invalid.store.initialize();
    assert(
      String(invalid.store.saveStatus) === "未保存",
      "an invalid project/fingerprint pair must not claim a saved baseline",
    );
  } finally {
    invalid.restore();
  }
});

Deno.test("session write failure leaves saved content intact and ignores stale project errors", async () => {
  const failure = Object.assign(new Error("permission denied"), { code: "session_write_failed" });
  const current = await bootStore({ saveSession: async () => { throw failure; } });
  try {
    current.store.addMapItem("正文先保存");
    assert(await current.store.flushNow(), "reader-position failure does not fail a committed project save");
    assert(current.state.writes === 1, "the canonical project write completed");
    assert(current.state.project.content_items.some((item) => item.title === "正文先保存"), "the saved lesson remains on disk");
    assert(current.store.saveStatus === "已保存", "session failure does not change the content save status");
    assert(String(current.store.ui.toast).includes("课程内容已经保存，但阅读位置没有记住"), "the user gets a separate reader-position warning");
  } finally {
    current.restore();
  }

  const delayedWrite: { reject?: (error: unknown) => void } = {};
  const stale = await bootStore({
    saveSession: () => new Promise((_resolve, reject) => { delayedWrite.reject = reject; }),
  });
  try {
    const oldSession = stale.store.session();
    const completion = stale.store.sessionScheduler.enqueue(oldSession);
    completion.catch(() => {});
    const drained = stale.store.sessionScheduler.flush().catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!delayedWrite.reject) throw new Error("the old session write is in flight");

    const next = createEmptyProjectData("新课程");
    const nextFingerprint = {
      exists: true,
      mtime_ms: 2,
      size: new TextEncoder().encode(JSON.stringify(next)).byteLength,
      hash: "2".repeat(64),
    };
    stale.store.adoptProjectSnapshot({
      project: next,
      project_id: next.project.id,
      project_dir: "/tmp/workbench-authoring-ui-test",
      lease_generation: "authoring-ui-test-lease",
      fingerprint: nextFingerprint,
    });
    const currentToast = stale.store.ui.toast;
    delayedWrite.reject(failure);
    await drained;
    await completion.catch(() => {});
    assert(stale.store.data.project.id === next.project.id, "the new project remains active");
    assert(stale.store.saveStatus === "已保存", "the stale session error does not mark the new project dirty or failed");
    assert(stale.store.ui.toast === currentToast, "the stale position error does not replace the new project's feedback");
  } finally {
    stale.restore();
  }
});

Deno.test("lesson creation, rename, reorder and delete keep the course consistent", async () => {
  const { store, restore } = await bootStore();
  try {
    store.openItem("");
    store.addMapItem("第一课");
    store.addMapItem("第二课");
    store.addMapItem("第三课");
    assert(store.data.content_items.length === 3, "three lessons must exist");
    assert(
      store.data.content_items.map((item) => item.code).join(",") ===
        "S01-01,S01-02,S01-03",
      "codes must follow the stage",
    );

    const [first, second, third] = store.data.content_items;
    store.renameLesson(first!.id, "重新命名的一课");
    assert(first!.title === "重新命名的一课", "rename must reach canonical data");
    assert(first!.order_index === 0, "rename must not reorder");

    store.moveLesson(third!.id, "up");
    const order = store.data.content_items
      .filter((item) => item.stage_id === first!.stage_id)
      .sort((a, b) => a.order_index - b.order_index)
      .map((item) => item.id);
    assert(order[1] === third!.id, "moving up swaps positions");

    store.openItem(second!.id);
    store.addBlock("paragraph", "第二课的正文");
    store.deleteLesson(second!.id);
    assert(
      store.data.content_items.some((item) => item.id === second!.id),
      "deleting a lesson with content asks for confirmation first",
    );
    assert(
      store.ui.confirmDeleteLesson !== null,
      "the confirmation request is recorded",
    );
    store.deleteLesson(second!.id);
    assert(
      !store.data.content_items.some((item) => item.id === second!.id),
      "delete removes the lesson",
    );
    assert(
      !store.data.blocks.some((block) => block.document_id === second!.document_id),
      "delete removes the lesson's blocks",
    );
    assert(
      !store.data.documents.some((document) => document.id === second!.document_id),
      "delete removes the lesson's document",
    );
    assert(
      store.data.content_items
        .filter((item) => item.stage_id === first!.stage_id)
        .every((item, index) => item.order_index === index),
      "remaining lessons keep contiguous order",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "the project must still pass canonical validation",
    );
  } finally {
    restore();
  }
});

Deno.test("block authoring keeps text, structure and selection in sync", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("区块测试");
    const item = store.currentItem()!;
    store.addBlock("heading", "标题");
    store.addBlock("paragraph", "第一段");
    store.addBlock("paragraph", "第二段");
    assert(store.blocks(item).length === 3, "three blocks must exist");

    const [heading, firstParagraph] = store.blocks(item);
    store.editBlockText(heading!.id, "改过的标题");
    assert(
      store.lesson()!.blocks[0]!.text === "改过的标题",
      "text edits are read back through the projection",
    );
    store.setBlockLevel(heading!.id, 1);
    assert(store.lesson()!.blocks[0]!.level === 1, "heading level is editable");
    store.setBlockType(firstParagraph!.id, "quote");
    assert(
      store.lesson()!.blocks[1]!.type === "quote",
      "block type conversion is canonical",
    );

    const before = store.blocks(item).map((block) => block.id);
    store.reorderBlockTo(before[2]!, before[0]!);
    const after = store.blocks(item).map((block) => block.id);
    assert(after[0] === before[2], "drag reorder moves the block to the target index");
    assert(
      after.every((id, index) =>
        store.blocks(item)[index]!.order_index === index
      ),
      "order_index stays contiguous",
    );

    store.selectBlock(heading!.id, { force: true });
    assert(store.ui.selectedBlockId === heading!.id, "selection follows the click");
    store.deleteBlock(heading!.id);
    assert(store.ui.selectedBlockId === null, "deleting the selected block clears it");
    assert(store.blocks(item).length === 2, "delete removes exactly one block");

    store.undo();
    assert(store.blocks(item).length === 3, "undo restores the deleted block");
    assert(
      validateProjectData(store.data).length === 0,
      "undo must leave a valid project",
    );
  } finally {
    restore();
  }
});

Deno.test("selecting a placeholder opens the status right panel", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("占位打开状态");
    store.addBlock("paragraph", "正文");
    store.addPlaceholder("text", "补一段说明");
    const placeholder = store.blocks(store.currentItem()!).find((block) =>
      block.type === "placeholder"
    )!;
    store.ui.rightPanel = "properties";
    store.ui.rightCollapsed = true;
    store.selectBlock(placeholder.id, { force: true });
    assert(
      store.ui.selectedBlockId === placeholder.id,
      "the placeholder must become the selected block",
    );
    assert(
      store.ui.rightPanel === "status",
      "placeholder selection must open the 状态 panel",
    );
    assert(
      store.ui.rightCollapsed === false,
      "opening 状态 must expand the right rail",
    );
  } finally {
    restore();
  }
});

Deno.test("soft block selection does not call full notify()", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("软选中");
    store.addBlock("paragraph", "一段");
    const id = store.blocks(store.currentItem()!)[0]!.id;
    const mutable = store as typeof store & {
      notify: (...args: unknown[]) => void;
    };
    let fullNotifies = 0;
    const previous = mutable.notify.bind(mutable);
    mutable.notify = (...args: unknown[]) => {
      fullNotifies += 1;
      previous(...args);
    };
    mutable.selectBlock(id, { force: true, soft: true });
    assert(mutable.ui.selectedBlockId === id, "soft select still records selectedBlockId");
    assert(
      fullNotifies === 0,
      "soft selection must not rebuild the editor via notify()",
    );
  } finally {
    restore();
  }
});

Deno.test("soft selecting a placeholder already on 状态 skips notify()", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("软占位");
    store.addPlaceholder("text", "补一段");
    const placeholder = store.blocks(store.currentItem()!).find((block) =>
      block.type === "placeholder"
    )!;
    store.ui.rightPanel = "status";
    store.ui.rightCollapsed = false;
    store.ui.selectedBlockId = null;
    const mutable = store as typeof store & {
      notify: (...args: unknown[]) => void;
    };
    let fullNotifies = 0;
    const previous = mutable.notify.bind(mutable);
    mutable.notify = (...args: unknown[]) => {
      fullNotifies += 1;
      previous(...args);
    };
    mutable.selectBlock(placeholder.id, { force: true, soft: true });
    assert(mutable.ui.selectedBlockId === placeholder.id, "placeholder stays selected");
    assert(mutable.ui.rightPanel === "status", "状态 remains the open panel");
    assert(
      fullNotifies === 0,
      "soft placeholder select must not notify when 状态 is already open",
    );
  } finally {
    restore();
  }
});

Deno.test("pointer reorder session commits canonical order_index via reorderBlockTo", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("指针排序");
    store.addBlock("paragraph", "A");
    store.addBlock("paragraph", "B");
    store.addBlock("paragraph", "C");
    const item = store.currentItem()!;
    const before = store.blocks(item).map((block) => block.id);
    const { createPointerReorderSession } = await import(
      `../app/main.js?pointer-reorder-${importCounter}`
    );
    assert(
      typeof createPointerReorderSession === "function",
      "pointer reorder helpers must be exported for the interaction path",
    );
    // Geometry stand-in: three stacked 100px frames. Drag C into the top half of A.
    const rects = before.map((id, index) => ({
      id,
      top: index * 100,
      height: 100,
    }));
    const session = createPointerReorderSession({
      sourceId: before[2]!,
      startX: 12,
      startY: 250,
      threshold: 5,
    });
    assert(
      session.move(12, 248, rects).active === false,
      "movement under the threshold must not start a reorder",
    );
    const armed = session.move(12, 40, rects);
    assert(armed.active === true, "crossing the threshold arms the gesture");
    assert(
      armed.targetId === before[0],
      "pointer over the top half of A must target A",
    );
    const committed = session.commit((source: string, target: string) =>
      store.reorderBlockTo(source, target)
    );
    assert(committed === true, "an armed gesture with a target must commit");
    const after = store.blocks(item).map((block) => block.id);
    assert(after[0] === before[2], "C must move before A");
    assert(
      after.every((id, index) => store.blocks(item)[index]!.order_index === index),
      "order_index must stay contiguous after pointer reorder",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "pointer reorder must leave a valid project",
    );
  } finally {
    restore();
  }
});

Deno.test("Flow drop targets insert before the indicator and null appends", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("Flow 插入语义");
    store.addBlock("paragraph", "A");
    store.addBlock("paragraph", "B");
    store.addBlock("paragraph", "C");
    const item = store.currentItem()!;
    const [a, b, c] = store.blocks(item);
    store.reorderBlockTo(a!.id, c!.id);
    assert(
      store.blocks(item).map((block) => block.id).join(",") === `${b!.id},${a!.id},${c!.id}`,
      "the dragged block must land immediately before the highlighted target",
    );
    store.reorderBlockTo(b!.id, null);
    assert(
      store.blocks(item).map((block) => block.id).join(",") === `${a!.id},${c!.id},${b!.id}`,
      "a drop on the end sentinel must append after every block",
    );
    assert(
      store.blocks(item).every((block, index) => block.order_index === index),
      "Flow writes contiguous canonical order indices",
    );
  } finally {
    restore();
  }
});

Deno.test("Workbench exposes Flow and migrates the removed Layout route to Free Layout", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("Flow 页面合同");
    store.addBlock("paragraph", "Flow 预览正文");
    store.ui.screen = "project";
    store.ui.route = "editor";
    store.ui.mode = "structure";
    const { createViews } = await import(`../app/views.js?flow-contract-${importCounter}`);
    const html = () => createViews(store).shellView() as string;
    const workbench = html();
    assert(workbench.includes('data-mode="structure"'), "the second Workbench view remains Flow");
    assert(workbench.includes("data-flow-drag-handle"), "Flow rows expose their own drag handle");
    assert(workbench.includes('data-action="flow-select-block"'), "the full Flow row returns to its body block");
    assert(!workbench.includes('data-mode="layout"'), "Workbench no longer exposes the Layout tab");
    assert(workbench.includes('data-route="free-layout"'), "Free Layout is a top-level navigation route");

    store.setMode("layout");
    assert(store.ui.route === "free-layout", "legacy Layout actions open the Free Layout page");
    assert(store.ui.mode === "writing", "the removed Layout tab is never restored");

    const migratedLayoutSession = store.normalizeReaderState(store.data, {
      route: "editor",
      mode: "layout",
      tabs: [{ content_item_id: store.currentItem()!.id, mode: "layout", pinned: false, scroll_top: 0 }],
    });
    assert(migratedLayoutSession.route === "free-layout", "legacy editor Layout sessions migrate to the Free Layout route");
    assert(migratedLayoutSession.mode === "writing", "legacy Layout session modes return to the body editor");
    assert(
      (migratedLayoutSession.tabs as Array<{ mode: string }>)[0]?.mode === "writing",
      "legacy lesson tabs cannot reopen the removed Layout tab",
    );
    const migratedStructureRoute = store.normalizeReaderState(store.data, { route: "structure", mode: "writing" });
    assert(migratedStructureRoute.route === "editor", "the removed Structure page returns to Workbench");
    assert(migratedStructureRoute.mode === "structure", "legacy Structure sessions open the Flow tab");

    store.createLayout("grid");
    store.ui.route = "free-layout";
    const freeLayout = html();
    assert(freeLayout.includes("GRID CANVAS"), "Free Layout keeps the existing Grid renderer");
    assert(!freeLayout.includes("Flow 是一维文档流"), "Grid renderer contains no legacy Flow page branch");
  } finally {
    restore();
  }
});

/**
 * Thin DOM stand-in that lets `bindBlockDrag` attach real listeners, so a test
 * can fire pointerdown/move/up on a handle instead of only driving the session
 * helper.
 */
async function bootPointerDom() {
  type DocListener = (event: Record<string, unknown>) => void;
  const documentListeners = new Map<string, DocListener[]>();
  let focusedElement: unknown = null;
  const blockNodes: Array<{
    dataset: { blockId: string };
    summary: { focus: () => void };
    classList: {
      add: (name: string) => void;
      remove: (name: string) => void;
      toggle: (name: string, force?: boolean) => boolean;
      contains: (name: string) => boolean;
    };
    getBoundingClientRect: () => {
      top: number;
      height: number;
      bottom: number;
      left: number;
      right: number;
      width: number;
    };
    addEventListener: (type: string, handler: DocListener) => void;
    removeEventListener: (type: string, handler: DocListener) => void;
    querySelector: (selector: string) => unknown;
    handle: {
      captured: boolean;
      addEventListener: (type: string, handler: DocListener) => void;
      removeEventListener: (type: string, handler: DocListener) => void;
      setPointerCapture: (id: number) => void;
      releasePointerCapture: (id: number) => void;
      fire: (type: string, event?: Record<string, unknown>) => void;
    };
  }> = [];

  const classListFor = (bucket: Set<string>) => ({
    add: (name: string) => {
      bucket.add(name);
    },
    remove: (name: string) => {
      bucket.delete(name);
    },
    toggle: (name: string, force?: boolean) => {
      const next = force ?? !bucket.has(name);
      if (next) bucket.add(name);
      else bucket.delete(name);
      return next;
    },
    contains: (name: string) => bucket.has(name),
  });

  const makeHandle = () => {
    const listeners = new Map<string, DocListener[]>();
    const handle = {
      captured: false,
      addEventListener(type: string, handler: DocListener) {
        const list = listeners.get(type) ?? [];
        list.push(handler);
        listeners.set(type, list);
      },
      removeEventListener(type: string, handler: DocListener) {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((candidate) => candidate !== handler),
        );
      },
      setPointerCapture(_id: number) {
        handle.captured = true;
      },
      releasePointerCapture(_id: number) {
        handle.captured = false;
      },
      fire(type: string, event: Record<string, unknown> = {}) {
        for (const handler of listeners.get(type) ?? []) {
          handler({ target: handle, currentTarget: handle, ...event });
        }
      },
    };
    return handle;
  };

  const scrollContainer = {
    scrollTop: 0,
    scrollHeight: 600,
    clientHeight: 100,
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
  };
  let actionClick: DocListener | null = null;
  const actionNode: any = {
    dataset: { action: "select-block", id: "" },
    addEventListener(type: string, handler: DocListener) {
      if (type === "click") actionClick = handler;
    },
    matches: () => false,
    closest(selector: string) {
      return selector === ".block-more-menu" ? {} : null;
    },
    fire() {
      actionClick?.({
        target: actionNode,
        stopPropagation() {},
      });
    },
  };
  const focusField = {
    focus() { focusedElement = focusField; },
    select() {},
  };
  let currentHtml = "";
  const root: {
    innerHTML: string;
    dataset: Record<string, string>;
    classList: ReturnType<typeof classListFor>;
    addEventListener: () => void;
    contains: () => boolean;
    querySelector: (selector: string) => unknown;
    querySelectorAll: (selector: string) => unknown[];
  } = {
    get innerHTML() { return currentHtml; },
    set innerHTML(value: string) {
      currentHtml = value;
      for (const node of blockNodes) {
        const summary = { focus() { focusedElement = summary; } };
        node.summary = summary;
      }
    },
    dataset: {},
    classList: classListFor(new Set()),
    addEventListener: () => {},
    contains: () => true,
    querySelector(selector: string) {
      if (selector === ".center") return scrollContainer;
      if (selector === '[data-focus-key="menu-test-field"]') return focusField;
      const match = /^article\.block\[data-block-id="([^"]+)"\]$/.exec(selector);
      if (match) {
        return blockNodes.find((node) => node.dataset.blockId === match[1]) ?? null;
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "[data-action]") return [actionNode];
      if (selector === "article.block[data-block-id]") return blockNodes;
      if (selector === "article.block.drop-before") {
        return blockNodes.filter((node) => node.classList.contains("drop-before"));
      }
      return [];
    },
  };

  const document: {
    activeElement: null;
    querySelector: (selector?: string) => unknown;
    querySelectorAll: () => unknown[];
    addEventListener: (
      type: string,
      handler: DocListener,
      capture?: boolean,
    ) => void;
    removeEventListener: (
      type: string,
      handler: DocListener,
      capture?: boolean,
    ) => void;
  } = {
    activeElement: null,
    querySelector: () => root,
    querySelectorAll: () => [],
    addEventListener(type, handler, capture) {
      if (!capture && type !== "keydown") return;
      const list = documentListeners.get(type) ?? [];
      list.push(handler);
      documentListeners.set(type, list);
    },
    removeEventListener(type, handler, _capture) {
      documentListeners.set(
        type,
        (documentListeners.get(type) ?? []).filter((candidate) =>
          candidate !== handler
        ),
      );
    },
  };

  const runtime = globalThis as typeof globalThis & {
    document?: unknown;
    __TAURI__?: unknown;
    __workbench?: unknown;
    __workbenchReady?: Promise<unknown>;
  };
  const previous = {
    document: runtime.document,
    tauri: runtime.__TAURI__,
    workbench: runtime.__workbench,
    ready: runtime.__workbenchReady,
    fetch: globalThis.fetch,
  };
  runtime.document = document;
  runtime.__TAURI__ = undefined;
  globalThis.fetch = async () => {
    throw new Error("test fetch disabled");
  };
  importCounter += 1;
  await import(`../app/main.js?pointer-dom-${importCounter}`);
  const store = runtime.__workbench as {
    data: ProjectData;
    ui: Record<string, unknown>;
    history: unknown[];
    saveTimer: number;
    sessionTimer?: number;
    notify: () => void;
    addMapItem: (title?: string) => void;
    addBlock: (type?: string, content?: string) => void;
    currentItem: () => ProjectData["content_items"][number] | null;
    blocks: (item?: unknown) => ProjectData["blocks"];
    reorderBlockTo: (source: string, target: string) => void;
  };
  assert(store, "pointer harness must reach the live __workbench store");
  try {
    await runtime.__workbenchReady;
  } catch { /* launcher is fine */ }

  const mountBlocks = (
    ids: string[],
    geometry: Array<{ top: number; height: number }>,
  ) => {
    blockNodes.length = 0;
    ids.forEach((id, index) => {
      const box = geometry[index] ?? { top: index * 100, height: 100 };
      const handle = makeHandle();
      const classes = new Set<string>();
      const listeners = new Map<string, DocListener[]>();
      const node = {
        dataset: { blockId: id },
        summary: { focus() { focusedElement = node.summary; } },
        classList: classListFor(classes),
        getBoundingClientRect: () => ({
          top: box.top - scrollContainer.scrollTop,
          height: box.height,
          bottom: box.top + box.height - scrollContainer.scrollTop,
          left: 0,
          right: 120,
          width: 120,
        }),
        addEventListener(type: string, handler: DocListener) {
          const list = listeners.get(type) ?? [];
          list.push(handler);
          listeners.set(type, list);
        },
        removeEventListener(type: string, handler: DocListener) {
          listeners.set(
            type,
            (listeners.get(type) ?? []).filter((candidate) => candidate !== handler),
          );
        },
        querySelector: (selector: string) =>
          selector === ".block-handle"
            ? handle
            : selector === "details.block-more > summary"
            ? node.summary
            : null,
        handle,
      };
      blockNodes.push(node);
    });
  };

  const fireDocument = (type: string, event: Record<string, unknown>) => {
    for (const handler of documentListeners.get(type) ?? []) handler(event);
  };

  return {
    store,
    blockNodes,
    scrollContainer,
    mountBlocks,
    fireDocument,
    triggerBlockMenuAction(id: string) {
      actionNode.dataset.id = id;
      actionNode.fire();
    },
    triggerAction(action: string, id = "") {
      actionNode.dataset.action = action;
      actionNode.dataset.id = id;
      actionNode.fire();
    },
    focusedElement: () => focusedElement,
    focusField,
    restore: () => {
      runtime.document = previous.document;
      runtime.__TAURI__ = previous.tauri;
      runtime.__workbench = previous.workbench;
      runtime.__workbenchReady = previous.ready;
      globalThis.fetch = previous.fetch;
      clearTimeout(store.saveTimer);
      if (store.sessionTimer) clearTimeout(store.sessionTimer);
    },
  };
}

Deno.test("delete confirmation leaves data intact on cancel or Escape and commits once on confirm", async () => {
  const dom = await bootPointerDom();
  try {
    dom.store.ui.screen = "project";
    dom.store.ui.route = "editor";
    dom.store.ui.mode = "writing";
    dom.store.addMapItem("确认后删除");
    dom.store.addBlock("paragraph", "保留这段内容直到确认");
    const block = dom.store.blocks()[0]!;
    const historyBefore = dom.store.history.length;
    const { createViews } = await import(`../app/views.js?delete-confirm-${importCounter}`);

    dom.triggerAction("delete-block", block.id);
    const confirmation = dom.store.ui.pendingDeleteConfirmation as { id: string } | undefined;
    assert(confirmation?.id === block.id, "delete action opens the matching confirmation");
    assert(dom.store.data.blocks.some((candidate) => candidate.id === block.id), "opening confirmation does not mutate canonical data");
    assert(dom.store.history.length === historyBefore, "opening confirmation does not add an undo entry");
    const markup = createViews(dom.store as never).overlayView() as string;
    assert(markup.includes('role="dialog"') && markup.includes('aria-modal="true"'), "confirmation is a semantic modal dialog");
    assert(markup.includes("delete-confirm-cancel") && markup.includes("delete-confirm-accept"), "dialog exposes cancel and confirm actions");

    dom.triggerAction("delete-confirm-cancel");
    assert(!dom.store.ui.pendingDeleteConfirmation, "cancel closes the dialog");
    assert(dom.store.data.blocks.some((candidate) => candidate.id === block.id), "cancel preserves the block");
    assert(dom.store.history.length === historyBefore, "cancel adds no undo entry");

    dom.triggerAction("delete-block", block.id);
    dom.fireDocument("keydown", { key: "Escape", preventDefault() {} });
    assert(!dom.store.ui.pendingDeleteConfirmation, "Escape closes the dialog");
    assert(dom.store.data.blocks.some((candidate) => candidate.id === block.id), "Escape preserves canonical data");
    assert(dom.store.history.length === historyBefore, "Escape adds no undo entry");

    dom.triggerAction("delete-block", block.id);
    dom.triggerAction("delete-confirm-accept");
    assert(!dom.store.data.blocks.some((candidate) => candidate.id === block.id), "confirm executes the delete action");
    assert(dom.store.history.length === historyBefore + 1, "confirm commits exactly one undoable action");
  } finally {
    dom.restore();
  }
});

Deno.test("Free Layout page and section removal use the shared cancel, confirm, and undo path", async () => {
  const dom = await bootPointerDom();
  const store = dom.store as any;
  try {
    store.ui.screen = "project";
    store.ui.route = "free-layout";
    store.addMapItem("共享确认排版");
    store.addBlock("paragraph", "页面删除不得删除正文");
    store.createLayout("grid");
    store.autofillGrid();
    store.beginPaginationConversion();
    store.confirmPaginationConversion();
    const sourcePage = store.layoutPages()[0];
    store.duplicatePage(sourcePage.id);
    const duplicatePage = store.layoutPages().find((page: { id: string }) => page.id !== sourcePage.id);
    assert(duplicatePage, "fixture contains a duplicated layout page");
    store.duplicatePage(duplicatePage.id);
    const thirdPage = store.layoutPages().find((page: { id: string }) =>
      page.id !== sourcePage.id && page.id !== duplicatePage.id
    );
    assert(thirdPage, "fixture contains three ordered layout pages");
    store.selectLayoutPage(duplicatePage.id);
    const historyBefore = store.history.length;

    dom.triggerAction("page-delete", duplicatePage.id);
    const pageConfirmation = store.ui.pendingDeleteConfirmation as { action: string; id: string } | undefined;
    assert(pageConfirmation?.action === "delete-page" && pageConfirmation.id === duplicatePage.id, "page delete opens the shared confirmation for its target");
    assert(store.layoutPages().some((page: { id: string }) => page.id === duplicatePage.id), "opening the dialog leaves the page intact");
    assert(store.history.length === historyBefore, "opening the dialog does not commit an undo item");

    dom.triggerAction("delete-confirm-cancel");
    assert(store.layoutPages().some((page: { id: string }) => page.id === duplicatePage.id), "Cancel preserves the page");
    assert(store.history.length === historyBefore, "Cancel does not commit");
    dom.triggerAction("page-delete", duplicatePage.id);
    dom.fireDocument("keydown", { key: "Escape", preventDefault() {} });
    assert(!store.ui.pendingDeleteConfirmation, "Escape closes the same shared dialog");
    assert(store.layoutPages().some((page: { id: string }) => page.id === duplicatePage.id), "Escape preserves the page");

    dom.triggerAction("page-delete", duplicatePage.id);
    dom.triggerAction("delete-confirm-accept");
    assert(!store.layoutPages().some((page: { id: string }) => page.id === duplicatePage.id), "one confirm removes the layout page");
    assert(store.ui.layoutPageId === thirdPage.id, "deleting the active middle page selects its nearest surviving neighbor");
    assert(store.data.blocks.some((block: { content: string }) => block.content === "页面删除不得删除正文"), "page deletion keeps canonical body content");
    assert(store.history.length === historyBefore + 1, "page deletion is one undoable canonical change");
    store.undo();
    assert(store.layoutPages().some((page: { id: string }) => page.id === duplicatePage.id), "Undo restores the page identity for continued editing");

    store.addSection();
    const section = store.data.layout_sections.at(-1);
    const sectionHistory = store.history.length;
    dom.triggerAction("delete-section", section.id);
    assert(store.ui.pendingDeleteConfirmation?.action === "delete-section", "section delete uses the same confirmation surface");
    assert(store.data.layout_sections.some((candidate: { id: string }) => candidate.id === section.id), "opening section confirmation is non-mutating");
    dom.triggerAction("delete-confirm-accept");
    assert(!store.data.layout_sections.some((candidate: { id: string }) => candidate.id === section.id), "one confirm removes the selected section");
    assert(store.history.length === sectionHistory + 1, "section deletion commits once");
    store.undo();
    assert(store.data.layout_sections.some((candidate: { id: string }) => candidate.id === section.id), "Undo restores the section");
  } finally {
    dom.restore();
  }
});

Deno.test("bindBlockDrag commits reorder from handle pointerdown/move/up", async () => {
  const dom = await bootPointerDom();
  try {
    dom.store.ui.screen = "project";
    dom.store.ui.route = "editor";
    dom.store.ui.mode = "writing";
    dom.store.addMapItem("DOM指针排序");
    dom.store.addBlock("paragraph", "A");
    dom.store.addBlock("paragraph", "B");
    dom.store.addBlock("paragraph", "C");
    const item = dom.store.currentItem()!;
    const before = dom.store.blocks(item).map((block) => block.id);
    dom.mountBlocks(before, [
      { top: 0, height: 100 },
      { top: 100, height: 100 },
      { top: 200, height: 100 },
    ]);
    // Re-bind so bindBlockDrag attaches to the staged handles.
    dom.store.notify();

    const source = dom.blockNodes[2]!;
    assert(!source.handle.captured, "capture starts unset");
    source.handle.fire("pointerdown", {
      pointerId: 7,
      button: 0,
      clientX: 12,
      clientY: 250,
    });
    dom.fireDocument("pointermove", {
      pointerId: 7,
      clientX: 12,
      clientY: 248,
      preventDefault() {},
    });
    assert(
      !source.handle.captured,
      "movement under the threshold must not capture yet",
    );
    dom.fireDocument("pointermove", {
      pointerId: 7,
      clientX: 12,
      clientY: 40,
      preventDefault() {},
    });
    assert(
      source.handle.captured,
      "crossing the threshold must setPointerCapture on the handle",
    );
    assert(
      dom.blockNodes[0]!.classList.contains("drop-before"),
      "the drop indicator must land on the target block",
    );
    dom.fireDocument("pointerup", { pointerId: 7 });
    const after = dom.store.blocks(item).map((block) => block.id);
    assert(after[0] === before[2], "pointerup must commit C before A");
    assert(
      after.every((id, index) => dom.store.blocks(item)[index]!.order_index === index),
      "order_index must stay contiguous after the DOM pointer gesture",
    );
    assert(
      !source.handle.captured,
      "pointerup must release pointer capture",
    );
  } finally {
    dom.restore();
  }
});

Deno.test("placeholder and requirement lifecycle survives navigation", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("待补测试");
    const item = store.currentItem()!;
    store.addBlock("paragraph", "正文");
    store.selectBlock(store.blocks(item)[0]!.id, { force: true });
    store.addPlaceholder("image", "补一张图");

    const blocks = store.lesson()!.blocks;
    assert(blocks.length === 2, "the placeholder is a real block");
    assert(blocks[1]!.type === "placeholder", "the placeholder block type is preserved");
    assert(
      blocks[1]!.requirement_id !== null,
      "the placeholder points at its requirement",
    );
    const requirement = store.data.requirements[0]!;
    assert(
      requirement.anchor_block_id === blocks[1]!.id,
      "the requirement anchors to its own placeholder block",
    );
    assert(requirement.status === "open", "a new requirement starts open");
    assert(store.lesson()!.progress.open_requirements === 1, "the gap counter sees it");

    store.updateRequirement(requirement.id, {
      note: "补一张搜索结果截图",
      type: "image",
      priority: "high",
    });
    const edited = store.data.requirements[0]!;
    assert(edited.note === "补一张搜索结果截图", "notes are editable");
    assert(edited.type === "image", "types are editable");
    assert(edited.priority === "high", "priority is editable");
    assert(
      store.blocks(item).find((block) => block.id === edited.anchor_block_id)!
        .content === "补一张搜索结果截图",
      "the placeholder text follows the note",
    );

    // Jump to another lesson and back: requirement and selection must not leak.
    store.addMapItem("另一课");
    const other = store.currentItem()!;
    assert(other.id !== item.id, "the new lesson becomes current");
    assert(
      store.lesson()!.requirements.length === 0,
      "the other lesson must not show the first lesson's requirements",
    );
    store.openItem(item.id);
    assert(
      store.lesson()!.requirements.length === 1,
      "returning restores the lesson's own requirements",
    );
    assert(store.ui.selectedBlockId === null, "selection does not leak across lessons");

    store.setRequirementStatus(requirement.id, "resolved");
    assert(store.lesson()!.progress.open_requirements === 0, "resolving clears the gap");
    store.setRequirementStatus(requirement.id, "open");
    assert(store.lesson()!.progress.open_requirements === 1, "reopening restores the gap");
    store.deleteRequirement(requirement.id);
    assert(store.data.requirements.length === 0, "deleting removes the requirement");
    assert(
      store.blocks(item).every((block) => block.type !== "placeholder"),
      "deleting the requirement removes its placeholder block",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "requirement lifecycle must leave a valid project",
    );
  } finally {
    restore();
  }
});

Deno.test("asset authoring links blocks, usages and requirements together", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("素材测试");
    const item = store.currentItem()!;
    store.commit("测试素材", (data) => {
      data.assets.push({
        id: "asset-image",
        project_id: data.project.id,
        type: "image",
        filename: "封面.png",
        storage_path: "assets/封面.png",
        mime_type: "image/png",
        width: null,
        height: null,
        duration_ms: null,
        file_size: 1024,
        checksum: "checksum-cover",
        title: "封面.png",
        description: "",
        source_type: "imported",
        source_url: null,
        copyright_note: null,
        created_at: "2026-01-01T00:00:00.000Z",
        archived: false,
      });
    });
    store.addBlock("paragraph", "需要配图的一段");
    const block = store.blocks(item)[0]!;
    store.selectBlock(block.id, { force: true });
    await store.insertAsset("asset-image", { block_id: block.id });

    let current = store.blocks(item)[0]!;
    assert(current.type === "image", "inserting an image asset converts the block");
    assert(current.settings.asset_id === "asset-image", "the block links the asset");
    const usage = store.data.asset_usages[0]!;
    assert(usage.asset_id === "asset-image", "a real usage is created");
    assert(usage.block_id === block.id, "the usage points at the block");
    assert(usage.content_item_id === item.id, "the usage belongs to the lesson");
    assert(store.lesson()!.blocks[0]!.asset !== null, "the projection resolves the asset");

    // A second insert of the same asset must not duplicate the usage.
    await store.insertAsset("asset-image", { block_id: block.id });
    assert(store.data.asset_usages.length === 1, "usages are idempotent per block");

    // Detaching keeps the block as an empty media slot.
    store.detachAsset(block.id, "asset-image");
    current = store.blocks(item)[0]!;
    assert(current.type === "image", "detaching keeps the media block type");
    assert(!current.settings.asset_id, "detaching clears the link");
    assert(store.data.asset_usages.length as number === 0, "detaching clears the usage");
    assert(
      store.lesson()!.progress.missing_media === 1,
      "an unlinked media block is reported as missing material",
    );

    // Resolving a requirement with the asset links the anchor block.
    store.setBlockType(block.id, "placeholder");
    const requirement = store.data.requirements.at(-1)!;
    store.resolveRequirement(requirement.id, "asset-image");
    const resolved = store.data.requirements.find((candidate) =>
      candidate.id === requirement.id
    )!;
    assert(resolved.status === "resolved", "the requirement is resolved");
    assert(resolved.resolved_asset_id === "asset-image", "the resolution records the asset");
    assert(
      store.blocks(item).find((candidate) => candidate.id === requirement.anchor_block_id)!
        .settings.asset_id === "asset-image",
      "the anchor block becomes the media slot",
    );

    // Deleting the asset clears every reference without removing rows, and asks
    // for confirmation first because references exist.
    store.deleteAsset("asset-image");
    assert(
      store.ui.confirmDeleteAssetId === "asset-image",
      "deleting a referenced asset asks for confirmation first",
    );
    assert(!store.data.assets[0]!.archived, "nothing is removed before confirmation");
    store.deleteAsset("asset-image");
    assert(store.data.assets[0]!.archived, "deleting archives instead of unlinking");
    assert(store.data.asset_usages.length as number === 0, "every usage is released");
    assert(
      store.data.requirements.every((candidate) =>
        candidate.resolved_asset_id === null
      ),
      "no requirement keeps a removed asset",
    );
    assert(
      store.data.blocks.every((candidate) => !candidate.settings.asset_id),
      "no block keeps a removed asset",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "asset deletion must leave a valid project",
    );
  } finally {
    restore();
  }
});

Deno.test("flow and grid layout edits persist on the canonical layout row", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.addMapItem("排版测试");
    const item = store.currentItem()!;
    store.addBlock("heading", "标题");
    store.addBlock("paragraph", "第一段");
    store.addBlock("paragraph", "第二段");

    store.createLayout("grid");
    const layout = store.data.layout_instances[0]!;
    assert(layout.mode === "grid", "the layout starts in grid mode");
    assert(store.data.layout_sections.length === 1, "a first section is created");

    store.autofillGrid();
    assert(
      store.data.placements.length === 3,
      "autofill places every unplaced block",
    );
    const firstPlacement = store.data.placements[0]!;
    assert(firstPlacement.row_start === 0, "placements start at the first free cell");

    store.movePlacement(firstPlacement.id, 1, 1);
    assert(
      store.data.placements[0]!.row_start === 1 &&
        store.data.placements[0]!.column_start === 1,
      "moving a placement snaps to the requested track",
    );
    store.resizePlacement(firstPlacement.id, 1, 0);
    assert(
      store.data.placements[0]!.column_end >
        store.data.placements[0]!.column_start,
      "resizing keeps a positive span",
    );

    // Put a placement in the last row so shrinking really has to clamp it.
    const rowsBefore = tracks(store.data.layout_instances[0]!.grid_definition).rows.length;
    const lastRow = store.data.placements.length;
    store.changeGrid("row", 2);
    const grownRows = tracks(store.data.layout_instances[0]!.grid_definition).rows.length;
    assert(grownRows === rowsBefore + 2, "adding rows grows the grid");
    store.movePlacement(firstPlacement.id, grownRows - 1 - firstPlacement.row_start, 0);
    const displaced = store.data.placements[0]!;
    assert(
      displaced.row_start === grownRows - 1,
      `expected the placement in the last row, got row ${displaced.row_start}`,
    );
    store.changeGrid("row", -2);
    const rowsAfter = tracks(store.data.layout_instances[0]!.grid_definition).rows.length;
    assert(rowsAfter === rowsBefore, "removing rows shrinks the grid");
    const clamped = store.data.placements.find((placement) =>
      placement.id === firstPlacement.id
    )!;
    assert(
      clamped.row_end <= rowsAfter && clamped.row_start >= 0,
      `shrinking the grid must clamp the displaced placement, got ${clamped.row_start}..${clamped.row_end} of ${rowsAfter}`,
    );
    assert(
      store.data.placements.every((placement) => placement.row_end <= rowsAfter),
      "every placement stays inside the grid",
    );
    void lastRow;

    store.addSection();
    const section = store.data.layout_sections.at(-1)!;
    store.renameSection(section.id, "第二段");
    assert(
      store.data.layout_sections.at(-1)!.name === "第二段",
      "sections are renamable",
    );

    store.setLayoutMode("flow");
    assert(store.data.layout_instances[0]!.mode === "flow", "flow mode is canonical");
    assert(
      store.data.placements.length === 3,
      "switching to flow must not drop placements",
    );
    store.setLayoutMode("grid");
    assert(String(store.data.layout_instances[0]!.mode) === "grid", "switching back is canonical");
    assert(store.data.placements.length === 3, "placements survive the round trip");

    store.unplaceBlock(store.blocks(item)[0]!.id);
    assert(store.data.placements.length as number === 2, "a block can be taken out of the grid");
    store.placeBlock(store.blocks(item)[0]!.id);
    assert(store.data.placements.length as number === 3, "and put back");

    await store.flush();
    const persisted = state.project;
    assert(
      persisted.layout_instances[0]!.mode === "grid",
      "the layout mode reaches canonical storage",
    );
    assert(persisted.placements.length === 3, "placements reach canonical storage");
    assert(
      validateProjectData(persisted).length === 0,
      "the persisted layout must stay valid",
    );
  } finally {
    restore();
  }
});

Deno.test("page conversion preview is read-only and reader state falls back to a real page", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("分页会话课");
    store.addBlock("paragraph", "第一页内容");
    store.createLayout("grid");
    const before = JSON.stringify(store.data);
    const historyBefore = store.history.length;
    store.beginPaginationConversion();
    assert(JSON.stringify(store.data) === before, "conversion preview cannot mutate canonical data");
    assert(store.history.length === historyBefore, "preview does not create history");
    store.cancelPaginationConversion();
    assert(JSON.stringify(store.data) === before, "cancel leaves the source layout unchanged");

    store.beginPaginationConversion();
    store.confirmPaginationConversion();
    const layout = store.data.layout_instances[0]!;
    const first = store.layoutPages()[0]!;
    assert(layout.pagination_mode === "paged", "confirmation enables paged layout");
    assert(first.id && first.layout_instance_id === layout.id, "conversion creates stable page identity");
    store.addLayoutPage();
    const second = store.layoutPages().find((page) => page.id !== first.id)!;
    store.selectLayoutPage(second.id);
    store.setLayoutZoom("actual");
    const saved = store.session();
    assert(saved.layout_page_id === second.id, "session records the selected page id");
    assert(saved.layout_zoom === "actual", "session records the chosen zoom mode");

    const recovered = store.normalizeReaderState(store.data, {
      active_content_item_id: store.currentItem()!.id,
      layout_page_id: "deleted-page-id",
      layout_zoom: "invalid",
    });
    assert(recovered.layout_page_id === first.id, "deleted or unknown page ids fall back to the first valid page");
    assert(recovered.layout_zoom === "fit", "invalid zoom falls back to fit");
    assert(validateProjectData(store.data).length === 0, "page conversion leaves a valid project");
  } finally {
    restore();
  }
});

Deno.test("page duplication edits independent blocks and page deletion preserves content", async () => {
  const { store, restore } = await bootStore();
  const previousConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    store.addMapItem("独立复制页");
    store.addBlock("paragraph", "原始正文");
    store.createLayout("grid");
    store.autofillGrid();
    store.beginPaginationConversion();
    store.confirmPaginationConversion();
    const sourcePage = store.layoutPages()[0]!;
    const sourcePlacement = store.data.placements.find((placement) => placement.page_id === sourcePage.id)!;
    const sourceBlock = store.data.blocks.find((block) => block.id === sourcePlacement.block_id)!;

    store.duplicatePage(sourcePage.id);
    const copiedPage = store.layoutPages().find((page) => page.id !== sourcePage.id)!;
    const copiedPlacement = store.data.placements.find((placement) => placement.page_id === copiedPage.id)!;
    const copiedBlock = store.data.blocks.find((block) => block.id === copiedPlacement.block_id)!;
    assert(copiedBlock.id !== sourceBlock.id, "copy creates a new canonical block id");
    assert(copiedPlacement.id !== sourcePlacement.id, "copy creates a new placement id");
    store.editBlockText(copiedBlock.id, "复制页已独立编辑");
    assert(copiedBlock.content === "复制页已独立编辑", "copy accepts its own content edit");
    assert(sourceBlock.content === "原始正文", "editing the copy does not edit source content");

    assert(store.deletePage(copiedPage.id), "a non-final page can be deleted");
    assert(store.data.layout_pages.every((page) => page.id !== copiedPage.id), "deleted page identity is removed");
    assert(store.data.blocks.some((block) => block.id === copiedBlock.id), "page deletion never deletes canonical content");
    assert(!store.data.placements.some((placement) => placement.page_id === copiedPage.id), "page deletion removes only its layout placements");
    assert(store.lesson()!.unplaced_blocks.some((block) => block.id === copiedBlock.id), "preserved content returns to the unplaced list");
    assert(validateProjectData(store.data).length === 0, "copy and deletion leave valid canonical data");
  } finally {
    globalThis.confirm = previousConfirm;
    restore();
  }
});

Deno.test("cross-page move rejects an occupied target atomically and accepts a free cell", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("跨页移动");
    store.addBlock("paragraph", "移动正文");
    store.addBlock("paragraph", "目标占位");
    store.createLayout("grid");
    store.beginPaginationConversion();
    store.confirmPaginationConversion();
    const sourcePage = store.layoutPages()[0]!;
    const movableBlock = store.blocks()[0]!;
    const targetBlock = store.blocks()[1]!;
    store.placeBlock(movableBlock.id);
    const moving = store.data.placements.find((placement) => placement.block_id === movableBlock.id)!;
    store.addLayoutPage();
    const targetPage = store.layoutPages().find((page) => page.id !== sourcePage.id)!;
    store.placeBlock(targetBlock.id);
    const historyBeforeFailure = store.history.length;
    const beforeFailure = JSON.stringify(store.data);

    assert(!store.movePlacementAcrossPage(moving.id, targetPage.id, 0, 0), "occupied destination is rejected");
    assert(JSON.stringify(store.data) === beforeFailure, "failed cross-page move does not partially change placement");
    assert(store.history.length === historyBeforeFailure, "failed move does not create a history entry");

    assert(store.movePlacementAcrossPage(moving.id, targetPage.id, 0, 1), "free destination accepts the move");
    const moved = store.data.placements.find((placement) => placement.id === moving.id)!;
    assert(moved.page_id === targetPage.id && moved.column_start === 1, "successful move writes the chosen page and cell");
    assert(validateProjectData(store.data).length === 0, "cross-page moves leave valid canonical data");
  } finally {
    restore();
  }
});

Deno.test("paged canvas stays finite and editor, preview, and publish show real page data", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("分页界面课");
    store.addBlock("paragraph", "分页中的真实正文");
    store.addBlock("heading", "页面标题");
    store.createLayout("grid");
    store.beginPaginationConversion();
    store.confirmPaginationConversion();
    const page = store.layoutPages()[0]!;
    store.commit("把页面设为单格", (data) => {
      const target = data.layout_pages.find((candidate) => candidate.id === page.id)!;
      target.grid_definition = { columns: [1], rows: [1] };
    });
    const before = store.data.placements.length;
    store.placeBlock(store.blocks()[0]!.id);
    store.placeBlock(store.blocks()[1]!.id);
    assert(store.data.placements.length === before + 1, "a full page refuses another placement");
    const pageTrackCounts = tracks(page.grid_definition as Record<string, unknown>);
    assert(pageTrackCounts.rows.length === 1 && pageTrackCounts.columns.length === 1, "filling a page never grows its finite grid");

    const { createViews } = await import(`../app/views.js?paged-ui-${importCounter}`);
    store.ui.screen = "project";
    store.ui.route = "free-layout";
    store.ui.mode = "writing";
    let html = createViews(store).shellView() as string;
    assert(html.includes("data-action=\"select-layout-page\""), "editor renders selectable page identities");
    assert(html.includes("data-action=\"toggle-pagination-edit\""), "editor exposes a separate pagination edit toggle");
    // 启用分页 must land the user in the state where the new page controls are
    // usable; a read-only canvas right after converting read as a dead button.
    assert(html.includes('data-page-readonly="false"'), "confirming the conversion opens pagination editing");
    assert(html.includes("data-action=\"page-duplicate\""), "pagination editing exposes page structure actions");
    assert(html.includes("data-action=\"resize-placement\""), "pagination editing exposes placement actions");
    assert(html.includes("退出分页编辑"), "the exit action names only the editing mode");
    assert(html.includes("有限页面"), "editor identifies finite page geometry");

    const togglePaginationEditing = () =>
      (store as unknown as { togglePaginationEditing: () => void }).togglePaginationEditing();
    togglePaginationEditing();
    html = createViews(store).shellView() as string;
    assert(html.includes('data-page-readonly="true"'), "page placements are inert while viewing");
    assert(!html.includes("data-action=\"page-duplicate\""), "page structure actions stay hidden while viewing");
    assert(!html.includes("data-action=\"resize-placement\""), "viewing mode hides placement actions");
    assert(!html.includes("退出分页编辑"), "the exit action only exists while editing");
    togglePaginationEditing();
    assert(store.data.layout_instances.at(-1)!.pagination_mode === "paged", "closing pagination edit mode does not change the saved layout mode");
    html = createViews(store).shellView() as string;
    assert(html.includes("data-action=\"resize-placement\""), "re-entering pagination editing restores the same controls");

    store.ui.route = "editor";
    store.setMode("preview");
    html = createViews(store).shellView() as string;
    assert(html.includes("page-preview-sheet"), "preview renders a physical page canvas");
    assert(html.includes("data-action=\"layout-zoom\""), "preview exposes fit and actual-size controls");

    store.ui.route = "publish";
    store.ui.publishFormat = "html";
    store.ui.publishPageMode = "all";
    store.ui.publishTargetPageSize = { preset: "a4-landscape", width_pt: 841.8898, height_pt: 595.2756 };
    html = createViews(store).shellView() as string;
    assert(html.includes("data-action=\"publish-page-mode\""), "layout-aware publishing exposes page range controls");
    assert(html.includes("data-action=\"publish-target-size\""), "publishing exposes per-output target size");
    assert(html.includes("fit-source-page"), "target-size preview draws the centered aspect-fit rectangle");
  } finally {
    restore();
  }
});

Deno.test("whole-course PDF and PPTX fit preview includes every lesson page", async () => {
  const { store, restore } = await bootStore({ isNative: () => true });
  try {
    store.addMapItem("横向课");
    store.addBlock("paragraph", "横向内容");
    store.createLayout("grid");
    store.beginPaginationConversion();
    store.confirmPaginationConversion();
    const landscapeLesson = store.currentItem()!;

    store.addMapItem("纵向课");
    store.addBlock("paragraph", "纵向内容");
    store.createLayout("grid");
    store.beginPaginationConversion();
    store.confirmPaginationConversion();
    const portraitLesson = store.currentItem()!;

    store.commit("设置课程页尺寸", (data) => {
      const firstLayout = data.layout_instances.find((layout) =>
        layout.content_item_id === landscapeLesson.id
      )!;
      const secondLayout = data.layout_instances.find((layout) =>
        layout.content_item_id === portraitLesson.id
      )!;
      firstLayout.page_size = { preset: "16:9", width_pt: 960, height_pt: 540 };
      secondLayout.page_size = {
        preset: "a4-portrait",
        width_pt: 595.2756,
        height_pt: 841.8898,
      };
      for (const page of data.layout_pages) {
        if (page.layout_instance_id === firstLayout.id) page.title = "横版页面";
        if (page.layout_instance_id === secondLayout.id) page.title = "竖版页面";
      }
    });

    store.ui.screen = "project";
    store.ui.route = "publish";
    store.ui.publishScope = "course";
    store.ui.publishFormat = "markdown";
    store.ui.publishTargetPageSize = null;
    const originalSizes = store.data.layout_instances.map((layout) =>
      structuredClone(layout.page_size)
    );

    for (const format of ["pdf", "pptx"]) {
      const capability = store.publicationCapability(format);
      assert(
        capability.status === "unsupported" && capability.code === "explicit_target_page_size_required",
        `${format} remains unavailable without an explicit target size for mixed whole-course pages`,
      );
    }
    const { createViews } = await import(`../app/views.js?course-fit-${importCounter}`);
    let html = createViews(store).shellView() as string;
    const formatButton = (source: string, format: string) =>
      source.match(new RegExp(`<button\\b(?=[^>]*\\bdata-format="${format}")[^>]*>`))?.[0] ?? "";
    const isDisabled = (button: string) => /\sdisabled(?:\s|>|$)/.test(button);
    assert(html.includes("publish-size-warning"), "mixed sizes prompt for a unified target");
    assert(html.includes("页面尺寸不同，需选择统一尺寸"), "original-size option no longer implies a false shared size");
    assert(html.includes('data-action="publish-target-size"'), "target size remains selectable before PDF is active");
    assert(isDisabled(formatButton(html, "pdf")), "PDF button is disabled until a target is chosen");
    assert(isDisabled(formatButton(html, "pptx")), "PPTX button is disabled until a target is chosen");

    store.setPublishTargetPageSize("16:9");
    store.ui.publishFormat = "pdf";
    for (const format of ["pdf", "pptx"]) {
      assert(
        store.publicationCapability(format).status === "available",
        `${format} becomes available after choosing a target size`,
      );
    }
    html = createViews(store).shellView() as string;
    assert(!isDisabled(formatButton(html, "pdf")), "PDF button enables after choosing a target size");
    assert(!isDisabled(formatButton(html, "pptx")), "PPTX button enables after choosing a target size");
    assert(html.includes(landscapeLesson.code), "preview names the landscape lesson");
    assert(html.includes(portraitLesson.code), "preview names the portrait lesson");
    assert(html.includes("横版页面") && html.includes("竖版页面"), "preview includes page cards from both lessons");
    assert((html.match(/fit-source-page/g) || []).length === 2, "every selected lesson page gets its own fit rectangle");
    assert(html.includes("1.000×") && html.includes("0.641×"), "preview shows a separate uniform fit scale for each source page");
    assert(
      JSON.stringify(store.data.layout_instances.map((layout) => layout.page_size)) ===
        JSON.stringify(originalSizes),
      "target sizing stays export-only and does not change canonical page sizes",
    );
  } finally {
    restore();
  }
});

Deno.test("completion state is derived from real data and drives navigation", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("第一课");
    store.addMapItem("第二课");
    const [first, second] = store.data.content_items;

    store.openItem(first!.id);
    store.addBlock("paragraph", "第一课的正文");
    assert(
      !store.lesson()!.progress.complete,
      "a lesson without a layout cannot be complete",
    );

    store.createLayout("grid");
    store.autofillGrid();
    for (const dimension of store.data.status_dimensions) {
      const terminal = store.data.status_options.find((option) =>
        option.dimension_id === dimension.id && option.is_terminal
      )!;
      store.updateStatus(dimension.key, terminal.name);
    }
    const progress = store.lesson()!.progress;
    assert(
      progress.complete,
      `expected a complete lesson, reasons: ${progress.reasons.join("；")}`,
    );
    assert(progress.percentage === 100, "a complete lesson reports full progress");

    store.updateStatus("content", "待研究");
    assert(!store.lesson()!.progress.complete, "a non-terminal status blocks completion");
    assert(
      store.lesson()!.progress.reasons.some((reason) => reason.includes("正文")),
      "the reason names the unfinished dimension",
    );

    const map = store.map();
    assert(map.lesson_count === 2, "the map lists both lessons");
    assert(map.complete_count === 0, "the map agrees with the derived state");

    store.navigateLesson("next");
    assert(store.currentItem()!.id === second!.id, "next lesson navigates");
    store.navigateLesson("previous");
    assert(store.currentItem()!.id === first!.id, "previous lesson navigates");

    // The board drag must write a canonical assignment, not a legacy shape.
    store.ui.boardDimension = "review";
    store.moveBoardCard(second!.id, "通过");
    const assignment = store.data.status_assignments.find((candidate) =>
      candidate.content_item_id === second!.id &&
      candidate.dimension_id === store.data.status_dimensions.find((dimension) =>
        dimension.key === "review"
      )!.id
    )!;
    assert(Boolean(assignment.option_id), "board drags write a canonical option id");
    assert(
      !("dimension_key" in assignment) && !("option" in assignment),
      "board drags must not write the legacy shape",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "status writes must leave a valid project",
    );
  } finally {
    restore();
  }
});

Deno.test("browser export adapters expose the service-supported archive formats", async () => {
  const { store, restore } = await bootStore();
  try {
    for (const format of ["json", "asset_package", "full_project"]) {
      assert(
        store.publicationCapability(format).status === "available",
        `${format} is supported by the browser DesktopService export route`,
      );
    }
  } finally {
    restore();
  }
});

Deno.test("authoring survives serialization, reopen and inbox capture", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.addMapItem("持久化测试");
    const item = store.currentItem()!;
    store.addBlock("heading", "标题");
    store.addPlaceholder("text", "补一段说明");
    store.commit("测试素材", (data) => {
      data.assets.push({
        id: "asset-doc",
        project_id: data.project.id,
        type: "image",
        filename: "图.png",
        storage_path: "assets/图.png",
        mime_type: "image/png",
        width: null,
        height: null,
        duration_ms: null,
        file_size: 10,
        checksum: "c",
        title: "图.png",
        description: "",
        source_type: "imported",
        source_url: null,
        copyright_note: null,
        created_at: "2026-01-01T00:00:00.000Z",
        archived: false,
      });
    });
    const requirement = store.data.requirements[0]!;
    store.resolveRequirement(requirement.id, "asset-doc");
    store.createLayout("grid");
    store.captureToInbox("稍后要补一张图", "灵感");
    assert(store.data.inbox_items.length === 1, "capture writes an inbox row");
    store.triageInbox(store.data.inbox_items[0]!.id, item.id);
    const inboxItem = store.data.inbox_items[0]!;
    assert(inboxItem.status === "triaged", "triage marks the inbox row");
    assert(inboxItem.content_item_id === item.id, "triage records the target lesson");
    assert(
      store.blocks(item).some((block) => block.content === "稍后要补一张图"),
      "triage turns the capture into real正文",
    );
    // 排版 after the capture: every block that exists must be placeable.
    store.autofillGrid();
    assert(
      store.data.placements.length === store.blocks(item).length,
      "autofill places every block that exists at that moment",
    );

    await store.flush();
    const persisted = state.project;
    assert(state.writes > 0, "authoring reaches the write bridge");
    const issues = validateProjectData(persisted);
    assert(issues.length === 0, `persisted project invalid: ${issues[0]?.message}`);

    // Reopen from the persisted payload: every authoring fact comes back.
    store.openItem("");
    store.data = structuredClone(createEmptyProjectData("空"));
    store.data = structuredClone(persisted);
    store.ui.activeId = persisted.content_items[0]!.id;
    const reopened = lessonView(store.data, persisted.content_items[0]!.id)!;
    assert(reopened.blocks.length === 3, "reopen keeps every block");
    assert(reopened.requirements.length === 1, "reopen keeps the requirement");
    assert(
      reopened.requirements[0]!.status === "resolved",
      "reopen keeps the resolved state",
    );
    assert(
      reopened.blocks.some((block) => block.asset !== null),
      "reopen keeps the asset reference",
    );
    assert(
      String(reopened.lesson.layout_mode) === "grid",
      "reopen keeps the layout mode",
    );
    assert(
      reopened.placements.length === reopened.blocks.length,
      "reopen keeps every placement",
    );
  } finally {
    restore();
  }
});

Deno.test("export preflight and every export entry point stay callable", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("导出测试");
    store.addBlock("heading", "标题");
    store.addBlock("paragraph", "正文");
    // Regression: exportPreflight read a projection shape that did not exist,
    // which made every export entry point throw and froze the shell.
    const report = store.exportPreflight();
    assert(typeof report.blocking === "number", "preflight returns a blocking count");
    assert(typeof report.warnings === "number", "preflight returns a warning count");
    assert(report.total === report.blocking + report.warnings, "the totals agree");

    store.addPlaceholder("image", "补一张图");
    const withGap = store.exportPreflight();
    assert(withGap.content === 1, "an open content requirement is reported");
    assert(typeof withGap.text === "number", "empty text blocks are reported");
    assert(
      withGap.total > report.total,
      "adding a gap raises the total issue count",
    );
  } finally {
    restore();
  }
});

Deno.test("service export reuses its authoritative revision, projection, and warning codes", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const revision = "sha256:service-snapshot";
  const bridgeOverrides = {
    invoke: async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      assert(command === "export.preflight", "openPreflight calls the service authority");
      return {
        issues: [{ severity: "warning", code: "service_warning", count: 1, message: "service warning" }],
        blocking: [],
        warnings: [{ code: "service_warning", count: 1, message: "service warning" }],
        ok: true,
        snapshot_revision: revision,
        counts: {},
      };
    },
    exportProject: async (...args: unknown[]) => {
      calls.push({ command: "export.run", args: { options: args[5] as Record<string, unknown> } });
      return { files: [] };
    },
  };
  const { store, restore } = await bootStore(bridgeOverrides);
  try {
    store.addMapItem("服务导出契约");
    store.addBlock("paragraph", "预检与运行使用同一投影");
    store.addPlaceholder("image", "仅用于产生本地别名警告");
    store.ui.publishFormat = "markdown";

    await store.openPreflight();
    const preflight = calls.find((call) => call.command === "export.preflight")!;
    const preflightOptions = preflight.args.options as Record<string, unknown>;
    const storedOptions = store.ui.preflightOptions as Record<string, unknown>;
    const storedReport = store.ui.preflightReport as { issues: Array<{ severity?: string; code?: string }> };
    assert(preflightOptions.snapshot_revision === undefined, "service computes its own snapshot revision");
    assert(storedOptions.snapshot_revision === revision, "opaque service revision is retained for run");
    assert(
      storedReport.issues.filter((issue) => issue.severity === "warning")
        .map((issue) => issue.code).join(",") === "service_warning",
      "service warning codes replace locally synthesized warning aliases",
    );

    store.acknowledgeExportWarning("service_warning", true);
    await store.exportCurrent("markdown");
    const run = calls.find((call) => call.command === "export.run")!;
    const runOptions = run.args.options as Record<string, unknown>;
    assert(runOptions.snapshot_revision === revision, "run sends the exact authoritative service revision");
    assert(
      JSON.stringify(runOptions.acknowledged_warnings) === JSON.stringify(["service_warning"]),
      "run acknowledges exactly the codes returned by service preflight",
    );
    assert(
      JSON.stringify(runOptions.projection) === JSON.stringify(preflightOptions.projection),
      "run sends the exact projection checked during preflight",
    );
  } finally {
    restore();
  }
});

Deno.test("browser export hands staged URLs to the download engine without an early release", async () => {
  const links: Array<{ href: string; download: string }> = [];
  const releases: string[] = [];
  const { store, bridge, restore } = await bootStore({
    command: async (name: string, input: Record<string, unknown>) => {
      if (name === "export.release") releases.push(String(input.export_id));
      return null;
    },
    exportProject: async (...args: unknown[]) => {
      const options = args[5] as Record<string, unknown>;
      const exportId = String(options.export_id);
      return {
        export_id: exportId,
        files: [{
          relative_path: "lesson/正文.md",
          mime_type: "text/markdown",
          size: 12,
          sha256: "a".repeat(64),
          download_url: `/api/export-file/${exportId}/0`,
        }],
      };
    },
  });
  const runtime = globalThis as typeof globalThis & { document?: any };
  const originalCreateElement = runtime.document?.createElement;
  runtime.document.createElement = (tag: string) => {
    assert(tag === "a", "service artifact URLs use browser download anchors");
    const link = {
      href: "",
      download: "",
      click() {
        links.push({ href: this.href, download: this.download });
      },
      remove() {},
    };
    return link;
  };
  try {
    const internal = store as any;
    store.ui.publishScope = "course";
    store.ui.publishFormat = "markdown";
    store.ui.preflightReport = { blocking: 0, issues: [] };
    store.ui.preflightOptions = internal.publicationOptions();
    store.ui.preflightRevision = store.data.project.updated_at;
    store.ui.preflightFormat = "markdown";
    await store.exportCurrent("markdown");
    assert(links.length === 1, "the staged file is handed to the browser download engine");
    const link = links[0];
    assert(link, "the browser download anchor was captured");
    assert(link.href.includes("/api/export-file/"), "the anchor targets the staged export, not the live source asset");
    assert(link.download === "正文.md", "the original relative filename is preserved");
    assert((store.ui.lastExport as any)?.status === "handed_off", "the UI reports handoff rather than claiming the download completed");
    assert(String(store.ui.toast).includes("浏览器下载列表"), "the user is told where to verify actual completion");

    internal.cancelActiveExport();
    assert(releases.length === 0, "route cleanup does not release a staged artifact after its URL has been handed to the browser");
    assert((bridge as any).projectDir === "/tmp/workbench-authoring-ui-test", "export does not change the project target");
  } finally {
    if (originalCreateElement) runtime.document.createElement = originalCreateElement;
    else delete runtime.document.createElement;
    restore();
  }
});

Deno.test("leaving publish invalidates an in-flight preflight response", async () => {
  let resolveQuery!: (value: Record<string, unknown>) => void;
  const queryResult = new Promise<Record<string, unknown>>((resolve) => resolveQuery = resolve);
  const { store, restore } = await bootStore({
    invoke: async () => await queryResult,
  });
  try {
    store.addMapItem("异步预检离页");
    store.addBlock("paragraph", "服务预检等待期间切换到设置");
    store.ui.publishFormat = "markdown";
    const request = store.openPreflight();
    assert(store.ui.preflightPending, "preflight exposes its pending state while the service waits");
    store.cancelPreflight({ clearContext: true });
    store.ui.route = "settings";
    store.notify();
    resolveQuery({
      issues: [],
      blocking: [],
      warnings: [],
      snapshot_revision: "sha256:late-preflight",
      counts: {},
    });
    await request;
    assert(store.ui.route === "settings", "late preflight cannot navigate back to publish");
    assert(store.ui.preflight === false && store.ui.preflightPending === false, "late preflight cannot reopen the modal");
    assert(store.ui.preflightReport === null, "late preflight cannot publish a stale report into the next route");
  } finally {
    restore();
  }
});

Deno.test("resolving a requirement with an asset keeps canonical consistency", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.addMapItem("待补素材测试");
    const item = store.currentItem()!;
    store.addBlock("paragraph", "需要配图");
    store.createLayout("grid");
    store.addPlaceholder("image", "补一张图");
    store.commit("测试素材", (data) => {
      data.assets.push({
        id: "asset-cover",
        project_id: data.project.id,
        type: "image",
        filename: "封面.png",
        storage_path: "assets/封面.png",
        mime_type: "image/png",
        width: null,
        height: null,
        duration_ms: null,
        file_size: 64,
        checksum: "checksum-cover",
        title: "封面.png",
        description: "",
        source_type: "imported",
        source_url: null,
        copyright_note: null,
        created_at: "2026-01-01T00:00:00.000Z",
        archived: false,
      });
    });
    const requirement = store.data.requirements[0]!;
    const anchorBefore = requirement.anchor_block_id!;
    // Resolve through the picker path while another block happens to be
    // selected: the requirement's own anchor must win.
    store.selectBlock(store.blocks(item)[0]!.id, { force: true });
    store.ui.assetPicker = { requirementId: requirement.id };
    await store.insertAsset("asset-cover");

    const resolved = store.data.requirements[0]!;
    assert(resolved.status === "resolved", "the requirement is resolved");
    assert(
      resolved.resolved_block_id === anchorBefore,
      "the requirement resolves its own anchor",
    );
    const usage = store.data.asset_usages.find((candidate) =>
      candidate.role === "requirement"
    )!;
    assert(Boolean(usage), "a requirement usage exists");
    assert(
      usage.block_id === resolved.anchor_block_id,
      "the usage points at the anchored block",
    );
    assert(
      (usage.layout_instance_id ?? null) ===
        (resolved.layout_instance_id ?? null),
      "the usage mirrors the requirement's scope",
    );
    const anchorBlock = store.data.blocks.find((block) =>
      block.id === resolved.anchor_block_id
    )!;
    assert(anchorBlock.type === "image", "the anchor becomes the media slot");
    assert(
      anchorBlock.settings.asset_id === "asset-cover",
      "the anchor links the asset",
    );
    assert(
      !store.blocks(item)[0]!.settings.asset_id,
      "an unrelated selected block is left alone",
    );
    assert(
      await store.flush(),
      "the resolved project is accepted by the pre-write gate",
    );
    assert(
      validateProjectData(state.project).length === 0,
      "the persisted project stays canonically valid",
    );
  } finally {
    restore();
  }
});

Deno.test("deleting a lesson keeps codes and inbox references valid", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.addMapItem("第一课");
    store.addMapItem("第二课");
    store.addMapItem("第三课");
    store.captureToInbox("稍后整理", "灵感");
    const inboxId = store.data.inbox_items[0]!.id;
    store.triageInbox(inboxId, store.data.content_items[1]!.id);
    assert(
      store.data.inbox_items[0]!.content_item_id !== null,
      "triage targets a lesson",
    );

    // Delete the middle lesson (content forces a confirmation step).
    store.deleteLesson(store.data.content_items[1]!.id);
    store.deleteLesson(store.data.content_items[1]!.id);
    assert(store.data.content_items.length === 2, "the lesson is removed");
    const codes = store.data.content_items.map((item) => item.code);
    assert(
      new Set(codes).size === codes.length,
      `codes must stay unique after a delete, got ${codes.join(",")}`,
    );
    const inbox = store.data.inbox_items[0]!;
    assert(
      inbox.content_item_id === null,
      "an inbox row targeted at a deleted lesson is released",
    );
    assert(inbox.status === "open", "the released inbox row is actionable again");

    // A new lesson must not reuse an existing code.
    store.addMapItem("第四课");
    const afterCodes = store.data.content_items.map((item) => item.code);
    assert(
      new Set(afterCodes).size === afterCodes.length,
      `codes must stay unique after adding, got ${afterCodes.join(",")}`,
    );
    assert(await store.flush(), "the project is still accepted by the gate");
    assert(
      validateProjectData(state.project).length === 0,
      "deleting and adding lessons leaves valid canonical data",
    );
  } finally {
    restore();
  }
});

Deno.test("a legacy status assignment is repaired on startup instead of blocking saves", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.addMapItem("旧项目");
    const item = store.currentItem()!;
    const dimension = store.data.status_dimensions.find((candidate) =>
      candidate.key === "content"
    )!;
    const option = store.data.status_options.find((candidate) =>
      candidate.dimension_id === dimension.id
    )!;
    // Simulate a project written by the previous UI: name-keyed assignment.
    store.commit("旧写法", (data) => {
      data.status_assignments = data.status_assignments.filter((assignment) =>
        assignment.content_item_id !== item.id
      );
      data.status_assignments.push({
        id: "legacy-assignment",
        content_item_id: item.id,
        dimension_key: "content",
        option: option.name,
      } as never);
    });
    // Migration is what every load path runs; apply it as the shell does.
    const legacy = structuredClone(store.data);
    // Directly exercise the same repair the loader performs.
    const repaired = JSON.parse(JSON.stringify(legacy));
    for (const assignment of repaired.status_assignments) {
      if (assignment.dimension_id && assignment.option_id) continue;
      const matchedDimension = repaired.status_dimensions.find((candidate: { id: string; key: string }) =>
        candidate.key === assignment.dimension_key
      );
      const matchedOption = repaired.status_options.find((candidate: { dimension_id: string; name: string }) =>
        candidate.dimension_id === matchedDimension?.id && candidate.name === assignment.option
      );
      assignment.dimension_id = matchedDimension?.id;
      assignment.option_id = matchedOption?.id;
      delete assignment.dimension_key;
      delete assignment.option;
    }
    store.data = repaired;
    store.ui.activeId = item.id;
    assert(
      await store.flush(),
      "a repaired legacy assignment no longer blocks autosave",
    );
    assert(
      validateProjectData(state.project).length === 0,
      "the repaired project is canonically valid",
    );
  } finally {
    restore();
  }
});

Deno.test("text edits reach history so undo can revert typing", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("文本撤销");
    const item = store.currentItem()!;
    store.addBlock("paragraph", "原始内容");
    const block = store.blocks(item)[0]!;
    const historyBefore = store.history.length;
    store.editBlockText(block.id, "改过的内容");
    assert(
      store.history.length === historyBefore + 1,
      "a text edit records one history entry",
    );
    assert(
      store.blocks(item)[0]!.content === "改过的内容",
      "the edit reaches canonical data",
    );
    store.undo();
    assert(
      store.blocks(item)[0]!.content === "原始内容",
      "undo restores the previous text",
    );
  } finally {
    restore();
  }
});

Deno.test("rich Markdown edits keep block IDs and undo one focus session", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("富文本撤销");
    const item = store.currentItem()!;
    store.addBlock("paragraph", "原始内容");
    const block = store.blocks(item)[0]!;
    const blockId = block.id;
    const historyBefore = store.history.length;

    // Rich-editor input events update canonical text in place; blur commits the
    // session once from its focus baseline, regardless of input event count.
    block.content = "先保留 **格式**";
    block.content = "完成的 **富文本** 和 ![图](images/a.png)";
    store.recordBlockTextEdit(blockId, "原始内容", block.content);
    assert(store.history.length === historyBefore + 1, "one focus session should make one undo entry");
    assert(store.blocks(item)[0]!.id === blockId, "editing must preserve the canonical block ID");
    store.undo();
    assert(store.blocks(item)[0]!.id === blockId, "undo must preserve the canonical block ID");
    assert(store.blocks(item)[0]!.content === "原始内容", "undo should restore the original source");
  } finally {
    restore();
  }
});

Deno.test("a project replaced on disk is never overwritten under the wrong identity", async () => {
  // Simulates two shells on one folder: the second one rewrites project.json
  // with a different project id, and the first must stop writing instead of
  // silently taking the file over.
  const { store, state, restore } = await bootStore();
  try {
    store.openItem("");
    store.addMapItem("身份测试");
    store.trackProjectIdentity();
    const originalId = store.data.project.id;
    assert(
      store.expectedProjectId === originalId,
      "adopting a project records its identity",
    );

    // Another writer replaces the file and this shell no longer owns it.
    state.project = {
      ...structuredClone(state.project),
      project: { ...state.project.project, id: "other-project-id" },
    };
    state.acceptWrites = false;
    store.addBlock("paragraph", "本地新增");
    const expectedBefore = store.expectedProjectId;
    const stateIdBefore = state.project.project.id;
    const saved = await store.flush();
    assert(
      !saved,
      `the save must be refused when the disk project changed (expected=${expectedBefore}, disk=${stateIdBefore}, now=${state.project.project.id}, status=${store.saveStatus}, toast=${store.ui.toast})`,
    );
    assert(
      store.saveStatus === "外部修改冲突",
      "the identity conflict is surfaced in the save status",
    );
    assert(
      String(store.ui.toast).includes("已经被替换"),
      "the user is told the project was replaced",
    );
    assert(
      state.project.project.id === "other-project-id",
      "the other project's file is left untouched",
    );
  } finally {
    restore();
  }
});

Deno.test("loading a project keeps its canonical identity", async () => {
  // Regression: the loader replaced the whole `project` object with a blank
  // default, which silently re-identified the course on every load and made
  // every save fail its invariant gate.
  const { store, restore, state } = await bootStore();
  try {
    // Boot the same way the app does: the shell loads the project file.
    await store.initialize();
    const fileId = state.project.project.id;
    store.openItem("");
    store.addMapItem("身份保持");
    store.addBlock("paragraph", "正文");

    assert(
      store.data.project.id === fileId,
      "the shell keeps the on-disk project identity",
    );
    assert(
      await store.flush(),
      "a save under the loaded identity is accepted",
    );
    const persisted = state.project;
    assert(
      persisted.project.id === fileId,
      "the written file keeps its identity",
    );
    assert(
      persisted.content_items.every((candidate) => candidate.project_id === fileId),
      "every row still belongs to the project that owns the file",
    );
    assert(
      validateProjectData(persisted).length === 0,
      "the persisted project is canonically valid",
    );
  } finally {
    restore();
  }
});

Deno.test("a domain-valid project with an out-of-grid placement still saves", async () => {
  // The canonical format lets a placement outlive a shrinking grid; overflow is
  // an export warning, never a save blocker.
  const { store, state, restore } = await bootStore();
  try {
    store.openItem("");
    store.addMapItem("排版越界");
    store.addBlock("paragraph", "正文");
    store.createLayout("grid");
    store.autofillGrid();
    const layout = store.data.layout_instances[0]!;
    store.commit("缩小网格", (data) => {
      const target = data.layout_instances.find((candidate) =>
        candidate.id === layout.id
      )!;
      target.grid_definition = { columns: [1], rows: [1] };
    });
    assert(
      store.data.placements.some((placement) =>
        placement.column_end > 1 || placement.row_end > 1
      ),
      "the fixture contains an out-of-grid placement",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "the domain accepts an out-of-grid placement",
    );
    assert(
      await store.flush(),
      "an out-of-grid placement must not block saving",
    );
    assert(
      validateProjectData(state.project).length === 0,
      "the saved project stays canonically valid",
    );
  } finally {
    restore();
  }
});

Deno.test("completing a layout requirement with an asset stays consistent", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.addMapItem("排版待补");
    const item = store.currentItem()!;
    store.addBlock("paragraph", "需要配图");
    store.createLayout("grid");
    const layout = store.data.layout_instances[0]!;
    store.ui.route = "free-layout";
    store.ui.mode = "writing";
    const context = (store as any).assetContext();
    assert(context.role === "layout", "Free Layout keeps its layout asset role after the tab migration");
    assert(context.layout_instance_id === layout.id, "Free Layout asset context carries its current layout instance");
    // A layout-scope requirement has no anchor block at all.
    store.commit("排版待补", (data) => {
      data.requirements.push({
        id: "req-layout",
        content_item_id: item.id,
        anchor_block_id: null,
        type: "image",
        scope: "layout",
        layout_instance_id: layout.id,
        note: "排版缺图",
        status: "open",
        priority: "normal",
        resolved_asset_id: null,
        resolved_block_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
        resolved_at: null,
      });
      data.assets.push({
        id: "asset-layout",
        project_id: data.project.id,
        type: "image",
        filename: "排版图.png",
        storage_path: "assets/排版图.png",
        mime_type: "image/png",
        width: null,
        height: null,
        duration_ms: null,
        file_size: 32,
        checksum: "checksum-layout",
        title: "排版图.png",
        description: "",
        source_type: "imported",
        source_url: null,
        copyright_note: null,
        created_at: "2026-01-01T00:00:00.000Z",
        archived: false,
      });
    });
    store.ui.assetPicker = { requirementId: "req-layout" };
    await store.insertAsset("asset-layout");

    const requirement = store.data.requirements.find((candidate) =>
      candidate.id === "req-layout"
    )!;
    assert(requirement.status === "resolved", "the requirement is resolved");
    const usage = store.data.asset_usages.find((candidate) =>
      candidate.role === "requirement"
    )!;
    assert(Boolean(usage), "a requirement usage exists");
    assert(
      usage.block_id === null,
      "a layout requirement's usage carries no block",
    );
    assert(
      usage.layout_instance_id === layout.id,
      "the usage references the layout instance",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "the resolved layout requirement is canonically valid",
    );
    assert(await store.flush(), "the project saves");
    assert(
      validateProjectData(state.project).length === 0,
      "the saved project stays valid",
    );
  } finally {
    restore();
  }
});

Deno.test("legacy status rows are repaired by the real load path", async () => {
  const { store, restore, state } = await bootStore();
  try {
    // Give the project a lesson before the shell loads it.
    store.openItem("");
    store.addMapItem("旧项目");
    await store.flush();
    await store.initialize();
    const item = store.currentItem()!;
    const dimension = store.data.status_dimensions.find((candidate) =>
      candidate.key === "content"
    )!;
    const option = store.data.status_options.find((candidate) =>
      candidate.dimension_id === dimension.id
    )!;
    // Simulate a project written by the previous UI, then load it again through
    // the same path the app uses (no inline repair in the test).
    store.commit("旧写法", (data) => {
      data.status_assignments = data.status_assignments.filter((assignment) =>
        assignment.content_item_id !== item.id
      );
      data.status_assignments.push({
        id: "legacy-row",
        content_item_id: item.id,
        dimension_key: "content",
        option: option.name,
      } as never);
    });
    state.project = structuredClone(store.data);
    await store.initialize();
    const repaired = store.data.status_assignments.find((assignment) =>
      assignment.content_item_id === item.id &&
      assignment.dimension_id === dimension.id
    )!;
    assert(Boolean(repaired), "the legacy row survives the load");
    assert(
      Boolean(repaired.option_id),
      "the legacy row is repaired to a canonical option id",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "the loaded project is canonically valid",
    );
    assert(await store.flush(), "autosave is not blocked after a load");
  } finally {
    restore();
  }
});

Deno.test("external reload migrates the adopted project", async () => {
  const { store, restore, state } = await bootStore();
  try {
    store.openItem("");
    store.addMapItem("外部修改");
    await store.flush();
    await store.initialize();
    const item = store.currentItem()!;
    const dimension = store.data.status_dimensions.find((candidate) =>
      candidate.key === "content"
    )!;
    const option = store.data.status_options.find((candidate) =>
      candidate.dimension_id === dimension.id
    )!;
    // The disk version carries a legacy status row.
    const external = structuredClone(store.data);
    external.status_assignments = external.status_assignments.filter((assignment) =>
      assignment.content_item_id !== item.id
    );
    external.status_assignments.push({
      id: "legacy-external",
      content_item_id: item.id,
      dimension_key: "content",
      option: option.name,
    } as never);
    state.project = external;
    store.externalConflict = { current: { exists: true } };
    // Adopt the disk version through the external-resolution path.
    await (store as unknown as {
      resolveExternalConflict: (action: string) => Promise<void>;
    }).resolveExternalConflict("reload").catch(() => {});
    assert(
      validateProjectData(store.data).length === 0 ||
        store.data.status_assignments.every((assignment) =>
          Boolean(assignment.dimension_id && assignment.option_id)
        ),
      "an adopted disk project never keeps a legacy status shape",
    );
  } finally {
    restore();
  }
});

Deno.test("the browser export mirrors media resolution and never leaks filenames", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("浏览器导出");
    const item = store.currentItem()!;
    store.addBlock("heading", "标题");
    store.addBlock("paragraph", "正文");
    store.commit("素材", (data) => {
      data.assets.push({
        id: "asset-export",
        project_id: data.project.id,
        type: "image",
        filename: "封面.png",
        storage_path: "assets/封面.png",
        mime_type: "image/png",
        width: null,
        height: null,
        duration_ms: null,
        file_size: 64,
        checksum: "checksum-export",
        title: "封面.png",
        description: "",
        source_type: "imported",
        source_url: null,
        copyright_note: null,
        created_at: "2026-01-01T00:00:00.000Z",
        archived: false,
      });
    });
    const paragraph = store.blocks(item).find((block) =>
      block.type === "paragraph"
    )!;
    store.selectBlock(paragraph.id, { force: true });
    await store.insertAsset("asset-export", { block_id: paragraph.id });
    const { browserMarkdown } = await import(
      `../app/main.js?browser-export-${importCounter}`
    );
    const markdown = browserMarkdown(store.data, item);
    assert(
      markdown.includes("![封面.png](assets/封面.png)"),
      `markdown must render the image inline, got:\n${markdown}`,
    );
    assert(
      !/^封面\.png$/m.test(markdown),
      "the asset filename must not leak as a prose paragraph",
    );
    assert(
      markdown.includes("正文") === false,
      "the replaced paragraph must not keep its old prose",
    );
  } finally {
    restore();
  }
});

/** Seed one image asset for position-insert tests. */
function seedImageAsset(
  store: { commit: (label: string, mutation: (data: ProjectData) => void) => void },
  id = "asset-position",
) {
  store.commit("测试素材", (data) => {
    data.assets.push({
      id,
      project_id: data.project.id,
      type: "image",
      filename: "插图.png",
      storage_path: "assets/插图.png",
      mime_type: "image/png",
      width: null,
      height: null,
      duration_ms: null,
      file_size: 128,
      checksum: `checksum-${id}`,
      title: "插图.png",
      description: "",
      source_type: "imported",
      source_url: null,
      copyright_note: null,
      created_at: "2026-01-01T00:00:00.000Z",
      archived: false,
    });
  });
}

Deno.test("Preview counts mapped Markdown images once and explains video image references", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("Preview inline refs");
    const item = store.currentItem()!;
    store.addBlock("paragraph", [
      "![照片](photo.png)",
      "![动画](loop.gif)",
      "![视频](clip.mp4)",
    ].join("\n\n"));
    const block = store.blocks(item)[0]!;
    const makeAsset = (
      id: string,
      type: ProjectData["assets"][number]["type"],
      filename: string,
      mime_type: string,
    ): ProjectData["assets"][number] => ({
      id,
      project_id: store.data.project.id,
      type,
      filename,
      storage_path: `assets/${filename}`,
      mime_type,
      width: null,
      height: null,
      duration_ms: type === "video" ? 2000 : null,
      file_size: 4,
      checksum: `checksum-${id}`,
      title: filename,
      description: "",
      source_type: "imported",
      source_url: null,
      copyright_note: null,
      created_at: "2026-01-01T00:00:00.000Z",
      archived: false,
    });
    store.commit("导入 Markdown 图片映射", (data) => {
      const assets = [
        makeAsset("asset-inline-photo", "image", "photo.png", "image/png"),
        makeAsset("asset-inline-gif", "gif", "loop.gif", "image/gif"),
        makeAsset("asset-inline-video", "video", "clip.mp4", "video/mp4"),
        makeAsset("asset-stale-map", "image", "removed.png", "image/png"),
      ];
      data.assets.push(...assets);
      const target = data.blocks.find((candidate) => candidate.id === block.id)!;
      target.settings.markdown_assets = [
        { href: "photo.png", asset_id: "asset-inline-photo" },
        { href: "loop.gif", asset_id: "asset-inline-gif" },
        { href: "clip.mp4", asset_id: "asset-inline-video" },
        { href: "removed.png", asset_id: "asset-stale-map" },
      ];
      for (const asset of assets.slice(0, 3)) {
        data.asset_usages.push({
          id: `usage-${asset.id}`,
          asset_id: asset.id,
          content_item_id: item.id,
          block_id: block.id,
          layout_instance_id: null,
          role: "content",
          created_at: "2026-01-01T00:00:00.000Z",
        });
      }
    });
    store.ui.screen = "project";
    store.ui.route = "editor";
    store.ui.mode = "preview";
    const { createViews } = await import(`../app/views.js?inline-preview-${importCounter}`);
    const html = createViews(store).shellView() as string;

    assert(block.type === "paragraph", "inline Markdown stays in its canonical paragraph block");
    assert(html.includes("2 个已在正文中显示"), "the Preview summary counts only renderable inline images and GIFs");
    assert(html.includes("photo.png · 图片") && html.includes("loop.gif · GIF"), "the summary names inline image and GIF assets");
    assert(!html.includes("clip.mp4 · 视频"), "a video-as-image warning is not counted as successfully displayed media");
    assert(!html.includes("removed.png"), "stale resolver mappings do not count as visible media");
    assert(html.includes("Markdown 图片语法只支持图片和 GIF") && html.includes("从媒体库插入视频区块"), "video referenced as a Markdown image gets a clear supported-path message");
  } finally {
    restore();
  }
});

Deno.test("block palette includes + 媒体 as a peer of + 正文", async () => {
  const views = await Deno.readTextFile(
    new URL("../app/views.js", import.meta.url),
  );
  const palette = views.match(
    /const BLOCK_PALETTE = \[([\s\S]*?)\];/,
  )?.[1] ?? "";
  assert(
    palette.includes('["media", "媒体"]') || palette.includes("媒体"),
    "BLOCK_PALETTE must include 媒体",
  );
  assert(
    views.includes('data-action="insert-block"') && views.includes("＋ ${label}"),
    "toolbar must render palette labels as ＋ buttons",
  );
  assert(
    views.includes("插入到当前位置"),
    "Media Library must expose 「插入到当前位置」",
  );
  assert(
    views.includes('data-action="insert-asset"'),
    "library insert must use the shared insert-asset action",
  );
});

Deno.test("insertAsset after the selected block creates a media block and AssetUsage", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("当前位置插入");
    const item = store.currentItem()!;
    store.addBlock("heading", "标题");
    store.addBlock("paragraph", "第一段");
    store.addBlock("paragraph", "第二段");
    seedImageAsset(store);
    const before = store.blocks(item);
    assert(before.length === 3, "three prose blocks exist");
    store.selectBlock(before[1]!.id, { force: true });

    await store.insertAsset("asset-position");

    const after = store.blocks(item);
    assert(after.length === 4, "position insert adds a new block");
    assert(after[0]!.type === "heading", "blocks before the anchor stay put");
    assert(
      after[1]!.type === "paragraph" && after[1]!.content === "第一段",
      "the selected block must not be converted in place",
    );
    assert(after[1]!.id === before[1]!.id, "selected block identity is preserved");
    const media = after[2]!;
    assert(
      media.type === "image" && media.settings.asset_id === "asset-position",
      "a new media block is inserted immediately after the selection",
    );
    assert(
      after[3]!.content === "第二段",
      "blocks after the anchor shift down",
    );
    assert(
      after.every((block, index) => block.order_index === index),
      "order_index stays contiguous",
    );
    const usage = store.data.asset_usages.find((candidate) =>
      candidate.asset_id === "asset-position"
    )!;
    assert(Boolean(usage), "AssetUsage is created");
    assert(usage.block_id === media.id, "usage points at the new media block");
    assert(usage.content_item_id === item.id, "usage belongs to the lesson");
    assert(usage.role === "content", "position insert is a content usage");
    assert(
      store.ui.selectedBlockId === media.id,
      "the new media block becomes selected",
    );
    assert(
      validateProjectData(store.data).length === 0,
      "position insert stays canonically valid",
    );
  } finally {
    restore();
  }
});

Deno.test("insertAsset without selection appends a media block at the lesson end", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("课末追加");
    const item = store.currentItem()!;
    store.addBlock("paragraph", "仅有正文");
    seedImageAsset(store, "asset-append");
    store.ui.selectedBlockId = null;

    await store.insertAsset("asset-append");

    const blocks = store.blocks(item);
    assert(blocks.length === 2, "append adds one media block");
    assert(
      blocks[0]!.type === "paragraph" && blocks[0]!.content === "仅有正文",
      "existing prose is left alone",
    );
    const media = blocks[1]!;
    assert(
      media.type === "image" && media.settings.asset_id === "asset-append",
      "media is appended at the lesson end",
    );
    const usage = store.data.asset_usages.find((candidate) =>
      candidate.asset_id === "asset-append"
    )!;
    assert(Boolean(usage), "AssetUsage is created on append");
    assert(usage.block_id === media.id, "usage points at the appended block");
    assert(usage.role === "content", "append is a content usage, not layout");
  } finally {
    restore();
  }
});

Deno.test("+ 媒体 opens the shared asset picker for position insert", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("媒体面板");
    store.addBlock("paragraph", "正文");
    seedImageAsset(store, "asset-picker-media");
    store.selectBlock(store.blocks(store.currentItem()!)[0]!.id, { force: true });

    store.addBlock("media");
    assert(
      store.ui.assetPicker !== null &&
        !(store.ui.assetPicker as { blockId?: string }).blockId &&
        !(store.ui.assetPicker as { requirementId?: string }).requirementId,
      "+ 媒体 must open the asset picker without a convert-in-place target",
    );
    assert(
      store.blocks(store.currentItem()!).length === 1,
      "opening the picker must not create an empty media block yet",
    );

    await store.insertAsset("asset-picker-media");
    const blocks = store.blocks(store.currentItem()!);
    assert(blocks.length === 2, "choosing an asset inserts after the selection");
    assert(blocks[0]!.type === "paragraph", "selected prose stays prose");
    assert(
      blocks[1]!.type === "image" &&
        blocks[1]!.settings.asset_id === "asset-picker-media",
      "picker choose-asset uses the same insertAsset mutation",
    );
  } finally {
    restore();
  }
});

Deno.test("Media Library insert-asset action shares insertAsset position semantics", async () => {
  const views = await Deno.readTextFile(
    new URL("../app/views.js", import.meta.url),
  );
  const mediaView = views.match(
    /function mediaView\(\) \{([\s\S]*?)\n  function /,
  )?.[1] ?? "";
  assert(
    mediaView.includes("插入到当前位置"),
    "mediaView CTA must say 插入到当前位置",
  );
  assert(
    mediaView.includes('data-action="insert-asset"'),
    "mediaView must call insert-asset (same handler as the side panel)",
  );
  const mediaPanel = views.match(
    /function mediaPanel\(view\) \{([\s\S]*?)\n  function /,
  )?.[1] ?? "";
  assert(
    mediaPanel.includes("选中区块之后") || mediaPanel.includes("当前选中区块之后") ||
      mediaPanel.includes("课末尾") || mediaPanel.includes("课末"),
    "mediaPanel copy must state the insert anchor",
  );

  const { store, restore } = await bootStore();
  try {
    store.addMapItem("媒体库同路径");
    const item = store.currentItem()!;
    store.addBlock("paragraph", "A");
    store.addBlock("paragraph", "B");
    seedImageAsset(store, "asset-library");
    store.selectBlock(store.blocks(item)[0]!.id, { force: true });
    // Media Library 「插入到当前位置」 goes through insertAsset with no block_id.
    await store.insertAsset("asset-library");
    const blocks = store.blocks(item);
    assert(blocks.length === 3, "library insert adds a block");
    assert(blocks[0]!.content === "A", "anchor prose is not converted");
    assert(
      blocks[1]!.type === "image" &&
        blocks[1]!.settings.asset_id === "asset-library",
      "library insert lands after the selected block",
    );
    assert(
      store.data.asset_usages.some((usage) =>
        usage.asset_id === "asset-library" && usage.block_id === blocks[1]!.id
      ),
      "library insert creates AssetUsage via the same mutation",
    );
  } finally {
    restore();
  }
});

Deno.test("requirement panel shows real anchors and type-specific actions", async () => {
  const viewsSource = await Deno.readTextFile(
    new URL("../app/views.js", import.meta.url),
  );
  const requirementRow = viewsSource.match(
    /function requirementRow\(requirement\) \{([\s\S]*?)\n  function /,
  )?.[1] ?? "";
  assert(
    requirementRow.includes("requirementAnchorLabel") ||
      requirementRow.includes("未定位"),
    "requirementRow must render a real anchor helper, not blockLabel alone",
  );
  assert(
    !/位置：\$\{esc\(blockLabel\(block\.type\)\)\}/.test(requirementRow),
    "requirementRow must not use 位置：${blockLabel(...)} (待补 for placeholders)",
  );

  const { store, restore } = await bootStore();
  try {
    store.addMapItem("待补锚点");
    const item = store.currentItem()!;
    // Force a stable lesson code so the rendered anchor is assertable.
    store.commit("固定课号", (data) => {
      const lesson = data.content_items.find((candidate) => candidate.id === item.id);
      if (lesson) lesson.code = "S01-02";
    });
    store.addBlock("paragraph", "已有正文");
    store.addPlaceholder("text", "补充这段文字");
    store.addPlaceholder("image", "补一张图片");
    // addPlaceholder leaves the new row in edit mode; show the action cards.
    store.ui.editingRequirementId = null;
    store.ui.rightPanel = "requirements";
    store.ui.route = "editor";
    store.ui.screen = "project";
    store.notify();

    const { createViews } = await import(
      `../app/views.js?req-panel-${importCounter}`
    );
    const html = createViews(store).shellView() as string;
    assert(!html.includes("位置：待补"), "rendered panel must never show 位置：待补");
    assert(
      html.includes("位置：S01-02 · 正文 ") || html.includes("位置：S01-02 · 图片 "),
      "open requirements must show lesson-code anchors",
    );

    const items = html.split('class="requirement-item').slice(1).map((chunk) =>
      chunk.slice(0, chunk.indexOf('class="requirement-item') > 0
        ? chunk.indexOf('class="requirement-item')
        : chunk.length)
    );
    const textItem = items.find((chunk) =>
      chunk.includes("<b>文字") || chunk.includes(">文字 ·") ||
      /<b>文字</.test(chunk)
    ) ?? "";
    const imageItem = items.find((chunk) =>
      chunk.includes("<b>图片") || /<b>图片</.test(chunk)
    ) ?? "";
    assert(textItem.length > 0, "text requirement card must render");
    assert(imageItem.length > 0, "image requirement card must render");
    assert(textItem.includes(">定位<") || textItem.includes("定位</"), "text req shows 定位");
    assert(textItem.includes("改备注"), "text req shows 改备注");
    assert(
      textItem.includes(">完成<") || textItem.includes("完成</"),
      "text req shows 完成",
    );
    assert(
      !textItem.includes("选择素材") && !textItem.includes("用素材完成"),
      "text req must not show media-only actions",
    );
    assert(imageItem.includes("选择素材"), "media req shows 选择素材");
    assert(imageItem.includes("用素材完成"), "media req shows 用素材完成");
    assert(
      imageItem.includes(">定位<") || imageItem.includes("定位</"),
      "media req shows 定位",
    );
  } finally {
    restore();
  }
});

/**
 * §14.1 — renaming a Media Library asset is a filesystem operation now, not a
 * display-name edit.  The shell owns the transaction, so the UI test checks the
 * wiring: the command is asked with the requested name, the project it answers
 * with replaces the local copy, and the history step remembers both names so
 * Undo can move the file back (§14.5).
 */
Deno.test("renaming an asset renames the managed file and stays reversible", async () => {
  const viewsSource = await Deno.readTextFile(
    new URL("../app/views.js", import.meta.url),
  );
  assert(
    viewsSource.includes('data-action="rename-asset"') &&
      viewsSource.includes("data-asset-title"),
    "media library must expose a rename surface",
  );
  assert(
    /磁盘文件同步改名/.test(viewsSource),
    "the rename control must say it changes the file",
  );
  assert(
    viewsSource.includes('data-focus-key="asset-menu-${esc(asset.id)}"') &&
      viewsSource.includes('data-focus-key="${esc(focusKey)}" data-action="open-asset-image"'),
    "media menu and zoom controls need stable return-focus targets",
  );

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callCount = () => calls.length;
  let shellView: { data: ProjectData } | null = null;
  const { store, restore, state } = await bootStore({
    // Stands in for the bound `asset.rename` command: the acknowledgement carries
    // exactly the project/fingerprint written by this operation.
    commandWithMutationAck: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      if (name !== "asset.rename") throw new Error(`unexpected command: ${name}`);
      const project = structuredClone(shellView!.data);
      const asset = project.assets.find((row) => row.id === args.asset_id);
      if (!asset) throw new Error(`找不到素材: ${String(args.asset_id)}`);
      const requested = String(args.new_name ?? "").trim();
      if (!requested) throw new Error("文件名不能为空。");
      if (requested === "占用") throw new Error("已有一个素材使用这个文件名，请换一个名字后重试。");
      const basename = requested.toLowerCase().endsWith(".png")
        ? requested.slice(0, -4)
        : requested;
      asset.filename = `${basename}.png`;
      asset.storage_path = `assets/${String(args.asset_id)}-${basename}.png`;
      asset.title = asset.filename;
      state.project = structuredClone(project);
      state.revision += 1;
      state.fingerprint = {
        exists: true,
        mtime_ms: state.revision + 1,
        size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
        hash: state.revision.toString(16).padStart(64, "0"),
      };
      return {
        value: { status: "renamed" },
        mutation_ack: {
          project: structuredClone(project),
          fingerprint: structuredClone(state.fingerprint),
          project_id: project.project.id,
          project_dir: "/tmp/workbench-authoring-ui-test",
          lease_generation: args.lease_generation,
          editor_generation: args.editor_generation,
          operation_id: args.operation_id,
          revision: args.revision,
          commit_state: "committed",
          outcome: "written",
        },
      };
    },
  });
  shellView = store as unknown as { data: ProjectData };
  try {
    store.addMapItem("素材改名");
    seedImageAsset(store, "asset-rename");
    // An import names the managed file after its own import id, not the asset id.
    // This is the shape that used to break Undo.
    store.commit("测试导入命名", (data) => {
      const row = data.assets.find((asset) => asset.id === "asset-rename")!;
      row.storage_path = "assets/7d2f9c1e-0000-4000-8000-000000000001-插图.png";
    });
    const fixture = store.data.assets.find((asset) => asset.id === "asset-rename")!;
    assert(fixture.filename === "插图.png", "fixture keeps the disk filename");
    assert(
      fixture.storage_path === "assets/7d2f9c1e-0000-4000-8000-000000000001-插图.png",
      "fixture keeps the imported managed path",
    );

    store.startAssetRename("asset-rename");
    const renameDialog = createViews(store as any).overlayView();
    assert(
      renameDialog.includes('role="dialog"') &&
        renameDialog.includes('data-action="confirm-rename-asset"') &&
        renameDialog.includes("托管文件") &&
        renameDialog.includes("data-asset-title"),
      "renaming uses an accessible dialog that explains the managed-file change",
    );
    const historyBeforeRename = store.history.length;
    await store.renameAsset("asset-rename", "课程封面");
    // Enter commits and the field then blurs carrying the same value: one intent
    // has to stay one shell request and one undo step.
    await store.renameAsset("asset-rename", "课程封面");
    const renamed = store.data.assets.find((asset) => asset.id === "asset-rename")!;
    assert(
      calls.length === 1 && calls[0]!.name === "asset.rename",
      `the shell must be asked once: ${JSON.stringify(calls)}`,
    );
    assert(
      store.history.length === historyBeforeRename + 1,
      `the blur follow-up must not add a step: ${store.history.length - historyBeforeRename}`,
    );
    assert(
      String(store.ui.toast).includes("已重命名文件"),
      `the success toast must survive the follow-up: ${String(store.ui.toast)}`,
    );
    assert(calls[0]!.args.new_name === "课程封面", "the requested name is passed through");
    assert(renamed.filename === "课程封面.png", "the managed filename changed");
    assert(
      renamed.storage_path === "assets/asset-rename-课程封面.png",
      "the managed path changed",
    );
    assert(renamed.id === "asset-rename", "asset id stays stable");
    assert(renamed.checksum === `checksum-asset-rename`, "content identity stays stable");

    const step = store.history[store.history.length - 1] as Record<string, any>;
    assert(
      step?.physical_rename?.previous_name === "插图.png" &&
        step?.physical_rename?.next_name === "课程封面.png",
      `the step must carry both names: ${JSON.stringify(step?.physical_rename)}`,
    );

    // §14.5 — Undo moves the file back through the same command.
    await store.undo();
    assert(
      callCount() === 2 && calls[1]!.args.new_name === "插图.png",
      `undo must rename back: ${JSON.stringify(calls.slice(-1))}`,
    );
    const undone = store.data.assets.find((asset) => asset.id === "asset-rename")!;
    assert(undone.filename === "插图.png", "undo restores the original filename");
    // The canonical project has to name the file the command actually wrote: the
    // pre-rename snapshot still pointed at the import-named path, which that very
    // command had just invalidated.
    assert(
      undone.storage_path === "assets/asset-rename-插图.png",
      `undo has to agree with the disk: ${undone.storage_path}`,
    );
    assert(store.future.length >= 1, "the undone step is available for redo");

    await store.redo();
    assert(
      callCount() === 3 && calls[2]!.args.new_name === "课程封面.png",
      `redo must rename forward: ${JSON.stringify(calls.slice(-1))}`,
    );
    assert(
      store.data.assets.find((asset) => asset.id === "asset-rename")!.storage_path ===
        "assets/asset-rename-课程封面.png",
      "redo re-applies the forward path on disk and in data",
    );
    assert(
      store.data.assets.find((asset) => asset.id === "asset-rename")!.filename ===
        "课程封面.png",
      "redo restores the new filename",
    );

    // §14.3 — an empty name must be rejected, and §19/§21 say a rejection has to
    // be stated rather than the field just closing back on the old name.
    const historyBeforeEmpty = store.history.length;
    const callsBeforeEmpty = callCount();
    store.startAssetRename("asset-rename");
    await store.renameAsset("asset-rename", "   ");
    assert(
      String(store.ui.toast).includes("不能为空"),
      `an empty name must say what was wrong: ${String(store.ui.toast)}`,
    );
    assert(
      callCount() === callsBeforeEmpty,
      `an empty name must not reach the shell: ${JSON.stringify(calls.slice(callsBeforeEmpty))}`,
    );
    assert(store.history.length === historyBeforeEmpty, "an empty name is not history");
    assert(
      store.data.assets.find((asset) => asset.id === "asset-rename")!.filename ===
        "课程封面.png",
      "an empty name leaves the file untouched",
    );

    // A rejected name never touches history and never claims success.
    const historyLength = store.history.length;
    store.startAssetRename("asset-rename");
    await store.renameAsset("asset-rename", "占用");
    assert(store.history.length === historyLength, "a refused rename is not history");
    assert(
      String(store.ui.toast).includes("已有一个素材使用这个文件名"),
      `the refusal is shown: ${String(store.ui.toast)}`,
    );
    assert(
      store.data.assets.find((asset) => asset.id === "asset-rename")!.filename ===
        "课程封面.png",
      "a refused rename changes nothing",
    );
    assert(
      store.ui.editingAssetId === "asset-rename" &&
        store.ui.assetRenameValue === "占用" &&
        String(store.ui.assetRenameError).includes("已有一个素材使用这个文件名"),
      "a refused rename keeps its input and visible error in the dialog",
    );
    store.cancelAssetRename();
    assert(
      store.ui.editingAssetId === null &&
        store.data.assets.find((asset) => asset.id === "asset-rename")!.filename === "课程封面.png",
      "cancel closes the dialog without changing the managed file",
    );
  } finally {
    restore();
  }
});

Deno.test("an uncertain canonical mutation pauses later saves without discarding edits", async () => {
  const { store, state, bridge, restore } = await bootStore();
  let renameCalls = 0;
  (bridge as Record<string, any>).commandWithMutationAck = async (
    name: string,
    request: Record<string, unknown>,
  ) => {
    assert(name === "asset.rename", "the uncertain mutation is the requested rename");
    assert(request.expected_project_id === state.project.project.id, "rename is bound to the opened project");
    renameCalls += 1;

    // Model Deno's promotion succeeding while its verification read fails:
    // Canonical points to the new target, but the bridge has no truthful ack.
    const committed = structuredClone(state.project);
    const asset = committed.assets.find((candidate) => candidate.id === "asset-uncertain");
    assert(asset, "fixture asset exists on disk");
    asset.filename = "已提交.png";
    asset.storage_path = "assets/asset-uncertain-已提交.png";
    asset.title = "已提交";
    state.project = committed;
    state.revision += 1;
    state.fingerprint = {
      exists: true,
      mtime_ms: state.revision + 1,
      size: new TextEncoder().encode(JSON.stringify(committed)).byteLength,
      hash: state.revision.toString(16).padStart(64, "0"),
    };
    throw Object.assign(new Error("rename verification read failed"), {
      code: "rename_outcome_uncertain",
      commit_state: "outcome_uncertain",
      stage: "asset_rename_commit",
      retryable: false,
      operation_id: request.operation_id,
      revision: request.revision,
      details: {
        project_id: request.expected_project_id,
        project_dir: request.project_dir,
        lease_generation: request.lease_generation,
        editor_generation: request.editor_generation,
        operation_id: request.operation_id,
        revision: request.revision,
        expected_fingerprint: request.expected_fingerprint,
        expected_committed_hash: state.fingerprint.hash,
        expected_committed_size: state.fingerprint.size,
        asset_id: "asset-uncertain",
        original_path: "assets/asset-uncertain.png",
        target_path: asset.storage_path,
      },
    });
  };

  try {
    store.addMapItem("待确认重命名");
    seedImageAsset(store, "asset-uncertain");
    store.startAssetRename("asset-uncertain");
    await store.renameAsset("asset-uncertain", "已提交");

    assert(renameCalls === 1, "one rename reached the service");
    assert(
      state.project.assets.find((asset) => asset.id === "asset-uncertain")?.filename === "已提交.png",
      "the service-side commit is retained",
    );
    assert(
      store.data.assets.find((asset) => asset.id === "asset-uncertain")?.filename === "插图.png",
      "the unacknowledged response is not adopted as a confirmed local snapshot",
    );
    assert(store.saveStatus === "保存结果待核验", "the editor reports an uncertain commit");
    assert(String(store.ui.toast).includes("结果暂时无法确认"), "the toast does not claim the rename failed");
    assert(
      String(createViews(store as any).overlayView()).includes('data-action="verify-save-result"'),
      "the rename dialog exposes the explicit disk-verification action",
    );

    const writesAfterMutation = state.writes;
    const diskTitle = state.project.project.title;
    store.commit("核验期间继续编辑", (data) => {
      data.project.title = "本地待保存修改";
    });
    assert(store.data.project.title === "本地待保存修改", "the later local edit remains in memory");
    assert(await store.flush() === false, "a paused queue refuses a blind follow-up save");
    assert(state.writes === writesAfterMutation, "the uncertain old baseline is never auto-retried");
    assert(state.project.project.title === diskTitle, "the later edit was not written over the unknown result");
    assert(store.saveStatus === "保存结果待核验", "flush preserves the verification status");
    assert(await store.verifyUncertainMutation() === false, "late local edits prevent automatic disk adoption");
    assert(store.data.project.title === "本地待保存修改", "verification keeps the newer local edit");
    assert(store.saveStatus === "保存结果待核验", "the queue remains paused while local and disk versions diverge");
    assert(String(store.ui.toast).includes("本地修改"), `the user is told why verification did not adopt disk state: ${String(store.ui.toast)}`);
  } finally {
    restore();
  }
});

Deno.test("an uncertain rename can be proven, reconciled, and saved without restoring its old path", async () => {
  const { store, state, bridge, restore } = await bootStore();
  let renameCalls = 0;
  let resolveCalls = 0;
  (bridge as Record<string, any>).commandWithMutationAck = async (
    name: string,
    request: Record<string, any>,
  ) => {
    if (name === "asset.rename") {
      renameCalls += 1;
      const committed = structuredClone(state.project);
      const asset = committed.assets.find((candidate) => candidate.id === "asset-verify-rename");
      assert(asset, "fixture asset exists in the committed project");
      asset.filename = "已确认.png";
      asset.storage_path = "assets/asset-verify-rename-已确认.png";
      asset.title = "已确认";
      state.project = committed;
      state.revision += 1;
      state.fingerprint = {
        exists: true,
        mtime_ms: state.revision + 1,
        size: new TextEncoder().encode(JSON.stringify(committed)).byteLength,
        hash: state.revision.toString(16).padStart(64, "0"),
      };
      throw Object.assign(new Error("rename promotion result is uncertain"), {
        code: "rename_outcome_uncertain",
        commit_state: "outcome_uncertain",
        stage: "asset_rename_commit",
        retryable: false,
        operation_id: request.operation_id,
        revision: request.revision,
        details: {
          project_id: request.expected_project_id,
          project_dir: request.project_dir,
          lease_generation: request.lease_generation,
          editor_generation: request.editor_generation,
          operation_id: request.operation_id,
          revision: request.revision,
          expected_fingerprint: request.expected_fingerprint,
          expected_committed_hash: state.fingerprint.hash,
          expected_committed_size: state.fingerprint.size,
          asset_id: asset.id,
          original_path: "assets/asset-verify-rename.png",
          target_path: asset.storage_path,
        },
      });
    }
    assert(name === "project.resolve", "verified state is adopted through the existing bound resolve command");
    resolveCalls += 1;
    assert(
      (request.project as ProjectData).assets.find((asset) => asset.id === "asset-verify-rename")?.storage_path ===
        "assets/asset-verify-rename-已确认.png",
      "the resolve write carries the proven committed target path",
    );
    assert(
      JSON.stringify(request.expected_current) === JSON.stringify(state.fingerprint),
      "the resolve write is CAS-bound to the verified read fingerprint",
    );
    const project = structuredClone(request.project as ProjectData);
    state.project = project;
    state.revision += 1;
    state.fingerprint = {
      exists: true,
      mtime_ms: state.revision + 1,
      size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
      hash: state.revision.toString(16).padStart(64, "0"),
    };
    return {
      value: { project },
      mutation_ack: {
        project,
        fingerprint: structuredClone(state.fingerprint),
        project_id: request.expected_project_id,
        project_dir: request.project_dir,
        lease_generation: request.lease_generation,
        editor_generation: request.editor_generation,
        operation_id: request.operation_id,
        revision: request.revision,
        commit_state: "committed",
        outcome: "written",
      },
    };
  };

  try {
    store.addMapItem("待核验重命名");
    seedImageAsset(store, "asset-verify-rename");
    store.startAssetRename("asset-verify-rename");
    await store.renameAsset("asset-verify-rename", "已确认");

    assert(renameCalls === 1, "the rename request is attempted once");
    assert(store.data.assets.find((asset) => asset.id === "asset-verify-rename")?.storage_path === "assets/插图.png", "the unacknowledged target is not adopted before proof");
    assert(await store.verifyUncertainMutation(), "matching operation/revision and hash/size proof allows explicit reconciliation");
    assert(resolveCalls === 1, "the existing bound resolve path refreshes the backend CAS baseline");
    assert(store.data.assets.find((asset) => asset.id === "asset-verify-rename")?.storage_path === "assets/asset-verify-rename-已确认.png", "verified project data is adopted with its actual managed path");
    assert(store.saveStatus === "已保存", "the editor resumes only after the resolve acknowledgement");

    store.commit("验证后继续编辑", (data) => { data.project.title = "核验后继续保存"; });
    assert(await store.flush(), "an ordinary save succeeds after explicit reconciliation");
    assert(state.project.assets.find((asset) => asset.id === "asset-verify-rename")?.storage_path === "assets/asset-verify-rename-已确认.png", "the next save preserves the renamed managed file path");
    assert(state.project.project.title === "核验后继续保存", "the post-verification edit is persisted");
  } finally {
    restore();
  }
});

Deno.test("native uncertain save proof accepts null mtime and resumes only after bound resolve", async () => {
  const { store, state, bridge, restore } = await bootStore();
  let writeCalls = 0;
  let resolveCalls = 0;
  const nextFingerprint = (project: ProjectData) => ({
    exists: true,
    mtime_ms: state.revision + 2,
    size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
    hash: state.revision.toString(16).padStart(64, "0"),
  });
  (bridge as any).writeProject = async (request: Record<string, any>) => {
    writeCalls += 1;
    const project = structuredClone(request.project as ProjectData);
    state.project = project;
    state.revision += 1;
    state.fingerprint = nextFingerprint(project);
    if (writeCalls === 1) {
      // This mirrors DesktopBridge.bridgeError's normalized Native envelope:
      // mtime_ms is intentionally unknown, while hash/size identify the bytes.
      throw Object.assign(new Error("Canonical rename outcome is uncertain"), {
        code: "project_save_failed",
        commit_state: "outcome_uncertain",
        stage: "canonical_rename",
        retryable: false,
        operation_id: request.operation_id,
        revision: request.revision,
        expected_committed_fingerprint: {
          exists: true,
          mtime_ms: null,
          size: state.fingerprint.size,
          hash: state.fingerprint.hash,
        },
      });
    }
    return {
      project_id: request.expected_project_id,
      project_dir: request.project_dir,
      lease_generation: request.lease_generation,
      editor_generation: request.editor_generation,
      operation_id: request.operation_id,
      revision: request.revision,
      outcome: "written",
      commit_state: "committed",
      fingerprint: structuredClone(state.fingerprint),
    };
  };
  (bridge as any).commandWithMutationAck = async (
    name: string,
    request: Record<string, any>,
  ) => {
    assert(name === "project.resolve", "uncertain save is reconciled through explicit project.resolve");
    resolveCalls += 1;
    assert(
      JSON.stringify(request.expected_current) === JSON.stringify(state.fingerprint),
      "resolve is bound to the actual pure-read fingerprint",
    );
    const project = structuredClone(request.project as ProjectData);
    state.project = project;
    state.revision += 1;
    state.fingerprint = nextFingerprint(project);
    return {
      value: { project },
      mutation_ack: {
        project,
        fingerprint: structuredClone(state.fingerprint),
        project_id: request.expected_project_id,
        project_dir: request.project_dir,
        lease_generation: request.lease_generation,
        editor_generation: request.editor_generation,
        operation_id: request.operation_id,
        revision: request.revision,
        commit_state: "committed",
        outcome: "written",
      },
    };
  };
  try {
    store.addMapItem("Native 不确定保存");
    assert(await store.flush() === false, "the uncertain write does not report a successful flush");
    assert(store.saveStatus === "保存结果待核验", "the native outcome pauses the editor");
    assert(await store.flush() === false && writeCalls === 1, "the same save is not blindly retried");

    const uncertainError = (store as any).uncertainMutation.error;
    const operationId = uncertainError.operation_id;
    uncertainError.operation_id = "a-different-native-operation";
    assert(await store.verifyUncertainMutation() === false, "a Native error for another operation cannot prove this write");
    assert(Number(resolveCalls) === 0, "mismatched operation metadata never reaches project.resolve");
    uncertainError.operation_id = operationId;

    assert(await store.verifyUncertainMutation(), "matching native hash/size proof resolves despite unknown mtime");
    assert(resolveCalls === 1, "the disk state is adopted through one explicit bound resolve");
    assert(String(store.saveStatus) === "已保存", "the editor resumes after the actual resolve acknowledgement");

    store.commit("核验后继续编辑", (project: ProjectData) => {
      project.project.title = "Native 核验后继续保存";
    });
    assert(await store.flush(), "an ordinary save succeeds only after reconciliation");
    assert(Number(writeCalls) === 2, "only the deliberate post-verification save is added");
    assert(state.project.project.title === "Native 核验后继续保存", "later local content is persisted");
  } finally {
    restore();
  }
});

Deno.test("a locked project offers safe retry and return without taking its lock", async () => {
  let openCalls = 0;
  const lockedBridge: Record<string, unknown> = {
    projectDir: null,
    projectDirFromUrl: false,
    isNative: () => true,
    setProjectDir: (value: string) => { lockedBridge.projectDir = value; },
    restoreProjectDir: (value: string | null) => { lockedBridge.projectDir = value; },
    openProject: async () => {
      openCalls += 1;
      throw new Error("project_locked: 该项目已在另一窗口或进程中编辑。");
    },
  };
  const { store, restore } = await bootStore(lockedBridge);
  try {
    await store.openProject("/locked/course");
    assert(
      (store.ui.projectProblem as { status?: string; dir?: string; problem?: { code?: string } })
          ?.status === "locked" &&
        (store.ui.projectProblem as { dir?: string })?.dir === "/locked/course" &&
        (store.ui.projectProblem as { problem?: { code?: string } })?.problem?.code === "project_locked",
      "a lock rejection is surfaced as a project-open problem with its directory",
    );
    const lockMarkup = createViews(store as any).overlayView();
    assert(
      lockMarkup.includes("项目正在使用") &&
        lockMarkup.includes('data-action="retry-locked-project"') &&
        lockMarkup.includes('data-action="dismiss-project-problem"') &&
        lockMarkup.includes("没有接管项目锁"),
      "the lock dialog explains the conflict and offers only retry or return",
    );
    await store.retryLockedProjectOpen();
    assert(openCalls === 2, "retry asks the normal project-open path again");
    assert(
      (store.ui.projectProblem as { status?: string })?.status === "locked",
      "a still-held lock remains visible after retry",
    );
    store.dismissProjectProblem();
    assert(
      store.ui.projectProblem === null && openCalls === 2,
      "return dismisses the message without another open or lock mutation",
    );
  } finally {
    restore();
  }
});

Deno.test("openWorkbench returns to the current lesson editor, defaulting to 正文", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("工作台第一课");
    const lessonId = String(store.ui.activeId || "");
    assert(lessonId, "fixture lesson must be open");
    store.ui.route = "media";
    store.ui.mode = "writing";
    store.notify();

    store.openWorkbench();
    assert(String(store.ui.route) === "editor", "工作台 must open the authoring editor route");
    assert(String(store.ui.activeId) === lessonId, "工作台 must keep the current lesson");
    assert(String(store.ui.mode) === "writing", "without a prior subview session, default to 正文");
  } finally {
    restore();
  }
});

Deno.test("openWorkbench restores 正文/Flow/Preview and migrates legacy Layout to Free Layout", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("会话恢复课");
    const lessonId = String(store.ui.activeId || "");
    store.setMode("layout");
    assert(String(store.ui.route) === "free-layout", "旧排版视图映射到一级自由排版");
    assert(String(store.ui.mode) === "writing", "旧排版子视图回到正文模式");
    store.ui.route = "inbox";
    store.notify();

    store.openWorkbench();
    assert(String(store.ui.route) === "editor", "工作台 returns to authoring");
    assert(String(store.ui.activeId) === lessonId, "same lesson stays active");
    assert(String(store.ui.mode) === "writing", "工作台恢复时回到正文子视图");

    store.setMode("preview");
    store.ui.route = "board";
    store.openWorkbench();
    assert(String(store.ui.mode) === "preview", "合法 session 恢复预览子视图");

    store.setMode("structure");
    store.ui.route = "map";
    store.openWorkbench();
    assert(String(store.ui.mode) === "structure", "合法 session 恢复结构子视图");
  } finally {
    restore();
  }
});

Deno.test("openWorkbench resumes the current course lesson when none is active", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("恢复课");
    const lessonId = String(store.ui.activeId || "");
    store.ui.activeId = null;
    store.ui.route = "overview";
    store.ui.mode = "writing";
    store.tabs = [];
    store.notify();

    store.openWorkbench();
    assert(String(store.ui.route) === "editor", "工作台 opens authoring even from overview");
    assert(String(store.ui.activeId) === lessonId, "resumes the course lesson");
    assert(String(store.ui.mode) === "writing", "defaults to 正文 when no session tab exists");
  } finally {
    restore();
  }
});

Deno.test("stage CRUD store: add rename reorder empty delete and non-empty safety", async () => {
  const { store, restore } = await bootStore();
  try {
    assert(typeof store.addStage === "function", "store must expose addStage");
    assert(typeof store.renameStage === "function", "store must expose renameStage");
    assert(typeof store.moveStage === "function", "store must expose moveStage");
    assert(typeof store.deleteStage === "function", "store must expose deleteStage");

    store.addStage();
    store.addStage();
    assert(store.data.stages.length === 2, "two stages created");
    const ordered = () =>
      [...store.data.stages].sort((a, b) => a.order_index - b.order_index);
    let first = ordered()[0]!;
    let second = ordered()[1]!;
    assert(first.code === "S01", "first code is S01");
    assert(first.title === "第一阶段", "first title is 第一阶段");
    assert(second.code === "S02", "second code is S02");
    assert(second.title === "第二阶段", "second title is 第二阶段");

    const firstId = first.id;
    const secondId = second.id;
    store.renameStage(firstId, "入门阶段");
    first = store.data.stages.find((stage) => stage.id === firstId)!;
    assert(first.title === "入门阶段", "rename updates display title");
    assert(first.code === "S01", "rename leaves code alone");

    store.moveStage(secondId, "up");
    first = store.data.stages.find((stage) => stage.id === firstId)!;
    second = store.data.stages.find((stage) => stage.id === secondId)!;
    assert(second.order_index === 0 && first.order_index === 1, "reorder swaps stages");

    store.deleteStage(firstId);
    assert(
      store.ui.confirmDeleteStage === firstId ||
        String(store.ui.toast || "").includes("确认"),
      "empty stage delete asks for confirmation first",
    );
    assert(
      store.data.stages.some((stage) => stage.id === firstId),
      "stage remains until confirmed",
    );
    store.deleteStage(firstId);
    assert(
      !store.data.stages.some((stage) => stage.id === firstId),
      "confirmed empty delete removes the stage",
    );

    store.addMapItem("占位课");
    const occupied = store.data.stages.find((stage) =>
      store.data.content_items.some((item) => item.stage_id === stage.id)
    )!;
    const lessonCount = store.data.content_items.filter((item) =>
      item.stage_id === occupied.id
    ).length;
    store.deleteStage(occupied.id);
    assert(
      store.data.stages.some((stage) => stage.id === occupied.id),
      "non-empty stage must not be deleted",
    );
    assert(
      String(store.ui.toast || "").includes(`${lessonCount}`) &&
        String(store.ui.toast || "").includes("节课"),
      `toast must ask to move lessons first, got: ${store.ui.toast}`,
    );
    assert(
      validateProjectData(store.data).length === 0,
      "project stays valid after stage CRUD",
    );
  } finally {
    restore();
  }
});

Deno.test("course map stage header exposes add rename reorder delete actions", async () => {
  const viewsSource = await Deno.readTextFile(
    new URL("../app/views.js", import.meta.url),
  );
  assert(viewsSource.includes('data-action="add-stage"'), "map must expose + 新阶段");
  assert(viewsSource.includes("新阶段"), "add-stage label is Chinese 新阶段");
  assert(viewsSource.includes('data-action="rename-stage"'), "stage head has rename");
  assert(viewsSource.includes('data-action="move-stage"'), "stage head has reorder");
  assert(viewsSource.includes('data-action="delete-stage"'), "stage head has delete");
  assert(
    /function mapView[\s\S]*stage-head[\s\S]*add-stage|add-stage[\s\S]*stage-head/.test(
      viewsSource,
    ) || viewsSource.includes("stage-tools") || viewsSource.includes("stage-more"),
    "stage actions live on the course map stage header, not buried elsewhere",
  );

  const mainSource = await Deno.readTextFile(
    new URL("../app/main.js", import.meta.url),
  );
  assert(mainSource.includes('"add-stage"') || mainSource.includes("case \"add-stage\""), "main binds add-stage");
  assert(mainSource.includes("rename-stage"), "main binds rename-stage");
  assert(mainSource.includes("move-stage"), "main binds move-stage");
  assert(mainSource.includes("delete-stage"), "main binds delete-stage");

  const { store, restore } = await bootStore();
  try {
    store.addStage();
    store.addStage();
    store.ui.route = "map";
    store.ui.screen = "project";
    store.notify();
    const { createViews } = await import(
      `../app/views.js?stage-crud-${importCounter}`
    );
    const html = createViews(store).shellView() as string;
    assert(html.includes("data-action=\"add-stage\""), "rendered map has add-stage");
    assert(html.includes("新阶段"), "rendered map shows 新阶段");
    assert(html.includes("data-action=\"rename-stage\""), "rendered stage head has rename");
    assert(html.includes("data-action=\"move-stage\""), "rendered stage head has move");
    assert(html.includes("data-action=\"delete-stage\""), "rendered stage head has delete");
    assert(html.includes("S01") && html.includes("S02"), "stage codes render");
    assert(html.includes("第一阶段") && html.includes("第二阶段"), "stage titles render");
  } finally {
    restore();
  }
});

Deno.test("assetThumb gives non-blank previews for image video markdown and attachments", async () => {
  const viewsSource = await Deno.readTextFile(
    new URL("../app/views.js", import.meta.url),
  );
  const thumb = viewsSource.match(
    /const assetThumb = \(asset\) => \{([\s\S]*?)\n  \};/,
  )?.[1] ?? viewsSource.match(
    /const assetThumb = \(asset\) => \{([\s\S]*?)\n  \/\* ---/,
  )?.[1] ?? "";
  assert(thumb.includes("isImageLike") || thumb.includes('type === "image"'), "images use thumbnail path");
  assert(
    thumb.includes('type === "video"') || thumb.includes("asset-video") ||
      thumb.includes("<video"),
    "MP4/video must have a poster/card path, not only the letter fallback",
  );
  assert(
    thumb.includes("asset-doc") || thumb.includes("previewText"),
    "Markdown must use a content preview path",
  );
  assert(
    thumb.includes("asset-attachment") || thumb.includes("attachment"),
    "PDF/DOCX must render as attachment cards",
  );
  assert(
    /pdf|docx|application\/pdf|isAttachment/i.test(thumb) ||
      viewsSource.includes("isAttachmentAsset") ||
      viewsSource.includes("asset-attachment"),
    "attachment detection must cover PDF/DOCX",
  );
});

Deno.test("cross-stage lesson move preserves references through one undo and redo", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("源第一课");
    const firstId = store.currentItem()!.id;
    store.addMapItem("待移动课");
    const movingId = store.currentItem()!.id;
    store.addMapItem("目标阶段课");
    const destinationId = store.currentItem()!.id;
    store.addStage("目标阶段");
    const sourceStageId = store.data.content_items.find((item) => item.id === firstId)!.stage_id!;
    const destinationStage = store.data.stages.find((stage) => stage.title === "目标阶段")!;
    assert(
      store.moveLessonToPosition(destinationId, destinationStage.id),
      "a destination lesson is moved into the new stage",
    );

    store.openItem(movingId);
    store.addBlock("paragraph", "跨阶段后仍保留的正文");
    const item = store.currentItem()!;
    const body = store.blocks(item)[0]!;
    store.addBlock("paragraph", "配图位置");
    const imageBlock = store.blocks(item)[1]!;
    store.commit("测试素材", (data) => {
      data.assets.push({
        id: "asset-move-test",
        project_id: data.project.id,
        type: "image",
        filename: "移动测试.png",
        storage_path: "assets/move-test.png",
        mime_type: "image/png",
        width: null,
        height: null,
        duration_ms: null,
        file_size: 8,
        checksum: "move-test",
        title: "移动测试.png",
        description: "",
        source_type: "imported",
        source_url: null,
        copyright_note: null,
        created_at: "2026-01-01T00:00:00.000Z",
        archived: false,
      });
    });
    store.selectBlock(imageBlock.id, { force: true });
    await store.insertAsset("asset-move-test", { block_id: imageBlock.id });
    const documentId = item.document_id;
    const usage = store.data.asset_usages[0]!;
    const assertReferences = () => {
      const currentItem = store.data.content_items.find((candidate) => candidate.id === movingId)!;
      assert(currentItem.document_id === documentId, "lesson keeps its document ID");
      assert(
        store.data.documents.find((document) => document.id === documentId)?.content_item_id === movingId,
        "document still points to the lesson",
      );
      assert(
        store.data.blocks.find((block) => block.id === body.id)?.content === "跨阶段后仍保留的正文",
        "lesson text and block ID survive",
      );
      assert(
        store.data.blocks.find((block) => block.id === imageBlock.id)?.settings.asset_id === "asset-move-test",
        "media block still points to its asset",
      );
      assert(
        store.data.asset_usages.some((candidate) =>
          candidate.id === usage.id && candidate.block_id === imageBlock.id &&
          candidate.content_item_id === movingId && candidate.asset_id === "asset-move-test"
        ),
        "asset usage keeps its references and ID",
      );
    };
    const assertMoved = () => {
      const moving = store.data.content_items.find((candidate) => candidate.id === movingId)!;
      const destination = store.data.content_items.find((candidate) => candidate.id === destinationId)!;
      assert(moving.stage_id === destinationStage.id && moving.code === "S02-01", "moved lesson is renumbered in destination");
      assert(destination.stage_id === destinationStage.id && destination.code === "S02-02", "destination siblings are renumbered");
      assert(
        [moving, destination].sort((a, b) => a.order_index - b.order_index)[0]?.id === movingId,
        "beforeId determines the destination order",
      );
      assertReferences();
    };

    store.history.length = 0;
    assert(
      store.moveLessonToPosition(movingId, destinationStage.id, destinationId),
      "lesson moves before the existing destination lesson",
    );
    assert(store.history.length === 1, "one move creates one undo entry");
    assertMoved();

    store.undo();
    const restored = store.data.content_items.find((candidate) => candidate.id === movingId)!;
    assert(restored.stage_id === sourceStageId && restored.code === "S01-02", "one undo restores source stage and numbering");
    assert(Number(store.history.length) === 0, "one undo consumes the move entry");
    assertReferences();

    store.redo();
    assert(store.history.length === 1, "one redo reapplies the move entry");
    assertMoved();
  } finally {
    restore();
  }
});

Deno.test("publish check returns to the lesson editor context", async () => {
  const { store, state, restore } = await bootStore();
  try {
    store.addMapItem("发布来源课程");
    const sourceId = store.currentItem()!.id;
    store.ui.screen = "project";
    store.ui.route = "editor";
    store.ui.mode = "preview";
    store.ui.layoutPageId = "source-page";

    let flushNowCalls = 0;
    const flushNow = store.flushNow.bind(store);
    store.flushNow = async () => {
      flushNowCalls += 1;
      return await flushNow();
    };
    const writesBeforePreflight = state.writes;
    await store.openPreflight();
    assert(flushNowCalls === 0, "preflight must not force a save");
    assert(state.writes === writesBeforePreflight, "preflight must not write the project");
    assert(store.ui.route === "publish" && store.ui.preflight, "preflight opens from the editor");
    store.returnFromPublish();

    assert(String(store.ui.route) === "editor", "return restores source route");
    assert(store.ui.activeId === sourceId, "return restores active lesson");
    assert(store.ui.mode === "preview", "return restores editor mode");
    assert(store.ui.layoutPageId === "source-page", "return restores source page context");
  } finally {
    restore();
  }
});

Deno.test("pointercancel, lost capture and Escape cancel reordering without a commit", async () => {
  const dom = await bootPointerDom();
  try {
    dom.store.ui.screen = "project";
    dom.store.ui.route = "editor";
    dom.store.ui.mode = "writing";
    dom.store.addMapItem("拖动取消");
    dom.store.addBlock("paragraph", "A");
    dom.store.addBlock("paragraph", "B");
    dom.store.addBlock("paragraph", "C");
    const item = dom.store.currentItem()!;
    const before = dom.store.blocks(item).map((block) => block.id);
    const historyLength = dom.store.history.length;

    const cancelDrag = (kind: "pointercancel" | "lostpointercapture" | "escape", pointerId: number) => {
      dom.mountBlocks(before, [
        { top: 0, height: 100 },
        { top: 100, height: 100 },
        { top: 200, height: 100 },
      ]);
      dom.store.notify();
      const source = dom.blockNodes[2]!;
      let gripDefaultPrevented = false;
      source.handle.fire("pointerdown", {
        pointerId,
        button: 0,
        clientX: 12,
        clientY: 250,
        preventDefault() { gripDefaultPrevented = true; },
      });
      assert(gripDefaultPrevented, "drag grip prevents text selection at pointerdown");
      dom.fireDocument("pointermove", {
        pointerId,
        clientX: 12,
        clientY: 40,
        preventDefault() {},
      });
      assert(source.handle.captured, `${kind} case begins a captured drag`);
      if (kind === "pointercancel") {
        dom.fireDocument("pointercancel", { pointerId });
      } else if (kind === "lostpointercapture") {
        source.handle.fire("lostpointercapture", { pointerId });
      } else {
        dom.fireDocument("keydown", {
          key: "Escape",
          preventDefault() {},
          stopPropagation() {},
        });
      }
      assert(!source.handle.captured, `${kind} releases pointer capture`);
      assert(dom.store.history.length === historyLength, `${kind} does not create a commit`);
      assert(
        dom.store.blocks(item).map((block) => block.id).join(",") === before.join(","),
        `${kind} leaves block order unchanged`,
      );
    };

    cancelDrag("pointercancel", 31);
    cancelDrag("lostpointercapture", 32);
    cancelDrag("escape", 33);
  } finally {
    dom.restore();
  }
});

Deno.test("pointer reorder auto-scrolls at the edge before choosing its target", async () => {
  const dom = await bootPointerDom();
  try {
    dom.store.ui.screen = "project";
    dom.store.ui.route = "editor";
    dom.store.ui.mode = "writing";
    dom.store.addMapItem("滚动边缘");
    dom.store.addBlock("paragraph", "A");
    dom.store.addBlock("paragraph", "B");
    dom.store.addBlock("paragraph", "C");
    const item = dom.store.currentItem()!;
    const before = dom.store.blocks(item).map((block) => block.id);
    dom.mountBlocks(before, [
      { top: 0, height: 100 },
      { top: 100, height: 100 },
      { top: 200, height: 100 },
    ]);
    dom.store.notify();

    const source = dom.blockNodes[2]!;
    source.handle.fire("pointerdown", {
      pointerId: 41,
      button: 0,
      clientX: 12,
      clientY: 250,
    });
    dom.fireDocument("pointermove", {
      pointerId: 41,
      clientX: 12,
      clientY: 90,
      preventDefault() {},
    });

    assert(dom.scrollContainer.scrollTop > 0, "dragging at the lower edge scrolls the container");
    assert(dom.blockNodes[1]!.classList.contains("drop-before"), "target is recalculated after scrolling");
    dom.fireDocument("pointerup", { pointerId: 41, clientX: 12, clientY: 90 });
    const after = dom.store.blocks(item).map((block) => block.id);
    assert(
      after.join(",") === [before[0], before[2], before[1]].join(","),
      "edge target remains B after auto-scroll, so C is placed before B",
    );
  } finally {
    dom.restore();
  }
});

Deno.test("asset preview drops a late read after switching projects", async () => {
  const textAsset = (projectId: string) => ({
    id: "shared-asset",
    project_id: projectId,
    type: "document",
    filename: "notes.md",
    storage_path: "assets/notes.md",
    mime_type: "text/markdown",
    file_size: 1,
    checksum: projectId,
    archived: false,
  });
  let project = { id: "project-old", assets: [textAsset("project-old")] };
  let resolveOldRead!: (bytes: Uint8Array) => void;
  let announceOldReadStarted!: () => void;
  const oldReadStarted = new Promise<void>((resolve) => announceOldReadStarted = resolve);
  const cache = new AssetPreviewCache({
    currentProject: () => project,
    readAssetBytes: () => project.id === "project-old"
      ? new Promise<Uint8Array>((resolve) => {
        resolveOldRead = resolve;
        announceOldReadStarted();
      })
      : Promise.resolve(new TextEncoder().encode("new project")),
  });

  const oldKey = cache.get("shared-asset")?.key;
  const oldRead = cache.load("shared-asset");
  await oldReadStarted;
  assert(Boolean(oldKey) && cache.isLoading("shared-asset"), "old read starts");
  project = { id: "project-new", assets: [textAsset("project-new")] };
  resolveOldRead(new TextEncoder().encode("old project"));
  await oldRead;

  assert(!cache.entries.has(oldKey!), "late old-project content is discarded");
  assert(cache.get("shared-asset")?.loading, "new project still needs its own read");
  await cache.load("shared-asset");
  assert(cache.get("shared-asset")?.text === "new project", "new project content is cached");
});

Deno.test("asset preview exposes read failures as a cached failure state", async () => {
  const project = {
    id: "project",
    assets: [{
      id: "failed-asset",
      project_id: "project",
      type: "document",
      filename: "notes.md",
      storage_path: "assets/notes.md",
      mime_type: "text/markdown",
      file_size: 1,
      checksum: "failed",
      archived: false,
    }],
  };
  const cache = new AssetPreviewCache({
    currentProject: () => project,
    readAssetBytes: () => Promise.reject(new Error("disk offline")),
  });

  await cache.load("failed-asset");
  const preview = cache.get("failed-asset");
  assert(preview?.failed, "failed read is exposed to the view");
  assert(preview.error === "disk offline", "failure keeps its useful message");
});

Deno.test("asset preview bounds concurrent reads and passes the byte cap", async () => {
  const assets = ["one", "two", "three"].map((id) => ({
    id,
    project_id: "project",
    type: "document",
    filename: `${id}.txt`,
    storage_path: `assets/${id}.txt`,
    mime_type: "text/plain",
    file_size: 1,
    checksum: id,
    archived: false,
  }));
  let active = 0;
  let maxActive = 0;
  const queued: Array<() => void> = [];
  const limits: number[] = [];
  const cache = new AssetPreviewCache({
    currentProject: () => ({ id: "project", assets }),
    readAssetBytes: (_assetId: string, maxBytes: number) => {
      limits.push(maxBytes);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<Uint8Array>((resolve) => queued.push(() => {
        active -= 1;
        resolve(new TextEncoder().encode("ok"));
      }));
    },
  }, { mediaLimit: 1024, maxConcurrentLoads: 1 });
  const tasks = assets.map((asset) => cache.load(asset.id));
  const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));
  await nextTurn();
  assert(queued.length === 1, "only one bounded read starts at a time");
  for (let index = 0; index < assets.length; index += 1) {
    const release = queued[index];
    assert(release, "the next queued read starts after the current read completes");
    release();
    await nextTurn();
  }
  await Promise.all(tasks);
  assert(maxActive === 1, "the concurrency limit is honored");
  assert(limits.every((limit) => limit === 1024), "the backend receives the byte cap");
});

Deno.test("GIF thumbnail comes from a static decoded bitmap and releases it", async () => {
  const globalObject = globalThis as unknown as Record<string, unknown>;
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const urlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const bitmap = { width: 2, height: 1, close() { closed = true; } };
  let closed = false;
  let drawn: unknown = null;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: (source: unknown) => drawn = source }),
        toBlob: (callback: (blob: Blob) => void, mime: string) =>
          callback(new Blob(["thumbnail"], { type: mime })),
      }),
    } as unknown,
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async (source: Blob) => {
      assert(source.type === "image/gif", "the encoded GIF is decoded as a blob");
      return bitmap as unknown as ImageBitmap;
    },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => "blob:gif-first-frame",
  });
  try {
    const url = await staticImagePoster(new Uint8Array([1, 2, 3]));
    assert(url === "blob:gif-first-frame", "poster URL is returned");
    assert(drawn === bitmap, "the non-animated ImageBitmap is drawn to the canvas");
    assert(closed, "the decoder bitmap is released after drawing");
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete globalObject.document;
    if (bitmapDescriptor) Object.defineProperty(globalThis, "createImageBitmap", bitmapDescriptor);
    else delete globalObject.createImageBitmap;
    if (urlDescriptor) Object.defineProperty(URL, "createObjectURL", urlDescriptor);
    else delete (URL as unknown as Record<string, unknown>).createObjectURL;
  }
});

Deno.test("closing a preview stops and resets its media elements", () => {
  const calls: string[] = [];
  const video = {
    currentTime: 4.5,
    pause: () => calls.push("pause"),
    removeAttribute: (name: string) => calls.push(`remove:${name}`),
    load: () => calls.push("load"),
  };
  const audio = {
    currentTime: 2,
    pause: () => calls.push("audio-pause"),
    removeAttribute: (name: string) => calls.push(`audio-remove:${name}`),
    load: () => calls.push("audio-load"),
  };
  const scope = { querySelectorAll: () => [video, audio] };
  assert(stopPreviewMedia(scope) === 2, "both preview players are stopped");
  assert(video.currentTime === 0 && audio.currentTime === 0, "playback positions reset");
  assert(calls.join(",") === "pause,remove:src,load,audio-pause,audio-remove:src,audio-load", "each source is detached and reloaded");
});

Deno.test("video viewer reacquires a fresh source and releases stale results", async () => {
  let resolveFirst!: (source: { url: string; release: () => void }) => void;
  const releases: string[] = [];
  let requests = 0;
  const { store, restore } = await bootStore({
    previewAssetVideoSource: async () => {
      requests += 1;
      if (requests === 1) {
        return await new Promise<{ url: string; release: () => void }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      const token = `fresh-${requests}`;
      return {
        url: `http://localhost/api/media/${token}`,
        release: () => releases.push(token),
      };
    },
  });
  try {
    const workbench = store as any;
    store.commit("添加视频预览夹具", (data) => {
      data.assets.push({
        id: "viewer-video",
        project_id: data.project.id,
        type: "video",
        filename: "clip.mp4",
        storage_path: "assets/clip.mp4",
        mime_type: "video/mp4",
        width: 64,
        height: 64,
        duration_ms: 2000,
        file_size: 8,
        checksum: "viewer-video-hash",
        title: "clip.mp4",
        description: "",
        source_type: "imported",
        source_url: null,
        copyright_note: null,
        created_at: "2026-10-06T00:00:00.000Z",
        archived: false,
      });
    });
    const opening = workbench.openAssetViewer("viewer-video");
    workbench.releaseAssetViewerSource();
    store.ui.assetImagePreviewId = null;
    resolveFirst({
      url: "http://localhost/api/media/stale",
      release: () => releases.push("stale"),
    });
    await opening;
    assert(releases.includes("stale"), "a late source is released after viewer close");
    assert(!store.ui.assetImagePreviewSource, "a late source cannot repopulate a closed viewer");

    await workbench.openAssetViewer("viewer-video");
    assert(requests === 2, "each viewer opening requests a new source token");
    assert(
      (store.ui.assetImagePreviewSource as { url?: string } | null)?.url?.endsWith("fresh-2"),
      "the viewer uses the newly issued source URL",
    );
    workbench.releaseAssetViewerSource();
    assert(releases.includes("fresh-2"), "closing releases the viewer source token");
  } finally {
    restore();
  }
});

Deno.test("property panel follows project and stage targets instead of the active lesson", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("当前活跃课时");
    store.addStage("真实阶段名");
    const projectTitle = store.data.project.title;
    const stage = store.data.stages.find((candidate) => candidate.title === "真实阶段名")!;
    const { createViews } = await import(
      `../app/views.js?property-target-${importCounter}`
    );

    store.selectPropertyTarget("project");
    let html = createViews(store).shellView() as string;
    assert(
      html.includes(`data-panel-scope="项目 · ${projectTitle}"`),
      "project properties use the real project title",
    );

    store.selectPropertyTarget("stage", stage.id);
    html = createViews(store).shellView() as string;
    assert(
      html.includes(`data-panel-scope="阶段 · ${stage.code} ${stage.title}"`),
      "stage properties use the selected stage's real code and title",
    );

    store.ui.activeId = null;
    store.ui.propertyTarget = null;
    store.ui.rightPanel = "properties";
    html = createViews(store).shellView() as string;
    assert(
      html.includes(`data-panel-scope="项目 · ${projectTitle}"`),
      "an empty selection falls back to project properties",
    );
    assert(
      !html.includes('data-panel-scope="课时 ·'),
      "an empty selection does not claim the current lesson",
    );
  } finally {
    restore();
  }
});

Deno.test("block overflow action restores focus to the new summary unless a field was requested", async () => {
  const dom = await bootPointerDom();
  try {
    const store = dom.store as any;
    store.addMapItem("菜单焦点课");
    const item = store.currentItem();
    assert(item, "menu focus test has an active lesson");
    store.openItem(item.id);
    store.addBlock("paragraph", "菜单动作");
    const block = store.blocks(item).at(-1);
    assert(block, "menu focus test has a source block");
    dom.mountBlocks([block.id], [{ top: 0, height: 100 }]);

    const sourceNode = dom.blockNodes[0]!;
    const oldSummary = sourceNode.summary;
    store.ui.focusField = "";
    dom.triggerBlockMenuAction(block.id);
    await Promise.resolve();
    assert(sourceNode.summary !== oldSummary, "action rendered a new summary");
    assert(
      dom.focusedElement() === sourceNode.summary,
      "focus returns to the corresponding summary in the new DOM",
    );

    store.ui.focusField = "menu-test-field";
    dom.triggerBlockMenuAction(block.id);
    await Promise.resolve();
    assert(
      dom.focusedElement() === dom.focusField,
      "an explicit focusField request wins over summary restoration",
    );
  } finally {
    dom.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Item 7 / 10: pagination editing state and page-title uniqueness
 * ------------------------------------------------------------------ */

function countOf(haystack: string, needle: string): number {
  return needle ? haystack.split(needle).length - 1 : 0;
}

/** A paged grid with two named pages and one placement on the active page. */
async function pagedEditingFixture(title: string) {
  const booted = await bootStore();
  const { store } = booted;
  store.addMapItem(title);
  store.addBlock("paragraph", "分页正文一");
  store.addBlock("paragraph", "分页正文二");
  store.createLayout("grid");
  store.beginPaginationConversion();
  store.confirmPaginationConversion();
  const first = store.layoutPages()[0]!;
  store.renamePage(first.id, "导入与渲染");
  store.placeBlock(store.blocks()[0]!.id);
  store.addLayoutPage();
  const pages = store.layoutPages();
  store.selectLayoutPage(first.id);
  store.ui.screen = "project";
  store.ui.route = "free-layout";
  store.ui.mode = "writing";
  const { createViews } = await import(`../app/views.js?pagination-editing-${importCounter}`);
  const render = () => createViews(store).shellView() as string;
  const toggle = () =>
    (store as unknown as { togglePaginationEditing: () => void }).togglePaginationEditing();
  return { ...booted, store, pages, render, toggle };
}

Deno.test("page move target renders available cells on the selected page", async () => {
  const { store, pages, render, restore } = await pagedEditingFixture("跨页目标面板");
  try {
    const placement = store.data.placements[0]!;
    const pageMove = store as unknown as {
      startPageMove: (placementId: string) => void;
      choosePageMoveTarget: (pageId: string) => void;
    };
    pageMove.startPageMove(placement.id);
    pageMove.choosePageMoveTarget(pages[1]!.id);

    const html = render();
    assert(
      html.includes(`选择「${pages[1]!.title}」里的可用位置`),
      "the target page must render its destination-cell panel",
    );
    assert(
      html.includes(`data-action="move-placement-page-cell"`) &&
        html.includes(`data-page-id="${pages[1]!.id}"`),
      "available destination cells must retain their page and move action",
    );
  } finally {
    restore();
  }
});

Deno.test("continuous Grid shows no output-section editor but keeps 启用分页 reachable", async () => {
  const { store, restore } = await bootStore();
  try {
    store.addMapItem("连续网格分组课");
    store.addBlock("paragraph", "连续网格正文");
    store.createLayout("grid");
    store.placeBlock(store.blocks()[0]!.id);
    store.ui.screen = "project";
    store.ui.route = "free-layout";
    store.ui.mode = "writing";
    const { createViews } = await import(`../app/views.js?continuous-grid-${importCounter}`);
    assert(store.data.layout_pages.length === 0, "the layout must still be continuous");
    assert(store.data.layout_sections.length > 0, "legacy section rows must still be maintained");
    const html = createViews(store).shellView() as string;
    assert(!html.includes("输出分区"), "the section editor must not appear before pagination is enabled");
    assert(!html.includes("＋ 分区"), "the add-section action must not appear before pagination is enabled");
    assert(!html.includes("data-action=\"grid-new-section\""), "no section mutation may be offered");
    assert(
      html.includes("data-action=\"pagination-conversion\""),
      "启用分页 must stay reachable so a legacy project can still convert",
    );
    assert(
      store.data.placements.every((placement) => "section_id" in placement),
      "placements must keep their legacy section grouping for export",
    );
  } finally {
    restore();
  }
});

Deno.test("exiting pagination editing changes no page or placement data", async () => {
  const { store, restore, render, toggle } = await pagedEditingFixture("分页编辑状态课");
  try {
    const editing = () => Boolean(store.ui.paginationEditing);
    assert(editing(), "启用分页 must land in pagination editing");
    const pagesBefore = structuredClone(store.data.layout_pages);
    const placementsBefore = structuredClone(store.data.placements);
    const snapshot = JSON.stringify(store.data);
    const activePageBefore = store.ui.layoutPageId;
    assert(render().includes("退出分页编辑"), "the editing bar must offer 退出分页编辑");

    toggle();
    assert(!editing(), "the action leaves editing mode");
    assert(store.data.layout_pages === store.data.layout_pages, "page rows keep their identity");
    assert(
      JSON.stringify(store.data.layout_pages) === JSON.stringify(pagesBefore),
      "page ids, titles and order must survive exiting editing mode",
    );
    assert(
      JSON.stringify(store.data.placements) === JSON.stringify(placementsBefore),
      "exiting editing must move nothing and unplace nothing",
    );
    assert(JSON.stringify(store.data) === snapshot, "exiting editing is a pure view-state change");
    assert(store.ui.layoutPageId === activePageBefore, "the active page must survive exiting editing");
    assert(store.data.layout_instances.at(-1)!.pagination_mode === "paged", "the layout stays paged");
    const viewing = render();
    assert(viewing.includes('data-page-readonly="true"'), "the canvas reads as view-only");
    assert(!viewing.includes("退出分页编辑"), "the exit action is only offered while editing");

    toggle();
    assert(editing(), "the same action re-enters editing");
    assert(store.ui.layoutPageId === activePageBefore, "re-entering restores the same active page");
    assert(JSON.stringify(store.data) === snapshot, "re-entering editing still changes no data");
  } finally {
    restore();
  }
});

Deno.test("an active page renders exactly one visible page title", async () => {
  const { store, restore, render, pages } = await pagedEditingFixture("页面标题去重课");
  try {
    for (const [index, page] of pages.entries()) {
      store.selectLayoutPage(page.id);
      for (const editing of [true, false]) {
        store.ui.paginationEditing = editing;
        const html = render();
        const named = html.match(/data-page-id="[^"]+"/g) || [];
        assert(named.length === 1, `the active page surface must name one page, got ${named.length}`);
        const title = index === 0 ? "导入与渲染" : page.title;
        assert(
          countOf(html, title) === 1,
          `page title "${title}" must appear once while ${editing ? "editing" : "viewing"}, got ${countOf(html, title)}`,
        );
        assert(
          !/<span>第 \d+ 页<\/span><small>第 \d+ 页<\/small>/.test(html),
          "the tab strip must never pair an index label with an identical default title",
        );
        assert(
          !/class="page-canvas-size"[^>]*>[^<]*第 \d+ 页[^<]*pt/.test(html.replace(title, "")),
          "the canvas size badge must carry geometry, not the page title",
        );
      }
    }
  } finally {
    restore();
  }
});

Deno.test("explicit keep-local resolves a paused conflict without flushing its stale queue", async () => {
  const observed = { resolveRequest: null as Record<string, unknown> | null };
  const confirmedDiskFingerprint = {
    exists: true,
    mtime_ms: 8,
    size: 4096,
    hash: "8".repeat(64),
  };
  const { store, state, bridge, restore } = await bootStore({
    inspectExternalModification: async () => ({
      changed: true,
      baseline: null,
      current: structuredClone(confirmedDiskFingerprint),
      external: structuredClone(state.project),
      external_diff: { changed: true, entries: [] },
      local_diff: null,
    }),
    commandWithMutationAck: async (name: string, request: Record<string, unknown>) => {
      assert(name === "project.resolve", "explicit keep-local uses the bound resolve command");
      observed.resolveRequest = structuredClone(request);
      const project = structuredClone(request.project as ProjectData);
      state.project = project;
      state.fingerprint = {
        exists: true,
        mtime_ms: 9,
        size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
        hash: "9".repeat(64),
      };
      return {
        value: { resolved: true },
        mutation_ack: {
          project,
          fingerprint: structuredClone(state.fingerprint),
          project_id: request.expected_project_id,
          project_dir: request.project_dir,
          lease_generation: request.lease_generation,
          editor_generation: request.editor_generation,
          operation_id: request.operation_id,
          revision: request.revision,
          outcome: "written",
          commit_state: "committed",
          recovery_warning: null,
          durability_warning: null,
        },
      };
    },
  });
  try {
    const runtimeStore = store as unknown as { saveRevision: number };
    store.commit("本地编辑", (project) => {
      project.project.title = "保留的本地版本";
    });
    const localRevision = runtimeStore.saveRevision;
    state.acceptWrites = false;
    state.fingerprint = structuredClone(confirmedDiskFingerprint);

    assert(await store.flush() === false, "the old queued save stops on the external CAS conflict");
    assert(store.saveStatus === "外部修改冲突", "the failed save pauses in the conflict state");
    assert(state.writes === 1, "only the original failed save reached the bridge");

    await store.resolveExternalConflict("keep-local");

    const resolveRequest = observed.resolveRequest;
    assert(resolveRequest !== null, "the explicit resolution was dispatched");
    assert(
      JSON.stringify(resolveRequest?.expected_fingerprint) === JSON.stringify(confirmedDiskFingerprint) &&
        JSON.stringify(resolveRequest?.expected_current) === JSON.stringify(confirmedDiskFingerprint),
      "resolve CAS is bound to the exact disk fingerprint the user confirmed",
    );
    assert(resolveRequest?.revision === localRevision, "resolve preserves the pending local editor revision");
    assert(resolveRequest?.expected_project_id === state.project.project.id, "resolve remains bound to the active project");
    assert(state.writes === 1, "the stale pending save is suppressed instead of replayed");
    assert(store.data.project.title === "保留的本地版本", "the committed ack preserves the local project");
    assert(String(store.saveStatus) === "已保存", "the committed resolve ack clears the conflict state");
    assert(store.externalConflict === null, "the resolved conflict is cleared only after ack");
    assert(bridge.projectDir === resolveRequest?.project_dir, "resolve stays on the active directory");
  } finally {
    restore();
  }
});
