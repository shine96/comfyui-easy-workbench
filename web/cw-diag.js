/**
 * 一键诊断：把「插件到底认没认出来你的 ComfyUI 界面」摊成一份可复制的报告。
 *
 * 真实 ComfyUI 的 DOM 类名会随版本变化，而这个插件是「不改 DOM、只加类名」的方案，
 * 所以出问题时需要知道四件事：
 *   1. 画布容器有没有被接管 —— 没接管就去设置里填「画布容器选择器」
 *   2. 哪些隐藏规则真的命中了 —— 误伤就关掉「自动隐藏疑似原生侧栏 / 面板」
 *   3. 参数面板提取到多少节点 / 参数 —— 太少说明节点不是标准 widget
 *   4. 后端接口是否可用 —— 不可用时资源条会退化为 /system_stats
 */

import { el, clear, button, toast, iconEl, VERSION } from "./cw-ui.js";
import { setting, KEYS } from "./cw-store.js";
import { fetchStats, getAppSync, getNodes, getWorkflowName, cwJson } from "./cw-comfy.js";

const NAMESPACE = "/comfui-workbench";

/* ------------------------------------------------------------------ 采集 */
function rectOf(node) {
  if (!node) return null;
  const box = node.getBoundingClientRect();
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    w: Math.round(box.width),
    h: Math.round(box.height),
  };
}

function describeNode(node) {
  if (!node) return null;
  return {
    tag: node.tagName.toLowerCase(),
    id: node.id || "",
    className: typeof node.className === "string" ? node.className : "",
  };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function frontendVersion(app) {
  const candidates = [
    globalThis.__COMFYUI_FRONTEND_VERSION__,
    globalThis.comfyAPI?.app?.app?.frontendVersion,
    app?.frontendVersion,
    app?.ui?.settings?.getSettingValue?.("Comfy.Version"),
    app?.ui?.settings?.getSettingValue?.("Comfy.InstalledVersion"),
  ];
  const found = candidates.find((value) => typeof value === "string" && value.trim());
  return found ? String(found).trim() : "";
}

function countDom(selector) {
  try {
    return document.querySelectorAll(selector).length;
  } catch (error) {
    return -1;
  }
}

/* 原生弹层（对话框 / 下拉菜单）：用来判断它们有没有被工作台面板挡住 */
const POPUP_SELECTOR =
  '[role="dialog"], .p-dialog, .comfy-modal, [role="menu"], .p-contextmenu, .litegraph.litecontextmenu';

/** 用 elementFromPoint 判断弹层中心点是否真的点在弹层上（比算 z-index 更准） */
function isOnTop(node, box) {
  if (!box.width || !box.height) return true;
  const x = Math.min(window.innerWidth - 1, Math.max(1, box.left + box.width / 2));
  const y = Math.min(window.innerHeight - 1, Math.max(1, box.top + Math.min(box.height / 2, 40)));
  try {
    const hit = document.elementFromPoint(x, y);
    return !hit || node.contains(hit) || hit.contains(node);
  } catch (error) {
    return true;
  }
}

function collectPopups() {
  let nodes = [];
  try {
    nodes = [...document.querySelectorAll(POPUP_SELECTOR)];
  } catch (error) {
    nodes = [];
  }
  return nodes.map((node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    const visible = style.display !== "none" && style.visibility !== "hidden";
    return {
      ...describeNode(node),
      display: style.display,
      zIndex: style.zIndex,
      visible,
      rect: {
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.round(box.width),
        h: Math.round(box.height),
      },
      covered: visible && !isOnTop(node, box),
    };
  });
}

/**
 * 采集一份诊断快照。
 * 只读，不会改动任何界面状态，可以在任何时候调用。
 */
export async function collectDiagnostics(workbench) {
  const layout = workbench?.layout;
  const app = getAppSync();
  const nodes = getNodes();

  const report = {
    plugin: { name: "ComfUI Workbench", version: VERSION },
    generatedAt: new Date().toISOString(),
    page: {
      url: location.href,
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      userAgent: navigator.userAgent,
    },
    mode: {
      enabled: Boolean(workbench?.enabled),
      themeSetting: setting(KEYS.theme, "auto"),
      themeApplied: document.documentElement.dataset.cwTheme || "",
      bodyClass: document.body.className,
      rootZIndex: getComputedStyle(document.getElementById("cw-root") || document.body).zIndex,
    },
    menu: { selector: null, found: false, height: 0, hiddenByUser: Boolean(layout?.hideNativeMenu), node: null },
    canvas: {
      found: Boolean(layout?.canvasHost),
      selector: layout?.canvasHostSelector || null,
      customSelector: layout?.canvasSelector || "",
      connected: Boolean(layout?.canvasHost?.isConnected),
      node: describeNode(layout?.canvasHost),
      rect: rectOf(layout?.canvasHost),
    },
    cssVars: {
      "--cw-menu-h": cssVar("--cw-menu-h"),
      "--cw-top": cssVar("--cw-top"),
      "--cw-left-w": cssVar("--cw-left-w"),
      "--cw-right-w": cssVar("--cw-right-w"),
    },
    hidden: { rules: 0, matched: [] },
    params: {
      nodes: nodes.length,
      widgets: nodes.reduce((sum, node) => sum + (node?.widgets?.length || 0), 0),
      groups: countDom("#cw-left-body .cw-group"),
      fields: countDom("#cw-left-body .cw-field"),
      positive: countDom("#cw-left-body .cw-badge-pos"),
      negative: countDom("#cw-left-body .cw-badge-neg"),
      onlyStars: Boolean(workbench?.params?.onlyStars),
    },
    output: {
      cards: countDom(".cw-card"),
      directory: document.querySelector(".cw-dir")?.textContent?.trim() || "",
    },
    popups: collectPopups(),
    backend: { ping: false, stats: false, degraded: false, error: "" },
    comfy: {
      app: Boolean(app),
      workflowName: getWorkflowName() || "",
      frontendVersion: frontendVersion(app),
    },
  };

  /* 原生顶栏 */
  if (layout) {
    const menu = layout.findMenu?.();
    report.menu.selector = layout.menuSelector || null;
    report.menu.found = Boolean(menu);
    if (menu) {
      const box = menu.getBoundingClientRect();
      report.menu.height = Math.round(box.height);
      report.menu.node = describeNode(menu);
    }
    /* 隐藏规则命中情况 */
    let selectors = [];
    try {
      selectors = layout.hideSelectors?.() || [];
    } catch (error) {
      selectors = [];
    }
    report.hidden.rules = selectors.length;
    for (const selector of selectors) {
      const count = countDom(selector);
      if (count > 0) report.hidden.matched.push({ selector, count });
    }
  }

  /* 后端接口 */
  try {
    const ping = await cwJson(`${NAMESPACE}/ping`);
    report.backend.ping = Boolean(ping?.ok);
  } catch (error) {
    report.backend.error = String(error?.message || error).slice(0, 200);
  }
  try {
    const stats = await fetchStats();
    report.backend.stats = Boolean(stats);
    report.backend.degraded = Boolean(stats?.degraded);
    report.backend.comfy = stats?.comfy || null;
  } catch (error) {
    if (!report.backend.error) report.backend.error = String(error?.message || error).slice(0, 200);
  }

  return report;
}

/* ------------------------------------------------------------------ 文本 */
function line(label, value) {
  return `${label}：${value}`;
}

/** 把报告转成人类可读、可直接粘贴到 issue 的纯文本 */
export function formatDiagnostics(report) {
  const out = [];
  out.push(`ComfUI Workbench 诊断报告 v${report.plugin.version}`);
  out.push(line("生成时间", report.generatedAt));
  out.push(line("页面", `${report.page.url}（${report.page.viewport}）`));
  out.push("");
  out.push(line("简化模式", report.mode.enabled ? "开" : "关"));
  out.push(line("主题", `${report.mode.themeApplied || "—"}（设置 ${report.mode.themeSetting}）`));
  out.push(
    line(
      "原生顶栏",
      report.menu.found
        ? `已找到（${report.menu.selector}）· 高度 ${report.menu.height}px · --cw-menu-h=${report.cssVars["--cw-menu-h"]}`
        : "未找到"
    )
  );
  out.push(
    line(
      "画布容器",
      report.canvas.found
        ? `已接管 · 选择器 ${report.canvas.selector} · ${
            report.canvas.node ? `${report.canvas.node.tag}${report.canvas.node.id ? `#${report.canvas.node.id}` : ""}` : ""
          }${report.canvas.node?.className ? `.${String(report.canvas.node.className).trim().split(/\s+/).join(".")}` : ""} · ${report.canvas.rect.w}×${report.canvas.rect.h}`
        : "未接管（画布不会被挤到中间）"
    )
  );
  out.push(
    line(
      "布局变量",
      `--cw-top=${report.cssVars["--cw-top"]} · --cw-left-w=${report.cssVars["--cw-left-w"]} · --cw-right-w=${report.cssVars["--cw-right-w"]}`
    )
  );
  out.push(line("隐藏规则", `共 ${report.hidden.rules} 条，命中 ${report.hidden.matched.length} 条`));
  for (const item of report.hidden.matched) out.push(`    · ${item.selector} × ${item.count}`);
  out.push(
    line(
      "参数面板",
      `节点 ${report.params.nodes} · 控件 ${report.params.widgets} · 分组 ${report.params.groups} · 字段 ${report.params.fields} · 正面 ${report.params.positive} / 负面 ${report.params.negative}`
    )
  );
  out.push(line("输出面板", `卡片 ${report.output.cards}${report.output.directory ? ` · ${report.output.directory}` : ""}`));
  const popups = report.popups || [];
  out.push(line("原生弹层", `检测到 ${popups.length} 个对话框 / 菜单`));
  for (const popup of popups.slice(0, 8)) {
    const name = `${popup.tag}${popup.id ? `#${popup.id}` : ""}${
      popup.className ? `.${String(popup.className).trim().split(/\s+/).slice(0, 3).join(".")}` : ""
    }`;
    out.push(
      `    · ${name} · display=${popup.display} · z-index=${popup.zIndex} · ${popup.rect.w}×${popup.rect.h}${
        popup.covered ? " · ⚠️ 被工作台面板遮挡" : ""
      }`
    );
  }
  out.push(
    line(
      "后端接口",
      `${report.backend.ping ? "ping 正常" : "ping 失败"} · ${report.backend.stats ? "stats 正常" : "stats 失败"}${
        report.backend.degraded ? "（已退化为 /system_stats）" : ""
      }${report.backend.error ? ` · ${report.backend.error}` : ""}`
    )
  );
  out.push(
    line(
      "ComfyUI",
      `app ${report.comfy.app ? "已就绪" : "未就绪"} · 工作流 ${report.comfy.workflowName || "未命名"}${
        report.comfy.frontendVersion ? ` · 前端版本 ${report.comfy.frontendVersion}` : ""
      }`
    )
  );

  const hints = [];
  if (!report.canvas.found) {
    hints.push("画布没被接管：在设置里给「画布容器选择器」填上画布容器的 CSS 选择器。");
  }
  if (!report.backend.ping) {
    hints.push("插件后端接口不可用：确认插件目录已放进 custom_nodes 且重启过 ComfyUI（资源条会退化为 /system_stats）。");
  }
  if (report.backend.degraded) {
    hints.push("资源数据来自 /system_stats 降级模式：CPU 与显卡利用率本身没有这项数据。");
  }
  if (report.params.fields === 0 && report.params.nodes > 0) {
    hints.push("没提取到参数：这些节点可能不是标准 widget 节点，可以到 issue 里附上这份报告。");
  }
  if ((report.popups || []).some((popup) => popup.covered)) {
    hints.push("有原生弹层被工作台面板遮挡：请把这份报告发我，我按 z-index 修。");
  }
  if (hints.length) {
    out.push("");
    out.push("建议：");
    for (const hint of hints) out.push(`    · ${hint}`);
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ 面板 */
let overlay = null;
let keyHandler = null;

function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      return true;
    }
  } catch (error) {
    /* 继续走兜底 */
  }
  return fallbackCopy(text);
}

function fallbackCopy(text) {
  try {
    const area = el("textarea", { class: "cw-diag-copyarea" });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.("copy") ?? false;
    area.remove();
    return ok;
  } catch (error) {
    return false;
  }
}

function ensureOverlay() {
  if (overlay && overlay.isConnected) return overlay;
  overlay = el("div", { class: "cw-diag-overlay cw-hidden", id: "cw-diag" });
  document.body.append(overlay);
  return overlay;
}

export function closeDiagnostics() {
  if (keyHandler) {
    window.removeEventListener("keydown", keyHandler);
    keyHandler = null;
  }
  if (!overlay) return;
  overlay.classList.add("cw-hidden");
  clear(overlay);
}

/**
 * 打开诊断面板并返回报告对象（便于自检脚本断言）。
 */
export async function openDiagnostics(workbench) {
  const report = await collectDiagnostics(workbench);
  const text = formatDiagnostics(report);
  const host = ensureOverlay();
  clear(host);

  const body = el("pre", { class: "cw-diag-body", id: "cw-diag-text", text });

  const copy = button("复制报告", {
    iconName: "copy",
    onClick: () => {
      const ok = copyText(body.textContent);
      toast(ok ? "诊断报告已复制到剪贴板" : "复制失败，请手动选中文本", ok ? "success" : "error");
    },
  });

  const close = button("", {
    iconName: "close",
    title: "关闭（Esc）",
    iconOnly: true,
    onClick: () => closeDiagnostics(),
  });

  host.append(
    // 遮罩先插入，弹窗后插入，否则遮罩会盖住弹窗并吃掉点击
    el("div", { class: "cw-diag-backdrop", on: { click: () => closeDiagnostics() } }),
    el(
      "div",
      { class: "cw-diag-panel", on: { click: (event) => event.stopPropagation() } },
      el(
        "div",
        { class: "cw-diag-bar" },
        iconEl("bug", 16),
        el("span", { class: "cw-diag-title", text: `诊断报告 · v${report.plugin.version}` }),
        el("span", { class: "cw-spacer" }),
        copy,
        close
      ),
      body,
      el("div", {
        class: "cw-diag-foot",
        text: "把这份报告复制到 issue 里，就能定位画布 / 侧栏 / 参数提取的问题。Esc 关闭。",
      })
    )
  );

  host.classList.remove("cw-hidden");

  if (keyHandler) window.removeEventListener("keydown", keyHandler);
  keyHandler = (event) => {
    if (event.key === "Escape") closeDiagnostics();
  };
  window.addEventListener("keydown", keyHandler);

  return report;
}
