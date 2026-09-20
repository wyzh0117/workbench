import {
  type ChangeDraft,
  type ChangePatch,
  type ContextPack,
  type ContextPackItem,
  type ContextSourceType,
  type JsonValue,
  type ProjectData,
  type Suggestion,
  type SuggestionType,
} from "./types.ts";
import { assert, id, now, sha256 } from "./util.ts";
import { documentRevision, updateBlockContent } from "./document.ts";
import { touchProject } from "./store.ts";

export interface ExplicitContextItem {
  source_type: ContextSourceType;
  source_id: string;
  label: string;
  content: string;
}

export interface ContextPackResult {
  pack: ContextPack;
  items: ContextPackItem[];
  /** The only context allowed to be sent to a model for this pack. */
  selected_content: string[];
}

export async function createContextPack(
  data: ProjectData,
  input: {
    purpose: string;
    target_content_item_id?: string | null;
    model_connection_id?: string | null;
    items: ExplicitContextItem[];
  },
): Promise<ContextPackResult> {
  const targetId = input.target_content_item_id ?? null;
  if (targetId) {
    assert(
      data.content_items.some((item) =>
        item.id === targetId && item.project_id === data.project.id
      ),
      "上下文目标内容不存在",
    );
  }
  const sourceKeys = new Set<string>();
  for (const selected of input.items) {
    const sourceKey = `${selected.source_type}:${selected.source_id}`;
    assert(
      !sourceKeys.has(sourceKey),
      `上下文来源不能重复: ${selected.source_id}`,
    );
    sourceKeys.add(sourceKey);
  }
  const pack: ContextPack = {
    id: id(),
    project_id: data.project.id,
    target_content_item_id: targetId,
    purpose: input.purpose,
    created_at: now(),
    model_connection_id: input.model_connection_id ?? null,
  };
  data.context_packs.push(pack);
  const items: ContextPackItem[] = [];
  for (const [index, selected] of input.items.entries()) {
    const item: ContextPackItem = {
      id: id(),
      context_pack_id: pack.id,
      source_type: selected.source_type,
      source_id: selected.source_id,
      label: selected.label,
      content_hash: await sha256(selected.content),
      order_index: index,
    };
    data.context_pack_items.push(item);
    items.push(item);
  }
  touchProject(data);
  return {
    pack,
    items,
    selected_content: input.items.map((item) => item.content),
  };
}

export interface ModelRequest {
  purpose: string;
  target_content_item_id: string | null;
  selected_context: ExplicitContextItem[];
  /** Optional user-reviewed patch input for deterministic test adapters. */
  proposed_changes?: ChangePatch[];
}

export interface ModelAdapter {
  analyze(request: ModelRequest): Promise<{
    type: SuggestionType;
    title: string;
    description: string;
    evidence_refs?: JsonValue[];
    proposed_changes?: ChangePatch[];
  }[]>;
}

/** Production must fail explicitly until a configured provider is injected. */
export class ModelUnavailableError extends Error {
  readonly code = "model_connection_unavailable";

  constructor(message = "尚未配置可用的模型连接") {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export class UnsupportedModelAdapter implements ModelAdapter {
  analyze(_request: ModelRequest): Promise<never> {
    return Promise.reject(new ModelUnavailableError());
  }
}

/**
 * Deterministic fake for service/domain integration tests.  It only returns a
 * suggestion envelope; it never receives a ProjectData reference and cannot
 * mutate canonical content.
 */
export class DeterministicModelAdapter implements ModelAdapter {
  analyze(request: ModelRequest): Promise<{
    type: SuggestionType;
    title: string;
    description: string;
    evidence_refs: JsonValue[];
    proposed_changes: ChangePatch[];
  }[]> {
    const evidence = request.selected_context.map((item) => ({
      source_type: item.source_type,
      source_id: item.source_id,
      label: item.label,
    })) as unknown as JsonValue[];
    return Promise.resolve([{
      type: "rewrite",
      title: "确定性测试建议",
      description: request.selected_context.length > 0
        ? `基于已选择的 ${request.selected_context.length} 项上下文生成建议`
        : "没有可分析的上下文",
      evidence_refs: evidence,
      proposed_changes: structuredClone(request.proposed_changes ?? []),
    }]);
  }
}

export interface AnalyzeSuggestionsInput {
  purpose: string;
  target_content_item_id?: string | null;
  context_pack_id: string;
  /** Must be exactly the sources the user checked in the Context Pack. */
  selected_context: ExplicitContextItem[];
  proposed_changes?: ChangePatch[];
}

export interface AnalyzeSuggestionsResult {
  request: ModelRequest;
  suggestions: Suggestion[];
}

/**
 * Execute the safe half of the AI pipeline.  The only canonical writes here
 * are pending Suggestion rows; blocks remain untouched until Diff + Apply.
 */
export async function analyzeForSuggestions(
  data: ProjectData,
  adapter: ModelAdapter,
  input: AnalyzeSuggestionsInput,
): Promise<AnalyzeSuggestionsResult> {
  const pack = data.context_packs.find((candidate) =>
    candidate.id === input.context_pack_id
  );
  assert(pack, `找不到上下文包: ${input.context_pack_id}`);
  assert(pack.project_id === data.project.id, "上下文包不属于当前项目");
  const target = input.target_content_item_id ?? pack.target_content_item_id;
  if (target !== null && target !== undefined) {
    assert(
      data.content_items.some((item) =>
        item.id === target && item.project_id === data.project.id
      ),
      "建议目标内容不存在",
    );
  }
  const packItems = data.context_pack_items.filter((item) =>
    item.context_pack_id === pack.id
  );
  assert(
    input.selected_context.length === packItems.length,
    "AI 上下文必须与已选择的来源一致",
  );
  assert(
    new Set(
      input.selected_context.map((item) =>
        `${item.source_type}:${item.source_id}`
      ),
    ).size === packItems.length,
    "AI 上下文来源不能重复",
  );
  for (const [index, selected] of input.selected_context.entries()) {
    const stored = packItems.find((item) =>
      item.source_type === selected.source_type &&
      item.source_id === selected.source_id
    );
    assert(stored, `AI 上下文来源未在勾选列表中: ${selected.source_id}`);
    assert(stored!.label === selected.label, "AI 上下文标签已变化，请重新预览");
    assert(
      await sha256(selected.content) === stored!.content_hash,
      `AI 上下文内容已变化: ${selected.source_id}`,
    );
    void index;
  }
  const request: ModelRequest = {
    purpose: input.purpose,
    target_content_item_id: target ?? null,
    selected_context: structuredClone(input.selected_context),
    proposed_changes: structuredClone(input.proposed_changes ?? []),
  };
  const responses = await adapter.analyze(request);
  const suggestions: Suggestion[] = [];
  for (const response of responses) {
    assert(
      response && typeof response.title === "string" &&
        typeof response.description === "string",
      "模型返回的建议格式无效",
    );
    assert(
      target !== null && target !== undefined,
      "结构建议必须先指定目标内容",
    );
    suggestions.push(createSuggestion(data, {
      target_content_item_id: target,
      context_pack_id: pack.id,
      type: response.type,
      title: response.title,
      description: response.description,
      evidence_refs: response.evidence_refs,
      model_metadata: {
        adapter: adapter.constructor.name,
        proposed_changes:
          (response.proposed_changes ?? []) as unknown as JsonValue,
      },
    }));
  }
  return { request, suggestions };
}

/** Convert a reviewed model envelope into a ChangeDraft without touching body data. */
export function acceptSuggestedChanges(
  data: ProjectData,
  suggestionId: string,
): ChangeDraft {
  const suggestion = data.suggestions.find((candidate) =>
    candidate.id === suggestionId
  );
  assert(suggestion, `找不到建议: ${suggestionId}`);
  const proposed = suggestion.model_metadata.proposed_changes;
  assert(Array.isArray(proposed), "建议没有可审核的修改");
  return acceptSuggestion(
    data,
    suggestionId,
    proposed as unknown as ChangePatch[],
  );
}

export interface ConversationConnector {
  check_login(): Promise<boolean>;
  list_conversations(): Promise<unknown[]>;
  get_conversation(externalId: string): Promise<unknown>;
  get_metadata(): Promise<Record<string, unknown>>;
  sync(): Promise<void>;
}

export function createSuggestion(
  data: ProjectData,
  input: {
    target_content_item_id: string;
    context_pack_id: string;
    type: SuggestionType;
    title: string;
    description: string;
    evidence_refs?: JsonValue[];
    model_metadata?: Record<string, JsonValue>;
  },
): Suggestion {
  assert(
    data.content_items.some((item) =>
      item.id === input.target_content_item_id &&
      item.project_id === data.project.id
    ),
    "建议目标内容不存在",
  );
  const pack = data.context_packs.find((candidate) =>
    candidate.id === input.context_pack_id
  );
  assert(pack, "建议引用的上下文不存在");
  assert(pack.project_id === data.project.id, "建议上下文不属于当前项目");
  assert(
    data.context_pack_items.some((item) => item.context_pack_id === pack.id),
    "建议上下文不能为空",
  );
  assert(
    pack.target_content_item_id === null ||
      pack.target_content_item_id === input.target_content_item_id,
    "建议目标与上下文目标不匹配",
  );
  const suggestion: Suggestion = {
    id: id(),
    target_content_item_id: input.target_content_item_id,
    context_pack_id: input.context_pack_id,
    type: input.type,
    title: input.title,
    description: input.description,
    evidence_refs: input.evidence_refs ?? [],
    status: "pending",
    model_metadata: input.model_metadata ?? {},
    created_at: now(),
    reviewed_at: null,
  };
  data.suggestions.push(suggestion);
  touchProject(data);
  return suggestion;
}

export function ignoreSuggestion(
  data: ProjectData,
  suggestionId: string,
): Suggestion {
  const suggestion = data.suggestions.find((candidate) =>
    candidate.id === suggestionId
  );
  assert(suggestion, `找不到建议: ${suggestionId}`);
  assert(suggestion.status === "pending", "只有待处理建议可以忽略");
  suggestion.status = "ignored";
  suggestion.reviewed_at = now();
  touchProject(data);
  return suggestion;
}

export function acceptSuggestion(
  data: ProjectData,
  suggestionId: string,
  proposedChanges: ChangePatch[],
): ChangeDraft {
  const suggestion = data.suggestions.find((candidate) =>
    candidate.id === suggestionId
  );
  assert(suggestion, `找不到建议: ${suggestionId}`);
  assert(suggestion.status === "pending", "只有待处理建议可以接受");
  assert(proposedChanges.length > 0, "建议必须包含至少一项修改");
  const target = suggestion.target_content_item_id;
  for (const patch of proposedChanges) {
    const block = data.blocks.find((candidate) =>
      candidate.id === patch.block_id
    );
    assert(block, `修改目标正文区块不存在: ${patch.block_id}`);
    const document = data.documents.find((candidate) =>
      candidate.id === block.document_id
    );
    assert(
      document?.content_item_id === target,
      "修改目标正文区块与建议内容不匹配",
    );
  }
  assert(
    new Set(proposedChanges.map((patch) => patch.block_id)).size ===
      proposedChanges.length,
    "同一修改草稿不能重复修改正文区块",
  );
  const baseRevision = documentRevision(
    data,
    suggestion.target_content_item_id,
  );
  suggestion.status = "accepted";
  suggestion.reviewed_at = now();
  const draft: ChangeDraft = {
    id: id(),
    suggestion_id: suggestion.id,
    target_content_item_id: suggestion.target_content_item_id,
    base_revision: baseRevision,
    proposed_changes: structuredClone(proposedChanges),
    diff: proposedChanges.map((patch) => ({
      block_id: patch.block_id,
      before: patch.before,
      after: patch.after,
    })) as unknown as JsonValue,
    status: "draft",
    created_at: now(),
    applied_at: null,
  };
  data.change_drafts.push(draft);
  touchProject(data);
  return draft;
}

export function reviewChangeDraft(
  data: ProjectData,
  changeDraftId: string,
): ChangeDraft {
  const draft = data.change_drafts.find((candidate) =>
    candidate.id === changeDraftId
  );
  assert(draft, `找不到修改草稿: ${changeDraftId}`);
  assert(draft.status === "draft", "修改草稿当前不可进入审核");
  draft.status = "reviewing";
  touchProject(data);
  return draft;
}

/** Apply only after a UI/user confirmation and against the same base revision. */
export function applyChangeDraft(
  data: ProjectData,
  changeDraftId: string,
  input: { confirmed: boolean; patch_ids?: string[] },
): ChangeDraft {
  const draft = data.change_drafts.find((candidate) =>
    candidate.id === changeDraftId
  );
  assert(draft, `找不到修改草稿: ${changeDraftId}`);
  assert(draft.status === "reviewing", "修改草稿必须先经过 Diff 审核");
  assert(input.confirmed === true, "应用正文必须有明确确认");
  assert(
    documentRevision(data, draft.target_content_item_id) ===
      draft.base_revision,
    "正文已变化，请重新生成 Diff",
  );
  const selected = input.patch_ids
    ? draft.proposed_changes.filter((patch) =>
      input.patch_ids!.includes(patch.block_id)
    )
    : draft.proposed_changes;
  assert(selected.length > 0, "至少确认一项修改");
  for (const patch of selected) {
    const block = data.blocks.find((candidate) =>
      candidate.id === patch.block_id
    );
    assert(block, `修改目标正文区块不存在: ${patch.block_id}`);
    const document = data.documents.find((candidate) =>
      candidate.id === block.document_id
    );
    assert(
      document?.content_item_id === draft.target_content_item_id,
      "修改目标正文区块与草稿内容不匹配",
    );
    if (patch.before !== null) {
      assert(
        JSON.stringify(block.content) === JSON.stringify(patch.before),
        "修改前正文与当前正文不一致",
      );
    }
  }
  // Validate every selected patch before mutating any block. A failed patch
  // must not leave earlier patches from the same confirmation half-applied.
  for (const patch of selected) {
    updateBlockContent(data, patch.block_id, patch.after);
  }
  const remaining = draft.proposed_changes.filter((patch) =>
    !selected.includes(patch)
  );
  if (remaining.length > 0) {
    const residual: ChangeDraft = {
      id: id(),
      suggestion_id: draft.suggestion_id,
      target_content_item_id: draft.target_content_item_id,
      base_revision: documentRevision(data, draft.target_content_item_id),
      proposed_changes: remaining,
      diff: remaining.map((patch) => ({
        block_id: patch.block_id,
        before: patch.before,
        after: patch.after,
      })) as unknown as JsonValue,
      status: "draft",
      created_at: now(),
      applied_at: null,
    };
    data.change_drafts.push(residual);
    draft.proposed_changes = selected;
    draft.diff = selected.map((patch) => ({
      block_id: patch.block_id,
      before: patch.before,
      after: patch.after,
    })) as unknown as JsonValue;
  }
  draft.status = "applied";
  draft.applied_at = now();
  touchProject(data);
  return draft;
}
