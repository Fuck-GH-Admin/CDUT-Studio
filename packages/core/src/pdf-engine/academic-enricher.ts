/**
 * 学术论文特征增强（AcademicEnricher）
 *
 * 在对齐 + 路由之后，对节点做学术论文专属的语义校正：
 * 1. 独立行间公式：居中排版 + 含数学符号 + 右侧编号 → kind 'equation'，包裹 LaTeX；
 * 2. 页眉/页脚分离：Y ≤ 0.06 / Y ≥ 0.94 打上 readingStreamId = -1，不进入主正文流；
 * 3. 脚注关联：接近页底且字号明显小于正文 → kind 'footnote'，抽取上标编号作为 anchor；
 * 4. 标题级别：按编号点分层级（3.1 → level 3）。
 */

import type { LayoutEquation, NormalizedBBox } from '@profer/shared'
import type { LayoutNode } from './types'

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

export interface AcademicEnrichOptions {
  /** 正文字号（点），缺省则由节点字号中位数推断 */
  bodyFontSize?: number
  pageWidth?: number
  pageHeight?: number
  /** 该节点集合所属页码 */
  pageNumber: number
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

/** 判断行间公式：居中 + 含数学符号（或带编号且短） */
function looksLikeEquation(node: LayoutNode): boolean {
  const text = node.text.trim()
  if (text.length === 0 || text.length > 200) return false
  const centerX = (node.bbox[0] + node.bbox[2]) / 2
  const centered = Math.abs(centerX - 0.5) <= 0.12
  const hasTag = EQUATION_TAG_PATTERN.test(text)
  const hasMath = MATH_SYMBOL_PATTERN.test(text)
  if (hasMath && (centered || hasTag)) return true
  return hasTag && centered && text.length <= 60
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

/**
 * 对单页节点执行学术增强（就地修改并返回同一数组）。
 */
export function enrichAcademicNodes(nodes: LayoutNode[], options: AcademicEnrichOptions): LayoutNode[] {
  const bodyFontSize = options.bodyFontSize && options.bodyFontSize > 0
    ? options.bodyFontSize
    : inferBodyFontSize(nodes)
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
    if (node.kind !== 'table' && looksLikeEquation(node)) {
      const rawText = node.text.trim()
      const tag = EQUATION_TAG_PATTERN.exec(rawText)?.[1]
      const latex = tag ? rawText.replace(EQUATION_TAG_PATTERN, '').trim() : rawText
      const equation: LayoutEquation = {
        equationId: `eq-p${options.pageNumber}-${node.id}`,
        latex,
        bbox: node.bbox as NormalizedBBox,
      }
      if (tag) equation.tag = tag
      node.kind = 'equation'
      node.equation = equation
      node.confidence = Math.min(node.confidence, 0.6)
      continue
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
