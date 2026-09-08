#!/usr/bin/env node
/**
 * 预览页自检工具（无头 Chrome + CDP）。
 *
 * 因为要验证的是「布局是否真的落到正确的像素位置」，所以这里不用截图，
 * 而是直接连 Chrome DevTools Protocol，在页面里执行断言表达式并取回 JSON。
 *
 * 用法：
 *   node tools/preview-check.mjs                 # 只做静态布局校验
 *   node tools/preview-check.mjs --run           # 额外点击「运行」，验证输出画廊
 *   node tools/preview-check.mjs --url <url>     # 指定页面地址（默认起本地静态服务）
 *
 * 需要本机安装 Google Chrome。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 8129;
const DEBUG_PORT = 9223;

const args = process.argv.slice(2);
const wantRun = args.includes("--run");
const wantDeep = args.includes("--deep");
const urlArgIndex = args.indexOf("--url");
const explicitUrl = urlArgIndex >= 0 ? args[urlArgIndex + 1] : null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- 静态服务 */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
};

function startStaticServer() {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const file = join(ROOT, path.replace(/^\/+/, "") || "preview/index.html");
      if (!file.startsWith(ROOT)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch (error) {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

/* ---------------------------------------------------------------- CDP 客户端 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.consoleErrors.push(
          message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" ")
        );
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        this.exceptions.push(details.exception?.description || details.text);
      }
    });
  }

  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text
      );
    }
    return result.result.value;
  }
}

async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
      const page = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      /* Chrome 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("找不到 Chrome 调试目标");
}

/* ---------------------------------------------------------------- 断言表达式 */
const LAYOUT_EXPRESSION = `(() => {
  const rect = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      x: Math.round(box.x), y: Math.round(box.y),
      w: Math.round(box.width), h: Math.round(box.height),
      display: style.display, position: style.position,
    };
  };
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? node.textContent.trim() : null;
  };
  const root = document.getElementById("cw-root");
  const vars = getComputedStyle(document.documentElement);
  const groups = [...document.querySelectorAll("#cw-left-body .cw-group")].map((group) => ({
    title: group.querySelector(".cw-group-title")?.textContent.trim(),
    badge: group.querySelector(".cw-badge")?.textContent.trim() || null,
    fields: [...group.querySelectorAll(".cw-field")].map((field) => ({
      kind: [...field.classList].find((c) => c.startsWith("cw-field-"))?.replace("cw-field-", ""),
      label: field.querySelector(".cw-field-name")?.textContent.trim(),
      value: field.querySelector("textarea, select, input")?.value,
    })),
  }));
  const metrics = [...document.querySelectorAll(".cw-metric")].map((metric) => ({
    key: metric.dataset.key,
    label: metric.querySelector(".cw-metric-label")?.textContent.trim(),
    value: metric.querySelector(".cw-metric-value")?.textContent.trim(),
    fill: metric.querySelector(".cw-meter-fill")?.style.width,
  }));
  const cards = [...document.querySelectorAll(".cw-card")].map((card) => ({
    kind: [...card.classList].find((c) => c.startsWith("cw-card-") && c !== "cw-card-media" && c !== "cw-card-bar" && c !== "cw-card-actions" && c !== "cw-card-meta" && c !== "cw-card-name" && c !== "cw-card-sub" && c !== "cw-card-btn" && c !== "cw-card-error"),
    name: card.querySelector(".cw-card-name")?.textContent.trim(),
    hasImage: Boolean(card.querySelector("img")),
    hasVideo: Boolean(card.querySelector("video")),
  }));
  return {
    enabled: Boolean(window.ComfUIWorkbench?.enabled),
    errors: window.__CW_ERRORS__ || [],
    bodyClass: document.body.className,
    cssVars: {
      menuH: vars.getPropertyValue("--cw-menu-h").trim(),
      top: vars.getPropertyValue("--cw-top").trim(),
      leftW: vars.getPropertyValue("--cw-left-w").trim(),
      rightW: vars.getPropertyValue("--cw-right-w").trim(),
    },
    rects: {
      bar: rect("#cw-bar"),
      left: rect("#cw-left"),
      right: rect("#cw-right"),
      canvasHost: rect(".cw-canvas-host"),
      leftSplit: rect(".cw-split-left"),
      rightSplit: rect(".cw-split-right"),
    },
    canvasHostClass: document.querySelector("#graph-canvas-container")?.className || null,
    nativeHidden: {
      menu: rect(".comfyui-menu"),
      sidebar: rect(".side-bar-panel"),
    },
    workflowName: text(".cw-wf-name"),
    workflowOptions: [...document.querySelectorAll(".cw-wf-select option")].map((o) => o.textContent.trim()),
    groups,
    metrics,
    cardCount: cards.length,
    cards: cards.slice(0, 6),
    runButton: text(".cw-run"),
    queueText: text(".cw-queue-text"),
    dir: text(".cw-dir"),
  };
})()`;

const RUN_EXPRESSION = `(async () => {
  const before = document.querySelectorAll(".cw-card").length;
  document.querySelector(".cw-run").click();
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const after = document.querySelectorAll(".cw-card").length;
  return {
    before,
    after,
    added: after - before,
    firstCard: document.querySelector(".cw-card .cw-card-name")?.textContent.trim(),
    queueText: document.querySelector(".cw-queue-text")?.textContent.trim(),
    progressHidden: document.querySelector(".cw-progress-row")?.classList.contains("cw-hidden"),
  };
})()`;

const DEEP_EXPRESSION = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wb = window.ComfUIWorkbench;
  const comfy = window.__CW_COMFY__;
  const rect = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
  };
  const fieldValue = (label) => {
    const field = [...document.querySelectorAll("#cw-left-body .cw-field")]
      .find((item) => item.querySelector(".cw-field-name")?.textContent.trim() === label);
    return field ? field.querySelector("textarea, select, input").value : null;
  };
  const out = {};

  /* 0. 关掉 mock 的自动改动，避免和下面的显式断言抢同一个参数 */
  window.__CW_MOCK__?.stopAutoEdit?.();

  /* 1. 画布改参数 → 左侧面板同步 */
  const sampler = comfy.app.graph._nodes.find((node) => node.id === 5);
  const stepsWidget = sampler.widgets.find((widget) => widget.name === "steps");
  out.stepsBefore = fieldValue("步数");
  stepsWidget.value = 48;
  comfy.app.graph.setDirtyCanvas();
  await wait(1600);
  out.stepsAfterExternalEdit = fieldValue("步数");

  /* 2. 面板改参数 → 写回节点 */
  const stepsField = [...document.querySelectorAll("#cw-left-body .cw-field")]
    .find((item) => item.querySelector(".cw-field-name")?.textContent.trim() === "步数");
  const stepsInput = stepsField.querySelector("input");
  stepsInput.value = "33";
  stepsInput.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(200);
  out.stepsWrittenBack = stepsWidget.value;

  /* 3. 隐藏 / 显示原生顶栏 */
  const menuButton = document.querySelector(".cw-bar-actions .cw-btn");
  menuButton.click();
  await wait(400);
  out.menuHidden = getComputedStyle(document.querySelector(".comfyui-menu")).display;
  out.menuVarHidden = getComputedStyle(document.documentElement).getPropertyValue("--cw-menu-h").trim();
  out.barYHidden = rect("#cw-bar")?.y;
  out.canvasYHidden = rect(".cw-canvas-host")?.y;
  menuButton.click();
  await wait(400);
  out.menuRestored = getComputedStyle(document.querySelector(".comfyui-menu")).display;
  out.barYRestored = rect("#cw-bar")?.y;

  /* 4. 大图预览 */
  document.querySelector(".cw-card-media img")?.click();
  await wait(400);
  out.lightboxOpen = !document.querySelector(".cw-lightbox").classList.contains("cw-hidden");
  out.lightboxHasImage = Boolean(document.querySelector(".cw-lightbox .cw-lb-media"));
  out.lightboxTitle = document.querySelector(".cw-lb-title")?.textContent.trim();
  document.querySelector(".cw-lb-close")?.click();
  await wait(250);
  out.lightboxClosed = document.querySelector(".cw-lightbox").classList.contains("cw-hidden");

  /* 5. 主题切换 */
  wb.layout.applyTheme("light");
  await wait(150);
  out.themeLight = document.documentElement.dataset.cwTheme;
  out.panelBgLight = getComputedStyle(document.querySelector("#cw-left")).backgroundColor;
  wb.layout.applyTheme("dark");
  await wait(150);
  out.panelBgDark = getComputedStyle(document.querySelector("#cw-left")).backgroundColor;

  /* 6. 关闭 / 打开简化模式 */
  wb.setEnabled(false);
  await wait(400);
  out.off = {
    bodyClass: document.body.className,
    canvasClass: document.querySelector("#graph-canvas-container").className,
    canvasRect: rect("#graph-canvas-container"),
    sidebarDisplay: getComputedStyle(document.querySelector(".side-bar-panel")).display,
    leftDisplay: getComputedStyle(document.querySelector("#cw-left")).display,
  };
  wb.setEnabled(true);
  await wait(700);
  out.on = {
    bodyClass: document.body.className,
    canvasClass: document.querySelector("#graph-canvas-container").className,
    canvasRect: rect("#graph-canvas-container"),
    sidebarDisplay: getComputedStyle(document.querySelector(".side-bar-panel")).display,
  };

  /* 7. 分隔条拖动 */
  const splitter = document.querySelector(".cw-split-left");
  const box = splitter.getBoundingClientRect();
  splitter.dispatchEvent(new PointerEvent("pointerdown", { clientX: box.x + 6, clientY: 300, bubbles: true, pointerId: 1 }));
  splitter.dispatchEvent(new PointerEvent("pointermove", { clientX: box.x + 106, clientY: 300, bubbles: true, pointerId: 1 }));
  splitter.dispatchEvent(new PointerEvent("pointerup", { clientX: box.x + 106, clientY: 300, bubbles: true, pointerId: 1 }));
  await wait(300);
  out.leftWidthAfterDrag = getComputedStyle(document.documentElement).getPropertyValue("--cw-left-w").trim();
  out.leftPanelWidthAfterDrag = rect("#cw-left")?.w;
  out.canvasXAfterDrag = rect(".cw-canvas-host")?.x;

  return out;
})()`;

/* ---------------------------------------------------------------- 主流程 */
let server = null;
let chrome = null;
const profile = mkdtempSync(join(tmpdir(), "cw-preview-"));

try {
  if (!explicitUrl) {
    server = await startStaticServer();
  }
  const url = explicitUrl || `http://127.0.0.1:${PORT}/preview/index.html`;

  chrome = spawn(
    CHROME,
    [
      "--headless=old",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-crash-reporter",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1680,1000",
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  chrome.stderr.on("data", () => {});

  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  // 等界面挂载完成
  for (let i = 0; i < 60; i += 1) {
    const ready = await cdp.evaluate(
      `Boolean(window.ComfUIWorkbench?.enabled && document.querySelector("#cw-left-body .cw-group"))`
    );
    if (ready) break;
    await sleep(250);
  }
  await sleep(1200); // 等资源条第一次刷新

  const report = await cdp.evaluate(LAYOUT_EXPRESSION);
  report.consoleErrors = cdp.consoleErrors;
  report.exceptions = cdp.exceptions;

  if (wantRun) {
    report.run = await cdp.evaluate(RUN_EXPRESSION);
    await sleep(400);
    report.afterRun = await cdp.evaluate(LAYOUT_EXPRESSION);
  }

  if (wantDeep) {
    report.deep = await cdp.evaluate(DEEP_EXPRESSION);
    report.deepConsoleErrors = cdp.consoleErrors;
    report.deepExceptions = cdp.exceptions;
  }

  console.log(JSON.stringify(report, null, 2));
  ws.close();
} catch (error) {
  console.error("自检失败：", error);
  process.exitCode = 1;
} finally {
  chrome?.kill("SIGKILL");
  server?.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch (error) {
    /* 忽略 */
  }
}
