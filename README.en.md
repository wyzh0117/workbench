# Workbench 4.0.0 · Goorul

A focused revision of the existing Tauri desktop application: open a standard document, optionally analyze it with your configured AI, research real sources and media, edit chapters, then export reusable documents.

[中文说明](README.md) · [Version-specific downloads](https://github.com/wyzh0117/workbench/releases/tag/v4.0.0-Goorul)

## Workflow

- Left: media previews and parent-folder navigation, in two tabs.
- Center: editable chapter-based text, image, video and source blocks with ordering and management.
- Right: real web/image/video discovery and embedded browsing or safe extracted-text reading.
- Both sidebars collapse and resize with pointer and keyboard controls.

Markdown is the editable interchange file; no new proprietary format or required `project.json`. Import Markdown, TXT, DOCX, PDF and PPTX without overwriting the binary source. Export Markdown, HTML, DOCX and editable PPTX. Each PPTX export includes a portable Markdown style guide for producing matching additional slides.

Complex source layouts are not guaranteed to round-trip. Scanned PDFs require text/OCR from another tool. Video and unsupported media retain clear source links and warnings. Native PDF export is not exposed in the focused interface; print the exported HTML to PDF when needed.

## Configuration and privacy

Use Settings to configure your own HTTPS AI endpoint, protocol, model and API key. Analysis/generation sends the document to that provider only when requested. Keys use existing platform secure storage, never document content or browser local storage. Missing credentials produce an honest error; offline editing remains available. There are no simulated API success results.

Image discovery uses Wikimedia Commons with provenance/license metadata. Selected PNG/JPEG images are downloaded into the document’s ordinary media folder before insertion so Office exports embed real bytes; other formats produce an explicit message. Web and video discovery require Brave Search and YouTube Data API credentials. Verify media rights before reuse. Sites can refuse embedded browsing; the safe reader is a labeled fallback, not a bypass.

## Install and verify

The release provides the existing macOS Universal DMG and Windows x64 NSIS installer names, with SHA-256 sidecars. See its notes for actual signing/notarization state. Do not disable operating-system security protections.

Source requirements: Deno **2.9.6**, stable Rust, Tauri 2 CLI and platform build prerequisites.

```sh
deno task check
deno task test
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo tauri build
```

The browser development shell supports real Markdown editing/download, but native filesystem, AI/search and binary document import/export require the desktop application. CI checks do not imply that the app was manually tested on the user's Mac.

The authorized release branch is `workbench-4.0.0-Goorul`, tag `v4.0.0-Goorul`, display title `workbench 4.0.0-Goorul`. Existing main and published refs/assets are not overwritten.

The repository currently has no LICENSE file; this revision does not invent licensing terms.
