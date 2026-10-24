import { describe, expect, test } from 'bun:test'
import { computeCursorAnchoredScroll, normalizePdfBbox } from './cslab-pdf-geometry'

describe('PDF 几何', () => {
  test('Given 倒置 bbox When normalizePdfBbox Then 返回正宽高', () => {
    const box = normalizePdfBbox([0.6, 0.8, 0.2, 0.3])
    expect(box.x).toBeCloseTo(0.2, 6)
    expect(box.y).toBeCloseTo(0.3, 6)
    expect(box.width).toBeCloseTo(0.4, 6)
    expect(box.height).toBeCloseTo(0.5, 6)
  })

  test('Given 放大 When 光标锚定 Then 光标下的内容保持不动', () => {
    const oldScale = 1
    const newScale = 1.5
    const scrollLeft = 100
    const scrollTop = 50
    const cursorX = 300
    const cursorY = 200
    const next = computeCursorAnchoredScroll({
      oldScale,
      newScale,
      scrollLeft,
      scrollTop,
      cursorX,
      cursorY,
    })
    expect(next.scrollLeft).toBeCloseTo((scrollLeft + cursorX) * 1.5 - cursorX, 6)
    expect(next.scrollTop).toBeCloseTo((scrollTop + cursorY) * 1.5 - cursorY, 6)
  })

  test('Given 缩回原比例 When 计算 Then 滚动条回到原位置', () => {
    const enlarged = computeCursorAnchoredScroll({
      oldScale: 1,
      newScale: 2,
      scrollLeft: 40,
      scrollTop: 20,
      cursorX: 120,
      cursorY: 80,
    })
    const restored = computeCursorAnchoredScroll({
      oldScale: 2,
      newScale: 1,
      scrollLeft: enlarged.scrollLeft,
      scrollTop: enlarged.scrollTop,
      cursorX: 120,
      cursorY: 80,
    })
    expect(restored.scrollLeft).toBeCloseTo(40, 6)
    expect(restored.scrollTop).toBeCloseTo(20, 6)
  })
})
