import { createHash } from "node:crypto";
import { join, normalize } from "node:path";
import {
  DesktopService,
  MemorySecretStore,
  type ProjectData,
} from "../src/domain/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function openProject(title: string) {
  const directory = await Deno.makeTempDir({ prefix: "acw-snapshot-service-" });
  const secrets = new MemorySecretStore();
  const desktop = new DesktopService(
    directory,
    { app_instance_id: `snapshot-service-${crypto.randomUUID()}` },
    secrets,
    { credential_store: secrets },
  );
  await desktop.open();
  const created = await desktop.commands.execute("project.create", { title });
  assert(!created.error, "project.create should establish a writable project");
  const loaded = await desktop.commands.execute("project.open_state", {});
  assert(
    !loaded.error,
    "project.open_state should provide the opened identity",
  );
  const state = loaded.value as {
    project: ProjectData;
    fingerprint: {
      exists: boolean;
      mtime_ms: number | null;
      size: number | null;
      hash: string | null;
    };
  };
  return {
    directory,
    desktop,
    project: state.project,
    fingerprint: state.fingerprint,
  };
}

function snapshotRequest(
  desktop: DesktopService,
  project: ProjectData,
  snapshotId: string,
  name = "测试版本",
) {
  return {
    project_dir: desktop.store.directory,
    expected_project_id: project.project.id,
    lease_generation: desktop.store.leaseGeneration,
    editor_generation: 7,
    operation_id: `snapshot-op-${crypto.randomUUID()}`,
    revision: 3,
    snapshot_id: snapshotId,
    name,
    note: "服务持久化测试",
    project: structuredClone(project),
  };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

Deno.test("snapshot.create binds a persisted copy, is idempotent, and lists bad rows separately", async () => {
  const fixture = await openProject("快照持久化");
  const { desktop, directory, project } = fixture;
  const snapshotId = crypto.randomUUID().replaceAll("-", "");
  const input = snapshotRequest(desktop, project, snapshotId);
  try {
    const first = await desktop.commands.execute("snapshot.create", input);
    assert(
      !first.error,
      `snapshot.create should persist: ${first.error?.code}`,
    );
    const ack = first.value as {
      id: string;
      snapshot_id: string;
      persisted: boolean;
      outcome: string;
      content_hash: string;
      created_at: string;
      project_id: string;
      project_dir: string;
      lease_generation: string | null;
      editor_generation: number;
      operation_id: string;
      revision: number;
    };
    const snapshotPath = join(
      directory,
      ".workspace",
      "snapshots",
      `${snapshotId}.json`,
    );
    const bytes = await Deno.readFile(snapshotPath);
    assert(
      ack.persisted && ack.id === snapshotId &&
        ack.snapshot_id === snapshotId &&
        ack.outcome === "written" && ack.content_hash === hash(bytes),
      "create ack must describe bytes actually persisted under the stable id",
    );
    assert(
      ack.project_id === project.project.id &&
        ack.project_dir === desktop.store.directory &&
        ack.lease_generation === desktop.store.leaseGeneration &&
        ack.editor_generation === input.editor_generation &&
        ack.operation_id === input.operation_id &&
        ack.revision === input.revision,
      "create ack must echo the validated project and editor binding",
    );

    const retry = await desktop.commands.execute("snapshot.create", input);
    assert(
      !retry.error,
      "retrying the same snapshot id and bytes should succeed",
    );
    const retryAck = retry.value as typeof ack;
    assert(
      retryAck.outcome === "unchanged" &&
        retryAck.content_hash === ack.content_hash &&
        retryAck.created_at === ack.created_at,
      "an identical retry must be a stable no-op acknowledgement",
    );

    const changed = structuredClone(project);
    changed.project.description = "不同内容";
    const conflict = await desktop.commands.execute("snapshot.create", {
      ...snapshotRequest(desktop, changed, snapshotId),
      operation_id: `snapshot-op-${crypto.randomUUID()}`,
    });
    assert(
      conflict.error?.code === "snapshot_id_conflict" &&
        conflict.error.details?.retryable === false,
      "reusing an id for different bytes must conflict without overwrite",
    );
    assert(
      hash(await Deno.readFile(snapshotPath)) === ack.content_hash,
      "the original snapshot bytes must survive an id conflict",
    );

    const damagedId = crypto.randomUUID().replaceAll("-", "");
    await Deno.writeTextFile(
      join(directory, ".workspace", "snapshots", `${damagedId}.json`),
      "{not valid project json",
    );
    const listed = await desktop.commands.execute("snapshot.list", {
      project_dir: desktop.store.directory,
    });
    assert(
      !listed.error,
      "snapshot.list should return valid rows despite a corrupt sibling",
    );
    const snapshotList = listed.value as {
      project_id: string;
      snapshots: Array<
        { id: string | null; status: string; content_hash?: string }
      >;
    };
    assert(
      snapshotList.project_id === project.project.id,
      "snapshot.list must bind the active project",
    );
    assert(
      snapshotList.snapshots.some((row) =>
        row.id === snapshotId && row.status === "available" &&
        row.content_hash === ack.content_hash
      ) &&
        snapshotList.snapshots.some((row) =>
          row.id === damagedId && row.status === "error"
        ),
      "list must isolate a malformed row and keep the valid snapshot available",
    );
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("snapshot create and restore report snapshot-directory sync warnings", async () => {
  const { desktop, directory, project } = await openProject("快照目录同步告警");
  const snapshotId = crypto.randomUUID().replaceAll("-", "");
  const snapshotDirectory = normalize(
    join(directory, ".workspace", "snapshots"),
  );
  const originalOpen = Deno.open;
  const blockSnapshotDirectorySync = () => {
    Deno.open = async (path, options) => {
      if (normalize(String(path)) === snapshotDirectory) {
        throw new Error("injected snapshot directory sync failure");
      }
      return await originalOpen(path, options);
    };
  };
  try {
    blockSnapshotDirectorySync();
    const created = await desktop.commands.execute("snapshot.create", {
      ...snapshotRequest(desktop, project, snapshotId),
    });
    assert(
      !created.error,
      "directory-sync warning must not roll back snapshot bytes",
    );
    const createdAck = created.value as {
      persisted: boolean;
      durability_warning?: string | null;
      content_hash: string;
    };
    assert(
      createdAck.persisted &&
        createdAck.durability_warning?.includes("目录元数据同步失败"),
      "snapshot.create must report a failed snapshots-directory sync",
    );
    const snapshotPath = join(snapshotDirectory, `${snapshotId}.json`);
    const snapshotMetadata = JSON.parse(
      await Deno.readTextFile(
        join(snapshotDirectory, `${snapshotId}.meta.json`),
      ),
    ) as { snapshot_id: string; content_hash: string };
    assert(
      hash(await Deno.readFile(snapshotPath)) === createdAck.content_hash &&
        snapshotMetadata.snapshot_id === snapshotId &&
        snapshotMetadata.content_hash === createdAck.content_hash,
      "a post-promotion sync warning must preserve the persisted snapshot and metadata",
    );

    const retry = await desktop.commands.execute("snapshot.create", {
      ...snapshotRequest(desktop, project, snapshotId),
    });
    assert(
      !retry.error,
      "the same snapshot can be retried after a sync warning",
    );
    const retryAck = retry.value as {
      outcome: string;
      durability_warning?: string | null;
    };
    assert(
      retryAck.outcome === "unchanged" &&
        retryAck.durability_warning?.includes("目录元数据同步失败"),
      "an idempotent retry must re-attempt and report an unresolved directory sync",
    );

    Deno.open = originalOpen;
    const modified = structuredClone(project);
    modified.project.description = "恢复前目录同步告警测试内容";
    await desktop.store.saveWithRecovery(modified);
    const state = await desktop.store.readProjectSnapshot();
    assert(state.project, "the modified canonical project should be readable");
    blockSnapshotDirectorySync();
    const restored = await desktop.commands.execute("snapshot.restore", {
      project_dir: desktop.store.directory,
      expected_project_id: project.project.id,
      expected_fingerprint: state.fingerprint,
      lease_generation: desktop.store.leaseGeneration,
      editor_generation: 8,
      operation_id: `restore-op-${crypto.randomUUID()}`,
      revision: 4,
      snapshot_id: snapshotId,
    });
    assert(
      !restored.error,
      "a backup directory-sync warning must not undo restore",
    );
    const restoreAck = restored.value as {
      durability_warning?: string | null;
      backup_snapshot_id: string;
    };
    assert(
      restoreAck.durability_warning?.includes("目录元数据同步失败"),
      "snapshot.restore must include the before-backup directory-sync warning",
    );
    const backupBytes = await Deno.readFile(
      join(snapshotDirectory, `${restoreAck.backup_snapshot_id}.json`),
    );
    assert(
      JSON.parse(new TextDecoder().decode(backupBytes)).project.description ===
        modified.project.description,
      "the warning must describe an actual persisted before-backup",
    );
  } finally {
    Deno.open = originalOpen;
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("snapshot.list is read-only when the snapshot directory is absent", async () => {
  const { directory, desktop } = await openProject("空快照列表");
  await desktop.close();
  const snapshotDirectory = join(directory, ".workspace", "snapshots");
  await Deno.remove(snapshotDirectory, { recursive: true }).catch(() =>
    undefined
  );
  const secrets = new MemorySecretStore();
  const readOnly = new DesktopService(
    directory,
    {
      app_instance_id: `snapshot-list-readonly-${crypto.randomUUID()}`,
      read_only: true,
    },
    secrets,
    { credential_store: secrets },
  );
  await readOnly.open();
  try {
    const listed = await readOnly.commands.execute("snapshot.list", {
      project_dir: readOnly.store.directory,
    });
    assert(
      !listed.error,
      `snapshot.list should be available in read-only mode: ${listed.error?.code}`,
    );
    const value = listed.value as { project_id: string; snapshots: unknown[] };
    assert(
      value.project_id && value.snapshots.length === 0,
      "an empty project should return an empty snapshot list",
    );
    let directoryExists = true;
    try {
      await Deno.stat(snapshotDirectory);
    } catch {
      directoryExists = false;
    }
    assert(
      !directoryExists,
      "listing must not create snapshot storage as a side effect",
    );
  } finally {
    await readOnly.close();
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("snapshot.list keeps a persisted orphan visible after canonical index commit fails", async () => {
  const { desktop, directory, project, fingerprint } = await openProject(
    "索引保存失败",
  );
  const snapshotId = crypto.randomUUID().replaceAll("-", "");
  const originalRename = Deno.rename;
  try {
    const persisted = await desktop.commands.execute("snapshot.create", {
      ...snapshotRequest(desktop, project, snapshotId, "尚未索引的版本"),
    });
    assert(
      !persisted.error,
      "snapshot sidecar should persist before canonical index update",
    );
    const indexed = structuredClone(project);
    indexed.snapshots.unshift({
      id: snapshotId,
      project_id: project.project.id,
      name: "尚未索引的版本",
      note: "服务持久化测试",
      git_commit_hash: null,
      created_at: new Date().toISOString(),
    });
    Deno.rename = async (from, to) => {
      if (String(to) === join(directory, "project.json")) {
        throw new Error("injected canonical snapshot-index commit failure");
      }
      await originalRename(from, to);
    };
    const save = await desktop.commands.execute("project.save", {
      project: indexed,
      expected_project_id: project.project.id,
      lease_generation: desktop.store.leaseGeneration,
      editor_generation: 7,
      operation_id: `index-op-${crypto.randomUUID()}`,
      revision: 4,
      expected_fingerprint: fingerprint,
    });
    assert(save.error, "the injected Canonical index save should fail");
    Deno.rename = originalRename;

    const listed = await desktop.commands.execute("snapshot.list", {
      project_dir: desktop.store.directory,
    });
    assert(
      !listed.error,
      "a sidecar snapshot should remain listable when Canonical indexing fails",
    );
    const value = listed.value as {
      snapshots: Array<{ id: string | null; name: string; status: string }>;
    };
    assert(
      value.snapshots.some((row) =>
        row.id === snapshotId && row.name === "尚未索引的版本" &&
        row.status === "available"
      ),
      "the service must discover the persisted orphan independently of Canonical snapshot rows",
    );
    const after = await desktop.store.readProjectSnapshot();
    assert(
      after.project?.snapshots.every((snapshot) => snapshot.id !== snapshotId),
      "failed Canonical indexing must not fabricate the snapshot metadata row",
    );
  } finally {
    Deno.rename = originalRename;
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("snapshot.restore persists a before-backup and returns the committed fingerprint", async () => {
  const { desktop, directory, project } = await openProject("恢复快照");
  const snapshotId = crypto.randomUUID().replaceAll("-", "");
  try {
    const saved = await desktop.commands.execute(
      "snapshot.create",
      snapshotRequest(desktop, project, snapshotId),
    );
    assert(!saved.error, "the source snapshot should persist before restore");

    const modified = structuredClone(project);
    modified.project.description = "恢复前的当前内容";
    await desktop.store.saveWithRecovery(modified);
    const opened = await desktop.commands.execute("project.open_state", {});
    assert(!opened.error, "the changed canonical project should reopen");
    const current = (opened.value as { project: ProjectData }).project;
    const request = {
      project_dir: desktop.store.directory,
      expected_project_id: project.project.id,
      lease_generation: desktop.store.leaseGeneration,
      editor_generation: 8,
      operation_id: `restore-op-${crypto.randomUUID()}`,
      revision: 4,
      snapshot_id: snapshotId,
    };
    const restored = await desktop.commands.execute(
      "snapshot.restore",
      request,
    );
    assert(
      !restored.error,
      `snapshot.restore should commit: ${restored.error?.code}`,
    );
    const ack = restored.value as {
      restored: boolean;
      snapshot_id: string;
      project: ProjectData;
      fingerprint: {
        exists: boolean;
        mtime_ms: number | null;
        size: number | null;
        hash: string | null;
      };
      project_id: string;
      project_dir: string;
      lease_generation: string | null;
      editor_generation: number;
      operation_id: string;
      revision: number;
      backup_snapshot_id: string;
      backup_persisted: boolean;
      commit_state: string;
    };
    assert(
      ack.restored && ack.snapshot_id === snapshotId &&
        ack.project.project.description === project.project.description &&
        ack.project_id === project.project.id &&
        ack.project_dir === desktop.store.directory &&
        ack.lease_generation === desktop.store.leaseGeneration &&
        ack.editor_generation === request.editor_generation &&
        ack.operation_id === request.operation_id &&
        ack.revision === request.revision && ack.commit_state === "committed",
      "restore ack must bind the committed project to its request",
    );
    assert(
      ack.backup_persisted && ack.backup_snapshot_id,
      "restore must acknowledge its persisted before-backup",
    );
    const backupPath = join(
      directory,
      ".workspace",
      "snapshots",
      `${ack.backup_snapshot_id}.json`,
    );
    const beforeBytes = await Deno.readFile(backupPath);
    assert(
      JSON.parse(new TextDecoder().decode(beforeBytes)).project.description ===
        current.project.description,
      "the persisted before-backup must contain the pre-restore canonical project",
    );
    const canonicalBytes = await Deno.readFile(join(directory, "project.json"));
    assert(
      ack.fingerprint.hash === hash(canonicalBytes) &&
        ack.fingerprint.size === canonicalBytes.byteLength,
      "restore fingerprint must match the actual committed canonical bytes",
    );
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("snapshot.restore leaves Canonical intact when its before-backup cannot persist", async () => {
  const { desktop, directory, project } = await openProject("备份失败恢复");
  const snapshotId = crypto.randomUUID().replaceAll("-", "");
  const snapshotPath = join(
    directory,
    ".workspace",
    "snapshots",
    `${snapshotId}.json`,
  );
  const originalRename = Deno.rename;
  try {
    const created = await desktop.commands.execute(
      "snapshot.create",
      snapshotRequest(desktop, project, snapshotId),
    );
    assert(!created.error, "the restore source snapshot should persist");
    const modified = structuredClone(project);
    modified.project.description = "必须留在磁盘上的当前内容";
    await desktop.store.saveWithRecovery(modified);
    const before = await Deno.readFile(join(directory, "project.json"));
    const current = await desktop.commands.execute("project.open_state", {});
    assert(!current.error, "the current canonical project should reopen");

    Deno.rename = async (from, to) => {
      if (
        String(to).startsWith(
          join(directory, ".workspace", "snapshots") + "/",
        ) &&
        String(to).endsWith(".json") && String(to) !== snapshotPath
      ) throw new Error("injected before-backup persistence failure");
      await originalRename(from, to);
    };
    const failed = await desktop.commands.execute("snapshot.restore", {
      project_dir: desktop.store.directory,
      expected_project_id: project.project.id,
      lease_generation: desktop.store.leaseGeneration,
      editor_generation: 9,
      operation_id: `restore-op-${crypto.randomUUID()}`,
      revision: 5,
      snapshot_id: snapshotId,
    });
    assert(
      failed.error,
      "restore must stop if its before-backup did not persist",
    );
    assert(
      hash(await Deno.readFile(join(directory, "project.json"))) ===
        hash(before),
      "failure to persist the before-backup must leave Canonical byte-for-byte unchanged",
    );
  } finally {
    Deno.rename = originalRename;
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
