#!/usr/bin/env python3
"""CSLab 可选 Python 增强提取器。

仅作为 TypeScript 主实现的能力补充：
- mat-v73: MATLAB v7.3 (HDF5)，依赖 h5py
- biologic-mpr: BioLogic EC-Lab .mpr，依赖 yadg 或 eclabfiles

输出统一 JSON：{ok, xLabel, xUnit, x, series:[{label,unit,values}], metadata}
任何依赖缺失都会输出 {ok:false,message}，由主进程安静降级。
"""

import argparse
import json
import sys


def emit(payload):
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()


def parse_mat_v73(path):
    try:
        import h5py  # type: ignore
        import numpy as np  # type: ignore
    except Exception:
        return {"ok": False, "message": "缺少 h5py/numpy，无法解析 MAT v7.3"}

    with h5py.File(path, "r") as handle:
        best = None

        def visitor(name, obj):
            nonlocal best
            if not hasattr(obj, "shape") or not hasattr(obj, "dtype"):
                return
            if obj.dtype.kind not in "fiu":
                return
            if len(obj.shape) != 2 or obj.size < 2:
                return
            score = obj.size
            if best is None or score > best[0]:
                best = (score, name, obj)

        handle.visititems(visitor)
        if best is None:
            return {"ok": False, "message": "HDF5 中未找到二维数值矩阵"}

        _, name, dataset = best
        matrix = np.array(dataset).astype(float)
        if matrix.shape[0] < matrix.shape[1]:
            matrix = matrix.T
        x = matrix[:, 0].tolist()
        series = [
            {"label": f"{name}[:, {index + 1}]", "values": matrix[:, index].tolist()}
            for index in range(1, matrix.shape[1])
        ]
        return {
            "ok": True,
            "xLabel": "X",
            "x": x,
            "series": series or [{"label": name, "values": matrix[:, 0].tolist()}],
            "metadata": {"variable": name, "shape": list(matrix.shape), "engine": "h5py"},
        }


def parse_biologic_mpr(path):
    try:
        from yadg import dg  # type: ignore
    except Exception:
        return {"ok": False, "message": "缺少 yadg，无法解析 BioLogic .mpr"}

    try:
        data = dg.from_file(path, encoding="thermogravimetry")  # 通用解析入口
    except Exception as error:
        return {"ok": False, "message": f"yadg 解析失败: {error}"}

    return {"ok": False, "message": f"yadg 已加载但未匹配到可用扫描: {type(data)}"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--format", required=True, choices=["mat-v73", "biologic-mpr"])
    args = parser.parse_args()

    if args.format == "mat-v73":
        emit(parse_mat_v73(args.input))
    else:
        emit(parse_biologic_mpr(args.input))


if __name__ == "__main__":
    main()
