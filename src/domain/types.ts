/**
 * Canonical project model for the pre-UI core.
 *
 * The desktop shell can call these objects through a Tauri command boundary.
 * No UI state, credentials, caches, or derived reports belong in ProjectData.
 */

export const CURRENT_SCHEMA_VERSION = "1.0.0";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
  [key: string]: JsonValue;
};
export type JsonObject = { [key: string]: JsonValue };

export type UUID = string;
export type ISODate = string;

export type ContentItemType =
  | "course_overview"
  | "stage_intro"
  | "lesson"
  | "exercise"
  | "case"
  | "pitfall"
  | "assessment"
  | "summary"
  | "reference"
  | "other";

export type BlockType =
  | "heading"
  | "paragraph"
  | "quote"
  | "image"
  | "gallery"
  | "gif"
  | "video"
  | "audio"
  | "table"
  | "chart"
  | "code"
  | "callout"
  | "exercise"
  | "divider"
  | "placeholder"
  | "embed";

export type RequirementType =
  | "text"
  | "image"
  | "gif"
  | "video"
  | "audio"
  | "table"
  | "chart"
  | "quote"
  | "case"
  | "link"
  | "data"
  | "other";

export type RequirementScope = "content" | "layout";
export type RequirementStatus = "open" | "resolved" | "ignored";
export type RequirementPriority = "low" | "normal" | "high";

export type AssetType =
  | "image"
  | "gif"
  | "video"
  | "audio"
  | "document"
  | "other";
export type AssetSourceType =
  | "original"
  | "generated"
  | "imported"
  | "external"
  | "unknown";

export type LayoutMode = "flow" | "grid";
export type FitMode = "contain" | "cover" | "stretch" | "natural";

export type CourseSeedSourceType =
  | "overview"
  | "outline"
  | "toc"
  | "articles"
  | "folder"
  | "spreadsheet"
  | "conversations"
  | "wizard"
  | "blank";

export type BlueprintStatus = "draft" | "confirmed" | "discarded";
export type BlueprintNodeType = "stage" | "content";

export type ConnectionStatus =
  | "disconnected"
  | "connected"
  | "error"
  | "requires_auth";
export type MessageRole = "user" | "assistant" | "system" | "tool";
export type ContextSourceType =
  | "document"
  | "stage"
  | "course_map"
  | "requirement"
  | "conversation"
  | "message"
  | "asset"
  | "custom";

export type SuggestionType =
  | "add_content"
  | "remove_content"
  | "rewrite"
  | "update_fact"
  | "add_media"
  | "restructure"
  | "new_lesson"
  | "move_lesson"
  | "other";
export type SuggestionStatus = "pending" | "accepted" | "ignored";
export type ChangeDraftStatus = "draft" | "reviewing" | "applied" | "discarded";

export interface Project {
  id: UUID;
  title: string;
  description: string;
  language: string;
  schema_version: string;
  created_at: ISODate;
  updated_at: ISODate;
  archived: boolean;
  settings: JsonObject;
}

export interface Stage {
  id: UUID;
  project_id: UUID;
  parent_stage_id: UUID | null;
  code: string;
  title: string;
  description: string;
  learning_action: string;
  order_index: number;
  archived: boolean;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface ContentItem {
  id: UUID;
  project_id: UUID;
  stage_id: UUID | null;
  code: string;
  title: string;
  type: ContentItemType;
  description: string;
  order_index: number;
  document_id: UUID;
  archived: boolean;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface Document {
  id: UUID;
  content_item_id: UUID;
  schema_version: string;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface Block {
  id: UUID;
  document_id: UUID;
  parent_block_id: UUID | null;
  type: BlockType;
  order_index: number;
  content: JsonValue;
  settings: JsonObject;
  created_at: ISODate;
  updated_at: ISODate;
}

/**
 * A semantic group is separate from a Block.  Group membership is canonical
 * and therefore does not leak grid coordinates into the document nodes.
 */
export interface BlockGroup {
  id: UUID;
  document_id: UUID;
  parent_group_id: UUID | null;
  title: string;
  block_ids: UUID[];
  order_index: number;
  collapsed: boolean;
  created_at: ISODate;
  updated_at: ISODate;
}

/** User-facing terminology and the internal name are intentionally aliases. */
export type Group = BlockGroup;

export interface Requirement {
  id: UUID;
  content_item_id: UUID;
  anchor_block_id: UUID | null;
  type: RequirementType;
  scope: RequirementScope;
  layout_instance_id: UUID | null;
  note: string;
  status: RequirementStatus;
  priority: RequirementPriority;
  resolved_asset_id: UUID | null;
  resolved_block_id: UUID | null;
  created_at: ISODate;
  resolved_at: ISODate | null;
}

export interface Asset {
  id: UUID;
  project_id: UUID;
  type: AssetType;
  filename: string;
  storage_path: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  file_size: number;
  checksum: string;
  title: string;
  description: string;
  source_type: AssetSourceType;
  source_url: string | null;
  copyright_note: string | null;
  created_at: ISODate;
  archived: boolean;
}

export interface AssetUsage {
  id: UUID;
  asset_id: UUID;
  content_item_id: UUID;
  block_id: UUID | null;
  layout_instance_id: UUID | null;
  role: string;
  created_at: ISODate;
}

export interface StatusDimension {
  id: UUID;
  project_id: UUID;
  key: string;
  name: string;
  order_index: number;
  allow_custom: boolean;
}

export interface StatusOption {
  id: UUID;
  dimension_id: UUID;
  key: string;
  name: string;
  order_index: number;
  is_terminal: boolean;
}

export interface StatusAssignment {
  id: UUID;
  content_item_id: UUID;
  dimension_id: UUID;
  option_id: UUID;
  updated_at: ISODate;
}

export interface LayoutTemplate {
  id: UUID;
  project_id: UUID | null;
  schema_version: string;
  name: string;
  mode: LayoutMode;
  width: number | null;
  height: number | null;
  aspect_ratio: string | null;
  default_grid: JsonObject;
  style_tokens: JsonObject;
  constraints: JsonObject;
  built_in: boolean;
}

export interface LayoutInstance {
  id: UUID;
  content_item_id: UUID;
  template_id: UUID | null;
  schema_version: string;
  name: string;
  mode: LayoutMode;
  grid_definition: JsonObject;
  settings: JsonObject;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface LayoutSection {
  id: UUID;
  layout_instance_id: UUID;
  name: string;
  page_index: number;
  order_index: number;
  grid_definition: JsonObject;
  settings: JsonObject;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface Placement {
  id: UUID;
  layout_instance_id: UUID;
  block_id: UUID;
  section_id: UUID | null;
  row_start: number;
  row_end: number;
  column_start: number;
  column_end: number;
  alignment: JsonObject;
  fit_mode: FitMode;
  padding: JsonObject;
  z_index: number;
}

export interface InboxItem {
  id: UUID;
  project_id: UUID | null;
  source_type: string;
  title: string;
  body: string;
  asset_id: UUID | null;
  content_item_id: UUID | null;
  status: "open" | "triaged" | "archived";
  created_at: ISODate;
  updated_at: ISODate;
}

export interface ExportPreset {
  id: UUID;
  project_id: UUID | null;
  name: string;
  output_type:
    | "markdown"
    | "html"
    | "image"
    | "pdf"
    | "json"
    | "asset_package"
    | "full_project"
    | "custom";
  platform: string;
  layout_instance_id: UUID | null;
  page_mode: "single" | "multi_page" | "long_image" | "web";
  settings: JsonObject;
  /** Optional 16-spec fields; older projects remain valid without them. */
  target_type?: string;
  width?: number | null;
  height?: number | null;
  format?: string;
  pagination_mode?: string;
  naming_rule?: string;
  scale?: number;
  background_mode?: string;
  media_rules?: JsonObject;
}

export interface CourseSeed {
  id: UUID;
  project_id: UUID | null;
  source_type: CourseSeedSourceType;
  raw_text: string | null;
  source_files: JsonValue[];
  metadata: JsonObject;
  created_at: ISODate;
}

export interface BlueprintDraft {
  id: UUID;
  course_seed_id: UUID;
  title: string;
  status: BlueprintStatus;
  created_at: ISODate;
  confirmed_at: ISODate | null;
}

export interface BlueprintNode {
  id: UUID;
  blueprint_id: UUID;
  parent_id: UUID | null;
  node_type: BlueprintNodeType;
  title: string;
  suggested_type: ContentItemType;
  order_index: number;
}

export interface ConversationSource {
  id: UUID;
  provider: string;
  display_name: string;
  connector_type: string;
  account_label: string;
  connection_status: ConnectionStatus;
  auth_reference: string;
  last_sync_at: ISODate | null;
}

export interface Conversation {
  id: UUID;
  source_id: UUID;
  external_id: string;
  title: string;
  external_created_at: ISODate | null;
  external_updated_at: ISODate | null;
  synced_at: ISODate;
  metadata: JsonObject;
}

export interface Message {
  id: UUID;
  conversation_id: UUID;
  external_id: string | null;
  role: MessageRole;
  content: JsonValue;
  attachments: JsonValue[];
  created_at: ISODate;
}

export interface ContextPack {
  id: UUID;
  project_id: UUID;
  target_content_item_id: UUID | null;
  purpose: string;
  created_at: ISODate;
  model_connection_id: UUID | null;
}

export interface ContextPackItem {
  id: UUID;
  context_pack_id: UUID;
  source_type: ContextSourceType;
  source_id: string;
  label: string;
  content_hash: string;
  order_index: number;
}

export interface Suggestion {
  id: UUID;
  target_content_item_id: UUID;
  context_pack_id: UUID;
  type: SuggestionType;
  title: string;
  description: string;
  evidence_refs: JsonValue[];
  status: SuggestionStatus;
  model_metadata: JsonObject;
  created_at: ISODate;
  reviewed_at: ISODate | null;
}

export interface ChangePatch {
  block_id: UUID;
  before: JsonValue | null;
  after: JsonValue;
}

export interface ChangeDraft {
  id: UUID;
  suggestion_id: UUID;
  target_content_item_id: UUID;
  base_revision: string;
  proposed_changes: ChangePatch[];
  diff: JsonValue;
  status: ChangeDraftStatus;
  created_at: ISODate;
  applied_at: ISODate | null;
  /** Optional V0-T03 fields; drafts written before them stay valid. */
  operations?: ChangeOperation[];
  reason?: string;
  validation?: ChangeValidation;
  scope?: JsonObject;
  provider?: JsonObject;
}

/** One reviewable AI edit. `before`/`after` are snapshots used by Diff + Apply. */
export interface ChangeOperation {
  id: string;
  op: "replace_block" | "insert_block" | "create_requirement" | "move_block";
  target: JsonObject;
  before: JsonValue | null;
  after: JsonValue;
  reason: string;
}

/** Result of the domain check that runs before an AI draft can be applied. */
export interface ChangeValidation {
  checked_at: ISODate;
  ok: boolean;
  issues: string[];
}

export interface Snapshot {
  id: UUID;
  project_id: UUID;
  name: string;
  note: string;
  git_commit_hash: string | null;
  created_at: ISODate;
}

export interface Publication {
  id: UUID;
  content_item_id: UUID;
  platform: string;
  layout_instance_id: UUID | null;
  status: "unpublished" | "ready" | "published" | "failed";
  version_label: string;
  published_at: ISODate | null;
  external_url: string | null;
  export_path: string | null;
}

/** Model connections are local-workspace data; only the reference is safe to persist. */
export interface ModelConnection {
  id: UUID;
  provider: string;
  name: string;
  base_url: string;
  model: string;
  credential_reference: string;
  capabilities: JsonObject;
  enabled: boolean;
}

export interface UserPreference {
  id: UUID;
  theme: string;
  left_panel_width: number;
  right_panel_width: number;
  default_editor_mode: "writing" | "structure" | "layout" | "preview";
  last_open_project: UUID | null;
  other_settings: JsonObject;
}

/** Project-owned canonical data. Derived reports and secure local data are intentionally absent. */
export interface ProjectData {
  schema_version: string;
  project: Project;
  stages: Stage[];
  content_items: ContentItem[];
  documents: Document[];
  blocks: Block[];
  groups: BlockGroup[];
  requirements: Requirement[];
  assets: Asset[];
  asset_usages: AssetUsage[];
  status_dimensions: StatusDimension[];
  status_options: StatusOption[];
  status_assignments: StatusAssignment[];
  layout_templates: LayoutTemplate[];
  layout_instances: LayoutInstance[];
  layout_sections: LayoutSection[];
  placements: Placement[];
  inbox_items: InboxItem[];
  export_presets: ExportPreset[];
  course_seeds: CourseSeed[];
  blueprint_drafts: BlueprintDraft[];
  blueprint_nodes: BlueprintNode[];
  conversation_sources: ConversationSource[];
  conversations: Conversation[];
  messages: Message[];
  context_packs: ContextPack[];
  context_pack_items: ContextPackItem[];
  suggestions: Suggestion[];
  change_drafts: ChangeDraft[];
  snapshots: Snapshot[];
  publications: Publication[];
}

export interface WorkspaceLocalData {
  model_connections: ModelConnection[];
  user_preferences: UserPreference | null;
}
