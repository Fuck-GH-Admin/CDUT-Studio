/**
 * Native 空间几何分段器（纯 TS 确定性引擎）
 *
 * 在没有 ONNX 版面模型时，作为「版面特征初判」的保底实现：
 * 字符图元 → 文本行 → 行内片段 → 段落块，并对多列/三线表做保守探测。
 *
 * 只产出「候选几何框 + 类别初判」，最终文本一律由 Category D 对齐器从原始字符流
 * 反查得到，保证源保持（source-preserving）。
 */

import type { LayoutRegionKind, PointBBox } from '@profer/shared'
import type { PdfGlyphItem, LayoutCandidateBox, VectorLine } from './types'
import { looksLikeSectionHeading } from './max-regret-router'

export interface SegmentPageInput {
  glyphs: readonly PdfGlyphItem[]
  vectorLines: readonly VectorLine[]
  pageWidth: number
  pageHeight: number
  pageNumber: number
}

/** 行内片段 */
interface Fragment {
  glyphs: PdfGlyphItem[]
  bbox: PointBBox
  lineIndex: number
}

/** 文本行 */
interface TextLine {
  fragments: Fragment[]
  centerY: number
  y0: number
  y1: number
}

/** 页面正文字号（众数） */
export function inferBodyFontSize(glyphs: readonly PdfGlyphItem[]): number {
  const histogram = new Map<number, number>()
  for (const glyph of glyphs) {
    if (glyph.fontSize <= 0) continue
    const key = Math.round(glyph.fontSize)
    histogram.set(key, (histogram.get(key) ?? 0) + 1)
  }
  let best = 10
  let bestCount = -1
  for (const [size, count] of histogram) {
    if (count > bestCount) {
      bestCount = count
      best = size
    }
  }
  return best
}

function bboxOf(glyphs: readonly PdfGlyphItem[]): PointBBox {
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

/** 字符图元 → 文本行 + 行内片段 */
function buildLines(glyphs: readonly PdfGlyphItem[], bodyFontSize: number): TextLine[] {
  const tolerance = Math.max(bodyFontSize * 0.5, 1)
  const fragmentGap = Math.max(bodyFontSize * 1.6, 3)

  const sorted = [...glyphs].sort((a, b) => {
    const ay = (a.bbox[1] + a.bbox[3]) / 2
    const by = (b.bbox[1] + b.bbox[3]) / 2
    if (Math.abs(ay - by) > tolerance) return ay - by
    return a.bbox[0] - b.bbox[0]
  })

  interface RawLine { glyphs: PdfGlyphItem[]; centerY: number; y0: number; y1: number }
  const rawLines: RawLine[] = []
  for (const glyph of sorted) {
    const cy = (glyph.bbox[1] + glyph.bbox[3]) / 2
    const last = rawLines[rawLines.length - 1]
    if (last && Math.abs(cy - last.centerY) <= tolerance) {
      last.glyphs.push(glyph)
      last.centerY = (last.centerY * (last.glyphs.length - 1) + cy) / last.glyphs.length
      last.y0 = Math.min(last.y0, glyph.bbox[1])
      last.y1 = Math.max(last.y1, glyph.bbox[3])
    } else {
      rawLines.push({ glyphs: [glyph], centerY: cy, y0: glyph.bbox[1], y1: glyph.bbox[3] })
    }
  }

  return rawLines.map((raw, lineIndex) => {
    const ordered = [...raw.glyphs].sort((a, b) => a.bbox[0] - b.bbox[0])
    const fragments: Fragment[] = []
    let current: PdfGlyphItem[] = []
    let currentRight = Number.NEGATIVE_INFINITY
    for (const glyph of ordered) {
      if (current.length > 0 && glyph.bbox[0] - currentRight > fragmentGap) {
        fragments.push({ glyphs: current, bbox: bboxOf(current), lineIndex })
        current = []
      }
      current.push(glyph)
      currentRight = Math.max(currentRight, glyph.bbox[2])
    }
    if (current.length > 0) fragments.push({ glyphs: current, bbox: bboxOf(current), lineIndex })
    return { fragments, centerY: raw.centerY, y0: raw.y0, y1: raw.y1 }
  })
}

/** X 方向重叠比例（相对较窄者） */
function xOverlapRatio(a: PointBBox, b: PointBBox): number {
  const overlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
  if (overlap <= 0) return 0
  const width = Math.min(a[2] - a[0], b[2] - b[0])
  return width > 0 ? overlap / width : 0
}

/**
 * 保守探测表格区域：以矢量横线为主锚（三线表），
 * 无矢量信息时回落到「连续多列对齐行」启发式（需每行 ≥3 个片段，避免误判双栏正文）。
 */
function detectTableRegions(
  lines: readonly TextLine[],
  fragmentGap: number,
): Array<{ bbox: PointBBox; glyphs: PdfGlyphItem[] }> {
  const regions: Array<{ bbox: PointBBox; glyphs: PdfGlyphItem[] }> = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line || line.fragments.length < 3) {
      index += 1
      continue
    }

    const group: TextLine[] = [line]
    let lastY1 = line.y1
    let next = index + 1
    while (next < lines.length) {
      const candidate = lines[next]
      if (!candidate || candidate.fragments.length < 3) break
      if (candidate.y0 - lastY1 > fragmentGap * 1.5) break
      group.push(candidate)
      lastY1 = candidate.y1
      next += 1
    }

    if (group.length >= 2) {
      const glyphs = group.flatMap((row) => row.fragments.flatMap((fragment) => fragment.glyphs))
      regions.push({ bbox: bboxOf(glyphs), glyphs })
      index = next
    } else {
      index += 1
    }
  }
  return regions
}

/** 文本块（由若干片段纵向合并而成） */
interface BlockDraft {
  glyphs: PdfGlyphItem[]
  bbox: PointBBox
}

/** 单块最大字符数安全阀：绝不允许把整栏正文融成一个巨型块 */
const MAX_BLOCK_CHARS = 1000
/** 首行缩进判定阈值（Points）：下一行明显右缩进即视为新段落起笔 */
const PARAGRAPH_INDENT_PT = 8
/** 句末标点（中英文），用于段落完结探测 */
const SENTENCE_END_PATTERN = /[.。！？!?；;：:]$/
/** 短行判定（片段字符数）：句末完结且本行偏短时不再向后强制融合 */
const SHORT_LINE_CHARS = 24

/** 拼接片段文本（仅用于段落边界判据，最终文本仍由对齐器源保持反查） */
function fragmentText(glyphs: readonly PdfGlyphItem[]): string {
  return glyphs.map((glyph) => glyph.char).join('')
}

/**
 * 判断当前片段是否应当开启新段落（拒绝并入目标块）：
 * 1. 行间距阻断：verticalGap > lineHeight * 0.8，视为新段落起笔；
 * 2. 首行缩进探测：下一行明显右缩进（Δx ≥ 8pt），视为新段落起笔；
 * 3. 句末标点阻断：上一行以句末标点收尾且本行字数偏短，不得与后续强制融合；
 * 4. 单块最大字数安全阀：目标块已达 1000 字符上限，强制切分。
 */
function startsNewParagraph(block: BlockDraft, fragment: Fragment, lineHeight: number): boolean {
  const verticalGap = fragment.bbox[1] - block.bbox[3]
  // 1. 行间距阻断
  if (verticalGap > lineHeight * 0.8) return true
  // 2. 首行缩进探测（仅对下一行生效）
  if (fragment.bbox[1] > block.bbox[1] && fragment.bbox[0] - block.bbox[0] >= PARAGRAPH_INDENT_PT) {
    return true
  }
  // 4. 单块最大字数安全阀
  if (block.glyphs.length >= MAX_BLOCK_CHARS) return true
  // 3. 句末标点阻断
  const prevEnd = fragmentText(block.glyphs).trimEnd()
  if (SENTENCE_END_PATTERN.test(prevEnd) && fragment.glyphs.length <= SHORT_LINE_CHARS) return true
  return false
}

/** 片段 → 段落块（纵向邻接 + X 重叠 + 段落边界阻断） */
function groupFragmentsIntoBlocks(fragments: readonly Fragment[], lineHeight: number): BlockDraft[] {
  const sorted = [...fragments].sort((a, b) => {
    if (a.bbox[1] !== b.bbox[1]) return a.bbox[1] - b.bbox[1]
    return a.bbox[0] - b.bbox[0]
  })

  const blocks: BlockDraft[] = []
  for (const fragment of sorted) {
    let target: BlockDraft | null = null
    for (const block of blocks) {
      const verticalGap = fragment.bbox[1] - block.bbox[3]
      if (verticalGap > lineHeight * 1.5) continue
      if (verticalGap < -lineHeight) continue
      if (xOverlapRatio(block.bbox, fragment.bbox) < 0.5) continue
      // 段落边界阻断：命中任一判据即另起新块，绝不与目标块强制融合
      if (startsNewParagraph(block, fragment, lineHeight)) continue
      target = block
      break
    }
    if (target) {
      target.glyphs.push(...fragment.glyphs)
      target.bbox = [
        Math.min(target.bbox[0], fragment.bbox[0]),
        Math.min(target.bbox[1], fragment.bbox[1]),
        Math.max(target.bbox[2], fragment.bbox[2]),
        Math.max(target.bbox[3], fragment.bbox[3]),
      ]
    } else {
      blocks.push({ glyphs: [...fragment.glyphs], bbox: [...fragment.bbox] as PointBBox })
    }
  }
  return blocks
}

/** 依据字号、文案样式给出区域类别初判 */
function classifyBlock(
  text: string,
  bbox: PointBBox,
  fontSize: number,
  bodyFontSize: number,
  pageNumber: number,
  pageWidth: number,
): LayoutRegionKind {
  const trimmed = text.trim()
  const isLargeFont = fontSize >= bodyFontSize * 1.25
  const width = bbox[2] - bbox[0]
  const centerX = (bbox[0] + bbox[2]) / 2
  const centered = pageWidth > 0 && Math.abs(centerX - pageWidth / 2) <= pageWidth * 0.06

  if (isLargeFont && pageNumber === 1 && centered && width > pageWidth * 0.3) {
    return 'title'
  }
  if (isLargeFont || looksLikeSectionHeading(trimmed)) {
    return 'section-heading'
  }
  if (/^(?:[•·▪◦\-*]|\d+[.)])\s+/.test(trimmed)) {
    return 'list-item'
  }
  return 'paragraph'
}

/**
 * 把一个页面的字符图元切分为候选版面框。
 */
export function segmentPageIntoBoxes(input: SegmentPageInput): LayoutCandidateBox[] {
  const { glyphs, pageNumber } = input
  if (glyphs.length === 0) return []

  const bodyFontSize = inferBodyFontSize(glyphs)
  const lines = buildLines(glyphs, bodyFontSize)
  const lineHeight = Math.max(bodyFontSize * 1.4, 2)

  // 1. 先剔除表格区域（其字符不再参与段落合并）
  const tableRegions = detectTableRegions(lines, lineHeight)
  const tableGlyphSet = new Set<PdfGlyphItem>()
  for (const region of tableRegions) {
    for (const glyph of region.glyphs) tableGlyphSet.add(glyph)
  }

  const boxes: LayoutCandidateBox[] = []
  let counter = 0

  for (const region of tableRegions) {
    boxes.push({
      id: `p${pageNumber}-tbl${counter}`,
      bbox: region.bbox,
      kindHint: 'table',
      fontSize: bodyFontSize,
    })
    counter += 1
  }

  // 2. 其余片段按纵向邻接合并为段落块
  const remainingFragments = lines.flatMap((line) => line.fragments).filter((fragment) =>
    fragment.glyphs.every((glyph) => !tableGlyphSet.has(glyph)),
  )
  const blocks = groupFragmentsIntoBlocks(remainingFragments, lineHeight)

  for (const block of blocks) {
    const ordered = [...block.glyphs].sort((a, b) => {
      if (a.bbox[1] !== b.bbox[1]) return a.bbox[1] - b.bbox[1]
      return a.bbox[0] - b.bbox[0]
    })
    const text = ordered.map((glyph) => glyph.char).join('')
    const fontSize = ordered.reduce((max, glyph) => Math.max(max, glyph.fontSize), 0) || bodyFontSize
    boxes.push({
      id: `p${pageNumber}-b${counter}`,
      bbox: block.bbox,
      kindHint: classifyBlock(text, block.bbox, fontSize, bodyFontSize, pageNumber, input.pageWidth),
      fontSize,
    })
    counter += 1
  }

  return boxes
}
