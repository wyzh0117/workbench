# Workbench 4.0.0 — focused standard-document workbench

## Intent and authority

Repair the existing Workbench, retaining its Tauri desktop shell and trustworthy parsing, credential, network and export infrastructure. The user explicitly delegated undecided design choices and authorized a new branch, tag and release; no approval gate is pending. This is an installable application, not the supplied HTML sketch or a separate product.

## Product boundary

One workflow: open a document → optionally ask a configured AI to analyze it → discover relevant real multimedia and read sources → select and edit chapter content → export standard documents and presentations. Remove the old course dashboards, inbox, mapping, project registry and publishing-center routes from the active interface. Retain historical implementation and tests only where useful for safe reuse; they are not additional user-facing modules.

Three-pane interface: left tabs for a visual media library and parent-folder navigation; center editable chapters with text, image, video and source blocks, reorder and removal controls; right search and an embedded source reader/browser with insertion controls. Both sidebars collapse and resize with pointer and keyboard controls. Use the supplied transparent tube logo and the sketch's restrained green/white direction, but no simulated imports, AI or exports.

## Decisions made on the user's behalf

- Keep Tauri 2, Rust and dependency-light JavaScript instead of rewriting in Electron or shipping only a web mockup.
- Markdown is the editable interchange file, with ordinary relative media files; no new proprietary project extension or mandatory project.json. Binary imports are read-only sources and save as Markdown copies.
- Export Markdown, standalone HTML, DOCX and editable PPTX. Browser print can produce PDF, clearly distinguished from a native PDF export.
- PPTX generation also writes a portable Markdown style guide describing actual typography, colors, dimensions, layouts, media treatment and instructions for matching additional slides.
- Selected Wikimedia Commons PNG/JPEG images are downloaded through a bounded fixed-host native request into ordinary local media before insertion; unsupported types fail explicitly without mutating the document.
- Existing configured HTTPS model/search adapters remain explicit opt-in. Missing credentials never produce mock success; manual editing remains available offline. No paid AI requests during development without configured authorization.
- Embedded safe source reading is the dependable default where remote sites forbid framing; retain original source links and label reader limitations rather than bypass site security headers.
- Branch `workbench-4.0.0-Goorul`; tag `v4.0.0-Goorul`; release title `workbench 4.0.0-Goorul`; numeric app version `4.0.0` for Windows packaging. Existing main and published refs/assets remain unchanged.

## Safety and persistence

Read bounded document/media inputs and reuse native parsers. Escape untrusted text and avoid executable HTML. Credentials stay in existing platform stores, not UI storage or exports. Preserve source files, detect external Markdown modifications before overwriting, and validate selected paths and public network destinations. Recoverable errors must leave editor content intact.

## Verification and delivery

Run existing Deno type/test suites, new focused frontend tests and native Rust tests. Exercise actual rendered UI with local fixtures, including repeated import, cancellation, missing model keys, export and resizing; test fixtures are not production fallbacks. Build the retained macOS Universal DMG and Windows x64 NSIS architecture on matching GitHub runners. Verify package metadata, hashes and release downloads. Do not claim macOS runtime testing from Linux. The beginner-friendly HTML delivery report is explicitly outside this repository and is delivered separately by the parent assistant.
