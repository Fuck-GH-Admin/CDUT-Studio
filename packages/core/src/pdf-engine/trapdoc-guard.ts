/**
 * TrapDoc 幽灵字符拦截与越界防御门禁
 *
 * 针对 TrapDoc 研究指出的「隐形文本注入」攻击（用不可见/透明/越界字符污染
 * 大模型上下文或偏转指令），在下游消费之前执行 5 项硬性熔断检查。
 *
 * 设计原则：宁可少留，也不放行任何可疑字符；正常可见字符 0 丢失。
 */

import type { PdfGlyphItem } from './types'

/** 不可见 Unicode 字符：零宽、BOM、C0 控制符（保留 \t \n \r） */
const INVISIBLE_CHAR_PATTERN = /[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

/** 过滤阈值（集中管理，便于测试与调参） */
export const TRAPDOC_THRESHOLDS = {
  /** 最小字号/尺寸（pt），小于此值视为零尺寸幽灵字符 */
  minSize: 0.1,
  /** 最小可见透明度，小于等于此值视为全透明 */
  minAlpha: 0.01,
  /** PDF 不可见渲染模式（Tr = 3，既不填充也不描边） */
  invisibleRenderingMode: 3,
} as const

export interface TrapDocFilterOptions {
  /** 页面可视宽度（Points） */
  pageWidth: number
  /** 页面可视高度（Points） */
  pageHeight: number
}

export interface TrapDocFilterResult {
  /** 通过门禁的正常字符图元 */
  glyphs: PdfGlyphItem[]
  /** 被拦截的幽灵字符数量 */
  filteredCount: number
}

/** 判断字符边界是否完全位于页面视口之外（屏幕外幽灵文本） */
function isFullyOutOfViewport(glyph: PdfGlyphItem, pageWidth: number, pageHeight: number): boolean {
  const [x0, y0, x1, y1] = glyph.bbox
  return x1 < 0 || y1 < 0 || x0 > pageWidth || y0 > pageHeight
}

/** 清理字符内的不可见 Unicode；清理后为空则返回 null（该字符整枚丢弃） */
function sanitizeChar(char: string): string | null {
  const cleaned = char.replace(INVISIBLE_CHAR_PATTERN, '')
  return cleaned.length > 0 ? cleaned : null
}

/**
 * 执行 5 项熔断检查并返回通过门禁的字符流。
 *
 * 1. 渲染模式阻断：renderingMode === 3（PDF 标准不可见文字）直接丢弃；
 * 2. 视口越界阻断：字符边界完全落在页面外直接丢弃；
 * 3. 透明度阻断：colorAlpha <= minAlpha 直接丢弃；
 * 4. 零尺寸阻断：fontSize/width/height <= minSize 直接丢弃——但仅对非空白可见字符生效，
 *    合法空格 / 薄空格 / 字距微调字符一律豁免，杜绝排版空白被误杀；
 * 5. 零宽/控制字符过滤：正则清理不可见 Unicode，清理后为空则丢弃。
 */
export function filterGhostGlyphs(
  glyphs: readonly PdfGlyphItem[],
  options: TrapDocFilterOptions,
): TrapDocFilterResult {
  const passed: PdfGlyphItem[] = []
  let filteredCount = 0

  for (const glyph of glyphs) {
    // 1. 不可见渲染模式（PDF 明确定义的 Tr = 3 隐形字符）
    if (glyph.renderingMode === TRAPDOC_THRESHOLDS.invisibleRenderingMode) {
      filteredCount += 1
      continue
    }

    // 2. 视口绝对越界阻断（完全落在页面负坐标或远大于页面宽高）
    if (glyph.isOutOfCanvas || isFullyOutOfViewport(glyph, options.pageWidth, options.pageHeight)) {
      filteredCount += 1
      continue
    }

    // 3. 透明度阻断
    if (glyph.colorAlpha <= TRAPDOC_THRESHOLDS.minAlpha) {
      filteredCount += 1
      continue
    }

    // 4. 零尺寸阻断：【关键修复】仅针对非空白、实质可见的字符！
    // 空格（' '）、薄空格或字距微调字符的 width 经常 < 0.1，绝不能当成恶意 Token 丢弃！
    const isWhitespace = glyph.char.trim().length === 0
    if (!isWhitespace) {
      if (
        glyph.fontSize <= TRAPDOC_THRESHOLDS.minSize
        || glyph.width <= TRAPDOC_THRESHOLDS.minSize
        || glyph.height <= TRAPDOC_THRESHOLDS.minSize
      ) {
        filteredCount += 1
        continue
      }
    }

    // 5. 零宽/控制字符
    const cleaned = sanitizeChar(glyph.char)
    if (cleaned === null) {
      filteredCount += 1
      continue
    }

    // 仅在字符确实被清理时才复制对象，避免无谓分配
    passed.push(cleaned === glyph.char ? glyph : { ...glyph, char: cleaned })
  }

  return { glyphs: passed, filteredCount }
}
