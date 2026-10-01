import { markdownFromEditable, markdownSemantics, parseMarkdown, renderMarkdown } from "../app/markdown.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function textNode(value: string) {
  return { nodeType: 3, nodeValue: value, childNodes: [] };
}

function elementNode(name: string, children: unknown[] = [], attrs: Record<string, string> = {}) {
  return {
    nodeType: 1,
    nodeName: name,
    childNodes: children,
    children: children.filter((child: any) => child?.nodeType === 1),
    getAttribute(key: string) { return attrs[key] ?? null; },
    querySelector: (_selector?: string): unknown => null,
    querySelectorAll: (_selector?: string): unknown[] => [],
  };
}

Deno.test("markdown parsing keeps GFM semantics, safe HTML and image references", () => {
  const result = parseMarkdown([
    "# 导论",
    "",
    "**粗体** 和 \\*\*转义\*\* 与 `**代码字面量**`。",
    "",
    "> 引用",
    "",
    "- 一级",
    "  - 二级",
    "- [x] 完成",
    "",
    "|标题|内容|",
    "|---|---|",
    "|**表格**|行|",
    "",
    "![封面](images/cover.png)",
    "![封面](images/cover.png)",
    "![远程](https://example.com/x.png)",
    "<script>alert(1)</script>",
  ].join("\n"));
  assert(result.blocks.some((block) => block.type === "heading" && block.level === 1), "heading semantics missing");
  assert(result.blocks.some((block) => block.type === "list" && block.text.includes("- [x] 完成")), "nested/task list source missing");
  assert(result.blocks.some((block) => block.type === "table"), "GFM table was not recognized");
  assert(result.explicitLocalImageRefs.length === 2, "only explicit local image references should be returned");
  const [firstRef, secondRef] = result.explicitLocalImageRefs;
  assert(firstRef && secondRef, "expected two local image reference records");
  assert(firstRef.blockIndex === secondRef.blockIndex, "image reference block index mismatch");
  assert(secondRef.occurrence === 1, "repeated image occurrence should be stable");
  assert(result.html.includes("<strong>粗体</strong>"), "strong formatting was lost");
  assert(result.html.includes("<table>"), "table did not render");
  assert(result.html.includes("<code>**代码字面量**</code>"), "code span was parsed as formatting");
  assert(result.html.includes("&lt;script&gt;"), "raw HTML was not escaped");
  assert(!result.html.includes("<script>"), "raw HTML must not execute");
  assert(!result.html.includes("<img src="), "images must wait for a controlled resolver");
  assert(!renderMarkdown("![bad](javascript:alert(1))", { resolveImage: () => "blob:ignored" }).includes("<img src="), "dangerous image schemes must be rejected");
  assert(renderMarkdown("![ok](images/a.png)", { resolveImage: () => "blob:asset-preview" }).includes('src="blob:asset-preview"'), "controlled image preview missing");
});

Deno.test("publication semantic Markdown keeps inline meaning and only resolved images", () => {
  const semantics = markdownSemantics(
    "**粗体** `字面` [链接](javascript:alert(1)) ![封面](images/a.png) <script>x</script>",
    { resolveImage: (href) => href === "images/a.png" ? { asset_id: "asset-a" } : null },
  );
  const paragraph = semantics[0];
  assert(paragraph?.type === "paragraph", "expected paragraph semantics");
  assert(paragraph.children.some((node) => node.type === "strong"), "inline emphasis missing");
  assert(paragraph.children.some((node) => node.type === "code" && node.text === "字面"), "code span did not stay literal");
  assert(!paragraph.children.some((node) => node.type === "link"), "unsafe link should be inert");
  const image = paragraph.children.find((node) => node.type === "image");
  assert(image?.type === "image" && image.asset_id === "asset-a", "controlled image asset reference missing");
  assert(paragraph.children.some((node) => node.type === "text" && node.text.includes("<script>")), "raw HTML should remain inert text");
});

Deno.test("rich editor round-trip writes Markdown while keeping inline formatting", () => {
  const strong = elementNode("STRONG", [textNode("你好")]);
  const paragraph = elementNode("P", [textNode("前言 "), strong, textNode(" 结束")]);
  const root = elementNode("DIV", [paragraph]);
  const markdown = markdownFromEditable(root);
  assert(markdown === "前言 **你好** 结束", `unexpected Markdown: ${markdown}`);
  assert(renderMarkdown(markdown).includes("<strong>你好</strong>"), "edited rich text did not survive Markdown round-trip");
  assert(renderMarkdown("## **标题**", { inlineOnly: true }).includes("<strong>标题</strong>"), "heading editor should preserve inline format without adding a heading wrapper");
});

Deno.test("edited lists, tables and local image refs round-trip as one Markdown source", () => {
  const image = elementNode("IMG", [], {
    alt: "封面",
    "data-markdown-image-href": "images/cover.png",
    "data-markdown-image-title": "封面图",
  });
  const nested = elementNode("UL", [elementNode("LI", [textNode("子项")])]);
  const parentItem = elementNode("LI", [textNode("父项 "), elementNode("STRONG", [textNode("粗体")]), textNode(" "), image, nested]);
  const taskItem = elementNode("LI", [textNode("完成")]);
  taskItem.querySelector = (selector?: string) => selector === "input[type='checkbox']" ? { checked: true } : null;
  const list = elementNode("UL", [parentItem, taskItem]);

  const header = elementNode("TR", [elementNode("TH", [textNode("词语")]), elementNode("TH", [textNode("说明")])]);
  const row = elementNode("TR", [elementNode("TD", [elementNode("EM", [textNode("课程")])]), elementNode("TD", [textNode("一段文本")])]);
  const table = elementNode("TABLE");
  table.querySelectorAll = (selector?: string) => selector === "tr" ? [header, row] : [];
  const markdown = markdownFromEditable(elementNode("DIV", [list, table]));
  const parsed = parseMarkdown(markdown);

  assert(markdown.includes("**粗体** ![封面](images/cover.png \"封面图\")"), `image and inline formatting were lost: ${markdown}`);
  assert(markdown.includes("- [x] 完成"), `task state was lost: ${markdown}`);
  assert(markdown.includes("  - 子项"), `nested list was lost: ${markdown}`);
  assert(parsed.blocks.some((block) => block.type === "list"), "edited list no longer parses as a list");
  assert(parsed.blocks.some((block) => block.type === "table"), "edited table no longer parses as a GFM table");
  assert(parsed.explicitLocalImageRefs.length === 1, "local image reference was lost");
  assert(parsed.explicitLocalImageRefs[0]?.href === "images/cover.png", "image reference target changed");
});
