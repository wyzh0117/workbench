import {
  createPersistenceScheduler,
  normalizeProjectDir,
} from "../app/persistence.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimeout(callback: () => void, delay: number) {
      const id = nextId++;
      tasks.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id: number) {
      tasks.delete(id);
    },
    tick(ms: number) {
      const target = now + ms;
      while (true) {
        const next = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!next) break;
        now = next[1].at;
        tasks.delete(next[0]);
        next[1].callback();
      }
      now = target;
    },
  };
}

function request(revision: number, projectDir = "/tmp/course/") {
  return {
    project_dir: projectDir,
    expected_project_id: "project-1",
    editor_generation: 4,
    lease_generation: "lease-9",
    operation_id: `save-${revision}`,
    revision,
    expected_fingerprint: { exists: true, hash: "before" },
    project: { project: { id: "project-1" }, revision },
    recovery_metadata: { canonical_revision: revision },
  };
}

function saved(value: ReturnType<typeof request>, hash: string) {
  return {
    project_id: value.expected_project_id,
    lease_generation: value.lease_generation,
    editor_generation: value.editor_generation,
    operation_id: value.operation_id,
    revision: value.revision,
    outcome: "written",
    fingerprint: { exists: true, hash },
  };
}

Deno.test("save scheduler coalesces cumulative revisions and advances the bound fingerprint", async () => {
  const timers = fakeTimers();
  const firstGate = deferred<ReturnType<typeof saved>>();
  const written: number[] = [];
  const expectedFingerprints: string[] = [];
  let dirtyRevision = 1;
  let dirty = true;
  const scheduler = createPersistenceScheduler({
    debounceMs: 350,
    maxWaitMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    write: async (value: ReturnType<typeof request>) => {
      written.push(value.revision);
      expectedFingerprints.push(value.expected_fingerprint.hash);
      if (value.revision === 1) return await firstGate.promise;
      return saved(value, `after-${value.revision}`);
    },
    onResult: (_result: unknown, value: ReturnType<typeof request>) => {
      if (value.revision === dirtyRevision) dirty = false;
      else dirty = true;
    },
  });

  const first = scheduler.enqueue(request(1));
  timers.tick(350);
  await Promise.resolve();
  dirtyRevision = 3;
  const second = scheduler.enqueue(request(2));
  const third = scheduler.enqueue(request(3));
  timers.tick(350);
  assert(written.join(",") === "1", "r2 and r3 should wait behind the active write");
  assert(dirty, "an older save acknowledgement must not clear a newer dirty revision");

  const drained = scheduler.flush();
  firstGate.resolve(saved(request(1), "after-1"));
  await drained;
  await Promise.all([first, second, third]);
  assert(written.join(",") === "1,3", "r2 should coalesce into the latest cumulative r3 snapshot");
  assert(expectedFingerprints.join(",") === "before,after-1", "r3 must compare against the acknowledged r1 fingerprint");
  assert(!dirty, "the acknowledgement for the latest cumulative revision should clear dirty state");
});

Deno.test("later cumulative snapshots advance CAS through r1, r3, and r5", async () => {
  const timers = fakeTimers();
  const firstGate = deferred<ReturnType<typeof saved>>();
  const thirdGate = deferred<ReturnType<typeof saved>>();
  const thirdStarted = deferred<void>();
  const writes: number[] = [];
  const expectedFingerprints: string[] = [];
  const scheduler = createPersistenceScheduler({
    debounceMs: 350,
    maxWaitMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    write: async (value: ReturnType<typeof request>) => {
      writes.push(value.revision);
      expectedFingerprints.push(value.expected_fingerprint.hash);
      if (value.revision === 1) return await firstGate.promise;
      if (value.revision === 3) {
        thirdStarted.resolve();
        return await thirdGate.promise;
      }
      return saved(value, `after-${value.revision}`);
    },
  });

  const first = scheduler.enqueue(request(1));
  timers.tick(350);
  await Promise.resolve();
  const third = scheduler.enqueue(request(3));
  timers.tick(350);
  const draining = scheduler.flush();
  firstGate.resolve(saved(request(1), "after-1"));
  await thirdStarted.promise;
  assert(writes.join(",") === "1,3", "r3 should start after r1 acknowledges");
  const fifth = scheduler.enqueue(request(5));
  timers.tick(350);
  thirdGate.resolve(saved(request(3), "after-3"));
  await draining;
  await Promise.all([first, third, fifth]);
  assert(writes.join(",") === "1,3,5", "the latest pending cumulative revision should be written once");
  assert(expectedFingerprints.join(",") === "before,after-1,after-3", "stale F0 requests must chain from each prior acknowledged fingerprint");
});

Deno.test("save scheduler has a trailing 350ms delay and a 2s maximum wait", async () => {
  const timers = fakeTimers();
  const written: number[] = [];
  const scheduler = createPersistenceScheduler({
    debounceMs: 350,
    maxWaitMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    write: async (value: ReturnType<typeof request>) => {
      written.push(value.revision);
      return saved(value, `after-${value.revision}`);
    },
  });

  scheduler.enqueue(request(1));
  for (let revision = 2; revision <= 7; revision++) {
    timers.tick(300);
    scheduler.enqueue(request(revision));
  }
  timers.tick(200);
  assert(written.length === 0, "the trailing timer should reset while edits continue");
  await scheduler.flush();
  assert(written.join(",") === "7", "maximum wait should commit the newest cumulative snapshot");
});

Deno.test("late save results cannot update a newer editor generation", async () => {
  const timers = fakeTimers();
  const gate = deferred<ReturnType<typeof saved>>();
  const original = request(1);
  let applied = 0;
  const scheduler = createPersistenceScheduler({
    debounceMs: 350,
    maxWaitMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    write: () => gate.promise,
    onResult: () => applied++,
  });
  scheduler.enqueue(original);
  timers.tick(350);
  await Promise.resolve();
  scheduler.changeGeneration({
    project_dir: "/tmp/other-course",
    expected_project_id: "project-2",
    editor_generation: 5,
    lease_generation: "lease-10",
  });
  gate.resolve(saved(original, "stale"));
  await scheduler.flush();
  assert(applied === 0, "a response from the prior project/editor generation must be ignored");
});

Deno.test("A to B to A invalidates old leases and flush waits for the current generation", async () => {
  const timers = fakeTimers();
  const firstGate = deferred<ReturnType<typeof saved>>();
  const writes: string[] = [];
  const results: string[] = [];
  const scheduler = createPersistenceScheduler({
    debounceMs: 350,
    maxWaitMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    write: async (value: ReturnType<typeof request>) => {
      writes.push(`${value.expected_project_id}:${value.revision}:${value.lease_generation}`);
      if (value.revision === 1) return await firstGate.promise;
      return saved(value, "final");
    },
    onResult: (_result: unknown, value: ReturnType<typeof request>) => results.push(`${value.expected_project_id}:${value.revision}`),
  });

  const oldA = scheduler.enqueue(request(1));
  timers.tick(350);
  await Promise.resolve();
  const projectB = { ...request(2), expected_project_id: "project-b", project_dir: "/tmp/b", editor_generation: 5, lease_generation: "lease-b", project: { project: { id: "project-b" }, revision: 2 } };
  scheduler.changeGeneration(projectB);
  const pendingB = scheduler.enqueue(projectB);
  const currentA = { ...request(3), project_dir: "/tmp/course", editor_generation: 6, lease_generation: "lease-a2" };
  let blockedSwitch = false;
  try { scheduler.changeGeneration(currentA); } catch (error) { blockedSwitch = error instanceof Error && (error as Error & { code?: string }).code === "save_drain_required"; }
  assert(blockedSwitch, "a project switch must not discard pending B saves");
  const drainedB = scheduler.flush();
  firstGate.resolve(saved(request(1), "old-a"));
  await drainedB;
  await Promise.all([oldA, pendingB]);
  scheduler.changeGeneration(currentA);
  const currentAPromise = scheduler.enqueue(currentA);
  await scheduler.flush();
  await currentAPromise;
  assert(writes.join(",") === "project-1:1:lease-9,project-b:2:lease-b,project-1:3:lease-a2", "A to B to A must drain each project under its own lease");
  assert(results.join(",") === "project-b:2,project-1:3", "the stale A result is ignored after generation changes");
});

Deno.test("older revisions and mismatched bindings cannot replace the active save", async () => {
  const timers = fakeTimers();
  const written: number[] = [];
  const scheduler = createPersistenceScheduler({
    debounceMs: 350,
    maxWaitMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    write: async (value: ReturnType<typeof request>) => {
      written.push(value.revision);
      return saved(value, "after");
    },
  });
  scheduler.enqueue(request(3));
  const stale = await scheduler.enqueue(request(2));
  assert(stale.reason === "stale_revision", "late r2 cannot supersede the stored r3 request");
  let invalidRejected = false;
  try { scheduler.enqueue({ ...request(4), revision: "not-a-revision" }); } catch { invalidRejected = true; }
  assert(invalidRejected, "invalid revisions must be rejected at the scheduler trust boundary");
  const switchedLease = { ...request(4), expected_project_id: "other-project", project: { project: { id: "other-project" }, revision: 4 } };
  let bindingRejected = false;
  try { await scheduler.enqueue(switchedLease); } catch (error) { bindingRejected = error instanceof Error && (error as Error & { code?: string }).code === "save_generation_mismatch"; }
  assert(bindingRejected, "project identity changes cannot silently discard same-generation dirty work");
  await scheduler.flush();
  assert(written.join(",") === "3", "only r3 may be committed");
});

Deno.test("failed writes reject drain, callback errors do not hide storage outcome", async () => {
  const timers = fakeTimers();
  let attempts = 0;
  let errors = 0;
  const scheduler = createPersistenceScheduler({
    debounceMs: 350,
    maxWaitMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    write: async (value: ReturnType<typeof request>) => {
      attempts++;
      if (attempts === 1) return { ...saved(value, "unexpected"), operation_id: "wrong-op" };
      return saved(value, "after-retry");
    },
    onError: () => { errors++; throw new Error("UI error handler failed"); },
    onResult: () => { throw new Error("UI success handler failed"); },
  });
  const first = scheduler.enqueue(request(1));
  timers.tick(350);
  const drain = scheduler.flush();
  let requestFailed = false;
  try { await first; } catch (error) { requestFailed = error instanceof Error && (error as Error & { code?: string }).code === "save_response_binding_mismatch"; }
  let drainFailed = false;
  try { await drain; } catch { drainFailed = true; }
  assert(requestFailed && drainFailed, "response mismatch and failed drain must remain visible to the caller");
  assert(errors === 1, "the failing UI callback must be isolated from the storage result");
  let closeBlocked = false;
  try { scheduler.close(); } catch { closeBlocked = true; }
  assert(closeBlocked, "closing after an unresolved failed save must be blocked");

  const retryRequest = { ...request(2), editor_generation: 5 };
  scheduler.reconcileGeneration(retryRequest);
  const retry = scheduler.enqueue(retryRequest);
  timers.tick(350);
  await scheduler.flush();
  const retryResult = await retry;
  assert(retryResult.outcome === "written", "a later successful write must preserve its committed result even when UI callbacks throw");
  scheduler.close();
});

Deno.test("uncertain commits pause the latest pending save until explicit reconciliation", async () => {
  const timers = fakeTimers();
  const firstGate = deferred<ReturnType<typeof saved>>();
  const writes: number[] = [];
  const scheduler = createPersistenceScheduler({
    debounceMs: 350,
    maxWaitMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    write: async (value: ReturnType<typeof request>) => {
      writes.push(value.revision);
      if (value.revision === 1) return await firstGate.promise;
      return saved(value, "reconciled");
    },
  });
  const firstRequest = request(1);
  const latestRequest = request(3);
  const first = scheduler.enqueue(firstRequest);
  timers.tick(350);
  await Promise.resolve();
  const pending = scheduler.enqueue(latestRequest);
  timers.tick(350);
  const uncertain = new Error("write result uncertain") as Error & { code: string; commit_state: string };
  uncertain.code = "outcome_uncertain";
  uncertain.commit_state = "outcome_uncertain";
  firstGate.reject(uncertain);
  let failed = false;
  try { await first; } catch { failed = true; }
  assert(failed, "the in-flight request must report its uncertain outcome");
  assert(writes.join(",") === "1", "uncertain r1 must not automatically dispatch pending r3");
  let blockedDrain = false;
  try { await scheduler.flush(); } catch (error) { blockedDrain = error instanceof Error && (error as Error & { code?: string }).code === "outcome_uncertain"; }
  assert(blockedDrain, "flush must preserve the uncertain outcome until reconciliation");

  const reconciledIdentity = { ...request(4), editor_generation: 5 };
  scheduler.reconcileGeneration(reconciledIdentity);
  const discarded = await pending;
  assert(discarded.reason === "reconciled", "only explicit reconciliation may discard the old pending snapshot");
  const retryRequest = { ...request(4), editor_generation: 5 };
  const retry = scheduler.enqueue(retryRequest);
  await scheduler.flush();
  await retry;
  assert(writes.join(",") === "1,4", "a reconciled generation may continue from a fresh request");
});

Deno.test("explicit not-committed failures may advance to the latest cumulative save", async () => {
  const timers = fakeTimers();
  const firstGate = deferred<ReturnType<typeof saved>>();
  const writes: number[] = [];
  const scheduler = createPersistenceScheduler({
    debounceMs: 350,
    maxWaitMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    write: async (value: ReturnType<typeof request>) => {
      writes.push(value.revision);
      if (value.revision === 1) return await firstGate.promise;
      return saved(value, "after-r3");
    },
  });
  const firstRequest = request(1);
  const first = scheduler.enqueue(firstRequest);
  timers.tick(350);
  await Promise.resolve();
  const latest = scheduler.enqueue(request(3));
  timers.tick(350);
  const drain = scheduler.flush();
  const notCommitted = new Error("disk was not changed") as Error & { code: string; commit_state: string };
  notCommitted.code = "save_io_failed";
  notCommitted.commit_state = "not_committed";
  firstGate.reject(notCommitted);
  await first.catch(() => undefined);
  await drain;
  await latest;
  assert(writes.join(",") === "1,3", "known-not-committed failure may proceed with the latest cumulative snapshot");
});

Deno.test("save requests are cloned, revision-bound, and directory identity is normalized", async () => {
  const timers = fakeTimers();
  const received: Array<ReturnType<typeof request>> = [];
  const original = request(1);
  const scheduler = createPersistenceScheduler({
    debounceMs: 350,
    maxWaitMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    write: async (value: ReturnType<typeof request>) => {
      received.push(value);
      return saved(value, "after");
    },
  });
  scheduler.enqueue(original);
  original.project.revision = 99;
  timers.tick(350);
  await scheduler.flush();
  assert(received[0]?.project.revision === 1, "the dispatched canonical project must be an immutable snapshot");
  assert(received[0]?.operation_id === "save-1" && received[0].revision === 1, "operation and revision must stay bound");
  assert(normalizeProjectDir(" /tmp/course/// ") === "/tmp/course", "directory identity should ignore trailing separators");
});
