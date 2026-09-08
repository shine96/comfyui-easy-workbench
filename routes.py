"""aiohttp 路由注册。

ComfyUI 在加载自定义节点之后才会 ``app.add_routes(server.routes)``，
所以这里必须在 import 阶段把 handler 挂到 ``PromptServer.instance.routes`` 上。
"""

from __future__ import annotations

import traceback
from typing import Any, Dict

from aiohttp import web

from . import files, stats


def _json(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, headers={"Cache-Control": "no-store"})


async def _read_json(request: web.Request) -> Dict[str, Any]:
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def register_routes() -> bool:
    """把接口挂到 ComfyUI 的 aiohttp 路由表。返回是否成功。"""
    try:
        from server import PromptServer  # type: ignore
    except Exception:
        return False

    instance = getattr(PromptServer, "instance", None)
    if instance is None or not hasattr(instance, "routes"):
        return False

    routes = instance.routes

    # ---------------------------------------------------------------- 资源占用
    @routes.get("/comfui-workbench/stats")
    async def comfui_stats(request: web.Request) -> web.Response:
        force = request.query.get("force") in ("1", "true", "yes")
        try:
            return _json(stats.get_stats(force=force))
        except Exception as exc:
            traceback.print_exc()
            return _json({"error": str(exc)}, status=500)

    @routes.get("/comfui-workbench/ping")
    async def comfui_ping(request: web.Request) -> web.Response:
        return _json({"ok": True, "version": _version()})

    # ---------------------------------------------------------------- 输出产物
    @routes.get("/comfui-workbench/outputs")
    async def comfui_outputs(request: web.Request) -> web.Response:
        try:
            limit = int(request.query.get("limit", "120"))
        except Exception:
            limit = 120
        kind = request.query.get("kind") or None
        try:
            return _json(
                {
                    "items": files.list_outputs(limit=limit, kind=kind),
                    "directory": files.output_directory(),
                }
            )
        except Exception as exc:
            traceback.print_exc()
            return _json({"items": [], "error": str(exc)}, status=500)

    @routes.post("/comfui-workbench/reveal")
    async def comfui_reveal(request: web.Request) -> web.Response:
        payload = await _read_json(request)
        target = payload.get("path")
        if not target:
            resolved = files.resolve_output_file(
                payload.get("filename", ""),
                payload.get("subfolder", "") or "",
                payload.get("type", "output") or "output",
            )
            if not resolved:
                return _json({"ok": False, "error": "未找到文件"}, status=404)
            target = resolved
        result = files.reveal(str(target))
        return _json(result, status=200 if result.get("ok") else 400)

    # ---------------------------------------------------------------- 工作流
    @routes.get("/comfui-workbench/workflows")
    async def comfui_workflows(request: web.Request) -> web.Response:
        try:
            return _json(
                {
                    "items": files.list_workflows(),
                    "directory": files.workflows_directory(),
                }
            )
        except Exception as exc:
            traceback.print_exc()
            return _json({"items": [], "error": str(exc)}, status=500)

    @routes.get("/comfui-workbench/workflow")
    async def comfui_workflow_get(request: web.Request) -> web.Response:
        name = request.query.get("name") or ""
        data = files.read_workflow(name)
        if not data:
            return _json({"ok": False, "error": "工作流不存在"}, status=404)
        return _json({"ok": True, **data})

    @routes.post("/comfui-workbench/workflow")
    async def comfui_workflow_save(request: web.Request) -> web.Response:
        payload = await _read_json(request)
        name = payload.get("name") or ""
        workflow = payload.get("workflow")
        if not isinstance(workflow, dict):
            return _json({"ok": False, "error": "缺少 workflow 字段"}, status=400)
        result = files.write_workflow(name, workflow)
        return _json(result, status=200 if result.get("ok") else 400)

    return True


def _version() -> str:
    try:
        from . import __version__

        return __version__
    except Exception:
        return "unknown"
