/**
 * Item 2 — §4.2/§4.3 applied: choosing a directory row in Mapping Preview must
 * contribute every image and video beneath it as a Media Library asset, even
 * though the preview listing itself stays flat (§4.1).  Nothing may be inserted
 * into Lesson content and no AssetUsage may exist merely because a folder was
 * selected.
 *
 * This is the Deno twin of `folder_adopt_selected_directory_imports_descendant_media_only`
 * in src-tauri/src/lib.rs.
 */
import { buildImportMappingPlan, confirmImportMappingPlan } from "../src/service/folder_mapping.ts";
import type { ImportMappingPlan } from "../src/service/folder_mapping.ts";
import { scanFolder } from "../src/service/folder_scan.ts";
import { confirmFolderAdoption } from "../src/service/folder_adoption.ts";
import { createEscapeLink } from "./helpers/fs_links.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message = "values differ"): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

async function withTempDir(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix });
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function join(root: string, ...parts: string[]): string {
  return `${root}/${parts.join("/")}`;
}

async function writeBytes(path: string, bytes: number[]): Promise<void> {
  await Deno.writeFile(path, new Uint8Array(bytes));
}

/** A confirmed plan whose only chosen row is the `course` directory itself. */
async function directoryPlan(root: string, selected: boolean): Promise<ImportMappingPlan> {
  const report = await scanFolder(root);
  const plan = buildImportMappingPlan(report.root, report.entries);
  plan.items = plan.items.filter((item) =>
    item.kind === "directory" && item.relative_path === "course"
  );
  for (const item of plan.items) {
    item.mapping = "stage";
    item.selected = selected;
  }
  assert(plan.items.length === 1, "the flat scan must offer the selected directory row");
  return confirmImportMappingPlan(plan);
}

async function seedCourse(root: string): Promise<void> {
  await Deno.mkdir(join(root, "course", "deep"), { recursive: true });
  await Deno.mkdir(join(root, "course", "a"), { recursive: true });
  await Deno.mkdir(join(root, "course", "b"), { recursive: true });
  await writeBytes(join(root, "course", "deep", "shot.png"), [7, 8, 9]);
  await writeBytes(join(root, "course", "deep", "clip.mp4"), [1, 2, 3, 4]);
  await writeBytes(join(root, "course", "deep", "twin.png"), [7, 8, 9]); // same checksum
  await writeBytes(join(root, "course", "a", "icon.png"), [100]);
  await writeBytes(join(root, "course", "b", "icon.png"), [200]);
  await Deno.writeTextFile(join(root, "course", "deep", "notes.md"), "# 不要导入\n");
  await writeBytes(join(root, "course", "deep", "song.mp3"), [9]);
}

Deno.test("a selected directory imports descendant media as assets only", async () => {
  await withTempDir("acw-descendant-adoption-", async (root) => {
    await seedCourse(root);
    const plan = await directoryPlan(root, true);
    const result = await confirmFolderAdoption(plan, { skip_project_write: true });

    const names = result.data.assets.map((asset) => asset.filename).sort();
    assertEquals(names, ["clip.mp4", "icon.png", "icon.png", "shot.png"], "eligible descendants");
    assertEquals(result.reused_asset_ids.length, 1, "the checksum duplicate reuses one asset");
    assert(
      !names.some((name) => name.endsWith(".md") || name.endsWith(".mp3")),
      `documents and audio stay out: ${JSON.stringify(names)}`,
    );

    // §4.3: the library gains the media; the course itself is untouched.
    assertEquals(result.data.content_items.length, 0, "no lesson content inserted");
    assertEquals(result.data.documents.length, 0, "no lesson document created");
    assertEquals(result.data.blocks.length, 0, "no blocks created");
    assertEquals(result.data.asset_usages.length, 0, "no AssetUsage from a folder selection");
    assertEquals(result.content_item_ids.length, 0, "no content ids reported");
    assertEquals(result.data.stages.length, 1, "the directory itself is still a stage");

    assert(
      result.warnings.some((warning) => warning.includes("递归收录 5")),
      `the sweep is reported: ${JSON.stringify(result.warnings)}`,
    );

    for (const path of result.copied_files) {
      const bytes = await Deno.readFile(join(root, path));
      assert(bytes.length > 0, `managed copy ${path} is empty`);
    }
    assertEquals(
      Array.from(await Deno.readFile(join(root, "course", "deep", "shot.png"))),
      [7, 8, 9],
      "sources are never mutated",
    );
    await Deno.stat(join(root, "course", "deep", "notes.md"));
  });
});

Deno.test("folder adoption reports new media separately from Markdown references reused in the same batch", async () => {
  await withTempDir("acw-adoption-reused-markdown-assets-", async (root) => {
    await Deno.mkdir(join(root, "course", "media"), { recursive: true });
    await writeBytes(join(root, "course", "media", "shot.png"), [1, 2, 3]);
    await writeBytes(join(root, "course", "media", "loop.gif"), [4, 5, 6]);
    await writeBytes(join(root, "course", "media", "clip.mp4"), [7, 8, 9]);
    await Deno.writeTextFile(
      join(root, "course", "lesson.md"),
      "# Lesson\n\n![shot](media/shot.png)\n\n![loop](media/loop.gif)\n",
    );

    const plan = await directoryPlan(root, true);
    const result = await confirmFolderAdoption(plan, {
      skip_project_write: true,
      document_paths: ["course/lesson.md"],
    });
    const assetIds = result.data.assets.map((asset) => asset.id);
    const usageIds = result.data.asset_usages.map((usage) => usage.asset_id);

    assertEquals(result.data.assets.length, 3, "the three recursive media files create only three rows");
    assertEquals(result.copied_files.length, 3, "Markdown image references must reuse staged descendant files");
    assertEquals(result.asset_ids.length, 3, "asset_ids counts only the unique newly added Canonical rows");
    assertEquals(new Set(result.asset_ids).size, 3, "new asset IDs are unique");
    assertEquals(result.reused_asset_ids.length, 2, "each Markdown image reference is reported as a reuse event");
    assertEquals([...result.reused_asset_ids].sort(), [...usageIds].sort(), "body usages keep the real reused asset IDs");
    assert(usageIds.every((id) => assetIds.includes(id)), "every Markdown usage points at an existing Canonical asset row");
    assertEquals(result.data.asset_usages.length, 2, "both image references keep their usage rows");
  });
});

Deno.test("an unselected directory contributes no descendants", async () => {
  await withTempDir("acw-descendant-unselected-", async (root) => {
    await seedCourse(root);
    const plan = await directoryPlan(root, false);
    const result = await confirmFolderAdoption(plan, { skip_project_write: true });
    assertEquals(result.data.assets.length, 0, "nothing was swept in");
    assertEquals(result.copied_files.length, 0, "nothing was copied");
  });
});

Deno.test("descendant media never follows a symlink out of the folder", async () => {
  await withTempDir("acw-descendant-symlink-", async (root) => {
    const outside = await Deno.makeTempDir({ prefix: "acw-descendant-outside-" });
    try {
      await Deno.mkdir(join(root, "course"), { recursive: true });
      await writeBytes(join(root, "course", "keep.png"), [7]);
      await writeBytes(join(outside, "leak.png"), [42]);
      const linked = await createEscapeLink(join(outside, "leak.png"), join(root, "course", "escape.png"), "file");
      if (!linked) {
        console.warn("[skip] Windows lacks symlink privilege; descendant link escape not exercised");
        return;
      }
      const plan = await directoryPlan(root, true);
      const result = await confirmFolderAdoption(plan, { skip_project_write: true });
      const names = result.data.assets.map((asset) => asset.filename);
      assertEquals(names, ["keep.png"], "only real files inside the folder import");
      assert(
        result.warnings.some((warning) => warning.includes("符号链接")),
        `the skip is reported: ${JSON.stringify(result.warnings)}`,
      );
      assertEquals(
        Array.from(await Deno.readFile(join(outside, "leak.png"))),
        [42],
        "the file behind the link is untouched",
      );
    } finally {
      await Deno.remove(outside, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("a descendant the plan already lists keeps its own row and imports once", async () => {
  await withTempDir("acw-descendant-claimed-", async (root) => {
    await seedCourse(root);
    const report = await scanFolder(root);
    const plan = buildImportMappingPlan(report.root, report.entries);
    plan.items = plan.items.filter((item) =>
      item.kind === "directory" && item.relative_path === "course"
    );
    for (const item of plan.items) {
      item.mapping = "stage";
      item.selected = true;
    }
    // The user reached this descendant another way and made its choice explicit.
    plan.items.push({
      relative_path: "course/deep/clip.mp4",
      kind: "file",
      mime: "video/mp4",
      size: 4,
      suggested: "asset",
      mapping: "asset",
      selected: true,
      is_suggestion: true,
    });
    const result = await confirmFolderAdoption(
      confirmImportMappingPlan(plan),
      { skip_project_write: true },
    );
    const names = result.data.assets.map((asset) => asset.filename).sort();
    assertEquals(names, ["clip.mp4", "icon.png", "icon.png", "shot.png"], "imported once each");
    assert(
      result.warnings.some((warning) => warning.includes("递归收录 4")),
      `the listed path is not swept in again: ${JSON.stringify(result.warnings)}`,
    );
  });
});
