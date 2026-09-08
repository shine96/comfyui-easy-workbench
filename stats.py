"""资源占用采集：CPU / 内存 / 显卡 / 显存 / 队列。

设计原则
--------
* **零硬依赖**：没有 psutil 时退化为 ``os.getloadavg`` / 系统命令；
  没有 torch 时退化为 ``nvidia-smi``；任何一项失败都不会影响整体返回。
* **结果缓存**：前端会按 1~2 秒轮询，这里做 0.5 秒缓存，避免重复调用昂贵接口
  （``nvidia-smi`` 属于进程级调用，必须缓存）。
* **单位统一**：所有容量字段都是字节（int），百分比是 0~100 的 float。
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import time
from typing import Any, Dict, List, Optional

try:  # psutil 是可选依赖，装了就用，没装就降级
    import psutil  # type: ignore
except Exception:  # pragma: no cover
    psutil = None  # type: ignore


_CACHE: Dict[str, Any] = {"ts": 0.0, "data": None}
_CACHE_TTL = 0.5


def _safe(fn, default=None):
    """执行 fn，任何异常都返回 default。"""
    try:
        return fn()
    except Exception:
        return default


# --------------------------------------------------------------------------- #
# CPU
# --------------------------------------------------------------------------- #
def _cpu_percent() -> Optional[float]:
    if psutil is not None:
        try:
            value = psutil.cpu_percent(interval=None)
            if value is not None:
                return round(float(value), 1)
        except Exception:
            pass
    # 退化为 1 分钟平均负载 / 核心数
    try:
        load = os.getloadavg()[0]
        cores = os.cpu_count() or 1
        return round(min(100.0, load / cores * 100.0), 1)
    except Exception:
        return None


def _collect_cpu() -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "percent": _cpu_percent(),
        "count": os.cpu_count(),
        "name": _safe(lambda: platform.processor()) or platform.machine(),
        "source": "psutil" if psutil is not None else "loadavg",
    }
    freq = _safe(lambda: psutil.cpu_freq() if psutil is not None else None)
    if freq is not None:
        info["freq_mhz"] = round(float(getattr(freq, "current", 0) or 0))
    load = _safe(lambda: list(os.getloadavg()))
    if load:
        info["loadavg"] = [round(x, 2) for x in load]
    return info


# --------------------------------------------------------------------------- #
# 内存
# --------------------------------------------------------------------------- #
def _collect_memory() -> Dict[str, Any]:
    if psutil is not None:
        vm = _safe(lambda: psutil.virtual_memory())
        if vm is not None:
            return {
                "total": int(vm.total),
                "used": int(vm.total - vm.available),
                "available": int(vm.available),
                "percent": round(float(vm.percent), 1),
            }
    total = _sysctl_int("hw.memsize")
    if total:
        # macOS 没有 psutil 时，用 vm_stat 估算可用内存
        free = _macos_free_memory()
        used = max(0, total - (free or 0))
        return {
            "total": int(total),
            "used": int(used),
            "available": int(free or 0),
            "percent": round(used / total * 100.0, 1) if total else None,
        }
    return {"total": None, "used": None, "available": None, "percent": None}


def _sysctl_int(key: str) -> Optional[int]:
    if not shutil.which("sysctl"):
        return None
    out = _safe(
        lambda: subprocess.run(
            ["sysctl", "-n", key], capture_output=True, text=True, timeout=1.5
        ).stdout.strip()
    )
    try:
        return int(out)  # type: ignore[arg-type]
    except Exception:
        return None


def _macos_free_memory() -> Optional[int]:
    """通过 vm_stat 估算可用内存（page size 4096）。"""
    out = _safe(
        lambda: subprocess.run(
            ["vm_stat"], capture_output=True, text=True, timeout=1.5
        ).stdout
    )
    if not out:
        return None
    pages: Dict[str, int] = {}
    for line in out.splitlines()[1:]:
        if ":" not in line:
            continue
        name, _, value = line.partition(":")
        value = value.strip().rstrip(".")
        if value.isdigit():
            pages[name.strip()] = int(value)
    page_size = 4096
    free_pages = (
        pages.get("Pages free", 0)
        + pages.get("Pages inactive", 0)
        + pages.get("Pages speculative", 0)
        + pages.get("Pages purgeable", 0)
    )
    return free_pages * page_size or None


# --------------------------------------------------------------------------- #
# 显卡 / 显存
# --------------------------------------------------------------------------- #
def _import_torch():
    try:
        import torch  # type: ignore

        return torch
    except Exception:
        return None


def _nvidia_smi_devices() -> List[Dict[str, Any]]:
    """没有 torch 时用 nvidia-smi 兜底。"""
    if not shutil.which("nvidia-smi"):
        return []
    cmd = [
        "nvidia-smi",
        "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
    ]
    out = _safe(
        lambda: subprocess.run(cmd, capture_output=True, text=True, timeout=2.0).stdout
    )
    devices: List[Dict[str, Any]] = []
    for line in (out or "").strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        try:
            used = int(float(parts[3])) * 1024 * 1024
            total = int(float(parts[4])) * 1024 * 1024
            device = {
                "index": int(parts[0]),
                "name": parts[1],
                "type": "cuda",
                "utilization": int(float(parts[2])),
                "vram_used": used,
                "vram_total": total,
                "vram_free": max(0, total - used),
                "source": "nvidia-smi",
            }
            if len(parts) > 5 and parts[5].isdigit():
                device["temperature"] = int(parts[5])
            devices.append(device)
        except Exception:
            continue
    return devices


def _cuda_devices(torch) -> List[Dict[str, Any]]:
    devices: List[Dict[str, Any]] = []
    if not _safe(lambda: torch.cuda.is_available(), False):
        return devices
    try:
        import pynvml  # type: ignore

        nvml_ready = True
        _safe(lambda: pynvml.nvmlInit())
    except Exception:
        pynvml = None  # type: ignore
        nvml_ready = False

    count = _safe(lambda: torch.cuda.device_count(), 0) or 0
    for i in range(count):
        device: Dict[str, Any] = {
            "index": i,
            "type": "cuda",
            "name": _safe(lambda i=i: torch.cuda.get_device_name(i)) or f"CUDA {i}",
            "source": "torch",
        }
        mem = _safe(lambda i=i: torch.cuda.mem_get_info(i))
        if mem:
            free, total = int(mem[0]), int(mem[1])
            device.update(
                vram_free=free, vram_total=total, vram_used=max(0, total - free)
            )
        device["torch_allocated"] = _safe(
            lambda i=i: int(torch.cuda.memory_allocated(i))
        )
        device["torch_reserved"] = _safe(
            lambda i=i: int(torch.cuda.memory_reserved(i))
        )
        if nvml_ready and pynvml is not None:
            handle = _safe(lambda i=i: pynvml.nvmlDeviceGetHandleByIndex(i))
            if handle is not None:
                util = _safe(lambda: pynvml.nvmlDeviceGetUtilizationRates(handle))
                if util is not None:
                    device["utilization"] = int(util.gpu)
                temp = _safe(
                    lambda: pynvml.nvmlDeviceGetTemperature(
                        handle, pynvml.NVML_TEMPERATURE_GPU
                    )
                )
                if temp is not None:
                    device["temperature"] = int(temp)
        devices.append(device)

    if nvml_ready:
        _safe(lambda: pynvml.nvmlShutdown())
    return devices


def _mps_device(torch) -> Optional[Dict[str, Any]]:
    """Apple Silicon：显存与内存共享，用 torch.mps 的推荐上限作为「显存」。"""
    if not _safe(
        lambda: hasattr(torch.backends, "mps") and torch.backends.mps.is_available(),
        False,
    ):
        return None
    device: Dict[str, Any] = {
        "index": 0,
        "type": "mps",
        "name": _safe(lambda: platform.machine()) or "Apple Silicon GPU",
        "source": "torch.mps",
        "unified_memory": True,
    }
    allocated = _safe(lambda: int(torch.mps.current_allocated_memory()))
    driver = _safe(lambda: int(torch.mps.driver_allocated_memory()))
    total = _safe(lambda: int(torch.mps.recommended_max_memory()))
    if total:
        used = driver if driver is not None else (allocated or 0)
        device.update(
            vram_total=total,
            vram_used=max(0, used),
            vram_free=max(0, total - used),
        )
    if allocated is not None:
        device["torch_allocated"] = allocated
    if driver is not None:
        device["torch_reserved"] = driver
    return device


def _collect_devices() -> List[Dict[str, Any]]:
    torch = _import_torch()
    devices: List[Dict[str, Any]] = []
    if torch is not None:
        devices.extend(_cuda_devices(torch))
        mps = _mps_device(torch)
        if mps is not None:
            devices.append(mps)
        if not devices:
            xpu_available = _safe(
                lambda: hasattr(torch, "xpu") and torch.xpu.is_available(), False
            )
            if xpu_available:
                count = _safe(lambda: torch.xpu.device_count(), 0) or 0
                for i in range(count):
                    devices.append(
                        {
                            "index": i,
                            "type": "xpu",
                            "name": _safe(lambda i=i: torch.xpu.get_device_name(i))
                            or f"XPU {i}",
                            "source": "torch",
                        }
                    )
    if not devices:
        devices = _nvidia_smi_devices()
    return devices


# --------------------------------------------------------------------------- #
# 队列
# --------------------------------------------------------------------------- #
def _collect_queue() -> Dict[str, Any]:
    try:
        from server import PromptServer  # type: ignore

        instance = getattr(PromptServer, "instance", None)
        queue = getattr(instance, "prompt_queue", None) if instance is not None else None
        if queue is not None:
            info = _safe(lambda: queue.get_queue_info())
            if isinstance(info, dict):
                return {
                    "running": len(info.get("queue_running") or []),
                    "pending": len(info.get("queue_pending") or []),
                }
            running = _safe(lambda: len(queue.currently_running), 0) or 0
            pending = _safe(lambda: len(queue.queue), 0) or 0
            return {"running": int(running), "pending": int(pending)}
    except Exception:
        pass
    return {"running": 0, "pending": 0, "unknown": True}


# --------------------------------------------------------------------------- #
# 汇总
# --------------------------------------------------------------------------- #
def _collect_comfy() -> Dict[str, Any]:
    info: Dict[str, Any] = {"python": platform.python_version()}
    version = None
    for module_name, attr in (("comfyui_version", "__version__"), ("comfy", "__version__")):
        try:
            module = __import__(module_name)
            version = getattr(module, attr, None)
            if version:
                break
        except Exception:
            continue
    if version:
        info["version"] = str(version)
    torch = _import_torch()
    if torch is not None:
        info["torch"] = getattr(torch, "__version__", None)
    return info


def get_stats(force: bool = False) -> Dict[str, Any]:
    """返回一次完整的资源快照（带 0.5 秒缓存）。"""
    now = time.time()
    if (
        not force
        and _CACHE["data"] is not None
        and now - float(_CACHE["ts"]) < _CACHE_TTL
    ):
        return _CACHE["data"]

    data = {
        "ts": now,
        "cpu": _collect_cpu(),
        "memory": _collect_memory(),
        "devices": _collect_devices(),
        "queue": _collect_queue(),
        "comfy": _collect_comfy(),
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "hostname": _safe(lambda: platform.node()),
        },
    }
    _CACHE["ts"] = now
    _CACHE["data"] = data
    return data


def prime() -> None:
    """预热 CPU 采样：psutil 的第一次 cpu_percent 永远返回 0.0。"""
    if psutil is not None:
        _safe(lambda: psutil.cpu_percent(interval=None))


prime()
