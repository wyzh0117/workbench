import {
  type ExportPreset,
  type FitMode,
  type JsonObject,
  type LayoutInstance,
  type LayoutMode,
  type LayoutSection,
  type LayoutTemplate,
  type Placement,
  type ProjectData,
} from "./types.ts";
import { assert, id, now } from "./util.ts";
import { touchProject } from "./store.ts";

export interface LayoutTemplateInput {
  project_id?: string | null;
  name: string;
  mode: LayoutMode;
  width?: number | null;
  height?: number | null;
  aspect_ratio?: string | null;
  default_grid?: JsonObject;
  style_tokens?: JsonObject;
  constraints?: JsonObject;
  built_in?: boolean;
}

export function createLayoutTemplate(
  data: ProjectData,
  input: LayoutTemplateInput,
): LayoutTemplate {
  if (input.project_id !== null && input.project_id !== undefined) {
    assert(input.project_id === data.project.id, "排版模板不属于当前项目");
  }
  const template: LayoutTemplate = {
    id: id(),
    project_id: input.built_in ? null : input.project_id ?? data.project.id,
    schema_version: data.schema_version,
    name: input.name,
    mode: input.mode,
    width: input.width ?? null,
    height: input.height ?? null,
    aspect_ratio: input.aspect_ratio ?? null,
    default_grid: input.default_grid ?? { columns: [1], rows: [1] },
    style_tokens: input.style_tokens ?? {},
    constraints: input.constraints ?? {},
    built_in: input.built_in ?? false,
  };
  data.layout_templates.push(template);
  touchProject(data);
  return template;
}

export function createLayoutInstance(
  data: ProjectData,
  contentItemId: string,
  input: {
    name: string;
    mode: LayoutMode;
    template_id?: string | null;
    grid_definition?: JsonObject;
    settings?: JsonObject;
  },
): LayoutInstance {
  const item = data.content_items.find((candidate) =>
    candidate.id === contentItemId
  );
  assert(
    item?.project_id === data.project.id,
    `找不到当前项目内容: ${contentItemId}`,
  );
  const templateId = input.template_id ?? null;
  if (templateId) {
    const template = data.layout_templates.find((candidate) =>
      candidate.id === templateId
    );
    assert(template, `找不到排版模板: ${templateId}`);
    assert(
      template.project_id === null || template.project_id === data.project.id,
      "排版模板不属于当前项目",
    );
    assert(template.mode === input.mode, "排版实例与模板模式不一致");
  }
  const instance: LayoutInstance = {
    id: id(),
    content_item_id: contentItemId,
    template_id: templateId,
    schema_version: data.schema_version,
    name: input.name,
    mode: input.mode,
    grid_definition: input.grid_definition ?? { columns: [1], rows: [1] },
    settings: input.settings ?? {},
    created_at: now(),
    updated_at: now(),
  };
  data.layout_instances.push(instance);
  touchProject(data);
  return instance;
}

export function addLayoutSection(
  data: ProjectData,
  layoutInstanceId: string,
  input: {
    name: string;
    page_index?: number;
    order_index?: number;
    grid_definition?: JsonObject;
    settings?: JsonObject;
  },
): LayoutSection {
  const layout = data.layout_instances.find((candidate) =>
    candidate.id === layoutInstanceId
  );
  assert(layout, `找不到排版版本: ${layoutInstanceId}`);
  const sectionsForLayout = data.layout_sections.filter((section) =>
    section.layout_instance_id === layoutInstanceId
  );
  const section: LayoutSection = {
    id: id(),
    layout_instance_id: layoutInstanceId,
    name: input.name,
    page_index: input.page_index ?? sectionsForLayout.length,
    order_index: input.order_index ?? sectionsForLayout.length,
    grid_definition: input.grid_definition ?? layout.grid_definition,
    settings: input.settings ?? {},
    created_at: now(),
    updated_at: now(),
  };
  data.layout_sections.push(section);
  touchProject(data);
  return section;
}

export function addPlacement(
  data: ProjectData,
  layoutInstanceId: string,
  blockId: string,
  input: {
    row_start: number;
    row_end: number;
    column_start: number;
    column_end: number;
    section_id?: string | null;
    alignment?: JsonObject;
    fit_mode?: FitMode;
    padding?: JsonObject;
    z_index?: number;
  },
): Placement {
  const layout = data.layout_instances.find((candidate) =>
    candidate.id === layoutInstanceId
  );
  assert(layout, `找不到排版版本: ${layoutInstanceId}`);
  const block = data.blocks.find((candidate) => candidate.id === blockId);
  assert(block, `找不到正文区块: ${blockId}`);
  const document = data.documents.find((candidate) =>
    candidate.id === block.document_id
  );
  assert(
    document?.content_item_id === layout.content_item_id,
    "排版只能放置同一内容的正文区块",
  );
  if (input.section_id) {
    const section = data.layout_sections.find((candidate) =>
      candidate.id === input.section_id
    );
    assert(
      section?.layout_instance_id === layoutInstanceId,
      "排版区域不属于该排版版本",
    );
  }
  assert(
    input.row_start >= 0 && input.row_end > input.row_start,
    "行轨道范围无效",
  );
  assert(
    input.column_start >= 0 && input.column_end > input.column_start,
    "列轨道范围无效",
  );
  assert(
    [input.row_start, input.row_end, input.column_start, input.column_end]
      .every(Number.isInteger),
    "网格轨道必须使用整数",
  );
  const placement: Placement = {
    id: id(),
    layout_instance_id: layoutInstanceId,
    block_id: blockId,
    section_id: input.section_id ?? null,
    row_start: input.row_start,
    row_end: input.row_end,
    column_start: input.column_start,
    column_end: input.column_end,
    alignment: input.alignment ?? {},
    fit_mode: input.fit_mode ?? "natural",
    padding: input.padding ?? {},
    z_index: input.z_index ?? 0,
  };
  data.placements.push(placement);
  layout.updated_at = now();
  touchProject(data);
  return placement;
}

export function createExportPreset(
  data: ProjectData,
  input: {
    name: string;
    output_type: ExportPreset["output_type"];
    platform?: string;
    project_id?: string | null;
    layout_instance_id?: string | null;
    page_mode?: ExportPreset["page_mode"];
    settings?: JsonObject;
    target_type?: string;
    width?: number | null;
    height?: number | null;
    format?: string;
    pagination_mode?: string;
    naming_rule?: string;
    scale?: number;
    background_mode?: string;
    media_rules?: JsonObject;
  },
): ExportPreset {
  if (input.project_id !== null && input.project_id !== undefined) {
    assert(input.project_id === data.project.id, "导出预设不属于当前项目");
  }
  if (input.layout_instance_id) {
    const layout = data.layout_instances.find((candidate) =>
      candidate.id === input.layout_instance_id
    );
    assert(layout, "找不到导出预设的排版版本");
    const contentItem = data.content_items.find((item) =>
      item.id === layout.content_item_id
    );
    assert(
      contentItem?.project_id === data.project.id,
      "导出预设的排版版本不属于当前项目",
    );
  }
  const preset: ExportPreset = {
    id: id(),
    project_id: input.project_id ?? data.project.id,
    name: input.name,
    output_type: input.output_type,
    platform: input.platform ?? "custom",
    layout_instance_id: input.layout_instance_id ?? null,
    page_mode: input.page_mode ?? "single",
    settings: input.settings ?? {},
    target_type: input.target_type,
    width: input.width ?? null,
    height: input.height ?? null,
    format: input.format,
    pagination_mode: input.pagination_mode,
    naming_rule: input.naming_rule,
    scale: input.scale,
    background_mode: input.background_mode,
    media_rules: input.media_rules,
  };
  data.export_presets.push(preset);
  touchProject(data);
  return preset;
}
