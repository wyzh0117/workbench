import {
  documentStats,
  escapeHtml,
  insertBlock,
  moveItem,
  normalizeWebUrl,
  parseDocument,
  pickPath,
  previewUrl,
  removeBlock,
  serializeDocument,
  sidebarWidth,
} from "../app/workbench-model.js";
function eq(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
}
Deno.test("v4 document round trips chapters, fenced code, images, video and source blocks", () => {
  const markdown =
    "# 课程\n\n导言。\n\n## 第一章\n\n正文。\n\n![港口](assets/port.png)\n\n[视频](assets/clip.mp4)\n\n[来源](https://example.org/report)\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n";
  const doc = parseDocument(markdown, "test.md");
  eq(doc.title, "课程");
  eq(doc.chapters.length, 2);
  eq(doc.chapters[1]!.blocks.map((b: { type: string }) => b.type), [
    "text",
    "image",
    "video",
    "source",
    "text",
  ]);
  eq(serializeDocument(doc), markdown);
});
Deno.test("v4 editing and block order are serialized without mutating other chapters", () => {
  const doc = parseDocument(
    "# Course\n\n## One\n\nAlpha\n\nBeta\n\n## Two\n\nGamma\n",
  );
  const chapter = doc.chapters[0]!;
  moveItem(chapter.blocks, chapter.blocks[1].id, -1);
  eq(chapter.blocks.map((b: { markdown: string }) => b.markdown), [
    "Beta",
    "Alpha",
  ]);
  insertBlock(chapter, { type: "image", url: "media/a.png", caption: "A" });
  eq(chapter.blocks.length, 3);
  removeBlock(chapter, chapter.blocks[1].id);
  eq(chapter.blocks.length, 2);
  eq(serializeDocument(doc).includes("![A](media/a.png)"), true);
  eq(doc.chapters[1]!.blocks[0].markdown, "Gamma");
});
Deno.test("v4 URL boundary permits only public http(s) and rejects executable or local destinations", () => {
  eq(normalizeWebUrl("example.org/a"), "https://example.org/a");
  for (
    const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "http://localhost/a",
      "http://127.0.0.1/a",
      "http://192.168.1.3",
      "https://[::1]/",
    ]
  ) eq(normalizeWebUrl(url), null);
  eq(previewUrl("javascript:alert(1)"), "");
  eq(previewUrl("data:image/png;base64,AA=="), "data:image/png;base64,AA==");
});
Deno.test("v4 sidebar keyboard and pointer resize values stay inside usable boundaries", () => {
  eq(sidebarWidth("left", 10), 200);
  eq(sidebarWidth("right", 900), 560);
  eq(sidebarWidth("left", 300), 300);
});
Deno.test("v4 native picker cancellation never becomes a document path", () => {
  eq(pickPath({ status: "cancelled", path: null }), null);
  eq(pickPath({ status: "selected", path: "/a.md" }), "/a.md");
  eq(pickPath("/a.md"), "/a.md");
});
Deno.test("v4 user strings are escaped and counts derive only from content", () => {
  eq(escapeHtml('<img onerror="x">'), "&lt;img onerror=&quot;x&quot;&gt;");
  eq(documentStats(parseDocument("# A\n\n## B\n\nText")).blocks, 1);
});
Deno.test("v4 previews reject private hosts and credential-bearing public URLs", () => {
  for (
    const url of [
      "https://127.0.0.1/image.png",
      "https://192.168.1.2/a.png",
      "https://user:password@example.org/a.png",
      "http://example.org/a.png",
    ]
  ) eq(previewUrl(url), "");
  eq(previewUrl("https://example.org/a.png"), "https://example.org/a.png");
});
Deno.test("v4 longer fenced code does not terminate at a shorter inner fence", () => {
  const md =
    "# A\n\n## One\n\n````markdown\n```\n## Still code\n```\n````\n\n## Two\n\nDone\n";
  const doc = parseDocument(md);
  eq(doc.chapters.map((c: { title: string }) => c.title), ["One", "Two"]);
  eq(serializeDocument(doc), md);
});
Deno.test("v4 indented code and media link titles survive editing other blocks", () => {
  const md =
    '# A\n\n    const example = true;\n    console.log(example);\n\n![Alt](media/image.png "Attribution")\n';
  eq(serializeDocument(parseDocument(md)), md);
});
