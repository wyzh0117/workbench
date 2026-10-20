# UI-05 live editor evidence

Observed on 2026-10-21 in Chrome DevTools against the isolated Deno app at `http://127.0.0.1:4173/`, browser context `workbench-ui05-83712`, page 3. The fixture was `/private/tmp/workbench-v3-browser-fixture-20261020`; it contained one lesson and no user files. The operations used the visible editor controls and browser input, not direct mutation of app state.

1. Opened the fixture lesson, opened the paragraph’s More menu → Properties, and changed its type from `正文` to `标题`. The editor showed the same original paragraph text under the new heading block.
2. Inserted a second paragraph and typed `临时 UI05 顺序检查段落`. Dragged its visible `⠿` handle onto the first block. The rendered order labels changed from heading `01` / paragraph `02` to paragraph `01` / heading `02`; both texts remained with their original blocks.
3. Clicked Undo and Redo. Undo restored heading `01` / paragraph `02` and announced `已撤销：调整正文顺序`; Redo restored paragraph `01` / heading `02` and announced `已恢复：调整正文顺序`.
4. Inserted a blank paragraph, typed `# UI05 semantics`, and blurred the editor. The live editor converted the Markdown prefix into a heading block with content `UI05 semantics`. Undo returned that edit to a blank paragraph.
5. Undid the temporary edits. The app reported `✓ 已保存`; an on-disk read of the isolated `project.json` confirmed one content item and one original block (`51f3711d-47f2-4bc7-8f6a-418090e9d471`), type `paragraph`, with the exact original text `使用已选课程资料规划案例与教学视频。来源和证据需要经过审阅后再保存。`. The final restored file SHA-256 was `e6caf9c3a5f1d4d8474001e371d4d8c3c2ecd456ba1171aeddde0e3e21a37315`.

This covers the §14 UI-05 editor actions in the visible app path: block-type change, Markdown semantic conversion, real drag reorder, and Undo/Redo restoration. The intermediate order was observed in the live editor’s order labels; no intermediate service readback was captured. The final project-file readback confirms the temporary fixture was restored. This is browser UI evidence, not a packaged Native-window run. DevTools displayed an inline screenshot, but its screenshot file output rejected the available workspace paths, so no screenshot file is claimed.
