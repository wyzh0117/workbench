/**
 * V1-T04 Task 9 — import-folder entry + read-only folder scan.
 *
 * Spec: package §§26, 29, 38. Scan must not write project.json or mutate user files.
 */
import { join } from "node:path";
import { DesktopService } from "../src/service/desktop.ts";
import { scanFolder, type ScanResult } from "../src/service/folder_scan.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function fingerprintTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      const rel = path.slice(root.length).replace(/^[\\/]/, "").replaceAll("\\", "/");
      if (entry.isSymlink) {
        out.set(rel, `symlink:${await Deno.readLink(path)}`);
        continue;
      }
      if (entry.isDirectory) {
        out.set(rel, "dir");
        await walk(path);
        continue;
      }
      if (entry.isFile) {
        const bytes = await Deno.readFile(path);
        const stat = await Deno.lstat(path);
        out.set(rel, `file:${stat.size}:${Array.from(bytes).join(",")}`);
      }
    }
  }
  await walk(root);
  return out;
}

function byRelative(entries: ScanResult[]): Map<string, ScanResult> {
  return new Map(entries.map((entry) => [entry.relative_path.replaceAll("\\", "/"), entry]));
}

Deno.test("launcher exposes three distinct project-entry actions including 导入已有文件夹", async () => {
  const views = await Deno.readTextFile(new URL("../app/views.js", import.meta.url));
  const main = await Deno.readTextFile(new URL("../app/main.js", import.meta.url));
  const launcher = views.slice(
    views.indexOf("function launcherView"),
    views.indexOf("const launcher ="),
  );
  assert(launcher.includes("新建课程"), "launcher must keep 新建课程");
  assert(
    /打开项目文件夹|打开现有项目/.test(launcher),
    "launcher must keep open-project path",
  );
  assert(
    launcher.includes("导入已有文件夹") &&
      launcher.includes('data-action="import-folder"'),
    "launcher must expose a distinct 导入已有文件夹 action",
  );
  assert(
    launcher.includes('data-action="new-project"') &&
      /open-project-dir|open-file/.test(launcher) &&
      launcher.includes('data-action="import-folder"'),
    "the three entry actions must remain distinct data-actions",
  );
  assert(
    main.includes('case "import-folder"') &&
      /importExistingFolderFromPicker|importExistingFolder/.test(main),
    "main must wire import-folder to a dedicated handler",
  );
  assert(
    !/case "import-folder":[\s\S]{0,200}newProjectFromPicker/.test(main),
    "import-folder must not collapse into new-project",
  );
  assert(
    !/case "import-folder":[\s\S]{0,200}openProjectFromPicker/.test(main),
    "import-folder must not collapse into open-project",
  );
});

Deno.test("scanFolder walks nested folders and tags roles without writing project.json", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-scan-" });
  try {
    await Deno.mkdir(join(root, "01-基础"), { recursive: true });
    await Deno.mkdir(join(root, "02-进阶"), { recursive: true });
    await Deno.writeTextFile(join(root, "01-基础", "导论.md"), "# 导论\n");
    await Deno.writeTextFile(join(root, "01-基础", "大纲.docx"), "docx");
    await Deno.writeFile(join(root, "01-基础", "intro.png"), new Uint8Array([1, 2, 3]));
    await Deno.writeTextFile(join(root, "02-进阶", "第二课.md"), "## 二\n");
    await Deno.writeFile(join(root, "02-进阶", "demo.mp4"), new Uint8Array([4, 5]));
    await Deno.writeFile(join(root, "总体说明.pdf"), new Uint8Array([6]));
    await Deno.writeTextFile(join(root, "notes.txt"), "txt");
    await Deno.writeTextFile(join(root, "weird.bin"), "bin");

    const before = await fingerprintTree(root);
    const report = await scanFolder(root);
    const after = await fingerprintTree(root);

    assert(report.root === root, "report must record the scanned root");
    assert(
      !(await Deno.stat(join(root, "project.json")).then(() => true).catch(() => false)),
      "scan must not create project.json",
    );
    assert(
      JSON.stringify([...before.entries()].sort()) ===
        JSON.stringify([...after.entries()].sort()),
      "scan must not mutate user files",
    );

    const map = byRelative(report.entries);
    assert(map.get("01-基础")?.kind === "directory", "nested folder must appear");
    assert(map.get("01-基础")?.suggested_role === "stage", "top-level folder → stage suggestion");
    assert(map.get("01-基础/导论.md")?.suggested_role === "lesson", "markdown → lesson");
    assert(map.get("01-基础/导论.md")?.mime === "text/markdown", "markdown mime");
    assert(map.get("notes.txt")?.suggested_role === "lesson", "txt → lesson");
    assert(map.get("01-基础/intro.png")?.suggested_role === "asset", "image → asset");
    assert(map.get("02-进阶/demo.mp4")?.suggested_role === "asset", "video → asset");
    assert(map.get("01-基础/大纲.docx")?.suggested_role === "reference", "docx → reference");
    assert(map.get("总体说明.pdf")?.suggested_role === "reference", "pdf → reference");
    assert(
      map.get("weird.bin")?.suggested_role === "unsupported",
      "unknown type must be tagged unsupported, not crash",
    );
    assert(
      typeof map.get("01-基础/导论.md")?.size === "number" &&
        (map.get("01-基础/导论.md")?.size ?? 0) > 0,
      "file size must be present",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scanFolder isolates unreadable entries without failing the tree", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-unreadable-" });
  const locked = join(root, "locked");
  try {
    await Deno.writeTextFile(join(root, "ok.md"), "# ok\n");
    await Deno.mkdir(locked);
    await Deno.writeTextFile(join(locked, "secret.md"), "secret");
    await Deno.chmod(locked, 0o000);

    const report = await scanFolder(root);
    const map = byRelative(report.entries);
    assert(map.has("ok.md"), "readable sibling must still be scanned");
    assert(
      map.get("ok.md")?.suggested_role === "lesson",
      "readable file keeps its suggested role",
    );
    const lockedEntry = map.get("locked");
    assert(lockedEntry, "unreadable directory must still appear as a degraded entry");
    assert(
      Boolean(lockedEntry.error) || lockedEntry.suggested_role === "unsupported",
      "unreadable entry must be degraded, not throw",
    );
    assert(
      !map.has("locked/secret.md"),
      "contents under an unreadable directory must not be required",
    );
  } finally {
    try {
      await Deno.chmod(locked, 0o700);
    } catch { /* best-effort restore for cleanup */ }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scanFolder degrades an unreadable single file without failing siblings (§40)", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-unreadable-file-" });
  const lockedFile = join(root, "locked.md");
  try {
    await Deno.writeTextFile(join(root, "ok.md"), "# ok\n");
    await Deno.writeTextFile(lockedFile, "secret");
    await Deno.chmod(lockedFile, 0o000);

    const report = await scanFolder(root);
    const map = byRelative(report.entries);
    assert(map.has("ok.md"), "readable sibling must still be scanned");
    assert(map.get("ok.md")?.suggested_role === "lesson", "readable file keeps role");
    const lockedEntry = map.get("locked.md");
    assert(lockedEntry, "unreadable file must still appear as a degraded entry");
    assert(
      Boolean(lockedEntry.error) && lockedEntry.suggested_role === "unsupported",
      "unreadable file must be degraded, not throw",
    );
    assert(
      !(await Deno.stat(join(root, "project.json")).then(() => true).catch(() => false)),
      "unreadable-file scan must not create project.json",
    );
  } finally {
    try {
      await Deno.chmod(lockedFile, 0o600);
    } catch { /* best-effort restore for cleanup */ }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CourseFolder fixture (§41) scans as nested stages with md/png/mp4/docx/pdf roles", async () => {
  const fixture = new URL("./fixtures/CourseFolder", import.meta.url);
  const root = Deno.build.os === "windows"
    ? decodeURIComponent(fixture.pathname.replace(/^\//, ""))
    : decodeURIComponent(fixture.pathname);
  const before = await fingerprintTree(root);
  const report = await scanFolder(root);
  const after = await fingerprintTree(root);
  assert(
    JSON.stringify([...before.entries()].sort()) ===
      JSON.stringify([...after.entries()].sort()),
    "fixture scan must be read-only",
  );
  const map = byRelative(report.entries);
  assert(map.get("01-基础")?.suggested_role === "stage", "01-基础 → stage");
  assert(map.get("02-进阶")?.suggested_role === "stage", "02-进阶 → stage");
  assert(map.get("01-基础/导论.md")?.suggested_role === "lesson", "导论.md → lesson");
  assert(map.get("01-基础/intro.png")?.suggested_role === "asset", "intro.png → asset");
  assert(map.get("02-进阶/demo.mp4")?.suggested_role === "asset", "demo.mp4 → asset");
  assert(map.get("01-基础/大纲.docx")?.suggested_role === "reference", "大纲.docx → reference");
  assert(map.get("总体说明.pdf")?.suggested_role === "reference", "总体说明.pdf → reference");
  assert(map.get("02-进阶/第二课.md")?.suggested_role === "lesson", "第二课.md → lesson");
  assert(
    !(await Deno.stat(join(root, "project.json")).then(() => true).catch(() => false)),
    "fixture must remain without project.json after scan",
  );
});

Deno.test("folder.scan command is read-only and does not require an open project", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-cmd-" });
  const serviceRoot = await Deno.makeTempDir({ prefix: "acw-t04-svc-" });
  try {
    await Deno.mkdir(join(root, "单元"), { recursive: true });
    await Deno.writeTextFile(join(root, "单元", "a.md"), "# a\n");
    const before = await fingerprintTree(root);
    const desktop = new DesktopService(serviceRoot, { read_only: true });
    try {
      assert(desktop.context.project === null, "scan must work with no open project");
      const executed = await desktop.commands.execute("folder.scan", { path: root });
      const report = executed.value as {
        root: string;
        entries: ScanResult[];
      };
      assert(report.root === root, "command must return scanned root");
      assert(
        report.entries.some((entry) =>
          entry.relative_path.replaceAll("\\", "/") === "单元/a.md"
        ),
        "command must return nested scan entries",
      );
      assert(
        !(await Deno.stat(join(root, "project.json")).then(() => true).catch(() => false)),
        "folder.scan must not write project.json into the user folder",
      );
      assert(
        !(await Deno.stat(join(serviceRoot, "project.json")).then(() => true).catch(() => false)),
        "folder.scan must not create a project in the service directory either",
      );
    } finally {
      await desktop.close();
    }
    const after = await fingerprintTree(root);
    assert(
      JSON.stringify([...before.entries()].sort()) ===
        JSON.stringify([...after.entries()].sort()),
      "folder.scan command must not mutate user files",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(serviceRoot, { recursive: true });
  }
});

Deno.test("scanFolder rejects symlink escape and skips symlink children", async () => {
  const root = await Deno.makeTempDir({ prefix: "acw-t04-symlink-root-" });
  const outside = await Deno.makeTempDir({ prefix: "acw-t04-symlink-out-" });
  try {
    await Deno.writeTextFile(join(outside, "escape.md"), "escaped");
    await Deno.writeTextFile(join(root, "safe.md"), "safe");
    await Deno.symlink(outside, join(root, "link-out"));
    await Deno.symlink(root, join(root, "loop"));

    const report = await scanFolder(root);
    const rels = report.entries.map((entry) => entry.relative_path.replaceAll("\\", "/"));
    assert(rels.includes("safe.md"), "real file inside root must be scanned");
    assert(!rels.some((rel) => rel.includes("escape.md")), "symlink escape must not pull outside files");
    assert(!rels.includes("link-out"), "symlink children must be skipped, not followed");
    assert(!rels.includes("loop"), "circular symlink must be skipped");

    let rejected = false;
    try {
      await scanFolder(join(root, "link-out"));
    } catch {
      rejected = true;
    }
    assert(rejected, "scanning a symlink root must be rejected");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});
