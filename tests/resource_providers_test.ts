import {
  createResourceProviders,
} from "../src/service/resource_providers.ts";
import type { SecretStore } from "../src/service/security.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
}

async function assertCode(work: () => Promise<unknown>, code: string) {
  try {
    await work();
  } catch (caught) {
    const value = caught as { error?: { code?: string } };
    assertEquals(value.error?.code, code, "structured resource error code");
    return caught;
  }
  throw new Error(`expected ${code} error`);
}

class TestSecrets implements SecretStore {
  readonly values = new Map<string, string>();
  writes = 0;
  deletes = 0;
  async set(provider: string, value: string) { this.writes++; this.values.set(provider, value); }
  async get(provider: string) { return this.values.get(provider) ?? null; }
  async delete(provider: string) { this.deletes++; this.values.delete(provider); }
  async listProviders() { return [...this.values.keys()]; }
}

function mockedFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input, init = {}) => {
    const url = input instanceof Request
      ? new URL(input.url)
      : new URL(String(input));
    return await handler(url, init);
  }) as typeof fetch;
}

const fixedNow = () => new Date("2026-10-20T02:00:00.000Z");

Deno.test("resource provider credentials stay isolated and statuses reveal no key", async () => {
  const secrets = new TestSecrets();
  const providers = createResourceProviders({
    secrets,
    transport: "mock",
    fetchImpl: mockedFetch(() => new Response("{}")),
    now: fixedNow,
  });
  await providers.setCredential("brave_search", " brave-private-key ");
  const statuses = await providers.listProviders();
  assertEquals([...secrets.values.keys()], ["resource.brave_search"], "provider key uses its own namespace");
  assertEquals(statuses.map(({ id, credential_present }) => [id, credential_present]), [
    ["brave_search", true],
    ["youtube_data_api", false],
  ], "status reports presence only");
  assert(!JSON.stringify(statuses).includes("brave-private-key"), "status does not reveal credentials");
  await assertCode(() => providers.searchVideos({ query: "topic", count: 5, duration_band: "target" }), "auth_required");
  await providers.deleteCredential("brave_search");
  assertEquals(await secrets.get("resource.brave_search"), null, "credential deletion uses the same namespace");
});

Deno.test("unknown provider IDs are rejected before touching SecretStore", async () => {
  const secrets = new TestSecrets();
  secrets.values.set("resource.brave_search", "existing");
  const providers = createResourceProviders({
    secrets,
    transport: "mock",
    fetchImpl: mockedFetch(() => new Response("{}")),
  });
  await assertCode(
    () => providers.setCredential("unknown" as never, "injected"),
    "invalid_input",
  );
  await assertCode(
    () => providers.deleteCredential("unknown" as never),
    "invalid_input",
  );
  assertEquals([secrets.writes, secrets.deletes], [0, 0], "invalid IDs do not call SecretStore");
  assertEquals([...secrets.values.entries()], [["resource.brave_search", "existing"]], "existing keys remain untouched");
});

Deno.test("Brave web search uses its official endpoint and returns sourced metadata", async () => {
  const secrets = new TestSecrets();
  secrets.values.set("resource.brave_search", "brave-secret-value");
  const requests: Array<{ url: URL; headers: Headers }> = [];
  let requestCount = 0;
  const providers = createResourceProviders({
    secrets,
    transport: "mock",
    now: fixedNow,
    fetchImpl: mockedFetch((url, init) => {
      requests.push({ url, headers: new Headers(init.headers) });
      return Response.json({
        web: {
          results: [{
            title: "Source title",
            url: "https://example.org/article",
            description: "A real provider snippet",
            profile: { long_name: "Example publisher" },
            page_age: "2026-10-19",
          }],
        },
      });
    }),
  });
  const hits = await providers.searchWeb({
    query: "  economic policy ",
    count: 28,
    country: "us",
    search_lang: "en",
    onRequest: () => requestCount++,
  });
  assertEquals(requestCount, 1, "budget callback runs once immediately before the HTTP request");
  assertEquals(requests[0]?.url.href, "https://api.search.brave.com/res/v1/web/search?q=economic+policy&count=20&country=US&search_lang=en", "request path and bounded parameters");
  assertEquals(requests[0]?.headers.get("x-subscription-token"), "brave-secret-value", "Brave key is sent in its required header");
  assertEquals(hits[0], {
    provider_id: "brave_search",
    transport: "mock",
    request_id: hits[0]?.request_id,
    requested_at: "2026-10-20T02:00:00.000Z",
    fetched_at: "2026-10-20T02:00:00.000Z",
    query: "economic policy",
    title: "Source title",
    url: "https://example.org/article",
    description: "A real provider snippet",
    publisher: "Example publisher",
    page_age: "2026-10-19",
    published_at: null,
  }, "search result keeps its provider facts and provenance");
  assert(!requests[0]?.url.href.includes("brave-secret-value"), "Brave key is absent from its URL");
});

Deno.test("YouTube search resolves duration and region from videos.list metadata", async () => {
  const secrets = new TestSecrets();
  secrets.values.set("resource.youtube_data_api", "youtube-secret-value");
  const requestUrls: URL[] = [];
  let requestCount = 0;
  const ids = ["vid239aa", "vid240aa", "vid300aa", "vid360aa", "vid361aa"];
  const durations = ["PT3M59S", "PT4M", "PT5M", "PT6M", "PT6M1S"];
  const providers = createResourceProviders({
    secrets,
    transport: "mock",
    now: fixedNow,
    fetchImpl: mockedFetch((url) => {
      requestUrls.push(url);
      if (url.pathname.endsWith("/search")) {
        return Response.json({ items: ids.map((videoId) => ({
          id: { videoId },
          snippet: { title: `Search ${videoId}`, channelTitle: "Channel", publishedAt: "2026-01-01T00:00:00Z" },
        })) });
      }
      return Response.json({ items: ids.map((id, index) => ({
        id,
        snippet: {
          title: `Video ${id}`,
          channelTitle: "Actual channel",
          publishedAt: "2026-01-02T00:00:00Z",
          defaultAudioLanguage: index === 0 ? "en" : undefined,
        },
        contentDetails: {
          duration: durations[index],
          caption: "true",
          regionRestriction: index === 4 ? { blocked: ["US"] } : { allowed: ["US", "CA"] },
        },
        status: { embeddable: index !== 4 },
      })) });
    }),
  });
  const hits = await providers.searchVideos({
    query: "lesson concept",
    count: 5,
    country: "us",
    relevance_language: "en",
    duration_band: "target",
    published_after: "2026-01-01T00:00:00Z",
    published_before: "2026-02-01T00:00:00Z",
    onRequest: () => requestCount++,
  });
  assertEquals(requestCount, 2, "search and videos.list each consume one request");
  assertEquals(requestUrls.map((url) => url.pathname), [
    "/youtube/v3/search",
    "/youtube/v3/videos",
  ], "search is followed by official video metadata lookup");
  assertEquals(requestUrls[0]?.searchParams.get("type"), "video", "search is video-only");
  assertEquals(requestUrls[0]?.searchParams.get("videoDuration"), "medium", "target search uses 4–20 minute discovery filter");
  assertEquals(requestUrls[0]?.searchParams.get("regionCode"), "US", "country is sent to YouTube search");
  assertEquals(requestUrls[0]?.searchParams.get("publishedAfter"), "2026-01-01T00:00:00Z", "published-after filter reaches YouTube search");
  assertEquals(requestUrls[0]?.searchParams.get("publishedBefore"), "2026-02-01T00:00:00Z", "published-before filter reaches YouTube search");
  assertEquals(requestUrls[1]?.searchParams.get("part"), "snippet,contentDetails,status", "details request includes duration, caption and embed metadata");
  assertEquals(hits.map((hit) => [hit.total_duration_sec, hit.duration_class]), [
    [239, "outside"],
    [240, "target"],
    [300, "target"],
    [360, "target"],
    [361, "wide"],
  ], "duration classes honor exact second boundaries");
  assertEquals(hits[0]?.region_availability, "available", "allowed country list is honored");
  assertEquals(hits[4]?.region_availability, "restricted", "blocked country list is honored");
  assertEquals(hits[0]?.captions_available, true, "caption availability is metadata only");
  assert(!("caption_text" in (hits[0] ?? {})), "provider does not claim caption text");
  assert(hits.every((hit) => hit.requested_at === "2026-10-20T02:00:00.000Z" && hit.query === "lesson concept"), "video hits keep operation provenance");
  assert(requestUrls.every((url) => url.searchParams.get("key") === "youtube-secret-value"), "YouTube API key is sent only on YouTube requests");
  assert(hits.every((hit) => !hit.url.includes("youtube-secret-value")), "API key is absent from returned video URLs");
  assert(hits[1]?.metadata_limitations.some((value) => value.includes("Caption track language")), "caption language limitation is explicit");
});

Deno.test("YouTube short fallback labels only measured 180–239 second candidates as wide", async () => {
  const secrets = new TestSecrets();
  secrets.values.set("resource.youtube_data_api", "youtube-key");
  const urls: URL[] = [];
  const providers = createResourceProviders({
    secrets,
    transport: "mock",
    fetchImpl: mockedFetch((url) => {
      urls.push(url);
      return url.pathname.endsWith("/search")
        ? Response.json({ items: [{ id: { videoId: "short239" }, snippet: { title: "Short", channelTitle: "Channel" } }] })
        : Response.json({ items: [{
          id: "short239",
          snippet: { title: "Short", channelTitle: "Channel" },
          contentDetails: { duration: "PT239S" },
        }] });
    }),
  });
  const hits = await providers.searchVideos({ query: "topic", count: 1, duration_band: "short_fallback" });
  assertEquals(urls[0]?.searchParams.get("videoDuration"), "short", "short fallback uses YouTube's under-four-minute filter");
  assertEquals(hits[0]?.duration_class, "wide", "239 seconds is a fallback candidate, not a target");
});

Deno.test("provider failures are structured, bounded, cancellable and never include YouTube keys", async () => {
  const secrets = new TestSecrets();
  secrets.values.set("resource.youtube_data_api", "youtube-top-secret");
  const providers = createResourceProviders({
    secrets,
    transport: "mock",
    now: fixedNow,
    fetchImpl: mockedFetch(() => Response.json({
      error: { errors: [{ reason: "keyInvalid" }] },
    }, { status: 403 })),
  });
  const failure = await assertCode(
    () => providers.getVideoDetails(["videoId123"]),
    "auth_required",
  ) as { error?: unknown };
  assert(!JSON.stringify(failure.error).includes("youtube-top-secret"), "API key never reaches structured errors");

  const limited = createResourceProviders({
    secrets,
    transport: "mock",
    fetchImpl: mockedFetch(() => new Response("{}", { status: 429 })),
  });
  await assertCode(
    () => limited.searchVideos({ query: "topic", count: 1, duration_band: "target" }),
    "rate_limited",
  );

  const timedOut = createResourceProviders({
    secrets,
    transport: "mock",
    timeoutMs: 5,
    fetchImpl: ((_input, init = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch,
  });
  await assertCode(
    () => timedOut.getVideoDetails(["videoId123"]),
    "timeout",
  );

  const cancelled = createResourceProviders({
    secrets,
    transport: "mock",
    timeoutMs: 500,
    fetchImpl: ((_input, init = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch,
  });
  const controller = new AbortController();
  const pending = cancelled.searchVideos({ query: "topic", count: 1, duration_band: "target", signal: controller.signal });
  controller.abort();
  await assertCode(() => pending, "cancelled");
});

Deno.test("source fetch blocks SSRF redirects and oversized responses, and hashes read content", async () => {
  const secrets = new TestSecrets();
  let calls = 0;
  let requestCount = 0;
  const providers = createResourceProviders({
    secrets,
    transport: "mock",
    now: fixedNow,
    maxResponseBytes: 500,
    fetchImpl: mockedFetch(() => {
      calls++;
      return new Response("<!doctype html><html><head><title>Example &amp; Evidence</title><meta property='og:site_name' content='Example'></head><body><script>unsafePageCode()</script><main>Primary source body with evidence.</main></body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }),
  });
  for (const unsafe of [
    "http://127.0.0.1/private",
    "https://localhost/private",
    "https://service.internal/metadata",
    "https://user:pass@example.org/secret",
    "https://example.org:8443/private",
  ]) {
    await assertCode(() => providers.fetchSource({ url: unsafe }), "source_unreadable");
  }
  assertEquals(calls, 0, "unsafe URLs never reach fetch");
  const source = await providers.fetchSource({
    url: "https://example.org/article",
    query: "policy case",
    onRequest: () => requestCount++,
  });
  assertEquals(requestCount, 1, "source fetch budget callback runs once before the request");
  assertEquals(source.title, "Example & Evidence", "HTML title is decoded from source bytes");
  assertEquals(source.publisher, "Example", "publisher comes from page metadata");
  assert(source.excerpt?.includes("Primary source body with evidence"), "excerpt comes from fetched body text");
  assert(source.text?.includes("Primary source body with evidence") && !source.text.includes("unsafePageCode"), "reader returns extracted text without page scripts");
  assertEquals(source.truncated, false, "short readable pages are not marked truncated");
  assertEquals(source.evidence_access, "content_read", "body text is marked as read");
  assertEquals(source.query, "policy case", "source retrieval preserves originating query when supplied");
  assert(source.content_hash?.length === 64, "source bytes receive a SHA-256 hash");

  const redirected = createResourceProviders({
    secrets,
    transport: "mock",
    fetchImpl: mockedFetch(() => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/admin" },
    })),
  });
  await assertCode(() => redirected.fetchSource({ url: "https://example.org/article" }), "source_unreadable");

  const tooLarge = createResourceProviders({
    secrets,
    transport: "mock",
    maxResponseBytes: 4,
    fetchImpl: mockedFetch(() => new Response("too much", {
      headers: { "content-type": "text/plain" },
    })),
  });
  await assertCode(() => tooLarge.fetchSource({ url: "https://example.org/article" }), "source_unreadable");
});

Deno.test("live source fetch fails closed until it can use the native pinned transport", async () => {
  let calls = 0;
  let requestCount = 0;
  const providers = createResourceProviders({
    secrets: new TestSecrets(),
    fetchImpl: mockedFetch(() => {
      calls++;
      return new Response("must not be fetched");
    }),
  });
  const caught = await assertCode(
    () => providers.fetchSource({
      url: "https://example.org/article",
      onRequest: () => requestCount++,
    }),
    "transport_unavailable",
  ) as { error?: { details?: Record<string, unknown> } };
  assertEquals(
    caught.error?.details?.reason,
    "native_source_fetch_required",
    "the live source fetch explains which transport is required",
  );
  assertEquals([calls, requestCount], [0, 0], "live mode never dispatches or debits a source fetch");
});
