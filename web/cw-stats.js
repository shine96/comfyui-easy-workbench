/**
 * 顶部资源占用条：CPU / 内存 / 显卡 / 显存 / 队列。
 *
 * 数据来自 /comfui-workbench/stats（后端采集），
 * 接口不可用时自动退化为 ComfyUI 自带的 /system_stats（无 CPU、无 GPU 利用率）。
 */

import { el, iconEl, fmtBytes, fmtPercent, levelColor, clear, button, shortDeviceName } from "./cw-ui.js";
import { fetchStats } from "./cw-comfy.js";
import { setting, KEYS } from "./cw-store.js";

export class StatsBar {
  constructor(container, options = {}) {
    this.host = container;
    this.onToggleMenu = options.onToggleMenu || (() => {});
    this.onDiagnose = options.onDiagnose || (() => {});
    this.onExit = options.onExit || (() => {});
    this.onToggleMinimal = options.onToggleMinimal || (() => {});
    this.timer = null;
    this.running = false;
    this.interval = Math.max(500, Number(setting(KEYS.pollMs, 1500)) || 1500);
    this.last = null;
    this.metrics = {};
    this.degraded = false;
    this.errorCount = 0;
    /** 暴露给自检脚本：验证型号压缩规则 */
    this.shortDeviceName = shortDeviceName;
  }

  mount() {
    clear(this.host);

    const brand = el(
      "div",
      { class: "cw-brand", title: "ComfUI Workbench" },
      el("span", { class: "cw-logo", html: iconEl("panelLeft", 16).innerHTML }),
      el("span", { class: "cw-brand-text", text: "工作台" })
    );

    this.workflowLabel = el("span", { class: "cw-wf-name", text: "未命名工作流" });
    const workflowBox = el(
      "div",
      { class: "cw-wf" },
      el("span", { class: "cw-wf-ico", html: iconEl("grid", 14).innerHTML }),
      this.workflowLabel
    );

    this.metricsHost = el("div", { class: "cw-metrics" });

    this.queueChip = this.buildMetric("queue", "队列", "queue");
    this.cpuChip = this.buildMetric("cpu", "CPU", "cpu");
    this.memChip = this.buildMetric("mem", "内存", "memory");
    this.gpuChip = this.buildMetric("gpu", "显卡", "gpu");
    this.vramChip = this.buildMetric("vram", "显存", "memory");
    this.metricsHost.append(this.cpuChip, this.memChip, this.gpuChip, this.vramChip, this.queueChip);

    const actions = el(
      "div",
      { class: "cw-bar-actions" },
      // 最重要的逃生出口：浏览器可能吃掉 Ctrl+Shift+B，所以必须有一个看得见、点得到的按钮
      (this.exitButton = button("原生界面", {
        iconName: "expand",
        title: "回到 ComfyUI 原生界面（侧栏 / 设置 / 插件管理 / 重启都会回来）",
        className: "cw-btn-exit",
        onClick: () => this.onExit(),
      })),
      (this.menuButton = button("原生菜单", {
        iconName: "settings",
        title: "显示/隐藏 ComfyUI 原生顶栏",
        className: "cw-btn-menu",
        onClick: () => this.onToggleMenu(),
      })),
      (this.refreshButton = button("", {
        iconName: "refresh",
        title: "立即刷新资源占用",
        iconOnly: true,
        onClick: () => this.refresh(true),
      })),
      (this.minimalButton = button("", {
        iconName: "grid",
        title: "极简画布：只显示流程节点（收起画布菜单 / FPS / 浮动工具条）",
        iconOnly: true,
        className: "cw-btn-minimal",
        onClick: () => this.onToggleMinimal(),
      })),
      (this.diagnoseButton = button("", {
        iconName: "bug",
        title: "诊断界面（Ctrl+Shift+D）：画布接管 / 隐藏规则 / 参数提取 / 后端接口",
        iconOnly: true,
        className: "cw-btn-diag",
        onClick: () => this.onDiagnose(),
      }))
    );

    this.host.append(brand, workflowBox, el("div", { class: "cw-spacer" }), this.metricsHost, actions);
    return this;
  }

  buildMetric(key, label, iconName) {
    const value = el("span", { class: "cw-metric-value", text: "—" });
    // 简短型号标签（目前只有显卡用；为空时 CSS 会自动隐藏）
    const tag = el("span", { class: "cw-metric-tag", text: "" });
    const bar = el("i", { class: "cw-meter-fill" });
    const chip = el(
      "div",
      { class: "cw-metric", dataset: { key } },
      el("span", { class: "cw-metric-ico", html: iconEl(iconName, 15).innerHTML }),
      el(
        "div",
        { class: "cw-metric-body" },
        el(
          "div",
          { class: "cw-metric-row" },
          el("span", { class: "cw-metric-label", text: label }),
          tag,
          value
        ),
        el("div", { class: "cw-meter" }, bar)
      )
    );
    this.metrics[key] = { chip, value, bar, tag };
    return chip;
  }

  setWorkflowName(name) {
    if (!this.workflowLabel) return;
    this.workflowLabel.textContent = name || "未命名工作流";
    this.workflowLabel.title = name || "";
  }

  setQueue(running, pending) {
    const target = this.metrics.queue;
    if (!target) return;
    const total = Number(running || 0) + Number(pending || 0);
    target.value.textContent = total === 0 ? "空闲" : `${running || 0} 运行 / ${pending || 0} 等待`;
    target.bar.style.width = total === 0 ? "0%" : "100%";
    target.bar.style.background = total === 0 ? "var(--cw-muted)" : "var(--cw-accent-2)";
    target.chip.classList.toggle("cw-active", total > 0);
  }

  setProgress(value, max) {
    const target = this.metrics.queue;
    if (!target || !max) return;
    const percent = Math.max(0, Math.min(100, (Number(value) / Number(max)) * 100));
    target.value.textContent = `${Math.round(percent)}%`;
    target.bar.style.width = `${percent}%`;
    target.bar.style.background = "var(--cw-accent-2)";
  }

  async refresh(force = false) {
    if (this.running && !force) return;
    this.running = true;
    try {
      const stats = await fetchStats();
      this.last = stats;
      this.errorCount = 0;
      this.render(stats);
    } catch (error) {
      this.errorCount += 1;
      if (this.errorCount <= 2) console.warn("[ComfUI Workbench] 资源占用获取失败", error);
      this.setUnavailable();
    } finally {
      this.running = false;
    }
  }

  render(stats) {
    const { cpu = {}, memory = {}, devices = [], queue = {} } = stats || {};

    /* CPU */
    const cpuPercent = numberOrNull(cpu.percent);
    this.setGauge("cpu", cpuPercent, fmtPercent(cpuPercent), {
      title: [
        cpu.name || "",
        cpu.count ? `${cpu.count} 核心` : "",
        cpu.freq_mhz ? `${(cpu.freq_mhz / 1000).toFixed(2)} GHz` : "",
        cpu.loadavg ? `负载 ${cpu.loadavg.join(" / ")}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    });

    /* 内存 */
    const memPercent = numberOrNull(memory.percent);
    this.setGauge(
      "mem",
      memPercent,
      memory.total ? `${fmtBytes(memory.used)} / ${fmtBytes(memory.total)}` : fmtPercent(memPercent),
      {
        title: memory.total
          ? `内存 ${fmtBytes(memory.used)} / ${fmtBytes(memory.total)}（可用 ${fmtBytes(
              memory.available ?? memory.free
            )}）`
          : "内存信息不可用",
        label: fmtPercent(memPercent),
      }
    );

    /* 显卡 + 显存 */
    const device = pickDevice(devices);
    if (device) {
      const util = numberOrNull(device.utilization);
      const typeLabel = device.type ? String(device.type).toUpperCase() : "";
      this.setGauge("gpu", util, util === null ? typeLabel || "—" : fmtPercent(util), {
        title: [device.name, typeLabel, device.temperature ? `${device.temperature}℃` : "", devices.length > 1 ? `共 ${devices.length} 个设备` : ""]
          .filter(Boolean)
          .join(" · "),
        label: device.name || "",
        // 顶部显示简短型号，例如 RTX 4090 / M2 Max
        tag: shortDeviceName(device.name || typeLabel || ""),
      });

      const vramPercent =
        device.vram_total && device.vram_used !== null && device.vram_used !== undefined
          ? (device.vram_used / device.vram_total) * 100
          : null;
      this.setGauge(
        "vram",
        vramPercent,
        device.vram_total
          ? `${fmtBytes(device.vram_used)} / ${fmtBytes(device.vram_total)}`
          : "—",
        {
          title: device.vram_total
            ? `${device.unified_memory ? "统一内存" : "显存"} ${fmtBytes(device.vram_used)} / ${fmtBytes(
                device.vram_total
              )}（可用 ${fmtBytes(device.vram_free)}）`
            : "显存信息不可用",
          label: fmtPercent(vramPercent),
        }
      );
    } else {
      this.setGauge("gpu", null, "—", { title: "未检测到 GPU（CPU 模式）", tag: "" });
      this.setGauge("vram", null, "—", { title: "未检测到 GPU（CPU 模式）" });
    }

    /* 队列 */
    if (queue && !queue.unknown) this.setQueue(queue.running, queue.pending);

    /* 降级提示 */
    const degraded = Boolean(stats && stats.degraded);
    if (degraded !== this.degraded) {
      this.degraded = degraded;
      this.host.classList.toggle("cw-degraded", degraded);
      if (degraded) {
        this.host.title = "后端 /comfui-workbench/stats 不可用，已退化为 /system_stats（无 CPU 与 GPU 利用率）";
      } else {
        this.host.removeAttribute("title");
      }
    }
  }

  setGauge(key, percent, text, options = {}) {
    const target = this.metrics[key];
    if (!target) return;
    target.value.textContent = text ?? "—";
    if (options.title) target.chip.title = options.title;
    if (options.label) target.chip.dataset.label = options.label;
    if (target.tag && options.tag !== undefined) {
      target.tag.textContent = options.tag || "";
      target.tag.title = options.label || options.tag || "";
    }
    const known = Number.isFinite(Number(percent));
    target.bar.style.width = known ? `${Math.max(2, Math.min(100, Number(percent)))}%` : "0%";
    target.bar.style.background = known ? levelColor(Number(percent)) : "var(--cw-muted)";
    target.chip.classList.toggle("cw-unknown", !known);
  }

  setUnavailable() {
    for (const key of ["cpu", "mem", "gpu", "vram"]) {
      const target = this.metrics[key];
      if (!target) continue;
      target.value.textContent = "—";
      target.bar.style.width = "0%";
    }
    this.host.classList.add("cw-degraded");
    this.host.title = "无法获取资源占用（请确认插件后端已加载）";
  }

  start() {
    this.stop();
    this.refresh(true);
    this.timer = setInterval(() => {
      if (document.hidden) return;
      this.refresh();
    }, this.interval);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  onVisibility = () => {
    if (!document.hidden) this.refresh(true);
  };
}

function pickDevice(devices) {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  const withVram = devices.find((device) => device.vram_total);
  return withVram || devices[0];
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
