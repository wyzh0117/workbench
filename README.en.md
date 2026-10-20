<div align="center">
  <h1>AI Course Workbench</h1>
  <p>Plan courses, organize materials, and turn unfinished notes into exportable lessons on your own computer.</p>
</div>

[简体中文](README.md) · [Latest release](https://github.com/wyzh0117/workbench/releases/latest)

## About

AI Course Workbench is a local-first course authoring tool. Course content lives in a `project.json` file on your computer, so you can keep editing and back it up yourself.

## Quick start

Download the Windows or macOS installer from the [latest release page](https://github.com/wyzh0117/workbench/releases/latest), open the app, then create or open a course project.

To build from source, install Deno 2.x, Rust, and the build tools for your platform:

```bash
deno task check
deno task test
cargo test --manifest-path src-tauri/Cargo.toml
cargo tauri build
```

## How it works

Create course stages and lessons, then edit lesson content, arrange materials, and track what still needs work. Search indexes and previews can be rebuilt; the project file keeps the course content. The AI assistant suggests edits for you to review one at a time before applying them.

## What you can do

- Plan and reorder course stages and lessons.
- Edit lesson notes and page layouts, then preview them.
- Organize images, video, PDF, DOCX, EPUB, LaTeX, and Markdown files.
- Find teaching cases and videos from selected course materials, review their sources, then save or cite them explicitly.
- Extract an editable style from an existing PowerPoint and export a supplemental slide as a single-slide file or an appended copy.
- Track missing content and course completion.
- Review AI suggestions and export Markdown, HTML, PDF, PPTX, or a full project package.

## Example

For a photography course, outline the stages and lessons, add notes and sample images, mark missing practice exercises, then preview and export the course materials.

## License

The repository does not currently include a LICENSE file, so usage, modification, and redistribution terms have not been declared.
