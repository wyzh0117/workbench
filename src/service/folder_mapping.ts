/**
 * V1-T04 import mapping plan (§§30–31, 34).
 *
 * Suggestions derived from ScanResult.suggested_role. Marked as 建议, not 事实.
 * Preview builds an editable plan; Confirm collects it. Neither writes Canonical
 * / project.json — call confirmFolderAdoption (folder.adopt) after confirm.
 */
import type { ScanKind, ScanResult, SuggestedRole } from "./folder_scan.ts";

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
  kind: ScanKind;
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
