import { describe, expect, test } from 'bun:test'
import { annotateInlineMath, enrichAcademicNodes, rateFormulaComplexity } from '../academic-enricher'
import { describeColumn } from '../document-serializer'
import type { LayoutNode, PdfGlyphItem, VectorLine } from '../types'
import type { NormalizedBBox, PointBBox } from '@profer/shared'

function glyph(
  char: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fontSize = 10,
  fontName = 'CMR10',
): PdfGlyphItem {
  return {
    char,
    fontName,
    fontSize,
    originX: x0,
    originY: y1,
    width: x1 - x0,
    height: y1 - y0,
    bbox: [x0, y0, x1, y1],
    renderingMode: 0,
    colorAlpha: 1,
    isOutOfCanvas: false,
  }
}

function run(
  text: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fontSize = 10,
  fontName = 'CMR10',
): PdfGlyphItem[] {
  const chars = Array.from(text)
  const width = (x1 - x0) / chars.length
  return chars.map((char, index) =>
    glyph(char, x0 + index * width, y0, x0 + (index + 1) * width, y1, fontSize, fontName),
  )
}

function hline(x0: number, y: number, x1: number): VectorLine {
  return { x0, y0: y, x1, y1: y, isHorizontal: true, thickness: 1 }
}

function makeNode(
  id: string,
  glyphs: PdfGlyphItem[],
  bbox: NormalizedBBox,
  pointBbox: PointBBox,
  kind: LayoutNode['kind'] = 'paragraph',
  fontSize = 10,
): LayoutNode {
  return {
    id,
    pageNumber: 1,
    kind,
    text: glyphs.map((glyph) => glyph.char).join('').replace(/\s+/g, ' ').trim(),
    bbox,
    pointBbox,
    confidence: 0.9,
    readingStreamId: 0,
    readingOrderIndex: 0,
    fontSize,
    glyphs,
  }
}

describe('行内公式探测与包裹', () => {
  const bodyOpts = { bodyFontSize: 10, pageWidth: 400, pageHeight: 400 }

  test('正文中的 p < 0.05 被正确加上 $...$', () => {
    const glyphs = run('p < 0.05', 40, 200, 120, 212)
    const node = makeNode('p1-b1', glyphs, [0.1, 0.5, 0.3, 0.53], [40, 200, 120, 212])

    annotateInlineMath(node, bodyOpts)

    expect(node.text).toContain('$p < 0.05$')
  })

  test('正文中的 α ∈ ℝ 被正确包裹并归一化为 LaTeX', () => {
    const glyphs = run('α ∈ ℝ', 40, 200, 120, 212)
    const node = makeNode('p1-b2', glyphs, [0.1, 0.5, 0.3, 0.53], [40, 200, 120, 212])

    annotateInlineMath(node, bodyOpts)

    expect(node.text).toContain('$\\alpha \\in \\mathbb{R}$')
  })

  test('纯自然语言段落不被误包公式', () => {
    const glyphs = run('The results are shown below for clarity.', 40, 200, 300, 212)
    const node = makeNode('p1-b3', glyphs, [0.1, 0.5, 0.75, 0.53], [40, 200, 300, 212])

    annotateInlineMath(node, bodyOpts)

    expect(node.text).toBe('The results are shown below for clarity.')
  })

  test('升降位上下标被识别为公式并还原为 LaTeX', () => {
    const glyphs = [
      glyph('x', 40, 90, 50, 100, 10),
      glyph('i', 51, 96, 56, 103, 7),
      glyph('2', 57, 90, 62, 97, 7),
    ]
    const node = makeNode('p1-b4', glyphs, [0.1, 0.5, 0.16, 0.53], [40, 90, 62, 100])

    annotateInlineMath(node, bodyOpts)

    expect(node.text).toContain('$x_{i}^{2}$')
  })
})

describe('行间公式 LaTeX 重构（不再是原文冒充）', () => {
  const region: PointBBox = [0, 0, 400, 400]

  test('分式横线 + 上下字形折叠为 \\frac{a+b}{c+d}', () => {
    const glyphs = [...run('a+b', 150, 150, 250, 170), ...run('c+d', 150, 190, 250, 210)]
    const node = makeNode('p1-eq1', glyphs, [0.35, 0.37, 0.65, 0.53], region, 'paragraph')
    const vectorLines = [hline(145, 180, 255)]

    enrichAcademicNodes([node], { pageNumber: 1, vectorLines, pageWidth: 400, pageHeight: 400 })

    expect(node.kind).toBe('equation')
    expect(node.equation?.latex).toBe('\\frac{a+b}{c+d}')
    expect(node.equation?.source).toBe('geometric')
    expect(node.equation?.mathAst).toBeDefined()
  })

  test('vectorLines 未透传时不硬造 \\frac（暗礁二回归）', () => {
    const glyphs = [...run('y=a+b', 150, 150, 250, 170), ...run('c+d', 150, 190, 250, 210)]
    const node = makeNode('p1-eq2', glyphs, [0.35, 0.37, 0.65, 0.53], region, 'paragraph')

    enrichAcademicNodes([node], { pageNumber: 1, pageWidth: 400, pageHeight: 400 })

    expect(node.kind).toBe('equation')
    expect(node.equation?.latex).not.toContain('\\frac')
    expect(node.equation?.latex).toContain('y=a+b')
  })
})

describe('页眉页脚与脚注分离', () => {
  test('页面极顶短文本被判为页眉并脱离主正文流', () => {
    const glyphs = run('Journal of Something', 40, 10, 300, 22)
    const node = makeNode('p1-h', glyphs, [0.1, 0.01, 0.75, 0.03], [40, 10, 300, 22])

    enrichAcademicNodes([node], { pageNumber: 1, pageWidth: 400, pageHeight: 400 })

    expect(node.kind).toBe('header')
    expect(node.readingStreamId).toBe(-1)
  })

  test('页面极顶的多行长段落绝不被判为页眉', () => {
    const glyphs = run('A very long abstract paragraph that must never be treated as a page header at all.', 40, 10, 380, 40)
    const node = makeNode('p1-body', glyphs, [0.1, 0.01, 0.95, 0.1], [40, 10, 380, 40])

    enrichAcademicNodes([node], { pageNumber: 1, pageWidth: 400, pageHeight: 400 })

    expect(node.kind).not.toBe('header')
    expect(node.readingStreamId).toBe(0)
  })
})

describe('公式复杂度评级', () => {
  test('高度超过阈值倍数即判 high', () => {
    expect(
      rateFormulaComplexity({ height: 0.1, lineHeight: 0.03, barCount: 0, hasGrid: false, threshold: 2.5 }),
    ).toBe('high')
  })

  test('多条分数线或二维网格判 high', () => {
    expect(
      rateFormulaComplexity({ height: 0.05, lineHeight: 0.03, barCount: 2, hasGrid: false, threshold: 2.5 }),
    ).toBe('high')
    expect(
      rateFormulaComplexity({ height: 0.05, lineHeight: 0.03, barCount: 0, hasGrid: true, threshold: 2.5 }),
    ).toBe('high')
  })

  test('单行公式判 simple', () => {
    expect(
      rateFormulaComplexity({ height: 0.05, lineHeight: 0.03, barCount: 0, hasGrid: false, threshold: 2.5 }),
    ).toBe('simple')
  })
})

describe('聚光灯锚点栏位描述（三栏必须区分中栏）', () => {
  test('三栏版面：左栏 / 中栏 / 右栏', () => {
    expect(describeColumn({ readingStreamId: 0, columnCount: 3 })).toBe('左栏')
    expect(describeColumn({ readingStreamId: 1, columnCount: 3 })).toBe('中栏')
    expect(describeColumn({ readingStreamId: 2, columnCount: 3 })).toBe('右栏')
  })

  test('双栏版面：左栏 / 右栏', () => {
    expect(describeColumn({ readingStreamId: 0, columnCount: 2 })).toBe('左栏')
    expect(describeColumn({ readingStreamId: 1, columnCount: 2 })).toBe('右栏')
  })

  test('单栏与跨栏通栏块：通栏', () => {
    expect(describeColumn({ readingStreamId: 0, columnCount: 1 })).toBe('通栏')
    expect(describeColumn({ readingStreamId: 0 })).toBe('通栏')
    expect(describeColumn({ readingStreamId: -1, columnCount: 2 })).toBe('通栏')
  })
})
