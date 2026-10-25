/**
 * 编辑距离与模糊文本定位（Bug 15）
 *
 * 论文 AI 评审给出的引用片段常与正文存在标点、空白、全半角差异，
 * 精确 `indexOf` 会「未命中」并静默丢弃建议。
 * 本模块提供两级定位能力：先精确、后模糊，容忍排版噪声。
 */

/** 归一化：折叠空白、统一全半角标点，供模糊比对使用。 */
function foldForMatch(value: string): string {
  return value
    .replace(/[\s　]+/g, '')
    .replace(/[“”„‟＂]/g, '"')
    .replace(/[‘’＇]/g, "'")
    .replace(/[，、﹐]/g, ',')
    .replace(/[。．｡]/g, '.')
    .replace(/[：﹕]/g, ':')
    .replace(/[；﹔]/g, ';')
    .replace(/[！︗]/g, '!')
    .replace(/[？︖]/g, '?')
    .replace(/[（【〔]/g, '(')
    .replace(/[）】〕]/g, ')')
    .toLowerCase()
}

/** 标准 Levenshtein 编辑距离（双数组滚动，O(m·n) 时间 / O(min(m,n)) 空间）。 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  // 保证 b 是较短串，滚动数组只占 O(min) 空间。
  let prev = a
  let next = b
  if (prev.length < next.length) {
    const tmp = prev
    prev = next
    next = tmp
  }

  let previousRow = new Uint32Array(next.length + 1)
  let currentRow = new Uint32Array(next.length + 1)
  for (let j = 0; j <= next.length; j += 1) previousRow[j] = j

  for (let i = 1; i <= prev.length; i += 1) {
    currentRow[0] = i
    const prevChar = prev.charCodeAt(i - 1)
    for (let j = 1; j <= next.length; j += 1) {
      const cost = prevChar === next.charCodeAt(j - 1) ? 0 : 1
      const del = currentRow[j - 1] ?? 0
      const ins = previousRow[j] ?? 0
      const sub = previousRow[j - 1] ?? 0
      currentRow[j] = Math.min(del + 1, ins + 1, sub + cost)
    }
    const swap = previousRow
    previousRow = currentRow
    currentRow = swap
  }
  return previousRow[next.length] ?? 0
}

export interface FuzzyMatchRange {
  start: number
  end: number
  /** 0~1，越高越接近原文。 */
  score: number
}

/**
 * 字符滑动窗口 + 编辑距离模糊定位。
 *
 * 窗口长度取 `target.length` 并允许 ±windowSlack 浮动；
 * 命中后返回**原文坐标**（未折叠坐标），可直接用于 range 设置。
 * 完全不匹配返回 null，绝不猜测。
 */
export function findFuzzyRange(
  haystack: string,
  target: string,
  options: { maxRatio?: number; windowSlack?: number } = {},
): FuzzyMatchRange | null {
  const maxRatio = options.maxRatio ?? 0.25
  const slack = options.windowSlack ?? Math.max(2, Math.ceil(target.length * 0.2))
  const foldedHay = foldForMatch(haystack)
  const foldedTarget = foldForMatch(target)
  if (!foldedTarget.length || !foldedHay.length) return null

  // 折叠会压缩字符，记录每个折叠位对应的原文位，命中后还原。
  const originIndex = new Array<number>(foldedHay.length + 1)
  {
    let k = 0
    for (let i = 0; i < haystack.length; i += 1) {
      const foldedChar = foldForMatch(haystack[i] ?? '')
      if (!foldedChar.length) continue
      // 折叠单个字符可能展开为多字符（如全角标点），逐个登记同一原文位。
      for (let c = 0; c < foldedChar.length; c += 1) {
        originIndex[k] = i
        k += 1
      }
    }
    originIndex[k] = haystack.length
  }

  const minLen = Math.max(1, foldedTarget.length - slack)
  const maxLen = foldedTarget.length + slack
  let best: { start: number; end: number; distance: number; len: number } | null = null

  for (let len = minLen; len <= maxLen; len += 1) {
    for (let start = 0; start + len <= foldedHay.length; start += 1) {
      const window = foldedHay.slice(start, start + len)
      const distance = levenshtein(window, foldedTarget)
      const denom = Math.max(window.length, foldedTarget.length)
      const ratio = denom === 0 ? 0 : distance / denom
      if (ratio > maxRatio) continue
      if (!best || ratio < best.distance / Math.max(best.len, foldedTarget.length)) {
        best = { start, end: start + len, distance, len }
      }
      // 找到零差异即最优，提前结束。
      if (distance === 0) break
    }
    if (best && best.distance === 0) break
  }

  if (!best) return null
  const startOrigin = originIndex[best.start] ?? 0
  const endOrigin = originIndex[best.end] ?? haystack.length
  const denom = Math.max(best.len, foldedTarget.length)
  return {
    start: startOrigin,
    end: endOrigin,
    score: denom === 0 ? 1 : 1 - best.distance / denom,
  }
}
