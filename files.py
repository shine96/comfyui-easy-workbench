"""文件相关能力：输出目录产物、用户工作流读写、在文件管理器中定位文件。

所有路径都做「必须落在目标目录内」的校验，防止通过 ``../`` 读取任意文件。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from typing import Any, Dict, List, Optional

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"}
VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v", ".gif"}
AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}

_MAX_SCAN = 12000  # 单次扫描文件数上限，避免超大输出目录拖慢接口
_MAX_DEPTH = 5


def _folder_paths():
    import folder_paths  # type: ignore

    return folder_paths


def output_directory() -> str:
    try:
        return str(_folder_paths().get_output_directory())
    except Exception:
        return ""


def user_directory() -> str:
    try:
        return str(_folder_paths().get_user_directory())
    except Exception:
        base = ""
        try:
            base = str(_folder_paths().base_path)
        except Exception:
            pass
        return os.path.join(base, "user") if base else ""


def workflows_directory() -> str:
    user = user_directory()
    return os.path.join(user, "default", "workflows") if user else ""


def _is_inside(base: str, target: str) -> bool:
    try:
        base_abs = os.path.abspath(base)
        target_abs = os.path.abspath(target)
        return os.path.commonpath([base_abs, target_abs]) == base_abs
    except Exception:
        return False


def _kind_of(ext: str) -> Optional[str]:
    ext = ext.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    return None


# --------------------------------------------------------------------------- #
# 输出产物
# --------------------------------------------------------------------------- #
def list_outputs(limit: int = 120, kind: Optional[str] = None) -> List[Dict[str, Any]]:
    """列出输出目录里的图片/视频/音频，按修改时间倒序。"""
    root = output_directory()
    if not root or not os.path.isdir(root):
        return []
    limit = max(1, min(int(limit or 120), 1000))

    items: List[Dict[str, Any]] = []
    scanned = 0
    root_depth = root.rstrip(os.sep).count(os.sep)
    for dirpath, dirnames, filenames in os.walk(root):
        # 跳过隐藏目录
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        if dirpath.count(os.sep) - root_depth >= _MAX_DEPTH:
            dirnames[:] = []
        for name in filenames:
            if name.startswith("."):
                continue
            scanned += 1
            if scanned > _MAX_SCAN:
                break
            ext = os.path.splitext(name)[1]
            file_kind = _kind_of(ext)
            if file_kind is None:
                continue
            if kind and file_kind != kind:
                continue
            full = os.path.join(dirpath, name)
            stat = None
            try:
                stat = os.stat(full)
            except Exception:
                continue
            subfolder = os.path.relpath(dirpath, root)
            if subfolder == ".":
                subfolder = ""
            items.append(
                {
                    "filename": name,
                    "subfolder": subfolder.replace(os.sep, "/"),
                    "type": "output",
                    "kind": file_kind,
                    "mtime": int(stat.st_mtime),
                    "size": int(stat.st_size),
                }
            )
        if scanned > _MAX_SCAN:
            break

    items.sort(key=lambda item: item.get("mtime") or 0, reverse=True)
    return items[:limit]


def resolve_output_file(filename: str, subfolder: str = "", type_: str = "output") -> Optional[str]:
    """把 ComfyUI 的 (filename, subfolder, type) 解析为磁盘绝对路径。"""
    if not filename:
        return None
    try:
        if type_ == "temp":
            base = str(_folder_paths().get_temp_directory())
        elif type_ == "input":
            base = str(_folder_paths().get_input_directory())
        else:
            base = output_directory()
    except Exception:
        return None
    if not base:
        return None
    candidate = os.path.abspath(os.path.join(base, subfolder or "", filename))
    if not _is_inside(base, candidate):
        return None
    return candidate if os.path.isfile(candidate) else None


def reveal(path: str) -> Dict[str, Any]:
    """在系统文件管理器中定位文件/目录。"""
    if not path or not os.path.exists(path):
        return {"ok": False, "error": "文件不存在"}
    system = os.name if os.name == "nt" else os.uname().sysname.lower()  # type: ignore[attr-defined]
    try:
        if system == "darwin":
            subprocess.Popen(["open", "-R", path])
        elif system == "windows" or os.name == "nt":
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
        else:
            target = path if os.path.isdir(path) else os.path.dirname(path)
            opener = shutil.which("xdg-open")
            if not opener:
                return {"ok": False, "error": "未找到 xdg-open"}
            subprocess.Popen([opener, target])
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


# --------------------------------------------------------------------------- #
# 删除产物
# --------------------------------------------------------------------------- #
#: 允许删除的文件类型：只放开「输出目录里的媒体 / 文本」，避免误删模型、配置等
DELETABLE_EXTS = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS | {".txt"}


def delete_output(filename: str, subfolder: str = "", type_: str = "output") -> Dict[str, Any]:
    """把输出目录里的一个产物从磁盘上彻底删除。

    安全约束（任意一条不满足都拒绝）：
      * 只允许 ``type=output``，不允许删 input / temp；
      * 文件名必须是纯文件名，不能带路径分隔符（子目录只能走 ``subfolder``）；
      * 解析后的路径必须落在输出目录内（同时校验 realpath，防止软链逃逸）；
      * 扩展名必须在 ``DELETABLE_EXTS`` 里。
    """
    if type_ and type_ != "output":
        return {"ok": False, "error": "只允许删除输出目录里的文件"}

    root = output_directory()
    if not root or not os.path.isdir(root):
        return {"ok": False, "error": "无法定位输出目录"}

    name = (filename or "").strip()
    if not name:
        return {"ok": False, "error": "缺少文件名"}
    if name.startswith("."):
        return {"ok": False, "error": "非法文件名"}
    if any(sep and sep in name for sep in (os.sep, os.altsep, "/", "\\")):
        return {"ok": False, "error": "文件名不能包含路径分隔符"}
    if name in (".", ".."):
        return {"ok": False, "error": "非法文件名"}

    ext = os.path.splitext(name)[1].lower()
    if ext not in DELETABLE_EXTS:
        return {"ok": False, "error": f"不支持删除 {ext or '该类型'} 文件"}

    candidate = os.path.abspath(os.path.join(root, subfolder or "", name))
    if not _is_inside(root, candidate):
        return {"ok": False, "error": "非法路径"}
    # 软链可能指向输出目录之外，必须用 realpath 再校验一次
    if not _is_inside(os.path.realpath(root), os.path.realpath(candidate)):
        return {"ok": False, "error": "非法路径"}
    if not os.path.isfile(candidate):
        return {"ok": False, "error": "文件不存在"}

    try:
        os.remove(candidate)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "filename": name,
        "subfolder": (subfolder or "").replace(os.sep, "/"),
        "path": candidate,
    }


# --------------------------------------------------------------------------- #
# 工作流
# --------------------------------------------------------------------------- #
_SAFE_NAME = re.compile(r"[^\w\u4e00-\u9fff.\- ()（）]+")


def _sanitize_name(name: str) -> str:
    name = (name or "").strip().replace("\\", "/")
    name = "/".join(part for part in name.split("/") if part not in ("", ".", ".."))
    parts = []
    for part in name.split("/"):
        part = _SAFE_NAME.sub("_", part).strip()
        if part:
            parts.append(part)
    cleaned = "/".join(parts)
    if not cleaned:
        cleaned = "workflow"
    if not cleaned.lower().endswith(".json"):
        cleaned += ".json"
    return cleaned


def list_workflows() -> List[Dict[str, Any]]:
    root = workflows_directory()
    if not root or not os.path.isdir(root):
        return []
    items: List[Dict[str, Any]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if not name.lower().endswith(".json"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            stat = None
            try:
                stat = os.stat(full)
            except Exception:
                continue
            items.append(
                {
                    "name": rel,
                    "label": os.path.splitext(rel)[0],
                    "mtime": int(stat.st_mtime),
                    "size": int(stat.st_size),
                }
            )
    items.sort(key=lambda item: item.get("mtime") or 0, reverse=True)
    return items


def read_workflow(name: str) -> Optional[Dict[str, Any]]:
    root = workflows_directory()
    if not root:
        return None
    safe = _sanitize_name(name)
    full = os.path.join(root, safe)
    if not _is_inside(root, full) or not os.path.isfile(full):
        return None
    try:
        with open(full, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return {"name": safe, "workflow": data}
    except Exception:
        return None


def write_workflow(name: str, workflow: Any) -> Dict[str, Any]:
    root = workflows_directory()
    if not root:
        return {"ok": False, "error": "无法定位用户工作流目录"}
    safe = _sanitize_name(name)
    full = os.path.join(root, safe)
    if not _is_inside(root, full):
        return {"ok": False, "error": "非法路径"}
    try:
        os.makedirs(os.path.dirname(full) or root, exist_ok=True)
        if os.path.exists(full):
            backup = f"{full}.{int(time.time())}.bak"
            shutil.copy2(full, backup)
        with open(full, "w", encoding="utf-8") as handle:
            json.dump(workflow, handle, ensure_ascii=False, indent=2)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "name": safe, "path": full}
