import {
  CURRENT_SCHEMA_VERSION,
  type JsonObject,
  type Project,
  type ProjectData,
  type StatusDimension,
  type StatusOption,
} from "./types.ts";
import { assert, id, now } from "./util.ts";

const CANONICAL_ARRAYS = [
  "stages",
  "content_items",
  "documents",
  "blocks",
  "groups",
  "requirements",
  "assets",
  "asset_usages",
  "status_dimensions",
  "status_options",
  "status_assignments",
  "layout_templates",
  "layout_instances",
  "layout_sections",
  "placements",
  "inbox_items",
  "export_presets",
  "course_seeds",
  "blueprint_drafts",
  "blueprint_nodes",
  "conversation_sources",
  "conversations",
  "messages",
  "context_packs",
  "context_pack_items",
  "suggestions",
  "change_drafts",
  "snapshots",
  "publications",
] as const;

const DEFAULT_STATUS_OPTIONS: Record<string, Array<[string, string, boolean]>> =
  {
    content: [
      ["research", "待研究", false],
      ["drafting", "起草中", false],
      ["review", "待审核", false],
      ["final", "已定稿", true],
    ],
    media: [
      ["not_started", "未开始", false],
      ["making", "制作中", false],
      ["review", "待审核", false],
      ["complete", "已完成", true],
    ],
    layout: [
      ["not_started", "未开始", false],
      ["layouting", "排版中", false],
      ["check", "待检查", false],
      ["complete", "已完成", true],
    ],
    review: [
      ["not_reviewed", "未审核", false],
      ["reviewing", "审核中", false],
      ["approved", "通过", true],
      ["needs_revision", "需修改", false],
    ],
    publish: [
      ["unpublished", "未发布", false],
      ["ready", "待发布", false],
      ["published", "已发布", true],
    ],
    update: [
      ["latest", "最新", true],
      ["suggested", "建议更新", false],
      ["required", "必须更新", false],
    ],
  };

const DEFAULT_STATUS_NAMES: Record<string, string> = {
  content: "正文",
  media: "媒体",
  layout: "排版",
  review: "审核",
  publish: "发布",
  update: "更新",
};

function createDefaultStatuses(
  projectId: string,
): Pick<ProjectData, "status_dimensions" | "status_options"> {
  const status_dimensions: StatusDimension[] = [];
  const status_options: StatusOption[] = [];
  Object.entries(DEFAULT_STATUS_OPTIONS).forEach(
    ([key, options], dimensionIndex) => {
      const dimensionId = id();
      status_dimensions.push({
        id: dimensionId,
        project_id: projectId,
        key,
        name: DEFAULT_STATUS_NAMES[key] ?? key,
        order_index: dimensionIndex,
        allow_custom: true,
      });
      options.forEach(([optionKey, name, is_terminal], optionIndex) => {
        status_options.push({
          id: id(),
          dimension_id: dimensionId,
          key: optionKey,
          name,
          order_index: optionIndex,
          is_terminal,
        });
      });
    },
  );
  return { status_dimensions, status_options };
}

export function createEmptyProjectData(
  title = "未命名课程",
  description = "",
  language = "zh-CN",
): ProjectData {
  const timestamp = now();
  const project: Project = {
    id: id(),
    title,
    description,
    language,
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: timestamp,
    updated_at: timestamp,
    archived: false,
    settings: {},
  };
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    project,
    stages: [],
    content_items: [],
    documents: [],
    blocks: [],
    groups: [],
    requirements: [],
    assets: [],
    asset_usages: [],
    ...createDefaultStatuses(project.id),
    status_assignments: [],
    layout_templates: [],
    layout_instances: [],
    layout_sections: [],
    placements: [],
    inbox_items: [],
    export_presets: [],
    course_seeds: [],
    blueprint_drafts: [],
    blueprint_nodes: [],
    conversation_sources: [],
    conversations: [],
    messages: [],
    context_packs: [],
    context_pack_items: [],
    suggestions: [],
    change_drafts: [],
    snapshots: [],
    publications: [],
  };
}

function fillMissingArrays(candidate: Record<string, unknown>): void {
  for (const key of CANONICAL_ARRAYS) {
    if (!(key in candidate)) {
      candidate[key] = [];
      continue;
    }
    // Never replace a malformed collection during migration: doing so would
    // silently discard canonical data before the user can recover it.
    assert(Array.isArray(candidate[key]), `项目字段 ${key} 必须是数组`);
  }
}

function fillSchemaVersions(candidate: Record<string, unknown>): void {
  const documents = candidate.documents as unknown[];
  for (const value of documents) {
    if (value && typeof value === "object") {
      (value as Record<string, unknown>).schema_version ??=
        CURRENT_SCHEMA_VERSION;
    }
  }
  for (const key of ["layout_templates", "layout_instances"] as const) {
    const values = candidate[key] as unknown[];
    for (const value of values) {
      if (value && typeof value === "object") {
        (value as Record<string, unknown>).schema_version ??=
          CURRENT_SCHEMA_VERSION;
      }
    }
  }
  for (const value of candidate.requirements as unknown[]) {
    if (!value || typeof value !== "object") continue;
    const requirement = value as Record<string, unknown>;
    requirement.scope ??= "content";
    requirement.layout_instance_id ??= null;
    requirement.resolved_asset_id ??= null;
    requirement.resolved_block_id ??= null;
    requirement.resolved_at ??= null;
  }
  for (const value of candidate.blocks as unknown[]) {
    if (!value || typeof value !== "object") continue;
    (value as Record<string, unknown>).parent_block_id ??= null;
  }
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

type AnyRecord = Record<string, unknown>;

const ENUMS = {
  content_type: [
    "course_overview",
    "stage_intro",
    "lesson",
    "exercise",
    "case",
    "pitfall",
    "assessment",
    "summary",
    "reference",
    "other",
  ],
  block_type: [
    "heading",
    "paragraph",
    "quote",
    "image",
    "gallery",
    "gif",
    "video",
    "audio",
    "table",
    "chart",
    "code",
    "callout",
    "exercise",
    "divider",
    "placeholder",
    "embed",
  ],
  requirement_type: [
    "text",
    "image",
    "gif",
    "video",
    "audio",
    "table",
    "chart",
    "quote",
    "case",
    "link",
    "data",
    "other",
  ],
  requirement_scope: ["content", "layout"],
  requirement_status: ["open", "resolved", "ignored"],
  requirement_priority: ["low", "normal", "high"],
  asset_type: ["image", "gif", "video", "audio", "document", "other"],
  asset_source_type: [
    "original",
    "generated",
    "imported",
    "external",
    "unknown",
  ],
  layout_mode: ["flow", "grid"],
  fit_mode: ["contain", "cover", "stretch", "natural"],
  seed_source_type: [
    "overview",
    "outline",
    "toc",
    "articles",
    "folder",
    "spreadsheet",
    "conversations",
    "wizard",
    "blank",
  ],
  blueprint_status: ["draft", "confirmed", "discarded"],
  blueprint_node_type: ["stage", "content"],
  connection_status: ["disconnected", "connected", "error", "requires_auth"],
  message_role: ["user", "assistant", "system", "tool"],
  context_source_type: [
    "document",
    "stage",
    "course_map",
    "requirement",
    "conversation",
    "message",
    "asset",
    "custom",
  ],
  suggestion_type: [
    "add_content",
    "remove_content",
    "rewrite",
    "update_fact",
    "add_media",
    "restructure",
    "new_lesson",
    "move_lesson",
    "other",
  ],
  suggestion_status: ["pending", "accepted", "ignored"],
  change_draft_status: ["draft", "reviewing", "applied", "discarded"],
  publication_status: ["unpublished", "ready", "published", "failed"],
  output_type: [
    "markdown",
    "html",
    "image",
    "pdf",
    "json",
    "asset_package",
    "full_project",
    "custom",
  ],
  page_mode: ["single", "multi_page", "long_image", "web"],
} as const;

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ids<T extends AnyRecord>(
  values: unknown,
  path: string,
  issues: ValidationIssue[],
): Map<string, T> {
  const map = new Map<string, T>();
  if (!Array.isArray(values)) return map;
  for (const [index, value] of values.entries()) {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
      issues.push({
        path: `${path}[${index}].id`,
        code: "invalid_id",
        message: "对象必须有非空 id",
      });
      continue;
    }
    if (map.has(value.id)) {
      issues.push({
        path: `${path}[${index}].id`,
        code: "duplicate_id",
        message: `重复 id: ${value.id}`,
      });
      continue;
    }
    map.set(value.id, value as T);
  }
  return map;
}

function requireEnum(
  value: unknown,
  values: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "string" || !values.includes(value)) {
    issues.push({
      path,
      code: "invalid_enum",
      message: `不支持的枚举值: ${String(value)}`,
    });
  }
}

function requireRef(
  map: Map<string, AnyRecord>,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  message = "引用对象不存在",
): void {
  if (typeof value !== "string" || !map.has(value)) {
    issues.push({ path, code: "invalid_reference", message });
  }
}

function requireNullableRef(
  map: Map<string, AnyRecord>,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  message = "引用对象不存在",
): void {
  if (value !== null && value !== undefined) {
    requireRef(map, value, path, issues, message);
  }
}

function requireSameProject(
  value: AnyRecord,
  projectId: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value.project_id !== projectId) {
    issues.push({
      path: `${path}.project_id`,
      code: "cross_project_reference",
      message: "对象不属于当前项目",
    });
  }
}

function detectParentCycles(
  map: Map<string, AnyRecord>,
  parentField: string,
  pathPrefix: string,
  issues: ValidationIssue[],
): void {
  for (const key of map.keys()) {
    const visited = new Set<string>();
    let cursor: string | null = key;
    while (cursor) {
      if (visited.has(cursor)) {
        issues.push({
          path: `${pathPrefix}.${key}.${parentField}`,
          code: "cycle",
          message: "父级引用形成循环",
        });
        break;
      }
      visited.add(cursor);
      const value = map.get(cursor);
      cursor = value && typeof value[parentField] === "string"
        ? value[parentField] as string
        : null;
    }
  }
}

/**
 * Validate the project graph without mutating it.  The result is intentionally
 * a list so callers can show all repairable problems in one pass; persistence
 * boundaries call `assertValidProjectData` to fail closed.
 */
export function validateProjectData(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return [{
      path: "project",
      code: "invalid_root",
      message: "项目必须是对象",
    }];
  }
  const project = isRecord(input.project) ? input.project : null;
  if (!project || typeof project.id !== "string" || !project.id) {
    issues.push({
      path: "project",
      code: "missing_project",
      message: "项目缺少有效 id",
    });
    return issues;
  }
  const projectId = project.id;
  if (input.schema_version !== CURRENT_SCHEMA_VERSION) {
    issues.push({
      path: "schema_version",
      code: "unsupported_schema",
      message: `需要 ${CURRENT_SCHEMA_VERSION}`,
    });
  }
  if (project.schema_version !== CURRENT_SCHEMA_VERSION) {
    issues.push({
      path: "project.schema_version",
      code: "unsupported_schema",
      message: `需要 ${CURRENT_SCHEMA_VERSION}`,
    });
  }
  const collection = (key: string): unknown[] => {
    const value = input[key];
    if (!Array.isArray(value)) {
      issues.push({
        path: key,
        code: "invalid_collection",
        message: "必须是数组",
      });
      return [];
    }
    return value;
  };
  const stages = ids<AnyRecord>(collection("stages"), "stages", issues);
  const contentItems = ids<AnyRecord>(
    collection("content_items"),
    "content_items",
    issues,
  );
  const documents = ids<AnyRecord>(
    collection("documents"),
    "documents",
    issues,
  );
  const blocks = ids<AnyRecord>(collection("blocks"), "blocks", issues);
  const groups = ids<AnyRecord>(collection("groups"), "groups", issues);
  const requirements = ids<AnyRecord>(
    collection("requirements"),
    "requirements",
    issues,
  );
  const assets = ids<AnyRecord>(collection("assets"), "assets", issues);
  const usages = ids<AnyRecord>(
    collection("asset_usages"),
    "asset_usages",
    issues,
  );
  const dimensions = ids<AnyRecord>(
    collection("status_dimensions"),
    "status_dimensions",
    issues,
  );
  const options = ids<AnyRecord>(
    collection("status_options"),
    "status_options",
    issues,
  );
  const assignments = ids<AnyRecord>(
    collection("status_assignments"),
    "status_assignments",
    issues,
  );
  const templates = ids<AnyRecord>(
    collection("layout_templates"),
    "layout_templates",
    issues,
  );
  const layouts = ids<AnyRecord>(
    collection("layout_instances"),
    "layout_instances",
    issues,
  );
  const sections = ids<AnyRecord>(
    collection("layout_sections"),
    "layout_sections",
    issues,
  );
  const placements = ids<AnyRecord>(
    collection("placements"),
    "placements",
    issues,
  );
  const inbox = ids<AnyRecord>(
    collection("inbox_items"),
    "inbox_items",
    issues,
  );
  const presets = ids<AnyRecord>(
    collection("export_presets"),
    "export_presets",
    issues,
  );
  const seeds = ids<AnyRecord>(
    collection("course_seeds"),
    "course_seeds",
    issues,
  );
  const drafts = ids<AnyRecord>(
    collection("blueprint_drafts"),
    "blueprint_drafts",
    issues,
  );
  const nodes = ids<AnyRecord>(
    collection("blueprint_nodes"),
    "blueprint_nodes",
    issues,
  );
  const sources = ids<AnyRecord>(
    collection("conversation_sources"),
    "conversation_sources",
    issues,
  );
  const conversations = ids<AnyRecord>(
    collection("conversations"),
    "conversations",
    issues,
  );
  const messages = ids<AnyRecord>(collection("messages"), "messages", issues);
  const packs = ids<AnyRecord>(
    collection("context_packs"),
    "context_packs",
    issues,
  );
  const packItems = ids<AnyRecord>(
    collection("context_pack_items"),
    "context_pack_items",
    issues,
  );
  const suggestions = ids<AnyRecord>(
    collection("suggestions"),
    "suggestions",
    issues,
  );
  const changeDrafts = ids<AnyRecord>(
    collection("change_drafts"),
    "change_drafts",
    issues,
  );
  const snapshots = ids<AnyRecord>(
    collection("snapshots"),
    "snapshots",
    issues,
  );
  const publications = ids<AnyRecord>(
    collection("publications"),
    "publications",
    issues,
  );

  const seen = new Map<string, string>();
  seen.set(projectId, "project");
  for (
    const [collectionName, map] of [
      ["stages", stages],
      ["content_items", contentItems],
      ["documents", documents],
      ["blocks", blocks],
      ["groups", groups],
      ["requirements", requirements],
      ["assets", assets],
      ["asset_usages", usages],
      ["status_dimensions", dimensions],
      ["status_options", options],
      ["status_assignments", assignments],
      ["layout_templates", templates],
      ["layout_instances", layouts],
      ["layout_sections", sections],
      ["placements", placements],
      ["inbox_items", inbox],
      ["export_presets", presets],
      ["course_seeds", seeds],
      ["blueprint_drafts", drafts],
      ["blueprint_nodes", nodes],
      ["conversation_sources", sources],
      ["conversations", conversations],
      ["messages", messages],
      ["context_packs", packs],
      ["context_pack_items", packItems],
      ["suggestions", suggestions],
      ["change_drafts", changeDrafts],
      ["snapshots", snapshots],
      ["publications", publications],
    ] as Array<[string, Map<string, AnyRecord>]>
  ) {
    for (const key of map.keys()) {
      const previous = seen.get(key);
      if (previous) {
        issues.push({
          path: `${collectionName}.${key}`,
          code: "duplicate_global_id",
          message: `id 已在 ${previous} 中使用`,
        });
      } else seen.set(key, collectionName);
    }
  }
  for (const [key, value] of stages) {
    const path = `stages.${key}`;
    requireSameProject(value, projectId, path, issues);
    requireNullableRef(
      stages,
      value.parent_stage_id,
      `${path}.parent_stage_id`,
      issues,
      "父阶段不存在",
    );
    if (value.parent_stage_id === key) {
      issues.push({
        path: `${path}.parent_stage_id`,
        code: "cycle",
        message: "阶段不能以自身为父级",
      });
    }
  }
  detectParentCycles(stages, "parent_stage_id", "stages", issues);
  const stageCodes = new Set<string>();
  for (const [key, value] of stages) {
    if (typeof value.code !== "string") continue;
    if (stageCodes.has(value.code)) {
      issues.push({
        path: `stages.${key}.code`,
        code: "duplicate_unique",
        message: "阶段编号不能重复",
      });
    }
    stageCodes.add(value.code);
  }
  for (const [key, value] of contentItems) {
    const path = `content_items.${key}`;
    requireSameProject(value, projectId, path, issues);
    requireNullableRef(
      stages,
      value.stage_id,
      `${path}.stage_id`,
      issues,
      "内容所属阶段不存在",
    );
    requireRef(
      documents,
      value.document_id,
      `${path}.document_id`,
      issues,
      "正文文档不存在",
    );
    requireEnum(value.type, ENUMS.content_type, `${path}.type`, issues);
  }
  const contentCodes = new Set<string>();
  for (const [key, value] of contentItems) {
    if (typeof value.code !== "string") continue;
    if (contentCodes.has(value.code)) {
      issues.push({
        path: `content_items.${key}.code`,
        code: "duplicate_unique",
        message: "内容编号不能重复",
      });
    }
    contentCodes.add(value.code);
  }
  for (const [key, value] of documents) {
    const path = `documents.${key}`;
    if (value.schema_version !== CURRENT_SCHEMA_VERSION) {
      issues.push({
        path: `${path}.schema_version`,
        code: "unsupported_schema",
        message: `需要 ${CURRENT_SCHEMA_VERSION}`,
      });
    }
    requireRef(
      contentItems,
      value.content_item_id,
      `${path}.content_item_id`,
      issues,
      "正文所属内容不存在",
    );
  }
  const documentContentKeys = new Set<string>();
  for (const [key, value] of documents) {
    if (typeof value.content_item_id !== "string") continue;
    if (documentContentKeys.has(value.content_item_id)) {
      issues.push({
        path: `documents.${key}.content_item_id`,
        code: "duplicate_unique",
        message: "一个内容只能有一个正文文档",
      });
    }
    documentContentKeys.add(value.content_item_id);
  }
  for (const [key, value] of blocks) {
    const path = `blocks.${key}`;
    requireRef(
      documents,
      value.document_id,
      `${path}.document_id`,
      issues,
      "正文区块所属文档不存在",
    );
    requireNullableRef(
      blocks,
      value.parent_block_id,
      `${path}.parent_block_id`,
      issues,
      "父正文区块不存在",
    );
    if (value.parent_block_id === key) {
      issues.push({
        path: `${path}.parent_block_id`,
        code: "cycle",
        message: "正文区块不能以自身为父级",
      });
    }
    requireEnum(value.type, ENUMS.block_type, `${path}.type`, issues);
    const parent = typeof value.parent_block_id === "string"
      ? blocks.get(value.parent_block_id)
      : null;
    if (parent && parent.document_id !== value.document_id) {
      issues.push({
        path: `${path}.parent_block_id`,
        code: "cross_document_reference",
        message: "父正文区块必须属于同一文档",
      });
    }
  }
  detectParentCycles(blocks, "parent_block_id", "blocks", issues);
  const blockGroup = new Map<string, string>();
  for (const [key, value] of groups) {
    const path = `groups.${key}`;
    requireRef(
      documents,
      value.document_id,
      `${path}.document_id`,
      issues,
      "分组所属文档不存在",
    );
    requireNullableRef(
      groups,
      value.parent_group_id,
      `${path}.parent_group_id`,
      issues,
      "父分组不存在",
    );
    if (value.parent_group_id === key) {
      issues.push({
        path: `${path}.parent_group_id`,
        code: "cycle",
        message: "分组不能以自身为父级",
      });
    }
    const parentGroup = typeof value.parent_group_id === "string"
      ? groups.get(value.parent_group_id)
      : null;
    if (parentGroup && parentGroup.document_id !== value.document_id) {
      issues.push({
        path: `${path}.parent_group_id`,
        code: "cross_document_reference",
        message: "父分组必须属于同一文档",
      });
    }
    if (!Array.isArray(value.block_ids)) {
      issues.push({
        path: `${path}.block_ids`,
        code: "invalid_collection",
        message: "分组必须包含区块数组",
      });
    } else {
      for (const [index, blockId] of value.block_ids.entries()) {
        requireRef(
          blocks,
          blockId,
          `${path}.block_ids[${index}]`,
          issues,
          "分组区块不存在",
        );
        if (typeof blockId === "string") {
          const previous = blockGroup.get(blockId);
          if (previous && previous !== key) {
            issues.push({
              path: `${path}.block_ids[${index}]`,
              code: "duplicate_membership",
              message: "区块不能同时属于多个分组",
            });
          } else blockGroup.set(blockId, key);
          const block = blocks.get(blockId);
          if (block && block.document_id !== value.document_id) {
            issues.push({
              path: `${path}.block_ids[${index}]`,
              code: "cross_document_reference",
              message: "分组区块必须属于同一文档",
            });
          }
        }
      }
    }
  }
  detectParentCycles(groups, "parent_group_id", "groups", issues);
  for (const [key, value] of requirements) {
    const path = `requirements.${key}`;
    requireRef(
      contentItems,
      value.content_item_id,
      `${path}.content_item_id`,
      issues,
      "待补所属内容不存在",
    );
    requireNullableRef(
      blocks,
      value.anchor_block_id,
      `${path}.anchor_block_id`,
      issues,
      "待补锚点区块不存在",
    );
    requireEnum(value.type, ENUMS.requirement_type, `${path}.type`, issues);
    requireEnum(value.scope, ENUMS.requirement_scope, `${path}.scope`, issues);
    requireEnum(
      value.status,
      ENUMS.requirement_status,
      `${path}.status`,
      issues,
    );
    requireEnum(
      value.priority,
      ENUMS.requirement_priority,
      `${path}.priority`,
      issues,
    );
    requireNullableRef(
      assets,
      value.resolved_asset_id,
      `${path}.resolved_asset_id`,
      issues,
      "待补素材不存在",
    );
    requireNullableRef(
      blocks,
      value.resolved_block_id,
      `${path}.resolved_block_id`,
      issues,
      "待补完成区块不存在",
    );
    if (value.scope === "layout") {
      requireRef(
        layouts,
        value.layout_instance_id,
        `${path}.layout_instance_id`,
        issues,
        "排版待补缺少排版版本",
      );
    }
    if (value.scope === "content" && value.layout_instance_id !== null) {
      issues.push({
        path: `${path}.layout_instance_id`,
        code: "invalid_reference",
        message: "内容待补不能关联排版版本",
      });
    }
    const item = typeof value.content_item_id === "string"
      ? contentItems.get(value.content_item_id)
      : null;
    const anchor = typeof value.anchor_block_id === "string"
      ? blocks.get(value.anchor_block_id)
      : null;
    if (item && anchor) {
      const document = typeof anchor.document_id === "string"
        ? documents.get(anchor.document_id)
        : undefined;
      if (document?.content_item_id !== item.id) {
        issues.push({
          path: `${path}.anchor_block_id`,
          code: "cross_content_reference",
          message: "待补锚点必须属于同一内容",
        });
      }
    }
    const layout = typeof value.layout_instance_id === "string"
      ? layouts.get(value.layout_instance_id)
      : null;
    if (item && layout && layout.content_item_id !== item.id) {
      issues.push({
        path: `${path}.layout_instance_id`,
        code: "cross_content_reference",
        message: "排版待补必须属于同一内容",
      });
    }
    if (item && typeof value.resolved_asset_id === "string") {
      const asset = assets.get(value.resolved_asset_id);
      if (asset && asset.project_id !== item.project_id) {
        issues.push({
          path: `${path}.resolved_asset_id`,
          code: "cross_project_reference",
          message: "完成待补素材不属于同一项目",
        });
      }
    }
  }
  for (const [key, value] of assets) {
    requireSameProject(value, projectId, `assets.${key}`, issues);
    requireEnum(value.type, ENUMS.asset_type, `assets.${key}.type`, issues);
    requireEnum(
      value.source_type,
      ENUMS.asset_source_type,
      `assets.${key}.source_type`,
      issues,
    );
    if (typeof value.file_size !== "number" || value.file_size < 0) {
      issues.push({
        path: `assets.${key}.file_size`,
        code: "invalid_value",
        message: "素材大小不能为负数",
      });
    }
    if (
      typeof value.storage_path !== "string" || !value.storage_path ||
      value.storage_path.startsWith("/") ||
      value.storage_path.split(/[\\/]/).includes("..")
    ) {
      issues.push({
        path: `assets.${key}.storage_path`,
        code: "invalid_path",
        message: "素材路径必须是项目内相对路径",
      });
    }
  }
  const usageTuples = new Set<string>();
  for (const [key, value] of usages) {
    const path = `asset_usages.${key}`;
    requireRef(
      assets,
      value.asset_id,
      `${path}.asset_id`,
      issues,
      "素材引用目标不存在",
    );
    requireRef(
      contentItems,
      value.content_item_id,
      `${path}.content_item_id`,
      issues,
      "素材引用内容不存在",
    );
    requireNullableRef(
      blocks,
      value.block_id,
      `${path}.block_id`,
      issues,
      "素材引用区块不存在",
    );
    requireNullableRef(
      layouts,
      value.layout_instance_id,
      `${path}.layout_instance_id`,
      issues,
      "素材引用排版不存在",
    );
    const asset = typeof value.asset_id === "string"
      ? assets.get(value.asset_id)
      : null;
    const item = typeof value.content_item_id === "string"
      ? contentItems.get(value.content_item_id)
      : null;
    if (asset && item && asset.project_id !== item.project_id) {
      issues.push({
        path: `${path}.asset_id`,
        code: "cross_project_reference",
        message: "素材引用跨项目",
      });
    }
    if (asset?.archived === true) {
      issues.push({
        path: `${path}.asset_id`,
        code: "archived_reference",
        message: "已归档素材不能继续被引用",
      });
    }
    const tuple = `${value.asset_id}|${value.content_item_id}|${
      value.block_id ?? ""
    }|${value.layout_instance_id ?? ""}|${value.role ?? ""}`;
    if (usageTuples.has(tuple)) {
      issues.push({ path, code: "duplicate_usage", message: "重复素材引用" });
    }
    usageTuples.add(tuple);
    if (typeof value.block_id === "string" && item) {
      const block = blocks.get(value.block_id);
      const document = block && documents.get(String(block.document_id));
      if (document?.content_item_id !== item.id) {
        issues.push({
          path: `${path}.block_id`,
          code: "cross_content_reference",
          message: "素材引用区块不属于内容",
        });
      }
    }
    if (typeof value.layout_instance_id === "string" && item) {
      const layout = layouts.get(value.layout_instance_id);
      if (layout?.content_item_id !== item.id) {
        issues.push({
          path: `${path}.layout_instance_id`,
          code: "cross_content_reference",
          message: "素材引用排版不属于内容",
        });
      }
    }
  }
  for (const [key, value] of requirements) {
    const path = `requirements.${key}`;
    if (
      value.status !== "resolved" &&
      (value.resolved_asset_id !== null || value.resolved_block_id !== null)
    ) {
      issues.push({
        path: `${path}.resolved_asset_id`,
        code: "inconsistent_resolution",
        message: "未完成待补不能保留完成引用",
      });
    }
    if (
      value.status === "resolved" && typeof value.resolved_asset_id === "string"
    ) {
      const hasUsage = [...usages.values()].some((usage) =>
        usage.asset_id === value.resolved_asset_id &&
        usage.content_item_id === value.content_item_id &&
        usage.block_id === (value.anchor_block_id ?? null) &&
        usage.layout_instance_id === (value.layout_instance_id ?? null) &&
        usage.role === "requirement"
      );
      if (!hasUsage) {
        issues.push({
          path: `${path}.resolved_asset_id`,
          code: "inconsistent_usage",
          message: "已完成待补缺少素材引用记录",
        });
      }
    }
  }
  for (const [key, value] of dimensions) {
    requireSameProject(value, projectId, `status_dimensions.${key}`, issues);
  }
  const dimensionKeys = new Set<string>();
  for (const [key, value] of dimensions) {
    if (typeof value.key !== "string") continue;
    if (dimensionKeys.has(value.key)) {
      issues.push({
        path: `status_dimensions.${key}.key`,
        code: "duplicate_unique",
        message: "状态维度 key 不能重复",
      });
    }
    dimensionKeys.add(value.key);
  }
  const assignmentKeys = new Set<string>();
  for (const [key, value] of assignments) {
    const path = `status_assignments.${key}`;
    requireRef(
      contentItems,
      value.content_item_id,
      `${path}.content_item_id`,
      issues,
      "状态内容不存在",
    );
    requireRef(
      dimensions,
      value.dimension_id,
      `${path}.dimension_id`,
      issues,
      "状态维度不存在",
    );
    requireRef(
      options,
      value.option_id,
      `${path}.option_id`,
      issues,
      "状态选项不存在",
    );
    const dimension = typeof value.dimension_id === "string"
      ? dimensions.get(value.dimension_id)
      : null;
    const option = typeof value.option_id === "string"
      ? options.get(value.option_id)
      : null;
    if (dimension && option && option.dimension_id !== dimension.id) {
      issues.push({
        path: `${path}.option_id`,
        code: "cross_dimension_reference",
        message: "状态选项不属于该维度",
      });
    }
    const unique = `${value.content_item_id}|${value.dimension_id}`;
    if (assignmentKeys.has(unique)) {
      issues.push({
        path,
        code: "duplicate_unique",
        message: "同一内容和状态维度只能有一个状态",
      });
    }
    assignmentKeys.add(unique);
  }
  for (const [key, value] of options) {
    requireRef(
      dimensions,
      value.dimension_id,
      `status_options.${key}.dimension_id`,
      issues,
      "状态选项维度不存在",
    );
  }
  const optionKeys = new Set<string>();
  for (const [key, value] of options) {
    if (
      typeof value.dimension_id !== "string" || typeof value.key !== "string"
    ) continue;
    const unique = `${value.dimension_id}|${value.key}`;
    if (optionKeys.has(unique)) {
      issues.push({
        path: `status_options.${key}.key`,
        code: "duplicate_unique",
        message: "同一状态维度不能有重复选项",
      });
    }
    optionKeys.add(unique);
  }
  for (const [key, value] of templates) {
    if (value.schema_version !== CURRENT_SCHEMA_VERSION) {
      issues.push({
        path: `layout_templates.${key}.schema_version`,
        code: "unsupported_schema",
        message: `需要 ${CURRENT_SCHEMA_VERSION}`,
      });
    }
    if (
      value.project_id !== null && value.project_id !== undefined &&
      value.project_id !== projectId
    ) {
      issues.push({
        path: `layout_templates.${key}.project_id`,
        code: "cross_project_reference",
        message: "排版模板不属于当前项目",
      });
    }
    requireEnum(
      value.mode,
      ENUMS.layout_mode,
      `layout_templates.${key}.mode`,
      issues,
    );
  }
  for (const [key, value] of layouts) {
    const path = `layout_instances.${key}`;
    if (value.schema_version !== CURRENT_SCHEMA_VERSION) {
      issues.push({
        path: `${path}.schema_version`,
        code: "unsupported_schema",
        message: `需要 ${CURRENT_SCHEMA_VERSION}`,
      });
    }
    requireRef(
      contentItems,
      value.content_item_id,
      `${path}.content_item_id`,
      issues,
      "排版内容不存在",
    );
    requireNullableRef(
      templates,
      value.template_id,
      `${path}.template_id`,
      issues,
      "排版模板不存在",
    );
    requireEnum(value.mode, ENUMS.layout_mode, `${path}.mode`, issues);
    const template = typeof value.template_id === "string"
      ? templates.get(value.template_id)
      : null;
    if (
      template && template.project_id !== null &&
      template.project_id !== projectId
    ) {
      issues.push({
        path: `${path}.template_id`,
        code: "cross_project_reference",
        message: "排版模板跨项目",
      });
    }
    if (template && template.mode !== value.mode) {
      issues.push({
        path: `${path}.mode`,
        code: "invalid_value",
        message: "排版实例与模板模式不一致",
      });
    }
  }
  for (const [key, value] of sections) {
    requireRef(
      layouts,
      value.layout_instance_id,
      `layout_sections.${key}.layout_instance_id`,
      issues,
      "排版区域所属版本不存在",
    );
  }
  for (const [key, value] of placements) {
    const path = `placements.${key}`;
    requireRef(
      layouts,
      value.layout_instance_id,
      `${path}.layout_instance_id`,
      issues,
      "放置所属排版不存在",
    );
    requireRef(
      blocks,
      value.block_id,
      `${path}.block_id`,
      issues,
      "放置正文区块不存在",
    );
    requireNullableRef(
      sections,
      value.section_id,
      `${path}.section_id`,
      issues,
      "放置区域不存在",
    );
    requireEnum(
      value.fit_mode,
      ["contain", "cover", "stretch", "natural"],
      `${path}.fit_mode`,
      issues,
    );
    for (
      const field of ["row_start", "row_end", "column_start", "column_end"]
    ) {
      if (typeof value[field] !== "number" || !Number.isInteger(value[field])) {
        issues.push({
          path: `${path}.${field}`,
          code: "invalid_value",
          message: "网格轨道必须为整数",
        });
      }
    }
    if (
      typeof value.row_start === "number" &&
      typeof value.row_end === "number" && value.row_end <= value.row_start
    ) {
      issues.push({
        path: `${path}.row_end`,
        code: "invalid_value",
        message: "行范围无效",
      });
    }
    if (
      typeof value.column_start === "number" &&
      typeof value.column_end === "number" &&
      value.column_end <= value.column_start
    ) {
      issues.push({
        path: `${path}.column_end`,
        code: "invalid_value",
        message: "列范围无效",
      });
    }
    const layout = typeof value.layout_instance_id === "string"
      ? layouts.get(value.layout_instance_id)
      : null;
    const block = typeof value.block_id === "string"
      ? blocks.get(value.block_id)
      : null;
    const document = block && documents.get(String(block.document_id));
    if (
      layout && document && document.content_item_id !== layout.content_item_id
    ) {
      issues.push({
        path: `${path}.block_id`,
        code: "cross_content_reference",
        message: "排版放置区块不属于该内容",
      });
    }
    const section = typeof value.section_id === "string"
      ? sections.get(value.section_id)
      : null;
    if (section && section.layout_instance_id !== value.layout_instance_id) {
      issues.push({
        path: `${path}.section_id`,
        code: "cross_layout_reference",
        message: "排版区域不属于该排版",
      });
    }
  }
  for (const [key, value] of inbox) {
    if (
      value.project_id !== null && value.project_id !== undefined &&
      value.project_id !== projectId
    ) {
      issues.push({
        path: `inbox_items.${key}.project_id`,
        code: "cross_project_reference",
        message: "收件箱条目不属于当前项目",
      });
    }
    requireNullableRef(
      assets,
      value.asset_id,
      `inbox_items.${key}.asset_id`,
      issues,
      "收件箱素材不存在",
    );
    requireNullableRef(
      contentItems,
      value.content_item_id,
      `inbox_items.${key}.content_item_id`,
      issues,
      "收件箱目标内容不存在",
    );
  }
  for (const [key, value] of presets) {
    const path = `export_presets.${key}`;
    if (
      value.project_id !== null && value.project_id !== undefined &&
      value.project_id !== projectId
    ) {
      issues.push({
        path: `${path}.project_id`,
        code: "cross_project_reference",
        message: "导出预设不属于当前项目",
      });
    }
    requireNullableRef(
      layouts,
      value.layout_instance_id,
      `${path}.layout_instance_id`,
      issues,
      "导出预设排版不存在",
    );
    requireEnum(
      value.output_type,
      ENUMS.output_type,
      `${path}.output_type`,
      issues,
    );
    requireEnum(value.page_mode, ENUMS.page_mode, `${path}.page_mode`, issues);
    const layout = typeof value.layout_instance_id === "string"
      ? layouts.get(value.layout_instance_id)
      : null;
    const item = layout && contentItems.get(String(layout.content_item_id));
    if (layout && item && item.project_id !== projectId) {
      issues.push({
        path: `${path}.layout_instance_id`,
        code: "cross_project_reference",
        message: "导出预设排版跨项目",
      });
    }
  }
  for (const [key, value] of seeds) {
    if (
      value.project_id !== null && value.project_id !== undefined &&
      value.project_id !== projectId
    ) {
      issues.push({
        path: `course_seeds.${key}.project_id`,
        code: "cross_project_reference",
        message: "课程输入不属于当前项目",
      });
    }
    requireEnum(
      value.source_type,
      ENUMS.seed_source_type,
      `course_seeds.${key}.source_type`,
      issues,
    );
  }
  for (const [key, value] of drafts) {
    requireRef(
      seeds,
      value.course_seed_id,
      `blueprint_drafts.${key}.course_seed_id`,
      issues,
      "课程草稿输入不存在",
    );
    requireEnum(
      value.status,
      ENUMS.blueprint_status,
      `blueprint_drafts.${key}.status`,
      issues,
    );
  }
  for (const [key, value] of nodes) {
    const path = `blueprint_nodes.${key}`;
    requireRef(
      drafts,
      value.blueprint_id,
      `${path}.blueprint_id`,
      issues,
      "课程节点草稿不存在",
    );
    requireNullableRef(
      nodes,
      value.parent_id,
      `${path}.parent_id`,
      issues,
      "课程节点父级不存在",
    );
    requireEnum(
      value.node_type,
      ENUMS.blueprint_node_type,
      `${path}.node_type`,
      issues,
    );
    requireEnum(
      value.suggested_type,
      ENUMS.content_type,
      `${path}.suggested_type`,
      issues,
    );
    const parent = typeof value.parent_id === "string"
      ? nodes.get(value.parent_id)
      : null;
    if (parent && parent.blueprint_id !== value.blueprint_id) {
      issues.push({
        path: `${path}.parent_id`,
        code: "cross_blueprint_reference",
        message: "课程节点父级跨草稿",
      });
    }
  }
  for (const [key, value] of sources) {
    requireEnum(
      value.connection_status,
      ENUMS.connection_status,
      `conversation_sources.${key}.connection_status`,
      issues,
    );
  }
  for (const [key, value] of conversations) {
    requireRef(
      sources,
      value.source_id,
      `conversations.${key}.source_id`,
      issues,
      "对话来源不存在",
    );
  }
  for (const [key, value] of messages) {
    const path = `messages.${key}`;
    requireRef(
      conversations,
      value.conversation_id,
      `${path}.conversation_id`,
      issues,
      "消息所属对话不存在",
    );
    requireEnum(value.role, ENUMS.message_role, `${path}.role`, issues);
  }
  for (const [key, value] of packs) {
    const path = `context_packs.${key}`;
    if (value.project_id !== projectId) {
      issues.push({
        path: `${path}.project_id`,
        code: "cross_project_reference",
        message: "上下文包跨项目",
      });
    }
    requireNullableRef(
      contentItems,
      value.target_content_item_id,
      `${path}.target_content_item_id`,
      issues,
      "上下文目标内容不存在",
    );
  }
  for (const [key, value] of packItems) {
    requireRef(
      packs,
      value.context_pack_id,
      `context_pack_items.${key}.context_pack_id`,
      issues,
      "上下文包条目所属包不存在",
    );
    requireEnum(
      value.source_type,
      ENUMS.context_source_type,
      `context_pack_items.${key}.source_type`,
      issues,
    );
    if (
      typeof value.context_pack_id === "string" &&
      typeof value.source_id === "string"
    ) {
      const pack = packs.get(value.context_pack_id);
      if (pack && value.source_type === "asset") {
        requireRef(
          assets,
          value.source_id,
          `context_pack_items.${key}.source_id`,
          issues,
          "上下文素材不存在",
        );
      }
      if (pack && value.source_type === "document") {
        requireRef(
          documents,
          value.source_id,
          `context_pack_items.${key}.source_id`,
          issues,
          "上下文文档不存在",
        );
      }
      if (pack && value.source_type === "stage") {
        requireRef(
          stages,
          value.source_id,
          `context_pack_items.${key}.source_id`,
          issues,
          "上下文阶段不存在",
        );
      }
      if (pack && value.source_type === "requirement") {
        requireRef(
          requirements,
          value.source_id,
          `context_pack_items.${key}.source_id`,
          issues,
          "上下文待补不存在",
        );
      }
      if (pack && value.source_type === "conversation") {
        requireRef(
          conversations,
          value.source_id,
          `context_pack_items.${key}.source_id`,
          issues,
          "上下文对话不存在",
        );
      }
      if (pack && value.source_type === "message") {
        requireRef(
          messages,
          value.source_id,
          `context_pack_items.${key}.source_id`,
          issues,
          "上下文消息不存在",
        );
      }
    }
  }
  for (const [key, value] of suggestions) {
    const path = `suggestions.${key}`;
    requireRef(
      contentItems,
      value.target_content_item_id,
      `${path}.target_content_item_id`,
      issues,
      "建议目标内容不存在",
    );
    requireRef(
      packs,
      value.context_pack_id,
      `${path}.context_pack_id`,
      issues,
      "建议上下文包不存在",
    );
    requireEnum(value.type, ENUMS.suggestion_type, `${path}.type`, issues);
    requireEnum(
      value.status,
      ENUMS.suggestion_status,
      `${path}.status`,
      issues,
    );
    const pack = typeof value.context_pack_id === "string"
      ? packs.get(value.context_pack_id)
      : null;
    if (pack && pack.project_id !== projectId) {
      issues.push({
        path: `${path}.context_pack_id`,
        code: "cross_project_reference",
        message: "建议上下文包跨项目",
      });
    }
  }
  for (const [key, value] of changeDrafts) {
    const path = `change_drafts.${key}`;
    requireRef(
      suggestions,
      value.suggestion_id,
      `${path}.suggestion_id`,
      issues,
      "修改草稿建议不存在",
    );
    requireRef(
      contentItems,
      value.target_content_item_id,
      `${path}.target_content_item_id`,
      issues,
      "修改草稿目标内容不存在",
    );
    requireEnum(
      value.status,
      ENUMS.change_draft_status,
      `${path}.status`,
      issues,
    );
    if (Array.isArray(value.proposed_changes)) {
      for (const [index, patch] of value.proposed_changes.entries()) {
        if (!isRecord(patch)) {
          continue;
        }
        requireRef(
          blocks,
          patch.block_id,
          `${path}.proposed_changes[${index}].block_id`,
          issues,
          "修改草稿正文区块不存在",
        );
        const block = typeof patch.block_id === "string"
          ? blocks.get(patch.block_id)
          : null;
        const item = typeof value.target_content_item_id === "string"
          ? contentItems.get(value.target_content_item_id)
          : null;
        const document = block && documents.get(String(block.document_id));
        if (block && item && document?.content_item_id !== item.id) {
          issues.push({
            path: `${path}.proposed_changes[${index}].block_id`,
            code: "cross_content_reference",
            message: "修改草稿区块不属于目标内容",
          });
        }
      }
    }
  }
  for (const [key, value] of snapshots) {
    if (value.project_id !== projectId) {
      issues.push({
        path: `snapshots.${key}.project_id`,
        code: "cross_project_reference",
        message: "历史版本跨项目",
      });
    }
  }
  for (const [key, value] of publications) {
    const path = `publications.${key}`;
    requireRef(
      contentItems,
      value.content_item_id,
      `${path}.content_item_id`,
      issues,
      "发布内容不存在",
    );
    requireNullableRef(
      layouts,
      value.layout_instance_id,
      `${path}.layout_instance_id`,
      issues,
      "发布排版不存在",
    );
    requireEnum(
      value.status,
      ENUMS.publication_status,
      `${path}.status`,
      issues,
    );
    const layout = typeof value.layout_instance_id === "string"
      ? layouts.get(value.layout_instance_id)
      : null;
    if (layout && layout.content_item_id !== value.content_item_id) {
      issues.push({
        path: `${path}.layout_instance_id`,
        code: "cross_content_reference",
        message: "发布排版不属于内容",
      });
    }
  }
  return issues;
}

export function assertValidProjectData(
  input: unknown,
): asserts input is ProjectData {
  const issues = validateProjectData(input);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new Error(`项目校验失败: ${first.path} ${first.message}`);
  }
}

export const validateCanonicalProject = validateProjectData;
export const assertValidCanonicalProject = assertValidProjectData;

/** Upgrade the open JSON format without requiring users to recreate a project. */
export function migrateProject(input: unknown): ProjectData {
  assert(input && typeof input === "object", "项目文件必须是 JSON 对象");
  const candidate = structuredClone(input) as Record<string, unknown>;
  assert(
    candidate.project && typeof candidate.project === "object",
    "项目文件缺少 project",
  );
  fillMissingArrays(candidate);
  fillSchemaVersions(candidate);
  candidate.schema_version = CURRENT_SCHEMA_VERSION;
  const project = candidate.project as Record<string, unknown>;
  project.id ??= id();
  project.title ??= "未命名课程";
  project.description ??= "";
  project.language ??= "zh-CN";
  project.created_at ??= now();
  project.updated_at ??= now();
  project.schema_version = CURRENT_SCHEMA_VERSION;
  project.settings ??= {};
  project.archived ??= false;
  if ((candidate.status_dimensions as unknown[]).length === 0) {
    const defaults = createDefaultStatuses(String(project.id));
    candidate.status_dimensions = defaults.status_dimensions;
    candidate.status_options = defaults.status_options;
  }
  // Loading an existing project is also a trust boundary; do not expose a
  // legacy secret-bearing file to the editor just because it was not changed.
  assertNoSecretFields(candidate);
  assertValidProjectData(candidate);
  return candidate as unknown as ProjectData;
}

const SECRET_FIELD_TOKENS = [
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "bearertoken",
  "token",
  "cookie",
  "cookies",
  "password",
  "passphrase",
  "secret",
  "privatekey",
  "clientsecret",
  "authorization",
  "credential",
  "authreference",
  "credentialreference",
];
const PRIVATE_FIELD_TOKENS = [
  "workspacelocal",
  "securelocal",
  "modelconnections",
  "userpreferences",
  "recovery",
  "cache",
];

function isSensitiveFieldKey(key: string): boolean {
  const boundary = key.toLowerCase();
  if (
    /(?:^|[\s._-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|token|cookie|cookies|password|passphrase|secret|private[_-]?key|client[_-]?secret|authorization|credentials?|auth[_-]?reference|credential[_-]?reference)(?=$|[\s._-])/i
      .test(boundary)
  ) return true;
  if (
    /(?:^|[\s._-])(?:workspace[_-]?local|secure[_-]?local|model[_-]?connections?|user[_-]?preferences?|recovery|cache)(?=$|[\s._-])/i
      .test(boundary)
  ) return true;
  const compact = key.replace(/[\s._-]/g, "");
  const lower = compact.toLowerCase();
  return [...SECRET_FIELD_TOKENS, ...PRIVATE_FIELD_TOKENS].some((token) => {
    let position = lower.indexOf(token);
    while (position >= 0) {
      const after = position + token.length;
      if (after === compact.length || /[A-Z]/.test(compact[after] ?? "")) {
        return true;
      }
      position = lower.indexOf(token, position + 1);
    }
    return false;
  });
}

function assertNoSecretFields(value: unknown, path = "project"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSecretFields(item, `${path}[${index}]`)
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    // ConversationSource stores only an opaque local reference here; the
    // actual cookie/token remains in the local SecretStore.
    const isOpaqueAuthReference = key === "auth_reference" &&
      path.startsWith("project.conversation_sources[");
    // ContextPack stores only the id of the model connection it was built for.
    // Without this exemption the `model_connections` private-field token makes
    // every project that has ever built an AI context pack impossible to save
    // (`model_connection_id` matches the delimited `model[_-]?connections?`
    // rule), which would silently break autosave for the whole AI workflow.
    // The exemption is scoped to that exact column: a same-named key nested
    // deeper inside a pack row (or anywhere else) is still rejected.
    const isOpaqueModelConnectionRef = key === "model_connection_id" &&
      /^project\.context_packs\[\d+\]$/.test(path);
    if (
      isSensitiveFieldKey(key) && !isOpaqueAuthReference &&
      !isOpaqueModelConnectionRef
    ) {
      throw new Error(`项目数据禁止保存凭据字段: ${path}.${key}`);
    }
    assertNoSecretFields(child, `${path}.${key}`);
  }
}

export function serializeProject(data: ProjectData): string {
  assertNoSecretFields(data);
  return JSON.stringify(migrateProject(data), null, 2) + "\n";
}

export async function saveProject(
  data: ProjectData,
  filePath: string,
): Promise<void> {
  const contents = serializeProject(data);
  const temporary = `${filePath}.tmp-${crypto.randomUUID()}`;
  const bytes = new TextEncoder().encode(contents);
  try {
    const file = await Deno.open(temporary, {
      create: true,
      truncate: true,
      write: true,
    });
    try {
      let offset = 0;
      while (offset < bytes.length) {
        offset += await file.write(bytes.subarray(offset));
      }
      await file.sync();
    } finally {
      file.close();
    }
    // Validate the complete staged payload before replacing the canonical file.
    migrateProject(JSON.parse(await Deno.readTextFile(temporary)));
    try {
      await Deno.copyFile(filePath, `${filePath}.bak`);
    } catch (caught) {
      if (!(caught instanceof Deno.errors.NotFound)) throw caught;
    }
    await Deno.rename(temporary, filePath);
  } catch (caught) {
    try {
      await Deno.remove(temporary);
    } catch (cleanup) {
      if (!(cleanup instanceof Deno.errors.NotFound)) throw cleanup;
    }
    throw caught;
  }
}

export async function loadProject(filePath: string): Promise<ProjectData> {
  return migrateProject(JSON.parse(await Deno.readTextFile(filePath)));
}

export function touchProject(data: ProjectData): void {
  data.project.updated_at = now();
}

export function createJsonObject(
  entries: Record<string, unknown> = {},
): JsonObject {
  return entries as JsonObject;
}
