import { describe, expect, test } from 'bun:test'
import {
  clampOfficeScale,
  getRenderedPptxSlideCanvas,
  matchTextLayerGeometry,
  normalizeOfficeFormat,
  readXlsxGeometry,
} from './silurus-bridge'

describe('silurus bridge helpers', () => {
  test('routes supported Office extensions', () => {
    expect(normalizeOfficeFormat('报告.DOCX')).toBe('docx')
    expect(normalizeOfficeFormat('预算.xlsx')).toBe('xlsx')
    expect(normalizeOfficeFormat('/tmp/slides.PPTX')).toBe('pptx')
    expect(normalizeOfficeFormat('legacy.doc')).toBeNull()
  })

  test('clamps invalid and out-of-range scales', () => {
    expect(clampOfficeScale(Number.NaN)).toBe(1)
    expect(clampOfficeScale(0.1)).toBe(0.25)
    expect(clampOfficeScale(2.5)).toBe(2.5)
    expect(clampOfficeScale(9)).toBe(4)
  })

  test('returns a canvas only after the requested virtualized slide finished rendering', () => {
    const canvas = { isConnected: true } as HTMLCanvasElement
    const viewer = { _slots: new Map([[2, { canvas, renderedSlide: 2, renderedScale: 0.75 }]]) }
    expect(getRenderedPptxSlideCanvas(viewer as never, 2)).toBe(canvas)
    expect(getRenderedPptxSlideCanvas(viewer as never, 1)).toBeNull()
    expect(getRenderedPptxSlideCanvas({ _slots: new Map([[2, { canvas, renderedSlide: 1, renderedScale: 0.75 }]]) } as never, 2)).toBeNull()
    expect(getRenderedPptxSlideCanvas({ _slots: new Map([[2, { canvas, renderedSlide: 2, renderedScale: -1 }]]) } as never, 2)).toBeNull()
  })

  test('Given Silurus XlsxViewer getCellRect returns { x, y, w, h } When computing multi-cell row geometry Then returns finite bounding box without NaN', () => {
    const parent = {} as HTMLElement
    const internals = {
      canvasArea: parent,
      getCellRect: (row: number, col: number) => {
        if (row === 9 && col === 0) return { x: 42, y: 210, w: 110, h: 24 }
        if (row === 9 && col === 1) return { x: 152, y: 210, w: 95, h: 24 }
        return null
      },
    }
    const geom = readXlsxGeometry(internals, { row: 9, col: 0 }, { row: 9, col: 1 })
    expect(geom).not.toBeNull()
    expect(geom?.parent).toBe(parent)
    expect(geom?.left).toBe(42)
    expect(geom?.top).toBe(210)
    expect(geom?.width).toBe(205)
    expect(geom?.height).toBe(24)
  })

  test('Given Silurus DocxScrollViewer textLayer spans When matching citation label Then returns exact line bounding box', () => {
    const wrapper = { clientHeight: 1122, offsetHeight: 1122 } as HTMLElement
    const spans = [
      {
        textContent: 'B1-532  202519110212 周奕轩',
        style: { left: '90px', top: '180px', lineHeight: '20px' },
        offsetLeft: 90,
        offsetTop: 180,
        offsetWidth: 220,
        offsetHeight: 20,
      },
      {
        textContent: 'B1-533  202519110103 邓迪文',
        style: { left: '90px', top: '212px', lineHeight: '20px' },
        offsetLeft: 90,
        offsetTop: 212,
        offsetWidth: 220,
        offsetHeight: 20,
      },
    ]
    const textLayer = {
      isConnected: true,
      querySelectorAll: () => spans,
    } as unknown as HTMLElement

    const geom = matchTextLayerGeometry(wrapper, textLayer, '第1页·B1-533 邓迪文', [0.15, 0.18, 0.45, 0.21])
    expect(geom).not.toBeNull()
    expect(geom?.parent).toBe(wrapper)
    expect(geom?.left).toBe(84)
    expect(geom?.top).toBe(208)
    expect(geom?.width).toBe(232)
    expect(geom?.height).toBe(28)
  })
})

