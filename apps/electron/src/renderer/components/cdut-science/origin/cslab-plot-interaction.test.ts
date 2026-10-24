import { describe, expect, test } from 'bun:test'
import {
  axisPositiveFloor,
  isLogAxis,
  panAxisWindow,
  zoomAxisWindow,
} from './cslab-plot-interaction'

describe('Origin 轴交互数学保护', () => {
  test('对数轴识别', () => {
    expect(isLogAxis('log10')).toBe(true)
    expect(isLogAxis('log2')).toBe(true)
    expect(isLogAxis('linear')).toBe(false)
  })

  test('Given log10 轴平移 When 计算 Then min 保持正数', () => {
    const next = panAxisWindow({
      scale: 'log10',
      min: 1,
      max: 100,
      dataMin: 0.5,
      dataMax: 100,
      deltaRatio: 2,
    })
    expect(next.min).toBeGreaterThan(0)
    expect(next.max).toBeGreaterThan(next.min)
  })

  test('Given log10 轴极端放大 When 计算 Then min 不跌破硬下界', () => {
    const floor = axisPositiveFloor('log10', 0.001)
    expect(floor).toBe(1e-4)
    const next = zoomAxisWindow({
      scale: 'log10',
      min: 1e-3,
      max: 1,
      dataMin: 1e-3,
      dataMax: 1,
      anchorRatio: 0,
      factor: 1e-9,
    })
    expect(next.min).toBeGreaterThanOrEqual(floor)
    expect(next.max).toBeGreaterThan(next.min)
  })

  test('Given 线性轴 When 缩放 Then 与旧线性公式一致', () => {
    const next = zoomAxisWindow({
      scale: 'linear',
      min: 0,
      max: 10,
      dataMin: 0,
      dataMax: 10,
      anchorRatio: 0.5,
      factor: 2,
    })
    expect(next.min).toBeCloseTo(-5, 6)
    expect(next.max).toBeCloseTo(15, 6)
  })

  test('Given log2 轴 When 平移 Then 数值有限且为正', () => {
    const next = panAxisWindow({
      scale: 'log2',
      min: 1,
      max: 64,
      dataMin: 1,
      dataMax: 64,
      deltaRatio: -1.5,
    })
    expect(Number.isFinite(next.min)).toBe(true)
    expect(next.min).toBeGreaterThan(0)
    expect(next.max).toBeGreaterThan(next.min)
  })
})
