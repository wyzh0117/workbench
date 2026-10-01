/**
 * Item 1 — §3.2 Case C on the storage side: a confirmed re-import of a folder
 * whose `project.json` exists but cannot be used must keep that file.  The
 * adoption moves it aside under a `*.invalid.backup` name (which the folder scan
 * already ignores) rather than letting the new manifest replace it, and refuses
 * outright when the file is actually a usable project.
 *
 * This is the Deno twin of `folder_adopt_case_c_*` in src-tauri/src/lib.rs.
 */
import {
  createEmptyProjectData,
  serializeProject,
  validateProjectData,
} from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";
import {
  buildImportMappingPlan,
  confirmImportMappingPlan,
  type ImportMappingPlan,
} from "../src/service/folder_mapping.ts";
import { scanFolder } from "../src/service/folder_scan.ts";
import { confirmFolderAdoption } from "../src/service/folder_adoption.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message = "values differ"): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "acw-case-c-" });
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function readIfExists(path: string): Promise<string | null> {
  return await Deno.readTextFile(path).catch(() => null);
}

async function backupNames(root: string): Promise<string[]> {
  const found: string[] = [];
  for await (const item of Deno.readDir(root)) {
    if (item.name.startsWith("project.json.") && item.name.endsWith(".invalid.backup")) {
      found.push(item.name);
    }
  }
  return found.sort();
}

async function planFor(root: string): Promise<ImportMappingPlan> {
  const report = await scanFolder(root);
  const plan = buildImportMappingPlan(report.root, report.entries);
  // Keep the plan to the one image: markdown items would need the shared parse
  // payload, and this test is about the manifest, not the parser.
  plan.items = plan.items.filter((item) => item.relative_path === "cover.png");
  for (const item of plan.items) {
    item.mapping = "asset";
    item.selected = true;
  }
  return confirmImportMappingPlan(plan);
}

async function seedFolder(root: string, manifest: string | null): Promise<void> {
  await Deno.writeFile(join(root, "cover.png"), new Uint8Array([1, 2, 3]));
  if (manifest !== null) await Deno.writeTextFile(join(root, "project.json"), manifest);
}

function join(root: string, name: string): string {
  return `${root}/${name}`;
}

Deno.test("an existing unusable manifest is kept as a backup on confirmed re-import", async () => {
  await withTempDir(async (root) => {
    await seedFolder(root, "{broken");
    const plan = await planFor(root);

    // Without the confirmation the folder is untouched — the old refusal stands.
    let refused = "";
    try {
      await confirmFolderAdoption(plan, {});
    } catch (caught) {
      refused = caught instanceof Error ? caught.message : String(caught);
    }
    assert(refused.includes("project.json"), `expected a manifest refusal, got: ${refused}`);
    assertEquals(await readIfExists(join(root, "project.json")), "{broken", "an unconfirmed adoption leaves the manifest alone");
    assertEquals(await backupNames(root), [], "nothing was moved aside");

    const result = await confirmFolderAdoption(plan, { replace_invalid_project: true });
    const backups = await backupNames(root);
    assertEquals(backups.length, 1, "exactly one quarantined manifest");
    const [backup] = backups;
    assert(backup, "the backup has a name");
    assertEquals(await readIfExists(join(root, backup)), "{broken", "every byte of the original is preserved");
    const written = await readIfExists(join(root, "project.json"));
    assert(written !== null, "a new manifest was written");
    const parsed = JSON.parse(written) as ProjectData;
    assertEquals(validateProjectData(parsed).length, 0, "the new manifest is canonical");
    assert(
      result.warnings.some((warning) => warning.includes("project.json")),
      `the backup is reported to the user: ${JSON.stringify(result.warnings)}`,
    );
  });
});

Deno.test("the confirmation never replaces a usable project", async () => {
  await withTempDir(async (root) => {
    const existing = createEmptyProjectData("已经可用的课程");
    await seedFolder(root, serializeProject(existing));
    const plan = await planFor(root);
    let message = "";
    try {
      await confirmFolderAdoption(plan, { replace_invalid_project: true });
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    assert(message.includes("可用"), `expected a usable-project refusal, got: ${message}`);
    assertEquals(await readIfExists(join(root, "project.json")), serializeProject(existing), "the usable project is untouched");
    assertEquals(await backupNames(root), [], "a refused adoption moves nothing");
  });
});

Deno.test("a newer schema is refused as too new, not treated as broken", async () => {
  await withTempDir(async (root) => {
    const newer = { ...createEmptyProjectData("未来版本"), schema_version: "99.0.0" };
    await seedFolder(root, JSON.stringify(newer));
    const plan = await planFor(root);
    let message = "";
    try {
      await confirmFolderAdoption(plan, { replace_invalid_project: true });
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    assert(message.includes("更高版本"), `expected an upgrade hint, got: ${message}`);
    assertEquals(await readIfExists(join(root, "project.json")), JSON.stringify(newer), "the newer project is untouched");
    assertEquals(await backupNames(root), [], "nothing was moved aside");
  });
});
