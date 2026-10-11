/**
 * PDF 高精解析引擎 - 引擎内部数据类型
 *
 * 本文件只承载引擎内部流转的数据结构（字符图元、矢量线段、图节点、引擎配置），
 * 对外的全要素文档 AST 契约定义在 `@profer/shared` 的 types/pdf.ts。
 *
 * 坐标系约定：
 * - PointBBox：PDF Points (72 dpi)，左上角为原点，y 轴向下（与页面归一化坐标同向）
 * - NormalizedBBox：除以页面宽高后的 0.0 ~ 1.0 坐标
 */

import type {
  DocumentLayoutBlock,
  PointBBox,
  NormalizedBBox,
  LayoutRegionKind,
  LayoutTableStructure,
  LayoutEquation,
} from '@profer/shared'

/** 单个字符图元（由 pdfjs 文本项的变换矩阵与宽度切分而来） */
export interface PdfGlyphItem {
  char: string
  fontName: string
  fontSize: number
  originX: number
  originY: number
  width: number
  height: number
  bbox: PointBBox             // [x0, y0, x1, y1] PDF 绝对坐标（左上角原点）
  renderingMode: number       // 0: Fill, 1: Stroke, 2: Fill+Stroke, 3: Invisible (Neither)
  colorAlpha: number          // 0.0 ~ 1.0
  isOutOfCanvas: boolean
}

/** 页面矢量线段（由 PDF 绘制指令解析；用于三线表边框探测） */
export interface VectorLine {
  x0: number
  y0: number
  x1: number
  y1: number
  isHorizontal: boolean
  thickness: number
}

/** 单页几何图元集合 */
export interface PdfPageGeometry {
  pageNumber: number
  width: number
  height: number
  glyphs: PdfGlyphItem[]
  vectorLines: VectorLine[]
}

/** 字符流提取结果 */
export interface PdfGeometryExtractResult {
  pages: PdfPageGeometry[]
  pageCount: number
  extractMs: number
}

/**
 * 版面候选框（分段器产出的几何区域，尚未绑定字符）
 * 供 Category D 二部图对齐消费。
 */
export interface LayoutCandidateBox {
  id: string
  bbox: PointBBox
  /** 版式初判类别（对齐后仍会在 enricher 中二次校正） */
  kindHint: LayoutRegionKind
  /** 该区域主字号（用于标题级别/脚注判定） */
  fontSize: number
}

/**
 * 版面节点：候选框绑定字符后的图节点，是 Max-Regret 路由的输入单元。
 */
export interface LayoutNode {
  id: string
  pageNumber: number
  kind: LayoutRegionKind
  text: string
  /** 归一化边界框 */
  bbox: NormalizedBBox
  /** 绝对点坐标框 */
  pointBbox: PointBBox
  confidence: number
  readingStreamId: number
  readingOrderIndex: number
  /** 节点主字号（Points），用于脚注/标题级别等学术增强判定 */
  fontSize?: number
  headingLevel?: number
  table?: LayoutTableStructure
  equation?: LayoutEquation
  footnoteRef?: string
  isOcrRecognized?: boolean
}

/** 引擎配置 */
export interface PdfEngineOptions {
  fileName?: string
  /** 最大解析页数（防止超长文档阻塞主线程），默认不限制 */
  maxPages?: number
  /** 是否启用专用 OCR 信道桥接（需注入 ocrPort 才真正生效） */
  enableOcrBridge?: boolean
}

/** 把内部 LayoutNode 转为对外契约 DocumentLayoutBlock */
export function toDocumentLayoutBlock(node: LayoutNode): DocumentLayoutBlock {
  const block: DocumentLayoutBlock = {
    id: node.id,
    pageNumber: node.pageNumber,
    kind: node.kind,
    text: node.text,
    bbox: node.bbox,
    readingOrderIndex: node.readingOrderIndex,
    readingStreamId: node.readingStreamId,
    confidence: node.confidence,
  }
  if (node.headingLevel !== undefined) block.headingLevel = node.headingLevel
  if (node.table !== undefined) block.table = node.table
  if (node.equation !== undefined) block.equation = node.equation
  if (node.footnoteRef !== undefined) block.footnoteRef = node.footnoteRef
  if (node.isOcrRecognized !== undefined) block.isOcrRecognized = node.isOcrRecognized
  return block
}
