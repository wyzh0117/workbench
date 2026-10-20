import { addAsset } from "../src/domain/assets.ts";
import { createEmptyProjectData } from "../src/domain/store.ts";
import { id, now, sha256Bytes } from "../src/domain/util.ts";
import { CURRENT_SCHEMA_VERSION } from "../src/domain/types.ts";
import type { ProjectData } from "../src/domain/types.ts";
import type { PresentationStyleExtractionReport } from "../src/ui/contracts.ts";
import {
  exportSlide,
  extractStyle,
  parseGeneratedSlideSpec,
  prepareSlideGenerationContext,
  type PresentationCodec,
  previewSlide,
  proposeSlide,
  saveStyle,
} from "../src/service/presentation_workflow.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejectsCode(
  run: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await run();
  } catch (caught) {
    const actual = (caught as { error?: { code?: string } })?.error?.code;
    assert(
      actual === code,
      `expected ${code}, received ${actual ?? String(caught)}`,
    );
    return;
  }
  throw new Error(`expected rejection ${code}`);
}

function projectFixture(): {
  data: ProjectData;
  source: Uint8Array;
  sourceAssetId: string;
} {
  const data = createEmptyProjectData("Presentation workflow test");
  const source = new Uint8Array([1, 2, 3]);
  const asset = addAsset(data, data.project.id, {
    type: "other",
    filename: "source.pptx",
    storage_path: "assets/source.pptx",
    mime_type:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    checksum: "0".repeat(64),
    file_size: source.byteLength,
    source_type: "imported",
  }).asset;
  // The fixture's checksum is replaced with the exact in-memory bytes by each test.
  asset.checksum = "0".repeat(64);
  return { data, source, sourceAssetId: asset.id };
}

function fakeCodec(): PresentationCodec {
  const variant = {
    id: "variant-1",
    master_part: "ppt/slideMasters/slideMaster1.xml",
    theme_part: "ppt/theme/theme1.xml",
    layout_part: "ppt/slideLayouts/slideLayout1.xml",
    slide_parts: ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"],
    representative_slide_part: "ppt/slides/slide1.xml",
    theme_colors: [],
    theme_fonts: [],
    placeholders: [],
    representative_objects: [],
  };
  return {
    async inspectPptx(bytes) {
      const source_sha256 = await sha256Bytes(bytes);
      const report: PresentationStyleExtractionReport = {
        source_sha256,
        presentation_part: "ppt/presentation.xml",
        slide_count: bytes[0] === 6 ? 1 : bytes[0] === 7 ? 4 : 3,
        ordered_slides: Array.from(
          { length: bytes[0] === 6 ? 1 : bytes[0] === 7 ? 4 : 3 },
          (_, index) => ({
            slide_id: String(256 + index * 256),
            order: index + 1,
            part: `ppt/slides/slide${index + 1}.xml`,
          }),
        ),
        slide_width_emu: 9_144_000,
        slide_height_emu: 5_143_500,
        variants: [variant],
        representative_previews: [{
          source_sha256,
          variant_id: variant.id,
          slide_part: variant.representative_slide_part,
          width_emu: 12_192_000,
          height_emu: 6_858_000,
          format: "svg",
          svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
          limitations: ["结构预览"],
        }],
        extraction_facts: ["3 slides"],
        limitations: ["不是 PowerPoint 实际渲染"],
      };
      return report;
    },
    async previewSlideCopy(_source, _template, _spec, tokens) {
      assert(
        tokens.slide_size_emu.width === 9_144_000,
        "preview must use extracted theme tokens",
      );
      return {
        format: "svg",
        svg:
          '<svg xmlns="http://www.w3.org/2000/svg"><text>new slide</text></svg>',
        limitations: [],
      };
    },
    async appendSlideCopy() {
      return new Uint8Array([7, 8, 9, 10, 11]);
    },
    async singleSlideCopy() {
      return new Uint8Array([6, 5, 4, 3]);
    },
  };
}

Deno.test("presentation style extraction, machine rules, slide preview and export bind verified revisions", async () => {
  const { data, source, sourceAssetId } = projectFixture();
  const sourceAsset = data.assets.find((asset) => asset.id === sourceAssetId)!;
  sourceAsset.checksum = await sha256Bytes(source);
  const bytes = new Map([[sourceAssetId, source]]);
  const readAsset = async (assetId: string) =>
    bytes.get(assetId) ?? new Uint8Array();
  const codec = fakeCodec();

  const extraction = await extractStyle(data, sourceAssetId, readAsset, codec);
  assert(
    extraction.visual_review_required,
    "extraction must require visual review",
  );
  assert(
    extraction.report.representative_previews.length === 1,
    "structural representative preview is returned",
  );
  const markdown = (await Deno.readTextFile(
    new URL("./fixtures/presentation_style_markdown.md", import.meta.url),
  )).replace(
    '"color": null',
    '"color": "#abcdef"',
  );
  const saved = await saveStyle(data, {
    style_draft_id: extraction.style_draft_id,
    variant_id: "variant-1",
    markdown,
  });
  assert(
    saved.parsed_tokens.status === "valid",
    "valid machine section is parsed",
  );
  assert(
    saved.style_profile.tokens.editable_rules.title.color === "#ABCDEF",
    "machine color is normalized",
  );
  assert(
    data.presentation_documents.length === 1,
    "first style save creates a presentation working copy",
  );

  const lessonId = id();
  const documentId = id();
  data.content_items.push({
    id: lessonId,
    project_id: data.project.id,
    stage_id: null,
    code: "L1",
    title: "Lesson",
    type: "lesson",
    description: "",
    order_index: 0,
    document_id: documentId,
    archived: false,
    created_at: now(),
    updated_at: now(),
  });
  data.documents.push({
    id: documentId,
    content_item_id: lessonId,
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: now(),
    updated_at: now(),
  });
  const plan = proposeSlide(data, {
    document_id: saved.presentation_document.id,
    lesson_id: lessonId,
    style_profile_id: saved.style_profile.id,
    style_revision: saved.style_profile.revision,
    target_asset_id: sourceAssetId,
    insert_after_slide_id: null,
    spec: {
      layout_ref: "variant-1",
      title: "Supplement",
      body: [{ kind: "bullet", text: "Key point" }],
      image_asset_ids: [],
      source_ids: [],
      speaker_notes: "Review in PowerPoint",
    },
  });
  const profile = data.style_profiles.find((item) =>
    item.id === saved.style_profile.id
  )!;
  const savedProfileHash = profile.markdown_hash;
  const savedParsedHash = profile.parsed_from_hash;
  const savedParserVersion = profile.parser_version;
  profile.markdown_hash = "0".repeat(64);
  await rejectsCode(
    () =>
      previewSlide(
        data,
        { slide_plan_id: plan.id, revision: plan.revision },
        readAsset,
        codec,
      ),
    "stale_style_tokens",
  );
  profile.markdown_hash = savedProfileHash;
  profile.parser_version = "unsupported-parser";
  await rejectsCode(
    () =>
      previewSlide(
        data,
        { slide_plan_id: plan.id, revision: plan.revision },
        readAsset,
        codec,
      ),
    "stale_style_tokens",
  );
  profile.parser_version = savedParserVersion;
  const preview = await previewSlide(
    data,
    { slide_plan_id: plan.id, revision: plan.revision },
    readAsset,
    codec,
  );
  assert(
    preview.svg.includes("new slide"),
    "preview contains the codec-rendered SVG",
  );
  assert(
    preview.limitations.some((text) => text.includes("不是 PowerPoint")),
    "preview exposes fidelity limit",
  );

  profile.parsed_from_hash = "f".repeat(64);
  let stagedWhileStale = false;
  await rejectsCode(
    () =>
      exportSlide(
        data,
        {
          slide_plan_id: plan.id,
          revision: plan.revision,
          output_mode: "append",
          approved: true,
        },
        readAsset,
        async () => {
          stagedWhileStale = true;
          throw new Error("stale style must fail before asset staging");
        },
        codec,
        async () => {},
      ),
    "stale_style_tokens",
  );
  assert(!stagedWhileStale, "stale style cannot stage an export asset");
  profile.parsed_from_hash = savedParsedHash;

  const commits: ProjectData[] = [];
  let rolledBack = false;
  const exported = await exportSlide(
    data,
    {
      slide_plan_id: plan.id,
      revision: plan.revision,
      output_mode: "append",
      approved: true,
    },
    readAsset,
    async (draft, output, metadata) => {
      const asset = addAsset(draft, draft.project.id, {
        type: "other",
        filename: metadata.filename,
        storage_path: `assets/${metadata.filename}`,
        mime_type: metadata.mime_type,
        checksum: await sha256Bytes(output),
        file_size: output.byteLength,
        title: metadata.title,
        source_type: "generated",
        description: `Parent asset ${metadata.parent_asset_id}`,
      }).asset;
      bytes.set(asset.id, output);
      return {
        asset,
        async rollback() {
          rolledBack = true;
          bytes.delete(asset.id);
        },
      };
    },
    codec,
    async (draft) => {
      commits.push(structuredClone(draft));
    },
  );
  assert(!rolledBack, "successful commit keeps the staged asset");
  assert(
    exported.output_asset_id !== sourceAssetId,
    "export always creates a copy",
  );
  assert(exported.page_count === 4, "append adds one page");
  assert(
    exported.presentation_document.current_asset_id ===
      exported.output_asset_id,
    "successful export advances only the working copy",
  );
  assert(
    exported.presentation_document.source_asset_id === sourceAssetId,
    "original remains the document source",
  );
  assert(
    commits[0]?.assets.some((asset) => asset.id === exported.output_asset_id),
    "asset and document pointer commit together",
  );
});

Deno.test("AI slide preparation binds scoped context and accepts only an allowlisted SlideSpec", async () => {
  const { data, source, sourceAssetId } = projectFixture();
  data.project.description = "Never include project-wide notes in a lesson request";
  const sourceAsset = data.assets.find((asset) => asset.id === sourceAssetId)!;
  sourceAsset.checksum = await sha256Bytes(source);
  const bytes = new Map([[sourceAssetId, source]]);
  const readAsset = async (assetId: string) => bytes.get(assetId) ?? new Uint8Array();
  const codec = fakeCodec();
  const extracted = await extractStyle(data, sourceAssetId, readAsset, codec);
  const saved = await saveStyle(data, {
    style_draft_id: extracted.style_draft_id,
    variant_id: "variant-1",
    markdown: extracted.markdown_draft,
  });
  const lessonId = id();
  const documentId = id();
  data.content_items.push({
    id: lessonId,
    project_id: data.project.id,
    stage_id: null,
    code: "L1",
    title: "Current lesson",
    type: "lesson",
    description: "Only this lesson is in scope",
    order_index: 0,
    document_id: documentId,
    archived: false,
    created_at: now(),
    updated_at: now(),
  });
  data.documents.push({
    id: documentId,
    content_item_id: lessonId,
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: now(),
    updated_at: now(),
  });
  const blockId = id();
  data.blocks.push({
    id: blockId,
    document_id: documentId,
    parent_block_id: null,
    type: "paragraph",
    order_index: 0,
    content: "Lesson text for the model",
    settings: {},
    created_at: now(),
    updated_at: now(),
  });
  const image = addAsset(data, data.project.id, {
    type: "image",
    filename: "lesson.png",
    storage_path: "assets/lesson.png",
    mime_type: "image/png",
    checksum: "1".repeat(64),
    file_size: 1,
    source_type: "imported",
  }).asset;
  data.asset_usages.push({
    id: id(),
    asset_id: image.id,
    content_item_id: lessonId,
    block_id: blockId,
    layout_instance_id: null,
    role: "lesson image",
    created_at: now(),
  });
  const capture = {
    project_fingerprint: "a".repeat(64),
    lease_generation: "lease-1",
    editor_generation: 7,
  };
  const base = {
    document_id: saved.presentation_document.id,
    lesson_id: lessonId,
    style_profile_id: saved.style_profile.id,
    style_revision: saved.style_profile.revision,
    target_asset_id: sourceAssetId,
    instruction: "Summarize the lesson",
    provider_id: "existing-provider",
    model: "existing-model",
    session_generation: 12,
    editor_generation: 7,
  };
  const preparedAtMiddle = await prepareSlideGenerationContext(
    data,
    { ...base, generation_id: "generation-middle", insert_after_slide_id: "512" },
    capture,
    { readAsset, codec },
  );
  assert(preparedAtMiddle.insertion_order === 3, "preparation uses the inspected slide order");
  assert(preparedAtMiddle.allowed_image_asset_ids.includes(image.id), "lesson image is allowlisted");
  assert(preparedAtMiddle.context.user.includes("Lesson text for the model"), "lesson text is included");
  assert(!preparedAtMiddle.context.user.includes(data.project.description), "project-wide text is excluded");

  const prepared = await prepareSlideGenerationContext(
    data,
    { ...base, generation_id: "generation-end", insert_after_slide_id: null },
    capture,
    { readAsset, codec },
  );
  const modelText = JSON.stringify({
    layout_ref: prepared.variant_id,
    title: "Generated slide",
    body: [{ kind: "bullet", text: "Lesson point" }],
    image_asset_ids: [image.id],
    source_ids: [],
    speaker_notes: "",
  });
  const spec = parseGeneratedSlideSpec(data, prepared, modelText);
  const plan = proposeSlide(data, {
    ...base,
    insert_after_slide_id: null,
    spec,
    generation_source: {
      mode: "ai",
      generation_id: prepared.generation_id,
      session_generation: prepared.session_generation,
      provider_id: prepared.provider_id,
      model: prepared.model,
      context_sha256: prepared.context_sha256,
      lesson_snapshot_sha256: prepared.lesson_snapshot_sha256,
      style_markdown_sha256: prepared.style_markdown_sha256,
      snapshot_binding_sha256: prepared.snapshot_binding_sha256,
      consented_at: now(),
      authorized: true,
    },
  });
  assert(plan.generation_source?.mode === "ai", "the saved plan records AI as its true source");
  await rejectsCode(
    async () => parseGeneratedSlideSpec(data, prepared, "not JSON"),
    "invalid_slide_spec",
  );
  await rejectsCode(
    async () => parseGeneratedSlideSpec(data, prepared, JSON.stringify({
      layout_ref: prepared.variant_id,
      title: "Bad source",
      body: [],
      image_asset_ids: [],
      source_ids: ["not-allowed"],
      speaker_notes: "",
    })),
    "invalid_slide_spec",
  );
  await rejectsCode(
    () => prepareSlideGenerationContext(
      data,
      { ...base, provider_id: "", generation_id: "no-provider", insert_after_slide_id: null },
      capture,
      { readAsset, codec },
    ),
    "provider_unavailable",
  );
});

Deno.test("presentation workflow rejects missing native codec, stale sources and unverified insert IDs", async () => {
  const { data, source, sourceAssetId } = projectFixture();
  const sourceAsset = data.assets.find((asset) => asset.id === sourceAssetId)!;
  sourceAsset.checksum = await sha256Bytes(source);
  const readAsset = async () => source;
  await rejectsCode(
    () => extractStyle(data, sourceAssetId, readAsset),
    "native_engine_required",
  );

  const extraction = await extractStyle(
    data,
    sourceAssetId,
    readAsset,
    fakeCodec(),
  );
  sourceAsset.checksum = "f".repeat(64);
  await rejectsCode(
    () =>
      saveStyle(data, {
        style_draft_id: extraction.style_draft_id,
        variant_id: "variant-1",
        markdown: extraction.markdown_draft,
      }),
    "style_draft_stale",
  );
  sourceAsset.checksum = await sha256Bytes(source);
  const changedFacts = extraction.markdown_draft.replace(
    '"width": 9144000',
    '"width": 10',
  );
  await rejectsCode(
    () =>
      saveStyle(data, {
        style_draft_id: extraction.style_draft_id,
        variant_id: "variant-1",
        markdown: changedFacts,
      }),
    "style_facts_changed",
  );
  const styleFixture = await Deno.readTextFile(
    new URL("./fixtures/presentation_style_markdown.md", import.meta.url),
  );
  const invalidMarkdown = [
    styleFixture.replace("```workbench-style", "```workbench-style-bad"),
    styleFixture.replace(
      "```workbench-style",
      "```workbench-style\n{}\n```\n\n```workbench-style",
    ),
    styleFixture.replace("variant-1", "wrong-variant"),
    styleFixture.replace(
      '"editable_rules":',
      '"unknown": true,\n  "editable_rules":',
    ),
    styleFixture.replace(
      /```workbench-style[\s\S]*?```/,
      "```workbench-style\n{bad}\n```",
    ),
  ];
  for (const markdown of invalidMarkdown) {
    await rejectsCode(
      () =>
        saveStyle(data, {
          style_draft_id: extraction.style_draft_id,
          variant_id: "variant-1",
          markdown,
        }),
      "style_markdown_invalid",
    );
  }
  await rejectsCode(
    () =>
      saveStyle(data, {
        style_draft_id: extraction.style_draft_id,
        variant_id: "variant-1",
        markdown: styleFixture + "中".repeat(34_000),
      }),
    "style_markdown_invalid",
  );
  const saved = await saveStyle(data, {
    style_draft_id: extraction.style_draft_id,
    variant_id: "variant-1",
    markdown: styleFixture,
  });

  const lessonId = id();
  const documentId = id();
  data.content_items.push({
    id: lessonId,
    project_id: data.project.id,
    stage_id: null,
    code: "L1",
    title: "Lesson",
    type: "lesson",
    description: "",
    order_index: 0,
    document_id: documentId,
    archived: false,
    created_at: now(),
    updated_at: now(),
  });
  data.documents.push({
    id: documentId,
    content_item_id: lessonId,
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: now(),
    updated_at: now(),
  });
  await rejectsCode(async () =>
    proposeSlide(data, {
      document_id: saved.presentation_document.id,
      lesson_id: lessonId,
      style_profile_id: saved.style_profile.id,
      style_revision: saved.style_profile.revision,
      target_asset_id: sourceAssetId,
      insert_after_slide_id: "arbitrary-slide-id",
      spec: {
        layout_ref: "variant-1",
        title: "Supplement",
        body: [],
        image_asset_ids: [],
        source_ids: [],
        speaker_notes: "",
      },
    }), "unsupported_insert_position");
});
