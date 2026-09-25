/**
 * Read-only folder scan for V1-T04 import-folder entry (§§26, 29, 38).
 *
 * Produces ScanResult metadata only. Does not write project.json, move files,
 * or read file contents into Canonical. Symlink roots/children are rejected or
 * skipped; a single unreadable entry degrades without failing the tree.
 */
import { basename, extname, isAbsolute, join, normalize, relative } from "node:path";

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

/** Metadata-only scan; warn when a file exceeds this size (do not read bytes). */
export const SCAN_LARGE_FILE_BYTES = 100 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text"]);
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
 * Recursively scan `root` into a flat list of ScanResult rows.
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
