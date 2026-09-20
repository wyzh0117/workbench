import { join, normalize, relative } from "node:path";
import { HIGH_LEVEL_COMMANDS, READ_QUERIES } from "../src/service/commands.ts";
import { DesktopService } from "../src/service/desktop.ts";

const appRoot = normalize(new URL("../app/", import.meta.url).pathname);
// The browser build intentionally exposes one project root selected by the
// launcher. The renderer never receives arbitrary filesystem access.
const projectRoot = join(Deno.cwd(), ".workbench-project");
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

function errorResponse(message: string, status = 400): Response {
  return json({
    error: {
      code: "bridge_request_failed",
      user_message: message,
      recoverable: true,
      recommended_action: "检查输入后重试。",
    },
  }, status);
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
    return errorResponse(caught instanceof Error ? caught.message : "查询失败");
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
  { hostname: "127.0.0.1", port: 4173 },
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
          project_root: ".workbench-project",
        });
      }
      if (url.pathname === "/api/command" && request.method === "POST") {
        return await bridgeCommand(request);
      }
      if (url.pathname === "/api/query" && request.method === "POST") {
        return await bridgeQuery(request);
      }
      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
        });
      }
      return await staticFile(url.pathname);
    } catch (caught) {
      return errorResponse(
        caught instanceof Error ? caught.message : "请求失败",
        400,
      );
    }
  },
);

try {
  await server.finished;
} finally {
  await desktop.close();
}
