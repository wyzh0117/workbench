function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const lib = await Deno.readTextFile(
  new URL("../src-tauri/src/lib.rs", import.meta.url),
);
const cargo = await Deno.readTextFile(
  new URL("../src-tauri/Cargo.toml", import.meta.url),
);
const app = await Deno.readTextFile(
  new URL("../app/main.js", import.meta.url),
);
const capability = JSON.parse(
  await Deno.readTextFile(
    new URL("../src-tauri/capabilities/default.json", import.meta.url),
  ),
);

Deno.test("native shell exposes explicit project and high-level workflows", () => {
  for (
    const command of [
      "project_open",
      "project_create",
      "project_save",
      "project_external_status",
      "project_reload",
      "project_merge",
      "project_resolve",
      "project_close",
      "confirm_close",
      "create_snapshot",
      "list_snapshots",
      "restore_snapshot",
      "import_preview",
      "import_confirm",
      "asset_import",
      "select_file",
      "select_folder",
      "select_export_path",
      "export_preflight",
      "export_run",
      "publication_record",
      "clear_recovery_journal",
    ]
  ) {
    assert(
      lib.includes(`fn ${command}`),
      `${command} must have a native implementation`,
    );
  }
  assert(
    lib.includes("atomic_write_path"),
    "canonical writes must use the atomic writer",
  );
  assert(
    lib.includes("PROJECT_BASELINES") &&
      lib.includes("ensure_no_external_modification") &&
      lib.includes("external_modification_conflict") &&
      lib.includes("project_fingerprint") &&
      lib.includes("merge_json_values"),
    "native writes must compare a content fingerprint and reuse the diff/merge conflict path",
  );
  assert(
    lib.includes("PROJECT_LOCK_RELATIVE_PATH") &&
      lib.includes("PROJECT_LOCK_GUARD_RELATIVE_PATH") &&
      lib.includes("PROJECT_LOCK_STALE_MS") &&
      lib.includes("PROJECT_LOCK_HEARTBEAT_MS") &&
      lib.includes("release_all_project_locks") &&
      lib.includes("ExitRequested") &&
      lib.includes("WindowEvent::CloseRequested") &&
      lib.includes("prevent_close") &&
      lib.includes("EXIT_READY") &&
      lib.includes("CLOSE_REQUEST_EVENT") &&
      lib.includes("tauri://close-requested"),
    "native project writes must share one guarded lease and flush before exit release",
  );
  assert(
    lib.includes("atomic_write_bytes_path") &&
      lib.includes("sha256_hex") &&
      lib.includes("asset_usages") &&
      lib.includes("bytes_base64"),
    "native asset import must preserve raw bytes, checksum and usage metadata",
  );
  assert(
    lib.includes('"files": [{') &&
      lib.includes('"__bytes_base64"') &&
      lib.includes('"target_path": output_path'),
    "native export must return stable file bytes and an explicit target path",
  );
  assert(
    lib.includes("fn export_run(preset: Value, options: Option<Value>)") &&
      lib.includes("fn export_preflight(preset: Value, options: Option<Value>)") &&
      lib.includes("export_content_item_id") &&
      lib.includes("content_item_not_found") &&
      lib.includes(
        "fn markdown_for_project(project: &Value, content_item_id: Option<&str>)",
      ) &&
      lib.includes(
        "fn html_for_project(project: &Value, content_item_id: Option<&str>)",
      ),
    "native export must carry options content_item_id through preflight and semantic renderers",
  );
  assert(
    lib.includes("fn rfc3339_now()") &&
      lib.includes("fn touch_project_updated_at") &&
      lib.includes("fn write_project_value_with_warning") &&
      lib.includes('"warning": warning') &&
      !lib.includes("let _ = clear_recovery_journal_path(project_dir)"),
    "native asset writes must advance canonical revision and surface recovery cleanup warnings",
  );
  assert(
    lib.includes('picker_result(kind, "cancelled"') &&
      lib.includes('"status": "unsupported"'),
    "native picker cancellation and unavailable capability must be explicit",
  );
  assert(
    lib.includes("tauri_plugin_dialog::DialogExt") &&
      lib.includes("blocking_pick_file") &&
      lib.includes("blocking_pick_folder") &&
      lib.includes("blocking_save_file") &&
      lib.includes(".plugin(tauri_plugin_dialog::init())"),
    "desktop picker commands must use the Tauri dialog plugin",
  );
  assert(
    cargo.includes('tauri-plugin-dialog = "2"'),
    "native shell must pin the Tauri dialog plugin to v2",
  );
  assert(
    lib.includes("async fn select_export_path(app: AppHandle, input: Option<Value>)") &&
      lib.includes("async fn select_file(app: AppHandle, input: Option<Value>)") &&
      lib.includes("async fn select_folder(app: AppHandle, input: Option<Value>)"),
    "native picker commands must use one explicit input wrapper",
  );
  assert(
    lib.includes("restore-before"),
    "snapshot restore must keep a before-backup",
  );
  assert(
    lib.includes("snapshot_list.insert") && lib.includes("backup_snapshot_id"),
    "snapshot restore must retain the before-backup in canonical metadata",
  );
  assert(
    !lib.includes('"status": "delegated"'),
    "native commands must not claim delegated success",
  );
  assert(
    lib.includes("当前原生壳未配置操作系统钥匙串"),
    "secret fallback must be explicit unsupported",
  );
  assert(
    app.includes('"project.open": "project_open"') &&
      app.includes('"project.create": "project_create"') &&
      app.includes('"snapshot.restore": "restore_snapshot"') &&
      app.includes('invoke("project_close"') &&
      app.includes('addEventListener("beforeunload"') &&
      app.includes("closeNativeProject(previousProjectDir)") &&
      app.includes("getCurrentWindow") &&
      app.includes("onCloseRequested") &&
      app.includes('listen("tauri://close-requested"') &&
      app.includes('workbench://close-requested') &&
      app.includes('confirmClose()') &&
      app.includes('return await this.invoke("project.open", {})') &&
      !app.includes('invoke("open_project"') &&
      app.includes('"project.external.inspect": "project_external_status"') &&
      app.includes('resolveExternalConflict') &&
      app.includes('external_modification_conflict') &&
      app.includes("nativeLeaseDirs") &&
      app.includes("hasNativeLease") &&
      app.includes("targetLeaseActive") &&
      app.includes("nativeSwitchPending") &&
      app.includes("rollbackNativeTarget") &&
      app.includes("onDragDropEvent") &&
      app.includes('listen("tauri://drag-drop"'),
    "native mapping must target explicit create/open/restore/close lifecycle commands",
  );
  const readProjectStart = lib.indexOf("fn read_project(project_dir: String)");
  const readProjectEnd = lib.indexOf("fn project_save", readProjectStart);
  assert(
    readProjectStart >= 0 && readProjectEnd > readProjectStart &&
      !lib.slice(readProjectStart, readProjectEnd).includes("acquire_project_lock"),
    "read_project must remain read-only and never acquire an edit lease",
  );
  const projectSaveStart = lib.indexOf("fn project_save(project_dir: String, project: Value)");
  const projectSaveEnd = lib.indexOf("fn project_create", projectSaveStart);
  assert(
    projectSaveStart >= 0 && projectSaveEnd > projectSaveStart &&
      lib.slice(projectSaveStart, projectSaveEnd).includes("require_active_project_lock") &&
      !lib.slice(projectSaveStart, projectSaveEnd).includes("acquire_project_lock"),
    "project_save must require an existing lease; project_create owns acquisition",
  );
  const newProjectStart = app.indexOf("async newProject(title");
  const newProjectEnd = app.indexOf("async newProjectFromPicker", newProjectStart);
  const newProjectBlock = app.slice(newProjectStart, newProjectEnd);
  assert(
    newProjectBlock.indexOf("await this.flush()") < newProjectBlock.indexOf("this.bridge.setProjectDir(projectDir)") &&
      newProjectBlock.indexOf("this.closeNativeProject(previousProjectDir)") > newProjectBlock.indexOf("project.create"),
    "new project switching must flush before target acquisition and release the old lease only after success",
  );
  const openProjectStart = app.indexOf("async openProject(projectDir");
  const openProjectEnd = app.indexOf("async openProjectFromPicker", openProjectStart);
  const openProjectBlock = app.slice(openProjectStart, openProjectEnd);
  assert(
    openProjectBlock.indexOf("await this.flush()") < openProjectBlock.indexOf("this.bridge.setProjectDir(projectDir)") &&
      openProjectBlock.indexOf("this.closeNativeProject(previousProjectDir)") > openProjectBlock.indexOf("saveSession"),
    "open project switching must preserve the old lease until the target is saved successfully",
  );
  assert(
    newProjectBlock.includes("await this.rollbackNativeTarget") &&
      openProjectBlock.includes("await this.rollbackNativeTarget") &&
      !newProjectBlock.includes("closeNativeProject(previousProjectDir); } catch (() => {})") &&
      !openProjectBlock.includes("closeNativeProject(previousProjectDir); } catch (() => {})"),
    "project switching must explicitly roll back a target when releasing the old lease fails",
  );
  assert(
    app.includes("this.bridge.restoreProjectDir(null, false)") &&
      app.includes("await this.bridge.saveSession({ project_dir: null })") &&
      app.includes("const hadLease = store.hasNativeLease()") &&
      app.includes("if (store.hasNativeLease()) await store.closeNativeProject()"),
    "failed session recovery and close must clear stale paths and skip unowned release",
  );
  const closeStart = app.indexOf("const flushAndClose = async () =>");
  const closeEnd = app.indexOf("store.subscribe", closeStart);
  const closeBlock = app.slice(closeStart, closeEnd);
  assert(
    closeStart >= 0 && closeEnd > closeStart &&
      closeBlock.includes("await store.resolveNativeSwitchPending()") &&
      closeBlock.indexOf("await store.flush()") < closeBlock.indexOf("closeNativeProject") &&
      closeBlock.indexOf("closeNativeProject") < closeBlock.indexOf("confirmClose"),
    "native close must flush, release an owned lease, then confirm exit",
  );
  const closeHandlerStart = app.indexOf("currentWindow.onCloseRequested");
  const closeHandlerEnd = app.indexOf("}).catch(() => {});", closeHandlerStart);
  const closeHandler = app.slice(closeHandlerStart, closeHandlerEnd);
  assert(
    closeHandler.includes("(event)") &&
      closeHandler.indexOf("event.preventDefault()") >= 0 &&
      closeHandler.indexOf("event.preventDefault()") < closeHandler.indexOf("flushAndClose()"),
    "window close handling must prevent destruction before flushing and releasing the lease",
  );
  assert(
    lib.includes("let Some(registered) = registered else") &&
      lib.includes("return Ok(())") &&
      lib.includes("release_without_registered_lease_has_no_side_effect"),
    "native release must not create a guard for an unopened directory",
  );
  assert(
    lib.includes("year_text.len() != 4") &&
      lib.includes("extreme_heartbeat_is_malformed_without_overflow"),
    "native heartbeat parsing must reject extreme years without overflow",
  );
  for (
    const signature of [
      "fn read_project(project_dir: String)",
      "fn project_save(project_dir: String, project: Value)",
      "fn write_recovery_journal(project_dir: String, contents: String)",
      "fn read_recovery_journal(project_dir: String)",
    ]
  ) {
    assert(
      lib.includes(signature),
      `${signature} must require a project directory`,
    );
  }
  assert(
    !lib.includes("fn project_save(project_dir: Option<String>") &&
      !lib.includes("fn read_project(project_dir: Option<String>"),
    "native project open/save cannot make the directory optional",
  );
  assert(
    app.includes("projectDir: this.requireProjectDir()") &&
      app.includes("project_dir: projectDir") &&
      app.includes("output_dir: preset.output_dir || projectDir") &&
      app.includes(
        "return { source: { ...input, project_dir: projectDir } }",
      ) &&
      app.includes("return { input: { ...input, project_dir: projectDir } }"),
    "native persistence, import, export and publication must carry the selected directory",
  );
  assert(
    app.includes("project_dir: this.projectDir || null") &&
      app.includes(
        "if (this.bridge.isNative()) return { project_dir: this.bridge.projectDir };",
      ) &&
      !app.includes("data-project-dir") &&
      app.includes('"select_folder"') &&
      app.includes('return await this.invoke("project.open", {})') &&
      !app.includes('invoke("open_project"') &&
      app.includes("await this.bridge.saveSession({ project_dir: null })"),
    "native session and launcher must use the folder picker instead of manual paths",
  );
  assert(
    app.includes('"select_file"') &&
      app.includes('"select_export_path"') &&
      app.includes('invoke("clear_recovery_journal"') &&
      app.includes('listen("tauri://drag-drop"') &&
      app.includes("source_path: sourcePath") &&
      app.includes("const context = this.assetContext()") &&
      app.includes("md|markdown") &&
      app.includes("if (!await this.flush())") &&
      app.includes("this.decodeBytes(await invoke") &&
      app.includes("content_item_id: contentItemId") &&
      app.includes("无法导入文件") &&
      app.includes(".webm,.mov,.m4v"),
    "native picker, drag/drop, recovery cleanup and contextual asset import must stay in the UI boundary",
  );
  assert(
    app.includes("const clearResult = await this.bridge.clearRecoveryJournal()") &&
      app.includes("this.noteRecoveryWarning") &&
      app.includes("this.flushQueue = createSerialQueue()") &&
      app.includes("files)) return nativePath(candidate.files[0])"),
    "recovery cleanup must follow canonical save, stay serialized, and native export file/path envelopes must be readable",
  );
  const saveStart = lib.indexOf("fn project_save");
  const saveEnd = lib.indexOf("fn bridge_status", saveStart);
  assert(
    saveStart >= 0 && saveEnd > saveStart,
    "project_save boundary must be discoverable",
  );
  assert(
    !lib.slice(saveStart, saveEnd).includes("app_local_data_dir"),
    "project_save cannot use fixed app-local data",
  );
  for (const format of ["json", "markdown", "html"]) {
    assert(
      lib.includes(`\"${format}\"`),
      `${format} export must have a native branch`,
    );
  }
});

Deno.test("native boundary has no fs or shell Tauri capability", () => {
  const permissions = capability.permissions as string[];
  assert(
    !permissions.some((permission) => permission.startsWith("fs:")),
    "fs capability must stay absent",
  );
  assert(
    !permissions.some((permission) => permission.startsWith("shell:")),
    "shell capability must stay absent",
  );
  assert(
    permissions.includes("dialog:allow-open") &&
      permissions.includes("dialog:allow-save"),
    "dialog plugin permissions must be explicitly scoped",
  );
  assert(
    lib.includes("loopback-only"),
    "bridge must advertise loopback-only mode",
  );
  assert(
    lib.includes("constant_time_equal"),
    "bridge token comparison must be protected",
  );
  assert(lib.includes("白名单动作"), "bridge actions must be allow-listed");
});
