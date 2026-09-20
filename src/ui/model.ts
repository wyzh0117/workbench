import type {
  ExportPreflight,
  GridDefinition,
  GridPlacement,
} from "./contracts.ts";

/** Keep pointer movement on integer tracks; DOM pixels are never canonical. */
export function snapTrack(value: number, trackCount: number): number {
  if (!Number.isFinite(value) || trackCount <= 0) return 0;
  return Math.max(0, Math.min(trackCount - 1, Math.round(value)));
}

export function normalizeGrid(grid: Partial<GridDefinition>): GridDefinition {
  const columns = Array.isArray(grid.columns) && grid.columns.length
    ? grid.columns.map((value) =>
      Number.isFinite(value) && value > 0 ? value : 1
    )
    : [1];
  const rows = Array.isArray(grid.rows) && grid.rows.length
    ? grid.rows.map((value) => Number.isFinite(value) && value > 0 ? value : 1)
    : [1];
  return { columns, rows };
}

export function clampPlacement(
  placement: GridPlacement,
  grid: GridDefinition,
): GridPlacement {
  const normalized = normalizeGrid(grid);
  const rowStart = snapTrack(placement.row_start, normalized.rows.length);
  const columnStart = snapTrack(
    placement.column_start,
    normalized.columns.length,
  );
  const rowEnd = Math.max(
    rowStart + 1,
    Math.min(normalized.rows.length, Math.round(placement.row_end)),
  );
  const columnEnd = Math.max(
    columnStart + 1,
    Math.min(normalized.columns.length, Math.round(placement.column_end)),
  );
  return {
    ...placement,
    row_start: rowStart,
    row_end: rowEnd,
    column_start: columnStart,
    column_end: columnEnd,
  };
}

export function deriveExportPreflight(input: {
  content_gaps: number;
  layout_gaps: number;
  placements?: Array<Pick<GridPlacement, "row_end" | "column_end">>;
  grid?: GridDefinition;
  text_overflow?: number;
  missing_fonts?: number;
}): ExportPreflight {
  const grid = input.grid ? normalizeGrid(input.grid) : null;
  const overflow = grid && input.placements
    ? input.placements.filter((placement) =>
      placement.row_end > grid.rows.length ||
      placement.column_end > grid.columns.length
    ).length
    : 0;
  const text_overflow = input.text_overflow ?? 0;
  const missing_fonts = input.missing_fonts ?? 0;
  return {
    content_gaps: Math.max(0, input.content_gaps),
    layout_gaps: Math.max(0, input.layout_gaps),
    overflow,
    text_overflow,
    missing_fonts,
    total: Math.max(0, input.content_gaps) + Math.max(0, input.layout_gaps) +
      overflow + text_overflow + missing_fonts,
  };
}

export function atomicPayload(project: unknown): string {
  return JSON.stringify(project, null, 2) + "\n";
}
