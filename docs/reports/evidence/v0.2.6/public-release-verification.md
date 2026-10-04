# v0.2.6 public release verification

Verified 2026-10-04 UTC (2026-10-05 +0800) after the release workflow completed.

## Release and workflow

- Release: [v0.2.6](https://github.com/wyzh0117/workbench/releases/tag/v0.2.6), published 2026-10-04 20:31:39 UTC, `isDraft=false`, `isPrerelease=false`.
- `https://github.com/wyzh0117/workbench/releases/latest` resolved to `v0.2.6`.
- [Workflow run 37231984095](https://github.com/wyzh0117/workbench/actions/runs/37231984095) completed successfully for tag commit `223a5944e50ffdc6f4bdd09509eacf8f09c47b0e`. Universal build, asset staging, shipped-app signature-state check, and publication steps passed.

## Anonymous download and integrity

Unauthenticated `curl --fail --location` downloads of the public DMG and `.sha256` sidecar both returned HTTP 200. The DMG was 14,414,435 bytes; the sidecar was 96 bytes.

| Asset | GitHub SHA-256 | Download check |
| --- | --- | --- |
| `AI-Course-Workbench-macOS.dmg` | `08ecebe9ea20d848244c750598d2cf1e4f921e942532bd9126f395b1487cc27e` | Downloaded file hash and sidecar contents match |
| `AI-Course-Workbench-macOS.dmg.sha256` | `0577fc8af02e661cea7d3b831409c0d5f805efa56d9b16579e31d3b63123b8eb` | Downloaded sidecar file hash matches |

`hdiutil verify` reported the downloaded DMG checksum as VALID. A read-only mount succeeded; it was detached after inspection.

## Shipped app and signature facts

The mounted app reports bundle ID `io.github.wyzh0117.ai-course-workbench`, version/build `0.2.6`, and executable architectures `x86_64 arm64`.

The **public CI app** is ad-hoc signed: `codesign -dv --verbose=4` reports `Signature=adhoc` and `TeamIdentifier=not set`; `codesign --verify --deep --strict` reports the bundle valid on disk. The CI run had no Apple signing certificate, skipped the Developer ID build path, and its signature check reported `spctl` rejected the app. The published release body says the artifact is not Developer ID signed and not notarized. A local `spctl` check on the mounted copy returned an internal Code Signing subsystem error. `xcrun stapler validate` could not inspect the mounted app because Launch Services returned `LSDataUnavailable`; that response is recorded as a tool limitation, not as evidence of a ticket.

The **local smoke candidate** is a separate build with isolated identifier `io.github.wyzh0117.ai-course-workbench.smoke-20261005` and DMG SHA-256 `c4594037e0c9d4e908c9896e2aff9b39c55b23c883e19c0429fb73654d2e354f`. Its recorded state is unsigned and unnotarized. The local candidate hash/signature state must not be substituted for the public CI app facts above.

No app launch or native UI smoke was performed during this verification; only the public DMG was mounted read-only for metadata and binary inspection.

## Frozen prior release

The existing [v0.2.5 release](https://github.com/wyzh0117/workbench/releases/tag/v0.2.5) remains published with its original GitHub asset digests:

- DMG: `a84884466b084cd674a4d0d32a52b3284863a9adb9706c11283009fb14b7f9fd`
- `.sha256` sidecar: `b57141634353c61f4a49d0b0e32d0eacf5e027e7cee2410ca657cc47d8b70ce8`
