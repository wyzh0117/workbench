# v3.1.0 backend focused validation

Captured 2026-10-26 in the shared `codex/v3.1.0` worktree. Raw command output is beside this file.

| Check | Result | Log |
|---|---:|---|
| `deno task check` | pass | [deno-task-check.log](deno-task-check.log) |
| `deno test --allow-all tests/browser_session_test.ts tests/resource_discovery_workflow_test.ts tests/resource_document_discovery_test.ts` | 12 passed, 0 failed | [deno-focused-tests.log](deno-focused-tests.log) |
| `cargo fmt --all --check` | pass | [cargo-fmt-check.log](cargo-fmt-check.log) |
| `cargo test discovery_ -- --nocapture` | 3 passed, 0 failed | [cargo-document-parser-tests.log](cargo-document-parser-tests.log) |
| `cargo test session_payloads_carry_reader_position_but_never_credentials -- --nocapture` | 1 passed, 0 failed | [cargo-session-test.log](cargo-session-test.log) |
| `cargo test document_context_keeps_only_parser_verified_evidence_and_bounded_constraints -- --nocapture` | 1 passed, 0 failed | [cargo-document-context-test.log](cargo-document-context-test.log) |
| `cargo test interrupted_and_failed_rows_keep_stable_query_indexes -- --nocapture` | 1 passed, 0 failed | [cargo-retry-index-test.log](cargo-retry-index-test.log) |

The parser test covers bounded Markdown/TXT plus DOCX/PDF through their existing canonical text readers; the PPTX test checks slide text in actual slide order. The Deno discovery workflow test uses injected provider contracts; it verifies resume/retry and evidence behavior, not live provider networking. Rust tests validate the native session schema and parser/context/retry helpers, not the running Tauri GUI. Brand is separately re-testing the rebuilt native app against a real local fixture after the session allowlist fix.

The route-migration precedence regression was fixed and is covered by the focused browser-session run: when an old route maps to a current settings section or course-tree filter, the resolved destination takes precedence over a cached subview value.

No Brave/YouTube credentials are configured. External search providers and full live network discovery remain unverified; do not count mock candidates as live results. Baseline full-suite outputs are recorded under `../baseline/`.
