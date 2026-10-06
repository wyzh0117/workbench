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
const instrumentation = args.get("instrumentation") ?? "on";
if (mode !== "baseline" && mode !== "candidate") {
  throw new Error("--mode must be baseline or candidate");
}
if (instrumentation !== "on" && instrumentation !== "off") {
  throw new Error("--instrumentation must be on or off");
}
if (!Number.isSafeInteger(iterations) || iterations < 10) {
  throw new Error("--iterations must be an integer of at least 10");
}
const instrumentationEnabled = instrumentation === "on";

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
  const middle = Math.floor(sorted.length / 2);
  return {
    // Keep the original upper-middle field for historical report readers.
    median_ms: sorted[Math.floor(sorted.length / 2)] ?? null,
    median_conventional_ms: sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : sorted[middle] ?? null,
    p95_nearest_rank_ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    min_ms: sorted[0] ?? null,
    max_ms: sorted.at(-1) ?? null,
    samples_ms: samples,
  };
}

type PhaseMap = Record<string, number>;
const phaseRows: Record<"noop" | "changed", PhaseMap[]> = { noop: [], changed: [] };
let activePhaseRow: PhaseMap | null = null;
const phaseStack: Array<{ name: string; childrenMs: number }> = [];
function addPhase(name: string, elapsedMs: number, chargeParent = true): void {
  if (activePhaseRow) activePhaseRow[name] = (activePhaseRow[name] ?? 0) + elapsedMs;
  if (chargeParent) {
    const parent = phaseStack.at(-1);
    if (parent) parent.childrenMs += elapsedMs;
  }
}
async function measurePhase<T>(name: string, run: () => Promise<T>): Promise<T> {
  const frame = { name, childrenMs: 0 };
  const startedAt = performance.now();
  phaseStack.push(frame);
  try {
    return await run();
  } finally {
    const elapsedMs = performance.now() - startedAt;
    phaseStack.pop();
    addPhase(name, elapsedMs);
    addPhase(`${name}.exclusive`, Math.max(0, elapsedMs - frame.childrenMs), false);
  }
}
function phaseSummary(rows: PhaseMap[]): Record<string, unknown> {
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  return Object.fromEntries(names.map((name) => {
    const samples = rows.map((row) => row[name] ?? 0);
    return [name, { ...percentiles(samples), samples_ms: samples }];
  }));
}
function wrapPhaseMethod(
  target: object | undefined,
  methodName: string,
  phaseName: string | ((args: unknown[]) => string),
): (() => void) | null {
  if (!target) return null;
  const original = Reflect.get(target, methodName);
  if (typeof original !== "function") return null;
  const descriptor = Object.getOwnPropertyDescriptor(target, methodName);
  Object.defineProperty(target, methodName, {
    configurable: true,
    writable: true,
    value: async function (this: unknown, ...args: unknown[]) {
      const name = typeof phaseName === "function" ? phaseName(args) : phaseName;
      return await measurePhase(name, async () => await Reflect.apply(original, this, args));
    },
  });
  return () => descriptor
    ? Object.defineProperty(target, methodName, descriptor)
    : Reflect.deleteProperty(target, methodName);
}
function installPhaseIoTimers(): () => void {
  const restorers: Array<() => void> = [];
  const deno = Deno as unknown as Record<string, unknown>;
  const wrapDeno = (name: string) => {
    const original = deno[name];
    if (typeof original !== "function") return;
    deno[name] = async (...args: unknown[]) => {
      const startedAt = performance.now();
      try {
        return await Reflect.apply(original, Deno, args);
      } finally {
        addPhase(`fs.${name}`, performance.now() - startedAt);
      }
    };
    restorers.push(() => deno[name] = original);
  };
  for (const name of ["readFile", "readTextFile", "writeFile", "writeTextFile", "rename", "remove", "mkdir", "stat", "lstat"]) {
    wrapDeno(name);
  }
  const wrappedPrototypes = new Set<object>();
  const wrapFsPrototype = (initial: object | null) => {
    let proto = initial;
    while (proto) {
      const owner = proto;
      if (wrappedPrototypes.has(owner)) return;
      wrappedPrototypes.add(owner);
      for (const methodName of ["read", "write", "sync", "close"]) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, methodName);
        if (!descriptor || typeof descriptor.value !== "function") continue;
        const original = descriptor.value;
        Object.defineProperty(owner, methodName, {
          ...descriptor,
          value: function (this: unknown, ...args: unknown[]) {
            const startedAt = performance.now();
            try {
              const result = Reflect.apply(original, this, args);
              if (result && typeof (result as Promise<unknown>).then === "function") {
                return (result as Promise<unknown>).finally(() => addPhase(`fs.file.${methodName}`, performance.now() - startedAt));
              }
              addPhase(`fs.file.${methodName}`, performance.now() - startedAt);
              return result;
            } catch (error) {
              addPhase(`fs.file.${methodName}`, performance.now() - startedAt);
              throw error;
            }
          },
        });
        restorers.push(() => Object.defineProperty(owner, methodName, descriptor));
      }
      proto = Object.getPrototypeOf(owner);
    }
  };
  const originalOpen = deno.open;
  if (typeof originalOpen === "function") {
    deno.open = async (...args: unknown[]) => {
      const startedAt = performance.now();
      const file = await Reflect.apply(originalOpen, Deno, args) as Deno.FsFile;
      addPhase("fs.open", performance.now() - startedAt);
      wrapFsPrototype(Object.getPrototypeOf(file));
      return file;
    };
    restorers.push(() => deno.open = originalOpen);
  }
  const originalDigest = crypto.subtle.digest;
  crypto.subtle.digest = async (...args: Parameters<SubtleCrypto["digest"]>) => {
    const startedAt = performance.now();
    try {
      return await originalDigest.apply(crypto.subtle, args);
    } finally {
      addPhase("crypto.subtle.digest", performance.now() - startedAt);
    }
  };
  restorers.push(() => crypto.subtle.digest = originalDigest);
  return () => { for (const restore of restorers.reverse()) restore(); };
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
let restorePhaseIo: (() => void) | null = null;
let restorePhaseMethods: Array<() => void> = [];
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
    ProjectDirectoryStore?: { prototype: object };
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
    const result = await measurePhase("command.execute", () => desktop.commands.execute("project.save", input));
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

  restorePhaseMethods = [
    wrapPhaseMethod(storageModule.ProjectDirectoryStore?.prototype, "saveWithRecovery", "store.saveWithRecovery"),
    wrapPhaseMethod(storageModule.ProjectDirectoryStore?.prototype, "saveBound", "store.saveBound"),
    wrapPhaseMethod(storageModule.ProjectDirectoryStore?.prototype, "withWritableLease", "store.withWritableLease"),
    wrapPhaseMethod(storageModule.ProjectDirectoryStore?.prototype, "withLockGuard", "store.withLockGuard"),
    wrapPhaseMethod(storageModule.ProjectDirectoryStore?.prototype, "externalChange", "store.externalChange"),
    wrapPhaseMethod(storageModule.ProjectDirectoryStore?.prototype, "writeProjectUnlocked", "store.writeProjectUnlocked"),
    wrapPhaseMethod(storageModule.ProjectDirectoryStore?.prototype, "writeAtomicText", (args) => `store.writeAtomicText:${String(args[0])}`),
    wrapPhaseMethod(storageModule.ProjectDirectoryStore?.prototype, "readProjectSnapshot", "store.readProjectSnapshot"),
    wrapPhaseMethod(DesktopService.prototype, "rebuildSearchAfterWrite", "search.rebuildSearchAfterWrite"),
    wrapPhaseMethod(DesktopService.prototype, "commitCanonicalMutation", "service.commitCanonicalMutation"),
  ].filter((restore): restore is () => void => Boolean(restore));
  const searchInstance = (desktop as unknown as { search?: object }).search;
  const restoreSearchMethod = wrapPhaseMethod(searchInstance, "rebuild", "search.rebuild");
  if (restoreSearchMethod) restorePhaseMethods.push(restoreSearchMethod);

  const samples = async (kind: "noop" | "changed") => {
    io = emptyCounters();
    activeHandles = 0;
    storageModule.setStorageIoDiagnosticsEnabled?.(instrumentationEnabled);
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
      activePhaseRow = {};
      const startedAt = performance.now();
      const value = await save(
        next,
        revision,
        `io-bench-${kind}-${String(index).padStart(2, "0")}`,
      );
      durations.push(performance.now() - startedAt);
      phaseRows[kind].push(activePhaseRow);
      activePhaseRow = null;
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
      file_io: instrumentationEnabled ? structuredClone(io) : null,
      service_metrics: instrumentationEnabled ? serviceMetrics : null,
    };
  };

  if (instrumentationEnabled) restoreProbe = installFileIoProbe();
  restorePhaseIo = installPhaseIoTimers();
  const noOp = await samples("noop");
  const changed = await samples("changed");
  const report = {
    mode,
    api: mode === "candidate" ? "bound project.save" : "legacy project.save",
    measurement_mode: instrumentationEnabled
      ? "instrumented_latency_and_counters"
      : "unprobed_latency_only",
    instrumentation: {
      file_io_probe: instrumentationEnabled,
      storage_service_diagnostics: instrumentationEnabled,
      counters_when_disabled: null,
    },
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
    phase_profile: {
      methodology: "runner-only symmetric wrappers; method spans are inclusive, .exclusive subtracts directly timed child spans; filesystem timings are separate and diagnostic-only",
      no_op: phaseSummary(phaseRows.noop),
      changed: phaseSummary(phaseRows.changed),
    },
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
        measurement_mode: instrumentationEnabled
          ? "instrumented_latency_and_counters"
          : "unprobed_latency_only",
        fixture_sha256: fixtureHash,
        iterations_per_case: iterations,
      },
      null,
      2,
    ),
  );
} finally {
  restorePhaseIo?.();
  for (const restore of restorePhaseMethods.reverse()) restore();
  restoreProbe?.();
  const storageModule = await import("../src/service/storage.ts") as {
    setStorageIoDiagnosticsEnabled?: (enabled: boolean) => void;
  };
  storageModule.setStorageIoDiagnosticsEnabled?.(false);
  await desktop.close();
  await Deno.remove(runDirectory, { recursive: true }).catch(() => {});
}
