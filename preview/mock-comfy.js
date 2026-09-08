/**
 * 预览用 mock：模拟 ComfyUI 的 app / api，让 web/ 下的真实插件代码
 * 在没有 ComfyUI 的环境里跑起来，便于验证布局与交互。
 *
 * 提供的能力：
 *   - 假节点图（含 positive/negative 连线，用于验证提示词角色识别）
 *   - 假画布（Canvas 2D 绘制节点框，验证 .cw-canvas-host 的挤压定位）
 *   - /comfui-workbench/* 全部接口的假数据
 *   - 运行按钮 → 模拟一次执行，产生新图片
 *   - 每隔几秒修改一次节点参数，验证「节点 → 面板」双向同步
 */

/* ------------------------------------------------------------------ 工具 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const listeners = new Map();

function emit(type, detail) {
  const set = listeners.get(type);
  if (!set) return;
  for (const handler of set) {
    try {
      handler({ type, detail });
    } catch (error) {
      console.error(`[mock] 事件 ${type} 处理失败`, error);
    }
  }
}

/* ------------------------------------------------------------------ 假节点图 */
const NODES = [
  {
    id: 1,
    type: "CheckpointLoaderSimple",
    title: "加载模型",
    pos: [40, 60],
    size: [230, 98],
    widgets: [
      {
        name: "ckpt_name",
        type: "combo",
        value: "sd_xl_base_1.0.safetensors",
        options: { values: ["sd_xl_base_1.0.safetensors", "flux1-dev-fp8.safetensors", "dreamshaper_8.safetensors"] },
      },
    ],
    inputs: [],
    outputs: [
      { name: "MODEL", links: [9] },
      { name: "CLIP", links: [10, 11] },
      { name: "VAE", links: [13] },
    ],
  },
  {
    id: 2,
    type: "CLIPTextEncode",
    title: "CLIP Text Encode (正面)",
    pos: [40, 200],
    size: [300, 140],
    widgets: [
      {
        name: "text",
        type: "customtext",
        multiline: true,
        value:
          "masterpiece, best quality, a serene mountain lake at sunrise, mist over the water, ultra detailed, cinematic lighting",
      },
    ],
    inputs: [{ name: "clip", link: 10 }],
    outputs: [{ name: "CONDITIONING", links: [12] }],
  },
  {
    id: 3,
    type: "CLIPTextEncode",
    title: "CLIP Text Encode (负面)",
    pos: [40, 380],
    size: [300, 120],
    widgets: [
      {
        name: "text",
        type: "customtext",
        multiline: true,
        value: "lowres, bad anatomy, blurry, watermark, text, jpeg artifacts",
      },
    ],
    inputs: [{ name: "clip", link: 11 }],
    outputs: [{ name: "CONDITIONING", links: [14] }],
  },
  {
    id: 4,
    type: "EmptyLatentImage",
    title: "空 Latent",
    pos: [380, 60],
    size: [220, 130],
    widgets: [
      { name: "width", type: "INT", value: 1024, options: { min: 16, max: 8192, step: 8 } },
      { name: "height", type: "INT", value: 1024, options: { min: 16, max: 8192, step: 8 } },
      { name: "batch_size", type: "INT", value: 1, options: { min: 1, max: 64, step: 1 } },
    ],
    inputs: [],
    outputs: [{ name: "LATENT", links: [15] }],
  },
  {
    id: 5,
    type: "KSampler",
    title: "K 采样器",
    pos: [380, 240],
    size: [250, 262],
    widgets: [
      { name: "seed", type: "INT", value: 883745129, options: { min: 0, max: 1844674407370955, step: 1 } },
      { name: "control_after_generate", type: "combo", value: "randomize", options: { values: ["fixed", "increment", "decrement", "randomize"] } },
      { name: "steps", type: "INT", value: 28, options: { min: 1, max: 200, step: 1 } },
      { name: "cfg", type: "FLOAT", value: 7.5, options: { min: 0, max: 100, step: 0.1 } },
      {
        name: "sampler_name",
        type: "combo",
        value: "dpmpp_2m",
        options: { values: ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "ddim", "uni_pc"] },
      },
      {
        name: "scheduler",
        type: "combo",
        value: "karras",
        options: { values: ["normal", "karras", "exponential", "sgm_uniform", "simple"] },
      },
      { name: "denoise", type: "FLOAT", value: 1.0, options: { min: 0, max: 1, step: 0.01 } },
    ],
    inputs: [
      { name: "model", link: 9 },
      { name: "positive", link: 12 },
      { name: "negative", link: 14 },
      { name: "latent_image", link: 15 },
    ],
    outputs: [{ name: "LATENT", links: [16] }],
  },
  {
    id: 6,
    type: "VAEDecode",
    title: "VAE 解码",
    pos: [680, 60],
    size: [200, 80],
    widgets: [],
    inputs: [
      { name: "samples", link: 16 },
      { name: "vae", link: 13 },
    ],
    outputs: [{ name: "IMAGE", links: [17] }],
  },
  {
    id: 7,
    type: "SaveImage",
    title: "保存图像",
    pos: [680, 200],
    size: [220, 80],
    widgets: [{ name: "filename_prefix", type: "string", value: "ComfyUI" }],
    inputs: [{ name: "images", link: 17 }],
    outputs: [],
  },
];

const LINKS = {
  9: { origin_id: 1, origin_slot: 0, target_id: 5, target_slot: 0 },
  10: { origin_id: 1, origin_slot: 1, target_id: 2, target_slot: 0 },
  11: { origin_id: 1, origin_slot: 1, target_id: 3, target_slot: 0 },
  12: { origin_id: 2, origin_slot: 0, target_id: 5, target_slot: 1 },
  13: { origin_id: 1, origin_slot: 2, target_id: 6, target_slot: 1 },
  14: { origin_id: 3, origin_slot: 0, target_id: 5, target_slot: 2 },
  15: { origin_id: 4, origin_slot: 0, target_id: 5, target_slot: 3 },
  16: { origin_id: 5, origin_slot: 0, target_id: 6, target_slot: 0 },
  17: { origin_id: 6, origin_slot: 0, target_id: 7, target_slot: 0 },
};

/* ------------------------------------------------------------------ 假画布 */
const canvasEl = document.getElementById("graph-canvas");
const containerEl = document.getElementById("graph-canvas-container");

function nodeHeight(node) {
  return Math.max(70, 34 + (node.widgets?.length || 0) * 26 + 12);
}

function drawGraph() {
  if (!canvasEl || !containerEl) return;
  const width = Math.max(1, containerEl.clientWidth);
  const height = Math.max(1, containerEl.clientHeight);
  const dpr = window.devicePixelRatio || 1;
  canvasEl.width = Math.floor(width * dpr);
  canvasEl.height = Math.floor(height * dpr);
  canvasEl.style.width = `${width}px`;
  canvasEl.style.height = `${height}px`;
  const ctx = canvasEl.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  /* 背景 */
  ctx.fillStyle = "#0d1015";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(255,255,255,0.035)";
  ctx.lineWidth = 1;
  const grid = 28;
  for (let x = 0; x < width; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
    ctx.stroke();
  }

  /* 连线 */
  const positions = new Map();
  for (const node of NODES) positions.set(node.id, node);
  ctx.strokeStyle = "#5a7ea8";
  ctx.lineWidth = 2;
  for (const link of Object.values(LINKS)) {
    const from = positions.get(link.origin_id);
    const to = positions.get(link.target_id);
    if (!from || !to) continue;
    const x1 = from.pos[0] + from.size[0];
    const y1 = from.pos[1] + 24 + link.origin_slot * 20;
    const x2 = to.pos[0];
    const y2 = to.pos[1] + 24 + (link.target_slot || 0) * 22;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1 + 60, y1, x2 - 60, y2, x2, y2);
    ctx.stroke();
  }

  /* 节点 */
  for (const node of NODES) {
    const [x, y] = node.pos;
    const [w] = node.size;
    const h = nodeHeight(node);

    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    roundRect(ctx, x, y, w, h, 9);
    ctx.fillStyle = "#1b212a";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    roundRect(ctx, x, y, w, 26, { tl: 9, tr: 9, br: 0, bl: 0 });
    ctx.fillStyle = node.id === 5 ? "#2b4a7a" : "#242d38";
    ctx.fill();

    ctx.fillStyle = "#dbe4ef";
    ctx.font = "600 12px -apple-system, 'PingFang SC', sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(node.title || node.type, x + 10, y + 13.5);

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 9);
    ctx.stroke();

    /* widget 行 */
    let wy = y + 34;
    for (const widget of node.widgets || []) {
      ctx.fillStyle = "#0f141a";
      roundRect(ctx, x + 8, wy, w - 16, 20, 5);
      ctx.fill();
      ctx.fillStyle = "#8c99ab";
      ctx.font = "11px -apple-system, 'PingFang SC', sans-serif";
      const raw = String(widget.value ?? "");
      const text = raw.length > 26 ? `${raw.slice(0, 26)}…` : raw;
      ctx.fillText(`${widget.name}: ${text}`, x + 14, wy + 10.5);
      wy += 26;
    }

    /* 端口 */
    ctx.fillStyle = "#7ea2c9";
    for (let i = 0; i < (node.inputs?.length || 0); i += 1) {
      ctx.beginPath();
      ctx.arc(x, y + 30 + i * 22, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < (node.outputs?.length || 0); i += 1) {
      ctx.beginPath();
      ctx.arc(x + w, y + 30 + i * 20, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* 左下角提示 */
  ctx.fillStyle = "rgba(140,153,171,0.65)";
  ctx.font = "12px -apple-system, 'PingFang SC', sans-serif";
  ctx.fillText("中间区域 = ComfyUI 原生节点画布（mock 绘制）", 18, height - 18);
}

function roundRect(ctx, x, y, w, h, radius) {
  const r = typeof radius === "number" ? { tl: radius, tr: radius, br: radius, bl: radius } : radius;
  ctx.beginPath();
  ctx.moveTo(x + r.tl, y);
  ctx.lineTo(x + w - r.tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r.tr);
  ctx.lineTo(x + w, y + h - r.br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
  ctx.lineTo(x + r.bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r.bl);
  ctx.lineTo(x, y + r.tl);
  ctx.quadraticCurveTo(x, y, x + r.tl, y);
  ctx.closePath();
}

if (containerEl) {
  new ResizeObserver(() => drawGraph()).observe(containerEl);
  window.addEventListener("resize", drawGraph);
}

/* ------------------------------------------------------------------ 假图片 */
const imageCache = new Map();

function makeImage(seedText, label) {
  const key = `${seedText}|${label}`;
  if (imageCache.has(key)) return imageCache.get(key);
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  const gradient = ctx.createLinearGradient(0, 0, 512, 512);
  gradient.addColorStop(0, `hsl(${hash}, 62%, 42%)`);
  gradient.addColorStop(0.5, `hsl(${(hash + 40) % 360}, 58%, 30%)`);
  gradient.addColorStop(1, `hsl(${(hash + 90) % 360}, 50%, 18%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 512);

  ctx.globalAlpha = 0.25;
  for (let i = 0; i < 60; i += 1) {
    ctx.beginPath();
    ctx.arc(Math.random() * 512, Math.random() * 512, Math.random() * 60 + 6, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${(hash + i * 12) % 360}, 70%, ${30 + (i % 5) * 9}%)`;
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "600 30px -apple-system, 'PingFang SC', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(label, 256, 250);
  ctx.font = "16px ui-monospace, monospace";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fillText(seedText, 256, 290);

  const url = canvas.toDataURL("image/png");
  imageCache.set(key, url);
  return url;
}

/* ------------------------------------------------------------------ 假数据 */
let statsTick = 0;
const queueState = { running: 0, pending: 0 };

function mockStats() {
  statsTick += 1;
  const wave = (base, amplitude, period) =>
    base + Math.sin(statsTick / period) * amplitude + (Math.random() - 0.5) * 2;

  return {
    ts: Date.now() / 1000,
    cpu: {
      percent: Math.round(wave(34, 22, 4) * 10) / 10,
      count: 12,
      name: "Apple M2 Max",
      freq_mhz: 3500,
      loadavg: [2.4, 2.1, 1.9],
      source: "psutil",
    },
    memory: {
      total: 34359738368,
      used: Math.round(wave(21, 3, 6) * 1024 ** 3),
      available: Math.round(wave(11, 3, 6) * 1024 ** 3),
      percent: Math.round(wave(62, 9, 6) * 10) / 10,
    },
    devices: [
      {
        index: 0,
        type: "mps",
        name: "Apple M2 Max (38 核 GPU)",
        unified_memory: true,
        vram_total: 22906494976,
        vram_used: Math.round(wave(9, 3, 5) * 1024 ** 3),
        vram_free: Math.round(wave(12, 3, 5) * 1024 ** 3),
        utilization: Math.round(wave(58, 30, 3)),
        torch_allocated: 4.2 * 1024 ** 3,
        source: "torch.mps",
      },
    ],
    queue: { running: queueState.running, pending: queueState.pending },
    comfy: { version: "0.3.40", python: "3.12.7", torch: "2.5.1" },
    platform: { system: "Darwin", release: "24.1.0", machine: "arm64", hostname: "preview" },
  };
}

function mockOutputs(limit) {
  const now = Math.floor(Date.now() / 1000);
  const names = [
    ["ComfyUI_00042_.png", "image", 40],
    ["ComfyUI_00041_.png", "image", 190],
    ["ComfyUI_00040_.png", "image", 640],
    ["upscaled/ComfyUI_00039_.png", "image", 1500],
    ["ComfyUI_00038_.png", "image", 3200],
    ["ComfyUI_00037_.png", "image", 5600],
    ["ComfyUI_00036_.png", "image", 8800],
    ["animate/ComfyUI_00035.mp4", "video", 2400],
    ["ComfyUI_00034_.png", "image", 12000],
  ];
  return names.slice(0, limit).map(([name, kind, age]) => {
    const parts = name.split("/");
    return {
      filename: parts.pop(),
      subfolder: parts.join("/"),
      type: "output",
      kind,
      mtime: now - age,
      size: kind === "video" ? 2_412_000 : 1_240_000 + age * 37,
    };
  });
}

const WORKFLOWS = [
  { name: "风景/写实风景.json", label: "风景/写实风景", mtime: Math.floor(Date.now() / 1000) - 300, size: 12400 },
  { name: "人物/半身人像.json", label: "人物/半身人像", mtime: Math.floor(Date.now() / 1000) - 7200, size: 15200 },
  { name: "flux-dev-基础.json", label: "flux-dev-基础", mtime: Math.floor(Date.now() / 1000) - 86400 * 3, size: 9800 },
];

/* ------------------------------------------------------------------ app / api */
const registeredSettings = new Map();
let extension = null;

const app = {
  graph: {
    _nodes: NODES,
    links: LINKS,
    getNodeById(id) {
      return NODES.find((node) => String(node.id) === String(id)) || null;
    },
    setDirtyCanvas() {
      drawGraph();
    },
  },
  canvas: {
    resize() {
      drawGraph();
    },
    setDirty() {
      drawGraph();
    },
  },
  ui: {
    settings: {
      getSettingValue(id) {
        const entry = registeredSettings.get(id);
        return entry ? entry.value : undefined;
      },
      setSettingValue(id, value) {
        const entry = registeredSettings.get(id);
        if (entry) entry.value = value;
        entry?.onChange?.(value);
      },
    },
  },
  async queuePrompt() {
    simulateRun();
    return true;
  },
  async loadGraphData(workflow) {
    console.log("[mock] loadGraphData", workflow);
  },
  async graphToPrompt() {
    return {
      workflow: {
        last_node_id: NODES.length,
        nodes: NODES.map((node) => ({
          id: node.id,
          type: node.type,
          title: node.title,
          widgets_values: (node.widgets || []).map((widget) => widget.value),
        })),
      },
    };
  },
  registerExtension(candidate) {
    extension = candidate;
    for (const entry of candidate.settings || []) {
      registeredSettings.set(entry.id, { value: entry.defaultValue, onChange: entry.onChange });
    }
    // 模拟 ComfyUI：DOM 就绪后调用 setup()
    setTimeout(() => candidate.setup?.(), 0);
  },
};

const api = {
  addEventListener(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
  },
  removeEventListener(type, handler) {
    listeners.get(type)?.delete(handler);
  },
  apiURL(path) {
    if (typeof path === "string" && path.startsWith("/view?")) {
      const params = new URLSearchParams(path.slice(6));
      const filename = params.get("filename") || "image.png";
      if (/\.(mp4|webm|mov)$/i.test(filename)) return "./assets/mock-video.mp4";
      return makeImage(filename, filename.replace(/\.[^.]+$/, "").slice(0, 22));
    }
    return path;
  },
  async fetchApi(path, options = {}) {
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const [route, query = ""] = String(path).split("?");
    const params = new URLSearchParams(query);

    if (route === "/comfui-workbench/stats") return json(mockStats());
    if (route === "/comfui-workbench/outputs") {
      return json({ items: mockOutputs(Number(params.get("limit")) || 40), directory: "/ComfyUI/output" });
    }
    if (route === "/comfui-workbench/workflows") {
      return json({ items: WORKFLOWS, directory: "/ComfyUI/user/default/workflows" });
    }
    if (route === "/comfui-workbench/workflow" && (!options.method || options.method === "GET")) {
      return json({ ok: true, name: params.get("name"), workflow: { nodes: [], links: [] } });
    }
    if (route === "/comfui-workbench/workflow") {
      const body = JSON.parse(options.body || "{}");
      console.log("[mock] 保存工作流", body.name);
      return json({ ok: true, name: body.name || "workflow.json", path: `/ComfyUI/user/default/workflows/${body.name}` });
    }
    if (route === "/comfui-workbench/reveal") return json({ ok: true });
    if (route === "/comfui-workbench/ping") return json({ ok: true, version: "preview" });
    if (route === "/interrupt") return json({});
    if (route === "/system_stats") {
      const stats = mockStats();
      return json({
        system: { os: "darwin", ram_total: stats.memory.total, ram_free: stats.memory.available },
        devices: [{ name: stats.devices[0].name, type: "mps", vram_total: stats.devices[0].vram_total, vram_free: stats.devices[0].vram_free }],
      });
    }
    return json({ ok: false, error: `mock 未实现的接口：${route}` }, 404);
  },
};

/* ------------------------------------------------------------------ 模拟执行 */
async function simulateRun() {
  queueState.running = 1;
  queueState.pending = 0;
  emit("status", { status: { exec_info: { queue_remaining: 1 } } });
  emit("execution_start", { prompt_id: "mock-run" });

  const total = 18;
  for (let step = 1; step <= total; step += 1) {
    await sleep(70);
    emit("progress", { value: step, max: total, node: "KSampler (5)" });
  }

  const stamp = String(Date.now()).slice(-6);
  const images = [1, 2, 3, 4].map((index) => ({
    filename: `ComfyUI_${stamp}_${index}.png`,
    subfolder: "",
    type: "output",
  }));
  emit("executed", { output: { images }, prompt_id: "mock-run" });
  emit("executing", null);
  queueState.running = 0;
  emit("status", { status: { exec_info: { queue_remaining: 0 } } });
}

/* ------------------------------------------------------------------ 外部改动（验证双向同步） */
const autoEditTimer = setTimeout(() => {
  const sampler = NODES.find((node) => node.id === 5);
  const steps = sampler.widgets.find((widget) => widget.name === "steps");
  steps.value = 36;
  app.graph.setDirtyCanvas();
  console.log("[mock] 在画布上把 steps 改成了 36，左侧面板应自动同步");
}, 20000);

/* ------------------------------------------------------------------ 暴露给插件 */
globalThis.__CW_COMFY__ = { app, api };
globalThis.__CW_MOCK__ = {
  NODES,
  LINKS,
  emit,
  simulateRun,
  stopAutoEdit() {
    clearTimeout(autoEditTimer);
  },
  get extension() {
    return extension;
  },
};

drawGraph();
console.log("[mock] ComfyUI mock 就绪");
