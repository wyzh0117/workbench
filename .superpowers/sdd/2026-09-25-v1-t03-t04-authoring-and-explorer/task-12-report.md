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


---

## Fix round (review Critical + Important)

### Fixes
1. **Critical — Native IPC:** flattened `folder_adopt(plan, duplicate_choice?, project_title?)` like `folder_scan` so UI `invoke({ plan })` works; no `{ input: … }` nest required.
2. **Important — Deno existing project.json:** `confirmFolderAdoption` refuses when `project.json` already exists (same message as native).
3. **Important — Native §35:** added checksum reuse, same-name different bytes, ignore/unselected tests.
4. **Important — Partial apply:** stage media under `.workspace/adopt-staging/`, promote only after Canonical write; cleanup staging on failure (never delete originals). UI failure toast no longer claims「原文件夹未改动」.

### Covering tests + commands + output

```bash
deno test --allow-read --allow-write tests/t04_adoption_test.ts tests/native_boundary_test.ts
```

```
running 8 tests from ./tests/t04_adoption_test.ts
… Deno adopt refuses when project.json already exists (matches native) ... ok
… (7 other adoption tests) ... ok
running 5 tests from ./tests/native_boundary_test.ts
… folder.adopt native IPC uses flat { plan } like folder.scan (no input nest) ... ok
ok | 13 passed | 0 failed
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml folder_adopt
```

```
running 5 tests
folder_adopt_rejects_unconfirmed_plan ... ok
folder_adopt_skips_ignore_and_unselected_entries ... ok
folder_adopt_writes_canonical_copies_assets_and_leaves_originals ... ok
folder_adopt_same_name_different_bytes_gets_distinct_asset_paths ... ok
folder_adopt_reuses_identical_checksum_and_keeps_original_bytes ... ok
ok | 5 passed
```

```bash
deno task check && deno task test
```

```
deno task check OK
ok | 324 passed | 0 failed
```
