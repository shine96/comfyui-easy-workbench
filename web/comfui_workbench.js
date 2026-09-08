/**
 * ComfUI Workbench —— 前端扩展入口。
 *
 * 加载顺序：ComfyUI 把本文件作为 ES 模块动态 import，
 * 这里先注册扩展，等 ComfyUI 调用 setup() 之后再构建界面（此时 DOM 与 app 都已就绪）。
 */

import { getComfy } from "./cw-comfy.js";
import { Workbench } from "./cw-workbench.js";
import { store, KEYS } from "./cw-store.js";
import { DEFAULT_HIDE_SELECTORS } from "./cw-layout.js";

const EXTENSION_NAME = "ComfUI.Workbench";
const STYLE_URL = new URL("./style.css", import.meta.url).href;

let workbench = null;

/* ------------------------------------------------------------------ 样式 */
function ensureStyles() {
  if (document.querySelector("link[data-cw-style]")) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = STYLE_URL;
    link.dataset.cwStyle = "";
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => {
      console.warn("[ComfUI Workbench] 样式表加载失败：", STYLE_URL);
      resolve();
    });
    document.head.append(link);
    // 兜底：某些环境下 link 的 load 事件不会触发
    setTimeout(resolve, 1500);
  });
}

/* ------------------------------------------------------------------ 设置项 */
const settings = [
  {
    id: KEYS.enabled,
    name: "启用简易工作台",
    type: "boolean",
    defaultValue: true,
    tooltip: "关闭后回到 ComfyUI 原生界面（快捷键 Ctrl+Shift+B 也可以切换）",
    onChange: (value) => workbench?.setEnabled(value),
  },
  {
    id: KEYS.pollMs,
    name: "资源占用刷新间隔（毫秒）",
    type: "number",
    defaultValue: 1500,
    attrs: { min: 500, max: 10000, step: 100 },
    onChange: (value) => {
      if (!workbench?.stats) return;
      workbench.stats.interval = Math.max(500, Number(value) || 1500);
      workbench.stats.start();
    },
  },
  {
    id: KEYS.theme,
    name: "工作台主题",
    type: "combo",
    defaultValue: "auto",
    options: ["auto", "dark", "light"],
    onChange: (value) => workbench?.layout.applyTheme(value),
  },
  {
    id: KEYS.broadHide,
    name: "自动隐藏疑似原生侧栏 / 面板",
    type: "boolean",
    defaultValue: true,
    tooltip:
      "用属性选择器（class/id 含 sidebar、bottom-panel、queue-panel 等）兜底隐藏，兼容不同前端版本；误伤时可关闭",
    onChange: () => workbench?.layout.installHideStyle(),
  },
  {
    id: KEYS.hideSelectors,
    name: "额外隐藏的原生元素选择器",
    type: "text",
    defaultValue: "",
    tooltip: "逗号分隔的 CSS 选择器，用于在简化模式下隐藏更多原生界面元素",
    onChange: () => workbench?.layout.installHideStyle(),
  },
  {
    id: KEYS.canvasSelector,
    name: "画布容器选择器（留空自动检测）",
    type: "text",
    defaultValue: "",
    tooltip:
      "如果画布没有被挤到中间，说明自动检测没命中，在这里填上画布容器的 CSS 选择器（可用 Ctrl+Shift+D 诊断报告里的「画布容器」项）",
    onChange: (value) => workbench?.layout.setCanvasSelector(value),
  },
  {
    id: KEYS.canvasMinimal,
    name: "极简画布（只显示流程节点）",
    type: "boolean",
    defaultValue: true,
    tooltip:
      "收起画布上的原生外壳：右下角画布菜单、左下角 FPS 信息、选中时的浮动工具条、小地图，并把连线改成直线、去掉中点标记。退出工作台会原样还原你原来的设置",
    onChange: (value) => workbench?.canvas.setMinimal(value),
  },
  {
    id: KEYS.flowAnimation,
    name: "连线动效（执行时流动 + 节点呼吸）",
    type: "boolean",
    defaultValue: true,
    tooltip:
      "执行中的节点会呼吸发光，数据沿它的连线流动；关闭可省电（系统开启「减少动态效果」时自动关闭）",
    onChange: (value) => workbench?.canvas.setFlow(value),
  },
];

/* ------------------------------------------------------------------ 扩展 */
async function boot() {
  const comfy = await getComfy();
  const app = comfy?.app;

  const start = async () => {
    await ensureStyles();
    workbench = new Workbench();
    globalThis.ComfUIWorkbench = workbench;
    await workbench.mount();
  };

  if (!app || typeof app.registerExtension !== "function") {
    // 预览页 / 非 ComfyUI 环境
    console.warn("[ComfUI Workbench] 未检测到 ComfyUI app，直接以独立模式启动");
    await start();
    return;
  }

  app.registerExtension({
    name: EXTENSION_NAME,
    settings,
    commands: [
      {
        id: "ComfUI.Workbench.Toggle",
        label: "切换简易工作台",
        icon: "pi pi-desktop",
        function: () => workbench?.toggle(),
      },
      {
        id: "ComfUI.Workbench.Run",
        label: "运行当前工作流",
        icon: "pi pi-play",
        function: () => workbench?.run(),
      },
      {
        id: "ComfUI.Workbench.Interrupt",
        label: "中断当前执行",
        icon: "pi pi-stop",
        function: () => workbench?.interrupt(),
      },
      {
        id: "ComfUI.Workbench.Diagnose",
        label: "ComfUI 工作台：诊断当前界面",
        icon: "pi pi-question-circle",
        function: () => workbench?.diagnose(),
      },
    ],
    // 注意：不要注册 Ctrl+Enter —— ComfyUI 前端把扩展快捷键按「默认快捷键」注册，
    // 一旦和内置的 Comfy.QueuePrompt 撞车就会抛异常并弹红色错误提示。
    // 运行直接沿用 ComfyUI 原生的 Ctrl+Enter，我们只监听事件刷新界面。
    keybindings: [
      { commandId: "ComfUI.Workbench.Toggle", combo: { key: "b", ctrl: true, shift: true } },
      { commandId: "ComfUI.Workbench.Interrupt", combo: { key: ".", ctrl: true } },
      { commandId: "ComfUI.Workbench.Diagnose", combo: { key: "d", ctrl: true, shift: true } },
    ],
    async setup() {
      try {
        await start();
      } catch (error) {
        console.error("[ComfUI Workbench] 启动失败", error);
      }
    },
    // 切换工作流后立即刷新左侧参数
    async afterConfigureGraph() {
      workbench?.params && ((workbench.params.signature = ""), workbench.params.render(true));
    },
  });

  console.log(
    `[ComfUI Workbench] 已注册。默认隐藏的原生选择器：${DEFAULT_HIDE_SELECTORS.join(", ")}`
  );
}

await boot();
