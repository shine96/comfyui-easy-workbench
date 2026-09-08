/**
 * 配置存储：优先使用 ComfyUI 的 settings（能在设置面板里改），
 * 读写失败时退回 localStorage，保证在任意前端版本下都能工作。
 */

import { getAppSync } from "./cw-comfy.js";

const PREFIX = "comfui.workbench.";

const memory = new Map();

function ls() {
  try {
    return globalThis.localStorage || null;
  } catch (error) {
    return null;
  }
}

export const store = {
  get(key, fallback) {
    const storage = ls();
    if (!storage) return memory.has(key) ? memory.get(key) : fallback;
    try {
      const raw = storage.getItem(PREFIX + key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  },
  set(key, value) {
    memory.set(key, value);
    const storage = ls();
    if (!storage) return;
    try {
      storage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (error) {
      /* 隐私模式 / 配额满，忽略 */
    }
  },
  remove(key) {
    memory.delete(key);
    const storage = ls();
    if (!storage) return;
    try {
      storage.removeItem(PREFIX + key);
    } catch (error) {
      /* 忽略 */
    }
  },
};

/** 读取 ComfyUI 设置项，读不到就用 localStorage / 默认值 */
export function setting(id, fallback) {
  const app = getAppSync();
  try {
    const value = app?.ui?.settings?.getSettingValue?.(id);
    if (value !== undefined && value !== null && value !== "") return value;
  } catch (error) {
    /* 设置项可能还没注册，忽略 */
  }
  return store.get(id, fallback);
}

export function setSetting(id, value) {
  const app = getAppSync();
  try {
    if (app?.ui?.settings?.setSettingValue) {
      app.ui.settings.setSettingValue(id, value);
      return;
    }
  } catch (error) {
    /* 忽略 */
  }
  store.set(id, value);
}

export function onSettingChange(id, handler) {
  const app = getAppSync();
  try {
    app?.ui?.settings?.addEventListener?.("change", (event) => {
      if (!event?.detail || event.detail.setting?.id === id || event.detail.id === id) {
        handler(event?.detail?.value);
      }
    });
  } catch (error) {
    /* 忽略 */
  }
}

export const KEYS = {
  enabled: "ComfUI.Workbench.Enabled",
  pollMs: "ComfUI.Workbench.PollMs",
  theme: "ComfUI.Workbench.Theme",
  leftWidth: "leftWidth",
  rightWidth: "rightWidth",
  stars: "stars",
  collapsed: "collapsed",
  onlyStars: "onlyStars",
  hideNative: "hideNative",
  hideNativeMenu: "hideNativeMenu",
  broadHide: "ComfUI.Workbench.BroadHide",
  hideSelectors: "ComfUI.Workbench.HideSelectors",
  compactText: "ComfUI.Workbench.AutoGrowText",
  showOnlyParams: "ComfUI.Workbench.ShowOnlyParams",
};
