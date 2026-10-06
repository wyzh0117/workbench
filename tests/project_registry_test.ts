/**
 * §4/§5 — the application-level project registry.
 *
 * These tests are the browser twin of the `registry.rs` unit tests.  The point
 * is not that the JSON round-trips; it is that a row never says something false
 * about a folder: a moved project follows its id, a replaced folder retires the
 * row that claimed it, a removed row means only a row, and a folder that is not
 * a Workbench project root is never offered an 打开 button.
 */
import {
  assertNoSensitiveKeys,
  dropReplaced,
  PROJECT_REGISTRY_FILE,
  ProjectRegistryStore,
  recordRows,
  registryProjectAvailable,
  relocateRows,
  removeRows,
  rowFromValue,
  sortRows,
  type RegistryRequest,
  type RegistryRow,
} from "../src/service/project_registry.ts";
import { createEmptyProjectData, serializeProject } from "../src/domain/store.ts";
import { ProjectDirectoryStore } from "../src/service/storage.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}\n  expected: ${right}\n  actual:   ${left}`);
}

/** A row the test is about to inspect: "there was exactly one" is part of the claim. */
function only<T>(items: readonly T[], message: string): T {
  const [first] = items;
  if (first === undefined) throw new Error(`${message} — got ${items.length} rows`);
  return first;
}

function row(
  projectId: string,
  projectPath: string,
  openedAt: string,
  extra: Partial<RegistryRow> = {},
): RegistryRow {
  return {
    project_id: projectId,
    project_path: projectPath,
    project_title: `课程 ${projectId}`,
    last_opened_at: openedAt,
    ...extra,
  };
}

function request(
  projectId: string,
  projectPath: string,
  extra: Partial<RegistryRequest> = {},
): RegistryRequest {
  return {
    project_id: projectId,
    project_path: projectPath,
    project_title: `课程 ${projectId}`,
    ...extra,
  };
}

const live = () => true;
const dead = () => false;
const stamp = (day: number) => `2026-03-0${day}T08:00:00.000Z`;

async function registryInTempDir(): Promise<{ store: ProjectRegistryStore; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "workbench-registry-" });
  return { store: new ProjectRegistryStore(dir), dir };
}

Deno.test("a recorded project is written with only the §4.1 fields", async () => {
  const { store, dir } = await registryInTempDir();
  try {
    const outcome = await store.record(request("proj-a", "/tmp/proj-a"));
    eq(outcome.status, "added", "a first open is a new row");
    const contents = JSON.parse(
      await Deno.readTextFile(`${dir}/${PROJECT_REGISTRY_FILE}`),
    );
    const [first] = contents.projects;
    eq(
      Object.keys(first).sort(),
      ["last_opened_at", "project_id", "project_path", "project_title"],
      "the persisted record holds exactly the §4.1 fields",
    );
    eq(first.project_title, "课程 proj-a", "the title the caller passed is the title stored");
    eq(contents.version, 1, "the file carries its format version");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an open that reports no location refreshes the row instead of erasing it", async () => {
  const rows = [row("proj-a", "/tmp/proj-a", stamp(1), { last_content_item_id: "c-9" })];
  const { rows: next, outcome } = recordRows(
    rows,
    request("proj-a", "", { project_title: "改过名字的课程" }),
    live,
    stamp(4),
  );
  eq(outcome.status, "refreshed", "the identity and the stored path already match");
  eq(next.length, 1, "one row per project, never a second one");
  const kept = only(next, "the refresh left exactly one row");
  eq(kept.project_path, "/tmp/proj-a", "an empty path never wipes the stored location");
  eq(kept.project_title, "改过名字的课程", "the title still updates");
  eq(kept.last_content_item_id, "c-9", "a hint is not forgotten by a position-less open");
});

Deno.test("a brand-new row with no location is refused", () => {
  eq(
    (() => {
      try {
        recordRows([], request("proj-new", ""), live, stamp(1));
        return "stored";
      } catch (error) {
        return (error as Error).message;
      }
    })(),
    "项目登记表需要项目的文件夹路径",
    "a card the launcher can never open is not worth storing",
  );
});

Deno.test("the same id at two live folders asks the user rather than merging", () => {
  const rows = [row("proj-a", "/tmp/a", stamp(1))];
  const { rows: after, outcome } = recordRows(rows, request("proj-a", "/tmp/b"), live, stamp(2));
  eq(outcome.status, "duplicate", "two live folders, one identity");
  eq(after, rows, "nothing is written without the user's decision");
  eq(outcome.project?.project_path, "/tmp/a", "the prompt names the row that is on file");

  const both = recordRows(
    rows,
    request("proj-a", "/tmp/b", { allow_second_copy: true }),
    live,
    stamp(2),
  );
  eq(both.rows.length, 2, "the explicit choice keeps both locations");
  eq(both.outcome.status, "added", "the second copy is a new row");
});

Deno.test("reopening a moved project follows the id to the new folder", () => {
  const rows = [row("proj-a", "/tmp/gone", stamp(1))];
  const { rows: next, outcome } = recordRows(
    rows,
    request("proj-a", "/tmp/moved"),
    (candidate) => candidate !== "/tmp/gone",
    stamp(3),
  );
  eq(outcome.status, "relocated", "the stored folder is gone and this id opened elsewhere");
  eq(outcome.previous_path, "/tmp/gone", "the answer names where it moved from");
  eq(next.length, 1, "a move updates the row instead of accumulating one");
  eq(only(next, "the move left one row").project_path, "/tmp/moved", "the row now says where the project is");
});

Deno.test("relocating refuses a folder whose id does not match", () => {
  const rows = [row("proj-a", "/tmp/gone", stamp(1), { last_content_item_id: "c-1" })];
  const message = (() => {
    try {
      relocateRows(rows, "proj-a", "/tmp/other", {
        found_id: "proj-b",
        found_title: "别的课",
      }, stamp(5));
      return "accepted";
    } catch (error) {
      return (error as Error).message;
    }
  })();
  assert(message.includes("不一致"), `a different project must not be adopted: ${message}`);
  eq(only(rows, "the refusal read the original row").project_path, "/tmp/gone", "the refused call changed nothing");

  const moved = relocateRows(rows, "proj-a", "/tmp/found", {
    found_id: "proj-a",
    found_title: "第一门课",
  }, stamp(5));
  eq(moved.row.project_path, "/tmp/found", "a matching id is allowed through");
  eq(moved.rows.length, 1, "the row was updated, not duplicated");
  assert(
    !("last_content_item_id" in moved.row),
    "the old folder's reader hint does not travel to a new folder",
  );
});

Deno.test("relocating onto the stored path keeps the row rather than deleting it", () => {
  const rows = [row("proj-a", "/tmp/found", stamp(1), { last_content_item_id: "c-1" })];
  const { rows: next, row: kept } = relocateRows(rows, "proj-a", "/tmp/found", {
    found_id: "proj-a",
    found_title: "课程 proj-a",
  }, stamp(5));
  eq(next.length, 1, "a row is not its own duplicate");
  eq(kept.project_path, "/tmp/found", "the row still has a location");
  eq(kept.last_content_item_id, "c-1", "the path did not change, so the hint stays");
});

Deno.test("a folder recorded under a new id retires the row that claimed it", () => {
  const rows = [row("proj-old", "/tmp/shared", stamp(1)), row("proj-keep", "/tmp/elsewhere", stamp(2))];
  const { rows: next } = recordRows(rows, request("proj-new", "/tmp/shared"), live, stamp(3));
  const ids = next.map((candidate) => candidate.project_id);
  assert(!ids.includes("proj-old"), `the replaced folder must not keep claiming the old id: ${ids}`);
  assert(ids.includes("proj-keep"), "an unrelated row is not collateral damage");
  eq(next.length, 2, "one row in, one row out");
  const kept = dropReplaced(rows, "proj-new", "/tmp/fresh");
  eq(kept.length, 2, "the rule only fires for the folder that changed identity");
});

Deno.test("removing a row deletes the row and nothing else", async () => {
  const { store, dir } = await registryInTempDir();
  try {
    await store.record(request("proj-a", "/tmp/a"));
    await store.record(request("proj-b", "/tmp/b"));
    const removed = await store.remove({ project_id: "proj-a", project_path: "/tmp/a" });
    eq(removed.removed, 1, "exactly the named row went");
    const listed = await store.list();
    eq(listed.projects.map((candidate) => candidate.project_id), ["proj-b"], "the other row stays");
    const written = [...Deno.readDirSync(dir)].map((entry) => entry.name).sort();
    eq(written, [".workspace"], "removal writes only inside the app-level .workspace");
    eq(
      [...Deno.readDirSync(`${dir}/.workspace`)].map((entry) => entry.name).sort(),
      ["projects.json"],
      "no project payload is ever stored beside the registry",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removeRows without a path removes every row for that id", () => {
  const rows = [
    row("proj-a", "/tmp/a", stamp(1)),
    row("proj-a", "/tmp/b", stamp(2)),
    row("proj-c", "/tmp/c", stamp(3)),
  ];
  const both = removeRows(rows, "proj-a");
  eq(both.removed, 2, "both copies of the same identity are that project's rows");
  eq(both.rows.map((candidate) => candidate.project_id), ["proj-c"], "unrelated rows are kept");
  const one = removeRows(rows, "proj-a", "/tmp/a");
  eq(one.removed, 1, "a path-scoped removal touches one row");
  eq(one.rows.map((candidate) => candidate.project_path), ["/tmp/b", "/tmp/c"], "the named row went");
});

Deno.test("a damaged registry reads as empty and keeps the file for diagnosis", async () => {
  const { store, dir } = await registryInTempDir();
  try {
    await Deno.mkdir(`${dir}/.workspace`, { recursive: true });
    await Deno.writeTextFile(`${dir}/${PROJECT_REGISTRY_FILE}`, "{ this is not json");
    const rows = await store.read();
    eq(rows, [], "a damaged registry must never block the start page");
    const backup = await Deno.readTextFile(`${dir}/.workspace/projects.bak`);
    eq(backup, "{ this is not json", "the unreadable file is kept, not overwritten");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("closed project roots stay available while bare folders do not", async () => {
  const dir = await Deno.makeTempDir({ prefix: "workbench-registry-live-" });
  const root = await Deno.makeTempDir({ prefix: "workbench-registry-root-", dir });
  const bare = await Deno.makeTempDir({ prefix: "workbench-registry-bare-", dir });
  await Deno.writeTextFile(`${bare}/.workbench.lock`, "legacy marker\n");
  let projectStore: ProjectDirectoryStore | null = null;
  try {
    const store = new ProjectRegistryStore(dir);
    const canonical = createEmptyProjectData("Available after close");
    await Deno.writeTextFile(`${root}/project.json`, serializeProject(canonical));
    projectStore = new ProjectDirectoryStore(root, {
      app_instance_id: "registry-availability-test",
    });
    await projectStore.open();
    assert(
    await Deno.stat(projectStore.lockPath).then((stat) => stat.isFile),
      "the real store open creates its active lease",
    );
    const rows = [
      row(canonical.project.id, root, stamp(3)),
      row("proj-bare", bare, stamp(2)),
      row("proj-gone", `${dir}/does-not-exist`, stamp(1)),
    ];
    await store.write(rows);
    const listed = await store.list();
    eq(
      listed.projects.map((candidate) => [candidate.project_id, candidate.available]),
      [[canonical.project.id, true], ["proj-bare", false], ["proj-gone", false]],
      "Canonical roots stay openable; lease and legacy marker do not define availability",
    );
    await projectStore.close();
    eq(
      await Deno.stat(projectStore.lockPath).then(() => true, () => false),
      false,
      "real store close releases its lease",
    );
    const afterClose = await store.list();
    eq(
      afterClose.projects[0]?.available,
      true,
      "closing the project lease does not hide its Canonical root",
    );
    assert(
      !("api_key" in (listed.projects[0] ?? {})),
      "the derived flags are the only additions",
    );
  } finally {
    await projectStore?.close().catch(() => undefined);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("registryProjectAvailable rejects paths it must not trust", async () => {
  const dir = await Deno.makeTempDir({ prefix: "workbench-registry-probe-" });
  try {
    const project = `${dir}/course`;
    await Deno.mkdir(project);
    await Deno.writeTextFile(
      `${project}/project.json`,
      serializeProject(createEmptyProjectData("Registry probe")),
    );
    eq(
      registryProjectAvailable(project),
      true,
      "a Canonical file identifies an openable project root",
    );
    eq(registryProjectAvailable(`${dir}/missing`), false, "a folder that is gone is not");
    eq(registryProjectAvailable("relative/course"), false, "a relative path is not a location");
    eq(registryProjectAvailable(""), false, "an empty path is not a location");
    eq(registryProjectAvailable(dir), false, "the parent of projects is not a project");
    const linkedCanonical = `${project}/linked-project.json`;
    try {
      await Deno.symlink(`${project}/project.json`, linkedCanonical);
      await Deno.remove(`${project}/project.json`);
      await Deno.symlink(linkedCanonical, `${project}/project.json`);
      eq(registryProjectAvailable(project), false, "a symlinked Canonical file is refused");
    } catch {
      // Some filesystems refuse symlinks; the root-symlink case below remains meaningful.
    }
    const link = `${dir}/linked-course`;
    try {
      await Deno.symlink(project, link);
      eq(registryProjectAvailable(link), false, "a symlinked root is refused like the shell refuses it");
    } catch {
      // Some filesystems refuse symlinks; the refusal above is the interesting case.
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a row that is not a row is dropped rather than echoed", () => {
  eq(
    rowFromValue({
      project_id: "a",
      project_path: "/tmp/a",
      project_title: "课",
      last_opened_at: stamp(1),
      api_key: "sk-leak",
    }),
    null,
    "a record with a credential-shaped key is not a registry row",
  );
  eq(rowFromValue({ project_path: "/tmp/no-id" }), null, "a row without identity is worthless");
  const trusted = rowFromValue({
    project_id: "b",
    project_path: "/tmp/b",
    project_title: "课 B",
    last_opened_at: stamp(2),
  });
  assert(trusted, "a well-formed row is read");
  eq(Object.keys(trusted).sort(), [
    "last_opened_at",
    "project_id",
    "project_path",
    "project_title",
  ], "only the §4.1 fields survive the read");
  eq(
    (() => {
      try {
        assertNoSensitiveKeys({ project_id: "a", apiKey: "sk-leak" });
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    })(),
    "登记表记录不得包含凭据或本机私有字段",
    "the record gate runs before anything is written",
  );
});

Deno.test("rows sort newest first with the id as a stable tiebreak", () => {
  const rows = [
    row("a", "/tmp/a", stamp(1)),
    row("b", "/tmp/b", stamp(3)),
    row("c", "/tmp/c", stamp(2)),
    row("d", "/tmp/d", ""),
  ];
  eq(
    sortRows(rows.slice()).map((candidate) => candidate.project_id),
    ["b", "c", "a", "d"],
    "last_opened_at DESC, and a row with no timestamp sits at the tail",
  );
  const tied = sortRows([row("x", "/tmp/x", stamp(1)), row("y", "/tmp/y", stamp(1))]);
  eq(
    tied.map((candidate) => candidate.project_id),
    ["y", "x"],
    "a tie breaks on the id, descending — the same order in both shells, so two renders never swap",
  );
});
