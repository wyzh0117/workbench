/**
 * V1-T02 second implementation (P2) regression tests.
 *
 * P2 refines four interaction models.  The failures worth guarding against are
 * the ones a rewrite reintroduces silently, so each group is pinned at the
 * layer where the rule lives:
 *
 *  - P2-1 Provider / Model discovery: the model list must come from the
 *    provider (or from the user's own hands), never from a table in the app;
 *    a provider that cannot enumerate models must still be saveable.
 *  - P2-2 Block height: short content grows Small → Medium and then the frame
 *    scrolls; long content grows Medium → Large and never drops below Medium;
 *    shrinking content steps back down.
 *  - P2-3 Flow owns reordering: Flow writes the canonical `order_index`, so
 *    structure and preview cannot disagree with it.
 *  - P2-4 Grid interaction: left click places, right click unplaces, clicking a
 *    highlighted cell relocates, and the store refuses a cell the UI would
 *    never offer.
 */
import {
  AiTransport,
  modelIdsFromPayload,
  modelListUrl,
} from "../src/service/ai_transport.ts";
import { MemorySecretStore } from "../src/service/security.ts";
import {
  BLOCK_SIZE_CEILING,
  blockSizeTier,
  blockSizeTierForLines,
  blockSizeView,
  estimateBlockLines,
} from "../app/authoring.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const CREDENTIAL = "sk-v0t02-discovery-do-not-leak-4a1b2c3d";

const PROVIDER = {
  id: "deepseek",
  label: "DeepSeek",
  kind: "openai_compatible",
  base_url: "https://api.deepseek.com",
  chat_path: "/chat/completions",
  auth_header: "authorization",
  auth_scheme: "Bearer",
  default_model: "",
  models: [],
};

/* ------------------------------------------------------------------ *
 * P2-1 — Provider / Model discovery
 * ------------------------------------------------------------------ */

Deno.test("P2-1 model discovery reads the provider's own list with the stored key", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-p2-models-" });
  const calls: { url: string; method: string; auth: string }[] = [];
  try {
    const transport = new AiTransport(directory, {
      credential_store: new MemorySecretStore(),
      fetch: (input, init) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({
          url,
          method: String(init?.method ?? "GET"),
          auth: headers.authorization ?? "",
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              object: "list",
              data: [{ id: "zeta-model" }, { id: "alpha-model" }, { id: "alpha-model" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    });
    await transport.setCredential(PROVIDER.id, CREDENTIAL);
    await transport.saveConnection({ provider: PROVIDER });
    const result = await transport.listAiModels({ provider_id: PROVIDER.id });
    assert(
      calls.length === 1 && calls[0]!.url === "https://api.deepseek.com/models",
      `discovery must GET {base_url}/models, saw ${JSON.stringify(calls)}`,
    );
    assert(calls[0]!.method === "GET", "model discovery must not post a chat body");
    assert(
      calls[0]!.auth === `Bearer ${CREDENTIAL}`,
      "the stored credential must be injected as the provider's auth header",
    );
    assert(
      result.models.join(",") === "alpha-model,zeta-model",
      `duplicates must collapse and the list must be stable, got ${result.models.join(",")}`,
    );
    assert(
      !JSON.stringify(result).includes(CREDENTIAL),
      "the discovery result must never echo the key",
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("P2-1 a provider without model enumeration fails readably instead of inventing names", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-p2-models-fail-" });
  try {
    const transport = new AiTransport(directory, {
      credential_store: new MemorySecretStore(),
      fetch: () =>
        Promise.resolve(
          new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }),
        ),
    });
    await transport.setCredential(PROVIDER.id, CREDENTIAL);
    await transport.saveConnection({ provider: PROVIDER });
    let thrown: unknown = null;
    try {
      await transport.listAiModels({ provider_id: PROVIDER.id });
    } catch (error) {
      thrown = error;
    }
    assert(thrown !== null, "a 404 must surface as a failure, not as an empty model list");
    const message = JSON.stringify(thrown);
    assert(!message.includes(CREDENTIAL), "a failure payload must never carry the key");
    const code = (thrown as { error?: { code?: string } }).error?.code ??
      (thrown as { code?: string }).code;
    assert(
      typeof code === "string" && code.length > 0,
      `the failure must stay structured, got ${message}`,
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("P2-1 discovery without a saved key asks for the key rather than calling out", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-p2-models-nokey-" });
  let called = 0;
  try {
    const transport = new AiTransport(directory, {
      credential_store: new MemorySecretStore(),
      fetch: () => {
        called += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });
    await transport.saveConnection({ provider: PROVIDER });
    let thrown: unknown = null;
    try {
      await transport.listAiModels({ provider_id: PROVIDER.id });
    } catch (error) {
      thrown = error;
    }
    assert(thrown !== null, "discovery without a credential must fail");
    assert(called === 0, "no network call may happen before a credential exists");
    const code = (thrown as { error?: { code?: string } }).error?.code ??
      (thrown as { code?: string }).code;
    assert(
      code === "missing_credential" || code === "not_configured",
      `expected a credential error, got ${JSON.stringify(thrown)}`,
    );
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("P2-1 the model list is parsed from the shapes providers really return", () => {
  assert(
    modelIdsFromPayload({ data: [{ id: "a" }, { id: "b" }] }).join(",") === "a,b",
    "OpenAI-compatible { data: [{ id }] } must parse",
  );
  assert(
    modelIdsFromPayload({ models: [{ name: "llama3" }, { id: "qwen" }] }).join(",") ===
      "llama3,qwen",
    "Ollama-style { models: [{ name }] } must parse",
  );
  assert(
    modelIdsFromPayload(["only-one"]).join(",") === "only-one",
    "a bare array must parse",
  );
  assert(
    modelIdsFromPayload({ data: [] }).length === 0 &&
      modelIdsFromPayload({}).length === 0 &&
      modelIdsFromPayload(null).length === 0,
    "shapes without model names must yield an empty list, not a guess",
  );
  assert(
    modelListUrl("https://api.example.com/v1/") === "https://api.example.com/v1/models",
    "a trailing slash must not double up",
  );
});

/* ------------------------------------------------------------------ *
 * P2-2 — Block frame sizing
 * ------------------------------------------------------------------ */

Deno.test("P2-2 a short block grows Small → Medium and then the frame scrolls", () => {
  const short = ["heading", "quote", "callout", "divider", "placeholder"];
  for (const type of short) {
    assert(
      blockSizeTier(type, "短标题") === "small",
      `${type} must start at Small so a one-liner is not a huge box`,
    );
    assert(
      blockSizeTier(type, "行\n".repeat(4)) === "medium",
      `${type} must step up to Medium once the text needs a second line`,
    );
    assert(
      blockSizeTier(type, "行\n".repeat(40)) === "medium",
      `${type} must stop at Medium (its ceiling) and let the frame scroll`,
    );
    assert(
      BLOCK_SIZE_CEILING.short === "medium",
      "the short ceiling must be Medium — a heading never becomes a Large box",
    );
  }
});

Deno.test("P2-2 a long block grows Medium → Large and never drops below Medium", () => {
  const long = ["paragraph", "code", "list", "exercise"];
  for (const type of long) {
    assert(
      blockSizeTier(type, "一句话") === "medium",
      `${type} must start at Medium, not shrink to a small box`,
    );
    assert(
      blockSizeTier(type, "行\n".repeat(8)) === "large",
      `${type} must step up to Large when the text is long`,
    );
    assert(
      blockSizeTier(type, "行\n".repeat(200)) === "large",
      `${type} must stop at Large (its ceiling) and let the frame scroll`,
    );
    assert(
      BLOCK_SIZE_CEILING.long === "large",
      "the long ceiling must be Large",
    );
  }
});

Deno.test("P2-2 measured lines follow the same rule as the text estimate", () => {
  // The editor refreshes the tier from the laid-out field while typing, so the
  // measured path must agree with the estimate the first render uses.
  for (const [type, text] of [
    ["paragraph", "行\n".repeat(8)],
    ["heading", "短标题"],
    ["heading", "行\n".repeat(9)],
    ["code", "单行"],
  ] as const) {
    const lines = estimateBlockLines(text);
    assert(
      blockSizeTierForLines(
        ["heading", "quote", "callout", "divider", "placeholder"].includes(type) ? "short" : "long",
        lines,
      ) === blockSizeTier(type, text),
      `${type} must reach the same tier on both paths`,
    );
  }
  assert(
    blockSizeTierForLines("long", 1) === "medium" &&
      blockSizeTierForLines("long", 99) === "large" &&
      blockSizeTierForLines("short", 99) === "medium",
    "the measured path must honour both ceilings",
  );
});

Deno.test("P2-2 shrinking the text steps the frame back down", () => {
  const grown = blockSizeView({ type: "paragraph", text: "行\n".repeat(8) });
  assert(grown.tier === "large", "long text must report the Large tier");
  const shrunk = blockSizeView({ type: "paragraph", text: "只剩一句" });
  assert(shrunk.tier === "medium", "deleting the text must step the frame back down");
  const heading = blockSizeView({ type: "heading", text: "标题" });
  assert(heading.kind === "short" && heading.tier === "small", "a heading stays small");
  assert(
    estimateBlockLines("a".repeat(200)) > 2,
    "a long unbroken line must still count as several lines",
  );
});

/* ------------------------------------------------------------------ *
 * P2-3 / P2-4 — Flow order and Grid interaction live in
 * `dogfooding_test.ts`, where the store/DOM harness already exists.
 * ------------------------------------------------------------------ */
