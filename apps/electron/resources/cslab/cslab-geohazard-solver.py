#!/usr/bin/env python3
"""CSLab 泥石流高精度通道（可选 numpy 加速）

用法：
  python cslab-geohazard-solver.py --dem DEM.asc --params params.json --out OUT_DIR

输出：
  max_depth.asc / max_speed.asc / arrival.asc / timeseries.csv / result.json

无 numpy 时以退出码 2 结束，主进程自动回退 TypeScript 求解器。
"""

import argparse
import json
import math
import os
import sys

try:
    import numpy as np
except Exception:  # pragma: no cover - 运行环境缺依赖
    print("MISSING_NUMPY", file=sys.stderr)
    sys.exit(2)

G = 9.81
RHO = 2000
MIN_DEPTH = 1e-4


def read_asc(path):
    header = {}
    with open(path, "r", encoding="utf-8") as fh:
        lines = [line.strip() for line in fh if line.strip()]
    data_start = 0
    for idx, line in enumerate(lines):
        parts = line.split()
        if len(parts) == 2 and parts[1].replace(".", "", 1).replace("-", "", 1).isdigit():
            header[parts[0].lower()] = float(parts[1])
            data_start = idx + 1
        else:
            break
    width = int(header["ncols"])
    height = int(header["nrows"])
    nodata = header.get("nodata_value")
    values = np.fromstring(" ".join(lines[data_start:]), sep=" ", dtype=np.float64)
    values = values[: width * height].reshape((height, width)).astype(np.float64)
    if nodata is not None:
        values[values == nodata] = np.nan
    return header, values


def write_asc(path, header, values, nodata=-9999):
    height, width = values.shape
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f"ncols {width}\nnrows {height}\n")
        fh.write(f"xllcorner {header.get('xllcorner', 0)}\n")
        fh.write(f"yllcorner {header.get('yllcorner', 0)}\n")
        fh.write(f"cellsize {header.get('cellsize', 1)}\n")
        fh.write(f"NODATA_value {nodata}\n")
        for row in values:
            row = np.where(np.isfinite(row), np.round(row, 3), nodata)
            fh.write(" ".join(str(v) for v in row) + "\n")


def analyze(header, z):
    height, width = z.shape
    cell = float(header.get("cellsize", 1))
    valid = np.isfinite(z)
    slope = np.zeros_like(z)
    down = np.full((height, width), -1, dtype=np.int64)
    zz = np.where(valid, z, np.nan)
    for r in range(1, height - 1):
        for c in range(1, width - 1):
            block = zz[r - 1:r + 2, c - 1:c + 2]
            if not np.all(np.isfinite(block)):
                continue
            dzdx = ((block[0, 2] + 2 * block[1, 2] + block[2, 2]) - (block[0, 0] + 2 * block[1, 0] + block[2, 0])) / (8 * cell)
            dzdy = ((block[2, 0] + 2 * block[2, 1] + block[2, 2]) - (block[0, 0] + 2 * block[0, 1] + block[0, 2])) / (8 * cell)
            slope[r, c] = math.degrees(math.atan(math.hypot(dzdx, dzdy)))
            best = 0.0
            best_idx = -1
            for i, (dr, dc) in enumerate([(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]):
                nr, nc = r + dr, c + dc
                if not np.isfinite(zz[nr, nc]):
                    continue
                grad = (zz[r, c] - zz[nr, nc]) / (math.hypot(dr, dc) * cell)
                if grad > best:
                    best = grad
                    best_idx = i
            if best_idx >= 0:
                dr, dc = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)][best_idx]
                down[r, c] = (r + dr) * width + (c + dc)
    acc = np.where(valid, 1.0, 0.0)
    order = np.argsort(-np.nan_to_num(z, nan=-1e18), axis=None)
    flat = acc.reshape(-1)
    for idx in order:
        target = down.reshape(-1)[idx]
        if target >= 0:
            flat[target] += flat[idx]
    valid_count = int(valid.sum())
    threshold = max(50, int(round(valid_count * 0.02)))
    channels = np.where((acc >= threshold) & valid)
    if len(channels[0]) > 0:
        heights = z[channels]
        best = int(np.argmax(heights))
        source = (int(channels[0][best]), int(channels[1][best]))
    else:
        flat_idx = int(np.nanargmax(z))
        source = (flat_idx // width, flat_idx % width)
    return acc, threshold, source, float(np.nanmean(slope[slope > 0])) if np.any(slope > 0) else 0.0


def friction(rheology, h, speed):
    if rheology.get("model") == "bingham":
        yield_stress = max(0.0, float(rheology.get("yieldStressPa", 0)))
        viscosity = max(0.0, float(rheology.get("viscosityPaS", 0)))
        return (yield_stress + 3 * viscosity * speed / max(h, 0.01)) / (RHO * max(h, 0.01))
    mu = max(0.0, float(rheology.get("mu", 0.2)))
    xi = max(1.0, float(rheology.get("xi", 400)))
    return mu * G + G * speed * speed / (xi * max(h, 0.01))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dem", required=True)
    parser.add_argument("--params", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    header, z = read_asc(args.dem)
    with open(args.params, "r", encoding="utf-8") as fh:
        params = json.load(fh)
    os.makedirs(args.out, exist_ok=True)
    height, width = z.shape
    valid = np.isfinite(z)
    cell = float(header.get("cellsize", 1))
    area = cell * cell
    acc, threshold, source, mean_slope = analyze(header, z)
    src_row, src_col = params.get("source", {}).get("row", source[0]), params.get("source", {}).get("col", source[1])

    volume = float(params.get("volumeM3") or 0)
    if volume <= 0 and params.get("rainfall"):
        rain = params["rainfall"]
        runoff = float(rain.get("runoffCoefficient", 0.7))
        catchment = float(rain.get("catchmentAreaM2") or max(1.0, acc[src_row, src_col]) * area)
        volume = runoff * (float(rain["intensityMmPerHour"]) / 1000.0) * (float(rain["durationMin"]) / 60.0) * catchment
    if volume <= 0:
        print("volume must be positive", file=sys.stderr)
        return 1

    duration = float(params.get("durationS", 600))
    cfl = float(params.get("cfl", 0.4))
    rheology = params.get("rheology") or {"model": "voellmy", "mu": 0.2, "xi": 400}
    release_duration = min(duration, max(60.0, float(params.get("rainfall", {}).get("durationMin", 60)) * 60.0))
    release_rate = volume / release_duration

    h = np.zeros_like(z)
    qx = np.zeros_like(z)
    qy = np.zeros_like(z)
    deposit = np.zeros_like(z)
    max_h = np.zeros_like(z)
    max_speed = np.zeros_like(z)
    arrival = np.full_like(z, np.nan)
    released = 0.0
    simulated = 0.0
    timeseries = []
    next_sample = 0.0
    outlet_idx = None
    channel_cells = np.where((acc >= threshold) & valid)
    if len(channel_cells[0]) > 0:
        heights = z[channel_cells]
        outlet = int(np.argmin(heights))
        outlet_idx = (int(channel_cells[0][outlet]), int(channel_cells[1][outlet]))

    while simulated < duration:
        wave = np.nanmax(np.where(valid, np.abs(qx / np.maximum(h, MIN_DEPTH)) + np.sqrt(G * np.maximum(h, 0)), 0))
        dt = min(1.0, cfl * cell / max(0.5, float(wave)), duration - simulated)
        if simulated < release_duration:
            inject = min(volume - released, release_rate * dt)
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    r, c = src_row + dr, src_col + dc
                    if 0 <= r < height and 0 <= c < width and valid[r, c]:
                        h[r, c] += inject / 9.0 / area
            released += inject

        hL, hR = h[:, :-1], h[:, 1:]
        qxL, qxR = qx[:, :-1], qx[:, 1:]
        qyL, qyR = qy[:, :-1], qy[:, 1:]
        uL = qxL / np.maximum(hL, MIN_DEPTH)
        uR = qxR / np.maximum(hR, MIN_DEPTH)
        vL = qyL / np.maximum(hL, MIN_DEPTH)
        vR = qyR / np.maximum(hR, MIN_DEPTH)
        waveX = np.maximum(np.abs(uL) + np.sqrt(G * np.maximum(hL, 0)), np.abs(uR) + np.sqrt(G * np.maximum(hR, 0)))
        fh = 0.5 * (qxL + qxR) - 0.5 * waveX * (hR - hL)
        fqx = 0.5 * (uL * uL * hL + 0.5 * G * hL * hL + uR * uR * hR + 0.5 * G * hR * hR) - 0.5 * waveX * (qxR - qxL)
        fqy = 0.5 * (uL * vL * hL + uR * vR * hR) - 0.5 * waveX * (qyR - qyL)
        div_h = np.zeros_like(h)
        div_qx = np.zeros_like(qx)
        div_qy = np.zeros_like(qy)
        div_h[:, 1:] += fh
        div_h[:, :-1] -= fh
        div_qx[:, 1:] += fqx
        div_qx[:, :-1] -= fqx
        div_qy[:, 1:] += fqy
        div_qy[:, :-1] -= fqy

        hU, hD = h[:-1, :], h[1:, :]
        qxU, qxD = qx[:-1, :], qx[1:, :]
        qyU, qyD = qy[:-1, :], qy[1:, :]
        vU = qyU / np.maximum(hU, MIN_DEPTH)
        vD = qyD / np.maximum(hD, MIN_DEPTH)
        uU = qxU / np.maximum(hU, MIN_DEPTH)
        uD = qxD / np.maximum(hD, MIN_DEPTH)
        waveY = np.maximum(np.abs(vU) + np.sqrt(G * np.maximum(hU, 0)), np.abs(vD) + np.sqrt(G * np.maximum(hD, 0)))
        gh = 0.5 * (qyU + qyD) - 0.5 * waveY * (hD - hU)
        gqx = 0.5 * (uU * vU * hU + uD * vD * hD) - 0.5 * waveY * (qxD - qxU)
        gqy = 0.5 * (vU * vU * hU + 0.5 * G * hU * hU + vD * vD * hD + 0.5 * G * hD * hD) - 0.5 * waveY * (qyD - qyU)
        div_h[1:, :] += gh
        div_h[:-1, :] -= gh
        div_qx[1:, :] += gqx
        div_qx[:-1, :] -= gqx
        div_qy[1:, :] += gqy
        div_qy[:-1, :] -= gqy

        h = h - dt / cell * div_h
        qx = qx - dt / cell * div_qx
        qy = qy - dt / cell * div_qy
        h[~valid] = 0
        qx[~valid] = 0
        qy[~valid] = 0
        h = np.where(h < MIN_DEPTH, 0, h)
        speed = np.where(h > MIN_DEPTH, np.hypot(qx, qy) / np.maximum(h, MIN_DEPTH), 0)
        decel = np.zeros_like(h)
        for r in range(height):
            for c in range(width):
                if h[r, c] > MIN_DEPTH:
                    decel[r, c] = friction(rheology, float(h[r, c]), float(speed[r, c]))
        factor = np.minimum(1.0, dt * decel / np.maximum(speed, 1e-6))
        qx -= qx * factor
        qy -= qy * factor
        moving = (speed < float(params.get("depositionVelocity", 0.5))) & (h > MIN_DEPTH)
        deposit[moving] += h[moving] * 0.05
        h[moving] *= 0.95
        max_h = np.maximum(max_h, h)
        max_speed = np.maximum(max_speed, speed)
        first = np.isnan(arrival) & (h > 0.01)
        arrival[first] = simulated
        simulated += dt
        if simulated >= next_sample:
            next_sample += 2.0
            if outlet_idx is None:
                discharge = 0
                depth = 0
                vel = 0
            else:
                orow, ocol = outlet_idx
                depth = float(h[orow, ocol])
                vel = float(speed[orow, ocol])
                discharge = depth * vel * cell
            timeseries.append({"timeS": round(simulated, 1), "dischargeM3s": round(discharge, 3), "depthM": round(depth, 3), "velocityMs": round(vel, 3)})

    finite_max_h = np.where(np.isfinite(max_h), max_h, 0)
    finite_max_speed = np.where(np.isfinite(max_speed), max_speed, 0)
    write_asc(os.path.join(args.out, "max_depth.asc"), header, finite_max_h)
    write_asc(os.path.join(args.out, "max_speed.asc"), header, finite_max_speed)
    write_asc(os.path.join(args.out, "arrival.asc"), header, arrival, nodata=-1)
    with open(os.path.join(args.out, "timeseries.csv"), "w", encoding="utf-8") as fh:
        fh.write("time_s,discharge_m3_s,depth_m,velocity_m_s\n")
        for point in timeseries:
            fh.write(f"{point['timeS']},{point['dischargeM3s']},{point['depthM']},{point['velocityMs']}\n")

    hazard = {
        "high": int(np.sum(max_h >= 1.0)) * area,
        "medium": int(np.sum((max_h >= 0.3) & (max_h < 1.0))) * area,
        "low": int(np.sum((max_h >= 0.05) & (max_h < 0.3))) * area,
    }
    touched = np.isfinite(arrival)
    if np.any(touched):
        rows, cols = np.where(touched)
        runout = float(np.max(np.hypot(rows - src_row, cols - src_col) * cell))
    else:
        runout = 0.0
    result = {
        "ok": True,
        "engineUsed": "python",
        "model": rheology.get("model", "voellmy"),
        "source": {"row": src_row, "col": src_col, "elevation": float(z[src_row, src_col])},
        "releasedVolumeM3": round(released),
        "peakDischargeM3s": round(max([p["dischargeM3s"] for p in timeseries], default=0.0), 2),
        "maxDepthM": round(float(finite_max_h.max()), 3),
        "maxSpeedMs": round(float(finite_max_speed.max()), 2),
        "runoutDistanceM": round(runout, 1),
        "depositionVolumeM3": round(float(deposit.sum()) * area),
        "arrivalTimeS": round(float(np.nanmin(arrival)) if np.any(np.isfinite(arrival)) else 0.0, 1),
        "hazardAreaM2": hazard,
        "timeseries": timeseries,
        "warnings": ["Python/numpy 通道：与 TypeScript 求解器同构的简化工程模型。"],
        "message": "Python 高精度通道完成；仍需实测降雨、粒径级配与历史灾害校核。",
        "meanSlopeDeg": round(mean_slope, 2),
        "channelThreshold": threshold,
    }
    with open(os.path.join(args.out, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
