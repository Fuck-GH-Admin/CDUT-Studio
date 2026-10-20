"""CSLab 用户 Python 工具扫描器（AST 静态分析）

用法：python cslab-tool-scanner.py --file <path>
输出：单行 JSON，便于宿主解析。
"""

from __future__ import annotations

import argparse
import ast
import json
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    return parser.parse_args()


def annotation_to_text(node: ast.AST | None) -> str | None:
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:
        return None


def collect_function(node: ast.FunctionDef | ast.AsyncFunctionDef, module_doc: str) -> dict:
    args = list(node.args.posonlyargs) + list(node.args.args)
    defaults = [None] * (len(args) - len(node.args.defaults)) + list(node.args.defaults)
    params = []

    for arg, default in zip(args, defaults):
        if arg.arg in ("self", "cls"):
            continue
        params.append(
            {
                "name": arg.arg,
                "annotation": annotation_to_text(arg.annotation),
                "required": default is None,
                "default": annotation_to_text(default) if default is not None else None,
            }
        )

    for arg, default in zip(node.args.kwonlyargs, node.args.kw_defaults):
        params.append(
            {
                "name": arg.arg,
                "annotation": annotation_to_text(arg.annotation),
                "required": default is None,
                "default": annotation_to_text(default) if default is not None else None,
            }
        )

    has_varargs = node.args.vararg is not None or node.args.kwarg is not None
    is_async = isinstance(node, ast.AsyncFunctionDef)
    docstring = ast.get_docstring(node) or ""

    return {
        "name": node.name,
        "docstring": docstring,
        "moduleDoc": module_doc,
        "args": params,
        "returns": annotation_to_text(node.returns),
        "unsupportedReason": (
            "不支持 async 函数" if is_async else ("不支持 *args/**kwargs 变长参数" if has_varargs else None)
        ),
    }


def main() -> None:
    args = parse_args()
    try:
        with open(args.file, "r", encoding="utf-8") as handle:
            source = handle.read()
        tree = ast.parse(source)
        module_doc = ast.get_docstring(tree) or ""
        functions = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name.startswith("_"):
                    continue
                functions.append(collect_function(node, module_doc))
        sys.stdout.write(
            json.dumps(
                {"ok": True, "moduleDoc": module_doc, "functions": functions},
                ensure_ascii=False,
            )
        )
    except Exception as error:  # noqa: BLE001 - 必须把语法错误原样回报给宿主
        sys.stdout.write(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
