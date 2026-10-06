import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectData } from "../src/domain/types.ts";
import { DesktopService } from "../src/service/desktop.ts";
import { fileFingerprint } from "../src/service/storage.ts";

const args = new Map(
  Deno.args.filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, ...rest] = arg.slice(2).split("=");
    return [key!, rest.join("=")];
  }),
);
const mode = args.get("mode") ?? "candidate";
const fixturePath = resolve(
  args.get("fixture") ?? "/tmp/workbench-large-canonical-fixture.json",
);
const outputPath = resolve(
  args.get("output") ??
    `docs/reports/evidence/io-ui-closure/deno-${mode}-large.json`,
);
const iterations = Number(args.get("iterations") ?? "10");
const declaredSourceCommit = args.get("source-commit") ?? null;
if (mode !== "baseline" && mode !== "candidate") {
  throw new Error("--mode must be baseline or candidate");
}
if (!Number.isSafeInteger(iterations) || iterations < 10) {
  throw new Error("--iterations must be an integer of at least 10");
}

type FileIoTarget = {
  read_operations: number;
  read_bytes: number;
  write_operations: number;
  write_bytes: number;
  sync_attempts: number;
  sync_successes: number;
  rename_in: number;
  rename_out: number;
  removes: number;
};
type FileIoCounters = {
  by_target: Record<string, FileIoTarget>;
  open_operations: number;
  close_operations: number;
  peak_open_handles: number;
  read_file_operations: number;
  read_file_bytes: number;
  read_text_file_operations: number;
  read_text_file_bytes: number;
  write_file_operations: number;
  write_file_bytes: number;
  write_text_file_operations: number;
  write_text_file_bytes: number;
  rename_operations: number;
  remove_operations: number;
};

function emptyCounters(): FileIoCounters {
  return {
    by_target: {},
    open_operations: 0,
    close_operations: 0,
    peak_open_handles: 0,
    read_file_operations: 0,
    read_file_bytes: 0,
    read_text_file_operations: 0,
    read_text_file_bytes: 0,
    write_file_operations: 0,
    write_file_bytes: 0,
    write_text_file_operations: 0,
    write_text_file_bytes: 0,
    rename_operations: 0,
    remove_operations: 0,
  };
}

let io = emptyCounters();
let activeHandles = 0;
function targetName(path: string | URL): string {
  const value = String(path).replaceAll("\\", "/");
  if (value.endsWith("/project.json.bak")) return "canonical_backup";
  if (value.endsWith("/project.json")) return "canonical_project";
  if (value.endsWith("/.workspace/recovery.json")) return "recovery_journal";
  if (value.endsWith("/.workspace/index.json")) return "search_index";
  if (value.endsWith("/.workspace/browser-session.json")) {
    return "browser_session";
  }
  if (value.includes(".tmp-")) return "owned_temp";
  if (value.includes("/.workspace/")) return "workspace_sidecar";
  return "other";
}
function bucket(path: string | URL): FileIoTarget {
  const name = targetName(path);
  return io.by_target[name] ??= {
    read_operations: 0,
    read_bytes: 0,
    write_operations: 0,
    write_bytes: 0,
    sync_attempts: 0,
    sync_successes: 0,
    rename_in: 0,
    rename_out: 0,
    removes: 0,
  };
}

function installFileIoProbe() {
  const original = {
    open: Deno.open.bind(Deno),
    readFile: Deno.readFile.bind(Deno),
    readTextFile: Deno.readTextFile.bind(Deno),
    writeFile: Deno.writeFile.bind(Deno),
    writeTextFile: Deno.writeTextFile.bind(Deno),
    rename: Deno.rename.bind(Deno),
    remove: Deno.remove.bind(Deno),
  };
  const deno = Deno as typeof Deno;
  deno.readFile = async (...callArgs) => {
    const bytes = await original.readFile(...callArgs);
    const row = bucket(callArgs[0]);
    row.read_operations += 1;
    row.read_bytes += bytes.byteLength;
    io.read_file_operations += 1;
    io.read_file_bytes += bytes.byteLength;
    return bytes;
  };
  deno.readTextFile = async (...callArgs) => {
    const value = await original.readTextFile(...callArgs);
    const byteLength = new TextEncoder().encode(value).byteLength;
    const row = bucket(callArgs[0]);
    row.read_operations += 1;
    row.read_bytes += byteLength;
    io.read_text_file_operations += 1;
    io.read_text_file_bytes += byteLength;
    return value;
  };
  deno.writeFile = async (...callArgs) => {
    await original.writeFile(...callArgs);
    const data = callArgs[1];
    const byteLength = data instanceof Uint8Array ? data.byteLength : 0;
    const row = bucket(callArgs[0]);
    row.write_operations += 1;
    row.write_bytes += byteLength;
    io.write_file_operations += 1;
    io.write_file_bytes += byteLength;
  };
  deno.writeTextFile = async (...callArgs) => {
    await original.writeTextFile(...callArgs);
    const data = callArgs[1];
    const byteLength = typeof data === "string"
      ? new TextEncoder().encode(data).byteLength
      : 0;
    const row = bucket(callArgs[0]);
    row.write_operations += 1;
    row.write_bytes += byteLength;
    io.write_text_file_operations += 1;
    io.write_text_file_bytes += byteLength;
  };
  deno.rename = async (from, to) => {
    await original.rename(from, to);
    bucket(from).rename_out += 1;
    bucket(to).rename_in += 1;
    io.rename_operations += 1;
  };
  deno.remove = async (...callArgs) => {
    await original.remove(...callArgs);
    bucket(callArgs[0]).removes += 1;
    io.remove_operations += 1;
  };
  deno.open = async (path, options) => {
    const file = await original.open(path, options);
    const row = bucket(path);
    io.open_operations += 1;
    activeHandles += 1;
    io.peak_open_handles = Math.max(io.peak_open_handles, activeHandles);
    let closed = false;
    const read = file.read.bind(file);
    const write = file.write.bind(file);
    const sync = file.sync.bind(file);
    const close = file.close.bind(file);
    return new Proxy(file, {
      get(target, property) {
        if (property === "read") {
          return async (buffer: Uint8Array) => {
            row.read_operations += 1;
            const count = await read(buffer);
            if (count !== null) row.read_bytes += count;
            return count;
          };
        }
        if (property === "write") {
          return async (buffer: Uint8Array) => {
            const count = await write(buffer);
            row.write_operations += 1;
            row.write_bytes += count;
            return count;
          };
        }
        if (property === "sync") {
          return async () => {
            row.sync_attempts += 1;
            await sync();
            row.sync_successes += 1;
          };
        }
        if (property === "close") {
          return () => {
            try {
              return close();
            } finally {
              if (!closed) {
                closed = true;
                activeHandles -= 1;
                io.close_operations += 1;
              }
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Deno.FsFile;
  };
  return () => {
    deno.open = original.open;
    deno.readFile = original.readFile;
    deno.readTextFile = original.readTextFile;
    deno.writeFile = original.writeFile;
    deno.writeTextFile = original.writeTextFile;
    deno.rename = original.rename;
    deno.remove = original.remove;
  };
}

function percentiles(samples: number[]) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    median_ms: sorted[Math.floor(sorted.length / 2)] ?? null,
    min_ms: sorted[0] ?? null,
    max_ms: sorted.at(-1) ?? null,
    samples_ms: samples,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", owned))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const sourceModulePaths = {
  desktop: join(repoRoot, "src/service/desktop.ts"),
  storage: join(repoRoot, "src/service/storage.ts"),
  import_export: join(repoRoot, "src/service/import_export.ts"),
  search: join(repoRoot, "src/service/search.ts"),
};
const sourceModules = Object.fromEntries(
  await Promise.all(
    Object.entries(sourceModulePaths).map(async ([name, path]) => {
      const bytes = await Deno.readFile(path);
      return [name, {
        path,
        bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      }];
    }),
  ),
);
const runnerBytes = await Deno.readFile(scriptPath);
const gitRevision = await new Deno.Command("git", {
  args: ["rev-parse", "HEAD"],
  cwd: repoRoot,
  stdout: "piped",
  stderr: "null",
}).output().then((output) =>
  output.success ? new TextDecoder().decode(output.stdout).trim() : null
);

const fixtureBytes = await Deno.readFile(fixturePath);
const fixtureHash = await sha256Hex(fixtureBytes);
const fixtureProject = JSON.parse(
  new TextDecoder().decode(fixtureBytes),
) as ProjectData;
const runDirectory = await Deno.makeTempDir({
  prefix: `io-benchmark-${mode}-`,
});
const canonicalPath = join(runDirectory, "project.json");
await Deno.writeFile(canonicalPath, fixtureBytes);
const desktop = new DesktopService(runDirectory, {
  app_instance_id: `io-benchmark-${mode}-${crypto.randomUUID()}`,
});
let restoreProbe: (() => void) | null = null;
try {
  const opened = await desktop.open();
  if (!opened || opened.project.id !== fixtureProject.project.id) {
    throw new Error(
      "DesktopService did not open the requested fixture project",
    );
  }
  let project = structuredClone(opened);
  let fingerprint = await fileFingerprint(canonicalPath);
  if (!fingerprint.exists || fingerprint.hash !== fixtureHash) {
    throw new Error("The fixture changed during service initialization");
  }

  const storageModule = await import("../src/service/storage.ts") as {
    setStorageIoDiagnosticsEnabled?: (enabled: boolean) => void;
    getStorageIoMetrics?: () => Record<string, number>;
  };
  const leaseGeneration = (
    desktop.store as unknown as { leaseGeneration?: string }
  ).leaseGeneration;
  if (mode === "candidate" && !leaseGeneration) {
    throw new Error("candidate service did not acquire a project lease");
  }
  const save = async (
    next: ProjectData,
    revision: number,
    operationId: string,
  ) => {
    const input = mode === "candidate"
      ? {
        project_dir: runDirectory,
        expected_project_id: project.project.id,
        lease_generation: leaseGeneration ?? "",
        editor_generation: 1,
        operation_id: operationId,
        revision,
        expected_fingerprint: fingerprint,
        project: next,
      }
      : { project: next, expected_fingerprint: fingerprint };
    const result = await desktop.commands.execute("project.save", input);
    if (result.error) {
      throw new Error(
        `project.save ${operationId} failed: ${JSON.stringify(result.error)}`,
      );
    }
    const value = result.value as {
      fingerprint?: typeof fingerprint;
      outcome?: string;
    };
    if (
      !value.fingerprint?.exists || typeof value.fingerprint.hash !== "string"
    ) {
      throw new Error(
        "project.save did not return its actual committed fingerprint",
      );
    }
    fingerprint = value.fingerprint;
    project = next;
    return value;
  };

  // Warm the same real DesktopService command path, then restore the original
  // fixture before counters start so both measured cases begin from known bytes.
  const warmChanged = structuredClone(project);
  warmChanged.project.title = `${fixtureProject.project.title} warmup`;
  warmChanged.project.updated_at = new Date(Date.now() + 1000).toISOString();
  await save(warmChanged, 1, "io-bench-warm-changed");
  await save(structuredClone(opened), 2, "io-bench-warm-reset");
  await save(structuredClone(opened), 3, "io-bench-warm-noop");

  const samples = async (kind: "noop" | "changed") => {
    io = emptyCounters();
    activeHandles = 0;
    storageModule.setStorageIoDiagnosticsEnabled?.(true);
    const durations: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const next = structuredClone(project);
      if (kind === "changed") {
        const suffix = String(index).padStart(2, "0");
        next.project.title = `${
          fixtureProject.project.title.slice(0, -2)
        }${suffix}`;
        next.project.updated_at = new Date(Date.now() + index * 1000 + 1000)
          .toISOString();
      }
      const revision = kind === "noop" ? index + 4 : iterations + index + 4;
      const startedAt = performance.now();
      const value = await save(
        next,
        revision,
        `io-bench-${kind}-${String(index).padStart(2, "0")}`,
      );
      durations.push(performance.now() - startedAt);
      if (
        mode === "candidate" &&
        value.outcome !== (kind === "noop" ? "unchanged" : "written")
      ) {
        throw new Error(
          `candidate ${kind} sample ${index} returned outcome ${value.outcome}`,
        );
      }
    }
    const serviceMetrics = storageModule.getStorageIoMetrics?.() ?? null;
    return {
      ...percentiles(durations),
      file_io: structuredClone(io),
      service_metrics: serviceMetrics,
    };
  };

  restoreProbe = installFileIoProbe();
  const noOp = await samples("noop");
  const changed = await samples("changed");
  const report = {
    mode,
    api: mode === "candidate" ? "bound project.save" : "legacy project.save",
    source: {
      repo_root: repoRoot,
      declared_commit: declaredSourceCommit,
      git_head: gitRevision,
      modules: sourceModules,
      instrumentation_runner: {
        path: scriptPath,
        bytes: runnerBytes.byteLength,
        sha256: await sha256Hex(runnerBytes),
      },
      instrumentation_patch_scope: mode === "baseline"
        ? "runner copy is added inside the dfcb23e archive; runtime module paths and hashes above identify the unmodified baseline sources"
        : "runner is separate from candidate production modules; runtime module paths and hashes above identify the measured sources",
    },
    fixture: {
      path: fixturePath,
      bytes: fixtureBytes.byteLength,
      sha256: fixtureHash,
      project_id: fixtureProject.project.id,
    },
    unmeasured_warmup_saves: 3,
    iterations_per_case: iterations,
    setup_directory: runDirectory,
    no_op: noOp,
    changed,
    limitations: {
      process_rss: "not measured",
      device_physical_write_amplification: "not measured",
      browser_session_io:
        "measured separately by browser_session_generation_test",
      in_process_buffer_peak: "not measured by this save runner",
    },
  };
  await Deno.mkdir(dirname(outputPath), { recursive: true });
  await Deno.writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        mode,
        fixture_sha256: fixtureHash,
        iterations_per_case: iterations,
      },
      null,
      2,
    ),
  );
} finally {
  restoreProbe?.();
  const storageModule = await import("../src/service/storage.ts") as {
    setStorageIoDiagnosticsEnabled?: (enabled: boolean) => void;
  };
  storageModule.setStorageIoDiagnosticsEnabled?.(false);
  await desktop.close();
  await Deno.remove(runDirectory, { recursive: true }).catch(() => {});
}
