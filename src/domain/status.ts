import type { ProjectData, StatusAssignment } from "./types.ts";
import { assert, id, now } from "./util.ts";
import { touchProject } from "./store.ts";

export function initializeContentStatuses(
  data: ProjectData,
  contentItemId: string,
): void {
  const item = data.content_items.find((candidate) =>
    candidate.id === contentItemId
  );
  assert(item, `找不到内容: ${contentItemId}`);
  for (
    const dimension of data.status_dimensions.filter((candidate) =>
      candidate.project_id === item.project_id
    )
  ) {
    const firstOption = data.status_options
      .filter((option) => option.dimension_id === dimension.id)
      .sort((a, b) => a.order_index - b.order_index)[0];
    if (firstOption) {
      assignStatus(data, contentItemId, dimension.key, firstOption.key);
    }
  }
}

export function assignStatus(
  data: ProjectData,
  contentItemId: string,
  dimensionKey: string,
  optionKey: string,
): StatusAssignment {
  const item = data.content_items.find((candidate) =>
    candidate.id === contentItemId
  );
  assert(item, `找不到内容: ${contentItemId}`);
  const dimension = data.status_dimensions.find((candidate) =>
    candidate.project_id === item.project_id && candidate.key === dimensionKey
  );
  assert(dimension, `找不到状态维度: ${dimensionKey}`);
  const option = data.status_options.find((candidate) =>
    candidate.dimension_id === dimension.id && candidate.key === optionKey
  );
  assert(option, `找不到状态选项: ${dimensionKey}/${optionKey}`);
  const existing = data.status_assignments.find((assignment) =>
    assignment.content_item_id === contentItemId &&
    assignment.dimension_id === dimension.id
  );
  if (existing) {
    existing.option_id = option.id;
    existing.updated_at = now();
    touchProject(data);
    return existing;
  }
  const assignment: StatusAssignment = {
    id: id(),
    content_item_id: contentItemId,
    dimension_id: dimension.id,
    option_id: option.id,
    updated_at: now(),
  };
  data.status_assignments.push(assignment);
  touchProject(data);
  return assignment;
}

export interface StatusView {
  dimension_key: string;
  dimension_name: string;
  option_key: string;
  option_name: string;
}

export function getStatusViews(
  data: ProjectData,
  contentItemId: string,
): StatusView[] {
  const assignments = data.status_assignments.filter((assignment) =>
    assignment.content_item_id === contentItemId
  );
  return assignments.flatMap((assignment) => {
    const dimension = data.status_dimensions.find((candidate) =>
      candidate.id === assignment.dimension_id
    );
    const option = data.status_options.find((candidate) =>
      candidate.id === assignment.option_id
    );
    return dimension && option
      ? [{
        dimension_key: dimension.key,
        dimension_name: dimension.name,
        option_key: option.key,
        option_name: option.name,
      }]
      : [];
  }).sort((a, b) => a.dimension_key.localeCompare(b.dimension_key));
}
