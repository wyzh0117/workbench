/**
 * V1 Post-v0.2.3 Item 8 (§9) — Model settings rebuilt on DSH's provider UX.
 *
 * The governing invariant is §9.2: Workbench ships *no* preset provider
 * templates (Volcengine/Doubao, OpenAI, Anthropic, DeepSeek, …).  Everything a
 * request needs must come from an explicit, user-created connection record, so
 * these tests pin down three things:
 *
 *   1. the only shipped catalogue left is the three API protocols of §9.4;
 *   2. `normalizeAiConnection` / `aiModelDiscoveryPlan` refuse a bare id and
 *      validate an explicit record instead;
 *   3. model discovery is derived per protocol and is a convenience, never a
 *      prerequisite (§9.5) — and it never carries a credential.
 *
 * Offline by construction: no network, no live provider, no credential in any
 * fixture.  `CREDENTIAL_STANDIN` is a recognisable-but-fake marker whose only
 * job is to prove the value cannot be echoed.
 */
import * as aiModule from "../app/ai.js";
import {
  AI_API_PROTOCOLS,
  AI_OFFLINE_PROVIDER_ID,
  AiFailure,
  aiApiProtocolChoices,
  aiApiProtocolLabel,
  aiIsKnownApiProtocol,
  aiIsOfflineConnection,
  aiModelDiscoveryPlan,
  normalizeAiConnection,
} from "../app/ai.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
}

/** Await an expected AiFailure and return it so the message can be asserted. */
function assertAiFailure(fn: () => unknown, code: string, message: string): AiFailure {
  let thrown: unknown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof AiFailure, `${message}: 抛出的不是 AiFailure（${String(thrown)}）`);
  const failure = thrown as AiFailure;
  assert(
    failure.code === code,
    `${message}: 期望 ${code}，实际 ${failure.code}（${failure.message}）`,
  );
  assert(
    typeof failure.recommended_action === "string" &&
      failure.recommended_action.length > 0,
    `${message}: 错误必须带 recommended_action`,
  );
  return failure;
}

/** Not a key: a marker used only to prove no credential is ever echoed. */
const CREDENTIAL_STANDIN = "standin-value-never-a-real-key";

/** The §9.4 field set, exactly as the Settings → Models form submits it.
 *
 * Note the form has no auth-header or auth-scheme field: the protocol decides
 * both, so a saved record simply omits them.
 */
function formRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "my-provider",
    label: "我的模型连接",
    kind: "openai_compatible",
    api_protocol: "openai-completions",
    base_url: "https://gateway.example.test/v1",
    chat_path: "/chat/completions",
    default_model: "model-a",
    models: ["model-a", "model-b"],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * §9.2 / §9.4 — the only catalogue left is the protocol list
 * ------------------------------------------------------------------ */

Deno.test("§9.4 offers exactly three API protocol choices with DSH's labels", () => {
  const choices = aiApiProtocolChoices();
  assertEquals(
    choices.map((choice) => choice.id),
    ["openai-completions", "openai-responses", "anthropic-messages"],
    "协议 id 列表必须恰好是 §9.4 的三项",
  );
  assertEquals(
    choices.map((choice) => choice.label),
    ["OpenAI Chat Completions", "OpenAI Responses", "Anthropic Messages"],
    "协议显示名必须与 §9.4 的措辞逐字一致",
  );
  assertEquals(
    AI_API_PROTOCOLS.length,
    3,
    "协议目录必须只有三项，不能夹带服务商模板",
  );
  for (const choice of choices) {
    assert(
      aiIsKnownApiProtocol(choice.id) === true,
      `${choice.id} 必须是可用协议`,
    );
    assertEquals(
      aiApiProtocolLabel(choice.id),
      choice.label,
      `${choice.id} 的显示名必须来自同一份目录`,
    );
  }
});

Deno.test("protocol choices are copies and unknown protocols read as unknown", () => {
  const first = aiApiProtocolChoices();
  first[0]!.label = "被改坏了";
  first[0]!.id = "injected-provider";
  first.push({ id: "extra", label: "Extra" });
  assertEquals(
    aiApiProtocolChoices().map((choice) => choice.id),
    ["openai-completions", "openai-responses", "anthropic-messages"],
    "外部修改返回值不能污染目录",
  );
  assertEquals(aiApiProtocolLabel("openai"), "", "未知协议不能返回显示名");
  assertEquals(aiApiProtocolLabel(null), "", "非字符串也不能被当成协议");
  assert(!aiIsKnownApiProtocol("deepseek"), "服务商 id 不是协议 id");
  assert(!aiIsKnownApiProtocol(""), "空值不是协议");
});

Deno.test("§9.2 no shipped provider-template catalogue survives in the module", () => {
  const exports = aiModule as unknown as Record<string, unknown>;
  for (const removed of [
    "AI_PROVIDER_PRESETS",
    "aiProviderPreset",
    "aiProviderDescriptors",
    "aiProviderCatalog",
    "resolvePreset",
  ]) {
    assert(
      exports[removed] === undefined,
      `${removed} 必须已从 app/ai.js 移除（§9.2 不再内置服务商模板）`,
    );
  }
  // And nothing similarly named took its place.
  const leftovers = Object.keys(exports).filter((name) =>
    /preset|template|catalog/i.test(name)
  );
  assertEquals(leftovers, [], "导出符号里不能残留模板目录类的名字");
});

Deno.test("§9.2 the offline connector is a code path, not a catalogue entry", () => {
  assertEquals(AI_OFFLINE_PROVIDER_ID, "fake", "离线连接器的 id 必须稳定");
  assert(
    aiIsOfflineConnection(AI_OFFLINE_PROVIDER_ID) === true,
    "按 id 必须能识别离线连接器",
  );
  assert(
    aiIsOfflineConnection(formRecord({ id: AI_OFFLINE_PROVIDER_ID })) === true,
    "按记录也必须能识别离线连接器",
  );
  assert(
    aiIsOfflineConnection(formRecord({ kind: "fake" })) === true,
    "kind 为 fake 的记录就是离线连接器",
  );
  assert(
    aiIsOfflineConnection(formRecord()) === false,
    "用户自建连接不能被认成离线连接器",
  );
  assert(!aiIsOfflineConnection(null), "空值不是离线连接器");
  assert(
    !AI_API_PROTOCOLS.some((choice) => choice.id === AI_OFFLINE_PROVIDER_ID),
    "离线连接器不能出现在协议目录里",
  );
});

/* ------------------------------------------------------------------ *
 * §9.3 / §9.4 — explicit connection records
 * ------------------------------------------------------------------ */

Deno.test("§9.2 normalizeAiConnection rejects a bare provider id", () => {
  for (
    const bare of ["deepseek", "doubao", "openai", "custom", "fake", "  nope  ", ""]
  ) {
    const failure = assertAiFailure(
      () => normalizeAiConnection(bare),
      "not_configured",
      `id 字符串「${bare}」不能仍被解析成默认配置`,
    );
    assert(
      failure.message.includes("不再内置服务商模板"),
      `必须说明 Workbench 不再内置服务商模板（${bare}）`,
    );
    assert(
      failure.recommended_action.includes("设置 → 模型"),
      "必须引导用户去「设置 → 模型」新建连接",
    );
    assert(!failure.message.includes(CREDENTIAL_STANDIN), "错误不得回显密钥");
  }
});

Deno.test("normalizeAiConnection rejects a missing connection readably", () => {
  for (const empty of [null, undefined, 0, true, false, NaN]) {
    const failure = assertAiFailure(
      () => normalizeAiConnection(empty),
      "not_configured",
      `空连接（${String(empty)}）必须报 not_configured`,
    );
    assert(
      failure.message.includes("设置 → 模型"),
      "必须把用户指回「设置 → 模型」",
    );
  }
});

Deno.test("§9.4 Provider ID is required and stays the record's identity", () => {
  for (const bad of ["", "   ", null, undefined, 0, {}, []]) {
    const failure = assertAiFailure(
      () => normalizeAiConnection(formRecord({ id: bad })),
      "invalid_request",
      `Provider ID 为 ${JSON.stringify(bad)} 时必须被拒绝`,
    );
    assert(
      failure.message.includes("Provider ID"),
      "错误必须点名缺的是 Provider ID",
    );
  }
  // A record with no fields at all is the same missing-id case, not a template.
  assertAiFailure(
    () => normalizeAiConnection({}),
    "invalid_request",
    "空对象必须按缺少 Provider ID 报错",
  );
  // Surrounding whitespace is trimmed, never silently accepted as another id.
  assertEquals(
    normalizeAiConnection(formRecord({ id: "  spaced-id  " })).id,
    "spaced-id",
    "Provider ID 必须去除首尾空白",
  );
});

Deno.test("§9.4 display name is editable and independent of the id", () => {
  const created = normalizeAiConnection(
    formRecord({ id: "stable-id", label: "第一次起的名字" }),
  );
  assertEquals(created.label, "第一次起的名字", "显示名必须按用户填写保存");
  const renamed = normalizeAiConnection(
    formRecord({ id: "stable-id", label: "改过的名字" }),
  );
  assertEquals(renamed.label, "改过的名字", "显示名必须可以修改");
  assertEquals(renamed.id, "stable-id", "显示名改动不能影响 Provider ID");
  // An empty display name falls back to the id so the list row is never blank.
  assertEquals(
    normalizeAiConnection(formRecord({ label: "   " })).label,
    "my-provider",
    "显示名为空时必须回退到 Provider ID",
  );
});

Deno.test("§9.4 normalizeAiConnection rejects an unknown API protocol", () => {
  for (const protocol of ["openai", "azure-openai", "OPENAI-COMPLETIONS", "nope"]) {
    const failure = assertAiFailure(
      () => normalizeAiConnection(formRecord({ api_protocol: protocol })),
      "invalid_request",
      `未知协议「${protocol}」必须被拒绝`,
    );
    assert(
      failure.message.includes("不支持的 API 协议"),
      "错误必须说明协议不支持",
    );
    for (const label of aiApiProtocolChoices().map((choice) => choice.label)) {
      assert(
        failure.message.includes(label),
        `错误必须列出可选项（缺少 ${label}）`,
      );
    }
  }
});

Deno.test("§9.4 auth header and scheme are derived per protocol", () => {
  // A record coming from the §9.4 form carries no auth fields at all.
  const defaults = normalizeAiConnection(formRecord());
  assertEquals(defaults.auth_header, "authorization", "OpenAI 系协议默认 authorization");
  assertEquals(defaults.auth_scheme, "Bearer", "OpenAI 系协议默认 Bearer 方案");

  const responses = normalizeAiConnection(
    formRecord({ api_protocol: "openai-responses" }),
  );
  assertEquals(responses.auth_header, "authorization", "Responses 同样使用 authorization");
  assertEquals(responses.auth_scheme, "Bearer", "Responses 同样使用 Bearer");

  const anthropic = normalizeAiConnection(
    formRecord({ api_protocol: "anthropic-messages" }),
  );
  assertEquals(anthropic.auth_header, "x-api-key", "Anthropic 使用 x-api-key");
  assertEquals(anthropic.auth_scheme, "", "Anthropic 的密钥不带方案前缀");

  // An explicit choice always wins over the protocol default.
  const custom = normalizeAiConnection(
    formRecord({ api_protocol: "anthropic-messages", auth_header: "authorization", auth_scheme: "Bearer" }),
  );
  assertEquals(custom.auth_header, "authorization", "显式鉴权头必须被尊重");
  assertEquals(custom.auth_scheme, "Bearer", "显式鉴权方案必须被尊重");
  const bare = normalizeAiConnection(formRecord({ auth_scheme: "Token" }));
  assertEquals(bare.auth_scheme, "Token", "非 Bearer 方案不能被改写");

  // An explicitly submitted "" scheme means "send the bare value" (documented
  // in app/ai.js): the form therefore must not blank out an OpenAI scheme.
  const blankScheme = normalizeAiConnection(formRecord({ auth_scheme: "" }));
  assertEquals(blankScheme.auth_scheme, "", "显式空方案表示不带前缀");
  assertEquals(blankScheme.auth_header, "authorization", "显式空方案不改变头名");
});

Deno.test("normalizeAiConnection keeps only connection fields and copies them", () => {
  const source = formRecord({
    requires_credential: true,
    api_key: CREDENTIAL_STANDIN,
    credential: CREDENTIAL_STANDIN,
  });
  const normalized = normalizeAiConnection(source);
  assertEquals(
    Object.keys(normalized).sort(),
    [
      "api_protocol",
      "auth_header",
      "auth_scheme",
      "base_url",
      "chat_path",
      "default_model",
      "id",
      "kind",
      "label",
      "models",
    ],
    "规范化结果只能携带连接字段：UI 标记与密钥都不属于它",
  );
  const serialized = JSON.stringify(normalized);
  assert(!serialized.includes(CREDENTIAL_STANDIN), "凭据不能进入连接记录");
  // Defensive copy: editing the result must not touch the caller's record.
  normalized.label = "被改坏了";
  normalized.models.push("injected");
  assertEquals(source.label, "我的模型连接", "输入记录不能被返回值牵连");
  assertEquals(source.models, ["model-a", "model-b"], "模型列表必须是副本");
});

Deno.test("§9.4 model catalog fields are trimmed, deduped and optional", () => {
  assertEquals(
    normalizeAiConnection(
      formRecord({ models: [" model-a ", "model-a", "", null, "model-b"] }),
    ).models,
    ["model-a", "model-b"],
    "模型目录必须去除空白与重复项",
  );
  assertEquals(
    normalizeAiConnection(formRecord({ models: "not-an-array" })).models,
    [],
    "非数组的模型目录必须降级为空目录",
  );
});

Deno.test("§9.5 a connection with zero models is still valid", () => {
  const noModels = normalizeAiConnection(
    formRecord({ models: [], default_model: "" }),
  );
  assertEquals(noModels.models, [], "零模型连接的目录就是空的");
  assertEquals(noModels.default_model, "", "还没有默认模型也是合法状态");
  assertEquals(noModels.id, "my-provider", "零模型不影响连接身份");
  assertEquals(noModels.api_protocol, "openai-completions", "协议仍然可用");
});

/* ------------------------------------------------------------------ *
 * §9.5 — model discovery
 * ------------------------------------------------------------------ */

Deno.test("§9.5 discovery derives {base}/models for every protocol", () => {
  for (const choice of aiApiProtocolChoices()) {
    const plan = aiModelDiscoveryPlan(formRecord({ api_protocol: choice.id }));
    assertEquals(
      plan.endpoint,
      "https://gateway.example.test/v1/models",
      `${choice.label} 的模型列表地址必须由 Base URL 派生`,
    );
    assertEquals(
      plan.protocol_label,
      choice.label,
      `${choice.label} 必须带自己的显示名`,
    );
    assertEquals(
      plan.headers["accept"],
      "application/json",
      "模型列表必须声明接受 JSON",
    );
  }
});

Deno.test("§9.5 discovery sends anthropic-version only for Anthropic", () => {
  const anthropic = aiModelDiscoveryPlan(
    formRecord({ api_protocol: "anthropic-messages" }),
  );
  assertEquals(
    anthropic.headers["anthropic-version"],
    "2023-06-01",
    "Anthropic 模型列表必须带版本头",
  );
  for (const id of ["openai-completions", "openai-responses"]) {
    const plan = aiModelDiscoveryPlan(formRecord({ api_protocol: id }));
    assert(
      !("anthropic-version" in plan.headers),
      `${id} 不能发送 anthropic-version`,
    );
  }
});

Deno.test("§9.5 discovery names the auth header but never a credential", () => {
  for (
    const protocol of ["openai-completions", "openai-responses", "anthropic-messages"]
  ) {
    const plan = aiModelDiscoveryPlan(
      formRecord({
        api_protocol: protocol,
        base_url: "https://gateway.example.test/v1/",
      }),
    );
    const serialized = JSON.stringify(plan);
    assert(!serialized.includes(CREDENTIAL_STANDIN), "计划里绝不能出现密钥值");
    assert(!serialized.includes("api_key"), "计划不能携带 api_key 字段");
    for (const value of Object.values(plan.headers)) {
      assert(
        !/key|token|secret|bearer|sk-/i.test(value),
        `探测请求头只能是协议元数据，不能像凭据（${value}）`,
      );
    }
    assertEquals(
      plan.endpoint,
      "https://gateway.example.test/v1/models",
      "Base URL 末尾斜杠必须被规整",
    );
    assert(
      !(protocol === "anthropic-messages") || plan.auth_header === "x-api-key",
      "Anthropic 必须声明 x-api-key 头名（由 transport 填入受保护密钥）",
    );
  }
  // The header *name* travels; the value never does.
  const openai = aiModelDiscoveryPlan(formRecord());
  assertEquals(openai.auth_header, "authorization", "鉴权头名必须交给 transport");
  assertEquals(openai.auth_scheme, "Bearer", "鉴权方案必须交给 transport");
  assert(
    !("authorization" in openai.headers),
    "探测计划不能自己写入 authorization 头的值",
  );
});

Deno.test("§9.5 discovery without a Base URL fails and keeps manual entry open", () => {
  const failure = assertAiFailure(
    () => aiModelDiscoveryPlan(formRecord({ base_url: "   " })),
    "not_configured",
    "缺 Base URL 时不能凭空探测模型列表",
  );
  assert(
    failure.message.includes("Base URL"),
    "错误必须指出缺的是 Base URL",
  );
  assert(
    failure.recommended_action.includes("手动填写 Model ID"),
    "必须告知仍可手动填写 Model ID（§9.5）",
  );
  // A bare id is still the §9.2 error, not a missing-Base-URL error.
  const byId = assertAiFailure(
    () => aiModelDiscoveryPlan("deepseek"),
    "not_configured",
    "探测也不能按 id 取内置模板",
  );
  assert(
    byId.message.includes("不再内置服务商模板"),
    "必须说明 Workbench 不再内置服务商模板",
  );
});

Deno.test("§9.5 discovery works for a connection that has no models yet", () => {
  const fresh = normalizeAiConnection(
    formRecord({ models: [], default_model: "", id: "brand-new" }),
  );
  const plan = aiModelDiscoveryPlan(fresh);
  assertEquals(
    plan.endpoint,
    "https://gateway.example.test/v1/models",
    "新连接即使目录为空也必须可以探测",
  );
  assertEquals(plan.protocol_label, "OpenAI Chat Completions", "探测计划要显示协议名");
  // Nothing discovered is persisted by the plan itself (§9.5).
  assertEquals(fresh.models, [], "生成探测计划不能改动连接的模型目录");
});
