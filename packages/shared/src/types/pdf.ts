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

// ===== 递归数学语法树（对齐 OOXML m:oMath 表达力）=====
//
// 只描述数据形状，构建与 LaTeX 序列化逻辑位于 @profer/core 的 math-ast-builder。
// 放在 shared 的原因：LayoutEquation 需引用 MathNode，而 shared 不得反向依赖 core。

/** 数学符号的排版变体（决定序列化时是否加 `\mathbb{}` 等修饰） */
export type MathSymbolVariant = 'italic' | 'normal' | 'operator' | 'greek' | 'bb'

/** 可叠加在表达式上的重音/修饰符 */
export type MathAccent = 'hat' | 'bar' | 'vec' | 'tilde' | 'dot' | 'ddot' | 'overline'

export type MathNode =
  /** 水平序列（对应 m:r 的容器） */
  | { type: 'row'; children: MathNode[] }
  /** 单个变量/标识符 */
  | { type: 'symbol'; text: string; variant?: MathSymbolVariant }
  /** 数字面量 */
  | { type: 'number'; text: string }
  /** 运算符 / 关系符 */
  | { type: 'op'; text: string }
  /** 普通文本（\text{}） */
  | { type: 'text'; text: string }
  /** 分式（m:f） */
  | { type: 'fraction'; numerator: MathNode; denominator: MathNode }
  /** 下标（m:sSub） */
  | { type: 'sub'; base: MathNode; sub: MathNode }
  /** 上标（m:sSup） */
  | { type: 'sup'; base: MathNode; sup: MathNode }
  /** 上下标同时（m:sSubSup） */
  | { type: 'subSup'; base: MathNode; sub?: MathNode; sup?: MathNode }
  /** 根式（m:rad） */
  | { type: 'radical'; radicand: MathNode; degree?: MathNode }
  /** 求和 / 积分等带上下限的 n 元运算（m:nary） */
  | { type: 'nary'; operator: string; sub?: MathNode; sup?: MathNode; body: MathNode }
  /** 矩阵（m:m） */
  | { type: 'matrix'; rows: MathNode[][]; leftDelim: string; rightDelim: string }
  /** 分段函数 / 方程组 */
  | { type: 'cases'; rows: Array<{ left: MathNode; right?: MathNode }> }
  /** 带定界符的子表达式（m:d） */
  | { type: 'delim'; left: string; right: string; body: MathNode }
  /** 重音修饰 */
  | { type: 'accent'; base: MathNode; accent: MathAccent }

/** 公式还原来源（metrics 中按此分账，绝不混淆） */
export type EquationSource = 'native' | 'geometric' | 'pix2text'

/** 公式复杂度评级（决定是否送视觉 OCR 兜底） */
export type EquationComplexity = 'simple' | 'high'

/** 结构化公式模型 */
export interface LayoutEquation {
  equationId: string
  latex: string
  tag?: string          // 公式编号，如 (1), (2.3)
  bbox: NormalizedBBox
  /** 全要素公式语法树（可由 serializeMathAstToLatex 重算 LaTeX） */
  mathAst?: MathNode
  /** 还原来源 */
  source?: EquationSource
  /** 复杂度评级 */
  complexity?: EquationComplexity
}

// ===== 论文解析准度（面向最终用户的三档选择，文案零技术术语） =====

export type PdfParseAccuracy = 'fast' | 'balanced' | 'thorough'

export interface PdfParseAccuracyOption {
  value: PdfParseAccuracy
  /** 用户看到的名称 */
  label: string
  /** 用户看到的说明（大白话，禁止出现 OCR/Pix2Text/LaTeX 等术语） */
  description: string
}

export const PDF_PARSE_ACCURACY_OPTIONS: readonly PdfParseAccuracyOption[] = [
  {
    value: 'fast',
    label: '快速',
    description: '几秒钟就好，个别复杂公式的还原可能略有出入',
  },
  {
    value: 'balanced',
    label: '均衡（推荐）',
    description: '速度和准确度都照顾到，日常读论文足够',
  },
  {
    value: 'thorough',
    label: '精细',
    description: '最准确，但会慢一些；公式特别多的论文选它',
  },
] as const

export const PDF_PARSE_ACCURACY_DEFAULT: PdfParseAccuracy = 'balanced'

/** 切换准度后的固定提示语（非技术语言） */
export const PDF_PARSE_ACCURACY_HINT = '改完之后重新解析文档才会生效'

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
  /** 该块所在分栏区域的栏数（跨栏通栏块恒为 1），用于聚光灯锚点渲染「左栏/中栏/右栏/通栏」 */
  columnCount?: number
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
    /** 视觉公式识别的实际调用次数 */
    formulaOcrCalls: number
    /** 因未达复杂度阈值或超出配额而跳过视觉识别的公式数 */
    formulaOcrSkipped: number
    /** 走整页 OCR 重构的降级页数 */
    ocrRecognizedPages: number
    /** 检测到降级但 OCR 端口不可用的页数（如实记录，绝不伪造） */
    ocrUnavailablePages: number
    /** 扫描到的原生 MathML/TeX 关联标签数 */
    nativeMathTagCount: number
    /** 公式来源分账 */
    mathFromNative: number
    mathFromGeometric: number
    mathFromPix2Text: number
    /** 水平分带总数（供诊断分栏拓扑） */
    bandCount: number
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
