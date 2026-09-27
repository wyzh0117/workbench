import type {
  LayoutPage,
  LayoutPageSize,
  Placement,
  ProjectData,
  JsonObject,
} from "../src/domain/types.ts";

export function addLayoutPage(
  data: ProjectData,
  layoutId: string,
  input?: { title?: string; after_page_id?: string; grid_definition?: JsonObject },
): LayoutPage;
export function convertSectionsToPages(
  data: ProjectData,
  layoutId: string,
  options?: { page_size?: LayoutPageSize },
): LayoutPage[];
export function renameLayoutPage(
  data: ProjectData,
  pageId: string,
  title: string,
): LayoutPage;
export function reorderLayoutPage(
  data: ProjectData,
  pageId: string,
  orderIndex: number,
): LayoutPage;
export function deleteLayoutPage(
  data: ProjectData,
  pageId: string,
): { deleted_page: LayoutPage; unplaced_block_ids: string[] };
export function movePlacementToPage(
  data: ProjectData,
  placementId: string,
  pageId: string,
  coordinates?: Pick<Placement, "row_start" | "row_end" | "column_start" | "column_end"> | null,
): Placement;
export function duplicateLayoutPage(
  data: ProjectData,
  pageId: string,
  input?: { title?: string },
): LayoutPage;
export function setLayoutPageSize(
  data: ProjectData,
  layoutId: string,
  pageSize: LayoutPageSize,
): LayoutPageSize;
export function createPagedLayout(
  data: ProjectData,
  layoutId: string,
  pageSize?: LayoutPageSize,
): LayoutPage[];
