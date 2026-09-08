/**
 * 右侧「输出」面板：本次会话产物 + 输出目录里的历史产物。
 *
 * 数据来源：
 *   - ComfyUI 的 executed / progress 事件（实时）
 *   - /comfui-workbench/outputs（历史，按修改时间倒序）
 * 媒体通过 /view 接口读取，点击卡片可放大预览（图片支持滚轮缩放/拖拽平移）。
 */

import {
  el,
  clear,
  iconEl,
  button,
  toast,
  fmtBytes,
  fmtAgo,
  clamp,
  throttle,
  openContextMenu,
  confirmDialog,
} from "./cw-ui.js";
import { fetchOutputs, revealFile, deleteOutput, viewUrl } from "./cw-comfy.js";

const KINDS = [
  { id: "all", label: "全部" },
  { id: "image", label: "图片" },
  { id: "video", label: "视频" },
  { id: "audio", label: "音频" },
  { id: "text", label: "文本" },
];

export class OutputPanel {
  constructor({ head, body, foot, onCountChange }) {
    this.head = head;
    this.body = body;
    this.foot = foot;
    this.onCountChange = onCountChange || (() => {});
    this.items = new Map();
    this.order = [];
    this.filter = "all";
    this.directory = "";
    this.lightboxIndex = -1;
    this.lightboxList = [];
  }

  mount() {
    this.mountHead();
    this.mountBody();
    this.mountFoot();
    return this;
  }

  mountHead() {
    clear(this.head);

    this.countLabel = el("span", { class: "cw-count", text: "0" });

    this.filterSelect = el(
      "select",
      {
        class: "cw-select cw-filter",
        on: {
          change: (event) => {
            this.filter = event.target.value;
            this.render();
          },
        },
      },
      ...KINDS.map((kind) => el("option", { value: kind.id, text: kind.label }))
    );

    this.progressBar = el("i", { class: "cw-progress-fill" });
    this.progressWrap = el("div", { class: "cw-progress" }, this.progressBar);
    this.progressText = el("span", { class: "cw-progress-text", text: "" });
    this.progressRow = el(
      "div",
      { class: "cw-progress-row cw-hidden" },
      this.progressText,
      this.progressWrap
    );

    this.head.append(
      el(
        "div",
        { class: "cw-head-row" },
        el("span", { class: "cw-head-title", text: "输出结果" }),
        this.countLabel,
        el("span", { class: "cw-spacer" }),
        this.filterSelect,
        button("", {
          iconName: "refresh",
          title: "重新扫描输出目录",
          iconOnly: true,
          onClick: () => this.loadHistory(true),
        })
      ),
      this.progressRow
    );
  }

  mountBody() {
    clear(this.body);
    this.grid = el("div", { class: "cw-gallery" });
    this.empty = el(
      "div",
      { class: "cw-empty" },
      iconEl("image", 24),
      el("p", { text: "还没有输出" }),
      el("p", { class: "cw-empty-hint", text: "点左侧「运行」后，生成的图片 / 视频会出现在这里。" })
    );
    this.body.append(this.grid, this.empty);
  }

  mountFoot() {
    clear(this.foot);
    this.dirLabel = el("span", { class: "cw-dir", text: "输出目录：—" });
    this.foot.append(
      this.dirLabel,
      el("span", { class: "cw-spacer" }),
      button("清空列表", {
        iconName: "trash",
        title: "只清空这里的列表，不删除磁盘文件",
        onClick: async () => {
          if (!this.order.length) return;
          const ok = await confirmDialog({
            title: "清空列表",
            message: "只会清空这里的列表，磁盘上的文件不会被删除。确定吗？",
            confirmText: "清空",
          });
          if (!ok) return;
          this.items.clear();
          this.order = [];
          this.closeLightbox();
          this.render();
        },
      })
    );
  }

  /* ------------------------------------------------------------- 数据 */
  async loadHistory(notify = false) {
    try {
      const { items, directory } = await fetchOutputs(240);
      this.directory = directory || this.directory;
      this.dirLabel.textContent = `输出目录：${this.directory || "—"}`;
      this.dirLabel.title = this.directory || "";
      let added = 0;
      for (const item of items) {
        if (this.addItem(item, { silent: true })) added += 1;
      }
      this.render();
      if (notify) toast(`已加载 ${items.length} 个历史输出`, "success");
      return added;
    } catch (error) {
      console.warn("[ComfUI Workbench] 读取输出目录失败", error);
      if (notify) toast("读取输出目录失败", "error");
      return 0;
    }
  }

  /** executed 事件：{images:[{filename,subfolder,type}], videos:[...], text:[...]} */
  handleExecuted(detail) {
    const output = detail?.output || detail || {};
    let added = 0;
    for (const [group, list] of Object.entries(output)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry === "string") {
          if (this.addItem({ kind: "text", text: entry, filename: "text 输出" }, { prepend: true })) added += 1;
          continue;
        }
        if (!entry || !entry.filename) continue;
        const kind = groupKind(group, entry.filename);
        if (!kind) continue;
        if (
          this.addItem(
            {
              filename: entry.filename,
              subfolder: entry.subfolder || "",
              type: entry.type || "output",
              kind,
              mtime: Math.floor(Date.now() / 1000),
              size: null,
            },
            { prepend: true }
          )
        ) {
          added += 1;
        }
      }
    }
    if (added) this.render();
    return added;
  }

  addItem(item, { prepend = false, silent = false } = {}) {
    const key = itemKey(item);
    if (this.items.has(key)) {
      if (item.mtime && this.items.get(key).mtime !== item.mtime) {
        this.items.set(key, { ...this.items.get(key), ...item });
      }
      return false;
    }
    const record = { ...item, key };
    this.items.set(key, record);
    if (prepend) this.order.unshift(key);
    else this.order.push(key);
    return true;
  }

  /* ------------------------------------------------------------- 渲染 */
  render() {
    const visible = this.order
      .map((key) => this.items.get(key))
      .filter(Boolean)
      .filter((item) => this.filter === "all" || item.kind === this.filter);

    clear(this.grid);
    this.empty.classList.toggle("cw-hidden", visible.length > 0);
    this.countLabel.textContent = String(this.order.length);
    this.onCountChange(visible.length);

    const fragment = document.createDocumentFragment();
    for (const item of visible) fragment.append(this.renderCard(item, visible));
    this.grid.append(fragment);
  }

  renderCard(item, visible) {
    const media = el("div", { class: "cw-card-media" });

    if (item.kind === "image") {
      const url = viewUrl(item);
      media.append(
        el("img", {
          attrs: { src: url, loading: "lazy", alt: item.filename, decoding: "async" },
          on: {
            click: () => this.openLightbox(item, visible),
            error: () => media.classList.add("cw-card-error"),
          },
        })
      );
    } else if (item.kind === "video") {
      media.append(
        el("video", {
          attrs: { src: viewUrl(item), preload: "metadata", muted: true, playsinline: true },
          on: { click: () => this.openLightbox(item, visible) }
        }),
        el("span", { class: "cw-play-badge", html: iconEl("play", 16).innerHTML })
      );
    } else if (item.kind === "audio") {
      media.append(
        el("div", { class: "cw-audio-face", html: iconEl("audio", 26).innerHTML }),
        el("span", { class: "cw-play-badge", html: iconEl("play", 16).innerHTML }),
        el("div", { class: "cw-audio-wrap" }, el("audio", { attrs: { src: viewUrl(item), controls: true } }))
      );
    } else {
      media.append(
        el("div", { class: "cw-text-face", text: String(item.text || "").slice(0, 400) })
      );
    }

    const actions = el(
      "div",
      { class: "cw-card-actions" },
      item.kind !== "text"
        ? el("a", {
            class: "cw-card-btn",
            attrs: {
              href: viewUrl(item),
              download: item.filename,
              title: "下载",
            },
            html: iconEl("download", 14).innerHTML,
          })
        : el("button", {
            class: "cw-card-btn",
            type: "button",
            title: "复制文本",
            html: iconEl("text", 14).innerHTML,
            on: {
              click: () => {
                navigator.clipboard?.writeText(String(item.text || ""));
                toast("已复制到剪贴板", "success");
              },
            },
          }),
      el("button", {
        class: "cw-card-btn",
        type: "button",
        title: "在文件管理器中显示",
        html: iconEl("folder", 14).innerHTML,
        on: { click: () => this.reveal(item) },
      })
    );

    return el(
      "article",
      {
        class: ["cw-card", `cw-card-${item.kind}`],
        dataset: { key: item.key },
        title: "右键可以删除该文件",
        on: { contextmenu: (event) => this.openCardMenu(event, item, visible) },
      },
      media,
      el(
        "div",
        { class: "cw-card-bar" },
        el(
          "div",
          { class: "cw-card-meta" },
          el("span", { class: "cw-card-name", text: item.filename || "text", title: item.filename }),
          el("span", {
            class: "cw-card-sub",
            text: [fmtAgo(item.mtime), item.size ? fmtBytes(item.size) : ""].filter(Boolean).join(" · "),
          })
        ),
        actions
      )
    );
  }

  async reveal(item) {
    try {
      const result = await revealFile({
        filename: item.filename,
        subfolder: item.subfolder || "",
        type: item.type || "output",
      });
      if (!result.ok) throw new Error(result.error || "打开失败");
    } catch (error) {
      toast(`打开失败：${error.message || error}`, "error");
    }
  }

  /* ------------------------------------------------------------- 右键菜单 */
  openCardMenu(event, item, visible = []) {
    event.preventDefault();
    event.stopPropagation();
    const isText = item.kind === "text";
    openContextMenu(event, [
      {
        label: isText ? "复制文本" : "放大预览",
        iconName: isText ? "text" : "expand",
        onSelect: () =>
          isText
            ? navigator.clipboard?.writeText(String(item.text || "")) && toast("已复制到剪贴板", "success")
            : this.openLightbox(item, visible),
      },
      {
        label: isText ? "复制到剪贴板" : "下载",
        iconName: "download",
        disabled: isText,
        onSelect: () => this.download(item),
      },
      {
        label: "在文件夹中显示",
        iconName: "folder",
        disabled: !item.filename,
        onSelect: () => this.reveal(item),
      },
      { separator: true },
      {
        label: "删除该文件…",
        iconName: "trash",
        danger: true,
        disabled: !item.filename,
        onSelect: () => this.deleteItem(item),
      },
    ]);
  }

  download(item) {
    if (!item.filename) return;
    const link = el("a", {
      attrs: { href: viewUrl(item), download: item.filename },
    });
    document.body.append(link);
    link.click();
    link.remove();
  }

  /**
   * 从服务器磁盘上彻底删除该产物（不可恢复）。
   * 删除前会弹确认框；成功后从画廊和预览列表里移除。
   */
  async deleteItem(item) {
    if (!item?.filename) {
      toast("文本输出没有对应文件，无法删除", "info");
      return false;
    }
    const where = [item.subfolder, item.filename].filter(Boolean).join("/");
    const ok = await confirmDialog({
      title: "从磁盘删除",
      message: `确定要彻底删除「${where}」吗？\n文件会从服务器磁盘上删除，无法恢复。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return false;

    try {
      const result = await deleteOutput({
        filename: item.filename,
        subfolder: item.subfolder || "",
        type: item.type || "output",
      });
      if (!result?.ok) throw new Error(result?.error || "删除失败");
      this.removeItem(item);
      toast(`已删除 ${item.filename}`, "success");
      return true;
    } catch (error) {
      console.error("[ComfUI Workbench] 删除失败", error);
      toast(`删除失败：${error.message || error}`, "error", 5000);
      return false;
    }
  }

  removeItem(item) {
    const key = item.key || itemKey(item);
    this.items.delete(key);
    this.order = this.order.filter((entry) => entry !== key);

    // 正在预览的文件被删掉时，同步更新预览列表
    if (this.lightboxList.some((entry) => entry.key === key)) {
      this.lightboxList = this.lightboxList.filter((entry) => entry.key !== key);
      if (this.lightboxList.length === 0) {
        this.closeLightbox();
      } else {
        this.lightboxIndex = Math.min(this.lightboxIndex, this.lightboxList.length - 1);
        this.renderLightbox();
      }
    }
    this.render();
  }

  /* ------------------------------------------------------------- 进度 / 状态 */
  setProgress(detail) {
    if (!detail) {
      this.progressRow.classList.add("cw-hidden");
      this.progressBar.style.width = "0%";
      return;
    }
    const { value, max, node } = detail;
    this.progressRow.classList.remove("cw-hidden");
    const percent = max ? clamp((Number(value) / Number(max)) * 100, 0, 100) : 0;
    this.progressBar.style.width = `${percent}%`;
    this.progressText.textContent = node
      ? `${node}  ${value ?? 0}/${max ?? "?"}`
      : `执行中 ${Math.round(percent)}%`;
  }

  setStatus(text) {
    if (!text) {
      this.progressRow.classList.add("cw-hidden");
      return;
    }
    this.progressRow.classList.remove("cw-hidden");
    this.progressText.textContent = text;
    this.progressBar.style.width = "100%";
    this.progressBar.classList.add("cw-indeterminate");
  }

  clearStatus() {
    this.progressBar.classList.remove("cw-indeterminate");
    this.setProgress(null);
  }

  /* ------------------------------------------------------------- 大图预览 */
  openLightbox(item, list) {
    this.lightboxList = (list || []).filter((entry) => entry.kind !== "text");
    this.lightboxIndex = this.lightboxList.findIndex((entry) => entry.key === item.key);
    if (this.lightboxIndex < 0) {
      this.lightboxList = [item];
      this.lightboxIndex = 0;
    }
    if (!this.lightbox) this.buildLightbox();
    this.lightbox.classList.remove("cw-hidden");
    this.renderLightbox();
  }

  buildLightbox() {
    this.lightboxStage = el("div", { class: "cw-lb-stage" });
    this.lightboxTitle = el("span", { class: "cw-lb-title" });
    this.lightboxCounter = el("span", { class: "cw-lb-counter" });
    this.lightboxActions = el("div", { class: "cw-lb-actions" });
    this.zoomLabel = el("span", { class: "cw-lb-zoom", text: "100%" });

    const close = () => this.closeLightbox();
    const prev = () => this.stepLightbox(-1);
    const next = () => this.stepLightbox(1);

    this.lightbox = el(
      "div",
      {
        class: "cw-lightbox cw-hidden",
        on: {
          click: (event) => {
            if (event.target === this.lightbox || event.target === this.lightboxStage) close();
          },
        },
      },
      el(
        "div",
        { class: "cw-lb-bar" },
        this.lightboxTitle,
        this.lightboxCounter,
        el("span", { class: "cw-spacer" }),
        el("button", {
          class: "cw-card-btn cw-lb-fit",
          type: "button",
          title: "适应屏幕（双击图片或按 0）",
          html: iconEl("fit", 16).innerHTML,
          on: { click: () => this.fitToScreen() },
        }),
        this.zoomLabel,
        this.lightboxActions,
        el("button", {
          class: "cw-card-btn cw-lb-close",
          type: "button",
          title: "关闭（Esc）",
          html: iconEl("close", 18).innerHTML,
          on: { click: close },
        })
      ),
      el(
        "div",
        { class: "cw-lb-body" },
        el("button", {
          class: "cw-lb-nav cw-lb-prev",
          type: "button",
          title: "上一个（←）",
          html: iconEl("chevronRight", 22).innerHTML,
          on: { click: prev },
        }),
        this.lightboxStage,
        el("button", {
          class: "cw-lb-nav cw-lb-next",
          type: "button",
          title: "下一个（→）",
          html: iconEl("chevronRight", 22).innerHTML,
          on: { click: next },
        })
      )
    );

    this.lightbox.addEventListener("wheel", (event) => this.onLightboxWheel(event), { passive: false });
    document.addEventListener("keydown", (event) => {
      if (this.lightbox.classList.contains("cw-hidden")) return;
      if (event.key === "Escape") close();
      else if (event.key === "ArrowLeft") prev();
      else if (event.key === "ArrowRight") next();
      else if (event.key === "0") this.fitToScreen();
      else if (event.key === "+" || event.key === "=") {
        this.zoom = clamp((this.zoom || 1) + 0.25, 0.1, 8);
        this.applyZoom();
      } else if (event.key === "-") {
        this.zoom = clamp((this.zoom || 1) - 0.25, 0.1, 8);
        this.applyZoom();
      }
    });
    // 窗口尺寸变了要重新适应，否则图片可能又超出屏幕
    window.addEventListener("resize", () => {
      if (this.lightbox && !this.lightbox.classList.contains("cw-hidden")) this.fitToScreen();
    });
    document.body.append(this.lightbox);
  }

  renderLightbox() {
    const item = this.lightboxList[this.lightboxIndex];
    if (!item) return;
    clear(this.lightboxStage);
    this.resetZoom();
    this.baseW = 0;
    this.baseH = 0;

    if (item.kind === "image") {
      this.zoomTarget = el("img", {
        class: "cw-lb-media",
        // on 必须在 attrs 之前：缓存过的图片可能在 src 赋值后立刻触发 load
        on: { load: () => this.fitToScreen() },
        attrs: { src: viewUrl(item), alt: item.filename, draggable: false },
      });
      this.lightboxStage.append(this.zoomTarget);
      this.attachPan(this.zoomTarget);
    } else if (item.kind === "video") {
      this.zoomTarget = el("video", {
        class: "cw-lb-media",
        on: { loadedmetadata: () => this.fitToScreen() },
        attrs: { src: viewUrl(item), controls: true, autoplay: true, playsinline: true },
      });
      this.lightboxStage.append(this.zoomTarget);
    } else {
      this.zoomTarget = el(
        "div",
        { class: "cw-lb-audio" },
        el("div", { class: "cw-audio-face", html: iconEl("audio", 48).innerHTML }),
        el("div", { class: "cw-lb-name", text: item.filename }),
        el("audio", { attrs: { src: viewUrl(item), controls: true, autoplay: true } })
      );
      this.lightboxStage.append(this.zoomTarget);
    }

    this.lightboxTitle.textContent = item.filename || "";
    this.lightboxTitle.title = [item.subfolder, item.filename].filter(Boolean).join("/");
    this.lightboxCounter.textContent =
      this.lightboxList.length > 1 ? `${this.lightboxIndex + 1} / ${this.lightboxList.length}` : "";

    clear(this.lightboxActions);
    this.lightboxActions.append(
      el("a", {
        class: "cw-card-btn",
        attrs: { href: viewUrl(item), download: item.filename, title: "下载" },
        html: iconEl("download", 16).innerHTML,
      }),
      el("button", {
        class: "cw-card-btn",
        type: "button",
        title: "在文件管理器中显示",
        html: iconEl("folder", 16).innerHTML,
        on: { click: () => this.reveal(item) },
      }),
      el("button", {
        class: "cw-card-btn",
        type: "button",
        title: "新窗口打开原图",
        html: iconEl("expand", 16).innerHTML,
        on: { click: () => window.open(viewUrl(item), "_blank") },
      }),
      el("button", {
        class: "cw-card-btn cw-lb-delete",
        type: "button",
        title: "从磁盘删除该文件",
        html: iconEl("trash", 16).innerHTML,
        on: { click: () => this.deleteItem(item) },
      })
    );

    // 图片/视频的尺寸可能还没就绪，下一帧再量一次
    requestAnimationFrame(() => this.fitToScreen());
  }

  /**
   * 把媒体按「容器能放下的最大尺寸」摆正（不放大，只缩小）。
   *
   * 关键点：显式写入 px 宽高，而不是只靠 CSS 的 max-width/max-height ——
   * 这样即使 ComfyUI 的全局样式覆盖了我们的规则，大图也不会撑出屏幕。
   */
  fitToScreen() {
    const target = this.zoomTarget;
    const stage = this.lightboxStage?.getBoundingClientRect();
    if (!target || !stage || !stage.width || !stage.height) return;

    const naturalW = target.naturalWidth || target.videoWidth || 0;
    const naturalH = target.naturalHeight || target.videoHeight || 0;
    if (!naturalW || !naturalH) return;

    const fit = Math.min(stage.width / naturalW, stage.height / naturalH, 1);
    this.baseW = naturalW * fit;
    this.baseH = naturalH * fit;
    target.style.width = `${Math.round(this.baseW)}px`;
    target.style.height = `${Math.round(this.baseH)}px`;

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyZoom();
  }

  stepLightbox(delta) {
    if (this.lightboxList.length < 2) return;
    this.lightboxIndex =
      (this.lightboxIndex + delta + this.lightboxList.length) % this.lightboxList.length;
    this.renderLightbox();
  }

  closeLightbox() {
    this.lightbox?.classList.add("cw-hidden");
    clear(this.lightboxStage);
    this.zoomTarget = null;
  }

  onLightboxWheel(event) {
    if (!this.zoomTarget || this.zoomTarget.tagName !== "IMG") return;
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.15 : 0.15;
    this.zoom = clamp((this.zoom || 1) + delta, 0.1, 8);
    this.applyZoom();
  }

  /**
   * 应用缩放 + 平移。
   * 平移会被夹住：缩放后没超过容器就强制居中，
   * 超过容器时也只能在「多出来的那部分」范围内拖动 ——
   * 这样「先放大拖动、再缩小」不会把图片甩出屏幕。
   */
  applyZoom = throttle(() => {
    const target = this.zoomTarget;
    if (!target) return;

    const stage = this.lightboxStage?.getBoundingClientRect();
    const scale = this.zoom || 1;
    const baseW = this.baseW || target.offsetWidth || 0;
    const baseH = this.baseH || target.offsetHeight || 0;

    const maxX = Math.max(0, (baseW * scale - (stage?.width || 0)) / 2);
    const maxY = Math.max(0, (baseH * scale - (stage?.height || 0)) / 2);
    this.panX = clamp(this.panX || 0, -maxX, maxX);
    this.panY = clamp(this.panY || 0, -maxY, maxY);

    target.style.transform = `translate(${Math.round(this.panX)}px, ${Math.round(
      this.panY
    )}px) scale(${scale})`;
    target.classList.toggle("cw-zoomed", scale > 1.01);
    this.updateZoomLabel();
  }, 16);

  updateZoomLabel() {
    if (!this.zoomLabel) return;
    this.zoomLabel.textContent = `${Math.round((this.zoom || 1) * 100)}%`;
  }

  resetZoom() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    if (this.zoomTarget) {
      this.zoomTarget.style.transform = "";
      this.zoomTarget.classList.remove("cw-zoomed");
    }
    this.updateZoomLabel();
  }

  attachPan(target) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    target.addEventListener("pointerdown", (event) => {
      if ((this.zoom || 1) <= 1) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originX = this.panX || 0;
      originY = this.panY || 0;
      target.setPointerCapture?.(event.pointerId);
      target.classList.add("cw-dragging");
      event.preventDefault();
    });
    target.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      this.panX = originX + (event.clientX - startX);
      this.panY = originY + (event.clientY - startY);
      this.applyZoom();
    });
    const stop = () => {
      dragging = false;
      target.classList.remove("cw-dragging");
    };
    target.addEventListener("pointerup", stop);
    target.addEventListener("pointercancel", stop);
    target.addEventListener("dblclick", () => this.fitToScreen());
  }
}

/* ---------------------------------------------------------------- 工具 */
function itemKey(item) {
  if (item.kind === "text") return `text:${String(item.text || "").slice(0, 64)}`;
  return `${item.type || "output"}/${item.subfolder || ""}/${item.filename}`;
}

function groupKind(group, filename) {
  const name = String(group || "").toLowerCase();
  if (name.includes("image") || name.includes("gif")) return "image";
  if (name.includes("video")) return "video";
  if (name.includes("audio")) return "audio";
  if (name.includes("text")) return "text";
  const ext = String(filename || "").split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif"].includes(ext)) return "image";
  if (["mp4", "webm", "mkv", "mov", "avi", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "flac", "ogg", "m4a", "aac"].includes(ext)) return "audio";
  if (["txt", "json", "csv"].includes(ext)) return "text";
  return null;
}
