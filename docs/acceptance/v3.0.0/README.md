# v3.0.0 UI evidence

Evidence was captured on 2026-10-21 from the isolated browser project at `127.0.0.1:4173` using Chrome DevTools. The project contained one lesson and no user files. Screenshots show only that fixture.

## UI-08 responsive course table

- [1280 × 900 three-column layout](ui08-1280-layout.png)
- [1024 × 900 keyboard-scroll and focused row](ui08-1024-keyboard-scroll.png)

At 1024 px, the course table region measured x=229–731 px with `scrollLeft` maximum 135 px. After four ArrowRight key presses, the last-column delete button measured x=697–729 px, fully within the table region. The 1280 px view shows the course title, status, missing-material, and material columns without vertical text wrapping. The 1440 px no-scroll view was also checked in the isolated browser; its original screenshot remains in the task visualization folder.

## UI-09 motion and text scaling

- [1280 × 900 reduced-motion view](ui09-reduced-motion-1280.png)

Chrome DevTools emulated `prefers-reduced-motion: reduce`; `matchMedia` returned true, button transition duration computed to `0.00001s`, and `scroll-behavior` computed to `auto`.

Text scaling remains **unverified**. In a separate isolated Chrome session, `Emulation.setEmulatedOSTextScale` accepted scale values 1.5 and 2.0, but computed font sizes and text bounds did not change. For example, the project-title button remained 13 px and 214 × 29.59 px at both values. No 150% or 200% text-scale pass is claimed.

## PERF-01 bounded browser sample

This is exploratory browser-side evidence, not a PERF-01 pass. The normal isolated fixture had zero assets and no discovery task. For a bounded list sample, 500 synthetic document cards were appended to the in-memory store only; no canonical project write or network request was made.

At 1280 × 900 in Chrome 155, with normal CPU and no network throttling:

| Measurement | Result |
| --- | ---: |
| 500-card list render, from `store.notify()` through two animation frames | 243.8 ms |
| List height / viewport / maximum scroll | 31,010 / 538 / 30,472 px |
| 21-position scroll sample | 331.5 ms |
| Full `#app` root replacements during scrolling | 0 |
| Inbox → editor route transition | 99.1 / 99.9 ms |
| JS heap used before / after list build / after route return | 3.06 / 3.24 / 4.89 MiB |
| JS heap total before / after list build / after route return | 3.74 / 5.05 / 6.91 MiB |

Heap values came from `performance.memory` and were not forced through garbage collection; they are JS-heap samples, not process memory. The route test had no real returned discovery task, so task-return behavior remains unverified.

Continuous editing was measured on the fixture's real lesson paragraph using Chrome DevTools keyboard input. Appending the 20-character string ` [PERF-EDIT-000001]!` produced 20 input events. Input-to-next-animation-frame latency ranged from 0.7 to 18.2 ms (median 5.8 ms), and the editor remained focused after all 20 events. One root replacement was observed across the edit and blur/commit. Autosave changed from “正在保存…” to “已保存” in 418 ms; `project.json` contained the edited body. Reload restored the edited text. The paragraph was then restored through the editor, autosaved, and reloaded; the original body was present and the temporary suffix was absent. The fixture again had zero assets. No actual search task was available, so PERF-01 remains partial.

A separate cold browser trace at 1280 × 900 reported LCP 616 ms (TTFB 6 ms, render delay 610 ms) and CLS 0. This load trace is supplemental and does not measure the PERF-01 interaction scenario.

## Automated checks

- `deno task check` — passed after the resource-discovery workflow test gained its legacy-migration case.
- `deno test --allow-read --allow-write --allow-env=TMPDIR tests/resource_discovery_workflow_test.ts` — 2 passed, 0 failed.
- `deno task test` — 726 passed, 0 failed in the prior approved-loopback full run. That run predates the addition of the entire `tests/resource_discovery_workflow_test.ts` file, so it does not include either of its two tests; both passed separately above.
- [`authoring_ui_test.ts`](../../../tests/authoring_ui_test.ts) focused checks — “PowerPoint export renders durability warnings as escaped alerts” passed 1/1, and “resource recovery warnings from project and task state remain visible” passed 1/1. Their inclusion in the 726-test full-run snapshot was not recorded, so they are listed separately.
