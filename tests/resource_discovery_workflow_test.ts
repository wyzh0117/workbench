import {
  addLayoutPage,
  addLayoutSection,
  addPlacement,
  appendBlock,
  assignStatus,
  createDocument,
  createEmptyProjectData,
  createLayoutInstance,
  createLayoutTemplate,
  DesktopService,
  initializeContentStatuses,
  lessonProgress,
  MemorySecretStore,
  migrateProject,
  type ProjectData,
  type ResourceItem,
  type ResourceUsage,
  serializeProject,
  type SourceEvidence,
} from "../src/domain/index.ts";
import type {
  ResourceCandidate,
  ResourceCandidateAcceptInput,
  ResourceDiscoveryPlan,
  ResourceDiscoveryTask,
} from "../src/ui/contracts.ts";
import type {
  ResourceProviders,
  SourceFetchResult,
  VideoHit,
  WebSearchHit,
} from "../src/service/resource_providers.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function acceptedValue<T>(
  result: {
    error?: { code: string; user_message: string } | null;
    value?: unknown;
  },
  label: string,
): T {
  assert(!result.error, `${label}: ${JSON.stringify(result.error)}`);
  return result.value as T;
}

type OpenState = {
  fingerprint: unknown;
  project_id: string;
  project_dir: string;
  lease_generation: string;
};

function addLesson(project: ProjectData, title: string, order: number): string {
  const id = crypto.randomUUID();
  const stage = project.stages[0] ?? null;
  const document = createDocument(project, id);
  project.content_items.push({
    id,
    project_id: project.project.id,
    stage_id: stage?.id ?? null,
    code: stage
      ? `${stage.code}-${String(order + 1).padStart(2, "0")}`
      : `C${String(order + 1).padStart(2, "0")}`,
    title,
    type: "lesson",
    description: "资源发现集成测试",
    order_index: order,
    document_id: document.id,
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  initializeContentStatuses(project, id);
  appendBlock(
    project,
    id,
    "paragraph",
    `${title} 的课程正文：河畔洪水疏散与社区应对案例。`,
  );
  return id;
}

function videoHit(
  query: string,
  requestId: string,
  videoId: string,
  duration: number | null,
  durationClass: VideoHit["duration_class"],
): VideoHit {
  const iso = duration === null ? null : duration === 240 ? "PT4M" : "PT8M1S";
  return {
    provider_id: "youtube_data_api",
    transport: "mock",
    request_id: requestId,
    requested_at: "2026-10-21T01:00:00.000Z",
    fetched_at: "2026-10-21T01:00:01.000Z",
    query,
    provider_video_id: videoId,
    title: "河畔洪水疏散事件：教学视频",
    url: `https://www.youtube.com/watch?v=${videoId}`,
    channel_title: "明确标记的测试频道",
    published_at: null,
    description: "测试 provider 的结构化视频元数据。",
    duration_iso8601: iso,
    total_duration_sec: duration,
    region_availability: "unknown",
    spoken_language: null,
    captions_available: null,
    embeddable: null,
    duration_class: durationClass,
    metadata_limitations: ["Explicit mock provider; not live search evidence."],
  };
}

function applyFixtureLessonDeletion(
  project: ProjectData,
  lessonId: string,
): void {
  const documentIds = new Set(
    project.documents.filter((doc) => doc.content_item_id === lessonId).map((
      doc,
    ) => doc.id),
  );
  const blockIds = new Set(
    project.blocks.filter((block) => documentIds.has(block.document_id)).map((
      block,
    ) => block.id),
  );
  project.blocks = project.blocks.filter((block) =>
    !documentIds.has(block.document_id)
  );
  project.documents = project.documents.filter((doc) =>
    !documentIds.has(doc.id)
  );
  project.requirements = project.requirements.filter((row) =>
    row.content_item_id !== lessonId && !blockIds.has(row.anchor_block_id ?? "")
  );
  project.asset_usages = project.asset_usages.filter((row) =>
    row.content_item_id !== lessonId && !blockIds.has(row.block_id ?? "")
  );
  project.resource_usages = project.resource_usages.filter((row) =>
    row.lesson_id !== lessonId
  );
  project.status_assignments = project.status_assignments.filter((row) =>
    row.content_item_id !== lessonId
  );
  project.slide_plans = project.slide_plans.filter((row) =>
    row.lesson_id !== lessonId
  );
  project.content_items = project.content_items.filter((row) =>
    row.id !== lessonId
  );
  const remaining = project.content_items.filter((row) =>
    row.stage_id === project.stages[0]?.id && !row.archived
  )
    .sort((a, b) => a.order_index - b.order_index);
  remaining.forEach((item, index) => {
    item.order_index = index;
    if (item.stage_id) {
      const stage = project.stages.find((row) => row.id === item.stage_id);
      if (stage) {
        item.code = `${stage.code}-${String(index + 1).padStart(2, "0")}`;
      }
    }
  });
}

async function waitForTask(
  desktop: DesktopService,
  taskId: string,
): Promise<ResourceDiscoveryTask> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await desktop.queries.execute("resource.discovery.get", {
      task_id: taskId,
    }) as ResourceDiscoveryTask | null;
    assert(task, "resource.discovery.get should return the started task");
    if (
      ["completed", "partial", "failed", "stale", "cancelled"].includes(
        task.state,
      )
    ) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("resource discovery task did not reach a terminal state");
}

Deno.test("public resource discovery flow shares evidence and usages across review, reopen, and lesson deletion", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-resource-discovery-flow-",
  });
  let desktop: DesktopService | null = new DesktopService(
    directory,
    { app_instance_id: `resource-discovery-${crypto.randomUUID()}` },
    new MemorySecretStore(),
    {},
    new MemorySecretStore(),
  );
  let requestCount = 0;
  let webSearchCount = 0;
  let videoSearchCount = 0;
  const transport = desktop.resourceProviders as ResourceProviders;
  const beforeRequest = (input: { onRequest?: () => void }) => {
    input.onRequest?.();
    requestCount += 1;
  };
  transport.searchWeb = async (input) => {
    beforeRequest(input);
    webSearchCount += 1;
    const suffix = webSearchCount === 1 ? "news-report" : "agency-timeline";
    const publisher = webSearchCount === 1
      ? "Riverside Daily"
      : "Emergency Agency";
    const title = webSearchCount === 1
      ? "Riverside flood evacuation event — news report"
      : "Riverside flood evacuation event — agency timeline";
    const hit: WebSearchHit = {
      provider_id: "brave_search",
      transport: "mock",
      request_id: `brave-search-${webSearchCount}`,
      requested_at: "2026-10-21T01:00:00.000Z",
      fetched_at: "2026-10-21T01:00:01.000Z",
      query: input.query,
      title,
      url: `https://${
        webSearchCount === 1 ? "news" : "agency"
      }.example.test/${suffix}`,
      description:
        "Two independent mock sources describe the same Riverside flood evacuation event.",
      publisher,
      page_age: null,
      published_at: null,
    };
    return [hit];
  };
  transport.fetchSource = async (input): Promise<SourceFetchResult> => {
    beforeRequest(input);
    const publisher = input.url.includes("news.example.test")
      ? "Riverside Daily"
      : "Emergency Agency";
    return {
      provider_id: "brave_search",
      transport: "mock",
      request_id: `source-${new URL(input.url).pathname.slice(1)}`,
      requested_at: "2026-10-21T01:00:01.000Z",
      fetched_at: "2026-10-21T01:00:02.000Z",
      query: input.query ?? "",
      url: input.url,
      title: `Riverside flood evacuation event — ${publisher}`,
      publisher,
      excerpt:
        "Mock page content describes the same flood evacuation and response timeline.",
      evidence_access: "content_read",
      content_hash: "a".repeat(64),
      limitations: ["Explicit mock source fetch; not live web evidence."],
    };
  };
  transport.searchVideos = async (input) => {
    beforeRequest(input);
    videoSearchCount += 1;
    const requestId = `youtube-search-${videoSearchCount}`;
    return [
      videoHit(input.query, requestId, "samevideo01", 240, "target"),
      videoHit(input.query, requestId, "unknownv001", null, "unknown"),
      videoHit(input.query, requestId, "outvid00001", 481, "outside"),
    ];
  };

  try {
    await desktop.open();
    const created = await desktop.commands.execute("project.create", {
      title: "资源发现验收",
    });
    const project = structuredClone(
      acceptedValue<ProjectData>(created, "create project"),
    );
    const firstLessonId = addLesson(project, "第一课：洪水预警", 0);
    const secondLessonId = addLesson(project, "第二课：应急响应", 1);
    const firstState = acceptedValue<OpenState>(
      await desktop.commands.execute("project.open_state", {}),
      "open project before fixture save",
    );
    const fixtureSave = await desktop.commands.execute("project.save", {
      project,
      expected_fingerprint: firstState.fingerprint,
    });
    acceptedValue(fixtureSave, "save two lesson fixture");

    const openState = acceptedValue<OpenState>(
      await desktop.commands.execute("project.open_state", {}),
      "open prepared project",
    );
    let expectedFingerprint = openState.fingerprint;
    let editorGeneration = 1;
    let revision = 1;
    const mutationBinding = () => ({
      project_dir: openState.project_dir,
      expected_project_id: openState.project_id,
      lease_generation: openState.lease_generation,
      editor_generation: editorGeneration++,
      operation_id: crypto.randomUUID(),
      revision: revision++,
      expected_fingerprint: expectedFingerprint,
    });
    const recordCommit = (result: { mutation_ack?: unknown }) => {
      const ack = result.mutation_ack as { fingerprint?: unknown } | undefined;
      assert(
        ack?.fingerprint,
        "successful canonical acceptance should return a fresh fingerprint",
      );
      expectedFingerprint = ack.fingerprint;
    };

    const prepare = acceptedValue<ResourceDiscoveryPlan>(
      await desktop.commands.execute("resource.discovery.prepare", {
        content_item_ids: [firstLessonId, secondLessonId],
        search_types: ["web", "video"],
        request_budget: 20,
        preferences: {
          per_lesson_limit: 3,
          language: "en",
          target_min_sec: 240,
          target_max_sec: 360,
          wide_min_sec: 180,
          wide_max_sec: 480,
        },
      }),
      "prepare resource discovery",
    );
    assert(
      prepare.context_preview.items.length === 2,
      "prepare should expose both lesson excerpts for review",
    );
    assert(
      prepare.budget.required_upper_bound === 16,
      "plan should disclose the conservative request upper bound",
    );
    const started = acceptedValue<ResourceDiscoveryTask>(
      await desktop.commands.execute("resource.discovery.start", {
        plan_id: prepare.plan_id,
        input_hash: prepare.input_hash,
        authorized: true,
      }),
      "start authorized mock search",
    );
    const completed = await waitForTask(desktop, started.task_id);
    assert(
      completed.state === "completed",
      `mock discovery should complete: ${completed.state}`,
    );
    assert(
      requestCount === 6 && completed.budget.completed_requests === 6,
      "budget should count every mock HTTP dispatch, including page reads",
    );
    assert(
      webSearchCount === 2 && videoSearchCount === 2,
      "each lesson should run both provider searches",
    );

    const firstWeb = completed.candidates.find((candidate) =>
      candidate.lesson_id === firstLessonId && candidate.medium === "text"
    );
    const secondWeb = completed.candidates.find((candidate) =>
      candidate.lesson_id === secondLessonId && candidate.medium === "text"
    );
    const firstVideo = completed.candidates.find((candidate) =>
      candidate.lesson_id === firstLessonId &&
      candidate.video?.provider_video_id === "samevideo01"
    );
    const secondVideo = completed.candidates.find((candidate) =>
      candidate.lesson_id === secondLessonId &&
      candidate.video?.provider_video_id === "samevideo01"
    );
    const unknownVideo = completed.candidates.find((candidate) =>
      candidate.lesson_id === firstLessonId &&
      candidate.video?.provider_video_id === "unknownv001"
    );
    assert(
      firstWeb && secondWeb && firstVideo && secondVideo && unknownVideo,
      "inbox review should show both event sources, the shared video, and unknown-duration candidate",
    );
    assert(
      unknownVideo.video?.total_duration_sec === null &&
        unknownVideo.duration_class === "unknown",
      "unknown duration must remain unknown in the inbox",
    );
    assert(
      !completed.candidates.some((candidate) =>
        candidate.video?.provider_video_id === "outvid00001"
      ),
      "out-of-range videos must not become candidates",
    );
    assert(
      firstVideo.video?.total_duration_sec === 240,
      "the exact lower target-duration boundary should be retained",
    );

    const accept = async (
      candidate: ResourceCandidate,
      lessonId: string,
      extra: Partial<ResourceCandidateAcceptInput> = {},
    ) => {
      return await desktop!.commands.execute("resource.candidate.accept", {
        task_id: completed.task_id,
        candidate_id: candidate.id,
        lesson_id: lessonId,
        teaching_use: "用于比较预警与应急决策。",
        discussion_questions: ["哪些信号应触发提前疏散？"],
        action: "keep",
        ...extra,
        ...mutationBinding(),
      });
    };
    const acceptResult = (
      result: Awaited<ReturnType<typeof accept>>,
      label: string,
    ) => {
      const value = acceptedValue<{
        resource: ResourceItem;
        evidence: SourceEvidence[];
        usage: ResourceUsage;
        block_id: string | null;
        candidate_id: string;
      }>(result, label);
      recordCommit(result);
      return value;
    };
    const currentTask = async () => {
      const task = await desktop!.queries.execute("resource.discovery.get", {
        task_id: completed.task_id,
      }) as ResourceDiscoveryTask | null;
      assert(task, "resource.discovery.get should retain the review task");
      return task;
    };
    let committedGeneration = completed.snapshot.generation;
    const assertOneGenerationCommit = async (label: string) => {
      const task = await currentTask();
      assert(
        task.snapshot.generation === committedGeneration + 1,
        `${label} should advance the discovery binding by exactly one generation`,
      );
      committedGeneration += 1;
      return task;
    };

    const firstEvent = acceptResult(
      await accept(firstWeb, firstLessonId),
      "accept first event source",
    );
    await assertOneGenerationCommit("first event acceptance");
    const unconfirmedMerge = await accept(secondWeb, secondLessonId, {
      existing_resource_id: firstEvent.resource.id,
    });
    assert(
      unconfirmedMerge.error?.code === "merge_confirmation_required",
      "same-event source merge must require explicit confirmation",
    );
    assert(
      (await currentTask()).snapshot.generation === committedGeneration,
      "rejected merge must not advance the canonical generation",
    );
    const mergedEvent = acceptResult(
      await accept(secondWeb, secondLessonId, {
        existing_resource_id: firstEvent.resource.id,
        merge_confirmed: true,
      }),
      "explicitly merge second event source",
    );
    assert(
      mergedEvent.resource.id === firstEvent.resource.id,
      "explicit same-event merge should retain one library resource",
    );
    assert(
      mergedEvent.evidence.length === 2,
      "merged event resource should retain both distinct source records",
    );
    assert(
      new Set(mergedEvent.evidence.map((source) => source.url)).size === 2,
      "merged event sources should remain distinct URLs",
    );
    assert(
      mergedEvent.evidence.every((source) => source.fact_check === "unchecked"),
      "provider and mock content evidence must not be promoted to fact checked",
    );
    await assertOneGenerationCommit("event source merge");

    const firstVideoAccepted = acceptResult(
      await accept(firstVideo, firstLessonId, {
        manual_video_timing: { start_sec: 30, end_sec: 60, confirmed: true },
      }),
      "accept shared video in first lesson",
    );
    await assertOneGenerationCommit("first video usage");
    const secondVideoAccepted = acceptResult(
      await accept(secondVideo, secondLessonId, {
        existing_resource_id: firstVideoAccepted.resource.id,
        merge_confirmed: true,
        manual_video_timing: { start_sec: 150, end_sec: 210, confirmed: true },
      }),
      "reuse shared video in second lesson",
    );
    assert(
      secondVideoAccepted.resource.id === firstVideoAccepted.resource.id,
      "same video should share one canonical resource",
    );
    assert(
      secondVideoAccepted.usage.lesson_id === secondLessonId,
      "second video usage should belong to the second lesson",
    );
    assert(
      secondVideoAccepted.usage.video_selection?.start_sec === 150 &&
        secondVideoAccepted.usage.video_selection.end_sec === 210,
      "second lesson should preserve its separately confirmed clip",
    );
    await assertOneGenerationCommit("second video usage");

    const duplicateAccept = acceptResult(
      await accept(secondVideo, secondLessonId, {
        existing_resource_id: firstVideoAccepted.resource.id,
        merge_confirmed: true,
        manual_video_timing: { start_sec: 150, end_sec: 210, confirmed: true },
      }),
      "repeat the same acceptance",
    );
    assert(
      duplicateAccept.usage.id === secondVideoAccepted.usage.id,
      "duplicate accept should return the existing lesson usage",
    );
    await assertOneGenerationCommit("duplicate acceptance");

    const unknownTiming = await accept(unknownVideo, firstLessonId, {
      manual_video_timing: { start_sec: 0, end_sec: 20, confirmed: true },
    });
    assert(
      unknownTiming.error?.code === "timing_evidence_required",
      "unknown duration must not authorize a manually timed clip",
    );
    assert(
      (await currentTask()).snapshot.generation === committedGeneration,
      "rejected unknown-duration clip must not commit a generation",
    );

    const inboxTask = await currentTask();
    assert(
      inboxTask.candidates.find((candidate) => candidate.id === firstVideo.id)
        ?.accepted_resource_id === firstVideoAccepted.resource.id,
      "inbox review should link the first lesson candidate to the shared library resource",
    );
    const projectBeforeReopen = await desktop!.queries.execute(
      "project.get",
    ) as ProjectData;
    assert(
      projectBeforeReopen.resource_items.length === 2,
      "library should contain the explicitly merged event and shared video",
    );
    assert(
      projectBeforeReopen.resource_usages.length === 4,
      "each shared resource should have one usage in each lesson",
    );
    const videoUsages = projectBeforeReopen.resource_usages.filter((usage) =>
      usage.resource_id === firstVideoAccepted.resource.id
    );
    assert(
      videoUsages.length === 2,
      "one shared video resource should have exactly two lesson usages",
    );
    assert(
      new Set(
        videoUsages.map((usage) =>
          `${usage.video_selection?.start_sec}-${usage.video_selection?.end_sec}`
        ),
      ).size === 2,
      "shared video usages should retain different manual clips",
    );

    await desktop!.close();
    desktop = new DesktopService(
      directory,
      { app_instance_id: `resource-discovery-reopen-${crypto.randomUUID()}` },
      new MemorySecretStore(),
      {},
      new MemorySecretStore(),
    );
    await desktop.open();
    const reopened = acceptedValue<OpenState & { project: ProjectData }>(
      await desktop.commands.execute("project.open_state", {}),
      "reopen canonical project",
    );
    const reopenedProject = await desktop.queries.execute(
      "project.get",
    ) as ProjectData;
    const reopenedTask = await desktop.queries.execute(
      "resource.discovery.get",
      { task_id: completed.task_id },
    ) as ResourceDiscoveryTask | null;
    assert(
      reopenedTask?.candidates.find((candidate) =>
        candidate.id === secondVideo.id
      )?.accepted_resource_id === firstVideoAccepted.resource.id,
      "reopened inbox task should preserve accepted resource binding",
    );
    assert(
      reopenedProject.resource_usages.length === 4,
      "reopened library should preserve both usages for each shared resource",
    );

    const afterDelete = structuredClone(reopenedProject);
    applyFixtureLessonDeletion(afterDelete, firstLessonId);
    const saveAfterDelete = await desktop.commands.execute("project.save", {
      project: afterDelete,
      project_dir: reopened.project_dir,
      expected_project_id: reopened.project_id,
      lease_generation: reopened.lease_generation,
      editor_generation: 2,
      operation_id: crypto.randomUUID(),
      revision: 2,
      expected_fingerprint: reopened.fingerprint,
    });
    acceptedValue(saveAfterDelete, "save lesson deletion");
    await desktop.close();
    desktop = new DesktopService(
      directory,
      {
        app_instance_id:
          `resource-discovery-delete-reopen-${crypto.randomUUID()}`,
      },
      new MemorySecretStore(),
      {},
      new MemorySecretStore(),
    );
    await desktop.open();
    acceptedValue(
      await desktop.commands.execute("project.open_state", {}),
      "reopen after lesson deletion",
    );
    const afterDeleteProject = await desktop.queries.execute(
      "project.get",
    ) as ProjectData;
    const survivingVideo = afterDeleteProject.resource_items.find((resource) =>
      resource.id === firstVideoAccepted.resource.id
    );
    assert(
      !afterDeleteProject.content_items.some((item) =>
        item.id === firstLessonId
      ),
      "deleted lesson should stay deleted after reopen",
    );
    assert(
      survivingVideo,
      "shared video resource should remain in the library while another lesson uses it",
    );
    const survivingVideoUsages = afterDeleteProject.resource_usages.filter((
      usage,
    ) => usage.resource_id === survivingVideo.id);
    assert(
      survivingVideoUsages.length === 1 &&
        survivingVideoUsages[0]?.lesson_id === secondLessonId,
      "deleting one lesson should preserve the other lesson's video usage",
    );
    assert(
      afterDeleteProject.resource_items.some((resource) =>
        resource.id === firstEvent.resource.id
      ),
      "merged event resource should also remain in the shared library",
    );
  } finally {
    if (desktop) await desktop.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("legacy 1.0 migration preserves layouts through public save and is idempotent after reopen", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-legacy-migration-roundtrip-",
  });
  let desktop = new DesktopService(directory, {
    app_instance_id: `legacy-migration-${crypto.randomUUID()}`,
  });
  const collections = [
    "source_evidence",
    "resource_items",
    "resource_usages",
    "style_profiles",
    "presentation_documents",
    "slide_plans",
  ] as const;
  try {
    const project = createEmptyProjectData("1.0 legacy layout roundtrip");
    const lessonId = addLesson(project, "保留布局与完成状态", 0);
    const block = project.blocks.find((row) =>
      row.document_id ===
        project.content_items.find((item) => item.id === lessonId)?.document_id
    );
    assert(block, "legacy fixture should contain the lesson body block");
    const template = createLayoutTemplate(project, {
      name: "遗留Grid模板",
      mode: "grid",
    });
    const layout = createLayoutInstance(project, lessonId, {
      name: "遗留Grid实例",
      mode: "grid",
      template_id: template.id,
      grid_definition: { columns: [1, 1], rows: [1] },
    });
    const section = addLayoutSection(project, layout.id, {
      name: "遗留区域",
      page_index: 0,
      order_index: 0,
      grid_definition: { columns: [1, 1], rows: [1] },
    });
    const page = addLayoutPage(project, layout.id, {
      title: "遗留页面",
      grid_definition: { columns: [1, 1], rows: [1] },
    });
    const placement = addPlacement(project, layout.id, block.id, {
      row_start: 0,
      row_end: 1,
      column_start: 0,
      column_end: 1,
      section_id: section.id,
    });
    placement.page_id = page.id;
    for (const dimension of project.status_dimensions) {
      const option = project.status_options.find((candidate) =>
        candidate.dimension_id === dimension.id &&
        (dimension.key === "layout"
          ? !candidate.is_terminal
          : candidate.is_terminal)
      );
      assert(
        option,
        `fixture should have a status option for ${dimension.key}`,
      );
      assignStatus(project, lessonId, dimension.key, option.key);
    }
    const preservedIds = {
      lesson: lessonId,
      template: template.id,
      layout: layout.id,
      section: section.id,
      page: page.id,
      placement: placement.id,
    };

    const legacy = structuredClone(project) as unknown as Record<
      string,
      unknown
    >;
    legacy.schema_version = "1.0.0";
    (legacy.project as Record<string, unknown>).schema_version = "1.0.0";
    for (const collection of collections) delete legacy[collection];
    await Deno.writeTextFile(desktop.store.projectPath, JSON.stringify(legacy));

    await desktop.open();
    const opened = acceptedValue<OpenState & { project: ProjectData }>(
      await desktop.commands.execute("project.open_state", {}),
      "open legacy project",
    );
    assert(
      opened.project.schema_version === "1.1.0" &&
        opened.project.project.schema_version === "1.1.0",
      "opening should run the real migration and bring both schema stamps to 1.1.0",
    );
    for (const collection of collections) {
      assert(
        Array.isArray(opened.project[collection]) &&
          opened.project[collection].length === 0,
        `migration should add the empty ${collection} collection`,
      );
    }
    assert(
      opened.project.layout_templates.some((row) =>
        row.id === preservedIds.template
      ) &&
        opened.project.layout_instances.some((row) =>
          row.id === preservedIds.layout
        ) &&
        opened.project.layout_sections.some((row) =>
          row.id === preservedIds.section
        ) &&
        opened.project.layout_pages.some((row) =>
          row.id === preservedIds.page
        ) &&
        opened.project.placements.some((row) =>
          row.id === preservedIds.placement
        ),
      "layout and placement identities should survive migration",
    );
    assert(
      lessonProgress(opened.project, lessonId).complete,
      "a preserved nonterminal layout status must not block lesson completion",
    );
    const diskAfterOpen = JSON.parse(
      await Deno.readTextFile(desktop.store.projectPath),
    ) as Record<string, unknown>;
    assert(
      diskAfterOpen.schema_version === "1.1.0",
      "opening the writable public service should persist the migration",
    );

    opened.project.project.description = "public service migration save";
    const save = await desktop.commands.execute("project.save", {
      project: opened.project,
      project_dir: opened.project_dir,
      expected_project_id: opened.project_id,
      lease_generation: opened.lease_generation,
      editor_generation: 1,
      operation_id: crypto.randomUUID(),
      revision: 1,
      expected_fingerprint: opened.fingerprint,
      recovery_metadata: {
        project_id: opened.project_id,
        saved_at: new Date().toISOString(),
      },
    });
    acceptedValue(save, "save migrated project through public command");

    await desktop.close();
    desktop = new DesktopService(directory, {
      app_instance_id: `legacy-migration-reopen-${crypto.randomUUID()}`,
    });
    await desktop.open();
    const reopened = acceptedValue<OpenState & { project: ProjectData }>(
      await desktop.commands.execute("project.open_state", {}),
      "reopen migrated project",
    );
    assert(
      reopened.project.project.description === "public service migration save",
      "the public save should persist through close and reopen",
    );
    assert(
      reopened.project.layout_templates.some((row) =>
        row.id === preservedIds.template
      ) &&
        reopened.project.layout_instances.some((row) =>
          row.id === preservedIds.layout
        ) &&
        reopened.project.layout_sections.some((row) =>
          row.id === preservedIds.section
        ) &&
        reopened.project.layout_pages.some((row) =>
          row.id === preservedIds.page
        ) &&
        reopened.project.placements.some((row) =>
          row.id === preservedIds.placement
        ),
      "layout and placement identities should survive public save and reopen",
    );
    for (const collection of collections) {
      assert(
        Array.isArray(reopened.project[collection]) &&
          reopened.project[collection].length === 0,
        `reopened canonical data should retain ${collection}`,
      );
    }
    const once = migrateProject(reopened.project);
    const twice = migrateProject(once);
    assert(
      serializeProject(once) === serializeProject(twice) &&
        serializeProject(once) === serializeProject(reopened.project),
      "reapplying migration after reopen should be byte-stable and idempotent",
    );
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});
