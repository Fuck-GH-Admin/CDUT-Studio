#!/usr/bin/env python3
"""CSLab 公式验算与可选 OCR 脚本。

评审加固 11.5：verify 模式只依赖 SymPy，绝不 import pix2text；
ocr 模式是独立分支，失败只影响识别按钮。

verify 输出：
{ok, engine, equivalent, residual, dimensions, singularities, limitNotes,
 preprocess:{appliedFixes}, elapsedMs}
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time

# 进程间编码治理：Windows 中文系统下默认走 CP936，与 Node 端 UTF-8 解码不一致会产生乱码。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

# 内置 antlr4 runtime（vendor/antlr4），使 SymPy parse_latex 开箱即用（Bug 3）。
# 插入的是 vendor 这一层，让 `import antlr4` 命中 vendor/antlr4/。
_VENDOR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
if os.path.isdir(_VENDOR_DIR) and _VENDOR_DIR not in sys.path:
    sys.path.insert(0, _VENDOR_DIR)


def emit(payload):
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()


def preprocess_latex(latex):
    fixes = []
    text = latex.strip()
    if "\\left" in text or "\\right" in text:
        text = text.replace("\\left", "").replace("\\right", "")
        fixes.append("移除 \\left/\\right 尺寸修饰")
    text = text.replace("\\,", "").replace("\\;", "").replace("\\!", "")
    text = text.replace("\\displaystyle", "")
    # 为裸微分补显式括号：\int f dx → \int (f) dx
    if "\\int" in text and "(" not in text and ")(" not in text:
        code = re.sub(r"\\int\s*(.+?)\s*(d[a-zA-Z]+)", r"\\int \\left(\1\\right) \2", text)
        if code != text:
            text = code
            fixes.append("为积分式补充显式括号")
    return text, fixes


SAFE_FUNCTIONS = {
    "sin", "cos", "tan", "cot", "sec", "csc",
    "asin", "acos", "atan", "sinh", "cosh", "tanh",
    "exp", "log", "sqrt", "Abs", "pi", "E",
}


def parse_ascii_expression(latex, local_dict):
    """安全解析纯 ASCII 数学表达式。

    严禁调用 sp.sympify（底层为 eval），仅使用受限 parse_expr + 严格白名单校验。
    """
    import sympy as sp
    from sympy.parsing.sympy_parser import (
        implicit_multiplication_application,
        parse_expr,
        standard_transformations,
    )

    text = latex.strip()
    if not text:
        raise ValueError("表达式为空")

    # 1. 替换幂运算符与 ln 映射
    text = re.sub(r"\bln\b", "log", text)
    text = text.replace("^", "**")

    # 2. 全字符白名单校验
    if not re.match(r"^[0-9A-Za-z_\s+\-*/().,]+$", text):
        raise ValueError("含有非法字符")

    # 3. 禁止双下划线与非数字点操作符，阻断 Python 属性链穿透
    if "__" in text or re.search(r"\.(?![0-9])", text):
        raise ValueError("禁止属性访问或特殊变量")

    # 4. 提取所有标识符并做严格符号/白名单函数校验
    identifiers = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", text))
    for identifier in identifiers:
        if identifier not in local_dict and identifier not in SAFE_FUNCTIONS:
            raise ValueError(f"未知或未受信任的标识符: {identifier}")

    # 5. 构造严格受限的全局命名空间
    global_dict = {
        "Symbol": sp.Symbol,
        "Integer": sp.Integer,
        "Float": sp.Float,
        "Rational": sp.Rational,
        # 隐式乘法与幂运算在 evaluate=False 下需要显式构造函数。
        "Mul": sp.Mul,
        "Add": sp.Add,
        "Pow": sp.Pow,
        "pi": sp.pi,
        "E": sp.E,
    }
    for func_name in SAFE_FUNCTIONS:
        if hasattr(sp, func_name):
            global_dict[func_name] = getattr(sp, func_name)

    return parse_expr(
        text,
        local_dict=local_dict,
        global_dict=global_dict,
        # 追加隐式乘法，保留 2x、x(x+1) 这类学术公式的自然输入。
        transformations=standard_transformations + (implicit_multiplication_application,),
        evaluate=False,
    )


def parse_latex_to_sympy(latex, symbols):
    import sympy as sp

    local_dict = {}
    for name in symbols.keys():
        local_dict[name] = sp.Symbol(name)
        local_dict[name.replace("_", "")] = sp.Symbol(name)

    engine = "sympy.parse_latex"
    try:
        from latex2sympy2 import latex2sympy

        return latex2sympy(latex, local_dict=local_dict or None), "latex2sympy2"
    except Exception:
        pass

    from sympy.parsing.latex import parse_latex

    try:
        try:
            return parse_latex(latex, strict=False, local_dict=local_dict or None), engine
        except TypeError:
            return parse_latex(latex, strict=False), engine
    except Exception as latex_error:
        # 红线：严禁对不可信输入调用 sp.sympify（底层是 eval）。
        # 纯 ASCII 数学表达式改走白名单 + 受限 global_dict 的 parse_expr。
        try:
            return parse_ascii_expression(latex, local_dict), "sympy.parse_expr_safe"
        except Exception:
            raise latex_error


def verify(latex_lhs, latex_rhs, symbols):
    import sympy as sp

    started = time.time()
    lhs_text, lhs_fixes = preprocess_latex(latex_lhs)
    rhs_text, rhs_fixes = preprocess_latex(latex_rhs)

    try:
        lhs, lhs_engine = parse_latex_to_sympy(lhs_text, symbols)
        rhs, rhs_engine = parse_latex_to_sympy(rhs_text, symbols)
    except Exception as error:
        return {
            "ok": False,
            "engine": "sympy",
            "message": f"LaTeX 语法解析失败：{error}",
            "preprocess": {"appliedFixes": lhs_fixes + rhs_fixes},
        }

    difference = sp.simplify(sp.expand(lhs - rhs))
    equivalent = difference == 0
    if not equivalent:
        # 二次尝试：通分与三角化简。
        try:
            difference = sp.trigsimp(sp.cancel(difference))
            equivalent = difference == 0
        except Exception:
            pass

    dimensions = {"note": "未提供量纲映射，未执行量纲齐次性校验"}
    if symbols:
        try:
            import sympy.physics.units as units
            from sympy.physics.units.systems.si import dimsys_SI

            substitutions = {}
            for name, unit_name in symbols.items():
                quantity = getattr(units, str(unit_name), None)
                if quantity is not None:
                    substitutions[sp.Symbol(name)] = quantity
            if substitutions:
                lhs_dim = dimsys_SI.get_dimensional_dependencies(lhs.subs(substitutions))
                rhs_dim = dimsys_SI.get_dimensional_dependencies(rhs.subs(substitutions))
                dimensions = {
                    "lhs": {str(key): value for key, value in lhs_dim.items()},
                    "rhs": {str(key): value for key, value in rhs_dim.items()},
                    "homogeneous": lhs_dim == rhs_dim,
                    "note": "基于 dimsys_SI 的量纲依赖比较",
                }
        except Exception as error:
            dimensions = {"note": f"量纲校验未执行：{error}"}

    singularities = []
    limit_notes = []
    free_symbols = sorted(difference.free_symbols, key=lambda item: str(item))[:8]
    for variable in free_symbols:
        try:
            at_zero = sp.limit(difference, variable, 0, dir="+")
            if at_zero in (sp.oo, -sp.oo, sp.zoo):
                singularities.append(str(variable))
        except Exception:
            limit_notes.append(f"{variable} → 0+ 极限无法闭式求解")
        try:
            at_infinity = sp.limit(difference, variable, sp.oo)
            if at_infinity in (sp.oo, -sp.oo, sp.zoo):
                singularities.append(f"{variable} → ∞")
        except Exception:
            limit_notes.append(f"{variable} → ∞ 极限无法闭式求解")

    if len(free_symbols) >= 2:
        limit_notes.append("多变量极限为逐点计算，结果仅作条件性收敛提示")

    return {
        "ok": True,
        "engine": lhs_engine if lhs_engine == rhs_engine else f"{lhs_engine}+{rhs_engine}",
        "equivalent": bool(equivalent),
        "residual": None if equivalent else str(difference),
        "dimensions": dimensions,
        "singularities": singularities,
        "limitNotes": limit_notes,
        "preprocess": {"appliedFixes": lhs_fixes + rhs_fixes},
        "elapsedMs": int((time.time() - started) * 1000),
    }


def ocr(image_path):
    started = time.time()
    try:
        from pix2text import Pix2Text
    except Exception:
        # engine 值显式区分「依赖未装」，供翻译面板渲染一键安装引导。
        return {
            "ok": False,
            "engine": "pix2text-missing",
            "message": "未安装 Pix2Text（可一键安装学术 OCR 引擎）",
        }

    try:
        recognizer = Pix2Text.from_config()
        result = recognizer.recognize_formula(image_path)
        if isinstance(result, dict):
            latex = result.get("text") or result.get("latex")
        elif isinstance(result, list) and result:
            first = result[0]
            latex = first.get("text") if isinstance(first, dict) else str(first)
        else:
            latex = str(result)
        if not latex:
            return {"ok": False, "engine": "pix2text", "message": "未识别出公式"}
        return {
            "ok": True,
            "engine": "pix2text",
            "latex": latex,
            "elapsedMs": int((time.time() - started) * 1000),
        }
    except Exception as error:
        return {
            "ok": False,
            "engine": "pix2text",
            "message": f"公式识别失败：{error}",
        }


def ocr_text(image_path):
    """整页纯文本 OCR：逐行识别并拼接（行内公式保留 $...$），供学术翻译使用。"""
    started = time.time()
    try:
        from pix2text import Pix2Text
    except Exception:
        return {
            "ok": False,
            "engine": "pix2text-missing",
            "message": "未安装 Pix2Text（可一键安装学术 OCR 引擎）",
        }

    try:
        recognizer = Pix2Text.from_config()
        result = recognizer.recognize(image_path)
        lines = []
        if isinstance(result, list):
            for item in result:
                if isinstance(item, dict):
                    text = item.get("text") or item.get("latex")
                    if isinstance(text, str) and text.strip():
                        lines.append(text.strip())
                elif isinstance(item, str) and item.strip():
                    lines.append(item.strip())
        elif isinstance(result, dict):
            text = result.get("text") or result.get("latex")
            if isinstance(text, str) and text.strip():
                lines.append(text.strip())
        elif isinstance(result, str) and result.strip():
            lines.append(result.strip())
        joined = "\n".join(lines).strip()
        if not joined:
            return {"ok": False, "engine": "pix2text", "message": "未识别出文本"}
        return {
            "ok": True,
            "engine": "pix2text",
            "text": joined,
            "elapsedMs": int((time.time() - started) * 1000),
        }
    except Exception as error:
        return {
            "ok": False,
            "engine": "pix2text",
            "message": f"文本识别失败：{error}",
        }


def _load_pix2text():
    """加载 Pix2Text；未安装时返回 None（调用方如实报告 pix2text-missing）。"""
    try:
        from pix2text import Pix2Text
    except Exception:
        return None
    return Pix2Text


def _render_pdf_page(pdf_path, page_no):
    """把指定页渲染为 PIL 图像。

    渲染统一放在 Python 端完成：Node/Electron 主进程不引入 canvas 依赖。
    依次尝试 pypdfium2（pix2text 自带）与 PyMuPDF，两者都不可用时返回 None。
    返回 (image, page_width_pts, page_height_pts)。
    """
    try:
        import pypdfium2 as pdfium
    except Exception:
        pdfium = None
    if pdfium is not None:
        try:
            doc = pdfium.PdfDocument(pdf_path)
            index = max(0, min(len(doc) - 1, page_no - 1))
            page = doc[index]
            bitmap = page.render(scale=200 / 72.0)
            image = bitmap.to_pil()
            width, height = page.get_size()
            doc.close()
            return image, float(width), float(height)
        except Exception:
            pass

    try:
        import io

        import fitz  # PyMuPDF
        from PIL import Image

        doc = fitz.open(pdf_path)
        index = max(0, min(doc.page_count - 1, page_no - 1))
        page = doc[index]
        pix = page.get_pixmap(dpi=200)
        image = Image.open(io.BytesIO(pix.tobytes("png")))
        rect = page.rect
        doc.close()
        return image, float(rect.width), float(rect.height)
    except Exception:
        pass

    return None


def _flatten_recognize_result(result):
    """把 Pix2Text.recognize 的返回摊平为 [{text, box}] 列表。"""
    items = []

    def take(entry):
        if isinstance(entry, dict):
            text = entry.get("text") or entry.get("latex")
            if isinstance(text, str) and text.strip():
                box = entry.get("box") or entry.get("position")
                items.append({"text": text.strip(), "box": box})
            for key in ("children", "lines", "regions", "content"):
                nested = entry.get(key)
                if isinstance(nested, (list, tuple)):
                    for child in nested:
                        take(child)
        elif isinstance(entry, (list, tuple)):
            for child in entry:
                take(child)
        elif isinstance(entry, str) and entry.strip():
            items.append({"text": entry.strip(), "box": None})

    take(result)
    return items


def _box_to_rect(box, fallback):
    """把 Pix2Text 的 box（[[x,y]x4] 或 [x0,y0,x1,y1]）转成 {x,y,w,h} 像素矩形。"""
    try:
        if isinstance(box, (list, tuple)) and len(box) == 4:
            flat = []
            for item in box:
                if isinstance(item, (list, tuple)) and len(item) >= 2:
                    flat.append((float(item[0]), float(item[1])))
                elif isinstance(item, (int, float)):
                    flat.append(float(item))
            if len(flat) == 4 and all(isinstance(p, tuple) for p in flat):
                xs = [p[0] for p in flat]
                ys = [p[1] for p in flat]
                x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
                return {"x": x0, "y": y0, "w": max(1.0, x1 - x0), "h": max(1.0, y1 - y0)}
            if len(flat) == 4 and all(isinstance(p, float) for p in flat):
                x0, y0, x1, y1 = flat
                return {"x": x0, "y": y0, "w": max(1.0, x1 - x0), "h": max(1.0, y1 - y0)}
    except Exception:
        pass
    return fallback


def ocr_pdf_region(pdf_path, page_no, bbox, kind):
    """对 PDF 指定页的归一化区域做视觉识别。

    kind='formula' 返回端到端 LaTeX；kind='text' 返回带像素坐标的字块，
    坐标相对裁剪图（Node 侧的 transformToNormalizedBBox 据此映射回页面归一化坐标）。
    """
    started = time.time()
    Pix2Text = _load_pix2text()
    if Pix2Text is None:
        return {
            "ok": False,
            "engine": "pix2text-missing",
            "message": "未安装 Pix2Text（可一键安装学术 OCR 引擎）",
        }

    rendered = _render_pdf_page(pdf_path, page_no)
    if rendered is None:
        return {
            "ok": False,
            "engine": "pix2text",
            "message": "无法渲染 PDF 页面（缺少 pypdfium2 / PyMuPDF）",
        }

    image, _page_w, _page_h = rendered
    width, height = image.size
    try:
        x0, y0, x1, y1 = [float(v) for v in bbox]
    except Exception:
        x0, y0, x1, y1 = 0.0, 0.0, 1.0, 1.0

    left = int(max(0.0, min(1.0, x0)) * width)
    top = int(max(0.0, min(1.0, y0)) * height)
    right = int(max(0.0, min(1.0, x1)) * width)
    bottom = int(max(0.0, min(1.0, y1)) * height)
    if right - left < 2 or bottom - top < 2:
        left, top, right, bottom = 0, 0, width, height
    crop = image.crop((left, top, right, bottom))

    temp_dir = tempfile.mkdtemp(prefix="cslab-ocr-pdf-")
    try:
        image_path = os.path.join(temp_dir, "region.png")
        crop.save(image_path)
        recognizer = Pix2Text.from_config()

        if kind == "formula":
            result = recognizer.recognize_formula(image_path)
            if isinstance(result, dict):
                latex = result.get("text") or result.get("latex")
            elif isinstance(result, list) and result:
                first = result[0]
                latex = first.get("text") if isinstance(first, dict) else str(first)
            else:
                latex = str(result)
            if not latex:
                return {
                    "ok": False,
                    "engine": "pix2text",
                    "message": "未识别出公式",
                    "elapsedMs": int((time.time() - started) * 1000),
                }
            return {
                "ok": True,
                "engine": "pix2text",
                "latex": latex,
                "elapsedMs": int((time.time() - started) * 1000),
            }

        result = recognizer.recognize(image_path)
        items = _flatten_recognize_result(result)
        crop_w, crop_h = crop.size
        blocks = []
        for index, item in enumerate(items):
            fallback = {
                "x": 0.0,
                "y": crop_h * index / max(1, len(items)),
                "w": float(crop_w),
                "h": float(crop_h) / max(1, len(items)),
            }
            blocks.append(
                {
                    "text": item["text"],
                    "rect": _box_to_rect(item["box"], fallback),
                    "confidence": 0.9,
                }
            )
        return {
            "ok": True,
            "engine": "pix2text",
            "blocks": blocks,
            "imageWidth": crop_w,
            "imageHeight": crop_h,
            "elapsedMs": int((time.time() - started) * 1000),
        }
    except Exception as error:
        return {
            "ok": False,
            "engine": "pix2text",
            "message": f"区域识别失败：{error}",
            "elapsedMs": int((time.time() - started) * 1000),
        }
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["verify", "ocr", "ocr-text", "ocr-pdf"], required=True)
    parser.add_argument("--lhs", default="")
    parser.add_argument("--rhs", default="")
    parser.add_argument("--symbols", default="{}")
    parser.add_argument("--image", default="")
    parser.add_argument("--pdf", default="")
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--bbox", default="0,0,1,1")
    parser.add_argument("--kind", choices=["text", "formula"], default="text")
    args = parser.parse_args()

    if args.mode == "ocr-pdf":
        if not args.pdf:
            emit({"ok": False, "engine": "pix2text", "message": "缺少 --pdf 参数"})
            return
        bbox = [float(v) for v in args.bbox.split(",")[:4]] if args.bbox else [0.0, 0.0, 1.0, 1.0]
        if len(bbox) != 4:
            bbox = [0.0, 0.0, 1.0, 1.0]
        emit(ocr_pdf_region(args.pdf, args.page, bbox, args.kind))
        return

    if args.mode == "ocr":
        if not args.image:
            emit({"ok": False, "engine": "pix2text", "message": "缺少 --image 参数"})
            return
        emit(ocr(args.image))
        return

    if args.mode == "ocr-text":
        if not args.image:
            emit({"ok": False, "engine": "pix2text", "message": "缺少 --image 参数"})
            return
        emit(ocr_text(args.image))
        return

    try:
        import sympy  # noqa: F401
    except Exception:
        emit(
            {
                "ok": False,
                "engine": "sympy",
                "message": "未安装 SymPy（可一键安装 formula 依赖）",
            }
        )
        return

    try:
        symbols = json.loads(args.symbols or "{}")
        if not isinstance(symbols, dict):
            symbols = {}
    except Exception:
        symbols = {}

    if not args.lhs.strip() or not args.rhs.strip():
        emit({"ok": False, "engine": "sympy", "message": "请提供等式左右两侧的 LaTeX"})
        return

    emit(verify(args.lhs, args.rhs, symbols))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # 统一以 JSON 返回，避免主进程解析到半截 stdout。
        emit({"ok": False, "engine": "sympy", "message": f"公式验算脚本异常：{error}"})
