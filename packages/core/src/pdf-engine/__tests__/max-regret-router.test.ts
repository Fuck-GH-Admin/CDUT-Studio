import { describe, expect, test } from 'bun:test'
import {
  detectColumnLayout,
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
