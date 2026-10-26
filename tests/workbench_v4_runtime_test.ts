import { DocumentSession, WorkbenchBridge } from "../app/workbench-runtime.js";
function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
Deno.test("v4 bridge uses only native IPC and wraps input without false fallback on null", async () => {
  const calls: unknown[] = [];
  const bridge = new WorkbenchBridge(async (name: string, args: unknown) => {
    calls.push({ name, args });
    return null;
  });
  assert(
    await bridge.call("wb_document_open", { path: "/a.md" }) === null,
    "null is native success",
  );
  assert(
    JSON.stringify(calls) ===
      '[{"name":"wb_document_open","args":{"input":{"path":"/a.md"}}}]',
    "native shape",
  );
});
Deno.test("v4 missing native shell fails visibly instead of creating mock API results", async () => {
  const bridge = new WorkbenchBridge(null);
  let message = "";
  try {
    await bridge.call("wb_resource_search", {});
  } catch (e) {
    message = String(e);
  }
  assert(message.includes("桌面版"), "missing host explanation");
});
Deno.test("v4 saves serialize and carry last committed hash without clearing later edits", async () => {
  const writes: Record<string, unknown>[] = [];
  let release: () => void = () => {};
  const bridge = new WorkbenchBridge(
    async (_name: string, args: { input: Record<string, unknown> }) => {
      writes.push(args.input);
      if (writes.length === 1) await new Promise<void>((r) => release = r);
      return { path: "/a.md", hash: `h${writes.length}` };
    },
  );
  const session = new DocumentSession(bridge);
  session.open({
    path: "/a.md",
    sourcePath: "/a.md",
    hash: "h0",
    markdown: "# A\n\nFirst\n",
    title: "A",
  });
  session.document!.chapters[0]!.blocks[0].markdown = "Second";
  session.touch();
  const saving = session.save();
  await new Promise((r) => setTimeout(r, 0));
  session.document!.chapters[0]!.blocks[0].markdown = "Third";
  session.touch();
  const second = session.save();
  release();
  await Promise.all([saving, second]);
  assert(writes.length === 2, "two snapshots persisted");
  assert(
    writes[0]!.expectedHash === "h0" && writes[1]!.expectedHash === "h1",
    "hash chained",
  );
  assert(String(writes[1]!.markdown).includes("Third"), "later edit persisted");
  assert(!session.dirty, "clean only after final save");
});
Deno.test("v4 failed saves preserve dirty document and original hash", async () => {
  const session = new DocumentSession(
    new WorkbenchBridge(async () => {
      throw "conflict: file changed";
    }),
  );
  session.open({ path: "/a.md", hash: "before", markdown: "# A", title: "A" });
  session.touch();
  try {
    await session.save();
  } catch { /* expected */ }
  assert(session.dirty, "dirty retained");
  assert(session.hash === "before", "hash retained");
});
Deno.test("v4 binary source cannot silently overwrite the input document", async () => {
  let wrote = false;
  const session = new DocumentSession(
    new WorkbenchBridge(async () => {
      wrote = true;
      return {};
    }),
  );
  session.open({
    path: "/a.docx",
    sourcePath: "/a.docx",
    hash: "h",
    markdown: "# A",
    title: "A",
  });
  session.touch();
  try {
    await session.save();
  } catch { /* expected */ }
  assert(!wrote, "source not overwritten");
});
Deno.test("v4 transition flush persists edits that arrived while an earlier save was in flight", async () => {
  const { flushStableDocument } = await import("../app/workbench-runtime.js");
  let release: () => void = () => {};
  const writes: Record<string, unknown>[] = [];
  const session = new DocumentSession(
    new WorkbenchBridge(
      async (_name: string, args: { input: Record<string, unknown> }) => {
        writes.push(args.input);
        if (writes.length === 1) await new Promise<void>((r) => release = r);
        return { path: "/a.md", hash: `h${writes.length}` };
      },
    ),
  );
  session.open({ path: "/a.md", hash: "h0", markdown: "# A\n\nOriginal\n" });
  session.touch();
  const transition = flushStableDocument(session);
  await new Promise((r) => setTimeout(r, 0));
  session.document!.chapters[0]!.blocks[0].markdown = "Later sentence";
  session.touch();
  release();
  await transition;
  assert(writes.length === 2, "later save required before transition");
  assert(
    String(writes[1]!.markdown).includes("Later sentence"),
    "latest sentence persisted",
  );
  assert(!session.dirty, "only clean session may transition");
});
Deno.test("v4 latest async request rejects old reader response after newer source completes", async () => {
  const { LatestRequest } = await import("../app/workbench-runtime.js");
  const gate = new LatestRequest();
  let release: (value: string) => void = () => {};
  let visible = "";
  const first = gate.run(
    () => new Promise<string>((r) => release = r),
    (value: string) => visible = value,
  );
  await gate.run(
    () => Promise.resolve("Source B"),
    (value: string) => visible = value,
  );
  release("Source A");
  await first;
  assert(visible === "Source B", "A cannot overwrite B");
});
Deno.test("v4 selected excerpt is scoped to its source and cleared on navigation", async () => {
  const { SourceSelection } = await import("../app/workbench-runtime.js");
  const selected = new SourceSelection();
  selected.reset("https://a.example/");
  selected.capture("https://a.example/", "Text A");
  assert(
    selected.read("https://a.example/") === "Text A",
    "current source selection",
  );
  selected.reset("https://b.example/");
  assert(
    selected.read("https://b.example/") === "",
    "navigation clears selection",
  );
  selected.capture("https://a.example/", "late A");
  assert(
    selected.read("https://b.example/") === "",
    "stale source cannot supply new citation",
  );
});
Deno.test("v4 successful Save As makes the new Markdown document the media source root", async () => {
  const writes: Record<string, unknown>[] = [];
  const session = new DocumentSession(
    new WorkbenchBridge(
      async (_name: string, args: { input: Record<string, unknown> }) => {
        writes.push(args.input);
        return { path: "/new/course.md", hash: "new" };
      },
    ),
  );
  session.open({
    path: "/old/course.docx",
    sourcePath: "/old/course.docx",
    markdown: "# A",
  });
  session.touch();
  await session.save("/new/course.md");
  session.touch();
  await session.save();
  assert(
    writes[0]!.sourcePath === "/old/course.docx",
    "initial extraction uses source binary",
  );
  assert(
    writes[1]!.sourcePath === "/new/course.md",
    "subsequent save resolves portable media beside new document",
  );
});
Deno.test("v4 browser import cannot replace a document edited while file bytes are being read", async () => {
  const { readImportSnapshot } = await import("../app/workbench-runtime.js");
  const session = new DocumentSession(new WorkbenchBridge(null));
  session.open({ markdown: "# Current\n\nOriginal\n" });
  let release: (value: string) => void = () => {};
  const pending = readImportSnapshot(
    session,
    () => new Promise<string>((resolve) => release = resolve),
  );
  session.document!.chapters[0]!.blocks[0].markdown = "New sentence";
  session.touch();
  release("# Incoming");
  let rejected = false;
  try {
    await pending;
  } catch {
    rejected = true;
  }
  assert(rejected, "stale import rejected");
  assert(
    session.document!.chapters[0]!.blocks[0].markdown === "New sentence",
    "new text retained",
  );
});
Deno.test("v4 discovered image insertion uses acknowledged local media and retains attribution", async () => {
  const { insertDiscoveredImage } = await import("../app/workbench-runtime.js");
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const session = new DocumentSession(
    new WorkbenchBridge(
      async (name: string, args: { input: Record<string, unknown> }) => {
        calls.push({ name, input: args.input });
        return {
          id: "asset",
          name: "harbor.png",
          path: "/course/lesson.media/harbor-hash.png",
          relativePath: "lesson.media/harbor-hash.png",
          kind: "image",
          mime: "image/png",
        };
      },
    ),
  );
  session.open({
    path: "/course/lesson.md",
    sourcePath: "/course/lesson.md",
    markdown: "# Lesson\n\n## Research\n\nExisting text\n",
    hash: "h0",
  });
  const target = session.document!.chapters[0]!;
  await insertDiscoveredImage(session, {
    kind: "image",
    url: "https://upload.wikimedia.org/harbor.png",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Harbor.png",
    title: "Harbor",
    attribution: "Jane Photographer",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  }, target.id);
  assert(
    calls[0]!.name === "wb_media_import" &&
      calls[0]!.input.url === "https://upload.wikimedia.org/harbor.png",
    "native bounded original download",
  );
  assert(
    target.blocks[1].url === "lesson.media/harbor-hash.png",
    "actual portable local reference",
  );
  assert(
    target.blocks[0].markdown === "Existing text",
    "existing content preserved",
  );
  assert(
    target.blocks.some((b: { caption?: string; url?: string }) =>
      b.url === "https://commons.wikimedia.org/wiki/File:Harbor.png" &&
      b.caption?.includes("Jane Photographer") &&
      b.caption?.includes("CC BY 4.0")
    ),
    "attribution and original source retained",
  );
});
Deno.test("v4 image import rejection leaves document unchanged rather than inserting an unusable remote embed", async () => {
  const { insertDiscoveredImage } = await import("../app/workbench-runtime.js");
  const session = new DocumentSession(
    new WorkbenchBridge(async () => {
      throw new Error("unsupported_image: PNG/JPEG only");
    }),
  );
  session.open({ path: "/a.md", markdown: "# A\n\nOriginal\n" });
  const before = JSON.stringify(session.document);
  let rejected = false;
  try {
    await insertDiscoveredImage(session, {
      kind: "image",
      url: "https://upload.wikimedia.org/a.svg",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:A.svg",
      title: "A",
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "failure surfaced");
  assert(
    JSON.stringify(session.document) === before,
    "no broken media block inserted",
  );
});
