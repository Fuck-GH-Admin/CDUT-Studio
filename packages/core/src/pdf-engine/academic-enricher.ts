/**
 * 学术论文特征增强（AcademicEnricher）
 *
 * 在对齐 + 路由之后，对节点做学术论文专属的语义校正：
 * 1. 行间公式：居中排版 + 含数学符号 + 右侧编号 → kind 'equation'，
 *    并由几何二维 Math AST 递归重构为标准 LaTeX（不再是「原文冒充 latex」）；
 * 2. 行内公式：段落内斜体变量、数学符号、升降位上下标就地包裹 `$...$`；
 * 3. 页眉/页脚分离：Y ≤ 0.06 / Y ≥ 0.94 打上 readingStreamId = -1，不进入主正文流；
 * 4. 脚注关联：接近页底且字号明显小于正文 → kind 'footnote'，抽取上标编号作为 anchor；
 * 5. 标题级别：按编号点分层级（3.1 → level 3）。
 *
 * 注意：页眉/页脚的剥离必须先于水平分带（见 max-regret-router.filterBodyNodes），
 * 否则页眉页脚会被误判为跨栏通栏块，切出碎片带并污染栏位投影直方图。
 */

import type { LayoutEquation, NormalizedBBox } from '@profer/shared'
import type { NativeMathTag, PdfGlyphItem, LayoutNode, VectorLine } from './types'
import {
  buildMathAst,
  hasBalancedBraces,
  mathmlToLatex,
  normalizeMathSymbols,
  serializeMathAstToLatex,
} from './math-ast-builder'

/** 页眉/页脚判定的归一化 Y 阈值 */
export const HEADER_Y_MAX = 0.06
export const FOOTER_Y_MIN = 0.94
/** 页眉/页脚硬核安全阀：极短文本 + 极低物理高度，二者必须同时满足 */
export const HEADER_FOOTER_MAX_CHARS = 120
export const HEADER_FOOTER_MAX_HEIGHT_RATIO = 0.035
/** 脚注判定：接近页底 + 字号小于正文 */
export const FOOTNOTE_Y_MIN = 0.88
export const FOOTNOTE_FONT_RATIO = 0.92

/** 行间公式特征：数学符号 / LaTeX 控制字 / 关系运算符 */
const MATH_SYMBOL_PATTERN = /[=∑∫∏√±×÷≤≥≠≈∞∂αβγδθλμπσφψω∇∈∀∃⇒⇔→←↔]|\\[a-zA-Z]+/

/** 公式右侧编号，如 (1)、(2.3) */
const EQUATION_TAG_PATTERN = /\((\d+(?:\.\d+)*)\)\s*$/

/** 行内公式探测的强信号：数学符号 / 希腊字母 / 数集字母（刻意不含 ^ _ ，避免误伤普通下划线标识符） */
const INLINE_MATH_STRONG_PATTERN = /[=<>≤≥≠≈±×÷⋅·∞∂∇∈∉∀∃⇒⇔→←↔⊂⊆⊃⊇∪∩∫∑∏√αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩℝℕℤℚℂ]/

/** 斜体字体名特征（用于识别排版变量） */
const ITALIC_FONT_PATTERN = /italic|\bit\b|-it|mti|obi|cmmi|cmmib|cmsy/i

/** 含 ≥4 个连续字母的 token 视为自然语言单词，不并入行内公式 */
const PROSE_WORD_PATTERN = /[A-Za-z]{4,}/

/** 跨空格扩展时，只有「看起来像数学」的短 token 才被并入公式 */
function looksLikeMathToken(token: string): boolean {
  if (token.length === 0 || token.length > 6) return false
  if (PROSE_WORD_PATTERN.test(token)) return false
  if (INLINE_MATH_STRONG_PATTERN.test(token)) return true
  if (/^[A-Za-z]$/.test(token)) return true // 单字母变量
  if (/^[\d]+([.,][\d]+)?$/.test(token)) return true // 数字
  if (/^[A-Za-z]\d$/.test(token)) return true // x2 这类紧凑记号
  return false
}

export interface AcademicEnrichOptions {
  /** 正文字号（点），缺省则由节点字号中位数推断 */
  bodyFontSize?: number
  pageWidth?: number
  pageHeight?: number
  /** 该节点集合所属页码 */
  pageNumber: number
  /**
   * 页面矢量线段。
   *
   * 分式横线与根式上划线的重构完全依赖它；不传就无法合成 `\frac` / `\sqrt`，
   * 调用方（pdf-engine）必须从 geometry.vectorLines 透传。
   */
  vectorLines?: readonly VectorLine[]
  /** 正文行高（归一化），用于公式复杂度评级；缺省按节点高度中位数推断 */
  lineHeight?: number
  /** 原生 MathML/TeX 关联标签（可缺省；命中时优先于几何逆求） */
  nativeMathTags?: readonly NativeMathTag[]
}

/** 推断正文字号（出现次数最多的字号，即众数） */
function inferBodyFontSize(nodes: readonly LayoutNode[]): number {
  const histogram = new Map<number, number>()
  for (const node of nodes) {
    if (node.fontSize && node.fontSize > 0) {
      const key = Math.round(node.fontSize)
      histogram.set(key, (histogram.get(key) ?? 0) + 1)
    }
  }
  let best = 0
  let bestCount = -1
  for (const [size, count] of histogram) {
    if (count > bestCount) {
      bestCount = count
      best = size
    }
  }
  return best
}

/** 图注 / 坐标轴标签特征：即便居中或带编号，也绝不是公式（不锚定行首，图注常多段拼接） */
const CAPTION_PATTERN = /[\s([（][a-dA-D]\)|\bFig(?:ure)?\.?\s*\d|\bTable\s*\d|\[[a-zA-Z]{1,3}\]/

/** 公式里不应出现成串自然语言单词（≥2 个 3 字母以上单词即判为图注/正文） */
function hasProseWords(text: string): boolean {
  return (text.match(/[A-Za-z]{3,}/g) ?? []).length >= 2
}

/** 判断行间公式：居中 + 含数学符号 / 带编号 + 含数学符号 / 含分数线 */
function looksLikeEquation(node: LayoutNode, vectorLines: readonly VectorLine[] = []): boolean {
  const text = node.text.trim()
  if (text.length === 0 || text.length > 200) return false
  if (CAPTION_PATTERN.test(text)) return false
  if (hasProseWords(text)) return false
  const centerX = (node.bbox[0] + node.bbox[2]) / 2
  const centered = Math.abs(centerX - 0.5) <= 0.12
  const hasTag = EQUATION_TAG_PATTERN.test(text)
  const hasMath = MATH_SYMBOL_PATTERN.test(text)
  // 必须含真实数学符号：仅凭「居中 + 编号」会把 `. (16)` 这类残行误判为公式
  if (hasMath && (centered || hasTag)) return true
  // 纯分式 / 根式：没有数学符号，但区域内存在横向分数线或上划线
  if (centered && hasHorizontalBar(node, vectorLines)) return true
  return false
}

/** 该块区域内是否存在横向矢量线（分数线 / 根式上划线） */
function hasHorizontalBar(node: LayoutNode, vectorLines: readonly VectorLine[]): boolean {
  return vectorLines.some((line) => {
    if (!line.isHorizontal) return false
    const y = (line.y0 + line.y1) / 2
    return (
      line.x1 >= node.pointBbox[0] &&
      line.x0 <= node.pointBbox[2] &&
      y >= node.pointBbox[1] &&
      y <= node.pointBbox[3]
    )
  })
}

/** 从章节编号推断标题级别，如 "3.1 Methods" → 3（受限于 1~6） */
export function inferHeadingLevel(text: string): number {
  const match = /^(\d+(?:\.\d+){0,3})/.exec(text.trim())
  if (!match) return 2
  const depth = (match[1] ?? '').split('.').length
  return Math.min(6, Math.max(1, depth))
}

/**
 * 判断块是否为真正的页眉（三重硬核防护）：
 * 1. 物理位置位于页面极顶（y0 <= HEADER_Y_MAX）；
 * 2. 文本长度很短（通常 <= 120 字符）；
 * 3. 几何高度很低（归一化高度 <= 0.035）。
 * 严禁将多行长段落或字数超过 120 字的内容归类为页眉！
 */
function isGenuineHeader(node: LayoutNode): boolean {
  const y0 = node.bbox[1]
  const heightRatio = node.bbox[3] - node.bbox[1]
  const textLength = node.text.trim().length
  if (y0 > HEADER_Y_MAX) return false
  return textLength <= HEADER_FOOTER_MAX_CHARS && heightRatio <= HEADER_FOOTER_MAX_HEIGHT_RATIO
}

/** 判断块是否为真正的页脚（同三重硬核防护，位置改为页面极底 y1 >= FOOTER_Y_MIN） */
function isGenuineFooter(node: LayoutNode): boolean {
  const y1 = node.bbox[3]
  const heightRatio = node.bbox[3] - node.bbox[1]
  const textLength = node.text.trim().length
  if (y1 < FOOTER_Y_MIN) return false
  return textLength <= HEADER_FOOTER_MAX_CHARS && heightRatio <= HEADER_FOOTER_MAX_HEIGHT_RATIO
}

// ===== 公式复杂度评级（决定是否送视觉 OCR 兜底） =====

export interface FormulaComplexityInput {
  /** 公式块高度（归一化） */
  height: number
  /** 正文行高（归一化） */
  lineHeight: number
  /** 区域内分数线 / 上划线数量 */
  barCount: number
  /** 是否命中矩阵 / 多行对齐特征 */
  hasGrid: boolean
  /** 触发阈值倍数（来自用户准度档位） */
  threshold: number
}

/**
 * 公式复杂度评级：高度、分数线数量、二维网格任一命中即判 'high'。
 */
export function rateFormulaComplexity(input: FormulaComplexityInput): 'simple' | 'high' {
  const lineHeight = input.lineHeight > 0 ? input.lineHeight : 0.03
  const heightRatio = input.height / lineHeight
  if (heightRatio > input.threshold) return 'high'
  if (input.barCount >= 2) return 'high'
  if (input.hasGrid) return 'high'
  return 'simple'
}

// ===== 行内公式探测 =====

interface MathRun {
  start: number
  end: number // 不含
  text: string
}

/** 字形序列 → 行内公式区间（含必要的左右扩展） */
function detectInlineMathRuns(
  glyphs: readonly PdfGlyphItem[],
  rawText: string,
  bodyFontSize: number,
): MathRun[] {
  if (glyphs.length === 0) return []
  const chars = Array.from(rawText)

  // 1. 逐字形打分
  const strong = new Array<boolean>(glyphs.length).fill(false)
  for (let i = 0; i < glyphs.length; i += 1) {
    const glyph = glyphs[i]!
    const char = glyph.char
    if (INLINE_MATH_STRONG_PATTERN.test(char)) {
      strong[i] = true
      continue
    }
    // 上下标：小字号 + 明显升降位
    const isScriptSize = bodyFontSize > 0 && glyph.fontSize <= bodyFontSize * 0.85
    const baselineShift = bodyFontSize > 0 && Math.abs(glyph.originY - estimateBaseline(glyphs, bodyFontSize)) > bodyFontSize * 0.22
    if (isScriptSize && baselineShift) {
      strong[i] = true
      continue
    }
    // 斜体排版变量（单字母，非自然语言单词）
    if (ITALIC_FONT_PATTERN.test(glyph.fontName) && /^[A-Za-z]$/.test(char)) {
      strong[i] = true
    }
  }
  if (!strong.some(Boolean)) return []

  // 2. 强信号扩边：先吸收同一词内的相邻字形，再跨单空格吸收「看起来像数学」的短 token
  const inMath = [...strong]
  const isSeparator = (index: number): boolean => /\s/.test(chars[index] ?? ' ')

  // 2a. 词内相邻字形（xi2、a+b 这类紧凑记号必须整体成式）
  for (let i = 0; i < glyphs.length; i += 1) {
    if (!strong[i]) continue
    for (let j = i - 1; j >= 0 && !isSeparator(j); j -= 1) inMath[j] = true
    for (let j = i + 1; j < glyphs.length && !isSeparator(j); j += 1) inMath[j] = true
  }

  // 2b. 跨单空格吸收短的数学 token（p < 0.05、α ∈ ℝ）
  for (let i = 0; i < glyphs.length; i += 1) {
    if (!strong[i]) continue
    for (let j = i - 1; j >= 0; j -= 1) {
      if (inMath[j]) continue
      if (!isSeparator(j)) break
      let k = j - 1
      while (k >= 0 && !isSeparator(k)) k -= 1
      const token = chars.slice(k + 1, j).join('')
      if (!looksLikeMathToken(token)) break
      for (let m = k + 1; m <= j; m += 1) inMath[m] = true
    }
    for (let j = i + 1; j < glyphs.length; j += 1) {
      if (inMath[j]) continue
      if (!isSeparator(j)) break
      let k = j + 1
      while (k < glyphs.length && !isSeparator(k)) k += 1
      const token = chars.slice(j + 1, k).join('')
      if (!looksLikeMathToken(token)) break
      for (let m = j; m < k; m += 1) inMath[m] = true
      j = k - 1
    }
  }

  // 3. 收敛为连续区间
  const runs: MathRun[] = []
  let start = -1
  for (let i = 0; i <= glyphs.length; i += 1) {
    const active = i < glyphs.length && inMath[i]!
    if (active && start < 0) start = i
    if (!active && start >= 0) {
      runs.push({ start, end: i, text: chars.slice(start, i).join('').trim() })
      start = -1
    }
  }
  return runs.filter((run) => run.text.length > 0 && !PROSE_WORD_PATTERN.test(run.text))
}

/** 估算主基线：取主字号字形 originY 的中位数 */
function estimateBaseline(glyphs: readonly PdfGlyphItem[], bodyFontSize: number): number {
  const main = glyphs
    .filter((glyph) => bodyFontSize > 0 && glyph.fontSize > bodyFontSize * 0.85)
    .map((glyph) => glyph.originY)
  const pool = main.length > 0 ? main : glyphs.map((glyph) => glyph.originY)
  if (pool.length === 0) return 0
  const sorted = [...pool].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * 行内公式就地包裹：在 `node.text` 中插入 `$...$`。
 *
 * 依赖「group.text 与 group.glyphs 严格同序」（source-preserving-aligner 的保证），
 * 因此按下标插标记绝不会错位。
 */
export function annotateInlineMath(
  node: LayoutNode,
  options: { bodyFontSize: number; vectorLines?: readonly VectorLine[]; pageWidth: number; pageHeight: number },
): void {
  const glyphs = node.glyphs ?? []
  if (glyphs.length === 0) return
  const rawText = glyphs.map((glyph) => glyph.char).join('')
  const runs = detectInlineMathRuns(glyphs, rawText, options.bodyFontSize)
  if (runs.length === 0) return

  const chars = Array.from(rawText)
  const parts: string[] = []
  let cursor = 0
  for (const run of runs) {
    if (run.start > cursor) parts.push(chars.slice(cursor, run.start).join(''))
    const runGlyphs = glyphs.slice(run.start, run.end)
    let latex = ''
    try {
      const ast = buildMathAst({
        glyphs: runGlyphs,
        vectorLines: options.vectorLines ?? [],
        region: [
          node.pointBbox[0],
          node.pointBbox[1],
          node.pointBbox[2],
          node.pointBbox[3],
        ],
        bodyFontSize: options.bodyFontSize,
      })
      latex = serializeMathAstToLatex(ast)
    } catch {
      latex = ''
    }
    if (!latex.trim()) latex = normalizeMathSymbols(run.text)
    // 花括号不配平（如跨行被切开的表达式）→ 保留原文，绝不输出编译不过的 LaTeX
    if (!hasBalancedBraces(latex)) {
      parts.push(normalizeMathSymbols(run.text))
    } else {
      parts.push(`$${latex}$`)
    }
    cursor = run.end
  }
  if (cursor < chars.length) parts.push(chars.slice(cursor).join(''))

  // 重建后统一压缩空白（原始字形流含 PDF 里的任意空格），$...$ 内部不受影响
  node.text = parts.join('').replace(/\s+/g, ' ').trim()
}

/**
 * 对单页节点执行学术增强（就地修改并返回同一数组）。
 */
export function enrichAcademicNodes(nodes: LayoutNode[], options: AcademicEnrichOptions): LayoutNode[] {
  const bodyFontSize = options.bodyFontSize && options.bodyFontSize > 0
    ? options.bodyFontSize
    : inferBodyFontSize(nodes)
  const vectorLines = options.vectorLines ?? []
  const lineHeight =
    options.lineHeight && options.lineHeight > 0
      ? options.lineHeight
      : nodes.length > 0
        ? Math.max(0.005, nodes.reduce((acc, node) => acc + (node.bbox[3] - node.bbox[1]), 0) / nodes.length)
        : 0.03
  const pageWidth = options.pageWidth ?? 1
  const pageHeight = options.pageHeight ?? 1
  let footnoteOrdinal = 0

  for (const node of nodes) {
    const y0 = node.bbox[1]

    // 页眉 / 页脚：只有经过 isGenuine 三重校验才脱离主正文阅读流
    if (isGenuineHeader(node)) {
      node.kind = 'header'
      node.readingStreamId = -1
      continue
    }
    if (isGenuineFooter(node)) {
      node.kind = 'footer'
      node.readingStreamId = -1
      continue
    }

    // 脚注：接近页底 + 明显小字号
    const isSmallFont = bodyFontSize > 0
      && node.fontSize !== undefined
      && node.fontSize < bodyFontSize * FOOTNOTE_FONT_RATIO
    if (y0 >= FOOTNOTE_Y_MIN && isSmallFont) {
      footnoteOrdinal += 1
      const leadingNumber = /^\s*(\d+)[).、\s]/.exec(node.text)?.[1]
      node.kind = 'footnote'
      node.footnoteRef = `fn-${options.pageNumber}-${leadingNumber ?? footnoteOrdinal}`
      continue
    }

    // 行间公式
    if (node.kind !== 'table' && looksLikeEquation(node, vectorLines)) {
      const rawText = node.text.trim()
      const tag = EQUATION_TAG_PATTERN.exec(rawText)?.[1]
      const equation = buildEquationNode(node, {
        tag,
        pageNumber: options.pageNumber,
        bodyFontSize,
        vectorLines,
        lineHeight,
        nativeMathTags: options.nativeMathTags,
      })
      node.kind = 'equation'
      node.equation = equation
      node.confidence = Math.min(node.confidence, 0.6)
      continue
    }

    // 行内公式：仅对正文段落 / 列表项做（标题与表格不动，避免污染锚点文本）
    if (node.kind === 'paragraph' || node.kind === 'list-item') {
      annotateInlineMath(node, { bodyFontSize, vectorLines, pageWidth, pageHeight })
    }

    // 标题级别
    if (node.kind === 'section-heading') {
      node.headingLevel = inferHeadingLevel(node.text)
    } else if (node.kind === 'title') {
      node.headingLevel = 1
    }
  }

  return nodes
}

interface EquationBuildContext {
  tag?: string
  pageNumber: number
  bodyFontSize: number
  vectorLines: readonly VectorLine[]
  lineHeight: number
  nativeMathTags?: readonly NativeMathTag[]
}

/**
 * 构建行间公式结构：原生 MathML 命中则优先，否则走几何二维 Math AST 逆求。
 * 两条路径都失败时如实回退为符号归一化文本，绝不伪造 LaTeX。
 */
function buildEquationNode(node: LayoutNode, ctx: EquationBuildContext): LayoutEquation {
  const rawText = node.text.trim()
  const latexFromText = ctx.tag ? rawText.replace(EQUATION_TAG_PATTERN, '').trim() : rawText
  const equation: LayoutEquation = {
    equationId: `eq-p${ctx.pageNumber}-${node.id}`,
    latex: latexFromText,
    bbox: node.bbox as NormalizedBBox,
    source: 'geometric',
    complexity: 'simple',
  }
  if (ctx.tag) equation.tag = ctx.tag

  // 1) 原生 MathML/TeX 关联标签（加分项）
  const native = resolveNativeMathTag(ctx.nativeMathTags, ctx.pageNumber)
  if (native) {
    const latex = native.format === 'mathml'
      ? mathmlToLatex(native.content)
      : normalizeMathSymbols(native.content)
    if (latex && latex.trim()) {
      equation.latex = latex
      equation.source = 'native'
      return equation
    }
  }

  // 2) 几何二维 Math AST 逆求（主力）
  const glyphs = node.glyphs ?? []
  if (glyphs.length > 0) {
    try {
      const ast = buildMathAst({
        glyphs,
        vectorLines: ctx.vectorLines,
        region: node.pointBbox,
        bodyFontSize: ctx.bodyFontSize,
      })
      const latex = serializeMathAstToLatex(ast)
      if (latex.trim()) {
        equation.latex = latex
        equation.mathAst = ast
      }
    } catch {
      // 几何逆求失败：保留符号归一化文本
    }
    if (!equation.mathAst) {
      equation.latex = normalizeMathSymbols(latexFromText)
    }
    const height = node.bbox[3] - node.bbox[1]
    const barCount = ctx.vectorLines.filter(
      (line) =>
        line.isHorizontal &&
        line.x1 >= node.pointBbox[0] &&
        line.x0 <= node.pointBbox[2] &&
        (line.y0 + line.y1) / 2 >= node.pointBbox[1] &&
        (line.y0 + line.y1) / 2 <= node.pointBbox[3],
    ).length
    const hasGrid = equation.mathAst?.type === 'matrix' || equation.mathAst?.type === 'cases'
    equation.complexity = rateFormulaComplexity({
      height,
      lineHeight: ctx.lineHeight,
      barCount,
      hasGrid,
      threshold: 2.5,
    })
    return equation
  }

  equation.latex = normalizeMathSymbols(latexFromText)
  return equation
}

/** 按页码取首个可用的原生数学标签（扫描无法精确定位时按页兜底） */
function resolveNativeMathTag(
  tags: readonly NativeMathTag[] | undefined,
  pageNumber: number,
): NativeMathTag | undefined {
  if (!tags || tags.length === 0) return undefined
  return tags.find((tag) => tag.pageNumber === pageNumber) ?? tags.find((tag) => tag.pageNumber === undefined)
}
