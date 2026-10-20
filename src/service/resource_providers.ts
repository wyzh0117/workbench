import type { SecretStore } from "./security.ts";
import { error, ServiceError } from "./errors.ts";

export type ResourceProviderId = "brave_search" | "youtube_data_api";
export type TransportKind = "live" | "mock";
export type VideoDurationBand = "target" | "short_fallback";

export interface ResourceProviderStatus {
  id: ResourceProviderId;
  capabilities: Array<"web_search" | "video_search" | "video_metadata">;
  credential_present: boolean;
}

export interface WebSearchHit {
  provider_id: "brave_search";
  transport: TransportKind;
  request_id: string;
  requested_at: string;
  fetched_at: string;
  query: string;
  title: string;
  url: string;
  description: string;
  publisher: string | null;
  page_age: string | null;
  published_at: string | null;
}

export interface VideoHit {
  provider_id: "youtube_data_api";
  transport: TransportKind;
  request_id: string;
  requested_at: string;
  fetched_at: string;
  query: string;
  provider_video_id: string;
  title: string;
  url: string;
  channel_title: string;
  published_at: string | null;
  description: string;
  duration_iso8601: string | null;
  total_duration_sec: number | null;
  region_availability: "available" | "restricted" | "unknown";
  spoken_language: string | null;
  captions_available: boolean | null;
  embeddable: boolean | null;
  duration_class: "target" | "wide" | "outside" | "unknown";
  metadata_limitations: string[];
}

export interface SourceFetchResult {
  provider_id: ResourceProviderId;
  transport: TransportKind;
  request_id: string;
  requested_at: string;
  fetched_at: string;
  query: string;
  url: string;
  title: string;
  publisher: string | null;
  excerpt: string | null;
  evidence_access: "metadata_only" | "content_read" | "unavailable";
  content_hash: string | null;
  limitations: string[];
}

export interface ResourceProviders {
  listProviders(): Promise<ResourceProviderStatus[]>;
  setCredential(providerId: ResourceProviderId, value: string): Promise<void>;
  deleteCredential(providerId: ResourceProviderId): Promise<void>;
  searchWeb(input: {
    query: string;
    count: number;
    country?: string;
    search_lang?: string;
    signal?: AbortSignal;
    onRequest?: () => void;
  }): Promise<WebSearchHit[]>;
  searchVideos(input: {
    query: string;
    count: number;
    country?: string;
    relevance_language?: string;
    duration_band: VideoDurationBand;
    published_after?: string;
    published_before?: string;
    signal?: AbortSignal;
    onRequest?: () => void;
  }): Promise<VideoHit[]>;
  getVideoDetails(ids: string[], signal?: AbortSignal, onRequest?: () => void): Promise<VideoHit[]>;
  fetchSource(input: { url: string; query?: string; signal?: AbortSignal; onRequest?: () => void }): Promise<SourceFetchResult>;
}

type Deps = {
  secrets: Pick<SecretStore, "get" | "set" | "delete" | "listProviders">;
  fetchImpl?: typeof fetch;
  transport?: TransportKind;
  now?: () => Date;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

const CREDENTIALS: Record<ResourceProviderId, string> = {
  brave_search: "resource.brave_search",
  youtube_data_api: "resource.youtube_data_api",
};
function credentialKey(providerId: unknown): string {
  if (providerId !== "brave_search" && providerId !== "youtube_data_api") {
    throw error("invalid_input", "不支持的资源服务。", "Unknown resource provider ID", {
      recoverable: false,
      recommended_action: "选择支持的资源服务后重试。",
      details: {},
    });
  }
  return CREDENTIALS[providerId];
}
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const YOUTUBE_SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";
const YOUTUBE_VIDEOS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SOURCE_TEXT_LIMIT = 4_000;
const STATUS: ResourceProviderStatus[] = [
  {
    id: "brave_search",
    capabilities: ["web_search"],
    credential_present: false,
  },
  {
    id: "youtube_data_api",
    capabilities: ["video_search", "video_metadata"],
    credential_present: false,
  },
];

function providerError(
  code: string,
  providerId: ResourceProviderId,
  details: Record<string, unknown> = {},
): ServiceError {
  const messages: Record<string, string> = {
    auth_required: "请先配置此资源服务的专用 API Key。",
    provider_unavailable: "资源服务暂时不可用，请稍后重试。",
    rate_limited: "资源服务已达到请求限额，请稍后再试。",
    timeout: "资源请求超时，请检查网络后重试。",
    transport_unavailable: "无法连接到资源服务，请检查网络连接。",
    source_unreadable: "来源页面无法安全读取或内容格式不受支持。",
    cancelled: "已取消本次资源请求。",
  };
  return error(
    code,
    messages[code] ?? "资源请求没有完成。",
    `Resource provider ${providerId}: ${code}`,
    {
      recoverable: true,
      recommended_action: code === "auth_required"
        ? "配置该服务自己的 API Key 后重试。"
        : null,
      details: { provider_id: providerId, ...details },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function boundedCount(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function validateQuery(value: string, providerId: ResourceProviderId): string {
  const query = value.trim();
  if (!query) {
    throw error("invalid_input", "搜索词不能为空。", "Empty resource query", {
      recoverable: true,
      recommended_action: "输入主题或概念后重试。",
      details: { provider_id: providerId },
    });
  }
  return query;
}

function isoNow(now: () => Date): string {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error("Resource provider clock returned an invalid date");
  }
  return date.toISOString();
}

function requestId(): string {
  return crypto.randomUUID();
}

function codeForHttp(
  providerId: ResourceProviderId,
  status: number,
  payload: unknown,
): string {
  if (status === 429) return "rate_limited";
  if (providerId === "brave_search" && (status === 401 || status === 403)) {
    return "auth_required";
  }
  if (providerId === "youtube_data_api") {
    const errorObject = isRecord(payload) && isRecord(payload.error)
      ? payload.error
      : null;
    const items = errorObject && Array.isArray(errorObject.errors)
      ? errorObject.errors
      : [];
    const reasons = items.map((item) =>
      isRecord(item) ? stringOf(item.reason) : ""
    );
    if (reasons.some((reason) => [
      "quotaExceeded",
      "dailyLimitExceeded",
      "rateLimitExceeded",
    ].includes(reason))) return "rate_limited";
    if (reasons.some((reason) => ["keyInvalid", "keyExpired"].includes(reason))) {
      return "auth_required";
    }
  }
  return "provider_unavailable";
}

function validateMockSourceUrl(raw: string, providerId: ResourceProviderId): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw providerError("source_unreadable", providerId, { reason: "invalid_url" });
  }
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  const blockedSuffixes = [
    ".localhost",
    ".local",
    ".internal",
    ".lan",
    ".home",
    ".home.arpa",
    ".test",
    ".example",
    ".invalid",
    ".onion",
  ];
  if (
    url.protocol !== "https:" || url.username || url.password ||
    (url.port !== "" && url.port !== "443") || !host.includes(".") ||
    host === "localhost" || blockedSuffixes.some((suffix) => host.endsWith(suffix)) ||
    /^[0-9.]+$/.test(host) || host.includes(":")
  ) {
    throw providerError("source_unreadable", providerId, { reason: "unsafe_url" });
  }
  if ([...url.searchParams.keys()].some((key) =>
    /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|signature|token)/i.test(key)
  )) {
    throw providerError("source_unreadable", providerId, {
      reason: "sensitive_query_parameter",
    });
  }
  url.hash = "";
  return url;
}

function statusFailure(
  providerId: ResourceProviderId,
  response: Response,
  payload?: unknown,
): ServiceError {
  if (response.status === 429) {
    return providerError("rate_limited", providerId, { http_status: 429 });
  }
  const code = codeForHttp(providerId, response.status, payload);
  return providerError(code, providerId, { http_status: response.status });
}

function sourceStatusFailure(status: number, providerId: ResourceProviderId): ServiceError {
  return providerError("source_unreadable", providerId, { http_status: status });
}

async function readBounded(
  response: Response,
  maxBytes: number,
  providerId: ResourceProviderId,
  source: boolean,
): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw providerError(source ? "source_unreadable" : "provider_unavailable", providerId, {
      reason: "response_too_large",
      max_response_bytes: maxBytes,
    });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw providerError(source ? "source_unreadable" : "provider_unavailable", providerId, {
          reason: "response_too_large",
          max_response_bytes: maxBytes,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function responseFailure(response: Response, url: URL): boolean {
  if (response.redirected || (response.status >= 300 && response.status < 400)) return true;
  if (!response.url) return false;
  try {
    const finalUrl = new URL(response.url);
    return finalUrl.origin !== url.origin || finalUrl.pathname !== url.pathname;
  } catch {
    return true;
  }
}

export function createResourceProviders(deps: Deps): ResourceProviders {
  const transport = deps.transport ?? "live";
  if (transport === "mock" && !deps.fetchImpl) {
    throw providerError("provider_unavailable", "brave_search", {
      reason: "mock_transport_requires_fetch_injection",
    });
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = Math.max(1, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = Math.max(1, deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);

  async function credential(providerId: ResourceProviderId): Promise<string> {
    const key = await deps.secrets.get(CREDENTIALS[providerId]);
    if (!key?.trim()) throw providerError("auth_required", providerId);
    return key.trim();
  }

  async function requestJson(
    providerId: ResourceProviderId,
    url: URL,
    headers: HeadersInit,
    signal?: AbortSignal,
    onRequest?: () => void,
  ): Promise<{ value: unknown; fetchedAt: string }> {
    if (signal?.aborted) throw providerError("cancelled", providerId);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      onRequest?.();
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (responseFailure(response, url)) {
        throw providerError("provider_unavailable", providerId, {
          reason: "unexpected_redirect",
        });
      }
      const bytes = await readBounded(response, maxResponseBytes, providerId, false);
      let value: unknown = null;
      if (bytes.length) {
        try {
          value = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw providerError("provider_unavailable", providerId, {
            reason: "invalid_json",
            http_status: response.status,
          });
        }
      }
      if (!response.ok) throw statusFailure(providerId, response, value);
      return { value, fetchedAt: isoNow(now) };
    } catch (caught) {
      if (caught instanceof ServiceError) throw caught;
      if (timedOut) throw providerError("timeout", providerId, { timeout_ms: timeoutMs });
      if (signal?.aborted || (caught instanceof Error && caught.name === "AbortError")) {
        throw providerError("cancelled", providerId);
      }
      throw providerError("transport_unavailable", providerId);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function detailHits(
    ids: string[],
    signal?: AbortSignal,
    context: {
      query: string;
      requestId: string;
      requestedAt: string;
      band?: VideoDurationBand;
      country?: string;
      onRequest?: () => void;
    } = {
      query: "",
      requestId: requestId(),
      requestedAt: isoNow(now),
    },
    fallback: Map<string, Record<string, unknown>> = new Map(),
  ): Promise<VideoHit[]> {
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter((id) => /^[A-Za-z0-9_-]{6,}$/.test(id)))].slice(0, 50);
    if (!uniqueIds.length) return [];
    const apiKey = await credential("youtube_data_api");
    const url = new URL(YOUTUBE_VIDEOS_ENDPOINT);
    url.searchParams.set("part", "snippet,contentDetails,status");
    url.searchParams.set("id", uniqueIds.join(","));
    url.searchParams.set("key", apiKey);
    const { value, fetchedAt } = await requestJson(
      "youtube_data_api",
      url,
      { accept: "application/json" },
      signal,
      context.onRequest,
    );
    const items = isRecord(value) && Array.isArray(value.items) ? value.items : null;
    if (!items) {
      throw providerError("provider_unavailable", "youtube_data_api", {
        reason: "invalid_response_shape",
      });
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      if (isRecord(item) && typeof item.id === "string") byId.set(item.id, item);
    }
    return uniqueIds.map((id) => {
      const item = byId.get(id);
      const snippet = item && isRecord(item.snippet) ? item.snippet : null;
      const details = item && isRecord(item.contentDetails) ? item.contentDetails : null;
      const status = item && isRecord(item.status) ? item.status : null;
      const duration = optionalString(details?.duration);
      const seconds = duration ? parseIsoDurationSeconds(duration) : null;
      const limitations: string[] = [
        "YouTube duration metadata may differ slightly from playback duration.",
      ];
      if (!item) limitations.push("YouTube did not return metadata for this video ID.");
      if (seconds === null) limitations.push("Video duration is unknown and requires manual verification.");
      if (typeof details?.caption !== "string") limitations.push("Caption availability was not returned.");
      if (!optionalString(snippet?.defaultAudioLanguage)) limitations.push("Spoken language is unknown; title language is not a substitute.");
      limitations.push("Caption track language and caption text are unavailable without authorized caption access.");
      if (typeof status?.embeddable !== "boolean") limitations.push("Embedding availability was not returned.");
      const regionAvailability = regionAvailabilityFor(details, context.country);
      if (regionAvailability === "unknown") limitations.push("Region availability is unknown for the requested country.");
      const fallbackSnippet = fallback.get(id);
      const title = optionalString(snippet?.title) ?? stringOf(fallbackSnippet?.title);
      const channelTitle = optionalString(snippet?.channelTitle) ?? stringOf(fallbackSnippet?.channelTitle);
      const publishedAt = optionalString(snippet?.publishedAt) ?? optionalString(fallbackSnippet?.publishedAt);
      const description = optionalString(snippet?.description) ?? stringOf(fallbackSnippet?.description);
      if (!title) limitations.push("Video title is unknown.");
      return {
        provider_id: "youtube_data_api",
        transport,
        request_id: context.requestId,
        requested_at: context.requestedAt,
        fetched_at: fetchedAt,
        query: context.query,
        provider_video_id: id,
        title,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
        channel_title: channelTitle,
        published_at: publishedAt,
        description,
        duration_iso8601: duration,
        total_duration_sec: seconds,
        region_availability: regionAvailability,
        spoken_language: optionalString(snippet?.defaultAudioLanguage),
        captions_available: details && typeof details.caption === "string"
          ? details.caption === "true"
          : null,
        embeddable: typeof status?.embeddable === "boolean" ? status.embeddable : null,
        duration_class: classifyDuration(seconds, context.band ?? "target"),
        metadata_limitations: limitations,
      };
    });
  }

  return {
    async listProviders() {
      const statuses = await Promise.all(STATUS.map(async (status) => ({
        ...status,
        capabilities: [...status.capabilities],
        credential_present: Boolean((await deps.secrets.get(CREDENTIALS[status.id]))?.trim()),
      })));
      return statuses;
    },

    async setCredential(providerId, value) {
      const key = credentialKey(providerId);
      const secret = value.trim();
      if (!secret) {
        throw error("secret_invalid", "API Key 不能为空。", "Empty resource provider credential", {
          recoverable: true,
          recommended_action: "粘贴对应服务的 API Key 后重试。",
          details: { provider_id: providerId },
        });
      }
      await deps.secrets.set(key, secret);
    },

    async deleteCredential(providerId) {
      await deps.secrets.delete(credentialKey(providerId));
    },

    async searchWeb(input) {
      const query = validateQuery(input.query, "brave_search");
      if (query.length > 600 || query.split(/\s+/).filter(Boolean).length > 75) {
        throw error("invalid_input", "搜索词过长，请缩短后重试。", "Brave query exceeds documented limits", {
          recoverable: true,
          recommended_action: null,
          details: { provider_id: "brave_search" },
        });
      }
      const key = await credential("brave_search");
      const id = requestId();
      const requestedAt = isoNow(now);
      const url = new URL(BRAVE_ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(boundedCount(input.count, 20)));
      if (input.country) url.searchParams.set("country", input.country.trim().toUpperCase());
      if (input.search_lang) url.searchParams.set("search_lang", input.search_lang.trim().toLowerCase());
      const { value, fetchedAt } = await requestJson(
        "brave_search",
        url,
        { accept: "application/json", "x-subscription-token": key },
        input.signal,
        input.onRequest,
      );
      const web = isRecord(value) && isRecord(value.web) ? value.web : null;
      if (!web || !Array.isArray(web.results)) {
        throw providerError("provider_unavailable", "brave_search", {
          reason: "invalid_response_shape",
        });
      }
      return web.results.flatMap((raw): WebSearchHit[] => {
        if (!isRecord(raw)) return [];
        const title = optionalString(raw.title);
        const url = optionalString(raw.url);
        if (!title || !url) return [];
        const profile = isRecord(raw.profile) ? raw.profile : null;
        return [{
          provider_id: "brave_search",
          transport,
          request_id: id,
          requested_at: requestedAt,
          fetched_at: fetchedAt,
          query,
          title,
          url,
          description: stringOf(raw.description),
          publisher: optionalString(profile?.long_name) ?? optionalString(profile?.name),
          page_age: optionalString(raw.page_age),
          published_at: optionalString(raw.published_at),
        }];
      });
    },

    async searchVideos(input) {
      const query = validateQuery(input.query, "youtube_data_api");
      const id = requestId();
      const requestedAt = isoNow(now);
      const key = await credential("youtube_data_api");
      const url = new URL(YOUTUBE_SEARCH_ENDPOINT);
      url.searchParams.set("part", "snippet");
      url.searchParams.set("type", "video");
      url.searchParams.set("videoDuration", input.duration_band === "target" ? "medium" : "short");
      url.searchParams.set("maxResults", String(boundedCount(input.count, 50)));
      url.searchParams.set("q", query);
      if (input.country) url.searchParams.set("regionCode", input.country.trim().toUpperCase());
      if (input.relevance_language) url.searchParams.set("relevanceLanguage", input.relevance_language.trim().toLowerCase());
      if (input.published_after) url.searchParams.set("publishedAfter", input.published_after.trim());
      if (input.published_before) url.searchParams.set("publishedBefore", input.published_before.trim());
      url.searchParams.set("key", key);
      const { value, fetchedAt } = await requestJson(
        "youtube_data_api",
        url,
        { accept: "application/json" },
        input.signal,
        input.onRequest,
      );
      const items = isRecord(value) && Array.isArray(value.items) ? value.items : null;
      if (!items) {
        throw providerError("provider_unavailable", "youtube_data_api", {
          reason: "invalid_response_shape",
        });
      }
      const found: Array<{ id: string; snippet: Record<string, unknown> }> = [];
      for (const raw of items) {
        if (!isRecord(raw) || !isRecord(raw.id) || !isRecord(raw.snippet)) continue;
        const videoId = optionalString(raw.id.videoId);
        if (videoId) found.push({ id: videoId, snippet: raw.snippet });
      }
      if (!found.length) return [];
      const fallback = new Map(found.map((item) => [item.id, item.snippet]));
      const hits = await detailHits(
        found.map((item) => item.id),
        input.signal,
        {
          query,
          requestId: id,
          requestedAt,
          band: input.duration_band,
          country: input.country?.trim().toUpperCase(),
          onRequest: input.onRequest,
        },
        fallback,
      );
      // A search hit lacking a videos.list record remains visible as unknown,
      // while returned duration metadata is classified from actual seconds.
      return hits.map((hit) => ({
        ...hit,
        fetched_at: fetchedAt > hit.fetched_at ? fetchedAt : hit.fetched_at,
      }));
    },

    async getVideoDetails(ids, signal, onRequest) {
      const requestIdValue = requestId();
      const requestedAt = isoNow(now);
      return await detailHits(ids, signal, {
        query: "",
        requestId: requestIdValue,
        requestedAt,
        onRequest,
      });
    },

    async fetchSource(input) {
      const requestedAt = isoNow(now);
      const id = requestId();
      const url = validateMockSourceUrl(input.url, "brave_search");
      const providerId: ResourceProviderId = /(^|\.)(youtube\.com|youtu\.be)$/.test(url.hostname)
        ? "youtube_data_api"
        : "brave_search";
      if (input.signal?.aborted) throw providerError("cancelled", providerId);
      if (transport === "live") {
        throw providerError("transport_unavailable", providerId, {
          reason: "native_source_fetch_required",
        });
      }
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        input.onRequest?.();
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
          credentials: "omit",
          redirect: "manual",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
        if (responseFailure(response, url)) {
          throw providerError("source_unreadable", providerId, { reason: "redirect_blocked" });
        }
        if (!response.ok) throw sourceStatusFailure(response.status, providerId);
        const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (![
          "text/html",
          "application/xhtml+xml",
          "text/plain",
        ].includes(mime)) {
          await response.body?.cancel().catch(() => {});
          throw providerError("source_unreadable", providerId, {
            reason: "unsupported_content_type",
          });
        }
        const bytes = await readBounded(response, maxResponseBytes, providerId, true);
        const sourceText = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        const html = mime !== "text/plain";
        const title = html
          ? extractMeta(sourceText, "og:title") ?? extractTag(sourceText, "title") ?? url.hostname
          : url.hostname;
        const publisher = html ? extractMeta(sourceText, "og:site_name") ?? url.hostname : url.hostname;
        const bodyText = html ? htmlText(sourceText) : normalizeSpace(sourceText);
        const excerpt = bodyText.slice(0, SOURCE_TEXT_LIMIT).trim() ||
          (html ? extractMeta(sourceText, "description") : null);
        const hashBuffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(hashBuffer).set(bytes);
        const digest = await crypto.subtle.digest("SHA-256", hashBuffer);
        const contentHash = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        return {
          provider_id: providerId,
          transport,
          request_id: id,
          requested_at: requestedAt,
          fetched_at: isoNow(now),
          query: input.query?.trim() ?? "",
          url: url.href,
          title,
          publisher,
          excerpt: excerpt || null,
          evidence_access: bodyText ? "content_read" : "metadata_only",
          content_hash: contentHash,
          limitations: bodyText
            ? []
            : ["Page metadata was available, but no readable body text was extracted."],
        };
      } catch (caught) {
        if (caught instanceof ServiceError) throw caught;
        if (timedOut) throw providerError("timeout", providerId, { timeout_ms: timeoutMs });
        if (input.signal?.aborted || (caught instanceof Error && caught.name === "AbortError")) {
          throw providerError("cancelled", providerId);
        }
        throw providerError("transport_unavailable", providerId);
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function parseIsoDurationSeconds(value: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some((part) => part !== undefined)) return null;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  const total = Number(days) * 86_400 + Number(hours) * 3_600 +
    Number(minutes) * 60 + Number(seconds);
  return Number.isFinite(total) ? total : null;
}

function regionAvailabilityFor(
  details: Record<string, unknown> | null,
  country?: string,
): VideoHit["region_availability"] {
  if (!country || !details || !isRecord(details.regionRestriction)) return "unknown";
  const restriction = details.regionRestriction;
  const allowed = Array.isArray(restriction.allowed)
    ? restriction.allowed.filter((item): item is string => typeof item === "string")
    : null;
  const blocked = Array.isArray(restriction.blocked)
    ? restriction.blocked.filter((item): item is string => typeof item === "string")
    : null;
  const code = country.toUpperCase();
  if (allowed && blocked) return "unknown";
  if (allowed) return allowed.some((item) => item.toUpperCase() === code)
    ? "available"
    : "restricted";
  if (blocked) return blocked.some((item) => item.toUpperCase() === code)
    ? "restricted"
    : "available";
  return "unknown";
}

function classifyDuration(seconds: number | null, band: VideoDurationBand): VideoHit["duration_class"] {
  if (seconds === null) return "unknown";
  if (seconds >= 240 && seconds <= 360) return "target";
  if (
    (band === "target" && seconds > 360 && seconds <= 480) ||
    (band === "short_fallback" && seconds >= 180 && seconds < 240)
  ) return "wide";
  return "outside";
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, decimal: string) => {
      const codepoint = Number(decimal);
      return codepoint > 0 && codepoint <= 0x10ffff
        ? String.fromCodePoint(codepoint)
        : "";
    })
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) => {
      const codepoint = Number.parseInt(hex, 16);
      return codepoint > 0 && codepoint <= 0x10ffff
        ? String.fromCodePoint(codepoint)
        : "";
    });
}

function extractMeta(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = /\b(?:property|name)\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    if (name?.toLowerCase() !== key.toLowerCase() && !new RegExp(`^${escaped}$`, "i").test(name ?? "")) continue;
    const content = /\bcontent\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    if (content) return normalizeSpace(decodeEntities(content));
  }
  return null;
}

function extractTag(html: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}\\s*>`, "i").exec(html)?.[1];
  return value ? normalizeSpace(decodeEntities(value.replace(/<[^>]*>/g, " "))) : null;
}

function htmlText(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1] ?? html;
  return normalizeSpace(decodeEntities(
    body.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  ));
}
