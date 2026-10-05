import { createEmptyProjectData } from "../src/domain/store.ts";
import { DesktopService } from "../src/service/desktop.ts";
import {
  fileFingerprint,
  ProjectDirectoryStore,
} from "../src/service/storage.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("project.read_state returns the canonical fingerprint without opening or writing", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-read-state-" });
  const store = new ProjectDirectoryStore(directory);
  try {
    const project = createEmptyProjectData("Pure read");
    await Deno.writeTextFile(
      `${directory}/project.json`,
      JSON.stringify(project, null, 2),
    );
    const expected = await fileFingerprint(`${directory}/project.json`);
    const state = await store.readProjectSnapshot();
    const internal = store as unknown as { baseline: unknown; lock: unknown };
    assert(
      state.project?.project.id === project.project.id,
      "canonical id should be returned",
    );
    assert(
      state.fingerprint.hash === expected.hash,
      "content fingerprint should match canonical bytes",
    );
    assert(
      internal.baseline === null && internal.lock === null,
      "pure read must not adopt a save baseline or lease",
    );
    assert(
      !(await exists(`${directory}/.workspace`)),
      "pure read must not create workspace metadata",
    );

    const emptyDirectory = `${directory}/empty`;
    await Deno.mkdir(emptyDirectory);
    const emptyStore = new ProjectDirectoryStore(emptyDirectory);
    const missing = await emptyStore.readProjectSnapshot();
    assert(
      missing.project === null && !missing.fingerprint.exists,
      "missing canonical state should be reported without creating it",
    );
    assert(
      !(await exists(`${emptyDirectory}/.workspace`)),
      "missing-state read must stay read-only",
    );
    const desktop = new DesktopService(emptyDirectory);
    try {
      const command = await desktop.commands.execute("project.read_state");
      const value = command.value as {
        project?: unknown;
        project_id?: unknown;
      };
      assert(
        !command.error && value.project === null && value.project_id === null,
        "bridge read_state should return a missing snapshot without opening the project",
      );
      assert(
        !(await exists(`${emptyDirectory}/.workspace`)),
        "bridge read_state must not create workspace metadata",
      );
    } finally {
      await desktop.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (caught) {
    if (caught instanceof Deno.errors.NotFound) return false;
    throw caught;
  }
}
