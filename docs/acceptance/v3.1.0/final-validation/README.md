# v3.1.0 final validation

Captured 2026-10-26 from the final shared worktree after UI and version/documentation updates.

Machine-readable counts and evidence scope are in [`results.json`](./results.json).

| Check | Result | Raw log |
|---|---|---|
| `git diff --check` | Pass | [`git-diff-check.log`](./git-diff-check.log) |
| `deno task check` | Pass | [`deno-task-check.log`](./deno-task-check.log) |
| `deno task test` | 778 passed, 0 failed | [`deno-task-test.log`](./deno-task-test.log) |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all --check` | Pass | [`cargo-fmt-check.log`](./cargo-fmt-check.log) |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 304 passed, 0 failed, 2 ignored | [`cargo-test.log`](./cargo-test.log) |

The two ignored Rust tests are unchanged from the baseline: `tests::manual_native_project_save_warm_metrics` is a manual warm benchmark that requires `WORKBENCH_NATIVE_IO_FIXTURE` to point to a valid large `project.json`; `generate_office_review_samples` writes temporary PPTX packages for manual Office inspection. No test was newly ignored in this change. The full provider-backed discovery workflow was not live-tested: no Brave or YouTube credentials or model connection were configured. Injected provider/contract tests do not count as live-network evidence.

Native debug-app evidence is recorded in [`../native-gui-validation.md`](../native-gui-validation.md). It covers real Tauri Markdown parse IPC, project-session reopen after a complete debug-process exit and fresh launch, right-side tabs, public HTTPS `resource.source.read` (`example.com`), and private loopback rejection. The native public-source-read check is not evidence for live AI extraction or search-provider discovery. Signed/package installers and their system icon presentation were not tested.

The separate [UI copy audit](../../../research/ui-copy-audit-v3.1.0.md) contains all 202 unique source-mapped rows and no undecided items. IDs 98 and 112 intentionally retain credential/privacy boundary text; IDs 148 and 150 use the approved expandable PowerPoint note.
