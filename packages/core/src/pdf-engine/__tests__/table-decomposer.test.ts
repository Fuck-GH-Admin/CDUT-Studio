import { describe, expect, test } from 'bun:test'
import { decomposeTable } from '../table-decomposer'
import type { PdfGlyphItem, VectorLine } from '../types'

/** 在 (x, y) 处放置一段文本（每个字符等宽、彼此相邻，构成单一单元格片段） */
function placeText(text: string, x: number, y: number, fontSize = 10): PdfGlyphItem[] {
  const charWidth = fontSize * 0.5
  const glyphs: PdfGlyphItem[] = []
  let cursor = x
  for (const char of text) {
    glyphs.push({
      char,
      fontName: 'Helvetica',
      fontSize,
      originX: cursor,
      originY: y + fontSize,
      width: charWidth,
      height: fontSize,
      bbox: [cursor, y, cursor + charWidth, y + fontSize],
      renderingMode: 0,
      colorAlpha: 1,
      isOutOfCanvas: false,
    })
    cursor += charWidth
  }
  return glyphs
}

const pageWidth = 200
const pageHeight = 80

describe('TableDecomposer 空间网格重构', () => {
  test('三线表 + 跨列单元格：识别表头、colSpan 与 GFM Markdown', () => {
    const glyphs = [
      // 第 0 行（表头）：一个跨越两列的大标题
      ...placeText('SpanningHeader', 40, 5, 10),
      // 第 1 行：两个单元格
      ...placeText('Item', 5, 25, 10),
      ...placeText('Score', 120, 25, 10),
      // 第 2 行：两个单元格
      ...placeText('Alpha', 5, 45, 10),
      ...placeText('10', 120, 45, 10),
    ]

    const structure = decomposeTable({
      region: [0, 0, pageWidth, pageHeight],
      glyphs,
      vectorLines: [],
      pageWidth,
      pageHeight,
    })

    expect(structure.rowCount).toBe(3)
    expect(structure.columnCount).toBe(2)

    const headerCell = structure.cells.find((cell) => cell.text === 'SpanningHeader')
    expect(headerCell).toBeDefined()
    expect(headerCell?.colSpan).toBe(2)
    expect(headerCell?.isHeader).toBe(true)

    const scoreCell = structure.cells.find((cell) => cell.text === 'Score')
    expect(scoreCell?.colSpan).toBe(1)

    expect(structure.headers[0]).toBe('SpanningHeader')
    expect(structure.markdown).toContain('| --- | --- |')
    expect(structure.markdown).toContain('| SpanningHeader |  |')
    expect(structure.markdown).toContain('| Item | Score |')
    expect(structure.markdown).toContain('| Alpha | 10 |')
  })

  test('垂直边框线优先作为列分界', () => {
    const glyphs = [
      ...placeText('Item', 5, 5, 10),
      ...placeText('Score', 120, 5, 10),
      ...placeText('Alpha', 5, 25, 10),
      ...placeText('10', 120, 25, 10),
    ]
    const vectorLines: VectorLine[] = [
      { x0: 110, y0: 0, x1: 110, y1: 80, isHorizontal: false, thickness: 1 },
    ]

    const structure = decomposeTable({
      region: [0, 0, pageWidth, pageHeight],
      glyphs,
      vectorLines,
      pageWidth,
      pageHeight,
    })

    expect(structure.columnCount).toBe(2)
    expect(structure.cells.find((cell) => cell.text === 'Score')?.columnIndex).toBe(1)
  })
})
