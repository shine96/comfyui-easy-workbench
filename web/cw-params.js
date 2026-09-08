/**
 * 左侧「提示词 / 参数」面板。
 *
 * 自动从当前画布中提取常用参数：
 *   - 文本类 widget（CLIPTextEncode 的 text 等）→ 多行文本框，并自动标注 正面/负面
 *   - 数值 / 下拉 / 开关 widget → 对应的原生控件
 * 改动会立即写回节点；节点上的改动也会同步回面板（每 700ms 对比一次，避开正在输入的控件）。
 *
 * 结构变化（换工作流、增删节点）时按「签名」重建；仅数值变化时只做同步，避免打断输入。
 */

import {
  el,
  clear,
  iconEl,
  button,
  toast,
  debounce,
  clamp,
  fmtAgo,
} from "./cw-ui.js";
import { store, KEYS, setting } from "./cw-store.js";
import {
  getNodes,
  getLink,
  setWidgetValue,
  graphToWorkflowJson,
  loadWorkflowData,
  fetchWorkflows,
  readWorkflow,
  writeWorkflow,
  runPrompt,
  interruptPrompt,
} from "./cw-comfy.js";

const TEXT_HINT = /(text|prompt|positive|negative|string|描述|提示)/i;
const PROMPT_NODE_HINT = /(cliptextencode|textencode|text encode|prompt|text)/i;
const NEGATIVE_HINT = /(neg|负面|负向|反向)/i;
const POSITIVE_HINT = /(pos|正面|正向)/i;

export class ParamsPanel {
  constructor({ head, body, foot, onRun, onInterrupt, onWorkflowChange }) {
    this.head = head;
    this.body = body;
    this.foot = foot;
    this.onRun = onRun || (() => {});
    this.onInterrupt = onInterrupt || (() => {});
    this.onWorkflowChange = onWorkflowChange || (() => {});
    this.controls = [];
    this.signature = "";
    this.workflows = [];
    this.onlyStars = store.get(KEYS.onlyStars, false) === true;
    this.busy = false;
  }

  mount() {
    this.mountHead();
    this.mountFoot();
    this.render();
    return this;
  }

  /* ------------------------------------------------------------- 顶部 */
  mountHead() {
    clear(this.head);

    this.wfSelect = el("select", {
      class: "cw-select cw-wf-select",
      title: "选择用户工作流目录下的工作流",
      on: {
        change: () => this.loadSelectedWorkflow(),
      },
    });

    const reload = button("", {
      iconName: "refresh",
      title: "重新扫描工作流目录",
      iconOnly: true,
      onClick: () => this.refreshWorkflows(true),
    });
    const save = button("", {
      iconName: "save",
      title: "把当前画布另存为工作流",
      iconOnly: true,
      onClick: () => this.saveAs(),
    });

    this.starFilter = button("常用", {
      iconName: "star",
      title: "只显示已收藏的参数",
      onClick: () => {
        this.onlyStars = !this.onlyStars;
        store.set(KEYS.onlyStars, this.onlyStars);
        this.starFilter.classList.toggle("cw-on", this.onlyStars);
        this.signature = "";
        this.render();
      },
    });
    this.starFilter.classList.toggle("cw-on", this.onlyStars);

    this.head.append(
      el("div", { class: "cw-wf-row" }, this.wfSelect, reload, save),
      el(
        "div",
        { class: "cw-head-row" },
        el("span", { class: "cw-head-title", text: "提示词与参数" }),
        el("div", { class: "cw-spacer" }),
        this.starFilter
      )
    );
  }

  mountFoot() {
    clear(this.foot);

    this.runButton = el(
      "button",
      {
        class: "cw-run",
        type: "button",
        title: "把当前工作流加入队列（Ctrl + Enter）",
        on: { click: () => this.onRun() },
      },
      el("span", { class: "cw-run-ico", html: iconEl("play", 20).innerHTML }),
      el("span", { class: "cw-run-text", text: "运行" }),
      el("span", { class: "cw-run-hint", text: "Ctrl+↵" })
    );

    this.stopButton = button("停止", {
      iconName: "stop",
      className: "cw-stop",
      title: "中断当前执行",
      onClick: () => this.onInterrupt(),
    });
    this.stopButton.disabled = true;

    this.queueText = el("span", { class: "cw-queue-text", text: "队列空闲" });

    this.foot.append(
      el("div", { class: "cw-run-row" }, this.runButton, this.stopButton),
      el("div", { class: "cw-foot-meta" }, this.queueText)
    );
  }

  setRunning(running) {
    this.stopButton.disabled = !running;
    this.runButton.classList.toggle("cw-busy", Boolean(running));
  }

  setQueue(running, pending) {
    if (!this.queueText) return;
    const total = Number(running || 0) + Number(pending || 0);
    this.queueText.textContent =
      total === 0 ? "队列空闲" : `运行中 ${running || 0} · 等待 ${pending || 0}`;
    this.setRunning(Number(running || 0) > 0);
  }

  /* ------------------------------------------------------------- 工作流 */
  async refreshWorkflows(force = false) {
    try {
      const { items } = await fetchWorkflows();
      this.workflows = items;
      const previous = this.wfSelect.value;
      clear(this.wfSelect);
      this.wfSelect.append(el("option", { value: "", text: `选择工作流…（${items.length}）` }));
      for (const item of items) {
        this.wfSelect.append(
          el("option", {
            value: item.name,
            text: `${item.label}${item.mtime ? `  ·  ${fmtAgo(item.mtime)}` : ""}`,
          })
        );
      }
      if (previous && items.some((item) => item.name === previous)) this.wfSelect.value = previous;
      if (force) toast(`已找到 ${items.length} 个工作流`, "success");
    } catch (error) {
      console.warn("[ComfUI Workbench] 工作流列表获取失败", error);
      clear(this.wfSelect);
      this.wfSelect.append(el("option", { value: "", text: "工作流目录不可用" }));
    }
  }

  async loadSelectedWorkflow() {
    const name = this.wfSelect.value;
    if (!name) return;
    try {
      const workflow = await readWorkflow(name);
      if (!workflow) throw new Error("工作流为空");
      await loadWorkflowData(workflow);
      toast(`已载入 ${name}`, "success");
      this.onWorkflowChange(name.replace(/\.json$/i, ""));
    } catch (error) {
      console.error(error);
      toast(`载入失败：${error.message || error}`, "error");
    }
  }

  async saveAs() {
    try {
      const suggested = this.wfSelect.value || "my-workflow.json";
      const name = window.prompt("保存为（可带子目录，例如 我的/风景.json）", suggested);
      if (!name) return;
      const workflow = await graphToWorkflowJson();
      const result = await writeWorkflow(name, workflow);
      if (!result.ok) throw new Error(result.error || "保存失败");
      toast(`已保存：${result.name}`, "success");
      await this.refreshWorkflows();
      this.wfSelect.value = result.name;
    } catch (error) {
      console.error(error);
      toast(`保存失败：${error.message || error}`, "error");
    }
  }

  /* ------------------------------------------------------------- 渲染 */
  render(force = false) {
    const nodes = getNodes();
    const signature = buildSignature(nodes);
    if (!force && signature === this.signature) {
      this.syncValues();
      return;
    }
    this.signature = signature;
    this.controls = [];
    clear(this.body);

    const groups = collectGroups(nodes, this.onlyStars);
    if (groups.length === 0) {
      this.body.append(
        el(
          "div",
          { class: "cw-empty" },
          iconEl("text", 22),
          el("p", { text: "没有可显示的参数" }),
          el("p", {
            class: "cw-empty-hint",
            text: "在中间画布里添加节点后会自动出现；也可以用「常用」筛选。",
          })
        )
      );
      return;
    }

    for (const group of groups) this.body.append(this.renderGroup(group));
    this.syncValues();
  }

  renderGroup(group) {
    const collapsed = isCollapsed(group.key);
    const content = el("div", { class: "cw-group-body" });
    for (const entry of group.entries) {
      const row = this.renderRow(entry);
      if (row) content.append(row);
    }

    const chevron = el("span", { class: "cw-chev", html: iconEl(collapsed ? "chevronRight" : "chevronDown", 15).innerHTML });
    const header = el(
      "div",
      {
        class: "cw-group-head",
        on: {
          click: () => {
            const next = !isCollapsed(group.key);
            setCollapsed(group.key, next);
            chevron.innerHTML = iconEl(next ? "chevronRight" : "chevronDown", 15).innerHTML;
            content.classList.toggle("cw-collapsed", next);
          },
        },
      },
      chevron,
      el("span", { class: "cw-group-title", text: group.title, title: group.title }),
      group.badge
        ? el("span", { class: ["cw-badge", `cw-badge-${group.badgeKind || "plain"}`], text: group.badge })
        : null,
      el("span", { class: "cw-spacer" }),
      el("span", { class: "cw-group-count", text: String(group.entries.length) })
    );

    content.classList.toggle("cw-collapsed", collapsed);
    return el("section", { class: "cw-group" }, header, content);
  }

  renderRow(entry) {
    const { node, widget } = entry;
    const key = starKey(node, widget);
    const starred = isStarred(key);

    const star = el("button", {
      class: ["cw-star", starred ? "cw-on" : ""],
      type: "button",
      title: starred ? "取消常用" : "标记为常用",
      html: iconEl(starred ? "star" : "starOutline", 14).innerHTML,
      on: {
        click: (event) => {
          event.stopPropagation();
          const next = !isStarred(key);
          setStarred(key, next);
          star.classList.toggle("cw-on", next);
          star.innerHTML = iconEl(next ? "star" : "starOutline", 14).innerHTML;
          if (this.onlyStars) {
            this.signature = "";
            this.render(true);
          }
        },
      },
    });

    let control = null;
    let extra = null;

    if (entry.kind === "text") {
      if (entry.multiline === false) {
        // 单行文本（例如 filename_prefix）
        control = el("input", {
          class: "cw-input",
          type: "text",
          value: String(widget.value ?? ""),
          spellcheck: false,
          on: {
            input: debounce((event) => writeValue(node, widget, event.target.value), 260),
          },
        });
      } else {
        control = el("textarea", {
          class: "cw-textarea",
          rows: 3,
          value: String(widget.value ?? ""),
          spellcheck: false,
          on: {
            input: debounce((event) => {
              const target = event.target;
              autoGrow(target);
              writeValue(node, widget, target.value);
            }, 260),
            focus: () => autoGrow(control),
          },
        });
        autoGrow(control);
      }
      extra = el(
        "button",
        {
          class: "cw-inline-btn",
          type: "button",
          title: "清空",
          html: iconEl("close", 12).innerHTML,
          on: {
            click: () => {
              control.value = "";
              autoGrow(control);
              writeValue(node, widget, "");
            },
          },
        }
      );
    } else if (entry.kind === "combo") {
      control = el("select", {
        class: "cw-select",
        on: {
          change: (event) => writeValue(node, widget, event.target.value),
        },
      });
      const values = entry.values || [];
      if (!values.includes(String(widget.value)) && widget.value !== undefined) {
        control.append(el("option", { value: String(widget.value), text: String(widget.value) }));
      }
      for (const value of values) {
        control.append(el("option", { value: String(value), text: String(value) }));
      }
      control.value = String(widget.value ?? "");
    } else if (entry.kind === "bool") {
      control = el("input", {
        class: "cw-check",
        type: "checkbox",
        checked: Boolean(widget.value),
        on: {
          change: (event) => writeValue(node, widget, event.target.checked),
        },
      });
    } else {
      const options = widget.options || {};
      control = el("input", {
        class: "cw-input",
        type: "number",
        value: Number(widget.value ?? 0),
        step: options.step ?? (Number.isInteger(widget.value) ? 1 : 0.01),
        attrs: {
          min: options.min ?? undefined,
          max: options.max ?? undefined,
        },
        on: {
          change: (event) => {
            const raw = event.target.value;
            const next = Number(raw);
            if (!Number.isFinite(next)) {
              event.target.value = widget.value;
              return;
            }
            writeValue(node, widget, Number.isInteger(widget.value) ? Math.round(next) : next);
          },
        },
      });
      if (entry.kind === "seed") {
        extra = el(
          "button",
          {
            class: "cw-inline-btn",
            type: "button",
            title: "随机种子",
            html: iconEl("dice", 13).innerHTML,
            on: {
              click: () => {
                const next = Math.floor(Math.random() * 1e15);
                control.value = next;
                writeValue(node, widget, next);
              },
            },
          }
        );
      }
    }

    const label = el(
      "div",
      { class: "cw-field-label" },
      el("span", { class: "cw-field-name", text: entry.label, title: `${node.type} · ${widget.name}` }),
      extra
    );

    const field = el(
      "div",
      { class: ["cw-field", `cw-field-${entry.kind}`] },
      el("div", { class: "cw-field-top" }, label, star),
      control
    );

    this.controls.push({ node, widget, control, kind: entry.kind });
    return field;
  }

  /* ------------------------------------------------------------- 同步 */
  syncValues() {
    for (const entry of this.controls) {
      const { control, widget } = entry;
      if (!control || !control.isConnected) continue;
      if (document.activeElement === control) continue;
      const value = widget.value;
      if (entry.kind === "bool") {
        if (control.checked !== Boolean(value)) control.checked = Boolean(value);
      } else if (entry.kind === "text") {
        const text = String(value ?? "");
        if (control.value !== text) {
          control.value = text;
          autoGrow(control);
        }
      } else if (entry.kind === "combo") {
        const text = String(value ?? "");
        if (control.value !== text) control.value = text;
      } else {
        const num = Number(value);
        if (Number.isFinite(num) && Number(control.value) !== num) control.value = String(num);
      }
    }
  }
}

/* ------------------------------------------------------------------ 工具 */

function writeValue(node, widget, value) {
  try {
    setWidgetValue(node, widget, value);
  } catch (error) {
    console.warn("[ComfUI Workbench] 写入参数失败", error);
    toast("写入参数失败，请查看控制台", "error");
  }
}

function autoGrow(textarea) {
  if (!textarea || textarea.tagName !== "TEXTAREA") return;
  textarea.style.height = "auto";
  const height = clamp(textarea.scrollHeight, 62, 300);
  textarea.style.height = `${height}px`;
}

function buildSignature(nodes) {
  return nodes
    .map((node) => {
      const widgets = node.widgets || [];
      return `${node.id}:${node.type}:${node.title || ""}:${widgets
        .map((widget) => `${widget.name}=${widget.type || typeof widget.value}`)
        .join(",")}`;
    })
    .join("|");
}

function isCombo(widget) {
  return (
    widget.type === "combo" ||
    (widget.options && Array.isArray(widget.options.values) && widget.options.values.length > 0)
  );
}

function isTextWidget(widget) {
  if (isCombo(widget)) return false;
  if (widget.type === "text" || widget.type === "customtext" || widget.type === "string") return true;
  if (widget.multiline) return true;
  if (typeof widget.value === "string" && TEXT_HINT.test(widget.name || "")) return true;
  return false;
}

/** 判断文本 widget 是否需要多行输入框（提示词要，文件名前缀不要） */
function isMultilineText(widget) {
  if (widget.multiline) return true;
  if (widget.type === "customtext") return true;
  const name = String(widget.name || "").toLowerCase();
  if (["text", "prompt", "positive", "negative", "system_prompt"].includes(name)) return true;
  if (typeof widget.value === "string" && widget.value.length > 80) return true;
  return false;
}

function classify(node, widget) {
  if (!widget || widget.type === "button" || widget.type === "hidden") return null;
  if (widget.options && widget.options.serialize === false) return null;
  if (isTextWidget(widget)) return { kind: "text", multiline: isMultilineText(widget) };
  if (isCombo(widget)) return { kind: "combo", values: widget.options.values.map(String) };
  if (typeof widget.value === "boolean" || widget.type === "toggle") return { kind: "bool" };
  if (typeof widget.value === "number") {
    if (/seed|noise_seed|rand/i.test(widget.name || "")) return { kind: "seed" };
    return { kind: "number" };
  }
  return null;
}

function prettyLabel(name) {
  const map = {
    text: "提示词",
    positive: "正面提示词",
    negative: "负面提示词",
    ckpt_name: "模型",
    sampler_name: "采样器",
    scheduler: "调度器",
    steps: "步数",
    cfg: "CFG 强度",
    seed: "种子",
    denoise: "降噪强度",
    width: "宽度",
    height: "高度",
    batch_size: "批次大小",
    lora_name: "LoRA",
    strength_model: "模型强度",
    strength_clip: "CLIP 强度",
    filename_prefix: "文件名前缀",
    control_after_generate: "生成后操作",
    vae_name: "VAE",
    clip_name: "CLIP",
    unet_name: "UNet",
    guidance: "引导强度",
    max_shift: "最大偏移",
    base_shift: "基础偏移",
  };
  if (map[name]) return map[name];
  return String(name || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** 判断某个节点的文本 widget 是正面还是负面（通过输出连线推断，再退化到标题关键词） */
function promptRoles(nodes) {
  const roles = new Map();
  for (const node of nodes) {
    for (const input of node.inputs || []) {
      const name = String(input.name || "").toLowerCase();
      if (name !== "positive" && name !== "negative") continue;
      const link = getLink(input.link);
      if (link) roles.set(String(link.origin_id), name);
    }
  }
  return roles;
}

function collectGroups(nodes, onlyStars) {
  const roles = promptRoles(nodes);
  const groups = [];

  for (const node of nodes) {
    const widgets = node.widgets || [];
    const entries = [];
    for (const widget of widgets) {
      const info = classify(node, widget);
      if (!info) continue;
      if (onlyStars && !isStarred(starKey(node, widget))) continue;
      entries.push({
        node,
        widget,
        kind: info.kind,
        values: info.values,
        multiline: info.multiline,
        label: prettyLabel(widget.name),
      });
    }
    if (entries.length === 0) continue;

    const title = node.title || node.type || `节点 ${node.id}`;
    let badge = null;
    let badgeKind = "plain";
    const role = roles.get(String(node.id));
    if (role === "positive") {
      badge = "正面";
      badgeKind = "pos";
    } else if (role === "negative") {
      badge = "负面";
      badgeKind = "neg";
    } else if (NEGATIVE_HINT.test(title)) {
      badge = "负面";
      badgeKind = "neg";
    } else if (POSITIVE_HINT.test(title)) {
      badge = "正面";
      badgeKind = "pos";
    }

    groups.push({
      key: `${node.type}::${title}`,
      title,
      badge,
      badgeKind,
      entries,
      priority: groupPriority(node, role),
    });
  }

  groups.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title, "zh-Hans-CN"));
  return groups;
}

function groupPriority(node, role) {
  const type = String(node.type || "").toLowerCase();
  const title = String(node.title || "").toLowerCase();
  const isPromptNode = PROMPT_NODE_HINT.test(type) || PROMPT_NODE_HINT.test(title);
  if (role === "positive") return 0;
  if (role === "negative") return 1;
  if (isPromptNode) return 2;
  if (/sampler|ksampler/.test(type)) return 3;
  if (/latent|size|empty/.test(type)) return 4;
  if (/loader|checkpoint|lora|vae|clip/.test(type)) return 5;
  return 6;
}

/* ---------------------------------------------------------------- 收藏 / 折叠 */
function starKey(node, widget) {
  return `${node.type}::${widget.name}`;
}

function stars() {
  const value = store.get(KEYS.stars, []);
  return Array.isArray(value) ? value : [];
}

function isStarred(key) {
  return stars().includes(key);
}

function setStarred(key, value) {
  const list = new Set(stars());
  if (value) list.add(key);
  else list.delete(key);
  store.set(KEYS.stars, [...list]);
}

function collapsed() {
  const value = store.get(KEYS.collapsed, []);
  return Array.isArray(value) ? value : [];
}

function isCollapsed(key) {
  return collapsed().includes(key);
}

function setCollapsed(key, value) {
  const list = new Set(collapsed());
  if (value) list.add(key);
  else list.delete(key);
  store.set(KEYS.collapsed, [...list]);
}
