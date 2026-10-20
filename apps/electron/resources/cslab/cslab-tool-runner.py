"""CSLab 用户 Python 工具执行器

用法：python cslab-tool-runner.py --file <path> --function <name> --args <jsonPath>
输出：单行 JSON：{"ok": true, "result": ...} 或 {"ok": false, "error": "..."}
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import traceback


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--function", required=True)
    parser.add_argument("--args", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        with open(args.args, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict):
            raise ValueError("参数必须是 JSON 对象")

        spec = importlib.util.spec_from_file_location("cslab_user_tool", args.file)
        if spec is None or spec.loader is None:
            raise ImportError("无法加载目标模块")
        # 允许同目录下多文件工具互相 import。
        sys.path.insert(0, os.path.dirname(os.path.abspath(args.file)))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        function = getattr(module, args.function, None)
        if function is None or not callable(function):
            raise AttributeError(f"函数不存在或不可调用: {args.function}")

        result = function(**payload)
        sys.stdout.write(
            json.dumps({"ok": True, "result": result}, ensure_ascii=False, default=str)
        )
    except Exception as error:  # noqa: BLE001 - 需要把完整堆栈交还宿主
        sys.stdout.write(
            json.dumps(
                {"ok": False, "error": f"{error}\n{traceback.format_exc()}"},
                ensure_ascii=False,
            )
        )


if __name__ == "__main__":
    main()
