/**
 * Boot the workbench shell.
 *
 * This is a classic (non-module) script on purpose: it runs even when the
 * module graph fails, so a broken bundle can say which file did not load
 * instead of leaving an empty window.  It lives in its own file rather than
 * inline so the app's `script-src 'self'` policy never has to allow inline
 * script.
 */
(function () {
  var reported = false;
  function panel(summary, detail) {
    if (reported) return;
    var app = document.getElementById("app");
    if (!app || app.childElementCount > 0) return;
    reported = true;
    var section = document.createElement("section");
    section.className = "boot-error";
    section.setAttribute("role", "alert");
    var title = document.createElement("h1");
    title.textContent = "工作台界面加载失败";
    var lead = document.createElement("p");
    lead.textContent = summary;
    section.appendChild(title);
    section.appendChild(lead);
    if (detail) {
      var details = document.createElement("details");
      details.className = "diagnostic";
      var summaryNode = document.createElement("summary");
      summaryNode.textContent = "显示技术信息";
      details.appendChild(summaryNode);
      var pre = document.createElement("pre");
      pre.textContent = detail;
      details.appendChild(pre);
      section.appendChild(details);
    }
    var hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "项目文件没有被改动。请重新启动应用；如果仍然失败，再展开技术信息并一并反馈。";
    section.appendChild(hint);
    app.textContent = "";
    app.appendChild(section);
  }
  // The interface modules, in load order.  Probing them turns "nothing
  // happened" into "this file is missing".
  var SHELL_FILES = [
    "/styles.css",
    "/constants.js",
    "/recovery.js",
    "/authoring.js",
    "/ai.js",
    "/canvas.js",
    "/views.js",
    "/main.js",
  ];
  function probe() {
    return Promise.all(SHELL_FILES.map(function (file) {
      return fetch(file).then(function (response) {
        return file + " → HTTP " + response.status;
      }).catch(function (error) {
        return file + " → " + (error && error.message ? error.message : "无法读取");
      });
    })).then(function (lines) { return lines.join("\n"); });
  }
  function report(summary, detail) {
    probe().then(function (listing) {
      panel(summary, (detail ? detail + "\n\n" : "") + "界面资源检查：\n" + listing);
    }).catch(function () {
      panel(summary, detail);
    });
  }
  window.addEventListener("error", function (event) {
    var target = event.target;
    if (target && target !== window && target.tagName) {
      var tag = String(target.tagName).toLowerCase();
      if (tag === "script" || tag === "link") {
        report("有一个界面资源没有加载成功。", String(target.src || target.href || ""));
        return;
      }
    }
    report("界面脚本执行出错。", event.message || String(event.error || ""));
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    report("界面启动过程中出错。", reason && reason.message ? reason.message : String(reason || ""));
  });
  import("/main.js").catch(function (error) {
    report("界面脚本加载失败。", error && (error.stack || error.message) ? (error.stack || error.message) : String(error));
  });
})();
