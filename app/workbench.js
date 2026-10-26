/** Workbench 4.0 production entry. No sample projects, offline AI or simulated results. */
import {
  insertBlock,
  moveItem,
  newId,
  normalizeWebUrl,
  parseDocument,
  pickPath,
  previewUrl,
  removeBlock,
  serializeDocument,
  sidebarWidth,
} from "./workbench-model.js";
import {
  DocumentSession,
  errorMessage,
  flushStableDocument,
  insertDiscoveredImage,
  LatestRequest,
  readImportSnapshot,
  SourceSelection,
  WorkbenchBridge,
} from "./workbench-runtime.js";
import { initialViewState, renderWorkbench } from "./workbench-view.js";
const root = typeof document === "undefined"
  ? null
  : document.getElementById("app");
const bridge = new WorkbenchBridge(),
  session = new DocumentSession(bridge),
  state = initialViewState();
state.native = bridge.native;
const readerRequests = new LatestRequest(),
  folderRequests = new LatestRequest(),
  sourceSelection = new SourceSelection();
let saveTimer = null,
  saveBlocked = false,
  lastFocus = null,
  previewGeneration = 0;
function prefs() {
  try {
    return JSON.parse(localStorage.getItem("workbench.v4.preferences") || "{}");
  } catch {
    return {};
  }
}
function persistPrefs() {
  try {
    localStorage.setItem(
      "workbench.v4.preferences",
      JSON.stringify({
        leftWidth: state.leftWidth,
        rightWidth: state.rightWidth,
        leftCollapsed: state.leftCollapsed,
        rightCollapsed: state.rightCollapsed,
        selectedProvider: state.selectedProvider,
        selectedModel: state.selectedModel,
      }),
    );
  } catch { /* Preferences never block editing. */ }
}
function viewState() {
  return {
    ...state,
    document: session.document,
    path: session.path,
    dirty: session.dirty,
  };
}
function render() {
  if (!root) return;
  const editorScroll = root.querySelector(".document-stage")?.scrollTop || 0,
    leftScroll = root.querySelector("#library-body")?.scrollTop || 0,
    rightScroll = root.querySelector("#research-body")?.scrollTop || 0;
  const focused = document.activeElement,
    focusToken = focused?.dataset?.edit
      ? [
        focused.dataset.edit,
        focused.dataset.id || "",
        focused.dataset.chapter || "",
      ]
      : null,
    selectionStart = focused?.selectionStart,
    selectionEnd = focused?.selectionEnd;
  root.innerHTML = renderWorkbench(viewState());
  root.querySelector(".document-stage")?.scrollTo?.(0, editorScroll);
  root.querySelector("#library-body")?.scrollTo?.(0, leftScroll);
  root.querySelector("#research-body")?.scrollTo?.(0, rightScroll);
  fitEditors();
  if (focusToken) {
    const target = [...root.querySelectorAll("[data-edit]")].find((n) =>
      n.dataset.edit === focusToken[0] &&
      (n.dataset.id || "") === focusToken[1] &&
      (n.dataset.chapter || "") === focusToken[2]
    );
    target?.focus({ preventScroll: true });
    if (typeof selectionStart === "number") {
      target?.setSelectionRange?.(selectionStart, selectionEnd);
    }
  }
  if (
    state.modal && !focusToken &&
    !root.querySelector(".modal")?.contains(document.activeElement)
  ) {
    root.querySelector(
      ".modal input:not([type=hidden]),.modal textarea,.modal select,.modal button",
    )?.focus({ preventScroll: true });
  }
}
function fitEditors() {
  root?.querySelectorAll(".block-text").forEach((node) => {
    node.style.height = "auto";
    node.style.height = Math.max(45, node.scrollHeight) + "px";
  });
}
function notice(message, kind = "info") {
  state.notice = message;
  state.noticeKind = kind;
  render();
}
function report(error) {
  notice(errorMessage(error), "error");
}
function patchStatus() {
  const status = root?.querySelector("#save-status");
  if (status) {
    status.textContent = state.busy || state.saveStatus ||
      (session.dirty ? "未保存的更改" : "已保存");
  }
  root?.querySelector(".status-dot")?.classList.toggle(
    "unsaved",
    session.dirty,
  );
}
function changed() {
  session.touch();
  state.saveStatus = session.writable && bridge.native
    ? "等待保存…"
    : "未保存的更改";
  patchStatus();
  if (saveTimer) clearTimeout(saveTimer);
  if (session.writable && bridge.native && !saveBlocked) {
    saveTimer = setTimeout(() => void saveDocument(false).catch(report), 900);
  }
}
function chapter(id = null) {
  return session.document?.chapters.find((c) =>
    c.id === (id || state.activeChapter)
  ) || session.document?.chapters.at(-1);
}
function findBlock(chapterId, id) {
  return chapter(chapterId)?.blocks.find((b) => b.id === id);
}
function modal(value) {
  lastFocus = document.activeElement;
  state.modal = value;
  render();
}
function closeModal() {
  state.modal = null;
  render();
  lastFocus?.isConnected && lastFocus.focus?.();
}
async function busy(label, action) {
  if (state.busy) throw new Error("请等待当前操作完成后再试。");
  state.busy = label;
  render();
  try {
    return await action();
  } finally {
    state.busy = "";
    render();
  }
}
async function canReplace() {
  if (!session.dirty) return true;
  if (bridge.native && session.writable) {
    try {
      await flushStableDocument(session);
      return !session.dirty;
    } catch (error) {
      report(error);
      return false;
    }
  }
  return globalThis.confirm(
    "当前文档有未保存的更改。确定放弃并打开其他文档吗？",
  );
}
async function loadFolder(path) {
  if (!bridge.native) return bridge.call("wb_folder_list", { path });
  state.folderLoading = true;
  render();
  try {
    await folderRequests.run(
      () => bridge.call("wb_folder_list", { path }),
      (result) => {
        state.folder = result;
        state.folderLoading = false;
        render();
      },
    );
  } catch (error) {
    state.folderLoading = false;
    render();
    throw error;
  }
}
function joinedPath(rootPath, relative) {
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(relative)) return relative;
  if (!rootPath) return relative;
  return `${rootPath.replace(/[\\/]+$/, "")}/${relative.replace(/^\.\//, "")}`;
}
async function mediaPreview(path, folderPath = state.folder?.path) {
  if (state.previewUrls[path]) return state.previewUrls[path];
  if (/^data:|^blob:|^asset:/i.test(path)) return previewUrl(path);
  const result = await bridge.call("wb_media_preview", {
    path,
    ...(folderPath ? { root: folderPath } : {}),
  });
  const url = previewUrl(result?.url || result?.dataUrl);
  if (!url) throw new Error("无法预览此文件类型。");
  state.previewUrls[path] = url;
  return url;
}
async function loadDocumentPreviews() {
  const generation = ++previewGeneration, rootPath = state.documentFolder;
  const jobs = [];
  for (const media of state.media) {
    if (!media.dataUrl) {
      jobs.push(async () => {
        try {
          await mediaPreview(media.path, rootPath);
        } catch { /* A missing preview is visible, never a fake image. */ }
      });
    }
  }
  for (
    const block of session.document?.chapters.flatMap((c) => c.blocks) || []
  ) {
    if (
      !["image", "video"].includes(block.type) ||
      /^(?:data:|blob:|asset:)/.test(block.url)
    ) continue;
    const media = state.media.find((m) =>
      m.path === block.url || m.name === block.url.split(/[\\/]/).at(-1)
    );
    if (media?.dataUrl) {
      state.previewUrls[block.url] = media.dataUrl;
      continue;
    }
    jobs.push(async () => {
      try {
        const url = await mediaPreview(
          media?.path ||
            (/^https:\/\//.test(block.url)
              ? block.url
              : joinedPath(rootPath, block.url)),
          rootPath,
        );
        if (generation === previewGeneration) {
          state.previewUrls[block.url] = url;
        }
      } catch { /* Explicit placeholder with retry. */ }
    });
  }
  for (let i = 0; i < jobs.length; i += 4) {
    await Promise.all(jobs.slice(i, i + 4).map((job) => job()));
    if (generation !== previewGeneration) return;
  }
  if (generation === previewGeneration) render();
}
async function adoptDocument(result) {
  previewGeneration++;
  readerRequests.invalidate();
  sourceSelection.reset();
  state.readerLoading = false;
  state.reader = null;
  session.open(result);
  state.activeChapter = null;
  state.analysis = null;
  state.styleMarkdown = result.styleMarkdown || "";
  state.documentFolder = result.folderPath ||
    result.path?.replace(/[\\/][^\\/]+$/, "") || null;
  state.media = (result.media || []).filter((m) =>
    ["image", "video"].includes(m.kind)
  );
  state.previewUrls = {};
  saveBlocked = false;
  state.saveStatus = result.path ? "已从本地读取" : "未保存到本地";
  state.notice = (result.warnings || []).join(" · ");
  state.noticeKind = state.notice ? "warning" : "info";
  render();
  if (bridge.native && state.documentFolder) {
    try {
      await loadFolder(state.documentFolder);
    } catch (error) {
      notice(
        "文档已打开，但无法读取所在文件夹：" + errorMessage(error),
        "warning",
      );
    }
    void loadDocumentPreviews();
  }
}
async function openPath(path) {
  await busy("正在读取文档…", async () => {
    if (!await canReplace()) return;
    await adoptDocument(await bridge.call("wb_document_open", { path }));
  });
}
async function importDocument() {
  if (!bridge.native) {
    document.getElementById("wb-import-input").click();
    return;
  }
  const path = pickPath(await bridge.call("select_file", {}));
  if (path) await openPath(path);
}
function download(text, name, type = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type })),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function safeFilename(value) {
  // deno-lint-ignore no-control-regex -- File names cannot contain control characters.
  return String(value || "未命名文档").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 100) || "未命名文档";
}
async function saveDocument(explicit = true) {
  if (!session.document) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!bridge.native) {
    if (explicit) {
      download(
        serializeDocument(session.document),
        safeFilename(session.document.title) + ".md",
      );
      session.savedRevision = session.revision;
      state.saveStatus = "已下载 Markdown 副本";
      render();
    }
    return;
  }
  let target = null;
  if (!session.writable) {
    if (!explicit) return;
    target = pickPath(
      await bridge.call("select_export_path", {
        defaultName: safeFilename(session.document.title) + ".md",
        filename: safeFilename(session.document.title) + ".md",
        format: "md",
      }),
    );
    if (!target) return;
  }
  state.saveStatus = "正在保存…";
  patchStatus();
  try {
    await session.save(target);
    if (target) {
      state.documentFolder = session.path.replace(/[\\/][^\\/]+$/, "");
      await loadFolder(state.documentFolder);
    }
    saveBlocked = false;
    state.saveStatus = session.dirty ? "等待保存…" : "已保存到本地";
    patchStatus();
  } catch (error) {
    saveBlocked = true;
    state.saveStatus = "保存失败 · 更改仍在编辑器中";
    patchStatus();
    throw error;
  }
}
async function chooseFolder() {
  const path = pickPath(await bridge.call("select_folder", {}));
  if (path) {
    state.leftTab = "folder";
    await loadFolder(path);
  }
}
async function importMedia() {
  if (!bridge.native) {
    document.getElementById("wb-media-input").click();
    return;
  }
  if (!session.document) throw new Error("请先新建或导入文档，再添加媒体。");
  if (!session.writable) {
    await saveDocument();
    if (!session.writable) return;
  }
  const raw = await bridge.call("select_files", {});
  const paths = Array.isArray(raw)
    ? raw.map(pickPath).filter(Boolean)
    : raw?.paths || [pickPath(raw)].filter(Boolean);
  let skipped = 0;
  for (const path of paths) {
    if (
      !/\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|mov|m4v|webm|ogv)$/i.test(path)
    ) {
      skipped++;
      continue;
    }
    const media = await bridge.call("wb_media_import", {
      path,
      documentPath: session.path,
    });
    media.documentUrl = media.relativePath;
    if (!state.media.some((item) => item.path === media.path)) {
      state.media.push(media);
    }
    try {
      await mediaPreview(media.path, state.documentFolder);
    } catch (error) {
      state.notice = errorMessage(error);
      state.noticeKind = "warning";
    }
  }
  state.leftTab = "media";
  if (skipped) {
    state.notice = `${skipped} 个文件不是可用的图片或视频，未添加。`;
    state.noticeKind = "warning";
  }
  render();
}
async function insertMedia(media) {
  if (
    bridge.native && !media.documentUrl && !media.dataUrl && media.path &&
    /^(?:[A-Za-z]:[\\/]|\/)/.test(media.path) && state.documentFolder &&
    !media.path.startsWith(state.documentFolder.replace(/[\\/]+$/, "") + "/")
  ) {
    if (!session.writable) {
      await saveDocument();
      if (!session.writable) return;
    }
    media = await bridge.call("wb_media_import", {
      path: media.path,
      documentPath: session.path,
    });
    media.documentUrl = media.relativePath;
    await mediaPreview(media.path, state.documentFolder);
  }
  const target = chapter();
  if (!target) throw new Error("请先新建或导入一份文档。");
  let url = media.documentUrl || media.path || media.url;
  if (
    state.documentFolder &&
    url?.startsWith(state.documentFolder.replace(/[\\/]+$/, "") + "/")
  ) url = url.slice(state.documentFolder.replace(/[\\/]+$/, "").length + 1);
  insertBlock(target, { type: media.kind, caption: media.name, url });
  if (media.dataUrl || state.previewUrls[media.path]) {
    state.previewUrls[url] = media.dataUrl || state.previewUrls[media.path];
  }
  changed();
  state.modal = null;
  render();
}
async function settings() {
  modal({ type: "settings" });
  if (!bridge.native) return;
  await refreshSettings();
  render();
}
async function refreshSettings() {
  const [ai, resources] = await Promise.all([
    bridge.call("ai_connection_list", {}),
    bridge.call("resource_providers_list", {}),
  ]);
  state.providers = (ai?.providers || []).filter((p) =>
    p.id !== "fake" && p.kind !== "offline"
  );
  state.configured = ai?.configured || {};
  state.credentialOrigins = ai?.credential_origins || {};
  state.resourceProviders = Array.isArray(resources)
    ? resources
    : resources?.providers || [];
  if (!state.providers.some((p) => p.id === state.selectedProvider)) {
    const first = state.providers.find((p) => state.configured[p.id]) ||
      state.providers[0];
    state.selectedProvider = first?.id || "";
    state.selectedModel = first?.default_model || first?.models?.[0] || "";
  }
  persistPrefs();
}
function aiSelection() {
  const provider = state.providers.find((p) => p.id === state.selectedProvider);
  if (!provider || !state.configured[provider.id]) {
    throw new Error("请先在设置中配置真实 AI 服务与 API Key。");
  }
  const model = state.selectedModel || provider.default_model ||
    provider.models?.[0];
  if (!model) throw new Error("请在设置中填写模型 ID。");
  return { providerId: provider.id, modelId: model };
}
async function analyze() {
  if (!session.document) return;
  await busy("AI 正在解析当前文档…", async () => {
    const result = await bridge.call("wb_document_analyze", {
      markdown: serializeDocument(session.document),
      ...aiSelection(),
      requestId: newId(),
    });
    state.analysis = result;
    state.rightTab = "discover";
    state.rightCollapsed = false;
    state.query = result.keywords?.[0] || session.document.title;
    state.notice = "文档解析完成。点击关键词或搜索框查找相关素材。";
    state.noticeKind = "info";
  });
}
async function search(query = state.query) {
  if (!String(query).trim()) throw new Error("请输入搜索关键词。");
  if (state.searching) return;
  state.query = String(query).trim();
  state.searching = true;
  state.searchRan = true;
  state.rightTab = "discover";
  state.results = [];
  state.searchWarnings = [];
  render();
  try {
    const result = await bridge.call("wb_resource_search", {
      query: state.query,
      kind: state.searchKind,
      count: 12,
    });
    state.results = result?.results || [];
    state.searchWarnings = result?.warnings || [];
    for (const row of state.results) {
      const path = row.previewUrl || row.thumbnailUrl || row.thumbnail_url;
      if (path) {
        try {
          row.thumbnailUrl = await mediaPreview(path, null);
        } catch {
          row.thumbnailUrl = "";
          row.thumbnail_url =
            ""; /* Do not bypass native network policy for thumbnails. */
        }
      }
    }
  } finally {
    state.searching = false;
    render();
  }
}
async function readUrl(raw, title = "") {
  const url = normalizeWebUrl(raw);
  if (!url) {
    throw new Error(
      "请输入有效的公开 HTTP(S) 网页地址；本地、私有网络或脚本地址不能打开。",
    );
  }
  sourceSelection.reset(url);
  state.rightTab = "browser";
  state.rightCollapsed = false;
  state.readerLoading = true;
  state.reader = { url, title: title || url, text: "" };
  state.readerMode = "text";
  render();
  await readerRequests.run(async () => {
    try {
      return {
        source: await bridge.call("wb_source_read", {
          url,
          query: state.query,
        }),
      };
    } catch (error) {
      return {
        source: {
          url,
          title: title || url,
          text: "",
          limitations: errorMessage(error),
        },
        error,
      };
    }
  }, ({ source, error }) => {
    state.reader = {
      ...source,
      url: source.url || url,
      title: source.title || title || url,
    };
    state.readerLoading = false;
    sourceSelection.reset(state.reader.url);
    if (error) {
      state.notice = errorMessage(error);
      state.noticeKind = "error";
    }
    render();
  });
}
function insertSource(source, text = "") {
  const target = chapter();
  if (!target) throw new Error("请先新建或导入一份文档。");
  const url = normalizeWebUrl(source?.url);
  if (!url) throw new Error("来源地址无效。");
  if (text.trim()) insertBlock(target, { type: "text", markdown: text.trim() });
  insertBlock(target, { type: "source", caption: source.title || url, url });
  changed();
  render();
}
async function insertResult(result) {
  if (!result) return;
  if (result.kind !== "image") {
    insertSource(result);
    return;
  }
  if (!bridge.native) {
    throw new Error("下载搜索图片并嵌入 Office 文档需要 Workbench 桌面版。");
  }
  await busy("正在下载图片并保存到本地素材…", async () => {
    if (!session.document) throw new Error("请先新建或导入文档。");
    if (!session.writable) {
      await saveDocument();
      if (!session.writable) return;
    }
    const media = await insertDiscoveredImage(
      session,
      result,
      chapter()?.id || "",
    );
    if (!state.media.some((item) => item.path === media.path)) {
      state.media.push(media);
    }
    changed();
    try {
      state.previewUrls[media.relativePath] = await mediaPreview(
        media.path,
        state.documentFolder,
      );
    } catch (error) {
      state.notice = "图片已保存并插入，但预览未加载：" + errorMessage(error);
      state.noticeKind = "warning";
    }
    state.leftTab = "media";
  });
}
async function openExternal() {
  const url = normalizeWebUrl(state.reader?.url);
  if (!url) return;
  if (bridge.native) await bridge.call("wb_open_external", { url });
  else globalThis.open(url, "_blank", "noopener,noreferrer");
}
async function runAction(action, node) {
  if (state.busy && !["close-modal", "dismiss-notice"].includes(action)) return;
  const id = node.dataset.id, chapterId = node.dataset.chapter;
  switch (action) {
    case "home":
      root.querySelector(".document-title")?.focus();
      break;
    case "new":
      await busy("正在新建文档…", async () => {
        if (!await canReplace()) return;
        await adoptDocument({
          markdown: "# 未命名文档\n\n## 第一章\n",
          title: "未命名文档",
        });
        session.touch();
      });
      root.querySelector(".document-title")?.select();
      break;
    case "import":
      await importDocument();
      break;
    case "save":
      await saveDocument();
      break;
    case "settings":
      await settings();
      break;
    case "export":
      modal({ type: "export" });
      break;
    case "analyze":
      await analyze();
      break;
    case "close-modal":
      closeModal();
      break;
    case "dismiss-notice":
      state.notice = "";
      render();
      break;
    case "expand-left":
      state.leftCollapsed = false;
      persistPrefs();
      render();
      break;
    case "expand-right":
      state.rightCollapsed = false;
      persistPrefs();
      render();
      break;
    case "toggle-left":
      state.leftCollapsed = !state.leftCollapsed;
      persistPrefs();
      render();
      break;
    case "toggle-right":
      state.rightCollapsed = !state.rightCollapsed;
      persistPrefs();
      render();
      break;
    case "collapse-left":
      state.leftCollapsed = true;
      persistPrefs();
      render();
      break;
    case "collapse-right":
      state.rightCollapsed = true;
      persistPrefs();
      render();
      break;
    case "left-tab":
      state.leftTab = node.dataset.value;
      render();
      break;
    case "right-tab":
      state.rightTab = node.dataset.value;
      render();
      break;
    case "media-filter":
      state.mediaFilter = node.dataset.value;
      render();
      break;
    case "choose-folder":
      await chooseFolder();
      break;
    case "folder-parent":
      if (state.folder?.parentPath) await loadFolder(state.folder.parentPath);
      break;
    case "folder-entry": {
      const path = node.dataset.path;
      if (node.dataset.kind === "directory" || node.dataset.kind === "folder") {
        await loadFolder(path);
      } else if (
        /\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v)$/i.test(path)
      ) {
        const item = {
          id: newId(),
          path,
          name: path.split(/[\\/]/).at(-1),
          kind: /\.(mp4|webm|mov|m4v)$/i.test(path) ? "video" : "image",
        };
        await mediaPreview(path);
        modal({ type: "preview", item });
      } else await openPath(path);
      break;
    }
    case "import-media":
      await importMedia();
      break;
    case "preview-media": {
      const item = state.media.find((m) => m.id === id);
      if (item) {
        if (!item.dataUrl) await mediaPreview(item.path);
        modal({ type: "preview", item });
      }
      break;
    }
    case "insert-media": {
      const item = state.media.find((m) => m.id === id);
      if (item) await insertMedia(item);
      break;
    }
    case "insert-preview":
      await insertMedia(state.modal.item);
      break;
    case "add-chapter": {
      if (!session.document) break;
      const item = {
        id: newId(),
        title: "新章节",
        level: 2,
        implicit: false,
        blocks: [],
      };
      session.document.chapters.push(item);
      state.activeChapter = item.id;
      changed();
      render();
      root.querySelector(
        `[data-edit="chapter-title"][data-chapter="${item.id}"]`,
      )?.select();
      break;
    }
    case "chapter-up":
    case "chapter-down":
      moveItem(session.document.chapters, id, action === "chapter-up" ? -1 : 1);
      changed();
      render();
      break;
    case "chapter-delete": {
      const item = session.document.chapters.find((c) => c.id === id);
      if (
        item &&
        (!item.blocks.length ||
          confirm(`删除「${item.title}」及其 ${item.blocks.length} 个区块？`))
      ) {
        session.document.chapters = session.document.chapters.filter((c) =>
          c.id !== id
        );
        if (state.activeChapter === id) state.activeChapter = null;
        changed();
        render();
      }
      break;
    }
    case "add-block":
      if (node.dataset.kind === "text") {
        const item = insertBlock(chapter(chapterId), {
          type: "text",
          markdown: "",
        });
        changed();
        render();
        root.querySelector(`[data-edit="block"][data-id="${item.id}"]`)
          ?.focus();
      } else modal({ type: "link", kind: node.dataset.kind, chapterId });
      break;
    case "block-up":
    case "block-down":
      moveItem(chapter(chapterId).blocks, id, action === "block-up" ? -1 : 1);
      changed();
      render();
      break;
    case "block-copy": {
      const block = findBlock(chapterId, id);
      insertBlock(chapter(chapterId), {
        ...structuredClone(block),
        id: newId(),
      }, id);
      changed();
      render();
      break;
    }
    case "block-delete":
      removeBlock(chapter(chapterId), id);
      changed();
      render();
      break;
    case "edit-media": {
      const b = findBlock(chapterId, id);
      modal({
        type: "link",
        kind: b.type,
        chapterId,
        blockId: id,
        url: b.url,
        caption: b.caption,
      });
      break;
    }
    case "load-block-media": {
      const block = findBlock(chapterId, id);
      state.previewUrls[block.url] = await mediaPreview(
        joinedPath(state.documentFolder, block.url),
        state.documentFolder,
      );
      render();
      break;
    }
    case "search-kind":
      state.searchKind = node.dataset.kind;
      state.results = [];
      state.searchRan = false;
      state.searchWarnings = [];
      render();
      break;
    case "search-topic":
      await search(node.dataset.query);
      break;
    case "read-result": {
      const r = state.results[Number(node.dataset.index)];
      await readUrl(r.sourceUrl || r.source_url || r.url, r.title);
      break;
    }
    case "insert-result":
      await insertResult(state.results[Number(node.dataset.index)]);
      break;
    case "read-url":
      await readUrl(node.dataset.url);
      break;
    case "reader-mode":
      state.readerMode = node.dataset.value;
      render();
      break;
    case "open-external":
      await openExternal();
      break;
    case "insert-source":
      insertSource(state.reader);
      break;
    case "insert-selection":
      if (!sourceSelection.read(state.reader?.url).trim()) {
        throw new Error("请先在「提取正文」中选中需要插入的文字。");
      }
      insertSource(state.reader, sourceSelection.read(state.reader?.url));
      sourceSelection.reset(state.reader.url);
      break;
    case "apply-generated": {
      const markdown = state.modal.markdown;
      if (!markdown?.trim()) throw new Error("草稿为空，不能应用。");
      session.document = parseDocument(markdown, session.document.title);
      state.activeChapter = null;
      changed();
      closeModal();
      break;
    }
  }
}
async function submit(form) {
  if (state.busy) return;
  const data = new FormData(form), get = (name) => String(data.get(name) || "");
  switch (form.dataset.form) {
    case "search":
      await search(get("query"));
      break;
    case "navigate":
      await readUrl(get("url"));
      break;
    case "link": {
      const m = state.modal, url = get("url").trim();
      if (
        /^[a-z][a-z\d+.-]*:/i.test(url) && !normalizeWebUrl(url) &&
        !/^blob:/i.test(url)
      ) throw new Error("仅支持公开网页地址或本地媒体路径。");
      const block = { type: m.kind, caption: get("caption"), url };
      if (m.blockId) Object.assign(findBlock(m.chapterId, m.blockId), block);
      else insertBlock(chapter(m.chapterId), block);
      changed();
      closeModal();
      if (bridge.native) void loadDocumentPreviews();
      break;
    }
    case "ai-settings": {
      let secret = get("secret");
      const id = get("id").trim(),
        protocol = get("api_protocol"),
        base = get("base_url").trim(),
        existing = state.providers.find((p) => p.id === id),
        oldOrigin = state.credentialOrigins?.[id] ||
          (existing?.base_url ? new URL(existing.base_url).origin : null),
        newOrigin = new URL(base).origin;
      const confirmOrigin = Boolean(
        state.configured[id] && oldOrigin !== newOrigin,
      );
      if (
        confirmOrigin &&
        !confirm(
          `此连接的密钥当前绑定到 ${
            oldOrigin || "原地址"
          }。是否允许将其发送到 ${newOrigin}？`,
        )
      ) return;
      const provider = {
        id,
        label: get("label").trim(),
        kind: "openai_compatible",
        base_url: base,
        api_protocol: protocol,
        chat_path: protocol === "anthropic-messages"
          ? "/messages"
          : protocol === "openai-responses"
          ? "/responses"
          : "/chat/completions",
        auth_header: protocol === "anthropic-messages"
          ? "x-api-key"
          : "authorization",
        auth_scheme: protocol === "anthropic-messages" ? "" : "Bearer",
        default_model: get("model").trim(),
        models: [get("model").trim()],
      };
      await bridge.call("ai_connection_save", {
        provider,
        ...(confirmOrigin ? { confirm_credential_origin: true } : {}),
      });
      try {
        if (secret.trim()) {
          await bridge.call("ai_secret_set", {
            provider_id: id,
            value: secret,
          });
        }
      } finally {
        secret = "";
        form.querySelector("[name=secret]").value = "";
      }
      state.selectedProvider = id;
      state.selectedModel = provider.default_model;
      await refreshSettings();
      notice(
        state.configured[id]
          ? "连接已保存，系统已确认密钥存在。"
          : "连接配置已保存；请填写 API Key 后再使用 AI。",
      );
      break;
    }
    case "search-settings": {
      let secret = get("secret");
      try {
        await bridge.call("resource_secret_set", {
          provider_id: get("provider_id"),
          value: secret,
        });
      } finally {
        secret = "";
        form.querySelector("[name=secret]").value = "";
      }
      await refreshSettings();
      notice("搜索服务密钥已写入系统安全存储。");
      break;
    }
    case "export": {
      const format = get("format");
      if (!bridge.native) {
        if (format === "md") {
          await saveDocument();
          closeModal();
          return;
        }
        throw new Error(
          "Word、PowerPoint 与其他格式导出需要 Workbench 桌面版。",
        );
      }
      const ext = format === "style" ? "md" : format,
        name = safeFilename(session.document.title) +
          (format === "style" ? ".style" : "") + "." + ext,
        path = pickPath(
          await bridge.call("select_export_path", {
            defaultName: name,
            filename: name,
            format: ext,
          }),
        );
      if (!path) return;
      await busy("正在生成导出文件…", async () => {
        const result = await bridge.call("wb_document_export", {
          path,
          sourcePath: session.sourcePath,
          format: format === "style" ? "md" : format,
          markdown: format === "style"
            ? state.styleMarkdown
            : serializeDocument(session.document),
          title: session.document.title,
          styleMarkdown: state.styleMarkdown || undefined,
        });
        state.modal = null;
        state.notice = `已导出到 ${result.path || path}${
          result.warnings?.length ? " · " + result.warnings.join(" · ") : ""
        }`;
        state.noticeKind = result.warnings?.length ? "warning" : "info";
      });
      break;
    }
    case "generate": {
      const instruction = get("instruction");
      await busy("AI 正在生成可审阅草稿…", async () => {
        const result = await bridge.call("wb_document_generate", {
          markdown: serializeDocument(session.document),
          instruction,
          ...aiSelection(),
          requestId: newId(),
        });
        if (!result.markdown?.trim()) {
          throw new Error("AI 服务没有返回可用文档。原文没有改变。");
        }
        state.modal = { type: "generated", markdown: result.markdown };
      });
      break;
    }
  }
}
function wire() {
  root.addEventListener("click", (event) => {
    const node = event.target.closest("[data-action]");
    if (!node || node.disabled) return;
    event.preventDefault();
    void runAction(node.dataset.action, node).catch(report);
  });
  root.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-form]");
    if (!form) return;
    event.preventDefault();
    void submit(form).catch(report);
  });
  root.addEventListener("input", (event) => {
    const node = event.target, edit = node.dataset.edit;
    if (!edit) return;
    if (edit === "generated") {
      state.modal.markdown = node.value;
      return;
    }
    if (edit === "title") {
      session.document.title = node.value;
      session.document.titleHeading = true;
    }
    if (edit === "chapter-title") {
      const c = chapter(node.dataset.chapter);
      c.title = node.value;
      c.implicit = false;
    }
    if (edit === "block") {
      findBlock(node.dataset.chapter, node.dataset.id).markdown = node.value;
      node.style.height = "auto";
      node.style.height = Math.max(45, node.scrollHeight) + "px";
    }
    if (edit === "caption") {
      findBlock(node.dataset.chapter, node.dataset.id).caption = node.value;
    }
    changed();
  });
  root.addEventListener("change", (event) => {
    const node = event.target;
    if (node.dataset.change === "chapter") {
      state.activeChapter = node.value || null;
      render();
      root.querySelector(".document-stage")?.scrollTo?.(0, 0);
    }
    if (node.dataset.change === "provider") {
      state.selectedProvider = node.value;
      state.selectedModel = state.providers.find((p) =>
        p.id === node.value
      )?.default_model || "";
      persistPrefs();
      render();
    }
  });
  root.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest("[data-resize]");
    if (!handle) return;
    event.preventDefault();
    const side = handle.dataset.resize,
      startX = event.clientX,
      start = state[side + "Width"];
    handle.setPointerCapture?.(event.pointerId);
    handle.classList.add("dragging");
    const move = (ev) => {
      state[side + "Width"] = sidebarWidth(
        side,
        start + (side === "left" ? 1 : -1) * (ev.clientX - startX),
      );
      root.querySelector(".workbench").style.setProperty(
        "--" + side,
        state[side + "Width"] + "px",
      );
      handle.setAttribute("aria-valuenow", state[side + "Width"]);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.classList.remove("dragging");
      persistPrefs();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
  root.addEventListener("keydown", (event) => {
    const handle = event.target.closest("[data-resize]");
    if (
      handle && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      const side = handle.dataset.resize,
        delta = (event.key === "ArrowRight" ? 1 : -1) *
          (side === "left" ? 1 : -1) * 16;
      state[side + "Width"] = sidebarWidth(
        side,
        event.key === "Home"
          ? 0
          : event.key === "End"
          ? 999
          : state[side + "Width"] + delta,
      );
      persistPrefs();
      root.querySelector(".workbench").style.setProperty(
        "--" + side,
        state[side + "Width"] + "px",
      );
      handle.setAttribute("aria-valuenow", state[side + "Width"]);
    }
    if (event.key === "Escape" && state.modal) {
      event.preventDefault();
      closeModal();
    }
    if (event.key === "Tab" && state.modal) {
      const list = [
        ...root.querySelectorAll(
          ".modal button:not(:disabled),.modal input:not([type=hidden]),.modal select,.modal textarea,a[href]",
        ),
      ].filter((n) => n.offsetParent !== null);
      const first = list[0], last = list.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  document.addEventListener("selectionchange", () => {
    const selected = globalThis.getSelection(),
      readerNode = root.querySelector("#reader-text");
    if (
      selected?.rangeCount && readerNode?.contains(selected.anchorNode) &&
      readerNode.contains(selected.focusNode)
    ) sourceSelection.capture(state.reader?.url, selected.toString());
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveDocument().catch(report);
    }
  });
  const importer = document.createElement("input");
  importer.id = "wb-import-input";
  importer.type = "file";
  importer.accept = ".md,.markdown,.txt";
  importer.hidden = true;
  importer.setAttribute("aria-label", "导入 Markdown 文档");
  document.body.append(importer);
  importer.addEventListener("change", async () => {
    const file = importer.files?.[0];
    if (!file || state.busy) return;
    try {
      await busy("正在读取文档…", async () => {
        if (!await canReplace()) return;
        if (!/\.(md|markdown|txt)$/i.test(file.name)) {
          throw new Error(
            "浏览器编辑模式仅支持 Markdown 或纯文本；其他格式请使用桌面版。",
          );
        }
        if (file.size > 10 * 1024 * 1024) {
          throw new Error("此文档超过浏览器编辑模式的 10 MB 限制。");
        }
        const markdown = await readImportSnapshot(session, () => file.text());
        await adoptDocument({ markdown, title: file.name });
      });
    } catch (error) {
      report(error);
    } finally {
      importer.value = "";
    }
  });
  const mediaInput = document.createElement("input");
  mediaInput.id = "wb-media-input";
  mediaInput.type = "file";
  mediaInput.accept = "image/*,video/*";
  mediaInput.multiple = true;
  mediaInput.hidden = true;
  document.body.append(mediaInput);
  mediaInput.addEventListener("change", () => {
    for (const file of mediaInput.files || []) {
      const url = URL.createObjectURL(file);
      state.media.push({
        id: newId(),
        name: file.name,
        url,
        documentUrl: file.name,
        kind: file.type.startsWith("video/") ? "video" : "image",
        dataUrl: url,
      });
    }
    state.leftTab = "media";
    state.notice =
      "浏览器媒体仅在当前会话预览；导出的 Markdown 引用文件名，请将原媒体放在同一目录。";
    state.noticeKind = "warning";
    render();
    mediaInput.value = "";
  });
  globalThis.addEventListener("beforeunload", (event) => {
    if (session.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}
async function initialize() {
  const saved = prefs();
  state.leftWidth = sidebarWidth("left", saved.leftWidth);
  state.rightWidth = sidebarWidth("right", saved.rightWidth);
  state.leftCollapsed = Boolean(saved.leftCollapsed);
  state.rightCollapsed = Boolean(saved.rightCollapsed);
  state.selectedProvider = saved.selectedProvider || "";
  state.selectedModel = saved.selectedModel || "";
  if (globalThis.innerWidth < 760) {
    state.leftCollapsed = true;
    state.rightCollapsed = true;
  }
  render();
  wire();
  if (bridge.native) {
    try {
      await refreshSettings();
      render();
    } catch (error) {
      notice("服务设置暂不可读取：" + errorMessage(error), "warning");
    }
    const listen = globalThis.__TAURI__?.event?.listen;
    if (listen) {
      const close = async () => {
        try {
          if (state.busy) throw new Error("请等待当前操作完成后再关闭。");
          state.busy = "正在保存并关闭…";
          render();
          if (session.dirty) {
            if (session.writable) await flushStableDocument(session);
            else if (!confirm("当前文档尚未保存。仍然关闭吗？")) {
              state.busy = "";
              render();
              return;
            }
          }
          await bridge.invoke("confirm_close", {});
        } catch (error) {
          state.busy = "";
          report(error);
        }
      };
      await listen("workbench://close-requested", () => void close());
    }
  }
  return state;
}
if (root) {
  globalThis.__workbench = {
    state,
    session,
    bridge,
    render,
    openPath,
    saveDocument,
  };
  globalThis.__workbenchReady = initialize();
}
export { bridge, initialize, render, session, state };
