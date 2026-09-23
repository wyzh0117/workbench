import {
  appendBlock,
  createDocument,
  createEmptyProjectData,
  initializeContentStatuses,
  now,
} from "../src/domain/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function count(source: string, literal: string): number {
  return source.split(literal).length - 1;
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to >= 0, `source must contain ${start} and ${end}`);
  return source.slice(from, to);
}

function projectWithLesson() {
  const data = createEmptyProjectData("返回行为测试");
  const stage = data.stages[0];
  const contentId = crypto.randomUUID();
  const document = createDocument(data, contentId);
  data.content_items.push({
    id: contentId,
    project_id: data.project.id,
    stage_id: stage?.id ?? null,
    code: "S01-01",
    title: "返回后继续",
    type: "lesson",
    description: "",
    order_index: 0,
    document_id: document.id,
    archived: false,
    created_at: now(),
    updated_at: now(),
  });
  initializeContentStatuses(data, contentId);
  appendBlock(data, contentId, "paragraph", "返回后仍然保留的正文");
  return data;
}

Deno.test("Workbench shell keeps one collapse control per local sidebar", async () => {
  const source = await Deno.readTextFile(
    new URL("../app/views.js", import.meta.url),
  );
  const topbar = between(source, "function topbarView", "function leftPanelView");
  const left = between(source, "function leftPanelView", "function centerView");
  const right = between(source, "function rightPanelView", "function statusbarView");
  const launcher = between(source, "function launcherView", "const launcher");
  const styles = await Deno.readTextFile(
    new URL("../app/styles.css", import.meta.url),
  );
  const main = await Deno.readTextFile(
    new URL("../app/main.js", import.meta.url),
  );

  assert(count(source, 'data-action="toggle-left"') === 1, "left collapse must have one control");
  assert(count(source, 'data-action="toggle-right"') === 1, "right collapse must have one control");
  assert(count(source, 'data-action="return-launcher"') === 1, "launcher return must have one control");
  assert(topbar.includes('data-action="return-launcher"'), "topbar must own the launcher return action");
  assert(topbar.includes('class="secondary launcher-return"'), "launcher return must be a named secondary action");
  assert(topbar.includes("返回项目选择；当前项目不会关闭"), "return action must explain that the project stays open");
  assert(!topbar.includes('data-action="toggle-left"'), "topbar must not duplicate the left collapse action");
  assert(!topbar.includes('data-action="toggle-right"'), "topbar must not duplicate the right collapse action");
  assert(main.includes('case "return-launcher": store.returnToLauncher(); return;'), "return button must have an explicit action handler");
  assert(launcher.includes('class="recent-card"') && launcher.includes('data-action="enter-project"'), "continue must re-enter through the project action");
  const recentCard = between(launcher, 'class="recent-card"', "</section>");
  assert(!recentCard.includes('data-action="open-item"'), "continue must not bypass session restoration with a direct lesson open");
  // V1-T02 P1-1: the launcher used to show nine differently named entries that
  // all ran "新建课程".  The real course-input entrances live in 课程地图 now,
  // and the launcher must point there instead of pretending.
  assert(!launcher.includes('class="seed-choices"'), "the launcher must not fake nine different entrances");
  assert(launcher.includes("课程地图"), "the launcher must say where existing material is turned into a course map");
  assert(source.includes("function seedCard()"), "课程地图 must own the course-input card");
  const seedCard = between(source, "function seedCard()", "function mapView()");
  assert(
    seedCard.includes("SEED_TEXT_SOURCES.map") && seedCard.includes('data-action="pick-seed" data-type="${type}"'),
    "the seed card must render one real entrance per supported course-input source",
  );
  const authoring = await Deno.readTextFile(
    new URL("../app/authoring.js", import.meta.url),
  );
  for (const type of ["overview", "outline", "toc", "articles", "spreadsheet", "conversations"]) {
    assert(authoring.includes(`"${type}"`), `the shared vocabulary must define ${type}`);
    assert(authoring.includes(`  ${type}: {`), `every supported source needs its own hint, including ${type}`);
  }
  assert(authoring.includes("folder:"), "the unsupported folder source must exist so it can be disabled honestly");
  assert(seedCard.includes("disabled"), "an unsupported source must be visible but disabled rather than fake");
  assert(seedCard.includes('data-action="build-blueprint"'), "the seed card must build a blueprint draft");
  assert(seedCard.includes("disabled"), "an unsupported source must be visible but disabled rather than fake");
  assert(main.includes('case "build-blueprint": void store.startSeed(); return;'), "the seed card must run through the store");
  assert(main.includes('"course.seed.create"') && main.includes('"blueprint.build"'), "the seed flow must use the Domain commands, not a local copy");
  assert(left.includes('class="panel-heading"'), "left collapse must stay in the left panel heading");
  assert(left.includes('data-action="toggle-left"'), "left panel must keep its local collapse action");
  assert(right.includes('class="right-tabs"'), "right collapse must stay in the right panel tabs");
  assert(right.includes('data-action="toggle-right"'), "right panel must keep its local collapse action");
  assert(styles.includes(".workspace { display: grid; grid-template-columns: 228px minmax(430px, 1fr) 286px;"), "normal workspace columns must stay unchanged");
  assert(styles.includes(".shell.left-collapsed .workspace { grid-template-columns: 30px minmax(430px, 1fr) 286px; }"), "left collapse must leave a local rail");
  assert(styles.includes(".shell.right-collapsed .workspace { grid-template-columns: 228px minmax(430px, 1fr) 30px; }"), "right collapse must leave a local rail");
  assert(styles.includes(".shell.left-collapsed.right-collapsed .workspace { grid-template-columns: 30px minmax(430px, 1fr) 30px; }"), "both collapsed rails must leave the center usable");
  assert(styles.includes(".left-collapsed .left-panel, .right-collapsed .right-panel { visibility: visible; }"), "collapsed sidebars must keep their local expand controls visible");
  assert(styles.includes(".left-collapsed .left-panel nav") && styles.includes(".right-collapsed .right-panel .right-content"), "collapsed rails must hide content without hiding controls");
  assert(styles.includes("@media (max-width: 1150px)"), "narrow workspace rules must remain present");
  assert(30 + 420 + 30 <= 960, "both narrow collapsed rails must not cover the main work area");
});

Deno.test("shared controls align core workbench surfaces without losing compact exceptions", async () => {
  const styles = await Deno.readTextFile(
    new URL("../app/styles.css", import.meta.url),
  );
  const views = await Deno.readTextFile(
    new URL("../app/views.js", import.meta.url),
  );

  assert(styles.includes("--control-height: 35px"), "alignment pass must expose one shared control height");
  assert(styles.includes("--statusbar-height: 30px"), "statusbar height must be a shared token");
  assert(
    /\.primary, \.secondary, \.text-button, \.icon-button, \.mode-button, \.filter\s*\{[\s\S]*?display: inline-flex/.test(styles),
    "button families must share inline-flex vertical alignment",
  );
  assert(styles.includes("min-height: var(--control-height);"), "standard controls must share a minimum height");
  assert(styles.includes("height: var(--icon-control-size);"), "icon controls must keep a stable clickable size");
  assert(styles.includes(".field-label input, .field-label textarea") && styles.includes("padding: 8px 10px"), "field inputs must use the shared vertical padding");
  assert(styles.includes(".panel-heading {") && styles.includes("height: 48px;"), "left sidebar heading must use the common heading height");
  assert(styles.includes(".right-tabs {") && styles.includes("height: 48px;"), "right sidebar heading must use the common heading height");
  assert(styles.includes(".side-head {") && styles.includes("min-height: 36px;"), "right-panel section headings must reserve a consistent title row");
  assert(styles.includes(".modal-head {") && styles.includes("align-items: center;"), "dialog headers must center their title and close control");
  assert(styles.includes(".modal > .modal-actions { min-height: var(--control-height); }"), "dialog footers must align to the standard control height");
  assert(styles.includes(".modal-actions.compact .secondary { min-height: var(--control-height-compact);"), "compact action rows must keep their smaller intended height");
  assert(styles.includes(".statusbar > span {") && styles.includes("text-overflow: ellipsis;"), "status text must stay aligned and bounded");
  assert(styles.includes("bottom: calc(var(--statusbar-height) + 16px);"), "toast must clear the status bar consistently");
  assert(views.includes('class="statusbar"') && views.includes('class="toast"'), "alignment pass must cover status and toast surfaces");
});

Deno.test("returning to the launcher keeps the project and continue position intact", async () => {
  const runtime = globalThis as typeof globalThis & {
    document?: unknown;
    __TAURI__?: unknown;
  };
  const previousDocument = runtime.document;
  const previousTauri = runtime.__TAURI__;
  const previousFetch = globalThis.fetch;
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {},
  };
  runtime.document = {
    querySelector: () => root,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
    activeElement: null,
  };
  runtime.__TAURI__ = undefined;
  globalThis.fetch = async () => {
    throw new Error("test fetch disabled");
  };

  try {
    const { WorkbenchStore } = await import(
      `../app/main.js?workbench-ui-${crypto.randomUUID()}`
    );
    const project = projectWithLesson();
    const calls: string[] = [];
    const bridge = {
      projectDir: "/tmp/workbench-ui-return",
      projectDirFromUrl: false,
      isNative: () => true,
      command: async (command: string) => {
        calls.push(command);
        return {};
      },
      saveSession: async () => {
        calls.push("save-session");
      },
      closeProject: async () => {
        calls.push("close-project");
      },
    };
    const store = new WorkbenchStore(bridge);
    store.data = structuredClone(project);
    store.ui.screen = "project";
    store.ui.activeId = project.content_items[0]!.id;
    store.ui.mode = "preview";
    store.ui.rightPanel = "media";
    store.ui.route = "publish";
    store.ui.leftCollapsed = true;
    store.ui.rightCollapsed = true;
    store.tabs = [{
      content_item_id: project.content_items[0]!.id,
      mode: "preview",
      pinned: true,
      scroll_top: 24,
    }];
    store.markNativeLease(bridge.projectDir);
    const before = JSON.stringify(store.data);

    store.returnToLauncher();
    assert(store.ui.screen === "launcher", "return action must show the default launcher");
    assert(store.data.project.id === project.project.id, "return action must keep the open project");
    assert(JSON.stringify(store.data) === before, "return action must not mutate canonical project data");
    assert(store.hasNativeLease(bridge.projectDir), "return action must keep the project lease");
    assert(!calls.includes("close-project"), "return action must not close the project");

    store.enterProject();
    assert(store.ui.screen === "project", "continue action must re-enter the open project");
    assert(store.ui.activeId === project.content_items[0]!.id, "continue must keep the current lesson");
    assert(store.ui.mode === "preview", "continue must keep the current mode");
    assert(store.ui.rightPanel === "media", "continue must keep the current panel");
    assert(store.ui.route === "publish", "continue must keep the current view");
    assert(store.tabs[0]?.scroll_top === 24, "continue must keep the current tab position");
    assert(store.hasNativeLease(bridge.projectDir), "continue must keep the same project lease");
  } finally {
    runtime.document = previousDocument;
    runtime.__TAURI__ = previousTauri;
    globalThis.fetch = previousFetch;
  }
});

Deno.test("user-facing copy explains safety, continuation, and next actions", async () => {
  const views = await Deno.readTextFile(new URL("../app/views.js", import.meta.url));
  const main = await Deno.readTextFile(new URL("../app/main.js", import.meta.url));
  const boot = await Deno.readTextFile(new URL("../app/boot.js", import.meta.url));
  const server = await Deno.readTextFile(new URL("../scripts/dev_server.ts", import.meta.url));
  const storage = await Deno.readTextFile(new URL("../src/service/storage.ts", import.meta.url));
  const errors = await Deno.readTextFile(new URL("../src/service/errors.ts", import.meta.url));

  assert(views.includes("保存已暂停") && views.includes("磁盘版本没有改变"), "conflict copy must explain the safety stop");
  assert(views.includes("请选择重新载入、自动合并，或在确认后保留本地版本"), "conflict copy must name the next actions");
  assert(!views.includes("EXTERNAL MODIFICATION CONFLICT") && !views.includes("BLOCKING") && !views.includes("WARNING"), "technical conflict/preflight labels must stay out of primary copy");
  assert(views.includes("显示技术信息") && views.includes("必须修复") && views.includes("确认提示并导出"), "preflight must separate repair blockers from confirmable notices");
  assert(views.includes("预览失败；请打开媒体库查看，或重新导入文件") && views.includes("没有找到匹配的素材。换一个文件名继续搜索"), "asset copy must explain recovery and search next steps");
  assert(views.includes("课程内容没有改动，你可以检查设置后重试"), "AI failure copy must state that canonical content is safe");
  assert(main.includes("const userFacingError") && main.includes("external_modification_conflict") && main.includes("keychain_unavailable") && main.includes("当前操作没有写入"), "save/open/AI failures must map technical causes to safe user copy");
  assert(main.includes("发现未完成的保存；磁盘版本没有改变") && main.includes("暂存内容"), "startup recovery copy must explain the available choices");
  assert(boot.includes("createElement(\"details\")") && boot.includes("显示技术信息") && boot.includes("项目文件没有被改动"), "startup failure details must be expandable and safe");
  assert(server.includes("asErrorObject(value, \"bridge_request_failed\")") && server.includes("technical_message"), "browser bridge errors must expose diagnostics separately from user copy");
  assert(storage.includes("这个项目正在其他窗口或进程中使用") && storage.includes("课程文件在其他地方发生了变化"), "service lock/conflict errors must be actionable in Chinese");
  assert(errors.includes("这项操作没有完成。工作台仍可继续使用，请重试。"), "unknown service errors must still tell users what they can do next");
});
