/**
 * 通用 UI 工具：DOM 构建、图标、提示条、格式化。
 * 保持零依赖，方便在预览页里复用。
 */

/** 与 __init__.py / pyproject.toml 保持一致 */
export const VERSION = "1.0.0";

/** 创建元素：el("div", { class: "x", on: { click: fn } }, child, ...) */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined) continue;
    switch (key) {
      case "class":
      case "className":
        node.className = Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value);
        break;
      case "text":
        node.textContent = String(value);
        break;
      case "html":
        node.innerHTML = String(value);
        break;
      case "style":
        if (typeof value === "string") node.style.cssText = value;
        else Object.assign(node.style, value);
        break;
      case "dataset":
        Object.assign(node.dataset, value);
        break;
      case "on":
        for (const [event, handler] of Object.entries(value)) {
          if (typeof handler === "function") node.addEventListener(event, handler);
        }
        break;
      case "attrs":
        for (const [attr, attrValue] of Object.entries(value)) {
          if (attrValue === null || attrValue === undefined || attrValue === false) continue;
          node.setAttribute(attr, attrValue === true ? "" : String(attrValue));
        }
        break;
      default:
        if (key in node && typeof value !== "object") node[key] = value;
        else node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ------------------------------------------------------------------ 图标 */
const ICON_PATHS = {
  play: "M8 5v14l11-7z",
  stop: "M6 6h12v12H6z",
  refresh:
    "M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
  star: "M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z",
  starOutline:
    "M22 9.24l-7.19-.62L12 2 9.19 8.62 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z",
  download: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
  folder:
    "M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z",
  close:
    "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  image:
    "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z",
  video:
    "M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z",
  audio:
    "M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zm-2 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z",
  cpu: "M22 9V7h-2V5c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-2h2v-2h-2v-2h2v-2h-2V9h2zm-4 10H4V5h14v14zM6 13h5v4H6zm6-6h4v3h-4zM6 7h5v5H6zm6 4h4v6h-4z",
  memory:
    "M15 9H9v6h6V9zm-2 4h-2v-2h2v2zm8-2V9h-2V7c0-1.1-.9-2-2-2h-2V3h-2v2h-2V3H9v2H7c-1.1 0-2 .9-2 2v2H3v2h2v2H3v2h2v2c0 1.1.9 2 2 2h2v2h2v-2h2v2h2v-2h2c1.1 0 2-.9 2-2v-2h2v-2h-2v-2h2zm-4 6H7V7h10v10z",
  gpu: "M4 6h16v12H4V6zm2 2v8h12V8H6zm2 2h4v4H8v-4z",
  queue: "M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z",
  settings:
    "M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z",
  save: "M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  warn: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
  chevronRight: "M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z",
  chevronDown: "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z",
  dice: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3 3a1.6 1.6 0 1 0 0 3.2A1.6 1.6 0 0 0 8 6zm8 0a1.6 1.6 0 1 0 0 3.2A1.6 1.6 0 0 0 16 6zm-8 8.8a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zm8 0a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zM12 12a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z",
  expand:
    "M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z",
  trash:
    "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  grid: "M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z",
  text: "M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z",
  panelLeft: "M3 5h18v14H3V5zm2 2v10h4V7H5zm6 0v10h8V7h-8z",
  bug: "M20 8h-2.81a5.985 5.985 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63A5.985 5.985 0 0 0 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81a6 6 0 0 0 10.38 0H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z",
  copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
  fit: "M9 3H3v6h2V5h4V3zm12 0h-6v2h4v4h2V3zM3 15v6h6v-2H5v-4H3zm16 0v4h-4v2h6v-6h-2z",
};

export function icon(name, size = 16) {
  const path = ICON_PATHS[name] || ICON_PATHS.grid;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
}

export function iconEl(name, size = 16, className = "cw-ico") {
  const span = el("span", { class: className });
  span.innerHTML = icon(name, size);
  return span;
}

/** 带图标的按钮 */
export function button(label, { iconName, title, className = "", onClick, iconOnly = false } = {}) {
  return el(
    "button",
    {
      class: ["cw-btn", className, iconOnly ? "cw-btn-icon" : ""],
      type: "button",
      title: title || label || "",
      on: onClick ? { click: onClick } : {},
    },
    iconName ? iconEl(iconName, 15) : null,
    label ? el("span", { class: "cw-btn-label", text: label }) : null
  );
}

/* ------------------------------------------------------------------ 右键菜单 */
let ctxMenu = null;
let ctxCleanup = null;

export function closeContextMenu() {
  if (ctxCleanup) {
    ctxCleanup();
    ctxCleanup = null;
  }
  if (ctxMenu) {
    ctxMenu.remove();
    ctxMenu = null;
  }
}

/**
 * 简易右键菜单。
 * items: [{ label, iconName, danger, disabled, onSelect } | { separator: true }]
 * 返回菜单节点，方便自检脚本断言。
 */
export function openContextMenu(event, items = []) {
  closeContextMenu();
  const menu = el("div", { class: "cw-ctxmenu", id: "cw-ctxmenu", role: "menu" });

  for (const item of items) {
    if (item.separator) {
      menu.append(el("div", { class: "cw-ctxsep" }));
      continue;
    }
    const node = el(
      "button",
      {
        class: ["cw-ctxitem", item.danger ? "cw-ctxitem-danger" : "", item.disabled ? "cw-ctxitem-off" : ""],
        type: "button",
        attrs: { role: "menuitem", disabled: item.disabled ? true : null },
        on: {
          click: () => {
            if (item.disabled) return;
            closeContextMenu();
            item.onSelect?.();
          },
        },
      },
      item.iconName ? iconEl(item.iconName, 14) : null,
      el("span", { class: "cw-ctxlabel", text: item.label })
    );
    menu.append(node);
  }

  document.body.append(menu);

  // 先插入再量尺寸，保证不跑出视口
  const pad = 8;
  const maxX = window.innerWidth - menu.offsetWidth - pad;
  const maxY = window.innerHeight - menu.offsetHeight - pad;
  menu.style.left = `${Math.max(pad, Math.min(event.clientX, maxX))}px`;
  menu.style.top = `${Math.max(pad, Math.min(event.clientY, maxY))}px`;

  const onPointerDown = (pointerEvent) => {
    if (!menu.contains(pointerEvent.target)) closeContextMenu();
  };
  const onKey = (keyEvent) => {
    if (keyEvent.key === "Escape") closeContextMenu();
  };
  const onViewport = () => closeContextMenu();

  // 当前这次 contextmenu 事件之后才挂监听，否则会立刻关掉自己
  setTimeout(() => {
    if (ctxMenu !== menu) return;
    document.addEventListener("pointerdown", onPointerDown, true);
  }, 0);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onViewport);
  window.addEventListener("blur", onViewport);

  ctxMenu = menu;
  ctxCleanup = () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onViewport);
    window.removeEventListener("blur", onViewport);
  };
  return menu;
}

/* ------------------------------------------------------------------ 确认框 */
/**
 * 替代 window.confirm：不阻塞主线程、样式统一、可被自检脚本点击。
 * 返回 Promise<boolean>。
 */
export function confirmDialog({
  title = "确认",
  message = "",
  confirmText = "确定",
  cancelText = "取消",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "cw-confirm-overlay", id: "cw-confirm" });
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(value);
    };

    const onKey = (event) => {
      if (event.key === "Escape") finish(false);
      else if (event.key === "Enter") finish(true);
    };

    const confirmButton = el("button", {
      class: ["cw-btn", danger ? "cw-btn-danger" : "cw-btn-primary"],
      type: "button",
      id: "cw-confirm-ok",
      text: confirmText,
      on: { click: () => finish(true) },
    });
    const cancelButton = el("button", {
      class: "cw-btn",
      type: "button",
      id: "cw-confirm-cancel",
      text: cancelText,
      on: { click: () => finish(false) },
    });

    // 遮罩必须先插入：两个都是定位元素且 z-index 相同，DOM 靠后的会盖住靠前的，
    // 遮罩后插入就会把弹窗盖住并吃掉点击（曾经的真实 bug）
    overlay.append(
      el("div", { class: "cw-confirm-backdrop", on: { click: () => finish(false) } }),
      el(
        "div",
        { class: "cw-confirm", on: { click: (event) => event.stopPropagation() } },
        el("div", { class: "cw-confirm-title", text: title }),
        message ? el("div", { class: "cw-confirm-msg", text: message }) : null,
        el("div", { class: "cw-confirm-actions" }, cancelButton, confirmButton)
      )
    );

    document.body.append(overlay);
    window.addEventListener("keydown", onKey);
    requestAnimationFrame(() => confirmButton.focus());
  });
}

/* ------------------------------------------------------------------ 提示条 */
let toastHost = null;

export function toast(message, kind = "info", timeout = 2800) {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = el("div", { class: "cw-toasts", id: "cw-toasts" });
    document.body.append(toastHost);
  }
  const node = el(
    "div",
    { class: ["cw-toast", `cw-toast-${kind}`] },
    iconEl(kind === "error" ? "warn" : kind === "success" ? "check" : "grid", 15),
    el("span", { text: message })
  );
  toastHost.append(node);
  requestAnimationFrame(() => node.classList.add("cw-in"));
  const dismiss = () => {
    node.classList.remove("cw-in");
    setTimeout(() => node.remove(), 220);
  };
  const timer = setTimeout(dismiss, timeout);
  node.addEventListener("click", () => {
    clearTimeout(timer);
    dismiss();
  });
  return dismiss;
}

/* ------------------------------------------------------------------ 格式化 */
export function fmtBytes(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return "—";
  if (num < 1024) return `${num} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let index = -1;
  let rest = num;
  while (rest >= 1024 && index < units.length - 1) {
    rest /= 1024;
    index += 1;
  }
  return `${rest.toFixed(rest >= 100 ? 0 : digits)} ${units[index]}`;
}

export function fmtPercent(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return `${num.toFixed(digits)}%`;
}

/**
 * 把显卡/设备全名压成简短型号，用来塞进顶部资源条。
 *   "NVIDIA GeForce RTX 4090"        → "RTX 4090"
 *   "AMD Radeon RX 7900 XTX"         → "RX 7900 XTX"
 *   "Apple M2 Max (38 核 GPU)"       → "M2 Max"
 *   "Intel(R) Arc(TM) A770 Graphics" → "Arc A770"
 *   "NVIDIA A100-SXM4-40GB"          → "A100"
 */
export function shortDeviceName(raw, maxLength = 14) {
  const original = String(raw || "").trim();
  if (!original) return "";

  let name = original
    .replace(/\([^)]*\)/g, " ") // 括号里的补充说明（核心数 / 显存等）
    .replace(/\[[^\]]*\]/g, " ")
    .replace(
      /\b(NVIDIA|GeForce|AMD|Radeon|Intel|Apple|Tesla|Quadro|Corporation|Graphics|GPU|SXM\d*)\b/gi,
      " "
    )
    .replace(/\b\d+\s*GB\b/gi, " ")
    .replace(/\b\d+\s*MB\b/gi, " ")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) name = original;
  if (name.length > maxLength) name = `${name.slice(0, Math.max(1, maxLength - 1))}…`;
  return name;
}

export function fmtTime(seconds) {
  if (!Number.isFinite(Number(seconds))) return "—";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function fmtAgo(mtime) {
  if (!mtime) return "";
  const diff = Math.max(0, Date.now() / 1000 - mtime);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(mtime * 1000).toLocaleDateString();
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function debounce(fn, wait = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let pending = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(pending);
      pending = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, wait - (now - last));
    }
  };
}

/** 按阈值返回颜色 */
export function levelColor(percent) {
  if (percent === null || percent === undefined || !Number.isFinite(Number(percent))) return "var(--cw-muted)";
  const value = Number(percent);
  if (value >= 90) return "var(--cw-danger)";
  if (value >= 75) return "var(--cw-warn)";
  return "var(--cw-accent)";
}
