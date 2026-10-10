/**
 * Item 2 — a selected directory contributes descendant image/video media, while
 * the Mapping Preview listing stays flat (§4.1, §4.4).
 *
 * `scanFolder` (the preview listing) must expose only the selected folder's
 * immediate children. `scanMediaDescendants` is the separate recursive path used
 * for a directory the user explicitly selected, and it must be strictly visual
 * media, read-only and symlink/traversal safe.
 */
import { createEscapeLink } from "./helpers/fs_links.ts";
import {
  addAsset,
  createEmptyProjectData,
  scanFolder,
  scanMediaDescendants,
} from "../src/domain/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

async function buildTree(dir: string): Promise<void> {
  // Documents / audio that must never be swept in as visual media.
  await Deno.writeTextFile(`${dir}/overview.md`, "# 总览");
  await Deno.writeTextFile(`${dir}/manual.pdf`, "fake pdf");
  await Deno.writeFile(`${dir}/voice.mp3`, new Uint8Array([1, 2, 3]));
  // A selected stage directory with nested media + non-media.
  await Deno.mkdir(`${dir}/s01-00/deep`, { recursive: true });
  await Deno.writeFile(`${dir}/s01-00/cover.png`, PNG);
  await Deno.writeFile(`${dir}/s01-00/photo.jpg`, JPEG);
  await Deno.writeFile(`${dir}/s01-00/clip.mp4`, MP4);
  await Deno.writeFile(`${dir}/s01-00/anim.gif`, GIF);
  await Deno.writeFile(`${dir}/s01-00/deep/nested.png`, PNG);
  await Deno.writeTextFile(`${dir}/s01-00/notes.md`, "not media");
}

Deno.test("scanFolder keeps the Mapping Preview listing flat (immediate children only)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wb-flat-scan-" });
  try {
    await buildTree(dir);
    const report = await scanFolder(dir);
    const rels = report.entries.map((entry) => entry.relative_path);
    assert(rels.includes("s01-00"), "the stage directory row must be listed");
    assert(!rels.includes("s01-00/cover.png"), "descendant files must NOT appear in the flat scan");
    assert(!rels.includes("s01-00/deep/nested.png"), "deep files must NOT appear");
    const stageRow = report.entries.find((entry) => entry.relative_path === "s01-00");
    assert(stageRow?.kind === "directory", "s01-00 must be a directory row");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("scanMediaDescendants finds recursive image/video but excludes documents/audio", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wb-media-desc-" });
  try {
    await buildTree(dir);
    const scan = await scanMediaDescendants(dir, "s01-00");
    const paths = scan.entries.map((entry) => entry.relative_path);
    for (const expected of [
      "s01-00/cover.png",
      "s01-00/photo.jpg",
      "s01-00/clip.mp4",
      "s01-00/anim.gif",
      "s01-00/deep/nested.png",
    ]) {
      assert(paths.includes(expected), `missing descendant ${expected}`);
    }
    assert(!paths.some((path) => path.endsWith(".md")), "markdown must stay excluded");
    assert(!paths.some((path) => path.endsWith(".pdf")), "pdf must stay excluded");
    assert(!paths.some((path) => path.endsWith(".mp3")), "audio must stay excluded");
    for (const entry of scan.entries) {
      assert(
        entry.kind === "image" || entry.kind === "video",
        `only image/video allowed, got ${entry.kind}`,
      );
      assert(
        entry.mime.startsWith("image/") || entry.mime.startsWith("video/"),
        `mime must be image/video, got ${entry.mime}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("scanMediaDescendants rejects symlinked descendants that escape the root", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wb-media-symlink-" });
  const outside = await Deno.makeTempDir({ prefix: "wb-media-outside-" });
  try {
    await buildTree(dir);
    await Deno.writeFile(`${outside}/leak.png`, PNG);
    const linked = await createEscapeLink(`${outside}/leak.png`, `${dir}/s01-00/link.png`, "file");
    if (!linked) {
      console.warn("[skip] Windows lacks symlink privilege; descendant file-link escape not exercised");
      return;
    }
    const scan = await scanMediaDescendants(dir, "s01-00");
    const paths = scan.entries.map((entry) => entry.relative_path);
    assert(!paths.includes("s01-00/link.png"), "symlinked media must be skipped");
    assert(
      scan.warnings.some((warning) => warning.includes("link.png")),
      "skipping must be recorded as a warning",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    await Deno.remove(outside, { recursive: true }).catch(() => {});
  }
});

Deno.test("scanMediaDescendants rejects path traversal in the selected directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wb-media-traversal-" });
  try {
    await buildTree(dir);
    let threw = false;
    try {
      await scanMediaDescendants(dir, "../../etc");
    } catch {
      threw = true;
    }
    assert(threw, "a traversal relative path must be rejected");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("scanMediaDescendants degrades an unreadable file without failing the batch", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wb-media-degrade-" });
  try {
    await buildTree(dir);
    await Deno.writeFile(`${dir}/s01-00/locked.png`, PNG);
    // Best-effort chmod; some CI filesystems let the owner read 000 anyway.
    const unreadable = await Deno.chmod(`${dir}/s01-00/locked.png`, 0o000)
      .then(() => true)
      .catch(() => false);
    if (!unreadable) return; // platform denied chmod semantics; nothing to assert
    const scan = await scanMediaDescendants(dir, "s01-00");
    const paths = scan.entries.map((entry) => entry.relative_path);
    // The readable siblings still made it through despite one bad file.
    assert(paths.includes("s01-00/cover.png"), "batch must continue past the unreadable file");
    if (!paths.includes("s01-00/locked.png")) {
      assert(
        scan.errors.some((error) => error.includes("locked.png")),
        "the unreadable file must be recorded as a degraded error",
      );
    }
    await Deno.chmod(`${dir}/s01-00/locked.png`, 0o644);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("scanMediaDescendants never mutates the source tree", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wb-media-nomutate-" });
  try {
    await buildTree(dir);
    const before = await Deno.readFile(`${dir}/s01-00/cover.png`);
    const statBefore = await Deno.stat(`${dir}/s01-00/cover.png`);
    await scanMediaDescendants(dir, "s01-00");
    const after = await Deno.readFile(`${dir}/s01-00/cover.png`);
    const statAfter = await Deno.stat(`${dir}/s01-00/cover.png`);
    assert(before.length === after.length, "byte length must be unchanged");
    assert(before.every((byte, index) => byte === after[index]), "bytes must be unchanged");
    assert(statBefore.mtime?.getTime() === statAfter.mtime?.getTime(), "mtime must be unchanged");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("asset layer dedupes by checksum and keeps same-name/different-bytes apart", () => {
  const data = createEmptyProjectData("课程");
  const projectId = data.project.id;
  const first = addAsset(data, projectId, {
    type: "image",
    filename: "cover.png",
    storage_path: `assets/${data.project.id}-cover.png`,
    mime_type: "image/png",
    checksum: "abc",
    file_size: 8,
  });
  assert(!first.duplicate, "the first checksum-seen asset is new");
  // Same bytes (checksum) reused elsewhere → duplicate, no new row.
  const dup = addAsset(data, projectId, {
    type: "image",
    filename: "cover-copy.png",
    storage_path: `assets/${data.project.id}-cover-copy.png`,
    mime_type: "image/png",
    checksum: "abc",
    file_size: 8,
  });
  assert(dup.duplicate, "identical checksum must dedupe");
  assert(dup.asset.id === first.asset.id, "dedupe reuses the existing row");
  // Same filename, different bytes → distinct assets (collision safety).
  const clash = addAsset(data, projectId, {
    type: "image",
    filename: "cover.png",
    storage_path: `assets/${data.project.id}-cover.png`,
    mime_type: "image/png",
    checksum: "xyz-different",
    file_size: 8,
  });
  assert(!clash.duplicate, "same name but different bytes must not dedupe");
  assert(clash.asset.id !== first.asset.id, "a distinct row is created");
});
