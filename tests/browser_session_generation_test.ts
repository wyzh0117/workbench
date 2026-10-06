import {
  BrowserSessionStore,
  getBrowserSessionIoMetrics,
  setBrowserSessionIoDiagnosticsEnabled,
} from "../src/service/browser_session.ts";
import { ServiceError } from "../src/service/errors.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("browser session epochs reject delayed pages and order same-page saves", async () => {
  const directory = await Deno.makeTempDir({ prefix: "browser-session-generation-" });
  try {
    const projectId = "session-generation-project";
    const earlierPage = new BrowserSessionStore(directory);
    const first = await earlierPage.open(projectId);
    assert(first.session === null && first.revision === 0);

    const sessionA = { project_id: projectId, route: "/chapter/a" };
    const firstWrite = await earlierPage.save(sessionA, projectId, {
      operation_id: "old-page-1",
      session_generation: first.session_generation,
      revision: 1,
    });
    assert(firstWrite?.outcome === "written");

    const beforeNoop = await Deno.readTextFile(earlierPage.path);
    const noOp = await earlierPage.save(sessionA, projectId, {
      operation_id: "old-page-2",
      session_generation: first.session_generation,
      revision: 2,
    });
    const afterNoop = await Deno.readTextFile(earlierPage.path);
    assert(noOp?.outcome === "unchanged");
    assert(beforeNoop === afterNoop, "same-value save should leave persisted envelope untouched");

    let staleRevision: unknown;
    try {
      await earlierPage.save(
        { project_id: projectId, route: "/chapter/old" },
        projectId,
        {
          operation_id: "old-page-late",
          session_generation: first.session_generation,
          revision: 1,
        },
      );
    } catch (caught) {
      staleRevision = caught;
    }
    assert(staleRevision instanceof ServiceError);
    assert(staleRevision.error.code === "browser_session_stale");
    assert(staleRevision.error.details.commit_state === "not_committed");

    // A second store instance models a later process/page sharing the advisory
    // lock and the same sidecar path; its explicit open invalidates old writes.
    const laterPage = new BrowserSessionStore(directory);
    const second = await laterPage.open(projectId);
    assert(second.session_generation > first.session_generation);
    assert(second.session?.route === "/chapter/a");
    const sessionB = { project_id: projectId, route: "/chapter/b" };
    const currentWrite = await laterPage.save(sessionB, projectId, {
      operation_id: "new-page-1",
      session_generation: second.session_generation,
      revision: 1,
    });
    assert(currentWrite?.outcome === "written");

    let staleEpoch: unknown;
    try {
      await earlierPage.save(
        { project_id: projectId, route: "/chapter/rollback" },
        projectId,
        {
          operation_id: "old-page-after-bootstrap",
          session_generation: first.session_generation,
          revision: 3,
        },
      );
    } catch (caught) {
      staleEpoch = caught;
    }
    assert(staleEpoch instanceof ServiceError);
    assert(staleEpoch.error.code === "browser_session_stale");
    assert((await laterPage.load(projectId))?.route === "/chapter/b");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("browser session same-value save performs zero envelope data-file writes", async () => {
  const directory = await Deno.makeTempDir({ prefix: "browser-session-io-" });
  const projectId = "session-io-project";
  const store = new BrowserSessionStore(directory);
  try {
    const unmeasured = await store.open(projectId);
    const saved = { project_id: projectId, route: "/chapter/a" };
    await store.save(saved, projectId, {
      operation_id: "unmeasured-save",
      session_generation: unmeasured.session_generation,
      revision: 1,
    });
    const disabled = getBrowserSessionIoMetrics();
    assert(
      disabled.envelope_temp_write_operations === 0 &&
        disabled.envelope_atomic_replacements === 0,
      "session write diagnostics must stay off by default",
    );

    setBrowserSessionIoDiagnosticsEnabled(true);
    const cursor = await store.open(projectId);
    const afterOpen = getBrowserSessionIoMetrics();
    const unchanged = await store.save(cursor.session, projectId, {
      operation_id: "same-value-noop",
      session_generation: cursor.session_generation,
      revision: 1,
    });
    const afterNoop = getBrowserSessionIoMetrics();
    assert(unchanged?.outcome === "unchanged");
    assert(
      afterNoop.envelope_temp_write_operations === afterOpen.envelope_temp_write_operations &&
        afterNoop.envelope_atomic_replacements === afterOpen.envelope_atomic_replacements,
      "an unchanged session save must not stage or replace the data file",
    );

    const changed = await store.save(
      { project_id: projectId, route: "/chapter/b" },
      projectId,
      {
        operation_id: "changed-save",
        session_generation: cursor.session_generation,
        revision: 2,
      },
    );
    const afterChange = getBrowserSessionIoMetrics();
    assert(changed?.outcome === "written");
    assert(
      afterChange.envelope_temp_write_operations === afterNoop.envelope_temp_write_operations + 1 &&
        afterChange.envelope_atomic_replacements === afterNoop.envelope_atomic_replacements + 1 &&
        afterChange.envelope_temp_write_bytes > afterNoop.envelope_temp_write_bytes,
      "a changed session save should count its actual staged bytes and replacement",
    );
  } finally {
    setBrowserSessionIoDiagnosticsEnabled(false);
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});
