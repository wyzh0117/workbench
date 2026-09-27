import type {
  AssetType,
  BlockType,
  JsonObject,
  LayoutInstance,
  LayoutPage,
  LayoutPageSize,
  Placement,
  ProjectData,
} from "../src/domain/types.ts";

export type PublicationTarget = "markdown" | "html" | "web" | "wechat" | "pdf" | "pptx";
export interface PublicationProjectionOptions {
  content_item_id?: string | null;
  layout_instance_id?: string | null;
  page_ids?: string[] | null;
  target_page_size?: LayoutPageSize | null;
}
export interface PublicationProjectionNotice {
  code: "legacy_grid_sections_require_pagination";
  layout_instance_id: string;
  section_ids: string[];
  includes_unsectioned: boolean;
  message: string;
}
export interface PublicationMedia {
  id: string;
  type: AssetType;
  title: string;
  filename: string;
  output_path: string;
  mime_type: string;
  source_url: string | null;
  inline: boolean;
}
export interface PublicationBlock {
  id: string;
  type: BlockType;
  text: string;
  heading_level: number | null;
  media: PublicationMedia | null;
}
export interface PublicationPageItem {
  placement_id: string;
  block_id: string;
  kind: BlockType;
  text: string;
  heading_level: number | null;
  rect: { x_pt: number; y_pt: number; width_pt: number; height_pt: number };
  style: {
    alignment: JsonObject;
    fit_mode: string;
    padding: JsonObject;
    z_index: number;
    font_size_pt: number;
    line_height: number;
  };
  media: PublicationMedia | null;
}
export interface PublicationPage {
  page_id: string | null;
  title: string;
  order: number;
  logical_width_pt: number;
  logical_height_pt: number;
  items: PublicationPageItem[];
}
export interface PublicationLesson {
  id: string;
  code: string;
  title: string;
  blocks: PublicationBlock[];
  attachments: PublicationMedia[];
  layout: null | {
    layout_instance_id: string;
    mode: "flow" | "grid";
    name: string;
    pagination_mode: "continuous" | "paged";
    page_size: LayoutPageSize;
    sections: string[];
    pages: PublicationPage[];
    unplaced_block_ids: string[];
    placed_block_ids: string[];
  };
}
export interface PublicationProjection {
  schema_version: "2";
  project_id: string;
  title: string;
  language: string;
  scope: "lesson" | "course";
  content_item_id: string | null;
  generated_from_updated_at: string;
  selection: {
    content_item_id: string | null;
    layout_instance_id: string | null;
    page_ids: string[] | null;
  };
  target_page_size: LayoutPageSize | null;
  lessons: PublicationLesson[];
  notices: PublicationProjectionNotice[];
  media: PublicationMedia[];
}
export type PublicationAdapter = { available: boolean; layout: boolean };
export declare const PAGE_SIZE_PRESETS: Record<string, LayoutPageSize>;
export declare const PUBLICATION_FORMATS: readonly PublicationTarget[];
export declare function getLayoutPages(data: ProjectData, layoutInstanceId: string): LayoutPage[];
export declare function resolvePageSize(layout: LayoutInstance): LayoutPageSize;
export declare function pageGrid(layout: LayoutInstance, page: LayoutPage): JsonObject;
export declare function resolvePlacementRect(
  placement: Placement,
  grid: JsonObject,
  size: Pick<LayoutPageSize, "width_pt" | "height_pt">,
): PublicationPageItem["rect"];
export declare function projectPageGeometry(
  layout: LayoutInstance,
  page: Pick<LayoutPage, "layout_instance_id" | "grid_definition"> & {
    id: string | null;
    title?: string;
    order_index?: number;
  },
  placements: Placement[],
): PublicationPage;
export declare function resolvePageItemStyle(
  block: import("../src/domain/types.ts").Block,
  placement?: Placement,
): PublicationPageItem["style"];
export declare function fitPageRect(
  sourceWidthPt: number,
  sourceHeightPt: number,
  targetWidthPt: number,
  targetHeightPt: number,
): { scale: number; x_pt: number; y_pt: number; width_pt: number; height_pt: number };
export declare function buildPublicationProjection(
  data: ProjectData,
  options?: PublicationProjectionOptions,
): PublicationProjection;
export declare function getAvailablePublicationAdapters(environment?: {
  native?: boolean;
  service?: boolean;
}): Record<PublicationTarget, PublicationAdapter>;
export declare function getPublicationCapabilities(
  projection: PublicationProjection,
  target: PublicationTarget,
  adapters?: Record<PublicationTarget, boolean | PublicationAdapter>,
): { status: "available" | "unavailable" | "unsupported" | "lossy"; code: string | null };
