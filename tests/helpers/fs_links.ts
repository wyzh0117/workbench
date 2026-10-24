/**
 * Link fixtures for escape-rejection tests.
 *
 * POSIX escape links are symbolic links. Windows only allows unprivileged
 * symlinks under Developer Mode, so when a directory link is enough the
 * helper falls back to a directory junction: Deno reports junctions as
 * symlinks (`lstat().isSymlink === true`), so the code under test must reject
 * them exactly like POSIX symlinks. File links cannot be junctions; when the
 * OS refuses the symlink the caller receives `false` and should skip that
 * scenario instead of faking it.
 */

export function isPrivilegeError(caught: unknown): boolean {
  if (caught instanceof Deno.errors.PermissionDenied) return true;
  if (caught instanceof TypeError) return true; // Windows needs explicit link options
  const code = (caught as { code?: string })?.code ?? "";
  return code === "EPERM" || code === "EACCES";
}

/**
 * Create an escape link at `link` pointing at `target`.
 * Returns `false` when the platform requires a privilege this process lacks;
 * throws for real failures.
 */
export async function createEscapeLink(
  target: string,
  link: string,
  kind: "file" | "dir",
): Promise<boolean> {
  if (Deno.build.os !== "windows") {
    await Deno.symlink(target, link, kind === "dir" ? { type: "dir" } : { type: "file" });
    return true;
  }
  try {
    await Deno.symlink(target, link, kind === "dir" ? { type: "dir" } : { type: "file" });
    return true;
  } catch (caught) {
    if (!isPrivilegeError(caught)) throw caught;
  }
  if (kind === "file") return false; // junctions only exist for directories
  const command = new Deno.Command("cmd.exe", {
    args: ["/c", "mklink", "/J", link, target],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
  const output = await command.output();
  return output.code === 0;
}
