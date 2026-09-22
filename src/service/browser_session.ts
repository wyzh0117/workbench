import { join, normalize } from "node:path";
import { id } from "../domain/util.ts";
import { error, ServiceError } from "./errors.ts";

/** Browser reader state is adjacent metadata, never part of project.json. */
export const BROWSER_SESSION_FILE = ".workspace/browser-session.json";
const BROWSER_SESSION_VERSION = 1;
const MAX_BROWSER_SESSION_BYTES = 64 * 1024;
const READER_KEYS = [
  "active_content_item_id",
  "mode",
  "right_panel",
  "route",
  "selected_block_id",
  "ai_scope",
  "ai_provider_id",
  "ai_model",
  "left_collapsed",
  "right_collapsed",
  "tabs",
] as const;
const SESSION_KEYS = new Set<string>(["project_id", ...READER_KEYS]);

export type BrowserReaderSession = Record<string, unknown> & {
  project_id: string;
};

interface BrowserSessionEnvelope {
  version: number;
  project_root: string;
  project_id: string;
  session: BrowserReaderSession;
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

/**
 * The browser service owns one configured project root. Keeping this record
 * beside that root avoids a global server-side session shared by projects,
 * while the envelope's root and project id make stale records harmless.
 */
export class BrowserSessionStore {
  readonly directory: string;
  readonly path: string;

  constructor(directory: string) {
    this.directory = normalize(directory);
    this.path = join(this.directory, BROWSER_SESSION_FILE);
  }

  /**
   * Read only a validated reader record for the currently opened project.
   * Corrupt, stale, moved, or inaccessible files intentionally look like no
   * session: a resume pointer must never prevent the project from opening.
   */
  async load(projectId: string | null): Promise<BrowserReaderSession | null> {
    if (!isProjectId(projectId)) return null;
    try {
      const raw = await this.readEnvelope();
      if (!raw) return null;
      if (raw.version !== BROWSER_SESSION_VERSION) return null;
      if (raw.project_root !== this.directory || raw.project_id !== projectId) {
        return null;
      }
      return normalizeSession(raw.session, projectId);
    } catch {
      return null;
    }
  }

  /**
   * Save after the service has identified the canonical project. The caller's
   * project id is checked again here; this boundary never writes project.json
   * and never accepts a session for another project root/identity.
   */
  async save(value: unknown, projectId: string): Promise<void> {
    if (!isProjectId(projectId)) throw invalidSession("Missing current project id");
    const session = normalizeSession(value, projectId);
    if (!session) throw invalidSession("Session payload is not reader metadata");
    const envelope: BrowserSessionEnvelope = {
      version: BROWSER_SESSION_VERSION,
      project_root: this.directory,
      project_id: projectId,
      session,
    };
    const contents = `${JSON.stringify(envelope)}\n`;
    if (new TextEncoder().encode(contents).byteLength > MAX_BROWSER_SESSION_BYTES) {
      throw invalidSession("Browser session is too large");
    }
    try {
      await this.ensureSafeDirectory();
      const temporary = `${this.path}.tmp-${id()}`;
      try {
        await Deno.writeTextFile(temporary, contents, { createNew: true });
        await Deno.rename(temporary, this.path);
      } catch (caught) {
        await Deno.remove(temporary).catch(() => undefined);
        throw caught;
      }
      // Reader state is not secret, but a restrictive mode keeps the sidecar
      // consistent with other local metadata on systems that support chmod.
      if (Deno.build.os !== "windows") await Deno.chmod(this.path, 0o600).catch(() => undefined);
    } catch (caught) {
      if (caught instanceof ServiceError) throw caught;
      throw sessionError("write", caught);
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
      typeof parsed.project_id !== "string" || !isRecord(parsed.session)) return null;
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
      await Deno.mkdir(workspace, { recursive: false });
    }
    try {
      const stat = await Deno.lstat(this.path);
      if (stat.isSymlink || !stat.isFile) throw new Error("session path is not a regular file");
    } catch (caught) {
      if (!isNotFound(caught)) throw caught;
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
    if (["left_collapsed", "right_collapsed"].includes(key)) {
      if (typeof child !== "boolean") return null;
    } else if (key === "active_content_item_id" || key === "selected_block_id") {
      if (child !== null && typeof child !== "string") return null;
    } else if (typeof child !== "string") {
      return null;
    }
    output[key] = child;
  }
  return output;
}
