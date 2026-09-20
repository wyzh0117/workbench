// deno-fmt-ignore-file
/*
 * Dependency-free desktop-first renderer.
 *
 * In a Tauri build, DesktopBridge forwards every persistence operation to
 * Rust commands. The browser build uses the same high-level command API
 * through the local Deno service, so canonical state never lives in UI code.
 * Components only mutate WorkbenchStore; they never call fs, Git, or secrets.
 */

import { createSerialQueue, recoveryWarning } from "./recovery.js";

const SESSION_KEY = "ai-course-workbench.session";
const NATIVE_PROJECT_COMMANDS = new Set([
  "project.open",
  "project.create",
  "project.save",
  "import.preview",
  "import.confirm",
  "asset.import",
  "snapshot.create",
  "snapshot.restore",
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
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));
const textOf = (value) => typeof value === "string" ? value : JSON.stringify(value ?? "");
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

function emptyProject(title = "AI 课程工作台示例") {
  const project = { id: uid(), title, description: "", language: "zh-CN", schema_version: "1.0.0", created_at: now(), updated_at: now(), archived: false, settings: {} };
  const stageA = { id: uid(), project_id: project.id, code: "S01", title: "认识 AI", order_index: 0, archived: false };
  const stageB = { id: uid(), project_id: project.id, code: "S02", title: "做出第一课", order_index: 1, archived: false };
  const makeItem = (stage, code, title, order) => {
    const document = { id: uid(), content_item_id: null, schema_version: "1.0.0" };
    const item = { id: uid(), project_id: project.id, stage_id: stage.id, code, title, type: "lesson", description: "", order_index: order, document_id: document.id, archived: false };
    document.content_item_id = item.id;
    return { item, document };
  };
  const first = makeItem(stageA, "S01-01", "AI 与搜索引擎的区别", 0);
  const second = makeItem(stageA, "S01-02", "把问题说清楚", 1);
  const third = makeItem(stageB, "S02-01", "做出第一份课程草稿", 0);
  const paragraph = (documentId, content, order) => ({ id: uid(), document_id: documentId, parent_block_id: null, type: "paragraph", order_index: order, content, settings: {} });
  const heading = (documentId, content, order) => ({ id: uid(), document_id: documentId, parent_block_id: null, type: "heading", order_index: order, content, settings: { level: 2 } });
  const placeholder = (documentId, order) => ({ id: uid(), document_id: documentId, parent_block_id: null, type: "placeholder", order_index: order, content: "一张搜索结果截图", settings: {} });
  const firstBlocks = [heading(first.document.id, "先理解问题，再选择工具", 0), paragraph(first.document.id, "AI 可以帮我们整理信息，但它不会替我们决定问题。", 1), placeholder(first.document.id, 2)];
  const secondBlocks = [paragraph(second.document.id, "把模糊想法拆成可回答的问题。", 0)];
  const thirdBlocks = [paragraph(third.document.id, "从一个小练习开始，逐步完成课程。", 0)];
  const req = { id: uid(), content_item_id: first.item.id, anchor_block_id: firstBlocks[2].id, type: "image", scope: "content", layout_instance_id: null, note: "补一张搜索结果截图", status: "open", priority: "normal", resolved_asset_id: null };
  const layout = { id: uid(), content_item_id: first.item.id, name: "3:4 竖版", mode: "grid", grid_definition: { columns: [1, 1, 1, 1], rows: [1, 1, 1, 1, 1, 1] }, settings: {}, schema_version: "1.0.0" };
  const section = { id: uid(), layout_instance_id: layout.id, name: "开场", page_index: 0, order_index: 0, grid_definition: { start_row: 0, end_row: 2 }, settings: {} };
  const placement = { id: uid(), layout_instance_id: layout.id, block_id: firstBlocks[0].id, section_id: section.id, row_start: 0, row_end: 1, column_start: 0, column_end: 4, fit_mode: "natural", z_index: 0 };
  const status_dimensions = Object.keys(STATUS).map((key, index) => ({ id: uid(), project_id: project.id, key, name: { content: "正文", media: "媒体", layout: "排版", review: "审核", publish: "发布", update: "更新" }[key], order_index: index, allow_custom: true }));
  const status_options = status_dimensions.flatMap((dimension) => STATUS[dimension.key].map((name, index) => ({ id: uid(), dimension_id: dimension.id, key: `${dimension.key}_${index}`, name, order_index: index, is_terminal: index === STATUS[dimension.key].length - 1 })));
  const statuses = [];
  [first.item, second.item, third.item].forEach((item) => status_dimensions.forEach((dimension) => { const options = status_options.filter((candidate) => candidate.dimension_id === dimension.id); const optionIndex = dimension.key === "content" && item === first.item ? 1 : 0; statuses.push({ id: uid(), content_item_id: item.id, dimension_id: dimension.id, option_id: options[optionIndex]?.id || options[0]?.id, updated_at: now() }); }));
  return {
    schema_version: "1.0.0",
    project,
    stages: [stageA, stageB],
    content_items: [first.item, second.item, third.item],
    documents: [first.document, second.document, third.document],
    blocks: [...firstBlocks, ...secondBlocks, ...thirdBlocks],
    requirements: [req], assets: [], asset_usages: [], status_dimensions, status_options, status_assignments: statuses,
    layout_instances: [layout], layout_sections: [section], placements: [placement],
    inbox_items: [{ id: uid(), project_id: project.id, source_type: "manual", title: "一张值得研究的截图", body: "稍后决定放进哪一课。", asset_id: null, content_item_id: null, status: "open", created_at: now(), updated_at: now() }],
    export_presets: [{ id: uid(), project_id: project.id, name: "小红书多图", output_type: "image", platform: "小红书", layout_instance_id: layout.id, page_mode: "multi_page", settings: { scale: 2 } }],
    snapshots: [], suggestions: [], publications: [],
  };
}

function blankProject(title = "未命名课程") {
  const demo = emptyProject(title);
  return {
    schema_version: demo.project.schema_version,
    project: demo.project,
    stages: [], content_items: [], documents: [], blocks: [], requirements: [],
    assets: [], asset_usages: [], status_dimensions: demo.status_dimensions || [], status_options: demo.status_options || [], status_assignments: [], layout_templates: [], layout_instances: [],
    layout_sections: [], placements: [], inbox_items: [], export_presets: [],
    course_seeds: [], blueprint_drafts: [], blueprint_nodes: [],
    conversation_sources: [], conversations: [], messages: [], context_packs: [],
    context_pack_items: [], suggestions: [], change_drafts: [], snapshots: [],
    publications: [],
  };
}

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
    if (["project.open", "project.create", "project.save", "snapshot.create", "snapshot.restore"].includes(command)) {
      return { ...input, projectDir };
    }
    if (command === "export.run") {
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
    if (["asset.import", "publication.record"].includes(command)) {
      return { input: { ...input, project_dir: projectDir } };
    }
    return { ...input, project_dir: projectDir };
  }
  async invoke(command, args) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    // `undefined` means no native shell.  A successful Tauri command may
    // legitimately resolve to `null`, which must not trigger fallback writes.
    // A native command may legitimately return null; only undefined means the
    // native shell is absent (the old boundary used `native !== undefined`),
    // so browser fallback writes are never triggered.
    if (invoke) return this.decodeBytes(await invoke(this.nativeCommand(command), this.nativeInput(command, args)));
    if (typeof fetch !== "function") throw new Error("工作台服务不可用");
    const response = await fetch(`${this.apiBase}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: command, input: args ?? {} }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.user_message || "工作台操作失败");
    }
    return this.decodeBytes(payload.value);
  }
  nativeCommand(command) {
    return {
      "project.open": "project_open",
      "project.create": "project_create",
      "project.save": "project_save",
      "import.preview": "import_preview",
      "import.confirm": "import_confirm",
      "asset.import": "asset_import",
      "snapshot.create": "create_snapshot",
      "snapshot.restore": "restore_snapshot",
      "export.run": "export_run",
      "publication.record": "publication_record",
      "secret.set": "secret_set",
      "secret.delete": "secret_delete",
      "connector.sync": "connector_sync",
      "ai.analyze": "ai_analyze",
      "suggestion.apply": "suggestion_apply",
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
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (!invoke) return await this.invoke("project.open", {});
    try {
      const result = parseNativeValue(await invoke("open_project", { projectDir, project_dir: projectDir }));
      return result?.project || result?.value?.project || result?.value || result;
    } catch (error) {
      // Keep old desktop shells usable while the native adapter rolls forward.
      const message = String(error?.message || error || "").toLowerCase();
      if (!/(unknown|not found|不存在|未注册|command)/.test(message)) throw error;
      return await this.invoke("project.open", {});
    }
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
    return await invoke("clear_recovery_journal", { projectDir: this.projectDir, project_dir: this.projectDir });
  }
  async listenNativeDrops(onPaths) {
    const listen = globalThis.__TAURI__?.event?.listen;
    if (!this.isNative() || typeof listen !== "function") return () => {};
    return await listen("tauri://drag-drop", (event) => {
      const payload = event?.payload ?? event;
      const paths = Array.isArray(payload) ? payload : payload?.paths || payload?.files || [];
      const normalized = paths.map((path) => typeof path === "string" ? path : path?.path).filter(Boolean);
      if (normalized.length) onPaths(normalized);
    });
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
        await this.saveSession({ project_dir: this.projectDir });
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
  async writeProject(project) {
    await this.invoke("project.save", { project });
  }
  async closeProject(projectDir = this.projectDir) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (!invoke || !projectDir) return;
    await invoke("project_close", { projectDir, project_dir: projectDir });
  }
  async confirmClose() {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) await invoke("confirm_close", {});
  }
  async writeRecoveryJournal(journal) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) {
      await invoke("write_recovery_journal", {
        projectDir: this.requireProjectDir(),
        contents: JSON.stringify(journal),
      });
    }
  }
  async readRecoveryJournal() {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    return invoke
      ? await invoke("read_recovery_journal", { projectDir: this.requireProjectDir() })
      : null;
  }
  async saveSession(session) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) {
      await invoke("save_session", {
        session: { ...(session || {}), project_dir: this.projectDir || null },
      });
      return;
    }
    this.memory[SESSION_KEY] = clone(session);
  }
  async loadSession() {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (invoke) {
      const session = await invoke("load_session", {});
      const projectDir = session && typeof session.project_dir === "string"
        ? session.project_dir
        : null;
      if (!this.projectDirFromUrl && projectDir) this.projectDir = projectDir;
      return projectDir ? { project_dir: projectDir } : null;
    }
    return this.memory[SESSION_KEY] || null;
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

function browserExportBlocks(data, item) {
  return (data.blocks || []).filter((block) => block.document_id === item?.document_id).sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
}
function browserExportText(value) { return typeof value === "string" ? value : JSON.stringify(value ?? ""); }
function browserMarkdown(data, item) {
  const lines = [`# ${browserExportText(item?.title || "未命名内容")}`, ""];
  const layoutOnlyAnchors = new Set((data.requirements || [])
    .filter((requirement) => requirement.content_item_id === item?.id && requirement.scope === "layout")
    .map((requirement) => requirement.anchor_block_id)
    .filter(Boolean));
  browserExportBlocks(data, item).filter((block) => !layoutOnlyAnchors.has(block.id)).forEach((block) => {
    const content = browserExportText(block.content);
    if (!content) return;
    if (block.type === "heading") lines.push(`${"#".repeat(Math.max(1, Math.min(6, Number(block.settings?.level) || 2)))} ${content}`);
    else if (block.type === "quote") lines.push(`> ${content}`);
    else if (block.type === "code") lines.push("```\n" + content + "\n```");
    else if (block.type === "divider") lines.push("---");
    else if (block.type === "placeholder") lines.push(`> 待补内容：${content}`);
    else lines.push(content);
    lines.push("");
  });
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
function browserHtml(data, item) {
  const blocks = browserExportBlocks(data, item).map((block) => {
    const content = esc(browserExportText(block.content));
    if (block.type === "heading") { const level = Math.max(1, Math.min(6, Number(block.settings?.level) || 2)); return `<h${level}>${content}</h${level}>`; }
    if (block.type === "quote") return `<blockquote>${content}</blockquote>`;
    if (block.type === "code") return `<pre><code>${content}</code></pre>`;
    if (block.type === "divider") return "<hr>";
    if (block.type === "placeholder") return `<aside class="待补内容">待补内容：${content}</aside>`;
    return `<p>${content}</p>`;
  }).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(item?.title || "未命名内容")}</title><style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font:16px/1.7 system-ui,sans-serif}blockquote{border-left:3px solid #bbb;padding-left:1rem}.待补内容{padding:.75rem;background:#fff5dc}</style></head><body><article><h1>${esc(item?.title || "未命名内容")}</h1>${blocks}</article></body></html>\n`;
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

class WorkbenchStore {
  constructor(bridge) {
    this.bridge = bridge;
    this.data = blankProject();
    this.ui = { screen: "launcher", route: "overview", mode: "writing", layoutMode: "grid", boardDimension: "content", activeId: null, focusRequirementId: null, leftCollapsed: false, rightCollapsed: false, rightPanel: "requirements", palette: false, paletteIndex: 0, capture: false, preflight: false, snapshot: false, gridEditing: false, toast: "" };
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
    this.nativeSwitchPending = null;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { this.listeners.forEach((listener) => listener()); }
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
  async resolveNativeSwitchPending() {
    const pending = this.nativeSwitchPending;
    if (!pending) return true;
    try {
      await this.closeNativeProject(pending.projectDir);
      this.nativeSwitchPending = null;
      return true;
    } catch (error) {
      this.ui.toast = `项目切换仍未完成：${error?.message || error || "新项目锁尚未释放"}`;
      this.saveStatus = "保存失败";
      this.notify();
      return false;
    }
  }
  async rollbackNativeTarget(projectDir, restoreProjectDir, restoreFromUrl, cause) {
    try {
      await this.closeNativeProject(projectDir);
    } catch (rollbackError) {
      this.nativeSwitchPending = { projectDir };
      this.bridge.restoreProjectDir(restoreProjectDir, restoreFromUrl);
      throw new Error(`项目切换失败，无法回滚新项目锁：${rollbackError?.message || rollbackError}`);
    }
    this.bridge.restoreProjectDir(restoreProjectDir, restoreFromUrl);
    await this.bridge.saveSession({ project_dir: restoreProjectDir || null });
    throw cause;
  }
  currentItem() { return this.data.content_items.find((item) => item.id === this.ui.activeId) ?? this.data.content_items[0] ?? null; }
  blocks(item = this.currentItem()) { return item ? this.data.blocks.filter((block) => block.document_id === item.document_id).sort((a, b) => a.order_index - b.order_index) : []; }
  layout(item = this.currentItem()) { return item ? this.data.layout_instances.find((candidate) => candidate.content_item_id === item.id) ?? null : null; }
  gaps(item = this.currentItem()) {
    const requirements = item ? this.data.requirements.filter((req) => req.content_item_id === item.id && req.status === "open") : [];
    return { content: requirements.filter((req) => req.scope === "content").length, layout: requirements.filter((req) => req.scope === "layout").length, total: requirements.length };
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
  commit(label, mutation) {
    const before = clone(this.data);
    mutation(this.data);
    this.data.project.updated_at = nextRevision(this.data.project.updated_at);
    this.history.push({ label, before, after: clone(this.data) });
    if (this.history.length > 50) this.history.shift();
    this.future = [];
    this.scheduleSave();
    this.notify();
  }
  markDirty() { this.data.project.updated_at = nextRevision(this.data.project.updated_at); this.scheduleSave(); this.notify(); }
  scheduleSave() {
    this.saveStatus = "正在保存…";
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.flush(); }, 350);
    this.notify();
  }
  scheduleSessionSave() {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      this.bridge.saveSession(this.session()).catch(() => {});
    }, 0);
  }
  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    return this.flushQueue(() => this.flushNow());
  }
  async flushNow() {
    let saved = false;
    this.recoveryWarning = "";
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
        try {
          const clearResult = await this.bridge.clearRecoveryJournal();
          const warning = recoveryWarning(clearResult);
          if (warning) this.noteRecoveryWarning(warning);
        } catch (error) {
          this.noteRecoveryWarning(error?.message || "恢复日志清理失败");
        }
        if (this.data.project.updated_at !== revision) continue;
        await this.bridge.saveSession(this.session());
        if (this.data.project.updated_at !== revision) continue;
        this.saveStatus = "已保存";
        saved = true;
        break;
      }
    } catch (error) {
      const message = String(error?.message || error || "");
      if (this.bridge.isNative() && /project_(?:not_open|lock_lost|lock_not_owned)/.test(message)) {
        this.clearNativeLease();
      }
      this.saveStatus = "保存失败";
      this.ui.toast = error?.message || "保存失败，请重试";
    }
    this.notify();
    return saved;
  }
  noteRecoveryWarning(value) {
    const message = String(value || "恢复日志处理失败");
    this.recoveryWarning = message;
    this.ui.toast = `项目已保存，但${message}`;
    console.warn(`[workbench] ${message}`);
  }
  session() {
    if (this.bridge.isNative()) return { project_dir: this.bridge.projectDir };
    return { project_id: this.data.project.id, active_content_item_id: this.ui.activeId, mode: this.ui.mode, right_panel: this.ui.rightPanel, left_collapsed: this.ui.leftCollapsed, right_collapsed: this.ui.rightCollapsed, tabs: this.tabs };
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
      if (!this.bridge.isNative() || this.bridge.projectDir) {
        persisted = await this.bridge.readProject();
        if (this.bridge.isNative() && persisted != null) {
          this.markNativeLease(this.bridge.projectDir);
          if (!this.isProjectData(persisted)) {
            await this.closeNativeProject(this.bridge.projectDir).catch(() => {});
            throw new Error("项目目录中没有可识别的 project.json");
          }
        }
        recovery = await this.bridge.readRecoveryJournal();
      }
    } catch (error) {
      if (this.bridge.isNative() && !this.hasNativeLease()) {
        this.bridge.restoreProjectDir(null, false);
        await this.bridge.saveSession({ project_dir: null }).catch(() => {});
        session = null;
        persisted = null;
        recovery = null;
      }
      this.ui.toast = error?.message || "无法读取本地项目";
    }
    if (this.bridge.isNative() && this.bridge.projectDir && !this.hasNativeLease()) {
      this.bridge.restoreProjectDir(null, false);
      await this.bridge.saveSession({ project_dir: null }).catch(() => {});
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
    if (journalProject && (!project || journalSavedAt > projectUpdatedAt)) {
      this.data = journalProject;
      this.ui.toast = "已载入上次自动保存的工作";
    } else if (project) {
      this.data = project;
    }
    if (this.bridge.isNative() && this.bridge.projectDir && persisted) {
      await this.bridge.saveSession(this.session()).catch(() => {});
    }
    await this.restoreSession(session);
    if (this.bridge.isNative() && !this.nativeDropUnlisten) {
      this.nativeDropUnlisten = await this.bridge.listenNativeDrops((paths) => {
        void this.importNativeFiles(paths);
      }).catch(() => null);
    }
    this.notify();
  }
  async restoreSession(session = null) {
    session ??= await this.bridge.loadSession();
    if (!session || session.project_id !== this.data.project.id) return;
    this.ui.activeId = session.active_content_item_id || this.ui.activeId;
    this.ui.mode = session.mode || this.ui.mode;
    this.ui.rightPanel = session.right_panel || this.ui.rightPanel;
    this.ui.leftCollapsed = Boolean(session.left_collapsed);
    this.ui.rightCollapsed = Boolean(session.right_collapsed);
    this.tabs = Array.isArray(session.tabs) ? session.tabs.filter((tab) => this.data.content_items.some((item) => item.id === tab.content_item_id)) : [];
    if (this.ui.activeId && !this.tabs.some((tab) => tab.content_item_id === this.ui.activeId)) this.tabs.push({ content_item_id: this.ui.activeId, mode: this.ui.mode, pinned: false, scroll_top: 0 });
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
      let targetLeaseActive = false;
      let targetRollbackAttempted = false;
      try {
        if (previousLeaseActive && previousProjectDir !== projectDir && !await this.flush()) {
          throw new Error("当前项目保存失败，请重试后再切换项目");
        }
        this.bridge.setProjectDir(projectDir);
        const created = await this.bridge.command("project.create", { title });
        this.markNativeLease(projectDir);
        targetLeaseActive = true;
        if (previousLeaseActive && previousProjectDir !== projectDir) {
          try {
            await this.closeNativeProject(previousProjectDir);
          } catch (error) {
            targetRollbackAttempted = true;
            await this.rollbackNativeTarget(projectDir, restoreProjectDir, restoreProjectDirFromUrl, error);
          }
        }
        this.data = created;
        this.ui.toast = "已创建本地项目；课程地图可继续编辑";
      } catch (error) {
        if (targetLeaseActive && !targetRollbackAttempted) {
          try {
            await this.closeNativeProject(projectDir);
          } catch (rollbackError) {
            this.nativeSwitchPending = { projectDir };
            this.bridge.restoreProjectDir(restoreProjectDir, restoreProjectDirFromUrl);
            error = new Error(`项目创建失败，无法回滚新项目锁：${rollbackError?.message || rollbackError}`);
          }
        }
        if (!this.nativeSwitchPending) this.bridge.restoreProjectDir(restoreProjectDir, restoreProjectDirFromUrl);
        this.ui.toast = error?.message || "无法创建课程";
        this.saveStatus = "保存失败";
        this.notify();
        return;
      }
      this.ui.screen = "project";
      this.ui.route = "map";
      this.ui.activeId = null;
      this.ui.focusRequirementId = null;
      this.tabs = [];
      this.history = [];
      this.future = [];
      this.notify();
      return;
    }
    try {
      const created = await this.bridge.command("project.create", { title });
      this.data = this.isProjectData(created) ? created : blankProject(title);
      const seed = await this.bridge.command("course.seed.create", {
        source_type: "blank",
        raw_text: "",
        metadata: { title },
      });
      await this.bridge.command("blueprint.build", { course_seed_id: seed.id });
      this.data = await this.bridge.command("project.open", {});
      this.ui.toast = "已创建课程草稿，请确认课程地图后开始写作";
    } catch (error) {
      this.ui.toast = error?.message || "无法创建课程";
      this.saveStatus = "保存失败";
    }
    this.ui.screen = "project";
    this.ui.route = "map";
    this.ui.activeId = null;
    this.ui.focusRequirementId = null;
    this.tabs = [];
    this.history = [];
    this.future = [];
    this.saveStatus = this.ui.toast ? this.saveStatus : "未保存";
    this.notify();
  }
  async newProjectFromPicker(title = "未命名课程") {
    if (!this.bridge.isNative()) return await this.newProject(title);
    const projectDir = await this.bridge.selectFolder();
    if (!projectDir) return;
    return await this.newProject(title, projectDir);
  }
  async openProject(projectDir = "") {
    if (!this.bridge.isNative()) return;
    if (!await this.resolveNativeSwitchPending()) return;
    const previousProjectDir = this.bridge.projectDir;
    const previousProjectDirFromUrl = this.bridge.projectDirFromUrl;
    const previousLeaseActive = this.hasNativeLease(previousProjectDir);
    const restoreProjectDir = previousLeaseActive ? previousProjectDir : null;
    const restoreProjectDirFromUrl = previousLeaseActive ? previousProjectDirFromUrl : false;
    let targetLeaseActive = false;
    let targetRollbackAttempted = false;
    try {
      if (previousLeaseActive && previousProjectDir !== projectDir && !await this.flush()) {
        throw new Error("当前项目保存失败，请重试后再切换项目");
      }
      this.bridge.setProjectDir(projectDir);
      let opened = await this.bridge.openProject(projectDir);
      if (!this.isProjectData(opened)) opened = await this.bridge.readProject();
      if (!this.isProjectData(opened)) throw new Error("项目目录中没有可识别的 project.json");
      this.markNativeLease(projectDir);
      targetLeaseActive = true;
      await this.bridge.saveSession({ project_dir: projectDir });
      if (previousLeaseActive && previousProjectDir !== projectDir) {
        try {
          await this.closeNativeProject(previousProjectDir);
        } catch (error) {
          targetRollbackAttempted = true;
          await this.rollbackNativeTarget(projectDir, restoreProjectDir, restoreProjectDirFromUrl, error);
        }
      }
      this.data = opened;
      this.history = [];
      this.future = [];
      this.localSnapshots.clear();
      this.tabs = [];
      this.ui.screen = "project";
      this.ui.route = "overview";
      this.ui.activeId = this.data.content_items[0]?.id || null;
      this.ui.toast = "已打开本地项目";
    } catch (error) {
      if (targetLeaseActive && !targetRollbackAttempted) {
        try {
          await this.closeNativeProject(projectDir);
        } catch (rollbackError) {
          this.nativeSwitchPending = { projectDir };
          this.bridge.restoreProjectDir(restoreProjectDir, restoreProjectDirFromUrl);
          error = new Error(`项目打开失败，无法回滚新项目锁：${rollbackError?.message || rollbackError}`);
        }
      }
      if (!this.nativeSwitchPending) this.bridge.restoreProjectDir(restoreProjectDir, restoreProjectDirFromUrl);
      this.ui.toast = error?.message || "无法打开本地项目";
    }
    this.notify();
  }
  async openProjectFromPicker() {
    if (!this.bridge.isNative()) return;
    const projectDir = await this.bridge.selectFolder();
    if (!projectDir) return;
    return await this.openProject(projectDir);
  }
  async confirmBlueprint(draftId) {
    try {
      const confirmed = await this.bridge.command("blueprint.confirm", { draft_id: draftId });
      if (this.isProjectData(confirmed)) this.data = confirmed;
      else this.data = await this.bridge.command("project.open", {});
      this.ui.activeId = this.data.content_items[0]?.id || null;
      this.ui.toast = "课程地图已确认，可以开始写作";
    } catch (error) { this.ui.toast = error?.message || "无法确认课程地图"; }
    this.notify();
  }
  loadProjectPayload(value) { if (!this.isProjectData(value)) throw new Error("项目文件缺少可识别的课程数据"); const defaults = blankProject(String(value.project.title || "未命名课程")); this.data = { ...defaults, ...clone(value), project: { ...defaults.project, ...clone(value.project) } }; ["stages", "content_items", "documents", "blocks", "requirements", "assets", "asset_usages", "status_dimensions", "status_options", "status_assignments", "layout_templates", "layout_instances", "layout_sections", "placements", "inbox_items", "export_presets", "course_seeds", "blueprint_drafts", "blueprint_nodes", "conversation_sources", "conversations", "messages", "context_packs", "context_pack_items", "suggestions", "change_drafts", "snapshots", "publications"].forEach((key) => { if (!Array.isArray(this.data[key])) this.data[key] = []; }); this.ui.screen = "project"; this.ui.route = "overview"; this.ui.activeId = this.data.content_items[0]?.id || null; this.ui.focusRequirementId = null; this.tabs = []; this.scheduleSessionSave(); this.notify(); }
  assetContext(blockId = null) {
    const item = this.currentItem();
    const focused = this.data.requirements.find((requirement) => requirement.id === this.ui.focusRequirementId);
    const layout = item ? this.layout(item) : null;
    return {
      project_id: this.data.project.id,
      content_item_id: item?.id || this.ui.activeId || null,
      block_id: blockId || focused?.anchor_block_id || null,
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
      this.data = project;
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
      this.ui.toast = "请先打开项目，再导入素材";
      this.notify();
      return;
    }
    const selected = [...new Set((paths || []).filter((path) => typeof path === "string" && path.trim()))];
    if (!selected.length) return;
    let imported = 0;
    let receivedAsset = false;
    try {
      if (!await this.flush()) {
        this.ui.toast = this.ui.toast || "素材导入前保存失败，请先重试";
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
        if (this.isProjectData(refreshed)) this.data = refreshed;
      }
      this.ui.screen = "project";
      this.ui.route = "media";
      this.ui.toast = this.recoveryWarning
        ? `已导入 ${imported} 个素材；${this.recoveryWarning}`
        : `已导入 ${imported} 个素材`;
    } catch (error) {
      this.ui.toast = error?.message || "素材导入失败";
    }
    this.notify();
  }
  async selectAndImportAsset() {
    if (!this.bridge.isNative()) return;
    try {
      const path = await this.bridge.selectFile();
      if (path) await this.importNativeFiles([path]);
    } catch (error) {
      this.ui.toast = error?.message || "无法选择素材文件";
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
      } catch (error) { this.ui.toast = error?.message || "素材导入失败"; }
      this.ui.route = "media";
    } else {
      await this.addInbox(new TextDecoder().decode(bytes), name.replace(/\.[^.]+$/, ""));
      this.ui.route = "inbox";
    }
    this.ui.screen = "project";
    this.notify();
  }
  undo() { const change = this.history.pop(); if (!change) return; this.future.push(change); this.data = clone(change.before); this.saveStatus = "正在保存…"; this.scheduleSave(); this.notify(); }
  redo() { const change = this.future.pop(); if (!change) return; this.history.push(change); this.data = clone(change.after); this.scheduleSave(); this.notify(); }
  enterProject() {
    if (this.bridge.isNative() && !this.bridge.projectDir) {
      void this.openProjectFromPicker();
      return;
    }
    this.ui.screen = "project";
    this.ui.route = "editor";
    this.ui.activeId = this.ui.activeId || this.data.content_items[0]?.id || null;
    if (this.ui.activeId && !this.tabs.some((tab) => tab.content_item_id === this.ui.activeId)) this.tabs.push({ content_item_id: this.ui.activeId, mode: this.ui.mode, pinned: false, scroll_top: 0 });
    this.scheduleSessionSave();
    this.notify();
  }
  openItem(id) { if (!this.data.content_items.some((item) => item.id === id)) return; this.ui.activeId = id; this.ui.route = "editor"; const tab = this.tabs.find((candidate) => candidate.content_item_id === id); if (tab) this.ui.mode = tab.mode; else this.tabs.push({ content_item_id: id, mode: this.ui.mode, pinned: false, scroll_top: 0 }); this.scheduleSessionSave(); this.notify(); }
  focusRequirement(id) { const requirement = this.data.requirements.find((candidate) => candidate.id === id); if (!requirement) return; const block = this.data.blocks.find((candidate) => candidate.id === requirement.anchor_block_id); const document = this.data.documents.find((candidate) => candidate.id === block?.document_id); const layout = requirement.layout_instance_id ? this.data.layout_instances.find((candidate) => candidate.id === requirement.layout_instance_id) : null; const contentItemId = document?.content_item_id || layout?.content_item_id; if (contentItemId) { this.ui.activeId = contentItemId; if (!this.tabs.some((tab) => tab.content_item_id === contentItemId)) this.tabs.push({ content_item_id: contentItemId, mode: "writing", pinned: false, scroll_top: 0 }); } this.ui.route = "editor"; this.ui.mode = requirement.scope === "layout" ? "layout" : "writing"; this.ui.rightPanel = "requirements"; this.ui.focusRequirementId = id; this.ui.toast = requirement.scope === "layout" ? "已定位到排版中的待补位置" : "已定位到正文中的待补位置"; this.scheduleSessionSave(); this.notify(); }
  setMode(mode) { this.ui.mode = mode; const tab = this.tabs.find((candidate) => candidate.content_item_id === this.ui.activeId); if (tab) tab.mode = mode; this.scheduleSessionSave(); this.notify(); }
  addBlock(type = "paragraph", content = "开始写点什么…") { const item = this.currentItem(); if (!item) return; this.commit("新增正文区块", (data) => { const blocks = data.blocks.filter((block) => block.document_id === item.document_id); data.blocks.push({ id: uid(), document_id: item.document_id, parent_block_id: null, type, order_index: blocks.length, content, settings: type === "heading" ? { level: 2 } : {} }); }); }
  addMapItem(title = "新建内容") { this.commit("新建课程内容", (data) => { let stage = data.stages[0]; if (!stage) { stage = { id: uid(), project_id: data.project.id, parent_stage_id: null, code: "S01", title: "第一阶段", description: "", learning_action: "", order_index: 0, archived: false, created_at: now(), updated_at: now() }; data.stages.push(stage); } const document = { id: uid(), content_item_id: null, schema_version: data.schema_version, created_at: now(), updated_at: now() }; const item = { id: uid(), project_id: data.project.id, stage_id: stage.id, code: `${stage.code}-${String(data.content_items.filter((candidate) => candidate.stage_id === stage.id).length + 1).padStart(2, "0")}`, title, type: "lesson", description: "", order_index: data.content_items.filter((candidate) => candidate.stage_id === stage.id).length, document_id: document.id, archived: false, created_at: now(), updated_at: now() }; document.content_item_id = item.id; data.documents.push(document); data.content_items.push(item); data.blocks.push({ id: uid(), document_id: document.id, parent_block_id: null, type: "paragraph", order_index: 0, content: "开始写点什么…", settings: {} }); this.ui.activeId = item.id; }); this.ui.route = "editor"; this.ui.screen = "project"; }
  addPlaceholder() { const item = this.currentItem(); if (!item) return; this.commit("插入待补内容", (data) => { const blocks = data.blocks.filter((block) => block.document_id === item.document_id); const block = { id: uid(), document_id: item.document_id, parent_block_id: null, type: "placeholder", order_index: blocks.length, content: "待补内容", settings: {} }; data.blocks.push(block); data.requirements.push({ id: uid(), content_item_id: item.id, anchor_block_id: block.id, type: "text", scope: "content", layout_instance_id: null, note: "补充这段内容", status: "open", priority: "normal", resolved_asset_id: null }); }); }
  addAsset(filename = "新素材.png") { const item = this.currentItem(); this.commit("加入媒体库", (data) => { data.assets.push({ id: uid(), project_id: data.project.id, type: "image", filename, storage_path: "assets/" + filename, mime_type: "image/png", width: null, height: null, duration_ms: null, file_size: 0, checksum: "browser:" + filename + ":" + Date.now(), title: filename, description: "", source_type: "imported", source_url: null, copyright_note: null, created_at: now(), archived: false }); }); this.ui.rightPanel = "media"; if (item) this.ui.route = "editor"; }
  resolveRequirement(id, assetId) { this.commit("完成待补内容", (data) => { const req = data.requirements.find((candidate) => candidate.id === id); if (!req) return; req.status = "resolved"; req.resolved_asset_id = assetId; req.resolved_at = now(); }); }
  updateStatus(dimension, value) { const item = this.currentItem(); if (!item) return; const canonicalDimension = (this.data.status_dimensions || []).find((candidate) => candidate.key === dimension); const option = canonicalDimension ? (this.data.status_options || []).find((candidate) => candidate.dimension_id === canonicalDimension.id && candidate.name === value) : null; this.commit("更新状态", (data) => { const status = data.status_assignments.find((candidate) => candidate.content_item_id === item.id && (candidate.dimension_key === dimension || candidate.dimension_id === canonicalDimension?.id)); if (status) { if (option) { status.dimension_id = canonicalDimension.id; status.option_id = option.id; delete status.option; delete status.dimension_key; } else { status.option = value; status.dimension_key = dimension; } } else data.status_assignments.push(option ? { id: uid(), content_item_id: item.id, dimension_id: canonicalDimension.id, option_id: option.id, updated_at: now() } : { id: uid(), content_item_id: item.id, dimension_key: dimension, option: value }); }); }
  setBoardDimension(dimension) { if (!STATUS[dimension]) return; this.ui.boardDimension = dimension; this.notify(); }
  moveBoardCard(id, option) { const dimension = this.ui.boardDimension; this.commit("拖动看板卡片", (data) => { const canonicalDimension = (data.status_dimensions || []).find((candidate) => candidate.key === dimension); const canonicalOption = canonicalDimension && (data.status_options || []).find((candidate) => candidate.dimension_id === canonicalDimension.id && candidate.name === option); const status = data.status_assignments.find((candidate) => candidate.content_item_id === id && (candidate.dimension_key === dimension || candidate.dimension_id === canonicalDimension?.id)); if (status) { if (canonicalOption) { status.dimension_id = canonicalDimension.id; status.option_id = canonicalOption.id; delete status.option; delete status.dimension_key; } else { status.option = option; status.dimension_key = dimension; } } else data.status_assignments.push(canonicalOption ? { id: uid(), content_item_id: id, dimension_id: canonicalDimension.id, option_id: canonicalOption.id, updated_at: now() } : { id: uid(), content_item_id: id, dimension_key: dimension, option }); }); }
  async addInbox(text, title = "快速收集") { try { const item = await this.bridge.command("inbox.create", { title, body: text, source_type: /^https?:/i.test(text) ? "web" : "manual" }); if (item) { this.data.inbox_items.unshift(item); this.data.project.updated_at = now(); this.saveStatus = "已保存"; this.notify(); } } catch (error) { this.ui.toast = error?.message || "无法加入收件箱"; this.notify(); } }
  async triageInbox(id, target = this.ui.activeId) { try { const item = await this.bridge.command("inbox.triage", { inbox_item_id: id, content_item_id: target }); const local = this.data.inbox_items.find((candidate) => candidate.id === id); if (local && item) Object.assign(local, item); this.notify(); } catch (error) { this.ui.toast = error?.message || "无法处理收件箱条目"; this.notify(); } }
  async assetizeInbox(id) { const item = this.data.inbox_items.find((candidate) => candidate.id === id); if (!item) return; let binary = ""; for (const byte of new TextEncoder().encode(item.body || "")) binary += String.fromCharCode(byte); try { const result = await this.bridge.command("inbox.assetize", { inbox_item_id: id, filename: `${item.title || "收件箱内容"}.txt`, type: "document", mime_type: "text/plain", bytes_base64: btoa(binary) }); if (result?.asset && !this.data.assets.some((asset) => asset.id === result.asset.id)) this.data.assets.push(result.asset); if (result?.item) Object.assign(item, result.item); this.ui.toast = "已从收件箱保存为素材"; this.notify(); } catch (error) { this.ui.toast = error?.message || "无法保存为素材"; this.notify(); } }
  ignoreInbox(id) { this.commit("忽略收件箱条目", (data) => { const item = data.inbox_items.find((candidate) => candidate.id === id); if (item) item.status = "archived"; }); }
  addSection() { const layout = this.layout(); if (!layout) return; this.commit("新增排版分区", (data) => { const sections = data.layout_sections.filter((section) => section.layout_instance_id === layout.id); data.layout_sections.push({ id: uid(), layout_instance_id: layout.id, name: "新分区", page_index: sections.length, order_index: sections.length, grid_definition: { start_row: 0, end_row: 1 }, settings: {} }); }); }
  createLayout() { const item = this.currentItem(); if (!item) return; this.commit("创建排版版本", (data) => { const layout = { id: uid(), content_item_id: item.id, template_id: null, schema_version: data.schema_version, name: "默认网格", mode: "grid", grid_definition: { columns: [1, 1, 1], rows: [1, 1, 1] }, settings: {}, created_at: now(), updated_at: now() }; data.layout_instances.push(layout); data.layout_sections.push({ id: uid(), layout_instance_id: layout.id, name: "第 1 页", page_index: 0, order_index: 0, grid_definition: layout.grid_definition, settings: {}, created_at: now(), updated_at: now() }); }); }
  setLayoutMode(mode) { this.ui.layoutMode = mode; this.ui.gridEditing = false; this.notify(); }
  changeGrid(kind, amount = 1) { const layout = this.layout(); if (!layout) return; this.commit(kind === "row" ? "增加横向轨道" : "增加纵向轨道", (data) => { const target = data.layout_instances.find((candidate) => candidate.id === layout.id); if (!target) return; const key = kind === "row" ? "rows" : "columns"; const tracks = Array.isArray(target.grid_definition[key]) ? target.grid_definition[key] : [1]; target.grid_definition[key] = [...tracks, ...Array.from({ length: amount }, () => 1)]; }); }
  addGridBlock() { const item = this.currentItem(); const layout = this.layout(); if (!item || !layout) return; this.commit("放入排版内容", (data) => { const blocks = data.blocks.filter((block) => block.document_id === item.document_id); const block = { id: uid(), document_id: item.document_id, parent_block_id: null, type: "callout", order_index: blocks.length, content: "排版中的新内容", settings: {} }; data.blocks.push(block); const grid = layout.grid_definition; data.placements.push({ id: uid(), layout_instance_id: layout.id, block_id: block.id, section_id: data.layout_sections.find((section) => section.layout_instance_id === layout.id)?.id ?? null, row_start: 1, row_end: Math.min(3, grid.rows.length), column_start: 1, column_end: Math.min(3, grid.columns.length), fit_mode: "natural", z_index: 0 }); }); }
  movePlacement(id, dr, dc) { const layout = this.layout(); if (!layout) return; this.commit("吸附移动排版元素", (data) => { const placement = data.placements.find((candidate) => candidate.id === id); if (!placement) return; const rows = layout.grid_definition.rows.length; const columns = layout.grid_definition.columns.length; const rowSpan = placement.row_end - placement.row_start; const colSpan = placement.column_end - placement.column_start; placement.row_start = Math.max(0, Math.min(rows - rowSpan, Math.round(placement.row_start + dr))); placement.row_end = placement.row_start + rowSpan; placement.column_start = Math.max(0, Math.min(columns - colSpan, Math.round(placement.column_start + dc))); placement.column_end = placement.column_start + colSpan; }); }
  saveVersion(name, note) { const snapshot = { id: uid(), name: name || "未命名版本", note: note || "", created_at: now() }; this.commit("保存历史版本", (data) => data.snapshots.unshift(snapshot)); const saved = clone(this.data); this.localSnapshots.set(snapshot.id, saved); this.bridge.createSnapshot({ snapshot_id: snapshot.id, name: snapshot.name, note: snapshot.note, project: saved }).catch(() => {}); this.ui.snapshot = false; this.ui.toast = "已保存历史版本"; }
  async restoreVersion(id) { let saved = this.localSnapshots.get(id); let nativeRestore = false; if (!saved) { saved = await this.bridge.restoreSnapshot(id, this.data.project.id); nativeRestore = this.bridge.isNative(); if (saved) this.localSnapshots.set(id, clone(saved)); } if (!saved) { this.ui.toast = "找不到这个历史版本"; this.notify(); return; } const current = clone(this.data); const nativeBackup = nativeRestore && Array.isArray(saved.snapshots) ? saved.snapshots.find((snapshot) => snapshot.name === "恢复前备份") : null; const backup = nativeBackup || { id: uid(), name: "恢复前备份", note: "恢复旧版本前自动创建", created_at: now() }; this.localSnapshots.set(backup.id, current); this.commit("恢复历史版本", (data) => { Object.keys(data).forEach((key) => { if (key !== "snapshots") data[key] = clone(saved[key]); }); data.snapshots = [backup, ...(saved.snapshots || []).filter((snapshot) => snapshot.id !== backup.id)]; }); if (!nativeRestore || !nativeBackup) this.bridge.createSnapshot({ snapshot_id: backup.id, name: backup.name, note: backup.note, project: current }).catch(() => {}); this.ui.toast = "已恢复，恢复前备份已保留"; }
  exportPreflight() {
    const item = this.currentItem();
    const layout = this.layout();
    const gaps = this.gaps(item);
    const grid = layout?.grid_definition || { rows: [1], columns: [1] };
    const overflow = this.data.placements.filter((placement) => placement.layout_instance_id === layout?.id && (placement.row_end > (grid.rows?.length || 1) || placement.column_end > (grid.columns?.length || 1) || placement.row_start < 0 || placement.column_start < 0)).length;
    const missingAssets = this.data.requirements.filter((req) => req.content_item_id === item?.id && req.status === "open" && req.resolved_asset_id && !this.data.assets.some((asset) => asset.id === req.resolved_asset_id && !asset.archived)).length;
    const settings = layout?.settings || {};
    const text = Number(settings.text_overflow || settings.textOverflow || 0) || 0;
    const fonts = Array.isArray(settings.missing_fonts) ? settings.missing_fonts.length : 0;
    const external = Array.isArray(settings.external_refs) ? settings.external_refs.length : 0;
    const blocking = overflow + missingAssets;
    const warnings = gaps.content + gaps.layout + text + fonts + external;
    return { content: gaps.content, layout: gaps.layout, missingAssets, overflow, text, fonts, external, blocking, warnings, total: blocking + warnings };
  }
  async exportCurrent(format = "markdown") {
    const item = this.currentItem();
    if (!item) { this.ui.toast = "还没有可导出的内容"; this.notify(); return; }
    const preset = (this.data.export_presets || []).find((candidate) => candidate.output_type === format) || { name: format, output_type: format, platform: "通用", page_mode: "single", settings: {} };
    try {
      if (this.bridge.isNative()) {
        if (!await this.flush()) {
          this.ui.toast = this.ui.toast || "导出前保存失败，请先重试";
          this.notify();
          return;
        }
        const extension = format === "html" ? "html" : format === "markdown" ? "md" : "json";
        const suggested = `${String(item.code || item.title || "内容").replace(/[\\/:*?"<>|]/g, "_")}.${extension}`;
        const outputPath = await this.bridge.selectExportPath(suggested, format);
        if (!outputPath) {
          this.ui.toast = "已取消导出";
          this.notify();
          return;
        }
        const native = await this.bridge.exportProject(format, this.data, preset, outputPath, item.id);
        const result = parseNativeValue(native);
        const exportedPath = nativePath(result) || result?.output_path || result?.outputPath || outputPath;
        this.ui.toast = exportedPath ? `已导出到 ${exportedPath}` : "已完成导出";
        this.notify();
        return;
      }
      const content = format === "html" ? browserHtml(this.data, item) : browserMarkdown(this.data, item);
      const ext = format === "html" ? "html" : "md";
      const mime = format === "html" ? "text/html" : "text/markdown";
      browserDownload(`${String(item.code || "内容").replace(/[\\/:*?"<>|]/g, "_")}.${ext}`, content, mime);
      this.ui.toast = `已导出${format === "html" ? "网页 HTML" : "Markdown"}`;
    } catch (error) {
      this.ui.toast = error?.message || "导出失败";
    }
    this.notify();
  }
  async recordPublication() { const item = this.currentItem(); if (!item) return; const report = this.exportPreflight(); if (report.blocking) { this.ui.toast = `仍有 ${report.blocking} 个严重问题，请先修复`; this.notify(); return; } const publication = { content_item_id: item.id, platform: "手动发布", layout_instance_id: this.layout(item)?.id || null, status: "published", version_label: "手动发布", published_at: now(), external_url: null, export_path: null }; if (this.bridge.isNative()) { try { await this.flush(); const result = await this.bridge.command("publication.record", { publication }); if (result?.publication) this.data.publications.unshift(result.publication); this.ui.toast = "已记录发布版本"; } catch (error) { this.ui.toast = error?.message || "发布记录失败"; } this.notify(); return; } this.commit("记录发布版本", (data) => data.publications.unshift({ id: uid(), ...publication })); this.ui.toast = "已记录发布版本"; this.notify(); }
}

const bridge = new DesktopBridge();
const store = new WorkbenchStore(bridge);
const root = document.querySelector("#app");
if (bridge.isNative()) {
  let closing = false;
  const flushAndClose = async () => {
    if (closing) return;
    closing = true;
    try {
      if (!await store.resolveNativeSwitchPending()) {
        throw new Error("项目切换尚未完成，关闭已取消");
      }
      const hadLease = store.hasNativeLease();
      if (hadLease && !await store.flush() && store.hasNativeLease()) {
        throw new Error("项目尚未保存，关闭已取消");
      }
      if (store.hasNativeLease()) await store.closeNativeProject();
      await bridge.confirmClose();
    } catch (error) {
      closing = false;
      store.ui.toast = error?.message || "关闭前保存失败";
      store.notify();
    }
  };
  const getCurrentWindow = globalThis.__TAURI__?.window?.getCurrentWindow;
  if (typeof getCurrentWindow === "function") {
    try {
      const currentWindow = getCurrentWindow();
      if (typeof currentWindow?.onCloseRequested === "function") {
        void currentWindow.onCloseRequested((event) => {
          event.preventDefault();
          void flushAndClose();
        }).catch(() => {});
      }
    } catch {
      // The global event fallback below covers older Tauri shells.
    }
  }
  const listen = globalThis.__TAURI__?.event?.listen;
  if (typeof listen === "function") {
    const onCloseRequested = () => {
      void flushAndClose();
    };
    void listen("tauri://close-requested", onCloseRequested).catch(() => {});
    void listen("workbench://close-requested", onCloseRequested).catch(() => {});
  }
  globalThis.addEventListener("beforeunload", () => {
    void flushAndClose();
  });
}
store.subscribe(() => render());
void store.initialize();

function render() {
  if (!root) return;
  root.innerHTML = store.ui.screen === "launcher" ? launcherView() : shellView();
  bindEvents();
  const focused = store.ui.focusRequirementId;
  if (focused) queueMicrotask(() => root.querySelector(`[data-requirement-id="${focused}"]`)?.scrollIntoView({ block: "center" }));
}

function launcherView() {
  const recent = store.data.project;
  const native = store.bridge.isNative();
  return `<section class="launcher">
    <div class="launcher-orb">✦</div><p class="eyebrow">AI COURSE WORKBENCH</p>
    <h1>把一套课程，从想法做到发布</h1>
    <p class="muted launcher-copy">本地优先、结构化保存，正文、待补、素材、排版和版本都在同一个工作台里。</p>
    <div class="launcher-actions"><button class="primary big" data-action="new-project">新建课程</button><button class="secondary big" data-action="${native ? "open-project-dir" : "open-file"}">${native ? "打开项目文件夹" : "打开现有项目"}</button>${native ? "" : `<input hidden type="file" data-project-file accept=".json,.md,.markdown,.txt,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp4,.webm,.mov,.m4v,.mp3,.wav,.m4a,.aac,.ogg,.pdf,.doc,.docx" />`}</div>
    <div class="seed-choices"><span class="muted">你现在有什么？</span><button data-action="enter-project">课程概论</button><button data-action="enter-project">课程大纲</button><button data-action="enter-project">教材目录</button><button data-action="enter-project">已有文章</button><button data-action="enter-project">资料文件夹</button><button data-action="enter-project">表格</button><button data-action="enter-project">AI 对话</button><button data-action="enter-project">一步步创建</button><button data-action="enter-project">空白课程</button></div>
    <div class="recent-card"><div><span class="eyebrow">最近项目</span><h2>${esc(recent.title)}</h2><p class="muted">上次编辑：${esc(store.data.content_items[0]?.code || "还没有内容")}</p></div><button class="primary" data-action="enter-project">继续工作 <span>→</span></button></div>
    <p class="small muted">${native ? "项目文件夹通过系统选择器打开；不需要手输路径。" : "首次启动会先进入项目启动器；日常工作只需要使用自然语言界面。"}</p>
  </section>${overlayView()}${toastView()}`;
}

function shellView() {
  const item = store.currentItem();
  return `<div class="shell ${store.ui.leftCollapsed ? "left-collapsed" : ""} ${store.ui.rightCollapsed ? "right-collapsed" : ""}">
    ${topbarView(item)}
    <div class="workspace">
      ${leftPanelView()}
      <main class="center" tabindex="-1">${centerView()}</main>
      ${rightPanelView()}
    </div>
    ${statusbarView(item)}
  </div>${overlayView()}${toastView()}`;
}

function topbarView(item) {
  return `<header class="topbar"><div class="brand"><button class="icon-button" data-action="toggle-left" title="收起左栏">${store.ui.leftCollapsed ? "☰" : "‹"}</button><span class="brand-mark">✦</span><span>AI Course Workbench</span></div><div class="project-name"><span class="dot"></span>${esc(store.data.project.title)}<span class="chevron">⌄</span></div><div class="top-actions"><span class="save-state ${store.saveStatus === "保存失败" ? "error" : ""}">${store.saveStatus === "已保存" ? "✓ " : ""}${esc(store.saveStatus)}</span><button class="icon-button" data-action="undo" title="撤销">↶</button><button class="icon-button" data-action="redo" title="恢复">↷</button><button class="secondary" data-action="save-version">保存版本</button><button class="secondary" data-action="preview">预览</button><button class="primary" data-action="preflight">导出</button><button class="icon-button" data-action="toggle-right" title="收起右栏">${store.ui.rightCollapsed ? "☰" : "›"}</button></div></header>
  <div class="tabs"><button class="tab home-tab ${store.ui.route === "overview" ? "active" : ""}" data-action="route" data-route="overview">项目概览</button>${store.tabs.map((tab) => { const target = store.data.content_items.find((candidate) => candidate.id === tab.content_item_id); return `<button class="tab ${target?.id === item?.id ? "active" : ""}" data-action="open-item" data-id="${target?.id}">${esc(target?.code || "课程")} <span class="tab-close" data-action="close-tab" data-id="${target?.id}">×</span></button>`; }).join("")}</div>`;
}

function leftPanelView() {
  return `<aside class="left-panel panel"><div class="panel-heading"><span>工作台</span><button class="icon-button" data-action="toggle-left">‹</button></div><nav>${NAV.map(([route, label, icon]) => `<button class="nav-item ${store.ui.route === route ? "active" : ""}" data-action="route" data-route="${route}"><span class="nav-icon">${icon}</span><span>${label}</span>${route === "inbox" && store.data.inbox_items.filter((item) => item.status === "open").length ? `<b class="count">${store.data.inbox_items.filter((item) => item.status === "open").length}</b>` : ""}</button>`).join("")}</nav><div class="panel-footer"><button class="nav-item" data-action="capture"><span class="nav-icon">＋</span><span>快速收集</span><kbd>⌘⇧空格</kbd></button><button class="nav-item" data-action="palette"><span class="nav-icon">⌕</span><span>搜索与命令</span><kbd>⌘K</kbd></button></div></aside>`;
}

function centerView() {
  if (store.ui.route === "editor") return editorView();
  if (store.ui.route === "map") return mapView();
  if (store.ui.route === "inbox") return inboxView();
  if (store.ui.route === "board") return boardView();
  if (store.ui.route === "media") return mediaView();
  if (store.ui.route === "versions") return versionsView();
  if (store.ui.route === "updates") return simplePage("更新中心", "待处理建议和需要更新的内容会在这里集中出现。", "✦");
  if (store.ui.route === "publish") return publishView();
  if (store.ui.route === "settings") return simplePage("项目设置", "项目文件、默认视图和工作台偏好。", "⚙");
  return overviewView();
}

function editorView() {
  const item = store.currentItem();
  if (!item) return emptyState("还没有课程内容", "先从课程地图创建一项内容。", "map", "打开课程地图");
  const modes = [["writing", "正文"], ["structure", "结构"], ["layout", "排版"], ["preview", "预览"]];
  return `<section class="editor-page"><div class="breadcrumbs"><span>课程</span><b>/</b><span>${esc(item.code)}</span><b>/</b><strong>${esc(item.title)}</strong></div><div class="editor-head"><div><span class="eyebrow">${esc(item.code)} · ${esc(item.type)}</span><h1>${esc(item.title)}</h1></div><div class="mode-switch">${modes.map(([mode, label]) => `<button class="mode-button ${store.ui.mode === mode ? "active" : ""}" data-action="mode" data-mode="${mode}">${label}</button>`).join("")}</div></div><div class="editor-body">${store.ui.mode === "writing" ? writingView() : store.ui.mode === "structure" ? structureView() : store.ui.mode === "layout" ? layoutView() : previewView()}</div></section>`;
}

function writingView() {
  const item = store.currentItem();
  return `<div class="writing-toolbar"><button class="secondary" data-action="add-block">＋ 段落</button><button class="secondary" data-action="add-heading">H 标题</button><button class="secondary" data-action="add-placeholder">＋ 待补内容</button><span class="toolbar-hint">正文顺序决定语义；排版只负责空间位置</span></div><div class="block-list">${store.blocks(item).map((block) => { const requirement = store.data.requirements.find((req) => req.anchor_block_id === block.id); const focused = requirement?.id === store.ui.focusRequirementId ? " focused" : ""; return block.type === "placeholder" ? `<article class="block placeholder-block${focused}" data-block-id="${block.id}" data-requirement-id="${requirement?.id || ""}"><div class="block-handle">⠿</div><div class="placeholder-icon">□</div><div class="block-main"><span class="eyebrow">待补内容 · ${esc(block.content)}</span><p>${esc(requirement?.note || "添加备注，之后再补")}</p></div><button class="text-button" data-action="focus-requirement" data-id="${requirement?.id || ""}">去右栏处理 →</button></article>` : `<article class="block${focused}" data-block-id="${block.id}" data-requirement-id="${requirement?.id || ""}"><div class="block-handle">⠿</div><div class="block-main">${block.type === "heading" ? `<input class="block-heading" data-block-id="${block.id}" value="${esc(textOf(block.content))}" aria-label="正文标题" />` : `<textarea class="block-text" data-block-id="${block.id}" aria-label="正文内容">${esc(textOf(block.content))}</textarea>`}</div><span class="block-type">${block.type === "heading" ? "标题" : "正文"}</span></article>`; }).join("")}</div><button class="add-block-line" data-action="add-block">＋ 继续写作</button>`;
}

function structureView() {
  const blocks = store.blocks();
  return `<div class="structure-toolbar"><span>拖动或使用箭头调整正文结构</span><button class="secondary" data-action="add-placeholder">＋ 添加待补</button></div><div class="structure-list">${blocks.map((block, index) => `<div class="structure-row"><span class="order">${String(index + 1).padStart(2, "0")}</span><span class="drag">⠿</span><span class="structure-content"><b>${esc(block.type === "placeholder" ? "待补内容" : block.type === "heading" ? "标题" : "正文")}</b><span>${esc(textOf(block.content))}</span></span><button class="icon-button" data-action="move-block" data-id="${block.id}" data-direction="up" ${index === 0 ? "disabled" : ""}>↑</button><button class="icon-button" data-action="move-block" data-id="${block.id}" data-direction="down" ${index === blocks.length - 1 ? "disabled" : ""}>↓</button></div>`).join("")}</div>`;
}

function layoutView() {
  const layout = store.layout();
  if (!layout) return `<div class="empty-state"><div class="empty-icon">▦</div><h2>还没有排版版本</h2><p class="muted">创建一个排版版本后，就能在 Flow 或 Grid 中放置正文。</p><button class="primary" data-action="create-layout">创建排版版本</button></div>`;
  const grid = layout.grid_definition;
  const placements = store.data.placements.filter((placement) => placement.layout_instance_id === layout.id);
  const sections = store.data.layout_sections.filter((section) => section.layout_instance_id === layout.id).sort((a, b) => a.order_index - b.order_index);
  if (store.ui.layoutMode === "flow") return `<div class="layout-toolbar"><button class="secondary active-tool">Flow</button><button class="secondary" data-action="layout-mode" data-layout-mode="grid">Grid</button><button class="secondary" data-action="grid-add-block">＋ 内容</button><button class="secondary" data-action="grid-new-section">＋ 分区</button><button class="secondary" data-action="mode" data-mode="preview">预览</button></div><div class="layout-meta"><span><b>${esc(layout.name)}</b> · Flow</span><span>一维文档流 · 正文顺序保持不变</span></div><div class="flow-canvas">${store.blocks().map((block, index) => `<div class="flow-placement"><span class="flow-order">${String(index + 1).padStart(2, "0")}</span><span>${esc(textOf(block.content))}</span></div>`).join("")}</div><p class="layout-note">Flow 负责上下流式排版；切换到 Grid 后可以按可变 Track 放置，同一份正文不会复制。</p>`;
  return `<div class="layout-toolbar"><button class="secondary" data-action="layout-mode" data-layout-mode="flow">Flow</button><button class="secondary active-tool">Grid</button><button class="secondary" data-action="grid-add-block">＋ 内容</button><button class="secondary ${store.ui.gridEditing ? "active-tool" : ""}" data-action="grid-toggle-edit">编辑网格</button><button class="secondary" data-action="grid-auto">自动整理</button><button class="secondary" data-action="grid-align">对齐</button><span class="toolbar-separator"></span><button class="secondary" data-action="grid-add-col">＋ 列</button><button class="secondary" data-action="grid-add-row">＋ 行</button><button class="secondary" data-action="grid-new-section">＋ 分区</button><button class="secondary" data-action="mode" data-mode="preview">预览</button></div><div class="layout-meta"><span><b>${esc(layout.name)}</b> · Grid</span><span>${grid.columns.length} 列 × ${grid.rows.length} 行 · 拖动会吸附到轨道</span></div><div class="section-strip">${sections.map((section) => `<span class="section-chip">${esc(section.name)} <small>第 ${section.page_index + 1} 段</small></span>`).join("")}</div><div class="grid-wrap ${store.ui.gridEditing ? "editing" : ""}"><div class="grid-canvas" style="--cols:${grid.columns.length};--rows:${grid.rows.length};">${store.ui.gridEditing ? gridLabels(grid) : ""}${placements.map((placement) => { const block = store.data.blocks.find((candidate) => candidate.id === placement.block_id); return `<div class="placement" style="grid-row:${placement.row_start + 1}/${placement.row_end + 1};grid-column:${placement.column_start + 1}/${placement.column_end + 1};" data-placement="${placement.id}"><span>${esc(textOf(block?.content || "内容"))}</span><div class="placement-actions"><button data-action="move-placement" data-id="${placement.id}" data-dr="-1" data-dc="0">↑</button><button data-action="move-placement" data-id="${placement.id}" data-dr="1" data-dc="0">↓</button><button data-action="move-placement" data-id="${placement.id}" data-dr="0" data-dc="-1">←</button><button data-action="move-placement" data-id="${placement.id}" data-dr="0" data-dc="1">→</button></div></div>`; }).join("")}</div></div><p class="layout-note">正常模式下网格线仅用于定位；只有“编辑网格”才允许调整轨道。Section 属于排版，不会复制正文。</p>`;
}

function gridLabels(grid) { return `<div class="track-labels cols">${grid.columns.map((_, i) => `<span>C${i + 1}</span>`).join("")}</div><div class="track-labels rows">${grid.rows.map((_, i) => `<span>R${i + 1}</span>`).join("")}</div>`; }

function previewView() {
  return `<div class="preview-toolbar"><span>预览会隐藏网格辅助线，正文顺序保持不变。</span><button class="secondary" data-action="preflight">导出前检查</button></div><article class="preview-paper">${store.blocks().map((block) => block.type === "heading" ? `<h2>${esc(textOf(block.content))}</h2>` : block.type === "placeholder" ? `<div class="preview-placeholder">待补：${esc(textOf(block.content))}</div>` : `<p>${esc(textOf(block.content))}</p>`).join("")}</article>`;
}

function overviewView() {
  const summary = { items: store.data.content_items.length, gaps: store.data.requirements.filter((req) => req.status === "open").length, inbox: store.data.inbox_items.filter((item) => item.status === "open").length, assets: store.data.assets.length };
  return `<section class="page"><div class="page-head"><div><span class="eyebrow">项目概览</span><h1>${esc(store.data.project.title)}</h1><p class="muted">从想法到发布，今天继续完成一小步。</p></div><button class="primary" data-action="route" data-route="map">打开课程地图 →</button></div><div class="summary-grid"><div class="summary-card"><span>课程内容</span><strong>${summary.items}</strong><small>项内容</small></div><div class="summary-card warning"><span>待补内容</span><strong>${summary.gaps}</strong><small>点击收件箱或右栏继续</small></div><div class="summary-card"><span>收件箱</span><strong>${summary.inbox}</strong><small>条待处理输入</small></div><div class="summary-card"><span>媒体</span><strong>${summary.assets}</strong><small>个项目素材</small></div></div><div class="overview-grid"><div class="card"><div class="card-head"><h2>继续工作</h2><button class="text-button" data-action="open-item" data-id="${store.data.content_items[0]?.id}">打开 →</button></div><div class="continue-row"><span class="continue-code">${esc(store.data.content_items[0]?.code || "—")}</span><div><b>${esc(store.data.content_items[0]?.title || "还没有内容")}</b><p class="muted">正文：起草中 · 图片：缺 ${summary.gaps}</p></div></div></div><div class="card"><div class="card-head"><h2>待处理</h2><button class="text-button" data-action="route" data-route="inbox">查看全部 →</button></div><ul class="task-list"><li><span class="task-dot orange"></span><span>收件箱</span><b>${summary.inbox}</b></li><li><span class="task-dot purple"></span><span>待补内容</span><b>${summary.gaps}</b></li><li><span class="task-dot blue"></span><span>待排版</span><b>${store.data.content_items.length}</b></li></ul></div></div></section>`;
}

function mapView() {
  const draft = (store.data.blueprint_drafts || []).find((candidate) => candidate.status === "draft");
  const draftNodes = draft ? (store.data.blueprint_nodes || []).filter((node) => node.blueprint_id === draft.id).sort((a, b) => a.order_index - b.order_index) : [];
  const draftCard = draft ? `<div class="card blueprint-confirm"><span class="eyebrow">待确认的课程地图</span><h2>${esc(draft.title)}</h2><p class="muted">确认前只保存课程输入和草稿，确认后才创建正式阶段与内容。</p><div class="blueprint-nodes">${draftNodes.map((node) => `<div class="structure-row"><span class="order">${node.node_type === "stage" ? "阶段" : "内容"}</span><span>${esc(node.title)}</span></div>`).join("")}</div><button class="primary" data-action="confirm-blueprint" data-id="${draft.id}">确认课程地图并创建内容</button></div>` : "";
  return `<section class="page"><div class="page-head"><div><span class="eyebrow">课程地图</span><h1>课程结构</h1><p class="muted">结构只维护一次，正文、看板和发布中心都会从这里读取。</p></div><button class="primary" data-action="add-map-item">＋ 新建内容</button></div>${draftCard}<div class="course-map">${store.data.stages.map((stage) => `<div class="stage-card"><div class="stage-head"><span class="stage-code">${esc(stage.code)}</span><h2>${esc(stage.title)}</h2><span class="stage-count">${store.data.content_items.filter((item) => item.stage_id === stage.id).length} 项</span></div><div class="map-items">${store.data.content_items.filter((item) => item.stage_id === stage.id).sort((a, b) => a.order_index - b.order_index).map((item) => mapItem(item)).join("")}</div></div>`).join("")}</div></section>`;
}
function mapItem(item) { const gaps = store.gaps(item); const status = store.statuses(item).find((candidate) => candidate.key === "content"); return `<button class="map-item" data-action="open-item" data-id="${item.id}"><span class="map-item-code">${esc(item.code)}</span><span class="map-item-title">${esc(item.title)}</span><span class="map-item-meta">${esc(status?.selected || "待研究")} · ${gaps.total ? `待补 ${gaps.total}` : "无待补"}</span><span>›</span></button>`; }

function inboxView() { const items = store.data.inbox_items.filter((item) => item.status !== "archived"); return `<section class="page"><div class="page-head"><div><span class="eyebrow">项目级输入</span><h1>收件箱 <sup>${items.length}</sup></h1><p class="muted">先收进来，以后再决定它是素材、正文还是待补内容。</p></div><button class="primary" data-action="capture">＋ 快速收集</button></div><div class="filter-row"><button class="filter active">全部</button><button class="filter">文字</button><button class="filter">图片</button><button class="filter">网页</button><button class="filter">文件</button></div><div class="inbox-list">${items.length ? items.map((item) => `<article class="inbox-card"><div class="inbox-type">${item.source_type === "web" ? "🔗" : item.asset_id ? "🖼" : "📝"}</div><div class="inbox-main"><span class="eyebrow">${esc(item.source_type === "web" ? "网页" : "灵感")}</span><h2>${esc(item.title)}</h2><p>${esc(item.body)}</p><small class="muted">${item.status === "triaged" ? "已分配到课程" : item.asset_id ? "已保存为素材" : "尚未决定用途"}</small></div><div class="inbox-actions"><button class="secondary" data-action="triage-inbox" data-id="${item.id}">加入当前课程</button>${item.asset_id ? "" : `<button class="secondary" data-action="assetize-inbox" data-id="${item.id}">保存为素材</button>`}<button class="text-button" data-action="ignore-inbox" data-id="${item.id}">忽略</button></div></article>`).join("") : emptyState("收件箱是空的", "用快速收集保存一句话、网页或截图。", "capture", "快速收集")}</div></section>`; }

function boardView() { const dimension = store.ui.boardDimension || "content"; const statuses = STATUS[dimension] || STATUS.content; const selected = (item) => store.statuses(item).find((candidate) => candidate.key === dimension)?.selected || statuses[0]; return `<section class="page"><div class="page-head"><div><span class="eyebrow">制作进度</span><h1>制作看板</h1><p class="muted">状态由你决定，完整度由待补自动计算；拖动卡片即可改当前维度。</p></div><select class="select" data-board-dimension>${Object.entries({ content: "正文", media: "媒体", layout: "排版", review: "审核", publish: "发布", update: "更新" }).map(([key, label]) => `<option value="${key}" ${dimension === key ? "selected" : ""}>${label}</option>`).join("")}</select></div><div class="kanban" data-board-dimension="${dimension}">${statuses.map((status) => `<div class="kanban-column" data-board-option="${esc(status)}"><div class="kanban-head"><span>${esc(status)}</span><b>${store.data.content_items.filter((item) => selected(item) === status).length}</b></div>${store.data.content_items.filter((item) => selected(item) === status).map((item) => `<button draggable="true" class="kanban-card" data-action="open-item" data-board-id="${item.id}" data-id="${item.id}"><span>${esc(item.code)}</span><b>${esc(item.title)}</b><small>${store.gaps(item).total ? `待补 ${store.gaps(item).total}` : "无待补"}</small></button>`).join("")}</div>`).join("")}</div></section>`; }

function mediaView() { return `<section class="page"><div class="page-head"><div><span class="eyebrow">项目资产</span><h1>媒体库 <sup>${store.data.assets.length}</sup></h1><p class="muted">拖入媒体库只创建素材；拖到正文或待补才会建立使用位置。</p></div><button class="primary" data-action="open-file">＋ 添加素材</button></div><input hidden type="file" data-project-file accept=".png,.jpg,.jpeg,.gif,.webp,.svg,.mp4,.webm,.mov,.m4v,.mp3,.wav,.m4a,.aac,.ogg,.pdf,.doc,.docx,.md,.markdown,.txt" /><div class="drop-zone" data-drop-zone="assets"><span class="drop-icon">⇧</span><b>拖入文件，或点击添加素材</b><small>图片、GIF、视频、音频和普通附件</small></div><div class="asset-grid">${store.data.assets.map((asset) => `<article class="asset-card"><div class="asset-thumb">${asset.type === "image" ? "▧" : "◈"}</div><div><b>${esc(asset.filename)}</b><small>${esc(asset.source_type)} · 未使用</small></div></article>`).join("")}</div></section>`; }
function versionsView() { return `<section class="page"><div class="page-head"><div><span class="eyebrow">长期历史</span><h1>版本历史</h1><p class="muted">撤销解决手滑，自动保存防丢失，历史版本帮助你回到明确节点。</p></div><button class="primary" data-action="save-version">保存版本</button></div><div class="version-list">${store.data.snapshots.length ? store.data.snapshots.map((snapshot) => `<article class="version-card"><span class="version-icon">◷</span><div><b>${esc(snapshot.name)}</b><p>${esc(snapshot.note || "没有备注")}</p><small>${new Date(snapshot.created_at).toLocaleString("zh-CN")}</small></div><button class="secondary" data-action="restore-version" data-id="${snapshot.id}">恢复</button></article>`).join("") : emptyState("还没有命名版本", "重要节点可以保存一个容易理解的版本名。", "save-version", "保存版本")}</div></section>`; }
function publishView() { const item = store.currentItem(); const publications = (store.data.publications || []).filter((publication) => publication.content_item_id === item?.id); return `<section class="page"><div class="page-head"><div><span class="eyebrow">发布中心</span><h1>发布与导出</h1><p class="muted">先做确定性的导出前检查，再记录你已经发布的版本。</p></div><button class="primary" data-action="preflight">导出前检查</button></div><div class="card publish-card"><h2>${esc(item?.code || "未选择内容")}｜${esc(item?.title || "还没有内容")}</h2><p class="muted">当前排版：${esc(store.layout()?.name || "未设置")} · 发布记录 ${publications.length} 条</p><div class="modal-actions"><button class="secondary" data-action="export-format" data-format="markdown">导出 Markdown</button><button class="secondary" data-action="export-format" data-format="html">导出 HTML</button><button class="primary" data-action="record-publication">记录已发布</button></div></div><div class="version-list">${publications.map((publication) => `<article class="version-card"><span class="version-icon">↗</span><div><b>${esc(publication.version_label)}</b><p>${esc(publication.platform)} · ${esc(publication.status)}</p><small>${esc(publication.published_at || "")}</small></div></article>`).join("") || `<div class="empty-state"><h2>还没有发布记录</h2><p class="muted">完成检查并记录第一个已发布版本。</p></div>`}</div></section>`; }
function simplePage(title, description, icon) { return `<section class="page simple-page"><div class="simple-icon">${icon}</div><span class="eyebrow">项目工作台</span><h1>${title}</h1><p class="muted">${description}</p><button class="primary" data-action="open-item" data-id="${store.currentItem()?.id}">继续编辑当前内容 →</button></section>`; }
function emptyState(title, description, action, label) { return `<div class="empty-state"><div class="empty-icon">✦</div><h2>${title}</h2><p class="muted">${description}</p><button class="primary" data-action="${action === "capture" ? "capture" : action === "map" ? "route" : "mode"}" ${action === "map" ? 'data-route="map"' : action === "writing" ? 'data-mode="writing"' : ""}>${label}</button></div>`; }

function rightPanelView() {
  const tabs = [["media", "媒体"], ["requirements", "待补"], ["status", "状态"], ["assistant", "AI 助手"], ["properties", "属性"], ["versions", "版本"]];
  return `<aside class="right-panel panel"><div class="right-tabs">${tabs.map(([key, label]) => `<button class="right-tab ${store.ui.rightPanel === key ? "active" : ""}" data-action="right-panel" data-panel="${key}">${label}</button>`).join("")}<button class="icon-button collapse-right" data-action="toggle-right">›</button></div><div class="right-content">${store.ui.rightPanel === "media" ? mediaPanel() : store.ui.rightPanel === "requirements" ? requirementsPanel() : store.ui.rightPanel === "status" ? statusPanel() : store.ui.rightPanel === "assistant" ? assistantPanel() : store.ui.rightPanel === "properties" ? propertiesPanel() : versionsPanel()}</div></aside>`;
}
function mediaPanel() { return `<div class="side-head"><div><span class="eyebrow">当前课程</span><h2>媒体库</h2></div><button class="icon-button" data-action="add-asset">＋</button></div><div class="mini-search">⌕ 搜索媒体</div><div class="side-list">${store.data.assets.length ? store.data.assets.map((asset) => `<div class="side-item"><span class="side-thumb">▧</span><span><b>${esc(asset.filename)}</b><small>未使用</small></span></div>`).join("") : `<div class="side-empty">还没有素材<br /><button class="text-button" data-action="add-asset">添加第一个素材</button></div>`}</div>`; }
function requirementsPanel() { const gaps = store.gaps(); return `<div class="side-head"><div><span class="eyebrow">完成当前内容</span><h2>待补内容 <sup>${gaps.total}</sup></h2></div><button class="icon-button" data-action="add-placeholder">＋</button></div><div class="gap-summary"><div><b>${gaps.content}</b><span>内容待补</span></div><div><b>${gaps.layout}</b><span>排版待补</span></div></div><div class="side-list">${store.data.requirements.filter((req) => req.content_item_id === store.currentItem()?.id).map((req) => `<button class="side-item requirement-item" data-action="focus-requirement" data-id="${req.id}"><span class="req-dot ${req.status === "open" ? "open" : "done"}">${req.status === "open" ? "!" : "✓"}</span><span><b>${req.status === "open" ? "待补" : "已完成"} · ${esc(req.type)}</b><small>${esc(req.note)}</small></span><span>›</span></button>`).join("") || `<div class="side-empty">当前正文没有待补内容</div>`}</div>`; }
function statusPanel() { return `<div class="side-head"><div><span class="eyebrow">由你决定</span><h2>制作状态</h2></div></div><div class="status-list">${store.statuses().map((status) => `<label class="status-row"><span>${esc(status.label)}</span><select data-status-dim="${status.key}">${status.options.map((option) => `<option ${option === status.selected ? "selected" : ""}>${option}</option>`).join("")}</select></label>`).join("")}</div><p class="side-note">状态和完整度是两件事：正文可以已定稿，同时仍有图片待补。</p>`; }
function assistantPanel() { return `<div class="side-head"><div><span class="eyebrow">只分析已勾选内容</span><h2>AI 助手</h2></div></div><label class="field-label">模型<select class="select"><option>DeepSeek</option><option>ChatGPT / OpenAI</option><option>豆包</option><option>自定义接口</option></select></label><div class="context-list"><label><input type="checkbox" checked /> 当前正文</label><label><input type="checkbox" checked /> 当前阶段</label><label><input type="checkbox" /> 当前媒体</label><label><input type="checkbox" /> 历史对话</label></div><button class="primary full" data-action="analyze">分析已选上下文</button><p class="side-note">AI 只生成建议。接受后会先进入修改草稿和 Diff，确认后才应用正文。</p>`; }
function propertiesPanel() { const item = store.currentItem(); return `<div class="side-head"><div><span class="eyebrow">当前内容</span><h2>页面属性</h2></div></div><dl class="properties"><dt>编号</dt><dd>${esc(item?.code)}</dd><dt>标题</dt><dd>${esc(item?.title)}</dd><dt>类型</dt><dd>${esc(item?.type)}</dd><dt>所属阶段</dt><dd>${esc(store.data.stages.find((stage) => stage.id === item?.stage_id)?.title || "未分组")}</dd><dt>当前排版</dt><dd>${esc(store.layout()?.name || "未设置")}</dd></dl>`; }
function versionsPanel() { return `<div class="side-head"><div><span class="eyebrow">安全恢复</span><h2>版本历史</h2></div><button class="icon-button" data-action="save-version">＋</button></div><p class="side-note">恢复旧版本前会自动保留“恢复前备份”。</p>${store.data.snapshots.slice(0, 4).map((snapshot) => `<button class="side-item" data-action="restore-version" data-id="${snapshot.id}"><span class="version-icon">◷</span><span><b>${esc(snapshot.name)}</b><small>${esc(snapshot.note || "查看版本")}</small></span></button>`).join("")}`; }

function statusbarView(item) { const gaps = store.gaps(item); const contentStatus = store.statuses(item).find((status) => status.key === "content")?.selected; const layoutStatus = store.statuses(item).find((status) => status.key === "layout")?.selected; return `<footer class="statusbar"><span class="status-code">${esc(item?.code || "未选择")}</span><span>正文：${esc(contentStatus || "待研究")}</span><span>待补：${gaps.content}</span><span>排版：${esc(layoutStatus || "未开始")}</span><span class="status-spacer"></span><span>本地优先 · 自动保存</span></footer>`; }

function overlayView() {
  if (store.ui.palette) return `<div class="overlay" data-action="close-overlay"><div class="palette modal" data-stop-click="true"><div class="palette-input"><span>⌕</span><input autofocus data-palette-input placeholder="搜索课程、素材、命令……" /></div><div class="palette-results">${paletteResults("")}</div><div class="palette-hint"><kbd>↑↓</kbd> 选择 <kbd>↵</kbd> 打开 <kbd>Esc</kbd> 关闭</div></div></div>`;
  if (store.ui.capture) return `<div class="overlay" data-action="close-overlay"><div class="capture modal" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">QUICK CAPTURE</span><h2>快速收集</h2></div><button class="icon-button" data-action="close-overlay">×</button></div><textarea autofocus data-capture-input placeholder="写点什么，或粘贴网页链接……"></textarea><label class="field-label">放入<select class="select"><option>${esc(store.data.project.title)}</option></select></label><div class="modal-actions"><button class="secondary" data-action="close-overlay">取消</button><button class="primary" data-action="submit-capture">放入收件箱</button></div></div></div>`;
  if (store.ui.preflight) { const report = store.exportPreflight(); return `<div class="overlay" data-action="close-overlay"><div class="preflight modal" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">EXPORT PREFLIGHT</span><h2>导出前检查</h2></div><button class="icon-button" data-action="close-overlay">×</button></div><label class="field-label">导出预设<select class="select">${(store.data.export_presets || []).map((preset) => `<option>${esc(preset.name)} · ${esc(preset.platform)}</option>`).join("") || "<option>未设置预设</option>"}</select></label><p class="muted">检查是结构化计算，不调用 AI；严重问题必须修复，警告可在确认后继续。</p><div class="check-list"><div><span class="check ${report.content ? "warning" : "ok"}">${report.content ? report.content : "✓"}</span><span>内容级待补</span><b>${report.content}</b></div><div><span class="check ${report.layout ? "warning" : "ok"}">${report.layout ? report.layout : "✓"}</span><span>当前排版待补</span><b>${report.layout}</b></div><div><span class="check ${report.missingAssets ? "warning" : "ok"}">${report.missingAssets ? report.missingAssets : "✓"}</span><span>缺失素材文件</span><b>${report.missingAssets}</b></div><div><span class="check ${report.overflow ? "warning" : "ok"}">${report.overflow ? report.overflow : "✓"}</span><span>超出画布</span><b>${report.overflow}</b></div><div><span class="check ${report.text ? "warning" : "ok"}">${report.text ? report.text : "✓"}</span><span>文字溢出</span><b>${report.text}</b></div><div><span class="check ${report.fonts ? "warning" : "ok"}">${report.fonts ? report.fonts : "✓"}</span><span>未加载字体</span><b>${report.fonts}</b></div><div><span class="check ${report.external ? "warning" : "ok"}">${report.external ? report.external : "✓"}</span><span>外部引用</span><b>${report.external}</b></div></div><div class="preflight-total">严重问题 <strong>${report.blocking}</strong> · 警告 <strong>${report.warnings}</strong></div><div class="modal-actions"><button class="secondary" data-action="close-overlay">返回修复</button><button class="secondary" data-action="export-format" data-format="markdown">导出 Markdown</button><button class="primary" data-action="export-format" data-format="html">导出 HTML</button></div></div></div>`; }
  if (store.ui.snapshot) return `<div class="overlay" data-action="close-overlay"><div class="capture modal" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">长期历史</span><h2>保存版本</h2></div><button class="icon-button" data-action="close-overlay">×</button></div><label class="field-label">版本名称<input data-snapshot-name placeholder="例如：第一课正文定稿" /></label><label class="field-label">备注<textarea data-snapshot-note placeholder="记录这个节点为什么重要"></textarea></label><div class="modal-actions"><button class="secondary" data-action="close-overlay">取消</button><button class="primary" data-action="submit-snapshot">保存版本</button></div></div></div>`;
  return "";
}
function paletteResults(query) { const q = String(query).toLowerCase(); const results = []; store.data.content_items.forEach((item) => { if (!q || `${item.code}${item.title}`.toLowerCase().includes(q)) results.push({ type: "课程", label: `${item.code}｜${item.title}`, action: "open-item", id: item.id }); }); store.data.assets.forEach((asset) => { if (!q || asset.filename.toLowerCase().includes(q)) results.push({ type: "素材", label: asset.filename, action: "route", route: "media" }); }); [["打开课程地图", "map"], ["打开收件箱", "inbox"], ["打开制作看板", "board"], ["保存版本", "save-version"], ["快速收集", "capture"]].forEach(([label, route]) => { if (!q || label.toLowerCase().includes(q)) results.push({ type: "命令", label, action: route === "save-version" || route === "capture" ? route : "route", route: route }); }); return results.slice(0, 8).map((result, index) => `<button class="palette-result ${index === store.ui.paletteIndex ? "selected" : ""}" data-action="palette-run" data-palette-action="${result.action}" data-id="${result.id || ""}" data-route="${result.route || ""}"><span class="result-type">${result.type}</span><b>${esc(result.label)}</b><span>↵</span></button>`).join("") || `<div class="no-results">没有找到匹配内容</div>`; }
function toastView() { return store.ui.toast ? `<div class="toast" role="status">${esc(store.ui.toast)}<button class="icon-button" data-action="clear-toast">×</button></div>` : ""; }

function bindEvents() {
  root.querySelectorAll("[data-action]").forEach((element) => element.addEventListener("click", (event) => {
    if (element.dataset.stopClick === "true") event.stopPropagation();
    const action = element.dataset.action;
    if (action === "close-overlay") { store.ui.palette = store.ui.capture = store.ui.preflight = store.ui.snapshot = false; store.notify(); return; }
    if (action === "enter-project") { store.enterProject(); return; }
    if (action === "new-project") { void (store.bridge.isNative() ? store.newProjectFromPicker() : store.newProject()); return; }
    if (action === "confirm-blueprint") { void store.confirmBlueprint(element.dataset.id); return; }
    if (action === "open-file") { if (store.bridge.isNative()) void store.selectAndImportAsset(); else root.querySelector("[data-project-file]")?.click(); return; }
    if (action === "open-project-dir") { void store.openProjectFromPicker(); return; }
    if (action === "toggle-left") { store.ui.leftCollapsed = !store.ui.leftCollapsed; store.scheduleSessionSave(); store.notify(); return; }
    if (action === "toggle-right") { store.ui.rightCollapsed = !store.ui.rightCollapsed; store.scheduleSessionSave(); store.notify(); return; }
    if (action === "route") { store.ui.route = element.dataset.route; store.scheduleSessionSave(); store.notify(); return; }
    if (action === "open-item") { store.openItem(element.dataset.id); return; }
    if (action === "close-tab") { event.stopPropagation(); const id = element.dataset.id; store.tabs = store.tabs.filter((tab) => tab.content_item_id !== id || tab.pinned); if (store.ui.activeId === id) { const next = store.tabs.at(-1); store.ui.activeId = next?.content_item_id || store.data.content_items[0]?.id; if (next) store.ui.mode = next.mode; } store.scheduleSessionSave(); store.notify(); return; }
    if (action === "mode") { store.setMode(element.dataset.mode); return; }
    if (action === "preview") { store.setMode("preview"); store.ui.route = "editor"; store.notify(); return; }
    if (action === "undo") { store.undo(); return; }
    if (action === "redo") { store.redo(); return; }
    if (action === "save-version") { store.ui.snapshot = true; store.ui.palette = false; store.notify(); return; }
    if (action === "submit-snapshot") { store.saveVersion(root.querySelector("[data-snapshot-name]")?.value, root.querySelector("[data-snapshot-note]")?.value); return; }
    if (action === "restore-version") { store.restoreVersion(element.dataset.id); return; }
    if (action === "right-panel") { store.ui.rightPanel = element.dataset.panel; store.ui.rightCollapsed = false; store.scheduleSessionSave(); store.notify(); return; }
    if (action === "add-block") { store.addBlock(); return; }
    if (action === "add-heading") { store.addBlock("heading", "新的小节"); return; }
    if (action === "add-placeholder") { store.addPlaceholder(); store.ui.rightPanel = "requirements"; return; }
    if (action === "focus-requirement") { store.focusRequirement(element.dataset.id); return; }
    if (action === "move-block") { const blocks = store.blocks(); const index = blocks.findIndex((block) => block.id === element.dataset.id); const target = element.dataset.direction === "up" ? index - 1 : index + 1; if (index >= 0 && blocks[target]) store.commit("调整正文顺序", (data) => { const a = data.blocks.find((block) => block.id === blocks[index].id); const b = data.blocks.find((block) => block.id === blocks[target].id); const order = a.order_index; a.order_index = b.order_index; b.order_index = order; }); return; }
    if (action === "grid-toggle-edit") { store.ui.gridEditing = !store.ui.gridEditing; store.notify(); return; }
    if (action === "layout-mode") { store.setLayoutMode(element.dataset.layoutMode); return; }
    if (action === "grid-add-row") { store.changeGrid("row"); return; }
    if (action === "grid-add-col") { store.changeGrid("column"); return; }
    if (action === "grid-new-section") { store.addSection(); return; }
    if (action === "create-layout") { store.createLayout(); return; }
    if (action === "grid-add-block") { store.addGridBlock(); return; }
    if (action === "grid-auto") { store.ui.toast = "已按内容边界自动整理（仍可撤销）"; store.notify(); return; }
    if (action === "grid-align") { store.ui.toast = "已对齐到最近轨道"; store.notify(); return; }
    if (action === "move-placement") { store.movePlacement(element.dataset.id, Number(element.dataset.dr), Number(element.dataset.dc)); return; }
    if (action === "capture") { store.ui.capture = true; store.ui.palette = false; store.notify(); return; }
    if (action === "submit-capture") { const value = root.querySelector("[data-capture-input]")?.value.trim(); if (value) store.addInbox(value, value.slice(0, 32)); store.ui.capture = false; store.ui.route = "inbox"; store.notify(); return; }
    if (action === "palette") { store.ui.palette = true; store.ui.paletteIndex = 0; store.ui.capture = false; store.notify(); return; }
    if (action === "palette-run") { const subAction = element.dataset.paletteAction; store.ui.palette = false; if (subAction === "route") store.ui.route = element.dataset.route; else if (subAction === "open-item") store.openItem(element.dataset.id); else if (subAction === "save-version") store.ui.snapshot = true; else if (subAction === "capture") store.ui.capture = true; store.scheduleSessionSave(); store.notify(); return; }
    if (action === "add-asset") { store.addAsset(); return; }
    if (action === "triage-inbox") { store.triageInbox(element.dataset.id); return; }
    if (action === "assetize-inbox") { void store.assetizeInbox(element.dataset.id); return; }
    if (action === "ignore-inbox") { store.ignoreInbox(element.dataset.id); return; }
    if (action === "analyze") { store.ui.rightPanel = "assistant"; store.ui.toast = "AI 连接器尚未配置：未生成建议，也未修改正文"; store.notify(); return; }
    if (action === "preflight") { store.ui.preflight = true; store.notify(); return; }
    if (action === "export-format") { const report = store.exportPreflight(); if (report.blocking) { store.ui.toast = `仍有 ${report.blocking} 个严重问题，请先修复`; store.notify(); return; } store.ui.preflight = false; void store.exportCurrent(element.dataset.format || "markdown"); return; }
    if (action === "export-anyway") { const report = store.exportPreflight(); if (report.blocking) { store.ui.toast = `仍有 ${report.blocking} 个严重问题，请先修复`; store.notify(); return; } store.ui.preflight = false; void store.exportCurrent("markdown"); return; }
    if (action === "record-publication") { store.recordPublication(); return; }
    if (action === "clear-toast") { store.ui.toast = ""; store.notify(); return; }
    if (action === "add-map-item") { store.addMapItem(); return; }
  }));
  root.querySelectorAll("textarea[data-block-id], input[data-block-id]").forEach((element) => element.addEventListener("input", () => { const block = store.data.blocks.find((candidate) => candidate.id === element.dataset.blockId); if (block) { block.content = element.value; store.markDirty(); } }));
  root.querySelectorAll("select[data-status-dim]").forEach((element) => element.addEventListener("change", () => store.updateStatus(element.dataset.statusDim, element.value)));
  root.querySelector("select[data-board-dimension]")?.addEventListener("change", (event) => store.setBoardDimension(event.target.value));
  root.querySelector("[data-project-file]")?.addEventListener("change", (event) => { const file = event.target.files?.[0]; if (!file) return; store.importBrowserFile(file).catch((error) => { store.ui.toast = error?.message || "无法导入文件"; store.notify(); }); event.target.value = ""; });
  root.querySelector("[data-palette-input]")?.addEventListener("input", (event) => { store.ui.paletteIndex = 0; const results = root.querySelector(".palette-results"); if (results) results.innerHTML = paletteResults(event.target.value); });
  root.querySelector("[data-drop-zone]")?.addEventListener("dragover", (event) => { event.preventDefault(); event.currentTarget.classList.add("dragging"); });
  root.querySelector("[data-drop-zone]")?.addEventListener("dragleave", (event) => event.currentTarget.classList.remove("dragging"));
  root.querySelector("[data-drop-zone]")?.addEventListener("drop", (event) => { event.preventDefault(); event.currentTarget.classList.remove("dragging"); const file = event.dataTransfer.files[0]; if (file) store.importBrowserFile(file).catch((error) => { store.ui.toast = error?.message || "无法导入文件"; store.notify(); }); });
  root.querySelectorAll("[data-board-option]").forEach((column) => { column.addEventListener("dragover", (event) => event.preventDefault()); column.addEventListener("drop", (event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain"); if (id) store.moveBoardCard(id, column.dataset.boardOption); }); });
  root.querySelectorAll("[data-board-id]").forEach((card) => card.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", card.dataset.boardId)));
}

document.addEventListener("keydown", (event) => {
  const command = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
  const capture = (event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "Space";
  if (command) { event.preventDefault(); store.ui.palette = true; store.ui.paletteIndex = 0; store.ui.capture = false; store.notify(); }
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
  if (event.key === "Escape" && (store.ui.palette || store.ui.capture || store.ui.preflight || store.ui.snapshot)) { store.ui.palette = store.ui.capture = store.ui.preflight = store.ui.snapshot = false; store.scheduleSessionSave(); store.notify(); }
});

render();

export { WorkbenchStore };
