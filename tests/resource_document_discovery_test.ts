import {
  appendBlock,
  createDocument,
  DesktopService,
  initializeContentStatuses,
  MemorySecretStore,
  type ProjectData,
} from "../src/domain/index.ts";
import type {
  ResourceDiscoveryDocumentContext,
  ResourceDiscoveryPlan,
  ResourceDiscoveryTask,
} from "../src/ui/contracts.ts";
import type {
  ResourceProviders,
  SourceFetchResult,
  WebSearchHit,
} from "../src/service/resource_providers.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function value<T>(result: { error?: { code: string } | null; value?: unknown }, label: string): T {
  assert(!result.error, `${label}: ${JSON.stringify(result.error)}`);
  return result.value as T;
}

type OpenState = {
  fingerprint: unknown;
  project_id: string;
  project_dir: string;
  lease_generation: string;
};

async function waitForTask(desktop: DesktopService, taskId: string): Promise<ResourceDiscoveryTask> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await desktop.queries.execute("resource.discovery.get", { task_id: taskId }) as ResourceDiscoveryTask | null;
    assert(task, "discovery task should remain queryable");
    if (["completed", "partial", "failed", "stale", "cancelled"].includes(task.state)) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("document-driven discovery task did not finish");
}

Deno.test("document discovery parses canonical Markdown, validates evidence, and persists editable search intent", async () => {
  const directory = await Deno.makeTempDir({ prefix: "acw-document-discovery-" });
  let desktop: DesktopService | null = new DesktopService(
    directory,
    { app_instance_id: `document-discovery-${crypto.randomUUID()}` },
    new MemorySecretStore(),
    {},
    new MemorySecretStore(),
  );
  let sourcePath: string | null = null;
  try {
    await desktop.open();
    const project = structuredClone(value<ProjectData>(
      await desktop.commands.execute("project.create", { title: "文档驱动搜索合同" }),
      "create project",
    ));
    const lessonId = crypto.randomUUID();
    const document = createDocument(project, lessonId);
    project.content_items.push({
      id: lessonId,
      project_id: project.project.id,
      stage_id: project.stages[0]?.id ?? null,
      code: "D-01",
      title: "极端高温应对",
      type: "lesson",
      description: "识别城市热风险与公共卫生应对措施。",
      order_index: 0,
      document_id: document.id,
      archived: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    initializeContentStatuses(project, lessonId);
    appendBlock(project, lessonId, "paragraph", "比较高温预警、避暑中心和社区健康服务的实际案例。");
    const firstState = value<OpenState>(
      await desktop.commands.execute("project.open_state", {}),
      "read project binding",
    );
    value(await desktop.commands.execute("project.save", {
      project,
      expected_fingerprint: firstState.fingerprint,
    }), "save lesson fixture");

    sourcePath = await Deno.makeTempFile({ suffix: ".md" });
    await Deno.writeTextFile(sourcePath, [
      "# Urban heat response",
      "",
      "Heat illness warning signs should guide public health action.",
      "",
      "Cooling centers and neighborhood outreach reduce risk during heat waves.",
    ].join("\n"));
    const openState = value<OpenState>(
      await desktop.commands.execute("project.open_state", {}),
      "refresh project binding",
    );
    const imported = value<{ asset: { id: string } }>(
      await desktop.commands.execute("asset.import", {
        source_path: sourcePath,
        filename: "urban-heat-outline.md",
        type: "document",
        mime_type: "text/markdown",
        project_dir: openState.project_dir,
        expected_project_id: openState.project_id,
        lease_generation: openState.lease_generation,
        editor_generation: 1,
        operation_id: crypto.randomUUID(),
        revision: 1,
        expected_fingerprint: openState.fingerprint,
      }),
      "import canonical outline",
    );
    const parsed = value<{
      asset_id: string;
      sha256: string;
      title: string;
      text: string;
      blocks: Array<{ index: number; text: string; locator: { block: number; section?: string } }>;
    }>(
      await desktop.commands.execute("resource.discovery.document.parse", { asset_id: imported.asset.id }),
      "parse canonical Markdown",
    );
    assert(parsed.asset_id === imported.asset.id && parsed.text.includes("Heat illness warning signs"), "parser reads the imported file bytes");

    const context: ResourceDiscoveryDocumentContext = {
      asset_id: parsed.asset_id,
      sha256: parsed.sha256,
      title: parsed.title,
      themes: [{
        name: "urban heat response",
        evidence: [{ text: "Heat illness warning signs", locator: parsed.blocks[1]!.locator }],
      }],
      concepts: ["urban heat risk"],
      objectives: ["identify warning signs"],
      case_types: ["community response"],
      media_types: ["interview", "news report"],
      keywords: ["heat illness"],
      language: "en",
      preferred_language: "zh",
      constraints: {
        terms: ["cooling center"],
        time_range: "2020 onward",
        regions: ["Phoenix"],
        industries: ["public health"],
      },
    };
    const invalid = await desktop.commands.execute("resource.discovery.prepare", {
      content_item_ids: [lessonId],
      search_types: ["web"],
      request_budget: 20,
      preferences: { per_lesson_limit: 2, language: "fr" },
      document_context: {
        ...context,
        themes: [{
          name: "invented theme",
          evidence: [{ text: "text absent from the source", locator: parsed.blocks[1]!.locator }],
        }],
      },
    });
    assert(invalid.error?.code === "invalid_input", "forged model evidence is rejected at the service boundary");

    const plan = value<ResourceDiscoveryPlan>(
      await desktop.commands.execute("resource.discovery.prepare", {
        content_item_ids: [lessonId],
        search_types: ["web"],
        request_budget: 20,
        preferences: { per_lesson_limit: 2, language: "fr" },
        document_context: context,
        intent_overrides: { themes: ["heat warning systems"], keywords: ["hospital admissions"] },
      }),
      "prepare document-driven discovery",
    );
    const query = plan.queries[0]!.queries[0]!.query;
    assert(plan.document_context?.language === "en" && plan.document_context.preferred_language === "zh", "plan keeps source and preferred languages distinct");
    assert(query.includes("heat warning systems") && query.includes("hospital admissions"), "user-edited topic and keyword drive the prepared query");
    for (const term of ["cooling center", "2020 onward", "Phoenix", "public health", "interview", "fr"]) {
      assert(query.includes(term), `document constraint/media/language is preserved in query: ${term}`);
    }

    const provider = desktop.resourceProviders as ResourceProviders;
    const dispatchedQueries: string[] = [];
    provider.searchWeb = async (input) => {
      dispatchedQueries.push(input.query);
      input.onRequest?.();
      return [{
        provider_id: "brave_search",
        transport: "mock",
        request_id: "test-search-1",
        requested_at: new Date().toISOString(),
        fetched_at: new Date().toISOString(),
        query: input.query,
        title: "Heat safety public health report",
        url: "https://example.org/heat-safety",
        description: "Explicit mock provider result.",
        publisher: "Example public health office",
        page_age: null,
        published_at: null,
      } satisfies WebSearchHit];
    };
    provider.fetchSource = async (input): Promise<SourceFetchResult> => ({
      provider_id: "brave_search",
      transport: "mock",
      request_id: "test-read-1",
      requested_at: new Date().toISOString(),
      fetched_at: new Date().toISOString(),
      query: input.query ?? "",
      url: input.url,
      title: "Heat safety public health report",
      publisher: "Example public health office",
      text: "Mock page text, injected for a contract test.",
      excerpt: "Mock page text, injected for a contract test.",
      truncated: false,
      evidence_access: "content_read",
      content_hash: "a".repeat(64),
      limitations: ["Injected mock provider; not live-network evidence."],
    });
    const started = value<ResourceDiscoveryTask>(
      await desktop.commands.execute("resource.discovery.start", {
        plan_id: plan.plan_id,
        input_hash: plan.input_hash,
        authorized: true,
      }),
      "start explicit mock search",
    );
    const completed = await waitForTask(desktop, started.task_id);
    assert(completed.state === "completed", "injected mock provider completes the task");
    assert(dispatchedQueries[0]?.includes("cooling center"), "the provider receives document constraints");
    assert(completed.candidates[0]?.matched_themes?.includes("heat warning systems"), "progressive candidate retains its topic match");

    await desktop.close();
    desktop = new DesktopService(
      directory,
      { app_instance_id: `document-discovery-reopen-${crypto.randomUUID()}` },
      new MemorySecretStore(),
      {},
      new MemorySecretStore(),
    );
    await desktop.open();
    value<OpenState & { project: ProjectData }>(
      await desktop.commands.execute("project.open_state", {}),
      "reopen project with document task",
    );
    const recovered = await desktop.queries.execute("resource.discovery.plan", { plan_id: plan.plan_id }) as ResourceDiscoveryPlan | null;
    assert(recovered?.document_context?.asset_id === imported.asset.id, "reopen restores the document-bound plan without another parse");
    const recoveredTask = await desktop.queries.execute("resource.discovery.get", { task_id: started.task_id }) as ResourceDiscoveryTask | null;
    assert(recoveredTask?.candidates[0]?.matched_themes?.includes("heat warning systems"), "reopen preserves completed candidates");
  } finally {
    if (desktop) await desktop.close();
    if (sourcePath) await Deno.remove(sourcePath).catch(() => undefined);
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
