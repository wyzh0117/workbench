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
type PersistedCache = {
  version: number;
  plans: ResourceDiscoveryPlan[];
  tasks: ResourceDiscoveryTask[];
  accepted: Record<string, AcceptedCandidate>;
  retry_queries: Record<string, ResourceDiscoveryQueryPlan[]>;
};

function isoNow(): string {
  return now();
}

function taskStopped(task: ResourceDiscoveryTask): boolean {
  return task.state === "cancel_requested" || task.state === "cancelled" || task.state === "stale";
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
      preferences.language,
      preferences.learner_level,
      preferences.case_types?.join(" "),
      preferences.source_preference?.join(" "),
    ].map(normalizeText).filter(Boolean).join(" ");
    const dateTerms = [
      preferences.published_after ? `after:${preferences.published_after.slice(0, 10)}` : "",
      preferences.published_before ? `before:${preferences.published_before.slice(0, 10)}` : "",
    ].filter(Boolean).join(" ");
    const query = normalizeText(`${context.queryBase} ${suffix} ${dateTerms}`).slice(0, 500);
    queries.push({
      lesson_id: itemId,
      need: context.queryBase,
      existing_resource_ids: context.existingResourceIds,
      source_locators: context.sourceLocators,
      queries: searchTypes.map((kind) => ({
        kind,
        query,
        request_budget_upper_bound: kind === "web"
          ? 1 + Math.min(preferences.per_lesson_limit, MAX_CASE_RESULTS_PER_QUERY)
          : 4,
      })),
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
  private readonly retryQueries = new Map<string, ResourceDiscoveryQueryPlan[]>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private loaded: Promise<void> | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    directory: string,
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
    const built = buildQueries(project, contentItemIds, searchTypes, preferences);
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
    await this.assertPlanFresh(plan, project);
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
    this.retryQueries.set(task.task_id, plan.queries.flatMap((lesson) => lesson.queries.map((query) => ({
      ...lesson,
      queries: [query],
    }))));
    this.trim();
    await this.persist();
    this.schedule(task.task_id, () => this.runTask(task.task_id));
    return structuredClone(task);
  }

  async getTask(taskId: string): Promise<ResourceDiscoveryTask | null> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    const plan = task && this.plans.get(task.plan_id);
    if (task && plan && !["cancelled", "failed", "stale"].includes(task.state)) {
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
    if (!["partial", "failed", "completed"].includes(task.state)) {
      throw error("invalid_task_state", "当前任务还不能重试。", `Cannot retry task in state ${task.state}`);
    }
    const pending = this.retryQueries.get(taskId) ?? [];
    const selected = candidateId
      ? pending.filter((query) => task.candidates.some((candidate) => candidate.id === candidateId && candidate.lesson_id === query.lesson_id))
      : pending.filter((query) => task.errors.some((item) => item.query === query.queries[0]?.query));
    if (selected.length === 0) {
      throw error("no_retryable_work", "没有可重试的失败请求。", "No failed query is available to retry");
    }
    const plan = this.plans.get(task.plan_id);
    if (!plan || task.budget.remaining_requests <= 0) {
      throw error("budget_exhausted", "剩余请求预算不足，无法重试。", "No request budget remains for retry");
    }
    const project = this.requireProject();
    await this.assertPlanFresh(plan, project);
    const reservedRetryRequests = selected.reduce((total, row) =>
      total + (row.queries[0]?.request_budget_upper_bound ?? 0), 0);
    if (reservedRetryRequests > task.budget.remaining_requests) {
      throw error("budget_exhausted", "剩余预算不足以完成所选重试。", "Remaining request budget is below the retry upper bound");
    }
    if (candidateId) task.candidates = task.candidates.filter((candidate) => candidate.id !== candidateId);
    task.errors = task.errors.filter((item) => !selected.some((query) => query.queries[0]?.query === item.query));
    task.progress.total_queries += selected.length;
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
    const built = buildQueries(data, input.content_item_ids, input.search_types, input.preferences);
    const hash = await candidateInputHash({
      project_id: data.project.id,
      generation: this.getGeneration(),
      lesson_revisions: built.lessonRevisions,
      content_item_ids: input.content_item_ids,
      search_types: input.search_types,
      request_budget: input.request_budget,
      preferences: input.preferences,
      queries: built.queries,
    });
    return { hash, queries: built.queries, lessonRevisions: built.lessonRevisions };
  }

  private async assertPlanFresh(plan: ResourceDiscoveryPlan, data: ProjectData): Promise<void> {
    const generation = this.getGeneration();
    if (data.project.id !== plan.project_id || generation !== plan.snapshot.generation) {
      throw error("stale_input", "课程已切换，请重新准备资源发现。", "Resource discovery project generation changed");
    }
    const searchTypes = [...new Set(plan.queries.flatMap((lesson) => lesson.queries.map((query) => query.kind)))];
    const input: ResourceDiscoveryPrepareInput = {
      content_item_ids: plan.content_item_ids,
      search_types: searchTypes,
      request_budget: plan.budget.max_requests,
      preferences: plan.preferences,
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
    const queries = plan.queries.flatMap((lesson) => lesson.queries.map((query) => ({ ...lesson, queries: [query] })));
    await this.runQueries(taskId, queries, plan, controller);
  }

  private async runQueries(
    taskId: string,
    queries: ResourceDiscoveryQueryPlan[],
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
                task.errors.push({ code: failure.code, message: failure.message, query: queryPlan.query });
              }
              const evidence = makeEvidenceFromWeb(hit, fetched, failure);
              const candidate = candidateFromWeb(task.task_id, row.lesson_id, hit, evidence, plan.preferences);
              addProjectId(candidate, plan.project_id);
              this.addCandidate(task, candidate);
            }
          } else {
            const common = {
              query: queryPlan.query,
              count: Math.min(plan.preferences.per_lesson_limit, 10),
              country: plan.preferences.country,
              relevance_language: plan.preferences.language,
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
              addProjectId(candidate, plan.project_id);
              this.addCandidate(task, candidate);
            }
          }
          task.progress.completed_queries += 1;
        } catch (caught) {
          const failure = safeError(caught);
          if (failure.code === "stale_input") {
            task.state = "stale";
            controller.abort();
            break;
          }
          if (controller.signal.aborted || failure.code === "cancelled") break;
          task.errors.push({ code: failure.code, message: failure.message, query: queryPlan.query });
          task.progress.completed_queries += 1;
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
          task.state = "failed";
          task.errors.push({ code: "interrupted", message: "应用关闭时任务已停止，可重新检索。" });
          task.updated_at = isoNow();
        }
        this.tasks.set(task.task_id, task);
      }
      for (const [key, value] of Object.entries(parsed.accepted ?? {})) this.accepted.set(key, value);
      for (const [key, value] of Object.entries(parsed.retry_queries ?? {})) this.retryQueries.set(key, value);
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
