# Workbench v3.1.0 baseline

- Captured: 2026-10-26 (Asia/Shanghai)
- Checkout: `3baa601efa26473676fe420cfc7837a00bbae405` (detached HEAD)
- Worktree: clean before implementation; no repository `AGENTS.md` or separate project pointer was present.
- `deno task check`: passed (full output: `deno-task-check.log`).
- `deno task test`: 773 passed, 0 failed (31s; full output: `deno-task-test.log`).
- `cargo test --manifest-path src-tauri/Cargo.toml`: 298 passed, 0 failed, 2 ignored (full output: `cargo-test.log`). Both ignored tests are present in the baseline log:
  - `tests::manual_native_project_save_warm_metrics`: manual warm benchmark; set `WORKBENCH_NATIVE_IO_FIXTURE` to a valid large `project.json` to run it.
  - `generate_office_review_samples`: writes temporary PPTX packages for manual Office inspection.

These are pre-change results. They establish the v3.0.2 test baseline only; they are not v3.1.0 acceptance evidence.
