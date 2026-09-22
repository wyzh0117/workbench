import { createEmptyProjectData } from "../domain/store.ts";
import { applyChangeDraft } from "../domain/ai.ts";
import { join } from "node:path";
import type { AssetType, JsonObject, ProjectData } from "../domain/types.ts";
import { addAssetUsage } from "../domain/assets.ts";
import {
  buildBlueprintDraft,
  confirmBlueprint,
  createCourseSeed,
  discardBlueprint,
} from "../domain/course.ts";
import { createInboxItem, triageInboxItem } from "../domain/workflow.ts";
import { assignStatus } from "../domain/status.ts";
import { reorderBlocks } from "../domain/document.ts";
import { resolveRequirement } from "../domain/requirements.ts";
import {
  addLayoutSection,
  addPlacement,
  createLayoutInstance,
} from "../domain/layout.ts";
import {
  AiTransport,
  type AiTransportOptions,
} from "./ai_transport.ts";
import { AuditLog } from "./audit.ts";
import { BrowserSessionStore } from "./browser_session.ts";
import { CommandBus, type CommandContext, QueryBus } from "./commands.ts";
import { EventBus } from "./events.ts";
import { error, ServiceError } from "./errors.ts";
import { JobManager } from "./jobs.ts";
import {
  MacKeychainSecretStore,
  type SecretStore,
} from "./security.ts";
import { DiagnosticLogger } from "./diagnostics.ts";
import {
  createSearchIndex,
  MemorySearchIndex,
  SearchService,
} from "./search.ts";
import {
  ConnectorRegistry,
  ImportedConversationConnector,
  syncSelectedConversations,
} from "./connectors.ts";
import {
  type FileFingerprint,
  type ProjectDirectoryOptions,
  ProjectDirectoryStore,
} from "./storage.ts";
import {
  confirmImport,
  exportProject,
  type ImportPreview,
  type ImportSource,
  ManualPublishAdapter,
  preflightExport,
  previewImport,
} from "./import_export.ts";
import type { ExportPreset } from "../domain/types.ts";

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeImportSources(value: unknown): ImportSource[] {
  if (!Array.isArray(value)) return [];
  return value.map((source) => {
    if (!source || typeof source !== "object") return source as ImportSource;
    const candidate = source as ImportSource & { bytes_base64?: unknown };
    if (typeof candidate.bytes_base64 === "string") {
      return {
        ...candidate,
        bytes: decodeBase64(candidate.bytes_base64),
      } as ImportSource;
    }
    return candidate;
  });
}

/** Small composition root for the UI bridge; all system access stays behind it. */
export class DesktopService {
  readonly store: ProjectDirectoryStore;
  /** Browser reader metadata is separate from canonical project storage. */
  readonly browserSession: BrowserSessionStore;
  readonly events = new EventBus();
  readonly jobs = new JobManager();
  readonly audit = new AuditLog();
  readonly secrets: SecretStore;
  readonly diagnostics: DiagnosticLogger;
  readonly search: SearchService;
  readonly connectors = new ConnectorRegistry();
  readonly context: CommandContext;
  readonly commands: CommandBus;
  readonly queries: QueryBus;
  private readonly importPreviews = new Map<string, ImportPreview>();
  /** In-flight `ai.complete` requests, shared across project directories. */
  private readonly aiRequests = new Map<string, AbortController>();
  private readonly aiOptions: AiTransportOptions;
  private aiTransportInstance: AiTransport | null = null;
  private aiTransportDirectory: string | null = null;

  constructor(
    directory: string,
    options: ProjectDirectoryOptions = {},
    secrets: SecretStore = new MacKeychainSecretStore(),
    aiOptions: AiTransportOptions = {},
  ) {
    this.store = new ProjectDirectoryStore(directory, options);
    this.browserSession = new BrowserSessionStore(this.store.directory);
    this.aiOptions = aiOptions;
    this.diagnostics = new DiagnosticLogger(
      join(directory, ".workspace", "diagnostics"),
    );
    this.search = new SearchService(
      options.read_only
        ? new MemorySearchIndex()
        : createSearchIndex(join(directory, ".workspace")),
    );
    this.secrets = secrets;
    this.context = {
      project: null,
      eventBus: this.events,
      audit: this.audit,
      source: "user",
    };
    this.commands = new CommandBus(
      this.context,
      undefined,
      async (safe, command) => {
        await this.diagnostics.write(
          safe.severity === "fatal" ? "fatal" : "error",
          safe.code,
          safe.technical_message,
          { command, severity: safe.severity, ...safe.details },
        );
      },
    );
    this.queries = new QueryBus(this.context);
    this.registerCommands();
    this.registerQueries();
  }

  private registerCommands(): void {
    this.commands.register("project.open", async () => {
      try {
        this.context.project = await this.store.readProject();
      } catch (caught) {
        if (caught instanceof Deno.errors.NotFound) {
          this.context.project = null;
          return { value: null };
        }
        throw caught;
      }
      if (!this.context.project) return { value: null };
      await this.search.rebuild(this.context.project);
      return {
        value: this.context.project,
        audit: {
          object_type: "project",
          object_id: this.context.project.project.id,
          action: "open",
        },
      };
    });
    this.commands.register("project.create", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as { title?: string; description?: string; language?: string }
        : {};
      this.context.project = createEmptyProjectData(
        candidate.title ?? "未命名课程",
        candidate.description ?? "",
        candidate.language ?? "zh-CN",
      );
      await this.store.writeProject(this.context.project);
      await this.search.rebuild(this.context.project);
      return {
        value: this.context.project,
        events: [EventBus.domainEvent({
          type: "ProjectChanged",
          project_id: this.context.project.project.id,
          entity_type: "project",
          entity_id: this.context.project.project.id,
          source: "user",
          metadata: { action: "created" },
        })],
        audit: {
          object_type: "project",
          object_id: this.context.project.project.id,
          action: "create",
        },
      };
    });
    this.commands.register("project.save", async (input) => {
      if (!input || typeof input !== "object") {
        throw new Error("project.save requires project data");
      }
      // The browser/native bridge sends { project: ProjectData }, while
      // service callers historically passed ProjectData directly. Accept both
      // at this boundary so the canonical writer never receives the envelope.
      const envelope = input as { project?: unknown };
      const nested = envelope.project;
      const candidate = nested && typeof nested === "object" &&
          "project" in nested
        ? nested as ProjectData
        : input as ProjectData;
      await this.store.saveWithRecovery(candidate);
      this.context.project = candidate;
      await this.search.rebuild(candidate);
      return {
        value: candidate,
        audit: {
          object_type: "project",
          object_id: candidate.project.id,
          action: "save",
        },
      };
    });
    this.commands.register("project.external.inspect", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as { project?: ProjectData }
        : {};
      return {
        value: await this.store.inspectExternalModification(
          candidate.project ?? this.context.project,
        ),
      };
    });
    this.commands.register("project.reload", async () => {
      this.context.project = await this.store.readProject();
      await this.search.rebuild(this.context.project);
      return {
        value: this.context.project,
        audit: {
          object_type: "project",
          object_id: this.context.project.project.id,
          action: "reload_external",
        },
      };
    });
    this.commands.register("project.merge", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as { project?: ProjectData }
        : {};
      const local = candidate.project ?? this.context.project;
      if (!local) throw new Error("No project is open");
      return { value: await this.store.mergeExternalChanges(local) };
    });
    this.commands.register("project.resolve", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as {
          project?: ProjectData;
          expected_current?: FileFingerprint;
        }
        : {};
      if (!candidate.project || !candidate.expected_current) {
        throw new Error("project.resolve requires project and expected_current");
      }
      await this.store.resolveExternalChanges(
        candidate.project,
        candidate.expected_current,
      );
      this.context.project = candidate.project;
      await this.search.rebuild(candidate.project);
      return {
        value: candidate.project,
        audit: {
          object_type: "project",
          object_id: candidate.project.project.id,
          action: "resolve_external",
        },
      };
    });
    this.commands.register("course.seed.create", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          source_type?: Parameters<typeof createCourseSeed>[1]["source_type"];
          raw_text?: string | null;
          source_files?: Parameters<typeof createCourseSeed>[1]["source_files"];
          metadata?: Parameters<typeof createCourseSeed>[1]["metadata"];
        }
        : {};
      const seed = createCourseSeed(this.context.project, {
        source_type: candidate.source_type ?? "blank",
        raw_text: candidate.raw_text ?? null,
        source_files: candidate.source_files,
        metadata: candidate.metadata,
      });
      await this.store.saveWithRecovery(this.context.project);
      await this.search.rebuild(this.context.project);
      return {
        value: seed,
        audit: {
          object_type: "course_seed",
          object_id: seed.id,
          action: "create",
        },
      };
    });
    this.commands.register("blueprint.build", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as { course_seed_id?: string }
        : {};
      if (!candidate.course_seed_id) {
        throw new Error("blueprint.build requires course_seed_id");
      }
      const draft = buildBlueprintDraft(
        this.context.project,
        candidate.course_seed_id,
      );
      await this.store.saveWithRecovery(this.context.project);
      await this.search.rebuild(this.context.project);
      return {
        value: {
          draft,
          nodes: this.context.project.blueprint_nodes.filter((node) =>
            node.blueprint_id === draft.id
          ),
        },
        audit: {
          object_type: "blueprint_draft",
          object_id: draft.id,
          action: "build",
        },
      };
    });
    this.commands.register("blueprint.confirm", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as { blueprint_id?: string; draft_id?: string }
        : {};
      const draftId = candidate.blueprint_id ?? candidate.draft_id;
      if (!draftId) throw new Error("blueprint.confirm requires draft_id");
      confirmBlueprint(this.context.project, draftId);
      await this.store.saveWithRecovery(this.context.project);
      await this.search.rebuild(this.context.project);
      return {
        value: this.context.project,
        audit: {
          object_type: "blueprint_draft",
          object_id: draftId,
          action: "confirm",
        },
      };
    });
    this.commands.register("blueprint.discard", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as { blueprint_id?: string; draft_id?: string }
        : {};
      const draftId = candidate.blueprint_id ?? candidate.draft_id;
      if (!draftId) throw new Error("blueprint.discard requires draft_id");
      discardBlueprint(this.context.project, draftId);
      await this.store.saveWithRecovery(this.context.project);
      await this.search.rebuild(this.context.project);
      return {
        value: this.context.project.blueprint_drafts.find((draft) =>
          draft.id === draftId
        ),
        audit: {
          object_type: "blueprint_draft",
          object_id: draftId,
          action: "discard",
        },
      };
    });
    this.commands.register("asset.import", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          source_path?: string;
          type?: AssetType;
          filename?: string;
          mime_type?: string;
          title?: string;
          description?: string;
          content_item_id?: string | null;
          block_id?: string | null;
          layout_instance_id?: string | null;
          role?: string | null;
        }
        : {};
      let sourcePath = candidate.source_path;
      let temporaryPath: string | null = null;
      const withBytes = candidate as typeof candidate & {
        bytes_base64?: unknown;
      };
      if (!sourcePath && typeof withBytes.bytes_base64 === "string") {
        temporaryPath = await Deno.makeTempFile({ suffix: "-asset" });
        await Deno.writeFile(
          temporaryPath,
          decodeBase64(withBytes.bytes_base64),
        );
        sourcePath = temporaryPath;
      }
      if (!sourcePath) {
        throw new Error("asset.import requires source_path or bytes_base64");
      }
      let result;
      try {
        result = await this.store.importAssetFile(
          this.context.project,
          sourcePath,
          {
            type: candidate.type ?? "other",
            mime_type: candidate.mime_type ?? "application/octet-stream",
            title: candidate.title,
            description: candidate.description,
            filename: candidate.filename,
          },
          "existing",
        );
      } finally {
        if (temporaryPath) {
          await Deno.remove(temporaryPath).catch(() => undefined);
        }
      }
      const contentItemId = typeof candidate.content_item_id === "string"
        ? candidate.content_item_id.trim()
        : "";
      const blockId = typeof candidate.block_id === "string" &&
          candidate.block_id.trim()
        ? candidate.block_id.trim()
        : null;
      const layoutInstanceId =
        typeof candidate.layout_instance_id === "string" &&
          candidate.layout_instance_id.trim()
          ? candidate.layout_instance_id.trim()
          : null;
      const role = typeof candidate.role === "string" && candidate.role.trim()
        ? candidate.role.trim()
        : "content";
      const usage = contentItemId
        ? addAssetUsage(this.context.project, result.asset.id, contentItemId, {
          block_id: blockId,
          layout_instance_id: layoutInstanceId,
          role,
        })
        : null;
      await this.store.saveWithRecovery(this.context.project);
      await this.search.rebuild(this.context.project);
      return {
        value: { ...result, usage },
        audit: {
          object_type: "asset",
          object_id: result.asset.id,
          action: "import",
        },
      };
    });
    this.commands.register("inbox.create", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          title?: string;
          body?: string;
          source_type?: string;
          asset_id?: string | null;
        }
        : {};
      const item = createInboxItem(this.context.project, {
        title: candidate.title ?? "快速收集",
        body: candidate.body ?? "",
        source_type: candidate.source_type,
        asset_id: candidate.asset_id,
      });
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: item,
        audit: {
          object_type: "inbox_item",
          object_id: item.id,
          action: "create",
        },
      };
    });
    this.commands.register("inbox.triage", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as { inbox_item_id?: string; content_item_id?: string | null }
        : {};
      if (!candidate.inbox_item_id) {
        throw new Error("inbox.triage requires inbox_item_id");
      }
      const item = triageInboxItem(
        this.context.project,
        candidate.inbox_item_id,
        candidate.content_item_id,
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: item,
        audit: {
          object_type: "inbox_item",
          object_id: item.id,
          action: "triage",
        },
      };
    });
    this.commands.register("inbox.assetize", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          inbox_item_id?: string;
          asset_id?: string;
          bytes_base64?: string;
          filename?: string;
          type?: AssetType;
          mime_type?: string;
        }
        : {};
      if (!candidate.inbox_item_id) {
        throw new Error("inbox.assetize requires inbox_item_id");
      }
      const item = this.context.project.inbox_items.find((entry) =>
        entry.id === candidate.inbox_item_id
      );
      if (!item) throw new Error("找不到收件箱条目");
      let asset = candidate.asset_id
        ? this.context.project.assets.find((entry) =>
          entry.id === candidate.asset_id
        )
        : null;
      if (candidate.asset_id && !asset) throw new Error("找不到要关联的素材");
      if (
        asset &&
        (asset.project_id !== this.context.project.project.id || asset.archived)
      ) {
        throw new Error("素材不能关联到当前项目");
      }
      if (!asset && typeof candidate.bytes_base64 === "string") {
        const temporaryPath = await Deno.makeTempFile({ suffix: "-asset" });
        try {
          await Deno.writeFile(
            temporaryPath,
            decodeBase64(candidate.bytes_base64),
          );
          asset = (await this.store.importAssetFile(
            this.context.project,
            temporaryPath,
            {
              type: candidate.type ?? "other",
              mime_type: candidate.mime_type ?? "application/octet-stream",
              filename: candidate.filename ?? item.title,
            },
            "existing",
          )).asset;
        } finally {
          await Deno.remove(temporaryPath).catch(() => undefined);
        }
      }
      if (!asset) throw new Error("收件箱条目没有可保存的素材内容");
      item.asset_id = asset.id;
      item.updated_at = new Date().toISOString();
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: { item, asset },
        audit: {
          object_type: "inbox_item",
          object_id: item.id,
          action: "assetize",
        },
      };
    });
    this.commands.register("status.assign", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          content_item_id?: string;
          dimension_key?: string;
          option_key?: string;
        }
        : {};
      if (
        !candidate.content_item_id || !candidate.dimension_key ||
        !candidate.option_key
      ) {
        throw new Error(
          "status.assign requires content_item_id, dimension_key, and option_key",
        );
      }
      const assignment = assignStatus(
        this.context.project,
        candidate.content_item_id,
        candidate.dimension_key,
        candidate.option_key,
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: assignment,
        audit: {
          object_type: "status_assignment",
          object_id: assignment.id,
          action: "assign",
        },
      };
    });
    this.commands.register("document.reorder", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as { content_item_id?: string; block_ids?: string[] }
        : {};
      if (!candidate.content_item_id || !Array.isArray(candidate.block_ids)) {
        throw new Error(
          "document.reorder requires content_item_id and block_ids",
        );
      }
      reorderBlocks(
        this.context.project,
        candidate.content_item_id,
        candidate.block_ids,
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: this.context.project.blocks.filter((block) =>
          candidate.block_ids?.includes(block.id)
        ).sort((a, b) => a.order_index - b.order_index),
        audit: {
          object_type: "document",
          object_id: candidate.content_item_id,
          action: "reorder",
        },
      };
    });
    this.commands.register("requirement.resolve", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          requirement_id?: string;
          resolved_asset_id?: string | null;
          resolved_block_id?: string | null;
        }
        : {};
      if (!candidate.requirement_id) {
        throw new Error("requirement.resolve requires requirement_id");
      }
      const requirement = resolveRequirement(
        this.context.project,
        candidate.requirement_id,
        candidate.resolved_asset_id ?? null,
        candidate.resolved_block_id ?? null,
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: requirement,
        audit: {
          object_type: "requirement",
          object_id: requirement.id,
          action: "resolve",
        },
      };
    });
    this.commands.register("layout.create", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          content_item_id?: string;
          name?: string;
          mode?: "flow" | "grid";
          grid_definition?: JsonObject;
        }
        : {};
      if (!candidate.content_item_id) {
        throw new Error("layout.create requires content_item_id");
      }
      const layout = createLayoutInstance(
        this.context.project,
        candidate.content_item_id,
        {
          name: candidate.name ?? "默认排版",
          mode: candidate.mode ?? "grid",
          grid_definition: candidate.grid_definition ??
            { columns: [1, 1, 1], rows: [1, 1, 1] },
        },
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: layout,
        audit: {
          object_type: "layout",
          object_id: layout.id,
          action: "create",
        },
      };
    });
    this.commands.register("layout.section.create", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          layout_instance_id?: string;
          name?: string;
          page_index?: number;
        }
        : {};
      if (!candidate.layout_instance_id) {
        throw new Error("layout.section.create requires layout_instance_id");
      }
      const section = addLayoutSection(
        this.context.project,
        candidate.layout_instance_id,
        {
          name: candidate.name ?? "新分区",
          page_index: candidate.page_index,
        },
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: section,
        audit: {
          object_type: "layout_section",
          object_id: section.id,
          action: "create",
        },
      };
    });
    this.commands.register("placement.create", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          layout_instance_id?: string;
          block_id?: string;
          section_id?: string | null;
          row_start?: number;
          row_end?: number;
          column_start?: number;
          column_end?: number;
        }
        : {};
      if (!candidate.layout_instance_id || !candidate.block_id) {
        throw new Error(
          "placement.create requires layout_instance_id and block_id",
        );
      }
      const placement = addPlacement(
        this.context.project,
        candidate.layout_instance_id,
        candidate.block_id,
        {
          section_id: candidate.section_id,
          row_start: candidate.row_start ?? 0,
          row_end: candidate.row_end ?? 1,
          column_start: candidate.column_start ?? 0,
          column_end: candidate.column_end ?? 1,
        },
      );
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: placement,
        audit: {
          object_type: "placement",
          object_id: placement.id,
          action: "create",
        },
      };
    });
    this.commands.register("import.preview", async (input) => {
      const candidate = input && typeof input === "object"
        ? input as {
          sources?: ImportSource[];
          mode?: "content" | "blueprint" | "asset" | "project";
        }
        : {};
      const preview = await previewImport(
        normalizeImportSources(candidate.sources),
        {
          data: this.context.project,
          mode: candidate.mode,
        },
      );
      this.importPreviews.set(preview.id, preview);
      return {
        value: preview,
        audit: {
          object_type: "import",
          action: "preview",
          metadata: { count: preview.items.length, mode: preview.mode },
        },
      };
    });
    this.commands.register("import.confirm", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          preview?: ImportPreview;
          options?: Parameters<typeof confirmImport>[2];
        }
        : {};
      if (!candidate.preview) {
        throw new Error("import.confirm requires a preview");
      }
      const preview = this.importPreviews.get(candidate.preview.id) ??
        candidate.preview;
      const result = await confirmImport(
        this.context.project,
        preview,
        candidate.options ?? {},
      );
      this.importPreviews.delete(preview.id);
      // A confirmed project import returns a migrated replacement project;
      // content/asset imports mutate the current project in place.
      if (result.project) this.context.project = result.project;
      await this.store.saveWithRecovery(this.context.project);
      await this.search.rebuild(this.context.project);
      return {
        value: result,
        audit: {
          object_type: "import",
          action: "confirm",
          metadata: { mode: result.mode },
        },
      };
    });
    this.commands.register("export.run", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          preset?: ExportPreset;
          preset_id?: string;
          options?: Parameters<typeof exportProject>[2];
        }
        : {};
      const preset = candidate.preset ??
        this.context.project.export_presets.find((item) =>
          item.id === candidate.preset_id
        );
      if (!preset) throw new Error("export.run requires an export preset");
      const result = await exportProject(
        this.context.project,
        preset,
        {
          ...(candidate.options ?? {}),
          project_root: this.store.directory,
        },
      );
      return {
        value: result,
        audit: {
          object_type: "export",
          object_id: preset.id,
          action: "run",
          metadata: { target: result.target, files: result.files.length },
        },
      };
    });
    this.commands.register("publication.record", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          content_item_id?: string;
          preset?: ExportPreset;
          preset_id?: string;
          options?: Parameters<typeof exportProject>[2];
          external_url?: string | null;
          version_label?: string;
          export_path?: string | null;
        }
        : {};
      const preset = candidate.preset ??
        this.context.project.export_presets.find((item) =>
          item.id === candidate.preset_id
        );
      if (!preset || !candidate.content_item_id) {
        throw new Error(
          "publication.record requires content_item_id and export preset",
        );
      }
      const adapter = new ManualPublishAdapter(preset.platform);
      const request = {
        data: this.context.project,
        content_item_id: candidate.content_item_id,
        preset,
        options: {
          ...(candidate.options ?? {}),
          project_root: this.store.directory,
        },
        external_url: candidate.external_url,
        version_label: candidate.version_label,
        export_path: candidate.export_path,
      };
      const prepared = await adapter.prepare(request);
      const publication = await adapter.publish(request, prepared);
      await this.store.saveWithRecovery(this.context.project);
      return {
        value: publication,
        audit: {
          object_type: "publication",
          object_id: publication.id,
          action: "record",
          metadata: { platform: publication.platform },
        },
      };
    });
    this.commands.register("snapshot.create", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as { name?: string; note?: string }
        : {};
      const project = structuredClone(this.context.project);
      const snapshot = await this.store.createSnapshot(
        project,
        candidate.name ?? "未命名版本",
        candidate.note ?? "",
      );
      this.context.project = project;
      await this.search.rebuild(this.context.project);
      return {
        value: snapshot,
        events: [
          EventBus.domainEvent({
            type: "SnapshotCreated",
            project_id: project.project.id,
            entity_type: "snapshot",
            entity_id: snapshot.id,
            source: "user",
            metadata: {},
          }),
        ],
        audit: {
          object_type: "snapshot",
          object_id: snapshot.id,
          action: "create",
        },
      };
    });
    this.commands.register("snapshot.restore", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const snapshotId = input && typeof input === "object" &&
          typeof (input as { snapshot_id?: unknown }).snapshot_id === "string"
        ? (input as { snapshot_id: string }).snapshot_id
        : "";
      if (!snapshotId) throw new Error("snapshot_id is required");
      const restored = await this.store.restoreSnapshot(
        structuredClone(this.context.project),
        snapshotId,
      );
      this.context.project = restored.project;
      await this.search.rebuild(this.context.project);
      return {
        value: restored,
        audit: {
          object_type: "project",
          object_id: restored.project.project.id,
          action: "restore",
          metadata: { snapshot_id: snapshotId },
        },
      };
    });
    this.commands.register("connector.sync", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          source?: unknown;
          selected_ids?: string[];
          provider?: string;
          display_name?: string;
          account_label?: string;
        }
        : {};
      if (candidate.source === undefined) {
        throw new Error("connector.sync requires an explicit import source");
      }
      const connector = new ImportedConversationConnector(
        candidate.source as never,
        {
          provider: candidate.provider,
          display_name: candidate.display_name,
          account_label: candidate.account_label,
        },
      );
      this.connectors.register(
        candidate.provider ?? "local-import",
        connector,
      );
      await connector.sync();
      const selected = candidate.selected_ids ?? [];
      const result = selected.length
        ? await syncSelectedConversations(
          this.context.project,
          connector,
          selected,
        )
        : { source: null, conversations: [], messages: [] };
      if (selected.length) {
        await this.store.saveWithRecovery(this.context.project);
        await this.search.rebuild(this.context.project);
      }
      return {
        value: {
          metadata: await connector.get_metadata(),
          listed: await connector.listConversations(),
          imported: result,
        },
        audit: {
          object_type: "conversation",
          action: "sync",
          metadata: { selected_count: selected.length },
        },
      };
    });
    this.commands.register("ai.analyze", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      await Promise.resolve();
      const candidate = input && typeof input === "object"
        ? input as {
          selected_context?: unknown[];
          purpose?: string;
          target_content_item_id?: string | null;
        }
        : {};
      const selected = Array.isArray(candidate.selected_context)
        ? candidate.selected_context
        : [];
      // The service deliberately returns an analysis envelope only. Canonical
      // data is untouched until a user reviews a Suggestion/ChangeDraft.
      return {
        value: {
          status: "suggestion_pending",
          selected_count: selected.length,
          purpose: candidate.purpose ?? "分析当前内容",
          target_content_item_id: candidate.target_content_item_id ?? null,
        },
        audit: {
          object_type: "ai",
          action: "analyze",
          metadata: { selected_count: selected.length },
        },
      };
    });
    this.commands.register("suggestion.apply", async (input) => {
      if (!this.context.project) throw new Error("No project is open");
      const candidate = input && typeof input === "object"
        ? input as {
          change_draft_id?: string;
          confirmed?: boolean;
          patch_ids?: string[];
        }
        : {};
      if (!candidate.change_draft_id) {
        throw new Error("suggestion.apply requires change_draft_id");
      }
      const draft = applyChangeDraft(
        this.context.project,
        candidate.change_draft_id,
        {
          confirmed: candidate.confirmed === true,
          patch_ids: candidate.patch_ids,
        },
      );
      await this.store.saveWithRecovery(this.context.project);
      await this.search.rebuild(this.context.project);
      return {
        value: draft,
        audit: {
          object_type: "change_draft",
          object_id: draft.id,
          action: "apply",
        },
      };
    });
    this.commands.register("secret.set", async (input) => {
      const candidate = input as { provider?: string; value?: string };
      await this.secrets.set(candidate.provider ?? "", candidate.value ?? "");
      return {
        value: { provider: candidate.provider ?? "" },
        audit: {
          object_type: "secret",
          object_id: candidate.provider ?? null,
          action: "set",
        },
      };
    });
    this.commands.register("secret.delete", async (input) => {
      const provider = input && typeof input === "object" &&
          typeof (input as { provider?: unknown }).provider === "string"
        ? (input as { provider: string }).provider
        : "";
      await this.secrets.delete(provider);
      return {
        value: { provider },
        audit: { object_type: "secret", object_id: provider, action: "delete" },
      };
    });
    // ---- V0-T03 AI workflow (browser shell transport) ----------------------
    // `ai.analyze` / `suggestion.apply` / `secret.*` keep their existing
    // behaviour: these commands own provider connections and the live
    // transport, and they never place a credential in a result or an audit.
    this.commands.register("ai.connection.list", async () => {
      // The only AI command that stays usable before a project exists.
      if (!this.context.project) {
        return {
          value: { providers: [], configured: {} },
          audit: {
            object_type: "ai_connection",
            action: "list",
            metadata: { provider_count: 0 },
          },
        };
      }
      const connections = await this.aiTransport().listConnections();
      return {
        value: connections,
        audit: {
          object_type: "ai_connection",
          action: "list",
          metadata: { provider_count: connections.providers.length },
        },
      };
    });
    this.commands.register("ai.connection.save", async (input) => {
      this.assertAiProjectOpen();
      const saved = await this.aiTransport().saveConnection(input);
      return {
        value: saved,
        audit: {
          object_type: "ai_connection",
          object_id: saved.provider.id,
          action: "save",
        },
      };
    });
    this.commands.register("ai.connection.delete", async (input) => {
      this.assertAiProjectOpen();
      const providerId = input && typeof input === "object" &&
          typeof (input as { provider_id?: unknown }).provider_id === "string"
        ? (input as { provider_id: string }).provider_id
        : "";
      const result = await this.aiTransport().deleteConnection(providerId);
      return {
        value: result,
        audit: {
          object_type: "ai_connection",
          object_id: result.provider_id,
          action: "delete",
          metadata: { removed: result.removed },
        },
      };
    });
    this.commands.register("ai.secret.set", async (input) => {
      this.assertAiProjectOpen();
      const candidate = input && typeof input === "object"
        ? input as { provider_id?: unknown; value?: unknown }
        : {};
      const providerId = typeof candidate.provider_id === "string"
        ? candidate.provider_id
        : "";
      const value = typeof candidate.value === "string" ? candidate.value : "";
      const result = await this.aiTransport().setCredential(providerId, value);
      // The credential value is deliberately absent from the result and audit.
      return {
        value: result,
        audit: {
          object_type: "ai_secret",
          object_id: result.provider_id,
          action: "set",
          metadata: { has_value: true },
        },
      };
    });
    this.commands.register("ai.secret.delete", async (input) => {
      this.assertAiProjectOpen();
      const providerId = input && typeof input === "object" &&
          typeof (input as { provider_id?: unknown }).provider_id === "string"
        ? (input as { provider_id: string }).provider_id
        : "";
      const result = await this.aiTransport().deleteCredential(providerId);
      return {
        value: result,
        audit: {
          object_type: "ai_secret",
          object_id: result.provider_id,
          action: "delete",
          metadata: { removed: result.removed },
        },
      };
    });
    this.commands.register("ai.complete", async (input) => {
      this.assertAiProjectOpen();
      const result = await this.aiTransport().completeAiRequest(input, {});
      const candidate = input && typeof input === "object"
        ? input as { provider_id?: unknown; request_id?: unknown }
        : {};
      return {
        value: result,
        audit: {
          object_type: "ai",
          object_id: typeof candidate.request_id === "string"
            ? candidate.request_id
            : null,
          action: "complete",
          metadata: {
            provider_id: typeof candidate.provider_id === "string"
              ? candidate.provider_id
              : null,
            status: result.status,
            response_kind: result.response_kind,
          },
        },
      };
    });
    this.commands.register("ai.cancel", async (input) => {
      // Cancelling is idempotent and must never fail, even before a project is
      // open: the in-flight registry is shared across project directories.
      const requestId = input && typeof input === "object" &&
          typeof (input as { request_id?: unknown }).request_id === "string"
        ? (input as { request_id: string }).request_id
        : "";
      const result = this.aiTransport().cancelAiRequest(requestId);
      return {
        value: result,
        audit: {
          object_type: "ai",
          object_id: requestId || null,
          action: "cancel",
          metadata: { cancelled: result.cancelled },
        },
      };
    });
    this.commands.register("ai.execution.append", async (input) => {
      this.assertAiProjectOpen();
      const candidate = input && typeof input === "object"
        ? input as { record?: unknown }
        : {};
      const result = await this.aiTransport().appendExecutionRecord(
        candidate.record ?? input,
      );
      return {
        value: result,
        audit: {
          object_type: "ai_execution",
          object_id: result.id,
          action: "append",
        },
      };
    });
    this.commands.register("ai.execution.list", async (input) => {
      this.assertAiProjectOpen();
      const candidate = input && typeof input === "object"
        ? input as { limit?: unknown }
        : {};
      const records = await this.aiTransport().listExecutionRecords(
        typeof candidate.limit === "number" ? candidate.limit : undefined,
      );
      return {
        value: { records },
        audit: {
          object_type: "ai_execution",
          action: "list",
          metadata: { count: records.length },
        },
      };
    });
  }

  /** Structured failure used by every AI command that mutates project state. */
  private assertAiProjectOpen(): void {
    if (this.context.project) return;
    throw error(
      "project_not_open",
      "请先打开或新建一个课程项目，再使用 AI 功能。",
      "AI commands require an open project directory",
      {
        recoverable: true,
        recommended_action: "打开或新建课程项目后重试。",
        details: {},
      },
    );
  }

  /**
   * Read the current project directory on every call so a project switch moves
   * the AI files with it.  The transport itself is built lazily because the
   * directory is only known once the store exists.
   */
  private aiTransport(): AiTransport {
    const directory = this.store.directory;
    if (!this.aiTransportInstance || this.aiTransportDirectory !== directory) {
      this.aiTransportInstance = new AiTransport(directory, {
        ...this.aiOptions,
        read_only: this.store.options.read_only,
        requests: this.aiRequests,
      });
      this.aiTransportDirectory = directory;
    }
    return this.aiTransportInstance;
  }

  private registerQueries(): void {
    this.queries.register("project.get", () => this.context.project);
    this.queries.register(
      "snapshots.list",
      () => this.context.project?.snapshots ?? [],
    );
    this.queries.register("jobs.list", () => this.jobs.list());
    this.queries.register("course.tree", () => {
      if (!this.context.project) return null;
      return {
        stages: this.context.project.stages,
        content_items: this.context.project.content_items,
      };
    });
    this.queries.register("export.preflight", async (input) => {
      if (!this.context.project) return null;
      const candidate = input && typeof input === "object"
        ? input as {
          preset?: ExportPreset;
          preset_id?: string;
          options?: Parameters<typeof preflightExport>[2];
        }
        : {};
      const preset = candidate.preset ??
        this.context.project.export_presets.find((item) =>
          item.id === candidate.preset_id
        );
      if (!preset) {
        throw new Error("export.preflight requires an export preset");
      }
      return await preflightExport(
        this.context.project,
        preset,
        {
          ...(candidate.options ?? {}),
          project_root: this.store.directory,
        },
      );
    });
    this.queries.register("requirements.missing", (input) => {
      if (!this.context.project) return [];
      const candidate = input && typeof input === "object"
        ? input as { content_item_id?: string }
        : {};
      return this.context.project.requirements.filter((requirement) =>
        requirement.status === "open" &&
        (!candidate.content_item_id ||
          requirement.content_item_id === candidate.content_item_id)
      );
    });
    this.queries.register("search.query", async (input) => {
      const query = input && typeof input === "object" &&
          typeof (input as { query?: unknown }).query === "string"
        ? (input as { query: string }).query
        : "";
      return await this.search.search(
        query,
        input && typeof input === "object"
          ? input as { limit?: number; types?: never }
          : {},
      );
    });
    this.queries.register("assets.search", async (input) => {
      const query = input && typeof input === "object" &&
          typeof (input as { query?: unknown }).query === "string"
        ? (input as { query: string }).query
        : "";
      return await this.search.search(query, {
        limit: input && typeof input === "object"
          ? (input as { limit?: number }).limit
          : undefined,
        types: ["asset"],
      });
    });
    this.queries.register("connector.health", async () => {
      return await this.connectors.health();
    });
    this.queries.register("diagnostics.export", async () => {
      return await this.diagnostics.exportBundle();
    });
  }

  /**
   * Read a browser resume pointer only after checking the current canonical
   * project. Missing, corrupt, stale, or inaccessible records are equivalent
   * to no pointer so the launcher remains usable.
   */
  async loadBrowserSession(): Promise<Record<string, unknown> | null> {
    let project: ProjectData;
    try {
      project = await this.store.readProject();
    } catch {
      return null;
    }
    const projectId = project?.project?.id;
    if (typeof projectId !== "string" || !projectId.trim()) return null;
    return await this.browserSession.load(projectId);
  }

  /** Save UI-only browser metadata after resolving the canonical identity. */
  async saveBrowserSession(value: unknown): Promise<void> {
    let project: ProjectData;
    try {
      project = await this.store.readProject();
    } catch (caught) {
      throw error(
        "browser_session_unavailable",
        "上次阅读位置暂时无法保存，但课程内容仍可继续使用。",
        `Cannot validate browser session project: ${caught instanceof Error ? caught.message : "unknown failure"}`,
        {
          recoverable: true,
          recommended_action: "重新打开项目后重试；课程内容不会因此改变。",
          details: {},
        },
      );
    }
    const projectId = project?.project?.id;
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw error(
        "browser_session_unavailable",
        "当前没有可识别的课程项目，阅读位置未保存。",
        "Cannot save browser session without a canonical project identity",
        {
          recoverable: true,
          recommended_action: "先打开一个有效的课程项目。",
          details: {},
        },
      );
    }
    try {
      await this.browserSession.save(value, projectId);
    } catch (caught) {
      if (caught instanceof ServiceError) throw caught;
      throw error(
        "browser_session_unavailable",
        "上次阅读位置暂时无法保存，但课程内容仍可继续使用。",
        `Cannot save browser session: ${caught instanceof Error ? caught.message : "unknown failure"}`,
        {
          recoverable: true,
          recommended_action: "检查项目目录权限后重试；课程内容不会因此改变。",
          details: {},
        },
      );
    }
  }

  async open(): Promise<ProjectData | null> {
    await this.store.open();
    try {
      this.context.project = await this.store.readProject();
      await this.search.rebuild(this.context.project);
      return this.context.project;
    } catch (caught) {
      if (caught instanceof Deno.errors.NotFound) return null;
      // A project directory may be newly created; a missing project file is not fatal.
      if (
        caught instanceof Error &&
        /No such file|not found/i.test(caught.message)
      ) return null;
      throw caught;
    }
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
