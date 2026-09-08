/**
 * 极简画布 + 连线动效。
 *
 * 目标：中间只留工作流的节点本身，把画布上的原生外壳收起来，并让连线更好懂。
 *
 * 实现方式（关键取舍）：
 *   「画布菜单 / 画布信息 / 连线样式 / 中点标记 / 选择工具条 / 小地图」
 *   这些 ComfyUI 自己就有设置项，所以优先改**设置值**而不是硬隐藏 DOM ——
 *   这样既不和 Vue 抢 DOM，也能在退出工作台时精确还原用户原来的偏好。
 *   旧版本没有某个设置项时，再用 CSS 兜底隐藏。
 *
 * 动效：给 litegraph 挂 onDrawForeground 钩子，在执行中的节点周围画呼吸光晕，
 *       并沿它的连线画流动的点。空闲时不开 rAF，避免白白吃 CPU。
 */

import { getAppSync, getGraph, getNodes, getNodeById } from "./cw-comfy.js";
import { setting, setSetting, KEYS } from "./cw-store.js";

/** ComfyUI 自身的设置项 ID —— 用它们来收起画布外壳 */
export const CANVAS_SETTING_IDS = {
  canvasMenu: "Comfy.Graph.CanvasMenu",
  canvasInfo: "Comfy.Graph.CanvasInfo",
  linkMarkers: "Comfy.Graph.LinkMarkers",
  linkRenderMode: "Comfy.LinkRenderMode",
  selectionToolbox: "Comfy.Canvas.SelectionToolbox",
  minimap: "Comfy.Minimap.Visible",
};

/** 极简模式下要写入的值；拿不到 LiteGraph 常量时返回 null，表示「这项跳过」 */
export function minimalValues() {
  const litegraph = globalThis.LiteGraph || {};
  const markers = litegraph.LinkMarkerShape || {};
  return {
    canvasMenu: false,
    canvasInfo: false,
    selectionToolbox: false,
    minimap: false,
    linkMarkers: Number.isFinite(markers.None) ? markers.None : 0,
    linkRenderMode: Number.isFinite(litegraph.STRAIGHT_LINK) ? litegraph.STRAIGHT_LINK : null,
  };
}

export class MinimalCanvas {
  constructor() {
    /** 进入极简模式前用户自己的设置值，退出时原样还原 */
    this.saved = null;
    this.applied = false;
  }

  settingsApi() {
    const api = getAppSync()?.ui?.settings;
    if (!api || typeof api.setSettingValue !== "function") return null;
    return api;
  }

  /** 有没有可用的 ComfyUI 设置接口（预览页 / 老版本可能没有） */
  supported() {
    return Boolean(this.settingsApi());
  }

  apply() {
    if (this.applied) return false;
    const api = this.settingsApi();
    if (!api) return false;

    const values = minimalValues();
    const saved = {};
    for (const [key, id] of Object.entries(CANVAS_SETTING_IDS)) {
      saved[key] = setting(id, undefined);
      const next = values[key];
      if (next === null || next === undefined) continue;
      try {
        api.setSettingValue(id, next);
      } catch (error) {
        console.warn(`[ComfUI Workbench] 无法设置 ${id}`, error);
      }
    }
    this.saved = saved;
    this.applied = true;
    return true;
  }

  restore() {
    if (!this.applied) return false;
    const api = this.settingsApi();
    const saved = this.saved || {};
    if (api) {
      for (const [key, id] of Object.entries(CANVAS_SETTING_IDS)) {
        const previous = saved[key];
        if (previous === undefined || previous === null) continue;
        try {
          api.setSettingValue(id, previous);
        } catch (error) {
          /* 忽略：还原失败也不该影响退出 */
        }
      }
    }
    this.saved = null;
    this.applied = false;
    return true;
  }
}

/* ------------------------------------------------------------------ 连线动效 */
/** 纯函数：在两点之间按 progress 取样，返回一组流动点的坐标（便于自检） */
export function flowDots(from, to, progress, count = 3) {
  const dots = [];
  if (!from || !to || !Number.isFinite(count) || count < 1) return dots;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  for (let index = 0; index < count; index += 1) {
    let t = (progress + index / count) % 1;
    if (t < 0) t += 1;
    dots.push({ x: from.x + dx * t, y: from.y + dy * t, t });
  }
  return dots;
}

/** 纯函数：节点在图坐标系里的矩形（litegraph 的 pos/size） */
export function nodeRect(node) {
  if (!node) return null;
  const pos = node.pos || [0, 0];
  const size = node.size || [0, 0];
  return { x: pos[0], y: pos[1], w: size[0], h: size[1] };
}

/** 连线端点（图坐标）。优先用 litegraph 的 getConnectionPos，失败就按节点边框估算 */
export function connectionPoint(node, isInput, slot) {
  if (!node) return null;
  try {
    const out = node.getConnectionPos?.(isInput, slot, [0, 0]);
    if (out && Number.isFinite(out[0]) && Number.isFinite(out[1])) {
      return { x: out[0], y: out[1] };
    }
  } catch (error) {
    /* 继续走兜底 */
  }
  const rect = nodeRect(node);
  if (!rect) return null;
  return isInput
    ? { x: rect.x, y: rect.y + rect.h / 2 }
    : { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
}

/** 把图坐标换算成屏幕坐标（litegraph 的 ds.offset / ds.scale） */
export function toScreen(point, ds) {
  if (!point) return null;
  const scale = ds?.scale || 1;
  const offset = ds?.offset || [0, 0];
  return { x: (point.x + offset[0]) * scale, y: (point.y + offset[1]) * scale };
}

/** 取出图里所有连线（litegraph 的 links 可能是 Map，也可能是数组） */
export function allLinks(graph) {
  const links = graph?.links;
  if (!links) return [];
  if (typeof links.values === "function") return [...links.values()].filter(Boolean);
  return Object.values(links).filter(Boolean);
}

export class FlowOverlay {
  constructor() {
    this.canvas = null;
    this.activeNodeId = null;
    this.installed = false;
    this.frame = null;
    this.phase = 0;
    this.previousHook = null;
    /** 暴露纯函数，方便自检脚本直接验证几何计算 */
    this.helpers = { flowDots, nodeRect, connectionPoint, toScreen, allLinks };
    this.reducedMotion = false;
    try {
      this.reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    } catch (error) {
      this.reducedMotion = false;
    }
  }

  attach() {
    const canvas = getAppSync()?.canvas;
    if (!canvas || this.installed) return this;
    this.canvas = canvas;
    this.previousHook = canvas.onDrawForeground || null;
    canvas.onDrawForeground = (ctx, graph, ...rest) => {
      this.previousHook?.(ctx, graph, ...rest);
      try {
        this.draw(ctx, graph);
      } catch (error) {
        /* 画不出来也不能影响画布本身 */
      }
    };
    this.installed = true;
    return this;
  }

  detach() {
    if (this.canvas && this.installed) {
      this.canvas.onDrawForeground = this.previousHook || undefined;
      this.canvas.setDirty?.(true, true);
    }
    this.stop();
    this.canvas = null;
    this.installed = false;
    this.previousHook = null;
  }

  /** 当前执行到哪个节点（null 表示没有在跑） */
  setActiveNode(nodeId) {
    const next = nodeId === null || nodeId === undefined ? null : String(nodeId);
    if (next === this.activeNodeId) return;
    this.activeNodeId = next;
    if (next) this.start();
    else this.stop();
  }

  start() {
    if (this.frame || this.reducedMotion) return;
    const tick = () => {
      this.phase = (this.phase + 0.02) % 1;
      this.canvas?.setDirty?.(true, false);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.phase = 0;
    this.canvas?.setDirty?.(true, true);
  }

  /** 真正画的部分：执行中的节点光晕 + 它的连线上的流动点 */
  draw(ctx, graph) {
    if (!ctx || !this.activeNodeId) return;
    const node = getNodeById(this.activeNodeId) || findNode(graph, this.activeNodeId);
    const ds = this.canvas?.ds;
    if (!node || !ds) return;

    const rect = nodeRect(node);
    const screen = toScreen({ x: rect.x, y: rect.y }, ds);
    const scale = ds.scale || 1;
    const w = rect.w * scale;
    const h = rect.h * scale;

    /* 光晕：用 sin 做呼吸，避免刺眼 */
    const pulse = 0.5 + 0.5 * Math.sin(this.phase * Math.PI * 2);
    ctx.save();
    ctx.lineWidth = 2 + pulse * 2;
    ctx.strokeStyle = `rgba(79, 140, 255, ${0.35 + pulse * 0.35})`;
    ctx.shadowColor = "rgba(79, 140, 255, 0.85)";
    ctx.shadowBlur = 12 + pulse * 10;
    roundRect(ctx, screen.x, screen.y, w, h, 8 * scale);
    ctx.stroke();
    ctx.restore();

    /* 连线上的流动点：只画和当前节点相连的线 */
    const links = allLinks(graph);
    for (const link of links) {
      const isSource = String(link.origin_id) === this.activeNodeId;
      const isTarget = String(link.target_id) === this.activeNodeId;
      if (!isSource && !isTarget) continue;

      const origin = getNodeById(link.origin_id) || findNode(graph, link.origin_id);
      const target = getNodeById(link.target_id) || findNode(graph, link.target_id);
      const from = toScreen(connectionPoint(origin, false, link.origin_slot), ds);
      const to = toScreen(connectionPoint(target, true, link.target_slot), ds);
      if (!from || !to) continue;

      for (const dot of flowDots(from, to, this.phase, 3)) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(120, 200, 255, ${0.35 + dot.t * 0.5})`;
        ctx.arc(dot.x, dot.y, 2.4 + dot.t * 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function findNode(graph, id) {
  if (!graph) return null;
  try {
    if (typeof graph.getNodeById === "function") return graph.getNodeById(id);
  } catch (error) {
    /* 忽略 */
  }
  return getNodes().find((node) => String(node.id) === String(id)) || null;
}

function roundRect(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 统一入口：极简画布 + 动效，跟着工作台开关一起生效 */
export class CanvasPolish {
  constructor() {
    this.minimal = new MinimalCanvas();
    this.flow = new FlowOverlay();
  }

  setEnabled(enabled) {
    if (enabled) {
      if (setting(KEYS.canvasMinimal, true) !== false) this.minimal.apply();
      if (setting(KEYS.flowAnimation, true) !== false) this.flow.attach();
    } else {
      this.minimal.restore();
      this.flow.detach();
    }
  }

  setMinimal(enabled) {
    if (enabled) this.minimal.apply();
    else this.minimal.restore();
  }

  setFlow(enabled) {
    if (enabled) this.flow.attach();
    else this.flow.detach();
  }

  setActiveNode(nodeId) {
    this.flow.setActiveNode(nodeId);
  }

  destroy() {
    this.minimal.restore();
    this.flow.detach();
  }
}

/** 让「连线简单易懂」也能手动触发（设置面板改动时调用） */
export function applyLinkStyle() {
  const values = minimalValues();
  if (values.linkRenderMode !== null) setSetting(CANVAS_SETTING_IDS.linkRenderMode, values.linkRenderMode);
  if (values.linkMarkers !== null) setSetting(CANVAS_SETTING_IDS.linkMarkers, values.linkMarkers);
}
