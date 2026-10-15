/**
 * PPTX 离散空间拓扑与阅读顺序重构求解器 (Discrete Spatial Topology & Reading Order Solver)
 *
 * 核心能力：
 * 1. 嵌套组合形状 (`p:grpSp`) 递归 2D 齐次仿射变换矩阵 ($3 \times 3$) 展平，支持平移 (`a:off`)、
 *    子空间重映射 (`a:chOff`/`a:chExt` -> `a:ext`)、旋转 (`rot / 60000°`) 与镜像 (`flipH`/`flipV`)；
 * 2. 动画时间轴 (`p:timing` -> `p:cTn` -> `p:spTgt[@spid]`) 因果 DAG 拓扑排序 + Y-Band (`0.04 * H`) 空间阅读顺序重构；
 * 3. 连接线 (`p:cxnSp` -> `a:stCxn` / `a:endCxn`) 拓扑图重构，自动合成 `mermaid flowchart` 代码块；
 * 4. 提取文本框 (`p:txBody`)、表格 (`a:tbl` -> GFM Markdown 表格)、图表/图片 (`p:pic`) 与演讲者备注 (`notesSlide`)。
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
  parseOoxmlRelationships,
} from './ooxml-zip-reader.ts'

// ─── 常量与单位换算 (1 inch = 914400 EMUs = 72 pt => 1 pt = 12700 EMUs) ───

const DEFAULT_SLIDE_WIDTH_EMU = 12192000 // 16:9 宽屏默认宽度 (960 pt)
const DEFAULT_SLIDE_HEIGHT_EMU = 6858000 // 16:9 宽屏默认高度 (540 pt)
const EMU_PER_PT = 12700

function emuToPt(emu: number): number {
  return emu / EMU_PER_PT
}

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0
  return Math.max(0, Math.min(1, Number(val.toFixed(4))))
}

// ─── 2D 齐次仿射变换矩阵 (3x3: [a, b, tx, c, d, ty, 0, 0, 1]) ───

export type Matrix2D = [number, number, number, number, number, number]

export const IDENTITY_MATRIX: Matrix2D = [1, 0, 0, 0, 1, 0]

/** 矩阵乘法：$M_1 \times M_2$ */
export function multiplyMatrix2D(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  const [a1, b1, tx1, c1, d1, ty1] = m1
  const [a2, b2, tx2, c2, d2, ty2] = m2
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    a1 * tx2 + b1 * ty2 + tx1,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    c1 * tx2 + d1 * ty2 + ty1,
  ]
}

/** 对二维点 $(x, y)$ 应用仿射变换 */
export function applyMatrix2D(m: Matrix2D, x: number, y: number): [number, number] {
  const [a, b, tx, c, d, ty] = m
  return [a * x + b * y + tx, c * x + d * y + ty]
}

/**
 * 构建旋转 + 镜像矩阵（围绕局部中心 $(cx, cy)$）。
 */
function buildRotationFlipMatrix(
  cx: number,
  cy: number,
  rot60k: number,
  flipH: boolean,
  flipV: boolean,
): Matrix2D {
  if (rot60k === 0 && !flipH && !flipV) return IDENTITY_MATRIX
  const rad = ((rot60k / 60000) * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const sx = flipH ? -1 : 1
  const sy = flipV ? -1 : 1

  // T(cx, cy) * R(rad) * S(sx, sy) * T(-cx, -cy)
  const a = cos * sx
  const b = -sin * sy
  const c = sin * sx
  const d = cos * sy
  const tx = cx - a * cx - b * cy
  const ty = cy - c * cx - d * cy
  return [a, b, tx, c, d, ty]
}

/**
 * 构建组合形状 (`p:grpSp -> p:grpSpPr -> a:xfrm`) 的子空间到父空间仿射矩阵。
 * 对嵌套组合的缩放矩阵做防御性钳制，杜绝异常 chExt/ext 产生 NaN 或极端缩放。
 */
function buildGroupTransformMatrix(xfrm: XmlElement | null, parentMatrix: Matrix2D): Matrix2D {
  if (!xfrm) return parentMatrix
  const off = getFirstDirectChild(xfrm, 'off')
  const ext = getFirstDirectChild(xfrm, 'ext')
  const chOff = getFirstDirectChild(xfrm, 'chOff')
  const chExt = getFirstDirectChild(xfrm, 'chExt')

  const sanitize = (val: number): number => (Number.isFinite(val) ? val : 0)
  const offX = sanitize(Number(getAttr(off, 'x') ?? 0))
  const offY = sanitize(Number(getAttr(off, 'y') ?? 0))
  const extCx = sanitize(Number(getAttr(ext, 'cx') ?? 0))
  const extCy = sanitize(Number(getAttr(ext, 'cy') ?? 0))
  const chOffX = sanitize(Number(getAttr(chOff, 'x') ?? offX))
  const chOffY = sanitize(Number(getAttr(chOff, 'y') ?? offY))
  const chExtCx = sanitize(Number(getAttr(chExt, 'cx') ?? extCx))
  const chExtCy = sanitize(Number(getAttr(chExt, 'cy') ?? extCy))

  // 缩放防御：非有限值或超出 ±64x 的退化缩放一律回退单位矩阵，保证归一化 bbox 有界
  const safeScale = (scale: number): number =>
    Number.isFinite(scale) && scale !== 0 && Math.abs(scale) <= 64 ? scale : 1
  const scaleX = safeScale(chExtCx > 0 && extCx > 0 ? extCx / chExtCx : 1)
  const scaleY = safeScale(chExtCy > 0 && extCy > 0 ? extCy / chExtCy : 1)
  const tx = offX - chOffX * scaleX
  const ty = offY - chOffY * scaleY

  const mapMatrix: Matrix2D = [scaleX, 0, tx, 0, scaleY, ty]

  const rot = Number(getAttr(xfrm, 'rot') ?? 0)
  const flipH = getAttr(xfrm, 'flipH') === '1' || getAttr(xfrm, 'flipH') === 'true'
  const flipV = getAttr(xfrm, 'flipV') === '1' || getAttr(xfrm, 'flipV') === 'true'

  const centerX = offX + extCx / 2
  const centerY = offY + extCy / 2
  const rotFlip = buildRotationFlipMatrix(centerX, centerY, rot, flipH, flipV)

  return multiplyMatrix2D(parentMatrix, multiplyMatrix2D(rotFlip, mapMatrix))
}

/**
 * 将局部形状 `a:xfrm` 通过父级累积矩阵投影为全局幻灯片归一化边界框 `[x0, y0, x1, y1]`。
 */
function computeShapeNormalizedBBox(
  xfrm: XmlElement | null,
  parentMatrix: Matrix2D,
  slideWidthEmu: number,
  slideHeightEmu: number,
  fallbackBBox: [number, number, number, number] = [0.08, 0.12, 0.92, 0.28],
): [number, number, number, number] {
  if (!xfrm) return fallbackBBox
  const off = getFirstDirectChild(xfrm, 'off')
  const ext = getFirstDirectChild(xfrm, 'ext')
  const x = Number(getAttr(off, 'x'))
  const y = Number(getAttr(off, 'y'))
  const cx = Number(getAttr(ext, 'cx'))
  const cy = Number(getAttr(ext, 'cy'))

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(cx) || !Number.isFinite(cy)) {
    return fallbackBBox
  }

  const rot = Number(getAttr(xfrm, 'rot') ?? 0)
  const flipH = getAttr(xfrm, 'flipH') === '1' || getAttr(xfrm, 'flipH') === 'true'
  const flipV = getAttr(xfrm, 'flipV') === '1' || getAttr(xfrm, 'flipV') === 'true'
  const localRot = buildRotationFlipMatrix(x + cx / 2, y + cy / 2, rot, flipH, flipV)
  const totalMatrix = multiplyMatrix2D(parentMatrix, localRot)

  const corners: Array<[number, number]> = [
    applyMatrix2D(totalMatrix, x, y),
    applyMatrix2D(totalMatrix, x + Math.max(1, cx), y),
    applyMatrix2D(totalMatrix, x + Math.max(1, cx), y + Math.max(1, cy)),
    applyMatrix2D(totalMatrix, x, y + Math.max(1, cy)),
  ]

  // 仅保留有限坐标：异常嵌套矩阵产生的 NaN/Inf 一律回退默认框，保证输出恒为 [0..1] 有序 bbox
  const finiteXs = corners.map((c) => c[0]).filter((v) => Number.isFinite(v))
  const finiteYs = corners.map((c) => c[1]).filter((v) => Number.isFinite(v))
  if (finiteXs.length === 0 || finiteYs.length === 0) return fallbackBBox

  const minX = Math.min(...finiteXs)
  const maxX = Math.max(...finiteXs)
  const minY = Math.min(...finiteYs)
  const maxY = Math.max(...finiteYs)

  return [
    clamp01(minX / slideWidthEmu),
    clamp01(minY / slideHeightEmu),
    clamp01(maxX / slideWidthEmu),
    clamp01(maxY / slideHeightEmu),
  ]
}

// ─── 幻灯片内部形状与连接线抽取 ───

interface RawSlideShape {
  shapeId: string
  name: string
  placeholderType?: string
  placeholderIdx?: string
  blockType: OfficeBlockType
  text: string
  markdown: string
  bbox: [number, number, number, number]
  headingLevel?: number
  rowCount?: number
  columnCount?: number
}

interface RawConnector {
  id: string
  fromShapeId?: string
  toShapeId?: string
  label?: string
}

function extractTxBodyContent(
  txBody: XmlElement | null,
  isTitlePlaceholder: boolean,
  isSubtitlePlaceholder: boolean,
): { text: string; markdown: string; blockType: OfficeBlockType; headingLevel?: number } {
  if (!txBody) return { text: '', markdown: '', blockType: 'paragraph' }

  const paragraphs = getDirectChildren(txBody, 'p')
  const plainLines: string[] = []
  const mdLines: string[] = []
  let hasList = false

  for (const p of paragraphs) {
    const pPr = getFirstDirectChild(p, 'pPr')
    const lvl = Number(getAttr(pPr, 'lvl') ?? '0')
    const hasBuNone = Boolean(pPr && getFirstDirectChild(pPr, 'buNone'))
    const hasBuChar = Boolean(pPr && getFirstDirectChild(pPr, 'buChar'))
    const hasBuAutoNum = Boolean(pPr && getFirstDirectChild(pPr, 'buAutoNum'))

    const runTexts: string[] = []
    for (const child of getDirectChildren(p)) {
      if (child.localName === 'r' || child.localName === 'fld') {
        const t = findFirstElement(child, 't')
        if (t) runTexts.push(getTextContent(t))
      } else if (child.localName === 'br') {
        runTexts.push('\n')
      }
    }

    const lineText = runTexts.join('').replace(/\s+/g, ' ').trim()
    if (!lineText) continue
    plainLines.push(lineText)

    if (isTitlePlaceholder && mdLines.length === 0) {
      mdLines.push(`# ${lineText}`)
    } else if (isSubtitlePlaceholder && mdLines.length === 0) {
      mdLines.push(`## ${lineText}`)
    } else if (!hasBuNone && (hasBuChar || hasBuAutoNum || lvl > 0)) {
      hasList = true
      const indent = '  '.repeat(Math.max(0, Math.min(4, lvl)))
      mdLines.push(`${indent}- ${lineText}`)
    } else {
      mdLines.push(lineText)
    }
  }

  const text = plainLines.join('\n').trim()
  const markdown = mdLines.join('\n').trim()
  if (isTitlePlaceholder) {
    return { text, markdown, blockType: 'heading', headingLevel: 1 }
  }
  if (isSubtitlePlaceholder) {
    return { text, markdown, blockType: 'heading', headingLevel: 2 }
  }
  if (hasList && plainLines.length > 1) {
    return { text, markdown, blockType: 'list' }
  }
  return { text, markdown, blockType: 'paragraph' }
}

function extractDrawingTable(tblNode: XmlElement): {
  text: string
  markdown: string
  rowCount: number
  columnCount: number
} {
  const trNodes = getDirectChildren(tblNode, 'tr')
  const matrix: string[][] = []

  for (const tr of trNodes) {
    const tcNodes = getDirectChildren(tr, 'tc')
    const rowCells: string[] = []
    for (const tc of tcNodes) {
      const cellText = findElements(tc, 't')
        .map((t) => getTextContent(t))
        .join(' ')
        .replace(/\s+/g, ' ')
        .replace(/\|/g, '\\|')
        .trim()
      rowCells.push(cellText)
    }
    if (rowCells.length > 0) {
      matrix.push(rowCells)
    }
  }

  if (matrix.length === 0) {
    return { text: '', markdown: '', rowCount: 0, columnCount: 0 }
  }

  const colCount = Math.max(1, ...matrix.map((r) => r.length))
  const pad = (row: string[]) => Array.from({ length: colCount }, (_, i) => row[i] ?? '')
  const header = pad(matrix[0]!)
  const sep = Array.from({ length: colCount }, () => '---')
  const mdLines = [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...matrix.slice(1).map((r) => `| ${pad(r).join(' | ')} |`),
  ]
  const plainLines = matrix.map((r) => pad(r).join('\t'))

  return {
    text: plainLines.join('\n'),
    markdown: mdLines.join('\n'),
    rowCount: matrix.length,
    columnCount: colCount,
  }
}

/**
 * 递归遍历 `p:spTree` 或嵌套 `p:grpSp`，展平仿射变换矩阵并收集所有形状与连接线。
 */
function collectShapesFromTree(
  containerNode: XmlElement,
  parentMatrix: Matrix2D,
  slideWidthEmu: number,
  slideHeightEmu: number,
  shapesOut: RawSlideShape[],
  connectorsOut: RawConnector[],
): void {
  for (const child of getDirectChildren(containerNode)) {
    if (child.localName === 'grpSp') {
      const grpSpPr = getFirstDirectChild(child, 'grpSpPr')
      const xfrm = grpSpPr ? getFirstDirectChild(grpSpPr, 'xfrm') : null
      const groupMatrix = buildGroupTransformMatrix(xfrm, parentMatrix)
      collectShapesFromTree(child, groupMatrix, slideWidthEmu, slideHeightEmu, shapesOut, connectorsOut)
      continue
    }

    if (child.localName === 'sp') {
      const nvSpPr = getFirstDirectChild(child, 'nvSpPr')
      const cNvPr = nvSpPr ? getFirstDirectChild(nvSpPr, 'cNvPr') : null
      const nvPr = nvSpPr ? getFirstDirectChild(nvSpPr, 'nvPr') : null
      const ph = nvPr ? getFirstDirectChild(nvPr, 'ph') : null
      const shapeId = getAttr(cNvPr, 'id') ?? `${shapesOut.length + 1}`
      const shapeName = getAttr(cNvPr, 'name') ?? ''
      const phType = getAttr(ph, 'type')
      const phIdx = getAttr(ph, 'idx')

      const isTitle = phType === 'title' || phType === 'ctrTitle'
      const isSubtitle = phType === 'subTitle'

      const spPr = getFirstDirectChild(child, 'spPr')
      const xfrm = spPr ? getFirstDirectChild(spPr, 'xfrm') : null
      const fallbackBBox: [number, number, number, number] = isTitle
        ? [0.06, 0.05, 0.94, 0.18]
        : [0.06, 0.22, 0.94, 0.85]
      const bbox = computeShapeNormalizedBBox(xfrm, parentMatrix, slideWidthEmu, slideHeightEmu, fallbackBBox)

      const txBody = getFirstDirectChild(child, 'txBody')
      const extracted = extractTxBodyContent(txBody, isTitle, isSubtitle)
      if (!extracted.text) continue

      shapesOut.push({
        shapeId,
        name: shapeName,
        placeholderType: phType,
        placeholderIdx: phIdx,
        blockType: extracted.blockType,
        text: extracted.text,
        markdown: extracted.markdown,
        bbox,
        ...(extracted.headingLevel ? { headingLevel: extracted.headingLevel } : {}),
      })
      continue
    }

    if (child.localName === 'graphicFrame') {
      const nvGraphicFramePr = getFirstDirectChild(child, 'nvGraphicFramePr')
      const cNvPr = nvGraphicFramePr ? getFirstDirectChild(nvGraphicFramePr, 'cNvPr') : null
      const shapeId = getAttr(cNvPr, 'id') ?? `${shapesOut.length + 1}`
      const shapeName = getAttr(cNvPr, 'name') ?? '图表'
      const xfrm = getFirstDirectChild(child, 'xfrm')
      const bbox = computeShapeNormalizedBBox(
        xfrm,
        parentMatrix,
        slideWidthEmu,
        slideHeightEmu,
        [0.08, 0.24, 0.92, 0.82],
      )

      const tblNode = findFirstElement(child, 'tbl')
      if (tblNode) {
        const tbl = extractDrawingTable(tblNode)
        if (tbl.text) {
          shapesOut.push({
            shapeId,
            name: shapeName,
            blockType: 'table',
            text: tbl.text,
            markdown: tbl.markdown,
            bbox,
            rowCount: tbl.rowCount,
            columnCount: tbl.columnCount,
          })
        }
        continue
      }

      const chartNode = findFirstElement(child, 'chart')
      if (chartNode) {
        shapesOut.push({
          shapeId,
          name: shapeName,
          blockType: 'figure',
          text: `[图表: ${shapeName}]`,
          markdown: `> **[图表]** ${shapeName}`,
          bbox,
        })
      }
      continue
    }

    if (child.localName === 'pic') {
      const nvPicPr = getFirstDirectChild(child, 'nvPicPr')
      const cNvPr = nvPicPr ? getFirstDirectChild(nvPicPr, 'cNvPr') : null
      const shapeId = getAttr(cNvPr, 'id') ?? `${shapesOut.length + 1}`
      const descr = getAttr(cNvPr, 'descr') || getAttr(cNvPr, 'name') || '幻灯片插图'
      const spPr = getFirstDirectChild(child, 'spPr')
      const xfrm = spPr ? getFirstDirectChild(spPr, 'xfrm') : null
      const bbox = computeShapeNormalizedBBox(
        xfrm,
        parentMatrix,
        slideWidthEmu,
        slideHeightEmu,
        [0.15, 0.25, 0.85, 0.80],
      )

      shapesOut.push({
        shapeId,
        name: descr,
        blockType: 'figure',
        text: `[图片: ${descr}]`,
        markdown: `![${descr}](slide-image)`,
        bbox,
      })
      continue
    }

    if (child.localName === 'cxnSp') {
      const nvCxnSpPr = getFirstDirectChild(child, 'nvCxnSpPr')
      const cNvPr = nvCxnSpPr ? getFirstDirectChild(nvCxnSpPr, 'cNvPr') : null
      const cNvCxnSpPr = nvCxnSpPr ? getFirstDirectChild(nvCxnSpPr, 'cNvCxnSpPr') : null
      const stCxn = cNvCxnSpPr ? getFirstDirectChild(cNvCxnSpPr, 'stCxn') : null
      const endCxn = cNvCxnSpPr ? getFirstDirectChild(cNvCxnSpPr, 'endCxn') : null

      const id = getAttr(cNvPr, 'id') ?? `cxn-${connectorsOut.length + 1}`
      const fromShapeId = getAttr(stCxn, 'id')
      const toShapeId = getAttr(endCxn, 'id')
      const txBody = getFirstDirectChild(child, 'txBody')
      const label = txBody ? extractTxBodyContent(txBody, false, false).text : undefined

      if (fromShapeId || toShapeId) {
        connectorsOut.push({
          id,
          fromShapeId,
          toShapeId,
          ...(label ? { label } : {}),
        })
      }
    }
  }
}

// ─── `p:timing` 动画因果树抽取 ───

function extractTimingOrderMap(slideRoot: XmlElement): Map<string, number> {
  const orderMap = new Map<string, number>()
  const timingNode = findFirstElement(slideRoot, 'timing')
  if (!timingNode) return orderMap

  let step = 0
  for (const spTgt of findElements(timingNode, 'spTgt')) {
    const spid = getAttr(spTgt, 'spid')
    if (spid && !orderMap.has(spid)) {
      orderMap.set(spid, step++)
    }
  }
  return orderMap
}

// ─── 形状确定性阅读顺序求解 (Title First + Y-Band `0.04 * H` + Timing DAG) ───

function sortSlideShapesDeterministically(
  shapes: RawSlideShape[],
  timingMap: Map<string, number>,
): RawSlideShape[] {
  const Y_BAND_TOLERANCE = 0.04

  return [...shapes].sort((a, b) => {
    const aIsTitle = a.placeholderType === 'title' || a.placeholderType === 'ctrTitle'
    const bIsTitle = b.placeholderType === 'title' || b.placeholderType === 'ctrTitle'
    if (aIsTitle !== bIsTitle) return aIsTitle ? -1 : 1

    const aIsSub = a.placeholderType === 'subTitle'
    const bIsSub = b.placeholderType === 'subTitle'
    if (aIsSub !== bIsSub) return aIsSub ? -1 : 1

    // 若两个形状均在 p:timing 动画序列中，优先尊重动画因果顺序
    const aTiming = timingMap.get(a.shapeId)
    const bTiming = timingMap.get(b.shapeId)
    if (aTiming !== undefined && bTiming !== undefined && aTiming !== bTiming) {
      return aTiming - bTiming
    }

    // Y-Band 分带（容差 0.04），同带内按 X 从左到右排列
    const dy = a.bbox[1] - b.bbox[1]
    if (Math.abs(dy) > Y_BAND_TOLERANCE) {
      return dy
    }
    return a.bbox[0] - b.bbox[0]
  })
}

// ─── 连接线拓扑转 Mermaid 流程图 ───

function buildMermaidFromConnectors(
  connectors: RawConnector[],
  shapes: RawSlideShape[],
): { mermaidCode: string; bbox: [number, number, number, number] } | null {
  if (connectors.length === 0) return null
  const shapeById = new Map(shapes.map((s) => [s.shapeId, s]))
  const edges: string[] = []
  const involvedShapes: RawSlideShape[] = []

  const sanitizeNodeLabel = (raw: string): string =>
    raw.replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, 32).trim() || '节点'

  for (const cxn of connectors) {
    if (!cxn.fromShapeId || !cxn.toShapeId) continue
    const fromShape = shapeById.get(cxn.fromShapeId)
    const toShape = shapeById.get(cxn.toShapeId)
    const fromLabel = fromShape ? sanitizeNodeLabel(fromShape.text) : `Shape_${cxn.fromShapeId}`
    const toLabel = toShape ? sanitizeNodeLabel(toShape.text) : `Shape_${cxn.toShapeId}`
    const edgeLabel = cxn.label ? `|"${sanitizeNodeLabel(cxn.label)}"|` : ''
    edges.push(`  S${cxn.fromShapeId}["${fromLabel}"] -->${edgeLabel} S${cxn.toShapeId}["${toLabel}"]`)
    if (fromShape) involvedShapes.push(fromShape)
    if (toShape) involvedShapes.push(toShape)
  }

  if (edges.length === 0) return null

  const bbox: [number, number, number, number] =
    involvedShapes.length > 0
      ? [
          clamp01(Math.min(...involvedShapes.map((s) => s.bbox[0]))),
          clamp01(Math.min(...involvedShapes.map((s) => s.bbox[1]))),
          clamp01(Math.max(...involvedShapes.map((s) => s.bbox[2]))),
          clamp01(Math.max(...involvedShapes.map((s) => s.bbox[3]))),
        ]
      : [0.1, 0.25, 0.9, 0.8]

  const mermaidCode = ['flowchart LR', ...edges].join('\n')
  return { mermaidCode, bbox }
}

// ─── 解析幻灯片有序路径与演讲者备注 ───

function resolveOrderedSlidePaths(zip: OoxmlZipReader): {
  slidePaths: string[]
  slideWidthEmu: number
  slideHeightEmu: number
} {
  let slideWidthEmu = DEFAULT_SLIDE_WIDTH_EMU
  let slideHeightEmu = DEFAULT_SLIDE_HEIGHT_EMU
  const presRoot = zip.readXml('ppt/presentation.xml')
  const rels = parseOoxmlRelationships(zip, 'ppt/_rels/presentation.xml.rels', 'ppt')
  const slidePaths: string[] = []

  if (presRoot) {
    const sldSz = findFirstElement(presRoot, 'sldSz')
    if (sldSz) {
      const cx = Number(getAttr(sldSz, 'cx'))
      const cy = Number(getAttr(sldSz, 'cy'))
      if (Number.isFinite(cx) && cx > 100000) slideWidthEmu = cx
      if (Number.isFinite(cy) && cy > 100000) slideHeightEmu = cy
    }

    const sldIdLst = findFirstElement(presRoot, 'sldIdLst')
    if (sldIdLst) {
      for (const sldId of getDirectChildren(sldIdLst, 'sldId')) {
        const rId = getAttr(sldId, 'r:id') ?? getAttr(sldId, 'id')
        const rel = rId ? rels.get(rId) : undefined
        if (rel && zip.has(rel.target)) {
          slidePaths.push(rel.target)
        }
      }
    }
  }

  if (slidePaths.length === 0) {
    const discovered = zip
      .listEntries()
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)\.xml$/i)?.[1] ?? '0', 10)
        const nb = parseInt(b.match(/slide(\d+)\.xml$/i)?.[1] ?? '0', 10)
        return na - nb
      })
    slidePaths.push(...discovered)
  }

  return { slidePaths, slideWidthEmu, slideHeightEmu }
}

function extractSpeakerNotes(zip: OoxmlZipReader, slidePath: string, slideNum: number): string {
  const slideFileName = slidePath.split('/').pop() ?? `slide${slideNum}.xml`
  const relsPath = `ppt/slides/_rels/${slideFileName}.rels`
  const rels = parseOoxmlRelationships(zip, relsPath, 'ppt/slides')

  let notesPath: string | undefined
  for (const rel of rels.values()) {
    if (rel.type.includes('notesSlide') && zip.has(rel.target)) {
      notesPath = rel.target
      break
    }
  }
  if (!notesPath) {
    const fallback = `ppt/notesSlides/notesSlide${slideNum}.xml`
    if (zip.has(fallback)) notesPath = fallback
  }
  if (!notesPath) return ''

  const notesRoot = zip.readXml(notesPath)
  if (!notesRoot) return ''

  const noteLines: string[] = []
  for (const sp of findElements(notesRoot, 'sp')) {
    const nvPr = findFirstElement(sp, 'nvPr')
    const ph = nvPr ? getFirstDirectChild(nvPr, 'ph') : null
    const phType = getAttr(ph, 'type')
    // 跳过页码占位符与页眉页脚
    if (phType === 'sldNum' || phType === 'hdr' || phType === 'ftr' || phType === 'dt') continue
    const txBody = getFirstDirectChild(sp, 'txBody')
    const { text } = extractTxBodyContent(txBody, false, false)
    if (text) noteLines.push(text)
  }

  return noteLines.join('\n').trim()
}

// ─── 主求解入口：`solvePptxTopology` ───

export function solvePptxTopology(
  zip: OoxmlZipReader,
  options: OfficeParseOptions = {},
): OfficeDocumentLayoutAST {
  const coreMeta = parseCoreMetadata(zip)
  const { slidePaths, slideWidthEmu, slideHeightEmu } = resolveOrderedSlidePaths(zip)
  const widthPt = Number(emuToPt(slideWidthEmu).toFixed(2))
  const heightPt = Number(emuToPt(slideHeightEmu).toFixed(2))

  const pages: OfficePageLayout[] = []
  let globalReadingOrder = 0
  const maxSlides = options.maxPages ?? slidePaths.length

  for (let idx = 0; idx < Math.min(slidePaths.length, maxSlides); idx++) {
    const slidePath = slidePaths[idx]!
    const slideNumber = idx + 1
    const slideRoot = zip.readXml(slidePath)
    if (!slideRoot) continue

    const spTree = findFirstElement(slideRoot, 'spTree') ?? slideRoot
    const rawShapes: RawSlideShape[] = []
    const rawConnectors: RawConnector[] = []

    collectShapesFromTree(
      spTree,
      IDENTITY_MATRIX,
      slideWidthEmu,
      slideHeightEmu,
      rawShapes,
      rawConnectors,
    )

    const timingMap = extractTimingOrderMap(slideRoot)
    const sortedShapes = sortSlideShapesDeterministically(rawShapes, timingMap)

    const blocks: OfficeLayoutBlock[] = []
    let slideTitle = ''

    for (const shape of sortedShapes) {
      if (!slideTitle && (shape.placeholderType === 'title' || shape.placeholderType === 'ctrTitle' || shape.headingLevel === 1)) {
        slideTitle = shape.text.split('\n')[0]!.trim().slice(0, 48)
      }

      const blockIdx = blocks.length + 1
      const shortDesc =
        shape.blockType === 'heading'
          ? shape.text.split('\n')[0]!.slice(0, 24)
          : shape.blockType === 'table'
            ? '表格'
            : shape.blockType === 'figure'
              ? shape.name.slice(0, 20) || '图示'
              : slideTitle || shape.text.slice(0, 18) || '要点'

      blocks.push({
        id: `p${slideNumber}-b${blockIdx}`,
        pageNumber: slideNumber,
        type: shape.blockType,
        text: shape.text,
        markdown: shape.markdown,
        bbox: shape.bbox,
        locLabel: `幻灯片${slideNumber}·${shortDesc}`,
        readingOrder: globalReadingOrder++,
        ...(shape.headingLevel ? { headingLevel: shape.headingLevel } : {}),
        ...(shape.rowCount ? { rowCount: shape.rowCount } : {}),
        ...(shape.columnCount ? { columnCount: shape.columnCount } : {}),
      })
    }

    // 若存在连接线拓扑，合成 Mermaid 流程图块
    const mermaidDiagrams: string[] = []
    const connectorMermaid = buildMermaidFromConnectors(rawConnectors, sortedShapes)
    if (connectorMermaid) {
      mermaidDiagrams.push(connectorMermaid.mermaidCode)
      const blockIdx = blocks.length + 1
      blocks.push({
        id: `p${slideNumber}-b${blockIdx}`,
        pageNumber: slideNumber,
        type: 'figure',
        text: `[流程图拓扑]\n${connectorMermaid.mermaidCode}`,
        markdown: `\`\`\`mermaid\n${connectorMermaid.mermaidCode}\n\`\`\``,
        bbox: connectorMermaid.bbox,
        locLabel: `幻灯片${slideNumber}·架构流程图`,
        readingOrder: globalReadingOrder++,
      })
    }

    // 演讲者备注
    const speakerNotes = extractSpeakerNotes(zip, slidePath, slideNumber)
    if (speakerNotes) {
      const blockIdx = blocks.length + 1
      blocks.push({
        id: `p${slideNumber}-b${blockIdx}`,
        pageNumber: slideNumber,
        type: 'footer',
        text: `演讲者备注：${speakerNotes}`,
        markdown: `> **演讲者备注**：${speakerNotes.replace(/\n+/g, ' ')}`,
        bbox: [0.05, 0.88, 0.95, 0.98],
        locLabel: `幻灯片${slideNumber}·演讲者备注`,
        readingOrder: globalReadingOrder++,
      })
    }

    pages.push({
      pageNumber: slideNumber,
      widthPt,
      heightPt,
      ...(slideTitle ? { title: slideTitle } : {}),
      blocks,
      ...(mermaidDiagrams.length > 0 ? { mermaidDiagrams } : {}),
    })
  }

  const presTitle = coreMeta.title || pages[0]?.title

  return {
    format: 'pptx',
    pageCount: pages.length,
    pages,
    metadata: {
      ...(presTitle ? { title: presTitle } : {}),
      ...(coreMeta.author ? { author: coreMeta.author } : {}),
    },
  }
}
