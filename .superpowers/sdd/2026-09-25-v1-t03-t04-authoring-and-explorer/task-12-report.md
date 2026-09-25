# Task 12 Report — In-place adoption apply + Source/Asset/Canonical + duplicates

## Strategy A (chosen)

**In-place adoption:** write `project.json` + `.workspace` into the **chosen folder**. Copy confirmed media into `assets/{id}-{filename}`. **Do not** move, rename, or delete original files.

**Why not Strategy B (managed sidecar project):** Ruling already selected A; A avoids a second root, keeps Canonical First colocated with the user’s materials, and does not invent bidirectional sync with a separate Source Root.

### Source / Asset / Canonical (§33)

| Role | Meaning | Apply behavior |
|---|---|---|
| **Source** | External reference, not yet lesson body | InboxItem `source_type: "source"` (+ text body or linked Asset) |
| **Reference** | DOCX/PDF default | InboxItem `source_type: "reference"` + document Asset copy |
| **Asset** | Managed media | Copy into `assets/`, `addAsset` / native asset row |
| **Canonical** | Stage / Lesson / Block | Written into `project.json` |

Duplicates (§35): same checksum → reuse existing Asset + Chinese warning; same name different bytes → new `assets/{id}-{filename}` (no silent overwrite). `selected + ignore` → ignore. Unconfirmed plans throw and write nothing.

---

## Status

DONE

## Commits

`feat(v1-t04): in-place folder adoption after confirm`

## Tests

`tests/t04_adoption_test.ts` registered in `deno.json` check+test:

1. Unconfirmed plan must not apply  
2. Strategy A writes `project.json` + `.workspace`; originals fingerprint unchanged  
3. Unselected / ignore not imported  
4. Checksum reuse + same-name different bytes no silent overwrite  
5. Markdown → Canonical blocks; docx/pdf → Source/Reference  
6. `folder.adopt` DesktopService command  
7. UI confirm →「写入课程项目」→ consume confirmed plan  

Native (`cargo test`): `folder_adopt_*`, `project_create_allows_strategy_a_in_nonempty_folder_without_moving_files`

**Gate:** `deno task check` OK · `deno task test` 322 passed · focused cargo adopt tests OK

## Concerns

- Deno `confirmFolderAdoption` and Rust `folder_adopt` both implement Strategy A; keep semantics aligned (same pattern as scan).  
- Adoption success toast is re-applied on microtask so soft AI side-file refresh failures do not clobber it.  
- Re-adopting a folder that already has `project.json` is rejected natively; Deno path uses `ProjectDirectoryStore` overwrite flags for first write only.

## Path

`/Users/youngi/Documents/MiniWork/workbench/.superpowers/sdd/2026-09-25-v1-t03-t04-authoring-and-explorer/task-12-report.md`
