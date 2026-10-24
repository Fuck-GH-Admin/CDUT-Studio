/**
 * cslab-edge-router 动态锚点路由测试
 *
 * 覆盖：向量法线外推（垂直连接无水平歪斜）、显式 fromSide/toSide 协议保真、
 * 左右/上下/交叉相对位置的最优锚点选择。
 */

import { describe, expect, test } from 'bun:test'
import type { CsLabCanvasNode } from '@profer/shared'
import { edgePath } from './cslab-edge-router'

function node(
  id: string,
  x: number,
  y: number,
  width = 260,
  height = 150,
): CsLabCanvasNode {
  return { id, type: 'text', x, y, width, height }
}

interface PathSegment {
  start: { x: number; y: number }
  c1: { x: number; y: number }
  c2: { x: number; y: number }
  end: { x: number; y: number }
}

function parsePath(d: string): PathSegment {
  const match =
    /^M (-?[\d.]+) (-?[\d.]+) C (-?[\d.]+) (-?[\d.]+), (-?[\d.]+) (-?[\d.]+), (-?[\d.]+) (-?[\d.]+)$/.exec(
      d,
    )
  if (!match) throw new Error(`无法解析路径: ${d}`)
  const n = (index: number): number => Number(match[index])
  return {
    start: { x: n(1), y: n(2) },
    c1: { x: n(3), y: n(4) },
    c2: { x: n(5), y: n(6) },
    end: { x: n(7), y: n(8) },
  }
}

describe('显式 fromSide/toSide 协议保真（Obsidian 手工连线）', () => {
  test('fromSide: bottom → toSide: top 严格从 bottom 锚点连至 top 锚点', () => {
    const from = node('a', 0, 0)
    const to = node('b', 0, 400)
    const d = edgePath(from, to, { fromSide: 'bottom', toSide: 'top' })
    const path = parsePath(d)
    // bottom 锚点 = (from.x + w/2, from.y + h)
    expect(path.start).toEqual({ x: 130, y: 150 })
    // top 锚点 = (to.x + w/2, to.y)
    expect(path.end).toEqual({ x: 130, y: 400 })
  })

  test('fromSide: right → toSide: left 从右缘出、入左缘', () => {
    const from = node('a', 0, 0)
    const to = node('b', 600, 0)
    const path = parsePath(edgePath(from, to, { fromSide: 'right', toSide: 'left' }))
    expect(path.start).toEqual({ x: 260, y: 75 })
    expect(path.end).toEqual({ x: 600, y: 75 })
  })

  test('仅指定 fromSide 时另一端按几何评分兜底', () => {
    const from = node('a', 0, 0)
    const to = node('b', 600, 0)
    const path = parsePath(edgePath(from, to, { fromSide: 'right' }))
    expect(path.start).toEqual({ x: 260, y: 75 })
    // 目标在正右方，最优入边为 left。
    expect(path.end).toEqual({ x: 600, y: 75 })
  })
})

describe('向量法线外推', () => {
  test('上下垂直连接：控制点 x 分量 == 锚点 x（沿 Y 轴外推，无水平 dx 歪斜）', () => {
    const from = node('a', 0, 0)
    const to = node('b', 0, 500)
    const path = parsePath(edgePath(from, to))
    // 最优组合应从 bottom (0+130, 150) 连至 top (0+130, 500)
    expect(path.start).toEqual({ x: 130, y: 150 })
    expect(path.end).toEqual({ x: 130, y: 500 })
    // 法线 (0,1) 与 (0,-1)：控制点只在 Y 方向偏移，x 分量不变。
    expect(path.c1.x).toBe(path.start.x)
    expect(path.c2.x).toBe(path.end.x)
    expect(path.c1.y).toBeGreaterThan(path.start.y)
    expect(path.c2.y).toBeLessThan(path.end.y)
  })

  test('左右水平连接：控制点 y 分量 == 锚点 y（沿 X 轴外推）', () => {
    const from = node('a', 0, 0)
    const to = node('b', 600, 0)
    const path = parsePath(edgePath(from, to))
    expect(path.start).toEqual({ x: 260, y: 75 })
    expect(path.end).toEqual({ x: 600, y: 75 })
    expect(path.c1.y).toBe(path.start.y)
    expect(path.c2.y).toBe(path.end.y)
    expect(path.c1.x).toBeGreaterThan(path.start.x)
    expect(path.c2.x).toBeLessThan(path.end.x)
  })
})

describe('几何评分兜底（未显式指定端点）', () => {
  test('目标在源左侧：从左缘出、入右缘，无同侧穿透', () => {
    const from = node('a', 600, 0)
    const to = node('b', 0, 0)
    const path = parsePath(edgePath(from, to))
    expect(path.start).toEqual({ x: 600, y: 75 })
    expect(path.end).toEqual({ x: 260, y: 75 })
    expect(path.c1.x).toBeLessThan(path.start.x)
    expect(path.c2.x).toBeGreaterThan(path.end.x)
  })

  test('目标在源正上方：从 top 出、入 bottom', () => {
    const from = node('a', 0, 500)
    const to = node('b', 0, 0)
    const path = parsePath(edgePath(from, to))
    expect(path.start).toEqual({ x: 130, y: 500 })
    expect(path.end).toEqual({ x: 130, y: 150 })
  })

  test('交叉位置（右下 → 左上）：距离 + 方向惩罚选最优组合', () => {
    const from = node('a', 500, 0)
    const to = node('b', 0, 500)
    const path = parsePath(edgePath(from, to))
    // 源右下、目标左上：从 left 或 bottom 出，入 right 或 top。
    const validStart =
      (path.start.x === 500 && path.start.y === 75) || // left
      (path.start.x === 630 && path.start.y === 150) // bottom
    const validEnd =
      (path.end.x === 260 && path.end.y === 575) || // right
      (path.end.x === 130 && path.end.y === 500) // top
    expect(validStart).toBe(true)
    expect(validEnd).toBe(true)
  })
})
