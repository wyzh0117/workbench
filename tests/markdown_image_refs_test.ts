import { parseMarkdown } from "../app/markdown.js";
import { buildMarkdownDependencyPreview } from "../app/canvas.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Markdown image refs include remote and escaping links from AST, not code", () => {
  const parsed = parseMarkdown([
    "![local](images/ok.png)",
    "![remote](https://example.test/remote.png)",
    "![missing](images/missing.png)",
    "![escape](../outside.png)",
    "",
    "```markdown",
    "![code](credentials.png)",
    "```",
    "",
    "`![inline code](ignored.png)`",
  ].join("\n"));

  assert(
    parsed.imageRefs.map((ref) => ref.href).join(",") ===
      "images/ok.png,https://example.test/remote.png,images/missing.png,../outside.png",
    "all Markdown image AST refs should be available for preview classification",
  );
  assert(
    parsed.explicitLocalImageRefs.map((ref) => ref.href).join(",") ===
      "images/ok.png,images/missing.png,../outside.png",
    "only syntactically local AST refs should be authorized for filesystem checks",
  );
  const preview = buildMarkdownDependencyPreview("sha256", parsed, {
    "images/ok.png": "present",
    "images/missing.png": "missing",
    "../outside.png": "outside_root",
  });
  assert(
    preview.counts.local_readable === 1 &&
      preview.counts.missing === 1 &&
      preview.counts.outside_root === 1 &&
      preview.counts.remote_or_unsafe === 1,
    "dependency preview should count each explicit AST image by safety/readability",
  );
});
