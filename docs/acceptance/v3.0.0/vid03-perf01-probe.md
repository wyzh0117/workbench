# VID-03 / PERF-01 bounded runtime probe

This probe used an isolated browser service and disposable project under `/private/tmp`; it did not use the user’s project or change product source. It supplements the 3.0.0 acceptance matrix with the behavior observed in this one run. It does not establish native-shell, Office, live-provider, or full-scale performance behavior.

## VID-03: video preview lifecycle

The real two-frame fixture `tests/fixtures/media-preview/two-frame.mp4` was served from the disposable project. Its SHA-256 is `6ad4eea38f72c3bbad9c64b43cc9252101d8c785b2449275294d52dcc5005562`; `ffprobe` identified H.264, 64×48, 2 seconds. The browser app opened the production media-preview route and decoded the fixture (`readyState=4`, no media error).

In `node /private/tmp/workbench-vid03-perf01-0263/vid03-midplay.js`, a trusted browser click started playback. A `playing` event was followed by `timeupdate`; the close action ran at `currentTime=0.275697` while the video was still playing, well before its 2-second end. After close, the retained video node was disconnected, paused, reset to `currentTime=0`, had `src=null` and `readyState=0`, and a GET to its former media-token path returned 404. Reopening the viewer in the earlier `node /private/tmp/workbench-vid03-perf01-0263/resume-vid03.js` run produced a different token. This verifies active-playback close, token invalidation, and a fresh token on reopen in the browser service path.

The probe did not switch the open project while the preview was active, and it did not validate the native/Tauri video surface. Those behaviors remain unobserved here.

## PERF-01: disposable 121-file project

The setup script `/private/tmp/workbench-vid03-perf01-0263/setup.ts` created a temporary project at `/private/tmp/workbench-vid03-perf01-0263/project` using the existing `DesktopService` path. It imported 120 generated 16×16 PNGs and the video fixture: 121 stored assets totaling 11,514 bytes. The initial canonical `project.json` was 95,898 bytes. The measured run used `PROJECT_ROOT=/private/tmp/workbench-vid03-perf01-0263/project PORT=4174 deno run -A scripts/dev_server.ts`, an isolated headless Chrome profile at `/private/tmp/workbench-vid03-perf01-0263/chrome-profile`, CDP port 9223, and `node /private/tmp/workbench-vid03-perf01-0263/perf01.js`. The ordinary development server on port 4173 was left running and untouched.

In the production editor, the 121-row media list had a 7,512-pixel scroll height and a 131-pixel viewport. Twenty scroll steps reached twenty distinct positions from top to bottom in 333.8 ms. A `MutationObserver` on `#app` observed zero added or removed nodes in the app subtree during scrolling, including zero list-child changes. Reported JS heap was 4,446,579 bytes before scrolling and 4,469,618 bytes after; after editing it was 6,784,924 bytes. The heap readings were not taken after forced garbage collection and should be treated as snapshots, not a memory-growth result.

The editor then received 21 trusted `Input.insertText` character events over 738 ms. The editor stayed connected and focused; the visible editor text contained the marker `PERF01-EDIT-20261021`, and the UI showed `✓ 已保存` after the 1.2-second post-input observation. A fresh `project.open_state` request returned HTTP 200 and the canonical block content with Markdown-escaped hyphens. The canonical file grew from 96,704 bytes (SHA-256 `050bfaf454e7efd5514cd38276edc59e830798d7599337b8179369d6a28de117`) before editing to 96,729 bytes afterward (SHA-256 `7fa1f5bb5a6f914f11cae17df77696415e3f1768db3594a48fc7319415bfb469`). The 21 input-to-next-animation-frame readings had 0.5 ms minimum, 4.8 ms median, and 17 ms maximum.

An explicitly injected offline mock resource search had completed earlier in setup: one candidate, one request, 7.3 ms, with a four-request budget. That result was created before the lesson changed. The later public `resource.discovery.get` call returned the persisted task as `stale` after the lesson was edited, so this probe does not claim a fresh task completed after editing or any live-provider result. There were no provider credentials or real network-search observations in this run.

The sample project is small and uses tiny generated images; this does not establish performance for a representative large user project, a full media-heavy lesson, or repeated task returns. PERF-01 remains partial on this evidence.

The scroll, heap, and input timing values above were transcribed from the bounded runner's captured stdout; there is no separate raw JSON measurement file. During fixture setup, one recoverable `course.seed.create` call used invalid `source_type: "text"`; setup then explicitly created the valid lesson used for the measurements. That setup typo is excluded from the measured flow and is not a product failure.
