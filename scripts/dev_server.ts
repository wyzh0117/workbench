import { join, normalize, relative } from "node:path";
import { asErrorObject } from "../src/service/errors.ts";
import { HIGH_LEVEL_COMMANDS, READ_QUERIES } from "../src/service/commands.ts";
import { DesktopService } from "../src/service/desktop.ts";
import { resolveFolderVideoSource } from "../src/service/folder_scan.ts";
import { isPathWithin } from "../src/service/fs_paths.ts";
import { fileRangeResponse } from "../src/service/media_range.ts";

const appRoot = normalize(new URL("../app/", import.meta.url).pathname);
// The browser build intentionally exposes one project root selected by the
// launcher. The renderer never receives arbitrary filesystem access.
//
// `PROJECT_ROOT` / `PORT` let an isolated instance point at a throwaway
// project for desktop-shell verification; the defaults keep the everyday
// development workbench on .workbench-project:4173.
const projectRoot = Deno.env.get("PROJECT_ROOT")?.trim() ||
  join(Deno.cwd(), ".workbench-project");
const port = Number(Deno.env.get("PORT") || "") || 4173;
const desktop = new DesktopService(projectRoot, {
  app_instance_id: `browser-${Deno.pid}`,
});
const mediaTokens = new Map<string, {
  expiresAt: number;
  kind: "asset" | "folder";
  projectId?: string;
  assetId?: string;
  root?: string;
  relativePath?: string;
}>();
const scannedFolderRoots = new Map<string, { expiresAt: number; videoPaths: Set<string> }>();
const MEDIA_TOKEN_TTL_MS = 10 * 60 * 1000;
const MEDIA_TOKEN_LIMIT = 32;
const EXPORT_DOWNLOAD_CHUNK_BYTES = 1024 * 1024;

class MediaTokenCapacityError extends Error {}

await desktop.open();

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function json(value: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(value, (_key, child) => {
      if (child instanceof Uint8Array) {
        let binary = "";
        for (const byte of child) binary += String.fromCharCode(byte);
        return { __bytes_base64: btoa(binary) };
      }
      return child;
    }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function errorResponse(value: unknown, status = 400): Response {
  const error = typeof value === "string"
    ? {
      code: "bridge_request_failed",
      user_message: value,
      technical_message: value,
      severity: "recoverable",
      recoverable: true,
      recommended_action: "检查提示后重试。",
      details: {},
    }
    : asErrorObject(value, "bridge_request_failed");
  return json({ error }, status);
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("请求必须是 JSON 对象");
    }
    return value as Record<string, unknown>;
  } catch (caught) {
    throw new Error(
      caught instanceof Error ? caught.message : "请求 JSON 无效",
    );
  }
}

async function bridgeSession(request: Request): Promise<Response> {
  if (request.method === "GET") {
    // The service validates the sidecar against the current project before it
    // returns anything. A missing/corrupt/inaccessible record is just null.
    return json({ value: await desktop.loadBrowserSession() });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  try {
    const body = await requestBody(request);
    const hasOrdering = ["session_generation", "revision", "operation_id"]
      .some((key) => key in body);
    if (hasOrdering && (
      typeof body.session_generation !== "number" ||
      typeof body.revision !== "number" ||
      typeof body.operation_id !== "string"
    )) {
      throw new Error("Session ordering metadata must be complete");
    }
    const result = await desktop.saveBrowserSession(
      body.session,
      hasOrdering
        ? {
          session_generation: body.session_generation as number,
          revision: body.revision as number,
          operation_id: body.operation_id as string,
        }
        : undefined,
    );
    return json({ value: result ?? null });
  } catch (caught) {
    return json({ error: asErrorObject(caught, "browser_session_unavailable") }, 400);
  }
}

async function bridgeSessionOpen(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  try {
    const body = await requestBody(request);
    if (typeof body.project_id !== "string") {
      throw new Error("POST /api/session/open requires project_id");
    }
    return json({ value: await desktop.openBrowserSession(body.project_id) });
  } catch (caught) {
    return json({ error: asErrorObject(caught, "browser_session_unavailable") }, 400);
  }
}

async function bridgeCommand(request: Request): Promise<Response> {
  const body = await requestBody(request);
  const name = typeof body.name === "string" ? body.name : "";
  if (!HIGH_LEVEL_COMMANDS.includes(name as never)) {
    return errorResponse("该操作不受支持。", 404);
  }
  const execution = await desktop.commands.execute(name, body.input ?? {});
  if (execution.error) return json({ error: execution.error }, 400);
  const scanValue = execution.value as { root?: unknown; entries?: unknown } | null;
  const scannedRoot = scanValue?.root;
  if (name === "folder.scan" && typeof scannedRoot === "string") {
    try {
      const root = await Deno.realPath(scannedRoot);
      const videoPaths = new Set<string>();
      if (Array.isArray(scanValue?.entries)) {
        for (const entry of scanValue.entries as Array<Record<string, unknown>>) {
          if (entry.kind !== "file" || !String(entry.mime || "").startsWith("video/")) continue;
          if (typeof entry.relative_path === "string") videoPaths.add(entry.relative_path.replaceAll("\\", "/"));
        }
      }
      scannedFolderRoots.set(root, { expiresAt: Date.now() + MEDIA_TOKEN_TTL_MS, videoPaths });
      while (scannedFolderRoots.size > 16) {
        const oldest = scannedFolderRoots.keys().next().value;
        if (!oldest) break;
        scannedFolderRoots.delete(oldest);
      }
    } catch { /* the scan already returned its user-facing path error */ }
  }
  return json({
    value: execution.value,
    execution_id: execution.id,
    ...(execution.mutation_ack ? { mutation_ack: execution.mutation_ack } : {}),
  });
}

async function bridgeQuery(request: Request): Promise<Response> {
  const body = await requestBody(request);
  const name = typeof body.name === "string" ? body.name : "";
  if (!READ_QUERIES.includes(name as never)) {
    return errorResponse("该查询不受支持。", 404);
  }
  try {
    return json({
      value: await desktop.queries.execute(name, body.input ?? {}),
    });
  } catch (caught) {
    return errorResponse(caught);
  }
}

/** Upper bound for a preview payload; the native shell uses the same limit. */
const ASSET_READ_SIZE_LIMIT = 8 * 1024 * 1024;

/**
 * Read-only asset bytes for UI previews in the browser build.  The desktop
 * shell exposes the same capability through the `asset_read` command, which
 * resolves the id against the open project and refuses unsafe paths.  Here the
 * request is limited to the one configured project root.
 */
async function bridgeAssetBytes(request: Request): Promise<Response> {
  const body = await requestBody(request);
  const assetId = typeof body.asset_id === "string" ? body.asset_id : "";
  if (!assetId) return errorResponse("缺少素材 ID。", 400);
  const project = desktop.context.project;
  const asset = project?.assets.find((candidate) => candidate.id === assetId);
  if (!asset || asset.archived) return errorResponse("找不到素材。", 404);
  const storagePath = String(asset.storage_path || "");
  if (
    !storagePath || storagePath.startsWith("/") ||
    storagePath.split(/[\\/]/).includes("..")
  ) {
    return errorResponse("素材路径无效。", 400);
  }
  const target = join(projectRoot, storagePath);
  // Reject symlinked components and oversized files, matching the native
  // `asset_read` limits: this route returns project bytes to the renderer.
  try {
    const realRoot = await Deno.realPath(projectRoot);
    const realTarget = await Deno.realPath(target);
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
      return errorResponse("素材路径无效。", 400);
    }
    const stat = await Deno.lstat(target);
    if (!stat.isFile) return errorResponse("素材路径不是文件。", 400);
    if (stat.size > ASSET_READ_SIZE_LIMIT) {
      return errorResponse("素材过大，无法在工作台内预览（单文件上限 8 MiB）。", 413);
    }
  } catch {
    return errorResponse("素材文件不可读。", 404);
  }
  try {
    const bytes = await Deno.readFile(target);
    return new Response(bytes, {
      headers: {
        "content-type": asset.mime_type || "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  } catch {
    return errorResponse("素材文件不可读。", 404);
  }
}

async function exportDownloadResponse(
  exportId: string,
  fileIndex: number,
  requestSignal: AbortSignal,
): Promise<Response> {
  const handle = await desktop.openExportDownload(exportId, fileIndex, requestSignal);
  let servedBytes = 0;
  const filename = handle.relative_path.split(/[\\/]/).at(-1) || "export";
  const asciiFilename = filename.replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\\r\n]/g, "_") || "export";
  const utf8Filename = encodeURIComponent(filename).replace(/[!'()*]/g, (value) =>
    `%${value.charCodeAt(0).toString(16).toUpperCase()}`
  );
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = new Uint8Array(EXPORT_DOWNLOAD_CHUNK_BYTES);
      try {
        if (handle.signal.aborted) throw new DOMException("Export download cancelled", "AbortError");
        const count = await handle.read(chunk);
        if (count === null) {
          // `finish` marks the download complete synchronously (before its
          // first await). Start it BEFORE the client can observe the end of
          // the body, so a repeated download URL is already refused while the
          // staging cleanup still runs.
          const finishing = handle.finish(true);
          controller.close();
          await finishing;
          return;
        }
        servedBytes += count;
        controller.enqueue(chunk.subarray(0, count));
        if (servedBytes >= handle.size) {
          const finishing = handle.finish(true);
          controller.close();
          await finishing;
        }
      } catch (caught) {
        controller.error(caught);
        await handle.finish(false);
      }
    },
    async cancel() {
      await handle.finish(false);
    },
  }, { highWaterMark: 0 });
  return new Response(body, {
    headers: {
      "content-type": handle.mime_type || "application/octet-stream",
      "content-length": String(handle.size),
      "content-disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function resolveProjectVideoSource(assetId: string): Promise<{
  path: string;
  mime: string;
  size: number;
  projectId: string;
}> {
  const project = desktop.context.project;
  const projectId = project?.project?.id;
  if (!project || !projectId) throw new Error("当前没有打开的课程项目");
  const asset = project.assets.find((candidate) => candidate.id === assetId);
  if (!asset || asset.archived) throw new Error("找不到可预览的视频素材");
  if (asset.type !== "video" || !String(asset.mime_type || "").startsWith("video/")) {
    throw new Error("该素材不是受支持的视频文件");
  }
  const storagePath = String(asset.storage_path || "").replaceAll("\\", "/");
  const parts = storagePath.split("/");
  if (parts[0] !== "assets" || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("素材路径无效");
  }
  const root = await Deno.realPath(projectRoot);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    const stat = await Deno.lstat(cursor);
    if (stat.isSymlink) throw new Error("素材路径包含符号链接");
  }
  const path = await Deno.realPath(cursor);
  if (!isPathWithin(root, path)) {
    throw new Error("素材路径超出项目目录");
  }
  const metadata = await Deno.stat(path);
  if (!metadata.isFile) throw new Error("素材路径不是普通文件");
  return { path, mime: asset.mime_type, size: metadata.size, projectId };
}

function pruneMediaTokens(): void {
  const now = Date.now();
  for (const [token, entry] of mediaTokens) {
    if (entry.expiresAt <= now) mediaTokens.delete(token);
  }
  for (const [root, expiresAt] of scannedFolderRoots) {
    if (expiresAt.expiresAt <= now) scannedFolderRoots.delete(root);
  }
}

function newMediaToken(entry: Omit<NonNullable<ReturnType<typeof mediaTokens.get>>, "expiresAt">): string {
  pruneMediaTokens();
  if (mediaTokens.size >= MEDIA_TOKEN_LIMIT) {
    throw new MediaTokenCapacityError("同时打开的视频预览过多，请先关闭其他预览");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  mediaTokens.set(token, { ...entry, expiresAt: Date.now() + MEDIA_TOKEN_TTL_MS });
  return token;
}

async function createMediaSource(request: Request): Promise<Response> {
  const body = await requestBody(request);
  let entry: Omit<NonNullable<ReturnType<typeof mediaTokens.get>>, "expiresAt">;
  let mime: string;
  let size: number;
  if (typeof body.asset_id === "string" && body.asset_id) {
    const source = await resolveProjectVideoSource(body.asset_id);
    ({ mime, size } = source);
    entry = { kind: "asset", projectId: source.projectId, assetId: body.asset_id };
  } else {
    const rootInput = typeof body.root === "string" ? body.root : "";
    const relativePath = typeof body.relative_path === "string" ? body.relative_path : "";
    const root = await Deno.realPath(rootInput);
    const scan = scannedFolderRoots.get(root);
    const normalizedRelativePath = relativePath.replaceAll("\\", "/");
    if (!scan || scan.expiresAt <= Date.now() || !scan.videoPaths.has(normalizedRelativePath)) {
      throw new Error("请先扫描并选择该文件夹中的视频");
    }
    const source = await resolveFolderVideoSource(root, normalizedRelativePath);
    mime = source.mime;
    size = source.size;
    entry = { kind: "folder", root, relativePath };
  }
  const token = newMediaToken(entry);
  return json({ url: `/api/media/${token}`, mime, size });
}

async function serveMediaToken(request: Request, token: string): Promise<Response> {
  pruneMediaTokens();
  const entry = mediaTokens.get(token);
  if (!entry) return errorResponse("视频预览已关闭或过期，请重新打开。", 404);
  let source: { path: string; mime: string; size: number };
  try {
    if (entry.kind === "asset") {
      const currentProjectId = desktop.context.project?.project?.id;
      if (entry.projectId !== currentProjectId || !entry.assetId) {
        mediaTokens.delete(token);
        return errorResponse("课程项目已切换，请重新打开视频。", 410);
      }
      source = await resolveProjectVideoSource(entry.assetId);
    } else {
      source = await resolveFolderVideoSource(entry.root || "", entry.relativePath || "");
    }
    entry.expiresAt = Date.now() + MEDIA_TOKEN_TTL_MS;
    return await fileRangeResponse(source.path, source.mime, request);
  } catch (caught) {
    mediaTokens.delete(token);
    return errorResponse(caught, 404);
  }
}

function trustedApiRequest(request: Request, url: URL): boolean {
  const host = String(request.headers.get("host") || "").toLowerCase();
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname.toLowerCase()) ||
    url.port !== String(port) || ![`localhost:${port}`, `127.0.0.1:${port}`].includes(host)) return false;
  const origin = request.headers.get("origin");
  if (["POST", "DELETE"].includes(request.method) && !origin) return false;
  return !origin || origin === url.origin;
}

async function staticFile(pathname: string): Promise<Response> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  if (
    !relativePath || relativePath.includes("..") || relativePath.includes("\\")
  ) {
    return new Response("Not found", { status: 404 });
  }
  const target = normalize(join(appRoot, relativePath));
  const inside = relative(appRoot, target);
  if (inside.startsWith("..") || inside.includes("/../")) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const file = await Deno.readFile(target);
    return new Response(file, {
      headers: {
        "content-type": contentType(relativePath),
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

const server = Deno.serve(
  { hostname: "127.0.0.1", port },
  async (request) => {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/") && !trustedApiRequest(request, url)) {
        return errorResponse("仅允许本机工作台页面访问此服务。", 403);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": url.origin,
            "access-control-allow-methods": "GET,HEAD,POST,DELETE,OPTIONS",
            "access-control-allow-headers": "content-type",
            "vary": "origin",
          },
        });
      }
      if (url.pathname === "/api/status" && request.method === "GET") {
        return json({
          mode: "service",
          project_open: desktop.context.project !== null,
          project_root: projectRoot,
        });
      }
      if (url.pathname === "/api/session" && ["GET", "POST"].includes(request.method)) {
        return await bridgeSession(request);
      }
      if (url.pathname === "/api/session/open" && request.method === "POST") {
        return await bridgeSessionOpen(request);
      }
      if (url.pathname === "/api/command" && request.method === "POST") {
        return await bridgeCommand(request);
      }
      if (url.pathname === "/api/query" && request.method === "POST") {
        return await bridgeQuery(request);
      }
      if (url.pathname === "/api/asset" && request.method === "POST") {
        return await bridgeAssetBytes(request);
      }
      const exportDownload = /^\/api\/export-file\/([a-f0-9]{32})\/(\d+)$/.exec(url.pathname);
      if (exportDownload && request.method === "GET") {
        return await exportDownloadResponse(
          exportDownload[1]!,
          Number(exportDownload[2]),
          request.signal,
        );
      }
      if (url.pathname === "/api/media-source" && request.method === "POST") {
        return await createMediaSource(request);
      }
      const mediaToken = /^\/api\/media\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
      if (mediaToken && request.method === "DELETE") {
        mediaTokens.delete(mediaToken);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      if (mediaToken && ["GET", "HEAD"].includes(request.method)) {
        return await serveMediaToken(request, mediaToken);
      }
      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
        });
      }
      return await staticFile(url.pathname);
    } catch (caught) {
      return errorResponse(caught, caught instanceof MediaTokenCapacityError ? 429 : 400);
    }
  },
);

const shutdown = () => {
  void server.shutdown();
};
const shutdownSignals: Array<"SIGINT" | "SIGTERM"> = [];
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(signal, shutdown);
    shutdownSignals.push(signal);
  } catch {
    // Some embedded hosts do not grant signal handling; server.finished still
    // owns the normal service cleanup path.
  }
}
// Windows has no SIGTERM, so a supervising parent needs another way to ask
// for a graceful stop. With WORKBENCH_SHUTDOWN_ON_STDIN_EOF=1 the service
// treats its closed stdin as that request and runs the same clean shutdown
// path (HTTP stop + DesktopService close) as SIGTERM on POSIX.
if (Deno.env.get("WORKBENCH_SHUTDOWN_ON_STDIN_EOF") === "1") {
  void (async () => {
    try {
      for await (const _chunk of Deno.stdin.readable) {
        // Drain: the parent may write before closing; EOF is the signal.
      }
    } catch {
      // stdin may already be gone; either way the request is "stop now".
    }
    shutdown();
  })();
}
try {
  await server.finished;
} finally {
  for (const signal of shutdownSignals) {
    Deno.removeSignalListener(signal, shutdown);
  }
  await desktop.close();
}
