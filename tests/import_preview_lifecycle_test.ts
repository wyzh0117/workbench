import { DesktopService } from "../src/service/desktop.ts";
import { confirmImport, previewImport } from "../src/service/import_export.ts";
import { createEmptyProjectData } from "../src/domain/store.ts";

const PREVIEW_TTL_MS = 15 * 60 * 1000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type PreviewSlot = {
  created_at: number;
  active: boolean;
  preview?: { items?: Array<{ payload?: Uint8Array }> } | null;
  input_directory?: string | null;
};

function previewSlots(desktop: DesktopService): Map<string, PreviewSlot> {
  return (desktop as unknown as {
    importPreviews: Map<string, PreviewSlot>;
  }).importPreviews;
}

async function createPreview(desktop: DesktopService, name: string) {
  const result = await desktop.commands.execute("import.preview", {
    sources: [{ name, bytes: "preview" }],
  });
  assert(!result.error, `preview ${name} should succeed`);
  return result.value as { id: string };
}

Deno.test("pending import previews are capped and can be released", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-import-preview-life-",
  });
  const desktop = new DesktopService(directory);
  try {
    const previews: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      previews.push((await createPreview(desktop, `note-${index}.md`)).id);
    }
    const firstSlot = previewSlots(desktop).get(previews[0]!)!;
    assert(
      firstSlot.preview?.items?.[0]?.payload === undefined,
      "inline browser bytes must be represented by an owned file descriptor, not cached payload",
    );
    const ownedInputDirectory = firstSlot.input_directory;
    assert(
      ownedInputDirectory,
      "inline bytes should use an owned temporary directory",
    );

    const full = await desktop.commands.execute("import.preview", {
      sources: [{ name: "ninth.md", bytes: "preview" }],
    });
    assert(full.error, "the ninth pending preview must not grow the cache");
    assert(
      full.error.user_message.includes("上限") ||
        full.error.user_message.includes("稍后重试"),
      "a full preview cache should report a recoverable limit",
    );

    const released = await desktop.commands.execute("import.preview.release", {
      preview_id: previews[0],
    });
    assert(
      !released.error,
      "a pending preview must have an explicit release command",
    );
    assert(
      (released.value as { released?: boolean }).released === true,
      "release should acknowledge which cached preview it removed",
    );
    let inputWasRemoved = false;
    try {
      await Deno.stat(ownedInputDirectory);
    } catch (caught) {
      inputWasRemoved = caught instanceof Deno.errors.NotFound;
    }
    assert(
      inputWasRemoved,
      "release must remove its owned inline source directory",
    );

    await createPreview(desktop, "replacement.md");
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("file previews keep no media payload and cap summaries at 512 KiB", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-import-preview-summary-",
  });
  const sourcePath = `${directory}/large.md`;
  const desktop = new DesktopService(`${directory}/project`);
  try {
    const source = "x".repeat(1024 * 1024);
    await Deno.writeTextFile(sourcePath, source);
    const result = await desktop.commands.execute("import.preview", {
      sources: [{ path: sourcePath }],
    });
    assert(!result.error, "large text should still produce a summary preview");
    const item = (result.value as {
      items: Array<{
        text: string | null;
        payload?: Uint8Array;
        summary_truncated?: boolean;
      }>;
    }).items[0]!;
    assert(
      item.payload === undefined,
      "a file preview must not retain its bytes",
    );
    assert(
      new TextEncoder().encode(item.text ?? "").byteLength <= 512 * 1024,
      "the retained text summary must stay within 512 KiB",
    );
    assert(
      item.summary_truncated,
      "the preview must disclose its truncated summary",
    );
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("confirm rejects a source changed under the same size, mtime and identity", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-import-source-change-",
  });
  const sourcePath = `${directory}/source.md`;
  try {
    await Deno.writeTextFile(sourcePath, "# source\n");
    const before = await Deno.stat(sourcePath);
    const preview = await previewImport([{ path: sourcePath }]);
    await Deno.writeTextFile(sourcePath, "# change\n");
    if (before.atime && before.mtime) {
      await Deno.utime(
        sourcePath,
        before.atime.getTime() / 1000,
        before.mtime.getTime() / 1000,
      );
    }
    const after = await Deno.stat(sourcePath);
    assert(
      before.size === after.size,
      "fixture content should keep the same size",
    );
    assert(
      before.mtime?.getTime() === after.mtime?.getTime(),
      "fixture should restore the original modification time",
    );
    const data = createEmptyProjectData("Source change");
    let rejected = false;
    try {
      await confirmImport(data, preview);
    } catch (caught) {
      rejected = caught instanceof Error &&
        caught.message.includes("摘要已变化");
    }
    assert(
      rejected,
      "confirmation must compare the retained preview summary hash",
    );
    assert(
      data.inbox_items.length === 0,
      "rejected source changes must not mutate Canonical data",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("expired previews are pruned while an active confirmation stays pinned", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-import-preview-ttl-",
  });
  const desktop = new DesktopService(directory);
  try {
    const ids: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      ids.push((await createPreview(desktop, `expired-${index}.md`)).id);
    }
    const slots = previewSlots(desktop);
    const expiredAt = Date.now() - PREVIEW_TTL_MS - 1;
    for (const [id, slot] of slots) {
      slot.created_at = expiredAt;
      slot.active = id === ids[0];
    }

    await createPreview(desktop, "fresh.md");
    assert(slots.has(ids[0]!), "an active confirmation must not be evicted");
    assert(
      slots.size === 2,
      "all seven expired inactive previews should be released",
    );
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("twenty preview release cycles and service close leave no cached records", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-import-preview-cancel-",
  });
  const desktop = new DesktopService(directory);
  try {
    for (let index = 0; index < 20; index += 1) {
      const preview = await createPreview(desktop, `cancel-${index}.md`);
      const released = await desktop.commands.execute(
        "import.preview.release",
        {
          preview_id: preview.id,
        },
      );
      assert(!released.error, `release ${index} should succeed`);
    }
    assert(
      previewSlots(desktop).size === 0,
      "released summaries must not accumulate",
    );
    await createPreview(desktop, "close.md");
    await desktop.close();
    assert(
      previewSlots(desktop).size === 0,
      "service close must release pending previews",
    );
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("twenty active confirmation cancels abort before canonical commit", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "acw-import-active-cancel-",
  });
  const sourcePath = `${directory}/large.png`;
  const desktop = new DesktopService(`${directory}/project`);
  try {
    const sparse = await Deno.open(sourcePath, {
      write: true,
      createNew: true,
    });
    await sparse.truncate(128 * 1024 * 1024);
    sparse.close();
    await desktop.open();
    const created = await desktop.commands.execute("project.create", {
      title: "Active cancel",
    });
    assert(!created.error, "a disposable project fixture should be created");
    const canonicalBefore = JSON.stringify(desktop.context.project);

    for (let index = 0; index < 20; index += 1) {
      const preview = await desktop.commands.execute("import.preview", {
        sources: [{ path: sourcePath }],
      });
      assert(!preview.error, `asset preview ${index} should succeed`);
      const previewValue = preview.value as { id: string };
      const confirmPromise = desktop.commands.execute("import.confirm", {
        preview: previewValue,
      });
      const slot = previewSlots(desktop).get(previewValue.id)!;
      for (let spin = 0; spin < 100 && !slot.active; spin += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert(
        slot.active,
        `confirmation ${index} should enter the active lifecycle`,
      );
      const releasePromise = desktop.commands.execute(
        "import.preview.release",
        {
          preview_id: previewValue.id,
        },
      );
      const [confirmed, released] = await Promise.all([
        confirmPromise,
        releasePromise,
      ]);
      assert(confirmed.error, `confirmation ${index} must abort before commit`);
      assert(
        !released.error &&
          (released.value as { released?: boolean }).released === true,
        `release ${index} should acknowledge active cancellation`,
      );
      assert(
        JSON.stringify(desktop.context.project) === canonicalBefore,
        `cancel ${index} must not mutate the canonical project`,
      );
      assert(
        previewSlots(desktop).size === 0,
        "cancelled previews must be released",
      );
    }
  } finally {
    await desktop.close();
    await Deno.remove(directory, { recursive: true });
  }
});
