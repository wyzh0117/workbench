import { createEmptyProjectData, validateProjectData } from "../src/domain/store.ts";
import { addStage } from "../src/domain/course.ts";
import { createDocument, appendBlock } from "../src/domain/document.ts";
import { initializeContentStatuses } from "../src/domain/status.ts";
import { addAsset, addAssetUsage } from "../src/domain/assets.ts";
import { addPlacement, createLayoutInstance } from "../src/domain/layout.ts";
import { addLayoutPage, createPagedLayout } from "../app/layout_pages.js";

const mode = Deno.args.find((argument) => argument.startsWith("--mode="))?.slice(7) || "large";
const requestedProjectId = Deno.args.find((argument) => argument.startsWith("--project-id="))?.slice(13) || "";
if (!["large", "small", "media-ui", "small-final", "layout-final"].includes(mode)) {
  throw new Error(`unsupported fixture mode: ${mode}`);
}
if (requestedProjectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedProjectId)) {
  throw new Error("--project-id must be a UUIDv4");
}
const output = Deno.args.find((argument) => !argument.startsWith("--"));
const data = createEmptyProjectData(
  mode === "large" ? "File I/O deterministic benchmark" : `File I/O ${mode} QA fixture`,
  "Canonical domain fixture",
  "en-US",
);
const stage = addStage(data, { title: "Fixture stage", code: "S01" });
const paragraph = "The quick brown fox measures canonical project I/O while preserving valid domain structure. ".repeat(11);
const expandedCourse = mode === "small-final" || mode === "layout-final";
const secondStage = expandedCourse ? addStage(data, { title: "Fixture stage 2", code: "S02" }) : null;
const lessons: Array<{ id: string; stage_id: string }> = [];
const lessonCount = expandedCourse ? 4 : 1;
for (let lessonIndex = 0; lessonIndex < lessonCount; lessonIndex++) {
  const stageForLesson = expandedCourse && lessonIndex >= 2 ? secondStage! : stage;
  const contentId = crypto.randomUUID();
  const document = createDocument(data, contentId);
  const orderIndex = data.content_items.filter((item) => item.stage_id === stageForLesson.id).length;
  data.content_items.push({
    id: contentId,
    project_id: data.project.id,
    stage_id: stageForLesson.id,
    code: `${stageForLesson.code}-${String(orderIndex + 1).padStart(2, "0")}`,
    title: expandedCourse ? `Fixture lesson ${lessonIndex + 1}` : "Large canonical lesson",
    type: "lesson",
    description: "Deterministic I/O benchmark content",
    order_index: orderIndex,
    document_id: document.id,
    archived: false,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
  initializeContentStatuses(data, contentId);
  lessons.push({ id: contentId, stage_id: stageForLesson.id });
  const blockCount = mode === "large" ? 5000 : expandedCourse ? 4 : 12;
  for (let index = 0; index < blockCount; index++) {
    const content = expandedCourse
      ? index === 0
        ? `Fixture heading ${lessonIndex + 1}`
        : index === 2
        ? `Fixture long body ${lessonIndex + 1}. ${paragraph.repeat(8)}`
        : `Fixture lesson ${lessonIndex + 1}, paragraph ${index}. ${paragraph}`
      : `${String(index).padStart(5, "0")} ${paragraph}`;
    appendBlock(data, contentId, expandedCourse && index === 0 ? "heading" : "paragraph", content);
  }
}
const mediaCount = mode === "large" ? 1000 : mode === "media-ui" ? 114 : expandedCourse ? 4 : mode === "small" ? 3 : 0;
const assetFiles: Array<{ path: string; bytes: Uint8Array }> = [];
function concat(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function uint32be(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}
function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, bytes: Uint8Array): Uint8Array {
  const payload = concat(new TextEncoder().encode(type), bytes);
  return concat(uint32be(bytes.length), payload, uint32be(pngCrc(payload)));
}
async function qaPng(seed: number): Promise<Uint8Array> {
  const width = 32;
  const height = 32;
  const scanlines = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    scanlines[row] = 0;
    for (let x = 0; x < width; x++) {
      const offset = row + 1 + x * 4;
      const tile = ((x >> 3) + (y >> 3) + seed) & 1;
      scanlines[offset] = (seed * 47 + tile * 70 + x * 2) & 255;
      scanlines[offset + 1] = (seed * 83 + tile * 95 + y * 2) & 255;
      scanlines[offset + 2] = (seed * 29 + tile * 120) & 255;
      scanlines[offset + 3] = 255;
    }
  }
  const compressed = new Uint8Array(await new Response(
    new Blob([scanlines]).stream().pipeThrough(new CompressionStream("deflate")),
  ).arrayBuffer());
  const header = concat(uint32be(width), uint32be(height), Uint8Array.of(8, 6, 0, 0, 0));
  return concat(
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    pngChunk("IHDR", header), pngChunk("IDAT", compressed), pngChunk("IEND", new Uint8Array()),
  );
}
async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", stableBytes.buffer))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
for (let index = 0; index < mediaCount; index++) {
  const filename = `fixture-${String(index).padStart(3, "0")}.png`;
  const bytes = mode === "large" ? new Uint8Array() : await qaPng(index + 1);
  addAsset(data, data.project.id, {
    type: "image",
    filename,
    storage_path: `assets/${filename}`,
    mime_type: "image/png",
    checksum: mode === "large" ? `sha256-fixture-${String(index).padStart(4, "0")}` : await sha256Bytes(bytes),
    file_size: mode === "large" ? 1024 + index : bytes.byteLength,
    width: mode === "large" ? 1920 : 32,
    height: mode === "large" ? 1080 : 32,
    title: `Fixture image ${index}`,
    source_type: "imported",
  }, true);
  if (mode !== "large") assetFiles.push({ path: `assets/${filename}`, bytes });
}
const motionCopies = mode === "media-ui" ? 3 : expandedCourse ? 1 : 0;
if (motionCopies) {
  const mediaRoot = `/tmp/workbench-io-ui-ffmpeg-${Deno.pid}`;
  await Deno.mkdir(mediaRoot, { recursive: true });
  const gifPath = `${mediaRoot}/sample.gif`;
  const mp4Path = `${mediaRoot}/sample.mp4`;
  const gifRun = await new Deno.Command("ffmpeg", { args: [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "testsrc=size=64x64:rate=5:duration=2", "-loop", "0", "-y", gifPath,
  ], stdout: "null", stderr: "piped" }).output();
  if (!gifRun.success) throw new Error(`ffmpeg GIF fixture failed: ${new TextDecoder().decode(gifRun.stderr)}`);
  const mp4Run = await new Deno.Command("ffmpeg", { args: [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "testsrc=size=64x64:rate=5:duration=2", "-an", "-c:v", "libx264", "-preset", "ultrafast",
    "-crf", "28", "-pix_fmt", "yuv420p", "-threads", "1", "-movflags", "+faststart", "-y", mp4Path,
  ], stdout: "null", stderr: "piped" }).output();
  if (!mp4Run.success) throw new Error(`ffmpeg MP4 fixture failed: ${new TextDecoder().decode(mp4Run.stderr)}`);
  for (let index = 0; index < motionCopies; index++) {
    for (const [extension, mime, type, source] of [
      ["gif", "image/gif", "gif", gifPath],
      ["mp4", "video/mp4", "video", mp4Path],
    ] as const) {
      const filename = `fixture-${String(index).padStart(2, "0")}.${extension}`;
      const bytes = await Deno.readFile(source);
      const relativePath = `assets/${filename}`;
      addAsset(data, data.project.id, {
        type, filename, storage_path: relativePath, mime_type: mime,
        checksum: await sha256Bytes(bytes), file_size: bytes.byteLength,
        width: 64, height: 64, title: `Fixture ${extension.toUpperCase()} ${index + 1}`,
        source_type: "imported",
      }, true);
      assetFiles.push({ path: relativePath, bytes });
    }
  }
  if (mode === "media-ui" && data.assets.length !== 120) throw new Error(`media-ui fixture needs 120 assets, got ${data.assets.length}`);
}
if (mode === "layout-final") {
  const firstLesson = lessons[0]!;
  const layout = createLayoutInstance(data, firstLesson.id, {
    name: "三页排版验收",
    mode: "grid",
    grid_definition: { columns: [1, 1], rows: [1, 1] },
  });
  const pages = createPagedLayout(data, layout.id);
  pages.push(addLayoutPage(data, layout.id, { title: "跨页文本与图片" }));
  pages.push(addLayoutPage(data, layout.id, { title: "长正文续页" }));
  const mediaAsset = data.assets.find((asset) => asset.type === "image")!;
  const mediaBlock = appendBlock(data, firstLesson.id, "image", mediaAsset.filename, {
    asset_id: mediaAsset.id,
    media_type: "image",
  });
  addAssetUsage(data, mediaAsset.id, firstLesson.id, { block_id: mediaBlock.id });
  const textBlocks = data.blocks.filter((block) => {
    const document = data.documents.find((candidate) => candidate.id === block.document_id);
    return document?.content_item_id === firstLesson.id;
  });
  const placements = [
    [textBlocks[0]!, mediaBlock],
    [textBlocks[1]!, textBlocks[2]!],
    [textBlocks[3]!],
  ];
  for (const [pageIndex, page] of pages.entries()) {
    for (const [cellIndex, block] of placements[pageIndex]!.entries()) {
      const placement = addPlacement(data, layout.id, block.id, {
        row_start: Math.floor(cellIndex / 2),
        row_end: Math.floor(cellIndex / 2) + 1,
        column_start: cellIndex % 2,
        column_end: cellIndex % 2 + 1,
      });
      placement.page_id = page.id;
    }
  }
}

const ids = new Map<string, string>();
let nextId = 1;
const uuidFrom = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
function collect(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) collect(item); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && !ids.has(record.id)) ids.set(record.id, uuidFrom(nextId++));
  for (const nested of Object.values(record)) collect(nested);
}
collect(data);
function normalize(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) normalize(item); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, current] of Object.entries(value as Record<string, unknown>)) {
    if (typeof current === "string" && (key === "id" || key.endsWith("_id")) && ids.has(current)) {
      (value as Record<string, unknown>)[key] = ids.get(current)!;
    } else if (typeof current === "string" && key.endsWith("_at")) {
      (value as Record<string, unknown>)[key] = "2026-10-01T00:00:00.000Z";
    } else normalize(current);
  }
}
normalize(data);
if (requestedProjectId) {
  const previousProjectId = data.project.id;
  data.project.id = requestedProjectId;
  for (const rows of Object.values(data)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row && typeof row === "object" && "project_id" in row && row.project_id === previousProjectId) {
        row.project_id = requestedProjectId;
      }
    }
  }
}
const issues = validateProjectData(data);
if (issues.length) throw new Error(`invalid fixture (${issues.length}): ${JSON.stringify(issues.slice(0, 20))}`);
const json = `${JSON.stringify(data, null, 2)}\n`;
const defaultPaths: Record<string, string> = {
  large: "/tmp/workbench-large-canonical-fixture.json",
  small: "/tmp/workbench-small-qa",
  "media-ui": "/tmp/workbench-media-ui-qa",
  "small-final": "/tmp/workbench-io-ui-F-small-final",
  "layout-final": "/tmp/workbench-io-ui-F-layout-final",
};
const path = output || defaultPaths[mode]!;
if (mode === "large") {
  await Deno.writeTextFile(path, json);
} else {
  await Deno.mkdir(`${path}/assets`, { recursive: true });
  for (const asset of assetFiles) await Deno.writeFile(`${path}/${asset.path}`, asset.bytes);
  await Deno.writeTextFile(`${path}/project.json`, json);
}
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
console.log(JSON.stringify({ path, mode, bytes: new TextEncoder().encode(json).byteLength, sha256, stages: data.stages.length, lessons: data.content_items.length, blocks: data.blocks.length, assets: data.assets.length, pages: data.layout_pages.length, placements: data.placements.length, issues: issues.length, projectId: data.project.id, media_files: assetFiles.length, types: { png: assetFiles.filter((file) => file.path.endsWith(".png")).length, gif: assetFiles.filter((file) => file.path.endsWith(".gif")).length, mp4: assetFiles.filter((file) => file.path.endsWith(".mp4")).length } }, null, 2));
