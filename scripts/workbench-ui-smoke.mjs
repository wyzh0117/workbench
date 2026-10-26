/** Real rendered-browser smoke test. No production fixture/result fallback is installed. */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const modulePath = process.env.WB_PLAYWRIGHT_MODULE;
if (!modulePath) {
  throw new Error(
    "Set WB_PLAYWRIGHT_MODULE to the installed Playwright index.mjs.",
  );
}
const { chromium } = await import(pathToFileURL(modulePath).href);
const root = resolve("app"), output = resolve(".qa-output");
await mkdir(output, { recursive: true });
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const target = resolve(
      root,
      "." +
        decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname),
    );
    if (!target.startsWith(root + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const bytes = await readFile(target);
    res.writeHead(200, {
      "content-type": types[extname(target)] || "application/octet-stream",
    });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WB_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.WB_CHROMIUM_EXECUTABLE }
    : {}),
}).catch(async (error) => {
  await new Promise((resolve) => server.close(resolve));
  throw error;
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const steps = [];
const record = async (label) => {
  steps.push(label);
  console.log("PASS", label);
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("heading", { name: "从一份文档开始" }).waitFor().catch(
    () => page.locator(".workbench").waitFor(),
  );
  assert.match(await page.locator("body").innerText(), /浏览器编辑模式/);
  await page.screenshot({ path: output + "/01-empty.png", fullPage: true });
  await record(
    "Production entry renders empty workspace without simulated content",
  );
  await page.locator("#wb-import-input").setInputFiles({
    name: "课堂研究.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# 课堂研究\n\n## 第一章\n\n真实导入的正文。\n\n## 第二章\n\n保留这段资料。\n",
    ),
  });
  await page.getByRole("textbox", { name: "文档标题", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "文档标题", exact: true })
      .inputValue(),
    "课堂研究",
  );
  assert.equal(await page.locator("textarea.block-text").count(), 2);
  await page.locator("textarea.block-text").first().fill(
    "这是在编辑器中修改后的正文。",
  );
  await record(
    "Actual Markdown file import creates editable chapters and accepts text edits",
  );
  for (const side of ["left", "right"]) {
    await page.locator(`[data-action="collapse-${side}"]`).click();
    assert(
      await page.locator(".workbench").evaluate(
        (el, s) => el.classList.contains(s + "-collapsed"),
        side,
      ),
    );
    await page.locator(`[data-action="expand-${side}"]`).click();
    const handle = page.locator(`[data-resize="${side}"]`);
    const before = Number(await handle.getAttribute("aria-valuenow"));
    await handle.focus();
    await page.keyboard.press(side === "left" ? "ArrowRight" : "ArrowLeft");
    assert.notEqual(Number(await handle.getAttribute("aria-valuenow")), before);
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + (side === "left" ? 35 : -35),
      box.y + box.height / 2,
    );
    await page.mouse.up();
  }
  await record(
    "Both sidebars collapse/reopen and resize using keyboard and pointer",
  );
  await page.locator('[data-action="settings"]').first().click();
  await page.getByRole("dialog").waitFor();
  assert.equal(
    await page.locator('input[name="secret"]').first().getAttribute("type"),
    "password",
  );
  await page.locator('[data-action="close-modal"]').click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.locator('[data-action="settings"]').first().click();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await record(
    "Settings uses password controls and repeated close/Escape leaves no stale dialog",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.locator('[data-action="save"]').click();
  const download = await downloadPromise;
  const saved = output + "/edited-document.md";
  await download.saveAs(saved);
  assert.match(await readFile(saved, "utf8"), /这是在编辑器中修改后的正文/);
  assert.match(await readFile(saved, "utf8"), /保留这段资料/);
  await record("Browser standard Markdown save produces actual edited bytes");
  await page.screenshot({
    path: output + "/02-edited-document.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.screenshot({ path: output + "/03-compact.png", fullPage: true });
  assert.equal(errors.length, 0, errors.join("\n"));
  await writeFile(
    output + "/results.json",
    JSON.stringify(
      {
        passed: steps.length,
        steps,
        pageErrors: errors,
        note:
          "Real Chromium browser-mode UI checks. Native backend/package tests are separate; no claim of macOS UI interaction.",
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({ path: output + "/failure.png", fullPage: true })
    .catch(() => {});
  await writeFile(
    output + "/failure.txt",
    String(error.stack || error) + "\nPage errors:\n" + errors.join("\n"),
  );
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
