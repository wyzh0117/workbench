import {
  atomicPayload,
  clampPlacement,
  deriveExportPreflight,
  normalizeGrid,
  snapTrack,
} from "../src/ui/model.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Grid movement snaps to integer tracks and stays inside the grid", () => {
  assert(snapTrack(1.6, 4) === 2, "pointer movement should snap");
  assert(snapTrack(-4, 4) === 0, "start must be clamped");
  assert(snapTrack(99, 4) === 3, "end must be clamped");
  const placement = clampPlacement({
    block_id: "b1",
    row_start: 2.7,
    row_end: 99.2,
    column_start: -1,
    column_end: 0.2,
    section_id: null,
  }, normalizeGrid({ columns: [1, 1], rows: [1, 1, 1] }));
  assert(placement.row_start === 2 && placement.row_end === 3, "rows clamp");
  assert(
    placement.column_start === 0 && placement.column_end === 1,
    "cols clamp",
  );
});

Deno.test("Export preflight reports content/layout gaps without blocking export", () => {
  const report = deriveExportPreflight({
    content_gaps: 2,
    layout_gaps: 1,
    placements: [{ row_end: 4, column_end: 1 }],
    grid: { rows: [1, 1, 1], columns: [1] },
    text_overflow: 1,
  });
  assert(report.overflow === 1, "overflow should be visible");
  assert(report.total === 5, "all checks should be counted");
});

Deno.test("Canonical payload is newline-terminated and independent of UI state", () => {
  const payload = atomicPayload({ project: { title: "课程" } });
  assert(payload.endsWith("\n"), "atomic payload must be complete JSON");
  assert(
    !payload.includes("left_collapsed"),
    "UI state must stay outside project data",
  );
});

Deno.test("Desktop shell restores persisted state and supports palette keyboard actions", async () => {
  const source = await Deno.readTextFile(
    new URL("../app/main.js", import.meta.url),
  );
  assert(
    source.includes("void store.initialize();"),
    "startup must hydrate project/session state",
  );
  assert(
    source.includes("event.stopPropagation();"),
    "closing a tab must not reopen it through the parent button",
  );
  assert(
    source.includes('event.key === "Enter"'),
    "palette must support opening the selected result with Enter",
  );
  assert(
    source.includes("snapshotId: input.snapshot_id"),
    "native snapshot writes must preserve the UI snapshot id",
  );
  assert(
    source.includes("native !== undefined"),
    "native null command results must not trigger browser fallback writes",
  );
  assert(
    source.includes('requirement.scope === "layout"'),
    "browser Markdown export must exclude layout-only requirements",
  );
  assert(
    source.includes("AI 连接器尚未配置"),
    "browser fallback must not claim a suggestion was generated without an AI adapter",
  );
});
