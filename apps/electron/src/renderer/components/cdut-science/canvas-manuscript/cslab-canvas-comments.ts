/**
 * Canvas 原生批注注入与本地确定性体检
 *
 * 插件没有“带内容新增批注”的命令，因此统一走：
 * executeSetRange -> executeSetGroup -> executeSetCommentList -> executeHighlight
 * 批注 id 即 group id，锚点随元素的 groupIds 持久化。
 */

import type Editor from '@hufe921/canvas-editor'
import type { IElement } from '@hufe921/canvas-editor'
import type { IComment } from '@hufe921/canvas-editor-plugin-comment'
import { extractCanvasText, findTextRange } from './cslab-canvas-adapter'
import { personaTitle } from '../cslab-review-personas'
import type { CsLabReviewCommentInput } from './cslab-canvas-types'

export const CSLAB_COMMENT_AUTHOR = 'CDUT Science'
export const CSLAB_COMMENT_HIGHLIGHT = '#FDE7E9'

function formatCommentContent(item: CsLabReviewCommentInput): string {
  const head = `【${item.personaTitle}】`
  const action =
    item.kind === 'delete'
      ? '建议删除'
      : item.replacement
        ? `建议改为：${item.replacement}`
        : '审阅意见'
  const reason = item.comment ? `\n理由：${item.comment}` : ''
  return `${head}${action}${reason}`
}

export function applyReviewComments(
  editor: Editor,
  items: CsLabReviewCommentInput[],
): { applied: number; skipped: number } {
  if (items.length === 0) return { applied: 0, skipped: 0 }

  const comments: IComment[] = [...editor.command.executeGetCommentList()]
  let applied = 0
  let skipped = 0

  for (const item of items) {
    const main = editor.command.getValue().data.main as IElement[]
    const range = findTextRange(main, item.quote)
    if (!range) {
      skipped += 1
      continue
    }
    editor.command.executeSetRange(range.start, range.end)
    const groupId = editor.command.executeSetGroup()
    if (!groupId) {
      skipped += 1
      continue
    }
    comments.push({
      id: groupId,
      content: formatCommentContent(item),
      createdAt: new Date().toISOString(),
      user: CSLAB_COMMENT_AUTHOR,
    })
    editor.command.executeSetCommentList(comments)
    editor.command.executeHighlight(CSLAB_COMMENT_HIGHLIGHT)
    applied += 1
  }

  return { applied, skipped }
}

export function clearAllComments(editor: Editor): number {
  const comments = editor.command.executeGetCommentList()
  for (const comment of comments) {
    editor.command.executeRemoveComment(comment.id)
  }
  return comments.length
}

/** 本地确定性规则体检（不调用模型）。 */
export function buildLocalCanvasSuggestions(main: IElement[]): CsLabReviewCommentInput[] {
  const text = extractCanvasText({ main })
  const suggestions: CsLabReviewCommentInput[] = []
  const seen = new Set<string>()
  const persona = personaTitle('Grammar_Check')

  const push = (item: CsLabReviewCommentInput): void => {
    if (!item.quote || seen.has(item.quote)) return
    seen.add(item.quote)
    suggestions.push(item)
  }

  const repeatedChar: Array<{ char: string; reason: string }> = [
    { char: '的', reason: '重复助词「的的」' },
    { char: '了', reason: '重复助词「了了」' },
    { char: '是', reason: '重复判断词「是是」' },
  ]
  for (const item of repeatedChar) {
    for (const match of text.matchAll(new RegExp(`${item.char}{2,}`, 'g'))) {
      push({
        kind: 'replace',
        quote: match[0],
        replacement: item.char,
        comment: item.reason,
        personaTitle: persona,
      })
    }
  }

  for (const punctuation of ['，', '。', '；', '：', '！', '？']) {
    for (const match of text.matchAll(new RegExp(`${punctuation}{2,}`, 'g'))) {
      push({
        kind: 'replace',
        quote: match[0],
        replacement: punctuation,
        comment: '重复标点',
        personaTitle: persona,
      })
    }
  }

  for (const sentence of text.split(/[。！？\n]/)) {
    const trimmed = sentence.trim()
    if (trimmed.length <= 120) continue
    push({
      kind: 'comment',
      quote: trimmed.slice(0, 60),
      comment: `该句约 ${trimmed.length} 字，建议拆分以提升可读性`,
      personaTitle: persona,
    })
    if (suggestions.length >= 40) break
  }

  return suggestions.slice(0, 40)
}
