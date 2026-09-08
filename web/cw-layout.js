/**
 * 三栏布局：顶部资源条 / 左侧参数栏 / 中间原生画布 / 右侧输出栏。
 *
 * 实现思路（重要）：
 *   不移动 ComfyUI 的任何 DOM 节点，只给画布容器加一个类，用 CSS 的
 *   `position: fixed` + `inset` 把它「挤」到中间区域。
 *   这样避免和 Vue 的虚拟 DOM 打架，前端升级也不容易崩。
 *   所有尺寸通过 CSS 变量下发：
 *     --cw-menu-h  原生顶栏高度（自动测量）
 *     --cw-bar-h   本插件资源条高度
 *     --cw-top     = menu + bar
 *     --cw-left-w / --cw-right-w  左右栏宽度
 */

import { el, clamp, debounce } from "./cw-ui.js";
import { store, KEYS, setting } from "./cw-store.js";
import { resizeCanvas } from "./cw-comfy.js";

const CANVAS_SELECTORS = [
  "#graph-canvas-container",
  ".graph-canvas-container",
  ".graph-canvas-wrapper",
  "#graph-canvas",
  "canvas#graph-canvas",
  ".litegraph.litegraph-canvas",
];

/** 用户填的选择器可能写错，这里统一校验，避免一个笔误让整个样式失效 */
export function isValidSelector(selector) {
  const text = String(selector || "").trim();
  if (!text) return false;
  try {
    document.querySelector(text);
    return true;
  } catch (error) {
    return false;
  }
}

const MENU_SELECTORS = [
  ".comfyui-menu",
  ".comfy-menu",
  "#comfyui-menu",
  ".comfyui-topbar",
  "header.comfyui-menu",
];

/** 简化模式默认隐藏的原生元素（侧边栏 / 底部队列等），用户可在设置里改 */
export const DEFAULT_HIDE_SELECTORS = [
  ".side-bar-panel",
  ".sidebar-container",
  ".comfyui-sidebar",
  ".side-toolbar-container",
  ".bottom-panel",
  ".comfyui-body-bottom",
  ".comfy-queue",
  "#queue",
  ".queue-panel",
  "#comfyui-queue-panel",
];

/**
 * 兜底规则：不同前端版本类名会变，用属性选择器按关键字命中，
 * 这样即使 ComfyUI 升级换了类名，侧边栏/底部面板也不会挡住工作台。
 * 怕误伤可以在设置里关掉「自动隐藏疑似原生侧栏/面板」。
 */
export const BROAD_HIDE_SELECTORS = [
  '[class*="side-bar" i]',
  '[class*="sidebar" i]',
  '[id*="side-bar" i]',
  '[id*="sidebar" i]',
  '[class*="bottom-panel" i]',
  '[class*="queue-panel" i]',
  '[class*="queue-tab" i]',
];

export const DEFAULT_HIDE_MENU_SELECTORS = [".comfyui-menu", ".comfy-menu", ".comfyui-topbar"];

/**
 * 弹层豁免名单：隐藏规则**绝对不能**碰对话框 / 下拉菜单 / 右键菜单内部。
 *
 * 因为宽泛规则用的是「class 里含 sidebar / queue-panel 就隐藏」，而 ComfyUI 的设置
 * 对话框里本身就有带 sidebar 字样的分类导航；不豁免的话，点开设置会看到空白或
 * 完全没反应（整个弹层被 display:none 掉）。
 */
export const DIALOG_EXEMPT_SELECTORS = [
  '[role="dialog"]',
  '[role="dialog"] *',
  '[aria-modal="true"]',
  '[aria-modal="true"] *',
  '[role="menu"]',
  '[role="menu"] *',
  '[role="listbox"]',
  '[role="listbox"] *',
  ".p-dialog",
  ".p-dialog *",
  ".p-connected-overlay",
  ".p-connected-overlay *",
  ".p-contextmenu",
  ".p-contextmenu *",
  ".comfy-modal",
  ".comfy-modal *",
  ".litegraph.litecontextmenu",
  ".litegraph.litecontextmenu *",
  ".litegraph.litedialog",
  ".litegraph.litedialog *",
  "#cw-root",
  "#cw-root *",
];

export class Layout {
  constructor() {
    this.root = null;
    this.refs = {};
    this.canvasHost = null;
    this.canvasHostSelector = null;
    this.enabled = false;
    this.leftWidth = clamp(Number(store.get(KEYS.leftWidth, 340)) || 340, 240, 720);
    this.rightWidth = clamp(Number(store.get(KEYS.rightWidth, 400)) || 400, 260, 900);
    this.hideNative = setting(KEYS.hideNative, true) !== false;
    this.hideNativeMenu = store.get(KEYS.hideNativeMenu, false) === true;
    this.canvasSelector = String(setting(KEYS.canvasSelector, "") || "").trim();
    this._measureTimers = [];
  }

  build() {
    const topbar = el("header", { class: "cw-bar", id: "cw-bar" });
    const left = el("aside", { class: "cw-panel cw-left", id: "cw-left" });
    const right = el("aside", { class: "cw-panel cw-right", id: "cw-right" });

    const leftHead = el("div", { class: "cw-panel-head" });
    const leftBody = el("div", { class: "cw-panel-body", id: "cw-left-body" });
    const leftFoot = el("div", { class: "cw-panel-foot", id: "cw-left-foot" });

    const rightHead = el("div", { class: "cw-panel-head" });
    const rightBody = el("div", { class: "cw-panel-body cw-gallery-body", id: "cw-right-body" });
    const rightFoot = el("div", { class: "cw-panel-foot", id: "cw-right-foot" });

    left.append(leftHead, leftBody, leftFoot);
    right.append(rightHead, rightBody, rightFoot);

    const leftSplit = el("div", {
      class: "cw-split cw-split-left",
      title: "拖动调整宽度，双击复位",
    });
    const rightSplit = el("div", {
      class: "cw-split cw-split-right",
      title: "拖动调整宽度，双击复位",
    });

    this.root = el(
      "div",
      { id: "cw-root", class: "cw-root cw-hidden" },
      topbar,
      left,
      right,
      leftSplit,
      rightSplit
    );
    document.body.append(this.root);

    this.refs = {
      topbar,
      left,
      right,
      leftHead,
      leftBody,
      leftFoot,
      rightHead,
      rightBody,
      rightFoot,
      leftSplit,
      rightSplit,
    };

    this.bindSplitter(leftSplit, "left");
    this.bindSplitter(rightSplit, "right");
    this.applyWidths();
    this.installHideStyle();
    this.watchMenu();

    window.addEventListener(
      "resize",
      debounce(() => this.onViewportChange(), 120)
    );

    return this.refs;
  }

  /* ------------------------------------------------------------ 开关 */
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    document.body.classList.toggle("cw-simplified", this.enabled);
    this.root.classList.toggle("cw-hidden", !this.enabled);
    if (this.enabled) {
      this.ensureCanvasHost();
      this.measureMenu();
      this.onViewportChange();
    } else {
      this.releaseCanvasHost();
      resizeCanvas();
    }
  }

  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  /* ------------------------------------------------------------ 画布定位 */
  /** 优先用用户自定义选择器，然后才是内置的候选列表 */
  canvasSelectors() {
    const custom = this.canvasSelector;
    return custom ? [custom, ...CANVAS_SELECTORS] : [...CANVAS_SELECTORS];
  }

  ensureCanvasHost() {
    if (this.canvasHost && this.canvasHost.isConnected) return this.canvasHost;
    let target = null;
    let matched = null;
    for (const selector of this.canvasSelectors()) {
      let found = null;
      try {
        found = document.querySelector(selector);
      } catch (error) {
        // 用户自定义选择器写错时不至于让整个工作台挂掉
        console.warn(`[ComfUI Workbench] 画布选择器无效，已跳过：${selector}`);
        continue;
      }
      if (!found) continue;
      target = found.tagName === "CANVAS" ? found.parentElement : found;
      if (target) {
        matched = selector;
        break;
      }
    }
    if (!target) {
      this.canvasHostSelector = null;
      return null;
    }
    if (this.canvasHost && this.canvasHost !== target) {
      this.canvasHost.classList.remove("cw-canvas-host");
    }
    this.canvasHost = target;
    this.canvasHostSelector = matched;
    this.canvasHost.classList.add("cw-canvas-host");
    return target;
  }

  releaseCanvasHost() {
    if (this.canvasHost) this.canvasHost.classList.remove("cw-canvas-host");
    this.canvasHost = null;
    this.canvasHostSelector = null;
  }

  /** 设置里改动「画布容器选择器」时立即生效 */
  setCanvasSelector(selector) {
    this.canvasSelector = String(selector || "").trim();
    this.releaseCanvasHost();
    this.ensureCanvasHost();
    this.onViewportChange();
    return this.canvasHostSelector;
  }

  onViewportChange() {
    if (!this.enabled) return;
    this.ensureCanvasHost();
    resizeCanvas();
  }

  /* ------------------------------------------------------------ 原生顶栏高度 */
  findMenu() {
    for (const selector of MENU_SELECTORS) {
      const found = document.querySelector(selector);
      if (found) {
        this.menuSelector = selector;
        return found;
      }
    }
    this.menuSelector = null;
    return null;
  }

  measureMenu() {
    if (!this.enabled) return;
    this.ensureMenuObserver();
    const menu = this.findMenu();
    let height = 0;
    if (menu && !this.hideNativeMenu) {
      const rect = menu.getBoundingClientRect();
      if (rect.height > 0 && rect.width > 0) height = Math.round(rect.bottom);
    }
    document.documentElement.style.setProperty("--cw-menu-h", `${height}px`);
  }

  watchMenu() {
    // 前端挂载是异步的，前几秒多测几次
    for (const delay of [120, 400, 900, 1800, 3200]) {
      this._measureTimers.push(setTimeout(() => this.measureMenu(), delay));
    }
    // 有些环境下原生界面挂载很慢，用一个自清理的轮询兜底（找到就停）
    let tries = 0;
    const poll = setInterval(() => {
      tries += 1;
      this.measureMenu();
      if (this.findMenu() || tries > 30) clearInterval(poll);
    }, 1000);
    this._measureTimers.push(poll);
    this.ensureMenuObserver();
  }

  /** 原生顶栏可能比插件晚挂载，所以每次测量都顺手补一次尺寸观察 */
  ensureMenuObserver() {
    const menu = this.findMenu();
    if (!menu || menu === this._menuNode) return;
    if (typeof ResizeObserver !== "function") return;
    try {
      this._menuObserver?.disconnect?.();
      this._menuObserver = new ResizeObserver(() => this.measureMenu());
      this._menuObserver.observe(menu);
      this._menuNode = menu;
    } catch (error) {
      /* 忽略：观察失败不影响布局 */
    }
  }

  /* ------------------------------------------------------------ 宽度 */
  applyWidths() {
    document.documentElement.style.setProperty("--cw-left-w", `${Math.round(this.leftWidth)}px`);
    document.documentElement.style.setProperty("--cw-right-w", `${Math.round(this.rightWidth)}px`);
  }

  setWidths(left, right) {
    if (Number.isFinite(left)) this.leftWidth = clamp(left, 240, 720);
    if (Number.isFinite(right)) this.rightWidth = clamp(right, 260, 900);
    this.applyWidths();
    this.onViewportChange();
  }

  bindSplitter(handle, side) {
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const move = (event) => {
      if (!dragging) return;
      const clientX = event.touches ? event.touches[0].clientX : event.clientX;
      const delta = clientX - startX;
      if (side === "left") this.setWidths(startWidth + delta, null);
      else this.setWidths(null, startWidth - delta);
      event.preventDefault();
    };

    const stop = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("cw-resizing");
      store.set(side === "left" ? KEYS.leftWidth : KEYS.rightWidth, Math.round(
        side === "left" ? this.leftWidth : this.rightWidth
      ));
    };

    handle.addEventListener("pointerdown", (event) => {
      if (!this.enabled) return;
      dragging = true;
      startX = event.clientX;
      startWidth = side === "left" ? this.leftWidth : this.rightWidth;
      document.body.classList.add("cw-resizing");
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("dblclick", () => {
      this.setWidths(side === "left" ? 340 : null, side === "right" ? 400 : null);
      store.set(side === "left" ? KEYS.leftWidth : KEYS.rightWidth, side === "left" ? 340 : 400);
    });
  }

  /* ------------------------------------------------------------ 隐藏原生元素 */
  hideSelectors() {
    const custom = setting(KEYS.hideSelectors, "");
    const extra = String(custom || "")
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((selector) => {
        // 一个写错的选择器会让整条 :is(...) 规则失效，所以先逐个校验
        const ok = isValidSelector(selector);
        if (!ok) console.warn(`[ComfUI Workbench] 忽略无效的隐藏选择器：${selector}`);
        return ok;
      });
    const list = [...DEFAULT_HIDE_SELECTORS, ...extra];
    if (setting(KEYS.broadHide, true) !== false) list.push(...BROAD_HIDE_SELECTORS);
    if (this.hideNativeMenu) list.push(...DEFAULT_HIDE_MENU_SELECTORS);
    return list;
  }

  installHideStyle() {
    let style = document.getElementById("cw-hide-style");
    if (!style) {
      style = el("style", { id: "cw-hide-style" });
      document.head.append(style);
    }
    const selectors = this.hideNative ? this.hideSelectors() : [];
    style.textContent = selectors.length
      ? `body.cw-simplified :is(${selectors.join(", ")}):not(${DIALOG_EXEMPT_SELECTORS.join(
          ", "
        )}) { display: none !important; }`
      : "";
  }

  setHideNative(value) {
    this.hideNative = Boolean(value);
    this.installHideStyle();
    this.measureMenu();
  }

  setHideNativeMenu(value) {
    this.hideNativeMenu = Boolean(value);
    store.set(KEYS.hideNativeMenu, this.hideNativeMenu);
    this.installHideStyle();
    setTimeout(() => {
      this.measureMenu();
      this.onViewportChange();
    }, 60);
  }

  /* ------------------------------------------------------------ 主题 */
  applyTheme(theme) {
    const resolved =
      theme === "auto" ? (isLightNativeTheme() ? "light" : "dark") : theme === "light" ? "light" : "dark";
    // 变量要挂在 <html> 上，才能作用到画布容器（它不在 #cw-root 里面）
    document.documentElement.dataset.cwTheme = resolved;
    if (this.root) this.root.dataset.cwTheme = resolved;
    return resolved;
  }
}

function isLightNativeTheme() {
  try {
    const body = getComputedStyle(document.body);
    const color = body.backgroundColor || "";
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) return false;
    const [r, g, b] = match[1].split(",").map((value) => parseFloat(value));
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5;
  } catch (error) {
    return false;
  }
}
