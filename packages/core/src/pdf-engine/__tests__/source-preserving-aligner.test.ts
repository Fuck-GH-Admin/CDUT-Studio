import { describe, expect, test } from 'bun:test'
import { alignGlyphsToBoxes } from '../source-preserving-aligner'
import type { PdfGlyphItem } from '../types'

function glyph(char: string, bbox: [number, number, number, number]): PdfGlyphItem {
  return {
    char,
    fontName: 'Helvetica',
    fontSize: 10,
    originX: bbox[0],
    originY: bbox[3],
    width: bbox[2] - bbox[0],
    height: bbox[3] - bbox[1],
    bbox,
    renderingMode: 0,
    colorAlpha: 1,
    isOutOfCanvas: false,
  }
}

describe('Source-Preserving Alignment 二部图对齐', () => {
  test('字符被归属到对应 BBox 且严格保持原始字节流顺序', () => {
    const boxes = [
      { id: 'a', bbox: [0, 0, 100, 20] as [number, number, number, number] },
      { id: 'b', bbox: [120, 0, 220, 20] as [number, number, number, number] },
    ]
    // 故意打乱输入顺序：验证「同一框内」按字节流顺序保留
    const stream = [
      glyph('B', [125, 5, 135, 15]),
      glyph('H', [5, 5, 15, 15]),
      glyph('y', [135, 5, 145, 15]),
      glyph('i', [15, 5, 25, 15]),
    ]

    const groups = alignGlyphsToBoxes(stream, boxes)

    expect(groups[0]?.text).toBe('Hi')
    expect(groups[1]?.text).toBe('By')
  })

  test('基线漂移字符在垂直容差内被行吸附', () => {
    const boxes = [{ id: 'a', bbox: [0, 0, 100, 20] as [number, number, number, number] }]
    // 字符略低于框底（中心 22，超出框底 20 仅 2pt），靠容差吸附
    const drifting = glyph('x', [5, 18, 15, 26])

    const groups = alignGlyphsToBoxes([drifting], boxes, { verticalTolerance: 2 })

    expect(groups[0]?.text).toBe('x')
  })

  test('完全在框外的字符不被错误归属', () => {
    const boxes = [{ id: 'a', bbox: [0, 0, 100, 20] as [number, number, number, number] }]
    const outside = glyph('x', [300, 300, 310, 310])

    const groups = alignGlyphsToBoxes([outside], boxes)

    expect(groups[0]?.text).toBe('')
  })
})
