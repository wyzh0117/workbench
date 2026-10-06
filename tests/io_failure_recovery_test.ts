import { addAsset } from "../src/domain/assets.ts";
import { createEmptyProjectData } from "../src/domain/store.ts";
import { DesktopService } from "../src/service/desktop.ts";
import {
  fileFingerprint,
  getStorageIoMetrics,
  ProjectDirectoryStore,
  setStorageIoDiagnosticsEnabled,
  type FileFingerprint,
  type RecoveryJournal,
} from "../src/service/storage.ts";
import type { ProjectData } from "../src/domain/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function openStore() {
  const directory = await Deno.makeTempDir({ prefix: "acw-io-recovery-" });
  const store = new ProjectDirectoryStore(directory, {
    app_instance_id: `io-recovery-${crypto.randomUUID()}`,
  });
  await store.open();
  const project = createEmptyProjectData("Recovery");
  await store.writeProject(project);
  return { directory, store, project };
}

function journalFor(project: ProjectData): RecoveryJournal {
  return {
    transaction_id: crypto.randomUUID(),
    project_id: project.project.id,
    canonical_revision: project.project.updated_at,
    saved_at: new Date(Date.now() + 60_000).toISOString(),
    project: structuredClone(project),
  };
}

async function saveChangedProject(
  store: ProjectDirectoryStore,
  project: ProjectData,
  operationId: string,
) {
  const state = await store.readProjectSnapshot();
  const next = structuredClone(project);
  next.project.title = "Changed title";
  next.project.updated_at = new Date(Date.now() + 1_000).toISOString();
  return await store.saveBound(next, {
    expected_project_id: project.project.id,
    lease_generation: store.leaseGeneration ?? "",
    editor_generation: 4,
    operation_id: operationId,
    revision: 9,
    expected_fingerprint: state.fingerprint,
  });
}

async function caughtSave(
  store: ProjectDirectoryStore,
  project: ProjectData,
  operationId: string,
): Promise<{ code: string; details: Record<string, unknown> }> {
  try {
    await saveChangedProject(store, project, operationId);
  } catch (caught) {
    const value = caught as {
      error?: { code?: unknown; details?: unknown };
    };
    assert(value.error, "save failure must retain a structured ServiceError");
    return {
      code: String(value.error.code ?? ""),
      details: value.error.details && typeof value.error.details === "object"
        ? value.error.details as Record<string, unknown>
        : {},
    };
  }
  throw new Error("expected the bound save to fail");
}

Deno.test("committed recovery journals are suppressed without deleting the journal", async () => {
  const { directory, store, project } = await openStore();
  try {
    const journal = journalFor(project);
    await store.writeRecoveryJournal(journal);
    const recoveryPath = `${directory}/.workspace/recovery.json`;
    const bytesBefore = await Deno.readTextFile(recoveryPath);
    const baselineBefore = JSON.stringify(
      (store as unknown as { baseline: unknown }).baseline,
    );

    const read = await store.readRecoveryJournal();
    assert(
      read === null,
      "a journal exactly matching Canonical project id, revision, and body is already committed",
    );
    assert(
      await Deno.readTextFile(recoveryPath) === bytesBefore,
      "suppressing a committed recovery journal must not delete or rewrite it",
    );
    assert(
      JSON.stringify((store as unknown as { baseline: unknown }).baseline) === baselineBefore,
      "checking a journal must not adopt or replace the active Canonical baseline",
    );
  } finally {
    await store.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("project.open_state returns the filtered recovery journal with its canonical snapshot", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-open-recovery-" });
  const desktop = new DesktopService(directory, {
    app_instance_id: `open-recovery-${crypto.randomUUID()}`,
  });
  try {
    await desktop.open();
    const created = await desktop.commands.execute("project.create", {
      title: "Committed project",
    });
    assert(!created.error, "project.create should initialize the Canonical project");
    const project = created.value as ProjectData;
    await desktop.store.writeRecoveryJournal(journalFor(project));

    const opened = await desktop.commands.execute("project.open_state", {});
    assert(!opened.error, "project.open_state should return the leased snapshot");
    const value = opened.value as {
      project: ProjectData;
      recovery_journal: RecoveryJournal | null;
    };
    assert(
      value.project.project.id === project.project.id &&
        value.recovery_journal === null,
      "the recovery decision must be derived from the same returned Canonical project",
    );
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("canonical mutation receipt is detached while command context keeps its live project reference", async () => {
  const directory = await Deno.makeTempDir({ prefix: "io-mutation-ack-" });
  const desktop = new DesktopService(directory, {
    app_instance_id: `io-mutation-ack-${crypto.randomUUID()}`,
  });
  try {
    await desktop.open();
    const created = await desktop.commands.execute("project.create", {
      title: "Mutation acknowledgement",
    });
    assert(!created.error, "project.create should establish a writable project");
    const opened = await desktop.commands.execute("project.open_state", {});
    assert(!opened.error, "project.open_state should provide the canonical owner and fingerprint");
    const state = opened.value as {
      project: ProjectData;
      fingerprint: { exists: boolean; mtime_ms: number | null; size: number | null; hash: string | null };
    };
    const liveProject = desktop.context.project;
    assert(liveProject === state.project, "open_state should establish the live context reference");

    const operationId = `ack-${crypto.randomUUID()}`;
    const committed = await desktop.commands.execute("course.seed.create", {
      source_type: "blank",
      raw_text: "# Receipt",
      project_dir: desktop.store.directory,
      expected_project_id: state.project.project.id,
      lease_generation: desktop.store.leaseGeneration,
      editor_generation: 12,
      operation_id: operationId,
      revision: 8,
      expected_fingerprint: state.fingerprint,
    });
    assert(!committed.error, `bound canonical mutation should commit: ${committed.error?.code}`);
    const ack = committed.mutation_ack as {
      project: ProjectData;
      fingerprint: { exists: boolean; size: number | null; hash: string | null };
      project_id: string;
      project_dir: string;
      lease_generation: string;
      editor_generation: number;
      operation_id: string;
      revision: number;
      commit_state: string;
      outcome: string;
    } | undefined;
    const seed = committed.value as { id: string };
    assert(ack && seed.id, "the command should keep its old value and add a sibling acknowledgement");
    assert(
      ack.project_id === state.project.project.id &&
        ack.project_dir === desktop.store.directory &&
        ack.lease_generation === desktop.store.leaseGeneration &&
        ack.editor_generation === 12 && ack.operation_id === operationId &&
        ack.revision === 8 && ack.commit_state === "committed" && ack.outcome === "written",
      "the acknowledgement should echo the validated request and committed identity",
    );
    assert(
      desktop.context.project === liveProject &&
        liveProject?.course_seeds.some((row) => row.id === seed.id),
      "successful writes should update the original live context object",
    );
    assert(
      ack.project.course_seeds.some((row) => row.id === seed.id),
      "the detached acknowledgement should contain the exact committed project",
    );
    liveProject!.course_seeds[0]!.id = "later-handler-mutation";
    assert(
      ack.project.course_seeds.some((row) => row.id === seed.id),
      "later live-object edits must not mutate the committed acknowledgement",
    );
    const disk = await desktop.store.readProjectSnapshot();
    assert(
      disk.fingerprint.hash === ack.fingerprint.hash &&
        disk.fingerprint.size === ack.fingerprint.size,
      "the fingerprint in the acknowledgement must describe actual committed bytes",
    );
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("recovery journal with matching revision but different body stays visible", async () => {
  const { directory, store, project } = await openStore();
  try {
    const journal = journalFor(project);
    journal.project.project.title = "Different body, same revision";
    await store.writeRecoveryJournal(journal);

    const read = await store.readRecoveryJournal();
    assert(
      read?.transaction_id === journal.transaction_id,
      "same project id and revision are insufficient when the journal body differs",
    );
    assert(
      (await Deno.readTextFile(`${directory}/.workspace/recovery.json`)).includes(
        journal.transaction_id,
      ),
      "a nonmatching recovery journal must remain available for an explicit decision",
    );
  } finally {
    await store.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("backup symlink failure leaves Canonical unchanged and is not retryable", async () => {
  const { directory, store, project } = await openStore();
  try {
    const canonicalPath = `${directory}/project.json`;
    const backupPath = `${canonicalPath}.bak`;
    const sentinelPath = `${directory}/protected-output`;
    const before = await Deno.readFile(canonicalPath);
    await Deno.writeTextFile(sentinelPath, "preserve existing output");
    await Deno.symlink(sentinelPath, backupPath);

    const failure = await caughtSave(store, project, "backup-symlink-op");
    const after = await Deno.readFile(canonicalPath);
    const backup = await Deno.lstat(backupPath);
    assert(failure.code === "invalid_project_path", "symlink rejection code stays stable");
    assert(failure.details.stage === "backup", "failure should identify backup stage");
    assert(failure.details.commit_state === "not_committed", "Canonical was not promoted");
    assert(failure.details.retryable === false, "a protected symlink is not transient");
    assert(failure.details.operation_id === "backup-symlink-op", "failure keeps operation identity");
    assert(before.toString() === after.toString(), "the existing project output is unchanged");
    assert(backup.isSymlink, "cleanup must not remove the caller's backup symlink");
    assert(await Deno.readTextFile(sentinelPath) === "preserve existing output", "the symlink target is preserved");
  } finally {
    await store.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("a bound save after lease closure is not marked retryable", async () => {
  const { directory, store, project } = await openStore();
  const state = await store.readProjectSnapshot();
  const leaseGeneration = store.leaseGeneration;
  await store.close();
  const changed = structuredClone(project);
  changed.project.title = "Closed lease";
  changed.project.updated_at = new Date(Date.now() + 1_000).toISOString();
  try {
    await store.saveBound(changed, {
      expected_project_id: project.project.id,
      lease_generation: leaseGeneration ?? "",
      editor_generation: 4,
      operation_id: "closed-lease-op",
      revision: 10,
      expected_fingerprint: state.fingerprint,
    });
    throw new Error("a save without the writer lease must fail");
  } catch (caught) {
    const value = caught as {
      error?: { code?: string; details?: Record<string, unknown> };
    };
    assert(value.error?.code === "project_not_open", "the lease error code should remain stable");
    assert(value.error.details?.stage === "save_preflight", "the failure should identify preflight");
    assert(value.error.details?.commit_state === "not_committed", "no bytes were committed");
    assert(value.error.details?.retryable === false, "reopening is required; retrying this request cannot succeed");
    assert(value.error.details?.operation_id === "closed-lease-op", "failure keeps its operation binding");
    const current = await fileFingerprint(`${directory}/project.json`);
    assert(
      current.hash === state.fingerprint.hash,
      "Canonical must remain unchanged after the closed-lease rejection",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("canonical I/O counters are opt-in and show no-op versus committed writes", async () => {
  const { directory, store, project } = await openStore();
  try {
    await store.readProjectSnapshot();
    assert(
      Object.values(getStorageIoMetrics()).every((count) => count === 0),
      "normal service reads must not accumulate diagnostic counters by default",
    );
    setStorageIoDiagnosticsEnabled(true);
    const state = await store.readProjectSnapshot();
    const noOp = await store.saveBound(project, {
      expected_project_id: project.project.id,
      lease_generation: store.leaseGeneration ?? "",
      editor_generation: 5,
      operation_id: "io-noop",
      revision: 11,
      expected_fingerprint: state.fingerprint,
    });
    const afterNoOp = getStorageIoMetrics();
    assert(noOp.outcome === "unchanged", "same project bytes should use the no-op path");
    assert(
      afterNoOp.project_temp_files_created === 0 &&
        afterNoOp.project_temp_write_bytes === 0 &&
        afterNoOp.project_backup_copy_operations === 0 &&
        afterNoOp.project_file_sync_attempts === 0 &&
        afterNoOp.project_backup_renames === 0 &&
        afterNoOp.project_promotions === 0 &&
        afterNoOp.recovery_journal_temp_files_created === 0 &&
        afterNoOp.recovery_journal_promotions === 0 &&
        afterNoOp.recovery_journal_removal_successes === 0,
      "unchanged saves must perform zero Canonical data-file writes or replacements",
    );

    const changed = structuredClone(project);
    changed.project.title = "Measured commit";
    changed.project.updated_at = new Date(Date.now() + 2_000).toISOString();
    const beforeWrite = getStorageIoMetrics();
    const written = await store.saveBound(changed, {
      expected_project_id: project.project.id,
      lease_generation: store.leaseGeneration ?? "",
      editor_generation: 5,
      operation_id: "io-write",
      revision: 12,
      expected_fingerprint: state.fingerprint,
    });
    const afterWrite = getStorageIoMetrics();
    assert(written.outcome === "written", "changed project bytes should commit once");
    assert(
      afterWrite.project_full_read_operations - beforeWrite.project_full_read_operations <= 2,
      "a changed save should use at most two actual full Canonical reads",
    );
    assert(
      afterWrite.project_temp_files_created - beforeWrite.project_temp_files_created === 1 &&
        afterWrite.project_backup_copy_operations - beforeWrite.project_backup_copy_operations === 1 &&
        afterWrite.project_promotions - beforeWrite.project_promotions === 1 &&
        afterWrite.project_backup_renames - beforeWrite.project_backup_renames === 1 &&
        afterWrite.recovery_journal_temp_files_created - beforeWrite.recovery_journal_temp_files_created === 1 &&
        afterWrite.recovery_journal_promotions - beforeWrite.recovery_journal_promotions === 1 &&
        afterWrite.recovery_journal_removal_successes - beforeWrite.recovery_journal_removal_successes === 1 &&
        afterWrite.recovery_directory_sync_attempts - beforeWrite.recovery_directory_sync_attempts === 2,
      "the write receipt should match one staged commit, backup copy, and atomic promotion",
    );
    assert(
      afterWrite.project_temp_write_bytes > beforeWrite.project_temp_write_bytes &&
        afterWrite.project_backup_copy_read_bytes > beforeWrite.project_backup_copy_read_bytes &&
        afterWrite.project_backup_copy_write_bytes > beforeWrite.project_backup_copy_write_bytes &&
        afterWrite.recovery_journal_temp_write_bytes > beforeWrite.recovery_journal_temp_write_bytes &&
        afterWrite.recovery_journal_file_sync_attempts - beforeWrite.recovery_journal_file_sync_attempts === 1,
      "diagnostics should count actual bytes read and written for Canonical, backup, and recovery journal",
    );
  } finally {
    setStorageIoDiagnosticsEnabled(false);
    await store.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("DesktopService no-op project.save skips recovery, canonical, and search-index writes", async () => {
  const directory = await Deno.makeTempDir({ prefix: "desktop-noop-save-" });
  const desktop = new DesktopService(directory, {
    app_instance_id: `desktop-noop-${crypto.randomUUID()}`,
  });
  const originalWriteTextFile = Deno.writeTextFile;
  const deno = Deno as typeof Deno & { writeTextFile: typeof Deno.writeTextFile };
  let searchIndexTempWrites = 0;
  try {
    await desktop.open();
    const created = await desktop.commands.execute("project.create", {
      title: "No-op service save",
    });
    assert(!created.error, "project.create should seed the test project");
    const opened = await desktop.commands.execute("project.open_state", {});
    assert(!opened.error, "open_state should return the save identity");
    const state = opened.value as {
      project: ProjectData;
      fingerprint: FileFingerprint;
      project_id: string;
      project_dir: string;
      lease_generation: string;
    };
    setStorageIoDiagnosticsEnabled(true);
    deno.writeTextFile = async (...args) => {
      if (String(args[0]).includes("/.workspace/index.json.tmp-")) {
        searchIndexTempWrites += 1;
      }
      return await originalWriteTextFile(...args);
    };
    const saved = await desktop.commands.execute("project.save", {
      project_dir: state.project_dir,
      expected_project_id: state.project_id,
      lease_generation: state.lease_generation,
      editor_generation: 2,
      operation_id: "desktop-noop-save",
      revision: 3,
      expected_fingerprint: state.fingerprint,
      project: structuredClone(state.project),
    });
    assert(!saved.error, "a same-content service save should succeed");
    const value = saved.value as { outcome: string };
    const io = getStorageIoMetrics();
    assert(value.outcome === "unchanged", "the service should classify exact same bytes as unchanged");
    assert(
      io.project_temp_files_created === 0 &&
        io.project_backup_copy_operations === 0 &&
        io.project_backup_renames === 0 &&
        io.project_promotions === 0 &&
        io.recovery_journal_temp_files_created === 0 &&
        io.recovery_journal_promotions === 0 &&
        io.recovery_journal_removal_attempts === 0 &&
        searchIndexTempWrites === 0,
      "unchanged DesktopService saves should write neither recovery, Canonical, nor derived index files",
    );
  } finally {
    deno.writeTextFile = originalWriteTextFile;
    setStorageIoDiagnosticsEnabled(false);
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("transient pre-promotion failure is retryable only after disk proves no commit", async () => {
  const { directory, store, project } = await openStore();
  const canonicalPath = `${directory}/project.json`;
  const before = await Deno.readFile(canonicalPath);
  const deno = Deno as typeof Deno & { rename: typeof Deno.rename };
  const originalRename = Deno.rename;
  try {
    deno.rename = async (from, to) => {
      if (to === canonicalPath) {
        throw Object.assign(new Error("temporary rename contention"), {
          code: "EBUSY",
        });
      }
      await originalRename(from, to);
    };
    const failure = await caughtSave(store, project, "transient-before-op");
    assert(failure.details.stage === "promote", "the failed stage should be the atomic promote");
    assert(failure.details.commit_state === "not_committed", "pure Canonical read proves target stayed old");
    assert(failure.details.retryable === true, "only the known transient precommit failure may retry");
    assert(before.toString() === (await Deno.readFile(canonicalPath)).toString(), "failed promotion preserves Canonical bytes");
  } finally {
    deno.rename = originalRename;
    await store.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("lost rename acknowledgement is verified as committed and cleanup failure warns", async () => {
  const { directory, store, project } = await openStore();
  const canonicalPath = `${directory}/project.json`;
  const recoveryPath = `${directory}/.workspace/recovery.json`;
  const deno = Deno as typeof Deno & { rename: typeof Deno.rename };
  const originalRename = Deno.rename;
  try {
    deno.rename = async (from, to) => {
      await originalRename(from, to);
      if (to === canonicalPath) {
        await Deno.remove(recoveryPath);
        await Deno.mkdir(recoveryPath);
        await Deno.writeTextFile(`${recoveryPath}/held`, "prevent cleanup");
        throw Object.assign(new Error("rename completed but acknowledgement was lost"), {
          code: "EIO",
        });
      }
    };
    const result = await saveChangedProject(store, project, "ambiguous-promote-op");
    const actual = await fileFingerprint(canonicalPath);
    const onDisk = JSON.parse(await Deno.readTextFile(canonicalPath)) as ProjectData;
    assert(result.outcome === "written", "verified post-rename bytes must return successful outcome");
    assert(result.fingerprint.hash === actual.hash, "ack fingerprint must identify committed bytes");
    assert(result.fingerprint.size === actual.size, "ack size must identify committed bytes");
    assert(onDisk.project.title === "Changed title", "the expected revision is actually on disk");
    assert(result.durability_warning?.includes("未确认") === true, "lost rename acknowledgement is reported as a warning");
    assert(result.recovery_warning?.includes("清理失败") === true, "postcommit recovery cleanup failure is a warning");
    assert(await Deno.readTextFile(`${recoveryPath}/held`) === "prevent cleanup", "the injected nonempty cleanup target remains intact");
  } finally {
    deno.rename = originalRename;
    await store.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("asset rename preserves target bytes when canonical commit outcome is uncertain", async () => {
  const directory = await Deno.makeTempDir({ prefix: "io-rename-uncertain-" });
  const desktop = new DesktopService(directory, {
    app_instance_id: `rename-uncertain-${crypto.randomUUID()}`,
  });
  const canonicalPath = `${directory}/project.json`;
  const originalRename = Deno.rename;
  const originalReadFile = Deno.readFile;
  const deno = Deno as typeof Deno & {
    rename: typeof Deno.rename;
    readFile: typeof Deno.readFile;
  };
  let canonicalRenameCompleted = false;
  let verificationReadFailed = false;
  try {
    await desktop.open();
    const project = createEmptyProjectData("Uncertain rename");
    const { asset } = addAsset(project, project.project.id, {
      type: "image",
      filename: "before.png",
      storage_path: "assets/pending-before.png",
      mime_type: "image/png",
      checksum: "rename-source-checksum",
      file_size: 7,
    });
    asset.storage_path = `assets/${asset.id}-before.png`;
    const oldPath = `${directory}/${asset.storage_path}`;
    const newPath = `${directory}/assets/${asset.id}-after.png`;
    await Deno.mkdir(`${directory}/assets`, { recursive: true });
    await Deno.writeTextFile(oldPath, "payload");
    await desktop.store.writeProject(project);
    const opened = await desktop.commands.execute("project.open_state", {});
    assert(!opened.error, "open_state should load the seeded project and binding");
    const state = opened.value as {
      project: ProjectData;
      fingerprint: { exists: boolean; mtime_ms: number | null; size: number | null; hash: string | null };
      project_id: string;
      project_dir: string;
      lease_generation: string;
    };

    deno.rename = async (from, to) => {
      await originalRename(from, to);
      if (to === canonicalPath && !canonicalRenameCompleted) {
        canonicalRenameCompleted = true;
        throw Object.assign(new Error("canonical rename ack lost"), { code: "EIO" });
      }
    };
    deno.readFile = async (path) => {
      if (String(path) === canonicalPath && canonicalRenameCompleted && !verificationReadFailed) {
        verificationReadFailed = true;
        throw new Deno.errors.PermissionDenied("injected canonical verification read failure");
      }
      return await originalReadFile(path);
    };

    const result = await desktop.commands.execute("asset.rename", {
      asset_id: asset.id,
      new_name: "after",
      project_dir: state.project_dir,
      expected_project_id: state.project.project.id,
      lease_generation: state.lease_generation,
      editor_generation: 5,
      operation_id: "rename-uncertain-ack",
      revision: 3,
      expected_fingerprint: state.fingerprint,
    });
    deno.rename = originalRename;
    deno.readFile = originalReadFile;

    assert(result.error, "the unverifiable canonical promote must return an error envelope");
    assert(
      result.error.details.commit_state === "outcome_uncertain",
      "the command error should preserve the uncertain commit state",
    );
    assert(
      result.error.details.retryable === false,
      "an uncertain commit must never invite a blind retry",
    );
    assert(
      result.error.details.project_id === state.project_id &&
        result.error.details.project_dir === state.project_dir &&
        result.error.details.lease_generation === state.lease_generation &&
        result.error.details.editor_generation === 5 &&
        result.error.details.operation_id === "rename-uncertain-ack" &&
        result.error.details.revision === 3,
      "the uncertain error must retain the exact request binding",
    );
    assert(
      result.error.details.expected_fingerprint !== null &&
        result.error.details.asset_id === asset.id &&
        result.error.details.original_path === `assets/${asset.id}-before.png` &&
        result.error.details.target_path === `assets/${asset.id}-after.png`,
      "the uncertain error must identify the expected source and target asset paths",
    );
    assert(
      canonicalRenameCompleted && verificationReadFailed,
      "the injected post-promotion verification failure should run",
    );
    const expectedFingerprint = await fileFingerprint(canonicalPath);
    assert(
      result.error.details.expected_committed_hash === expectedFingerprint.hash &&
        result.error.details.expected_committed_size === expectedFingerprint.size,
      "the expected commit identity must match the actual Canonical bytes",
    );
    const verified = await desktop.commands.execute("project.read_state", {});
    assert(!verified.error, "pure project.read_state should remain available for outcome verification");
    const verifiedValue = verified.value as {
      project_id: string;
      project_dir: string;
      fingerprint: FileFingerprint;
    };
    assert(
      verifiedValue.project_id === result.error.details.project_id &&
        verifiedValue.project_dir === result.error.details.project_dir &&
        verifiedValue.fingerprint.hash === result.error.details.expected_committed_hash &&
        verifiedValue.fingerprint.size === result.error.details.expected_committed_size,
      "pure read_state must prove this uncertain rename committed before the UI resumes",
    );
    const actual = JSON.parse(await Deno.readTextFile(canonicalPath)) as ProjectData;
    assert(
      actual.assets.find((candidate) => candidate.id === asset.id)?.storage_path ===
        `assets/${asset.id}-after.png`,
      "the committed or uncertain canonical project still names the promoted target",
    );
    assert(
      await Deno.readTextFile(newPath) === "payload",
      "the physical asset must stay at the target named by Canonical after an uncertain outcome",
    );
    let oldTargetExists = true;
    try {
      await Deno.lstat(oldPath);
    } catch (caught) {
      if (caught instanceof Deno.errors.NotFound) oldTargetExists = false;
      else throw caught;
    }
    assert(!oldTargetExists, "uncertain commits must not blindly roll the asset back");
  } finally {
    deno.rename = originalRename;
    deno.readFile = originalReadFile;
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});
