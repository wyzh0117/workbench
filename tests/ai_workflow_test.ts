/**
 * V0-T03 Workstream A — AI Workflow core tests (`app/ai.js`).
 *
 * Everything here runs offline against the deterministic connector and an
 * injected fake transport: no credential, no network, no live provider.  The
 * case that matters most is the last one — AI rows written by this module must
 * still pass the canonical serializer, otherwise autosave would break for any
 * project that ever used the AI panel.
 */
import {
  AI_EXECUTION_OUTCOME,
  AI_EXECUTION_STATUS,
  AI_FAILURE_CODES,
  AI_PROVIDER_PRESETS,
  AiFailure,
  FakeAiConnector,
  HttpAiConnector,
  aiChangeDraftDiffRows,
  aiContextPreviewLines,
  aiContextPromptPayload,
  aiProviderDescriptors,
  aiProviderPreset,
  applyAiChangeDraft,
  assembleAiContext,
  buildAiExecutionRecord,
  buildAiProviderCall,
  createAiChangeDraft,
  createAiSuggestion,
  normalizeAiProviderResponse,
  parseAiAnswer,
  rejectAiChangeDraft,
  validateAiChangeDraft,
} from "../app/ai.js";
import {
  addAsset,
  addAssetUsage,
  appendBlock,
  createEmptyProjectData,
  insertPlaceholder,
} from "../src/domain/index.ts";
import { serializeProject, validateProjectData } from "../src/domain/store.ts";
import type { Block, ChangeDraft, ProjectData } from "../src/domain/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
}

/** Await an expected AiFailure and return it so the message can be asserted. */
async function assertAiFailure(
  fn: () => unknown,
  code: string,
  message: string,
): Promise<AiFailure> {
  let thrown: unknown = null;
  try {
    await fn();
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
    typeof failure.message === "string" && failure.message.length > 0,
    `${message}: 错误必须带可读信息`,
  );
  assert(
    typeof failure.recommended_action === "string" &&
      failure.recommended_action.length > 0,
    `${message}: 错误必须带 recommended_action`,
  );
  return failure;
}

const LESSON_ONE_BODY =
  "第一课的第一段正文：这里是完整内容，课级AI上下文必须能看到它，因为它是本次目标课次的一部分。";
const LESSON_ONE_SECOND =
  "第一课的第二段正文：这一段的完整内容不应该出现在区块级上下文里，因为它已经超过结构摘要的长度限制。";
const LESSON_TWO_BODY =
  "第二课的正文：这一课的内容绝对不能被发送到第一课的课级或区块级上下文里，用来验证跨课泄漏。";
const SECRET_VALUE = "sk-live-abcdefghijklmnopqrstuvwxyz012345";

function aiFixture() {
  const data = createEmptyProjectData("AI Workflow 测试");
  const projectId = data.project.id;
  const stamp = "2026-01-01T00:00:00.000Z";
  const stageA = {
    id: "stage-a",
    project_id: projectId,
    parent_stage_id: null,
    code: "S01",
    title: "第一阶段",
    description: "",
    learning_action: "",
    order_index: 0,
    archived: false,
    created_at: stamp,
    updated_at: stamp,
  };
  const stageB = {
    ...stageA,
    id: "stage-b",
    code: "S02",
    title: "第二阶段",
    order_index: 1,
  };
  data.stages.push(stageA, stageB);
  const makeLesson = (
    id: string,
    stageId: string,
    code: string,
    title: string,
    order: number,
  ) => {
    const documentId = `doc-${id}`;
    data.documents.push({
      id: documentId,
      content_item_id: id,
      schema_version: data.schema_version,
      created_at: stamp,
      updated_at: stamp,
    });
    data.content_items.push({
      id,
      project_id: projectId,
      stage_id: stageId,
      code,
      title,
      type: "lesson",
      description: "",
      order_index: order,
      document_id: documentId,
      archived: false,
      created_at: stamp,
      updated_at: stamp,
    });
  };
  makeLesson("lesson-1", "stage-a", "S01-01", "第一课", 0);
  makeLesson("lesson-2", "stage-a", "S01-02", "第二课", 1);
  makeLesson("lesson-3", "stage-b", "S02-01", "第三课", 0);

  const heading = appendBlock(data, "lesson-1", "heading", "开场");
  const first = appendBlock(data, "lesson-1", "paragraph", LESSON_ONE_BODY);
  const second = appendBlock(data, "lesson-1", "paragraph", LESSON_ONE_SECOND);
  appendBlock(data, "lesson-2", "paragraph", LESSON_TWO_BODY);
  // `appendBlock` stamps the real clock; pin it so the fixture (and every
  // "updated_at must change" assertion) is stable across runs.
  for (const block of data.blocks) {
    block.created_at = stamp;
    block.updated_at = stamp;
  }

  // A project that has ever used AI holds settings that must never ship.
  data.project.settings = { api_key: SECRET_VALUE, theme: "light" };

  return { data, heading, first, second };
}

const FULL_INCLUDE = {
  requirements: true,
  assets: true,
  completion: true,
  nearby: true,
};

function allItemText(context: { items: Array<{ content: string }> }): string {
  return context.items.map((item) => item.content).join("\n---\n");
}

/* ------------------------------------------------------------------ *
 * Context assembly
 * ------------------------------------------------------------------ */

Deno.test("course scope ships the whole course and stays traceable", () => {
  const { data, first } = aiFixture();
  const context = assembleAiContext(data, {
    scope: "course",
    content_item_id: "lesson-2",
    instruction: "给整门课提三个改进方向",
    include: FULL_INCLUDE,
  });
  assertEquals(context.scope.kind, "course", "范围类型必须是 course");
  assertEquals(
    context.scope.content_item_id,
    "lesson-2",
    "课程范围必须解析出一个具体的可修改课次（活动的课次优先）",
  );
  assert(
    context.scope.label.includes("整门课程") &&
      context.scope.label.includes("S01-02"),
    `课程范围标签必须如实说明目标课次：${context.scope.label}`,
  );
  assertEquals(context.course.lesson_count, 3, "课程摘要必须统计全部课次");
  assertEquals(context.course.stage_count, 2, "课程摘要必须统计阶段数");
  assertEquals(context.lesson?.id, "lesson-2", "课次投影必须指向目标课次");
  const text = allItemText(context);
  assert(text.includes(LESSON_ONE_BODY), "课程范围必须包含第一课正文");
  assert(text.includes(LESSON_TWO_BODY), "课程范围必须包含第二课正文");
  assert(
    context.items.some((item) => item.source_type === "course_map"),
    "必须有一个课程地图投影条目",
  );
  assertEquals(
    context.payload_chars,
    context.items.reduce((sum, item) => sum + item.chars, 0),
    "payload_chars 必须等于条目字数之和",
  );
  for (const item of context.items) {
    assert(item.chars === item.content.length, "chars 必须等于 content 长度");
    assert(item.source_id.length > 0, "每个条目都必须能追溯回 canonical 行");
    assert(
      item.source_type !== "document" ||
        data.documents.some((document) => document.id === item.source_id),
      `document 条目必须指向真实文档：${item.source_id}`,
    );
    assert(
      item.source_type !== "requirement" ||
        data.requirements.some((row) => row.id === item.source_id),
      `requirement 条目必须指向真实待补：${item.source_id}`,
    );
    assert(
      item.source_type !== "asset" ||
        data.assets.some((row) => row.id === item.source_id),
      `asset 条目必须指向真实素材：${item.source_id}`,
    );
    void first;
  }
});

Deno.test("lesson and block scope never ship another lesson's body", () => {
  const { data, first } = aiFixture();
  const lessonContext = assembleAiContext(data, {
    scope: "lesson",
    content_item_id: "lesson-1",
    include: FULL_INCLUDE,
  });
  const lessonText = allItemText(lessonContext);
  assert(lessonText.includes(LESSON_ONE_BODY), "课级范围必须包含本课正文");
  assert(
    !lessonText.includes(LESSON_TWO_BODY),
    "课级范围不能包含其他课次的正文",
  );
  assertEquals(
    lessonContext.excluded.filter((entry) =>
      entry.reason.includes("其他课次")
    ).length,
    1,
    "必须如实声明其他课次的正文没有发送",
  );

  const blockContext = assembleAiContext(data, {
    scope: "block",
    content_item_id: "lesson-1",
    block_id: first.id,
    include: FULL_INCLUDE,
  });
  const blockText = allItemText(blockContext);
  assert(blockText.includes(LESSON_ONE_BODY), "区块范围必须包含目标区块全文");
  assert(
    !blockText.includes(LESSON_TWO_BODY),
    "区块范围不能包含其他课次正文",
  );
  assert(
    !blockText.includes(LESSON_ONE_SECOND),
    "区块范围不能包含本课其他区块的完整正文",
  );
  assertEquals(
    blockContext.block?.id,
    first.id,
    "block 投射必须指向目标区块",
  );
  assert(
    blockContext.items.some((item) =>
      item.label.includes("本课结构")
    ),
    "区块范围必须发送本课结构摘要",
  );
  assert(
    blockContext.excluded.some((entry) =>
      entry.reason.includes("区块范围")
    ),
    "区块范围必须如实声明本课其他正文没有发送",
  );
});

Deno.test("context assembly is deterministic and never mutates canonical data", () => {
  const { data, first } = aiFixture();
  const before = JSON.stringify(data);
  const input = {
    scope: "block" as const,
    content_item_id: "lesson-1",
    block_id: first.id,
    instruction: "把这一段改得更适合新手",
    include: FULL_INCLUDE,
  };
  const one = assembleAiContext(data, input);
  const two = assembleAiContext(data, input);
  assertEquals(one.items, two.items, "相同输入必须产生逐字节相同的 items");
  assertEquals(one, two, "相同输入必须产生相同的上下文");
  assertEquals(JSON.stringify(data), before, "装配上下文必须是纯读操作");
  assertEquals(data.context_packs.length, 0, "装配上下文不能新增 canonical 行");
  assertEquals(data.suggestions.length, 0, "装配上下文不能新增建议");
});

Deno.test("context limits are reported honestly instead of dropping silently", () => {
  const { data } = aiFixture();
  // Four lessons of ~20k characters exceed the 60k total budget, and every
  // single lesson exceeds the per-item clamp.
  const filler = "这是一段很长的课程正文，用来测试上下文长度上限。".repeat(1200);
  const makeLesson = (id: string, code: string, order: number) => {
    const documentId = `doc-${id}`;
    data.documents.push({
      id: documentId,
      content_item_id: id,
      schema_version: data.schema_version,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    data.content_items.push({
      id,
      project_id: data.project.id,
      stage_id: "stage-b",
      code,
      title: `${code} 长课`,
      type: "lesson",
      description: "",
      order_index: order,
      document_id: documentId,
      archived: false,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    appendBlock(data, id, "paragraph", filler);
  };
  makeLesson("lesson-long-1", "S02-02", 1);
  makeLesson("lesson-long-2", "S02-03", 2);
  makeLesson("lesson-long-3", "S02-04", 3);

  const context = assembleAiContext(data, {
    scope: "course",
    content_item_id: "lesson-1",
    include: FULL_INCLUDE,
  });
  assert(
    context.payload_chars <= 60000,
    `上下文总量必须收在上限内：${context.payload_chars}`,
  );
  const reasons = context.excluded.map((entry) => entry.reason).join("\n");
  assert(
    reasons.includes("超出单次上下文长度上限"),
    "超预算的条目必须在 excluded 里如实说明",
  );
  assert(
    reasons.includes("已截断"),
    "被截断的条目必须在 excluded 里如实说明",
  );
  assert(
    context.excluded.every((entry) => entry.reason.length > 0),
    "每个 excluded 条目都必须给出原因",
  );
});

Deno.test("an archived lesson cannot be an AI scope", async () => {
  const { data } = aiFixture();
  const lesson = data.content_items.find((item) => item.id === "lesson-2")!;
  lesson.archived = true;
  const failure = await assertAiFailure(
    () =>
      assembleAiContext(data, {
        scope: "lesson",
        content_item_id: "lesson-2",
        include: FULL_INCLUDE,
      }),
    "invalid_request",
    "归档课次必须被拒绝",
  );
  assert(
    failure.message.includes("归档"),
    `错误信息必须说明是归档：${failure.message}`,
  );
});

Deno.test("excluded entries honestly report the categories the caller turned off", () => {
  const { data } = aiFixture();
  const context = assembleAiContext(data, {
    scope: "lesson",
    content_item_id: "lesson-1",
    include: {
      requirements: false,
      assets: false,
      completion: false,
      nearby: false,
    },
  });
  const reasons = context.excluded.map((entry) => entry.reason).join("\n");
  assert(reasons.includes("待补要求"), "必须声明没有发送 Requirement");
  assert(reasons.includes("素材信息"), "必须声明没有发送素材元数据");
  assert(reasons.includes("完成度与状态"), "必须声明没有发送完成度");
  assert(reasons.includes("相邻内容"), "必须声明没有发送相邻内容");
  assert(
    !context.items.some((item) => item.source_type === "requirement"),
    "关掉待补后就不能再发待补",
  );
  assert(
    !context.items.some((item) => item.source_type === "asset"),
    "关掉素材后就不能再发素材",
  );
  assertEquals(context.completion, null, "关掉完成度后 completion 必须为 null");
});

Deno.test("requirements and assets are included when they are switched on", () => {
  const { data, first } = aiFixture();
  const asset = addAsset(data, data.project.id, {
    type: "image",
    filename: "封面.png",
    storage_path: "assets/封面.png",
    mime_type: "image/png",
    checksum: "checksum-封面",
    file_size: 1024,
  }).asset;
  addAssetUsage(data, asset.id, "lesson-1", { block_id: first.id });
  insertPlaceholder(data, "lesson-1", {
    type: "image",
    note: "补一张章节配图",
    priority: "high",
  });

  const context = assembleAiContext(data, {
    scope: "lesson",
    content_item_id: "lesson-1",
    include: FULL_INCLUDE,
  });
  assertEquals(context.requirements.length, 1, "本课待补必须进入上下文投影");
  assertEquals(
    context.requirements[0]!.type,
    "image",
    "待补类型必须保留",
  );
  assertEquals(
    context.requirements[0]!.priority,
    "high",
    "待补优先级必须保留",
  );
  assertEquals(context.assets.length, 1, "本课素材必须进入上下文投影");
  assert(
    context.items.some((item) =>
      item.source_type === "requirement" &&
      item.content.includes("补一张章节配图")
    ),
    "待补内容必须以条目形式发送",
  );
  assert(
    context.items.some((item) =>
      item.source_type === "asset" && item.content.includes("封面.png")
    ),
    "素材元数据必须以条目形式发送",
  );
  assert(context.completion !== null, "打开完成度后必须给出完成度投影");
  assert(
    (context.completion?.dimensions.length ?? 0) === 4,
    "完成度必须包含四个维度",
  );
});

Deno.test("context never carries credentials and redacts credential-shaped text", () => {
  const { data, first } = aiFixture();
  data.blocks.find((block) => block.id === first.id)!.content =
    `我的密钥是 ${SECRET_VALUE}，请帮我改写这一段。`;
  const context = assembleAiContext(data, {
    scope: "course",
    content_item_id: "lesson-1",
    include: FULL_INCLUDE,
  });
  const serialized = JSON.stringify(context);
  assert(
    !serialized.includes(SECRET_VALUE),
    "API Key 绝不能出现在上下文里",
  );
  assert(
    !serialized.includes("api_key"),
    "项目设置里的密钥字段名也不能出现在上下文里",
  );
  assert(
    serialized.includes("已隐藏"),
    "疑似密钥的内容必须被就地隐藏",
  );
  assert(
    context.excluded.some((entry) => entry.reason.includes("密钥")),
    "必须如实声明项目设置与密钥不进入上下文",
  );
});

Deno.test("context preview and prompt payload describe exactly what is sent", () => {
  const { data, first } = aiFixture();
  const context = assembleAiContext(data, {
    scope: "block",
    content_item_id: "lesson-1",
    block_id: first.id,
    instruction: "解释这一段在讲什么",
    include: FULL_INCLUDE,
  });
  const lines = aiContextPreviewLines(context);
  assertEquals(lines.length, context.items.length, "预览行数必须等于条目数");
  assertEquals(
    lines.map((line) => line.label),
    context.items.map((item) => item.label),
    "预览行必须按顺序对应条目",
  );
  const payload = aiContextPromptPayload(context);
  assert(
    payload.system.includes("replace_block") &&
      payload.system.includes("create_requirement"),
    "system 提示必须写清四种操作契约",
  );
  assert(
    payload.system.includes("changes"),
    "system 提示必须要求返回 changes",
  );
  assert(
    payload.user.includes("解释这一段在讲什么"),
    "user 内容必须包含用户指令",
  );
  assert(
    payload.user.includes("【用户要求】") ||
      payload.user.includes("## 用户要求"),
    "user 内容必须标出用户要求",
  );
  assert(
    !payload.system.includes(LESSON_ONE_BODY),
    "system 提示不能夹带课程正文",
  );
});

Deno.test("scope resolution fails readably when there is nothing to target", async () => {
  const empty = createEmptyProjectData("空课程");
  const failure = await assertAiFailure(
    () => assembleAiContext(empty, { scope: "course", include: FULL_INCLUDE }),
    "invalid_request",
    "没有课次时课程范围必须报可读错误",
  );
  assert(
    failure.message.includes("还没有课次"),
    `错误信息必须说明下一步：${failure.message}`,
  );

  const { data, first } = aiFixture();
  await assertAiFailure(
    () =>
      assembleAiContext(data, {
        scope: "block",
        block_id: "block-does-not-exist",
        include: FULL_INCLUDE,
      }),
    "invalid_request",
    "未知区块必须报可读错误",
  );
  await assertAiFailure(
    () =>
      assembleAiContext(data, {
        scope: "lesson",
        include: FULL_INCLUDE,
      }),
    "invalid_request",
    "课级范围缺少目标时必须报可读错误",
  );
  assert(first.id.length > 0, "fixture 必须提供真实区块 id");
});

/* ------------------------------------------------------------------ *
 * Provider catalog and request building
 * ------------------------------------------------------------------ */

Deno.test("provider catalog exposes the five presets as copies", () => {
  const ids = AI_PROVIDER_PRESETS.map((preset) => preset.id);
  assertEquals(
    ids,
    ["deepseek", "doubao", "openai", "custom", "fake"],
    "Provider 目录必须稳定",
  );
  assert(
    aiProviderPreset("deepseek")?.requires_credential === true,
    "在线 Provider 必须声明需要密钥",
  );
  assert(
    aiProviderPreset("fake")?.requires_credential === false,
    "本地连接器不需要密钥",
  );
  assertEquals(aiProviderPreset("nope"), null, "未知 Provider 必须返回 null");
  const descriptors = aiProviderDescriptors();
  descriptors[0]!.label = "被改坏了";
  assert(
    aiProviderPreset("deepseek")?.label === "DeepSeek",
    "目录必须返回副本，不能被外部修改",
  );
  assertEquals(
    descriptors.length,
    AI_PROVIDER_PRESETS.length,
    "descriptors 必须覆盖全部预设",
  );
});

Deno.test("missing credential guidance names the system-secure storage boundary", () => {
  const failure = new AiFailure("missing_credential", "这个 Provider 还没有配置 API Key。");
  assert(
    failure.recommended_action.includes("macOS 系统钥匙串"),
    "缺少密钥的下一步必须指向系统钥匙串",
  );
  assert(
    !failure.recommended_action.includes(".workspace"),
    "缺少密钥的下一步不得保留明文文件存储说明",
  );
});

Deno.test("buildAiProviderCall builds a chat request without any credential", () => {
  const { data, first } = aiFixture();
  const context = assembleAiContext(data, {
    scope: "block",
    content_item_id: "lesson-1",
    block_id: first.id,
    instruction: "重写这一段",
    include: FULL_INCLUDE,
  });
  const call = buildAiProviderCall({
    preset: "deepseek",
    model: "deepseek-chat",
    context,
    instruction: "重写这一段",
    wants_changes: true,
  });
  assertEquals(
    call.url,
    "https://api.deepseek.com/chat/completions",
    "URL 必须由 base_url 与 chat_path 组成",
  );
  assertEquals(call.response_kind, "chat", "响应类型必须是 chat");
  assertEquals(call.provider_id, "deepseek", "调用必须带 provider_id");
  assertEquals(call.auth.header, "authorization", "鉴权头名称由 preset 声明");
  assertEquals(call.auth.scheme, "Bearer", "鉴权方案由 preset 声明");
  assert(
    !Object.keys(call.headers).some((key) => key.toLowerCase() === "authorization"),
    "请求头里不能直接出现 authorization（密钥由 transport 进程注入）",
  );
  assertEquals(
    call.headers["x-workbench-auth"],
    "deepseek",
    "必须用注入指令头告诉 transport 用哪个 Provider 的密钥",
  );
  assertEquals(
    call.body.model,
    "deepseek-chat",
    "请求体必须带模型名",
  );
  assertEquals(
    (call.body.messages as Array<{ role: string }>).length,
    2,
    "必须组装 system + user 两条消息",
  );
  assertEquals(call.body.stream, false, "V0 使用非流式请求");
  assertEquals(
    call.body.response_format,
    { type: "json_object" },
    "修改型请求必须要求 JSON 输出",
  );
  const serialized = JSON.stringify(call);
  assert(!serialized.includes("sk-"), "请求里绝不能出现密钥");
  assert(
    !serialized.includes("requires_credential"),
    "preset 的 UI 字段不能进入 transport 载荷",
  );
  assert(
    !serialized.includes(SECRET_VALUE),
    "项目设置里的密钥不能进入请求",
  );

  const explain = buildAiProviderCall({
    preset: aiProviderPreset("openai")!,
    context,
    instruction: "解释这一段",
    wants_changes: false,
  });
  assertEquals(
    explain.body.response_format,
    undefined,
    "解释型请求不强制 JSON 输出，便于普通回答",
  );
  assertEquals(
    explain.url,
    "https://api.openai.com/v1/chat/completions",
    "自定义 base_url 必须被尊重",
  );
});

Deno.test("buildAiProviderCall reports an unconfigured provider readably", async () => {
  const failure = await assertAiFailure(
    () => buildAiProviderCall({ preset: "custom", instruction: "你好" }),
    "not_configured",
    "没有 Base URL 时必须报 not_configured",
  );
  assert(
    failure.message.includes("Base URL"),
    "错误信息必须指出缺什么",
  );
  await assertAiFailure(
    () => buildAiProviderCall({ preset: "unknown-provider", instruction: "你好" }),
    "not_configured",
    "未知 Provider 必须报 not_configured",
  );
  await assertAiFailure(
    () =>
      buildAiProviderCall({
        preset: "fake",
        instruction: "你好",
      }),
    "not_configured",
    "本地连接器不走网络调用",
  );
});

/* ------------------------------------------------------------------ *
 * Response normalisation
 * ------------------------------------------------------------------ */

const ANSWER_JSON = '{"answer":"我把这一段改得更口语了。","changes":[]}';

Deno.test("normalizeAiProviderResponse reads a JSON chat completion", () => {
  const preset = aiProviderPreset("deepseek")!;
  const normalized = normalizeAiProviderResponse(preset, {
    ok: true,
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      model: "deepseek-chat",
      choices: [{
        message: { role: "assistant", content: ANSWER_JSON },
        finish_reason: "stop",
      }],
      usage: { total_tokens: 42 },
    },
    response_kind: "json",
  });
  assertEquals(normalized.text, ANSWER_JSON, "必须取出回答文本");
  assertEquals(normalized.model, "deepseek-chat", "必须带出模型名");
  assertEquals(normalized.finish_reason, "stop", "必须带出结束原因");
  assertEquals(normalized.usage, { total_tokens: 42 }, "必须带出用量");
  assertEquals(normalized.raw_kind, "json", "必须标记响应类型");
});

Deno.test("normalizeAiProviderResponse reads SSE and parsed chunk arrays", () => {
  const preset = aiProviderPreset("deepseek")!;
  const sse = [
    'data: {"model":"deepseek-chat","choices":[{"delta":{"content":"你"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"好"}}]}',
    "",
    "data: 这不是 JSON，应当被跳过",
    "",
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":7}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const streamed = normalizeAiProviderResponse(preset, {
    ok: true,
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: sse,
    response_kind: "stream",
  });
  assertEquals(streamed.text, "你好", "必须拼接 SSE 分片");
  assertEquals(streamed.finish_reason, "stop", "必须读取 SSE 的结束原因");
  assertEquals(streamed.usage, { total_tokens: 7 }, "必须读取 SSE 的用量");
  assertEquals(streamed.raw_kind, "stream", "必须标记为流式响应");

  const chunks = normalizeAiProviderResponse(preset, {
    ok: true,
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: [{ choices: [{ delta: { content: "流" } }] }, {
      choices: [{ delta: { content: "式" } }],
    }],
    response_kind: "stream",
  });
  assertEquals(chunks.text, "流式", "必须接受已解析的分片数组");
});

Deno.test("normalizeAiProviderResponse rejects unreadable or empty bodies", async () => {
  const preset = aiProviderPreset("deepseek")!;
  await assertAiFailure(
    () =>
      normalizeAiProviderResponse(preset, {
        ok: true,
        status: 200,
        headers: { "content-type": "application/json" },
        body: "{ 这不是 JSON",
        response_kind: "json",
      }),
    "malformed_response",
    "坏 JSON 必须报 malformed_response",
  );
  await assertAiFailure(
    () =>
      normalizeAiProviderResponse(preset, {
        ok: true,
        status: 200,
        headers: { "content-type": "application/json" },
        body: { choices: [{ message: { content: "" } }] },
        response_kind: "json",
      }),
    "malformed_response",
    "空内容必须报 malformed_response",
  );
  await assertAiFailure(
    () =>
      normalizeAiProviderResponse(preset, {
        ok: false,
        code: "rate_limited",
        message: "限流了",
        status: 429,
      }),
    "rate_limited",
    "失败的 transport 结果必须还原成 AiFailure",
  );
});

/* ------------------------------------------------------------------ *
 * Answer parsing
 * ------------------------------------------------------------------ */

Deno.test("parseAiAnswer accepts plain and fenced JSON", () => {
  const plain = parseAiAnswer(
    '{"answer":"说明","changes":[{"op":"replace_block","block_id":"b1","content":"新正文","reason":"更清楚"}]}',
  );
  assertEquals(plain.answer, "说明", "必须读出 answer");
  assertEquals(plain.changes.length, 1, "必须读出 changes");
  assertEquals(plain.changes[0]!.op, "replace_block", "必须保留 op");
  assertEquals(plain.changes[0]!.block_id, "b1", "必须保留 block_id");
  assertEquals(plain.changes[0]!.reason, "更清楚", "必须保留 reason");

  const fenced = parseAiAnswer(
    "这是我的建议：\n```json\n" +
      '{"answer":"围栏里的说明","changes":[]}\n```\n希望有帮助。',
  );
  assertEquals(fenced.answer, "围栏里的说明", "必须能解析围栏 JSON");
  assertEquals(fenced.changes, [], "空 changes 必须解析成空数组");

  const four = parseAiAnswer(JSON.stringify({
    answer: "四条操作",
    changes: [
      { op: "replace_block", block_id: "b1", content: "新正文", reason: "r" },
      {
        op: "insert_block",
        after_block_id: "b1",
        type: "paragraph",
        content: "过渡段",
        reason: "r",
      },
      {
        op: "create_requirement",
        requirement_type: "image",
        note: "补图",
        priority: "high",
        anchor_block_id: null,
        reason: "r",
      },
      {
        op: "move_block",
        block_id: "b2",
        after_block_id: null,
        reason: "r",
      },
    ],
  }));
  assertEquals(four.changes.length, 4, "四种操作都必须能解析");
  assertEquals(
    four.changes.map((change) => change.op).join(","),
    "replace_block,insert_block,create_requirement,move_block",
    "操作顺序必须保持",
  );
  assertEquals(
    four.changes[2]!.priority,
    "high",
    "待补优先级必须保留",
  );
});

Deno.test("parseAiAnswer treats prose as an answer but rejects broken change intents", async () => {
  const prose = parseAiAnswer("这一段主要在解释为什么要先写大纲，再写正文。");
  assertEquals(prose.changes, [], "纯文字回答必须视为没有修改");
  assert(prose.answer.includes("大纲"), "纯文字回答必须保留原文");

  await assertAiFailure(
    () => parseAiAnswer('{"answer":"说明","changes":"不是数组"}'),
    "malformed_response",
    "changes 不是数组必须报 malformed_response",
  );
  await assertAiFailure(
    () =>
      parseAiAnswer(
        '{"answer":"说明","changes":[{"op":"rewrite_block","block_id":"b1","content":"x"}]}',
      ),
    "malformed_response",
    "未知 op 必须报 malformed_response",
  );
  await assertAiFailure(
    () =>
      parseAiAnswer(
        '{"answer":"说明","changes":[{"op":"replace_block","content":"缺少 block_id"}]}',
      ),
    "malformed_response",
    "缺少 block_id 必须报 malformed_response",
  );
  await assertAiFailure(
    () => parseAiAnswer("我建议做以下 changes：把第一段改短，把第二段拆开。"),
    "malformed_response",
    "提到 changes 但不是 JSON 必须报 malformed_response",
  );
  await assertAiFailure(
    () => parseAiAnswer(""),
    "malformed_response",
    "空回答必须报 malformed_response",
  );
  await assertAiFailure(
    () => parseAiAnswer("[1,2,3]"),
    "malformed_response",
    "JSON 不是对象必须报 malformed_response",
  );
  await assertAiFailure(
    () => parseAiAnswer('{"answer":"说明","changes":[]'),
    "malformed_response",
    "破损 JSON 必须报 malformed_response",
  );
});

/* ------------------------------------------------------------------ *
 * Connectors
 * ------------------------------------------------------------------ */

Deno.test("FakeAiConnector is deterministic and offline", async () => {
  const { data, first } = aiFixture();
  const context = assembleAiContext(data, {
    scope: "block",
    content_item_id: "lesson-1",
    block_id: first.id,
    instruction: "解释这一段",
    include: FULL_INCLUDE,
  });
  const connector = new FakeAiConnector();
  const one = await connector.complete({
    instruction: "解释这一段",
    context,
    wants_changes: false,
  });
  const two = await connector.complete({
    instruction: "解释这一段",
    context,
    wants_changes: false,
  });
  assertEquals(one, two, "本地连接器必须完全确定性");
  assertEquals(one.changes, [], "解释型指令默认不产生修改");
  assert(one.answer.includes("解释这一段"), "回答必须回应用户指令");
  assertEquals(connector.descriptor().provider_id, "fake", "描述必须标明 fake");

  const changes = [{
    op: "replace_block",
    block_id: first.id,
    content: "更口语的正文",
    reason: "降低阅读门槛",
  }];
  const structured = new FakeAiConnector({ changes });
  const rewrite = await structured.complete({
    instruction: "重写这一段，让它更适合新手",
    context,
  });
  assertEquals(rewrite.changes.length, 1, "修改型指令必须返回结构化 changes");
  assertEquals(
    rewrite.changes[0]!.block_id,
    first.id,
    "changes 必须原样返回",
  );
  const explain = await structured.complete({
    instruction: "这一段讲了什么",
    context,
  });
  assertEquals(
    explain.changes,
    [],
    "非修改型指令即使配置了 changes 也不能返回修改",
  );
  const forced = await structured.complete({
    instruction: "随便说点什么",
    context,
    wants_changes: true,
  });
  assertEquals(forced.changes.length, 1, "wants_changes 必须强制返回修改");
});

Deno.test("FakeAiConnector synthesises a reviewable rewrite for block scope", async () => {
  const { data, first } = aiFixture();
  const context = assembleAiContext(data, {
    scope: "block",
    content_item_id: "lesson-1",
    block_id: first.id,
    instruction: "把当前段落改写得更适合新手",
    include: FULL_INCLUDE,
  });
  const connector = new FakeAiConnector();
  const completion = await connector.complete({
    instruction: "把当前段落改写得更适合新手",
    context,
  });
  assertEquals(
    completion.changes.length,
    1,
    "默认配置的本地连接器必须为区块级修改请求合成一条修改",
  );
  const change = completion.changes[0]!;
  assertEquals(change.op, "replace_block", "合成修改必须是替换区块");
  assertEquals(change.block_id, first.id, "合成修改必须指向上下文里的目标区块");
  assert(
    typeof change.content === "string" &&
      change.content.includes("【本地示例改写】"),
    "合成内容必须带上明显的本地标记",
  );
  assert(
    typeof change.content === "string" &&
      change.content.includes(LESSON_ONE_BODY),
    "合成内容必须保留原正文，方便用户对照",
  );
  assert(
    typeof change.content === "string" &&
      change.content.length > LESSON_ONE_BODY.length,
    "合成内容必须比原文更长（附带了口语化说明）",
  );
  assert(
    typeof change.reason === "string" && change.reason.length > 0,
    "合成修改必须给出理由",
  );
  assert(
    completion.answer.includes("本地") && completion.answer.includes("没有联网"),
    `回答必须说明这是本地生成、没有联网：${completion.answer}`,
  );

  // Drive the synthesised change through the whole review pipeline.
  const suggestion = createAiSuggestion(data, {
    answer: completion.answer,
    changes: completion.changes,
    context,
    modelMetadata: { provider_id: "fake", model: completion.model },
  });
  const draft = createAiChangeDraft(data, suggestion.id, completion.changes, {
    scope: context.scope,
    provider: { provider_id: "fake", model: completion.model },
  });
  assertEquals(draft.status, "reviewing", "草稿必须可以立刻审核");
  assertEquals(
    validateAiChangeDraft(data, draft.id),
    { ok: true, issues: [] },
    "合成修改必须通过 Apply 前的 canonical 校验",
  );
  const rows = aiChangeDraftDiffRows(data, draft.id);
  assert(
    rows[0]!.after_lines.some((line) => line.includes("【本地示例改写】")),
    "Diff 必须展示本地示例改写",
  );
  applyAiChangeDraft(data, draft.id, { confirmed: true });
  const block = data.blocks.find((candidate) => candidate.id === first.id)!;
  assert(block.content !== LESSON_ONE_BODY, "应用后正文必须变化");
  assert(
    typeof block.content === "string" && block.content.includes(LESSON_ONE_BODY),
    "应用后的正文仍然包含原内容",
  );
  assertEquals(data.blocks.length, 4, "替换操作不能新增或删除区块");
  assertEquals(
    validateProjectData(data),
    [],
    "本地闭环结束后项目必须仍然有效",
  );

  // Course/lesson scope names no single block, so it stays answer-only.
  const lessonContext = assembleAiContext(data, {
    scope: "lesson",
    content_item_id: "lesson-2",
    instruction: "改写第二课",
    include: FULL_INCLUDE,
  });
  const lessonCompletion = await connector.complete({
    instruction: "改写第二课",
    context: lessonContext,
  });
  assertEquals(
    lessonCompletion.changes,
    [],
    "课级/课程级没有唯一目标区块，必须只回答不改动",
  );
});

Deno.test("FakeAiConnector stays read-only for explanation requests", async () => {
  const { data, first } = aiFixture();
  const context = assembleAiContext(data, {
    scope: "block",
    content_item_id: "lesson-1",
    block_id: first.id,
    instruction: "解释当前段落",
    include: FULL_INCLUDE,
  });
  const connector = new FakeAiConnector();
  const before = JSON.stringify(data.blocks);
  const completion = await connector.complete({
    instruction: "解释当前段落",
    context,
    wants_changes: false,
  });
  assertEquals(completion.changes, [], "解释型指令不能合成任何修改");
  assert(
    completion.answer.includes("不会改动课程内容"),
    `解释型回答必须说明不会改动内容：${completion.answer}`,
  );
  assertEquals(
    JSON.stringify(data.blocks),
    before,
    "解释型请求不能改动任何区块",
  );
  assert(!before.includes("【本地示例改写】"), "没有修改时不应出现合成内容");
});

Deno.test("FakeAiConnector synthesis is deterministic and never empty", async () => {
  const { data, first } = aiFixture();
  const context = assembleAiContext(data, {
    scope: "block",
    content_item_id: "lesson-1",
    block_id: first.id,
    instruction: "重写这一段，让它更适合新手",
    include: FULL_INCLUDE,
  });
  const connector = new FakeAiConnector();
  const one = await connector.complete({
    instruction: "重写这一段，让它更适合新手",
    context,
  });
  const two = await connector.complete({
    instruction: "重写这一段，让它更适合新手",
    context,
  });
  assertEquals(one, two, "相同输入必须产生完全相同的合成修改");
  assertEquals(one.changes.length, 1, "必须合成一条修改");
  assert(
    typeof one.changes[0]!.content === "string" &&
      one.changes[0]!.content.length > 0,
    "合成内容不能为空",
  );

  // An empty block still gets a non-empty, clearly-labelled sample.
  const empty = appendBlock(data, "lesson-2", "paragraph", "");
  const emptyContext = assembleAiContext(data, {
    scope: "block",
    content_item_id: "lesson-2",
    block_id: empty.id,
    instruction: "把这一段改写得更清楚",
    include: FULL_INCLUDE,
  });
  const emptyCompletion = await connector.complete({
    instruction: "把这一段改写得更清楚",
    context: emptyContext,
  });
  assertEquals(emptyCompletion.changes.length, 1, "空区块也必须能生成示例改写");
  assert(
    typeof emptyCompletion.changes[0]!.content === "string" &&
      emptyCompletion.changes[0]!.content.includes("【本地示例改写】") &&
      emptyCompletion.changes[0]!.content.length > 20,
    "空区块的示例改写也必须非空且带标记",
  );
});

Deno.test("FakeAiConnector maps every scenario to the right failure code", async () => {
  const scenarios: Array<[string, string]> = [
    ["timeout", "timeout"],
    ["provider_error", "provider_error"],
    ["rate_limit", "rate_limited"],
    ["rate_limited", "rate_limited"],
    ["malformed", "malformed_response"],
    ["missing_credential", "missing_credential"],
    ["permission_denied", "permission_denied"],
    ["cancelled", "cancelled"],
  ];
  for (const [scenario, code] of scenarios) {
    const connector = new FakeAiConnector({ scenario });
    await assertAiFailure(
      () => connector.complete({ instruction: "重写这一段" }),
      code,
      `场景 ${scenario} 必须映射到 ${code}`,
    );
  }
  const ok = new FakeAiConnector({ scenario: "ok" });
  const completion = await ok.complete({ instruction: "重写这一段" });
  assert(completion.answer.length > 0, "ok 场景必须返回回答");
  await assertAiFailure(
    () => new FakeAiConnector({ scenario: "没有这个场景" }),
    "invalid_request",
    "未知场景必须报 invalid_request",
  );
});

Deno.test("FakeAiConnector honours cancellation and latency", async () => {
  const controller = new AbortController();
  const connector = new FakeAiConnector({ latency_ms: 50 });
  const pending = connector.complete(
    { instruction: "重写这一段" },
    { signal: controller.signal },
  );
  controller.abort();
  await assertAiFailure(
    () => pending,
    "cancelled",
    "取消必须映射到 cancelled",
  );
  const aborted = new AbortController();
  aborted.abort();
  await assertAiFailure(
    () => connector.complete({ instruction: "重写这一段" }, { signal: aborted.signal }),
    "cancelled",
    "已经取消的信号必须立刻失败",
  );
});

Deno.test("HttpAiConnector maps HTTP status codes to failure codes", async () => {
  const preset = aiProviderPreset("deepseek")!;
  const cases: Array<[number, string]> = [
    [401, "missing_credential"],
    [403, "permission_denied"],
    [429, "rate_limited"],
    [500, "provider_error"],
    [404, "provider_error"],
  ];
  for (const [status, code] of cases) {
    const connector = new HttpAiConnector({
      preset,
      transport: () =>
        Promise.resolve({
          ok: false,
          status,
          code: "provider_error",
          message: `HTTP ${status}`,
        }),
    });
    const failure = await assertAiFailure(
      () => connector.complete({ instruction: "你好" }),
      code,
      `HTTP ${status} 必须映射到 ${code}`,
    );
    assertEquals(failure.status, status, `HTTP ${status} 必须保留状态码`);
  }
  // A transport that reports ok:true with an error status is still mapped.
  const odd = new HttpAiConnector({
    preset,
    transport: () =>
      Promise.resolve({ ok: true, status: 403, headers: {}, body: {} }),
  });
  await assertAiFailure(
    () => odd.complete({ instruction: "你好" }),
    "permission_denied",
    "带着错误状态码的成功结果也必须归一",
  );
});

Deno.test("HttpAiConnector maps timeout, cancel and missing transport", async () => {
  const preset = aiProviderPreset("deepseek")!;
  const timeoutConnector = new HttpAiConnector({
    preset,
    transport: () => {
      const error = new Error("request timed out after 60000ms");
      error.name = "TimeoutError";
      return Promise.reject(error);
    },
  });
  await assertAiFailure(
    () => timeoutConnector.complete({ instruction: "你好" }),
    "timeout",
    "超时必须映射到 timeout",
  );

  const cancelConnector = new HttpAiConnector({
    preset,
    transport: (_call, options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  const controller = new AbortController();
  const pending = cancelConnector.complete(
    { instruction: "你好" },
    { signal: controller.signal },
  );
  controller.abort();
  await assertAiFailure(
    () => pending,
    "cancelled",
    "abort 必须映射到 cancelled",
  );

  const preAborted = new AbortController();
  preAborted.abort();
  await assertAiFailure(
    () =>
      cancelConnector.complete(
        { instruction: "你好" },
        { signal: preAborted.signal },
      ),
    "cancelled",
    "已经取消的信号必须立刻失败",
  );

  const noTransport = new HttpAiConnector({ preset });
  await assertAiFailure(
    () => noTransport.complete({ instruction: "你好" }),
    "transport_unavailable",
    "没有 transport 必须报 transport_unavailable",
  );

  const network = new HttpAiConnector({
    preset,
    transport: () => Promise.reject(new Error("network is unreachable")),
  });
  await assertAiFailure(
    () => network.complete({ instruction: "你好" }),
    "transport_unavailable",
    "网络错误必须映射到 transport_unavailable",
  );
});

/** An Error shaped exactly like `app/main.js#bridgeError` produces. */
interface BridgeStyleFailure extends Error {
  code?: string;
  details?: unknown;
  recommended_action?: string;
}

function bridgeFailure(
  message: string,
  code: string,
  extra: { details?: unknown; recommended_action?: string } = {},
): BridgeStyleFailure {
  const failure = new Error(message) as BridgeStyleFailure;
  failure.code = code;
  failure.details = extra.details ?? {};
  if (extra.recommended_action !== undefined) {
    failure.recommended_action = extra.recommended_action;
  }
  return failure;
}

function throwingConnector(failure: unknown) {
  return new HttpAiConnector({
    preset: aiProviderPreset("deepseek")!,
    transport: () => Promise.reject(failure),
  });
}

Deno.test("HttpAiConnector honours the shell's structured failure code", async () => {
  const codes = [
    "missing_credential",
    "not_configured",
    "provider_error",
    "rate_limited",
    "permission_denied",
    "malformed_response",
    "invalid_request",
    "timeout",
    "cancelled",
  ];
  for (const code of codes) {
    const message = `AI 服务商「deepseek」返回了 ${code} 场景。`;
    const connector = throwingConnector(bridgeFailure(message, code, {
      details: { provider_id: "deepseek" },
      recommended_action: "在 AI 面板点击该服务商的「保存密钥」后重试。",
    }));
    const failure = await assertAiFailure(
      () => connector.complete({ instruction: "重写这一段" }),
      code,
      `桥接错误码 ${code} 必须原样保留`,
    );
    assertEquals(
      failure.message,
      message,
      `桥接错误的原始信息必须展示给用户（${code}）`,
    );
    assertEquals(
      failure.recommended_action,
      "在 AI 面板点击该服务商的「保存密钥」后重试。",
      `桥接错误给出的下一步必须被保留（${code}）`,
    );
    assertEquals(
      failure.details,
      { provider_id: "deepseek" },
      `桥接错误的 details 必须被保留（${code}）`,
    );
  }
});

Deno.test("HttpAiConnector maps connection-level codes without hiding the reason", async () => {
  // No open / writable project: the next step is opening one, not "the tunnel
  // is down".
  for (
    const code of [
      "project_not_open",
      "read_only_project",
      "invalid_project_path",
    ]
  ) {
    const message = `工作台返回了 ${code}。`;
    const failure = await assertAiFailure(
      () =>
        throwingConnector(bridgeFailure(message, code)).complete({
          instruction: "重写这一段",
        }),
      "not_configured",
      `${code} 必须映射到 not_configured`,
    );
    assert(
      failure.message.includes(code) &&
        failure.message.includes("可写的课程项目"),
      `${code} 必须保留原始原因并给出下一步：${failure.message}`,
    );
  }

  // Other connection problems stay transport-level but keep the real reason.
  for (
    const code of [
      "ai_connection_unreadable",
      "ai_connection_write_failed",
      "ai_execution_record_failed",
    ]
  ) {
    const message = `工作台返回了 ${code}：配置目录不可写。`;
    const failure = await assertAiFailure(
      () =>
        throwingConnector(bridgeFailure(message, code)).complete({
          instruction: "重写这一段",
        }),
      "transport_unavailable",
      `${code} 必须映射到 transport_unavailable`,
    );
    assertEquals(failure.message, message, `${code} 的原始信息必须保留`);
  }

  // An unrecognised code is not silently turned into a provider failure, and
  // its message still reaches the user.
  const unknown = await assertAiFailure(
    () =>
      throwingConnector(
        bridgeFailure("桥接请求失败：连接被重置。", "bridge_request_failed"),
      ).complete({ instruction: "重写这一段" }),
    "transport_unavailable",
    "未知的桥接错误码必须落到 transport_unavailable",
  );
  assertEquals(
    unknown.message,
    "桥接请求失败：连接被重置。",
    "未知错误码的信息不能被吞掉",
  );
});

Deno.test("HttpAiConnector keeps structured codes and text heuristics apart", async () => {
  // A structured code wins over the message text in both directions.
  const confusing = await assertAiFailure(
    () =>
      throwingConnector(
        bridgeFailure("请求已取消：服务商返回错误。", "provider_error"),
      ).complete({ instruction: "重写这一段" }),
    "provider_error",
    "结构化错误码不能被「取消」字样覆盖",
  );
  assert(confusing.message.includes("已取消"), "原始信息仍然必须可见");

  const timeoutText = await assertAiFailure(
    () =>
      throwingConnector(
        bridgeFailure(
          "connect timeout while calling the provider",
          "provider_error",
        ),
      ).complete({ instruction: "重写这一段" }),
    "provider_error",
    "结构化错误码不能被 timeout 字样覆盖",
  );
  assert(timeoutText.message.includes("timeout"), "原始信息仍然必须可见");

  const structuredTimeout = await assertAiFailure(
    () =>
      throwingConnector(bridgeFailure("上游 60 秒未响应。", "timeout")).complete(
        { instruction: "重写这一段" },
      ),
    "timeout",
    "结构化 timeout 必须映射到 timeout",
  );
  assert(
    structuredTimeout.recommended_action.length > 0,
    "没有给出 recommended_action 时必须使用错误码默认的下一步",
  );

  // No code at all: keep the previous heuristics.
  const noCode = await assertAiFailure(
    () =>
      throwingConnector(new Error("network is unreachable")).complete({
        instruction: "重写这一段",
      }),
    "transport_unavailable",
    "没有错误码的普通异常仍然映射到 transport_unavailable",
  );
  assert(
    JSON.stringify(noCode.details).includes("network is unreachable"),
    "普通异常的原始信息必须留在 details 里",
  );

  const abortShaped = new Error("the operation was aborted");
  abortShaped.name = "AbortError";
  await assertAiFailure(
    () => throwingConnector(abortShaped).complete({ instruction: "重写这一段" }),
    "cancelled",
    "AbortError 形状的异常仍然映射到 cancelled",
  );

  const timeoutShaped = new Error("request timed out");
  timeoutShaped.name = "TimeoutError";
  await assertAiFailure(
    () => throwingConnector(timeoutShaped).complete({ instruction: "重写这一段" }),
    "timeout",
    "TimeoutError 形状的异常仍然映射到 timeout",
  );

  // An AiFailure thrown by the transport itself is returned unchanged.
  const already = new AiFailure(
    "missing_credential",
    "这个 Provider 还没有配置 API Key。",
    {
      details: { provider_id: "deepseek" },
      recommended_action: "请先保存密钥。",
    },
  );
  const same = await assertAiFailure(
    () => throwingConnector(already).complete({ instruction: "重写这一段" }),
    "missing_credential",
    "已经是 AiFailure 的错误必须原样返回",
  );
  assertEquals(same.message, already.message, "AiFailure 必须原样返回");
  assertEquals(
    same.recommended_action,
    "请先保存密钥。",
    "AiFailure 的 recommended_action 不能丢",
  );

  // `bridgeError` always stamps a code, so a real abort can arrive as an
  // AbortError carrying the generic "bridge_request_failed".
  const abortWithBridgeCode = new Error("请求被中断");
  abortWithBridgeCode.name = "AbortError";
  (abortWithBridgeCode as BridgeStyleFailure).code = "bridge_request_failed";
  await assertAiFailure(
    () =>
      throwingConnector(abortWithBridgeCode).complete({
        instruction: "重写这一段",
      }),
    "cancelled",
    "未知桥接码 + AbortError 形状仍然必须映射到 cancelled",
  );

  // The user's own abort outranks whatever the transport reported.
  const controller = new AbortController();
  controller.abort();
  await assertAiFailure(
    () =>
      throwingConnector(bridgeFailure("Provider 出错", "provider_error")).complete(
        { instruction: "重写这一段" },
        { signal: controller.signal },
      ),
    "cancelled",
    "用户主动取消优先于传输层的错误码",
  );
});

Deno.test("HttpAiConnector completes offline through an injected transport", async () => {
  const { data, first } = aiFixture();
  const context = assembleAiContext(data, {
    scope: "block",
    content_item_id: "lesson-1",
    block_id: first.id,
    instruction: "重写这一段",
    include: FULL_INCLUDE,
  });
  let seen: { url: string; body: Record<string, unknown> } | null = null;
  const connector = new HttpAiConnector({
    preset: "deepseek",
    model: "deepseek-chat",
    transport: (call: {
      url: string;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }, options: { timeout_ms: number }) => {
      seen = { url: call.url, body: call.body };
      assertEquals(options.timeout_ms, 60000, "默认超时必须传给 transport");
      assertEquals(
        call.headers["x-workbench-auth"],
        "deepseek",
        "transport 必须收到注入指令",
      );
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          model: "deepseek-chat",
          choices: [{
            message: {
              content: JSON.stringify({
                answer: "已经重写。",
                changes: [{
                  op: "replace_block",
                  block_id: first.id,
                  content: "改写后的正文",
                  reason: "更口语",
                }],
              }),
            },
            finish_reason: "stop",
          }],
        },
        response_kind: "json",
      });
    },
  });
  const completion = await connector.complete(
    { instruction: "重写这一段", context, wants_changes: true },
  );
  assertEquals(completion.answer, "已经重写。", "必须返回解析后的回答");
  assertEquals(completion.changes.length, 1, "必须返回解析后的修改");
  assert(seen !== null, "transport 必须被调用");
  assertEquals(
    (seen as unknown as { url: string }).url,
    "https://api.deepseek.com/chat/completions",
    "transport 必须收到完整 URL",
  );
  assertEquals(
    connector.descriptor().provider_id,
    "deepseek",
    "描述必须标明 Provider",
  );
});

/* ------------------------------------------------------------------ *
 * Suggestion / ChangeDraft / Diff / Apply / Reject
 * ------------------------------------------------------------------ */

const EXPECTED_BLOCK_KEYS =
  "content,created_at,document_id,id,order_index,parent_block_id,settings,type,updated_at";
const EXPECTED_REQUIREMENT_KEYS =
  "anchor_block_id,content_item_id,created_at,id,layout_instance_id,note,priority,resolved_asset_id,resolved_at,resolved_block_id,scope,status,type";

function lessonContext(data: ProjectData, instruction = "帮我改写第一课的正文") {
  return assembleAiContext(data, {
    scope: "lesson",
    content_item_id: "lesson-1",
    instruction,
    include: FULL_INCLUDE,
  });
}

function makeSuggestion(
  data: ProjectData,
  changes: unknown[],
  instruction = "帮我改写第一课的正文",
) {
  const context = lessonContext(data, instruction);
  const suggestion = createAiSuggestion(data, {
    answer: "我按你的要求改写了第一课的正文。",
    changes,
    context,
    modelMetadata: {
      provider_id: "fake",
      model: "fake-deterministic",
      provider_label: "本地确定性连接器（离线）",
    },
  });
  return { context, suggestion };
}

Deno.test("createAiSuggestion records a pending suggestion with its context pack", () => {
  const { data, first } = aiFixture();
  const { context, suggestion } = makeSuggestion(data, [{
    op: "replace_block",
    block_id: first.id,
    content: "改写后的正文",
    reason: "更清楚",
  }]);
  assertEquals(suggestion.status, "pending", "新建议必须是待处理");
  assertEquals(
    suggestion.target_content_item_id,
    "lesson-1",
    "建议必须绑定目标课次",
  );
  assertEquals(suggestion.type, "rewrite", "有替换操作的建议类型必须是 rewrite");
  assert(suggestion.title.length > 0, "建议必须有标题");
  assert(
    suggestion.reviewed_at === null,
    "未审核的建议不能带审核时间",
  );
  assertEquals(data.context_packs.length, 1, "必须建立上下文包");
  assertEquals(
    data.context_pack_items.length,
    context.items.length,
    "上下文包条目数必须等于发送条目数",
  );
  const pack = data.context_packs[0]!;
  assertEquals(
    pack.target_content_item_id,
    "lesson-1",
    "上下文包必须绑定目标课次",
  );
  assertEquals(pack.model_connection_id, null, "V0 不引用模型连接");
  for (const item of data.context_pack_items) {
    assert(
      typeof item.content_hash === "string" && item.content_hash.length > 0,
      "上下文包条目必须有内容指纹",
    );
    assert(
      Number.isInteger(item.order_index),
      "上下文包条目顺序必须是整数",
    );
  }
  assertEquals(
    suggestion.evidence_refs.length,
    Math.min(context.items.length, 50),
    "证据引用必须来自实际发送的条目",
  );
  assert(
    suggestion.model_metadata.provider_id === "fake",
    "模型元数据必须带 provider_id",
  );
  assert(
    !JSON.stringify(suggestion.model_metadata).includes("requires_credential"),
    "模型元数据不能带 preset 的 UI 字段",
  );
  const noChanges = makeSuggestion(aiFixture().data, []);
  assertEquals(
    noChanges.suggestion.type,
    "other",
    "只回答问题的建议类型必须是 other",
  );
});

Deno.test("createAiSuggestion refuses an unknown target lesson", async () => {
  const { data } = aiFixture();
  const context = lessonContext(data);
  await assertAiFailure(
    () =>
      createAiSuggestion(data, {
        answer: "说明",
        context,
        targetContentItemId: "lesson-missing",
      }),
    "invalid_request",
    "未知目标课次必须报 invalid_request",
  );
  await assertAiFailure(
    () => createAiSuggestion(data, { answer: "说明" }),
    "invalid_request",
    "缺少目标与上下文必须报 invalid_request",
  );
  await assertAiFailure(
    () => createAiSuggestion(data, { answer: "   ", context }),
    "invalid_request",
    "空回答必须报 invalid_request",
  );
});

Deno.test("replace_block draft validates, diffs and applies atomically", () => {
  const { data, first } = aiFixture();
  const { suggestion } = makeSuggestion(data, [{
    op: "replace_block",
    block_id: first.id,
    content: "改写后的第一段正文。",
    reason: "更口语",
  }]);
  const draft = createAiChangeDraft(
    data,
    suggestion.id,
    [{
      op: "replace_block",
      block_id: first.id,
      content: "改写后的第一段正文。",
      reason: "更口语",
    }],
    {
      reason: "让开头更容易读",
      scope: { kind: "lesson", content_item_id: "lesson-1", block_id: null },
      provider: { provider_id: "fake", model: "fake-deterministic" },
    },
  );
  assertEquals(draft.status, "reviewing", "新草稿必须直接进入待审核状态");
  assertEquals(suggestion.status, "accepted", "生成草稿后建议必须变成已接受");
  assertEquals(draft.operations?.length, 1, "必须记录一条结构化操作");
  assertEquals(
    draft.proposed_changes.length,
    1,
    "替换操作必须同时写入兼容用的 proposed_changes",
  );
  assertEquals(
    draft.proposed_changes[0]!.before,
    LESSON_ONE_BODY,
    "before 必须快照当时的正文",
  );
  assertEquals(draft.reason, "让开头更容易读", "草稿必须记录理由");
  assertEquals(draft.scope?.kind, "lesson", "草稿必须记录范围");
  assertEquals(
    draft.provider?.provider_id,
    "fake",
    "草稿必须记录 Provider（不含密钥）",
  );
  assert(
    typeof draft.validation?.checked_at === "string" &&
      draft.validation.ok === true,
    "创建时的校验结果必须记录",
  );

  const validation = validateAiChangeDraft(data, draft.id);
  assertEquals(validation, { ok: true, issues: [] }, "刚创建的草稿必须可应用");

  const rows = aiChangeDraftDiffRows(data, draft.id);
  assertEquals(rows.length, 1, "Diff 行数必须等于操作数");
  assertEquals(rows[0]!.op, "replace_block", "Diff 必须标出操作");
  assertEquals(
    rows[0]!.before_lines,
    [LESSON_ONE_BODY],
    "Diff 必须给出改动前的行",
  );
  assertEquals(
    rows[0]!.after_lines,
    ["改写后的第一段正文。"],
    "Diff 必须给出改动后的行",
  );
  assertEquals(rows[0]!.block_id, first.id, "Diff 必须标出目标区块");

  const beforeApply = JSON.stringify(data.blocks.find((b) => b.id === first.id));
  const applied = applyAiChangeDraft(data, draft.id, { confirmed: true });
  assertEquals(applied.status, "applied", "应用后草稿必须标记已应用");
  assert(
    typeof applied.applied_at === "string",
    "应用后必须记录时间",
  );
  const block = data.blocks.find((candidate) => candidate.id === first.id)!;
  assertEquals(block.content, "改写后的第一段正文。", "应用后正文必须更新");
  assertEquals(
    block.document_id,
    "doc-lesson-1",
    "应用后区块仍必须属于原文档",
  );
  assert(
    block.updated_at !== JSON.parse(beforeApply).updated_at,
    "应用后必须刷新 updated_at",
  );
  assertEquals(
    data.blocks.length,
    4,
    "替换操作不能新增或删除区块",
  );
  assertEquals(
    validateProjectData(data),
    [],
    "应用后项目必须仍然通过 canonical 校验",
  );
});

Deno.test("apply requires confirmation and refuses an already handled draft", async () => {
  const { data, first } = aiFixture();
  const changes = [{
    op: "replace_block",
    block_id: first.id,
    content: "新正文",
    reason: "测试",
  }];
  const { suggestion } = makeSuggestion(data, changes);
  const draft = createAiChangeDraft(data, suggestion.id, changes, {});
  await assertAiFailure(
    () => applyAiChangeDraft(data, draft.id, { confirmed: false }),
    "invalid_request",
    "没有确认时不能应用",
  );
  assertEquals(
    data.blocks.find((block) => block.id === first.id)!.content,
    LESSON_ONE_BODY,
    "未确认的 Apply 不能改动正文",
  );
  applyAiChangeDraft(data, draft.id, { confirmed: true });
  await assertAiFailure(
    () => applyAiChangeDraft(data, draft.id, { confirmed: true }),
    "invalid_request",
    "已经应用的草稿不能再次应用",
  );
  await assertAiFailure(
    () => applyAiChangeDraft(data, "draft-missing", { confirmed: true }),
    "invalid_request",
    "未知草稿必须报 invalid_request",
  );
});

Deno.test("insert_block produces rows shaped exactly like main.js#addBlock", () => {
  const { data, first } = aiFixture();
  const changes = [{
    op: "insert_block",
    after_block_id: first.id,
    type: "paragraph",
    content: "这是新增的过渡段。",
    reason: "衔接下一节",
  }];
  const { suggestion } = makeSuggestion(data, changes);
  const draft = createAiChangeDraft(data, suggestion.id, changes, {});
  const operation = draft.operations![0]!;
  assertEquals(operation.before, null, "新增操作的 before 必须是 null");
  assertEquals(
    (operation.after as { order_index: number }).order_index,
    2,
    "新增操作必须记录插入后的位置快照",
  );
  const rows = aiChangeDraftDiffRows(data, draft.id);
  assertEquals(rows[0]!.before_lines, [], "新增操作没有改动前的行");
  assertEquals(
    rows[0]!.after_lines,
    ["这是新增的过渡段。"],
    "新增操作必须展示新正文",
  );

  applyAiChangeDraft(data, draft.id, { confirmed: true });
  const created = data.blocks.find((block) =>
    block.content === "这是新增的过渡段。"
  )!;
  assert(created, "应用后必须新增区块");
  assertEquals(
    Object.keys(created).sort().join(","),
    EXPECTED_BLOCK_KEYS,
    "新增区块的字段必须与 main.js#addBlock 完全一致",
  );
  assert(
    /^\d{4}-\d{2}-\d{2}T/.test(created.created_at) &&
      /^\d{4}-\d{2}-\d{2}T/.test(created.updated_at),
    "新增区块必须使用 ISO 时间戳",
  );
  assertEquals(created.parent_block_id, null, "新增区块没有父区块");
  assertEquals(created.settings, {}, "普通段落不能带多余 settings");
  const ordered = data.blocks
    .filter((block) => block.document_id === "doc-lesson-1")
    .sort((left, right) => left.order_index - right.order_index);
  assertEquals(
    ordered.map((block) => block.order_index),
    [0, 1, 2, 3],
    "order_index 必须保持连续整数",
  );
  assertEquals(
    ordered.map((block) => block.id)[2],
    created.id,
    "新段落必须落在锚点区块之后",
  );
});

Deno.test("insert_block of a placeholder always pairs a Requirement", () => {
  const { data, first } = aiFixture();
  const changes = [{
    op: "insert_block",
    after_block_id: first.id,
    type: "placeholder",
    requirement_type: "image",
    content: "补一张流程图",
    reason: "帮助理解步骤",
  }];
  const { suggestion } = makeSuggestion(data, changes);
  const draft = createAiChangeDraft(data, suggestion.id, changes, {});
  applyAiChangeDraft(data, draft.id, { confirmed: true });

  const placeholder = data.blocks.find((block) =>
    block.type === "placeholder"
  )!;
  assert(placeholder, "必须新增占位区块");
  assertEquals(
    Object.keys(placeholder).sort().join(","),
    EXPECTED_BLOCK_KEYS,
    "占位区块的字段必须与 main.js#addPlaceholder 完全一致",
  );
  assertEquals(placeholder.content, "补一张流程图", "占位说明必须保留");
  assertEquals(
    placeholder.settings.requirement_type,
    "image",
    "占位区块必须记录待补类型",
  );
  assertEquals(placeholder.settings.scope, "content", "占位区块作用域必须是内容");
  const requirement = data.requirements.find((row) =>
    row.id === placeholder.settings.requirement_id
  )!;
  assert(requirement, "占位区块必须配对一条待补");
  assertEquals(
    Object.keys(requirement).sort().join(","),
    EXPECTED_REQUIREMENT_KEYS,
    "待补字段必须与 main.js#addPlaceholder 完全一致",
  );
  assertEquals(
    requirement.anchor_block_id,
    placeholder.id,
    "待补必须锚定占位区块自身",
  );
  assertEquals(requirement.status, "open", "新待补必须是未完成");
  assertEquals(requirement.priority, "normal", "新待补默认普通优先级");
  assertEquals(requirement.note, "补一张流程图", "待补说明必须与占位一致");
  assertEquals(
    validateProjectData(data),
    [],
    "占位区块与待补必须通过 canonical 校验",
  );
});

Deno.test("create_requirement produces a canonical Requirement row", () => {
  const { data, first } = aiFixture();
  const reference = insertPlaceholder(aiFixture().data, "lesson-1", {
    type: "text",
    note: "参考行",
  });
  const changes = [{
    op: "create_requirement",
    requirement_type: "video",
    note: "补一段演示视频",
    priority: "high",
    anchor_block_id: first.id,
    reason: "视频比文字更直观",
  }];
  const { suggestion } = makeSuggestion(data, changes);
  const draft = createAiChangeDraft(data, suggestion.id, changes, {});
  const operation = draft.operations![0]!;
  assertEquals(operation.before, null, "新增待补的 before 必须是 null");
  assertEquals(
    (operation.after as { content_item_id: string }).content_item_id,
    "lesson-1",
    "新增待补必须绑定目标课次",
  );
  const rows = aiChangeDraftDiffRows(data, draft.id);
  assert(
    rows[0]!.after_lines.some((line) => line.includes("视频")),
    "Diff 必须说明要补什么",
  );
  assertEquals(rows[0]!.block_id, first.id, "Diff 必须标出锚点区块");

  applyAiChangeDraft(data, draft.id, { confirmed: true });
  const requirement = data.requirements.find((row) =>
    row.note === "补一段演示视频"
  )!;
  assert(requirement, "必须新增待补");
  assertEquals(
    Object.keys(requirement).sort().join(","),
    Object.keys(reference).sort().join(","),
    "新增待补的字段必须与既有作者路径完全一致",
  );
  assertEquals(requirement.type, "video", "待补类型必须保留");
  assertEquals(requirement.priority, "high", "待补优先级必须保留");
  assertEquals(requirement.anchor_block_id, first.id, "待补必须锚定指定区块");
  assertEquals(requirement.scope, "content", "内容待补必须声明 scope");
  assertEquals(
    requirement.layout_instance_id,
    null,
    "内容待补不能关联排版版本",
  );
  assertEquals(
    data.blocks.filter((block) => block.type === "placeholder").length,
    0,
    "create_requirement 不应该凭空插入占位区块",
  );
  assertEquals(validateProjectData(data), [], "新增待补必须通过 canonical 校验");
});

Deno.test("move_block reorders the lesson and diffs the affected window", () => {
  const { data, second } = aiFixture();
  const changes = [{
    op: "move_block",
    block_id: second.id,
    after_block_id: null,
    reason: "把第二段提到最前面",
  }];
  const { suggestion } = makeSuggestion(data, changes);
  const draft = createAiChangeDraft(data, suggestion.id, changes, {});
  const operation = draft.operations![0]!;
  assertEquals(
    (operation.before as { block_ids: string[] }).block_ids.length,
    3,
    "移动操作必须记录受影响的区块窗口",
  );
  assertEquals(
    (operation.after as { block_ids: string[] }).block_ids[0],
    second.id,
    "目标顺序必须把被移动的区块放到最前面",
  );
  const rows = aiChangeDraftDiffRows(data, draft.id);
  assertEquals(rows[0]!.op, "move_block", "Diff 必须标出移动操作");
  assertEquals(
    rows[0]!.before_lines.length,
    rows[0]!.after_lines.length,
    "移动操作的前后窗口长度必须一致",
  );
  assert(
    rows[0]!.after_lines[0]!.includes("第二段正文") ||
      rows[0]!.after_lines[0]!.includes("第二段"),
    "移动后的第一行必须是被移动的区块",
  );

  applyAiChangeDraft(data, draft.id, { confirmed: true });
  const ordered = data.blocks
    .filter((block) => block.document_id === "doc-lesson-1")
    .sort((left, right) => left.order_index - right.order_index);
  assertEquals(
    ordered[0]!.id,
    second.id,
    "应用后第二段必须排在最前面",
  );
  assertEquals(
    ordered.map((block) => block.order_index),
    [0, 1, 2],
    "order_index 必须重新连续编号",
  );
  assertEquals(
    data.blocks.length,
    4,
    "移动操作不能新增或删除区块",
  );
});

Deno.test("rejectAiChangeDraft leaves every block and requirement untouched", async () => {
  const { data, first } = aiFixture();
  const changes = [{
    op: "replace_block",
    block_id: first.id,
    content: "不该被写入的正文",
    reason: "测试拒绝",
  }];
  const { suggestion } = makeSuggestion(data, changes);
  const draft = createAiChangeDraft(data, suggestion.id, changes, {});
  const blocksBefore = JSON.stringify(data.blocks);
  const requirementsBefore = JSON.stringify(data.requirements);
  const rejected = rejectAiChangeDraft(data, draft.id, { reason: "这不是我想要的语气" });
  assertEquals(rejected.status, "discarded", "拒绝后状态必须是 discarded");
  assertEquals(
    JSON.stringify(data.blocks),
    blocksBefore,
    "拒绝不能改动任何区块",
  );
  assertEquals(
    JSON.stringify(data.requirements),
    requirementsBefore,
    "拒绝不能改动任何待补",
  );
  assert(
    !JSON.stringify(data.blocks).includes("不该被写入的正文"),
    "拒绝后正文里不能出现草稿内容",
  );
  assert(
    (rejected.validation?.issues.join("") || "").includes("这不是我想要的语气"),
    "拒绝原因必须被记录",
  );
  assertEquals(
    data.change_drafts.filter((row) => row.status === "discarded").length,
    1,
    "草稿本身必须保留为已拒绝",
  );
  const validation = validateAiChangeDraft(data, draft.id);
  assert(!validation.ok, "已拒绝的草稿不能再被应用");
  assert(
    validation.issues.some((issue) => issue.includes("不能应用")),
    "校验必须说明为什么不能应用",
  );
  await assertAiFailure(
    () => rejectAiChangeDraft(data, draft.id, {}),
    "invalid_request",
    "重复拒绝必须报可读错误",
  );
});

Deno.test("apply is all-or-nothing and refuses a changed base", async () => {
  const { data, first, second } = aiFixture();
  const changes = [
    {
      op: "replace_block",
      block_id: first.id,
      content: "第一条改写",
      reason: "r1",
    },
    {
      op: "replace_block",
      block_id: second.id,
      content: "第二条改写",
      reason: "r2",
    },
  ];
  const { suggestion } = makeSuggestion(data, changes);
  const draft = createAiChangeDraft(data, suggestion.id, changes, {});
  // A later external edit invalidates the second operation only.
  const operations = draft.operations ?? [];
  operations[1]!.before = "这一段在别处已经被改过了";

  const snapshot = JSON.stringify(data);
  const failure = await assertAiFailure(
    () => applyAiChangeDraft(data, draft.id, { confirmed: true }),
    "invalid_request",
    "before 不匹配时必须拒绝应用",
  );
  assertEquals(
    JSON.stringify(data),
    snapshot,
    "失败的 Apply 必须让数据逐字节保持不变（不能半写入）",
  );
  assertEquals(
    data.blocks.find((block) => block.id === first.id)!.content,
    LESSON_ONE_BODY,
    "第一个操作也不能被写入",
  );
  assertEquals(
    data.blocks.find((block) => block.id === second.id)!.content,
    LESSON_ONE_SECOND,
    "第二个操作不能被写入",
  );
  assertEquals(draft.status, "reviewing", "失败的草稿必须留在待审核状态");
  assert(
    (failure.details as { issues?: string[] } | null)?.issues?.length,
    "失败必须给出具体问题列表",
  );

  // A block that disappears after the draft was generated is also caught.
  const secondDraftData = aiFixture();
  const secondChanges = [{
    op: "replace_block",
    block_id: secondDraftData.second.id,
    content: "改写",
    reason: "r",
  }];
  const secondSuggestion = makeSuggestion(secondDraftData.data, secondChanges);
  const goneDraft = createAiChangeDraft(
    secondDraftData.data,
    secondSuggestion.suggestion.id,
    secondChanges,
    {},
  );
  secondDraftData.data.blocks = secondDraftData.data.blocks.filter((block) =>
    block.id !== secondDraftData.second.id
  );
  const before = JSON.stringify(secondDraftData.data);
  await assertAiFailure(
    () =>
      applyAiChangeDraft(secondDraftData.data, goneDraft.id, { confirmed: true }),
    "invalid_request",
    "目标区块被删除后必须拒绝应用",
  );
  assertEquals(
    JSON.stringify(secondDraftData.data),
    before,
    "区块被删除后失败的 Apply 也不能改动数据",
  );
});

Deno.test("apply can restrict itself to a subset of operations", async () => {
  const { data, first, second } = aiFixture();
  const changes = [
    { op: "replace_block", block_id: first.id, content: "只改第一段", reason: "r1" },
    { op: "replace_block", block_id: second.id, content: "第二段", reason: "r2" },
  ];
  const { suggestion } = makeSuggestion(data, changes);
  const draft = createAiChangeDraft(data, suggestion.id, changes, {});
  const onlyFirst = draft.operations![0]!.id;
  applyAiChangeDraft(data, draft.id, {
    confirmed: true,
    operation_ids: [onlyFirst],
  });
  assertEquals(
    data.blocks.find((block) => block.id === first.id)!.content,
    "只改第一段",
    "选中的操作必须应用",
  );
  assertEquals(
    data.blocks.find((block) => block.id === second.id)!.content,
    LESSON_ONE_SECOND,
    "未选中的操作不能应用",
  );
  assertEquals(
    draft.operations?.length,
    1,
    "应用后草稿只保留真正落盘的操作",
  );
  await assertAiFailure(
    () =>
      applyAiChangeDraft(data, draft.id, {
        confirmed: true,
        operation_ids: ["op-missing"],
      }),
    "invalid_request",
    "未知操作 id 必须报可读错误",
  );
});

Deno.test("course scope refuses changes that belong to another lesson", async () => {
  const { data } = aiFixture();
  const context = assembleAiContext(data, {
    scope: "course",
    content_item_id: "lesson-1",
    instruction: "改写第二课",
    include: FULL_INCLUDE,
  });
  const otherBlock = data.blocks.find((block) =>
    block.document_id === "doc-lesson-2"
  )!;
  const suggestion = createAiSuggestion(data, {
    answer: "我改一下第二课。",
    changes: [{
      op: "replace_block",
      block_id: otherBlock.id,
      content: "改过的第二课",
      reason: "r",
    }],
    context,
    modelMetadata: { provider_id: "fake", model: "fake-deterministic" },
  });
  const failure = await assertAiFailure(
    () =>
      createAiChangeDraft(data, suggestion.id, [{
        op: "replace_block",
        block_id: otherBlock.id,
        content: "改过的第二课",
        reason: "r",
      }], {}),
    "invalid_request",
    "跨课次的修改必须被拒绝",
  );
  assert(
    failure.message.includes(otherBlock.id) &&
      failure.message.includes("切换"),
    `错误必须点名区块并给出下一步：${failure.message}`,
  );
  assertEquals(data.change_drafts.length, 0, "被拒绝时不能留下草稿");
});

Deno.test("AI rows survive the canonical serializer", () => {
  const { data, first } = aiFixture();
  // The fixture plants a fake key in project.settings to prove the context
  // never ships it; the canonical writer legitimately refuses such a project,
  // so the serializer case starts from a clean settings object.
  delete data.project.settings.api_key;
  addAsset(data, data.project.id, {
    type: "image",
    filename: "封面.png",
    storage_path: "assets/封面.png",
    mime_type: "image/png",
    checksum: "checksum-封面",
    file_size: 2048,
  });
  insertPlaceholder(data, "lesson-1", { type: "text", note: "补一段小结" });
  const changes = [
    {
      op: "replace_block",
      block_id: first.id,
      content: "改写后的正文",
      reason: "更清楚",
    },
    {
      op: "insert_block",
      after_block_id: first.id,
      type: "placeholder",
      requirement_type: "image",
      content: "补一张插图",
      reason: "帮助理解",
    },
    {
      op: "create_requirement",
      requirement_type: "link",
      note: "补一个参考链接",
      priority: "low",
      anchor_block_id: null,
      reason: "方便延伸阅读",
    },
    {
      op: "move_block",
      block_id: first.id,
      after_block_id: null,
      reason: "把结论提前",
    },
  ];
  const { suggestion } = makeSuggestion(data, changes);
  const draft = createAiChangeDraft(data, suggestion.id, changes, {
    scope: { kind: "lesson", content_item_id: "lesson-1", block_id: null },
    provider: { provider_id: "fake", model: "fake-deterministic" },
  });
  applyAiChangeDraft(data, draft.id, { confirmed: true });

  assertEquals(
    validateProjectData(data),
    [],
    "AI 写入的行不能引入 canonical 校验问题",
  );
  const serialized = serializeProject(data);
  assert(
    serialized.includes(draft.id),
    "已应用的草稿必须能写进 project.json",
  );
  assert(
    serialized.includes(suggestion.id),
    "建议必须能写进 project.json",
  );
  assert(
    serialized.includes(data.context_packs[0]!.id),
    "上下文包必须能写进 project.json",
  );
  assert(
    !serialized.includes(SECRET_VALUE),
    "序列化结果里不能出现任何密钥",
  );
  assert(
    !serialized.includes("requires_credential"),
    "AI 行里不能带 preset 的 UI 字段",
  );
});

/* ------------------------------------------------------------------ *
 * Execution record
 * ------------------------------------------------------------------ */

Deno.test("offline end-to-end: context → call → parse → suggestion → draft → apply", async () => {
  const { data, first } = aiFixture();
  delete data.project.settings.api_key;
  const context = assembleAiContext(data, {
    scope: "block",
    content_item_id: "lesson-1",
    block_id: first.id,
    instruction: "把这一段改得更适合新手",
    include: FULL_INCLUDE,
  });
  const started = new Date().toISOString();
  const connector = new HttpAiConnector({
    preset: "deepseek",
    model: "deepseek-chat",
    transport: (call: { body: Record<string, unknown> }) => {
      // The transport sees the assembled context only, never a credential.
      const messages = call.body.messages as Array<{ content: string }>;
      assert(
        messages[1]!.content.includes(LESSON_ONE_BODY),
        "请求必须携带目标区块正文",
      );
      assert(
        !JSON.stringify(call).includes(SECRET_VALUE),
        "请求里不能出现密钥",
      );
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          model: "deepseek-chat",
          choices: [{
            message: {
              content: JSON.stringify({
                answer: "我把它改得更口语，并补了一个过渡句。",
                changes: [{
                  op: "replace_block",
                  block_id: first.id,
                  content: "改写后的新手友好正文。",
                  reason: "降低阅读门槛",
                }],
              }),
            },
            finish_reason: "stop",
          }],
          usage: { total_tokens: 128 },
        },
        response_kind: "json",
      });
    },
  });
  const completion = await connector.complete({
    instruction: "把这一段改得更适合新手",
    context,
    wants_changes: true,
  });
  const suggestion = createAiSuggestion(data, {
    answer: completion.answer,
    changes: completion.changes,
    context,
    modelMetadata: {
      provider_id: "deepseek",
      model: completion.model,
      provider_label: "DeepSeek",
    },
  });
  const draft = createAiChangeDraft(data, suggestion.id, completion.changes, {
    scope: context.scope,
    provider: { provider_id: "deepseek", model: completion.model },
  });
  assertEquals(
    validateAiChangeDraft(data, draft.id),
    { ok: true, issues: [] },
    "闭环里的草稿必须可应用",
  );
  const rows = aiChangeDraftDiffRows(data, draft.id);
  assert(
    rows[0]!.after_lines[0] === "改写后的新手友好正文。",
    "Diff 必须展示模型给出的新正文",
  );
  applyAiChangeDraft(data, draft.id, { confirmed: true });
  assertEquals(
    data.blocks.find((block) => block.id === first.id)!.content,
    "改写后的新手友好正文。",
    "应用后正文必须更新",
  );
  assertEquals(
    validateProjectData(data),
    [],
    "闭环结束后项目必须仍然有效",
  );
  assert(
    serializeProject(data).includes(draft.id),
    "闭环结束后项目必须能正常保存",
  );
  const record = buildAiExecutionRecord({
    project_id: data.project.id,
    started_at: started,
    finished_at: new Date().toISOString(),
    scope: context.scope,
    instruction: context.instruction,
    context,
    provider: {
      provider_id: "deepseek",
      model: completion.model,
      label: "DeepSeek",
    },
    status: "succeeded",
    outcome: draft.status === "applied" ? "change_draft" : "suggestion",
    suggestion_id: suggestion.id,
    change_draft_id: draft.id,
    review: { state: "applied", decided_at: new Date().toISOString() },
  });
  assertEquals(record.outcome, "change_draft", "闭环产出必须是 ChangeDraft");
  assert(
    !JSON.stringify(record).includes("改写后的新手友好正文"),
    "执行记录不能包含正文",
  );
});

Deno.test("buildAiExecutionRecord keeps metadata only", () => {
  const { data, first } = aiFixture();
  const context = assembleAiContext(data, {
    scope: "block",
    content_item_id: "lesson-1",
    block_id: first.id,
    instruction: "重写这一段",
    include: FULL_INCLUDE,
  });
  const record = buildAiExecutionRecord({
    project_id: data.project.id,
    started_at: "2026-02-01T00:00:00.000Z",
    finished_at: "2026-02-01T00:00:02.500Z",
    scope: {
      kind: "block",
      content_item_id: "lesson-1",
      block_id: first.id,
      label: context.scope.label,
    },
    instruction: "重写这一段",
    context,
    provider: {
      provider_id: "deepseek",
      model: "deepseek-chat",
      label: "DeepSeek",
    },
    status: "succeeded",
    outcome: "change_draft",
    suggestion_id: "suggestion-1",
    change_draft_id: "draft-1",
    review: { state: "applied", decided_at: "2026-02-01T00:00:03.000Z" },
  });
  assertEquals(record.duration_ms, 2500, "必须计算耗时");
  assertEquals(record.status, "succeeded", "必须保留状态");
  assertEquals(record.outcome, "change_draft", "必须保留产出类型");
  assertEquals(
    record.capabilities,
    { tools: [], mcp: [], skills: [] },
    "V0 必须如实声明没有调用任何工具",
  );
  assertEquals(
    record.context.item_count,
    context.items.length,
    "执行记录只能记录上下文的元数据",
  );
  assertEquals(
    record.context.chars,
    context.payload_chars,
    "执行记录必须记录上下文长度",
  );
  assert(
    record.context.source_types.includes("custom"),
    "执行记录必须记录来源类型",
  );
  const serialized = JSON.stringify(record);
  assert(
    !serialized.includes(LESSON_ONE_BODY),
    "执行记录不能包含正文全文",
  );
  assert(!serialized.includes(SECRET_VALUE), "执行记录不能包含密钥");
  assert(!serialized.includes("api_key"), "执行记录不能包含密钥字段");
  assertEquals(
    Object.keys(record.provider).sort().join(","),
    "label,model,provider_id",
    "执行记录的 provider 只能有这三个字段",
  );
  assertEquals(
    record.review.state,
    "applied",
    "执行记录必须记录审核结果",
  );
  assertEquals(
    record.provider.model,
    "deepseek-chat",
    "执行记录必须记录模型名",
  );
});

Deno.test("buildAiExecutionRecord truncates and normalises unsafe input", () => {
  const long = "很长的指令".repeat(1000);
  // A hostile caller can pass anything; the record must still stay clean.
  const taintedProvider = {
    provider_id: "x",
    model: "y",
    label: "z",
    api_key: SECRET_VALUE,
    requires_credential: true,
  };
  const record = buildAiExecutionRecord({
    project_id: "project-1",
    instruction: long,
    provider: taintedProvider,
    status: "没有这个状态",
    outcome: "没有这个结果",
    review: { state: "没有这个状态" },
    context: { item_count: 3, chars: 120, source_types: ["document", "custom"] },
  });
  assert(
    record.instruction.length <= 2000,
    "指令必须截断到 2000 字以内",
  );
  assert(
    !JSON.stringify(record).includes(SECRET_VALUE),
    "意外传入的密钥不能被写进记录",
  );
  assert(
    !JSON.stringify(record).includes("requires_credential"),
    "意外传入的 UI 字段不能被写进记录",
  );
  assertEquals(record.status, "failed", "非法状态必须归一到 failed");
  assertEquals(record.outcome, "none", "非法产出必须归一到 none");
  assertEquals(record.review.state, "pending", "非法审核状态必须归一到 pending");
  assertEquals(record.context.item_count, 3, "必须接受外部上下文元数据");
  assertEquals(record.error_code, null, "没有错误时 error_code 必须为 null");
  assertEquals(
    AI_EXECUTION_STATUS.includes(record.status),
    true,
    "状态必须来自冻结枚举",
  );
  assertEquals(
    AI_EXECUTION_OUTCOME.includes(record.outcome),
    true,
    "产出必须来自冻结枚举",
  );
  assertEquals(
    AI_FAILURE_CODES.includes("transport_unavailable"),
    true,
    "失败码枚举必须包含传输不可用",
  );
  assertEquals(
    typeof record.id === "string" && record.id.length > 0,
    true,
    "记录必须自带 id",
  );
  void (null as ChangeDraft | null);
  void (null as Block | null);
});
