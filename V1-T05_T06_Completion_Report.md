# V1-T05 / V1-T06 Completion Report

Updated: 2026-09-28

Status: **VERIFIED. V1 remains ACTIVE; next step is user dogfood.**

## Project state

V0 remains CLOSED and V1-T01 through V1-T06 are VERIFIED. Do not create V1-T07 or close V1 before separately authorized work.

The user authorized a new release after acceptance and independent review, superseding the task spec's earlier “do not publish a new Release” limitation. `v0.2.1` is now published. The earlier `v0.2.0` tag-triggered workflow failed during macOS certificate import before creating a GitHub Release or assets; that tag remains immutable. All previously published tags and assets remain immutable.

## Delivered

- Grid layouts support persistent page identity, order and size, page create/rename/duplicate/reorder, placement and cross-page movement. Existing continuous layouts remain readable and can be converted to pages.
- UI and exporters share one publication projection and capability check. Mixed-size course PDF/PPTX requires an explicit target page size; preflight warnings are tied to the project snapshot and blocking issues cannot be acknowledged away.
- Native HTML, PDF and PPTX render the projected page geometry. PPTX uses one slide per page and separate editable text and picture objects; attachments do not add slides.
- Session restore preserves layout_page_id and zoom when the saved project matches the canonical launch directory.

## Automated validation

| Check | Result |
|---|---|
| deno task test | 346 passed, 0 failed |
| deno task check | Passed |
| Adoption → pagination → preflight/export → original file preservation | tests/t04_adoption_test.ts, adopted folder can page and export while source files stay unchanged (§12.2); included in 346 tests |
| Focused UI/shared projection tests | native_boot_test 9/9; authoring_ui_test 43/43; paged_section_export_review_test.ts 6/6 |
| Rust | cargo fmt --check; cargo test 78/78 |
| PPTX structure | OPC parts/content types, slide layout ID and theme style matrix contract tests passed |
| Independent review | Legacy schema migration, clone identity/anchors, paged HTML selected scope, old Grid preview and multi-section ambiguity fixes reported PASS |
| Graft | 74 indexed files; 2199 nodes / 6881 edges; generated cache is git-ignored |

## Desktop and reader evidence

- An isolated project was converted from three legacy sections to three pages in the native UI. After the session-restore fix, the diagnostic app restored page 3 on two consecutive close/restart cycles. The saved layout_page_id, zoom and canonical project path matched. Diagnostic app executable SHA-256: 9484881a31e6e30f20c47282be3e01cf849745442507e1a74d3a9668a07a12b1.
- The earlier intermediate app produced a three-page PDF at 960×540 pt per page; pypdf extracted bilingual text and real image objects, and pdftoppm confirmed image placement. Its SHA-256 is 977a7bdc381e27ca19eb0e9047d3e89eeb0bdf92a7beea3d5dd4cef14bb09cd4. The clean sample is deliverables/v0.2.0/paged-course/full-course-3pages.pdf.
- The three-page/two-image Static Web package opened directly from file:// in Chrome with an isolated profile, without Workbench or an HTTP server. The persistent, clean sample is deliverables/v0.2.0/static-web/; it contains only index.html, manifest.json and the two referenced images. Its README records the source app identity and per-file hashes. This is an intermediate-app export; final Universal smoke checks the current runtime/export chain without repeating the full Web reader test.
- PowerPoint opened the three-page Tauri UI export without Repair. Text and a picture remained independently editable in PowerPoint; changes could be saved. The clean sample is deliverables/v0.2.0/paged-course/full-course-3pages.pptx (SHA-256 fc027d3879642cc113e06fa262f429d3ecb1813f5d07a04127d62edf606ce84e).
- The final Universal app launched and restored page 3 in the isolated project. Its executable hash matches the built app. Native current-page PDF smoke: /private/tmp/tauri-acceptance/exports/universal-smoke-current-page-p3.pdf (SHA-256 7eec0f3524f3feb696b6e8a45be27bca60dc48020e72ffe3934c493b1914bc73); pypdf confirmed one 960×540 pt page containing the third page's title and body. Together with the independently checked full-course PDF, editable PowerPoint deck and direct file:// Static Web sample, this completes the T05/T06 acceptance set.

## Verified local Universal build used for T05/T06 acceptance

    App: src-tauri/target/universal-apple-darwin/release/bundle/macos/AI Course Workbench.app
    Version: 0.2.0 (local T05/T06 reader acceptance build, predating the v0.2.1 release)
    Architectures: x86_64 arm64
    Executable SHA-256: 885fb6b143bf578405ba85db29edb623031d58994d624a12e0aa266d43de3d29

    DMG: src-tauri/target/universal-apple-darwin/release/bundle/dmg/AI Course Workbench_0.2.0_universal.dmg
    Size: 10,856,185 bytes
    SHA-256: 6800e76ea5717e9cc64403eeba3eb73c525fefd662442c3a6977e82f2ed0ffb2

hdiutil verify passed. The app is ad-hoc signed; it has no Apple Developer ID signature and is not notarized. The listed DMG hash identifies this local build. The tag-triggered release workflow supplies the published DMG's own SHA-256 sidecar.

## Published release

GitHub Actions run [`36325086880`](https://github.com/wyzh0117/workbench/actions/runs/36325086880) succeeded and published [`v0.2.1`](https://github.com/wyzh0117/workbench/releases/tag/v0.2.1). The release source commit and peeled `v0.2.1` tag are `60f697697843a340da3a793f1bbd2165e390f783`. This documentation-only follow-up is a later commit on `main`; the published tag remains pinned to its release source commit.

The Universal DMG is 10,857,264 bytes with SHA-256 `ca151a578065939f6c2e0dfa4f23955faee5f512c6833ccbe4931a68bf66817c`. An unauthenticated download matched the public `.sha256` sidecar and GitHub asset digest; `hdiutil verify` reported a valid image. The app bundle reports version 0.2.1 and contains x86_64 + arm64. It is ad-hoc signed without Apple Developer ID signing or notarization; users may see macOS security prompts.

The `v0.2.0` tag-triggered run failed before creating a Release because macOS `security import` rejected the workflow's empty certificate values. No v0.2.0 Release assets were published and that tag remains frozen.
