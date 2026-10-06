import { createHash } from "node:crypto";
import { join } from "node:path";
import { DesktopService } from "../src/service/desktop.ts";
import { migrateProject, serializeProject } from "../src/domain/store.ts";
import type { ProjectData } from "../src/domain/types.ts";
import type { FileFingerprint } from "../src/service/storage.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

interface OpenState {
  project: ProjectData;
  project_id: string;
  project_dir: string;
  lease_generation: string;
  fingerprint: FileFingerprint;
}

async function openCreatedProject() {
  const directory = await Deno.makeTempDir({ prefix: "acw-save-protocol-" });
  const desktop = new DesktopService(directory, {
    app_instance_id: `save-protocol-${crypto.randomUUID()}`,
  });
  await desktop.open();
  const created = await desktop.commands.execute("project.create", {
    title: "Save protocol",
  });
  assert(
    !created.error,
    "test project should be created under an active lease",
  );
  const opened = await desktop.commands.execute("project.open_state", {});
  assert(!opened.error, "open_state should bind the editable project");
  return {
    directory,
    desktop,
    project: structuredClone(created.value as ProjectData),
    state: opened.value as OpenState,
  };
}

function request(
  project: ProjectData,
  state: OpenState,
  revision: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    project,
    project_dir: state.project_dir,
    expected_project_id: state.project_id,
    lease_generation: state.lease_generation,
    editor_generation: 1,
    operation_id: crypto.randomUUID(),
    revision,
    expected_fingerprint: state.fingerprint,
    recovery_metadata: {
      project_id: state.project_id,
      saved_at: new Date().toISOString(),
    },
    ...overrides,
  };
}

Deno.test("project.read_state stays pure and open_state returns the active lease", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-save-read-state-" });
  const desktop = new DesktopService(directory);
  try {
    const result = await desktop.commands.execute("project.read_state", {});
    assert(!result.error, "read_state should succeed before opening");
    const value = result.value as {
      project_id: string | null;
      project_dir: string;
      lease_generation: string | null;
    };
    assert(value.project_id === null, "missing project has no owner id");
    assert(
      value.project_dir === directory,
      "read returns the canonical directory",
    );
    assert(value.lease_generation === null, "pure read never adopts a lease");
    let workspaceCreated = false;
    try {
      await Deno.stat(`${directory}/.workspace`);
      workspaceCreated = true;
    } catch (caught) {
      if (!(caught instanceof Deno.errors.NotFound)) throw caught;
    }
    assert(
      !workspaceCreated,
      "pure read must not create the workspace or lock",
    );
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }

  const opened = await openCreatedProject();
  try {
    const first = opened.state.lease_generation;
    assert(
      typeof first === "string" && first.length > 0,
      "open returns a lease generation",
    );
    await opened.desktop.store.heartbeat();
    const afterHeartbeat = await opened.desktop.commands.execute(
      "project.open_state",
      {},
    );
    assert(
      (afterHeartbeat.value as OpenState).lease_generation === first,
      "heartbeat keeps one stable lease generation",
    );
    const read = await opened.desktop.commands.execute(
      "project.read_state",
      {},
    );
    assert(
      (read.value as { lease_generation: string | null }).lease_generation ===
        null,
      "pure read does not echo or adopt the active writer lease",
    );
  } finally {
    await opened.desktop.close();
    await Deno.remove(opened.directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("bound project saves return compact ack and unchanged saves perform zero writes", async () => {
  const { directory, desktop, project, state } = await openCreatedProject();
  const path = join(directory, "project.json");
  const recoveryPath = join(directory, ".workspace", "recovery.json");
  const recoveryBackupPath = `${recoveryPath}.bak`;
  const projectBackupPath = `${path}.bak`;
  try {
    const canonicalText = serializeProject(project);
    assert(
      serializeProject(migrateProject(JSON.parse(canonicalText))) ===
        canonicalText,
      "serialized canonical bytes remain stable after domain normalization",
    );
    const beforeBytes = await Deno.readFile(path);
    await Deno.writeTextFile(recoveryPath, "recovery sentinel");
    await Deno.writeTextFile(recoveryBackupPath, "recovery backup sentinel");
    await Deno.writeTextFile(projectBackupPath, "project backup sentinel");
    const unchangedRequest = request(project, state, 1, {
      project_dir: `${state.project_dir}/.`,
    });
    const unchanged = await desktop.commands.execute(
      "project.save",
      unchangedRequest,
    );
    assert(!unchanged.error, "unchanged save should succeed");
    const unchangedValue = unchanged.value as Record<string, unknown>;
    assert(
      unchangedValue.outcome === "unchanged",
      "save reports unchanged outcome",
    );
    assert(!("project" in unchangedValue), "save ack stays compact");
    assert(
      unchangedValue.project_id === state.project_id,
      "ack binds the project owner",
    );
    assert(
      unchangedValue.lease_generation === state.lease_generation,
      "ack binds the active lease",
    );
    assert(
      unchangedValue.operation_id === unchangedRequest.operation_id,
      "ack includes the operation id",
    );
    assert(
      bytesEqual(await Deno.readFile(path), beforeBytes),
      "unchanged save leaves canonical bytes untouched",
    );
    assert(
      await Deno.readTextFile(recoveryPath) === "recovery sentinel",
      "unchanged save leaves recovery file untouched",
    );
    assert(
      await Deno.readTextFile(recoveryBackupPath) ===
        "recovery backup sentinel",
      "unchanged save leaves recovery backup untouched",
    );
    assert(
      await Deno.readTextFile(projectBackupPath) === "project backup sentinel",
      "unchanged save leaves project backup untouched",
    );

    const changed = structuredClone(project);
    changed.project.title = "Bound save written";
    const writtenRequest = request(changed, state, 2);
    const written = await desktop.commands.execute(
      "project.save",
      writtenRequest,
    );
    assert(!written.error, "changed save should commit");
    const writtenAck = written.value as Record<string, unknown>;
    assert(writtenAck.outcome === "written", "save reports a written outcome");
    assert(
      writtenAck.project_id === state.project_id,
      "written ack keeps the owner id",
    );
    assert(
      writtenAck.editor_generation === 1,
      "written ack echoes editor generation",
    );
    assert(writtenAck.revision === 2, "written ack echoes revision");
    assert(
      writtenAck.operation_id === writtenRequest.operation_id,
      "written ack carries the operation id",
    );
    const committedBytes = await Deno.readFile(path);
    const actualHash = createHash("sha256").update(committedBytes).digest(
      "hex",
    );
    assert(
      (writtenAck.fingerprint as FileFingerprint).hash === actualHash,
      "fingerprint hashes exactly the bytes committed to disk",
    );
    assert(
      writtenAck.durability_warning === null,
      "the compact ack reports durability status",
    );
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("project.save rejects stale lease and wrong owner before changing canonical", async () => {
  const { directory, desktop, project, state } = await openCreatedProject();
  const path = join(directory, "project.json");
  try {
    const before = await Deno.readFile(path);
    const staleLease = await desktop.commands.execute(
      "project.save",
      request(project, state, 1, { lease_generation: "stale-lease" }),
    );
    assert(
      staleLease.error?.code === "project_lock_lost",
      "stale lease is rejected",
    );
    assert(
      staleLease.error.details.commit_state === "not_committed",
      "lease errors are explicitly noncommitting",
    );
    const wrongOwner = await desktop.commands.execute(
      "project.save",
      request(project, state, 1, { expected_project_id: "another-project" }),
    );
    assert(
      wrongOwner.error?.code === "project_id_mismatch",
      "wrong owner is rejected",
    );
    assert(
      wrongOwner.error.details.commit_state === "not_committed",
      "owner errors are explicitly noncommitting",
    );
    const incompleteBinding = await desktop.commands.execute(
      "project.save",
      {
        project,
        project_dir: state.project_dir,
        expected_fingerprint: state.fingerprint,
      },
    );
    assert(
      incompleteBinding.error?.code === "save_binding_invalid" &&
        incompleteBinding.error.details.commit_state === "not_committed",
      "a partial new binding must fail closed instead of downgrading to legacy save",
    );
    const wrongDirectory = await desktop.commands.execute(
      "project.save",
      request(project, state, 1, { project_dir: `${directory}-other` }),
    );
    assert(
      wrongDirectory.error?.code === "save_binding_invalid",
      "another project path is rejected",
    );
    assert(
      wrongDirectory.error.details.commit_state === "not_committed",
      "directory errors are explicitly noncommitting",
    );
    assert(
      bytesEqual(await Deno.readFile(path), before),
      "rejected bindings leave canonical bytes unchanged",
    );
    const external = structuredClone(project);
    external.project.title = "External writer";
    await Deno.writeTextFile(path, JSON.stringify(external));
    const externallyChanged = await Deno.readFile(path);
    const staleFingerprint = await desktop.commands.execute(
      "project.save",
      request(project, state, 2),
    );
    assert(
      staleFingerprint.error?.code === "external_modification_conflict",
      "same-owner save cannot overwrite a changed canonical fingerprint",
    );
    assert(
      staleFingerprint.error.details.stage === "fingerprint_preflight" &&
        staleFingerprint.error.details.commit_state === "not_committed",
      "fingerprint conflicts identify a noncommitting stage",
    );
    assert(
      bytesEqual(await Deno.readFile(path), externallyChanged),
      "fingerprint conflict leaves external canonical bytes untouched",
    );
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});
