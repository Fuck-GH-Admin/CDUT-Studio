import { describe, expect, test } from 'bun:test'
import { filterGhostGlyphs } from '../trapdoc-guard'
import type { PdfGlyphItem } from '../types'

function makeGlyph(overrides: Partial<PdfGlyphItem> = {}): PdfGlyphItem {
  return {
    char: 'A',
    fontName: 'Helvetica',
    fontSize: 12,
    originX: 100,
    originY: 200,
    width: 6,
    height: 12,
    bbox: [100, 188, 106, 200],
    renderingMode: 0,
    colorAlpha: 1,
    isOutOfCanvas: false,
    ...overrides,
  }
}

const page = { pageWidth: 612, pageHeight: 792 }

describe('TrapDocGuard 幽灵字符拦截', () => {
  test('5 类幽灵字符被 100% 滤除，正常字符 0 丢失', () => {
    const normal = [makeGlyph({ char: 'H' }), makeGlyph({ char: 'i', bbox: [106, 188, 112, 200] })]
    const ghosts = [
      makeGlyph({ char: 'X', renderingMode: 3 }),         // 不可见渲染模式
      makeGlyph({ char: 'Y', fontSize: 0 }),              // 零尺寸
      makeGlyph({ char: 'Z', width: 0 }),                 // 零宽
      makeGlyph({ char: 'Q', height: 0 }),                // 零高
      makeGlyph({ char: 'W', bbox: [-50, -50, -40, -30], isOutOfCanvas: true }), // 越界
      makeGlyph({ char: 'V', colorAlpha: 0 }),            // 全透明
      makeGlyph({ char: '\u200B' }),                      // 纯零宽字符
    ]

    const result = filterGhostGlyphs([...normal, ...ghosts], page)

    expect(result.glyphs.map((glyph) => glyph.char)).toEqual(['H', 'i'])
    expect(result.filteredCount).toBe(ghosts.length)
  })

  test('内嵌不可见字符被清理但字符本身保留', () => {
    const glyph = makeGlyph({ char: 'A\uFEFFB\u200B' })
    const result = filterGhostGlyphs([glyph], page)

    expect(result.glyphs).toHaveLength(1)
    expect(result.glyphs[0]?.char).toBe('AB')
    expect(result.filteredCount).toBe(0)
  })

  test('完全落在页面视口之外的幽灵文本整枚丢弃', () => {
    const glyph = makeGlyph({ bbox: [700, 10, 720, 20], isOutOfCanvas: false })
    const result = filterGhostGlyphs([glyph], page)

    expect(result.glyphs).toHaveLength(0)
    expect(result.filteredCount).toBe(1)
  })
})
