/**
 * DOCX 确定性流式排版重排求解器 (Flow-to-Layout Reflow Solver)
 *
 * 核心能力：
 * 1. 样式继承链求解 (`word/styles.xml` 的 `w:basedOn` 递归合并：字号、行距、段前段后、缩进、大纲级别)；
 * 2. Windows GDI 整数字距仿真 + CJK 全角字符网格测量，计算段落精确折行行数与高度：
 *    `h_line = s * 1.298 * (w:line / 240)`；
 * 3. 跨页浮动表格分裂手术 (`w:tbl` / `w:tr` / `w:cantSplit` / `w:tblHeader` 虚拟表头克隆)；
 * 4. OMML 数学公式 (`m:oMath` / `m:oMathPara`) 递归转译为标准 LaTeX (`$...$` / `$$...$$`)；
 * 5. 页内脚注 (`w:footnoteReference`) 空间预留与显式分页符 (`w:br[@w:type="page"]` / `w:lastRenderedPageBreak`) 感知；
 * 6. 产出归一化物理边界框 `bbox: [x0/W, y0/H, x1/W, y1/H]` 与 `p{page}-b{idx}` 拓扑锚点。
 */

import type {
  OfficeBlockType,
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
} from './ooxml-zip-reader.ts'

// ─── 常量与单位换算 (1 pt = 20 twips) ───

const DEFAULT_PAGE_WIDTH_TWIPS = 11906  // A4 宽度 = 595.3 pt
const DEFAULT_PAGE_HEIGHT_TWIPS = 16838 // A4 高度 = 841.9 pt
const DEFAULT_MARGIN_TOP_TWIPS = 1440   // 72 pt (1 inch)
const DEFAULT_MARGIN_BOTTOM_TWIPS = 1440
const DEFAULT_MARGIN_LEFT_TWIPS = 1800  // 90 pt (1.25 inch)
const DEFAULT_MARGIN_RIGHT_TWIPS = 1800
const DEFAULT_FONT_SIZE_PT = 10.5       // 五号字 21 half-points = 10.5 pt
const DEFAULT_LINE_TWIPS = 240          // 单倍行距

function twipsToPt(twips: number): number {
  return twips / 20
}

/** EMU → pt 换算基数（1 pt = 12700 EMU） */
const EMU_PER_PT = 12700

/** 插图高度防御上限（pt）：超出视为解析异常值直接丢弃 */
const MAX_PLAUSIBLE_FIGURE_HEIGHT_PT = 4000

/**
 * 从 `w:drawing`（wp:inline / wp:anchor → wp:extent cx/cy，EMU）或旧版 `w:pict`
 * （v:shape style="...height:...pt..."，VML）提取插图真实物理高度（pt）。
 */
function extractDrawingHeightPt(node: XmlElement): number | undefined {
  // 现代绘图对象：wp:inline / wp:anchor 直接子节点 wp:extent
  const hostNode = findFirstElement(node, 'inline') ?? findFirstElement(node, 'anchor')
  if (hostNode) {
    const extent = getFirstDirectChild(hostNode, 'extent')
    const cyEmu = Number(getAttr(extent, 'cy'))
    if (Number.isFinite(cyEmu) && cyEmu > 0) {
      const heightPt = cyEmu / EMU_PER_PT
      if (heightPt > 0 && heightPt < MAX_PLAUSIBLE_FIGURE_HEIGHT_PT) return heightPt
    }
    return undefined
  }
  // 旧版 VML 形状：style 属性内联尺寸
  const shape = findFirstElement(node, 'shape')
  const style = getAttr(shape, 'style')
  if (style) {
    const m = /(?:^|;)\s*height\s*:\s*([\d.]+)\s*(pt|px)?/i.exec(style)
    if (m) {
      const raw = Number(m[1])
      if (Number.isFinite(raw) && raw > 0 && raw < MAX_PLAUSIBLE_FIGURE_HEIGHT_PT) {
        return m[2]?.toLowerCase() === 'px' ? (raw * 72) / 96 : raw
      }
    }
  }
  return undefined
}

/**
 * 判断锚点插图是否挤占文字流动空间：
 * wp:inline 恒占位；wp:anchor 仅在四周/上下环绕时占位，
 * 衬于文字下方（behindDoc）或无环绕（wrapNone）的浮动插图不改变流式高度。
 */
function isDrawingFlowDisplacing(node: XmlElement): boolean {
  const anchorNode = findFirstElement(node, 'anchor')
  if (!anchorNode) return true
  const behindDoc = getAttr(anchorNode, 'behindDoc')
  if (behindDoc === '1' || behindDoc?.toLowerCase() === 'true') return false
  if (findFirstElement(anchorNode, 'wrapNone')) return false
  return true
}

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0
  return Math.max(0, Math.min(1, Number(val.toFixed(4))))
}

// ─── 样式与列表定义数据结构 ───

interface DocxStyleResolved {
  styleId: string
  name: string
  basedOn?: string
  fontSizePt?: number
  lineTwips?: number
  lineRule?: string
  spaceBeforePt?: number
  spaceAfterPt?: number
  indentLeftPt?: number
  indentRightPt?: number
  indentFirstLinePt?: number
  headingLevel?: number
  keepNext?: boolean
  keepLines?: boolean
  pageBreakBefore?: boolean
}

interface PageGeometryPt {
  widthPt: number
  heightPt: number
  marginTopPt: number
  marginBottomPt: number
  marginLeftPt: number
  marginRightPt: number
  cols: number
}

interface NumberingRegistry {
  numIdToAbstractId: Map<string, string>
  abstractLvlFormat: Map<string, Map<number, string>>
  counters: Map<string, number>
}

// ─── 样式表解析与 `w:basedOn` 继承链展开 ───

function detectHeadingLevelFromStyle(styleId: string, name: string, outlineLvl?: number): number | undefined {
  if (outlineLvl !== undefined && outlineLvl >= 0 && outlineLvl <= 5) {
    return outlineLvl + 1
  }
  const combined = `${styleId} ${name}`.trim()
  const m = /(?:^|\b)(?:heading|标题)\s*([1-6])\b/i.exec(combined) ?? /^([1-6])$/.exec(styleId)
  if (m) {
    return parseInt(m[1]!, 10)
  }
  if (/^(?:title|标题)$/i.test(name.trim()) || /^title$/i.test(styleId.trim())) {
    return 1
  }
  return undefined
}

function parseRunFontSizePt(rPr: XmlElement | null): number | undefined {
  if (!rPr) return undefined
  const szNode = getFirstDirectChild(rPr, 'sz') ?? getFirstDirectChild(rPr, 'szCs')
  const val = Number(getAttr(szNode, 'val'))
  if (Number.isFinite(val) && val > 0) return val / 2
  return undefined
}

function isWordOnOffEnabled(node: XmlElement | null | undefined): boolean {
  if (!node) return false
  const val = getAttr(node, 'val')?.trim().toLowerCase()
  if (val === '0' || val === 'false' || val === 'off') return false
  return true
}

function extractParagraphProps(pPr: XmlElement | null): Partial<DocxStyleResolved> {
  if (!pPr) return {}
  const out: Partial<DocxStyleResolved> = {}

  const spacing = getFirstDirectChild(pPr, 'spacing')
  if (spacing) {
    const before = Number(getAttr(spacing, 'before'))
    const after = Number(getAttr(spacing, 'after'))
    const line = Number(getAttr(spacing, 'line'))
    const lineRule = getAttr(spacing, 'lineRule')
    if (Number.isFinite(before) && before >= 0) out.spaceBeforePt = twipsToPt(before)
    if (Number.isFinite(after) && after >= 0) out.spaceAfterPt = twipsToPt(after)
    if (Number.isFinite(line) && line > 0) out.lineTwips = line
    if (lineRule) out.lineRule = lineRule
  }

  const ind = getFirstDirectChild(pPr, 'ind')
  if (ind) {
    const left = Number(getAttr(ind, 'left') ?? getAttr(ind, 'start'))
    const right = Number(getAttr(ind, 'right') ?? getAttr(ind, 'end'))
    const firstLine = Number(getAttr(ind, 'firstLine'))
    const hanging = Number(getAttr(ind, 'hanging'))
    if (Number.isFinite(left)) out.indentLeftPt = twipsToPt(left)
    if (Number.isFinite(right)) out.indentRightPt = twipsToPt(right)
    if (Number.isFinite(firstLine)) out.indentFirstLinePt = twipsToPt(firstLine)
    else if (Number.isFinite(hanging)) out.indentFirstLinePt = -twipsToPt(hanging)
  }

  const outlineLvlNode = getFirstDirectChild(pPr, 'outlineLvl')
  if (outlineLvlNode) {
    const lvl = Number(getAttr(outlineLvlNode, 'val'))
    if (Number.isFinite(lvl) && lvl >= 0 && lvl <= 5) {
      out.headingLevel = lvl + 1
    }
  }

  if (isWordOnOffEnabled(getFirstDirectChild(pPr, 'keepNext'))) out.keepNext = true
  if (isWordOnOffEnabled(getFirstDirectChild(pPr, 'keepLines'))) out.keepLines = true
  if (isWordOnOffEnabled(getFirstDirectChild(pPr, 'pageBreakBefore'))) out.pageBreakBefore = true

  return out
}

function parseStylesXml(zip: OoxmlZipReader): {
  styles: Map<string, DocxStyleResolved>
  defaultFontSizePt: number
} {
  const stylesRoot = zip.readXml('word/styles.xml')
  const rawStyles = new Map<string, DocxStyleResolved>()
  let defaultFontSizePt = DEFAULT_FONT_SIZE_PT

  if (!stylesRoot) {
    return { styles: rawStyles, defaultFontSizePt }
  }

  // 解析 docDefaults
  const docDefaults = findFirstElement(stylesRoot, 'docDefaults')
  if (docDefaults) {
    const rPrDefault = findFirstElement(docDefaults, 'rPr')
    const defaultSz = parseRunFontSizePt(rPrDefault)
    if (defaultSz) defaultFontSizePt = defaultSz
  }

  for (const styleNode of findElements(stylesRoot, 'style')) {
    const styleId = getAttr(styleNode, 'styleId')
    if (!styleId) continue
    const nameNode = getFirstDirectChild(styleNode, 'name')
    const name = getAttr(nameNode, 'val') ?? styleId
    const basedOnNode = getFirstDirectChild(styleNode, 'basedOn')
    const basedOn = getAttr(basedOnNode, 'val')

    const pPr = getFirstDirectChild(styleNode, 'pPr')
    const rPr = getFirstDirectChild(styleNode, 'rPr')
    const pProps = extractParagraphProps(pPr)
    const fontSizePt = parseRunFontSizePt(rPr)
    const headingLevel = detectHeadingLevelFromStyle(styleId, name, pProps.headingLevel ? pProps.headingLevel - 1 : undefined)

    rawStyles.set(styleId, {
      styleId,
      name,
      basedOn,
      ...pProps,
      ...(fontSizePt !== undefined ? { fontSizePt } : {}),
      ...(headingLevel !== undefined ? { headingLevel } : {}),
    })
  }

  // 递归展开 basedOn 继承链（带环路检测）
  const resolvedMap = new Map<string, DocxStyleResolved>()
  function resolveStyle(id: string, visited = new Set<string>()): DocxStyleResolved | undefined {
    if (resolvedMap.has(id)) return resolvedMap.get(id)!
    const current = rawStyles.get(id)
    if (!current) return undefined
    if (visited.has(id)) return current
    visited.add(id)

    const parent = current.basedOn ? resolveStyle(current.basedOn, visited) : undefined
    const merged: DocxStyleResolved = {
      ...parent,
      ...current,
      styleId: current.styleId,
      name: current.name,
    }
    resolvedMap.set(id, merged)
    return merged
  }

  for (const id of rawStyles.keys()) {
    resolveStyle(id)
  }

  return { styles: resolvedMap, defaultFontSizePt }
}

// ─── 列表编号 (`word/numbering.xml`) 解析 ───

function parseNumberingXml(zip: OoxmlZipReader): NumberingRegistry {
  const numIdToAbstractId = new Map<string, string>()
  const abstractLvlFormat = new Map<string, Map<number, string>>()
  const counters = new Map<string, number>()

  const root = zip.readXml('word/numbering.xml')
  if (!root) return { numIdToAbstractId, abstractLvlFormat, counters }

  for (const absNode of findElements(root, 'abstractNum')) {
    const absId = getAttr(absNode, 'abstractNumId')
    if (!absId) continue
    const lvlMap = new Map<number, string>()
    for (const lvlNode of getDirectChildren(absNode, 'lvl')) {
      const ilvl = Number(getAttr(lvlNode, 'ilvl') ?? '0')
      const numFmtNode = getFirstDirectChild(lvlNode, 'numFmt')
      const fmt = getAttr(numFmtNode, 'val') ?? 'bullet'
      lvlMap.set(ilvl, fmt)
    }
    abstractLvlFormat.set(absId, lvlMap)
  }

  for (const numNode of findElements(root, 'num')) {
    const numId = getAttr(numNode, 'numId')
    const absIdNode = getFirstDirectChild(numNode, 'abstractNumId')
    const absId = getAttr(absIdNode, 'val')
    if (numId && absId) {
      numIdToAbstractId.set(numId, absId)
    }
  }

  return { numIdToAbstractId, abstractLvlFormat, counters }
}

// ─── 脚注 (`word/footnotes.xml`) 解析 ───

function parseFootnotesXml(zip: OoxmlZipReader): Map<string, string> {
  const map = new Map<string, string>()
  const root = zip.readXml('word/footnotes.xml')
  if (!root) return map

  for (const fnNode of findElements(root, 'footnote')) {
    const id = getAttr(fnNode, 'id')
    const type = getAttr(fnNode, 'type')
    if (!id || type === 'separator' || type === 'continuationSeparator') continue
    const numId = Number(id)
    if (Number.isFinite(numId) && numId <= 0) continue

    const textParts: string[] = []
    for (const p of findElements(fnNode, 'p')) {
      const t = findElements(p, 't').map((n) => getTextContent(n)).join('').trim()
      if (t) textParts.push(t)
    }
    if (textParts.length > 0) {
      map.set(id, textParts.join(' '))
    }
  }
  return map
}

// ─── OMML (`m:oMath` / `m:oMathPara`) -> LaTeX 递归转换器 ───

export function convertOmmlNodeToLatex(node: XmlElement): string {
  switch (node.localName) {
    case 'oMathPara':
    case 'oMath': {
      return getDirectChildren(node).map(convertOmmlNodeToLatex).join('')
    }
    case 'r': {
      return findElements(node, 't').map((t) => getTextContent(t)).join('')
    }
    case 't': {
      return getTextContent(node)
    }
    case 'f': {
      const num = getFirstDirectChild(node, 'num')
      const den = getFirstDirectChild(node, 'den')
      const numLatex = num ? getDirectChildren(num).map(convertOmmlNodeToLatex).join('') : ''
      const denLatex = den ? getDirectChildren(den).map(convertOmmlNodeToLatex).join('') : ''
      return `\\frac{${numLatex}}{${denLatex}}`
    }
    case 'sSup': {
      const e = getFirstDirectChild(node, 'e')
      const sup = getFirstDirectChild(node, 'sup')
      const base = e ? getDirectChildren(e).map(convertOmmlNodeToLatex).join('') : ''
      const exp = sup ? getDirectChildren(sup).map(convertOmmlNodeToLatex).join('') : ''
      return `${base}^{${exp}}`
    }
    case 'sSub': {
      const e = getFirstDirectChild(node, 'e')
      const sub = getFirstDirectChild(node, 'sub')
      const base = e ? getDirectChildren(e).map(convertOmmlNodeToLatex).join('') : ''
      const idx = sub ? getDirectChildren(sub).map(convertOmmlNodeToLatex).join('') : ''
      return `${base}_{${idx}}`
    }
    case 'sSubSup': {
      const e = getFirstDirectChild(node, 'e')
      const sub = getFirstDirectChild(node, 'sub')
      const sup = getFirstDirectChild(node, 'sup')
      const base = e ? getDirectChildren(e).map(convertOmmlNodeToLatex).join('') : ''
      const idx = sub ? getDirectChildren(sub).map(convertOmmlNodeToLatex).join('') : ''
      const exp = sup ? getDirectChildren(sup).map(convertOmmlNodeToLatex).join('') : ''
      return `${base}_{${idx}}^{${exp}}`
    }
    case 'rad': {
      const deg = getFirstDirectChild(node, 'deg')
      const e = getFirstDirectChild(node, 'e')
      const degText = deg ? getDirectChildren(deg).map(convertOmmlNodeToLatex).join('').trim() : ''
      const body = e ? getDirectChildren(e).map(convertOmmlNodeToLatex).join('') : ''
      return degText ? `\\sqrt[${degText}]{${body}}` : `\\sqrt{${body}}`
    }
    case 'nary': {
      const naryPr = getFirstDirectChild(node, 'naryPr')
      const chrNode = naryPr ? getFirstDirectChild(naryPr, 'chr') : null
      const chr = getAttr(chrNode, 'val') ?? '∑'
      const opMap: Record<string, string> = {
        '∑': '\\sum',
        '∏': '\\prod',
        '∫': '\\int',
        '∬': '\\iint',
        '∮': '\\oint',
      }
      const op = opMap[chr] ?? chr
      const sub = getFirstDirectChild(node, 'sub')
      const sup = getFirstDirectChild(node, 'sup')
      const e = getFirstDirectChild(node, 'e')
      const subLatex = sub ? getDirectChildren(sub).map(convertOmmlNodeToLatex).join('').trim() : ''
      const supLatex = sup ? getDirectChildren(sup).map(convertOmmlNodeToLatex).join('').trim() : ''
      const body = e ? getDirectChildren(e).map(convertOmmlNodeToLatex).join('') : ''
      const limits = `${subLatex ? `_{${subLatex}}` : ''}${supLatex ? `^{${supLatex}}` : ''}`
      return `${op}${limits} ${body}`.trim()
    }
    case 'd': {
      const dPr = getFirstDirectChild(node, 'dPr')
      const begChr = getAttr(dPr ? getFirstDirectChild(dPr, 'begChr') : null, 'val') ?? '('
      const endChr = getAttr(dPr ? getFirstDirectChild(dPr, 'endChr') : null, 'val') ?? ')'
      const elements = getDirectChildren(node, 'e').map((e) =>
        getDirectChildren(e).map(convertOmmlNodeToLatex).join(''),
      )
      return `\\left${begChr}${elements.join(', ')}\\right${endChr}`
    }
    case 'm': {
      const rows = getDirectChildren(node, 'mr').map((mr) =>
        getDirectChildren(mr, 'e')
          .map((e) => getDirectChildren(e).map(convertOmmlNodeToLatex).join(''))
          .join(' & '),
      )
      return `\\begin{pmatrix} ${rows.join(' \\\\ ')} \\end{pmatrix}`
    }
    case 'eqArr': {
      const rows = getDirectChildren(node, 'e').map((e) =>
        getDirectChildren(e).map(convertOmmlNodeToLatex).join(''),
      )
      return rows.join(' \\\\ ')
    }
    default: {
      const children = getDirectChildren(node)
      if (children.length > 0) {
        return children.map(convertOmmlNodeToLatex).join('')
      }
      return ''
    }
  }
}

// ─── GDI 整数字距仿真与 CJK 行折行测量 ───

function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点
    (code >= 0xff00 && code <= 0xffef) || // 全角 ASCII/标点
    (code >= 0xac00 && code <= 0xd7af)    // 韩文音节
  )
}

/**
 * 采用 Windows GDI 96 DPI 整像素舍入字距模型估算文本在给定字号下的总宽度（Points）。
 */
export function measureGdiTextWidthPt(text: string, fontSizePt: number): number {
  const fontSizePx = Math.max(1, Math.round((fontSizePt * 96) / 72))
  let totalPx = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 10 || code === 13) continue
    if (isCjkCodePoint(code)) {
      totalPx += fontSizePx
    } else if (code === 32) {
      totalPx += Math.max(1, Math.round(fontSizePx * 0.33))
    } else if (code >= 65 && code <= 90) {
      totalPx += Math.max(1, Math.round(fontSizePx * 0.65))
    } else {
      totalPx += Math.max(1, Math.round(fontSizePx * 0.54))
    }
  }
  return (totalPx * 72) / 96
}

/**
 * 计算单行高度：遵循 Word GDI 单倍行距基准 `h_line = s * 1.298 * (w:line / 240)`。
 */
export function computeGdiLineHeightPt(
  fontSizePt: number,
  lineTwips = DEFAULT_LINE_TWIPS,
  lineRule = 'auto',
): number {
  const baseSingleLinePt = fontSizePt * 1.298
  if (lineRule === 'exact') {
    return Math.max(fontSizePt, twipsToPt(lineTwips))
  }
  if (lineRule === 'atLeast') {
    return Math.max(baseSingleLinePt, twipsToPt(lineTwips))
  }
  const factor = lineTwips > 0 ? lineTwips / DEFAULT_LINE_TWIPS : 1
  return baseSingleLinePt * factor
}

// ─── 页面几何参数解析 (`w:sectPr`) ───

function parseSectionGeometry(sectPr: XmlElement | null): PageGeometryPt {
  let widthTwips = DEFAULT_PAGE_WIDTH_TWIPS
  let heightTwips = DEFAULT_PAGE_HEIGHT_TWIPS
  let marginTopTwips = DEFAULT_MARGIN_TOP_TWIPS
  let marginBottomTwips = DEFAULT_MARGIN_BOTTOM_TWIPS
  let marginLeftTwips = DEFAULT_MARGIN_LEFT_TWIPS
  let marginRightTwips = DEFAULT_MARGIN_RIGHT_TWIPS
  let cols = 1

  if (sectPr) {
    const pgSz = getFirstDirectChild(sectPr, 'pgSz')
    if (pgSz) {
      const w = Number(getAttr(pgSz, 'w'))
      const h = Number(getAttr(pgSz, 'h'))
      if (Number.isFinite(w) && w > 1000) widthTwips = w
      if (Number.isFinite(h) && h > 1000) heightTwips = h
    }
    const pgMar = getFirstDirectChild(sectPr, 'pgMar')
    if (pgMar) {
      const top = Number(getAttr(pgMar, 'top'))
      const bottom = Number(getAttr(pgMar, 'bottom'))
      const left = Number(getAttr(pgMar, 'left'))
      const right = Number(getAttr(pgMar, 'right'))
      if (Number.isFinite(top) && top >= 0) marginTopTwips = top
      if (Number.isFinite(bottom) && bottom >= 0) marginBottomTwips = bottom
      if (Number.isFinite(left) && left >= 0) marginLeftTwips = left
      if (Number.isFinite(right) && right >= 0) marginRightTwips = right
    }
    const colsNode = getFirstDirectChild(sectPr, 'cols')
    if (colsNode) {
      const num = Number(getAttr(colsNode, 'num'))
      if (Number.isFinite(num) && num >= 1) cols = num
    }
  }

  return {
    widthPt: twipsToPt(widthTwips),
    heightPt: twipsToPt(heightTwips),
    marginTopPt: twipsToPt(marginTopTwips),
    marginBottomPt: twipsToPt(marginBottomTwips),
    marginLeftPt: twipsToPt(marginLeftTwips),
    marginRightPt: twipsToPt(marginRightTwips),
    cols,
  }
}

// ─── 段落解析 (`w:p`) ───

interface ParsedParagraphSegment {
  text: string
  markdown: string
  hasPageBreakBefore: boolean
  isFormulaOnly: boolean
  hasDrawing: boolean
  /** 参与文字流动的插图真实物理高度（pt），取自 EMU extent / VML style；无插图或浮动不占位时缺省 */
  drawingHeightPt?: number
  footnoteIds: string[]
  fontSizePt?: number
}

function extractParagraphSegments(
  pNode: XmlElement,
  defaultFontSizePt: number,
  styleFontSizePt?: number,
): ParsedParagraphSegment[] {
  const segments: ParsedParagraphSegment[] = []
  let currentText = ''
  let currentMd = ''
  let hasBreakBefore = false
  let hasFormula = false
  let hasPlainText = false
  let hasDrawing = false
  let drawingHeightPt: number | undefined
  let maxFontSizePt = styleFontSizePt ?? defaultFontSizePt
  const footnoteIds: string[] = []

  const flushSegment = (nextHasBreak = false) => {
    const trimmedText = currentText.trim()
    const trimmedMd = currentMd.trim()
    if (trimmedText || trimmedMd || hasDrawing) {
      segments.push({
        text: trimmedText || (hasDrawing ? '[插图]' : ''),
        markdown: trimmedMd || (hasDrawing ? '![文档插图](embedded-figure)' : ''),
        hasPageBreakBefore: hasBreakBefore,
        isFormulaOnly: hasFormula && !hasPlainText,
        hasDrawing,
        ...(drawingHeightPt !== undefined ? { drawingHeightPt } : {}),
        footnoteIds: [...footnoteIds],
        fontSizePt: maxFontSizePt,
      })
    }
    currentText = ''
    currentMd = ''
    hasBreakBefore = nextHasBreak
    hasFormula = false
    hasPlainText = false
    hasDrawing = false
    drawingHeightPt = undefined
    footnoteIds.length = 0
  }

  for (const child of getDirectChildren(pNode)) {
    if (child.localName === 'pPr') {
      if (isWordOnOffEnabled(findFirstElement(child, 'pageBreakBefore'))) {
        hasBreakBefore = true
      }
      continue
    }

    if (child.localName === 'oMathPara') {
      const latex = convertOmmlNodeToLatex(child).trim()
      if (latex) {
        hasFormula = true
        currentText += ` ${latex} `
        currentMd += `\n$$\n${latex}\n$$\n`
      }
      continue
    }

    if (child.localName === 'oMath') {
      const latex = convertOmmlNodeToLatex(child).trim()
      if (latex) {
        hasFormula = true
        currentText += ` $${latex}$ `
        currentMd += `$${latex}$`
      }
      continue
    }

    if (child.localName === 'r' || child.localName === 'hyperlink' || child.localName === 'ins') {
      const runs = child.localName === 'r' ? [child] : findElements(child, 'r')
      for (const r of runs) {
        const rPr = getFirstDirectChild(r, 'rPr')
        const rFont = parseRunFontSizePt(rPr)
        if (rFont && rFont > maxFontSizePt) maxFontSizePt = rFont
        const isBold = isWordOnOffEnabled(rPr ? getFirstDirectChild(rPr, 'b') : null)
        const isItalic = isWordOnOffEnabled(rPr ? getFirstDirectChild(rPr, 'i') : null)

        for (const rChild of getDirectChildren(r)) {
          if (rChild.localName === 'lastRenderedPageBreak') {
            flushSegment(true)
            continue
          }
          if (rChild.localName === 'br') {
            const brType = getAttr(rChild, 'type')
            if (brType === 'page') {
              flushSegment(true)
            } else {
              currentText += '\n'
              currentMd += '\n'
            }
            continue
          }
          if (rChild.localName === 'tab') {
            currentText += '\t'
            currentMd += '    '
            continue
          }
          if (rChild.localName === 'drawing' || rChild.localName === 'pict') {
            hasDrawing = true
            const descrNode = findFirstElement(rChild, 'docPr')
            const descr = getAttr(descrNode, 'descr') || getAttr(descrNode, 'name') || '文档插图'
            currentText += `[插图: ${descr}]`
            currentMd += `![${descr}](embedded-figure)`
            // 提取插图真实物理高度（EMU extent / VML style），供主流程替代「13pt 假想文本行」
            const figureHeightPt = extractDrawingHeightPt(rChild)
            if (figureHeightPt !== undefined && isDrawingFlowDisplacing(rChild)) {
              // 同段多图取最大高度
              drawingHeightPt = Math.max(drawingHeightPt ?? 0, figureHeightPt)
            }
            continue
          }
          if (rChild.localName === 'footnoteReference') {
            const fnId = getAttr(rChild, 'id')
            if (fnId) {
              footnoteIds.push(fnId)
              currentText += `[^${fnId}]`
              currentMd += `[^${fnId}]`
            }
            continue
          }
          if (rChild.localName === 't') {
            const val = getTextContent(rChild)
            if (val.length > 0) {
              hasPlainText = true
              currentText += val
              if (isBold && isItalic && val.trim()) {
                currentMd += `***${val}***`
              } else if (isBold && val.trim()) {
                currentMd += `**${val}**`
              } else if (isItalic && val.trim()) {
                currentMd += `*${val}*`
              } else {
                currentMd += val
              }
            }
          }
        }
      }
    }
  }

  flushSegment(false)
  return segments
}

// ─── 表格解析与跨页分裂 (`w:tbl` / `w:cantSplit` / `w:tblHeader`) ───

interface ParsedTableRow {
  cells: string[]
  isHeader: boolean
  cantSplit: boolean
  heightPt: number
}

function parseTableRows(
  tblNode: XmlElement,
  contentWidthPt: number,
  defaultFontSizePt: number,
): ParsedTableRow[] {
  const trNodes = getDirectChildren(tblNode, 'tr')
  const rows: ParsedTableRow[] = []

  for (let rIdx = 0; rIdx < trNodes.length; rIdx++) {
    const tr = trNodes[rIdx]!
    const trPr = getFirstDirectChild(tr, 'trPr')
    const isHeader = isWordOnOffEnabled(trPr ? getFirstDirectChild(trPr, 'tblHeader') : null) || rIdx === 0
    const cantSplit = isWordOnOffEnabled(trPr ? getFirstDirectChild(trPr, 'cantSplit') : null)
    const trHeightNode = trPr ? getFirstDirectChild(trPr, 'trHeight') : null
    const explicitHeightTwips = Number(getAttr(trHeightNode, 'val'))

    const tcNodes = getDirectChildren(tr, 'tc')
    const colCount = Math.max(1, tcNodes.length)
    const colWidthPt = Math.max(36, contentWidthPt / colCount)

    const cells: string[] = []
    let maxLinesInRow = 1

    for (const tc of tcNodes) {
      const pTexts: string[] = []
      for (const p of getDirectChildren(tc, 'p')) {
        const t = findElements(p, 't').map((n) => getTextContent(n)).join('').trim()
        const mathNodes = findElements(p, 'oMath')
        const mathText = mathNodes.map((m) => `$${convertOmmlNodeToLatex(m).trim()}$`).join(' ')
        const combined = [t, mathText].filter(Boolean).join(' ').trim()
        if (combined) pTexts.push(combined)
      }
      const cellText = pTexts.join(' ').replace(/\|/g, '\\|').trim()
      cells.push(cellText)

      const textWidth = measureGdiTextWidthPt(cellText, defaultFontSizePt)
      const wrappedLines = Math.max(1, Math.ceil(textWidth / Math.max(24, colWidthPt - 10)))
      if (wrappedLines > maxLinesInRow) maxLinesInRow = wrappedLines
    }

    const lineHeight = computeGdiLineHeightPt(defaultFontSizePt)
    const computedHeightPt = maxLinesInRow * lineHeight + 8
    const heightPt =
      Number.isFinite(explicitHeightTwips) && explicitHeightTwips > 0
        ? Math.max(computedHeightPt, twipsToPt(explicitHeightTwips))
        : computedHeightPt

    rows.push({
      cells,
      isHeader,
      cantSplit,
      heightPt,
    })
  }

  return rows
}

function buildGfmTableMarkdown(rows: ParsedTableRow[]): { markdown: string; plainText: string; colCount: number } {
  if (rows.length === 0) return { markdown: '', plainText: '', colCount: 0 }
  const colCount = Math.max(1, ...rows.map((r) => r.cells.length))
  const padCells = (cells: string[]): string[] =>
    Array.from({ length: colCount }, (_, i) => (cells[i] ?? '').replace(/\r?\n/g, ' ').trim())

  const headerCells = padCells(rows[0]!.cells)
  const separator = Array.from({ length: colCount }, () => '---')
  const lines: string[] = [
    `| ${headerCells.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
  ]
  const plainLines: string[] = [headerCells.join('\t')]

  for (let i = 1; i < rows.length; i++) {
    const rowCells = padCells(rows[i]!.cells)
    lines.push(`| ${rowCells.join(' | ')} |`)
    plainLines.push(rowCells.join('\t'))
  }

  return {
    markdown: lines.join('\n'),
    plainText: plainLines.join('\n'),
    colCount,
  }
}

// ─── 主求解入口：`solveDocxReflow` ───

export function solveDocxReflow(
  zip: OoxmlZipReader,
  options: OfficeParseOptions = {},
): OfficeDocumentLayoutAST {
  const docRoot = zip.readXml('word/document.xml')
  if (!docRoot) {
    throw new Error('无效的 DOCX 文档：缺少 word/document.xml')
  }

  const coreMeta = parseCoreMetadata(zip)
  const { styles, defaultFontSizePt } = parseStylesXml(zip)
  const numbering = parseNumberingXml(zip)
  const footnotes = parseFootnotesXml(zip)

  const bodyNode = findFirstElement(docRoot, 'body') ?? docRoot
  const bodySectPr = getFirstDirectChild(bodyNode, 'sectPr')
  let geometry = parseSectionGeometry(bodySectPr)

  const pages: OfficePageLayout[] = []
  let currentPageNumber = 1
  let currentY = geometry.marginTopPt
  let currentBlocks: OfficeLayoutBlock[] = []
  let currentSectionTitle = ''
  let currentPageMainTitle = ''
  let globalReadingOrder = 0
  let currentPageFootnoteReservedPt = 0
  const currentPageFootnotes: Array<{ id: string; text: string }> = []

  const getUsableBottomPt = (): number =>
    Math.max(
      geometry.marginTopPt + 72,
      geometry.heightPt - geometry.marginBottomPt - currentPageFootnoteReservedPt,
    )

  const flushCurrentPage = (nextGeometry?: PageGeometryPt) => {
    // 将当前页累积的脚注作为底部块落入当页版面
    if (currentPageFootnotes.length > 0) {
      const fnHeight = Math.min(currentPageFootnoteReservedPt, geometry.heightPt * 0.25)
      const fnY0 = Math.max(geometry.marginTopPt, geometry.heightPt - geometry.marginBottomPt - fnHeight)
      const fnY1 = Math.min(geometry.heightPt, fnY0 + fnHeight)
      const fnText = currentPageFootnotes.map((f) => `[${f.id}] ${f.text}`).join('\n')
      const fnMd = currentPageFootnotes.map((f) => `[^${f.id}]: ${f.text}`).join('\n')
      const blockIdx = currentBlocks.length + 1
      currentBlocks.push({
        id: `p${currentPageNumber}-b${blockIdx}`,
        pageNumber: currentPageNumber,
        type: 'footer',
        text: fnText,
        markdown: fnMd,
        bbox: [
          clamp01(geometry.marginLeftPt / geometry.widthPt),
          clamp01(fnY0 / geometry.heightPt),
          clamp01((geometry.widthPt - geometry.marginRightPt) / geometry.widthPt),
          clamp01(fnY1 / geometry.heightPt),
        ],
        locLabel: `第${currentPageNumber}页·脚注`,
        readingOrder: globalReadingOrder++,
      })
      currentPageFootnotes.length = 0
      currentPageFootnoteReservedPt = 0
    }

    if (currentBlocks.length > 0 || pages.length === 0) {
      pages.push({
        pageNumber: currentPageNumber,
        widthPt: Number(geometry.widthPt.toFixed(2)),
        heightPt: Number(geometry.heightPt.toFixed(2)),
        ...(currentPageMainTitle || currentSectionTitle
          ? { title: currentPageMainTitle || currentSectionTitle }
          : {}),
        blocks: currentBlocks,
      })
    }

    if (nextGeometry) {
      geometry = nextGeometry
    }
    currentPageNumber += 1
    currentY = geometry.marginTopPt
    currentBlocks = []
    currentPageMainTitle = ''
  }

  const bodyChildren = getDirectChildren(bodyNode)

  for (const child of bodyChildren) {
    if (options.maxPages && currentPageNumber > options.maxPages) break

    if (child.localName === 'p') {
      const pPr = getFirstDirectChild(child, 'pPr')
      const pStyleNode = pPr ? getFirstDirectChild(pPr, 'pStyle') : null
      const styleId = getAttr(pStyleNode, 'val')
      const style = styleId ? styles.get(styleId) : undefined
      const inlineProps = extractParagraphProps(pPr)

      const fontSizePt = inlineProps.fontSizePt ?? style?.fontSizePt ?? defaultFontSizePt
      const lineTwips = inlineProps.lineTwips ?? style?.lineTwips ?? DEFAULT_LINE_TWIPS
      const lineRule = inlineProps.lineRule ?? style?.lineRule ?? 'auto'
      const spaceBeforePt = inlineProps.spaceBeforePt ?? style?.spaceBeforePt ?? 0
      const spaceAfterPt = inlineProps.spaceAfterPt ?? style?.spaceAfterPt ?? 4
      const indentLeftPt = inlineProps.indentLeftPt ?? style?.indentLeftPt ?? 0
      const indentRightPt = inlineProps.indentRightPt ?? style?.indentRightPt ?? 0
      const headingLevel = inlineProps.headingLevel ?? style?.headingLevel

      // 检查列表属性 `w:numPr`
      const numPr = pPr ? getFirstDirectChild(pPr, 'numPr') : null
      const numId = getAttr(numPr ? getFirstDirectChild(numPr, 'numId') : null, 'val')
      const ilvl = Number(getAttr(numPr ? getFirstDirectChild(numPr, 'ilvl') : null, 'val') ?? '0')
      const isList = Boolean(numId && numId !== '0')

      const segments = extractParagraphSegments(child, defaultFontSizePt, fontSizePt)
      const inlineSectPr = pPr ? getFirstDirectChild(pPr, 'sectPr') : null

      for (const seg of segments) {
        if (seg.hasPageBreakBefore && currentBlocks.length > 0) {
          flushCurrentPage()
        }

        // 统计脚注空间预留
        for (const fnId of seg.footnoteIds) {
          const fnText = footnotes.get(fnId)
          if (fnText && !currentPageFootnotes.some((item) => item.id === fnId)) {
            currentPageFootnotes.push({ id: fnId, text: fnText })
            currentPageFootnoteReservedPt += 18
          }
        }

        const effectiveFontPt = seg.fontSizePt ?? fontSizePt
        const contentWidthPt = Math.max(
          72,
          geometry.widthPt - geometry.marginLeftPt - geometry.marginRightPt - indentLeftPt - indentRightPt,
        )
        const textWidthPt = measureGdiTextWidthPt(seg.text, effectiveFontPt)
        const lineCount = Math.max(1, Math.ceil(textWidthPt / contentWidthPt))
        const singleLinePt = computeGdiLineHeightPt(effectiveFontPt, lineTwips, lineRule)
        let blockHeightPt = Math.max(singleLinePt, lineCount * singleLinePt)
        // 插图段落使用真实绘图物理高度（EMU extent / VML style），
        // 修复将 [插图] 当作单行 13pt 假想文本导致的整页纵向累计坐标漂移
        if (seg.hasDrawing && seg.drawingHeightPt !== undefined && seg.drawingHeightPt > blockHeightPt) {
          blockHeightPt = seg.drawingHeightPt
        }
        const totalRequiredPt = spaceBeforePt + blockHeightPt + spaceAfterPt

        // Widow/Orphan 与分页阈值判定
        if (currentY + totalRequiredPt > getUsableBottomPt() && currentBlocks.length > 0) {
          flushCurrentPage()
        }

        const y0Pt = currentY + spaceBeforePt
        const y1Pt = Math.min(geometry.heightPt - geometry.marginBottomPt, y0Pt + blockHeightPt)
        const x0Pt = geometry.marginLeftPt + indentLeftPt
        const x1Pt = Math.min(
          geometry.widthPt - geometry.marginRightPt,
          Math.max(x0Pt + 36, x0Pt + Math.min(contentWidthPt, Math.max(textWidthPt, contentWidthPt * 0.25))),
        )

        let blockType: OfficeBlockType = 'paragraph'
        let blockMarkdown = seg.markdown
        let effectiveHeadingLevel = headingLevel

        if (seg.isFormulaOnly) {
          blockType = 'formula'
          if (!blockMarkdown.startsWith('$$')) {
            blockMarkdown = `$$\n${seg.text.replace(/^\$|\$$/g, '').trim()}\n$$`
          }
        } else if (seg.hasDrawing && seg.text.startsWith('[插图')) {
          blockType = 'figure'
        } else if (effectiveHeadingLevel !== undefined) {
          blockType = 'heading'
          const lvl = Math.max(1, Math.min(6, effectiveHeadingLevel))
          effectiveHeadingLevel = lvl
          currentSectionTitle = seg.text.replace(/\s+/g, ' ').slice(0, 36)
          if (!currentPageMainTitle) currentPageMainTitle = currentSectionTitle
          const cleanHeadingText = seg.text.replace(/^#+\s*/, '').trim()
          blockMarkdown = `${'#'.repeat(lvl)} ${cleanHeadingText}`
        } else if (isList && numId) {
          blockType = 'list'
          const absId = numbering.numIdToAbstractId.get(numId)
          const fmt = (absId ? numbering.abstractLvlFormat.get(absId)?.get(ilvl) : undefined) ?? 'bullet'
          const indentPrefix = '  '.repeat(Math.max(0, Math.min(4, ilvl)))
          if (fmt === 'bullet') {
            blockMarkdown = `${indentPrefix}- ${seg.markdown}`
          } else {
            const key = `${numId}:${ilvl}`
            const nextCount = (numbering.counters.get(key) ?? 0) + 1
            numbering.counters.set(key, nextCount)
            blockMarkdown = `${indentPrefix}${nextCount}. ${seg.markdown}`
          }
        } else if (/^(?:图|表|Fig(?:ure)?\.?|Table)\s*\d+/i.test(seg.text.trim()) && seg.text.length < 120) {
          blockType = 'caption'
        }

        const blockIdx = currentBlocks.length + 1
        const cleanSnippet = seg.text.replace(/\s+/g, ' ').trim().slice(0, 24)
        const locSuffix =
          blockType === 'heading'
            ? seg.text.slice(0, 24)
            : blockType === 'formula'
              ? '公式'
              : blockType === 'figure'
                ? '插图'
                : cleanSnippet || currentSectionTitle || '正文'

        currentBlocks.push({
          id: `p${currentPageNumber}-b${blockIdx}`,
          pageNumber: currentPageNumber,
          type: blockType,
          text: seg.text,
          markdown: blockMarkdown,
          bbox: [
            clamp01(x0Pt / geometry.widthPt),
            clamp01(y0Pt / geometry.heightPt),
            clamp01(x1Pt / geometry.widthPt),
            clamp01(y1Pt / geometry.heightPt),
          ],
          locLabel: `第${currentPageNumber}页·${locSuffix}`,
          readingOrder: globalReadingOrder++,
          ...(effectiveHeadingLevel !== undefined ? { headingLevel: effectiveHeadingLevel } : {}),
        })

        currentY = y1Pt + spaceAfterPt
      }

      if (inlineSectPr) {
        const nextGeom = parseSectionGeometry(inlineSectPr)
        flushCurrentPage(nextGeom)
      }
      continue
    }

    if (child.localName === 'tbl') {
      const contentWidthPt = Math.max(72, geometry.widthPt - geometry.marginLeftPt - geometry.marginRightPt)
      const allRows = parseTableRows(child, contentWidthPt, defaultFontSizePt)
      if (allRows.length === 0) continue

      const headerRows = allRows.filter((r) => r.isHeader)
      const dataRows = allRows.filter((r) => !r.isHeader)
      const effectiveRows = dataRows.length > 0 ? dataRows : allRows

      let sliceRows: ParsedTableRow[] = headerRows.length > 0 && dataRows.length > 0 ? [...headerRows] : []
      let sliceHeightPt = sliceRows.reduce((acc, r) => acc + r.heightPt, 0)

      const commitTableSlice = (rowsToCommit: ParsedTableRow[]) => {
        if (rowsToCommit.length === 0) return
        const { markdown, plainText, colCount } = buildGfmTableMarkdown(rowsToCommit)
        const totalH = rowsToCommit.reduce((acc, r) => acc + r.heightPt, 0)
        const y0Pt = currentY + 4
        const y1Pt = Math.min(geometry.heightPt - geometry.marginBottomPt, y0Pt + totalH)
        const x0Pt = geometry.marginLeftPt
        const x1Pt = geometry.widthPt - geometry.marginRightPt
        const blockIdx = currentBlocks.length + 1
        const locSuffix = currentSectionTitle ? `${currentSectionTitle}·表格` : '表格'

        currentBlocks.push({
          id: `p${currentPageNumber}-b${blockIdx}`,
          pageNumber: currentPageNumber,
          type: 'table',
          text: plainText,
          markdown,
          bbox: [
            clamp01(x0Pt / geometry.widthPt),
            clamp01(y0Pt / geometry.heightPt),
            clamp01(x1Pt / geometry.widthPt),
            clamp01(y1Pt / geometry.heightPt),
          ],
          locLabel: `第${currentPageNumber}页·${locSuffix}`,
          readingOrder: globalReadingOrder++,
          rowCount: rowsToCommit.length,
          columnCount: colCount,
        })
        currentY = y1Pt + 8
      }

      for (const row of effectiveRows) {
        const usableBottom = getUsableBottomPt()
        const projectedBottom = currentY + 4 + sliceHeightPt + row.heightPt

        if (projectedBottom > usableBottom && (sliceRows.length > headerRows.length || currentBlocks.length > 0)) {
          if (sliceRows.length > headerRows.length || (headerRows.length === 0 && sliceRows.length > 0)) {
            commitTableSlice(sliceRows)
          }
          flushCurrentPage()
          // 跨页分裂时自动在新页顶部虚拟克隆 w:tblHeader 表头行
          sliceRows = headerRows.length > 0 && dataRows.length > 0 ? [...headerRows] : []
          sliceHeightPt = sliceRows.reduce((acc, r) => acc + r.heightPt, 0)
        }

        sliceRows.push(row)
        sliceHeightPt += row.heightPt
      }

      if (sliceRows.length > 0) {
        commitTableSlice(sliceRows)
      }
    }
  }

  if (currentBlocks.length > 0 || pages.length === 0) {
    flushCurrentPage()
  }

  const docTitle =
    coreMeta.title ||
    pages[0]?.title ||
    pages[0]?.blocks.find((b) => b.type === 'heading')?.text

  return {
    format: 'docx',
    pageCount: pages.length,
    pages,
    metadata: {
      ...(docTitle ? { title: docTitle } : {}),
      ...(coreMeta.author ? { author: coreMeta.author } : {}),
    },
  }
}
