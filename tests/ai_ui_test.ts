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
  aiDescriptor: (providerId?: string) => Record<string, any>;
  aiModel: () => string;
  aiConnector: () => unknown;
  aiSetScope: (scope: string) => void;
  aiToggleContext: (key: string) => void;
  aiToggleChanges: () => void;
  aiSetProvider: (id: string) => void;
  aiEditProvider: (id: string, options?: { preserveSelection?: boolean }) => void;
  aiCreateConnection: () => void;
  aiSaveProvider: (input: Record<string, any>) => Promise<boolean>;
  aiSaveSecret: (value: string, providerId?: string | null) => Promise<boolean>;
  aiDeleteSecret: (providerId?: string | null) => Promise<boolean>;
  aiDeleteConnection: (providerId: string) => Promise<boolean>;
  aiDiscoverModels: () => Promise<string[]>;
  aiTestConnection: () => Promise<boolean>;
  aiCloseSettings: () => void;
  aiToggleSettings: () => void;
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
    credentialOrigins: {} as Record<string, string>,
    modelsByProvider: {} as Record<string, string[]>,
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
  const previousConfirm = globalThis.confirm;
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
      case "ai.connection.list": {
        const providerIds = new Set([
          ...state.providers.map((provider) => String(provider.id || "")),
          ...state.secrets.keys(),
        ]);
        return {
          providers: structuredClone(state.providers),
          configured: Object.fromEntries(
            [...providerIds].filter(Boolean).map((id) => [id, state.secrets.has(id)]),
          ),
          credential_origins: { ...state.credentialOrigins },
        };
      }
      case "ai.models.list": {
        const providerId = String(input.provider_id || "");
        const provider = state.providers.find((entry) => entry.id === providerId);
        return {
          provider_id: providerId,
          models: [...(state.modelsByProvider[providerId] || [])],
          endpoint: String(provider?.base_url || "") + "/models",
        };
      }
      case "ai.models.probe":
        return {
          provider_id: String(input.provider?.id || ""),
          models: ["probe-model"],
          endpoint: String(input.provider?.base_url || "") + "/models",
        };
      case "ai.connection.test": {
        const provider = state.providers.find((entry) => entry.id === input.provider_id);
        return { provider_id: input.provider_id, model: provider?.default_model, endpoint: provider?.base_url };
      }
      case "ai.connection.save": {
        const provider = structuredClone(input.provider);
        const originOf = (value: unknown) => {
          try {
            return new URL(String(value || "")).origin;
          } catch {
            return null;
          }
        };
        const oldOrigin = state.credentialOrigins[provider.id] || null;
        const targetOrigin = originOf(provider.base_url);
        if (
          state.secrets.has(provider.id) &&
          oldOrigin !== targetOrigin &&
          input.confirm_credential_origin !== true
        ) {
          throw bridgeFailure({
            code: "credential_origin_confirmation_required",
            message: "需要确认 API Key 的新使用域名",
          });
        }
        const index = state.providers.findIndex((entry) =>
          entry.id === provider.id
        );
        if (index >= 0) state.providers.splice(index, 1, provider);
        else state.providers.push(provider);
        if (state.secrets.has(provider.id) && targetOrigin) {
          state.credentialOrigins[provider.id] = targetOrigin;
        }
        return { provider };
      }
      case "ai.connection.delete": {
        const providerId = String(input.provider_id || "");
        state.providers = state.providers.filter((entry) =>
          entry.id !== providerId
        );
        state.secrets.delete(providerId);
        delete state.credentialOrigins[providerId];
        return { provider_id: providerId, removed: true };
      }
      case "ai.secret.set":
        if (!state.dropSecretWrites) {
          state.secrets.set(String(input.provider_id), String(input.value));
          const provider = state.providers.find((entry) =>
            entry.id === String(input.provider_id)
          );
          if (provider?.base_url) {
            state.credentialOrigins[String(input.provider_id)] =
              new URL(String(provider.base_url)).origin;
          }
        }
        // A broken keychain write still reports success at the CLI boundary;
        // only reading the credential back tells the truth.
        return { provider_id: input.provider_id, configured: true };
      case "ai.secret.delete":
        state.secrets.delete(String(input.provider_id));
        delete state.credentialOrigins[String(input.provider_id)];
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
      globalThis.confirm = previousConfirm;
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

Deno.test("creating a connection renders its editable form before the connection list", async () => {
  const { store, restore } = await bootStore();
  try {
    store.aiCreateConnection();
    const { createViews } = await import(`../app/views.js?ai-new-connection-${++importCounter}`);
    const html = createViews(store as never).shellView() as string;
    const form = html.indexOf('class="ai-provider-form"');
    const manager = html.indexOf('id="ai-connection-manager"');
    assert(form >= 0, "the new-connection action must render the editable provider form");
    assert(manager > form, "the form must appear before the longer connection/account lists");
    assert(html.includes("data-ai-base-url"), "the form must expose the Base URL input immediately");
    assert(html.includes("data-ai-api-protocol"), "the form must expose the protocol selector immediately");
  } finally {
    restore();
  }
});

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

Deno.test("AI URL changes require an origin confirmation before saved Keys move", async () => {
  const booted = await bootStore();
  const { store, state, restore } = booted;
  const provider = {
    id: "custom-origin",
    label: "测试连接",
    kind: "openai_compatible",
    base_url: "https://old.example/v1",
    chat_path: "/chat/completions",
    default_model: "model-a",
    models: ["model-a"],
  };
  state.providers.push(provider);
  state.secrets.set(provider.id, "opaque-test-credential");
  state.credentialOrigins[provider.id] = "https://old.example";
  await store.aiLoadProviders();
  store.ui.aiProviderId = provider.id;
  store.ui.aiProviderForm = { ...provider };

  const previousConfirm = globalThis.confirm;
  let prompt = "";
  try {
    globalThis.confirm = (message?: string) => {
      prompt = String(message || "");
      return false;
    };
    const savesBefore = state.calls.filter((call) =>
      call.command === "ai.connection.save"
    ).length;
    const refused = await store.aiSaveProvider({
      ...provider,
      base_url: "https://new.example/v1",
    });
    assert(!refused, "declining a cross-origin transfer must stop the save");
    assert(
      prompt.includes("https://old.example") &&
        prompt.includes("https://new.example"),
      "the confirmation must show both credential origins",
    );
    assert(
      state.providers[0]?.base_url === "https://old.example/v1" &&
        state.secrets.has(provider.id),
      "declining must preserve the saved URL and credential",
    );
    assert(
      state.calls.filter((call) => call.command === "ai.connection.save")
          .length === savesBefore,
      "declining must not call the save command",
    );

    globalThis.confirm = () => true;
    const saved = await store.aiSaveProvider({
      ...provider,
      base_url: "https://new.example/v1",
    });
    assert(saved, "explicit confirmation should save the new origin");
    const saveCall = state.calls.filter((call) =>
      call.command === "ai.connection.save"
    ).at(-1);
    assert(
      saveCall?.input.confirm_credential_origin === true,
      "only an accepted prompt may set the origin-confirmation command flag",
    );
    assert(
      state.credentialOrigins[provider.id] === "https://new.example",
      "the existing Key should be bound to the confirmed origin",
    );

    delete state.credentialOrigins[provider.id];
    await store.aiLoadProviders();
    globalThis.confirm = (message?: string) => {
      prompt = String(message || "");
      return false;
    };
    const savesBeforeMissingBinding = state.calls.filter((call) =>
      call.command === "ai.connection.save"
    ).length;
    const refusedUnbound = await store.aiSaveProvider({
      ...state.providers[0],
    });
    assert(!refusedUnbound, "a missing binding must require confirmation even at the same URL");
    assert(
      prompt.includes("未绑定域名") && prompt.includes("https://new.example"),
      "the confirmation must identify a missing binding and the saved target origin",
    );
    assert(
      state.calls.filter((call) => call.command === "ai.connection.save").length ===
        savesBeforeMissingBinding,
      "declining an unbound-key confirmation must not save provider metadata",
    );

    globalThis.confirm = () => true;
    assert(
      await store.aiSaveProvider({ ...state.providers[0] }),
      "explicit confirmation must bind an existing key when its origin was missing",
    );
    const unboundSaveCall = state.calls.filter((call) =>
      call.command === "ai.connection.save"
    ).at(-1);
    assert(
      unboundSaveCall?.input.confirm_credential_origin === true &&
        state.credentialOrigins[provider.id] === "https://new.example",
      "same-origin metadata saves must still explicitly confirm a missing binding",
    );

    store.ui.aiProviderForm = {
      ...state.providers[0],
      base_url: "https://unconfirmed.example/v1",
    };
    const modelCallsBefore = state.calls.filter((call) =>
      call.command === "ai.models.list"
    ).length;
    assert(
      (await store.aiDiscoverModels()).length === 0,
      "model discovery must stop on a URL that has not been saved and confirmed",
    );
    assert(
      state.calls.filter((call) => call.command === "ai.models.list").length ===
        modelCallsBefore,
      "unsaved model discovery must not invoke the provider request",
    );
  } finally {
    globalThis.confirm = previousConfirm;
    restore();
  }
});

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
    assert(root.innerHTML.includes("还没有可用的模型连接"), "没有模型连接时应先配置 AI，再显示运行能力信息");
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
    store.aiEditProvider("fake");
    store.notify();
    assert(
      root.innerHTML.includes("macOS 系统钥匙串（本机浏览器服务）"),
      "浏览器壳必须说明密钥写入 macOS 系统钥匙串",
    );
    assert(!root.innerHTML.includes("本项目目录的 .workspace/ai"), "浏览器壳不得声称密钥在项目文件");
    assert(root.innerHTML.includes("课程文件不含凭据"), "必须说明课程文件不保存凭据");
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
    assert(root.innerHTML.includes("课程文件不含凭据"), "必须说明课程文件不保存凭据");
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
    state.providers = [{ id: "custom", label: "Configured", base_url: "https://api.example.test/v1", default_model: "model-1", models: ["model-1"] }];
    state.secrets.set("custom", "local-test-key");
    await store.aiLoadProviders();
    store.aiSetProvider("custom");
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
    state.providers = [{ id: "custom", label: "测试连接", base_url: "https://api.example.test/v1", default_model: "model-1", models: ["model-1"] }];
    state.secrets.set("custom", "local-test-key");
    await store.aiLoadProviders();
    store.aiSetProvider("custom");
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
    await store.aiLoadProviders();
    store.aiSetProvider("custom");
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
        root.innerHTML.includes("课程文件不含凭据"),
      "面板必须说明密钥保存于系统钥匙串且课程文件不含凭据",
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

Deno.test("connection management keeps provider metadata, keys, models, and selection scoped by id", async () => {
  const { store, state, root, restore } = await bootStore();
  const globalScope = globalThis as typeof globalThis & {
    confirm?: (message?: string) => boolean;
  };
  const previousConfirm = globalScope.confirm;
  globalScope.confirm = () => true;
  try {
    seedCourse(store);
    state.providers = [
      {
        id: "account-a",
        label: "账户 A",
        kind: "openai_compatible",
        base_url: "https://a.example.test/v1",
        chat_path: "/chat/completions",
        auth_header: "authorization",
        auth_scheme: "Bearer",
        default_model: "a-default",
        models: ["a-default"],
      },
      {
        id: "account-b",
        label: "账户 B",
        kind: "openai_compatible",
        base_url: "https://b.example.test/v1",
        chat_path: "/chat/completions",
        auth_header: "authorization",
        auth_scheme: "Bearer",
        default_model: "b-default",
        models: ["b-default"],
      },
    ];
    state.secrets.set("account-a", "local-key-account-a");
    state.secrets.set("account-b", "local-key-account-b");
    state.modelsByProvider = {
      "account-a": ["a-model-only"],
      "account-b": ["b-model-only"],
    };
    await store.aiLoadProviders();
    store.aiSetProvider("account-a");
    store.ui.rightPanel = "assistant";

    // Editing B must not switch the active runtime connection away from A.
    store.aiEditProvider("account-b", { preserveSelection: true });
    assert(store.ui.aiProviderId === "account-a", "管理 B 不得切换当前连接 A");
    assert(store.ui.aiProviderForm.id === "account-b", "表单必须明确绑定 B 的 ID");
    assert(root.innerHTML.includes("data-action=\"ai-delete-connection\""), "已保存连接必须提供显式删除入口");
    assert(
      !root.innerHTML.includes("local-key-account-a") &&
        !root.innerHTML.includes("local-key-account-b"),
      "连接管理界面不得回显任一 Key",
    );

    const bModels = await store.aiDiscoverModels();
    const bListCall = state.calls.filter((call) => call.command === "ai.models.list").at(-1);
    assert(bModels.join(",") === "b-model-only", "B 的模型列表必须来自 B 的连接");
    assert(bListCall?.input.provider_id === "account-b", "读取模型命令必须使用表单连接 B");
    assert(bListCall?.input.base_url === undefined, "模型请求只传连接 ID，地址由服务层读取已保存配置");
    assert(root.innerHTML.includes("b-model-only"), "B 的远程模型必须显示在 B 表单中");

    assert(
      await store.aiSaveProvider({
        id: store.ui.aiProviderForm.id,
        label: "账户 B 更新",
        base_url: "https://b.example.test/v2",
        default_model: "b-saved-model",
        models: ["b-saved-model"],
      }),
      "保存 B 的元数据必须成功",
    );
    assert(store.ui.aiProviderId === "account-a", "保存非当前连接的元数据不得切换 A");
    assert(store.ui.aiModel === "a-default", "保存 B 不得覆盖 A 的模型选择");
    assert(state.providers.find((provider) => provider.id === "account-b")?.base_url === "https://b.example.test/v2", "保存只应更新 B 的连接元数据");
    assert(state.providers.find((provider) => provider.id === "account-b")?.api_protocol === "openai-completions", "API 协议必须和连接配置一起保存");
    assert(state.secrets.get("account-a") === "local-key-account-a", "元数据保存不得改写 A 的 Key");
    assert(state.secrets.get("account-b") === "local-key-account-b", "元数据保存不得改写 B 的 Key");

    store.aiEditProvider("account-a", { preserveSelection: true });
    const aModels = await store.aiDiscoverModels();
    const aListCall = state.calls.filter((call) => call.command === "ai.models.list").at(-1);
    assert(aModels.join(",") === "a-model-only", "切换管理对象后模型列表必须切换到 A");
    assert(aListCall?.input.provider_id === "account-a", "A 的模型请求必须使用 A 的 ID");
    assert(root.innerHTML.includes("a-model-only"), "A 的远程模型必须显示在 A 表单中");

    store.aiEditProvider("account-b", { preserveSelection: true });
    const secretWritesBeforeBlank = state.calls.filter((call) => call.command === "ai.secret.set").length;
    assert(!await store.aiSaveSecret("   ", "account-b"), "空白 Key 必须被拒绝");
    assert(state.secrets.get("account-b") === "local-key-account-b", "空 Key 不得覆盖已保存的 B Key");
    assert(
      state.calls.filter((call) => call.command === "ai.secret.set").length === secretWritesBeforeBlank,
      "空白 Key 不得调用本机凭据写入接口",
    );
    assert(await store.aiSaveSecret("replacement-key-account-b", "account-b"), "B 的 Key 更新必须成功");
    assert(state.secrets.get("account-a") === "local-key-account-a", "更新 B 的 Key 不得影响 A");
    assert(state.secrets.get("account-b") === "replacement-key-account-b", "显式 provider ID 必须将新 Key 写入 B");

    store.aiSetProvider("account-b");
    assert(store.aiModel() === "b-saved-model", "切换到 B 后必须采用 B 保存的默认模型");
    assert(store.ui.aiConfigured["account-b"] === true, "B 的已配置状态应由本机服务读回");
    assert(await store.aiTestConnection(), "连接测试必须独立运行已保存连接的最小请求");
    assert(state.calls.at(-1)?.command === "ai.connection.test", "连接测试必须使用专用命令");
    store.ui.aiError = { code: "authentication_failed", message: "认证失败" };
    store.notify();
    assert(root.innerHTML.includes("服务商认证失败（401）"), "401 应与缺少 Key 的状态明确区分");
    store.ui.aiError = { code: "missing_credential", message: "没有 Key" };
    store.notify();
    assert(root.innerHTML.includes("本机尚未保存 API Key"), "缺少 Key 应显示独立提示");

    assert(await store.aiDeleteSecret("account-b"), "显式删除 B 的 Key 必须成功");
    assert(!state.secrets.has("account-b"), "删除操作必须清除 B 的 Key");
    assert(state.secrets.get("account-a") === "local-key-account-a", "删除 B 的 Key 不得影响 A");
    assert(store.ui.aiConfigured["account-b"] === false, "删除后配置状态必须由本机服务读回");

    // A connection delete removes that ID's metadata and any remaining key.
    assert(await store.aiSaveSecret("replacement-key-account-b", "account-b"), "删除连接前重新保存 B 的 Key");
    assert(await store.aiDeleteConnection("account-b"), "显式删除 B 连接必须成功");
    assert(!state.providers.some((provider) => provider.id === "account-b"), "删除 B 连接必须移除 B 元数据");
    assert(!state.secrets.has("account-b"), "删除 B 连接必须一并清除 B 凭据");
    assert(state.providers.some((provider) => provider.id === "account-a"), "删除 B 不得影响 A 元数据");
    assert(state.secrets.get("account-a") === "local-key-account-a", "删除 B 不得影响 A 凭据");

    // Settings visibility is ephemeral and legacy values are ignored.
    store.aiCloseSettings();
    assert(store.ui.aiSettingsOpen === false, "关闭设置后 UI 状态必须关闭");
    const closedSession = store.session();
    assert(!("ai_settings_open" in closedSession), "设置窗口开关不得写入 reader session");
    await store.restoreSession({ ...closedSession, project_id: store.data.project.id, ai_settings_open: true });
    assert(store.ui.aiSettingsOpen === false, "旧会话不得在重启后恢复设置窗口");
    assert(!("ai_settings_open" in store.session()), "设置窗口开关不得重新持久化");
  } finally {
    globalScope.confirm = previousConfirm;
    restore();
  }
});

Deno.test("AI settings use one topbar modal; close clears a temporary key and preserves assistant input", async () => {
    const { store, root, restore } = await bootStore();
  try {
    const { block } = seedCourse(store);
    store.ui.rightPanel = "assistant";
    store.ui.aiInstruction = "保留这条输入";
    store.notify();
    assert(root.innerHTML.includes("还没有可用的模型连接"), "没有模型连接时助手应显示空状态");
    assert(root.innerHTML.includes("data-action=\"ai-toggle-settings\""), "空状态提供配置 AI 入口");
    assert(!root.innerHTML.includes('<select class="select" data-ai-provider>'), "助手不得保留连接选择器");
    store.aiEditProvider("custom");
    assert(root.innerHTML.includes("ai-settings-modal"), "AI 设置必须显示为独立弹窗");
    assert(root.innerHTML.includes("data-ai-api-protocol"), "设置必须支持三种协议");
    assert(root.innerHTML.includes("连接配置尚未保存"), "连接配置保存状态应单独呈现");

    const secret = { value: "temporary-unsaved-key" };
    (root as unknown as { querySelectorAll: (selector: string) => unknown[] }).querySelectorAll = (selector: string) =>
      selector.includes("data-ai-secret") ? [secret] : [];
    store.aiCloseSettings();
    assert(secret.value === "", "关闭设置必须清空未保存 Key 输入");
    assert(store.ui.aiInstruction === "保留这条输入", "关闭设置不得清除助手指令输入");
    assert(root.innerHTML.includes(`data-block-id="${block.id}"`), "关闭设置应回到原课程和原正文编辑器");
    assert(root.innerHTML.includes("第一课的正文"), "设置弹窗不应覆盖课程正文输入");
    assert(!JSON.stringify(store.ui).includes("temporary-unsaved-key"), "临时 Key 不得进入 UI 状态");
  } finally {
    restore();
  }
});

Deno.test("subscription login is native-only and the browser shell cannot report a fake success", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    state.providers.push({
      id: "chatgpt-subscription-a",
      label: "ChatGPT account",
      kind: "openai_chatgpt_subscription",
      base_url: "https://api.openai.com/v1",
      api_protocol: "openai-responses",
      default_model: "",
      models: [],
    });
    await store.aiLoadProviders();
    store.ui.aiSettingsOpen = true;
    store.bridge.isNative = () => false;
    store.notify();
    assert(
      root.innerHTML.includes("当前浏览器服务壳不支持订阅登录"),
      "browser shell must explain that SIWC requires the native runtime",
    );
    assert(
      !root.innerHTML.includes('data-action="ai-subscription-start"'),
      "browser shell must not present an unusable login action",
    );
    const login = store as unknown as { aiSubscriptionStart: () => Promise<boolean> };
    const before = state.calls.filter((call) => call.command === "ai.subscription.start").length;
    await login.aiSubscriptionStart();
    assert(store.ui.aiSubscriptionAttempt?.status === "unavailable", "unsupported shell must show the real unavailable state");
    assert(
      state.calls.filter((call) => call.command === "ai.subscription.start").length === before,
      "unsupported shell must not call a fake auth command",
    );
    store.bridge.isNative = () => true;
    store.notify();
    assert(
      root.innerHTML.includes('data-action="ai-subscription-start"'),
      "native settings must provide an explicit user-triggered login entry",
    );
  } finally {
    restore();
  }
});

Deno.test("temporary model discovery sends its key once and clears the input without saving it", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    seedCourse(store);
    store.ui.aiProviderForm = {
      id: "probe-temporary",
      label: "临时探测",
      base_url: "https://probe.example.test/v1",
      api_protocol: "openai-completions",
      chat_path: "/chat/completions",
      default_model: "",
      models: [],
    };
    const secret = { value: "temporary-probe-key" };
    (root as unknown as { querySelector: (selector: string) => unknown }).querySelector = (selector: string) =>
      selector === "[data-ai-secret]" ? secret : null;
    const models = await store.aiDiscoverModels();
    const call = state.calls.at(-1);
    assert(models.join(",") === "probe-model", "临时探测应读取后端返回的模型");
    assert(call?.command === "ai.models.probe", "未保存地址必须走临时后端探测");
    assert(call?.input.temporary_credential === "temporary-probe-key", "临时凭据仅用于当前探测命令");
    assert(secret.value === "", "探测开始后必须清空 DOM Key 字段");
    assert(!state.secrets.has(store.ui.aiProviderForm.id), "模型探测不得写凭据 store");
    assert(!JSON.stringify(store.ui).includes("temporary-probe-key"), "临时凭据不得进入 UI 状态");
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
