/**
 * PDF 视窗几何纯函数
 *
 * bbox 归一化必须兼容 PDF 原生左下角坐标系（y0 > y1）与页面旋转后的符号差异。
 */

export interface PdfBboxRect {
  x: number
  y: number
  width: number
  height: number
}

export function normalizePdfBbox(bbox: readonly [number, number, number, number]): PdfBboxRect {
  const [x0, y0, x1, y1] = bbox
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  }
}

export interface CursorAnchoredScrollInput {
  oldScale: number
  newScale: number
  scrollLeft: number
  scrollTop: number
  cursorX: number
  cursorY: number
}

export function computeCursorAnchoredScroll(
  input: CursorAnchoredScrollInput,
): { scrollLeft: number; scrollTop: number } {
  const ratio = input.newScale / Math.max(1e-6, input.oldScale)
  return {
    scrollLeft: (input.scrollLeft + input.cursorX) * ratio - input.cursorX,
    scrollTop: (input.scrollTop + input.cursorY) * ratio - input.cursorY,
  }
}
