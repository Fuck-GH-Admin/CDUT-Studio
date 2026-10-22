/**
 * 图表标定 / 磁性吸附 / 跨平台 venv 路径测试
 */

import { describe, expect, test } from 'bun:test'
import {
  fitAxisScale,
  mapPixelToValue,
  snapPointToPolyline,
} from '@profer/shared'
import { getVenvPythonPath } from './cslab-python-runtime'

describe('图表标定纯函数', () => {
  test('线性刻度拟合', () => {
    const fit = fitAxisScale(
      [
        { px: 0, py: 0, value: 0 },
        { px: 100, py: 0, value: 10 },
        { px: 200, py: 0, value: 20 },
      ],
      'auto',
    )
    expect(fit?.scale).toBe('linear')
    expect(fit?.r2).toBeCloseTo(1, 6)
    expect(mapPixelToValue(150, [
      { px: 0, py: 0, value: 0 },
      { px: 100, py: 0, value: 10 },
      { px: 200, py: 0, value: 20 },
    ])).toBeCloseTo(15, 6)
  })

  test('对数刻度自动优先', () => {
    const ticks = [
      { px: 0, py: 0, value: 1 },
      { px: 100, py: 0, value: 10 },
      { px: 200, py: 0, value: 100 },
    ]
    const fit = fitAxisScale(ticks, 'auto')
    expect(fit?.scale).toBe('log')
    expect(fit?.r2).toBeCloseTo(1, 6)
    expect(mapPixelToValue(150, ticks)).toBeCloseTo(31.6227766, 4)
  })

  test('对数刻度遇到非正数回退线性', () => {
    const ticks = [
      { px: 0, py: 0, value: 0 },
      { px: 100, py: 0, value: 10 },
    ]
    expect(fitAxisScale(ticks, 'log')?.scale).toBe('linear')
  })

  test('Y 轴刻度按 py 拟合（同一 px 垂直线不再失效）', () => {
    const ticks = [
      { px: 80.5, py: 419.5, value: 0 },
      { px: 80.5, py: 40.5, value: 100 },
    ]
    const fit = fitAxisScale(ticks, 'auto', 'py')
    expect(fit?.scale).toBe('linear')
    expect(fit?.r2).toBeCloseTo(1, 6)
    expect(mapPixelToValue(419.5, ticks, 'auto', 'py')).toBeCloseTo(0, 6)
    expect(mapPixelToValue(230, ticks, 'auto', 'py')).toBeCloseTo(50, 1)
    expect(mapPixelToValue(40.5, ticks, 'auto', 'py')).toBeCloseTo(100, 6)
  })
})

describe('磁性吸附', () => {
  const polyline: Array<[number, number]> = [
    [0, 0],
    [100, 0],
  ]

  test('阈值内投影到最近线段', () => {
    const result = snapPointToPolyline({ x: 50, y: 3 }, [polyline], 8)
    expect(result.point.x).toBeCloseTo(50, 6)
    expect(result.point.y).toBeCloseTo(0, 6)
    expect(result.distance).toBeCloseTo(3, 6)
  })

  test('阈值外保持原坐标', () => {
    const result = snapPointToPolyline({ x: 50, y: 30 }, [polyline], 8)
    expect(result.point).toEqual({ x: 50, y: 30 })
    expect(result.segmentIndex).toBe(-1)
  })

  test('多折线选择最近段', () => {
    const result = snapPointToPolyline(
      { x: 10, y: 45 },
      [
        polyline,
        [
          [0, 50],
          [100, 50],
        ],
      ],
      8,
    )
    expect(result.polylineIndex).toBe(1)
    expect(result.point.y).toBeCloseTo(50, 6)
  })
})

describe('跨平台 venv 路径', () => {
  test('Windows 使用 Scripts/python.exe', () => {
    const path = getVenvPythonPath('C:/lab/runtime/.venv', 'win32')
    expect(path).toContain('Scripts')
    expect(path.endsWith('python.exe')).toBe(true)
  })

  test('POSIX 使用 bin/python', () => {
    const path = getVenvPythonPath('/lab/runtime/.venv', 'linux')
    expect(path).toContain('bin')
    expect(path.endsWith('python')).toBe(true)
  })
})
