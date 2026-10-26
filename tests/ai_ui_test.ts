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
import { appCredentialStoreLabel } from "../app/host.js";
import {
  AI_CAPACITY_INVALID_MESSAGE,
  AI_MODEL_ID_REQUIRED_MESSAGE,
  AI_MODEL_META_ID_MESSAGE,
  AI_REASONING_REQUIRED_MESSAGE,
  AI_REASONING_VALUE_REQUIRED_MESSAGE,
  FakeAiConnector,
  HttpAiConnector,
  aiChangeDraftDiffRows,
  aiFormatCapacity,
  aiParseCapacity,
  aiReasoningTierOptions,
} from "../app/ai.js";
import { createEmptyProjectData } from "../src/domain/index.ts";
import { validateProjectData } from "../src/domain/store.ts";
import type { ProjectData } from "../src/domain/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let importCounter = 0;

type TestFingerprint = {
  exists: boolean;
  mtime_ms: number | null;
  size: number | null;
  hash: string | null;
};

function testFingerprint(project: ProjectData, revision: number): TestFingerprint {
  return {
    exists: true,
    mtime_ms: 1_780_000_000_000 + revision,
    size: new TextEncoder().encode(JSON.stringify(project)).byteLength,
    hash: revision.toString(16).padStart(64, "0"),
  };
}

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
  commit_state?: string | null;
  stage?: string | null;
  retryable?: boolean;
  fingerprint?: Record<string, unknown>;
  expected_committed_fingerprint?: Record<string, unknown>;
  operation_id?: string;
  revision?: number;
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
  aiSetAddTab: (tab: string) => void;
  aiSetProviderId: (value: string) => void;
  aiSyncDraftField: (field: string, value: string) => void;
  aiSaveProvider: (input: Record<string, any>) => Promise<boolean>;
  aiSaveSecret: (value: string, providerId?: string | null) => Promise<boolean>;
  aiDeleteSecret: (providerId?: string | null) => Promise<boolean>;
  aiDeleteConnection: (providerId: string) => Promise<boolean>;
  aiDiscoverModels: () => Promise<string[]>;
  aiTestConnection: () => Promise<boolean>;
  aiNormalizeDraft: (source: Record<string, any>, options?: Record<string, unknown>) => Record<string, any>;
  aiModelRowByKey: (key: string) => Record<string, any> | null;
  aiToggleModelRow: (key: string) => void;
  aiRemoveModelRow: (key: string) => void;
  aiMoveModelRow: (key: string, dir: string) => void;
  aiAddManualModel: () => void;
  aiSyncModelRowField: (key: string, field: string, value: string) => void;
  aiValidateModelRowField: (key: string, field: string) => void;
  aiValidateModelRows: () => string;
  aiToggleModelRowInput: (key: string, kind: string, checked: boolean) => void;
  aiToggleModelReasoning: (key: string) => void;
  aiToggleReasoningHelp: (key: string) => void;
  aiAddTierRow: (key: string) => void;
  aiRemoveTierRow: (key: string, tierKey: string) => void;
  aiChangeTierName: (key: string, tierKey: string, to: string) => void;
  aiSyncTierValue: (key: string, tierKey: string, text: string) => void;
  aiValidateTierValue: (key: string, tierKey: string) => void;
  aiResetModels: () => void;
  aiToggleAdvanced: () => void;
  aiToggleSecretVisible: () => void;
  aiClearTemporarySecretInputs: () => void;
  aiPickerSearch: (value: string) => void;
  aiPickerToggle: (id: string) => void;
  aiPickerSelectAll: () => void;
  aiPickerClearAll: () => void;
  aiPickerConfirm: () => void;
  aiCloseModelPicker: () => void;
  aiPickerWouldEmpty: () => boolean;
  aiPickerVisibleModels: () => Array<Record<string, any>>;
  aiOpenModelPicker: () => void;
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
    fingerprint: testFingerprint(source, 1),
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
        const ids = [...(state.modelsByProvider[providerId] || [])];
        // Exactly the payload both real shells return: entries carry the label,
        // `model_ids` is the plain list.
        return {
          provider_id: providerId,
          models: ids.map((id) => ({ id, label: id })),
          model_ids: ids,
          display_names: Object.fromEntries(ids.map((id) => [id, id])),
          endpoint: String(provider?.base_url || "") + "/models",
        };
      }
      case "ai.models.probe":
        return {
          provider_id: String(input.provider?.id || ""),
          models: [{ id: "probe-model", label: "probe-model" }],
          model_ids: ["probe-model"],
          display_names: { "probe-model": "probe-model" },
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
      case "project.create": {
        state.project = createEmptyProjectData(String(input.title || "未命名课程"));
        state.fingerprint = testFingerprint(state.project, state.writes + 1);
        return structuredClone(state.project);
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
  bridgeTarget.projectDir = "/tmp/workbench-ai-ui-test";
  bridgeTarget.projectDirFromUrl = false;
  bridgeTarget.lastOpenedProjectState = {
    project_dir: "/tmp/workbench-ai-ui-test",
    lease_generation: "ai-ui-test-lease",
  };
  bridgeTarget.openProjectState = async () => {
    bridgeTarget.lastOpenedProjectState = {
      project_dir: "/tmp/workbench-ai-ui-test",
      project_id: state.project.project.id,
      lease_generation: "ai-ui-test-lease",
    };
    return {
      project: structuredClone(state.project),
      project_id: state.project.project.id,
      project_dir: "/tmp/workbench-ai-ui-test",
      lease_generation: "ai-ui-test-lease",
      fingerprint: structuredClone(state.fingerprint),
    };
  };
  bridgeTarget.isNative = () => false;
  bridgeTarget.currentProject = () => state.project;
  bridgeTarget.loadSession = async () => null;
  bridgeTarget.readProject = async () => structuredClone(state.project);
  bridgeTarget.readProjectState = async () => ({
    project: structuredClone(state.project),
    project_id: state.project.project.id,
    project_dir: "/tmp/workbench-ai-ui-test",
    lease_generation: "ai-ui-test-lease",
    fingerprint: structuredClone(state.fingerprint),
  });
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
  bridgeTarget.writeProject = async (request: Record<string, any>) => {
    assert(
      JSON.stringify(request.expected_fingerprint) === JSON.stringify(state.fingerprint),
      "the UI save must send the currently adopted project fingerprint",
    );
    assert(request.expected_project_id === state.project.project.id, "the save must bind the current project id");
    assert(request.lease_generation === "ai-ui-test-lease", "the save must bind the current browser lease");
    state.writes += 1;
    state.project = structuredClone(request.project);
    state.fingerprint = testFingerprint(request.project, state.writes + 1);
    return {
      project_id: request.expected_project_id,
      lease_generation: request.lease_generation,
      editor_generation: request.editor_generation,
      operation_id: request.operation_id,
      revision: request.revision,
      outcome: "written",
      commit_state: "committed",
      fingerprint: structuredClone(state.fingerprint),
      recovery_warning: null,
    };
  };
  bridgeTarget.command = command;
  bridgeFailure = (value: unknown) => store.bridge.bridgeError(value);
  await (runtime as { __workbenchReady?: Promise<void> }).__workbenchReady;
  // The web launcher used by these tests has no persisted project file. Bind
  // the fake service to the live booted Canonical project before exercising
  // autosave; a random pre-boot fixture id would correctly fail strict CAS.
  state.project = structuredClone(store.data);
  state.fingerprint = testFingerprint(state.project, 1);
  assert(
    (store as any).adoptProjectSnapshot({
      project: state.project,
      project_id: state.project.project.id,
      project_dir: "/tmp/workbench-ai-ui-test",
      lease_generation: "ai-ui-test-lease",
      fingerprint: state.fingerprint,
    }),
    "the AI test service must adopt its project and fingerprint together",
  );
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

Deno.test("rightPanelView is exported, callable, and tolerates pre-v3 resource fixtures", async () => {
  const { store, restore } = await bootStore();
  try {
    store.ui.rightTab = "discovery";
    delete store.ui.resourceSearchTypes;
    const { createViews } = await import(`../app/views.js?right-panel-contract-${++importCounter}`);
    const views = createViews(store as never);
    assert(typeof views.rightPanelView === "function", "createViews must expose the partial right-panel renderer");
    const html = views.rightPanelView();
    assert(html.includes('data-right-tab="discovery"') && html.includes('aria-selected="true"'), "the default discovery tab must render as selected");
    assert(html.includes('data-resource-search="web"') && html.includes('data-resource-search="video"'), "old fixtures without resourceSearchTypes must receive safe defaults");
    store.ui.resourceDocument = { asset_id: "asset-1", filename: "lesson.md", status: "parsed", readable: true, truncated: false, error: "正文已解析。配置模型连接后可继续提取主题。", context: null };
    store.ui.resourceTask = { task_id: "task-1", state: "interrupted", progress: { completed_queries: 1, total_queries: 3 }, budget: { completed_requests: 1, max_requests: 8 }, candidates: [], errors: [] };
    let discovery = views.rightPanelView();
    assert(discovery.includes("配置后继续提取主题") && discovery.includes("配置 AI 连接"), "an already parsed document must offer a configure-and-continue path");
    assert(discovery.includes("继续查找"), "an interrupted task must offer continuation");
    store.ui.resourceTask.state = "failed";
    discovery = views.rightPanelView();
    assert(discovery.includes("重试失败项"), "ordinary failed queries must retain retry wording");
  } finally {
    restore();
  }
});

Deno.test("candidate reader uses the current HTTPS URL, escapes text, and reflects read state", async () => {
  const { store, restore } = await bootStore();
  try {
    store.ui.rightTab = "browser";
    store.ui.resourceTask = {
      task_id: "task-reader-view",
      candidates: [{
        id: "candidate-reader-view",
        title: "安全阅读",
        url: "https://example.test/current",
        source_evidence: [{ url: "https://example.test/current", excerpt: "来源摘录" }],
      }],
    };
    store.ui.resourceSelectedCandidateId = "candidate-reader-view";
    const { createViews } = await import(`../app/views.js?reader-state-${++importCounter}`);
    const render = () => createViews(store as never).rightPanelView();
    store.ui.resourceReading = {
      candidateId: "candidate-reader-view",
      url: "https://example.test/old",
      result: { url: "https://example.test/old", text: "旧 URL 正文" },
    };
    let html = render();
    assert(html.includes("来源摘录") && !html.includes("旧 URL 正文"), "a changed candidate URL must show its own evidence instead of stale body text");
    assert(html.includes(">读取正文</button>"), "an unread current URL must offer a read action");

    store.ui.resourceReading = {
      candidateId: "candidate-reader-view",
      url: "https://example.test/current",
      result: { url: "https://example.test/current", text: "<script>unsafe()</script>", publisher: "来源" },
    };
    html = render();
    assert(html.includes("&lt;script&gt;unsafe()&lt;/script&gt;"), "reader text must remain escaped plain text");
    assert(html.includes(">重新读取</button>"), "a successfully read current URL must offer refresh");
    assert(!html.includes("<script>unsafe()"), "reader text must never become executable markup");

    store.ui.resourceReading = { candidateId: "candidate-reader-view", url: "https://example.test/current", loading: true };
    html = render();
    assert(html.includes('disabled aria-busy="true">正在读取…</button>'), "the current URL action must expose its loading state");
    store.ui.resourceReading = { candidateId: "candidate-reader-view", url: "https://example.test/current", error: "服务不可用" };
    html = render();
    assert(html.includes(">重试读取</button>"), "a failed current URL must offer retry");
  } finally {
    restore();
  }
});

Deno.test("an editor renders inside the card it belongs to: add card or provider row", async () => {
  const { store, state, restore } = await bootStore();
  try {
    state.providers.push({
      id: "row-provider",
      label: "行内提供商",
      kind: "openai_compatible",
      base_url: "https://row.example.test/v1",
      default_model: "row-model",
      models: ["row-model"],
    });
    await store.aiLoadProviders();
    store.aiCreateConnection();
    const { createViews } = await import(`../app/views.js?ai-new-connection-${++importCounter}`);
    const htmlOf = () => createViews(store as never).shellView() as string;
    let html = htmlOf();
    const rows = html.indexOf('class="ai-provider-rows"');
    const addCard = html.indexOf('class="ai-add-card"');
    const addEditor = html.indexOf('data-ai-editor="add"');
    assert(rows >= 0, "the settings modal must render the provider row list");
    assert(addEditor >= 0, "the new-connection action must render the editable provider editor");
    assert(
      addEditor > addCard && addCard > rows,
      "the add card's editor renders inside the add card, after the provider row list",
    );
    assert(html.includes("data-ai-base-url"), "the form must expose the Base URL input immediately");
    assert(html.includes("data-ai-api-protocol"), "the form must expose the protocol selector immediately");
    // Editing a saved provider opens the editor card inside that provider's row.
    store.aiEditProvider("row-provider", { preserveSelection: true });
    html = htmlOf();
    const rowStart = html.indexOf('data-provider-id="row-provider"');
    const rowEditor = html.indexOf('data-ai-editor="row"');
    assert(rowStart >= 0, "the saved provider must render a provider row card");
    assert(rowEditor > rowStart, "the editor card must render inside its own provider row");
    assert(
      html.indexOf('class="ai-add-trigger"') > rowEditor,
      "opening a row collapses the add card back to its dashed entry button",
    );
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

Deno.test("a refused connection save keeps the typed form and names the field", async () => {
  const { store, state, restore } = await bootStore();
  const saves = () =>
    state.calls.filter((call) => call.command === "ai.connection.save").length;
  const typed = {
    id: "typed-account",
    label: "我的连接",
    base_url: "api.openai.com/v1",
    api_protocol: "openai-completions",
    default_model: "gpt-5-mini",
    models: ["gpt-5-mini"],
  };
  try {
    const savesBefore = saves();
    assert(
      (await store.aiSaveProvider(typed)) === false,
      "an address without a scheme must not be saved",
    );
    assert(saves() === savesBefore, "a rejected address must not reach the shell");
    assert(
      String(store.ui.toast).includes("Base URL"),
      `the refusal must name the field: ${String(store.ui.toast)}`,
    );
    // §9.4 — the fields render from the form state, so a refusal that clears it
    // would throw away the whole half-filled connection.
    assert(store.ui.aiProviderForm.base_url === typed.base_url, "the rejected address stays in its field");
    assert(store.ui.aiProviderForm.label === "我的连接", "the display name survives the refusal");
    assert(store.ui.aiProviderForm.default_model === "gpt-5-mini", "the model survives the refusal");
    assert(store.ui.aiProviderForm.id === "typed-account", "the provider id survives the refusal");

    assert(
      (await store.aiSaveProvider({ ...typed, base_url: "https://user:sk-secret@example.test/v1" })) ===
        false,
      "a credential embedded in the address must not be saved",
    );
    assert(
      !String(store.ui.toast).includes("sk-secret"),
      `the refusal must not echo the credential: ${String(store.ui.toast)}`,
    );
    assert(
      (await store.aiSaveProvider({ ...typed, base_url: "" })) === false,
      "an API connection with no address is not usable",
    );
    assert(saves() === savesBefore, "none of the refusals asked the shell to save");

    assert(
      await store.aiSaveProvider({ ...typed, base_url: "https://api.example.test/v1" }),
      "the same form saves once the address is complete",
    );
    assert(
      state.providers.find((provider) => provider.id === "typed-account")?.base_url ===
        "https://api.example.test/v1",
      "the shell receives the address that replaced the rejected one",
    );
    assert(
      store.ui.aiProviderForm.base_url === "https://api.example.test/v1",
      "the form shows what is now saved",
    );
  } finally {
    restore();
  }
});

Deno.test("the default provider is the offline connector and a run only adds a suggestion", async () => {
  const { store, state, restore } = await bootStore();
  try {
    seedCourse(store);
    store.ui.rightTab = "assistant";
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
    store.ui.rightTab = "assistant";
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
    assert(store.saveStatus !== "保存失败", `记录写入失败不得影响课程保存状态：${store.ui.toast}`);
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

Deno.test("bridgeError preserves nested commit protocol fields and top-level precedence", async () => {
  const { store, restore } = await bootStore();
  try {
    const fingerprint = { exists: true, mtime_ms: null, size: 17, hash: "a".repeat(64) };
    const failure = store.bridge.bridgeError({
      error: {
        code: "project_save_failed",
        user_message: "保存结果需要核验",
        details: {
          commit_state: "outcome_uncertain",
          stage: "rename",
          retryable: true,
          fingerprint,
          expected_committed_fingerprint: fingerprint,
          operation_id: "op-7",
          revision: 7,
        },
      },
    });
    assert(failure.commit_state === "outcome_uncertain", "nested commit state must survive bridge normalization");
    assert(failure.stage === "rename", "nested stage must survive bridge normalization");
    assert(failure.retryable === true, "nested retryable field must survive bridge normalization");
    assert(failure.fingerprint?.hash === fingerprint.hash, "nested fingerprint must survive bridge normalization");
    assert(failure.expected_committed_fingerprint?.size === 17, "expected commit fingerprint must survive bridge normalization");
    assert(failure.operation_id === "op-7" && failure.revision === 7, "operation binding must survive bridge normalization");

    const conflict = store.bridge.bridgeError({
      error: {
        code: "external_modification_conflict",
        user_message: "外部修改冲突",
        retryable: false,
        details: { commit_state: "not_committed", retryable: true },
      },
    });
    assert(conflict.commit_state === "not_committed", "conflict commit state must survive normalization");
    assert(conflict.retryable === false, "explicit top-level false must override nested retryable true");
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
    store.ui.rightTab = "assistant";
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
    store.ui.rightTab = "assistant";
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
    store.ui.rightTab = "assistant";
    store.bridge.isNative = () => false;
    store.aiEditProvider("fake");
    store.notify();
    assert(
      root.innerHTML.includes(appCredentialStoreLabel(false)),
      "浏览器壳必须说明密钥写入本机系统凭据存储",
    );
    assert(!root.innerHTML.includes("本项目目录的 .workspace/ai"), "浏览器壳不得声称密钥在项目文件");
    assert(root.innerHTML.includes("课程文件不含凭据"), "必须说明课程文件不保存凭据");
    store.bridge.isNative = () => true;
    store.notify();
    assert(
      root.innerHTML.includes(appCredentialStoreLabel(true)),
      "桌面壳必须说明密钥写入系统凭据管理器",
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
    store.ui.rightTab = "assistant";
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
    store.ui.rightTab = "assistant";
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
    store.ui.rightTab = "assistant";
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
    assert(await store.flush(), `pending saves must drain before direct project payload loading：${store.ui.toast}`);
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
    state.fingerprint = testFingerprint(cleanDisk, state.writes + 10);
    store.bridge.reloadExternalProject = async () => ({
      project: structuredClone(cleanDisk),
      fingerprint: structuredClone(state.fingerprint),
    });
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
      `执行记录写入失败不得影响课程保存状态：${store.ui.toast}`,
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
    store.ui.rightTab = "assistant";
    store.aiEditProvider("custom");
    assert(root.innerHTML.includes("已配置密钥"), "面板必须说明密钥已配置");
    assert(
      !root.innerHTML.includes(credential),
      "面板绝不能渲染密钥值",
    );
    assert(
      (root.innerHTML.includes(appCredentialStoreLabel(true)) ||
        root.innerHTML.includes(appCredentialStoreLabel(false))) &&
        root.innerHTML.includes("课程文件不含凭据"),
      "面板必须说明密钥保存于系统凭据存储且课程文件不含凭据",
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
    store.ui.rightTab = "assistant";

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
    store.ui.rightTab = "assistant";
    store.ui.aiInstruction = "保留这条输入";
    store.notify();
    assert(root.innerHTML.includes("还没有可用的模型连接"), "没有模型连接时助手应显示空状态");
    assert(root.innerHTML.includes("data-action=\"ai-toggle-settings\""), "空状态提供配置 AI 入口");
    assert(!root.innerHTML.includes('<select class="select" data-ai-provider>'), "助手不得保留连接选择器");
    store.aiCreateConnection();
    assert(root.innerHTML.includes("ai-settings-modal"), "AI 设置必须显示为独立弹窗");
    assert(root.innerHTML.includes("data-ai-api-protocol"), "设置必须支持三种协议");
    // Audit row 91 shortens the status label while preserving its separate connection state.
    assert(root.innerHTML.includes("连接：未保存"), "连接配置保存状态应单独呈现");

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
    // design §2: the subscription block renders as the「订阅登录」segment of the
    // add card, so the test opens that segment before looking at it.
    store.aiCreateConnection();
    store.aiSetAddTab("subscription");
    store.notify();
    assert(
      root.innerHTML.includes("此环境不支持订阅登录，请使用桌面版 Workbench。"),
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
      /没有读回/.test(String(store.ui.toast)) && /凭据存储|钥匙串/.test(String(store.ui.toast)),
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

/* ------------------------------------------------------------------ *
 * P2 — 模型目录行（design §4.1）、「选择模型」弹窗（§4.2）、model_meta（§4.3）
 * ------------------------------------------------------------------ */

Deno.test("capacity inputs accept DSH's K/M suffixes and refuse anything else", () => {
  const inherit = aiParseCapacity("");
  assert(inherit.ok, "空输入=继承适配器默认，不是错误");
  const spaced = aiParseCapacity("   ");
  assert(spaced.ok, "纯空白同样按空输入处理");
  for (const [text, expected] of [
    ["256K", 256000],
    ["1M", 1000000],
    ["1.5M", 1500000],
    ["131072", 131072],
    ["0.5K", 500],
    ["2k", 2000],
    ["3m", 3000000],
  ] as Array<[string, number]>) {
    const parsed = aiParseCapacity(text);
    assert(parsed.ok, `${text} 必须是合法容量`);
    assert(parsed.ok && parsed.value === expected,
      `${text} 必须解析为 ${expected}，实际 ${String(parsed.ok ? parsed.value : "")}`);
  }
  for (const bad of ["abc", "-1", "0", "1.0001K", "1.2.3", "M", "1K2", "8192 tokens"]) {
    const parsed = aiParseCapacity(bad);
    assert(!parsed.ok, `「${bad}」必须被拒绝`);
    assert(!parsed.ok && parsed.message === AI_CAPACITY_INVALID_MESSAGE,
      "容量非法文案必须逐字使用 design §3 的句子");
  }
  assert(aiFormatCapacity(2000000) === "2M", "整百万显示为 xM");
  assert(aiFormatCapacity(1500000) === "1500K", "非整百万按整千显示");
  assert(aiFormatCapacity(128000) === "128K", "整千显示为 xK");
  assert(aiFormatCapacity(12345) === "12345", "其他数字原样显示");
});

Deno.test("the model catalog renders editable rows with order, edit and remove", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    state.providers.push({
      id: "row-models",
      label: "模型行连接",
      kind: "openai_compatible",
      base_url: "https://rows.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "model-a",
      models: ["model-a", "model-b"],
      model_meta: {
        "model-a": {
          name: "甲模型",
          context_window: 128000,
          max_tokens: 8192,
          input: ["text", "image"],
        },
      },
    });
    await store.aiLoadProviders();
    store.aiEditProvider("row-models", { preserveSelection: true });
    // 模型目录在「自定义设置」折叠区内（design §2.1）。
    store.aiToggleAdvanced();
    store.notify();
    const rows = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    assert(rows.length === 2, "两个模型必须是两行，而不是两个 chip");
    assert(rows[0]!.name === "甲模型", "已保存的显示名必须进入模型行");
    assert(rows[0]!.context_window === "128K", "容量按 DSH 记法回显（128K）");
    assert(rows[0]!.max_tokens === "8192", "最大输出按原样回显");
    assert(
      rows[0]!.input_text === true && rows[0]!.input_image === true && rows[0]!.input_declared === true,
      "已保存的输入类型必须进入模型行",
    );
    assert(rows[1]!.name === "" && rows[1]!.context_window === "", "没有元数据的模型不得凭空补值");
    let html = String(root.innerHTML);
    assert(html.includes("data-ai-model-rows"), "模型目录必须渲染模型行容器");
    assert(
      html.includes('data-action="ai-move-model"') && html.includes('data-dir="up"') &&
        html.includes('data-dir="down"'),
      "每行行头必须有↑/↓排序按钮",
    );
    assert(html.includes('data-action="ai-edit-model"') && html.includes("编辑"), "每行必须能「编辑」/「收起」");
    assert(html.includes('data-action="ai-remove-model"') && html.includes("移除"), "每行必须能「移除」");
    assert(html.includes('class="ai-model-id"'), "行头必须以等宽字体显示 Model ID");
    store.aiToggleModelRow(rows[0]!.key);
    store.notify();
    html = String(root.innerHTML);
    assert(html.includes(">Model ID<"), "展开体必须有 Model ID 字段");
    assert(html.includes("显示名称"), "展开体必须有显示名称字段");
    assert(html.includes('placeholder="留空显示 Model ID"'), "显示名称占位文案必须逐字");
    assert(html.includes("上下文窗口") && html.includes("最大输出 token"), "展开体必须有两列容量");
    assert(
      html.includes("data-ai-model-context") && html.includes("data-ai-model-max-tokens"),
      "两个容量输入必须可编辑",
    );
    assert(html.includes("输入类型") && html.includes("文本") && html.includes("图片"), "展开体必须有输入类型复选框");
    assert(html.includes('value="128K"') && html.includes('value="8192"'), "已保存容量必须显示在行内输入框");
    assert(html.includes('value="甲模型"'), "已保存显示名必须显示在行内输入框");
  } finally {
    restore();
  }
});

Deno.test("moving a model row keeps its expanded state and half-typed capacity", async () => {
  const { store, state, restore } = await bootStore();
  try {
    state.providers.push({
      id: "move-models",
      label: "排序连接",
      kind: "openai_compatible",
      base_url: "https://move.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "model-a",
      models: ["model-a", "model-b"],
    });
    await store.aiLoadProviders();
    store.aiEditProvider("move-models", { preserveSelection: true });
    const rows = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    const second = rows[1]!;
    store.aiToggleModelRow(second.key);
    // 半填容量只在保存前解析，必须随行移动保留。
    store.aiSyncModelRowField(second.key, "context_window", "1.5");
    store.aiMoveModelRow(second.key, "up");
    const after = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    assert(after[0]!.key === second.key, "上移必须把该行放到前面");
    assert(after[1]!.key === rows[0]!.key, "另一行必须跟着下移");
    assert(after[0]!.expanded === true, "展开状态必须随行移动保留");
    assert(after[0]!.context_window === "1.5", "未输完的容量必须随行移动保留");
    assert(
      (store.ui.aiProviderForm.models as string[]).join(",") === "model-b,model-a",
      "模型顺序必须跟随行顺序",
    );
    store.aiMoveModelRow(second.key, "down");
    assert(
      (store.ui.aiProviderForm.modelRows as Array<Record<string, any>>).map((row) => row.key).join(",") ===
        rows.map((row) => row.key).join(","),
      "下移必须能还原顺序",
    );
  } finally {
    restore();
  }
});

Deno.test("model row validation names the empty and duplicated Model ID on its row", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    state.providers.push({
      id: "validate-models",
      label: "校验连接",
      kind: "openai_compatible",
      base_url: "https://validate.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "model-a",
      models: ["model-a"],
    });
    await store.aiLoadProviders();
    store.aiEditProvider("validate-models", { preserveSelection: true });
    store.aiToggleAdvanced();
    store.aiAddManualModel();
    const rows = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    const added = rows[rows.length - 1]!;
    store.aiValidateModelRowField(added.key, "id");
    store.notify();
    assert(
      String(root.innerHTML).includes(AI_MODEL_ID_REQUIRED_MESSAGE),
      "空 Model ID 的提示必须逐字「Model ID 不能为空。」并挂在行上",
    );
    store.aiSyncModelRowField(added.key, "id", "model-a");
    store.aiValidateModelRowField(added.key, "id");
    store.notify();
    assert(
      String(root.innerHTML).includes("Model ID 不能重复：model-a"),
      "重复 Model ID 的提示必须逐字带上重复的 id",
    );
    const savesBefore = state.calls.filter((call) => call.command === "ai.connection.save").length;
    assert(
      (await store.aiSaveProvider({
        id: "validate-models",
        label: "校验连接",
        base_url: "https://validate.example.test/v1",
        api_protocol: "openai-completions",
      })) === false,
      "重复的 Model ID 必须拦下保存",
    );
    assert(
      state.calls.filter((call) => call.command === "ai.connection.save").length === savesBefore,
      "校验失败不得调用保存命令",
    );
    assert(String(store.ui.toast).includes("Model ID 不能重复：model-a"), "拒绝原因必须可读");
    // 离开容量字段时，消息同样挂到对应行。
    store.aiSyncModelRowField(rows[0]!.key, "max_tokens", "abc");
    store.aiValidateModelRowField(rows[0]!.key, "max_tokens");
    store.notify();
    assert(
      String(root.innerHTML).includes(AI_CAPACITY_INVALID_MESSAGE),
      "非法容量的提示必须逐字挂在对应行",
    );
  } finally {
    restore();
  }
});

Deno.test("「＋ 添加模型」adds one expanded row and puts the caret in its Model ID", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    state.providers.push({
      id: "add-model",
      label: "手填连接",
      kind: "openai_compatible",
      base_url: "https://add.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "",
      models: [],
    });
    await store.aiLoadProviders();
    store.aiEditProvider("add-model", { preserveSelection: true });
    store.aiToggleAdvanced();
    store.notify();
    assert(
      String(root.innerHTML).includes("暂无模型，可手动添加 Model ID。"),
      "空目录必须保留 DSH 的空态文案",
    );
    store.aiAddManualModel();
    const rows = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    const added = rows[rows.length - 1]!;
    assert(rows.length === 1, "「＋ 添加模型」必须只加一行");
    assert(added.expanded === true, "新行必须展开");
    const focusKey = `data-focus-key="ai-model-id-${added.key}"`;
    assert(String(root.innerHTML).includes(focusKey), "Model ID 输入必须带该行的 focus key");
    assert(
      String(root.innerHTML).split(focusKey).length === 2,
      "focus key 必须唯一指向新行，光标才会落进它的 Model ID 输入",
    );
  } finally {
    restore();
  }
});

Deno.test("「获取可用模型」opens the「选择模型」dialog whose ticks are the model list", async () => {
  const { store, state, root, restore } = await bootStore();
  const globalScope = globalThis as typeof globalThis & { confirm?: (message?: string) => boolean };
  const previousConfirm = globalScope.confirm;
  globalScope.confirm = () => true;
  try {
    state.providers.push({
      id: "picker-provider",
      label: "弹窗连接",
      kind: "openai_compatible",
      base_url: "https://picker.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "keep-model",
      models: ["keep-model"],
    });
    state.secrets.set("picker-provider", "local-key");
    state.modelsByProvider = {
      "picker-provider": ["keep-model", "new-model", "other-model"],
    };
    await store.aiLoadProviders();
    store.aiEditProvider("picker-provider", { preserveSelection: true });
    const found = await store.aiDiscoverModels();
    assert(found.join(",") === "keep-model,new-model,other-model", "读取结果必须来自服务商");
    const picker = store.ui.aiModelPicker;
    assert(picker.open === true, "读取成功必须打开「选择模型」弹窗");
    assert(picker.models.length === 3, "候选必须来自这次读取");
    assert(
      picker.selected instanceof Set && picker.selected.has("keep-model"),
      "已配置的模型必须先勾上",
    );
    const html = String(root.innerHTML);
    assert(html.includes("选择模型"), "弹窗标题必须逐字「选择模型」");
    // Audit row 103 replaces the implementation-heavy explanation with the effect of selection.
    assert(html.includes("仅保留勾选的模型。"), "弹窗描述 must state which models remain");
    assert(html.includes('placeholder="搜索 Model ID"'), "搜索框占位必须逐字");
    assert(html.includes(">全选<") && html.includes(">取消全选<"), "必须有全选与取消全选");
    assert(html.includes(">更新列表<"), "主按钮必须逐字「更新列表」");
    assert(html.includes(">取消<"), "次按钮必须逐字「取消」");
    assert(html.includes("new-model"), "候选必须显示原始 Model ID");
    // 勾选的候选项把提供商公布的信息复制进可编辑行。
    store.ui.aiModelPicker = {
      open: true,
      search: "",
      selected: new Set(["rich-model"]),
      models: [{
        id: "rich-model",
        name: "富模型",
        context_window: "1M",
        max_tokens: "128K",
        input_text: true,
        input_image: true,
        input_declared: true,
      }],
      loading: false,
      error: null,
    };
    store.aiPickerConfirm();
    const rows = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    const adopted = rows.find((row) => row.id === "rich-model");
    assert(Boolean(adopted), "勾选的候选必须成为模型行");
    assert(adopted!.name === "富模型", "提供商公布的显示名必须复制进行");
    assert(adopted!.context_window === "1M", "公布的上下文窗口必须复制进行");
    assert(adopted!.max_tokens === "128K", "公布的最大输出必须复制进行");
    assert(
      adopted!.input_text === true && adopted!.input_image === true,
      "公布的输入类型必须复制进行",
    );
  } finally {
    globalScope.confirm = previousConfirm;
    restore();
  }
});

Deno.test("「更新列表」adopts ticks, removes unticked candidates and keeps unlisted rows", async () => {
  const { store, state, restore } = await bootStore();
  const globalScope = globalThis as typeof globalThis & { confirm?: (message?: string) => boolean };
  const previousConfirm = globalScope.confirm;
  globalScope.confirm = () => true;
  try {
    state.providers.push({
      id: "update-list",
      label: "更新连接",
      kind: "openai_compatible",
      base_url: "https://update.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "keep-model",
      models: ["keep-model", "manual-model"],
      model_meta: { "keep-model": { name: "保留行" } },
    });
    state.secrets.set("update-list", "local-key");
    state.modelsByProvider = { "update-list": ["keep-model", "new-model"] };
    await store.aiLoadProviders();
    store.aiEditProvider("update-list", { preserveSelection: true });
    // 用户在弹窗之前改过的行值必须保留。
    const rowsBefore = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    const keepRow = rowsBefore.find((row) => row.id === "keep-model")!;
    store.aiSyncModelRowField(keepRow.key, "name", "用户改过的名字");
    await store.aiDiscoverModels();
    store.ui.aiModelPicker.selected = new Set(["keep-model", "new-model"]);
    store.aiPickerConfirm();
    const rows = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    const ids = rows.map((row) => row.id).join(",");
    assert(
      ids === "keep-model,manual-model,new-model",
      `未列出的保留、新勾选的追加（实际 ${ids}）`,
    );
    const kept = rows.find((row) => row.id === "keep-model")!;
    assert(kept.name === "用户改过的名字", "已存在的行必须保留用户调整过的值");
    assert(store.ui.aiModelPicker.open === false, "更新列表后弹窗必须关闭");
    // 在候选中且取消勾选的已配置模型会被移除。
    await store.aiDiscoverModels();
    store.ui.aiModelPicker.selected = new Set(["keep-model", "new-model", "manual-model"]);
    store.aiPickerConfirm();
    await store.aiDiscoverModels();
    store.ui.aiModelPicker.selected = new Set(["keep-model", "manual-model"]);
    store.aiPickerConfirm();
    const trimmed = (store.ui.aiProviderForm.modelRows as Array<Record<string, any>>).map((row) => row.id).join(",");
    assert(trimmed === "keep-model,manual-model", "取消勾选的 new-model 必须被移除");
  } finally {
    globalScope.confirm = previousConfirm;
    restore();
  }
});

Deno.test("picker search keeps hidden ticks and 全选 only adds visible results", async () => {
  const { store, state, restore } = await bootStore();
  try {
    state.providers.push({
      id: "search-picker",
      label: "搜索连接",
      kind: "openai_compatible",
      base_url: "https://search.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "",
      models: [],
    });
    state.secrets.set("search-picker", "local-key");
    state.modelsByProvider = {
      "search-picker": ["alpha-model", "beta-model", "gamma-model"],
    };
    await store.aiLoadProviders();
    store.aiEditProvider("search-picker", { preserveSelection: true });
    await store.aiDiscoverModels();
    // 空目录=全选初值，先清空再单独勾一个，便于验证搜索不影响隐藏项。
    store.aiPickerClearAll();
    store.aiPickerToggle("alpha-model");
    store.aiPickerSearch("beta");
    assert(
      store.aiPickerVisibleModels().map((model) => model.id).join(",") === "beta-model",
      "搜索必须按 Model ID 过滤候选",
    );
    assert(
      store.ui.aiModelPicker.selected.has("alpha-model"),
      "搜索不得清掉被隐藏候选的勾选",
    );
    store.aiPickerSelectAll();
    assert(
      store.ui.aiModelPicker.selected.has("beta-model") && store.ui.aiModelPicker.selected.has("alpha-model"),
      "全选只加可见结果，隐藏的勾选保留",
    );
    assert(!store.ui.aiModelPicker.selected.has("gamma-model"), "全选不得添加被搜索隐藏的候选");
    store.aiPickerClearAll();
    assert(store.ui.aiModelPicker.selected.size === 0, "取消全选必须清空全部勾选");
    // 显示名同样参与搜索。
    store.ui.aiModelPicker.models[0]!.name = "阿尔法";
    store.aiPickerSearch("阿尔法");
    assert(
      store.aiPickerVisibleModels().map((model) => model.id).join(",") === "alpha-model",
      "搜索必须同时匹配显示名",
    );
  } finally {
    restore();
  }
});

Deno.test("an update that would empty the model list is refused (fetchKeepOne)", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    state.providers.push({
      id: "keep-one",
      label: "保底连接",
      kind: "openai_compatible",
      base_url: "https://keep.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "only-model",
      models: ["only-model"],
    });
    state.secrets.set("keep-one", "local-key");
    state.modelsByProvider = { "keep-one": ["only-model"] };
    await store.aiLoadProviders();
    store.aiEditProvider("keep-one", { preserveSelection: true });
    await store.aiDiscoverModels();
    store.aiPickerClearAll();
    assert(store.aiPickerWouldEmpty() === true, "把非空列表清空的更新必须被识别");
    const html = String(root.innerHTML);
    assert(html.includes("请至少保留一个勾选的模型。"), "禁用原因必须可读");
    assert(
      /data-action="ai-picker-confirm"[^>]*disabled/.test(html),
      "会清空列表的「更新列表」必须禁用",
    );
    const rowsBefore = (store.ui.aiProviderForm.modelRows as Array<Record<string, any>>).map((row) => row.id).join(",");
    store.aiPickerConfirm();
    const rowsAfter = (store.ui.aiProviderForm.modelRows as Array<Record<string, any>>).map((row) => row.id).join(",");
    assert(rowsBefore === rowsAfter, "被拒绝的更新不得改动模型目录");
    assert(store.ui.aiModelPicker.open === true, "被拒绝的更新不得关闭弹窗");
  } finally {
    restore();
  }
});

Deno.test("a saved model_meta rides through edit and save without losing a field", async () => {
  const { store, state, restore } = await bootStore();
  try {
    const meta = {
      "model-a": {
        name: "甲模型",
        context_window: 1500000,
        max_tokens: 8192,
        input: ["image", "text"],
        reasoning_efforts: { off: "off", medium: "medium" },
      },
    };
    state.providers.push({
      id: "meta-provider",
      label: "元数据连接",
      kind: "openai_compatible",
      base_url: "https://meta.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "model-a",
      models: ["model-a"],
      model_meta: structuredClone(meta),
    });
    await store.aiLoadProviders();
    store.aiEditProvider("meta-provider", { preserveSelection: true });
    assert(
      await store.aiSaveProvider({
        id: "meta-provider",
        label: "元数据连接",
        base_url: "https://meta.example.test/v1",
        api_protocol: "openai-completions",
        default_model: "model-a",
        models: ["model-a"],
      }),
      "编辑并保存必须成功",
    );
    const call = state.calls.filter((entry) => entry.command === "ai.connection.save").at(-1);
    const submitted = call?.input?.provider?.model_meta;
    assert(Boolean(submitted), "提交载荷必须携带 model_meta");
    assert(
      JSON.stringify(submitted) === JSON.stringify(meta),
      `编辑并保存不得丢字段（提交 ${JSON.stringify(submitted)}）`,
    );
    assert(
      JSON.stringify(state.providers.find((entry) => entry.id === "meta-provider")?.model_meta) ===
        JSON.stringify(meta),
      "本机保存的 model_meta 必须与提交一致",
    );
  } finally {
    restore();
  }
});

Deno.test("clearing the model metadata submits an explicit empty model_meta", async () => {
  const { store, state, restore } = await bootStore();
  try {
    state.providers.push({
      id: "clear-meta",
      label: "清空元数据",
      kind: "openai_compatible",
      base_url: "https://clear.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "model-a",
      models: ["model-a"],
      model_meta: { "model-a": { name: "甲模型", context_window: 128000 } },
    });
    await store.aiLoadProviders();
    store.aiEditProvider("clear-meta", { preserveSelection: true });
    assert(
      await store.aiSaveProvider({
        id: "clear-meta",
        label: "清空元数据",
        base_url: "https://clear.example.test/v1",
        api_protocol: "openai-completions",
        default_model: "model-a",
        models: ["model-a"],
        model_meta: {},
      }),
      "显式清空必须可保存",
    );
    const call = state.calls.filter((entry) => entry.command === "ai.connection.save").at(-1);
    assert(
      Boolean(call?.input?.provider) && "model_meta" in call!.input.provider,
      "清空元数据必须显式提交 model_meta 字段",
    );
    assert(
      JSON.stringify(call?.input?.provider?.model_meta) === "{}",
      "清空元数据必须提交空对象 model_meta: {}",
    );
    // 行内清空是同一件事：没有元数据的行不写条目。
    store.aiEditProvider("clear-meta", { preserveSelection: true });
    const rows = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    store.aiSyncModelRowField(rows[0]!.key, "name", "");
    store.aiSyncModelRowField(rows[0]!.key, "context_window", "");
    rows[0]!.input_declared = false;
    assert(
      await store.aiSaveProvider({
        id: "clear-meta",
        label: "清空元数据",
        base_url: "https://clear.example.test/v1",
        api_protocol: "openai-completions",
        default_model: "model-a",
        models: ["model-a"],
      }),
      "行内清空后必须仍可保存",
    );
    const secondCall = state.calls.filter((entry) => entry.command === "ai.connection.save").at(-1);
    assert(
      JSON.stringify(secondCall?.input?.provider?.model_meta) === "{}",
      "没有元数据的行必须提交空的 model_meta",
    );
  } finally {
    restore();
  }
});

Deno.test("a credential-shaped Model ID never carries a model_meta entry", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    state.providers.push({
      id: "token-model",
      label: "敏感 id 连接",
      kind: "openai_compatible",
      base_url: "https://token.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "gpt-token-preview",
      models: ["gpt-token-preview"],
    });
    await store.aiLoadProviders();
    store.aiEditProvider("token-model", { preserveSelection: true });
    store.aiToggleAdvanced();
    const rows = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    store.aiSyncModelRowField(rows[0]!.key, "name", "含 token 的模型");
    store.aiSyncModelRowField(rows[0]!.key, "context_window", "128K");
    assert(
      await store.aiSaveProvider({
        id: "token-model",
        label: "敏感 id 连接",
        base_url: "https://token.example.test/v1",
        api_protocol: "openai-completions",
        default_model: "gpt-token-preview",
        models: ["gpt-token-preview"],
      }),
      "模型 id 本身仍要能保存",
    );
    const call = state.calls.filter((entry) => entry.command === "ai.connection.save").at(-1);
    assert(
      JSON.stringify(call?.input?.provider?.model_meta) === "{}",
      "命中密钥形状正则的 Model ID 不能带 model_meta 条目",
    );
    assert(
      call?.input?.provider?.models?.join(",") === "gpt-token-preview",
      "Model ID 本身不受影响，仍进 models",
    );
    assert(
      String(root.innerHTML).includes(AI_MODEL_META_ID_MESSAGE),
      "前端必须给出可读提示，而不是让服务端拒绝整个保存",
    );
    assert(
      String(store.ui.toast || "").includes("已保存"),
      "保存不能因为元数据被跳过而失败",
    );
  } finally {
    restore();
  }
});

Deno.test("「恢复默认模型」returns to the saved list and says what it will discard", async () => {
  const { store, state, restore } = await bootStore();
  const globalScope = globalThis as typeof globalThis & { confirm?: (message?: string) => boolean };
  const previousConfirm = globalScope.confirm;
  try {
    state.providers.push({
      id: "reset-models",
      label: "恢复连接",
      kind: "openai_compatible",
      base_url: "https://reset.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "saved-model",
      models: ["saved-model"],
      model_meta: { "saved-model": { name: "已保存的名字" } },
    });
    await store.aiLoadProviders();
    store.aiEditProvider("reset-models", { preserveSelection: true });
    store.aiAddManualModel();
    const rows = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    store.aiSyncModelRowField(rows[rows.length - 1]!.key, "id", "typed-model");
    let prompt = "";
    globalScope.confirm = (message?: string) => {
      prompt = String(message || "");
      return false;
    };
    store.aiResetModels();
    assert(
      prompt === "恢复这个提供商的默认模型目录？当前的模型编辑会被丢弃。",
      "确认文案必须逐字（实际 ${prompt}）",
    );
    assert(
      (store.ui.aiProviderForm.modelRows as Array<Record<string, any>>).length === 2,
      "拒绝确认不得改动模型目录",
    );
    globalScope.confirm = () => true;
    store.aiResetModels();
    const restored = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    assert(
      restored.map((row) => row.id).join(",") === "saved-model",
      "恢复默认必须回到该连接已保存的模型列表",
    );
    assert(restored[0]!.name === "已保存的名字", "已保存的元数据必须一起回来");
    assert(
      (store.ui.aiProviderForm.models as string[]).join(",") === "saved-model",
      "模型顺序必须回到已保存的顺序",
    );
  } finally {
    globalScope.confirm = previousConfirm;
    restore();
  }
});

Deno.test("a model row must keep at least one input type", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    state.providers.push({
      id: "input-types",
      label: "输入类型连接",
      kind: "openai_compatible",
      base_url: "https://input.example.test/v1",
      api_protocol: "openai-completions",
      default_model: "model-a",
      models: ["model-a"],
    });
    await store.aiLoadProviders();
    store.aiEditProvider("input-types", { preserveSelection: true });
    const rows = store.ui.aiProviderForm.modelRows as Array<Record<string, any>>;
    const row = rows[0]!;
    // 默认只有「文本」：先勾「图片」，才能取消「文本」。
    store.aiToggleModelRowInput(row.key, "image", true);
    assert(
      store.aiModelRowByKey(row.key)!.input_image === true && store.aiModelRowByKey(row.key)!.input_declared === true,
      "勾选必须记入该行，并声明输入类型",
    );
    store.aiToggleModelRowInput(row.key, "text", false);
    const after = store.aiModelRowByKey(row.key)!;
    assert(after.input_text === false && after.input_image === true, "有另一种输入类型时允许取消「文本」");
    // 只剩一种时，取消最后一种必须被拒绝并说明原因。
    store.aiToggleModelRowInput(row.key, "image", false);
    const kept = store.aiModelRowByKey(row.key)!;
    assert(kept.input_image === true, "至少一种输入类型必须保留");
    assert(
      String(store.ui.toast).includes("输入类型至少要保留一种。"),
      "拒绝原因必须可读",
    );
    store.aiToggleModelRow(row.key);
    store.notify();
    // The refusal is a transient toast, not a row failure: the row itself must
    // stay error-free (the whole-page string would also match the toast slot).
    assert(
      String(root.innerHTML).includes("data-ai-model-error") === false,
      "没有失败的行不显示错误",
    );
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * design §2.1 / UI spec §2.5 — 推理等级（ai-reasoning）
 * ------------------------------------------------------------------ */

/** One provider whose model declares reasoning tiers, ready to edit. */
async function bootReasoningProvider(
  modelMeta: Record<string, unknown> | undefined,
  protocol = "openai-completions",
) {
  const handle = await bootStore();
  handle.state.providers.push({
    id: "reasoning-ui",
    label: "推理连接",
    kind: "openai_compatible",
    base_url: "https://reasoning.example.test/v1",
    api_protocol: protocol,
    default_model: "model-a",
    models: ["model-a"],
    ...(modelMeta ? { model_meta: modelMeta } : {}),
  });
  await handle.store.aiLoadProviders();
  handle.store.aiEditProvider("reasoning-ui", { preserveSelection: true });
  const row = (handle.store.ui.aiProviderForm.modelRows as Array<Record<string, any>>)[0]!;
  return { ...handle, row };
}

Deno.test("推理等级：开关、「?」说明与档位行按 design §2.1 渲染", async () => {
  const { store, root, row, restore } = await bootReasoningProvider({
    "model-a": { reasoning_efforts: { off: "off", medium: "medium" } },
  });
  try {
    assert(row.reasoning_enabled === true, "已存档位必须显示为开关打开");
    assert(row.tiers.map((tier: any) => tier.tier).join(",") === "off,medium", "档位按存档顺序成行");
    store.aiToggleAdvanced();
    store.aiToggleModelRow(row.key);
    const html = String(root.innerHTML);
    assert(html.includes("data-action=" + String.fromCharCode(34) + "ai-toggle-model-reasoning" + String.fromCharCode(34)), "必须渲染「推理等级」开关");
    assert(/data-action="ai-toggle-model-reasoning"[^>]*checked/.test(html), "开关必须显示为开");
    assert(html.includes("data-action=" + String.fromCharCode(34) + "ai-toggle-reasoning-help" + String.fromCharCode(34)), "标签旁必须有「?」说明按钮");
    assert(html.includes("data-action=" + String.fromCharCode(34) + "ai-add-tier" + String.fromCharCode(34)), "必须有「添加档位」");
    assert(html.includes("data-action=" + String.fromCharCode(34) + "ai-remove-tier" + String.fromCharCode(34)), "每档必须有「移除」");
    assert(html.includes("API 参数值"), "第二列必须叫「API 参数值」");
    assert(
      /data-ai-tier-value[^>]*data-tier-key="tier-1"[^>]*value="off"[^>]*disabled/.test(html),
      "off 行的 API 参数值输入必须禁用、已写值照常显示",
    );
    assert(
      /data-ai-tier-value[^>]*data-tier-key="tier-2"[^>]*value="medium"/.test(html) &&
        !/data-ai-tier-value[^>]*data-tier-key="tier-2"[^>]*disabled/.test(html),
      "思考档位行的参数值输入必须可编辑",
    );
    // Audit row 106 keeps the service-docs, default-tier and Off transmission rules concise.
    store.aiToggleReasoningHelp(row.key);
    const helped = String(root.innerHTML);
    assert(helped.includes("参数值以服务商文档为准。未指定档位时使用最强档；Off 不发送推理参数。"), "说明必须保留参数来源、默认档与 Off 规则");
  } finally {
    restore();
  }
});

Deno.test("推理等级开关：打开从四档起步，关闭=字段不存在，重开不恢复旧编辑", async () => {
  const { store, state, row, restore } = await bootReasoningProvider(undefined);
  try {
    assert(row.reasoning_enabled === false && row.tiers.length === 0, "没有声明时开关必须是关");
    store.aiToggleModelReasoning(row.key);
    assert(row.reasoning_enabled === true, "开关必须能打开");
    assert(
      row.tiers.map((tier: any) => tier.tier).join(",") === "off,low,medium,high",
      "打开开关总是从 off/low/medium/high 四行开始",
    );
    assert(
      row.tiers.every((tier: any) => tier.value === tier.tier),
      "每档 API 参数值初值=档位名",
    );
    store.aiRemoveTierRow(row.key, "tier-4");
    store.aiToggleModelReasoning(row.key);
    assert(row.reasoning_enabled === false && row.tiers.length === 0, "关闭开关必须清空档位行");
    store.aiToggleModelReasoning(row.key);
    assert(
      row.tiers.map((tier: any) => tier.tier).join(",") === "off,low,medium,high",
      "重新打开只恢复四档初始行，不恢复之前删掉的档位",
    );
    // 开关关闭 = 字段不存在：提交载荷不得带 reasoning_efforts。
    store.aiToggleModelReasoning(row.key);
    assert(
      await store.aiSaveProvider({
        id: "reasoning-ui",
        label: "推理连接",
        base_url: "https://reasoning.example.test/v1",
        api_protocol: "openai-completions",
        default_model: "model-a",
        models: ["model-a"],
      }) === true,
      "关闭推理等级后必须能保存",
    );
    const call = state.calls.filter((entry) => entry.command === "ai.connection.save").at(-1);
    const submitted = call?.input?.provider?.model_meta;
    assert(
      !submitted || !submitted["model-a"] || !("reasoning_efforts" in submitted["model-a"]),
      "开关关闭时该字段必须不存在（模型不推理、不下发任何推理参数）",
    );
  } finally {
    restore();
  }
});

Deno.test("推理等级：每档只能用一次，换档只在思考档之间保留自定义值", async () => {
  const { store, row, restore } = await bootReasoningProvider({
    "model-a": { reasoning_efforts: { off: "off", low: "low", medium: "medium", high: "high" } },
  });
  try {
    const options = aiReasoningTierOptions(row.tiers, "low");
    assert(!options.includes("medium"), "已用档位不得出现在别行的档位下拉里");
    assert(options.includes("low"), "本行自己的档位必须始终可选");
    // 每档只能用一次：换到已用档位被拒绝。
    store.aiChangeTierName(row.key, "tier-2", "medium");
    assert(row.tiers[1].tier === "low", "已用档位必须拒绝换入");
    // 自定义值只在两个思考档位之间保留。
    store.aiSyncTierValue(row.key, "tier-2", "  custom-low  ");
    assert(row.tiers[1].value === "custom-low", "参数值按输入保存（首尾空白去掉）");
    store.aiChangeTierName(row.key, "tier-2", "minimal");
    assert(row.tiers[1].value === "custom-low", "思考档之间换档必须保留自定义值");
    // 仍是旧档位名的参数值随之重置。
    store.aiSyncTierValue(row.key, "tier-2", "minimal");
    store.aiChangeTierName(row.key, "tier-2", "xhigh");
    assert(row.tiers[1].value === "xhigh", "旧档位名的参数值必须重置为新档位名");
    // 切到/切离 off 都重置。
    store.aiRemoveTierRow(row.key, "tier-1");
    store.aiChangeTierName(row.key, "tier-2", "off");
    assert(row.tiers[0].tier === "off" && row.tiers[0].value === "off", "切到 off 必须重置");
    store.aiChangeTierName(row.key, "tier-2", "low");
    assert(row.tiers[0].value === "low", "切离 off 必须重置");
  } finally {
    restore();
  }
});

Deno.test("推理等级：「添加档位」按升级顺序补档，档位用完即禁用", async () => {
  const { store, root, row, restore } = await bootReasoningProvider(undefined);
  try {
    store.aiToggleModelReasoning(row.key);
    store.aiAddTierRow(row.key);
    assert(
      row.tiers.map((tier: any) => tier.tier).join(",") === "off,low,medium,high,xhigh",
      "新档位必须接在最高已用档之上",
    );
    store.aiAddTierRow(row.key);
    store.aiAddTierRow(row.key);
    assert(
      row.tiers.map((tier: any) => tier.tier).join(",") === "off,low,medium,high,xhigh,max,minimal",
      "用完高档后回落到第一个未用档位",
    );
    store.aiToggleAdvanced();
    store.aiToggleModelRow(row.key);
    assert(
      /data-action="ai-add-tier"[^>]*disabled/.test(String(root.innerHTML)),
      "七档用完后「添加档位」必须禁用",
    );
  } finally {
    restore();
  }
});

Deno.test("推理等级校验：design §3 文案逐字，离开字段把档位名填回", async () => {
  // 没有 off 以外的档位（开关开着但只剩 off / 0 行）。
  const emptyCase = await bootReasoningProvider(undefined);
  try {
    const row = emptyCase.row;
    emptyCase.store.aiToggleModelReasoning(row.key);
    emptyCase.store.aiRemoveTierRow(row.key, "tier-2");
    emptyCase.store.aiRemoveTierRow(row.key, "tier-3");
    emptyCase.store.aiRemoveTierRow(row.key, "tier-4");
    assert(
      emptyCase.store.aiValidateModelRows() === AI_REASONING_REQUIRED_MESSAGE,
      "只剩 off 时必须是「推理等级至少要有一个思考档位，或关闭推理等级。」",
    );
    emptyCase.store.aiToggleAdvanced();
    emptyCase.store.aiToggleModelRow(row.key);
    assert(
      String(emptyCase.root.innerHTML).includes(AI_REASONING_REQUIRED_MESSAGE),
      "校验文案必须上屏",
    );
    assert(
      await emptyCase.store.aiSaveProvider({
        id: "reasoning-ui",
        label: "推理连接",
        base_url: "https://reasoning.example.test/v1",
        api_protocol: "openai-completions",
        default_model: "model-a",
        models: ["model-a"],
      }) === false,
      "校验不通过必须拒绝保存",
    );
  } finally {
    emptyCase.restore();
  }

  // off 以外档位缺值或空串。
  const missing = await bootReasoningProvider({ "model-a": { reasoning_efforts: { low: "" } } });
  try {
    const row = missing.row;
    assert(
      missing.store.aiValidateModelRows() === AI_REASONING_VALUE_REQUIRED_MESSAGE,
      "缺值必须是「每个思考档位都要填写 API 参数值。」",
    );
    missing.store.aiToggleAdvanced();
    missing.store.aiToggleModelRow(row.key);
    const html = String(missing.root.innerHTML);
    assert(html.includes(AI_REASONING_VALUE_REQUIRED_MESSAGE), "缺值文案必须上屏");
    assert(/data-ai-tier-value[^>]*aria-invalid="true"/.test(html), "无效输入必须标为无效");
    // 离开字段时把档位名填进去。
    missing.store.aiValidateTierValue(row.key, "tier-1");
    assert(row.tiers[0].value === "low", "离开字段必须把档位名填回");
    assert(missing.store.aiValidateModelRows() === "", "修好后校验必须通过");
  } finally {
    missing.restore();
  }
});

Deno.test("推理等级持久化：按行序写回 map，用户自定义键名不进渲染与提交", async () => {
  const plain = await bootReasoningProvider({
    "model-a": { reasoning_efforts: { off: "off", medium: "medium" } },
  });
  try {
    plain.store.aiSyncTierValue(plain.row.key, "tier-2", "budget-2048");
    assert(
      await plain.store.aiSaveProvider({
        id: "reasoning-ui",
        label: "推理连接",
        base_url: "https://reasoning.example.test/v1",
        api_protocol: "openai-completions",
        default_model: "model-a",
        models: ["model-a"],
      }) === true,
      "带推理等级必须能保存",
    );
    const call = plain.state.calls.filter((entry) => entry.command === "ai.connection.save").at(-1);
    const submitted = call?.input?.provider?.model_meta?.["model-a"]?.reasoning_efforts;
    assert(
      JSON.stringify(submitted) === JSON.stringify({ off: "off", medium: "budget-2048" }),
      "reasoning_efforts 必须按行序写回（off 键允许存值）",
    );
  } finally {
    plain.restore();
  }

  // 固定小写枚举之外的键名既不渲染、也不提交（CREDENTIAL_FIELD 红线）。
  const hostile = await bootReasoningProvider({
    "model-a": { reasoning_efforts: { api_key: "evil", Low: "x", low: "low", high: "high" } },
    "orphan-model": { reasoning_efforts: { token: "evil2", max: "max" } },
  });
  try {
    assert(
      hostile.row.tiers.map((tier: any) => tier.tier).join(",") === "low,high",
      "渲染路径只接受固定小写枚举档位",
    );
    assert(
      await hostile.store.aiSaveProvider({
        id: "reasoning-ui",
        label: "推理连接",
        base_url: "https://reasoning.example.test/v1",
        api_protocol: "openai-completions",
        default_model: "model-a",
        models: ["model-a"],
      }) === true,
      "带元数据必须能保存",
    );
    const call = hostile.state.calls.filter((entry) => entry.command === "ai.connection.save").at(-1);
    const meta = call?.input?.provider?.model_meta;
    const text = JSON.stringify(meta);
    assert(
      !text.includes("evil") && !text.includes("api_key") && !text.includes("Low"),
      "用户自定义键名不得进入提交路径",
    );
    assert(
      JSON.stringify(meta["model-a"].reasoning_efforts) === JSON.stringify({ low: "low", high: "high" }),
      "行内档位按行序重建，只留固定枚举键",
    );
    assert(
      JSON.stringify(meta["orphan-model"].reasoning_efforts) === JSON.stringify({ max: "max" }),
      "未知 id 条目保留（规则 3），但也只留固定档位键",
    );
  } finally {
    hostile.restore();
  }
});

Deno.test("已存的 false 在开关被操作前保持不变", async () => {
  const { store, state, row, restore } = await bootReasoningProvider({
    "model-a": { reasoning_efforts: false },
  });
  try {
    assert(row.reasoning_enabled === false && row.tiers.length === 0, "false 显示为开关关闭");
    assert(
      await store.aiSaveProvider({
        id: "reasoning-ui",
        label: "推理连接",
        base_url: "https://reasoning.example.test/v1",
        api_protocol: "openai-completions",
        default_model: "model-a",
        models: ["model-a"],
      }) === true,
      "未操作开关必须照常保存",
    );
    let call = state.calls.filter((entry) => entry.command === "ai.connection.save").at(-1);
    // The row keeps its untouched seed, but the SUBMITTED map must stay
    // schema-valid: the service accepts a map or an absent field, never `false`.
    assert(
      !("reasoning_efforts" in (call?.input?.provider?.model_meta?.["model-a"] ?? {})),
      "开关被操作前的 false 在提交时归一为字段缺失，否则服务端会拒收整个连接",
    );
    // 一旦操作过开关，关闭=字段不存在。
    store.aiToggleModelReasoning(row.key);
    store.aiToggleModelReasoning(row.key);
    assert(
      await store.aiSaveProvider({
        id: "reasoning-ui",
        label: "推理连接",
        base_url: "https://reasoning.example.test/v1",
        api_protocol: "openai-completions",
        default_model: "model-a",
        models: ["model-a"],
      }) === true,
      "操作开关后必须照常保存",
    );
    call = state.calls.filter((entry) => entry.command === "ai.connection.save").at(-1);
    const entry = call?.input?.provider?.model_meta?.["model-a"];
    assert(
      !entry || !("reasoning_efforts" in entry),
      "操作过后开关关闭=字段不存在",
    );
  } finally {
    restore();
  }
});


/* ------------------------------------------------------------------ *
 * 行为锁定（2026-10-24 独立验收测试缺口）：分段切换不丢草稿、行卡收起/重开
 * 保留草稿、两草稿槽互不丢弃，以及 design §2.2/§3 的渲染文案逐字。
 * ------------------------------------------------------------------ */

/**
 * design §2/§4.1：分段控件只换 `ui.aiAddTab`，草稿一直在 `ui.aiAddDraft` 槽里
 * ——在一段里填好的字段切到另一段、再切回来必须原样还在（含模型目录行）。
 */
Deno.test("「＋ 添加模型提供商」分段切换不丢草稿：切走再切回已填字段仍在", async () => {
  const { store, root, restore } = await bootStore();
  try {
    store.aiCreateConnection();
    store.aiSetProviderId("draft-tab-provider");
    store.aiSyncDraftField("label", "分段草稿显示名");
    store.aiSyncDraftField("base_url", "https://draft-tab.example.test/v1");
    store.aiAddManualModel();
    const rows = store.ui.aiAddDraft.modelRows as Array<Record<string, any>>;
    store.aiSyncModelRowField(rows[rows.length - 1]!.key, "id", "draft-tab-model");
    // 打字同步刻意不重渲染（保 IME/光标）；断言渲染值前先重渲染一次。
    store.notify();
    const typed = [
      'value="draft-tab-provider"',
      'value="分段草稿显示名"',
      'value="https://draft-tab.example.test/v1"',
      ">draft-tab-model<",
    ];
    let html = String(root.innerHTML);
    for (const snippet of typed) {
      assert(html.includes(snippet), `初始创建表单必须渲染已填字段：${snippet}`);
    }
    // 第三方模型提供商 → 自定义模型 API：同一张表单，值原样。
    store.aiSetAddTab("custom");
    html = String(root.innerHTML);
    assert(
      html.includes("支持兼容 OpenAI 或 Anthropic 协议的服务。"),
      "「自定义模型 API」段的用途说明必须逐字（design §2.2 D2）",
    );
    for (const snippet of typed) {
      assert(html.includes(snippet), `切到「自定义模型 API」不得丢弃已填字段：${snippet}`);
    }
    // 自定义模型 API → 订阅登录：面板换成订阅区，草稿仍留在槽里。
    store.aiSetAddTab("subscription");
    const draft = store.ui.aiAddDraft;
    assert(draft.providerId === "draft-tab-provider", "切到「订阅登录」不得丢弃 Provider ID 草稿");
    assert(draft.label === "分段草稿显示名", "切到「订阅登录」不得丢弃显示名草稿");
    assert(draft.base_url === "https://draft-tab.example.test/v1", "切到「订阅登录」不得丢弃 API 地址草稿");
    assert(
      (draft.modelRows as Array<Record<string, any>>).some((row) => row.id === "draft-tab-model"),
      "切到「订阅登录」不得丢弃模型目录草稿",
    );
    // 订阅登录 → 第三方模型提供商：切回来逐字段还原。
    store.aiSetAddTab("third-party");
    html = String(root.innerHTML);
    // Audit row 94 removes the tab's duplicate instructions; actions and fields remain visible.
    assert(html.includes(">获取可用模型</button>"), "第三方连接仍要保留模型读取入口");
    assert(!html.includes("填写服务商的地址、协议与 API 密钥"), "第三方表单不重复列出字段操作说明");
    for (const snippet of typed) {
      assert(html.includes(snippet), `切回「第三方模型提供商」已填字段必须仍在：${snippet}`);
    }
  } finally {
    restore();
  }
});

/**
 * design §4.1：行内编辑卡「收起」只收卡不丢草稿；重开同一 provider 走
 * `aiEditProvider` 的 reuse 分支，已填字段（含「自定义设置」展开态）原样回来。
 */
Deno.test("行内编辑卡「收起」后重开同一 provider：已填字段仍在（reuse 分支）", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    state.providers.push({
      id: "row-keep",
      label: "行内保留连接",
      kind: "openai_compatible",
      base_url: "https://row-keep.example.test/v1",
      api_protocol: "openai-completions",
      chat_path: "/chat/completions",
      default_model: "keep-model",
      models: ["keep-model"],
    });
    await store.aiLoadProviders();
    store.aiEditProvider("row-keep", { preserveSelection: true });
    // 「显示名称 / API 地址」在「自定义设置」折叠区内（design §2.1）。
    store.aiToggleAdvanced();
    store.aiSyncDraftField("label", "行内草稿显示名");
    store.aiSyncDraftField("base_url", "https://row-draft.example.test/v1");
    store.notify();
    let html = String(root.innerHTML);
    assert(html.includes('value="行内草稿显示名"'), "编辑卡必须先渲染已填显示名");
    assert(html.includes('value="https://row-draft.example.test/v1"'), "编辑卡必须先渲染已填地址");
    // 「收起」按钮走的就是 handleAction 的 ai-edit-connection 收起分支（与
    // ai-cancel-provider 同三步）：清临时密钥输入 + 关编辑卡 + notify，草稿留槽。
    store.aiClearTemporarySecretInputs();
    store.ui.aiOpenEditor = null;
    store.notify();
    html = String(root.innerHTML);
    assert(!html.includes('data-ai-editor="row"'), "收起后行内编辑卡必须不再渲染");
    assert(
      store.ui.aiRowDraft?.label === "行内草稿显示名" &&
        store.ui.aiRowDraft?.base_url === "https://row-draft.example.test/v1",
      "收起不得丢弃行卡草稿（design §4.1）",
    );
    store.aiEditProvider("row-keep", { preserveSelection: true });
    html = String(root.innerHTML);
    assert(html.includes('value="行内草稿显示名"'), "重开同一行必须复用草稿里的显示名");
    assert(html.includes('value="https://row-draft.example.test/v1"'), "重开同一行必须复用草稿里的地址");
    assert(html.includes("data-ai-base-url"), "重开同一行必须保留「自定义设置」展开态");
  } finally {
    restore();
  }
});

/**
 * design §2.1/§4.1：一次只展开一张编辑卡，但 `aiRowDraft` 与 `aiAddDraft`
 * 两个槽互不清空——开一张卡不得丢另一张的半填内容。
 */
Deno.test("行卡与新增卡两个草稿槽互不丢弃：开一张编辑卡不清另一张的草稿", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    state.providers.push({
      id: "row-slot",
      label: "槽位连接",
      kind: "openai_compatible",
      base_url: "https://row-slot.example.test/v1",
      api_protocol: "openai-completions",
      chat_path: "/chat/completions",
      default_model: "slot-model",
      models: ["slot-model"],
    });
    await store.aiLoadProviders();
    // 新增卡草稿。
    store.aiCreateConnection();
    store.aiSetProviderId("add-slot");
    store.aiSyncDraftField("label", "新增草稿显示名");
    store.aiSyncDraftField("base_url", "https://add-draft.example.test/v1");
    // 行卡草稿：打开行卡会收起新增卡（一次一张）。
    store.aiEditProvider("row-slot", { preserveSelection: true });
    store.aiToggleAdvanced();
    store.aiSyncDraftField("label", "行卡草稿显示名");
    store.aiSyncDraftField("base_url", "https://row-draft.example.test/v1");
    store.notify();
    let html = String(root.innerHTML);
    assert(html.includes('value="行卡草稿显示名"'), "行卡展开时必须渲染行卡草稿");
    assert(!html.includes('value="新增草稿显示名"'), "一次只展开一张编辑卡");
    assert(
      store.ui.aiAddDraft?.label === "新增草稿显示名" &&
        store.ui.aiAddDraft?.base_url === "https://add-draft.example.test/v1",
      "打开行卡不得清空新增卡草稿（design §4.1 两槽互不丢弃）",
    );
    // 切回新增卡：行卡收起，行卡草稿留槽。
    store.aiCreateConnection();
    html = String(root.innerHTML);
    assert(html.includes('value="新增草稿显示名"'), "重开新增卡必须还原新增卡草稿里的显示名");
    assert(html.includes('value="https://add-draft.example.test/v1"'), "重开新增卡必须还原新增卡草稿里的地址");
    assert(!html.includes('value="行卡草稿显示名"'), "新增卡展开时行卡必须收起");
    assert(
      store.ui.aiRowDraft?.label === "行卡草稿显示名" &&
        store.ui.aiRowDraft?.base_url === "https://row-draft.example.test/v1",
      "打开新增卡不得清空行卡草稿",
    );
    // 再重开同一行：行卡草稿原样回来。
    store.aiEditProvider("row-slot", { preserveSelection: true });
    html = String(root.innerHTML);
    assert(html.includes('value="行卡草稿显示名"'), "行卡草稿必须再次完整渲染");
    assert(html.includes('value="https://row-draft.example.test/v1"'), "行卡地址草稿必须再次完整渲染");
  } finally {
    restore();
  }
});

/** Audit row 88 removes the duplicate key helper; the field label, placeholder and actions remain. */
Deno.test("创建表单保留模型提供商和密钥操作入口", async () => {
  const { store, root, restore } = await bootStore();
  try {
    store.aiCreateConnection();
    const html = String(root.innerHTML);
    assert(html.includes(">创建提供商</button>"), "创建态主按钮文案必须逐字是「创建提供商」（design §2.2 B12）");
    assert(html.includes('placeholder="输入 API 密钥"'), "密钥输入必须保留可用提示");
    assert(html.includes("删除本机保存的密钥"), "删除密钥按钮文案必须逐字（design §3）");
  } finally {
    restore();
  }
});

/** Audit rows 92 and 100 shorten status while preserving the error and credential state. */
Deno.test("模型目录错误和离线连接器状态保留恢复信息", async () => {
  const { store, state, root, restore } = await bootStore();
  try {
    state.providers.push({
      id: "copy-provider",
      label: "文案连接",
      kind: "openai_compatible",
      base_url: "https://copy.example.test/v1",
      api_protocol: "openai-completions",
      chat_path: "/chat/completions",
      default_model: "copy-model",
      models: ["copy-model"],
    });
    state.secrets.set("copy-provider", "local-key-for-copy-test");
    await store.aiLoadProviders();
    store.aiEditProvider("copy-provider", { preserveSelection: true });
    // 让「获取可用模型」真实失败一次：错误走 bridgeError → aiFailureFrom → 渲染。
    const bridge = store.bridge as unknown as {
      command: (name: string, input?: Record<string, any>) => Promise<unknown>;
    };
    const realCommand = bridge.command;
    bridge.command = async (name, input) => {
      if (name === "ai.models.list") throw new Error("上游拒绝读取模型（测试）");
      return await realCommand(name, input ?? {});
    };
    try {
      const models = await store.aiDiscoverModels();
      assert(models.length === 0, "读取失败必须回到手工填写，而不是编造模型");
    } finally {
      bridge.command = realCommand;
    }
    const failed = String(root.innerHTML);
    assert(failed.includes("读取失败："), "读取失败原因必须可见");
    assert(
      failed.includes("可手动添加 Model ID"),
      "读取失败提示必须保留手动添加模型的路径",
    );
    // 离线连接器的凭据状态文案：新增卡 Provider ID 命中离线连接器时逐字渲染。
    store.aiCreateConnection();
    store.aiSetProviderId("fake");
    store.notify();
    assert(
      String(root.innerHTML).includes("无需密钥（离线连接器）。"),
      "离线连接器的凭据状态必须清楚",
    );
  } finally {
    restore();
  }
});



