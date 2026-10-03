/**
 * Constants shared by the shell (`main.js`) and the view layer (`views.js`).
 *
 * They live in their own module so the view layer never has to import the
 * shell: a `main.js` ⇄ `views.js` cycle would instantiate the whole application
 * twice whenever the shell is loaded under a second specifier (tests import it
 * with a cache-busting query), and each instance would boot its own store,
 * listeners and autosave timers.
 */

/**
 * Hidden browser file input used when no native shell is present.  Kept in one
 * place so the native picker, drag & drop and MIME mapping stay a single
 * implementation.
 */
export const PROJECT_FILE_PICKER =
  `<input hidden multiple type="file" data-project-file accept=".json,.md,.markdown,.txt,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp4,.webm,.mov,.m4v,.mp3,.wav,.m4a,.aac,.ogg,.pdf,.doc,.docx,.zip" />`;

/**
 * §18 — the text/document formats the body-content dialog offers after the
 * Mapping Plan is confirmed.  Media (image / video) is deliberately absent: it
 * already auto-imports into the Media Library under §17 and must never appear
 * in this list.
 *
 * `src/service/folder_mapping.ts` keeps the typed twin of this list for the
 * browser/HTTP pipeline; `tests/document_import_dialog_test.ts` fails if the
 * two ever drift apart.
 */
export const DOCUMENT_IMPORT_EXTENSIONS = Object.freeze([
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".tex",
  ".latex",
  ".docx",
  ".epub",
  ".pdf",
]);

/** Chinese type label per §18.3 row metadata (`类型`). */
export const DOCUMENT_IMPORT_TYPE_LABELS = Object.freeze({
  ".txt": "TXT",
  ".text": "TXT",
  ".md": "Markdown",
  ".markdown": "Markdown",
  ".tex": "LaTeX",
  ".latex": "LaTeX",
  ".docx": "Word",
  ".epub": "EPUB",
  ".pdf": "PDF",
});

/** §28 — the only outcomes a shell may report for one document. */
export const DOCUMENT_IMPORT_OUTCOMES = Object.freeze([
  "succeeded",
  "degraded",
  "skipped",
  "failed",
]);

/** Chinese labels for the §28 tally and the per-file list. */
export const DOCUMENT_IMPORT_OUTCOME_LABELS = Object.freeze({
  succeeded: "成功",
  degraded: "降级",
  skipped: "跳过",
  failed: "失败",
});

/**
 * Lowercased extension of a relative path, or "" when the row has none.
 * A dot-leading name (".md") is a filename, not an extension.
 */
export function documentImportExtension(relativePath) {
  const name = String(relativePath ?? "").replaceAll("\\", "/").split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** The original relative directory of a row ("" when it sits at the root). */
export function documentImportDirectory(relativePath) {
  const path = String(relativePath ?? "").replaceAll("\\", "/");
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * §16 / §18 — one confirmed-plan row that the dialog may offer as body content.
 *
 * The role test is the narrowest it can be: `lesson` is the only mapping in a
 * confirmed plan that becomes 正文 in either shell, so the dialog never
 * re-infers a target (§19). Rows the mapping preview already marks unreadable
 * stay out — promising them here would be a lie the import cannot keep.
 */
export function isDocumentImportCandidate(item) {
  if (!item || typeof item !== "object") return false;
  if (item.kind !== "file") return false;
  if (item.selected !== true) return false;
  if (item.mapping !== "lesson") return false;
  if (item.error) return false;
  return DOCUMENT_IMPORT_EXTENSIONS.includes(documentImportExtension(item.relative_path));
}

/** Candidate rows of a plan, shallow-copied so the dialog cannot write through. */
export function collectDocumentImportCandidates(plan) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  return items.filter((item) => isDocumentImportCandidate(item)).map((item) => ({
    ...item,
    destination: item.destination ? { ...item.destination } : null,
  }));
}

/**
 * §18.2 — group candidates by their original relative directory.  `s01-00/` and
 * `s01-01/` stay separate groups; a root-level file groups under "".
 */
export function groupDocumentImportCandidates(items) {
  const buckets = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const directory = documentImportDirectory(item.relative_path);
    const bucket = buckets.get(directory);
    if (bucket) bucket.push(item);
    else buckets.set(directory, [item]);
  }
  const groups = [...buckets.entries()].map(([directory, rows]) => ({ directory, items: rows }));
  groups.sort((left, right) => {
    if (left.directory === right.directory) return 0;
    if (!left.directory) return -1;
    if (!right.directory) return 1;
    return left.directory < right.directory ? -1 : 1;
  });
  return groups;
}

/**
 * §19 / §31 — the dialog filters which already-mapped rows are sent and nothing
 * else: the deselected rows lose their `selected` flag, every other row is
 * forwarded verbatim (mapping, destination, duplicate acknowledgement), and the
 * plan stays confirmed.
 */
export function applyDocumentImportDeselection(plan, deselected) {
  const paths = new Set(
    (Array.isArray(deselected) ? deselected : [])
      .map((path) => String(path ?? "").replaceAll("\\", "/")),
  );
  const items = Array.isArray(plan?.items) ? plan.items : [];
  return {
    ...plan,
    items: items.map((item) => {
      const path = String(item?.relative_path ?? "").replaceAll("\\", "/");
      if (!paths.has(path) || !isDocumentImportCandidate(item)) return item;
      return { ...item, selected: false };
    }),
  };
}

/**
 * §28 — the document tally a shell returned with `folder.adopt` / `folder.append`.
 *
 * Absent, empty or foreign-shaped → `null`, so the caller keeps showing the
 * ordinary import-warning list instead of a panel of zeros.  Counts come from
 * the shell whenever it sent numbers; only when a count is missing are they
 * counted off the per-file rows it actually returned. Nothing is ever invented.
 */
export function normalizeDocumentImportReport(value) {
  const report = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!report) return null;
  const rows = Array.isArray(report.files) ? report.files : [];
  const files = rows
    .filter((file) =>
      file && typeof file === "object" && typeof file.relative_path === "string" && file.relative_path
    )
    .map((file) => {
      const outcome = DOCUMENT_IMPORT_OUTCOMES.includes(String(file.outcome))
        ? String(file.outcome)
        : "failed";
      return {
        relative_path: file.relative_path,
        outcome,
        outcome_label: DOCUMENT_IMPORT_OUTCOME_LABELS[outcome] || outcome,
        reason: typeof file.reason === "string" ? file.reason : "",
      };
    });
  const counts = {};
  let reported = false;
  for (const outcome of DOCUMENT_IMPORT_OUTCOMES) {
    const raw = Number(report[outcome]);
    if (Number.isFinite(raw) && raw >= 0) {
      counts[outcome] = Math.floor(raw);
      reported = true;
    } else {
      counts[outcome] = files.filter((file) => file.outcome === outcome).length;
    }
  }
  if (!files.length && !reported) return null;
  return { ...counts, total: files.length, files };
}

/**
 * The §28 headline, e.g. 成功 3 · 降级 1 · 跳过 2 · 失败 1.  Empty for no report.
 */
export function documentImportTallyText(report) {
  if (!report) return "";
  const parts = DOCUMENT_IMPORT_OUTCOMES.map(
    (outcome) => `${DOCUMENT_IMPORT_OUTCOME_LABELS[outcome]} ${report[outcome] || 0}`,
  );
  return parts.join(" · ");
}
