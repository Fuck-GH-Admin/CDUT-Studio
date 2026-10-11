/**
 * Category C: TableDecomposer 空间网格重构
 *
 * 学术论文常见三线表（Booktabs：顶线、表头分隔线、底线）与跨列单元格。
 * 采用「投影剖分（Projection Profile Split）+ 跨度合并（Merge Spans）」：
 * 1. 行聚类：Y 向把字符聚成行；
 * 2. 列数推定：取「每行单元格数」的众数（跨越单元格不会掩盖真实列数）；
 * 3. 列分界：有垂直边框线则以其为准，否则对「单元格数 = 列数」的代表行做 X 轴空白投影；
 * 4. 跨度合并：行内单元格按其跨越的列区间计算 colSpan；
 * 5. 输出结构化矩阵与 GFM Markdown 表格。
 */

import type { LayoutTableCell, LayoutTableStructure, NormalizedBBox, PointBBox } from '@profer/shared'
import { normalizePointBBox } from '@profer/shared'
import type { PdfGlyphItem, VectorLine } from './types'

export interface TableDecomposeInput {
  /** 表格区域（点坐标，左上角原点） */
  region: PointBBox
  /** 区域内的字符图元 */
  glyphs: readonly PdfGlyphItem[]
  /** 区域内的矢量线段 */
  vectorLines: readonly VectorLine[]
  pageWidth: number
  pageHeight: number
  caption?: string
}

interface RowCluster {
  glyphs: PdfGlyphItem[]
  y0: number
  y1: number
}

/** 判断字符是否落在区域内（以中心点为准，留 1pt 容差） */
function glyphInRegion(glyph: PdfGlyphItem, region: PointBBox): boolean {
  const cx = (glyph.bbox[0] + glyph.bbox[2]) / 2
  const cy = (glyph.bbox[1] + glyph.bbox[3]) / 2
  return cx >= region[0] - 1 && cx <= region[2] + 1 && cy >= region[1] - 1 && cy <= region[3] + 1
}

function medianFontSize(glyphs: readonly PdfGlyphItem[]): number {
  const sizes = glyphs.map((glyph) => glyph.fontSize).filter((size) => size > 0).sort((a, b) => a - b)
  if (sizes.length === 0) return 10
  return sizes[Math.floor(sizes.length / 2)] ?? 10
}

/** Y 向聚类成行 */
function clusterRows(glyphs: readonly PdfGlyphItem[]): RowCluster[] {
  const tolerance = Math.max(medianFontSize(glyphs) * 0.6, 1)
  const sorted = [...glyphs].sort((a, b) => {
    const ay = (a.bbox[1] + a.bbox[3]) / 2
    const by = (b.bbox[1] + b.bbox[3]) / 2
    if (Math.abs(ay - by) > tolerance) return ay - by
    return a.bbox[0] - b.bbox[0]
  })

  const rows: RowCluster[] = []
  for (const glyph of sorted) {
    const cy = (glyph.bbox[1] + glyph.bbox[3]) / 2
    const current = rows[rows.length - 1]
    if (current && Math.abs(cy - (current.y0 + current.y1) / 2) <= tolerance) {
      current.glyphs.push(glyph)
      current.y0 = Math.min(current.y0, glyph.bbox[1])
      current.y1 = Math.max(current.y1, glyph.bbox[3])
    } else {
      rows.push({ glyphs: [glyph], y0: glyph.bbox[1], y1: glyph.bbox[3] })
    }
  }
  rows.sort((a, b) => a.y0 - b.y0)
  return rows
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

/** 行内按 X 向空白聚类出单元格分组 */
function splitRowIntoGroups(row: RowCluster, gapThreshold: number): PdfGlyphItem[][] {
  const sorted = [...row.glyphs].sort((a, b) => a.bbox[0] - b.bbox[0])
  const groups: PdfGlyphItem[][] = []
  let current: PdfGlyphItem[] = []
  let currentRight = Number.NEGATIVE_INFINITY
  for (const glyph of sorted) {
    if (current.length > 0 && glyph.bbox[0] - currentRight > gapThreshold) {
      groups.push(current)
      current = []
    }
    current.push(glyph)
    currentRight = Math.max(currentRight, glyph.bbox[2])
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** 取众数（并列时取较大值） */
function modeMax(values: number[]): number {
  const histogram = new Map<number, number>()
  for (const value of values) histogram.set(value, (histogram.get(value) ?? 0) + 1)
  let best = values[0] ?? 1
  let bestCount = -1
  for (const [value, count] of histogram) {
    if (count > bestCount || (count === bestCount && value > best)) {
      bestCount = count
      best = value
    }
  }
  return best
}

/** 用垂直边框线确定列区间；无则返回 null */
function columnBandsFromLines(
  region: PointBBox,
  vectorLines: readonly VectorLine[],
): Array<[number, number]> | null {
  const regionHeight = region[3] - region[1]
  const xs = vectorLines
    .filter((line) => !line.isHorizontal)
    .filter((line) => line.x0 >= region[0] - 2 && line.x0 <= region[2] + 2 && Math.abs(line.y1 - line.y0) >= regionHeight * 0.5)
    .map((line) => line.x0)
    .sort((a, b) => a - b)

  if (xs.length === 0) return null

  const unique: number[] = []
  for (const x of xs) {
    if (unique.length === 0 || Math.abs(x - (unique[unique.length - 1] ?? x)) > 3) unique.push(x)
  }

  const edges = [region[0], ...unique, region[2]]
  const bands: Array<[number, number]> = []
  for (let i = 0; i < edges.length - 1; i += 1) {
    const left = edges[i]!
    const right = edges[i + 1]!
    if (right - left > 2) bands.push([left, right])
  }
  return bands.length >= 2 ? bands : null
}

/** 对一组框做 X 轴空白投影，切分出列区间 */
function columnBandsFromBoxes(
  region: PointBBox,
  boxes: readonly PointBBox[],
): Array<[number, number]> {
  if (boxes.length === 0) return [[region[0], region[2]]]
  const regionWidth = Math.max(region[2] - region[0], 1)
  const bins = 256
  const covered = new Array<boolean>(bins).fill(false)
  for (const box of boxes) {
    const start = Math.floor(((box[0] - region[0]) / regionWidth) * (bins - 1))
    const end = Math.ceil(((box[2] - region[0]) / regionWidth) * (bins - 1))
    for (let bin = Math.max(0, start); bin <= Math.min(bins - 1, end); bin += 1) covered[bin] = true
  }

  const binWidth = regionWidth / bins
  const minGap = Math.max(3, regionWidth * 0.02)
  const bands: Array<[number, number]> = []
  let runStart = -1
  for (let bin = 0; bin <= bins; bin += 1) {
    const isCovered = bin < bins && covered[bin] === true
    if (isCovered && runStart < 0) {
      runStart = bin
    } else if (!isCovered && runStart >= 0) {
      bands.push([region[0] + runStart * binWidth, region[0] + bin * binWidth])
      runStart = -1
    }
  }

  // 合并间距过窄的相邻块（视为同一列）
  const merged: Array<[number, number]> = []
  for (const band of bands) {
    const last = merged[merged.length - 1]
    if (last && band[0] - last[1] < minGap) last[1] = band[1]
    else merged.push(band)
  }
  if (merged.length === 0) return [[region[0], region[2]]]

  // 用空白中点作为列分界，补全首尾到区域边界
  const boundaries: number[] = []
  for (let i = 0; i < merged.length - 1; i += 1) {
    boundaries.push((merged[i]![1] + merged[i + 1]![0]) / 2)
  }
  const edges = [region[0], ...boundaries, region[2]]
  const bandsOut: Array<[number, number]> = []
  for (let i = 0; i < edges.length - 1; i += 1) bandsOut.push([edges[i]!, edges[i + 1]!])
  return bandsOut
}

/** GFM Markdown 表格渲染 */
function renderMarkdown(matrix: string[][], columnCount: number): string {
  const rowText = (cells: string[]): string =>
    `| ${Array.from({ length: columnCount }, (_, col) => cells[col] ?? '').join(' | ')} |`
  const header = matrix[0] ?? new Array<string>(columnCount).fill('')
  const separator = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`
  const body = matrix.slice(1).map(rowText)
  return [rowText(header), separator, ...body].join('\n')
}

/**
 * 表格区域空间网格重构。
 */
export function decomposeTable(input: TableDecomposeInput): LayoutTableStructure {
  const glyphs = input.glyphs.filter((glyph) => glyphInRegion(glyph, input.region))
  const rows = clusterRows(glyphs)
  const fontSize = medianFontSize(glyphs)
  const gapThreshold = Math.max(fontSize * 0.9, 3)

  const rowGroups = rows.map((row) => splitRowIntoGroups(row, gapThreshold))

  // 列数 = 每行单元格数的众数（跨越单元格不掩盖真实列数）
  const columnCount = Math.max(1, modeMax(rowGroups.map((groups) => groups.length)))

  // 列分界：优先垂直边框线，其次对「单元格数 = 列数」的代表行做投影
  const representativeBoxes: PointBBox[] = []
  for (const groups of rowGroups) {
    if (groups.length === columnCount) {
      for (const group of groups) representativeBoxes.push(bboxOf(group))
    }
  }
  const bands = columnBandsFromLines(input.region, input.vectorLines)
    ?? columnBandsFromBoxes(input.region, representativeBoxes)
  const bandCount = Math.max(1, bands.length)

  const matrix: string[][] = []
  const cells: LayoutTableCell[] = []

  rows.forEach((row, rowIndex) => {
    const rowMatrix = new Array<string>(bandCount).fill('')
    const groups = rowGroups[rowIndex] ?? []
    for (const group of groups) {
      const box = bboxOf(group)
      const overlapping = bands
        .map((band, index) => ({ index, overlap: Math.min(box[2], band[1]) - Math.max(box[0], band[0]) }))
        .filter((entry) => entry.overlap > 0)
      const columnIndex = overlapping.length > 0 ? overlapping[0]!.index : 0
      const colSpan = Math.max(1, overlapping.length)

      const text = group.map((glyph) => glyph.char).join('').trim()
      const cellBBox: NormalizedBBox = normalizePointBBox([box[0], box[1], box[2], box[3]], input.pageWidth, input.pageHeight)
      cells.push({
        rowIndex,
        columnIndex,
        rowSpan: 1,
        colSpan,
        isHeader: rowIndex === 0,
        text,
        bbox: cellBBox,
      })
      if (rowMatrix[columnIndex] !== undefined) rowMatrix[columnIndex] = text
    }
    matrix.push(rowMatrix)
  })

  const headerRow = matrix[0] ?? new Array<string>(bandCount).fill('')
  const headers = Array.from({ length: bandCount }, (_, col) => headerRow[col] ?? '')

  const structure: LayoutTableStructure = {
    rowCount: rows.length,
    columnCount: bandCount,
    headers,
    cells,
    markdown: renderMarkdown(matrix, bandCount),
  }
  if (input.caption !== undefined) structure.caption = input.caption
  return structure
}
