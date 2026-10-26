import { join } from "node:path";
import type {
  ProjectData,
  ResourceItem,
  ResourceUsage,
  SourceEvidence,
  VideoResourceMetadata,
} from "../domain/types.ts";
import { insertBlockAt } from "../domain/document.ts";
import { id, now } from "../domain/util.ts";
import type {
  ResourceCandidate,
  ResourceCandidateAcceptInput,
  ResourceDiscoveryDocumentContext,
  ResourceDiscoveryDocumentParseInput,
  ResourceDiscoveryDocumentParseResult,
  ResourceDiscoveryIntentOverrides,
  ResourceDiscoveryPlan,
  ResourceDiscoveryPreferences,
  ResourceDiscoveryPrepareInput,
  ResourceDiscoveryQueryPlan,
  ResourceDiscoveryTask,
  ResourceSearchType,
} from "../ui/contracts.ts";
import { ServiceError, error } from "./errors.ts";
import type {
  ResourceProviders,
  SourceFetchResult,
  VideoHit,
  WebSearchHit,
} from "./resource_providers.ts";

const CACHE_VERSION = 1;
const PLAN_TTL_MS = 15 * 60_000;
const MAX_CACHED_TASKS = 8;
const MAX_CANDIDATES_PER_TASK = 200;
const MAX_CASE_RESULTS_PER_QUERY = 3;
const PARAGRAPH_CONTEXT_LIMIT = 240;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/;

type AcceptedCandidate = { resource_id: string; usages: Record<string, string> };
type IndexedQuery = ResourceDiscoveryQueryPlan & { query_index: number };
type PersistedCache = {
  version: number;
  plans: ResourceDiscoveryPlan[];
  tasks: ResourceDiscoveryTask[];
  accepted: Record<string, AcceptedCandidate>;
  retry_queries: Record<string, IndexedQuery[]>;
};

const DOCUMENT_READ_LIMIT = 8 * 1024 * 1024;
const DOCUMENT_BLOCK_LIMIT = 500;
const DOCUMENT_TEXT_LIMIT = 120_000;

function safeAssetStoragePath(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("assets/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

async function assertRegularAssetPath(root: string, relativePath: string) {
  let path = root;
  const parts = relativePath.split("/");
  let stat: Deno.FileInfo | null = null;
  for (let index = 0; index < parts.length; index += 1) {
    path = join(path, parts[index]!);
    stat = await Deno.lstat(path);
    if (stat.isSymlink || (index === parts.length - 1 ? !stat.isFile : !stat.isDirectory)) {
      throw error("unsafe_asset_path", "文档素材路径无效，无法安全读取。", "Document asset path is not a regular in-project file");
    }
  }
  if (!stat) throw error("unsafe_asset_path", "文档素材路径无效，无法安全读取。", "Document asset path is empty");
  return { path, stat };
}

function sameAssetFile(left: Deno.FileInfo, right: Deno.FileInfo): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtime?.getTime() === right.mtime?.getTime();
}

function decodeDiscoveryText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2)), encoding: "UTF-16LE" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2);
    if (body.length % 2 !== 0) throw error("document_parse_failed", "文档编码不完整，无法读取。", "Odd byte count in UTF-16BE document");
    const swapped = new Uint8Array(body.length);
    for (let index = 0; index < body.length; index += 2) {
      swapped[index] = body[index + 1]!;
      swapped[index + 1] = body[index]!;
    }
    return { text: new TextDecoder("utf-16le", { fatal: true }).decode(swapped), encoding: "UTF-16BE" };
  }
  const utf8 = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(utf8), encoding: "UTF-8" };
}

function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return crypto.subtle.digest("SHA-256", buffer).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

function takeCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function boundedStringArray(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw error("invalid_input", `文档搜索 ${label} 无效。`, `${label} must be a bounded string array`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || Array.from(item.trim()).length > 160) {
      throw error("invalid_input", `文档搜索 ${label} 含无效内容。`, `${label} contains invalid text`);
    }
    if (!result.includes(item.trim())) result.push(item.trim());
  }
  return result;
}

function validIntentOverrides(raw: unknown): ResourceDiscoveryIntentOverrides | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw error("invalid_input", "搜索意图修改格式无效。", "intent_overrides must be an object");
  }
  const value = raw as Record<string, unknown>;
  const result: ResourceDiscoveryIntentOverrides = {};
  for (const key of ["themes", "keywords", "case_types", "media_types"] as const) {
    if (value[key] === undefined) continue;
    const list = boundedStringArray(value[key], key, 20);
    if (key === "themes" && !list.length) {
      throw error("invalid_input", "搜索主题不能为空。", "intent_overrides.themes must not be empty");
    }
    result[key] = list;
  }
  if (value.language !== undefined) {
    if (typeof value.language !== "string" || Array.from(value.language.trim()).length > 80) {
      throw error("invalid_input", "搜索语言无效。", "intent_overrides.language is invalid");
    }
    result.language = value.language.trim();
  }
  return result;
}

function isoNow(): string {
  return now();
}

function taskStopped(task: ResourceDiscoveryTask): boolean {
  return task.state === "cancel_requested" || task.state === "cancelled" || task.state === "stale";
}

function indexedQueries(plan: ResourceDiscoveryPlan): IndexedQuery[] {
  let query_index = 0;
  return plan.queries.flatMap((lesson) => lesson.queries.map((query) => ({
    ...lesson,
    queries: [query],
    query_index: query_index++,
  })));
}

function safeError(caught: unknown): { code: string; message: string } {
  if (caught instanceof ServiceError) {
    return {
      code: caught.error.code,
      message: caught.error.user_message,
    };
  }
  const value = caught && typeof caught === "object"
    ? caught as { error?: { code?: unknown; user_message?: unknown } }
    : null;
  if (value?.error) {
    return {
      code: typeof value.error.code === "string"
        ? value.error.code
        : "provider_unavailable",
      message: typeof value.error.user_message === "string"
        ? value.error.user_message
        : "资源来源暂时不可用，请重试。",
    };
  }
  return { code: "provider_unavailable", message: "资源来源暂时不可用，请重试。" };
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function sha256(value: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then(
    (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function canonicalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.href.replace(/\/$/, "");
  } catch {
    return value.trim();
  }
}

function inPublishedRange(
  value: string | null,
  preferences: ResourceDiscoveryPreferences,
): boolean {
  if (!value || !DATE_RE.test(value)) return true;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return true;
  const after = preferences.published_after ? Date.parse(preferences.published_after) : NaN;
  const before = preferences.published_before ? Date.parse(preferences.published_before) : NaN;
  return !(Number.isFinite(after) && timestamp < after) &&
    !(Number.isFinite(before) && timestamp > before);
}

function safeDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function itemContext(data: ProjectData, itemId: string) {
  const item = data.content_items.find((candidate) =>
    candidate.id === itemId && !candidate.archived
  );
  if (!item) throw error("stale_input", "所选课次已不存在，请重新准备资源发现。", "Selected content item is missing or archived");
  const doc = data.documents.find((candidate) => candidate.id === item.document_id);
  const blocks = doc ? data.blocks.filter((block) => block.document_id === doc.id)
    .sort((left, right) => left.order_index - right.order_index) : [];
  const sourceBlocks = blocks.filter((block) =>
    ["heading", "paragraph", "quote", "callout"].includes(block.type) &&
    typeof block.content === "string" && normalizeText(block.content)
  ).slice(0, 3);
  const blockText = sourceBlocks.map((block) => normalizeText(block.content)).join(" ");
  const base = normalizeText(`${item.title} ${item.description} ${blockText}`)
    .slice(0, PARAGRAPH_CONTEXT_LIMIT);
  const lessonRevision = JSON.stringify({
    item: { id: item.id, updated_at: item.updated_at, title: item.title, description: item.description },
    document: doc ? { id: doc.id, updated_at: doc.updated_at } : null,
    blocks: sourceBlocks.map(({ id: blockId, type, content, updated_at }) => ({
      id: blockId,
      type,
      content,
      updated_at,
    })),
  });
  const existingResourceIds = data.resource_usages.filter((usage) =>
    usage.lesson_id === item.id
  ).map((usage) => usage.resource_id);
  return {
    item,
    queryBase: base || normalizeText(item.title),
    excerpt: base || normalizeText(item.title),
    lessonRevision,
    existingResourceIds: [...new Set(existingResourceIds)],
    sourceLocators: sourceBlocks.map((block) => ({
      block_id: block.id,
      section: block.type === "heading" ? normalizeText(block.content) : null,
      paragraph: block.type === "heading" ? null : normalizeText(block.content).slice(0, 160),
    })),
  };
}

function validPreferences(input: ResourceDiscoveryPreferences): ResourceDiscoveryPreferences {
  const perLessonLimit = Number(input.per_lesson_limit);
  if (!Number.isInteger(perLessonLimit) || perLessonLimit < 1 || perLessonLimit > 10) {
    throw error("invalid_input", "每课候选数量需为 1 到 10。", "per_lesson_limit must be between 1 and 10");
  }
  const checkPair = (min: number | undefined, max: number | undefined, label: string) => {
    if (min !== undefined && (!Number.isFinite(min) || min < 0) ||
      max !== undefined && (!Number.isFinite(max) || max <= 0) ||
      min !== undefined && max !== undefined && min >= max) {
      throw error("invalid_input", `${label}范围无效。`, `${label} duration range is invalid`);
    }
  };
  checkPair(input.target_min_sec, input.target_max_sec, "目标时长");
  checkPair(input.wide_min_sec, input.wide_max_sec, "放宽时长");
  if (input.published_after && !DATE_RE.test(input.published_after) ||
    input.published_before && !DATE_RE.test(input.published_before)) {
    throw error("invalid_input", "发布日期范围无效。", "Publication dates must be ISO dates");
  }
  return structuredClone({
    ...input,
    per_lesson_limit: perLessonLimit,
    target_min_sec: input.target_min_sec ?? 240,
    target_max_sec: input.target_max_sec ?? 360,
    wide_min_sec: input.wide_min_sec ?? 180,
    wide_max_sec: input.wide_max_sec ?? 480,
  });
}

function buildQueries(
  data: ProjectData,
  contentItemIds: string[],
  searchTypes: ResourceSearchType[],
  preferences: ResourceDiscoveryPreferences,
  documentContext?: ResourceDiscoveryDocumentContext,
  intentOverrides?: ResourceDiscoveryIntentOverrides,
): { queries: ResourceDiscoveryQueryPlan[]; preview: ResourceDiscoveryPlan["context_preview"]; lessonRevisions: Record<string, string> } {
  const queries: ResourceDiscoveryQueryPlan[] = [];
  const items: ResourceDiscoveryPlan["context_preview"]["items"] = [];
  const lessonRevisions: Record<string, string> = {};
  for (const itemId of contentItemIds) {
    const context = itemContext(data, itemId);
    lessonRevisions[itemId] = context.lessonRevision;
    items.push({
      content_item_id: itemId,
      title: context.item.title,
      excerpt: context.excerpt,
    });
    const suffix = [
      intentOverrides?.language || preferences.language || documentContext?.preferred_language,
      preferences.learner_level,
      (intentOverrides?.case_types ?? documentContext?.case_types ?? preferences.case_types)?.join(" "),
      (intentOverrides?.media_types ?? documentContext?.media_types)?.join(" "),
      preferences.source_preference?.join(" "),
    ].map(normalizeText).filter(Boolean).join(" ");
    const dateTerms = [
      preferences.published_after ? `after:${preferences.published_after.slice(0, 10)}` : "",
      preferences.published_before ? `before:${preferences.published_before.slice(0, 10)}` : "",
    ].filter(Boolean).join(" ");
    const topics = documentContext
      ? (intentOverrides?.themes ?? documentContext.themes.map((theme) => theme.name))
      : [context.queryBase];
    const documentTerms = documentContext
      ? [
        (intentOverrides?.keywords ?? documentContext.keywords).join(" "),
        documentContext.concepts.slice(0, 4).join(" "),
        documentContext.objectives.slice(0, 2).join(" "),
        documentContext.constraints?.terms?.join(" "),
        documentContext.constraints?.time_range,
        documentContext.constraints?.regions?.join(" "),
        documentContext.constraints?.industries?.join(" "),
      ].join(" ")
      : "";
    const queryRows = topics.flatMap((topic) => searchTypes.map((kind) => ({
      kind,
      ...(documentContext ? { topic } : {}),
      query: normalizeText(`${topic} ${documentTerms} ${suffix} ${dateTerms}`).slice(0, 500),
      request_budget_upper_bound: kind === "web"
        ? 1 + Math.min(preferences.per_lesson_limit, MAX_CASE_RESULTS_PER_QUERY)
        : 4,
    })));
    queries.push({
      lesson_id: itemId,
      need: documentContext ? topics.join(" · ") : context.queryBase,
      existing_resource_ids: context.existingResourceIds,
      source_locators: context.sourceLocators,
      queries: queryRows,
    });
  }
  return {
    queries,
    preview: {
      items,
      character_count: items.reduce((total, item) => total + item.excerpt.length, 0),
    },
    lessonRevisions,
  };
}

async function candidateInputHash(input: {
  project_id: string;
  generation: number;
  lesson_revisions: Record<string, string>;
  content_item_ids: string[];
  search_types: ResourceSearchType[];
  request_budget: number;
  preferences: ResourceDiscoveryPreferences;
  document_context?: ResourceDiscoveryDocumentContext;
  intent_overrides?: ResourceDiscoveryIntentOverrides;
  queries: ResourceDiscoveryQueryPlan[];
}): Promise<string> {
  return await sha256(JSON.stringify(input));
}

function makeEvidenceFromWeb(
  hit: WebSearchHit,
  fetched: SourceFetchResult | null,
  failure?: { code: string; message: string },
): SourceEvidence {
  return {
    id: id(),
    project_id: "",
    provider_id: hit.provider_id,
    request_id: fetched?.request_id ?? hit.request_id,
    query: hit.query,
    requested_at: fetched?.requested_at ?? hit.requested_at,
    url: hit.url,
    title: fetched?.title ?? hit.title,
    publisher: fetched?.publisher ?? hit.publisher,
    event_date: null,
    published_at: safeDate(hit.published_at),
    fetched_at: fetched?.fetched_at ?? hit.fetched_at,
    excerpt: fetched?.excerpt ?? null,
    evidence_access: fetched?.evidence_access ?? "unavailable",
    fact_check: "unchecked",
    content_hash: fetched?.content_hash ?? null,
    limitations: [
      ...(fetched?.limitations ?? []),
      ...(failure ? [`Source fetch failed (${failure.code}); search metadata is not evidence text.`] : []),
      ...(hit.published_at && !safeDate(hit.published_at) ? ["Provider publication date could not be normalized; event date remains unknown."] : []),
    ],
  };
}

function videoEvidence(hit: VideoHit): SourceEvidence {
  return {
    id: id(),
    project_id: "",
    provider_id: hit.provider_id,
    request_id: hit.request_id,
    query: hit.query,
    requested_at: hit.requested_at,
    url: hit.url,
    title: hit.title,
    publisher: hit.channel_title,
    event_date: null,
    published_at: safeDate(hit.published_at),
    fetched_at: hit.fetched_at,
    excerpt: null,
    evidence_access: "metadata_only",
    fact_check: "unchecked",
    content_hash: null,
    limitations: [...hit.metadata_limitations],
  };
}

function explicitMergeTarget(input: ResourceCandidateAcceptInput): string | null {
  const raw = input as unknown as Record<string, unknown>;
  const resourceId = raw.existing_resource_id;
  const confirmed = raw.merge_confirmed;
  if (resourceId !== undefined && (typeof resourceId !== "string" || !resourceId.trim())) {
    throw error("invalid_input", "合并目标无效。", "existing_resource_id must be a non-empty string");
  }
  if (confirmed !== undefined && typeof confirmed !== "boolean") {
    throw error("invalid_input", "合并确认必须是布尔值。", "merge_confirmed must be boolean");
  }
  if (resourceId !== undefined ? confirmed !== true : confirmed === true) {
    throw error("merge_confirmation_required", "选择合并目标并确认后才能合并来源。", "Explicit merge requires a selected resource and merge_confirmed=true");
  }
  return typeof resourceId === "string" ? resourceId : null;
}

function manualTimingInput(value: unknown): { start_sec: number; end_sec: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw error("invalid_input", "人工视频时间证据格式无效。", "manual_video_timing must be an object");
  }
  const timing = value as Record<string, unknown>;
  if (timing.confirmed !== true || typeof timing.start_sec !== "number" || !Number.isFinite(timing.start_sec) ||
    typeof timing.end_sec !== "number" || !Number.isFinite(timing.end_sec)) {
    throw error("manual_confirmation_required", "请确认已在视频中人工核对片段时间。", "Manual video timing requires finite times and confirmed=true");
  }
  return { start_sec: timing.start_sec, end_sec: timing.end_sec };
}

function createManualTimingEvidence(
  candidate: ResourceCandidate,
  timing: { start_sec: number; end_sec: number },
  projectId: string,
  durationEvidence: SourceEvidence | undefined,
): SourceEvidence {
  const video = candidate.video;
  const videoId = video?.provider_video_id;
  const duration = video?.total_duration_sec;
  let trustedUrl = false;
  try {
    const parsed = new URL(candidate.url || "");
    trustedUrl = parsed.protocol === "https:" && parsed.hostname === "www.youtube.com" &&
      parsed.pathname === "/watch" && parsed.searchParams.get("v") === videoId &&
      candidate.url === `https://www.youtube.com/watch?v=${videoId}`;
  } catch {
    // Invalid stored candidate URLs are rejected below.
  }
  if (!video || video.provider_id !== "youtube_data_api" || !/^[A-Za-z0-9_-]{11}$/.test(videoId || "") ||
    !trustedUrl || typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 ||
    !durationEvidence || durationEvidence.provider_id !== video.provider_id || durationEvidence.url !== candidate.url ||
    durationEvidence.evidence_access !== "metadata_only" || video.duration_evidence_id !== durationEvidence.id ||
    timing.start_sec < 0 || timing.start_sec >= timing.end_sec || timing.end_sec > duration) {
    throw error("timing_evidence_required", "无法用有效的视频来源与时长元数据验证片段。", "Manual video timing requires a matching YouTube metadata source and known duration");
  }
  const createdAt = now();
  return {
    id: id(),
    project_id: projectId,
    provider_id: video.provider_id,
    request_id: `manual:${id()}`,
    url: candidate.url,
    title: `人工确认视频片段 ${timing.start_sec}–${timing.end_sec} 秒`,
    publisher: candidate.publisher,
    event_date: null,
    published_at: candidate.published_at,
    fetched_at: createdAt,
    locator: { start_sec: timing.start_sec, end_sec: timing.end_sec },
    excerpt: null,
    evidence_access: "metadata_only",
    fact_check: "unchecked",
    content_hash: null,
    limitations: ["用户人工查看并记录了片段时间；未校验字幕或文字稿。"],
    evidence_method: "manual_video_timing",
    confirmed_by_user: true,
  };
}

function videoMetadata(hit: VideoHit, evidenceId: string): VideoResourceMetadata {
  return {
    provider_id: hit.provider_id,
    provider_video_id: hit.provider_video_id,
    total_duration_sec: hit.total_duration_sec,
    duration_evidence_id: hit.total_duration_sec === null ? null : evidenceId,
    spoken_language: hit.spoken_language,
    subtitle_languages: null,
    language_evidence_ids: [],
    caption_state: hit.captions_available === true
      ? "available"
      : hit.captions_available === false
      ? "unavailable"
      : "unknown",
    embeddable: hit.embeddable,
    region_availability: hit.region_availability,
    metadata_limitations: [
      ...hit.metadata_limitations,
      "Public video metadata does not establish spoken language or downloadable caption languages.",
    ],
  };
}

function candidateFromWeb(
  taskId: string,
  lessonId: string,
  hit: WebSearchHit,
  evidence: SourceEvidence,
  preferences: ResourceDiscoveryPreferences,
): ResourceCandidate {
  const summary = evidence.excerpt
    ? evidence.excerpt
    : "检索摘要仅供发现线索；来源正文未读取，事实待人工核验。";
  const limitations = [...evidence.limitations];
  if (!evidence.excerpt) limitations.push("Search result descriptions are not retained as factual evidence.");
  if (preferences.published_after || preferences.published_before) {
    limitations.push("Publication range is filtered only when the provider returns a parseable publication date.");
  }
  return {
    id: id(),
    task_id: taskId,
    lesson_id: lessonId,
    medium: "text",
    narrative_case_type: null,
    title: evidence.title || hit.title,
    event_subject: null,
    event_date: null,
    published_at: evidence.published_at,
    publisher: evidence.publisher,
    url: hit.url,
    fetched_at: evidence.fetched_at,
    factual_summary: summary,
    claims: [],
    source_evidence: [evidence],
    video: null,
    status: "pending",
    limitations,
  };
}

function candidateFromVideo(taskId: string, lessonId: string, hit: VideoHit): ResourceCandidate {
  const evidence = videoEvidence(hit);
  const video = videoMetadata(hit, evidence.id);
  return {
    id: id(),
    task_id: taskId,
    lesson_id: lessonId,
    medium: "video",
    narrative_case_type: null,
    title: hit.title,
    event_subject: null,
    event_date: null,
    published_at: safeDate(hit.published_at),
    publisher: hit.channel_title,
    url: hit.url,
    fetched_at: hit.fetched_at,
    factual_summary: `平台元数据：${hit.channel_title}；${hit.total_duration_sec === null ? "时长未核验" : `总时长 ${hit.total_duration_sec} 秒`}。`,
    claims: hit.total_duration_sec === null ? [] : [{ text: `视频总时长为 ${hit.total_duration_sec} 秒`, evidence_ids: [evidence.id] }],
    source_evidence: [evidence],
    video,
    ...(hit.duration_class === "outside" ? {} : { duration_class: hit.duration_class }),
    status: "pending",
    limitations: [...hit.metadata_limitations],
  };
}

function addProjectId(candidate: ResourceCandidate, projectId: string): void {
  for (const evidence of candidate.source_evidence) evidence.project_id = projectId;
}

function blockContent(candidate: ResourceCandidate): string {
  const title = candidate.url ? `[${candidate.title}](${candidate.url})` : candidate.title;
  const summary = candidate.source_evidence.some((item) => item.evidence_access === "content_read")
    ? candidate.factual_summary
    : `${candidate.factual_summary}（来源尚待人工核验）`;
  return `${title}\n\n${summary}`;
}

export class ResourceDiscoveryService {
  private readonly cachePath: string;
  private readonly plans = new Map<string, ResourceDiscoveryPlan>();
  private readonly tasks = new Map<string, ResourceDiscoveryTask>();
  private readonly accepted = new Map<string, AcceptedCandidate>();
  private readonly retryQueries = new Map<string, IndexedQuery[]>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private loaded: Promise<void> | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly directory: string,
    private readonly providers: ResourceProviders,
    private readonly getProject: () => ProjectData | null,
    private readonly getGeneration: () => number,
    private readonly saveProject: (data: ProjectData, input: unknown) => Promise<{ project: ProjectData; mutation_ack?: Record<string, unknown> }>,
  ) {
    this.cachePath = join(directory, ".workspace", "resource-discovery.json");
  }

  async listProviders() {
    return await this.providers.listProviders();
  }

  async parseDocument(input: ResourceDiscoveryDocumentParseInput): Promise<ResourceDiscoveryDocumentParseResult> {
    const project = this.requireProject();
    const assetId = typeof input?.asset_id === "string" ? input.asset_id.trim() : "";
    if (!assetId || assetId.length > 256) {
      throw error("invalid_input", "素材 ID 无效。", "Document discovery requires an asset_id");
    }
    const asset = project.assets.find((candidate) => candidate.id === assetId && !candidate.archived);
    if (!asset || asset.project_id !== project.project.id) {
      throw error("asset_not_found", "找不到可读取的文档素材。", "Document asset is missing, archived or belongs to another project");
    }
    const extension = asset.filename.split(".").pop()?.toLowerCase() ?? "";
    if (!["txt", "text", "md", "markdown"].includes(extension)) {
      throw error("unsupported_platform", "DOCX、PDF 和 PPTX 正文读取需要 Tauri 桌面版。", "This shell only parses canonical TXT and Markdown assets");
    }
    if (!safeAssetStoragePath(asset.storage_path)) {
      throw error("unsafe_asset_path", "文档素材路径无效，无法安全读取。", "Document asset storage_path is not a safe assets/ path");
    }
    const before = await assertRegularAssetPath(this.directory, asset.storage_path);
    if (before.stat.size > DOCUMENT_READ_LIMIT) {
      throw error("document_too_large", "文档超过 8 MiB 的浏览器壳读取上限。", "TXT/Markdown asset exceeds the browser-shell read limit");
    }
    const bytes = await Deno.readFile(before.path);
    const after = await assertRegularAssetPath(this.directory, asset.storage_path);
    if (!sameAssetFile(before.stat, after.stat) || bytes.byteLength !== after.stat.size) {
      throw error("stale_input", "文档素材读取期间发生变化，请重新导入。", "Document asset changed while being read");
    }
    const decoded = decodeDiscoveryText(bytes);
    const source = decoded.text.replace(/\r\n?/g, "\n");
    const paragraphs = source.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean);
    const markdown = extension === "md" || extension === "markdown";
    const rawBlocks = paragraphs.map((text) => ({
      text,
      type: markdown && /^#{1,6}\s/.test(text.split("\n", 1)[0]!) ? "heading" : "paragraph",
    }));
    const sourceTextChars = Array.from(source).length;
    const firstHeading = rawBlocks.find((block) => block.type === "heading")?.text;
    const firstBlock = rawBlocks[0]?.text;
    const title = takeCodePoints((firstHeading ?? firstBlock ?? asset.title ?? asset.filename).split("\n", 1)[0]!.replace(/^#{1,6}\s*/, "").trim(), 300) || asset.filename.replace(/\.[^.]+$/, "");
    const warnings: string[] = [];
    if (decoded.encoding !== "UTF-8") warnings.push(`文档编码识别为 ${decoded.encoding}，已转换为 UTF-8。`);
    if (!paragraphs.length) warnings.push("文档为空，没有可用于搜索的正文。");
    const blocks: ResourceDiscoveryDocumentParseResult["blocks"] = [];
    const textParts: string[] = [];
    let section: string | undefined;
    let textChars = 0;
    let truncated = false;
    for (const raw of rawBlocks) {
      const separator = textParts.length ? 2 : 0;
      const remaining = DOCUMENT_TEXT_LIMIT - textChars - separator;
      if (blocks.length >= DOCUMENT_BLOCK_LIMIT || remaining <= 0) {
        truncated = true;
        break;
      }
      const bounded = takeCodePoints(raw.text, remaining);
      if (bounded.length !== raw.text.length) truncated = true;
      if (raw.type === "heading") section = takeCodePoints(raw.text.replace(/^#{1,6}\s*/, ""), 300);
      textParts.push(bounded);
      textChars += Array.from(bounded).length + separator;
      const locator = { block: blocks.length, ...(section ? { section } : {}) };
      blocks.push({ index: blocks.length, type: raw.type, text: bounded, locator });
      if (truncated) break;
    }
    if (truncated) warnings.push(`供 AI 提取的正文最多保留 ${DOCUMENT_TEXT_LIMIT} 个字符和 ${DOCUMENT_BLOCK_LIMIT} 个段落。`);
    return {
      asset_id: assetId,
      filename: asset.filename,
      file_type: extension,
      sha256: await sha256Bytes(bytes),
      title,
      text: textParts.join("\n\n"),
      source_text_chars: sourceTextChars,
      readable: textParts.some((part) => part.trim()),
      blocks,
      warnings,
      degraded: false,
      truncated,
    };
  }

  private async validateDocumentContext(raw: unknown): Promise<ResourceDiscoveryDocumentContext> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw error("invalid_input", "文档主题数据无效。", "document_context must be an object");
    }
    const candidate = raw as Record<string, unknown>;
    const assetId = typeof candidate.asset_id === "string" ? candidate.asset_id.trim() : "";
    const digest = typeof candidate.sha256 === "string" ? candidate.sha256 : "";
    if (!assetId || assetId.length > 256 || !/^[a-f0-9]{64}$/.test(digest)) {
      throw error("invalid_input", "文档主题数据缺少素材或校验信息。", "document_context asset_id or sha256 is invalid");
    }
    const parsed = await this.parseDocument({ asset_id: assetId });
    if (parsed.sha256 !== digest) {
      throw error("stale_input", "文档素材已变化，请重新解析。", "Document context digest does not match the canonical imported asset");
    }
    if (!Array.isArray(candidate.themes) || candidate.themes.length < 1 || candidate.themes.length > 8) {
      throw error("invalid_input", "文档至少需要一个可追溯主题。", "document_context must have 1–8 themes");
    }
    const themes = candidate.themes.map((rawTheme) => {
      if (!rawTheme || typeof rawTheme !== "object" || Array.isArray(rawTheme)) {
        throw error("invalid_input", "文档主题格式无效。", "A document theme must be an object");
      }
      const theme = rawTheme as Record<string, unknown>;
      const name = typeof theme.name === "string" ? theme.name.trim() : "";
      if (!name || Array.from(name).length > 160 || !Array.isArray(theme.evidence) || theme.evidence.length < 1 || theme.evidence.length > 4) {
        throw error("invalid_input", "文档主题或原文依据无效。", "A theme needs a bounded name and 1–4 evidence rows");
      }
      const evidence = theme.evidence.map((rawEvidence) => {
        if (!rawEvidence || typeof rawEvidence !== "object" || Array.isArray(rawEvidence)) {
          throw error("invalid_input", "文档主题依据格式无效。", "Document evidence must be an object");
        }
        const row = rawEvidence as Record<string, unknown>;
        const text = typeof row.text === "string" ? row.text.trim() : "";
        const locator = row.locator && typeof row.locator === "object" && !Array.isArray(row.locator)
          ? row.locator as Record<string, unknown>
          : null;
        if (!text || Array.from(text).length > 800 || !locator || Object.keys(locator).some((key) => !["block", "section", "page", "slide"].includes(key))) {
          throw error("invalid_input", "文档主题依据缺少有效原文定位。", "Document evidence text or locator is invalid");
        }
        const index = locator.block;
        const block = Number.isInteger(index) && (index as number) >= 0
          ? parsed.blocks[index as number]
          : undefined;
        if (!block || block.index !== index || !normalizeText(block.text).includes(normalizeText(text))) {
          throw error("invalid_input", "主题依据与文档实际区块不匹配。", "Document evidence text does not occur in its cited parsed block");
        }
        for (const key of ["section", "page", "slide"] as const) {
          if (locator[key] !== undefined && block.locator[key] !== locator[key]) {
            throw error("invalid_input", "主题依据页码或章节与文档不匹配。", `Document evidence ${key} locator is not present on the cited block`);
          }
        }
        return { text, locator: structuredClone(block.locator) };
      });
      return { name, evidence };
    });
    const language = typeof candidate.language === "string" && Array.from(candidate.language).length <= 80
      ? candidate.language.trim()
      : null;
    if (language === null) {
      throw error("invalid_input", "文档来源语言字段无效。", "document_context.language must be a string of at most 80 characters");
    }
    const preferredLanguage = candidate.preferred_language;
    if (preferredLanguage !== undefined && (typeof preferredLanguage !== "string" || Array.from(preferredLanguage.trim()).length > 80)) {
      throw error("invalid_input", "搜索偏好语言无效。", "document_context.preferred_language is invalid");
    }
    let constraints: ResourceDiscoveryDocumentContext["constraints"];
    if (candidate.constraints !== undefined) {
      if (!candidate.constraints || typeof candidate.constraints !== "object" || Array.isArray(candidate.constraints)) {
        throw error("invalid_input", "文档限定条件格式无效。", "document_context.constraints must be an object");
      }
      const rawConstraints = candidate.constraints as Record<string, unknown>;
      if (Object.keys(rawConstraints).some((key) => !["terms", "time_range", "regions", "industries"].includes(key))) {
        throw error("invalid_input", "文档限定条件含未知字段。", "document_context.constraints contains an unknown field");
      }
      constraints = {
        ...(rawConstraints.terms === undefined ? {} : { terms: boundedStringArray(rawConstraints.terms, "限制术语", 20) }),
        ...(rawConstraints.regions === undefined ? {} : { regions: boundedStringArray(rawConstraints.regions, "地区", 20) }),
        ...(rawConstraints.industries === undefined ? {} : { industries: boundedStringArray(rawConstraints.industries, "行业", 20) }),
      };
      if (rawConstraints.time_range !== undefined) {
        if (typeof rawConstraints.time_range !== "string" || Array.from(rawConstraints.time_range.trim()).length > 160) {
          throw error("invalid_input", "文档时间范围无效。", "document_context.constraints.time_range is invalid");
        }
        constraints.time_range = rawConstraints.time_range.trim();
      }
    }
    return {
      asset_id: assetId,
      sha256: digest,
      title: parsed.title,
      themes,
      concepts: boundedStringArray(candidate.concepts, "概念", 20),
      objectives: boundedStringArray(candidate.objectives, "教学目标", 20),
      case_types: boundedStringArray(candidate.case_types, "案例类型", 20),
      media_types: boundedStringArray(candidate.media_types, "媒体类型", 20),
      keywords: boundedStringArray(candidate.keywords, "关键词", 30),
      language,
      ...(preferredLanguage === undefined ? {} : { preferred_language: preferredLanguage.trim() }),
      ...(constraints === undefined ? {} : { constraints }),
    };
  }

  async prepare(input: ResourceDiscoveryPrepareInput): Promise<ResourceDiscoveryPlan> {
    await this.ensureLoaded();
    const project = this.requireProject();
    if (!input || !Array.isArray(input.content_item_ids) || !Array.isArray(input.search_types) || !input.preferences || typeof input.preferences !== "object") {
      throw error("invalid_input", "资源发现参数无效。", "Resource discovery inputs have the wrong shape");
    }
    const contentItemIds = [...new Set(input.content_item_ids.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
    const searchTypes = [...new Set(input.search_types)].filter((value): value is ResourceSearchType => value === "web" || value === "video");
    if (searchTypes.length !== input.search_types.length) {
      throw error("invalid_input", "资源类型无效。", "Resource discovery search_types contains an unsupported value");
    }
    if (contentItemIds.length === 0 || contentItemIds.length > 20 || searchTypes.length === 0) {
      throw error("invalid_input", "请至少选择一节课和一种资源类型。", "Resource discovery requires 1–20 lessons and at least one search type");
    }
    const requestBudget = Number(input.request_budget);
    if (!Number.isInteger(requestBudget) || requestBudget < 1 || requestBudget > 200) {
      throw error("invalid_input", "网络请求预算需为 1 到 200。", "request_budget must be between 1 and 200");
    }
    const preferences = validPreferences(input.preferences);
    const documentContext = input.document_context === undefined
      ? undefined
      : await this.validateDocumentContext(input.document_context);
    const intentOverrides = validIntentOverrides(input.intent_overrides);
    const built = buildQueries(project, contentItemIds, searchTypes, preferences, documentContext, intentOverrides);
    const requiredUpperBound = built.queries.reduce((sum, lesson) =>
      sum + lesson.queries.reduce((subtotal, query) => subtotal + query.request_budget_upper_bound, 0), 0);
    const createdAt = isoNow();
    const base = {
      project_id: project.project.id,
      generation: this.getGeneration(),
      lesson_revisions: built.lessonRevisions,
      content_item_ids: contentItemIds,
      search_types: searchTypes,
      request_budget: requestBudget,
      preferences,
      ...(documentContext ? { document_context: documentContext } : {}),
      ...(intentOverrides ? { intent_overrides: intentOverrides } : {}),
      queries: built.queries,
    };
    const inputHash = await candidateInputHash(base);
    const plan: ResourceDiscoveryPlan = {
      plan_id: id(),
      project_id: project.project.id,
      input_hash: inputHash,
      snapshot: {
        project_id: project.project.id,
        generation: this.getGeneration(),
        input_hash: inputHash,
        lesson_revisions: built.lessonRevisions,
      },
      content_item_ids: contentItemIds,
      preferences,
      ...(documentContext ? { document_context: documentContext } : {}),
      ...(intentOverrides ? { intent_overrides: intentOverrides } : {}),
      queries: built.queries,
      context_preview: built.preview,
      budget: { max_requests: requestBudget, required_upper_bound: requiredUpperBound },
      created_at: createdAt,
      expires_at: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
    };
    this.plans.set(plan.plan_id, plan);
    this.trim();
    await this.persist();
    return structuredClone(plan);
  }

  async getPlan(planId: string): Promise<ResourceDiscoveryPlan | null> {
    await this.ensureLoaded();
    const plan = this.plans.get(planId);
    return plan ? structuredClone(plan) : null;
  }

  async start(input: { plan_id: string; input_hash: string; authorized: true }): Promise<ResourceDiscoveryTask> {
    await this.ensureLoaded();
    const plan = this.plans.get(input.plan_id);
    if (!plan || plan.expires_at <= isoNow()) {
      throw error("plan_expired", "资源发现方案已过期，请重新准备。", "Resource discovery plan is missing or expired");
    }
    if (input.authorized !== true || input.input_hash !== plan.input_hash) {
      throw error("authorization_required", "启动前请确认本次发送的检索上下文。", "Resource discovery requires explicit authorization and the prepared input hash");
    }
    if (plan.budget.required_upper_bound > plan.budget.max_requests) {
      throw error("budget_exhausted", `当前预算不足；最多需要 ${plan.budget.required_upper_bound} 次网络请求。`, "Prepared request budget is below the conservative HTTP upper bound");
    }
    const project = this.requireProject();
    await this.assertPlanFresh(plan, project, true);
    const task: ResourceDiscoveryTask = {
      task_id: id(),
      state: "queued",
      snapshot: structuredClone(plan.snapshot),
      plan_id: plan.plan_id,
      progress: { completed_queries: 0, total_queries: plan.queries.reduce((sum, row) => sum + row.queries.length, 0) },
      budget: {
        max_requests: plan.budget.max_requests,
        reserved_requests: plan.budget.required_upper_bound,
        completed_requests: 0,
        remaining_requests: plan.budget.max_requests,
      },
      candidates: [],
      errors: [],
      created_at: isoNow(),
      updated_at: isoNow(),
    };
    this.tasks.set(task.task_id, task);
    this.retryQueries.set(task.task_id, indexedQueries(plan));
    this.trim();
    await this.persist();
    this.schedule(task.task_id, () => this.runTask(task.task_id));
    return structuredClone(task);
  }

  async getTask(taskId: string): Promise<ResourceDiscoveryTask | null> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    const plan = task && this.plans.get(task.plan_id);
    if (task && plan && !["cancelled", "failed", "stale", "interrupted"].includes(task.state)) {
      try {
        await this.assertPlanFresh(plan, this.requireProject());
      } catch {
        task.state = "stale";
        task.updated_at = isoNow();
        this.controllers.get(taskId)?.abort();
        await this.persist();
      }
    }
    return task ? structuredClone(task) : null;
  }

  async cancel(taskId: string): Promise<ResourceDiscoveryTask> {
    await this.ensureLoaded();
    const task = this.requireTask(taskId);
    if (task.state === "queued" || task.state === "running") {
      task.state = "cancel_requested";
      task.updated_at = isoNow();
      this.controllers.get(taskId)?.abort();
      if (!this.controllers.has(taskId)) task.state = "cancelled";
      await this.persist();
    }
    return structuredClone(task);
  }

  async retry(taskId: string, candidateId?: string): Promise<ResourceDiscoveryTask> {
    await this.ensureLoaded();
    const task = this.requireTask(taskId);
    const continuing = task.state === "cancelled" || task.state === "interrupted";
    if (!continuing && !["partial", "failed", "completed"].includes(task.state)) {
      throw error("invalid_task_state", "当前任务还不能重试。", `Cannot retry task in state ${task.state}`);
    }
    const pending = this.retryQueries.get(taskId) ?? [];
    const selected = continuing
      ? pending.filter((query) => query.query_index >= task.progress.completed_queries)
      : candidateId
      ? pending.filter((query) => task.candidates.some((candidate) => candidate.id === candidateId && candidate.lesson_id === query.lesson_id))
      : pending.filter((query) => task.errors.some((item) =>
        item.query_index === query.query_index || (item.query_index === undefined && item.query === query.queries[0]?.query)
      ));
    if (selected.length === 0) {
      throw error("no_retryable_work", "没有可重试的失败请求。", "No failed query is available to retry");
    }
    const plan = this.plans.get(task.plan_id);
    if (!plan || task.budget.remaining_requests <= 0) {
      throw error("budget_exhausted", "剩余请求预算不足，无法重试。", "No request budget remains for retry");
    }
    const project = this.requireProject();
    if (continuing) await this.rebindInterruptedTask(task, plan, project);
    await this.assertPlanFresh(plan, project, continuing);
    const reservedRetryRequests = selected.reduce((total, row) =>
      total + (row.queries[0]?.request_budget_upper_bound ?? 0), 0);
    if (reservedRetryRequests > task.budget.remaining_requests) {
      throw error("budget_exhausted", "剩余预算不足以完成所选重试。", "Remaining request budget is below the retry upper bound");
    }
    if (candidateId) task.candidates = task.candidates.filter((candidate) => candidate.id !== candidateId);
    if (!continuing) {
      task.errors = task.errors.filter((item) => !selected.some((query) =>
        item.query_index === query.query_index || (item.query_index === undefined && item.query === query.queries[0]?.query)
      ));
    }
    task.state = "running";
    task.updated_at = isoNow();
    await this.persist();
    this.schedule(taskId, () => this.runQueries(taskId, selected, plan));
    return structuredClone(task);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const task of this.tasks.values()) {
      if (task.state === "queued") {
        task.state = "cancelled";
        task.updated_at = isoNow();
      }
    }
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.runs.values()]);
    await this.persist();
  }

  async accept(input: ResourceCandidateAcceptInput): Promise<{
    result: {
      resource: ResourceItem;
      evidence: SourceEvidence[];
      usage: ResourceUsage;
      block_id: string | null;
      candidate_id: string;
    };
    mutation_ack?: Record<string, unknown>;
  }> {
    await this.ensureLoaded();
    const task = this.requireTask(input.task_id);
    const candidate = task.candidates.find((item) => item.id === input.candidate_id);
    if (!candidate) throw error("candidate_missing", "候选已不存在，请重新搜索。", "Resource candidate is missing");
    const explicitResourceId = explicitMergeTarget(input);
    const manualTiming = input.manual_video_timing === undefined
      ? null
      : manualTimingInput(input.manual_video_timing);
    const project = this.requireProject();
    const plan = this.plans.get(task.plan_id);
    if (!plan) throw error("stale_input", "资源发现上下文已过期，请重新搜索。", "Resource discovery plan is missing");
    await this.assertPlanFresh(plan, project);
    if (!plan.content_item_ids.includes(input.lesson_id)) {
      throw error("invalid_lesson", "目标课次不属于本次任务。", "Target lesson is outside the prepared discovery plan");
    }
    const lesson = project.content_items.find((item) => item.id === input.lesson_id && !item.archived);
    if (!lesson) throw error("stale_input", "目标课次已不存在，请重新准备。", "Target lesson is missing or archived");
    const acceptedKey = `${task.task_id}:${candidate.id}`;
    const prior = this.accepted.get(acceptedKey);
    const data = structuredClone(project);
    const sourceEvidence = data.source_evidence;
    if (candidate.accepted_resource_id && explicitResourceId && candidate.accepted_resource_id !== explicitResourceId) {
      throw error("invalid_resource_merge", "此候选已绑定到另一资源，不能重新绑定。", "Accepted candidate cannot be rebound to another resource");
    }
    let resource = candidate.accepted_resource_id
      ? data.resource_items.find((item) => item.id === candidate.accepted_resource_id)
      : prior
      ? data.resource_items.find((item) => item.id === prior.resource_id)
      : undefined;
    if (explicitResourceId) {
      resource = data.resource_items.find((item) => item.id === explicitResourceId);
      if (!resource || resource.project_id !== data.project.id) {
        throw error("invalid_resource_merge", "合并目标不属于当前项目。", "Explicit merge target is not a project resource");
      }
    }
    if (resource && resource.medium !== candidate.medium) {
      throw error("invalid_resource_merge", "只能将同类素材的来源合并到一起。", "Explicit resource merge requires matching media types");
    }
    if (resource?.video && candidate.video &&
      (resource.video.provider_id !== candidate.video.provider_id ||
        resource.video.provider_video_id !== candidate.video.provider_video_id)) {
      throw error("invalid_resource_merge", "该视频资源已绑定到另一条视频，请保留为独立资源。", "A resource cannot replace its single canonical video with a different video");
    }
    if (!resource && candidate.video?.provider_video_id) {
      resource = data.resource_items.find((item) =>
        item.medium === candidate.medium &&
        item.video?.provider_id === candidate.video?.provider_id &&
        item.video?.provider_video_id === candidate.video?.provider_video_id
      );
    }
    if (!resource && candidate.url) {
      const normalized = canonicalUrl(candidate.url);
      const evidenceIds = new Set(data.source_evidence.filter((item) => canonicalUrl(item.url) === normalized).map((item) => item.id));
      resource = data.resource_items.find((item) => item.medium === candidate.medium && item.source_ids.some((evidenceId) => evidenceIds.has(evidenceId)));
    }
    const evidenceIdMap = new Map<string, string>();
    const freshEvidence: SourceEvidence[] = [];
    for (const source of candidate.source_evidence) {
      const existing = data.source_evidence.find((item) =>
        item.provider_id === source.provider_id &&
        item.request_id === source.request_id &&
        item.url === source.url
      );
      if (existing) {
        evidenceIdMap.set(source.id, existing.id);
        continue;
      }
      const idCollision = data.source_evidence.some((item) => item.id === source.id);
      const evidence = structuredClone(source);
      evidence.id = idCollision ? id() : source.id;
      evidence.project_id = data.project.id;
      evidenceIdMap.set(source.id, evidence.id);
      freshEvidence.push(evidence);
    }
    sourceEvidence.push(...freshEvidence);
    const canonicalCandidateVideo = candidate.video ? structuredClone(candidate.video) : null;
    if (canonicalCandidateVideo?.duration_evidence_id) {
      canonicalCandidateVideo.duration_evidence_id = evidenceIdMap.get(canonicalCandidateVideo.duration_evidence_id) ??
        (sourceEvidence.find((item) => item.id === canonicalCandidateVideo.duration_evidence_id)?.id ?? null);
      if (!canonicalCandidateVideo.duration_evidence_id) {
        throw error("invalid_candidate", "视频时长缺少对应来源证据。", "Video metadata duration evidence is missing");
      }
    }
    const candidateClaims = candidate.claims.map((claim) => ({
      ...structuredClone(claim),
      evidence_ids: claim.evidence_ids.map((evidenceId) => evidenceIdMap.get(evidenceId) ?? evidenceId)
        .filter((evidenceId) => sourceEvidence.some((item) => item.id === evidenceId)),
    }));
    if (!resource) {
      resource = {
        contract_version: 1,
        id: id(),
        project_id: data.project.id,
        medium: candidate.medium,
        ...(candidate.narrative_case_type ? { narrative_case_type: candidate.narrative_case_type } : {}),
        title: candidate.title,
        source_ids: [...new Set(candidate.source_evidence.map((evidence) => evidenceIdMap.get(evidence.id)).filter((value): value is string => Boolean(value)))],
        factual_summary: candidate.factual_summary,
        claims: candidateClaims,
        ...(canonicalCandidateVideo ? { video: canonicalCandidateVideo } : {}),
        revision: 1,
        created_at: isoNow(),
        updated_at: isoNow(),
      };
      data.resource_items.push(resource);
    } else {
      const candidateEvidenceIds = candidate.source_evidence
        .map((evidence) => evidenceIdMap.get(evidence.id))
        .filter((value): value is string => Boolean(value));
      const additions = candidateEvidenceIds.filter((evidenceId) => !resource!.source_ids.includes(evidenceId));
      resource.source_ids.push(...additions);
      for (const claim of candidateClaims) {
        if (!resource.claims.some((existing) => existing.text === claim.text && existing.evidence_ids.join() === claim.evidence_ids.join())) {
          resource.claims.push(claim);
        }
      }
      if (!resource.video && canonicalCandidateVideo) resource.video = canonicalCandidateVideo;
      if (!resource.factual_summary && candidate.factual_summary) resource.factual_summary = candidate.factual_summary;
      resource.revision += additions.length > 0 ? 1 : 0;
      resource.updated_at = isoNow();
    }
    for (const claim of resource.claims) {
      claim.evidence_ids = claim.evidence_ids.filter((evidenceId) =>
        data.source_evidence.some((evidence) => evidence.id === evidenceId)
      );
    }
    const evidenceIds = new Set(resource.source_ids);
    const evidence = data.source_evidence.filter((item) => evidenceIds.has(item.id));
    const teachingUse = normalizeText(input.teaching_use);
    if (!teachingUse || teachingUse.length > 2_000 || input.discussion_questions.length > 20) {
      throw error("invalid_input", "教学用法或讨论题不符合长度限制。", "Resource usage text exceeds limits");
    }
    if (manualTiming && candidate.medium !== "video") {
      throw error("invalid_input", "人工时间证据只能用于视频素材。", "Manual video timing is only valid for video candidates");
    }
    if (manualTiming && input.video_selection !== undefined) {
      const selection = input.video_selection;
      const timingEvidence = selection?.timing_evidence_id
        ? data.source_evidence.find((item) => item.id === selection.timing_evidence_id)
        : undefined;
      if (selection?.mode !== "clip" || selection.start_sec !== manualTiming.start_sec ||
        selection.end_sec !== manualTiming.end_sec ||
        (selection.timing_evidence_id !== null && selection.timing_evidence_id !== undefined &&
          (!timingEvidence || timingEvidence.provider_id !== candidate.video?.provider_id ||
            timingEvidence.url !== candidate.url ||
            timingEvidence.locator?.start_sec !== manualTiming.start_sec ||
            timingEvidence.locator?.end_sec !== manualTiming.end_sec))) {
        throw error("invalid_video_selection", "人工记录的时间与其他片段选择冲突。", "Manual timing conflicts with the supplied video selection");
      }
    }
    if (!manualTiming && candidate.medium === "video" && input.video_selection?.mode === "clip") {
      const selection = input.video_selection;
      const total = resource.video?.total_duration_sec;
      const timing = selection.timing_evidence_id && data.source_evidence.find((item) => item.id === selection.timing_evidence_id);
      if (total === null || total === undefined || selection.start_sec === null || selection.end_sec === null ||
        selection.start_sec < 0 || selection.start_sec >= selection.end_sec || selection.end_sec > total ||
        !candidate.video || !timing || timing.provider_id !== candidate.video.provider_id ||
        timing.url !== candidate.url || timing.evidence_access !== "timed_transcript" ||
        timing.locator?.start_sec !== selection.start_sec || timing.locator?.end_sec !== selection.end_sec) {
        throw error("timing_evidence_required", "没有可核验的时间证据，无法保存片段建议。", "Video clip requires verified timing evidence within total duration");
      }
    }
    let existingUsage = data.resource_usages.find((usage) =>
      usage.resource_id === resource!.id && usage.lesson_id === lesson.id &&
      (input.action === "insert_citation" ? usage.block_id !== null : usage.block_id === null)
    );
    let videoSelection = input.video_selection ? structuredClone(input.video_selection) : undefined;
    if (manualTiming) {
      if (existingUsage) {
        const previousTiming = existingUsage.video_selection?.timing_evidence_id
          ? data.source_evidence.find((item) => item.id === existingUsage.video_selection!.timing_evidence_id)
          : undefined;
        if (existingUsage.video_selection?.mode !== "clip" ||
          existingUsage.video_selection.start_sec !== manualTiming.start_sec ||
          existingUsage.video_selection.end_sec !== manualTiming.end_sec ||
          previousTiming?.evidence_method !== "manual_video_timing") {
          throw error("usage_conflict", "该课次已保存另一种视频选择，不能用不同片段覆盖。", "Existing usage conflicts with this manual video timing");
        }
        videoSelection = structuredClone(existingUsage.video_selection);
      } else {
        const sourceId = candidate.video?.duration_evidence_id;
        const durationEvidence = sourceId
          ? sourceEvidence.find((item) => item.id === evidenceIdMap.get(sourceId))
          : undefined;
        const timingEvidence = createManualTimingEvidence(candidate, manualTiming, data.project.id, durationEvidence);
        sourceEvidence.push(timingEvidence);
        if (!resource.source_ids.includes(timingEvidence.id)) resource.source_ids.push(timingEvidence.id);
        videoSelection = {
          mode: "clip",
          start_sec: manualTiming.start_sec,
          end_sec: manualTiming.end_sec,
          timing_evidence_id: timingEvidence.id,
        };
        resource.revision += 1;
        resource.updated_at = isoNow();
      }
    }
    let blockId: string | null = existingUsage?.block_id ?? null;
    if (input.action === "insert_citation") {
      if (input.block_id && !data.blocks.some((block) => block.id === input.block_id)) {
        throw error("invalid_block", "引用目标正文区块不存在。", "Citation target block does not exist");
      }
      if (input.block_id) {
        const target = data.blocks.find((block) => block.id === input.block_id)!;
        const targetDocument = data.documents.find((item) => item.id === target.document_id);
        if (targetDocument?.content_item_id !== lesson.id) {
          throw error("invalid_block", "引用目标正文区块不属于所选课次。", "Citation target block belongs to another lesson");
        }
      }
      if (!existingUsage) {
        const content = blockContent(candidate);
        const targetIndex = input.block_id
          ? data.blocks.find((block) => block.id === input.block_id)!.order_index + 1
          : data.blocks.filter((block) => block.document_id === lesson.document_id).length;
        const block = insertBlockAt(data, lesson.id, "paragraph", content, targetIndex, { resource_id: resource.id });
        blockId = block.id;
      }
    }
    let usage: ResourceUsage | undefined = existingUsage;
    if (!usage) {
      usage = {
        contract_version: 1,
        id: prior?.usages[lesson.id] ?? id(),
        project_id: data.project.id,
        resource_id: resource.id,
        lesson_id: lesson.id,
        block_id: blockId,
        teaching_use: teachingUse,
        discussion_questions: input.discussion_questions.map(normalizeText).filter(Boolean).slice(0, 20),
        ...(videoSelection ? { video_selection: videoSelection } : {}),
        created_at: isoNow(),
      };
      data.resource_usages.push(usage);
    }
    const commit = await this.commit(data, input);
    const saved = commit.project;
    const committedResource = saved.resource_items.find((item) => item.id === resource!.id)!;
    const committedUsage = saved.resource_usages.find((item) => item.id === usage!.id)!;
    this.accepted.set(acceptedKey, {
      resource_id: committedResource.id,
      usages: { ...(prior?.usages ?? {}), [lesson.id]: committedUsage.id },
    });
    const liveTask = this.requireTask(task.task_id);
    const liveCandidate = liveTask.candidates.find((item) => item.id === candidate.id);
    if (liveCandidate) {
      liveCandidate.status = "accepted";
      liveCandidate.accepted_resource_id = committedResource.id;
    }
    const committedGeneration = this.getGeneration();
    if (saved.project.id === plan.project_id &&
      committedGeneration === plan.snapshot.generation + 1 &&
      this.getProject()?.project.id === plan.project_id) {
      const searchTypes = [...new Set(plan.queries.flatMap((row) => row.queries.map((query) => query.kind)))];
      const refreshed = await this.buildPlan(saved, {
        content_item_ids: plan.content_item_ids,
        search_types: searchTypes,
        request_budget: plan.budget.max_requests,
        preferences: plan.preferences,
        ...(plan.document_context ? { document_context: plan.document_context } : {}),
        ...(plan.intent_overrides ? { intent_overrides: plan.intent_overrides } : {}),
      });
      plan.input_hash = refreshed.hash;
      plan.snapshot = {
        project_id: plan.project_id,
        generation: committedGeneration,
        input_hash: refreshed.hash,
        lesson_revisions: refreshed.lessonRevisions,
      };
      plan.queries = refreshed.queries;
      liveTask.snapshot = structuredClone(plan.snapshot);
    }
    liveTask.updated_at = isoNow();
    await this.persist();
    return {
      result: {
        resource: structuredClone(committedResource),
        evidence: committedResource.source_ids.map((evidenceId) => saved.source_evidence.find((item) => item.id === evidenceId)!).filter(Boolean),
        usage: structuredClone(committedUsage),
        block_id: committedUsage.block_id,
        candidate_id: candidate.id,
      },
      ...(commit.mutation_ack ? { mutation_ack: commit.mutation_ack } : {}),
    };
  }

  private async buildPlan(
    data: ProjectData,
    input: ResourceDiscoveryPrepareInput,
  ): Promise<{ hash: string; queries: ResourceDiscoveryQueryPlan[]; lessonRevisions: Record<string, string> }> {
    const built = buildQueries(
      data,
      input.content_item_ids,
      input.search_types,
      input.preferences,
      input.document_context,
      input.intent_overrides,
    );
    const hash = await candidateInputHash({
      project_id: data.project.id,
      generation: this.getGeneration(),
      lesson_revisions: built.lessonRevisions,
      content_item_ids: input.content_item_ids,
      search_types: input.search_types,
      request_budget: input.request_budget,
      preferences: input.preferences,
      ...(input.document_context ? { document_context: input.document_context } : {}),
      ...(input.intent_overrides ? { intent_overrides: input.intent_overrides } : {}),
      queries: built.queries,
    });
    return { hash, queries: built.queries, lessonRevisions: built.lessonRevisions };
  }

  private async rebindInterruptedTask(
    task: ResourceDiscoveryTask,
    plan: ResourceDiscoveryPlan,
    project: ProjectData,
  ): Promise<void> {
    const generation = this.getGeneration();
    if (project.project.id !== plan.project_id) {
      throw error("stale_input", "课程已切换，请重新准备资源发现。", "Interrupted resource task belongs to another project");
    }
    if (generation === plan.snapshot.generation) return;
    const searchTypes = [...new Set(plan.queries.flatMap((row) => row.queries.map((query) => query.kind)))];
    const fresh = await this.buildPlan(project, {
      content_item_ids: plan.content_item_ids,
      search_types: searchTypes,
      request_budget: plan.budget.max_requests,
      preferences: plan.preferences,
      ...(plan.document_context ? { document_context: plan.document_context } : {}),
      ...(plan.intent_overrides ? { intent_overrides: plan.intent_overrides } : {}),
    });
    if (JSON.stringify(fresh.queries) !== JSON.stringify(plan.queries) ||
      JSON.stringify(fresh.lessonRevisions) !== JSON.stringify(plan.snapshot.lesson_revisions)) {
      throw error("stale_input", "课程内容已变化，请重新准备资源发现。", "Interrupted resource task inputs changed while the app was closed");
    }
    if (plan.document_context) {
      const current = await this.validateDocumentContext(plan.document_context);
      if (JSON.stringify(current) !== JSON.stringify(plan.document_context)) {
        throw error("stale_input", "文档素材或主题依据已变化，请重新准备资源发现。", "Interrupted resource task document evidence changed while the app was closed");
      }
    }
    plan.input_hash = fresh.hash;
    plan.snapshot = {
      project_id: plan.project_id,
      generation,
      input_hash: fresh.hash,
      lesson_revisions: fresh.lessonRevisions,
    };
    task.snapshot = structuredClone(plan.snapshot);
    task.updated_at = isoNow();
    await this.persist();
  }

  private async assertPlanFresh(plan: ResourceDiscoveryPlan, data: ProjectData, verifyDocument = false): Promise<void> {
    const generation = this.getGeneration();
    if (data.project.id !== plan.project_id || generation !== plan.snapshot.generation) {
      throw error("stale_input", "课程已切换，请重新准备资源发现。", "Resource discovery project generation changed");
    }
    if (plan.document_context) {
      const asset = data.assets.find((candidate) => candidate.id === plan.document_context!.asset_id && !candidate.archived);
      if (!asset || asset.project_id !== plan.project_id || asset.checksum !== plan.document_context.sha256) {
        throw error("stale_input", "文档素材已变化，请重新准备资源发现。", "Resource discovery document asset metadata changed");
      }
      if (verifyDocument) {
        const fresh = await this.validateDocumentContext(plan.document_context);
        if (JSON.stringify(fresh) !== JSON.stringify(plan.document_context)) {
          throw error("stale_input", "文档素材或主题依据已变化，请重新准备资源发现。", "Resource discovery document context changed after preparation");
        }
      }
    }
    const searchTypes = [...new Set(plan.queries.flatMap((lesson) => lesson.queries.map((query) => query.kind)))];
    const input: ResourceDiscoveryPrepareInput = {
      content_item_ids: plan.content_item_ids,
      search_types: searchTypes,
      request_budget: plan.budget.max_requests,
      preferences: plan.preferences,
      ...(plan.document_context ? { document_context: plan.document_context } : {}),
      ...(plan.intent_overrides ? { intent_overrides: plan.intent_overrides } : {}),
    };
    const fresh = await this.buildPlan(data, input);
    if (fresh.hash !== plan.input_hash || fresh.hash !== plan.snapshot.input_hash) {
      throw error("stale_input", "所选课次内容已变化，请重新准备资源发现。", "Resource discovery inputs changed after preparation");
    }
  }

  private async runTask(taskId: string): Promise<void> {
    if (this.closed) return;
    const task = this.tasks.get(taskId);
    const plan = task && this.plans.get(task.plan_id);
    if (!task || !plan || task.state !== "queued") return;
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    try {
      await this.assertPlanFresh(plan, this.requireProject());
    } catch {
      task.state = "stale";
      task.updated_at = isoNow();
      this.controllers.delete(taskId);
      await this.persist();
      return;
    }
    task.state = "running";
    task.updated_at = isoNow();
    await this.persist();
    const queries = indexedQueries(plan);
    await this.runQueries(taskId, queries, plan, controller);
  }

  private async runQueries(
    taskId: string,
    queries: IndexedQuery[],
    plan: ResourceDiscoveryPlan,
    controller = this.controllers.get(taskId) ?? new AbortController(),
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.controllers.set(taskId, controller);
    const spendRequest = () => {
      if (controller.signal.aborted || taskStopped(task)) {
        throw new DOMException("Cancelled", "AbortError");
      }
      if (this.getProject()?.project.id !== plan.project_id || this.getGeneration() !== plan.snapshot.generation) {
        task.state = "stale";
        controller.abort();
        throw error("stale_input", "课程已切换或修改，请重新准备资源发现。", "Resource discovery generation changed before request dispatch");
      }
      if (task.budget.completed_requests >= task.budget.max_requests) {
        throw error("budget_exhausted", "网络请求预算已用完。", "Resource discovery HTTP budget exhausted");
      }
      task.budget.completed_requests += 1;
      task.budget.remaining_requests = task.budget.max_requests - task.budget.completed_requests;
      task.updated_at = isoNow();
      void this.persist().catch(() => undefined);
    };
    try {
      for (const row of queries) {
        if (controller.signal.aborted || taskStopped(task)) break;
        const queryPlan = row.queries[0];
        if (!queryPlan) continue;
        try {
          const project = this.requireProject();
          await this.assertPlanFresh(plan, project);
          if (queryPlan.kind === "web") {
            const hits = await this.providers.searchWeb({
              query: queryPlan.query,
              count: Math.min(plan.preferences.per_lesson_limit, MAX_CASE_RESULTS_PER_QUERY),
              country: plan.preferences.country,
              search_lang: plan.preferences.language,
              signal: controller.signal,
              onRequest: spendRequest,
            });
            await this.assertPlanFresh(plan, this.requireProject());
            for (const hit of hits) {
              if (controller.signal.aborted || taskStopped(task)) break;
              if (!inPublishedRange(hit.published_at, plan.preferences)) continue;
              let fetched: SourceFetchResult | null = null;
              let failure: { code: string; message: string } | undefined;
              try {
                fetched = await this.providers.fetchSource({
                  url: hit.url,
                  query: queryPlan.query,
                  signal: controller.signal,
                  onRequest: spendRequest,
                });
                if (controller.signal.aborted || taskStopped(task)) break;
              } catch (caught) {
                if (controller.signal.aborted) throw caught;
                failure = safeError(caught);
                task.errors.push({ code: failure.code, message: failure.message, query: queryPlan.query, query_index: row.query_index });
              }
              const evidence = makeEvidenceFromWeb(hit, fetched, failure);
              const candidate = candidateFromWeb(task.task_id, row.lesson_id, hit, evidence, plan.preferences);
              if (queryPlan.topic) candidate.matched_themes = [queryPlan.topic];
              addProjectId(candidate, plan.project_id);
              this.addCandidate(task, candidate);
            }
          } else {
            const common = {
              query: queryPlan.query,
              count: Math.min(plan.preferences.per_lesson_limit, 10),
              country: plan.preferences.country,
              relevance_language: plan.intent_overrides?.language || plan.preferences.language || plan.document_context?.preferred_language,
              published_after: plan.preferences.published_after ?? undefined,
              published_before: plan.preferences.published_before ?? undefined,
              signal: controller.signal,
              onRequest: spendRequest,
            };
            let hits = await this.providers.searchVideos({ ...common, duration_band: "target" });
            await this.assertPlanFresh(plan, this.requireProject());
            let acceptedHits = hits.filter((hit) => hit.duration_class === "target" || hit.duration_class === "unknown");
            const futureReservation = queries.slice(queries.indexOf(row) + 1).reduce((total, next) =>
              total + (next.queries[0]?.request_budget_upper_bound ?? 0), 0);
            if (!hits.some((hit) => hit.duration_class === "target") && task.budget.remaining_requests >= 2 + futureReservation) {
              const wide = await this.providers.searchVideos({ ...common, duration_band: "short_fallback" });
              await this.assertPlanFresh(plan, this.requireProject());
              acceptedHits.push(...wide.filter((hit) => hit.duration_class === "wide" || hit.duration_class === "unknown"));
            }
            const seen = new Set<string>();
            for (const hit of acceptedHits) {
              if (seen.has(hit.provider_video_id) || !inPublishedRange(hit.published_at, plan.preferences)) continue;
              seen.add(hit.provider_video_id);
              const candidate = candidateFromVideo(task.task_id, row.lesson_id, hit);
              if (queryPlan.topic) candidate.matched_themes = [queryPlan.topic];
              addProjectId(candidate, plan.project_id);
              this.addCandidate(task, candidate);
            }
          }
          task.progress.completed_queries = Math.max(task.progress.completed_queries, row.query_index + 1);
        } catch (caught) {
          const failure = safeError(caught);
          if (failure.code === "stale_input") {
            task.state = "stale";
            controller.abort();
            break;
          }
          if (controller.signal.aborted || failure.code === "cancelled") break;
          task.errors.push({ code: failure.code, message: failure.message, query: queryPlan.query, query_index: row.query_index });
          task.progress.completed_queries = Math.max(task.progress.completed_queries, row.query_index + 1);
        }
        task.updated_at = isoNow();
        await this.persist();
      }
    } finally {
      this.controllers.delete(taskId);
      if (task.state === "stale") {
        // Keep stale terminal state; its snapshot can no longer authorize results.
      } else if (task.state === "cancel_requested" || controller.signal.aborted) task.state = "cancelled";
      else if (task.errors.length && task.candidates.length) task.state = "partial";
      else if (task.errors.length) task.state = "failed";
      else task.state = "completed";
      task.updated_at = isoNow();
      await this.persist();
    }
  }

  private addCandidate(task: ResourceDiscoveryTask, candidate: ResourceCandidate): void {
    if (task.state === "cancel_requested" || task.state === "cancelled") return;
    const sourceKey = candidate.video?.provider_video_id
      ? `youtube:${candidate.video.provider_video_id}`
      : canonicalUrl(candidate.url);
    const candidateKey = sourceKey ? `${candidate.lesson_id}:${sourceKey}` : null;
    const duplicate = candidateKey && task.candidates.find((existing) =>
      `${existing.lesson_id}:${existing.video?.provider_video_id ? `youtube:${existing.video.provider_video_id}` : canonicalUrl(existing.url)}` === candidateKey
    );
    if (duplicate) {
      const known = new Set(duplicate.source_evidence.map((evidence) => `${evidence.provider_id}:${evidence.request_id}:${evidence.url}`));
      for (const evidence of candidate.source_evidence) {
        const key = `${evidence.provider_id}:${evidence.request_id}:${evidence.url}`;
        if (!known.has(key)) duplicate.source_evidence.push(evidence);
      }
      duplicate.limitations = [...new Set([...duplicate.limitations, ...candidate.limitations])];
      duplicate.matched_themes = [...new Set([...(duplicate.matched_themes ?? []), ...(candidate.matched_themes ?? [])])];
      return;
    }
    if (task.candidates.length < MAX_CANDIDATES_PER_TASK) task.candidates.push(candidate);
  }

  private requireProject(): ProjectData {
    const project = this.getProject();
    if (!project) throw error("project_not_open", "请先打开课程项目。", "Resource workflow requires an open project");
    return project;
  }

  private requireTask(taskId: string): ResourceDiscoveryTask {
    const task = this.tasks.get(taskId);
    if (!task) throw error("task_missing", "资源发现任务已不存在。", "Resource discovery task is missing");
    return task;
  }

  private async commit(data: ProjectData, input: unknown): Promise<{ project: ProjectData; mutation_ack?: Record<string, unknown> }> {
    return await this.saveProject(data, input);
  }

  private schedule(taskId: string, run: () => Promise<void>): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      const active = run().catch(() => undefined).finally(() => this.runs.delete(taskId));
      this.runs.set(taskId, active);
    }, 0);
    this.timers.add(timer);
  }

  private trim(): void {
    while (this.tasks.size > MAX_CACHED_TASKS) {
      const key = this.tasks.keys().next().value;
      if (!key) break;
      if (this.controllers.has(key)) break;
      this.tasks.delete(key);
      this.retryQueries.delete(key);
    }
    while (this.plans.size > MAX_CACHED_TASKS) {
      const key = this.plans.keys().next().value;
      if (!key) break;
      this.plans.delete(key);
    }
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await Deno.readTextFile(this.cachePath)) as PersistedCache;
      if (parsed.version !== CACHE_VERSION) return;
      for (const plan of parsed.plans ?? []) if (plan?.plan_id && plan.expires_at > isoNow()) this.plans.set(plan.plan_id, plan);
      for (const task of parsed.tasks ?? []) {
        if (!task?.task_id) continue;
        if (["queued", "running", "cancel_requested"].includes(task.state)) {
          task.state = "interrupted";
          task.updated_at = isoNow();
        }
        this.tasks.set(task.task_id, task);
      }
      for (const [key, value] of Object.entries(parsed.accepted ?? {})) this.accepted.set(key, value);
      for (const [key, value] of Object.entries(parsed.retry_queries ?? {})) {
        const normalized = value.map((row, index) => ({
          ...row,
          query_index: Number.isSafeInteger(row.query_index) ? row.query_index : index,
        }));
        this.retryQueries.set(key, normalized);
      }
      for (const task of this.tasks.values()) {
        if (!this.retryQueries.has(task.task_id)) {
          const plan = this.plans.get(task.plan_id);
          if (plan) this.retryQueries.set(task.task_id, indexedQueries(plan));
        }
      }
      this.trim();
    } catch (caught) {
      if (!(caught instanceof Deno.errors.NotFound)) {
        // ponytail: malformed derived cache is discarded; canonical resources remain authoritative.
        await Deno.remove(this.cachePath).catch(() => undefined);
      }
    }
  }

  private persist(): Promise<void> {
    const cache: PersistedCache = {
      version: CACHE_VERSION,
      plans: [...this.plans.values()],
      tasks: [...this.tasks.values()],
      accepted: Object.fromEntries(this.accepted),
      retry_queries: Object.fromEntries(this.retryQueries),
    };
    this.writeTail = this.writeTail.then(async () => {
      const parent = join(this.cachePath, "..");
      await Deno.mkdir(parent, { recursive: true });
      const temp = `${this.cachePath}.${id()}.tmp`;
      try {
        await Deno.writeTextFile(temp, JSON.stringify(cache));
        await Deno.rename(temp, this.cachePath);
      } catch (caught) {
        await Deno.remove(temp).catch(() => undefined);
        throw caught;
      }
    });
    return this.writeTail;
  }
}
