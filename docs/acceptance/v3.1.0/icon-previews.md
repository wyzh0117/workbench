# v3.1.0 app icon previews

The SVG master is [`src-tauri/icons/workbench-brand.svg`](../../../src-tauri/icons/workbench-brand.svg). Its four white rounded squares use the geometry from `workbench-3.1.0-sketch.html` (`viewBox="0 0 24 24"`, 7×7 squares, radius 1.5, positions `(3,3)`, `(14,3)`, `(3,14)`, `(14,14)`) and the existing brand token `--primary: #14725f`.

Each image links to its full-size PNG. The eight requested sizes were rendered directly from the SVG with macOS `sips`; dimensions were checked from each PNG header. `python3 scripts/generate_icons.py` also regenerates the Tauri PNG, ICNS, and ICO assets using the built-in `sips` and `iconutil` tools.

| Size | Preview |
| ---: | :--- |
| 16×16 | [![16×16](icons/16.png)](icons/16.png) |
| 24×24 | [![24×24](icons/24.png)](icons/24.png) |
| 32×32 | [![32×32](icons/32.png)](icons/32.png) |
| 48×48 | [![48×48](icons/48.png)](icons/48.png) |
| 128×128 | [![128×128](icons/128.png)](icons/128.png) |
| 256×256 | [![256×256](icons/256.png)](icons/256.png) |
| 512×512 | [![512×512](icons/512.png)](icons/512.png) |
| 1024×1024 | [![1024×1024](icons/1024.png)](icons/1024.png) |

The PNG, ICO, and ICNS outputs were structurally inspected. Native Dock/Finder and Windows taskbar/installer rendering, and packaged macOS/Windows builds, remain unverified until desktop and release acceptance.
