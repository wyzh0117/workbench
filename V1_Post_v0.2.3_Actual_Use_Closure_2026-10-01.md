# AI Course Workbench — V1 Post-v0.2.3 Actual-Use Closure

> **Status at start**
>
> ```text
> V0 = CLOSED
> V1 = ACTIVE
> V1-T01 … V1-T06 = historical VERIFIED
> Latest public release = v0.2.3
> Current product state = PARTIAL
> Current work = V1 actual-use feedback closure
> ```
>
> This document does **not** create `V1-T07`, does not reopen historical T01–T06, and does not close V1.
> It is the next actual-use closure package after public release `v0.2.3`.
>
> Existing published tags/assets remain immutable. If this work is later released, use a **new** version/tag; never overwrite `v0.2.3`.

---

# 0. Sources and current-state note

The local Remote Desktop Commander device was unavailable when this task was prepared, so the latest public repository state was used to confirm the project position.

Confirmed current repository state:

```text
V1 ACTIVE
v0.2.3 published
v0.2.3 source/tag = 0ce229ac79b925164e3ea43eae4ac8059d5022e4
Deno latest recorded full suite = 389/389
Rust latest recorded full suite = 95/95
Distribution = PARTIAL
Developer ID / notarization = not completed
```

The existing v0.2.3 acceptance report already records that several items were only partially verified in isolated QA builds and that online ChatGPT subscription / Provider calls were not verified.

This round must use the **real user-observed behavior after v0.2.3** as the source of truth when it conflicts with a previous QA claim.

---

# 1. Overall goal

This round should be completed as **one development update**.

The goal is to close 15 actual-use issues without inventing another task tree:

```text
smart project/folder open
→ root-level mapping + selected-folder media discovery
→ distraction-free rich block editing
→ Markdown shortcut compilation and conservative block auto-conversion
→ pagination UI correction
→ DSH-style model configuration
→ real ChatGPT subscription / API online smoke
→ page-name / media / multi-select fixes
→ disk-synchronized rename
→ Grid pointer interaction repair
→ permanent feature-update manual
```

No interim user acceptance is required during implementation. The agent should implement, test, debug and repair within the original scope autonomously, then deliver one final candidate for user validation.

---

# 2. Classification of the 15 feedback items

| # | Classification | Required result |
|---:|---|---|
| 1 | Project open/import flow bug | Smart-detect project vs ordinary folder; valid `project.json` opens; ordinary folder enters import instead of generic rejection |
| 2 | Import behavior extension | Selecting a directory in mapping recursively imports image/video descendants as assets |
| 3 | UI requirement not delivered | Block chrome hidden by default; hover/focus reveals controls |
| 4 | Editor redesign | Remove B/I/S and Markdown-source UI; Markdown syntax compiles into rich display |
| 5 | Editor interaction clarification | “Invisible block” editing, overlay controls, no layout jump |
| 6 | Semantic auto-conversion | Pure Markdown structural content can convert block type conservatively |
| 7 | Pagination UI regression | Hide output-section UI until pagination is enabled; provide exit pagination editing |
| 8 | AI settings redesign | Rebuild model configuration using DSH information architecture, no preset provider templates |
| 9 | Online AI blocker | ChatGPT subscription login must list models and complete a real request; real API smoke allowed |
| 10 | UI bug | Remove duplicate page-title rendering |
| 11 | Media preview/UI bug | PNG thumbnail fixed; media cards redesigned with proper spacing |
| 12 | Import UX | Add multi-select asset import |
| 13 | Filesystem behavior change | Rename in Workbench must rename the local file and keep references consistent |
| 14 | Grid regression | Restore left/right click placement controls and fix underlying event architecture |
| 15 | Project-control requirement | Create and maintain a natural-language Feature Update Manual after every development/release |

---

# 3. Item 1 — Smart open: project folder vs ordinary folder

## 3.1 Problem

After v0.2.3, choosing either:

```text
/Users/youngi/Documents/MiniWork/AI学习课程
```

or a child folder such as:

```text
s01-00
```

can still produce the generic message:

```text
这个文件夹还不是 AI Course Workbench 项目。
没有找到有效的 project.json。
...
```

This is wrong in two different scenarios:

1. A folder without `project.json` is being used as a source folder and should enter import/adoption.
2. A folder *with* `project.json` should either open, migrate, or show the exact validation failure — not be treated as if no project exists.

---

## 3.2 Replace the binary entry logic with smart detection

When a user selects a folder from the normal project-opening flow:

### Case A — Valid current project

```text
valid project.json
→ open project directly
```

### Case B — Supported older schema

```text
project.json exists
→ run supported migration
→ validate
→ open
```

### Case C — project.json exists but remains invalid

Do **not** say “没有找到 project.json”.

Show the actual category:

```text
检测到 project.json，但项目数据无法通过校验。
```

Provide:

```text
查看具体问题
返回
作为普通资料文件夹重新导入（must not overwrite the existing file without confirmation)
```

The error detail must identify the first actionable schema / identity / reference failure.

### Case D — No project.json

Do not reject the folder.

Route directly to:

```text
existing-folder import
→ scan
→ mapping preview
```

The user should not need to understand the internal distinction between:

```text
“打开项目文件夹”
and
“导入已有文件夹”
```

before Workbench can help.

---

## 3.3 One selection entry, two outcomes

The preferred user mental model:

```text
选一个文件夹
↓
Workbench 判断
├─ 是项目 → 打开
└─ 不是项目 → 帮我导入
```

Internal service separation may remain, but the product should no longer make the user guess which internal pipeline to choose.

---

## 3.4 Regression matrix

Must test:

```text
valid v0.2.3 project
older supported project
project.json malformed JSON
project.json valid JSON but invalid Canonical
plain folder with files
plain folder with only subfolders
plain empty folder
folder containing s01-00 … s01-14
folder already adopted once
```

No generic “not a project” message may be used when a more specific diagnosis is available.

---

# 4. Item 2 — Directory mapping imports descendant visual media

## 4.1 Mapping UI stays root-level

Keep the anti-flood behavior:

> Mapping Preview only lists the selected directory’s immediate children.

Do not recursively dump every descendant file into the mapping table.

---

## 4.2 New rule for a selected directory row

If the user selects a **directory** in Mapping Preview, Workbench recursively inspects that selected directory *only for visual media*.

Eligible descendants:

```text
image/*
video/*
```

Initial required set:

```text
PNG
JPG / JPEG
WebP
GIF
MP4
other already-supported image/video MIME types
```

Explicitly excluded from this automatic descendant-media rule:

```text
Markdown
TXT
PDF
DOCX
other document/reference types
audio unless later explicitly approved
```

---

## 4.3 Asset behavior

Each eligible descendant:

```text
→ Asset candidate
→ checksum duplicate detection
→ copied/managed according to current project adoption rules
→ appears in Media Library
```

Do not automatically insert it into Lesson content.

Do not create `AssetUsage` merely because the folder was selected.

Media becomes available in the library; insertion remains a user action.

---

## 4.4 Safety

Recursive descendant-media scan must retain:

```text
symlink escape rejection
path traversal rejection
readability degradation per file
no source-file mutation
checksum deduplication
same-name/different-bytes collision safety
```

---

# 5. Items 3 + 5 — Distraction-free / “invisible block” editor

## 5.1 Product intent

The user should feel:

> “I am editing the lesson content.”

not:

> “I am editing inside many visible cards.”

Default content presentation should therefore hide block chrome.

---

## 5.2 Default state

When a block is neither hovered nor focused:

Hide:

```text
block type label
block sequence number
Markdown/source label
insert button
more (…) button
attribute/chrome row
visible card/tool framing that makes the block feel like a box
```

The content itself remains visible.

---

## 5.3 Hover / focus state

When the pointer enters the block area or the block receives focus:

Reveal a lightweight overlay containing only the relevant block controls, such as:

```text
drag handle
block type / attribute access
insert
more (…)
```

The overlay must be:

```text
positioned over the content layer
not part of normal document flow
not change block height
not push neighboring blocks
allowed to visually overlap adjacent chrome
```

This directly matches the yellow-box feedback in the supplied screenshot.

---

## 5.4 Focus behavior

Clicking editable text:

```text
selects the block
keeps the caret
does not rerender the editable node
does not interrupt IME
shows the block overlay
```

Moving the pointer away while the editor still has focus should not make controls impossible to reach.

Use `:focus-within` / explicit selected state in addition to hover.

---

## 5.5 Visual boundaries

Default:

```text
no heavy card border
no strong background container
no persistent “标题 37 / 正文 39” metadata strip
```

Selected/focused state may use a subtle left accent or very light background, but should not restore a “boxed form” appearance.

---

# 6. Item 4 — Remove B / I / S / Markdown-source UI; Markdown shortcuts compile automatically

## 6.1 Remove the UI shown in the red boxes

Completely remove from each editable block:

```text
B
I
S
Markdown
源码
Markdown source toggle
```

This includes both red-box areas shown in the screenshot.

Do not hide them behind `...`; remove this editing concept from the block UI.

---

## 6.2 User-facing editing model

The editor becomes a semantic rich-text surface with Markdown shortcuts.

Example:

```text
user types: **你好**
```

After the syntax becomes complete:

```text
你好
```

is displayed bold.

The user should not need to switch to a source view.

---

## 6.3 Canonical storage

Keep one authoritative source.

Recommended implementation boundary:

```text
semantic editor DOM / AST
↕ deterministic serializer
Canonical Markdown-compatible source
```

or an equivalent structured inline representation that preserves current project compatibility.

Do not create:

```text
rendered HTML as a second source of truth
```

Do not save arbitrary contenteditable HTML directly into Canonical.

---

## 6.4 Supported first-class Markdown semantics

At minimum:

```text
bold
italic
strikethrough
inline code
heading
quote
ordered list
unordered list
link
horizontal rule
fenced code
```

Existing safe Markdown parsing and local-image resolution rules must remain.

Raw HTML stays escaped / unsupported unless explicitly safe-listed later.

---

## 6.5 Editing behavior

Compilation must be composition-safe.

Do not transform during an active IME composition.

A completed Markdown token may be compiled:

```text
after closing syntax
or
after a short stable edit boundary
```

without moving the caret unexpectedly.

Undo should treat one auto-format action as one coherent history operation.

---

# 7. Item 6 — Conservative automatic block-type conversion

## 7.1 Eligible source blocks

Apply to input-capable blocks except:

```text
divider
media
placeholder
```

---

## 7.2 Conversion principle

Only convert block type when the **entire meaningful block content** parses into one unambiguous structural semantic unit.

No mixed-content conversion.

---

## 7.3 Required examples

### Pure inline code

Input:

```text
`print("Hello")`
```

and nothing else.

Result:

```text
block type → code
display → print("Hello")
```

### Mixed inline code + normal text

Input:

```text
`print("Hello")`你好
```

Result:

```text
keep original block type
render inline code styling inside it
do not convert the whole block
```

### Heading

Input:

```text
## 标题
```

and no other semantic content:

```text
block type → heading
level → H2
```

### Quote

Input:

```text
> 一段引用
```

only:

```text
block type → quote
```

### List

A complete list-only block may convert to the existing list-type block if the Domain already has a compatible type.

### Divider

If a normal editable block contains only a recognized divider syntax and current Domain conversion can be lossless:

```text
---
```

it may convert to divider.

---

## 7.4 No heuristic guessing

Do not convert because text merely *looks like* code.

Conversion must be based on the Markdown semantic parse.

Must not convert during partial typing such as:

```text
`
**
>
#
```

until syntax is complete.

---

# 8. Item 7 — Pagination UI correction

## 8.1 Current user expectation

Before pagination is enabled:

```text
do not show “输出分区” editor
```

After:

```text
启用分页
```

then show pagination-related page / output grouping controls.

---

## 8.2 Exit pagination editing

Provide a clearly visible:

```text
退出分页编辑
```

action.

This means:

```text
leave pagination editing mode
```

not:

```text
delete pages
flatten layout
erase page identity
```

All page data, placement and export semantics remain.

Re-entering pagination editing restores the same page.

---

## 8.3 Release-build verification

This requirement was previously marked passed in QA snapshots but was not observed by the user in v0.2.3.

Therefore acceptance must be performed in a build equivalent to the final distributable, not only an isolated QA shell.

---

# 9. Item 8 — Rebuild Model Settings using DSH’s model-provider UX

## 9.1 Important interpretation

“照抄 DSH” here means:

> adopt DSH’s information architecture, field semantics, interaction order and error posture.

Do not copy DeepSeek Harness branding assets or ship its provider catalog by default.

---

## 9.2 Remove Workbench preset provider templates

Do not show default cards such as:

```text
Volcengine / Doubao
OpenAI preset
Anthropic preset
DeepSeek preset
other pre-created provider templates
```

The page should show only:

```text
user-created API connections
saved subscription accounts
```

---

## 9.3 Settings → Models structure

Use a DSH-style Models page.

### Existing model providers

List configured connections.

Each connection shows:

```text
display name
provider id
base URL
protocol
credential configured / not configured
configured models
default model
edit
delete
```

Never display the literal secret.

---

## 9.4 Add model provider

Primary action:

```text
+ Add model provider
```

Form fields:

```text
Provider ID
Display name
Base URL
API protocol
API key
Model catalog
```

API protocol choices:

```text
OpenAI Chat Completions
OpenAI Responses
Anthropic Messages
```

Provider ID is stable/permanent after creation.

Display name remains editable.

---

## 9.5 Model discovery

Provide:

```text
Fetch available models
```

Use the unsaved form’s current:

```text
base URL
protocol
credential
```

or the saved connection’s protected credential.

Model discovery is a convenience, not a prerequisite.

If discovery fails:

```text
manual Model ID entry remains available
```

Nothing from discovery is persisted until Save.

---

## 9.6 Model catalog picker

Discovery result:

```text
search
multi-select models
add selected
```

Then the saved connection owns only the models the user chose.

---

## 9.7 AI Assistant separation

AI Assistant must not contain model configuration UI.

### No usable model

Show only:

```text
配置 AI
```

which opens Settings → Models.

### Usable model exists

AI Assistant shows only:

```text
account / connection selector
model selector
scope
context preview
instruction
run/cancel
Suggestion / Diff / Apply workflow
```

No Base URL field, API-key field, provider editing or model-management card inside the assistant.

---

## 9.8 Subscription login stays

Keep subscription login as a separate group in Settings → Models / Accounts.

It does not become an API-template card.

---

# 10. Item 9 — ChatGPT subscription login: real model discovery and inference

## 10.1 Problem

User login succeeds, but:

```text
models cannot be loaded
requests cannot complete
```

This must no longer be treated as “login succeeded, therefore integration works.”

---

## 10.2 Validate granted capability after login

After ChatGPT sign-in, inspect the returned granted scopes.

A verified identity alone is not enough.

The connection must explicitly have the ChatGPT plan-usage permission required for inference.

If missing, show a clear state:

```text
ChatGPT 已登录，但没有授权套餐用量。
请重新授权并允许 ChatGPT plan usage。
```

Do not show an empty model picker with no explanation.

---

## 10.3 Model list request

Using the selected account’s access token:

```text
GET https://api.openai.com/v1/models
Authorization: Bearer <access token>
```

Read the account-specific model list returned for plan usage.

Only show models the server marks as listable / available.

Use the server model slug for inference.

Refresh the model list when switching ChatGPT accounts.

---

## 10.4 Real inference

After model discovery:

```text
selected account
→ selected model
→ Responses API
→ streamed/nonempty completed result
```

must succeed in a real online smoke test.

Do not stop at “models loaded”.

---

## 10.5 Token refresh

Implement and verify:

```text
access token expiry
→ refresh with saved issued client_id + latest refresh_token
→ atomically replace token set
→ retry model list / inference
```

Serialize refreshes for the same account to prevent refresh-token races.

---

## 10.6 Authorized online testing

For this development round, the user explicitly authorizes:

```text
one or more minimal real API smoke tests
one minimal ChatGPT subscription smoke
```

Rules:

```text
never print or log API keys / access tokens / refresh tokens
never put credentials in screenshots, project.json, diagnostics or feature history
use the smallest practical request
prefer Luna Low if it is returned by the account’s live model catalog
if Luna Low is not returned, choose a low-cost / low-effort model that is actually returned
do not hard-code Luna Low as an entitlement
```

The agent may use a low-cost subagent/model during implementation testing when available.

---

## 10.7 Online acceptance

Must record separately:

```text
login
granted plan-usage scope
model list nonempty
selected model
one completed response
token refresh result (if safely testable)
```

Do not conflate API-key and subscription-provider tests.

---

# 11. Item 10 — Remove duplicate page titles

In Workbench → Layout and Preview, paged Grid currently shows the page name twice:

```text
large “第n页”
small “第n页”
```

One page identity is enough.

Keep:

```text
one primary page title
```

Secondary UI may show only non-duplicate metadata:

```text
page dimensions
page index / count
zoom
layout name
```

No second copy of the same page title.

Add a UI regression test for exactly one visible page-title instance per active page surface.

---

# 12. Item 11 — PNG thumbnail repair + Media Library visual redesign

## 12.1 PNG is a regression

MP4 and GIF thumbnail behavior improved in v0.2.3, but PNG still appears blank.

Treat supported static images as a separate pipeline from first-frame video/GIF logic.

Required:

```text
PNG → actual thumbnail
JPG/JPEG → actual thumbnail
WebP → actual thumbnail where supported
GIF → static first-frame thumbnail
MP4 → static first-frame thumbnail
```

Do not send PNG through video-frame extraction.

---

## 12.2 Diagnose the actual failure

Check:

```text
asset bytes
MIME
blob URL lifecycle
lazy-loading observer
object URL revocation timing
image decode
CSP / Tauri asset boundary
transparent-image background
thumbnail element sizing
```

Do not “fix” blank PNG with a generic placeholder unless actual decode fails.

---

## 12.3 Media card redesign

The current card gives too much space to text/actions and too little usable visual space.

New card structure:

```text
┌───────────────────────────┐
│                           │
│       thumbnail           │
│       / first frame       │
│                           │
├───────────────────────────┤
│ file/display name         │
│ type · size · usage       │
│ [插入] [重命名] [删除]    │
└───────────────────────────┘
```

Use a consistent thumbnail aspect ratio and neutral background.

Suggested:

```text
aspect-ratio: 4 / 3
object-fit: contain
```

or another coherent design chosen by the UI system.

Cards must have:

```text
real whitespace
consistent gap
clear title hierarchy
actions on one row where width allows
responsive wrap only when necessary
```

---

## 12.4 Detail behavior

Keep previously requested behavior:

```text
image click → enlarge
GIF click → enlarged playback starts
video click → enlarge paused with center Play button
closing GIF/video → return to static first-frame thumbnail
```

---

# 13. Item 12 — Multi-select Add Assets

Native:

```text
+ 添加素材
```

must allow multiple file selection.

A multi-file selection is processed as one import batch.

Requirements:

```text
each file validated independently
checksum duplicate handling
same-name collision handling
one bad file does not silently cancel all successful files
clear batch result
```

Prefer one undoable batch operation when Domain/history semantics allow it.

The existing drop zone should also continue accepting multiple files.

---

# 14. Item 13 — Rename must rename the local file

This intentionally changes the previous “display-name only” behavior.

---

## 14.1 Managed Media Library assets

Renaming an asset must:

```text
rename the physical managed file on disk
update canonical filename / relative managed path
keep asset id stable
keep AssetUsage references stable
keep checksum/content identity
update UI and preview
```

Do not duplicate the file under a new name and leave the old copy behind.

---

## 14.2 Source files in Files page

Renaming a Markdown or other source file in the Files page must rename that source file on disk.

Update any Workbench-maintained source record / relative path that points to it.

---

## 14.3 Safety rules

By default:

```text
rename basename only
preserve file extension
```

If extension editing is later allowed, re-run MIME/type validation.

Must reject:

```text
path separators
..
empty name
collision with existing file
symlink target escape
unauthorized root
```

---

## 14.4 Transaction behavior

Rename must be atomic from the user’s perspective:

```text
preflight
→ filesystem rename
→ Canonical/source-reference update
→ save
```

If Canonical update fails after filesystem rename, roll the file rename back.

If rollback itself fails:

```text
surface BLOCKING error with exact original/new paths
do not claim success
```

---

## 14.5 Undo / Redo

If the operation enters Workbench history:

```text
Undo → physical rename back + metadata restore
Redo → physical rename forward + metadata restore
```

Handle name collisions safely.

---

# 15. Item 14 — Restore Grid left/right click behavior at the root

## 15.1 Required behavior

For placed Grid blocks:

```text
left click → select / enter move-to-cell state
click target cell → move
right click → remove from Grid / defined context action
```

For unplaced blocks:

```text
left click → place into first valid cell
```

---

## 15.2 Do not patch individual buttons only

The regression may come from:

```text
new invisible-block overlays
pointer-events
event delegation
selection handlers
stopPropagation
contextmenu suppression
rerender replacing listeners
```

Audit the full pointer/event chain.

---

## 15.3 Stable interaction architecture

Prefer:

```text
one delegated pointer/click/contextmenu handler per stable surface
data-action / data-placement identity
overlay controls that intentionally define pointer-events
```

Avoid attaching fragile per-node listeners that disappear after rerender.

---

## 15.4 Regression tests

Must cover:

```text
unplaced → left-click place
placed → left-click move mode
cell → commit move
placed → right-click remove
Escape → cancel move
rerender → interactions still work
hover overlay visible → underlying intended action still works
pagination page switch → interactions still work
save / restart → placement persists
```

At least one real Tauri pointer-based smoke is required.

---

# 16. Item 15 — Create a permanent Feature Update Manual

## 16.1 New folder

Create:

```text
docs/feature-history/
```

Files:

```text
docs/feature-history/README.md
docs/feature-history/UNRELEASED.md
docs/feature-history/v0.1.0.md
docs/feature-history/v0.1.1.md
docs/feature-history/v0.1.2.md
docs/feature-history/v0.2.1.md
docs/feature-history/v0.2.2.md
docs/feature-history/v0.2.3.md
...
```

Do not create a file for a tag that never became a public user release unless the index explicitly labels it “unreleased/failed tag”.

---

## 16.2 Purpose

This is not a commit log.

It is a natural-language product history for humans.

Each released-version file should answer:

```text
这个版本用户能做什么新事情？
哪些操作方式发生了变化？
哪些旧问题被修复？
有没有兼容性或迁移变化？
还有哪些已知限制？
```

Avoid internal test-count dumps unless they materially help explain the release.

---

## 16.3 UNRELEASED workflow

At the end of every development session that changes product behavior:

```text
update UNRELEASED.md
```

When a public release is created:

```text
freeze relevant UNRELEASED content
→ docs/feature-history/vX.Y.Z.md
→ reset UNRELEASED.md for the next cycle
```

---

## 16.4 Backfill history

During this round, backfill the already-published versions from:

```text
Release Notes
PROJECT_MASTER_CONTROL
completion reports
Git history
```

Do not invent capabilities not supported by those records.

---

## 16.5 Master Control rule

Add a permanent rule to `PROJECT_MASTER_CONTROL.md`:

> Every development completion that changes user-visible product behavior must update `docs/feature-history/UNRELEASED.md`. Every public release must archive that release’s natural-language changes to `docs/feature-history/vX.Y.Z.md` and update the index. A task is not considered fully handed off until the Feature Update Manual has been updated.

Also add the Feature Update Manual to the mandatory end-of-task checklist alongside:

```text
Completion Report
README
PROJECT_MASTER_CONTROL
```

---

# 17. Unified import behavior after this round

The product should now have one understandable folder mental model.

## User selects a folder

```text
Workbench detects project state
```

### Existing valid project

```text
Open
```

### Existing migratable project

```text
Migrate → Open
```

### Invalid project.json

```text
Explain exact problem
→ no generic false message
```

### Ordinary folder

```text
Import
→ root-level Mapping Preview
→ user selects files/folders
→ selected folders recursively contribute image/video assets
→ Confirm
→ project.json written
→ project opens
```

### Existing project later needs more files

```text
Project Overview → Add files/folder
→ import into existing project
→ preserve project identity/history/pages/usages
```

---

# 18. Unified rich-content behavior after this round

User-facing model:

```text
type content naturally
use Markdown shortcuts when convenient
see formatted semantics immediately
never switch to “Markdown source”
```

Examples:

```text
**bold**              → bold text
*italic*              → italic text
~~strike~~            → struck text
`code` + other text   → inline code, original block type retained
`only code`           → auto-convert whole block to Code
## only heading       → Heading H2
> only quote          → Quote
```

No persistent toolbar row.

No persistent block metadata strip.

Block tools appear only when needed.

---

# 19. AI acceptance architecture

## API providers

DSH-style custom provider flow:

```text
Provider ID
Display name
Base URL
Protocol
Write-only API key
Fetch models
Select models
Manual model ID fallback
Save
```

No preset provider templates.

---

## ChatGPT subscription

```text
Continue with ChatGPT
→ validate identity
→ validate plan-usage scope
→ save account profile/token set
→ list available account models
→ select returned model
→ Responses API inference
→ refresh token when required
```

If any stage fails, UI must tell the user which stage failed.

Examples:

```text
已登录，但未授权 ChatGPT plan usage
模型列表请求失败
当前账户没有可用模型
token 已失效且刷新失败
模型可选，但推理请求失败
```

Never collapse all failures into “AI 配置失败”.

---

# 20. Required verification

## 20.1 Automated full gates

At final source state:

```text
deno task check
deno task test
cargo fmt --check
cargo test
cargo build
```

If producing a candidate DMG:

```text
Universal build
hdiutil verify
```

---

## 20.2 Import / project smoke

Test with:

```text
AI学习课程/
  s01-00/
  ...
  s01-14/
```

and at least one child with valid `project.json`.

Verify:

```text
root ordinary folder routes to import
valid project opens
invalid project gives precise error
selected root child folders import visual descendants
documents are not silently swept in as media
confirm creates project and opens it
```

---

## 20.3 Editor smoke

Verify:

```text
no B/I/S/Markdown-source UI
default block chrome invisible
hover/focus overlay
no layout jump
**你好** becomes bold
pure inline-code block converts to code
mixed inline code + text does not convert
heading/quote conversion
Undo/Redo for formatting and conversion
IME not interrupted
```

---

## 20.4 Pagination smoke

Verify in final-like Tauri build:

```text
pagination off → no output-section editor
enable → relevant page/output controls appear
exit pagination editing → page data preserved
re-enter → same active page and placements
only one page title displayed
```

---

## 20.5 Media smoke

At minimum:

```text
PNG
JPG/JPEG
WebP if supported
GIF
MP4
```

Verify:

```text
thumbnail visible without opening modal
GIF/video first frame
GIF enlarged playback
video enlarged paused + center play
close → returns to first frame
actions/layout responsive
multi-select import
```

---

## 20.6 File rename smoke

Verify real filesystem names before/after:

```text
media asset rename
Markdown source rename
Undo
Redo
collision
invalid filename
```

---

## 20.7 Grid smoke

Use real pointer events in Tauri where practical:

```text
left place
left move
target cell
right remove
Escape cancel
rerender
page switch
save/restart
```

---

## 20.8 Online AI smoke

The user authorizes minimal real testing.

### ChatGPT subscription

Verify:

```text
login
plan-usage scope
model list
model selection
one completed response
```

Prefer Luna Low if returned by the live model catalog; otherwise use a low-cost model actually returned by the server.

### API

Use one configured test API connection where the user has provided/authorized credentials:

```text
model discovery or manual model
one minimal inference
```

Never record credentials in logs, screenshots, docs or feature history.

---

# 21. Acceptance standard

This round is not complete because:

```text
a test says a handler exists
```

It is complete when user-observable behavior matches the specification.

Historical QA claims do not override current real-user reproduction.

If the released v0.2.3 behavior differs from an old QA snapshot:

```text
treat the real release behavior as the regression to fix
```

---

# 22. Release boundary

`v0.2.3` is already public and frozen.

Do not:

```text
move v0.2.3 tag
replace v0.2.3 DMG
overwrite v0.2.3 SHA sidecar
```

This document does **not** itself authorize a new release.

If the user later asks to publish this closure, create a new version/tag (for example `v0.2.4` if that is still the next valid release number).

---

# 23. Master Control writeback after completion

Append a new actual-use closure section without changing historical T01–T06 VERIFIED records.

Record:

```text
source commit
candidate/release version if any
all 15 items: completed / partial / blocked
full automated gates
real Tauri evidence
online AI evidence
remaining explicit limitations
Feature Update Manual paths updated
```

Update:

```text
Current Position
Current Handoff
Current Status
NEXT ACTION
Change Log
Feature Update Manual rule
```

Do not create `V1-T07`.

Do not close V1 automatically.

---

# 24. Completion report — required 15-item matrix

Final report must contain:

| # | User feedback | Implementation | Automated evidence | Real UI evidence | Status |
|---:|---|---|---|---|---|
| 1 | Smart folder/project open | … | … | … | PASS/PARTIAL/BLOCKED |
| 2 | Folder descendant visual media | … | … | … | … |
| 3 | Invisible block chrome | … | … | … | … |
| 4 | Remove source toolbar + Markdown compile | … | … | … | … |
| 5 | Overlay properties | … | … | … | … |
| 6 | Auto block conversion | … | … | … | … |
| 7 | Pagination controls | … | … | … | … |
| 8 | DSH-style model settings | … | … | … | … |
| 9 | Real ChatGPT/API usage | … | … | … | … |
| 10 | Duplicate page title | … | … | … | … |
| 11 | PNG/media UI | … | … | … | … |
| 12 | Multi-select assets | … | … | … | … |
| 13 | Disk rename | … | … | … | … |
| 14 | Grid left/right click | … | … | … | … |
| 15 | Feature Update Manual | … | … | … | … |

Do not summarize 15 items into “mostly done”.

---

# 25. Definition of Done

```text
[ ] Smart open routes valid project / invalid project / ordinary folder correctly
[ ] Existing valid project.json no longer triggers false “no project.json”
[ ] Mapping Preview stays root-level
[ ] Selected directory recursively contributes image/video descendants as assets
[ ] Block chrome hidden by default
[ ] Hover/focus overlay does not reflow layout
[ ] B/I/S/Markdown-source UI removed
[ ] Markdown shortcuts compile to rich semantics
[ ] Conservative block auto-conversion works and is undoable
[ ] Pagination controls obey enabled/editing state
[ ] Duplicate page title removed
[ ] Model settings rebuilt with DSH-style provider workflow
[ ] No preset provider templates
[ ] ChatGPT subscription model discovery works online
[ ] At least one real ChatGPT plan inference succeeds, or exact external blocker is evidenced
[ ] At least one authorized real API inference succeeds, or exact external blocker is evidenced
[ ] PNG thumbnail works
[ ] Media Library card layout redesigned
[ ] Multi-select Add Assets works
[ ] Rename changes the physical file and updates references safely
[ ] Grid left/right click behavior restored with root-cause regression protection
[ ] Full automated gates green
[ ] Final-like Tauri smoke completed for core interactions
[ ] docs/feature-history/ created and historical released versions backfilled
[ ] UNRELEASED.md updated
[ ] PROJECT_MASTER_CONTROL.md includes permanent Feature Update Manual rule
[ ] README / Master Control accurately distinguish current public release and current source state
[ ] No historical release tag/asset overwritten
```

---

# 26. NEXT ACTION

```text
Implement this post-v0.2.3 actual-use closure as one update.
Do not create V1-T07.
Do not publish a new release unless separately authorized.
After implementation, deliver one candidate build + one 15-item completion matrix for user validation.
```

---

# 27. External implementation references

Use current official documentation during implementation:

- DeepSeek Harness — Configure models: mirror its provider/custom API/model-discovery information architecture while omitting preset provider templates.
- OpenAI — Sign in with ChatGPT for open-source/local apps: verify granted plan-usage scope, account-specific model listing, Responses API inference, multi-account separation and refresh-token handling.

Do not infer online subscription capability solely from a successful browser login.

---

# 28. User-requested interruption handoff (2026-10-01)

Work stopped immediately at the user's direction. The last observed account usage
snapshot was 90% used; a later lookup failed, so exact quota at interruption is
unknown. This closure is **INTERRUPTED / PARTIAL**, not complete. Keep V1 ACTIVE;
do not create V1-T07. No source or test files were changed, no tests/builds or
online AI calls were run, and no commit, tag or Release was made. `v0.2.3` remains
the latest public frozen release. Although the user authorized publishing a new
version after completion, that authorized release was not performed; on resume,
use a new version/tag (expected `v0.2.4` after checking the current remote state).

The worktree is still on `main`. The release-audit agent modified only
`README.md` and `PROJECT_MASTER_CONTROL.md`; its only check was `git diff --check`
on those files. The UI agent made no changes and ran no checks. The scope agent
created the Completion Report and made no source/test changes. No process remains
running. The current untracked request/history inputs and `docs/superpowers/`
must be preserved. `UNRELEASED.md` and the Feature Update Manual have not been
created; no `docs/feature-history/` backfill was done.

Confirmed context for items 8–9: unsaved-form model discovery already follows
`aiDiscoverModels → ai.models.probe → probeAiModels / ai_models_probe_at`; do not
rewrite it based on the earlier mistaken assumption. Remaining model-settings
gaps and live online capability still need verification.

| # | Item | Status at interruption |
|---:|---|---|
| 1 | Smart project/folder open | NOT IMPLEMENTED / NOT VERIFIED; picker/error code only inspected. |
| 2 | Selected-folder image/video discovery | NOT IMPLEMENTED / NOT VERIFIED; no scanner or mapping changes. |
| 3 | Hide block chrome | NOT IMPLEMENTED / NOT VERIFIED; UI agent survey only. |
| 4 | Markdown rich editing and remove B/I/S/source UI | NOT IMPLEMENTED / NOT VERIFIED; UI agent survey only. |
| 5 | Overlay block properties | NOT IMPLEMENTED / NOT VERIFIED. |
| 6 | Undoable structural Markdown conversion | NOT IMPLEMENTED / NOT VERIFIED; root cause not established. |
| 7 | Pagination UI state | NOT IMPLEMENTED / NOT VERIFIED; UI agent survey only. |
| 8 | DSH-style model settings | NOT IMPLEMENTED / NOT VERIFIED; no code changes. |
| 9 | Live ChatGPT/API smoke | NOT IMPLEMENTED / NOT VERIFIED; no online request. |
| 10 | Duplicate page title | NOT IMPLEMENTED / NOT VERIFIED; UI agent survey only. |
| 11 | PNG/media cards | NOT IMPLEMENTED / NOT VERIFIED; PNG cause unresolved. |
| 12 | Multi-select Add Assets | NOT IMPLEMENTED / NOT VERIFIED; single-file picker path inspected. |
| 13 | Physical rename and reference sync | NOT IMPLEMENTED / NOT VERIFIED; inspected asset rename changes display title only; source-file path not inspected. |
| 14 | Grid left/right-click behavior | NOT IMPLEMENTED / NOT VERIFIED; UI agent survey only, no pointer smoke. |
| 15 | Feature Update Manual | NOT IMPLEMENTED / NOT VERIFIED; no manual or history backfill. |

Read in this order before resuming: `AGENTS.md` → this request →
`PROJECT_MASTER_CONTROL.md` §41 →
[`docs/V1_Post_v0.2.3_Actual_Use_Closure_2026-10-01_Completion_Report.md`](docs/V1_Post_v0.2.3_Actual_Use_Closure_2026-10-01_Completion_Report.md)
→ `README.md` → the 2026-09-30 feedback/acceptance report and other relevant
documents. Then inspect `git status` and assign all 15 items. Do not represent
historical v0.2.3 test results as evidence for this closure. The completion
report is the live item-by-item status and next-step record.
