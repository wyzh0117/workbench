# V1-T05 / V1-T06 Completion Report

Updated: 2026-09-27

Status: **DONE; final Universal reader smoke pending. V1 remains ACTIVE.**

## Project state

V0 remains CLOSED and V1-T01 through V1-T04 remain VERIFIED. V1-T05 (Paged Canvas) and V1-T06 (Layout-aware Export & PPTX) are implemented; do not create V1-T07 or close V1 before separately authorized work. The latest public release as of this report is v0.1.2.

The user authorized a new v0.2.0 release after acceptance and independent review. That authorization supersedes the task spec's earlier “do not publish a new Release” limitation; it does not authorize changing any published tag or asset. No commit, push, tag, PR, merge, or v0.2.0 Release has been created at this report snapshot.

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
- The earlier intermediate app produced a three-page PDF at 960×540 pt per page; pypdf extracted bilingual text and real image objects, and pdftoppm confirmed image placement. That intermediate PDF SHA-256 was 977a7bdc381e27ca19eb0e9047d3e89eeb0bdf92a7beea3d5dd4cef14bb09cd4.
- The earlier intermediate app's three-page/two-image Static Web package opened in Safari through a local HTTP server. file:// was blocked by Safari's sandbox. These earlier PDF/Web results are supporting evidence, not final-bundle verification.
- The first PPTX triggered PowerPoint Repair. The Rust writer was fixed and structural regression tests were added. PowerPoint opened the direct-renderer probe without Repair. The latest Tauri UI export, /tmp/tauri-acceptance/exports/fixed-course-3pages-ui.pptx (SHA-256 fc027d3879642cc113e06fa262f429d3ecb1813f5d07a04127d62edf606ce84e), opened without Repair and showed three slides. The acceptance agent also edited text, moved an image and saved an independent copy; the final copy/hash check is pending.
- Remaining native checks use the final Universal bundle: page restore smoke, single/selected-page PDF, Static Web reader and asset check, and a short final PPTX/export smoke. T05/T06 remain DONE, not VERIFIED, until these checks and final independent review are complete.

## Final local Universal build

    App: src-tauri/target/universal-apple-darwin/release/bundle/macos/AI Course Workbench.app
    Version: 0.2.0
    Architectures: x86_64 arm64
    Executable SHA-256: 885fb6b143bf578405ba85db29edb623031d58994d624a12e0aa266d43de3d29

    DMG: src-tauri/target/universal-apple-darwin/release/bundle/dmg/AI Course Workbench_0.2.0_universal.dmg
    Size: 10,856,185 bytes
    SHA-256: 6800e76ea5717e9cc64403eeba3eb73c525fefd662442c3a6977e82f2ed0ffb2

hdiutil verify passed. The app is ad-hoc signed; it has no Apple Developer ID signature and is not notarized. This is a local candidate, not a GitHub Release. The final native smoke is still pending.

## Release path

.github/release-notes/v0.2.0.md contains the release-specific T05/T06 notes. After final acceptance and review, merge the PR to main, then push only the v0.2.0 tag at that commit. The tag-push event is the only workflow trigger that publishes; workflow_dispatch, including dispatch on a tag, only builds. The workflow creates the Release and uploads the DMG plus its SHA-256 sidecar. Do not also run gh release create or gh release upload. After publication, compare main, origin/main and the release tag commit, then anonymously download the DMG and sidecar and verify the checksum. Existing releases remain immutable.

## Exact staging allowlist

Stage only these task paths after final acceptance. Do not use git add -A.

    .github/release-notes/v0.2.0.md
    .github/workflows/release.yml
    PROJECT_MASTER_CONTROL.md
    README.md
    V1-T05_T06_Completion_Report.md
    V1-T05_T06_Paged_Canvas_and_Layout_Aware_Export.md   # include unchanged; original task spec
    app/authoring.js
    app/layout_pages.d.ts
    app/layout_pages.js
    app/main.js
    app/publication.d.ts
    app/publication.js
    app/styles.css
    app/views.js
    deno.json
    src-tauri/Cargo.lock
    src-tauri/Cargo.toml
    src-tauri/src/lib.rs
    src-tauri/src/paged_export.rs
    src-tauri/tauri.conf.json
    src/domain/layout.ts
    src/domain/store.ts
    src/domain/types.ts
    src/service/browser_session.ts
    src/service/import_export.ts
    src/service/publish.ts
    tests/authoring_ui_test.ts
    tests/import_export_test.ts
    tests/native_boot_test.ts
    tests/p2_interaction_test.ts
    tests/paged_section_export_review_test.ts
    tests/t04_adoption_test.ts

Exclude the pre-existing unrelated untracked files V1-T03_T04_Combined_Development_Package.md and docs/superpowers/plans/2026-09-25-v1-t03-t04-authoring-and-explorer.md. The T05/T06 task spec above is directly relevant and remains unmodified. No staging, commit, push, tag or release has been done at this report snapshot.
