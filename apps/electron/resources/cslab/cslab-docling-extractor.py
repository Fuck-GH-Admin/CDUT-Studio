#!/usr/bin/env python3
"""CSLab 文献结构化蒸馏脚本（Docling 渐进增强）。

能力：
- 以 Docling（Granite-Docling，纯 CPU 可运行）解析 PDF 版面结构；
- 导出 Markdown 主体（章节标题 / 摘要段 / 图表题注可辨识）。

红线：docling 未安装时输出 {ok:false,missingDependency:true}，
由上层降级到 LLM / 启发式蒸馏，绝不自动安装、绝不伪造内容。
仅通过 stdout 输出单行 JSON，日志一律写 stderr。
"""

import json
import sys

MARKDOWN_LIMIT = 200_000


def emit(payload):
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "reason": "缺少 PDF 路径"})
        return

    pdf_path = sys.argv[1]
    try:
        from docling.document_converter import DocumentConverter
    except Exception:
        emit({"ok": False, "missingDependency": True, "reason": "docling 未安装"})
        return

    try:
        document = DocumentConverter().convert(pdf_path).document
        markdown = document.export_to_markdown()
        emit({"ok": True, "markdown": markdown[:MARKDOWN_LIMIT]})
    except Exception as error:  # noqa: BLE001
        emit({"ok": False, "reason": str(error)[:500]})


if __name__ == "__main__":
    main()
