# Mapping backend and format evidence

Evidence is from fixtures and parser unit tests run on the v0.2.6 working tree.

## Reproducible checks

| Command | Result |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | PASS |
| `cargo check --manifest-path src-tauri/Cargo.toml --all-targets -j2` | PASS |
| `cargo test --manifest-path src-tauri/Cargo.toml -j2` | PASS, 222 library tests; binary and doc-test targets also pass (0 tests). Loopback access is required by existing AI/auth tests. |
| `cargo build --manifest-path src-tauri/Cargo.toml -j2` | PASS |
| `deno test --allow-read --allow-write tests/document_import_dialog_test.ts --filter 'checked documents under one new lesson folder share its folder-named lesson'` | PASS, 1 passed. |
| `deno test -A tests/t04_adoption_test.ts` | PASS, 15 passed. |
| `deno test --allow-read --allow-write tests/t04_adoption_test.ts --filter 'append targets a lesson'` | PASS, 1 passed; existing lesson content/pages survive append and deleted-target duplicate is skipped. |

The main format fixture is `tests::folder_adopt_preserves_semantic_images_across_selected_formats` in `src-tauri/src/lib.rs`; its focused command is:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib folder_adopt_preserves_semantic_images_across_selected_formats -j2
```

It passes and asserts source order, image alt text, exact managed-file bytes, semantic `AssetUsage`, no usage for recursively collected unused media, and persistence after close/reopen. Its four lessons correspond to one selected document each under a selected stage folder.

| Input | Extracted image position and behavior | Known degradation |
| --- | --- | --- |
| Markdown `.md` / `.markdown` | The native path parses GFM itself when no parsed blocks are supplied. The fixture retains heading, quote, list, table, code, and paragraph order; the referenced GIF remains in its source paragraph with its alt text and creates one usage at that block. The Deno execution path parses the checked source at adoption time and imports only referenced local images. | A missing local image keeps the original Markdown reference and raises a warning. Unsafe root escapes are rejected. |
| DOCX `.docx` | The fixture places an embedded PNG in the document body after its heading. Extraction keeps the image at that document position, materializes the original bytes, and creates a usage for the corresponding block. | Header/footer/layout parts and unsupported objects are not treated as body content; unsupported objects and table/anchor details warn when they cannot be preserved. |
| EPUB `.epub` | The fixture follows OPF spine order. The chapter heading precedes an inline GIF in its paragraph and the ending paragraph follows it; `alt` is retained, exact bytes are managed, and a usage points at the image block. | Unresolvable images warn while text remains; CSS, scripts, and package metadata do not become lesson blocks. |
| LaTeX `.tex` / `.latex` | `\includegraphics[width=1cm]{../shared/latex figure.gif}` resolves through the Markdown local-image resolver. A parent-relative path that remains inside the source root is accepted, the space is percent-encoded, and the image remains between surrounding paragraph text with exact bytes and a usage. | Math and unsupported environments/macros degrade with warnings while readable source remains. `\graphicspath` and legacy graphics macros are not resolved. |
| Recursive GIF media | A nested GIF is copied byte-for-byte into managed assets. Referenced Markdown, EPUB, and LaTeX GIFs each retain their semantic block position and create usage rows. | A GIF found only by recursive media scan enters the asset library without a usage or body block. |
| PDF `.pdf` | Existing parser fixtures verify text-stream extraction and page/reading order. | Image XObjects are reported but not imported; no reliable semantic image position is asserted, so no image usage is fabricated. |

The lesson-folder adoption fixtures additionally assert that two checked direct-child documents share one folder-named Lesson for `unassigned_lesson`, `null`, and an existing-stage destination; an unchecked third document is not imported. Stage-folder children remain one Lesson per selected document, and existing-lesson appends preserve the target Lesson. Client-supplied grouping/title fields are discarded before the backend derives grouping from the confirmed parent mapping. Duplicate Markdown is skipped before a stale destination is resolved; both the native and Deno paths have regression fixtures for this case.
