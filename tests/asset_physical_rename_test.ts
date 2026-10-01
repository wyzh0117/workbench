/**
 * Item 13 — renaming a managed asset must rename the physical file and keep every
 * canonical reference in lockstep (§14.1–§14.5).
 *
 * The pure layer (`planAssetRename` / `applyAssetRename`) is checked in isolation,
 * then the storage transaction (`ProjectDirectoryStore.renameManagedAsset`) is
 * exercised end-to-end against a real temp project directory: preflight →
 * filesystem rename → canonical rewrite → save, with rollback on save failure and
 * a reversible Undo/Redo round-trip.
 */
import {
  addAsset,
  addAssetUsage,
  appendBlock,
  applyAssetRename,
  createDocument,
  createEmptyProjectData,
  isAssetRenameNoop,
  planAssetRename,
  ProjectDirectoryStore,
} from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ASSET_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

/** A valid project with one image asset, a content item, and a media block that
 * embeds the managed path and links the asset by id. */
function projectWithAsset(): { data: ProjectData; assetId: string; blockId: string } {
  const data = createEmptyProjectData("重命名单元");
  const projectId = data.project.id;
  const assetId = "asset-fixed-id";
  const storagePath = `assets/${assetId}-cover.png`;
  // Build the asset row directly so the id is deterministic; `addAsset` would
  // mint its own uuid and store the storage path verbatim.
  data.assets.push({
    id: assetId,
    project_id: projectId,
    type: "image",
    filename: "cover.png",
    storage_path: storagePath,
    mime_type: "image/png",
    width: null,
    height: null,
    duration_ms: null,
    file_size: ASSET_BYTES.length,
    checksum: "checksum-abc",
    title: "cover.png",
    description: "",
    source_type: "imported",
    source_url: null,
    copyright_note: null,
    created_at: new Date().toISOString(),
    archived: false,
  });
  const contentId = "content-fixed-id";
  const document = createDocument(data, contentId);
  data.content_items.push({
    id: contentId,
    project_id: projectId,
    stage_id: data.stages[0]?.id ?? null,
    code: "S01-01",
    title: "第一课",
    type: "lesson",
    description: "",
    order_index: 0,
    document_id: document.id,
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const block = appendBlock(
    data,
    contentId,
    "image",
    `![封面](${storagePath})`,
    { asset_id: assetId },
  );
  addAssetUsage(data, assetId, contentId, { block_id: block.id });
  return { data, assetId, blockId: block.id };
}

// ---------------------------------------------------------------------------
// Pure: planning + name validation
// ---------------------------------------------------------------------------

Deno.test("planAssetRename preserves the extension and rebuilds the managed path", () => {
  const { data, assetId } = projectWithAsset();
  const plan = planAssetRename(data, assetId, "diagram");
  assert(plan.new_filename === "diagram.png", `got ${plan.new_filename}`);
  assert(
    plan.new_storage_path === `assets/${assetId}-diagram.png`,
    `got ${plan.new_storage_path}`,
  );
  // A user who retypes the extension must not get it doubled.
  const retyped = planAssetRename(data, assetId, "diagram.png");
  assert(retyped.new_filename === "diagram.png", `got ${retyped.new_filename}`);
  assert(!isAssetRenameNoop(plan), "cover.png → diagram.png is a real change");
});

Deno.test("planAssetRename detects a noop when nothing changes", () => {
  const { data, assetId } = projectWithAsset();
  const plan = planAssetRename(data, assetId, "cover");
  assert(isAssetRenameNoop(plan), "cover → cover.png must be a noop");
});

Deno.test("planAssetRename rejects unsafe names (§14.3)", () => {
  const { data, assetId } = projectWithAsset();
  for (const bad of ["", "   ", "a/b", "a\\b", "..", ".", "C:\\evil", "dr\u0000ive"]) {
    let threw = false;
    try {
      planAssetRename(data, assetId, bad);
    } catch {
      threw = true;
    }
    assert(threw, `name ${JSON.stringify(bad)} must be rejected`);
  }
});

Deno.test("applyAssetRename rewrites every reference and keeps id + checksum stable", () => {
  const { data, assetId, blockId } = projectWithAsset();
  const before = structuredClone(data);
  const plan = planAssetRename(data, assetId, "diagram");
  const usageCount = data.asset_usages.length;
  const rewritten = applyAssetRename(data, plan);
  assert(rewritten >= 1, "the storage path rewrite must be counted");

  const asset = data.assets.find((candidate) => candidate.id === assetId)!;
  assert(asset.id === before.assets[0]?.id, "asset id must not change");
  assert(asset.checksum === "checksum-abc", "checksum/content identity must not change");
  assert(asset.filename === "diagram.png", `filename got ${asset.filename}`);
  assert(
    asset.storage_path === `assets/${assetId}-diagram.png`,
    `storage_path got ${asset.storage_path}`,
  );
  const block = data.blocks.find((candidate) => candidate.id === blockId)!;
  const content = String(block.content);
  assert(
    content.includes(`assets/${assetId}-diagram.png`) &&
      !content.includes(`assets/${assetId}-cover.png`),
    `block embed must be rewritten: ${content}`,
  );
  assert(data.asset_usages.length === usageCount, "AssetUsage rows stay stable");
});

// ---------------------------------------------------------------------------
// Storage transaction (real files on disk)
// ---------------------------------------------------------------------------

async function openStore(dir: string): Promise<ProjectDirectoryStore> {
  const store = new ProjectDirectoryStore(dir);
  await store.open();
  return store;
}

async function seedProject(store: ProjectDirectoryStore, data: ProjectData, assetId: string) {
  await Deno.mkdir(`${store.directory}/assets`, { recursive: true });
  await Deno.writeFile(`${store.directory}/assets/${assetId}-cover.png`, ASSET_BYTES);
  await store.writeProject(data);
}

async function readProject(dir: string): Promise<ProjectData> {
  return JSON.parse(await Deno.readTextFile(`${dir}/project.json`)) as ProjectData;
}

Deno.test("renameManagedAsset moves the file and rewrites the saved canonical project", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wb-rename-e2e-" });
  let store: ProjectDirectoryStore | null = null;
  try {
    const { data, assetId } = projectWithAsset();
    store = await openStore(dir);
    await seedProject(store, data, assetId);

    const outcome = await store.renameManagedAsset(data, assetId, "diagram");
    assert(outcome.status === "renamed", `got ${outcome.status}`);

    // Physical file moved; original gone; bytes identical.
    const statNew = await Deno.stat(`${dir}/assets/${assetId}-diagram.png`);
    assert(statNew.isFile, "renamed file must exist");
    let oldGone = false;
    try {
      await Deno.stat(`${dir}/assets/${assetId}-cover.png`);
    } catch {
      oldGone = true;
    }
    assert(oldGone, "the original file must no longer exist");
    const written = await Deno.readFile(`${dir}/assets/${assetId}-diagram.png`);
    assert(
      written.every((byte, index) => byte === ASSET_BYTES[index]),
      "renamed file bytes must be unchanged",
    );

    // Canonical on disk updated, id + checksum stable.
    const persisted = await readProject(dir);
    const asset = persisted.assets.find((candidate) => candidate.id === assetId)!;
    assert(asset.storage_path === `assets/${assetId}-diagram.png`, "saved storage_path updated");
    assert(asset.filename === "diagram.png", "saved filename updated");
    assert(asset.checksum === "checksum-abc", "saved checksum unchanged");
    const block = persisted.blocks.find((candidate) =>
      String(candidate.settings.asset_id ?? "") === assetId
    )!;
    assert(
      String(block.content).includes(`assets/${assetId}-diagram.png`),
      "saved block embed updated",
    );
  } finally {
    await store?.close().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("renameManagedAsset rejects a filesystem collision and keeps the original", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wb-rename-collide-" });
  let store: ProjectDirectoryStore | null = null;
  try {
    const { data, assetId } = projectWithAsset();
    store = await openStore(dir);
    await seedProject(store, data, assetId);
    // A stray file already occupies the exact managed target path.
    await Deno.writeFile(`${dir}/assets/${assetId}-taken.png`, new Uint8Array([9]));

    let threw = false;
    try {
      await store.renameManagedAsset(data, assetId, "taken");
    } catch {
      threw = true;
    }
    assert(threw, "collision with an existing file must be rejected");
    // Nothing moved: the original is intact and the collision file is untouched.
    assert((await Deno.stat(`${dir}/assets/${assetId}-cover.png`)).isFile, "original must survive");
    assert((await Deno.stat(`${dir}/assets/${assetId}-taken.png`)).isFile, "collider must survive");
  } finally {
    await store?.close().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("renameManagedAsset rolls the file back when the canonical save fails", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wb-rename-rollback-" });
  let store: ProjectDirectoryStore | null = null;
  try {
    const { data, assetId } = projectWithAsset();
    store = await openStore(dir);
    await seedProject(store, data, assetId);
    // Make the on-disk project diverge from the store baseline so the canonical
    // write inside the transaction throws (a genuine save failure).
    const diverged = structuredClone(data);
    diverged.project.title = "外部修改";
    await Deno.writeTextFile(`${dir}/project.json`, JSON.stringify(diverged));

    let threw = false;
    try {
      await store.renameManagedAsset(data, assetId, "diagram");
    } catch {
      threw = true;
    }
    assert(threw, "a failing save must surface as an error, not a silent success");
    // Rollback restored the original file and removed the renamed one.
    assert((await Deno.stat(`${dir}/assets/${assetId}-cover.png`)).isFile, "original restored");
    let renamedExists = true;
    try {
      await Deno.stat(`${dir}/assets/${assetId}-diagram.png`);
    } catch {
      renamedExists = false;
    }
    assert(!renamedExists, "the rolled-back file must not linger under the new name");
  } finally {
    await store?.close().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("renameManagedAsset is reversible — Undo/Redo round-trip (§14.5)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wb-rename-undo-" });
  let store: ProjectDirectoryStore | null = null;
  try {
    const { data, assetId } = projectWithAsset();
    store = await openStore(dir);
    await seedProject(store, data, assetId);

    const forward = await store.renameManagedAsset(data, assetId, "diagram");
    assert(forward.status === "renamed", `forward rename got ${forward.status}`);
    // Undo: rename back using the previous basename.
    const back = await store.renameManagedAsset(forward.project, assetId, "cover");
    assert(back.status === "renamed", `undo got ${back.status}`);
    assert((await Deno.stat(`${dir}/assets/${assetId}-cover.png`)).isFile, "file back to original");
    const restored = back.project.assets.find((candidate) => candidate.id === assetId)!;
    assert(restored.storage_path === `assets/${assetId}-cover.png`, "storage_path restored");
    assert(restored.checksum === "checksum-abc", "identity preserved through undo");
  } finally {
    await store?.close().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
