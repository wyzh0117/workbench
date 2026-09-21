/**
 * Desktop boundary contracts.  The Web UI talks to this interface only;
 * filesystem, Git and secure storage stay behind the Tauri bridge.
 */

export type EditorMode = "writing" | "structure" | "layout" | "preview";
export type RightPanel =
  | "media"
  | "requirements"
  | "status"
  | "assistant"
  | "properties"
  | "versions";

export interface WorkbenchSession {
  project_id: string | null;
  active_content_item_id: string | null;
  mode: EditorMode;
  right_panel: RightPanel;
  left_collapsed: boolean;
  right_collapsed: boolean;
  tabs: Array<{
    content_item_id: string;
    mode: EditorMode;
    pinned: boolean;
    scroll_top: number;
  }>;
}

/** Native persistence keeps only the explicit project directory reference. */
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

export interface DesktopBridge {
  readProject(): Promise<unknown | null>;
  writeProject(project: unknown): Promise<void>;
  writeRecoveryJournal(journal: unknown): Promise<void>;
  readRecoveryJournal(): Promise<unknown | null>;
  saveSession(session: PersistedWorkbenchSession): Promise<void>;
  loadSession(): Promise<PersistedWorkbenchSession | null>;
  createSnapshot(input: {
    snapshot_id?: string;
    name: string;
    note: string;
    project: unknown;
  }): Promise<void>;
  restoreSnapshot?(
    snapshotId: string,
    projectId?: string,
  ): Promise<unknown | null>;
}

/** Names exposed by the desktop bridge are intentionally high-level. */
export type BridgeCommandName =
  | "project.open"
  | "project.create"
  | "project.save"
  | "import.preview"
  | "import.confirm"
  | "asset.import"
  | "snapshot.create"
  | "snapshot.restore"
  | "export.run"
  | "publication.record"
  | "secret.set"
  | "secret.delete"
  | "connector.sync"
  | "ai.analyze"
  | "suggestion.apply"
  | "ai.connection.list"
  | "ai.connection.save"
  | "ai.connection.delete"
  | "ai.secret.set"
  | "ai.secret.delete"
  | "ai.complete"
  | "ai.cancel"
  | "ai.execution.append"
  | "ai.execution.list";

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
  | "diagnostics.export";

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
