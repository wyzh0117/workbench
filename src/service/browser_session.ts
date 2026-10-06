import { join, normalize } from "node:path";
import { id } from "../domain/util.ts";
import { error, ServiceError } from "./errors.ts";

/** Browser reader state is adjacent metadata, never part of project.json. */
export const BROWSER_SESSION_FILE = ".workspace/browser-session.json";
const BROWSER_SESSION_VERSION = 1;
const MAX_BROWSER_SESSION_BYTES = 64 * 1024;
const browserSessionIoMetrics = {
  envelope_temp_write_operations: 0,
  envelope_temp_write_bytes: 0,
  envelope_atomic_replacements: 0,
};
let browserSessionIoDiagnosticsEnabled = false;

export function setBrowserSessionIoDiagnosticsEnabled(enabled: boolean): void {
  browserSessionIoDiagnosticsEnabled = enabled;
  if (enabled) {
    browserSessionIoMetrics.envelope_temp_write_operations = 0;
    browserSessionIoMetrics.envelope_temp_write_bytes = 0;
    browserSessionIoMetrics.envelope_atomic_replacements = 0;
  }
}

export function getBrowserSessionIoMetrics(): typeof browserSessionIoMetrics {
  return { ...browserSessionIoMetrics };
}

const READER_KEYS = [
  "active_content_item_id",
  "mode",
  "right_panel",
  "route",
  "selected_block_id",
  "layout_page_id",
  "layout_zoom",
  "ai_scope",
  "ai_provider_id",
  "ai_model",
  "left_collapsed",
  "right_collapsed",
  "collapsed_stage_ids",
  "tabs",
  // V1-T04 Explorer chrome (§39) — .workspace session only.
  "explorer_filter",
  "explorer_expanded",
  "explorer_recent",
] as const;
const EXPLORER_PATH_LIST_KEYS = new Set([
  "explorer_expanded",
  "explorer_recent",
  "collapsed_stage_ids",
]);
const EXPLORER_PATH_LIST_LIMIT: Record<string, number> = {
  explorer_expanded: 64,
  explorer_recent: 8,
  collapsed_stage_ids: 1024,
};
const SESSION_KEYS = new Set<string>(["project_id", ...READER_KEYS]);

export type BrowserReaderSession = Record<string, unknown> & {
  project_id: string;
};

interface BrowserSessionEnvelope {
  version: number;
  project_root: string;
  project_id: string;
  session: BrowserReaderSession | null;
  session_generation?: number;
  revision?: number;
}

export interface BrowserSessionCursor {
  session: BrowserReaderSession | null;
  session_generation: number;
  revision: number;
}

export interface BrowserSessionSaveBinding {
  operation_id: string;
  session_generation: number;
  revision: number;
}

export interface BrowserSessionSaveResult {
  outcome: "written" | "unchanged";
  session_generation: number;
  revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(caught: unknown): boolean {
  return caught instanceof Deno.errors.NotFound || Boolean(
    caught && typeof caught === "object" && "name" in caught &&
      (caught as { name?: unknown }).name === "NotFound",
  );
}

function isAlreadyExists(caught: unknown): boolean {
  return caught instanceof Deno.errors.AlreadyExists;
}

function sessionError(operation: string, caught?: unknown): ServiceError {
  const technical = caught instanceof Error ? caught.message : "unknown failure";
  return error(
    "browser_session_unavailable",
    operation === "read"
      ? "上次阅读位置暂时无法读取，已使用默认页面。"
      : "上次阅读位置暂时无法保存，但课程内容仍可继续使用。",
    `Browser session ${operation} failed: ${technical}`,
    {
      recoverable: true,
      recommended_action: "检查项目目录权限后重试；课程内容不会因此改变。",
      details: { operation },
    },
  );
}

function invalidSession(message: string): ServiceError {
  return error(
    "invalid_browser_session",
    "阅读位置记录无效，已使用默认页面。",
    message,
    {
      recoverable: true,
      recommended_action: "继续使用工作台；下次保存时会重新记录阅读位置。",
      details: {},
    },
  );
}

function staleSession(message: string): ServiceError {
  return error(
    "browser_session_stale",
    "阅读位置已被较新的页面更新，请刷新后重试。",
    message,
    {
      recoverable: false,
      recommended_action: null,
      details: {
        stage: "session_ordering",
        commit_state: "not_committed",
        retryable: false,
      },
    },
  );
}

function sameSession(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * The browser service owns one configured project root. Keeping this record
 * beside that root avoids a global server-side session shared by projects,
 * while the envelope's root and project id make stale records harmless.
 */
export class BrowserSessionStore {
  readonly directory: string;
  readonly path: string;
  readonly lockPath: string;
  private activeGeneration: number | null = null;
  private acceptedRevision = 0;

  constructor(directory: string) {
    this.directory = normalize(directory);
    this.path = join(this.directory, BROWSER_SESSION_FILE);
    this.lockPath = `${this.path}.lock`;
  }

  /**
   * Read only a validated reader record for the currently opened project.
   * Corrupt, stale, moved, or inaccessible files intentionally look like no
   * session: a resume pointer must never prevent the project from opening.
   */
  async load(projectId: string | null): Promise<BrowserReaderSession | null> {
    if (!isProjectId(projectId)) return null;
    try {
      if (!await this.ensureSafeDirectory(false)) return null;
      return await this.withLock(false, async () => {
        const raw = await this.readEnvelope();
        if (!raw) return null;
        if (raw.version !== BROWSER_SESSION_VERSION) return null;
        if (raw.project_root !== this.directory || raw.project_id !== projectId) {
          return null;
        }
        return normalizeSession(raw.session, projectId);
      });
    } catch {
      return null;
    }
  }

  /**
   * Start a new browser page epoch under the sidecar lock. Reads stay pure;
   * this explicit handshake makes delayed writes from earlier pages stale.
   */
  async open(projectId: string): Promise<BrowserSessionCursor> {
    if (!isProjectId(projectId)) throw invalidSession("Missing current project id");
    try {
      await this.ensureSafeDirectory();
      return await this.withLock(true, async () => {
        const current = await this.readEnvelope();
        const session = current?.project_id === projectId
          ? normalizeSession(current.session, projectId)
          : null;
        const previousGeneration = Number.isSafeInteger(current?.session_generation)
          ? current!.session_generation!
          : 0;
        const generation = Math.max(Date.now(), previousGeneration + 1);
        const envelope: BrowserSessionEnvelope = {
          version: BROWSER_SESSION_VERSION,
          project_root: this.directory,
          project_id: projectId,
          session,
          session_generation: generation,
          revision: 0,
        };
        await this.writeEnvelope(envelope);
        this.activeGeneration = generation;
        this.acceptedRevision = 0;
        return { session, session_generation: generation, revision: 0 };
      });
    } catch (caught) {
      if (caught instanceof ServiceError) throw caught;
      throw sessionError("write", caught);
    }
  }

  /**
   * Save after the service has identified the canonical project. The caller's
   * project id is checked again here; this boundary never writes project.json
   * and never accepts a session for another project root/identity.
   */
  async save(
    value: unknown,
    projectId: string,
    binding?: BrowserSessionSaveBinding,
  ): Promise<BrowserSessionSaveResult | void> {
    if (binding) return await this.saveBound(value, projectId, binding);
    if (!isProjectId(projectId)) throw invalidSession("Missing current project id");
    const session = normalizeSession(value, projectId);
    if (!session) throw invalidSession("Session payload is not reader metadata");
    try {
      await this.ensureSafeDirectory();
      await this.withLock(true, async () => {
        const current = await this.readEnvelope();
        if (Number.isSafeInteger(current?.session_generation)) {
          throw sessionError("write", new Error("session bootstrap is required"));
        }
        if (current?.project_id === projectId && sameSession(current.session, session)) return;
        await this.writeEnvelope({
          version: BROWSER_SESSION_VERSION,
          project_root: this.directory,
          project_id: projectId,
          session,
        });
      });
    } catch (caught) {
      if (caught instanceof ServiceError) throw caught;
      throw sessionError("write", caught);
    }
  }

  private async saveBound(
    value: unknown,
    projectId: string,
    binding: BrowserSessionSaveBinding,
  ): Promise<BrowserSessionSaveResult> {
    if (!isProjectId(projectId)) throw invalidSession("Missing current project id");
    if (typeof binding.operation_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(binding.operation_id) ||
      !Number.isSafeInteger(binding.session_generation) ||
      !Number.isSafeInteger(binding.revision) || binding.revision < 1) {
      throw invalidSession("Invalid browser session operation binding");
    }
    const session = normalizeSession(value, projectId);
    if (!session) throw invalidSession("Session payload is not reader metadata");
    try {
      await this.ensureSafeDirectory();
      return await this.withLock(true, async () => {
        const current = await this.readEnvelope();
        if (
          !current || current.project_root !== this.directory ||
          current.project_id !== projectId ||
          current.session_generation !== binding.session_generation ||
          this.activeGeneration !== binding.session_generation
        ) {
          throw staleSession("Browser page generation is no longer active");
        }
        const persistedRevision = Number.isSafeInteger(current.revision)
          ? current.revision!
          : 0;
        const highWater = Math.max(this.acceptedRevision, persistedRevision);
        if (binding.revision < highWater) {
          throw staleSession("Browser session revision is older than the accepted revision");
        }
        const unchanged = sameSession(current.session, session);
        if (binding.revision === highWater) {
          if (!unchanged) throw staleSession("Duplicate browser session revision has different content");
          this.acceptedRevision = highWater;
          return {
            outcome: "unchanged",
            session_generation: binding.session_generation,
            revision: binding.revision,
          };
        }
        if (unchanged) {
          // Advance only this active page's cursor: no data-file write or
          // atomic replacement is needed for identical reader metadata.
          this.acceptedRevision = binding.revision;
          return {
            outcome: "unchanged",
            session_generation: binding.session_generation,
            revision: binding.revision,
          };
        }
        await this.writeEnvelope({
          ...current,
          session,
          revision: binding.revision,
        });
        this.acceptedRevision = binding.revision;
        return {
          outcome: "written",
          session_generation: binding.session_generation,
          revision: binding.revision,
        };
      });
    } catch (caught) {
      if (caught instanceof ServiceError) throw caught;
      throw sessionError("write", caught);
    }
  }

  private async writeEnvelope(envelope: BrowserSessionEnvelope): Promise<void> {
    const contents = `${JSON.stringify(envelope)}\n`;
    const byteLength = new TextEncoder().encode(contents).byteLength;
    if (byteLength > MAX_BROWSER_SESSION_BYTES) {
      throw invalidSession("Browser session is too large");
    }
    const temporary = `${this.path}.tmp-${id()}`;
    try {
      await Deno.writeTextFile(temporary, contents, { createNew: true });
      if (browserSessionIoDiagnosticsEnabled) {
        browserSessionIoMetrics.envelope_temp_write_operations += 1;
        browserSessionIoMetrics.envelope_temp_write_bytes += byteLength;
      }
      await Deno.rename(temporary, this.path);
      if (browserSessionIoDiagnosticsEnabled) {
        browserSessionIoMetrics.envelope_atomic_replacements += 1;
      }
    } catch (caught) {
      await Deno.remove(temporary).catch(() => undefined);
      throw caught;
    }
    if (Deno.build.os !== "windows") {
      await Deno.chmod(this.path, 0o600).catch(() => undefined);
    }
  }

  private async withLock<T>(exclusive: boolean, action: () => Promise<T>): Promise<T> {
    let current: Deno.FileInfo | null = null;
    try {
      current = await Deno.lstat(this.lockPath);
    } catch (caught) {
      if (!isNotFound(caught) || !exclusive) throw caught;
    }
    if (current && (current.isSymlink || !current.isFile)) {
      throw new Error("session lock path is not a regular file");
    }
    if (!current && !exclusive) return await action();

    const file = await Deno.open(this.lockPath, {
      create: exclusive,
      mode: 0o600,
      read: true,
      write: exclusive,
    });
    try {
      const opened = await file.stat();
      const beforeLock = await Deno.lstat(this.lockPath);
      if (
        beforeLock.isSymlink || !beforeLock.isFile || opened.dev !== beforeLock.dev ||
        opened.ino !== beforeLock.ino
      ) {
        throw new Error("session lock path changed while opening");
      }
      await file.lock(exclusive);
      const afterLock = await Deno.lstat(this.lockPath);
      if (
        afterLock.isSymlink || !afterLock.isFile || opened.dev !== afterLock.dev ||
        opened.ino !== afterLock.ino
      ) {
        throw new Error("session lock path changed while acquiring lock");
      }
      try {
        return await action();
      } finally {
        await file.unlock();
      }
    } finally {
      file.close();
    }
  }

  private async readEnvelope(): Promise<BrowserSessionEnvelope | null> {
    if (!await this.ensureSafeDirectory(false)) return null;
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.lstat(this.path);
    } catch (caught) {
      if (isNotFound(caught)) return null;
      throw caught;
    }
    if (stat.isSymlink || !stat.isFile || stat.size > MAX_BROWSER_SESSION_BYTES) return null;
    const parsed: unknown = JSON.parse(await Deno.readTextFile(this.path));
    if (!isRecord(parsed)) return null;
    if (typeof parsed.version !== "number" || typeof parsed.project_root !== "string" ||
      typeof parsed.project_id !== "string" ||
      (parsed.session !== null && !isRecord(parsed.session)) ||
      (parsed.session_generation !== undefined &&
        (typeof parsed.session_generation !== "number" ||
          !Number.isSafeInteger(parsed.session_generation) ||
          parsed.session_generation < 0)) ||
      (parsed.revision !== undefined &&
        (typeof parsed.revision !== "number" ||
          !Number.isSafeInteger(parsed.revision) || parsed.revision < 0))) return null;
    return parsed as unknown as BrowserSessionEnvelope;
  }

  private async ensureSafeDirectory(createWorkspace = true): Promise<boolean> {
    let root: Deno.FileInfo;
    try {
      root = await Deno.lstat(this.directory);
    } catch (caught) {
      throw caught;
    }
    if (root.isSymlink || !root.isDirectory) throw new Error("project root is not a directory");
    const workspace = join(this.directory, ".workspace");
    try {
      const stat = await Deno.lstat(workspace);
      if (stat.isSymlink || !stat.isDirectory) throw new Error("workspace is not a directory");
    } catch (caught) {
      if (!isNotFound(caught)) throw caught;
      if (!createWorkspace) return false;
      try {
        await Deno.mkdir(workspace, { recursive: false });
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      const created = await Deno.lstat(workspace);
      if (created.isSymlink || !created.isDirectory) throw new Error("workspace is not a directory");
    }
    for (const [path, description] of [
      [this.path, "session"],
      [this.lockPath, "session lock"],
    ] as const) {
      try {
        const stat = await Deno.lstat(path);
        if (stat.isSymlink || !stat.isFile) {
          throw new Error(`${description} path is not a regular file`);
        }
      } catch (caught) {
        if (!isNotFound(caught)) throw caught;
      }
    }
    return true;
  }
}

function isProjectId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

/** Keep only the shared UI reader contract; canonical and secret-shaped data is dropped. */
function normalizeSession(value: unknown, projectId: string): BrowserReaderSession | null {
  if (!isRecord(value) || value.project_id !== projectId) return null;
  for (const key of Object.keys(value)) {
    if (!SESSION_KEYS.has(key)) return null;
  }
  const output: BrowserReaderSession = { project_id: projectId };
  for (const key of READER_KEYS) {
    if (!(key in value)) continue;
    const child = value[key];
    if (key === "tabs") {
      if (!Array.isArray(child) || child.length > 100) return null;
      const tabs: Record<string, unknown>[] = [];
      for (const tab of child) {
        if (!isRecord(tab)) return null;
        const allowed = ["content_item_id", "mode", "pinned", "scroll_top"];
        if (Object.keys(tab).some((tabKey) => !allowed.includes(tabKey))) return null;
        if (typeof tab.content_item_id !== "string" || typeof tab.mode !== "string" ||
          typeof tab.pinned !== "boolean" || typeof tab.scroll_top !== "number" ||
          !Number.isFinite(tab.scroll_top)) return null;
        tabs.push({
          content_item_id: tab.content_item_id,
          mode: tab.mode,
          pinned: tab.pinned,
          scroll_top: tab.scroll_top,
        });
      }
      output.tabs = tabs;
      continue;
    }
    if (EXPLORER_PATH_LIST_KEYS.has(key)) {
      if (!Array.isArray(child)) return null;
      const limit = EXPLORER_PATH_LIST_LIMIT[key] ?? 64;
      if (child.length > limit) return null;
      const paths: string[] = [];
      for (const item of child) {
        if (typeof item !== "string" || !item.trim() || item.length > 1024) return null;
        paths.push(item.trim());
      }
      output[key] = paths;
      continue;
    }
    if (key === "explorer_filter") {
      if (typeof child !== "string" || child.length > 256) return null;
      output[key] = child;
      continue;
    }
    if (["left_collapsed", "right_collapsed"].includes(key)) {
      if (typeof child !== "boolean") return null;
    } else if (
      key === "active_content_item_id" || key === "selected_block_id" ||
      key === "layout_page_id"
    ) {
      if (child !== null && typeof child !== "string") return null;
    } else if (key === "layout_zoom") {
      if (child !== "fit" && child !== "actual") return null;
    } else if (typeof child !== "string") {
      return null;
    }
    output[key] = child;
  }
  return output;
}
