import {
  assertProjectPath,
  AuditLog,
  auditMetadata,
  authorizeBridgeRequest,
  CommandBus,
  type CommandContext,
  createBridgePolicy,
  createEmptyProjectData,
  DesktopService,
  EventBus,
  exportProjectJson,
  JobManager,
  loadProject,
  MemorySecretStore,
  ProjectDirectoryStore,
  QueryBus,
  sanitizeAIOutput,
  ServiceError,
} from "../src/domain/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("high-level command bus rejects raw bridge operations and isolates handler failures", async () => {
  const context: CommandContext = {
    project: null,
    eventBus: new EventBus(),
    audit: new AuditLog(),
    source: "user",
  };
  const bus = new CommandBus(context);
  let called = false;
  bus.register("project.open", () => {
    called = true;
    throw new Error("internal details");
  });
  const failed = await bus.execute("project.open", { project_id: "p1" });
  assert(
    called && failed.error?.code === "command_failed",
    "handler failure must become structured error",
  );
  const forbidden = await bus.execute("fs.read", {});
  assert(
    forbidden.error?.code === "command_not_allowed",
    "raw fs command must not cross bridge",
  );

  const narrowed = new CommandBus(
    context,
    ["fs.read"] as unknown as readonly string[],
  );
  assert(
    (await narrowed.execute("fs.read", {})).error?.code ===
      "command_not_allowed",
    "runtime command allowlists must not widen to raw fs operations",
  );
  const queries = new QueryBus(context);
  let mixed = false;
  try {
    await queries.execute("project.save", {});
  } catch (caught) {
    mixed = caught instanceof ServiceError &&
      caught.error.code === "command_not_allowed";
  }
  assert(mixed, "query bus must reject command names");
});

Deno.test("desktop save accepts the bridge project envelope", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-desktop-save-" });
  const desktop = new DesktopService(directory, {
    app_instance_id: "desktop-save-test",
  });
  await desktop.open();
  const created = await desktop.commands.execute("project.create", {
    title: "桥接课程",
  });
  assert(!created.error, "project.create should succeed");
  const project = created.value as ReturnType<typeof createEmptyProjectData>;
  project.project.title = "桥接课程已修改";
  const saved = await desktop.commands.execute("project.save", { project });
  assert(!saved.error, "wrapped project.save should succeed");
  const loaded = await desktop.queries.execute("project.get");
  assert(
    (loaded as typeof project)?.project.title === "桥接课程已修改",
    "wrapped save must update the canonical project",
  );
  await desktop.close();
});

Deno.test("domain, derived and UI event channels stay separate", async () => {
  const bus = new EventBus();
  let domains = 0;
  let derived = 0;
  let notifications = 0;
  bus.onDomain(() => {
    domains += 1;
  });
  bus.onDerived(() => {
    derived += 1;
  });
  bus.onUI(() => {
    notifications += 1;
  });
  const event = EventBus.domainEvent({
    type: "ProjectChanged",
    project_id: "p",
    entity_type: "project",
    entity_id: "p",
    source: "user",
    metadata: {},
  });
  await bus.emitDomain(event);
  await bus.emitDerived(
    EventBus.derivedUpdate({
      kind: "summary",
      project_id: "p",
      source_event_id: event.id,
      payload: {},
    }),
  );
  await bus.notify(
    EventBus.notification({
      level: "success",
      message: "已保存",
      source_event_id: event.id,
    }),
  );
  assert(
    domains === 1 && derived === 1 && notifications === 1,
    "channels should be independent",
  );
});

Deno.test("same-type domain event recursion is suppressed", async () => {
  const bus = new EventBus();
  let calls = 0;
  const event = EventBus.domainEvent({
    type: "ProjectChanged",
    project_id: "p",
    entity_type: "project",
    entity_id: "p",
    source: "user",
    metadata: {},
  });
  bus.onDomain(async () => {
    calls += 1;
    await bus.emitDomain(event);
  });
  await bus.emitDomain(event);
  assert(
    calls === 1,
    "a same-type consumer loop must stop at the domain boundary",
  );
});

Deno.test("job can be cancelled and reports status", async () => {
  const manager = new JobManager();
  const handle = manager.start("测试任务", async (job) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    job.throwIfCancelled();
    return "done";
  });
  assert(handle.cancel(), "queued job should cancel");
  const result = await handle.promise;
  assert(result.status === "cancelled", "cancelled job must not complete");
  const internal = manager as unknown as { controllers: Map<string, unknown> };
  assert(
    internal.controllers.size === 0,
    "cancelled queued jobs must release their controller",
  );
});

Deno.test("project storage uses recovery journal, lock and persistent snapshots", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-service-" });
  const data = createEmptyProjectData("服务测试");
  const store = new ProjectDirectoryStore(directory, {
    app_instance_id: "test-a",
    heartbeat_ms: 50,
  });
  await store.open();
  await store.writeProject(data);
  const loaded = await store.readProject();
  assert(loaded.project.title === "服务测试", "project should round-trip");
  await store.saveWithRecovery(data);
  assert(
    (await store.readRecoveryJournal()) === null,
    "journal clears after successful commit",
  );
  const snapshot = await store.createSnapshot(data, "节点", "测试");
  assert(snapshot.name === "节点", "snapshot metadata should persist");
  const restored = await store.restoreSnapshot(data, snapshot.id);
  assert(
    restored.backup.name === "恢复前备份" &&
      restored.project.project.id === data.project.id &&
      restored.project.snapshots[0]?.id === restored.backup.id,
    "restore creates a backup",
  );
  await store.close();

  const second = new ProjectDirectoryStore(directory, {
    app_instance_id: "test-b",
  });
  await second.open();
  await second.close();
});

Deno.test("active project lock blocks a second editor", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-lock-" });
  const first = new ProjectDirectoryStore(directory, {
    app_instance_id: "first",
  });
  const second = new ProjectDirectoryStore(directory, {
    app_instance_id: "second",
  });
  await first.open();
  let blocked = false;
  try {
    await second.open();
  } catch (caught) {
    blocked = caught instanceof ServiceError &&
      caught.error.code === "project_locked";
  }
  assert(blocked, "second editor must not silently write");
  await first.close();
});

Deno.test("writable storage APIs require an owned project lock", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-lock-required-" });
  const unopened = new ProjectDirectoryStore(directory);
  let denied = false;
  try {
    await unopened.writeProject(createEmptyProjectData());
  } catch (caught) {
    denied = caught instanceof ServiceError &&
      caught.error.code === "project_not_open";
  }
  assert(denied, "writes must not bypass the project lock");
  assert(
    !(await Deno.stat(`${directory}/.workspace/project.lock.guard`).catch(() => null)),
    "an unopened write must not create a lock guard",
  );
});

Deno.test("project file paths reject traversal before filesystem access", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-path-" });
  const store = new ProjectDirectoryStore(directory, {
    app_instance_id: "path-check",
  });
  await store.open();
  let denied = false;
  try {
    await store.moveToTrash("../outside");
  } catch (caught) {
    denied = caught instanceof ServiceError &&
      caught.error.code === "invalid_project_path";
  }
  assert(denied, "relative project paths must reject parent traversal");
  await store.close();
});

Deno.test("project file paths reject symlink escapes", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-symlink-" });
  const outside = await Deno.makeTempDir({ prefix: "acw-outside-" });
  await Deno.symlink(outside, `${directory}/assets`);
  const store = new ProjectDirectoryStore(directory, {
    app_instance_id: "symlink-check",
  });
  await store.open();
  let denied = false;
  try {
    await store.moveToTrash("assets/secret.txt");
  } catch (caught) {
    denied = caught instanceof ServiceError &&
      caught.error.code === "invalid_project_path";
  }
  assert(denied, "symlinked project paths must not escape the project root");
  await store.close();
});

Deno.test("project root symlinks are rejected", async () => {
  const outside = await Deno.makeTempDir({ prefix: "acw-root-outside-" });
  const link = `${await Deno.makeTempDir({
    prefix: "acw-root-link-",
  })}/project`;
  await Deno.symlink(outside, link);
  const store = new ProjectDirectoryStore(link, {
    app_instance_id: "symlink-root-check",
  });
  let denied = false;
  try {
    await store.open();
  } catch (caught) {
    denied = caught instanceof ServiceError &&
      caught.error.code === "invalid_project_path";
  }
  assert(denied, "the selected project root must not be a symlink");
});

Deno.test("permission path checks reject symlink escapes", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-policy-root-" });
  const outside = await Deno.makeTempDir({ prefix: "acw-policy-outside-" });
  await Deno.symlink(outside, `${root}/link`);
  let denied = false;
  try {
    assertProjectPath(
      { project_root: root, capabilities: new Set(["read"]) },
      `${root}/link/file.txt`,
    );
  } catch (caught) {
    denied = caught instanceof ServiceError &&
      caught.error.code === "path_outside_project";
  }
  assert(denied, "permission path checks must reject symlink escapes");
});

Deno.test("permission path checks reject a symlink project root", async () => {
  const outside = await Deno.makeTempDir({
    prefix: "acw-policy-root-outside-",
  });
  const link = `${await Deno.makeTempDir({
    prefix: "acw-policy-root-link-",
  })}/project`;
  await Deno.symlink(outside, link);
  let denied = false;
  try {
    assertProjectPath(
      { project_root: link, capabilities: new Set(["read"]) },
      `${link}/file.txt`,
    );
  } catch (caught) {
    denied = caught instanceof ServiceError &&
      caught.error.code === "path_outside_project";
  }
  assert(denied, "permission checks must reject a symlink project root");
});

Deno.test("stale takeover cannot be overwritten by the old heartbeat", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-stale-lock-" });
  const first = new ProjectDirectoryStore(directory, {
    app_instance_id: "first",
    stale_after_ms: 1,
    heartbeat_ms: 60_000,
  });
  await first.open();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = new ProjectDirectoryStore(directory, {
    app_instance_id: "second",
    force_takeover: true,
    heartbeat_ms: 60_000,
  });
  await second.open();
  await first.heartbeat();
  assert(
    (await second.inspectLock()).lock?.app_instance_id === "second",
    "old heartbeat must not clobber a takeover lock",
  );
  await second.close();
  await first.close();
});

Deno.test("malformed stale locks remain recoverable", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-malformed-lock-" });
  await Deno.mkdir(`${directory}/.workspace`, { recursive: true });
  await Deno.writeTextFile(`${directory}/.workspace/project.lock`, "partial");
  const store = new ProjectDirectoryStore(directory, {
    app_instance_id: "recovered",
    stale_after_ms: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.open();
  assert(
    (await store.inspectLock()).lock?.app_instance_id === "recovered",
    "stale malformed lock should be replaceable",
  );
  await store.close();
});

Deno.test("fresh malformed locks remain protected and invalid heartbeat uses mtime", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-malformed-fresh-" });
  await Deno.mkdir(`${directory}/.workspace`, { recursive: true });
  const lockPath = `${directory}/.workspace/project.lock`;
  await Deno.writeTextFile(lockPath, "partial");
  const fresh = new ProjectDirectoryStore(directory, {
    app_instance_id: "blocked-fresh",
    stale_after_ms: 30_000,
  });
  assert(!(await fresh.inspectLock()).stale, "fresh malformed lock must use mtime");
  let blocked = false;
  try {
    await fresh.open();
  } catch (caught) {
    blocked = caught instanceof ServiceError && caught.error.code === "project_locked";
  }
  assert(blocked, "fresh malformed lock must block takeover");
  await Deno.writeTextFile(
    lockPath,
    JSON.stringify({
      app_instance_id: "invalid-heartbeat",
      pid: 1,
      host: "test",
      opened_at: "2026-01-01T00:00:00.000Z",
      heartbeat: "99999-99-99T99:99:99.999Z",
    }),
  );
  assert(
    !(await fresh.inspectLock()).stale,
    "invalid heartbeat must fall back to fresh lock mtime",
  );
  assert(
    !fresh.isLockStale({
      app_instance_id: "invalid-date",
      pid: 1,
      host: "test",
      opened_at: "2026-02-28T00:00:00.000Z",
      heartbeat: "2026-02-31T00:00:00.000Z",
    }, 1_000, 1_000),
    "impossible calendar dates must be treated as malformed and use mtime",
  );
  for (const heartbeat of [
    " 2026-03-01T00:00:00.000Z ",
    "1969-12-31T23:59:59.999Z",
    "2026-3-01T00:00:00.000Z",
    "2026-03-01T0:00:00.000Z",
  ]) {
    assert(
      !fresh.isLockStale({
        app_instance_id: "strict-heartbeat",
        pid: 1,
        host: "test",
        opened_at: "2026-03-01T00:00:00.000Z",
        heartbeat,
      }, 1_000, 1_000),
      `strict heartbeat parser must treat ${heartbeat} as fresh/malformed via mtime`,
    );
  }
  const trimmedAt = Date.parse("2026-03-01T00:00:00.000Z") + 30_001;
  assert(
    fresh.isLockStale({
      app_instance_id: "trimmed-heartbeat",
      pid: 1,
      host: "test",
      opened_at: "2026-03-01T00:00:00.000Z",
      heartbeat: " 2026-03-01T00:00:00.000Z ",
    }, trimmedAt, trimmedAt),
    "trimmed heartbeat must be parsed instead of falling back to fresh mtime",
  );
});

Deno.test("failed migration keeps the original canonical file", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-migration-failure-",
  });
  const original = JSON.stringify({ project: null, marker: "keep-me" });
  await Deno.writeTextFile(`${directory}/project.json`, original);
  const store = new ProjectDirectoryStore(directory, {
    app_instance_id: "migrator",
  });
  let failed = false;
  try {
    await store.open();
  } catch {
    failed = true;
  }
  assert(failed, "invalid project migration must fail");
  assert(
    await Deno.readTextFile(`${directory}/project.json`) === original,
    "migration failure must preserve the source file",
  );
});

Deno.test("read-only storage never leaves a snapshot side effect", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-read-only-" });
  const writable = new ProjectDirectoryStore(directory, {
    app_instance_id: "writer",
  });
  const data = createEmptyProjectData("只读测试");
  await writable.open();
  await writable.writeProject(data);
  await writable.close();
  const readOnly = new ProjectDirectoryStore(directory, { read_only: true });
  await readOnly.open();
  let denied = false;
  try {
    await readOnly.createSnapshot(data, "不应写入");
  } catch (caught) {
    denied = caught instanceof ServiceError &&
      caught.error.code === "read_only_project";
  }
  assert(denied, "read-only snapshot must be rejected");
  let snapshotFiles = 0;
  try {
    for await (
      const _entry of Deno.readDir(`${directory}/.workspace/snapshots`)
    ) snapshotFiles += 1;
  } catch (caught) {
    if (!(caught instanceof Deno.errors.NotFound)) throw caught;
  }
  assert(
    snapshotFiles === 0,
    "read-only snapshot rejection must not create files",
  );
  await readOnly.close();
});

Deno.test("rejected credentials never enter the recovery journal", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-journal-secret-" });
  const store = new ProjectDirectoryStore(directory, {
    app_instance_id: "writer",
  });
  await store.open();
  const data = createEmptyProjectData();
  data.project.settings.api_key = "must-not-journal";
  let rejected = false;
  try {
    await store.saveWithRecovery(data);
  } catch {
    rejected = true;
  }
  assert(rejected, "credential-bearing project must be rejected");
  assert(
    (await store.readRecoveryJournal()) === null,
    "failed save must not leave credentials in recovery.json",
  );
  await Deno.writeTextFile(
    store.journalPath,
    JSON.stringify({ project: data }),
  );
  let unreadable = false;
  try {
    await store.readRecoveryJournal();
  } catch {
    unreadable = true;
  }
  assert(
    unreadable,
    "pre-existing secret-bearing recovery journals must not be loaded",
  );
  await store.close();
});

Deno.test("secret-bearing canonical files are rejected on load", async () => {
  const file = await Deno.makeTempFile({
    prefix: "acw-load-secret-",
    suffix: ".json",
  });
  const data = createEmptyProjectData();
  data.project.settings.my_api_key = "must-not-load";
  await Deno.writeTextFile(file, JSON.stringify(data));
  let rejected = false;
  try {
    await loadProject(file);
  } catch {
    rejected = true;
  }
  assert(rejected, "loadProject must not expose secret-bearing canonical data");
  await Deno.remove(file);
});

Deno.test("secrets, unsafe HTML and export-only sensitive fields are excluded", async () => {
  const secrets = new MemorySecretStore();
  await secrets.set("openai", "do-not-log");
  const data = createEmptyProjectData();
  (data.project.settings as Record<string, unknown>).api_key = "do-not-export";
  const exported = exportProjectJson(data);
  assert(
    !exported.includes("do-not-export") && !exported.includes("do-not-log"),
    "secrets must not enter export",
  );
  const safe = sanitizeAIOutput(
    '<p onclick="evil()">ok</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>',
  );
  assert(
    !safe.includes("script") && !safe.includes("onclick") &&
      !safe.includes("javascript:"),
    "unsafe AI markup must be sanitized",
  );
  const encoded = sanitizeAIOutput(
    '<a href="javas&#x63;ript:alert(1)">x</a><a href="java&NewLine;script:alert(1)">y</a><img srcset="javascript:alert(1)">',
  );
  assert(
    !encoded.includes("javascript") && !encoded.includes('srcset="javascript'),
    "encoded dangerous URLs must be sanitized",
  );
  const localOnly = exportProjectJson(
    {
      userPreferences: { theme: "dark" },
      private_cache: { body: "secret" },
      "my.api.key": "also-secret",
      style_tokens: { primary: "#fff" },
    } as never,
  );
  assert(
    !localOnly.includes("userPreferences") &&
      !localOnly.includes("private_cache") &&
      !localOnly.includes("also-secret") && localOnly.includes("style_tokens"),
    "local-only export fields must be excluded",
  );
  const policy = createBridgePolicy({
    allowed_origins: ["https://example.test"],
  });
  authorizeBridgeRequest(policy, {
    token: policy.token,
    origin: "https://example.test",
    action: "health",
  });
  let denied = false;
  try {
    authorizeBridgeRequest(policy, {
      token: "wrong",
      origin: "https://example.test",
      action: "health",
    });
  } catch {
    denied = true;
  }
  assert(denied, "bridge token must be required");
  const unknownActionPolicy = createBridgePolicy({
    allowed_origins: ["https://example.test"],
    allowed_actions: ["fs.read"],
  });
  let actionDenied = false;
  try {
    authorizeBridgeRequest(unknownActionPolicy, {
      token: unknownActionPolicy.token,
      origin: "https://example.test",
      action: "fs.read",
    });
  } catch {
    actionDenied = true;
  }
  assert(
    actionDenied,
    "bridge policy must not allow actions outside the protocol",
  );
  const audited = auditMetadata({
    message: "provider api_key=do-not-log",
    safe: "ok",
  });
  assert(
    !JSON.stringify(audited).includes("do-not-log") && audited.safe === "ok",
    "audit metadata must redact inline credentials",
  );
});
