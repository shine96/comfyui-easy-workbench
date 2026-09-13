/**
 * ComfyUI 适配层。
 *
 * 所有对 ComfyUI 内部对象（app / api / graph / canvas）的访问都集中在这个文件，
 * 好处有两点：
 *   1. 不同版本前端 API 的差异只在这里做兼容；
 *   2. 预览页（preview/index.html）可以在没有 ComfyUI 的环境里注入
 *      globalThis.__CW_COMFY__，从而用同一套业务代码验证界面。
 */

const NAMESPACE = "/comfui-workbench";

let cached = null;
let loading = null;

/** 同步获取（构建界面之前必须已经 await 过 getComfy） */
export function getComfySync() {
  return cached || globalThis.__CW_COMFY__ || null;
}

export function getAppSync() {
  return getComfySync()?.app || null;
}

export function getApiSync() {
  return getComfySync()?.api || null;
}

export async function getComfy() {
  if (cached) return cached;
  if (globalThis.__CW_COMFY__) {
    cached = globalThis.__CW_COMFY__;
    return cached;
  }
  if (loading) return loading;
  loading = (async () => {
    try {
      const [appModule, apiModule] = await Promise.all([
        import("../../scripts/app.js"),
        import("../../scripts/api.js"),
      ]);
      cached = { app: appModule.app, api: apiModule.api };
    } catch (error) {
      console.warn("[ComfUI Workbench] 无法加载 ComfyUI 模块，将退化为只读模式", error);
      cached = { app: null, api: null };
    }
    return cached;
  })();
  return loading;
}

/* ------------------------------------------------------------------ HTTP */
export async function cwFetch(path, options = {}) {
  const api = getApiSync();
  if (api && typeof api.fetchApi === "function") return api.fetchApi(path, options);
  return fetch(path, options);
}

export async function cwJson(path, options = {}) {
  const response = await cwFetch(path, options);
  if (!response || !response.ok) {
    const text = response ? await response.text().catch(() => "") : "";
    throw new Error(`${response ? response.status : "network"} ${text}`.trim());
  }
  return response.json();
}

/** 拼接 ComfyUI 的资源 URL（会自动带上前端 base path） */
export function apiURL(path) {
  const api = getApiSync();
  try {
    if (api && typeof api.apiURL === "function") return api.apiURL(path);
  } catch (error) {
    /* 忽略 */
  }
  return path;
}

/** /view 链接：cacheKey 用于强制刷新缩略图 */
export function viewUrl(item, { preview = false } = {}) {
  if (!item) return "";
  const params = new URLSearchParams();
  params.set("filename", item.filename || "");
  if (item.subfolder) params.set("subfolder", item.subfolder);
  params.set("type", item.type || "output");
  if (preview) params.set("preview", "webp");
  if (item.mtime) params.set("t", String(item.mtime));
  return apiURL(`/view?${params.toString()}`);
}

/* ------------------------------------------------------------------ 资源占用 */
export async function fetchStats() {
  try {
    return await cwJson(`${NAMESPACE}/stats`);
  } catch (error) {
    // 后端接口不可用时退化为 ComfyUI 自带的 /system_stats（没有 CPU 与 GPU 利用率）
    const fallback = await cwJson("/system_stats").catch(() => null);
    if (!fallback) throw error;
    return normalizeSystemStats(fallback);
  }
}

function normalizeSystemStats(raw) {
  const system = raw.system || {};
  const devices = (raw.devices || []).map((device, index) => {
    const total = numberOrNull(device.vram_total);
    const free = numberOrNull(device.vram_free);
    const used = total !== null && free !== null ? Math.max(0, total - free) : null;
    const torchTotal = numberOrNull(device.torch_vram_total);
    const torchFree = numberOrNull(device.torch_vram_free);
    return {
      index: device.index ?? index,
      name: device.name || device.type || `设备 ${index}`,
      type: String(device.type || "").toLowerCase(),
      vram_total: total,
      vram_free: free,
      vram_used: used,
      torch_allocated:
        torchTotal !== null && torchFree !== null ? Math.max(0, torchTotal - torchFree) : null,
      source: "system_stats",
    };
  });
  const ramTotal = numberOrNull(system.ram_total);
  const ramFree = numberOrNull(system.ram_free);
  return {
    ts: Date.now() / 1000,
    degraded: true,
    cpu: { percent: null, count: null, source: "system_stats" },
    memory: {
      total: ramTotal,
      free: ramFree,
      used: ramTotal !== null && ramFree !== null ? Math.max(0, ramTotal - ramFree) : null,
      percent:
        ramTotal && ramFree !== null ? Math.round(((ramTotal - ramFree) / ramTotal) * 1000) / 10 : null,
    },
    devices,
    queue: { running: 0, pending: 0, unknown: true },
    comfy: {
      version: system.comfyui_version,
      python: system.python_version,
      torch: system.pytorch_version,
      os: system.os,
    },
    platform: { system: system.os || "" },
  };
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/* ------------------------------------------------------------------ 输出产物 */
export async function fetchOutputs(limit = 120) {
  const data = await cwJson(`${NAMESPACE}/outputs?limit=${encodeURIComponent(limit)}`);
  return { items: data.items || [], directory: data.directory || "" };
}

export async function revealFile(payload) {
  const body = typeof payload === "string" ? { path: payload } : payload || {};
  return cwJson(`${NAMESPACE}/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 从磁盘删除一个输出产物（不可恢复） */
export async function deleteOutput(payload) {
  const body = typeof payload === "string" ? { filename: payload } : payload || {};
  return cwJson(`${NAMESPACE}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ 工作流 */
export async function fetchWorkflows() {
  const data = await cwJson(`${NAMESPACE}/workflows`);
  return { items: data.items || [], directory: data.directory || "" };
}

export async function readWorkflow(name) {
  const data = await cwJson(`${NAMESPACE}/workflow?name=${encodeURIComponent(name)}`);
  return data.workflow;
}

export async function writeWorkflow(name, workflow) {
  return cwJson(`${NAMESPACE}/workflow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, workflow }),
  });
}

/** 把工作流 JSON 载入画布 */
export async function loadWorkflowData(workflow) {
  const app = getAppSync();
  if (!app) throw new Error("ComfyUI 未就绪");
  if (typeof app.loadGraphData === "function") return app.loadGraphData(workflow);
  if (typeof app.workflowManager?.loadGraphData === "function") {
    return app.workflowManager.loadGraphData(workflow);
  }
  if (typeof app.loadApiJson === "function") return app.loadApiJson(workflow);
  throw new Error("当前前端版本不支持载入工作流");
}

/** 导出当前画布的工作流 JSON（用于「另存为」） */
export async function graphToWorkflowJson() {
  const app = getAppSync();
  if (!app) throw new Error("ComfyUI 未就绪");
  if (typeof app.graphToPrompt === "function") {
    const result = await app.graphToPrompt();
    if (result && result.workflow) return result.workflow;
  }
  if (app.graph && typeof app.graph.serialize === "function") return app.graph.serialize();
  throw new Error("无法导出工作流");
}

export function getWorkflowName() {
  const app = getAppSync();
  const workflow = app?.extensionManager?.workflow?.activeWorkflow;
  const name =
    workflow?.filename ||
    workflow?.name ||
    app?.workflowManager?.activeWorkflow?.name ||
    app?.graph?._cwName ||
    "";
  return String(name || "").replace(/\.json$/i, "");
}

/* ------------------------------------------------------------------ 执行控制 */
export async function runPrompt() {
  const app = getAppSync();
  if (!app) throw new Error("ComfyUI 未就绪");
  if (typeof app.queuePrompt === "function") return app.queuePrompt(0, 1);
  const manager = app.extensionManager;
  if (manager?.command?.execute) {
    await manager.command.execute("Comfy.QueuePrompt");
    return true;
  }
  const button =
    document.querySelector("#queue-button") || document.querySelector(".comfy-queue-button");
  if (button) {
    button.click();
    return true;
  }
  throw new Error("找不到执行入口");
}

export async function interruptPrompt() {
  const app = getAppSync();
  const manager = app?.extensionManager;
  if (manager?.command?.execute) {
    try {
      await manager.command.execute("Comfy.Interrupt");
      return true;
    } catch (error) {
      /* 继续尝试其它方式 */
    }
  }
  try {
    await cwFetch("/interrupt", { method: "POST" });
    return true;
  } catch (error) {
    const button =
      document.querySelector("#interrupt-button") || document.querySelector(".comfy-interrupt-button");
    if (button) {
      button.click();
      return true;
    }
  }
  throw new Error("无法中断执行");
}

/* ------------------------------------------------------------------ 图 / 节点 */
export function getGraph() {
  return getAppSync()?.graph || null;
}

export function getNodes() {
  const graph = getGraph();
  return (graph && graph._nodes) || [];
}

export function getLink(linkId) {
  const graph = getGraph();
  if (!graph || linkId === null || linkId === undefined || linkId < 0) return null;
  const links = graph.links;
  if (!links) return null;
  if (typeof links.get === "function") return links.get(linkId) || null;
  return links[linkId] || null;
}

export function getNodeById(id) {
  const graph = getGraph();
  if (!graph) return null;
  if (typeof graph.getNodeById === "function") return graph.getNodeById(id);
  return getNodes().find((node) => String(node.id) === String(id)) || null;
}

/**
 * 写入 widget 值，尽量兼容新旧前端：
 *  - 直接赋值 widget.value
 *  - 触发 widget.callback（让节点内部逻辑 / 序列化同步）
 *  - 如果是 DOM 渲染的 widget（新版前端的 textarea），同步 DOM 并派发 input 事件
 */
export function setWidgetValue(node, widget, value) {
  if (!node || !widget) return false;
  const previous = widget.value;
  if (previous === value) return false;
  widget.value = value;
  const canvas = getAppSync()?.canvas;
  try {
    if (typeof widget.callback === "function") {
      widget.callback(value, canvas, node, [0, 0], null);
    }
  } catch (error) {
    console.warn("[ComfUI Workbench] widget.callback 调用失败", error);
  }
  const element = widget.element || widget.inputEl || widget.elementRoot;
  if (element && "value" in element) {
    try {
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (error) {
      /* 忽略 */
    }
  }
  try {
    node.setDirtyCanvas?.(true, true);
    getGraph()?.setDirtyCanvas?.(true, true);
  } catch (error) {
    /* 忽略 */
  }
  return true;
}

/** 让 litegraph 重新计算画布尺寸 */
export function resizeCanvas() {
  const app = getAppSync();
  if (!app) return;
  const canvas = app.canvas;
  try {
    if (canvas && typeof canvas.resize === "function") canvas.resize();
    if (canvas && typeof canvas.setDirty === "function") canvas.setDirty(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
  } catch (error) {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ 事件 */
export function onComfyEvent(name, handler) {
  const api = getApiSync();
  if (!api || typeof api.addEventListener !== "function") return () => {};
  api.addEventListener(name, handler);
  return () => {
    try {
      api.removeEventListener?.(name, handler);
    } catch (error) {
      /* 忽略 */
    }
  };
}
