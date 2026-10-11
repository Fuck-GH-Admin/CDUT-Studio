/**
 * 全要素文档 AST 与 PDF 解析引擎输入输出契约
 *
 * 对应设计文档：
 * - .trae/documents/aaadddnext_gen_pdf_parser_plan.md（顶层架构）
 * - .trae/documents/aaabbbnext_gen_pdf_parser_detailed_implementation.md（工程实现规格）
 *
 * 定位：本文件只描述「数据形状」，不引入任何解析逻辑，供 @profer/core 引擎
 * 与主进程服务层（document-parser / review document-service）共享消费。
 */

/**
 * 几何边界框：归一化坐标 [x0, y0, x1, y1]，取值范围 0.0 ~ 1.0 (相对于页面宽高)
 * 原点 (0, 0) 为页面左上角，(1, 1) 为右下角
 */
export type NormalizedBBox = [x0: number, y0: number, x1: number, y1: number]

/**
 * 绝对点坐标框：以 PDF Points (72 dpi) 为基准。
 * 与 NormalizedBBox 保持同一朝向（左上角原点、y 轴向下），便于线性归一化。
 */
export type PointBBox = [x0: number, y0: number, x1: number, y1: number]

/** 版面区域类别 (兼容 RT-DocLayout 预测类别) */
export type LayoutRegionKind =
  | 'title'             // 论文总标题
  | 'section-heading'   // 章节标题 (如 1. Introduction)
  | 'paragraph'         // 正文段落
  | 'table'             // 表格区域
  | 'figure'            // 插图/图表位图
  | 'equation'          // 独立行间公式
  | 'header'            // 页眉
  | 'footer'            // 页脚
  | 'footnote'          // 文末/页脚脚注
  | 'list-item'         // 列表条目

/** 表格结构化单元格 */
export interface LayoutTableCell {
  rowIndex: number
  columnIndex: number
  rowSpan: number
  colSpan: number
  isHeader: boolean
  text: string
  bbox: NormalizedBBox
}

/** 结构化表格模型 */
export interface LayoutTableStructure {
  rowCount: number
  columnCount: number
  headers: string[]
  cells: LayoutTableCell[]
  markdown: string
  caption?: string
}

/** 结构化公式模型 */
export interface LayoutEquation {
  equationId: string
  latex: string
  tag?: string          // 公式编号，如 (1), (2.3)
  bbox: NormalizedBBox
}

/** 基础结构化排版块 (AST 核心节点) */
export interface DocumentLayoutBlock {
  id: string
  pageNumber: number
  kind: LayoutRegionKind
  text: string
  bbox: NormalizedBBox
  readingOrderIndex: number      // Max-Regret 求解后的全局顺序序号
  readingStreamId: number        // 所属逻辑阅读流 ID (例如分栏时为栏 ID)
  confidence: number             // 置信度 0.0 ~ 1.0
  headingLevel?: number          // 标题级别 1~6
  table?: LayoutTableStructure   // 当 kind === 'table' 时存在
  equation?: LayoutEquation      // 当 kind === 'equation' 时存在
  footnoteRef?: string           // 正文引用脚注的 anchor 标识
  isOcrRecognized?: boolean      // 是否来源于专用 OCR 信道
}

/** 单页排版模型 */
export interface DocumentLayoutPage {
  pageNumber: number
  width: number
  height: number
  columnCount: number            // 算法探测出的栏数 (1, 2, 3)
  blocks: DocumentLayoutBlock[]
  trappedTokensFiltered: number  // 本页过滤的 TrapDoc 幽灵字符数
}

/** 全要素文档 AST 根对象 */
export interface DocumentLayoutAST {
  fileName: string
  pageCount: number
  pages: DocumentLayoutPage[]
  readingOrderedBlocks: DocumentLayoutBlock[]  // 全文展平的线性阅读序列
  outline: Array<{ title: string; level: number; blockId: string; page: number }>
  markdown: string               // 序列化后的高保真学术 Markdown 文本
  metrics: {
    totalExtractionMs: number
    alignmentMs: number
    maxRegretSortMs: number
    tableParseMs: number
    trapDocFilteredCount: number
  }
}

// ===== 坐标换算工具（纯函数，引擎与服务层共用） =====

/** 把点坐标框按页面尺寸归一化并夹取到 [0, 1] 区间 */
export function normalizePointBBox(bbox: PointBBox, pageWidth: number, pageHeight: number): NormalizedBBox {
  const safeWidth = pageWidth > 0 ? pageWidth : 1
  const safeHeight = pageHeight > 0 ? pageHeight : 1
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
  return [
    clamp01(bbox[0] / safeWidth),
    clamp01(bbox[1] / safeHeight),
    clamp01(bbox[2] / safeWidth),
    clamp01(bbox[3] / safeHeight),
  ]
}
