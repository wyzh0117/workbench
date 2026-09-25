/**
 * V1-T04 import mapping plan (§§30–31, 34).
 *
 * Suggestions derived from ScanResult.suggested_role. Marked as 建议, not 事实.
 * Preview builds an editable plan; Confirm collects it. Neither writes Canonical
 * / project.json — adoption apply is Task 12.
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
    items: plan.items.map((item) => ({ ...item })),
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
      };
    })
    .filter((item) => item.relative_path.length > 0);

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
      break;
    }
  }
  return next;
}

/**
 * Collect the current plan as user-confirmed.
 * Does not write project.json / Canonical (Task 12).
 */
export function confirmImportMappingPlan(
  plan: ImportMappingPlan,
): ImportMappingPlan {
  const next = clonePlan(plan);
  next.confirmed = true;
  next.confirmed_at = new Date().toISOString();
  return next;
}
