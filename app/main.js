// deno-fmt-ignore-file
/*
 * Dependency-free desktop-first renderer.
 *
 * In a Tauri build, DesktopBridge forwards every persistence operation to
 * Rust commands. The browser build uses the same high-level command API
 * through the local Deno service, so canonical state never lives in UI code.
 * Components only mutate WorkbenchStore; they never call fs, Git, or secrets.
 */

import { PROJECT_FILE_PICKER } from "./constants.js";
import { createSerialQueue, recoveryWarning } from "./recovery.js";
import {
  MEDIA_BLOCK_TYPES,
  assetUsedElsewhere,
  blockLabel,
  blocksFor,
  courseMap,
  lessonView,
  requirementBacklog,
  resumeLessonId,
  statusOptionId,
  textOf,
  usagesForAsset,
} from "./authoring.js";
import { AssetPreviewCache, esc } from "./canvas.js";
import { createViews } from "./views.js";
import {
  AI_FAILURE_CODES,
  AiFailure,
  FakeAiConnector,
  HttpAiConnector,
  aiProviderPreset,
  applyAiChangeDraft,
  assembleAiContext,
  buildAiExecutionRecord,
  createAiChangeDraft,
  createAiSuggestion,
  rejectAiChangeDraft,
  validateAiChangeDraft,
} from "./ai.js";

const SESSION_KEY = "ai-course-workbench.session";
const SESSION_READER_KEYS = [
  "active_content_item_id",
  "mode",
  "right_panel",
  "route",
  "selected_block_id",
  "ai_scope",
  "ai_provider_id",
  "ai_model",
  "left_collapsed",
  "right_collapsed",
  "tabs",
];
/** High-level commands that must carry the selected project directory. */
const NATIVE_PROJECT_COMMANDS = new Set([
  "project.open",
  "project.create",
  "project.save",
  "project.external.inspect",
  "project.reload",
  "project.merge",
  "project.resolve",
  "import.preview",
  "import.confirm",
  "asset.import",
  "asset.read",
  "snapshot.create",
  "snapshot.restore",
  "export.preflight",
  "export.run",
  "publication.record",
]);
const clone = (value) => structuredClone(value);
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const nextRevision = (previous) => {
  const previousMs = Date.parse(previous || "");
  const currentMs = Date.now();
  return new Date(Math.max(currentMs, Number.isFinite(previousMs) ? previousMs + 1 : currentMs)).toISOString();
};
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

/** Keep technical bridge failures out of ordinary toasts. */
const userFacingError = (error, fallback) => {
  const raw = String(error?.message || error || "").trim();
  const context = `${String(error?.code || "")} ${raw}`.toLowerCase();
  if (/project_(?:not_open|lock_lost|lock_not_owned|locked)|项目已被占用|项目编辑锁|锁/.test(context)) {
    return "这个项目正在其他窗口或进程中使用。为避免覆盖，当前操作没有写入；课程内容没有改变，请关闭其他窗口后重试。";
  }
  if (/external_modification_conflict|外部修改|外部项目文件|磁盘版本/.test(context)) {
    return "课程文件在其他地方发生了变化，保存已暂停以免覆盖内容。你仍可继续查看，请重新载入、自动合并，或明确保留本地版本。";
  }
  if (/project\.json|可识别的课程|project data|项目文件|项目目录不存在/.test(context)) {
    return "这个文件夹或文件不是可用的课程项目。课程内容没有改变，请选择正确的项目后再试。";
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
    return fallback;
  }
  return raw;
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
  ["inbox", "收件箱", "↓"],
  ["board", "制作看板", "▤"],
  ["media", "媒体库", "◈"],
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
      this.projectDir = new URL(globalThis.location?.href || "http://localhost/")
        .searchParams.get("project_dir")?.trim() || null;
      this.projectDirFromUrl = Boolean(this.projectDir);
    } catch {
      this.projectDir = null;
    }
  }
  isNative() { return Boolean(globalThis.__TAURI__?.core?.invoke); }
  setProjectDir(value) {
    const projectDir = String(value ?? "").trim();
    if (!projectDir) throw new Error("请先选择项目文件夹");
    this.projectDir = projectDir;
    this.projectDirFromUrl = false;
    return projectDir;
  }
  restoreProjectDir(value, fromUrl = false) {
    this.projectDir = value || null;
    this.projectDirFromUrl = Boolean(value && fromUrl);
  }
  requireProjectDir() {
    if (!this.projectDir) throw new Error("请先选择项目文件夹");
    return this.projectDir;
  }
  nativeInput(command, args = {}) {
    if (!this.isNative() || !NATIVE_PROJECT_COMMANDS.has(command)) return args;
    const projectDir = this.requireProjectDir();
    const input = args && typeof args === "object" ? args : {};
    if (command === "project.resolve") {
      return { projectDir, project: input.project, expectedCurrent: input.expected_current };
    }
    if (["project.open", "project.create", "project.save", "project.external.inspect", "project.reload", "project.merge", "snapshot.create", "snapshot.restore"].includes(command)) {
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
    if (["asset.import", "asset.read", "publication.record"].includes(command)) {
      return { input: { ...input, project_dir: projectDir } };
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
    const failure = new Error(detail?.user_message || detail?.message || fallback);
    failure.code = detail?.code || "bridge_request_failed";
    failure.details = detail?.details || {};
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
  nativeCommand(command) {
    return {
      "project.open": "project_open",
      "project.create": "project_create",
      "project.save": "project_save",
      "project.external.inspect": "project_external_status",
      "project.reload": "project_reload",
      "project.merge": "project_merge",
      "project.resolve": "project_resolve",
      "import.preview": "import_preview",
      "import.confirm": "import_confirm",
      "asset.import": "asset_import",
      "asset.read": "asset_read",
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
  async openProject(projectDir) {
    return await this.invoke("project.open", {});
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
  async clearRecoveryJournal() {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (!invoke || !this.projectDir) return;
    return await this.nativeInvoke("clear_recovery_journal", { projectDir: this.projectDir, project_dir: this.projectDir });
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
    return await this.invoke(name, input);
  }
  async readProject() {
    return await this.invoke("project.open", {});
  }
  /** Read one referenced asset's bytes for an in-workbench preview. */
  async readAssetBytes(assetId) {
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
    return await this.readAssetBytesFromDevServer(assetId);
  }
  async readAssetBytesFromDevServer(assetId) {
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
    return new Uint8Array(await response.arrayBuffer());
  }
  async exportProject(format, project, preset, outputPath = "", contentItemId = null) {
    const nextPreset = { ...(preset || { name: format, output_type: format, platform: "通用", page_mode: "single", settings: {} }) };
    if (contentItemId) nextPreset.content_item_id = contentItemId;
    if (outputPath) {
      const parts = pathParts(outputPath);
      nextPreset.filename = parts.filename;
      nextPreset.output_dir = parts.output_dir;
      nextPreset.output_path = outputPath;
    }
    return await this.invoke("export.run", { preset: nextPreset, options: { content_item_id: contentItemId || null } });
  }
  async revealExport(path) {
    if (!this.isNative()) throw new Error("浏览器下载的文件请在下载目录查看。");
    return await this.invoke("export.reveal", { path });
  }
  async writeProject(project) {
    await this.invoke("project.save", { project });
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
    return await this.invoke("project.reload", {});
  }
  async mergeExternalProject(project) {
    return await this.invoke("project.merge", { project });
  }
  async resolveExternalProject(project, expectedCurrent) {
    return await this.invoke("project.resolve", { project, expected_current: expectedCurrent });
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
  async saveSession(session) {
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
      await this.nativeInvoke("save_session", { session: payload });
      return;
    }
    if (typeof globalThis.fetch !== "function") {
      this.memory[SESSION_KEY] = clone(session);
      return;
    }
    const response = await globalThis.fetch(`${this.apiBase}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: session && typeof session === "object" ? session : {} }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw this.bridgeError(payload, "无法记录上次阅读位置");
  }
  async loadSession() {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) {
      const session = await this.nativeInvoke("load_session", {});
      const projectDir = session && typeof session.project_dir === "string"
        ? session.project_dir
        : null;
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
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) return await this.invoke("snapshot.create", { snapshotId: input.snapshot_id, name: input.name, note: input.note, project: input.project });
    return await this.invoke("snapshot.create", input);
  }
  async restoreSnapshot(snapshotId, projectId = "default") {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) {
      const result = await this.invoke("snapshot.restore", { snapshotId, projectId });
      return result?.restored ? await this.readProject() : result?.project || result;
    }
    const restored = await this.invoke("snapshot.restore", { snapshot_id: snapshotId, project_id: projectId });
    return restored?.project || restored;
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
    this.ui = {
      screen: "launcher",
      route: "overview",
      mode: "writing",
      boardDimension: "content",
      activeId: null,
      selectedBlockId: null,
      focusRequirementId: null,
      leftCollapsed: false,
      rightCollapsed: false,
      rightPanel: "requirements",
      palette: false,
      paletteIndex: 0,
      capture: false,
      preflight: false,
      preflightReport: null,
      publishScope: "lesson",
      publishFormat: "markdown",
      lastExport: null,
      snapshot: false,
      gridEditing: false,
      assetPicker: null,
      assetUsageId: null,
      editingRequirementId: null,
      assetQuery: "",
      showPreviewNotes: true,
      confirmDeleteLesson: null,
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
    };
    this.tabs = [];
    this.history = [];
    this.future = [];
    this.listeners = new Set();
    this.saveTimer = 0;
    this.sessionTimer = 0;
    this.flushQueue = createSerialQueue();
    this.recoveryWarning = "";
    this.saveStatus = "未保存";
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
    this.editTimer = 0;
    this.assetSearchTimer = 0;
    this.expectedProjectId = null;
    /** Preview cache: bounded, read-only, never a source of truth. */
    this.assetPreview = new AssetPreviewCache(bridge);
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { this.listeners.forEach((listener) => listener()); }
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
        this.notify();
      }, options.ttl ?? 6000);
    }
    this.notify();
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
      ai_scope: this.ui.aiScope,
      ai_provider_id: this.ui.aiProviderId,
      ai_model: this.ui.aiModel,
      left_collapsed: this.ui.leftCollapsed,
      right_collapsed: this.ui.rightCollapsed,
      tabs: clone(this.tabs),
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
      ai_scope: "lesson",
      ai_provider_id: "fake",
      ai_model: "",
      left_collapsed: false,
      right_collapsed: false,
      tabs: activeId
        ? [{ content_item_id: activeId, mode: "writing", pinned: false, scroll_top: 0 }]
        : [],
    };
  }
  normalizeReaderState(project, candidate = {}, route = "overview") {
    const defaults = this.defaultReaderState(project, route);
    const value = candidate && typeof candidate === "object" ? candidate : {};
    const knownItem = (id) => Boolean(id) && project.content_items.some((item) => item.id === id);
    const activeId = knownItem(value.active_content_item_id)
      ? value.active_content_item_id
      : defaults.active_content_item_id;
    const mode = ["writing", "structure", "layout", "preview"].includes(value.mode)
      ? value.mode
      : defaults.mode;
    const rightPanel = RIGHT_PANEL_KEYS.includes(value.right_panel)
      ? value.right_panel
      : defaults.right_panel;
    const nextRoute = ROUTES.includes(value.route) ? value.route : defaults.route;
    const selectedBlockId = typeof value.selected_block_id === "string" && activeId &&
        blocksFor(project, activeId).some((block) => block.id === value.selected_block_id)
      ? value.selected_block_id
      : null;
    const tabs = Array.isArray(value.tabs)
      ? value.tabs
        .filter((tab) => tab && knownItem(tab.content_item_id))
        .map((tab) => ({
          content_item_id: tab.content_item_id,
          mode: ["writing", "structure", "layout", "preview"].includes(tab.mode) ? tab.mode : "writing",
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
      ai_scope: ["course", "lesson", "block"].includes(value.ai_scope) ? value.ai_scope : defaults.ai_scope,
      ai_provider_id: typeof value.ai_provider_id === "string" && value.ai_provider_id.trim()
        ? value.ai_provider_id.trim()
        : defaults.ai_provider_id,
      ai_model: typeof value.ai_model === "string" ? value.ai_model.trim() : defaults.ai_model,
      left_collapsed: Boolean(value.left_collapsed),
      right_collapsed: Boolean(value.right_collapsed),
      tabs,
    };
  }
  applyReaderState(reader) {
    const value = reader || {};
    this.ui.activeId = value.active_content_item_id || null;
    this.ui.mode = value.mode || "writing";
    this.ui.rightPanel = value.right_panel || "requirements";
    this.ui.route = value.route || "overview";
    this.ui.selectedBlockId = value.selected_block_id || null;
    this.ui.aiScope = value.ai_scope || "lesson";
    this.ui.aiProviderId = value.ai_provider_id || "fake";
    this.ui.aiModel = value.ai_model || "";
    this.ui.leftCollapsed = Boolean(value.left_collapsed);
    this.ui.rightCollapsed = Boolean(value.right_collapsed);
    this.tabs = clone(value.tabs || []);
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
    await this.bridge.saveSession(value);
    this.rememberSession(value);
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
        this.bridge.restoreProjectDir(pending.restoreProjectDir, pending.restoreFromUrl);
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
  async rollbackNativeTarget(projectDir, restoreProjectDir, restoreFromUrl, cause, restoreSession = null) {
    // A provisional target lease belongs to us even when the project payload
    // turned out to be unusable, so close it before restoring the old pointer.
    const pending = {
      projectDir,
      restoreProjectDir,
      restoreFromUrl,
      restoreSession,
    };
    try {
      await this.bridge.closeProject(projectDir);
      this.clearNativeLease(projectDir);
    } catch (rollbackError) {
      this.nativeSwitchPending = pending;
      this.bridge.restoreProjectDir(restoreProjectDir, restoreFromUrl);
      throw new Error(`项目切换失败，当前项目仍保持不变。${userFacingError(rollbackError, "请稍后重试。")}`);
    }
    this.bridge.restoreProjectDir(restoreProjectDir, restoreFromUrl);
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
  lesson(item = this.currentItem()) { return item ? lessonView(this.data, item.id) : null; }
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
  selectBlock(id, options = {}) {
    const item = this.currentItem();
    if (!item) return;
    const known = blocksFor(this.data, item.id).some((block) => block.id === id);
    if (!known) return;
    this.ui.selectedBlockId = this.ui.selectedBlockId === id && !options.force ? null : id;
    if (options.mode && this.ui.mode !== options.mode) this.setMode(options.mode, { silent: true });
    this.scheduleSessionSave();
    this.notify();
  }
  commit(label, mutation) {
    const before = clone(this.data);
    const selectionBefore = this.ui.selectedBlockId;
    mutation(this.data);
    this.data.project.updated_at = nextRevision(this.data.project.updated_at);
    this.retainUiSelection();
    this.history.push({ label, before, after: clone(this.data), selection: selectionBefore });
    if (this.history.length > 50) this.history.shift();
    this.future = [];
    this.scheduleSave();
    this.notify();
  }
  markDirty() { this.data.project.updated_at = nextRevision(this.data.project.updated_at); this.scheduleSave(); this.notify(); }
  /**
   * Record an edit without re-rendering: used while a text field still owns
   * focus so the caret and IME composition are never destroyed mid-typing.
   * A follow-up commit() records the same change in history.
   */
  markPendingEdit() {
    this.data.project.updated_at = nextRevision(this.data.project.updated_at);
    this.saveStatus = "正在保存…";
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.flush(); }, 350);
    clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => { this.editTimer = 0; this.notify(); }, 600);
  }
  /**
   * Drop selection state that no longer points at canonical rows, so a stale
   * block or requirement can never leak into the next lesson.
   */
  /** Record the project identity this shell is allowed to write. */
  trackProjectIdentity(data = this.data) {
    this.expectedProjectId = data?.project?.id ?? null;
    const dropped = Number(data?.__status_repair_dropped || 0);
    if (dropped > 0) {
      delete data.__status_repair_dropped;
      this.ui.toast = `有 ${dropped} 条状态记录指向已不存在的状态表，已移除；请重新设置这些课程的状态`;
    }
    return this.expectedProjectId;
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
   * The selected provider, shaped like an `AiProviderPreset`.
   *
   * A saved configuration only overrides the fields it actually carries, so a
   * provider id that is not in the shipped catalog still gets readable
   * defaults instead of an empty form.
   */
  aiDescriptor() {
    const id = String(this.ui.aiProviderId || "fake").trim() || "fake";
    const custom = aiProviderPreset("custom") || {
      id: "custom",
      label: "自定义（OpenAI 兼容）",
      kind: "openai_compatible",
      base_url: "",
      chat_path: "/chat/completions",
      auth_header: "authorization",
      auth_scheme: "Bearer",
      default_model: "",
      models: [],
      requires_credential: true,
    };
    const known = aiProviderPreset(id);
    const base = known || {
      ...custom,
      id,
      label: id,
      base_url: "",
      default_model: "",
      models: [],
    };
    const saved = (Array.isArray(this.ui.aiProviders) ? this.ui.aiProviders : [])
      .find((entry) => entry && entry.id === id) || null;
    const descriptor = { ...base };
    if (saved) {
      for (const key of ["label", "base_url", "chat_path", "auth_header", "auth_scheme", "default_model"]) {
        if (typeof saved[key] === "string" && saved[key]) descriptor[key] = saved[key];
      }
      descriptor.models = [...new Set([
        ...(Array.isArray(saved.models)
          ? saved.models.filter((model) => typeof model === "string" && model)
          : []),
        ...(Array.isArray(base.models) ? base.models : []),
      ])];
    }
    // V0 knows exactly two connector kinds: the offline fake and the
    // OpenAI-compatible HTTP transport.
    descriptor.kind = id === "fake" ? "fake" : "openai_compatible";
    descriptor.requires_credential = id !== "fake";
    return descriptor;
  }
  /** The model id a run would use, resolved the same way the panel shows it. */
  aiModel() {
    const descriptor = this.aiDescriptor();
    return String(this.ui.aiModel || "").trim() || descriptor.default_model ||
      (Array.isArray(descriptor.models) ? descriptor.models[0] : "") || "";
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
      preset: descriptor,
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
    const models = Array.isArray(descriptor.models) ? descriptor.models : [];
    if (!models.includes(this.ui.aiModel)) {
      this.ui.aiModel = descriptor.default_model || models[0] || "";
    }
    this.ui.aiProviderForm = null;
    this.ui.aiError = null;
    this.scheduleSessionSave();
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
    const descriptor = this.aiDescriptor();
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
  aiEditProvider(id) {
    const providerId = String(id || this.ui.aiProviderId || "").trim();
    if (providerId && providerId !== this.ui.aiProviderId) this.aiSetProvider(providerId);
    if (this.ui.aiProviderForm) {
      this.ui.aiProviderForm = null;
      this.notify();
      return;
    }
    const descriptor = this.aiDescriptor();
    this.ui.aiProviderForm = {
      id: descriptor.id,
      label: descriptor.label,
      base_url: descriptor.base_url,
      chat_path: descriptor.chat_path,
      default_model: descriptor.default_model,
      models: Array.isArray(descriptor.models) ? descriptor.models : [],
    };
    this.notify();
  }
  /** Save a provider's address / model names.  Never a credential. */
  async aiSaveProvider(input = {}) {
    const id = String(input.id || this.ui.aiProviderId || "").trim();
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
    const existing = (Array.isArray(this.ui.aiProviders) ? this.ui.aiProviders : [])
      .find((entry) => entry && entry.id === id) || null;
    const provider = {
      id,
      label: String(input.label || id).trim() || id,
      kind: "openai_compatible",
      base_url: String(input.base_url || "").trim(),
      chat_path: String(input.chat_path || (existing && existing.chat_path) || "/chat/completions"),
      auth_header: String((existing && existing.auth_header) || "authorization"),
      auth_scheme: String((existing && existing.auth_scheme) || "Bearer"),
      default_model: String(input.default_model || "").trim(),
      models: Array.isArray(input.models)
        ? input.models.map((model) => String(model).trim()).filter(Boolean)
        : [],
    };
    try {
      await this.bridge.command("ai.connection.save", { provider });
    } catch (error) {
      this.ui.aiError = this.aiFailureFrom(error);
      this.ui.toast = `服务商配置没有保存：${this.ui.aiError.message}`;
      this.notify();
      return false;
    }
    this.ui.aiProviderForm = null;
    await this.aiLoadProviders();
    this.ui.toast = `已保存「${provider.label}」的地址与模型名（不包含密钥）`;
    this.notify();
    return true;
  }
  /**
   * Store one credential through the transport process.  The value is never
   * kept in `ui`, in the DOM after submit, or in any log line.
   */
  async aiSaveSecret(value) {
    const providerId = String(this.ui.aiProviderId || "").trim();
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
    try {
      await this.bridge.command("ai.secret.set", { provider_id: providerId, value: secret });
    } catch (error) {
      this.ui.aiError = this.aiFailureFrom(error);
      this.ui.toast = `密钥没有保存：${this.ui.aiError.message}`;
      this.notify();
      return false;
    }
    this.ui.aiConfigured = { ...(this.ui.aiConfigured || {}), [providerId]: true };
    this.ui.aiError = null;
    this.ui.toast = `API Key 已保存到${this.aiStorageLabel()}（不回显，也不进入课程文件）`;
    this.notify();
    return true;
  }
  async aiDeleteSecret() {
    const providerId = String(this.ui.aiProviderId || "").trim();
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
    this.ui.aiConfigured = { ...(this.ui.aiConfigured || {}), [providerId]: false };
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
    this.saveStatus = "正在保存…";
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.flush(); }, 350);
    this.notify();
  }
  scheduleSessionSave() {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      if (this.nativeSwitching) return;
      this.persistSession(this.session()).catch(() => {});
    }, 0);
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
    return this.flushQueue(() => this.flushNow());
  }
  /**
   * Write pending edits immediately instead of waiting for the autosave
   * debounce.  `flushNow` refuses to run while a recovery decision is pending,
   * so callers that have just resolved one use this entry point.
   */
  writeThrough() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    return this.flushQueue(() => this.flushNow());
  }
  async flushNow() {
    let saved = false;
    this.recoveryWarning = "";
    const issues = assertAuthoringInvariants(this.data);
    if (issues.length > 0) {
      // Refuse to write a project that would fail canonical validation: the
      // previous good file must stay intact and the user must be told.
      this.saveStatus = "保存失败";
      this.ui.toast = "这份课程里有一处关联不完整，暂时没有保存。你可以继续编辑；修复提示后再保存。";
      this.notify();
      return false;
    }
    if (this.pendingRecovery) {
      this.saveStatus = "恢复待处理";
      this.ui.toast = "发现未完成的保存，当前不能继续保存。请先恢复暂存内容或保留磁盘版本。";
      this.notify();
      return false;
    }
    if (this.nativeSwitchPending) {
      this.saveStatus = "保存失败";
      this.ui.toast = "项目切换尚未完成，请先完成锁回滚";
      this.notify();
      return false;
    }
    try {
      while (true) {
        const revision = nextRevision(this.data.project.updated_at);
        this.data.project.updated_at = revision;
        const snapshot = clone(this.data);
        await this.bridge.writeRecoveryJournal({ project_id: snapshot.project.id, saved_at: revision, project: snapshot });
        if (this.data.project.updated_at !== revision) continue;
        await this.bridge.writeProject(snapshot);
        if (this.data.project.updated_at !== revision) continue;
        if (this.data.project.updated_at !== revision) continue;
        // Re-check the identity the bridge reports: a project silently replaced
        // on disk (another tab, a swapped folder) must not keep being
        // overwritten under the wrong project.  Bridges without the query keep
        // working unchanged.
        const expected = this.expectedProjectId ?? snapshot.project.id;
        let diskId = null;
        if (typeof this.bridge.projectIdentity === "function") {
          diskId = await this.bridge.projectIdentity().catch(() => null);
        }
        if (diskId && diskId !== expected) {
          this.saveStatus = "保存失败";
          this.ui.toast = "磁盘上的项目已经被替换，已停止写入；课程内容没有改变，请重新打开项目。";
          this.notify();
          return false;
        }
        if (this.data.project.updated_at !== revision) continue;
        try {
          const clearResult = await this.bridge.clearRecoveryJournal();
          const warning = recoveryWarning(clearResult);
          if (warning) this.noteRecoveryWarning(warning);
        } catch (error) {
          this.noteRecoveryWarning("恢复记录暂时没有清理，但课程内容已经保存。你可以继续使用。");
        }
        if (this.data.project.updated_at !== revision) continue;
        try {
          await this.persistSession(this.session());
        } catch (error) {
          // The canonical project is already on disk; losing the reader
          // position must not be reported as a failed save of the project.
          this.ui.toast = "课程已经保存，但上次阅读位置没有记住。课程内容不受影响，你可以继续使用。";
        }
        if (this.data.project.updated_at !== revision) continue;
        this.saveStatus = "已保存";
        saved = true;
        break;
      }
    } catch (error) {
      if (this.bridge.isNative() && typeof error?.message === "string" && /project_(?:not_open|lock_lost|lock_not_owned)/.test(error.message)) {
        this.clearNativeLease();
        this.saveStatus = "保存失败";
        this.ui.toast = userFacingError(error, "保存没有完成。课程内容没有改变，请稍后再试。");
        this.notify();
        return false;
      }
      if (error?.code === "external_modification_conflict" || /external_modification_conflict/.test(String(error?.message || ""))) {
        await this.captureExternalConflict(error);
        return false;
      }
      this.saveStatus = "保存失败";
      this.ui.toast = userFacingError(error, "保存没有完成。课程内容没有改变，请稍后再试。");
      this.notify();
      return false;
    }
    this.notify();
    return saved;
  }
  async captureExternalConflict(error) {
    this.saveStatus = "外部修改冲突";
    this.ui.toast = "课程文件在其他地方发生了变化，保存已暂停以免覆盖内容。你仍可继续查看；请选择重新载入、合并或保留本地版本。";
    this.externalConflict = await this.bridge.inspectExternalModification(this.data).catch((inspectionError) => ({
      inspection_error: inspectionError?.message || "无法读取磁盘差异",
      current: null,
    }));
    this.notify();
    return false;
  }
  async resolveExternalConflict(action) {
    this.ui.toast = "正在处理外部修改…";
    this.notify();
    if (action === "reload") {
      try {
        await this.flushQueue(async () => {
          const reloaded = await this.bridge.reloadExternalProject();
          if (!this.isProjectData(reloaded)) throw new Error("磁盘版本不是可识别的课程项目");
          this.data = migrateUiProject(reloaded);
          this.trackProjectIdentity();
          this.history = [];
          this.future = [];
          this.resetAiState();
          this.retainUiSelection();
          await this.bridge.clearRecoveryJournal().catch(() => {});
          this.externalConflict = null;
          this.saveStatus = "已保存";
          this.ui.toast = "已载入磁盘版本";
          this.notify();
        });
      } catch (error) {
        this.ui.toast = userFacingError(error, "重新载入没有完成。当前内容没有改变，请重试。");
        this.notify();
      }
      return;
    }
    if (action === "merge") {
      try {
        await this.flushQueue(async () => {
          // The service returns a three-way MergeResult: `merged` already
          // carries both the external and the local edits, and `conflicts`
          // lists the paths that could not be combined.
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
        });
      } catch (error) {
        this.ui.toast = userFacingError(error, "自动合并没有完成。当前内容没有改变，请重新载入或保留本地版本。");
        this.notify();
      }
      return;
    }
    if (action === "keep-local") {
      try {
        await this.flushQueue(() => this.applyExternalResolution(this.data, "已明确保留本地版本"));
      } catch (error) {
        this.ui.toast = userFacingError(error, "保留本地版本没有完成。当前内容没有改变，请重试。");
        this.notify();
      }
    }
  }
  async applyExternalResolution(project, message) {
    const expected = this.externalConflict?.current;
    if (!expected) throw new Error("缺少磁盘版本指纹，请重新载入或重新检查");
    const resolved = await this.bridge.resolveExternalProject(project, expected);
    if (this.isProjectData(resolved)) {
      this.data = migrateUiProject(resolved);
      this.trackProjectIdentity();
      this.resetAiState();
    }
    this.externalConflict = null;
    this.retainUiSelection();
    this.saveStatus = "已保存";
    this.ui.toast = message;
    this.notify();
  }
  async resolvePendingRecovery(action) {
    const pending = this.pendingRecovery;
    if (!pending) return;
    if (action === "discard") {
      this.pendingRecovery = null;
      await this.bridge.clearRecoveryJournal().catch(() => {});
      this.saveStatus = "未保存";
      this.ui.toast = "已保留磁盘版本";
      this.notify();
      return;
    }
    const current = clone(this.data);
    const backup = { id: uid(), project_id: current.project?.id || null, name: "恢复前备份", note: "恢复自动保存前自动创建", git_commit_hash: null, created_at: now() };
    this.localSnapshots.set(backup.id, current);
    await this.bridge.createSnapshot({ snapshot_id: backup.id, name: backup.name, note: backup.note, project: current }).catch(() => {});
    // Adopt the journal through the ordinary commit path so it is written to
    // canonical data by autosave and stays undoable like any other edit.
    this.pendingRecovery = null;
    this.commit("恢复自动保存", (data) => {
      const next = clone(pending.project);
      Object.keys(next).forEach((key) => { data[key] = next[key]; });
      // Recovery restores the course the shell already has open; adopting a
      // different project id would silently switch the open project and orphan
      // every reference to it.
      data.project = { ...next.project, id: current.project.id };
      data.snapshots = [backup, ...(next.snapshots || []).filter((snapshot) => snapshot.id !== backup.id)];
    });
    // Persist immediately: the user just resolved a recovery decision, and a
    // debounced write could still lose the restored content.  The write-through
    // also clears the recovery journal as part of the normal autosave path.
    await this.writeThrough();
    // The journal replaced the whole project in memory, so no AI preview, Diff
    // or result may survive it.
    this.resetAiState();
    this.ui.toast = this.recoveryWarning
      ? `已恢复自动保存内容；${this.recoveryWarning}`
      : "已恢复自动保存内容，恢复前备份已保留";
    this.notify();
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
  async initialize() {
    let session = null;
    let persisted = null;
    let recovery = null;
    try {
      session = await this.bridge.loadSession();
      this.rememberSession(session);
      if (!this.bridge.isNative() || this.bridge.projectDir) {
        persisted = await this.bridge.readProject();
        if (this.bridge.isNative() && persisted != null) {
          this.markNativeLease(this.bridge.projectDir);
          if (!this.isProjectData(persisted)) {
            await this.closeNativeProject(this.bridge.projectDir).catch(() => {});
            throw new Error("这个文件夹不是可用的课程项目，请选择正确的项目后再试。");
          }
        }
        recovery = await this.bridge.readRecoveryJournal();
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
    const projectUpdatedAt = project?.project?.updated_at || "";
    const journalSavedAt = typeof recovery?.saved_at === "string" ? recovery.saved_at : "";
    if (journalProject && project && journalSavedAt > projectUpdatedAt) {
      this.data = migrateUiProject(project);
      this.trackProjectIdentity();
      this.pendingRecovery = {
        project: migrateUiProject(journalProject),
        canonical: this.data,
        saved_at: journalSavedAt,
      };
      this.ui.toast = "发现未完成的保存；磁盘版本没有改变，请选择恢复暂存内容或保留磁盘版本。";
    } else if (journalProject && !project) {
      this.data = migrateUiProject(journalProject);
      this.trackProjectIdentity();
      this.ui.toast = "已载入未完成的保存内容。请检查后继续编辑，确认无误后再保存。";
    } else if (project) {
      this.data = migrateUiProject(project);
      this.trackProjectIdentity();
      // The browser service already has one configured project root. After a
      // refresh, reopen its shell directly instead of showing the first-launch
      // launcher and making the user click "继续工作" again. Native startup
      // keeps its existing launcher/window behavior.
      if (!this.bridge.isNative()) this.ui.screen = "project";
    }
    await this.restoreSession(session);
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
      let restoreSession = null;
      let targetOpened = false;
      try {
        if (previousLeaseActive && previousProjectDir !== projectDir && !await this.flush()) {
          throw new Error("当前项目保存失败，请重试后再切换项目");
        }
        this.nativeSwitching = true;
        restoreSession = previousLeaseActive ? this.session() : null;
        this.bridge.setProjectDir(projectDir);
        const created = await this.bridge.command("project.create", { title });
        targetOpened = true;
        // A non-null create result means the shell may already own the target
        // lease, even if the returned payload is unusable.
        this.markNativeLease(projectDir);
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
            );
          } catch (rollbackError) {
            error = rollbackError;
          }
        } else {
          this.bridge.restoreProjectDir(restoreProjectDir, restoreProjectDirFromUrl);
        }
        this.ui.toast = userFacingError(error, "无法新建课程。当前项目没有改变，请重试。");
        this.notify();
      } finally {
        this.nativeSwitching = false;
      }
      return;
    }
    this.assetPreview.clear();
    this.applyNewProject(emptyProject(title));
    this.data.project.title = title;
    this.ui.screen = "project";
    this.ui.route = "map";
    this.scheduleSave();
    this.notify();
  }
  commitNativeProject(project, reader) {
    this.assetPreview.clear();
    this.data = project;
    this.trackProjectIdentity();
    this.history = [];
    this.future = [];
    this.localSnapshots.clear();
    this.pendingRecovery = null;
    this.externalConflict = null;
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
   * Switch to another project folder.
   *
   * Durable lease invariants: the previous lease is released only after the
   * target is readable and saved; a provisional target lease is rolled back on
   * any failure, and a rejected `project_open` never releases a lease we do
   * not own.
   */
  async openProject(projectDir = "") {
    if (!this.bridge.isNative()) {
      await this.openProjectFromPicker();
      return;
    }
    if (!await this.resolveNativeSwitchPending()) return;
    const previousProjectDir = this.bridge.projectDir;
    const previousProjectDirFromUrl = this.bridge.projectDirFromUrl;
    const previousLeaseActive = this.hasNativeLease(previousProjectDir);
    if (previousLeaseActive && previousProjectDir === projectDir) return;
    const restoreProjectDir = previousLeaseActive ? previousProjectDir : null;
    const restoreProjectDirFromUrl = previousLeaseActive ? previousProjectDirFromUrl : false;
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
      if (opened == null) throw new Error("这个文件夹不是可用的课程项目，请选择正确的项目后再试。");
      targetOpened = true;
      // A non-null open result may have acquired a lease even when validation
      // below rejects its project payload; rollback must track that lease.
      this.markNativeLease(projectDir);
      if (!this.isProjectData(opened)) throw new Error("这个文件夹不是可用的课程项目，请选择正确的项目后再试。");
      const targetData = migrateUiProject(opened);
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
      );
      this.ui.toast = `已打开《${this.data.project.title}》`;
      this.notify();
    } catch (error) {
      if (!targetOpened) {
        // A rejected or empty project_open did not establish a target lease;
        // never close a directory this instance does not own or rewrite the
        // still-coherent old session.
        this.bridge.restoreProjectDir(restoreProjectDir, restoreProjectDirFromUrl);
      } else {
        try {
          await this.rollbackNativeTarget(
            projectDir,
            restoreProjectDir,
            restoreProjectDirFromUrl,
            error,
            restoreSession,
          );
        } catch (rollbackError) {
          error = rollbackError;
        }
      }
      this.ui.toast = userFacingError(error, "无法打开项目。当前项目没有改变，请重试。");
      this.notify();
    } finally {
      this.nativeSwitching = false;
    }
  }
  async openProjectFromPicker() {
    if (this.bridge.isNative()) {
      try {
        const dir = await this.bridge.selectFolder();
        if (!dir) return;
        await this.openProject(dir);
      } catch (error) {
        this.ui.toast = userFacingError(error, "无法打开项目。当前项目没有改变，请重试。");
        this.notify();
      }
      return;
    }
    let adopted = false;
    try {
      const session = await this.bridge.loadSession();
      const project = await this.bridge.readProject();
      this.assetPreview.clear();
      if (this.isProjectData(project)) {
        this.data = migrateUiProject(project);
      this.trackProjectIdentity();
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
    return {
      project_id: this.data.project.id,
      content_item_id: item?.id || this.ui.activeId || null,
      block_id: blockId || this.selectedBlock()?.id || focused?.anchor_block_id || null,
      layout_instance_id: this.ui.mode === "layout" ? layout?.id || null : null,
      role: this.ui.mode === "layout" ? "layout" : "content",
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
  async mergeImportedResult(result) {
    const payload = parseNativeValue(result);
    const warning = recoveryWarning(payload);
    if (warning) this.noteRecoveryWarning(warning);
    const project = payload?.project && this.isProjectData(payload.project)
      ? payload.project
      : payload?.value?.project && this.isProjectData(payload.value.project)
      ? payload.value.project
      : null;
    if (project) {
      this.data = migrateUiProject(project);
      this.trackProjectIdentity();
      // The shell answered an import with a whole project: treat it exactly
      // like any other project replacement.
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
    const selected = [...new Set((paths || []).filter((path) => typeof path === "string" && path.trim()))];
    if (!selected.length) return;
    let imported = 0;
    let receivedAsset = false;
    try {
      if (!await this.flush()) {
        this.ui.toast = this.ui.toast || "素材导入前没有保存成功，素材尚未导入。请先重试保存。";
        this.notify();
        return;
      }
      for (const sourcePath of selected) {
        const filename = filenameFromPath(sourcePath);
        const mimeType = mimeForFilename(filename);
        const context = this.assetContext();
        const result = await this.bridge.command("asset.import", {
          source_path: sourcePath,
          filename,
          mime_type: mimeType,
          type: assetTypeForFile(filename, mimeType),
          context,
          content_item_id: context.content_item_id,
          block_id: context.block_id,
          layout_instance_id: context.layout_instance_id,
          role: context.role,
        });
        const beforeAssets = this.data.assets.length;
        await this.mergeImportedResult(result);
        receivedAsset ||= this.data.assets.length > beforeAssets;
        imported += 1;
      }
      if (!receivedAsset && this.bridge.isNative()) {
        const refreshed = await this.bridge.readProject();
        if (this.isProjectData(refreshed)) {
          this.data = migrateUiProject(refreshed);
          // The whole project was re-read from disk: drop AI state that could
          // point at rows this version no longer has.
          this.resetAiState();
        }
      }
      this.ui.screen = "project";
      this.ui.route = "media";
      this.ui.toast = this.recoveryWarning
        ? `已导入 ${imported} 个素材；${this.recoveryWarning}`
        : `已导入 ${imported} 个素材`;
    } catch (error) {
      this.ui.toast = userFacingError(error, "素材导入没有完成。课程内容没有改变，请重试。");
    }
    this.notify();
  }
  async selectAndImportAsset() {
    if (!this.bridge.isNative()) return;
    try {
      const path = await this.bridge.selectFile();
      if (path) await this.importNativeFiles([path]);
    } catch (error) {
      this.ui.toast = userFacingError(error, "没有选中可用的素材文件，请重试。");
      this.notify();
    }
  }
  async importBrowserFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = file.name || "导入文件";
    if (/\.json$/i.test(name) || file.type === "application/json") {
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (this.isProjectData(parsed)) {
        this.loadProjectPayload(parsed);
        await this.bridge.writeProject(this.data);
        this.ui.toast = "已打开项目文件";
        this.notify();
        return;
      }
    }
    const base64 = (() => {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    })();
    if (isAssetFile(name, file.type)) {
      try {
        const context = this.assetContext();
        const asset = await this.bridge.command("asset.import", {
          filename: name,
          mime_type: file.type || mimeForFilename(name),
          type: assetTypeForFile(name, file.type),
          bytes_base64: base64,
          context,
          content_item_id: context.content_item_id,
          block_id: context.block_id,
          layout_instance_id: context.layout_instance_id,
          role: context.role,
        });
        await this.mergeImportedResult(asset);
        this.ui.toast = this.recoveryWarning
          ? `已将文件内容保存到媒体库；${this.recoveryWarning}`
          : "已将文件内容保存到媒体库";
      } catch (error) { this.ui.toast = userFacingError(error, "素材导入没有完成。课程内容没有改变，请重试。"); }
      this.ui.route = "media";
    } else {
      this.captureToInbox(new TextDecoder().decode(bytes), name.replace(/\.[^.]+$/, ""));
      this.ui.route = "inbox";
    }
    this.ui.screen = "project";
    this.notify();
  }
  undo() {
    const change = this.history.pop();
    if (!change) return;
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
    const change = this.future.pop();
    if (!change) return;
    this.history.push(change);
    this.data = clone(change.after);
    this.ui.selectedBlockId = change.selection ?? null;
    this.retainUiSelection();
    this.ui.toast = `已恢复：${change.label}`;
    this.scheduleSave();
    this.notify();
  }
  /** Return to the launcher without releasing the active project lease. */
  returnToLauncher() {
    this.ui.screen = "launcher";
    this.ui.palette = this.ui.capture = this.ui.preflight = this.ui.snapshot = false;
    this.ui.assetPicker = null;
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
    this.ui.route = "editor";
    this.ui.focusRequirementId = null;
    this.ui.selectedBlockId = null;
    this.ui.gridEditing = false;
    this.ui.assetPicker = null;
    this.ui.editingRequirementId = null;
    this.ui.assetUsageId = null;
    if (lessonChanged) this.aiSyncScope();
    this.openTab(id);
    this.scheduleSessionSave();
    this.notify();
  }
  focusRequirement(id) {
    const requirement = this.data.requirements.find((candidate) => candidate.id === id);
    if (!requirement) return;
    if (!this.data.content_items.some((item) => item.id === requirement.content_item_id)) return;
    this.ui.screen = "project";
    this.ui.activeId = requirement.content_item_id;
    this.ui.route = "editor";
    this.ui.mode = requirement.scope === "layout" ? "layout" : "writing";
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
    this.ui.mode = mode;
    const tab = this.tabs.find((candidate) => candidate.content_item_id === this.ui.activeId);
    if (tab) tab.mode = mode;
    if (!options.silent) {
      this.scheduleSessionSave();
      this.notify();
    }
  }
  setLayoutMode(mode) { this.setLayoutModeOnLayout(mode); }
  setLayoutModeOnLayout(mode) {
    const item = this.currentItem();
    if (!item) return;
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
    const defaults = { paragraph: "开始写点什么…", heading: "新的小节", quote: "引用内容", callout: "提示内容", code: "// 代码" };
    const blocks = blocksFor(this.data, item.id);
    const index = atIndex >= 0 ? Math.min(atIndex, blocks.length) : blocks.length;
    let createdId = null;
    this.commit(`新增${blockLabel(type)}`, (data) => {
      const document = data.documents.find((candidate) => candidate.content_item_id === item.id) ||
        data.documents.find((candidate) => candidate.id === item.document_id);
      if (!document) return;
      const id = uid();
      createdId = id;
      data.blocks.push({ id, document_id: document.id, parent_block_id: null, type, order_index: index, content: content || defaults[type] || "", settings: type === "heading" ? { level: 2 } : {}, created_at: now(), updated_at: now() });
      renumberBlocks(data, document.id);
    });
    if (createdId) this.ui.selectedBlockId = createdId;
    this.ui.rightPanel = type === "placeholder" ? "requirements" : this.ui.rightPanel;
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
    let requirementId = null;
    this.commit("插入占位符", (data) => {
      const document = data.documents.find((candidate) => candidate.content_item_id === item.id);
      if (!document) return;
      const placeholderId = uid();
      requirementId = uid();
      const siblings = data.blocks.filter((block) => block.document_id === document.id);
      const anchorIndex = anchor ? siblings.findIndex((block) => block.id === anchor.id) : -1;
      const index = anchorIndex >= 0 ? anchorIndex + 1 : siblings.length;
      data.blocks.push({ id: placeholderId, document_id: document.id, parent_block_id: null, type: "placeholder", order_index: index, content: text, settings: { requirement_type: type, scope: "content", requirement_id: requirementId }, created_at: now(), updated_at: now() });
      renumberBlocks(data, document.id);
      // The placeholder block itself is the canonical anchor: keeping the
      // requirement pointed at some earlier block would leave it stranded as
      // soon as that block is deleted.
      data.requirements.push({ id: requirementId, content_item_id: item.id, anchor_block_id: placeholderId, type, scope: "content", layout_instance_id: null, note: text, status: "open", priority: "normal", resolved_asset_id: null, resolved_block_id: null, created_at: now(), resolved_at: null });
    });
    if (requirementId) {
      this.ui.selectedBlockId = null;
      this.ui.rightPanel = "requirements";
      this.ui.editingRequirementId = requirementId;
    }
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
  /** Move a block to the position of another block (drag & drop reorder). */
  reorderBlockTo(sourceId, targetId) {
    const item = this.currentItem();
    if (!item || sourceId === targetId) return;
    const blocks = blocksFor(this.data, item.id);
    const from = blocks.findIndex((block) => block.id === sourceId);
    const to = blocks.findIndex((block) => block.id === targetId);
    if (from < 0 || to < 0) return;
    const ordered = blocks.map((block) => block.id);
    ordered.splice(from, 1);
    ordered.splice(to, 0, sourceId);
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
      block.settings.level = Math.max(1, Math.min(4, Number(level) || 2));
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
  recordBlockTextEdit(blockId, before, value) {
    const block = this.data.blocks.find((candidate) => candidate.id === blockId);
    if (!block) return;
    const previous = textOf(before);
    if (previous === value) {
      if (textOf(block.content) !== value) {
        // The DOM is ahead of canonical data (undo/redo during typing).
        block.content = value;
        this.markPendingEdit();
      }
      return;
    }
    block.content = previous;
    this.commit(`编辑${blockLabel(block.type)}`, (data) => {
      const target = data.blocks.find((candidate) => candidate.id === blockId);
      if (!target) return;
      target.content = value;
      target.updated_at = now();
      const document = data.documents.find((candidate) => candidate.id === target.document_id);
      if (document) document.updated_at = now();
      const item = data.content_items.find((candidate) => candidate.document_id === target.document_id);
      if (item) item.updated_at = now();
    });
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
    // A requirement owns its anchor; using the current block selection instead
    // would resolve the wrong place and break canonical consistency.
    // A layout requirement has no anchor block at all: the usage must carry
    // `block_id: null` and only reference the layout instance.
    const blockId = requirement
      ? (requirement.scope === "content" ? requirement.anchor_block_id : null)
      : options.block_id || this.ui.assetPicker?.blockId ||
        this.selectedBlock()?.id || null;
    // A usage must mirror the requirement's own scope: a content requirement
    // never carries a layout instance.
    const usageLayoutId = requirement
      ? requirement.layout_instance_id
      : (options.layout_instance_id ||
        (options.role === "layout" ? this.layout(item)?.id ?? null : null));
    this.ui.assetPicker = null;
    this.commit(`插入素材：${asset.title || asset.filename}`, (data) => {
      const contentItem = data.content_items.find((candidate) => candidate.id === item.id);
      if (!contentItem) return;
      const document = data.documents.find((candidate) => candidate.content_item_id === item.id) || data.documents.find((candidate) => candidate.id === contentItem.document_id);
      const role = requirement ? "requirement" : (options.role || (blockId ? "content" : "layout"));
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
      let targetBlockId = blockId;
      if (!targetBlockId && document && !requirement) {
        const siblings = data.blocks.filter((block) => block.document_id === document.id);
        const id = uid();
        targetBlockId = id;
        data.blocks.push(linkBlockAsset({
          id,
          document_id: document.id,
          parent_block_id: null,
          type: "paragraph",
          order_index: siblings.length,
          content: "",
          settings: {},
          created_at: now(),
          updated_at: now(),
        }, asset));
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
    if (blockId) this.ui.selectedBlockId = blockId;
    this.ui.toast = `已插入素材：${asset.title || asset.filename}`;
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
      if (patch.type) requirement.type = patch.type;
      if (["open", "resolved", "ignored"].includes(patch.status)) requirement.status = patch.status;
      const anchor = data.blocks.find((candidate) => candidate.id === requirement.anchor_block_id);
      if (anchor && anchor.type === "placeholder" && typeof patch.note === "string") {
        anchor.content = patch.note;
        anchor.settings.requirement_type = requirement.type;
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
      const result = await this.bridge.command("asset.import", {
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
      this.ui.toast = "已从收件箱保存为素材";
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
  addSection() {
    const layout = this.layout();
    if (!layout) return;
    this.commit("新增排版分区", (data) => {
      const sections = data.layout_sections.filter((section) => section.layout_instance_id === layout.id);
      data.layout_sections.push({ id: uid(), layout_instance_id: layout.id, name: `第 ${sections.length + 1} 段`, page_index: sections.length, order_index: sections.length, grid_definition: layout.grid_definition, settings: {}, created_at: now(), updated_at: now() });
    });
  }
  renameSection(sectionId, name) {
    const next = String(name ?? "").trim();
    if (!next) return;
    this.commit("重命名排版分区", (data) => {
      const section = data.layout_sections.find((candidate) => candidate.id === sectionId);
      if (!section) return;
      section.name = next;
      section.updated_at = now();
    });
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
  changeGrid(kind, amount = 1) {
    const layout = this.layout();
    if (!layout) return;
    const key = kind === "row" ? "rows" : "columns";
    const remove = amount < 0;
    this.commit(remove ? "减少网格轨道" : "增加网格轨道", (data) => {
      const target = data.layout_instances.find((candidate) => candidate.id === layout.id);
      if (!target) return;
      const tracks = Array.isArray(target.grid_definition[key]) ? [...target.grid_definition[key]] : [1];
      if (remove) {
        const wanted = Math.abs(Number(amount) || 1);
        if (tracks.length <= 1) return;
        const kept = tracks.slice(0, Math.max(1, tracks.length - wanted));
        target.grid_definition[key] = kept;
        for (const placement of data.placements.filter((candidate) => candidate.layout_instance_id === layout.id)) {
          clampPlacementToGrid(placement, target.grid_definition);
        }
        target.updated_at = now();
        return;
      }
      target.grid_definition[key] = [...tracks, ...Array.from({ length: Math.max(1, amount) }, () => 1)];
      target.updated_at = now();
    });
  }
  placeBlock(blockId) {
    const item = this.currentItem();
    const layout = this.layout();
    if (!item || !layout) return;
    this.commit("放入排版内容", (data) => {
      const target = data.layout_instances.find((candidate) => candidate.id === layout.id);
      const block = data.blocks.find((candidate) => candidate.id === blockId);
      const document = data.documents.find((candidate) => candidate.id === block?.document_id);
      if (!target || !block || document?.content_item_id !== item.id) return;
      if (data.placements.some((placement) => placement.layout_instance_id === target.id && placement.block_id === blockId)) return;
      const grid = target.grid_definition;
      let cell = nextFreeCell(grid, data.placements.filter((placement) => placement.layout_instance_id === target.id));
      // A full grid grows by one row rather than pushing a placement outside
      // the canvas.
      if (cell.row >= (Array.isArray(grid.rows) ? grid.rows.length : 1)) {
        grid.rows = [...(Array.isArray(grid.rows) ? grid.rows : [1]), 1];
        cell = nextFreeCell(grid, data.placements.filter((placement) => placement.layout_instance_id === target.id));
      }
      const section = data.layout_sections.filter((candidate) => candidate.layout_instance_id === target.id).sort((a, b) => a.order_index - b.order_index)[0];
      data.placements.push({ id: uid(), layout_instance_id: target.id, block_id: blockId, section_id: section ? section.id : null, row_start: cell.row, row_end: cell.row + 1, column_start: cell.column, column_end: cell.column + 1, alignment: {}, fit_mode: "natural", padding: {}, z_index: 0 });
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
  autofillGrid() {
    const item = this.currentItem();
    const layout = this.layout();
    if (!item || !layout || layout.mode === "flow") return;
    const blocks = blocksFor(this.data, item.id);
    this.commit("一键排版全部正文", (data) => {
      const target = data.layout_instances.find((candidate) => candidate.id === layout.id);
      if (!target) return;
      const grid = target.grid_definition;
      const existing = data.placements.filter((placement) => placement.layout_instance_id === target.id);
      const placed = new Set(existing.map((placement) => placement.block_id));
      const section = data.layout_sections.filter((candidate) => candidate.layout_instance_id === target.id).sort((a, b) => a.order_index - b.order_index)[0];
      let cursor = nextFreeCell(grid, existing);
      for (const block of blocks) {
        if (placed.has(block.id)) continue;
        if (cursor.row >= grid.rows.length) {
          grid.rows = [...grid.rows, 1, 1];
        }
        data.placements.push({ id: uid(), layout_instance_id: target.id, block_id: block.id, section_id: section ? section.id : null, row_start: cursor.row, row_end: cursor.row + 1, column_start: cursor.column, column_end: Math.min(grid.columns.length, cursor.column + 2), alignment: {}, fit_mode: "natural", padding: {}, z_index: 0 });
        cursor = nextFreeCell(grid, data.placements.filter((placement) => placement.layout_instance_id === target.id));
      }
      target.updated_at = now();
    });
    this.ui.toast = "已把还没有放入网格的正文排进去";
  }
  movePlacement(id, dr, dc) {
    const layout = this.layout();
    if (!layout) return;
    this.commit("吸附移动排版元素", (data) => {
      const target = data.layout_instances.find((candidate) => candidate.id === layout.id);
      const placement = data.placements.find((candidate) => candidate.id === id);
      if (!target || !placement) return;
      const rows = target.grid_definition.rows.length;
      const columns = target.grid_definition.columns.length;
      const rowSpan = placement.row_end - placement.row_start;
      const colSpan = placement.column_end - placement.column_start;
      placement.row_start = Math.max(0, Math.min(rows - rowSpan, Math.round(placement.row_start + dr)));
      placement.row_end = placement.row_start + rowSpan;
      placement.column_start = Math.max(0, Math.min(columns - colSpan, Math.round(placement.column_start + dc)));
      placement.column_end = placement.column_start + colSpan;
    });
  }
  resizePlacement(id, dw = 0, dh = 0) {
    const layout = this.layout();
    if (!layout) return;
    this.commit("调整排版元素尺寸", (data) => {
      const target = data.layout_instances.find((candidate) => candidate.id === layout.id);
      const placement = data.placements.find((candidate) => candidate.id === id);
      if (!target || !placement) return;
      const rows = target.grid_definition.rows.length;
      const columns = target.grid_definition.columns.length;
      placement.column_end = Math.max(placement.column_start + 1, Math.min(columns, placement.column_end + dw));
      placement.row_end = Math.max(placement.row_start + 1, Math.min(rows, placement.row_end + dh));
    });
  }
  saveVersion(name, note) {
    const snapshot = { id: uid(), project_id: this.data.project.id, name: name || "未命名版本", note: note || "", git_commit_hash: null, created_at: now() };
    this.commit("保存历史版本", (data) => data.snapshots.unshift(snapshot));
    const saved = clone(this.data);
    this.localSnapshots.set(snapshot.id, saved);
    this.bridge.createSnapshot({ snapshot_id: snapshot.id, name: snapshot.name, note: snapshot.note, project: saved }).catch(() => {});
    this.ui.snapshot = false;
    this.ui.toast = "已保存历史版本";
  }
  async restoreVersion(id) {
    let saved = this.localSnapshots.get(id);
    let nativeRestore = false;
    if (!saved) {
      saved = await this.bridge.restoreSnapshot(id, this.data.project.id);
      nativeRestore = this.bridge.isNative();
      if (saved) this.localSnapshots.set(id, clone(saved));
    }
    if (!saved) {
      this.ui.toast = "找不到这个历史版本。课程内容没有改变，请选择其他版本或继续编辑。";
      this.notify();
      return;
    }
    const current = clone(this.data);
    const nativeBackup = nativeRestore && Array.isArray(saved.snapshots) ? saved.snapshots.find((snapshot) => snapshot.name === "恢复前备份") : null;
    const backup = nativeBackup || { id: uid(), project_id: this.data.project.id, name: "恢复前备份", note: "恢复旧版本前自动创建", git_commit_hash: null, created_at: now() };
    this.localSnapshots.set(backup.id, current);
    this.commit("恢复历史版本", (data) => {
      Object.keys(data).forEach((key) => {
        if (key !== "snapshots") data[key] = clone(saved[key]);
      });
      data.snapshots = [backup, ...(saved.snapshots || []).filter((snapshot) => snapshot.id !== backup.id)];
    });
    if (!nativeRestore || !nativeBackup) this.bridge.createSnapshot({ snapshot_id: backup.id, name: backup.name, note: backup.note, project: current }).catch(() => {});
    this.ui.toast = "已恢复，恢复前备份已保留";
  }
  exportPreflight() {
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
    const overflow = layouts.reduce((sum, layoutInstance) => sum + this.data.placements.filter((placement) => placement.layout_instance_id === layoutInstance.id).filter((placement) => placement.row_end > layoutInstance.grid_definition.rows.length || placement.column_end > layoutInstance.grid_definition.columns.length).length, 0);
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
    const blocking = overflow + missingAssets;
    const warnings = content + layout + text + fonts + external + mediaDowngrades;
    return { content, layout, missingAssets, overflow, text, fonts, external, mediaDowngrades, blocking, warnings, total: blocking + warnings, issues: [] };
  }
  async openPreflight() {
    this.ui.preflight = true;
    this.ui.preflightReport = this.exportPreflight();
    this.notify();
    if (!this.bridge.isNative()) return;
    try {
      const item = this.currentItem();
      const contentItemId = this.ui.publishScope === "lesson" ? item?.id || null : null;
      const preset = { name: this.ui.publishFormat, output_type: this.ui.publishFormat, target_type: this.ui.publishFormat, platform: "通用", settings: {} };
      const report = await this.bridge.invoke("export.preflight", { preset, options: { content_item_id: contentItemId } });
      const local = this.exportPreflight();
      const errors = Array.isArray(report?.errors) ? report.errors : [];
      const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
      const blockingCount = Math.max(errors.length, local.blocking);
      const warningCount = Math.max(warnings.length, local.warnings);
      // 本地只统计「引用断链」，磁盘上文件缺失由原生检查发现；两者都会让导出被阻止，
      // 因此这一行必须同时反映原生错误，否则会出现「缺失素材文件 ✓ 0 / BLOCKING 1」的矛盾显示。
      const missingAssets = Math.max(local.missingAssets, errors.filter((issue) => issue.code === "missing_asset").length);
      this.ui.preflightReport = { ...local, missingAssets, blocking: blockingCount, warnings: warningCount, total: blockingCount + warningCount, issues: [...errors.map((issue) => ({ ...issue, severity: "blocking" })), ...warnings.map((issue) => ({ ...issue, severity: "warning" }))] };
    } catch (error) {
      this.ui.preflightReport = { ...this.exportPreflight(), blocking: 1, issues: [{ severity: "blocking", message: userFacingError(error, "导出检查没有完成。请稍后再试。") }] };
    }
    this.notify();
  }
  async exportCurrent(format = this.ui.publishFormat || "markdown") {
    const item = this.currentItem();
    if (!item) {
      this.ui.toast = "还没有可导出的课程内容。请先在课程地图创建一课，再运行导出。";
      this.notify();
      return;
    }
    const contentItemId = this.ui.publishScope === "lesson" ? item.id : null;
    if (this.bridge.isNative()) {
      try {
        if (!await this.flush()) {
          this.ui.toast = this.ui.toast || "导出前保存失败，请重试";
          this.notify();
          return;
        }
        const extensions = { markdown: "md", html: "html", web: "web", wechat: "html", pdf: "pdf", json: "json", asset_package: "assets", full_project: "project-package" };
        const stem = this.ui.publishScope === "lesson" ? `${item.code}-${item.title}` : this.data.project.title;
        const outputPath = await this.bridge.selectExportPath(`${stem}.${extensions[format] || format}`, format);
        if (!outputPath) return;
        const result = await this.bridge.exportProject(format, this.data, null, outputPath, contentItemId);
        const files = Array.isArray(result?.files) ? result.files.length : 0;
        this.ui.lastExport = { format, scope: this.ui.publishScope, path: result?.output_path || outputPath, files };
        this.ui.toast = `导出完成：${files || 1} 个文件，可在 ${this.ui.lastExport.path} 打开`;
      } catch (error) {
        this.ui.lastExport = null;
        this.ui.toast = `导出没有完成。源课程没有修改。${userFacingError(error, "请先修复导出前检查列出的问题，再重试。")}`;
      }
      this.notify();
      return;
    }
    try {
      if (!["markdown", "html", "wechat"].includes(format)) throw new Error("浏览器只能下载 Markdown、HTML 或富文本结果；课程内容没有改变，请使用桌面应用导出其他格式。");
      const items = this.ui.publishScope === "course" ? this.data.content_items.filter((candidate) => !candidate.archived) : [item];
      const contents = items.map((candidate) => format === "markdown" ? browserMarkdown(this.data, candidate) : browserHtml(this.data, candidate)).join(format === "markdown" ? "\n" : "\n");
      const extension = format === "markdown" ? "md" : "html";
      browserDownload(`${stemForExport(this.data.project.title)}-${this.ui.publishScope}.${extension}`, contents, format === "markdown" ? "text/markdown" : "text/html");
      this.ui.lastExport = { format, scope: this.ui.publishScope, path: "浏览器下载目录", files: 1 };
      this.ui.toast = "已下载导出文件";
    } catch (error) {
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
    if (this.bridge.isNative()) {
      try {
        await this.flush();
        const result = await this.bridge.command("publication.record", { publication });
        if (result?.publication) this.data.publications.unshift(result.publication);
        this.ui.toast = "已记录发布版本";
      } catch (error) {
        this.ui.toast = userFacingError(error, "发布记录没有保存。课程内容没有改变，请重试。");
      }
      this.notify();
      return;
    }
    this.commit("记录发布版本", (data) => data.publications.unshift({ id: uid(), ...publication }));
    this.ui.toast = "已记录发布版本";
    this.notify();
  }
}

/* ------------------------------------------------------------------ *
 * UI-only helpers.  These stay in the shell because they only touch
 * view state; every canonical mutation goes through WorkbenchStore.
 * ------------------------------------------------------------------ */

const ROUTES = ["overview", "map", "inbox", "board", "media", "backlog", "updates", "publish", "versions", "settings", "editor"];
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
    layout_templates: [], layout_instances: [], layout_sections: [], placements: [],
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
/** The asset preview cache resolves ids against the currently open project. */
bridge.currentProject = () => store.data;

let root = null;
try {
  root = globalThis.document?.querySelector?.("#app") ?? null;
} catch {
  root = null;
}

const views = createViews(store);

let lastToast = "";
let toastTimer = 0;

function render() {
  if (!root) return;
  root.innerHTML = store.ui.screen === "launcher" ? views.launcherView() : views.shellView();
  bindEvents();
  scheduleToastDismissal();
  const focused = store.ui.focusRequirementId;
  if (focused) queueMicrotask(() => root.querySelector(`[data-requirement-id="${focused}"]`)?.scrollIntoView({ block: "center" }));
  const selected = store.ui.selectedBlockId;
  if (selected && store.ui.mode === "writing") {
    queueMicrotask(() => root.querySelector(`[data-block-id="${selected}"]`)?.scrollIntoView({ block: "nearest" }));
  }
}

/* ------------------------------------------------------------------ *
 * DOM binding.  Selection changes render; text edits do not, so the
 * caret and IME composition survive until the field loses focus.
 * ------------------------------------------------------------------ */

const TEXT_FIELD_SELECTOR = "textarea[data-block-id], input[data-block-id]";

function flushPendingEdit(element) {
  if (!element) return;
  const block = store.data.blocks.find((candidate) => candidate.id === element.dataset.blockId);
  if (!block) return;
  const scope = element.dataset.editProperty;
  if (scope === "text") {
    // The input listener already wrote the value into canonical data, so the
    // history entry is recorded from the value typing started from.
    const baseline = element.dataset.editBaseline;
    store.recordBlockTextEdit(
      element.dataset.blockId,
      typeof baseline === "string" ? baseline : block.content,
      element.value,
    );
  } else if (scope === "title") {
    store.renameLesson(block.id, element.value);
  }
  delete element.dataset.editBaseline;
}

function handleAction(action, element, event) {
  switch (action) {
    case "close-overlay":
      store.ui.palette = store.ui.capture = store.ui.preflight = store.ui.snapshot = false;
      store.ui.assetPicker = null;
      store.notify();
      return;
    case "enter-project": store.enterProject(); return;
    case "return-launcher": store.returnToLauncher(); return;
    case "new-project": void (store.bridge.isNative() ? store.newProjectFromPicker() : store.newProject()); return;
    case "confirm-blueprint": store.confirmBlueprint(element.dataset.id); return;
    case "discard-blueprint":
      store.commit("放弃课程草稿", (data) => {
        const draft = (data.blueprint_drafts || []).find((candidate) => candidate.id === element.dataset.id);
        if (draft) draft.status = "discarded";
      });
      return;
    case "open-file": if (store.bridge.isNative()) void store.selectAndImportAsset(); else root.querySelector("[data-project-file]")?.click(); return;
    case "open-project-dir": void store.openProjectFromPicker(); return;
    case "toggle-left": store.ui.leftCollapsed = !store.ui.leftCollapsed; store.scheduleSessionSave(); store.notify(); return;
    case "toggle-right": store.ui.rightCollapsed = !store.ui.rightCollapsed; store.scheduleSessionSave(); store.notify(); return;
    case "route": store.ui.route = element.dataset.route; store.scheduleSessionSave(); store.notify(); return;
    case "open-item": store.openItem(element.dataset.id); return;
    case "prev-lesson": store.navigateLesson("previous"); return;
    case "next-lesson": store.navigateLesson("next"); return;
    case "rename-lesson": {
      const item = store.data.content_items.find((candidate) => candidate.id === element.dataset.id);
      if (!item) return;
      const next = globalThis.prompt?.("重命名这一课", item.title);
      if (typeof next === "string") store.renameLesson(item.id, next);
      return;
    }
    case "move-lesson": store.moveLesson(element.dataset.id, element.dataset.direction); return;
    case "delete-lesson": store.deleteLesson(element.dataset.id); return;
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
    case "external-reload": void store.resolveExternalConflict("reload"); return;
    case "external-merge": void store.resolveExternalConflict("merge"); return;
    case "external-keep-local": void store.resolveExternalConflict("keep-local"); return;
    case "recovery-restore": void store.resolvePendingRecovery("restore"); return;
    case "recovery-discard": void store.resolvePendingRecovery("discard"); return;
    case "save-version": store.ui.snapshot = true; store.ui.palette = false; store.notify(); return;
    case "submit-snapshot": store.saveVersion(root.querySelector("[data-snapshot-name]")?.value, root.querySelector("[data-snapshot-note]")?.value); return;
    case "restore-version": void store.restoreVersion(element.dataset.id); return;
    case "right-panel": store.ui.rightPanel = element.dataset.panel; store.ui.rightCollapsed = false; store.scheduleSessionSave(); store.notify(); return;
    case "insert-block":
      // A placeholder must always carry a Requirement, never just a block.
      if (element.dataset.type === "placeholder") store.addPlaceholder("text");
      else store.addBlock(element.dataset.type);
      return;
    case "insert-block-below": store.addBlock("paragraph", "", blocksIndexOf(element.dataset.id) + 1); return;
    case "add-block": store.addBlock("paragraph"); return;
    case "add-heading": store.addBlock("heading"); return;
    case "add-block-below": store.addBlock("paragraph", "", blocksIndexOf(element.dataset.id) + 1); return;
    case "select-block": store.selectBlock(element.dataset.id, { mode: "writing" }); return;
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
    case "delete-requirement": store.deleteRequirement(element.dataset.id); return;
    case "pick-asset-for-requirement": store.ui.assetPicker = { requirementId: element.dataset.id }; store.notify(); return;
    case "pick-asset-for-block": store.ui.assetPicker = { blockId: element.dataset.id }; store.notify(); return;
    case "pick-asset-import": store.ui.assetPicker = null; if (store.bridge.isNative()) void store.selectAndImportAsset(); else root.querySelector("[data-project-file]")?.click(); return;
    case "choose-asset": void store.insertAsset(element.dataset.id); return;
    case "insert-asset": void store.insertAsset(element.dataset.id); return;
    case "detach-asset": store.detachAsset(element.dataset.id, element.dataset.asset); return;
    case "delete-asset": store.deleteAsset(element.dataset.id); return;
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
    case "delete-block": store.deleteBlock(element.dataset.id); return;
    case "layout-mode": store.setLayoutMode(element.dataset.layoutMode); return;
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
    case "grid-new-section": store.addSection(); return;
    case "rename-section": {
      const section = store.data.layout_sections.find((candidate) => candidate.id === element.dataset.id);
      if (!section) return;
      const next = globalThis.prompt?.("重命名分区", section.name);
      if (typeof next === "string") store.renameSection(section.id, next);
      return;
    }
    case "place-block": store.placeBlock(element.dataset.id); return;
    case "unplace-block": store.unplaceBlock(element.dataset.id); return;
    case "grid-autofill": store.autofillGrid(); return;
    case "move-placement": store.movePlacement(element.dataset.id, Number(element.dataset.dr) || 0, Number(element.dataset.dc) || 0); return;
    case "resize-placement": store.resizePlacement(element.dataset.id, Number(element.dataset.dw) || 0, Number(element.dataset.dh) || 0); return;
    case "capture": store.ui.capture = true; store.ui.palette = false; store.notify(); return;
    case "submit-capture": {
      const value = root.querySelector("[data-capture-input]")?.value.trim();
      if (value) store.captureToInbox(value, value.slice(0, 32));
      store.ui.capture = false;
      store.ui.route = "inbox";
      store.notify();
      return;
    }
    case "palette": store.ui.palette = true; store.ui.paletteIndex = 0; store.ui.capture = false; store.notify(); return;
    case "palette-run": {
      const sub = element.dataset.paletteAction;
      store.ui.palette = false;
      if (sub === "route") store.ui.route = element.dataset.route;
      else if (sub === "open-item") store.openItem(element.dataset.id);
      else if (sub === "focus-requirement") store.focusRequirement(element.dataset.id);
      else if (sub === "save-version") store.ui.snapshot = true;
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
    case "ai-save-provider": {
      const read = (selector) => root.querySelector(selector)?.value ?? "";
      void store.aiSaveProvider({
        id: store.ui.aiProviderId,
        label: read("[data-ai-provider-label]"),
        base_url: read("[data-ai-base-url]"),
        default_model: read("[data-ai-default-model]"),
        models: read("[data-ai-models]").split(/[,，\s]+/).filter(Boolean),
      });
      return;
    }
    case "ai-cancel-provider": store.ui.aiProviderForm = null; store.notify(); return;
    case "ai-save-secret": {
      const input = root.querySelector("[data-ai-secret]");
      const value = input ? input.value : "";
      // The field is cleared immediately: a credential must not stay in the DOM.
      if (input) input.value = "";
      void store.aiSaveSecret(value);
      return;
    }
    case "ai-delete-secret": void store.aiDeleteSecret(); return;
    case "preflight": void store.openPreflight(); return;
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
    case "export-format": {
      const format = element.dataset.format || store.ui.publishFormat || "markdown";
      store.ui.publishFormat = format;
      const report = store.ui.preflightReport || store.exportPreflight();
      if (report.blocking) { store.ui.toast = `导出前检查还有 ${report.blocking} 个必须修复的问题。请先返回检查并修复`; store.notify(); return; }
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
    store.notify();
  }, 6000);
}

function bindEvents() {
  root.querySelectorAll("[data-action]").forEach((element) => element.addEventListener("click", (event) => {
    if (element.dataset.stopClick === "true") event.stopPropagation();
    handleAction(element.dataset.action, element, event);
  }));

  // Block text: update in place, then record one history entry on blur.
  root.querySelectorAll(TEXT_FIELD_SELECTOR).forEach((element) => {
    element.dataset.editProperty = "text";
    const sync = () => {
      const block = store.data.blocks.find((candidate) => candidate.id === element.dataset.blockId);
      if (!block) return;
      block.content = element.value;
      store.markPendingEdit();
    };
    element.addEventListener("input", sync);
    element.addEventListener("change", sync);
    element.addEventListener("focus", () => {
      store.ui.selectedBlockId = element.dataset.blockId;
      // Remember where typing started so undo can revert the edit itself.
      element.dataset.editBaseline = element.value;
      store.scheduleSessionSave();
    });
    element.addEventListener("blur", () => flushPendingEdit(element));
  });

  // Clicking anywhere in a block selects it for the right-hand panels without
  // re-rendering, so the click never steals focus from a text field.
  root.querySelectorAll("article.block[data-block-id]").forEach((element) => {
    const blockId = element.dataset.blockId;
    element.addEventListener("click", () => {
      if (store.ui.selectedBlockId === blockId) return;
      store.ui.selectedBlockId = blockId;
      store.scheduleSessionSave();
      // A full render keeps the selection rings and the right-hand panels in
      // step; text fields are skipped below so this never steals focus.
      if (document.activeElement && document.activeElement.closest?.("article.block")) return;
      store.notify();
    });
  });

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
  // Import every selected file: the picker allows multi-select and users
  // routinely add a batch of material at once.
  for (const input of root.querySelectorAll("[data-project-file]")) {
    input.addEventListener("change", (event) => {
      const files = [...(event.target.files || [])];
      if (!files.length) return;
      void (async () => {
        for (const file of files) {
          try {
            await store.importBrowserFile(file);
          } catch (error) {
            store.ui.toast = userFacingError(error, "文件导入没有完成。课程内容没有改变，请重试。");
            store.notify();
          }
        }
      })();
      event.target.value = "";
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
      const file = event.dataTransfer.files[0];
      if (file) store.importBrowserFile(file).catch((error) => { store.ui.toast = userFacingError(error, "文件导入没有完成。课程内容没有改变，请重试。"); store.notify(); });
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

/** Reorder正文 by dragging the block rail. */
function bindBlockDrag() {
  let draggingId = null;
  for (const element of root.querySelectorAll("article.block[data-block-id]")) {
    const blockId = element.dataset.blockId;
    const handle = element.querySelector(".block-handle");
    if (!handle) continue;
    handle.addEventListener("dragstart", (event) => {
      draggingId = blockId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-block-id", blockId);
    });
    handle.addEventListener("dragend", () => { draggingId = null; });
    element.addEventListener("dragover", (event) => {
      if (!draggingId || draggingId === blockId) return;
      if (event.dataTransfer.types.includes("text/plain") && !event.dataTransfer.types.includes("application/x-block-id")) return;
      event.preventDefault();
      element.classList.add("drop-before");
    });
    element.addEventListener("dragleave", () => element.classList.remove("drop-before"));
    element.addEventListener("drop", (event) => {
      element.classList.remove("drop-before");
      const source = draggingId || event.dataTransfer.getData("application/x-block-id");
      if (!source || source === blockId) return;
      event.preventDefault();
      event.stopPropagation();
      store.reorderBlockTo(source, blockId);
      draggingId = null;
    });
  }
}

document.addEventListener("keydown", (event) => {
  const command = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
  const save = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
  const capture = (event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "Space";
  const undo = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z";
  const redo = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "z";
  if (command) { event.preventDefault(); store.ui.palette = true; store.ui.paletteIndex = 0; store.ui.capture = false; store.notify(); }
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
  if (capture) { event.preventDefault(); store.ui.capture = true; store.ui.palette = false; store.notify(); }
  if (event.key === "Escape" && (store.ui.palette || store.ui.capture || store.ui.preflight || store.ui.snapshot || store.ui.assetPicker)) {
    store.ui.palette = store.ui.capture = store.ui.preflight = store.ui.snapshot = false;
    store.ui.assetPicker = null;
    store.scheduleSessionSave();
    store.notify();
  }
});

/* Native window lifecycle: flush, release the lease, then confirm exit. */
const flushAndClose = async () => {
  try {
    await store.resolveNativeSwitchPending();
    if (!await store.flush()) return;
    // Only release a lease this instance actually owns; releasing an unowned
    // directory would create a guard file for a project we never opened.
    const hadLease = store.hasNativeLease();
    if (hadLease) {
      if (store.hasNativeLease()) await store.closeNativeProject();
    }
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
  globalThis.addEventListener("beforeunload", () => {
    void flushAndClose();
  });
}

store.subscribe(() => render());
// The promise is exposed so the native shell (and the desktop boot tests) can
// wait for a fully restored window instead of guessing at a delay.  It carries
// no capability: the store itself is already reachable as `__workbench`.
globalThis.__workbenchReady = store.initialize();

// Expose the live workbench for native automation and manual inspection.  This
// is the running store only: it grants nothing the UI could not already do.
globalThis.__workbench = store;

if (root) render();

export { DesktopBridge, WorkbenchStore, browserHtml, browserMarkdown };
export { PROJECT_FILE_PICKER } from "./constants.js";
