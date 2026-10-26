import { initialViewState, renderWorkbench } from "../app/workbench-view.js";
import { parseDocument } from "../app/workbench-model.js";
function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
Deno.test("v4 real empty shell has two library tabs and independent accessible resize handles", () => {
  const html = renderWorkbench(initialViewState());
  assert(html.includes("媒体库") && html.includes("文件夹"), "two tabs");
  assert(
    (html.match(/role="separator"/g) || []).length === 2,
    "two resize handles",
  );
  assert(
    html.includes('aria-valuemin="200"') &&
      html.includes('aria-valuemin="280"'),
    "resize bounds",
  );
  assert(
    !html.includes("海上运输") && !html.includes("示例来源"),
    "no fixture material",
  );
  assert(html.includes("导入文档"), "import path");
});
Deno.test("v4 document surface exposes chapters and typed block management while escaping hostile text", () => {
  const s = initialViewState();
  s.document = parseDocument(
    "# <script>\n\n## Chapter\n\nText\n\n![Alt](javascript:alert)",
  );
  const html = renderWorkbench(s);
  assert(html.includes("&lt;script&gt;"), "title escaped");
  assert(html.includes('data-action="block-up"'), "reorder control");
  assert(html.includes('data-action="chapter-delete"'), "chapter management");
  assert(!html.includes('src="javascript:'), "unsafe image blocked");
});
Deno.test("v4 reader distinguishes embedded site from extracted text and permits selecting source text", () => {
  const s = initialViewState();
  s.rightTab = "browser";
  s.reader = {
    url: "https://example.org/",
    title: "Source",
    text: "Verified content",
  };
  s.readerMode = "web";
  let html = renderWorkbench(s);
  assert(
    html.includes("<iframe") && html.includes("sandbox="),
    "sandboxed actual browser",
  );
  s.readerMode = "text";
  html = renderWorkbench(s);
  assert(html.includes("Verified content"), "real text shown");
  assert(
    html.includes('data-action="insert-selection"'),
    "selection insertion",
  );
});
Deno.test("v4 native media never bypasses bounded preview IPC with a direct remote image request", () => {
  const s = initialViewState();
  s.native = true;
  s.document = parseDocument(
    "# A\n\n![Remote](https://upload.wikimedia.org/example.png)",
  );
  let html = renderWorkbench(s);
  assert(
    !html.includes('src="https://upload.wikimedia.org'),
    "native CSP boundary",
  );
  s.previewUrls["https://upload.wikimedia.org/example.png"] =
    "data:image/png;base64,AA==";
  html = renderWorkbench(s);
  assert(
    html.includes('src="data:image/png;base64,AA=="'),
    "native bounded preview used",
  );
});
Deno.test("v4 welcome lists only native import formats actually supported", () => {
  const html = renderWorkbench(initialViewState());
  assert(
    html.includes("Markdown · TXT · Word · PowerPoint · PDF"),
    "actual import formats listed",
  );
  assert(
    !html.includes("PDF · HTML · LaTeX"),
    "unsupported imports never advertised",
  );
});
