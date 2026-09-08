/**
 * 工作台总控：把布局、资源条、参数面板、输出面板串起来，并接管 ComfyUI 事件。
 */

import { toast, debounce } from "./cw-ui.js";
import { store, setting, KEYS } from "./cw-store.js";
import {
  getComfy,
  getAppSync,
  onComfyEvent,
  runPrompt,
  interruptPrompt,
  getWorkflowName,
} from "./cw-comfy.js";
import { Layout } from "./cw-layout.js";
import { StatsBar } from "./cw-stats.js";
import { ParamsPanel } from "./cw-params.js";
import { OutputPanel } from "./cw-output.js";

const TICK_MS = 900;

export class Workbench {
  constructor() {
    this.mounted = false;
    this.enabled = false;
    this.running = false;
    this.tickTimer = null;
    this.unsubscribers = [];
  }

  async mount() {
    if (this.mounted) return this;
    await getComfy();
    if (!getAppSync()) {
      console.warn("[ComfUI Workbench] 未找到 ComfyUI app 实例，工作台不会启动");
      return this;
    }
    this.mounted = true;

    this.layout = new Layout();
    const refs = this.layout.build();
    this.layout.applyTheme(setting(KEYS.theme, "auto"));

    this.stats = new StatsBar(refs.topbar, {
      onToggleMenu: () => this.toggleNativeMenu(),
    }).mount();

    this.params = new ParamsPanel({
      head: refs.leftHead,
      body: refs.leftBody,
      foot: refs.leftFoot,
      onRun: () => this.run(),
      onInterrupt: () => this.interrupt(),
      onWorkflowChange: (name) => this.stats.setWorkflowName(name),
    }).mount();

    this.output = new OutputPanel({
      head: refs.rightHead,
      body: refs.rightBody,
      foot: refs.rightFoot,
    }).mount();

    this.bindEvents();
    this.syncMenuButton();

    this.stats.start();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);

    this.setEnabled(setting(KEYS.enabled, true) !== false);
    return this;
  }

  /* ------------------------------------------------------------- 开关 */
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.layout.setEnabled(this.enabled);
    if (this.enabled) {
      this.params.refreshWorkflows();
      this.output.loadHistory();
      this.params.signature = "";
      this.params.render(true);
      this.updateWorkflowName();
      toast("已进入简易工作台（Ctrl+Shift+B 切换）", "success", 2200);
    }
  }

  toggle() {
    this.setEnabled(!this.enabled);
    store.set(KEYS.enabled, this.enabled);
    return this.enabled;
  }

  toggleNativeMenu() {
    this.layout.setHideNativeMenu(!this.layout.hideNativeMenu);
    this.syncMenuButton();
  }

  syncMenuButton() {
    if (!this.stats?.menuButton) return;
    const hidden = this.layout.hideNativeMenu;
    this.stats.menuButton.classList.toggle("cw-on", hidden);
    this.stats.menuButton.title = hidden ? "显示 ComfyUI 原生顶栏" : "隐藏 ComfyUI 原生顶栏";
    const label = this.stats.menuButton.querySelector(".cw-btn-label");
    if (label) label.textContent = hidden ? "显示菜单" : "原生菜单";
  }

  /* ------------------------------------------------------------- 事件 */
  bindEvents() {
    const sub = (name, handler) => this.unsubscribers.push(onComfyEvent(name, handler));

    sub("executed", (event) => {
      const added = this.output.handleExecuted(event?.detail);
      if (added) this.output.clearStatus();
    });

    sub("execution_start", () => {
      this.setRunning(true);
      this.output.setStatus("开始执行…");
    });

    sub("executing", (event) => {
      const detail = event?.detail;
      if (!detail) {
        this.setRunning(false);
        this.output.clearStatus();
      } else {
        this.setRunning(true);
      }
    });

    sub("progress", (event) => {
      const detail = event?.detail || {};
      this.output.setProgress(detail);
      if (detail.max) this.stats.setProgress(detail.value, detail.max);
    });

    sub("execution_error", (event) => {
      this.setRunning(false);
      this.output.clearStatus();
      const message = event?.detail?.exception_message || event?.detail?.error || "执行出错";
      toast(String(message).slice(0, 160), "error", 6000);
    });

    sub("execution_interrupted", () => {
      this.setRunning(false);
      this.output.clearStatus();
      toast("已中断", "info");
    });

    sub("status", (event) => {
      const queue = event?.detail?.status?.exec_info?.queue_remaining;
      if (typeof queue === "number") {
        this.stats.setQueue(queue > 0 ? 1 : 0, Math.max(0, queue - 1));
        this.params.setQueue(queue > 0 ? 1 : 0, Math.max(0, queue - 1));
        if (queue === 0) this.setRunning(false);
      }
    });

    // 工作流切换 / 节点变化 → 重建参数面板
    const invalidate = debounce(() => {
      this.params.signature = "";
      this.params.render(true);
      this.updateWorkflowName();
    }, 200);

    sub("afterConfigureGraph", invalidate);
    sub("workflowLoaded", invalidate);
    sub("nodeCreated", invalidate);

    window.addEventListener(
      "resize",
      debounce(() => this.layout.onViewportChange(), 120)
    );

    // Ctrl/Cmd + Enter 快捷运行（新前端 command 未生效时的兜底）
    window.addEventListener("keydown", (event) => {
      if (!this.enabled) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        this.run();
      }
    });
  }

  setRunning(running) {
    this.running = Boolean(running);
    this.params.setRunning(this.running);
  }

  updateWorkflowName() {
    const name = getWorkflowName() || this.params?.wfSelect?.value?.replace(/\.json$/i, "") || "";
    this.stats.setWorkflowName(name);
  }

  /* ------------------------------------------------------------- 轮询 */
  tick() {
    if (!this.enabled) return;
    // 前端偶尔会重建画布容器，发现掉线就重新接管
    if (!this.layout.canvasHost || !this.layout.canvasHost.isConnected) {
      this.layout.ensureCanvasHost();
      this.layout.onViewportChange();
    }
    try {
      this.params.render();
    } catch (error) {
      console.warn("[ComfUI Workbench] 参数面板刷新失败", error);
    }
    this.updateWorkflowName();
  }

  /* ------------------------------------------------------------- 动作 */
  async run() {
    if (this.running) {
      toast("正在执行中，请稍候", "info");
      return;
    }
    try {
      await runPrompt();
      this.setRunning(true);
      this.output.setStatus("已加入队列…");
      toast("已加入执行队列", "success", 1800);
    } catch (error) {
      console.error(error);
      toast(`运行失败：${error.message || error}`, "error", 5000);
    }
  }

  async interrupt() {
    try {
      await interruptPrompt();
      this.setRunning(false);
      this.output.clearStatus();
    } catch (error) {
      toast(`中断失败：${error.message || error}`, "error");
    }
  }

  destroy() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const unsubscribe of this.unsubscribers) unsubscribe?.();
    this.unsubscribers = [];
    this.stats?.stop();
  }
}
