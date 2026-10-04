# v0.2.6 frozen-tree local pre-release build

Built from the source-frozen tree after the persisted save-status update in `adoptProjectSnapshot()` and the Free Layout `pageGrid` import fix. This local pre-release build passed package validation. Its hash identifies the local QA artifact and does not identify the published DMG; public asset verification is recorded separately in [public-release-verification.md](./public-release-verification.md).

- Command: `cargo tauri build --target universal-apple-darwin --bundles app,dmg --config '{"identifier":"io.github.wyzh0117.ai-course-workbench.smoke-20261005"}' -- --jobs 2`
- Result: App and DMG bundles completed successfully.
- App: `/Users/youngi/Documents/MiniWork/workbench/src-tauri/target/universal-apple-darwin/release/bundle/macos/AI Course Workbench.app`
- DMG: `/Users/youngi/Documents/MiniWork/workbench/src-tauri/target/universal-apple-darwin/release/bundle/dmg/AI Course Workbench_0.2.6_universal.dmg`
- Bundle identifier: `io.github.wyzh0117.ai-course-workbench.smoke-20261005`
- Version and build: `0.2.6`
- Verification time: `2026-10-05 04:09` Asia/Shanghai.
- Architectures: `x86_64 arm64` (`lipo -archs` on the bundled executable).
- SHA-256: `c4594037e0c9d4e908c9896e2aff9b39c55b23c883e19c0429fb73654d2e354f`
- DMG integrity: `hdiutil verify` reported `checksum ... is VALID`. A read-only mount contained `AI Course Workbench.app` at the volume root and an `Applications` alias. The mounted App had the same identifier, version, and architectures. The mount was detached after inspection.
- Local-candidate signing only: no Developer ID signature is present. The executable reports an ad-hoc linker signature and no TeamIdentifier; `codesign --verify --deep --strict` reports that this local app bundle is not signed. `spctl --assess --type execute -vv` returned a Code Signing subsystem error. This local result does not describe the public app; its verified signing state is in [public-release-verification.md](./public-release-verification.md).
- Native CUA smoke: BLOCKED by the locked Mac; no native app launch or interaction was attempted. The browser/native UI evidence and limitation are recorded in the QA report.

The earlier pre-freeze and pre-Free-Layout-fix hashes remain in their respective historical evidence entries; this file records the final frozen-tree local pre-release build.
