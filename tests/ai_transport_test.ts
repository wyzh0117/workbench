import { join } from "node:path";
import {
  DesktopService,
  MemorySecretStore,
  ServiceError,
  type SecretStore,
} from "../src/domain/index.ts";
import {
  type AiFetch,
  AiTransport,
  sanitizeExecutionRecord,
  scrubCredentialText,
} from "../src/service/ai_transport.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** A credential value that must never reach a command result, audit or record. */
const CREDENTIAL = "sk-v0t03-do-not-leak-9f8e7d6c";

const PROVIDER = {
  id: "deepseek",
  label: "DeepSeek",
  kind: "openai_compatible",
  base_url: "https://api.deepseek.com",
  chat_path: "/chat/completions",
  auth_header: "authorization",
  auth_scheme: "Bearer",
  default_model: "deepseek-chat",
  models: ["deepseek-chat", "deepseek-reasoner"],
};

const COMPLETE_INPUT = {
  request_id: "req-1",
  provider_id: "deepseek",
  url: "https://api.deepseek.com/chat/completions",
  auth: { header: "authorization", scheme: "Bearer" },
  headers: { "content-type": "application/json", "x-workbench-auth": "deepseek" },
  body: { model: "deepseek-chat", messages: [] },
  timeout_ms: 5000,
};

interface FetchCall {
  input: string | URL | Request;
  init: RequestInit;
}

function stubFetch(
  responder: Response | ((call: FetchCall) => Response | Promise<Response>),
): { fetch: AiFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const stub: AiFetch = (input, init) => {
    const call: FetchCall = { input, init: init ?? {} };
    calls.push(call);
    return Promise.resolve(
      typeof responder === "function" ? responder(call) : responder,
    );
  };
  return { fetch: stub, calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A transport that never answers until the request is aborted. */
function hangingFetch(onStarted: () => void = () => {}): AiFetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? null;
      onStarted();
      const abort = () =>
        reject(new DOMException("The operation was aborted.", "AbortError"));
      if (!signal) return;
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Project-relative paths of every readable file whose text contains `needle`. */
async function filesContaining(
  root: string,
  needle: string,
): Promise<string[]> {
  const matches: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      if (entry.isDirectory) {
        await walk(full, relative);
        continue;
      }
      if (!entry.isFile) continue;
      try {
        if ((await Deno.readTextFile(full)).includes(needle)) {
          matches.push(relative);
        }
      } catch {
        // Binary or unreadable files cannot be text-scanned.
      }
    }
  };
  await walk(root, "");
  return matches.sort();
}

/** Store the credential `COMPLETE_INPUT` expects to have injected. */
async function seedCredential(desktop: DesktopService): Promise<void> {
  const stored = await desktop.commands.execute("ai.secret.set", {
    provider_id: "deepseek",
    value: CREDENTIAL,
  });
  assert(
    !stored.error,
    `seeding the credential failed: ${JSON.stringify(stored.error)}`,
  );
}

interface DesktopFixture {
  directory: string;
  desktop: DesktopService;
  aiHome: string;
  credentialStore: MemorySecretStore;
}

async function withDesktop(
  body: (fixture: DesktopFixture) => Promise<void>,
  options: { fetch?: AiFetch; createProject?: boolean } = {},
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "acw-ai-transport-" });
  const credentialStore = new MemorySecretStore();
  const desktop = new DesktopService(
    directory,
    { app_instance_id: `ai-transport-${crypto.randomUUID()}` },
    credentialStore,
    { fetch: options.fetch, credential_store: credentialStore },
  );
  try {
    await desktop.open();
    if (options.createProject !== false) {
      const created = await desktop.commands.execute("project.create", {
        title: "AI 传输测试课程",
      });
      assert(
        !created.error,
        `project.create failed: ${JSON.stringify(created.error)}`,
      );
    }
    await body({
      directory,
      desktop,
      aiHome: join(directory, ".workspace", "ai"),
      credentialStore,
    });
  } finally {
    await desktop.close().catch(() => undefined);
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("ai connections round-trip without ever returning the credential", async () => {
  await withDesktop(async ({ desktop }) => {
    const stored = await desktop.commands.execute("ai.secret.set", {
      provider_id: "deepseek",
      value: CREDENTIAL,
    });
    assert(
      !stored.error,
      `ai.secret.set failed: ${JSON.stringify(stored.error)}`,
    );
    assert(
      JSON.stringify(stored.value) === JSON.stringify({
        provider_id: "deepseek",
      }),
      "ai.secret.set must return only the provider id",
    );
    assert(
      !JSON.stringify(stored).includes(CREDENTIAL),
      "the credential must never be echoed by ai.secret.set",
    );
    assert(
      !JSON.stringify(desktop.audit.list()).includes(CREDENTIAL),
      "audit metadata must not contain the credential",
    );

    const saved = await desktop.commands.execute("ai.connection.save", {
      provider: PROVIDER,
    });
    assert(
      !saved.error,
      `ai.connection.save failed: ${JSON.stringify(saved.error)}`,
    );
    const savedProvider = (saved.value as { provider: { id: string } }).provider;
    assert(savedProvider.id === "deepseek", "the saved provider must come back");

    const listed = await desktop.commands.execute("ai.connection.list", {});
    assert(!listed.error, "ai.connection.list must succeed");
    const list = listed.value as {
      providers: Array<{ id: string }>;
      configured: Record<string, boolean>;
    };
    assert(
      list.providers.length === 1 && list.providers[0]?.id === "deepseek",
      "the saved provider must be listed",
    );
    assert(
      list.configured.deepseek === true,
      "credential presence must be reported as a boolean",
    );
    assert(
      !Object.prototype.hasOwnProperty.call(list, "credentials"),
      "the connection list must expose `configured`, never a credential map",
    );

    const deleted = await desktop.commands.execute("ai.connection.delete", {
      provider_id: "deepseek",
    });
    assert(!deleted.error, "ai.connection.delete must succeed");
    assert(
      JSON.stringify(deleted.value) ===
        JSON.stringify({ provider_id: "deepseek", removed: true }),
      "delete must report what it removed",
    );
    const after = await desktop.commands.execute("ai.connection.list", {});
    const afterList = after.value as {
      providers: unknown[];
      configured: Record<string, boolean>;
    };
    assert(
      afterList.providers.length === 0 &&
        afterList.configured.deepseek === undefined,
      "deleting a connection must drop both the config and its credential",
    );
  });
});

Deno.test("ai.secret.delete removes only the credential and stays idempotent", async () => {
  await withDesktop(async ({ desktop }) => {
    await desktop.commands.execute("ai.connection.save", { provider: PROVIDER });
    await seedCredential(desktop);
    const first = await desktop.commands.execute("ai.secret.delete", {
      provider_id: "deepseek",
    });
    assert(!first.error, "ai.secret.delete must succeed");
    assert(
      JSON.stringify(first.value) ===
        JSON.stringify({ provider_id: "deepseek", removed: true }),
      "the first delete must report removed=true",
    );
    const listed = await desktop.commands.execute("ai.connection.list", {});
    const list = listed.value as {
      providers: unknown[];
      configured: Record<string, boolean>;
    };
    assert(
      list.providers.length === 1 && list.configured.deepseek === false,
      "the provider config must survive a credential delete",
    );
    const second = await desktop.commands.execute("ai.secret.delete", {
      provider_id: "deepseek",
    });
    assert(
      !second.error &&
        (second.value as { removed: boolean }).removed === false,
      "deleting a missing credential must stay a no-op",
    );
    assert(
      !JSON.stringify([
        first,
        second,
        listed,
        desktop.audit.list(),
      ]).includes(CREDENTIAL),
      "no credential value may appear in any result",
    );
  });
});

Deno.test("provider metadata stays under .workspace/ai while credentials stay in the injected secure store", async () => {
  await withDesktop(async ({ directory, desktop, credentialStore }) => {
    const stored = await desktop.commands.execute("ai.secret.set", {
      provider_id: "deepseek",
      value: CREDENTIAL,
    });
    assert(!stored.error, "ai.secret.set must succeed");
    const providersPath = join(directory, ".workspace", "ai", "providers.json");
    assert(
      await pathExists(providersPath),
      "providers.json must be written under <project>/.workspace/ai",
    );
    assert(
      !(await pathExists(join(directory, ".workspace", "ai-providers.json"))),
      "the AI store must not fall back to the project .workspace root",
    );
    const onDisk = JSON.parse(await Deno.readTextFile(providersPath)) as Record<string, unknown>;
    assert(
      !Object.prototype.hasOwnProperty.call(onDisk, "credentials"),
      "providers.json must contain metadata only",
    );
    assert(
      await credentialStore.get("deepseek") === CREDENTIAL,
      "the credential must be persisted by the injected secure store",
    );
    const stat = await Deno.stat(providersPath);
    if (Deno.build.os === "windows" || stat.mode === null) {
      // Windows cannot express POSIX modes; the write is still best-effort.
      return;
    }
    assert(
      (stat.mode & 0o077) === 0,
      `providers.json must be private, got mode ${
        (stat.mode & 0o777).toString(8)
      }`,
    );
  });
});

Deno.test("historical plaintext credentials migrate once to the injected secure store", async () => {
  const projectDirectory = await Deno.makeTempDir({ prefix: "acw-ai-migrate-" });
  const aiHome = join(projectDirectory, ".workspace", "ai");
  const secureStore = new MemorySecretStore();
  const legacy = JSON.stringify({
    providers: [PROVIDER],
    credentials: { deepseek: CREDENTIAL },
  }, null, 2);
  try {
    await Deno.mkdir(aiHome, { recursive: true });
    await Deno.writeTextFile(join(aiHome, "providers.json"), `${legacy}\n`);
    await Deno.writeTextFile(join(aiHome, "providers.bak"), `${legacy}\n`);
    const transport = new AiTransport(projectDirectory, {
      credential_store: secureStore,
    });
    const listed = await transport.listConnections();
    assert(listed.configured.deepseek === true, "migration must preserve configured status");
    assert(await secureStore.get("deepseek") === CREDENTIAL, "migration must verify the secure-store value");
    const metadata = JSON.parse(await Deno.readTextFile(join(aiHome, "providers.json"))) as Record<string, unknown>;
    assert(!Object.prototype.hasOwnProperty.call(metadata, "credentials"), "migrated metadata must not contain credentials");
    assert(!await pathExists(join(aiHome, "providers.bak")), "historical plaintext backup must be removed after migration");
    assert(!JSON.stringify(listed).includes(CREDENTIAL), "migration result must never echo the key");
  } finally {
    await Deno.remove(projectDirectory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("failed historical migration leaves plaintext sources untouched without echoing the key", async () => {
  class FailingStore implements SecretStore {
    async set(): Promise<void> { throw new Error("keychain unavailable"); }
    async get(): Promise<string | null> { return null; }
    async delete(): Promise<void> {}
    async listProviders(): Promise<string[]> { return []; }
  }
  const projectDirectory = await Deno.makeTempDir({ prefix: "acw-ai-migrate-fail-" });
  const aiHome = join(projectDirectory, ".workspace", "ai");
  const legacy = JSON.stringify({ providers: [PROVIDER], credentials: { deepseek: CREDENTIAL } });
  try {
    await Deno.mkdir(aiHome, { recursive: true });
    await Deno.writeTextFile(join(aiHome, "providers.json"), legacy);
    const transport = new AiTransport(projectDirectory, { credential_store: new FailingStore() });
    let thrown: unknown = null;
    try {
      await transport.listConnections();
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof ServiceError, "failed migration must use a structured service error");
    assert(!JSON.stringify(thrown).includes(CREDENTIAL), "migration errors must not echo the key");
    assert(await Deno.readTextFile(join(aiHome, "providers.json")) === legacy, "failed migration must not alter the source");
  } finally {
    await Deno.remove(projectDirectory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("a corrupt provider file fails readably without echoing its contents", async () => {
  await withDesktop(async ({ desktop, aiHome }) => {
    await Deno.mkdir(aiHome, { recursive: true });
    const corrupt =
      `{"credentials": {"deepseek": "${CREDENTIAL}", }}`;
    await Deno.writeTextFile(join(aiHome, "providers.json"), corrupt);
    const listed = await desktop.commands.execute("ai.connection.list", {});
    assert(
      listed.error?.code === "ai_connection_unreadable",
      `a corrupt provider file must fail readably, got ${listed.error?.code}`,
    );
    assert(
      !JSON.stringify(listed.error).includes(CREDENTIAL),
      "a JSON parse failure must not echo file contents into the error",
    );
    assert(
      (listed.error?.user_message ?? "").includes("ai/providers.json"),
      "the message must point at the file to repair",
    );
    assert(
      (await Deno.readTextFile(join(aiHome, "providers.json"))) === corrupt,
      "a failed read must leave the file untouched for the user to inspect",
    );
  });
});

Deno.test("ai.connection.save rejects credential-shaped provider fields", async () => {
  await withDesktop(async ({ desktop }) => {
    for (
      const field of [
        "api_key",
        "token",
        "credential",
        "password",
        "authorization",
        "requires_credential",
      ]
    ) {
      const result = await desktop.commands.execute("ai.connection.save", {
        provider: { id: "custom", [field]: "value" },
      });
      assert(
        result.error?.code === "invalid_request",
        `provider field ${field} must be rejected, got ${result.error?.code}`,
      );
      assert(
        (result.error?.user_message ?? "").includes(field),
        `the error must name the rejected field ${field}`,
      );
    }
    const nested = await desktop.commands.execute("ai.connection.save", {
      provider: { id: "custom", extra: { deeper: { api_key: "x" } } },
    });
    assert(
      nested.error?.code === "invalid_request" &&
        (nested.error?.user_message ?? "").includes("extra.deeper.api_key"),
      "credential-shaped keys must be rejected at any depth",
    );
    const inline = await desktop.commands.execute("ai.connection.save", {
      provider: {
        id: "inline-url",
        base_url: `https://example.test/v1?api_key=${CREDENTIAL}`,
      },
    });
    assert(
      inline.error?.code === "invalid_request" &&
        !JSON.stringify(inline.error).includes(CREDENTIAL),
      "credential-shaped URL query parameters must not be persisted or echoed",
    );
    const badId = await desktop.commands.execute("ai.connection.save", {
      provider: { id: "" },
    });
    assert(
      badId.error?.code === "invalid_request",
      "a provider without an id must be rejected",
    );
    const listed = await desktop.commands.execute("ai.connection.list", {});
    assert(
      (listed.value as { providers: unknown[] }).providers.length === 0,
      "a rejected provider config must never be stored",
    );
  });
});

Deno.test("ai.complete posts once with the injected auth header and normalises bodies", async () => {
  const { fetch: stub, calls } = stubFetch(() =>
    jsonResponse({ choices: [{ message: { content: "你好" } }] })
  );
  await withDesktop(async ({ desktop }) => {
    await seedCredential(desktop);
    const result = await desktop.commands.execute("ai.complete", {
      ...COMPLETE_INPUT,
    });
    assert(
      !result.error,
      `ai.complete failed: ${JSON.stringify(result.error)}`,
    );
    const value = result.value as {
      status: number;
      response_kind: string;
      body: { choices: Array<{ message: { content: string } }> };
    };
    assert(
      value.status === 200 && value.response_kind === "json",
      "a JSON answer must come back as response_kind=json with its status",
    );
    assert(
      value.body.choices[0]?.message.content === "你好",
      "the parsed body must be returned unchanged",
    );
    assert(
      !JSON.stringify(result).includes(CREDENTIAL),
      "the transport result must not contain the credential",
    );
    assert(calls.length === 1, "exactly one request must be sent");
    const call = calls[0]!;
    assert(
      String(call.input) === "https://api.deepseek.com/chat/completions",
      "the provider url must be used verbatim",
    );
    const headers = call.init.headers as Record<string, string>;
    assert(
      headers["authorization"] === `Bearer ${CREDENTIAL}`,
      "the credential must be injected as the configured auth header",
    );
    assert(
      headers["x-workbench-auth"] === undefined,
      "renderer injection markers must never reach the provider",
    );
    assert(
      call.init.method === "POST" &&
        call.init.body === JSON.stringify(COMPLETE_INPUT.body),
      "the request body must be posted as JSON",
    );
    assert(call.init.redirect === "manual", "redirects must not be followed");
  }, { fetch: stub });
});

Deno.test("ai.complete returns streams as raw text and unparsable JSON as text", async () => {
  const stream = stubFetch(() =>
    new Response('data: {"delta":"hi"}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    })
  );
  await withDesktop(async ({ desktop }) => {
    await seedCredential(desktop);
    const result = await desktop.commands.execute("ai.complete", {
      ...COMPLETE_INPUT,
    });
    assert(!result.error, "a streaming answer must not fail");
    const value = result.value as { response_kind: string; body: unknown };
    assert(
      value.response_kind === "stream" &&
        value.body === 'data: {"delta":"hi"}\n\ndata: [DONE]\n\n',
      "text/event-stream bodies must come back as raw text",
    );
  }, { fetch: stream.fetch });

  const broken = stubFetch(() =>
    new Response("{not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  await withDesktop(async ({ desktop }) => {
    await seedCredential(desktop);
    const result = await desktop.commands.execute("ai.complete", {
      ...COMPLETE_INPUT,
    });
    assert(!result.error, "an unparsable body must not fail the transport");
    const value = result.value as { response_kind: string; body: unknown };
    assert(
      value.response_kind === "json" && value.body === "{not json",
      "an unparsable JSON body must be returned as text for the caller to classify",
    );
  }, { fetch: broken.fetch });
});

Deno.test("ai.complete maps provider HTTP failures to design error codes", async () => {
  let status = 401;
  // The provider echoes the request headers back, which is the realistic way a
  // key would ride out inside an error payload.
  const { fetch: stub } = stubFetch(() =>
    new Response(
      JSON.stringify({
        error: {
          message: `denied (Authorization: Bearer ${CREDENTIAL})`,
          echo: { headers: { authorization: `Bearer ${CREDENTIAL}` } },
        },
      }),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    )
  );
  const expected: Array<[number, string]> = [
    [401, "missing_credential"],
    [403, "permission_denied"],
    [429, "rate_limited"],
    [400, "provider_error"],
    [500, "provider_error"],
    [503, "provider_error"],
  ];
  await withDesktop(async ({ desktop }) => {
    await seedCredential(desktop);
    for (const [code, expectedCode] of expected) {
      status = code;
      const result = await desktop.commands.execute("ai.complete", {
        ...COMPLETE_INPUT,
      });
      assert(
        result.error?.code === expectedCode,
        `HTTP ${code} must map to ${expectedCode}, got ${result.error?.code}`,
      );
      assert(
        result.error?.recommended_action !== null &&
          result.error?.recommended_action !== undefined,
        `HTTP ${code} must suggest a next step`,
      );
      assert(
        !JSON.stringify(result.error).includes(CREDENTIAL),
        `the HTTP ${code} error must not contain the credential`,
      );
      assert(
        (result.error?.details.status as number) === code,
        "the provider status must be preserved in details",
      );
    }
  }, { fetch: stub });
});

Deno.test("a provider echoing the credential cannot leak it into results, diagnostics or the project", async () => {
  let mode: "authorization" | "x-api-key" | "url" = "authorization";
  const echoHeader = (): string =>
    mode === "x-api-key" ? CREDENTIAL : `Bearer ${CREDENTIAL}`;
  const { fetch: stub, calls } = stubFetch((call) => {
    if (mode === "url") {
      // A network failure that quotes the url, including its `api_key` query.
      return Promise.reject(
        new Error(`error sending request for url (${String(call.input)})`),
      );
    }
    const header = mode === "x-api-key" ? "x-api-key" : "Authorization";
    return new Response(
      JSON.stringify({
        error: {
          message: `Invalid ${header}: ${echoHeader()}`,
          url: String(call.input),
          echo: { headers: { [header]: echoHeader() } },
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  });

  await withDesktop(async ({ desktop, directory }) => {
    await seedCredential(desktop);
    const credentialForCustom = await desktop.commands.execute("ai.secret.set", {
      provider_id: "local-custom",
      value: CREDENTIAL,
    });
    assert(!credentialForCustom.error, "the custom provider needs a key too");

    const attempts: Array<{ label: string; result: unknown }> = [];

    mode = "authorization";
    attempts.push({
      label: "authorization echo",
      result: await desktop.commands.execute("ai.complete", {
        ...COMPLETE_INPUT,
        request_id: "leak-authorization",
      }),
    });

    mode = "x-api-key";
    attempts.push({
      label: "x-api-key echo",
      result: await desktop.commands.execute("ai.complete", {
        request_id: "leak-x-api-key",
        provider_id: "local-custom",
        url: "https://custom.example.com/v1/chat/completions",
        auth: { header: "x-api-key", scheme: "" },
        headers: { "content-type": "application/json" },
        body: { model: "custom" },
        timeout_ms: 5000,
      }),
    });

    mode = "url";
    attempts.push({
      label: "url leak",
      result: await desktop.commands.execute("ai.complete", {
        ...COMPLETE_INPUT,
        request_id: "leak-url",
        url: `https://api.deepseek.com/chat/completions?api_key=${CREDENTIAL}`,
      }),
    });

    // The subject must really have been sent, otherwise these assertions pass
    // vacuously.
    const sentHeaders = calls.map((call) =>
      JSON.stringify(call.init.headers ?? {})
    ).join("\n");
    assert(
      sentHeaders.includes(CREDENTIAL),
      "the transport must still inject the credential into the real request",
    );
    assert(
      calls.some((call) => typeof call.init.headers === "object" &&
        call.init.headers !== null &&
        (call.init.headers as Record<string, string>)["x-api-key"] === CREDENTIAL),
      "the custom provider shape must inject x-api-key",
    );
    assert(
      calls.some((call) =>
        String(call.input).includes(`api_key=${CREDENTIAL}`)
      ),
      "the url leak case must actually carry the key in its url",
    );

    for (const { label, result } of attempts) {
      const failure = (result as {
        error?: {
          code: string;
          user_message: string;
          technical_message: string;
          recommended_action: string | null;
          details: Record<string, unknown>;
        };
      }).error;
      assert(failure, `${label} must fail`);
      assert(
        !JSON.stringify(result).includes(CREDENTIAL),
        `${label}: the command result must not contain the credential`,
      );
      assert(
        !failure!.user_message.includes(CREDENTIAL) &&
          !failure!.technical_message.includes(CREDENTIAL) &&
          !String(failure!.recommended_action ?? "").includes(CREDENTIAL) &&
          !JSON.stringify(failure!.details).includes(CREDENTIAL),
        `${label}: the error message, advice and details must be scrubbed`,
      );
      if (failure!.details.detail !== undefined) {
        assert(
          String(failure!.details.detail).includes("[REDACTED]"),
          `${label}: the provider detail must show the redaction marker`,
        );
      }
    }
    assert(
      !JSON.stringify(desktop.audit.list()).includes(CREDENTIAL),
      "audit entries must not carry the credential",
    );

    // Sink (b): the rotating diagnostics log on disk.
    const logPath = desktop.diagnostics.path;
    const log = await Deno.readTextFile(logPath);
    assert(
      log.includes("missing_credential") &&
        log.includes("transport_unavailable"),
      "the diagnostics log must actually have recorded these failures",
    );
    assert(
      !log.includes(CREDENTIAL),
      "diagnostics.log must never contain the credential",
    );

    // Sink (c): the diagnostics export bundle.
    const bundle = await desktop.queries.execute("diagnostics.export");
    assert(
      !JSON.stringify(bundle).includes(CREDENTIAL),
      "the diagnostics export bundle must never contain the credential",
    );

    // With Keychain-backed storage no project file may hold the credential.
    const withCredential = await filesContaining(directory, CREDENTIAL);
    assert(
      withCredential.length === 0,
      `the project tree must never hold the credential, got ${
        withCredential.join(",") || "(nothing)"
      }`,
    );
  }, { fetch: stub });
});

Deno.test("AiTransport scrubs the credential from every thrown failure", async () => {
  const projectDirectory = await Deno.makeTempDir({ prefix: "acw-ai-scrub-" });
  const { fetch: stub } = stubFetch(() =>
    new Response(
      JSON.stringify({
        error: {
          message: `Invalid Authorization: Bearer ${CREDENTIAL}`,
          echo: { authorization: `Bearer ${CREDENTIAL}` },
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    )
  );
  try {
    const transport = new AiTransport(projectDirectory, {
      fetch: stub,
      credential_store: new MemorySecretStore(),
    });
    await transport.setCredential("deepseek", CREDENTIAL);
    let thrown: unknown = null;
    try {
      await transport.completeAiRequest({ ...COMPLETE_INPUT });
    } catch (caught) {
      thrown = caught;
    }
    assert(thrown instanceof ServiceError, "the transport must throw a ServiceError");
    const failure = thrown as ServiceError;
    assert(
      !failure.message.includes(CREDENTIAL),
      "the thrown Error message must be scrubbed",
    );
    assert(
      !JSON.stringify(failure.error).includes(CREDENTIAL),
      "the structured error must be scrubbed",
    );
    assert(
      String(failure.error.details.detail ?? "").includes("[REDACTED]") &&
        !String(failure.error.details.detail ?? "").includes(CREDENTIAL),
      "the provider detail must be redacted, not dropped silently",
    );
    assert(
      scrubCredentialText(`x ${CREDENTIAL} y`, [CREDENTIAL]) === "x [REDACTED] y",
      "the exact-value scrub helper must replace the whole value",
    );
  } finally {
    await Deno.remove(projectDirectory, { recursive: true }).catch(() =>
      undefined
    );
  }
});

Deno.test("encoded, escaped and fragmented credential echoes are redacted", async () => {
  const base64 = btoa(CREDENTIAL);
  const hex = Array.from(new TextEncoder().encode(CREDENTIAL))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const reversed = Array.from(CREDENTIAL).reverse().join("");
  const escaped = Array.from(CREDENTIAL)
    .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("");
  const forms = [CREDENTIAL, base64, hex, reversed];
  const halves = ["sk-v0t03-do", "-not-leak-9f8e7d6c"];

  const attacks: Record<string, string> = {
    base64: JSON.stringify({ error: { message: `invalid key ${base64}` } }),
    hex: JSON.stringify({ error: { message: `invalid key ${hex}` } }),
    reversed: JSON.stringify({ error: { message: `invalid key ${reversed}` } }),
    escaped: `{"error":{"message":"invalid key ${escaped}"}}`,
    split: JSON.stringify({
      error: { message: "invalid key" },
      first: halves[0],
      second: halves[1],
    }),
  };
  let attack = "base64";
  const { fetch: stub } = stubFetch(() =>
    new Response(attacks[attack]!, {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  );

  const results: unknown[] = [];
  await withDesktop(async ({ desktop, directory }) => {
    await seedCredential(desktop);
    for (const name of Object.keys(attacks)) {
      attack = name;
      const result = await desktop.commands.execute("ai.complete", {
        ...COMPLETE_INPUT,
        request_id: `attack-${name}`,
      });
      results.push(result);
      assert(
        result.error?.code === "missing_credential",
        `${name} must still fail with the provider's status`,
      );
      for (const form of forms) {
        assert(
          !JSON.stringify(result).includes(form),
          `${name} echo: the ${form.slice(0, 10)}… form must not survive`,
        );
      }
      for (const half of halves) {
        assert(
          !JSON.stringify(result).includes(half),
          `${name} echo: a credential fragment must not survive`,
        );
      }
      const detail = String(
        (result.error?.details as { detail?: unknown }).detail ?? "",
      );
      assert(
        detail === "[REDACTED]" || detail.includes("[REDACTED]"),
        `${name} echo: the excerpt must show a redaction marker, got ${
          JSON.stringify(detail.slice(0, 60))
        }`,
      );
    }

    const log = await Deno.readTextFile(desktop.diagnostics.path);
    for (const form of [...forms, ...halves]) {
      assert(
        !log.includes(form),
        `diagnostics.log must not carry the ${form.slice(0, 10)}… form`,
      );
    }
    const bundle = JSON.stringify(
      await desktop.queries.execute("diagnostics.export"),
    );
    for (const form of [...forms, ...halves]) {
      assert(
        !bundle.includes(form),
        `the diagnostics bundle must not carry the ${form.slice(0, 10)}… form`,
      );
    }
    const withCredential = await filesContaining(directory, CREDENTIAL);
    assert(
      withCredential.length === 0,
      `the project tree must never hold the credential, got ${
        withCredential.join(",") || "(nothing)"
      }`,
    );
    assert(results.length === 5, "every attack must have been attempted");
  }, { fetch: stub });
});

Deno.test("a request URL carrying the key cannot leak through a url echo", async () => {
  const requestUrl = `https://api.example.com/v1?api_key=${CREDENTIAL}`;
  const { fetch: stub, calls } = stubFetch((call) =>
    Promise.reject(
      new Error(`error sending request for url (${String(call.input)})`),
    )
  );
  await withDesktop(async ({ desktop }) => {
    const saved = await desktop.commands.execute("ai.connection.save", {
      provider: {
        id: "url-key-provider",
        label: "URL key",
        kind: "openai_compatible",
        base_url: "https://api.example.com/v1",
        auth_header: "",
        auth_scheme: "",
      },
    });
    assert(!saved.error, "the provider metadata must save without an inline key");
    const stored = await desktop.commands.execute("ai.secret.set", {
      provider_id: "url-key-provider",
      value: CREDENTIAL,
    });
    assert(!stored.error, "the credential must save");

    // The request URL carries the key, but provider metadata must not.
    const result = await desktop.commands.execute("ai.complete", {
      request_id: "url-key",
      provider_id: "url-key-provider",
      url: requestUrl,
      headers: { "content-type": "application/json" },
      body: { model: "custom" },
      timeout_ms: 5000,
    });
    assert(
      result.error?.code === "transport_unavailable",
      `expected a transport failure, got ${result.error?.code}`,
    );
    assert(
      calls.length === 1 && String(calls[0]!.input).includes(CREDENTIAL),
      "the fixture must really have sent the key inside the url",
    );
    const serialized = JSON.stringify(result);
    assert(
      !serialized.includes(CREDENTIAL),
      "the url key must not appear in the command result",
    );
    assert(
      !serialized.includes("api.example.com"),
      "the effective url must be replaced by <url>, not echoed",
    );
    assert(
      (result.error?.technical_message ?? "").includes("<url>"),
      "the technical message must show the <url> placeholder",
    );
    const log = await Deno.readTextFile(desktop.diagnostics.path);
    assert(
      !log.includes(CREDENTIAL) && !log.includes("api.example.com"),
      "neither the key nor the effective url may reach diagnostics.log",
    );
  }, { fetch: stub });
});

Deno.test("a short credential drops the whole provider excerpt", async () => {
  const { fetch: stub, calls } = stubFetch(() =>
    new Response(
      JSON.stringify({ error: { message: "RuntimeError: bad key or model" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    )
  );
  await withDesktop(async ({ desktop }) => {
    // `e` occurs all over the provider body: an unguarded exact replace would
    // turn `{"error":…` into `{"[REDACTED]rror":…`.  Instead, no provider text
    // is kept at all while such a credential is stored.
    const stored = await desktop.commands.execute("ai.secret.set", {
      provider_id: "deepseek",
      value: "e",
    });
    assert(!stored.error, "a one-character credential must still store");
    const result = await desktop.commands.execute("ai.complete", {
      ...COMPLETE_INPUT,
      request_id: "short-key",
    });
    assert(
      result.error?.code === "missing_credential",
      "the provider status must still map",
    );
    const details = result.error?.details as {
      detail?: unknown;
      status?: unknown;
      body_kind?: unknown;
      body_chars?: unknown;
    };
    const detail = String(details.detail ?? "");
    assert(
      detail === "[REDACTED]",
      `no provider text may be kept, got ${JSON.stringify(detail)}`,
    );
    assert(
      !detail.includes("[REDACTED]rror") &&
        !detail.includes("Runtim[REDACTED]"),
      "nothing is mangled because nothing is kept",
    );
    assert(
      !JSON.stringify(result).includes("RuntimeError"),
      "the provider body must not appear anywhere in the result",
    );
    assert(
      result.error?.technical_message === "AI provider returned 401",
      "unrelated messages must stay intact",
    );
    assert(
      details.status === 401 && details.body_kind === "json" &&
        (details.body_chars as number) > 0,
      "the structured triage fields must survive the dropped excerpt",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert(
      headers["authorization"] === "Bearer e",
      "the short credential must still be injected",
    );
  }, { fetch: stub });
});

Deno.test("ordinary identifiers survive the provider excerpt", async () => {
  const { fetch: stub } = stubFetch(() =>
    new Response(
      JSON.stringify({
        error: {
          message: "model deepseek-reasoner is not available for this account",
          model: "gpt-4o-mini-2024-07-18",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    )
  );
  await withDesktop(async ({ desktop }) => {
    await seedCredential(desktop);
    const result = await desktop.commands.execute("ai.complete", {
      ...COMPLETE_INPUT,
      request_id: "identifiers",
    });
    assert(
      result.error?.code === "provider_error",
      `expected a provider error, got ${result.error?.code}`,
    );
    const detail = String(
      (result.error?.details as { detail?: unknown }).detail ?? "",
    );
    assert(
      detail.includes("deepseek-reasoner"),
      `a lowercase identifier must survive, got ${JSON.stringify(detail)}`,
    );
    assert(
      detail.includes("not available for this account"),
      "prose must survive the excerpt",
    );
    assert(
      !detail.includes("gpt-4o-mini-2024-07-18") &&
        detail.includes("[REDACTED]"),
      "a digit-bearing identifier is still treated as credential-shaped",
    );
  }, { fetch: stub });
});

Deno.test("a lowercase digit-free key cannot slip through reversed", async () => {
  // The narrowed shape rule needs a digit or an uppercase letter, so this key's
  // reversed spelling is caught by the value-aware transform check instead.
  const key = "lowercaseonlysecretkey";
  const reversed = Array.from(key).reverse().join("");
  assert(
    !/[0-9A-Z]/.test(reversed),
    "the fixture must really be all lowercase with no digits",
  );
  const { fetch: stub } = stubFetch(() =>
    new Response(
      JSON.stringify({ error: { message: `invalid key ${reversed}` } }),
      { status: 403, headers: { "content-type": "application/json" } },
    )
  );
  await withDesktop(async ({ desktop }) => {
    const stored = await desktop.commands.execute("ai.secret.set", {
      provider_id: "deepseek",
      value: key,
    });
    assert(!stored.error, "the key must store");
    const result = await desktop.commands.execute("ai.complete", {
      ...COMPLETE_INPUT,
      request_id: "reversed-lowercase",
    });
    assert(
      result.error?.code === "permission_denied",
      "the provider status must still map",
    );
    assert(
      !JSON.stringify(result).includes(reversed) &&
        !JSON.stringify(result).includes(key),
      "neither the key nor its reversed spelling may survive",
    );
    const detail = String(
      (result.error?.details as { detail?: unknown }).detail ?? "",
    );
    assert(
      detail === "[REDACTED]",
      `the whole excerpt must be dropped, got ${JSON.stringify(detail)}`,
    );
    const log = await Deno.readTextFile(desktop.diagnostics.path);
    assert(
      !log.includes(reversed) && !log.includes(key),
      "diagnostics.log must stay clean too",
    );
  }, { fetch: stub });
});

Deno.test("a credential pasted into the instruction does not reach the executions file", async () => {
  await withDesktop(async ({ desktop, aiHome }) => {
    await seedCredential(desktop);
    const base64 = btoa(CREDENTIAL);
    const appended = await desktop.commands.execute("ai.execution.append", {
      record: {
        id: "pasted",
        instruction: `请用 ${CREDENTIAL} 这个密钥访问，或者用 ${base64}`,
        error_message: `Authorization: Bearer ${CREDENTIAL}`,
        status: "failed",
      },
    });
    assert(!appended.error, "the record must still be stored");
    const onDisk = await Deno.readTextFile(join(aiHome, "executions.json"));
    for (const form of [CREDENTIAL, base64]) {
      assert(
        !onDisk.includes(form),
        `the executions file must not carry the ${form.slice(0, 10)}… form`,
      );
    }
    assert(
      !onDisk.includes("9f8e7d6c"),
      "no fragment of the pasted credential may survive",
    );
    const stored = JSON.parse(onDisk) as Array<{
      instruction: string;
      error_message: string;
    }>;
    assert(
      stored[0]!.instruction.includes("[REDACTED]") &&
        stored[0]!.error_message.includes("[REDACTED]"),
      "the free text must be redacted in place, not dropped",
    );
    const listed = await desktop.commands.execute("ai.execution.list", {
      limit: 5,
    });
    assert(
      !JSON.stringify(listed.value).includes(CREDENTIAL),
      "listed records must be clean too",
    );
  });
});

Deno.test("diagnostics.log is created private like the AI store", async () => {
  const { fetch: stub } = stubFetch(() =>
    new Response(JSON.stringify({ error: { message: "denied" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  );
  await withDesktop(async ({ desktop }) => {
    await seedCredential(desktop);
    const result = await desktop.commands.execute("ai.complete", {
      ...COMPLETE_INPUT,
      request_id: "mode-check",
    });
    assert(result.error, "the provider must fail so the log is written");
    const stat = await Deno.stat(desktop.diagnostics.path);
    if (Deno.build.os === "windows" || stat.mode === null) return;
    assert(
      (stat.mode & 0o077) === 0,
      `diagnostics.log must not be group/world readable, got mode ${
        (stat.mode & 0o777).toString(8)
      }`,
    );
  }, { fetch: stub });
});

Deno.test("ai.complete refuses unsafe urls and unconfigured or keyless providers", async () => {
  const { fetch: stub, calls } = stubFetch(() => jsonResponse({ ok: true }));
  await withDesktop(async ({ desktop }) => {
    for (
      const url of [
        "http://api.example.com/v1/chat",
        "file:///etc/passwd",
        "ftp://api.example.com/v1",
        "not a url",
      ]
    ) {
      const result = await desktop.commands.execute("ai.complete", {
        provider_id: "deepseek",
        url,
        body: {},
      });
      assert(
        result.error?.code === "invalid_request",
        `${url} must be rejected with invalid_request, got ${result.error?.code}`,
      );
    }
    const local = await desktop.commands.execute("ai.complete", {
      request_id: "req-local",
      provider_id: "ollama",
      url: "http://127.0.0.1:11434/v1/chat/completions",
      body: { model: "local" },
    });
    assert(
      !local.error,
      `loopback http must be allowed, got ${JSON.stringify(local.error)}`,
    );
    assert(
      calls.length === 1 && String(calls[0]!.input).startsWith("http://127.0.0.1"),
      "only the loopback request may reach fetch",
    );

    const missingCredential = await desktop.commands.execute("ai.complete", {
      ...COMPLETE_INPUT,
      provider_id: "ghost",
    });
    assert(
      missingCredential.error?.code === "missing_credential",
      `a provider without a key must fail with missing_credential, got ${missingCredential.error?.code}`,
    );
    assert(
      (missingCredential.error?.user_message ?? "").includes("ghost"),
      "the failure must name the provider",
    );
    assert(
      calls.length === 1,
      "a missing credential must fail before any network call",
    );

    const notConfigured = await desktop.commands.execute("ai.complete", {
      provider_id: "ghost",
      body: {},
    });
    assert(
      notConfigured.error?.code === "not_configured",
      `an unknown provider without a url must fail with not_configured, got ${notConfigured.error?.code}`,
    );
  }, { fetch: stub });
});

Deno.test("ai.complete times out and stays cancellable", async () => {
  await withDesktop(async ({ desktop }) => {
    await seedCredential(desktop);
    const began = Date.now();
    const timedOut = await desktop.commands.execute("ai.complete", {
      ...COMPLETE_INPUT,
      request_id: "req-timeout",
      timeout_ms: 40,
    });
    assert(
      timedOut.error?.code === "timeout",
      `a hanging provider must fail with timeout, got ${timedOut.error?.code}`,
    );
    assert(
      Date.now() - began < 5000,
      "the timeout must not wait for the default 60s budget",
    );

    // A finished request id is a harmless no-op.
    const late = await desktop.commands.execute("ai.cancel", {
      request_id: "req-timeout",
    });
    assert(
      !late.error && (late.value as { cancelled: boolean }).cancelled === false,
      "cancelling a finished request must be a no-op",
    );
  }, { fetch: hangingFetch() });
});

Deno.test("ai.cancel aborts an in-flight request and never fails", async () => {
  let started: () => void = () => {};
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  await withDesktop(async ({ desktop }) => {
    await seedCredential(desktop);
    const pending = desktop.commands.execute("ai.complete", {
      ...COMPLETE_INPUT,
      request_id: "req-cancel",
      timeout_ms: 30_000,
    });
    await startedPromise;
    const cancelled = await desktop.commands.execute("ai.cancel", {
      request_id: "req-cancel",
    });
    assert(
      !cancelled.error &&
        (cancelled.value as { cancelled: boolean }).cancelled === true,
      "cancelling a live request must report cancelled=true",
    );
    const result = await pending;
    assert(
      result.error?.code === "cancelled",
      `a cancelled request must fail with cancelled, got ${result.error?.code}`,
    );
    const again = await desktop.commands.execute("ai.cancel", {
      request_id: "req-cancel",
    });
    assert(
      !again.error &&
        (again.value as { cancelled: boolean }).cancelled === false,
      "cancelling twice must stay a no-op",
    );
  }, { fetch: hangingFetch(() => started()) });
});

Deno.test("ai.execution records are sanitised, truncated and bounded to 200", async () => {
  await withDesktop(async ({ desktop, aiHome }) => {
    const appended = await desktop.commands.execute("ai.execution.append", {
      record: {
        id: "exec-1",
        project_id: "p1",
        status: "succeeded",
        outcome: "answer",
        instruction: "写一段导语",
        provider: { provider_id: "deepseek", model: "deepseek-chat" },
        capabilities: { tools: [], mcp: [], skills: [] },
      },
    });
    assert(!appended.error, "ai.execution.append must succeed");
    assert(
      (appended.value as { id: string }).id === "exec-1",
      "the record id must be returned",
    );

    const listed = await desktop.commands.execute("ai.execution.list", {
      limit: 10,
    });
    assert(!listed.error, "ai.execution.list must succeed");
    const records = (listed.value as { records: Array<Record<string, unknown>> })
      .records;
    assert(
      records.length === 1 && records[0]?.id === "exec-1",
      "the appended record must be listed",
    );

    const long = await desktop.commands.execute("ai.execution.append", {
      record: { id: "exec-2", instruction: "长".repeat(2500) },
    });
    assert(!long.error, "a long instruction must still be recorded");
    const truncated = await desktop.commands.execute("ai.execution.list", {
      limit: 10,
    });
    const first = (truncated.value as {
      records: Array<{ instruction: string }>;
    }).records[0]!;
    assert(
      first.instruction.length === 2000,
      `instruction must be capped at 2000 chars, got ${first.instruction.length}`,
    );

    const shaped = await desktop.commands.execute("ai.execution.append", {
      record: {
        id: "exec-3",
        instruction: "带密钥的记录",
        api_key: CREDENTIAL,
        nested: { deeper: { token: CREDENTIAL, password: "x", kept: 1 } },
        items: [{ authorization: CREDENTIAL, label: "ok" }],
      },
    });
    assert(!shaped.error, "credential-shaped keys must be stripped, not rejected");
    const onDisk = await Deno.readTextFile(join(aiHome, "executions.json"));
    assert(
      !onDisk.includes(CREDENTIAL) &&
        !onDisk.includes("api_key") &&
        !onDisk.includes("authorization") &&
        !onDisk.includes("token"),
      "credential-shaped keys must be stripped at every depth",
    );
    const stored = JSON.parse(onDisk) as Array<{
      id: string;
      nested?: { deeper?: Record<string, unknown> };
      items?: Array<Record<string, unknown>>;
    }>;
    const recorded = stored.find((entry) => entry.id === "exec-3");
    assert(
      recorded?.nested?.deeper?.kept === 1 &&
        recorded?.items?.[0]?.label === "ok",
      "non-credential fields must be preserved",
    );

    for (let index = 0; index < 205; index += 1) {
      const bulk = await desktop.commands.execute("ai.execution.append", {
        record: { id: `bulk-${index}`, status: "succeeded" },
      });
      assert(!bulk.error, `bulk append ${index} must succeed`);
    }
    const bounded = await desktop.commands.execute("ai.execution.list", {
      limit: 200,
    });
    const recent = (bounded.value as { records: Array<{ id: string }> }).records;
    assert(
      recent.length === 200 && recent[0]?.id === "bulk-204",
      "list must return at most 200 records, newest first",
    );
    const fileRecords = JSON.parse(
      await Deno.readTextFile(join(aiHome, "executions.json")),
    ) as Array<{ id: string }>;
    assert(
      fileRecords.length === 200 && fileRecords[0]?.id === "bulk-5",
      "the stored file must keep only the most recent 200 records",
    );
  });
});

Deno.test("ai.execution.append replaces an existing record id in place", async () => {
  await withDesktop(async ({ desktop, aiHome }) => {
    for (const id of ["run-1", "run-2", "run-3"]) {
      const seeded = await desktop.commands.execute("ai.execution.append", {
        record: { id, status: "succeeded", review: { state: "pending" } },
      });
      assert(!seeded.error, `seeding ${id} must succeed`);
    }
    // The user decision for an already-recorded run must update, not duplicate.
    const decided = await desktop.commands.execute("ai.execution.append", {
      record: {
        id: "run-2",
        status: "succeeded",
        outcome: "change_draft",
        review: { state: "applied", decided_at: "2024-01-01T00:00:00.000Z" },
      },
    });
    assert(
      !decided.error && (decided.value as { id: string }).id === "run-2",
      "a replace must report the same record id",
    );

    const listed = await desktop.commands.execute("ai.execution.list", {
      limit: 20,
    });
    const records = (listed.value as {
      records: Array<{
        id: string;
        outcome?: string;
        review: { state: string; decided_at?: string };
      }>;
    }).records;
    assert(
      records.length === 3,
      `a review decision must not add a row, got ${records.length}`,
    );
    assert(
      records.map((record) => record.id).join(",") === "run-3,run-2,run-1",
      `the replaced record must keep its position, got ${
        records.map((record) => record.id).join(",")
      }`,
    );
    const replaced = records[1]!;
    assert(
      replaced.review.state === "applied" &&
        replaced.review.decided_at === "2024-01-01T00:00:00.000Z" &&
        replaced.outcome === "change_draft",
      "the stored entry must be the new record",
    );
    assert(
      records[0]!.review.state === "pending" &&
        records[2]!.review.state === "pending",
      "the other records must be untouched",
    );

    const stored = JSON.parse(
      await Deno.readTextFile(join(aiHome, "executions.json")),
    ) as Array<{ id: string; review: { state: string } }>;
    assert(
      stored.length === 3 && stored[1]?.id === "run-2" &&
        stored[1]?.review.state === "applied",
      "the replace must also land on disk in the same position",
    );
  });
});

Deno.test("ai.execution.append mints an id for a record without one", async () => {
  await withDesktop(async ({ desktop }) => {
    const first = await desktop.commands.execute("ai.execution.append", {
      record: { status: "succeeded", instruction: "没有 id 的记录" },
    });
    assert(!first.error, "a record without an id must still be stored");
    const firstId = (first.value as { id: string }).id;
    assert(
      typeof firstId === "string" && firstId.length > 0,
      "a record without an id must be assigned one",
    );
    const second = await desktop.commands.execute("ai.execution.append", {
      record: { status: "succeeded" },
    });
    const secondId = (second.value as { id: string }).id;
    assert(secondId !== firstId, "each id-less record must get its own id");
    const listed = await desktop.commands.execute("ai.execution.list", {
      limit: 20,
    });
    const records = (listed.value as { records: Array<{ id: string }> })
      .records;
    assert(
      records.length === 2 &&
        records.every((record) =>
          typeof record.id === "string" && record.id.length > 0
        ),
      "both id-less records must be appended with their own id",
    );
    assert(
      records[0]?.id === secondId,
      "a minted-id record must be appended, never treated as a replace",
    );
  });
});

Deno.test("ai.execution.append collapses pre-existing duplicate ids", async () => {
  await withDesktop(async ({ desktop, aiHome }) => {
    const executionsPath = join(aiHome, "executions.json");
    await Deno.mkdir(aiHome, { recursive: true });
    // A log written by the earlier append-only build: one run could keep
    // several rows (the "4 records for 2 runs" symptom).
    const seeded = [
      { id: "run-3", status: "succeeded", review: { state: "pending" } },
      { id: "run-1", status: "succeeded", review: { state: "pending" } },
      { id: "run-1", status: "succeeded", review: { state: "applied" } },
      { id: "run-2", status: "succeeded", review: { state: "pending" } },
    ];
    await Deno.writeTextFile(executionsPath, JSON.stringify(seeded));

    const repaired = await desktop.commands.execute("ai.execution.append", {
      record: {
        id: "run-1",
        status: "succeeded",
        outcome: "change_draft",
        review: { state: "rejected", decided_at: "2024-02-02T00:00:00.000Z" },
      },
    });
    assert(
      !repaired.error && (repaired.value as { id: string }).id === "run-1",
      "collapsing a duplicate id must still report that id",
    );

    const stored = JSON.parse(
      await Deno.readTextFile(executionsPath),
    ) as Array<{
      id: string;
      outcome?: string;
      review: { state: string; decided_at?: string };
    }>;
    assert(
      stored.filter((entry) => entry.id === "run-1").length === 1,
      `exactly one run-1 row may survive, got ${
        stored.filter((entry) => entry.id === "run-1").length
      }`,
    );
    assert(
      stored.map((entry) => entry.id).join(",") === "run-3,run-1,run-2",
      `the first match must keep its position, got ${
        stored.map((entry) => entry.id).join(",")
      }`,
    );
    const survivor = stored[1]!;
    assert(
      survivor.review.state === "rejected" &&
        survivor.review.decided_at === "2024-02-02T00:00:00.000Z" &&
        survivor.outcome === "change_draft",
      "the surviving row must be the newly written record",
    );
    assert(
      stored[0]!.review.state === "pending" &&
        stored[2]!.review.state === "pending",
      "the unrelated records must be untouched",
    );

    const listed = await desktop.commands.execute("ai.execution.list", {
      limit: 20,
    });
    const records = (listed.value as {
      records: Array<{ id: string; review: { state: string } }>;
    }).records;
    assert(
      records.map((record) => record.id).join(",") === "run-2,run-1,run-3" &&
        records[1]?.review.state === "rejected",
      "the run must show exactly one row in the newest-first list too",
    );
  });
});

Deno.test("ai.execution.append keeps the 200-record bound and order after a replace", async () => {
  await withDesktop(async ({ desktop, aiHome }) => {
    const executionsPath = join(aiHome, "executions.json");
    await Deno.mkdir(aiHome, { recursive: true });
    const seeded = Array.from({ length: 200 }, (_value, index) => ({
      id: `run-${index}`,
      status: "succeeded",
      review: { state: "pending" },
    }));
    await Deno.writeTextFile(executionsPath, JSON.stringify(seeded));

    const replaced = await desktop.commands.execute("ai.execution.append", {
      record: { id: "run-0", status: "succeeded", review: { state: "rejected" } },
    });
    assert(!replaced.error, "replacing inside a full log must succeed");
    const afterReplace = JSON.parse(
      await Deno.readTextFile(executionsPath),
    ) as Array<{ id: string; review: { state: string } }>;
    assert(afterReplace.length === 200, "a replace must not grow the log");
    assert(
      afterReplace[0]?.id === "run-0" &&
        afterReplace[0]?.review.state === "rejected",
      "the replaced record must keep its oldest position on disk",
    );
    const listed = await desktop.commands.execute("ai.execution.list", {
      limit: 200,
    });
    const records = (listed.value as { records: Array<{ id: string }> }).records;
    assert(
      records.length === 200 && records[0]?.id === "run-199",
      "the newest-first head must be unchanged by a replace",
    );
    assert(
      records.at(-1)?.id === "run-0",
      "the replaced record must stay at the oldest end of the list",
    );

    const appended = await desktop.commands.execute("ai.execution.append", {
      record: { id: "run-new", status: "succeeded" },
    });
    assert(!appended.error, "appending to a full log must succeed");
    const final = JSON.parse(
      await Deno.readTextFile(executionsPath),
    ) as Array<{ id: string }>;
    assert(final.length === 200, "the 200-record bound must still hold");
    assert(
      final.filter((entry) => entry.id === "run-new").length === 1 &&
        final.at(-1)?.id === "run-new",
      "a new record must be appended at the newest end exactly once",
    );
    assert(
      final[0]?.id === "run-1" && !final.some((entry) => entry.id === "run-0"),
      "the oldest entry must be dropped first, even when it was just updated",
    );
  });
});

Deno.test("sanitizeExecutionRecord strips credentials and caps instructions", () => {
  // Real instructions are words, not one 2100-character opaque run: the shape
  // filter would (correctly) treat such a run as credential-shaped.
  const longInstruction = "写一段导语，说明本课目标。 ".repeat(200);
  assert(
    longInstruction.length > 2000,
    "the fixture must exceed the instruction cap",
  );
  const sanitized = sanitizeExecutionRecord({
    id: "r1",
    instruction: longInstruction,
    credential: CREDENTIAL,
    provider: { provider_id: "deepseek", access_token: CREDENTIAL },
    deep: { deeper: { deepest: { secret: CREDENTIAL, keep: "yes" } } },
  });
  assert(
    (sanitized.instruction as string).length === 2000,
    "instruction must be truncated to 2000 characters",
  );
  assert(
    !JSON.stringify(sanitized).includes(CREDENTIAL),
    "sanitised records must not contain a credential",
  );
  assert(
    !("credential" in sanitized) &&
      !("access_token" in (sanitized.provider as Record<string, unknown>)) &&
      (sanitized.deep as { deeper: { deepest: { keep: string } } }).deeper
          .deepest.keep === "yes",
    "credential-shaped keys must be removed without touching siblings",
  );
  const shaped = sanitizeExecutionRecord({
    instruction: `pasted ${CREDENTIAL} and ${btoa(CREDENTIAL)}`,
    error_message: "Authorization: Bearer sk-another-pasted-key-1234",
  });
  assert(
    String(shaped.instruction).includes("[REDACTED]") &&
      !String(shaped.instruction).includes(CREDENTIAL) &&
      !String(shaped.instruction).includes(btoa(CREDENTIAL)),
    "a pasted credential and its encoded form must be redacted from free text",
  );
  assert(
    !String(shaped.error_message).includes("sk-another-pasted-key-1234"),
    "a bearer value in an error message must be redacted",
  );
});

Deno.test("a failing execution append surfaces an AI-scoped error, not a save failure", async () => {
  await withDesktop(async ({ directory, desktop }) => {
    // Occupy the log path with a directory so the atomic write must fail.
    await Deno.mkdir(join(directory, ".workspace", "ai", "executions.json"), {
      recursive: true,
    });
    const result = await desktop.commands.execute("ai.execution.append", {
      record: { id: "exec-fail", instruction: "不会写入" },
    });
    assert(
      result.error?.code === "ai_execution_record_failed",
      `expected an AI-scoped failure, got ${result.error?.code}`,
    );
    assert(
      !/storage|external_modification|project_save|project_not_open/.test(
        result.error?.code ?? "",
      ),
      "an execution log failure must not look like a storage or save failure",
    );
    assert(
      (result.error?.user_message ?? "").includes("AI 执行记录"),
      "the message must say the AI log failed, not the course save",
    );
    const project = await desktop.queries.execute("project.get");
    const saved = await desktop.commands.execute("project.save", { project });
    assert(
      !saved.error,
      "course saving must keep working after an execution log failure",
    );
  });
});

Deno.test("AI commands require an open project and never leak a credential", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-ai-noproject-" });
  const desktop = new DesktopService(
    directory,
    { app_instance_id: `ai-noproject-${crypto.randomUUID()}` },
    new MemorySecretStore(),
    {},
  );
  try {
    const listed = await desktop.commands.execute("ai.connection.list", {});
    assert(!listed.error, "ai.connection.list must work before a project opens");
    assert(
      JSON.stringify(listed.value) ===
        JSON.stringify({ providers: [], configured: {} }),
      "with no project open the connection list must be empty",
    );
    const calls: Array<[string, unknown]> = [
      ["ai.connection.save", { provider: { id: "custom" } }],
      ["ai.connection.delete", { provider_id: "custom" }],
      ["ai.secret.set", { provider_id: "custom", value: CREDENTIAL }],
      ["ai.secret.delete", { provider_id: "custom" }],
      ["ai.complete", { provider_id: "custom", url: "https://example.com", body: {} }],
      ["ai.execution.append", { record: { id: "exec-x" } }],
      ["ai.execution.list", { limit: 5 }],
    ];
    const results: unknown[] = [listed];
    for (const [name, input] of calls) {
      const result = await desktop.commands.execute(name, input);
      results.push(result);
      assert(
        result.error?.code === "project_not_open",
        `${name} must require an open project, got ${result.error?.code}`,
      );
      assert(
        (result.error?.recommended_action ?? "").length > 0,
        `${name} must suggest how to fix the failure`,
      );
    }
    // Cancelling is idempotent: it must never fail, not even without a project.
    const cancelled = await desktop.commands.execute("ai.cancel", {
      request_id: "unknown-request",
    });
    assert(
      !cancelled.error &&
        (cancelled.value as { cancelled: boolean }).cancelled === false,
      "ai.cancel on an unknown id must be a harmless no-op",
    );
    results.push(cancelled);
    assert(
      !JSON.stringify(results).includes(CREDENTIAL),
      "no AI command result may contain the credential",
    );
    assert(
      !(await pathExists(join(directory, ".workspace", "ai", "providers.json"))),
      "failing AI commands must not create the AI store",
    );
  } finally {
    await desktop.close().catch(() => undefined);
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("AiTransport honours an injected ai_home and tolerates an empty project", async () => {
  const projectDirectory = await Deno.makeTempDir({ prefix: "acw-ai-project-" });
  const aiHome = await Deno.makeTempDir({ prefix: "acw-ai-home-" });
  try {
    const transport = new AiTransport(projectDirectory, {
      ai_home: aiHome,
      fetch: stubFetch(() => jsonResponse({})).fetch,
      credential_store: new MemorySecretStore(),
    });
    assert(
      await transport.listExecutionRecords().then((records) =>
        records.length === 0
      ),
      "listing records before any project exists must return an empty list",
    );
    await transport.setCredential("deepseek", CREDENTIAL);
    await transport.saveConnection({ provider: PROVIDER });
    assert(
      await pathExists(join(aiHome, "providers.json")),
      "ai_home must receive providers.json",
    );
    const connections = await transport.listConnections();
    assert(
      connections.configured.deepseek === true &&
        !JSON.stringify(connections).includes(CREDENTIAL),
      "the transport reports credential presence without the value",
    );
    const appended = await transport.appendExecutionRecord({ id: "exec-1" });
    assert(
      appended.id === "exec-1" &&
        await pathExists(join(aiHome, "executions.json")),
      "ai_home must receive executions.json",
    );
  } finally {
    await Deno.remove(projectDirectory, { recursive: true }).catch(() =>
      undefined
    );
    await Deno.remove(aiHome, { recursive: true }).catch(() => undefined);
  }
});
