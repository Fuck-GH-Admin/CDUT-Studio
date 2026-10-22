/**
 * CSLab 图表数字化纯几何与标定函数
 *
 * 主进程（Python 结果校验）与渲染进程（磁性吸附）共用，禁止依赖任何运行时能力。
 * 红线：
 * 1. 对数映射仅接受正数物理值；无法拟合时如实返回 null，不伪造结果。
 * 2. R² 统一在物理数值空间计算，保证线性/对数比较口径一致。
 */

import type { CsLabAxisTick } from '../types/cslab'

export interface CsLabPoint {
  x: number
  y: number
}

export interface CsLabSegmentProjection {
  point: CsLabPoint
  distance: number
  segmentIndex: number
  polylineIndex: number
}

export interface CsLabAxisScaleFit {
  scale: 'linear' | 'log'
  r2: number
  predict: (pixel: number) => number
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function computeR2(actual: number[], predicted: number[]): number {
  if (actual.length === 0) return 0
  const average = mean(actual)
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < actual.length; i += 1) {
    const diff = actual[i]! - predicted[i]!
    ssRes += diff * diff
    const totalDiff = actual[i]! - average
    ssTot += totalDiff * totalDiff
  }
  if (ssTot === 0) return ssRes === 0 ? 1 : 0
  return 1 - ssRes / ssTot
}

function fitLinear(
  ticks: CsLabAxisTick[],
  coordinate: 'px' | 'py' = 'px',
): CsLabAxisScaleFit | null {
  const pixels = ticks.map((tick) => tick[coordinate])
  const values = ticks.map((tick) => tick.value)
  const pixelMean = mean(pixels)
  const valueMean = mean(values)
  let numerator = 0
  let denominator = 0
  for (let i = 0; i < ticks.length; i += 1) {
    const dx = pixels[i]! - pixelMean
    numerator += dx * (values[i]! - valueMean)
    denominator += dx * dx
  }
  if (denominator === 0) return null
  const slope = numerator / denominator
  const intercept = valueMean - slope * pixelMean
  const predict = (pixel: number): number => slope * pixel + intercept
  return {
    scale: 'linear',
    r2: computeR2(values, pixels.map(predict)),
    predict,
  }
}

function fitLogarithmic(
  ticks: CsLabAxisTick[],
  coordinate: 'px' | 'py' = 'px',
): CsLabAxisScaleFit | null {
  if (ticks.some((tick) => !(tick.value > 0))) return null
  const pixels = ticks.map((tick) => tick[coordinate])
  const logs = ticks.map((tick) => Math.log10(tick.value))
  const pixelMean = mean(pixels)
  const logMean = mean(logs)
  let numerator = 0
  let denominator = 0
  for (let i = 0; i < ticks.length; i += 1) {
    const dx = pixels[i]! - pixelMean
    numerator += dx * (logs[i]! - logMean)
    denominator += dx * dx
  }
  if (denominator === 0) return null
  const slope = numerator / denominator
  const intercept = logMean - slope * pixelMean
  const predict = (pixel: number): number => 10 ** (slope * pixel + intercept)
  return {
    scale: 'log',
    r2: computeR2(
      ticks.map((tick) => tick.value),
      pixels.map(predict),
    ),
    predict,
  }
}

/**
 * 根据刻度点自动选择线性或对数映射。
 *
 * @param ticks 至少 2 个刻度；3 个及以上时 R² 判别更有意义
 * @param preferred 'auto' 时取 R² 更高者；若对数不可用则回退线性
 * @param coordinate 拟合所用的像素方向：X 轴传 'px'，Y 轴传 'py'（Y 轴刻度通常共线于同一 px）
 */
export function fitAxisScale(
  ticks: CsLabAxisTick[],
  preferred: 'auto' | 'linear' | 'log' = 'auto',
  coordinate: 'px' | 'py' = 'px',
): CsLabAxisScaleFit | null {
  const valid = ticks.filter(
    (tick) => Number.isFinite(tick.px) && Number.isFinite(tick.py) && Number.isFinite(tick.value),
  )
  if (valid.length < 2) return null

  const linear = fitLinear(valid, coordinate)
  const logarithmic = fitLogarithmic(valid, coordinate)

  if (preferred === 'linear') return linear ?? logarithmic
  if (preferred === 'log') return logarithmic ?? linear

  if (!linear) return logarithmic
  if (!logarithmic) return linear
  // 明确优先级：R² 相同时选线性，保证结果确定。
  return logarithmic.r2 > linear.r2 + 1e-9 ? logarithmic : linear
}

/** 将像素坐标映射为物理数值；无法拟合时返回 null。X 轴传 'px'，Y 轴传 'py'。 */
export function mapPixelToValue(
  pixel: number,
  ticks: CsLabAxisTick[],
  scale: 'auto' | 'linear' | 'log' = 'auto',
  coordinate: 'px' | 'py' = 'px',
): number | null {
  const fit = fitAxisScale(ticks, scale, coordinate)
  if (!fit) return null
  const value = fit.predict(pixel)
  return Number.isFinite(value) ? value : null
}

/** 点到线段的最短投影（含端点裁剪）。 */
export function projectPointOnSegment(
  point: CsLabPoint,
  start: CsLabPoint,
  end: CsLabPoint,
): CsLabSegmentProjection {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) {
    return {
      point: { x: start.x, y: start.y },
      distance: Math.hypot(point.x - start.x, point.y - start.y),
      segmentIndex: 0,
      polylineIndex: 0,
    }
  }
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  )
  const projected = { x: start.x + t * dx, y: start.y + t * dy }
  return {
    point: projected,
    distance: Math.hypot(point.x - projected.x, point.y - projected.y),
    segmentIndex: 0,
    polylineIndex: 0,
  }
}

/**
 * 磁性吸附：在阈值内投影到最近折线段；阈值外原样返回。
 *
 * @param point 当前控制点（图像像素坐标）
 * @param polylines 后端返回的曲线像素折线集合
 * @param threshold 吸附半径（图像像素）
 */
export function snapPointToPolyline(
  point: CsLabPoint,
  polylines: Array<Array<[number, number]>>,
  threshold: number,
): CsLabSegmentProjection {
  let bestProjection: CsLabSegmentProjection | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (let polylineIndex = 0; polylineIndex < polylines.length; polylineIndex += 1) {
    const polyline = polylines[polylineIndex]!
    for (let index = 1; index < polyline.length; index += 1) {
      const start = polyline[index - 1]!
      const end = polyline[index]!
      const projection = projectPointOnSegment(
        point,
        { x: start[0], y: start[1] },
        { x: end[0], y: end[1] },
      )
      if (projection.distance < bestDistance) {
        bestDistance = projection.distance
        bestProjection = {
          ...projection,
          segmentIndex: index - 1,
          polylineIndex,
        }
      }
    }
  }

  if (bestProjection && bestDistance <= threshold) return bestProjection
  return {
    point: { x: point.x, y: point.y },
    distance: bestDistance,
    segmentIndex: -1,
    polylineIndex: -1,
  }
}

/** 计算若干点的凸包面积（仅用于散点质量过滤的轻量辅助）。 */
export function polygonArea(points: CsLabPoint[]): number {
  if (points.length < 3) return 0
  let area = 0
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]!
    const next = points[(i + 1) % points.length]!
    area += current.x * next.y - next.x * current.y
  }
  return Math.abs(area) / 2
}
