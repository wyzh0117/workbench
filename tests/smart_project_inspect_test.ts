/**
 * Item 1 — smart project/folder open (§3.4 regression matrix).
 *
 * Covers both the pure canonical classifier (`inspectProjectData`) and the
 * filesystem inspector (`inspectProjectDirectory`) that the launcher routes on.
 * The machine-readable `status` must never collapse a specific diagnosis into a
 * generic "not a project" message, and a folder whose `project.json` only needs
 * migration must be reported as `migratable`, not `invalid`.
 */
import {
  createEmptyProjectData,
  inspectProjectData,
  inspectProjectDirectory,
  migrateProject,
  serializeProject,
  validateProjectData,
} from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "wb-smart-open-" });
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function writeProjectJson(dir: string, text: string): Promise<void> {
  await Deno.writeTextFile(`${dir}/project.json`, text);
}

// ---------------------------------------------------------------------------
// Pure classifier: inspectProjectData
// ---------------------------------------------------------------------------

Deno.test("inspectProjectData: a current valid project reports status valid", () => {
  const fresh = createEmptyProjectData("课程");
  const inspection = inspectProjectData(fresh);
  assert(inspection.status === "valid", `expected valid, got ${inspection.status}`);
  assert(inspection.problem === null, "a valid project must carry no problem");
  assert(inspection.project?.id === fresh.project.id, "project id must be echoed");
  assert(
    inspection.supported_schema_version === fresh.schema_version,
    "supported version must match CURRENT_SCHEMA_VERSION",
  );
});

Deno.test("inspectProjectData: an older supported schema is migratable, not invalid", () => {
  const fresh = createEmptyProjectData("课程");
  const older = structuredClone(fresh) as unknown as Record<string, unknown>;
  delete older.layout_pages;
  older.schema_version = 4; // pre-semver integer revision
  (older.project as Record<string, unknown>).schema_version = undefined;
  delete (older.project as Record<string, unknown>).schema_version;
  const inspection = inspectProjectData(older);
  assert(
    inspection.status === "migratable",
    `expected migratable for an older schema, got ${inspection.status}`,
  );
  assert(inspection.problem === null, "migratable is not a problem state");
});

Deno.test("inspectProjectData: a missing layout_pages collection is migratable too", () => {
  const fresh = createEmptyProjectData("课程");
  const data = structuredClone(fresh);
  // Mirrors the real course: valid project/content_items/blocks, no layout_pages.
  delete (data as unknown as Record<string, unknown>).layout_pages;
  (data as unknown as Record<string, unknown>).schema_version = 3;
  const inspection = inspectProjectData(data);
  assert(inspection.status === "migratable", `got ${inspection.status}`);
  // Migration must actually repair it to a fully valid canonical project.
  const migrated = migrateProject(data);
  assert(validateProjectData(migrated).length === 0, "migrate must reach zero issues");
});

Deno.test("inspectProjectData: a newer unsupported schema is invalid with a precise code", () => {
  const fresh = createEmptyProjectData("课程");
  const newer = structuredClone(fresh) as unknown as Record<string, unknown>;
  newer.schema_version = "99.0.0";
  const inspection = inspectProjectData(newer);
  assert(inspection.status === "invalid", `got ${inspection.status}`);
  assert(inspection.problem?.code === "unsupported_schema", "expected unsupported_schema");
});

Deno.test("inspectProjectData: valid JSON but broken canonical is invalid with first problem", () => {
  const fresh = createEmptyProjectData("课程");
  const broken = structuredClone(fresh);
  // Reference a document that does not exist → an invalid_reference problem.
  broken.blocks.push({
    id: "blk-orphan",
    document_id: "missing-document-id",
    parent_block_id: null,
    type: "paragraph",
    order_index: 0,
    content: "正文",
    settings: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as never);
  const inspection = inspectProjectData(broken);
  assert(inspection.status === "invalid", `got ${inspection.status}`);
  assert(
    inspection.problem?.code === "invalid_reference",
    `expected invalid_reference, got ${inspection.problem?.code}`,
  );
  assert(Boolean(inspection.problem?.path), "problem must carry the failing path");
});

Deno.test("inspectProjectData: a bare non-project object is invalid_root", () => {
  const inspection = inspectProjectData({ hello: "world" });
  assert(inspection.status === "invalid", `got ${inspection.status}`);
  assert(inspection.problem?.code === "missing_project", "expected missing_project");
});

// ---------------------------------------------------------------------------
// Filesystem inspector: inspectProjectDirectory
// ---------------------------------------------------------------------------

Deno.test("inspectProjectDirectory: malformed JSON is its own malformed_json status", () =>
  withTempDir(async (dir) => {
    await writeProjectJson(dir, '{ "project": { "id": "x", ,, }');
    const inspection = await inspectProjectDirectory(dir);
    assert(
      inspection.status === "malformed_json",
      `expected malformed_json, got ${inspection.status}`,
    );
    assert(inspection.problem?.code === "malformed_json", "code must be malformed_json");
  }));

Deno.test("inspectProjectDirectory: a plain folder with files has no project.json", () =>
  withTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/notes.md`, "# hi");
    await Deno.writeTextFile(`${dir}/data.csv`, "a,b");
    const inspection = await inspectProjectDirectory(dir);
    assert(inspection.status === "no_project_json", `got ${inspection.status}`);
    assert(inspection.problem?.code === "project_json_missing", "missing file diagnosis");
  }));

Deno.test("inspectProjectDirectory: a folder with only subfolders is still no_project_json", () =>
  withTempDir(async (dir) => {
    await Deno.mkdir(`${dir}/s01-00`);
    await Deno.mkdir(`${dir}/s01-01`);
    const inspection = await inspectProjectDirectory(dir);
    assert(inspection.status === "no_project_json", `got ${inspection.status}`);
  }));

Deno.test("inspectProjectDirectory: an empty folder is no_project_json", () =>
  withTempDir(async (dir) => {
    const inspection = await inspectProjectDirectory(dir);
    assert(inspection.status === "no_project_json", `got ${inspection.status}`);
  }));

Deno.test("inspectProjectDirectory: a stage-shaped folder s01-00..s01-14 is no_project_json", () =>
  withTempDir(async (dir) => {
    for (let index = 0; index <= 14; index += 1) {
      const name = `s01-${String(index).padStart(2, "0")}`;
      await Deno.mkdir(`${dir}/${name}`);
      await Deno.writeTextFile(`${dir}/${name}/lesson.md`, "# " + name);
    }
    const inspection = await inspectProjectDirectory(dir);
    assert(inspection.status === "no_project_json", `got ${inspection.status}`);
  }));

Deno.test("inspectProjectDirectory: an already-adopted folder opens, not a missing-project message", () =>
  withTempDir(async (dir) => {
    const fresh = createEmptyProjectData("已接管课程");
    await writeProjectJson(dir, serializeProject(fresh));
    const inspection = await inspectProjectDirectory(dir);
    assert(inspection.status === "valid", `expected valid, got ${inspection.status}`);
    assert(inspection.project?.title === "已接管课程", "title must round-trip");
  }));

Deno.test("inspectProjectDirectory: a valid-but-invalid-canonical project is invalid, not missing", () =>
  withTempDir(async (dir) => {
    const text = JSON.stringify({
      schema_version: "1.0.0",
      project: {
        id: "p",
        title: "坏引用",
        schema_version: "1.0.0",
        created_at: "now",
        updated_at: "now",
      },
      documents: [{ id: "d1" }],
      blocks: [{ id: "b1", document_id: "nope", parent_block_id: null }],
    });
    await writeProjectJson(dir, text);
    const inspection = await inspectProjectDirectory(dir);
    assert(inspection.status === "invalid", `got ${inspection.status}`);
    assert(inspection.problem?.code === "invalid_reference", "must diagnose the reference");
    assert(
      Boolean(inspection.problem?.path) && (inspection.problem?.expected ?? "").length > 0,
      "a specific diagnosis must carry path + expectation, not a generic message",
    );
  }));

Deno.test("inspectProjectDirectory: a relative path is an unreadable classification, not a throw", () =>
  withTempDir(async (dir) => {
    const inspection = await inspectProjectDirectory("relative/only");
    assert(inspection.status === "unreadable", `got ${inspection.status}`);
    assert(inspection.problem?.code === "invalid_path", "expected invalid_path");
    void dir;
  }));

Deno.test("inspectProjectDirectory: a parent of adopted projects is itself no_project_json (§3.5)", () =>
  withTempDir(async (dir) => {
    // The exact shape a user gets after adopting several folders side by side:
    // a plain parent whose children are each a real, opened project.
    for (const [index, title] of ["第一课", "第二课"].entries()) {
      const child = `${dir}/s01-0${index}`;
      await Deno.mkdir(child);
      await writeProjectJson(child, serializeProject(createEmptyProjectData(title)));
    }
    const inspection = await inspectProjectDirectory(dir);
    assert(inspection.status === "no_project_json", `got ${inspection.status}`);
    assert(inspection.problem?.code === "project_json_missing", "missing file diagnosis");
    // Routing only ever acts on the root it was given: no silently echoing a
    // child's identity, which would auto-open the wrong project.
    assert(inspection.project === null, "the parent must not borrow a child's identity");
    // The children are genuinely openable, so the parent's classification is
    // about the parent — not about the children being broken.
    for (const name of ["s01-00", "s01-01"]) {
      const childInspection = await inspectProjectDirectory(`${dir}/${name}`);
      assert(childInspection.status === "valid", `child ${name} must be valid`);
      assert(childInspection.project !== null, `child ${name} must carry an identity`);
    }
  }));

Deno.test("migration: an old supported schema keeps exactly one identity (§2, §32.1)", () => {
  const fresh = createEmptyProjectData("身份课");
  const identity = fresh.project.id;
  const older = structuredClone(fresh) as unknown as Record<string, unknown>;
  delete older.layout_pages;
  older.schema_version = 4; // pre-semver integer revision
  delete (older.project as Record<string, unknown>).schema_version;
  const migrated = migrateProject(older);
  assert(migrated.project.id === identity, "migration must keep project.id byte-identical");
  assert(
    migrated.schema_version === fresh.schema_version &&
      migrated.project.schema_version === fresh.project.schema_version,
    "migration must bump both version stamps to the current schema",
  );
  assert(validateProjectData(migrated).length === 0, "migration must reach zero issues");
  const reread = JSON.parse(serializeProject(migrated)) as { project: { id: string } };
  assert(reread.project.id === identity, "identity must survive a serialize → parse round-trip");
  const inspection = inspectProjectData(reread);
  assert(inspection.status === "valid", `migrated project must inspect valid, got ${inspection.status}`);
  assert(inspection.project?.id === identity, "the inspector must echo the one identity");
  // §2: one identity, not two — no parallel uuid-style field may appear while
  // the legacy file is brought forward.
  for (const key of ["uuid", "project_uuid", "project_uuid_v4", "projectId", "project_id"]) {
    assert(!(key in migrated), `migration must not mint a second identity field (${key})`);
  }
});

// Guard: keep the unused-import checker happy for the ProjectData type used in
// fixtures above without widening the public surface.
const _typeProbe: ProjectData | null = null;
void _typeProbe;
