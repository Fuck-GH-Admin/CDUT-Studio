import { describe, expect, test } from 'bun:test'
import {
  analyzePageTopology,
  clusterColumnBoundaries,
  columnIndexOf,
  computeXProjectionProfile,
  decomposeHorizontalBands,
  detectColumnLayout,
  findDeepValleys,
  solveMaxRegretReadingOrder,
} from '../max-regret-router'
import type { LayoutNode } from '../types'
import type { NormalizedBBox } from '@profer/shared'

function node(id: string, text: string, bbox: NormalizedBBox): LayoutNode {
  return {
    id,
    pageNumber: 1,
    kind: 'paragraph',
    text,
    bbox,
    pointBbox: [0, 0, 0, 0],
    confidence: 0.9,
    readingStreamId: 0,
    readingOrderIndex: 0,
  }
}

describe('Max-Regret 阅读顺序推理', () => {
  test('学术双栏：读完左栏再换到右栏，严禁左右交叉穿插', () => {
    const nodes = [
      node('L1', 'In this paper we propose a novel method,', [0.08, 0.20, 0.45, 0.26]),
      node('L2', 'which significantly improves accuracy.', [0.08, 0.28, 0.45, 0.34]),
      node('L3', 'The results are shown below.', [0.08, 0.36, 0.45, 0.42]),
      node('R1', '3. Methodology', [0.55, 0.20, 0.92, 0.25]),
      node('R2', 'We design a two-stage pipeline.', [0.55, 0.27, 0.92, 0.33]),
    ]

    const ordered = solveMaxRegretReadingOrder(nodes)

    expect(ordered.map((item) => item.id)).toEqual(['L1', 'L2', 'L3', 'R1', 'R2'])
    expect(ordered.map((item) => item.readingOrderIndex)).toEqual([0, 1, 2, 3, 4])
  })

  test('分栏探测识别出双栏结构', () => {
    const nodes = [
      node('L1', 'left', [0.08, 0.20, 0.45, 0.26]),
      node('L2', 'left', [0.08, 0.28, 0.45, 0.34]),
      node('R1', 'right', [0.55, 0.20, 0.92, 0.26]),
      node('R2', 'right', [0.55, 0.28, 0.92, 0.34]),
    ]

    const layout = detectColumnLayout(nodes)

    expect(layout.columnCount).toBe(2)
    expect(layout.boundaries).toEqual([0.5])
  })

  test('单栏文档按自上而下顺序阅读', () => {
    const nodes = [
      node('P3', 'third', [0.1, 0.5, 0.9, 0.56]),
      node('P1', 'first', [0.1, 0.2, 0.9, 0.26]),
      node('P2', 'second', [0.1, 0.35, 0.9, 0.41]),
    ]

    const ordered = solveMaxRegretReadingOrder(nodes)

    expect(ordered.map((item) => item.id)).toEqual(['P1', 'P2', 'P3'])
  })
})

describe('投影直方图深谷搜索', () => {
  test('双栏版面的栏隙被识别为深谷', () => {
    const nodes = [
      node('L1', 'left', [0.08, 0.20, 0.45, 0.26]),
      node('L2', 'left', [0.08, 0.28, 0.45, 0.34]),
      node('R1', 'right', [0.55, 0.20, 0.92, 0.26]),
      node('R2', 'right', [0.55, 0.28, 0.92, 0.34]),
    ]

    const valleys = findDeepValleys(computeXProjectionProfile(nodes))

    expect(valleys.length).toBeGreaterThanOrEqual(1)
    const gutter = valleys.find((valley) => valley.x0 < 0.5 && valley.x1 > 0.5)
    expect(gutter).toBeDefined()
    expect(gutter!.x1 - gutter!.x0).toBeGreaterThanOrEqual(0.015)
    expect(gutter!.depth).toBeGreaterThan(0.5)
  })

  test('无栏隙的单栏版面不硬造深谷', () => {
    const nodes = [
      node('P1', 'first', [0.10, 0.20, 0.90, 0.26]),
      node('P2', 'second', [0.10, 0.30, 0.90, 0.36]),
      node('P3', 'third', [0.10, 0.40, 0.90, 0.46]),
    ]

    const valleys = findDeepValleys(computeXProjectionProfile(nodes))

    expect(valleys.every((valley) => valley.x1 <= 0.10 || valley.x0 >= 0.90)).toBe(true)
  })
})

describe('非对称分栏', () => {
  test('左宽右窄（正文 + 边注）：栏宽独立表达，阅读流左栏到底再进边注', () => {
    const nodes = [
      node('L1', 'Body paragraph one.', [0.08, 0.20, 0.66, 0.26]),
      node('L2', 'Body paragraph two.', [0.08, 0.28, 0.66, 0.34]),
      node('L3', 'Body paragraph three.', [0.08, 0.36, 0.66, 0.42]),
      node('M1', 'margin note a', [0.72, 0.20, 0.94, 0.25]),
      node('M2', 'margin note b', [0.72, 0.28, 0.94, 0.33]),
    ]

    const layout = detectColumnLayout(nodes)

    expect(layout.columnCount).toBe(2)
    // 左栏宽约 0.58，右栏宽约 0.22 —— 绝不假设各栏等宽
    expect(layout.columns[0]!.x1 - layout.columns[0]!.x0).toBeGreaterThan(0.45)
    expect(layout.columns[1]!.x1 - layout.columns[1]!.x0).toBeLessThan(0.35)

    const ordered = solveMaxRegretReadingOrder(nodes)
    expect(ordered.map((item) => item.id)).toEqual(['L1', 'L2', 'L3', 'M1', 'M2'])
  })

  test('columnIndexOf 按水平中心落栏，支持非对称栏宽', () => {
    const layout = detectColumnLayout([
      node('L1', 'a', [0.08, 0.20, 0.66, 0.26]),
      node('L2', 'b', [0.08, 0.28, 0.66, 0.34]),
      node('M1', 'c', [0.72, 0.20, 0.94, 0.25]),
      node('M2', 'd', [0.72, 0.28, 0.94, 0.33]),
    ])

    expect(columnIndexOf(node('x', 'x', [0.10, 0.5, 0.60, 0.56]), layout)).toBe(0)
    expect(columnIndexOf(node('y', 'y', [0.74, 0.5, 0.92, 0.56]), layout)).toBe(1)
  })
})

describe('三栏版面', () => {
  test('识别出三栏且阅读流严格按栏序推进', () => {
    const nodes = [
      node('A1', 'a1', [0.06, 0.20, 0.28, 0.26]),
      node('A2', 'a2', [0.06, 0.30, 0.28, 0.36]),
      node('B1', 'b1', [0.38, 0.20, 0.60, 0.26]),
      node('B2', 'b2', [0.38, 0.30, 0.60, 0.36]),
      node('C1', 'c1', [0.70, 0.20, 0.93, 0.26]),
      node('C2', 'c2', [0.70, 0.30, 0.93, 0.36]),
    ]

    const layout = detectColumnLayout(nodes)
    expect(layout.columnCount).toBe(3)
    expect(layout.boundaries).toHaveLength(2)

    const ordered = solveMaxRegretReadingOrder(nodes)
    expect(ordered.map((item) => item.id)).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'])
    expect(ordered.map((item) => item.readingStreamId)).toEqual([0, 0, 1, 1, 2, 2])
    // 三栏下每块的 columnCount 记为所在带的栏数
    expect(ordered.map((item) => item.columnCount)).toEqual([3, 3, 3, 3, 3, 3])
  })
})

describe('水平分带拓扑', () => {
  test('上双栏 → 中通栏大图 → 下双栏：分 3 带隔离，绝不跳步', () => {
    const nodes = [
      node('T1', 'Top left body.', [0.08, 0.10, 0.45, 0.18]),
      node('T2', 'Top left body two.', [0.08, 0.20, 0.45, 0.28]),
      node('T3', 'Top right body.', [0.55, 0.10, 0.92, 0.18]),
      node('T4', 'Top right body two.', [0.55, 0.20, 0.92, 0.28]),
      // 跨栏浮动大图（占位块，文本极短）
      node('FIG', 'Figure 3', [0.08, 0.38, 0.92, 0.62]),
      node('B1', 'Bottom left body.', [0.08, 0.72, 0.45, 0.80]),
      node('B2', 'Bottom left body two.', [0.08, 0.82, 0.45, 0.90]),
      node('B3', 'Bottom right body.', [0.55, 0.72, 0.92, 0.80]),
      node('B4', 'Bottom right body two.', [0.55, 0.82, 0.92, 0.90]),
    ]

    const bands = decomposeHorizontalBands(nodes)

    expect(bands).toHaveLength(3)
    expect(bands[0]!.nodeIds).toEqual(['T1', 'T2', 'T3', 'T4'])
    expect(bands[1]!.nodeIds).toEqual(['FIG'])
    expect(bands[2]!.nodeIds).toEqual(['B1', 'B2', 'B3', 'B4'])
    // 带序严格自顶向下
    expect(bands.map((band) => band.y0)).toEqual([...bands.map((band) => band.y0)].sort((a, b) => a - b))
    // 上下带各自是双栏
    expect(bands[0]!.columnCount).toBe(2)
    expect(bands[2]!.columnCount).toBe(2)
    // 浮动图自成带
    expect(bands[1]!.columnCount).toBe(1)
  })

  test('跨栏大图下方正文绝不提前吸附到右栏顶部', () => {
    const nodes = [
      node('T1', 'Top left body.', [0.08, 0.10, 0.45, 0.18]),
      node('T2', 'Top right body.', [0.55, 0.10, 0.92, 0.18]),
      node('FIG', 'Figure 3', [0.08, 0.38, 0.92, 0.62]),
      node('B1', 'Bottom left body.', [0.08, 0.72, 0.45, 0.80]),
      node('B2', 'Bottom right body.', [0.55, 0.72, 0.92, 0.80]),
    ]

    const { ordered } = analyzePageTopology(nodes)

    expect(ordered.map((item) => item.id)).toEqual(['T1', 'T2', 'FIG', 'B1', 'B2'])
  })

  test('页眉页脚绝不进入分带与投影聚类', () => {
    const header: LayoutNode = {
      ...node('H', 'Journal of Something 2024', [0.08, 0.01, 0.92, 0.04]),
      kind: 'header',
      readingStreamId: -1,
    }
    const footer: LayoutNode = {
      ...node('F', '12', [0.08, 0.96, 0.92, 0.99]),
      kind: 'footer',
      readingStreamId: -1,
    }
    const nodes = [
      header,
      node('T1', 'Top left body.', [0.08, 0.10, 0.45, 0.18]),
      node('T2', 'Top right body.', [0.55, 0.10, 0.92, 0.18]),
      node('B1', 'Bottom left body.', [0.08, 0.72, 0.45, 0.80]),
      node('B2', 'Bottom right body.', [0.55, 0.72, 0.92, 0.80]),
      footer,
    ]

    const bands = decomposeHorizontalBands(nodes)

    // 页眉/页脚不产生碎片带，正文被识别为一个双栏带
    expect(bands).toHaveLength(1)
    expect(bands[0]!.columnCount).toBe(2)

    const { ordered } = analyzePageTopology(nodes)
    expect(ordered.map((item) => item.id)).toEqual(['T1', 'T2', 'B1', 'B2'])
    // 页眉/页脚不进入主阅读流
    expect(ordered.some((item) => item.id === 'H' || item.id === 'F')).toBe(false)
  })
})

describe('多峰 K-Means 自适应定栏数', () => {
  test('零散块不被误判为独立栏', () => {
    const nodes = [
      node('L1', 'left', [0.08, 0.20, 0.45, 0.26]),
      node('L2', 'left', [0.08, 0.30, 0.45, 0.36]),
      node('L3', 'left', [0.08, 0.40, 0.45, 0.46]),
      node('L4', 'left', [0.08, 0.50, 0.45, 0.56]),
      // 右侧孤块：不足以构成独立栏
      node('R1', 'note', [0.72, 0.20, 0.92, 0.24]),
    ]

    const layout = clusterColumnBoundaries(nodes, findDeepValleys(computeXProjectionProfile(nodes)))

    expect(layout.columnCount).toBe(1)
  })
})
