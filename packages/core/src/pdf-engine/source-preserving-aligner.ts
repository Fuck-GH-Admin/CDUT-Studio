/**
 * Category D: Source-Preserving Bipartite Alignment（源保持二部图对齐）
 *
 * 把「视觉几何候选框」与「PDF 原生字符流」建模为二分图匹配：
 * - 每个字符计算其落在候选框内的相交面积比 IoA = Area(g ∩ b) / Area(g)；
 * - IoA ≥ 0.5 或字符中心点落入候选框，即建立候选匹配边；
 * - 对基线漂移（Baseline Drift）的字符，用垂直容差 ε 做行吸附；
 * - 贪心区间划分：每个字符归属其 IoA 最大的候选框。
 *
 * 关键性质：框内字符序列严格按**原始字节流顺序**保留，因此输出文本与 PDF 内嵌
 * 文本完全一致，不会出现 OCR 式字符级拼写幻觉。
 */

import type { PointBBox } from '@profer/shared'
import type { PdfGlyphItem } from './types'

/** 候选边界框 */
export interface AlignerBox {
  id: string
  bbox: PointBBox
}

/** 单个候选框对齐后的字符集合 */
export interface AlignmentGroup {
  boxId: string
  /** 按原始字节流顺序排列的字符图元 */
  glyphs: PdfGlyphItem[]
  /** 由字符顺序拼接出的文本 */
  text: string
  /** 字符并集的外接矩形（无字符时为 null） */
  bbox: PointBBox | null
}

export interface AlignOptions {
  /** IoA 命中阈值，默认 0.5 */
  ioaThreshold?: number
  /** 基线漂移垂直吸附容差（Points），默认 2 */
  verticalTolerance?: number
}

interface BBoxLike {
  0: number
  1: number
  2: number
  3: number
}

/** 两框相交面积 */
function intersectionArea(a: BBoxLike, b: BBoxLike): number {
  const x0 = Math.max(a[0], b[0])
  const y0 = Math.max(a[1], b[1])
  const x1 = Math.min(a[2], b[2])
  const y1 = Math.min(a[3], b[3])
  if (x1 <= x0 || y1 <= y0) return 0
  return (x1 - x0) * (y1 - y0)
}

/** 字符落在候选框内的相交面积比 */
export function computeIoA(glyph: PdfGlyphItem, box: BBoxLike): number {
  const area = Math.max(glyph.width * glyph.height, 1e-6)
  return intersectionArea(glyph.bbox, box) / area
}

function centerInBox(glyph: PdfGlyphItem, box: BBoxLike): boolean {
  const cx = (glyph.bbox[0] + glyph.bbox[2]) / 2
  const cy = (glyph.bbox[1] + glyph.bbox[3]) / 2
  return cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3]
}

/** 基线漂移吸附：水平方向在框内，垂直方向仅小幅越界 */
function withinBaselineTolerance(glyph: PdfGlyphItem, box: BBoxLike, tolerance: number): boolean {
  const cx = (glyph.bbox[0] + glyph.bbox[2]) / 2
  const cy = (glyph.bbox[1] + glyph.bbox[3]) / 2
  if (cx < box[0] || cx > box[2]) return false
  return cy >= box[1] - tolerance && cy <= box[3] + tolerance
}

/**
 * 将字符流对齐到候选框集合。
 *
 * @param glyphs 已通过 TrapDoc 门禁的字符流（应保持原始顺序）
 * @param boxes 候选边界框集合
 * @returns 每个候选框的字符集合（顺序与 boxes 一致）
 */
export function alignGlyphsToBoxes(
  glyphs: readonly PdfGlyphItem[],
  boxes: readonly AlignerBox[],
  options: AlignOptions = {},
): AlignmentGroup[] {
  const ioaThreshold = options.ioaThreshold ?? 0.5
  const verticalTolerance = options.verticalTolerance ?? 2

  const buckets = new Map<string, PdfGlyphItem[]>()
  for (const box of boxes) buckets.set(box.id, [])

  for (const glyph of glyphs) {
    let bestId: string | null = null
    let bestScore = Number.NEGATIVE_INFINITY

    for (const box of boxes) {
      const ioa = computeIoA(glyph, box.bbox)
      const containsCenter = centerInBox(glyph, box.bbox)
      const tolerant = withinBaselineTolerance(glyph, box.bbox, verticalTolerance)

      let score = Number.NEGATIVE_INFINITY
      if (ioa >= ioaThreshold) {
        // 命中面积比优先，中心命中作为次级加权
        score = ioa + (containsCenter ? 0.5 : 0)
      } else if (containsCenter) {
        score = 0.9
      } else if (tolerant) {
        // 基线漂移吸附：给较低分，仅在没有更强候选时生效
        score = 0.3
      }

      if (score > bestScore) {
        bestScore = score
        bestId = box.id
      }
    }

    if (bestId !== null && bestScore > Number.NEGATIVE_INFINITY) {
      buckets.get(bestId)?.push(glyph)
    }
  }

  return boxes.map((box) => {
    const glyphsInBox = buckets.get(box.id) ?? []
    return {
      boxId: box.id,
      glyphs: glyphsInBox,
      text: glyphsInBox.map((glyph) => glyph.char).join(''),
      bbox: unionBBox(glyphsInBox),
    }
  })
}

/** 计算字符集合的外接矩形 */
export function unionBBox(glyphs: readonly PdfGlyphItem[]): PointBBox | null {
  if (glyphs.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const glyph of glyphs) {
    minX = Math.min(minX, glyph.bbox[0])
    minY = Math.min(minY, glyph.bbox[1])
    maxX = Math.max(maxX, glyph.bbox[2])
    maxY = Math.max(maxY, glyph.bbox[3])
  }
  return [minX, minY, maxX, maxY]
}
