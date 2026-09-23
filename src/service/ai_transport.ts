/**
 * Browser-shell AI transport (V0-T03 Workstream B).
 *
 * The renderer never sees an API key.  `app/ai.js` picks the provider URL and
 * the request shape, then this module performs the single HTTPS POST and
 * injects the stored credential as the configured auth header.  Provider
 * semantics stay in one place (`app/ai.js`); this file only knows how to send
 * one request and how to map the answer back to a structured result.
 *
 * Non-canonical local state, never part of `project.json` and never exported:
 *   <project>/.workspace/ai/providers.json    provider metadata only
 *   <project>/.workspace/ai/executions.json   bounded execution log (max 200)
 * Credentials are held by macOS Keychain; historical plaintext values are
 * migrated once and removed only after verified Keychain storage succeeds.
 *
 * The JSON shapes are shared with the native (Rust) transport so the two
 * shells stay interchangeable.
 */

import { createHash } from "node:crypto";
import { dirname, join, normalize } from "node:path";
import { id } from "../domain/util.ts";
import { error, redactSecrets, ServiceError } from "./errors.ts";
import {
  MacKeychainSecretStore,
  type SecretStore,
} from "./security.ts";

/** Provider configuration the page may persist.  Never contains a credential. */
export interface AiProviderConfig {
  id: string;
  label?: string;
  kind?: string;
  base_url?: string;
  chat_path?: string;
  auth_header?: string;
  auth_scheme?: string;
  default_model?: string;
  models?: string[];
  [field: string]: unknown;
}

export interface AiConnectionList {
  providers: AiProviderConfig[];
  /** Presence only (`{ provider_id: true }`); a credential value is never returned. */
  configured: Record<string, boolean>;
}

/** Design §3 transport result. */
export interface AiTransportResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  response_kind: "json" | "stream";
}

export interface AiRequestInput {
  request_id?: string;
  provider_id?: string;
  url?: string;
  auth?: { header?: string; scheme?: string } | null;
  headers?: Record<string, string>;
  body?: unknown;
  timeout_ms?: number;
}

export type AiFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AiTransportOptions {
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetch?: AiFetch;
  /** Directory holding provider metadata / executions. */
  ai_home?: string;
  /** Shared in-flight registry so `ai.cancel` keeps working across projects. */
  requests?: Map<string, AbortController>;
  /** System-secure credential backend; tests inject an isolated fake store. */
  credential_store?: SecretStore;
  read_only?: boolean;
  max_records?: number;
}

export interface AiExecutionRecord {
  id?: string;
  instruction?: string;
  [field: string]: unknown;
}

const PROVIDERS_FILE = "providers.json";
const EXECUTIONS_FILE = "executions.json";
const WORKSPACE_DIRECTORY = ".workspace";
const AI_DIRECTORY = "ai";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** A short excerpt is enough to debug a provider failure and cheap to scrub. */
const MAX_ERROR_DETAIL_CHARS = 120;

const MAX_PROVIDERS = 50;
const MAX_PROVIDER_BYTES = 8 * 1024;
const MAX_PROVIDER_DEPTH = 4;
const MAX_PROVIDERS_FILE_BYTES = 1024 * 1024;

const MAX_EXECUTIONS = 200;
const MAX_EXECUTIONS_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_INSTRUCTION_CHARS = 2000;
const MAX_RECORD_STRING_CHARS = 20_000;
const MAX_RECORD_DEPTH = 8;
const MAX_RECORDS_BYTES = 4 * 1024 * 1024;

/**
 * Credential-shaped field names, exactly the rule the native shell applies
 * (`sensitive_key` in `src-tauri/src/lib.rs`).  Both transports must reject the
 * same payloads or a configuration that works in the browser shell would hard
 * fail in the desktop shell.
 */
const CREDENTIAL_FIELD = /key|token|secret|credential|password|authorization/i;
const DANGEROUS_FIELDS = new Set(["__proto__", "constructor", "prototype"]);
const SAFE_PROVIDER_FIELDS =
  "id / label / kind / base_url / chat_path / auth_header / auth_scheme / default_model / models";
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const defaultAiFetch: AiFetch = (input, init) => fetch(input, init);

function isNotFound(caught: unknown): boolean {
  return caught instanceof Deno.errors.NotFound ||
    (caught instanceof Error && "code" in caught &&
      (caught as { code?: string }).code === "ENOENT");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messageOf(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  return String(caught ?? "未知错误");
}

const REDACTED = "[REDACTED]";

/** Below this length an exact-value replace mangles ordinary prose. */
const MIN_EXACT_SECRET_CHARS = 4;
/**
 * Credential-shaped opaque runs (base64, hex, reversed, or an unknown scheme).
 * A run must also carry a digit or an uppercase letter: real key spellings do,
 * while ordinary identifiers (`deepseek-reasoner`) and prose do not.  The
 * value-aware transform check below covers the rare all-lowercase, digit-free
 * key whose reversed spelling this rule alone would miss.
 */
const OPAQUE_RUN = /[A-Za-z0-9+/=_-]{16,}/g;

/**
 * Remove the exact credential the transport injected from provider-derived
 * text.  A provider may echo the request (headers, url, body) in its error
 * payload, so the strongest scrub is the one that knows the value: the raw
 * secret and the `scheme + " " + secret` form are both replaced.  Short values
 * are left to the labelled pass in `errors.ts` — replacing a 1-2 character
 * secret would shred every word containing it.
 */
export function scrubCredentialText(
  text: string,
  secrets: readonly string[],
): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length < MIN_EXACT_SECRET_CHARS) continue;
    output = output.split(secret).join(REDACTED);
  }
  return output;
}

function opaqueRuns(text: string): string {
  return text.replace(
    OPAQUE_RUN,
    (run) => /[0-9A-Z]/.test(run) ? REDACTED : run,
  );
}

/** Punctuation and whitespace removed, so a split credential becomes visible. */
function compactSecretText(text: string): string {
  return text.replace(/[^A-Za-z0-9]/g, "");
}

/** Shortest key fragment that must still be treated as part of the key. */
const MIN_SPLIT_FRAGMENT_CHARS = 8;

/** Spellings a provider may use to echo the key without it looking like a key.
 * The plain value is excluded: it is removed exactly, in place. */
function encodedSecretForms(secret: string): string[] {
  const forms = new Set<string>();
  forms.add(Array.from(secret).reverse().join(""));
  try {
    forms.add(btoa(secret));
  } catch {
    // Values outside latin1 have no such base64 spelling.
  }
  forms.add(
    Array.from(new TextEncoder().encode(secret))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );
  forms.delete(secret);
  return [...forms].filter((form) => form.length > 0);
}

/**
 * True when the text carries the credential transformed — split across it
 * (`sk-v0t03-do` … `-not-leak-9f8e7d6c`), reversed, base64- or hex-encoded.
 * Exact replacement cannot see any of those, and no excerpt of such a body can
 * be kept safely, so the caller drops the whole excerpt.
 */
function containsTransformedSecret(
  text: string,
  secrets: readonly string[],
): boolean {
  const compact = compactSecretText(text);
  if (compact.length === 0) return false;
  for (const secret of secrets) {
    const compactSecret = compactSecretText(secret);
    if (compactSecret.length < MIN_SPLIT_FRAGMENT_CHARS) continue;
    for (const form of encodedSecretForms(secret)) {
      if (text.includes(form) || compact.includes(compactSecretText(form))) {
        return true;
      }
    }
    const fragment = Math.max(
      MIN_SPLIT_FRAGMENT_CHARS,
      Math.ceil(compactSecret.length / 2),
    );
    for (
      let start = 0;
      start + fragment <= compactSecret.length;
      start += 1
    ) {
      if (compact.includes(compactSecret.slice(start, start + fragment))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Decode the escape spellings a provider body (or a JSON payload inside it) may
 * use, so `\u0073\u006b…`, `\x73\x6b…` and `%73%6b…` are compared as the text
 * they represent rather than as harmless punctuation.
 */
function normalizeProviderText(text: string): string {
  let output = text;
  try {
    output = decodeURIComponent(output);
  } catch {
    // A stray `%` is not percent-encoding; keep the text as it arrived.
  }
  return output.replace(
    /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([nrt"\\/]))/g,
    (match, unicode: string | undefined, hex: string | undefined, simple) => {
      if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      if (simple === "n") return "\n";
      if (simple === "r") return "\r";
      if (simple === "t") return "\t";
      return typeof simple === "string" ? simple : match;
    },
  );
}

/**
 * Full scrub for text that came from outside the process (a provider error
 * body, a fetch error quoting the url).  Layers, in order: decode escapes,
 * replace the exact stored credential, apply the labelled/shape rules from
 * `errors.ts`, then redact any remaining opaque run.  A provider that echoes
 * the key base64-, hex-, reversed- or escape-encoded cannot survive all four,
 * and a body that merely splits the key in two is dropped entirely.
 */
export function scrubProviderText(
  text: string,
  secrets: readonly string[],
): string {
  if (containsTransformedSecret(text, secrets)) return REDACTED;
  const exact = scrubCredentialText(normalizeProviderText(text), secrets);
  return opaqueRuns(String(redactSecrets(exact)));
}

/**
 * Scrub free text the user or the page supplied (an instruction, an error
 * message) before it is persisted.  No exact values are needed: the labelled
 * rules cover `api_key=…` / `Bearer …` / `sk-…`, and opaque runs cover encoded
 * spellings.
 */
export function scrubFreeText(
  text: string,
  secrets: readonly string[] = [],
): string {
  return opaqueRuns(String(redactSecrets(scrubCredentialText(text, secrets))));
}

/** Never let the effective request url (which may carry a key) be persisted. */
function stripRequestUrl(text: string, url: URL | null): string {
  if (!url) return text;
  const forms = [
    url.href,
    `${url.origin}${url.pathname}`,
    `${url.origin}${url.pathname}/`,
  ];
  let output = text;
  for (const form of forms) {
    if (!form) continue;
    output = output.split(form).join("<url>");
  }
  return output;
}

function bodyKind(contentType: string): "json" | "html" | "text" {
  const value = contentType.toLowerCase();
  if (value.includes("html")) return "html";
  if (value.includes("json")) return "json";
  return "text";
}

function scrubCredentialValue(
  value: unknown,
  secrets: readonly string[],
): unknown {
  if (typeof value === "string") return scrubCredentialText(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => scrubCredentialValue(item, secrets));
  }
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = scrubCredentialValue(child, secrets);
  }
  return output;
}

/**
 * Last-resort backstop around every transport failure.  Even a message this
 * module did not author (a fetch/DNS/TLS error quoting the url, or a provider
 * body) is re-scrubbed before it can reach the renderer, the audit log or
 * `.workspace/diagnostics`.
 */
function scrubTransportFailure(
  caught: unknown,
  secrets: readonly string[],
): unknown {
  if (secrets.length === 0) return caught;
  if (caught instanceof ServiceError) {
    return new ServiceError({
      code: caught.error.code,
      user_message: scrubCredentialText(caught.error.user_message, secrets),
      technical_message: scrubCredentialText(
        caught.error.technical_message,
        secrets,
      ),
      severity: caught.error.severity,
      recoverable: caught.error.recoverable,
      recommended_action: caught.error.recommended_action === null
        ? null
        : scrubCredentialText(caught.error.recommended_action, secrets),
      details: scrubCredentialValue(caught.error.details, secrets) as Record<
        string,
        unknown
      >,
    });
  }
  if (caught instanceof Error) {
    const message = scrubCredentialText(caught.message, secrets);
    if (message === caught.message) return caught;
    const replacement = new Error(message);
    replacement.name = caught.name;
    return replacement;
  }
  return caught;
}

/**
 * Every spelling of a credential this transport must be able to remove: the
 * `scheme + " " + value` header form and the bare value.  Built whenever a
 * credential is stored for the provider, even when no auth header is injected,
 * because a saved `base_url` may itself carry the key in its query string.
 * Order matters only for cosmetics: the longest form must win first.
 */
function credentialScrubList(
  secret: string,
  scheme: string,
): string[] {
  const forms = scheme ? [`${scheme} ${secret}`, secret] : [secret];
  return forms.filter((form, index) => form.length > 0 && forms.indexOf(form) === index)
    .sort((left, right) => right.length - left.length);
}

function invalidRequest(
  userMessage: string,
  technicalMessage: string,
  recommendedAction: string | null = null,
): ServiceError {
  return error("invalid_request", userMessage, technicalMessage, {
    recoverable: true,
    recommended_action: recommendedAction,
    details: {},
  });
}

function notConfigured(
  userMessage: string,
  technicalMessage: string,
): ServiceError {
  return error("not_configured", userMessage, technicalMessage, {
    recoverable: true,
    recommended_action: "在 AI 面板中选择并保存一个服务商后重试。",
    details: {},
  });
}

/** Clone a JSON value while dropping prototype-polluting field names. */
function cloneJsonValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_PROVIDER_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => cloneJsonValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (!isPlainRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_FIELDS.has(key)) continue;
    const cloned = cloneJsonValue(child, depth + 1);
    if (cloned !== undefined) output[key] = cloned;
  }
  return output;
}

/** Reject credentials (and non-JSON values) hidden anywhere in a config. */
function findForbiddenField(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenField(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const field = path ? `${path}.${key}` : key;
    if (DANGEROUS_FIELDS.has(key) || CREDENTIAL_FIELD.test(key)) return field;
    const found = findForbiddenField(child, field);
    if (found) return found;
  }
  return null;
}

/** Query-string API keys are secrets even when the containing field is `base_url`. */
function findInlineCredentialField(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findInlineCredentialField(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const field = path ? `${path}.${key}` : key;
    if (typeof child === "string" && key === "base_url") {
      const query = child.split("?", 2)[1]?.split("#", 1)[0] ?? "";
      for (const part of query.split("&")) {
        const [name, rawValue] = part.split("=", 2);
        if (!name || !rawValue) continue;
        let decodedName = name;
        try {
          decodedName = decodeURIComponent(name);
        } catch {
          // An invalid query escape is still treated as ordinary metadata here;
          // URL validation will report it at request time without echoing it.
        }
        if (CREDENTIAL_FIELD.test(decodedName)) {
          return `${field}[query:${decodedName}]`;
        }
      }
    }
    const found = findInlineCredentialField(child, field);
    if (found) return found;
  }
  return null;
}

function assertJsonOnly(value: unknown, depth = 0): void {
  if (depth > MAX_PROVIDER_DEPTH) {
    throw invalidRequest(
      "服务商配置层级过深，无法保存。",
      "Provider config exceeds the supported nesting depth",
    );
  }
  if (value === undefined || value === null) return;
  const type = typeof value;
  if (type === "function" || type === "symbol" || type === "bigint") {
    throw invalidRequest(
      "服务商配置包含无法保存的值。",
      `Provider config contains a non-JSON value of type ${type}`,
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonOnly(item, depth + 1);
    return;
  }
  if (isPlainRecord(value)) {
    for (const child of Object.values(value)) assertJsonOnly(child, depth + 1);
  }
}

function isSafeProviderId(value: string): boolean {
  return PROVIDER_ID_PATTERN.test(value) && !DANGEROUS_FIELDS.has(value);
}

/** Validate and normalise one provider config coming from the renderer. */
export function normalizeProviderConfig(value: unknown): AiProviderConfig {
  if (!isPlainRecord(value)) {
    throw invalidRequest(
      "服务商配置格式无效。",
      "ai.connection.save expects a provider object",
      `请提交 id、${SAFE_PROVIDER_FIELDS} 等字段。`,
    );
  }
  const providerId = typeof value.id === "string" ? value.id.trim() : "";
  if (!isSafeProviderId(providerId)) {
    throw invalidRequest(
      "服务商配置缺少合法的 id。",
      `Invalid provider id: ${JSON.stringify(value.id)}`,
      "请使用字母、数字、下划线或短横线组成的 id。",
    );
  }
  const forbidden = findForbiddenField(value);
  const inlineCredential = findInlineCredentialField(value);
  if (forbidden) {
    const leaf = forbidden.split(".").at(-1) ?? forbidden;
    const hint = leaf === "requires_credential"
      ? "「requires_credential」是界面元数据，请勿随配置提交（原生壳会把它当作凭据字段拒绝）。"
      : "密钥请通过「保存密钥」单独提交。";
    throw invalidRequest(
      `服务商配置中出现了不允许的字段「${forbidden}」。`,
      `Credential-shaped provider field rejected: ${forbidden}`,
      `${hint}允许的字段：${SAFE_PROVIDER_FIELDS}。`,
    );
  }
  if (inlineCredential) {
    throw invalidRequest(
      `服务商配置中出现了不允许的密钥查询参数「${inlineCredential}」。`,
      `Inline credential query parameter rejected: ${inlineCredential}`,
      "API Key 必须通过「保存密钥」单独提交。",
    );
  }
  assertJsonOnly(value);
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_PROVIDER_BYTES) {
    throw invalidRequest(
      "服务商配置过大，无法保存。",
      `Provider config exceeds ${MAX_PROVIDER_BYTES} bytes`,
    );
  }
  const cloned = cloneJsonValue(JSON.parse(serialized)) as AiProviderConfig;
  const normalized: AiProviderConfig = { ...cloned, id: providerId };
  for (const field of ["label", "kind", "base_url", "chat_path"] as const) {
    const candidate = normalized[field];
    if (candidate !== undefined && typeof candidate !== "string") {
      throw invalidRequest(
        `服务商配置字段「${field}」必须是文本。`,
        `Provider field ${field} must be a string`,
      );
    }
  }
  for (const field of ["auth_header", "auth_scheme", "default_model"] as const) {
    const candidate = normalized[field];
    if (candidate !== undefined && typeof candidate !== "string") {
      throw invalidRequest(
        `服务商配置字段「${field}」必须是文本。`,
        `Provider field ${field} must be a string`,
      );
    }
  }
  if (normalized.models !== undefined) {
    if (
      !Array.isArray(normalized.models) ||
      normalized.models.some((model) => typeof model !== "string")
    ) {
      throw invalidRequest(
        "服务商配置字段「models」必须是文本列表。",
        "Provider field models must be an array of strings",
      );
    }
  }
  return normalized;
}

/** Read one persisted provider entry; invalid entries are ignored. */
function coerceProviderEntry(value: unknown): AiProviderConfig | null {
  if (!isPlainRecord(value)) return null;
  if (findForbiddenField(value) || findInlineCredentialField(value)) return null;
  const providerId = typeof value.id === "string" ? value.id.trim() : "";
  if (!isSafeProviderId(providerId)) return null;
  try {
    return normalizeProviderConfig(value);
  } catch {
    return null;
  }
}

interface AiProvidersState {
  providers: AiProviderConfig[];
}

interface ParsedAiProvidersState extends AiProvidersState {
  /** Historical plaintext values only; consumed by one-time migration. */
  credentials: Record<string, string>;
  /** Unknown root fields are stripped so metadata cannot become a secret sink. */
  hasExtraFields: boolean;
  /** Historical provider entries are rewritten to the allow-listed shape. */
  providerMetadataChanged: boolean;
}

function normalizeProvidersState(value: unknown): ParsedAiProvidersState | null {
  if (!isPlainRecord(value)) return null;
  const rawProviders = value.providers;
  if (rawProviders !== undefined && !Array.isArray(rawProviders)) return null;
  const hasExtraFields = Object.keys(value).some((key) =>
    key !== "providers" && key !== "credentials"
  );
  const rawCredentials = value.credentials;
  if (rawCredentials !== undefined && !isPlainRecord(rawCredentials)) return null;
  const providers: AiProviderConfig[] = [];
  for (const entry of rawProviders ?? []) {
    const provider = coerceProviderEntry(entry);
    if (provider) providers.push(provider);
    if (providers.length >= MAX_PROVIDERS) break;
  }
  const providerMetadataChanged = rawProviders !== undefined &&
    JSON.stringify(rawProviders) !== JSON.stringify(providers);
  const credentials: Record<string, string> = {};
  for (const [key, child] of Object.entries(rawCredentials ?? {})) {
    if (!isSafeProviderId(key)) continue;
    if (typeof child === "string" && child.length > 0) credentials[key] = child;
  }
  return { providers, credentials, hasExtraFields, providerMetadataChanged };
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  const source = response?.headers;
  if (source && typeof source.forEach === "function") {
    source.forEach((value, key) => {
      headers[String(key).toLowerCase()] = String(value);
    });
  }
  return headers;
}

async function writeBytesSyncSafe(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const file = await Deno.open(path, {
    create: true,
    truncate: true,
    write: true,
    mode: 0o600,
  });
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += await file.write(bytes.subarray(offset));
    }
    await file.sync();
  } finally {
    file.close();
  }
}

/** Best effort: platforms without POSIX modes simply ignore the call. */
async function chmodPrivate(path: string): Promise<void> {
  try {
    await Deno.chmod(path, 0o600);
  } catch {
    // Windows and some network filesystems cannot express POSIX modes.
  }
}

/**
 * Strip credentials and oversized text from an execution record.  The design's
 * record shape never needs a credential field, so a broad key match is safe.
 * Free text (`instruction`, `error_message`) is scrubbed too: a user can paste
 * a key into the instruction box, and it must not reach the executions file.
 */
export function sanitizeExecutionRecord(
  value: unknown,
  depth = 0,
  secrets: readonly string[] = [],
): Record<string, unknown> {
  const sanitized = sanitizeRecordValue(value, depth, secrets);
  return isPlainRecord(sanitized) ? sanitized : {};
}

/** Free-text fields that must survive a pasted credential. */
const FREE_TEXT_FIELDS = new Set(["instruction", "error_message"]);

function sanitizeRecordValue(
  value: unknown,
  depth: number,
  secrets: readonly string[],
): unknown {
  if (depth > MAX_RECORD_DEPTH) return {};
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRecordValue(item, depth + 1, secrets));
  }
  if (isPlainRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (DANGEROUS_FIELDS.has(key) || CREDENTIAL_FIELD.test(key)) continue;
      if (FREE_TEXT_FIELDS.has(key) && typeof child === "string") {
        const scrubbed = scrubFreeText(child, secrets);
        output[key] = key === "instruction"
          ? scrubbed.slice(0, MAX_INSTRUCTION_CHARS)
          : scrubbed;
        continue;
      }
      output[key] = sanitizeRecordValue(child, depth + 1, secrets);
    }
    return output;
  }
  if (typeof value === "string" && value.length > MAX_RECORD_STRING_CHARS) {
    return value.slice(0, MAX_RECORD_STRING_CHARS);
  }
  return value;
}

function boundRecords(
  records: Record<string, unknown>[],
  limit: number,
): Record<string, unknown>[] {
  let bounded = records.slice(Math.max(0, records.length - limit));
  while (
    bounded.length > 1 &&
    JSON.stringify(bounded).length > MAX_RECORDS_BYTES
  ) {
    bounded = bounded.slice(1);
  }
  return bounded;
}

function normalizeMaxRecords(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return MAX_EXECUTIONS;
  }
  return Math.min(Math.max(Math.round(value), 1), MAX_EXECUTIONS);
}

function projectKeychainPrefix(projectDirectory: string): string {
  // Scope browser-service credentials to the project without putting the
  // user's filesystem path in visible Keychain account metadata.
  const digest = createHash("sha256").update(projectDirectory).digest("hex");
  return `project-${digest.slice(0, 32)}:provider:`;
}

/**
 * AI transport + connection/credential/execution store for one project
 * directory.  Construct it per project; it never caches across directories.
 */
export class AiTransport {
  readonly projectDirectory: string;
  /** Directory holding `providers.json` and `executions.json`. */
  readonly home: string;
  private readonly fetchImpl: AiFetch;
  private readonly requestRegistry: Map<string, AbortController>;
  private readonly readOnly: boolean;
  private readonly recordLimit: number;
  private readonly credentialStore: SecretStore;

  constructor(projectDirectory: string, options: AiTransportOptions = {}) {
    this.projectDirectory = normalize(projectDirectory);
    const requestedHome = options.ai_home?.trim();
    this.home = normalize(
      requestedHome && requestedHome.length
        ? requestedHome
        : join(this.projectDirectory, WORKSPACE_DIRECTORY, AI_DIRECTORY),
    );
    this.fetchImpl = options.fetch ?? defaultAiFetch;
    this.requestRegistry = options.requests ?? new Map<string, AbortController>();
    this.readOnly = options.read_only === true;
    this.recordLimit = normalizeMaxRecords(options.max_records);
    this.credentialStore = options.credential_store ?? new MacKeychainSecretStore({
      accountPrefix: projectKeychainPrefix(this.projectDirectory),
    });
  }

  get providersPath(): string {
    return join(this.home, PROVIDERS_FILE);
  }

  get executionsPath(): string {
    return join(this.home, EXECUTIONS_FILE);
  }

  private assertWritable(): void {
    if (this.readOnly) {
      throw error(
        "read_only_project",
        "当前项目以只读方式打开，无法保存 AI 配置。",
        "Refusing to mutate system-secure AI credentials for a read-only project",
        {
          recoverable: false,
          recommended_action: "切换到编辑模式后重试。",
          details: {},
        },
      );
    }
  }

  // ---------------------------------------------------------------- connections

  /** Providers plus credential *presence*; never a credential value. */
  async listConnections(): Promise<AiConnectionList> {
    const state = await this.readProviders();
    const configured: Record<string, boolean> = {};
    for (const provider of state.providers) {
      configured[provider.id] = (await this.credentialStore.get(provider.id)) !== null;
    }
    return {
      providers: state.providers.map((provider) => structuredClone(provider)),
      configured,
    };
  }

  /** Insert or replace one provider config (upsert by `provider.id`). */
  async saveConnection(
    input: unknown,
  ): Promise<{ provider: AiProviderConfig }> {
    const candidate = isPlainRecord(input) && "provider" in input
      ? input.provider
      : input;
    const provider = normalizeProviderConfig(candidate);
    this.assertWritable();
    const state = await this.readProviders();
    const index = state.providers.findIndex((entry) =>
      entry.id === provider.id
    );
    if (index >= 0) state.providers.splice(index, 1, provider);
    else state.providers.push(provider);
    if (state.providers.length > MAX_PROVIDERS) {
      throw invalidRequest(
        `最多只能保存 ${MAX_PROVIDERS} 个 AI 服务商配置。`,
        `Provider list exceeds ${MAX_PROVIDERS}`,
        "先删除不再使用的服务商配置。",
      );
    }
    await this.writeProviders(state);
    return { provider: structuredClone(provider) };
  }

  /** Remove a provider config and any system-keychain credential stored for it. */
  async deleteConnection(
    providerId: string,
  ): Promise<{ provider_id: string; removed: boolean }> {
    const key = assertProviderId(providerId);
    this.assertWritable();
    const state = await this.readProviders();
    const before = state.providers.length;
    state.providers = state.providers.filter((entry) => entry.id !== key);
    const hadCredential = (await this.credentialStore.get(key)) !== null;
    if (hadCredential) await this.credentialStore.delete(key);
    const removed = state.providers.length !== before || hadCredential;
    if (removed) await this.writeProviders(state);
    return { provider_id: key, removed };
  }

  /** Store a credential in the system Keychain; the value is never returned. */
  async setCredential(
    providerId: string,
    value: string,
  ): Promise<{ provider_id: string }> {
    const key = assertProviderId(providerId);
    this.assertWritable();
    if (typeof value !== "string" || value.trim().length === 0) {
      throw invalidRequest(
        "密钥不能为空。",
        "Empty credential rejected",
        "请在 AI 面板中粘贴完整的 API Key。",
      );
    }
    const trimmed = value.trim();
    if (trimmed.length > 8192) {
      throw invalidRequest(
        "密钥过长，请确认粘贴的内容是否正确。",
        `Credential exceeds 8192 characters (${trimmed.length})`,
      );
    }
    const state = await this.readProviders();
    // Keychain write happens before metadata only-write. If metadata fails,
    // the key remains recoverable and no plaintext fallback is created.
    await this.credentialStore.set(key, trimmed);
    await this.writeProviders(state);
    return { provider_id: key };
  }

  async deleteCredential(
    providerId: string,
  ): Promise<{ provider_id: string; removed: boolean }> {
    const key = assertProviderId(providerId);
    this.assertWritable();
    await this.readProviders();
    const removed = (await this.credentialStore.get(key)) !== null;
    if (removed) await this.credentialStore.delete(key);
    return { provider_id: key, removed };
  }

  // ------------------------------------------------------------------ transport

  /**
   * P2-1: read the provider's own model list instead of shipping a table of
   * model names that goes stale.  The stored credential is injected exactly
   * like `ai.complete` does it — the renderer never sees the key — and a
   * provider that does not implement model enumeration fails with a readable
   * `ServiceError`, which the UI turns into manual Model ID entry.
   */
  async listAiModels(input: unknown): Promise<{
    provider_id: string;
    models: string[];
    endpoint: string;
  }> {
    if (!isPlainRecord(input)) {
      throw invalidRequest(
        "读取模型的参数无效。",
        "ai.models.list expects a JSON object",
      );
    }
    const candidate = input as { provider_id?: unknown; base_url?: unknown; timeout_ms?: unknown };
    const state = await this.readProviders();
    const providerId = typeof candidate.provider_id === "string"
      ? candidate.provider_id.trim()
      : "";
    const provider = providerId
      ? state.providers.find((entry) => entry.id === providerId)
      : undefined;
    if (!providerId || !provider) {
      throw notConfigured(
        "还没有选择 AI 服务商，无法读取模型列表。",
        "ai.models.list requires a saved provider",
      );
    }
    const credential = await this.credentialStore.get(providerId);
    if (!credential) {
      throw error(
        "missing_credential",
        `AI 服务商「${providerId}」还没有配置 API Key。`,
        `No credential stored for provider ${providerId}`,
        {
          recoverable: true,
          recommended_action: "先在设置里保存 API Key，再读取模型列表；也可以直接手动填写 Model ID。",
          details: { provider_id: providerId },
        },
      );
    }
    const baseUrl = typeof candidate.base_url === "string" && candidate.base_url.trim()
      ? candidate.base_url.trim()
      : String(provider.base_url || "").trim();
    if (!baseUrl) {
      throw invalidRequest(
        "还没有填写 Base URL，无法读取模型列表。",
        "ai.models.list has no base_url to query",
      );
    }
    const url = assertTransportUrl(modelListUrl(baseUrl));
    const header = typeof provider.auth_header === "string" && provider.auth_header.trim()
      ? provider.auth_header.trim()
      : "authorization";
    const scheme = typeof provider.auth_scheme === "string" ? provider.auth_scheme : "Bearer";
    const headers: Record<string, string> = {
      accept: "application/json",
      [header]: scheme ? `${scheme} ${credential}` : credential,
    };
    const schemeOnWire = typeof provider.auth_scheme === "string" ? provider.auth_scheme : "";
    const result = await this.send({
      requestId: id(),
      providerId,
      url,
      headers,
      body: "",
      method: "GET",
      timeoutMs: normalizeTimeout(candidate.timeout_ms),
      signal: null,
      secrets: credentialScrubList(credential, schemeOnWire),
      dropProviderExcerpt: credential.trim().length < MIN_EXACT_SECRET_CHARS,
    });
    const models = modelIdsFromPayload(result.body);
    if (!models.length) {
      throw error(
        "provider_error",
        "服务商没有返回可识别的模型名。",
        "ai.models.list response contained no model ids",
        {
          recoverable: true,
          recommended_action: "可以在设置里手动填写 Model ID，不影响保存与运行。",
          details: { provider_id: providerId, endpoint: url.toString() },
        },
      );
    }
    return { provider_id: providerId, models, endpoint: url.toString() };
  }

  /**
   * Design §3 `ai.complete`: one HTTPS POST with the stored credential injected
   * as the configured auth header.  Failures are structured `ServiceError`s so
   * the renderer can normalise them into `AiFailure`.
   */
  async completeAiRequest(
    input: unknown,
    options: { signal?: AbortSignal | null } = {},
  ): Promise<AiTransportResult> {
    if (!isPlainRecord(input)) {
      throw invalidRequest(
        "AI 请求参数无效。",
        "ai.complete expects a JSON object",
      );
    }
    const candidate = input as AiRequestInput;
    const state = await this.readProviders();
    const providerId = typeof candidate.provider_id === "string"
      ? candidate.provider_id.trim()
      : "";
    const provider = providerId
      ? state.providers.find((entry) => entry.id === providerId)
      : undefined;
    const storedCredential = providerId
      ? await this.credentialStore.get(providerId)
      : null;
    const storedCredentials = await this.credentialsForProviders(state.providers);
    const url = assertTransportUrl(this.resolveRequestUrl(candidate, state));
    const headers = normalizeHeaders(candidate.headers);
    const auth = normalizeAuth(candidate.auth);
    // Scrub from the system-stored credential, not only from the injected
    // header: a saved base_url can carry a key in its query string.
    const scheme = auth?.scheme ||
      (typeof provider?.auth_scheme === "string" ? provider.auth_scheme : "");
    const credentials = storedCredential
      ? credentialScrubList(storedCredential, scheme)
      : [];
    // A credential too short to replace exactly would shred ordinary words, so
    // while any such credential is stored no provider text is kept at all.
    const exactScrubUnsafe = storedCredentials.some((value) => {
      const trimmed = value.trim();
      return trimmed.length > 0 && trimmed.length < MIN_EXACT_SECRET_CHARS;
    });
    if (auth) {
      if (!providerId) {
        throw notConfigured(
          "尚未选择 AI 服务商，无法取出密钥。",
          "ai.complete requires provider_id when auth is requested",
        );
      }
      if (!storedCredential) {
        throw error(
          "missing_credential",
          `AI 服务商「${providerId}」还没有配置 API Key。`,
          `No credential stored for provider ${providerId}`,
          {
            recoverable: true,
            recommended_action: "在 AI 面板点击该服务商的「保存密钥」，填入 API Key 后重试。",
            details: { provider_id: providerId },
          },
        );
      }
      headers[auth.header] = auth.scheme
        ? `${auth.scheme} ${storedCredential}`
        : storedCredential;
    }
    const body = serializeBody(candidate.body);
    const timeoutMs = normalizeTimeout(candidate.timeout_ms);
    const requestId = typeof candidate.request_id === "string" &&
        candidate.request_id.trim().length > 0
      ? candidate.request_id.trim()
      : id();
    try {
      return await this.send({
        requestId,
        providerId,
        url,
        headers,
        body,
        timeoutMs,
        signal: options.signal ?? null,
        secrets: credentials,
        dropProviderExcerpt: exactScrubUnsafe,
      });
    } catch (caught) {
      // Whatever produced this failure (provider body, fetch error, url) must
      // not carry the credential any further.
      throw scrubTransportFailure(caught, credentials);
    }
  }

  /**
   * Abort an in-flight request.  An unknown or finished id is a no-op; this
   * command must never fail, because cancelling twice is normal UI behaviour.
   */
  cancelAiRequest(requestId: string): { cancelled: boolean } {
    const key = typeof requestId === "string" ? requestId.trim() : "";
    const controller = key ? this.requestRegistry.get(key) : undefined;
    if (!controller) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  }

  // ---------------------------------------------------------- execution records

  /**
   * Append one sanitised record, or replace it by `id` — append or replace by
   * id, never both.  A run is recorded once when it finishes and then updated
   * when the user reviews it (`pending` → `applied` / `rejected`), so an
   * id-keyed upsert keeps exactly one row per run instead of growing a second
   * row whose `pending` state could never resolve.  A replace keeps the first
   * match's position in the list, so the newest-first ordering callers see is
   * stable, and any further rows sharing that id are collapsed in the same pass
   * so a log written by the earlier append-only build heals itself.  Returns
   * the record id (minted when the record did not carry one).
   */
  async appendExecutionRecord(record: unknown): Promise<{ id: string }> {
    if (!isPlainRecord(record)) {
      throw this.executionFailure(
        new Error("execution record must be a JSON object"),
      );
    }
    // Every credential this project stores is scrubbed from the record's free
    // text, so a key pasted into the instruction box cannot reach the file.
    let scrubList: string[];
    try {
      scrubList = await this.storedCredentialScrubList();
    } catch (caught) {
      throw this.executionFailure(caught);
    }
    const sanitized = sanitizeExecutionRecord(record, 0, scrubList);
    const existingId = typeof sanitized.id === "string" ? sanitized.id.trim() : "";
    const recordId = existingId || id();
    sanitized.id = recordId;
    const records = await this.readExecutions();
    const index = existingId
      ? records.findIndex((entry) =>
        typeof entry.id === "string" && entry.id === recordId
      )
      : -1;
    if (index >= 0) {
      records.splice(index, 1, sanitized);
      // Walk backwards so removing a duplicate cannot shift the cursor.
      for (let cursor = records.length - 1; cursor > index; cursor -= 1) {
        const entry = records[cursor];
        if (entry && typeof entry.id === "string" && entry.id === recordId) {
          records.splice(cursor, 1);
        }
      }
    } else records.push(sanitized);
    const bounded = boundRecords(records, this.recordLimit);
    try {
      await this.writeFile(this.executionsPath, `${JSON.stringify(bounded)}\n`);
    } catch (caught) {
      throw this.executionFailure(caught);
    }
    return { id: recordId };
  }

  /** Most recent records first.  Safe to call before a project exists. */
  async listExecutionRecords(
    limit?: number,
  ): Promise<Record<string, unknown>[]> {
    const parsedLimit = typeof limit === "number" && Number.isFinite(limit)
      ? Math.round(limit)
      : DEFAULT_LIST_LIMIT;
    const cap = Math.min(Math.max(parsedLimit, 1), MAX_EXECUTIONS);
    const records = await this.readExecutions();
    const scrubList = await this.storedCredentialScrubList();
    return records
      .slice(Math.max(0, records.length - cap))
      .reverse()
      .map((record) => sanitizeExecutionRecord(record, 0, scrubList));
  }

  // ------------------------------------------------------------------ internals

  private resolveRequestUrl(
    candidate: AiRequestInput,
    state: AiProvidersState,
  ): string {
    const explicit = typeof candidate.url === "string"
      ? candidate.url.trim()
      : "";
    if (explicit) return explicit;
    const providerId = typeof candidate.provider_id === "string"
      ? candidate.provider_id.trim()
      : "";
    const provider = providerId
      ? state.providers.find((entry) => entry.id === providerId)
      : undefined;
    const baseUrl = typeof provider?.base_url === "string"
      ? provider.base_url.trim()
      : "";
    if (!baseUrl) {
      throw notConfigured(
        providerId
          ? `AI 服务商「${providerId}」还没有配置接口地址。`
          : "尚未选择 AI 服务商。",
        "ai.complete has no url and no saved provider base_url",
      );
    }
    const chatPath = typeof provider?.chat_path === "string"
      ? provider.chat_path.trim()
      : "";
    if (!chatPath) return baseUrl;
    return `${baseUrl.replace(/\/+$/, "")}/${chatPath.replace(/^\/+/, "")}`;
  }

  private async send(request: {
    requestId: string;
    providerId: string;
    url: URL;
    headers: Record<string, string>;
    body: string;
    /** P2-1 model discovery is a GET; chat completions stay a POST. */
    method?: "POST" | "GET";
    timeoutMs: number;
    signal: AbortSignal | null;
    /** Exact credential forms that must never survive in a failure payload. */
    secrets: readonly string[];
    /** True when a stored credential is too short to scrub safely. */
    dropProviderExcerpt: boolean;
  }): Promise<AiTransportResult> {
    const controller = new AbortController();
    this.requestRegistry.set(request.requestId, controller);
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    const external = request.signal;
    const onExternalAbort = () => {
      cancelled = true;
      controller.abort();
    };
    if (external) {
      if (external.aborted) {
        cancelled = true;
        controller.abort();
      } else {
        external.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    const failure = (caught: unknown): ServiceError =>
      this.translateFetchFailure(caught, {
        timedOut,
        cancelled,
        signal: controller.signal,
        providerId: request.providerId,
        timeoutMs: request.timeoutMs,
        secrets: request.secrets,
        url: request.url,
      });
    try {
      let response: Response;
      try {
        const method = request.method === "GET" ? "GET" : "POST";
        response = await this.fetchImpl(request.url, {
          method,
          headers: request.headers,
          body: method === "GET" ? undefined : request.body,
          signal: controller.signal,
          // One request only: a redirect could forward a custom auth header to
          // a host the user never configured, so redirects stop the call.
          redirect: "manual",
        });
      } catch (caught) {
        throw failure(caught);
      }
      const status = typeof response?.status === "number" ? response.status : 0;
      if (
        response?.type === "opaqueredirect" ||
        (status >= 300 && status < 400)
      ) {
        throw error(
          "provider_error",
          "AI 服务商地址发生了跳转，为避免密钥被转发到其他站点，请求已停止。",
          `AI request was redirected (status ${status})`,
          {
            recoverable: true,
            recommended_action: "请把服务地址改为最终地址后重试。",
            details: { provider_id: request.providerId || null, status },
          },
        );
      }
      const headers = responseHeaders(response);
      const ok = status >= 200 && status < 300;
      const declaredLength = Number.parseInt(
        headers["content-length"] ?? "",
        10,
      );
      if (
        ok && Number.isFinite(declaredLength) &&
        declaredLength > MAX_RESPONSE_BYTES
      ) {
        try {
          await response.body?.cancel();
        } catch {
          // The connection is released when the response is collected.
        }
        throw this.responseTooLarge(request.providerId, declaredLength);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (caught) {
        throw failure(caught);
      }
      if (!ok) {
        throw this.statusFailure(
          status,
          text,
          request.providerId,
          request.secrets,
          request.url,
          headers["content-type"] ?? "",
          request.dropProviderExcerpt,
        );
      }
      if (text.length > MAX_RESPONSE_BYTES) {
        throw this.responseTooLarge(request.providerId, text.length);
      }
      const contentType = (headers["content-type"] ?? "").toLowerCase();
      if (contentType.includes("text/event-stream")) {
        return {
          status,
          headers,
          body: text,
          response_kind: "stream",
        };
      }
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // The caller classifies an unparsable body as `malformed_response`.
        body = text;
      }
      return { status, headers, body, response_kind: "json" };
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener("abort", onExternalAbort);
      this.requestRegistry.delete(request.requestId);
    }
  }

  private translateFetchFailure(
    caught: unknown,
    context: {
      timedOut: boolean;
      cancelled: boolean;
      signal: AbortSignal;
      providerId: string;
      timeoutMs: number;
      secrets: readonly string[];
      url: URL | null;
    },
  ): ServiceError {
    if (caught instanceof ServiceError) return caught;
    if (context.timedOut) {
      const seconds = Math.max(1, Math.round(context.timeoutMs / 1000));
      return error(
        "timeout",
        `AI 服务商在 ${seconds} 秒内没有响应，请求已结束。`,
        `AI request timed out after ${context.timeoutMs}ms`,
        {
          recoverable: true,
          recommended_action: "稍后重试；如果持续超时，请换用响应更快的模型。",
          details: {
            provider_id: context.providerId || null,
            timeout_ms: context.timeoutMs,
          },
        },
      );
    }
    const name = caught instanceof Error ? caught.name : "";
    if (context.cancelled || context.signal.aborted || name === "AbortError") {
      return error(
        "cancelled",
        "已取消本次 AI 请求。",
        "AI request aborted by the user",
        {
          recoverable: true,
          recommended_action: null,
          details: { provider_id: context.providerId || null },
        },
      );
    }
    return error(
      "transport_unavailable",
      "无法连接到 AI 服务商，请检查网络连接或服务地址。",
      // The effective url may carry the key in a query string, so it never
      // reaches a message or a log: `<url>` stands in for it.
      `AI transport failed: ${
        scrubProviderText(
          stripRequestUrl(messageOf(caught), context.url),
          context.secrets,
        )
      }`,
      {
        recoverable: true,
        recommended_action: "检查网络与服务地址后重试。",
        details: { provider_id: context.providerId || null },
      },
    );
  }

  private responseTooLarge(providerId: string, size: number): ServiceError {
    return error(
      "provider_error",
      "AI 服务商返回的内容过大，已停止处理。",
      `AI response exceeds ${MAX_RESPONSE_BYTES} bytes (${size})`,
      {
        recoverable: true,
        recommended_action: "缩小上下文后重试。",
        details: { provider_id: providerId || null, size },
      },
    );
  }

  private statusFailure(
    status: number,
    text: string,
    providerId: string,
    secrets: readonly string[],
    url: URL | null,
    contentType: string,
    dropProviderExcerpt: boolean,
  ): ServiceError {
    // A hostile or buggy provider can echo the request (headers and url) in its
    // error payload, transformed or not.  The excerpt is therefore decoded,
    // exact-value scrubbed, pattern scrubbed, shape filtered and short — and
    // the structured metadata still says what happened.  When a stored
    // credential is too short to replace exactly, no provider text is kept at
    // all: a readable excerpt is worthless next to a leak.
    const details = {
      provider_id: providerId || null,
      status,
      body_kind: bodyKind(contentType),
      body_chars: text.length,
      detail: dropProviderExcerpt
        ? REDACTED
        : scrubProviderText(stripRequestUrl(text.trim(), url), secrets)
          .slice(0, MAX_ERROR_DETAIL_CHARS),
    };
    if (status === 401) {
      return error(
        "missing_credential",
        "服务商拒绝了本次请求（401）：API Key 可能不正确、已过期或未授权。",
        `AI provider returned 401`,
        {
          recoverable: true,
          recommended_action: "在 AI 面板重新保存该服务商的 API Key 后重试。",
          details,
        },
      );
    }
    if (status === 403) {
      return error(
        "permission_denied",
        "服务商拒绝了本次请求（403）：该密钥没有调用此模型或接口的权限。",
        `AI provider returned 403`,
        {
          recoverable: true,
          recommended_action: "确认密钥权限、账号额度或更换模型后重试。",
          details,
        },
      );
    }
    if (status === 429) {
      return error(
        "rate_limited",
        "请求过于频繁（429），服务商已限流。",
        `AI provider returned 429`,
        {
          recoverable: true,
          recommended_action: "等待一段时间后重试，或降低请求频率。",
          details,
        },
      );
    }
    if (status >= 500) {
      return error(
        "provider_error",
        `AI 服务商暂时不可用（HTTP ${status}）。`,
        `AI provider returned ${status}`,
        {
          recoverable: true,
          recommended_action: "稍后重试；若持续失败，请查看服务商状态页。",
          details,
        },
      );
    }
    return error(
      "provider_error",
      `AI 服务商返回错误（HTTP ${status}）。`,
      `AI provider returned ${status}`,
      {
        recoverable: true,
        recommended_action: "检查模型名称与服务地址后重试。",
        details,
      },
    );
  }

  private executionFailure(caught: unknown): ServiceError {
    if (
      caught instanceof ServiceError &&
      caught.error.code === "ai_execution_record_failed"
    ) {
      return caught;
    }
    return error(
      "ai_execution_record_failed",
      "AI 执行记录未能写入，课程内容不受影响。",
      `Failed to append the AI execution record: ${messageOf(caught)}`,
      {
        recoverable: true,
        recommended_action:
          "可以继续编辑课程；如需保留记录，请确认项目 .workspace/ai 目录可写。",
        details: { operation: "ai.execution.append" },
      },
    );
  }

  /**
   * Every credential spelling stored for this project. This deliberately
   * fails closed: without a complete scrub list, no execution record may be
   * written or returned.
   */
  private async storedCredentialScrubList(): Promise<string[]> {
    const state = await this.readProviders();
    return [...new Set(
      await this.credentialsForProviders(state.providers).then((values) =>
        values.flatMap((value) => credentialScrubList(value, ""))
      ),
    )];
  }

  private async credentialsForProviders(
    providers: readonly AiProviderConfig[],
  ): Promise<string[]> {
    const providerIds = new Set(providers.map((provider) => provider.id));
    // Injectable fakes can enumerate their isolated accounts; the macOS
    // adapter intentionally does not enumerate the user's Keychain.
    for (const providerId of await this.credentialStore.listProviders()) {
      providerIds.add(providerId);
    }
    const values: string[] = [];
    for (const providerId of providerIds) {
      const value = await this.credentialStore.get(providerId);
      if (value) values.push(value);
    }
    return values;
  }

  private migrationFailure(operation: string): ServiceError {
    return error(
      "ai_credential_migration_failed",
      "历史 API Key 未能安全迁移到 macOS 系统钥匙串，原文件未删除。",
      `Credential migration failed (${operation})`,
      {
        recoverable: true,
        recommended_action: "确认 macOS 钥匙串可用后重试；在迁移完成前不要共享项目目录。",
        details: { operation, path: ".workspace/ai/providers.json" },
      },
    );
  }

  private async readLegacyDocument(
    path: string,
  ): Promise<ParsedAiProvidersState | null> {
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.lstat(path);
    } catch (caught) {
      if (isNotFound(caught)) return null;
      throw this.unreadable(caught);
    }
    if (stat.isSymlink || !stat.isFile || stat.size > MAX_PROVIDERS_FILE_BYTES) {
      throw this.unreadable(new Error("provider metadata file is invalid"));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Deno.readTextFile(path));
    } catch (caught) {
      throw this.unreadable(caught);
    }
    if (isPlainRecord(parsed) && Array.isArray(parsed.providers)) {
      for (const provider of parsed.providers) {
        if (findForbiddenField(provider) || findInlineCredentialField(provider)) {
          throw this.migrationFailure("provider-metadata");
        }
      }
    }
    if (isPlainRecord(parsed) && isPlainRecord(parsed.credentials)) {
      for (const [providerId, rawValue] of Object.entries(parsed.credentials)) {
        if (typeof rawValue !== "string") {
          throw this.migrationFailure("invalid-credential");
        }
        if (rawValue.trim() && !isSafeProviderId(providerId)) {
          throw this.migrationFailure("invalid-provider");
        }
      }
    }
    const state = normalizeProvidersState(parsed);
    if (!state) throw this.unreadable(new Error("provider metadata is invalid"));
    return state;
  }

  /**
   * Read provider metadata and migrate any historical plaintext credentials in
   * one transaction-like sequence. The old file is retained until every key
   * has been written and verified in Keychain and metadata-only JSON succeeds.
   */
  private async readProviders(): Promise<AiProvidersState> {
    const primary = await this.readLegacyDocument(this.providersPath);
    const backupPath = join(this.home, "providers.bak");
    const backup = await this.readLegacyDocument(backupPath);
    const state = primary ?? backup;
    if (!state) return { providers: [] };

    const credentials = {
      ...(backup?.credentials ?? {}),
      ...(primary?.credentials ?? {}),
    };
    const hasLegacyShape = primary?.credentials !== undefined ||
      backup?.credentials !== undefined || primary?.hasExtraFields === true ||
      backup?.hasExtraFields === true || primary?.providerMetadataChanged === true ||
      backup?.providerMetadataChanged === true ||
      (backup !== null && primary === null);
    if (hasLegacyShape) {
      if (this.readOnly) throw this.migrationFailure("read-only-project");
      for (const [providerId, rawValue] of Object.entries(credentials)) {
        const value = rawValue.trim();
        if (!value) continue;
        try {
          await this.credentialStore.set(providerId, value);
          const verified = await this.credentialStore.get(providerId);
          if (verified !== value) throw new Error("keychain verification failed");
        } catch {
          // Neither providers.json nor providers.bak is removed on failure.
          throw this.migrationFailure("keychain-write");
        }
      }
      try {
        await this.writeProviders({ providers: state.providers });
        if (backup !== null) await Deno.remove(backupPath);
      } catch {
        // Metadata write/removal failures leave the old plaintext source intact
        // so a retry cannot lose the user's credential.
        throw this.migrationFailure("metadata-cleanup");
      }
    }
    return { providers: state.providers };
  }

  private unreadable(caught: unknown): ServiceError {
    // Never echo the parser message: JSON.parse errors quote the file content,
    // and this file holds credentials.
    const reason = caught instanceof Error ? caught.name : typeof caught;
    return error(
      "ai_connection_unreadable",
      "无法读取 AI 服务商设置（ai/providers.json）。课程内容不受影响，请在 AI 面板重新设置后重试；原文件没有改动。",
      `Failed to read ${this.providersPath} (${reason})`,
      {
        recoverable: true,
        recommended_action: "在 AI 面板重新保存服务商设置后重试；课程内容不会因此改变。",
        details: { path: ".workspace/ai/providers.json" },
      },
    );
  }

  private async writeProviders(state: AiProvidersState): Promise<void> {
    // Provider metadata is deliberately the only JSON content. Credentials
    // belong to the system Keychain, never to providers.json or its backups.
    const contents = `${JSON.stringify({ providers: state.providers }, null, 2)}\n`;
    try {
      await this.writeFile(this.providersPath, contents);
    } catch (caught) {
      if (caught instanceof ServiceError) throw caught;
      throw error(
        "ai_connection_write_failed",
        "AI 服务商配置未能保存，请检查项目目录是否可写。",
        `Failed to write ${this.providersPath}: ${messageOf(caught)}`,
        {
          recoverable: true,
          recommended_action: "确认项目目录未被设为只读后重试。",
          details: { path: ".workspace/ai/providers.json" },
        },
      );
    }
  }

  private async readExecutions(): Promise<Record<string, unknown>[]> {
    // The execution log is non-canonical and bounded: an unreadable or stale
    // file must never block the AI panel.
    try {
      const stat = await Deno.stat(this.executionsPath);
      if (!stat.isFile || stat.size > MAX_EXECUTIONS_FILE_BYTES) return [];
      const parsed: unknown = JSON.parse(
        await Deno.readTextFile(this.executionsPath),
      );
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isPlainRecord);
    } catch {
      return [];
    }
  }

  /** Atomic, private write: temp file + fsync + rename, POSIX mode 0600. */
  private async writeFile(target: string, contents: string): Promise<void> {
    if (this.readOnly) {
      throw error(
        "read_only_project",
        "当前项目以只读方式打开，无法保存 AI 配置。",
        `Refusing to write ${target} for a read-only project`,
        {
          recoverable: false,
          recommended_action: "切换到编辑模式后重试。",
          details: {},
        },
      );
    }
    await this.assertNotSymlink(dirname(target));
    await this.assertNotSymlink(target);
    await Deno.mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${id()}`;
    try {
      await writeBytesSyncSafe(temporary, new TextEncoder().encode(contents));
      // Re-validate before the rename.  The parser message is dropped on
      // purpose: it quotes the payload, which may contain a credential.
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch {
        throw new Error("AI store payload is not valid JSON");
      }
      if (!parsed || typeof parsed !== "object") {
        throw new Error("JSON root must be an object");
      }
      await Deno.rename(temporary, target);
      await chmodPrivate(target);
    } catch (caught) {
      try {
        await Deno.remove(temporary);
      } catch (cleanup) {
        if (!isNotFound(cleanup)) void cleanup;
      }
      throw caught;
    }
  }

  private async assertNotSymlink(path: string): Promise<void> {
    try {
      if ((await Deno.lstat(path)).isSymlink) {
        throw error(
          "invalid_project_path",
          "AI 配置文件路径不能是符号链接。",
          `Symlink rejected for AI storage: ${path}`,
          { recoverable: false, recommended_action: null, details: {} },
        );
      }
    } catch (caught) {
      if (caught instanceof ServiceError) throw caught;
      if (!isNotFound(caught)) throw caught;
    }
  }
}

function assertProviderId(providerId: string): string {
  const key = typeof providerId === "string" ? providerId.trim() : "";
  if (!isSafeProviderId(key)) {
    throw invalidRequest(
      "服务商 id 无效。",
      `Invalid provider id: ${JSON.stringify(providerId)}`,
      "请使用字母、数字、下划线或短横线组成的 id。",
    );
  }
  return key;
}

/** `{base}/models`, without doubling a trailing slash. */
export function modelListUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/**
 * Model ids out of the shapes OpenAI-compatible providers actually return:
 * `{ data: [{ id }] }`, `{ models: [{ id | name }] }`, or a bare array.
 */
export function modelIdsFromPayload(payload: unknown): string[] {
  const entries = (() => {
    if (Array.isArray(payload)) return payload;
    if (!isPlainRecord(payload)) return [];
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.models)) return payload.models;
    return [];
  })();
  const ids = entries.map((entry) => {
    if (typeof entry === "string") return entry.trim();
    if (!isPlainRecord(entry)) return "";
    const value = entry.id ?? entry.name ?? entry.model;
    return typeof value === "string" ? value.trim() : "";
  }).filter((value) => value.length > 0);
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function assertTransportUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidRequest(
      "AI 请求地址无效，无法解析。",
      "ai.complete received an unparsable url",
      "请检查服务商接口地址。",
    );
  }
  if (url.protocol === "https:") return url;
  const host = url.hostname.toLowerCase();
  const localHost = host === "127.0.0.1" || host === "localhost" ||
    host === "::1" || host === "[::1]";
  if (url.protocol === "http:" && localHost) return url;
  throw invalidRequest(
    "出于安全考虑，AI 请求只允许 https:// 地址（本机调试可用 http://127.0.0.1 或 http://localhost）。",
    `Rejected AI request scheme: ${url.protocol}//${host}`,
    "请把服务地址改为 https:// 开头的接口地址。",
  );
}

function normalizeHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (value === undefined || value === null) {
    headers["content-type"] = "application/json";
    return headers;
  }
  if (!isPlainRecord(value)) {
    throw invalidRequest("AI 请求头格式无效。", "ai.complete headers must be an object");
  }
  for (const [name, raw] of Object.entries(value)) {
    const header = name.trim().toLowerCase();
    if (!HEADER_NAME_PATTERN.test(header)) {
      throw invalidRequest(
        "AI 请求头名称无效。",
        `Invalid header name: ${JSON.stringify(name)}`,
      );
    }
    // Renderer-side injection markers never leave this process.
    if (header.startsWith("x-workbench-")) continue;
    // `fetch` owns these; forwarding them corrupts the request.
    if (header === "content-length" || header === "host") continue;
    if (typeof raw !== "string") {
      throw invalidRequest(
        `AI 请求头「${header}」的值必须是文本。`,
        `Header ${header} must be a string`,
      );
    }
    headers[header] = raw;
  }
  if (!("content-type" in headers)) {
    headers["content-type"] = "application/json";
  }
  return headers;
}

/**
 * `auth` asks the transport to inject the stored credential.  A provider that
 * needs no key simply omits `auth` (or leaves `header` empty).
 */
function normalizeAuth(
  value: unknown,
): { header: string; scheme: string } | null {
  if (value === undefined || value === null) return null;
  if (!isPlainRecord(value)) {
    throw invalidRequest("AI 鉴权配置无效。", "ai.complete auth must be an object");
  }
  const header = typeof value.header === "string" ? value.header.trim() : "";
  if (!header) return null;
  if (!HEADER_NAME_PATTERN.test(header)) {
    throw invalidRequest(
      "AI 鉴权头名称无效。",
      `Invalid auth header name: ${JSON.stringify(value.header)}`,
    );
  }
  const scheme = typeof value.scheme === "string" ? value.scheme.trim() : "";
  return { header: header.toLowerCase(), scheme };
}

function serializeBody(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) {
    throw invalidRequest("AI 请求缺少 body。", "ai.complete received an empty body");
  }
  let text: unknown;
  try {
    text = JSON.stringify(value);
  } catch {
    throw invalidRequest(
      "AI 请求 body 无法序列化为 JSON。",
      "ai.complete body is not JSON serialisable",
    );
  }
  if (typeof text !== "string") {
    throw invalidRequest(
      "AI 请求 body 无法序列化为 JSON。",
      "ai.complete body is not JSON serialisable",
    );
  }
  return text;
}

function normalizeTimeout(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalidRequest(
      "AI 请求超时时间无效。",
      `Invalid timeout_ms: ${JSON.stringify(value)}`,
    );
  }
  return Math.min(Math.max(Math.round(value), 1), MAX_TIMEOUT_MS);
}
