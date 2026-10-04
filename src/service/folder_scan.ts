/**
 * Read-only folder scan for V1-T04 import-folder entry (§§26, 29, 38).
 *
 * Produces ScanResult metadata only. Does not write project.json, move files,
 * or read file contents into Canonical. Symlink roots/children are rejected or
 * skipped; a single unreadable entry degrades without failing the tree.
 */
import { basename, dirname, extname, isAbsolute, join, normalize, relative } from "node:path";
import { sha256Bytes } from "../domain/util.ts";

export type ScanKind = "directory" | "file";

/** Suggested mapping role — advice only until Confirm (Task 11/12). */
export type SuggestedRole =
  | "stage"
  | "folder"
  | "lesson"
  | "asset"
  | "reference"
  | "unsupported";

export interface ScanResult {
  path: string;
  relative_path: string;
  kind: ScanKind;
  mime: string | null;
  size: number | null;
  suggested_role: SuggestedRole;
  /** Set when this entry was degraded (permission / IO) without aborting the tree. */
  error?: string | null;
}

export interface FolderScanReport {
  root: string;
  entries: ScanResult[];
  warnings: string[];
  errors: string[];
}

export interface FolderDirectChildGroup {
  directory: string;
  entries: ScanResult[];
}

export interface FolderDirectChildScanReport {
  root: string;
  groups: FolderDirectChildGroup[];
  warnings: string[];
  errors: string[];
}

/** Metadata-only scan; warn when a file exceeds this size (do not read bytes). */
export const SCAN_LARGE_FILE_BYTES = 100 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".text",
  ".tex",
  ".latex",
]);
const WORD_EXTENSIONS = new Set([".doc", ".docx", ".odt", ".rtf"]);
const SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".bat",
  ".cmd",
  ".ps1",
  ".exe",
  ".app",
  ".com",
  ".dll",
]);
const ASSET_EXTENSIONS: Record<string, string> = {
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
};

const MANAGED_IMPORT_NAMES = new Set([
  "project.json",
  "project.json.bak",
  "project.json.backup",
  "project.lock",
  "project.lock.guard",
  "providers.json",
  "providers.bak",
  "credentials.json",
  ".workspace",
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".cache",
  ".env",
  "id_rsa",
  "id_ed25519",
  "backups",
  "backup",
]);

function isManagedImportName(name: string): boolean {
  const lower = name.toLowerCase();
  return MANAGED_IMPORT_NAMES.has(lower) ||
    /^\.env(?:\.|$)/.test(lower) ||
    /(?:credential|secret|token|api[-_]?key)/.test(lower) ||
    /\.(?:pem|key|p12|pfx|orig|old|swp)$/.test(lower) ||
    /(?:\.bak|\.backup|\.lock|\.tmp|~)$/.test(lower);
}

function extension(name: string): string {
  return extname(name).toLowerCase();
}

function mimeFor(name: string): string | null {
  const ext = extension(name);
  const known: Record<string, string> = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".text": "text/plain",
    ".tex": "text/x-tex",
    ".latex": "text/x-tex",
    ".epub": "application/epub+zip",
    ".json": "application/json",
    ".html": "text/html",
    ".pdf": "application/pdf",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ...ASSET_EXTENSIONS,
  };
  return known[ext] ?? null;
}

function suggestedRoleForFile(name: string): SuggestedRole {
  const ext = extension(name);
  if (SCRIPT_EXTENSIONS.has(ext)) return "unsupported";
  if (TEXT_EXTENSIONS.has(ext)) return "lesson";
  if (WORD_EXTENSIONS.has(ext) || ext === ".pdf") return "reference";
  if (ASSET_EXTENSIONS[ext]) return "asset";
  return "unsupported";
}

function suggestedRoleForDirectory(relativePath: string): SuggestedRole {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return "folder";
  // Top-level folder → Stage candidate (§30). Deeper folders stay generic.
  return normalized.includes("/") ? "folder" : "stage";
}

function toRelative(root: string, path: string): string {
  const rel = relative(root, path).replaceAll("\\", "/");
  if (!rel || rel === ".") return "";
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("扫描路径越过了所选文件夹边界");
  }
  return rel;
}

async function hasSymlinkComponent(root: string, relativePath: string): Promise<boolean> {
  let cursor = root;
  for (const part of relativePath.replaceAll("\\", "/").split("/").filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if ((await Deno.lstat(cursor)).isSymlink) return true;
    } catch (caught) {
      if (caught instanceof Deno.errors.NotFound) return false;
      throw caught;
    }
  }
  return false;
}

async function assertScanRoot(root: string): Promise<string> {
  const normalized = normalize(root);
  if (!normalized || !isAbsolute(normalized)) {
    throw new Error("导入文件夹必须是用户明确选择的绝对路径");
  }
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.lstat(normalized);
  } catch (caught) {
    throw new Error(
      `无法打开所选文件夹：${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  if (stat.isSymlink) {
    throw new Error("为避免越过目录边界，导入不支持以符号链接作为根目录");
  }
  if (!stat.isDirectory) {
    throw new Error("导入已有文件夹需要选择一个文件夹，而不是单个文件");
  }
  return normalized;
}

function degrade(
  path: string,
  relativePath: string,
  kind: ScanKind,
  message: string,
): ScanResult {
  return {
    path,
    relative_path: relativePath,
    kind,
    mime: kind === "file" ? mimeFor(basename(path)) : null,
    size: null,
    suggested_role: "unsupported",
    error: message,
  };
}

/**
 * Scan the immediate children of `root` into a flat list of ScanResult rows.
 * Read-only: never creates project.json or mutates user files.
 */
export async function scanFolder(root: string): Promise<FolderScanReport> {
  const resolved = await assertScanRoot(root);
  const entries: ScanResult[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const visited = new Set<string>();

  async function visit(path: string): Promise<void> {
    let relativePath: string;
    try {
      relativePath = toRelative(resolved, path);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      errors.push(message);
      return;
    }

    let stat: Deno.FileInfo;
    try {
      stat = await Deno.lstat(path);
    } catch (caught) {
      const message = `无法读取：${caught instanceof Error ? caught.message : String(caught)}`;
      const entry = degrade(path, relativePath, "file", message);
      entries.push(entry);
      errors.push(`${relativePath || "."}: ${message}`);
      return;
    }

    if (stat.isSymlink) {
      // Symlink children are skipped (same policy as listFiles). Root was already rejected.
      warnings.push(`${relativePath || "."}: 已跳过符号链接，避免越过所选文件夹`);
      return;
    }

    if (stat.isDirectory) {
      let identity = normalize(path);
      try {
        identity = await Deno.realPath(path);
      } catch { /* readDir below reports the useful error */ }
      if (visited.has(identity)) return;
      visited.add(identity);

      if (relativePath !== "") {
        entries.push({
          path,
          relative_path: relativePath,
          kind: "directory",
          mime: null,
          size: null,
          suggested_role: suggestedRoleForDirectory(relativePath),
        });
        // Import mapping never expands a selected folder into all of its
        // descendants. Users can choose that folder as a new root explicitly.
        return;
      }

      let children: Deno.DirEntry[];
      try {
        children = [];
        for await (const entry of Deno.readDir(path)) {
          children.push(entry);
        }
      } catch (caught) {
        const message = `无法读取目录：${
          caught instanceof Error ? caught.message : String(caught)
        }`;
        if (relativePath === "") {
          throw new Error(message);
        }
        // Replace the optimistic directory row with a degraded one.
        const index = entries.findIndex((entry) =>
          entry.path === path && entry.kind === "directory" && !entry.error
        );
        const degraded = degrade(path, relativePath, "directory", message);
        if (index >= 0) entries[index] = degraded;
        else entries.push(degraded);
        errors.push(`${relativePath}: ${message}`);
        return;
      }

      children.sort((left, right) => left.name.localeCompare(right.name, "zh"));
      for (const child of children) {
        if (isManagedImportName(child.name)) {
          warnings.push(
            `${relativePath ? `${relativePath}/` : ""}${child.name}: 已跳过工作台管理文件或构建目录`,
          );
          continue;
        }
        if (child.name.startsWith(".")) continue;
        if (child.isSymlink) {
          warnings.push(
            `${relativePath ? `${relativePath}/` : ""}${child.name}: 已跳过符号链接`,
          );
          continue;
        }
        await visit(join(path, child.name));
      }
      return;
    }

    if (!stat.isFile) {
      warnings.push(`${relativePath}: 已跳过非普通文件`);
      return;
    }

    const role = suggestedRoleForFile(basename(path));
    const mime = mimeFor(basename(path));
    const size = Number(stat.size);
    if (Number.isFinite(size) && size > SCAN_LARGE_FILE_BYTES) {
      warnings.push(
        `${relativePath}: 文件较大（${size} 字节），扫描仅记录元数据，不会读取内容`,
      );
    }

    // Probe readability without loading bytes into Canonical. A permission
    // failure degrades this row only.
    try {
      const handle = await Deno.open(path, { read: true });
      handle.close();
    } catch (caught) {
      const message = `无法读取文件：${
        caught instanceof Error ? caught.message : String(caught)
      }`;
      entries.push(degrade(path, relativePath, "file", message));
      errors.push(`${relativePath}: ${message}`);
      return;
    }

    entries.push({
      path,
      relative_path: relativePath,
      kind: "file",
      mime,
      size: Number.isFinite(size) ? size : null,
      suggested_role: role,
    });
  }

  await visit(resolved);
  entries.sort((left, right) =>
    left.relative_path.localeCompare(right.relative_path, "zh")
  );
  return { root: resolved, entries, warnings, errors };
}

/**
 * Read metadata for direct files in selected root-level Mapping folders.
 * This intentionally does not descend into a child's subdirectories.
 */
export async function scanFolderDirectChildren(
  root: string,
  relativeDirs: readonly string[],
): Promise<FolderDirectChildScanReport> {
  const resolvedRoot = await assertScanRoot(root);
  const realRoot = await Deno.realPath(resolvedRoot);
  const warnings: string[] = [];
  const errors: string[] = [];
  const groups: FolderDirectChildGroup[] = [];
  const seen = new Set<string>();

  for (const rawDirectory of Array.isArray(relativeDirs) ? relativeDirs : []) {
    const directory = String(rawDirectory ?? "").replaceAll("\\", "/");
    if (!directory || directory.includes("\0") || isAbsolute(directory) ||
      directory.includes("/") || directory === "." || directory === "..") {
      warnings.push(`${directory || "."}: 映射目录无效，未扫描直接子文件`);
      continue;
    }
    if (seen.has(directory)) continue;
    seen.add(directory);

    const entries: ScanResult[] = [];
    const absoluteDir = join(realRoot, directory);
    try {
      toRelative(realRoot, absoluteDir);
      if (await hasSymlinkComponent(realRoot, directory)) {
        warnings.push(`${directory}: 已跳过符号链接，避免越过所选文件夹`);
        groups.push({ directory, entries });
        continue;
      }
      const stat = await Deno.lstat(absoluteDir);
      if (stat.isSymlink) {
        warnings.push(`${directory}: 已跳过符号链接，避免越过所选文件夹`);
        groups.push({ directory, entries });
        continue;
      }
      if (!stat.isDirectory) {
        warnings.push(`${directory}: 映射目录已不是文件夹，未扫描直接子文件`);
        groups.push({ directory, entries });
        continue;
      }
      const resolvedDir = await Deno.realPath(absoluteDir);
      if (resolvedDir !== realRoot && !resolvedDir.startsWith(`${realRoot}/`)) {
        warnings.push(`${directory}: 映射目录超出所选文件夹，未扫描`);
        groups.push({ directory, entries });
        continue;
      }

      const children: Deno.DirEntry[] = [];
      try {
        for await (const child of Deno.readDir(resolvedDir)) children.push(child);
      } catch (caught) {
        const message = `无法读取目录：${caught instanceof Error ? caught.message : String(caught)}`;
        errors.push(`${directory}: ${message}`);
        groups.push({ directory, entries });
        continue;
      }
      children.sort((left, right) => left.name.localeCompare(right.name, "zh"));

      for (const child of children) {
        if (child.name.startsWith(".")) continue;
        const relativePath = `${directory}/${child.name}`;
        if (isManagedImportName(child.name)) {
          warnings.push(`${relativePath}: 已跳过工作台管理文件或构建目录`);
          continue;
        }
        const path = join(resolvedDir, child.name);
        let childStat: Deno.FileInfo;
        try {
          childStat = await Deno.lstat(path);
        } catch (caught) {
          const message = `无法读取：${caught instanceof Error ? caught.message : String(caught)}`;
          entries.push(degrade(path, relativePath, "file", message));
          errors.push(`${relativePath}: ${message}`);
          continue;
        }
        if (childStat.isSymlink) {
          warnings.push(`${relativePath}: 已跳过符号链接，避免越过所选文件夹`);
          continue;
        }
        if (!childStat.isFile) continue;
        try {
          toRelative(realRoot, path);
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          warnings.push(`${relativePath}: ${message}`);
          continue;
        }
        entries.push({
          path,
          relative_path: relativePath,
          kind: "file",
          mime: mimeFor(child.name),
          size: childStat.size,
          suggested_role: suggestedRoleForFile(child.name),
        });
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      errors.push(`${directory}: ${message}`);
    }
    groups.push({ directory, entries });
  }

  return { root: realRoot, groups, warnings, errors };
}

/** A visual-media descendant found under a selected directory row. */
export type MediaDescendantKind = "image" | "video";

/**
 * Row kinds the confirm step may read as files. `directory` stays out of this
 * list on purpose: directories become stages in pass 1 and must never be
 * treated as documents.
 */
export const ADOPTABLE_FILE_KINDS: readonly string[] = [
  "file",
  "image",
  "video",
];

export interface MediaDescendantCandidate {
  relative_path: string;
  filename: string;
  mime: string;
  kind: MediaDescendantKind;
  size: number;
}

export interface MediaDescendantScan {
  root: string;
  relative_dir: string;
  entries: MediaDescendantCandidate[];
  warnings: string[];
  errors: string[];
}

/**
 * Visual media classifier for one file name. Reuses the existing preview/MIME
 * tables so a directory sweep can never disagree with `scanFolder`, and stays
 * deliberately blind to documents, text and audio.
 */
export function mediaKindForName(name: string): MediaDescendantKind | null {
  const kind = previewKindForName(name, mimeFor(name));
  return kind === "image" || kind === "video" ? kind : null;
}

/**
 * Recursively list visual media UNDER one selected directory row.
 *
 * The anti-flood rule that keeps the Mapping Preview root listing flat still
 * holds: only the selected folder's own subtree is walked here, and the caller
 * must have selected that directory explicitly. Read-only — never creates
 * project.json and never mutates the source files.
 */
export async function scanMediaDescendants(
  root: string,
  relativeDir: string,
): Promise<MediaDescendantScan> {
  const resolved = await assertScanRoot(root);
  const rel = String(relativeDir || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (rel.includes("\0") || isAbsolute(rel) ||
    rel.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error("扫描路径无效");
  }
  const parts = rel.split("/").filter(Boolean);
  const absolute = parts.length ? join(resolved, ...parts) : resolved;
  toRelative(resolved, absolute);

  if (parts.length && await hasSymlinkComponent(resolved, rel)) {
    throw new Error("已跳过符号链接，避免越过所选文件夹");
  }

  let directoryStat: Deno.FileInfo;
  try {
    directoryStat = await Deno.lstat(absolute);
  } catch (caught) {
    throw new Error(
      `无法读取所选文件夹：${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  if (directoryStat.isSymlink) {
    throw new Error("已跳过符号链接，避免越过所选文件夹");
  }
  if (!directoryStat.isDirectory) {
    throw new Error("选择媒体目录需要选择一个文件夹，而不是单个文件");
  }

  const entries: MediaDescendantCandidate[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const visited = new Set<string>();

  async function walk(path: string, relativePath: string): Promise<void> {
    let children: Deno.DirEntry[];
    try {
      children = [];
      for await (const child of Deno.readDir(path)) children.push(child);
    } catch (caught) {
      const message = `无法读取目录：${
        caught instanceof Error ? caught.message : String(caught)
      }`;
      errors.push(`${relativePath || "."}: ${message}`);
      return;
    }
    children.sort((left, right) => left.name.localeCompare(right.name, "zh"));

    for (const child of children) {
      const childRel = relativePath ? `${relativePath}/${child.name}` : child.name;
      if (isManagedImportName(child.name)) {
        warnings.push(`${childRel}: 已跳过工作台管理文件或构建目录`);
        continue;
      }
      if (child.name.startsWith(".")) continue;
      const childPath = join(path, child.name);
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.lstat(childPath);
      } catch (caught) {
        errors.push(
          `${childRel}: 无法读取：${caught instanceof Error ? caught.message : String(caught)}`,
        );
        continue;
      }
      if (stat.isSymlink) {
        warnings.push(`${childRel}: 已跳过符号链接，避免越过所选文件夹`);
        continue;
      }

      if (stat.isDirectory) {
        let identity = normalize(childPath);
        try {
          identity = await Deno.realPath(childPath);
        } catch { /* readDir above reports the useful error */ }
        if (visited.has(identity)) {
          warnings.push(`${childRel}: 已跳过重复目录`);
          continue;
        }
        visited.add(identity);
        await walk(childPath, childRel);
        continue;
      }
      if (!stat.isFile) {
        warnings.push(`${childRel}: 已跳过非普通文件`);
        continue;
      }

      const kind = mediaKindForName(child.name);
      if (!kind) continue;
      // Never let one unreadable descendant fail the whole batch.
      try {
        const handle = await Deno.open(childPath, { read: true });
        handle.close();
      } catch (caught) {
        errors.push(
          `${childRel}: 无法读取文件：${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        );
        continue;
      }
      const mime = mimeFor(child.name) ??
        (kind === "image" ? "image/*" : "video/*");
      entries.push({
        relative_path: childRel,
        filename: child.name,
        mime,
        kind,
        size: Number.isFinite(stat.size) ? Number(stat.size) : 0,
      });
    }
  }

  await walk(absolute, rel);
  entries.sort((left, right) =>
    left.relative_path.localeCompare(right.relative_path, "zh")
  );
  return {
    root: resolved,
    relative_dir: rel,
    entries,
    warnings,
    errors,
  };
}

/** Preview kinds returned by readFolderPreview (§28). */
export type FolderPreviewKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "reference"
  | "unsupported"
  | "directory";

export interface FolderPreviewResult {
  relative_path: string;
  mime: string | null;
  size: number | null;
  preview_kind: FolderPreviewKind;
  text: string | null;
  bytes_base64: string | null;
  /** Set for DOCX and other non-editable references. */
  note: string | null;
  error?: string | null;
}

export interface FolderSourceResult {
  relative_path: string;
  size: number;
  sha256: string;
  text: string;
}

export interface MarkdownImageStatus {
  status: "present" | "missing" | "unsafe" | "error";
  relative_path: string | null;
  size: number | null;
  mime: string | null;
  message?: string;
}

const PREVIEW_TEXT_LIMIT = 512 * 1024;
const PREVIEW_MEDIA_LIMIT = 16 * 1024 * 1024;

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function previewKindForName(name: string, mime: string | null): FolderPreviewKind {
  const lowerMime = String(mime || "").toLowerCase();
  if (lowerMime.startsWith("text/") || TEXT_EXTENSIONS.has(extension(name))) {
    return "text";
  }
  if (lowerMime.startsWith("image/") || /^\.(png|jpe?g|gif|webp|svg|avif)$/i.test(extension(name))) {
    return "image";
  }
  if (lowerMime.startsWith("video/") || /^\.(mp4|webm|mov|m4v)$/i.test(extension(name))) {
    return "video";
  }
  if (lowerMime.startsWith("audio/") || /^\.(mp3|wav|m4a|ogg)$/i.test(extension(name))) {
    return "audio";
  }
  if (extension(name) === ".pdf" || lowerMime === "application/pdf") return "pdf";
  if (WORD_EXTENSIONS.has(extension(name)) || /word|document/.test(lowerMime)) {
    return "reference";
  }
  return "unsupported";
}

/**
 * Read-only preview payload for one path under a previously scanned root.
 * Does not write Canonical / project.json. PDFs return bounded bytes for a
 * controlled viewer; DOCX stays a metadata-only reference until parsed safely.
 */
export async function readFolderPreview(
  root: string,
  relativePath: string,
): Promise<FolderPreviewResult> {
  const resolvedRoot = await assertScanRoot(root);
  const rel = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!rel || rel.includes("\0") || rel.split("/").some((part) => part === "..")) {
    throw new Error("预览路径无效");
  }
  const absolute = join(resolvedRoot, ...rel.split("/").filter(Boolean));
  // Ensure the resolved path stays inside the scan root.
  toRelative(resolvedRoot, absolute);

  try {
    if (await hasSymlinkComponent(resolvedRoot, rel)) {
      return {
        relative_path: rel,
        mime: null,
        size: null,
        preview_kind: "unsupported",
        text: null,
        bytes_base64: null,
        note: null,
        error: "已跳过符号链接，避免越过所选文件夹",
      };
    }
  } catch (caught) {
    return {
      relative_path: rel,
      mime: mimeFor(basename(absolute)),
      size: null,
      preview_kind: "unsupported",
      text: null,
      bytes_base64: null,
      note: null,
      error: `无法读取：${caught instanceof Error ? caught.message : String(caught)}`,
    };
  }

  let stat: Deno.FileInfo;
  try {
    stat = await Deno.lstat(absolute);
  } catch (caught) {
    return {
      relative_path: rel,
      mime: mimeFor(basename(absolute)),
      size: null,
      preview_kind: "unsupported",
      text: null,
      bytes_base64: null,
      note: null,
      error: `无法读取：${caught instanceof Error ? caught.message : String(caught)}`,
    };
  }
  if (stat.isSymlink) {
    return {
      relative_path: rel,
      mime: null,
      size: null,
      preview_kind: "unsupported",
      text: null,
      bytes_base64: null,
      note: null,
      error: "已跳过符号链接，避免越过所选文件夹",
    };
  }
  if (stat.isDirectory) {
    return {
      relative_path: rel,
      mime: null,
      size: null,
      preview_kind: "directory",
      text: null,
      bytes_base64: null,
      note: "文件夹",
    };
  }

  const mime = mimeFor(basename(absolute));
  const kind = previewKindForName(basename(absolute), mime);
  const size = Number.isFinite(stat.size) ? Number(stat.size) : null;

  if (kind === "reference") {
    return {
      relative_path: rel,
      mime,
      size,
      preview_kind: "reference",
      text: null,
      bytes_base64: null,
      note: "参考文件 · 仅显示文件信息",
    };
  }
  if (kind === "unsupported") {
    return {
      relative_path: rel,
      mime,
      size,
      preview_kind: "unsupported",
      text: null,
      bytes_base64: null,
      note: "当前版本暂不支持预览此类型",
    };
  }

  if (size === 0) {
    return {
      relative_path: rel,
      mime,
      size,
      preview_kind: kind,
      text: null,
      bytes_base64: null,
      note: null,
      error: "文件为空，无法预览",
    };
  }

  const limit = kind === "text" ? PREVIEW_TEXT_LIMIT : PREVIEW_MEDIA_LIMIT;
  if (size != null && size > limit) {
    const limitLabel = kind === "text" ? "512 KiB" : "16 MiB";
    const message = `文件超过单文件预览上限（${limitLabel}），无法在资源浏览器内读取`;
    return {
      relative_path: rel,
      mime,
      size,
      preview_kind: kind,
      text: null,
      bytes_base64: null,
      note: message,
      error: message,
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(absolute);
  } catch (caught) {
    return {
      relative_path: rel,
      mime,
      size,
      preview_kind: kind,
      text: null,
      bytes_base64: null,
      note: null,
      error: `无法读取文件：${caught instanceof Error ? caught.message : String(caught)}`,
    };
  }

  if (kind === "text") {
    return {
      relative_path: rel,
      mime,
      size: bytes.byteLength,
      preview_kind: "text",
      text: new TextDecoder().decode(bytes),
      bytes_base64: null,
      note: null,
    };
  }

  if (kind === "pdf" && new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    return {
      relative_path: rel,
      mime,
      size: bytes.byteLength,
      preview_kind: kind,
      text: null,
      bytes_base64: null,
      note: null,
      error: "PDF 文件内容无效或已损坏，无法预览",
    };
  }

  return {
    relative_path: rel,
    mime,
    size: bytes.byteLength,
    preview_kind: kind,
    text: null,
    bytes_base64: encodeBase64(bytes),
    note: null,
  };
}

/** Revalidate a scanned video path for a short-lived, ranged preview source. */
export async function resolveFolderVideoSource(
  root: string,
  relativePath: string,
): Promise<{ path: string; mime: string; size: number }> {
  const resolvedRoot = await assertScanRoot(root);
  const rel = String(relativePath || "").replaceAll("\\", "/");
  const parts = rel.split("/");
  if (!rel || rel.includes("\0") || isAbsolute(rel) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("预览路径无效");
  }
  const absolute = join(resolvedRoot, ...parts);
  toRelative(resolvedRoot, absolute);
  let cursor = resolvedRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    if ((await Deno.lstat(cursor)).isSymlink) throw new Error("视频来源包含符号链接");
  }
  const stat = await Deno.stat(absolute);
  if (!stat.isFile) throw new Error("视频来源不是文件");
  const mime = mimeFor(basename(absolute)) || "application/octet-stream";
  if (previewKindForName(basename(absolute), mime) !== "video" || !mime.startsWith("video/")) {
    throw new Error("该文件不是受支持的视频格式");
  }
  const realRoot = await Deno.realPath(resolvedRoot);
  const realTarget = await Deno.realPath(absolute);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
    throw new Error("视频来源超出所选文件夹");
  }
  const realStat = await Deno.stat(realTarget);
  if (!realStat.isFile) throw new Error("视频来源不是文件");
  return { path: realTarget, mime, size: realStat.size };
}

/** Read one explicitly selected text source for the shared Markdown parser. */
export async function readFolderSource(
  root: string,
  relativePath: string,
): Promise<FolderSourceResult> {
  const resolvedRoot = await assertScanRoot(root);
  const rel = String(relativePath || "").replaceAll("\\", "/");
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length || rel.includes("\0") || isAbsolute(rel) || parts.some((part) => part === ".." || part === ".")) {
    throw new Error("导入源路径无效");
  }
  const absolute = join(resolvedRoot, ...parts);
  toRelative(resolvedRoot, absolute);
  if (await hasSymlinkComponent(resolvedRoot, rel)) {
    throw new Error("导入源路径包含符号链接");
  }
  const stat = await Deno.stat(absolute);
  if (!stat.isFile) throw new Error("导入源必须是文件");
  const bytes = await Deno.readFile(absolute);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return {
    relative_path: rel,
    size: bytes.byteLength,
    sha256: await sha256Bytes(bytes),
    text,
  };
}

export async function inspectMarkdownImage(
  root: string,
  markdownRelativePath: string,
  href: string,
): Promise<MarkdownImageStatus> {
  const resolvedRoot = await assertScanRoot(root);
  const markdownRel = String(markdownRelativePath || "").replaceAll("\\", "/");
  const sourceParts = markdownRel.split("/");
  if (!markdownRel || markdownRel.includes("\0") || isAbsolute(markdownRel) || sourceParts.some((part) => !part || part === "." || part === "..")) {
    return { status: "unsafe", relative_path: null, size: null, mime: null, message: "Markdown源路径无效" };
  }
  const sourcePath = join(resolvedRoot, ...sourceParts);
  try {
    if (await hasSymlinkComponent(resolvedRoot, markdownRel)) {
      return { status: "unsafe", relative_path: null, size: null, mime: null, message: "Markdown源路径包含符号链接" };
    }
    if (!(await Deno.stat(sourcePath)).isFile) {
      return { status: "unsafe", relative_path: null, size: null, mime: null, message: "Markdown源必须是文件" };
    }
  } catch (caught) {
    if (caught instanceof Deno.errors.NotFound) {
      return { status: "error", relative_path: null, size: null, mime: null, message: "Markdown源文件不存在" };
    }
    return { status: "error", relative_path: null, size: null, mime: null, message: "无法检查Markdown源文件" };
  }

  const rawHref = String(href || "").trim();
  const imagePath = rawHref.split(/[?#]/, 1)[0] || "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(imagePath);
  } catch {
    return { status: "unsafe", relative_path: null, size: null, mime: null, message: "图片路径编码无效" };
  }
  if (
    !decoded || decoded.startsWith("/") || decoded.startsWith("\\") ||
    decoded.includes("\\") || decoded.includes("\0") || decoded.includes(":") ||
    /^[a-z][a-z\d+.-]*:/i.test(decoded)
  ) {
    return { status: "unsafe", relative_path: null, size: null, mime: null, message: "仅允许所选文件夹内的本地图片" };
  }
  const relativePath = normalize(join(dirname(markdownRel), decoded)).replaceAll("\\", "/");
  if (!relativePath || relativePath === "." || relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    return { status: "unsafe", relative_path: null, size: null, mime: null, message: "图片引用超出所选文件夹" };
  }
  const absolute = join(resolvedRoot, ...relativePath.split("/"));
  toRelative(resolvedRoot, absolute);
  try {
    if (await hasSymlinkComponent(resolvedRoot, relativePath)) {
      return { status: "unsafe", relative_path: relativePath, size: null, mime: null, message: "图片依赖不能经过符号链接" };
    }
  } catch (caught) {
    if (caught instanceof Deno.errors.NotFound) {
      return { status: "missing", relative_path: relativePath, size: null, mime: mimeFor(basename(absolute)) };
    }
    return { status: "error", relative_path: relativePath, size: null, mime: mimeFor(basename(absolute)), message: "无法检查图片依赖" };
  }
  try {
    const canonical = await Deno.realPath(absolute);
    toRelative(await Deno.realPath(resolvedRoot), canonical);
    const stat = await Deno.stat(canonical);
    if (!stat.isFile) {
      return { status: "unsafe", relative_path: relativePath, size: null, mime: mimeFor(basename(absolute)), message: "图片依赖不是文件" };
    }
    return { status: "present", relative_path: relativePath, size: stat.size, mime: mimeFor(basename(absolute)) };
  } catch (caught) {
    if (caught instanceof Deno.errors.NotFound) {
      return { status: "missing", relative_path: relativePath, size: null, mime: mimeFor(basename(absolute)) };
    }
    return { status: "error", relative_path: relativePath, size: null, mime: mimeFor(basename(absolute)), message: "无法检查图片依赖" };
  }
}
