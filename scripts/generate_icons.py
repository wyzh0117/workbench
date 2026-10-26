#!/usr/bin/env python3
"""Generate the Tauri icon set from the shared SVG using macOS system tools."""

from __future__ import annotations

import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "src-tauri" / "icons"
SOURCE = ICON_DIR / "workbench-brand.svg"
PNG_OUTPUTS = {
    32: "32x32.png",
    64: "64x64.png",
    128: "128x128.png",
    256: "128x128@2x.png",
    512: "icon.png",
}
RENDER_SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS_ENTRIES = (
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
)


def run(*args: str) -> None:
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as image:
        header = image.read(24)
    if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"Not a PNG image: {path}")
    return struct.unpack(">II", header[16:24])


def render_svg(destination: Path, size: int) -> None:
    run(
        "sips",
        "-s",
        "format",
        "png",
        "-z",
        str(size),
        str(size),
        str(SOURCE),
        "--out",
        str(destination),
    )
    if png_size(destination) != (size, size):
        raise ValueError(f"Expected {size}x{size} PNG from {SOURCE}, got {png_size(destination)}")


def write_ico(path: Path, images: list[tuple[int, Path]]) -> None:
    entries: list[bytes] = []
    payloads: list[bytes] = []
    offset = 6 + (16 * len(images))
    for size, image_path in images:
        payload = image_path.read_bytes()
        if png_size(image_path) != (size, size):
            raise ValueError(f"ICO image must be {size}x{size}: {image_path}")
        entries.append(
            struct.pack(
                "<BBBBHHII",
                0 if size == 256 else size,
                0 if size == 256 else size,
                0,
                0,
                1,
                32,
                len(payload),
                offset,
            )
        )
        payloads.append(payload)
        offset += len(payload)
    path.write_bytes(struct.pack("<HHH", 0, 1, len(images)) + b"".join(entries) + b"".join(payloads))


def main() -> int:
    if sys.platform != "darwin":
        print("Icon generation uses the built-in macOS sips and iconutil tools.", file=sys.stderr)
        return 2
    for tool in ("sips", "iconutil"):
        if shutil.which(tool) is None:
            print(f"Required macOS tool not found: {tool}", file=sys.stderr)
            return 2
    if not SOURCE.is_file():
        print(f"Missing SVG source: {SOURCE}", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix="workbench-icons-") as temp_name:
        temp = Path(temp_name)
        renders = temp / "renders"
        renders.mkdir()
        for size in RENDER_SIZES:
            render_svg(renders / f"{size}.png", size)

        iconset = temp / "workbench.iconset"
        iconset.mkdir()
        for filename, size in ICNS_ENTRIES:
            shutil.copyfile(renders / f"{size}.png", iconset / filename)
        icns = temp / "icon.icns"
        run("iconutil", "-c", "icns", str(iconset), "-o", str(icns))

        ico = temp / "icon.ico"
        write_ico(ico, [(size, renders / f"{size}.png") for size in ICO_SIZES])

        for size, filename in PNG_OUTPUTS.items():
            shutil.copyfile(renders / f"{size}.png", ICON_DIR / filename)
        shutil.copyfile(icns, ICON_DIR / "icon.icns")
        shutil.copyfile(ico, ICON_DIR / "icon.ico")

    print("Generated Tauri PNG, ICNS, and ICO assets from src-tauri/icons/workbench-brand.svg.")
    print("Preview sizes rendered and checked: " + ", ".join(f"{size}px" for size in RENDER_SIZES))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
