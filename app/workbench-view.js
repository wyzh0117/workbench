import {
  documentStats,
  escapeHtml as e,
  normalizeWebUrl,
  previewUrl,
} from "./workbench-model.js";
const paths = {
  folder: "M3 7h6l2-3h10v16H3z",
  file: "M6 3h8l4 4v14H6z M14 3v5h5 M9 12h6 M9 16h6",
  image: "M3 4h18v16H3z M3 16l5-5 5 5 3-3 5 5 M15 8h.01",
  video: "M3 5h18v14H3z M10 9l5 3-5 3z",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  plus: "M12 5v14 M5 12h14",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  up: "M5 15l7-7 7 7",
  down: "M5 9l7 7 7-7",
  close: "M5 5l14 14 M19 5L5 19",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M19 5l-2 2 M7 17l-2 2",
  upload: "M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6",
  download: "M12 3v13 M7 11l5 5 5-5 M4 15v6h16v-6",
  link:
    "M10 14l4-4 M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  globe:
    "M3 12h18 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 3c-6 5-6 13 0 18 M12 3c6 5 6 13 0 18",
  panel: "M3 4h18v16H3z M9 4v16",
  trash: "M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7",
  copy: "M8 8h12v13H8z M16 8V3H3v13h5",
  text: "M4 4h16 M12 4v16 M8 20h8",
  check: "M4 12l5 5L20 6",
  save: "M4 3h13l4 4v14H3V3z M7 3v6h10V3 M7 21v-8h10v8",
  external: "M13 3h8v8 M21 3 10 14 M10 3H3v18h18v-7",
};
export const icon = (name) =>
  `<svg class="wb-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="${
    paths[name] || paths.file
  }"/></svg>`;
const button = (action, label, glyph = "", cls = "", extra = "") =>
  `<button class="btn ${cls}" data-action="${action}" ${extra}>${
    glyph ? icon(glyph) : ""
  }<span>${label}</span></button>`;
const ib = (action, label, glyph, extra = "") =>
  `<button class="icon-btn" data-action="${action}" aria-label="${
    e(label)
  }" title="${e(label)}" ${extra}>${icon(glyph)}</button>`;
const empty = (glyph, title, body, actions = "") =>
  `<div class="panel-empty"><div class="empty-glyph">${
    icon(glyph)
  }</div><h3>${title}</h3><p>${body}</p>${actions}</div>`;
/** @returns {Record<string, any>} */
export function initialViewState() {
  return {
    native: false,
    document: null,
    path: null,
    dirty: false,
    leftTab: "media",
    rightTab: "discover",
    leftCollapsed: false,
    rightCollapsed: false,
    leftWidth: 244,
    rightWidth: 350,
    media: [],
    mediaFilter: "all",
    folder: null,
    folderLoading: false,
    activeChapter: null,
    query: "",
    searchKind: "web",
    results: [],
    searching: false,
    searchRan: false,
    searchWarnings: [],
    reader: null,
    readerMode: "text",
    readerLoading: false,
    analysis: null,
    providers: [],
    configured: {},
    resourceProviders: [],
    busy: "",
    notice: "",
    noticeKind: "info",
    saveStatus: "",
    modal: null,
    styleMarkdown: "",
    selectedProvider: "",
    selectedModel: "",
    previewUrls: {},
  };
}
function leftPanel(s) {
  const tabs = `<div class="panel-tabs" role="tablist" aria-label="本地资料">${
    ["media", "folder"].map((t, i) =>
      `<button role="tab" id="tab-${t}" aria-controls="library-body" aria-selected="${
        s.leftTab === t
      }" data-action="left-tab" data-value="${t}">${
        icon(i ? "folder" : "image")
      }${i ? "文件夹" : "媒体库"}</button>`
    ).join("")
  }</div>`;
  let body = "";
  if (s.leftTab === "folder") {
    body = `<div class="folder-toolbar">${
      ib(
        "folder-parent",
        "上一级文件夹",
        "up",
        s.folder?.parentPath ? "" : "disabled",
      )
    }<span title="${e(s.folder?.path || "")}">${
      e(s.folder?.path?.split(/[\\/]/).filter(Boolean).at(-1) || "未选择文件夹")
    }</span>${ib("choose-folder", "选择文件夹", "folder")}</div>`;
    if (s.folderLoading) {
      body +=
        `<div class="loading-row"><span class="spinner"></span>正在读取文件夹</div>`;
    } else if (!s.folder) {
      body += empty(
        "folder",
        "打开本地文件夹",
        "显示当前文件夹中的文档、图片和视频。",
        button("choose-folder", "选择文件夹", "folder"),
      );
    } else {body += `<div class="folder-path" title="${e(s.folder.path)}">${
        e(s.folder.path)
      }</div><div class="folder-list">${
        s.folder.entries?.length
          ? s.folder.entries.map((f) =>
            `<button class="folder-entry" data-action="folder-entry" data-path="${
              e(f.path)
            }" data-kind="${e(f.kind)}"><span class="file-glyph ${
              ["directory", "folder"].includes(f.kind) ? "is-folder" : ""
            }">${
              icon(
                ["directory", "folder"].includes(f.kind)
                  ? "folder"
                  : /^(png|jpg|jpeg|webp|gif|svg)$/i.test(f.extension)
                  ? "image"
                  : /^(mp4|mov|webm)$/i.test(f.extension)
                  ? "video"
                  : "file",
              )
            }</span><span><b>${e(f.name)}</b><small>${
              ["directory", "folder"].includes(f.kind)
                ? "文件夹"
                : e((f.extension || "文件").toUpperCase()) +
                  (f.size ? " · " + formatBytes(f.size) : "")
            }</small></span>${
              ["directory", "folder"].includes(f.kind) ? icon("right") : ""
            }</button>`
          ).join("")
          : empty("folder", "文件夹为空", "选择上一级查看其他文件。")
      }</div>`;}
  } else {
    const rows = s.media.filter((m) =>
      s.mediaFilter === "all" || m.kind === s.mediaFilter
    );
    body =
      `<div class="media-toolbar"><div class="chips" role="group" aria-label="媒体类型">${
        [["all", "全部"], ["image", "图片"], ["video", "视频"]].map(([v, l]) =>
          `<button class="chip ${
            s.mediaFilter === v ? "active" : ""
          }" data-action="media-filter" data-value="${v}" aria-pressed="${
            s.mediaFilter === v
          }">${l}</button>`
        ).join("")
      }</div>${
        ib("import-media", "添加本地媒体", "plus")
      }</div><div class="library-summary"><span>本地素材</span><span>${rows.length} 项</span></div>`;
    body += rows.length
      ? `<div class="media-grid">${
        rows.map((m) => {
          const src = previewUrl(m.dataUrl || s.previewUrls[m.path] || m.url);
          return `<article class="media-card"><button class="media-preview" data-action="preview-media" data-id="${
            e(m.id)
          }" aria-label="预览 ${e(m.name)}">${
            src
              ? (m.kind === "video"
                ? `<video src="${
                  e(src)
                }" preload="metadata" muted></video><span class="play-symbol">▶</span>`
                : `<img src="${e(src)}" alt="${e(m.name)}" loading="lazy">`)
              : icon(m.kind === "video" ? "video" : "image")
          }</button><div class="media-caption"><b title="${e(m.name)}">${
            e(m.name)
          }</b><span>${m.kind === "video" ? "视频" : "图片"}</span></div>${
            button(
              "insert-media",
              "插入",
              "plus",
              "small",
              `data-id="${e(m.id)}" ${s.document ? "" : "disabled"}`,
            )
          }</article>`;
        }).join("")
      }</div>`
      : empty(
        "image",
        "让素材触手可及",
        "导入图片或视频，预览后放入正在编写的章节。",
        button("import-media", "添加本地媒体", "plus"),
      );
  }
  return `${tabs}<div id="library-body" role="tabpanel" aria-labelledby="tab-${s.leftTab}" class="panel-body">${body}</div><div class="panel-foot">${
    icon("folder")
  }<span>原文件保留在本地</span>${
    ib("collapse-left", "收起左侧栏", "left")
  }</div>`;
}
const formatBytes = (n) =>
  n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024
    ? `${Math.round(n / 1024)} KB`
    : `${n} B`;
function blockView(block, chapter, s, index) {
  const attrs = `data-chapter="${e(chapter.id)}" data-id="${e(block.id)}"`,
    label = {
      text: "正文",
      image: "图片",
      video: "视频",
      source: "来源",
    }[block.type] || "正文";
  const tools = `<div class="block-tools"><span class="block-kind">${
    icon(block.type === "source" ? "link" : block.type)
  }${label}</span><span class="grow"></span>${
    ib("block-up", "上移区块", "up", attrs + (index === 0 ? " disabled" : ""))
  }${
    ib(
      "block-down",
      "下移区块",
      "down",
      attrs + (index === chapter.blocks.length - 1 ? " disabled" : ""),
    )
  }${ib("block-copy", "复制区块", "copy", attrs)}${
    ib("block-delete", "删除区块", "trash", attrs)
  }</div>`;
  let content = "";
  if (block.type === "text") {
    content =
      `<textarea class="block-text" data-edit="block" ${attrs} aria-label="${
        e(chapter.title)
      }，正文区块 ${
        index + 1
      }" placeholder="在这里写下内容… 支持 Markdown" spellcheck="false">${
        e(block.markdown)
      }</textarea>`;
  } else if (block.type === "source") {
    content = `<div class="source-block">${
      icon("link")
    }<div class="grow"><input class="source-title" data-edit="caption" ${attrs} value="${
      e(block.caption)
    }" aria-label="来源标题"><a href="${
      e(normalizeWebUrl(block.url) || "#")
    }" data-action="read-url" data-url="${e(block.url)}">${
      e(block.url)
    }</a></div>${ib("edit-media", "编辑来源链接", "settings", attrs)}</div>`;
  } else {
    const direct = s.native && /^https?:/.test(block.url) &&
        !/^https?:\/\/asset\.localhost\//.test(block.url)
      ? ""
      : block.url;
    const src = previewUrl(s.previewUrls[block.url] || direct);
    content = `<figure class="document-media">${
      src
        ? (block.type === "video"
          ? `<video src="${e(src)}" controls preload="metadata"></video>`
          : `<img src="${e(src)}" alt="${e(block.caption)}" loading="lazy">`)
        : `<div class="media-unavailable">${
          icon(block.type)
        }<span>预览尚未加载</span><button data-action="load-block-media" ${attrs}>加载本地预览</button></div>`
    }<figcaption><input data-edit="caption" ${attrs} value="${
      e(block.caption || "")
    }" placeholder="添加说明文字" aria-label="媒体说明">${
      ib("edit-media", "编辑媒体地址", "settings", attrs)
    }</figcaption></figure>`;
  }
  return `<section class="document-block ${block.type}-block" data-block="${
    e(block.id)
  }">${tools}${content}</section>`;
}
function center(s) {
  const doc = s.document,
    stats = documentStats(doc),
    chapters = doc?.chapters || [],
    active = s.activeChapter
      ? chapters.filter((c) => c.id === s.activeChapter)
      : chapters;
  const toolbar =
    `<div class="document-toolbar"><div class="sidebar-controls">${
      ib(
        s.leftCollapsed ? "expand-left" : "toggle-left",
        s.leftCollapsed ? "展开左侧栏" : "收起左侧栏",
        "panel",
        `aria-expanded="${!s.leftCollapsed}"`,
      )
    }${
      s.leftCollapsed ? '<span class="toolbar-divider"></span>' : ""
    }</div><span class="doc-crumb">${icon("file")}<span>${
      e(doc?.title || "新建工作区")
    }</span></span><span class="grow"></span>${
      doc
        ? `<select aria-label="切换章节" data-change="chapter"><option value="">全部章节 · ${chapters.length}</option>${
          chapters.map((c, i) =>
            `<option value="${e(c.id)}" ${
              s.activeChapter === c.id ? "selected" : ""
            }>${i + 1}. ${e(c.title)}</option>`
          ).join("")
        }</select>${button("add-chapter", "章节", "plus", "small ghost")}`
        : ""
    }${
      ib(
        s.rightCollapsed ? "expand-right" : "toggle-right",
        s.rightCollapsed ? "展开右侧栏" : "收起右侧栏",
        "panel",
        `aria-expanded="${!s.rightCollapsed}"`,
      )
    }</div>`;
  if (!doc) {
    return toolbar +
      `<div class="document-stage empty-stage"><div class="welcome"><img class="welcome-mark" src="/assets/workbench-mark.png" alt=""><span class="eyebrow">一个专注内容的工作空间</span><h1>从一份文档开始，<br><span>把想法写成作品。</span></h1><p>文档、素材与灵感，在同一处汇合。<br>导入已有内容，或从空白页开始。</p><div class="welcome-actions">${
        button("import", "导入文档", "upload", "primary")
      }${
        button("new", "新建空白文档", "plus")
      }</div><div class="supported-formats">Markdown · TXT · Word · PowerPoint · PDF</div></div><div class="workspace-principles"><span>${
        icon("file")
      }章节式编写</span><span>${icon("image")}本地媒体</span><span>${
        icon("globe")
      }来源可追溯</span></div></div>`;
  }
  return toolbar +
    `<div class="document-stage"><div class="paper-meta"><span>${
      icon("file")
    }可编辑文档</span><span>${stats.chapters} 章 · ${stats.blocks} 个区块</span></div><article class="document-paper"><div class="paper-kicker"><span>WORKBENCH / DOCUMENT</span><span>${
      s.dirty ? "编辑中" : "本地文档"
    }</span></div><input class="document-title" data-edit="title" aria-label="文档标题" value="${
      e(doc.title)
    }"><div class="paper-rule"></div>${
      active.map((chapter) =>
        `<section class="chapter" data-chapter-section="${
          e(chapter.id)
        }"><div class="chapter-heading"><span class="chapter-number">${
          String(chapters.indexOf(chapter) + 1).padStart(2, "0")
        }</span><input data-edit="chapter-title" data-chapter="${
          e(chapter.id)
        }" value="${
          e(chapter.title)
        }" aria-label="章节标题"><div class="chapter-tools">${
          ib("chapter-up", "上移章节", "up", `data-id="${e(chapter.id)}"`)
        }${
          ib("chapter-down", "下移章节", "down", `data-id="${e(chapter.id)}"`)
        }${
          ib(
            "chapter-delete",
            "删除章节",
            "trash",
            `data-id="${e(chapter.id)}"`,
          )
        }</div></div>${
          chapter.blocks.map((b, i) => blockView(b, chapter, s, i)).join("")
        }<div class="insert-row"><span>插入区块</span>${
          [["text", "正文", "text"], ["image", "图片", "image"], [
            "video",
            "视频",
            "video",
          ], ["source", "来源", "link"]].map(([t, l, g]) =>
            button(
              "add-block",
              l,
              g,
              "small ghost",
              `data-kind="${t}" data-chapter="${e(chapter.id)}"`,
            )
          ).join("")
        }</div></section>`
      ).join("")
    }<div class="paper-footer"><span>${
      e(doc.title)
    }</span><span>${stats.characters.toLocaleString()} 字符</span></div></article><div class="document-bottom">${
      button("add-chapter", "添加新章节", "plus", "ghost")
    }</div></div>`;
}
function discovery(s) {
  const analysis = s.analysis
    ? `<section class="analysis-summary"><div>${
      icon("spark")
    }<b>文档要点</b></div><p>${
      e(s.analysis.summary || "")
    }</p><div class="topic-chips">${
      (s.analysis.keywords || []).slice(0, 8).map((q) =>
        `<button data-action="search-topic" data-query="${e(q)}">${
          e(q)
        }</button>`
      ).join("")
    }</div></section>`
    : "";
  const controls =
    `<form class="search-form" data-form="search"><div class="search-input">${
      icon("search")
    }<input name="query" aria-label="搜索关键词" placeholder="搜索与内容相关的素材" value="${
      e(s.query)
    }"><button type="submit" aria-label="开始搜索" ${
      s.searching ? "disabled" : ""
    }>${
      icon("right")
    }</button></div></form><div class="discovery-types" role="group" aria-label="搜索类型">${
      [["web", "网页", "globe"], ["image", "图片", "image"], [
        "video",
        "视频",
        "video",
      ]].map(([k, l, g]) =>
        `<button class="${
          s.searchKind === k ? "active" : ""
        }" data-action="search-kind" data-kind="${k}" aria-pressed="${
          s.searchKind === k
        }">${icon(g)}${l}</button>`
      ).join("")
    }</div>`;
  let result = "";
  if (s.searching) {
    result =
      `<div class="loading-row"><span class="spinner"></span>正在向搜索服务查找…</div>`;
  } else if (s.results.length) {
    result =
      `<div class="result-count">找到 ${s.results.length} 条结果<span>来自真实网络来源</span></div><div class="result-list">${
        s.results.map((r, i) =>
          `<article class="result-card">${
            r.kind === "image" && previewUrl(r.thumbnailUrl || r.thumbnail_url)
              ? `<button class="result-image" data-action="read-result" data-index="${i}"><img src="${
                e(previewUrl(r.thumbnailUrl || r.thumbnail_url))
              }" alt="${e(r.title)}" loading="lazy"></button>`
              : ""
          }<div class="result-source">${
            icon(
              r.kind === "video"
                ? "video"
                : r.kind === "image"
                ? "image"
                : "globe",
            )
          }<span>${e(hostname(r.url))}</span><span>${
            e(r.providerId || r.provider_id || "")
          }</span></div><h3><button data-action="read-result" data-index="${i}">${
            e(r.title)
          }</button></h3><p>${e(r.description || r.excerpt || "")}</p>${
            r.license
              ? `<div class="result-license">${
                e(
                  typeof r.license === "string"
                    ? r.license
                    : JSON.stringify(r.license),
                )
              }</div>`
              : ""
          }<div class="result-actions">${
            button(
              "read-result",
              "查看来源",
              "",
              "small ghost",
              `data-index="${i}"`,
            )
          }${
            button(
              "insert-result",
              "插入文档",
              "plus",
              "small",
              `data-index="${i}" ${s.document ? "" : "disabled"}`,
            )
          }</div></article>`
        ).join("")
      }</div>`;
  } else {result = empty(
      "search",
      s.searchRan ? "没有找到相关素材" : "让灵感有据可循",
      s.searchRan
        ? "换一组关键词，或检查搜索服务设置。"
        : "搜索网页、图片和视频；先查看来源，再把所需内容放入章节。",
      s.searchRan
        ? ""
        : `<div class="search-hint">图片搜索可直接使用。网页与视频需要配置服务。</div>`,
    );}
  return `${analysis}${controls}${
    s.searchWarnings?.length
      ? `<div class="inline-warning">${
        s.searchWarnings.map(e).join("<br>")
      }</div>`
      : ""
  }${result}`;
}
function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
function reader(s) {
  const source = s.reader,
    validated = normalizeWebUrl(source?.url || ""),
    url = validated?.startsWith("https:") ? validated : null;
  const address = `<form class="address-form" data-form="navigate">${
    icon("globe")
  }<input name="url" value="${
    e(source?.url || "")
  }" aria-label="网页地址" placeholder="粘贴网页地址"><button type="submit" aria-label="打开网页">${
    icon("right")
  }</button></form>`;
  if (s.readerLoading) {
    return address +
      `<div class="loading-row"><span class="spinner"></span>读取来源内容…</div>`;
  }
  if (!source) {
    return address +
      empty(
        "globe",
        "在这里阅读来源",
        "打开搜索结果或输入网址。画布始终保留在身旁。",
      );
  }
  return `${address}<div class="reader-toolbar"><div class="chips"><button class="chip ${
    s.readerMode === "text" ? "active" : ""
  }" data-action="reader-mode" data-value="text">提取正文</button><button class="chip ${
    s.readerMode === "web" ? "active" : ""
  }" data-action="reader-mode" data-value="web">原始网页</button></div>${
    ib("open-external", "在系统浏览器打开", "external")
  }</div><div class="reader-heading"><h3>${
    e(source.title || hostname(source.url))
  }</h3><a href="${e(url || "#")}" data-action="open-external">${
    e(hostname(source.url))
  }</a></div>${
    s.readerMode === "web" && url
      ? `<div class="embedded-browser"><iframe src="${e(url)}" title="${
        e(source.title || "来源网页")
      }" sandbox="allow-scripts allow-forms allow-popups allow-presentation" referrerpolicy="no-referrer"></iframe></div><div class="reader-limits">部分网站禁止嵌入，或需要登录。如果页面空白，请切换「提取正文」或在系统浏览器打开。原始网页内的跨域选区无法读取。</div>`
      : `<div class="reader-text" id="reader-text" tabindex="0">${
        e(
          source.text || source.excerpt ||
            "此页面没有可提取正文。可切换原始网页或在系统浏览器打开。",
        )
      }</div>${
        source.limitations
          ? `<div class="reader-limits">${
            e(
              Array.isArray(source.limitations)
                ? source.limitations.join(" · ")
                : source.limitations,
            )
          }</div>`
          : ""
      }`
  }<div class="reader-insert">${
    button(
      "insert-selection",
      "插入选中文字",
      "plus",
      "primary small",
      s.document && s.readerMode === "text" ? "" : "disabled",
    )
  }${
    button(
      "insert-source",
      "引用来源",
      "link",
      "small",
      s.document ? "" : "disabled",
    )
  }<small>插入后保留来源链接</small></div>`;
}
function rightPanel(s) {
  return `<div class="panel-tabs" role="tablist" aria-label="在线资料">${
    [["discover", "发现素材", "spark"], ["browser", "浏览网页", "globe"]].map((
      [t, l, g],
    ) =>
      `<button role="tab" aria-selected="${
        s.rightTab === t
      }" data-action="right-tab" data-value="${t}" aria-controls="research-body" id="tab-${t}">${
        icon(g)
      }${l}</button>`
    ).join("")
  }</div><div class="panel-body research-body" id="research-body" role="tabpanel" aria-labelledby="tab-${s.rightTab}">${
    s.rightTab === "browser" ? reader(s) : discovery(s)
  }</div><div class="panel-foot">${
    ib("collapse-right", "收起右侧栏", "right")
  }<span>${
    s.searchKind === "image" ? "Wikimedia Commons" : "搜索服务由你掌控"
  }</span>${ib("settings", "配置服务", "settings")}</div>`;
}
function modal(s) {
  if (!s.modal) return "";
  const m = s.modal;
  let content = "", title = "";
  if (m.type === "settings") {
    title = "连接你的服务";
    const current = s.providers.find((p) => p.id === s.selectedProvider),
      id = current?.id || "workbench-api";
    content =
      `<p class="modal-lead">凭据只存入系统安全存储，不进入文档、浏览器存储或导出文件。</p><div class="settings-tabs"><b>AI 模型</b><span>用于理解文档与生成内容</span></div><form data-form="ai-settings"><label>已有连接<select name="existing" data-change="provider"><option value="">添加新连接</option>${
        s.providers.filter((p) => p.id !== "fake").map((p) =>
          `<option value="${e(p.id)}" ${
            p.id === s.selectedProvider ? "selected" : ""
          }>${e(p.label || p.name || p.id)}${
            s.configured[p.id] ? " · 已配置密钥" : ""
          }</option>`
        ).join("")
      }</select></label><div class="form-grid"><label>连接名称<input name="label" value="${
        e(current?.label || current?.name || "我的模型服务")
      }" required></label><label>连接 ID<input name="id" value="${e(id)}" ${
        current ? "readonly" : ""
      } required pattern="[A-Za-z0-9_-]+"></label></div><label>API 地址<input name="base_url" type="url" value="${
        e(current?.base_url || "")
      }" placeholder="https://api.example.com/v1" required></label><div class="form-grid"><label>协议<select name="api_protocol">${
        [["openai-completions", "OpenAI Chat Completions"], [
          "openai-responses",
          "OpenAI Responses",
        ], ["anthropic-messages", "Anthropic Messages"]].map(([v, l]) =>
          `<option value="${v}" ${
            current?.api_protocol === v ? "selected" : ""
          }>${l}</option>`
        ).join("")
      }</select></label><label>模型 ID<input name="model" value="${
        e(s.selectedModel || current?.default_model || "")
      }" placeholder="服务商提供的模型名称" required></label></div><label>API Key<input name="secret" type="password" autocomplete="new-password" placeholder="${
        s.configured[id] ? "已保存；留空保留现有密钥" : "输入后写入系统安全存储"
      }"></label><div class="form-actions"><span>${
        s.configured[id] ? "系统已确认密钥存在" : "尚未确认密钥"
      }</span><button class="btn primary" type="submit">保存连接</button></div></form><div class="settings-tabs"><b>联网搜索</b><span>图片使用 Wikimedia Commons，无需密钥</span></div>${
        [["brave_search", "Brave Search", "网页搜索"], [
          "youtube_data_api",
          "YouTube Data API",
          "视频搜索",
        ]].map(([id, label, hint]) =>
          `<form data-form="search-settings" class="search-setting"><div><b>${label}</b><small>${hint} · ${
            s.resourceProviders.find((p) => p.id === id)?.credential_present
              ? "已配置"
              : "未配置"
          }</small></div><input type="hidden" name="provider_id" value="${id}"><input name="secret" type="password" autocomplete="new-password" placeholder="API Key" aria-label="${label} API Key" required><button class="btn small" type="submit">保存</button></form>`
        ).join("")
      }`;
  } else if (m.type === "export") {
    title = "生成与导出";
    content =
      `<p class="modal-lead">导出当前编辑内容，或先让已配置的 AI 生成一份可审阅的新稿。</p><form data-form="export"><label>导出格式<select name="format"><option value="md">Markdown 文档 (.md)</option><option value="docx">Word 文档 (.docx)</option><option value="pptx">PowerPoint 演示文稿 (.pptx)</option><option value="html">网页文档 (.html)</option>${
        s.styleMarkdown
          ? '<option value="style">模板样式说明 (.md)</option>'
          : ""
      }</select></label><p class="field-help">文件只在选择保存位置后生成。媒体随导出文档保存在对应资源文件夹。</p><button class="btn primary" type="submit">${
        icon("download")
      }选择位置并导出</button></form><div class="settings-tabs"><b>AI 生成新稿</b><span>保留当前文档，审阅后再决定是否应用</span></div><form data-form="generate"><label>希望如何改写？<textarea name="instruction" rows="3" placeholder="例如：整理成结构清晰的课堂讲义，保留引用来源。" required></textarea></label><p class="field-help">当前文档会发送给你选择的模型服务。不会上传 API Key 或其他本地文件。</p><button class="btn" type="submit">${
        icon("spark")
      }生成草稿</button></form>${
        s.styleMarkdown
          ? `<details class="style-details"><summary>已提取的模板样式</summary><pre>${
            e(s.styleMarkdown)
          }</pre></details>`
          : ""
      }`;
  } else if (m.type === "generated") {
    title = "审阅 AI 草稿";
    content =
      `<p class="modal-lead">这是服务返回的真实草稿。请核实事实与来源；应用会替换当前编辑内容。</p><textarea class="generated-editor" data-edit="generated" aria-label="AI 生成草稿">${
        e(m.markdown)
      }</textarea><div class="form-actions">${
        button("close-modal", "保留原文")
      }${button("apply-generated", "应用草稿", "check", "primary")}</div>`;
  } else if (m.type === "link") {
    title =
      { image: "插入图片", video: "插入视频", source: "引用来源" }[m.kind] ||
      "编辑媒体";
    content =
      `<form data-form="link"><label>标题或说明<input name="caption" value="${
        e(m.caption || "")
      }" required></label><label>地址<input name="url" value="${
        e(m.url || "")
      }" placeholder="https://… 或文档相对路径" required></label><p class="field-help">媒体保留来源地址。导出时由本地程序处理可用的媒体资源。</p><button class="btn primary" type="submit">${
        icon("plus")
      }${m.blockId ? "保存更改" : "插入文档"}</button></form>`;
  } else if (m.type === "preview") {
    title = m.item.name;
    const src = previewUrl(
      m.item.dataUrl || s.previewUrls[m.item.path] || m.item.url,
    );
    content = `<div class="large-preview">${
      src
        ? (m.item.kind === "video"
          ? `<video src="${e(src)}" controls autoplay></video>`
          : `<img src="${e(src)}" alt="${e(m.item.name)}">`)
        : "<p>无法预览此媒体。文件格式或大小可能不受支持。</p>"
    }</div><p class="field-help">${e(m.item.path || m.item.url || "")}</p>${
      button(
        "insert-preview",
        "插入当前章节",
        "plus",
        "primary",
        s.document ? "" : "disabled",
      )
    }`;
  }
  return `<div class="modal-overlay"><section class="modal ${
    m.type === "preview" ? "wide" : ""
  }" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><h2 id="modal-title">${
    e(title)
  }</h2>${
    ib("close-modal", "关闭对话框", "close")
  }</header><div class="modal-content">${content}</div></section></div>`;
}
export function renderWorkbench(s) {
  const status = s.busy || s.saveStatus ||
    (s.dirty ? "未保存的更改" : s.path ? "已从本地读取" : "准备就绪");
  return `<div class="workbench ${s.leftCollapsed ? "left-collapsed" : ""} ${
    s.rightCollapsed ? "right-collapsed" : ""
  }" style="--left:${s.leftWidth}px;--right:${s.rightWidth}px"><header class="appbar"><a class="brand" href="#" data-action="home"><img src="/assets/workbench-mark.png" alt="Workbench 标志"><b>Workbench</b><span>4.0</span></a><span class="appbar-divider"></span><div class="appbar-title" title="${
    e(s.path || "")
  }">${
    e(s.document?.title || "内容工作台")
  }</div><nav class="header-actions" aria-label="工作台操作">${
    button("import", "导入", "upload")
  }${
    button(
      "analyze",
      "AI 解析",
      "spark",
      "ghost",
      s.document && !s.busy ? "" : "disabled",
    )
  }${
    button(
      "export",
      "生成 / 导出",
      "download",
      "primary",
      s.document ? "" : "disabled",
    )
  }${ib("settings", "设置", "settings")}</nav></header>${
    !s.native
      ? '<div class="host-notice">浏览器编辑模式 · 本地文件夹、AI 和联网搜索需在 Workbench 桌面版使用。</div>'
      : ""
  }${
    s.notice
      ? `<div class="notice ${s.noticeKind}" role="${
        s.noticeKind === "error" ? "alert" : "status"
      }"><span>${e(s.notice)}</span>${
        ib("dismiss-notice", "关闭提示", "close")
      }</div>`
      : ""
  }<main class="workspace" ${
    s.busy ? 'inert aria-busy="true"' : ""
  }><aside class="sidebar left-sidebar" aria-label="媒体与文件">${
    leftPanel(s)
  }</aside><div class="resize-handle left-resize" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" aria-valuemin="200" aria-valuemax="420" aria-valuenow="${s.leftWidth}" tabindex="0" data-resize="left"></div><section class="document-area" aria-label="文档编辑区">${
    center(s)
  }</section><div class="resize-handle right-resize" role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" aria-valuemin="280" aria-valuemax="560" aria-valuenow="${s.rightWidth}" tabindex="0" data-resize="right"></div><aside class="sidebar right-sidebar" aria-label="发现与浏览">${
    rightPanel(s)
  }</aside></main><footer class="statusbar"><span class="status-message"><i class="status-dot ${
    s.dirty ? "unsaved" : ""
  }"></i><span id="save-status">${
    e(status)
  }</span></span><span class="status-path" title="${e(s.path || "")}">${
    e(s.path || "文件保留在你的设备上")
  }</span><span>${
    s.document
      ? `${documentStats(s.document).characters.toLocaleString()} 字符`
      : "本地优先"
  }</span>${
    s.document ? button("save", "保存", "save", "status-save") : ""
  }<span class="version">4.0.0</span></footer>${
    s.busy
      ? `<div class="busy-status" role="status"><span class="spinner"></span>${
        e(s.busy)
      }</div>`
      : ""
  }${modal(s)}</div>`;
}
