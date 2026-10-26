# Workbench v3.1.0 backend decisions

Date: 2026-10-26

## Decisions

- Document discovery reads only an existing canonical `asset_id` imported into the active project. It does not accept arbitrary local paths or add a course/resource entity migration. Native parsing supports DOCX, PDF, PPTX, TXT and Markdown; browser-shell parsing supports TXT and Markdown where the imported bytes are available.
- Parsed document context and user-edited intent are optional fields on a discovery plan and its persisted task snapshot. Existing plans and tasks without these fields remain valid. Evidence locators must resolve to parser-produced blocks/slides and evidence text must occur in its referenced source block.
- Source reading reuses the existing HTTPS/public-address SSRF guard, pinned DNS address, bounded timeout/body size and MIME checks. HTML is reduced to text without script execution; browser UI receives text and does not render remote HTML.
- `completed_queries` is the stable prefix length of original query rows processed, including failed rows. Cancelled/interrupted tasks continue rows at or after that prefix while keeping candidates, evidence and errors. Partial/failed tasks retry only failed rows. Query totals stay fixed; completed rows are not implicitly dispatched again.
- After a browser-shell reopen, an interrupted plan may rebind to the new in-process generation only when the project identity, lesson revisions, generated query rows and document evidence still match. Otherwise the task remains stale and requires a fresh plan.
- Reader position stays optional session metadata, not canonical course data. The native and browser session boundaries accept the current `readerState` fields (including v3.1 discovery state and the derived legacy-route notice) with enum, shape and size limits; malformed reader metadata falls back to defaults or no session and must not invalidate the project itself.

## Evidence and limits

The browser-shell recovery contract is covered by `tests/resource_discovery_workflow_test.ts`; document parsing, source safety and provider contracts are covered by the resource discovery/provider tests. Native unit tests cover stable query row indexes and reader-session schema validation. Tauri GUI acceptance is recorded separately under `docs/acceptance/v3.1.0/`; tests using injected providers are explicitly mocks and do not claim live web or video provider verification.
