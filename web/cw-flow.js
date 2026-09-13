/**
 * 简约流程图视图：中间区域改成「只显示工作流节点」的只读流程图。
 *
 * 设计要点：
 *   · 数据来自当前画布的工作流（节点名 + 连线），不依赖 ComfyUI 的 DOM 结构，
 *     所以前端换皮也不会失效；
 *   · 布局按依赖关系从左到右分层（同层按节点原来的纵坐标排序，尽量贴近作者意图），
 *     有环也能收敛（深度用最长路径 + 访问标记，不会死循环）；
 *   · 用 SVG 画：虚线、圆角、描边动画都能用 CSS 写，改样式不用重画；
 *   · 平移/缩放通过改 viewBox 实现，文字始终清晰；
 *   · 执行到某个节点时：它自己加一圈天蓝色虚线光圈，和它相连的线加粗并流动。
 */

import { el, clear, iconEl } from "./cw-ui.js";
import { getGraph } from "./cw-comfy.js";
import { allLinks } from "./cw-canvas.js";

const NODE_HEIGHT = 48;
const GAP_X = 90;
const GAP_Y = 26;
const PAD = 48;
const MIN_NODE_W = 132;
const MAX_NODE_W = 260;

/** 节点显示名：优先用画布上看到的名字，其次才是类型 */
export function nodeLabel(node) {
  const title = String(node?.title || "").trim();
  if (title) return title;
  const type = String(node?.type || "").trim();
  return type || "节点";
}

/** 粗略估算文字宽度：中日韩字符按一个字宽算，其它按 0.58 字宽 */
export function estimateTextWidth(text, fontSize = 13) {
  let width = 0;
  for (const char of String(text)) {
    width += /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(char) ? fontSize : fontSize * 0.58;
  }
  return width;
}

/**
 * 把节点名压进给定宽度；装不下就从**中间**省略。
 * 从中间省略是因为「CLIP Text Encode (正面)」这类名字的区分信息在结尾，
 * 只截尾部会变成两个一模一样的「CLIP Text Encode …」。
 */
export function fitLabel(text, maxWidth, fontSize = 13) {
  const value = String(text || "");
  if (estimateTextWidth(value, fontSize) <= maxWidth) return value;
  let keep = value.length - 1;
  while (keep > 2) {
    const headCount = Math.ceil(keep / 2);
    const tailCount = Math.floor(keep / 2);
    const candidate = `${value.slice(0, headCount)}…${value.slice(value.length - tailCount)}`;
    if (estimateTextWidth(candidate, fontSize) <= maxWidth) return candidate;
    keep -= 1;
  }
  return `${value.slice(0, 1)}…`;
}

/** 从图里抽出「节点 + 连线」模型（只保留两端都存在的连线） */
export function buildModel(graph) {
  const rawNodes = (graph?._nodes || []).filter((node) => node && node.id !== undefined);
  const byId = new Map(rawNodes.map((node) => [String(node.id), node]));

  const links = [];
  const seen = new Set();
  for (const raw of allLinks(graph)) {
    const from = String(raw.origin_id);
    const to = String(raw.target_id);
    if (!byId.has(from) || !byId.has(to) || from === to) continue;
    const key = `${from}:${raw.origin_slot ?? 0}->${to}:${raw.target_slot ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ from, to, fromSlot: raw.origin_slot ?? 0, toSlot: raw.target_slot ?? 0 });
  }

  const nodes = rawNodes.map((node) => ({
    id: String(node.id),
    name: nodeLabel(node),
    order: Number(node.pos?.[1] ?? 0) * 10000 + Number(node.pos?.[0] ?? 0),
  }));

  return { nodes, links };
}

/**
 * 分层布局：返回 { nodes:[{id,name,x,y,w,h,depth}], links, width, height }
 * 深度 = 从入口到该节点的最长路径（有环时环上的节点按已访问收敛）。
 */
export function layoutModel(model) {
  const ids = model.nodes.map((node) => node.id);
  const incoming = new Map(ids.map((id) => [id, []]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const link of model.links) {
    outgoing.get(link.from)?.push(link.to);
    incoming.get(link.to)?.push(link.from);
  }

  const depth = new Map();
  const visiting = new Set();
  const computeDepth = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0; // 环：就地截断
    visiting.add(id);
    let value = 0;
    for (const parent of incoming.get(id) || []) {
      value = Math.max(value, computeDepth(parent) + 1);
    }
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const id of ids) computeDepth(id);

  /* 按深度分列，同列按原来的上下顺序排 */
  const columns = new Map();
  for (const node of model.nodes) {
    const level = depth.get(node.id) || 0;
    if (!columns.has(level)) columns.set(level, []);
    columns.get(level).push(node);
  }
  const levels = [...columns.keys()].sort((a, b) => a - b);

  /* 先量尺寸，再横向排（每列宽度取该列最宽的节点） */
  const sized = new Map();
  for (const node of model.nodes) {
    const width = Math.min(
      MAX_NODE_W,
      Math.max(MIN_NODE_W, Math.round(estimateTextWidth(node.name, 13)) + 36)
    );
    sized.set(node.id, width);
  }

  const placed = [];
  let columnX = PAD;
  const tallest = maxColumnHeight(columns, sized);
  for (const level of levels) {
    const column = columns.get(level).sort((a, b) => a.order - b.order);
    const columnWidth = Math.max(...column.map((node) => sized.get(node.id)));
    const totalHeight = column.length * NODE_HEIGHT + (column.length - 1) * GAP_Y;
    // 每列在垂直方向居中，整体看起来更对称
    let y = PAD + Math.max(0, (tallest - totalHeight) / 2);

    for (const node of column) {
      const width = sized.get(node.id);
      placed.push({
        id: node.id,
        name: node.name,
        depth: level,
        x: Math.round(columnX + (columnWidth - width) / 2),
        y: Math.round(y),
        w: width,
        h: NODE_HEIGHT,
      });
      y += NODE_HEIGHT + GAP_Y;
    }
    columnX += columnWidth + GAP_X;
  }

  const width = Math.max(PAD * 2, columnX - GAP_X + PAD);
  const height = Math.max(PAD * 2, tallest + PAD * 2);
  return { nodes: placed, links: model.links, width, height };
}

function maxColumnHeight(columns, sized) {
  let tallest = 0;
  for (const column of columns.values()) {
    const total = column.length * NODE_HEIGHT + (column.length - 1) * GAP_Y;
    tallest = Math.max(tallest, total);
  }
  return tallest;
}

/** 连线路径：左边出、右边进的三次贝塞尔，横向留出弧线空间 */
export function linkPath(fromNode, toNode) {
  const x1 = fromNode.x + fromNode.w;
  const y1 = fromNode.y + fromNode.h / 2;
  const x2 = toNode.x;
  const y2 = toNode.y + toNode.h / 2;
  const bend = Math.max(28, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

export class FlowView {
  constructor(container) {
    this.container = container;
    this.enabled = false;
    this.model = { nodes: [], links: [] };
    this.layout = { nodes: [], links: [], width: 0, height: 0 };
    this.view = { x: 0, y: 0, w: 1, h: 1 };
    this.activeNodeId = null;
    this.selectedNodeId = null;
    this.nodeEls = new Map();
    this.linkEls = [];
    this.signature = "";
    this.panning = null;
    /** 用户手动缩放/平移过之后，窗口变化就不再自动适应 */
    this.userAdjusted = false;
    this.observer = null;
  }

  /* ------------------------------------------------------------- 结构 */
  mount() {
    if (!this.container) return this;
    clear(this.container);

    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("class", "cw-flow-svg");
    this.svg.setAttribute("id", "cw-flow-svg");
    this.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    this.linkLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.linkLayer.setAttribute("class", "cw-flow-links");
    this.nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.nodeLayer.setAttribute("class", "cw-flow-nodes");
    this.svg.append(this.linkLayer, this.nodeLayer);

    this.hint = el("div", { class: "cw-flow-hint cw-hidden" }, iconEl("grid", 22), el("p", { text: "当前工作流没有节点" }));
    this.meta = el("span", { class: "cw-flow-meta", text: "" });
    this.fitButton = el(
      "button",
      {
        class: "cw-btn cw-flow-fit",
        type: "button",
        title: "适应窗口（双击空白处也可以）",
        on: { click: () => this.fit() },
      },
      iconEl("fit", 14),
      el("span", { class: "cw-btn-label", text: "适应" })
    );
    this.toolbar = el("div", { class: "cw-flow-bar" }, this.meta, this.fitButton);

    this.container.append(this.svg, this.toolbar, this.hint);

    this.bindEvents();

    // 容器尺寸变化（拖分隔条 / 窗口缩放）时，没手动调过视图就重新适应
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(() => {
        if (this.enabled && !this.userAdjusted) this.fit();
      });
      this.observer.observe(this.container);
    }
    return this;
  }

  bindEvents() {
    /* 拖动平移 */
    this.svg.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".cw-flow-node")) return;
      const box = this.svg.getBoundingClientRect();
      this.panning = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        view: { ...this.view },
        scaleX: this.view.w / Math.max(1, box.width),
        scaleY: this.view.h / Math.max(1, box.height),
      };
      this.svg.setPointerCapture?.(event.pointerId);
      this.svg.classList.add("cw-flow-grabbing");
      this.userAdjusted = true;
    });
    this.svg.addEventListener("pointermove", (event) => {
      if (!this.panning || event.pointerId !== this.panning.pointerId) return;
      this.view.x = this.panning.view.x - (event.clientX - this.panning.startX) * this.panning.scaleX;
      this.view.y = this.panning.view.y - (event.clientY - this.panning.startY) * this.panning.scaleY;
      this.applyView();
    });
    const stopPan = (event) => {
      if (!this.panning || (event && event.pointerId !== this.panning.pointerId)) return;
      this.panning = null;
      this.svg.classList.remove("cw-flow-grabbing");
    };
    this.svg.addEventListener("pointerup", stopPan);
    this.svg.addEventListener("pointercancel", stopPan);

    /* 滚轮缩放（以指针位置为锚点） */
    this.svg.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const box = this.svg.getBoundingClientRect();
        const factor = event.deltaY > 0 ? 1.12 : 1 / 1.12;
        const px = this.view.x + ((event.clientX - box.left) / Math.max(1, box.width)) * this.view.w;
        const py = this.view.y + ((event.clientY - box.top) / Math.max(1, box.height)) * this.view.h;
        const w = Math.min(this.layout.width * 3, Math.max(this.layout.width / 6, this.view.w * factor));
        const h = w * (this.view.h / Math.max(1e-6, this.view.w));
        this.view.x = px - ((event.clientX - box.left) / Math.max(1, box.width)) * w;
        this.view.y = py - ((event.clientY - box.top) / Math.max(1, box.height)) * h;
        this.view.w = w;
        this.view.h = h;
        this.userAdjusted = true;
        this.applyView();
      },
      { passive: false }
    );

    /* 双击空白处 = 适应窗口；点节点 = 选中 */
    this.svg.addEventListener("dblclick", (event) => {
      if (!event.target.closest(".cw-flow-node")) this.fit();
    });
    this.svg.addEventListener("click", (event) => {
      const group = event.target.closest(".cw-flow-node");
      this.selectNode(group?.dataset.id || null);
    });
  }

  /* ------------------------------------------------------------- 开关 */
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.container?.classList.toggle("cw-hidden", !this.enabled);
    if (this.enabled) {
      this.refresh(true);
      this.fit();
    } else {
      this.setActiveNode(null);
    }
  }

  /** 重新读取工作流并重画（工作流/节点变了才真正重画） */
  refresh(force = false) {
    if (!this.enabled) return false;
    const model = buildModel(getGraph());
    const signature = `${model.nodes.map((node) => `${node.id}:${node.name}`).join("|")}#${model.links
      .map((link) => `${link.from}>${link.to}`)
      .join("|")}`;
    if (!force && signature === this.signature) {
      this.syncActive();
      return false;
    }
    this.signature = signature;
    this.model = model;
    this.layout = layoutModel(model);
    this.render();
    this.fit();
    return true;
  }

  /* ------------------------------------------------------------- 渲染 */
  render() {
    if (!this.svg) return;
    clear(this.linkLayer);
    clear(this.nodeLayer);
    this.nodeEls = new Map();
    this.linkEls = [];

    const placed = new Map(this.layout.nodes.map((node) => [node.id, node]));

    for (const link of this.layout.links) {
      const from = placed.get(link.from);
      const to = placed.get(link.to);
      if (!from || !to) continue;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "cw-flow-link");
      path.setAttribute("d", linkPath(from, to));
      path.setAttribute("data-from", link.from);
      path.setAttribute("data-to", link.to);
      this.linkLayer.append(path);
      this.linkEls.push(path);
    }

    for (const node of this.layout.nodes) {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute("class", "cw-flow-node");
      group.setAttribute("data-id", node.id);
      group.setAttribute("data-depth", String(node.depth));
      group.setAttribute("transform", `translate(${node.x} ${node.y})`);

      const ring = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      ring.setAttribute("class", "cw-flow-ring");
      ring.setAttribute("x", "-5");
      ring.setAttribute("y", "-5");
      ring.setAttribute("width", String(node.w + 10));
      ring.setAttribute("height", String(node.h + 10));
      ring.setAttribute("rx", "14");

      const box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      box.setAttribute("class", "cw-flow-box");
      box.setAttribute("width", String(node.w));
      box.setAttribute("height", String(node.h));
      box.setAttribute("rx", "10");

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("class", "cw-flow-label");
      label.setAttribute("x", String(node.w / 2));
      label.setAttribute("y", String(node.h / 2));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dominant-baseline", "central");
      label.textContent = fitLabel(node.name, node.w - 24, 13);

      const full = document.createElementNS("http://www.w3.org/2000/svg", "title");
      full.textContent = `${node.name}（#${node.id}）`;

      group.append(ring, box, label, full);
      this.nodeLayer.append(group);
      this.nodeEls.set(node.id, group);
    }

    this.meta.textContent = `${this.layout.nodes.length} 个节点 · ${this.layout.links.length} 条连线`;
    this.hint.classList.toggle("cw-hidden", this.layout.nodes.length > 0);
    this.svg.setAttribute("viewBox", `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`);
    this.syncActive();
  }

  /* ------------------------------------------------------------- 视图 */
  fit() {
    const width = Math.max(1, this.layout.width || 1);
    const height = Math.max(1, this.layout.height || 1);
    const box = this.svg?.getBoundingClientRect();
    const aspect = box && box.height > 0 ? box.width / box.height : 16 / 9;
    let w = width;
    let h = height;
    if (w / h > aspect) h = w / aspect;
    else w = h * aspect;
    this.view = {
      x: (width - w) / 2,
      y: (height - h) / 2,
      w,
      h,
    };
    this.userAdjusted = false;
    this.applyView();
  }

  applyView() {
    if (!this.svg) return;
    this.svg.setAttribute("viewBox", `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`);
  }

  /* ------------------------------------------------------------- 状态 */
  setActiveNode(nodeId) {
    const next = nodeId === null || nodeId === undefined ? null : String(nodeId);
    if (next === this.activeNodeId) return;
    this.activeNodeId = next;
    this.syncActive();
  }

  selectNode(nodeId) {
    const next = nodeId === null || nodeId === undefined ? null : String(nodeId);
    this.selectedNodeId = next;
    for (const [id, group] of this.nodeEls) {
      group.setAttribute("data-selected", id === next ? "true" : "false");
    }
    return next;
  }

  /** 把执行状态刷到节点和连线上 */
  syncActive() {
    for (const [id, group] of this.nodeEls) {
      group.setAttribute("data-active", id === this.activeNodeId ? "true" : "false");
    }
    for (const path of this.linkEls) {
      const touched =
        path.getAttribute("data-from") === this.activeNodeId ||
        path.getAttribute("data-to") === this.activeNodeId;
      path.setAttribute("data-active", touched ? "true" : "false");
    }
  }

  destroy() {
    this.setActiveNode(null);
    this.observer?.disconnect();
    this.observer = null;
    clear(this.container);
    this.nodeEls = new Map();
    this.linkEls = [];
    this.signature = "";
  }
}
