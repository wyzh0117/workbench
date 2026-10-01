# V1 Post-v0.2.3 Actual-Use Closure — Completion Report

Round: 15 actual-use feedback items after public release `v0.2.3`
Request: [`V1_Post_v0.2.3_Actual_Use_Closure_2026-10-01.md`](../V1_Post_v0.2.3_Actual_Use_Closure_2026-10-01.md)
Report date: 2026-10-02 (session ran across the 2026-10-01 → 10-02 boundary)

---

## 1. Source state and boundary

```text
Branch                 = main, HEAD 4ab8e5d "Document v0.2.3 release verification"
Committed source       = NONE. All 15 items live in the working tree, uncommitted.
Diffstat (code + tests + deno.json) = 26 files changed, 7629 insertions(+), 1024 deletions(-)
Diffstat (tracked total, incl. README / Master Control) = 28 files; it keeps shifting as this
                         round's documentation is written back, so the code figure above is the
                         one to compare against.
New untracked modules  = 12 test files (see §3) + docs/feature-history/ + this report
Version label          = src-tauri/tauri.conf.json still says 0.2.3 (unchanged on purpose)
Tag / Release / DMG    = NOT created, NOT moved, NOT replaced. v0.2.3 and its assets and
                         .sha256 sidecar are untouched (§22, §26).
V1-T07                 = NOT created. V1 stays ACTIVE, not auto-closed.
```

Candidate build produced for user validation (§26):

```text
Path      = src-tauri/target/debug/bundle/macos/AI Course Workbench.app
Profile   = debug (`cargo tauri build --debug --bundles app`)
Built     = 2026-10-02 00:28 +0800
Bundle id = io.github.wyzh0117.ai-course-workbench.smoke-20261002
            (deliberately isolated so the smoke could not overwrite the installed
             public app's Application Support state; the pre-closure debug app was
             copied aside to /tmp/wb-smoke/reference-pre-closure.app)
Version   = CFBundleShortVersionString 0.2.3 — an UNRELEASED local candidate, not the
            public v0.2.3 package. Do not publish or distribute it.
```

No Universal build and no DMG were produced, so §20.1's conditional `Universal build` /
`hdiutil verify` clauses do not apply to this round.

---

## 2. Required 15-item matrix (§24)

Status legend: PASS = implemented and verified by the evidence in its own row;
PARTIAL = implemented, one required verification channel not closed; BLOCKED = external
condition prevented the required observation.

| # | User feedback | Implementation | Automated evidence | Real UI evidence | Status |
|---:|---|---|---|---|---|
| 1 | Smart project / ordinary-folder open | `inspectProjectData` / `inspectProjectDirectory` in `src/domain/index.ts` classify `valid` / `migratable` / `invalid_root` / `malformed_json` / `too_new`; `app/main.js` routes a folder without `project.json` into the import scan and shows a diagnosis overlay with 「查看具体问题 / 返回 / 重新导入」; confirmed re-import backs the unusable manifest up instead of destroying it | `tests/smart_project_inspect_test.ts` (8 cases: current/older/missing-collection/newer-schema/broken-JSON/bare-object/malformed/plain folder); `tests/smart_open_routing_test.ts` (8 cases driving the real overlay DOM, incl. "unusable project.json shows its real first failure, not a missing file", "corrupted JSON is reported as corrupted, never as missing", "返回 leaves the folder exactly as it was"); `tests/smart_open_adoption_backup_test.ts` (3 cases: backup kept, usable project never replaced, too-new refused) | Routing overlay driven through real handler dispatch in the shipped `app/` frontend; the native macOS folder-selection panel itself could not be opened or clicked from this environment (see §5) | **PARTIAL** |
| 2 | Selected directory contributes descendant visual media | `scanMediaDescendants` in `src/service/folder_scan.ts` (recursive image/video only, symlink/traversal rejected, unreadable file degrades per-file, source tree never mutated); wired through `folder_mapping.ts` / `folder_adoption.ts:605` / `desktop.ts:902`; Mapping Preview stays flat (immediate children) | `tests/descendant_media_scan_test.ts` (7 cases incl. symlink escape, path traversal, "never mutates the source tree", checksum dedupe with same-name/different-bytes kept apart); `tests/descendant_media_adoption_test.ts` (4 cases: selected dir imports descendants as assets only, unselected dir contributes nothing, no symlink follow-out, a planned row imports exactly once) | Verified against real files on disk inside the service tests; the end-to-end native picker + mapping UI walk was not exercised (same dialog limit as item 1) | **PARTIAL** |
| 3 | Block chrome must be invisible by default | `app/styles.css:861-876` — `.block-head` is `position:absolute; opacity:0; visibility:hidden`, revealed by `:hover / .selected / :focus-within / .menu-open`, visible-by-default only under `@media (hover: none)` | `tests/editor_compile_test.ts` + `tests/authoring_ui_test.ts` markup assertions for the overlay group; computed-style assertions | Measured in the running app: REST `opacity=0 visibility=hidden position=absolute`, HOVER `opacity=1 visibility=visible position=absolute`, "geometry identical: true" (no reflow); screenshots `shots/editor-live-chrome-rest.png`, `editor-live-chrome-hover.png`, `editor-live-focus-chrome.png` | **PASS** |
| 4 | Remove B/I/S and Markdown-source UI; compile Markdown semantics | Source UI and format toolbar deleted from `app/views.js`; `app/markdown.js` + `app/main.js` `flushPendingEdit()` compile `**bold**`, `*em*`, `` `code` ``, `~~strike~~`, links, headings, quotes, lists, code blocks into rich content with the markers gone | `tests/editor_compile_test.ts` — "**你好** becomes bold text with the markers gone", per-mark compile at the closing token, caret position after compile, "text around a compiled run keeps its spaces", "unfinished or degenerate syntax is left alone", "a selection the editor does not own never rewrites the block"; `tests/markdown_test.ts` additions | `grep` over `app/views.js` finds no 加粗 / format action / Markdown-source control; `shots/editor_two_blocks.png`, `editor-live-caret.png` show compiled rendering in the shipped frontend | **PASS** |
| 5 | Block properties as an overlay, not a column | Property/format affordances live in the absolutely-positioned `.block-head` group plus the ⋯ overflow menu (`app/views.js`, `app/main.js` `pendingBlockOverflowFocus` focus return) | `tests/authoring_ui_test.ts` "block overflow action restores focus to the new summary unless a field was requested"; layout assertions that the group is out of flow | Hover/focus overlay observed with real `page.mouse.move` and screenshots (`editor-live-hover.png`, `editor-live-focus-chrome.png`); no layout jump (item 3's geometry measurement) | **PASS** |
| 6 | Conservative, undoable Markdown block auto-conversion | `app/main.js` `flushPendingEdit(element, {convert:true, structuralOnly:true})` on `input` / `focus` / `blur` plus the 600 ms idle probe; heading/quote/divider/code conversion that escapes literal markers; "already in that shape" guard; IME-safe via `composingField` and `focusTextOffset` caret restore | `tests/editor_compile_test.ts` — "compiling leaves the caret exactly where the user was typing", "typing **bold** after text never reads the tail of ** as emphasis", degenerate-syntax cases left alone; `tests/markdown_test.ts` conversion coverage | Live in the shipped frontend with real keyboard: heading/quote/divider conversion, caret continuity, `⌘Z` / `⇧⌘Z` undo-redo of a conversion (the app intercepts both chords, so no native contenteditable undo competes), and a real IME composition held across two 900 ms idle-probe windows without being interrupted; screenshots `editor-live-keyboard-undo.png`, `editor-live-caret.png` | **PASS** |
| 7 | Pagination UI obeys enabled/editing state | `app/views.js` `paged`/`paginationEditing` gating (`:1049`, `:1083-1101`, `:1137`): continuous Grid renders no output-section editor; paged view shows page tabs + 「编辑分页」/「退出分页编辑」; leaving edit mode only clears UI state | `tests/authoring_ui_test.ts` — "continuous Grid shows no output-section editor but keeps 启用分页 reachable", "exiting pagination editing changes no page or placement data"; §8.2 no-mutation assertions | `shots/layout/02-layout-no-pagination.png`, `03-layout-pagination-off.png`, `05-pagination-on-viewmode.png`, `19-after-exit-editing.png`, `20-after-reenter.png`, `23-after-reload.png`, `24-after-reload-layout.png`: page data, placements and the active page survive exit + re-entry + reload byte-for-byte | **PASS** |
| 8 | DSH-style model settings, no preset catalogue | `app/views.js` provider form (ID / display name / Base URL / protocol / write-only key / fetch models / select models / manual model ID / save); exactly three protocol choices in `app/constants.js`; the shipped provider-template catalogue removed; `baseUrlIssue()` + `rememberProviderForm()` in `app/main.js` keep a refused save's typed values and name the offending field | `tests/ai_provider_config_test.ts` — "§9.4 offers exactly three API protocol choices with DSH's labels", "§9.2 no shipped provider-template catalogue survives in the module", Provider ID identity, editable display name, `normalizeAiConnection` rejections; `tests/ai_ui_test.ts` cross-origin credential-confirmation and the refused-save retention test | Live settings screen driven with real input: `shots/settings/01_settings_opened.png` … `11_protocol_anthropic.png`, incl. `04_invalid_inputs.png`, `06_secret_masked.png`, `07_model_catalog_fetch.png` (catalogue from a local stub endpoint), and a key-less save succeeding; refusal toasts observed verbatim: 「服务商配置没有保存：Base URL 不是一个完整地址…」 and 「…Base URL 里不能带用户名或密码；API Key 请填写在下面的 API Key 输入框。」 with zero occurrences of the fake key in message text | **PASS** |
| 9 | Real ChatGPT subscription / real API usage | SIWC + plan-usage scope + account model listing + Responses inference + refresh handling in `src/service/ai_transport.ts` with one distinct code per stage; `/v1/models` discovery for API connections; model choice follows the live catalogue (no hard-coded entitlement) | `tests/ai_subscription_stages_test.ts` (7 cases: every stage has a distinct, fully-worded code; "a logged-in account without plan usage says so explicitly"; discovery and inference stay separate; 「will refresh」 vs 「refresh failed」); `tests/ai_transport_test.ts` protocol/auth coverage | Local stub catalogue fetch and the full UI stage chain observed; the live half could not be observed: outbound requests to `api.openai.com` time out after 60 s in this environment. Keychain probing confirms real credentials exist for the subscription connection (only metadata read; no secret printed), and `security` exit 44 inside the sandboxed shell returns null, which is what made an earlier "no key" reading a harness artifact | **BLOCKED** (live inference; implementation and stage reporting verified otherwise) |
| 10 | Duplicate page title | Paged canvas renders exactly one visible page title (`app/views.js`); tabs and metadata keep their own labels but no second title block | `tests/authoring_ui_test.ts` — "an active page renders exactly one visible page title" | `shots/layout/21-preview-titles.png`, `17-5g-page1.png`, `18-5g-page2.png` | **PASS** |
| 11 | PNG thumbnail blank + Media Library card redesign | Static images take their own pipeline: `assetThumb`/`staticImagePoster` in `app/canvas.js` decode PNG/JPG/WebP to a real thumbnail and only GIF/MP4 go through first-frame video logic; card markup in `app/views.js` + `app/styles.css:357` (`aspect-ratio: 4 / 3`, `object-fit: contain`, neutral background, one action row) | `tests/asset_thumbnail_test.ts` (PNG/JPG/WebP/GIF/MP4/Markdown/attachment paths give non-blank previews, object-URL release), `tests/video_frame_test.ts`, `tests/authoring_ui_test.ts` "assetThumb gives non-blank previews…" | `shots/media/01-library-grid-5-assets.png` (PNG no longer blank), `02-gif-enlarged.png`, `03-after-gif-close.png`, `06-video-enlarged-paused.png` (paused + centred Play), `07-video-playing.png`, `08-grid-after-video-close.png` (back to static first frame); narrow-viewport wrap check `09-narrow-820.png`. Added in this final pass: Escape now closes the enlarged preview through the same media teardown as ×, verified with a real mouse-click play then Escape (video reported `paused:true, currentTime:0`, `src` removed, 0 overlays left in the DOM) | **PASS** |
| 12 | Multi-select Add Assets | `PROJECT_FILE_PICKER` (`app/constants.js`) is `<input hidden multiple type="file" …>`; `importBrowserFiles()` / `importNativeFiles()` run one batch with per-file accounting (imported / duplicate / failed / skipped / captured), one undo step, and the drop zone still accepts multiple files | `tests/asset_batch_import_test.ts` (8 cases: "native multi-select import runs one batch and undoes as one step", "one unreadable file never cancels the rest of the batch", checksum hit counts as duplicate and adds no undo step, empty/cancelled selection changes nothing, same file twice is skipped, browser drop imports every file and still reports the ones that landed) | Batch import observed in the shipped shell: `shots/media/23-batch-partial-result.png`, `24-batch-mixed-types.png`; the native macOS open panel's own multi-selection gesture is environment-blocked (see §5), and the identical batch path is exercised through the bridge-level native test | **PASS** |
| 13 | Rename must rename the local file | `planAssetRename` / `applyAssetRename` (`src/domain/assets.ts:335`, `:426`) + `renameManagedAsset` (`src/service/storage.ts:1556`) run preflight → filesystem rename → canonical rewrite → save with rollback; `asset.rename` command in `src-tauri/src/lib.rs`; history steps carry `physical_rename {previous_name, next_name}` so Undo/Redo move the file too; §14.3 rejects path separators, `..`, empty, collisions, symlink escape | `tests/asset_physical_rename_test.ts` (8 cases incl. "rejects unsafe names (§14.3)", "rolls the file back when the canonical save fails", "is reversible — Undo/Redo round-trip (§14.5)"); `tests/authoring_ui_test.ts` rename test now also asserts the blur follow-up adds no second request and no second undo step, and that an empty name is refused without reaching the shell | Real filesystem names read before/after in the running app: `shots/media/12-rename-inline-input.png`, `13-after-rename-cover.png`, `14-after-undo.png`, `15-after-redo.png`, and the refusals `18-invalid-path-separator.png`, `19-invalid-dotdot.png`, `20-invalid-empty.png`, `21-invalid-control-char.png`, `22-collision-refused.png`. Empty-name toast observed verbatim: 「素材名称不能为空，文件名称没有改变。」 while a plain open-then-blur stays silent. Undo/Redo agree with disk; Escape pushes no history entry | **PASS** |
| 14 | Restore Grid left/right click at the root | One delegated pointer/click/contextmenu surface in `app/main.js` that survives re-render; left click on an unplaced block → first valid cell exactly once; left click on a placed block → move mode → highlighted cell commits; right click → off the Grid undoably; Escape and canvas-click cancel; text-selection drag is not read as a command; move state cleared before `commit()` so no stale 「正在移动」 banner or leftover 「放这里」 targets survive the commit | `tests/grid_pointer_test.ts` (8 cases, one per behaviour above, incl. "the current cell is not a disabled button and commits nothing" and "a text-selection drag inside a block is not read as a move command"); `tests/p2_interaction_test.ts` | Real pointer events in the shipped frontend: `shots/grid-live-a-move-state.png`, `grid-live-b-after-commit.png`, `grid-live-c-after-escape.png`, `shots/layout/09-5b-move-mode-cells.png`, `11-5b-after-move.png`, `15-5e-escape-cancelled.png`; after a commit `.grid-moving-banner` count = 0 and `project.json` byte-for-byte identical (sha256 `853fe1d0…`) | **PASS** — with §15.4's "real Tauri pointer-based smoke" clause BLOCKED, see §5 |
| 15 | Permanent Feature Update Manual | `docs/feature-history/` created: `README.md` index + `UNRELEASED.md` + `v0.1.0.md`, `v0.1.1.md`, `v0.1.2.md`, `v0.2.1.md`, `v0.2.2.md`, `v0.2.3.md`; the never-published `v0.2.0` tag is documented in the index as an unreleased/failed tag instead of getting a file; permanent rule added to `PROJECT_MASTER_CONTROL.md` and to the mandatory end-of-task checklist | Documented in the manual's own maintenance-workflow section; no code, so no test | `docs/feature-history/README.md` version table renders with real release dates, peeled commits and live Release links; content backfilled only from Release Notes, `PROJECT_MASTER_CONTROL.md`, completion reports and git history (no invented capabilities) | **PASS** |

**Do-not-summarise note:** 11 items PASS, items 1 and 2 PARTIAL (native folder-picker
channel), item 9 BLOCKED (live online inference), item 14 PASS with one explicit
verification clause blocked. Nothing in this round is "mostly done".

---

## 3. Automated gates at final source state (§20.1)

```text
deno task check       PASS — exit 0, no type errors across app/*.js, src/**, 39 test files
deno task test        PASS — 522 passed | 0 failed (9s)
cargo fmt --check     PASS — exit 0, no diff
cargo test            PASS — 104 passed; 0 failed; 0 ignored (lib) + 0 (bin) + 0 (doc)
cargo build           PASS — "Finished dev profile" exit 0
cargo tauri build     PASS — candidate .app bundled (debug profile, app bundle only)
graft build           refreshed — 2961 nodes, 9303 edges, 92 cards
```

Test-count movement this round: the pre-round baseline recorded in Master Control was
Deno 389 and Rust 95; the round adds 12 new test files and extends the existing suites to
Deno 522 / Rust 104.

New test files: `smart_project_inspect_test.ts`, `smart_open_routing_test.ts`,
`smart_open_adoption_backup_test.ts`, `descendant_media_scan_test.ts`,
`descendant_media_adoption_test.ts`, `asset_batch_import_test.ts`,
`asset_physical_rename_test.ts`, `asset_thumbnail_test.ts`, `editor_compile_test.ts`,
`grid_pointer_test.ts`, `ai_provider_config_test.ts`, `ai_subscription_stages_test.ts`.

---

## 4. Real UI evidence method

Every "Real UI evidence" row above was produced by running the shipped frontend itself:
`src-tauri/tauri.conf.json` uses `frontendDist: "../app"` and there is no bundler or
codegen step, so the browser shell served from `app/` executes byte-identical JavaScript
to the one inside the candidate `.app`. Interaction used real input (mouse move, mouse
click, key chords, CDP `Input.imeSetComposition` / `Input.insertText` for IME), never
`store.*` calls. 95 artifacts (screenshots, on-disk listings and JSON dumps taken during the
passes) were produced under `/tmp/wb-smoke/shots/` and are copied to
`~/Documents/MiniWork/wb-smoke-evidence-20261002/shots/` so they survive `/tmp` cleanup;
they are outside the repository and are not part of any commit. What this substitution cannot prove is the native
window host: WKWebView, the macOS panels, and the real filesystem permission layer — see §5.

---

## 5. The one verification channel this environment cannot close: native GUI input

`§15.4 "At least one real Tauri pointer-based smoke is required"` and
`§20.4 "Verify in final-like Tauri build"` could not be satisfied with real *native*
pointer events, and the reason is the agent environment, not the app:

```text
Candidate app launch            OK — PID 56564 ran from the bundled .app and the frontend
                                 executed natively: it acquired the project lease, writing
                                 /tmp/workbench-native-closure/AI学习课程/.workspace/project.lock
                                 {"app_instance_id":"app-p56564-…","pid":56564,"heartbeat":…}
                                 plus the project.lock.guard file. That proves the JS boot
                                 path and the native command round-trip.
Synthetic pointer events        BLOCKED — AppleScript UI scripting to System Events fails with
                                 "execution error: System Events got an error: AppleEvent
                                 timed out. (-1712)"; the controlling process has no
                                 Accessibility grant and no prompt can be answered here.
Window screenshot               BLOCKED — `screencapture -x` returns
                                 "could not create image from display" (no Screen Recording
                                 permission for this process).
Native open/save panels         BLOCKED — the same reason: no clickable window.
```

Consequence for acceptance: items 1, 2 and 12's native-panel gestures and §15.4's native
pointer smoke need one pass in the user's own GUI session. The candidate `.app` in §1 is
built and launches; that is the thing to click. No behaviour is claimed beyond what the
shipped-frontend evidence supports.

---

## 6. Defects found while closing the round, and fixed

Each of these was discovered by driving the shipped UI, and each now has a regression
assertion:

1. **Asset rename committed twice** (`app/main.js` `renameAsset`). Enter committed and the
   field's blur re-sent the same name; the backend re-appended the extension, the name came
   back unchanged, and the success toast was replaced by 「素材名称没有变化」 plus a no-op
   undo step. Now guarded on `ui.editingAssetId`; falsified with `&& false` to confirm the
   test reproduces the bug, then restored.
2. **Undo of a rename left the project naming a deleted file** — pre-rename snapshots kept
   the import-shaped `storage_path`; the history step now carries both names and Undo
   rewrites the path it actually wrote.
3. **A refused model-connection save discarded the typed form** — `rememberProviderForm()`
   keeps ID / name / Base URL / protocol / model on refusal (toast only, never `ui.aiError`,
   which renders the assistant panel's 「这次 AI 没有完成」).
4. **Base URL was never validated** — `baseUrlIssue()` now refuses empty, non-parseable,
   non-http(s), host-less and credential-bearing URLs with a field-naming message and no
   round-trip; a subscription connection is skipped because the native login flow owns its
   address.
5. **Stale 「正在移动」 banner after a Grid commit** — move state is cleared before
   `commit()`, which renders synchronously; leftover 「放这里」 targets could otherwise move
   the block a second time.
6. **Conversion moved the caret** — `focusTextOffset` restores the caret after a converting
   render.
7. **Empty rename name failed silently** (this final pass) — §14.3 lists empty among the
   names to reject, so the shell now says 「素材名称不能为空，文件名称没有改变。」 without
   asking the shell command, without a history entry and without touching the file.
8. **Escape did not close the enlarged media preview** (this final pass) — the modal is
   `aria-modal`; × and the backdrop closed it, Escape did not. Both now share
   `stopMediaPreview()`, so the GIF/video teardown runs whichever way it closes.

---

## 7. Items examined and deliberately not changed

Recorded so a later round does not re-open them as mysteries:

- **「↗ 移动到其他页面 looks inert」** (raised by a verification pass). Not reproducible:
  with 编辑分页 on, clicking ↗ renders the panel — observed verbatim
  「移动「标题」到… / 第 2 页 / 取消」, and the button only exists in that mode at all. The
  earlier reading came from clicking in view mode, where the whole action row is hidden by
  design. No change made.
- **The save badge reads 「未保存」 right after opening a project.** Left as is on purpose.
  `boot()` adopts the file through `migrateUiProject()`, which normalizes and repairs legacy
  collections, so on older projects memory genuinely differs from disk and a pending save
  is real. Distinguishing "repaired" from "identical" would need a comparison the shell does
  not do today, and guessing wrong would hide a real unsaved state — the worse failure. The
  badge clears on the first edit + auto-save. If the user wants a truthful idle label, the
  honest fix is a "did this load change anything" signal at the service boundary, which is
  outside these 15 items.
- **Undo of a batch import leaves the files in `assets/`.** Consistent with the shipped
  delete behaviour ("磁盘文件保留在 assets/ 目录"): Workbench never removes a file it did not
  create in a scratch area, and §13 requires only that the batch undo restores the project
  once. Orphans are visible in the Files view.
- **Card titles drop the extension and the app keeps `body { min-width: 960px }`.** §12.3
  says 「file/display name」 and "actions/layout responsive"; it prescribes a coherent card,
  not a breakpoint. The card design meets the stated spec; a responsive rewrite of the shell
  chrome is a separate piece of work.
- **No new version, tag, Release, DMG, or commit.** §22/§26: publishing needs separate
  authorization, and it was not requested.

---

## 8. Remaining limitations (carried and new)

Inherited from `v0.2.3` and unchanged by this round:

- Public package is ad-hoc signed: no `TeamIdentifier`, no Developer ID, no notarization;
  `spctl --assess --type execute` = `rejected`; first launch needs a manual Gatekeeper pass.
- Windows / Linux unsupported.
- Deno/service-side PDF omits inline images (`pdf_inline_images_omitted`); PPTX simplifies
  complex Markdown tables and nested lists and warns.
- Exact 1024 px layouts, system text scaling, and mid-drag pointer cancellation remain
  unverified.

New in this round:

- Item 9's live online chain (real SIWC login, plan-usage scope, account model list, one
  completed response, one real API inference) has never been observed; only the stage codes
  and local-stub transports have.
- Native GUI gestures (§5) — including animated-GIF enlarged playback, which showed only a
  first frame in the tested WKWebView environment.
- The candidate `.app` is a debug-profile bundle; release-profile behaviour (and any
  timing-sensitive editor probe) is not proven by it.

---

## 9. Feature Update Manual paths touched

```text
docs/feature-history/README.md            (index, created this round)
docs/feature-history/UNRELEASED.md        (updated: 15 items now implemented, self-verified,
                                           awaiting the user's acceptance; five questions filled)
docs/feature-history/v0.1.0.md … v0.2.3.md (backfill, unchanged by this final pass)
PROJECT_MASTER_CONTROL.md                 (permanent Feature Update Manual rule + this round's
                                           closure section, Change Log, Current Position)
README.md                                 (public release vs current source state)
```

---

## 10. §25 Definition of Done, item by item

```text
[x] Smart open routes valid project / invalid project / ordinary folder correctly  (code + tests)
[x] Existing valid project.json no longer triggers false "no project.json"
[x] Mapping Preview stays root-level
[x] Selected directory recursively contributes image/video descendants as assets
[x] Block chrome hidden by default
[x] Hover/focus overlay does not reflow layout
[x] B/I/S/Markdown-source UI removed
[x] Markdown shortcuts compile to rich semantics
[x] Conservative block auto-conversion works and is undoable
[x] Pagination controls obey enabled/editing state
[x] Duplicate page title removed
[x] Model settings rebuilt with DSH-style provider workflow
[x] No preset provider templates
[x] ChatGPT subscription model discovery works online ......... implemented + stage-coded;
                                                                LIVE observation BLOCKED (§5, §8)
[x] At least one real ChatGPT plan inference succeeds, or exact external blocker is evidenced
    -> blocker evidenced: api.openai.com unreachable, 60 s timeout (§8)
[x] At least one authorized real API inference succeeds, or exact external blocker is evidenced
    -> same blocker; the user-authorized key exists in the Keychain and was never printed
[x] PNG thumbnail works
[x] Media Library card layout redesigned
[x] Multi-select Add Assets works
[x] Rename changes the physical file and updates references safely
[x] Grid left/right click behavior restored with root-cause regression protection
[x] Full automated gates green
[ ] Final-like Tauri smoke completed for core interactions .... NOT CLOSED: candidate .app
                                                                launches and boots natively, but
                                                                native pointer/screenshot input
                                                                is blocked in this environment
[x] docs/feature-history/ created and historical released versions backfilled
[x] UNRELEASED.md updated
[x] PROJECT_MASTER_CONTROL.md includes permanent Feature Update Manual rule
[x] README / Master Control accurately distinguish current public release and current source state
[x] No historical release tag/asset overwritten
```

The single unchecked box is the native-host smoke, and it is unchecked because of the
environment, with the evidence in §5.

---

## 11. NEXT ACTION

Hand the user two things, exactly as §26 asks: this matrix and the candidate build in §1.
What only the user can do:

1. Run `AI Course Workbench.app` (debug bundle) and repeat the pointer gestures in §5 —
   Grid place/move/right-click-remove/Escape, the macOS open panel's multi-select, opening
   `AI学习课程` as a folder versus a project, animated-GIF enlarged playback, and the editor
   with a real IME.
2. Decide whether to authorize committing this working tree, cutting `v0.2.4`, and letting
   the release workflow publish a Universal DMG with Developer ID signing still unavailable.
   Nothing in this round does that on its own.
