#!/usr/bin/env node
/**
 * 预览页自检工具（无头 Chrome + CDP）。
 *
 * 因为要验证的是「布局是否真的落到正确的像素位置」，所以这里不用截图，
 * 而是直接连 Chrome DevTools Protocol，在页面里执行断言表达式并取回 JSON，
 * 再用真实断言逐项检查（失败会以非 0 退出码结束，方便接 CI）。
 *
 * 用法：
 *   node tools/preview-check.mjs                 # 静态布局 + 参数提取 + 输出面板
 *   node tools/preview-check.mjs --run           # 额外点击「运行」，验证输出画廊
 *   node tools/preview-check.mjs --deep          # 额外验证双向同步 / 模式切换 / 诊断
 *   node tools/preview-check.mjs --deep --run    # 全部
 *   node tools/preview-check.mjs --json          # 额外打印原始报告（排查用）
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
const wantJson = args.includes("--json");
const urlArgIndex = args.indexOf("--url");
const explicitUrl = urlArgIndex >= 0 ? args[urlArgIndex + 1] : null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- 断言收集 */
const checks = [];

function check(section, label, ok, detail = "") {
  checks.push({ section, label, ok: Boolean(ok), detail: detail === "" ? "" : String(detail) });
}

function report() {
  const sections = [];
  for (const item of checks) {
    if (!sections.includes(item.section)) sections.push(item.section);
  }
  for (const section of sections) {
    console.log(`\n== ${section} ==`);
    for (const item of checks.filter((entry) => entry.section === section)) {
      const mark = item.ok ? "✅" : "❌";
      console.log(`${mark} ${item.label}${item.detail ? ` — ${item.detail}` : ""}`);
    }
  }
  const failed = checks.filter((item) => !item.ok);
  console.log("");
  if (failed.length === 0) {
    console.log(`✅ 全部通过（${checks.length} 项）`);
  } else {
    console.log(`❌ ${failed.length}/${checks.length} 项失败：`);
    for (const item of failed) console.log(`   · [${item.section}] ${item.label} — ${item.detail}`);
  }
  return failed.length;
}

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
    viewport: { w: window.innerWidth, h: window.innerHeight },
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
    keybindings: (window.__CW_MOCK__?.extension?.keybindings || []).map((item) =>
      [
        item.combo.key,
        item.combo.ctrl ? "ctrl" : "",
        item.combo.shift ? "shift" : "",
        item.combo.alt ? "alt" : "",
      ]
        .filter(Boolean)
        .join("+")
        .toLowerCase()
    ),
    keybindingConflicts: (window.__CW_MOCK__?.keybindingConflicts || []).map((item) => item.message),
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
  const menuButton = document.querySelector(".cw-btn-menu");
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
    rootHidden: document.getElementById("cw-root").classList.contains("cw-hidden"),
    leftRect: rect("#cw-left"),
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

  /* 8. 画布容器选择器：默认命中 → 自定义生效 → 写错回退 → 复位 */
  out.canvasSelectorDefault = wb.layout.canvasHostSelector;
  comfy.app.ui.settings.setSettingValue("ComfUI.Workbench.CanvasSelector", ".graph-canvas-container");
  await wait(200);
  out.canvasSelectorCustom = wb.layout.canvasHostSelector;
  comfy.app.ui.settings.setSettingValue("ComfUI.Workbench.CanvasSelector", "!!! 不是选择器 ((");
  await wait(200);
  out.canvasSelectorBadFallback = wb.layout.canvasHostSelector;
  out.canvasHostAfterBad = Boolean(wb.layout.canvasHost?.isConnected);
  comfy.app.ui.settings.setSettingValue("ComfUI.Workbench.CanvasSelector", "");
  await wait(200);
  out.canvasSelectorReset = wb.layout.canvasHostSelector;

  /* 9. 隐藏选择器里混入无效项，不应影响有效项 */
  const HIDE_KEY = "comfui.workbench.ComfUI.Workbench.HideSelectors";
  localStorage.setItem(HIDE_KEY, JSON.stringify(".mock-hint, !!! 坏选择器 (("));
  wb.layout.installHideStyle();
  await wait(150);
  out.hideRuleWithBad = document.getElementById("cw-hide-style").textContent.includes(".mock-hint");
  out.mockHintDisplay = getComputedStyle(document.querySelector(".mock-hint")).display;
  out.sidebarDisplayWithBad = getComputedStyle(document.querySelector(".side-bar-panel")).display;
  localStorage.removeItem(HIDE_KEY);
  wb.layout.installHideStyle();
  await wait(150);
  out.mockHintRestored = getComputedStyle(document.querySelector(".mock-hint")).display;

  /* 10. 原生弹层（设置对话框 / 下拉菜单）不该被隐藏规则误伤，也不该被工作台盖住 */
  const dialog = document.getElementById("mock-settings");
  const menu = document.getElementById("mock-menu");
  dialog.style.display = "flex";
  menu.style.display = "block";
  await wait(200);
  out.dialogDisplay = getComputedStyle(dialog).display;
  out.dialogSidebarDisplay = getComputedStyle(dialog.querySelector(".mock-dialog-sidebar")).display;
  out.dialogZIndex = getComputedStyle(dialog).zIndex;
  out.dialogOnTop = (() => {
    const box = dialog.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return Boolean(hit && dialog.contains(hit));
  })();
  out.menuZIndex = getComputedStyle(menu).zIndex;
  out.menuInnerDisplay = getComputedStyle(menu.querySelector(".mock-queue-panel")).display;
  out.menuOnTop = (() => {
    const box = menu.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 20);
    return Boolean(hit && menu.contains(hit));
  })();
  const popupDiag = await wb.diagnostics();
  out.diagPopupCount = (popupDiag.popups || []).length;
  out.diagPopupCovered = (popupDiag.popups || []).filter((popup) => popup.covered).length;
  dialog.style.display = "none";
  menu.style.display = "none";
  await wait(150);

  /* 11. 一键诊断 */
  const diag = await wb.diagnostics();
  out.diag = {
    version: diag.plugin?.version,
    hasTimestamp: Boolean(diag.generatedAt),
    canvasFound: diag.canvas?.found,
    canvasSelector: diag.canvas?.selector,
    menuFound: diag.menu?.found,
    menuHeight: diag.menu?.height,
    hiddenRules: diag.hidden?.rules,
    hiddenMatched: diag.hidden?.matched?.length,
    paramsNodes: diag.params?.nodes,
    paramsFields: diag.params?.fields,
    paramsPositive: diag.params?.positive,
    paramsNegative: diag.params?.negative,
    outputCards: diag.output?.cards,
    backendPing: diag.backend?.ping,
    backendStats: diag.backend?.stats,
    comfyApp: diag.comfy?.app,
    leftVar: diag.cssVars?.["--cw-left-w"],
  };
  await wb.diagnose();
  await wait(300);
  const panel = document.getElementById("cw-diag");
  out.diagPanelOpen = panel ? !panel.classList.contains("cw-hidden") : false;
  out.diagTextLength = document.querySelector("#cw-diag-text")?.textContent.length || 0;
  out.diagTextHasCanvas = (document.querySelector("#cw-diag-text")?.textContent || "").includes("画布容器");
  out.diagTextHasPopups = (document.querySelector("#cw-diag-text")?.textContent || "").includes("原生弹层");
  document.querySelector(".cw-diag-bar .cw-btn-icon")?.click();
  await wait(250);
  out.diagPanelClosed = panel ? panel.classList.contains("cw-hidden") : false;
  await wb.diagnose();
  await wait(250);
  out.diagReopened = panel ? !panel.classList.contains("cw-hidden") : false;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(250);
  out.diagEscClosed = panel ? panel.classList.contains("cw-hidden") : false;

  /* 12. 顶栏「原生界面」逃生按钮：浏览器吃掉 Ctrl+Shift+B 时靠它回原生界面 */
  const exitButton = document.querySelector(".cw-btn-exit");
  out.exitButtonExists = Boolean(exitButton);
  out.exitButtonVisible = Boolean(exitButton && exitButton.offsetParent);
  exitButton?.click();
  await wait(600);
  out.exitLeavesSimplified = !document.body.classList.contains("cw-simplified");
  out.exitButtonGone = !document.querySelector(".cw-btn-exit")?.offsetParent;
  wb.setEnabled(true);
  await wait(700);
  out.exitBackToWorkbench = document.body.classList.contains("cw-simplified");

  /* 13. 布局自检：正常时静默，人为破坏后能报出问题 */
  out.selfCheckHealthy = (await wb.selfCheck()).length === 0;
  const menuEl = document.querySelector(".comfyui-menu");
  menuEl.classList.remove("comfyui-menu");
  out.selfCheckBroken = (await wb.selfCheck()).length > 0;
  menuEl.classList.add("comfyui-menu");
  wb.layout.measureMenu();
  await wait(200);

  return out;
})()`;

/* ---------------------------------------------------------------- 断言 */
function assertLayout(data) {
  const S = "布局像素";
  const r = data.rects || {};
  const W = data.viewport?.w || r.bar?.w || 0;
  const bar = r.bar;
  check(S, "资源条贴顶且占满宽度", bar && bar.x === 0 && bar.y === 42 && bar.h === 44 && bar.w === W,
    bar ? `x=${bar.x} y=${bar.y} w=${bar.w} h=${bar.h}` : "未找到 #cw-bar");
  check(S, "左栏固定在左侧、高度撑满", r.left && r.left.x === 0 && r.left.y === 86 && r.left.w === 340,
    r.left ? `x=${r.left.x} y=${r.left.y} w=${r.left.w}` : "未找到 #cw-left");
  check(S, "右栏贴在右侧", r.right && r.right.x === W - 400 && r.right.w === 400 && r.right.y === 86,
    r.right ? `x=${r.right.x} w=${r.right.w}` : "未找到 #cw-right");
  check(S, "画布被挤到中间", r.canvasHost && r.canvasHost.x === 348 && r.canvasHost.w === W - 348 - 408,
    r.canvasHost ? `x=${r.canvasHost.x} w=${r.canvasHost.w}` : "未找到画布容器");
  check(S, "三栏互不重叠",
    r.left && r.canvasHost && r.right &&
      r.left.x + r.left.w <= r.canvasHost.x &&
      r.canvasHost.x + r.canvasHost.w <= r.right.x,
    r.canvasHost ? `left→${r.left.x + r.left.w} canvas→${r.canvasHost.x + r.canvasHost.w} right→${r.right.x}` : "");
  check(S, "分隔条就位",
    r.leftSplit && r.leftSplit.x === 334 && r.leftSplit.w === 12 &&
      r.rightSplit && r.rightSplit.x === W - 406 && r.rightSplit.w === 12,
    r.leftSplit && r.rightSplit ? `leftSplit.x=${r.leftSplit.x} rightSplit.x=${r.rightSplit.x}` : "");
  check(S, "画布容器已接管（加了 cw-canvas-host）",
    String(data.canvasHostClass || "").includes("cw-canvas-host"), data.canvasHostClass);
  check(S, "原生侧栏已隐藏", data.nativeHidden?.sidebar?.display === "none",
    data.nativeHidden?.sidebar?.display);
  check(S, "原生顶栏没有被误隐藏", data.nativeHidden?.menu?.display !== "none",
    data.nativeHidden?.menu?.display);

  const M = "顶部资源条";
  const byKey = Object.fromEntries((data.metrics || []).map((metric) => [metric.key, metric]));
  check(M, "五个指标齐全", ["cpu", "mem", "gpu", "vram", "queue"].every((key) => byKey[key]),
    (data.metrics || []).map((metric) => metric.key).join(","));
  check(M, "CPU 显示百分比", /%$/.test(byKey.cpu?.value || ""), byKey.cpu?.value);
  check(M, "内存显示 已用/总量", /\/.+GB/.test(byKey.mem?.value || ""), byKey.mem?.value);
  check(M, "显卡显示百分比", /%$/.test(byKey.gpu?.value || ""), byKey.gpu?.value);
  check(M, "显存显示 已用/总量", /\/.+GB/.test(byKey.vram?.value || ""), byKey.vram?.value);
  check(M, "队列空闲", (byKey.queue?.value || "").includes("空闲"), byKey.queue?.value);
  check(M, "显示当前工作流名", Boolean(data.workflowName), data.workflowName);

  const P = "左侧参数面板";
  const groups = data.groups || [];
  const allFields = groups.flatMap((group) => group.fields || []);
  const kinds = new Set(allFields.map((field) => field.kind));
  check(P, "按节点分组", groups.length >= 4, `${groups.length} 组`);
  check(P, "自动识别正面提示词", groups.some((group) => group.badge === "正面"),
    groups.map((group) => group.badge).filter(Boolean).join(",") || "无");
  check(P, "自动识别负面提示词", groups.some((group) => group.badge === "负面"),
    groups.map((group) => group.badge).filter(Boolean).join(",") || "无");
  check(P, "文本参数渲染为多行输入", kinds.has("text"), [...kinds].join(","));
  check(P, "数值参数渲染为数字控件", kinds.has("number"), [...kinds].join(","));
  check(P, "种子参数单独渲染", kinds.has("seed"), [...kinds].join(","));
  check(P, "下拉参数渲染为选择框", kinds.has("combo"), [...kinds].join(","));
  const steps = allFields.find((field) => field.label === "步数");
  check(P, "默认步数读取正确", steps?.value === "28", steps?.value);
  check(P, "工作流下拉有内容", (data.workflowOptions || []).length > 0,
    (data.workflowOptions || []).slice(0, 3).join(" / "));

  const O = "右侧输出面板";
  check(O, "启动即列出历史产物", data.cardCount > 0, `${data.cardCount} 张`);
  check(O, "卡片是图片或视频",
    (data.cards || []).length > 0 && (data.cards || []).every((card) => card.hasImage || card.hasVideo),
    (data.cards || []).map((card) => `${card.name}(${card.hasImage ? "img" : "video"})`).join(", "));
  check(O, "显示输出目录", /输出目录/.test(data.dir || ""), data.dir);

  check("运行按钮", "左下角运行按钮存在", /运行/.test(data.runButton || ""), data.runButton);

  const K = "快捷键不与原生冲突";
  const combos = data.keybindings || [];
  check(K, "没有和 ComfyUI 核心快捷键撞车", (data.keybindingConflicts || []).length === 0,
    (data.keybindingConflicts || []).join(" | ") || combos.join(", "));
  check(K, "不抢原生 Ctrl+Enter（Comfy.QueuePrompt）",
    !combos.includes("enter+ctrl"), combos.join(", "));
  check(K, "注册了工作台自己的快捷键",
    combos.includes("b+ctrl+shift") && combos.includes(".+ctrl") && combos.includes("d+ctrl+shift"),
    combos.join(", "));

  const E = "运行期无报错";
  check(E, "无未捕获 JS 异常", (data.exceptions || []).length === 0,
    (data.exceptions || []).join(" | "));
  check(E, "无 console.error", (data.consoleErrors || []).length === 0,
    (data.consoleErrors || []).join(" | "));
  check(E, "页面自身无错误", (data.errors || []).length === 0, (data.errors || []).join(" | "));
  check(E, "简化模式已生效", data.enabled && String(data.bodyClass).includes("cw-simplified"),
    data.bodyClass);
}

function assertRun(data) {
  const S = "运行流程";
  const run = data.run || {};
  check(S, "点「运行」后新增产物", run.added >= 1, `before=${run.before} after=${run.after}`);
  check(S, "运行后画廊与预期一致", data.afterRun?.cardCount === run.after,
    `${data.afterRun?.cardCount} vs ${run.after}`);
  check(S, "执行结束队列回到空闲", (run.queueText || "").includes("空闲"), run.queueText);
  check(S, "新产物排在首位", Boolean(run.firstCard), run.firstCard);
}

function assertDeep(data) {
  const d = data.deep || {};

  const S1 = "参数双向同步";
  check(S1, "画布改参数 → 面板跟随", d.stepsAfterExternalEdit === "48",
    `改前=${d.stepsBefore} 改后=${d.stepsAfterExternalEdit}`);
  check(S1, "面板改参数 → 写回节点", d.stepsWrittenBack === 33, `节点值=${d.stepsWrittenBack}`);

  const S2 = "原生顶栏开关";
  check(S2, "隐藏后原生顶栏不可见", d.menuHidden === "none", d.menuHidden);
  check(S2, "隐藏后 --cw-menu-h 归零", d.menuVarHidden === "0px", d.menuVarHidden);
  check(S2, "隐藏后资源条上移到 y=0", d.barYHidden === 0, `y=${d.barYHidden}`);
  check(S2, "隐藏后画布上移到资源条下方 y=44", d.canvasYHidden === 44, `y=${d.canvasYHidden}`);
  check(S2, "恢复后原生顶栏可见", d.menuRestored === "flex", d.menuRestored);
  check(S2, "恢复后资源条回到 y=42", d.barYRestored === 42, `y=${d.barYRestored}`);

  const S3 = "大图预览";
  check(S3, "点击卡片打开预览", d.lightboxOpen === true, String(d.lightboxOpen));
  check(S3, "预览里是图片", d.lightboxHasImage === true, String(d.lightboxHasImage));
  check(S3, "预览显示文件名", Boolean(d.lightboxTitle), d.lightboxTitle);
  check(S3, "关闭后隐藏", d.lightboxClosed === true, String(d.lightboxClosed));

  const S4 = "主题切换";
  check(S4, "浅色主题生效", d.themeLight === "light", d.themeLight);
  check(S4, "浅色下左栏是浅背景", /rgb\(25[0-5], 25[0-5], 25[0-5]\)/.test(d.panelBgLight || ""),
    d.panelBgLight);
  check(S4, "深色下左栏是深背景", d.panelBgDark !== d.panelBgLight, d.panelBgDark);

  const S5 = "模式切换还原";
  check(S5, "关闭简化模式后侧栏恢复", d.off?.sidebarDisplay === "block", d.off?.sidebarDisplay);
  check(S5, "关闭后画布回到全屏", d.off?.canvasRect?.x === 0 && d.off?.canvasRect?.w === data.viewport?.w,
    d.off ? `x=${d.off.canvasRect?.x} w=${d.off.canvasRect?.w}` : "");
  check(S5, "关闭后左栏不再占据空间", d.off?.rootHidden === true && d.off?.leftRect?.w === 0,
    d.off ? `rootHidden=${d.off.rootHidden} 左栏宽=${d.off.leftRect?.w}` : "");
  check(S5, "关闭后摘掉 cw-canvas-host 类",
    !String(d.off?.canvasClass || "").includes("cw-canvas-host"), d.off?.canvasClass);
  check(S5, "重新开启后侧栏再次隐藏", d.on?.sidebarDisplay === "none", d.on?.sidebarDisplay);
  check(S5, "重新开启后画布回到中间", d.on?.canvasRect?.x === 348, `x=${d.on?.canvasRect?.x}`);

  const S6 = "分隔条拖动";
  check(S6, "拖动后左栏变宽到 440px", d.leftWidthAfterDrag === "440px", d.leftWidthAfterDrag);
  check(S6, "画布跟着右移", d.canvasXAfterDrag === 448, `x=${d.canvasXAfterDrag}`);

  const S7 = "画布容器选择器";
  check(S7, "默认自动命中画布容器", d.canvasSelectorDefault === "#graph-canvas-container",
    d.canvasSelectorDefault);
  check(S7, "自定义选择器立即生效", d.canvasSelectorCustom === ".graph-canvas-container",
    d.canvasSelectorCustom);
  check(S7, "写错的选择器自动回退且不崩", d.canvasSelectorBadFallback === "#graph-canvas-container" &&
    d.canvasHostAfterBad === true, `${d.canvasSelectorBadFallback} · 容器在线=${d.canvasHostAfterBad}`);
  check(S7, "清空后回到自动检测", d.canvasSelectorReset === "#graph-canvas-container",
    d.canvasSelectorReset);

  const S8 = "隐藏选择器容错";
  check(S8, "无效项不影响有效项", d.hideRuleWithBad === true, String(d.hideRuleWithBad));
  check(S8, "有效项真的生效", d.mockHintDisplay === "none", d.mockHintDisplay);
  check(S8, "原有隐藏规则仍然生效", d.sidebarDisplayWithBad === "none", d.sidebarDisplayWithBad);
  check(S8, "移除后恢复显示", d.mockHintRestored !== "none", d.mockHintRestored);

  const S10 = "原生弹层不被误伤 / 不被遮挡";
  check(S10, "设置对话框本身不被隐藏", d.dialogDisplay !== "none", d.dialogDisplay);
  check(S10, "对话框内的 sidebar 分类导航不被隐藏（回归）",
    d.dialogSidebarDisplay !== "none", d.dialogSidebarDisplay);
  check(S10, "对话框被抬到工作台之上", d.dialogZIndex === "12000" && d.dialogOnTop === true,
    `z-index=${d.dialogZIndex} onTop=${d.dialogOnTop}`);
  check(S10, "下拉菜单盖过工作台资源条", d.menuZIndex === "12000" && d.menuOnTop === true,
    `z-index=${d.menuZIndex} onTop=${d.menuOnTop}`);
  check(S10, "菜单内 queue-panel 字样的项不被隐藏（回归）",
    d.menuInnerDisplay !== "none", d.menuInnerDisplay);
  check(S10, "诊断报告能识别弹层且不误报遮挡",
    d.diagPopupCount >= 2 && d.diagPopupCovered === 0,
    `识别 ${d.diagPopupCount} 个 / 遮挡 ${d.diagPopupCovered} 个`);

  const S9 = "一键诊断";
  const diag = d.diag || {};
  check(S9, "报告带版本号", Boolean(diag.version), diag.version);
  check(S9, "报告带时间戳", diag.hasTimestamp === true, String(diag.hasTimestamp));
  check(S9, "报告识别到画布容器", diag.canvasFound === true && Boolean(diag.canvasSelector),
    `${diag.canvasSelector}`);
  check(S9, "报告识别到原生顶栏", diag.menuFound === true && diag.menuHeight === 42,
    `height=${diag.menuHeight}`);
  check(S9, "报告列出隐藏规则命中情况", diag.hiddenRules > 0 && diag.hiddenMatched >= 1,
    `规则 ${diag.hiddenRules} 条 / 命中 ${diag.hiddenMatched} 条`);
  check(S9, "报告统计参数提取结果",
    diag.paramsNodes > 0 && diag.paramsFields > 0 && diag.paramsPositive >= 1 && diag.paramsNegative >= 1,
    `节点 ${diag.paramsNodes} / 字段 ${diag.paramsFields} / 正 ${diag.paramsPositive} 负 ${diag.paramsNegative}`);
  check(S9, "报告统计输出卡片", diag.outputCards > 0, String(diag.outputCards));
  check(S9, "报告探测后端接口", diag.backendPing === true && diag.backendStats === true,
    `ping=${diag.backendPing} stats=${diag.backendStats}`);
  check(S9, "报告确认 ComfyUI 就绪", diag.comfyApp === true, String(diag.comfyApp));
  check(S9, "报告带布局变量", Boolean(diag.leftVar), diag.leftVar);
  check(S9, "诊断面板可打开且有内容", d.diagPanelOpen === true && d.diagTextLength > 200 &&
    d.diagTextHasCanvas === true && d.diagTextHasPopups === true,
    `open=${d.diagPanelOpen} 文本长度=${d.diagTextLength}`);
  check(S9, "诊断面板可关闭", d.diagPanelClosed === true, String(d.diagPanelClosed));
  check(S9, "可再次打开并用 Esc 关闭",
    d.diagReopened === true && d.diagEscClosed === true,
    `reopen=${d.diagReopened} esc=${d.diagEscClosed}`);

  const S11 = "逃生出口（回原生界面）";
  check(S11, "顶栏有「原生界面」按钮且可见",
    d.exitButtonExists === true && d.exitButtonVisible === true,
    `存在=${d.exitButtonExists} 可见=${d.exitButtonVisible}`);
  check(S11, "点一下就真的退出简化模式",
    d.exitLeavesSimplified === true && d.exitButtonGone === true,
    `退出=${d.exitLeavesSimplified} 按钮消失=${d.exitButtonGone}`);
  check(S11, "还能再回到工作台", d.exitBackToWorkbench === true, String(d.exitBackToWorkbench));

  const S12 = "启动布局自检";
  check(S12, "布局正常时不误报", d.selfCheckHealthy === true, String(d.selfCheckHealthy));
  check(S12, "原生顶栏找不到时能报出来", d.selfCheckBroken === true, String(d.selfCheckBroken));

  const E = "深度检查无报错";
  check(E, "深度流程无未捕获异常", (data.deepExceptions || []).length === 0,
    (data.deepExceptions || []).join(" | "));
  check(E, "深度流程无 console.error", (data.deepConsoleErrors || []).length === 0,
    (data.deepConsoleErrors || []).join(" | "));
}

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

  const reportData = await cdp.evaluate(LAYOUT_EXPRESSION);
  reportData.consoleErrors = cdp.consoleErrors;
  reportData.exceptions = cdp.exceptions;

  if (wantRun) {
    reportData.run = await cdp.evaluate(RUN_EXPRESSION);
    await sleep(400);
    reportData.afterRun = await cdp.evaluate(LAYOUT_EXPRESSION);
  }

  if (wantDeep) {
    reportData.deep = await cdp.evaluate(DEEP_EXPRESSION);
    reportData.deepConsoleErrors = cdp.consoleErrors;
    reportData.deepExceptions = cdp.exceptions;
  }

  if (wantJson) console.log(JSON.stringify(reportData, null, 2));

  assertLayout(reportData);
  if (wantRun) assertRun(reportData);
  if (wantDeep) assertDeep(reportData);

  const failed = report();
  if (failed > 0) process.exitCode = 1;
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
