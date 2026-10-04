/**
 * V1-T04 import mapping plan (§§30–31, 34).
 *
 * Suggestions derived from ScanResult.suggested_role. Marked as 建议, not 事实.
 * Preview builds an editable plan; Confirm collects it. Neither writes Canonical
 * / project.json — call confirmFolderAdoption (folder.adopt) after confirm.
 */
import { scanFolderDirectChildren } from "./folder_scan.ts";
import type {
  MediaDescendantKind,
  ScanKind,
  ScanResult,
  SuggestedRole,
} from "./folder_scan.ts";

/** User-editable mapping target for an import entry. */
export type MappingRole =
  | "stage"
  | "lesson"
  | "source"
  | "asset"
  | "reference"
  | "ignore";

export type ImportMappingDestination =
  | { kind: "unassigned_lesson" }
  | { kind: "existing_stage"; stage_id: string }
  | { kind: "existing_lesson"; content_item_id: string };

export type MarkdownImageDependencyStatus =
  | "present"
  | "missing"
  | "outside_root"
  | "remote_or_unsafe";

export interface MarkdownImageDependency {
  href: string;
  title: string | null;
  alt: string | null;
  tokenIndex: number;
  occurrence: number;
  blockIndex: number;
  status: MarkdownImageDependencyStatus;
}

export interface MarkdownDependencyPreview {
  state: "loading" | "ready" | "error";
  source_hash: string | null;
  fingerprint?: string;
  counts?: {
    total: number;
    local_readable: number;
    missing: number;
    outside_root: number;
    remote_or_unsafe: number;
  };
  images?: MarkdownImageDependency[];
  error?: string;
}

export interface MarkdownSourceMatch {
  state: "same_content" | "changed_source";
  content_item_id: string;
  title: string;
  source_path: string;
  previous_hash: string;
  target_deleted?: boolean;
}

export interface ImportMappingItem {
  relative_path: string;
  /**
   * `directory` rows come from the flat scan; `file` rows are direct children;
   * `image`/`video` rows come from `scanMediaDescendants` for a directory the
   * user selected explicitly.
   */
  kind: ScanKind | MediaDescendantKind;
  mime: string | null;
  size: number | null;
  /** Original ScanResult suggestion (advice only). */
  suggested: MappingRole;
  /** Current user choice (defaults to suggested). */
  mapping: MappingRole;
  /** Whether this entry is included in the import plan. */
  selected: boolean;
  /** Always true for rows born from scan suggestions. */
  is_suggestion: true;
  error?: string | null;
  destination?: ImportMappingDestination | null;
  /** Executor-only key for checked documents sharing a newly-created Lesson folder target. */
  folder_lesson_group?: string;
  /** Folder title used for the first successfully imported document in that group. */
  folder_lesson_title?: string;
  markdown_dependency_preview?: MarkdownDependencyPreview | null;
  markdown_source_match?: MarkdownSourceMatch | null;
  allow_duplicate?: boolean;
}

export interface ImportMappingPlan {
  root: string;
  items: ImportMappingItem[];
  /** Set only by confirmImportMappingPlan — never by preview builders. */
  confirmed: boolean;
  confirmed_at: string | null;
}

export interface FolderDocumentCandidateGroup {
  directory: string;
  mapping: "stage" | "lesson";
  destination: ImportMappingDestination | null;
  items: ImportMappingItem[];
}

export interface FolderDocumentCandidateScan {
  root: string;
  groups: FolderDocumentCandidateGroup[];
  warnings: string[];
  errors: string[];
}

const ROLE_LABELS: Record<MappingRole, string> = {
  stage: "阶段",
  lesson: "课文",
  source: "源资料",
  asset: "素材",
  reference: "参考",
  ignore: "忽略",
};

/** Map ScanResult.suggested_role → editable MappingRole. */
export function mappingRoleFromSuggested(role: SuggestedRole): MappingRole {
  switch (role) {
    case "stage":
      return "stage";
    case "lesson":
      return "lesson";
    case "asset":
      return "asset";
    case "reference":
      return "reference";
    case "folder":
    case "unsupported":
    default:
      return "ignore";
  }
}

/**
 * §18 — the text/document formats that may become lesson body content once the
 * Mapping Plan is confirmed. Media is absent on purpose: images and videos
 * already auto-import into the Media Library under §17.
 *
 * `app/constants.js` carries the shell-side twin of this list; the dialog test
 * asserts the two stay identical.
 */
export const DOCUMENT_IMPORT_EXTENSIONS: readonly string[] = [
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".tex",
  ".latex",
  ".docx",
  ".epub",
  ".pdf",
];

/**
 * Read only immediate supported document files in selected stage/lesson folders.
 * The selected Mapping row supplies the child semantics; this scan never infers
 * a second target from child names or deeper directory structure.
 */
export async function scanFolderDocuments(
  root: string,
  plan: ImportMappingPlan,
): Promise<FolderDocumentCandidateScan> {
  if (!plan || plan.confirmed !== true) {
    throw new Error("只能读取已确认映射计划中的文档候选");
  }
  const requestedRoot = String(root || "").trim();
  if (!requestedRoot || requestedRoot !== String(plan.root || "").trim()) {
    throw new Error("文档扫描路径必须与已确认映射计划的源文件夹一致");
  }
  const parents = plan.items.filter((item): item is ImportMappingItem & { mapping: "stage" | "lesson" } =>
    item?.kind === "directory" && item.selected === true && !item.error &&
    (item.mapping === "stage" || item.mapping === "lesson")
  );
  const scan = await scanFolderDirectChildren(
    requestedRoot,
    parents.map((item) => item.relative_path),
  );
  const byDirectory = new Map(parents.map((item) => [item.relative_path, item]));
  const groups: FolderDocumentCandidateGroup[] = [];
  for (const scanned of scan.groups) {
    const parent = byDirectory.get(scanned.directory);
    if (!parent) continue;
    const destination = parent.mapping === "lesson" && parent.destination
      ? { ...parent.destination }
      : null;
    const items = scanned.entries
      .filter((entry) =>
        (DOCUMENT_IMPORT_EXTENSIONS as readonly string[]).includes(
          documentImportExtension(entry.relative_path),
        )
      )
      .map((entry): ImportMappingItem => ({
        relative_path: entry.relative_path,
        kind: "file",
        mime: entry.mime,
        size: entry.size,
        suggested: "lesson",
        mapping: "lesson",
        selected: !entry.error,
        is_suggestion: true,
        error: entry.error ?? null,
        destination: destination ? { ...destination } : null,
        markdown_dependency_preview: null,
        markdown_source_match: null,
        allow_duplicate: false,
      }));
    groups.push({
      directory: scanned.directory,
      mapping: parent.mapping,
      destination: destination ? { ...destination } : null,
      items,
    });
  }
  return {
    root: scan.root,
    groups,
    warnings: scan.warnings,
    errors: scan.errors,
  };
}

/** §28 — the only outcomes one document import may report. */
export type DocumentImportOutcome = "succeeded" | "degraded" | "skipped" | "failed";

export const DOCUMENT_IMPORT_OUTCOMES: readonly DocumentImportOutcome[] = [
  "succeeded",
  "degraded",
  "skipped",
  "failed",
];

/** §28 — one row of the per-file import list. `reason` is display copy. */
export interface DocumentImportFile {
  relative_path: string;
  outcome: DocumentImportOutcome;
  reason: string;
}

/** §28 — the tally plus the per-file list a shell returns with an import. */
export interface DocumentImportReport {
  succeeded: number;
  degraded: number;
  skipped: number;
  failed: number;
  files: DocumentImportFile[];
}

/** Lowercased extension of a relative path, or "" when the row has none. */
export function documentImportExtension(relativePath: string): string {
  const name = String(relativePath ?? "").replaceAll("\\", "/").split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** The original relative directory of a row ("" when it sits at the root). */
export function documentImportDirectory(relativePath: string): string {
  const path = String(relativePath ?? "").replaceAll("\\", "/");
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * §16 / §18 — a confirmed-plan row the body dialog may offer.
 *
 * `lesson` is the only mapping that becomes 正文 in either shell, so the dialog
 * re-infers nothing (§19); media rows and rows the preview cannot read stay out.
 */
export function isDocumentImportCandidate(item: ImportMappingItem | undefined): boolean {
  if (!item) return false;
  if (item.kind !== "file") return false;
  if (item.selected !== true) return false;
  if (item.mapping !== "lesson") return false;
  if (item.error) return false;
  return (DOCUMENT_IMPORT_EXTENSIONS as readonly string[]).includes(
    documentImportExtension(item.relative_path),
  );
}

/** Candidate rows of a plan, copied so the dialog cannot write through. */
export function collectDocumentImportCandidates(
  plan: ImportMappingPlan | null | undefined,
): ImportMappingItem[] {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  return items
    .filter((item) => isDocumentImportCandidate(item))
    .map((item) => ({
      ...item,
      destination: item.destination ? { ...item.destination } : null,
    }));
}

/** §18.2 — candidates grouped by their original relative directory, never flat. */
export interface DocumentImportGroup {
  directory: string;
  items: ImportMappingItem[];
}

export function groupDocumentImportCandidates(
  items: readonly ImportMappingItem[],
): DocumentImportGroup[] {
  const buckets = new Map<string, ImportMappingItem[]>();
  for (const item of items) {
    const directory = documentImportDirectory(item.relative_path);
    const bucket = buckets.get(directory);
    if (bucket) bucket.push(item);
    else buckets.set(directory, [item]);
  }
  return [...buckets.entries()]
    .map(([directory, rows]) => ({ directory, items: rows }))
    .sort((left, right) => {
      if (left.directory === right.directory) return 0;
      if (!left.directory) return -1;
      if (!right.directory) return 1;
      return left.directory < right.directory ? -1 : 1;
    });
}

/**
 * §19 / §31 — apply the dialog's answer to a confirmed plan.
 *
 * Deselected candidates lose their `selected` flag and are therefore not sent;
 * every other row — mapping, destination, duplicate acknowledgement — is
 * forwarded verbatim and the plan stays confirmed. Only rows the dialog could
 * have shown are writable here: an arbitrary path cannot switch off a stage.
 */
export function applyDocumentImportDeselection(
  plan: ImportMappingPlan,
  deselected: readonly string[],
): ImportMappingPlan {
  const paths = new Set(
    (Array.isArray(deselected) ? deselected : [])
      .map((path) => String(path ?? "").replaceAll("\\", "/")),
  );
  const next = clonePlan(plan);
  for (const item of next.items) {
    if (!paths.has(item.relative_path)) continue;
    if (!isDocumentImportCandidate(item)) continue;
    item.selected = false;
  }
  return next;
}

/** Count a report's own rows, so a shell that sends only `files` is still honest. */
export function documentImportReportFromFiles(
  files: readonly DocumentImportFile[],
): DocumentImportReport {
  const counts: Record<DocumentImportOutcome, number> = {
    succeeded: 0,
    degraded: 0,
    skipped: 0,
    failed: 0,
  };
  for (const file of files) counts[file.outcome] += 1;
  return { ...counts, files: files.map((file) => ({ ...file })) };
}

/**
 * Chinese label for a mapping role.
 * Pass `{ suggestion: true }` to prefix 建议 (advice, not fact).
 */
export function mappingRoleLabel(
  role: MappingRole,
  options: { suggestion?: boolean } = {},
): string {
  const base = ROLE_LABELS[role] || role;
  return options.suggestion ? `建议${base}` : base;
}

function clonePlan(plan: ImportMappingPlan): ImportMappingPlan {
  return {
    root: plan.root,
    confirmed: plan.confirmed,
    confirmed_at: plan.confirmed_at,
    items: plan.items.map((item) => ({
      ...item,
      destination: item.destination ? { ...item.destination } : null,
      markdown_dependency_preview: item.markdown_dependency_preview
        ? {
          ...item.markdown_dependency_preview,
          counts: item.markdown_dependency_preview.counts
            ? { ...item.markdown_dependency_preview.counts }
            : undefined,
          images: item.markdown_dependency_preview.images?.map((image) => ({ ...image })),
        }
        : null,
      markdown_source_match: item.markdown_source_match
        ? { ...item.markdown_source_match }
        : null,
    })),
  };
}

/**
 * Build an editable mapping preview from a read-only ScanResult list.
 * Does not confirm and does not touch the filesystem or Canonical.
 */
export function buildImportMappingPlan(
  root: string,
  entries: ScanResult[],
): ImportMappingPlan {
  const items: ImportMappingItem[] = (Array.isArray(entries) ? entries : [])
    .map((entry): ImportMappingItem => {
      const suggested = mappingRoleFromSuggested(entry.suggested_role);
      const hasError = Boolean(entry.error);
      const selected = !hasError && suggested !== "ignore";
      const kind: ScanKind = entry.kind === "directory" ? "directory" : "file";
      return {
        relative_path: String(entry.relative_path || "").replaceAll("\\", "/"),
        kind,
        mime: entry.mime ?? null,
        size: entry.size ?? null,
        suggested,
        mapping: suggested,
        selected,
        is_suggestion: true,
        error: entry.error ?? null,
        destination: suggested === "lesson" ? { kind: "unassigned_lesson" } : null,
        markdown_dependency_preview: null,
        markdown_source_match: null,
        allow_duplicate: false,
      };
    })
    .filter((item) => item.relative_path.length > 0);
  for (const item of items) {
    if (item.mapping !== "lesson") continue;
    const hasMappedStageParent = items.some((candidate) =>
      candidate.kind === "directory" && candidate.selected && candidate.mapping === "stage" &&
      item.relative_path.startsWith(`${candidate.relative_path}/`)
    );
    item.destination = hasMappedStageParent ? null : { kind: "unassigned_lesson" };
  }

  return {
    root: String(root || ""),
    items,
    confirmed: false,
    confirmed_at: null,
  };
}

/** Toggle whether an entry is included. Does not confirm. */
export function setImportMappingSelected(
  plan: ImportMappingPlan,
  relativePath: string,
  selected: boolean,
): ImportMappingPlan {
  const path = String(relativePath || "").replaceAll("\\", "/");
  const next = clonePlan(plan);
  next.confirmed = false;
  next.confirmed_at = null;
  for (const item of next.items) {
    if (item.relative_path === path) {
      item.selected = Boolean(selected);
      if (item.selected && item.mapping === "lesson" && /\.(md|markdown)$/i.test(item.relative_path)) {
        item.markdown_dependency_preview = null;
        item.markdown_source_match = null;
        item.allow_duplicate = false;
      }
      break;
    }
  }
  return next;
}

/** Change the mapping role for one entry. Does not confirm. */
export function setImportMappingRole(
  plan: ImportMappingPlan,
  relativePath: string,
  role: MappingRole,
): ImportMappingPlan {
  const path = String(relativePath || "").replaceAll("\\", "/");
  const allowed: MappingRole[] = [
    "stage",
    "lesson",
    "source",
    "asset",
    "reference",
    "ignore",
  ];
  const mapping = allowed.includes(role) ? role : "ignore";
  const next = clonePlan(plan);
  next.confirmed = false;
  next.confirmed_at = null;
  for (const item of next.items) {
    if (item.relative_path === path) {
      item.mapping = mapping;
      if (mapping === "ignore") item.selected = false;
      else if (!item.selected) item.selected = true;
      if (mapping === "lesson") {
        const hasMappedStageParent = next.items.some((candidate) =>
          candidate.kind === "directory" && candidate.selected && candidate.mapping === "stage" &&
          item.relative_path.startsWith(`${candidate.relative_path}/`)
        );
        item.destination = hasMappedStageParent ? null : (item.destination || { kind: "unassigned_lesson" });
      } else {
        item.destination = null;
        item.markdown_dependency_preview = null;
        item.markdown_source_match = null;
        item.allow_duplicate = false;
      }
      break;
    }
  }
  return next;
}

/** Assign an explicit destination to a lesson row; persistence validates the target. */
export function setImportMappingDestination(
  plan: ImportMappingPlan,
  relativePath: string,
  destination: ImportMappingDestination | null | { kind: "folder_structure" },
): ImportMappingPlan {
  const path = String(relativePath || "").replaceAll("\\", "/");
  const next = clonePlan(plan);
  next.confirmed = false;
  next.confirmed_at = null;
  for (const item of next.items) {
    if (item.relative_path === path && item.mapping === "lesson") {
      item.destination = destination?.kind === "folder_structure"
        ? null
        : destination
        ? { ...destination }
        : null;
      break;
    }
  }
  return next;
}

/** Explicitly acknowledge importing a Markdown source match as a new copy. */
export function setImportMappingAllowDuplicate(
  plan: ImportMappingPlan,
  relativePath: string,
  allow: boolean,
): ImportMappingPlan {
  const path = String(relativePath || "").replaceAll("\\", "/");
  const next = clonePlan(plan);
  next.confirmed = false;
  next.confirmed_at = null;
  for (const item of next.items) {
    if (item.relative_path === path && item.mapping === "lesson") {
      item.allow_duplicate = Boolean(allow);
      break;
    }
  }
  return next;
}

/**
 * Collect the current plan as user-confirmed.
 * Does not write project.json / Canonical — apply via confirmFolderAdoption.
 */
export function confirmImportMappingPlan(
  plan: ImportMappingPlan,
): ImportMappingPlan {
  const next = clonePlan(plan);
  next.confirmed = true;
  next.confirmed_at = new Date().toISOString();
  return next;
}
