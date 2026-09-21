import {
  addAsset,
  addAssetUsage,
  addLayoutSection,
  addPlacement,
  appendBlock,
  buildBlueprintDraft,
  buildPublishProjection,
  confirmBlueprint,
  confirmImport,
  createCourseSeed,
  createEmptyProjectData,
  createExportPreset,
  createLayoutInstance,
  DesktopService,
  ExportBlockedError,
  exportProject,
  insertPlaceholder,
  ManualPublishAdapter,
  preflightExport,
  previewImport,
} from "../src/domain/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function courseData() {
  const data = createEmptyProjectData("导入导出测试");
  const seed = createCourseSeed(data, {
    source_type: "blank",
    raw_text: "# 阶段一\n第一课",
  });
  const draft = buildBlueprintDraft(data, seed.id);
  confirmBlueprint(data, draft.id);
  return data;
}

Deno.test("Markdown/TXT import is preview-first and content stays out of the course map", async () => {
  const data = createEmptyProjectData();
  const preview = await previewImport([{
    name: "lesson.md",
    bytes: "# 先预览\n\n正文",
  }], { data });
  assert(
    preview.requires_confirmation && preview.counts.markdown === 1,
    "markdown should produce a preview",
  );
  assert(
    data.inbox_items.length === 0 && data.content_items.length === 0,
    "preview must not mutate canonical data",
  );
  const result = await confirmImport(data, preview);
  assert(
    result.inbox_ids.length === 1 && data.inbox_items[0]?.body.includes("正文"),
    "content import should become Inbox by default",
  );
  assert(
    data.content_items.length === 0,
    "content import must not silently create course structure",
  );
});

Deno.test("course structure import creates CourseSeed/BlueprintDraft only", async () => {
  const data = createEmptyProjectData();
  const preview = await previewImport([{
    name: "outline.md",
    bytes: "# 阶段一\n第一课",
  }], { mode: "blueprint" });
  const result = await confirmImport(data, preview);
  assert(
    result.course_seed_ids.length === 1 &&
      result.blueprint_draft_ids.length === 1,
    "outline should become a draft",
  );
  assert(
    data.stages.length === 0 && data.content_items.length === 0,
    "unconfirmed blueprint must not create the course",
  );
});

Deno.test("asset import shows checksum duplicates and never executes scripts", async () => {
  const data = courseData();
  const first = await previewImport([{
    name: "shot.png",
    bytes: new Uint8Array([1, 2, 3]),
  }], { data, mode: "asset" });
  const imported = await confirmImport(data, first, { mode: "asset" });
  assert(
    imported.asset_ids.length === 1,
    "asset should be imported after confirmation",
  );
  const duplicate = await previewImport([{
    name: "copy.png",
    bytes: new Uint8Array([1, 2, 3]),
  }], { data, mode: "asset" });
  assert(
    duplicate.duplicate_count === 1,
    "same bytes should be identified by checksum",
  );
  const script = await previewImport([{
    name: "install.sh",
    bytes: "rm -rf /",
  }], { data, mode: "asset" });
  assert(
    !script.items[0]?.supported &&
      script.items[0]?.errors.some((message) => message.includes("不会执行")),
    "scripts must be rejected without execution",
  );
});

Deno.test("Word and PDF are explicit unsupported adapters", async () => {
  const word = await previewImport([{
    name: "notes.docx",
    bytes: new Uint8Array([0, 1]),
  }]);
  const pdf = await previewImport([{
    name: "notes.pdf",
    bytes: new Uint8Array([0, 1]),
  }]);
  assert(
    !word.items[0]?.supported &&
      word.warnings.some((message) => message.includes("Word")),
    "Word capability must be explicit",
  );
  assert(
    !pdf.items[0]?.supported &&
      pdf.warnings.some((message) => message.includes("PDF")),
    "PDF capability must be explicit",
  );
});

Deno.test("Markdown and clean semantic HTML exports are deterministic", async () => {
  const data = courseData();
  const item = data.content_items[0]!;
  appendBlock(data, item.id, "heading", "导出标题", { level: 2 });
  appendBlock(data, item.id, "paragraph", "正文 <script>alert(1)</script>");
  const exportedAsset = addAsset(data, data.project.id, {
    type: "image",
    filename: "cover.png",
    storage_path: "assets/cover.png",
    mime_type: "image/png",
    checksum: "export-cover-checksum",
    title: "课程封面",
  }).asset;
  addAssetUsage(data, exportedAsset.id, item.id);
  const markdownPreset = createExportPreset(data, {
    name: "正文",
    output_type: "markdown",
    platform: "通用",
  });
  const htmlPreset = createExportPreset(data, {
    name: "网页",
    output_type: "html",
    platform: "网页",
  });
  const assetBytes = { [exportedAsset.id]: new Uint8Array([1]) };
  const markdown = await exportProject(data, markdownPreset, {
    content_item_id: item.id,
    asset_bytes: assetBytes,
  });
  const html = await exportProject(data, htmlPreset, {
    content_item_id: item.id,
    asset_bytes: assetBytes,
  });
  const markdownAgain = await exportProject(data, markdownPreset, {
    content_item_id: item.id,
    asset_bytes: assetBytes,
  });
  assert(
    new TextDecoder().decode(markdown.files[0]!.bytes) ===
      new TextDecoder().decode(markdownAgain.files[0]!.bytes),
    "same input should produce stable markdown",
  );
  const markdownText = new TextDecoder().decode(markdown.files[0]!.bytes);
  const htmlText = new TextDecoder().decode(html.files[0]!.bytes);
  assert(
    markdownText.includes("![课程封面](assets/cover.png)") &&
      htmlText.includes('src="assets/cover.png"'),
    "used assets should remain referenced in Markdown and HTML",
  );
  assert(
    htmlText.includes("<article>") && !htmlText.includes("data-"),
    "HTML should be semantic and free of app data attributes",
  );
  assert(
    !htmlText.includes("<script>"),
    "HTML export must not carry executable markup",
  );
});

Deno.test("preflight separates warnings from blocking layout/assets issues", async () => {
  const data = courseData();
  const item = data.content_items[0]!;
  insertPlaceholder(data, item.id, { type: "image", note: "补一张封面" });
  const layout = createLayoutInstance(data, item.id, {
    name: "3:4",
    mode: "grid",
    grid_definition: { columns: [1], rows: [1] },
  });
  addPlacement(
    data,
    layout.id,
    appendBlock(data, item.id, "paragraph", "正文").id,
    { row_start: 0, row_end: 2, column_start: 0, column_end: 1 },
  );
  const preset = createExportPreset(data, {
    name: "网页",
    output_type: "html",
    platform: "网页",
    layout_instance_id: layout.id,
  });
  const report = await preflightExport(data, preset, {
    content_item_id: item.id,
  });
  assert(
    report.warnings.some((issue) => issue.code === "content_requirement"),
    "open content requirements are warnings",
  );
  assert(
    report.blocking.some((issue) => issue.code === "canvas_overflow"),
    "canvas overflow is blocking",
  );
  let blocked = false;
  try {
    await exportProject(data, preset, { content_item_id: item.id });
  } catch (caught) {
    blocked = caught instanceof ExportBlockedError;
  }
  assert(blocked, "blocking preflight issues must prevent damaged output");
});

Deno.test("full project export excludes private conversation data and PDF is readable", async () => {
  const data = courseData();
  data.conversation_sources.push({
    id: "s",
    provider: "imported",
    display_name: "本地导入",
    connector_type: "file",
    account_label: "测试",
    connection_status: "connected",
    auth_reference: "local-reference",
    last_sync_at: null,
  });
  data.conversations.push({
    id: "c",
    source_id: "s",
    external_id: "x",
    title: "私聊",
    external_created_at: null,
    external_updated_at: null,
    synced_at: new Date().toISOString(),
    metadata: {},
  });
  data.messages.push({
    id: "m",
    conversation_id: "c",
    external_id: null,
    role: "user",
    content: "私密内容",
    attachments: [],
    created_at: new Date().toISOString(),
  });
  const packagePreset = createExportPreset(data, {
    name: "完整项目",
    output_type: "custom",
    platform: "项目",
    settings: { target_type: "full_project" },
  });
  const result = await exportProject(data, packagePreset);
  const projectJson = new TextDecoder().decode(
    result.files.find((file) => file.relative_path === "project.json")!.bytes,
  );
  assert(
    !projectJson.includes("私聊") && !projectJson.includes("私密内容"),
    "private conversations must not enter a package by default",
  );
  const pdfPreset = createExportPreset(data, {
    name: "PDF",
    output_type: "pdf",
    platform: "PDF",
  });
  const pdf = await exportProject(data, pdfPreset);
  const pdfFile = pdf.files.find((file) => file.mime_type === "application/pdf");
  assert(
    pdfFile && new TextDecoder("latin1").decode(pdfFile.bytes.slice(0, 8)).startsWith("%PDF-"),
    "PDF output should be a readable PDF container",
  );
});

Deno.test("manual publication adapter records a user-facing publication", async () => {
  const data = courseData();
  const item = data.content_items[0]!;
  appendBlock(data, item.id, "paragraph", "可以发布");
  const preset = createExportPreset(data, {
    name: "网页",
    output_type: "html",
    platform: "网页",
  });
  const adapter = new ManualPublishAdapter("网页");
  const validation = await adapter.validate({
    data,
    content_item_id: item.id,
    preset,
  });
  assert(validation.ok, "valid publication should pass preflight");
  const prepared = await adapter.prepare({
    data,
    content_item_id: item.id,
    preset,
  });
  const publication = await adapter.publish({
    data,
    content_item_id: item.id,
    preset,
    external_url: "https://example.test/post",
    version_label: "第一版",
  }, prepared);
  assert(
    publication.status === "published" &&
      publication.external_url === "https://example.test/post",
    "manual publication should retain URL and status",
  );
  assert(
    (await adapter.getStatus(data, item.id)).publication?.id === publication.id,
    "publication status should be queryable",
  );
});

Deno.test("desktop command boundary exposes preview, preflight, and export", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-import-export-command-",
  });
  const desktop = new DesktopService(directory, {
    app_instance_id: "command-test",
  });
  await desktop.open();
  try {
    const created = await desktop.commands.execute("project.create", {
      title: "命令导出",
    });
    assert(
      !created.error && desktop.context.project,
      "project command should open a canonical project",
    );
    const preview = await desktop.commands.execute("import.preview", {
      sources: [{ name: "正文.md", bytes: "# 标题\n\n内容" }],
    });
    const previewValue = preview.value as Awaited<
      ReturnType<typeof previewImport>
    >;
    assert(
      !preview.error && previewValue.requires_confirmation,
      "preview command should not write immediately",
    );
    const confirmed = await desktop.commands.execute("import.confirm", {
      preview: previewValue,
      options: { content_target: "content_item" },
    });
    const confirmedValue = confirmed.value as { content_item_ids: string[] };
    assert(
      !confirmed.error && confirmedValue.content_item_ids.length === 1,
      "confirm command should persist the selected import",
    );
    const preset = createExportPreset(desktop.context.project!, {
      name: "网页",
      output_type: "html",
      platform: "网页",
    });
    const check = await desktop.queries.execute("export.preflight", {
      preset,
    }) as Awaited<ReturnType<typeof preflightExport>>;
    assert(check.ok, "preflight query should be available through the bridge");
    const exported = await desktop.commands.execute("export.run", {
      preset,
      options: { content_item_id: confirmedValue.content_item_ids[0] },
    });
    const exportedValue = exported.value as Awaited<
      ReturnType<typeof exportProject>
    >;
    assert(
      !exported.error && exportedValue.files.length === 1,
      "export command should produce an HTML file",
    );
  } finally {
    await desktop.close();
  }
});

Deno.test("folder preview skips circular links and keeps long Unicode names portable", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-import-edge-" });
  await Deno.writeTextFile(`${root}/中文.md`, "");
  await Deno.symlink(root, `${root}/loop`);
  const preview = await previewImport([{ path: root }]);
  assert(
    preview.items[0]?.children.length === 1,
    "circular symlink must not recurse into the folder",
  );

  const data = courseData();
  const longName = `${"课程".repeat(160)}.png`;
  const assetPreview = await previewImport([{
    name: longName,
    bytes: new Uint8Array([1, 2, 3]),
  }], { data, mode: "asset" });
  const result = await confirmImport(data, assetPreview, { mode: "asset" });
  const asset = data.assets.find((candidate) =>
    candidate.id === result.asset_ids[0]
  );
  assert(
    asset && new TextEncoder().encode(asset.filename).byteLength <= 180,
    "long Unicode filenames must be bounded",
  );
  assert(
    !asset.storage_path.includes(".."),
    "generated asset paths must stay relative",
  );
});

Deno.test("blocking preflight cannot be bypassed and unsafe HTML asset paths are rejected", async () => {
  const data = courseData();
  const item = data.content_items[0]!;
  const malicious = addAsset(data, data.project.id, {
    type: "image",
    filename: "cover.png",
    storage_path: 'assets/cover.png" onerror="alert(1)',
    mime_type: "image/png",
    checksum: "edge-html",
    file_size: 1,
  }).asset;
  const imageBlock = appendBlock(data, item.id, "image", malicious.filename);
  const htmlPreset = createExportPreset(data, {
    name: "网页",
    output_type: "html",
    platform: "网页",
  });
  let unsafeBlocked = false;
  try {
    await exportProject(data, htmlPreset, {
      content_item_id: item.id,
      asset_bytes: { [malicious.id]: new Uint8Array([1]) },
    });
  } catch (caught) {
    unsafeBlocked = caught instanceof ExportBlockedError &&
      caught.report.blocking.some((issue) => issue.code === "unsafe_path");
  }
  assert(unsafeBlocked, "unsafe asset paths must block HTML output");

  const layout = createLayoutInstance(data, item.id, {
    name: "网格",
    mode: "grid",
    grid_definition: { columns: [1], rows: [1] },
  });
  addPlacement(data, layout.id, imageBlock.id, {
    row_start: 0,
    row_end: 2,
    column_start: 0,
    column_end: 1,
  });
  const layoutPreset = createExportPreset(data, {
    name: "排版",
    output_type: "html",
    platform: "网页",
    layout_instance_id: layout.id,
  });
  let blocked = false;
  try {
    await exportProject(data, layoutPreset, {
      content_item_id: item.id,
      force_warnings: true,
    });
  } catch (caught) {
    blocked = caught instanceof ExportBlockedError;
  }
  assert(blocked, "force_warnings must not bypass blocking layout errors");
});

Deno.test("multi-page image export emits stable files per LayoutSection", async () => {
  const data = courseData();
  const item = data.content_items[0]!;
  const first = appendBlock(data, item.id, "paragraph", "第一分区");
  const second = appendBlock(data, item.id, "paragraph", "第二分区");
  const layout = createLayoutInstance(data, item.id, {
    name: "多页",
    mode: "grid",
    grid_definition: { columns: [1], rows: [1] },
  });
  const one = addLayoutSection(data, layout.id, {
    name: "开场",
    grid_definition: { columns: [1], rows: [1] },
  });
  const two = addLayoutSection(data, layout.id, {
    name: "正文",
    grid_definition: { columns: [1], rows: [1] },
  });
  addPlacement(data, layout.id, first.id, {
    section_id: one.id,
    row_start: 0,
    row_end: 1,
    column_start: 0,
    column_end: 1,
  });
  addPlacement(data, layout.id, second.id, {
    section_id: two.id,
    row_start: 0,
    row_end: 1,
    column_start: 0,
    column_end: 1,
  });
  const preset = createExportPreset(data, {
    name: "多页",
    output_type: "image",
    platform: "小红书",
    page_mode: "multi_page",
    layout_instance_id: layout.id,
  });
  const firstRun = await exportProject(data, preset, {
    content_item_id: item.id,
  });
  const secondRun = await exportProject(data, preset, {
    content_item_id: item.id,
  });
  assert(
    firstRun.files.length === 2 &&
      firstRun.files[0]?.relative_path.includes("开场"),
    "each section should produce one image",
  );
  assert(
    firstRun.files.map((file) => file.relative_path).join("|") ===
      secondRun.files.map((file) => file.relative_path).join("|"),
    "section filenames must be deterministic",
  );
});

Deno.test("full project preflight rejects asset symlinks that escape the project root", async () => {
  const data = courseData();
  const root = await Deno.makeTempDir({ prefix: "acw-export-root-" });
  const outside = await Deno.makeTempDir({ prefix: "acw-export-outside-" });
  await Deno.writeTextFile(`${outside}/secret.png`, "private");
  await Deno.symlink(outside, `${root}/assets`);
  addAsset(data, data.project.id, {
    type: "image",
    filename: "secret.png",
    storage_path: "assets/secret.png",
    mime_type: "image/png",
    checksum: "edge-symlink",
    file_size: 7,
  });
  const preset = createExportPreset(data, {
    name: "完整项目",
    output_type: "custom",
    platform: "项目",
    settings: { target_type: "full_project" },
  });
  const report = await preflightExport(data, preset, { project_root: root });
  assert(
    report.blocking.some((issue) => issue.code === "missing_asset"),
    "symlinked assets must be treated as missing",
  );
});

Deno.test("export refuses a symlink at the final output target", async () => {
  const data = courseData();
  const root = await Deno.makeTempDir({ prefix: "acw-export-target-" });
  const outside = await Deno.makeTempDir({
    prefix: "acw-export-target-outside-",
  });
  const outsideFile = `${outside}/secret.md`;
  await Deno.writeTextFile(outsideFile, "must-stay-private");
  await Deno.symlink(outsideFile, `${root}/result.md`);
  const preset = createExportPreset(data, {
    name: "result",
    output_type: "markdown",
    platform: "通用",
    naming_rule: "result",
  });
  let rejected = false;
  try {
    await exportProject(data, preset, { output_dir: root });
  } catch {
    rejected = true;
  }
  assert(rejected, "an output symlink must not be followed");
  assert(
    await Deno.readTextFile(outsideFile) === "must-stay-private",
    "an output symlink must not overwrite a file outside the export root",
  );
});

Deno.test("publish projection keeps scope/order/layout and omits workflow placeholders", () => {
  const data = courseData();
  const item = data.content_items[0]!;
  appendBlock(data, item.id, "heading", "稳定标题", { level: 2 });
  insertPlaceholder(data, item.id, { type: "text", note: "尚未完成" });
  const image = addAsset(data, data.project.id, {
    type: "image",
    filename: "中文 封面.png",
    storage_path: "assets/中文 封面.png",
    mime_type: "image/png",
    checksum: "projection-image",
  }).asset;
  const imageBlock = appendBlock(data, item.id, "image", image.filename, {
    asset_id: image.id,
  });
  addAssetUsage(data, image.id, item.id, { block_id: imageBlock.id });
  const layout = createLayoutInstance(data, item.id, {
    name: "课程网格",
    mode: "grid",
    grid_definition: { columns: [1], rows: [1] },
  });
  addPlacement(data, layout.id, imageBlock.id, {
    row_start: 0,
    row_end: 1,
    column_start: 0,
    column_end: 1,
  });
  const projection = buildPublishProjection(data, { content_item_id: item.id });
  assert(projection.scope === "lesson" && projection.lessons.length === 1, "lesson scope should be explicit");
  assert(!projection.lessons[0]!.blocks.some((block) => block.type === "placeholder"), "placeholder workflow state must not enter published prose");
  assert(projection.lessons[0]!.blocks.filter((block) => block.media?.id === image.id).length === 1, "inline media should occur once");
  assert(projection.lessons[0]!.attachments.every((media) => media.id !== image.id), "inline media must not be repeated as an attachment");
  assert(projection.lessons[0]!.layout?.mode === "grid", "layout semantics should survive projection");
});

Deno.test("static web package is portable and copies only referenced assets", async () => {
  const data = courseData();
  const item = data.content_items[0]!;
  appendBlock(data, item.id, "paragraph", "可搬走的网页正文");
  const used = addAsset(data, data.project.id, {
    type: "gif",
    filename: "演示 动图.gif",
    storage_path: "assets/演示 动图.gif",
    mime_type: "image/gif",
    checksum: "used-gif",
  }).asset;
  const unused = addAsset(data, data.project.id, {
    type: "image",
    filename: "未使用.png",
    storage_path: "assets/未使用.png",
    mime_type: "image/png",
    checksum: "unused-image",
  }).asset;
  const block = appendBlock(data, item.id, "gif", used.filename, { asset_id: used.id });
  addAssetUsage(data, used.id, item.id, { block_id: block.id });
  const output = await Deno.makeTempDir({ prefix: "acw-portable-web-" });
  const preset = createExportPreset(data, {
    name: "静态网页",
    output_type: "custom",
    platform: "网页",
    settings: { target_type: "web" },
  });
  const before = JSON.stringify(data);
  const result = await exportProject(data, preset, {
    output_dir: output,
    asset_bytes: {
      [used.id]: new Uint8Array([71, 73, 70, 56, 57, 97]),
      [unused.id]: new Uint8Array([1]),
    },
  });
  assert(result.files.some((file) => file.relative_path === "index.html"), "web package needs an entrypoint");
  assert(await Deno.stat(`${output}/assets/演示 动图.gif`).then((stat) => stat.isFile), "referenced GIF bytes should be copied");
  let unusedExists = true;
  try { await Deno.stat(`${output}/assets/未使用.png`); } catch { unusedExists = false; }
  assert(!unusedExists, "unused assets should not enter the web package");
  const moved = `${output}-moved`;
  await Deno.rename(output, moved);
  const html = await Deno.readTextFile(`${moved}/index.html`);
  assert(html.includes("可搬走的网页正文") && html.includes("assets/%E6%BC%94%E7%A4%BA%20%E5%8A%A8%E5%9B%BE.gif"), "moved package should retain relative Unicode asset references");
  assert(!html.includes(".workspace") && JSON.stringify(data) === before, "export must not leak workspace data or mutate Canonical");
});

Deno.test("preflight warns about media downgrade and failure leaves no partial artifact", async () => {
  const data = courseData();
  const item = data.content_items[0]!;
  const video = addAsset(data, data.project.id, {
    type: "video",
    filename: "lesson video.mp4",
    storage_path: "assets/lesson video.mp4",
    mime_type: "video/mp4",
    checksum: "video-warning",
  }).asset;
  const block = appendBlock(data, item.id, "video", video.filename, { asset_id: video.id });
  addAssetUsage(data, video.id, item.id, { block_id: block.id });
  const preset = createExportPreset(data, {
    name: "result",
    output_type: "markdown",
    platform: "通用",
    naming_rule: "result",
  });
  const report = await preflightExport(data, preset, {
    content_item_id: item.id,
    asset_bytes: { [video.id]: new Uint8Array([1]) },
  });
  assert(report.warnings.some((issue) => issue.code === "media_downgrade"), "non-interactive media downgrade should be explained");
  const output = await Deno.makeTempDir({ prefix: "acw-export-atomic-" });
  await Deno.writeTextFile(`${output}/result.md`, "keep-existing");
  const before = JSON.stringify(data);
  let rejected = false;
  try {
    await exportProject(data, preset, {
      content_item_id: item.id,
      output_dir: output,
      asset_bytes: { [video.id]: new Uint8Array([1]) },
    });
  } catch { rejected = true; }
  assert(rejected && await Deno.readTextFile(`${output}/result.md`) === "keep-existing", "existing valid output must not be overwritten silently");
  const leftovers = [];
  for await (const entry of Deno.readDir(output)) if (entry.name.startsWith(".acw-export-")) leftovers.push(entry.name);
  assert(leftovers.length === 0 && JSON.stringify(data) === before, "failed export must clean staging and preserve Canonical bytes");
});

Deno.test("desktop confirmation installs a confirmed project import", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-project-import-" });
  const desktop = new DesktopService(directory, {
    app_instance_id: "project-import",
  });
  await desktop.open();
  try {
    const initial = await desktop.commands.execute("project.create", {
      title: "当前项目",
    });
    assert(!initial.error, "current project should be created");
    const imported = createEmptyProjectData("导入项目");
    const preview = await desktop.commands.execute("import.preview", {
      mode: "project",
      sources: [{ name: "project.json", bytes: JSON.stringify(imported) }],
    });
    assert(!preview.error, "project JSON should preview");
    const confirmed = await desktop.commands.execute("import.confirm", {
      preview: preview.value,
    });
    assert(
      !confirmed.error && desktop.context.project?.project.title === "导入项目",
      "confirmed project import should replace the open project",
    );
  } finally {
    await desktop.close();
  }
});
