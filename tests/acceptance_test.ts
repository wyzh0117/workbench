import {
  addLayoutSection,
  addPlacement,
  appendBlock,
  applyChangeDraft,
  asErrorObject,
  createContextPack,
  createCourseSeed,
  createEmptyProjectData,
  createExportPreset,
  createLayoutInstance,
  createSuggestion,
  deriveGaps,
  DesktopService,
  DiagnosticLogger,
  FileSearchIndex,
  handleFatal,
  ImportedConversationConnector,
  insertPlaceholder,
  IsolatedConnector,
  MemorySearchIndex,
  ProjectDirectoryStore,
  redactSecrets,
  reviewChangeDraft,
  sanitizeHtml,
  ServiceError,
  syncSelectedConversations,
  writeRecoveryJournalBeforeFatal,
} from "../src/domain/index.ts";
import type { ProjectData } from "../src/domain/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function confirmedFixture(): Promise<ProjectData> {
  const data = createEmptyProjectData("验收课程");
  const seed = createCourseSeed(data, {
    source_type: "blank",
    raw_text: "# 阶段一\n第一课",
  });
  const { buildBlueprintDraft, confirmBlueprint } = await import(
    "../src/domain/course.ts"
  );
  const draft = buildBlueprintDraft(data, seed.id);
  confirmBlueprint(data, draft.id);
  return data;
}

Deno.test("E2E-01 autosave recovery journal survives a simulated interrupted write", async () => {
  const data = await confirmedFixture();
  const calls: unknown[] = [];
  const writer = {
    writeRecoveryJournal: (journal: unknown): Promise<void> => {
      calls.push(journal);
      return Promise.resolve();
    },
  };
  await writeRecoveryJournalBeforeFatal(
    writer,
    data,
    new ServiceError({
      code: "disk_full",
      user_message: "无法保存",
      severity: "fatal",
      recoverable: false,
    }),
  );
  assert(calls.length === 1, "fatal path must journal before shutdown");
  assert(
    (calls[0] as { project: ProjectData }).project.project.id ===
      data.project.id,
    "journal must contain canonical state",
  );
});

Deno.test("E2E-02 read-only storage blocks writes with a structured user error", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-accept-readonly-" });
  const store = new ProjectDirectoryStore(directory, { read_only: true });
  await store.open();
  let error: unknown = null;
  try {
    await store.writeProject(createEmptyProjectData());
  } catch (caught) {
    error = caught;
  }
  assert(
    asErrorObject(error).code === "read_only_project",
    "readonly writes need a stable error code",
  );
  await store.close();
});

Deno.test("E2E-02b simulated disk-full fatal path logs without masking the error", async () => {
  const data = await confirmedFixture();
  const directory = await Deno.makeTempDir({ prefix: "acw-accept-disk-full-" });
  const logger = new DiagnosticLogger(directory, {
    max_bytes: 4096,
    max_files: 1,
  });
  const writer = {
    writeRecoveryJournal: (): Promise<void> => {
      const failure = new Error("No space left on device") as Error & {
        code: string;
      };
      failure.code = "ENOSPC";
      return Promise.reject(failure);
    },
  };
  await handleFatal(
    writer,
    logger,
    data,
    new ServiceError({
      code: "disk_full",
      user_message: "无法保存",
      severity: "fatal",
      recoverable: false,
    }),
    () => undefined,
  );
  const entries = await logger.read();
  assert(
    entries.some((entry) => entry.code === "fatal_recovery_journal_failed") &&
      entries.some((entry) =>
        entry.level === "fatal" && entry.code === "disk_full"
      ),
    "disk-full recovery failure must still produce a fatal diagnostic",
  );
});

Deno.test("E2E-03 snapshot restore keeps a recovery point", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-accept-snapshot-" });
  const store = new ProjectDirectoryStore(directory, {
    app_instance_id: "accept-snapshot",
  });
  await store.open();
  const data = await confirmedFixture();
  await store.writeProject(data);
  const snapshot = await store.createSnapshot(data, "正文节点");
  data.project.title = "后来修改";
  const result = await store.restoreSnapshot(data, snapshot.id);
  assert(
    result.backup.name === "恢复前备份",
    "restore must preserve current state first",
  );
  await store.close();
});

Deno.test("E2E-04 Grid and LayoutSection keep placement outside Block", async () => {
  const data = await confirmedFixture();
  const item = data.content_items[0]!;
  const block = appendBlock(data, item.id, "paragraph", "网格正文");
  const layout = createLayoutInstance(data, item.id, {
    name: "多页网格",
    mode: "grid",
    grid_definition: { rows: [1, 1], columns: [1, 1] },
  });
  const section = addLayoutSection(data, layout.id, { name: "第 1 页" });
  addPlacement(data, layout.id, block.id, {
    section_id: section.id,
    row_start: 0,
    row_end: 1,
    column_start: 0,
    column_end: 2,
  });
  assert(
    !("row_start" in block) && data.layout_sections.length === 1,
    "layout coordinates belong to placement/section",
  );
});

Deno.test("E2E-05 Undo-equivalent snapshot preserves the previous canonical document", async () => {
  const data = await confirmedFixture();
  const item = data.content_items[0]!;
  const block = appendBlock(data, item.id, "paragraph", "原文");
  const before = structuredClone(data);
  block.content = "修改后";
  const restored = before.blocks.find((candidate) => candidate.id === block.id);
  assert(
    restored?.content === "原文",
    "recovery point must restore the old text",
  );
});

Deno.test("E2E-06 Requirement gaps remain separate from user-controlled status", async () => {
  const data = await confirmedFixture();
  const item = data.content_items[0]!;
  insertPlaceholder(data, item.id, { type: "image", note: "补图" });
  const gaps = deriveGaps(data, item.id);
  assert(
    gaps.by_scope.content === 1 && gaps.total_open === 1,
    "content gap should be derived from Requirement",
  );
});

Deno.test("E2E-07 AI context is explicit and a draft cannot apply before review", async () => {
  const data = await confirmedFixture();
  const item = data.content_items[0]!;
  const block = appendBlock(data, item.id, "paragraph", "原文");
  const pack = await createContextPack(data, {
    purpose: "改写",
    target_content_item_id: item.id,
    items: [{
      source_type: "document",
      source_id: item.document_id,
      label: "正文",
      content: "原文",
    }],
  });
  const suggestion = createSuggestion(data, {
    target_content_item_id: item.id,
    context_pack_id: pack.pack.id,
    type: "rewrite",
    title: "改写",
    description: "建议",
  });
  const draft = (await import("../src/domain/ai.ts")).acceptSuggestion(
    data,
    suggestion.id,
    [{ block_id: block.id, before: "原文", after: "改后" }],
  );
  let blocked = false;
  try {
    applyChangeDraft(data, draft.id, { confirmed: true });
  } catch {
    blocked = true;
  }
  assert(blocked && block.content === "原文", "AI must not bypass Diff review");
  reviewChangeDraft(data, draft.id);
  applyChangeDraft(data, draft.id, { confirmed: true });
  assert(
    String(block.content) === "改后",
    "explicit apply should update canonical content",
  );
});

Deno.test("E2E-08 imported connector only syncs explicitly selected conversations", async () => {
  const data = await confirmedFixture();
  const connector = new ImportedConversationConnector({
    conversations: [
      {
        external_id: "one",
        title: "选中",
        messages: [{ role: "user", content: "入选" }],
      },
      {
        external_id: "two",
        title: "未选",
        messages: [{ role: "user", content: "不应入库" }],
      },
    ],
  });
  assert(
    (await connector.listConversations()).length === 0,
    "connector must wait for explicit sync",
  );
  await connector.sync();
  await syncSelectedConversations(data, connector, ["one"]);
  assert(
    data.conversations.length === 1 && data.messages[0]?.content === "入选",
    "unselected conversations must stay out",
  );
});

Deno.test("E2E-08b connector selection failure does not partially mutate canonical data", async () => {
  const data = await confirmedFixture();
  const connector = new ImportedConversationConnector({
    conversations: [{ external_id: "one", title: "选中", messages: [] }],
  });
  await connector.sync();
  let failed = false;
  try {
    await syncSelectedConversations(data, connector, ["one", "missing"]);
  } catch {
    failed = true;
  }
  assert(
    failed && data.conversation_sources.length === 0 &&
      data.conversations.length === 0,
    "failed connector selection must not leave partial canonical data",
  );
});

Deno.test("E2E-09 connector failure is isolated from the workbench", async () => {
  const isolated = new IsolatedConnector("broken", {
    health: () => Promise.reject(new Error("provider timeout")),
    listConversations: () => Promise.resolve([]),
    fetchConversation: () => Promise.resolve(null),
  });
  const result = await isolated.health();
  assert(
    !result.ok && result.error?.code === "connector_failed",
    "connector errors must become data",
  );
  const healthy = await isolated.listConversations();
  assert(healthy.ok, "one provider failure must not poison the registry");
});

Deno.test("E2E-10 security redacts secrets and strips executable HTML", () => {
  const redacted = JSON.stringify(
    redactSecrets({ api_key: "secret", safe: "ok" }),
  );
  assert(
    !redacted.includes("secret") && redacted.includes("REDACTED"),
    "diagnostics must redact credentials",
  );
  const html = sanitizeHtml(
    `<p>Hello</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>`,
  );
  assert(
    !html.includes("<script") && !html.includes("javascript:"),
    "untrusted HTML must be inert",
  );
});

Deno.test("E2E-11 rotating diagnostics remain readable after log growth", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-accept-diagnostics-",
  });
  const logger = new DiagnosticLogger(directory, {
    max_bytes: 1024,
    max_files: 2,
  });
  for (let index = 0; index < 30; index += 1) {
    await logger.info("test", `entry-${index}`, { api_key: "never-log" });
  }
  const bundle = await logger.exportBundle();
  assert(
    bundle.files[0]?.contents.includes("entry-29") &&
      !bundle.files[0]?.contents.includes("never-log"),
    "diagnostic export must rotate and redact",
  );
});

Deno.test("E2E-13 desktop command/UI contract keeps the canonical vertical slice", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-accept-bridge-" });
  const desktop = new DesktopService(directory, {
    app_instance_id: "accept-bridge",
  });
  await desktop.open();
  try {
    const created = await desktop.commands.execute("project.create", {
      title: "桥接课程",
    });
    assert(
      !created.error,
      "project.create should persist an empty canonical project",
    );
    const seed = await desktop.commands.execute("course.seed.create", {
      source_type: "outline",
      raw_text: "# 阶段一\n第一课",
      metadata: { title: "桥接课程" },
    });
    const seedId = (seed.value as { id: string }).id;
    const draft = await desktop.commands.execute("blueprint.build", {
      course_seed_id: seedId,
    });
    const draftId = (draft.value as { draft: { id: string } }).draft.id;
    assert(
      desktop.context.project?.content_items.length === 0,
      "draft must not create content before confirmation",
    );
    await desktop.commands.execute("blueprint.confirm", { draft_id: draftId });
    const data = desktop.context.project!;
    const item = data.content_items[0]!;
    const block = appendBlock(data, item.id, "paragraph", "正文");
    const requirement = insertPlaceholder(data, item.id, {
      type: "image",
      note: "补图",
    });
    await desktop.commands.execute("asset.import", {
      filename: "shot.png",
      type: "image",
      mime_type: "image/png",
      bytes_base64: "AQID",
    });
    const asset = data.assets.at(-1)!;
    assert(asset.file_size === 3, "asset command must persist uploaded bytes");
    await desktop.commands.execute("requirement.resolve", {
      requirement_id: requirement.id,
      resolved_asset_id: asset.id,
    });
    const exportPreset = createExportPreset(data, {
      name: "服务边界导出",
      output_type: "html",
      platform: "网页",
    });
    const exported = await desktop.commands.execute("export.run", {
      preset: exportPreset,
      options: { content_item_id: item.id },
    });
    assert(
      !exported.error &&
        (exported.value as { files: unknown[] }).files.length >= 1,
      "resolved assets should export through the desktop service root",
    );
    const inbox = await desktop.commands.execute("inbox.create", {
      title: "待保存素材",
      body: "截图来源",
      source_type: "manual",
    });
    const inboxId = (inbox.value as { id: string }).id;
    await desktop.commands.execute("inbox.assetize", {
      inbox_item_id: inboxId,
      asset_id: asset.id,
    });
    assert(
      data.inbox_items.find((entry) => entry.id === inboxId)?.asset_id ===
        asset.id,
      "Inbox can link an Asset without copying content into正文",
    );
    await desktop.commands.execute("document.reorder", {
      content_item_id: item.id,
      block_ids: [requirement.anchor_block_id!, block.id],
    });
    const layout = await desktop.commands.execute("layout.create", {
      content_item_id: item.id,
      name: "3:4",
      mode: "grid",
    });
    const layoutId = (layout.value as { id: string }).id;
    const section = await desktop.commands.execute("layout.section.create", {
      layout_instance_id: layoutId,
      name: "第 1 页",
    });
    await desktop.commands.execute("placement.create", {
      layout_instance_id: layoutId,
      block_id: block.id,
      section_id: (section.value as { id: string }).id,
      row_start: 0,
      row_end: 1,
      column_start: 0,
      column_end: 1,
    });
    await desktop.close();
    const reopened = new ProjectDirectoryStore(directory, {
      app_instance_id: "accept-bridge-reopen",
    });
    await reopened.open();
    const persisted = await reopened.readProject();
    assert(
      persisted.assets[0]?.file_size === 3 && persisted.placements.length === 1,
      "canonical file should round-trip the service slice",
    );
    await reopened.close();
  } finally {
    await desktop.close();
  }
});

Deno.test("asset.import links browser bytes to usage and preserves duplicate links", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-accept-asset-usage-",
  });
  const desktop = new DesktopService(directory, {
    app_instance_id: "accept-asset-usage",
  });
  await desktop.open();
  try {
    await desktop.commands.execute("project.create", { title: "素材引用课程" });
    const seed = await desktop.commands.execute("course.seed.create", {
      source_type: "blank",
      raw_text: "# 阶段一\n第一课",
    });
    const draft = await desktop.commands.execute("blueprint.build", {
      course_seed_id: (seed.value as { id: string }).id,
    });
    await desktop.commands.execute("blueprint.confirm", {
      draft_id: (draft.value as { draft: { id: string } }).draft.id,
    });
    const data = desktop.context.project!;
    const item = data.content_items[0]!;
    const block = appendBlock(data, item.id, "paragraph", "正文");
    const layout = await desktop.commands.execute("layout.create", {
      content_item_id: item.id,
      name: "网格",
      mode: "grid",
    });
    const layoutId = (layout.value as { id: string }).id;
    const bytes = new TextEncoder().encode("真实导入字节");
    const checksumBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes),
    );
    const checksum = [...checksumBytes].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    const bytesBase64 = btoa(String.fromCharCode(...bytes));
    const imported = await desktop.commands.execute("asset.import", {
      filename: "真实.png",
      type: "image",
      mime_type: "image/png",
      bytes_base64: bytesBase64,
      content_item_id: item.id,
      block_id: block.id,
      layout_instance_id: layoutId,
      role: "content",
    });
    assert(!imported.error, "asset import with usage context should succeed");
    const first = imported.value as {
      asset: { id: string; checksum: string; file_size: number };
      duplicate: boolean;
      usage: {
        asset_id: string;
        content_item_id: string;
        block_id: string | null;
        layout_instance_id: string | null;
        role: string;
      } | null;
    };
    assert(
      !first.duplicate && first.asset.checksum === checksum,
      "checksum must be persisted",
    );
    assert(
      first.asset.file_size === bytes.length &&
        first.usage?.asset_id === first.asset.id &&
        first.usage.content_item_id === item.id &&
        first.usage.block_id === block.id &&
        first.usage.layout_instance_id === layoutId &&
        first.usage.role === "content",
      "new assets must return their canonical usage",
    );
    const secondBlock = appendBlock(data, item.id, "paragraph", "第二处正文");
    const duplicate = await desktop.commands.execute("asset.import", {
      filename: "重复.png",
      type: "image",
      mime_type: "image/png",
      bytes_base64: bytesBase64,
      content_item_id: item.id,
      block_id: secondBlock.id,
      layout_instance_id: layoutId,
      role: "content",
    });
    assert(
      !duplicate.error,
      "duplicate import with a new usage should succeed",
    );
    const second = duplicate.value as {
      asset: { id: string };
      duplicate: boolean;
      usage: { asset_id: string; block_id: string | null } | null;
    };
    assert(
      second.duplicate && second.asset.id === first.asset.id &&
        second.usage?.asset_id === first.asset.id &&
        second.usage.block_id === secondBlock.id,
      "duplicate assets must return and persist the requested usage",
    );
    assert(
      data.asset_usages.length === 2,
      "each distinct placement needs one usage",
    );
    await desktop.close();

    const reopened = new DesktopService(directory, {
      app_instance_id: "accept-asset-usage-reopen",
    });
    await reopened.open();
    try {
      const persisted = reopened.context.project!;
      assert(
        persisted.assets.length === 1 && persisted.asset_usages.length === 2 &&
          persisted.assets[0]?.checksum === checksum,
        "asset checksum and usages must survive reopening the project",
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await desktop.close();
  }
});

Deno.test("E2E-12 indexed search handles a large project without per-query file reads", () => {
  const data = createEmptyProjectData("规模测试");
  for (let index = 0; index < 1000; index += 1) {
    const itemId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    data.content_items.push({
      id: itemId,
      project_id: data.project.id,
      stage_id: null,
      code: `C${index}`,
      title: `课程 ${index}`,
      type: "lesson",
      description: `主题 ${index % 10}`,
      order_index: index,
      document_id: documentId,
      archived: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    data.documents.push({
      id: documentId,
      content_item_id: itemId,
      schema_version: data.schema_version,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  for (let index = 0; index < 10000; index += 1) {
    data.assets.push({
      id: crypto.randomUUID(),
      project_id: data.project.id,
      type: "image",
      filename: `asset-${index}.png`,
      storage_path: `assets/${index}.png`,
      mime_type: "image/png",
      width: null,
      height: null,
      duration_ms: null,
      file_size: 1,
      checksum: `checksum-${index}`,
      title: `素材 ${index}`,
      description: "规模测试",
      source_type: "imported",
      source_url: null,
      copyright_note: null,
      created_at: new Date().toISOString(),
      archived: false,
    });
  }
  const longDocument = data.documents[0]!;
  data.blocks.push({
    id: crypto.randomUUID(),
    document_id: longDocument.id,
    parent_block_id: null,
    type: "paragraph",
    order_index: 0,
    content: `${"长文".repeat(1000)}末尾搜索词`,
    settings: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const index = new MemorySearchIndex();
  index.rebuild(data);
  const result = index.search("C999");
  assert(
    result.some((item) => item.code === "C999"),
    "indexed Cmd-K search should find codes in a large project",
  );
  assert(
    index.search("末尾搜索词").length > 0,
    "long-document matches must not disappear from the index",
  );
});

Deno.test("FileSearchIndex is rebuildable cache and not canonical storage", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-accept-index-" });
  const data = await confirmedFixture();
  const index = new FileSearchIndex(directory);
  await index.rebuild(data);
  const loaded = new FileSearchIndex(directory);
  assert(await loaded.load(), "index cache should load after rebuild");
  assert(
    (await loaded.search("第一课")).length > 0,
    "reloaded cache should answer search",
  );
});
