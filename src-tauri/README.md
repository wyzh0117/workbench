# Tauri boundary

`app/` is the dependency-free Web UI used by the review server and as the
Tauri `frontendDist`. In a native build, `src-tauri/src/lib.rs` is the only
place that receives filesystem requests. The renderer can call high-level
commands for an explicitly selected project directory, atomic canonical JSON
writes, recovery journals, snapshots, import preview/confirmation, export,
and publication records. It never receives arbitrary `fs`, shell, Git, or
credential handles.

This workspace does not include a Rust toolchain or downloaded Cargo cache,
so native compilation is not claimed here. The UI fallback remains runnable
with `deno task ui`.

`capabilities/default.json` grants only the core Tauri capability. The
renderer sees named high-level project, import/export/publication, and
browser-bridge commands; raw filesystem, shell, and Git primitives are not
exposed. JSON, Markdown, and HTML exports are written only after a preflight
and only to an explicitly selected output directory. Secret commands return an
explicit `unsupported` error until an OS keychain adapter is installed; no
secret material is ever written as plain text.

Project commands require an absolute directory selected by the user. The
native layer rejects symlinked project/output paths, keeps recovery and
snapshots beside the project under `.workspace`, writes `project.json` via a
temporary file plus rename, and creates a restore-before-backup before a
snapshot restore. Bridge requests must include the in-memory pairing token,
an HTTP(S) loopback or `tauri://localhost` origin, and one of the two
allow-listed actions.
