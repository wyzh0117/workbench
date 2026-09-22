import { join, normalize, relative } from "node:path";
import { asErrorObject } from "../src/service/errors.ts";
import { HIGH_LEVEL_COMMANDS, READ_QUERIES } from "../src/service/commands.ts";
import { DesktopService } from "../src/service/desktop.ts";

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
        "access-control-allow-origin": "*",
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
    await desktop.saveBrowserSession(body.session);
    return json({ value: null });
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
  return json({ value: execution.value, execution_id: execution.id });
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
      return errorResponse("素材过大，无法在工作台内预览。", 413);
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
        "access-control-allow-origin": "*",
      },
    });
  } catch {
    return errorResponse("素材文件不可读。", 404);
  }
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
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "content-type",
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
      if (url.pathname === "/api/command" && request.method === "POST") {
        return await bridgeCommand(request);
      }
      if (url.pathname === "/api/query" && request.method === "POST") {
        return await bridgeQuery(request);
      }
      if (url.pathname === "/api/asset" && request.method === "POST") {
        return await bridgeAssetBytes(request);
      }
      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
        });
      }
      return await staticFile(url.pathname);
    } catch (caught) {
      return errorResponse(caught, 400);
    }
  },
);

try {
  await server.finished;
} finally {
  await desktop.close();
}
