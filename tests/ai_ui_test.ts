/**
 * AI workflow UI tests (V0-T03, Workstream D).
 *
 * These drive the real `WorkbenchStore` over the real `app/ai.js` core with an
 * injected bridge, so every AI step is checked against canonical project data:
 * a run may only add canonical AI rows, and applying a draft must be atomic,
 * undoable and refused when the underlying content moved.
 *
 * No network is used: the default provider is the offline deterministic
 * connector, and the provider / credential / execution storage is answered by
 * an in-memory fake bridge.
 */
import {
  FakeAiConnector,
  HttpAiConnector,
  aiChangeDraftDiffRows,
} from "../app/ai.js";
import { createEmptyProjectData } from "../src/domain/index.ts";
import { validateProjectData } from "../src/domain/store.ts";
import type { ProjectData } from "../src/domain/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let importCounter = 0;

interface BridgeCall {
  command: string;
  input: Record<string, any>;
}

/** The failure shape `DesktopBridge.bridgeError` constructs. */
interface BridgeFailure {
  code: string;
  message: string;
  details: Record<string, any>;
  recoverable: boolean;
  recommended_action: string | null;
}

/** The slice of the running store these tests need. */
interface AiStore {
  data: ProjectData;
  ui: Record<string, any>;
  saveStatus: string;
  history: Array<{ label: string }>;
  future: unknown[];
  bridge: {
    projectDir: string | null;
    isNative: () => boolean;
    bridgeError: (value: unknown, fallback?: string) => BridgeFailure;
    reloadExternalProject?: () => Promise<unknown>;
    clearRecoveryJournal?: () => Promise<unknown>;
  };
  commit: (label: string, mutation: (data: ProjectData) => void) => void;
  currentItem: () => ProjectData["content_items"][number] | null;
  blocks: (item?: unknown) => ProjectData["blocks"];
  flush: () => Promise<unknown>;
  newProject: (title?: string, projectDir?: string) => Promise<void>;
  loadProjectPayload: (value: unknown) => void;
  resolveExternalConflict: (action: string) => Promise<void>;
  resetAiState: () => void;
  addMapItem: (title?: string) => void;
  addBlock: (type?: string, content?: string, atIndex?: number) => void;
  editBlockText: (id: string, value: string) => void;
  openItem: (id: string) => void;
  selectBlock: (id: string, options?: Record<string, unknown>) => void;
  undo: () => void;
  redo: () => void;
  notify: () => void;
  initialize: () => Promise<void>;
  aiDescriptor: () => Record<string, any>;
  aiModel: () => string;
  aiConnector: () => unknown;
  aiSetScope: (scope: string) => void;
  aiToggleContext: (key: string) => void;
  aiToggleChanges: () => void;
  aiSetProvider: (id: string) => void;
  aiEditProvider: (id: string) => void;
  aiSaveProvider: (input: Record<string, any>) => Promise<boolean>;
  aiSaveSecret: (value: string) => Promise<boolean>;
  aiDeleteSecret: () => Promise<boolean>;
  aiPreviewContext: () => void;
  aiRun: () => Promise<void>;
  aiCancel: () => Promise<boolean>;
  aiOpenDraft: (id: string) => void;
  aiApplyDraft: (id?: string) => boolean;
  aiRejectDraft: (id?: string) => boolean;
  aiDismissDraft: () => void;
  aiLoadProviders: () => Promise<unknown[]>;
  aiLoadExecutions: () => Promise<unknown[]>;
  aiStorageLabel: () => string;
  aiCapabilities: () => { tools: unknown[]; mcp: unknown[]; skills: unknown[] };
  aiRecordExecution: (record: Record<string, any>) => Promise<unknown>;
  refreshAiSideFiles: () => void;
  session: () => Record<string, any>;
  restoreSession: (session?: Record<string, any> | null) => Promise<void>;
  saveTimer: number;
}

/** Poll until `predicate` holds; the AI run is asynchronous by design. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待超时：${label}`);
}

/** Boot a fresh WorkbenchStore over an isolated in-memory project. */
async function bootStore(options: { executionWritesFail?: boolean } = {}) {
  const source = createEmptyProjectData("AI UI 测试");
  const state = {
    project: structuredClone(source) as ProjectData,
    writes: 0,
    sessions: [] as unknown[],
    providers: [] as Array<Record<string, any>>,
    secrets: new Map<string, string>(),
    executions: [] as Array<Record<string, any>>,
    executionWritesFail: options.executionWritesFail === true,
    /** When true, `ai.secret.set` claims success but stores nothing. */
    dropSecretWrites: false,
    calls: [] as BridgeCall[],
    completions: [] as BridgeCall[],
    cancels: [] as string[],
    completeResult: null as unknown,
    /** When set, `ai.complete` rejects through the real `bridgeError` path. */
    completeError: null as unknown,
    pendingComplete: false,
    releaseComplete: null as null | ((value: unknown) => void),
  };
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {},
    dataset: {},
  };
  const runtime = globalThis as typeof globalThis & {
    document?: unknown;
    __TAURI__?: unknown;
    __workbench?: unknown;
    __workbenchReady?: unknown;
  };
  const previousDocument = runtime.document;
  const previousTauri = runtime.__TAURI__;
  const previousWorkbench = runtime.__workbench;
  const previousReady = runtime.__workbenchReady;
  const previousFetch = globalThis.fetch;
  runtime.document = {
    querySelector: () => root,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  runtime.__TAURI__ = undefined;
  globalThis.fetch = async () => {
    throw new Error("test fetch disabled");
  };
  /**
   * In-memory stand-in for the native / service AI commands: providers,
   * credential *presence* and the execution log never touch the network.
   */
  let bridgeFailure = (value: unknown) => value;
  const command = async (name: string, input: Record<string, any> = {}) => {
    const call = { command: name, input: structuredClone(input) };
    state.calls.push(call);
    switch (name) {
      case "ai.connection.list":
        return {
          providers: structuredClone(state.providers),
          configured: Object.fromEntries(
            [...state.secrets.keys()].map((id) => [id, true]),
          ),
        };
      case "ai.connection.save": {
        const provider = structuredClone(input.provider);
        const index = state.providers.findIndex((entry) =>
          entry.id === provider.id
        );
        if (index >= 0) state.providers.splice(index, 1, provider);
        else state.providers.push(provider);
        return { provider };
      }
      case "ai.connection.delete": {
        const providerId = String(input.provider_id || "");
        state.providers = state.providers.filter((entry) =>
          entry.id !== providerId
        );
        state.secrets.delete(providerId);
        return { provider_id: providerId, removed: true };
      }
      case "ai.secret.set":
        if (!state.dropSecretWrites) {
          state.secrets.set(String(input.provider_id), String(input.value));
        }
        // A broken keychain write still reports success at the CLI boundary;
        // only reading the credential back tells the truth.
        return { provider_id: input.provider_id, configured: true };
      case "ai.secret.delete":
        state.secrets.delete(String(input.provider_id));
        return { provider_id: input.provider_id, removed: true };
      case "ai.complete": {
        state.completions.push(call);
        // A shell failure rejects exactly like `DesktopBridge.invoke` does:
        // through `bridgeError`, so the error shape is the real one.
        if (state.completeError) throw bridgeFailure(state.completeError);
        if (state.pendingComplete) {
          return await new Promise((resolve) => {
            state.releaseComplete = resolve;
          });
        }
        return state.completeResult;
      }
      case "ai.cancel":
        state.cancels.push(String(input.request_id));
        return { cancelled: true };
      case "ai.execution.append": {
        if (state.executionWritesFail) {
          throw new Error("执行记录文件不可写（测试）");
        }
        // Both shells upsert by record id: replacing a row in place is what lets
        // a review decision update its run instead of adding a second row.
        const record = structuredClone(input.record);
        const recordId = record && typeof record.id === "string" ? record.id : "";
        const index = recordId
          ? state.executions.findIndex((entry) => entry.id === recordId)
          : -1;
        if (index >= 0) state.executions.splice(index, 1, record);
        else state.executions.push(record);
        return { id: recordId || "record" };
      }
      case "ai.execution.list":
        return { records: structuredClone(state.executions.slice().reverse()) };
      default:
        throw new Error(`未实现的桥命令：${name}`);
    }
  };
  importCounter += 1;
  await import(`../app/main.js?ai-ui-${importCounter}`);
  // The module boots its own store and wires `render()` to it, so the tests
  // drive that store and swap its persistence / AI commands for the in-memory
  // fake above.  Awaiting the module's boot promise guarantees nothing will
  // replace `store.data` after the fixture is seeded.
  const store = runtime.__workbench as unknown as AiStore;
  assert(store && typeof store === "object", "模块必须暴露运行中的工作台");
  const bridgeTarget = store.bridge as unknown as Record<string, unknown>;
  bridgeTarget.projectDir = null;
  bridgeTarget.projectDirFromUrl = false;
  bridgeTarget.isNative = () => false;
  bridgeTarget.currentProject = () => state.project;
  bridgeTarget.loadSession = async () => null;
  bridgeTarget.readProject = async () => structuredClone(state.project);
  bridgeTarget.readRecoveryJournal = async () => null;
  bridgeTarget.listenNativeDrops = async () => () => {};
  bridgeTarget.writeRecoveryJournal = async () => {};
  bridgeTarget.clearRecoveryJournal = async () => {};
  bridgeTarget.saveSession = async (session: unknown) => {
    state.sessions.push(session);
  };
  bridgeTarget.createSnapshot = async () => ({});
  bridgeTarget.setProjectDir = () => {};
  bridgeTarget.restoreProjectDir = () => {};
  bridgeTarget.projectIdentity = async () => state.project.project.id;
  bridgeTarget.writeProject = async (project: ProjectData) => {
    state.writes += 1;
    state.project = structuredClone(project);
  };
  bridgeTarget.command = command;
  bridgeFailure = (value: unknown) => store.bridge.bridgeError(value);
  await (runtime as { __workbenchReady?: Promise<void> }).__workbenchReady;
  // Settle the side files deterministically (the boot used the real bridge).
  store.ui.toast = "";
  store.ui.aiError = null;
  await store.aiLoadProviders();
  await store.aiLoadExecutions();
  return {
    store,
    state,
    root,
    restore: () => {
      runtime.document = previousDocument;
      runtime.__TAURI__ = previousTauri;
      runtime.__workbench = previousWorkbench;
      runtime.__workbenchReady = previousReady;
      globalThis.fetch = previousFetch;
      clearTimeout(store.saveTimer);
    },
  };
}

/** Two lessons with one paragraph each, built through the real store API. */
function seedCourse(store: AiStore) {
  store.addMapItem("第一课");
  const first = store.currentItem();
  store.addBlock("paragraph", "第一课的正文");
  store.addMapItem("第二课");
  const second = store.currentItem();
  store.addBlock("paragraph", "第二课的正文");
  assert(first && second, "测试夹具必须包含两节课");
  store.openItem(first.id);
  return { first, second, block: store.blocks(first)[0]! };
}

const REPLACEMENT = "AI 改写后的正文";
const REPLACE_REASON = "让表达更直接";

/** A store whose offline connector answers with one replace_block change. */
async function bootWithChange(options: { executionWritesFail?: boolean } = {}) {
  const booted = await bootStore(options);
  const { first, block } = seedCourse(booted.store);
  booted.store.aiConnector = () =>
    new FakeAiConnector({
      changes: [{
        op: "replace_block",
        block_id: block.id,
        content: REPLACEMENT,
        reason: REPLACE_REASON,
      }],
    });
  booted.store.ui.aiInstruction = "请帮我看看这一段";
  booted.store.aiToggleChanges();
  await booted.store.aiRun();
  return { ...booted, first, blockId: block.id };
}

Deno.test("the default provider is the offline connector and a run only adds a suggestion", async () => {
  const { store, state, restore } = await bootStore();
  try {
    seedCourse(store);
    store.ui.rightPanel = "assistant";
    const blocksBefore = JSON.stringify(store.data.blocks);
    assert(store.ui.aiProviderId === "fake", "默认服务商必须是离线确定性连接器");
    const descriptor = store.aiDescriptor();
    assert(descriptor.id === "fake" && descriptor.kind === "fake", "默认描述符必须是离线连接器");
    assert(
      store.aiConnector() instanceof FakeAiConnector,
      "默认服务商必须构造离线连接器，而不是 HTTP 连接器",
    );
    store.ui.aiInstruction = "请解释这一段";
    await store.aiRun();
    assert(store.ui.aiStatus === "done", "运行必须成功结束");
    assert(
      String(store.ui.aiResult?.answer || "").includes("本地确定性连接器"),
      "回答必须来自离线确定性连接器",
    );
    assert(store.data.suggestions.length === 1, "必须生成一条 canonical 建议");
    assert(store.data.change_drafts.length === 0, "纯解释请求不得生成修改草稿");
    assert(store.data.context_packs.length === 1, "成功运行必须恰好写入一个上下文包");
    assert(store.data.context_pack_items.length > 0, "上下文包必须带上条目");
    assert(
      store.ui.aiResult?.suggestion_id === store.data.suggestions[0]!.id,
      "回答必须指向刚生成的建议",
    );
    assert(
      JSON.stringify(store.data.blocks) === blocksBefore,
      "一次纯解释运行不得改动任何正文",
    );
    assert(state.executions.length === 1, "必须留下一条执行记录");
    assert(
      state.executions[0]!.status === "succeeded" &&
        state.executions[0]!.outcome === "suggestion",
      "执行记录必须如实记录状态与产出",
    );
    assert(validateProjectData(store.data).length === 0, "项目必须仍然通过 canonical 校验");
  } finally {
    restore();
  }
});

Deno.test("a run with changes produces a reviewable ChangeDraft rendered from the real diff rows", async () => {
  const { store, root, blockId, restore } = await bootWithChange();
  try {
    assert(store.ui.aiWantsChanges === true, "「要求修改课程」必须记录到 UI 状态");
    assert(store.data.change_drafts.length === 1, "带 changes 的回答必须生成修改草稿");
    const draft = store.data.change_drafts[0]!;
    assert(store.ui.aiDraftId === draft.id, "面板必须指向刚生成的草稿");
    assert(draft.status === "reviewing", "新草稿必须处于待审核状态");
    assert(
      store.data.blocks.find((block) => block.id === blockId)!.content ===
        "第一课的正文",
      "生成草稿本身不得改动正文",
    );
    assert(
      store.ui.aiResult?.change_draft_id === draft.id &&
        store.ui.aiResult?.outcome === "change_draft",
      "运行结果必须如实报告产出的是修改草稿",
    );

    const rows = aiChangeDraftDiffRows(store.data, draft.id);
    assert(rows.length === 1 && rows[0]!.op === "replace_block", "必须生成一条替换 diff 行");
    store.ui.rightPanel = "assistant";
    store.notify();
    assert(
      root.innerHTML.includes(rows[0]!.label),
      "面板必须渲染 aiChangeDraftDiffRows 生成的行标签",
    );
    assert(root.innerHTML.includes("修改前") && root.innerHTML.includes("修改后"), "Diff 必须左右并列");
    assert(root.innerHTML.includes("第一课的正文"), "Diff 必须显示原文");
    assert(root.innerHTML.includes(REPLACEMENT), "Diff 必须显示新正文");
    assert(root.innerHTML.includes(REPLACE_REASON), "Diff 必须显示每条修改的理由");
    assert(root.innerHTML.includes("应用这些修改"), "Diff 必须提供应用入口");
    assert(root.innerHTML.includes("拒绝"), "Diff 必须提供拒绝入口");
  } finally {
    restore();
  }
});

Deno.test("rejecting a draft leaves content byte-identical and flips the draft to discarded", async () => {
  const { store, restore } = await bootWithChange();
  try {
    const draftId = store.ui.aiDraftId;
    const blocksBefore = JSON.stringify(store.data.blocks);
    const requirementsBefore = JSON.stringify(store.data.requirements);
    assert(store.aiRejectDraft(draftId) === true, "拒绝必须成功");
    const draft = store.data.change_drafts.find((candidate) => candidate.id === draftId)!;
    assert(draft.status === "discarded", "拒绝必须把草稿标记为已拒绝");
    assert(
      JSON.stringify(store.data.blocks) === blocksBefore,
      "拒绝必须让正文逐字节不变",
    );
    assert(
      JSON.stringify(store.data.requirements) === requirementsBefore,
      "拒绝必须让待补逐字节不变",
    );
    assert(store.ui.aiDraftId === null, "拒绝后面板不再显示这份 Diff");
    await until(
      () =>
        store.ui.aiExecutions.some((record: Record<string, any>) =>
          record.change_draft_id === draftId && record.review?.state === "rejected"
        ),
      "执行历史必须留下拒绝决定",
    );
    assert(validateProjectData(store.data).length === 0, "项目必须仍然通过 canonical 校验");
  } finally {
    restore();
  }
});

Deno.test("applying a draft changes the block, commits once, and undo/redo round-trips", async () => {
  const { store, blockId, restore } = await bootWithChange();
  try {
    const draftId = store.ui.aiDraftId;
    const historyBefore = store.history.length;
    assert(store.aiApplyDraft(draftId) === true, "应用必须成功");
    assert(
      store.data.blocks.find((block) => block.id === blockId)!.content === REPLACEMENT,
      "应用必须把新正文写进 canonical 区块",
    );
    assert(
      store.data.change_drafts.find((candidate) => candidate.id === draftId)!.status === "applied",
      "应用后草稿必须标记为已应用",
    );
    assert(
      store.history.length === historyBefore + 1,
      "应用必须只推入一条历史记录",
    );
    assert(
      String(store.history.at(-1)?.label || "").includes("AI"),
      "历史记录必须标明这是 AI 应用",
    );
    assert(validateProjectData(store.data).length === 0, "应用后项目必须仍然通过 canonical 校验");
    await until(
      () =>
        store.ui.aiExecutions.some((record: Record<string, any>) =>
          record.change_draft_id === draftId && record.review?.state === "applied"
        ),
      "执行历史必须留下这次审核决定",
    );

    store.undo();
    assert(
      store.data.blocks.find((block) => block.id === blockId)!.content === "第一课的正文",
      "撤销必须恢复原始正文",
    );
    assert(
      store.data.change_drafts.find((candidate) => candidate.id === draftId)!.status === "reviewing",
      "撤销后草稿必须回到待审核",
    );
    store.redo();
    assert(
      store.data.blocks.find((block) => block.id === blockId)!.content === REPLACEMENT,
      "重做必须重新应用这份修改",
    );
    assert(validateProjectData(store.data).length === 0, "重做后项目必须仍然通过 canonical 校验");
  } finally {
    restore();
  }
});

Deno.test("a rejected draft updates its run's execution record instead of appending", async () => {
  const { store, state, restore } = await bootWithChange();
  try {
    const draftId = store.ui.aiDraftId;
    assert(state.executions.length === 1, "一次运行必须只写一条执行记录");
    const before = state.executions[0]!;
    assert(before.review?.state === "pending", "运行记录初始必须是待审核");
    assert(store.aiRejectDraft(draftId) === true, "拒绝必须成功");
    await until(
      () => state.executions.every((record) => record.review?.state === "rejected"),
      "拒绝决定必须写入执行记录",
    );
    assert(state.executions.length === 1, "拒绝必须更新原记录，而不是追加一条");
    const after = state.executions[0]!;
    assert(after.id === before.id, "更新必须保留原记录 id（两个壳都按 id upsert）");
    assert(after.created_at === before.created_at, "更新必须保留 created_at");
    assert(after.change_draft_id === draftId, "更新必须仍然指向这份草稿");
    assert(
      after.review.state === "rejected" && typeof after.review.decided_at === "string",
      "审核状态必须带上决定时间",
    );
    assert(
      store.ui.aiExecutions.filter((record: Record<string, any>) =>
        record.change_draft_id === draftId
      ).length === 1,
      "面板里同一次运行只能有一行",
    );
  } finally {
    restore();
  }
});

Deno.test("an applied draft updates its run's execution record instead of appending", async () => {
  const { store, state, restore } = await bootWithChange();
  try {
    const draftId = store.ui.aiDraftId;
    assert(state.executions.length === 1, "一次运行必须只写一条执行记录");
    const before = state.executions[0]!;
    assert(store.aiApplyDraft(draftId) === true, "应用必须成功");
    await until(
      () => state.executions.every((record) => record.review?.state === "applied"),
      "应用决定必须写入执行记录",
    );
    assert(state.executions.length === 1, "应用必须更新原记录，而不是追加一条");
    const after = state.executions[0]!;
    assert(after.id === before.id, "更新必须保留原记录 id（两个壳都按 id upsert）");
    assert(after.created_at === before.created_at, "更新必须保留 created_at");
    assert(after.scope?.kind === before.scope?.kind, "更新必须保留范围");
    assert(
      after.review.state === "applied" && typeof after.review.decided_at === "string",
      "审核状态必须带上决定时间",
    );
    assert(
      store.ui.aiExecutions.filter((record: Record<string, any>) =>
        record.change_draft_id === draftId
      ).length === 1,
      "面板里同一次运行只能有一行",
    );
  } finally {
    restore();
  }
});

Deno.test("a failed review-record write only warns and never changes the Apply result", async () => {
  const { store, state, blockId, restore } = await bootWithChange({ executionWritesFail: true });
  try {
    const draftId = store.ui.aiDraftId;
    store.saveStatus = "已保存";
    store.ui.toast = "";
    assert(store.aiApplyDraft(draftId) === true, "记录写入失败不得影响应用结果");
    assert(
      store.data.blocks.find((block) => block.id === blockId)!.content === REPLACEMENT,
      "正文必须已经应用",
    );
    await until(
      () => String(store.ui.toast).includes("执行记录"),
      "记录写入失败必须给出可见提示",
    );
    assert(store.saveStatus !== "保存失败", "记录写入失败不得影响课程保存状态");
    assert(state.executions.length === 0, "测试桥必须真的拒绝写入");
  } finally {
    restore();
  }
});

Deno.test("bridgeError keeps the recommended action the shells send", async () => {
  const { store, restore } = await bootStore();
  try {
    const failure = store.bridge.bridgeError({
      error: {
        code: "missing_credential",
        user_message: "这个 Provider 还没有配置 API Key。",
        recommended_action: "请在 AI 设置里为这个 Provider 填写 API Key。",
        details: { provider_id: "deepseek" },
        recoverable: true,
      },
    });
    assert(failure.code === "missing_credential", "必须保留服务端错误码");
    assert(failure.message === "这个 Provider 还没有配置 API Key。", "必须保留可读消息");
    assert(
      failure.recommended_action === "请在 AI 设置里为这个 Provider 填写 API Key。",
      "必须保留服务端给出的下一步动作，AI 面板才能说清怎么修",
    );
    assert(failure.details.provider_id === "deepseek", "必须保留结构化细节");
    assert(failure.recoverable === true, "可恢复标记必须保留");
    const bare = store.bridge.bridgeError({ error: { code: "unknown_thing", user_message: "出错了" } });
    assert(bare.recommended_action === null, "服务端没有给出建议时必须是 null，而不是残留旧值");
  } finally {
    restore();
  }
});

Deno.test("a shell failure carries its recommended action all the way to the panel", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    seedCourse(store);
    state.providers = [{
      id: "custom",
      label: "自定义（OpenAI 兼容）",
      base_url: "https://api.example.test/v1",
      default_model: "demo-model",
      models: ["demo-model"],
    }];
    await store.aiLoadProviders();
    store.ui.aiProviderId = "custom";
    store.ui.aiInstruction = "请解释这一段";
    const before = JSON.stringify(store.data);
    state.completeError = {
      error: {
        code: "missing_credential",
        user_message: "这个 Provider 还没有配置 API Key。",
        recommended_action: "请在 AI 设置里为这个 Provider 填写 API Key。",
        details: { provider_id: "custom" },
        recoverable: true,
      },
    };
    await store.aiRun();
    assert(store.ui.aiError?.code === "missing_credential", "shell 错误码必须一路保留");
    assert(
      store.ui.aiError?.recommended_action === "请在 AI 设置里为这个 Provider 填写 API Key。",
      "shell 给出的下一步动作必须到达面板，而不是被替换成通用文案",
    );
    assert(JSON.stringify(store.data) === before, "失败不得改动 canonical 数据");
    store.ui.rightPanel = "assistant";
    store.notify();
    assert(
      root.innerHTML.includes("请在 AI 设置里为这个 Provider 填写 API Key。"),
      "面板必须渲染这条动作",
    );
  } finally {
    restore();
  }
});

Deno.test("a run that cannot build its ChangeDraft writes nothing at all", async () => {
  const { store, state, restore } = await bootStore();
  try {
    const { second, block } = seedCourse(store);
    // The connector answers about a block that lives in the *previous* lesson,
    // so `createAiChangeDraft` rejects after `createAiSuggestion` succeeded —
    // the exact shape that used to leave an orphaned Suggestion behind.
    store.aiConnector = () =>
      new FakeAiConnector({
        changes: [{
          op: "replace_block",
          block_id: block.id,
          content: "越界改写",
          reason: "测试跨课修改",
        }],
      });
    store.ui.aiInstruction = "请帮我看看这一段";
    store.ui.aiWantsChanges = true;
    store.openItem(second.id);
    await store.flush();
    const dataBefore = JSON.stringify(store.data);
    const diskBefore = structuredClone(state.project);
    const historyBefore = store.history.length;
    await store.aiRun();
    assert(store.ui.aiError?.code === "invalid_request", "跨课修改必须报 invalid_request");
    assert(store.ui.aiStatus === "failed", "运行必须明确失败");
    assert(
      JSON.stringify(store.data) === dataBefore,
      "失败的运行必须让 canonical 数据逐字节不变（不得留下半写入）",
    );
    assert(store.history.length === historyBefore, "失败的运行不得推入历史记录");
    for (const key of ["context_packs", "context_pack_items", "suggestions", "change_drafts"]) {
      assert(
        (store.data as unknown as Record<string, unknown[]>)[key]!.length === 0,
        `失败的运行不得留下 ${key}`,
      );
    }
    assert(store.ui.aiDraftId === null && store.ui.aiResult === null, "失败不得留下可审核结果");
    await store.flush();
    const diskAfter = state.project as unknown as Record<string, unknown>;
    for (
      const key of [
        "blocks",
        "requirements",
        "context_packs",
        "context_pack_items",
        "suggestions",
        "change_drafts",
      ]
    ) {
      assert(
        JSON.stringify(diskAfter[key]) ===
          JSON.stringify((diskBefore as unknown as Record<string, unknown>)[key]),
        `失败的运行不得把 ${key} 写进磁盘`,
      );
    }
  } finally {
    restore();
  }
});

Deno.test("the panel discloses that no Tool, MCP or Skill is called", async () => {
  const { store, root, restore } = await bootStore();
  try {
    seedCourse(store);
    const capabilities = store.aiCapabilities();
    assert(
      capabilities.tools.length === 0 && capabilities.mcp.length === 0 &&
        capabilities.skills.length === 0,
      "V0 的执行记录必须如实声明没有调用任何 Tool / MCP / Skill",
    );
    store.ui.rightPanel = "assistant";
    store.notify();
    assert(
      root.innerHTML.includes("不会调用任何 Tool、MCP 或 Skill"),
      "面板必须如实披露不会调用额外能力",
    );
  } finally {
    restore();
  }
});

Deno.test("the panel names the AI storage location of the running shell", async () => {
  const { store, root, restore } = await bootStore();
  try {
    seedCourse(store);
    store.ui.rightPanel = "assistant";
    store.bridge.isNative = () => false;
    store.notify();
    assert(
      root.innerHTML.includes("macOS 系统钥匙串（本机浏览器服务）"),
      "浏览器壳必须说明密钥写入 macOS 系统钥匙串",
    );
    assert(!root.innerHTML.includes("本项目目录的 .workspace/ai"), "浏览器壳不得声称密钥在项目文件");
    assert(root.innerHTML.includes("项目文件只保留服务商元数据"), "必须说明项目文件不保存密钥");
    store.bridge.isNative = () => true;
    store.notify();
    assert(
      root.innerHTML.includes("macOS 系统钥匙串"),
      "桌面壳必须说明密钥写入 macOS 系统钥匙串",
    );
    assert(
      !root.innerHTML.includes("本机应用数据目录") &&
        !root.innerHTML.includes("本项目目录的 .workspace/ai"),
      "桌面壳不得声称密钥在项目文件",
    );
    assert(root.innerHTML.includes("项目文件只保留服务商元数据"), "必须说明项目文件不保存密钥");
  } finally {
    restore();
  }
});

Deno.test("the execution history only shows the current project's runs", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    seedCourse(store);
    const projectId = store.data.project.id;
    state.executions = [
      {
        id: "other-project-run",
        project_id: "another-project",
        created_at: "2026-01-01T00:00:00.000Z",
        status: "succeeded",
        outcome: "change_draft",
        review: { state: "pending" },
      },
      {
        id: "this-project-run",
        project_id: projectId,
        created_at: "2026-01-02T00:00:00.000Z",
        status: "succeeded",
        outcome: "suggestion",
        review: { state: "pending" },
      },
    ];
    await store.aiLoadExecutions();
    assert(store.ui.aiExecutions.length === 1, "面板只能显示当前项目的执行记录");
    assert(store.ui.aiExecutions[0].id === "this-project-run", "必须保留本项目那条记录");
    store.ui.aiExecutionsOpen = true;
    store.ui.rightPanel = "assistant";
    store.notify();
    assert(
      !root.innerHTML.includes("another-project"),
      "别的项目的执行记录绝不能出现在面板里",
    );
    assert(root.innerHTML.includes("执行记录（1）"), "计数必须只算本项目的记录");
  } finally {
    restore();
  }
});

Deno.test("a successful run writes exactly one ContextPack, Suggestion and ChangeDraft", async () => {
  const { store, blockId, restore } = await bootWithChange();
  try {
    assert(store.data.context_packs.length === 1, "成功运行必须恰好写入一个上下文包");
    assert(store.data.context_pack_items.length > 0, "上下文包必须带上条目");
    assert(store.data.suggestions.length === 1, "成功运行必须恰好写入一条建议");
    assert(store.data.change_drafts.length === 1, "成功运行必须恰好写入一份修改草稿");
    assert(
      store.data.context_pack_items.every((item) =>
        item.context_pack_id === store.data.context_packs[0]!.id
      ),
      "上下文包条目必须属于这个上下文包",
    );
    assert(
      store.data.change_drafts[0]!.suggestion_id === store.data.suggestions[0]!.id,
      "修改草稿必须挂在这条建议上",
    );
    assert(
      store.data.blocks.find((block) => block.id === blockId)!.content === "第一课的正文",
      "生成这些行不得改动正文",
    );
    assert(validateProjectData(store.data).length === 0, "项目必须仍然通过 canonical 校验");
  } finally {
    restore();
  }
});

Deno.test("switching to another project clears the previous project's AI state", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    const { block } = seedCourse(store);
    store.aiConnector = () =>
      new FakeAiConnector({
        changes: [{
          op: "replace_block",
          block_id: block.id,
          content: REPLACEMENT,
          reason: REPLACE_REASON,
        }],
      });
    store.ui.aiInstruction = "请帮我看看这一段";
    store.ui.aiWantsChanges = true;
    await store.aiRun();
    assert(state.executions.length === 1, "P1 必须留下一条执行记录");
    const p1Record = state.executions[0]!;
    const p1Label = String(p1Record.scope?.label || "");
    assert(p1Label.length > 0, "P1 的执行记录必须带范围标签");
    assert(
      store.ui.aiContext !== null && store.ui.aiResult !== null &&
        store.ui.aiDraftId !== null,
      "P1 的 AI 状态必须非空",
    );
    store.ui.rightPanel = "assistant";
    store.notify();
    assert(root.innerHTML.includes(p1Label), "P1 的面板必须显示 P1 的范围标签");

    // Path 1: the ordinary "new project" switch.
    await store.newProject("P2");
    await store.aiLoadExecutions();
    assert(store.data.project.id !== p1Record.project_id, "必须已经切换到另一个项目");
    assert(store.ui.aiExecutions.length === 0, "切换项目后不得保留上一个项目的执行记录");
    assert(store.ui.aiContext === null, "切换项目必须清空 AI 上下文");
    assert(store.ui.aiDraftId === null, "切换项目必须清空 Diff 指针");
    assert(store.ui.aiResult === null, "切换项目必须清空上一次回答");
    assert(store.ui.aiError === null && store.ui.aiStatus === "idle", "切换项目必须清空状态与错误");
    store.ui.rightPanel = "assistant";
    store.notify();
    assert(!root.innerHTML.includes(p1Record.id), "面板不得渲染上一个项目的执行记录 id");
    assert(!root.innerHTML.includes(p1Label), "面板不得渲染上一个项目的范围标签");
    assert(root.innerHTML.includes("执行记录（0）"), "计数必须重新开始");

    // Path 2: loading a project payload (project file / import).
    state.executions.push({
      id: "p2-run",
      project_id: store.data.project.id,
      created_at: new Date().toISOString(),
      scope: { kind: "lesson", label: "P2-范围标记" },
      status: "succeeded",
      outcome: "answer",
      review: { state: "pending" },
    });
    await store.aiLoadExecutions();
    assert(store.ui.aiExecutions.length === 1, "P2 自己的执行记录必须显示");
    store.ui.aiExecutionsOpen = true;
    store.notify();
    assert(root.innerHTML.includes("P2-范围标记"), "P2 的面板必须显示 P2 自己的记录");
    assert(root.innerHTML.includes("执行记录（1）"), "P2 的计数必须是 1");
    store.loadProjectPayload(createEmptyProjectData("P4"));
    assert(store.ui.aiExecutions.length === 0, "载入新项目载荷必须清空上一个项目的执行记录");
    assert(
      store.ui.aiContext === null && store.ui.aiDraftId === null &&
        store.ui.aiResult === null,
      "载入新项目载荷必须清空 AI 状态",
    );
    store.notify();
    assert(!root.innerHTML.includes("P2-范围标记"), "面板不得渲染上一个项目的范围标记");
  } finally {
    restore();
  }
});

Deno.test("an external reload drops the AI state of the replaced project", async () => {
  const { store, state, restore } = await bootStore();
  try {
    const { block } = seedCourse(store);
    await store.flush();
    const cleanDisk = structuredClone(state.project);
    store.aiConnector = () =>
      new FakeAiConnector({
        changes: [{
          op: "replace_block",
          block_id: block.id,
          content: REPLACEMENT,
          reason: REPLACE_REASON,
        }],
      });
    store.ui.aiInstruction = "请帮我看看这一段";
    store.ui.aiWantsChanges = true;
    await store.aiRun();
    // A function call keeps TypeScript from narrowing the array across the
    // reload below.
    const draftCount = () => (store.data.change_drafts || []).length;
    assert(
      draftCount() === 1 && store.ui.aiDraftId !== null,
      "必须先有一份待审核的草稿",
    );
    store.bridge.reloadExternalProject = async () => structuredClone(cleanDisk);
    await store.resolveExternalConflict("reload");
    assert(draftCount() === 0, "重新载入必须采用磁盘版本");
    assert(store.ui.aiDraftId === null, "重新载入不得保留指向已消失草稿的指针");
    assert(
      store.ui.aiResult === null && store.ui.aiContext === null,
      "重新载入必须清空 AI 结果与上下文",
    );
    assert(store.ui.aiExecutionsOpen === false, "重新载入必须收起旧的执行记录面板");
  } finally {
    restore();
  }
});

Deno.test("an apply after the underlying content changed is refused and keeps the draft", async () => {
  const { store, blockId, restore } = await bootWithChange();
  try {
    const draftId = store.ui.aiDraftId;
    store.editBlockText(blockId, "人工改过的正文");
    const blocksBefore = JSON.stringify(store.data.blocks);
    const requirementsBefore = JSON.stringify(store.data.requirements);
    assert(store.aiApplyDraft(draftId) === false, "正文变化后必须拒绝应用");
    assert(
      JSON.stringify(store.data.blocks) === blocksBefore,
      "被拒绝的应用不得改动正文",
    );
    assert(
      JSON.stringify(store.data.requirements) === requirementsBefore,
      "被拒绝的应用不得改动待补",
    );
    const draft = store.data.change_drafts.find((candidate) => candidate.id === draftId)!;
    assert(draft.status === "reviewing", "被拒绝的应用必须保留草稿");
    assert(
      draft.validation?.ok === false && (draft.validation?.issues?.length || 0) > 0,
      "必须记录校验失败与原因，用户才能决定下一步",
    );
    assert(store.ui.aiDraftId === draftId, "被拒绝后仍应指向这份草稿以便重试");
    assert(
      String(store.ui.toast).includes("不能应用"),
      "必须给出可读的拒绝原因",
    );
    assert(validateProjectData(store.data).length === 0, "项目必须仍然通过 canonical 校验");
  } finally {
    restore();
  }
});

Deno.test("every fake connector failure leaves the project byte-identical", async () => {
  const scenarios: Array<[string, string]> = [
    ["timeout", "timeout"],
    ["provider_error", "provider_error"],
    ["rate_limit", "rate_limited"],
    ["malformed", "malformed_response"],
    ["missing_credential", "missing_credential"],
    ["permission_denied", "permission_denied"],
    ["cancelled", "cancelled"],
  ];
  for (const [scenario, expected] of scenarios) {
    const { store, restore } = await bootStore();
    try {
      seedCourse(store);
      const before = JSON.stringify(store.data);
      store.aiConnector = () => new FakeAiConnector({ scenario });
      store.ui.aiInstruction = "请解释这一段";
      await store.aiRun();
      assert(
        store.ui.aiError?.code === expected,
        `${scenario} 必须归一为 ${expected}，实际是 ${store.ui.aiError?.code}`,
      );
      assert(
        JSON.stringify(store.data) === before,
        `${scenario} 失败不得改动 canonical 数据`,
      );
      assert(
        store.data.suggestions.length === 0 && store.data.change_drafts.length === 0,
        `${scenario} 失败不得留下建议或草稿`,
      );
      assert(
        store.ui.aiStatus === (scenario === "cancelled" ? "cancelled" : "failed"),
        `${scenario} 必须给出终态`,
      );
      assert(
        String(store.ui.aiError?.recommended_action || "").length > 0,
        `${scenario} 必须告诉用户下一步做什么`,
      );
      assert(validateProjectData(store.data).length === 0, "项目必须仍然通过 canonical 校验");
    } finally {
      restore();
    }
  }
});

Deno.test("switching lessons drops the assembled AI context and its block", async () => {
  const { store, restore } = await bootStore();
  try {
    const { first, second, block } = seedCourse(store);
    store.openItem(first.id);
    store.selectBlock(block.id);
    store.aiSetScope("block");
    store.aiPreviewContext();
    assert(store.ui.aiContext !== null, "预览必须装配出上下文");
    assert(store.ui.aiBlockId === block.id, "区块范围必须绑定当前区块");
    assert(
      store.ui.aiContext.scope.content_item_id === first.id,
      "上下文必须绑定当前课次",
    );
    store.openItem(second.id);
    assert(store.ui.aiContext === null, "切换课次必须清空 AI 上下文");
    assert(store.ui.aiContextOpen === false, "切换课次必须收起旧预览");
    assert(store.ui.aiBlockId === null, "上一课的区块必须从 AI 范围里移除");
    assert(store.ui.selectedBlockId === null, "切换课次仍然清空正文选择");
    assert(store.ui.aiResult === null || typeof store.ui.aiResult === "object", "运行结果状态保持自洽");
  } finally {
    restore();
  }
});

Deno.test("a failed execution-record write only warns and never fails the save", async () => {
  const { store, state, restore } = await bootStore({ executionWritesFail: true });
  try {
    seedCourse(store);
    store.saveStatus = "已保存";
    store.ui.aiInstruction = "请解释这一段";
    await store.aiRun();
    assert(store.ui.aiStatus === "done", "记录写入失败不得让这次运行看起来失败");
    assert(store.data.suggestions.length === 1, "建议仍然必须写入 canonical 数据");
    assert(
      store.saveStatus !== "保存失败",
      "执行记录写入失败不得影响课程保存状态",
    );
    assert(
      String(store.ui.toast).includes("执行记录"),
      "必须给出可见的提示，说明记录没有写入",
    );
    assert(state.executions.length === 0, "测试桥必须真的拒绝写入");
  } finally {
    restore();
  }
});

Deno.test("the panel never renders a provider credential value", async () => {
  const credential = "sk-test-should-never-be-rendered-0001";
  const { store, state, root, restore } = await bootStore();
  try {
    seedCourse(store);
    state.providers = [{
      id: "custom",
      label: "自定义（OpenAI 兼容）",
      kind: "openai_compatible",
      base_url: "https://api.example.test/v1",
      default_model: "demo-model",
      models: ["demo-model"],
    }];
    await store.aiLoadProviders();
    assert(store.ui.aiConfigured.custom !== true, "初始状态必须是未配置密钥");
    store.aiSetProvider("custom");
    assert(store.ui.aiProviderId === "custom", "测试必须先选中要配置的服务商");
    assert(store.aiModel() === "demo-model", "切换服务商必须选中它的默认模型");
    await store.aiSaveSecret(credential);
    assert(
      state.secrets.get("custom") === credential,
      "密钥必须交给本机服务保存",
    );
    assert(
      store.ui.aiConfigured.custom === true,
      "保存成功后必须只记录「已配置」这一事实",
    );
    assert(
      !JSON.stringify(store.ui).includes(credential),
      "密钥绝不能进入 UI 状态",
    );
    store.ui.rightPanel = "assistant";
    store.aiEditProvider("custom");
    assert(root.innerHTML.includes("已配置密钥"), "面板必须说明密钥已配置");
    assert(
      !root.innerHTML.includes(credential),
      "面板绝不能渲染密钥值",
    );
    assert(
      root.innerHTML.includes("macOS 系统钥匙串") &&
        root.innerHTML.includes("项目文件只保留服务商元数据"),
      "面板必须说明密钥保存于系统钥匙串且项目文件不保存密钥",
    );
    // Deleting asks for confirmation; a headless shell has no dialog, so the
    // test approves it explicitly.
    const globalScope = globalThis as typeof globalThis & {
      confirm?: (message?: string) => boolean;
    };
    const previousConfirm = globalScope.confirm;
    globalScope.confirm = () => true;
    try {
      await store.aiDeleteSecret();
    } finally {
      globalScope.confirm = previousConfirm;
    }
    assert(state.secrets.has("custom") === false, "删除密钥必须送达本机服务");
    // V1-T02 P0-4: "已配置" is a fact reported by the shell, never an optimistic
    // guess.  After a delete the panel re-reads the shell, so the key is gone
    // from the map (undefined) rather than locally forced to false.
    assert(
      !store.ui.aiConfigured.custom,
      "删除后「已配置」必须来自本机服务的读回结果",
    );
    assert(
      state.calls.filter((call) => call.command === "ai.connection.list")
        .length >= 3,
      "保存与删除都必须以本机服务的读回结果为准，而不是乐观假设成功",
    );
  } finally {
    restore();
  }
});

Deno.test("a key the shell cannot read back is never reported as configured", async () => {
  const { store, state, restore } = await bootStore();
  try {
    seedCourse(store);
    state.providers = [{
      id: "custom",
      label: "自定义（OpenAI 兼容）",
      kind: "openai_compatible",
      base_url: "https://api.example.test/v1",
      default_model: "demo-model",
      models: ["demo-model"],
    }];
    await store.aiLoadProviders();
    store.aiSetProvider("custom");
    // V1-T02 P0-4: `security add-generic-password` exits 0 even when it stored
    // an empty password, so the UI must never trust the write's own report.
    state.dropSecretWrites = true;
    const saved = await store.aiSaveSecret("sk-lost-in-the-keychain");
    assert(saved === false, "aiSaveSecret must report the failure");
    assert(
      !store.ui.aiConfigured?.custom,
      "a key that cannot be read back is not configured",
    );
    assert(
      /没有读回/.test(String(store.ui.toast)) && /钥匙串/.test(String(store.ui.toast)),
      "the toast must explain that the write could not be confirmed",
    );
    assert(
      !JSON.stringify(store.ui).includes("sk-lost-in-the-keychain"),
      "a failed key must still never enter UI state",
    );
    // The shell really is the source of truth: once it can report the key, the
    // same panel shows 已配置 without any optimistic local flag.
    state.dropSecretWrites = false;
    assert(await store.aiSaveSecret("sk-real-key") === true, "a confirmed key must report success");
    assert(store.ui.aiConfigured.custom === true, "a confirmed key must show as configured");
  } finally {
    restore();
  }
});

Deno.test("cancel asks the transport process to stop and keeps the course unchanged", async () => {
  const { store, state, restore } = await bootStore();
  try {
    seedCourse(store);
    state.providers = [{
      id: "custom",
      label: "自定义（OpenAI 兼容）",
      base_url: "https://api.example.test/v1",
      default_model: "demo-model",
      models: ["demo-model"],
    }];
    await store.aiLoadProviders();
    store.ui.aiProviderId = "custom";
    store.ui.aiInstruction = "请解释这一段";
    state.pendingComplete = true;
    const before = JSON.stringify(store.data);
    const pending = store.aiRun();
    await until(() => state.completions.length === 1, "ai.complete 必须已经发出");
    assert(store.ui.aiStatus === "running", "请求发出后必须处于运行中");
    const requestId = store.ui.aiRunId;
    assert(typeof requestId === "string" && requestId.length > 0, "运行必须有 request_id");
    assert(
      state.completions[0]!.input.request_id === requestId,
      "ai.complete 必须携带同一个 request_id",
    );
    await store.aiCancel();
    assert(state.cancels.includes(String(requestId)), "取消必须把 request_id 送达本机服务");
    assert(store.ui.aiStatus === "cancelled", "取消后状态必须是已取消");
    state.releaseComplete?.({ ok: false, code: "cancelled", message: "这次请求已经取消。" });
    await pending;
    assert(
      store.data.suggestions.length === 0 && store.data.change_drafts.length === 0,
      "取消不得产生建议或修改草稿",
    );
    assert(JSON.stringify(store.data) === before, "取消不得改动 canonical 数据");
    assert(store.ui.aiStatus === "cancelled", "迟到的结果不得改写已取消的状态");
  } finally {
    restore();
  }
});

Deno.test("a transport failure on an uncovered provider never fabricates an answer", async () => {
  const { store, state, restore } = await bootStore();
  try {
    seedCourse(store);
    state.providers = [{
      id: "custom",
      label: "自定义（OpenAI 兼容）",
      base_url: "https://api.example.test/v1",
      default_model: "demo-model",
      models: ["demo-model"],
    }];
    await store.aiLoadProviders();
    store.ui.aiProviderId = "custom";
    assert(
      store.aiConnector() instanceof HttpAiConnector,
      "非 fake 服务商必须构造 HTTP 连接器",
    );
    assert(store.aiModel() === "demo-model", "必须使用保存的模型名");
    store.ui.aiInstruction = "请解释这一段";
    const before = JSON.stringify(store.data);
    state.completeResult = {
      ok: false,
      code: "missing_credential",
      message: "这个 Provider 还没有配置 API Key。",
    };
    await store.aiRun();
    assert(
      store.ui.aiError?.code === "missing_credential",
      "缺少密钥的传输失败必须归一为 missing_credential",
    );
    assert(store.data.suggestions.length === 0, "失败不得伪造建议");
    assert(JSON.stringify(store.data) === before, "失败不得改动 canonical 数据");
    const call = state.completions.at(-1)!;
    assert(call.input.provider_id === "custom", "ai.complete 必须带上 provider_id");
    assert(
      call.input.url === "https://api.example.test/v1/chat/completions",
      "必须使用保存的 Base URL",
    );
    assert(
      JSON.stringify(call.input.headers).toLowerCase().includes("authorization") === false,
      "页面不得把密钥放进请求头；它只能由传输进程注入",
    );
    assert(
      typeof call.input.request_id === "string" && call.input.request_id.length > 0,
      "请求必须携带 request_id",
    );
  } finally {
    restore();
  }
});

Deno.test("AI reader position is persisted but never the provider or execution state", async () => {
  const { store, restore } = await bootStore();
  try {
    seedCourse(store);
    store.ui.aiProviderId = "custom";
    store.ui.aiModel = "demo-model";
    store.ui.aiScope = "block";
    store.ui.aiExecutions = [{ id: "record-1" }];
    store.ui.aiContext = { scope: { content_item_id: "x" } };
    store.ui.aiResult = { answer: "不应进入会话" };
    store.ui.aiProviders = [{ id: "custom" }];
    store.ui.aiConfigured = { custom: true };
    const session = store.session();
    assert(session.ai_scope === "block", "会话必须保留 AI 范围");
    assert(session.ai_provider_id === "custom", "会话必须保留服务商选择");
    assert(session.ai_model === "demo-model", "会话必须保留模型选择");
    const serialized = JSON.stringify(session);
    for (const forbidden of ["aiProviders", "aiConfigured", "aiExecutions", "aiContext", "aiResult"]) {
      assert(!serialized.includes(forbidden), `会话不得包含 ${forbidden}`);
    }
    assert(
      !/token|secret|password|credential|api[_-]?key/i.test(serialized),
      "会话不得包含凭据形状的字段名",
    );
  } finally {
    restore();
  }
});
