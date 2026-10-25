/**
 * Origin 画布平移/缩放的数学保护
 *
 * 对数轴必须在对数域平移与缩放，且 min 不能跌入 <=0；否则 Math.log10 会产生
 * NaN / -Infinity，导致整条曲线消失。所有函数保持纯函数，便于单测。
 */

import type { CsLabPlotAxisScale } from '@profer/shared'

const MIN_POSITIVE = 1e-4

export function isLogAxis(scale: CsLabPlotAxisScale): boolean {
  return scale === 'log10' || scale === 'log2'
}

function logBase(scale: CsLabPlotAxisScale): (value: number) => number {
  return scale === 'log2' ? Math.log2 : Math.log10
}

function toScaled(value: number, scale: CsLabPlotAxisScale): number {
  return isLogAxis(scale) ? logBase(scale)(value) : value
}

function fromScaled(value: number, scale: CsLabPlotAxisScale): number {
  return isLogAxis(scale) ? (scale === 'log2' ? 2 ** value : 10 ** value) : value
}

/** 对数轴正下界：max(1e-4, dataMin*0.1)。 */
export function axisPositiveFloor(scale: CsLabPlotAxisScale, dataMin: number): number {
  if (!isLogAxis(scale)) return Number.NEGATIVE_INFINITY
  const anchored = Number.isFinite(dataMin) && dataMin > 0 ? dataMin * 0.1 : MIN_POSITIVE
  return Math.max(MIN_POSITIVE, anchored)
}

function normalizeLogWindow(
  scale: CsLabPlotAxisScale,
  min: number,
  max: number,
  dataMin: number,
): { min: number; max: number } {
  const floor = axisPositiveFloor(scale, dataMin)
  let nextMin = Math.max(min, floor)
  let nextMax = Math.max(max, nextMin * 1.0001)
  if (!(nextMax > nextMin)) {
    nextMin = floor
    nextMax = floor * 1.0001
  }
  return { min: nextMin, max: nextMax }
}

export interface AxisWindowInput {
  scale: CsLabPlotAxisScale
  min: number
  max: number
  dataMin: number
  dataMax: number
}

/** 拖拽平移：对数轴在对数域平移相同比例。 */
export function panAxisWindow(
  input: AxisWindowInput & { deltaRatio: number },
): { min: number; max: number } {
  if (!Number.isFinite(input.min) || !Number.isFinite(input.max) || !(input.max > input.min)) {
    return { min: input.min, max: input.max }
  }
  if (!isLogAxis(input.scale)) {
    const span = input.max - input.min
    return {
      min: input.min - input.deltaRatio * span,
      max: input.max - input.deltaRatio * span,
    }
  }
  const min = Math.max(input.min, axisPositiveFloor(input.scale, input.dataMin))
  const max = Math.max(input.max, min * 1.0001)
  const scaledMin = toScaled(min, input.scale)
  const scaledMax = toScaled(max, input.scale)
  const span = scaledMax - scaledMin
  const nextMin = fromScaled(scaledMin - input.deltaRatio * span, input.scale)
  const nextMax = fromScaled(scaledMax - input.deltaRatio * span, input.scale)
  return normalizeLogWindow(input.scale, nextMin, nextMax, input.dataMin)
}

/**
 * 滚轮缩放：像素锚点先映射到对数域比例，再重新分配 logSpan。
 * 这样鼠标下的数值在缩放过程中保持不动。
 */
export function zoomAxisWindow(
  input: AxisWindowInput & { anchorRatio: number; factor: number },
): { min: number; max: number } {
  if (!Number.isFinite(input.min) || !Number.isFinite(input.max) || !(input.max > input.min)) {
    return { min: input.min, max: input.max }
  }
  const ratio = Math.max(0, Math.min(1, input.anchorRatio))
  const factor = Number.isFinite(input.factor) && input.factor > 0 ? input.factor : 1

  if (!isLogAxis(input.scale)) {
    const anchor = input.min + ratio * (input.max - input.min)
    return {
      min: anchor - (anchor - input.min) * factor,
      max: anchor + (input.max - anchor) * factor,
    }
  }

  const min = Math.max(input.min, axisPositiveFloor(input.scale, input.dataMin))
  const max = Math.max(input.max, min * 1.0001)
  const scaledMin = toScaled(min, input.scale)
  const scaledMax = toScaled(max, input.scale)
  const anchor = scaledMin + ratio * (scaledMax - scaledMin)
  const nextMin = fromScaled(anchor - (anchor - scaledMin) * factor, input.scale)
  const nextMax = fromScaled(anchor + (scaledMax - anchor) * factor, input.scale)
  return normalizeLogWindow(input.scale, nextMin, nextMax, input.dataMin)
}
