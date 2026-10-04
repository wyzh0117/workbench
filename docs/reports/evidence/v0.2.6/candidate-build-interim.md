# v0.2.6 interim candidate build

This is a pre-freeze diagnostic candidate. The final release candidate must be rebuilt from the frozen source tree after the Project Lock and Rename dialog fixes.

- Command: `cargo tauri build --target universal-apple-darwin --bundles app,dmg --config '{"identifier":"io.github.wyzh0117.ai-course-workbench.smoke-20261005"}' -- --jobs 2`
- Result: App and DMG bundling passed after retrying with elevated permission; the initial sandboxed run stopped in `bundle_dmg.sh`.
- App: `src-tauri/target/universal-apple-darwin/release/bundle/macos/AI Course Workbench.app`
- DMG: `src-tauri/target/universal-apple-darwin/release/bundle/dmg/AI Course Workbench_0.2.6_universal.dmg`
- Identifier: `io.github.wyzh0117.ai-course-workbench.smoke-20261005`
- Version: `0.2.6`
- Architecture: `x86_64 arm64` (`lipo -archs` on the bundled executable).
- SHA-256: `59885304ae685994ae078ee22478fac8bc372be44bf712b37c194c8dca55421c`
- DMG: `hdiutil verify` reported a valid checksum. A read-only mount showed `AI Course Workbench.app` at the volume root plus the `Applications` alias; mounted app metadata and architectures matched the standalone bundle. The image was detached after inspection.
- Signing: the app bundle has no Developer ID signature. The executable reports an ad-hoc linker signature with no TeamIdentifier; `codesign --verify --deep --strict` reports that the bundle is not signed. `spctl --assess` returned a Code Signing subsystem error in this local environment. Do not describe this local candidate as signed or notarized; verify the published workflow artifact separately.
- Native CUA launch: pending user unlock of the Mac. The QA agent has the exact App path and identifier and will run isolated smoke after access is available.
