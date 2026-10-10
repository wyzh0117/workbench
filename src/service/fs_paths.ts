/**
 * Cross-platform absolute-path helpers.
 *
 * On Windows `Deno.realPath` returns backslash-separated paths and the file
 * system is case-insensitive; POSIX returns slash-separated, case-sensitive
 * paths. Every containment check must compare the normalized form of both, or
 * a valid in-root file is misreported as "outside the folder" on Windows.
 */

/** Fold a path to its comparison form: `/` separators, plus case folding on Windows. */
export function pathKey(path: string): string {
  const folded = String(path ?? "").replaceAll("\\", "/");
  return Deno.build.os === "windows" ? folded.toLowerCase() : folded;
}

/** True when `target` is `root` itself or lives underneath it. */
export function isPathWithin(root: string, target: string): boolean {
  const rootKey = pathKey(root).replace(/\/+$/, "");
  const targetKey = pathKey(target).replace(/\/+$/, "");
  return targetKey === rootKey || targetKey.startsWith(rootKey + "/");
}

/**
 * Resolve `candidate` and verify it still lives inside `root` after all links
 * (symlinks AND Windows junctions/reparse points) are followed. Throws the
 * caller's `escape` error when resolution leaves the root.
 */
export async function realPathWithin(
  root: string,
  candidate: string,
  onEscape: () => Error,
): Promise<string> {
  const realRoot = await Deno.realPath(root);
  const realTarget = await Deno.realPath(candidate);
  if (!isPathWithin(realRoot, realTarget)) throw onEscape();
  return realTarget;
}
