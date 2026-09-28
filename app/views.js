// deno-fmt-ignore-file
/*
 * Rendering layer for the dependency-free desktop-first renderer.
 *
 * Every view is a pure function of the store's canonical data plus its UI
 * state.  The course map, the lesson editor, the preview and the completion
 * badges all read `app/authoring.js` projections, so no view can grow its own
 * copy of the course state.  Views never mutate project data: they only emit
 * `data-action` attributes that `main.js` binds.
 */

import { PROJECT_FILE_PICKER } from "./constants.js";
import {
  MEDIA_REQUIREMENT_TYPES,
  REQUIREMENT_TYPES,
  SEED_SOURCE_HINTS,
  SEED_TEXT_SOURCES,
  assetLabel,
  blockLabel,
  blockSizeView,
  courseMap,
  freeCellsFor,
  formatBytes,
  lessonView,
  placementGrid,
  nextStepLabel,
  requirementAnchorLabel,
  requirementBacklog,
  usagesForAsset,
} from "./authoring.js";
import {
  aiChangeDraftDiffRows,
  aiContextPreviewLines,
  aiProviderDescriptors,
} from "./ai.js";
import {
  buildExplorerTree,
  explorerEntryName,
  explorerStatusLabel,
  explorerTypeLabel,
  filterExplorerEntries,
  IMPORT_MAPPING_ROLES,
  mappingRoleLabel,
  markdownToHtml,
} from "./canvas.js";
import {
  buildPublicationProjection,
  fitPageRect,
  getAvailablePublicationAdapters,
  getPublicationCapabilities,
  PAGE_SIZE_PRESETS,
  projectPageGeometry,
  resolvePageSize,
} from "./publication.js";

const EDITOR_MODES = [
  ["writing", "正文"],
  ["structure", "结构"],
  ["layout", "排版"],
  ["preview", "预览"],
];
const RIGHT_PANELS = [
  ["media", "媒体"],
  ["requirements", "待补"],
  ["status", "状态"],
  ["assistant", "AI 助手"],
  ["properties", "属性"],
  ["versions", "版本"],
];
const BLOCK_PALETTE = [
  ["paragraph", "正文"],
  ["heading", "标题"],
  ["quote", "引用"],
  ["callout", "提示"],
  ["code", "代码"],
  ["divider", "分隔线"],
  ["media", "媒体"],
  ["placeholder", "占位符"],
];
const RIGHT_PANEL_LABELS = Object.fromEntries(RIGHT_PANELS);
const MODE_LABELS = Object.fromEntries(EDITOR_MODES);

export function createViews(store) {
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  const assetPreview = (asset) =>
    store.assetPreview.get(asset && asset.id, asset);
  const retryAssetPreviewButton = (asset, compact = false) =>
    `<button type="button" class="${compact ? "icon-button" : "text-button"}" data-action="retry-asset-preview" data-asset="${esc(asset.id)}" aria-label="重试预览：${esc(asset.title || asset.filename)}" title="重试预览">${compact ? "↻" : "重试预览"}</button>`;
  const previewUrl = (asset) => {
    const preview = assetPreview(asset);
    return preview && preview.url ? preview.url : "";
  };
  const previewText = (asset) => {
    const preview = assetPreview(asset);
    return preview && typeof preview.text === "string" ? preview.text : "";
  };
  const mediaDuration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const rest = String(total % 60).padStart(2, "0");
    return minutes >= 60
      ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${rest}`
      : `${minutes}:${rest}`;
  };
  const isImageLike = (asset) =>
    asset && (asset.type === "image" || asset.type === "gif");
  const isAttachmentAsset = (asset) => {
    if (!asset) return false;
    const name = String(asset.filename || "");
    const mime = String(asset.mime_type || "");
    return /\.(pdf|docx?|xlsx?|pptx?|zip)$/i.test(name) ||
      /application\/(pdf|.*word|.*document|.*sheet|.*presentation|zip)/i.test(
        mime,
      ) ||
      (asset.type === "document" && !previewText(asset) &&
        !/\.(md|markdown|txt|csv|json)$/i.test(name));
  };
  /**
   * A real trash glyph.  The emoji (U+1F5D1) depends on an emoji font being
   * installed and inherited `color`, which is how a delete control could end
   * up invisible; an inline SVG always renders and follows `currentColor`.
   */
  const TRASH_ICON = `<svg class="trash-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6.2 1.8h3.6l.5 1.1H13v1.5H3V2.9h2.7l.5-1.1ZM4.4 5.6h7.2l-.55 7.9a1.1 1.1 0 0 1-1.1 1.03H6.05A1.1 1.1 0 0 1 4.95 13.5L4.4 5.6Z"/></svg>`;
  const PREFLIGHT_ISSUE_LABELS = {
    canonical_invalid: "课程内容不完整",
    missing_asset: "引用的素材文件找不到",
    unsafe_path: "素材位置不安全",
    unsupported_format: "当前格式暂不支持",
    open_requirements: "还有待补内容",
    media_downgrade: "部分媒体会降级为附件说明",
    layout_overflow: "内容超出排版范围",
  };
  const issueMessage = (issue) => {
    const message = typeof issue?.message === "string" ? issue.message.trim() : "";
    return message || PREFLIGHT_ISSUE_LABELS[issue?.code] || "导出前检查发现一项需要处理的问题";
  };
  const issueDiagnostics = (issue) => {
    const code = typeof issue?.code === "string" ? issue.code.trim() : "";
    const path = typeof issue?.path === "string" ? issue.path.trim() : "";
    if (!code && !path) return "";
    const lines = [code ? `代码：${code}` : "", path ? `位置：${path}` : ""].filter(Boolean).join("\n");
    return `<details class="diagnostic"><summary>显示技术信息</summary><code>${esc(lines)}</code></details>`;
  };

  /**
   * Thumbnails: images/GIF as <img>, video as a muted poster card, Markdown as
   * text, PDF/DOCX as attachment cards — never a blank board.
   */
  const assetThumb = (asset) => {
    const preview = assetPreview(asset);
    const label = asset.title || asset.filename || "素材";
    if (preview && preview.failed) {
      return `<span class="asset-thumb" role="img" aria-label="${esc(label)}预览失败">⚠<small>预览失败</small><small>${esc(preview.error || "素材不可读")}</small><small>请检查文件或重新导入</small></span>`;
    }
    if (!preview || preview.loading) {
      const key = preview?.key
        ? ` data-asset-preview-key="${esc(preview.key)}"`
        : "";
      const pending = Boolean(preview?.pending);
      return `<span class="asset-thumb"${key} title="${pending ? "正在读取素材预览" : "靠近素材时加载预览"}">${preview?.loading ? pending ? "正在读取" : "等待加载" : "预览未加载"}</span>`;
    }
    const url = preview.url || "";
    if (url && isImageLike(asset)) {
      return `<img class="asset-image" src="${esc(preview.thumbnailUrl || url)}" alt="${
        esc(label)
      }" loading="lazy" />`;
    }
    if (url && asset.type === "video") {
      return `<img class="asset-image asset-video" src="${
        esc(preview.posterUrl)
      }" alt="${esc(label)} · 视频封面" loading="lazy" />`;
    }
    const text = preview.text;
    if (typeof text === "string") {
      return `<span class="asset-doc" title="打开媒体库查看完整内容">${
        esc(text.replace(/\s+/g, " ").trim().slice(0, 60) || "空文档")
      }</span>`;
    }
    if (isAttachmentAsset(asset) || asset.type === "document" ||
      asset.type === "other" || asset.type === "audio") {
      const ext = String(asset.filename || "").split(".").pop() ||
        assetLabel(asset.type);
      return `<span class="asset-attachment" title="${
        esc(label)
      }"><span class="asset-attachment-icon">📎</span><small>${
        esc(String(ext).toUpperCase())
      }</small><span>${esc(label)}</span>${
        isAttachmentAsset(asset)
          ? "<small>参考文件 · 当前环境没有内嵌缩略图</small>"
          : asset.type === "other"
          ? "<small>当前格式不支持内嵌预览</small>"
          : ""
      }</span>`;
    }
    return `<span class="asset-thumb" title="当前格式暂不支持预览">${assetLabel(asset.type)} · 暂无预览</span>`;
  };

  const mediaLibraryPreview = (asset) => {
    const preview = assetPreview(asset);
    const label = asset.title || asset.filename || "素材";
    const url = preview?.url || "";
    if (preview?.failed) {
      return `<div class="asset-thumb asset-preview-error" role="group" aria-label="${esc(label)} · ${esc(assetLabel(asset.type))} 预览失败" style="flex-direction:column;gap:3px;padding:6px"><b>${esc(label)} · ${esc(assetLabel(asset.type))} 预览失败</b><small>${esc(preview.error || "素材不可读")}</small>${retryAssetPreviewButton(asset)}</div>`;
    }
    if (isImageLike(asset) && url) {
      return `<button type="button" class="asset-image-zoom" data-action="open-asset-image" data-asset="${esc(asset.id)}" aria-label="放大查看 ${esc(label)}" title="点击查看大图" style="align-items:center;background:transparent;border:0;cursor:zoom-in;display:flex;height:100%;justify-content:center;padding:0;width:100%"><img class="asset-image" src="${esc(preview.thumbnailUrl || url)}" alt="${esc(label)}" loading="lazy" style="height:100%;max-height:none;max-width:none;object-fit:cover;width:100%" /></button>`;
    }
    if (preview?.pdf && url) {
      return `<iframe class="asset-pdf-preview" src="${esc(url)}" title="${esc(label)} · PDF 第一页预览" loading="lazy" referrerpolicy="no-referrer" style="display:block;width:100%;height:180px;border:0;background:#f4f4f4"></iframe>`;
    }
    if (asset.type === "video" && url) {
      const player = `<video class="asset-image asset-video" src="${esc(url)}" poster="${esc(preview.posterUrl || "")}" controls preload="none" playsinline aria-label="${esc(label)}"></video>`;
      const duration = mediaDuration(preview.durationSeconds);
      return duration ? `<div>${player}<small class="muted">${duration}</small></div>` : player;
    }
    if (asset.type === "audio" && url) {
      const player = `<audio class="asset-audio" src="${esc(url)}" controls preload="metadata" aria-label="${esc(label)}"></audio>`;
      const duration = mediaDuration(preview.durationSeconds);
      return duration ? `<div>${player}<small class="muted">${duration}</small></div>` : player;
    }
    return assetThumb(asset);
  };

  /* ---------------------------------------------------------------- shell */

  function launcherView(esc) {
    const project = store.data.project;
    const map = courseMap(store.data, store.ui.activeId);
    // "继续工作" must name the lesson it will actually resume: the position the
    // session restored when there is one, otherwise the first unfinished lesson.
    const restoredId = map.lessons.some((lesson) => lesson.id === store.ui.activeId)
      ? store.ui.activeId
      : null;
    const resumeId = restoredId || store.resumeLessonId();
    const resume = map.lessons.find((lesson) => lesson.id === resumeId) || null;
    const native = store.bridge.isNative();
    return `<section class="launcher">
      <div class="launcher-orb">✦</div><p class="eyebrow">AI COURSE WORKBENCH</p>
      <h1>把一套课程，从想法做到发布</h1>
      <p class="muted launcher-copy">课程内容会保存在本机；正文、待补、素材、排版和版本都在同一个工作台里。</p>
      <div class="launcher-actions"><button class="primary big" data-action="new-project">新建课程</button><button class="secondary big" data-action="${native ? "open-project-dir" : "open-file"}">${native ? "打开项目文件夹" : "打开现有项目"}</button><button class="secondary big" data-action="import-folder">导入已有文件夹</button>${native ? "" : PROJECT_FILE_PICKER}</div>
      <div class="recent-card"><div><span class="eyebrow">继续工作</span><h2>${esc(project.title)}</h2><p class="muted">${
      resume
        ? `${esc(resume.code)}｜${esc(resume.title)} · ${
          resume.progress.complete
            ? "这一课已完成"
            : esc(resume.progress.reasons[0] || "可以继续编辑")
        }`
        : "还没有课程内容。现在可以新建第一课，之后随时回来继续。"
    }</p>${map.lesson_count ? `<div class="progress-track"><span style="width:${map.progress}%"></span></div><small class="muted">整门课程 ${map.complete_count}/${map.lesson_count} 课完成 · 待补 ${map.open_requirements} 项</small>` : ""}</div><button class="primary" data-action="enter-project">继续工作 <span>→</span></button></div>
      <p class="small muted">${
      native
        ? "可以选择新建课程、打开已有 Workbench 项目，或导入已有文件夹（只读扫描，确认前不会改写原文件）。"
        : "可以打开现有课程，也可以先新建一门课程。导入已有文件夹请使用桌面应用。"
    } 手上已经有课程概论、大纲、教材目录、文章、表格或 AI 对话时：进入课程后打开「课程地图」，粘贴进去先生成课程地图草稿，确认后才创建正式内容。</p>
    </section>${overlay()}<div class="toast-slot" data-chrome-toast>${toast()}</div>`;
  }

  const launcher = () => launcherView(esc);
  const overlay = () => overlayView(esc);
  const toast = () => toastView(esc);

  function shellView() {
    const item = store.currentItem();
    return `<div class="shell ${
      store.ui.leftCollapsed ? "left-collapsed" : ""
    } ${store.ui.rightCollapsed ? "right-collapsed" : ""}">
      ${topbarView(item)}
      <div class="workspace">
        ${leftPanelView()}
        <main class="center" tabindex="-1">${centerView()}</main>
        ${rightPanelView()}
      </div>
      ${statusbarView(item)}
    </div>${overlay()}<div class="toast-slot" data-chrome-toast>${toast()}</div>`;
  }

  /**
   * The save indicator on its own, so an autosave can refresh just this chip
   * (`patchChrome`) instead of rebuilding the editor the user is typing in.
   */
  function saveStateView() {
    const saveHint = store.saveStatus === "已保存"
      ? "课程内容已保存"
      : store.saveStatus === "正在保存…"
      ? "正在保存课程内容"
      : store.saveStatus === "外部修改冲突"
      ? "保存已暂停；课程文件在其他地方发生了变化，请先处理提示"
      : store.saveStatus === "保存失败"
      ? "这次没有保存成功；请查看提示后重试"
      : "课程内容的保存状态";
    return `<span class="save-state ${
      store.saveStatus === "保存失败" || store.saveStatus === "外部修改冲突"
        ? "error"
        : ""
    }" data-chrome-save title="${saveHint}">${
      store.saveStatus === "已保存" ? "✓ " : ""
    }${esc(store.saveStatus)}</span>`;
  }

  function topbarView(item) {
    const map = courseMap(store.data, item ? item.id : null);
    const editLessonInWorkbench = item &&
      store.ui.editingLessonTitleId === item.id &&
      store.ui.editingLessonTitleSurface === "workbench";
    return `<header class="topbar"><div class="brand"><button class="secondary launcher-return" data-action="return-launcher" title="返回项目选择；当前项目不会关闭">⌂ <span>项目选择</span></button><span class="brand-mark">✦</span><span>AI Course Workbench</span></div>${
      store.ui.editingProjectTitle && store.ui.editingProjectTitleSurface === "topbar"
        ? `<div class="project-name editing"><span class="dot"></span><input class="project-title-input" data-project-title data-focus-key="project-title" value="${
          esc(store.data.project.title)
        }" aria-label="课程标题" /><span class="project-title-hint">Enter 保存 · Esc 取消</span></div>`
        : `<div class="project-name" data-action="edit-project-title" role="button" tabindex="0" title="点击修改课程标题"><span class="dot"></span>${
          esc(store.data.project.title)
        }<span class="chevron">⌄</span></div>`
    }<div class="lesson-switch">${
      item
        ? `<button class="icon-button" data-action="prev-lesson" title="打开上一课" ${
          map.previous_id ? "" : "disabled"
        }>‹</button>${editLessonInWorkbench
          ? `<input class="lesson-title-inline" data-lesson-title-inline data-id="${item.id}" data-focus-key="lesson-title-inline" aria-label="课程标题" value="${esc(item.title)}" />`
          : `<button class="lesson-pill" data-action="rename-lesson" data-title-surface="workbench" data-id="${item.id}" title="点击修改当前课程标题">${esc(item.code)}｜${esc(item.title)}</button>`
        }<button class="icon-button" data-action="next-lesson" title="打开下一课" ${
          map.next_id ? "" : "disabled"
        }>›</button>`
        : ""
    }</div><div class="top-actions">${saveStateView()}<button class="icon-button" data-action="undo" title="撤销上一次编辑">↶</button><button class="icon-button" data-action="redo" title="恢复上一次编辑">↷</button><button class="secondary" data-action="route" data-route="map">课程地图</button><button class="secondary" data-action="save-project">保存</button><button class="secondary" data-action="save-version">保存版本</button><button class="secondary" data-action="preview">预览</button><button class="primary" data-action="preflight">导出</button></div></header>
    <div class="tabs"><button class="tab home-tab ${
      store.ui.route === "overview" ? "active" : ""
    }" data-action="route" data-route="overview">项目概览</button>${
      store.tabs.map((tab) => {
        const target = store.data.content_items.find((candidate) =>
          candidate.id === tab.content_item_id
        );
        if (!target) return "";
        return `<button class="tab ${
          target.id === (item && item.id) ? "active" : ""
        }" data-action="open-item" data-id="${target.id}">${
          esc(target.code)
        }｜${esc(target.title)} <span class="tab-close" data-action="close-tab" data-id="${target.id}">×</span></button>`;
      }).join("")
    }</div>`;
  }

  function leftPanelView() {
    const map = courseMap(store.data, store.ui.activeId);
    const openInbox = store.data.inbox_items.filter((item) =>
      item.status === "open"
    ).length;
    const nav = [
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
    return `<aside class="left-panel panel"><div class="panel-heading"><span>工作台</span><button class="icon-button" data-action="toggle-left" title="${store.ui.leftCollapsed ? "展开左栏" : "收起左栏"}">${store.ui.leftCollapsed ? "☰" : "‹"}</button></div><nav>${
      nav.map(([route, label, icon]) => {
        const isWorkbench = route === "workbench";
        const active = isWorkbench
          ? store.ui.route === "editor"
          : store.ui.route === route;
        const action = isWorkbench
          ? 'data-action="open-workbench"'
          : `data-action="route" data-route="${route}"`;
        return `<button class="nav-item ${
          active ? "active" : ""
        }" ${action}><span class="nav-icon">${icon}</span><span>${label}</span>${
          route === "inbox" && openInbox ? `<b class="count">${openInbox}</b>` : ""
        }${
          route === "backlog" && map.open_requirements
            ? `<b class="count">${map.open_requirements}</b>`
            : ""
        }</button>`;
      }).join("")
    }</nav><div class="panel-footer">${
      map.lessons.length
        ? `<div class="side-head compact"><span class="eyebrow">本课程</span><span class="muted small">${
          map.complete_count
        }/${map.lesson_count} 课完成</span></div><div class="left-lessons">${
          map.stages.map((stage) =>
            `<div class="left-stage"><span class="left-stage-code">${
              esc(stage.code)
            }</span><span class="left-stage-title">${
              esc(stage.title)
            }</span></div>${
              stage.lessons.map((lesson) =>
                `<button class="left-lesson ${
                  lesson.current ? "active" : ""
                }" data-action="open-item" data-id="${lesson.id}" title="${
                  esc(lesson.title)
                }"><span class="left-lesson-code">${
                  esc(lesson.code)
                }</span><span class="left-lesson-title">${
                  esc(lesson.title)
                }</span><span class="lesson-dot ${
                  lesson.progress.complete ? "done" : "open"
                }"></span></button>`
              ).join("")
            }`
          ).join("")
        }</div>`
        : ""
    }<button class="nav-item" data-action="capture"><span class="nav-icon">＋</span><span>快速收集</span><kbd>⌘⇧空格</kbd></button><button class="nav-item" data-action="palette"><span class="nav-icon">⌕</span><span>搜索与命令</span><kbd>⌘K</kbd></button></div></aside>`;
  }

  function centerView() {
    if (store.ui.route === "editor") return editorView();
    if (store.ui.route === "map") return mapView();
    if (store.ui.route === "explorer") return explorerView();
    if (store.ui.route === "mapping") return mappingView();
    if (store.ui.route === "inbox") return inboxView();
    if (store.ui.route === "board") return boardView();
    if (store.ui.route === "media") return mediaView();
    if (store.ui.route === "backlog") return backlogView();
    if (store.ui.route === "versions") return versionsView();
    if (store.ui.route === "updates") {
      return simplePage(
        "更新中心",
        "待处理建议和需要更新的内容会在这里集中出现。",
        "✦",
      );
    }
    if (store.ui.route === "publish") return publishView();
    if (store.ui.route === "settings") {
      return simplePage("项目设置", "项目文件、默认视图和工作台偏好。", "⚙");
    }
    return overviewView();
  }

  /* --------------------------------------------------------- course map */

  /**
   * "你现在有什么？" — every button here maps to a real course-input source the
   * Domain supports, and the ones that cannot work yet say so instead of
   * pretending.  Nothing is created until the user confirms the draft.
   */
  function seedCard() {
    const active = store.ui.seedType;
    const hint = active ? SEED_SOURCE_HINTS[active] : null;
    return `<div class="card seed-card"><span class="eyebrow">你现在有什么？</span><h2>把已有的内容变成课程地图</h2><p class="muted">选中一类你手上已有的内容，粘贴进来，先生成一份课程地图草稿。确认草稿前不会创建正式阶段与内容。</p><div class="seed-grid">${
      SEED_TEXT_SOURCES.map((type) => {
        const entry = SEED_SOURCE_HINTS[type];
        return `<button class="${
          active === type ? "primary" : "secondary"
        }" data-action="pick-seed" data-type="${type}" title="${
          esc(entry.hint)
        }">${esc(entry.label)}</button>`;
      }).join("")
    }<button class="secondary" disabled title="${
      esc(SEED_SOURCE_HINTS.folder.hint)
    }">资料文件夹（暂不支持）</button></div>${
      hint
        ? `<div class="seed-input"><label class="field-label">${
          esc(hint.hint)
        }<textarea data-seed-text data-focus-key="seed-text" placeholder="${
          esc(hint.placeholder)
        }">${esc(store.ui.seedText || "")}</textarea></label><div class="modal-actions"><button class="primary" data-action="build-blueprint" ${
          store.ui.seedBusy ? "disabled" : ""
        }>${store.ui.seedBusy ? "正在生成…" : "生成课程地图草稿"}</button><button class="text-button" data-action="cancel-seed">取消</button></div></div>`
        : ""
    }</div>`;
  }

  function mapView() {
    const draft = (store.data.blueprint_drafts || []).find((candidate) =>
      candidate.status === "draft"
    );
    const draftNodes = draft
      ? (store.data.blueprint_nodes || []).filter((node) =>
        node.blueprint_id === draft.id
      ).sort((a, b) => a.order_index - b.order_index)
      : [];
    const draftCard = draft
      ? `<div class="card blueprint-confirm"><span class="eyebrow">待确认的课程地图</span><h2>${
        esc(draft.title)
      }</h2><p class="muted">确认前只保存课程输入和草稿，确认后才创建正式阶段与内容。</p><div class="blueprint-nodes">${
        draftNodes.map((node) =>
          `<div class="structure-row"><span class="order">${
            node.node_type === "stage" ? "阶段" : "内容"
          }</span><span>${esc(node.title)}</span></div>`
        ).join("")
      }</div><div class="modal-actions"><button class="secondary" data-action="discard-blueprint" data-id="${
        draft.id
      }">放弃这份草稿</button><button class="primary" data-action="confirm-blueprint" data-id="${
        draft.id
      }">确认课程地图并创建内容</button></div></div>`
      : "";
    const map = courseMap(store.data, store.ui.activeId);
    const realStages = map.stages.filter((stage) => stage.id);
    const mapProjectTitle = store.ui.editingProjectTitle &&
        store.ui.editingProjectTitleSurface === "map"
      ? `<input class="project-title-input map-project-title-input" data-project-title data-focus-key="project-title" value="${esc(store.data.project.title)}" aria-label="课程标题" />`
      : `<button class="inline-title-button map-project-title" data-action="edit-project-title" data-title-surface="map" title="点击修改课程标题">${esc(map.project_title)}</button>`;
    if (map.lesson_count === 0 && realStages.length === 0 && !draft) {
      return `<section class="page"><div class="page-head"><div><span class="eyebrow">课程地图</span><h1>${mapProjectTitle}</h1><p class="muted">课程还没有内容。可以先建第一课或新阶段，也可以把手上已有的材料变成课程地图。</p></div><div class="map-actions"><button class="secondary" data-action="select-project-properties">项目属性</button><button class="secondary" data-action="add-stage">＋ 新阶段</button><button class="primary" data-action="add-map-item">＋ 新建课程内容</button></div></div>${
        seedCard()
      }<div class="empty-state"><div class="empty-icon">▦</div><h2>还没有课程内容</h2><p class="muted">现在可以新建第一课，或先加一个阶段；课程地图会保留你的后续编辑。</p><div class="modal-actions"><button class="secondary" data-action="add-stage">＋ 新阶段</button><button class="primary" data-action="add-map-item">新建第一课</button></div></div></section>`;
    }
    return `<section class="page"><div class="page-head"><div><span class="eyebrow">课程地图</span><h1>${
      mapProjectTitle
    }</h1><p class="muted">${
      map.lesson_count
        ? `共 ${map.lesson_count} 课 · 已完成 ${map.complete_count} 课 · 待补 ${map.open_requirements} 项 · 缺素材 ${map.missing_media} 处`
        : "还没有内容，可以先新建第一课或新阶段"
    }</p>${
      map.lesson_count
        ? `<div class="progress-track wide"><span style="width:${map.progress}%"></span></div>`
        : ""
    }</div><div class="map-actions"><button class="secondary" data-action="select-project-properties">项目属性</button>${store.currentItem() ? `<button class="secondary" data-action="locate-current-lesson">定位当前课</button>` : ""}<button class="secondary" data-action="add-stage">＋ 新阶段</button><button class="secondary" data-action="add-map-item">＋ 新建课程内容</button>${
      map.next_lesson_id
        ? `<button class="primary" data-action="open-item" data-id="${map.next_lesson_id}">继续下一处未完成 →</button>`
        : ""
    }</div></div>${draftCard}<div class="course-map">${
      map.stages.map((stage, stageIndex) =>
        stageCard(stage, stageIndex, realStages.length)
      ).join("")
    }</div></section>`;
  }

  function stageCard(stage, stageIndex, stageCount) {
    const manageable = Boolean(stage.id);
    const collapsed = manageable && store.ui.collapsedStageIds.includes(stage.id);
    const editing = manageable && store.ui.editingStageTitleId === stage.id;
    const tools = manageable
      ? `<div class="stage-tools"><button class="icon-button stage-collapse-toggle" data-action="toggle-stage-collapse" data-id="${
        stage.id
      }" aria-expanded="${!collapsed}" title="${collapsed ? "展开阶段" : "折叠阶段"}">${collapsed ? "▸" : "⌄"}</button><button class="icon-button" data-action="rename-stage" data-id="${
        stage.id
      }" title="重命名阶段">✎</button><button class="icon-button" data-action="move-stage" data-id="${
        stage.id
      }" data-direction="up" title="上移阶段" ${
        stageIndex === 0 ? "disabled" : ""
      }>↑</button><button class="icon-button" data-action="move-stage" data-id="${
        stage.id
      }" data-direction="down" title="下移阶段" ${
        stageIndex >= stageCount - 1 ? "disabled" : ""
      }>↓</button><details class="stage-more"><summary class="icon-button" title="更多阶段操作">⋯</summary><div class="stage-more-menu"><button type="button" class="stage-more-item" data-action="add-stage" title="在课程地图新增阶段">＋ 新阶段</button><button type="button" class="stage-more-item" data-action="rename-stage" data-id="${
        stage.id
      }" title="重命名阶段">重命名</button><button type="button" class="stage-more-item danger" data-action="delete-stage" data-id="${
        stage.id
      }" title="删除阶段（空阶段需确认；有课时会先提示移动）">${TRASH_ICON} 删除阶段</button></div></details></div>`
      : "";
    const selectedPropertyStage = store.ui.propertyTarget?.kind === "stage" &&
      store.ui.propertyTarget.id === stage.id;
    return `<div class="stage-card ${stage.current ? "current" : ""}${collapsed ? " collapsed" : ""}" data-stage-id="${esc(stage.id)}" data-collapsed="${collapsed}"><div class="stage-head"><button type="button" class="stage-code stage-property-target ${selectedPropertyStage ? "selected" : ""}" data-action="select-stage-properties" data-id="${esc(stage.id)}" aria-pressed="${selectedPropertyStage}" title="查看阶段属性">${
      esc(stage.code)
    }</span><h2>${editing
      ? `<input class="stage-title-inline" data-stage-title-inline data-id="${stage.id}" data-focus-key="stage-title" aria-label="阶段名称" value="${esc(stage.title)}" />`
      : `<button class="inline-title-button stage-title-button" data-action="rename-stage" data-id="${stage.id}" title="点击修改阶段名称">${esc(stage.title)}</button>`
    }</h2><span class="stage-count">${
      stage.lessons.length
    } 课 · 完成 ${stage.complete_count}${
      stage.open_requirements ? ` · 待补 ${stage.open_requirements}` : ""
    }</span>${tools}</div><div class="map-items">${
      stage.lessons.length
        ? stage.lessons.map(mapItem).join("")
        : `<div class="side-empty map-empty-drop">这个阶段还没有内容；可以新建一课，或把课时拖到这里。</div>`
    }<div class="lesson-drop-end" aria-hidden="true">放入${esc(stage.title)}末尾</div></div></div>`;
  }

  /**
   * What is still missing in one lesson.  A per-lesson percentage was a made-up
   * number (it mixed six dimensions into one figure) and is replaced by the
   * gap counts the course actually tracks.
   */
  function lessonGapLabel(lesson) {
    const gaps = lesson.gaps || {};
    const missing = lesson.progress?.missing_media || 0;
    if (lesson.progress?.complete) return "已完成";
    const parts = [];
    if (gaps.total) parts.push(`待补 ${gaps.total} 项`);
    if (missing) parts.push(`缺素材 ${missing} 项`);
    if (!parts.length) parts.push("无待补");
    return parts.join(" · ");
  }

  function mapItem(lesson) {
    const progress = lesson.progress;
    const nextStep = nextStepLabel(lesson);
    const editing = store.ui.editingLessonTitleId === lesson.id &&
      store.ui.editingLessonTitleSurface === "map";
    const content = editing
      ? `<div class="map-open map-open-editing"><span class="map-item-code">${esc(lesson.code)}</span><span class="map-item-body"><input class="lesson-title-inline" data-lesson-title-inline data-id="${lesson.id}" data-focus-key="lesson-title-inline" aria-label="课程标题" value="${esc(lesson.title)}" /><small>${esc(lesson.summary)}</small></span><span class="map-item-meta"><span class="badge ${progress.complete ? "done" : "open"}">${lessonGapLabel(lesson)}</span><span class="map-item-state">${lesson.current ? "正在编辑" : progress.complete ? "已完成" : esc(progress.reasons[0] || nextStep)}</span></span><span class="map-arrow">›</span></div>`
      : `<button class="map-open" data-action="open-item" data-id="${lesson.id}"><span class="map-item-code">${esc(lesson.code)}</span><span class="map-item-body"><b>${esc(lesson.title)}</b><small>${esc(lesson.summary)}</small></span><span class="map-item-meta"><span class="badge ${progress.complete ? "done" : "open"}">${lessonGapLabel(lesson)}</span><span class="map-item-state">${lesson.current ? "正在编辑" : progress.complete ? "已完成" : esc(progress.reasons[0] || nextStep)}</span></span><span class="map-arrow">›</span></button>`;
    return `<div class="map-item ${lesson.current ? "current" : ""}" data-map-lesson="${lesson.id}"><button type="button" class="lesson-drag-handle" data-lesson-drag-handle="${lesson.id}" aria-label="拖动${esc(lesson.title)}">⠿</button>${content}<div class="map-item-tools"><button class="icon-button" data-action="rename-lesson" data-title-surface="map" data-id="${lesson.id}" title="重命名这一课">✎</button><button class="icon-button" data-action="move-lesson" data-id="${lesson.id}" data-direction="up" title="上移这一课" ${lesson.order_index === 0 ? "disabled" : ""}>↑</button><button class="icon-button" data-action="move-lesson" data-id="${lesson.id}" data-direction="down" title="下移这一课">↓</button><button class="icon-button danger" data-action="delete-lesson" data-id="${lesson.id}" title="删除这一课（会先确认；可以用撤销恢复）">${TRASH_ICON}</button></div></div>`;
  }

  /* ------------------------------------------------------ lesson editor */

  function editorView() {
    const item = store.currentItem();
    if (!item) {
      return emptyState(
        "还没有课程内容",
        "课程还没有可编辑的内容。打开课程地图新建一项，就可以继续。",
        "map",
        "打开课程地图",
      );
    }
    const view = store.lesson(item);
    const lesson = view ? view.lesson : null;
    const map = courseMap(store.data, item.id);
    const stage = store.data.stages.find((candidate) =>
      candidate.id === item.stage_id
    );
    return `<section class="editor-page"><div class="breadcrumbs"><button class="text-button" data-action="route" data-route="map">课程地图</button><b>/</b><span>${
      esc(stage ? stage.title : "未分组")
    }</span><b>/</b><strong>${esc(item.code)} ${esc(item.title)}</strong></div><div class="editor-head"><div><span class="eyebrow">${
      esc(item.code)
    } · ${esc(item.type)} · 第 ${
      map.current_index + 1
    }/${map.lesson_count} 课</span><h1>${esc(item.title)}</h1></div><div class="mode-switch">${
      EDITOR_MODES.map(([mode, label]) =>
        `<button class="mode-button ${
          store.ui.mode === mode ? "active" : ""
        }" data-action="mode" data-mode="${mode}">${label}</button>`
      ).join("")
    }</div></div><div class="lesson-strip">${
      lessonStrip(item, lesson)
    }</div><div class="editor-body">${
      store.ui.mode === "writing"
        ? writingView(item, view)
        : store.ui.mode === "structure"
        ? structureView(item, view)
        : store.ui.mode === "layout"
        ? layoutView(item, view)
        : previewView(item, view)
    }</div><div class="lesson-nav"><button class="secondary" data-action="prev-lesson" ${
      map.previous_id ? "" : "disabled"
    }>← 上一课</button><span class="muted small">${
      map.previous_id || map.next_id
        ? "跳课不会丢失未保存内容"
        : "这是唯一的一课"
    }</span><button class="secondary" data-action="next-lesson" ${
      map.next_id ? "" : "disabled"
    }>下一课 →</button></div></section>`;
  }

  function lessonStrip(item, lesson) {
    if (!lesson) return "";
    const progress = lesson.progress;
    const gaps = lesson.gaps;
    return `<div class="lesson-state"><span class="badge ${
      progress.complete ? "done" : "open"
    }">这一课${
      progress.complete ? "已完成" : "还没完成"
    }</span><div class="gap-counter">${
      gaps.by_type.image ? `<span>图片：缺 ${gaps.by_type.image} 张</span>` : ""
    }${gaps.by_type.gif ? `<span>GIF：缺 ${gaps.by_type.gif} 个</span>` : ""}${
      gaps.by_type.video ? `<span>视频：缺 ${gaps.by_type.video} 个</span>` : ""
    }${
      gaps.by_type.text
        ? `<span>文字：缺 ${gaps.by_type.text} 段</span>`
        : ""
    }${
      gaps.layout
        ? `<span>排版待补：${gaps.layout} 项</span>`
        : ""
    }${
      progress.missing_media
        ? `<span class="warning">素材缺失：${progress.missing_media} 处</span>`
        : ""
    }${
      gaps.total === 0 && !progress.missing_media
        ? `<span class="ok">待补：已齐</span>`
        : ""
    }</div><span class="lesson-next">下一步：${
      esc(nextStepLabel(lesson))
    }</span></div>${
      progress.complete
        ? ""
        : `<p class="side-note">${
          esc(progress.reasons.slice(0, 3).join("；"))
        }</p>`
    }`;
  }

  function writingView(item, view) {
    if (!view || view.blocks.length === 0) {
      return `${blockToolbar()}<div class="empty-state inline"><div class="empty-icon">✎</div><h2>这一课还没有正文</h2><p class="muted">课程内容还可以继续编辑。先写一段正文，也可以先加标题或留下待补项。</p><div class="modal-actions"><button class="primary" data-action="add-block">＋ 正文</button><button class="secondary" data-action="add-heading">＋ 标题</button><button class="secondary" data-action="add-placeholder">＋ 占位符</button></div></div>`;
    }
    return `${blockToolbar()}<div class="block-list">${
      view.blocks.map((block, index) => blockCard(block, index)).join("")
    }</div><button class="add-block-line" data-action="add-block-below" data-id="${
      view.blocks[view.blocks.length - 1].id
    }">＋ 继续写作</button>`;
  }

  function blockToolbar() {
    return `<div class="writing-toolbar">${
      BLOCK_PALETTE.map(([type, label]) =>
        `<button class="secondary" data-action="insert-block" data-type="${type}">＋ ${label}</button>`
      ).join("")
    }<span class="toolbar-hint">正文顺序决定语义；排版只负责空间位置</span></div>`;
  }

  function blockCard(block, index) {
    const selected = store.ui.selectedBlockId === block.id;
    const focused = block.requirement_id &&
      block.requirement_id === store.ui.focusRequirementId;
    const requirement = block.requirement_id
      ? store.data.requirements.find((candidate) =>
        candidate.id === block.requirement_id
      )
      : null;
    const size = block.size || blockSizeView(block);
    const typeLabel = esc(block.label || blockLabel(block.type));
    return `<article class="block block-${block.type} block-size-${
      size.tier
    } block-kind-${size.kind}${
      selected ? " selected" : ""
    }${focused ? " focused" : ""}" data-block-id="${block.id}" data-block-size="${
      size.tier
    }" data-requirement-id="${
      block.requirement_id || ""
    }"><div class="block-head"><span class="block-handle" title="按住拖动以调整正文顺序">⠿</span><span class="block-type-label">${typeLabel}</span><span class="block-order">${
      String(index + 1).padStart(2, "0")
    }</span><div class="block-head-actions"><button class="icon-button" data-action="insert-block-below" data-id="${
      block.id
    }" title="在这块正文下方插入">＋</button><details class="block-more"><summary class="icon-button" title="更多操作">⋯</summary><div class="block-more-menu"><button type="button" class="block-more-item" data-action="select-block" data-id="${
      block.id
    }" title="选中这块正文">◎ 选中</button><button type="button" class="block-more-item" data-action="move-block" data-id="${
      block.id
    }" data-direction="up" title="上移这块正文" ${
      index === 0 ? "disabled" : ""
    }>↑ 上移</button><button type="button" class="block-more-item" data-action="move-block" data-id="${
      block.id
    }" data-direction="down" title="下移这块正文">↓ 下移</button><button type="button" class="block-more-item danger" data-action="delete-block" data-id="${
      block.id
    }" title="删除这块正文（可以用撤销恢复）">${TRASH_ICON} 删除</button></div></details></div></div><div class="block-main">${
      blockBody(block, requirement)
    }</div></article>`;
  }

  function blockBody(block, requirement) {
    switch (block.type) {
      case "heading": {
        const level = Math.max(1, Math.min(4, block.level || 2));
        return `<input class="block-heading block-heading-${level}" data-block-id="${block.id}" value="${
          esc(block.text)
        }" aria-label="标题" placeholder="小节标题" /><span class="block-hint">H${level}${
          level === 1 ? "" : ` · 点击右栏属性可改级别`
        }</span>`;
      }
      case "divider":
        return `<hr class="block-divider" /><span class="block-hint">分隔线</span>`;
      case "placeholder":
        return `<div class="placeholder-body"><span class="placeholder-icon">□</span><div><span class="eyebrow">${
          requirement ? `${requirementTypeLabel(requirement.type)}待补` : "待补"
        }</span><p>${esc(block.text || "待补内容")}</p><small class="muted">${
          esc(requirement ? requirement.note : "还没有填写备注")
        } · ${
          requirement && requirement.status !== "open" ? "已完成" : "未完成"
        }</small></div><div class="placeholder-actions"><button class="secondary" data-action="pick-asset-for-requirement" data-id="${
          block.requirement_id || ""
        }">选择素材</button><button class="secondary" data-action="route" data-route="media">去媒体库</button><button class="secondary" data-action="edit-requirement" data-id="${
          block.requirement_id || ""
        }">改备注</button><button class="text-button" data-action="delete-requirement" data-id="${
          block.requirement_id || ""
        }">删除</button></div></div>`;
      case "image":
      case "gif":
      case "video":
      case "audio":
      case "embed":
        return mediaBody(block);
      case "callout":
      case "quote":
        return `<textarea class="block-text block-quote" data-block-id="${block.id}" aria-label="引用内容" placeholder="引用或提示内容">${
          esc(block.text)
        }</textarea><span class="block-hint">${esc(block.label)}</span>`;
      case "code":
        return `<textarea class="block-text block-code" data-block-id="${block.id}" aria-label="代码内容" placeholder="代码">${
          esc(block.text)
        }</textarea><span class="block-hint">代码</span>`;
      default:
        return `<textarea class="block-text" data-block-id="${block.id}" aria-label="正文内容" placeholder="开始写点什么…">${
          esc(block.text)
        }</textarea><span class="block-hint">${esc(block.label)}</span>`;
    }
  }

  function mediaBody(block) {
    const asset = block.asset;
    if (!asset) {
      return `<div class="media-slot empty"><span class="media-slot-icon">🖼</span><div><b>${
        esc(block.label)
      }还没有指向素材</b><small class="muted">选择或拖入素材后，这里会建立真实引用。</small></div><button class="secondary" data-action="pick-asset-for-block" data-id="${
        block.id
      }">选择素材</button></div>`;
    }
    const preview = assetPreview(asset);
    const url = preview?.url || "";
    const text = preview?.text;
    const body = (() => {
      if (asset.type === "video" && url) {
        return `<video class="asset-image" src="${esc(url)}" poster="${esc(preview.posterUrl || "")}" controls preload="metadata" playsinline></video>`;
      }
      if (asset.type === "audio" && url) {
        return `<audio class="asset-audio" src="${esc(url)}" controls preload="metadata"></audio>`;
      }
      if ((asset.type === "image" || asset.type === "gif") && url) {
        return `<img class="asset-image" src="${esc(url)}" alt="${
          esc(asset.title || asset.filename)
        }" />`;
      }
      if (preview?.pdf && url) {
        return `<iframe class="media-pdf-preview" src="${esc(url)}" title="${esc(asset.title || asset.filename)} · PDF 第一页预览" loading="lazy" referrerpolicy="no-referrer" style="display:block;width:100%;height:420px;border:0;background:#f4f4f4"></iframe>`;
      }
      // Markdown and other text bundles are material too: show the beginning
      // of the real file instead of an empty slot.
      if (typeof text === "string") {
        return `<pre class="media-document">${
          esc(text.slice(0, 1200) || "（空文档）")
        }</pre>`;
      }
      if (preview && preview.failed) {
        return `<div class="media-slot failed"><b>${esc(asset.filename)} · ${esc(assetLabel(asset.type))} 预览失败</b><small>${esc(preview.error || "素材不可读")}</small><small>请检查文件内容，或在媒体库替换为可读取的文件。</small>${retryAssetPreviewButton(asset)}</div>`;
      }
      if (preview?.loaded) {
        // This file is readable, but the current WebView has no renderer.
        return `<div class="media-slot attachment">📎 ${
          esc(asset.title || asset.filename)
        }（${esc(assetLabel(asset.type))} · ${esc(asset.type === "other" ? "当前格式不支持内嵌预览" : "参考文件，当前没有正文解析")})</div>`;
      }
      if (preview?.loading) {
        return `<div class="media-slot loading" data-asset-preview-key="${esc(preview.key || "")}">${preview.pending ? "正在读取素材预览…" : "靠近素材时加载预览…"}</div>`;
      }
      return `<div class="media-slot failed"><b>${esc(asset.filename)} 暂不可用</b><small>${asset.archived ? "素材已归档" : "找不到可读取的素材预览"}；请在媒体库检查或重新添加。</small></div>`;
    })();
    return `<div class="media-slot" data-block-id="${block.id}">${body}<div class="media-meta"><span class="badge">${
      assetLabel(asset.type)
    }</span><b>${esc(asset.title || asset.filename)}</b><small class="muted">${
      esc(asset.source_type)
    } · ${formatBytes(asset.file_size)}${
      asset.archived ? " · 已归档" : ""
    }</small></div><div class="media-actions"><button class="secondary" data-action="pick-asset-for-block" data-id="${
      block.id
    }">替换素材</button><button class="secondary" data-action="detach-asset" data-id="${
      block.id
    }" data-asset="${asset.id}">解除引用</button><button class="text-button" data-action="route" data-route="media">在媒体库查看</button></div></div>`;
  }

  function requirementTypeLabel(type) {
    return {
      text: "文字",
      image: "图片",
      gif: "GIF",
      video: "视频",
      audio: "音频",
      table: "表格",
      chart: "图表",
      quote: "引用",
      case: "案例",
      link: "链接",
      data: "数据",
      other: "其他",
    }[type] || "内容";
  }

  function structureView(item, view) {
    if (!view || view.blocks.length === 0) {
      return `<div class="empty-state inline"><h2>还没有可调整的结构</h2><p class="muted">这门课还没有正文，所以暂时没有结构可以调整。先回到正文继续写。</p><button class="primary" data-action="mode" data-mode="writing">回到正文</button></div>`;
    }
    const placementOf = (blockId) => view.placement_of(blockId);
    return `<div class="structure-toolbar"><span>结构视图只看结构：点击一行回到正文定位。调整先后顺序请到「排版 → Flow」。</span><button class="secondary" data-action="layout-mode" data-layout-mode="flow" title="到 Flow 调整正文先后顺序">到 Flow 调整顺序</button><button class="secondary" data-action="add-placeholder">＋ 添加占位符</button></div><div class="structure-list">${
      view.blocks.map((block, index) => {
        const placement = placementOf(block.id);
        const requirement = block.requirement_id
          ? store.data.requirements.find((candidate) =>
            candidate.id === block.requirement_id
          )
          : null;
        return `<div class="structure-row ${
          store.ui.selectedBlockId === block.id ? "selected" : ""
        }${block.asset_missing ? " has-gap" : ""}" data-structure-block="${
          block.id
        }"><span class="order">${
          String(index + 1).padStart(2, "0")
        }</span><button class="structure-jump" data-action="select-block" data-id="${
          block.id
        }"><b>${esc(block.label)}</b><span>${
          esc(block.summary || "（空）")
        }</span></button><span class="structure-flags">${
          block.asset_missing ? `<span class="badge warning">缺素材</span>` : ""
        }${
          requirement && requirement.status === "open"
            ? `<span class="badge open">待补</span>`
            : ""
        }${
          placement
            ? `<span class="badge">${view.pagination_mode === "paged" ? `已放在「${esc(view.pages.find((page) => page.id === placement.page_id)?.title || "其他页面")}」 · ` : "已排版 "}R${placement.row_start + 1}C${
              placement.column_start + 1
            }</span>`
            : ""
        }</span><button class="icon-button danger" data-action="delete-block" data-id="${
          block.id
        }" title="删除这块正文（可以用撤销恢复）">${TRASH_ICON}</button></div>`;
      }).join("")
    }</div>`;
  }

  /* ------------------------------------------------------------- layout */

  function layoutView(item, view) {
    const layout = view ? view.lesson.layout : null;
    if (!layout) {
      return `<div class="empty-state"><div class="empty-icon">▦</div><h2>还没有排版版本</h2><p class="muted">正文还没有排版位置。创建一个版本后，就可以继续安排内容。</p><button class="primary" data-action="create-layout">创建排版版本</button></div>`;
    }
    const mode = layout.mode === "flow" ? "flow" : "grid";
    const paged = layout.pagination_mode === "paged";
    const grid = view.page_grid || layout.grid_definition;
    const pageSize = resolvePageSize(layout);
    const toolbar = `<div class="layout-toolbar"><button class="secondary ${
      mode === "flow" ? "active-tool" : ""
    }" data-action="layout-mode" data-layout-mode="flow">Flow</button><button class="secondary ${
      mode === "grid" ? "active-tool" : ""
    }" data-action="layout-mode" data-layout-mode="grid">Grid</button>${
      mode === "grid"
        ? `<button class="secondary ${store.ui.gridEditing ? "active-tool" : ""}" data-action="grid-toggle-edit" title="行列结构会影响当前画布里的放置">${
          store.ui.gridEditing ? "完成编辑网格" : "编辑网格"
        }</button>${
          store.ui.gridEditing
            ? `<button class="secondary" data-action="grid-add-col">＋ 列</button><button class="secondary" data-action="grid-add-row">＋ 行</button><button class="secondary" data-action="grid-remove-col">− 列</button><button class="secondary" data-action="grid-remove-row">− 行</button><span class="toolbar-hint">正在编辑${paged ? "当前页" : "网格"}行列；已有放置会按现有规则调整。</span>`
            : `<span class="toolbar-hint">${grid.columns.length} 列 × ${grid.rows.length} 行${paged ? " · 有限页面" : " · 连续画布"}；修改行列前先点「编辑网格」。</span>`
        }${paged ? "" : `<button class="secondary" data-action="pagination-conversion">启用分页</button>`}<button class="secondary" data-action="grid-autofill">${paged ? "排入当前页" : "一键排版全部正文"}</button>`
        : `<span class="toolbar-hint">Flow 是一维文档流：这里调整的就是正文的先后顺序（写回 Canonical order）。</span>`
    }</div>`;
    const meta = `<div class="layout-meta"><span><b>${
      esc(layout.name)
    }</b> · ${mode === "flow" ? "Flow" : paged ? "分页 Grid" : "连续 Grid"}</span><span>${
      mode === "grid"
        ? paged
          ? `${view.pages.length} 页 · ${pageSize.width_pt} × ${pageSize.height_pt} pt · 页面尺寸与屏幕缩放分开`
          : `${grid.columns.length} 列 × ${grid.rows.length} 行 · 同一份正文只保存一次位置`
        : "正文顺序决定阅读顺序"
    }</span><button class="text-button" data-action="rename-layout">重命名排版</button></div>`;
    if (mode === "flow") {
      const first = view.blocks[0] ? view.blocks[0].id : "";
      const last = view.blocks.length
        ? view.blocks[view.blocks.length - 1].id
        : "";
      return `${toolbar}${meta}<div class="flow-canvas">${
        view.blocks.map((block, index) =>
          `<div class="flow-placement ${
            store.ui.selectedBlockId === block.id ? "selected" : ""
          }" data-structure-block="${block.id}"><span class="flow-order">${
            String(index + 1).padStart(2, "0")
          }</span><button class="flow-jump" data-action="select-block" data-id="${
            block.id
          }"><b>${esc(block.label)}</b><span>${
            esc(block.summary || "（空）")
          }</span></button><span class="flow-move"><button class="icon-button" data-action="move-block" data-id="${
            block.id
          }" data-direction="up" title="在正文顺序里上移一块" ${
            block.id === first ? "disabled" : ""
          }>↑</button><button class="icon-button" data-action="move-block" data-id="${
            block.id
          }" data-direction="down" title="在正文顺序里下移一块" ${
            block.id === last ? "disabled" : ""
          }>↓</button></span></div>`
        ).join("")
      }</div><p class="layout-note">Flow 就是正文顺序本身：这里的上移 / 下移直接写回 Canonical Block order，结构视图与预览都跟着同一条顺序走。</p>`;
    }
    const page = view.active_page;
    const placements = view.placements;
    const unplaced = view.unplaced_blocks;
    const gridTracks = (tracks) => tracks.map((track) => `minmax(0, ${Number(track) || 1}fr)`).join(" ");
    const pageGeometry = paged && page
      ? projectPageGeometry(layout, page, view.all_placements)
      : null;
    const zoomWidth = store.ui.layoutZoom === "actual"
      ? `${pageSize.width_pt * 4 / 3}px`
      : `min(100%, 900px, ${Math.min(68, 68 * pageSize.width_pt / pageSize.height_pt)}vh)`;
    const canvasStyle = paged
      ? `style="--cols:${grid.columns.length};--rows:${grid.rows.length};width:${zoomWidth};aspect-ratio:${pageSize.width_pt}/${pageSize.height_pt};grid-template-columns:${gridTracks(grid.columns)};grid-template-rows:${gridTracks(grid.rows)}"`
      : `style="--cols:${grid.columns.length};--rows:${grid.rows.length};"`;
    const pageOverflow = placements.filter((placement) =>
      placement.row_end > grid.rows.length || placement.column_end > grid.columns.length
    ).length;
    // P2-4: while a block is being moved the canvas highlights every cell it
    // can land in, and clicking one writes the new position.
    const movingId = store.ui.movingPlacementId || "";
    const moving = movingId
      ? placements.find((placement) => placement.id === movingId) || null
      : null;
    const blockOf = (placement) =>
      placement
        ? view.blocks.find((block) => block.id === placement.block_id) || null
        : null;
    return `${toolbar}${meta}${paged ? pageNavigation(view, layout) : sectionStrip(view.sections, placements)}${store.ui.paginationConversionPreview ? paginationConversionPreview(view, layout) : ""}${store.ui.pageSizePreview && !store.ui.pageSizePreview.conversion ? pageSizePreview(layout) : ""}<div class="grid-wrap ${
      store.ui.gridEditing ? "editing" : ""
    }${paged ? " paged-canvas-wrap" : ""}">${paged && !page ? `<p class="layout-note">当前分页布局还没有页面，请新建页面后继续。</p>` : ""}${pageGeometry ? `<span class="page-canvas-size" data-page-id="${pageGeometry.page_id}" data-width-pt="${pageGeometry.logical_width_pt}" data-height-pt="${pageGeometry.logical_height_pt}">${esc(page.title)} · ${pageGeometry.logical_width_pt} × ${pageGeometry.logical_height_pt} pt · ${store.ui.layoutZoom === "actual" ? "实际尺寸" : "适合窗口"}</span>` : ""}${pageOverflow ? `<div class="page-overflow-warning">${pageOverflow} 块内容超出当前网格范围；页面保留了原放置，请调整网格或位置。</div>` : ""}${
      movingId ? movingBanner(moving, blockOf(moving)) : ""
    }<div class="grid-canvas${paged ? " paged-grid-canvas" : ""}" ${canvasStyle}>${
      store.ui.gridEditing ? gridLabels(grid) : ""
    }${
      placements.map((placement) => {
        const block = view.blocks.find((candidate) =>
          candidate.id === placement.block_id
        );
        if (!block) return "";
        const cell = placementGrid(placement, grid);
        const isMoving = movingId === placement.id;
        return `<div class="placement${
          store.ui.selectedBlockId === block.id ? " selected" : ""
        }${isMoving ? " moving" : ""}" style="grid-row:${cell.row};grid-column:${
          cell.column
        };" data-placement="${placement.id}" data-structure-block="${
          placement.block_id
        }" data-row="${placement.row_start}" data-col="${
          placement.column_start
        }" tabindex="0" title="左键点击：移动这块内容 · 右键点击：移出网格"><span class="placement-label">${
          esc(block.label)
        }</span><span class="placement-text">${
          esc(block.summary || "（空）")
        }</span><span class="placement-cell">R${
          placement.row_start + 1
        }C${placement.column_start + 1}</span><div class="placement-actions"><button data-action="select-block" data-id="${
          placement.block_id
        }" title="编辑这块内容">✎</button>${paged && view.pages.length > 1 ? `<button data-action="start-page-move" data-id="${placement.id}" title="移动到其他页面">↗</button>` : ""}<button data-action="resize-placement" data-id="${
          placement.id
        }" data-dw="1" title="加宽一列">＋宽</button><button data-action="resize-placement" data-id="${
          placement.id
        }" data-dw="-1" title="减宽一列">−宽</button><button data-action="resize-placement" data-id="${
          placement.id
        }" data-dh="1" title="加高一行">＋高</button><button data-action="resize-placement" data-id="${
          placement.id
        }" data-dh="-1" title="减高一行">−高</button><button data-action="unplace-block" data-id="${
          placement.block_id
        }" title="移出网格（也可以直接右键）">✕</button></div></div>`;
      }).join("")
    }${
      movingId ? moveTargets(view, grid, moving) : ""
    }</div></div><div class="unplaced-strip"><span class="eyebrow" title="左键点击一块正文，它会落到第一个可用格子">还没有放进网格的正文</span>${
      unplaced.length
        ? `<div class="unplaced-list">${
          unplaced.map((block) =>
            `<button class="secondary unplaced-block" data-action="place-block" data-id="${
              block.id
            }" title="左键点击：放进第一个可用格子">＋ ${esc(block.label)}：${
              esc((block.summary || "（空）").slice(0, 18))
            }</button>`
          ).join("")
        }</div>`
        : `<span class="muted small">全部正文都已经放进网格</span>`
    }</div>${paged && view.placed_elsewhere_blocks?.length ? `<div class="placed-elsewhere"><span class="eyebrow">其他页面（${view.placed_elsewhere_blocks.length} 块）</span>${view.placed_elsewhere_blocks.map((block) => { const placement = view.placement_of(block.id); const pageTitle = view.pages.find((candidate) => candidate.id === placement?.page_id)?.title || "其他页面"; return `<button class="secondary" data-action="select-layout-page" data-id="${placement?.page_id || ""}">${esc(block.label)} · ${esc(pageTitle)}</button>`; }).join("")}</div>` : ""}${paged ? `<p class="compatibility-note">旧版工作台不识别独立页面；重新打开时会按连续网格显示，不会删除当前分页数据。</p>` : ""}<p class="layout-note">左键点正文上画布、左键点格子移动、右键移出；↑↓←→ 不再用于移动。网格只保存位置，正文、素材引用和待补仍然保存在原来的地方。</p>`;
  }

  function pageNavigation(view, layout) {
    const pages = view.pages || [];
    const current = view.active_page;
    const currentIndex = pages.findIndex((page) => page.id === current?.id);
    const preset = layout.page_size?.preset || "legacy";
    const sizeOptions = [
      ["16:9", "16:9 横向"],
      ["a4-portrait", "A4 纵向"],
      ["a4-landscape", "A4 横向"],
      ...(preset === "legacy" ? [["legacy", "继承旧尺寸"]] : []),
    ];
    return `<div class="paged-page-tools"><div class="page-tabs" role="tablist" aria-label="页面导航">${pages.map((page, index) => `<button role="tab" aria-selected="${page.id === current?.id}" class="page-tab ${page.id === current?.id ? "active" : ""}" data-action="select-layout-page" data-id="${page.id}" title="第 ${index + 1} 页 · ${esc(page.title)}"><span>第 ${index + 1} 页</span><small>${esc(page.title)}</small></button>`).join("")}<button class="secondary page-add" data-action="page-add">＋ 新建页</button></div><div class="page-action-row"><div class="page-actions"><button class="secondary" data-action="page-rename" data-id="${current?.id || ""}" ${!current ? "disabled" : ""}>重命名</button><button class="secondary" data-action="page-reorder" data-id="${current?.id || ""}" data-direction="up" ${currentIndex <= 0 ? "disabled" : ""}>↑ 上移</button><button class="secondary" data-action="page-reorder" data-id="${current?.id || ""}" data-direction="down" ${currentIndex < 0 || currentIndex >= pages.length - 1 ? "disabled" : ""}>↓ 下移</button><button class="secondary" data-action="page-duplicate" data-id="${current?.id || ""}" ${!current ? "disabled" : ""}>复制页</button><button class="secondary" data-action="page-delete" data-id="${current?.id || ""}" ${pages.length <= 1 ? "disabled title=\"至少保留一页\"" : ""}>删除页</button></div><div class="page-view-controls"><label class="page-size-control">页面尺寸<select class="select" data-action="page-size-preview">${sizeOptions.map(([value, label]) => `<option value="${value}" ${preset === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><button class="secondary ${store.ui.layoutZoom === "fit" ? "active-tool" : ""}" data-action="layout-zoom" data-zoom="fit">适合窗口</button><button class="secondary ${store.ui.layoutZoom === "actual" ? "active-tool" : ""}" data-action="layout-zoom" data-zoom="actual">实际尺寸</button></div></div>${store.ui.movingPlacementTargetPageId ? pageMovePanel(view, layout) : ""}</div>`;
  }

  function paginationConversionPreview(view, layout) {
    const sections = view.sections || [];
    const placements = view.all_placements || view.placements;
    const loose = placements.filter((placement) => !sections.some((section) => section.id === placement.section_id)).length;
    const pending = store.ui.pageSizePreview || {};
    const size = pending.size || resolvePageSize(layout);
    const options = [["legacy", "保留旧布局几何"], ["16:9", "16:9 横向"], ["a4-portrait", "A4 纵向"], ["a4-landscape", "A4 横向"]];
    return `<div class="page-conversion-preview"><b>转换预览：${sections.length ? `${sections.length} 个输出分区各生成一页` : "现有网格生成一页"}</b><span>已有 ${placements.length} 块放置会保留网格位置；${loose ? `${loose} 块未分组放置会归到第一页；` : ""}未放置正文继续留在未放置列表。转换可以撤销。</span><label>页面尺寸<select class="select" data-action="conversion-page-size">${options.map(([value, label]) => `<option value="${value}" ${pending.preset === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><small>${sections.length || 1} 页 · ${size.width_pt} × ${size.height_pt} pt · 页面标题和跨格位置保留</small><div class="page-confirm-actions"><button class="secondary" data-action="cancel-pagination-conversion">取消</button><button class="primary" data-action="confirm-pagination-conversion">确认启用分页</button></div></div>`;
  }

  function pageSizePreview(layout) {
    const pending = store.ui.pageSizePreview;
    const current = resolvePageSize(layout);
    const next = pending.size || current;
    return `<div class="page-size-preview"><span>全部 ${store.layoutPages().length} 页将从 ${current.width_pt} × ${current.height_pt} pt 调整为 ${next.width_pt} × ${next.height_pt} pt。页面内相对位置和跨格保持，屏幕缩放不变。</span><div class="page-confirm-actions"><button class="secondary" data-action="cancel-page-size">取消</button><button class="primary" data-action="confirm-page-size">确认并保存到历史</button></div></div>`;
  }

  function pageMovePanel(view, layout) {
    const pending = store.ui.movingPlacementTargetPageId;
    const placement = view.all_placements.find((candidate) => candidate.id === pending.placementId);
    if (!placement) return `<div class="page-move-panel"><span>这块放置已经不存在。</span><button class="text-button" data-action="cancel-page-move">关闭</button></div>`;
    const block = view.blocks.find((candidate) => candidate.id === placement.block_id);
    if (!pending.targetPageId) {
      return `<div class="page-move-panel"><b>移动「${esc(block?.label || "正文")}」到…</b>${view.pages.filter((page) => page.id !== placement.page_id).map((page) => `<button class="secondary" data-action="choose-page-move-target" data-id="${page.id}">${esc(page.title)}</button>`).join("")}<button class="text-button" data-action="cancel-page-move">取消</button></div>`;
    }
    const targetPage = view.pages.find((page) => page.id === pending.targetPageId);
    if (!targetPage) return "";
    const grid = pageGrid(layout, targetPage);
    const rowSpan = Math.max(1, placement.row_end - placement.row_start);
    const columnSpan = Math.max(1, placement.column_end - placement.column_start);
    const occupied = view.all_placements.filter((candidate) => candidate.page_id === targetPage.id);
    const targets = freeCellsFor(grid, occupied, { rowSpan, columnSpan });
    return `<div class="page-move-panel"><b>选择「${esc(targetPage.title)}」里的可用位置（跨 ${rowSpan} 行 × ${columnSpan} 列）</b>${targets.length ? targets.map((cell) => `<button class="secondary" data-action="move-placement-page-cell" data-id="${placement.id}" data-page-id="${targetPage.id}" data-row="${cell.row}" data-col="${cell.column}">R${cell.row + 1} · C${cell.column + 1}</button>`).join("") : `<span class="muted small">目标页没有能容纳此内容的空位；原放置保持不变。</span>`}<button class="text-button" data-action="cancel-page-move">取消</button></div>`;
  }

  /** The output-section strip above the canvas (P1-9). */
  function sectionStrip(sections, placements) {
    return `<div class="section-strip"><span class="section-strip-label" title="分区把网格里的一组位置归到同一次输出（多页导出时一页 = 一个分区）">输出分区</span>${
      sections.map((section) =>
        store.ui.editingSectionId === section.id
          ? `<span class="section-chip editing"><input class="section-name-input" data-section-name data-focus-key="section-name" data-id="${
            section.id
          }" value="${esc(section.name)}" aria-label="分区名称" /><small>Enter 保存 · Esc 取消</small></span>`
          : `<span class="section-chip"><button class="text-button" data-action="rename-section" data-id="${
            section.id
          }" title="重命名这个分区">${esc(section.name)}</button><small>${
            placements.filter((placement) => placement.section_id === section.id).length
          } 块 · 第 ${
            section.page_index + 1
          } 页</small><button class="icon-button danger" data-action="delete-section" data-id="${
            section.id
          }" title="删除这个分区（里面的内容会回到「未分区」，不会被删除）">${TRASH_ICON}</button></span>`
      ).join("") || `<span class="muted small">还没有分区；所有内容都在「未分区」里</span>`
    }<button class="secondary" data-action="grid-new-section" title="增加一个输出分区（多页导出时多一页）">＋ 分区</button></div>`;
  }

  /** The banner that names the block currently being moved (P2-4). */
  function movingBanner(placement, block) {
    return `<div class="grid-moving-banner" data-moving-placement="${
      placement ? placement.id : ""
    }"><b>正在移动：${
      esc(block ? block.label : "这块内容")
    }</b><span>点一个高亮格子放下，或按 Esc 取消。</span><button class="text-button" data-action="grid-cancel-move">取消移动</button></div>`;
  }

  /** Every cell the moving block can land in, highlighted and clickable. */
  function moveTargets(view, grid, placement) {
    if (!placement) return "";
    const rowSpan = Math.max(1, placement.row_end - placement.row_start);
    const columnSpan = Math.max(1, placement.column_end - placement.column_start);
    const allowed = freeCellsFor(grid, view.placements, {
      rowSpan,
      columnSpan,
      exceptId: placement.id,
    });
    return allowed.map((cell) => {
      const current = cell.row === placement.row_start &&
        cell.column === placement.column_start;
      return `<button class="grid-cell-target${
        current ? " current" : ""
      }" style="grid-row:${cell.row + 1};grid-column:${
        cell.column + 1
      };" data-action="grid-move-to" data-id="${placement.id}" data-row="${
        cell.row
      }" data-col="${cell.column}" ${
        current ? "disabled" : ""
      } title="${
        current ? "这块内容现在就在这里" : "把这块内容放到这里"
      }">${current ? "当前" : "放这里"}</button>`;
    }).join("");
  }

  function gridLabels(grid) {
    return `<div class="track-labels cols">${
      grid.columns.map((_, i) => `<span>C${i + 1}</span>`).join("")
    }</div><div class="track-labels rows">${
      grid.rows.map((_, i) => `<span>R${i + 1}</span>`).join("")
    }</div>`;
  }

  /* ------------------------------------------------------------ preview */

  /**
   * One block, rendered as preview HTML.  Flow and Grid both come through here,
   * so a block can never look different depending on the layout mode.
   */
  function previewBlockHtml(block, showNotes) {
    {
      switch (block.type) {
        case "heading": {
          const level = Math.max(1, Math.min(4, block.level || 2));
          return `<h${level}>${esc(block.text)}</h${level}>`;
        }
        case "quote":
          return `<blockquote>${esc(block.text)}</blockquote>`;
        case "code":
          return `<pre class="preview-code"><code>${
            esc(block.text)
          }</code></pre>`;
        case "divider":
          return `<hr />`;
        case "callout":
          return `<aside class="preview-callout">${
            esc(block.text)
          }</aside>`;
        case "placeholder":
          return showNotes
            ? `<div class="preview-placeholder">占位符：${
              esc(block.text)
            }（不在正式内容中）</div>`
            : "";
        case "image":
        case "gif":
        case "video":
        case "audio":
        case "embed":
          return previewMedia(block, showNotes);
        default:
          return block.text.trim()
            ? `<p>${esc(block.text)}</p>`
            : showNotes
            ? `<div class="preview-placeholder">这一段还是空的</div>`
            : "";
      }
    }
  }

  /**
   * A canvas extent that never clips content: a placement saved before the grid
   * definition shrank must still be visible in the preview (the preflight
   * reports the same case as a blocking `canvas_overflow`).
   */
  function previewExtent(placements, grid) {
    let rows = Array.isArray(grid?.rows) ? grid.rows.length : 1;
    let columns = Array.isArray(grid?.columns) ? grid.columns.length : 1;
    for (const placement of placements) {
      rows = Math.max(rows, Number(placement.row_end) || 1);
      columns = Math.max(columns, Number(placement.column_end) || 1);
    }
    return { rows: Math.max(1, rows), columns: Math.max(1, columns) };
  }

  /**
   * Grid projection: the same canonical blocks and the same LayoutInstance the
   * export reads, drawn at their real row/column/span.  Sections are separate
   * canvases because that is what a multi-page export does with them.
   */
  function previewGridHtml(view, layout, showNotes) {
    const grid = layout.grid_definition || { columns: [1], rows: [1] };
    const sections = view.sections || [];
    const inSection = (placement, sectionId) => placement.section_id === sectionId;
    const groups = [];
    for (const section of sections) {
      const placements = view.placements.filter((placement) =>
        inSection(placement, section.id)
      );
      if (placements.length) {
        groups.push({
          title: `${section.name} · 第 ${section.page_index + 1} 页`,
          grid: section.grid_definition || grid,
          placements,
        });
      }
    }
    const loose = view.placements.filter((placement) =>
      !sections.some((section) => inSection(placement, section.id))
    );
    if (loose.length) {
      groups.push({
        title: sections.length ? "未分区" : "",
        grid,
        placements: loose,
      });
    }
    if (!groups.length) {
      groups.push({ title: "", grid, placements: view.placements });
    }
    const canvases = groups.map((group) => {
      const extent = previewExtent(group.placements, group.grid);
      const cells = group.placements.map((placement) => {
        const block = view.blocks.find((candidate) =>
          candidate.id === placement.block_id
        );
        if (!block) return "";
        const cell = placementGrid(placement, {
          columns: new Array(extent.columns).fill(1),
          rows: new Array(extent.rows).fill(1),
        });
        return `<div class="preview-grid-cell" style="grid-row:${
          cell.row
        };grid-column:${cell.column};" data-preview-block="${
          block.id
        }">${previewBlockHtml(block, showNotes)}</div>`;
      }).join("");
      return `<section class="preview-canvas">${
        group.title
          ? `<span class="preview-section-tag">${esc(group.title)}</span>`
          : ""
      }<div class="preview-grid" style="--cols:${extent.columns};--rows:${
        extent.rows
      };">${cells}</div></section>`;
    }).join("");
    const placedIds = new Set(view.placements.map((placement) => placement.block_id));
    const unplaced = view.blocks.filter((block) => !placedIds.has(block.id));
    const unplacedHtml = unplaced.length
      ? `<div class="preview-unplaced"><span class="eyebrow" title="这些正文还没有网格位置；导出时它们排在正文顺序的末尾">还没有放进网格（${
        unplaced.length
      } 块）</span>${
        unplaced.map((block) =>
          `<div class="preview-unplaced-item" data-preview-block="${
            block.id
          }">${previewBlockHtml(block, showNotes)}</div>`
        ).join("")
      }</div>`
      : "";
    return {
      html: `${canvases}${unplacedHtml}`,
      unplacedCount: unplaced.length,
      grid,
    };
  }

  function previewPagedHtml(item, view, layout, showNotes) {
    const pages = view.pages || [];
    const page = view.active_page || pages[0];
    if (!page) return { html: `<div class="empty-state"><h2>还没有页面</h2><p>回到排版画布新建页面。</p></div>`, unplacedCount: view.blocks.length, grid: view.page_grid };
    const projection = buildPublicationProjection(store.data, {
      content_item_id: item.id,
      layout_instance_id: layout.id,
      page_ids: [page.id],
    });
    const projectedLayout = projection.lessons[0]?.layout;
    const projectedPage = projectedLayout?.pages?.[0];
    if (!projectedPage) return { html: "", unplacedCount: 0, grid: view.page_grid };
    const width = projectedPage.logical_width_pt;
    const height = projectedPage.logical_height_pt;
    const ratio = width / height;
    const displayWidth = store.ui.layoutZoom === "actual"
      ? `${width * 4 / 3}px`
      : `min(100%, 900px, ${Math.min(68, 68 * ratio)}vh)`;
    const blockById = new Map(view.blocks.map((block) => [block.id, block]));
    const items = projectedPage.items.map((entry) => {
      const block = blockById.get(entry.block_id);
      if (!block) return "";
      const rect = entry.rect;
      const style = `left:${rect.x_pt / width * 100}%;top:${rect.y_pt / height * 100}%;width:${rect.width_pt / width * 100}%;height:${rect.height_pt / height * 100}%;z-index:${entry.style.z_index};text-align:${esc(entry.style.alignment?.horizontal || "left")};`;
      return `<div class="page-preview-item" data-preview-block="${block.id}" style="${style}">${previewBlockHtml(block, showNotes)}</div>`;
    }).join("");
    const pageIndex = pages.findIndex((candidate) => candidate.id === page.id);
    const pageNav = `<div class="page-preview-tabs" role="tablist" aria-label="预览页面">${pages.map((candidate, index) => `<button role="tab" aria-selected="${candidate.id === page.id}" class="page-tab ${candidate.id === page.id ? "active" : ""}" data-action="select-layout-page" data-id="${candidate.id}">第 ${index + 1} 页 · ${esc(candidate.title)}</button>`).join("")}</div><div class="page-preview-controls"><span>${pageIndex + 1} / ${pages.length} · ${width} × ${height} pt</span><button class="secondary" data-action="layout-zoom" data-zoom="fit">适合窗口</button><button class="secondary" data-action="layout-zoom" data-zoom="actual">实际尺寸</button></div>`;
    const unplaced = (projectedLayout.unplaced_block_ids || []).map((blockId) => blockById.get(blockId)).filter(Boolean);
    const unplacedHtml = unplaced.length
      ? `<div class="preview-unplaced"><span class="eyebrow">还没有放在页面上（${unplaced.length} 块）</span>${unplaced.map((block) => `<div class="preview-unplaced-item" data-preview-block="${block.id}">${previewBlockHtml(block, showNotes)}</div>`).join("")}</div>`
      : "";
    return {
      html: `${pageNav}<div class="page-preview-viewport ${store.ui.layoutZoom === "actual" ? "actual" : "fit"}"><section class="page-preview-sheet" style="width:${displayWidth};aspect-ratio:${width}/${height}"><div class="page-preview-content">${items}</div></section></div>${unplacedHtml}`,
      unplacedCount: unplaced.length,
      grid: view.page_grid,
    };
  }

  function previewView(item, view) {
    if (!view) return "";
    const showNotes = store.ui.showPreviewNotes !== false;
    // Media blocks render their asset inline, so the gallery below the article
    // only summarises what is already shown instead of adding a second copy.
    const gallery = view.blocks.filter((block) => block.asset);
    const layout = view.lesson.layout;
    const pagedMode = Boolean(layout?.mode === "grid" && layout.pagination_mode === "paged");
    const gridMode = Boolean(
      layout && layout.mode === "grid" && (pagedMode || view.placements.length),
    );
    const projected = pagedMode
      ? previewPagedHtml(item, view, layout, showNotes)
      : gridMode
      ? previewGridHtml(view, layout, showNotes)
      : null;
    const body = gridMode ? "" : view.blocks.map((block) =>
      previewBlockHtml(block, showNotes)
    ).join("");
    const placedCount = view.placements.length;
    return `<div class="preview-toolbar"><span>预览只读取同一份正文与素材引用，编辑时实时更新。</span><label class="checkbox-inline"><input type="checkbox" data-preview-notes data-focus-key="preview-notes" ${
      showNotes ? "checked" : ""
    } /> 显示待补与空段落</label><button class="secondary" data-action="preflight">导出前检查</button></div><div class="preview-meta"><span>排版：${
      layout ? `${esc(layout.name)} · ${layout.mode === "flow" ? "Flow" : "Grid"}` : "未设置"
    }</span><span>${
      gridMode
        ? `${projected.grid.columns.length} 列 × ${projected.grid.rows.length} 行 · 已放置 ${placedCount} 块${
          projected.unplacedCount ? ` · 未上画布 ${projected.unplacedCount} 块` : ""
        }`
        : placedCount
        ? `Flow 按正文顺序输出（${placedCount} 块已放置，不影响顺序）`
        : "还没有网格放置"
    }</span><span>正文 ${view.blocks.length} 块</span></div><article class="preview-paper${
      gridMode || pagedMode ? " preview-paper-grid" : ""
    }">${
      gridMode
        ? projected.html
        : body ||
          `<p class="muted">这一课还没有正文。回到正文视图写一段，预览会自动更新。</p>`
    }</article><div class="preview-assets"><span class="eyebrow">本课引用的素材（${
      gallery.length
    } 个已在正文中显示）</span>${
      gallery.length
        ? `<div class="preview-asset-list">${
          gallery.map((block) =>
            `<span class="badge">${
              esc(block.asset.title || block.asset.filename)
            } · ${esc(assetLabel(block.asset.type))}</span>`
          ).join("")
        }</div>`
        : `<span class="muted small">这一课还没有使用素材，可以继续写正文。</span>`
    }</div>`;
  }

  function previewMedia(block, showNotes) {
    const asset = block.asset;
    if (!asset) {
      return showNotes
        ? `<div class="preview-placeholder">${
          esc(block.label)
        }：还没有选择素材。你可以继续编辑，或回到媒体库添加。</div>`
        : "";
    }
    // Markdown and other text bundles render their real content, which is the
    // whole point of importing them as material.
    const preview = assetPreview(asset);
    const url = preview?.url || "";
    if (preview?.failed) {
      return `<div class="preview-media-failed"><b>${esc(asset.filename)} · ${esc(assetLabel(asset.type))} 预览失败</b><p>${esc(preview.error || "素材不可读")}</p><p class="muted">请检查文件内容，或在媒体库替换为可读取的文件。</p>${retryAssetPreviewButton(asset)}</div>`;
    }
    if (preview?.loading) {
      return `<div class="preview-placeholder" data-asset-preview-key="${esc(preview.key || "")}">${preview.pending ? "正在读取" : "等待加载"} ${esc(asset.filename)}…</div>`;
    }
    if ((asset.type === "image" || asset.type === "gif") && url) {
      return `<figure><img src="${esc(url)}" alt="${
        esc(asset.title || asset.filename)
      }" /><figcaption>${esc(asset.title || asset.filename)}</figcaption></figure>`;
    }
    if (asset.type === "video" && url) {
      return `<figure><video src="${esc(url)}" poster="${esc(preview.posterUrl || "")}" controls preload="metadata" playsinline></video><figcaption>${
        esc(asset.title || asset.filename)
      }</figcaption></figure>`;
    }
    if (asset.type === "audio" && url) {
      return `<figure><audio src="${esc(url)}" controls preload="metadata"></audio><figcaption>${
        esc(asset.title || asset.filename)
      }</figcaption></figure>`;
    }
    if (preview?.pdf && url) {
      return `<figure class="preview-pdf"><iframe src="${esc(url)}" title="${esc(asset.title || asset.filename)} · PDF 第一页预览" loading="lazy" referrerpolicy="no-referrer" style="display:block;width:100%;height:560px;border:0;background:#f4f4f4"></iframe><figcaption>${esc(asset.title || asset.filename)} · PDF 第一页</figcaption></figure>`;
    }
    const text = preview?.text;
    if (typeof text === "string") {
      return `<figure class="preview-document"><figcaption>${
        esc(asset.title || asset.filename)
      } · Markdown</figcaption><pre class="preview-markdown">${
        esc(text.slice(0, 4000) || "（空文档）")
      }</pre></figure>`;
    }
    if (preview?.loaded) return `<p class="preview-attachment">📎 ${
      esc(asset.title || asset.filename)
    }（${esc(assetLabel(asset.type))} · ${esc(asset.type === "other" ? "当前格式不支持内嵌预览" : "参考文件，当前没有正文解析")})</p>`;
    return `<div class="preview-media-failed"><b>${esc(asset.filename)} 暂不可用</b><p>${asset.archived ? "素材已归档" : "找不到可读取的素材预览"}；请在媒体库检查或重新添加。</p></div>`;
  }

  /* ------------------------------------------------------------ backlog */

  function backlogView() {
    const backlog = requirementBacklog(store.data);
    const map = courseMap(store.data, store.ui.activeId);
    if (backlog.total === 0) {
      return `<section class="page"><div class="page-head"><div><span class="eyebrow">长期维护</span><h1>待补总览</h1><p class="muted">整门课程的待补内容会集中出现在这里。</p></div></div><div class="empty-state"><div class="empty-icon">✓</div><h2>目前没有待补内容</h2><p class="muted">课程没有需要补充的项目，可以继续检查课程地图或开始发布。</p><button class="primary" data-action="route" data-route="map">回到课程地图</button></div></section>`;
    }
    const groups = [...backlog.by_lesson.entries()];
    return `<section class="page"><div class="page-head"><div><span class="eyebrow">长期维护</span><h1>待补总览 <sup>${
      backlog.total
    }</sup></h1><p class="muted">隔几天回来时，从这里就能知道下一步该补什么。</p></div><button class="primary" data-action="route" data-route="map">课程地图</button></div><div class="backlog-list">${
      groups.map(([lessonId, entries]) => {
        const lesson = map.lessons.find((candidate) => candidate.id === lessonId);
        return `<section class="backlog-group"><div class="backlog-head"><b>${
          esc(lesson ? `${lesson.code}｜${lesson.title}` : "未知内容")
        }</b><span class="badge open">${entries.length} 项</span><button class="text-button" data-action="open-item" data-id="${
          lessonId
        }">进入这一课 →</button></div>${
          entries.map((entry) =>
            `<div class="backlog-row"><span class="req-dot open">!</span><span class="backlog-note"><b>${
              esc(requirementTypeLabel(entry.type))
            }</b><span>${esc(entry.note || "没有备注")}</span>${
              entry.anchor_text
                ? `<small class="muted">位置：${
                  esc(entry.anchor_text.slice(0, 40))
                }</small>`
                : `<small class="muted">位置：整课</small>`
            }</span><span class="backlog-priority">${
              entry.priority === "high" ? "重要" : ""
            }</span><button class="secondary" data-action="focus-requirement" data-id="${
              entry.id
            }">定位</button></div>`
          ).join("")
        }</section>`;
      }).join("")
    }</div></section>`;
  }

  /* ------------------------------------------------------------ overview */

  function overviewView() {
    const map = courseMap(store.data, store.ui.activeId);
    const openInbox = store.data.inbox_items.filter((item) =>
      item.status === "open"
    ).length;
    const resumeId = store.resumeLessonId();
    const resume = map.lessons.find((lesson) => lesson.id === resumeId) || null;
    const backlog = requirementBacklog(store.data);
    return `<section class="page"><div class="page-head"><div><span class="eyebrow">项目概览</span><h1>${
      esc(store.data.project.title)
    }</h1><p class="muted">从想法到发布，今天继续完成一小步。</p></div><button class="primary" data-action="route" data-route="map">打开课程地图 →</button></div><div class="summary-grid"><div class="summary-card"><span>课程内容</span><strong>${
      map.lesson_count
    }</strong><small>已完成 ${map.complete_count} 课</small></div><div class="summary-card ${
      map.open_requirements ? "warning" : ""
    }"><span>待补内容</span><strong>${
      map.open_requirements
    }</strong><small>${backlog.by_lesson.size} 课涉及</small></div><div class="summary-card"><span>收件箱</span><strong>${openInbox}</strong><small>条待处理输入</small></div><div class="summary-card"><span>媒体</span><strong>${
      store.data.assets.filter((asset) => !asset.archived).length
    }</strong><small>个项目素材</small></div></div><div class="overview-grid"><div class="card"><div class="card-head"><h2>继续工作</h2>${
      resume
        ? `<button class="text-button" data-action="open-item" data-id="${resume.id}">打开 →</button>`
        : ""
    }</div>${
      resume
        ? `<div class="continue-row"><span class="continue-code">${
          esc(resume.code)
        }</span><div><b>${esc(resume.title)}</b><p class="muted">${
          esc(resume.summary)
        }</p><div class="progress-track"><span style="width:${
          resume.progress.percentage
        }%"></span></div><small class="muted">${
          resume.progress.complete
            ? "这一课已经完成"
            : esc(resume.progress.reasons.slice(0, 2).join("；"))
        }</small></div></div>`
        : `<div class="side-empty">还没有课程内容。打开课程地图新建一课，就可以继续。</div>`
    }</div><div class="card"><div class="card-head"><h2>待处理</h2><button class="text-button" data-action="route" data-route="backlog">查看全部 →</button></div><ul class="task-list"><li><span class="task-dot orange"></span><span>收件箱</span><b>${openInbox}</b></li><li><span class="task-dot purple"></span><span>待补内容</span><b>${
      map.open_requirements
    }</b></li><li><span class="task-dot blue"></span><span>缺素材</span><b>${
      map.missing_media
    }</b></li></ul></div></div></section>`;
  }

  /* --------------------------------------------------------------- inbox */

  function inboxView() {
    const items = store.data.inbox_items.filter((item) =>
      item.status !== "archived"
    );
    return `<section class="page"><div class="page-head"><div><span class="eyebrow">项目级输入</span><h1>收件箱 <sup>${
      items.length
    }</sup></h1><p class="muted">先收进来，以后再决定它是素材、正文还是待补内容。</p></div><button class="primary" data-action="capture">＋ 快速收集</button></div><div class="inbox-list">${
      items.length
        ? items.map((item) =>
          `<article class="inbox-card"><div class="inbox-type">${
            item.source_type === "web" ? "🔗" : item.asset_id ? "🖼" : "📝"
          }</div><div class="inbox-main"><span class="eyebrow">${
            esc(item.source_type === "web" ? "网页" : "灵感")
          }</span><h2>${esc(item.title)}</h2><p>${
            esc(item.body)
          }</p><small class="muted">${
            item.status === "triaged"
              ? "已分配到课程"
              : item.asset_id
              ? "已保存为素材"
              : "尚未决定用途"
          }</small></div><div class="inbox-actions"><button class="secondary" data-action="triage-inbox" data-id="${
            item.id
          }" ${
            store.ui.activeId ? "" : "disabled"
          }>加入当前课程</button>${
            item.asset_id
              ? ""
              : `<button class="secondary" data-action="assetize-inbox" data-id="${item.id}">保存为素材</button>`
          }<button class="text-button" data-action="ignore-inbox" data-id="${
            item.id
          }">忽略</button></div></article>`
        ).join("")
        : emptyState(
          "收件箱是空的",
          "用快速收集保存一句话、网页或截图。",
          "capture",
          "快速收集",
        )
    }</div></section>`;
  }

  /* --------------------------------------------------------------- board */

  function boardView() {
    const dimension = store.ui.boardDimension || "content";
    const map = courseMap(store.data, store.ui.activeId);
    const options = store.statusOptions(dimension);
    const selectedOf = (lesson) => {
      const status = lesson.progress.statuses.find((candidate) =>
        candidate.key === dimension
      );
      return status && status.option ? status.option : options[0] || "";
    };
    return `<section class="page"><div class="page-head"><div><span class="eyebrow">制作进度</span><h1>制作看板</h1><p class="muted">状态由你决定，完整度由待补自动计算。先选维度，再拖动卡片。</p></div><label class="field-label board-dimension">正在修改的维度<select class="select" data-board-dimension aria-label="正在修改的状态维度">${
      [
        ["content", "正文"],
        ["media", "媒体"],
        ["layout", "排版"],
        ["review", "审核"],
        ["publish", "发布"],
        ["update", "更新"],
      ].map(([key, label]) =>
        `<option value="${key}" ${
          dimension === key ? "selected" : ""
        }>${label}</option>`
      ).join("")
    }</select></label></div><div class="kanban">${
      options.map((option) =>
        `<div class="kanban-column" data-board-option="${
          esc(option)
        }"><div class="kanban-head"><span>${esc(option)}</span><b>${
          map.lessons.filter((lesson) => selectedOf(lesson) === option).length
        }</b></div>${
          map.lessons.filter((lesson) => selectedOf(lesson) === option).map((
            lesson,
          ) =>
            `<button draggable="true" class="kanban-card ${
              lesson.current ? "current" : ""
            }" data-action="open-item" data-board-id="${lesson.id}" data-id="${
              lesson.id
            }"><span>${esc(lesson.code)}</span><b>${
              esc(lesson.title)
            }</b><small>${
              lesson.progress.complete
                ? "已完成"
                : `待补 ${lesson.progress.open_requirements}`
            }</small></button>`
          ).join("")
        }</div>`
      ).join("")
    }</div></section>`;
  }

  /* --------------------------------------------------------------- media */

  function explorerView() {
    const report = store.ui.folderScan;
    const rootLabel = store.ui.importFolderRoot || report?.root || "";
    const entries = Array.isArray(report?.entries) ? report.entries : [];
    const filter = String(store.ui.explorerFilter || "");
    const filtered = filterExplorerEntries(entries, filter);
    const tree = buildExplorerTree(filtered);
    const expanded = new Set(
      Array.isArray(store.ui.explorerExpanded) ? store.ui.explorerExpanded : [],
    );
    const selected = store.ui.explorerSelected || "";
    const preview = store.ui.explorerPreview;

    const renderNode = (node, depth) => {
      const isDir = node.kind === "directory";
      const isOpen = expanded.has(node.relative_path);
      const isSelected = selected === node.relative_path;
      const entry = node.entry || {};
      const type = explorerTypeLabel(entry);
      const status = explorerStatusLabel(entry);
      const size = isDir || entry.size == null ? "—" : formatBytes(entry.size);
      const toggle = isDir
        ? `<button class="explorer-toggle" data-action="explorer-toggle" data-path="${
          esc(node.relative_path)
        }" title="${isOpen ? "折叠" : "展开"}" aria-expanded="${isOpen ? "true" : "false"}">${
          isOpen ? "▾" : "▸"
        }</button>`
        : `<span class="explorer-toggle spacer"></span>`;
      const children = isDir && isOpen
        ? node.children.map((child) => renderNode(child, depth + 1)).join("")
        : "";
      return `<div class="explorer-row ${isSelected ? "selected" : ""} ${
        entry.error ? "degraded" : ""
      }" style="--explorer-depth:${depth}" data-action="explorer-select" data-path="${
        esc(node.relative_path)
      }">${toggle}<span class="explorer-name" title="${
        esc(node.relative_path)
      }">${isDir ? "📁" : "📄"} ${esc(node.name)}</span><span class="explorer-type">${
        esc(type)
      }</span><span class="explorer-size">${esc(size)}</span><span class="explorer-status">${
        esc(status)
      }</span></div>${children}`;
    };

    const previewPane = () => {
      if (!selected || !preview) {
        return `<div class="explorer-preview-empty"><div class="empty-icon">📂</div><h2>选择一个文件查看预览</h2><p class="muted">Markdown / TXT 显示文本；图片显示缩略图；视频显示媒体卡；PDF / DOCX 显示文件信息（作为参考文件导入）。不会出现白板。</p></div>`;
      }
      const name = explorerEntryName(preview.relative_path || selected);
      const meta = [
        explorerTypeLabel({
          relative_path: preview.relative_path || selected,
          mime: preview.mime,
          kind: preview.preview_kind === "directory" ? "directory" : "file",
          suggested_role: preview.preview_kind === "reference" ? "reference" : null,
        }),
        preview.size != null ? formatBytes(preview.size) : null,
        preview.mime || null,
      ].filter(Boolean).join(" · ");
      const head =
        `<div class="explorer-preview-head"><span class="eyebrow">文件预览</span><h2>${
          esc(name)
        }</h2><p class="muted">${esc(meta || selected)}</p></div>`;
      if (preview.loading) {
        return `${head}<div class="explorer-preview-body loading"><p class="muted">正在读取预览…</p></div>`;
      }
      if (preview.failed) {
        return `${head}<div class="explorer-preview-body failed"><p>${
          esc(preview.error || preview.note || "无法预览该文件")
        }</p></div>`;
      }
      if (preview.preview_kind === "text" && typeof preview.text === "string") {
        const isMd = /\.(md|markdown)$/i.test(name);
        return `${head}<div class="explorer-preview-body text">${
          isMd
            ? `<div class="explorer-md">${markdownToHtml(preview.text)}</div>`
            : `<pre class="explorer-text">${esc(preview.text)}</pre>`
        }</div>`;
      }
      if (preview.preview_kind === "image" && preview.url) {
        return `${head}<div class="explorer-preview-body media"><img class="explorer-image" src="${
          esc(preview.url)
        }" alt="${esc(name)}" /></div>`;
      }
      if (preview.preview_kind === "video" && preview.url) {
        return `${head}<div class="explorer-preview-body media"><div class="explorer-media-card"><video class="explorer-video" src="${
          esc(preview.url)
        }" controls preload="metadata" playsinline></video><small>视频媒体卡</small></div></div>`;
      }
      if (preview.preview_kind === "audio" && preview.url) {
        return `${head}<div class="explorer-preview-body media"><div class="explorer-media-card"><audio class="explorer-audio" src="${
          esc(preview.url)
        }" controls preload="metadata"></audio><small>音频</small></div></div>`;
      }
      if (preview.preview_kind === "reference") {
        return `${head}<div class="explorer-preview-body reference"><div class="explorer-reference-card"><span class="asset-attachment-icon">📎</span><div><b>${
          esc(name)
        }</b><p class="muted">文件信息 · ${
          esc(meta || "参考文件")
        }</p><p><strong>作为参考文件导入</strong></p><p class="muted">当前版本不提供完整正文解析；确认导入前不会改写原文件。</p></div></div></div>`;
      }
      if (preview.preview_kind === "directory") {
        return `${head}<div class="explorer-preview-body"><p class="muted">这是一个文件夹。展开左侧树可浏览其中的文件。</p></div>`;
      }
      return `${head}<div class="explorer-preview-body"><p class="muted">${
        esc(preview.note || "当前版本暂不支持预览此类型")
      }</p></div>`;
    };

    if (!report) {
      return `<section class="page explorer-page"><div class="page-head"><div><span class="eyebrow">外部源资料</span><h1>资源浏览器</h1><p class="muted">浏览已扫描的文件夹树；只读，不会写入课程项目。确认导入在后续步骤。</p></div><button class="primary" data-action="import-folder-again">导入已有文件夹</button></div><div class="empty-state"><div class="empty-icon">📂</div><h2>还没有扫描结果</h2><p class="muted">从项目选择页使用「导入已有文件夹」，或点上方按钮选择一个文件夹（桌面应用）。</p></div></section>`;
    }

    return `<section class="page explorer-page"><div class="page-head"><div><span class="eyebrow">外部源资料</span><h1>资源浏览器</h1><p class="muted">只读浏览 · ${
      esc(rootLabel || "已扫描文件夹")
    } · 不会改写原文件，也不会写入课程项目。</p></div><div class="page-head-actions"><button class="secondary" data-action="import-folder-again">重新选择文件夹</button><button class="primary" data-action="open-import-mapping">打开映射预览</button></div></div><div class="explorer-layout"><div class="explorer-tree-pane"><label class="field-label">按文件名过滤<input class="select" data-explorer-filter data-focus-key="explorer-filter" placeholder="输入文件名" value="${
      esc(filter)
    }" /></label><div class="explorer-columns"><span></span><span>文件</span><span>类型</span><span>大小</span><span>可识别状态</span></div><div class="explorer-tree">${
      tree.length
        ? tree.map((node) => renderNode(node, 0)).join("")
        : `<div class="side-empty">没有匹配「${esc(filter)}」的文件名</div>`
    }</div></div><div class="explorer-preview-pane">${previewPane()}</div></div></section>`;
  }

  function mappingView() {
    const plan = store.ui.importMappingPlan;
    const report = store.ui.folderScan;
    const rootLabel = store.ui.importFolderRoot || plan?.root || report?.root || "";
    if (!report && !plan) {
      return `<section class="page mapping-page"><div class="page-head"><div><span class="eyebrow">导入映射</span><h1>映射预览</h1><p class="muted">根据扫描结果给出候选映射；标记为「建议」，不是事实。</p></div><button class="primary" data-action="import-folder-again">导入已有文件夹</button></div><div class="empty-state"><div class="empty-icon">🗂</div><h2>还没有映射建议</h2><p class="muted">请先扫描文件夹，再打开映射预览。</p></div></section>`;
    }
    const items = Array.isArray(plan?.items) ? plan.items : [];
    const selectedCount = items.filter((item) => item.selected).length;
    const roleOptions = (current) =>
      IMPORT_MAPPING_ROLES.map((role) =>
        `<option value="${role}" ${role === current ? "selected" : ""}>${
          esc(mappingRoleLabel(role))
        }</option>`
      ).join("");
    const rows = items.map((item) => {
      const name = explorerEntryName(item.relative_path) || item.relative_path;
      const suggestion = mappingRoleLabel(item.suggested, { suggestion: true });
      return `<tr class="mapping-row ${item.selected ? "" : "deselected"} ${
        item.error ? "degraded" : ""
      }"><td><input type="checkbox" data-mapping-select data-path="${
        esc(item.relative_path)
      }" ${item.selected ? "checked" : ""} ${item.error ? "disabled" : ""} /></td><td class="mapping-name" title="${
        esc(item.relative_path)
      }">${item.kind === "directory" ? "📁" : "📄"} ${esc(name)}<small class="muted">${
        esc(item.relative_path)
      }</small></td><td><span class="mapping-suggestion" title="建议，不是事实">${
        esc(suggestion)
      }</span></td><td><select class="select mapping-role" data-mapping-role data-path="${
        esc(item.relative_path)
      }" ${item.error ? "disabled" : ""}>${roleOptions(item.mapping)}</select></td></tr>`;
    }).join("");
    const status = plan?.confirmed
      ? `<p class="mapping-confirmed">已确认导入计划（${selectedCount} 项）。下一步：写入课程项目（原地接管，不移动原文件）。</p>`
      : `<p class="muted">已选 ${selectedCount} / ${items.length} 项 · 以下均为<strong>建议</strong>，可取消勾选或修改映射后，再点「确认导入计划」。</p>`;
    const actions = plan?.confirmed
      ? `<button class="secondary" data-action="route" data-route="explorer">返回资源浏览器</button><button class="secondary" data-action="confirm-import-mapping">重新确认</button><button class="primary" data-action="apply-folder-adoption">写入课程项目</button>`
      : `<button class="secondary" data-action="route" data-route="explorer">返回资源浏览器</button><button class="primary" data-action="confirm-import-mapping">确认导入计划</button>`;
    return `<section class="page mapping-page"><div class="page-head"><div><span class="eyebrow">导入映射</span><h1>映射预览</h1><p class="muted">候选映射 · ${
      esc(rootLabel || "已扫描文件夹")
    } · 建议 ≠ 事实 · 确认后可原地写入课程项目。</p></div><div class="page-head-actions">${actions}</div></div>${status}<div class="mapping-table-wrap"><table class="mapping-table"><thead><tr><th>导入</th><th>文件 / 文件夹</th><th>建议</th><th>映射为</th></tr></thead><tbody>${
      rows || `<tr><td colspan="4" class="side-empty">没有可映射的条目</td></tr>`
    }</tbody></table></div></section>`;
  }

  function mediaView() {
    const assets = store.data.assets.filter((asset) => !asset.archived);
    const usageCount = (assetId) => usagesForAsset(store.data, assetId).length;
    return `<section class="page"><div class="page-head"><div><span class="eyebrow">项目资产</span><h1>媒体库 <sup>${
      assets.length
    }</sup></h1><p class="muted">导入只创建素材；「插入到当前位置」会在选中区块之后新建媒体块（无选中则追加到课末），并建立真实引用。</p></div><button class="primary" data-action="open-file">＋ 添加素材</button></div>${PROJECT_FILE_PICKER}<div class="drop-zone" data-drop-zone="assets"><span class="drop-icon">⇧</span><b>拖入文件，或点击添加素材</b><small>图片、GIF、视频、音频、Markdown 和普通附件</small></div><div class="asset-grid">${
      assets.length
        ? assets.map((asset) => {
          const usages = usagesForAsset(store.data, asset.id);
          const lessons = [...new Set(usages.map((usage) =>
            usage.content_item_id
          ))].map((id) =>
            store.data.content_items.find((item) => item.id === id)
          ).filter(Boolean);
          const displayName = asset.title || asset.filename;
          const renaming = store.ui.editingAssetId === asset.id;
          return `<article class="asset-card" data-asset-id="${
            asset.id
          }"><div class="asset-thumb-wrap">${mediaLibraryPreview(asset)}</div><div class="asset-info">${
            renaming
              ? `<label class="field-label">显示名称<input class="select" data-asset-title data-focus-key="asset-title" data-id="${asset.id}" value="${
                esc(displayName)
              }" /></label>`
              : `<b>${esc(displayName)}</b>`
          }<small>${esc(assetLabel(asset.type))} · ${
            esc(asset.filename)
          } · ${formatBytes(asset.file_size)}</small><small>${
            usages.length
              ? `使用位置：${
                lessons.map((item) => esc(item.code)).join("、")
              }`
              : "还没有被任何内容引用"
          }</small></div><div class="asset-actions">${
            store.ui.activeId
              ? `<button class="secondary" data-action="insert-asset" data-id="${asset.id}">插入到当前位置</button>`
              : ""
          }${
            renaming
              ? `<button class="secondary" data-action="cancel-rename-asset">取消</button>`
              : `<button class="text-button" data-action="rename-asset" data-id="${asset.id}">重命名</button>`
          }<button class="text-button danger" data-action="delete-asset" data-id="${
            asset.id
          }">删除</button></div></article>`;
        }).join("")
        : `<div class="empty-state inline"><h2>还没有素材</h2><p class="muted">课程还没有素材。拖入文件，或点击“添加素材”后继续。</p></div>`
    }</div></section>`;
  }

  function versionsView() {
    return `<section class="page"><div class="page-head"><div><span class="eyebrow">长期历史</span><h1>版本历史</h1><p class="muted">撤销解决手滑，自动保存防丢失，历史版本帮助你回到明确节点。</p></div><button class="primary" data-action="save-version">保存版本</button></div><div class="version-list">${
      store.data.snapshots.length
        ? store.data.snapshots.map((snapshot) =>
          `<article class="version-card"><span class="version-icon">◷</span><div><b>${
            esc(snapshot.name)
          }</b><p>${esc(snapshot.note || "没有备注")}</p><small>${
            new Date(snapshot.created_at).toLocaleString("zh-CN")
          }</small></div><button class="secondary" data-action="restore-version" data-id="${
            snapshot.id
          }">恢复</button></article>`
        ).join("")
        : emptyState(
          "还没有命名版本",
          "课程还没有可回到的历史节点。保存一个版本后，就可以随时恢复。",
          "save-version",
          "保存版本",
        )
    }</div></section>`;
  }

  function publishView() {
    const item = store.currentItem();
    const courseScope = store.ui.publishScope === "course";
    const publications = (store.data.publications || []).filter((publication) =>
      courseScope || publication.content_item_id === (item && item.id)
    );
    const view = item ? store.lesson(item) : null;
    const layout = !courseScope && item ? store.layout(item) : null;
    const adapters = getAvailablePublicationAdapters({
      native: store.bridge.isNative(),
      service: !store.bridge.isNative(),
    });
    const formats = [
      ["markdown", "Markdown", "可编辑文本与稳定相对素材引用"],
      ["html", "Semantic HTML", "无需 Workbench 即可独立阅读"],
      ["web", "Static Web Package", "index.html + 实际使用的素材"],
      ["pdf", "PDF", "交付、阅读与留档"],
      ["pptx", "PowerPoint", "按页面尺寸生成演示文稿"],
      ["wechat", "微信 / 富文本", "保守样式与媒体迁移提示"],
      ["json", "Project JSON", "去除私有会话的结构化备份"],
      ["asset_package", "素材包", "素材文件与 manifest"],
      ["full_project", "完整项目包", "可恢复课程数据、正文与素材"],
    ];
    const projection = (() => {
      try { return store.publicationProjection(); } catch { return null; }
    })();
    const targetSize = store.ui.publishTargetPageSize;
    const adapter = adapters[store.ui.publishFormat];
    const supportsLayout = adapter?.layout === true;
    const canChooseTargetSize = supportsLayout ||
      ["html", "web", "pdf", "pptx"].some((format) =>
        adapters[format]?.available && adapters[format]?.layout
      );
    const showLayoutControls = courseScope || layout?.mode === "grid";
    const selectedCapability = projection
      ? store.publicationCapability(store.ui.publishFormat, projection)
      : { status: "unavailable", code: null };
    const requiresTargetSize = projection && ["pdf", "pptx"].some((format) =>
      store.publicationCapability(format, projection).code === "explicit_target_page_size_required"
    );
    const targetSizeNotice = requiresTargetSize
      ? `<p class="publish-size-warning" role="status">全课程页面尺寸不同。PDF 和 PowerPoint 需要统一目标尺寸；请选择输出尺寸后查看逐页适配预览。</p>`
      : "";
    const originalSizeLabel = requiresTargetSize
      ? "页面尺寸不同，需选择统一尺寸"
      : "各课保持原尺寸";
    const fitPages = targetSize && projection
      ? projection.lessons.flatMap((lesson) => (lesson.layout?.pages || []).map((page) => {
        const fit = fitPageRect(
          page.logical_width_pt,
          page.logical_height_pt,
          targetSize.width_pt,
          targetSize.height_pt,
        );
        return { lesson, page, fit };
      }))
      : [];
    const pageRange = layout?.pagination_mode === "paged" && view && supportsLayout
      ? `<div class="publish-layout-controls"><b>页面范围</b><div class="publish-page-options">${[
        ["all", "全部页面"], ["current", "当前页"], ["selected", "选定页面"],
      ].map(([mode, label]) => `<button class="secondary ${store.ui.publishPageMode === mode ? "active-tool" : ""}" data-action="publish-page-mode" data-mode="${mode}" aria-pressed="${store.ui.publishPageMode === mode}">${label}</button>`).join("")}</div>${store.ui.publishPageMode === "selected" ? `<div class="publish-page-options">${view.pages.map((page, index) => `<label><input type="checkbox" data-action="publish-page-toggle" data-id="${page.id}" ${store.ui.publishSelectedPageIds.includes(page.id) ? "checked" : ""}/>第 ${index + 1} 页 · ${esc(page.title)}</label>`).join("")}</div>` : ""}<small class="muted">导出页序遵循排版页面顺序；不改变课程内容。</small></div>`
      : "";
    const targetSizeControl = canChooseTargetSize
      ? `<label class="page-size-control">输出页面尺寸<select class="select" data-action="publish-target-size"><option value="original" ${!targetSize ? "selected" : ""}>${originalSizeLabel}</option>${[["16:9", "16:9 横向"], ["a4-portrait", "A4 纵向"], ["a4-landscape", "A4 横向"], ["custom", "自定义尺寸"]].map(([preset, label]) => `<option value="${preset}" ${targetSize?.preset === preset ? "selected" : ""}>${label}</option>`).join("")}</select></label>${targetSize?.preset === "custom" ? `<div class="publish-page-options"><label>宽度 (pt)<input class="select" type="number" min="1" max="100000" step="1" data-action="publish-target-size-value" data-axis="width_pt" value="${targetSize.width_pt}"/></label><label>高度 (pt)<input class="select" type="number" min="1" max="100000" step="1" data-action="publish-target-size-value" data-axis="height_pt" value="${targetSize.height_pt}"/></label></div>` : ""}`
      : `<span class="muted small">当前格式不保留页面尺寸或位置。</span>`;
    const fitPreview = canChooseTargetSize && targetSize && fitPages.length
      ? `<div class="publish-fit-preview"><b>等比适配预览</b><div class="publish-fit-pages">${fitPages.slice(0, 8).map(({ lesson, page, fit }) => `<div class="publish-fit-page-card"><div class="fit-target-page" style="aspect-ratio:${targetSize.width_pt}/${targetSize.height_pt}"><div class="fit-source-page" style="left:${fit.x_pt / targetSize.width_pt * 100}%;top:${fit.y_pt / targetSize.height_pt * 100}%;width:${fit.width_pt / targetSize.width_pt * 100}%;height:${fit.height_pt / targetSize.height_pt * 100}%"></div></div><small>${esc(lesson.code)} · ${esc(page.title || `第 ${page.order + 1} 页`)} · ${fit.scale.toFixed(3)}×</small></div>`).join("")}</div><span>整页等比缩放并居中，不裁切；目标尺寸只用于本次输出。${fitPages.length > 8 ? `显示前 8 页，共 ${fitPages.length} 页。` : ""}</span></div>`
      : canChooseTargetSize && targetSize
      ? `<div class="publish-fit-preview">所选范围没有已排版页面可供尺寸适配预览。</div>`
      : canChooseTargetSize && projection?.lessons.some((lesson) => lesson.layout?.pages?.length > 1)
      ? `<div class="publish-fit-preview">不同课程可保留各自页面尺寸；选择统一目标尺寸后会显示等比缩放与居中预览，不会裁切。</div>`
      : "";
    const last = store.ui.lastExport;
    return `<section class="page"><div class="page-head"><div><span class="eyebrow">OUTPUT & PUBLISH</span><h1>发布与导出</h1><p class="muted">从同一份课程内容生成可搬走的结果；导出不会改写正文、排版或素材引用。</p></div><div class="page-head-actions">${store.ui.publishReturnContext ? `<button class="secondary" data-action="return-publish-source">返回来源页面</button>` : ""}<button class="primary" data-action="preflight">运行导出前检查</button></div></div>
      <div class="card publish-card"><h2>1. 选择输出范围</h2><div class="segmented"><button class="${courseScope ? "" : "active"}" data-action="publish-scope" data-scope="lesson">当前课${item ? ` · ${esc(item.code)}` : ""}</button><button class="${courseScope ? "active" : ""}" data-action="publish-scope" data-scope="course">整门课程</button></div><p class="muted">${courseScope ? `整门课程 · ${store.data.content_items.filter((candidate) => !candidate.archived).length} 课` : view ? `${esc(item.title)} · 完成 ${view.progress.percentage}% · 待补 ${view.progress.open_requirements} 项` : "尚未选择课程"}</p></div>
      ${showLayoutControls ? `<div class="card publish-card"><h2>2. 输出布局与页面</h2><div class="publish-layout-controls">${pageRange}${layout?.pagination_mode === "paged" && !supportsLayout ? `<p class="muted">当前格式不会保留页面布局，因此无法按页筛选。</p>` : ""}<div class="page-action-row">${targetSizeControl}</div>${targetSizeNotice}${fitPreview}</div><p class="muted">页面筛选与目标尺寸仅影响本次导出；尺寸不同的课时会按同一比例居中适配，不裁掉页面内容。</p></div>` : ""}
      <div class="card publish-card"><h2>3. 选择格式</h2><div class="format-grid">${formats.map(([key, label, detail]) => { let capability = { status: "unavailable" }; try { capability = store.publicationCapability(key); } catch { /* selection validation is shown in preflight */ } const unavailable = ["unavailable", "unsupported"].includes(capability.status); const capabilityLabel = capability.code === "explicit_target_page_size_required" ? "请先选择统一尺寸" : capability.status === "available" ? (adapters[key]?.layout ? "页面布局保留" : "可用") : capability.status === "lossy" ? "页面布局会线性化" : capability.status === "unsupported" ? "当前排版不支持" : "此环境不可用"; return `<button class="format-card ${store.ui.publishFormat === key ? "active" : ""}" data-action="publish-format" data-format="${key}" ${unavailable ? "disabled" : ""}><b>${label}</b><small>${detail}</small><small class="format-capability">${capabilityLabel}</small></button>`; }).join("")}</div><div class="modal-actions"><button class="secondary" data-action="preflight">运行导出前检查</button></div></div>
      ${store.ui.preflight ? publishPreflightView() : ""}
      ${last ? `<div class="card publish-card success-card"><h2>最近一次导出</h2><p><b>${esc(last.format)}</b> · ${last.scope === "course" ? "整门课程" : "当前课"} · ${last.files} 个文件</p><p class="muted">实际位置：<code>${esc(last.path)}</code></p><p class="muted">输出不依赖 Workbench 运行。</p>${store.bridge.isNative() ? `<button class="secondary" data-action="reveal-export">在 Finder 中显示</button>` : ""}</div>` : ""}
      <div class="card publish-card"><h2>发布记录</h2><p class="muted">发布记录只记录你确认过的发布节点，不会改变课程内容。</p><button class="secondary" data-action="record-publication">记录已发布</button></div><div class="version-list">${publications.map((publication) => `<article class="version-card"><span class="version-icon">↗</span><div><b>${esc(publication.version_label)}</b><p>${esc(publication.platform)} · ${esc(publication.status)}</p><small>${esc(publication.published_at || "")}</small></div></article>`).join("") || `<div class="empty-state"><h2>还没有发布记录</h2><p class="muted">导出并实际迁移后，可以记录这个发布节点；课程内容不会因此改变。</p></div>`}</div></section>`;
  }

  function publishPreflightView() {
    const report = store.ui.preflightReport || store.exportPreflight();
    const issues = Array.isArray(report.issues) ? report.issues : [];
    const warningIssues = issues.filter((issue) => issue.severity === "warning" && issue.code);
    const requiredCodes = new Set(warningIssues.map((issue) => issue.code));
    const acknowledged = new Set(store.ui.acknowledgedWarnings || []);
    const allWarningsAcknowledged = [...requiredCodes].every((code) => acknowledged.has(code)) &&
      !(report.warnings > 0 && !requiredCodes.size);
    const selection = store.publicationOptions();
    const frozen = store.ui.preflightOptions;
    const sameSelection = frozen && ["content_item_id", "layout_instance_id", "page_ids", "target_page_size"].every((key) =>
      JSON.stringify(frozen[key] ?? null) === JSON.stringify(selection[key] ?? null)
    );
    const current = Boolean(
      sameSelection &&
      store.ui.preflightRevision === store.data.project.updated_at &&
      store.ui.preflightFormat === store.ui.publishFormat
    );
    return `<div class="card publish-card publish-preflight" aria-live="polite"><h2>4. 导出前检查</h2><p class="muted">先检查课程内容与素材。必须修复的问题会阻止导出；逐项确认提示后才会生成文件。此检查不会修改课程，也不会调用 AI。</p>${store.ui.preflightPending ? `<p class="preflight-pending" role="status">正在检查当前课程快照…</p>` : ""}<div class="check-list">${[
      ["内容级待补", report.content, false],
      ["当前排版待补", report.layout, false],
      ["缺失素材文件", report.missingAssets, true],
      ["超出画布", report.overflow, true],
      ["空正文 / 文字提醒", report.text, false],
      ["未加载字体", report.fonts, false],
      ["外部引用", report.external, false],
      ["媒体降级", report.mediaDowngrades || 0, false],
    ].map(([label, count, blocking]) => `<div><span class="check ${count ? blocking ? "danger" : "warning" : "ok"}">${count || "✓"}</span><span>${label}</span><b>${count}</b></div>`).join("")}</div>${issues.length ? `<div class="issue-list">${issues.map((issue) => `<article class="${issue.severity === "blocking" ? "issue-blocking" : "issue-warning"}"><b>${issue.severity === "blocking" ? "必须修复" : "提示"}</b><span>${esc(issueMessage(issue))}</span>${issueDiagnostics(issue)}</article>`).join("")}</div>` : ""}${warningIssues.length ? `<div class="warning-ack-list"><b>逐项确认本次输出提示</b>${warningIssues.map((issue) => `<label><input type="checkbox" data-action="acknowledge-export-warning" data-code="${esc(issue.code)}" ${acknowledged.has(issue.code) ? "checked" : ""}/><span>${esc(issueMessage(issue))}${issue.count > 1 ? `（${issue.count} 项）` : ""}</span></label>`).join("")}</div>` : ""}<div class="preflight-total">必须修复 <strong>${report.blocking}</strong> · 提示 <strong>${report.warnings}</strong></div>${!current && !store.ui.preflightPending ? `<p class="warning-text">课程或输出范围在检查后发生变化，请重新运行检查后再导出。</p>` : ""}${report.blocking ? `<p class="error-text">当前不能导出：请先修复上面标为“必须修复”的问题。不会生成半成品，也不会修改源课程。</p>` : report.warnings ? `<p class="muted">未放置正文、线性化或媒体降级会按上方说明处理；确认提示后才会继续生成。</p>` : `<p class="success-text">检查通过，可以生成输出；源课程不会被修改。</p>`}<div class="modal-actions"><button class="secondary" data-action="preflight" ${store.ui.preflightPending ? "disabled" : ""}>重新运行检查</button><button class="primary" data-action="export-format" data-format="${esc(store.ui.publishFormat)}" ${!current || store.ui.preflightPending || report.blocking || !allWarningsAcknowledged ? "disabled" : ""}>${report.warnings ? "确认提示并导出" : "开始导出"}</button></div></div>`;
  }

  function simplePage(title, description, icon) {
    const item = store.currentItem();
    return `<section class="page simple-page"><div class="simple-icon">${icon}</div><span class="eyebrow">项目工作台</span><h1>${title}</h1><p class="muted">${description}</p>${
      item
        ? `<button class="primary" data-action="open-item" data-id="${item.id}">继续编辑 ${
          esc(item.code)
        } →</button>`
        : `<button class="primary" data-action="route" data-route="map">打开课程地图</button>`
    }</section>`;
  }

  function emptyState(title, description, action, label) {
    const attributes = action === "capture"
      ? 'data-action="capture"'
      : action === "map"
      ? 'data-action="route" data-route="map"'
      : action === "writing"
      ? 'data-action="mode" data-mode="writing"'
      : 'data-action="add-block"';
    return `<div class="empty-state"><div class="empty-icon">✦</div><h2>${title}</h2><p class="muted">${description}</p><button class="primary" ${attributes}>${label}</button></div>`;
  }

  /* --------------------------------------------------------- right rail */

  function propertyTargetInfo() {
    const target = store.ui.propertyTarget;
    if (target?.kind === "project") {
      return { kind: "project", project: store.data.project };
    }
    if (target?.kind === "stage") {
      const stage = store.data.stages.find((candidate) =>
        candidate.id === target.id && !candidate.archived
      );
      if (stage) return { kind: "stage", stage };
    }
    const item = store.ui.activeId
      ? store.data.content_items.find((candidate) =>
        candidate.id === store.ui.activeId && !candidate.archived
      ) || null
      : null;
    return item
      ? { kind: "lesson", item }
      : { kind: "project", project: store.data.project };
  }

  function rightPanelView() {
    const item = store.currentItem();
    const view = item ? lessonView(store.data, item.id) : null;
    const target = propertyTargetInfo();
    const selectedBlock = view && store.ui.selectedBlockId
      ? view.blocks.find((block) => block.id === store.ui.selectedBlockId)
      : null;
    const scope = store.ui.rightPanel === "properties"
      ? selectedBlock
        ? `区块 · ${selectedBlock.label}`
        : target.kind === "stage"
        ? `阶段 · ${target.stage.code} ${target.stage.title}`
        : target.kind === "project"
        ? `项目 · ${target.project.title}`
        : `课时 · ${target.item.code} ${target.item.title}`
      : item
      ? `${item.code}｜${item.title}`
      : "未选择课程";
    return `<aside class="right-panel panel"><div class="right-tabs">${
      RIGHT_PANELS.map(([key, label]) =>
        `<button class="right-tab ${
          store.ui.rightPanel === key ? "active" : ""
        }" data-action="right-panel" data-panel="${key}">${label}${
          key === "requirements" && view && view.progress.open_requirements
            ? `<sup>${view.progress.open_requirements}</sup>`
            : ""
        }</button>`
      ).join("")
    }<button class="icon-button collapse-right" data-action="toggle-right" title="${store.ui.rightCollapsed ? "展开右栏" : "收起右栏"}">${store.ui.rightCollapsed ? "☰" : "›"}</button></div><div class="right-content" data-panel-scope="${
      esc(scope)
    }"><div class="scope-banner">作用对象：<b>${esc(scope)}</b></div>${
      store.ui.rightPanel === "media"
        ? mediaPanel(view)
        : store.ui.rightPanel === "requirements"
        ? requirementsPanel(view)
        : store.ui.rightPanel === "status"
        ? statusPanel(view)
        : store.ui.rightPanel === "assistant"
        ? assistantPanel()
        : store.ui.rightPanel === "properties"
        ? propertiesPanel(view)
        : versionsPanel()
    }</div></aside>`;
  }

  function mediaPanel(view) {
    const assets = store.data.assets.filter((asset) => !asset.archived);
    const query = String(store.ui.assetQuery || "").trim().toLowerCase();
    const visibleAssets = assets.filter((asset) =>
      !query ||
      asset.filename.toLowerCase().includes(query) ||
      String(asset.title).toLowerCase().includes(query)
    );
    const used = view ? view.lesson.media_count : 0;
    const insertAnchor = store.ui.selectedBlockId
      ? "会插入到当前选中区块之后"
      : "会追加到当前课末尾";
    return `<div class="side-head"><div><span class="eyebrow">当前课程</span><h2>媒体库</h2></div><button class="icon-button" data-action="open-file" title="添加素材">＋</button></div><label class="field-label">搜索素材<input class="select" data-asset-search placeholder="输入文件名" value="${
      esc(store.ui.assetQuery || "")
    }" /></label>${PROJECT_FILE_PICKER}<p class="side-note">本课已引用 ${used} 个素材。选择素材${insertAnchor}。</p><div class="side-list">${
      visibleAssets.length
        ? visibleAssets.map((asset) => {
          const usages = usagesForAsset(store.data, asset.id);
          const displayName = asset.title || asset.filename;
          const preview = assetPreview(asset);
          return `<div class="side-item asset-row" data-asset-id="${
            asset.id
          }"><span class="side-thumb-wrap">${assetThumb(asset)}</span><span class="side-item-body"><b>${
            esc(displayName)
          }</b><small>${esc(assetLabel(asset.type))} · ${
            usages.length ? `已使用 ${usages.length} 处` : "还没有被引用"
          }</small></span><span class="side-item-tools">${preview?.failed ? retryAssetPreviewButton(asset, true) : ""}<button class="icon-button" data-action="insert-asset" data-id="${
            asset.id
          }" title="插入到当前位置">＋</button><button class="icon-button" data-action="rename-asset" data-id="${
            asset.id
          }" title="修改显示名称">✎</button><button class="icon-button" data-action="show-asset-usage" data-id="${
            asset.id
          }" title="查看这个素材的使用位置">?</button></span></div>`;
        }).join("")
        : assets.length
        ? `<div class="side-empty">没有找到匹配的素材。换一个文件名继续搜索。</div>`
        : `<div class="side-empty">还没有素材。点击“添加素材”导入第一个文件。</div>`
    }</div>${
      store.ui.assetUsageId ? assetUsagePanel(store.ui.assetUsageId) : ""
    }`;
  }

  function assetUsagePanel(assetId) {
    const asset = store.data.assets.find((candidate) =>
      candidate.id === assetId
    );
    if (!asset) return "";
    const usages = usagesForAsset(store.data, assetId);
    return `<div class="usage-box"><div class="side-head"><b>使用位置</b><button class="icon-button" data-action="hide-asset-usage" title="关闭使用位置">×</button></div>${
      usages.length
        ? usages.map((usage) => {
          const item = store.data.content_items.find((candidate) =>
            candidate.id === usage.content_item_id
          );
          const block = usage.block_id
            ? store.data.blocks.find((candidate) =>
              candidate.id === usage.block_id
            )
            : null;
          return `<button class="side-item" data-action="focus-usage" data-id="${
            usage.content_item_id
          }" data-block="${
            usage.block_id || ""
          }"><span>${esc(item ? item.code : "未知")}</span><small>${
            esc(block ? blockLabel(block.type) : "整课引用")
          } · ${esc(usage.role)}</small></button>`;
        }).join("")
        : `<p class="side-note">还没有被引用。</p>`
    }<button class="text-button danger" data-action="delete-asset" data-id="${
      asset.id
    }">删除这个素材</button></div>`;
  }

  function requirementsPanel(view) {
    if (!view) return `<div class="side-empty">还没有选中课程。先在左侧选择一课，就可以继续。</div>`;
    const gaps = view.lesson.gaps;
    const requirements = view.requirements;
    const open = requirements.filter((requirement) =>
      requirement.status === "open"
    );
    const done = requirements.filter((requirement) =>
      requirement.status !== "open"
    );
    return `<div class="side-head"><div><span class="eyebrow">完成这一课</span><h2>待补 <sup>${
      open.length
    }</sup></h2></div><button class="icon-button" data-action="add-placeholder" title="新增待补占位符">＋</button></div><div class="gap-summary"><div><b>${
      gaps.content
    }</b><span>内容待补</span></div><div><b>${
      gaps.layout
    }</b><span>排版待补</span></div><div><b>${
      view.progress.missing_media
    }</b><span>缺素材</span></div></div><div class="modal-actions compact"><button class="secondary" data-action="add-requirement-text">＋ 文字待补</button><button class="secondary" data-action="add-requirement-image">＋ 图片待补</button></div><div class="side-list">${
      open.length
        ? open.map((requirement) => requirementRow(requirement)).join("")
        : `<div class="side-empty">这一课没有未完成的待补内容，可以继续写正文或查看预览。</div>`
    }</div>${
      done.length
        ? `<details class="done-group"><summary>已完成 ${done.length} 项</summary>${
          done.map((requirement) => requirementRow(requirement)).join("")
        }</details>`
        : ""
    }<p class="side-note">待补会一直保存，重开项目后仍然可以定位到这里。</p>`;
  }

  function requirementRow(requirement) {
    const editing = store.ui.editingRequirementId === requirement.id;
    const block = requirement.anchor_block_id
      ? store.data.blocks.find((candidate) =>
        candidate.id === requirement.anchor_block_id
      )
      : null;
    const asset = requirement.resolved_asset_id
      ? store.data.assets.find((candidate) =>
        candidate.id === requirement.resolved_asset_id
      )
      : null;
    const anchor = requirementAnchorLabel(store.data, requirement);
    const mediaRequirement = MEDIA_REQUIREMENT_TYPES.includes(requirement.type);
    if (editing) {
      return `<div class="requirement-item editing" data-requirement-id="${
        requirement.id
      }"><label class="field-label">备注<input class="select" data-requirement-note data-id="${
        requirement.id
      }" value="${esc(requirement.note)}" /></label><label class="field-label">类型<select class="select" data-requirement-type data-id="${
        requirement.id
      }">${
        REQUIREMENT_TYPES.map((type) =>
          `<option value="${type}" ${
            requirement.type === type ? "selected" : ""
          }>${requirementTypeLabel(type)}</option>`
        ).join("")
      }</select></label><label class="field-label">优先级<select class="select" data-requirement-priority data-id="${
        requirement.id
      }">${
        [["low", "低"], ["normal", "普通"], ["high", "重要"]].map((
          [key, label],
        ) =>
          `<option value="${key}" ${
            requirement.priority === key ? "selected" : ""
          }>${label}</option>`
        ).join("")
      }</select></label><div class="modal-actions"><button class="secondary" data-action="cancel-requirement-edit">取消</button><button class="primary" data-action="save-requirement" data-id="${
        requirement.id
      }">保存</button></div></div>`;
    }
    const openActions = mediaRequirement
      ? `<button class="secondary" data-action="pick-asset-for-requirement" data-id="${requirement.id}">选择素材</button><button class="secondary" data-action="pick-asset-for-requirement" data-id="${requirement.id}">用素材完成</button>${
        block
          ? `<button class="text-button" data-action="focus-requirement" data-id="${requirement.id}">定位</button>`
          : ""
      }`
      : `${
        block
          ? `<button class="text-button" data-action="focus-requirement" data-id="${requirement.id}">定位</button>`
          : ""
      }<button class="text-button" data-action="edit-requirement" data-id="${requirement.id}">改备注</button><button class="secondary" data-action="resolve-requirement" data-id="${requirement.id}">完成</button>`;
    return `<div class="requirement-item ${
      requirement.status === "open" ? "open" : "resolved"
    }" data-requirement-id="${requirement.id}"><span class="req-dot ${
      requirement.status === "open" ? "open" : "done"
    }">${requirement.status === "open" ? "!" : "✓"}</span><div class="requirement-body"><b>${
      esc(requirementTypeLabel(requirement.type))
    }${requirement.priority === "high" ? " · 重要" : ""}${
      requirement.scope === "layout" ? " · 排版" : ""
    }</b><span>${esc(requirement.note || "没有备注")}</span><small class="muted">位置：${
      esc(anchor)
    }${
      asset
        ? ` · 已关联素材：${esc(asset.title || asset.filename)}`
        : ""
    }</small><div class="requirement-actions">${
      requirement.status === "open"
        ? openActions
        : `<button class="secondary" data-action="reopen-requirement" data-id="${
          requirement.id
        }">重新打开</button><button class="text-button" data-action="edit-requirement" data-id="${
          requirement.id
        }">改备注</button>${
          block
            ? `<button class="text-button" data-action="focus-requirement" data-id="${requirement.id}">定位</button>`
            : ""
        }`
    }<button class="text-button danger" data-action="delete-requirement" data-id="${
      requirement.id
    }">删除</button></div></div></div>`;
  }

  /**
   * Which six-dimensional status a select edits, and on which lesson.  The
   * dimension name comes from the project's own `status_dimensions` row
   * (through the authoring projection), never from a guess in the view.
   */
  function dimensionLabel(status) {
    return status.label || status.name || status.key || "";
  }

  function statusPanel(view) {
    if (!view) return `<div class="side-empty">还没有选中课程。先在左侧选择一课，就可以继续。</div>`;
    return `<div class="side-head"><div><span class="eyebrow">正在修改</span><h2>制作状态</h2><p class="side-note">作用对象：<b>${
      esc(view.lesson.code)
    }｜${esc(view.lesson.title)}</b>。下面每行是一个状态维度。</p></div></div><label class="field-label">课程标题<input class="select" data-lesson-title value="${
      esc(view.lesson.title)
    }" /></label><div class="status-list">${
      view.progress.statuses.map((status) =>
        `<label class="status-row" title="状态维度：${
          esc(dimensionLabel(status))
        }"><span>${esc(dimensionLabel(status))}${
          status.terminal ? " ✓" : ""
        }</span><select data-status-dim="${status.key}" aria-label="${
          esc(dimensionLabel(status))
        }状态">${
          store.statusOptions(status.key).map((option) =>
            `<option ${
              option === status.option ? "selected" : ""
            }>${esc(option)}</option>`
          ).join("")
        }</select></label>`
      ).join("")
    }</div><p class="side-note">状态和完整度是两件事：正文可以已定稿，同时仍有图片待补。</p>`;
  }

  /* ------------------------------------------------------- AI workflow */

  const AI_SCOPE_LABELS = { course: "课程", lesson: "当前课次", block: "当前区块" };
  const AI_STATUS_LABELS = {
    idle: "尚未运行",
    assembling: "正在整理上下文",
    running: "正在请求模型",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  const AI_EXECUTION_STATUS_LABELS = { succeeded: "成功", failed: "失败", cancelled: "已取消" };
  const AI_EXECUTION_OUTCOME_LABELS = {
    answer: "只生成回答",
    suggestion: "已存为建议",
    change_draft: "已生成修改草稿",
    none: "没有产出",
  };
  const AI_REVIEW_LABELS = { pending: "待审核", rejected: "已拒绝", applied: "已应用", apply_failed: "应用失败" };
  const AI_DRAFT_STATUS_LABELS = { reviewing: "待审核", applied: "已应用", discarded: "已拒绝" };
  const AI_OPERATION_LABELS = {
    replace_block: "替换正文",
    insert_block: "新增区块",
    create_requirement: "新增待补",
    move_block: "调整顺序",
  };
  const AI_INCLUDE_KEYS = [
    ["requirements", "待补要求"],
    ["assets", "素材信息"],
    ["completion", "完成度与状态"],
    ["nearby", "相邻内容"],
  ];

  /**
   * Providers the panel can offer: the shipped catalog merged with whatever
   * `ai.connection.list` returned.  A saved config only overrides the fields it
   * actually carries, so an unknown provider id still gets readable defaults.
   */
  function aiProviderChoices() {
    const merged = new Map();
    for (const preset of aiProviderDescriptors()) merged.set(preset.id, { ...preset });
    const saved = Array.isArray(store.ui.aiProviders) ? store.ui.aiProviders : [];
    for (const entry of saved) {
      const id = String(entry && entry.id ? entry.id : "").trim();
      if (!id) continue;
      const previous = merged.get(id) || {
        id,
        label: id,
        kind: "openai_compatible",
        base_url: "",
        default_model: "",
        models: [],
        requires_credential: true,
      };
      const models = [...new Set([
        ...(Array.isArray(entry.models) ? entry.models.filter((model) => typeof model === "string" && model) : []),
        ...(Array.isArray(previous.models) ? previous.models : []),
      ])];
      merged.set(id, {
        ...previous,
        label: typeof entry.label === "string" && entry.label ? entry.label : previous.label,
        base_url: typeof entry.base_url === "string" && entry.base_url ? entry.base_url : previous.base_url,
        default_model: typeof entry.default_model === "string" && entry.default_model
          ? entry.default_model
          : previous.default_model,
        models,
      });
    }
    // A provider id that is no longer in the saved list still has to show up,
    // otherwise the select would silently display a provider the store is not
    // actually using.
    const currentId = String(store.ui.aiProviderId || "").trim();
    if (currentId && !merged.has(currentId)) {
      merged.set(currentId, {
        id: currentId,
        label: `${currentId}（本机已无此配置）`,
        kind: "openai_compatible",
        base_url: "",
        default_model: "",
        models: [],
        requires_credential: true,
      });
    }
    // The offline connector is the default and the only provider that works
    // without a credential, so it always heads the list.
    return [...merged.values()].sort((left, right) =>
      left.id === "fake" ? -1 : right.id === "fake" ? 1 : 0
    );
  }

  function aiConfiguredMap() {
    return store.ui.aiConfigured && typeof store.ui.aiConfigured === "object"
      ? store.ui.aiConfigured
      : {};
  }

  function aiIncludeToggles() {
    const include = store.ui.aiInclude && typeof store.ui.aiInclude === "object"
      ? store.ui.aiInclude
      : {};
    return `<div class="ai-include-row">${
      AI_INCLUDE_KEYS.map(([key, label]) => {
        const on = include[key] !== false;
        return `<button class="ai-toggle" data-action="ai-toggle-context" data-key="${key}" aria-pressed="${on}">${
          on ? "✓ " : "○ "
        }${label}</button>`;
      }).join("")
    }</div>`;
  }

  function aiContextPreview() {
    if (!store.ui.aiContextOpen || !store.ui.aiContext) return "";
    const context = store.ui.aiContext;
    const lines = aiContextPreviewLines(context);
    const excluded = Array.isArray(context.excluded) ? context.excluded : [];
    return `<div class="ai-context">
      <p class="ai-context-total">本次共发送 <b>${lines.length}</b> 项、<b>${
      Number(context.payload_chars) || 0
    }</b> 字。范围：${esc(context.scope ? context.scope.label : "未指定")}</p>
      ${
      lines.length
        ? `<ul class="ai-context-list">${
          lines.map((line) =>
            `<li><b>${esc(line.label)}</b><small>${esc(line.source_type)} · ${
              Number(line.chars) || 0
            } 字</small></li>`
          ).join("")
        }</ul>`
        : `<p class="ai-hint">按当前勾选，这次不会发送任何课程内容。请选择至少一项内容后再预览或运行。</p>`
    }
      <div class="ai-excluded"><b>不会发送</b>${
      excluded.length
        ? `<ul>${
          excluded.map((entry) =>
            `<li>${esc(entry.source_type)}｜${esc(entry.reason)}${
              entry.source_id ? `（${esc(entry.source_id)}）` : ""
            }</li>`
          ).join("")
        }</ul>`
        : `<p class="ai-hint">没有需要排除的内容。</p>`
    }</div>
    </div>`;
  }

  function aiConnectionManagerView(choices, configured) {
    const savedIds = new Set(
      (Array.isArray(store.ui.aiProviders) ? store.ui.aiProviders : [])
        .map((provider) => String(provider?.id || "").trim())
        .filter(Boolean),
    );
    const connections = choices.filter((choice) => choice.id !== "fake");
    return `<section class="ai-connection-manager" id="ai-connection-manager">
      <div class="ai-block-head"><div><b>连接与模型</b><small>API Key 只显示是否已保存，不会回显。</small></div><button class="secondary" data-action="ai-create-connection">新建连接</button></div>
      <div class="ai-connection-list">${connections.length
        ? connections.map((choice) => {
          const id = String(choice.id || "");
          const active = id === String(store.ui.aiProviderId || "");
          const configuredKey = configured[id] === true;
          const saved = savedIds.has(id);
          const model = String(choice.default_model || choice.models?.[0] || "未设置模型");
          return `<article class="ai-connection-row${active ? " active" : ""}">
            <div class="ai-connection-info"><b>${esc(choice.label || id)}</b><span class="ai-key-state ${configuredKey ? "set" : "unset"}">${configuredKey ? "已保存 API Key" : "未保存 API Key"}</span>
              <small>${esc(id)} · ${esc(choice.base_url || "尚未设置 Base URL")}</small><small>默认模型：${esc(model)}</small>
            </div>
            <div class="ai-connection-actions"><button class="text-button" data-action="ai-use-provider" data-id="${esc(id)}" ${active ? "disabled" : ""}>${active ? "当前连接" : "使用"}</button><button class="text-button" data-action="ai-edit-connection" data-id="${esc(id)}">管理</button>${saved ? `<button class="text-button danger" data-action="ai-delete-connection" data-id="${esc(id)}">删除</button>` : ""}</div>
          </article>`;
        }).join("")
        : `<p class="ai-hint">还没有可管理的连接。</p>`}</div>
    </section>`;
  }

  /**
   * Provider/base-url/model form.  It never renders a credential value: the
   * key field is a masked, unbound `<input type="password">` whose text lives
   * only in the DOM until 保存密钥 reads it.
   *
   * Every field carries a `data-focus-key` so a render that lands mid-typing
   * can put the caret (and the typed text) back where it was.
   */
  function aiProviderFormView(descriptor, configured) {
    const form = store.ui.aiProviderForm;
    if (!form) return "";
    const providerId = String(form.id || descriptor.id || "").trim();
    const isFake = providerId === "fake";
    const discovered = Array.isArray(store.ui.aiModelOptions)
      ? store.ui.aiModelOptions
      : [];
    const chosen = String(store.ui.aiChosenModel || form.default_model || "");
    const manual = String(store.ui.aiManualModel || "");
    const busy = store.ui.aiModelsBusy === true;
    const failure = String(store.ui.aiModelsError || "");
    const source = String(store.ui.aiModelSource || "");
    return `<div class="ai-provider-form">
      <label class="field-label">显示名称<input class="select" data-ai-provider-label data-focus-key="ai-provider-label" value="${
      esc(form.label || descriptor.label || "")
    }" /></label>
      <label class="field-label">Base URL<input class="select" data-ai-base-url data-focus-key="ai-base-url" placeholder="https://api.example.com/v1" value="${
      esc(form.base_url || "")
    }" ${isFake ? "disabled" : ""} /></label>
      ${
      isFake
        ? `<p class="ai-hint">「本地确定性连接器」完全离线、不需要地址或密钥，因此没有可保存的配置。</p>
      <div class="ai-run-row"><button class="secondary" data-action="ai-edit-provider" data-id="custom">改为配置真实服务商</button></div>`
        : `<p class="ai-hint">这里保存的是地址与模型名，不是密钥；密钥用下面的「保存密钥」单独写入。</p>
      <div class="ai-run-row">
        <button class="secondary" data-action="ai-discover-models" data-focus-key="ai-discover" ${
          busy ? "disabled" : ""
        }>${busy ? "正在读取模型…" : "读取模型"}</button>
        <span class="ai-model-source">${
          source === "remote"
            ? `已从服务商读取到 ${discovered.length} 个模型`
            : source === "manual"
            ? "改为手动填写 Model ID"
            : "还没有读取过模型"
        }</span>
      </div>
      ${
          failure
            ? `<p class="ai-hint warning" data-ai-models-error>读取模型失败：${
              esc(failure)
            }。可以直接在下面手动填写 Model ID，不影响保存。</p>`
            : ""
        }
      ${
          discovered.length
            ? `<div class="ai-model-list" data-ai-model-list>${
              discovered.map((id) =>
                `<button class="ai-model-chip${
                  chosen === id && !manual ? " active" : ""
                }" data-action="ai-pick-model" data-id="${
                  esc(id)
                }" aria-pressed="${chosen === id && !manual}">${esc(id)}</button>`
              ).join("")
            }</div>`
            : ""
        }
      <label class="field-label">手动输入 Model ID（读取失败或需要未列出的模型时使用）<input class="select" data-ai-model-manual data-focus-key="ai-model-manual" placeholder="例如 deepseek-chat" value="${
          esc(manual || (discovered.length ? "" : chosen))
        }" /></label>
      <p class="ai-hint">将要使用的模型：<b data-ai-model-preview>${
          esc(manual || chosen || "（还没有选择）")
        }</b><span data-ai-model-preview-note>${
          manual ? "（手动填写）" : discovered.length ? "（来自读取结果）" : ""
        }</span></p>`
    }
      <div class="ai-run-row">
        <button class="primary" data-action="ai-save-provider" ${
      isFake ? "disabled" : ""
    }>保存配置</button>
        <button class="secondary" data-action="ai-cancel-provider">取消</button>
      </div>
      <p class="ai-hint">当前状态：${
      isFake
        ? "不需要密钥（离线连接器）。"
        : configured[providerId]
        ? "已配置密钥。"
        : "未配置密钥；运行时会以「缺少密钥」提示，不会伪造回答。"
    }</p>
      ${
      isFake ? "" : `<div class="ai-run-row">
        <input class="select" type="password" data-ai-secret data-provider-id="${esc(providerId)}" data-focus-key="ai-secret" autocomplete="off" placeholder="${configured[providerId] ? "粘贴新 API Key 以替换本机密钥" : "粘贴 API Key（不会回显）"}" />
        <button class="secondary" data-action="ai-save-secret" data-provider-id="${esc(providerId)}">保存密钥</button>
      </div>
      <div class="ai-run-row"><button class="text-button danger" data-action="ai-delete-secret" data-provider-id="${esc(providerId)}" ${
        configured[providerId] ? "" : "disabled"
      }>删除本机保存的密钥</button></div>`
    }
    </div>`;
  }

  function aiResultView() {
    const result = store.ui.aiResult;
    if (!result || !result.answer) return "";
    const pendingDraft = result.change_draft_id && store.ui.aiDraftId !== result.change_draft_id
      ? String(result.change_draft_id)
      : "";
    return `<div class="ai-block">
      <div class="ai-block-head"><b>AI 回答</b><button class="icon-button" data-action="ai-close-result" title="收起回答">×</button></div>
      <pre class="ai-answer">${esc(result.answer)}</pre>
      ${
      pendingDraft
        ? `<button class="primary full" data-action="ai-open-draft" data-id="${esc(pendingDraft)}">打开修改对照</button>`
        : ""
    }
      <p class="ai-hint">${
      result.change_draft_id
        ? "这次回答带有可审核的修改，下面会显示修改前后；确认前课程内容不会改变。"
        : result.suggestion_id
        ? "这次回答已保存为建议，正文没有改动。"
        : "这次没有生成可保存的建议；你仍可继续编辑。"
    }</p>
    </div>`;
  }

  function aiDraftView() {
    const draftId = store.ui.aiDraftId;
    if (!draftId) return "";
    const draft = (store.data.change_drafts || []).find((candidate) => candidate.id === draftId) || null;
    if (!draft) return "";
    let rows = [];
    try {
      rows = aiChangeDraftDiffRows(store.data, draftId);
    } catch {
      rows = [];
    }
    const operations = Array.isArray(draft.operations) ? draft.operations : [];
    const validation = draft.validation || null;
    const reviewing = draft.status === "reviewing";
    return `<div class="ai-block ai-diff">
      <div class="ai-block-head"><b>修改草稿 · 修改对照</b><span class="badge ${
      draft.status === "applied" ? "done" : draft.status === "discarded" ? "warning" : "open"
    }">${esc(AI_DRAFT_STATUS_LABELS[draft.status] || draft.status)}</span></div>
      <p class="ai-hint">下面列出修改前后内容。逐条看过后再决定；应用后可以用“撤销”回到应用前。</p>
      ${
      rows.map((row, index) => {
        const reason = operations[index] ? String(operations[index].reason || "") : "";
        const lines = (list) =>
          list.length
            ? `<pre class="ai-diff-lines">${
              list.map((line, position) => `${position + 1}. ${esc(line)}`).join("\n")
            }</pre>`
            : `<p class="ai-diff-empty">（无）</p>`;
        return `<article class="ai-diff-row">
          <header><b>${esc(row.label)}</b><span class="badge">${
          esc(AI_OPERATION_LABELS[row.op] || row.op)
        }</span></header>
          <p class="ai-diff-reason">理由：${esc(reason || "模型没有说明理由")}</p>
          <div class="ai-diff-sides">
            <div class="ai-diff-side before"><span class="eyebrow">修改前</span>${
          lines(row.before_lines)
        }</div>
            <div class="ai-diff-side after"><span class="eyebrow">修改后</span>${
          lines(row.after_lines)
        }</div>
          </div>
        </article>`;
      }).join("")
    }
      ${
      validation && validation.ok === false && Array.isArray(validation.issues) && validation.issues.length
        ? `<div class="ai-error"><b>上次校验未通过</b>${
          validation.issues.map((issue) => `<p>${esc(issue)}</p>`).join("")
        }</div>`
        : ""
    }
      <div class="ai-diff-actions">
        <button class="primary" data-action="ai-apply-draft" ${
      reviewing ? "" : "disabled"
    }>应用这些修改</button>
        <button class="secondary" data-action="ai-reject-draft" ${
      reviewing ? "" : "disabled"
    }>拒绝</button>
        <button class="text-button" data-action="ai-dismiss-draft">关闭修改对照</button>
      </div>
    </div>`;
  }

  function aiExecutionsView() {
    const records = Array.isArray(store.ui.aiExecutions) ? store.ui.aiExecutions : [];
    const open = store.ui.aiExecutionsOpen === true;
    const row = (record) => {
      const created = record.created_at ? new Date(record.created_at) : null;
      const when = created && !Number.isNaN(created.getTime())
        ? created.toLocaleString("zh-CN")
        : "时间未知";
      const scope = record.scope || {};
      const provider = record.provider || {};
      const review = record.review || {};
      const providerText = [provider.label || provider.provider_id, provider.model]
        .filter(Boolean).join(" · ") || "未记录服务商";
      const draftId = record.change_draft_id &&
          (store.data.change_drafts || []).some((draft) =>
            draft.id === record.change_draft_id
          )
        ? String(record.change_draft_id)
        : "";
      return `<article class="ai-execution">
        <div class="ai-execution-head"><b>${esc(when)}</b><span class="badge ${
        record.status === "succeeded" ? "done" : record.status === "failed" ? "warning" : "open"
      }">${esc(AI_EXECUTION_STATUS_LABELS[record.status] || record.status || "未知状态")}</span></div>
        <dl><dt>范围</dt><dd>${esc(scope.label || scope.kind || "未记录范围")}</dd>
        <dt>服务商</dt><dd>${esc(providerText)}</dd>
        <dt>结果</dt><dd>${esc(AI_EXECUTION_OUTCOME_LABELS[record.outcome] || record.outcome || "未记录")}${
        review.state ? ` · 审核：${esc(AI_REVIEW_LABELS[review.state] || review.state)}` : ""
      }</dd>${
        record.error_code
          ? `<dt>状态</dt><dd>这次执行没有完成${
            record.error_message ? `：${esc(record.error_message)}` : "，可以检查设置后再试"
          }</dd>`
          : ""
      }</dl>
        ${
        draftId
          ? `<button class="text-button" data-action="ai-open-draft" data-id="${esc(draftId)}">打开这次修改对照</button>`
          : ""
      }
      </article>`;
    };
    return `<div class="ai-block ai-executions">
      <div class="ai-block-head">
        <button class="text-button" data-action="ai-toggle-executions" aria-expanded="${open}">执行记录（${records.length}）${
      open ? " ▾" : " ▸"
    }</button>
        <button class="icon-button" data-action="ai-refresh-executions" title="重新读取执行记录">↻</button>
      </div>
      ${
      open
        ? records.length
          ? `<div class="ai-execution-list">${records.map(row).join("")}</div>`
          : `<p class="side-note">还没有这门课程的执行记录。运行一次 AI 后，这里会显示时间、范围、服务商和结果；这些记录不属于课程内容。</p>`
        : ""
    }
    </div>`;
  }

  function assistantPanel() {
    const item = store.currentItem();
    const lessons = courseMap(store.data, store.ui.activeId).lessons;
    // The lesson read model is what carries the human label for a block, so the
    // panel names its target exactly like the editor does.
    const lesson = item ? lessonView(store.data, item.id) : null;
    const lessonBlocks = lesson ? lesson.blocks : [];
    const selected = lessonBlocks.find((block) => block.id === store.ui.selectedBlockId) || null;
    const bound = lessonBlocks.find((block) => block.id === store.ui.aiBlockId) || null;
    const targetBlock = selected || bound;
    const choices = aiProviderChoices();
    const configured = aiConfiguredMap();
    const currentProviderId = String(store.ui.aiProviderId || "").trim();
    const descriptor = choices.find((choice) => choice.id === currentProviderId) ||
      choices.find((choice) => choice.id === "fake") || choices[0] || null;
    const providerId = currentProviderId || (descriptor ? descriptor.id : "");
    const models = descriptor && Array.isArray(descriptor.models) ? descriptor.models : [];
    const model = store.ui.aiModel || (descriptor ? descriptor.default_model : "") || models[0] || "";
    const status = String(store.ui.aiStatus || "idle");
    const error = store.ui.aiError;
    const errorCode = String(error?.code || "");
    const errorTitle = errorCode === "authentication_failed"
      ? "服务商认证失败（401）"
      : errorCode === "missing_credential"
      ? "本机尚未保存 API Key"
      : "这次 AI 没有完成";
    const errorHint = errorCode === "authentication_failed"
      ? "本机已取到这条连接的凭据，但服务商拒绝了认证。请检查 Base URL、认证头和方案，确认后再更新密钥。"
      : errorCode === "missing_credential"
      ? "本机没有这条连接的凭据。请在连接管理中单独保存 API Key。"
      : "课程内容没有改动，你可以检查设置后重试。";
    const running = status === "running";
    const form = store.ui.aiProviderForm;
    const formDescriptor = form
      ? choices.find((choice) => choice.id === form.id) || store.aiDescriptor(form.id)
      : descriptor;

    // Block scope is only offered when the editor has a block to point at;
    // when both exist the live selection wins, and `aiBlockId` is the fallback
    // remembered across a cleared selection.
    const blockUsable = Boolean(targetBlock);
    // Course scope really does send every lesson's body (app/ai.js pushes one
    // `document` item per lesson), so the summary has to say that instead of
    // claiming the opposite.
    const scopeHint = lessons.length === 0
      ? "这门课程还没有课次：先建一课，AI 才能读到上下文。"
      : store.ui.aiScope === "block" && !blockUsable
      ? "先在正文或结构里点选一个区块，才能使用「当前区块」范围。"
      : store.ui.aiScope === "block" && targetBlock
      ? `区块范围只发送本课结构摘要与这一段的全文：${esc(targetBlock.label)}。`
      : store.ui.aiScope === "course"
      ? "课程范围会发送整门课程：课程地图、各课结构摘要与各课正文全文。只想改一段时请切换到「当前区块」，或关掉不需要的类别后先预览。"
      : "课级范围只发送当前课的结构、正文与待补、素材元数据，不发送其他课次的正文。";
    const capabilities = store.aiCapabilities ? store.aiCapabilities() : null;
    const noExtraCapabilities = capabilities &&
      (capabilities.tools || []).length === 0 &&
      (capabilities.mcp || []).length === 0 &&
      (capabilities.skills || []).length === 0;
    const capabilityLine = noExtraCapabilities
      ? "本次只调用所选服务商的对话接口：不会调用任何 Tool、MCP 或 Skill。"
      : capabilities
      ? `本次会调用：Tool ${(capabilities.tools || []).length} 个、MCP ${(capabilities.mcp || []).length} 个、Skill ${(capabilities.skills || []).length} 个。`
      : "";

    return `<div class="side-head"><div><span class="eyebrow">本地优先 · 只生成可审核建议</span><h2>AI 助手</h2></div><button class="icon-button" data-action="ai-refresh-executions" title="重新读取执行记录">↻</button></div>

    <div class="ai-block">
      <span class="field-label">上下文范围</span>
      <div class="ai-scope-row">${
      ["course", "lesson", "block"].map((scope) => {
        const disabled = scope === "course"
          ? lessons.length === 0
          : scope === "lesson"
          ? !item
          : !blockUsable;
        return `<button class="ai-scope" data-action="ai-scope" data-scope="${scope}" aria-pressed="${
          store.ui.aiScope === scope
        }" ${disabled ? "disabled" : ""}>${AI_SCOPE_LABELS[scope]}</button>`;
      }).join("")
    }</div>
      <p class="ai-hint">${scopeHint}</p>
    </div>

    <div class="ai-block">
      <div class="ai-block-head"><b>将发送的上下文</b><button class="text-button" data-action="ai-preview-context">${
      store.ui.aiContextOpen && store.ui.aiContext ? "重新预览" : "预览"
    }</button></div>
      ${aiIncludeToggles()}
      ${aiContextPreview()}
    </div>

    <div class="ai-block">
      <label class="field-label">服务商<select class="select" data-ai-provider>${
      choices.map((choice) =>
        `<option value="${esc(choice.id)}" ${
          choice.id === providerId ? "selected" : ""
        }>${esc(choice.label || choice.id)}${
          choice.requires_credential === false ? "（离线，无需密钥）" : ""
        }</option>`
      ).join("")
    }</select></label>
      <label class="field-label">模型<select class="select" data-ai-model>${
      models.length
        ? models.map((candidate) =>
          `<option value="${esc(candidate)}" ${
            candidate === model ? "selected" : ""
          }>${esc(candidate)}</option>`
        ).join("")
        : `<option value="">${esc(model || "还没有可用模型，请先在设置中添加")}</option>`
    }</select></label>
      <div class="ai-provider-state">
        <span class="ai-key-state ${
      !descriptor || descriptor.requires_credential === false
        ? "set"
        : configured[providerId]
        ? "set"
        : "unset"
    }">${
      !descriptor || descriptor.requires_credential === false
        ? "无需密钥"
        : configured[providerId]
        ? "已配置密钥"
        : "未配置密钥"
    }</span>
        <button class="text-button" data-action="ai-toggle-settings" aria-expanded="${store.ui.aiSettingsOpen === true}" aria-controls="ai-connection-manager">${
      store.ui.aiSettingsOpen ? "收起连接管理" : "管理连接与模型"
    }</button>
      </div>
      ${store.ui.aiSettingsOpen ? `${aiConnectionManagerView(choices, configured)}${formDescriptor ? aiProviderFormView(formDescriptor, configured) : ""}` : ""}
      <p class="side-note" data-ai-storage="${
      store.bridge.isNative() ? "native" : "browser"
    }">API Key 只由本机服务写入${
      store.aiStorageLabel ? store.aiStorageLabel() : "macOS 系统钥匙串"
    }，不回显，也不会进入课程、备份、日志、导出或执行记录。项目文件只保留服务商元数据；密钥不会写入项目文件。</p>
    </div>

    <div class="ai-block">
      <label class="field-label">指令<textarea class="select ai-instruction" rows="3" data-ai-instruction value="${
      esc(store.ui.aiInstruction)
    }">${esc(store.ui.aiInstruction)}</textarea></label>
      <button class="ai-toggle" data-action="ai-toggle-changes" aria-pressed="${
      store.ui.aiWantsChanges === true
    }">${store.ui.aiWantsChanges === true ? "✓" : "○"} 要求修改课程内容</button>
      <p class="ai-hint">${
      store.ui.aiWantsChanges === true
        ? "会要求模型给出可审核的修改；仍然只会生成修改对照，确认后才写入正文。"
        : "默认只让模型解释、提问或给建议，不要求它改正文。"
    }</p>
      <div class="ai-run-row">
        <button class="primary" data-action="ai-run" ${running ? "disabled" : ""}>${
      running ? "正在运行…" : "运行 AI"
    }</button>
        <button class="secondary" data-action="ai-cancel" ${
      running ? "" : "disabled"
    }>取消</button>
      </div>
      <p class="ai-hint" data-ai-capabilities="true">${esc(capabilityLine)}</p>
      ${
      running
        ? `<p class="ai-hint">请求已经发出。取消只会通知本机服务停止这次请求；在它结束前界面不会改动课程内容。</p>`
        : ""
    }
    </div>

    <div class="ai-block">
      <div class="ai-block-head"><b>状态</b><span class="badge ${
      status === "failed"
        ? "warning"
        : status === "done"
        ? "done"
        : status === "running" || status === "assembling"
        ? "open"
        : ""
    }">${esc(AI_STATUS_LABELS[status] || status)}</span></div>
      ${
      error
        ? `<div class="ai-error"><b>${esc(errorTitle)}</b><p>${
          esc(error.message || "这次请求没有成功。")
        }</p><p>${esc(errorHint)} 课程内容没有改动。</p>${
          error.recommended_action
            ? `<p class="muted">下一步：${esc(error.recommended_action)}</p>`
            : ""
        }</div>`
        : `<p class="ai-hint">${
          status === "idle"
            ? "还没有运行过。开始运行后，结果会显示在这里；课程内容不会自动改动。"
            : "当前没有错误，可以继续。"
        }</p>`
    }
    </div>

    ${aiResultView()}
    ${aiDraftView()}
    ${aiExecutionsView()}`;
  }

  function propertiesPanel(view) {
    const target = propertyTargetInfo();
    if (target.kind === "project") {
      const project = target.project;
      const activeStages = store.data.stages.filter((stage) => !stage.archived);
      const activeLessons = store.data.content_items.filter((lesson) => !lesson.archived);
      return `<div class="side-head"><div><span class="eyebrow">当前选择</span><h2>${esc(project.title || "课程项目")}</h2></div></div><dl class="properties"><dt>对象</dt><dd>课程项目</dd><dt>阶段</dt><dd>${activeStages.length}</dd><dt>课程内容</dt><dd>${activeLessons.length}</dd></dl><p class="side-note">选择一个课时或正文区块后，可以查看它的详细属性。</p>`;
    }
    if (target.kind === "stage") {
      const stage = target.stage;
      const lessons = store.data.content_items.filter((lesson) =>
        !lesson.archived && lesson.stage_id === stage.id
      );
      return `<div class="side-head"><div><span class="eyebrow">当前阶段</span><h2>${esc(stage.code)}｜${esc(stage.title)}</h2></div></div><dl class="properties"><dt>对象</dt><dd>阶段</dd><dt>编号</dt><dd>${esc(stage.code)}</dd><dt>标题</dt><dd>${esc(stage.title)}</dd><dt>课程内容</dt><dd>${lessons.length}</dd></dl><p class="side-note">在课程地图中可以重命名阶段，或把课时拖入此阶段。</p>`;
    }
    if (!view) return "";
    const lesson = view.lesson;
    const item = store.currentItem();
    const stage = store.data.stages.find((candidate) =>
      candidate.id === item?.stage_id
    );
    const selected = store.ui.selectedBlockId
      ? view.blocks.find((block) => block.id === store.ui.selectedBlockId)
      : null;
    const requirement = selected && selected.requirement_id
      ? view.requirements.find((candidate) =>
        candidate.id === selected.requirement_id
      ) || null
      : null;
    return `<div class="side-head"><div><span class="eyebrow">${selected ? "当前区块" : "当前课时"}</span><h2>${
      selected ? esc(selected.label) : `${esc(lesson.code)}｜${esc(lesson.title)}`
    }</h2>${selected ? `<p class="side-note">所属课时：<b>${esc(lesson.code)}｜${esc(lesson.title)}</b></p>` : ""}</div></div>${
      selected
        ? `<div class="properties-box"><label class="field-label">内容<input class="select" data-block-text data-block-id="${
          selected.id
        }" value="${esc(selected.text)}" /></label>${
          selected.type === "heading"
            ? `<label class="field-label">级别<select class="select" data-block-level data-block-id="${
              selected.id
            }">${
              [1, 2, 3, 4].map((level) =>
                `<option value="${level}" ${
                  selected.level === level ? "selected" : ""
                }>H${level}</option>`
              ).join("")
            }</select></label>`
            : `<label class="field-label">区块类型<select class="select" data-block-type data-block-id="${
              selected.id
            }">${
              BLOCK_PALETTE.filter(([type]) => type !== "media").map(([type, label]) =>
                `<option value="${type}" ${
                  selected.type === type ? "selected" : ""
                }>${label}</option>`
              ).join("")
            }</select></label>`
        }<dl class="properties"><dt>类型</dt><dd>${
          esc(selected.label)
        }</dd><dt>素材</dt><dd>${
          selected.asset
            ? esc(selected.asset.filename)
            : selected.media
            ? "缺失，请到媒体库重新选择"
            : "—"
        }</dd><dt>待补</dt><dd>${
          selected.requirement_id ? "有" : "无"
        }</dd></dl>${
          selected.requirement_id && requirement
            ? `<div class="properties-box properties-requirement"><span class="eyebrow">这块内容对应的待补</span><label class="field-label">待补类型<select class="select" data-block-requirement-type data-block-id="${
              selected.id
            }" data-id="${
              selected.requirement_id
            }" data-focus-key="block-requirement-type" title="和「待补」面板、课程地图、待补总览使用同一个类型">${
              REQUIREMENT_TYPES.map((type) =>
                `<option value="${type}" ${
                  requirement.type === type ? "selected" : ""
                }>${requirementTypeLabel(type)}</option>`
              ).join("")
            }</select></label><label class="field-label">待补备注<input class="select" data-requirement-note data-id="${
              selected.requirement_id
            }" value="${esc(requirement.note)}" /></label></div>`
            : ""
        }<div class="modal-actions"><button class="secondary" data-action="delete-block" data-id="${
          selected.id
        }">删除这一块</button><button class="text-button" data-action="clear-block-selection">取消选择</button></div></div>`
        : `<dl class="properties"><dt>编号</dt><dd>${
          esc(lesson.code)
        }</dd><dt>标题</dt><dd>${esc(lesson.title)}</dd><dt>类型</dt><dd>${
          esc(lesson.type)
        }</dd><dt>所属阶段</dt><dd>${
          esc(stage ? stage.title : "未分组")
        }</dd><dt>正文块</dt><dd>${lesson.block_count}</dd><dt>素材</dt><dd>${
          lesson.media_count
        }</dd><dt>当前排版</dt><dd>${
          esc(lesson.layout ? lesson.layout.name : "未设置")
        }</dd><dt>待补</dt><dd>${
          lesson.gaps.total ? `${lesson.gaps.total} 项` : "无"
        }</dd><dt>缺素材</dt><dd>${
          lesson.progress.missing_media || 0
        } 项</dd></dl><p class="side-note">点选一个正文区块后可以在这里改类型和内容。</p>`
    }`;
  }

  function versionsPanel() {
    return `<div class="side-head"><div><span class="eyebrow">安全恢复</span><h2>版本历史</h2></div><button class="icon-button" data-action="save-version">＋</button></div><p class="side-note">恢复旧版本前会自动保留“恢复前备份”。</p>${
      store.data.snapshots.slice(0, 4).map((snapshot) =>
        `<button class="side-item" data-action="restore-version" data-id="${
          snapshot.id
        }"><span class="version-icon">◷</span><span><b>${
          esc(snapshot.name)
        }</b><small>${esc(snapshot.note || "查看版本")}</small></span></button>`
      ).join("")
    }`;
  }

  function statusbarView(item) {
    // The status bar renders before a lesson is selected (empty course, course
    // map, launcher), so it must never assume a current item.
    const view = item ? lessonView(store.data, item.id) : null;
    if (!item || !view) {
      return `<footer class="statusbar" data-chrome-statusbar><span class="status-code">未选择课程</span><span>课程地图可进入任意一课</span><span class="status-spacer"></span><span>本地优先 · 自动保存</span></footer>`;
    }
    const completion = view.progress;
    const gaps = view.lesson.gaps;
    const parts = [];
    if (gaps.by_type.text) parts.push(`文字：缺 ${gaps.by_type.text} 段`);
    if (gaps.by_type.image) parts.push(`图片：缺 ${gaps.by_type.image} 张`);
    if (gaps.by_type.gif) parts.push(`GIF：缺 ${gaps.by_type.gif} 个`);
    if (gaps.by_type.video) parts.push(`视频：缺 ${gaps.by_type.video} 个`);
    if (completion.missing_media) {
      parts.push(`素材缺失：${completion.missing_media}`);
    }
    return `<footer class="statusbar" data-chrome-statusbar><span class="status-code">${
      esc(item.code)
    }｜${esc(item.title)}</span><span>正文：${
      esc(view.lesson.content_status || "待研究")
    }</span><span>${parts.length ? esc(parts.join(" · ")) : "待补：已齐"}</span><span>排版：${
      esc(view.lesson.layout ? (view.lesson.layout.mode === "flow" ? "Flow" : "Grid") : "未开始")
    }</span><span>完成度：${
      completion.complete ? "已完成" : `${completion.percentage}%`
    }</span><span class="status-spacer"></span><span>本地优先 · 自动保存</span></footer>`;
  }

  /* ------------------------------------------------------------ overlays */

  function overlayView(esc) {
    if (store.externalConflict) {
      const conflict = store.externalConflict;
      const externalEntries = conflict.external_diff?.entries || [];
      const localEntries = conflict.local_diff?.entries || [];
      const mergeConflicts = conflict.merge?.conflicts || [];
      return `<div class="overlay"><div class="conflict-modal modal" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">保存已暂停</span><h2>课程文件在其他地方发生了变化</h2></div></div><p class="muted">为避免覆盖别人的修改，手动保存和自动保存都已暂停；磁盘版本没有改变。你可以继续查看，下一步请选择重新载入、自动合并，或在确认后保留本地版本。</p>${
        conflict.inspection_error
          ? `<p class="conflict-error">暂时无法读取磁盘差异。你仍可重新载入，或明确保留本地版本。</p><details class="diagnostic"><summary>显示技术信息</summary><code>${esc(conflict.inspection_error)}</code></details>`
          : ""
      }<div class="conflict-summary"><span>磁盘变化 <b>${
        externalEntries.length
      }</b></span><span>本地变化 <b>${
        localEntries.length
      }</b></span><span>合并冲突 <b>${
        mergeConflicts.length
      }</b></span></div><div class="conflict-list">${
        (mergeConflicts.length ? mergeConflicts : externalEntries).slice(0, 12)
          .map((entry) =>
            `<div><code>${
              esc(entry.path || "课程数据")
            }</code><small>${
              mergeConflicts.length ? "本地与外部都修改了此处" : "磁盘版本已变化"
            }</small></div>`
          ).join("") ||
        `<div><span>课程文件</span><small>文件内容或是否存在发生变化</small></div>`
      }</div><div class="modal-actions"><button class="secondary" data-action="external-reload">重新载入磁盘版本</button><button class="secondary" data-action="external-merge">预览并自动合并</button>${
        mergeConflicts.length
          ? `<button class="primary danger" data-action="external-keep-local">明确保留本地版本</button>`
          : ""
      }</div></div></div>`;
    }
    if (store.pendingRecovery) {
      const pending = store.pendingRecovery;
      const recoveredBlocks = pending.project?.blocks?.length || 0;
      const savedAt = pending.saved_at
        ? new Date(pending.saved_at).toLocaleString("zh-CN")
        : "未知时间";
      return `<div class="overlay"><div class="conflict-modal modal" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">恢复</span><h2>发现未完成的保存</h2></div></div><p class="muted">上次保存没有完成，磁盘版本没有改变。暂存内容来自 ${esc(savedAt)}，包含 ${recoveredBlocks} 个正文区块。请选择恢复暂存内容，或保留磁盘版本继续工作。</p><div class="modal-actions"><button class="secondary" data-action="recovery-discard">保留磁盘版本</button><button class="primary" data-action="recovery-restore">恢复暂存内容</button></div></div></div>`;
    }
    if (store.ui.assetImagePreviewId) {
      const asset = store.data.assets.find((candidate) =>
        candidate.id === store.ui.assetImagePreviewId
      );
      const preview = asset && !asset.archived && isImageLike(asset)
        ? assetPreview(asset)
        : null;
      const label = asset?.title || asset?.filename || "图片";
      const content = !asset || asset.archived || !isImageLike(asset)
        ? `<p class="preview-media-failed">图片素材当前不可用。</p>`
        : preview?.failed
        ? `<div class="preview-media-failed"><b>${esc(asset.filename)} · ${esc(assetLabel(asset.type))} 预览失败</b><p>${esc(preview.error || "素材不可读")}</p>${retryAssetPreviewButton(asset)}</div>`
        : preview?.loading
        ? `<div class="preview-placeholder" data-asset-preview-key="${esc(preview.key || "")}">正在读取 ${esc(label)}…</div>`
        : preview?.url
        ? `<img class="asset-image" src="${esc(preview.url)}" alt="${esc(label)}" style="display:block;margin:12px auto;max-height:72vh;max-width:100%;object-fit:contain" />`
        : `<p class="preview-media-failed">${esc(label)} 暂无可显示的预览。</p>`;
      return `<div class="overlay" data-action="close-overlay"><div class="image-preview-modal modal" role="dialog" aria-modal="true" aria-label="图片预览：${esc(label)}" data-stop-click="true" style="max-height:84vh;overflow:auto;padding:18px;width:min(92vw,1200px)"><div class="modal-head"><div><span class="eyebrow">图片预览</span><h2>${esc(label)}</h2></div><button type="button" class="icon-button" data-action="close-overlay" aria-label="关闭图片预览" title="关闭图片预览">×</button></div>${content}${preview?.width && preview?.height ? `<small class="muted" style="text-align:center">${preview.width} × ${preview.height}</small>` : ""}</div></div>`;
    }
    if (store.ui.assetPicker) {
      const target = store.ui.assetPicker;
      const assets = store.data.assets.filter((asset) => !asset.archived);
      const context = target.blockId
        ? "链接到指定的正文区块"
        : target.requirementId
        ? "用素材完成这条待补"
        : store.ui.selectedBlockId
        ? "插入到当前选中区块之后"
        : "追加到当前课末尾";
      return `<div class="overlay" data-action="close-overlay"><div class="asset-picker modal" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">MEDIA PICKER</span><h2>选择素材</h2></div><button class="icon-button" data-action="close-overlay" title="关闭素材选择">×</button></div><p class="muted">${context}。选择后会建立真实引用，可以在媒体库看到使用位置。</p>${
        assets.length
          ? `<div class="picker-grid">${
            assets.map((asset) =>
              `<button class="picker-card" data-action="choose-asset" data-id="${
                asset.id
              }"><span class="picker-thumb">${assetThumb(asset)}</span><b>${
                esc(asset.filename)
              }</b><small>${esc(assetLabel(asset.type))}</small></button>`
            ).join("")
          }</div>`
          : `<div class="side-empty">媒体库还没有素材。<button class="text-button" data-action="pick-asset-import">现在导入</button></div>`
      }</div></div>`;
    }
    if (store.ui.palette) {
      return `<div class="overlay" data-action="close-overlay"><div class="palette modal" data-stop-click="true"><div class="palette-input"><span>⌕</span><input autofocus data-palette-input data-focus-key="palette" placeholder="搜索课程、素材、命令……" /></div><div class="palette-results">${
        paletteResults("")
      }</div><div class="palette-hint"><kbd>↑↓</kbd> 选择 <kbd>↵</kbd> 打开 <kbd>Esc</kbd> 关闭</div></div></div>`;
    }
    if (store.ui.capture) {
      return `<div class="overlay" data-action="close-overlay"><div class="capture modal" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">QUICK CAPTURE</span><h2>快速收集</h2></div><button class="icon-button" data-action="close-overlay" title="关闭快速收集">×</button></div><textarea autofocus data-capture-input data-focus-key="capture" placeholder="写点什么，或粘贴网页链接……"></textarea><label class="field-label">放入<select class="select"><option>${
        esc(store.data.project.title)
      }</option></select></label><div class="modal-actions"><button class="secondary" data-action="close-overlay">取消</button><button class="primary" data-action="submit-capture">放入收件箱</button></div></div></div>`;
    }
    if (store.ui.preflight && store.ui.route !== "publish") {
      const report = store.ui.preflightReport || store.exportPreflight();
      const issues = Array.isArray(report.issues) ? report.issues : [];
      const formatNames = { markdown: "Markdown", html: "Semantic HTML", web: "Static Web Package", pdf: "PDF", pptx: "PowerPoint", wechat: "微信 / 富文本", json: "Project JSON", asset_package: "素材包", full_project: "完整项目包" };
      const warningIssues = issues.filter((issue) => issue.severity === "warning" && issue.code);
      const requiredCodes = new Set(warningIssues.map((issue) => issue.code));
      const acknowledged = new Set(store.ui.acknowledgedWarnings || []);
      const allWarningsAcknowledged = [...requiredCodes].every((code) => acknowledged.has(code)) && !(report.warnings > 0 && !requiredCodes.size);
      return `<div class="overlay" data-action="close-overlay"><div class="preflight modal" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">导出前检查</span><h2>导出前检查</h2></div><button class="icon-button" data-action="close-overlay" title="关闭导出前检查">×</button></div><p><b>${store.ui.publishScope === "course" ? "整门课程" : "当前课"}</b> → <b>${esc(formatNames[store.ui.publishFormat] || store.ui.publishFormat)}</b></p><p class="muted">先检查课程内容和素材。标为“必须修复”的问题会阻止导出；每项提示都需要你明确确认。检查不会修改课程，也不会调用 AI。</p><div class="check-list">${[
        ["内容级待补", report.content, false],
        ["当前排版待补", report.layout, false],
        ["缺失素材文件", report.missingAssets, true],
        ["超出画布", report.overflow, true],
        ["空正文 / 文字提醒", report.text, false],
        ["未加载字体", report.fonts, false],
        ["外部引用", report.external, false],
        ["媒体降级", report.mediaDowngrades || 0, false],
      ].map(([label, count, blocking]) => `<div><span class="check ${count ? blocking ? "danger" : "warning" : "ok"}">${count || "✓"}</span><span>${label}</span><b>${count}</b></div>`).join("")}</div>${issues.length ? `<div class="issue-list">${issues.map((issue) => `<article class="${issue.severity === "blocking" ? "issue-blocking" : "issue-warning"}"><b>${issue.severity === "blocking" ? "必须修复" : "提示"}</b><span>${esc(issueMessage(issue))}</span>${issueDiagnostics(issue)}</article>`).join("")}</div>` : ""}${warningIssues.length ? `<div class="warning-ack-list"><b>逐项确认本次输出提示</b>${warningIssues.map((issue) => `<label><input type="checkbox" data-action="acknowledge-export-warning" data-code="${esc(issue.code)}" ${acknowledged.has(issue.code) ? "checked" : ""}/><span>${esc(issueMessage(issue))}${issue.count > 1 ? `（${issue.count} 项）` : ""}</span></label>`).join("")}</div>` : ""}<div class="preflight-total">必须修复 <strong>${report.blocking}</strong> · 提示 <strong>${report.warnings}</strong></div>${report.blocking ? `<p class="error-text">当前不能导出：请先修复上面标为“必须修复”的问题。不会生成半成品，也不会修改源课程。</p>` : report.warnings ? `<p class="muted">仅在勾选确认全部提示后才会继续生成；未放置正文、线性化或媒体降级会按上方说明处理。</p>` : `<p class="success-text">检查通过，可以生成输出；源课程不会被修改。</p>`}<div class="modal-actions"><button class="secondary" data-action="close-overlay">返回继续修复</button><button class="primary" data-action="export-format" data-format="${esc(store.ui.publishFormat)}" ${report.blocking || !allWarningsAcknowledged ? "disabled" : ""}>${report.warnings ? "确认提示并导出" : "开始导出"}</button></div></div></div>`;
    }
    if (store.ui.snapshot) {
      return `<div class="overlay" data-action="close-overlay"><div class="capture modal" data-stop-click="true"><div class="modal-head"><div><span class="eyebrow">长期历史</span><h2>保存版本</h2></div><button class="icon-button" data-action="close-overlay" title="关闭保存版本">×</button></div><label class="field-label">版本名称<input data-snapshot-name data-focus-key="snapshot-name" placeholder="例如：第一课正文定稿" /></label><label class="field-label">备注<textarea data-snapshot-note data-focus-key="snapshot-note" placeholder="记录这个节点为什么重要"></textarea></label><div class="modal-actions"><button class="secondary" data-action="close-overlay">取消</button><button class="primary" data-action="submit-snapshot">保存版本</button></div></div></div>`;
    }
    return "";
  }

  function paletteResults(query) {
    const q = String(query).toLowerCase();
    const results = [];
    for (const lesson of courseMap(store.data, store.ui.activeId).lessons) {
      if (
        !q ||
        `${lesson.code}${lesson.title}`.toLowerCase().includes(q)
      ) {
        results.push({
          type: "课程",
          label: `${lesson.code}｜${lesson.title}`,
          action: "open-item",
          id: lesson.id,
        });
      }
    }
    for (const asset of store.data.assets) {
      if (!q || asset.filename.toLowerCase().includes(q)) {
        results.push({
          type: "素材",
          label: asset.filename,
          action: "route",
          route: "media",
        });
      }
    }
    for (const entry of requirementBacklog(store.data).entries) {
      if (
        q &&
        `${entry.lesson_code}${entry.lesson_title}${entry.note}`.toLowerCase()
          .includes(q)
      ) {
        results.push({
          type: "待补",
          label: `${entry.lesson_code}｜${entry.note || entry.type}`,
          action: "focus-requirement",
          id: entry.id,
        });
      }
    }
    for (
      const [label, route] of [
        ["打开工作台", "workbench"],
        ["打开课程地图", "map"],
        ["打开资源浏览器", "explorer"],
        ["打开映射预览", "mapping"],
        ["打开收件箱", "inbox"],
        ["打开制作看板", "board"],
        ["打开待补总览", "backlog"],
        ["打开媒体库", "media"],
        ["打开版本历史", "versions"],
        ["保存版本", "save-version"],
        ["快速收集", "capture"],
        ["显示所有缺素材的课", "missing-media"],
      ]
    ) {
      if (!q || label.toLowerCase().includes(q)) {
        results.push({
          type: "命令",
          label,
          action: route === "save-version" || route === "capture"
            ? route
            : route === "missing-media"
            ? "missing-media"
            : route === "workbench"
            ? "open-workbench"
            : route === "mapping"
            ? "open-import-mapping"
            : "route",
          route: route,
        });
      }
    }
    return results.slice(0, 10).map((result, index) =>
      `<button class="palette-result ${
        index === store.ui.paletteIndex ? "selected" : ""
      }" data-action="palette-run" data-palette-action="${
        result.action
      }" data-id="${result.id || ""}" data-route="${
        result.route || ""
      }"><span class="result-type">${result.type}</span><b>${
        esc(result.label)
      }</b><span>↵</span></button>`
    ).join("") || `<div class="no-results">没有找到匹配内容。换一个关键词，或按 Esc 关闭搜索。</div>`;
  }

  function toastView(esc) {
    return store.ui.toast
      ? `<div class="toast" role="status">${
        esc(store.ui.toast)
      }<button class="icon-button" data-action="clear-toast">×</button></div>`
      : "";
  }

  return {
    launcherView: launcher,
    shellView,
    overlayView: overlay,
    toastView: toast,
    statusbarView: () => statusbarView(store.currentItem()),
    saveStateView,
    paletteResults,
  };
}
