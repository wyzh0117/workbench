import {
  DesktopService,
  MemorySecretStore,
  type ProjectData,
} from "../src/domain/index.ts";
import {
  buildImportMappingPlan,
  confirmImportMappingPlan,
} from "../src/service/folder_mapping.ts";
import { scanFolder } from "../src/service/folder_scan.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function snapshotRequest(
  desktop: DesktopService,
  project: ProjectData,
  snapshotId: string,
  name: string,
) {
  return {
    project_dir: desktop.store.directory,
    expected_project_id: project.project.id,
    lease_generation: desktop.store.leaseGeneration,
    editor_generation: 1,
    operation_id: "save-cas-snapshot-" + crypto.randomUUID(),
    revision: 1,
    snapshot_id: snapshotId,
    name,
    note: "",
    project,
  };
}

function saveRequest(
  desktop: DesktopService,
  project: ProjectData,
  fingerprint: {
    exists: boolean;
    mtime_ms: number | null;
    size: number | null;
    hash: string | null;
  },
  revision: number,
) {
  return {
    project,
    project_dir: desktop.store.directory,
    expected_project_id: project.project.id,
    lease_generation: desktop.store.leaseGeneration,
    editor_generation: 1,
    operation_id: "save-cas-" + crypto.randomUUID(),
    revision,
    expected_fingerprint: fingerprint,
  };
}

Deno.test("folder.append rejects a stale project.save and accepts the fresh baseline", async () => {
  const target = await Deno.makeTempDir({ prefix: "acw-save-cas-target-" });
  const source = await Deno.makeTempDir({ prefix: "acw-save-cas-source-" });
  const secrets = new MemorySecretStore();
  const desktop = new DesktopService(
    target,
    { app_instance_id: `save-cas-${crypto.randomUUID()}` },
    secrets,
    { credential_store: secrets },
  );
  await desktop.open();
  try {
    const created = await desktop.commands.execute("project.create", {
      title: "CAS regression",
    });
    assert(!created.error, "project.create should establish the canonical project");

    const loaded = await desktop.commands.execute("project.open_state", {});
    assert(!loaded.error, "project.open_state should return the loaded snapshot");
    const oldState = loaded.value as {
      project: ProjectData;
      fingerprint: { exists: boolean; mtime_ms: number | null; size: number | null; hash: string | null };
    };
    assert(oldState.project && oldState.fingerprint.exists, "loaded state has project and fingerprint");
    const missingBaseline = await desktop.commands.execute("project.save", {
      project: oldState.project,
    });
    assert(
      missingBaseline.error?.code === "save_binding_invalid",
      "the command boundary must reject saves without valid project and fingerprint bindings",
    );

    await Deno.writeTextFile(source + "/reading.md", "# Imported lesson\n\nImported body.\n");
    const scan = await scanFolder(source);
    const plan = confirmImportMappingPlan(
      buildImportMappingPlan(scan.root, scan.entries),
    );
    const appended = await desktop.commands.execute("folder.append", {
      plan,
      document_paths: [],
    });
    assert(!appended.error, "folder.append should import the selected Markdown document");

    const staleProject = structuredClone(oldState.project);
    staleProject.project.title = "stale browser save";
    const rejected = await desktop.commands.execute(
      "project.save",
      saveRequest(desktop, staleProject, oldState.fingerprint, 1),
    );
    assert(
      rejected.error?.code === "external_modification_conflict",
      "project.save must reject the pre-append client fingerprint",
    );
    let disk = await desktop.store.readProject();
    assert(
      disk.content_items.length === 1 &&
        disk.blocks.some((block) => typeof block.content === "string" && block.content.includes("Imported body.")),
      "the imported lesson remains canonical after the stale save is refused",
    );

    const fresh = await desktop.commands.execute("project.open_state", {});
    assert(!fresh.error, "a fresh open_state should provide the updated baseline");
    const freshState = fresh.value as typeof oldState;
    const freshProject = structuredClone(freshState.project);
    freshProject.project.description = "saved from the current baseline";
    const accepted = await desktop.commands.execute(
      "project.save",
      saveRequest(desktop, freshProject, freshState.fingerprint, 2),
    );
    assert(!accepted.error, "a save using the fresh fingerprint should succeed");
    disk = await desktop.store.readProject();
    assert(
      disk.project.description === "saved from the current baseline" &&
        disk.content_items.length === 1 &&
        disk.blocks.some((block) => typeof block.content === "string" && block.content.includes("Imported body.")),
      "a fresh edit preserves the appended document and is written to disk",
    );
  } finally {
    await desktop.close();
    await Deno.remove(target, { recursive: true }).catch(() => undefined);
    await Deno.remove(source, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("snapshot.create stores the caller copy without changing the CAS baseline", async () => {
  const target = await Deno.makeTempDir({ prefix: "acw-snapshot-cas-" });
  const secrets = new MemorySecretStore();
  const desktop = new DesktopService(
    target,
    { app_instance_id: `snapshot-cas-${crypto.randomUUID()}` },
    secrets,
    { credential_store: secrets },
  );
  await desktop.open();
  try {
    const created = await desktop.commands.execute("project.create", {
      title: "Snapshot CAS regression",
    });
    assert(!created.error, "project.create should establish the canonical project");
    const loaded = await desktop.commands.execute("project.open_state", {});
    assert(!loaded.error, "project.open_state should return its CAS baseline");
    const initial = loaded.value as {
      project: ProjectData;
      fingerprint: { exists: boolean; mtime_ms: number | null; size: number | null; hash: string | null };
    };
    const snapshotId = crypto.randomUUID();
    const project = structuredClone(initial.project);
    project.snapshots.unshift({
      id: snapshotId,
      project_id: project.project.id,
      name: "唯一版本",
      note: "",
      git_commit_hash: null,
      created_at: new Date().toISOString(),
    });
    const saved = await desktop.commands.execute(
      "project.save",
      saveRequest(desktop, project, initial.fingerprint, 1),
    );
    assert(!saved.error, "the snapshot row should be committed through project.save");
    const committed = await desktop.commands.execute("project.open_state", {});
    assert(!committed.error, "the committed project state should be readable");
    const committedState = committed.value as typeof initial;
    const canonicalBefore = JSON.stringify(committedState.project);

    const tooLongId = await desktop.commands.execute("snapshot.create", {
      ...snapshotRequest(desktop, committedState.project, "s".repeat(129), "过长编号"),
    });
    assert(
      tooLongId.error?.code === "snapshot_invalid",
      "the service must reject snapshot ids longer than the native 128-byte limit",
    );
    const boundaryId = "s".repeat(128);
    const boundaryCopy = await desktop.commands.execute(
      "snapshot.create",
      snapshotRequest(desktop, committedState.project, boundaryId, "边界编号"),
    );
    assert(!boundaryCopy.error, "the maximum 128-byte ASCII snapshot id should be accepted");
    const reopenedBoundaryCopy = await desktop.store.diffSnapshots(boundaryId, boundaryId);
    assert(!reopenedBoundaryCopy.changed, "the maximum-length snapshot copy should reopen");

    const sidecar = await desktop.commands.execute(
      "snapshot.create",
      snapshotRequest(desktop, committedState.project, snapshotId, "唯一版本"),
    );
    assert(!sidecar.error, "snapshot.create should write the requested sidecar copy");
    const reopenedCopy = await desktop.store.diffSnapshots(snapshotId, snapshotId);
    assert(!reopenedCopy.changed, "the caller's snapshot id should reopen from its sidecar");
    const afterSidecar = await desktop.commands.execute("project.open_state", {});
    assert(!afterSidecar.error, "project state should remain readable after sidecar write");
    const afterState = afterSidecar.value as typeof initial;
    assert(
      JSON.stringify(afterState.project) === canonicalBefore &&
        JSON.stringify(afterState.fingerprint) === JSON.stringify(committedState.fingerprint),
      "snapshot.create must leave Canonical and its CAS fingerprint unchanged",
    );

    const nextProject = structuredClone(afterState.project);
    nextProject.project.description = "saved after sidecar creation";
    const nextSave = await desktop.commands.execute(
      "project.save",
      saveRequest(desktop, nextProject, afterState.fingerprint, 2),
    );
    assert(!nextSave.error, "the current baseline should still save after sidecar creation");
    const disk = await desktop.store.readProject();
    assert(
      disk.project.description === "saved after sidecar creation" &&
        disk.snapshots.filter((entry) => entry.id === snapshotId).length === 1,
      "a subsequent CAS save keeps exactly one canonical snapshot row",
    );
  } finally {
    await desktop.close();
    await Deno.remove(target, { recursive: true }).catch(() => undefined);
  }
});
