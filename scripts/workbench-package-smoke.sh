#!/usr/bin/env bash
# Validate the bytes inside the staged macOS DMG. This is not a visual UI test.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 DMG [TAURI_CONFIG] [EVIDENCE_DIRECTORY]" >&2
  exit 2
fi
if [ "$(uname -s)" != Darwin ]; then
  echo "macOS package validation requires a macOS runner." >&2
  exit 2
fi
dmg="$1"
config="${2:-src-tauri/tauri.conf.json}"
evidence="${3:-.qa-output/macos-package}"
mkdir -p "$evidence"

# Verify the staged sidecar against the exact DMG that will be uploaded.
python3 - "$dmg" <<'PY'
import hashlib, pathlib, re, sys
path = pathlib.Path(sys.argv[1])
sidecar = pathlib.Path(str(path) + ".sha256").read_text().strip()
match = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?(.+)", sidecar)
if not match or match.group(2) != path.name:
    raise SystemExit("Invalid DMG checksum sidecar")
with path.open("rb") as stream:
    hasher = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        hasher.update(chunk)
    digest = hasher.hexdigest()
if digest != match.group(1).lower():
    raise SystemExit("DMG checksum does not match staged bytes")
PY
hdiutil verify "$dmg" > "$evidence/dmg-verification.log" 2>&1

# Read only, no Finder windows; always detach the exact mounts returned by hdiutil.
cleanup() {
  status=$?
  trap - EXIT
  if [ -s "$evidence/attach.plist" ]; then
    while IFS= read -r mount; do
      if [ -n "$mount" ]; then
        if ! hdiutil detach "$mount" >> "$evidence/dmg-detach.log" 2>&1; then
          echo "Could not detach validation mount: $mount" >&2
          status=1
        fi
      fi
    done < <(python3 - "$evidence/attach.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], "rb") as stream:
    for item in plistlib.load(stream).get("system-entities", []):
        if item.get("mount-point"):
            print(item["mount-point"])
PY
)
  fi
  exit "$status"
}
trap cleanup EXIT
hdiutil attach -readonly -nobrowse -noautoopen -plist "$dmg" > "$evidence/attach.plist"

python3 - "$config" "$evidence/attach.plist" "$evidence/payload.json" <<'PY'
import json, os, pathlib, plistlib, sys
config = json.loads(pathlib.Path(sys.argv[1]).read_text())
with open(sys.argv[2], "rb") as stream:
    mounts = [pathlib.Path(x["mount-point"]) for x in plistlib.load(stream).get("system-entities", []) if x.get("mount-point")]
apps = [app for mount in mounts for app in mount.glob("*.app")]
if len(apps) != 1 or apps[0].name != config["productName"] + ".app":
    raise SystemExit("DMG must contain exactly the expected application bundle")
app = apps[0]
with (app / "Contents/Info.plist").open("rb") as stream:
    info = plistlib.load(stream)
if info.get("CFBundleShortVersionString") != config["version"]:
    raise SystemExit("Mounted app version does not match Tauri config")
if info.get("CFBundleIdentifier") != config["identifier"]:
    raise SystemExit("Mounted app identifier does not match Tauri config")
name = info.get("CFBundleExecutable", "")
if not name or pathlib.Path(name).name != name or name in (".", ".."):
    raise SystemExit("Invalid app executable name")
executable = app / "Contents/MacOS" / name
if not executable.is_file() or not executable.resolve().is_relative_to(app.resolve()) or not os.access(executable, os.X_OK):
    raise SystemExit("Missing or unsafe mounted app executable")
pathlib.Path(sys.argv[3]).write_text(json.dumps({"app": str(app), "executable": str(executable), "version": config["version"], "identifier": config["identifier"]}))
PY
app="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["app"])' "$evidence/payload.json")"
executable="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["executable"])' "$evidence/payload.json")"
lipo -archs "$executable" > "$evidence/architectures.txt"
python3 - "$evidence/architectures.txt" <<'PY'
import pathlib, sys
if set(pathlib.Path(sys.argv[1]).read_text().split()) != {"arm64", "x86_64"}:
    raise SystemExit("Mounted app is not the required arm64 + x86_64 Universal binary")
PY
codesign --verify --deep --strict "$app" > "$evidence/codesign-verification.log" 2>&1
codesign -dv --verbose=4 "$app" > "$evidence/codesign-details.log" 2>&1
# A Developer ID signature alone is not proof of notarization. Fail the signed
# release path unless the mounted shipped app has a ticket and passes Gatekeeper.
if grep -q 'Authority=Developer ID Application:' "$evidence/codesign-details.log"; then
  xcrun stapler validate "$app" > "$evidence/notarization.log" 2>&1
  spctl --assess --type execute --verbose "$app" > "$evidence/gatekeeper.log" 2>&1
fi

python3 - "$evidence" "$dmg" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
report = json.loads((root / "payload.json").read_text())
report["developer_id_signed"] = "Authority=Developer ID Application:" in (root / "codesign-details.log").read_text()
report["notarization_verified"] = report["developer_id_signed"] and (root / "notarization.log").is_file() and (root / "gatekeeper.log").is_file()
report.update({"package": pathlib.Path(sys.argv[2]).name, "architectures": sorted((root / "architectures.txt").read_text().split()), "checksum_verified": True, "dmg_verified": True, "signature_verified": True, "visual_ui_verified": False, "native_launch_verified": False})
(root / "macos-package.json").write_text(json.dumps(report, indent=2) + "\n")
print("macOS DMG checksum, mounted metadata, Universal architectures and signature verified; native launch and visual UI were not tested.")
PY
