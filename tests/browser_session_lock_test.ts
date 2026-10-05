import { BrowserSessionStore } from "../src/service/browser_session.ts";
import { DesktopService } from "../src/service/desktop.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const PROJECT_ID = "browser-session-lock-check";

Deno.test("browser session reads and writes do not adopt external Canonical state", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-session-pure-read-",
  });
  const desktop = new DesktopService(directory, {
    app_instance_id: `session-pure-${crypto.randomUUID()}`,
  });
  try {
    await desktop.open();
    const created = await desktop.commands.execute("project.create", {
      title: "Reader state remains outside Canonical",
    });
    assert(!created.error, "fixture project must be created");
    const opened = await desktop.commands.execute("project.open_state", {});
    assert(!opened.error, "fixture project must open with its active lease");
    const projectId = (opened.value as { project_id: string }).project_id;
    const store = desktop.store as unknown as { baseline: unknown };
    const baselineBefore = structuredClone(store.baseline);

    const projectPath = `${directory}/project.json`;
    const externalProject = JSON.parse(await Deno.readTextFile(projectPath));
    externalProject.project.description =
      "External edit held for conflict detection";
    await Deno.writeTextFile(projectPath, JSON.stringify(externalProject));
    const externalCanonical = await Deno.readTextFile(projectPath);

    const session = { project_id: projectId, mode: "preview", route: "editor" };
    await desktop.saveBrowserSession(session);
    assert(
      (await desktop.loadBrowserSession())?.route === "editor",
      "reader session must still round-trip",
    );

    assert(
      JSON.stringify(store.baseline) === JSON.stringify(baselineBefore),
      "browser session load/save must not adopt a newer disk fingerprint into the active Canonical baseline",
    );
    assert(
      await Deno.readTextFile(projectPath) === externalCanonical,
      "browser session load/save must not write Canonical project bytes",
    );
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("browser session identical serialization performs no sidecar replacement", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-session-noop-" });
  const store = new BrowserSessionStore(directory);
  const session = { project_id: PROJECT_ID, mode: "preview", route: "editor" };
  try {
    await store.save(session, PROJECT_ID);
    const before = await Deno.lstat(store.path);
    const beforeContents = await Deno.readFile(store.path);

    await store.save(session, PROJECT_ID);

    const after = await Deno.lstat(store.path);
    const afterContents = await Deno.readFile(store.path);
    assert(
      before.ino === after.ino,
      "same serialized session must keep the same sidecar inode",
    );
    assert(
      before.mtime?.getTime() === after.mtime?.getTime(),
      "same serialized session must not rewrite sidecar bytes",
    );
    assert(
      beforeContents.length === afterContents.length &&
        beforeContents.every((byte, index) => byte === afterContents[index]),
      "same serialized session must preserve exact sidecar bytes",
    );
    assert(
      (await Array.fromAsync(Deno.readDir(directory + "/.workspace"))).filter((
        entry,
      ) => entry.name.includes(".tmp-")).length === 0,
      "no-op save must not leave a temporary file",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("browser session save waits for a lock held by another Deno process", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-session-lock-" });
  const store = new BrowserSessionStore(directory);
  const lockPath = `${store.path}.lock`;
  const markerPath = `${directory}/child-started`;
  const childPath = `${directory}/session-lock-child.ts`;
  await Deno.mkdir(`${directory}/.workspace`);
  const held = await Deno.open(lockPath, {
    create: true,
    read: true,
    write: true,
  });
  let child: Deno.ChildProcess | null = null;
  try {
    await held.lock(true);
    const moduleUrl = import.meta.resolve("../src/service/browser_session.ts");
    const childSource = [
      `import { BrowserSessionStore } from ${JSON.stringify(moduleUrl)};`,
      `await Deno.writeTextFile(${JSON.stringify(markerPath)}, "started");`,
      `await new BrowserSessionStore(${
        JSON.stringify(directory)
      }).save({project_id:${
        JSON.stringify(PROJECT_ID)
      },mode:"preview",route:"child"}, ${JSON.stringify(PROJECT_ID)});`,
    ].join("\n");
    await Deno.writeTextFile(childPath, childSource);
    child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-read", "--allow-write", childPath],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        await Deno.stat(markerPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await Deno.stat(markerPath);
    const earlyExit = await Promise.race([
      child.status,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    assert(
      earlyExit === null,
      "a second process must wait while the exclusive session lock is held",
    );
    await held.unlock();
    const output = await child.output();
    assert(
      output.success,
      `child session save must finish after unlock: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
    child = null;
    assert(
      (await store.load(PROJECT_ID))?.route === "child",
      "the child process must persist its session after acquiring the lock",
    );
  } finally {
    await held.unlock().catch(() => undefined);
    held.close();
    if (child) {
      const output = await child.output();
      assert(
        output.success,
        `child session save must finish after unlock: ${
          new TextDecoder().decode(output.stderr)
        }`,
      );
    }
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("browser session load waits for a lock held by another Deno process", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-session-read-lock-",
  });
  const store = new BrowserSessionStore(directory);
  const session = { project_id: PROJECT_ID, mode: "preview", route: "editor" };
  const lockPath = `${store.path}.lock`;
  const markerPath = `${directory}/child-locked`;
  const releasePath = `${directory}/release-child`;
  const childPath = `${directory}/session-read-lock-child.ts`;
  let child: Deno.ChildProcess | null = null;
  try {
    await store.save(session, PROJECT_ID);
    const lockFile = await Deno.open(lockPath, {
      create: true,
      read: true,
      write: true,
    });
    lockFile.close();
    const childSource = [
      `const file = await Deno.open(${
        JSON.stringify(lockPath)
      }, {read:true,write:true});`,
      `await file.lock(true);`,
      `await Deno.writeTextFile(${JSON.stringify(markerPath)}, "locked");`,
      `while (true) { try { await Deno.stat(${
        JSON.stringify(releasePath)
      }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }`,
      `await file.unlock(); file.close();`,
    ].join("\n");
    await Deno.writeTextFile(childPath, childSource);
    child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-read", "--allow-write", childPath],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        await Deno.stat(markerPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await Deno.stat(markerPath);
    let loaded = false;
    const loading = store.load(PROJECT_ID).then((value) => {
      loaded = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(
      !loaded,
      "a read must wait while another process holds the exclusive session lock",
    );

    await Deno.writeTextFile(releasePath, "release");
    const output = await child.output();
    assert(
      output.success,
      `child lock must release cleanly: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
    child = null;
    assert(
      (await loading)?.route === "editor",
      "the read must finish with the persisted session after unlock",
    );
  } finally {
    await Deno.writeTextFile(releasePath, "release").catch(() => undefined);
    if (child) {
      await child.output();
    }
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
