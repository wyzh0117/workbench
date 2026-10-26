# v3.1.0 native GUI validation

Captured on 2026-10-26 using the debug Tauri application and CUA. The test project and Markdown fixture were isolated under temporary directories. No production credentials were read, displayed, or changed.

| Check | Result | Evidence |
|---|---|---|
| Import and parse a local course document | Pass | Imported a Markdown fixture through the native file picker. The discovery panel showed the fixture filename and `正文已解析`; with no model configured it retained the parsed state and showed the AI setup action. |
| Session payload shape and fresh-process recovery | Pass | The app-local `.workspace/session.json` contained active and root records for the isolated project, each with `resource_document.status=parsed`, an asset ID, an active lesson ID, and `right_tab=assistant`; no credential values were read. After setting the AI Assistant tab, the debug process exited and a new process was launched from the same bundle. Reopening `/private/tmp/workbench-v3.1.0-native-fresh` restored the AI Assistant tab; Discovery showed the fixture as `正文已解析`, the course showed `S01-01`, and the media library count was 1. |
| Complete debug process exit and relaunch | Pass | CUA sent Cmd+Q to the window owned by `/tmp/Workbench v3.1.0 Debug.app` (its executable symlinks to this worktree’s `src-tauri/target/debug/ai-course-workbench`). `ps` confirmed PID 77090 exited. After reopening the same bundle, PID 79751 was also confirmed exited after Cmd+Q; the next launch used PID 79835. The installed `AI Course Workbench` app process was left running and untouched. |
| Native right-side tabs | Pass | Clicked `浏览器`, `AI 助手`, then `发现素材`. The selected tab and panel content changed each time. Browser showed its empty-reader state; AI showed that no model connection was available; discovery returned to the parsed document state. |
| Public HTTPS source reading | Pass | Called the native `resource.source.read` command for `https://example.com/`. It returned title `Example Domain`, 156 text characters, and `content_read`. This proves only live public source reading, not model extraction or provider search. |
| Unsafe source URLs | Pass | Native source-read calls for `http://127.0.0.1/` and `https://127.0.0.1/` both returned `来源无法安全读取。` before any private destination was contacted. Rust unit coverage also checks the URL/IP guard, blocked redirects, response-size limits, and cancellation. |
| Narrow right-panel layout and keyboard exit | Pass in browser shell | At 360×320, the collapsed layout used 42px rails around a 276px center and had `scrollWidth === innerWidth`. The open drawer was 304px wide at x=56 with no horizontal overflow. Escape and the close button both collapsed it and returned focus to the right-rail control. The 1470, 1250, 1040, 680, and 679px viewport checks also passed. |

## Limits

- This was not the full document → live AI → external search → candidate read → favorite → canvas insertion workflow. No Brave or YouTube provider credentials were configured, and no mock result is counted as live evidence.
- The process-restart check used the native debug bundle and isolated fixture, not a signed or packaged release binary.
- The responsive viewport matrix ran in the local browser shell. Windows taskbar/installer presentation and native Windows system UI were not tested.
- macOS Dock/Finder/mission-control appearance and Windows taskbar behavior were not inspected. Generated format previews are recorded separately in [`icon-previews.md`](./icon-previews.md).
- These checks validate the native debug build used during the session. They do not validate a signed or packaged release binary.

The focused helper/contract tests are documented separately in [`backend/focused-validation.md`](./backend/focused-validation.md); they are not substitutes for the live checks above.
