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
import re
import sys
import time


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
        return {
            "ok": False,
            "engine": "pix2text",
            "message": "未安装 Pix2Text（可一键安装 formula-ocr 依赖）",
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["verify", "ocr"], required=True)
    parser.add_argument("--lhs", default="")
    parser.add_argument("--rhs", default="")
    parser.add_argument("--symbols", default="{}")
    parser.add_argument("--image", default="")
    args = parser.parse_args()

    if args.mode == "ocr":
        if not args.image:
            emit({"ok": False, "engine": "pix2text", "message": "缺少 --image 参数"})
            return
        emit(ocr(args.image))
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
