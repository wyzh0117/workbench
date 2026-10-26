import {
  insertBlock,
  normalizeWebUrl,
  parseDocument,
  serializeDocument,
} from "./workbench-model.js";
export function errorMessage(error) {
  let value = error;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value?.error?.user_message || value?.user_message || value?.message ||
    "操作未完成，请重试。";
}
/** Native is the sole authority for filesystem access, credentials and network requests. */
export class WorkbenchBridge {
  constructor(invoke = globalThis.__TAURI__?.core?.invoke || null) {
    this.invoke = invoke;
  }
  get native() {
    return typeof this.invoke === "function";
  }
  async call(name, input = {}) {
    if (!this.native) {
      throw new Error(
        "此操作需要 Workbench 桌面版。浏览器中可以编辑文档，但不会模拟本地文件、AI 或搜索结果。",
      );
    }
    try {
      return await this.invoke(name, { input });
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  }
}
/** Each save captures a revision and chains the last acknowledged file hash. */
export class DocumentSession {
  constructor(bridge) {
    this.bridge = bridge;
    this.document = null;
    this.path = null;
    this.sourcePath = null;
    this.hash = null;
    this.revision = 0;
    this.savedRevision = 0;
    this.generation = 0;
    this.queue = Promise.resolve();
  }
  get dirty() {
    return this.revision !== this.savedRevision;
  }
  get writable() {
    return Boolean(this.path && /\.(md|markdown)$/i.test(this.path));
  }
  open(result) {
    this.generation++;
    this.document = parseDocument(
      result.markdown || "",
      result.title || "未命名文档",
    );
    this.path = result.path || null;
    this.sourcePath = result.sourcePath || result.path || null;
    this.hash = result.hash || null;
    this.revision = 0;
    this.savedRevision = 0;
  }
  touch() {
    this.revision++;
  }
  /** @param {string|null} [destination] */
  save(destination = null) {
    if (!this.document) return Promise.resolve(null);
    const path = destination || this.path;
    if (!path || !/\.(md|markdown)$/i.test(path)) {
      return Promise.reject(
        new Error("请另存为 Markdown 文档；原始文件不会被覆盖。"),
      );
    }
    const revision = this.revision,
      generation = this.generation,
      markdown = serializeDocument(this.document),
      sourcePath = this.sourcePath;
    const operation = this.queue.catch(() => {}).then(async () => {
      if (generation !== this.generation) {
        throw new Error("文档已切换，未保存旧文档。");
      }
      const result = await this.bridge.call("wb_document_save", {
        path,
        sourcePath,
        markdown,
        ...(path === this.path && this.hash ? { expectedHash: this.hash } : {}),
      });
      if (generation === this.generation) {
        this.path = result.path || path;
        this.sourcePath = this.path;
        this.hash = result.hash;
        this.savedRevision = revision;
      }
      return result;
    });
    this.queue = operation;
    return operation;
  }
}
/** Refuse replacement/close unless the latest revision has actually reached disk. */
export async function flushStableDocument(session) {
  const generation = session.generation;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (generation !== session.generation) {
      throw new Error("文档已切换，请重新操作。");
    }
    if (!session.dirty) return;
    await session.save();
    if (!session.dirty && generation === session.generation) return;
  }
  throw new Error("文档仍在编辑中。请暂停输入并保存后，再切换或关闭。");
}
/** Stale network responses cannot replace a newer source or its provenance. */
export class LatestRequest {
  constructor() {
    this.sequence = 0;
  }
  invalidate() {
    this.sequence++;
  }
  async run(operation, apply) {
    const token = ++this.sequence;
    try {
      const result = await operation();
      if (token !== this.sequence) return false;
      apply(result);
      return true;
    } catch (error) {
      if (token !== this.sequence) return false;
      throw error;
    }
  }
}
/** Keep an excerpt tied to exactly the reader source where it was selected. */
export class SourceSelection {
  constructor() {
    this.url = null;
    this.text = "";
  }
  /** @param {string|null} [url] */
  reset(url = null) {
    this.url = url;
    this.text = "";
  }
  capture(url, text) {
    if (url === this.url) this.text = String(text || "");
  }
  read(url) {
    return url === this.url ? this.text : "";
  }
}
/** A slow browser File.text() may not discard newer edits or a different document. */
export async function readImportSnapshot(session, read) {
  const generation = session.generation, revision = session.revision;
  const markdown = await read();
  if (session.generation !== generation || session.revision !== revision) {
    throw new Error("文档在读取期间发生更改，未替换当前内容。请重新导入。");
  }
  return markdown;
}

/** Materialize a discovered image before adding any document blocks. No broken-embed fallback. */
export async function insertDiscoveredImage(session, result, chapterId = "") {
  if (!session.document || !session.writable) {
    throw new Error("请先将文档保存为 Markdown，再插入需要下载的图片。");
  }
  const url = normalizeWebUrl(
    result.imageUrl || result.image_url || result.url,
  );
  const sourceUrl = normalizeWebUrl(result.sourceUrl || result.source_url);
  if (!url || !sourceUrl) throw new Error("图片或原始来源地址无效，未插入。");
  const generation = session.generation;
  const targetId = chapterId || session.document.chapters.at(-1)?.id;
  if (!targetId) throw new Error("请先添加一个章节，再插入图片。");
  const media = await session.bridge.call("wb_media_import", {
    url,
    documentPath: session.path,
    name: result.title,
  });
  if (session.generation !== generation) {
    throw new Error("文档已切换，下载的图片未插入其他文档。");
  }
  const target = session.document.chapters.find((chapter) =>
    chapter.id === targetId
  );
  if (!target || !media?.relativePath || media.kind !== "image") {
    throw new Error("图片没有返回可用的本地路径，未插入文档。");
  }
  insertBlock(target, {
    type: "image",
    caption: result.title || media.name,
    url: media.relativePath,
  });
  const attribution = [
    result.title || media.name,
    result.attribution ? "作者：" + result.attribution : "",
    result.license || "",
  ].filter(Boolean).join(" · ");
  insertBlock(target, {
    type: "source",
    caption: "来源：" + attribution,
    url: sourceUrl,
  });
  const licenseUrl = normalizeWebUrl(result.licenseUrl || result.license_url);
  if (licenseUrl) {
    insertBlock(target, {
      type: "source",
      caption: "许可条件：" + (result.license || "查看原始许可"),
      url: licenseUrl,
    });
  }
  return { ...media, documentUrl: media.relativePath };
}
