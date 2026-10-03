/**
 * §4 — Application-level Project Registry: the browser/dev-shell twin of
 * `src-tauri/src/registry.rs`.
 *
 * Same rules, same record shape, same identity semantics — only the storage
 * location differs, following the precedent the AI store and
 * `browser_session.ts` already set: the desktop shell keeps app-global state in
 * `<app local data>/.workspace/projects.json`, the browser service owns exactly
 * one configured root and keeps its rebuildable copy at
 * `<root>/.workspace/projects.json`.
 *
 * This is **not Canonical**. A row says which project id lives at which path,
 * under which title, when it was last opened, and (optionally) which lesson the
 * reader was on. Course bodies, API keys, AI tokens and any copy of
 * `project.json` are outside the record shape: a row is rebuilt field by field
 * from named inputs, unknown keys in an existing file are dropped rather than
 * echoed, and every entry point runs the credential-shaped-key gate first.
 */
import { isAbsolute, join, normalize } from "node:path";
import { id } from "../domain/util.ts";
import { inspectProjectDirectory } from "./storage.ts";

/** Relative location of the registry file, identical in both shells. */
export const PROJECT_REGISTRY_FILE = ".workspace/projects.json";
const REGISTRY_VERSION = 1;
/** Rows kept in the file; the most recent win, older ones fall off the tail. */
const REGISTRY_LIMIT = 200;
const TITLE_LIMIT = 200;
const PATH_LIMIT = 4096;
const MAX_REGISTRY_BYTES = 256 * 1024;

/** The exact persisted field set from §4.1. Nothing else is ever written. */
export const REGISTRY_RECORD_FIELDS = [
  "project_id",
  "project_path",
  "project_title",
  "last_opened_at",
  "last_content_item_id",
] as const;

/**
 * Credential-shaped words are refused the same way the native shell's
 * `reject_sensitive` refuses them, so neither registry file can ever hold a key.
 */
const SENSITIVE_KEY = /(apikey|accesstoken|refreshtoken|authtoken|bearertoken|token|cookie|password|passphrase|secret|privatekey|clientsecret|authorization|credential)/i;

export type RegistryRow = {
  project_id: string;
  project_path: string;
  project_title: string;
  last_opened_at: string;
  last_content_item_id?: string;
};

/** A row as the launcher sees it: the record plus two derived, unpersisted flags. */
export type RegistryListRow = RegistryRow & { available: boolean; copy: boolean };

export type RegistryRequest = {
  project_id: string;
  project_path: string;
  project_title: string;
  last_content_item_id?: string | null;
  allow_second_copy?: boolean;
};

/**
 * The result envelope, field for field the same one `registry.rs::registry_record`
 * returns, so the launcher cannot behave differently per shell.
 */
export type RegistryOutcome = {
  status: "refreshed" | "added" | "relocated" | "duplicate";
  /** The row that now stands for this project (for `duplicate`: the stored one). */
  project?: RegistryRow;
  previous_path?: string;
  message?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(caught: unknown): boolean {
  return caught instanceof Deno.errors.NotFound || Boolean(
    caught && typeof caught === "object" && "name" in caught &&
      (caught as { name?: unknown }).name === "NotFound",
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Accept either spelling, exactly like the native command's argument reader. */
function field(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function assertNoSensitiveKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      assertNoSensitiveKeys(child, `${path}[${index}]`);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key.replace(/[\s_.-]/g, ""))) {
      throw new Error("登记表记录不得包含凭据或本机私有字段");
    }
    assertNoSensitiveKeys(child, `${path}.${key}`);
  }
}

/** Trim an incoming value into the canonical row, keeping only §4.1 fields. */
export function buildRow(
  input: {
    project_id: unknown;
    project_path: unknown;
    project_title: unknown;
    last_content_item_id?: unknown;
  },
  openedAt: string,
): RegistryRow | null {
  const projectId = text(input.project_id);
  if (!projectId) return null;
  const projectPath = text(input.project_path).slice(0, PATH_LIMIT);
  const title = text(input.project_title).slice(0, TITLE_LIMIT);
  const position = typeof input.last_content_item_id === "string"
    ? input.last_content_item_id.trim()
    : "";
  const row: RegistryRow = {
    project_id: projectId,
    project_path: projectPath,
    project_title: title || projectPath,
    last_opened_at: openedAt,
  };
  // §4.1 makes the position optional: an absent hint stays absent rather than
  // being written as null, which would look like a lost reader position.
  if (position) row.last_content_item_id = position;
  return row;
}

/** Read one stored row out of an arbitrary (possibly damaged) JSON value. */
export function rowFromValue(value: unknown): RegistryRow | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !(REGISTRY_RECORD_FIELDS as readonly string[]).includes(key))) {
    return null;
  }
  return buildRow(
    {
      project_id: value.project_id,
      project_path: value.project_path,
      project_title: value.project_title,
      last_content_item_id: value.last_content_item_id,
    },
    text(value.last_opened_at),
  );
}

/** `last_opened_at DESC`, id as a stable tiebreak so the list never reorders. */
export function sortRows<T extends { last_opened_at: string; project_id: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => {
    const key = (row: T) => `${String(row.last_opened_at || "")}\u0000${row.project_id}`;
    return key(right) < key(left) ? -1 : key(right) > key(left) ? 1 : 0;
  });
}

/** Ids stored at more than one path (§4.4). */
export function duplicatedIds(rows: readonly RegistryRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.project_id, (counts.get(row.project_id) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([projectId]) => projectId);
}

export function annotateRows(
  rows: readonly RegistryRow[],
  pathLive: (path: string) => boolean,
): RegistryListRow[] {
  const copies = duplicatedIds(rows);
  return sortRows(
    rows.map((row) => ({
      ...row,
      available: pathLive(row.project_path),
      copy: copies.includes(row.project_id),
    })),
  );
}

/** A reopen that carries no reader position must not forget the one on file. */
function keepStoredPosition(existing: RegistryRow, row: RegistryRow): RegistryRow {
  if (row.last_content_item_id || !existing.last_content_item_id) return row;
  return { ...row, last_content_item_id: existing.last_content_item_id };
}

/**
 * Rows that still describe the folder at `path`.
 *
 * One folder can only hold one `project.json`, so recording identity Y at a path
 * means any row that claimed a *different* id at that same path has stopped
 * being true — the folder was replaced, not renamed. Leaving it would put a card
 * on the start page that opens a different course than its title says. Only ever
 * a row: the folder itself is untouched. Same rule as `drop_replaced` in
 * `registry.rs`.
 */
export function dropReplaced(
  rows: readonly RegistryRow[],
  projectId: string,
  projectPath: string,
): RegistryRow[] {
  return rows.filter((row) => row.project_id === projectId || row.project_path !== projectPath);
}

/** §4.2 — upsert by `project_id`, with §4.3/§4.4 as explicit outcomes. */
export function recordRows(
  rows: readonly RegistryRow[],
  request: RegistryRequest,
  pathLive: (path: string) => boolean,
  openedAt: string,
): { rows: RegistryRow[]; outcome: RegistryOutcome } {
  // A caller that knows the identity but not the location is refreshing the row
  // the registry already has, not moving the project: an empty path must never
  // overwrite a stored one, and a brand-new row with no location would be a
  // card the launcher can never open. Same order as `registry.rs`.
  const projectId = text(request.project_id);
  const stored = rows.find((candidate) => candidate.project_id === projectId);
  const location = text(request.project_path) || stored?.project_path || "";
  if (!location) throw new Error("项目登记表需要项目的文件夹路径");
  const row = buildRow(
    {
      project_id: projectId,
      project_path: location,
      project_title: request.project_title,
      last_content_item_id: request.last_content_item_id ?? null,
    },
    openedAt,
  );
  if (!row) throw new Error("项目登记表需要项目的稳定标识");
  const next = rows.slice();
  const sameIdentity = next.find((candidate) =>
    candidate.project_id === row.project_id && candidate.project_path === row.project_path
  );
  if (sameIdentity) {
    const index = next.indexOf(sameIdentity);
    const refreshed = keepStoredPosition(sameIdentity, row);
    next[index] = refreshed;
    return {
      rows: dropReplaced(next, row.project_id, row.project_path),
      outcome: { status: "refreshed", project: refreshed },
    };
  }
  const existing = next.find((candidate) => candidate.project_id === row.project_id);
  if (existing) {
    const allowSecond = request.allow_second_copy === true;
    if (pathLive(existing.project_path) && !allowSecond) {
      // §4.4: two live folders, one identity. Nothing is written and nothing is
      // merged; the user decides which meaning they intended.
      return {
        rows: rows.slice(),
        outcome: {
          status: "duplicate",
          project: existing,
          message: "检测到同一个 Workbench 项目的两个副本。",
        },
      };
    }
    if (!pathLive(existing.project_path) && !allowSecond) {
      // §4.3 in disguise: the stored folder is gone and this id opened
      // elsewhere, so the row follows the project instead of piling up.
      const from = existing.project_path;
      const index = next.indexOf(existing);
      next[index] = row;
      return {
        rows: dropReplaced(next, row.project_id, row.project_path),
        outcome: { status: "relocated", project: row, previous_path: from },
      };
    }
    // 「保留两条记录（标注副本）」 is an explicit user decision.
    next.push(row);
    return {
      rows: dropReplaced(next, row.project_id, row.project_path),
      outcome: { status: "added", project: row },
    };
  }
  next.push(row);
  return {
    rows: dropReplaced(next, row.project_id, row.project_path),
    outcome: { status: "added", project: row },
  };
}

/** §5 — 从列表移除: a row deletion, never a disk operation. */
export function removeRows(
  rows: readonly RegistryRow[],
  projectId: string,
  projectPath?: string | null,
): { rows: RegistryRow[]; removed: number } {
  const id = text(projectId);
  const path = text(projectPath);
  if (!id) return { rows: rows.slice(), removed: 0 };
  const kept = rows.filter((row) =>
    !(row.project_id === id && (!path || row.project_path === path))
  );
  return { rows: kept, removed: rows.length - kept.length };
}

export type RelocateEvidence = { found_id: string; found_title: string };

/** §4.3 — re-point a row, and only when the id at the new path matches. */
export function relocateRows(
  rows: readonly RegistryRow[],
  projectId: string,
  newPath: string,
  evidence: RelocateEvidence,
  openedAt: string,
): { rows: RegistryRow[]; row: RegistryRow } {
  const id = text(projectId);
  const target = text(newPath);
  if (!id || !target) throw new Error("重新定位需要项目标识与新的文件夹路径");
  if (text(evidence.found_id) !== id) {
    // Never silently re-point a registry row at a different project.
    throw new Error(
      `该文件夹里的项目标识与登记表记录不一致（${text(evidence.found_id) || "无标识"} ≠ ${id}），已拒绝重新定位。`,
    );
  }
  const existing = rows.find((row) => row.project_id === id);
  if (!existing) throw new Error("登记表里没有这个项目的记录。");
  const row = buildRow(
    {
      project_id: id,
      project_path: target,
      project_title: text(evidence.found_title) || existing.project_title,
      // The reader position belonged to the old folder; a different folder may
      // hold a different lesson, so the hint does not travel.
      last_content_item_id: existing.project_path === target
        ? existing.last_content_item_id ?? null
        : null,
    },
    openedAt,
  );
  if (!row) throw new Error("登记表记录无法更新");
  const next = rows.slice();
  const already = next.findIndex((candidate) =>
    candidate.project_id === id && candidate.project_path === target
  );
  if (already >= 0) {
    // Same id at the same path twice is not two facts; collapse them.
    next[already] = row;
    const stale = next.findIndex((candidate) => candidate === existing);
    if (stale >= 0 && stale !== already) next.splice(stale, 1);
  } else {
    next[next.indexOf(existing)] = row;
  }
  return { rows: sortRows(next), row };
}

/**
 * Availability probe matching native `registry_project_available`: a row is
 * openable only when `<folder>/.workbench.lock` is a real file, which is what
 * makes a folder a Workbench project root in the first place. A folder that
 * exists but holds someone else's course therefore reads as *not available* and
 * offers 「选择项目文件夹」 instead of an open button. A symlinked root is refused,
 * the same way `reject_symlink` refuses one when the project is opened.
 */
export function registryProjectAvailable(candidate: string): boolean {
  const path = String(candidate || "").trim();
  if (!path || !isAbsolute(path)) return false;
  try {
    const root = Deno.lstatSync(path);
    if (!root.isDirectory || root.isSymlink) return false;
    return Deno.statSync(`${path.replace(/\/+$/, "")}/.workbench.lock`).isFile;
  } catch {
    return false;
  }
}

/**
 * File access for the registry. Every read is tolerant: a damaged file is set
 * aside as `.bak` and reads as empty, so the start page can never be blocked by
 * state that is, by design, rebuildable.
 */
export class ProjectRegistryStore {
  readonly directory: string;
  readonly path: string;

  constructor(directory: string) {
    this.directory = normalize(directory);
    this.path = join(this.directory, PROJECT_REGISTRY_FILE);
  }

  async read(): Promise<RegistryRow[]> {
    try {
      await Deno.mkdir(join(this.directory, ".workspace"), { recursive: true });
      const stat = await Deno.lstat(this.path);
      if (stat.isSymlink || !stat.isFile || stat.size > MAX_REGISTRY_BYTES) return [];
      const contents = await Deno.readTextFile(this.path);
      if (!contents.trim()) return [];
      const parsed: unknown = JSON.parse(contents);
      if (!isRecord(parsed) || !Array.isArray(parsed.projects)) return [];
      return parsed.projects.map(rowFromValue).filter((row): row is RegistryRow => Boolean(row));
    } catch (caught) {
      if (isNotFound(caught)) return [];
      if (caught instanceof SyntaxError) {
        await this.setAside();
        return [];
      }
      // A registry that cannot be read is still just an empty convenience list.
      return [];
    }
  }

  private async setAside(): Promise<void> {
    try {
      await Deno.copyFile(this.path, `${this.path.replace(/\.json$/, "")}.bak`);
    } catch {
      /* a forensic copy is a courtesy, never a requirement */
    }
  }

  async write(rows: readonly RegistryRow[]): Promise<void> {
    const sorted = sortRows(rows.slice());
    const kept = sorted.slice(0, REGISTRY_LIMIT).map((row) => ({
      project_id: row.project_id,
      project_path: row.project_path,
      project_title: row.project_title,
      last_opened_at: row.last_opened_at,
      ...(row.last_content_item_id ? { last_content_item_id: row.last_content_item_id } : {}),
    }));
    const contents = `${
      JSON.stringify({ version: REGISTRY_VERSION, projects: kept }, null, 2)
    }\n`;
    if (new TextEncoder().encode(contents).byteLength > MAX_REGISTRY_BYTES) {
      throw new Error("项目登记表内容过大");
    }
    const temporary = `${this.path}.tmp-${id()}`;
    await Deno.mkdir(join(this.directory, ".workspace"), { recursive: true });
    try {
      await Deno.writeTextFile(temporary, contents, { createNew: true });
      await Deno.rename(temporary, this.path);
    } catch (caught) {
      await Deno.remove(temporary).catch(() => undefined);
      throw caught;
    }
    if (Deno.build.os !== "windows") await Deno.chmod(this.path, 0o600).catch(() => undefined);
  }

  async list(): Promise<{ version: number; projects: RegistryListRow[] }> {
    const rows = await this.read();
    return { version: REGISTRY_VERSION, projects: annotateRows(rows, registryProjectAvailable) };
  }

  async record(payload: unknown): Promise<RegistryOutcome> {
    assertNoSensitiveKeys(payload);
    const candidate = isRecord(payload) ? payload : {};
    const request: RegistryRequest = {
      project_id: field(candidate, ["projectId", "project_id"]),
      project_path: field(candidate, ["projectPath", "project_path"]),
      project_title: field(candidate, ["projectTitle", "project_title"]),
      last_content_item_id: field(candidate, ["lastContentItemId", "last_content_item_id"]) || null,
      allow_second_copy: candidate.allowSecondCopy === true ||
        candidate.allow_second_copy === true,
    };
    const rows = await this.read();
    const { rows: next, outcome } = recordRows(rows, request, registryProjectAvailable, new Date().toISOString());
    if (outcome.status !== "duplicate") await this.write(next);
    return outcome;
  }

  async remove(payload: unknown): Promise<{ removed: number; project_id: string }> {
    assertNoSensitiveKeys(payload);
    const candidate = isRecord(payload) ? payload : {};
    const projectId = field(candidate, ["projectId", "project_id"]);
    if (!projectId) throw new Error("移除登记表记录需要项目标识");
    const projectPath = field(candidate, ["projectPath", "project_path"]);
    const rows = await this.read();
    // Nothing on disk besides the registry file is touched: no project read, no
    // project write, no lock.
    const { rows: kept, removed } = removeRows(rows, projectId, projectPath);
    await this.write(kept);
    return { removed, project_id: projectId };
  }

  async relocate(payload: unknown): Promise<{ status: "relocated"; project: RegistryRow }> {
    assertNoSensitiveKeys(payload);
    const candidate = isRecord(payload) ? payload : {};
    const projectId = field(candidate, ["projectId", "project_id"]);
    const newPath = field(candidate, [
      "newPath",
      "new_path",
      "projectPath",
      "project_path",
    ]);
    // Same evidence the native shell uses: read `project.json` at the new path
    // through the read-only classifier and take its identity echo.
    const inspection = await inspectProjectDirectory(newPath);
    if (inspection.status !== "valid" && inspection.status !== "migratable") {
      throw new Error(
        `无法采用这个文件夹：${inspection.problem?.message || "这个文件夹不是一个可用的 Workbench 项目。"}`,
      );
    }
    const { rows, row } = relocateRows(
      await this.read(),
      projectId,
      newPath,
      {
        found_id: inspection.project?.id ?? "",
        found_title: inspection.project?.title ?? "",
      },
      new Date().toISOString(),
    );
    await this.write(rows);
    return { status: "relocated", project: row };
  }
}
