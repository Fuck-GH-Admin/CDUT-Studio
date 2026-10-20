/**
 * CSLab 审稿建议 -> ProseMirror 切片计划（主进程 / 渲染进程共用）
 *
 * ProseMirror 的 Inline Mark 不允许跨 Block 边界。因此施加建议前必须：
 * 1. 单块唯一命中 -> 单切片；
 * 2. 跨块命中 -> 按块边界切成多段；
 * 3. 多处歧义 / 无法精确命中 -> 显式失败，由调用方降级为段落批注。
 *
 * 红线：不做模糊替换，不猜测用户意图。
 */

export interface CsLabDocBlock {
  /** 顶层块在 ProseMirror 文档中的起始位置（通常是 pos + 1）。 */
  start: number
  /** 块内可编辑文本（不含块级边界符）。 */
  text: string
  blockType: string
}

export interface CsLabSuggestionSlice {
  from: number
  to: number
  blockType: string
  /** 该切片对应的原文片段。 */
  text: string
}

export type CsLabSuggestionPlan =
  | { ok: true; slices: CsLabSuggestionSlice[]; degraded: false }
  | { ok: true; slices: []; degraded: true; reason: string }
  | { ok: false; slices: []; reason: 'quote-not-found' | 'quote-ambiguous' | 'quote-empty' }

function occurrences(haystack: string, needle: string): number[] {
  const positions: number[] = []
  if (!needle) return positions
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    positions.push(index)
    index = haystack.indexOf(needle, index + 1)
  }
  return positions
}

export function planSuggestionApplication(
  blocks: CsLabDocBlock[],
  quote: string,
): CsLabSuggestionPlan {
  const needle = (quote ?? '').trim()
  if (!needle) return { ok: false, slices: [], reason: 'quote-empty' }

  const singleMatches: CsLabSuggestionSlice[] = []
  for (const block of blocks) {
    for (const offset of occurrences(block.text, needle)) {
      singleMatches.push({
        from: block.start + offset,
        to: block.start + offset + needle.length,
        blockType: block.blockType,
        text: needle,
      })
    }
  }
  if (singleMatches.length === 1) {
    return { ok: true, slices: singleMatches, degraded: false }
  }
  if (singleMatches.length > 1) {
    return { ok: false, slices: [], reason: 'quote-ambiguous' }
  }

  // 跨块：尝试相邻块拼接（quote 中可能包含换行或空白）。
  const normalized = needle.replace(/\s+/g, ' ').trim()
  for (let blockIndex = 0; blockIndex < blocks.length - 1; blockIndex += 1) {
    const left = blocks[blockIndex]
    const right = blocks[blockIndex + 1]
    if (!left || !right) continue
    const leftText = left.text.replace(/\s+/g, ' ').trimEnd()
    const rightText = right.text.replace(/\s+/g, ' ').trimStart()
    for (let split = 1; split < normalized.length; split += 1) {
      const head = normalized.slice(0, split)
      const tail = normalized.slice(split)
      if (!leftText.endsWith(head) || !rightText.startsWith(tail)) continue
      const headOffset = left.text.lastIndexOf(head)
      const tailOffset = right.text.indexOf(tail)
      if (headOffset < 0 || tailOffset < 0) continue
      return {
        ok: true,
        slices: [
          {
            from: left.start + headOffset,
            to: left.start + left.text.length,
            blockType: left.blockType,
            text: head,
          },
          {
            from: right.start,
            to: right.start + tailOffset + tail.length,
            blockType: right.blockType,
            text: tail,
          },
        ],
        degraded: false,
      }
    }
  }

  return { ok: false, slices: [], reason: 'quote-not-found' }
}

export function describeSuggestionPlanFailure(plan: CsLabSuggestionPlan): string {
  if (plan.ok) return ''
  switch (plan.reason) {
    case 'quote-empty':
      return '建议缺少原文片段'
    case 'quote-ambiguous':
      return '原文片段在文档中出现多次，已跳过以避免误改'
    default:
      return '原文片段未在单段内精确命中；请人工确认或改为段落批注'
  }
}
