// deno-fmt-ignore-file
/*
 * Dependency-free desktop-first renderer.
 *
 * In a Tauri build, DesktopBridge forwards every persistence operation to
 * Rust commands. The browser build uses the same high-level command API
 * through the local Deno service, so canonical state never lives in UI code.
 * Components only mutate WorkbenchStore; they never call fs, Git, or secrets.
 */

import {
  PROJECT_FILE_PICKER,
  applyDocumentImportDeselection,
  collectDocumentImportCandidates,
  documentImportTallyText,
  normalizeDocumentImportReport,
} from "./constants.js";
import {
  caretTextOffset,
  compileInlineAtCaret,
  editorValueChangedSinceBaseline,
  focusTextOffset,
  markdownFromEditable,
  structuralConversion,
} from "./markdown.js";
import { parseMarkdown } from "./markdown.js";
import { createSerialQueue, recoveryWarning } from "./recovery.js";
import { createPersistenceScheduler, createSessionScheduler, normalizeProjectDir } from "./persistence.js";
import {
  MEDIA_BLOCK_TYPES,
  REQUIREMENT_TYPES,
  SEED_TEXT_SOURCES,
  assetUsedElsewhere,
  blockLabel,
  blockSizeTierForLines,
  blocksFor,
  courseMap,
  freeCellsFor,
  lessonView,
  placementsFor,
  requirementBacklog,
  resumeLessonId,
  statusOptionId,
  textOf,
  usagesForAsset,
} from "./authoring.js";
import {
  AssetPreviewCache,
  buildImportMappingPlan,
  confirmImportMappingPlan,
  decodeVideoFrame,
  esc,
  explorerPreviewKind,
  explorerUrlForBytes,
  loadImage,
  mappingRowClickToggles,
  staticImagePoster,
  stopPreviewMedia,
  setImportMappingRole as applyImportMappingRole,
  setImportMappingAllowDuplicate as applyImportMappingAllowDuplicate,
  setImportMappingDestination as applyImportMappingDestination,
  setImportMappingSelected as applyImportMappingSelected,
} from "./canvas.js";
import { createViews } from "./views.js";
import {
  addLayoutPage as addLayoutPageData,
  convertSectionsToPages as convertSectionsToPagesData,
  deleteLayoutPage as deleteLayoutPageData,
  duplicateLayoutPage as duplicateLayoutPageData,
  movePlacementToPage as movePlacementToPageData,
  reorderLayoutPage as reorderLayoutPageData,
  renameLayoutPage as renameLayoutPageData,
  setLayoutPageSize as setLayoutPageSizeData,
} from "./layout_pages.js";
import {
  buildPublicationProjection,
  fitPageRect,
  getAvailablePublicationAdapters,
  getLayoutPages,
  getPublicationCapabilities,
  PAGE_SIZE_PRESETS,
  pageGrid,
  projectPageGeometry,
  resolvePageSize,
} from "./publication.js";
import {
  AI_FAILURE_CODES,
  AiFailure,
  FakeAiConnector,
  HttpAiConnector,
  AI_OFFLINE_PROVIDER_ID,
  aiApiProtocolChoices,
  aiDiscoveredModelIds,
  aiIsKnownApiProtocol,
  aiIsOfflineConnection,
  applyAiChangeDraft,
  assembleAiContext,
  buildAiExecutionRecord,
  createAiChangeDraft,
  createAiSuggestion,
  rejectAiChangeDraft,
  validateAiChangeDraft,
} from "./ai.js";

const SESSION_KEY = "ai-course-workbench.session";
let cancelActivePointerDrag = null;
const SESSION_READER_KEYS = [
  "active_content_item_id",
  "mode",
  "right_panel",
  "route",
  "selected_block_id",
  "layout_page_id",
  "layout_zoom",
  "ai_scope",
  "ai_provider_id",
  "ai_model",
  "left_collapsed",
  "right_collapsed",
  "collapsed_stage_ids",
  "tabs",
  // V1-T04 Explorer chrome (§39) — workspace/session only, never Canonical.
  "explorer_filter",
  "explorer_expanded",
  "explorer_recent",
];

/** Cap persisted explorer path lists so session sidecars stay small. */
function normalizeExplorerPathList(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const path = item.trim();
    if (!path || path.length > 1024 || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= limit) break;
  }
  return out;
}
/** High-level commands that must carry the selected project directory. */
const NATIVE_PROJECT_COMMANDS = new Set([
  "project.open",
  "project.open_state",
  "project.read_state",
  "project.lease_status",
  "project.create",
  "project.save",
  "project.external.inspect",
  "project.reload",
  "project.merge",
  "project.resolve",
  "folder.append",
  "import.preview",
  "import.confirm",
  "course.seed.create",
  "blueprint.build",
  "asset.import",
  "asset.rename",
  "asset.read",
  "asset.preview_batch",
  "asset.preview_source",
  "snapshot.list",
  "snapshot.create",
  "snapshot.restore",
  "import.preview.release",
  "export.preflight",
  "export.run",
  "publication.record",
]);
const PROJECT_STATE_COMMANDS = new Set([
  "asset.import",
  "asset.rename",
  "folder.append",
  "publication.record",
]);
const clone = (value) => structuredClone(value);
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function oneShotMediaRelease(url) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    void fetch(url, { method: "DELETE" }).catch(() => {});
  };
}
const nextRevision = (previous) => {
  const previousMs = Date.parse(previous || "");
  const currentMs = Date.now();
  return new Date(Math.max(currentMs, Number.isFinite(previousMs) ? previousMs + 1 : currentMs)).toISOString();
};
/**
 * §4 — the application-level project registry.
 *
 * These four commands are app-global and rebuildable, so — unlike
 * `NATIVE_PROJECT_COMMANDS` — they must never receive the injected
 * `projectDir`, and the shell takes them as one `input: Value` struct (the
 * browser service receives the same payload flat through `/api/command`).
 * A row carries only identity, location, title and last-opened hints: never
 * course content, never a credential.
 */
const REGISTRY_COMMANDS = new Set([
  "registry.list",
  "registry.record",
  "registry.remove",
  "registry.relocate",
]);
/** The §4.1 record, exactly. Anything else is not a registry row. */
const REGISTRY_ROW_FIELDS = [
  "project_id",
  "project_path",
  "project_title",
  "last_opened_at",
  "last_content_item_id",
];
/**
 * Build the payload for `registry.record` from what the caller already knows.
 * Written as an explicit whitelist so a future caller cannot smuggle a course
 * body, a token or a whole `project.json` into the app-level file.
 */
function registryRecordPayload(value = {}) {
  const candidate = value && typeof value === "object" ? value : {};
  const row = {
    project_id: String(candidate.project_id ?? candidate.projectId ?? "").trim(),
    project_path: String(candidate.project_path ?? candidate.projectPath ?? "").trim(),
    project_title: String(candidate.project_title ?? candidate.projectTitle ?? "").trim(),
  };
  const position = String(
    candidate.last_content_item_id ?? candidate.lastContentItemId ?? "",
  ).trim();
  if (position) row.last_content_item_id = position;
  if (candidate.allow_second_copy === true || candidate.allowSecondCopy === true) {
    row.allow_second_copy = true;
  }
  return row;
}
/** Newest first, id as a stable tiebreak — the same order both shells return. */
function sortRegistryRows(rows = []) {
  const key = (row) => `${String(row?.last_opened_at || "")}\u0000${String(row?.project_id || "")}`;
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object" && row.project_id)
    .slice()
    .sort((left, right) => (key(left) < key(right) ? 1 : key(left) > key(right) ? -1 : 0));
}
const parseNativeValue = (value) => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
};
const nativePath = (value) => {
  const candidate = parseNativeValue(value);
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  if (Array.isArray(candidate)) return nativePath(candidate[0]);
  if (!candidate || typeof candidate !== "object") return null;
  for (const key of ["path", "file_path", "folder_path", "project_dir", "projectDir", "selected_path", "output_path", "outputPath", "input"]) {
    const path = nativePath(candidate[key]);
    if (path) return path;
  }
  if (Array.isArray(candidate.files)) return nativePath(candidate.files[0]);
  if (candidate.cancelled || candidate.canceled) return null;
  return nativePath(candidate.value);
};
const pathParts = (value) => {
  const path = String(value || "").replaceAll("\\", "/");
  const slash = path.lastIndexOf("/");
  const outputDir = slash < 0 ? "." : path.slice(0, slash) || "/";
  return { output_dir: slash === 2 && path[1] === ":" ? `${outputDir}/` : outputDir, filename: slash >= 0 ? path.slice(slash + 1) : path };
};
const filenameFromPath = (value) => pathParts(value).filename || "导入文件";
const mimeForFilename = (filename) => ({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav",
  md: "text/markdown", markdown: "text/markdown", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}[String(filename).split(".").pop()?.toLowerCase()] || "application/octet-stream");
const assetTypeForFile = (filename, mime = "") => {
  const lower = String(filename).toLowerCase();
  if (/\.gif$/.test(lower)) return "gif";
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/.test(lower)) return "image";
  if (mime.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/.test(lower)) return "video";
  if (mime.startsWith("audio/") || /\.(mp3|wav|m4a|aac)$/.test(lower)) return "audio";
  if (/\.(md|markdown)$/.test(lower) || mime === "text/markdown") return "document";
  return "other";
};
const isAssetFile = (filename, mime = "") => mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/") || /\.(gif|png|jpe?g|webp|svg|mp4|webm|mov|m4v|mp3|wav|m4a|aac|pdf|docx|md|markdown)$/i.test(filename);
/**
 * A batch member counts as imported only when it added a row.  The native
 * shell answers with an explicit `duplicate`; the browser service can reuse an
 * asset row without saying so, so fall back to the row count.
 */
const batchLandedAsset = (result, rowsGrew) => {
  const payload = parseNativeValue(result);
  const flag = payload?.duplicate ?? payload?.value?.duplicate;
  return typeof flag === "boolean" ? flag === false : rowsGrew;
};
/** One toast per batch: what already landed stays visible next to failures. */
function assetBatchToast(batch, landed, warning = "") {
  const parts = [`${landed} ${batch.imported} 个素材`];
  if (batch.duplicate) parts.push(`${batch.duplicate} 个已按 checksum 复用`);
  if (batch.captured) parts.push(`${batch.captured} 个内容放进收件箱`);
  if (batch.skipped) parts.push(`${batch.skipped} 个重复或不适用条目已跳过`);
  if (batch.failed) {
    const reasons = batch.failures.slice(0, 2).join("；");
    parts.push(`${batch.failed} 个失败${reasons ? `：${reasons}` : ""}${batch.failures.length > 2 ? `；另有 ${batch.failures.length - 2} 个` : ""}`);
  }
  const text = parts.join("；");
  return warning ? `${text}；${warning}` : text;
}

/**
 * Statuses the shell's folder classifier can return (`project.inspect`, and the
 * diagnosis payload `project.open` sends instead of course data).
 */
const PROJECT_INSPECTION_STATUSES = new Set([
  "valid",
  "migratable",
  "invalid",
  "no_project_json",
  "malformed_json",
  "unreadable",
]);

/**
 * A canonical project never carries a top-level `status`, so an open result that
 * does is the shell's diagnosis of the folder rather than course data.  Reading
 * that diagnosis is what stops a folder with a broken `project.json` from being
 * reported as if the file were missing.
 */
function projectInspection(value) {
  if (!value || typeof value !== "object") return null;
  if (!PROJECT_INSPECTION_STATUSES.has(value.status)) return null;
  return {
    status: value.status,
    schema_version: value.schema_version ?? null,
    supported_schema_version: value.supported_schema_version ?? null,
    problem: value.problem && typeof value.problem === "object" ? value.problem : null,
  };
}

/** §3.2 Case C copy: the detected category, then the first actionable failure. */
function projectProblemText(problem) {
  const detail = String(problem?.message || "").trim();
  if (problem?.code === "unsupported_schema") {
    return "检测到 project.json，但它由更高版本的 Workbench 创建，当前版本不会改写它。";
  }
  return detail
    ? `检测到 project.json，但项目数据无法通过校验：${detail}`
    : "检测到 project.json，但项目数据无法通过校验。";
}

/**
 * User-facing copy for a folder that cannot be opened as a project.
 *
 * `hints.diagnosis` is the shell's inspection status and wins over the string
 * matching below: guessing from an error's wording is exactly what used to tell
 * the user "没有找到有效的 project.json" about a folder that does contain one.
 * `hints.problemCode` refines that further, because a schema from a newer
 * Workbench needs "upgrade", not "your data is invalid".  With no diagnosis at
 * all the copy stays honest about what is unknown (§3.4).
 */
const describeProjectOpenFailure = (error, hints = {}) => {
  const raw = String(error?.message || error || "").trim();
  const context = `${String(error?.code || "")} ${raw}`.toLowerCase();
  const diagnosis = String(hints.diagnosis || "").trim();
  const problemCode = String(hints.problemCode || "").trim();
  const invalidJson = Boolean(
    diagnosis === "malformed_json" ||
    (!diagnosis && (hints.invalidJson || /项目 json 无效|json 无效/.test(context))),
  );
  // A newer schema is its own answer: "invalid data" would send the user off to
  // fix a file that is fine, and "missing" would be flatly wrong.
  const tooNew = !invalidJson && Boolean(
    problemCode === "unsupported_schema" ||
    diagnosis === "unsupported_schema" ||
    (!diagnosis && /更高版本|unsupported_schema/.test(context)),
  );
  const notObject = !tooNew && Boolean(
    diagnosis === "invalid" ||
    (!diagnosis && (
      hints.notObject ||
      /必须是 json 对象|可识别的课程|缺少 content_items|缺少 blocks/.test(context)
    )),
  );
  const missingJson = Boolean(
    diagnosis === "no_project_json" ||
    (!diagnosis && hints.missingJson && !invalidJson && !notObject),
  );
  const unreadable = Boolean(
    diagnosis === "unreadable" ||
    (!diagnosis && /项目目录不存在|无法读取|permission denied/.test(context)),
  );

  let why;
  let missing;
  if (invalidJson) {
    why = "这个文件夹里有 project.json，但它已损坏或无效，无法作为 AI Course Workbench 项目打开。";
    missing = raw ? `project.json 无法解析：${raw}` : "project.json 无法解析。";
  } else if (tooNew) {
    why = "这个 project.json 由更高版本的 Workbench 创建，当前版本还不能安全地打开它。";
    missing = raw || "文件的 schema_version 超出了当前版本支持的范围。";
  } else if (notObject) {
    why = "这个文件夹里有 project.json，但其中的课程数据没有通过校验。";
    missing = raw || "project.json 存在，但不是可识别的课程项目结构（需要 project、content_items、blocks）。";
  } else if (missingJson) {
    why = "这个文件夹还没有 project.json，因此它还不是 Workbench 项目；它可以作为资料文件夹导入。";
    missing = "所选文件夹根目录中没有 project.json。";
  } else if (unreadable) {
    why = "无法读取这个文件夹里的项目文件。";
    missing = raw || "project.json 无法读取（文件夹可能被移动、删除或没有访问权限）。";
  } else {
    why = "这次没有打开成功，课程文件没有被修改。";
    missing = raw || "打开过程被中断，暂时无法确认这个文件夹的内容。";
  }

  const actions = missingJson
    ? [
        "• 直接把它作为资料文件夹导入（现在就会开始扫描，不会写入任何文件）；",
        "• 或选择其他 Workbench 项目；",
        "• 或新建课程。",
      ]
    : [
        "• 查看具体问题后返回；",
        "• 或把它作为普通资料文件夹重新导入（不会覆盖现有 project.json，除非你确认）；",
        "• 或选择其他 Workbench 项目、新建课程。",
      ];

  return [why, "", missing, "", "你可以：", ...actions].join("\n");
};

/** Keep technical bridge failures out of ordinary toasts. */
const userFacingError = (error, fallback) => {
  const raw = String(error?.message || error || "").trim();
  const context = `${String(error?.code || "")} ${raw}`.toLowerCase();
  if ((error?.commit_state ?? error?.details?.commit_state) === "outcome_uncertain") {
    return "文件操作结果暂时无法确认。请重新读取项目状态后再继续写入。";
  }
  if (/project_(?:not_open|lock_lost|lock_not_owned|locked)|项目已被占用|项目编辑锁|锁/.test(context)) {
    return "这个项目正在其他窗口或进程中使用。为避免覆盖，当前操作没有写入；课程内容没有改变，请关闭其他窗口后重试。";
  }
  if (/external_modification_conflict|外部修改|外部项目文件|磁盘版本/.test(context)) {
    return "课程文件在其他地方发生了变化，保存已暂停以免覆盖内容。你仍可继续查看，请重新载入、自动合并，或明确保留本地版本。";
  }
  // Pass through copy that already spells out why and what to do next.
  if (raw.includes("你可以：") && raw.includes("\n")) return raw;
  if (
    /project\.json|可识别的课程|project data|项目文件|项目目录不存在|项目 json 无效|必须是 json 对象|不是可用的课程项目/.test(
      context,
    )
  ) {
    return describeProjectOpenFailure(error, {
      missingJson: /没有 project\.json|项目目录不存在|不是可用的课程项目/.test(context) &&
        !/项目 json 无效|必须是 json 对象|可识别的课程/.test(context),
      invalidJson: /项目 json 无效|json 无效/.test(context),
      notObject: /必须是 json 对象|可识别的课程/.test(context),
    });
  }
  if (/session|会话|阅读位置/.test(context)) {
    return "上次阅读位置没有保存，但课程内容没有受影响。你可以继续使用，稍后再试。";
  }
  if (/工作台服务不可用|service unavailable|服务暂时不可用/.test(context)) {
    return "工作台服务暂时不可用。课程内容没有改变，请重新启动后再试。";
  }
  if (/permission denied|access denied|eacces|权限不足|没有权限/.test(context)) {
    return "工作台没有权限完成这项操作。课程内容没有改变，请检查项目目录权限后重试。";
  }
  if (!raw || /^操作未完成(?:，|。|$)/.test(raw)) return fallback;
  // English exception text, error codes, paths and stack fragments are useful
  // in diagnostics but not as the primary action a user sees in a toast.
  if (/^(?:[A-Za-z][A-Za-z0-9_.-]*(?::|\s|$)|Error\b|Exception\b)|(?:[\\/]|\bat\s+|ENOENT|EISDIR|EINVAL)/.test(raw)) {
    // Native parse errors often append English "at line…" after a Chinese prefix.
    if (/项目 json 无效|project\.json/.test(context)) {
      return describeProjectOpenFailure(error, { invalidJson: /json 无效/.test(context) });
    }
    return fallback;
  }
  return raw;
};

/**
 * §28 — the body-import line for the import toast.
 *
 * A batch where one file failed must not read as if nothing happened, and must
 * not read as if the whole import failed either: the tally says how many came in
 * and the names say which did not. No report, no line — the ordinary warning
 * copy already on the toast stands on its own.
 */
const documentImportToastText = (report) => {
  if (!report) return "";
  const notImported = (Array.isArray(report.files) ? report.files : []).filter(
    (file) => file?.outcome === "failed" || file?.outcome === "skipped",
  );
  const names = notImported.slice(0, 2).map((file) => String(file.relative_path || "")).filter(Boolean);
  const tail = notImported.length > names.length ? ` 等 ${notImported.length} 个文件` : "";
  const detail = notImported.length
    ? `；未进入正文：${names.join("、")}${tail}`
    : "";
  return ` 正文导入：${documentImportTallyText(report)}${detail}。`;
};

const STATUS = {
  content: ["待研究", "起草中", "待审核", "已定稿"],
  media: ["未开始", "制作中", "待审核", "已完成"],
  layout: ["未开始", "排版中", "待检查", "已完成"],
  review: ["未审核", "审核中", "通过", "需修改"],
  publish: ["未发布", "待发布", "已发布"],
  update: ["最新", "建议更新", "必须更新"],
};
const NAV = [
  ["overview", "项目概览", "⌂"],
  ["map", "课程地图", "▦"],
  ["workbench", "工作台", "✎"],
  ["explorer", "文件", "📂"],
  ["inbox", "收件箱", "↓"],
  ["board", "制作看板", "▤"],
  ["media", "媒体库", "◈"],
  ["backlog", "待补总览", "!="],
  ["updates", "更新中心", "✦"],
  ["publish", "发布中心", "↗"],
  ["versions", "版本历史", "◷"],
  ["settings", "项目设置", "⚙"],
];

class DesktopBridge {
  constructor() {
    this.memory = {};
    this.apiBase = "/api";
    this.projectDir = null;
    this.projectDirFromUrl = false;
    try {
      const candidate = new URL(globalThis.location?.href || "http://localhost/")
        .searchParams.get("project_dir");
      this.projectDir = candidate && candidate.trim() ? candidate : null;
      this.projectDirFromUrl = Boolean(this.projectDir);
    } catch {
      this.projectDir = null;
    }
  }
  isNative() { return Boolean(globalThis.__TAURI__?.core?.invoke); }
  setProjectDir(value) {
    const projectDir = String(value ?? "");
    if (!projectDir.trim()) throw new Error("请先选择项目文件夹");
    this.projectDir = projectDir;
    this.projectDirFromUrl = false;
    return projectDir;
  }
  restoreProjectDir(value, fromUrl = false, openedState = null) {
    this.projectDir = value || null;
    this.projectDirFromUrl = Boolean(value && fromUrl);
    const projectDir = normalizeProjectDir(this.projectDir);
    this.lastOpenedProjectState = openedState &&
        normalizeProjectDir(openedState.project_dir) === projectDir
      ? { ...openedState, project_dir: projectDir }
      : null;
  }
  requireProjectDir() {
    if (!this.projectDir) throw new Error("请先选择项目文件夹");
    return this.projectDir;
  }
  nativeInput(command, args = {}) {
    const input = args && typeof args === "object" ? args : {};
    if (!this.isNative()) return args;
    if (command === "folder.scan_documents") return input;
    if (command === "folder.adopt") {
      const {
        document_paths: documentPaths = [],
        replace_invalid_project: replaceInvalidProject,
        editor_generation: editorGeneration,
        operation_id: operationId,
        revision,
        ...rest
      } = input;
      return {
        ...rest,
        documentPaths,
        ...(replaceInvalidProject === undefined ? {} : { replaceInvalidProject }),
        ...(editorGeneration === undefined ? {} : { editorGeneration }),
        ...(operationId === undefined ? {} : { operationId }),
        ...(revision === undefined ? {} : { revision }),
      };
    }
    if (command === "folder.append") {
      const {
        duplicate_choice: duplicateChoice,
        document_paths: documentPaths = [],
        project_dir: _projectDir,
        expected_project_id: expectedProjectId,
        expected_fingerprint: expectedFingerprint,
        lease_generation: leaseGeneration,
        editor_generation: editorGeneration,
        operation_id: operationId,
        revision,
        ...rest
      } = input;
      return {
        ...rest,
        projectDir: this.requireProjectDir(),
        documentPaths,
        ...(duplicateChoice === undefined ? {} : { duplicateChoice }),
        ...(expectedProjectId === undefined ? {} : { expectedProjectId }),
        ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
        ...(leaseGeneration === undefined ? {} : { leaseGeneration }),
        ...(editorGeneration === undefined ? {} : { editorGeneration }),
        ...(operationId === undefined ? {} : { operationId }),
        ...(revision === undefined ? {} : { revision }),
      };
    }
    if (!NATIVE_PROJECT_COMMANDS.has(command)) return args;
    const projectDir = this.requireProjectDir();
    if (command === "project.resolve") {
      return {
        projectDir,
        project: input.project,
        expectedCurrent: input.expected_current,
        ...(Object.hasOwn(input, "expected_project_id") ? { expectedProjectId: input.expected_project_id } : {}),
        ...(Object.hasOwn(input, "expected_fingerprint") ? { expectedFingerprint: input.expected_fingerprint } : {}),
        ...(Object.hasOwn(input, "lease_generation") ? { leaseGeneration: input.lease_generation } : {}),
        ...(Object.hasOwn(input, "editor_generation") ? { editorGeneration: input.editor_generation } : {}),
        ...(Object.hasOwn(input, "operation_id") ? { operationId: input.operation_id } : {}),
        ...(Object.hasOwn(input, "revision") ? { revision: input.revision } : {}),
      };
    }
    if (command === "project.save") {
      return {
        projectDir,
        project: input.project,
        expectedFingerprint: input.expected_fingerprint,
        ...(Object.hasOwn(input, "recovery_metadata") ? { recoveryMetadata: input.recovery_metadata } : {}),
        ...(Object.hasOwn(input, "recovery_journal") ? { recoveryJournal: input.recovery_journal } : {}),
        ...(Object.hasOwn(input, "expected_project_id") ? { expectedProjectId: input.expected_project_id } : {}),
        ...(Object.hasOwn(input, "lease_generation") ? { leaseGeneration: input.lease_generation } : {}),
        ...(Object.hasOwn(input, "editor_generation") ? { editorGeneration: input.editor_generation } : {}),
        ...(Object.hasOwn(input, "operation_id") ? { operationId: input.operation_id } : {}),
        ...(Object.hasOwn(input, "revision") ? { revision: input.revision } : {}),
      };
    }
    if (command === "snapshot.create") {
      return {
        projectDir,
        name: input.name,
        note: input.note,
        project: input.project,
        ...(Object.hasOwn(input, "snapshot_id") ? { snapshotId: input.snapshot_id } : {}),
        ...(Object.hasOwn(input, "expected_project_id") ? { expectedProjectId: input.expected_project_id } : {}),
        ...(Object.hasOwn(input, "lease_generation") ? { leaseGeneration: input.lease_generation } : {}),
        ...(Object.hasOwn(input, "editor_generation") ? { editorGeneration: input.editor_generation } : {}),
        ...(Object.hasOwn(input, "operation_id") ? { operationId: input.operation_id } : {}),
        ...(Object.hasOwn(input, "revision") ? { revision: input.revision } : {}),
      };
    }
    if (command === "snapshot.restore") {
      return {
        projectDir,
        snapshotId: input.snapshot_id,
        ...(Object.hasOwn(input, "expected_fingerprint") ? { expectedFingerprint: input.expected_fingerprint } : {}),
        ...(Object.hasOwn(input, "expected_project_id") ? { expectedProjectId: input.expected_project_id } : {}),
        ...(Object.hasOwn(input, "lease_generation") ? { leaseGeneration: input.lease_generation } : {}),
        ...(Object.hasOwn(input, "editor_generation") ? { editorGeneration: input.editor_generation } : {}),
        ...(Object.hasOwn(input, "operation_id") ? { operationId: input.operation_id } : {}),
        ...(Object.hasOwn(input, "revision") ? { revision: input.revision } : {}),
      };
    }
    if (["project.open", "project.open_state", "project.read_state", "project.lease_status", "project.create", "project.external.inspect", "project.reload", "project.merge", "snapshot.list"].includes(command)) {
      return { ...input, projectDir };
    }
    if (command === "export.run" || command === "export.preflight") {
      const preset = input.preset || {};
      return {
        ...input,
        preset: {
          ...preset,
          project_dir: projectDir,
          output_dir: preset.output_dir || projectDir,
        },
      };
    }
    if (command === "import.preview") return { source: { ...input, project_dir: projectDir } };
    if (command === "import.confirm") {
      const preview = input.preview && typeof input.preview === "object" ? input.preview : input;
      return { preview: { ...preview, project_dir: projectDir } };
    }
    // These commands take one `input: Value` struct, so the whole payload is
    // nested; sending bare keys makes the shell reject the call outright.
    if (
      [
        "asset.import",
        "asset.read",
        "asset.preview_batch",
        "asset.rename",
        "asset.preview_source",
        "publication.record",
        "course.seed.create",
        "blueprint.build",
      ].includes(command)
    ) {
      return { input: { ...input, project_dir: projectDir } };
    }
    if (command === "import.preview.release") {
      return { input: { preview_id: input.preview_id, project_dir: projectDir } };
    }
    return { ...input, project_dir: projectDir };
  }
  bridgeError(value, fallback = "工作台操作失败") {
    let payload = value;
    if (value instanceof Error && typeof value.message === "string") payload = value.message;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        const raw = payload;
        if (raw.startsWith("keychain_unavailable:")) {
          payload = {
            error: {
              code: "keychain_unavailable",
              user_message: "无法访问 macOS 系统钥匙串。课程内容没有改动，请检查系统钥匙串后重试。",
              technical_message: raw,
              recommended_action: "确认系统钥匙串可用后重试；课程内容不会因此改变。",
              details: {},
            },
          };
        } else {
          payload = { error: { user_message: raw } };
        }
      }
    }
    const detail = payload?.error || payload;
    const details = detail?.details && typeof detail.details === "object"
      ? detail.details
      : {};
    const nested = (key) => Object.hasOwn(detail || {}, key) ? detail[key] : details[key];
    const failure = new Error(detail?.user_message || detail?.message || fallback);
    failure.code = detail?.code || "bridge_request_failed";
    failure.details = details;
    failure.commit_state = nested("commit_state") ?? null;
    failure.stage = nested("stage") ?? null;
    failure.retryable = nested("retryable") === true;
    for (const key of ["fingerprint", "expected_committed_fingerprint", "operation_id", "revision"]) {
      const field = nested(key);
      if (field !== undefined) failure[key] = field;
    }
    failure.recoverable = detail?.recoverable !== false;
    // Both shells send a `recommended_action` (`src/ui/contracts.ts`
    // `BridgeErrorObject`, Rust `structured_ai_error`).  Dropping it here would
    // leave `app/ai.js#mapTransportError` with only its generic per-code
    // default, so the panel could not tell the user what to do next.
    failure.recommended_action = typeof detail?.recommended_action === "string"
      ? detail.recommended_action
      : null;
    return failure;
  }
  /**
   * Call a native command and normalise its failure.
   *
   * A bare `invoke` rejects with the raw shell payload, which is usually a
   * plain string.  Without this wrapper `error.message` is empty and a failed
   * write reaches the user as "保存失败" with no reason at all.
   */
  async nativeInvoke(command, args) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (!invoke) return null;
    try {
      return this.decodeBytes(await invoke(command, args));
    } catch (error) {
      throw this.bridgeError(error, "工作台操作失败");
    }
  }
  async invoke(command, args) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    // A missing `__TAURI__` means no native shell, so the request goes to the
    // service instead.  A successful Tauri command may legitimately resolve to
    // `null`, and that must never be mistaken for "no native shell": the guard
    // is the presence of `invoke`, not the shape of its result.
    if (invoke) {
      try {
        return this.decodeBytes(await invoke(this.nativeCommand(command), this.nativeInput(command, args)));
      } catch (error) {
        throw this.bridgeError(error, "工作台操作失败");
      }
    }
    if (typeof fetch !== "function") throw new Error("工作台服务暂时不可用。课程内容没有改变，请重新启动后再试。");
    const response = await fetch(`${this.apiBase}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: command, input: args ?? {} }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw this.bridgeError(payload, "工作台操作失败");
    return this.decodeBytes(payload.value);
  }
  async commandWithMutationAck(name, input = {}) {
    let raw;
    if (this.isNative()) {
      raw = await this.nativeInvoke(this.nativeCommand(name), this.nativeInput(name, input));
    } else {
      if (typeof fetch !== "function") throw new Error("工作台服务暂时不可用。课程内容没有改变，请重新启动后再试。");
      const response = await fetch(`${this.apiBase}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, input: input ?? {} }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw this.bridgeError(payload, "工作台操作失败");
      raw = payload;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { value: this.decodeBytes(raw), mutation_ack: null };
    }
    const mutation_ack = Object.hasOwn(raw, "mutation_ack")
      ? this.decodeBytes(raw.mutation_ack)
      : null;
    if (Object.hasOwn(raw, "value")) {
      return { value: this.decodeBytes(raw.value), mutation_ack };
    }
    const value = { ...raw };
    delete value.mutation_ack;
    delete value.execution_id;
    return { value: this.decodeBytes(value), mutation_ack };
  }
  async query(name, input = {}) {
    if (this.isNative()) return await this.invoke(name, input);
    if (typeof fetch !== "function") throw new Error("工作台服务暂时不可用。课程内容没有改变，请重新启动后再试。");
    const response = await fetch(`${this.apiBase}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, input }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw this.bridgeError(payload, "工作台查询失败");
    return this.decodeBytes(payload.value);
  }
  nativeCommand(command) {
    return {
      "project.open": "project_open",
      "project.open_state": "project_open_state",
      "project.read_state": "project_read_state",
      "project.lease_status": "project_lease_status",
      "project.inspect": "project_inspect",
      // §4 app-level registry: no `projectDir` injection, `input: Value` struct.
      "registry.list": "registry_list",
      "registry.record": "registry_record",
      "registry.remove": "registry_remove",
      "registry.relocate": "registry_relocate",
      "project.create": "project_create",
      "project.save": "project_save",
      "project.external.inspect": "project_external_status",
      "project.reload": "project_reload",
      "project.merge": "project_merge",
      "project.resolve": "project_resolve",
      "import.preview": "import_preview",
      "import.confirm": "import_confirm",
      "folder.scan": "folder_scan",
      "folder.scan_documents": "folder_scan_documents",
      "folder.read_preview": "folder_read_preview",
      "folder.preview_source": "folder_preview_source",
      "folder.read_source": "folder_read_source",
      "folder.markdown_image_status": "folder_markdown_image_status",
      "folder.adopt": "folder_adopt_with_documents",
      "folder.append": "folder_append_with_documents",
      "course.seed.create": "course_seed_create",
      "blueprint.build": "blueprint_build",
      "asset.import": "asset_import",
      "asset.rename": "asset_rename",
      "asset.read": "asset_read",
      "asset.preview_batch": "asset_preview_batch",
      "asset.preview_source": "asset_preview_source",
      "snapshot.list": "list_snapshots",
      "snapshot.create": "create_snapshot",
      "snapshot.restore": "restore_snapshot",
      "export.preflight": "export_preflight",
      "export.run": "export_run",
      "export.reveal": "reveal_export_path",
      "publication.record": "publication_record",
      "secret.set": "secret_set",
      "secret.delete": "secret_delete",
      "connector.sync": "connector_sync",
      "ai.analyze": "ai_analyze",
      "suggestion.apply": "suggestion_apply",
      // AI workflow commands.  They resolve their own storage (the provider /
      // execution files under the shell's AI directory: app-global in the
      // desktop shell, the project's `.workspace/ai` in the browser shell), so
      // none of them is in NATIVE_PROJECT_COMMANDS: the shell must not inject
      // `projectDir`.
      "ai.connection.list": "ai_connection_list",
      "ai.connection.save": "ai_connection_save",
      "ai.connection.delete": "ai_connection_delete",
      "ai.secret.set": "ai_secret_set",
      "ai.secret.delete": "ai_secret_delete",
      "ai.complete": "ai_complete",
      "ai.models.list": "ai_models_list",
      "ai.models.probe": "ai_models_probe",
      "ai.connection.test": "ai_connection_test",
      "ai.subscription.start": "ai_subscription_start",
      "ai.subscription.status": "ai_subscription_status",
      "ai.subscription.cancel": "ai_subscription_cancel",
      "ai.subscription.logout": "ai_subscription_logout",
      "ai.cancel": "ai_cancel",
      "ai.execution.append": "ai_execution_append",
      "ai.execution.list": "ai_execution_list",
    }[command] || command;
  }
  async selectFolder() {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (!invoke) return null;
    return nativePath(await this.invokePicker(invoke, "select_folder", {}));
  }
  async selectFile() {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (!invoke) return null;
    return nativePath(await this.invokePicker(invoke, "select_file", {}));
  }
  async selectFiles() {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (!invoke) return [];
    const result = parseNativeValue(await this.invokePicker(invoke, "select_files", {}));
    if (Array.isArray(result)) return result.map(nativePath).filter(Boolean);
    if (result?.status === "selected" && Array.isArray(result.paths)) {
      return result.paths.map(nativePath).filter(Boolean);
    }
    return [];
  }
  /** `project.open` for the directory currently selected on this bridge. */
  async openProject() {
    const state = await this.openProjectState();
    return state && Object.hasOwn(state, "project") ? state.project : state;
  }
  async selectExportPath(filename, format) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (!invoke) return null;
    const result = await this.invokePicker(invoke, "select_export_path", {
      defaultName: filename,
      filename,
      format,
      projectDir: this.projectDir,
      project_dir: this.projectDir,
    });
    return nativePath(result);
  }
  async invokePicker(invoke, command, input) {
    try {
      return await invoke(command, { input });
    } catch (error) {
      const message = String(error?.message || error || "").toLowerCase();
      if (!/(argument|input|deserialize|missing|invalid)/.test(message)) throw error;
      return await invoke(command, input);
    }
  }
  async clearRecoveryJournal(binding) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) {
      if (
        !binding || !this.projectDir ||
        normalizeProjectDir(binding.project_dir) !== normalizeProjectDir(this.projectDir)
      ) throw new Error("恢复日志清理请求没有绑定当前课程目录。");
      return await this.nativeInvoke("clear_recovery_journal", {
        projectDir: binding.project_dir,
        expectedProjectId: binding.expected_project_id,
        leaseGeneration: binding.lease_generation,
        editorGeneration: binding.editor_generation,
        operationId: binding.operation_id,
        revision: binding.revision,
        expectedFingerprint: binding.expected_fingerprint,
        expectedTransactionId: binding.expected_transaction_id,
      });
    }
    if (!binding) throw new Error("恢复日志清理请求缺少课程身份绑定。");
    return await this.invoke("project.recovery.clear", binding);
  }
  async listenNativeDrops(onPaths) {
    if (!this.isNative()) return () => {};
    const handleDrop = (event) => {
      const payload = event?.payload ?? event;
      if (payload?.type && payload.type !== "drop") return;
      const paths = Array.isArray(payload) ? payload : payload?.paths || payload?.files || [];
      const normalized = paths.map((path) => typeof path === "string" ? path : path?.path).filter(Boolean);
      if (normalized.length) onPaths(normalized);
    };
    const getCurrentWindow = globalThis.__TAURI__?.window?.getCurrentWindow;
    if (typeof getCurrentWindow === "function") {
      try {
        const currentWindow = getCurrentWindow();
        if (typeof currentWindow?.onDragDropEvent === "function") {
          return await currentWindow.onDragDropEvent(handleDrop);
        }
      } catch {
        // Older Tauri shells may only expose the global drag-drop event.
      }
    }
    const listen = globalThis.__TAURI__?.event?.listen;
    if (typeof listen !== "function") return () => {};
    return await listen("tauri://drag-drop", handleDrop);
  }
  decodeBytes(value) {
    if (Array.isArray(value)) return value.map((child) => this.decodeBytes(child));
    if (value instanceof Uint8Array) return value;
    if (!value || typeof value !== "object") return value;
    if (typeof value.__bytes_base64 === "string") {
      const binary = atob(value.__bytes_base64);
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, this.decodeBytes(child)]));
  }
  async command(name, input = {}) {
    if (REGISTRY_COMMANDS.has(name)) {
      const candidate = input && typeof input === "object" ? input : {};
      if (name === "registry.list") return await this.invoke(name, {});
      // `registry_record` / `_remove` / `_relocate` read one `input: Value`
      // struct in the native shell; the browser service takes the same payload
      // flat, so only the native transport wraps it.
      const payload = name === "registry.relocate"
        ? {
          project_id: String(candidate.project_id ?? candidate.projectId ?? "").trim(),
          new_path: String(candidate.new_path ?? candidate.newPath ?? "").trim(),
        }
        : registryRecordPayload(candidate);
      return await this.invoke(name, this.isNative() ? { input: payload } : payload);
    }
    if (this.isNative() && name === "project.create") {
      const candidate = input && typeof input === "object" ? input : {};
      if (candidate.project_dir || candidate.projectDir) this.setProjectDir(candidate.project_dir || candidate.projectDir);
      const project = blankProject(candidate.title || "未命名课程");
      let created = false;
      try {
        await this.invoke("project.create", { project });
        created = true;
        // Session persistence belongs to WorkbenchStore's transition commit.
        // Writing only the directory here used to pair a newly created target
        // with whichever reader state happened to be in memory.
        return project;
      } catch (error) {
        if (created) await this.closeProject().catch(() => {});
        throw error;
      }
    }
    const result = await this.invoke(name, input);
    if (PROJECT_STATE_COMMANDS.has(name) && result && typeof result === "object") {
      const state = await this.readProjectState();
      return { ...result, project_state: state };
    }
    return result;
  }
  async readProject() {
    const state = await this.readProjectState();
    return state?.project ?? null;
  }
  async readProjectState() {
    const value = await this.invoke("project.read_state", {});
    if (
      value && typeof value === "object" &&
      Object.hasOwn(value, "project") && Object.hasOwn(value, "fingerprint")
    ) return this.bindActiveLease(value);
    return {
      project: value ?? null,
      fingerprint: value == null ? { exists: false, mtime_ms: null, size: null, hash: null } : null,
      project_id: value?.project?.id ?? null,
      lease_generation: null,
    };
  }
  async openProjectState() {
    const requestedProjectDir = normalizeProjectDir(this.projectDir);
    const value = await this.invoke("project.open_state", {});
    if (
      value && typeof value === "object" && value.project &&
      typeof value.project_id === "string" && value.project_id &&
      (typeof value.lease_generation === "string" || Number.isSafeInteger(value.lease_generation))
    ) {
      const projectDir = normalizeProjectDir(value.project_dir ?? requestedProjectDir);
      if (normalizeProjectDir(this.projectDir) !== requestedProjectDir) return value;
      if (projectDir) {
        this.projectDir = projectDir;
        this.projectDirFromUrl = false;
      }
      this.lastOpenedProjectState = { ...value, project_dir: projectDir };
      return value;
    }
    if (normalizeProjectDir(this.projectDir) === requestedProjectDir) {
      this.lastOpenedProjectState = null;
    }
    return value;
  }
  bindActiveLease(state) {
    const opened = this.lastOpenedProjectState;
    const projectDir = normalizeProjectDir(state?.project_dir ?? this.projectDir);
    if (
      opened && opened.project_dir === projectDir &&
      normalizeProjectDir(this.projectDir) === projectDir
    ) return { ...state, project_dir: projectDir, lease_generation: opened.lease_generation };
    return {
      ...state,
      project_dir: projectDir,
      lease_generation: state?.lease_generation ?? null,
    };
  }
  async releaseImportPreview(previewId) {
    if (!previewId || this.isNative()) return { released: false };
    return await this.invoke("import.preview.release", { preview_id: previewId });
  }
  async readAssetBatch(request) {
    const result = await this.invoke("asset.preview_batch", request);
    if (!result || !Array.isArray(result.items)) throw new Error("素材批量预览返回格式无效");
    return result;
  }
  /**
   * Read one referenced asset's bytes for an in-workbench preview.
   * `maxBytes` mirrors the caller's preview ceiling: the native command already
   * refuses anything past its own 8 MiB limit, and the dev-server route has no
   * server-side gate at all, so the bound is enforced here instead.
   */
  async readAssetBytes(assetId, maxBytes = 0) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) {
      const result = await this.invoke("asset.read", { asset_id: assetId });
      const bytes = result && result.bytes_base64
        ? result.bytes_base64
        : result;
      if (bytes instanceof Uint8Array) return bytes;
      if (typeof bytes === "string") {
        const binary = atob(bytes);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
      }
      return new Uint8Array();
    }
    return await this.readAssetBytesFromDevServer(assetId, maxBytes);
  }
  async readAssetBytesFromDevServer(assetId, maxBytes = 0) {
    // The dev server already owns one project root, so no path is sent: the
    // bridge resolves the asset id against the open project itself.
    const response = await fetch(`${this.apiBase}/asset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asset_id: assetId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw this.bridgeError(payload, "素材不可读");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (maxBytes > 0 && bytes.length > maxBytes) {
      throw new Error(
        `素材超过单文件预览上限（${Math.max(1, Math.round(maxBytes / (1024 * 1024)))} MiB）`,
      );
    }
    return bytes;
  }
  async previewAssetVideoSource(assetId) {
    if (this.isNative()) {
      const path = await this.invoke("asset.preview_source", { asset_id: assetId });
      const convertFileSrc = globalThis.__TAURI__?.core?.convertFileSrc;
      if (typeof convertFileSrc !== "function") throw new Error("当前桌面壳不支持受控视频预览");
      return { url: convertFileSrc(path), release: () => {} };
    }
    const response = await fetch(`${this.apiBase}/media-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asset_id: assetId }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw this.bridgeError(payload, "视频不可读");
    const url = new URL(payload.url, globalThis.location?.href || "http://localhost/").href;
    return { url, release: oneShotMediaRelease(url) };
  }
  async previewFolderVideoSource(root, relativePath) {
    if (this.isNative()) {
      const path = await this.invoke("folder.preview_source", {
        root,
        relativePath,
      });
      const convertFileSrc = globalThis.__TAURI__?.core?.convertFileSrc;
      if (typeof convertFileSrc !== "function") throw new Error("当前桌面壳不支持受控视频预览");
      return { url: convertFileSrc(path), release: () => {} };
    }
    const response = await fetch(`${this.apiBase}/media-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, relative_path: relativePath }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw this.bridgeError(payload, "视频不可读");
    const url = new URL(payload.url, globalThis.location?.href || "http://localhost/").href;
    return { url, release: oneShotMediaRelease(url) };
  }
  async exportProject(format, project, preset, outputPath = "", contentItemId = null, options = {}) {
    const { export_id, ...exportOptions } = options;
    const nextPreset = { ...(preset || { name: format, output_type: format, platform: "通用", page_mode: "single", settings: {} }) };
    if (contentItemId) nextPreset.content_item_id = contentItemId;
    if (outputPath) {
      const parts = pathParts(outputPath);
      nextPreset.filename = parts.filename;
      nextPreset.output_dir = parts.output_dir;
      nextPreset.output_path = outputPath;
    }
    return await this.invoke("export.run", {
      ...(export_id ? { export_id } : {}),
      preset: nextPreset,
      options: { ...exportOptions, content_item_id: contentItemId || null },
    });
  }
  async revealExport(path) {
    if (!this.isNative()) throw new Error("浏览器下载的文件请在下载目录查看。");
    return await this.invoke("export.reveal", { path });
  }
  async writeProject(request, expectedFingerprint, recoveryJournal = null) {
    const input = request && Object.hasOwn(request, "expected_fingerprint")
      ? request
      : { project: request, expected_fingerprint: expectedFingerprint, recovery_journal: recoveryJournal };
    return await this.invoke("project.save", input);
  }
  /**
   * The canonical id of the project currently on disk, or null when it cannot
   * be read.  The store compares it before every write so a project silently
   * replaced on disk is never overwritten under the wrong identity.
   */
  async projectIdentity() {
    const project = await this.readProject();
    return project && typeof project.project?.id === "string"
      ? project.project.id
      : null;
  }
  async inspectExternalModification(project) {
    return await this.invoke("project.external.inspect", { project });
  }
  async reloadExternalProject() {
    const result = await this.invoke("project.reload", {});
    return result?.project && result?.fingerprint
      ? result
      : await this.readProjectState();
  }
  async mergeExternalProject(project) {
    return await this.invoke("project.merge", { project });
  }
  async resolveExternalProject(project, expectedCurrent) {
    await this.invoke("project.resolve", { project, expected_current: expectedCurrent });
    return await this.readProjectState();
  }
  async closeProject(projectDir = this.projectDir) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (!invoke || !projectDir) return;
    await this.nativeInvoke("project_close", { projectDir, project_dir: projectDir });
  }
  async confirmClose() {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) await this.nativeInvoke("confirm_close", {});
  }
  async writeRecoveryJournal(journal) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) {
      await this.nativeInvoke("write_recovery_journal", {
        projectDir: this.requireProjectDir(),
        contents: JSON.stringify(journal),
      });
    }
  }
  async readRecoveryJournal() {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    return invoke
      ? await this.nativeInvoke("read_recovery_journal", { projectDir: this.requireProjectDir() })
      : null;
  }
  async openSession(projectId) {
    if (this.isNative()) {
      return { session: await this.loadSession(), session_generation: null, revision: 0 };
    }
    if (typeof globalThis.fetch !== "function") {
      return { session: this.memory[SESSION_KEY] || null, session_generation: 0, revision: 0 };
    }
    const response = await globalThis.fetch(`${this.apiBase}/session/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw this.bridgeError(payload, "无法建立阅读位置保存通道");
    const state = payload.value;
    if (
      !state || typeof state !== "object" ||
      !Number.isSafeInteger(state.session_generation) || state.session_generation < 1 ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      (state.session !== null && (!state.session || typeof state.session !== "object" || state.session.project_id !== projectId))
    ) throw new Error("阅读位置保存通道返回了无效的版本信息");
    return state;
  }
  async saveSession(session, metadata = {}) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) {
      const requested = session && typeof session === "object" ? session : {};
      const requestedDir = typeof requested.project_dir === "string" && requested.project_dir.trim()
        ? requested.project_dir.trim()
        : null;
      const currentDir = this.projectDir || null;
      if (requestedDir && currentDir && requestedDir !== currentDir) {
        throw new Error("项目会话目录与当前项目不一致");
      }
      const payload = { ...requested, project_dir: requestedDir || currentDir };
      if (payload.project_dir && !payload.project_id) {
        throw new Error("项目会话缺少项目标识");
      }
      if (!payload.project_dir && payload.project_id) {
        throw new Error("项目会话缺少项目目录");
      }
      return await this.nativeInvoke("save_session", {
        session: payload,
        ...(metadata.operation_id ? { operationId: metadata.operation_id } : {}),
        ...(metadata.session_generation !== undefined ? { sessionGeneration: metadata.session_generation } : {}),
        ...(metadata.revision !== undefined ? { revision: metadata.revision } : {}),
      });
    }
    if (typeof globalThis.fetch !== "function") {
      this.memory[SESSION_KEY] = clone(session);
      return;
    }
    const response = await globalThis.fetch(`${this.apiBase}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        session: session && typeof session === "object" ? session : {},
        ...metadata,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw this.bridgeError(payload, "无法记录上次阅读位置");
    return payload.value ?? null;
  }
  async loadSession() {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) {
      const session = await this.nativeInvoke("load_session", {});
      const projectDir = session && typeof session.project_dir === "string"
        ? session.project_dir
        : null;
      // Rust returns the canonical --project-dir locator before it reads the
      // app-data session. Read once more to restore the reader position, but
      // only attach it when it names that exact project directory.
      if (
        projectDir && session && typeof session === "object" &&
        Object.keys(session).length === 1 && Object.hasOwn(session, "project_dir")
      ) {
        this.projectDir = projectDir;
        this.projectDirFromUrl = false;
        const saved = await this.nativeInvoke("load_session", {});
        if (saved && typeof saved === "object" && saved.project_dir === projectDir) {
          return saved;
        }
        return session;
      }
      if (!this.projectDirFromUrl && projectDir) this.projectDir = projectDir;
      // The session file holds the whole reader position, not just the
      // directory.  Returning only `project_dir` here would silently drop the
      // lesson, mode and panel that `restoreSession` needs, so every native
      // restart would fall back to "first unfinished lesson, default panels".
      return projectDir && session && typeof session === "object" ? session : null;
    }
    if (typeof globalThis.fetch !== "function") return this.memory[SESSION_KEY] || null;
    try {
      const response = await globalThis.fetch(`${this.apiBase}/session`, {
        method: "GET",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      // Session metadata is optional. A service outage, stale identity, or
      // corrupt record must leave a usable launcher/project, not a white page.
      if (!response.ok || payload.error) return null;
      return payload.value && typeof payload.value === "object" ? payload.value : null;
    } catch {
      return null;
    }
  }
  async createSnapshot(input) {
    return await this.invoke("snapshot.create", input);
  }
  async listSnapshots() {
    const snapshots = await this.invoke(
      "snapshot.list",
      this.isNative() ? {} : { project_dir: this.requireProjectDir() },
    );
    if (this.isNative()) {
      if (!Array.isArray(snapshots)) throw new Error("版本列表返回格式无效");
      return {
        project_id: this.lastOpenedProjectState?.project_id ?? null,
        snapshots,
      };
    }
    return snapshots;
  }
  async restoreSnapshot(snapshotId, request = {}) {
    const execution = await this.commandWithMutationAck("snapshot.restore", {
      ...request,
      snapshot_id: snapshotId,
    });
    return { ...(execution.value || {}), mutation_ack: execution.mutation_ack };
  }
}

/**
 * Browser-only export fallback.
 *
 * This mirrors the service renderer's resolution rule for media blocks so the
 * preview, the browser export and the desktop export agree on what an image
 * block renders as.
 */
function browserExportBlocks(data, item) {
  return (data.blocks || []).filter((block) => block.document_id === item?.document_id).sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
}
function browserExportText(value) { return typeof value === "string" ? value : JSON.stringify(value ?? ""); }
function browserBlockAsset(data, block) {
  const linked = block && block.settings && block.settings.asset_id;
  if (typeof linked === "string" && linked) {
    const found = (data.assets || []).find((asset) => asset.id === linked && !asset.archived);
    if (found) return found;
  }
  const reference = browserExportText(block.content).trim();
  return (data.assets || []).find((asset) =>
    !asset.archived &&
    (asset.filename === reference || asset.storage_path === reference || asset.title === reference)
  ) || null;
}
function browserReferencedAssets(data, item) {
  const ids = new Set((data.asset_usages || []).filter((usage) => usage.content_item_id === item?.id).map((usage) => usage.asset_id));
  for (const block of browserExportBlocks(data, item)) {
    const asset = browserBlockAsset(data, block);
    if (asset) ids.add(asset.id);
  }
  return (data.assets || []).filter((asset) => ids.has(asset.id) && !asset.archived && typeof asset.storage_path === "string" && !asset.storage_path.startsWith("/") && !asset.storage_path.split(/[\\/]/).includes("..")).sort((a, b) => String(a.filename).localeCompare(String(b.filename)) || String(a.id).localeCompare(String(b.id)));
}
/**
 * Markdown mirror of the service renderer: layout-only placeholder blocks are
 * omitted, media blocks render inline through their resolved asset, and the
 * referenced assets are listed once at the end.
 */
function browserMarkdown(data, item) {
  const lines = [`# ${browserExportText(item?.title || "未命名内容")}`, ""];
  const layoutOnlyAnchors = new Set((data.requirements || [])
    .filter((requirement) => requirement.content_item_id === item?.id && requirement.scope === "layout")
    .map((requirement) => requirement.anchor_block_id)
    .filter(Boolean));
  browserExportBlocks(data, item).filter((block) => !layoutOnlyAnchors.has(block.id)).forEach((block) => {
    const asset = browserBlockAsset(data, block);
    const content = browserExportText(block.content);
    if (block.type === "heading") {
      lines.push(`${"#".repeat(Math.max(1, Math.min(6, Number(block.settings?.level) || 2)))} ${content}`);
    } else if (block.type === "quote") {
      lines.push(`> ${content}`);
    } else if (block.type === "code") {
      lines.push("```\n" + content + "\n```");
    } else if (block.type === "divider") {
      lines.push("---");
    } else if (block.type === "placeholder") {
      return;
    } else if (asset && (asset.type === "image" || asset.type === "gif")) {
      lines.push(`![${asset.title || asset.filename}](${asset.storage_path})`);
    } else if (asset) {
      lines.push(`[${asset.title || asset.filename}](${asset.storage_path})`);
    } else if (content) {
      lines.push(content);
    } else {
      return;
    }
    lines.push("");
  });
  const inlineIds = new Set(
    browserExportBlocks(data, item)
      .map((block) => browserBlockAsset(data, block)?.id)
      .filter(Boolean),
  );
  const assets = browserReferencedAssets(data, item).filter((asset) => !inlineIds.has(asset.id));
  if (assets.length) {
    lines.push("## 素材", "");
    assets.forEach((asset) => {
      const title = String(asset.title || asset.filename).replaceAll("[", "\\[").replaceAll("]", "\\]");
      lines.push(`${asset.type === "image" || asset.type === "gif" ? "!" : ""}[${title}](${asset.storage_path})`, "");
    });
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** HTML mirror of the service renderer, using the same asset resolution. */
function browserHtml(data, item) {
  const blocks = browserExportBlocks(data, item).map((block) => {
    const asset = browserBlockAsset(data, block);
    const content = esc(browserExportText(block.content));
    if (block.type === "heading") { const level = Math.max(1, Math.min(6, Number(block.settings?.level) || 2)); return `<h${level}>${content}</h${level}>`; }
    if (block.type === "quote") return `<blockquote>${content}</blockquote>`;
    if (block.type === "code") return `<pre><code>${content}</code></pre>`;
    if (block.type === "divider") return "<hr>";
    if (block.type === "placeholder") return "";
    if (asset) {
      const path = esc(asset.storage_path);
      const title = esc(asset.title || asset.filename);
      if (asset.type === "image" || asset.type === "gif") {
        return `<figure><img src="${path}" alt="${title}"><figcaption>${title}</figcaption></figure>`;
      }
      if (asset.type === "video") {
        return `<figure><video controls src="${path}"></video><figcaption>${title}</figcaption></figure>`;
      }
      if (asset.type === "audio") {
        return `<figure><audio controls src="${path}"></audio><figcaption>${title}</figcaption></figure>`;
      }
      return `<p><a href="${path}">${title}</a></p>`;
    }
    return content ? `<p>${content}</p>` : "";
  }).filter(Boolean).join("\n");
  // Media is already inline, so the gallery only lists assets with no block of
  // their own (for example material attached by a requirement).
  const inlineIds = new Set(
    browserExportBlocks(data, item)
      .map((block) => browserBlockAsset(data, block)?.id)
      .filter(Boolean),
  );
  const assets = browserReferencedAssets(data, item)
    .filter((asset) => !inlineIds.has(asset.id))
    .map((asset) => {
      const path = esc(asset.storage_path); const title = esc(asset.title || asset.filename);
      if (asset.type === "image" || asset.type === "gif") return `<figure><img src="${path}" alt="${title}"><figcaption>${title}</figcaption></figure>`;
      if (asset.type === "video") return `<figure><video controls src="${path}"></video><figcaption>${title}</figcaption></figure>`;
      if (asset.type === "audio") return `<figure><audio controls src="${path}"></audio><figcaption>${title}</figcaption></figure>`;
      return `<p><a href="${path}">${title}</a></p>`;
    }).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(item?.title || "未命名内容")}</title><style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font:16px/1.7 system-ui,sans-serif}img,video{max-width:100%;height:auto}blockquote{border-left:3px solid #bbb;padding-left:1rem}.todo{padding:.75rem;background:#fff5dc}</style></head><body><article><h1>${esc(item?.title || "未命名内容")}</h1>${blocks}${assets ? `<section class="assets"><h2>素材</h2>${assets}</section>` : ""}</article></body></html>\n`;
}

function stemForExport(value) {
  return String(value || "course").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "").trim() || "course";
}

function browserDownload(filename, contents, mime) {
  if (typeof Blob === "undefined" || typeof URL === "undefined" || typeof document === "undefined") return false;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([contents], { type: mime }));
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
  return true;
}
function browserDownloadUrl(filename, url) {
  if (typeof document === "undefined" || typeof URL === "undefined") return false;
  let target;
  try {
    target = new URL(url, globalThis.location?.href || "http://localhost/");
    if (globalThis.location?.origin && target.origin !== globalThis.location.origin) return false;
  } catch {
    return false;
  }
  const link = document.createElement("a");
  link.href = target.href;
  link.download = filename;
  link.click();
  link.remove?.();
  return true;
}

/**
 * Next lesson code for a stage: one past the highest number already used, so a
 * code is never reused after a lesson is deleted.
 *
 * @param {string} stageCode
 * @param {Array<{ code?: string }>} siblings
 * @returns {string}
 */
function nextLessonCode(stageCode, siblings) {
  let highest = 0;
  for (const sibling of siblings) {
    const match = /-(\d+)$/.exec(String(sibling.code || ""));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${stageCode}-${String(highest + 1).padStart(2, "0")}`;
}

/**
 * Chinese ordinal used in default stage titles (第一阶段, 第十一阶段, …).
 *
 * @param {number} n
 * @returns {string}
 */
function chineseStageOrdinal(n) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (n <= 0) return String(n);
  if (n < 10) return digits[n];
  if (n === 10) return "十";
  if (n < 20) return `十${digits[n - 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ""}`;
  }
  return String(n);
}

/**
 * Next unused stage code (`S01`, `S02`, …) among non-archived stages.
 *
 * @param {any} data
 * @returns {string}
 */
function nextStageCode(data) {
  let highest = 0;
  for (const stage of data.stages || []) {
    if (stage.archived) continue;
    const match = /^S(\d+)$/i.exec(String(stage.code || ""));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `S${String(highest + 1).padStart(2, "0")}`;
}

/**
 * Default editable display title for a stage code. Code and title stay separate.
 *
 * @param {string} code
 * @returns {string}
 */
function defaultStageTitleForCode(code) {
  const match = /^S(\d+)$/i.exec(String(code || ""));
  const n = match ? Number(match[1]) : 1;
  return `第${chineseStageOrdinal(n)}阶段`;
}

/**
 * Compact active stage order_index after a delete.
 *
 * @param {any} data
 */
function reindexStages(data) {
  const ordered = data.stages
    .filter((stage) => !stage.archived)
    .sort((left, right) => left.order_index - right.order_index);
  ordered.forEach((stage, index) => {
    stage.order_index = index;
  });
}

/**
 * Renumber a stage's lessons so `code`, `order_index` and reading order agree.
 * Codes are user-facing identifiers, so they must stay unique after a delete.
 *
 * @param {any} data
 * @param {string | null} stageId
 */
function renumberLessonCodes(data, stageId) {
  const ordered = data.content_items
    .filter((item) => item.stage_id === stageId && !item.archived)
    .sort((left, right) => left.order_index - right.order_index);
  const stage = data.stages.find((candidate) => candidate.id === stageId);
  const prefix = stage ? stage.code : "C";
  ordered.forEach((item, index) => {
    item.code = `${prefix}-${String(index + 1).padStart(2, "0")}`;
  });
}

/**
 * Point a block at an asset.
 *
 * `settings.asset_id` is the canonical link the editor, preview and media
 * panel resolve.  `content` keeps the human filename because the export
 * renderers resolve inline media from block content, so both stay valid.
 *
 * @param {any} block
 * @param {any} asset
 */
function linkBlockAsset(block, asset) {
  block.type = mediaBlockTypeFor(asset);
  block.content = asset.filename || asset.title || "";
  block.settings.asset_id = asset.id;
  block.settings.media_type = asset.type;
  block.updated_at = now();
  return block;
}

/** Match a media block type to what the asset actually is. */
function mediaBlockTypeFor(asset) {
  if (asset.type === "gif") return "gif";
  if (asset.type === "video") return "video";
  if (asset.type === "audio") return "audio";
  if (asset.type === "document" || asset.type === "other") return "embed";
  return "image";
}

class WorkbenchStore {
  constructor(bridge) {
    this.bridge = bridge;
    this.data = blankProject();
    this.projectFingerprint = null;
    this.projectFingerprintGeneration = 0;
    this.ui = {
      screen: "launcher",
      route: "overview",
      mode: "writing",
      boardDimension: "content",
      activeId: null,
      selectedBlockId: null,
      propertyTarget: null,
      focusRequirementId: null,
      leftCollapsed: false,
      rightCollapsed: false,
      collapsedStageIds: [],
      rightPanel: "requirements",
      palette: false,
      paletteIndex: 0,
      capture: false,
      preflight: false,
      preflightPending: false,
      preflightReport: null,
      preflightRevision: null,
      preflightFormat: null,
      preflightOptions: null,
      acknowledgedWarnings: [],
      publishScope: "lesson",
      publishReturnContext: null,
      publishFormat: "markdown",
      lastExport: null,
      snapshot: false,
      gridEditing: false,
      paginationEditing: false,
      layoutPageId: null,
      layoutZoom: "fit",
      movingPlacementTargetPageId: null,
      paginationConversionPreview: false,
      pageSizePreview: null,
      previewPageIds: [],
      previewFit: true,
      publishPageMode: "all",
      publishSelectedPageIds: [],
      publishTargetPageSize: null,
      publishCapabilities: null,
      assetPicker: null,
      assetImagePreviewId: null,
      assetImagePreviewSource: null,
      assetImagePreviewLoading: false,
      assetImagePreviewError: "",
      assetUsageId: null,
      editingRequirementId: null,
      assetQuery: "",
      showPreviewNotes: true,
      confirmDeleteLesson: null,
      confirmDeleteStage: null,
      confirmDeleteAssetId: null,
      toast: "",
      // AI workflow (V0-T03 §4).  Every field here is UI-only: canonical AI
      // rows live in `this.data` and only change through `commit`.  The names
      // are also deliberately free of credential-shaped words because the
      // session writer rejects such keys.
      aiScope: "lesson",
      aiBlockId: null,
      aiInstruction: "",
      aiProviderId: "fake",
      aiModel: "",
      aiSettingsOpen: false,
      aiSubscriptionAttempt: null,
      aiInclude: { requirements: true, assets: true, completion: true, nearby: true },
      aiContext: null,
      aiContextOpen: false,
      aiStatus: "idle",
      aiError: null,
      aiResult: null,
      aiDraftId: null,
      aiExecutions: [],
      aiExecutionsOpen: false,
      aiProviders: [],
      aiConfigured: {},
      aiProviderForm: null,
      aiRunId: null,
      /** Whether the next run should ask the model for concrete changes. */
      aiWantsChanges: false,
      /**
       * A control the next render should put the caret into, as a
       * `data-focus-key` value ("ai-secret" after saving a provider config,
       * for example).  Consumed once, never persisted.
       */
      focusField: "",
      /**
       * §4/§5 — the app-level project registry rows for the start page, newest
       * first, plus the §4.4 copy prompt. Convenience state only: it is re-read
       * from the shell, never written into a course, and never part of the
       * session pointer.
       */
      registryProjects: [],
      registryCopy: null,
      /** Inline editors: the course title in the topbar, one layout section, asset title. */
      editingProjectTitle: false,
      editingProjectTitleSurface: "topbar",
      editingStageTitleId: null,
      editingLessonTitleId: null,
      editingLessonTitleSurface: "map",
      editingSectionId: null,
      editingAssetId: null,
      assetRenameValue: "",
      assetRenameError: "",
      /** "你现在有什么？": which course-input source is being pasted. */
      seedType: null,
      seedText: "",
      seedBusy: false,
      /** V1-T04 read-only folder scan result (Task 9). Not Canonical. */
      folderScan: null,
      /** Stable, immutable input for every fresh Mapping selection session. */
      mappingScanSnapshot: null,
      /** Explicit nested document choices; [] means the user chose none. */
      documentImportPaths: [],
      importFolderRoot: null,
      /** Workspace Explorer UI (§§27–28, 36–37, 39) — session/workspace only. */
      explorerFilter: "",
      explorerExpanded: [],
      explorerSelected: null,
      explorerRecent: [],
      explorerPreview: null,
      /** V1-T04 mapping preview plan (§§30–31). UI-only until Task 12 apply. */
      importMappingPlan: null,
      importMappingError: "",
      importMode: "adopt",
      importingMapping: false,
      /**
       * §18 — the body-document dialog opened by a confirmed plan: the candidate
       * rows (with the user's checkbox state) or null while it is closed.
       */
      documentImportDialog: null,
      /**
       * One-shot: the body dialog already answered this import run, so the import
       * it started is not asked again. Consumed by `applyFolderAdoption`.
       */
      documentImportAnswered: false,
      /** §28 — the last per-document import tally, or null when the shell sent none. */
      documentImportReport: null,
      /** §3.2 Case C: a folder whose project.json exists but cannot be used. */
      projectProblem: null,
      /** One-shot: the next adoption may move an invalid project.json aside. */
      replaceInvalidProject: false,
    };
    this.tabs = [];
    this.history = [];
    this.future = [];
    this.listeners = new Set();
    this.saveTimer = 0;
    this.activeFlushPromise = null;
    this.preflightDeferredSave = false;
    this.preflightGeneration = 0;
    this.activeExportId = null;
    this.sessionTimer = 0;
    this.flushQueue = createSerialQueue();
    this.recoveryWarning = "";
    this.saveStatus = "未保存";
    this.lastSaveFailure = null;
    this.uncertainMutation = null;
    this.uncertainMutationPending = false;
    this.canonicalMutationPending = false;
    this.canonicalMutationOwner = null;
    this.localSnapshots = new Map();
    this.nativeDropUnlisten = null;
    this.nativeLeaseDirs = new Set();
    // The native session file is the current pointer, while this map keeps a
    // coherent reader position for every project visited during this process.
    // It is serialized inside the same session payload so A → B → A does not
    // turn B into a reason to forget where A was.
    this.nativeProjectSessions = new Map();
    this.nativeSwitching = false;
    this.nativeSwitchPending = null;
    this.externalConflict = null;
    this.pendingRecovery = null;
    this.recoveryResolution = null;
    this.editTimer = 0;
    this.assetSearchTimer = 0;
    this.explorerFilterTimer = 0;
    this.folderScanGeneration = 0;
    this.mappingGeneration = 0;
    this.documentImportGeneration = 0;
    this.mappingScanSequence = 0;
    this.expectedProjectId = null;
    this.editorGeneration = 0;
    this.projectIdentityKey = "";
    this.saveRevision = 0;
    this.lastSaveProjectKey = null;
    this.sessionGeneration = 0;
    this.sessionRevision = 0;
    this.sessionBootstrapReady = false;
    this.sessionFailureReported = false;
    this.snapshotRows = [];
    this.snapshotLoading = false;
    this.snapshotLoadError = "";
    this.snapshotSaving = false;
    this.snapshotRestoringId = null;
    this.snapshotAttempt = null;
    this.snapshotOperationGeneration = 0;
    this.snapshotError = "";
    this.snapshotName = "";
    this.snapshotNote = "";
    /** Preview cache: bounded, read-only, never a source of truth. */
    this.assetPreview = new AssetPreviewCache(bridge);
    this.bridge.previewRequestContext = () => {
      const identity = this.saveIdentity();
      if (
        !identity.project_dir || !identity.expected_project_id ||
        !this.isFileFingerprint(this.projectFingerprint) ||
        !this.projectFingerprint.exists
      ) return null;
      return {
        project_dir: identity.project_dir,
        project_id: identity.expected_project_id,
        fingerprint: clone(this.projectFingerprint),
        lease_generation: identity.lease_generation,
        editor_generation: identity.editor_generation,
      };
    };
    this.saveScheduler = createPersistenceScheduler({
      write: (request) => this.persistProjectSnapshot(request),
      onResult: (result, request) => this.applySaveAcknowledgement(result, request),
      onError: (error, request) => this.reportSaveFailure(error, request),
    });
    this.sessionScheduler = createSessionScheduler({
      write: async (session, metadata) => {
        const result = await this.persistSessionDirect(session, metadata);
        this.sessionFailureReported = false;
        return result;
      },
      onError: (error, session) => this.reportSessionFailure(error, session),
    });
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() {
    if (this.preflightDeferredSave && this.ui.route !== "publish") {
      this.preflightDeferredSave = false;
      this.scheduleSave();
    }
    this.listeners.forEach((listener) => listener("full"));
  }
  /**
   * A change that only touches the chrome around the editor — the save state,
   * the status bar counters, the toast.  Autosave, typing and toasts all use
   * this instead of `notify()`: rebuilding the whole shell 350ms after every
   * keystroke is what used to destroy the caret, the selection and an
   * in-flight IME composition.  A full render still happens for any change
   * that alters structure (selection, mode, route, panels, modals).
   */
  notifyChrome() { this.listeners.forEach((listener) => listener("chrome")); }
  /**
   * Show a short-lived message.  Toasts are advisory: they must never sit on
   * top of the next action or claim state the project does not have.
   */
  say(message, options = {}) {
    this.ui.toast = String(message ?? "");
    clearTimeout(this.toastTimer);
    if (this.ui.toast && options.sticky !== true) {
      this.toastTimer = setTimeout(() => {
        this.ui.toast = "";
        this.notifyChrome();
      }, options.ttl ?? 6000);
    }
    this.notifyChrome();
  }
  hasNativeLease(projectDir = this.bridge.projectDir) {
    return this.bridge.isNative() && Boolean(projectDir) && this.nativeLeaseDirs.has(projectDir);
  }
  markNativeLease(projectDir = this.bridge.projectDir) {
    if (this.bridge.isNative() && projectDir) this.nativeLeaseDirs.add(projectDir);
  }
  clearNativeLease(projectDir = null) {
    if (!projectDir) this.nativeLeaseDirs.clear();
    else this.nativeLeaseDirs.delete(projectDir);
  }
  async closeNativeProject(projectDir = this.bridge.projectDir) {
    if (!this.hasNativeLease(projectDir)) return false;
    await this.bridge.closeProject(projectDir);
    this.clearNativeLease(projectDir);
    return true;
  }
  readerState() {
    return {
      active_content_item_id: this.ui.activeId,
      mode: this.ui.mode,
      right_panel: this.ui.rightPanel,
      route: this.ui.route,
      selected_block_id: this.ui.selectedBlockId,
      layout_page_id: this.ui.layoutPageId,
      layout_zoom: this.ui.layoutZoom,
      ai_scope: this.ui.aiScope,
      ai_provider_id: this.ui.aiProviderId,
      ai_model: this.ui.aiModel,
      left_collapsed: this.ui.leftCollapsed,
      right_collapsed: this.ui.rightCollapsed,
      collapsed_stage_ids: [...this.ui.collapsedStageIds],
      tabs: clone(this.tabs),
      explorer_filter: String(this.ui.explorerFilter || ""),
      explorer_expanded: normalizeExplorerPathList(this.ui.explorerExpanded),
      explorer_recent: normalizeExplorerPathList(this.ui.explorerRecent, 8),
    };
  }
  defaultReaderState(project, route = "overview") {
    const activeId = resumeLessonId(project) || project?.content_items?.[0]?.id || null;
    return {
      active_content_item_id: activeId,
      mode: "writing",
      right_panel: "requirements",
      route,
      selected_block_id: null,
      layout_page_id: (() => {
        const layout = project?.layout_instances?.find((candidate) =>
          candidate.content_item_id === activeId
        );
        return layout ? getLayoutPages(project, layout.id)[0]?.id ?? null : null;
      })(),
      layout_zoom: "fit",
      ai_scope: "lesson",
      ai_provider_id: "fake",
      ai_model: "",
      left_collapsed: false,
      right_collapsed: false,
      collapsed_stage_ids: [],
      tabs: activeId
        ? [{ content_item_id: activeId, mode: "writing", pinned: false, scroll_top: 0 }]
        : [],
      explorer_filter: "",
      explorer_expanded: [],
      explorer_recent: [],
    };
  }
  normalizeReaderState(project, candidate = {}, route = "overview") {
    const defaults = this.defaultReaderState(project, route);
    const value = candidate && typeof candidate === "object" ? candidate : {};
    const knownItem = (id) => Boolean(id) && project.content_items.some((item) => item.id === id);
    const activeId = knownItem(value.active_content_item_id)
      ? value.active_content_item_id
      : defaults.active_content_item_id;
    const legacyFlowRoute = value.route === "structure";
    const savedMode = legacyFlowRoute
      ? "structure"
      : ["writing", "structure", "layout", "preview"].includes(value.mode)
      ? value.mode
      : defaults.mode;
    const rightPanel = RIGHT_PANEL_KEYS.includes(value.right_panel)
      ? value.right_panel
      : defaults.right_panel;
    const rawRoute = legacyFlowRoute
      ? "editor"
      : ROUTES.includes(value.route)
      ? value.route
      : defaults.route;
    const nextRoute = rawRoute === "workbench"
      ? "editor"
      : rawRoute === "editor" && savedMode === "layout"
      ? "free-layout"
      : rawRoute;
    // Layout editing moved to its own top-level route; old lesson tabs return
    // to the body editor while the saved route carries the Grid/Page context.
    const mode = savedMode === "layout" ? "writing" : savedMode;
    const selectedBlockId = typeof value.selected_block_id === "string" && activeId &&
        blocksFor(project, activeId).some((block) => block.id === value.selected_block_id)
      ? value.selected_block_id
      : null;
    const activeLayout = project.layout_instances?.find((candidate) =>
      candidate.content_item_id === activeId
    );
    const activePages = activeLayout
      ? getLayoutPages(project, activeLayout.id)
      : [];
    const layoutPageId = activePages.some((page) => page.id === value.layout_page_id)
      ? value.layout_page_id
      : activePages[0]?.id ?? null;
    const tabs = Array.isArray(value.tabs)
      ? value.tabs
        .filter((tab) => tab && knownItem(tab.content_item_id))
        .map((tab) => ({
          content_item_id: tab.content_item_id,
          mode: ["writing", "structure", "layout", "preview"].includes(tab.mode)
            ? tab.mode === "layout" ? "writing" : tab.mode
            : "writing",
          pinned: Boolean(tab.pinned),
          scroll_top: Number(tab.scroll_top) || 0,
        }))
      : [];
    if (activeId && !tabs.some((tab) => tab.content_item_id === activeId)) {
      tabs.push({ content_item_id: activeId, mode, pinned: false, scroll_top: 0 });
    }
    return {
      ...defaults,
      active_content_item_id: activeId,
      mode,
      right_panel: rightPanel,
      route: nextRoute,
      selected_block_id: selectedBlockId,
      layout_page_id: layoutPageId,
      layout_zoom: ["fit", "actual"].includes(value.layout_zoom)
        ? value.layout_zoom
        : defaults.layout_zoom,
      ai_scope: ["course", "lesson", "block"].includes(value.ai_scope) ? value.ai_scope : defaults.ai_scope,
      ai_provider_id: typeof value.ai_provider_id === "string" && value.ai_provider_id.trim()
        ? value.ai_provider_id.trim()
        : defaults.ai_provider_id,
      ai_model: typeof value.ai_model === "string" ? value.ai_model.trim() : defaults.ai_model,
      left_collapsed: Boolean(value.left_collapsed),
      right_collapsed: Boolean(value.right_collapsed),
      collapsed_stage_ids: Array.isArray(value.collapsed_stage_ids)
        ? [...new Set(value.collapsed_stage_ids.filter((id) =>
          typeof id === "string" &&
          (project.stages || []).some((stage) => stage.id === id && !stage.archived)
        ))]
        : [],
      tabs,
      explorer_filter: typeof value.explorer_filter === "string"
        ? value.explorer_filter.slice(0, 256)
        : defaults.explorer_filter,
      explorer_expanded: normalizeExplorerPathList(value.explorer_expanded),
      explorer_recent: normalizeExplorerPathList(value.explorer_recent, 8),
    };
  }
  applyReaderState(reader) {
    const value = reader || {};
    this.ui.activeId = value.active_content_item_id || null;
    this.ui.mode = value.mode || "writing";
    this.ui.rightPanel = value.right_panel || "requirements";
    this.ui.route = value.route || "overview";
    this.ui.selectedBlockId = value.selected_block_id || null;
    this.ui.layoutPageId = value.layout_page_id || null;
    this.ui.layoutZoom = value.layout_zoom === "actual" ? "actual" : "fit";
    this.ui.aiScope = value.ai_scope || "lesson";
    this.ui.aiProviderId = value.ai_provider_id || "fake";
    this.ui.aiModel = value.ai_model || "";
    this.ui.aiSettingsOpen = false;
    this.ui.leftCollapsed = Boolean(value.left_collapsed);
    this.ui.rightCollapsed = Boolean(value.right_collapsed);
    this.ui.collapsedStageIds = Array.isArray(value.collapsed_stage_ids)
      ? [...value.collapsed_stage_ids]
      : [];
    this.tabs = clone(value.tabs || []);
    this.ui.explorerFilter = typeof value.explorer_filter === "string" ? value.explorer_filter : "";
    this.ui.explorerExpanded = normalizeExplorerPathList(value.explorer_expanded);
    this.ui.explorerRecent = normalizeExplorerPathList(value.explorer_recent, 8);
    this.normalizeActiveLayoutPage();
  }
  cacheSessionRecord(session) {
    if (!session || typeof session !== "object") return;
    const projectId = typeof session.project_id === "string" && session.project_id.trim()
      ? session.project_id.trim()
      : null;
    if (!projectId) return;
    const projectDir = typeof session.project_dir === "string" && session.project_dir.trim()
      ? session.project_dir.trim()
      : null;
    if (this.bridge.isNative() && !projectDir) return;
    const record = { project_id: projectId, project_dir: projectDir };
    for (const key of SESSION_READER_KEYS) {
      if (key in session) record[key] = clone(session[key]);
    }
    this.nativeProjectSessions.set(projectId, record);
  }
  rememberSession(session) {
    if (!session || typeof session !== "object") return;
    const records = session.project_sessions;
    if (records && typeof records === "object" && !Array.isArray(records)) {
      for (const [projectId, record] of Object.entries(records)) {
        if (record && typeof record === "object" && record.project_id === projectId) {
          this.cacheSessionRecord(record);
        }
      }
    }
    // The top-level record is the current committed identity and wins over a
    // stale duplicate nested under project_sessions.
    this.cacheSessionRecord(session);
  }
  sessionWithReader(projectDir, projectId, reader) {
    const record = {
      ...(this.bridge.isNative() ? { project_dir: projectDir || null } : {}),
      project_id: projectId || null,
      ...clone(reader || {}),
    };
    const records = new Map(this.nativeProjectSessions);
    if (record.project_id) records.set(record.project_id, record);
    const payload = { ...record };
    // Native storage can safely keep per-project reader positions because the
    // session file is app-local and each record carries its directory. The
    // browser service owns one configured root, so sending other projects'
    // records would only create an unnecessary cross-project restore surface.
    if (this.bridge.isNative()) {
      payload.project_sessions = Object.fromEntries(
        [...records.entries()].filter(([id, value]) => id && value && value.project_id === id),
      );
    }
    return payload;
  }
  async persistSession(session) {
    // onError reports the exact failed snapshot. Avoid tagging an old
    // project's failure onto a newly selected project.
    await this.sessionScheduler.flush().catch(() => {});
    return await this.persistSessionDirect(session, { operation_id: uid() });
  }
  async bootstrapBrowserSession(projectId) {
    this.sessionBootstrapReady = false;
    if (typeof this.bridge.openSession !== "function") {
      return { session: await this.bridge.loadSession(), session_generation: 0, revision: 0 };
    }
    const opened = await this.bridge.openSession(projectId);
    this.sessionGeneration = opened.session_generation;
    this.sessionRevision = opened.revision;
    this.sessionBootstrapReady = Number.isSafeInteger(opened.session_generation) &&
      opened.session_generation > 0;
    return opened;
  }
  async persistSessionDirect(session, metadata = {}) {
    const value = session && typeof session === "object" ? session : {};
    const projectDir = typeof value.project_dir === "string" && value.project_dir.trim()
      ? value.project_dir.trim()
      : null;
    const projectId = typeof value.project_id === "string" && value.project_id.trim()
      ? value.project_id.trim()
      : null;
    if (this.bridge.isNative()) {
      if ((projectDir && !projectId) || (!projectDir && projectId)) {
        throw new Error("项目会话的目录与标识不一致");
      }
      if (projectDir && this.bridge.projectDir !== projectDir) {
        throw new Error("项目会话目录与当前项目不一致");
      }
    }
    const sessionGeneration = this.bridge.isNative()
      ? ++this.sessionGeneration
      : this.sessionGeneration;
    const browserSessionProtocol = !this.bridge.isNative() &&
      typeof this.bridge.openSession === "function" && typeof globalThis.fetch === "function";
    if (browserSessionProtocol && !this.sessionBootstrapReady) {
      throw new Error("阅读位置保存通道尚未建立");
    }
    const revision = this.bridge.isNative()
      ? (this.sessionRevision = sessionGeneration)
      : ++this.sessionRevision;
    const result = await this.bridge.saveSession(value, {
      ...metadata,
      operation_id: metadata.operation_id || uid(),
      session_generation: sessionGeneration,
      revision,
    });
    if (browserSessionProtocol && (
      !result || result.session_generation !== sessionGeneration || result.revision !== revision ||
      !["written", "unchanged"].includes(result.outcome)
    )) throw new Error("阅读位置保存确认与当前页面版本不匹配");
    this.rememberSession(value);
  }
  reportSessionFailure(_error, failedSession = null) {
    if (failedSession && JSON.stringify(failedSession) !== JSON.stringify(this.session())) return;
    if (this.sessionFailureReported) return;
    this.sessionFailureReported = true;
    this.ui.toast = "课程内容已经保存，但阅读位置没有记住。你可以继续使用，稍后再试。";
    this.notifyChrome();
  }
  targetSession(project, projectDir, route = "overview") {
    const projectId = project?.project?.id || null;
    const saved = projectId ? this.nativeProjectSessions.get(projectId) : null;
    const savedForTarget = saved && (!this.bridge.isNative() || saved.project_dir === projectDir)
      ? saved
      : null;
    const reader = this.normalizeReaderState(project, savedForTarget || {}, route);
    return this.sessionWithReader(projectDir, projectId, reader);
  }
  async resolveNativeSwitchPending() {
    const pending = this.nativeSwitchPending;
    if (!pending) return true;
    try {
      if (pending.projectDir && this.hasNativeLease(pending.projectDir)) {
        await this.closeNativeProject(pending.projectDir);
      }
      if (pending.restoreProjectDir !== undefined) {
        this.bridge.restoreProjectDir(
          pending.restoreProjectDir,
          pending.restoreFromUrl,
          pending.restoreOpenedProjectState,
        );
      }
      if (Object.prototype.hasOwnProperty.call(pending, "restoreSession")) {
        if (pending.restoreSession) await this.persistSession(pending.restoreSession);
        else await this.persistSession({ project_dir: null });
      }
      this.nativeSwitchPending = null;
      return true;
    } catch (error) {
      this.ui.toast = `项目切换仍未完成。${userFacingError(error, "请稍后再试，当前项目仍保持不变。")}`;
      this.saveStatus = "保存失败";
      this.notify();
      return false;
    }
  }
  async rollbackNativeTarget(
    projectDir,
    restoreProjectDir,
    restoreFromUrl,
    cause,
    restoreSession = null,
    restoreOpenedProjectState = null,
  ) {
    // A provisional target lease belongs to us even when the project payload
    // turned out to be unusable, so close it before restoring the old pointer.
    const pending = {
      projectDir,
      restoreProjectDir,
      restoreFromUrl,
      restoreSession,
      restoreOpenedProjectState,
    };
    try {
      await this.bridge.closeProject(projectDir);
      this.clearNativeLease(projectDir);
    } catch (rollbackError) {
      this.nativeSwitchPending = pending;
      this.bridge.restoreProjectDir(restoreProjectDir, restoreFromUrl, restoreOpenedProjectState);
      throw new Error(`项目切换失败，当前项目仍保持不变。${userFacingError(rollbackError, "请稍后重试。")}`);
    }
    this.bridge.restoreProjectDir(restoreProjectDir, restoreFromUrl, restoreOpenedProjectState);
    try {
      if (restoreSession) await this.persistSession(restoreSession);
      else await this.persistSession({ project_dir: null });
    } catch (restoreError) {
      // The target lease is already gone, but the old session write can be
      // retried while the old lease/path remains active.
      this.nativeSwitchPending = { ...pending, projectDir: null };
      throw new Error(`项目切换失败，当前项目仍保持不变。${userFacingError(restoreError, "请稍后重试。")}`);
    }
    throw cause;
  }
  currentItem() { return this.data.content_items.find((item) => item.id === this.ui.activeId) ?? this.data.content_items[0] ?? null; }
  blocks(item = this.currentItem()) { return item ? blocksFor(this.data, item.id) : []; }
  layout(item = this.currentItem()) { return item ? this.data.layout_instances.find((candidate) => candidate.content_item_id === item.id) ?? null : null; }
  layoutPages(item = this.currentItem()) {
    const layout = this.layout(item);
    return layout ? getLayoutPages(this.data, layout.id) : [];
  }
  gridForLayout(layout, data = this.data, pageId = this.ui.layoutPageId) {
    if (layout?.pagination_mode !== "paged") return layout?.grid_definition ?? null;
    const page = getLayoutPages(data, layout.id).find((candidate) => candidate.id === pageId);
    return page ? pageGrid(layout, page) : null;
  }
  placementsForLayoutPage(layout, data = this.data, pageId = this.ui.layoutPageId) {
    return (data.placements || []).filter((placement) =>
      placement.layout_instance_id === layout?.id &&
      (layout?.pagination_mode !== "paged" || placement.page_id === pageId)
    );
  }
  normalizeActiveLayoutPage(item = this.currentItem()) {
    const pages = this.layoutPages(item);
    if (!pages.some((page) => page.id === this.ui.layoutPageId)) {
      this.ui.layoutPageId = pages[0]?.id ?? null;
    }
    if (!["fit", "actual"].includes(this.ui.layoutZoom)) {
      this.ui.layoutZoom = "fit";
    }
  }
  selectLayoutPage(pageId) {
    if (!this.layoutPages().some((page) => page.id === pageId)) return;
    this.ui.layoutPageId = pageId;
    this.ui.movingPlacementTargetPageId = null;
    this.scheduleSessionSave();
    this.notify();
  }
  setLayoutZoom(mode) {
    if (!["fit", "actual"].includes(mode)) return;
    this.ui.layoutZoom = mode;
    this.scheduleSessionSave();
    this.notify();
  }
  lesson(item = this.currentItem()) { return item ? lessonView(this.data, item.id, this.ui.layoutPageId) : null; }
  map() { return courseMap(this.data, this.ui.activeId); }
  gaps(item = this.currentItem()) {
    return item ? lessonView(this.data, item.id).lesson.gaps : { content: 0, layout: 0, total: 0 };
  }
  statusOptions(dimension) {
    const options = this.statuses().find((candidate) => candidate.key === dimension);
    return options ? options.options : (STATUS[dimension] || STATUS.content);
  }
  statuses(item = this.currentItem()) {
    return Object.entries(STATUS).map(([key, options]) => {
      const dimension = (this.data.status_dimensions || []).find((candidate) => candidate.key === key);
      const canonicalOptions = dimension ? (this.data.status_options || [])
        .filter((candidate) => candidate.dimension_id === dimension.id)
        .sort((a, b) => a.order_index - b.order_index)
        .map((candidate) => candidate.name) : options;
      const assignment = (this.data.status_assignments || []).find((status) => {
        if (status.content_item_id !== item?.id) return false;
        if (status.dimension_key === key) return true;
        return status.dimension_id === dimension?.id;
      });
      const canonicalOption = assignment?.option_id
        ? (this.data.status_options || []).find((candidate) => candidate.id === assignment.option_id)?.name
        : null;
      return {
        key,
        label: { content: "正文", media: "媒体", layout: "排版", review: "审核", publish: "发布", update: "更新" }[key],
        options: canonicalOptions.length ? canonicalOptions : options,
        selected: canonicalOption || assignment?.option || canonicalOptions[0] || options[0],
      };
    });
  }
  resumeLessonId() { return resumeLessonId(this.data, this.ui.activeId); }
  /** The block the right-hand panels act on, validated against the open lesson. */
  selectedBlock() {
    const item = this.currentItem();
    if (!item || !this.ui.selectedBlockId) return null;
    return blocksFor(this.data, item.id).find((block) => block.id === this.ui.selectedBlockId) ?? null;
  }
  selectPropertyTarget(kind, id = null) {
    if (kind === "stage" && !this.data.stages.some((stage) =>
      stage.id === id && !stage.archived
    )) return;
    if (kind !== "project" && kind !== "stage") return;
    this.ui.propertyTarget = kind === "project" ? { kind } : { kind, id };
    this.ui.selectedBlockId = null;
    this.ui.rightPanel = "properties";
    this.ui.rightCollapsed = false;
    this.notify();
  }
  selectBlock(id, options = {}) {
    const item = this.currentItem();
    if (!item) return;
    const known = blocksFor(this.data, item.id).some((block) => block.id === id);
    if (!known) return;
    const placement = (this.data.placements || []).find((candidate) =>
      candidate.layout_instance_id === this.layout(item)?.id && candidate.block_id === id
    );
    if (placement?.page_id && this.layoutPages(item).some((page) => page.id === placement.page_id)) {
      this.ui.layoutPageId = placement.page_id;
    }
    this.ui.selectedBlockId = this.ui.selectedBlockId === id && !options.force ? null : id;
    this.ui.propertyTarget = null;
    if (options.mode && this.ui.mode !== options.mode) this.setMode(options.mode, { silent: true });
    // Placeholder selection surfaces 状态 unless the caller opts out (e.g. a
    // control click inside the card). Soft callers skip a rebuild when the
    // panel is already open so caret / IME stay put.
    let panelChanged = false;
    if (this.ui.selectedBlockId && options.openStatus !== false) {
      const selected = blocksFor(this.data, item.id).find((block) =>
        block.id === this.ui.selectedBlockId
      );
      if (selected?.type === "placeholder") {
        panelChanged = this.ui.rightPanel !== "status" || this.ui.rightCollapsed;
        this.ui.rightPanel = "status";
        this.ui.rightCollapsed = false;
      }
    }
    this.scheduleSessionSave();
    // Soft selection updates the accent in place; a full notify() would
    // replace the DOM and drop caret / IME. Opening 状态 still needs a render.
    if (options.soft && !panelChanged) {
      syncBlockSelectionClasses();
      return;
    }
    this.notify();
  }
  commit(label, mutation, { notify = true } = {}) {
    if (this.canonicalMutationPending) {
      this.ui.toast = "正在完成文件操作，请稍后再编辑。";
      this.notifyChrome();
      return false;
    }
    const before = clone(this.data);
    const selectionBefore = this.ui.selectedBlockId;
    mutation(this.data);
    this.data.project.updated_at = nextRevision(this.data.project.updated_at);
    this.retainUiSelection();
    this.history.push({ label, before, after: clone(this.data), selection: selectionBefore });
    if (this.history.length > 50) this.history.shift();
    this.future = [];
    this.scheduleSave();
    if (notify) this.notify();
    return true;
  }
  recordExternalCommit(label, before, selection = this.ui.selectedBlockId) {
    if (!before) return;
    this.history.push({ label, before: clone(before), after: clone(this.data), selection });
    if (this.history.length > 50) this.history.shift();
    this.future = [];
  }
  markDirty() {
    if (this.canonicalMutationPending) return false;
    this.data.project.updated_at = nextRevision(this.data.project.updated_at);
    this.scheduleSave();
    this.notify();
    return true;
  }
  /**
   * Record an edit without re-rendering: used while a text field still owns
   * focus so the caret and IME composition are never destroyed mid-typing.
   * A follow-up commit() records the same change in history.
   */
  markPendingEdit() {
    if (this.canonicalMutationPending) return false;
    this.data.project.updated_at = nextRevision(this.data.project.updated_at);
    this.scheduleSave();
    clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => { this.editTimer = 0; this.notifyChrome(); }, 600);
    return true;
  }
  /**
   * Drop selection state that no longer points at canonical rows, so a stale
   * block or requirement can never leak into the next lesson.
   */
  /** Record the project identity this shell is allowed to write. */
  trackProjectIdentity(data = this.data) {
    const projectId = data?.project?.id ?? null;
    const projectDir = normalizeProjectDir(this.bridge.projectDir);
    const opened = this.bridge.lastOpenedProjectState;
    const leaseGeneration = opened?.project_dir === projectDir
      ? opened.lease_generation
      : null;
    const key = JSON.stringify({ project_dir: projectDir, project_id: projectId, lease_generation: leaseGeneration });
    if (key !== this.projectIdentityKey) {
      this.snapshotOperationGeneration += 1;
      this.snapshotSaving = false;
      this.snapshotRestoringId = null;
      this.snapshotAttempt = null;
      this.snapshotError = "";
      this.snapshotLoadError = "";
      this.snapshotLoading = false;
      this.snapshotRows = [];
      const editorGeneration = this.editorGeneration + 1;
      this.saveScheduler.changeGeneration({
        project_dir: projectDir,
        expected_project_id: projectId,
        lease_generation: leaseGeneration,
        editor_generation: editorGeneration,
      });
      this.editorGeneration = editorGeneration;
      this.projectIdentityKey = key;
      this.saveRevision = 0;
      this.lastSaveProjectKey = null;
      this.sessionFailureReported = false;
      this.uncertainMutation = null;
      this.uncertainMutationPending = false;
    }
    this.expectedProjectId = projectId;
    const dropped = Number(data?.__status_repair_dropped || 0);
    if (dropped > 0) {
      delete data.__status_repair_dropped;
      this.ui.toast = `有 ${dropped} 条状态记录指向已不存在的状态表，已移除；请重新设置这些课程的状态`;
    }
    return this.expectedProjectId;
  }
  saveIdentity() {
    const projectDir = normalizeProjectDir(this.bridge.projectDir);
    const opened = this.bridge.lastOpenedProjectState;
    const leaseGeneration = opened?.project_dir === projectDir
      ? opened.lease_generation
      : null;
    return {
      project_dir: projectDir,
      expected_project_id: this.expectedProjectId,
      lease_generation: leaseGeneration,
      editor_generation: this.editorGeneration,
    };
  }
  async runCanonicalMutation(
    command,
    input = {},
    {
      expectedFingerprint = null,
      resolvePausedConflict = false,
      preDrained = false,
      resolveUncertainResult = false,
      pauseIfInterveningEdit = false,
    } = {},
  ) {
    if (this.canonicalMutationPending) throw new Error("另一项文件操作尚未完成，请稍后重试。");
    const beforeDrain = this.saveIdentity();
    if (!beforeDrain.expected_project_id) throw new Error("请先打开课程，再执行文件操作。");
    const resolvingConflict = resolvePausedConflict && command === "project.resolve";
    if (resolvingConflict) {
      if (this.saveStatus !== "外部修改冲突" &&
        !(resolveUncertainResult && this.saveStatus === "保存结果待核验")) {
        throw new Error("只有已暂停的外部修改冲突可以直接解决。");
      }
      if (!this.isFileFingerprint(expectedFingerprint) ||
        JSON.stringify(input.expected_current) !== JSON.stringify(expectedFingerprint)) {
        throw new Error("解决冲突必须绑定用户确认的当前磁盘版本。");
      }
    } else {
      if (!preDrained && !await this.flush()) {
        throw new Error("课程内容尚未成功保存；文件操作没有执行。请先重试保存。");
      }
      if (!this.saveIdentityMatches(beforeDrain)) throw new Error("当前课程已经切换；文件操作已取消。");
    }
    const owner = this.beginCanonicalMutation();
    let rescheduleAfterMutation = false;
    let localEditPending = false;
    let request = null;
    let contentBeforeMutation = "";
    let projectBeforeMutation = null;
    const selectionBeforeMutation = this.ui.selectedBlockId;
    try {
      if (resolvingConflict) {
        // The failed CAS is expected here. Suppress its stale queued revision,
        // keep the user's in-memory project/revision, and start a new editor
        // generation whose resolve request is bound to the confirmed disk fp.
        this.reconcileEditorSaveState({ preserveRevision: true });
      }
      const identity = this.saveIdentity();
      const fingerprint = expectedFingerprint || this.projectFingerprint;
      if (!identity.project_dir || !identity.lease_generation || !this.isFileFingerprint(fingerprint) ||
        (!fingerprint.exists && !resolvingConflict)) {
        throw new Error("当前课程没有有效的项目路径、编辑租约或文件指纹；文件操作已取消。");
      }
      request = {
        ...input,
        project_dir: identity.project_dir,
        expected_project_id: identity.expected_project_id,
        lease_generation: identity.lease_generation,
        editor_generation: identity.editor_generation,
        operation_id: uid(),
        revision: Math.max(1, this.saveRevision),
        expected_fingerprint: clone(fingerprint),
      };
      if (typeof this.bridge.commandWithMutationAck !== "function") {
        throw new Error("当前工作台不支持绑定式文件操作；课程没有改变。");
      }
      projectBeforeMutation = clone(this.data);
      contentBeforeMutation = JSON.stringify(this.data);
      const execution = await this.bridge.commandWithMutationAck(command, request);
      const ack = execution?.mutation_ack;
      const validAck = ack && typeof ack === "object" &&
        ack.commit_state === "committed" && ["written", "unchanged"].includes(ack.outcome) &&
        ack.project_id === request.expected_project_id &&
        normalizeProjectDir(ack.project_dir) === request.project_dir &&
        ack.lease_generation === request.lease_generation &&
        ack.editor_generation === request.editor_generation &&
        ack.operation_id === request.operation_id && ack.revision === request.revision &&
        this.isFileFingerprint(ack.fingerprint) && ack.fingerprint.exists &&
        this.isProjectData(ack.project) && ack.project.project.id === request.expected_project_id;
      if (!validAck) {
        throw Object.assign(
          new Error("文件操作没有返回与当前课程和请求匹配的提交确认；请重新读取项目状态后重试。"),
          { code: "mutation_ack_uncertain", commit_state: "outcome_uncertain", retryable: false },
        );
      }
      if (!this.saveIdentityMatches(identity)) {
        throw new Error("文件操作已提交，但当前课程身份已变化；已保留当前编辑内容，请重新读取项目状态。");
      }
      const interveningEdit = this.saveRevision !== request.revision ||
        JSON.stringify(this.data) !== contentBeforeMutation;
      if (interveningEdit) {
        // A live editor can receive input before its debounced history callback.
        // Keep that newer local state and use the committed ack only as its CAS
        // base; never replace it with the older command snapshot.
        this.projectFingerprint = clone(ack.fingerprint);
        this.projectFingerprintGeneration += 1;
        this.reconcileEditorSaveState();
        if (pauseIfInterveningEdit) {
          const pauseError = Object.assign(
            new Error("文件操作已提交，但核验期间出现了较新的本地修改。"),
            { code: "save_reconciliation_required", commit_state: "not_committed", retryable: false },
          );
          this.saveScheduler.pause(pauseError);
          this.saveStatus = "保存结果待核验";
          localEditPending = true;
          if (this.uncertainMutation) this.uncertainMutation.verifiedState = clone({
            project: ack.project,
            project_id: ack.project_id,
            project_dir: ack.project_dir,
            lease_generation: ack.lease_generation,
            fingerprint: ack.fingerprint,
          });
          this.ui.toast = "磁盘提交已确认，但核验期间出现了更新的本地修改。已保留本地内容并暂停自动保存，请先处理这两份内容。";
        } else {
          this.saveStatus = "未保存";
          rescheduleAfterMutation = true;
        }
      } else {
        if (!this.adoptProjectSnapshot({
          project: ack.project,
          project_id: ack.project_id,
          fingerprint: ack.fingerprint,
        })) throw new Error("文件操作已提交，但返回的项目内容无效；请重新读取项目状态。");
        this.reconcileEditorSaveState();
      }
      this.noteRecoveryWarning(ack);
      const warnings = [ack.recovery_warning, ack.durability_warning]
        .filter((warning) => typeof warning === "string" && warning.trim());
      if (warnings.length) this.ui.toast = warnings.join("；");
      return { ...execution, mutation_ack: ack, warnings, localEditPending };
    } catch (error) {
      if ((error?.commit_state ?? error?.details?.commit_state) === "outcome_uncertain") {
        this.saveScheduler.pause(error);
        if (request && this.saveIdentityMatches(request)) {
          this.rememberUncertainMutation(error, {
            request,
            command,
            localProject: this.data,
            localRevision: this.saveRevision,
            baseProject: projectBeforeMutation || this.data,
            baselineContent: contentBeforeMutation,
            selection: selectionBeforeMutation,
          });
          this.reportSaveFailure(error, request);
        }
      }
      throw error;
    } finally {
      this.endCanonicalMutation(owner);
      if (rescheduleAfterMutation) this.scheduleSave();
    }
  }
  beginCanonicalMutation() {
    if (this.canonicalMutationPending) throw new Error("另一项文件操作尚未完成，请稍后重试。");
    const owner = uid();
    this.canonicalMutationOwner = owner;
    this.canonicalMutationPending = true;
    this.notifyChrome();
    return owner;
  }
  endCanonicalMutation(owner) {
    if (!owner || this.canonicalMutationOwner !== owner) return false;
    this.canonicalMutationOwner = null;
    this.canonicalMutationPending = false;
    this.notifyChrome();
    return true;
  }
  reconcileEditorSaveState({ preserveRevision = false } = {}) {
    const identity = this.saveIdentity();
    identity.editor_generation = this.editorGeneration + 1;
    this.saveScheduler.reconcileGeneration(identity);
    this.editorGeneration = identity.editor_generation;
    this.lastSaveFailure = null;
    if (!preserveRevision) this.saveRevision = 0;
    this.lastSaveProjectKey = null;
  }
  saveIdentityMatches(expected) {
    const current = this.saveIdentity();
    return Boolean(expected) &&
      expected.project_dir === current.project_dir &&
      expected.expected_project_id === current.expected_project_id &&
      expected.lease_generation === current.lease_generation &&
      expected.editor_generation === current.editor_generation;
  }
  rememberUncertainMutation(error, {
    request,
    command = null,
    localProject = this.data,
    localRevision = this.saveRevision,
    baseProject = request?.project || localProject,
    baselineContent = JSON.stringify(baseProject),
    selection = this.ui.selectedBlockId,
  } = {}) {
    if (!request || !this.saveIdentityMatches(request)) return false;
    const local = clone(localProject);
    this.uncertainMutation = {
      command,
      request: clone(request),
      error,
      baseProject: clone(baseProject),
      localProject: local,
      localRevision,
      localContent: JSON.stringify(local),
      changedAtFailure: localRevision !== request.revision || JSON.stringify(local) !== baselineContent,
      selection,
      verifiedState: null,
    };
    return true;
  }
  uncertainCommitProof(pending) {
    const error = pending?.error;
    const details = error?.details && typeof error.details === "object" ? error.details : {};
    const request = pending?.request;
    if (!request) return null;
    const operationId = error?.operation_id ?? details.operation_id;
    const revision = error?.revision ?? details.revision;
    if (operationId !== request.operation_id || revision !== request.revision) return null;
    for (const [key, expected] of Object.entries({
      project_id: request.expected_project_id,
      project_dir: request.project_dir,
      lease_generation: request.lease_generation,
      editor_generation: request.editor_generation,
    })) {
      if (Object.hasOwn(details, key) && (key === "project_dir"
        ? normalizeProjectDir(details[key]) !== normalizeProjectDir(expected)
        : details[key] !== expected)) return null;
    }
    if (details.expected_fingerprint && request.expected_fingerprint) {
      const expected = details.expected_fingerprint;
      if (expected.hash !== request.expected_fingerprint.hash || expected.size !== request.expected_fingerprint.size) return null;
    }
    const native = error?.expected_committed_fingerprint ?? details.expected_committed_fingerprint;
    if (native && native.exists === true && typeof native.hash === "string" && Number.isSafeInteger(native.size)) {
      return { hash: native.hash, size: native.size };
    }
    if (typeof details.expected_committed_hash === "string" && Number.isSafeInteger(details.expected_committed_size)) {
      return { hash: details.expected_committed_hash, size: details.expected_committed_size };
    }
    return null;
  }
  async verifyUncertainMutation() {
    const pending = this.uncertainMutation;
    if (!pending || this.uncertainMutationPending || this.canonicalMutationPending) return false;
    const request = pending.request;
    if (!this.saveIdentityMatches(request)) {
      this.ui.toast = "当前课程或编辑租约已经变化；结果没有自动核验，现有本地修改已保留。";
      this.notifyChrome();
      return false;
    }
    this.uncertainMutationPending = true;
    this.ui.toast = "正在读取并核对磁盘提交结果…";
    this.notifyChrome();
    try {
      const proof = this.uncertainCommitProof(pending);
      if (!proof) throw new Error("操作编号、版本号或预期提交指纹不完整，无法证明磁盘结果属于这次操作。");
      const state = await this.bridge.readProjectState();
      if (pending !== this.uncertainMutation || !this.saveIdentityMatches(request)) {
        throw new Error("核验期间课程身份发生变化；本地修改已保留，保存仍暂停。");
      }
      if (!this.isProjectData(state?.project) ||
        state.project_id !== request.expected_project_id ||
        state.project.project.id !== request.expected_project_id ||
        normalizeProjectDir(state.project_dir) !== normalizeProjectDir(request.project_dir) ||
        state.lease_generation !== request.lease_generation ||
        !this.isFileFingerprint(state.fingerprint) || !state.fingerprint.exists ||
        state.fingerprint.hash !== proof.hash || state.fingerprint.size !== proof.size) {
        throw new Error("磁盘课程与这次操作的提交指纹不匹配；没有自动采纳或重试，本地修改仍已保留。保存保持暂停。");
      }
      if (pending.command === "asset.rename" && (
        typeof pending.error?.details?.asset_id === "string" ||
        typeof pending.error?.details?.target_path === "string"
      )) {
        const details = pending.error?.details || {};
        const asset = state.project.assets.find((candidate) => candidate.id === details.asset_id);
        if (!asset || asset.id !== request.asset_id || asset.storage_path !== details.target_path) {
          throw new Error("磁盘指纹虽然可读，但素材路径与这次重命名的目标不一致；本地修改仍已保留，保存保持暂停。");
        }
      }
      const unchangedSinceFailure = !pending.changedAtFailure &&
        this.saveRevision === pending.localRevision &&
        JSON.stringify(this.data) === pending.localContent;
      if (!unchangedSinceFailure) {
        pending.verifiedState = clone(state);
        this.ui.toast = "磁盘已确认包含这次提交，但操作后出现了本地修改。为避免覆盖任一版本，本地内容已保留，自动保存仍暂停。";
        this.notifyChrome();
        return false;
      }
      const result = await this.runCanonicalMutation(
        "project.resolve",
        { project: state.project, expected_current: clone(state.fingerprint) },
        {
          expectedFingerprint: state.fingerprint,
          resolvePausedConflict: true,
          resolveUncertainResult: true,
          pauseIfInterveningEdit: true,
        },
      );
      if (result?.localEditPending) return false;
      if (pending.command === "asset.rename") {
        const beforeAsset = pending.baseProject.assets.find((asset) => asset.id === pending.error?.details?.asset_id);
        const afterAsset = this.data.assets.find((asset) => asset.id === pending.error?.details?.asset_id);
        if (beforeAsset && afterAsset && beforeAsset.storage_path !== afterAsset.storage_path) {
          this.history.push({
            label: `重命名素材文件「${beforeAsset.filename}」`,
            before: clone(pending.baseProject),
            after: clone(this.data),
            selection: pending.selection,
            physical_rename: {
              asset_id: afterAsset.id,
              previous_name: beforeAsset.filename,
              next_name: afterAsset.filename,
            },
          });
          if (this.history.length > 50) this.history.shift();
          this.future = [];
          this.ui.editingAssetId = null;
          this.ui.assetRenameValue = "";
          this.ui.assetRenameError = "";
        }
      }
      if (this.uncertainMutation === pending) this.uncertainMutation = null;
      this.externalConflict = null;
      this.saveStatus = "已保存";
      const warnings = result?.warnings || [];
      this.ui.toast = warnings.length
        ? `磁盘结果已核验，课程已恢复保存；${warnings.join("；")}`
        : "磁盘结果已核验，课程已恢复保存。";
      this.notify();
      return true;
    } catch (error) {
      if (this.uncertainMutation === pending) {
        this.saveScheduler.pause(pending.error);
        this.saveStatus = "保存结果待核验";
        this.ui.toast = userFacingError(error, "无法确认磁盘提交结果。本地修改已保留，自动保存仍暂停。");
      }
      this.notifyChrome();
      return false;
    } finally {
      this.uncertainMutationPending = false;
      this.notifyChrome();
    }
  }
  async refreshSnapshots() {
    const identity = this.saveIdentity();
    if (!identity.expected_project_id) return [];
    this.snapshotLoading = true;
    this.snapshotLoadError = "";
    this.notify();
    try {
      const result = await this.bridge.listSnapshots();
      if (!this.saveIdentityMatches(identity)) return [];
      if (
        !result || result.project_id !== identity.expected_project_id ||
        !Array.isArray(result.snapshots)
      ) throw new Error("版本列表与当前课程不匹配");
      this.snapshotRows = result.snapshots.map((row) => ({
        id: typeof row?.id === "string" ? row.id : null,
        name: String(row?.name || "历史版本无法读取"),
        note: String(row?.note || ""),
        created_at: String(row?.created_at || ""),
        status: row?.status === "available" || row?.status === "persisted"
          ? "available"
          : "error",
        error: row?.error && typeof row.error.message === "string"
          ? String(row.error.message)
          : null,
        content_hash: typeof row?.content_hash === "string" ? row.content_hash : null,
      }));
      this.snapshotLoadError = "";
      return this.snapshotRows;
    } catch (error) {
      if (this.saveIdentityMatches(identity)) {
        this.snapshotLoadError = userFacingError(error, "无法读取已保存版本");
      }
      return [];
    } finally {
      if (this.saveIdentityMatches(identity)) {
        this.snapshotLoading = false;
        this.notify();
      }
    }
  }
  saveRequest(project = this.data) {
    const identity = this.saveIdentity();
    if (!identity.expected_project_id || identity.expected_project_id !== project?.project?.id) {
      throw new Error("当前编辑器的项目身份已变化，请重新打开项目后保存。");
    }
    if (this.bridge.isNative() && (!identity.project_dir || !identity.lease_generation)) {
      throw new Error("当前窗口没有有效的项目锁，无法安全保存。");
    }
    const canonicalRevision = project.project.updated_at;
    const projectKey = JSON.stringify(project);
    if (projectKey !== this.lastSaveProjectKey) {
      this.saveRevision += 1;
      this.lastSaveProjectKey = projectKey;
    }
    if (!Number.isSafeInteger(this.saveRevision) || this.saveRevision < 1) {
      throw new Error("保存版本号无效，请重新打开项目后重试。");
    }
    return {
      ...identity,
      operation_id: uid(),
      revision: this.saveRevision,
      expected_fingerprint: this.projectFingerprint ? clone(this.projectFingerprint) : null,
      project: clone(project),
      recovery_metadata: {
        project_id: project.project.id,
        canonical_revision: canonicalRevision,
        saved_at: now(),
      },
    };
  }
  applySaveAcknowledgement(result, request) {
    const identity = this.saveIdentity();
    if (
      request.expected_project_id !== identity.expected_project_id ||
      request.project_dir !== identity.project_dir ||
      request.lease_generation !== identity.lease_generation ||
      request.editor_generation !== identity.editor_generation
    ) return;
    this.lastSaveFailure = null;
    this.projectFingerprint = clone(result.fingerprint);
    this.projectFingerprintGeneration += 1;
    this.noteRecoveryWarning(result);
    if (this.saveRevision === request.revision) {
      this.saveStatus = "已保存";
      if (result.durability_warning) this.ui.toast = result.durability_warning;
    }
    this.notifyChrome();
  }
  reportSaveFailure(error, request) {
    const identity = this.saveIdentity();
    if (
      request.expected_project_id !== identity.expected_project_id ||
      request.project_dir !== identity.project_dir ||
      request.lease_generation !== identity.lease_generation ||
      request.editor_generation !== identity.editor_generation
    ) return;
    const code = String(error?.code || error?.details?.code || "");
    const uncertain = (error?.commit_state ?? error?.details?.commit_state) === "outcome_uncertain";
    this.saveStatus = uncertain ? "保存结果待核验" : code === "external_modification_conflict" ? "外部修改冲突" : "保存失败";
    if (code === "external_modification_conflict") {
      void this.captureExternalConflict(error);
    } else if (uncertain) {
      this.saveScheduler.pause(error);
      if (!this.uncertainMutation) {
        this.rememberUncertainMutation(error, { request });
      }
      this.ui.toast = "保存结果暂时无法确认。自动保存已暂停；请核验磁盘结果后再继续。";
    } else {
      this.ui.toast = userFacingError(error, "保存没有完成。课程内容没有改变，请稍后再试。");
    }
    this.notifyChrome();
  }
  retainUiSelection() {
    const item = this.currentItem();
    this.ui.focusRequirementId = null;
    if (!item) {
      this.ui.selectedBlockId = null;
      this.aiSyncScope();
      return;
    }
    if (this.ui.selectedBlockId && !blocksFor(this.data, item.id).some((block) => block.id === this.ui.selectedBlockId)) {
      this.ui.selectedBlockId = null;
    }
    if (!this.layout(item)) this.ui.gridEditing = false;
    this.normalizeActiveLayoutPage(item);
    if (this.ui.assetUsageId && !this.data.assets.some((asset) => asset.id === this.ui.assetUsageId)) {
      this.ui.assetUsageId = null;
    }
    if (this.ui.editingRequirementId && !this.data.requirements.some((requirement) => requirement.id === this.ui.editingRequirementId)) {
      this.ui.editingRequirementId = null;
    }
    this.aiSyncScope();
  }
  /**
   * Drop AI state that no longer points at canonical rows.
   *
   * The previewed context and the Diff both belong to one lesson and one
   * block.  After an undo/redo, a lesson switch or a delete they can point at
   * rows that no longer exist — sending lesson A's text while the Diff claims
   * to be about lesson B is exactly the failure this prevents.
   */
  aiSyncScope() {
    const item = this.currentItem();
    if (this.ui.aiBlockId && (!item || !blocksFor(this.data, item.id).some((block) => block.id === this.ui.aiBlockId))) {
      // A block-scope preview mentions that block by id, so it dies with it.
      if (this.ui.aiScope === "block") {
        this.ui.aiContext = null;
        this.ui.aiContextOpen = false;
      }
      this.ui.aiBlockId = null;
    }
    if (this.ui.aiDraftId && !(this.data.change_drafts || []).some((draft) => draft.id === this.ui.aiDraftId)) {
      this.ui.aiDraftId = null;
    }
    const contextLesson = this.ui.aiContext && this.ui.aiContext.scope
      ? this.ui.aiContext.scope.content_item_id || null
      : null;
    if (this.ui.aiContext && (!item || contextLesson !== item.id)) {
      // Never send one lesson's context while the reader is in another.
      this.ui.aiContext = null;
      this.ui.aiContextOpen = false;
    }
  }

  /* ---------------------------------------------------------- AI workflow */

  /**
   * Shape a provider entry into the full connection record every transport and
   * every settings row reads from.  There is no fallback to a built-in default:
   * Workbench ships no provider templates (§9.2), so an `id` alone is not
   * configuration and only a record the shell actually holds can be completed.
   *
   * @param {{ id?: string, label?: string, kind?: string, base_url?: string,
   *   chat_path?: string, api_protocol?: string, auth_header?: string,
   *   auth_scheme?: string, default_model?: string, models?: string[] }} entry
   */
  connectionRecord(entry) {
    const id = String(entry?.id || "").trim();
    const apiProtocol = aiIsKnownApiProtocol(entry?.api_protocol)
      ? String(entry.api_protocol)
      : "openai-completions";
    const anthropic = apiProtocol === "anthropic-messages";
    const kind = String(entry?.kind || "") || "openai_compatible";
    return {
      id,
      label: String(entry?.label || "").trim() || id,
      kind,
      api_protocol: apiProtocol,
      base_url: String(entry?.base_url || "").trim(),
      chat_path: String(entry?.chat_path || "").trim() || "/chat/completions",
      // Auth follows the protocol and nothing else: the form has no scheme
      // editor and 保存配置 derives the same pair, so what the user reads, what
      // lands on disk and what the transport sends can never disagree.
      auth_header: anthropic ? "x-api-key" : "authorization",
      auth_scheme: anthropic ? "" : "Bearer",
      default_model: String(entry?.default_model || "").trim(),
      models: [...new Set((Array.isArray(entry?.models) ? entry.models : [])
        .map((model) => String(model || "").trim())
        .filter(Boolean))],
      requires_credential: !aiIsOfflineConnection({ kind, id }),
    };
  }
  /**
   * A Provider ID keys both the on-disk record and the local credential, so it
   * has to stay one safe path segment.  Empty is a problem too: an unsaved form
   * simply has no id yet.
   *
   * @returns {string} a user-facing reason, or `""` when the id is usable
   */
  providerIdIssue(id) {
    const value = String(id || "").trim();
    if (!value) return "请先填写 Provider ID。";
    if (value.includes("/") || value.includes("\\") || value.includes(" ") ||
      value === "." || value === "..") {
      return "Provider ID 只能使用字母、数字、点、下划线或连字符，且不能包含路径分隔符。";
    }
    return "";
  }

  /**
   * The connection a run would use, as an explicit record (§9.3/§9.4).
   *
   * Exactly three sources exist: a saved connection read back from the shell,
   * the offline deterministic connector that automated tests drive, and nothing
   * else.  An unknown id returns `null` so the assistant can say「配置 AI」
   * instead of silently inventing a Base URL or a model.
   */
  aiDescriptor(providerId = this.ui.aiProviderId) {
    const id = String(providerId || "").trim();
    if (!id) return null;
    if (id === AI_OFFLINE_PROVIDER_ID) {
      return {
        id,
        label: "本地确定性连接器（离线）",
        kind: "fake",
        api_protocol: "openai-completions",
        base_url: "",
        chat_path: "",
        auth_header: "",
        auth_scheme: "",
        default_model: "fake-deterministic",
        models: ["fake-deterministic"],
        requires_credential: false,
      };
    }
    const saved = (Array.isArray(this.ui.aiProviders) ? this.ui.aiProviders : [])
      .find((entry) => entry && entry.id === id) || null;
    // The form being edited is not a connection yet — §9.5 forbids persisting
    // discovery results before Save — but re-opening it must not lose the model
    // list the user just fetched, so an unsaved form answers only its own edit.
    if (saved) return this.connectionRecord(saved);
    const form = this.ui.aiProviderForm;
    if (form && form.isNew === true && String(form.id || "").trim() === id) {
      return this.connectionRecord(form);
    }
    return null;
  }
  /** The model id a run would use, resolved the same way the panel shows it. */
  aiModel() {
    const descriptor = this.aiDescriptor();
    const manual = String(this.ui.aiModel || "").trim();
    if (manual) return manual;
    if (!descriptor) return "";
    return descriptor.default_model || descriptor.models[0] || "";
  }
  /**
   * Build the connector for the selected provider.
   *
   * A method rather than an inline expression, so tests can substitute the
   * offline connector's options (the whole failure matrix runs through it) and
   * a future shell can inject another transport without touching the workflow.
   * The transport returns the bridge value verbatim: `HttpAiConnector` already
   * maps every transport outcome into an `AiFailure`.
   */
  aiConnector() {
    const descriptor = this.aiDescriptor();
    if (!descriptor || !descriptor.id) {
      throw new AiFailure("not_configured", "还没有选择 AI 服务商。请先在 AI 面板里选择一个服务商。", { recoverable: false });
    }
    if (descriptor.id === "fake") return new FakeAiConnector();
    return new HttpAiConnector({
      connection: descriptor,
      model: this.aiModel(),
      base_url: descriptor.base_url,
      transport: (call, options = {}) =>
        this.bridge.command("ai.complete", {
          request_id: this.ui.aiRunId,
          provider_id: call.provider_id,
          url: call.url,
          auth: call.auth,
          headers: call.headers,
          body: call.body,
          timeout_ms: options.timeout_ms,
        }),
    });
  }
  /**
   * The exact input `assembleAiContext` receives.  Block scope follows the
   * live editor selection, with the remembered `aiBlockId` as the fallback
   * when the selection was cleared.
   */
  aiContextInput() {
    const item = this.currentItem();
    const live = this.selectedBlock();
    const blockId = this.ui.aiScope === "block" ? (live ? live.id : this.ui.aiBlockId) : null;
    if (this.ui.aiScope === "block" && blockId) this.ui.aiBlockId = blockId;
    return {
      scope: this.ui.aiScope,
      content_item_id: item ? item.id : null,
      block_id: blockId,
      instruction: String(this.ui.aiInstruction || ""),
      include: { ...(this.ui.aiInclude || {}) },
    };
  }
  /** Normalise any thrown value into a displayable `AiFailure`. */
  aiFailureFrom(error) {
    if (error instanceof AiFailure) return error;
    const code = typeof error?.code === "string" && AI_FAILURE_CODES.includes(error.code)
      ? error.code
      : "transport_unavailable";
    const message = String(error?.message || error || "").trim() ||
      "AI 请求没有完成，课程内容没有改动。";
    return new AiFailure(code, message, { details: error?.details ?? null });
  }
  aiSetScope(scope) {
    if (!["course", "lesson", "block"].includes(scope)) return;
    this.ui.aiScope = scope;
    if (scope === "block") {
      const live = this.selectedBlock();
      if (live) this.ui.aiBlockId = live.id;
    }
    // A preview made for the previous scope would misreport what is sent.
    this.ui.aiContext = null;
    this.ui.aiContextOpen = false;
    this.ui.aiError = null;
    this.scheduleSessionSave();
    this.notify();
  }
  aiToggleContext(key) {
    if (!["requirements", "assets", "completion", "nearby"].includes(key)) return;
    const include = { ...(this.ui.aiInclude || {}) };
    include[key] = include[key] === false;
    this.ui.aiInclude = include;
    if (this.ui.aiContextOpen) {
      // Re-assemble so the preview keeps matching the toggles exactly.
      this.aiPreviewContext();
      return;
    }
    this.ui.aiContext = null;
    this.notify();
  }
  aiToggleChanges() {
    this.ui.aiWantsChanges = this.ui.aiWantsChanges !== true;
    this.notify();
  }
  aiSetProvider(id) {
    const providerId = String(id || "").trim();
    if (!providerId) return;
    this.ui.aiProviderId = providerId;
    const descriptor = this.aiDescriptor();
    const models = Array.isArray(descriptor?.models) ? descriptor.models : [];
    if (!models.includes(this.ui.aiModel)) {
      this.ui.aiModel = descriptor?.default_model || models[0] || "";
    }
    this.ui.aiProviderForm = null;
    this.ui.aiError = null;
    this.scheduleSessionSave();
    if (this.ui.aiSettingsOpen && providerId !== "fake") {
      this.aiEditProvider(providerId, { preserveSelection: true });
      return;
    }
    this.notify();
  }
  aiSetModel(model) {
    this.ui.aiModel = String(model || "").trim();
    this.scheduleSessionSave();
    this.notify();
  }
  /**
   * Assemble and remember the context that would be sent.  A pure read: no
   * canonical row is created, so previewing can never change the course.
   */
  aiPreviewContext() {
    try {
      this.ui.aiContext = assembleAiContext(this.data, this.aiContextInput());
      this.ui.aiContextOpen = true;
      this.ui.aiError = null;
      if (this.ui.aiStatus === "failed") this.ui.aiStatus = "idle";
    } catch (error) {
      // An `AiFailure` (no lesson, no block, …) becomes a readable banner and
      // must never escape as an unhandled action error.
      this.ui.aiContext = null;
      this.ui.aiContextOpen = false;
      this.ui.aiError = this.aiFailureFrom(error);
      this.ui.aiStatus = "failed";
    }
    this.notify();
  }
  /**
   * Run one AI request.
   *
   *  - assembling the context is a pure read;
   *  - the ContextPack / Suggestion / ChangeDraft are written through
   *    `commit`, so undo, redo and autosave behave exactly like manual edits;
   *  - no run ever touches a block, requirement or asset, and every failure
   *    leaves the course unchanged.
   */
  async aiRun() {
    if (this.ui.aiStatus === "running") return;
    let context;
    try {
      context = assembleAiContext(this.data, this.aiContextInput());
    } catch (error) {
      this.ui.aiContext = null;
      this.ui.aiContextOpen = false;
      this.ui.aiError = this.aiFailureFrom(error);
      this.ui.aiStatus = "failed";
      this.notify();
      return;
    }
    const descriptor = this.aiDescriptor() || {
      id: String(this.ui.aiProviderId || "").trim(),
      label: String(this.ui.aiProviderId || "").trim() || "未配置连接",
    };
    const instruction = String(this.ui.aiInstruction || "");
    this.ui.aiContext = context;
    this.ui.aiContextOpen = true;
    this.ui.aiError = null;
    this.ui.aiResult = null;
    this.ui.aiDraftId = null;
    this.ui.aiStatus = "running";
    this.ui.aiRunId = uid();
    const runId = this.ui.aiRunId;
    const startedAt = now();
    this.notify();

    let completion = null;
    let failure = null;
    try {
      completion = await this.aiConnector().complete({
        instruction,
        context,
        wants_changes: this.ui.aiWantsChanges === true,
      });
    } catch (error) {
      failure = this.aiFailureFrom(error);
    }
    // A newer run (or a cancel) owns the panel now; this one must not overwrite it.
    if (this.ui.aiRunId !== runId) return;

    // Cancelling is a decision, not a suggestion: even a late success is
    // reported as cancelled and produces no Suggestion or ChangeDraft.
    const cancelled = this.ui.aiStatus === "cancelled" ||
      (failure !== null && failure.code === "cancelled");
    if (cancelled) {
      completion = null;
      failure = failure && failure.code === "cancelled"
        ? failure
        : new AiFailure("cancelled", "这次 AI 请求已经取消，课程内容没有任何改动。");
    }

    let suggestionId = null;
    let draftId = null;
    let outcome = "none";
    let status = "failed";
    if (failure) {
      this.ui.aiStatus = cancelled ? "cancelled" : "failed";
      this.ui.aiError = failure;
    } else {
      const answer = String(completion.answer || "");
      const changes = Array.isArray(completion.changes) ? completion.changes : [];
      // Build the canonical rows on a deep copy and commit the copy only when
      // every step succeeded — `commit` has no rollback, so writing the
      // ContextPack/Suggestion and then failing to build the ChangeDraft (for
      // example a change that names a block in another lesson) would otherwise
      // leave an unreviewed orphan behind.  Anything that throws here leaves
      // `this.data` byte-identical and writes nothing.
      const candidate = clone(this.data);
      let builtSuggestionId = null;
      let builtDraftId = null;
      try {
        const suggestion = createAiSuggestion(candidate, {
          context,
          answer,
          changes,
          modelMetadata: {
            provider_id: descriptor.id,
            model: completion.model || this.aiModel(),
            provider_label: descriptor.label,
            changes,
          },
        });
        builtSuggestionId = suggestion.id;
        if (changes.length > 0) {
          const draft = createAiChangeDraft(candidate, suggestion.id, changes, {
            reason: suggestion.title,
            scope: context.scope,
            provider: {
              provider_id: descriptor.id,
              model: completion.model || this.aiModel(),
            },
          });
          builtDraftId = draft.id;
        }
      } catch (error) {
        // The model answered, but the answer could not become canonical AI
        // rows.  Say so instead of pretending a suggestion exists.
        failure = this.aiFailureFrom(error);
        this.ui.aiError = failure;
        this.ui.aiStatus = "failed";
      }
      if (!failure) {
        this.commit("记录 AI 建议", () => {
          this.data = candidate;
        });
        suggestionId = builtSuggestionId;
        draftId = builtDraftId;
        status = "succeeded";
        outcome = draftId ? "change_draft" : "suggestion";
        this.ui.aiStatus = "done";
        this.ui.aiDraftId = draftId;
        this.ui.aiResult = {
          answer,
          suggestion_id: suggestionId,
          change_draft_id: draftId,
          outcome,
        };
      }
    }
    this.ui.aiRunId = null;

    await this.aiRecordExecution(buildAiExecutionRecord({
      project_id: this.data.project.id,
      started_at: startedAt,
      finished_at: now(),
      scope: context.scope,
      instruction,
      context,
      provider: { provider_id: descriptor.id, model: completion?.model || this.aiModel(), label: descriptor.label },
      status: failure ? (failure.code === "cancelled" ? "cancelled" : "failed") : status,
      error_code: failure ? failure.code : null,
      error_message: failure ? failure.message : "",
      outcome,
      suggestion_id: suggestionId,
      change_draft_id: draftId,
      review: { state: "pending", decided_at: null },
    }));
    this.notify();
  }
  /**
   * Ask the transport process to stop the in-flight request.
   *
   * The page deliberately does NOT abort its own `ai.complete` call: the
   * cancel request has to reach the process that holds the socket, and that
   * process answers the pending call with a `cancelled` failure.
   */
  async aiCancel() {
    const requestId = this.ui.aiRunId;
    if (!requestId) return false;
    this.ui.aiStatus = "cancelled";
    this.ui.aiError = new AiFailure("cancelled", "这次 AI 请求已经取消，课程内容没有任何改动。");
    this.notify();
    try {
      await this.bridge.command("ai.cancel", { request_id: requestId });
    } catch (error) {
      this.ui.toast = `取消请求没有送达本机服务。${userFacingError(error, "这次请求可能仍在运行。")}`;
      this.notify();
    }
    return true;
  }
  aiOpenDraft(id) {
    const draftId = String(id || "").trim();
    if (!draftId || !(this.data.change_drafts || []).some((draft) => draft.id === draftId)) return;
    this.ui.aiDraftId = draftId;
    this.notify();
  }
  aiDismissDraft() {
    this.ui.aiDraftId = null;
    this.notify();
  }
  /** Record why a draft cannot be applied; the draft itself stays reviewable. */
  aiMarkDraftInvalid(draftId, issues) {
    const list = (Array.isArray(issues) ? issues : []).map(String).filter(Boolean);
    this.commit("AI 修改未通过校验", (data) => {
      const draft = (data.change_drafts || []).find((candidate) => candidate.id === draftId);
      if (!draft) return;
      draft.validation = { checked_at: now(), ok: false, issues: list };
    });
    void this.aiRecordReview(draftId, "apply_failed");
    this.ui.toast = `这份 AI 修改现在不能应用：${
      list[0] || "正文已经变化，请重新生成 Diff"
    }（修改草稿已保留，可以重新生成后再应用）`;
    this.notify();
  }
  /**
   * Read the execution log back and pick the record one review decision belongs
   * to: the run's most recent *pending* record first, otherwise the most recent
   * record for that draft at all.  `ai.execution.list` is newest-first.
   */
  async aiFindExecutionRecord(draftId) {
    /** @type {Array<Record<string, any>>} */
    let records = [];
    try {
      // The desktop log is app-global, so ask for the whole bounded log (both
      // shells cap it at 200 records) rather than the newest page: the run
      // being reviewed can be older than the panel's 20-row history.
      const result = await this.bridge.command("ai.execution.list", { limit: 200 });
      records = Array.isArray(result)
        ? result
        : Array.isArray(result?.records)
        ? result.records
        : [];
    } catch {
      // A log that cannot be read is no reason to refuse the decision; the
      // in-memory list is the best remaining source.
      records = [];
    }
    if (records.length === 0 && Array.isArray(this.ui.aiExecutions)) {
      records = this.ui.aiExecutions;
    }
    const matching = records.filter((entry) => entry && entry.change_draft_id === draftId);
    return matching.find((entry) => entry.review?.state === "pending") || matching[0] || null;
  }
  /**
   * Record one draft's review decision.
   *
   * `ai.execution.append` upserts by record id in both shells, so the decision
   * updates the run's existing record in place instead of adding a second row:
   * the record is read back, only its `review` is replaced, and the very same
   * record — same `id`, `created_at`, `scope`, `provider`, `instruction` — is
   * written again.  Only when the log has no row for this run at all (an older
   * build wrote it, or the record was trimmed away) is one reconstructed from
   * the canonical draft, so the decision is still visible.
   *
   * Records are explicitly NOT canonical: a failure only warns, exactly like
   * `aiRecordExecution`, and can never change the Apply/Reject outcome.
   */
  async aiRecordReview(draftId, reviewState) {
    try {
      const decidedAt = now();
      let record = await this.aiFindExecutionRecord(draftId);
      if (record) {
        record = { ...clone(record), review: { state: reviewState, decided_at: decidedAt } };
      } else {
        const draft = (this.data.change_drafts || []).find((candidate) => candidate.id === draftId) || null;
        if (!draft) return;
        record = buildAiExecutionRecord({
          project_id: this.data.project.id,
          scope: draft.scope,
          provider: draft.provider,
          status: "succeeded",
          outcome: "change_draft",
          suggestion_id: draft.suggestion_id,
          change_draft_id: draftId,
          review: { state: reviewState, decided_at: decidedAt },
        });
      }
      await this.aiRecordExecution(record);
    } catch (error) {
      // Callers fire this off without awaiting, so it must never reject: the
      // decision itself has already been applied either way.
      this.ui.toast = "这次审核决定没有写进执行记录，但课程内容与保存状态不受影响。你可以继续使用。";
      this.notify();
    }
  }
  /**
   * Apply a reviewed draft.
   *
   * Validate first, apply on a deep copy, and only then commit that copy — so
   * a failure can never leave a half-written course.  On failure the draft is
   * kept (`status` stays `reviewing`) with `validation.ok = false` recorded,
   * which is what lets the user retry after regenerating the Diff.
   */
  aiApplyDraft(id) {
    const draftId = String(id || this.ui.aiDraftId || "").trim();
    if (!draftId) return false;
    if (!(this.data.change_drafts || []).some((draft) => draft.id === draftId)) {
      this.ui.aiDraftId = null;
      this.ui.toast = "这份 AI 修改草稿已经不存在了，请重新生成";
      this.notify();
      return false;
    }
    try {
      const validation = validateAiChangeDraft(this.data, draftId);
      if (!validation.ok) {
        this.aiMarkDraftInvalid(draftId, validation.issues);
        return false;
      }
    } catch (error) {
      this.ui.aiError = this.aiFailureFrom(error);
      this.notify();
      return false;
    }
    const candidate = clone(this.data);
    try {
      applyAiChangeDraft(candidate, draftId, { confirmed: true });
    } catch (error) {
      const failure = this.aiFailureFrom(error);
      const issues = failure.details && Array.isArray(failure.details.issues) && failure.details.issues.length
        ? failure.details.issues
        : [failure.message];
      this.ui.aiError = failure;
      this.aiMarkDraftInvalid(draftId, issues);
      return false;
    }
    // `commit` hands the mutation live `this.data`; the candidate was fully
    // applied before this point, so the swap below cannot half-write.
    this.commit("应用 AI 修改", () => {
      this.data = candidate;
    });
    void this.aiRecordReview(draftId, "applied");
    this.ui.aiDraftId = null;
    this.ui.aiStatus = "done";
    this.ui.toast = "已应用 AI 修改，可以用「撤销」回到应用前";
    this.notify();
    return true;
  }
  aiRejectDraft(id) {
    const draftId = String(id || this.ui.aiDraftId || "").trim();
    if (!draftId) return false;
    try {
      this.commit("拒绝 AI 修改", (data) => {
        rejectAiChangeDraft(data, draftId, {});
      });
    } catch (error) {
      this.ui.aiError = this.aiFailureFrom(error);
      this.ui.toast = this.ui.aiError.message;
      this.notify();
      return false;
    }
    if (this.ui.aiDraftId === draftId) this.ui.aiDraftId = null;
    void this.aiRecordReview(draftId, "rejected");
    this.ui.toast = "已拒绝这份 AI 修改，正文、待补和素材都没有改动";
    this.notify();
    return true;
  }
  /**
   * Refresh the non-canonical AI side files (provider list + execution log).
   * Called once a project is open; every failure is contained.
   */
  refreshAiSideFiles() {
    void this.aiLoadProviders();
    void this.aiLoadExecutions();
  }
  /**
   * Drop the AI state that belongs to the project being replaced, then re-read
   * the shell's AI side files.
   *
   * Every path that swaps `this.data` wholesale for another project's data must
   * call this — new project, payload load, open, external reload/resolution,
   * recovery restore, an import that returns a whole project.  Otherwise the
   * panel keeps rendering the previous project's history (the desktop shell
   * stores the log app-globally), its Diff or its answer against the new
   * project.  The side files are re-read afterwards, because in the browser
   * shell both the provider list and the execution log live in the project.
   *
   * Deliberately not called by the AI's own commits (a run/apply replacing
   * `this.data` with its candidate) or by undo/redo: those stay inside the same
   * project, and `aiSyncScope()` already prunes ids that no longer exist.
   * Reader preferences (`aiScope`/`aiProviderId`/`aiModel`/`aiInclude`/
   * `aiInstruction`) survive a project switch on purpose — they are session
   * state, not project state.
   */
  resetAiState() {
    this.ui.aiContext = null;
    this.ui.aiContextOpen = false;
    this.ui.aiDraftId = null;
    this.ui.aiResult = null;
    this.ui.aiError = null;
    this.ui.aiStatus = "idle";
    this.ui.aiRunId = null;
    this.ui.aiBlockId = null;
    this.ui.aiExecutions = [];
    this.ui.aiExecutionsOpen = false;
    this.ui.aiProviderForm = null;
    this.refreshAiSideFiles();
  }
  /** Both shells keep provider metadata local and API Keys in macOS Keychain. */
  aiStorageLabel() {
    return this.bridge.isNative()
      ? "macOS 系统钥匙串"
      : "macOS 系统钥匙串（本机浏览器服务）";
  }
  /**
   * What this workflow may call besides the provider's chat endpoint.  Read
   * from the same source the execution record uses, so the panel's disclosure
   * cannot drift from what a run actually does (V0 calls no tools, MCP server
   * or Skill).
   */
  aiCapabilities() {
    return buildAiExecutionRecord({}).capabilities;
  }
  /** `ai.connection.list` → provider configs plus credential *presence*. */
  async aiLoadProviders() {
    try {
      const result = await this.bridge.command("ai.connection.list", {});
      const value = result && typeof result === "object" ? result : {};
      this.ui.aiProviders = Array.isArray(value.providers) ? value.providers : [];
      this.ui.aiConfigured = value.configured && typeof value.configured === "object"
        ? value.configured
        : {};
      this.ui.aiCredentialOrigins = value.credential_origins &&
          typeof value.credential_origins === "object"
        ? value.credential_origins
        : {};
      this.notify();
      return this.ui.aiProviders;
    } catch (error) {
      // Provider config is not canonical: failing to read it must never break
      // project loading.  The panel keeps the shipped catalog and says why.
      this.ui.aiError = this.aiFailureFrom(error);
      this.notify();
      return [];
    }
  }
  aiEditProvider(id, { preserveSelection = false } = {}) {
    const providerId = String(id || this.ui.aiProviderId || "").trim();
    if (!providerId) return;
    if (!preserveSelection && providerId !== this.ui.aiProviderId) this.aiSetProvider(providerId);
    const descriptor = this.aiDescriptor(providerId);
    if (!descriptor) {
      // §9.2: there is no template to open a form from. Only a connection the
      // shell actually holds can be edited.
      this.ui.toast = "这个连接还没有保存，没有可编辑的配置。";
      this.notify();
      return;
    }
    this.ui.aiProviderForm = {
      ...descriptor,
      models: Array.isArray(descriptor.models) ? descriptor.models : [],
      isNew: false,
    };
    this.ui.aiChosenModel = descriptor.default_model || descriptor.models?.[0] || "";
    this.ui.aiManualModel = "";
    this.ui.aiModelOptions = Array.isArray(descriptor.models) ? [...descriptor.models] : [];
    this.ui.aiModelSelection = [];
    this.ui.aiModelSource = this.ui.aiModelOptions.length ? "saved" : "";
    this.ui.aiModelsError = "";
    this.ui.aiSettingsOpen = true;
    // 设置 always opens (or refreshes) the form.  It used to toggle shut on a
    // second click, which closed the address/key fields exactly when the user
    // was looking for them.
    this.ui.focusField = "ai-provider-label";
    this.notify();
  }
  /**
   * Open an EMPTY provider form (§9.4).  The Provider ID is a field the user
   * types: it is pre-filled with a suggestion only so the form is never blank,
   * and it becomes permanent once the connection is saved.  Nothing here touches
   * the shell — a created-but-unsaved connection has no credential slot and
   * cannot be selected for a run.
   */
  aiCreateConnection() {
    const ids = new Set(
      (Array.isArray(this.ui.aiProviders) ? this.ui.aiProviders : [])
        .map((provider) => String(provider?.id || "").trim())
        .filter(Boolean),
    );
    let id;
    do { id = `connection-${uid()}`; } while (ids.has(id));
    this.ui.aiProviderForm = this.connectionRecord({
      id,
      label: "",
      base_url: "",
      api_protocol: "openai-completions",
      default_model: "",
      models: [],
    });
    this.ui.aiProviderForm.isNew = true;
    this.ui.aiChosenModel = "";
    this.ui.aiManualModel = "";
    this.ui.aiModelOptions = [];
    this.ui.aiModelSelection = [];
    this.ui.aiModelSource = "";
    this.ui.aiModelsError = "";
    this.ui.aiSettingsOpen = true;
    // The id is the first thing a user must decide, so it gets the caret.
    this.ui.focusField = "ai-provider-id";
    this.notify();
  }
  aiToggleSettings() {
    if (this.ui.aiSettingsOpen) return this.aiCloseSettings();
    this.ui.aiSettingsOpen = true;
    if (!this.ui.aiProviderForm) {
      const selected = (this.ui.aiProviders || []).find((entry) => entry?.id === this.ui.aiProviderId);
      if (selected?.kind !== "openai_chatgpt_subscription") this.aiEditProvider(this.ui.aiProviderId, { preserveSelection: true });
    }
    this.notify();
  }
  aiCloseSettings() {
    for (const input of root.querySelectorAll?.("[data-ai-secret], [data-ai-temporary-secret]") || []) {
      input.value = "";
    }
    this.ui.aiSettingsOpen = false;
    this.ui.aiProviderForm = null;
    this.ui.aiConnectionTestStatus = null;
    this.ui.focusField = "";
    this.notify();
  }
  async aiSubscriptionStart(providerId = "") {
    if (!this.bridge.isNative()) {
      this.ui.aiSubscriptionAttempt = { status: "unavailable", message: "订阅登录需要 macOS 桌面版。" };
      this.notify();
      return false;
    }
    if (this.ui.aiSubscriptionAttempt?.status === "pending") return false;
    try {
      const result = await this.bridge.command("ai.subscription.start", providerId ? { provider_id: providerId } : {});
      this.ui.aiSubscriptionAttempt = result;
      this.notify();
      void this.aiPollSubscription(String(result?.attempt_id || ""));
      return true;
    } catch (error) {
      const failure = this.aiFailureFrom(error);
      this.ui.aiSubscriptionAttempt = { status: "error", message: failure.message };
      this.notify();
      return false;
    }
  }
  async aiPollSubscription(attemptId) {
    if (!attemptId) return;
    for (let count = 0; count < 320; count++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const result = await this.bridge.command("ai.subscription.status", { attempt_id: attemptId });
        this.ui.aiSubscriptionAttempt = result;
        this.notify();
        if (result?.status !== "pending") {
          if (result?.status === "connected") await this.aiLoadProviders();
          return;
        }
      } catch (error) {
        this.ui.aiSubscriptionAttempt = { status: "error", message: this.aiFailureFrom(error).message };
        this.notify();
        return;
      }
    }
  }
  async aiSubscriptionCancel() {
    const attemptId = String(this.ui.aiSubscriptionAttempt?.attempt_id || "");
    if (!attemptId) return false;
    try {
      await this.bridge.command("ai.subscription.cancel", { attempt_id: attemptId });
      this.ui.aiSubscriptionAttempt = { attempt_id: attemptId, status: "cancelled", message: "登录已取消" };
      this.notify();
      return true;
    } catch (error) {
      this.ui.aiSubscriptionAttempt = { attempt_id: attemptId, status: "error", message: this.aiFailureFrom(error).message };
      this.notify();
      return false;
    }
  }
  async aiSubscriptionLogout(providerId) {
    const id = String(providerId || "").trim();
    if (!id) return false;
    try {
      const result = await this.bridge.command("ai.subscription.logout", { provider_id: id });
      await this.aiLoadProviders();
      this.ui.toast = result?.remote_revoked
        ? "已退出 ChatGPT 订阅账户并确认撤销远程会话"
        : "已清除本机订阅会话；远程撤销未确认，可在 ChatGPT 设置中断开 Workbench";
      this.notify();
      return true;
    } catch (error) {
      this.ui.toast = `退出订阅账户失败：${this.aiFailureFrom(error).message}`;
      this.notify();
      return false;
    }
  }
  async aiDeleteConnection(providerId) {
    const id = String(providerId || "").trim();
    if (!id || id === "fake") return false;
    const saved = (Array.isArray(this.ui.aiProviders) ? this.ui.aiProviders : [])
      .find((entry) => entry && entry.id === id) || null;
    const label = String(saved?.label || "").trim() || id;
    if (globalThis.confirm?.(`删除连接「${label}」及其本机密钥？此操作不会改动课程内容。`) === false) return false;
    try {
      await this.bridge.command("ai.connection.delete", { provider_id: id });
    } catch (error) {
      this.ui.aiError = this.aiFailureFrom(error);
      this.ui.toast = `连接没有删除：${this.ui.aiError.message}`;
      this.notify();
      return false;
    }
    // Deleting the selected connection leaves NO selection: the assistant falls
    // back to「配置 AI」rather than silently answering from the offline
    // deterministic connector.
    if (this.ui.aiProviderId === id) {
      this.ui.aiProviderId = "";
      this.ui.aiModel = "";
      this.scheduleSessionSave();
    }
    if (this.ui.aiProviderForm?.id === id) this.ui.aiProviderForm = null;
    await this.aiLoadProviders();
    this.ui.toast = `已删除连接「${id}」及其本机密钥`;
    this.notify();
    return true;
  }
  /**
   * P2-1: ask the provider what models it offers, using the credential that is
   * already in the system store.  The list is never hardcoded, and a failure is
   * not an error state: it switches the form to manual Model ID entry.
   */
  async aiDiscoverModels() {
    const form = this.ui.aiProviderForm || {};
    const providerId = String(form.id || this.ui.aiProviderId || "").trim();
    const baseUrl = String(
      (root.querySelector("[data-ai-base-url]") || {}).value || form.base_url || "",
    ).trim();
    const apiProtocol = String(
      (root.querySelector("[data-ai-api-protocol]") || {}).value || form.api_protocol || "openai-completions",
    );
    const temporaryKey = String(root.querySelector("[data-ai-secret]")?.value || "").trim();
    if (!providerId || providerId === "fake") {
      this.ui.toast = "离线连接器没有模型列表可以读取。";
      this.notify();
      return [];
    }
    if (!baseUrl) {
      this.ui.aiModelsError = "请先填写 Base URL";
      this.ui.aiModelSource = "manual";
      this.ui.focusField = "ai-base-url";
      this.notify();
      return [];
    }
    const savedProvider = (Array.isArray(this.ui.aiProviders) ? this.ui.aiProviders : [])
      .find((entry) => entry && entry.id === providerId) || null;
    const sameSavedEndpoint = savedProvider &&
      String(savedProvider.base_url || "").trim() === baseUrl &&
      String(savedProvider.api_protocol || "openai-completions") === apiProtocol;
    const useSavedCredential = sameSavedEndpoint && this.ui.aiConfigured?.[providerId] === true;
    if (!useSavedCredential && !temporaryKey) {
      this.ui.aiModelsError = "输入临时 API Key 以探测未保存的地址，或先保存连接和密钥";
      this.ui.aiModelSource = "manual";
      this.ui.focusField = "ai-secret";
      this.notify();
      return [];
    }
    // A key used only for this discovery request is never retained for a later
    // render, even when the request fails.
    if (!useSavedCredential) {
      const secretInput = root.querySelector("[data-ai-secret]");
      if (secretInput) secretInput.value = "";
    }
    this.ui.aiModelsBusy = true;
    this.ui.aiModelsError = "";
    this.notify();
    let models = [];
    let displayNames = {};
    try {
      const result = useSavedCredential
        ? await this.bridge.command("ai.models.list", { provider_id: providerId })
        : await this.bridge.command("ai.models.probe", {
          provider: {
            id: providerId,
            label: String(form.label || providerId),
            kind: "openai_compatible",
            base_url: baseUrl,
            chat_path: String(form.chat_path || "/chat/completions"),
            api_protocol: apiProtocol,
            auth_header: apiProtocol === "anthropic-messages" ? "x-api-key" : "authorization",
            auth_scheme: apiProtocol === "anthropic-messages" ? "" : "Bearer",
          },
          temporary_credential: temporaryKey,
        });
      models = aiDiscoveredModelIds(result);
      displayNames = result?.display_names && typeof result.display_names === "object"
        ? Object.fromEntries(Object.entries(result.display_names).filter(([, label]) => typeof label === "string"))
        : {};
    } catch (error) {
      this.ui.aiModelsBusy = false;
      this.ui.aiModelsError = this.aiFailureFrom(error).message;
      this.ui.aiModelSource = "manual";
      this.ui.focusField = "ai-model-manual";
      this.notify();
      return [];
    }
    this.ui.aiModelsBusy = false;
    models = models.map((model) => String(model || "").trim()).filter(Boolean);
    if (!models.length) {
      this.ui.aiModelsError = "服务商没有返回任何模型名";
      this.ui.aiModelSource = "manual";
      this.ui.focusField = "ai-model-manual";
      this.notify();
      return [];
    }
    this.ui.aiModelOptions = models;
    this.ui.aiModelLabels = displayNames;
    this.ui.aiModelSource = "remote";
    this.ui.aiModelsError = "";
    // A fresh catalog replaces the previous tick marks; §9.5 forbids keeping
    // anything from an older discovery round once the list changed.
    this.ui.aiModelSelection = [];
    if (!models.includes(this.ui.aiChosenModel)) this.ui.aiChosenModel = models[0];
    this.notify();
    return models;
  }
  /** Pick one of the discovered models.  Manual entry always wins if filled. */
  aiPickModel(id) {
    const model = String(id || "").trim();
    if (!model) return;
    this.ui.aiChosenModel = model;
    this.ui.aiManualModel = "";
    if (this.ui.aiProviderForm) this.ui.aiProviderForm.default_model = model;
    this.notify();
  }
  /**
   * The Provider ID is a permanent identity (§9.4): editable only while the
   * connection is unsaved.  Re-typing it after a save is a different connection,
   * and the shell refuses it — so the form refuses first and says why.
   */
  aiSetProviderId(value) {
    const form = this.ui.aiProviderForm;
    if (!form) return;
    if (form.isNew !== true) {
      this.ui.toast = "Provider ID 创建后不可修改；需要另一个 id 请点「+ 添加模型服务商」新建连接。";
      this.notify();
      return;
    }
    const id = String(value || "").trim();
    const issue = this.providerIdIssue(id);
    if (issue) {
      this.ui.toast = issue;
      this.notify();
      return;
    }
    const taken = (Array.isArray(this.ui.aiProviders) ? this.ui.aiProviders : [])
      .some((entry) => entry && entry.id === id);
    if (taken) {
      this.ui.toast = `已有连接使用 Provider ID「${id}」，请换一个。`;
      this.notify();
      return;
    }
    form.id = id;
    this.notify();
  }
  /** §9.6: tick or untick one model in the discovered catalog. */
  aiToggleModelSelection(id) {
    const model = String(id || "").trim();
    if (!model) return;
    const selection = new Set(
      Array.isArray(this.ui.aiModelSelection) ? this.ui.aiModelSelection : [],
    );
    if (selection.has(model)) selection.delete(model);
    else selection.add(model);
    this.ui.aiModelSelection = [...selection];
    this.notify();
  }
  /**
   * Move the ticked catalog entries into the connection's model list.  Still
   * only a form: nothing reaches the shell until 保存 (§9.5).
   */
  aiAddSelectedModels() {
    const form = this.ui.aiProviderForm;
    if (!form) return;
    const chosen = (Array.isArray(this.ui.aiModelSelection) ? this.ui.aiModelSelection : [])
      .map((model) => String(model || "").trim())
      .filter(Boolean);
    if (!chosen.length) {
      this.ui.toast = "先在模型目录里勾选至少一个模型。";
      this.notify();
      return;
    }
    const models = [...new Set([
      ...(Array.isArray(form.models) ? form.models : []),
      ...chosen,
    ])];
    form.models = models;
    if (!form.default_model) {
      form.default_model = chosen[0];
      this.ui.aiChosenModel = chosen[0];
    }
    this.ui.aiModelSelection = [];
    this.ui.toast = `已加入 ${chosen.length} 个模型，保存连接后才会生效。`;
    this.notify();
  }
  async aiTestConnection() {
    const form = this.ui.aiProviderForm || {};
    const providerId = String(form.id || this.ui.aiProviderId || "").trim();
    const saved = (this.ui.aiProviders || []).find((provider) => provider?.id === providerId);
    const current = {
      base_url: String(root.querySelector("[data-ai-base-url]")?.value || form.base_url || "").trim(),
      api_protocol: String(root.querySelector("[data-ai-api-protocol]")?.value || form.api_protocol || "openai-completions"),
      default_model: String(root.querySelector("[data-ai-model-manual]")?.value || this.ui.aiChosenModel || form.default_model || "").trim(),
    };
    if (!saved ||
      String(saved.base_url || "").trim() !== current.base_url ||
      String(saved.api_protocol || "openai-completions") !== current.api_protocol ||
      String(saved.default_model || "") !== current.default_model) {
      this.ui.aiConnectionTestStatus = { state: "error", message: "请先保存当前 Base URL、协议和默认模型，再测试连接。" };
      this.notify();
      return false;
    }
    if (this.ui.aiConfigured?.[providerId] !== true) {
      this.ui.aiConnectionTestStatus = { state: "error", message: "先保存 API Key，再运行连接测试。" };
      this.notify();
      return false;
    }
    this.ui.aiConnectionTestStatus = { state: "busy", message: "正在发送最小测试请求…" };
    this.notify();
    try {
      const result = await this.bridge.command("ai.connection.test", { provider_id: providerId });
      this.ui.aiConnectionTestStatus = {
        state: "ok",
        message: `连接成功：${String(result?.model || current.default_model)}（固定短提示，不读取课程内容）`,
      };
      this.notify();
      return true;
    } catch (error) {
      const failure = this.aiFailureFrom(error);
      this.ui.aiConnectionTestStatus = { state: "error", message: failure.message };
      this.notify();
      return false;
    }
  }
  /** Save a provider's address / model names.  Never a credential. */
  aiOriginForCredential(value) {
    try {
      const parsed = new URL(String(value || "").trim());
      return ["https:", "http:"].includes(parsed.protocol) ? parsed.origin : null;
    } catch {
      return null;
    }
  }
  /**
   * §9.4 — an address is checked while it is typed, not when the first request
   * fails on it.  The rules are the ones the credential-origin binding already
   * uses (`normalizedOrigin` in the service layer): http or https, a real host,
   * and no user or password embedded in the URL — a key belongs in the API key
   * field, where it goes to the keychain instead of into project.json.
   *
   * The bad value is never echoed back: a pasted URL can itself carry a secret.
   *
   * @returns {string} a user-facing reason, or `""` when the address is usable
   */
  baseUrlIssue(value) {
    const raw = String(value || "").trim();
    if (!raw) return "请填写 Base URL，例如 https://api.example.com/v1。";
    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch {
      return "Base URL 不是一个完整地址，需要包含 https:// 或 http:// 和域名。";
    }
    if (!["https:", "http:"].includes(parsed.protocol)) {
      return "Base URL 只支持 https:// 或 http:// 开头的地址。";
    }
    if (!parsed.hostname) return "Base URL 缺少域名，例如 https://api.example.com/v1。";
    if (parsed.username || parsed.password) {
      return "Base URL 里不能带用户名或密码；API Key 请填写在下面的 API Key 输入框。";
    }
    return "";
  }
  /**
   * Keep what the user typed in front of them.  The form fields render from
   * `ui.aiProviderForm`, so a refusal that only sets a toast and re-renders
   * silently throws away the whole half-filled connection.
   */
  rememberProviderForm(input = {}) {
    const current = this.ui.aiProviderForm || {};
    this.ui.aiProviderForm = {
      ...current,
      id: String(input.id || current.id || "").trim(),
      label: String(input.label || "").trim(),
      base_url: String(input.base_url || "").trim(),
      api_protocol: String(
        input.api_protocol || current.api_protocol || "openai-completions",
      ),
      default_model: String(input.default_model || "").trim(),
      models: Array.isArray(input.models) ? input.models : current.models || [],
    };
  }

  async aiSaveProvider(input = {}) {
    this.rememberProviderForm(input);
    const id = String(input.id || this.ui.aiProviderForm?.id || this.ui.aiProviderId || "").trim();
    if (!id) {
      this.ui.toast = "请先选择要配置的服务商";
      this.notify();
      return false;
    }
    if (id === "fake") {
      this.ui.toast = "「本地确定性连接器」完全离线，不需要地址或密钥，也没有可保存的配置";
      this.notify();
      return false;
    }
    const idIssue = this.providerIdIssue(id);
    if (idIssue) {
      this.ui.toast = idIssue;
      this.notify();
      return false;
    }
    const existing = (Array.isArray(this.ui.aiProviders) ? this.ui.aiProviders : [])
      .find((entry) => entry && entry.id === id) || null;
    const requestedProtocol = String(
      input.api_protocol || this.ui.aiProviderForm?.api_protocol ||
        existing?.api_protocol || "openai-completions",
    );
    // An unknown protocol is a stated failure, not something to quietly coerce
    // into the first choice (§19: never collapse a failure into a generic one).
    if (!aiIsKnownApiProtocol(requestedProtocol)) {
      this.ui.toast = `不支持的 API 协议「${requestedProtocol || "（空）"}」，只支持：${aiApiProtocolChoices()
        .map((choice) => choice.label)
        .join(" / ")}。`;
      this.notify();
      return false;
    }
    const protocol = requestedProtocol;
    const baseUrl = String(input.base_url || "").trim();
    // A subscription connection has no address of its own — the native login flow
    // configures it — so only an API connection is checked here.
    const baseUrlProblem = existing?.kind === "openai_chatgpt_subscription"
      ? ""
      : this.baseUrlIssue(baseUrl);
    if (baseUrlProblem) {
      this.ui.toast = `服务商配置没有保存：${baseUrlProblem}`;
      this.notify();
      return false;
    }
    const chosenModels = Array.isArray(input.models)
      ? input.models
      : Array.isArray(this.ui.aiProviderForm?.models)
      ? this.ui.aiProviderForm.models
      : [];
    const provider = {
      id,
      label: String(input.label || id).trim() || id,
      kind: existing?.kind || "openai_compatible",
      base_url: baseUrl,
      chat_path: String(input.chat_path || (existing && existing.chat_path) || "/chat/completions"),
      api_protocol: protocol,
      auth_header: protocol === "anthropic-messages" ? "x-api-key" : "authorization",
      auth_scheme: protocol === "anthropic-messages" ? "" : "Bearer",
      default_model: String(input.default_model || "").trim(),
      models: [...new Set(chosenModels.map((model) => String(model || "").trim()).filter(Boolean))],
    };
    const hasCredential = this.ui.aiConfigured?.[id] === true;
    const boundOrigin = this.ui.aiCredentialOrigins?.[id] || null;
    const targetOrigin = this.aiOriginForCredential(provider.base_url);
    let confirmCredentialOrigin = false;
    if (hasCredential && boundOrigin !== targetOrigin) {
      const oldLabel = boundOrigin || "未绑定域名";
      const newLabel = targetOrigin || "无效或空域名";
      const prompt = "此连接的 API Key 当前绑定到 " + oldLabel +
        "。目标域名将改为 " + newLabel +
        "。确认后，保存的 Key 会发送到新域名。只有信任该域名时继续。";
      confirmCredentialOrigin = typeof globalThis.confirm === "function" &&
        globalThis.confirm(prompt) === true;
      if (!confirmCredentialOrigin) {
        this.ui.toast = "连接仍绑定到 " + oldLabel + "；未保存更改，也未发送 API Key";
        this.notify();
        return false;
      }
    }
    try {
      await this.bridge.command("ai.connection.save", {
        provider,
        ...(confirmCredentialOrigin ? { confirm_credential_origin: true } : {}),
      });
    } catch (error) {
      this.ui.aiError = this.aiFailureFrom(error);
      this.ui.toast = `服务商配置没有保存：${this.ui.aiError.message}`;
      this.notify();
      return false;
    }
    this.ui.aiProviderForm = {
      ...(this.ui.aiProviderForm || {}),
      id: provider.id,
      label: provider.label,
      base_url: provider.base_url,
      chat_path: provider.chat_path,
      api_protocol: provider.api_protocol,
      auth_header: provider.auth_header,
      auth_scheme: provider.auth_scheme,
      default_model: provider.default_model,
      models: provider.models,
    };
    await this.aiLoadProviders();
    // The saved model is now the model: mirror it back into the form state so
    // the preview line cannot keep showing a choice that was not saved.
    this.ui.aiChosenModel = provider.default_model;
    this.ui.aiManualModel = "";
    if (this.ui.aiProviderId === provider.id) {
      this.ui.aiModel = provider.default_model || provider.models[0] || "";
    }
    // Keep the form open and move the caret to the key field: 保存配置 is the
    // first half of "configure this provider", the key is the second.
    this.ui.focusField = provider.id === "fake" ? "" : "ai-secret";
    this.ui.toast = `已保存「${provider.label}」的地址与模型名（不包含密钥）${
      provider.id === "fake" ? "" : "；接着可以粘贴 API Key"
    }`;
    this.notify();
    return true;
  }
  /**
   * Make sure a connection has a record on disk before its key is stored.  A key
   * for a provider the shell does not know reads back as "not configured", so an
   * unsaved form would silently lose its key on the next reload.
   *
   * The record saved here is the one already on screen, put through the same
   * normalisation the form uses, so switching protocol cannot leave a stored
   * `auth_scheme` behind that contradicts the new `auth_header`.
   */
  async ensureProviderRecord(providerId) {
    const id = String(providerId || "").trim();
    const saved = (Array.isArray(this.ui.aiProviders) ? this.ui.aiProviders : [])
      .some((entry) => entry && entry.id === id);
    if (saved) return;
    const form = this.ui.aiProviderForm;
    const source = form && String(form.id || "").trim() === id
      ? form
      : this.aiDescriptor(id);
    if (!source || String(source.id || "").trim() !== id) return;
    if (aiIsOfflineConnection(source)) return;
    const provider = { ...this.connectionRecord(source) };
    delete provider.requires_credential;
    if (!provider.base_url) return;
    await this.bridge.command("ai.connection.save", { provider });
  }
  /**
   * Store one credential through the transport process.  The value lives only
   * in the DOM node (a masked `<input type="password">`) until submit: it is
   * never mirrored into `ui`, never kept after submit, never logged.
   *
   * "已配置密钥" is only ever claimed from the shell's own read-back
   * (`ai.connection.list`), never from the fact that we called set().
   */
  async aiSaveSecret(value, requestedProviderId = null) {
    const providerId = String(requestedProviderId || this.ui.aiProviderForm?.id || this.ui.aiProviderId || "").trim();
    const secret = String(value ?? "");
    if (!providerId || providerId === "fake") {
      this.ui.toast = "这个服务商不需要密钥";
      this.notify();
      return false;
    }
    if (!secret.trim()) {
      this.ui.toast = "请先填写 API Key，再保存";
      this.notify();
      return false;
    }
    const savedProvider = (Array.isArray(this.ui.aiProviders) ? this.ui.aiProviders : [])
      .find((entry) => entry && entry.id === providerId) || null;
    const draftBaseUrl = String(
      (root.querySelector("[data-ai-base-url]") || {}).value ||
        this.ui.aiProviderForm?.base_url ||
        savedProvider?.base_url ||
        "",
    ).trim();
    if (
      savedProvider &&
      this.aiOriginForCredential(draftBaseUrl) !==
        (this.ui.aiCredentialOrigins?.[providerId] ||
          this.aiOriginForCredential(savedProvider.base_url))
    ) {
      this.ui.toast = "请先保存服务地址并确认 API Key 的新使用域名，再保存密钥";
      this.notify();
      return false;
    }
    try {
      await this.ensureProviderRecord(providerId);
      await this.bridge.command("ai.secret.set", { provider_id: providerId, value: secret });
    } catch (error) {
      this.ui.aiError = this.aiFailureFrom(error);
      this.ui.toast = `密钥没有保存：${this.ui.aiError.message}`;
      this.notify();
      return false;
    }
    await this.aiLoadProviders();
    this.ui.aiError = null;
    const configured = Boolean(this.ui.aiConfigured?.[providerId]);
    this.ui.toast = configured
      ? `API Key 已保存到${this.aiStorageLabel()}，并已读回确认（不回显，也不进入课程文件）`
      : "密钥写入后没有读回，暂时不能确认保存成功。请重试；如果一直失败，请检查系统钥匙串权限。";
    this.notify();
    return configured;
  }
  async aiDeleteSecret(requestedProviderId = null) {
    const providerId = String(requestedProviderId || this.ui.aiProviderForm?.id || this.ui.aiProviderId || "").trim();
    if (!providerId || providerId === "fake") return false;
    if (globalThis.confirm?.("删除这个服务商在本机保存的 API Key？（课程内容不受影响）") === false) return false;
    try {
      await this.bridge.command("ai.secret.delete", { provider_id: providerId });
    } catch (error) {
      this.ui.aiError = this.aiFailureFrom(error);
      this.ui.toast = `密钥没有删除：${this.ui.aiError.message}`;
      this.notify();
      return false;
    }
    await this.aiLoadProviders();
    this.ui.toast = "已删除本机保存的密钥；下次运行前需要重新填写";
    this.notify();
    return true;
  }
  /**
   * Read the execution log for the panel.  Non-canonical, so failures stay
   * soft.
   *
   * The desktop shell keeps the log app-globally, so a read can carry other
   * projects' runs: only records stamped with this project's id are shown, so
   * project A's history can never appear inside project B.  The review upsert
   * reads the unfiltered list itself (it must find the run it is deciding on).
   */
  async aiLoadExecutions() {
    try {
      const result = await this.bridge.command("ai.execution.list", { limit: 50 });
      const records = Array.isArray(result)
        ? result
        : Array.isArray(result?.records)
        ? result.records
        : [];
      const projectId = this.data.project?.id || null;
      this.ui.aiExecutions = records
        .filter((record) => record && record.project_id === projectId)
        .slice(0, 20);
      this.notify();
      return this.ui.aiExecutions;
    } catch (error) {
      this.ui.toast = "执行记录暂时读不到，但课程内容不受影响。你可以继续使用，稍后再试。";
      this.notify();
      return [];
    }
  }
  /**
   * Append or update one execution record.
   *
   * Records are explicitly NOT canonical: a failed write only warns, never
   * touches `saveStatus`, and never blocks an Apply.  The in-memory list
   * mirrors the transports, which upsert by record id: re-writing the same
   * record (a review decision) updates its row in place instead of adding a
   * duplicate.
   */
  async aiRecordExecution(record) {
    const list = Array.isArray(this.ui.aiExecutions) ? this.ui.aiExecutions : [];
    const recordId = record && typeof record.id === "string" ? record.id : "";
    const index = recordId
      ? list.findIndex((entry) => entry && entry.id === recordId)
      : -1;
    this.ui.aiExecutions = (index >= 0
      ? list.map((entry, position) => position === index ? record : entry)
      : [record, ...list]).slice(0, 20);
    try {
      await this.bridge.command("ai.execution.append", { record });
    } catch (error) {
      this.ui.toast = "AI 执行记录没有写入，但课程内容与保存状态不受影响。你可以继续使用。";
      this.notify();
    }
    return record;
  }

  scheduleSave() {
    if (this.canonicalMutationPending) return;
    this.saveStatus = "正在保存…";
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (this.ui.route === "publish") {
      this.preflightDeferredSave = true;
      this.notifyChrome();
      return;
    }
    try {
      const request = this.saveRequest();
      void this.saveScheduler.enqueue(request).catch((error) => this.reportSaveFailure(error, request));
    } catch (error) {
      this.saveStatus = "保存失败";
      this.ui.toast = userFacingError(error, "保存没有开始。请重新打开项目后重试。");
    }
    this.notifyChrome();
  }
  scheduleSessionSave() {
    if (this.nativeSwitching) return;
    void this.sessionScheduler.enqueue(this.session()).catch(() => {});
  }
  flush() {
    if (this.nativeSwitching) {
      this.saveStatus = "保存失败";
      this.ui.toast = "项目切换尚未完成，请稍后再保存或关闭";
      this.notify();
      return Promise.resolve(false);
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    return this.queueFlush(() => this.flushNow());
  }
  queueFlush(task) {
    const pending = this.flushQueue(task);
    this.activeFlushPromise = pending;
    const clearPending = () => {
      if (this.activeFlushPromise === pending) this.activeFlushPromise = null;
    };
    pending.then(clearPending, clearPending);
    return pending;
  }
  /**
   * Write pending edits immediately instead of waiting for the autosave
   * debounce.  `flushNow` refuses to run while a recovery decision is pending,
   * so callers that have just resolved one use this entry point.
   */
  writeThrough() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    return this.queueFlush(() => this.flushNow());
  }
  async flushNow() {
    this.recoveryWarning = "";
    const issues = assertAuthoringInvariants(this.data);
    if (issues.length > 0) {
      // Refuse to write a project that would fail canonical validation: the
      // previous good file must stay intact and the user must be told.
      this.saveStatus = "保存失败";
      this.ui.toast = "这份课程里有一处关联不完整，暂时没有保存。你可以继续编辑；修复提示后再保存。";
      this.notifyChrome();
      return false;
    }
    const recoverySaveInProgress = this.recoveryResolution?.pending === this.pendingRecovery &&
      this.recoveryResolution.action === "restore" &&
      this.recoveryResolution.allowRecoverySave === true;
    if (this.pendingRecovery && !recoverySaveInProgress) {
      this.saveStatus = "恢复待处理";
      this.ui.toast = "发现未完成的保存，当前不能继续保存。请先恢复暂存内容或保留磁盘版本。";
      this.notifyChrome();
      return false;
    }
    if (this.nativeSwitchPending) {
      this.saveStatus = "保存失败";
      this.ui.toast = "项目切换尚未完成，请先完成锁回滚";
      this.notifyChrome();
      return false;
    }
    let request = null;
    try {
      request = this.saveRequest();
      const retryingRecoverySave = recoverySaveInProgress && this.lastSaveFailure;
      const completion = retryingRecoverySave
        ? this.saveScheduler.retry(request)
        : this.saveScheduler.enqueue(request);
      completion.catch(() => {});
      await this.saveScheduler.flush();
      await completion;
      const sessionSnapshot = this.session();
      const sessionWrite = this.sessionScheduler.enqueue(sessionSnapshot);
      sessionWrite.catch(() => {});
      await this.sessionScheduler.flush().catch((error) => this.reportSessionFailure(error, sessionSnapshot));
      return this.saveStatus === "已保存";
    } catch (error) {
      if (request && this.saveIdentityMatches(request)) this.lastSaveFailure = error;
      if ((error?.commit_state ?? error?.details?.commit_state) === "outcome_uncertain") {
        if (request) this.reportSaveFailure(error, request);
        return false;
      }
      if (this.bridge.isNative() && /project_(?:not_open|lock_lost|lock_not_owned)/.test(String(error?.code || error?.message || ""))) {
        this.clearNativeLease();
        this.saveStatus = "保存失败";
        this.ui.toast = userFacingError(error, "保存没有完成。课程内容没有改变，请稍后再试。");
        this.notifyChrome();
        return false;
      }
      if (error?.code === "external_modification_conflict" || /external_modification_conflict/.test(String(error?.message || ""))) {
        await this.captureExternalConflict(error);
        return false;
      }
      this.saveStatus = "保存失败";
      this.ui.toast = userFacingError(error, "保存没有完成。课程内容没有改变，请稍后再试。");
      this.notifyChrome();
      return false;
    }
  }
  async captureExternalConflict(error) {
    this.saveStatus = "外部修改冲突";
    this.externalConflict = await this.bridge.inspectExternalModification(this.data).catch((inspectionError) => ({
      inspection_error: inspectionError?.message || "无法读取磁盘差异",
      current: null,
    }));
    const externalProjectId = this.externalConflict?.external?.project?.id;
    this.ui.toast = externalProjectId && externalProjectId !== this.data?.project?.id
      ? "项目文件已经被替换为其他课程，保存已暂停以免覆盖内容。请先检查磁盘版本，再选择重新载入或保留本地内容。"
      : "课程文件在其他地方发生了变化，保存已暂停以免覆盖内容。你仍可继续查看；请选择重新载入、合并或保留本地版本。";
    this.notify();
    return false;
  }
  async resolveExternalConflict(action) {
    this.ui.toast = "正在处理外部修改…";
    this.notify();
    if (action === "reload") {
      const pendingRecovery = this.pendingRecovery;
      let didReload = false;
      let clearResult = null;
      try {
        await this.queueFlush(async () => {
          const state = await this.bridge.reloadExternalProject();
          if (!this.adoptProjectSnapshot(state)) throw new Error("磁盘版本不是可识别的课程项目");
          didReload = true;
          this.reconcileEditorSaveState();
          this.history = [];
          this.future = [];
          this.resetAiState();
          this.retainUiSelection();
          if (pendingRecovery) {
            const request = this.recoveryClearRequest(pendingRecovery);
            clearResult = await this.bridge.clearRecoveryJournal(request);
            if (!this.recoveryClearAcknowledged(clearResult, request) ||
              this.pendingRecovery !== pendingRecovery || !this.saveIdentityMatches(request)) {
              throw new Error("磁盘版本已载入，但未能确认清理原恢复日志；恢复提示仍保留。");
            }
            this.projectFingerprint = clone(clearResult.fingerprint);
            this.pendingRecovery = null;
          }
          this.externalConflict = null;
          this.uncertainMutation = null;
          this.saveStatus = this.projectFingerprint?.exists ? "已保存" : "未保存";
          this.ui.toast = clearResult?.durability_warning
            ? `已载入磁盘版本；${clearResult.durability_warning}`
            : "已载入磁盘版本";
          this.notify();
        });
      } catch (error) {
        this.ui.toast = didReload
          ? userFacingError(error, "磁盘版本已载入，但恢复记录仍待处理。请保留提示并重试。")
          : userFacingError(error, "重新载入没有完成。当前内容没有改变，请重试。");
        this.notify();
      }
      return;
    }
    if (action === "merge") {
      try {
        // This is the user's explicit conflict decision. The failed save queue
        // is isolated by project.resolve itself; trying to flush it here would
        // prevent the user from resolving the conflict.
        const result = await this.bridge.mergeExternalProject(this.data);
        if (!result || result.can_apply === false) {
          throw new Error(
            result?.reason ||
              "还有无法自动合并的内容，请选择重新载入或明确保留本地版本",
          );
        }
        const merged = this.isProjectData(result.merged)
          ? result.merged
          : this.isProjectData(result.project)
          ? result.project
          : null;
        if (!merged) throw new Error("自动合并没有返回可用的项目数据");
        await this.applyExternalResolution(merged, "已按无冲突内容自动合并");
      } catch (error) {
        this.ui.toast = userFacingError(error, "自动合并没有完成。当前内容没有改变，请重新载入或保留本地版本。");
        this.notify();
      }
      return;
    }
    if (action === "keep-local") {
      try {
        await this.applyExternalResolution(this.data, "已明确保留本地版本");
      } catch (error) {
        this.ui.toast = userFacingError(error, "保留本地版本没有完成。当前内容没有改变，请重试。");
        this.notify();
      }
    }
  }
  async applyExternalResolution(project, message) {
    const expected = this.externalConflict?.current;
    if (!expected) throw new Error("缺少磁盘版本指纹，请重新载入或重新检查");
    if (!this.isFileFingerprint(expected)) throw new Error("磁盘版本指纹无效，请重新检查后再试");
    const result = await this.runCanonicalMutation(
      "project.resolve",
      { project, expected_current: clone(expected) },
      { expectedFingerprint: expected, resolvePausedConflict: true },
    );
    this.resetAiState();
    this.externalConflict = null;
    this.uncertainMutation = null;
    this.retainUiSelection();
    this.saveStatus = "已保存";
    this.ui.toast = result.warnings.length ? `${message}；${result.warnings.join("；")}` : message;
    this.notify();
  }
  async resolvePendingRecovery(action) {
    const pending = this.pendingRecovery;
    if (!pending || this.recoveryResolution?.pending === pending) return;
    let identity = this.saveIdentity();
    const operation = { pending, identity, action };
    this.recoveryResolution = operation;
    this.notify();
    try {
      if (action === "discard") {
        if (pending.restore_attempt &&
          JSON.stringify(this.data) !== pending.restore_attempt.project_json) {
          throw new Error("恢复后的编辑内容已变化；没有清理恢复日志，请先处理当前编辑。");
        }
        const request = this.recoveryClearRequest(pending, identity);
        const result = await this.bridge.clearRecoveryJournal(request);
        if (!this.recoveryClearAcknowledged(result, request) ||
          this.pendingRecovery !== pending || !this.saveIdentityMatches(identity)) {
          throw new Error("未能确认清理这次恢复日志；磁盘版本保持不变，请重试。");
        }
        this.projectFingerprint = clone(result.fingerprint);
        if (pending.restore_attempt) {
          if (
            JSON.stringify(this.data) !== pending.restore_attempt.project_json ||
            !this.isProjectData(pending.canonical) ||
            !this.adoptProjectSnapshot({
              project: pending.canonical,
              project_id: identity.expected_project_id,
              fingerprint: this.projectFingerprint,
            })
          ) throw new Error("恢复中的编辑内容已变化；恢复日志已清理，请重新读取磁盘版本后继续。");
          this.reconcileEditorSaveState();
          this.history = [];
          this.future = [];
          this.resetAiState();
          this.retainUiSelection();
        }
        this.pendingRecovery = null;
        this.saveStatus = this.projectFingerprint?.exists ? "已保存" : "未保存";
        this.ui.toast = result.durability_warning
          ? `已保留磁盘版本；${result.durability_warning}`
          : "已保留磁盘版本";
        this.notify();
        return;
      }

      if (action !== "restore") throw new Error("未知的恢复操作。");
      const priorRestore = pending.restore_attempt;
      if (priorRestore) {
        if (
          !this.saveIdentityMatches(priorRestore.identity) ||
          JSON.stringify(this.data) !== priorRestore.project_json ||
          this.saveRevision !== priorRestore.revision
        ) throw new Error("恢复后的编辑内容已变化；没有用旧内容覆盖，请检查当前编辑并重新载入磁盘状态。");
        if (this.lastSaveFailure) {
          const failure = this.lastSaveFailure;
          const code = String(failure?.code || failure?.details?.code || "");
          const safelyRetryable =
            (failure?.commit_state ?? failure?.details?.commit_state) === "not_committed" &&
            (failure?.retryable ?? failure?.details?.retryable) === true &&
            !/external_modification_conflict|project_(?:not_open|lock_lost|lock_not_owned|locked)|save_response_binding_mismatch/.test(code);
          if (!safelyRetryable) {
            throw new Error("上次正文写入结果不能安全重试；恢复前备份和本地内容均保留，请先核验磁盘状态。");
          }
        }
        operation.allowRecoverySave = true;
        const saved = await this.writeThrough();
        if (!saved) {
          this.ui.toast = "恢复内容仍保留在编辑器，正文尚未确认写入磁盘；恢复前备份已保留，请重试保存。";
          this.notify();
          return;
        }
        if (this.pendingRecovery !== pending || !this.saveIdentityMatches(identity)) return;
        this.pendingRecovery = null;
        const warnings = [priorRestore.durability_warning, this.recoveryWarning]
          .filter((warning) => typeof warning === "string" && warning.trim());
        this.ui.toast = warnings.length
          ? `已恢复自动保存内容；恢复前备份已创建，但持久化确认有限：${warnings.join("；")}`
          : "已恢复自动保存内容，恢复前备份已持久保存";
        this.notify();
        return;
      }

      const current = clone(this.data);
      const revision = this.saveRevision;
      if (!identity.expected_project_id || !this.isFileFingerprint(this.projectFingerprint) || !this.projectFingerprint.exists) {
        throw new Error("当前磁盘版本身份无效；恢复前备份没有创建，请重新打开课程后重试。");
      }
      let attempt = pending.backup_attempt;
      if (
        !attempt || attempt.name !== "恢复前备份" ||
        JSON.stringify(attempt.project) !== JSON.stringify(current) ||
        !this.saveIdentityMatches(attempt.identity)
      ) {
        attempt = {
          identity,
          project: current,
          name: "恢复前备份",
          note: "恢复自动保存前自动创建",
          snapshot_id: uid(),
          operation_id: uid(),
          revision: Math.max(1, this.saveRevision),
        };
        pending.backup_attempt = attempt;
      }
      const request = {
        project_dir: attempt.identity.project_dir,
        snapshot_id: attempt.snapshot_id,
        name: attempt.name,
        note: attempt.note,
        project: clone(attempt.project),
        expected_project_id: attempt.identity.expected_project_id,
        lease_generation: attempt.identity.lease_generation,
        editor_generation: attempt.identity.editor_generation,
        operation_id: attempt.operation_id,
        revision: attempt.revision,
      };
      const result = await this.bridge.createSnapshot(request);
      const validBackup = result && result.persisted === true &&
        result.id === request.snapshot_id && result.snapshot_id === request.snapshot_id &&
        result.project_id === request.expected_project_id &&
        normalizeProjectDir(result.project_dir) === normalizeProjectDir(request.project_dir) &&
        result.lease_generation === request.lease_generation &&
        result.editor_generation === request.editor_generation &&
        result.operation_id === request.operation_id && result.revision === request.revision &&
        ["written", "unchanged"].includes(result.outcome) &&
        typeof result.content_hash === "string" && /^[a-f0-9]{64}$/i.test(result.content_hash) &&
        typeof result.created_at === "string";
      if (!validBackup) throw new Error("恢复前备份没有返回匹配的持久化确认；磁盘课程未更改。");
      if (
        this.pendingRecovery !== pending || !this.saveIdentityMatches(identity) ||
        revision !== this.saveRevision || JSON.stringify(this.data) !== JSON.stringify(current)
      ) return;

      const backup = {
        id: result.id,
        project_id: result.project_id,
        name: attempt.name,
        note: attempt.note,
        git_commit_hash: null,
        created_at: result.created_at,
      };
      this.localSnapshots.set(backup.id, clone(attempt.project));
      this.commit("恢复自动保存", (data) => {
        const next = clone(pending.project);
        Object.keys(next).forEach((key) => { data[key] = next[key]; });
        // Recovery restores the course the shell already has open; adopting a
        // different project id would silently switch the open project and orphan
        // every reference to it.
        data.project = { ...next.project, id: current.project.id };
        data.snapshots = [backup, ...(next.snapshots || []).filter((snapshot) => snapshot.id !== backup.id)];
      });
      pending.restore_attempt = {
        identity: clone(identity),
        project_json: JSON.stringify(this.data),
        durability_warning: result.durability_warning || null,
      };
      this.resetAiState();
      operation.allowRecoverySave = true;
      const saved = await this.writeThrough();
      if (!saved) {
        pending.restore_attempt.revision = this.saveRevision;
        this.ui.toast = "恢复内容仍保留在编辑器，正文尚未确认写入磁盘；恢复前备份已保留，请重试保存。";
        this.notify();
        return;
      }
      if (this.pendingRecovery !== pending || !this.saveIdentityMatches(identity)) return;
      this.pendingRecovery = null;
      const warnings = [result.durability_warning, this.recoveryWarning]
        .filter((warning) => typeof warning === "string" && warning.trim());
      this.ui.toast = warnings.length
        ? `已恢复自动保存内容；恢复前备份已创建，但持久化确认有限：${warnings.join("；")}`
        : "已恢复自动保存内容，恢复前备份已持久保存";
      this.notify();
    } catch (error) {
      if (this.pendingRecovery === pending && this.saveIdentityMatches(identity)) {
        this.ui.toast = userFacingError(error, "恢复没有完成；磁盘课程保持不变，请重试。");
        this.notify();
      }
    } finally {
      if (this.recoveryResolution === operation) {
        this.recoveryResolution = null;
        this.notify();
      }
    }
  }
  recoveryClearRequest(pending, identity = this.saveIdentity()) {
    const transactionId = pending?.transaction_id;
    if (
      typeof transactionId !== "string" || !transactionId ||
      !identity.project_dir || !identity.expected_project_id || !identity.lease_generation ||
      (pending.project_id && pending.project_id !== identity.expected_project_id) ||
      (pending.project?.project?.id && pending.project.project.id !== identity.expected_project_id) ||
      !this.isFileFingerprint(this.projectFingerprint) || !this.projectFingerprint.exists ||
      !Number.isSafeInteger(this.projectFingerprint.size) ||
      typeof this.projectFingerprint.hash !== "string" || !this.projectFingerprint.hash
    ) {
      throw new Error("恢复日志与当前课程身份不匹配；没有清理恢复日志。");
    }
    const revision = Math.max(1, this.saveRevision);
    if (!Number.isSafeInteger(revision)) throw new Error("恢复日志请求版本无效；没有清理恢复日志。");
    return {
      project_dir: identity.project_dir,
      expected_project_id: identity.expected_project_id,
      lease_generation: identity.lease_generation,
      editor_generation: identity.editor_generation,
      operation_id: uid(),
      revision,
      expected_fingerprint: clone(this.projectFingerprint),
      expected_transaction_id: transactionId,
    };
  }
  recoveryClearAcknowledged(result, request) {
    const expectedFingerprint = request.expected_fingerprint;
    const actualFingerprint = result?.fingerprint;
    const fingerprintMatches = this.isFileFingerprint(actualFingerprint) &&
      actualFingerprint.exists === expectedFingerprint.exists &&
      actualFingerprint.size === expectedFingerprint.size &&
      actualFingerprint.hash === expectedFingerprint.hash;
    return result && typeof result.cleared === "boolean" &&
      result.project_id === request.expected_project_id &&
      normalizeProjectDir(result.project_dir) === normalizeProjectDir(request.project_dir) &&
      result.lease_generation === request.lease_generation &&
      result.editor_generation === request.editor_generation &&
      result.operation_id === request.operation_id && result.revision === request.revision &&
      fingerprintMatches &&
      (result.cleared
        ? result.transaction_id === request.expected_transaction_id
        : result.transaction_id === null);
  }
  /**
   * Drop the in-memory project.
   *
   * `keepSession` is for projects that are merely unreachable *right now* —
   * another window still holds the lease, or the read failed transiently.  The
   * session file already points at the right place, so erasing it would throw
   * away where the user was and leave them with nothing to continue.
   */
  async forgetNativeProject({ keepSession = false } = {}) {
    this.clearNativeLease();
    this.bridge.restoreProjectDir(null, false);
    if (keepSession) return;
    await this.persistSession({ project_dir: null }).catch(() => {});
  }
  noteRecoveryWarning(value) {
    const warning = recoveryWarning(value);
    if (!warning) return;
    this.recoveryWarning = warning;
    this.ui.toast = warning;
  }
  /**
   * Reader position for the next launch: the selected project directory plus
   * the same UI fields in both shells.  The native `save_session` stores this
   * payload verbatim, so the desktop build returns to the same lesson, mode and
   * panel exactly like the browser build; dropping the UI fields here would
   * make "关闭 → 重启 → 继续工作" silently restart at the top of the course.
   */
  session() {
    const projectDir = this.bridge.projectDir || null;
    const projectId = this.data.project?.id || null;
    const reader = this.readerState();
    return this.sessionWithReader(projectDir, projectId, reader);
  }
  isProjectData(value) {
    return Boolean(value && typeof value === "object" && value.project && Array.isArray(value.content_items) && Array.isArray(value.blocks));
  }
  isFileFingerprint(value) {
    return Boolean(
      value && typeof value === "object" && !Array.isArray(value) &&
        Object.hasOwn(value, "exists") &&
        Object.hasOwn(value, "mtime_ms") &&
        Object.hasOwn(value, "size") &&
        Object.hasOwn(value, "hash") &&
        typeof value.exists === "boolean" &&
        (value.mtime_ms === null || (Number.isSafeInteger(value.mtime_ms) && value.mtime_ms >= 0)) &&
        (value.size === null || (Number.isSafeInteger(value.size) && value.size >= 0)) &&
        (value.hash === null || typeof value.hash === "string") &&
        (value.exists || (value.mtime_ms === null && value.size === null && value.hash === null)),
    );
  }
  readProjectSnapshot() {
    if (typeof this.bridge.readProjectState === "function") {
      return Promise.resolve(this.bridge.readProjectState()).then((state) => {
        if (state == null) {
          return {
            project: null,
            project_id: null,
            lease_generation: null,
            fingerprint: { exists: false, mtime_ms: null, size: null, hash: null },
          };
        }
        if (
          !state || typeof state !== "object" ||
          !Object.hasOwn(state, "project") ||
          !Object.hasOwn(state, "fingerprint") ||
          !this.isFileFingerprint(state.fingerprint)
        ) {
          throw new Error("课程项目读取没有返回有效的磁盘版本标识；请重新打开项目后重试。");
        }
        const projectId = state.project?.project?.id ?? null;
        if (state.project && state.project_id !== projectId) {
          throw new Error("项目读取返回的项目标识与正文不一致；请重新打开项目后重试。");
        }
        return { ...state, project_id: projectId, lease_generation: state.lease_generation ?? null };
      });
    }
    return this.bridge.readProject().then((project) => {
      const state = { project };
      if (this.isFileFingerprint(this.projectFingerprint)) {
        state.fingerprint = clone(this.projectFingerprint);
      }
      return state;
    });
  }
  adoptProjectSnapshot(state) {
    if (!state || typeof state !== "object" || !Object.hasOwn(state, "project") || !this.isProjectData(state.project)) return false;
    if (state.project_id !== undefined && state.project_id !== state.project.project.id) return false;
    const hasFingerprint = Object.hasOwn(state, "fingerprint");
    if (
      (hasFingerprint && !this.isFileFingerprint(state.fingerprint)) ||
      (!hasFingerprint && typeof this.bridge.readProjectState === "function")
    ) return false;
    const project = migrateUiProject(state.project);
    this.data = project;
    this.trackProjectIdentity();
    this.saveStatus = hasFingerprint && state.fingerprint.exists
      ? "已保存"
      : "未保存";
    if (hasFingerprint) {
      this.projectFingerprint = clone(state.fingerprint);
      this.projectFingerprintGeneration += 1;
    }
    return true;
  }

  offerPendingRecovery(recovery) {
    if (!this.isProjectData(this.data)) return false;
    const projectId = this.data.project.id;
    const existingRecovery = this.pendingRecovery;
    if (
      recovery?.transaction_id && existingRecovery?.transaction_id === recovery.transaction_id &&
      (existingRecovery.project_id || existingRecovery.project?.project?.id) === projectId
    ) {
      // Repeated acknowledgements for one transaction must retain its retry state.
      return true;
    }
    const journalProject = this.isProjectData(recovery?.project) ? recovery.project : null;
    if (!journalProject) return false;
    const savedAt = typeof recovery.saved_at === "string" ? recovery.saved_at : "";
    if (
      (recovery.project_id && recovery.project_id !== projectId) ||
      journalProject.project.id !== projectId ||
      !(savedAt > (this.data.project.updated_at || ""))
    ) return false;
    this.pendingRecovery = {
      project: migrateUiProject(journalProject),
      canonical: clone(this.data),
      saved_at: savedAt,
      transaction_id: recovery.transaction_id,
      project_id: recovery.project_id,
      canonical_revision: recovery.canonical_revision,
    };
    this.ui.toast = "发现未完成的保存；磁盘版本没有改变，请选择恢复暂存内容或保留磁盘版本。";
    return true;
  }

  async persistProjectSnapshot(request, expectedFingerprint = this.projectFingerprint, recoveryJournal = null) {
    if (request && Object.hasOwn(request, "expected_fingerprint")) {
      return await this.bridge.writeProject(request);
    }
    // Compatibility for the narrow direct-write call sites while they migrate
    // to the scheduler barrier; normal autosave always passes a bound request.
    const baselineGeneration = this.projectFingerprintGeneration;
    const result = await this.bridge.writeProject({
      project: request,
      expected_fingerprint: expectedFingerprint,
      recovery_journal: recoveryJournal,
    });
    const writtenFingerprint = result?.fingerprint;
    if (!this.isFileFingerprint(writtenFingerprint) || !writtenFingerprint.exists) {
      throw new Error("保存确认没有返回有效的磁盘版本标识；请重新读取项目后重试。");
    }
    if (baselineGeneration === this.projectFingerprintGeneration) {
      this.projectFingerprint = clone(writtenFingerprint);
      this.projectFingerprintGeneration += 1;
    }
    return result;
  }
  async initialize() {
    let session = null;
    let persisted = null;
    let persistedState = null;
    let recovery = null;
    // §5 — the start page is the first screen a returning user sees, so the
    // project list is read before it paints.  Fire-and-forget: `loadRegistryRows`
    // contains its own failure and an unreadable registry is an empty list,
    // which must not delay or replace the project restore below.
    void this.loadRegistryRows();
    try {
      if (this.bridge.isNative()) {
        session = await this.bridge.loadSession();
        this.rememberSession(session);
      }
      if (!this.bridge.isNative() || this.bridge.projectDir) {
        if (this.bridge.isNative()) {
          const openedState = await this.bridge.openProjectState();
          if (openedState && Object.hasOwn(openedState, "project") && Object.hasOwn(openedState, "fingerprint")) {
            persistedState = openedState;
          } else if (openedState == null) {
            persistedState = {
              project: null,
              project_id: null,
              lease_generation: null,
              fingerprint: { exists: false, mtime_ms: null, size: null, hash: null },
            };
          } else {
            throw new Error(describeProjectOpenFailure(openedState));
          }
        } else {
          const openedState = typeof this.bridge.openProjectState === "function"
            ? await this.bridge.openProjectState()
            : null;
          persistedState = openedState && Object.hasOwn(openedState, "project") &&
              Object.hasOwn(openedState, "fingerprint")
            ? openedState
            : await this.readProjectSnapshot();
        }
        persisted = persistedState?.project ?? null;
        if (
          persisted == null && persistedState?.fingerprint &&
          persistedState.fingerprint.exists === false
        ) {
          // Absence is a usable baseline for an explicit first save.
          this.projectFingerprint = clone(persistedState.fingerprint);
          this.projectFingerprintGeneration += 1;
        }
        if (!this.bridge.isNative()) {
          if (persisted?.project?.id && typeof this.bridge.openSession === "function") {
            try {
              const openedSession = await this.bootstrapBrowserSession(persisted.project.id);
              session = openedSession.session;
            } catch (error) {
              // Reader state is optional. Keep the project usable, but make
              // subsequent position-save failures truthful until a new
              // bootstrap succeeds.
              session = await this.bridge.loadSession();
              this.sessionBootstrapReady = false;
              this.ui.toast = userFacingError(error, "阅读位置保存通道暂时不可用；课程内容仍可继续使用。");
            }
          } else {
            session = await this.bridge.loadSession();
          }
          this.rememberSession(session);
        }
      if (this.bridge.isNative() && persisted != null) {
        this.markNativeLease(this.bridge.projectDir);
          if (!this.isProjectData(persisted)) {
            await this.closeNativeProject(this.bridge.projectDir).catch(() => {});
            throw new Error(describeProjectOpenFailure(null, { notObject: true }));
          }
        }
        recovery = persistedState && Object.hasOwn(persistedState, "recovery_journal")
          ? persistedState.recovery_journal
          : await this.bridge.readRecoveryJournal();
      }
    } catch (error) {
      if (this.bridge.isNative() && !this.hasNativeLease()) {
        await this.forgetNativeProject({ keepSession: shouldKeepProjectPointer(error) });
        session = null;
        persisted = null;
        recovery = null;
      }
      this.ui.toast = userFacingError(error, "无法读取项目。课程内容没有改变，请重新打开项目后再试。");
    }
    if (this.bridge.isNative() && this.bridge.projectDir && !this.hasNativeLease()) {
      await this.forgetNativeProject();
      session = null;
      persisted = null;
      recovery = null;
    }
    if (this.bridge.isNative() && !this.bridge.projectDir && !this.ui.toast) {
      this.ui.toast = "请选择项目文件夹以开始工作";
    }
    const project = this.isProjectData(persisted) ? persisted : null;
    const journalProject = this.isProjectData(recovery?.project) ? recovery.project : null;
    if (journalProject && project) {
      this.adoptProjectSnapshot(persistedState || { project });
      this.offerPendingRecovery(recovery);
    } else if (journalProject && !project) {
      this.data = migrateUiProject(journalProject);
      this.trackProjectIdentity();
      this.ui.toast = "已载入未完成的保存内容。请检查后继续编辑，确认无误后再保存。";
    } else if (project) {
      this.adoptProjectSnapshot(persistedState || { project });
      // The browser service already has one configured project root. After a
      // refresh, reopen its shell directly instead of showing the first-launch
      // launcher and making the user click "继续工作" again. Native startup
      // keeps its existing launcher/window behavior.
      if (!this.bridge.isNative()) this.ui.screen = "project";
    }
    await this.restoreSession(session);
    if (this.isProjectData(this.data) && this.ui.route === "versions") {
      await this.refreshSnapshots();
    }
    if (this.bridge.isNative() && this.bridge.projectDir && persisted) {
      // Written *after* the reader position is restored: saving first would
      // persist empty defaults over the session, so quitting an untouched
      // window would forget where the user was.
      await this.persistSession(this.session()).catch(() => {});
    }
    if (this.bridge.isNative() && !this.nativeDropUnlisten) {
      this.nativeDropUnlisten = await this.bridge.listenNativeDrops((paths) => {
        void this.importNativeFiles(paths);
      }).catch(() => null);
    }
    // Provider configs and the execution log are read only once a project is
    // open; a failure here is contained inside the two loaders.
    this.refreshAiSideFiles();
    this.notify();
  }
  /** Restore the reader's position.  Never invents course state. */
  async restoreSession(session = null) {
    session ??= await this.bridge.loadSession();
    this.rememberSession(session);
    if (!this.isProjectData(this.data)) return;
    const projectId = this.data.project.id;
    const cached = this.nativeProjectSessions.get(projectId);
    const candidate = cached && (!this.bridge.isNative() || cached.project_dir === this.bridge.projectDir)
      ? cached
      : session?.project_id === projectId &&
          (!this.bridge.isNative() || session.project_dir === this.bridge.projectDir)
      ? session
      : null;
    const reader = this.normalizeReaderState(this.data, candidate || {}, "overview");
    this.applyReaderState(reader);
    this.aiSyncScope();
    this.notify();
  }
  async newProject(title = "未命名课程", projectDir = "") {
    if (this.bridge.isNative()) {
      if (!await this.resolveNativeSwitchPending()) return;
      const previousProjectDir = this.bridge.projectDir;
      const previousProjectDirFromUrl = this.bridge.projectDirFromUrl;
      const previousLeaseActive = this.hasNativeLease(previousProjectDir);
      const restoreProjectDir = previousLeaseActive ? previousProjectDir : null;
      const restoreProjectDirFromUrl = previousLeaseActive ? previousProjectDirFromUrl : false;
      const restoreOpenedProjectState = this.bridge.lastOpenedProjectState;
      let restoreSession = null;
      let targetOpened = false;
      try {
        if (previousLeaseActive && previousProjectDir !== projectDir && !await this.flush()) {
          throw new Error("当前项目保存失败，请重试后再切换项目");
        }
        this.nativeSwitching = true;
        restoreSession = previousLeaseActive ? this.session() : null;
        this.bridge.setProjectDir(projectDir);
        const createdResult = await this.bridge.command("project.create", { title });
        targetOpened = true;
        // A non-null create result means the shell may already own the target
        // lease, even if the returned payload is unusable.
        this.markNativeLease(projectDir);
        const createdState = await this.bridge.openProjectState();
        if (!createdState || !Object.hasOwn(createdState, "project") || !Object.hasOwn(createdState, "fingerprint")) {
          throw new Error(describeProjectOpenFailure(createdState));
        }
        this.markNativeLease(projectDir);
        const created = createdState?.project || createdResult;
        if (!this.isProjectData(created)) throw new Error("新课程没有创建成功。当前项目没有改变，请重试。");
        const targetData = migrateUiProject(created);
        const targetSession = this.targetSession(targetData, projectDir, "map");
        await this.persistSession(targetSession);
        if (previousLeaseActive && previousProjectDir !== projectDir) {
          await this.closeNativeProject(previousProjectDir);
        }
        this.commitNativeProject(
          targetData,
          this.normalizeReaderState(targetData, targetSession, "map"),
          createdState?.fingerprint,
        );
        this.ui.toast = `已创建《${this.data.project.title}》`;
        this.notify();
      } catch (error) {
        if (targetOpened) {
          try {
            await this.rollbackNativeTarget(
              projectDir,
              restoreProjectDir,
              restoreProjectDirFromUrl,
              error,
              restoreSession,
              restoreOpenedProjectState,
            );
          } catch (rollbackError) {
            error = rollbackError;
          }
        } else {
          this.bridge.restoreProjectDir(
            restoreProjectDir,
            restoreProjectDirFromUrl,
            restoreOpenedProjectState,
          );
        }
        this.ui.toast = userFacingError(error, "无法新建课程。当前项目没有改变，请重试。");
        this.notify();
      } finally {
        this.nativeSwitching = false;
      }
      return;
    }
    if (!await this.flush()) {
      this.ui.toast = "当前课程没有保存成功；没有创建或切换到新课程。请先重试保存。";
      this.notify();
      return;
    }
    try {
      const created = await this.bridge.command("project.create", { title });
      const opened = await this.bridge.openProjectState();
      if (
        !opened || !this.isProjectData(opened.project) ||
        !this.isFileFingerprint(opened.fingerprint) ||
        opened.project_id !== opened.project.project.id ||
        !opened.lease_generation
      ) throw new Error("新课程没有返回有效的已保存项目与编辑租约。");
      let sessionState = null;
      let sessionWarning = "";
      try {
        sessionState = await this.bootstrapBrowserSession(opened.project.project.id);
      } catch (error) {
        this.sessionBootstrapReady = false;
        sessionWarning = userFacingError(error, "课程已创建，但阅读位置暂时无法保存。");
      }
      const project = migrateUiProject(opened.project || created);
      this.commitNativeProject(
        project,
        this.normalizeReaderState(project, sessionState?.session || {}, "map"),
        opened.fingerprint,
      );
      if (this.sessionBootstrapReady) this.scheduleSessionSave();
      this.ui.toast = sessionWarning || `已创建《${this.data.project.title}》`;
    } catch (error) {
      this.ui.toast = userFacingError(error, "无法新建课程。当前项目没有改变，请重试。");
    }
    this.notify();
  }
  commitNativeProject(project, reader, fingerprint) {
    this.clearExplorerPreview();
    this.assetPreview.clear();
    this.data = project;
    this.projectFingerprint = fingerprint || null;
    this.projectFingerprintGeneration += 1;
    this.trackProjectIdentity();
    void this.recordCurrentProject();
    this.history = [];
    this.future = [];
    this.localSnapshots.clear();
    this.pendingRecovery = null;
    this.externalConflict = null;
    this.uncertainMutation = null;
    this.uncertainMutationPending = false;
    this.ui.screen = "project";
    this.ui.focusRequirementId = null;
    this.ui.gridEditing = false;
    this.ui.assetPicker = null;
    this.ui.assetUsageId = null;
    this.ui.editingRequirementId = null;
    this.applyReaderState(reader);
    this.resetAiState();
    this.saveStatus = "已保存";
  }
  applyNewProject(project) {
    this.data = this.isProjectData(project) ? migrateUiProject(project) : project;
      this.trackProjectIdentity();
    this.history = [];
    this.future = [];
    this.localSnapshots.clear();
    this.ui.screen = "project";
    this.ui.route = "map";
    this.ui.mode = "writing";
    this.ui.activeId = this.data.content_items.find((item) => !item.archived)?.id || null;
    this.ui.selectedBlockId = null;
    this.ui.focusRequirementId = null;
    this.ui.gridEditing = false;
    this.ui.assetPicker = null;
    this.ui.assetUsageId = null;
    this.ui.editingRequirementId = null;
    this.resetAiState();
    this.tabs = this.ui.activeId ? [{ content_item_id: this.ui.activeId, mode: "writing", pinned: false, scroll_top: 0 }] : [];
    this.saveStatus = "已保存";
  }
  async newProjectFromPicker(title = "未命名课程") {
    if (!this.bridge.isNative()) return;
    try {
      const dir = await this.bridge.selectFolder();
      if (!dir) return;
      await this.newProject(title, dir);
    } catch (error) {
      this.ui.toast = userFacingError(error, "无法新建课程。当前项目没有改变，请重试。");
      this.notify();
    }
  }
  /**
   * Third launcher path: 导入已有文件夹 (§26).
   * Picks a folder and runs a read-only scan. Must not call project.create or
   * project.open, and must not write project.json (adoption is Task 12).
   */
  async importExistingFolderFromPicker(mode = "adopt") {
    if (!this.bridge.isNative()) {
      this.ui.toast =
        "导入已有文件夹需要在桌面应用中选择文件夹。你也可以先「新建课程」或「打开现有项目」。";
      this.notifyChrome();
      return;
    }
    if (mode === "append" && !this.data?.project?.id) {
      this.ui.toast = "请先打开或新建要追加资料的课程项目。";
      this.notifyChrome();
      return;
    }
    try {
      const dir = await this.bridge.selectFolder();
      if (!dir) {
        this.ui.toast =
          "没有选择文件夹。你可以再点一次「导入已有文件夹」，或点「新建课程」/「打开项目文件夹」。";
        this.notifyChrome();
        return;
      }
      await this.importExistingFolder(dir, mode);
    } catch (error) {
      this.ui.toast = userFacingError(error, "无法扫描文件夹。当前项目没有改变，请重试。");
      this.notify();
    }
  }
  /** Read-only scan of an absolute folder. Stores ScanResult in UI state only. */
  async importExistingFolder(dir, mode = "adopt") {
    const root = String(dir || "").trim();
    if (!root) {
      this.ui.toast = "没有选择文件夹。请再试一次「导入已有文件夹」。";
      this.notifyChrome();
      return;
    }
    const scanGeneration = ++this.folderScanGeneration;
    this.mappingGeneration += 1;
    this.clearDocumentImportDialog();
    try {
      const report = await this.bridge.command("folder.scan", { path: root });
      if (scanGeneration !== this.folderScanGeneration) return;
      if (!report || !Array.isArray(report.entries)) {
        throw new Error("文件夹扫描没有返回可用结果。请重试，或选择其他文件夹。");
      }
      const resolvedRoot = report.root || root;
      const snapshot = {
        id: ++this.mappingScanSequence,
        root: resolvedRoot,
        entries: clone(report.entries),
      };
      this.ui.importMode = mode === "append" ? "append" : "adopt";
      this.ui.folderScan = report;
      this.ui.mappingScanSnapshot = snapshot;
      this.ui.importFolderRoot = resolvedRoot;
      this.ui.documentImportPaths = [];
      this.ui.importMappingError = "";
      this.ui.explorerFilter = "";
      this.ui.explorerSelected = null;
      this.ui.explorerPreview = null;
      // A new scan invalidates any body dialog / tally left over from the last one.
      this.clearDocumentImportDialog();
      // Fresh scan → fresh unconfirmed mapping suggestions (preview ≠ confirm).
      this.ui.importMappingPlan = buildImportMappingPlan(resolvedRoot, report.entries);
      // Expand top-level directories so the first glance shows nested files.
      this.ui.explorerExpanded = report.entries
        .filter((entry) =>
          entry.kind === "directory" &&
          !String(entry.relative_path || "").includes("/")
        )
        .map((entry) => String(entry.relative_path));
      const recent = Array.isArray(this.ui.explorerRecent) ? this.ui.explorerRecent.slice() : [];
      const nextRecent = [resolvedRoot, ...recent.filter((path) => path !== resolvedRoot)].slice(0, 8);
      this.ui.explorerRecent = nextRecent;
      this.ui.route = "explorer";
      this.ui.screen = "project";
      const files = report.entries.filter((entry) => entry.kind === "file").length;
      const folders = report.entries.filter((entry) => entry.kind === "directory").length;
      const degraded = report.entries.filter((entry) => entry.error).length;
      const parts = [`已扫描 ${files} 个文件`];
      if (folders) parts.push(`${folders} 个文件夹`);
      if (degraded) parts.push(`${degraded} 项无法读取（已跳过，不影响其余文件）`);
      this.ui.toast = `${parts.join("，")}。已打开资源浏览器（只读，尚未写入课程项目）。`;
      this.scheduleSessionSave();
      this.notify();
    } catch (error) {
      if (scanGeneration !== this.folderScanGeneration) return;
      this.ui.toast = userFacingError(error, "无法扫描文件夹。当前项目没有改变，请重试。");
      this.notify();
    }
  }
  /**
   * Open a fresh, editable selection session over the last immutable scan.
   * Does not rescan source files or write Canonical.
   */
  openImportMappingPreview() {
    const report = this.ui.folderScan;
    const root = this.ui.importFolderRoot || report?.root || "";
    const snapshot = this.ui.mappingScanSnapshot;
    const entries = snapshot?.root === root && Array.isArray(snapshot.entries)
      ? snapshot.entries
      : report?.entries;
    if (!Array.isArray(entries)) {
      this.ui.toast = "还没有扫描结果。请先使用「导入已有文件夹」。";
      this.notifyChrome();
      return;
    }
    this.mappingGeneration += 1;
    this.clearDocumentImportDialog();
    this.ui.documentImportPaths = [];
    this.ui.importMappingPlan = buildImportMappingPlan(root, clone(entries));
    this.ui.importMappingError = "";
    this.ui.documentImportReport = null;
    this.ui.route = "mapping";
    this.ui.screen = "project";
    this.ui.toast = "这是映射建议，不是最终事实。可勾选、修改后，再单独确认导入计划。";
    this.scheduleSessionSave();
    this.notify();
  }
  setImportMappingSelected(relativePath, selected) {
    if (!this.ui.importMappingPlan) return;
    this.ui.importMappingError = "";
    this.ui.importMappingNeedsReview = false;
    this.ui.importMappingPlan = applyImportMappingSelected(
      this.ui.importMappingPlan,
      relativePath,
      selected,
    );
    patchMappingRow(relativePath);
  }
  setImportMappingRole(relativePath, role) {
    if (!this.ui.importMappingPlan) return;
    this.ui.importMappingError = "";
    this.ui.importMappingNeedsReview = false;
    this.ui.importMappingPlan = applyImportMappingRole(
      this.ui.importMappingPlan,
      relativePath,
      role,
    );
    patchMappingRow(relativePath);
  }
  setImportMappingDestination(relativePath, value) {
    if (!this.ui.importMappingPlan) return;
    const [kind, id] = String(value || "").split(/:(.*)/s, 2);
    const destination = kind === "existing_stage" && id
      ? { kind, stage_id: id }
      : kind === "existing_lesson" && id
      ? { kind, content_item_id: id }
      : kind === "folder_structure"
      ? { kind }
      : { kind: "unassigned_lesson" };
    this.ui.importMappingError = "";
    this.ui.importMappingNeedsReview = false;
    this.ui.importMappingPlan = applyImportMappingDestination(
      this.ui.importMappingPlan,
      relativePath,
      destination,
    );
    patchMappingRow(relativePath);
  }
  setImportMappingAllowDuplicate(relativePath, allow) {
    if (!this.ui.importMappingPlan) return;
    this.ui.importMappingError = "";
    this.ui.importMappingPlan = applyImportMappingAllowDuplicate(
      this.ui.importMappingPlan,
      relativePath,
      allow,
    );
    patchMappingRow(relativePath);
  }
  /** Drop any pending body chooser and invalidate its async folder scan. */
  clearDocumentImportDialog() {
    this.documentImportGeneration += 1;
    this.ui.documentImportDialog = null;
    this.ui.documentImportAnswered = false;
    this.ui.documentImportPaths = [];
    this.ui.documentImportReport = null;
  }
  closeMappingPreview() {
    this.mappingGeneration += 1;
    this.clearDocumentImportDialog();
    const plan = this.ui.importMappingPlan;
    if (plan?.confirmed) {
      this.ui.importMappingPlan = { ...plan, confirmed: false, confirmed_at: null };
    }
  }
  /**
   * §18 — open the body-document dialog for a *confirmed* plan.
   *
   * Returns false when the plan holds no document candidate, which is exactly how
   * a media-only or text-free folder keeps its single confirm click (§16/§17).
   * The rows shown here are copies of the confirmed plan's candidates: the dialog
   * filters what gets sent and never re-infers a Stage / Lesson (§19).
   */
  async openDocumentImportDialog(plan, opener = null) {
    const root = String(plan?.root || this.ui.importFolderRoot || "");
    const rootItems = collectDocumentImportCandidates(plan).map((item) => ({
      ...item,
      source: "plan",
    }));
    const parentDirs = (plan?.items || []).filter((item) =>
      item?.kind === "directory" && item.selected === true && !item.error &&
      (item.mapping === "stage" || item.mapping === "lesson")
    );
    if (!rootItems.length && !parentDirs.length) return "none";
    if (opener) rememberDialogReturnFocus(opener);
    const generation = ++this.documentImportGeneration;
    const mappingGeneration = this.mappingGeneration;
    const groups = rootItems.length
      ? [{ directory: "", mapping: null, destination: null, items: rootItems }]
      : [];
    this.ui.documentImportDialog = {
      token: generation,
      root,
      appending: this.ui.importMode === "append",
      loading: parentDirs.length > 0,
      items: rootItems,
      groups,
      errors: [],
      warnings: [],
    };
    this.ui.documentImportAnswered = false;
    this.ui.documentImportPaths = [];
    this.ui.documentImportReport = null;
    this.ui.importMappingError = "";
    this.notify();
    let scan = { groups: [], errors: [], warnings: [] };
    if (parentDirs.length) {
      try {
        scan = await this.bridge.command("folder.scan_documents", { root, plan });
        scan = scan?.value || scan;
      } catch (error) {
        scan = {
          groups: [],
          errors: [userFacingError(error, "无法读取已选文件夹中的直接子文档")],
          warnings: [],
        };
      }
    }
    const current = this.ui.documentImportDialog;
    if (
      generation !== this.documentImportGeneration ||
      mappingGeneration !== this.mappingGeneration ||
      this.ui.route !== "mapping" || current?.token !== generation
    ) return "stale";
    const childGroups = (Array.isArray(scan?.groups) ? scan.groups : []).map((group) => ({
      ...group,
      items: (Array.isArray(group?.items) ? group.items : []).map((item) => ({
        ...item,
        relative_path: String(item?.relative_path || "").replaceAll("\\", "/"),
        source: "folder",
      })),
    }));
    const items = [...rootItems, ...childGroups.flatMap((group) => group.items)];
    const errors = Array.isArray(scan?.errors) ? scan.errors : [];
    const warnings = Array.isArray(scan?.warnings) ? scan.warnings : [];
    if (!items.length && !errors.length) {
      this.clearDocumentImportDialog();
      return mappingGeneration === this.mappingGeneration ? "none" : "stale";
    }
    const rootGroup = groups[0];
    this.ui.documentImportDialog = {
      token: generation,
      root,
      appending: this.ui.importMode === "append",
      loading: false,
      items,
      groups: [...(rootGroup ? [rootGroup] : []), ...childGroups],
      errors,
      warnings,
    };
    this.notify();
    return "opened";
  }
  async retryDocumentImportScan() {
    const dialog = this.ui.documentImportDialog;
    const plan = this.ui.importMappingPlan;
    if (!dialog || !Array.isArray(dialog.errors) || !dialog.errors.length || !plan?.confirmed) return;
    const previousSelection = new Map(
      (dialog.items || []).filter((item) => item?.source === "folder").map((item) => [
        String(item.relative_path || "").replaceAll("\\", "/"),
        item.selected === true,
      ]),
    );
    const deselected = (dialog.items || [])
      .filter((item) => item?.source !== "folder" && item?.selected !== true)
      .map((item) => String(item.relative_path || ""));
    this.ui.importMappingPlan = applyDocumentImportDeselection(plan, deselected);
    const result = await this.openDocumentImportDialog(this.ui.importMappingPlan);
    if (result !== "opened" || !this.ui.documentImportDialog) return;
    this.ui.documentImportDialog.items = this.ui.documentImportDialog.items.map((item) =>
      item?.source === "folder" && previousSelection.has(item.relative_path)
        ? { ...item, selected: previousSelection.get(item.relative_path) }
        : item
    );
    this.ui.documentImportDialog.groups = this.ui.documentImportDialog.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => item?.source === "folder" && previousSelection.has(item.relative_path)
        ? { ...item, selected: previousSelection.get(item.relative_path) }
        : item),
    }));
    this.notify();
  }
  documentImportRow(relativePath) {
    const path = String(relativePath ?? "").replaceAll("\\", "/");
    const items = this.ui.documentImportDialog?.items;
    if (!Array.isArray(items)) return null;
    return items.find((item) =>
      String(item?.relative_path ?? "").replaceAll("\\", "/") === path
    ) || null;
  }
  /** §18.1 — one row, toggled by its checkbox or by a click anywhere on the row. */
  setDocumentImportSelected(relativePath, selected) {
    const row = this.documentImportRow(relativePath);
    if (!row) return;
    row.selected = Boolean(selected);
    patchDocumentImportRow(relativePath);
  }
  /** §18.1 — 全选 / 取消全选. */
  setAllDocumentImportSelected(selected) {
    const items = this.ui.documentImportDialog?.items;
    if (!Array.isArray(items)) return;
    for (const item of items) item.selected = Boolean(selected);
    patchDocumentImportRows();
  }
  /**
   * §18 — 取消.  Nothing is adopted: the plan goes back to the editable,
   * unconfirmed state the preview uses for every other stopped import, and the
   * copy says in plain Chinese that no course content was written.
   */
  cancelDocumentImportSelection() {
    if (!this.ui.documentImportDialog) return;
    this.clearDocumentImportDialog();
    const plan = this.ui.importMappingPlan;
    if (plan?.confirmed) {
      this.ui.importMappingPlan = { ...plan, confirmed: false, confirmed_at: null };
    }
    this.ui.importMappingError =
      "已取消正文选择：没有写入任何课程内容，源文件仍在原处。映射预览仍可继续调整，再次确认即可导入。";
    this.notify();
  }
  /**
   * §19 / §31 — apply the dialog's answer to the confirmed plan and import.
   * Unchecked rows are deselected and therefore not sent at all; checked rows
   * keep the mapping and destination the preview already confirmed.
   */
  async confirmDocumentImportSelection() {
    const dialog = this.ui.documentImportDialog;
    if (!dialog || dialog.loading || dialog.token !== this.documentImportGeneration) return;
    this.ui.documentImportDialog = null;
    this.documentImportGeneration += 1;
    const plan = this.ui.importMappingPlan;
    if (!plan?.confirmed) {
      this.ui.importMappingError =
        "映射计划已不再是已确认状态，课程没有写入。请在映射预览里重新确认。";
      this.notify();
      return;
    }
    const items = Array.isArray(dialog.items) ? dialog.items : [];
    const deselected = items
      .filter((item) => item?.source !== "folder" && item?.selected !== true)
      .map((item) => String(item.relative_path ?? ""));
    this.ui.importMappingPlan = applyDocumentImportDeselection(plan, deselected);
    this.ui.documentImportPaths = items
      .filter((item) => item?.source === "folder" && item?.selected === true)
      .map((item) => String(item.relative_path ?? "").replaceAll("\\", "/"));
    // One-shot: the import started from this answer must not re-open the dialog.
    this.ui.documentImportAnswered = true;
    await this.applyFolderAdoption();
  }
  async importSelectedFilesFromPicker() {
    if (!this.bridge.isNative() || !this.data?.project?.id) {
      this.ui.toast = "请先打开课程项目，再从项目概览选择要追加的文件。";
      this.notifyChrome();
      return;
    }
    try {
      const paths = await this.bridge.selectFiles();
      if (!paths.length) return;
      const parents = [...new Set(paths.map((path) => pathParts(path).output_dir))];
      if (parents.length !== 1) {
        throw new Error("多选文件目前要求来自同一文件夹。请分批选择不同文件夹中的资料。");
      }
      const root = parents[0];
      const entries = paths.map((path) => {
        const filename = filenameFromPath(path);
        const extension = filename.split(".").pop()?.toLowerCase() || "";
        const suggested_role = /^(md|markdown|txt|text)$/.test(extension)
          ? "lesson"
          : /^(pdf|doc|docx|odt|rtf)$/.test(extension)
          ? "reference"
          : /^(png|jpe?g|gif|webp|svg|avif|mp4|webm|mov|m4v|mp3|wav|m4a|ogg)$/.test(extension)
          ? "asset"
          : "unsupported";
        return {
          path,
          relative_path: filename,
          kind: "file",
          mime: mimeForFilename(filename),
          size: null,
          suggested_role,
        };
      });
      this.ui.importMode = "append";
      this.ui.folderScan = { root, entries, warnings: [], errors: [] };
      this.ui.mappingScanSnapshot = {
        id: ++this.mappingScanSequence,
        root,
        entries: clone(entries),
      };
      this.ui.importFolderRoot = root;
      this.ui.importMappingPlan = buildImportMappingPlan(root, entries);
      this.mappingGeneration += 1;
      this.clearDocumentImportDialog();
      this.ui.documentImportPaths = [];
      this.ui.importMappingError = "";
      this.ui.route = "mapping";
      this.ui.screen = "project";
      this.ui.toast = `已选择 ${entries.length} 个文件。仅这些文件及 Markdown 明确引用的本地图片会进入映射计划。`;
      this.scheduleSessionSave();
      this.notify();
    } catch (error) {
      this.ui.toast = userFacingError(error, "文件选择没有完成，当前课程没有改变。请重试。");
      this.notify();
    }
  }
  /**
   * Confirm collects the editable plan into UI state (§31).
   * Does not write project.json / Canonical — call applyFolderAdoption next.
   */
  async confirmImportMapping(opener = null) {
    if (!this.ui.importMappingPlan) {
      this.ui.toast = "没有可确认的映射计划。请先打开映射预览。";
      this.notifyChrome();
      return;
    }
    if (this.importInFlight) return;
    this.ui.importMappingError = "";
    this.ui.importMappingNeedsReview = false;
    this.ui.importMappingPlan = confirmImportMappingPlan(this.ui.importMappingPlan);
    await this.applyFolderAdoption({ documentImportOpener: opener });
  }
  /** Confirm and execute the selected import plan as one user action. */
  async applyFolderAdoption({ documentImportOpener = null } = {}) {
    const plan = this.ui.importMappingPlan;
    if (!plan) {
      this.ui.toast = "没有可执行的映射计划。请先打开映射预览。";
      this.notifyChrome();
      return;
    }
    if (!plan.confirmed) {
      this.ui.toast = "请先确认导入计划。";
      this.notifyChrome();
      return;
    }
    if (this.importInFlight) return;
    const appending = this.ui.importMode === "append";
    // §18 — a confirmed plan that carries document candidates stops at the body
    // dialog before anything is written. The answer is consumed once, so the
    // import the dialog launches is not asked again; a plan with no candidate
    // takes no extra click and imports exactly as before.
    const answered = this.ui.documentImportAnswered === true;
    this.ui.documentImportAnswered = false;
    if (!answered) {
      const chooser = await this.openDocumentImportDialog(plan, documentImportOpener);
      if (chooser !== "none") return;
    }
    if (appending && !await this.flush()) {
      this.ui.importMappingPlan = { ...plan, confirmed: false, confirmed_at: null };
      this.ui.importMappingError =
        "追加前保存没有完成，课程内容没有改变。请先修复保存问题，再重新确认追加。";
      this.ui.toast = this.ui.importMappingError;
      this.notify();
      return;
    }
    const sourceIdentityBeforeAdoption = this.saveIdentity();
    if (
      !appending && sourceIdentityBeforeAdoption.project_dir &&
      sourceIdentityBeforeAdoption.expected_project_id &&
      sourceIdentityBeforeAdoption.lease_generation
    ) {
      if (!await this.flush()) {
        this.ui.importMappingError =
          "切换到新课程前，当前课程没有保存成功；新课程尚未创建。请先重试保存。";
        this.ui.toast = this.ui.importMappingError;
        this.notify();
        return;
      }
      if (!this.saveIdentityMatches(sourceIdentityBeforeAdoption)) {
        this.ui.importMappingError = "当前课程已经切换；新课程创建已取消。";
        this.ui.toast = this.ui.importMappingError;
        this.notify();
        return;
      }
    }
    const sourceContext = {
      identity: this.saveIdentity(),
      project: JSON.stringify(this.data),
      route: this.ui.route,
      screen: this.ui.screen,
      plan: JSON.stringify(this.ui.importMappingPlan),
    };
    this.importInFlight = true;
    this.ui.importingMapping = true;
    this.ui.importMappingError = "";
    this.notify();
    let createdRoot = "";
    let importCommitted = false;
    let appendBefore = null;
    let appendSelection = null;
    let appendHistoryRecorded = false;
    let adoptionOwner = null;
    try {
      // Parsing and local image validation happen at the trusted execution
      // boundary; Mapping selection itself never reads or parses source files.
      const executablePlan = clone(plan);
      if (appending) {
        // The successful flush above establishes the undo baseline; take the
        // snapshot at the last safe point before the external Canonical write.
        appendBefore = clone(this.data);
        appendSelection = this.ui.selectedBlockId;
      }
      // One-shot: consumed by the adoption this confirmation started, never by a
      // later import of a different folder.
      const replaceInvalidManifest = this.ui.replaceInvalidProject === true;
      this.ui.replaceInvalidProject = false;
      const commandInput = {
        plan: executablePlan,
        document_paths: [...(this.ui.documentImportPaths || [])],
        // §3.2 Case C only: the user confirmed re-importing a folder whose
        // project.json exists but cannot be read as a project.
        replace_invalid_project: !appending && replaceInvalidManifest,
      };
      let request = commandInput;
      if (!appending) {
        request = {
          ...commandInput,
          editor_generation: sourceContext.identity.editor_generation,
          operation_id: uid(),
          revision: Math.max(1, this.saveRevision),
        };
        adoptionOwner = this.beginCanonicalMutation();
      }
      const execution = appending
        ? await this.runCanonicalMutation("folder.append", request, { preDrained: true })
        : await this.bridge.commandWithMutationAck("folder.adopt", request);
      const result = execution?.value ?? execution;
      const mutationAck = execution?.mutation_ack;
      const adoptedState = mutationAck?.project && mutationAck?.fingerprint
        ? {
          project: mutationAck.project,
          project_id: mutationAck.project_id,
          project_dir: mutationAck.project_dir,
          lease_generation: mutationAck.lease_generation,
          fingerprint: mutationAck.fingerprint,
        }
        : null;
      const adopted = adoptedState?.project || null;
      if (!this.isProjectData(adopted)) {
        throw new Error("文件夹接管没有返回这次写入的绑定确认；不会用后续读取冒充提交确认。");
      }
      const rootValue = result?.root || plan.root || this.ui.importFolderRoot || "";
      const root = typeof rootValue === "string" ? rootValue : "";
      if (!root.trim()) throw new Error("文件夹接管没有返回有效的目标目录。");
      createdRoot = root;
      const expectedAdoptionIdentity = appending ? sourceContext.identity : request;
      const validAdoptionAck = mutationAck?.commit_state === "committed" &&
        ["written", "unchanged"].includes(mutationAck.outcome) &&
        mutationAck.project_id === adopted.project.id &&
        normalizeProjectDir(mutationAck.project_dir) === normalizeProjectDir(root) &&
        (appending
          ? mutationAck.project_id === expectedAdoptionIdentity.expected_project_id &&
            mutationAck.lease_generation === expectedAdoptionIdentity.lease_generation &&
            mutationAck.editor_generation === expectedAdoptionIdentity.editor_generation
          : (mutationAck.lease_generation === null ||
            typeof mutationAck.lease_generation === "string" ||
            Number.isSafeInteger(mutationAck.lease_generation)) &&
            mutationAck.editor_generation === expectedAdoptionIdentity.editor_generation &&
            mutationAck.operation_id === expectedAdoptionIdentity.operation_id &&
            mutationAck.revision === expectedAdoptionIdentity.revision) &&
        this.isFileFingerprint(mutationAck.fingerprint) &&
        mutationAck.fingerprint.exists &&
        adopted.project.id === mutationAck.project_id &&
        (!result?.data || JSON.stringify(result.data) === JSON.stringify(adopted));
      if (!validAdoptionAck) {
        throw new Error("文件夹接管的提交确认与目标课程不匹配；请重新打开目标文件夹核对。");
      }
      if (appending) {
        importCommitted = true;
        if (adopted.project.id !== this.data.project.id) {
          throw new Error("追加结果中的项目身份与当前课程不一致；已写入的数据需要重新载入确认。");
        }
        this.recordExternalCommit("追加文件夹资料", appendBefore, appendSelection);
        appendHistoryRecorded = Boolean(appendBefore);
        await this.persistSession(this.session()).catch((error) =>
          this.reportSessionFailure(error, this.session())
        );
      } else {
        importCommitted = true;
        const sourceStillCurrent = this.saveIdentityMatches(sourceContext.identity) &&
          JSON.stringify(this.data) === sourceContext.project &&
          this.ui.route === sourceContext.route &&
          this.ui.screen === sourceContext.screen &&
          JSON.stringify(this.ui.importMappingPlan) === sourceContext.plan;
        if (!sourceStillCurrent) {
          this.ui.pendingAdoptedProjectRoot = root;
          this.ui.route = "mapping";
          this.ui.screen = "project";
          this.ui.importMappingError =
            "课程项目已经创建，但当前页面状态已变化，因此没有自动切换。请重新打开已创建的课程；不要再次导入。";
          this.ui.toast = this.ui.importMappingError;
          this.notify();
          return;
        }
        if (adoptionOwner) {
          this.endCanonicalMutation(adoptionOwner);
          adoptionOwner = null;
        }
        this.ui.pendingAdoptedProjectRoot = null;
        if (this.bridge.isNative()) {
          await this.openProject(root, { reopen: true });
          const openedState = await this.bridge.openProjectState();
          if (openedState?.project_id !== mutationAck.project_id) {
            throw new Error("课程已经创建，但重新打开时项目身份不匹配。");
          }
        } else {
          this.bridge.setProjectDir(root);
          await this.openProjectFromPicker();
        }
        const opened = this.bridge.lastOpenedProjectState;
        if (
          this.data.project?.id !== mutationAck.project_id ||
          normalizeProjectDir(opened?.project_dir) !== normalizeProjectDir(root) ||
          opened?.project_id !== mutationAck.project_id ||
          !(typeof opened?.lease_generation === "string" ||
            Number.isSafeInteger(opened?.lease_generation))
        ) {
          this.ui.pendingAdoptedProjectRoot = root;
          this.ui.route = "mapping";
          this.ui.screen = "project";
          this.ui.importMappingError =
            "课程项目已经创建，但打开步骤未完成。请重新打开已创建的课程；不要再次导入。";
          this.ui.toast = this.ui.importMappingError;
          this.notify();
          return;
        }
      }
      const stages = Array.isArray(result?.stage_ids) ? result.stage_ids.length : (this.data.stages || []).length;
      const lessons = Array.isArray(result?.content_item_ids)
        ? result.content_item_ids.length
        : (this.data.content_items || []).length;
      const assets = Array.isArray(result?.asset_ids) ? result.asset_ids.length : (this.data.assets || []).length;
      const reused = Array.isArray(result?.reused_asset_ids) ? result.reused_asset_ids.length : 0;
      const parts = [appending ? `已追加到「${this.data.project.title}」` : `已原地接管并写入课程项目`];
      if (stages) parts.push(`${stages} 个阶段`);
      if (lessons) parts.push(`${lessons} 篇课文`);
      if (assets) parts.push(`${assets} 个素材`);
      if (reused) parts.push(`${reused} 个素材已按 checksum 复用`);
      const warnings = [
        ...(Array.isArray(result?.warnings) ? result.warnings : []),
        ...(Array.isArray(execution?.warnings) ? execution.warnings : []),
        ...(typeof mutationAck?.recovery_warning === "string" ? [mutationAck.recovery_warning] : []),
        ...(typeof mutationAck?.durability_warning === "string" ? [mutationAck.durability_warning] : []),
      ].filter((warning) => typeof warning === "string" && warning.trim());
      // §28 — the per-document tally rides on the same result. A shell that does
      // not send `document_import` (an older build, a folder with no document)
      // leaves the panel empty and the warning list doing all the talking.
      const documentReport = normalizeDocumentImportReport(result?.document_import);
      this.ui.documentImportReport = documentReport;
      const warningSummary = warnings.length
        ? ` 注意：${warnings.slice(0, 2).join("；")}${warnings.length > 2 ? `；另有 ${warnings.length - 2} 项提醒` : ""}`
        : "";
      this.ui.route = "map";
      this.scheduleSessionSave();
      this.ui.importMappingError = "";
      this.ui.toast = `${parts.join(" · ")}。原文件未移动或删除。${
        documentImportToastText(documentReport)
      }${warningSummary}`;
      this.notify();
    } catch (error) {
      const raw = String(error?.message || error || "");
      if (appending && importCommitted) {
        if (!appendHistoryRecorded && appendBefore && this.data.project.id === appendBefore.project.id) {
          this.recordExternalCommit("追加文件夹资料", appendBefore, appendSelection);
          appendHistoryRecorded = true;
        }
        this.ui.route = "mapping";
        this.ui.importMappingError =
          "资料已经写入当前课程，但界面刷新没有完成。请返回课程地图核对内容；不要再次追加。";
        this.ui.toast = this.ui.importMappingError;
      } else if (!appending && importCommitted || /课程项目已写入|项目已创建/.test(raw)) {
        this.ui.pendingAdoptedProjectRoot = createdRoot || plan.root;
        this.ui.route = "mapping";
        this.ui.screen = "project";
        this.ui.importMappingError =
          "课程项目已经创建，但后续步骤未完成。请重新打开已创建的课程；不要再次导入。";
        this.ui.toast = this.ui.importMappingError;
      } else {
        this.ui.importMappingPlan = { ...plan, confirmed: false, confirmed_at: null };
        this.ui.importMappingError = userFacingError(
          error,
          "无法完成课程项目写入。原文件未移动或删除；请检查所选文件和映射后重新确认。",
        );
        this.ui.toast = this.ui.importMappingError;
      }
      this.notify();
    } finally {
      if (adoptionOwner) this.endCanonicalMutation(adoptionOwner);
      this.importInFlight = false;
      this.ui.importingMapping = false;
      this.scheduleSessionSave();
      this.notify();
    }
  }
  async retryOpenAdoptedProject() {
    const rootValue = String(this.ui.pendingAdoptedProjectRoot || "");
    const root = rootValue.trim() ? rootValue : "";
    if (!root || !this.bridge.isNative()) return;
    await this.openProject(root, { reopen: true });
    if (this.bridge.projectDir === root && this.hasNativeLease(root)) {
      this.ui.pendingAdoptedProjectRoot = null;
      this.ui.importMappingError = "";
      this.ui.toast = `已打开《${this.data.project.title}》`;
      this.notify();
    } else {
      this.ui.pendingAdoptedProjectRoot = root;
      this.ui.importMappingError =
        "课程项目已经创建，但暂时无法打开。请确认所选文件夹仍可访问后重试；不要再次导入。";
      this.ui.toast = this.ui.importMappingError;
      this.notify();
    }
  }
  setExplorerFilter(query) {
    this.ui.explorerFilter = String(query ?? "");
    this.scheduleSessionSave();
    this.notify();
  }
  toggleExplorerExpanded(relativePath) {
    const path = String(relativePath || "");
    if (!path) return;
    const current = Array.isArray(this.ui.explorerExpanded) ? this.ui.explorerExpanded.slice() : [];
    const index = current.indexOf(path);
    if (index >= 0) current.splice(index, 1);
    else current.push(path);
    this.ui.explorerExpanded = current;
    this.scheduleSessionSave();
    this.notify();
  }
  clearExplorerPreview() {
    this.explorerPreviewGeneration = (this.explorerPreviewGeneration || 0) + 1;
    stopPreviewMedia(globalThis.document?.querySelector?.(".explorer-preview-body"));
    try { this.ui.explorerPreview?.release?.(); } catch { /* source may already be expired */ }
    const markdownUrls = Object.values(this.explorerMarkdownImageUrls || {}).map((value) =>
      typeof value === "string" ? value : value?.url
    );
    this.explorerMarkdownImageUrls = {};
    for (const url of [this.ui.explorerPreview?.url, this.ui.explorerPreview?.posterUrl, ...markdownUrls]) {
      if (typeof url !== "string" || !url.startsWith("blob:")) continue;
      try { URL.revokeObjectURL(url); } catch { /* already released */ }
    }
    this.ui.explorerPreview = null;
  }
  releaseAssetViewerSource() {
    this.assetViewerGeneration = (this.assetViewerGeneration || 0) + 1;
    const source = this.assetViewerSource;
    this.assetViewerSource = null;
    try { source?.release?.(); } catch { /* source may already be expired */ }
    this.ui.assetImagePreviewSource = null;
    this.ui.assetImagePreviewLoading = false;
    this.ui.assetImagePreviewError = "";
  }
  async openAssetViewer(assetId) {
    const asset = this.data.assets.find((candidate) =>
      candidate.id === assetId && !candidate.archived
    );
    if (!asset) return;
    this.releaseAssetViewerSource();
    const generation = this.assetViewerGeneration;
    const projectId = this.data.project.id;
    this.ui.assetImagePreviewId = asset.id;
    this.ui.assetImagePreviewLoading = asset.type === "video";
    this.ui.assetImagePreviewError = "";
    this.notify();
    if (asset.type !== "video") return;
    try {
      const source = await this.bridge.previewAssetVideoSource(asset.id);
      if (typeof source?.url !== "string" || !source.url) {
        throw new Error("视频预览地址无效");
      }
      if (
        generation !== this.assetViewerGeneration ||
        this.ui.assetImagePreviewId !== asset.id ||
        this.data.project.id !== projectId
      ) {
        try { source.release?.(); } catch { /* stale source */ }
        return;
      }
      this.assetViewerSource = source;
      this.ui.assetImagePreviewSource = { asset_id: asset.id, url: source.url };
      this.ui.assetImagePreviewLoading = false;
      this.notify();
    } catch (error) {
      if (
        generation !== this.assetViewerGeneration ||
        this.ui.assetImagePreviewId !== asset.id ||
        this.data.project.id !== projectId
      ) return;
      this.ui.assetImagePreviewLoading = false;
      this.ui.assetImagePreviewError = error?.message || "视频预览暂时不可用";
      this.notify();
    }
  }
  /**
   * Select a ScanResult row and load a non-blank preview (§28).
   * UI-only: never writes Canonical / mapping confirm.
   */
  async selectExplorerEntry(relativePath) {
    this.clearExplorerPreview();
    const previewGeneration = this.explorerPreviewGeneration;
    const path = String(relativePath || "");
    const report = this.ui.folderScan;
    const root = this.ui.importFolderRoot || report?.root || "";
    const entry = Array.isArray(report?.entries)
      ? report.entries.find((row) => String(row.relative_path) === path)
      : null;
    this.ui.explorerSelected = path || null;
    if (!entry) {
      this.scheduleSessionSave();
      this.notify();
      return;
    }
    const kind = explorerPreviewKind(entry);
    if (entry.kind === "directory") {
      this.ui.explorerPreview = {
        relative_path: path,
        preview_kind: "directory",
        text: null,
        url: null,
        note: "文件夹",
        failed: false,
        size: null,
        mime: null,
      };
      const expanded = Array.isArray(this.ui.explorerExpanded)
        ? this.ui.explorerExpanded.slice()
        : [];
      if (!expanded.includes(path)) expanded.push(path);
      this.ui.explorerExpanded = expanded;
      this.scheduleSessionSave();
      this.notify();
      return;
    }
    if (kind === "reference") {
      this.ui.explorerPreview = {
        relative_path: path,
        preview_kind: "reference",
        text: null,
        url: null,
        note: "参考文件 · 仅显示文件信息",
        failed: false,
        size: entry.size,
        mime: entry.mime,
      };
      this.scheduleSessionSave();
      this.notify();
      return;
    }
    this.ui.explorerPreview = {
      relative_path: path,
      preview_kind: kind,
      text: null,
      url: null,
      note: null,
      failed: false,
      loading: true,
      size: entry.size,
      mime: entry.mime,
    };
    this.scheduleSessionSave();
    this.notify();
    if (!root) {
      this.ui.explorerPreview = {
        ...this.ui.explorerPreview,
        loading: false,
        failed: true,
        note: "没有可预览的扫描根目录",
      };
      this.notify();
      return;
    }
    const ownedUrls = [];
    const ownedReleases = [];
    const markdownImageUrls = {};
    const isStale = () => this.explorerPreviewGeneration !== previewGeneration ||
      this.ui.explorerSelected !== path;
    const releaseOwned = () => {
      for (const owned of ownedUrls) { try { URL.revokeObjectURL(owned); } catch { /* already released */ } }
      for (const release of ownedReleases) { try { release(); } catch { /* already released */ } }
    };
    try {
      const preview = kind === "video"
        ? { preview_kind: kind, mime: entry.mime, size: entry.size }
        : await this.bridge.command("folder.read_preview", {
          root,
          relativePath: path,
        });
      if (this.explorerPreviewGeneration !== previewGeneration ||
        this.ui.explorerSelected !== path) return;
      let url = null;
      let posterUrl = null;
      let durationSeconds = null;
      if (kind === "video") {
        const source = await this.bridge.previewFolderVideoSource(root, path);
        if (typeof source?.release === "function") ownedReleases.push(source.release);
        url = source.url;
        const frame = await decodeVideoFrame(url);
        posterUrl = frame.posterUrl;
        durationSeconds = frame.durationSeconds;
        if (posterUrl?.startsWith("blob:")) ownedUrls.push(posterUrl);
      } else if (preview?.bytes_base64 &&
        (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf")) {
        const binary = atob(String(preview.bytes_base64));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        url = explorerUrlForBytes(bytes, preview.mime || entry.mime);
        if (url.startsWith("blob:")) ownedUrls.push(url);
        if (kind === "image") {
          await loadImage(url);
          if (/\.gif$/i.test(path) || String(preview.mime || "").toLowerCase() === "image/gif") {
            posterUrl = await staticImagePoster(bytes, preview.mime || "image/gif");
            if (posterUrl.startsWith("blob:")) ownedUrls.push(posterUrl);
          }
        } else if (kind === "video") {
          const frame = await decodeVideoFrame(url);
          posterUrl = frame.posterUrl;
          durationSeconds = frame.durationSeconds;
          if (posterUrl?.startsWith("blob:")) ownedUrls.push(posterUrl);
        }
      }
      if (preview?.preview_kind === "text" && typeof preview.text === "string" &&
        /\.(md|markdown)$/i.test(path)) {
        const references = [...new Set(parseMarkdown(preview.text).explicitLocalImageRefs.map((ref) => ref.href))];
        const allowedMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
        let totalBytes = 0;
        for (const [index, href] of references.entries()) {
          if (index >= 32) {
            markdownImageUrls[href] = { error: "图片引用过多，最多预览 32 张" };
            continue;
          }
          try {
            const dependency = await this.bridge.command("folder.markdown_image_status", {
              root,
              markdownRelativePath: path,
              href,
            });
            if (isStale()) {
              releaseOwned();
              return;
            }
            if (dependency?.status !== "present") {
              markdownImageUrls[href] = {
                error: dependency?.status === "missing"
                  ? "找不到本地图片"
                  : dependency?.status === "unsafe"
                  ? "图片路径超出来源目录或不可安全读取"
                  : "无法安全检查图片",
              };
              continue;
            }
            const relativePath = String(dependency.relative_path || "");
            const mime = String(dependency.mime || "").toLowerCase();
            const size = Number(dependency.size);
            if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").some((part) => part === "..") ||
              !allowedMimes.has(mime)) {
              markdownImageUrls[href] = { error: "图片路径或格式不适用于安全预览" };
              continue;
            }
            if (!Number.isFinite(size) || size < 0 || size > 16 * 1024 * 1024 || totalBytes + size > 16 * 1024 * 1024) {
              markdownImageUrls[href] = { error: "图片超过 16 MiB 文件预览限制" };
              continue;
            }
            const image = await this.bridge.command("folder.read_preview", { root, relativePath });
            if (isStale()) {
              releaseOwned();
              return;
            }
            if (image?.preview_kind !== "image" || !image.bytes_base64 ||
              String(image.mime || "").toLowerCase() !== mime) {
              markdownImageUrls[href] = { error: "图片文件已改变或无法读取" };
              continue;
            }
            const binary = atob(String(image.bytes_base64));
            const bytes = new Uint8Array(binary.length);
            for (let byte = 0; byte < binary.length; byte += 1) bytes[byte] = binary.charCodeAt(byte);
            if (bytes.length > 16 * 1024 * 1024 || totalBytes + bytes.length > 16 * 1024 * 1024) {
              markdownImageUrls[href] = { error: "图片超过 16 MiB 文件预览限制" };
              continue;
            }
            const imageUrl = explorerUrlForBytes(bytes, mime);
            if (imageUrl.startsWith("blob:")) ownedUrls.push(imageUrl);
            try {
              await loadImage(imageUrl);
              if (mime === "image/gif") {
                const poster = await staticImagePoster(bytes, mime);
                if (poster.startsWith("blob:")) ownedUrls.push(poster);
                if (imageUrl.startsWith("blob:")) {
                  URL.revokeObjectURL(imageUrl);
                  ownedUrls.splice(ownedUrls.indexOf(imageUrl), 1);
                }
                markdownImageUrls[href] = { url: poster };
              } else {
                markdownImageUrls[href] = { url: imageUrl };
              }
              totalBytes += bytes.length;
            } catch {
              if (imageUrl.startsWith("blob:")) {
                URL.revokeObjectURL(imageUrl);
                ownedUrls.splice(ownedUrls.indexOf(imageUrl), 1);
              }
              markdownImageUrls[href] = { error: "图片解码失败，文件可能已损坏" };
            }
          } catch {
            if (isStale()) {
              releaseOwned();
              return;
            }
            markdownImageUrls[href] = { error: "无法安全读取图片" };
          }
        }
      }
      if (isStale()) {
        releaseOwned();
        return;
      }
      this.explorerMarkdownImageUrls = markdownImageUrls;
      const release = ownedReleases.pop() || null;
      this.ui.explorerPreview = {
        relative_path: path,
        preview_kind: preview?.preview_kind || kind,
        text: typeof preview?.text === "string" ? preview.text : null,
        url,
        release,
        posterUrl,
        durationSeconds,
        note: preview?.note || null,
        failed: Boolean(preview?.error),
        loading: false,
        size: preview?.size ?? entry.size,
        mime: preview?.mime ?? entry.mime,
        error: preview?.error || null,
      };
      this.notify();
    } catch (error) {
      if (isStale()) {
        releaseOwned();
        return;
      }
      releaseOwned();
      this.ui.explorerPreview = {
        relative_path: path,
        preview_kind: kind,
        text: null,
        url: null,
        note: null,
        failed: true,
        loading: false,
        size: entry.size,
        mime: entry.mime,
        error: userFacingError(error, "无法预览该文件"),
      };
      this.notify();
    }
  }
  /**
   * Ask the shell what is actually inside a folder.  Classification is a
   * read-only, lock-free command, so a failure here means "the shell could not
   * tell us" rather than "the folder is broken" — the caller keeps its original
   * error in that case.
   */
  async inspectFolder(dir) {
    const path = String(dir || "").trim();
    if (!path) return null;
    try {
      return projectInspection(await this.bridge.command("project.inspect", { path }));
    } catch {
      return null;
    }
  }
  /**
   * §3.2/§3.3: one folder pick, two outcomes.
   *
   * A folder without `project.json` is not an error — it goes straight into the
   * existing scan + mapping flow, because asking the user to know the difference
   * between "打开项目文件夹" and "导入已有文件夹" before Workbench can help is the
   * complaint itself.  A folder whose `project.json` exists but cannot be used
   * keeps its own overlay, with the first actionable failure already visible.
   */
  async routeFolderInspection(dir, inspection) {
    if (inspection.status === "no_project_json") {
      this.ui.projectProblem = null;
      await this.importExistingFolder(dir, "adopt");
      return;
    }
    this.ui.projectProblem = {
      dir,
      status: inspection.status,
      schemaVersion: inspection.schema_version,
      supportedSchemaVersion: inspection.supported_schema_version,
      problem: inspection.problem,
      confirmReimport: false,
    };
    this.ui.toast = projectProblemText(inspection.problem);
    this.notify();
  }
  /** 返回: drop the diagnosis and lose nothing — the folder was never touched. */
  dismissProjectProblem() {
    const wasLocked = this.ui.projectProblem?.status === "locked";
    this.ui.projectProblem = null;
    this.ui.toast = wasLocked
      ? "已返回。项目锁仍由原编辑窗口持有，当前项目文件夹没有被修改。"
      : "已返回。这个文件夹没有被修改。";
    this.notify();
  }
  async retryLockedProjectOpen() {
    const problem = this.ui.projectProblem;
    if (problem?.status !== "locked" || !problem.dir) return;
    const dir = problem.dir;
    this.ui.projectProblem = null;
    this.notify();
    await this.openProject(dir, { reopen: true });
  }
  /**
   * §3.2 Case C, second step: re-import an unusable folder as a material folder.
   * The scan is read-only; the existing `project.json` is only ever moved aside
   * (never deleted) once the user confirms the import itself.
   */
  async reimportProjectProblemFolder({ replaceInvalid = false } = {}) {
    const problem = this.ui.projectProblem;
    if (!problem?.dir) return;
    // Never offer to move aside a project that is only newer than this build.
    if (problem.problem?.code === "unsupported_schema") {
      this.ui.toast = "这个项目由更高版本的 Workbench 创建，当前版本不会改写它。";
      this.notify();
      return;
    }
    if (!replaceInvalid) {
      this.ui.projectProblem = { ...problem, confirmReimport: true };
      this.notify();
      return;
    }
    const dir = problem.dir;
    this.ui.projectProblem = null;
    this.ui.replaceInvalidProject = true;
    await this.importExistingFolder(dir, "adopt");
  }
  /**
   * Open a project directory.
   *
   * Durable lease invariants: the previous lease is released only after the
   * target is readable and saved; a provisional target lease is rolled back on
   * any failure, and a rejected `project_open` never releases a lease we do
   * not own.
   *
   * `reopen` is the "the user just picked this folder" intent.  Without it, a
   * request for the directory that already holds the active lease is a no-op:
   * that is what the launcher needs when it restores a session.  With it, the
   * picker must always do something visible — re-picking the folder that is
   * already open used to return in silence, so 打开项目文件夹 looked like a
   * dead button.
   */
  async openProject(projectDir = "", { reopen = false } = {}) {
    if (!this.bridge.isNative()) {
      await this.openProjectFromPicker();
      return;
    }
    if (!await this.resolveNativeSwitchPending()) return;
    const previousProjectDir = this.bridge.projectDir;
    const previousProjectDirFromUrl = this.bridge.projectDirFromUrl;
    const previousLeaseActive = this.hasNativeLease(previousProjectDir);
    if (previousLeaseActive && previousProjectDir === projectDir) {
      if (!reopen) return;
      // Re-entry into the folder that is already leased: re-read it from disk
      // (the user is asking for it on purpose) and show the same feedback a
      // fresh open shows.  `reopenLeasedProject` reports its own failure, so
      // the generic open path below must not run a second time.
      await this.reopenLeasedProject(projectDir);
      return;
    }
    const restoreProjectDir = previousLeaseActive ? previousProjectDir : null;
    const restoreProjectDirFromUrl = previousLeaseActive ? previousProjectDirFromUrl : false;
    const restoreOpenedProjectState = this.bridge.lastOpenedProjectState;
    let restoreSession = null;
    let targetOpened = false;
    try {
      // The old canonical project and its reader position are durable before
      // target acquisition.  A conflict therefore aborts without touching the
      // old lease or session pointer.
      if (previousLeaseActive && previousProjectDir !== projectDir && !await this.flush()) {
        throw new Error("当前项目保存失败，请重试后再切换项目");
      }
      this.nativeSwitching = true;
      restoreSession = previousLeaseActive ? this.session() : null;
      this.bridge.setProjectDir(projectDir);
      // `openProject` acquires the target lease and reads its canonical data.
      const opened = await this.bridge.openProject();
      // A diagnosis payload (or an empty open we can now classify) decides the
      // route: import the folder, or show its real first failure.  Neither holds
      // a lease, so the previous project pointer goes back before we continue.
      const diagnosis = projectInspection(opened) ||
        (opened == null ? await this.inspectFolder(projectDir) : null);
      if (diagnosis) {
        this.bridge.restoreProjectDir(
          restoreProjectDir,
          restoreProjectDirFromUrl,
          restoreOpenedProjectState,
        );
        await this.routeFolderInspection(projectDir, diagnosis);
        return;
      }
      if (opened == null) throw new Error(describeProjectOpenFailure(null, { missingJson: true }));
      targetOpened = true;
      // A non-null open result may have acquired a lease even when validation
      // below rejects its project payload; rollback must track that lease.
      this.markNativeLease(projectDir);
      if (!this.isProjectData(opened)) throw new Error(describeProjectOpenFailure(null, { notObject: true }));
      const openedState = this.bridge.lastOpenedProjectState;
      const targetProject = openedState?.project;
      if (
        !this.isProjectData(targetProject) ||
        targetProject.project.id !== opened.project.id ||
        openedState.project_id !== targetProject.project.id ||
        normalizeProjectDir(openedState.project_dir) !== normalizeProjectDir(projectDir) ||
        !this.isFileFingerprint(openedState.fingerprint)
      ) throw new Error("项目打开确认与当前目录不匹配；请重新打开项目后重试。");
      const targetData = migrateUiProject(targetProject);
      const targetSession = this.targetSession(targetData, projectDir, "overview");
      // Save only a fully constructed target identity.  In particular, this
      // is never `this.session()`, whose data/UI still describe the old project.
      await this.persistSession(targetSession);
      if (previousLeaseActive && previousProjectDir !== projectDir) {
        await this.closeNativeProject(previousProjectDir);
      }
      this.commitNativeProject(
        targetData,
        this.normalizeReaderState(targetData, targetSession, "overview"),
        openedState?.fingerprint,
      );
      if (!this.offerPendingRecovery(openedState.recovery_journal)) {
        this.ui.toast = `已打开《${this.data.project.title}》`;
      }
      this.notify();
    } catch (error) {
      if (!targetOpened) {
        // A rejected or empty project_open did not establish a target lease;
        // never close a directory this instance does not own or rewrite the
        // still-coherent old session.
        this.bridge.restoreProjectDir(
          restoreProjectDir,
          restoreProjectDirFromUrl,
          restoreOpenedProjectState,
        );
      } else {
        try {
          await this.rollbackNativeTarget(
            projectDir,
            restoreProjectDir,
            restoreProjectDirFromUrl,
            error,
            restoreSession,
            restoreOpenedProjectState,
          );
        } catch (rollbackError) {
          error = rollbackError;
        }
      }
      const errorMessage = String(error?.message || error || "");
      if (error?.code === "project_locked" || /^project_locked\s*:/i.test(errorMessage)) {
        this.ui.projectProblem = {
          dir: projectDir,
          status: "locked",
          confirmReimport: false,
          problem: {
            code: "project_locked",
            path: projectDir,
            expected: "项目目录没有其他活跃编辑窗口",
            actual: "项目锁由另一个窗口或进程持有",
            message: "该项目已在另一窗口或进程中编辑。为避免覆盖，Workbench 没有接管项目锁，也没有修改项目内容。",
          },
        };
        this.ui.toast = "";
      } else {
        this.ui.toast = userFacingError(error, "无法打开项目。当前项目没有改变，请重试。");
      }
      this.notify();
    } finally {
      this.nativeSwitching = false;
    }
  }
  /**
   * Re-enter the folder this instance already holds a lease on.
   *
   * The canonical file is re-read (a deliberate open should show what is on
   * disk now), the reader position is kept, and the screen switches to the
   * project.  Never discards unsaved work: the flush comes first.
   */
  async reopenLeasedProject(projectDir) {
    const restoreProjectDirFromUrl = this.bridge.projectDirFromUrl;
    const restoreOpenedProjectState = this.bridge.lastOpenedProjectState;
    try {
      if (!await this.flush()) throw new Error("当前项目保存失败，请重试后再打开");
      this.bridge.setProjectDir(projectDir);
      const opened = await this.bridge.openProject();
      // The lease already belongs to this folder, so a diagnosis here is shown
      // or imported without touching the pointer it was taken with.
      const diagnosis = projectInspection(opened) ||
        (opened == null ? await this.inspectFolder(projectDir) : null);
      if (diagnosis) {
        await this.routeFolderInspection(projectDir, diagnosis);
        return true;
      }
      if (opened == null) {
        throw new Error(describeProjectOpenFailure(null, { missingJson: true }));
      }
      if (!this.isProjectData(opened)) {
        const recheck = await this.inspectFolder(projectDir);
        throw new Error(
          describeProjectOpenFailure(null, {
            diagnosis: recheck?.status || "invalid",
            problemCode: recheck?.problem?.code || "",
          }),
        );
      }
      const openedState = this.bridge.lastOpenedProjectState;
      const targetProject = openedState?.project;
      if (
        !this.isProjectData(targetProject) ||
        targetProject.project.id !== opened.project.id ||
        openedState.project_id !== targetProject.project.id ||
        normalizeProjectDir(openedState.project_dir) !== normalizeProjectDir(projectDir) ||
        !this.isFileFingerprint(openedState.fingerprint)
      ) throw new Error("重新打开项目确认与当前目录不匹配。当前项目没有改变，请重试。");
      const targetData = migrateUiProject(targetProject);
      const targetSession = this.targetSession(targetData, projectDir, "project");
      await this.persistSession(targetSession);
      this.commitNativeProject(
        targetData,
        this.normalizeReaderState(targetData, targetSession, "project"),
        openedState?.fingerprint,
      );
      if (!this.offerPendingRecovery(openedState.recovery_journal)) {
        this.ui.toast = `已打开《${this.data.project.title}》`;
      }
      this.notify();
      return true;
    } catch (error) {
      this.bridge.restoreProjectDir(projectDir, restoreProjectDirFromUrl, restoreOpenedProjectState);
      this.ui.toast = userFacingError(error, "无法打开项目。当前项目没有改变，请重试。");
      this.notify();
      return false;
    }
  }
  async openProjectFromPicker() {
    if (this.bridge.isNative()) {
      try {
        const dir = await this.bridge.selectFolder();
        if (!dir) {
          // A cancelled pick is fine, an unavailable picker is not: say which
          // one happened instead of leaving the button looking dead.
          this.ui.toast = "没有选择文件夹。你可以再点一次「打开项目文件夹」，或点「新建课程」。";
          this.notifyChrome();
          return;
        }
        await this.openProject(dir, { reopen: true });
      } catch (error) {
        this.ui.toast = userFacingError(error, "无法打开项目。当前项目没有改变，请重试。");
        this.notify();
      }
      return;
    }
    let adopted = false;
    try {
      const session = await this.bridge.loadSession();
      const openedState = typeof this.bridge.openProjectState === "function"
        ? await this.bridge.openProjectState()
        : null;
      const state = openedState && Object.hasOwn(openedState, "project") &&
          Object.hasOwn(openedState, "fingerprint")
        ? openedState
        : await this.readProjectSnapshot();
      const project = state?.project;
      this.assetPreview.clear();
      if (this.isProjectData(project) && this.adoptProjectSnapshot(state)) {
        this.ui.screen = "project";
        this.ui.activeId = null;
        this.ui.selectedBlockId = null;
        this.tabs = [];
        // A different project replaces every AI row: its panel state must go
        // with the previous one (resetAiState also re-reads the side files).
        this.resetAiState();
        adopted = true;
        await this.restoreSession(session);
        this.ui.toast = `已打开《${this.data.project.title}》`;
      } else {
        this.ui.toast = "还没有可打开的项目。请选择项目文件，或先新建一门课程。";
      }
    } catch (error) {
      this.ui.toast = userFacingError(error, "无法打开项目。当前项目没有改变，请重试。");
    }
    // A failed open keeps the current project, so its AI panel must survive.
    if (!adopted) this.refreshAiSideFiles();
    this.notify();
  }
  /**
   * "你现在有什么？" — turn what the user already has into a course map draft.
   *
   * The Domain owns both halves: `course.seed.create` records the input as one
   * of the nine `course_seeds.source_type` values the schema defines, and
   * `blueprint.build` derives the stage/content nodes from it.  Neither step
   * creates official stages or lessons — that happens only when the user
   * confirms the draft — so this entrance can never silently restructure a
   * course, and it needs no enum of its own.
   */
  pickSeed(sourceType) {
    if (!SEED_TEXT_SOURCES.includes(sourceType)) return;
    this.ui.seedType = this.ui.seedType === sourceType ? null : sourceType;
    this.ui.seedText = "";
    // The paste box is the whole point of this card: put the caret in it.
    if (this.ui.seedType) this.ui.focusField = "seed-text";
    this.notify();
  }
  cancelSeed() {
    if (!this.ui.seedType) return;
    this.ui.seedType = null;
    this.ui.seedText = "";
    this.notify();
  }
  async startSeed() {
    const type = this.ui.seedType;
    if (!SEED_TEXT_SOURCES.includes(type)) return;
    const rawText = String(this.ui.seedText || "").trim();
    if (!rawText) {
      this.ui.toast = "先粘贴或写下你现有的内容，再生成课程地图草稿。";
      this.notify();
      return;
    }
    this.ui.seedBusy = true;
    this.notify();
    let seedSaved = false;
    try {
      const seedResult = await this.runCanonicalMutation("course.seed.create", {
        source_type: type,
        raw_text: rawText,
      });
      const seedValue = seedResult.value?.seed ?? seedResult.value?.value ?? seedResult.value ?? seedResult;
      const seedId = seedValue && typeof seedValue.id === "string" ? seedValue.id : null;
      if (!seedId) throw new Error("课程输入没有保存成功");
      seedSaved = true;
      await this.runCanonicalMutation("blueprint.build", { course_seed_id: seedId });
      this.resetAiState();
      this.ui.seedType = null;
      this.ui.seedText = "";
      this.ui.route = "map";
      this.ui.toast = "已生成课程地图草稿；确认后才会创建正式阶段与内容。";
    } catch (error) {
      this.ui.toast = seedSaved
        ? `课程输入已保存，但课程地图草稿没有生成。${userFacingError(error, "请重试生成；已保存的输入不会丢失。")}`
        : userFacingError(error, "生成课程地图草稿失败。课程内容没有改变，请重试。");
    }
    this.ui.seedBusy = false;
    this.notify();
  }
  confirmBlueprint(draftId) {
    this.commit("确认课程地图", (data) => {
      const draft = (data.blueprint_drafts || []).find((candidate) => candidate.id === draftId);
      if (!draft || draft.status !== "draft") throw new Error("找不到待确认的课程草稿");
      const seed = (data.course_seeds || []).find((candidate) => candidate.id === draft.course_seed_id);
      if (!seed || seed.project_id !== null) throw new Error("这份课程输入已经确认过");
      data.project.title = draft.title;
      seed.project_id = data.project.id;
      const nodes = (data.blueprint_nodes || []).filter((node) => node.blueprint_id === draft.id).sort((a, b) => a.order_index - b.order_index);
      const stageIds = new Map();
      let stageOrder = 0;
      const contentOrderByStage = new Map();
      for (const node of nodes.filter((candidate) => candidate.node_type === "stage")) {
        const stageId = uid();
        stageIds.set(node.id, stageId);
        data.stages.push({ id: stageId, project_id: data.project.id, parent_stage_id: null, code: `S${String(stageOrder + 1).padStart(2, "0")}`, title: node.title, description: "", learning_action: "", order_index: stageOrder, archived: false, created_at: now(), updated_at: now() });
        stageOrder += 1;
        contentOrderByStage.set(stageId, 0);
      }
      for (const node of nodes.filter((candidate) => candidate.node_type === "stage")) {
        const stage = data.stages.find((candidate) => candidate.id === stageIds.get(node.id));
        if (stage) stage.parent_stage_id = node.parent_id ? stageIds.get(node.parent_id) ?? null : null;
      }
      for (const node of nodes.filter((candidate) => candidate.node_type === "content")) {
        const stageId = node.parent_id ? stageIds.get(node.parent_id) ?? null : null;
        const stage = data.stages.find((candidate) => candidate.id === stageId);
        const contentOrder = stageId ? contentOrderByStage.get(stageId) ?? 0 : data.content_items.length;
        const contentId = uid();
        const document = { id: uid(), content_item_id: contentId, schema_version: data.schema_version, created_at: now(), updated_at: now() };
        data.documents.push(document);
        data.content_items.push({ id: contentId, project_id: data.project.id, stage_id: stageId, code: stage ? `${stage.code}-${String(contentOrder + 1).padStart(2, "0")}` : `C${String(contentOrder + 1).padStart(2, "0")}`, title: node.title, type: node.suggested_type === "stage_intro" ? "lesson" : node.suggested_type, description: "", order_index: contentOrder, document_id: document.id, archived: false, created_at: now(), updated_at: now() });
        initializeStatusesFor(data, contentId);
        if (stageId) contentOrderByStage.set(stageId, contentOrder + 1);
      }
      draft.status = "confirmed";
      draft.confirmed_at = now();
      this.ui.activeId = data.content_items.find((item) => !item.archived)?.id || null;
    });
    this.ui.screen = "project";
    this.ui.route = "editor";
    if (this.ui.activeId) this.openTab(this.ui.activeId, "writing");
    this.ui.toast = "课程地图已确认，可以开始制作";
  }
  openTab(id, mode = this.ui.mode) {
    const tab = this.tabs.find((candidate) => candidate.content_item_id === id);
    if (tab) tab.mode = mode;
    else this.tabs.push({ content_item_id: id, mode, pinned: false, scroll_top: 0 });
  }
  loadProjectPayload(value) {
    if (!this.isProjectData(value)) throw new Error("这个文件不是可用的课程项目，请选择正确的项目文件。");
    this.data = migrateUiProject(value);
      this.trackProjectIdentity();
    this.ui.screen = "project";
    this.ui.route = "overview";
    this.ui.activeId = null;
    this.ui.selectedBlockId = null;
    this.ui.focusRequirementId = null;
    this.tabs = [];
    this.resetAiState();
    this.scheduleSessionSave();
    this.notify();
  }
  assetContext(blockId = null) {
    const item = this.currentItem();
    const focused = this.data.requirements.find((requirement) => requirement.id === this.ui.focusRequirementId);
    const layout = item ? this.layout(item) : null;
    const inLayout = this.ui.route === "free-layout" || this.ui.mode === "layout";
    return {
      project_id: this.data.project.id,
      content_item_id: item?.id || this.ui.activeId || null,
      block_id: blockId || this.selectedBlock()?.id || focused?.anchor_block_id || null,
      layout_instance_id: inLayout ? layout?.id || null : null,
      role: inLayout ? "layout" : "content",
      route: this.ui.route,
      mode: this.ui.mode,
    };
  }
  importedAssets(result) {
    const payload = parseNativeValue(result);
    const collect = (value) => {
      const candidate = parseNativeValue(value);
      if (!candidate || typeof candidate !== "object") return [];
      if (Array.isArray(candidate)) return candidate.flatMap((entry) => collect(entry));
      if (candidate.asset && typeof candidate.asset === "object") return [candidate.asset];
      if (Array.isArray(candidate.assets)) return candidate.assets.flatMap((entry) => collect(entry));
      if (candidate.value && typeof candidate.value === "object") return collect(candidate.value);
      return candidate.id && (candidate.filename || candidate.storage_path) ? [candidate] : [];
    };
    return collect(payload);
  }
  /**
   * Some commands answer with the whole canonical project instead of a delta —
   * only the shell knows how many references it had to rewrite.
   */
  replaceProjectFrom(payload) {
    if (payload && Object.hasOwn(payload, "project_state")) {
      return this.adoptProjectSnapshot(payload.project_state);
    }
    if (typeof this.bridge.readProjectState === "function") return false;
    const project = payload?.project && this.isProjectData(payload.project)
      ? payload.project
      : payload?.value?.project && this.isProjectData(payload.value.project)
      ? payload.value.project
      : null;
    if (!project) return false;
    this.data = migrateUiProject(project);
    this.trackProjectIdentity();
    return true;
  }
  async reconcileCanonicalMutation(payload) {
    // Canonical commands must go through runCanonicalMutation, which validates
    // the request-bound committed ack before adopting it. A post-write read is
    // not evidence of which bytes this operation committed.
    return Boolean(payload?.mutation_ack?.commit_state === "committed") &&
      payload.mutation_ack.project_id === this.expectedProjectId;
  }
  async mergeImportedResult(result) {
    const payload = parseNativeValue(result);
    const warning = recoveryWarning(payload);
    if (warning) this.noteRecoveryWarning(warning);
    if (payload?.mutation_ack?.commit_state === "committed") {
      // runCanonicalMutation already adopted the acknowledged project snapshot.
      this.resetAiState();
      return;
    }
    const usage = payload?.usage || payload?.value?.usage;
    if (!Array.isArray(this.data.asset_usages)) this.data.asset_usages = [];
    if (usage?.id && !this.data.asset_usages.some((candidate) => candidate.id === usage.id)) {
      this.data.asset_usages.push(usage);
    }
    for (const asset of this.importedAssets(payload)) {
      if (!asset?.id || this.data.assets.some((candidate) => candidate.id === asset.id)) continue;
      this.data.assets.push(asset);
    }
  }
  async importNativeFiles(paths) {
    if (!this.bridge.isNative() || !this.bridge.projectDir) {
      this.ui.toast = "还没有打开课程项目，暂时不能导入素材。请先打开或新建项目。";
      this.notify();
      return;
    }
    const requested = (paths || []).filter((path) => typeof path === "string" && path.trim());
    const selected = [...new Set(requested)];
    const batch = {
      imported: 0,
      duplicate: 0,
      failed: 0,
      skipped: requested.length - selected.length,
      captured: 0,
      failures: [],
    };
    if (!selected.length) return;
    if (!await this.flush()) {
      this.ui.toast = this.ui.toast || "素材导入前没有保存成功，素材尚未导入。请先重试保存。";
      this.notify();
      return;
    }
    const before = clone(this.data);
    const selection = this.ui.selectedBlockId;
    for (const sourcePath of selected) {
      const filename = filenameFromPath(sourcePath);
      // Each file owns its try/catch: one unreadable path must never cancel the
      // rest of the batch or hide the imports that already reached disk.
      try {
        const mimeType = mimeForFilename(filename);
        const result = await this.runCanonicalMutation("asset.import", {
          source_path: sourcePath,
          filename,
          mime_type: mimeType,
          type: assetTypeForFile(filename, mimeType),
        });
        const rowsBefore = this.data.assets.length;
        await this.mergeImportedResult(result);
        const grew = this.data.assets.length > rowsBefore;
        if (batchLandedAsset(result, grew)) batch.imported += 1;
        else batch.duplicate += 1;
      } catch (error) {
        batch.failed += 1;
        batch.failures.push(`${filename}：${userFacingError(error, "素材导入没有完成")}`);
      }
    }
    try {
      if (batch.imported) this.recordExternalCommit("批量导入素材", before, selection);
    } catch (error) {
      batch.failed += 1;
      batch.failures.push(userFacingError(error, "素材导入后的项目刷新没有完成"));
    }
    this.ui.screen = "project";
    this.ui.route = "media";
    this.ui.toast = assetBatchToast(batch, "已导入", this.recoveryWarning || "");
    this.notify();
  }
  async selectAndImportAsset() {
    if (!this.bridge.isNative()) return;
    try {
      const paths = await this.bridge.selectFiles();
      if (!Array.isArray(paths) || !paths.length) {
        // A cancelled pick is fine, an unavailable picker is not: say which
        // one happened instead of leaving the button looking dead.
        this.ui.toast = "没有选择素材文件。系统文件框支持一次多选，你可以再点一次「＋ 添加素材」。";
        this.notifyChrome();
        return;
      }
      await this.importNativeFiles(paths);
    } catch (error) {
      this.ui.toast = userFacingError(error, "没有选中可用的素材文件，请重试。");
      this.notify();
    }
  }
  /**
   * Browser-shell batch import: the drop zone and the hidden multi-picker both
   * land here so a folder of files reports the same per-file accounting as the
   * native picker.
   */
  async importBrowserFiles(files) {
    const requested = [...(files || [])].filter((file) => file && typeof file === "object");
    const batch = {
      imported: 0,
      duplicate: 0,
      failed: 0,
      skipped: 0,
      captured: 0,
      failures: [],
    };
    if (!requested.length) return;
    if (!await this.flush()) {
      this.ui.toast = this.ui.toast || "素材导入前没有保存成功，素材尚未导入。请先重试保存。";
      this.notify();
      return;
    }
    const before = clone(this.data);
    const selection = this.ui.selectedBlockId;
    for (const file of requested) {
      const name = String(file.name || "导入文件");
      try {
        const type = String(file.type || "");
        const projectJson = /\.json$/i.test(name) || type === "application/json";
        const assetFile = isAssetFile(name, type);
        const textFile = type.startsWith("text/") || /\.txt$/i.test(name);
        if (!projectJson && !assetFile && !textFile) {
          throw new Error("当前不支持这种文件格式；支持项目 JSON、文本、图片、视频、音频和参考文档。");
        }
        const size = Number(file.size);
        const limit = this.assetPreview?.mediaLimit ?? 8 * 1024 * 1024;
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error("无法确认文件大小，文件尚未读取。");
        }
        if (size > limit) {
          throw new Error(`单个文件超过 ${Math.round(limit / (1024 * 1024))} MiB 上限，文件尚未读取。`);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (projectJson) {
          const parsed = JSON.parse(new TextDecoder().decode(bytes));
          if (this.isProjectData(parsed)) {
            if (requested.length > 1) {
              batch.skipped += 1;
              continue;
            }
            const previous = clone(this.data);
            this.loadProjectPayload(parsed);
            try {
              const revision = nextRevision(this.data.project.updated_at);
              this.data.project.updated_at = revision;
              const snapshot = clone(this.data);
              await this.persistProjectSnapshot(snapshot, {
                project_id: snapshot.project.id,
                canonical_revision: revision,
                saved_at: revision,
                project: snapshot,
              });
            } catch (error) {
              this.data = previous;
              this.trackProjectIdentity();
              throw error;
            }
            this.ui.toast = "已打开项目文件";
            this.notify();
            return;
          }
        }
        if (assetFile) {
          const base64 = (() => {
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            return btoa(binary);
          })();
          const result = await this.runCanonicalMutation("asset.import", {
            filename: name,
            mime_type: file.type || mimeForFilename(name),
            type: assetTypeForFile(name, file.type),
            bytes_base64: base64,
          });
          const rowsBefore = this.data.assets.length;
          await this.mergeImportedResult(result);
          const grew = this.data.assets.length > rowsBefore;
          if (batchLandedAsset(result, grew)) batch.imported += 1;
          else batch.duplicate += 1;
        } else {
          this.captureToInbox(new TextDecoder().decode(bytes), name.replace(/\.[^.]+$/, ""));
          batch.captured += 1;
        }
      } catch (error) {
        batch.failed += 1;
        batch.failures.push(`${name}：${userFacingError(error, "文件导入没有完成")}`);
      }
    }
    if (batch.imported) this.recordExternalCommit("批量导入素材", before, selection);
    this.ui.screen = "project";
    this.ui.route = batch.captured && !batch.imported ? "inbox" : "media";
    this.ui.toast = assetBatchToast(batch, "已将", this.recoveryWarning || "");
    this.notify();
  }
  undo() {
    const change = this.history[this.history.length - 1];
    if (!change) return;
    if (change.physical_rename) return this.stepPhysicalRename("undo");
    this.history.pop();
    this.future.push(change);
    this.data = clone(change.before);
    this.ui.selectedBlockId = change.selection ?? null;
    this.retainUiSelection();
    this.ui.toast = `已撤销：${change.label}`;
    this.saveStatus = "正在保存…";
    this.scheduleSave();
    this.notify();
  }
  redo() {
    const change = this.future[this.future.length - 1];
    if (!change) return;
    if (change.physical_rename) return this.stepPhysicalRename("redo");
    this.future.pop();
    this.history.push(change);
    this.data = clone(change.after);
    this.ui.selectedBlockId = change.selection ?? null;
    this.retainUiSelection();
    this.ui.toast = `已恢复：${change.label}`;
    this.scheduleSave();
    this.notify();
  }
  /**
   * §14.5 — undo/redo for a step that moved a file on disk.  A snapshot restore
   * alone would leave the project naming a file that is not there, so the same
   * command swaps the file back first; the history entry only moves once the
   * filesystem agrees with it.
   */
  async stepPhysicalRename(direction) {
    const source = direction === "undo" ? this.history : this.future;
    const target = direction === "undo" ? this.future : this.history;
    const change = source[source.length - 1];
    const step = change?.physical_rename;
    if (!change || !step) return;
    const moveTo = direction === "undo" ? step.previous_name : step.next_name;
    if (!await this.flush()) {
      if (this.saveStatus !== "保存结果待核验") {
        this.ui.toast = "素材重命名步骤没有保存成功，文件名称保持当前状态。";
      }
      this.notify();
      return;
    }
    let mutationWarnings = [];
    try {
      const mutation = await this.runCanonicalMutation("asset.rename", {
        asset_id: step.asset_id,
        new_name: moveTo,
      });
      mutationWarnings = mutation.warnings;
    } catch (error) {
      const uncertain = (error?.commit_state ?? error?.details?.commit_state) === "outcome_uncertain";
      if (!uncertain) {
        this.ui.toast = `素材文件没有换成「${moveTo}」：${userFacingError(error, `${direction === "undo" ? "撤销" : "恢复"}没有完成，文件名称保持当前状态。`)}`;
      }
      this.notify();
      return;
    }
    source.pop();
    target.push(change);
    // The command has just moved the file, so the project it answered with is the
    // only state that agrees with the disk: a managed name is derived from the
    // asset id, while the history snapshot still names the path this very rename
    // invalidated.  Restoring that snapshot left the asset pointing at a file that
    // no longer existed, so the step takes the command's result and only borrows
    // the snapshot for the selection.
    this.ui.selectedBlockId = change.selection ?? null;
    this.retainUiSelection();
    const success = direction === "undo"
      ? `已撤销：${change.label}`
      : `已恢复：${change.label}`;
    this.ui.toast = mutationWarnings?.length
      ? `${success}；${mutationWarnings.join("；")}`
      : success;
    this.notify();
  }
  /* ---------------------------------------------------------------- registry */

  /**
   * §5 — the start page reads the registry from the shell every time it shows.
   *
   * A missing or damaged registry is an empty list, never an error screen: the
   * rows are rebuildable convenience state, and the courses themselves live on
   * disk.  The rows arrive already newest-first; the shell re-sorts so a service
   * that returns them in another order cannot make the page flicker between two
   * renders of the same data.
   */
  async loadRegistryRows() {
    try {
      const listed = await this.bridge.command("registry.list");
      const rows = Array.isArray(listed?.projects) ? listed.projects : [];
      this.ui.registryProjects = sortRegistryRows(rows);
    } catch {
      this.ui.registryProjects = [];
    }
    this.notify();
  }
  /**
   * §4.2 — record the project that just became current.
   *
   * Create, open and adopt all end in one of the two commit points, so this one
   * call covers the three.  It runs *after* the project is loaded and safe: the
   * registry is convenience state, so a failed record must never be dressed up
   * as a failed open.  A `duplicate` answer is the one case the user has to
   * decide on, and it opens the §4.4 prompt instead of guessing.
   */
  async recordCurrentProject() {
    const project = this.data?.project;
    const projectId = String(project?.id || "").trim();
    const projectPath = String(this.bridge.projectDir || "").trim();
    if (!projectId || !projectPath) return null;
    let result = null;
    try {
      result = await this.bridge.command("registry.record", {
        project_id: projectId,
        project_path: projectPath,
        project_title: String(project.title || ""),
        last_content_item_id: String(this.ui.activeId || ""),
      });
    } catch {
      return null;
    }
    if (result?.status === "duplicate") {
      this.ui.registryCopy = {
        project_id: projectId,
        project_title: String(project.title || ""),
        existing_path: String(result?.project?.project_path || ""),
        opened_path: projectPath,
      };
      this.notify();
    }
    return result;
  }
  /** §5 — a row opens through the same route 「打开项目文件夹」 uses. */
  async openRegistryProject(projectPath) {
    const dir = String(projectPath || "").trim();
    if (!dir) return;
    // `openProject` reads that folder's `project.json`, runs the full
    // classification, and routes a folder that turns out not to be an openable
    // project; the registry row is not a shortcut past any of that.
    await this.openProject(dir, { reopen: true });
  }
  /** §4.3 — point a row at a new folder, with the shell's id check. */
  async relocateRegistryProject(projectId) {
    const id = String(projectId || "").trim();
    if (!id) return;
    let dir = "";
    try {
      dir = String(await this.bridge.selectFolder() || "").trim();
    } catch {
      this.ui.toast = "没有可用的文件夹选择器，请稍后再试。";
      this.notify();
      return;
    }
    if (!dir) {
      this.ui.toast = "没有选择文件夹。这个项目仍留在列表里。";
      this.notify();
      return;
    }
    try {
      await this.bridge.command("registry.relocate", { project_id: id, new_path: dir });
      this.ui.toast = "已更新项目位置。";
    } catch (error) {
      // The native shell refuses a mismatched id here, and that refusal is the
      // point: say what it found rather than letting it look like a dead button.
      this.ui.toast = userFacingError(error, "无法重新定位这个项目。登记表没有改变。");
    }
    await this.loadRegistryRows();
  }
  /**
   * §5 — remove the row, nothing else.
   *
   * Deliberately destructive-looking, so the choice is confirmed first; the
   * command it calls only rewrites `.workspace/projects.json`.
   */
  async removeRegistryProject(projectId, projectPath) {
    const id = String(projectId || "").trim();
    if (!id) return;
    const row = (this.ui.registryProjects || []).find((candidate) =>
      candidate.project_id === id &&
      (!projectPath || candidate.project_path === projectPath)
    );
    const label = String(row?.project_title || projectPath || id).trim();
    if (!confirm(`只把「${label}」从启动页列表移除？\n磁盘上的课程文件夹不会被删除或修改。`)) return;
    try {
      await this.bridge.command("registry.remove", {
        project_id: id,
        project_path: String(projectPath || ""),
      });
      this.ui.toast = `已从列表移除「${label}」；课程文件夹没有被改动。`;
    } catch (error) {
      this.ui.toast = userFacingError(error, "无法从列表移除。登记表没有改变。");
    }
    await this.loadRegistryRows();
  }
  /** §4.4 — the user answers the copy question. */
  async resolveRegistryCopy(choice) {
    const copy = this.ui.registryCopy;
    if (!copy) return;
    this.ui.registryCopy = null;
    if (choice === "relocate") {
      try {
        await this.bridge.command("registry.relocate", {
          project_id: copy.project_id,
          new_path: copy.opened_path,
        });
        this.ui.toast = "项目位置已更新为这次打开的文件夹。";
      } catch (error) {
        this.ui.toast = userFacingError(error, "无法更新项目位置。");
      }
      await this.loadRegistryRows();
      return;
    }
    if (choice === "both") {
      try {
        await this.bridge.command("registry.record", {
          project_id: copy.project_id,
          project_path: copy.opened_path,
          project_title: copy.project_title,
          allow_second_copy: true,
        });
        this.ui.toast = "两条位置都保留了，列表里已标注副本。";
      } catch (error) {
        this.ui.toast = userFacingError(error, "无法保留两条记录。");
      }
      await this.loadRegistryRows();
      return;
    }
    this.notify();
  }
  /** Return to the launcher without releasing the active project lease. */
  returnToLauncher() {
    this.releaseAssetViewerSource();
    stopPreviewMedia(globalThis.document);
    this.clearExplorerPreview();
    this.ui.screen = "launcher";
    void this.loadRegistryRows();
    this.ui.palette = this.ui.capture = this.ui.preflight = this.ui.snapshot = false;
    this.ui.assetPicker = null;
    this.ui.assetImagePreviewId = null;
    this.notify();
  }
  enterProject() {
    if (this.bridge.isNative() && !this.bridge.projectDir) {
      void this.openProjectFromPicker();
      return;
    }
    this.ui.screen = "project";
    // Entering the project is the first moment the service can answer AI
    // questions about it; both loaders contain their own failures.
    this.refreshAiSideFiles();
    const items = this.data.content_items.filter((item) => !item.archived);
    if (items.length === 0) {
      this.ui.route = "map";
      this.ui.activeId = null;
      this.scheduleSessionSave();
      this.notify();
      return;
    }
    if (this.ui.activeId && items.some((item) => item.id === this.ui.activeId)) {
      // A restored reader position already carries both the lesson and the view
      // the user was last working in.  Re-opening it through `openItem` would
      // reset `route` to the editor and silently drop that context, so
      // "继续工作" returns to exactly where the session left off.
      this.scheduleSessionSave();
      this.notify();
      return;
    }
    this.openItem(this.resumeLessonId());
  }
  openItem(id) {
    const item = this.data.content_items.find((candidate) => candidate.id === id && !candidate.archived);
    if (!item) return;
    this.ui.screen = "project";
    const lessonChanged = this.ui.activeId !== id;
    this.ui.activeId = id;
    this.normalizeActiveLayoutPage(item);
    this.ui.route = "editor";
    this.ui.focusRequirementId = null;
    this.ui.selectedBlockId = null;
    this.ui.paginationEditing = false;
    this.ui.propertyTarget = null;
    this.ui.gridEditing = false;
    this.ui.assetPicker = null;
    this.ui.editingRequirementId = null;
    this.ui.assetUsageId = null;
    if (lessonChanged) this.aiSyncScope();
    this.openTab(id);
    this.scheduleSessionSave();
    this.notify();
  }
  /**
   * Left-nav「工作台」: return to the current lesson's authoring surface.
   * Defaults to 正文; restores 正文/结构/排版/预览 when a valid session
   * (or in-memory tab) already carries a mode for that lesson.
   */
  openWorkbench() {
    const items = this.data.content_items.filter((item) => !item.archived);
    if (items.length === 0) {
      this.ui.route = "map";
      this.ui.activeId = null;
      this.scheduleSessionSave();
      this.notify();
      return;
    }
    const id = this.ui.activeId && items.some((item) => item.id === this.ui.activeId)
      ? this.ui.activeId
      : this.resumeLessonId();
    if (!id) {
      this.ui.route = "map";
      this.ui.activeId = null;
      this.scheduleSessionSave();
      this.notify();
      return;
    }
    const modes = ["writing", "structure", "preview"];
    const tab = this.tabs.find((candidate) => candidate.content_item_id === id);
    let mode = "writing";
    if (tab && modes.includes(tab.mode)) mode = tab.mode;
    else if (this.ui.activeId === id && modes.includes(this.ui.mode)) mode = this.ui.mode;
    const lessonChanged = this.ui.activeId !== id;
    this.ui.screen = "project";
    this.ui.activeId = id;
    this.ui.route = "editor";
    this.ui.mode = mode;
    this.ui.focusRequirementId = null;
    this.ui.selectedBlockId = null;
    this.ui.propertyTarget = null;
    this.ui.gridEditing = false;
    this.ui.assetPicker = null;
    this.ui.editingRequirementId = null;
    this.ui.assetUsageId = null;
    if (lessonChanged) this.aiSyncScope();
    this.openTab(id, mode);
    this.scheduleSessionSave();
    this.notify();
  }
  focusRequirement(id) {
    const requirement = this.data.requirements.find((candidate) => candidate.id === id);
    if (!requirement) return;
    if (!this.data.content_items.some((item) => item.id === requirement.content_item_id)) return;
    this.ui.screen = "project";
    this.ui.activeId = requirement.content_item_id;
    this.ui.route = requirement.scope === "layout" ? "free-layout" : "editor";
    this.ui.mode = "writing";
    this.ui.rightPanel = "requirements";
    this.ui.focusRequirementId = id;
    this.ui.selectedBlockId = requirement.anchor_block_id;
    this.ui.gridEditing = false;
    this.aiSyncScope();
    this.openTab(requirement.content_item_id, this.ui.mode);
    this.ui.toast = requirement.scope === "layout" ? "已定位到排版中的待补位置" : "已定位到正文中的待补位置";
    this.scheduleSessionSave();
    this.notify();
  }
  setMode(mode, options = {}) {
    if (!["writing", "structure", "layout", "preview"].includes(mode)) return;
    this.ui.paginationEditing = false;
    this.ui.gridEditing = false;
    this.ui.movingPlacementTargetPageId = null;
    // The former Workbench Layout tab now lives at the Free Layout route.
    // Keep accepting its legacy action/session value, but never restore a dead tab.
    if (mode === "layout") {
      this.ui.route = "free-layout";
      this.ui.mode = "writing";
    } else this.ui.mode = mode;
    const tab = this.tabs.find((candidate) => candidate.content_item_id === this.ui.activeId);
    if (tab) tab.mode = mode === "layout" ? "writing" : mode;
    if (!options.silent) {
      this.scheduleSessionSave();
      this.notify();
    }
  }
  setLayoutMode(mode) { this.setLayoutModeOnLayout(mode); }
  setLayoutModeOnLayout(mode) {
    const item = this.currentItem();
    if (!item) return;
    this.ui.route = "free-layout";
    this.ui.paginationEditing = false;
    this.ui.gridEditing = false;
    this.ui.movingPlacementTargetPageId = null;
    this.scheduleSessionSave();
    if (!this.layout(item)) {
      this.createLayout(mode);
      return;
    }
    this.commit(mode === "flow" ? "切换到 Flow" : "切换到 Grid", (data) => {
      const layout = data.layout_instances.find((candidate) => candidate.content_item_id === item.id);
      if (!layout) return;
      layout.mode = mode === "flow" ? "flow" : "grid";
      layout.updated_at = now();
    });
  }
  navigateLesson(direction) {
    const map = this.map();
    const target = direction === "next" ? map.next_id : map.previous_id;
    if (target) this.openItem(target);
    else this.ui.toast = direction === "next" ? "已经是最后一课" : "已经是第一课";
    this.notify();
  }
  addBlock(type = "paragraph", content = "", atIndex = -1) {
    const item = this.currentItem();
    if (!item) return;
    // Authoring invariants: a placeholder without a Requirement would be a
    // block the用户 cannot track, and a media block needs a chosen asset.
    if (type === "placeholder") {
      this.addPlaceholder("text", content);
      return;
    }
    if (type === "media") {
      // Position insert: open the shared picker; choosing an asset calls
      // insertAsset without block_id so it inserts after the selection (or
      // appends), instead of converting a block in place.
      this.ui.assetPicker = {};
      this.notify();
      return;
    }
    // A new block starts EMPTY.  Hint text such as "开始写点什么…" belongs in
    // the control's placeholder attribute, never in canonical content: writing
    // it here would put Chinese hints into the course and into every export.
    const blocks = blocksFor(this.data, item.id);
    const index = atIndex >= 0 ? Math.min(atIndex, blocks.length) : blocks.length;
    // The new block is selected and 属性 opens, but focus stays in the editor:
    // the user keeps typing where they were.  The selection and the panel are
    // part of the same change as the block itself, because `commit` renders
    // once: setting them afterwards leaves the previous panel on screen.
    this.commit(`新增${blockLabel(type)}`, (data) => {
      const document = data.documents.find((candidate) => candidate.content_item_id === item.id) ||
        data.documents.find((candidate) => candidate.id === item.document_id);
      if (!document) return;
      const id = uid();
      data.blocks.push({ id, document_id: document.id, parent_block_id: null, type, order_index: index, content: String(content ?? ""), settings: type === "heading" ? { level: 2 } : {}, created_at: now(), updated_at: now() });
      renumberBlocks(data, document.id);
      this.ui.selectedBlockId = id;
      this.ui.rightPanel = "properties";
    });
  }
  insertBlockBelow(blockId) {
    const item = this.currentItem();
    if (!item) return;
    const blocks = blocksFor(this.data, item.id);
    const index = blocks.findIndex((block) => block.id === blockId);
    this.addBlock("paragraph", "", index >= 0 ? index + 1 : blocks.length);
  }
  addPlaceholder(type = "text", note = "") {
    const item = this.currentItem();
    if (!item) return;
    const anchor = this.selectedBlock();
    const defaults = { text: "补充这段文字", image: "补一张图片", gif: "补一个 GIF", video: "补一段视频" };
    const text = note || defaults[type] || "补充内容";
    // Like `addBlock`, the panel and the selection belong to the same commit:
    // a placeholder is created together with the requirement that tracks it,
    // and the 待补 panel must open showing it.
    this.commit("插入占位符", (data) => {
      const document = data.documents.find((candidate) => candidate.content_item_id === item.id);
      if (!document) return;
      const placeholderId = uid();
      const requirementId = uid();
      const siblings = data.blocks.filter((block) => block.document_id === document.id);
      const anchorIndex = anchor ? siblings.findIndex((block) => block.id === anchor.id) : -1;
      const index = anchorIndex >= 0 ? anchorIndex + 1 : siblings.length;
      data.blocks.push({ id: placeholderId, document_id: document.id, parent_block_id: null, type: "placeholder", order_index: index, content: text, settings: { requirement_type: type, scope: "content", requirement_id: requirementId }, created_at: now(), updated_at: now() });
      renumberBlocks(data, document.id);
      // The placeholder block itself is the canonical anchor: keeping the
      // requirement pointed at some earlier block would leave it stranded as
      // soon as that block is deleted.
      data.requirements.push({ id: requirementId, content_item_id: item.id, anchor_block_id: placeholderId, type, scope: "content", layout_instance_id: null, note: text, status: "open", priority: "normal", resolved_asset_id: null, resolved_block_id: null, created_at: now(), resolved_at: null });
      this.ui.selectedBlockId = null;
      this.ui.rightPanel = "requirements";
      this.ui.editingRequirementId = requirementId;
    });
  }
  deleteBlock(blockId) {
    const item = this.currentItem();
    if (!item) return;
    this.commit("删除正文区块", (data) => {
      const index = data.blocks.findIndex((block) => block.id === blockId);
      if (index < 0) return;
      const [block] = data.blocks.splice(index, 1);
      data.requirements = data.requirements.filter((requirement) => requirement.anchor_block_id !== blockId);
      data.asset_usages = data.asset_usages.filter((usage) => usage.block_id !== blockId);
      data.placements = data.placements.filter((placement) => placement.block_id !== blockId);
      for (const group of data.groups || []) {
        group.block_ids = group.block_ids.filter((candidate) => candidate !== blockId);
      }
      for (const requirement of data.requirements) {
        if (requirement.resolved_block_id === blockId) requirement.resolved_block_id = null;
      }
      renumberBlocks(data, block.document_id);
    });
    this.ui.toast = "已删除这个区块；素材本身仍在媒体库中";
  }
  moveBlock(blockId, direction) {
    const item = this.currentItem();
    if (!item) return;
    const blocks = blocksFor(this.data, item.id);
    const index = blocks.findIndex((block) => block.id === blockId);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || !blocks[target]) return;
    this.commit("调整正文顺序", (data) => {
      const left = data.blocks.find((block) => block.id === blocks[index].id);
      const right = data.blocks.find((block) => block.id === blocks[target].id);
      if (!left || !right) return;
      const order = left.order_index;
      left.order_index = right.order_index;
      right.order_index = order;
    });
  }
  /** Move a block before another block, or append it when targetId is null. */
  /**
   * @param {string} sourceId
   * @param {string | null} targetId
   */
  reorderBlockTo(sourceId, targetId) {
    const item = this.currentItem();
    if (!item || sourceId === targetId) return;
    const blocks = blocksFor(this.data, item.id);
    const from = blocks.findIndex((block) => block.id === sourceId);
    const targetIndex = targetId == null ? blocks.length : blocks.findIndex((block) => block.id === targetId);
    if (from < 0 || targetIndex < 0 || (targetId == null && from === blocks.length - 1)) return;
    if (targetId != null && blocks[from + 1]?.id === targetId) return;
    const ordered = blocks.map((block) => block.id);
    ordered.splice(from, 1);
    const insertionIndex = targetId == null
      ? ordered.length
      : targetIndex - Number(from < targetIndex);
    ordered.splice(insertionIndex, 0, sourceId);
    this.commit("调整正文顺序", (data) => {
      ordered.forEach((blockId, index) => {
        const block = data.blocks.find((candidate) => candidate.id === blockId);
        if (block) {
          block.order_index = index;
          block.updated_at = now();
        }
      });
    });
  }
  setBlockType(blockId, type) {
    if (!["paragraph", "heading", "quote", "callout", "code", "divider", "placeholder"].includes(type)) return;
    this.commit(`改成${blockLabel(type)}`, (data) => {
      const block = data.blocks.find((candidate) => candidate.id === blockId);
      if (!block || block.type === type) return;
      block.type = type;
      if (type === "heading") block.settings.level = block.settings.level || 2;
      if (type === "placeholder" && !block.settings.requirement_id) {
        const requirementId = uid();
        block.settings.requirement_type = "text";
        block.settings.scope = "content";
        block.settings.requirement_id = requirementId;
        const item = this.data.content_items.find((candidate) => candidate.document_id === block.document_id);
        if (item) {
          data.requirements.push({ id: requirementId, content_item_id: item.id, anchor_block_id: block.id, type: "text", scope: "content", layout_instance_id: null, note: textOf(block.content) || "补充内容", status: "open", priority: "normal", resolved_asset_id: null, resolved_block_id: null, created_at: now(), resolved_at: null });
        }
      }
      block.updated_at = now();
    });
  }
  setBlockLevel(blockId, level) {
    this.commit("修改标题级别", (data) => {
      const block = data.blocks.find((candidate) => candidate.id === blockId);
      if (!block) return;
      block.settings.level = Math.max(1, Math.min(6, Number(level) || 2));
      block.updated_at = now();
    });
  }
  /** Replace a single block's text through history, preserving undo. */
  editBlockText(blockId, value) {
    const block = this.data.blocks.find((candidate) => candidate.id === blockId);
    if (!block) return;
    this.recordBlockTextEdit(blockId, textOf(block.content), value);
  }
  /**
   * Record one text edit from an explicit before-value.
   *
   * Live typing writes straight into canonical data on every keystroke so the
   * caret is never destroyed; the history entry is then created from the value
   * typing started from, which keeps undo meaningful.
   */
  recordBlockTextEdit(blockId, before, value, { notify = true, retype = null } = {}) {
    const block = this.data.blocks.find((candidate) => candidate.id === blockId);
    if (!block) return;
    const previous = textOf(before);
    if (previous === value && !retype) {
      if (textOf(block.content) !== value) {
        // The DOM is ahead of canonical data (undo/redo during typing).
        block.content = value;
        this.markPendingEdit();
      }
      return;
    }
    // A compiled heading/quote/code keeps the type change and the marker
    // removal in the same entry, so one Undo returns the block to prose.
    if (previous === value) {
      this.commit(`改成${blockLabel(retype.type)}`, (data) => {
        const target = data.blocks.find((candidate) => candidate.id === blockId);
        if (!target) return;
        target.type = retype.type;
        if (retype.level != null) target.settings.level = retype.level;
        target.content = retype.content;
        target.updated_at = now();
      }, { notify });
      return;
    }
    block.content = previous;
    this.commit(`编辑${blockLabel(block.type)}`, (data) => {
      const target = data.blocks.find((candidate) => candidate.id === blockId);
      if (!target) return;
      target.content = retype ? retype.content : value;
      if (retype) {
        target.type = retype.type;
        if (retype.level != null) target.settings.level = retype.level;
      }
      target.updated_at = now();
      const document = data.documents.find((candidate) => candidate.id === target.document_id);
      if (document) document.updated_at = now();
      const item = data.content_items.find((candidate) => candidate.document_id === target.document_id);
      if (item) item.updated_at = now();
    }, { notify });
  }
  renameLesson(id, title) {
    const next = String(title ?? "").trim();
    if (!next) return;
    this.commit("重命名课程内容", (data) => {
      const item = data.content_items.find((candidate) => candidate.id === id);
      if (!item) return;
      item.title = next;
      item.updated_at = now();
    });
  }
  moveLesson(id, direction) {
    const item = this.data.content_items.find((candidate) => candidate.id === id);
    if (!item) return;
    const siblings = this.data.content_items.filter((candidate) => candidate.stage_id === item.stage_id && !candidate.archived).sort((a, b) => a.order_index - b.order_index);
    const index = siblings.findIndex((candidate) => candidate.id === id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || !siblings[target]) return;
    this.commit("调整课程顺序", (data) => {
      const left = data.content_items.find((candidate) => candidate.id === siblings[index].id);
      const right = data.content_items.find((candidate) => candidate.id === siblings[target].id);
      if (!left || !right) return;
      const order = left.order_index;
      left.order_index = right.order_index;
      right.order_index = order;
    });
  }
  moveLessonToPosition(id, targetStageId, beforeId = null) {
    const item = this.data.content_items.find((candidate) =>
      candidate.id === id && !candidate.archived
    );
    if (!item) return false;
    const sourceStageId = item.stage_id || null;
    const destinationStageId = targetStageId || null;
    if (destinationStageId && !this.data.stages.some((stage) =>
      stage.id === destinationStageId && !stage.archived
    )) return false;

    const orderedForStage = (stageId) => this.data.content_items
      .filter((candidate) =>
        !candidate.archived && candidate.stage_id === stageId &&
        candidate.id !== id
      )
      .sort((left, right) => left.order_index - right.order_index);
    const sourceItems = orderedForStage(sourceStageId);
    const destinationItems = sourceStageId === destinationStageId
      ? sourceItems
      : orderedForStage(destinationStageId);
    const insertionIndex = beforeId
      ? destinationItems.findIndex((candidate) => candidate.id === beforeId)
      : destinationItems.length;
    if (insertionIndex < 0) return false;
    const nextDestination = [...destinationItems];
    nextDestination.splice(insertionIndex, 0, item);
    if (sourceStageId === destinationStageId) {
      const previous = [...sourceItems, item]
        .sort((left, right) => left.order_index - right.order_index)
        .map((candidate) => candidate.id);
      if (previous.every((candidate, index) => candidate === nextDestination[index]?.id)) {
        return false;
      }
    }

    const sourceRemainingIds = sourceItems.map((candidate) => candidate.id);
    const destinationIds = nextDestination.map((candidate) => candidate.id);
    this.commit("移动课程到阶段", (data) => {
      const moving = data.content_items.find((candidate) => candidate.id === id);
      if (!moving) return;
      moving.stage_id = destinationStageId;
      const writeOrder = (ids, stageId) => {
        ids.forEach((contentItemId, index) => {
          const target = data.content_items.find((candidate) =>
            candidate.id === contentItemId
          );
          if (!target) return;
          target.stage_id = stageId;
          target.order_index = index;
          target.updated_at = now();
        });
      };
      if (sourceStageId === destinationStageId) {
        writeOrder(destinationIds, destinationStageId);
      } else {
        writeOrder(sourceRemainingIds, sourceStageId);
        writeOrder(destinationIds, destinationStageId);
      }
      renumberLessonCodes(data, sourceStageId);
      if (sourceStageId !== destinationStageId) {
        renumberLessonCodes(data, destinationStageId);
      }
    });
    return true;
  }
  toggleStageCollapse(stageId) {
    if (!this.data.stages.some((stage) => stage.id === stageId && !stage.archived)) {
      return;
    }
    const collapsed = new Set(this.ui.collapsedStageIds);
    if (collapsed.has(stageId)) collapsed.delete(stageId);
    else collapsed.add(stageId);
    this.ui.collapsedStageIds = [...collapsed];
    this.scheduleSessionSave();
    this.notify();
  }
  locateCurrentLesson() {
    const item = this.currentItem();
    if (!item) return;
    this.ui.route = "map";
    if (item.stage_id) {
      this.ui.collapsedStageIds = this.ui.collapsedStageIds.filter((id) =>
        id !== item.stage_id
      );
    }
    this.scheduleSessionSave();
    this.notify();
    setTimeout(() => {
      root.querySelector(`[data-map-lesson="${item.id}"]`)?.scrollIntoView?.({
        block: "center",
        behavior: "smooth",
      });
    }, 0);
  }
  deleteLesson(id) {
    const item = this.data.content_items.find((candidate) => candidate.id === id);
    if (!item) return;
    const views = lessonView(this.data, id);
    const blockers = [];
    if (views && views.lesson.block_count > 0) blockers.push(`${views.lesson.block_count} 个正文区块`);
    if (views && views.lesson.gaps.total > 0) blockers.push(`${views.lesson.gaps.total} 项待补`);
    if (views && views.lesson.media_count > 0) blockers.push(`${views.lesson.media_count} 个素材引用`);
    if (blockers.length && !this.ui.confirmDeleteLesson) {
      this.ui.confirmDeleteLesson = { id, blockers };
      this.ui.toast = `《${item.title}》里有${blockers.join("、")}，再点一次“确认删除”才会删除`;
      this.notify();
      return;
    }
    this.commit("删除课程内容", (data) => {
      const target = data.content_items.find((candidate) => candidate.id === id);
      if (!target) return;
      const documentIds = new Set(data.documents.filter((document) => document.content_item_id === id).map((document) => document.id));
      const blockIds = new Set(data.blocks.filter((block) => documentIds.has(block.document_id)).map((block) => block.id));
      data.blocks = data.blocks.filter((block) => !documentIds.has(block.document_id));
      data.documents = data.documents.filter((document) => !documentIds.has(document.id));
      data.requirements = data.requirements.filter((requirement) => !blockIds.has(requirement.anchor_block_id || "") && requirement.content_item_id !== id);
      data.asset_usages = data.asset_usages.filter((usage) => usage.content_item_id !== id && !blockIds.has(usage.block_id || ""));
      const layoutIds = new Set(data.layout_instances.filter((layout) => layout.content_item_id === id).map((layout) => layout.id));
      data.placements = data.placements.filter((placement) => !layoutIds.has(placement.layout_instance_id) && !blockIds.has(placement.block_id));
      data.layout_sections = data.layout_sections.filter((section) => !layoutIds.has(section.layout_instance_id));
      data.layout_instances = data.layout_instances.filter((layout) => layout.content_item_id !== id);
      data.groups = (data.groups || []).filter((group) => !documentIds.has(group.document_id));
      data.status_assignments = data.status_assignments.filter((assignment) => assignment.content_item_id !== id);
      data.publications = (data.publications || []).filter((publication) => publication.content_item_id !== id);
      // Inbox rows keep their text but lose a target that no longer exists;
      // leaving the id behind would be a dangling canonical reference.
      for (const inbox of data.inbox_items || []) {
        if (inbox.content_item_id !== id) continue;
        inbox.content_item_id = null;
        if (inbox.status === "triaged") inbox.status = "open";
        inbox.updated_at = now();
      }
      data.content_items = data.content_items.filter((candidate) => candidate.id !== id);
      const remaining = data.content_items.filter((candidate) => candidate.stage_id === target.stage_id && !candidate.archived).sort((a, b) => a.order_index - b.order_index);
      remaining.forEach((candidate, index) => { candidate.order_index = index; });
      // Lesson codes are derived from position, so they are renumbered too.
      renumberLessonCodes(data, target.stage_id);
    });
    this.ui.confirmDeleteLesson = null;
    if (this.ui.activeId === id) {
      this.tabs = this.tabs.filter((tab) => tab.content_item_id !== id);
      this.ui.selectedBlockId = null;
      this.ui.focusRequirementId = null;
      this.ui.activeId = null;
      const next = this.resumeLessonId();
      if (next) this.openItem(next);
      else { this.ui.route = "map"; this.ui.activeId = null; }
    }
    this.ui.toast = `已删除《${item.title}》；素材仍保留在媒体库`;
  }
  addStage(title) {
    let created = null;
    this.commit("新增阶段", (data) => {
      const code = nextStageCode(data);
      const display = String(title ?? "").trim() || defaultStageTitleForCode(code);
      const active = data.stages.filter((candidate) => !candidate.archived);
      const stage = {
        id: uid(),
        project_id: data.project.id,
        parent_stage_id: null,
        code,
        title: display,
        description: "",
        learning_action: "",
        order_index: active.length,
        archived: false,
        created_at: now(),
        updated_at: now(),
      };
      data.stages.push(stage);
      created = stage;
    });
    if (!created) return;
    this.ui.confirmDeleteStage = null;
    this.ui.screen = "project";
    this.ui.route = "map";
    this.ui.toast = `已新增阶段 ${created.code} ${created.title}`;
    this.notify();
  }
  renameStage(id, title) {
    const next = String(title ?? "").trim();
    if (!next) return;
    this.commit("重命名阶段", (data) => {
      const stage = data.stages.find((candidate) => candidate.id === id);
      if (!stage) return;
      stage.title = next;
      stage.updated_at = now();
    });
  }
  moveStage(id, direction) {
    const siblings = this.data.stages.filter((candidate) => !candidate.archived).sort((a, b) => a.order_index - b.order_index);
    const index = siblings.findIndex((candidate) => candidate.id === id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || !siblings[target]) return;
    this.commit("调整阶段顺序", (data) => {
      const left = data.stages.find((candidate) => candidate.id === siblings[index].id);
      const right = data.stages.find((candidate) => candidate.id === siblings[target].id);
      if (!left || !right) return;
      const order = left.order_index;
      left.order_index = right.order_index;
      right.order_index = order;
      left.updated_at = now();
      right.updated_at = now();
    });
  }
  deleteStage(id) {
    const stage = this.data.stages.find((candidate) => candidate.id === id);
    if (!stage) return;
    const lessonCount = this.data.content_items.filter((item) => item.stage_id === id && !item.archived).length;
    if (lessonCount > 0) {
      this.ui.confirmDeleteStage = null;
      this.ui.toast = `这个阶段还有 ${lessonCount} 节课，请先移动课程。`;
      this.notify();
      return;
    }
    if (this.ui.confirmDeleteStage !== id) {
      this.ui.confirmDeleteStage = id;
      this.ui.toast = `再点一次确认删除空阶段「${stage.title}」`;
      this.notify();
      return;
    }
    this.commit("删除阶段", (data) => {
      const still = data.content_items.some((item) => item.stage_id === id && !item.archived);
      if (still) return;
      data.stages = data.stages.filter((candidate) => candidate.id !== id);
      reindexStages(data);
    });
    this.ui.confirmDeleteStage = null;
    if (this.ui.propertyTarget?.kind === "stage" && this.ui.propertyTarget.id === id) {
      this.ui.propertyTarget = null;
    }
    this.ui.toast = `已删除阶段「${stage.title}」`;
    this.ui.route = "map";
    this.notify();
  }
  addMapItem(title = "新建课程内容") {
    const requested = String(title ?? "").trim() || "新建课程内容";
    let createdId = null;
    this.commit("新建课程内容", (data) => {
      let stage = data.stages.filter((candidate) => !candidate.archived).sort((a, b) => a.order_index - b.order_index)[0];
      if (!stage) {
        stage = { id: uid(), project_id: data.project.id, parent_stage_id: null, code: "S01", title: "第一阶段", description: "", learning_action: "", order_index: 0, archived: false, created_at: now(), updated_at: now() };
        data.stages.push(stage);
      }
      const document = { id: uid(), content_item_id: null, schema_version: data.schema_version, created_at: now(), updated_at: now() };
      const siblings = data.content_items.filter((candidate) => candidate.stage_id === stage.id);
      const item = { id: uid(), project_id: data.project.id, stage_id: stage.id, code: nextLessonCode(stage.code, siblings), title: requested, type: "lesson", description: "", order_index: siblings.length, document_id: document.id, archived: false, created_at: now(), updated_at: now() };
      document.content_item_id = item.id;
      data.documents.push(document);
      data.content_items.push(item);
      initializeStatusesFor(data, item.id);
      createdId = item.id;
    });
    if (!createdId) return;
    this.ui.screen = "project";
    this.openItem(createdId);
    this.ui.toast = "已新建一课，可以开始写正文";
  }
  addAsset() {
    this.ui.toast = "请通过“添加素材”导入真实文件；工作台不会创建没有文件的假素材";
    this.notify();
  }
  async insertAsset(assetId, options = {}) {
    const item = this.currentItem();
    const asset = this.data.assets.find((candidate) => candidate.id === assetId);
    if (!item || !asset) {
      this.ui.toast = "请先选择一课";
      this.notify();
      return;
    }
    const requirementId = options.requirement_id ||
      this.ui.assetPicker?.requirementId || null;
    const requirement = requirementId
      ? this.data.requirements.find((candidate) =>
        candidate.id === requirementId &&
        candidate.content_item_id === item.id
      ) ?? null
      : null;
    // Explicit link target (picker-for-block / drop / options.block_id):
    // convert that block in place.  Selection alone is NOT a link target —
    // position insert creates a new media block after the selection (or
    // appends when nothing is selected).
    // A requirement owns its anchor; using the current block selection instead
    // would resolve the wrong place and break canonical consistency.
    // A layout requirement has no anchor block at all: the usage must carry
    // `block_id: null` and only reference the layout instance.
    const linkBlockId = requirement
      ? (requirement.scope === "content" ? requirement.anchor_block_id : null)
      : options.block_id || this.ui.assetPicker?.blockId || null;
    const selected = !requirement && !linkBlockId ? this.selectedBlock() : null;
    const layoutOnly = !requirement && !linkBlockId && options.role === "layout";
    // A usage must mirror the requirement's own scope: a content requirement
    // never carries a layout instance.
    const usageLayoutId = requirement
      ? requirement.layout_instance_id
      : (options.layout_instance_id ||
        (layoutOnly ? this.layout(item)?.id ?? null : null));
    const assetLabel = asset.title || asset.filename;
    const anchorNote = linkBlockId
      ? null
      : selected
      ? "选中区块之后"
      : layoutOnly
      ? null
      : "课末尾";
    this.ui.assetPicker = null;
    let createdBlockId = null;
    this.commit(`插入素材：${assetLabel}`, (data) => {
      const contentItem = data.content_items.find((candidate) => candidate.id === item.id);
      if (!contentItem) return;
      const document = data.documents.find((candidate) => candidate.content_item_id === item.id) || data.documents.find((candidate) => candidate.id === contentItem.document_id);
      const role = requirement ? "requirement" : (options.role || "content");
      if (requirement) {
        const target = data.requirements.find((candidate) => candidate.id === requirement.id);
        if (target) {
          target.status = "resolved";
          target.resolved_asset_id = asset.id;
          target.resolved_block_id = target.anchor_block_id;
          target.resolved_at = now();
          data.asset_usages = data.asset_usages.filter((usage) => !(usage.role === "requirement" && usage.content_item_id === target.content_item_id && usage.block_id === target.anchor_block_id && usage.layout_instance_id === target.layout_instance_id));
        }
      }
      let targetBlockId = linkBlockId;
      if (layoutOnly) {
        targetBlockId = null;
      } else if (!targetBlockId && document && !requirement) {
        const siblings = data.blocks
          .filter((block) => block.document_id === document.id)
          .sort((left, right) =>
            (left.order_index ?? 0) - (right.order_index ?? 0) ||
            String(left.id).localeCompare(String(right.id))
          );
        const anchorIndex = selected
          ? siblings.findIndex((block) => block.id === selected.id)
          : -1;
        const index = anchorIndex >= 0 ? anchorIndex + 1 : siblings.length;
        // Make room so a stable renumber cannot leave the new block after a
        // sibling that previously shared the same order_index.
        for (const sibling of siblings) {
          if ((sibling.order_index ?? 0) >= index) sibling.order_index += 1;
        }
        const id = uid();
        targetBlockId = id;
        createdBlockId = id;
        data.blocks.push(linkBlockAsset({
          id,
          document_id: document.id,
          parent_block_id: null,
          type: "paragraph",
          order_index: index,
          content: "",
          settings: {},
          created_at: now(),
          updated_at: now(),
        }, asset));
        renumberBlocks(data, document.id);
        this.ui.selectedBlockId = id;
      } else if (targetBlockId) {
        const block = data.blocks.find((candidate) => candidate.id === targetBlockId);
        if (block) linkBlockAsset(block, asset);
      }
      const already = data.asset_usages.some((usage) =>
        usage.asset_id === asset.id &&
        usage.content_item_id === item.id &&
        usage.block_id === (targetBlockId ?? null) &&
        usage.layout_instance_id === usageLayoutId &&
        usage.role === role
      );
      if (!already) {
        data.asset_usages.push({ id: uid(), asset_id: asset.id, content_item_id: item.id, block_id: targetBlockId ?? null, layout_instance_id: usageLayoutId, role, created_at: now() });
      }
    });
    if (linkBlockId) this.ui.selectedBlockId = linkBlockId;
    else if (createdBlockId) this.ui.selectedBlockId = createdBlockId;
    this.ui.toast = anchorNote
      ? `已插入素材到${anchorNote}：${assetLabel}`
      : `已插入素材：${assetLabel}`;
  }
  detachAsset(blockId, assetId) {
    const item = this.currentItem();
    if (!item) return;
    this.commit("解除素材引用", (data) => {
      const block = data.blocks.find((candidate) => candidate.id === blockId);
      const document = data.documents.find((candidate) => candidate.id === block?.document_id);
      if (!block || document?.content_item_id !== item.id) return;
      const linked = block.settings.asset_id;
      delete block.settings.asset_id;
      delete block.settings.media_type;
      block.content = "";
      block.updated_at = now();
      const target = assetId || linked;
      if (target) {
        data.asset_usages = data.asset_usages.filter((usage) => !(usage.block_id === blockId && usage.asset_id === target));
      }
      for (const requirement of data.requirements) {
        if (requirement.anchor_block_id !== blockId) continue;
        if (target && requirement.resolved_asset_id !== target) continue;
        // A requirement that loses its material is open again: keeping any
        // resolved_* field would contradict the canonical consistency rules.
        requirement.resolved_asset_id = null;
        requirement.resolved_block_id = null;
        requirement.resolved_at = null;
        requirement.status = "open";
      }
    });
    this.ui.toast = "已解除引用；素材仍在媒体库中";
  }
  deleteAsset(assetId) {
    const asset = this.data.assets.find((candidate) => candidate.id === assetId);
    if (!asset) return;
    const usages = usagesForAsset(this.data, assetId);
    const elsewhere = assetUsedElsewhere(this.data, assetId, this.ui.activeId);
    if (usages.length && this.ui.confirmDeleteAssetId !== assetId) {
      this.ui.confirmDeleteAssetId = assetId;
      this.ui.toast = elsewhere.length
        ? `《${asset.filename}》被 ${usages.length} 处引用（含其他课 ${elsewhere.length} 处），再点一次“确认删除”会解除全部引用`
        : `《${asset.filename}》被本课 ${usages.length} 处引用，再点一次“确认删除”会解除引用`;
      this.notify();
      return;
    }
    this.commit("删除素材", (data) => {
      const target = data.assets.find((candidate) => candidate.id === assetId);
      if (!target) return;
      data.asset_usages = data.asset_usages.filter((usage) => usage.asset_id !== assetId);
      for (const block of data.blocks) {
        if (block.settings.asset_id !== assetId) continue;
        delete block.settings.asset_id;
        delete block.settings.media_type;
        block.content = "";
        block.updated_at = now();
      }
      for (const requirement of data.requirements) {
        if (requirement.resolved_asset_id !== assetId) continue;
        requirement.resolved_asset_id = null;
        requirement.resolved_block_id = null;
        requirement.resolved_at = null;
        requirement.status = "open";
      }
      target.archived = true;
    });
    this.ui.confirmDeleteAssetId = null;
    this.ui.assetUsageId = null;
    this.ui.toast = "已从项目中删除这个素材（磁盘文件保留在 assets/ 目录）";
  }
  /** Start the managed-file rename dialog. Confirming it moves the file. */
  startAssetRename(assetId) {
    const asset = this.data.assets.find((candidate) => candidate.id === assetId && !candidate.archived);
    if (!asset) return;
    this.ui.editingAssetId = assetId;
    this.ui.assetRenameValue = asset.filename;
    this.ui.assetRenameError = "";
    this.ui.focusField = "asset-title";
    this.ui.route = "media";
    this.notify();
  }
  cancelAssetRename() {
    if (!this.ui.editingAssetId) return;
    this.ui.editingAssetId = null;
    this.ui.assetRenameValue = "";
    this.ui.assetRenameError = "";
    this.notify();
  }
  /**
   * §14.1 — renaming a library asset renames the managed file on disk.
   *
   * The command owns the whole transaction (preflight → filesystem rename →
   * canonical rewrite → save, with rollback), so the shell never edits the
   * project first: it asks, then replaces its copy from the project the shell
   * answered with.  A rejected name leaves the file, the project and this
   * history untouched.  Asset id, checksum and AssetUsage ids stay stable
   * because only the command rewrites the paths that point at them.
   * @param {string} assetId
   * @param {string} requested
   */
  async renameAsset(assetId, requested) {
    // Enter commits and then the input loses focus, so blur arrives with the same
    // value a second time.  Without this guard that follow-up asks the shell to
    // rename again; the backend re-appends the extension, the name comes back
    // unchanged, and the real success toast is replaced by 「素材名称没有变化」
    // plus a no-op undo step.
    if (this.ui.editingAssetId !== assetId) return;
    const next = String(requested ?? "").trim();
    this.ui.assetRenameValue = String(requested ?? "");
    this.ui.assetRenameError = "";
    const previous = this.data.assets.find((candidate) => candidate.id === assetId);
    if (!previous) {
      this.cancelAssetRename();
      return;
    }
    if (!next) {
      // §14.3 lists an empty name as a rejection, and a rejection has to be said:
      // closing the field back to the old name alone leaves the user guessing
      // whether the rename worked.  A plain blur is not affected — the field is
      // prefilled with the current name, so that path lands on the branch below.
      this.ui.assetRenameError = "素材名称不能为空。";
      this.ui.toast = "素材名称不能为空，文件名称没有改变。";
      this.notify();
      return;
    }
    if (next === previous.filename) {
      this.cancelAssetRename();
      return;
    }
    const before = clone(this.data);
    const selection = this.ui.selectedBlockId;
    // The shell renames from the file on disk, so any pending edit has to be
    // saved first or the rename would answer with a project that lost it.
    if (!await this.flush()) {
      if (this.saveStatus === "保存结果待核验") {
        this.ui.assetRenameError = "上一项文件操作结果暂时无法确认，请重新读取项目状态后再继续。";
      } else {
        this.ui.assetRenameError = "素材重命名前没有保存成功，文件名称没有改变。请先重试保存。";
        this.ui.toast = this.ui.assetRenameError;
      }
      this.notify();
      return;
    }
    try {
      const mutation = await this.runCanonicalMutation("asset.rename", {
        asset_id: assetId,
        new_name: next,
      });
      const renamed = this.data.assets.find((candidate) => candidate.id === assetId);
      const newFilename = String(renamed?.filename || next);
      // §14.5: restoring the snapshot alone would leave the canonical project
      // naming a file that no longer exists, so the step carries both names.
      this.history.push({
        label: `重命名素材文件「${previous.filename}」`,
        before,
        after: clone(this.data),
        selection,
        physical_rename: {
          asset_id: assetId,
          previous_name: previous.filename,
          next_name: newFilename,
        },
      });
      if (this.history.length > 50) this.history.shift();
      this.future = [];
      const success = newFilename === previous.filename
        ? "素材名称没有变化"
        : `已重命名文件：${newFilename}`;
      this.ui.toast = mutation.warnings.length
        ? `${success}；${mutation.warnings.join("；")}`
        : success;
      this.ui.editingAssetId = null;
      this.ui.assetRenameValue = "";
      this.ui.assetRenameError = "";
    } catch (error) {
      const message = String(error?.message || error || "");
      const uncertain = (error?.commit_state ?? error?.details?.commit_state) === "outcome_uncertain";
      this.ui.assetRenameError = uncertain
        ? "重命名结果暂时无法确认，请重新读取项目状态后再继续。"
        : userFacingError(error, "文件名称没有改变。");
      if (!uncertain) this.ui.toast = `素材重命名没有完成：${this.ui.assetRenameError}`;
      if (message.includes("rename_rollback_failed")) {
        // §14.4: disk and project now disagree, so this stays visible instead of
        // flashing by in a toast — and success is never claimed.
        this.recoveryWarning = message;
      }
    }
    this.notify();
  }
  resolveRequirement(id, assetId = null) {
    const requirement = this.data.requirements.find((candidate) => candidate.id === id);
    if (!requirement) return;
    const asset = assetId ? this.data.assets.find((candidate) => candidate.id === assetId) : null;
    const block = requirement.anchor_block_id ? this.data.blocks.find((candidate) => candidate.id === requirement.anchor_block_id) : null;
    this.ui.editingRequirementId = null;
    this.commit("完成待补内容", (data) => {
      const target = data.requirements.find((candidate) => candidate.id === id);
      if (!target) return;
      data.asset_usages = data.asset_usages.filter((usage) => !(usage.role === "requirement" && usage.content_item_id === target.content_item_id && usage.block_id === target.anchor_block_id && usage.layout_instance_id === target.layout_instance_id));
      target.status = "resolved";
      target.resolved_asset_id = asset ? asset.id : null;
      target.resolved_block_id = target.anchor_block_id;
      target.resolved_at = now();
      if (asset) {
        data.asset_usages.push({ id: uid(), asset_id: asset.id, content_item_id: target.content_item_id, block_id: target.anchor_block_id, layout_instance_id: target.layout_instance_id, role: "requirement", created_at: now() });
        const anchor = data.blocks.find((candidate) => candidate.id === target.anchor_block_id);
        if (anchor) {
          // The placeholder becomes the media slot it was standing in for, so
          // preview and export resolve the asset through the block itself.
          linkBlockAsset(anchor, asset);
          anchor.settings.requirement_id = target.id;
        }
      } else if (block && block.type === "placeholder") {
        block.type = "paragraph";
        block.updated_at = now();
      }
    });
    this.ui.toast = asset ? "已用素材完成这项待补" : "已标记完成";
  }
  setRequirementStatus(id, status) {
    const allowed = ["open", "resolved", "ignored"];
    if (!allowed.includes(status)) return;
    this.commit(status === "resolved" ? "完成待补内容" : "重新打开待补内容", (data) => {
      const requirement = data.requirements.find((candidate) => candidate.id === id);
      if (!requirement) return;
      if (status !== "resolved") {
        data.asset_usages = data.asset_usages.filter((usage) => !(usage.role === "requirement" && usage.content_item_id === requirement.content_item_id && usage.block_id === requirement.anchor_block_id && usage.layout_instance_id === requirement.layout_instance_id));
        requirement.resolved_at = null;
        requirement.resolved_asset_id = null;
        requirement.resolved_block_id = null;
        // Reopening means the material is no longer accepted, so the anchor
        // goes back to being an empty placeholder instead of a stale link.
        const anchor = data.blocks.find((candidate) => candidate.id === requirement.anchor_block_id);
        if (anchor && anchor.type !== "placeholder") {
          delete anchor.settings.asset_id;
          delete anchor.settings.media_type;
          anchor.content = "";
          anchor.updated_at = now();
        }
      } else {
        requirement.resolved_at ??= now();
      }
      requirement.status = status;
    });
    this.ui.editingRequirementId = null;
  }
  updateRequirement(id, patch = {}) {
    this.commit("修改待补内容", (data) => {
      const requirement = data.requirements.find((candidate) => candidate.id === id);
      if (!requirement) return;
      if (typeof patch.note === "string") requirement.note = patch.note;
      if (["low", "normal", "high"].includes(patch.priority)) requirement.priority = patch.priority;
      if (REQUIREMENT_TYPES.includes(patch.type)) requirement.type = patch.type;
      if (["open", "resolved", "ignored"].includes(patch.status)) requirement.status = patch.status;
      const anchor = data.blocks.find((candidate) => candidate.id === requirement.anchor_block_id);
      if (anchor && anchor.type === "placeholder") {
        // The placeholder mirrors its requirement; a type-only change must be
        // reflected too, not just a note change.
        if (typeof patch.note === "string") anchor.content = patch.note;
        anchor.settings = { ...(anchor.settings || {}), requirement_type: requirement.type, scope: requirement.scope };
        anchor.updated_at = now();
      }
    });
    this.ui.editingRequirementId = null;
  }
  deleteRequirement(id) {
    this.commit("删除待补内容", (data) => {
      const requirement = data.requirements.find((candidate) => candidate.id === id);
      if (!requirement) return;
      data.requirements = data.requirements.filter((candidate) => candidate.id !== id);
      data.asset_usages = data.asset_usages.filter((usage) => !(usage.role === "requirement" && usage.content_item_id === requirement.content_item_id && usage.block_id === requirement.anchor_block_id && usage.layout_instance_id === requirement.layout_instance_id));
      if (requirement.anchor_block_id) {
        const anchor = data.blocks.find((candidate) => candidate.id === requirement.anchor_block_id);
        if (anchor && anchor.type === "placeholder") {
          const documentId = anchor.document_id;
          data.blocks = data.blocks.filter((candidate) => candidate.id !== requirement.anchor_block_id);
          data.placements = data.placements.filter((placement) => placement.block_id !== requirement.anchor_block_id);
          renumberBlocks(data, documentId);
        } else if (anchor) {
          delete anchor.settings.requirement_id;
        }
      }
    });
    this.ui.editingRequirementId = null;
    this.ui.toast = "已删除这项待补";
  }
  updateStatus(dimension, value) {
    const item = this.currentItem();
    if (!item) return;
    const dimensionRecord = (this.data.status_dimensions || []).find((candidate) => candidate.key === dimension);
    if (!dimensionRecord) return;
    const option = (this.data.status_options || []).find((candidate) => candidate.dimension_id === dimensionRecord.id && candidate.name === value);
    if (!option) {
      this.ui.toast = `状态「${value}」不在项目状态表中，未写入`;
      this.notify();
      return;
    }
    this.commit("更新状态", (data) => {
      const existing = data.status_assignments.find((candidate) => candidate.content_item_id === item.id && candidate.dimension_id === dimensionRecord.id);
      if (existing) {
        existing.option_id = option.id;
        existing.updated_at = now();
        delete existing.dimension_key;
        delete existing.option;
        return;
      }
      data.status_assignments.push({ id: uid(), content_item_id: item.id, dimension_id: dimensionRecord.id, option_id: option.id, updated_at: now() });
    });
  }
  setBoardDimension(dimension) { if (!STATUS[dimension]) return; this.ui.boardDimension = dimension; this.notify(); }
  moveBoardCard(id, option) {
    const dimension = this.ui.boardDimension;
    if (!dimension) return;
    // The card may belong to another lesson, so target that lesson explicitly
    // instead of assuming the current one.
    this.ui.statusTargetId = id;
    if (id !== this.ui.activeId) this.ui.activeId = id;
    this.updateStatus(dimension, option);
    this.scheduleSessionSave();
  }
  captureToInbox(text, title = "快速收集") {
    const body = String(text ?? "").trim();
    if (!body) return;
    this.commit("加入收件箱", (data) => {
      data.inbox_items.unshift({ id: uid(), project_id: data.project.id, source_type: /^https?:/i.test(body) ? "web" : "manual", title: String(title || body).slice(0, 60), body, asset_id: null, content_item_id: null, status: "open", created_at: now(), updated_at: now() });
    });
    this.ui.toast = "已放入收件箱";
  }
  triageInbox(id, target = this.ui.activeId) {
    if (!target) {
      this.ui.toast = "请先选择要分配到的课程内容";
      this.notify();
      return;
    }
    this.commit("分配收件箱条目", (data) => {
      const item = data.inbox_items.find((candidate) => candidate.id === id);
      const contentItem = data.content_items.find((candidate) => candidate.id === target);
      if (!item || !contentItem) return;
      item.content_item_id = target;
      item.status = "triaged";
      item.updated_at = now();
      const document = data.documents.find((candidate) => candidate.content_item_id === target);
      if (document) {
        const siblings = data.blocks.filter((block) => block.document_id === document.id);
        data.blocks.push({ id: uid(), document_id: document.id, parent_block_id: null, type: "paragraph", order_index: siblings.length, content: item.body, settings: { from_inbox_item_id: item.id }, created_at: now(), updated_at: now() });
      }
    });
  }
  async assetizeInbox(id) {
    const item = this.data.inbox_items.find((candidate) => candidate.id === id);
    if (!item) return;
    let binary = "";
    for (const byte of new TextEncoder().encode(item.body || "")) binary += String.fromCharCode(byte);
    try {
      const result = await this.runCanonicalMutation("asset.import", {
        filename: `${item.title || "收件箱内容"}.txt`,
        type: "document",
        mime_type: "text/plain",
        bytes_base64: btoa(binary),
        source_type: item.source_type === "web" ? "external" : "original",
        source_url: /^https?:/i.test(item.body || "") ? item.body.trim() : null,
      });
      await this.mergeImportedResult(result);
      this.commit("收件箱保存为素材", (data) => {
        const local = data.inbox_items.find((candidate) => candidate.id === id);
        const asset = this.importedAssets(result)[0];
        if (!local) return;
        local.asset_id = asset ? asset.id : local.asset_id;
        local.updated_at = now();
      });
      this.ui.toast = result.warnings.length
        ? `已从收件箱保存为素材；${result.warnings.join("；")}`
        : "已从收件箱保存为素材";
    } catch (error) {
      this.ui.toast = userFacingError(error, "保存为素材没有完成。课程内容没有改变，请重试。");
    }
    this.notify();
  }
  ignoreInbox(id) {
    this.commit("忽略收件箱条目", (data) => {
      const item = data.inbox_items.find((candidate) => candidate.id === id);
      if (item) item.status = "archived";
    });
  }
  /* ------------------------------------------------------- inline names */

  editProjectTitle(surface = "topbar") {
    this.ui.editingProjectTitle = true;
    this.ui.editingProjectTitleSurface = surface === "map" ? "map" : "topbar";
    this.ui.focusField = "project-title";
    this.notify();
  }
  cancelProjectTitle() {
    if (!this.ui.editingProjectTitle) return;
    this.ui.editingProjectTitle = false;
    this.ui.editingProjectTitleSurface = "topbar";
    this.notify();
  }
  commitProjectTitle(value) {
    if (!this.ui.editingProjectTitle) return;
    this.ui.editingProjectTitle = false;
    this.ui.editingProjectTitleSurface = "topbar";
    const title = String(value ?? "").trim();
    const current = String(this.data.project.title || "");
    if (!title || title === current) {
      this.notify();
      return;
    }
    this.commit("修改课程标题", (data) => {
      data.project.title = title;
      data.project.updated_at = now();
    });
    this.ui.toast = `课程标题已改为「${title}」`;
    this.notify();
  }
  startStageTitleEdit(id) {
    if (!this.data.stages.some((stage) => stage.id === id && !stage.archived)) return;
    this.ui.editingStageTitleId = id;
    this.ui.focusField = "stage-title";
    this.notify();
  }
  cancelStageTitleEdit() {
    if (!this.ui.editingStageTitleId) return;
    this.ui.editingStageTitleId = null;
    this.notify();
  }
  commitStageTitleEdit(id, value) {
    if (this.ui.editingStageTitleId !== id) return;
    this.ui.editingStageTitleId = null;
    const title = String(value ?? "").trim();
    const current = this.data.stages.find((stage) => stage.id === id)?.title || "";
    if (!title || title === current) {
      this.notify();
      return;
    }
    this.renameStage(id, title);
  }
  startLessonTitleEdit(id, surface = "map") {
    if (!this.data.content_items.some((item) => item.id === id && !item.archived)) return;
    this.ui.editingLessonTitleId = id;
    this.ui.editingLessonTitleSurface = surface === "workbench" ? "workbench" : "map";
    this.ui.focusField = "lesson-title-inline";
    this.notify();
  }
  cancelLessonTitleEdit() {
    if (!this.ui.editingLessonTitleId) return;
    this.ui.editingLessonTitleId = null;
    this.ui.editingLessonTitleSurface = "map";
    this.notify();
  }
  commitLessonTitleEdit(id, value) {
    if (this.ui.editingLessonTitleId !== id) return;
    this.ui.editingLessonTitleId = null;
    this.ui.editingLessonTitleSurface = "map";
    const title = String(value ?? "").trim();
    const current = this.data.content_items.find((item) => item.id === id)?.title || "";
    if (!title || title === current) {
      this.notify();
      return;
    }
    this.renameLesson(id, title);
  }
  addSection() {
    const layout = this.layout();
    if (!layout) return;
    this.commit("新增排版分区", (data) => {
      const sections = data.layout_sections.filter((section) => section.layout_instance_id === layout.id);
      data.layout_sections.push({ id: uid(), layout_instance_id: layout.id, name: `分区 ${sections.length + 1}`, page_index: sections.length, order_index: sections.length, grid_definition: layout.grid_definition, settings: {}, created_at: now(), updated_at: now() });
    });
    this.ui.editingSectionId = this.data.layout_sections.at(-1)?.id || null;
  }
  /** Inline rename (no `window.prompt`: a webview does not always have one). */
  startSectionRename(sectionId) {
    if (!this.data.layout_sections.some((section) => section.id === sectionId)) return;
    this.ui.editingSectionId = sectionId;
    this.ui.focusField = "section-name";
    this.notify();
  }
  cancelSectionRename() {
    if (!this.ui.editingSectionId) return;
    this.ui.editingSectionId = null;
    this.notify();
  }
  renameSection(sectionId, name) {
    const next = String(name ?? "").trim();
    this.ui.editingSectionId = null;
    if (!next) {
      this.notify();
      return;
    }
    this.commit("重命名排版分区", (data) => {
      const section = data.layout_sections.find((candidate) => candidate.id === sectionId);
      if (!section) return;
      section.name = next;
      section.updated_at = now();
    });
  }
  /**
   * Remove one output section.
   *
   * A section groups placements for multi-page output, so deleting it must not
   * delete content: the placements go back to "未分区" and the remaining
   * sections are renumbered.  Leaving `section_id` dangling would fail
   * canonical validation (and the app invariant that reports it).
   */
  deleteSection(sectionId) {
    const section = this.data.layout_sections.find((candidate) => candidate.id === sectionId);
    if (!section) return;
    this.commit("删除排版分区", (data) => {
      data.placements = data.placements.map((placement) =>
        placement.section_id === sectionId ? { ...placement, section_id: null, updated_at: now() } : placement
      );
      data.layout_sections = data.layout_sections.filter((candidate) => candidate.id !== sectionId);
      const rest = data.layout_sections
        .filter((candidate) => candidate.layout_instance_id === section.layout_instance_id)
        .sort((a, b) => a.order_index - b.order_index);
      rest.forEach((candidate, index) => {
        candidate.order_index = index;
        candidate.page_index = index;
      });
    });
    this.ui.editingSectionId = null;
  }
  createLayout(mode = "grid") {
    const item = this.currentItem();
    if (!item) return;
    this.commit("创建排版版本", (data) => {
      const existing = data.layout_instances.find((candidate) => candidate.content_item_id === item.id);
      if (existing) {
        existing.mode = mode === "flow" ? "flow" : "grid";
        return;
      }
      const layout = { id: uid(), content_item_id: item.id, template_id: null, schema_version: data.schema_version, name: mode === "flow" ? "流式排版" : "默认网格", mode: mode === "flow" ? "flow" : "grid", grid_definition: { columns: [1, 1, 1], rows: [1, 1, 1] }, settings: {}, created_at: now(), updated_at: now() };
      data.layout_instances.push(layout);
      data.layout_sections.push({ id: uid(), layout_instance_id: layout.id, name: "第 1 段", page_index: 0, order_index: 0, grid_definition: layout.grid_definition, settings: {}, created_at: now(), updated_at: now() });
    });
  }
  renameLayout(name) {
    const next = String(name ?? "").trim();
    const layout = this.layout();
    if (!layout || !next) return;
    this.commit("重命名排版版本", (data) => {
      const target = data.layout_instances.find((candidate) => candidate.id === layout.id);
      if (!target) return;
      target.name = next;
      target.updated_at = now();
    });
  }
  beginPaginationConversion() {
    const layout = this.layout();
    if (!layout || layout.mode !== "grid") return;
    const preview = clone(this.data);
    convertSectionsToPagesData(preview, layout.id);
    const legacySize = preview.layout_instances.find((candidate) => candidate.id === layout.id)?.page_size;
    this.ui.paginationConversionPreview = true;
    this.ui.pageSizePreview = { preset: "legacy", size: legacySize, conversion: true };
    this.notify();
  }
  cancelPaginationConversion() {
    this.ui.paginationConversionPreview = false;
    this.ui.pageSizePreview = null;
    this.notify();
  }
  setPageSizePreview(preset) {
    if (!["legacy", "16:9", "a4-portrait", "a4-landscape"].includes(preset)) return;
    const current = this.ui.pageSizePreview;
    const size = preset === "legacy"
      ? current?.conversion
        ? (() => {
          const preview = clone(this.data);
          convertSectionsToPagesData(preview, this.layout().id);
          return preview.layout_instances.find((candidate) => candidate.id === this.layout().id)?.page_size;
        })()
        : this.layout()?.page_size || resolvePageSize(this.layout())
      : PAGE_SIZE_PRESETS[preset];
    this.ui.pageSizePreview = { preset, size, conversion: Boolean(current?.conversion) };
    this.notify();
  }
  confirmPaginationConversion() {
    const layout = this.layout();
    if (!layout || layout.mode !== "grid") return;
    const preview = this.ui.pageSizePreview;
    const size = preview?.size || PAGE_SIZE_PRESETS["16:9"];
    let firstPage = null;
    this.commit("把输出分区转换为页面", (data) => {
      convertSectionsToPagesData(data, layout.id, { page_size: size });
      const currentLayout = data.layout_instances.find((candidate) => candidate.id === layout.id);
      if (currentLayout) {
        currentLayout.pagination_mode = "paged";
        currentLayout.page_size = size;
        currentLayout.updated_at = now();
      }
      firstPage = getLayoutPages(data, layout.id)[0] || null;
    });
    this.ui.layoutPageId = firstPage?.id ?? null;
    this.ui.paginationConversionPreview = false;
    this.ui.pageSizePreview = null;
    // Converting must land the user in the editing state the new controls need;
    // landing back in the read-only canvas would make 启用分页 look inert.
    this.ui.paginationEditing = true;
    this.ui.gridEditing = false;
    this.scheduleSessionSave();
    this.notify();
  }
  togglePaginationEditing() {
    if (this.layout()?.pagination_mode !== "paged") return;
    this.ui.paginationEditing = !this.ui.paginationEditing;
    this.ui.gridEditing = false;
    this.ui.movingPlacementTargetPageId = null;
    this.ui.movingPlacementId = null;
    this.notify();
  }
  addLayoutPage() {
    const layout = this.layout();
    if (!layout || layout.pagination_mode !== "paged") return;
    let created = null;
    this.commit("新增页面", (data) => {
      created = addLayoutPageData(data, layout.id, {
        after_page_id: this.ui.layoutPageId,
      });
    });
    if (created) this.ui.layoutPageId = created.id;
    this.normalizeActiveLayoutPage();
    this.scheduleSessionSave();
    this.notify();
  }
  renamePage(pageId, title) {
    const next = String(title ?? "").trim();
    if (!next || !this.layoutPages().some((page) => page.id === pageId)) return;
    this.commit("重命名页面", (data) => renameLayoutPageData(data, pageId, next));
  }
  movePage(pageId, direction) {
    const pages = this.layoutPages();
    const index = pages.findIndex((page) => page.id === pageId);
    const nextIndex = index + (direction === "up" ? -1 : 1);
    if (index < 0 || nextIndex < 0 || nextIndex >= pages.length) return;
    this.commit("调整页面顺序", (data) => reorderLayoutPageData(data, pageId, nextIndex));
  }
  duplicatePage(pageId) {
    if (!this.layoutPages().some((page) => page.id === pageId)) return;
    let copied = null;
    this.commit("复制页面", (data) => {
      copied = duplicateLayoutPageData(data, pageId);
    });
    if (copied) this.ui.layoutPageId = copied.id;
    this.normalizeActiveLayoutPage();
    this.scheduleSessionSave();
    this.notify();
  }
  deletePage(pageId) {
    const pages = this.layoutPages();
    if (pages.length <= 1) {
      this.say("分页画布至少保留一页；可以移出内容或切回 Flow。", { ttl: 4500 });
      return false;
    }
    const page = pages.find((candidate) => candidate.id === pageId);
    if (!page) return false;
    const deletedIndex = pages.findIndex((candidate) => candidate.id === pageId);
    const neighbor = pages[deletedIndex + (deletedIndex === pages.length - 1 ? -1 : 1)];
    pendingLayoutPageFocus = neighbor?.id || null;
    if (this.ui.layoutPageId === pageId) this.ui.layoutPageId = neighbor?.id || null;
    const count = (this.data.placements || []).filter((placement) => placement.page_id === pageId).length;
    let result = null;
    this.commit("删除页面排版", (data) => {
      result = deleteLayoutPageData(data, pageId);
    });
    this.normalizeActiveLayoutPage();
    this.scheduleSessionSave();
    const unplaced = Array.isArray(result?.unplaced_block_ids) ? result.unplaced_block_ids.length : count;
    this.say(`已删除页面排版；${unplaced} 块正文仍保留在课程中。`);
    return true;
  }
  changePageSize(preset) {
    const layout = this.layout();
    if (!layout || layout.pagination_mode !== "paged") return;
    const size = preset === "legacy"
      ? layout.page_size || resolvePageSize(layout)
      : PAGE_SIZE_PRESETS[preset];
    if (!size) return;
    this.ui.pageSizePreview = { preset, size, conversion: false };
    this.notify();
  }
  confirmPageSizeChange() {
    const layout = this.layout();
    const pending = this.ui.pageSizePreview;
    if (!layout || !pending || typeof pending !== "object") return;
    this.commit("更改页面尺寸", (data) => {
      setLayoutPageSizeData(data, layout.id, pending.size);
    });
    this.ui.pageSizePreview = null;
    this.scheduleSessionSave();
    this.notify();
  }
  cancelPageSizeChange() {
    this.ui.pageSizePreview = null;
    this.notify();
  }
  startPageMove(placementId) {
    const page = (this.data.placements || []).find((placement) => placement.id === placementId);
    if (!page || !this.layoutPages().some((candidate) => candidate.id === page.page_id)) return;
    this.ui.movingPlacementTargetPageId = { placementId, targetPageId: null };
    this.notify();
  }
  choosePageMoveTarget(targetPageId) {
    const pending = this.ui.movingPlacementTargetPageId;
    if (!pending || !this.layoutPages().some((page) => page.id === targetPageId)) return;
    this.ui.movingPlacementTargetPageId = { ...pending, targetPageId };
    this.notify();
  }
  cancelPageMove() {
    this.ui.movingPlacementTargetPageId = null;
    this.notify();
  }
  movePlacementAcrossPage(placementId, targetPageId, row, column) {
    const layout = this.layout();
    const placement = (this.data.placements || []).find((candidate) => candidate.id === placementId);
    const page = this.layoutPages().find((candidate) => candidate.id === targetPageId);
    if (!layout || !placement || !page || layout.pagination_mode !== "paged") return false;
    const bounds = {
      row_start: row,
      row_end: row + (placement.row_end - placement.row_start),
      column_start: column,
      column_end: column + (placement.column_end - placement.column_start),
    };
    try {
      movePlacementToPageData(clone(this.data), placementId, targetPageId, bounds);
    } catch (error) {
      this.say(error instanceof Error ? error.message : "目标页没有可用位置；原放置保持不变。");
      return false;
    }
    this.commit("跨页移动排版内容", (data) => {
      movePlacementToPageData(data, placementId, targetPageId, bounds);
    });
    this.ui.layoutPageId = targetPageId;
    this.ui.movingPlacementTargetPageId = null;
    this.scheduleSessionSave();
    this.notify();
    return true;
  }
  selectPublishPageMode(mode) {
    if (!["all", "current", "selected"].includes(mode)) return;
    this.ui.publishPageMode = mode;
    if (mode === "selected" && !this.ui.publishSelectedPageIds.length && this.ui.layoutPageId) {
      this.ui.publishSelectedPageIds = [this.ui.layoutPageId];
    }
    this.ui.preflightReport = null;
    this.notify();
  }
  togglePublishPage(pageId) {
    if (!this.layoutPages().some((page) => page.id === pageId)) return;
    const selected = new Set(this.ui.publishSelectedPageIds);
    if (selected.has(pageId)) selected.delete(pageId);
    else selected.add(pageId);
    this.ui.publishSelectedPageIds = [...selected];
    this.ui.preflightReport = null;
    this.notify();
  }
  acknowledgeExportWarning(code, checked) {
    const key = String(code || "").trim();
    if (!key) return;
    const values = new Set(this.ui.acknowledgedWarnings || []);
    if (checked) values.add(key);
    else values.delete(key);
    this.ui.acknowledgedWarnings = [...values];
    this.notify();
  }
  setPublishTargetPageSize(preset) {
    if (preset === "original") this.ui.publishTargetPageSize = null;
    else if (preset === "custom") {
      this.ui.publishTargetPageSize = this.ui.publishTargetPageSize?.preset === "custom"
        ? this.ui.publishTargetPageSize
        : { preset: "custom", width_pt: 960, height_pt: 540 };
    }
    else if (Object.prototype.hasOwnProperty.call(PAGE_SIZE_PRESETS, preset)) {
      this.ui.publishTargetPageSize = clone(PAGE_SIZE_PRESETS[preset]);
    } else return;
    this.ui.preflightReport = null;
    this.notify();
  }
  setPublishTargetPageSizeValue(axis, value) {
    if (axis !== "width_pt" && axis !== "height_pt") return;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 1 || number > 100000) return;
    const current = this.ui.publishTargetPageSize?.preset === "custom"
      ? this.ui.publishTargetPageSize
      : { preset: "custom", width_pt: 960, height_pt: 540 };
    this.ui.publishTargetPageSize = { ...current, [axis]: number };
    this.ui.preflightReport = null;
    this.notify();
  }
  publicationOptions() {
    const courseScope = this.ui.publishScope === "course";
    const item = this.currentItem();
    const layout = !courseScope && item ? this.layout(item) : null;
    const adapters = getAvailablePublicationAdapters({
      native: this.bridge.isNative(),
      service: !this.bridge.isNative(),
    });
    const adapter = adapters[this.ui.publishFormat];
    const baseProjection = item && !courseScope
      ? buildPublicationProjection(this.data, {
        content_item_id: item.id,
        layout_instance_id: layout?.id ?? null,
      })
      : buildPublicationProjection(this.data, { content_item_id: null });
    const canSelectPages = layout?.pagination_mode === "paged" && adapter?.layout === true &&
      getPublicationCapabilities(
        baseProjection,
        this.ui.publishFormat,
        adapters,
      ).status === "available";
    let pageIds = null;
    if (canSelectPages && this.ui.publishPageMode === "current") {
      pageIds = this.ui.layoutPageId ? [this.ui.layoutPageId] : [];
    } else if (canSelectPages && this.ui.publishPageMode === "selected") {
      const selected = new Set(this.ui.publishSelectedPageIds);
      pageIds = this.layoutPages(item).filter((page) => selected.has(page.id))
        .map((page) => page.id);
    }
    return {
      content_item_id: courseScope ? null : item?.id ?? null,
      layout_instance_id: layout?.id ?? null,
      page_ids: pageIds,
      target_page_size: adapter?.layout === true && this.ui.publishTargetPageSize
        ? clone(this.ui.publishTargetPageSize)
        : null,
    };
  }
  publicationProjection() {
    return buildPublicationProjection(this.data, this.publicationOptions());
  }
  publicationCapability(format = this.ui.publishFormat, projection = null) {
    const adapters = getAvailablePublicationAdapters({
      native: this.bridge.isNative(),
      service: !this.bridge.isNative(),
    });
    const adapter = adapters[format];
    const current = projection || buildPublicationProjection(this.data, {
      ...this.publicationOptions(),
      page_ids: null,
      target_page_size: adapter?.layout && this.ui.publishTargetPageSize
        ? clone(this.ui.publishTargetPageSize)
        : null,
    });
    if (Object.prototype.hasOwnProperty.call(adapters, format)) {
      return getPublicationCapabilities(current, format, adapters);
    }
    return { status: "available", code: null };
  }
  changeGrid(kind, amount = 1) {
    const layout = this.layout();
    if (!layout) return;
    const pageId = layout.pagination_mode === "paged" ? this.ui.layoutPageId : null;
    const key = kind === "row" ? "rows" : "columns";
    const remove = amount < 0;
    this.commit(remove ? "减少网格轨道" : "增加网格轨道", (data) => {
      const target = data.layout_instances.find((candidate) => candidate.id === layout.id);
      if (!target) return;
      const page = pageId ? data.layout_pages.find((candidate) => candidate.id === pageId) : null;
      const grid = page ? page.grid_definition : target.grid_definition;
      if (!grid) return;
      const tracks = Array.isArray(grid[key]) ? [...grid[key]] : [1];
      if (remove) {
        const wanted = Math.abs(Number(amount) || 1);
        if (tracks.length <= 1) return;
        const kept = tracks.slice(0, Math.max(1, tracks.length - wanted));
        grid[key] = kept;
        for (const placement of this.placementsForLayoutPage(target, data, pageId)) {
          clampPlacementToGrid(placement, grid);
        }
        target.updated_at = now();
        return;
      }
      grid[key] = [...tracks, ...Array.from({ length: Math.max(1, amount) }, () => 1)];
      target.updated_at = now();
    });
  }
  placeBlock(blockId) {
    const item = this.currentItem();
    const layout = this.layout();
    if (!item || !layout) return;
    const pageId = layout.pagination_mode === "paged" ? this.ui.layoutPageId : null;
    const selectedGrid = this.gridForLayout(layout);
    if (!selectedGrid) return;
    if (layout.pagination_mode === "paged") {
      const cell = nextFreeCell(selectedGrid, this.placementsForLayoutPage(layout));
      if (cell.row >= selectedGrid.rows.length) {
        this.say("当前页没有空位；请调整网格或切换到其他页。", { ttl: 4500 });
        return;
      }
    }
    this.commit("放入排版内容", (data) => {
      const target = data.layout_instances.find((candidate) => candidate.id === layout.id);
      const block = data.blocks.find((candidate) => candidate.id === blockId);
      const document = data.documents.find((candidate) => candidate.id === block?.document_id);
      if (!target || !block || document?.content_item_id !== item.id) return;
      if (data.placements.some((placement) => placement.layout_instance_id === target.id && placement.block_id === blockId)) return;
      const page = pageId ? data.layout_pages.find((candidate) => candidate.id === pageId) : null;
      const grid = page ? page.grid_definition : target.grid_definition;
      const current = data.placements.filter((placement) =>
        placement.layout_instance_id === target.id && (!page || placement.page_id === page.id)
      );
      let cell = nextFreeCell(grid, current);
      // A full grid grows by one row rather than pushing a placement outside
      // a continuous canvas. A page is a finite surface and stays unchanged.
      if (cell.row >= (Array.isArray(grid.rows) ? grid.rows.length : 1) && !page) {
        grid.rows = [...(Array.isArray(grid.rows) ? grid.rows : [1]), 1];
        cell = nextFreeCell(grid, current);
      }
      if (cell.row >= (Array.isArray(grid.rows) ? grid.rows.length : 1)) return;
      const section = data.layout_sections.filter((candidate) => candidate.layout_instance_id === target.id).sort((a, b) => a.order_index - b.order_index)[0];
      data.placements.push({ id: uid(), layout_instance_id: target.id, block_id: blockId, page_id: page?.id ?? null, section_id: section ? section.id : null, row_start: cell.row, row_end: cell.row + 1, column_start: cell.column, column_end: cell.column + 1, alignment: {}, fit_mode: "natural", padding: {}, z_index: 0 });
      target.updated_at = now();
    });
  }
  unplaceBlock(blockId) {
    const layout = this.layout();
    if (!layout) return;
    this.commit("移出网格", (data) => {
      data.placements = data.placements.filter((placement) => !(placement.layout_instance_id === layout.id && placement.block_id === blockId));
    });
  }
  /**
   * The defined right-click context action on a placed block (§15.1): take this
   * placement off the Grid and leave move/selection state behind.  It goes
   * through `commit`, so one Ctrl+Z puts the block back exactly where it was,
   * and the block's own content is never touched.  No confirmation dialog: the
   * action is undoable, so a dialog would only hide the result.
   */
  removePlacementByContext(placementId) {
    const placement = (this.data.placements || []).find((candidate) =>
      candidate.id === placementId
    );
    if (!placement) return false;
    const block = this.data.blocks.find((candidate) =>
      candidate.id === placement.block_id
    );
    this.unplaceBlock(placement.block_id);
    if (this.ui.movingPlacementId === placementId) this.ui.movingPlacementId = null;
    if (this.ui.selectedBlockId === placement.block_id) this.ui.selectedBlockId = null;
    this.ui.toast = `已把「${block ? blockLabel(block.type) : "这块内容"}」移出网格，回到「还没有放进网格的正文」`;
    this.notify();
    return true;
  }
  autofillGrid() {
    const item = this.currentItem();
    const layout = this.layout();
    if (!item || !layout || layout.mode === "flow") return;
    const blocks = blocksFor(this.data, item.id);
    this.commit("一键排版全部正文", (data) => {
      const target = data.layout_instances.find((candidate) => candidate.id === layout.id);
      if (!target) return;
      const page = target.pagination_mode === "paged"
        ? data.layout_pages.find((candidate) => candidate.id === this.ui.layoutPageId)
        : null;
      const grid = page ? page.grid_definition : target.grid_definition;
      const existing = data.placements.filter((placement) =>
        placement.layout_instance_id === target.id && (!page || placement.page_id === page.id)
      );
      const placed = new Set(data.placements.filter((placement) =>
        placement.layout_instance_id === target.id
      ).map((placement) => placement.block_id));
      const section = data.layout_sections.filter((candidate) => candidate.layout_instance_id === target.id).sort((a, b) => a.order_index - b.order_index)[0];
      let cursor = nextFreeCell(grid, existing);
      for (const block of blocks) {
        if (placed.has(block.id)) continue;
        if (cursor.row >= grid.rows.length && !page) {
          grid.rows = [...grid.rows, 1, 1];
        }
        if (cursor.row >= grid.rows.length) break;
        const placement = { id: uid(), layout_instance_id: target.id, block_id: block.id, page_id: page?.id ?? null, section_id: section ? section.id : null, row_start: cursor.row, row_end: cursor.row + 1, column_start: cursor.column, column_end: Math.min(grid.columns.length, cursor.column + 2), alignment: {}, fit_mode: "natural", padding: {}, z_index: 0 };
        data.placements.push(placement);
        placed.add(block.id);
        existing.push(placement);
        cursor = nextFreeCell(grid, existing);
      }
      target.updated_at = now();
    });
    this.ui.toast = layout.pagination_mode === "paged"
      ? "已排入当前页能放下的正文；其他页面内容保持原位"
      : "已把还没有放入网格的正文排进去";
  }
  movePlacement(id, dr, dc) {
    const layout = this.layout();
    if (!layout) return;
    this.commit("吸附移动排版元素", (data) => {
      const target = data.layout_instances.find((candidate) => candidate.id === layout.id);
      const placement = data.placements.find((candidate) => candidate.id === id);
      if (!target || !placement) return;
      const page = target.pagination_mode === "paged"
        ? data.layout_pages.find((candidate) => candidate.id === placement.page_id)
        : null;
      const grid = page ? page.grid_definition : target.grid_definition;
      const rows = grid.rows.length;
      const columns = grid.columns.length;
      const rowSpan = placement.row_end - placement.row_start;
      const colSpan = placement.column_end - placement.column_start;
      placement.row_start = Math.max(0, Math.min(rows - rowSpan, Math.round(placement.row_start + dr)));
      placement.row_end = placement.row_start + rowSpan;
      placement.column_start = Math.max(0, Math.min(columns - colSpan, Math.round(placement.column_start + dc)));
      placement.column_end = placement.column_start + colSpan;
    });
  }
  /**
   * P2-4: select a grid block for moving.  The cells it can go to are derived
   * from the same helper the write uses, so the highlight can never promise a
   * cell the store would refuse.
   */
  startMovePlacement(id) {
    const layout = this.layout();
    const placement = (this.data.placements || []).find((candidate) => candidate.id === id);
    if (!layout || !placement) return;
    this.ui.movingPlacementId = id;
    this.ui.selectedBlockId = placement.block_id;
    this.ui.toast = "";
    this.scheduleSessionSave();
    this.notify();
  }
  cancelMovePlacement() {
    if (!this.ui.movingPlacementId) return;
    this.ui.movingPlacementId = null;
    this.notify();
  }
  /** Move the selected placement to a cell the UI highlighted. */
  movePlacementTo(id, row, column) {
    const layout = this.layout();
    if (!layout) return false;
    const placement = (this.data.placements || []).find((candidate) => candidate.id === id);
    if (!placement) return false;
    const grid = this.gridForLayout(layout);
    if (!grid || (layout.pagination_mode === "paged" && placement.page_id !== this.ui.layoutPageId)) return false;
    const rows = Math.max(1, grid.rows.length);
    const columns = Math.max(1, grid.columns.length);
    const rowSpan = Math.max(1, placement.row_end - placement.row_start);
    const columnSpan = Math.max(1, placement.column_end - placement.column_start);
    const rowStart = Math.max(0, Math.min(rows - rowSpan, Math.round(row)));
    const columnStart = Math.max(0, Math.min(columns - columnSpan, Math.round(column)));
    const allowed = freeCellsFor(grid, this.placementsForLayoutPage(layout), {
      rowSpan,
      columnSpan,
      exceptId: id,
    });
    if (!allowed.some((cell) => cell.row === rowStart && cell.column === columnStart)) {
      this.ui.toast = "这个位置放不下：目标格子已被占用，或超出网格。";
      this.notify();
      return false;
    }
    // `commit` renders synchronously, so the move state has to be dropped before
    // it: cleared afterwards, the redraw still draws the "正在移动" banner and the
    // leftover 「放这里」 targets, and a click on one of them moves the block again.
    this.ui.movingPlacementId = null;
    this.ui.toast = "已移动这块内容";
    this.commit("移动排版元素", (data) => {
      const target = data.placements.find((candidate) => candidate.id === id);
      if (!target) return;
      target.row_start = rowStart;
      target.row_end = rowStart + rowSpan;
      target.column_start = columnStart;
      target.column_end = columnStart + columnSpan;
    });
    return true;
  }
  resizePlacement(id, dw = 0, dh = 0) {
    const layout = this.layout();
    if (!layout) return;
    this.commit("调整排版元素尺寸", (data) => {
      const target = data.layout_instances.find((candidate) => candidate.id === layout.id);
      const placement = data.placements.find((candidate) => candidate.id === id);
      if (!target || !placement) return;
      const page = target.pagination_mode === "paged"
        ? data.layout_pages.find((candidate) => candidate.id === this.ui.layoutPageId)
        : null;
      if (page && placement.page_id !== page.id) return;
      const grid = page ? page.grid_definition : target.grid_definition;
      const rows = grid.rows.length;
      const columns = grid.columns.length;
      placement.column_end = Math.max(placement.column_start + 1, Math.min(columns, placement.column_end + dw));
      placement.row_end = Math.max(placement.row_start + 1, Math.min(rows, placement.row_end + dh));
    });
  }
  async saveVersion(name, note) {
    if (this.snapshotSaving || this.snapshotRestoringId) return;
    const snapshotName = String(name || "未命名版本").trim() || "未命名版本";
    const snapshotNote = String(note || "").trim();
    // Freeze the click's Canonical value before the first await. A later edit
    // can remain live while this immutable revision is written as a snapshot.
    const identity = this.saveIdentity();
    const project = clone(this.data);
    const revision = Math.max(1, this.saveRevision);
    const operationGeneration = ++this.snapshotOperationGeneration;
    this.snapshotName = snapshotName;
    this.snapshotNote = snapshotNote;
    this.snapshotError = "";
    this.snapshotSaving = true;
    this.snapshotLoadError = "";
    this.notify();
    try {
      if (!identity.expected_project_id) throw new Error("请先打开课程，再保存历史版本。");
      if (!await this.flush()) {
        throw new Error("课程内容尚未成功保存；历史版本没有创建，请先重试保存。");
      }
      if (!this.saveIdentityMatches(identity)) {
        throw new Error("当前课程已经切换；已取消本次历史版本创建。");
      }
      let attempt = this.snapshotAttempt;
      if (
        !attempt || attempt.name !== snapshotName || attempt.note !== snapshotNote ||
        JSON.stringify(attempt.project) !== JSON.stringify(project) ||
        !this.saveIdentityMatches(attempt.identity)
      ) {
        attempt = {
          identity,
          project,
          name: snapshotName,
          note: snapshotNote,
          snapshot_id: uid(),
          operation_id: uid(),
          revision,
        };
        this.snapshotAttempt = attempt;
      }
      const request = {
        project_dir: attempt.identity.project_dir,
        snapshot_id: attempt.snapshot_id,
        name: attempt.name,
        note: attempt.note,
        project: clone(attempt.project),
        expected_project_id: attempt.identity.expected_project_id,
        lease_generation: attempt.identity.lease_generation,
        editor_generation: attempt.identity.editor_generation,
        operation_id: attempt.operation_id,
        revision: attempt.revision,
      };
      const result = await this.bridge.createSnapshot(request);
      const validAck = result && result.persisted === true &&
        result.snapshot_id === request.snapshot_id && result.id === request.snapshot_id &&
        result.project_id === request.expected_project_id &&
        result.project_dir === request.project_dir &&
        result.lease_generation === request.lease_generation &&
        result.editor_generation === request.editor_generation &&
        result.operation_id === request.operation_id && result.revision === request.revision &&
        ["written", "unchanged"].includes(result.outcome) &&
        typeof result.content_hash === "string" && /^[a-f0-9]{64}$/i.test(result.content_hash) &&
        typeof result.created_at === "string";
      if (!validAck) throw new Error("版本保存没有返回匹配的持久化确认；未将其加入历史列表。");
      if (!this.saveIdentityMatches(attempt.identity)) {
        if (this.snapshotAttempt === attempt) this.snapshotAttempt = null;
        return;
      }
      if (operationGeneration !== this.snapshotOperationGeneration) {
        if (this.snapshotAttempt === attempt) this.snapshotAttempt = null;
        return;
      }
      const snapshot = {
        id: result.id,
        project_id: result.project_id,
        name: request.name,
        note: request.note,
        git_commit_hash: null,
        created_at: result.created_at,
        content_hash: result.content_hash,
        status: "available",
      };
      if (this.snapshotAttempt === attempt) this.snapshotAttempt = null;
      this.snapshotError = "";
      this.snapshotRows = [snapshot, ...this.snapshotRows.filter((row) => row.id !== snapshot.id)];
      this.commit("保存历史版本", (data) => {
        data.snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
        data.snapshots.unshift({
          id: snapshot.id,
          project_id: snapshot.project_id,
          name: snapshot.name,
          note: snapshot.note,
          git_commit_hash: null,
          created_at: snapshot.created_at,
        });
      });
      this.ui.snapshot = false;
      try {
        if (!await this.flush()) throw new Error("snapshot index save did not commit");
        if (operationGeneration === this.snapshotOperationGeneration && this.saveIdentityMatches(identity)) {
          this.ui.toast = result.durability_warning
            ? `已保存历史版本；持久化确认有限：${result.durability_warning}`
            : "已保存历史版本";
        }
      } catch {
        if (operationGeneration === this.snapshotOperationGeneration && this.saveIdentityMatches(identity)) {
          const durability = result.durability_warning
            ? `；持久化确认有限：${result.durability_warning}`
            : "";
          this.ui.toast = `历史版本文件已写入${durability}；课程文件中的版本索引尚未写入，重新打开版本历史时会从已保存版本中重新发现。`;
        }
      }
    } catch (error) {
      if (operationGeneration === this.snapshotOperationGeneration && this.saveIdentityMatches(identity)) {
        this.snapshotError = userFacingError(error, "历史版本没有保存成功；课程内容没有改变，可以重试。请查看保存提示。");
        this.ui.toast = this.snapshotError;
        this.ui.snapshot = true;
      }
    } finally {
      if (operationGeneration === this.snapshotOperationGeneration) {
        this.snapshotSaving = false;
        this.notify();
      }
    }
  }
  async restoreVersion(id) {
    if (this.snapshotRestoringId || this.snapshotSaving || this.canonicalMutationPending) return;
    const row = this.snapshotRows.find((candidate) => candidate.id === id);
    if (!row || row.status !== "available") {
      this.ui.toast = row?.error || "该历史版本尚未确认可读取，请刷新版本列表后重试。";
      this.notify();
      return;
    }
    this.snapshotRestoringId = id;
    const operationGeneration = ++this.snapshotOperationGeneration;
    this.notify();
    const identity = this.saveIdentity();
    let mutationOwner = null;
    try {
      if (!await this.flush()) {
        throw new Error("课程内容尚未成功保存；历史版本没有恢复，未更改本地内容。请先重试保存。");
      }
      if (!this.saveIdentityMatches(identity)) throw new Error("当前课程已经切换；恢复操作已取消。");
      if (!this.isFileFingerprint(this.projectFingerprint) || !this.projectFingerprint.exists) {
        throw new Error("当前课程文件指纹无效；历史版本没有恢复，请重新打开课程后重试。");
      }
      const request = {
        project_dir: identity.project_dir,
        expected_project_id: identity.expected_project_id,
        expected_fingerprint: clone(this.projectFingerprint),
        lease_generation: identity.lease_generation,
        editor_generation: identity.editor_generation,
        operation_id: uid(),
        revision: Math.max(1, this.saveRevision),
      };
      mutationOwner = this.beginCanonicalMutation();
      const result = await this.bridge.restoreSnapshot(id, request);
      const ack = result?.mutation_ack;
      const validAck = result && result.restored === true &&
        result.snapshot_id === id && result.backup_persisted === true &&
        typeof result.backup_snapshot_id === "string" && result.backup_snapshot_id &&
        ack?.commit_state === "committed" && ["written", "unchanged"].includes(ack.outcome) &&
        ack.project_id === request.expected_project_id &&
        normalizeProjectDir(ack.project_dir) === request.project_dir &&
        ack.lease_generation === request.lease_generation &&
        ack.editor_generation === request.editor_generation &&
        ack.operation_id === request.operation_id && ack.revision === request.revision &&
        this.isFileFingerprint(ack.fingerprint) && this.isProjectData(ack.project) &&
        ack.project.project.id === request.expected_project_id &&
        result.project_id === ack.project_id &&
        normalizeProjectDir(result.project_dir) === request.project_dir &&
        result.lease_generation === ack.lease_generation &&
        result.editor_generation === ack.editor_generation &&
        result.operation_id === ack.operation_id && result.revision === ack.revision &&
        this.isFileFingerprint(result.fingerprint) &&
        JSON.stringify(result.fingerprint) === JSON.stringify(ack.fingerprint) &&
        this.isProjectData(result.project) &&
        JSON.stringify(result.project) === JSON.stringify(ack.project);
      if (!validAck || !this.saveIdentityMatches(identity)) {
        if (ack?.commit_state === "committed" || ack?.commit_state === "outcome_uncertain") {
          await this.reconcileCommittedRestore(identity);
        }
        throw new Error("恢复确认与当前操作不匹配；已重新读取项目状态，请检查后再继续。");
      }
      if (!this.adoptProjectSnapshot({
        project: ack.project,
        project_id: ack.project_id,
        fingerprint: ack.fingerprint,
      })) {
        await this.reconcileCommittedRestore(identity);
        throw new Error("恢复已经提交，但返回项目无效；已尝试重新读取当前项目。");
      }
      this.reconcileEditorSaveState();
      this.snapshotRows = [];
      const warnings = [result.recovery_warning, result.durability_warning]
        .filter((warning) => typeof warning === "string" && warning.trim());
      this.ui.toast = result.durability_warning
        ? `已恢复历史版本并写入恢复前备份；持久化确认有限：${warnings.join("；")}`
        : warnings.length
        ? `已恢复历史版本，恢复前备份已持久保存；${warnings.join("；")}`
        : "已恢复历史版本，恢复前备份已持久保存。";
      await this.refreshSnapshots();
    } catch (error) {
      if (error?.commit_state === "outcome_uncertain" && this.saveIdentityMatches(identity)) {
        await this.reconcileCommittedRestore(identity).catch(() => false);
      }
      if (operationGeneration === this.snapshotOperationGeneration && this.saveIdentityMatches(identity)) {
        this.ui.toast = userFacingError(error, "历史版本没有恢复；请查看保存状态和提示。");
      }
    } finally {
      if (mutationOwner) this.endCanonicalMutation(mutationOwner);
      if (operationGeneration === this.snapshotOperationGeneration) {
        this.snapshotRestoringId = null;
        this.notify();
      }
    }
  }
  async reconcileCommittedRestore(identity) {
    const state = await this.readProjectSnapshot();
    if (
      !this.saveIdentityMatches(identity) || !this.isProjectData(state?.project) ||
      state.project.project.id !== identity.expected_project_id || !this.isFileFingerprint(state.fingerprint)
    ) return false;
    if (!this.adoptProjectSnapshot({ ...state, project_id: identity.expected_project_id })) return false;
    this.reconcileEditorSaveState();
    return true;
  }
  exportPreflight() {
    const options = this.publicationOptions();
    const selected = this.ui.publishScope === "course"
      ? this.data.content_items.filter((candidate) => !candidate.archived)
      : [this.currentItem()].filter(Boolean);
    const ids = new Set(selected.map((item) => item.id));
    const requirements = this.data.requirements.filter((requirement) => ids.has(requirement.content_item_id) && requirement.status === "open");
    const content = requirements.filter((requirement) => requirement.scope === "content").length;
    const layout = requirements.filter((requirement) => requirement.scope === "layout").length;
    const usages = this.data.asset_usages.filter((usage) => ids.has(usage.content_item_id));
    const missingAssets = usages.filter((usage) => !this.data.assets.some((asset) => asset.id === usage.asset_id && !asset.archived)).length;
    const layouts = this.data.layout_instances.filter((candidate) => ids.has(candidate.content_item_id));
    const selectedPageIds = options.page_ids == null ? null : new Set(options.page_ids);
    const overflow = layouts.reduce((sum, layoutInstance) => sum + this.data.placements
      .filter((placement) => placement.layout_instance_id === layoutInstance.id)
      .filter((placement) => !selectedPageIds || selectedPageIds.has(placement.page_id))
      .filter((placement) => {
        const grid = this.gridForLayout(layoutInstance, this.data, placement.page_id);
        return grid && (placement.row_end > grid.rows.length || placement.column_end > grid.columns.length);
      }).length, 0);
    const text = selected.reduce((sum, item) => sum + lessonView(this.data, item.id).progress.empty_text_blocks, 0);
    const fonts = 0;
    const external = selected.flatMap((item) => blocksFor(this.data, item.id)).filter((block) => /https?:\/\//i.test(textOf(block.content))).length;
    const downgradeTypes = this.ui.publishFormat === "pdf"
      ? new Set(["gif", "video", "audio", "document", "other"])
      : new Set(["video", "audio", "document", "other"]);
    const mediaDowngrades = usages.filter((usage, index, all) => {
      const asset = this.data.assets.find((candidate) => candidate.id === usage.asset_id);
      return asset && downgradeTypes.has(asset.type) && all.findIndex((candidate) => candidate.asset_id === usage.asset_id) === index;
    }).length;
    let projection = null;
    let projectionError = null;
    try {
      projection = buildPublicationProjection(this.data, options);
    } catch (error) {
      projectionError = error instanceof Error ? error.message : String(error);
    }
    const capability = projection
      ? this.publicationCapability(this.ui.publishFormat, projection)
      : { status: "unavailable", code: "invalid_selection" };
    const unsupported = ["unavailable", "unsupported"].includes(capability.status);
    const unplaced = projection?.lessons.reduce((sum, lesson) =>
      sum + (lesson.layout?.unplaced_block_ids?.length || 0), 0) || 0;
    const missingLesson = this.ui.publishScope !== "course" && !this.currentItem();
    const blocking = overflow + missingAssets + Number(Boolean(projectionError)) + Number(unsupported) + Number(missingLesson);
    const warningCount = content + layout + text + fonts + external + mediaDowngrades + unplaced + Number(capability.status === "lossy");
    const issues = [];
    if (missingLesson) issues.push({ severity: "blocking", code: "missing_content_item", message: "请先在课程地图选择一课，或把输出范围改为整门课程。" });
    if (projectionError) issues.push({ severity: "blocking", code: "invalid_publication_selection", message: projectionError });
    if (unsupported) issues.push({
      severity: "blocking",
      code: capability.code || "adapter_unavailable",
      message: capability.status === "unsupported"
        ? "所选格式不支持当前排版方式。请改用支持页面布局的格式，或切换为 Grid 排版。"
        : "当前运行环境没有这个导出格式的可用适配器。",
    });
    const warning = (code, count, message) => {
      if (count > 0) issues.push({ severity: "warning", code, count, message });
    };
    warning("open_content_requirements", content, `${content} 项正文待补仍未完成；这些内容会按现状导出。`);
    warning("open_layout_requirements", layout, `${layout} 项排版待补仍未完成；这些内容会按现状导出。`);
    warning("empty_text", text, `${text} 段正文为空，导出时会保留为空白或跳过。`);
    warning("external_references", external, `${external} 处内容含外部引用，目标平台可能无法访问。`);
    warning("media_downgrade", mediaDowngrades, `${mediaDowngrades} 种媒体会以附件或迁移说明呈现。`);
    warning("unplaced_content", unplaced, `${unplaced} 块正文未放在排版页面中；本次布局导出只包含已放置内容。`);
    if (capability.status === "lossy") warning(
      capability.code || "layout_linearized",
      1,
      "此格式会把页面布局线性化，位置、页面尺寸和分页不会保留。",
    );
    return {
      content, layout, missingAssets, overflow, text, fonts, external,
      mediaDowngrades, blocking, warnings: warningCount,
      total: blocking + warningCount, issues, capability,
    };
  }
  async openPreflight() {
    const generation = ++this.preflightGeneration;
    const activeFlush = this.activeFlushPromise;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = 0;
      this.preflightDeferredSave = true;
    }
    // A save already in progress may finish, but opening preflight never starts
    // one. The report below is built from the current in-memory project.
    if (activeFlush) await activeFlush.catch(() => false);
    if (generation !== this.preflightGeneration) return;
    if (this.ui.route !== "publish") {
      const item = this.currentItem();
      this.ui.publishReturnContext = {
        route: this.ui.route,
        screen: this.ui.screen,
        activeId: this.ui.activeId,
        mode: this.ui.mode,
        layoutPageId: this.ui.layoutPageId,
        publishScope: this.ui.publishScope,
        publishPageMode: this.ui.publishPageMode,
        publishSelectedPageIds: [...this.ui.publishSelectedPageIds],
      };
      if (
        this.ui.route === "editor" && this.ui.mode === "preview" &&
        item && this.layout(item)?.pagination_mode === "paged"
      ) {
        this.ui.publishScope = "lesson";
        this.ui.publishPageMode = "current";
        this.ui.publishSelectedPageIds = this.ui.layoutPageId
          ? [this.ui.layoutPageId]
          : [];
      }
    }
    this.ui.route = "publish";
    const selection = this.publicationOptions();
    const revision = this.data.project.updated_at;
    let projection = null;
    try {
      projection = buildPublicationProjection(this.data, selection);
    } catch {
      // exportPreflight keeps the actionable validation message.
    }
    this.ui.preflight = true;
    this.ui.preflightReport = this.exportPreflight();
    this.ui.preflightRevision = revision;
    this.ui.preflightFormat = this.ui.publishFormat;
    this.ui.preflightOptions = {
      ...selection,
      ...(projection ? { projection } : {}),
      // Native export binds projections to project.updated_at. The service
      // computes a canonical SHA revision and returns it from preflight.
      ...(this.bridge.isNative() ? { snapshot_revision: revision } : {}),
    };
    this.ui.acknowledgedWarnings = [];
    this.ui.preflightPending = Boolean(
      projection && (typeof this.bridge.query === "function" || typeof this.bridge.invoke === "function")
    );
    this.notify();
    if (!this.ui.preflightPending) return;
    try {
      const options = this.ui.preflightOptions;
      const checkedRevision = this.ui.preflightRevision;
      const preset = { name: this.ui.publishFormat, output_type: this.ui.publishFormat, target_type: this.ui.publishFormat, platform: "通用", settings: {} };
      const query = this.bridge.query || this.bridge.invoke;
      const report = await query.call(this.bridge, "export.preflight", { preset, options });
      if (generation !== this.preflightGeneration || this.ui.route !== "publish" || !this.ui.preflight) return;
      const local = this.exportPreflight();
      if (this.data.project.updated_at !== checkedRevision) {
        this.ui.preflightReport = {
          ...local,
          blocking: Math.max(1, local.blocking),
          issues: [...local.issues, {
            severity: "blocking",
            code: "project_changed_after_preflight",
            message: "课程在检查期间发生变化，请重新运行导出前检查。",
          }],
        };
        this.ui.preflightPending = false;
        this.notify();
        return;
      }
      const errors = Array.isArray(report?.blocking)
        ? report.blocking
        : Array.isArray(report?.errors)
        ? report.errors
        : [];
      const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
      const authoritativeIssues = Array.isArray(report?.issues)
        ? report.issues
        : [
          ...errors.map((issue) => ({ ...issue, severity: "blocking" })),
          ...warnings.map((issue) => ({ ...issue, severity: "warning" })),
        ];
      if (typeof report?.snapshot_revision !== "string" || !report.snapshot_revision) {
        throw new Error("导出预检没有返回快照版本；请重新检查后再试。");
      }
      this.ui.preflightOptions = {
        ...this.ui.preflightOptions,
        snapshot_revision: report.snapshot_revision,
      };
      const blockingCount = Math.max(errors.length, local.blocking);
      const warningCount = warnings.length || authoritativeIssues.filter((issue) => issue.severity === "warning").length;
      // 本地只统计「引用断链」，磁盘上文件缺失由原生检查发现；两者都会让导出被阻止，
      // 因此这一行必须同时反映原生错误，否则会出现「缺失素材文件 ✓ 0 / BLOCKING 1」的矛盾显示。
      const missingAssets = Math.max(local.missingAssets, errors.filter((issue) => issue.code === "missing_asset").length);
      const issueMap = new Map();
      for (const issue of [
        ...local.issues.filter((issue) => issue.severity === "blocking"),
        ...authoritativeIssues,
      ]) {
        const key = `${issue.severity || "warning"}:${issue.code || issue.message || "unknown"}`;
        const previous = issueMap.get(key);
        issueMap.set(key, previous
          ? { ...previous, ...issue, count: Math.max(previous.count || 0, issue.count || 0) }
          : issue);
      }
      this.ui.preflightReport = {
        ...local,
        missingAssets,
        blocking: blockingCount,
        warnings: warningCount,
        total: blockingCount + warningCount,
        issues: [...issueMap.values()],
      };
    } catch (error) {
      if (generation !== this.preflightGeneration || this.ui.route !== "publish" || !this.ui.preflight) return;
      this.ui.preflightReport = { ...this.exportPreflight(), blocking: 1, issues: [{ severity: "blocking", message: userFacingError(error, "导出检查没有完成。请稍后再试。") }] };
    }
    this.ui.preflightPending = false;
    this.notify();
  }
  returnFromPublish() {
    this.cancelPreflight();
    const context = this.ui.publishReturnContext;
    this.ui.preflight = false;
    this.ui.preflightPending = false;
    this.ui.preflightReport = null;
    this.ui.preflightOptions = null;
    this.ui.acknowledgedWarnings = [];
    this.ui.publishReturnContext = null;
    if (context) {
      this.ui.screen = context.screen;
      this.ui.route = context.route === "publish" ? "map" : context.route;
      this.ui.activeId = this.data.content_items.some((item) =>
        item.id === context.activeId && !item.archived
      ) ? context.activeId : this.ui.activeId;
      this.ui.mode = context.mode || this.ui.mode;
      this.ui.layoutPageId = context.layoutPageId || null;
      this.ui.publishScope = context.publishScope || "lesson";
      this.ui.publishPageMode = context.publishPageMode || "all";
      this.ui.publishSelectedPageIds = [...(context.publishSelectedPageIds || [])];
    } else {
      this.ui.route = "map";
    }
    this.scheduleSessionSave();
    this.notify();
  }
  cancelPreflight({ clearContext = false } = {}) {
    this.preflightGeneration += 1;
    if (this.ui.preflight || this.ui.preflightPending) {
      this.ui.preflight = false;
      this.ui.preflightPending = false;
      this.ui.preflightReport = null;
      this.ui.preflightOptions = null;
      this.ui.acknowledgedWarnings = [];
      if (clearContext) this.ui.publishReturnContext = null;
    }
  }
  cancelActiveExport() {
    const exportId = this.activeExportId;
    this.activeExportId = null;
    if (exportId && !this.bridge.isNative() && typeof this.bridge.command === "function") {
      void this.bridge.command("export.release", { export_id: exportId }).catch(() => {});
    }
  }
  async exportCurrent(format = this.ui.publishFormat || "markdown") {
    const item = this.currentItem();
    if (!item && this.ui.publishScope !== "course") {
      this.ui.toast = "还没有可导出的课程内容。请先在课程地图创建一课，再运行导出。";
      this.notify();
      return;
    }
    if (this.ui.preflightPending) {
      this.ui.toast = "导出检查仍在进行，请等待检查结果。";
      this.notify();
      return;
    }
    const report = this.ui.preflightReport || this.exportPreflight();
    if (report.blocking) {
      this.ui.toast = `导出前检查还有 ${report.blocking} 个必须修复的问题。请先返回检查并修复`;
      this.notify();
      return;
    }
    const currentSelection = this.publicationOptions();
    const frozen = this.ui.preflightOptions;
    const selectionKeys = ["content_item_id", "layout_instance_id", "page_ids", "target_page_size"];
    const sameSelection = frozen && selectionKeys.every((key) =>
      JSON.stringify(frozen[key] ?? null) === JSON.stringify(currentSelection[key] ?? null)
    );
    if (
      !sameSelection ||
      this.ui.preflightRevision !== this.data.project.updated_at ||
      this.ui.preflightFormat !== format
    ) {
      this.ui.toast = "课程或导出范围在检查后发生变化，正在重新检查。";
      this.ui.preflight = true;
      this.notify();
      void this.openPreflight();
      return;
    }
    const warningCodes = [...new Set((report.issues || [])
      .filter((issue) => issue.severity === "warning" && issue.code)
      .map((issue) => issue.code))];
    const acknowledged = new Set(this.ui.acknowledgedWarnings || []);
    const missingAcknowledgement = warningCodes.filter((code) => !acknowledged.has(code));
    if (missingAcknowledgement.length) {
      this.ui.toast = "请逐项确认导出提示后再继续。";
      this.ui.preflight = true;
      this.notify();
      return;
    }
    const options = {
      ...clone(frozen),
      acknowledged_warnings: warningCodes,
    };
    const contentItemId = options.content_item_id;
    const preset = {
      name: format,
      output_type: format,
      target_type: format,
      platform: "通用",
      page_mode: "multi_page",
      layout_instance_id: options.layout_instance_id,
      settings: {},
    };
    if (this.bridge.isNative()) {
      try {
        const directoryFormats = new Set(["web", "asset_package", "full_project"]);
        const extensions = { markdown: "md", html: "html", wechat: "html", pdf: "pdf", pptx: "pptx", json: "json" };
        const selectedItem = options.content_item_id
          ? this.data.content_items.find((candidate) => candidate.id === options.content_item_id)
          : null;
        const isCourse = !options.content_item_id;
        const stem = isCourse || !selectedItem
          ? this.data.project.title
          : `${selectedItem.code}-${selectedItem.title}`;
        const filename = directoryFormats.has(format) ? stem : `${stem}.${extensions[format] || format}`;
        const outputPath = await this.bridge.selectExportPath(filename, format);
        if (!outputPath) return;
        const result = await this.bridge.exportProject(format, this.data, preset, outputPath, contentItemId, options);
        const files = Array.isArray(result?.files) ? result.files.length : 0;
        const destination = result?.output_path || outputPath;
        this.ui.lastExport = { format, scope: isCourse ? "course" : "lesson", path: destination, files };
        this.ui.toast = directoryFormats.has(format)
          ? `导出目录已生成：${files || 1} 个文件，位置：${destination}`
          : `导出完成：${files || 1} 个文件，可在 ${destination} 打开`;
      } catch (error) {
        this.ui.lastExport = null;
        this.ui.toast = `导出没有完成。源课程没有修改。${userFacingError(error, "请先修复导出前检查列出的问题，再重试。")}`;
      }
      this.notify();
      return;
    }
    try {
      if (typeof this.bridge.exportProject !== "function") {
        throw new Error("当前浏览器没有连接可用的导出服务；课程内容没有改变。");
      }
      const exportId = globalThis.crypto?.randomUUID?.().replaceAll("-", "").toLowerCase() || null;
      this.activeExportId = exportId;
      const result = await this.bridge.exportProject(format, this.data, preset, "", contentItemId, {
        ...options,
        ...(exportId ? { export_id: exportId } : {}),
      });
      if (exportId && this.activeExportId !== exportId) return;
      const files = Array.isArray(result?.files) ? result.files : [];
      if (!files.length) throw new Error("导出服务没有返回可下载文件；课程内容没有改变。");
      let downloaded = 0;
      for (const file of files) {
        if (!file || typeof file.relative_path !== "string") continue;
        if (typeof file.download_url === "string" && file.download_url) {
          downloaded += Number(browserDownloadUrl(
            file.relative_path.split(/[\\/]/).at(-1) || format,
            file.download_url,
          ));
        } else if (file.bytes) {
          downloaded += Number(browserDownload(
            file.relative_path.split(/[\\/]/).at(-1) || format,
            file.bytes,
            file.mime_type || "application/octet-stream",
          ));
        }
      }
      if (!downloaded) throw new Error("导出文件没有可下载的内容；课程内容没有改变。");
      this.activeExportId = null;
      this.ui.lastExport = { format, scope: options.content_item_id ? "lesson" : "course", path: "浏览器下载", files: downloaded, status: "handed_off" };
      this.ui.toast = `已将 ${downloaded}/${files.length} 个文件交给浏览器下载；完成情况请查看浏览器下载列表。`;
    } catch (error) {
      this.cancelActiveExport();
      this.ui.toast = userFacingError(error, "导出没有完成。源课程没有修改，请修复提示后重试。");
    }
    this.notify();
  }
  async recordPublication() {
    const item = this.currentItem();
    if (!item) return;
    const report = this.exportPreflight();
    if (report.blocking) {
      this.ui.toast = `导出前检查还有 ${report.blocking} 个必须修复的问题。课程内容没有改变，请先修复后再记录发布`;
      this.notify();
      return;
    }
    const publication = { content_item_id: item.id, platform: "手动发布", layout_instance_id: this.layout(item)?.id || null, status: "published", version_label: "手动发布", published_at: now(), external_url: null, export_path: null };
    try {
      const execution = await this.runCanonicalMutation("publication.record", { publication });
      this.ui.toast = execution.warnings.length
        ? `已记录发布版本；${execution.warnings.join("；")}`
        : "已记录发布版本";
    } catch (error) {
      this.ui.toast = userFacingError(error, "发布记录没有保存。课程内容没有改变，请重试。");
    }
    this.notify();
  }
}

/* ------------------------------------------------------------------ *
 * UI-only helpers.  These stay in the shell because they only touch
 * view state; every canonical mutation goes through WorkbenchStore.
 * ------------------------------------------------------------------ */

// 「工作台」is a left-nav entry (openWorkbench); authoring still uses route "editor".
// "workbench" is accepted as a session alias and normalized to "editor".
const ROUTES = ["overview", "map", "workbench", "free-layout", "explorer", "mapping", "inbox", "board", "media", "backlog", "updates", "publish", "versions", "settings", "editor"];
/**
 * Directory failures from the shell's `explicit_project_dir`, i.e. the cases
 * where the stored path genuinely is not a usable project directory.
 */
const UNUSABLE_PROJECT_DIR_ERRORS = [
  "项目目录不能为空",
  "项目目录必须是用户明确选择的绝对路径",
  "项目目录不存在",
  "项目目录不能是符号链接",
  "项目目录不是目录",
  "项目目录的父目录无效",
];

/**
 * True when a failed boot still leaves the stored project pointer worth
 * keeping.
 *
 * Only a path the shell reports as unusable loses the pointer.  A project that
 * is merely busy (another window still holds the lease), whose lock could not
 * be created, or whose project.json could not be read this time will open
 * again — and erasing the session would permanently lose where the user was.
 * Keeping a stale pointer costs at most one failed open with a readable
 * message; clearing it costs the reader position for good.
 */
function shouldKeepProjectPointer(error) {
  const message = String(error?.message || error || "");
  return !UNUSABLE_PROJECT_DIR_ERRORS.some((reason) => message.includes(reason));
}

const RIGHT_PANEL_KEYS = ["media", "requirements", "status", "assistant", "properties", "versions"];

/**
 * Minimal canonical invariants the UI can break on its own.
 *
 * The desktop shell writes whole projects, so a UI-side mistake would silently
 * replace a good file with an invalid one.  These checks mirror the domain
 * validator's most load-bearing rules and run before every write.
 *
 * @param {any} data
 * @returns {string[]}
 */
function assertAuthoringInvariants(data) {
  const issues = [];
  const rows = (key) => (Array.isArray(data[key]) ? data[key] : []);
  const ids = (key) => new Set(rows(key).map((row) => row && row.id));
  const blockIds = ids("blocks");
  const assetIds = ids("assets");
  const layoutIds = ids("layout_instances");
  const pageIds = ids("layout_pages");
  const contentIds = ids("content_items");
  const optionIds = ids("status_options");
  const dimensionIds = ids("status_dimensions");
  const requirementIds = ids("requirements");
  const blockById = new Map(rows("blocks").map((block) => [block.id, block]));
  const requirementById = new Map(
    rows("requirements").map((requirement) => [requirement.id, requirement]),
  );
  const stageIds = ids("stages");

  // Lesson codes are user-facing identifiers and must stay unique.
  const seenCodes = new Set();
  for (const item of rows("content_items")) {
    const code = String(item.code || "");
    if (seenCodes.has(code)) {
      issues.push(`课程编号重复：${code}`);
    }
    seenCodes.add(code);
    if (item.project_id !== data.project.id) {
      issues.push(`课程内容 ${item.id} 不属于当前项目`);
    }
    if (item.stage_id && !stageIds.has(item.stage_id)) {
      issues.push(`课程内容 ${item.id} 指向不存在的阶段`);
    }
  }

  for (const requirement of rows("requirements")) {
    const resolved = requirement.status === "resolved";
    if (resolved && requirement.resolved_asset_id && !assetIds.has(requirement.resolved_asset_id)) {
      issues.push(`待补 ${requirement.id} 指向不存在的素材`);
    }
    if (!resolved && (requirement.resolved_asset_id || requirement.resolved_block_id)) {
      issues.push(`待补 ${requirement.id} 未完成却保留了完成引用`);
    }
    if (requirement.anchor_block_id && !blockIds.has(requirement.anchor_block_id)) {
      issues.push(`待补 ${requirement.id} 指向不存在的正文区块`);
    }
    if (requirement.scope === "layout") {
      if (!requirement.layout_instance_id) {
        issues.push(`排版待补 ${requirement.id} 缺少排版版本`);
      } else if (!layoutIds.has(requirement.layout_instance_id)) {
        issues.push(`待补 ${requirement.id} 指向不存在的排版版本`);
      }
    } else if (requirement.layout_instance_id !== null && requirement.layout_instance_id !== undefined) {
      issues.push(`内容待补 ${requirement.id} 不能关联排版版本`);
    }
    // A resolved requirement must have the matching role:"requirement" usage.
    if (resolved && requirement.resolved_asset_id) {
      const hasUsage = rows("asset_usages").some((usage) =>
        usage.asset_id === requirement.resolved_asset_id &&
        usage.content_item_id === requirement.content_item_id &&
        (usage.block_id ?? null) === (requirement.anchor_block_id ?? null) &&
        (usage.layout_instance_id ?? null) === (requirement.layout_instance_id ?? null) &&
        usage.role === "requirement"
      );
      if (!hasUsage) {
        issues.push(`已完成待补 ${requirement.id} 缺少对应的素材引用记录`);
      }
    }
  }

  for (const block of rows("blocks")) {
    const linked = block.settings && block.settings.asset_id;
    if (linked && !assetIds.has(linked)) {
      issues.push(`正文区块 ${block.id} 指向不存在的素材`);
    }
    const requirementId = block.settings && block.settings.requirement_id;
    if (requirementId && !requirementIds.has(requirementId)) {
      issues.push(`正文区块 ${block.id} 指向不存在的待补`);
    }
    const document = rows("documents").find((candidate) => candidate.id === block.document_id);
    if (!document || !contentIds.has(document.content_item_id)) {
      issues.push(`正文区块 ${block.id} 不属于任何课程内容`);
    }
    const parent = block.parent_block_id;
    if (parent && !blockIds.has(parent)) {
      issues.push(`正文区块 ${block.id} 的父区块不存在`);
    }
  }
  // The requirement owns the anchor relationship; a stale back-pointer on a
  // block is not a canonical error (the domain validator accepts it), so it is
  // reported only when the pointer names a requirement that does not exist.
  for (const requirement of rows("requirements")) {
    const anchor = requirement.anchor_block_id
      ? blockById.get(requirement.anchor_block_id)
      : null;
    const linkedTo = anchor && anchor.settings && anchor.settings.requirement_id;
    if (linkedTo && !requirementIds.has(linkedTo)) {
      issues.push(`正文区块 ${anchor.id} 的待补指针指向不存在的待补`);
    }
  }

  for (const usage of rows("asset_usages")) {
    if (!assetIds.has(usage.asset_id)) issues.push(`素材引用 ${usage.id} 指向不存在的素材`);
    if (!contentIds.has(usage.content_item_id)) issues.push(`素材引用 ${usage.id} 指向不存在的课程内容`);
    if (usage.block_id && !blockIds.has(usage.block_id)) {
      issues.push(`素材引用 ${usage.id} 指向不存在的正文区块`);
    }
    if (usage.layout_instance_id && !layoutIds.has(usage.layout_instance_id)) {
      issues.push(`素材引用 ${usage.id} 指向不存在的排版版本`);
    }
  }

  for (const placement of rows("placements")) {
    if (!blockIds.has(placement.block_id)) issues.push(`排版位置 ${placement.id} 指向不存在的正文区块`);
    if (!layoutIds.has(placement.layout_instance_id)) issues.push(`排版位置 ${placement.id} 指向不存在的排版版本`);
    // Grid overflow is deliberately NOT a save blocker: the canonical format
    // allows a placement to outlive a shrinking grid, and the export preflight
    // reports it as a canvas warning.  Blocking saves for it would make a
    // project the domain considers valid impossible to edit.
    const integers = [
      placement.row_start,
      placement.row_end,
      placement.column_start,
      placement.column_end,
    ];
    if (!integers.every((value) => Number.isInteger(value))) {
      issues.push(`排版位置 ${placement.id} 的网格坐标必须是整数`);
    }
    if (placement.page_id != null) {
      const page = rows("layout_pages").find((candidate) => candidate.id === placement.page_id);
      if (!page) issues.push(`排版位置 ${placement.id} 指向不存在的页面`);
      else if (page.layout_instance_id !== placement.layout_instance_id) {
        issues.push(`排版位置 ${placement.id} 指向其他排版版本的页面`);
      }
    } else if (rows("layout_instances").some((candidate) =>
      candidate.id === placement.layout_instance_id && candidate.pagination_mode === "paged"
    )) {
      issues.push(`分页排版位置 ${placement.id} 缺少页面引用`);
    }
  }
  for (const section of rows("layout_sections")) {
    if (!layoutIds.has(section.layout_instance_id)) {
      issues.push(`排版分区 ${section.id} 指向不存在的排版版本`);
    }
  }
  for (const layout of rows("layout_instances")) {
    if (!contentIds.has(layout.content_item_id)) {
      issues.push(`排版版本 ${layout.id} 指向不存在的课程内容`);
    }
    const pages = rows("layout_pages").filter((page) => page.layout_instance_id === layout.id);
    if (layout.pagination_mode === "paged" && pages.length === 0) {
      issues.push(`分页排版版本 ${layout.id} 至少需要一页`);
    }
  }
  const seenPageIds = new Set();
  for (const page of rows("layout_pages")) {
    if (seenPageIds.has(page.id)) issues.push(`页面标识重复：${page.id}`);
    seenPageIds.add(page.id);
    if (!layoutIds.has(page.layout_instance_id)) {
      issues.push(`页面 ${page.id} 指向不存在的排版版本`);
    }
    if (!String(page.title || "").trim()) issues.push(`页面 ${page.id} 缺少标题`);
    if (!Number.isInteger(page.order_index) || page.order_index < 0) {
      issues.push(`页面 ${page.id} 的顺序必须是非负整数`);
    }
    if (!page.grid_definition || !Array.isArray(page.grid_definition.rows) || !Array.isArray(page.grid_definition.columns)) {
      issues.push(`页面 ${page.id} 缺少有效网格`);
    }
  }

  for (const assignment of rows("status_assignments")) {
    if (!contentIds.has(assignment.content_item_id)) {
      issues.push(`状态 ${assignment.id} 指向不存在的课程内容`);
    }
    if (!dimensionIds.has(assignment.dimension_id) || !optionIds.has(assignment.option_id)) {
      issues.push(`状态 ${assignment.id} 使用了非规范的状态引用`);
    }
  }
  const assignmentKeys = new Set();
  for (const assignment of rows("status_assignments")) {
    const key = `${assignment.content_item_id}|${assignment.dimension_id}`;
    if (assignmentKeys.has(key)) {
      issues.push(`同一内容的同一状态维度出现了多条记录：${assignment.content_item_id}`);
    }
    assignmentKeys.add(key);
  }

  for (const inbox of rows("inbox_items")) {
    if (inbox.content_item_id && !contentIds.has(inbox.content_item_id)) {
      issues.push(`收件箱条目 ${inbox.id} 指向不存在的课程内容`);
    }
    if (inbox.asset_id && !assetIds.has(inbox.asset_id)) {
      issues.push(`收件箱条目 ${inbox.id} 指向不存在的素材`);
    }
  }
  for (const publication of rows("publications")) {
    if (!contentIds.has(publication.content_item_id)) {
      issues.push(`发布记录 ${publication.id} 指向不存在的课程内容`);
    }
  }
  for (const snapshot of rows("snapshots")) {
    // Older snapshots may not carry a project id; only a mismatching one is an
    // error.
    if (snapshot.project_id != null && snapshot.project_id !== data.project.id) {
      issues.push(`历史版本 ${snapshot.id} 不属于当前项目`);
    }
  }
  return [...new Set(issues)];
}

/** Keep order_index contiguous after an insert or delete. */
function renumberBlocks(data, documentId) {
  data.blocks.filter((block) => block.document_id === documentId).sort((a, b) => a.order_index - b.order_index).forEach((block, index) => { block.order_index = index; });
}

/** Give a lesson the six default statuses without overwriting existing ones. */
function initializeStatusesFor(data, contentItemId) {
  for (const dimension of data.status_dimensions.filter((candidate) => candidate.project_id === data.project.id)) {
    const first = data.status_options.filter((option) => option.dimension_id === dimension.id).sort((a, b) => a.order_index - b.order_index)[0];
    if (!first) continue;
    const existing = data.status_assignments.find((assignment) => assignment.content_item_id === contentItemId && assignment.dimension_id === dimension.id);
    if (existing) continue;
    data.status_assignments.push({ id: uid(), content_item_id: contentItemId, dimension_id: dimension.id, option_id: first.id, updated_at: now() });
  }
}

function clampPlacementToGrid(placement, grid) {
  const rows = Array.isArray(grid.rows) ? grid.rows.length : 1;
  const columns = Array.isArray(grid.columns) ? grid.columns.length : 1;
  const rowSpan = Math.max(1, Math.min(rows, placement.row_end - placement.row_start));
  const colSpan = Math.max(1, Math.min(columns, placement.column_end - placement.column_start));
  placement.row_start = Math.max(0, Math.min(rows - rowSpan, placement.row_start));
  placement.row_end = placement.row_start + rowSpan;
  placement.column_start = Math.max(0, Math.min(columns - colSpan, placement.column_start));
  placement.column_end = placement.column_start + colSpan;
}

/** First cell in reading order that no existing placement occupies. */
function nextFreeCell(grid, placements) {
  const rows = Math.max(1, Array.isArray(grid.rows) ? grid.rows.length : 1);
  const columns = Math.max(1, Array.isArray(grid.columns) ? grid.columns.length : 1);
  const taken = new Set(placements.flatMap((placement) => {
    const cells = [];
    for (let row = placement.row_start; row < placement.row_end; row += 1) {
      for (let column = placement.column_start; column < placement.column_end; column += 1) cells.push(`${row}:${column}`);
    }
    return cells;
  }));
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!taken.has(`${row}:${column}`)) return { row, column };
    }
  }
  return { row: rows, column: 0 };
}

let lastDataUrl = null;
function markDataUrl(url) {
  if (lastDataUrl && lastDataUrl !== url) {
    try { URL.revokeObjectURL(lastDataUrl); } catch { /* already released */ }
  }
  lastDataUrl = url;
  return url;
}

function emptyProject(title = "未命名课程") {
  const project = { id: uid(), title, description: "", language: "zh-CN", schema_version: "1.0.0", created_at: now(), updated_at: now(), archived: false, settings: {} };
  const dimensionKeys = Object.keys(STATUS);
  const dimensionNames = { content: "正文", media: "媒体", layout: "排版", review: "审核", publish: "发布", update: "更新" };
  const status_dimensions = dimensionKeys.map((key, index) => ({ id: uid(), project_id: project.id, key, name: dimensionNames[key], order_index: index, allow_custom: true }));
  const status_options = status_dimensions.flatMap((dimension) => STATUS[dimension.key].map((name, index) => ({ id: uid(), dimension_id: dimension.id, key: `${dimension.key}_${index}`, name, order_index: index, is_terminal: index === STATUS[dimension.key].length - 1 })));
  return {
    schema_version: "1.0.0",
    project,
    stages: [], content_items: [], documents: [], blocks: [], groups: [], requirements: [],
    assets: [], asset_usages: [], status_dimensions, status_options, status_assignments: [],
    layout_templates: [], layout_instances: [], layout_sections: [], layout_pages: [], placements: [],
    inbox_items: [], export_presets: [], course_seeds: [], blueprint_drafts: [], blueprint_nodes: [],
    conversation_sources: [], conversations: [], messages: [], context_packs: [], context_pack_items: [],
    suggestions: [], change_drafts: [], snapshots: [], publications: [],
  };
}

function blankProject(title = "未命名课程") {
  return emptyProject(title);
}

/**
 * Fill in collections a project file may not have carried yet, and repair
 * legacy shapes the UI used to write (a status assignment keyed by name
 * instead of by canonical id) so the next save passes domain validation.
 */
function migrateUiProject(value) {
  const defaults = emptyProject(String(value?.project?.title || "未命名课程"));
  const clonedValue = clone(value);
  const clonedProject = clone(value.project);
  const data = { ...defaults, ...clonedValue, project: { ...defaults.project, ...clonedProject } };
  for (const key of Object.keys(defaults)) {
    // `project` is an object, not a collection: replacing it here would throw
    // away the loaded project identity and every reference to it.
    if (key === "project") continue;
    if (!Array.isArray(data[key])) data[key] = defaults[key];
  }
  if (!data.status_dimensions.length) {
    data.status_dimensions = defaults.status_dimensions;
    data.status_options = defaults.status_options;
  }
  // Repair status assignments that carry either the legacy name-keyed shape or
  // ids from a previous dimension set, so the next save passes validation.
  const dimensionById = new Map(
    data.status_dimensions.map((dimension) => [dimension.id, dimension]),
  );
  const optionById = new Map(
    data.status_options.map((option) => [option.id, option]),
  );
  const repaired = [];
  for (const assignment of data.status_assignments) {
    const knownDimension = dimensionById.get(assignment.dimension_id);
    const knownOption = optionById.get(assignment.option_id);
    if (
      knownDimension && knownOption &&
      knownOption.dimension_id === knownDimension.id
    ) {
      delete assignment.dimension_key;
      delete assignment.option;
      continue;
    }
    const legacyKey = assignment.dimension_key || assignment.dimension;
    let dimension = knownDimension ||
      data.status_dimensions.find((candidate) => candidate.key === legacyKey) ||
      data.status_dimensions.find((candidate) =>
        candidate.order_index === assignment.dimension_index
      );
    if (!dimension && typeof legacyKey === "string") {
      dimension = data.status_dimensions.find((candidate) =>
        candidate.name === legacyKey
      );
    }
    let option = dimension
      ? data.status_options.find((candidate) =>
        candidate.dimension_id === dimension.id &&
        candidate.name === assignment.option
      )
      : null;
    if (!option && dimension && typeof assignment.option_key === "string") {
      option = data.status_options.find((candidate) =>
        candidate.dimension_id === dimension.id &&
        candidate.key === assignment.option_key
      );
    }
    if (!option && dimension && knownOption &&
      knownOption.dimension_id === dimension.id) {
      option = knownOption;
    }
    if (!option && dimension) {
      option = data.status_options
        .filter((candidate) => candidate.dimension_id === dimension.id)
        .sort((left, right) => left.order_index - right.order_index)[0];
    }
    if (!dimension || !option) {
      // Keep the row and let the canonical validator decide: silently dropping
      // a status assignment would lose work the user (or an older UI) wrote.
      repaired.push(assignment.id);
      continue;
    }
    assignment.dimension_id = dimension.id;
    assignment.option_id = option.id;
    delete assignment.dimension_key;
    delete assignment.option;
    delete assignment.dimension_index;
  }
  if (repaired.length) {
    // A row whose status table no longer exists cannot be repaired without
    // guessing; it is removed but reported so the user knows something was
    // dropped instead of losing it silently.
    data.status_assignments = data.status_assignments.filter((assignment) =>
      !repaired.includes(assignment.id)
    );
    data.__status_repair_dropped = repaired.length;
  }
  return data;
}

const bridge = new DesktopBridge();
const store = new WorkbenchStore(bridge);
store.assetPreview.setOnChange(() => store.notify());
/**
 * A preview that settles repaints its own card. `onChange` above stays as the
 * fallback the cache uses only for a key no frame can repaint.
 */
store.assetPreview.setOnPatch((key) => patchAssetPreviewFrames(key));
/** The asset preview cache resolves ids against the currently open project. */
bridge.currentProject = () => store.data;

let root = null;
try {
  root = globalThis.document?.querySelector?.("#app") ?? null;
} catch {
  root = null;
}

const views = createViews(store);

function patchMappingCount() {
  const count = root?.querySelector?.("[data-mapping-selection-count]");
  const items = store.ui.importMappingPlan?.items || [];
  if (count) {
    count.textContent = `已选 ${items.filter((item) => item.selected).length} / ${items.length} 项`;
  }
}

function patchMappingRow(relativePath) {
  if (!root || store.ui.route !== "mapping") return;
  const path = String(relativePath || "").replaceAll("\\", "/");
  const row = [...root.querySelectorAll("tr[data-mapping-row]")].find((candidate) =>
    candidate.dataset.rowKey === path
  );
  if (!row) return;
  const active = globalThis.document?.activeElement;
  const focusControl = active && row.contains(active)
    ? active.matches?.("[data-mapping-select]") ? "[data-mapping-select]"
    : active.matches?.("[data-mapping-destination]") ? "[data-mapping-destination]"
    : active.matches?.("[data-mapping-role]") ? "[data-mapping-role]"
    : ""
    : "";
  const template = globalThis.document?.createElement?.("tbody");
  if (!template || typeof views.mappingRowView !== "function") return;
  template.innerHTML = views.mappingRowView(path);
  const replacement = template.querySelector("tr[data-mapping-row]");
  if (!replacement) return;
  row.replaceWith(replacement);
  bindMappingRow(replacement);
  if (focusControl) replacement.querySelector(focusControl)?.focus?.({ preventScroll: true });
  root.querySelector(".mapping-error")?.remove?.();
  patchMappingCount();
}

function patchDocumentImportRow(relativePath) {
  if (!root) return;
  const path = String(relativePath || "").replaceAll("\\", "/");
  const row = [...root.querySelectorAll("[data-document-import-row]")].find((candidate) =>
    String(candidate.dataset.path || "").replaceAll("\\", "/") === path
  );
  const item = store.documentImportRow(path);
  if (!row || !item) return;
  const selected = item.selected === true;
  row.dataset.selected = selected ? "true" : "false";
  row.classList.toggle("deselected", !selected);
  const checkbox = row.querySelector("[data-document-import-select]");
  if (checkbox) checkbox.checked = selected;
  patchDocumentImportCount();
}

function patchDocumentImportRows() {
  if (!root) return;
  for (const row of root.querySelectorAll("[data-document-import-row]")) {
    const item = store.documentImportRow(row.dataset.path || "");
    if (!item) continue;
    const selected = item.selected === true;
    row.dataset.selected = selected ? "true" : "false";
    row.classList.toggle("deselected", !selected);
    const checkbox = row.querySelector("[data-document-import-select]");
    if (checkbox) checkbox.checked = selected;
  }
  patchDocumentImportCount();
}

function patchDocumentImportCount() {
  const count = root?.querySelector?.("[data-document-import-count]");
  const items = store.ui.documentImportDialog?.items || [];
  if (count) {
    count.textContent = `已选 ${items.filter((item) => item.selected === true).length} / ${items.length} 项`;
  }
}

let lastToast = "";
let toastTimer = 0;

/* ------------------------------------------------------------------ *
 * 渲染不打断输入。
 *
 * `render()` 用最新状态重建整个外壳，所以它必须对正在打字的人"不可见"：
 * 替换 DOM 之前记住焦点控件、光标位置和滚动位置，替换之后原样放回去。
 * 正在组字（IME）的控件绝不重建——渲染会排队到 compositionend。
 * 只影响外壳的变化（保存状态、状态栏、提示条）走 patchChrome()，根本
 * 不碰编辑器 DOM。
 * ------------------------------------------------------------------ */

/** The scroll containers that must keep their position across a render. */
const SCROLL_KEEP_SELECTORS = [
  ".center",
  ".right-content",
  ".left-lessons",
  ".grid-wrap",
  ".palette-results",
  ".asset-picker",
  ".issue-list",
];

let rendering = false;
let renderQueued = false;
let composingField = null;
let closeActiveBlockOverflowMenu = null;
let activeBlockOverflowMenu = null;
let pendingBlockOverflowFocus = null;
let pendingLayoutPageFocus = null;
/** Caret to put back into a block editor after a render that a compile caused. */
let pendingEditorCaret = null;
let pendingEditorActionBlur = null;

/** A stable selector for the control that currently has focus. */
function focusSelector(element) {
  if (!element || element.nodeType !== 1) return "";
  const dataset = element.dataset || {};
  if (dataset.focusKey) return `[data-focus-key="${dataset.focusKey}"]`;
  if (dataset.blockId) return `textarea[data-block-id="${dataset.blockId}"], input[data-block-id="${dataset.blockId}"]`;
  if (dataset.requirementNote) return `[data-requirement-note][data-id="${dataset.id || ""}"]`;
  if (dataset.assetSearch !== undefined) return "[data-asset-search]";
  if (dataset.explorerFilter !== undefined) return "[data-explorer-filter]";
  if (dataset.aiInstruction !== undefined) return "[data-ai-instruction]";
  if (dataset.lessonTitle !== undefined) return "[data-lesson-title]";
  if (dataset.action) {
    const selectorValue = (value) => String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    let selector = `[data-action="${selectorValue(dataset.action)}"]`;
    for (const key of ["id", "route", "mode", "panel", "type", "path", "projectId"]) {
      if (dataset[key] !== undefined) {
        const attribute = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        selector += `[data-${attribute}="${selectorValue(dataset[key])}"]`;
        break;
      }
    }
    return selector;
  }
  if (element.id) return `#${element.id}`;
  return "";
}

function rememberDialogReturnFocus(source) {
  if (!root?.dataset) return;
  const menuSummary = source?.closest?.(".asset-card-menu")?.querySelector?.("summary");
  const selector = focusSelector(menuSummary || source);
  if (selector) root.dataset.dialogReturnFocus = selector;
}

/**
 * Put the caret back where the user was typing after an auto-compile replaced
 * the block editor.  A compile that moves the caret is what makes a formatter
 * feel like it is fighting the user, so the offset is carried across the render
 * and clamped into the converted body.
 */
function restorePendingBlockCaret() {
  const request = pendingEditorCaret;
  pendingEditorCaret = null;
  if (!request) return;
  queueMicrotask(() => {
    const editor = root?.querySelector?.(
      `[data-rich-editor][data-block-id="${request.blockId}"]`,
    );
    if (editor) {
      focusTextOffset(editor, request.offset);
      return;
    }
    const field = root?.querySelector?.(`textarea[data-block-id="${request.blockId}"]`);
    if (!field) return;
    try {
      field.focus?.({ preventScroll: true });
      const at = Math.max(0, Math.min(request.offset ?? 0, String(field.value ?? "").length));
      field.setSelectionRange(at, at);
    } catch { /* focus is best effort: never break a render over it */ }
  });
}

function captureTypingState() {
  let active = null;
  try {
    active = globalThis.document?.activeElement ?? null;
  } catch {
    active = null;
  }
  if (!active) return null;
  try {
    if (typeof root.contains === "function" && !root.contains(active)) return null;
  } catch {
    return null;
  }
  const selector = focusSelector(active);
  if (!selector) return null;
  const state = { selector, value: null, start: null, end: null, direction: "none", baseline: null };
  if (typeof active.value === "string") state.value = active.value;
  if (typeof active.selectionStart === "number") {
    state.start = active.selectionStart;
    state.end = typeof active.selectionEnd === "number" ? active.selectionEnd : active.selectionStart;
    state.direction = active.selectionDirection || "none";
  }
  if (active.dataset && typeof active.dataset.editBaseline === "string") {
    state.baseline = active.dataset.editBaseline;
  }
  return state;
}

function restoreTypingState(state) {
  if (!state) return;
  const target = root.querySelector(state.selector);
  if (!target) return;
  // An unbound field (the AI provider form, the palette, a dialog input) keeps
  // its text only in the DOM node, so the typed value travels with the focus.
  if (state.value !== null && typeof target.value === "string" && target.value !== state.value) {
    target.value = state.value;
    if (state.baseline !== null && target.dataset) target.dataset.editBaseline = state.baseline;
  }
  rendering = true;
  try {
    target.focus?.({ preventScroll: true });
  } catch {
    try {
      target.focus?.();
    } catch { /* focus is best effort: never break a render over it */ }
  } finally {
    rendering = false;
  }
  if (state.start !== null && typeof target.setSelectionRange === "function") {
    try {
      target.setSelectionRange(state.start, state.end, state.direction);
    } catch { /* non-text inputs reject a range: keep the value */ }
  }
}

function captureScrollState() {
  const captured = [];
  for (const selector of SCROLL_KEEP_SELECTORS) {
    let nodes = [];
    try {
      nodes = [...root.querySelectorAll(selector)];
    } catch {
      nodes = [];
    }
    nodes.forEach((node, index) => {
      if (node.scrollTop || node.scrollLeft) {
        captured.push({ selector, index, top: node.scrollTop, left: node.scrollLeft });
      }
    });
  }
  return captured;
}

function restoreScrollState(captured) {
  for (const item of captured) {
    let node = null;
    try {
      node = root.querySelectorAll(item.selector)[item.index] ?? null;
    } catch {
      node = null;
    }
    if (!node) continue;
    node.scrollTop = item.top;
    node.scrollLeft = item.left;
  }
}

/** Where the last render put the viewport, so an unrelated render leaves it be. */
const lastScrolledTo = { requirement: null, block: null };

/**
 * Update only the chrome around the editor: save state, status bar, toast.
 * Autosave, typing and toast timers use this, so nothing they do can pull the
 * caret out of a text field.
 */
function patchChrome() {
  if (!root || rendering) return;
  try {
    const save = root.querySelector("[data-chrome-save]");
    if (save) {
      save.outerHTML = views.saveStateView();
      const updatedSave = root.querySelector("[data-chrome-save]");
      const verify = updatedSave?.querySelector?.('[data-action="verify-save-result"]');
      if (verify && verify.dataset.verifyActionBound !== "true") {
        verify.dataset.verifyActionBound = "true";
        verify.addEventListener("click", (event) => dispatchBoundAction(verify, event));
      }
    }
    const statusbar = root.querySelector("[data-chrome-statusbar]");
    if (statusbar) statusbar.outerHTML = views.statusbarView();
    const toast = root.querySelector("[data-chrome-toast]");
    if (toast) toast.innerHTML = views.toastView();
  } catch { /* chrome is advisory: never break an edit over it */ }
  scheduleToastDismissal();
}

/**
 * Repaint the frames that show one asset preview, in place.
 *
 * A settled preview used to go through `store.notify()`, which rebuilt the whole
 * window: every card lost its element identity, `observe()` registered all of
 * them again, a freshly observed target always gets an intersect record, and
 * that record started another read — which evicted another still-visible card
 * and re-rendered the screen. That is the loop that made the media library flip
 * between 正在读取 / 等待加载 / thumbnail. Rewriting just this frame takes the
 * rebuild out of the cycle, and the patched frame keeps its identity so the
 * observer never sees it as newly visible.
 */
function patchAssetPreviewFrames(key) {
  if (!root) return 0;
  let frames = [];
  try {
    frames = Array.from(root.querySelectorAll("[data-asset-preview-key]"));
  } catch {
    return 0;
  }
  let patched = 0;
  for (const frame of frames) {
    if (!frame || frame.getAttribute("data-asset-preview-key") !== key) continue;
    if (!frame.isConnected) continue;
    const asset = store.assetPreview.assetFor(key, frame);
    // A card whose file changed identity is not ours to patch: its key is stale
    // and only a real render can hand it the new one.
    if (!asset || store.assetPreview.keyFor(asset) !== key) continue;
    const surface = frame.getAttribute("data-asset-preview-surface") || "";
    const blockId = frame.getAttribute("data-block-id") || "";
    const block = blockId
      ? store.data.blocks.find((candidate) => candidate.id === blockId) || null
      : null;
    const inner = views.assetPreviewFrameInner(asset, surface, block);
    // null: this surface's markup belongs to somebody else (a Markdown image
    // inside a rich editor). The cache then falls back to a rebuild for it.
    if (inner === null) continue;
    stopPreviewMedia(frame);
    frame.innerHTML = inner;
    // Brand-new controls — 放大查看, 重试预览, the video play button — would
    // otherwise be the visible-but-dead-button bug this app has fought before.
    bindActionControls(frame);
    patched += 1;
  }
  return patched;
}

function render() {
  if (!root) return;
  if (rendering) {
    renderQueued = true;
    return;
  }
  if (composingField) {
    let stillComposing = false;
    try {
      stillComposing = typeof root.contains !== "function" || root.contains(composingField);
    } catch {
      stillComposing = false;
    }
    if (stillComposing) {
      // Never rebuild the DOM under an in-flight IME composition: the
      // candidate window would be dropped mid-word.
      renderQueued = true;
      patchChrome();
      return;
    }
    composingField = null;
  }
  const overflowFocus = pendingBlockOverflowFocus;
  pendingBlockOverflowFocus = null;
  const layoutPageFocus = pendingLayoutPageFocus;
  pendingLayoutPageFocus = null;
  const previousDialog = root.querySelector?.('[role="dialog"][aria-modal="true"]') || null;
  const dialogWasOpen = Boolean(previousDialog);
  const activeElement = globalThis.document?.activeElement || null;
  const dialogFocusSelector = previousDialog?.contains?.(activeElement)
    ? focusSelector(activeElement)
    : "";
  if (!dialogWasOpen && !root.dataset?.dialogReturnFocus && activeElement && root.contains?.(activeElement)) {
    const returnSelector = focusSelector(activeElement);
    if (returnSelector) root.dataset.dialogReturnFocus = returnSelector;
  }
  const dialogReturnFocus = String(root.dataset?.dialogReturnFocus || "");
  rendering = true;
  let typing = null;
  let scroll = [];
  try {
    typing = captureTypingState();
    scroll = captureScrollState();
    cancelActivePointerDrag?.();
    closeActiveBlockOverflowMenu?.();
    root.innerHTML = store.ui.screen === "launcher" ? views.launcherView() : views.shellView();
  } finally {
    rendering = false;
  }
  bindEvents();
  autosizeBlockFields();
  scheduleToastDismissal();
  restoreScrollState(scroll);
  // Observe AFTER the viewport is back where the user left it: registered
  // first, every frame would be judged against the pre-restore scroll position
  // and the first cards of the library would all read at once.
  store.assetPreview.observe(root);
  restoreTypingState(typing);
  const currentDialog = root.querySelector?.('[role="dialog"][aria-modal="true"]') || null;
  if (currentDialog) {
    const retainedFocus = dialogFocusSelector
      ? currentDialog.querySelector?.(dialogFocusSelector)
      : null;
    if (retainedFocus) {
      try { retainedFocus.focus?.({ preventScroll: true }); } catch { retainedFocus.focus?.(); }
    } else if (!currentDialog.contains?.(globalThis.document?.activeElement)) {
      const firstControl = currentDialog.querySelector?.(
        '[autofocus], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])',
      );
      try { (firstControl || currentDialog).focus?.({ preventScroll: true }); } catch { (firstControl || currentDialog).focus?.(); }
    }
  } else if (dialogWasOpen) {
    const pageTab = layoutPageFocus
      ? root.querySelector?.(`[data-action="select-layout-page"][data-id="${layoutPageFocus}"]`)
      : null;
    const returnTarget = dialogReturnFocus ? root.querySelector?.(dialogReturnFocus) : null;
    root.dataset.dialogReturnFocus = "";
    const target = pageTab || returnTarget || root.querySelector?.(".center");
    try { target?.focus?.({ preventScroll: true }); } catch { target?.focus?.(); }
  } else if (layoutPageFocus) {
    const pageTab = root.querySelector?.(`[data-action="select-layout-page"][data-id="${layoutPageFocus}"]`);
    try { pageTab?.focus?.({ preventScroll: true }); } catch { pageTab?.focus?.(); }
  }
  restorePendingBlockCaret();
  const fieldRequest = String(store.ui.focusField || "");
  if (fieldRequest) {
    store.ui.focusField = "";
    queueMicrotask(() => {
      const target = root.querySelector(`[data-focus-key="${fieldRequest}"]`);
      if (!target) return;
      try {
        target.focus?.();
        target.select?.();
      } catch { /* focus is best effort */ }
    });
  } else if (overflowFocus) {
    queueMicrotask(() => {
      const blocks = Array.from(root.querySelectorAll("article.block[data-block-id]") || []);
      const target = blocks.find((block) =>
        block.dataset?.blockId === overflowFocus.blockId
      ) || blocks[Math.min(overflowFocus.index, blocks.length - 1)];
      const summary = target?.querySelector?.("details.block-more > summary");
      const fallback = root.querySelector('[data-action="add-block"]');
      (summary || fallback)?.focus?.();
    });
  }
  // Only follow the pinned selection when it actually moved: re-centring the
  // page on every autosave is what made the editor jump while typing.
  const focused = store.ui.focusRequirementId || null;
  if (focused && focused !== lastScrolledTo.requirement) {
    lastScrolledTo.requirement = focused;
    queueMicrotask(() => root.querySelector(`[data-requirement-id="${focused}"]`)?.scrollIntoView({ block: "center" }));
  } else if (!focused) {
    lastScrolledTo.requirement = null;
  }
  const selected = store.ui.selectedBlockId || null;
  if (selected && store.ui.mode === "writing" && selected !== lastScrolledTo.block) {
    lastScrolledTo.block = selected;
    queueMicrotask(() => root.querySelector(`[data-block-id="${selected}"]`)?.scrollIntoView({ block: "nearest" }));
  } else if (!selected || store.ui.mode !== "writing") {
    lastScrolledTo.block = null;
  }
  if (renderQueued) {
    renderQueued = false;
    render();
  }
}

/**
 * An IME composition owns the field until it ends; a render that lands in the
 * middle of one is held back and replayed afterwards.
 */
function installEditorGuards() {
  const target = globalThis.document;
  if (!target || typeof target.addEventListener !== "function") return;
  let deferredRenderScheduled = false;
  let deferredEditField = null;
  const finishCompositionRender = (field) => {
    deferredEditField = field || deferredEditField;
    if (deferredRenderScheduled) return;
    deferredRenderScheduled = true;
    queueMicrotask(() => {
      deferredRenderScheduled = false;
      if (!renderQueued) {
        deferredEditField = null;
        return;
      }
      const editField = deferredEditField;
      deferredEditField = null;
      renderQueued = false;
      // Let the field's compositionend/input listeners serialize the committed
      // text before a queued render can detach it and lose the undo baseline.
      if (editField?.dataset?.editProperty === "text") {
        // Compose into one undo entry but let this guard perform the single
        // render after the composition event has reached its target listeners.
        flushPendingEdit(editField, { notify: false });
        render();
      } else if (editField?.dataset?.editProperty) {
        const historyBefore = store.history.length;
        flushPendingEdit(editField);
        // A changed title commits through store.notify(), which already renders.
        if (store.history.length === historyBefore) render();
      } else render();
    });
  };
  const owns = (node) => {
    try {
      return Boolean(node) && (typeof root?.contains !== "function" || root.contains(node));
    } catch {
      return false;
    }
  };
  target.addEventListener("compositionstart", (event) => {
    if (owns(event.target)) composingField = event.target;
  }, true);
  target.addEventListener("compositionend", (event) => {
    if (event.target === composingField) composingField = null;
    if (renderQueued) finishCompositionRender(event.target);
  }, true);
  // Leaving the field ends the deferred render as well (a modal may have closed
  // or the field may have been removed while composing).
  target.addEventListener("focusout", (event) => {
    if (event.target === composingField) composingField = null;
    if (renderQueued) finishCompositionRender(event.target);
  }, true);
}

/* ------------------------------------------------------------------ *
 * DOM binding.  Selection changes render; text edits do not, so the
 * caret and IME composition survive until the field loses focus.
 * ------------------------------------------------------------------ */

const TEXT_FIELD_SELECTOR = "textarea[data-block-id], input[data-block-id]";

/** How long a paused keystroke counts as a finished edit before compiling. */
const BLOCK_COMPILE_IDLE_MS = 600;

/**
 * P2-2: a block frame is the only size container, so the textarea inside it
 * must grow to its content and let the frame scroll.  Without this the frame
 * would clip the text at its tier ceiling with no way to reach the rest.
 */
function autosizeBlockFields(scope = root) {
  for (const field of scope.querySelectorAll("textarea[data-block-id]")) {
    try {
      field.style.height = "auto";
      const measured = Math.max(41, field.scrollHeight);
      field.style.height = `${measured}px`;
      // The tier is what gives the frame its ceiling, and text edits do not
      // re-render (the caret must survive), so the class is refreshed here from
      // the laid-out field: growth steps up, shrinking steps back down, and the
      // frame itself stays the only scroll container.
      const frame = field.closest?.("article.block[data-block-id]");
      if (!frame) continue;
      const style = typeof getComputedStyle === "function"
        ? getComputedStyle(field)
        : null;
      const lineHeight = Number.parseFloat(style?.lineHeight || "") || 24;
      const lines = Math.max(1, Math.round(measured / lineHeight));
      const kind = frame.classList?.contains("block-kind-short") ? "short" : "long";
      const tier = blockSizeTierForLines(kind, lines);
      for (const name of ["small", "medium", "large"]) {
        frame.classList?.toggle(`block-size-${name}`, name === tier);
      }
      if (frame.dataset) frame.dataset.blockSize = tier;
    } catch { /* measuring is best effort; the frame still scrolls */ }
  }
}

function flushPendingEdit(element, { notify = true, convert = false, structuralOnly = false } = {}) {
  if (!element) return;
  // A render detaches the field and browsers may report that as a blur.  The
  // pending value is already in canonical data; the history entry is recorded
  // when the user really leaves the field.
  if (rendering) return;
  const block = store.data.blocks.find((candidate) => candidate.id === element.dataset.blockId);
  if (!block) return;
  const scope = element.dataset.editProperty;
  if (scope === "text") {
    // The input listener already wrote the value into canonical data, so the
    // history entry is recorded from the value typing started from.
    const baseline = element.dataset.editBaseline;
    const value = element.isContentEditable || element.dataset.richEditor === "true"
      ? markdownFromEditable(element)
      : element.value;
    // Structural Markdown becomes a structural block only at a stable edit
    // boundary, and never while a composition is in flight.
    // Do not reinterpret an existing escaped list (or any other Markdown) just
    // because the user focused the editor and left without changing it.
    const changedDuringFocus = editorValueChangedSinceBaseline(value, baseline);
    const retype = convert && changedDuringFocus && element.dataset.richEditor === "true"
      ? structuralConversion(value, {
        type: block.type,
        level: block.settings?.level ?? null,
      })
      : null;
    // Pausing mid-sentence is not a reason to redraw the block the user is
    // typing in, so an idle probe commits only when it found a real conversion.
    if (structuralOnly && (!retype || retype.deferUntilBlur)) return;
    const caretBefore = retype && !retype.deferUntilBlur ? caretTextOffset(element) : null;
    if (retype && caretBefore !== null) {
      // Recording the edit renders synchronously, so the caret has to be queued
      // before it: a request written after the redraw is only ever read by the
      // next one, which leaves the user typing into a detached field.
      pendingEditorCaret = {
        blockId: element.dataset.blockId,
        offset: Math.max(0, caretBefore - retype.offsetLoss),
      };
    }
    store.recordBlockTextEdit(
      element.dataset.blockId,
      typeof baseline === "string" ? baseline : block.content,
      value,
      { notify, retype },
    );
  } else if (scope === "title") {
    store.renameLesson(block.id, element.value);
  }
  delete element.dataset.editBaseline;
}

function actionTargetFromEditorBlur(event) {
  const related = event?.relatedTarget;
  const action = related?.dataset?.action ? related : related?.closest?.("[data-action]");
  if (!action || action.disabled || action.getAttribute?.("aria-disabled") === "true") return null;
  return action;
}

function flushEditorBeforeAction(actionElement, { notify = false } = {}) {
  const pending = pendingEditorActionBlur?.actionElement === actionElement
    ? pendingEditorActionBlur
    : null;
  const editor = pending?.editor || globalThis.document?.activeElement;
  const hasEditBaseline = typeof editor?.dataset?.editBaseline === "string";
  if (!editor || !hasEditBaseline || composingField === editor) return false;
  if (pending) pendingEditorActionBlur = null;
  flushPendingEdit(editor, { notify, convert: true });
  return true;
}

function deferEditorBlurUntilAction(editor, event) {
  const actionElement = actionTargetFromEditorBlur(event);
  if (!actionElement || composingField === editor) return false;
  if (pendingEditorActionBlur && pendingEditorActionBlur.actionElement !== actionElement) {
    flushEditorBeforeAction(pendingEditorActionBlur.actionElement, { notify: true });
  }
  pendingEditorActionBlur = { editor, actionElement };
  return true;
}

function dispatchBoundAction(element, event) {
  const actionDataset = { ...element.dataset };
  const action = actionDataset.action;
  const flushedEditor = flushEditorBeforeAction(element);
  // flushEditorBeforeAction suppresses its render until this action has been
  // dispatched, keeping the original control and its captured data available.
  Object.assign(element.dataset, actionDataset);
  handleAction(action, element, event);
  if (flushedEditor && element.isConnected) render();
}

/**
 * Stop and reset the media mounted in the open preview modal, so a GIF or video
 * cannot keep playing behind a surface that is already gone (§12.4).
 */
function stopMediaPreview() {
  const modal = root.querySelector(".asset-media-preview-modal");
  stopPreviewMedia(modal);
  modal?.querySelectorAll?.("img[data-animated-preview]").forEach((image) =>
    image.removeAttribute("src")
  );
}
function openDeleteConfirmation(action, id, source = null) {
  const key = String(id || "");
  if (!key) return;
  let target;
  let title;
  let description;
  switch (action) {
    case "delete-stage": {
      target = store.data.stages.find((stage) => stage.id === key);
      if (!target) return;
      const lessonCount = store.data.content_items.filter((item) => item.stage_id === key && !item.archived).length;
      if (lessonCount) {
        store.ui.toast = `这个阶段还有 ${lessonCount} 节课，请先移动课程。`;
        store.notify();
        return;
      }
      title = `删除阶段「${target.title}」？`;
      description = "这个阶段为空。删除后可以使用撤销恢复。";
      break;
    }
    case "delete-lesson": {
      target = store.data.content_items.find((item) => item.id === key);
      if (!target) return;
      const lesson = lessonView(store.data, key)?.lesson;
      title = `删除课程「${target.title}」？`;
      description = `将移除本课的 ${lesson?.block_count || 0} 个正文区块、${lesson?.gaps.total || 0} 项待补、排版与发布记录；素材文件保留在媒体库。可以撤销恢复。`;
      break;
    }
    case "delete-page": {
      target = store.layoutPages().find((page) => page.id === key);
      if (!target || store.layoutPages().length <= 1) return;
      const count = store.data.placements.filter((placement) => placement.page_id === key).length;
      title = `删除页面「${target.title}」的排版？`;
      description = `${count ? `其中 ${count} 块正文会回到未放置列表。` : ""}正文、素材和其他页面不会删除。可以撤销恢复。`;
      break;
    }
    case "delete-section": {
      target = store.data.layout_sections.find((section) => section.id === key);
      if (!target) return;
      const count = store.data.placements.filter((placement) => placement.section_id === key).length;
      title = `删除分区「${target.name}」？`;
      description = `${count ? `其中 ${count} 块内容会回到「未分区」。` : ""}正文不会被删除，可以撤销恢复。`;
      break;
    }
    case "delete-asset": {
      target = store.data.assets.find((asset) => asset.id === key && !asset.archived);
      if (!target) return;
      const usages = usagesForAsset(store.data, key).length;
      title = `从项目中删除素材「${target.filename}」？`;
      description = `将解除 ${usages} 处正文或待补引用并从媒体库移除；assets/ 中的磁盘文件保留。可以撤销恢复项目状态。`;
      break;
    }
    case "delete-block": {
      target = store.data.blocks.find((block) => block.id === key);
      if (!target) return;
      const requirementCount = store.data.requirements.filter((requirement) => requirement.anchor_block_id === key).length;
      title = `删除${blockLabel(target.type)}区块？`;
      description = `将移除正文内容、画布放置和 ${requirementCount} 项锚定待补；素材本身仍保留在媒体库。可以撤销恢复。`;
      break;
    }
    case "delete-requirement": {
      target = store.data.requirements.find((requirement) => requirement.id === key);
      if (!target) return;
      title = "删除这项待补？";
      description = target.anchor_block_id
        ? "这会解除待补与正文位置的关联；如果位置是专用占位区块，该区块也会删除。可以撤销恢复。"
        : "这会从项目中移除此项待补。可以撤销恢复。";
      break;
    }
    default:
      return;
  }
  rememberDialogReturnFocus(source);
  store.ui.pendingDeleteConfirmation = { action, id: key, title, description };
  store.notify();
}

function confirmPendingDelete() {
  const pending = store.ui.pendingDeleteConfirmation;
  if (!pending) return;
  store.ui.pendingDeleteConfirmation = null;
  switch (pending.action) {
    case "delete-stage":
      store.ui.confirmDeleteStage = pending.id;
      store.deleteStage(pending.id);
      break;
    case "delete-lesson":
      store.ui.confirmDeleteLesson = { id: pending.id, blockers: [] };
      store.deleteLesson(pending.id);
      break;
    case "delete-asset":
      store.ui.confirmDeleteAssetId = pending.id;
      store.deleteAsset(pending.id);
      break;
    case "delete-block":
      store.deleteBlock(pending.id);
      break;
    case "delete-requirement":
      store.deleteRequirement(pending.id);
      break;
    case "delete-page":
      store.deletePage(pending.id);
      break;
    case "delete-section":
      store.deleteSection(pending.id);
      break;
  }
}

function handleAction(action, element, event) {
  if (element.closest?.(".block-more-menu")) {
    const source = activeBlockOverflowMenu?.details.closest?.("article.block");
    const blockId = String(source?.dataset?.blockId || element.dataset.id || "");
    if (blockId) {
      const blocks = Array.from(root.querySelectorAll("article.block[data-block-id]") || []);
      const index = blocks.findIndex((block) => block.dataset?.blockId === blockId);
      pendingBlockOverflowFocus = { blockId, index: Math.max(0, index) };
    }
  }
  switch (action) {
    case "close-overlay":
      stopMediaPreview();
      store.releaseAssetViewerSource();
      store.cancelPreflight();
      store.ui.palette = store.ui.capture = store.ui.preflight = store.ui.snapshot = false;
      store.ui.assetPicker = null;
      store.ui.assetImagePreviewId = null;
      store.notify();
      return;
    case "open-asset-image": {
      const modal = root.querySelector(".asset-media-preview-modal");
      stopPreviewMedia(modal);
      modal?.querySelectorAll?.("img[data-animated-preview]").forEach((image) =>
        image.removeAttribute("src")
      );
      const asset = store.data.assets.find((candidate) =>
        candidate.id === element.dataset.asset && !candidate.archived
      );
      if (!asset) return;
      rememberDialogReturnFocus(element);
      void store.openAssetViewer(asset.id);
      return;
    }
    case "play-asset-video":
    case "play-explorer-video": {
      const video = element.closest(".asset-video-stage, .explorer-media-card")
        ?.querySelector("video");
      if (!video) return;
      const playButton = video.parentElement?.querySelector(".asset-video-play");
      const syncPlayButton = () => {
        if (playButton) playButton.style.display = video.paused ? "flex" : "none";
      };
      if (playButton && !playButton.dataset.playStateBound) {
        video.addEventListener("playing", syncPlayButton);
        video.addEventListener("pause", syncPlayButton);
        video.addEventListener("ended", syncPlayButton);
        playButton.dataset.playStateBound = "true";
      }
      void video.play().then(syncPlayButton).catch(() => {
        syncPlayButton();
        store.say("视频无法播放，请检查编码格式或文件内容。");
      });
      return;
    }
    case "retry-asset-preview":
      void store.assetPreview.retry(element.dataset.asset);
      return;
    case "enter-project": store.enterProject(); return;
    case "return-launcher": store.returnToLauncher(); return;
    case "open-registry-project": void store.openRegistryProject(element.dataset.projectPath); return;
    case "relocate-registry-project": void store.relocateRegistryProject(element.dataset.projectId); return;
    case "remove-registry-project":
      void store.removeRegistryProject(element.dataset.projectId, element.dataset.projectPath);
      return;
    case "registry-copy-dismiss":
      store.ui.registryCopy = null;
      store.notify();
      return;
    case "registry-copy-update-location": void store.resolveRegistryCopy("relocate"); return;
    case "registry-copy-keep-both": void store.resolveRegistryCopy("both"); return;
    case "new-project": void (store.bridge.isNative() ? store.newProjectFromPicker() : store.newProject()); return;
    case "pick-seed": store.pickSeed(element.dataset.type); return;
    case "cancel-seed": store.cancelSeed(); return;
    case "build-blueprint": void store.startSeed(); return;
    case "confirm-blueprint": store.confirmBlueprint(element.dataset.id); return;
    case "discard-blueprint":
      store.commit("放弃课程草稿", (data) => {
        const draft = (data.blueprint_drafts || []).find((candidate) => candidate.id === element.dataset.id);
        if (draft) draft.status = "discarded";
      });
      return;
    case "open-file": if (store.bridge.isNative()) void store.selectAndImportAsset(); else root.querySelector("[data-project-file]")?.click(); return;
    case "open-project-dir": void store.openProjectFromPicker(); return;
    case "import-folder": void store.importExistingFolderFromPicker(); return;
    case "dismiss-project-problem": store.dismissProjectProblem(); return;
    case "retry-locked-project": void store.retryLockedProjectOpen(); return;
    case "reimport-project-folder": void store.reimportProjectProblemFolder(); return;
    case "confirm-reimport-project-folder": void store.reimportProjectProblemFolder({ replaceInvalid: true }); return;
    case "append-files": void store.importSelectedFilesFromPicker(); return;
    case "append-folder": void store.importExistingFolderFromPicker("append"); return;
    case "explorer-select": void store.selectExplorerEntry(element.dataset.path || ""); return;
    case "explorer-toggle":
      event.stopPropagation();
      store.toggleExplorerExpanded(element.dataset.path || "");
      return;
    case "import-folder-again": void store.importExistingFolderFromPicker(); return;
    case "open-import-mapping": store.openImportMappingPreview(); return;
    case "confirm-import-mapping": store.confirmImportMapping(element); return;
    // §18 — the body-document dialog opened from a confirmed plan.
    case "document-import-all": store.setAllDocumentImportSelected(true); return;
    case "document-import-none": store.setAllDocumentImportSelected(false); return;
    case "document-import-retry": void store.retryDocumentImportScan(); return;
    case "document-import-confirm": void store.confirmDocumentImportSelection(); return;
    case "document-import-cancel": store.cancelDocumentImportSelection(); return;
    case "retry-open-adopted-project": void store.retryOpenAdoptedProject(); return;
    case "apply-folder-adoption": void store.applyFolderAdoption(); return;
    case "toggle-left": store.ui.leftCollapsed = !store.ui.leftCollapsed; store.scheduleSessionSave(); store.notify(); return;
    case "toggle-right": store.ui.rightCollapsed = !store.ui.rightCollapsed; store.scheduleSessionSave(); store.notify(); return;
    case "route": {
      const nextRoute = String(element.dataset.route || "");
      const previousRoute = store.ui.route;
      if (nextRoute !== previousRoute) {
        store.cancelPreflight({ clearContext: true });
        store.cancelActiveExport();
        store.releaseAssetViewerSource();
        stopPreviewMedia(root);
        root.querySelectorAll?.("img[data-animated-preview]").forEach((image) =>
          image.removeAttribute("src")
        );
        store.ui.assetImagePreviewId = null;
        if (previousRoute === "mapping" && nextRoute !== "mapping") {
          store.closeMappingPreview();
        }
        if (previousRoute === "explorer") store.clearExplorerPreview();
        store.ui.route = nextRoute;
        store.scheduleSessionSave();
        if (nextRoute === "versions") void store.refreshSnapshots();
        if (nextRoute === "explorer" && store.ui.explorerSelected) {
          void store.selectExplorerEntry(store.ui.explorerSelected);
        } else store.notify();
      }
      return;
    }
    case "explorer-retry":
      if (store.ui.explorerSelected) void store.selectExplorerEntry(store.ui.explorerSelected);
      return;
    case "open-workbench": store.openWorkbench(); return;
    case "open-item": store.openItem(element.dataset.id); return;
    case "prev-lesson": store.navigateLesson("previous"); return;
    case "next-lesson": store.navigateLesson("next"); return;
    case "rename-lesson": {
      store.startLessonTitleEdit(element.dataset.id, element.dataset.titleSurface || "map");
      return;
    }
    case "add-stage": store.addStage(); return;
    case "rename-stage": {
      store.startStageTitleEdit(element.dataset.id);
      return;
    }
    case "move-stage": store.moveStage(element.dataset.id, element.dataset.direction); return;
    case "delete-stage": openDeleteConfirmation(action, element.dataset.id, element); return;
    case "move-lesson": store.moveLesson(element.dataset.id, element.dataset.direction); return;
    case "toggle-stage-collapse": store.toggleStageCollapse(element.dataset.id); return;
    case "locate-current-lesson": store.locateCurrentLesson(); return;
    case "select-project-properties": store.selectPropertyTarget("project"); return;
    case "select-stage-properties": store.selectPropertyTarget("stage", element.dataset.id); return;
    case "delete-lesson": openDeleteConfirmation(action, element.dataset.id, element); return;
    case "close-tab": {
      event.stopPropagation();
      const id = element.dataset.id;
      store.tabs = store.tabs.filter((tab) => tab.content_item_id !== id || tab.pinned);
      if (store.ui.activeId === id) {
        const next = store.tabs.at(-1);
        store.ui.selectedBlockId = null;
        store.ui.focusRequirementId = null;
        if (next) store.openItem(next.content_item_id);
        else { store.ui.activeId = null; store.ui.route = "map"; store.notify(); }
      }
      store.scheduleSessionSave();
      store.notify();
      return;
    }
    case "mode": store.setMode(element.dataset.mode); return;
    case "preview": store.setMode("preview"); store.ui.route = "editor"; store.scheduleSessionSave(); store.notify(); return;
    case "undo": store.undo(); return;
    case "redo": store.redo(); return;
    case "save-project": void store.flush(); return;
    case "verify-save-result": void store.verifyUncertainMutation(); return;
    case "external-reload": void store.resolveExternalConflict("reload"); return;
    case "external-merge": void store.resolveExternalConflict("merge"); return;
    case "external-keep-local": void store.resolveExternalConflict("keep-local"); return;
    case "recovery-restore": void store.resolvePendingRecovery("restore"); return;
    case "recovery-discard": void store.resolvePendingRecovery("discard"); return;
    case "save-version":
      store.ui.snapshot = true;
      store.ui.palette = false;
      store.ui.focusField = "snapshot-name";
      store.notify();
      return;
    case "submit-snapshot": store.saveVersion(root.querySelector("[data-snapshot-name]")?.value, root.querySelector("[data-snapshot-note]")?.value); return;
    case "refresh-snapshots": void store.refreshSnapshots(); return;
    case "restore-version": void store.restoreVersion(element.dataset.id); return;
    case "right-panel": store.ui.rightPanel = element.dataset.panel; store.ui.rightCollapsed = false; store.scheduleSessionSave(); if (store.ui.rightPanel === "versions") void store.refreshSnapshots(); else store.notify(); return;
    case "insert-block":
      // A placeholder must always carry a Requirement, never just a block.
      // Media opens the shared picker; insertAsset performs the mutation.
      if (element.dataset.type === "placeholder") store.addPlaceholder("text");
      else store.addBlock(element.dataset.type);
      return;
    case "insert-block-below": store.addBlock("paragraph", "", blocksIndexOf(element.dataset.id) + 1); return;
    case "add-block": store.addBlock("paragraph"); return;
    case "add-heading": store.addBlock("heading"); return;
    case "add-block-below": store.addBlock("paragraph", "", blocksIndexOf(element.dataset.id) + 1); return;
    case "select-block": store.selectBlock(element.dataset.id, { mode: "writing" }); return;
    case "flow-select-block":
      lastScrolledTo.block = null;
      store.ui.route = "editor";
      store.selectBlock(element.dataset.id, { mode: "writing", force: true, openStatus: false });
      return;
    case "clear-block-selection": store.ui.selectedBlockId = null; store.scheduleSessionSave(); store.notify(); return;
    case "add-placeholder": store.addPlaceholder("text"); return;
    case "add-requirement-text": store.addPlaceholder("text"); return;
    case "add-requirement-image": store.addPlaceholder("image"); return;
    case "focus-requirement": store.focusRequirement(element.dataset.id); return;
    case "edit-requirement": store.ui.editingRequirementId = element.dataset.id; store.ui.rightPanel = "requirements"; store.notify(); return;
    case "cancel-requirement-edit": store.ui.editingRequirementId = null; store.notify(); return;
    case "save-requirement": {
      const id = element.dataset.id;
      const note = root.querySelector(`[data-requirement-note][data-id="${id}"]`)?.value ?? "";
      const type = root.querySelector(`[data-requirement-type][data-id="${id}"]`)?.value;
      const priority = root.querySelector(`[data-requirement-priority][data-id="${id}"]`)?.value;
      store.updateRequirement(id, { note, type, priority });
      return;
    }
    case "resolve-requirement": store.resolveRequirement(element.dataset.id); return;
    case "reopen-requirement": store.setRequirementStatus(element.dataset.id, "open"); return;
    case "delete-requirement": openDeleteConfirmation(action, element.dataset.id, element); return;
    case "pick-asset-for-requirement": store.ui.assetPicker = { requirementId: element.dataset.id }; store.notify(); return;
    case "pick-asset-for-block": store.ui.assetPicker = { blockId: element.dataset.id }; store.notify(); return;
    case "pick-asset-import": store.ui.assetPicker = null; if (store.bridge.isNative()) void store.selectAndImportAsset(); else root.querySelector("[data-project-file]")?.click(); return;
    case "choose-asset": void store.insertAsset(element.dataset.id); return;
    case "insert-asset": void store.insertAsset(element.dataset.id); return;
    case "detach-asset": store.detachAsset(element.dataset.id, element.dataset.asset); return;
    case "delete-asset": openDeleteConfirmation(action, element.dataset.id, element); return;
    case "rename-asset":
      rememberDialogReturnFocus(element);
      store.startAssetRename(element.dataset.id);
      return;
    case "cancel-rename-asset": store.cancelAssetRename(); return;
    case "confirm-rename-asset": {
      const input = root.querySelector("[data-asset-title]");
      const assetId = store.ui.editingAssetId || element.dataset.id;
      if (assetId && input) void store.renameAsset(assetId, input.value);
      return;
    }
    case "show-asset-usage": store.ui.assetUsageId = element.dataset.id; store.ui.rightPanel = "media"; store.notify(); return;
    case "hide-asset-usage": store.ui.assetUsageId = null; store.notify(); return;
    case "focus-usage": {
      const contentItemId = element.dataset.id;
      const blockId = element.dataset.block;
      if (blockId) store.ui.selectedBlockId = blockId;
      store.openItem(contentItemId);
      if (blockId) { store.ui.selectedBlockId = blockId; store.notify(); }
      return;
    }
    case "move-block": store.moveBlock(element.dataset.id, element.dataset.direction); return;
    case "delete-block": openDeleteConfirmation(action, element.dataset.id, element); return;
    case "delete-confirm-cancel":
      store.ui.pendingDeleteConfirmation = null;
      store.notify();
      return;
    case "delete-confirm-accept":
      confirmPendingDelete();
      return;
    case "layout-mode": store.setLayoutMode(element.dataset.layoutMode); return;
    case "toggle-pagination-edit":
      store.togglePaginationEditing();
      return;
    case "pagination-conversion": store.beginPaginationConversion(); return;
    case "cancel-pagination-conversion": store.cancelPaginationConversion(); return;
    case "confirm-pagination-conversion": store.confirmPaginationConversion(); return;
    case "conversion-page-size": store.setPageSizePreview(element.value); return;
    case "page-size-preview": store.changePageSize(element.value); return;
    case "confirm-page-size": store.confirmPageSizeChange(); return;
    case "cancel-page-size": store.cancelPageSizeChange(); return;
    case "page-add": store.addLayoutPage(); return;
    case "select-layout-page": store.selectLayoutPage(element.dataset.id); return;
    case "page-rename": {
      const page = store.layoutPages().find((candidate) => candidate.id === element.dataset.id);
      if (!page) return;
      const title = globalThis.prompt?.("重命名页面", page.title);
      if (typeof title === "string") store.renamePage(page.id, title);
      return;
    }
    case "page-reorder": store.movePage(element.dataset.id, element.dataset.direction); return;
    case "page-duplicate": store.duplicatePage(element.dataset.id); return;
    case "page-delete": openDeleteConfirmation("delete-page", element.dataset.id, element); return;
    case "start-page-move": store.startPageMove(element.dataset.id); return;
    case "choose-page-move-target": store.choosePageMoveTarget(element.dataset.id); return;
    case "move-placement-page-cell": store.movePlacementAcrossPage(
      element.dataset.id,
      element.dataset.pageId,
      Number(element.dataset.row),
      Number(element.dataset.col),
    ); return;
    case "cancel-page-move": store.cancelPageMove(); return;
    case "layout-zoom": store.setLayoutZoom(element.dataset.zoom); return;
    case "create-layout": store.createLayout("grid"); return;
    case "rename-layout": {
      const layout = store.layout();
      if (!layout) return;
      const next = globalThis.prompt?.("重命名排版版本", layout.name);
      if (typeof next === "string") store.renameLayout(next);
      return;
    }
    case "grid-toggle-edit": store.ui.gridEditing = !store.ui.gridEditing; store.notify(); return;
    case "grid-add-col": store.changeGrid("column", 1); return;
    case "grid-add-row": store.changeGrid("row", 1); return;
    case "grid-remove-col": store.changeGrid("column", -1); return;
    case "grid-remove-row": store.changeGrid("row", -1); return;
    case "edit-project-title": store.editProjectTitle(element.dataset.titleSurface); return;
    case "grid-new-section": store.addSection(); return;
    case "rename-section": store.startSectionRename(element.dataset.id); return;
    case "delete-section": openDeleteConfirmation("delete-section", element.dataset.id, element); return;
    case "place-block": store.placeBlock(element.dataset.id); return;
    case "unplace-block": store.unplaceBlock(element.dataset.id); return;
    case "grid-autofill": store.autofillGrid(); return;
    case "move-placement": store.movePlacement(element.dataset.id, Number(element.dataset.dr) || 0, Number(element.dataset.dc) || 0); return;
    case "grid-start-move": store.startMovePlacement(element.dataset.id); return;
    case "grid-cancel-move": store.cancelMovePlacement(); return;
    case "grid-move-to":
      // The cell the block already sits in is marked `data-current` rather than
      // `disabled` (a disabled control swallows the pointer, Item 14 §15.3), so
      // the no-op has to live here: mouse clicks never reach it (CSS
      // `pointer-events: none` lets them fall through to the block underneath),
      // but keyboard activation still arrives and must not pretend to move.
      if (element?.dataset?.current === "true") return;
      store.movePlacementTo(
        element.dataset.id,
        Number(element.dataset.row) || 0,
        Number(element.dataset.col) || 0,
      );
      return;
    case "resize-placement": store.resizePlacement(element.dataset.id, Number(element.dataset.dw) || 0, Number(element.dataset.dh) || 0); return;
    // A dialog that opens without the caret swallows the first thing the user
    // types.  Every overlay names its field through `data-focus-key`, so the
    // opener has to ask for it.
    case "capture":
      store.ui.capture = true;
      store.ui.palette = false;
      store.ui.focusField = "capture";
      store.notify();
      return;
    case "submit-capture": {
      const value = root.querySelector("[data-capture-input]")?.value.trim();
      if (value) store.captureToInbox(value, value.slice(0, 32));
      store.ui.capture = false;
      store.ui.route = "inbox";
      store.notify();
      return;
    }
    case "palette":
      store.ui.palette = true;
      store.ui.paletteIndex = 0;
      store.ui.capture = false;
      store.ui.focusField = "palette";
      store.notify();
      return;
    case "palette-run": {
      const sub = element.dataset.paletteAction;
      store.ui.palette = false;
      if (sub === "route") {
        store.ui.route = element.dataset.route;
        if (store.ui.route === "versions") void store.refreshSnapshots();
      }
      else if (sub === "open-workbench") {
        store.openWorkbench();
        return;
      }
      else if (sub === "open-item") store.openItem(element.dataset.id);
      else if (sub === "focus-requirement") store.focusRequirement(element.dataset.id);
      else if (sub === "save-version") {
        store.ui.snapshot = true;
        store.ui.focusField = "snapshot-name";
      }
      else if (sub === "capture") store.ui.capture = true;
      else if (sub === "missing-media") {
        const target = store.map().lessons.find((lesson) => lesson.progress.missing_media > 0);
        if (target) store.openItem(target.id);
        else store.ui.toast = "没有缺少素材的课程。你可以继续编辑或开始导出。";
      }
      store.scheduleSessionSave();
      store.notify();
      return;
    }
    case "triage-inbox": store.triageInbox(element.dataset.id); return;
    case "assetize-inbox": void store.assetizeInbox(element.dataset.id); return;
    case "ignore-inbox": store.ignoreInbox(element.dataset.id); return;
    // AI workflow.  These handlers only touch `ui.ai*` state (plus the
    // canonical AI rows, through commit), so they never move the reader
    // position, the editor mode or the current selection.
    case "ai-scope": store.aiSetScope(element.dataset.scope); return;
    case "ai-toggle-context": store.aiToggleContext(element.dataset.key); return;
    case "ai-toggle-changes": store.aiToggleChanges(); return;
    case "ai-preview-context": store.aiPreviewContext(); return;
    case "ai-run": void store.aiRun(); return;
    case "ai-cancel": void store.aiCancel(); return;
    case "ai-close-result": store.ui.aiResult = null; store.notify(); return;
    case "ai-open-draft":
    case "ai-open-diff": {
      store.aiOpenDraft(element.dataset.id);
      return;
    }
    case "ai-apply-draft": store.aiApplyDraft(element.dataset.id); return;
    case "ai-reject-draft": store.aiRejectDraft(element.dataset.id); return;
    case "ai-dismiss-draft": store.aiDismissDraft(); return;
    case "ai-toggle-executions":
      store.ui.aiExecutionsOpen = !store.ui.aiExecutionsOpen;
      store.notify();
      return;
    case "ai-refresh-executions": void store.aiLoadExecutions(); return;
    case "ai-edit-provider": store.aiEditProvider(element.dataset.id); return;
    case "ai-edit-connection":
      store.aiEditProvider(element.dataset.id, { preserveSelection: true });
      return;
    case "ai-use-provider": store.aiSetProvider(element.dataset.id); return;
    case "ai-create-connection": store.aiCreateConnection(); return;
    case "ai-delete-connection": void store.aiDeleteConnection(element.dataset.id); return;
    case "ai-toggle-settings":
      if (!store.ui.aiSettingsOpen) rememberDialogReturnFocus(element);
      store.aiToggleSettings();
      return;
    case "ai-close-settings": store.aiCloseSettings(); return;
    case "ai-settings-backdrop": store.aiCloseSettings(); return;
    case "ai-subscription-start": void store.aiSubscriptionStart(element.dataset.id || ""); return;
    case "ai-subscription-cancel": void store.aiSubscriptionCancel(); return;
    case "ai-subscription-logout": void store.aiSubscriptionLogout(element.dataset.id || ""); return;
    case "ai-test-connection": void store.aiTestConnection(); return;
    case "ai-save-provider": {
      const read = (selector) => root.querySelector(selector)?.value ?? "";
      // The model actually used is the manual Model ID when filled, otherwise
      // the one chosen from the discovered list.  Both are real user input;
      // neither comes from a hardcoded table in the app.
      const manual = read("[data-ai-model-manual]").trim();
      const chosen = manual || String(store.ui.aiChosenModel || "").trim();
      // §9.6: the connection owns exactly the models the user added to the
      // catalog, plus whatever they are typing right now.
      const models = [...new Set([
        ...((Array.isArray(store.ui.aiProviderForm?.models) ? store.ui.aiProviderForm.models : [])
          .map((model) => String(model || "").trim())
          .filter(Boolean)),
        chosen,
      ].filter(Boolean))];
      void store.aiSaveProvider({
        // The typed id wins: a save that lands before the field's change event
        // would otherwise write the placeholder id the form was opened with.
        id: read("[data-ai-provider-id]").trim() ||
          store.ui.aiProviderForm?.id || store.ui.aiProviderId,
        label: read("[data-ai-provider-label]"),
        base_url: read("[data-ai-base-url]"),
        api_protocol: read("[data-ai-api-protocol]") || "openai-completions",
        default_model: chosen,
        models,
      });
      return;
    }
    case "ai-discover-models": void store.aiDiscoverModels(); return;
    case "ai-pick-model": store.aiPickModel(element.dataset.id); return;
    case "ai-toggle-model-selection": store.aiToggleModelSelection(element.dataset.id); return;
    case "ai-add-selected-models": store.aiAddSelectedModels(); return;
    case "ai-cancel-provider": store.ui.aiProviderForm = null; store.notify(); return;
    case "ai-save-secret": {
      const input = root.querySelector("[data-ai-secret]");
      const value = input ? input.value : "";
      const providerId = String(element.dataset.providerId || input?.dataset.providerId || "").trim();
      // The field is cleared immediately: a credential must not stay in the DOM.
      if (input) input.value = "";
      void store.aiSaveSecret(value, providerId);
      return;
    }
    case "ai-delete-secret": void store.aiDeleteSecret(element.dataset.providerId); return;
    case "preflight": void store.openPreflight(); return;
    case "return-publish-source": store.returnFromPublish(); return;
    case "publish-scope":
      store.ui.publishScope = element.dataset.scope === "course" ? "course" : "lesson";
      store.ui.preflightReport = null;
      store.notify();
      return;
    case "publish-format":
      store.ui.publishFormat = element.dataset.format || "markdown";
      store.ui.preflightReport = null;
      store.notify();
      return;
    case "publish-page-mode": store.selectPublishPageMode(element.dataset.mode); return;
    case "publish-page-toggle": store.togglePublishPage(element.dataset.id); return;
    case "publish-target-size": store.setPublishTargetPageSize(element.value); return;
    case "publish-target-size-value": store.setPublishTargetPageSizeValue(element.dataset.axis, element.value); return;
    case "acknowledge-export-warning": store.acknowledgeExportWarning(
      element.dataset.code,
      Boolean(element.checked),
    ); return;
    case "export-format": {
      const format = element.dataset.format || store.ui.publishFormat || "markdown";
      store.ui.publishFormat = format;
      const report = store.ui.preflightReport || store.exportPreflight();
      if (report.blocking) { store.ui.toast = `导出前检查还有 ${report.blocking} 个必须修复的问题。请先返回检查并修复`; store.notify(); return; }
      const required = [...new Set((report.issues || []).filter((issue) => issue.severity === "warning" && issue.code).map((issue) => issue.code))];
      const acknowledged = new Set(store.ui.acknowledgedWarnings || []);
      if (required.some((code) => !acknowledged.has(code))) { store.ui.toast = "请逐项确认导出提示后再继续。"; store.notify(); return; }
      store.ui.preflight = false;
      void store.exportCurrent(format);
      return;
    }
    case "export-anyway": {
      const report = store.exportPreflight();
      if (report.blocking) { store.ui.toast = `导出前检查还有 ${report.blocking} 个必须修复的问题。请先返回检查并修复`; store.notify(); return; }
      store.ui.preflight = false;
      void store.exportCurrent("markdown");
      return;
    }
    case "reveal-export":
      if (store.ui.lastExport?.path) {
        void store.bridge.revealExport(store.ui.lastExport.path).catch((error) => store.say(userFacingError(error, "找不到导出文件。你仍可在下载目录查看结果。")));
      }
      return;
    case "record-publication": void store.recordPublication(); return;
    case "clear-toast": store.ui.toast = ""; store.notify(); return;
    case "add-map-item": store.addMapItem(); return;
    default: return;
  }
}

function blocksIndexOf(blockId) {
  return store.blocks().findIndex((block) => block.id === blockId);
}

/**
 * Toasts are advisory and must never sit on top of the next action, so every
 * new message starts its own dismissal timer.
 */
function scheduleToastDismissal() {
  const message = store.ui.toast || "";
  if (!message) {
    clearTimeout(toastTimer);
    toastTimer = 0;
    lastToast = "";
    return;
  }
  if (message === lastToast) return;
  lastToast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    store.ui.toast = "";
    lastToast = "";
    store.notifyChrome();
  }, 6000);
}

function dismissBlockOverflowMenu(restoreFocus = false) {
  const active = activeBlockOverflowMenu;
  if (!active) return;
  active.details.closest?.("article.block")?.classList.remove("menu-open");
  activeBlockOverflowMenu = null;
  closeActiveBlockOverflowMenu = null;
  active.doc.removeEventListener("pointerdown", active.onOutside, true);
  active.doc.removeEventListener("keydown", active.onKeyDown, true);
  active.doc.removeEventListener("scroll", active.reposition, true);
  active.win.removeEventListener?.("resize", active.reposition);
  active.menu.removeEventListener("click", active.onMenuClick);
  active.menu.classList.remove("block-menu-portal");
  for (const property of ["position", "left", "right", "top", "max-height", "overflow-y", "width", "visibility"]) {
    active.menu.style?.removeProperty?.(property);
  }
  active.details.open = false;
  if (active.details.isConnected) active.details.append(active.menu);
  else active.menu.remove();
  active.summary.setAttribute("aria-expanded", "false");
  if (restoreFocus) active.summary.focus();
}

function showBlockOverflowMenu(details) {
  dismissBlockOverflowMenu();
  const doc = globalThis.document;
  const win = globalThis.window || globalThis;
  const summary = details.querySelector("summary");
  const menu = details.querySelector(".block-more-menu");
  if (!doc?.body || !summary || !menu) return;
  details.closest?.("article.block")?.classList.add("menu-open");
  details.open = true;
  summary.setAttribute("aria-haspopup", "menu");
  summary.setAttribute("aria-expanded", "true");
  menu.setAttribute("role", "menu");
  menu.querySelectorAll("button").forEach((button) => button.setAttribute("role", "menuitem"));
  menu.classList.add("block-menu-portal");
  menu.style.position = "fixed";
  menu.style.visibility = "hidden";
  doc.body.append(menu);

  const reposition = () => {
    const anchor = summary.getBoundingClientRect?.() || { top: 0, right: 0, bottom: 0 };
    const viewportWidth = win.innerWidth || doc.documentElement?.clientWidth || 1024;
    const viewportHeight = win.innerHeight || doc.documentElement?.clientHeight || 768;
    const width = Math.min(220, Math.max(160, viewportWidth - 16));
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.max(80, viewportHeight - 16)}px`;
    menu.style.overflowY = "auto";
    const menuHeight = Math.min(menu.getBoundingClientRect?.().height || menu.offsetHeight || 180, viewportHeight - 16);
    const below = anchor.bottom + menuHeight + 4 <= viewportHeight - 8;
    const top = below ? anchor.bottom + 4 : Math.max(8, anchor.top - menuHeight - 4);
    const left = Math.max(8, Math.min(anchor.right - width, viewportWidth - width - 8));
    menu.style.left = `${left}px`;
    menu.style.right = "auto";
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
  };
  const onOutside = (event) => {
    if (menu.contains(event.target) || details.contains(event.target)) return;
    dismissBlockOverflowMenu();
  };
  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dismissBlockOverflowMenu(true);
  };
  const onMenuClick = (event) => {
    if (!event.target?.closest?.("button[data-action]")) return;
    const waitForRender = renderQueued || Boolean(composingField);
    const focusFieldPending = Boolean(String(store.ui.focusField || ""));
    dismissBlockOverflowMenu(!waitForRender && !focusFieldPending);
    if (!waitForRender) pendingBlockOverflowFocus = null;
  };
  menu.addEventListener("click", onMenuClick);
  const active = { doc, win, details, summary, menu, reposition, onOutside, onKeyDown, onMenuClick };
  activeBlockOverflowMenu = active;
  closeActiveBlockOverflowMenu = () => dismissBlockOverflowMenu();
  doc.addEventListener("pointerdown", onOutside, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("scroll", reposition, true);
  win.addEventListener?.("resize", reposition);
  reposition();
  menu.querySelector("button:not(:disabled)")?.focus();
}

/* ------------------------------------------------------------------ *
 * Item 14 (§15.3): one delegated pointer/click/contextmenu handler for the
 * placement Grid.
 *
 * `render()` rebuilds every node under `#app`, so a listener attached to a
 * `.placement` element only ever lived until the next notify(): re-render,
 * page switch, hover-chrome change.  `#app` is the one surface that survives,
 * so the grid's three listeners are installed there exactly once and identity
 * is resolved from the markup contract instead:
 *
 *   [data-grid-surface]   the owning surface — "grid" (the canvas) or
 *                         "unplaced" (the strip of not-yet-placed content)
 *   [data-placement]      a placed block; carries data-grid-role="placement",
 *                         data-structure-block, data-page-readonly, data-row,
 *                         data-col
 *   [data-action]         a control that owns its click (cell targets, the
 *                         overlay's resize/✕/✎ buttons, an unplaced block)
 *
 * The hover overlay in `.placement-actions` is the reason this had to be
 * delegated rather than patched per button: the overlay *container* is
 * `pointer-events: none` and only its buttons are `auto` (see styles.css), so a
 * visible overlay can no longer swallow the click meant for the block under it,
 * and the current move-target cell is `pointer-events: none` instead of a
 * `disabled` button, which used to eat the click completely.
 * ------------------------------------------------------------------ */
const gridPointer = { surface: null, press: null };

function gridEventTarget(event) {
  const target = event?.target;
  return target && typeof target.closest === "function" ? target : null;
}

function gridSurfaceOf(event) {
  const target = gridEventTarget(event);
  return target ? target.closest("[data-grid-surface]") : null;
}

function gridPlacementOf(event) {
  const target = gridEventTarget(event);
  return target ? target.closest("[data-placement]") : null;
}

/** The nearest `[data-action]` control that really lives inside `scope`. */
function gridOwnedControl(event, scope) {
  const target = gridEventTarget(event);
  const control = target ? target.closest("[data-action]") : null;
  if (!control || !control.dataset.action) return null;
  if (typeof scope?.contains !== "function") return null;
  return scope.contains(control) ? control : null;
}

function gridTextSelection() {
  try {
    return String(globalThis.getSelection?.()?.toString?.() || "");
  } catch {
    return "";
  }
}

function bindGridPointerSurface() {
  if (gridPointer.surface || !root?.addEventListener) return;
  gridPointer.surface = root;
  root.addEventListener("pointerdown", onGridPointerDown);
  root.addEventListener("click", onGridPointerClick);
  root.addEventListener("contextmenu", onGridContextMenu);
}

/**
 * Remember what the pointer actually pressed.  The click that follows is the
 * command; the press tells it apart from a text-selection drag, which must not
 * be read as "enter move mode".
 */
function onGridPointerDown(event) {
  const surface = gridSurfaceOf(event);
  if (!surface) {
    gridPointer.press = null;
    return;
  }
  const placement = gridPlacementOf(event);
  gridPointer.press = {
    surface: surface.dataset.gridSurface || "",
    placementId: placement?.dataset.placement || null,
    button: event.button,
    selection: gridTextSelection(),
  };
}

function onGridPointerClick(event) {
  const surface = gridSurfaceOf(event);
  if (!surface) return;
  if (event.button != null && event.button !== 0) return;
  const placement = gridPlacementOf(event);
  const control = gridOwnedControl(event, placement || surface);
  if (control) {
    // One dispatch path for every grid control, so `data-action` keeps its
    // app-wide meaning while the grid itself never depends on re-bound nodes.
    dispatchBoundAction(control, event);
    return;
  }
  if (!placement) {
    // Pressed the canvas itself with a move armed: put the block down where it
    // already is rather than stranding the user in move mode.
    if (surface.dataset.gridSurface === "grid" && store.ui.movingPlacementId) {
      store.cancelMovePlacement();
    }
    return;
  }
  if (placement.dataset.pageReadonly === "true") return;
  const selection = gridTextSelection();
  if (selection && selection !== gridPointer.press?.selection) return;
  const placementId = placement.dataset.placement || "";
  if (!placementId) return;
  if (store.ui.movingPlacementId === placementId) {
    store.cancelMovePlacement();
    return;
  }
  store.startMovePlacement(placementId);
}

/** Right click on a placed block is the defined context action: 移出网格. */
function onGridContextMenu(event) {
  const placement = gridPlacementOf(event);
  const surface = gridSurfaceOf(event);
  if (!placement || !surface) return;
  if (placement.dataset.pageReadonly === "true") return;
  // Only this gesture is claimed; the browser menu stays everywhere else.
  event.preventDefault();
  store.removePlacementByContext(placement.dataset.placement || "");
}

/**
 * Bind the `data-action` controls of one subtree.
 *
 * `render()` calls this on the root for the whole shell. A preview frame that
 * was patched in place owns brand-new controls and no render is coming for
 * them, so the patcher calls it on just that frame — otherwise the thumbnail
 * appears and its button does nothing.
 */
function bindActionControls(scope) {
  if (!scope?.querySelectorAll) return 0;
  const controls = Array.from(scope.querySelectorAll("[data-action]") || []);
  for (const element of controls) {
    element.addEventListener("blur", () => {
      flushEditorBeforeAction(element, { notify: true });
    });
    element.addEventListener("click", (event) => {
      if (element.matches?.("select[data-action], input[data-action]")) return;
      // Controls inside the placement Grid / unplaced strip belong to the single
      // delegated grid surface (`bindGridPointerSurface`), which survives every
      // re-render.  Binding them here as well would dispatch each grid click and
      // each cell commit twice.
      if (typeof element.closest === "function" && element.closest("[data-grid-surface]")) return;
      if (element.dataset.stopClick === "true") event.stopPropagation();
      // A dialog carries `data-stop-click="true"` so that a click inside it is
      // not a click on the backdrop.  The guard used to sit on the `[data-action]`
      // listener alone, and no dialog has a `data-action` of its own — so every
      // click inside a dialog bubbled to the overlay's `close-overlay` and threw
      // the dialog, and whatever had been typed into it, away.  Resolve the
      // dialog the click actually happened in and only dispatch actions from
      // that same scope.
      const dialog = typeof event.target?.closest === "function"
        ? event.target.closest("[data-stop-click='true']")
        : null;
      if (
        dialog &&
        !(typeof element.closest === "function" && element.closest("[data-stop-click='true']") === dialog)
      ) return;
      dispatchBoundAction(element, event);
    });
  }
  return controls.length;
}

function bindMappingRow(row) {
  row.querySelector("input[data-mapping-select]")?.addEventListener("change", (event) => {
    store.setImportMappingSelected(row.dataset.path || "", Boolean(event.target.checked));
  });
  row.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !mappingRowClickToggles(target)) return;
    store.setImportMappingSelected(
      row.dataset.path || "",
      row.dataset.selected !== "true",
    );
  });
  row.querySelector("select[data-mapping-role]")?.addEventListener("change", (event) => {
    store.setImportMappingRole(row.dataset.path || "", event.target.value || "ignore");
  });
  row.querySelector("select[data-mapping-destination]")?.addEventListener("change", (event) => {
    store.setImportMappingDestination(
      row.dataset.path || "",
      event.target.value || "unassigned_lesson",
    );
  });
  row.querySelector("input[data-mapping-duplicate]")?.addEventListener("change", (event) => {
    store.setImportMappingAllowDuplicate(row.dataset.path || "", Boolean(event.target.checked));
  });
}

function bindDocumentImportRow(row) {
  row.querySelector("input[data-document-import-select]")?.addEventListener("change", (event) => {
    store.setDocumentImportSelected(row.dataset.path || "", Boolean(event.target.checked));
  });
  row.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !mappingRowClickToggles(target)) return;
    store.setDocumentImportSelected(
      row.dataset.path || "",
      row.dataset.selected !== "true",
    );
  });
}

function bindEvents() {
  bindActionControls(root);
  if (root?.dataset && root.dataset.dialogFocusTrapBound !== "true") {
    root.dataset.dialogFocusTrapBound = "true";
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const dialog = root.querySelector?.('[role="dialog"][aria-modal="true"]');
      if (!dialog) return;
      const controls = Array.from(dialog.querySelectorAll?.(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])',
      ) || []).filter((element) =>
        !element.hidden && element.getAttribute?.("aria-hidden") !== "true" &&
        !(element.tagName !== "SUMMARY" && element.closest?.("details") && !element.closest("details").open)
      );
      if (!controls.length) {
        event.preventDefault();
        dialog.focus?.();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = globalThis.document?.activeElement;
      if (!dialog.contains?.(active) || (event.shiftKey && active === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus?.();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus?.();
      }
    });
  }
  root.querySelectorAll("select[data-action], input[data-action]").forEach((element) => {
    element.addEventListener("change", (event) => {
      dispatchBoundAction(element, event);
    });
  });
  root.querySelectorAll("details.block-more > summary").forEach((summary) => {
    const details = summary.closest("details.block-more");
    if (!details) return;
    summary.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (activeBlockOverflowMenu?.details === details) dismissBlockOverflowMenu();
      else showBlockOverflowMenu(details);
    });
  });

  // P2-1: the manual Model ID is a first-class choice.  Typing in it updates the
  // "将要使用的模型" line in place — no re-render, so the caret and IME survive —
  // and 保存配置 reads the same value.
  const manualModel = root.querySelector("[data-ai-model-manual]");
  if (manualModel) {
    const syncModelPreview = () => {
      const typed = String(manualModel.value || "").trim();
      store.ui.aiManualModel = typed;
      const target = root.querySelector("[data-ai-model-preview]");
      if (target) {
        target.textContent = typed || store.ui.aiChosenModel || "（还没有选择）";
      }
      const note = root.querySelector("[data-ai-model-preview-note]");
      if (note) {
        note.textContent = typed
          ? "（手动填写）"
          : store.ui.aiModelSource === "remote"
          ? "（来自读取结果）"
          : "";
      }
      store.scheduleSessionSave();
    };
    manualModel.addEventListener("input", syncModelPreview);
    manualModel.addEventListener("change", syncModelPreview);
  }
  // The Provider ID is a form field until 保存 (§9.4): editing it writes only
  // the unsaved form, and the store refuses to re-name a saved connection.
  const providerIdField = root.querySelector("[data-ai-provider-id]");
  if (providerIdField) {
    const commitProviderId = () => store.aiSetProviderId(providerIdField.value);
    providerIdField.addEventListener("change", commitProviderId);
    providerIdField.addEventListener("blur", commitProviderId);
  }
  const modelSearch = root.querySelector("[data-ai-model-search]");
  if (modelSearch) {
    modelSearch.addEventListener("input", () => {
      const query = String(modelSearch.value || "").trim().toLowerCase();
      for (const chip of root.querySelectorAll("[data-ai-model-list] .ai-model-chip")) {
        chip.hidden = query !== "" && !String(chip.textContent || "").toLowerCase().includes(query);
      }
    });
  }

  // P2-4 / Item 14 (§15.3): the whole placement Grid — left click to move,
  // click a cell to commit, right click to take a block off the canvas, Escape
  // to cancel — runs through ONE delegated pointer/click/contextmenu handler on
  // the surviving `#app` surface.  The per-node `[data-placement]` listeners
  // this replaces were re-attached on every notify() and died with the node they
  // were bound to, which is exactly how "the block is visible but a click does
  // nothing" survived every earlier button-level fix.  `bindGridPointerSurface`
  // guards itself, so calling it after each render installs nothing twice.
  bindGridPointerSurface();

  root.querySelectorAll("[data-rich-editor]").forEach((element) => {
    let compileTimer = 0;
    const stopCompile = () => {
      if (compileTimer) clearTimeout(compileTimer);
      compileTimer = 0;
    };
    const scheduleCompile = () => {
      if (compileTimer) clearTimeout(compileTimer);
      compileTimer = setTimeout(() => {
        compileTimer = 0;
        // A paused keystroke is the stable boundary: convert the finished
        // structural block without waiting for the user to leave the field.
        if (document.activeElement !== element || composingField === element) return;
        flushPendingEdit(element, { convert: true, structuralOnly: true });
      }, BLOCK_COMPILE_IDLE_MS);
    };
    const sync = (event) => {
      if (event?.isComposing) return;
      const block = store.data.blocks.find((candidate) => candidate.id === element.dataset.blockId);
      if (!block) return;
      compileInlineAtCaret(element);
      const value = markdownFromEditable(element);
      element.dataset.empty = String(!value.trim());
      if (textOf(block.content) === value) return;
      block.content = value;
      store.markPendingEdit();
      scheduleCompile();
    };
    element.addEventListener("input", sync);
    element.addEventListener("change", sync);
    element.addEventListener("compositionend", sync);
    element.addEventListener("focus", () => {
      const block = store.data.blocks.find((candidate) => candidate.id === element.dataset.blockId);
      if (block) element.dataset.editBaseline = block.content;
      store.selectBlock(element.dataset.blockId, { force: true, soft: true });
    });
    element.addEventListener("blur", (event) => {
      stopCompile();
      if (deferEditorBlurUntilAction(element, event)) return;
      flushPendingEdit(element, { convert: true });
    });
  });

  // Block text: update in place, then record one history entry on blur.
  root.querySelectorAll(TEXT_FIELD_SELECTOR).forEach((element) => {
    element.dataset.editProperty = "text";
    const sync = (event) => {
      // Never persist a half-formed IME composition; `compositionend` and the
      // following input event deliver the committed text.
      if (event && event.isComposing) return;
      const block = store.data.blocks.find((candidate) => candidate.id === element.dataset.blockId);
      if (!block) return;
      block.content = element.value;
      store.markPendingEdit();
    };
    element.addEventListener("input", (event) => {
      sync(event);
      if (element.tagName === "TEXTAREA") autosizeBlockFields(element.parentElement || root);
    });
    element.addEventListener("change", sync);
    element.addEventListener("compositionend", (event) => {
      sync(event);
      if (element.tagName === "TEXTAREA") autosizeBlockFields(element.parentElement || root);
    });
    element.addEventListener("focus", () => {
      // Remember where typing started so undo can revert the edit itself.
      element.dataset.editBaseline = element.value;
      // One selection API: soft select keeps caret / IME (no full notify).
      store.selectBlock(element.dataset.blockId, { force: true, soft: true });
    });
    element.addEventListener("blur", (event) => {
      if (deferEditorBlurUntilAction(element, event)) return;
      flushPendingEdit(element);
    });
  });

  // Clicking anywhere in a block selects it for the right-hand panels without
  // re-rendering, so the click never steals focus from a text field.
  root.querySelectorAll("article.block[data-block-id]").forEach((element) => {
    const blockId = element.dataset.blockId;
    element.addEventListener("click", (event) => {
      // Opening the overflow menu must not re-render or the <details> closes.
      const inMore = typeof event.target?.closest === "function" &&
        event.target.closest("details.block-more");
      const onControl = typeof event.target?.closest === "function" &&
        event.target.closest("button, a, summary, input, textarea, select, label");
      const focusedInBlock = Boolean(
        document.activeElement && document.activeElement.closest?.("article.block"),
      );
      // Soft when a field owns the caret or a control/menu must stay mounted;
      // openStatus is skipped for control clicks so buttons keep their own panel.
      store.selectBlock(blockId, {
        force: true,
        soft: Boolean(inMore || onControl || focusedInBlock),
        openStatus: !onControl && !inMore,
      });
    });
  });

  // The course title in the topbar: click to edit, Enter/blur commits, Esc
  // cancels.  The 状态 panel keeps its own 课程标题 field for the lesson title.
  const seedText = root.querySelector("[data-seed-text]");
  if (seedText) {
    // Unbound on purpose: the text lives only in the DOM until "生成课程地图
    // 草稿" reads it, so typing here can never dirty canonical data.
    seedText.addEventListener("input", () => {
      store.ui.seedText = seedText.value;
    });
  }
  const projectTitle = root.querySelector("[data-project-title]");
  if (projectTitle) {
    projectTitle.addEventListener("blur", () => store.commitProjectTitle(projectTitle.value));
    projectTitle.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        store.commitProjectTitle(projectTitle.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        store.cancelProjectTitle();
      }
    });
  }
  root.querySelectorAll("[data-stage-title-inline]").forEach((element) => {
    element.addEventListener("blur", () =>
      store.commitStageTitleEdit(element.dataset.id, element.value)
    );
    element.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        store.commitStageTitleEdit(element.dataset.id, element.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        store.cancelStageTitleEdit();
      }
    });
  });
  root.querySelectorAll("[data-lesson-title-inline]").forEach((element) => {
    element.addEventListener("blur", () =>
      store.commitLessonTitleEdit(element.dataset.id, element.value)
    );
    element.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        store.commitLessonTitleEdit(element.dataset.id, element.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        store.cancelLessonTitleEdit();
      }
    });
  });
  const sectionName = root.querySelector("[data-section-name]");
  if (sectionName) {
    sectionName.addEventListener("blur", () => store.renameSection(sectionName.dataset.id, sectionName.value));
    sectionName.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        store.renameSection(sectionName.dataset.id, sectionName.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        store.cancelSectionRename();
      }
    });
  }
  const assetTitle = root.querySelector("[data-asset-title]");
  if (assetTitle) {
    assetTitle.addEventListener("input", () => {
      if (store.ui.editingAssetId === assetTitle.dataset.id) {
        store.ui.assetRenameValue = assetTitle.value;
      }
    });
    assetTitle.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void store.renameAsset(assetTitle.dataset.id, assetTitle.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        store.cancelAssetRename();
      }
    });
  }

  const titleField = root.querySelector("[data-lesson-title]");
  if (titleField) {
    titleField.dataset.editProperty = "title";
    titleField.addEventListener("blur", () => {
      const item = store.currentItem();
      if (item) store.renameLesson(item.id, titleField.value);
    });
  }

  const textProperty = root.querySelector("[data-block-text]");
  if (textProperty) {
    textProperty.addEventListener("change", () => store.editBlockText(textProperty.dataset.blockId, textProperty.value));
  }
  const levelProperty = root.querySelector("[data-block-level]");
  if (levelProperty) levelProperty.addEventListener("change", () => store.setBlockLevel(levelProperty.dataset.blockId, levelProperty.value));
  const typeProperty = root.querySelector("[data-block-type]");
  if (typeProperty) typeProperty.addEventListener("change", () => store.setBlockType(typeProperty.dataset.blockId, typeProperty.value));

  root.querySelectorAll("select[data-status-dim]").forEach((element) => element.addEventListener("change", () => store.updateStatus(element.dataset.statusDim, element.value)));
  root.querySelector("select[data-board-dimension]")?.addEventListener("change", (event) => store.setBoardDimension(event.target.value));
  // The 属性 panel edits the same Requirement rows as the 待补 panel, through
  // the same store call, so a type chosen here shows up everywhere at once.
  const blockRequirementType = root.querySelector("select[data-block-requirement-type]");
  if (blockRequirementType) {
    blockRequirementType.addEventListener("change", () =>
      store.updateRequirement(blockRequirementType.dataset.id, { type: blockRequirementType.value })
    );
  }
  const blockRequirementNote = root.querySelector(".properties-requirement [data-requirement-note]");
  if (blockRequirementNote) {
    const commit = () => store.updateRequirement(blockRequirementNote.dataset.id, { note: blockRequirementNote.value });
    blockRequirementNote.addEventListener("blur", commit);
    blockRequirementNote.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    });
  }
  // Import every selected file as one batch: the picker allows multi-select and
  // users routinely add a folder of material at once.
  for (const input of root.querySelectorAll("[data-project-file]")) {
    input.addEventListener("change", (event) => {
      const files = [...(event.target.files || [])];
      event.target.value = "";
      if (!files.length) return;
      void store.importBrowserFiles(files).catch((error) => {
        store.ui.toast = userFacingError(error, "文件导入没有完成。课程内容没有改变，请重试。");
        store.notify();
      });
    });
  }
  root.querySelector("[data-palette-input]")?.addEventListener("input", (event) => {
    store.ui.paletteIndex = 0;
    const results = root.querySelector(".palette-results");
    if (results) results.innerHTML = views.paletteResults(event.target.value);
  });
  const assetSearch = root.querySelector("[data-asset-search]");
  if (assetSearch) {
    store.ui.assetQuery = assetSearch.value;
    assetSearch.addEventListener("input", () => {
      store.ui.assetQuery = assetSearch.value;
      clearTimeout(store.assetSearchTimer);
      store.assetSearchTimer = setTimeout(() => store.notify(), 200);
    });
  }
  root.querySelectorAll("tr[data-mapping-row]").forEach(bindMappingRow);
  // §18.1 — the whole row is a hit target, not only the checkbox.  The same
  // predicate the mapping preview uses keeps interactive children (the checkbox
  // itself, buttons) out of the row toggle so one click does exactly one thing.
  root.querySelectorAll("[data-document-import-row]").forEach(bindDocumentImportRow);

  const explorerFilter = root.querySelector("[data-explorer-filter]");
  if (explorerFilter) {
    store.ui.explorerFilter = explorerFilter.value;
    explorerFilter.addEventListener("input", () => {
      store.ui.explorerFilter = explorerFilter.value;
      clearTimeout(store.explorerFilterTimer);
      store.explorerFilterTimer = setTimeout(() => {
        store.scheduleSessionSave();
        store.notify();
      }, 160);
    });
  }
  const previewNotes = root.querySelector("[data-preview-notes]");
  if (previewNotes) previewNotes.addEventListener("change", () => { store.ui.showPreviewNotes = previewNotes.checked; store.notify(); });

  // AI instruction box.  `render()` replaces the whole panel, so typing must
  // never call notify(): the value is re-read here and mirrored into the store
  // on every input, exactly like `data-asset-search` above.
  const aiInstruction = root.querySelector("[data-ai-instruction]");
  if (aiInstruction) {
    store.ui.aiInstruction = aiInstruction.value;
    aiInstruction.addEventListener("input", () => {
      store.ui.aiInstruction = aiInstruction.value;
    });
  }
  const aiProviderSelect = root.querySelector("[data-ai-provider]");
  if (aiProviderSelect) {
    aiProviderSelect.addEventListener("change", () => store.aiSetProvider(aiProviderSelect.value));
  }
  const aiModelSelect = root.querySelector("[data-ai-model]");
  if (aiModelSelect) {
    aiModelSelect.addEventListener("change", () => store.aiSetModel(aiModelSelect.value));
  }

  const dropZone = root.querySelector("[data-drop-zone]");
  if (dropZone) {
    dropZone.addEventListener("dragover", (event) => { event.preventDefault(); dropZone.classList.add("dragging"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
    dropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragging");
      const files = [...(event.dataTransfer?.files || [])];
      if (!files.length) return;
      void store.importBrowserFiles(files).catch((error) => { store.ui.toast = userFacingError(error, "文件导入没有完成。课程内容没有改变，请重试。"); store.notify(); });
    });
  }

  root.querySelectorAll("[data-board-option]").forEach((column) => {
    column.addEventListener("dragover", (event) => event.preventDefault());
    column.addEventListener("drop", (event) => {
      event.preventDefault();
      const id = event.dataTransfer.getData("text/plain");
      if (id) store.moveBoardCard(id, column.dataset.boardOption);
    });
  });
  root.querySelectorAll("[data-board-id]").forEach((card) => card.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", card.dataset.boardId)));

  bindAssetDropTargets();
  bindBlockDrag();
  bindFlowDrag();
  bindCourseMapDrag();
}

/** Insert or complete content by dropping an asset from the media panel. */
function bindAssetDropTargets() {
  for (const element of root.querySelectorAll("[data-block-id]")) {
    const blockId = element.dataset.blockId;
    if (!blockId) continue;
    element.addEventListener("dragover", (event) => {
      if (!event.dataTransfer.types.includes("text/plain")) return;
      event.preventDefault();
      element.classList.add("drop-target");
    });
    element.addEventListener("dragleave", () => element.classList.remove("drop-target"));
    element.addEventListener("drop", (event) => {
      element.classList.remove("drop-target");
      const assetId = event.dataTransfer.getData("text/plain");
      if (!assetId || !store.data.assets.some((asset) => asset.id === assetId)) return;
      event.preventDefault();
      const requirement = store.data.requirements.find((candidate) => candidate.anchor_block_id === blockId && candidate.status === "open");
      void store.insertAsset(assetId, requirement ? { requirement_id: requirement.id } : { block_id: blockId });
    });
  }
  for (const element of root.querySelectorAll(".requirement-item[data-requirement-id]")) {
    const requirementId = element.dataset.requirementId;
    element.addEventListener("dragover", (event) => { event.preventDefault(); element.classList.add("drop-target"); });
    element.addEventListener("dragleave", () => element.classList.remove("drop-target"));
    element.addEventListener("drop", (event) => {
      element.classList.remove("drop-target");
      const assetId = event.dataTransfer.getData("text/plain");
      if (!assetId || !store.data.assets.some((asset) => asset.id === assetId)) return;
      event.preventDefault();
      void store.insertAsset(assetId, { requirement_id: requirementId });
    });
  }
}

/** Keep `.selected` accents in sync without replacing the editor DOM. */
function syncBlockSelectionClasses() {
  if (!root) return;
  const selectedId = store.ui.selectedBlockId;
  for (const element of root.querySelectorAll("article.block[data-block-id]")) {
    element.classList.toggle("selected", element.dataset.blockId === selectedId);
  }
}

function clearBlockDropIndicators() {
  if (!root) return;
  for (const element of root.querySelectorAll("article.block.drop-before")) {
    element.classList.remove("drop-before");
  }
}

/**
 * Pick the block id whose top edge is the drop line for a pointer Y.
 * `rects` is `[{ id, top, height }]`, typically from getBoundingClientRect().
 */
function findBlockReorderTarget(rects, sourceId, clientY) {
  let lastId = null;
  for (const rect of rects || []) {
    if (!rect || rect.id === sourceId) continue;
    const top = Number(rect.top) || 0;
    const height = Number(rect.height) || 0;
    const mid = top + height / 2;
    if (clientY < mid) return rect.id;
    lastId = rect.id;
  }
  return lastId;
}

/**
 * Pure pointer-reorder state machine: threshold → arm → target → commit.
 * Exported so tests can drive the path without a real OS mouse.
 */
function createPointerReorderSession({
  sourceId,
  startX = 0,
  startY = 0,
  threshold = 5,
} = {}) {
  let active = false;
  let targetId = null;
  return {
    get active() {
      return active;
    },
    get targetId() {
      return targetId;
    },
    move(clientX, clientY, rects) {
      if (!active) {
        const dx = (Number(clientX) || 0) - startX;
        const dy = (Number(clientY) || 0) - startY;
        if (Math.hypot(dx, dy) < threshold) {
          return { active: false, targetId: null };
        }
        active = true;
      }
      targetId = findBlockReorderTarget(rects, sourceId, clientY);
      return { active, targetId };
    },
    commit(reorder) {
      if (!active || !targetId || targetId === sourceId) return false;
      if (typeof reorder === "function") reorder(sourceId, targetId);
      return true;
    },
  };
}

function blockReorderRects() {
  const rects = [];
  for (const element of root.querySelectorAll("article.block[data-block-id]")) {
    const id = element.dataset.blockId;
    if (!id) continue;
    try {
      const box = element.getBoundingClientRect?.();
      if (!box) continue;
      rects.push({ id, top: box.top, height: box.height });
    } catch {
      /* geometry is best effort during tests without layout */
    }
  }
  return rects;
}

function pointerDragScrollContainer(source) {
  let node = source?.parentElement || null;
  while (node && node !== root) {
    try {
      const style = globalThis.getComputedStyle?.(node);
      const scrollable = /auto|scroll|overlay/.test(style?.overflowY || "") &&
        node.scrollHeight > node.clientHeight + 1;
      if (scrollable) return node;
    } catch { /* a detached node will use the workspace fallback */ }
    node = node.parentElement;
  }
  return root.querySelector(".center") || globalThis.document?.scrollingElement || null;
}

function autoScrollPointerDrag(container, clientY) {
  if (!container?.getBoundingClientRect) return;
  const rect = container.getBoundingClientRect();
  const edge = Math.min(64, Math.max(32, rect.height * 0.12));
  const amount = clientY < rect.top + edge
    ? -Math.max(10, (rect.top + edge - clientY) * 0.35)
    : clientY > rect.bottom - edge
    ? Math.max(10, (clientY - (rect.bottom - edge)) * 0.35)
    : 0;
  if (!amount) return;
  container.scrollTop = (Number(container.scrollTop) || 0) + amount;
}

function copyDragPreviewControls(source, preview) {
  const sourceControls = source.querySelectorAll?.("input, textarea, select") || [];
  const previewControls = preview.querySelectorAll?.("input, textarea, select") || [];
  sourceControls.forEach((control, index) => {
    const target = previewControls[index];
    if (target && "value" in control) target.value = control.value;
  });
}

/** Shared Pointer Events lifecycle for block and lesson ordering. */
function bindPointerReorder(handle, source, sourceId, {
  floatClass,
  sourceClass,
  clearFeedback,
  findTarget,
  showTarget,
  commit,
  canCommit,
} = {}) {
  const doc = globalThis.document;
  const win = doc?.defaultView || globalThis;
  if (!handle || !source || !sourceId) return;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault?.();
    const pointerId = event.pointerId;
    const projectId = store.data.project?.id;
    const route = store.ui.route;
    const activeId = store.ui.activeId;
    const scrollContainer = pointerDragScrollContainer(source);
    const session = createPointerReorderSession({
      sourceId,
      startX: event.clientX ?? 0,
      startY: event.clientY ?? 0,
      threshold: 5,
    });
    let captured = false;
    let floating = null;
    let target = null;
    let finished = false;
    const clear = () => {
      if (finished) return;
      finished = true;
      doc?.removeEventListener?.("pointermove", onMove, true);
      doc?.removeEventListener?.("pointerup", onUp, true);
      doc?.removeEventListener?.("pointercancel", onCancel, true);
      doc?.removeEventListener?.("keydown", onKeyDown, true);
      win?.removeEventListener?.("blur", onWindowBlur);
      handle.removeEventListener?.("lostpointercapture", onLostCapture);
      if (captured) {
        try { handle.releasePointerCapture?.(pointerId); } catch { /* best effort */ }
      }
      source.classList.remove(sourceClass);
      doc?.body?.classList.remove("pointer-reordering");
      floating?.remove();
      clearFeedback?.();
      if (cancelActivePointerDrag === cancel) cancelActivePointerDrag = null;
    };
    const cancel = () => clear();
    const onLostCapture = (lostEvent) => {
      if (lostEvent.pointerId === pointerId && !finished) clear();
    };
    const begin = (x, y) => {
      if (!floating) {
        if (typeof source.cloneNode === "function") {
          floating = source.cloneNode(true);
          floating.classList.add("reorder-drag-float", floatClass);
          floating.setAttribute("aria-hidden", "true");
          floating.removeAttribute("data-block-id");
          floating.removeAttribute("data-map-lesson");
          copyDragPreviewControls(source, floating);
          const rect = source.getBoundingClientRect?.();
          floating.style.width = `${Math.max(120, rect?.width || 320)}px`;
          doc?.body?.append(floating);
        }
        source.classList.add(sourceClass);
        doc?.body?.classList.add("pointer-reordering");
        try {
          handle.setPointerCapture?.(pointerId);
          captured = true;
        } catch { /* document listeners remain the fallback */ }
        handle.addEventListener?.("lostpointercapture", onLostCapture);
      }
      if (floating) {
        floating.style.left = `${x + 12}px`;
        floating.style.top = `${y + 12}px`;
      }
    };
    const updateTarget = (x, y) => {
      autoScrollPointerDrag(scrollContainer, y);
      target = findTarget?.(x, y) || null;
      showTarget?.(target);
    };
    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId || finished) return;
      const next = session.move(moveEvent.clientX ?? 0, moveEvent.clientY ?? 0, []);
      if (!next.active) return;
      moveEvent.preventDefault?.();
      begin(moveEvent.clientX ?? 0, moveEvent.clientY ?? 0);
      updateTarget(moveEvent.clientX ?? 0, moveEvent.clientY ?? 0);
    };
    const onUp = (upEvent) => {
      if (upEvent.pointerId !== pointerId || finished) return;
      const next = session.move(upEvent.clientX ?? 0, upEvent.clientY ?? 0, []);
      if (next.active) {
        begin(upEvent.clientX ?? 0, upEvent.clientY ?? 0);
        updateTarget(upEvent.clientX ?? 0, upEvent.clientY ?? 0);
      }
      if (session.active) {
        const suppressClick = (clickEvent) => {
          clickEvent.preventDefault?.();
          clickEvent.stopImmediatePropagation?.();
          handle.removeEventListener?.("click", suppressClick, true);
        };
        handle.addEventListener?.("click", suppressClick, true);
        globalThis.setTimeout?.(() => {
          handle.removeEventListener?.("click", suppressClick, true);
        }, 500);
      }
      const drop = target;
      const valid = session.active && drop && store.data.project?.id === projectId &&
        store.ui.route === route && store.ui.activeId === activeId &&
        (typeof canCommit !== "function" || canCommit(drop));
      clear();
      if (valid) commit?.(drop);
    };
    const onCancel = (cancelEvent) => {
      if (cancelEvent.pointerId === pointerId) clear();
    };
    const onKeyDown = (keyEvent) => {
      if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        clear();
      }
    };
    const onWindowBlur = () => clear();
    cancelActivePointerDrag?.();
    cancelActivePointerDrag = cancel;
    doc?.addEventListener?.("pointermove", onMove, true);
    doc?.addEventListener?.("pointerup", onUp, true);
    doc?.addEventListener?.("pointercancel", onCancel, true);
    doc?.addEventListener?.("keydown", onKeyDown, true);
    win?.addEventListener?.("blur", onWindowBlur);
  });
}

/** Reorder正文 by dragging its dedicated handle; cancellation never commits. */
function bindBlockDrag() {
  for (const element of root.querySelectorAll("article.block[data-block-id]")) {
    const blockId = element.dataset.blockId;
    const handle = element.querySelector(".block-handle");
    if (!blockId || !handle) continue;
    bindPointerReorder(handle, element, blockId, {
      floatClass: "block-drag-float",
      sourceClass: "is-dragging",
      clearFeedback: clearBlockDropIndicators,
      findTarget: (_x, y) => findBlockReorderTarget(blockReorderRects(), blockId, y),
      showTarget: (targetId) => {
        clearBlockDropIndicators();
        if (!targetId) return;
        root.querySelector(`article.block[data-block-id="${targetId}"]`)?.classList.add("drop-before");
      },
      canCommit: (targetId) => typeof targetId === "string" && targetId !== blockId,
      commit: (targetId) => store.reorderBlockTo(blockId, targetId),
    });
  }
}

const FLOW_REORDER_END = "__flow_reorder_end__";

function flowReorderRects() {
  const rects = [];
  for (const element of root.querySelectorAll(".flow-placement[data-block-id]")) {
    const id = element.dataset.blockId;
    if (!id) continue;
    try {
      const box = element.getBoundingClientRect?.();
      if (box) rects.push({ id, top: box.top, height: box.height });
    } catch { /* layout geometry is best effort in headless tests */ }
  }
  return rects;
}

function clearFlowDropIndicators() {
  root?.querySelectorAll(".flow-placement.drop-before").forEach((element) => {
    element.classList.remove("drop-before");
  });
  root?.querySelector("[data-flow-drop-end]")?.classList.remove("active");
}

function bindFlowDrag() {
  for (const source of root.querySelectorAll(".flow-placement[data-block-id]")) {
    const blockId = source.dataset.blockId;
    const handle = source.querySelector("[data-flow-drag-handle]");
    if (!blockId || !handle) continue;
    bindPointerReorder(handle, source, blockId, {
      floatClass: "flow-drag-float",
      sourceClass: "is-dragging",
      clearFeedback: clearFlowDropIndicators,
      findTarget: (_x, y) => {
        const rects = flowReorderRects();
        const last = rects.at(-1);
        if (last && y >= last.top + last.height * 0.78) return FLOW_REORDER_END;
        return findBlockReorderTarget(rects, blockId, y);
      },
      showTarget: (target) => {
        clearFlowDropIndicators();
        if (target === FLOW_REORDER_END) {
          root.querySelector("[data-flow-drop-end]")?.classList.add("active");
          return;
        }
        if (typeof target !== "string") return;
        Array.from(root.querySelectorAll(".flow-placement[data-block-id]")).find((element) =>
          element.dataset.blockId === target
        )?.classList.add("drop-before");
      },
      canCommit: (target) => target === FLOW_REORDER_END ||
        (typeof target === "string" && target !== blockId),
      commit: (target) => store.reorderBlockTo(
        blockId,
        target === FLOW_REORDER_END ? null : target,
      ),
    });
  }
}

function clearCourseMapDropFeedback() {
  if (!root) return;
  root.querySelectorAll(".map-item.lesson-drop-before").forEach((element) => {
    element.classList.remove("lesson-drop-before");
  });
  root.querySelectorAll(".stage-card.lesson-drop-at-end").forEach((element) => {
    element.classList.remove("lesson-drop-at-end");
  });
  root.querySelectorAll(".lesson-drop-end.active").forEach((element) => {
    element.classList.remove("active");
  });
}

function courseMapDropTarget(clientX, clientY, sourceId) {
  const stages = [...root.querySelectorAll(".stage-card[data-stage-id]")];
  const stage = stages.find((candidate) => {
    const rect = candidate.getBoundingClientRect?.();
    return rect && clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom;
  });
  if (!stage) return null;
  const stageId = stage.dataset.stageId || null;
  if (stage.dataset.collapsed === "true") {
    return { stage, marker: stage.querySelector(".lesson-drop-end"), stageId, beforeId: null };
  }
  const items = [...stage.querySelectorAll(".map-item[data-map-lesson]")]
    .filter((candidate) => candidate.dataset.mapLesson !== sourceId);
  for (const item of items) {
    const rect = item.getBoundingClientRect?.();
    if (rect && clientY < rect.top + rect.height / 2) {
      return {
        stage,
        anchor: item,
        marker: null,
        stageId,
        beforeId: item.dataset.mapLesson,
      };
    }
  }
  return { stage, marker: stage.querySelector(".lesson-drop-end"), stageId, beforeId: null };
}

/** Course map pointer sorting shares the block handle threshold and cancel semantics. */
function bindCourseMapDrag() {
  for (const handle of root.querySelectorAll("[data-lesson-drag-handle]")) {
    const sourceId = handle.dataset.lessonDragHandle;
    const source = root.querySelector(`[data-map-lesson="${sourceId}"]`);
    if (!sourceId || !source) continue;
    bindPointerReorder(handle, source, sourceId, {
      floatClass: "lesson-drag-float",
      sourceClass: "is-dragging-source",
      clearFeedback: clearCourseMapDropFeedback,
      findTarget: (x, y) => courseMapDropTarget(x, y, sourceId),
      showTarget: (target) => {
        clearCourseMapDropFeedback();
        if (!target) return;
        if (target.anchor) target.anchor.classList.add("lesson-drop-before");
        else {
          target.stage.classList.add("lesson-drop-at-end");
          target.marker?.classList.add("active");
        }
      },
      canCommit: (target) => store.ui.route === "map" && Boolean(target.stage),
      commit: (target) => store.moveLessonToPosition(sourceId, target.stageId, target.beforeId),
    });
  }
}

document.addEventListener("keydown", (event) => {
  const command = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
  const save = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
  const capture = (event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "Space";
  const undo = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z";
  const redo = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "z";
  if (command) {
    event.preventDefault();
    store.ui.palette = true;
    store.ui.paletteIndex = 0;
    store.ui.capture = false;
    store.ui.focusField = "palette";
    store.notify();
  }
  if (save) { event.preventDefault(); void store.flush(); }
  if (undo && store.ui.screen === "project") { event.preventDefault(); store.undo(); }
  if (redo && store.ui.screen === "project") { event.preventDefault(); store.redo(); }
  if (store.ui.palette && ["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
    event.preventDefault();
    const results = root.querySelectorAll(".palette-result");
    if (!results.length) return;
    if (event.key === "Enter") { results[store.ui.paletteIndex]?.click(); return; }
    const step = event.key === "ArrowDown" ? 1 : -1;
    store.ui.paletteIndex = (store.ui.paletteIndex + step + results.length) % results.length;
    results.forEach((result, index) => result.classList.toggle("selected", index === store.ui.paletteIndex));
  }
  if (capture) {
    event.preventDefault();
    store.ui.capture = true;
    store.ui.palette = false;
    store.ui.focusField = "capture";
    store.notify();
  }
  if (event.key === "Escape" && store.ui.projectProblem) {
    event.preventDefault();
    store.dismissProjectProblem();
    return;
  }
  if (event.key === "Escape" && store.ui.registryCopy) {
    event.preventDefault();
    store.ui.registryCopy = null;
    store.notify();
    return;
  }
  if (event.key === "Escape" && store.ui.pendingDeleteConfirmation) {
    event.preventDefault();
    store.ui.pendingDeleteConfirmation = null;
    store.notify();
    return;
  }
  if (event.key === "Escape" && store.ui.documentImportDialog) {
    // §18 — Escape is the 取消 button: nothing gets adopted, and the mapping page
    // says out loud that no course content was written.
    event.preventDefault();
    store.cancelDocumentImportSelection();
    return;
  }
  if (event.key === "Escape" && (store.externalConflict || store.pendingRecovery)) return;
  if (event.key === "Escape" && store.ui.editingAssetId) {
    event.preventDefault();
    store.cancelAssetRename();
    return;
  }
  if (event.key === "Escape" && store.ui.assetImagePreviewId) {
    // The modal is `aria-modal`, so Escape has to win over everything underneath
    // it — and it has to run the same teardown the × does, or the GIF keeps
    // playing behind a surface that is already gone.
    stopMediaPreview();
    store.releaseAssetViewerSource();
    store.ui.assetImagePreviewId = null;
    event.preventDefault();
    store.notify();
    return;
  }
  if (event.key === "Escape" && store.ui.movingPlacementId) {
    store.cancelMovePlacement();
    return;
  }
  if (event.key === "Escape" && store.ui.aiSettingsOpen) {
    store.aiCloseSettings();
    return;
  }
  if (event.key === "Escape" && (store.ui.palette || store.ui.capture || store.ui.preflight || store.ui.snapshot || store.ui.assetPicker)) {
    store.cancelPreflight();
    store.ui.palette = store.ui.capture = store.ui.preflight = store.ui.snapshot = false;
    store.ui.assetPicker = null;
    store.scheduleSessionSave();
    store.notify();
  }
});

/* Native window lifecycle: flush, release the lease, then confirm exit. */
const flushAndClose = async () => {
  try {
    if (store.nativeSwitching) {
      store.ui.toast = "项目切换尚未完成；请在切换完成后再次关闭。";
      store.notifyChrome();
      return;
    }
    if (!await store.resolveNativeSwitchPending()) return;
    if (store.nativeSwitching) return;
    // A cold Native window has only the in-memory launcher placeholder, not a
    // Canonical project to flush. Keep the strict save barrier once a project
    // identity or a project lease exists.
    const hasLease = store.hasNativeLease();
    if ((store.saveIdentity().expected_project_id || hasLease) && !await store.flush()) return;
    // Only release a lease this instance actually owns; releasing an unowned
    // directory would create a guard file for a project we never opened.
    if (hasLease) await store.closeNativeProject();
    await store.bridge.confirmClose();
  } catch (error) {
    store.ui.toast = userFacingError(error, "关闭前保存没有完成。课程内容没有改变，请先重试。");
    store.notify();
  }
};

if (bridge.isNative()) {
  const currentWindow = globalThis.__TAURI__?.window?.getCurrentWindow();
  currentWindow.onCloseRequested((event) => {
    event.preventDefault();
    void flushAndClose();
  }).catch(() => {});
  const listen = globalThis.__TAURI__?.event?.listen;
  if (typeof listen === "function") {
    const onCloseRequested = (event) => {
      event?.preventDefault?.();
      void flushAndClose();
    };
    void listen("tauri://close-requested", onCloseRequested).catch(() => {});
    void listen("workbench://close-requested", onCloseRequested).catch(() => {});
  }
}
if (typeof globalThis.addEventListener === "function") {
  if (bridge.isNative()) {
    globalThis.addEventListener("beforeunload", () => {
      void flushAndClose();
    });
  } else {
    // Browser reader state is a separate sidecar, so hand the latest route to
    // the keepalive endpoint before any canonical-save drain can yield to page
    // teardown. pagehide and beforeunload may both fire for one navigation.
    let pageExitSessionSent = false;
    const saveLatestBrowserSession = () => {
      if (pageExitSessionSent) return;
      pageExitSessionSent = true;
      const session = store.session();
      void store.persistSessionDirect(session).catch((error) =>
        store.reportSessionFailure(error, session)
      );
    };
    globalThis.addEventListener("pagehide", saveLatestBrowserSession);
    globalThis.addEventListener("beforeunload", saveLatestBrowserSession);
    globalThis.addEventListener("pageshow", () => {
      pageExitSessionSent = false;
    });
  }
}

store.subscribe((kind) => (kind === "chrome" ? patchChrome() : render()));
installEditorGuards();
// The promise is exposed so the native shell (and the desktop boot tests) can
// wait for a fully restored window instead of guessing at a delay.  It carries
// no capability: the store itself is already reachable as `__workbench`.
globalThis.__workbenchReady = store.initialize();

// Expose the live workbench for native automation and manual inspection.  This
// is the running store only: it grants nothing the UI could not already do.
globalThis.__workbench = store;

if (root) render();

export {
  DesktopBridge,
  WorkbenchStore,
  browserHtml,
  browserMarkdown,
  createPointerReorderSession,
  describeProjectOpenFailure,
  findBlockReorderTarget,
  userFacingError,
};
export { PROJECT_FILE_PICKER } from "./constants.js";
