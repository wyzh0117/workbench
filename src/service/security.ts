import { isAbsolute, join, normalize, relative } from "node:path";
import type { ProjectData } from "../domain/types.ts";
import { id } from "../domain/util.ts";
import { error, ServiceError } from "./errors.ts";

const KEYCHAIN_COMMAND = "/usr/bin/security";
const KEYCHAIN_SERVICE = "com.ai-course-workbench.ai";
const KEYCHAIN_ACCOUNT_PREFIX = "provider:";

function keychainFailure(operation: string): ServiceError {
  const userMessage = operation === "delete"
    ? "无法访问 macOS 系统钥匙串，API Key 没有删除。"
    : operation === "get"
    ? "无法访问 macOS 系统钥匙串，无法确认 API Key 是否已配置。"
    : "无法访问 macOS 系统钥匙串，API Key 没有保存。";
  return error(
    "keychain_unavailable",
    userMessage,
    `系统钥匙串操作失败（${operation}）`,
    {
      recoverable: true,
      recommended_action: "确认已登录 macOS 钥匙串并重试；课程文件未被修改。",
      details: { operation },
    },
  );
}

function keychainAccount(provider: string, accountPrefix: string): string {
  const value = provider.trim();
  if (!value || /[\r\n]/.test(value)) throw keychainFailure("invalid-account");
  return `${accountPrefix}${value}`;
}

/**
 * macOS Keychain-backed secret store used by the local browser service and by
 * generic service commands.  The `security` CLI is invoked with argv arrays;
 * writes are supplied on stdin so the value is never placed in process argv.
 * Tests must inject `MemorySecretStore` (or another SecretStore) instead.
 */
export class MacKeychainSecretStore implements SecretStore {
  readonly service: string;
  readonly accountPrefix: string;
  private readonly knownProviders = new Set<string>();

  constructor(options: { service?: string; accountPrefix?: string } = {}) {
    this.service = options.service?.trim() || KEYCHAIN_SERVICE;
    this.accountPrefix = options.accountPrefix?.trim() || KEYCHAIN_ACCOUNT_PREFIX;
  }

  private ensureSupported(): void {
    if (Deno.build.os !== "darwin") throw keychainFailure("unsupported-platform");
  }

  private async run(
    args: string[],
    input?: string,
  ): Promise<{ code: number; stdout: string }> {
    this.ensureSupported();
    try {
      const command = new Deno.Command(KEYCHAIN_COMMAND, {
        args,
        stdin: input === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
      });
      const child = command.spawn();
      if (input !== undefined) {
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(`${input}\n`));
        await writer.close();
      }
      const output = await child.output();
      return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
      };
    } catch {
      // Do not return security(1)'s stderr: it can contain user/keychain
      // metadata and is not actionable at the renderer boundary.
      throw keychainFailure("process");
    }
  }

  async set(provider: string, value: string): Promise<void> {
    if (!value) throw error("secret_invalid", "凭据不能为空。", "Empty secret rejected", {
      recoverable: false,
      recommended_action: null,
      details: {},
    });
    const account = keychainAccount(provider, this.accountPrefix);
    const result = await this.run([
      "add-generic-password",
      "-a",
      account,
      "-s",
      this.service,
      "-U",
      "-w",
    ], value);
    if (result.code !== 0) throw keychainFailure("set");
    this.knownProviders.add(provider.trim());
  }

  async get(provider: string): Promise<string | null> {
    const account = keychainAccount(provider, this.accountPrefix);
    const result = await this.run([
      "find-generic-password",
      "-a",
      account,
      "-s",
      this.service,
      "-w",
    ]);
    // `security` uses status 44 when no matching generic password exists.
    if (result.code === 44) return null;
    if (result.code !== 0) throw keychainFailure("get");
    const value = result.stdout.trim();
    if (value.length > 0) this.knownProviders.add(provider.trim());
    return value.length > 0 ? value : null;
  }

  async delete(provider: string): Promise<void> {
    const account = keychainAccount(provider, this.accountPrefix);
    const result = await this.run([
      "delete-generic-password",
      "-a",
      account,
      "-s",
      this.service,
    ]);
    if (result.code !== 0 && result.code !== 44) throw keychainFailure("delete");
    this.knownProviders.delete(provider.trim());
  }

  async listProviders(): Promise<string[]> {
    // The security CLI does not provide a safe, stable machine-readable list
    // for a service. Return only accounts this process has explicitly used;
    // callers also query provider metadata after a restart.
    return [...this.knownProviders];
  }
}

/** Provider-scoped secret boundary; production implementations must be system-secure. */
export interface SecretStore {
  set(provider: string, value: string): Promise<void>;
  get(provider: string): Promise<string | null>;
  delete(provider: string): Promise<void>;
  listProviders(): Promise<string[]>;
}

/** Injectable in-memory fake; production defaults to MacKeychainSecretStore. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  set(provider: string, value: string): Promise<void> {
    if (!provider.trim() || !value) {
      return Promise.reject(
        error("secret_invalid", "凭据不能为空。", "Empty secret rejected", {
          recoverable: false,
          recommended_action: null,
          details: {},
        }),
      );
    }
    this.values.set(provider, value);
    return Promise.resolve();
  }
  get(provider: string): Promise<string | null> {
    return Promise.resolve(this.values.get(provider) ?? null);
  }
  delete(provider: string): Promise<void> {
    this.values.delete(provider);
    return Promise.resolve();
  }
  listProviders(): Promise<string[]> {
    return Promise.resolve([...this.values.keys()]);
  }
  clear(): void {
    this.values.clear();
  }
}

// Match compound/camelCase keys too (for example `provider_api_key` and
// `authToken`) without treating legitimate names such as `style_tokens` as
// secrets. Export is a trust boundary, so a close key match is removed.
const SECRET_KEYS =
  /(?:^|[\s._-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|token|cookie|cookies|password|passphrase|secret|private[_-]?key|client[_-]?secret|authorization|credentials?|auth[_-]?reference|credential[_-]?reference)(?=$|[\s._-])/i;
const PRIVATE_KEYS =
  /(?:^|[\s._-])(?:recovery|secure[_-]?local|workspace(?:[_-]?local|[_-]?root)?|model[_-]?connections?|user[_-]?preferences?|cache|private[_-]?conversation[_-]?cache)(?=$|[\s._-])/i;
const CAMEL_KEY_TOKENS = [
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "bearertoken",
  "token",
  "cookie",
  "cookies",
  "password",
  "passphrase",
  "secret",
  "privatekey",
  "clientsecret",
  "authorization",
  "credential",
  "authreference",
  "credentialreference",
  "recovery",
  "securelocal",
  "workspace",
  "workspacelocal",
  "workspaceroot",
  "modelconnections",
  "userpreferences",
  "cache",
];

function isSensitiveKey(key: string): boolean {
  if (SECRET_KEYS.test(key) || PRIVATE_KEYS.test(key)) return true;
  const compact = key.replace(/[\s._-]/g, "");
  const lower = compact.toLowerCase();
  return CAMEL_KEY_TOKENS.some((token) => {
    let position = lower.indexOf(token);
    while (position >= 0) {
      const after = position + token.length;
      if (after === compact.length || /[A-Z]/.test(compact[after] ?? "")) {
        return true;
      }
      position = lower.indexOf(token, position + 1);
    }
    return false;
  });
}

function isAbsoluteLike(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\");
}

/** Remove credentials and workstation-specific paths from an export copy. */
export function sanitizeProjectForExport<T>(value: T): T {
  const sanitize = (candidate: unknown, key = ""): unknown => {
    if (isSensitiveKey(key)) return undefined;
    if (
      typeof candidate === "string" && isAbsoluteLike(candidate) &&
      /(?:path|file|directory|storage|export_path|workspace|root)/i.test(key)
    ) return undefined;
    if (Array.isArray(candidate)) {
      return candidate.map((item) => sanitize(item)).filter((item) =>
        item !== undefined
      );
    }
    if (!candidate || typeof candidate !== "object") return candidate;
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(candidate)) {
      const next = sanitize(child, childKey);
      if (next !== undefined) output[childKey] = next;
    }
    return output;
  };
  return sanitize(value) as T;
}

export function exportProjectJson(data: ProjectData): string {
  return JSON.stringify(sanitizeProjectForExport(data), null, 2) + "\n";
}

const DANGEROUS_TAGS =
  /<\/?(?:script|style|iframe|object|embed|form|base|meta|link)\b[^>]*>/gi;
const DANGEROUS_BLOCKS =
  /<(?:script|style|iframe|object|embed|form|base|meta|link)\b[^>]*>[\s\S]*?<\/(?:script|style|iframe|object|embed|form|base|meta|link)\s*>/gi;

/** Dependency-free sanitizer for pasted rich text and AI-generated markup. */
export function sanitizeHtml(input: string): string {
  let html = String(input ?? "").replace(DANGEROUS_BLOCKS, "").replace(
    DANGEROUS_TAGS,
    "",
  );
  html = html.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  const decodeUrlEntities = (value: string): string =>
    value
      .replace(/&colon;?|&#x0*3a;?|&#0*58;?/gi, ":")
      .replace(/&(?:newline|tab);?/gi, " ")
      .replace(/&#x([0-9a-f]+);?/gi, (_match, hex: string) => {
        const codePoint = Number.parseInt(hex, 16);
        return Number.isFinite(codePoint) && codePoint >= 0 &&
            codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : _match;
      })
      .replace(/&#([0-9]+);?/g, (_match, decimal: string) => {
        const codePoint = Number.parseInt(decimal, 10);
        return Number.isFinite(codePoint) && codePoint >= 0 &&
            codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : _match;
      });
  const isUnsafeUrl = (value: string): boolean => {
    const normalized = Array.from(decodeUrlEntities(value)).filter(
      (character) => {
        const code = character.codePointAt(0) ?? 0;
        return code > 0x20 && code !== 0x7f;
      },
    ).join("").toLowerCase();
    return /^(?:javascript|vbscript|data):/.test(normalized);
  };
  html = html.replace(
    /\s+(href|src|xlink:href|srcset|poster|action|formaction|background)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (_whole, name, _quoted, doubleValue, singleValue, bareValue) => {
      const url = String(doubleValue ?? singleValue ?? bareValue ?? "").trim();
      if (isUnsafeUrl(url)) return ` ${name}=""`;
      return ` ${name}="${url.replace(/"/g, "&quot;")}"`;
    },
  );
  return html.replace(/<!--(?:[\s\S]*?)-->/g, "");
}

export function sanitizeRichText(input: string): string {
  return sanitizeHtml(input);
}

export function sanitizeAIOutput(input: string): string {
  return sanitizeHtml(input);
}

export interface PermissionPolicy {
  project_root: string;
  capabilities: ReadonlySet<string>;
}

export function assertCapability(
  policy: PermissionPolicy,
  capability: string,
): void {
  if (!policy.capabilities.has(capability)) {
    throw error(
      "permission_denied",
      "当前窗口没有执行该操作的权限。",
      `Capability denied: ${capability}`,
      {
        recoverable: false,
        recommended_action: "请从拥有该权限的工作台入口执行。",
        details: {},
      },
    );
  }
}

export function assertProjectPath(
  policy: PermissionPolicy,
  candidate: string,
): string {
  const root = normalize(policy.project_root);
  const target = normalize(candidate);
  try {
    if (Deno.lstatSync(root).isSymlink) {
      throw error(
        "path_outside_project",
        "只能访问当前项目目录中的文件。",
        `Symlink project root rejected: ${root}`,
        { recoverable: false, recommended_action: null, details: {} },
      );
    }
  } catch (caught) {
    if (caught instanceof ServiceError) throw caught;
    if (!(caught instanceof Deno.errors.NotFound)) throw caught;
  }
  const rel = relative(root, target);
  if (
    rel === ".." ||
    rel.startsWith(`..${candidate.includes("\\") ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw error(
      "path_outside_project",
      "只能访问当前项目目录中的文件。",
      `Path outside project root: ${candidate}`,
      { recoverable: false, recommended_action: null, details: {} },
    );
  }
  let cursor = root;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if (Deno.lstatSync(cursor).isSymlink) {
        throw error(
          "path_outside_project",
          "只能访问当前项目目录中的文件。",
          `Symlink path outside project root: ${candidate}`,
          { recoverable: false, recommended_action: null, details: {} },
        );
      }
    } catch (caught) {
      if (caught instanceof ServiceError) throw caught;
      if (caught instanceof Deno.errors.NotFound) break;
      throw caught;
    }
  }
  return target;
}

export const BRIDGE_ACTIONS = [
  "capturePage",
  "sendSelection",
  "health",
] as const;
export interface BridgePolicy {
  host: "127.0.0.1";
  token: string;
  allowed_origins: readonly string[];
  allowed_extension_ids: readonly string[];
  allowed_actions: readonly string[];
}

export interface BridgeRequest {
  token: string;
  origin?: string | null;
  extension_id?: string | null;
  action: string;
}

export function createBridgePolicy(
  input: Partial<Omit<BridgePolicy, "host" | "token">> = {},
): BridgePolicy {
  const requestedActions = input.allowed_actions ?? [...BRIDGE_ACTIONS];
  const allowed_actions = requestedActions.filter((
    action,
  ): action is typeof BRIDGE_ACTIONS[number] =>
    BRIDGE_ACTIONS.includes(action as typeof BRIDGE_ACTIONS[number])
  );
  return {
    host: "127.0.0.1",
    token: id(),
    allowed_origins: input.allowed_origins ?? [],
    allowed_extension_ids: input.allowed_extension_ids ?? [],
    allowed_actions,
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let result = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    result |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return result === 0;
}

export function authorizeBridgeRequest(
  policy: BridgePolicy,
  request: BridgeRequest,
): void {
  if (!constantTimeEqual(policy.token, request.token)) {
    throw error(
      "bridge_unauthorized",
      "浏览器连接未获授权。",
      "Bridge token mismatch",
      {
        recoverable: false,
        recommended_action: "重新配对浏览器连接。",
        details: {},
      },
    );
  }
  if (!policy.allowed_origins.length && !policy.allowed_extension_ids.length) {
    throw error(
      "bridge_allowlist_empty",
      "浏览器连接尚未完成授权。",
      "Bridge origin/extension allowlist is empty",
      {
        recoverable: false,
        recommended_action: "先完成浏览器连接配对。",
        details: {},
      },
    );
  }
  if (
    policy.allowed_origins.length &&
    !policy.allowed_origins.includes(request.origin ?? "")
  ) {
    throw error(
      "bridge_origin_denied",
      "该浏览器来源未获授权。",
      "Bridge origin not allowlisted",
      { recoverable: false, recommended_action: null, details: {} },
    );
  }
  if (
    policy.allowed_extension_ids.length &&
    !policy.allowed_extension_ids.includes(request.extension_id ?? "")
  ) {
    throw error(
      "bridge_extension_denied",
      "该浏览器扩展未获授权。",
      "Bridge extension not allowlisted",
      { recoverable: false, recommended_action: null, details: {} },
    );
  }
  if (!policy.allowed_actions.includes(request.action)) {
    throw error(
      "bridge_action_denied",
      "该浏览器操作未获授权。",
      `Bridge action not allowlisted: ${request.action}`,
      { recoverable: false, recommended_action: null, details: {} },
    );
  }
}
