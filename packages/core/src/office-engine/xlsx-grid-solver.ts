/**
 * XLSX 离散网格分解与浮动锚点几何求解器 (Discrete Grid Decomposition & TwoCellAnchor Solver)
 *
 * 核心能力：
 * 1. 稀疏网格 DoK (Dictionary of Keys) 存储与连通区域分割（间隔 >= 2 空行/空列自动切分为独立数据表区块）；
 * 2. 合并单元格 (`<mergeCell ref="A1:C3"/>`) 语义传播与长表分块（每块默认 <= 40 行并自动克隆表头上下文）；
 * 3. `xl/sharedStrings.xml` (SST)、`xl/styles.xml` 日期/数值格式化、`xl/calcChain.xml` 与 `<f>` 公式依赖 DAG 提取；
 * 4. 动态列宽字符像素换算：
 *    $\text{Width}_{\text{px}}(c) = \text{trunc}\left(\frac{256 \times w_c + \text{trunc}(128 / \text{MDW})}{256} \times \text{MDW}\right)$
 *    结合 `1 Pixel = 9,525 EMUs (96 DPI)` 解析 `xdr:twoCellAnchor` / `xdr:oneCellAnchor` 浮动图表坐标。
 */

import type {
  OfficeDocumentLayoutAST,
  OfficeLayoutBlock,
  OfficePageLayout,
  OfficeParseOptions,
} from './types.ts'
import {
  type OoxmlZipReader,
  type XmlElement,
  findElements,
  findFirstElement,
  getAttr,
  getDirectChildren,
  getFirstDirectChild,
  getTextContent,
  parseCoreMetadata,
  parseOoxmlRelationships,
} from './ooxml-zip-reader.ts'

// ─── 常量与单元格坐标转换工具 ───

const DEFAULT_MDW_PX = 7           // 11pt Calibri 在 96 DPI 下的最大数字宽度 (Max Digit Width)
const DEFAULT_COL_CHAR_WIDTH = 8.43
const DEFAULT_ROW_HEIGHT_PT = 15   // 20 px @ 96 DPI
const EMU_PER_PIXEL_96DPI = 9525
const DEFAULT_MAX_ROWS_PER_BLOCK = 40

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0
  return Math.max(0, Math.min(1, Number(val.toFixed(4))))
}

/** 将列字母（如 `"A"`, `"Z"`, `"AA"`）转换为 0-based 列索引 */
export function colLettersToIndex(letters: string): number {
  const clean = letters.trim().toUpperCase()
  let idx = 0
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i)
    if (code >= 65 && code <= 90) {
      idx = idx * 26 + (code - 64)
    }
  }
  return Math.max(0, idx - 1)
}

/** 将 0-based 列索引转换为列字母（如 `0 -> "A"`, `26 -> "AA"`） */
export function indexToColLetters(colIndex: number): string {
  let n = colIndex + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out || 'A'
}

/** 解析单元格引用（如 `"B14"` 或 `"$C$5"`）为 0-based `{ row, col }` */
export function parseCellAddress(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim())
  if (!m) return null
  const col = colLettersToIndex(m[1]!)
  const row = Math.max(0, parseInt(m[2]!, 10) - 1)
  return { row, col }
}

/** 格式化 0-based 区域为标准 A1 引用（如 `"A1:F20"`） */
export function formatRangeAddress(minRow: number, minCol: number, maxRow: number, maxCol: number): string {
  const start = `${indexToColLetters(minCol)}${minRow + 1}`
  const end = `${indexToColLetters(maxCol)}${maxRow + 1}`
  return start === end ? start : `${start}:${end}`
}

/**
 * ECMA-376 标准列宽字符数转 96 DPI 屏幕像素宽度：
 * $\text{Width}_{\text{px}}(c) = \text{trunc}\left(\frac{256 \times w_c + \text{trunc}(128 / \text{MDW})}{256} \times \text{MDW}\right)$
 */
export function columnCharWidthToPx(charWidth: number, mdw = DEFAULT_MDW_PX): number {
  const w = Number.isFinite(charWidth) && charWidth > 0 ? charWidth : DEFAULT_COL_CHAR_WIDTH
  return Math.trunc(((256 * w + Math.trunc(128 / mdw)) / 256) * mdw)
}

// ─── SST 与 Styles (日期/数字格式) 解析 ───

function parseSharedStrings(zip: OoxmlZipReader): string[] {
  const sstRoot = zip.readXml('xl/sharedStrings.xml')
  if (!sstRoot) return []
  return getDirectChildren(sstRoot, 'si').map((si) =>
    findElements(si, 't')
      .map((t) => getTextContent(t))
      .join(''),
  )
}

function isBuiltInDateNumFmt(id: number): boolean {
  return (
    (id >= 14 && id <= 22) ||
    (id >= 27 && id <= 36) ||
    (id >= 45 && id <= 47) ||
    (id >= 50 && id <= 58)
  )
}

function isCustomDateFormatCode(code: string): boolean {
  const cleaned = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase()
  return /[ymdh]/.test(cleaned) && !/^[#0.,%]+$/.test(cleaned)
}

function parseDateStyleSet(zip: OoxmlZipReader): Set<number> {
  const stylesRoot = zip.readXml('xl/styles.xml')
  const dateStyleIndices = new Set<number>()
  if (!stylesRoot) return dateStyleIndices

  const customFormats = new Map<number, string>()
  const numFmtsNode = getFirstDirectChild(stylesRoot, 'numFmts')
  if (numFmtsNode) {
    for (const nf of getDirectChildren(numFmtsNode, 'numFmt')) {
      const id = Number(getAttr(nf, 'numFmtId'))
      const code = getAttr(nf, 'formatCode') ?? ''
      if (Number.isFinite(id) && code) customFormats.set(id, code)
    }
  }

  const cellXfsNode = getFirstDirectChild(stylesRoot, 'cellXfs')
  if (cellXfsNode) {
    getDirectChildren(cellXfsNode, 'xf').forEach((xf, idx) => {
      const numFmtId = Number(getAttr(xf, 'numFmtId'))
      if (!Number.isFinite(numFmtId)) return
      const customCode = customFormats.get(numFmtId)
      if (isBuiltInDateNumFmt(numFmtId) || (customCode && isCustomDateFormatCode(customCode))) {
        dateStyleIndices.add(idx)
      }
    })
  }

  return dateStyleIndices
}

function formatExcelSerialDate(rawValue: string): string {
  const serial = Number(rawValue)
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return rawValue

  // Excel 1900 闰年偏差修正 (25569 = 1970-01-01)
  const utcDays = serial - 25569
  const millis = Math.round(utcDays * 86400 * 1000)
  const dt = new Date(millis)
  if (Number.isNaN(dt.getTime())) return rawValue

  const pad = (n: number) => String(n).padStart(2, '0')
  const datePart = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
  const frac = Math.abs(serial - Math.floor(serial))
  if (frac < 1e-6) return datePart
  return `${datePart} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`
}

// ─── `xl/calcChain.xml` 公式计算链解析 ───

function parseCalcChain(zip: OoxmlZipReader): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const root = zip.readXml('xl/calcChain.xml')
  if (!root) return map

  for (const c of getDirectChildren(root, 'c')) {
    const r = getAttr(c, 'r')
    const i = getAttr(c, 'i') ?? '1'
    if (!r) continue
    const list = map.get(i) ?? []
    list.push(r)
    map.set(i, list)
  }
  return map
}

// ─── 工作表单元格与合并区域数据结构 ───

interface SparseCell {
  row: number
  col: number
  ref: string
  value: string
  formula?: string
}

interface MergeRange {
  minRow: number
  minCol: number
  maxRow: number
  maxCol: number
  ref: string
}

interface SheetGridModel {
  cells: Map<string, SparseCell>
  merges: MergeRange[]
  colWidthsPx: Map<number, number>
  rowHeightsPx: Map<number, number>
  minRow: number
  maxRow: number
  minCol: number
  maxCol: number
}

function cellKey(row: number, col: number): string {
  return `${row}:${col}`
}

function parseWorksheetGrid(
  sheetRoot: XmlElement,
  sharedStrings: string[],
  dateStyleIndices: Set<number>,
): SheetGridModel {
  const cells = new Map<string, SparseCell>()
  const merges: MergeRange[] = []
  const colWidthsPx = new Map<number, number>()
  const rowHeightsPx = new Map<number, number>()

  let minRow = Infinity
  let maxRow = -1
  let minCol = Infinity
  let maxCol = -1

  // 1. 解析列宽定义 `<cols><col min="1" max="3" width="14.5"/></cols>`
  const colsNode = getFirstDirectChild(sheetRoot, 'cols')
  if (colsNode) {
    for (const colNode of getDirectChildren(colsNode, 'col')) {
      const cMin = Math.max(1, Number(getAttr(colNode, 'min') ?? 1)) - 1
      const cMax = Math.min(1024, Number(getAttr(colNode, 'max') ?? cMin + 1)) - 1
      const width = Number(getAttr(colNode, 'width') ?? DEFAULT_COL_CHAR_WIDTH)
      const px = columnCharWidthToPx(width)
      for (let c = cMin; c <= cMax; c++) {
        colWidthsPx.set(c, px)
      }
    }
  }

  // 2. 解析稀疏单元格 `<sheetData><row><c>`
  const sheetData = getFirstDirectChild(sheetRoot, 'sheetData')
  if (sheetData) {
    for (const rowNode of getDirectChildren(sheetData, 'row')) {
      const rAttr = Number(getAttr(rowNode, 'r'))
      const rowIndex = Number.isFinite(rAttr) && rAttr >= 1 ? rAttr - 1 : Math.max(0, maxRow + 1)
      const htPt = Number(getAttr(rowNode, 'ht'))
      if (Number.isFinite(htPt) && htPt > 0) {
        rowHeightsPx.set(rowIndex, Math.round((htPt * 96) / 72))
      }

      const cNodes = getDirectChildren(rowNode, 'c')
      for (let cPos = 0; cPos < cNodes.length; cPos++) {
        const cNode = cNodes[cPos]!
        const refAttr = getAttr(cNode, 'r')
        const addr = refAttr ? parseCellAddress(refAttr) : null
        const row = addr ? addr.row : rowIndex
        const col = addr ? addr.col : cPos
        const ref = refAttr || `${indexToColLetters(col)}${row + 1}`

        const tAttr = getAttr(cNode, 't')
        const sAttr = Number(getAttr(cNode, 's'))
        const fNode = getFirstDirectChild(cNode, 'f')
        const vNode = getFirstDirectChild(cNode, 'v')
        const isNode = getFirstDirectChild(cNode, 'is')

        const formula = fNode ? getTextContent(fNode).trim() : undefined
        let displayValue = ''

        if (tAttr === 'inlineStr' && isNode) {
          displayValue = findElements(isNode, 't')
            .map((t) => getTextContent(t))
            .join('')
        } else if (vNode) {
          const rawVal = getTextContent(vNode).trim()
          if (tAttr === 's') {
            const sstIdx = parseInt(rawVal, 10)
            displayValue = Number.isFinite(sstIdx) ? (sharedStrings[sstIdx] ?? '') : rawVal
          } else if (tAttr === 'b') {
            displayValue = rawVal === '1' ? 'TRUE' : 'FALSE'
          } else if (!tAttr && Number.isFinite(sAttr) && dateStyleIndices.has(sAttr)) {
            displayValue = formatExcelSerialDate(rawVal)
          } else {
            displayValue = rawVal
          }
        }

        if (displayValue.trim().length === 0 && !formula) continue

        cells.set(cellKey(row, col), {
          row,
          col,
          ref,
          value: displayValue.trim(),
          ...(formula ? { formula } : {}),
        })

        if (row < minRow) minRow = row
        if (row > maxRow) maxRow = row
        if (col < minCol) minCol = col
        if (col > maxCol) maxCol = col
      }
    }
  }

  // 3. 解析合并单元格 `<mergeCells><mergeCell ref="A1:C2"/></mergeCells>`
  const mergeCellsNode = getFirstDirectChild(sheetRoot, 'mergeCells')
  if (mergeCellsNode) {
    for (const mc of getDirectChildren(mergeCellsNode, 'mergeCell')) {
      const ref = getAttr(mc, 'ref')
      if (!ref || !ref.includes(':')) continue
      const [startStr, endStr] = ref.split(':')
      const start = startStr ? parseCellAddress(startStr) : null
      const end = endStr ? parseCellAddress(endStr) : null
      if (!start || !end) continue

      const r0 = Math.min(start.row, end.row)
      const r1 = Math.max(start.row, end.row)
      const c0 = Math.min(start.col, end.col)
      const c1 = Math.max(start.col, end.col)
      merges.push({ minRow: r0, minCol: c0, maxRow: r1, maxCol: c1, ref })

      // 若左上角锚点单元格有值，确保合并区域纳入有效边界
      const topLeft = cells.get(cellKey(r0, c0))
      if (topLeft) {
        if (r0 < minRow) minRow = r0
        if (r1 > maxRow) maxRow = r1
        if (c0 < minCol) minCol = c0
        if (c1 > maxCol) maxCol = c1
      }
    }
  }

  if (maxRow < 0 || maxCol < 0) {
    minRow = 0
    maxRow = 0
    minCol = 0
    maxCol = 0
  }

  return {
    cells,
    merges,
    colWidthsPx,
    rowHeightsPx,
    minRow,
    maxRow,
    minCol,
    maxCol,
  }
}

// ─── 累积列宽与行高像素坐标计算 ───

function buildAxisOffsetsPx(
  maxIndex: number,
  customMap: Map<number, number>,
  defaultSizePx: number,
): number[] {
  const offsets = new Array<number>(maxIndex + 2)
  offsets[0] = 0
  for (let i = 0; i <= maxIndex; i++) {
    const size = customMap.get(i) ?? defaultSizePx
    offsets[i + 1] = offsets[i]! + size
  }
  return offsets
}

// ─── 稀疏区域分割（间隔 >= 2 空行或空列切分为独立表区块） ───

interface GridRegion {
  minRow: number
  maxRow: number
  minCol: number
  maxCol: number
}

function partitionGridIntoRegions(grid: SheetGridModel): GridRegion[] {
  if (grid.cells.size === 0) return []

  const occupiedRows = new Set<number>()
  for (const cell of grid.cells.values()) {
    occupiedRows.add(cell.row)
  }
  for (const m of grid.merges) {
    if (grid.cells.has(cellKey(m.minRow, m.minCol))) {
      for (let r = m.minRow; r <= m.maxRow; r++) occupiedRows.add(r)
    }
  }

  const sortedRows = Array.from(occupiedRows).sort((a, b) => a - b)
  if (sortedRows.length === 0) return []

  // 按 >= 2 个连续空行切分纵向带（Row Bands）
  const rowBands: Array<[number, number]> = []
  let bandStart = sortedRows[0]!
  let prevRow = sortedRows[0]!

  for (let i = 1; i < sortedRows.length; i++) {
    const r = sortedRows[i]!
    if (r - prevRow > 2) {
      rowBands.push([bandStart, prevRow])
      bandStart = r
    }
    prevRow = r
  }
  rowBands.push([bandStart, prevRow])

  // 在每个纵向带内，按 >= 2 个连续空列切分横向表区块
  const regions: GridRegion[] = []

  for (const [r0, r1] of rowBands) {
    const occupiedCols = new Set<number>()
    for (const cell of grid.cells.values()) {
      if (cell.row >= r0 && cell.row <= r1) {
        occupiedCols.add(cell.col)
      }
    }
    for (const m of grid.merges) {
      if (m.minRow >= r0 && m.maxRow <= r1 && grid.cells.has(cellKey(m.minRow, m.minCol))) {
        for (let c = m.minCol; c <= m.maxCol; c++) occupiedCols.add(c)
      }
    }

    const sortedCols = Array.from(occupiedCols).sort((a, b) => a - b)
    if (sortedCols.length === 0) continue

    let cStart = sortedCols[0]!
    let prevCol = sortedCols[0]!
    for (let i = 1; i < sortedCols.length; i++) {
      const c = sortedCols[i]!
      if (c - prevCol > 2) {
        regions.push({ minRow: r0, maxRow: r1, minCol: cStart, maxCol: prevCol })
        cStart = c
      }
      prevCol = c
    }
    regions.push({ minRow: r0, maxRow: r1, minCol: cStart, maxCol: prevCol })
  }

  return regions
}

// ─── `xdr:twoCellAnchor` / `xdr:oneCellAnchor` 浮动绘图解析 ───

interface FloatingDrawingBlock {
  name: string
  cellRef: string
  bbox: [number, number, number, number]
}

function parseSheetDrawings(
  zip: OoxmlZipReader,
  sheetPath: string,
  colOffsetsPx: number[],
  rowOffsetsPx: number[],
  totalWidthPx: number,
  totalHeightPx: number,
): FloatingDrawingBlock[] {
  const sheetFileName = sheetPath.split('/').pop() ?? ''
  const relsPath = `xl/worksheets/_rels/${sheetFileName}.rels`
  const rels = parseOoxmlRelationships(zip, relsPath, 'xl/worksheets')
  const results: FloatingDrawingBlock[] = []

  for (const rel of rels.values()) {
    if (!rel.type.includes('drawing') || !zip.has(rel.target)) continue
    const drawingRoot = zip.readXml(rel.target)
    if (!drawingRoot) continue

    const anchors = [
      ...getDirectChildren(drawingRoot, 'twoCellAnchor'),
      ...getDirectChildren(drawingRoot, 'oneCellAnchor'),
    ]

    for (const anchor of anchors) {
      const fromNode = getFirstDirectChild(anchor, 'from')
      const toNode = getFirstDirectChild(anchor, 'to')
      if (!fromNode) continue

      const fromCol = Math.max(0, Number(getTextContent(getFirstDirectChild(fromNode, 'col')) || 0))
      const fromColOffEmu = Number(getTextContent(getFirstDirectChild(fromNode, 'colOff')) || 0)
      const fromRow = Math.max(0, Number(getTextContent(getFirstDirectChild(fromNode, 'row')) || 0))
      const fromRowOffEmu = Number(getTextContent(getFirstDirectChild(fromNode, 'rowOff')) || 0)

      let toCol = fromCol + 4
      let toColOffEmu = 0
      let toRow = fromRow + 10
      let toRowOffEmu = 0

      if (toNode) {
        toCol = Math.max(fromCol, Number(getTextContent(getFirstDirectChild(toNode, 'col')) || fromCol + 1))
        toColOffEmu = Number(getTextContent(getFirstDirectChild(toNode, 'colOff')) || 0)
        toRow = Math.max(fromRow, Number(getTextContent(getFirstDirectChild(toNode, 'row')) || fromRow + 1))
        toRowOffEmu = Number(getTextContent(getFirstDirectChild(toNode, 'rowOff')) || 0)
      }

      const baseX0 = colOffsetsPx[Math.min(fromCol, colOffsetsPx.length - 1)] ?? 0
      const baseY0 = rowOffsetsPx[Math.min(fromRow, rowOffsetsPx.length - 1)] ?? 0
      const baseX1 = colOffsetsPx[Math.min(toCol + 1, colOffsetsPx.length - 1)] ?? baseX0 + 120
      const baseY1 = rowOffsetsPx[Math.min(toRow + 1, rowOffsetsPx.length - 1)] ?? baseY0 + 80

      const x0Px = baseX0 + fromColOffEmu / EMU_PER_PIXEL_96DPI
      const y0Px = baseY0 + fromRowOffEmu / EMU_PER_PIXEL_96DPI
      const x1Px = Math.max(x0Px + 24, baseX1 + toColOffEmu / EMU_PER_PIXEL_96DPI)
      const y1Px = Math.max(y0Px + 20, baseY1 + toRowOffEmu / EMU_PER_PIXEL_96DPI)

      const cNvPr = findFirstElement(anchor, 'cNvPr')
      const txBody = findFirstElement(anchor, 'txBody')
      const txText = txBody
        ? findElements(txBody, 't')
            .map((t) => getTextContent(t))
            .join(' ')
            .trim()
        : ''
      const baseName = getAttr(cNvPr, 'descr') || getAttr(cNvPr, 'name') || '工作表图表'
      const name = txText ? `${baseName}（${txText}）` : baseName
      const cellRef = formatRangeAddress(fromRow, fromCol, toRow, toCol)

      results.push({
        name,
        cellRef,
        bbox: [
          clamp01(x0Px / Math.max(1, totalWidthPx)),
          clamp01(y0Px / Math.max(1, totalHeightPx)),
          clamp01(x1Px / Math.max(1, totalWidthPx)),
          clamp01(y1Px / Math.max(1, totalHeightPx)),
        ],
      })
    }
  }

  return results
}

// ─── 主求解入口：`solveXlsxGrid` ───

export function solveXlsxGrid(
  zip: OoxmlZipReader,
  options: OfficeParseOptions = {},
): OfficeDocumentLayoutAST {
  const wbRoot = zip.readXml('xl/workbook.xml')
  if (!wbRoot) {
    throw new Error('无效的 XLSX 工作簿：缺少 xl/workbook.xml')
  }

  const coreMeta = parseCoreMetadata(zip)
  const sharedStrings = parseSharedStrings(zip)
  const dateStyleIndices = parseDateStyleSet(zip)
  const calcChainBySheet = parseCalcChain(zip)
  const wbRels = parseOoxmlRelationships(zip, 'xl/_rels/workbook.xml.rels', 'xl')

  const sheetsNode = findFirstElement(wbRoot, 'sheets')
  const sheetElements = sheetsNode ? getDirectChildren(sheetsNode, 'sheet') : findElements(wbRoot, 'sheet')

  const resolvedSheets: Array<{ name: string; sheetId: string; path: string }> = []
  sheetElements.forEach((sh, idx) => {
    const name = getAttr(sh, 'name') || `Sheet${idx + 1}`
    const sheetId = getAttr(sh, 'sheetId') || `${idx + 1}`
    const rId = getAttr(sh, 'r:id') ?? getAttr(sh, 'id')
    const rel = rId ? wbRels.get(rId) : undefined
    const targetPath = rel?.target ?? `xl/worksheets/sheet${idx + 1}.xml`
    if (zip.has(targetPath)) {
      resolvedSheets.push({ name, sheetId, path: targetPath })
    }
  })

  if (resolvedSheets.length === 0) {
    const fallbackEntries = zip
      .listEntries()
      .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e))
      .sort()
    fallbackEntries.forEach((path, idx) => {
      resolvedSheets.push({ name: `Sheet${idx + 1}`, sheetId: `${idx + 1}`, path })
    })
  }

  const maxRowsPerBlock = options.maxRowsPerBlock ?? DEFAULT_MAX_ROWS_PER_BLOCK
  const maxSheets = options.maxPages ?? resolvedSheets.length
  const pages: OfficePageLayout[] = []
  let globalReadingOrder = 0

  for (let sIdx = 0; sIdx < Math.min(resolvedSheets.length, maxSheets); sIdx++) {
    const sheetInfo = resolvedSheets[sIdx]!
    const pageNumber = sIdx + 1
    const sheetRoot = zip.readXml(sheetInfo.path)
    if (!sheetRoot) continue

    const grid = parseWorksheetGrid(sheetRoot, sharedStrings, dateStyleIndices)
    const defaultColPx = columnCharWidthToPx(DEFAULT_COL_CHAR_WIDTH)
    const defaultRowPx = Math.round((DEFAULT_ROW_HEIGHT_PT * 96) / 72)

    const colOffsetsPx = buildAxisOffsetsPx(Math.max(grid.maxCol + 6, 12), grid.colWidthsPx, defaultColPx)
    const rowOffsetsPx = buildAxisOffsetsPx(Math.max(grid.maxRow + 12, 24), grid.rowHeightsPx, defaultRowPx)
    const activeStartX = colOffsetsPx[grid.minCol] ?? 0
    const activeStartY = rowOffsetsPx[grid.minRow] ?? 0
    const activeEndX = Math.max(activeStartX + defaultColPx, colOffsetsPx[grid.maxCol + 1] ?? defaultColPx * 8)
    const activeEndY = Math.max(activeStartY + defaultRowPx, rowOffsetsPx[grid.maxRow + 1] ?? defaultRowPx * 15)
    const activeWidthPx = Math.max(1, activeEndX - activeStartX)
    const activeHeightPx = Math.max(1, activeEndY - activeStartY)

    // 合并单元格查找表：将子单元格映射至左上角主单元格
    const mergeLookup = new Map<string, SparseCell>()
    for (const m of grid.merges) {
      const master = grid.cells.get(cellKey(m.minRow, m.minCol))
      if (!master) continue
      for (let r = m.minRow; r <= m.maxRow; r++) {
        for (let c = m.minCol; c <= m.maxCol; c++) {
          if (r === m.minRow && c === m.minCol) continue
          mergeLookup.set(cellKey(r, c), master)
        }
      }
    }

    const regions = partitionGridIntoRegions(grid)
    const blocks: OfficeLayoutBlock[] = []

    for (const region of regions) {
      // 提取区域内所有非空行号
      const regionRows: number[] = []
      for (let r = region.minRow; r <= region.maxRow; r++) {
        let hasData = false
        for (let c = region.minCol; c <= region.maxCol; c++) {
          if (grid.cells.has(cellKey(r, c)) || mergeLookup.has(cellKey(r, c))) {
            hasData = true
            break
          }
        }
        if (hasData) regionRows.push(r)
      }
      if (regionRows.length === 0) continue

      const headerRowIdx = regionRows[0]!
      const dataRowIndices = regionRows.slice(1)
      const chunks: number[][] = []

      if (dataRowIndices.length <= maxRowsPerBlock - 1) {
        chunks.push(regionRows)
      } else {
        for (let i = 0; i < dataRowIndices.length; i += Math.max(1, maxRowsPerBlock - 1)) {
          chunks.push([headerRowIdx, ...dataRowIndices.slice(i, i + Math.max(1, maxRowsPerBlock - 1))])
        }
      }

      for (const chunkRows of chunks) {
        const chunkMinRow = chunkRows[0]!
        const chunkMaxRow = chunkRows[chunkRows.length - 1]!
        const cellRef = formatRangeAddress(chunkMinRow, region.minCol, chunkMaxRow, region.maxCol)

        const colHeaders: string[] = []
        for (let c = region.minCol; c <= region.maxCol; c++) {
          colHeaders.push(indexToColLetters(c))
        }

        const matrix: string[][] = []
        const formulasInChunk: string[] = []
        const formulaDepsSet = new Set<string>()

        for (const r of chunkRows) {
          const rowValues: string[] = []
          for (let c = region.minCol; c <= region.maxCol; c++) {
            const direct = grid.cells.get(cellKey(r, c))
            const mergedMaster = mergeLookup.get(cellKey(r, c))
            const cell = direct ?? mergedMaster
            const val = (cell?.value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
            rowValues.push(val)

            if (direct?.formula) {
              formulasInChunk.push(`${direct.ref}=${direct.formula}`)
              const refMatches = direct.formula.match(/[A-Za-z]+\d+(?::[A-Za-z]+\d+)?/g) ?? []
              for (const dep of refMatches) formulaDepsSet.add(dep.toUpperCase())
            }
          }
          matrix.push(rowValues)
        }

        const colCount = Math.max(1, region.maxCol - region.minCol + 1)
        const firstRow = matrix[0] ?? Array.from({ length: colCount }, () => '')
        const headerRowRef = formatRangeAddress(chunkMinRow, region.minCol, chunkMinRow, region.maxCol)
        const headerLine = `| 行坐标 (${headerRowRef}) | ${firstRow.map((v, i) => v || colHeaders[i] || `Col${i + 1}`).join(' | ')} |`
        const sepLine = `| --- | ${Array.from({ length: colCount }, () => '---').join(' | ')} |`
        const bodyLines = matrix.slice(1).map((row, idx) => {
          const r = chunkRows[idx + 1] ?? chunkMinRow + idx + 1
          const rowRef = formatRangeAddress(r, region.minCol, r, region.maxCol)
          return `| ${rowRef} | ${row.join(' | ')} |`
        })

        const mdParts = [
          `### ${sheetInfo.name} (${cellRef})`,
          headerLine,
          sepLine,
          ...bodyLines,
        ]
        if (formulasInChunk.length > 0) {
          mdParts.push(`\n> 公式依赖 (${cellRef}): \`${formulasInChunk.slice(0, 6).join('`, `')}\``)
        }

        const plainLines = matrix.map((row, idx) => {
          const r = chunkRows[idx] ?? chunkMinRow + idx
          const rowRef = formatRangeAddress(r, region.minCol, r, region.maxCol)
          return `[${rowRef}]\t${row.join('\t')}`
        })
        const x0Px = (colOffsetsPx[region.minCol] ?? activeStartX) - activeStartX
        const x1Px = (colOffsetsPx[region.maxCol + 1] ?? activeEndX) - activeStartX
        const y0Px = (rowOffsetsPx[chunkMinRow] ?? activeStartY) - activeStartY
        const y1Px = (rowOffsetsPx[chunkMaxRow + 1] ?? activeEndY) - activeStartY

        const blockIdx = blocks.length + 1
        blocks.push({
          id: `p${pageNumber}-b${blockIdx}`,
          pageNumber,
          type: 'table',
          text: plainLines.join('\n'),
          markdown: mdParts.join('\n'),
          bbox: [
            clamp01(x0Px / activeWidthPx),
            clamp01(y0Px / activeHeightPx),
            clamp01(x1Px / activeWidthPx),
            clamp01(y1Px / activeHeightPx),
          ],
          locLabel: `${sheetInfo.name}·${cellRef}`,
          readingOrder: globalReadingOrder++,
          sheetName: sheetInfo.name,
          cellRef,
          rowCount: matrix.length,
          columnCount: colCount,
          ...(formulaDepsSet.size > 0 ? { formulaDeps: Array.from(formulaDepsSet) } : {}),
        })
      }
    }

    // 解析 `xdr:twoCellAnchor` / `xdr:oneCellAnchor` 浮动图表
    const drawings = parseSheetDrawings(
      zip,
      sheetInfo.path,
      colOffsetsPx,
      rowOffsetsPx,
      activeEndX,
      activeEndY,
    )
    for (const drw of drawings) {
      const blockIdx = blocks.length + 1
      blocks.push({
        id: `p${pageNumber}-b${blockIdx}`,
        pageNumber,
        type: 'figure',
        text: `[图表: ${drw.name} @ ${drw.cellRef}]`,
        markdown: `> **[${sheetInfo.name}·${drw.cellRef}]** 图表：${drw.name}`,
        bbox: drw.bbox,
        locLabel: `${sheetInfo.name}·${drw.cellRef}`,
        readingOrder: globalReadingOrder++,
        sheetName: sheetInfo.name,
        cellRef: drw.cellRef,
      })
    }

    const totalWidthPt = Number(((activeEndX * 72) / 96).toFixed(2))
    const totalHeightPt = Number(((activeEndY * 72) / 96).toFixed(2))
    void calcChainBySheet

    pages.push({
      pageNumber,
      widthPt: Math.max(400, totalWidthPt),
      heightPt: Math.max(300, totalHeightPt),
      title: sheetInfo.name,
      sheetName: sheetInfo.name,
      blocks,
    })
  }

  return {
    format: 'xlsx',
    pageCount: pages.length,
    pages,
    metadata: {
      ...(coreMeta.title ? { title: coreMeta.title } : {}),
      ...(coreMeta.author ? { author: coreMeta.author } : {}),
      sheetNames: resolvedSheets.map((s) => s.name),
    },
  }
}
