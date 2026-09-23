// @ts-check
/*
 * AI Workflow core for the Course Workbench (V0-T03, Workstream A).
 *
 * This module is the single implementation of the AI contract: context
 * assembly, the provider catalog, request building, response normalisation and
 * the Suggestion / ChangeDraft / Diff / Apply / Reject pipeline.  The browser
 * shell (`app/main.js`), the Deno service transport and the Deno test suite all
 * load this same file, so provider semantics exist exactly once.
 *
 * Rules this file obeys:
 *  - Plain ES module.  It only uses capabilities present in both the browser
 *    and Deno (`crypto.randomUUID`, `structuredClone`, BigInt, plain string
 *    handling).  Nothing touches `window` / `document` / `Deno` / `fetch` at
 *    module top level, and there is no top-level side effect at all.
 *  - Context assembly is a PURE READ.  It never mutates `data` and never adds
 *    canonical rows; only the mutation helpers below (create / apply / reject)
 *    write, and they only write canonical arrays.
 *  - Nothing that could be a credential ever enters the context, a prompt, a
 *    ChangeDraft or an execution record.  Project settings are never read.
 *  - Every failure is an `AiFailure` with a readable Chinese message plus a
 *    `recommended_action`, so the UI can always say what happened next.
 */

import {
  MEDIA_BLOCK_TYPES,
  REQUIREMENT_TYPES,
  assetForBlock,
  assetLabel,
  blockLabel,
  blocksFor,
  courseMap,
  formatBytes,
  gapCounts,
  lessonAssets,
  lessonProgress,
  statusViews,
  textOf,
} from "./authoring.js";

/** @typedef {import("../src/domain/types.ts").ProjectData} ProjectData */
/** @typedef {import("../src/domain/types.ts").Block} Block */
/** @typedef {import("../src/domain/types.ts").ContentItem} ContentItem */
/** @typedef {import("../src/domain/types.ts").Document} Document */
/** @typedef {import("../src/domain/types.ts").Requirement} Requirement */
/** @typedef {import("../src/domain/types.ts").Asset} Asset */
/** @typedef {import("../src/domain/types.ts").Suggestion} Suggestion */
/** @typedef {import("../src/domain/types.ts").ChangeDraft} ChangeDraft */
/** @typedef {import("../src/domain/types.ts").ChangeOperation} ChangeOperation */
/** @typedef {import("../src/domain/types.ts").ChangeValidation} ChangeValidation */
/** @typedef {import("../src/domain/types.ts").ContextPack} ContextPack */
/** @typedef {import("../src/domain/types.ts").ContextPackItem} ContextPackItem */
/** @typedef {import("../src/domain/types.ts").JsonValue} JsonValue */
/** @typedef {import("../src/domain/types.ts").JsonObject} JsonObject */

/* ------------------------------------------------------------------ *
 * Shared shapes
 * ------------------------------------------------------------------ */

/**
 * One thing that is actually sent to the model.  `source_id` is always a
 * canonical row id, or an explicit projection id (`course_map` uses the
 * project id, `custom` uses the row the projection belongs to).
 *
 * @typedef {Object} AiContextItem
 * @property {string} source_type
 * @property {string} source_id
 * @property {string} label
 * @property {string} content
 * @property {number} chars
 */

/**
 * Something the user turned off, or something a limit dropped.  Being honest
 * here is the whole point: the user must be able to see what was NOT sent.
 *
 * @typedef {Object} AiExcludedItem
 * @property {string} source_type
 * @property {string} source_id
 * @property {string} reason
 */

/**
 * @typedef {Object} AiNearbyEntry
 * @property {"previous" | "next" | "stage_sibling"} relation
 * @property {string} code
 * @property {string} title
 */

/**
 * @typedef {Object} AiContextRequirement
 * @property {string} id
 * @property {string} type
 * @property {string} note
 * @property {string} priority
 * @property {string} status
 * @property {string | null} anchor_block_id
 * @property {string | null} resolved_asset_id
 */

/**
 * @typedef {Object} AiContextAsset
 * @property {string} id
 * @property {string} filename
 * @property {string} type
 * @property {string} mime_type
 * @property {number} size
 * @property {string[]} used_by
 */

/**
 * @typedef {Object} AiContext
 * @property {{ kind: string, label: string, content_item_id: string, block_id: string | null }} scope
 * @property {{ id: string, title: string }} project
 * @property {{ title: string, lesson_count: number, stage_count: number, completed_lessons: number, open_requirements: number, missing_assets: number }} course
 * @property {null | { id: string, code: string, title: string, type: string, stage_title: string, block_count: number, media_count: number, completion_percentage: number }} lesson
 * @property {null | { id: string, type: string, label: string, text: string, position: number, asset_filename: string }} block
 * @property {AiNearbyEntry[]} nearby
 * @property {AiContextRequirement[]} requirements
 * @property {AiContextAsset[]} assets
 * @property {null | { percentage: number, dimensions: Array<{ key: string, label: string, selected: string }>, gaps: Record<string, any> }} completion
 * @property {string} instruction
 * @property {AiContextItem[]} items
 * @property {AiExcludedItem[]} excluded
 * @property {number} payload_chars
 */

/**
 * One parsed model change.  `parseAiAnswer` only ever emits these fields, so a
 * model cannot smuggle extra keys into canonical data.
 *
 * @typedef {Object} AiChange
 * @property {string} op
 * @property {string} [block_id]
 * @property {string | null} [after_block_id]
 * @property {string} [type]
 * @property {JsonValue} [content]
 * @property {string} [requirement_type]
 * @property {string} [note]
 * @property {string} [priority]
 * @property {string | null} [anchor_block_id]
 * @property {string} reason
 */

/**
 * @typedef {Object} AiCompletion
 * @property {string} answer
 * @property {AiChange[]} changes
 * @property {string} model
 * @property {JsonValue} usage
 * @property {string} finish_reason
 * @property {string} raw_kind
 */

/**
 * @typedef {Object} AiProviderPreset
 * @property {string} id
 * @property {string} label
 * @property {"openai_compatible" | "fake"} kind
 * @property {string} base_url
 * @property {string} chat_path
 * @property {string} auth_header
 * @property {string} auth_scheme
 * @property {string} default_model
 * @property {string[]} models
 * @property {boolean} requires_credential
 */

/**
 * @typedef {Object} AiConnectorDescriptor
 * @property {string} provider_id
 * @property {string} label
 * @property {string} model
 * @property {string} kind
 * @property {string} base_url
 * @property {boolean} requires_credential
 */

/**
 * @typedef {Object} AiExecutionRecord
 * @property {string} id
 * @property {string} project_id
 * @property {string} created_at
 * @property {string} finished_at
 * @property {number} duration_ms
 * @property {{ kind: string, content_item_id: string | null, block_id: string | null, label: string }} scope
 * @property {string} instruction
 * @property {{ item_count: number, chars: number, source_types: string[] }} context
 * @property {{ provider_id: string, model: string, label: string }} provider
 * @property {{ tools: string[], mcp: string[], skills: string[] }} capabilities
 * @property {string} status
 * @property {string | null} error_code
 * @property {string} error_message
 * @property {string} outcome
 * @property {string | null} suggestion_id
 * @property {string | null} change_draft_id
 * @property {{ state: string, decided_at: string | null }} review
 */

/**
 * @typedef {Object} AiDiffRow
 * @property {string} op
 * @property {string} label
 * @property {string[]} before_lines
 * @property {string[]} after_lines
 * @property {string | null} block_id
 */

/** @typedef {"course" | "lesson" | "block"} AiScopeKind */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** The four operations the workflow understands. */
const AI_CHANGE_OPS = [
  "replace_block",
  "insert_block",
  "create_requirement",
  "move_block",
];

/** Mirrors the canonical enums (the .ts enums cannot be imported at runtime). */
const AI_BLOCK_TYPES = [
  "heading",
  "paragraph",
  "quote",
  "image",
  "gallery",
  "gif",
  "video",
  "audio",
  "table",
  "chart",
  "code",
  "callout",
  "exercise",
  "divider",
  "placeholder",
  "embed",
];
/** The shared Domain list; the AI draft validator must accept exactly这些. */
const AI_REQUIREMENT_TYPES = REQUIREMENT_TYPES;
const AI_PRIORITIES = ["low", "normal", "high"];
const AI_CONTEXT_SOURCE_TYPES = [
  "document",
  "stage",
  "course_map",
  "requirement",
  "conversation",
  "message",
  "asset",
  "custom",
];
const AI_REVIEW_STATES = ["pending", "rejected", "applied", "apply_failed"];

/**
 * Hard limits keep one click from shipping a whole book to a model.  They are
 * deterministic and every dropped or clipped item is reported in `excluded`.
 */
const AI_CONTEXT_LIMITS = {
  /** Total characters of `items` (the instruction is reserved on top). */
  total_chars: 60000,
  /** Per-item clamp. */
  item_chars: 20000,
  /** A user instruction is never allowed to eat the whole budget. */
  instruction_chars: 4000,
  /** Evidence refs copied onto a Suggestion. */
  evidence_refs: 50,
  /** Instruction clamp in an execution record (design §2.5). */
  record_instruction_chars: 2000,
};
const AI_DEFAULT_TIMEOUT_MS = 60000;

/** Instructions that mean "change the course", not just "explain it". */
const AI_MODIFICATION_INTENT =
  /重写|改写|修改|替换|润色|优化|扩写|精简|压缩|调整|移动|排序|顺序|新增|插入|补充|增加|删掉|删除|改成|换成|rewrite|rephrase|reword|modify|replace|insert|move|reorder/i;

/** Credential-shaped strings that must never leave the machine. */
const AI_CREDENTIAL_VALUE_PATTERNS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

/** Key names that must never appear in anything derived from canonical data. */
const AI_CREDENTIAL_KEY_PATTERN =
  /(api[_-]?key|apikey|token|secret|password|passwd|credential|authorization|private[_-]?key)/i;

/* ------------------------------------------------------------------ *
 * Small shared utilities
 * ------------------------------------------------------------------ */

/** @returns {string} */
function uuid() {
  return crypto.randomUUID();
}

/** @returns {string} */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Key-sorted JSON, byte-identical to `src/domain/util.ts#stableJson`.  Used for
 * revisions and for comparing "before" snapshots without depending on key
 * insertion order.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (value))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Deterministic 64-bit FNV-1a hash.  It is used for `context_pack_items`
 * content hashes because `createAiSuggestion` must stay synchronous (the UI
 * calls it inside a synchronous commit); the domain's async sha256 path used by
 * `analyzeForSuggestions` is untouched.
 *
 * @param {string} text
 * @returns {string}
 */
function stableHash(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash ^ BigInt(text.charCodeAt(index))) & mask;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Remove credential-shaped substrings from text that might be echoed back to a
 * model or written into a record.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeAiText(value) {
  const text = typeof value === "string" ? value : textOf(value);
  let cleaned = text;
  for (const pattern of AI_CREDENTIAL_VALUE_PATTERNS) {
    cleaned = cleaned.replace(pattern, (match, group) =>
      typeof group === "string" ? `${group} [已隐藏]` : "[已隐藏疑似密钥]"
    );
  }
  return cleaned;
}

/**
 * Deep-copy while dropping any key that names a credential.  Applied to the
 * finished context so a future projection cannot leak a secret by accident.
 *
 * @param {any} value
 * @returns {any}
 */
function scrubCredentialKeys(value) {
  if (Array.isArray(value)) return value.map((item) => scrubCredentialKeys(item));
  if (!value || typeof value !== "object") return value;
  /** @type {Record<string, any>} */
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (AI_CREDENTIAL_KEY_PATTERN.test(key)) continue;
    output[key] = scrubCredentialKeys(child);
  }
  return output;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringOf(value) {
  return typeof value === "string" ? value : "";
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function idOf(value) {
  return typeof value === "string" && value ? value : null;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function idListOf(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && entry);
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 * @returns {JsonValue}
 */
function cloneJson(value) {
  if (value === undefined) return "";
  try {
    return /** @type {JsonValue} */ (structuredClone(value));
  } catch {
    return textOf(value);
  }
}

/** @param {ProjectData} data @returns {ContentItem[]} */
function contentItemsOf(data) {
  return Array.isArray(data.content_items) ? data.content_items : [];
}

/** @param {ProjectData} data @returns {Document[]} */
function documentsOf(data) {
  return Array.isArray(data.documents) ? data.documents : [];
}

/** @param {ProjectData} data @returns {Block[]} */
function blocksOf(data) {
  return Array.isArray(data.blocks) ? data.blocks : [];
}

/** @param {ProjectData} data @returns {Requirement[]} */
function requirementsOf(data) {
  return Array.isArray(data.requirements) ? data.requirements : [];
}

/** @param {ProjectData} data @returns {Asset[]} */
function assetsOf(data) {
  return Array.isArray(data.assets) ? data.assets : [];
}

/** @param {ProjectData} data @returns {any[]} */
function stagesOf(data) {
  return Array.isArray(data.stages) ? data.stages : [];
}

/**
 * Rebuild the reading order of one lesson after an insert or a move, exactly
 * like `app/main.js#renumberBlocks` / `reorderBlockTo` do: `order_index` stays a
 * contiguous integer sequence owned by the document.
 *
 * @param {ProjectData} data
 * @param {string} documentId
 */
function renumberBlocks(data, documentId) {
  blocksOf(data)
    .filter((block) => block.document_id === documentId)
    .sort((left, right) =>
      (left.order_index ?? 0) - (right.order_index ?? 0) ||
      String(left.id).localeCompare(String(right.id))
    )
    .forEach((block, index) => {
      block.order_index = index;
    });
}

/**
 * Current document revision.  Compared before every Apply so a draft can never
 * be applied on top of text it was not generated from.
 *
 * @param {ProjectData} data
 * @param {string} contentItemId
 * @returns {string}
 */
function documentRevisionOf(data, contentItemId) {
  return stableJson(
    blocksFor(data, contentItemId).map((block) => ({
      id: block.id,
      order_index: block.order_index,
      type: block.type,
      content: block.content,
    })),
  );
}

/* ------------------------------------------------------------------ *
 * Failure contract
 * ------------------------------------------------------------------ */

/**
 * Every way an AI step can fail.  The UI switches on these codes, never on
 * message text.
 */
export const AI_FAILURE_CODES = [
  /** Provider 未配置 */
  "not_configured",
  /** API Key / Token 缺失 */
  "missing_credential",
  "timeout",
  "cancelled",
  "rate_limited",
  "provider_error",
  "malformed_response",
  /** tool / MCP / Skill 未授权 */
  "permission_denied",
  "transport_unavailable",
  "invalid_request",
];

/**
 * Per-code defaults: the user-facing sentence and the next step.  They are the
 * fallback whenever a transport did not already produce a readable message.
 *
 * @type {Record<string, { message: string, action: string }>}
 */
const AI_FAILURE_DEFAULTS = {
  not_configured: {
    message: "这个 AI Provider 还没有配置完成，无法发起请求。",
    action: "请先在「AI 设置」里选择并配置一个 Provider，然后重试。",
  },
  missing_credential: {
    message: "这个 Provider 还没有配置 API Key，请求被拒绝了。",
    action:
      "请在「AI 设置」里为这个 Provider 填写 API Key；密钥由本机服务写入 macOS 系统钥匙串，不会写入课程文件。",
  },
  timeout: {
    message: "AI 请求超时了（默认 60 秒内没有响应），课程内容没有改动。",
    action: "可以稍后重试；也可以先缩小上下文范围（改成课级或区块级）再重试。",
  },
  cancelled: {
    message: "这次 AI 请求已经取消，课程内容没有任何改动。",
    action: "这次请求已经取消，课程内容没有改动。可以重新发起请求。",
  },
  rate_limited: {
    message: "Provider 提示请求过于频繁（HTTP 429），已触发限流。",
    action: "稍等一会儿再重试；也可以换一个模型或 Provider。",
  },
  provider_error: {
    message: "Provider 返回了错误，课程内容没有改动。",
    action:
      "可以稍后重试；如果一直失败，请检查 AI 设置里的模型名与 Base URL 是否正确。",
  },
  malformed_response: {
    message: "模型的回复无法解析成可审核的建议，课程内容没有改动。",
    action:
      "可以重试一次；如果仍然失败，请换一个模型，或在指令里说明要改哪个区块。",
  },
  permission_denied: {
    message: "Provider 拒绝了这次请求：当前密钥没有调用这个模型的权限。",
    action:
      "请检查这个 Provider 的授权范围（Tool / MCP / Skill），确认允许后再重试。",
  },
  transport_unavailable: {
    message: "AI 传输通道不可用，课程内容没有改动。",
    action: "请确认桌面壳已授权联网、或本机服务可用，然后重试。",
  },
  invalid_request: {
    message: "这次 AI 请求的内容不合法，无法执行。",
    action: "请修正上面的问题后重试。",
  },
};

/**
 * Connection-level codes the two shells report for problems that are not
 * provider failures.  Without this table they would all read as
 * "传输通道不可用", which hides the real reason from the user.
 *
 * @type {Record<string, string>}
 */
const AI_CONNECTION_CODE_MAP = {
  project_not_open: "not_configured",
  read_only_project: "not_configured",
  invalid_project_path: "not_configured",
  ai_connection_unreadable: "transport_unavailable",
  ai_connection_write_failed: "transport_unavailable",
  ai_execution_record_failed: "transport_unavailable",
};
/** The connection codes whose next step is "open a writable project". */
const AI_PROJECT_FIRST_CODES = [
  "project_not_open",
  "read_only_project",
  "invalid_project_path",
];

/** @type {string[]} */
const AI_RECOVERABLE_CODES = [
  "not_configured",
  "missing_credential",
  "timeout",
  "cancelled",
  "rate_limited",
  "provider_error",
  "malformed_response",
  "permission_denied",
  "transport_unavailable",
];

/**
 * One failure type for the whole AI workflow.  `recommended_action` is always
 * filled in so the UI has something concrete to tell the user.
 */
export class AiFailure extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ details?: unknown, recoverable?: boolean, recommended_action?: string, status?: number | null }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AiFailure";
    this.code = AI_FAILURE_CODES.includes(code) ? code : "provider_error";
    this.details = options.details === undefined ? null : options.details;
    this.recoverable = options.recoverable === undefined
      ? AI_RECOVERABLE_CODES.includes(this.code)
      : options.recoverable === true;
    const defaults = AI_FAILURE_DEFAULTS[this.code] ||
      AI_FAILURE_DEFAULTS.provider_error;
    this.recommended_action = options.recommended_action ||
      (defaults ? defaults.action : "") ||
      "";
    this.status = options.status === undefined ? null : options.status;
  }
}

/**
 * @param {string} [message]
 * @returns {AiFailure}
 */
function cancelledFailure(message) {
  return new AiFailure(
    "cancelled",
    message || "这次 AI 请求已经取消，课程内容没有任何改动。",
  );
}

/* ------------------------------------------------------------------ *
 * Context assembly (pure read)
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @returns {AiScopeKind}
 */
function normalizeScopeKind(value) {
  return value === "course" || value === "block" ? value : "lesson";
}

/**
 * @param {unknown} value
 * @returns {{ requirements: boolean, assets: boolean, completion: boolean, nearby: boolean }}
 */
function normalizeInclude(value) {
  const source = recordOf(value);
  return {
    requirements: source.requirements !== false,
    assets: source.assets !== false,
    completion: source.completion !== false,
    nearby: source.nearby !== false,
  };
}

/** @type {Record<string, string>} */
const REQUIREMENT_TYPE_LABELS = {
  text: "文字",
  image: "图片",
  gif: "GIF",
  video: "视频",
  audio: "音频",
  table: "表格",
  chart: "图表",
  quote: "引用",
  case: "案例",
  link: "链接",
  data: "数据",
  other: "其他",
};
/** @type {Record<string, string>} */
const REQUIREMENT_STATUS_LABELS = {
  open: "待补",
  resolved: "已完成",
  ignored: "已忽略",
};
/** @type {Record<string, string>} */
const PRIORITY_LABELS = { low: "低", normal: "普通", high: "高" };
/** @type {Record<string, string>} */
const NEARBY_LABELS = {
  previous: "上一课",
  next: "下一课",
  stage_sibling: "同阶段",
};
/** @type {Record<string, string>} */
const DRAFT_STATUS_LABELS = {
  draft: "草稿",
  reviewing: "等待审核",
  applied: "已应用",
  discarded: "已拒绝",
};
/** @type {Record<string, string>} */
const SUGGESTION_STATUS_LABELS = {
  pending: "待处理",
  accepted: "已接受",
  ignored: "已忽略",
};

/**
 * @param {string} type
 * @returns {string}
 */
function requirementTypeLabel(type) {
  return REQUIREMENT_TYPE_LABELS[type] || type || "其他";
}

/**
 * @param {string} priority
 * @returns {string}
 */
function priorityLabel(priority) {
  return PRIORITY_LABELS[priority] || priority || "普通";
}

/**
 * @param {import("../src/domain/types.ts").Stage | null} stage
 * @returns {string}
 */
function stageTitle(stage) {
  return stage ? `${stage.code ? `${stage.code} ` : ""}${stage.title}`.trim() : "未分组";
}

/**
 * Course map text: structure and derived progress only, never lesson bodies.
 *
 * @param {ProjectData} data
 * @param {ReturnType<typeof courseMap>} map
 * @param {string} targetId
 * @returns {string}
 */
function courseMapText(data, map, targetId) {
  const lines = [`课程：${data.project ? data.project.title : "未命名课程"}`];
  for (const stage of map.stages) {
    lines.push(
      `阶段 ${stage.code || "—"} ${stage.title}（${stage.lesson_count} 课，完成 ${stage.complete_count}，待补 ${stage.open_requirements}）`,
    );
    for (const lesson of stage.lessons) {
      const marker = lesson.id === targetId ? " ← 本次目标课次" : "";
      lines.push(
        `  - ${lesson.code} ${lesson.title}（正文 ${lesson.block_count} 段，媒体 ${lesson.media_count}，待补 ${lesson.open_requirements}，完成度 ${lesson.progress.percentage}%）${marker}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * A short title for a block: media blocks name their asset, text blocks get the
 * first characters of their text.  The block scope only ever ships this much of
 * a block it was not asked about.
 *
 * @param {ProjectData} data
 * @param {Block} block
 * @returns {string}
 */
function blockTitleOf(data, block) {
  const asset = assetForBlock(data, block);
  const summary = MEDIA_BLOCK_TYPES.includes(block.type) && asset
    ? `素材 ${asset.filename}`
    : sanitizeAiText(textOf(block.content)).replace(/\s+/g, " ").trim();
  return summary.length > 40 ? `${summary.slice(0, 40)}…` : summary;
}

/**
 * One lesson's structure: order, type, block id and a very short summary.
 * This is what the block scope ships instead of the lesson body.
 *
 * @param {ProjectData} data
 * @param {ContentItem} item
 * @param {Block[]} lessonBlocks
 * @param {string | null} targetBlockId
 * @returns {string}
 */
function lessonStructureText(data, item, lessonBlocks, targetBlockId) {
  const lines = [
    `课次：${item.code} ${item.title}`,
    `正文区块（共 ${lessonBlocks.length} 段）：`,
  ];
  if (lessonBlocks.length === 0) lines.push("  （这一课还没有正文区块）");
  lessonBlocks.forEach((block, index) => {
    const summary = blockTitleOf(data, block);
    lines.push(
      `  ${index + 1}. [${block.type}] ${summary || "（空）"}${block.id === targetBlockId ? " ← 目标区块" : ""} (block_id: ${block.id})`,
    );
  });
  return lines.join("\n");
}

/**
 * Full body of one lesson: order, type, block id and text.  Used by the course
 * and lesson scopes, which the user explicitly asked to send as a whole.
 *
 * @param {Block[]} lessonBlocks
 * @returns {string}
 */
function lessonBodyText(lessonBlocks) {
  return lessonBlocks.length
    ? lessonBlocks.map((block, index) =>
      `[${index + 1}] ${blockLabel(block.type)}（${block.type}）(block_id: ${block.id})\n${textOf(block.content)}`
    ).join("\n\n")
    : "（这一课还没有正文区块）";
}

/**
 * Full text of one block, with the identity the model must quote back.
 *
 * @param {ProjectData} data
 * @param {Block} block
 * @param {number} position
 * @param {number} total
 * @returns {string}
 */
function blockBodyText(data, block, position, total) {
  const asset = assetForBlock(data, block);
  const lines = [
    `区块 id：${block.id}`,
    `类型：${blockLabel(block.type)}（${block.type}）`,
    `位置：第 ${position} 段 / 共 ${total} 段`,
  ];
  if (asset) lines.push(`关联素材：${asset.filename}（${assetLabel(asset.type)}）`);
  lines.push("正文：", textOf(block.content));
  return lines.join("\n");
}

/**
 * @param {ProjectData} data
 * @param {ContentItem} item
 * @param {Requirement} requirement
 * @returns {string}
 */
function requirementText(data, item, requirement) {
  const anchor = requirement.anchor_block_id
    ? blocksOf(data).find((block) => block.id === requirement.anchor_block_id)
    : null;
  return [
    `课次：${item.code} ${item.title}`,
    `类型：${requirementTypeLabel(requirement.type)}（${requirement.type}）`,
    `状态：${REQUIREMENT_STATUS_LABELS[requirement.status] || requirement.status}（${requirement.status}）`,
    `优先级：${priorityLabel(requirement.priority)}`,
    `说明：${requirement.note || "（没有填写说明）"}`,
    `锚点区块：${anchor ? `${anchor.id}（${blockLabel(anchor.type)}）` : "无"}`,
  ].join("\n");
}

/**
 * @param {ProjectData} data
 * @param {Asset} asset
 * @returns {string}
 */
function assetText(data, asset) {
  const usedBy = contentItemsOf(data)
    .filter((item) =>
      lessonAssets(data, item.id).some((candidate) => candidate.id === asset.id)
    )
    .map((item) => `${item.code} ${item.title}`);
  return [
    `文件名：${asset.filename}`,
    `类型：${assetLabel(asset.type)}（${asset.type}）`,
    `MIME：${asset.mime_type || "未知"}`,
    `大小：${formatBytes(asset.file_size)}`,
    `被引用：${usedBy.length ? usedBy.join("、") : "尚未被任何课次引用"}`,
  ].join("\n");
}

/**
 * @param {ProjectData} data
 * @param {ContentItem} item
 * @returns {string}
 */
function completionText(data, item) {
  const progress = lessonProgress(data, item.id);
  const gaps = gapCounts(data, item.id);
  const statuses = statusViews(data, item.id).filter((status) =>
    ["content", "media", "layout", "review"].includes(status.key)
  );
  return [
    `课次：${item.code} ${item.title}`,
    `完成度：${progress.percentage}%（${progress.complete ? "已完成" : "未完成"}）`,
    `正文：${progress.block_count} 段（空正文 ${progress.empty_text_blocks} 段，占位 ${progress.placeholders} 处）`,
    `待补：共 ${gaps.total} 项（正文 ${gaps.by_scope.content} / 排版 ${gaps.by_scope.layout}）`,
    `缺少素材的媒体区块：${progress.missing_media}`,
    `状态：${statuses.map((status) => `${status.name}=${status.option || "未设置"}`).join("；")}`,
    progress.reasons.length
      ? `未完成原因：${progress.reasons.join("；")}`
      : "未完成原因：无",
  ].join("\n");
}

/**
 * A lesson outside the reading order is either archived or deleted; the user
 * needs a different next step for each, so they get different messages.
 *
 * @param {ProjectData} data
 * @param {Document | null} document
 * @param {string | null} [itemId]
 * @returns {AiFailure}
 */
function archivedOrMissingLesson(data, document, itemId = null) {
  const id = itemId || (document ? document.content_item_id : "");
  const item = contentItemsOf(data).find((candidate) => candidate.id === id) ||
    null;
  if (item && item.archived) {
    return new AiFailure(
      "invalid_request",
      `课次「${item.code} ${item.title}」已经归档，不能作为 AI 范围。请先恢复这一课再试。`,
      { recoverable: false },
    );
  }
  return new AiFailure(
    "invalid_request",
    id
      ? `找不到课次 ${id}，它可能已经被删除。请重新打开一课再试。`
      : "这个正文区块不属于任何课次，不能作为 AI 范围。请重新选择区块。",
    { recoverable: false },
  );
}

/**
 * Assemble the exact context that would be sent to a model.
 *
 * Pure read: `data` is never mutated, no canonical row is created.  The same
 * `data` and the same `input` always produce byte-identical `items`.
 *
 * @param {ProjectData} data
 * @param {{
 *   scope: AiScopeKind,
 *   content_item_id?: string | null,
 *   block_id?: string | null,
 *   instruction?: string,
 *   include?: { requirements?: boolean, assets?: boolean, completion?: boolean, nearby?: boolean },
 * }} input
 * @returns {AiContext}
 */
export function assembleAiContext(data, input) {
  const request = recordOf(input);
  const kind = normalizeScopeKind(request.scope);
  const include = normalizeInclude(request.include);
  const instruction = sanitizeAiText(stringOf(request.instruction)).trim();
  const map = courseMap(data, null);
  const lessons = map.lessons;
  const requestedItemId = idOf(request.content_item_id);
  const requestedBlockId = idOf(request.block_id);

  if (lessons.length === 0) {
    throw new AiFailure(
      "invalid_request",
      "这门课程还没有课次，请先建一课再使用课程范围。",
      { recoverable: false },
    );
  }

  /** @type {ContentItem | null} */
  let target = null;
  /** @type {Block | null} */
  let block = null;
  /** @type {Document | null} */
  let document = null;

  if (kind === "block") {
    if (!requestedBlockId) {
      throw new AiFailure(
        "invalid_request",
        "区块范围需要先选中一个正文区块，再让 AI 帮你改写。",
        { recoverable: false },
      );
    }
    block = blocksOf(data).find((candidate) =>
      candidate.id === requestedBlockId
    ) || null;
    if (!block) {
      throw new AiFailure(
        "invalid_request",
        `找不到正文区块 ${requestedBlockId}，它可能已经被删除。请刷新后重新选择区块。`,
        { recoverable: false },
      );
    }
    document = documentsOf(data).find((candidate) =>
      candidate.id === block?.document_id
    ) || null;
    target = document
      ? lessons.find((lesson) => lesson.id === document?.content_item_id) || null
      : null;
    if (!target) throw archivedOrMissingLesson(data, document);
  } else if (kind === "lesson") {
    target = requestedItemId
      ? lessons.find((lesson) => lesson.id === requestedItemId) || null
      : null;
    if (!target) {
      if (!requestedItemId) {
        throw new AiFailure(
          "invalid_request",
          "课级范围需要先打开一课，再让 AI 参与写作。",
          { recoverable: false },
        );
      }
      throw archivedOrMissingLesson(data, null, requestedItemId);
    }
  } else {
    // Course scope still needs one concrete lesson to target: the active lesson
    // when the caller supplies one, otherwise the first lesson in reading
    // order.  The prompt states both facts honestly.
    target = requestedItemId
      ? lessons.find((lesson) => lesson.id === requestedItemId) || null
      : lessons[0] || null;
    if (!target) {
      throw new AiFailure(
        "invalid_request",
        "这门课程还没有课次，请先建一课再使用课程范围。",
        { recoverable: false },
      );
    }
  }

  if (!document) {
    document = documentsOf(data).find((candidate) =>
      candidate.id === target?.document_id
    ) || documentsOf(data).find((candidate) =>
      candidate.content_item_id === target?.id
    ) || null;
  }
  if (!target) {
    throw new AiFailure(
      "invalid_request",
      "这段时间范围没有对应的课次，请重新打开一课再试。",
      { recoverable: false },
    );
  }
  if (!document) {
    throw new AiFailure(
      "invalid_request",
      `课次「${target.code} ${target.title}」还没有正文文档，请先打开它并添加一段正文。`,
      { recoverable: false },
    );
  }

  const targetLesson = target;
  const targetDocument = document;
  const lessonBlocks = blocksFor(data, targetLesson.id);
  const progress = lessonProgress(data, targetLesson.id);
  const stage = stagesOf(data).find((candidate) =>
    candidate.id === targetLesson.stage_id
  ) || null;
  const blockPosition = block
    ? lessonBlocks.findIndex((candidate) => candidate.id === block?.id) + 1
    : 0;
  const blockAsset = block ? assetForBlock(data, block) : null;

  /** @type {AiContextItem[]} */
  const items = [];
  /** @type {AiExcludedItem[]} */
  const excluded = [];
  /** @type {Map<string, number>} */
  const skipped = new Map();
  /** @type {string[]} */
  const truncated = [];
  // The instruction travels as an item too, but it may never eat the whole
  // budget: a pasted document in the instruction box would otherwise starve
  // every course item out of the context.
  const instructionItem = instruction.length > AI_CONTEXT_LIMITS.instruction_chars
    ? `${instruction.slice(0, AI_CONTEXT_LIMITS.instruction_chars - 1)}…`
    : instruction;
  if (instructionItem !== instruction) {
    truncated.push(
      `用户要求超过 ${AI_CONTEXT_LIMITS.instruction_chars} 字，已截断后发送`,
    );
  }
  const reserve = instructionItem.length + 64;
  let used = 0;

  /**
   * @param {string} sourceType
   * @param {string} sourceId
   * @param {string} label
   * @param {string} raw
   * @returns {AiContextItem | null}
   */
  const pushItem = (sourceType, sourceId, label, raw) => {
    const text = sanitizeAiText(raw);
    const clipped = text.length > AI_CONTEXT_LIMITS.item_chars;
    const content = clipped
      ? `${text.slice(0, AI_CONTEXT_LIMITS.item_chars)}\n…（内容过长，已截断 ${
        text.length - AI_CONTEXT_LIMITS.item_chars
      } 字）`
      : text;
    if (used + content.length > AI_CONTEXT_LIMITS.total_chars - reserve) {
      skipped.set(sourceType, (skipped.get(sourceType) || 0) + 1);
      return null;
    }
    used += content.length;
    if (clipped) truncated.push(`${label}（${sourceId}）超过 ${AI_CONTEXT_LIMITS.item_chars} 字`);
    const item = {
      source_type: sourceType,
      source_id: sourceId,
      label,
      content,
      chars: content.length,
    };
    items.push(item);
    return item;
  };

  // 1. Course map — structure and progress for every scope.  Never a body.
  pushItem(
    "course_map",
    data.project.id,
    kind === "course"
      ? "课程地图（结构、进度、目标课次）"
      : "课程结构（只有课次标题与进度，没有其他课次的正文）",
    courseMapText(data, map, targetLesson.id),
  );

  // 2. Scope-specific content.
  if (kind === "course") {
    for (const lesson of lessons) {
      const lessonDocument = documentsOf(data).find((candidate) =>
        candidate.id === lesson.document_id
      ) || null;
      if (!lessonDocument) continue;
      pushItem(
        "document",
        lessonDocument.id,
        `课次正文：${lesson.code} ${lesson.title}`,
        lessonBodyText(blocksFor(data, lesson.id)),
      );
    }
  } else if (kind === "lesson") {
    pushItem(
      "document",
      targetDocument.id,
      `本课正文：${targetLesson.code} ${targetLesson.title}`,
      lessonBodyText(lessonBlocks),
    );
  } else {
    pushItem(
      "document",
      targetDocument.id,
      `本课结构：${targetLesson.code} ${targetLesson.title}`,
      lessonStructureText(data, targetLesson, lessonBlocks, block?.id || null),
    );
    if (block) {
      pushItem(
        "custom",
        block.id,
        `目标区块全文（${blockLabel(block.type)}）`,
        blockBodyText(data, block, blockPosition, lessonBlocks.length),
      );
    }
    if (include.nearby && block) {
      const index = lessonBlocks.findIndex((candidate) =>
        candidate.id === block?.id
      );
      const previous = index > 0 ? lessonBlocks[index - 1] : null;
      const next = index >= 0 && index < lessonBlocks.length - 1
        ? lessonBlocks[index + 1]
        : null;
      if (previous) {
        pushItem(
          "custom",
          previous.id,
          "上一区块（只有标题）",
          `${blockLabel(previous.type)}：${blockTitleOf(data, previous)}`,
        );
      }
      if (next) {
        pushItem(
          "custom",
          next.id,
          "下一区块（只有标题）",
          `${blockLabel(next.type)}：${blockTitleOf(data, next)}`,
        );
      }
    }
  }

  // 3. Requirements.
  const scopedLessons = kind === "course"
    ? lessons
    : lessons.filter((lesson) => lesson.id === targetLesson.id);
  const scopedRequirements = requirementsOf(data).filter((requirement) =>
    scopedLessons.some((lesson) => lesson.id === requirement.content_item_id)
  );
  if (include.requirements) {
    for (const requirement of scopedRequirements) {
      const owner = scopedLessons.find((lesson) =>
        lesson.id === requirement.content_item_id
      ) || targetLesson;
      pushItem(
        "requirement",
        requirement.id,
        `待补：${requirementTypeLabel(requirement.type)}（${owner.code}）`,
        requirementText(data, owner, requirement),
      );
    }
  } else {
    excluded.push({
      source_type: "requirement",
      source_id: targetLesson.id,
      reason: "本次没有勾选「待补要求」，因此没有发送任何 Requirement 内容。",
    });
  }

  // 4. Asset metadata (never the files themselves).
  const scopedAssets = kind === "course"
    ? assetsOf(data)
    : lessonAssets(data, targetLesson.id);
  if (include.assets) {
    for (const asset of scopedAssets) {
      pushItem(
        "asset",
        asset.id,
        `素材：${asset.filename}`,
        assetText(data, asset),
      );
    }
  } else {
    excluded.push({
      source_type: "asset",
      source_id: targetLesson.id,
      reason: "本次没有勾选「素材信息」，因此没有发送任何素材元数据。",
    });
  }

  // 5. Completion / status.
  if (include.completion) {
    pushItem(
      "custom",
      targetLesson.id,
      "完成度与状态",
      completionText(data, targetLesson),
    );
  } else {
    excluded.push({
      source_type: "custom",
      source_id: targetLesson.id,
      reason: "本次没有勾选「完成度与状态」，因此没有发送完成度信息。",
    });
  }

  // 6. Honest scope boundaries.
  if (kind === "lesson") {
    excluded.push({
      source_type: "custom",
      source_id: data.project.id,
      reason: "本次是课级范围，其他课次的正文没有发送。",
    });
  }
  if (kind === "block") {
    excluded.push({
      source_type: "document",
      source_id: targetDocument.id,
      reason: "本次是区块范围，本课其他区块的正文没有发送（只发送了结构与相邻区块标题）。",
    });
  }
  if (!include.nearby && kind !== "course") {
    excluded.push({
      source_type: "custom",
      source_id: targetLesson.id,
      reason: "本次没有勾选「相邻内容」，因此没有发送前后区块或相邻课次的标题。",
    });
  }
  excluded.push({
    source_type: "custom",
    source_id: data.project.id,
    reason: "项目设置、本地连接信息与任何密钥字段都不会进入 AI 上下文。",
  });

  // 7. Limits: say exactly what was dropped.
  for (const [sourceType, count] of skipped) {
    excluded.push({
      source_type: sourceType,
      source_id: data.project.id,
      reason: `另有 ${count} 项内容因为超出单次上下文长度上限（${AI_CONTEXT_LIMITS.total_chars} 字）没有发送。`,
    });
  }
  for (const note of truncated) {
    excluded.push({
      source_type: "custom",
      source_id: targetLesson.id,
      reason: `内容过长已截断：${note}。`,
    });
  }

  // 8. The instruction travels with the items so `items` stays the complete
  //    list of everything that will be sent.
  if (instructionItem) {
    pushItem("custom", targetLesson.id, "用户要求", instructionItem);
  }

  /** @type {AiNearbyEntry[]} */
  const nearby = [];
  if (kind !== "course") {
    const index = lessons.findIndex((lesson) => lesson.id === targetLesson.id);
    const previous = index > 0 ? lessons[index - 1] : null;
    const next = index >= 0 && index < lessons.length - 1
      ? lessons[index + 1]
      : null;
    if (previous) {
      nearby.push({
        relation: "previous",
        code: previous.code,
        title: previous.title,
      });
    }
    if (next) {
      nearby.push({ relation: "next", code: next.code, title: next.title });
    }
    for (const sibling of lessons.filter((lesson) =>
      lesson.stage_id === targetLesson.stage_id && lesson.id !== targetLesson.id
    )) {
      nearby.push({
        relation: "stage_sibling",
        code: sibling.code,
        title: sibling.title,
      });
    }
  }

  const statusDimensions = statusViews(data, targetLesson.id)
    .filter((status) =>
      ["content", "media", "layout", "review"].includes(status.key)
    )
    .map((status) => ({
      key: status.key,
      label: status.name,
      selected: status.option,
    }));

  /** @type {AiContext} */
  const context = {
    scope: {
      kind,
      label: kind === "course"
        ? `整门课程（本次可修改的目标课次：${targetLesson.code} ${targetLesson.title}）`
        : kind === "lesson"
        ? `课次 ${targetLesson.code} ${targetLesson.title}`
        : `区块「${block ? blockLabel(block.type) : "正文"}」@ ${targetLesson.code} ${targetLesson.title}`,
      content_item_id: targetLesson.id,
      block_id: block ? block.id : null,
    },
    project: {
      id: data.project.id,
      title: data.project.title,
    },
    course: {
      title: data.project.title,
      lesson_count: map.lesson_count,
      stage_count: stagesOf(data).filter((candidate) => !candidate.archived)
        .length,
      completed_lessons: map.complete_count,
      open_requirements: map.open_requirements,
      missing_assets: map.missing_media,
    },
    lesson: {
      id: targetLesson.id,
      code: targetLesson.code,
      title: targetLesson.title,
      type: targetLesson.type,
      stage_title: stageTitle(stage),
      block_count: lessonBlocks.length,
      media_count: lessonBlocks.filter((candidate) =>
        MEDIA_BLOCK_TYPES.includes(candidate.type) &&
        Boolean(assetForBlock(data, candidate))
      ).length,
      completion_percentage: progress.percentage,
    },
    block: block
      ? {
        id: block.id,
        type: block.type,
        label: blockLabel(block.type),
        text: sanitizeAiText(textOf(block.content)),
        position: blockPosition,
        asset_filename: blockAsset ? blockAsset.filename : "",
      }
      : null,
    nearby,
    requirements: scopedRequirements.map((requirement) => ({
      id: requirement.id,
      type: requirement.type,
      note: requirement.note,
      priority: requirement.priority,
      status: requirement.status,
      anchor_block_id: requirement.anchor_block_id ?? null,
      resolved_asset_id: requirement.resolved_asset_id ?? null,
    })),
    assets: scopedAssets.map((asset) => ({
      id: asset.id,
      filename: asset.filename,
      type: asset.type,
      mime_type: asset.mime_type || "",
      size: Number(asset.file_size) || 0,
      used_by: contentItemsOf(data)
        .filter((item) =>
          lessonAssets(data, item.id).some((candidate) => candidate.id === asset.id)
        )
        .map((item) => item.id),
    })),
    completion: include.completion
      ? {
        percentage: progress.percentage,
        dimensions: statusDimensions,
        gaps: gapCounts(data, targetLesson.id),
      }
      : null,
    instruction,
    items,
    excluded,
    payload_chars: items.reduce((sum, item) => sum + item.chars, 0),
  };

  return /** @type {AiContext} */ (scrubCredentialKeys(context));
}

/**
 * The system prompt that pins the answer contract the parser expects.
 *
 * @returns {string}
 */
export function aiSystemPrompt() {
  return [
    "你是 AI Course Workbench 的课程写作助手，正在帮用户修改一门课程。",
    "重要：你不能直接修改课程文件。你只能给出说明和结构化修改建议，用户会在 Diff 里逐条审核后决定是否应用。",
    "",
    "只返回一个 JSON 对象，不要写 JSON 以外的任何文字，也不要使用 Markdown 围栏：",
    "{",
    '  "answer": "给用户看的中文说明",',
    '  "changes": [ … ]',
    "}",
    "",
    "changes 只能使用下面四种 op，不要发明新的字段：",
    '1. {"op":"replace_block","block_id":"上下文中出现过的区块 id","content":"新的正文","reason":"为什么这样改"}',
    '2. {"op":"insert_block","after_block_id":"插到这个区块后面，null 表示放到本课末尾","type":"paragraph","content":"新正文","reason":"…"}',
    '3. {"op":"create_requirement","requirement_type":"text|image|gif|video|audio|table|chart|quote|case|link|data|other","note":"要补什么","priority":"low|normal|high","anchor_block_id":null,"reason":"…"}',
    '4. {"op":"move_block","block_id":"要移动的区块 id","after_block_id":"移动到哪个区块之后，null 表示移到最前面","reason":"…"}',
    "",
    "规则：",
    "- 只回答问题、不需要改正文时，changes 用空数组 []。",
    "- 只能引用上下文中出现过的 block_id；不确定就不要提议修改。",
    "- 用简体中文回答，说明要具体：改了什么、为什么。",
  ].join("\n");
}

/**
 * Turn an assembled context into the `{ system, user }` text a provider call
 * needs.  Pure: the context object is only read.
 *
 * @param {AiContext} context
 * @returns {{ system: string, user: string }}
 */
export function aiContextPromptPayload(context) {
  const source = recordOf(context);
  const scope = recordOf(source.scope);
  const project = recordOf(source.project);
  const lesson = recordOf(source.lesson);
  const block = recordOf(source.block);
  const nearby = Array.isArray(source.nearby) ? source.nearby : [];
  const items = Array.isArray(source.items) ? source.items : [];
  const instruction = stringOf(source.instruction).trim();

  const header = [`# 课程上下文`, `范围：${stringOf(scope.label) || "未指定"}`];
  if (stringOf(project.title)) header.push(`项目：${project.title}`);
  if (lesson.id) {
    header.push(
      `课次：${lesson.code} ${lesson.title}（${lesson.stage_title}，正文 ${lesson.block_count} 段，完成度 ${lesson.completion_percentage}%）`,
    );
  }
  if (block.id) {
    header.push(`当前区块：${block.label}（第 ${block.position} 段）`);
  }
  if (nearby.length) {
    header.push(
      `相邻内容：${
        nearby.map((entry) =>
          `${NEARBY_LABELS[stringOf(recordOf(entry).relation)] || "相邻"} ${
            stringOf(recordOf(entry).code)
          } ${stringOf(recordOf(entry).title)}`
        ).join("；")
      }`,
    );
  }

  const body = items.map((entry) => {
    const item = recordOf(entry);
    return `【${stringOf(item.label)}】(${stringOf(item.source_type)}:${stringOf(item.source_id)}，${Number(item.chars) || 0} 字)\n${stringOf(item.content)}`;
  });

  const instructionRendered = items.some((entry) =>
    stringOf(recordOf(entry).label) === "用户要求"
  );
  const parts = [header.join("\n"), "## 将发送给模型的内容"];
  parts.push(body.length ? body.join("\n\n") : "（本次没有附带任何课程内容。）");
  if (!instructionRendered) {
    parts.push("## 用户要求");
    parts.push(instruction || "（用户没有填写额外要求，请根据上下文给出下一步建议。）");
  }

  return {
    system: aiSystemPrompt(),
    user: parts.join("\n\n"),
  };
}

/**
 * One preview line per item that will be sent.  `excluded` stays on the context
 * itself so a preview can show "what is NOT sent" separately.
 *
 * @param {AiContext} context
 * @returns {Array<{ label: string, chars: number, source_type: string }>}
 */
export function aiContextPreviewLines(context) {
  const items = Array.isArray(recordOf(context).items)
    ? /** @type {AiContextItem[]} */ (recordOf(context).items)
    : [];
  return items.map((item) => ({
    label: item.label,
    chars: item.chars,
    source_type: item.source_type,
  }));
}

/* ------------------------------------------------------------------ *
 * Provider catalog
 * ------------------------------------------------------------------ */

/** @type {AiProviderPreset[]} */
export const AI_PROVIDER_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai_compatible",
    base_url: "https://api.deepseek.com",
    chat_path: "/chat/completions",
    auth_header: "authorization",
    auth_scheme: "Bearer",
    default_model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    requires_credential: true,
  },
  {
    id: "doubao",
    label: "火山方舟（豆包）",
    kind: "openai_compatible",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    chat_path: "/chat/completions",
    auth_header: "authorization",
    auth_scheme: "Bearer",
    default_model: "doubao-seed-1-6-250615",
    models: [
      "doubao-seed-1-6-250615",
      "doubao-1-5-pro-32k-250115",
      "doubao-1-5-lite-32k-250115",
    ],
    requires_credential: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai_compatible",
    base_url: "https://api.openai.com/v1",
    chat_path: "/chat/completions",
    auth_header: "authorization",
    auth_scheme: "Bearer",
    default_model: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    requires_credential: true,
  },
  {
    id: "custom",
    label: "自定义（OpenAI 兼容）",
    kind: "openai_compatible",
    base_url: "",
    chat_path: "/chat/completions",
    auth_header: "authorization",
    auth_scheme: "Bearer",
    default_model: "",
    models: [],
    requires_credential: true,
  },
  {
    id: "fake",
    label: "本地确定性连接器（离线）",
    kind: "fake",
    base_url: "",
    chat_path: "",
    auth_header: "",
    auth_scheme: "",
    default_model: "fake-deterministic",
    models: ["fake-deterministic"],
    requires_credential: false,
  },
];

/**
 * @param {unknown} id
 * @returns {AiProviderPreset | null}
 */
export function aiProviderPreset(id) {
  const found = AI_PROVIDER_PRESETS.find((preset) => preset.id === id);
  return found ? /** @type {AiProviderPreset} */ (structuredClone(found)) : null;
}

/**
 * Catalog for the UI dropdown.  Copies, so a caller cannot mutate the catalog.
 *
 * @returns {AiProviderPreset[]}
 */
export function aiProviderDescriptors() {
  return AI_PROVIDER_PRESETS.map((preset) =>
    /** @type {AiProviderPreset} */ (structuredClone(preset))
  );
}

/**
 * @param {unknown} value
 * @returns {AiProviderPreset | null}
 */
function resolvePreset(value) {
  if (typeof value === "string") return aiProviderPreset(value);
  if (value && typeof value === "object") {
    const record = recordOf(value);
    if (typeof record.id === "string") {
      const known = aiProviderPreset(record.id);
      if (known) return known;
    }
    if (typeof record.kind === "string" && typeof record.id === "string") {
      return /** @type {AiProviderPreset} */ (structuredClone(value));
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Request building
 * ------------------------------------------------------------------ */

/**
 * Build the one request shape every transport understands.  The returned
 * headers never contain a credential: they only tell the transport process
 * which provider's locally-stored secret to inject.  The API key lives in the
 * transport process (Rust / Deno service), never in the page.
 *
 * The result maps 1:1 onto the `ai.complete` command payload, so nothing has to
 * spread a whole preset (which carries UI-only fields such as
 * `requires_credential`) across the bridge.
 *
 * @param {{
 *   preset: string | AiProviderPreset,
 *   model?: string,
 *   context?: AiContext | { system: string, user: string } | null,
 *   instruction?: string,
 *   wants_changes?: boolean,
 *   base_url?: string,
 * }} input
 * @returns {{ provider_id: string, url: string, headers: Record<string, string>, body: Record<string, any>, response_kind: "chat", auth: { header: string, scheme: string } }}
 */
export function buildAiProviderCall(input) {
  const request = recordOf(input);
  const preset = resolvePreset(request.preset);
  if (!preset) {
    throw new AiFailure(
      "not_configured",
      `未知的 AI Provider：${String(request.preset ?? "（空）")}。请在 AI 设置里重新选择。`,
      { recoverable: false },
    );
  }
  if (preset.kind === "fake") {
    throw new AiFailure(
      "not_configured",
      "「本地确定性连接器」不需要网络请求，请直接使用 FakeAiConnector。",
      { recoverable: false },
    );
  }
  const baseUrl = String(request.base_url || preset.base_url || "")
    .replace(/\/+$/, "");
  if (!baseUrl) {
    throw new AiFailure(
      "not_configured",
      "这个 Provider 还没有填写 Base URL。请在 AI 设置里补全后再试。",
    );
  }
  const model = String(request.model || preset.default_model || "");
  if (!model) {
    throw new AiFailure(
      "not_configured",
      "还没有为这个 Provider 选择模型。请在 AI 设置里选择模型后再试。",
    );
  }

  const payload = promptPayloadFor(request.context, request.instruction);
  /** @type {Record<string, any>} */
  const body = {
    model,
    messages: [
      { role: "system", content: payload.system },
      { role: "user", content: payload.user },
    ],
    stream: false,
    temperature: 0.2,
  };
  if (request.wants_changes === true) {
    body.response_format = { type: "json_object" };
  }

  return {
    // Only the fields the transport contract needs: never the whole preset,
    // which also carries UI-only metadata.
    provider_id: preset.id,
    url: `${baseUrl}${preset.chat_path || "/chat/completions"}`,
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "x-workbench-auth": preset.id,
      "x-workbench-provider": preset.id,
    },
    body,
    response_kind: "chat",
    auth: { header: preset.auth_header, scheme: preset.auth_scheme },
  };
}

/**
 * @param {unknown} context
 * @param {unknown} instruction
 * @returns {{ system: string, user: string }}
 */
function promptPayloadFor(context, instruction) {
  const source = recordOf(context);
  const extra = stringOf(instruction).trim();
  if (typeof source.system === "string" && typeof source.user === "string") {
    return {
      system: source.system,
      user: source.user + (extra ? `\n\n## 用户要求\n${extra}` : ""),
    };
  }
  if (Array.isArray(source.items)) {
    const payload = aiContextPromptPayload(
      /** @type {AiContext} */ (context),
    );
    const alreadySent = stringOf(source.instruction).trim().length > 0;
    return {
      system: payload.system,
      user: payload.user +
        (!alreadySent && extra ? `\n\n## 用户要求\n${extra}` : ""),
    };
  }
  return {
    system: aiSystemPrompt(),
    user: extra ? `## 用户要求\n${extra}` : "（没有上下文，也没有具体指令。）",
  };
}

/* ------------------------------------------------------------------ *
 * Response normalisation (JSON + SSE)
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @returns {string}
 */
function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const record = recordOf(part);
        return typeof record.text === "string" ? record.text : "";
      })
      .join("");
  }
  return "";
}

/**
 * @param {unknown} chunk
 * @param {{ content: string, model: string, finish: string, usage: JsonValue }} state
 */
function accumulateChunk(chunk, state) {
  const record = recordOf(chunk);
  if (typeof record.model === "string" && record.model) state.model = record.model;
  if (record.usage && typeof record.usage === "object") {
    state.usage = /** @type {JsonValue} */ (structuredClone(record.usage));
  }
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = recordOf(choices[0]);
  if (typeof choice.finish_reason === "string" && choice.finish_reason) {
    state.finish = choice.finish_reason;
  }
  const delta = contentText(recordOf(choice.delta).content);
  const message = contentText(recordOf(choice.message).content);
  const plain = contentText(choice.text);
  state.content += delta || message || plain;
}

/**
 * @param {string} text
 * @param {{ content: string, model: string, finish: string, usage: JsonValue }} state
 */
function accumulateSse(text, state) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      accumulateChunk(JSON.parse(payload), state);
    } catch {
      // A single unparsable SSE frame is skipped: providers interleave
      // keep-alive comments and partial writes.  If nothing parses at all the
      // caller still gets a readable malformed_response.
    }
  }
}

/**
 * Normalise a transport result into `{ text, model, usage, finish_reason,
 * raw_kind }`.  Accepts both a JSON chat completion and an SSE
 * (`text/event-stream`) body, given either as a raw string or as parsed chunks.
 *
 * @param {string | AiProviderPreset | null} preset
 * @param {unknown} transportResult
 * @returns {{ text: string, model: string, usage: JsonValue, finish_reason: string, raw_kind: "json" | "stream" }}
 */
export function normalizeAiProviderResponse(preset, transportResult) {
  const result = recordOf(transportResult);
  const providerLabel = (() => {
    const resolved = resolvePreset(preset);
    return resolved ? resolved.label : "Provider";
  })();
  if (result.ok === false) {
    const code = AI_FAILURE_CODES.includes(stringOf(result.code))
      ? stringOf(result.code)
      : "provider_error";
    throw new AiFailure(
      code,
      stringOf(result.message) ||
        `${providerLabel} 没有返回可用的结果，请稍后重试。`,
      {
        status: Number.isFinite(result.status) ? Number(result.status) : null,
        details: sanitizeAiText(stringOf(result.detail)).slice(0, 500) || null,
      },
    );
  }

  const headers = recordOf(result.headers);
  /** @type {Record<string, string>} */
  const lowerHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    lowerHeaders[key.toLowerCase()] = stringOf(value);
  }
  const contentType = lowerHeaders["content-type"] || "";
  const body = result.body;
  const bodyIsString = typeof body === "string";
  const streamHint = result.response_kind === "stream" ||
    contentType.includes("event-stream") ||
    (bodyIsString && /** @type {string} */ (body).trimStart().startsWith("data:"));

  /** @type {{ content: string, model: string, finish: string, usage: JsonValue }} */
  const state = { content: "", model: "", finish: "", usage: null };

  if (Array.isArray(body)) {
    for (const chunk of body) accumulateChunk(chunk, state);
  } else if (streamHint && bodyIsString) {
    accumulateSse(/** @type {string} */ (body), state);
  } else if (streamHint && !bodyIsString) {
    accumulateChunk(body, state);
  } else {
    let parsed = body;
    if (bodyIsString) {
      try {
        parsed = JSON.parse(/** @type {string} */ (body));
      } catch {
        throw new AiFailure(
          "malformed_response",
          `${providerLabel} 返回的内容不是合法 JSON，无法读取回答。可以重试一次，或换一个模型。`,
          { details: sanitizeAiText(/** @type {string} */ (body)).slice(0, 300) },
        );
      }
    }
    accumulateChunk(parsed, state);
  }

  const text = state.content.trim();
  if (!text) {
    throw new AiFailure(
      "malformed_response",
      `${providerLabel} 返回了空内容，无法解析成建议。可以重试一次，或换一个模型。`,
    );
  }
  return {
    text,
    model: state.model,
    usage: state.usage,
    finish_reason: state.finish,
    raw_kind: streamHint ? "stream" : "json",
  };
}

/* ------------------------------------------------------------------ *
 * Answer parsing
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} change
 * @param {number} index
 * @returns {AiChange}
 */
function normalizeAiChange(change, index) {
  const where = `第 ${index + 1} 条修改`;
  /** @param {string} detail */
  const malformed = (detail) =>
    new AiFailure(
      "malformed_response",
      `模型返回的修改建议无法解析：${where}${detail}。请重试一次，或换一个更擅长结构化输出的模型。`,
    );
  const record = recordOf(change);
  if (!change || typeof change !== "object" || Array.isArray(change)) {
    throw malformed("不是一个对象");
  }
  const op = stringOf(record.op);
  if (!AI_CHANGE_OPS.includes(op)) {
    throw malformed(
      `使用了不支持的操作「${op || "（空）"}」，只支持 ${
        AI_CHANGE_OPS.join(" / ")
      }`,
    );
  }
  const reason = stringOf(record.reason).trim();

  if (op === "replace_block") {
    const blockId = idOf(record.block_id);
    if (!blockId) throw malformed("缺少 block_id");
    if (!("content" in record) || record.content === undefined) {
      throw malformed("缺少新的 content");
    }
    return {
      op,
      block_id: blockId,
      content: cloneJson(record.content),
      reason,
    };
  }

  if (op === "insert_block") {
    const type = stringOf(record.type) || "paragraph";
    if (!AI_BLOCK_TYPES.includes(type)) {
      throw malformed(`的区块类型「${type}」不存在`);
    }
    if (!("content" in record) || record.content === undefined) {
      throw malformed("缺少新区块的 content");
    }
    const afterBlockId = idOf(record.after_block_id);
    /** @type {AiChange} */
    const normalized = {
      op,
      after_block_id: afterBlockId,
      type,
      content: cloneJson(record.content),
      reason,
    };
    if (type === "placeholder") {
      const requirementType = stringOf(record.requirement_type) || "text";
      if (!AI_REQUIREMENT_TYPES.includes(requirementType)) {
        throw malformed(`的待补类型「${requirementType}」不存在`);
      }
      normalized.requirement_type = requirementType;
    }
    return normalized;
  }

  if (op === "create_requirement") {
    const requirementType = stringOf(record.requirement_type) ||
      stringOf(record.type) || "text";
    if (!AI_REQUIREMENT_TYPES.includes(requirementType)) {
      throw malformed(`的待补类型「${requirementType}」不存在`);
    }
    const priority = stringOf(record.priority) || "normal";
    if (!AI_PRIORITIES.includes(priority)) {
      throw malformed(`的优先级「${priority}」不存在`);
    }
    return {
      op,
      requirement_type: requirementType,
      note: stringOf(record.note).trim(),
      priority,
      anchor_block_id: idOf(record.anchor_block_id),
      reason,
    };
  }

  const blockId = idOf(record.block_id);
  if (!blockId) throw malformed("缺少 block_id");
  return {
    op,
    block_id: blockId,
    after_block_id: idOf(record.after_block_id),
    reason,
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
function extractJsonCandidate(text) {
  const fence = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence && typeof fence[1] === "string" && fence[1].trim()) {
    return fence[1].trim();
  }
  return text.trim();
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parse the model text into `{ answer, changes }`.  Unparsable *content*
 * answers degrade to a plain answer; anything that looks like it wanted to
 * change the course but cannot be parsed raises
 * `AiFailure("malformed_response")`.
 *
 * @param {string} text
 * @returns {{ answer: string, changes: AiChange[] }}
 */
export function parseAiAnswer(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new AiFailure(
      "malformed_response",
      "模型没有返回任何内容，无法解析成回答。请重试一次。",
    );
  }
  const raw = text.trim();
  const candidate = extractJsonCandidate(raw);
  const parsed = tryParseJson(candidate);

  if (parsed === undefined) {
    const looksLikeJson = raw.startsWith("{") || raw.startsWith("[") ||
      raw.includes("```json") || raw.includes("```JSON");
    if (looksLikeJson || /\bchanges\b/i.test(raw)) {
      throw new AiFailure(
        "malformed_response",
        "模型的回复提到了修改（changes），但不是合法的 JSON，因此无法生成可审核的 Diff。请重试一次，或在指令里说明要改哪个区块。",
        { details: { excerpt: raw.slice(0, 400) } },
      );
    }
    return { answer: raw, changes: [] };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AiFailure(
      "malformed_response",
      "模型返回的 JSON 不是对象，无法解析成 AI 建议。请重试一次。",
    );
  }
  const record = recordOf(parsed);
  if ("answer" in record && typeof record.answer !== "string") {
    throw new AiFailure(
      "malformed_response",
      "模型返回的 answer 不是文字，无法显示给用户。请重试一次。",
    );
  }
  let rawChanges = [];
  if ("changes" in record) {
    if (!Array.isArray(record.changes)) {
      throw new AiFailure(
        "malformed_response",
        "模型返回的 changes 不是数组，无法生成 Diff。请重试一次。",
      );
    }
    rawChanges = record.changes;
  }
  if (!("answer" in record) && rawChanges.length === 0) {
    throw new AiFailure(
      "malformed_response",
      "模型返回的 JSON 里既没有 answer 也没有 changes，无法使用。请重试一次。",
    );
  }
  const answer = typeof record.answer === "string" ? record.answer.trim() : "";
  const changes = rawChanges.map((change, index) =>
    normalizeAiChange(change, index)
  );
  return { answer, changes };
}

/* ------------------------------------------------------------------ *
 * Connectors
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeScenario(value) {
  const scenario = stringOf(value) || "ok";
  /** @type {Record<string, string>} */
  const aliases = {
    rate_limited: "rate_limit",
    malformed_response: "malformed",
    success: "ok",
  };
  const normalized = aliases[scenario] || scenario;
  const known = [
    "ok",
    "timeout",
    "provider_error",
    "rate_limit",
    "malformed",
    "missing_credential",
    "permission_denied",
    "cancelled",
  ];
  if (!known.includes(normalized)) {
    throw new AiFailure(
      "invalid_request",
      `未知的本地连接器场景：${scenario}。可选场景：${known.join(" / ")}。`,
      { recoverable: false },
    );
  }
  return normalized;
}

/**
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(cancelledFailure());
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(cancelledFailure());
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Marker the offline connector puts in front of a sample rewrite.  It is
 * deliberately visible so nobody can mistake a local sample for a model's work.
 */
const LOCAL_REWRITE_MARKER = "【本地示例改写】";
const LOCAL_REWRITE_REASON =
  "本地离线连接器生成的示例改写，用来在没有可用 Provider 时走通 Diff 与审核流程。";

/**
 * One-line, whitespace-flattened excerpt used inside generated text.
 *
 * @param {unknown} value
 * @param {number} [limit]
 * @returns {string}
 */
function flatExcerpt(value, limit = 40) {
  const text = sanitizeAiText(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Fully offline, fully deterministic connector.  It exists so the whole AI
 * workflow (including every failure path) can be exercised without a network
 * and without a credential.
 *
 * With no explicit `changes` configured it still answers modification requests
 * for a block scope by synthesising one clearly-labelled sample rewrite of that
 * block, so the real window can walk Suggestion → ChangeDraft → Diff → Apply
 * offline.  Course/lesson scope has no single block to target, so it keeps
 * answering without changes.
 */
export class FakeAiConnector {
  /** @param {{ scenario?: string, latency_ms?: number, changes?: unknown[], model?: string, label?: string }} [options] */
  constructor(options = {}) {
    this.scenario = normalizeScenario(options.scenario);
    this.latency_ms = Number.isFinite(options.latency_ms)
      ? Math.max(0, Number(options.latency_ms))
      : 0;
    this.changes = Array.isArray(options.changes)
      ? /** @type {AiChange[]} */ (structuredClone(options.changes))
      : [];
    this.model = stringOf(options.model) || "fake-deterministic";
    this.label = stringOf(options.label) || "本地确定性连接器（离线）";
  }

  /** @returns {AiConnectorDescriptor & { scenario: string }} */
  descriptor() {
    return {
      provider_id: "fake",
      label: this.label,
      model: this.model,
      kind: "fake",
      base_url: "",
      requires_credential: false,
      scenario: this.scenario,
    };
  }

  /**
   * @param {{ instruction?: string, context?: AiContext | null, wants_changes?: boolean }} [request]
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<AiCompletion>}
   */
  async complete(request = {}, options = {}) {
    const signal = options.signal;
    if (signal && signal.aborted) throw cancelledFailure();
    if (this.latency_ms > 0) await delay(this.latency_ms, signal);
    if (signal && signal.aborted) throw cancelledFailure();

    if (this.scenario === "timeout") {
      throw new AiFailure(
        "timeout",
        "本地连接器按设置返回了「超时」场景：Provider 在 60 秒内没有响应。课程内容没有改动。",
      );
    }
    if (this.scenario === "provider_error") {
      throw new AiFailure(
        "provider_error",
        "本地连接器按设置返回了「Provider 错误」场景：Provider 返回了 502。课程内容没有改动。",
        { status: 502 },
      );
    }
    if (this.scenario === "rate_limit") {
      throw new AiFailure(
        "rate_limited",
        "本地连接器按设置返回了「限流」场景：Provider 返回了 429，请稍后重试。",
        { status: 429 },
      );
    }
    if (this.scenario === "malformed") {
      throw new AiFailure(
        "malformed_response",
        "本地连接器按设置返回了「无法解析」场景：模型的回复不是合法 JSON，没有生成 ChangeDraft。",
      );
    }
    if (this.scenario === "missing_credential") {
      throw new AiFailure(
        "missing_credential",
        "本地连接器按设置返回了「缺少密钥」场景：这个 Provider 还没有配置 API Key。",
        { status: 401 },
      );
    }
    if (this.scenario === "permission_denied") {
      throw new AiFailure(
        "permission_denied",
        "本地连接器按设置返回了「未授权」场景：当前密钥没有调用这个模型的权限。",
        { status: 403 },
      );
    }
    if (this.scenario === "cancelled") {
      throw cancelledFailure(
        "本地连接器按设置返回了「已取消」场景：这次请求已经取消，课程内容没有改动。",
      );
    }

    const instruction = stringOf(request.instruction).trim();
    const context = recordOf(request.context);
    const items = Array.isArray(context.items) ? context.items : [];
    const wantsChanges = request.wants_changes === true ||
      AI_MODIFICATION_INTENT.test(instruction);
    /** @type {AiChange[]} */
    let changes = wantsChanges
      ? /** @type {AiChange[]} */ (structuredClone(this.changes))
      : [];
    // No explicit changes configured: still make a modification request
    // reviewable when the scope names one concrete block.  Course/lesson scope
    // has no single block to target, so it keeps answering without changes.
    let synthesized = false;
    if (wantsChanges && changes.length === 0) {
      const sample = this.synthesizeChange(context);
      if (sample) {
        changes = [sample];
        synthesized = true;
      }
    }
    const scopeNote = items.length
      ? `本次上下文包含 ${items.length} 项内容（${Number(context.payload_chars) || 0} 字）`
      : "本次没有附带课程内容";
    const intent = instruction || "（没有填写指令）";
    const answer = changes.length
      ? synthesized
        ? `【${this.label}】针对「${intent}」生成了一条本地示例改写，用来在没有配置真实 Provider 时走通 Diff 与审核流程。它由本地规则生成、没有联网，请在 Diff 里确认内容后再决定是否应用。${scopeNote}。`
        : `【${this.label}】针对「${intent}」准备了 ${changes.length} 条修改建议，请在 Diff 里逐条审核后再决定是否应用。${scopeNote}。`
      : `【${this.label}】关于「${intent}」的说明：这是本地确定性回答，没有联网，也不会改动课程内容。${scopeNote}。`;

    return {
      answer,
      changes,
      model: this.model,
      usage: null,
      finish_reason: "stop",
      raw_kind: "json",
    };
  }

  /**
   * Deterministic sample rewrite of the block the context points at.  It is
   * built only from that block's own text, carries a visible local marker and
   * never claims to be a model's output; the same context always yields the
   * same change, so tests and the desktop walkthrough are reproducible.
   *
   * @param {Record<string, any>} context
   * @returns {AiChange | null}
   */
  synthesizeChange(context) {
    const block = recordOf(context.block);
    const blockId = idOf(block.id);
    if (!blockId) return null;
    const original = sanitizeAiText(stringOf(block.text)).trim();
    const excerpt = flatExcerpt(original);
    const clarification = original
      ? `换句话说，这一段现在想表达的是「${excerpt}」；本地连接器先把原话保留在上面，方便你直接改成更合适的说法。`
      : "换句话说，这一区块还没有正文；本地连接器先放一句提示，方便你直接开始写。";
    return {
      op: "replace_block",
      block_id: blockId,
      content: `${LOCAL_REWRITE_MARKER}${
        original || "（这一区块目前是空的）"
      }\n\n${clarification}`,
      reason: LOCAL_REWRITE_REASON,
    };
  }
}

/**
 * HTTP connector.  It never touches the network itself: it builds the request
 * and hands it to the injected transport, which lives in the process that owns
 * the credential (Rust command or Deno service).  Every transport outcome is
 * normalised into an `AiFailure`.
 */
export class HttpAiConnector {
  /**
   * @param {{ preset: string | AiProviderPreset, model?: string, base_url?: string, transport?: (call: any, options: { signal?: AbortSignal, timeout_ms: number }) => Promise<unknown>, timeout_ms?: number }} options
   */
  constructor(options) {
    const request = recordOf(options);
    const preset = resolvePreset(request.preset);
    if (!preset) {
      throw new AiFailure(
        "not_configured",
        `未知的 AI Provider：${String(request.preset ?? "（空）")}。请在 AI 设置里重新选择。`,
        { recoverable: false },
      );
    }
    this.preset = preset;
    this.model = stringOf(request.model) || preset.default_model;
    this.base_url = stringOf(request.base_url) || preset.base_url;
    this.transport = typeof request.transport === "function"
      ? request.transport
      : null;
    this.timeout_ms = Number.isFinite(request.timeout_ms)
      ? Number(request.timeout_ms)
      : AI_DEFAULT_TIMEOUT_MS;
  }

  /** @returns {AiConnectorDescriptor} */
  descriptor() {
    return {
      provider_id: this.preset.id,
      label: this.preset.label,
      model: this.model,
      kind: this.preset.kind,
      base_url: this.base_url,
      requires_credential: this.preset.requires_credential,
    };
  }

  /**
   * @param {{ instruction?: string, context?: AiContext | { system: string, user: string } | null, wants_changes?: boolean, timeout_ms?: number }} [request]
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<AiCompletion>}
   */
  async complete(request = {}, options = {}) {
    const signal = options.signal;
    if (signal && signal.aborted) throw cancelledFailure();
    if (this.preset.kind === "fake") {
      throw new AiFailure(
        "invalid_request",
        "本地确定性连接器不走网络，请改用 FakeAiConnector。",
        { recoverable: false },
      );
    }
    const timeoutMs = Number.isFinite(request.timeout_ms)
      ? Number(request.timeout_ms)
      : this.timeout_ms;
    const call = buildAiProviderCall({
      preset: this.preset,
      model: this.model,
      base_url: this.base_url,
      context: request.context ?? null,
      instruction: request.instruction,
      wants_changes: request.wants_changes === true,
    });
    if (!this.transport) {
      throw new AiFailure(
        "transport_unavailable",
        "当前界面还没有可用的 AI 传输通道（桌面壳需要原生命令，浏览器壳需要本地服务）。请在 AI 设置里确认后重试。",
      );
    }

    let result;
    try {
      result = await this.transport(call, { signal, timeout_ms: timeoutMs });
    } catch (error) {
      throw mapTransportError(error, signal);
    }
    if (signal && signal.aborted) throw cancelledFailure();

    const failure = failureFromTransportResult(result);
    if (failure) throw failure;
    const normalized = normalizeAiProviderResponse(this.preset, result);
    const parsed = parseAiAnswer(normalized.text);
    return {
      answer: parsed.answer,
      changes: parsed.changes,
      model: normalized.model || this.model,
      usage: normalized.usage,
      finish_reason: normalized.finish_reason,
      raw_kind: normalized.raw_kind,
    };
  }
}

/**
 * HTTP status → failure code.  401/403/429 are actionable; everything else
 * non-2xx is a provider error.
 *
 * @param {number} status
 * @param {unknown} [detail]
 * @returns {AiFailure}
 */
function failureForStatus(status, detail) {
  const extra = sanitizeAiText(stringOf(detail)).slice(0, 300);
  if (status === 401) {
    return new AiFailure(
      "missing_credential",
      "Provider 拒绝了这次请求（HTTP 401）：API Key 缺失或已失效。请在 AI 设置里重新填写这个 Provider 的密钥，然后重试。",
      { status, details: extra || null },
    );
  }
  if (status === 403) {
    return new AiFailure(
      "permission_denied",
      "Provider 拒绝了这次请求（HTTP 403）：当前密钥没有调用这个模型的权限，或这个能力没有被授权。请检查 Provider 的授权设置。",
      { status, details: extra || null },
    );
  }
  if (status === 429) {
    return new AiFailure(
      "rate_limited",
      "Provider 提示请求过于频繁（HTTP 429）：已触发限流。稍等一会儿再试，或换一个模型。",
      { status, details: extra || null },
    );
  }
  return new AiFailure(
    "provider_error",
    `Provider 返回了 HTTP ${status}。可以稍后重试；如果一直失败，请检查 AI 设置里的模型名与 Base URL 是否正确。`,
    { status, details: extra || null },
  );
}

/**
 * @param {unknown} result
 * @returns {AiFailure | null}
 */
function failureFromTransportResult(result) {
  if (!result || typeof result !== "object") {
    return new AiFailure(
      "transport_unavailable",
      "AI 传输通道没有返回可识别的结果。请稍后重试。",
    );
  }
  const record = recordOf(result);
  const status = Number.isFinite(record.status) ? Number(record.status) : null;
  if (status !== null && (status < 200 || status >= 300)) {
    return failureForStatus(status, record.detail ?? record.message);
  }
  if (record.ok === false) {
    const code = AI_FAILURE_CODES.includes(stringOf(record.code))
      ? stringOf(record.code)
      : "provider_error";
    return new AiFailure(
      code,
      stringOf(record.message) || "AI 请求失败，课程内容没有改动，可以稍后重试。",
      { status, details: sanitizeAiText(stringOf(record.detail)).slice(0, 300) || null },
    );
  }
  return null;
}

/**
 * Keep a transport's structured details useful but bounded: strings are
 * redacted and clipped, objects are deep-copied without credential-shaped keys
 * and clipped when they would blow up an execution record.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function safeFailureDetails(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    return sanitizeAiText(value).slice(0, 500) || null;
  }
  if (typeof value !== "object") return value;
  try {
    const clean = scrubCredentialKeys(JSON.parse(JSON.stringify(value)));
    const text = JSON.stringify(clean);
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : clean;
  } catch {
    return null;
  }
}

/**
 * "Open a writable project first" guidance, keeping the shell's original
 * sentence in front of it so the real reason is never lost.
 *
 * @param {string} raw
 * @returns {string}
 */
function projectFirstMessage(raw) {
  const guidance = "请先打开（或新建）一个可写的课程项目，然后重试。";
  if (!raw) return `AI 功能需要先打开一个课程项目。${guidance}`;
  return `${raw.replace(/[。.\s]+$/, "")}。${guidance}`;
}

/**
 * Normalise anything a transport threw into an `AiFailure`.
 *
 * In both shells the real failure arrives as an `Error` built by
 * `app/main.js#bridgeError` carrying `.code` / `.details` (and, when the shell
 * provides it, `.recommended_action`).  That structured code is the only
 * reliable signal — the message is prose — so it wins over text sniffing.
 * Text heuristics remain for plain throws that carry no code at all.
 *
 * @param {unknown} error
 * @param {AbortSignal | undefined} signal
 * @returns {AiFailure}
 */
function mapTransportError(error, signal) {
  if (error instanceof AiFailure) return error;
  const record = recordOf(error);
  const name = stringOf(record.name);
  const details = safeFailureDetails(record.details);
  const message = (stringOf(record.message) || String(error ?? "")).trim();
  const recommended = stringOf(record.recommended_action).trim();
  const rawDetails = details ??
    (message ? sanitizeAiText(message).slice(0, 300) : null);

  // The caller's own abort is authoritative: whatever the transport reported,
  // the user asked for this to stop.
  if (signal && signal.aborted) return cancelledFailure();

  // A structured code from the shell always wins over text sniffing.
  const structured = stringOf(record.code);
  if (structured) {
    if (AI_PROJECT_FIRST_CODES.includes(structured)) {
      return new AiFailure("not_configured", projectFirstMessage(message), {
        details: rawDetails,
        recommended_action: recommended || undefined,
      });
    }
    const mapped = AI_FAILURE_CODES.includes(structured)
      ? structured
      : AI_CONNECTION_CODE_MAP[structured] || "";
    if (mapped) {
      const fallback = AI_FAILURE_DEFAULTS[mapped];
      return new AiFailure(mapped, message || (fallback ? fallback.message : ""), {
        details: rawDetails,
        recommended_action: recommended || undefined,
      });
    }
    // A code we know nothing about, but the throw still carries a structural
    // abort/timeout signal: trust that signal.
    if (name === "AbortError") return cancelledFailure();
    if (name === "TimeoutError") {
      return new AiFailure(
        "timeout",
        message || (AI_FAILURE_DEFAULTS.timeout || {}).message || "",
        { details: rawDetails, recommended_action: recommended || undefined },
      );
    }
    // Otherwise keep it out of the provider semantics, but never swallow the
    // reason the shell gave.
    return new AiFailure(
      "transport_unavailable",
      message ||
        (AI_FAILURE_DEFAULTS.transport_unavailable
          ? AI_FAILURE_DEFAULTS.transport_unavailable.message
          : ""),
      { details: rawDetails, recommended_action: recommended || undefined },
    );
  }

  // No structured code: keep the previous heuristics for plain throws.
  if (name === "AbortError") return cancelledFailure();
  if (name === "TimeoutError" || /timeout|timed out|超时/i.test(message)) {
    return new AiFailure(
      "timeout",
      (AI_FAILURE_DEFAULTS.timeout || AI_FAILURE_DEFAULTS.provider_error || {})
        .message || "",
      { details: rawDetails },
    );
  }
  if (/abort|cancel|取消/i.test(message)) return cancelledFailure();
  return new AiFailure(
    "transport_unavailable",
    (AI_FAILURE_DEFAULTS.transport_unavailable || {}).message || "",
    { details: rawDetails },
  );
}

/* ------------------------------------------------------------------ *
 * Suggestion / ChangeDraft / Diff / Apply / Reject
 * ------------------------------------------------------------------ */

/**
 * @param {ProjectData} data
 * @param {string} draftId
 * @returns {ChangeDraft}
 */
function findDraftOrThrow(data, draftId) {
  const draft = (Array.isArray(data.change_drafts) ? data.change_drafts : [])
    .find((candidate) => candidate.id === draftId);
  if (!draft) {
    throw new AiFailure(
      "invalid_request",
      `找不到修改草稿 ${draftId}，它可能已经被删除。请重新生成 AI 建议。`,
      { recoverable: false },
    );
  }
  return draft;
}

/**
 * @param {AiChange[]} changes
 * @returns {import("../src/domain/types.ts").SuggestionType}
 */
function suggestionTypeFor(changes) {
  const ops = new Set(changes.map((change) => change.op));
  if (ops.has("replace_block")) return "rewrite";
  if (ops.has("insert_block")) return "add_content";
  if (ops.has("move_block")) return "restructure";
  if (ops.has("create_requirement")) {
    const media = changes
      .filter((change) => change.op === "create_requirement")
      .map((change) => change.requirement_type || "text");
    return media.some((type) =>
      ["image", "gif", "video", "audio"].includes(type)
    )
      ? "add_media"
      : "add_content";
  }
  return "other";
}

/**
 * @param {string} answer
 * @param {AiChange[]} changes
 * @returns {string}
 */
function suggestionTitleFor(answer, changes) {
  const firstLine = answer.split(/\r?\n/).map((line) => line.trim()).find(
    (line) => line.length > 0,
  ) || "";
  const cleaned = firstLine.replace(/^#+\s*/, "").replace(/[*`_>]/g, "").trim();
  const base = cleaned ||
    (changes.length ? "AI 建议的课程修改" : "AI 对当前内容的说明");
  return base.length > 60 ? `${base.slice(0, 59)}…` : base;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeSourceType(value) {
  const type = stringOf(value);
  return AI_CONTEXT_SOURCE_TYPES.includes(type) ? type : "custom";
}

/**
 * Persist a ContextPack for the assembled context, or reuse the caller's.
 * The pack is canonical bookkeeping: it records *what was sent*, never the
 * secret that authenticated the call.
 *
 * @param {ProjectData} data
 * @param {unknown} contextPackId
 * @param {AiContext | null} context
 * @param {string} targetId
 * @param {unknown} purpose
 * @returns {ContextPack}
 */
function resolveContextPack(data, contextPackId, context, targetId, purpose) {
  const existingId = idOf(contextPackId);
  const packs = Array.isArray(data.context_packs) ? data.context_packs : [];
  if (existingId) {
    const pack = packs.find((candidate) => candidate.id === existingId);
    if (!pack) {
      throw new AiFailure(
        "invalid_request",
        `找不到上下文包 ${existingId}，请重新预览上下文再试。`,
        { recoverable: false },
      );
    }
    if (pack.project_id !== data.project.id) {
      throw new AiFailure(
        "invalid_request",
        "这个上下文包不属于当前项目，请重新预览上下文。",
        { recoverable: false },
      );
    }
    const packItems = Array.isArray(data.context_pack_items)
      ? data.context_pack_items.filter((item) => item.context_pack_id === pack.id)
      : [];
    if (packItems.length === 0) {
      throw new AiFailure(
        "invalid_request",
        "这个上下文包是空的，请重新预览上下文再试。",
        { recoverable: false },
      );
    }
    return pack;
  }

  const items = context && Array.isArray(context.items) ? context.items : [];
  if (items.length === 0) {
    throw new AiFailure(
      "invalid_request",
      "缺少上下文内容，无法建立 AI 上下文包。请先预览上下文再试。",
      { recoverable: false },
    );
  }
  const stamp = nowIso();
  /** @type {ContextPack} */
  const pack = {
    id: uuid(),
    project_id: data.project.id,
    target_content_item_id: targetId,
    purpose: stringOf(purpose) || "ai_workflow",
    created_at: stamp,
    model_connection_id: null,
  };
  data.context_packs.push(pack);
  items.forEach((item, index) => {
    /** @type {ContextPackItem} */
    const row = {
      id: uuid(),
      context_pack_id: pack.id,
      source_type: /** @type {any} */ (normalizeSourceType(item.source_type)),
      source_id: String(item.source_id),
      label: stringOf(item.label),
      content_hash: stableHash(stringOf(item.content)),
      order_index: index,
    };
    data.context_pack_items.push(row);
  });
  return pack;
}

/**
 * Create the canonical Suggestion for one AI answer.  Non-modifying requests
 * (an explanation, a summary) stop here: only a Suggestion row is written.
 *
 * @param {ProjectData} data
 * @param {{ contextPackId?: string | null, context_pack_id?: string | null, targetContentItemId?: string | null, target_content_item_id?: string | null, answer: string, changes?: unknown[], modelMetadata?: Record<string, unknown>, context?: AiContext | null, purpose?: string }} input
 * @returns {Suggestion}
 */
export function createAiSuggestion(data, input) {
  const request = recordOf(input);
  const answer = stringOf(request.answer).trim();
  if (!answer) {
    throw new AiFailure(
      "invalid_request",
      "AI 没有返回可保存的说明内容，无法生成建议。请重新发起一次请求。",
      { recoverable: false },
    );
  }
  const context = request.context && typeof request.context === "object"
    ? /** @type {AiContext} */ (recordOf(request.context))
    : null;
  const rawChanges = Array.isArray(request.changes)
    ? request.changes
    : Array.isArray(recordOf(request.modelMetadata).changes)
    ? /** @type {unknown[]} */ (recordOf(request.modelMetadata).changes)
    : [];
  const changes = rawChanges.map((change, index) =>
    normalizeAiChange(change, index)
  );

  const explicitTarget = idOf(request.targetContentItemId) ||
    idOf(request.target_content_item_id);
  const contextTarget = context && context.scope
    ? idOf(recordOf(context.scope).content_item_id)
    : null;
  const targetId = explicitTarget || contextTarget;
  if (!targetId) {
    throw new AiFailure(
      "invalid_request",
      "这条 AI 结果没有绑定具体课次，无法保存成建议。请先预览上下文再重试。",
      { recoverable: false },
    );
  }
  const target = contentItemsOf(data).find((item) =>
    item.id === targetId && item.project_id === data.project.id
  );
  if (!target) {
    throw new AiFailure(
      "invalid_request",
      `这条 AI 结果指向的课次（${targetId}）已经不存在了，请重新预览上下文。`,
      { recoverable: false },
    );
  }

  const pack = resolveContextPack(
    data,
    request.contextPackId ?? request.context_pack_id,
    context,
    target.id,
    request.purpose,
  );
  const packItems = Array.isArray(data.context_pack_items)
    ? data.context_pack_items.filter((item) => item.context_pack_id === pack.id)
    : [];

  const metadata = recordOf(request.modelMetadata);
  const stamp = nowIso();
  // Scalar metadata only: this row is canonical and is re-scanned by the
  // native project loader, so nothing secret-shaped (and no full provider
  // object) is copied into it.
  /** @type {Record<string, any>} */
  const modelMetadata = {
    adapter: "app/ai.js",
    provider_id: stringOf(metadata.provider_id),
    model: stringOf(metadata.model),
    provider_label: stringOf(metadata.provider_label),
    wants_changes: changes.length > 0,
    operation_count: changes.length,
    scope: context && context.scope
      ? {
        kind: stringOf(recordOf(context.scope).kind),
        content_item_id: stringOf(recordOf(context.scope).content_item_id),
        block_id: idOf(recordOf(context.scope).block_id),
      }
      : null,
    item_count: packItems.length,
    payload_chars: context ? Number(context.payload_chars) || 0 : 0,
    changes: /** @type {JsonValue} */ (/** @type {unknown} */ (changes)),
  };

  /** @type {Suggestion} */
  const suggestion = {
    id: uuid(),
    target_content_item_id: target.id,
    context_pack_id: pack.id,
    type: suggestionTypeFor(changes),
    title: suggestionTitleFor(answer, changes),
    description: answer.length > 2000 ? `${answer.slice(0, 1999)}…` : answer,
    evidence_refs: /** @type {JsonValue[]} */ (packItems
      .slice(0, AI_CONTEXT_LIMITS.evidence_refs)
      .map((item) => ({
        source_type: item.source_type,
        source_id: item.source_id,
        label: item.label,
      }))),
    status: "pending",
    model_metadata: /** @type {JsonObject} */ (
      /** @type {unknown} */ (modelMetadata)
    ),
    created_at: stamp,
    reviewed_at: null,
  };
  data.suggestions.push(suggestion);
  data.project.updated_at = stamp;
  return suggestion;
}

/**
 * Turn a Suggestion plus the model's `changes` into a reviewable ChangeDraft.
 * Body content is not touched here: every operation snapshots `before` so the
 * Diff and the Apply guard can detect a changed course.
 *
 * @param {ProjectData} data
 * @param {string} suggestionId
 * @param {unknown[]} changes
 * @param {{ reason?: string, scope?: unknown, provider?: unknown }} [options]
 * @returns {ChangeDraft}
 */
export function createAiChangeDraft(data, suggestionId, changes, options = {}) {
  const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
  const suggestion = suggestions.find((candidate) =>
    candidate.id === suggestionId
  );
  if (!suggestion) {
    throw new AiFailure(
      "invalid_request",
      `找不到建议 ${suggestionId}。请重新生成 AI 结果。`,
      { recoverable: false },
    );
  }
  if (suggestion.status !== "pending" && suggestion.status !== "accepted") {
    throw new AiFailure(
      "invalid_request",
      `这条建议当前状态是「${
        SUGGESTION_STATUS_LABELS[suggestion.status] || suggestion.status
      }」，不能再生成修改草稿。`,
      { recoverable: false },
    );
  }
  const normalized = (Array.isArray(changes) ? changes : []).map((change, index) =>
    normalizeAiChange(change, index)
  );
  if (normalized.length === 0) {
    throw new AiFailure(
      "invalid_request",
      "模型没有给出可审核的具体修改，只能把这次结果保留为建议。",
      { recoverable: false },
    );
  }
  const target = contentItemsOf(data).find((item) =>
    item.id === suggestion.target_content_item_id
  );
  if (!target) {
    throw new AiFailure(
      "invalid_request",
      "这条建议指向的课次已经不存在了，无法生成修改草稿。",
      { recoverable: false },
    );
  }
  const ordered = blocksFor(data, target.id);
  const known = new Map(ordered.map((block) => [block.id, block]));
  const blockById = new Map(blocksOf(data).map((block) => [block.id, block]));

  // Every referenced block must belong to the resolved target lesson.  A change
  // that points somewhere else means the model answered about a different
  // lesson, so the user is told to narrow the scope instead of silently
  // dropping it.
  for (const change of normalized) {
    const references = [
      change.block_id,
      change.after_block_id,
      change.anchor_block_id,
    ];
    for (const reference of references) {
      if (!reference) continue;
      if (known.has(reference)) continue;
      const exists = blockById.has(reference);
      throw new AiFailure(
        "invalid_request",
        `建议里的正文区块 ${reference} ${
          exists ? "属于其他课次" : "已经不存在"
        }，而本次目标课次是「${target.code} ${target.title}」。请把范围切换到这一课或具体区块后重试。`,
        { recoverable: false },
      );
    }
  }

  const stamp = nowIso();
  const operations = normalized.map((change) =>
    buildChangeOperation(data, target, ordered, known, change)
  );
  const draftScope = recordOf(options.scope);
  const draftProvider = recordOf(options.provider);
  const reason = stringOf(options.reason).trim() || suggestion.title || "";

  /** @type {ChangeDraft} */
  const draft = {
    id: uuid(),
    suggestion_id: suggestion.id,
    target_content_item_id: target.id,
    base_revision: documentRevisionOf(data, target.id),
    proposed_changes: proposedChangesFor(operations),
    diff: /** @type {JsonValue} */ (
      /** @type {unknown} */ (diffSnapshotFor(operations))
    ),
    status: "reviewing",
    created_at: stamp,
    applied_at: null,
    operations,
    reason,
    validation: { checked_at: stamp, ok: true, issues: [] },
    scope: /** @type {JsonObject} */ ({
      kind: stringOf(draftScope.kind) || "lesson",
      content_item_id: idOf(draftScope.content_item_id) || target.id,
      block_id: idOf(draftScope.block_id),
    }),
    provider: /** @type {JsonObject} */ ({
      provider_id: stringOf(draftProvider.provider_id),
      model: stringOf(draftProvider.model),
    }),
  };
  data.change_drafts.push(draft);
  if (suggestion.status === "pending") {
    suggestion.status = "accepted";
    suggestion.reviewed_at = stamp;
  }
  data.project.updated_at = stamp;
  return draft;
}

/**
 * @param {ProjectData} data
 * @param {ContentItem} target
 * @param {Block[]} ordered
 * @param {Map<string, Block>} known
 * @param {AiChange} change
 * @returns {ChangeOperation}
 */
function buildChangeOperation(data, target, ordered, known, change) {
  if (change.op === "replace_block") {
    const block = known.get(String(change.block_id));
    return {
      id: uuid(),
      op: "replace_block",
      target: { block_id: String(change.block_id) },
      before: cloneJson(block ? block.content : null),
      after: cloneJson(change.content),
      reason: change.reason,
    };
  }
  if (change.op === "insert_block") {
    const afterId = change.after_block_id ?? null;
    const index = afterId
      ? ordered.findIndex((block) => block.id === afterId) + 1
      : ordered.length;
    /** @type {Record<string, any>} */
    const after = {
      type: change.type,
      content: cloneJson(change.content),
      order_index: Math.max(0, index),
    };
    if (change.requirement_type) {
      after.requirement_type = change.requirement_type;
    }
    return {
      id: uuid(),
      op: "insert_block",
      target: {
        after_block_id: afterId,
        content_item_id: target.id,
      },
      before: null,
      after: /** @type {JsonValue} */ (/** @type {unknown} */ (after)),
      reason: change.reason,
    };
  }
  if (change.op === "create_requirement") {
    const anchor = change.anchor_block_id ?? null;
    return {
      id: uuid(),
      op: "create_requirement",
      target: { content_item_id: target.id, anchor_block_id: anchor },
      before: null,
      after: {
        type: change.requirement_type || "text",
        note: change.note || "",
        priority: change.priority || "normal",
        anchor_block_id: anchor,
        content_item_id: target.id,
      },
      reason: change.reason,
    };
  }
  const window = moveWindow(
    ordered.map((block) => block.id),
    String(change.block_id),
    change.after_block_id ?? null,
  );
  return {
    id: uuid(),
    op: "move_block",
    target: {
      block_id: String(change.block_id),
      after_block_id: change.after_block_id ?? null,
    },
    before: { block_ids: window.before },
    after: { block_ids: window.after },
    reason: change.reason,
  };
}

/**
 * The smallest affected window for "move `blockId` after `afterBlockId`",
 * expressed as the current order and the target order of that window.  Matches
 * the drag & drop semantics of `app/main.js#reorderBlockTo`.
 *
 * @param {string[]} ids
 * @param {string} blockId
 * @param {string | null} afterBlockId
 * @returns {{ before: string[], after: string[] }}
 */
function moveWindow(ids, blockId, afterBlockId) {
  const from = ids.indexOf(blockId);
  if (from < 0) return { before: [], after: [] };
  // "move X after X" is a no-op, not "move X to the front".
  if (afterBlockId === blockId) {
    return { before: [blockId], after: [blockId] };
  }
  const target = ids.slice();
  target.splice(from, 1);
  const anchor = afterBlockId === null ? -1 : target.indexOf(afterBlockId);
  const to = anchor + 1;
  target.splice(to, 0, blockId);
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  return {
    before: ids.slice(start, end + 1),
    after: target.slice(start, end + 1),
  };
}

/**
 * @param {ChangeOperation[]} operations
 * @returns {import("../src/domain/types.ts").ChangePatch[]}
 */
function proposedChangesFor(operations) {
  return operations
    .filter((operation) => operation.op === "replace_block")
    .map((operation) => ({
      block_id: String(operation.target.block_id || ""),
      before: operation.before,
      after: operation.after,
    }));
}

/**
 * @param {ChangeOperation[]} operations
 * @returns {Array<Record<string, any>>}
 */
function diffSnapshotFor(operations) {
  return operations.map((operation) => ({
    op: operation.op,
    block_id: operation.target.block_id ?? null,
    before: operation.before,
    after: operation.after,
    reason: operation.reason,
  }));
}

/**
 * Pure validation: can this draft be applied right now?  Never mutates `data`,
 * so a failing check cannot half-write anything.
 *
 * @param {ProjectData} data
 * @param {string} draftId
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function validateAiChangeDraft(data, draftId) {
  const draft = findDraftOrThrow(data, draftId);
  const issues = draftIssues(data, draft, null);
  return { ok: issues.length === 0, issues };
}

/**
 * @param {ProjectData} data
 * @param {ChangeDraft} draft
 * @param {string[] | null} selectedIds
 * @returns {string[]}
 */
function draftIssues(data, draft, selectedIds) {
  /** @type {string[]} */
  const issues = [];
  const target = contentItemsOf(data).find((item) =>
    item.id === draft.target_content_item_id
  );
  if (!target) {
    issues.push("这份草稿指向的课次已经不存在了。");
    return issues;
  }
  if (draft.status !== "reviewing") {
    issues.push(
      `这份草稿当前状态是「${
        DRAFT_STATUS_LABELS[draft.status] || draft.status
      }」，不能应用。`,
    );
  }
  const operations = Array.isArray(draft.operations) ? draft.operations : [];
  if (operations.length === 0) {
    issues.push("这份草稿没有结构化的修改操作，无法应用。");
    return issues;
  }
  if (documentRevisionOf(data, target.id) !== draft.base_revision) {
    issues.push("这一课的正文在生成 Diff 之后已经变化了，请重新生成 Diff。");
  }
  const ordered = blocksFor(data, target.id);
  const known = new Map(ordered.map((block) => [block.id, block]));
  const selected = selectedIds
    ? operations.filter((operation) => selectedIds.includes(operation.id))
    : operations;
  if (selected.length === 0) {
    issues.push("至少需要选择一项修改。");
    return issues;
  }
  const seen = new Set();
  for (const operation of selected) {
    if (operation.op === "replace_block" || operation.op === "move_block") {
      const blockId = idOf(operation.target.block_id);
      if (!blockId) continue;
      const key = `${operation.op}:${blockId}`;
      if (seen.has(key)) {
        issues.push(`同一个正文区块在这一次修改里出现了两次：${blockId}。`);
      }
      seen.add(key);
    }
  }
  for (const operation of selected) {
    issues.push(...operationIssues(ordered, known, operation));
  }
  return [...new Set(issues)];
}

/**
 * @param {Block[]} ordered
 * @param {Map<string, Block>} known
 * @param {ChangeOperation} operation
 * @returns {string[]}
 */
function operationIssues(ordered, known, operation) {
  /** @type {string[]} */
  const issues = [];
  const after = recordOf(operation.after);
  const before = recordOf(operation.before);

  if (operation.op === "replace_block") {
    const blockId = idOf(operation.target.block_id);
    const block = blockId ? known.get(blockId) : null;
    if (!block) {
      issues.push(`找不到要替换的正文区块 ${blockId || "（空）"}，它可能已经被删除。`);
      return issues;
    }
    if (stableJson(block.content) !== stableJson(operation.before)) {
      issues.push(
        `正文区块 ${block.id} 的内容与生成 Diff 时不一致，请重新生成 Diff。`,
      );
    }
    return issues;
  }

  if (operation.op === "insert_block") {
    const afterBlockId = idOf(operation.target.after_block_id);
    if (afterBlockId && !known.has(afterBlockId)) {
      issues.push(`找不到要插入位置的正文区块 ${afterBlockId}，它可能已经被删除。`);
    }
    const type = stringOf(after.type);
    if (!AI_BLOCK_TYPES.includes(type)) {
      issues.push(`新增区块的类型「${type || "（空）"}」不存在。`);
    }
    if (after.content === undefined) {
      issues.push("新增区块缺少正文内容。");
    }
    return issues;
  }

  if (operation.op === "create_requirement") {
    const type = stringOf(after.type);
    if (!AI_REQUIREMENT_TYPES.includes(type)) {
      issues.push(`新增待补的类型「${type || "（空）"}」不存在。`);
    }
    const priority = stringOf(after.priority) || "normal";
    if (!AI_PRIORITIES.includes(priority)) {
      issues.push(`新增待补的优先级「${priority}」不存在。`);
    }
    const anchor = idOf(after.anchor_block_id);
    if (anchor && !known.has(anchor)) {
      issues.push(`新增待补的锚点区块 ${anchor} 已经不存在了。`);
    }
    return issues;
  }

  if (operation.op === "move_block") {
    const blockId = idOf(operation.target.block_id);
    if (!blockId || !known.has(blockId)) {
      issues.push(`找不到要移动的正文区块 ${blockId || "（空）"}。`);
      return issues;
    }
    const currentIds = ordered.map((block) => block.id);
    const windowBefore = idListOf(before.block_ids);
    const windowAfter = idListOf(after.block_ids);
    if (windowBefore.length === 0 || windowAfter.length === 0) {
      issues.push("调整顺序的建议缺少受影响的区块列表。");
      return issues;
    }
    const start = currentIds.indexOf(windowBefore[0] || "");
    const slice = start < 0
      ? []
      : currentIds.slice(start, start + windowBefore.length);
    if (start < 0 || slice.join("|") !== windowBefore.join("|")) {
      issues.push(
        `这一课的区块顺序已经变化，${blockId} 的移动建议不再适用，请重新生成 Diff。`,
      );
    }
    if (
      windowAfter.length !== windowBefore.length ||
      windowAfter.slice().sort().join("|") !==
        windowBefore.slice().sort().join("|")
    ) {
      issues.push("调整顺序的目标顺序与受影响区块不一致。");
    }
    if (!windowAfter.includes(blockId)) {
      issues.push("调整顺序的建议里没有包含被移动的区块。");
    }
    return issues;
  }

  issues.push(`不支持的修改操作：${operation.op}。`);
  return issues;
}

/**
 * Apply a reviewed draft.  Every selected operation is validated before a
 * single canonical row is touched, so a failure leaves `data` byte-identical
 * (the caller still commits a deep copy, which is what makes this atomic
 * against a partially written store).
 *
 * @param {ProjectData} data
 * @param {string} draftId
 * @param {{ confirmed?: boolean, operation_ids?: string[] }} [input]
 * @returns {ChangeDraft}
 */
export function applyAiChangeDraft(data, draftId, input = {}) {
  const draft = findDraftOrThrow(data, draftId);
  if (input.confirmed !== true) {
    throw new AiFailure(
      "invalid_request",
      "应用 AI 修改前需要明确确认（confirmed: true）。",
      { recoverable: false },
    );
  }
  if (draft.status !== "reviewing") {
    throw new AiFailure(
      "invalid_request",
      `这份修改草稿当前状态是「${
        DRAFT_STATUS_LABELS[draft.status] || draft.status
      }」，不能应用。请重新生成后再审核。`,
      { recoverable: false },
    );
  }
  const operations = Array.isArray(draft.operations) ? draft.operations : [];
  if (operations.length === 0) {
    throw new AiFailure(
      "invalid_request",
      "这份草稿没有结构化的修改操作，无法应用。",
      { recoverable: false },
    );
  }
  const requestedIds = Array.isArray(input.operation_ids) &&
      input.operation_ids.length > 0
    ? input.operation_ids
    : operations.map((operation) => operation.id);
  const selected = requestedIds.map((operationId) => {
    const operation = operations.find((candidate) =>
      candidate.id === operationId
    );
    if (!operation) {
      throw new AiFailure(
        "invalid_request",
        `找不到要应用的修改操作 ${operationId}，请重新打开 Diff。`,
        { recoverable: false },
      );
    }
    return operation;
  });

  // 1. Validate everything before touching anything.
  const issues = draftIssues(data, draft, selected.map((operation) => operation.id));
  if (issues.length > 0) {
    throw new AiFailure(
      "invalid_request",
      `这份修改现在不能应用：${issues[0]}${
        issues.length > 1 ? `（另有 ${issues.length - 1} 项问题）` : ""
      }`,
      { details: { issues }, recoverable: false },
    );
  }

  const target = contentItemsOf(data).find((item) =>
    item.id === draft.target_content_item_id
  );
  if (!target) {
    throw new AiFailure(
      "invalid_request",
      "这份草稿指向的课次已经不存在了，无法应用。",
      { recoverable: false },
    );
  }
  const document = documentsOf(data).find((candidate) =>
    candidate.id === target.document_id
  ) || documentsOf(data).find((candidate) =>
    candidate.content_item_id === target.id
  );
  if (!document) {
    throw new AiFailure(
      "invalid_request",
      `课次「${target.code} ${target.title}」缺少正文文档，无法应用修改。`,
      { recoverable: false },
    );
  }

  // 2. Apply in a fixed category order so the result is deterministic.
  const stamp = nowIso();

  for (const operation of selected.filter((op) => op.op === "replace_block")) {
    const block = blocksOf(data).find((candidate) =>
      candidate.id === idOf(operation.target.block_id)
    );
    if (!block) continue;
    block.content = cloneJson(operation.after);
    block.updated_at = stamp;
  }

  for (
    const operation of selected.filter((op) => op.op === "create_requirement")
  ) {
    const after = recordOf(operation.after);
    /** @type {Requirement} */
    const requirement = {
      id: uuid(),
      content_item_id: target.id,
      anchor_block_id: idOf(after.anchor_block_id),
      type: /** @type {any} */ (stringOf(after.type) || "text"),
      scope: "content",
      layout_instance_id: null,
      note: stringOf(after.note),
      status: "open",
      priority: /** @type {any} */ (stringOf(after.priority) || "normal"),
      resolved_asset_id: null,
      resolved_block_id: null,
      created_at: stamp,
      resolved_at: null,
    };
    data.requirements.push(requirement);
  }

  for (const operation of selected.filter((op) => op.op === "insert_block")) {
    const after = recordOf(operation.after);
    const ordered = blocksFor(data, target.id);
    const afterBlockId = idOf(operation.target.after_block_id);
    const rawIndex = afterBlockId
      ? ordered.findIndex((block) => block.id === afterBlockId) + 1
      : ordered.length;
    const index = Math.max(0, Math.min(rawIndex, ordered.length));
    const type = stringOf(after.type) || "paragraph";
    const content = cloneJson(after.content);

    if (type === "placeholder") {
      // A placeholder block is always paired with the Requirement it tracks,
      // exactly like `app/main.js#addPlaceholder`.
      const placeholderId = uuid();
      const requirementId = uuid();
      const note = typeof content === "string" && content.trim()
        ? content
        : textOf(content) || "补充这段文字";
      const requirementType = stringOf(after.requirement_type) || "text";
      /** @type {Block} */
      const placeholder = {
        id: placeholderId,
        document_id: document.id,
        parent_block_id: null,
        type: "placeholder",
        order_index: index,
        content: typeof content === "string" && content.trim()
          ? content
          : "补充这段文字",
        settings: {
          requirement_type: requirementType,
          scope: "content",
          requirement_id: requirementId,
        },
        created_at: stamp,
        updated_at: stamp,
      };
      data.blocks.push(placeholder);
      /** @type {Requirement} */
      const requirement = {
        id: requirementId,
        content_item_id: target.id,
        anchor_block_id: placeholderId,
        type: /** @type {any} */ (requirementType),
        scope: "content",
        layout_instance_id: null,
        note,
        status: "open",
        priority: "normal",
        resolved_asset_id: null,
        resolved_block_id: null,
        created_at: stamp,
        resolved_at: null,
      };
      data.requirements.push(requirement);
      placeBlockAt(data, ordered, index, placeholder);
      continue;
    }

    /** @type {Block} */
    const block = {
      id: uuid(),
      document_id: document.id,
      parent_block_id: null,
      type: /** @type {any} */ (type),
      order_index: index,
      content,
      settings: type === "heading" ? { level: 2 } : {},
      created_at: stamp,
      updated_at: stamp,
    };
    data.blocks.push(block);
    placeBlockAt(data, ordered, index, block);
  }

  for (const operation of selected.filter((op) => op.op === "move_block")) {
    const orderedNow = blocksFor(data, target.id);
    const windowIds = idListOf(recordOf(operation.before).block_ids);
    const targetIds = idListOf(recordOf(operation.after).block_ids);
    const windowSet = new Set(windowIds);
    const firstIndex = orderedNow.findIndex((block) => windowSet.has(block.id));
    if (firstIndex < 0) continue;
    const byId = new Map(orderedNow.map((block) => [block.id, block]));
    const head = orderedNow.slice(0, firstIndex).filter((block) =>
      !windowSet.has(block.id)
    );
    const tail = orderedNow.slice(firstIndex).filter((block) =>
      !windowSet.has(block.id)
    );
    const windowBlocks = targetIds
      .map((blockId) => byId.get(blockId))
      .filter((candidate) => candidate !== undefined);
    const next = [...head, ...windowBlocks, ...tail];
    next.forEach((block, position) => {
      block.order_index = position;
      block.updated_at = stamp;
    });
  }

  // 3. Book-keeping.
  draft.status = "applied";
  draft.applied_at = stamp;
  if (selected.length !== operations.length) {
    draft.operations = /** @type {ChangeOperation[]} */ (
      structuredClone(selected)
    );
    draft.proposed_changes = proposedChangesFor(draft.operations);
    draft.diff = /** @type {JsonValue} */ (
      /** @type {unknown} */ (diffSnapshotFor(draft.operations))
    );
    draft.base_revision = documentRevisionOf(data, target.id);
  }
  draft.validation = { checked_at: stamp, ok: true, issues: [] };
  data.project.updated_at = stamp;
  return draft;
}

/**
 * Insert a freshly created block at an explicit position and keep the
 * document's `order_index` contiguous.
 *
 * @param {ProjectData} data
 * @param {Block[]} orderedBefore
 * @param {number} index
 * @param {Block} block
 */
function placeBlockAt(data, orderedBefore, index, block) {
  const next = orderedBefore.slice();
  next.splice(Math.max(0, Math.min(index, next.length)), 0, block);
  next.forEach((candidate, position) => {
    candidate.order_index = position;
  });
  renumberBlocks(data, block.document_id);
}

/**
 * Reject a draft.  Only the draft row changes: no block, requirement or asset
 * row is touched, so a rejection can never alter the course.
 *
 * @param {ProjectData} data
 * @param {string} draftId
 * @param {{ reason?: string }} [input]
 * @returns {ChangeDraft}
 */
export function rejectAiChangeDraft(data, draftId, input = {}) {
  const draft = findDraftOrThrow(data, draftId);
  if (draft.status === "applied") {
    throw new AiFailure(
      "invalid_request",
      "这份修改已经应用到课程里了，不能再拒绝。可以先用撤销回到应用前。",
      { recoverable: false },
    );
  }
  if (draft.status === "discarded") {
    throw new AiFailure(
      "invalid_request",
      "这份修改已经拒绝过了，课程内容没有改动。",
      { recoverable: false },
    );
  }
  const reason = stringOf(input.reason).trim();
  const stamp = nowIso();
  draft.status = "discarded";
  draft.validation = {
    checked_at: stamp,
    ok: false,
    issues: [reason ? `用户拒绝了这份修改：${reason}` : "用户拒绝了这份修改。"],
  };
  data.project.updated_at = stamp;
  return draft;
}

/**
 * Human-readable Diff rows for the review panel.  Pure read.
 *
 * @param {ProjectData} data
 * @param {string} draftId
 * @returns {AiDiffRow[]}
 */
export function aiChangeDraftDiffRows(data, draftId) {
  const draft = findDraftOrThrow(data, draftId);
  const operations = Array.isArray(draft.operations) ? draft.operations : [];
  const ordered = blocksFor(data, draft.target_content_item_id);
  /** @param {string} blockId */
  const positionOf = (blockId) => {
    const index = ordered.findIndex((block) => block.id === blockId);
    return index >= 0 ? index + 1 : 0;
  };
  /** @param {string} blockId */
  const summarize = (blockId) => {
    const block = ordered.find((candidate) => candidate.id === blockId);
    if (!block) return `${blockId}（已不存在）`;
    const text = sanitizeAiText(textOf(block.content)).replace(/\s+/g, " ").trim();
    return `${blockLabel(block.type)}：${text.slice(0, 40) || "（空）"}`;
  };

  return operations.map((operation) => {
    const after = recordOf(operation.after);
    const before = recordOf(operation.before);
    if (operation.op === "replace_block") {
      const blockId = idOf(operation.target.block_id);
      return {
        op: operation.op,
        label: `替换第 ${positionOf(blockId || "")} 段的正文`,
        before_lines: splitLines(operation.before),
        after_lines: splitLines(operation.after),
        block_id: blockId,
      };
    }
    if (operation.op === "insert_block") {
      const afterBlockId = idOf(operation.target.after_block_id);
      const type = stringOf(after.type) || "paragraph";
      const suffix = type === "placeholder" ? "（占位符，同时新增一项待补）" : "";
      return {
        op: operation.op,
        label: afterBlockId
          ? `在第 ${positionOf(afterBlockId)} 段之后新增「${blockLabel(type)}」${suffix}`
          : `在本课末尾新增「${blockLabel(type)}」${suffix}`,
        before_lines: [],
        after_lines: splitLines(after.content),
        block_id: afterBlockId,
      };
    }
    if (operation.op === "create_requirement") {
      const anchor = idOf(after.anchor_block_id);
      return {
        op: operation.op,
        label: `新增待补：${requirementTypeLabel(stringOf(after.type))}`,
        before_lines: [],
        after_lines: [
          `类型：${requirementTypeLabel(stringOf(after.type))}（${stringOf(after.type)}）`,
          `优先级：${priorityLabel(stringOf(after.priority))}`,
          `说明：${stringOf(after.note) || "（没有填写说明）"}`,
          `锚点区块：${anchor ? `第 ${positionOf(anchor)} 段` : "无"}`,
        ],
        block_id: anchor,
      };
    }
    return {
      op: operation.op,
      label: "调整本课区块顺序",
      before_lines: idListOf(before.block_ids).map((blockId, index) =>
        `${index + 1}. ${summarize(blockId)}`
      ),
      after_lines: idListOf(after.block_ids).map((blockId, index) =>
        `${index + 1}. ${summarize(blockId)}`
      ),
      block_id: idOf(operation.target.block_id),
    };
  });
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function splitLines(value) {
  const text = sanitizeAiText(value);
  if (!text) return [];
  return text.split(/\r?\n/);
}

/* ------------------------------------------------------------------ *
 * Execution record (non-canonical)
 * ------------------------------------------------------------------ */

/** Terminal state of one AI run. */
export const AI_EXECUTION_STATUS = ["succeeded", "failed", "cancelled"];
/** What an AI run produced. */
export const AI_EXECUTION_OUTCOME = [
  "answer",
  "suggestion",
  "change_draft",
  "none",
];

/**
 * Build one execution record.  Pure and synchronous so the UI can always write
 * a record, even when the call failed.
 *
 * The record contains metadata only: no prompt body, no item content, no
 * credential.  `provider` is rebuilt from exactly three fields so an
 * accidentally passed secret field cannot reach the record.
 *
 * @param {{
 *   id?: string,
 *   project_id?: string,
 *   started_at?: string,
 *   finished_at?: string,
 *   created_at?: string,
 *   scope?: { kind?: string, content_item_id?: string | null, block_id?: string | null, label?: string },
 *   instruction?: string,
 *   context?: AiContext | { item_count?: number, chars?: number, source_types?: string[] } | null,
 *   provider?: { provider_id?: string, model?: string, label?: string },
 *   status?: string,
 *   error_code?: string | null,
 *   error_message?: string,
 *   outcome?: string,
 *   suggestion_id?: string | null,
 *   change_draft_id?: string | null,
 *   review?: { state?: string, decided_at?: string | null },
 * }} input
 * @returns {AiExecutionRecord}
 */
export function buildAiExecutionRecord(input = {}) {
  const request = recordOf(input);
  const created = stringOf(request.started_at) || stringOf(request.created_at) ||
    nowIso();
  const finished = stringOf(request.finished_at) || nowIso();
  const elapsed = Date.parse(finished) - Date.parse(created);
  const duration = Number.isFinite(elapsed) && elapsed > 0
    ? Math.round(elapsed)
    : 0;

  const scope = recordOf(request.scope);
  const context = recordOf(request.context);
  const items = Array.isArray(context.items) ? context.items : [];
  const provider = recordOf(request.provider);
  const review = recordOf(request.review);

  const instruction = sanitizeAiText(stringOf(request.instruction));
  const errorMessage = sanitizeAiText(stringOf(request.error_message));
  const errorCode = idOf(request.error_code);

  const sourceTypes = items.length
    ? [...new Set(items.map((item) => normalizeSourceType(recordOf(item).source_type)))]
    : Array.isArray(context.source_types)
    ? idListOf(context.source_types).map(normalizeSourceType)
    : [];

  return {
    id: stringOf(request.id) || uuid(),
    project_id: stringOf(request.project_id),
    created_at: created,
    finished_at: finished,
    duration_ms: duration,
    scope: {
      kind: stringOf(scope.kind) || "lesson",
      content_item_id: idOf(scope.content_item_id),
      block_id: idOf(scope.block_id),
      label: sanitizeAiText(stringOf(scope.label)),
    },
    instruction: instruction.length > AI_CONTEXT_LIMITS.record_instruction_chars
      ? `${instruction.slice(0, AI_CONTEXT_LIMITS.record_instruction_chars - 1)}…`
      : instruction,
    context: {
      item_count: items.length || Number(context.item_count) || 0,
      chars: Number(context.payload_chars) || Number(context.chars) || 0,
      source_types: sourceTypes,
    },
    provider: {
      provider_id: stringOf(provider.provider_id),
      model: stringOf(provider.model),
      label: stringOf(provider.label),
    },
    // V0 calls no tools, no MCP server and no Skill: the record says so
    // truthfully instead of implying capabilities that were not used.
    capabilities: { tools: [], mcp: [], skills: [] },
    status: AI_EXECUTION_STATUS.includes(stringOf(request.status))
      ? stringOf(request.status)
      : "failed",
    error_code: errorCode,
    error_message: errorMessage.length > 500
      ? `${errorMessage.slice(0, 499)}…`
      : errorMessage,
    outcome: AI_EXECUTION_OUTCOME.includes(stringOf(request.outcome))
      ? stringOf(request.outcome)
      : "none",
    suggestion_id: idOf(request.suggestion_id),
    change_draft_id: idOf(request.change_draft_id),
    review: {
      state: AI_REVIEW_STATES.includes(stringOf(review.state))
        ? stringOf(review.state)
        : "pending",
      decided_at: idOf(review.decided_at),
    },
  };
}
