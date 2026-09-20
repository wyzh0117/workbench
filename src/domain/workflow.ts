import type { InboxItem, ProjectData, Publication, Snapshot } from "./types.ts";
import { assert, id, now } from "./util.ts";
import { touchProject } from "./store.ts";

export function createInboxItem(
  data: ProjectData,
  input: {
    title: string;
    body: string;
    source_type?: string;
    project_id?: string | null;
    asset_id?: string | null;
  },
): InboxItem {
  const projectId = input.project_id ?? data.project.id;
  assert(projectId === data.project.id, "收件箱项目不属于当前项目");
  if (input.asset_id) {
    const asset = data.assets.find((candidate) =>
      candidate.id === input.asset_id
    );
    assert(asset?.project_id === projectId, "收件箱素材不属于当前项目");
  }
  const item: InboxItem = {
    id: id(),
    project_id: projectId,
    source_type: input.source_type ?? "manual",
    title: input.title,
    body: input.body,
    asset_id: input.asset_id ?? null,
    content_item_id: null,
    status: "open",
    created_at: now(),
    updated_at: now(),
  };
  data.inbox_items.push(item);
  touchProject(data);
  return item;
}

export function triageInboxItem(
  data: ProjectData,
  inboxItemId: string,
  contentItemId?: string | null,
): InboxItem {
  const item = data.inbox_items.find((candidate) =>
    candidate.id === inboxItemId
  );
  assert(item, `找不到收件箱条目: ${inboxItemId}`);
  if (contentItemId) {
    const content = data.content_items.find((candidate) =>
      candidate.id === contentItemId
    );
    assert(
      content?.project_id === item.project_id,
      "收件箱目标内容不存在",
    );
  }
  item.content_item_id = contentItemId ?? null;
  item.status = "triaged";
  item.updated_at = now();
  touchProject(data);
  return item;
}

export function createSnapshot(
  data: ProjectData,
  name: string,
  note = "",
  gitCommitHash: string | null = null,
): Snapshot {
  const snapshot: Snapshot = {
    id: id(),
    project_id: data.project.id,
    name,
    note,
    git_commit_hash: gitCommitHash,
    created_at: now(),
  };
  data.snapshots.push(snapshot);
  touchProject(data);
  return snapshot;
}

export function createRestoreBackup(
  data: ProjectData,
  note = "恢复前自动备份",
): Snapshot {
  return createSnapshot(data, "恢复前备份", note);
}

export function createPublication(
  data: ProjectData,
  input: {
    content_item_id: string;
    platform: string;
    layout_instance_id?: string | null;
    status?: Publication["status"];
    version_label?: string;
    export_path?: string | null;
  },
): Publication {
  const item = data.content_items.find((candidate) =>
    candidate.id === input.content_item_id
  );
  assert(item?.project_id === data.project.id, "发布目标内容不存在");
  if (input.layout_instance_id) {
    const layout = data.layout_instances.find((candidate) =>
      candidate.id === input.layout_instance_id
    );
    assert(
      layout?.content_item_id === input.content_item_id,
      "发布排版版本与内容不匹配",
    );
  }
  const publication: Publication = {
    id: id(),
    content_item_id: input.content_item_id,
    platform: input.platform,
    layout_instance_id: input.layout_instance_id ?? null,
    status: input.status ?? "unpublished",
    version_label: input.version_label ?? "未命名版本",
    published_at: null,
    external_url: null,
    export_path: input.export_path ?? null,
  };
  data.publications.push(publication);
  touchProject(data);
  return publication;
}
