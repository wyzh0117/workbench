# v0.2.6 frozen-tree candidate

Built from the source-frozen tree after the persisted save-status update in `adoptProjectSnapshot()` and the Free Layout `pageGrid` import fix. This candidate passed package validation and is ready for final review; it has not been published.

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
- Signing: no Developer ID signature is present. The executable reports an ad-hoc linker signature and no TeamIdentifier; `codesign --verify --deep --strict` reports that the app bundle is not signed. `spctl --assess --type execute -vv` returned a Code Signing subsystem error. Record this candidate as unsigned and unnotarized; the public workflow artifact must be checked separately.
- Native CUA smoke: BLOCKED by the locked Mac; no native app launch or interaction was attempted. The browser/native UI evidence and limitation are recorded in the QA report.

The earlier pre-freeze and pre-Free-Layout-fix candidate hashes remain in their respective historical evidence entries; this file records the current frozen-tree candidate.
