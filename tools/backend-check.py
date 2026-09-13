#!/usr/bin/env python3
"""后端自检：在没有 ComfyUI 的环境里用假模块验证 stats / files / routes。

用法：
    python3 tools/backend-check.py

它会：
  1. 注入假的 folder_paths / server 模块；
  2. 建一个临时输出目录，放几张假图片、假视频和假工作流；
  3. 通过 importlib 把本插件当成包加载（目录名带连字符，普通 import 不行）；
  4. 直接调用 routes 里注册的 aiohttp handler，检查返回的 JSON；
  5. 打印每项结果，失败时以非 0 退出码结束。
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TMP = tempfile.mkdtemp(prefix="cw-backend-")
OUTPUT_DIR = os.path.join(TMP, "output")
USER_DIR = os.path.join(TMP, "user")
WORKFLOW_DIR = os.path.join(USER_DIR, "default", "workflows")
TEMP_DIR = os.path.join(TMP, "temp")
INPUT_DIR = os.path.join(TMP, "input")

for path in (OUTPUT_DIR, WORKFLOW_DIR, TEMP_DIR, INPUT_DIR):
    os.makedirs(path, exist_ok=True)

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    mark = "✅" if condition else "❌"
    print(f"{mark} {name}{(' — ' + detail) if detail else ''}")
    if not condition:
        failures.append(name)


def write_file(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)


# --------------------------------------------------------------------------- #
# 假模块
# --------------------------------------------------------------------------- #
folder_paths = types.ModuleType("folder_paths")
folder_paths.base_path = TMP
folder_paths.get_output_directory = lambda: OUTPUT_DIR
folder_paths.get_temp_directory = lambda: TEMP_DIR
folder_paths.get_input_directory = lambda: INPUT_DIR
folder_paths.get_user_directory = lambda: USER_DIR
sys.modules["folder_paths"] = folder_paths

server = types.ModuleType("server")


class FakeQueue:
    def get_queue_info(self):
        return {"queue_running": [1], "queue_pending": [2, 3]}


class FakePromptServer:
    instance = None

    def __init__(self):
        from aiohttp import web

        self.routes = web.RouteTableDef()
        self.prompt_queue = FakeQueue()


FakePromptServer.instance = FakePromptServer()
server.PromptServer = FakePromptServer
sys.modules["server"] = server


class FakeRequest:
    def __init__(self, query=None, body=None):
        self.query = query or {}
        self._body = body or {}

    async def json(self):
        return self._body


# --------------------------------------------------------------------------- #
# 造数据
# --------------------------------------------------------------------------- #
write_file(os.path.join(OUTPUT_DIR, "ComfyUI_00001_.png"), b"\x89PNG\r\n\x1a\n fake")
write_file(os.path.join(OUTPUT_DIR, "ComfyUI_00002_.png"), b"\x89PNG\r\n\x1a\n fake")
write_file(os.path.join(OUTPUT_DIR, "upscaled", "ComfyUI_00003_.png"), b"\x89PNG\r\n\x1a\n fake")
write_file(os.path.join(OUTPUT_DIR, "clip.mp4"), b"\x00\x00\x00\x18ftypmp42 fake video")
write_file(os.path.join(OUTPUT_DIR, "notes.txt"), "不是媒体，不该出现在列表里".encode("utf-8"))
write_file(
    os.path.join(WORKFLOW_DIR, "风景.json"),
    json.dumps({"nodes": [{"id": 1, "type": "KSampler"}]}, ensure_ascii=False).encode("utf-8"),
)

# --------------------------------------------------------------------------- #
# 以包的形式加载插件（目录名带连字符，必须走 importlib）
# --------------------------------------------------------------------------- #
spec = importlib.util.spec_from_file_location(
    "comfui_workbench",
    os.path.join(ROOT, "__init__.py"),
    submodule_search_locations=[ROOT],
)
package = importlib.util.module_from_spec(spec)
sys.modules["comfui_workbench"] = package
spec.loader.exec_module(package)

stats = sys.modules["comfui_workbench.stats"]
files = sys.modules["comfui_workbench.files"]

print("\n== 模块加载 ==")
check("插件包可加载", package.__version__ == "1.0.0", f"version={package.__version__}")
check("WEB_DIRECTORY 指向 ./web", package.WEB_DIRECTORY == "./web")
check("web 目录存在", os.path.isdir(os.path.join(ROOT, "web")))
check(
    "web 入口文件存在",
    os.path.isfile(os.path.join(ROOT, "web", "comfui_workbench.js")),
)
check("样式文件存在", os.path.isfile(os.path.join(ROOT, "web", "style.css")))

# --------------------------------------------------------------------------- #
# stats
# --------------------------------------------------------------------------- #
print("\n== 资源采集 ==")
snapshot = stats.get_stats(force=True)
check("stats 返回字典", isinstance(snapshot, dict))
check("包含 cpu 字段", "cpu" in snapshot, json.dumps(snapshot.get("cpu"), ensure_ascii=False)[:120])
check("包含 memory 字段", bool(snapshot.get("memory", {}).get("total")), str(snapshot.get("memory", {}).get("total")))
check("包含 devices 字段", isinstance(snapshot.get("devices"), list), f"{len(snapshot.get('devices') or [])} 个设备")
check(
    "队列读数正确",
    snapshot.get("queue") == {"running": 1, "pending": 2},
    json.dumps(snapshot.get("queue")),
)
check("缓存生效（0.5s 内返回同一对象）", stats.get_stats() is snapshot)

# --------------------------------------------------------------------------- #
# files
# --------------------------------------------------------------------------- #
print("\n== 文件能力 ==")
items = files.list_outputs(limit=50)
kinds = sorted({item["kind"] for item in items})
check("输出列表只含媒体", kinds == ["image", "video"], f"kinds={kinds}")
check("输出列表数量正确", len(items) == 4, f"{len(items)} 个")
check("按时间倒序", items[0]["mtime"] >= items[-1]["mtime"])
check(
    "子目录被记录",
    any(item["subfolder"] == "upscaled" for item in items),
    str([item["subfolder"] for item in items]),
)
check("txt 被过滤", all(not item["filename"].endswith(".txt") for item in items))
check(
    "路径穿越被拒绝",
    files.resolve_output_file("../etc/passwd") is None,
)
check(
    "正常文件可解析",
    files.resolve_output_file("ComfyUI_00001_.png") is not None,
)

workflows = files.list_workflows()
check("工作流列表非空", len(workflows) == 1, str(workflows))
check("工作流可读取", (files.read_workflow("风景.json") or {}).get("workflow", {}).get("nodes") is not None)
check("工作流穿越被拒绝", files.read_workflow("../../secret.json") is None)

saved = files.write_workflow("测试/子目录 工作流", {"nodes": [], "links": []})
check("工作流可保存", bool(saved.get("ok")), json.dumps(saved, ensure_ascii=False))
check(
    "保存后能读回",
    (files.read_workflow(saved.get("name", "")) or {}).get("workflow") is not None,
    str(saved.get("name")),
)
check("非法名称被清洗", ".." not in str(saved.get("name")), str(saved.get("name")))

# --------------------------------------------------------------------------- #
# 删除产物
# --------------------------------------------------------------------------- #
print("\n== 删除产物 ==")
DELETABLE = os.path.join(OUTPUT_DIR, "deletable.png")
SUBDELETABLE = os.path.join(OUTPUT_DIR, "upscaled", "sub-deletable.png")
write_file(DELETABLE, b"\x89PNG\r\n\x1a\n fake deletable")
write_file(SUBDELETABLE, b"\x89PNG\r\n\x1a\n fake sub deletable")

check(
    "文件存在时可删",
    bool(files.delete_output("deletable.png").get("ok")) and not os.path.exists(DELETABLE),
)
check(
    "子目录文件可删",
    bool(files.delete_output("sub-deletable.png", subfolder="upscaled").get("ok"))
    and not os.path.exists(SUBDELETABLE),
)
check("重复删除返回不存在", files.delete_output("deletable.png").get("ok") is False)
check(
    "路径穿越被拒绝",
    files.delete_output("../secret.png").get("ok") is False
    and files.delete_output("../../etc/passwd").get("ok") is False,
)
check("文件名带子目录被拒绝", files.delete_output("upscaled/x.png").get("ok") is False)
check("隐藏文件被拒绝", files.delete_output(".env").get("ok") is False)
check("不允许删非媒体类型", files.delete_output("model.safetensors").get("ok") is False)
check("不允许删 temp / input", files.delete_output("a.png", type_="temp").get("ok") is False)
check("缺少文件名被拒绝", files.delete_output("").get("ok") is False)
check(
    "删除后列表里不再出现",
    all(item["filename"] != "deletable.png" for item in files.list_outputs(limit=50)),
)

# 软链逃逸：输出目录里放一个指向外部文件的软链，必须拒绝
LINK = os.path.join(OUTPUT_DIR, "escape.png")
OUTSIDE = os.path.join(TMP, "outside.png")
write_file(OUTSIDE, b"\x89PNG\r\n\x1a\n outside")
try:
    if os.path.exists(LINK):
        os.remove(LINK)
    os.symlink(OUTSIDE, LINK)
    symlinked = True
except (OSError, NotImplementedError, AttributeError):
    symlinked = False
if symlinked:
    check("软链逃逸被拒绝", files.delete_output("escape.png").get("ok") is False)
    check("外部文件没被删掉", os.path.exists(OUTSIDE))
    os.remove(LINK)
else:
    check("软链逃逸被拒绝", True, "当前环境不支持创建软链，跳过")

# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #
print("\n== HTTP 接口 ==")
routes = FakePromptServer.instance.routes
route_defs = getattr(routes, "_items", None) or list(routes)
# 注意：/workflow 同时有 GET 和 POST，必须按 (方法, 路径) 建索引
handlers = {(route.method, route.path): route.handler for route in route_defs}
check(
    "已注册全部接口",
    {path for _, path in handlers}
    == {
        "/comfui-workbench/stats",
        "/comfui-workbench/ping",
        "/comfui-workbench/outputs",
        "/comfui-workbench/reveal",
        "/comfui-workbench/delete",
        "/comfui-workbench/workflows",
        "/comfui-workbench/workflow",
    },
    str(sorted(f"{method} {path}" for method, path in handlers)),
)


async def call(method, path, request):
    handler = handlers.get((method, path))
    if handler is None:
        raise AssertionError(f"未注册 {method} {path}")
    response = await handler(request)
    return response.status, json.loads(response.body.decode("utf-8"))


async def main() -> None:
    status, payload = await call("GET", "/comfui-workbench/stats", FakeRequest())
    check("GET /stats 返回 200", status == 200)
    check("GET /stats 有 cpu", "cpu" in payload)

    status, payload = await call("GET", "/comfui-workbench/outputs", FakeRequest(query={"limit": "2"}))
    check("GET /outputs 遵守 limit", status == 200 and len(payload["items"]) == 2, str(len(payload.get("items", []))))
    check("GET /outputs 带目录", bool(payload.get("directory")), payload.get("directory"))

    status, payload = await call("GET", "/comfui-workbench/workflows", FakeRequest())
    check(
        "GET /workflows 返回列表",
        status == 200 and len(payload["items"]) >= 1,
        f"{len(payload.get('items', []))} 个",
    )

    status, payload = await call(
        "GET", "/comfui-workbench/workflow", FakeRequest(query={"name": "风景.json"})
    )
    check("GET /workflow 命中", status == 200 and payload.get("ok"), str(payload.get("name")))

    status, payload = await call(
        "GET", "/comfui-workbench/workflow", FakeRequest(query={"name": "不存在.json"})
    )
    check("GET /workflow 未命中返回 404", status == 404)

    status, payload = await call(
        "POST",
        "/comfui-workbench/workflow",
        FakeRequest(body={"name": "接口保存.json", "workflow": {"nodes": []}}),
    )
    check("POST /workflow 保存成功", status == 200 and payload.get("ok"), str(payload.get("name")))

    status, payload = await call(
        "POST", "/comfui-workbench/workflow", FakeRequest(body={"name": "bad.json"})
    )
    check("POST /workflow 缺字段返回 400", status == 400)

    status, payload = await call(
        "POST",
        "/comfui-workbench/reveal",
        FakeRequest(body={"filename": "ComfyUI_00001_.png"}),
    )
    check("POST /reveal 响应正常", status in (200, 400), json.dumps(payload, ensure_ascii=False))

    status, payload = await call(
        "POST",
        "/comfui-workbench/reveal",
        FakeRequest(body={"filename": "../../etc/passwd"}),
    )
    check("POST /reveal 拒绝穿越", status == 404, json.dumps(payload, ensure_ascii=False))

    # 删除接口：真实删一个文件，再验证列表里没了
    write_file(os.path.join(OUTPUT_DIR, "api-delete.png"), b"\x89PNG\r\n\x1a\n api")
    status, payload = await call(
        "POST",
        "/comfui-workbench/delete",
        FakeRequest(body={"filename": "api-delete.png"}),
    )
    check("POST /delete 删除成功", status == 200 and payload.get("ok"), json.dumps(payload, ensure_ascii=False))
    check("POST /delete 磁盘文件已消失", not os.path.exists(os.path.join(OUTPUT_DIR, "api-delete.png")))

    status, payload = await call(
        "POST",
        "/comfui-workbench/delete",
        FakeRequest(body={"filename": "api-delete.png"}),
    )
    check("POST /delete 重复删除返回 400", status == 400, json.dumps(payload, ensure_ascii=False))

    status, payload = await call(
        "POST",
        "/comfui-workbench/delete",
        FakeRequest(body={"filename": "../../etc/passwd"}),
    )
    check("POST /delete 拒绝穿越", status == 400, json.dumps(payload, ensure_ascii=False))

    status, payload = await call("GET", "/comfui-workbench/ping", FakeRequest())
    check("GET /ping 正常", status == 200 and payload.get("ok"))


asyncio.run(main())

# --------------------------------------------------------------------------- #
# 汇总
# --------------------------------------------------------------------------- #
print()
if failures:
    print(f"❌ {len(failures)} 项失败：{', '.join(failures)}")
    sys.exit(1)
print("✅ 全部通过")
