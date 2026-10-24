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
import type { PdfOcrPorts } from './ocr-bridge'

/**
 * PDF 内嵌的原生数学标签（/AF 关联文件）。
 * 由上层对原始 PDF 对象尽力扫描得到；绝大多数论文不内嵌，故可缺省。
 */
export interface NativeMathTag {
  format: 'mathml' | 'tex'
  content: string
  /** 可能关联的页码（扫描无法精确定位时缺省） */
  pageNumber?: number
}

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

/** 页面矢量线段（由 PDF 绘制指令解析；用于三线表边框探测与分式横线重构） */
export interface VectorLine {
  x0: number
  y0: number
  x1: number
  y1: number
  isHorizontal: boolean
  thickness: number
}

/**
 * 页面文本层健康度（纯扫描件 / ToUnicode 缺失乱码页的降级判据）。
 * 检测到降级时由上层决定是否调度本地学术 OCR 重构，绝不伪造识别结果。
 */
export interface PageTextHealth {
  glyphCount: number
  /** 乱码占比：(U+FFFD / U+FFFE / 私用区 PUA) 字符数 / 总字符数 */
  garbledRatio: number
  isPageDegraded: boolean
  reason?: 'no-text-layer' | 'garbled-encoding'
}

/**
 * StructTree 角色摘要（页面/文档级先验）。
 *
 * 诚实声明：pdfjs 4.x 的 getStructTree 只暴露角色与内容 id，id 无法映射回字形流，
 * 故仅作置信度先验，不伪造块级归属。
 */
export interface StructTreeSummary {
  available: boolean
  roleCounts: Record<string, number>
  /** 角色为 Formula / Math 的元素数 */
  formulaRoleCount: number
}

/** 单页几何图元集合 */
export interface PdfPageGeometry {
  pageNumber: number
  width: number
  height: number
  glyphs: PdfGlyphItem[]
  vectorLines: VectorLine[]
  /** 文本层健康度（缺省视为健康） */
  health?: PageTextHealth
  /** StructTree 角色摘要（缺省视为不可用） */
  structTree?: StructTreeSummary
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
  /** 该块所在分栏区域的栏数（跨栏通栏块恒为 1） */
  columnCount?: number
  /** 节点主字号（Points），用于脚注/标题级别等学术增强判定 */
  fontSize?: number
  /** 块内对齐后的原始字符图元（供行内公式与上下标几何逆求；序列化文本仍以 text 为准） */
  glyphs?: PdfGlyphItem[]
  headingLevel?: number
  table?: LayoutTableStructure
  equation?: LayoutEquation
  footnoteRef?: string
  isOcrRecognized?: boolean
}

/**
 * 公式视觉识别的解析档位配置（由用户准度偏好映射而来）。
 * 纯契约：core 不感知用户偏好存储，只按配置执行。
 */
export interface FormulaModeConfig {
  /** 是否允许把高复杂度公式送视觉识别兜底 */
  enableFormulaOcr: boolean
  /** 复杂度触发阈值（归一化高度 ÷ 行高 的倍数） */
  complexityThreshold: number
  /** 单文档视觉识别调用上限 */
  maxFormulaOcrCalls: number
}

export const FORMULA_MODE_DEFAULT: FormulaModeConfig = {
  enableFormulaOcr: true,
  complexityThreshold: 2.5,
  maxFormulaOcrCalls: 12,
}

/** 引擎配置 */
export interface PdfEngineOptions {
  fileName?: string
  /** 最大解析页数（防止超长文档阻塞主线程），默认不限制 */
  maxPages?: number
  /** 是否启用专用 OCR 信道桥接（需注入 ocrPorts 才真正生效） */
  enableOcrBridge?: boolean
  /** OCR 端口集合（由上层注入，core 不绑定任何具体 OCR 引擎） */
  ocrPorts?: PdfOcrPorts
  /** 公式解析档位（缺省用 FORMULA_MODE_DEFAULT） */
  formulaMode?: FormulaModeConfig
  /** 原生 MathML/TeX 关联标签（由上层预扫描后注入，可缺省） */
  nativeMathTags?: NativeMathTag[]
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
  if (node.columnCount !== undefined) block.columnCount = node.columnCount
  if (node.table !== undefined) block.table = node.table
  if (node.equation !== undefined) block.equation = node.equation
  if (node.footnoteRef !== undefined) block.footnoteRef = node.footnoteRef
  if (node.isOcrRecognized !== undefined) block.isOcrRecognized = node.isOcrRecognized
  return block
}
