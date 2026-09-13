/**
 * 工作台总控：把布局、资源条、参数面板、输出面板串起来，并接管 ComfyUI 事件。
 */

import { toast, debounce } from "./cw-ui.js";
import { store, setting, setSetting, KEYS } from "./cw-store.js";
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
import { collectDiagnostics, openDiagnostics } from "./cw-diag.js";
import { CanvasPolish } from "./cw-canvas.js";
import { FlowView } from "./cw-flow.js";

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
      onDiagnose: () => this.diagnose(),
      onExit: () => this.toggle(),
      onToggleMinimal: () => this.toggleMinimal(),
      onToggleFlow: () => this.toggleFlowView(),
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

    this.canvas = new CanvasPolish();
    this.flow = new FlowView(refs.flow).mount();

    this.bindEvents();
    this.syncMenuButton();
    this.syncMinimalButton();
    this.syncFlowButton();

    this.stats.start();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);

    this.setEnabled(setting(KEYS.enabled, true) !== false);
    // 启动 2.5 秒后做一次布局体检：把「原生界面被挡住」这类问题直接说出来
    setTimeout(() => this.selfCheck(), 2500);
    return this;
  }

  /**
   * 布局自检：只做只读检查 + 提示，不改用户设置。
   * 目标是让「点了原生按钮没反应」这种情况自己说出原因，而不是让人去猜。
   */
  selfCheck() {
    if (!this.enabled) return [];
    const issues = [];

    if (!this.layout.canvasHost || !this.layout.canvasHost.isConnected) {
      issues.push("没找到画布容器，画布不会被挤到中间（设置里可填「画布容器选择器」）");
    }

    const menu = this.layout.findMenu();
    if (!menu) {
      issues.push("没找到 ComfyUI 原生顶栏，资源条可能压在顶部");
    } else if (!this.layout.hideNativeMenu) {
      const menuRect = menu.getBoundingClientRect();
      const barRect = this.stats?.host?.getBoundingClientRect();
      if (menuRect.height > 0 && barRect && barRect.top < menuRect.bottom - 1) {
        issues.push(
          `资源条和原生顶栏重叠（顶栏底部 ${Math.round(menuRect.bottom)}px，资源条顶部 ${Math.round(
            barRect.top
          )}px），顶栏按钮可能点不到`
        );
        // 能自愈就自愈：重新量一次顶栏高度
        this.layout.measureMenu();
      }
    }

    if (issues.length) {
      console.warn(
        `[ComfUI Workbench] 布局自检发现问题：\n  - ${issues.join(
          "\n  - "
        )}\n可点顶栏「原生界面」按钮回到原生界面，或按 Ctrl+Shift+D 查看完整诊断报告。`
      );
      toast("工作台布局自检发现问题，点顶栏「原生界面」可立即回到原生界面", "error", 9000);
    }
    return issues;
  }

  /* ------------------------------------------------------------- 开关 */
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    const flowOn = this.enabled && setting(KEYS.flowView, true) !== false;
    this.layout.setEnabled(this.enabled);
    this.canvas?.setEnabled(this.enabled, { flowView: flowOn });
    // 中间显示简约流程图（可在顶栏一键切回原生画布）
    this.setFlowView(flowOn);
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

  /** 中间区域：简约流程图 or 原生画布 */
  setFlowView(on) {
    const active = Boolean(on) && this.enabled;
    this.layout.setFlowMode(active);
    this.flow?.setEnabled(active);
    this.syncFlowButton();
    return active;
  }

  toggleFlowView() {
    const next = !(this.flow?.enabled === true);
    setSetting(KEYS.flowView, next);
    this.setFlowView(next);
    toast(next ? "中间已切到简约流程图" : "中间已切回原生画布（可拖拽编辑）", "info", 2000);
  }

  syncFlowButton() {
    if (!this.stats?.flowButton) return;
    const on = this.flow?.enabled === true;
    this.stats.flowButton.classList.toggle("cw-on", on);
    const label = this.stats.flowButton.querySelector(".cw-btn-label");
    if (label) label.textContent = on ? "流程图" : "原生画布";
    this.stats.flowButton.title = on
      ? "中间正在显示简约流程图（点一下切回原生画布去编辑）"
      : "中间正在显示原生画布（点一下只看简约流程图）";
  }

  toggleNativeMenu() {
    this.layout.setHideNativeMenu(!this.layout.hideNativeMenu);
    this.syncMenuButton();
  }

  /** 极简画布开关（顶栏图标按钮 / 设置项共用） */
  toggleMinimal() {
    const next = setting(KEYS.canvasMinimal, true) === false;
    setSetting(KEYS.canvasMinimal, next);
    this.canvas?.setMinimal(next);
    this.syncMinimalButton();
    toast(next ? "已开启极简画布" : "已显示画布菜单 / FPS / 工具条", "info", 1800);
  }

  syncMinimalButton() {
    if (!this.stats?.minimalButton) return;
    const on = setting(KEYS.canvasMinimal, true) !== false;
    this.stats.minimalButton.classList.toggle("cw-on", on);
    this.stats.minimalButton.title = on
      ? "极简画布已开启（点一下显示画布菜单 / FPS / 工具条）"
      : "极简画布已关闭（点一下只显示流程节点）";
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
        this.setActiveNode(null);
      } else {
        this.setRunning(true);
        this.setActiveNode(detail.node ?? detail.display_node ?? null);
      }
    });

    sub("progress", (event) => {
      const detail = event?.detail || {};
      this.output.setProgress(detail);
      if (detail.max) this.stats.setProgress(detail.value, detail.max);
      if (detail.node) this.setActiveNode(detail.node);
    });

    sub("execution_error", (event) => {
      this.setRunning(false);
      this.output.clearStatus();
      this.setActiveNode(null);
      const message = event?.detail?.exception_message || event?.detail?.error || "执行出错";
      toast(String(message).slice(0, 160), "error", 6000);
    });

    sub("execution_interrupted", () => {
      this.setRunning(false);
      this.output.clearStatus();
      this.setActiveNode(null);
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

    // 工作流切换 / 节点变化 → 重建参数面板 + 重画流程图
    const invalidate = debounce(() => {
      this.params.signature = "";
      this.params.render(true);
      this.updateWorkflowName();
      this.flow?.refresh();
    }, 200);

    sub("afterConfigureGraph", invalidate);
    sub("workflowLoaded", invalidate);
    sub("nodeCreated", invalidate);
    sub("nodeRemoved", invalidate);
    sub("graphChanged", invalidate);

    window.addEventListener(
      "resize",
      debounce(() => this.layout.onViewportChange(), 120)
    );

    // Ctrl/Cmd + Shift + D 诊断（新前端 command 未生效时的兜底）。
    // 不再自己抢 Ctrl+Enter：它属于 ComfyUI 原生的 Comfy.QueuePrompt，
    // 抢了会和原生快捷键重复触发（一次按键入队两次）。
    window.addEventListener("keydown", (event) => {
      if (!this.enabled) return;
      // 原生快捷键服务已经处理过这个组合（会 preventDefault），别再触发一次
      if (event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && String(event.key).toLowerCase() === "d") {
        event.preventDefault();
        this.diagnose();
      }
    });
  }

  setRunning(running) {
    this.running = Boolean(running);
    this.params.setRunning(this.running);
  }

  /** 执行状态统一入口：原生画布动效 + 流程图高亮 */
  setActiveNode(nodeId) {
    this.canvas?.setActiveNode(nodeId);
    this.flow?.setActiveNode(nodeId);
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
    // 流程图：节点增删改名后自检重画（签名没变时是空操作）
    try {
      this.flow?.refresh();
    } catch (error) {
      console.warn("[ComfUI Workbench] 流程图刷新失败", error);
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

  /* ------------------------------------------------------------- 诊断 */
  /** 只采集报告，不弹面板（自检脚本 / 控制台用） */
  diagnostics() {
    return collectDiagnostics(this);
  }

  /** 一键诊断：弹出可复制的报告面板，同时把原始对象挂到控制台 */
  async diagnose() {
    try {
      const report = await openDiagnostics(this);
      console.info("[ComfUI Workbench] 诊断报告", report);
      return report;
    } catch (error) {
      console.error("[ComfUI Workbench] 诊断失败", error);
      toast(`诊断失败：${error.message || error}`, "error", 5000);
      return null;
    }
  }

  destroy() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const unsubscribe of this.unsubscribers) unsubscribe?.();
    this.unsubscribers = [];
    this.stats?.stop();
    this.flow?.destroy();
    this.canvas?.destroy();
  }
}
