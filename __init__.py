"""ComfUI Workbench —— 把 ComfyUI 变成「简易工作台」的界面插件。

布局：顶部资源占用条 + 左侧提示词/参数 + 中间原生节点画布 + 右侧输出结果。

本插件不包含任何节点，只提供一个前端扩展（web/）和几个只读辅助接口：
    GET  /comfui-workbench/stats      资源占用（CPU / 内存 / 显卡 / 显存 / 队列）
    GET  /comfui-workbench/outputs    输出目录里的历史产物列表
    GET  /comfui-workbench/workflows  用户工作流列表
    GET  /comfui-workbench/workflow   读取某个工作流 JSON
    POST /comfui-workbench/workflow   保存工作流 JSON
    POST /comfui-workbench/reveal     在系统文件管理器中定位文件
"""

import traceback

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# ComfyUI 会把该目录下的所有 .js 作为前端扩展自动加载
WEB_DIRECTORY = "./web"

__version__ = "1.0.0"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "__version__"]

# 注册后端路由。任何异常都不应该影响 ComfyUI 启动，因此整体 try/except 兜底。
try:
    from .routes import register_routes

    if register_routes():
        print("[ComfUI Workbench] 后端接口已注册：/comfui-workbench/*")
    else:
        print("[ComfUI Workbench] 未检测到 PromptServer，跳过后端接口注册（仅界面功能可用）")
except Exception:  # pragma: no cover - 启动期保护
    print("[ComfUI Workbench] 后端接口注册失败，界面仍可使用（资源条会退化为 /system_stats）：")
    traceback.print_exc()
