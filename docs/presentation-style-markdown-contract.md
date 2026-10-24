# Presentation style Markdown contract

This file is the shared TypeScript/native contract for `StyleProfile.markdown`.
`workbench-style-v1` is the parser version. Implementations must enforce the
same rules and size limit.

## Shape

- The complete Markdown document is limited to 100,000 UTF-8 bytes.
- The selected variant has exactly one full heading line
  `## Variant: \`{variant_id}\``. Its section ends at the next level-two heading.
- Inside that section, include exactly one closed fence. The opening line is
  exactly three backticks followed by `workbench-style`; the closing line is
  exactly three backticks, with no extra spaces or text.
- The fence contains one JSON `PresentationStyleTokens` object. Unknown keys
  are rejected. The six top-level keys below are required.
- A block has exactly these top-level keys: `slide_size_emu`, `theme_colors`,
  `theme_fonts`, `placeholders`, `representative_objects`, and
  `editable_rules`.
- `editable_rules` has exactly `title` and `body`. Each rule may set only
  `font_size_hundredth_pt`, `color`, `x`, `y`, `width`, and `height`, using the
  shared `PresentationStyleTokens` field types. An omitted or `null` editable
  field means unchanged; unknown fields are rejected.

The shared valid parser sample is
[`tests/fixtures/presentation_style_markdown.md`](../tests/fixtures/presentation_style_markdown.md).
Its empty fact arrays keep it small; generated documents contain the complete
PPTX-extracted values.

## Authority and validation

The PPTX extraction report is authoritative for slide size, theme colors,
theme fonts, placeholders, and representative objects. Those fields are
read-only facts. Saving rejects missing/duplicate/malformed fences, unknown
keys, invalid editable values, or any change to those extracted facts. Only
`editable_rules` may change.

Font sizes are integer hundredths of a point from 100 through 400,000. Colors
are `#RRGGBB`. Geometry values are integer EMU values; positions are
nonnegative, dimensions are positive, and the resulting rectangle must fit
inside known slide dimensions. Geometry that cannot be validated against the
selected title/body shapes or known canvas dimensions is rejected at
preview/export.

The profile stores the exact Markdown plus its UTF-8 SHA-256 as both
`markdown_hash` and `parsed_from_hash`, and stores `parser_version` as
`workbench-style-v1`. Saving creates a new style revision. Preview and export
must re-hash and re-parse the current Markdown, verify both stored hashes and
the parser version, re-inspect the source PPTX, and compare its SHA-256 and
extracted facts before using those tokens. A parse or binding failure blocks
preview/export; stale tokens are never reused.

SVG previews describe supported OOXML structure and are not PowerPoint
renderings. Visual inferences remain separately labeled for user review.
