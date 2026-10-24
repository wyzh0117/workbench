import { createHash } from "node:crypto";
import { join, normalize } from "node:path";
import { createEscapeLink } from "./helpers/fs_links.ts";
import type { ProjectData } from "../src/domain/types.ts";
import {
  DesktopService,
  getAssetPreviewBatchMetrics,
  setAssetPreviewBatchDiagnosticsEnabled,
} from "../src/service/desktop.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asset(project: ProjectData, id: string, path: string, bytes: Uint8Array, checksum = hash(bytes)) {
  project.assets.push({
    id,
    project_id: project.project.id,
    type: "image",
    filename: `${id}.bin`,
    storage_path: path,
    mime_type: "image/png",
    width: null,
    height: null,
    duration_ms: null,
    file_size: bytes.byteLength,
    checksum,
    title: id,
    description: "",
    source_type: "imported",
    source_url: null,
    copyright_note: null,
    created_at: new Date().toISOString(),
    archived: false,
  });
}

Deno.test("asset.preview_batch binds Canonical once, enforces raw budget and isolates rows", async () => {
  const directory = await Deno.makeTempDir({ prefix: "asset-preview-batch-" });
  const outsideDirectory = await Deno.makeTempDir({ prefix: "asset-preview-batch-outside-" });
  const desktop = new DesktopService(directory, {
    app_instance_id: `asset-preview-${crypto.randomUUID()}`,
  });
  try {
    await desktop.open();
    const created = await desktop.commands.execute("project.create", { title: "Preview batch" });
    assert(!created.error, "test project should be created");
    const project = created.value as ProjectData;
    const assetsDirectory = join(directory, "assets");
    await Deno.mkdir(assetsDirectory, { recursive: true });

    const first = new Uint8Array(8 * 1024 * 1024);
    const second = new Uint8Array(8 * 1024 * 1024);
    for (let index = 0; index < first.length; index += 1) {
      first[index] = (index * 31 + 17) & 0xff;
      second[index] = (index * 47 + 91) & 0xff;
    }
    const deferredBytes = new Uint8Array([42]);
    const empty = new Uint8Array();
    const corrupt = new Uint8Array([4, 5, 6]);
    const oversize = new Uint8Array(8 * 1024 * 1024 + 1);
    await Deno.writeFile(join(assetsDirectory, "first.bin"), first);
    await Deno.writeFile(join(assetsDirectory, "second.bin"), second);
    await Deno.writeFile(join(assetsDirectory, "deferred.bin"), deferredBytes);
    await Deno.writeFile(join(assetsDirectory, "empty.bin"), empty);
    await Deno.writeFile(join(assetsDirectory, "corrupt.bin"), corrupt);
    await Deno.writeFile(join(assetsDirectory, "oversize.bin"), oversize);
    const linked = await createEscapeLink(outsideDirectory, join(assetsDirectory, "unsafe-link.bin"), "dir");
    if (!linked) {
      console.warn("[skip] Windows lacks symlink privilege; unsafe-link isolation not exercised");
      return;
    }

    asset(project, "asset-first", "assets/first.bin", first);
    asset(project, "asset-second", "assets/second.bin", second);
    asset(project, "asset-deferred", "assets/deferred.bin", deferredBytes);
    asset(project, "asset-empty", "assets/empty.bin", empty);
    asset(project, "asset-corrupt", "assets/corrupt.bin", corrupt, "0".repeat(64));
    asset(project, "asset-oversize", "assets/oversize.bin", oversize);
    project.assets.push({
      ...project.assets[0]!,
      id: "asset-unsafe-path",
      storage_path: "assets/unsafe-link.bin",
      checksum: hash(new Uint8Array()),
    });
    await desktop.store.writeProject(project);
    const state = await desktop.store.readProjectSnapshot();
    const baseRequest = {
      project_dir: `${normalize(directory)}/.`,
      project_id: project.project.id,
      fingerprint: state.fingerprint,
    };
    setAssetPreviewBatchDiagnosticsEnabled(false);
    const unmeasured = await desktop.commands.execute("asset.preview_batch", {
      ...baseRequest,
      request_generation: 10,
      asset_ids: ["asset-empty"],
    });
    assert(!unmeasured.error, "an unmeasured small request should complete");
    const disabledMetrics = getAssetPreviewBatchMetrics();
    assert(
      disabledMetrics.batches === 0 && disabledMetrics.source_file_opens === 0,
      "preview diagnostics must be disabled by default",
    );
    setAssetPreviewBatchDiagnosticsEnabled(true);
    const result = await desktop.commands.execute("asset.preview_batch", {
      ...baseRequest,
      request_generation: 11,
      asset_ids: [
        "missing-asset",
        "asset-corrupt",
        "asset-unsafe-path",
        "asset-first",
        "asset-second",
        "asset-deferred",
        "asset-empty",
        "asset-oversize",
      ],
    });
    assert(!result.error, "valid batch should return per-item results");
    const value = result.value as {
      project_id: string;
      fingerprint: { hash: string | null };
      request_generation: number;
      items: Array<{ asset_id: string; status: string; bytes_base64?: string; error?: { code: string } }>;
    };
    assert(value.project_id === project.project.id && value.request_generation === 11);
    assert(value.fingerprint.hash === state.fingerprint.hash);
    const byId = new Map(value.items.map((item) => [item.asset_id, item]));
    for (const [id, expected] of [["asset-first", first], ["asset-second", second], ["asset-empty", empty]] as const) {
      const item = byId.get(id);
      assert(item?.status === "ok" && typeof item.bytes_base64 === "string", `${id} should be readable`);
      const decoded = Uint8Array.from(atob(item.bytes_base64), (character) => character.charCodeAt(0));
      assert(hash(decoded) === hash(expected), `${id} bytes should match the source`);
    }
    assert(byId.get("asset-deferred")?.status === "deferred");
    assert(byId.get("missing-asset")?.status === "error");
    assert(byId.get("asset-corrupt")?.error?.code === "asset_checksum_mismatch", JSON.stringify(byId.get("asset-corrupt")));
    assert(byId.get("asset-unsafe-path")?.error?.code === "asset_path_invalid");
    assert(byId.get("asset-oversize")?.error?.code === "asset_too_large");
    const metrics = getAssetPreviewBatchMetrics();
    assert(
      metrics.batches === 1 && metrics.canonical_snapshot_reads === 1,
      "each preview batch should bind exactly one complete canonical snapshot read",
    );
    assert(
      metrics.source_file_opens === 4 && metrics.peak_open_handles_per_batch === 1,
      "the batch should isolate bad rows and close each source before opening the next",
    );
    assert(
      metrics.raw_bytes_returned === 16 * 1024 * 1024 &&
        metrics.base64_bytes_returned === 8 * Math.ceil((8 * 1024 * 1024) / 3) &&
        metrics.source_read_bytes === 16 * 1024 * 1024 + corrupt.byteLength,
      "metrics should distinguish actual source reads, raw payload, and base64 expansion",
    );
    setAssetPreviewBatchDiagnosticsEnabled(false);

    const stale = await desktop.commands.execute("asset.preview_batch", {
      project_dir: directory,
      project_id: project.project.id,
      fingerprint: { ...state.fingerprint, hash: "f".repeat(64) },
      request_generation: 12,
      asset_ids: ["asset-first"],
    });
    assert(stale.error?.code === "asset_preview_stale");

    const wrongMimeBytes = new Uint8Array([1, 2, 3]);
    await Deno.writeFile(join(assetsDirectory, "wrong-mime.bin"), wrongMimeBytes);
    asset(project, "asset-wrong-mime", "assets/wrong-mime.bin", wrongMimeBytes);
    project.assets.at(-1)!.mime_type = "text/plain";
    await desktop.store.writeProject(project);
    const wrongMimeState = await desktop.store.readProjectSnapshot();
    const mixed = await desktop.commands.execute("asset.preview_batch", {
      project_dir: directory,
      project_id: project.project.id,
      fingerprint: wrongMimeState.fingerprint,
      request_generation: 13,
      asset_ids: ["asset-wrong-mime", "asset-empty"],
    });
    assert(!mixed.error, "a MIME mismatch should remain isolated to its row");
    const mixedItems = new Map((mixed.value as {
      items: Array<{ asset_id: string; status: string; error?: { code: string } }>;
    }).items.map((item) => [item.asset_id, item]));
    assert(mixedItems.get("asset-wrong-mime")?.error?.code === "asset_mime_mismatch");
    assert(mixedItems.get("asset-empty")?.status === "ok", "valid rows should remain readable beside a MIME mismatch");
  } finally {
    setAssetPreviewBatchDiagnosticsEnabled(false);
    await desktop.close();
    await Deno.remove(directory, { recursive: true });
    await Deno.remove(outsideDirectory, { recursive: true }).catch(() => {});
  }
});
