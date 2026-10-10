# AI Course Workbench

[中文文档（简体）](./README.zh-CN.md)

**A local-first course authoring workbench.** Course map, lesson editor,
requirements ("to complete") tracking, media library, six-dimension completion
status, a review-only AI assistant, and a publish/export center — with your
project data stored in an open `project.json` on your own disk.

Built with a Deno service/domain layer, a dependency-free web UI, and a
restricted [Tauri 2](https://tauri.app) desktop shell. Everything rebuildable
(search index, thumbnails, diagnostics, snapshots) is a cache; the canonical
project file is the single source of truth.

---

## Download

> **Current status: v0.2.7 is published** and the repository is public. The
> links below work for anonymous visitors.

| Entry | Link |
|---|---|
| Latest release page (with release notes) | https://github.com/wyzh0117/workbench/releases/latest |
| **Windows installer (x64, fixed link — always the newest version)** | https://github.com/wyzh0117/workbench/releases/latest/download/AI-Course-Workbench-Windows-x64-setup.exe |
| **macOS disk image (Universal, fixed link — always the newest version)** | https://github.com/wyzh0117/workbench/releases/latest/download/AI-Course-Workbench-macOS.dmg |

Checksum sidecars (`.sha256`) are published next to each installer in every
release. Published releases are frozen: a released tag's assets never change,
so an old download keeps matching its published checksum forever.

### Requirements

| Platform | Minimum | Architecture |
|---|---|---|
| Windows | Windows 10 (1809+) with WebView2 | x64 installer (runs on x64 and ARM64 via emulation) |
| macOS | macOS 11.0 (Big Sur) | Universal — Apple Silicon (arm64) + Intel (x86_64) in one package |

### Install — Windows

1. Download `AI-Course-Workbench-Windows-x64-setup.exe`.
2. Run it and follow the per-user setup wizard (no administrator rights
   required).
3. Launch **AI Course Workbench** from the Start menu.

If Windows SmartScreen shows "Windows protected your PC", choose
**More info → Run anyway** — the installer is not code-signed yet (see
Distribution status below). The installer requires (and will offer to
install) the Microsoft Edge WebView2 runtime.

### Install — macOS

1. Download `AI-Course-Workbench-macOS.dmg`.
2. Open the DMG and drag **AI Course Workbench** to Applications.
3. Launch it from Applications.

The first launch needs a one-time approval because the app is not notarized
yet (see Distribution status below):

- **macOS 15 (Sequoia) / 26 and newer**: double-click, dismiss the dialog,
  then open **System Settings → Privacy & Security**, press **Open Anyway**
  and confirm with your password or Touch ID.
- **macOS 11 (Big Sur) – 14 (Sonoma)**: right-click (or Control-click) the
  app in Applications → **Open** → confirm **Open** in the dialog.

Do not disable Gatekeeper or strip the quarantine attribute.

### Verify your download

Each release ships a `.sha256` sidecar next to the installer:

```powershell
# Windows (PowerShell)
Get-FileHash .\AI-Course-Workbench-Windows-x64-setup.exe -Algorithm SHA256
```

```bash
# macOS
shasum -a 256 ~/Downloads/AI-Course-Workbench-macOS.dmg
```

Compare with the value in the `.sha256` sidecar from the same release.

## Distribution status

Honest current state:

- **Windows**: the NSIS installer is **not code-signed** (no Authenticode
  certificate), so SmartScreen may warn on first run. The per-user installer
  and the app itself are fully functional.
- **macOS**: the DMG is **ad-hoc signed and not notarized**; Gatekeeper
  requires the one-time approval described above.
- Getting proper Windows code signing / Apple Developer ID signing only needs
  certificates added to the release workflow — the app itself needs no changes.

## Features

- **Course map** — stages and lessons you can add, rename, reorder, delete.
- **Lesson editor** — body blocks, structure/flow, paged layout (Grid / Page),
  live preview, placeholders ("to complete") with real anchors.
- **Media library** — images, GIF, video, PDF/DOCX/EPUB/LaTeX/Markdown import
  with previews; referenced-media rename with Undo/Redo.
- **Requirements & six-dimension completion** — what's missing is tracked
  explicitly, separate from author-controlled status.
- **AI assistant (review-only)** — proposes `ChangeDraft`s you review and
  apply one by one; API keys live in the system credential store (macOS
  Keychain / Windows Credential Manager), never in course files.
- **Publish & export center** — Markdown, Semantic HTML, Static Web package,
  PDF, PPTX, WeChat/rich-text variants, Project JSON, asset packs, full
  project packages; strict read-only exports with preflight checks.
- **Safe storage** — atomic writes, autosave with recovery journal, project
  lock, external-modification detection with merge preview, timestamped
  snapshots, per-project reading position.

## Build from source

Prerequisites: [Deno](https://deno.com) 2.x, Rust (stable, MSVC toolchain on
Windows / Xcode command line tools on macOS), and `cargo install tauri-cli`
(or the `@tauri-apps/cli` npm package).

```bash
# 1. run the checks (the same gates releases pass)
deno task check
deno task test                                # service/UI test suite
cargo test --manifest-path src-tauri/Cargo.toml

# 2. build the desktop app for your platform
cargo tauri build                             # from the repository root
```

Platform bundles come from `src-tauri/tauri.<platform>.conf.json`:
macOS builds `app` + `dmg`, Windows builds the NSIS installer.

## Repository layout

```
app/          # dependency-free web UI (also runs inside the Tauri shell)
src/          # Deno domain + service layer (shared with the browser shell)
src-tauri/    # Tauri 2 desktop shell (Rust)
tests/        # Deno test suite
docs/feature-history/  # per-version product history (changelog)
.github/      # release workflow and per-version release notes
```

## Feedback

Issues and discussions are welcome: https://github.com/wyzh0117/workbench
