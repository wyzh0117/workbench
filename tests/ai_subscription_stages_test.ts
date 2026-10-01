/**
 * V1 Post-v0.2.3 Item 9 (§10) — ChatGPT subscription failure stages.
 *
 * §10.1 forbids treating "login succeeded" as "integration works", so every
 * stage between sign-in and a completed inference must have its own readable
 * state: login, granted plan-usage scope, model list, selected model,
 * inference, and token refresh.  `app/ai.js#AI_SUBSCRIPTION_STAGES` is the
 * single table both shells read to render that state, and
 * `aiSubscriptionStage()` is its only accessor.
 *
 * Offline only: this asserts the *wording contract*.  §10.4/§10.6 online smokes
 * are recorded separately and never here — no credential exists in this file.
 */
import {
  AI_SUBSCRIPTION_STAGES,
  aiSubscriptionStage,
} from "../app/ai.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
}

/** The §10 stages that must each be distinguishable in the UI. */
const REQUIRED_STAGES = [
  "login",
  "plan_usage",
  "models",
  "model",
  "inference",
  "refresh",
];

Deno.test("§10 every stage between login and inference has a distinct code", () => {
  const stages = [...new Set(AI_SUBSCRIPTION_STAGES.map((entry) => entry.stage))];
  for (const stage of REQUIRED_STAGES) {
    assert(
      stages.includes(stage),
      `§10 阶段「${stage}」必须有对应的错误状态，不能并入其它阶段`,
    );
    const entries = AI_SUBSCRIPTION_STAGES.filter((entry) => entry.stage === stage);
    assert(
      entries.length >= 1,
      `阶段「${stage}」至少要有一个可辨识的 code`,
    );
  }
});

Deno.test("§10 codes are unique, prefixed and always fully worded", () => {
  const codes = AI_SUBSCRIPTION_STAGES.map((entry) => entry.code);
  assertEquals(
    [...new Set(codes)].length,
    codes.length,
    "code 必须唯一，否则两个阶段会互相覆盖",
  );
  for (const entry of AI_SUBSCRIPTION_STAGES) {
    assert(
      entry.code.startsWith("subscription_"),
      `订阅状态 code 必须自带命名空间（${entry.code}）`,
    );
    for (const field of ["label", "message", "action"] as const) {
      assert(
        typeof entry[field] === "string" && entry[field].trim().length > 0,
        `${entry.code} 的 ${field} 不能为空`,
      );
    }
    assert(
      REQUIRED_STAGES.includes(entry.stage),
      `${entry.code} 的阶段「${entry.stage}」必须属于 §10 的阶段集合`,
    );
    assert(
      !/api[_ ]?key|access[_ ]?token|refresh[_ ]?token\s*[:=]/i.test(
        `${entry.message} ${entry.action}`,
      ),
      `${entry.code} 的文案不能内嵌任何凭据值`,
    );
  }
});

Deno.test("§10.2 a logged-in account without plan usage says so explicitly", () => {
  const stage = aiSubscriptionStage("subscription_scope_missing");
  assert(stage !== null, "缺少套餐用量授权必须有独立状态");
  assertEquals(stage.stage, "plan_usage", "该状态属于套餐用量授权阶段");
  assert(
    stage.message.includes("ChatGPT 已登录，但没有授权套餐用量"),
    `必须说明已登录但缺授权，实际：${stage.message}`,
  );
  assert(
    stage.action.includes("plan usage"),
    "下一步必须引导重新授权 plan usage",
  );
  assert(
    stage.action.includes("重新授权"),
    "下一步必须是可执行的动作，而不是空模型列表",
  );
});

Deno.test("§10.3 model discovery and §10.4 inference stay separate stages", () => {
  const failedList = aiSubscriptionStage("subscription_models_request_failed");
  const emptyList = aiSubscriptionStage("subscription_models_empty");
  assert(
    failedList?.stage === "models" && emptyList?.stage === "models",
    "模型列表失败与列表为空都属于 models 阶段",
  );
  assert(
    (failedList?.action ?? "").includes("Model ID"),
    "§9.5：列表请求失败时仍要提示可以手动填写 Model ID",
  );
  assert(
    (emptyList?.message ?? "").includes("没有可用模型"),
    "空列表必须说清是当前账户没有可用模型，而不是请求失败",
  );
  const notSelected = aiSubscriptionStage("subscription_model_not_selected");
  assert(
    notSelected?.stage === "model" && notSelected !== null,
    "没有选出模型必须是独立于列表的 model 阶段",
  );
  const inference = aiSubscriptionStage("subscription_inference_failed");
  assertEquals(inference?.stage, "inference", "推理失败必须单独成阶段");
  assert(
    (inference?.message ?? "").includes("模型可选"),
    "推理失败必须说明模型已经可选，不能与登录失败混淆",
  );
  assert(
    (inference?.action ?? "").includes("没有改动课程内容"),
    "失败文案必须说明本次没有改动课程",
  );
});

Deno.test("§10.5 token refresh distinguishes「will refresh」from「refresh failed」", () => {
  const due = aiSubscriptionStage("subscription_refresh_required");
  const broken = aiSubscriptionStage("subscription_refresh_failed");
  assert(due !== null && broken !== null, "刷新必须有两种状态");
  assertEquals(due.stage, "refresh", "两种刷新状态同属 refresh 阶段");
  assert(
    due.code !== broken.code,
    "到点刷新与刷新失败必须是不同 code",
  );
  assert(
    (broken.action ?? "").includes("重新登录"),
    "刷新失败必须引导重新登录",
  );
  assert(
    (broken.action ?? "").includes("refresh_token"),
    "§10.5：必须说明一次性 refresh_token 不会被重复使用",
  );
});

Deno.test("§10 login-stage states cover cancel, callback, session and native-only", () => {
  const loginCodes = AI_SUBSCRIPTION_STAGES
    .filter((entry) => entry.stage === "login")
    .map((entry) => entry.code);
  for (const code of [
    "subscription_cancelled",
    "subscription_callback_failed",
    "subscription_session_unavailable",
    "subscription_native_only",
  ]) {
    assert(
      loginCodes.includes(code),
      `${code} 必须归在 login 阶段，不能伪装成模型或推理失败`,
    );
  }
  const nativeOnly = aiSubscriptionStage("subscription_native_only");
  assert(
    (nativeOnly?.message ?? "").includes("macOS"),
    "原生壳专属能力必须说明需要 macOS 桌面版",
  );
  const cancelled = aiSubscriptionStage("subscription_cancelled");
  assert(
    (cancelled?.action ?? "").includes("不会保存任何凭据"),
    "取消登录必须说明没有保存任何凭据",
  );
});

Deno.test("aiSubscriptionStage returns copies and null for anything it does not own", () => {
  const first = aiSubscriptionStage("subscription_models_empty");
  assert(first !== null, "已知的 code 必须返回状态");
  first.label = "被改坏了";
  assertEquals(
    aiSubscriptionStage("subscription_models_empty")?.label,
    "模型列表",
    "返回的必须是副本，不能污染状态表",
  );
  for (
    const unknown of [
      "not_a_subscription_code",
      "missing_credential",
      "rate_limited",
      "",
      null,
      undefined,
      42,
      { code: "subscription_cancelled" },
    ]
  ) {
    assertEquals(
      aiSubscriptionStage(unknown),
      null,
      `未知 code（${String(unknown)}）必须返回 null，让 transport 自己兜底`,
    );
  }
});
