/**
 * Desktop boundary contracts.  The Web UI talks to this interface only;
 * filesystem, Git and secure storage stay behind the Tauri bridge.
 */

import type {
  PresentationDocument,
  ResourceItem,
  ResourceUsage,
  SlidePlan,
  SlidePlanGenerationSource,
  SlideSpec,
  SourceEvidence,
  StyleProfile,
} from "../domain/types.ts";

export type EditorMode = "writing" | "structure" | "layout" | "preview";
export type RightPanel =
  | "media"
  | "requirements"
  | "status"
  | "assistant"
  | "properties"
  | "versions";

export interface WorkbenchSession {
  /** Native sessions bind the reader position to this directory when present. */
  project_dir?: string | null;
  project_id: string | null;
  active_content_item_id: string | null;
  mode: EditorMode;
  right_panel: RightPanel;
  route?: string;
  course_tree_filter?: string;
  media_filter?: string;
  settings_section?: string;
  selected_block_id?: string | null;
  ai_scope?: "course" | "lesson" | "block";
  ai_provider_id?: string;
  ai_model?: string;
  collapsed_stage_ids?: string[];
  left_collapsed: boolean;
  right_collapsed: boolean;
  tabs: Array<{
    content_item_id: string;
    mode: EditorMode;
    pinned: boolean;
    scroll_top: number;
  }>;
  /** Reader positions for other project identities visited in this process. */
  project_sessions?: Record<string, NativeReaderSession>;
}

export interface NativeReaderSession {
  project_dir: string;
  project_id: string;
  active_content_item_id: string | null;
  mode: EditorMode;
  right_panel: RightPanel;
  route?: string;
  course_tree_filter?: string;
  media_filter?: string;
  settings_section?: string;
  selected_block_id?: string | null;
  ai_scope?: "course" | "lesson" | "block";
  ai_provider_id?: string;
  ai_model?: string;
  collapsed_stage_ids?: string[];
  left_collapsed: boolean;
  right_collapsed: boolean;
  tabs: WorkbenchSession["tabs"];
}

/** A launch override may intentionally contain only the explicit directory. */
export interface NativeWorkbenchSession {
  project_dir: string;
}

export type PersistedWorkbenchSession =
  | WorkbenchSession
  | NativeWorkbenchSession;

export interface AtomicWriteRequest {
  relative_path: string;
  contents: string;
}

export interface FileFingerprint {
  exists: boolean;
  mtime_ms: number | null;
  size: number | null;
  hash: string | null;
}

export interface RecoveryJournalClearRequest {
  project_dir: string;
  expected_project_id: string;
  lease_generation: string | number;
  editor_generation: number;
  operation_id: string;
  revision: number;
  expected_fingerprint: FileFingerprint;
  expected_transaction_id: string;
}

export interface RecoveryJournalClearResult {
  cleared: boolean;
  transaction_id: string | null;
  durability_warning?: string | null;
  project_id: string;
  project_dir: string;
  lease_generation: string | number;
  editor_generation: number;
  operation_id: string;
  revision: number;
  fingerprint: FileFingerprint;
}

export interface ProjectReadState {
  project: unknown | null;
  project_id: string | null;
  fingerprint: FileFingerprint;
  /** Present only for a writer-opened native project; a pure read has no lease. */
  lease_generation?: string | null;
  resource_recovery_warning?: string | null;
}

export interface ProjectSaveRequest {
  project_dir: string | null;
  expected_project_id: string;
  lease_generation: string | number | null;
  editor_generation: number;
  operation_id: string;
  revision: number;
  expected_fingerprint: FileFingerprint | null;
  project: unknown;
  recovery_metadata?: Record<string, unknown>;
}

export interface ProjectSaveResult {
  project_id: string;
  lease_generation: string | null;
  editor_generation: number;
  operation_id: string;
  revision: number;
  outcome: "written" | "unchanged";
  commit_state: "committed";
  fingerprint: FileFingerprint;
  recovery_warning?: string | null;
  durability_warning?: string | null;
}

export interface SnapshotWriteRequest {
  project_dir: string;
  snapshot_id: string;
  name: string;
  note: string;
  project: unknown;
  expected_project_id: string;
  lease_generation: string | null;
  editor_generation: number;
  operation_id: string;
  revision: number;
}

export interface SnapshotWriteResult {
  id: string;
  snapshot_id: string;
  name: string;
  note: string;
  created_at: string;
  content_hash: string;
  project_id: string;
  project_dir: string;
  lease_generation: string | null;
  editor_generation: number;
  operation_id: string;
  revision: number;
  persisted: true;
  outcome: "written" | "unchanged";
  durability_warning?: string;
}

export interface SnapshotRestoreRequest {
  project_dir: string;
  expected_project_id: string;
  expected_fingerprint: FileFingerprint;
  lease_generation: string | null;
  editor_generation: number;
  operation_id: string;
  revision: number;
}

export interface CanonicalMutationAcknowledgement {
  project: unknown;
  fingerprint: FileFingerprint;
  project_id: string;
  project_dir: string;
  lease_generation: string | null;
  editor_generation: number;
  operation_id: string;
  revision: number;
  commit_state: "committed";
  outcome: "written" | "unchanged";
  recovery_warning?: string | null;
  durability_warning?: string | null;
}

export interface SnapshotRestoreResult {
  restored: true;
  snapshot_id: string;
  project: unknown;
  fingerprint: FileFingerprint;
  project_id: string;
  project_dir?: string;
  lease_generation: string | null;
  editor_generation: number;
  operation_id: string;
  revision: number;
  backup_snapshot_id: string;
  backup_persisted: true;
  commit_state: "committed";
  recovery_warning?: string | null;
  durability_warning?: string | null;
}

export interface SnapshotListRow {
  id: string | null;
  name: string;
  note: string;
  created_at: string;
  status: "available" | "error" | "persisted";
  error?: { code: string; message: string };
  content_hash?: string;
}

export interface SnapshotListResult {
  project_id: string;
  snapshots: SnapshotListRow[];
}

export interface AssetPreviewBatchRequest {
  project_dir: string;
  project_id: string;
  fingerprint: FileFingerprint;
  request_generation: number;
  asset_ids: string[];
}

export interface AssetPreviewBatchItem {
  asset_id: string;
  status: "ok" | "error" | "deferred";
  bytes_base64?: string;
  error?: { code: string; message: string };
}

export interface AssetPreviewBatchResult {
  project_id: string;
  fingerprint: FileFingerprint;
  request_generation: number;
  items: AssetPreviewBatchItem[];
}

export interface ExportFileResult {
  relative_path: string;
  mime_type: string;
  size: number;
  sha256: string;
  asset_id?: string;
  bytes?: Uint8Array;
  download_url?: string;
  path?: string;
}

export interface ExportResult {
  export_id?: string;
  files: ExportFileResult[];
  output_path?: string;
  warnings?: string[];
}

export interface DesktopBridge {
  readProject(): Promise<unknown | null>;
  openProjectState?(): Promise<ProjectReadState & { lease_generation: string }>;
  readProjectState?(): Promise<ProjectReadState>;
  writeProject(request: ProjectSaveRequest): Promise<ProjectSaveResult>;
  writeRecoveryJournal(journal: unknown): Promise<void>;
  readRecoveryJournal(): Promise<unknown | null>;
  clearRecoveryJournal(
    request: RecoveryJournalClearRequest,
  ): Promise<RecoveryJournalClearResult>;
  saveSession(
    session: PersistedWorkbenchSession,
    metadata?: {
      operation_id: string;
      session_generation: number;
      revision: number;
    },
  ): Promise<unknown>;
  loadSession(): Promise<PersistedWorkbenchSession | null>;
  openSession?(projectId: string): Promise<{
    session: PersistedWorkbenchSession | null;
    session_generation: number | null;
    revision: number;
  }>;
  commandWithMutationAck?(name: string, input?: unknown): Promise<{
    value: unknown;
    mutation_ack: CanonicalMutationAcknowledgement | null;
  }>;
  createSnapshot(input: SnapshotWriteRequest): Promise<SnapshotWriteResult>;
  listSnapshots(): Promise<SnapshotListResult>;
  restoreSnapshot?(
    snapshotId: string,
    request: SnapshotRestoreRequest,
  ): Promise<SnapshotRestoreResult>;
  readAssetBatch?(
    input: AssetPreviewBatchRequest,
  ): Promise<AssetPreviewBatchResult>;
}

/** Names exposed by the desktop bridge are intentionally high-level. */
export type BridgeCommandName =
  | "project.open"
  | "project.open_state"
  | "project.read_state"
  | "project.create"
  | "project.save"
  | "project.resolve"
  | "project.recovery.clear"
  | "import.preview"
  | "import.preview.release"
  | "import.confirm"
  | "asset.import"
  | "asset.rename"
  | "asset.preview_batch"
  | "folder.adopt"
  | "folder.append"
  | "course.seed.create"
  | "blueprint.build"
  | "snapshot.create"
  | "snapshot.list"
  | "snapshot.restore"
  | "export.run"
  | "export.release"
  | "publication.record"
  | "secret.set"
  | "secret.delete"
  | "connector.sync"
  | "ai.analyze"
  | "suggestion.apply"
  | "ai.connection.list"
  | "ai.connection.save"
  | "ai.connection.delete"
  | "ai.subscription.start"
  | "ai.subscription.status"
  | "ai.subscription.cancel"
  | "ai.subscription.logout"
  | "ai.models.list"
  | "ai.secret.set"
  | "ai.secret.delete"
  | "ai.complete"
  | "ai.cancel"
  | "ai.execution.append"
  | "ai.execution.list"
  | "resource.discovery.prepare"
  | "resource.providers.secret.set"
  | "resource.providers.secret.delete"
  | "resource.discovery.start"
  | "resource.discovery.cancel"
  | "resource.discovery.retry"
  | "resource.candidate.accept"
  | "presentation.style.extract"
  | "presentation.style.save"
  | "presentation.slide.propose"
  | "presentation.slide.prepare_ai_context"
  | "presentation.slide.preview"
  | "presentation.slide.export";

export type BridgeQueryName =
  | "project.get"
  | "course.tree"
  | "requirements.missing"
  | "assets.search"
  | "snapshots.list"
  | "jobs.list"
  | "connector.health"
  | "export.preflight"
  | "search.query"
  | "diagnostics.export"
  | "resource.providers.list"
  | "resource.discovery.plan"
  | "resource.discovery.get";

export type ResourceProviderId = "brave_search" | "youtube_data_api";
export type ResourceSearchType = "web" | "video";
export type ResourceTaskState =
  | "queued"
  | "running"
  | "partial"
  | "completed"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "stale"
  | "interrupted";

export interface ResourceProviderStatus {
  id: ResourceProviderId;
  capabilities: Array<"web_search" | "video_search" | "video_metadata">;
  credential_present: boolean;
}

export interface ResourceDiscoveryPreferences {
  per_lesson_limit: number;
  case_types?: string[];
  learner_level?: string;
  source_preference?: string[];
  language?: string;
  country?: string;
  published_after?: string | null;
  published_before?: string | null;
  target_min_sec?: number;
  target_max_sec?: number;
  wide_min_sec?: number;
  wide_max_sec?: number;
}

export interface ResourceDiscoveryPrepareInput {
  content_item_ids: string[];
  search_types: ResourceSearchType[];
  request_budget: number;
  preferences: ResourceDiscoveryPreferences;
}

export interface ResourceDiscoveryQueryPlan {
  lesson_id: string;
  need: string;
  existing_resource_ids: string[];
  source_locators: Array<{ block_id: string; section: string | null; paragraph: string | null }>;
  queries: Array<{
    kind: ResourceSearchType;
    query: string;
    request_budget_upper_bound: number;
  }>;
}

export interface ResourceDiscoveryPlan {
  plan_id: string;
  project_id: string;
  input_hash: string;
  snapshot: {
    project_id: string;
    generation: number;
    input_hash: string;
    lesson_revisions: Record<string, string>;
  };
  content_item_ids: string[];
  preferences: ResourceDiscoveryPreferences;
  queries: ResourceDiscoveryQueryPlan[];
  context_preview: {
    items: Array<{ content_item_id: string; title: string; excerpt: string }>;
    character_count: number;
  };
  budget: { max_requests: number; required_upper_bound: number };
  created_at: string;
  expires_at: string;
}

export interface ResourceCandidate {
  id: string;
  task_id: string;
  lesson_id: string;
  medium: "text" | "video";
  narrative_case_type: string | null;
  title: string;
  event_subject: string | null;
  event_date: string | null;
  published_at: string | null;
  publisher: string | null;
  url: string | null;
  fetched_at: string;
  factual_summary: string;
  claims: Array<{ text: string; evidence_ids: string[] }>;
  source_evidence: SourceEvidence[];
  video: ResourceItem["video"] | null;
  duration_class?: "target" | "wide" | "unknown";
  status: "pending" | "accepted" | "skipped" | "failed";
  accepted_resource_id?: string;
  limitations: string[];
}

export interface ResourceDiscoveryTask {
  task_id: string;
  state: ResourceTaskState;
  snapshot: ResourceDiscoveryPlan["snapshot"];
  plan_id: string;
  progress: { completed_queries: number; total_queries: number };
  budget: {
    max_requests: number;
    reserved_requests: number;
    completed_requests: number;
    remaining_requests: number;
  };
  candidates: ResourceCandidate[];
  errors: Array<{ code: string; message: string; query?: string }>;
  resource_recovery_warning?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResourceCandidateAcceptInput {
  task_id: string;
  candidate_id: string;
  lesson_id: string;
  existing_resource_id?: string;
  merge_confirmed?: boolean;
  manual_video_timing?: {
    start_sec: number;
    end_sec: number;
    confirmed: true;
  };
  teaching_use: string;
  discussion_questions: string[];
  video_selection?: ResourceUsage["video_selection"];
  action: "keep" | "insert_citation";
  block_id?: string | null;
}

export interface ResourceCandidateAcceptResult {
  resource: ResourceItem;
  evidence: SourceEvidence[];
  usage: ResourceUsage;
  block_id: string | null;
  candidate_id: string;
}

export interface PresentationStyleThemeColor {
  slot: string;
  value: string;
}
export interface PresentationStyleThemeFont {
  scheme: string;
  script: string;
  typeface: string;
}
export interface PresentationStylePlaceholder {
  placeholder_type: string;
  index: string | null;
  shape_name: string | null;
  inheritance_source: string;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
}
export interface PresentationStyleObject {
  kind: string;
  name: string | null;
  placeholder_type: string | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  fill: string | null;
  line: string | null;
  font_sizes_hundredth_pt: number[];
  text_run_count: number;
}
export interface PresentationRepresentativePreview {
  source_sha256: string;
  variant_id: string;
  slide_part: string;
  width_emu: number | null;
  height_emu: number | null;
  format: "svg";
  svg: string;
  limitations: string[];
}
export interface PresentationStyleTokens {
  slide_size_emu: { width: number | null; height: number | null };
  theme_colors: PresentationStyleThemeColor[];
  theme_fonts: PresentationStyleThemeFont[];
  placeholders: PresentationStylePlaceholder[];
  representative_objects: PresentationStyleObject[];
  editable_rules: PresentationStyleEditableRules;
}

export interface PresentationStyleEditableRule {
  font_size_hundredth_pt: number | null;
  color: string | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
}

export interface PresentationStyleEditableRules {
  title: PresentationStyleEditableRule;
  body: PresentationStyleEditableRule;
}
export interface PresentationStyleVariant {
  id: string;
  master_part: string;
  theme_part: string | null;
  layout_part: string;
  slide_parts: string[];
  representative_slide_part: string;
  theme_colors: PresentationStyleThemeColor[];
  theme_fonts: PresentationStyleThemeFont[];
  placeholders: PresentationStylePlaceholder[];
  representative_objects: PresentationStyleObject[];
}
export interface PresentationStyleExtractionReport {
  source_sha256: string;
  presentation_part: string;
  slide_count: number;
  ordered_slides: Array<{ slide_id: string; order: number; part: string }>;
  slide_width_emu: number | null;
  slide_height_emu: number | null;
  variants: PresentationStyleVariant[];
  representative_previews: PresentationRepresentativePreview[];
  extraction_facts: string[];
  limitations: string[];
}

export interface PresentationStyleExtractInput { source_asset_id: string; }
export interface PresentationStyleExtractResult {
  style_draft_id: string;
  source_asset_id: string;
  report: PresentationStyleExtractionReport;
  markdown_draft: string;
  visual_review_required: true;
}
export type PresentationStyleSaveInput =
  | { style_draft_id: string; variant_id: string; markdown: string }
  | {
    style_profile_id: string;
    expected_revision: number;
    markdown: string;
  };
export interface PresentationStyleSaveResult {
  style_profile: StyleProfile;
  presentation_document: PresentationDocument;
  parsed_tokens: {
    parser_version: string;
    parsed_from_hash: string;
    status: "valid" | "needs_review";
    limitations: string[];
  };
}
export interface PresentationSlideProposeInput {
  document_id: string;
  lesson_id: string;
  style_profile_id: string;
  style_revision: number;
  target_asset_id: string;
  insert_after_slide_id: string | null;
  instruction?: string;
  generation_source?: SlidePlanGenerationSource;
  spec: SlideSpec;
}
export interface PresentationSlidePrepareAiContextInput {
  document_id: string;
  lesson_id: string;
  style_profile_id: string;
  style_revision: number;
  target_asset_id: string;
  insert_after_slide_id: string | null;
  instruction: string;
  provider_id: string;
  model: string;
  generation_id: string;
  session_generation: number;
  editor_generation: number;
}
export interface PresentationSlidePrepareAiContextResult {
  generation_id: string;
  session_generation: number;
  editor_generation: number;
  project_id: string;
  document_id: string;
  lesson_id: string;
  lesson_snapshot_sha256: string;
  style_profile_id: string;
  style_revision: number;
  style_markdown_sha256: string;
  target_asset_id: string;
  target_asset_sha256: string;
  variant_id: string;
  insert_after_slide_id: string | null;
  insertion_order: number;
  provider_id: string;
  model: string;
  context_sha256: string;
  snapshot_binding_sha256: string;
  context: { system: string; user: string };
  allowed_source_ids: string[];
  allowed_image_asset_ids: string[];
}
export interface PresentationSlidePreviewInput {
  slide_plan_id: string;
  revision: number;
}

export interface PresentationSlidePreviewResult {
  slide_plan_id: string;
  revision: number;
  format: "svg";
  svg: string;
  limitations: string[];
}
export interface PresentationSlideExportInput extends PresentationSlidePreviewInput {
  output_mode: "single" | "append";
  approved: true;
}
export interface PresentationSlideExportResult {
  slide_plan: SlidePlan;
  output_asset_id: string;
  presentation_document: PresentationDocument;
  page_count: number;
  source_sha256: string;
  output_sha256: string;
  durability_warning?: string | null;
  validation: { status: "valid"; checks: string[] };
}

export interface BridgeCommandContracts {
  "resource.providers.secret.set": {
    input: { provider_id: ResourceProviderId; value: string };
    output: { provider_id: ResourceProviderId; credential_present: true };
  };
  "resource.providers.secret.delete": {
    input: { provider_id: ResourceProviderId };
    output: { provider_id: ResourceProviderId; credential_present: false };
  };
  "resource.discovery.prepare": {
    input: ResourceDiscoveryPrepareInput;
    output: ResourceDiscoveryPlan;
  };
  "resource.discovery.start": {
    input: { plan_id: string; input_hash: string; authorized: true };
    output: ResourceDiscoveryTask;
  };
  "resource.discovery.cancel": {
    input: { task_id: string };
    output: ResourceDiscoveryTask;
  };
  "resource.discovery.retry": {
    input: { task_id: string; candidate_id?: string };
    output: ResourceDiscoveryTask;
  };
  "resource.candidate.accept": {
    input: ResourceCandidateAcceptInput;
    output: ResourceCandidateAcceptResult;
  };
  "presentation.style.extract": {
    input: PresentationStyleExtractInput;
    output: PresentationStyleExtractResult;
  };
  "presentation.style.save": {
    input: PresentationStyleSaveInput;
    output: PresentationStyleSaveResult;
  };
  "presentation.slide.propose": {
    input: PresentationSlideProposeInput;
    output: SlidePlan;
  };
  "presentation.slide.prepare_ai_context": {
    input: PresentationSlidePrepareAiContextInput;
    output: PresentationSlidePrepareAiContextResult;
  };
  "presentation.slide.preview": {
    input: PresentationSlidePreviewInput;
    output: PresentationSlidePreviewResult;
  };
  "presentation.slide.export": {
    input: PresentationSlideExportInput;
    output: PresentationSlideExportResult;
  };
}

export interface BridgeQueryContracts {
  "resource.providers.list": { input: Record<string, never>; output: ResourceProviderStatus[] };
  "resource.discovery.plan": { input: { plan_id: string }; output: ResourceDiscoveryPlan | null };
  "resource.discovery.get": { input: { task_id: string }; output: ResourceDiscoveryTask | null };
}

export interface BridgeErrorObject {
  code: string;
  user_message: string;
  technical_message?: string;
  recoverable: boolean;
  recommended_action: string | null;
  details?: Record<string, unknown>;
}

export interface DesktopServiceContract {
  command<T = unknown>(name: BridgeCommandName, input?: unknown): Promise<T>;
  query<T = unknown>(name: BridgeQueryName, input?: unknown): Promise<T>;
}

export interface ImportPreviewContract {
  id: string;
  mode: "content" | "blueprint" | "asset" | "project";
  counts: Record<string, number>;
  duplicate_count: number;
  warnings: string[];
  errors: string[];
  requires_confirmation: true;
}

export interface ExportResultContract {
  files: Array<{ relative_path: string; mime_type: string; bytes: Uint8Array }>;
  preflight: ExportPreflight;
  target: string;
}

export interface GridDefinition {
  columns: number[];
  rows: number[];
}

export interface GridPlacement {
  block_id: string;
  row_start: number;
  row_end: number;
  column_start: number;
  column_end: number;
  section_id: string | null;
}

export interface ExportPreflight {
  content_gaps: number;
  layout_gaps: number;
  overflow: number;
  text_overflow: number;
  missing_fonts: number;
  total: number;
}
