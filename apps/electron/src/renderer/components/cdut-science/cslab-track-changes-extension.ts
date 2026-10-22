/**
 * CSLab Track Changes（TipTap / ProseMirror）
 *
 * 架构抉择（对齐研报）：
 * - 用 **Marks** 记录修订，保留连续文本流，可序列化、可导出 Word；
 * - 块级删除/更新用 **Node Attributes**，避免破坏表格/段落 AST；
 * - 接受/拒绝全部在单事务内完成，保持 Undo/Redo 干净；
 * - 施加 AI 建议前用 shared 的 planSuggestionApplication 按块切片，
 *   绝不跨 Block 加 Inline Mark。
 */

import { Extension, Mark, mergeAttributes } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
  describeSuggestionPlanFailure,
  planSuggestionApplication,
  type CsLabDocBlock,
  type CsLabSuggestionPersona,
} from '@profer/shared'

export interface CsLabPersonaMeta {
  title: string
  color: string
  background: string
  border: string
}

export const CSLAB_PERSONA_META: Record<CsLabSuggestionPersona, CsLabPersonaMeta> = {
  human: {
    title: '人工审阅',
    color: 'hsl(var(--cslab-text))',
    background: 'hsl(var(--cslab-text) / 0.05)',
    border: 'hsl(var(--cslab-text) / 0.18)',
  },
  Methodology_Reviewer: {
    title: '方法论审稿人',
    color: 'hsl(var(--cslab-accent))',
    background: 'hsl(var(--cslab-accent) / 0.08)',
    border: 'hsl(var(--cslab-accent) / 0.42)',
  },
  Data_Analyst: {
    title: '数据可靠性',
    color: '#4F7A66',
    background: 'rgba(79,122,102,0.08)',
    border: 'rgba(79,122,102,0.40)',
  },
  Literature_Expert: {
    title: '文献专家',
    color: '#4C6180',
    background: 'rgba(76,97,128,0.08)',
    border: 'rgba(76,97,128,0.40)',
  },
  Grammar_Check: {
    title: '学术润色',
    color: '#8A7A5C',
    background: 'rgba(138,122,92,0.09)',
    border: 'rgba(138,122,92,0.42)',
  },
}

export const CSLAB_REVIEWER_PERSONAS: Array<Exclude<CsLabSuggestionPersona, 'human'>> = [
  'Methodology_Reviewer',
  'Data_Analyst',
  'Literature_Expert',
  'Grammar_Check',
]

interface TrackMarkAttrs {
  suggestionId: string | null
  authorId: string | null
  authorName: string | null
  personaType: CsLabSuggestionPersona
  createdAt: number | null
  commentText: string | null
}

function trackMarkAttributes(): Record<string, unknown> {
  return {
    suggestionId: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-suggestion-id'),
      renderHTML: (attributes: Record<string, unknown>) =>
        attributes.suggestionId ? { 'data-suggestion-id': attributes.suggestionId } : {},
    },
    authorId: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-author-id'),
      renderHTML: (attributes: Record<string, unknown>) =>
        attributes.authorId ? { 'data-author-id': attributes.authorId } : {},
    },
    authorName: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-author-name'),
      renderHTML: (attributes: Record<string, unknown>) =>
        attributes.authorName ? { 'data-author-name': attributes.authorName } : {},
    },
    personaType: {
      default: 'human' as CsLabSuggestionPersona,
      parseHTML: (element: HTMLElement) =>
        element.getAttribute('data-persona-type') ?? 'human',
      renderHTML: (attributes: Record<string, unknown>) => ({
        'data-persona-type': attributes.personaType,
      }),
    },
    createdAt: {
      default: null,
      parseHTML: (element: HTMLElement) => {
        const raw = element.getAttribute('data-created-at')
        return raw ? Number(raw) : null
      },
      renderHTML: (attributes: Record<string, unknown>) =>
        attributes.createdAt ? { 'data-created-at': String(attributes.createdAt) } : {},
    },
  }
}

export const InsertionMark = Mark.create({
  name: 'insertion',
  inclusive: false,
  addAttributes() {
    return trackMarkAttributes()
  },
  parseHTML() {
    return [{ tag: 'ins[data-suggestion-id]' }, { tag: 'ins' }]
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'ins',
      mergeAttributes(HTMLAttributes, {
        style:
          'text-decoration: underline; text-decoration-color: hsl(var(--cslab-accent)); text-underline-offset: 2px; background: hsl(var(--cslab-accent) / 0.06);',
      }),
      0,
    ]
  },
})

export const DeletionMark = Mark.create({
  name: 'deletion',
  inclusive: false,
  addAttributes() {
    return trackMarkAttributes()
  },
  parseHTML() {
    return [{ tag: 'del[data-suggestion-id]' }, { tag: 'del' }]
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'del',
      mergeAttributes(HTMLAttributes, {
        style: 'text-decoration: line-through; color: hsl(var(--cslab-muted)); opacity: 0.85;',
      }),
      0,
    ]
  },
})

export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  addAttributes() {
    return {
      ...trackMarkAttributes(),
      commentText: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-comment-text'),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.commentText ? { 'data-comment-text': attributes.commentText } : {},
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-comment-text]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        style:
          'background: hsl(var(--cslab-accent) / 0.10); border-bottom: 1px dashed hsl(var(--cslab-accent) / 0.65); padding-bottom: 1px;',
      }),
      0,
    ]
  },
})

/** 块级修订：给所有块节点挂 suggestion 属性（不破坏 AST）。 */
export const TrackChangeBlockAttributes = Extension.create({
  name: 'trackChangeBlockAttributes',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow', 'tableCell'],
        attributes: {
          suggestionId: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-suggestion-id'),
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.suggestionId ? { 'data-suggestion-id': attributes.suggestionId } : {},
          },
          suggestionType: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-suggestion-type'),
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.suggestionType ? { 'data-suggestion-type': attributes.suggestionType } : {},
          },
          suggestionAuthor: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-suggestion-author'),
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.suggestionAuthor
                ? { 'data-suggestion-author': attributes.suggestionAuthor }
                : {},
          },
          suggestionPersona: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-suggestion-persona'),
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.suggestionPersona
                ? { 'data-suggestion-persona': attributes.suggestionPersona }
                : {},
          },
        },
      },
    ]
  },
})

// ===== 建议收集 =====

export type CsLabCollectedKind = 'insertion' | 'deletion' | 'comment' | 'block'

export interface CsLabCollectedSuggestion {
  id: string
  kind: CsLabCollectedKind
  persona: CsLabSuggestionPersona
  authorName: string
  from: number
  to: number
  quote: string
  comment?: string
  blockType?: string
  suggestionType?: string
}

interface RangeAccumulator {
  id: string
  kind: CsLabCollectedKind
  persona: CsLabSuggestionPersona
  authorName: string
  from: number
  to: number
  quote: string
  comment?: string
}

export function collectSuggestions(editor: Editor | null): CsLabCollectedSuggestion[] {
  if (!editor) return []
  const doc = editor.state.doc
  const ranges = new Map<string, RangeAccumulator>()
  const blocks: CsLabCollectedSuggestion[] = []

  doc.descendants((node, pos) => {
    if (node.isText) {
      for (const mark of node.marks) {
        if (mark.type.name !== 'insertion' && mark.type.name !== 'deletion' && mark.type.name !== 'comment') {
          continue
        }
        const id = String(mark.attrs.suggestionId ?? '')
        if (!id) continue
        const key = `${mark.type.name}:${id}`
        const existing = ranges.get(key)
        if (existing && existing.to === pos) {
          existing.to = pos + node.nodeSize
          existing.quote += node.text ?? ''
        } else {
          ranges.set(key, {
            id,
            kind: mark.type.name as CsLabCollectedKind,
            persona: (mark.attrs.personaType ?? 'human') as CsLabSuggestionPersona,
            authorName: String(mark.attrs.authorName ?? mark.attrs.authorId ?? 'CDUT Science'),
            from: pos,
            to: pos + node.nodeSize,
            quote: node.text ?? '',
            comment: mark.attrs.commentText ? String(mark.attrs.commentText) : undefined,
          })
        }
      }
      return
    }

    const suggestionId = node.attrs?.suggestionId
    if (suggestionId) {
      blocks.push({
        id: String(suggestionId),
        kind: 'block',
        persona: (node.attrs?.suggestionPersona ?? 'human') as CsLabSuggestionPersona,
        authorName: String(node.attrs?.suggestionAuthor ?? 'CDUT Science'),
        from: pos,
        to: pos + node.nodeSize,
        quote: node.textContent,
        blockType: node.type.name,
        suggestionType: node.attrs?.suggestionType ? String(node.attrs.suggestionType) : undefined,
      })
    }
  })

  return [...ranges.values(), ...blocks].sort((left, right) => left.from - right.from)
}

// ===== 文档块（供切片计划） =====

export function collectDocBlocks(doc: ProseMirrorNode): CsLabDocBlock[] {
  const blocks: CsLabDocBlock[] = []
  doc.forEach((node, offset) => {
    // 含行内原子节点（胶囊/图片）的块位置与纯文本偏移不一致，直接排除以保证不误改。
    const hasAtom = node.content.content.some((child) => !child.isText)
    if (hasAtom) return
    blocks.push({
      start: offset + 1,
      text: node.textContent,
      blockType: node.type.name,
    })
  })
  return blocks
}

// ===== 命令 =====

export interface ApplyReviewResult {
  applied: number
  skipped: number
  messages: string[]
}

export interface CsLabReviewCommandInput {
  kind: 'replace' | 'delete' | 'comment'
  quote: string
  replacement?: string
  comment?: string
  persona: CsLabSuggestionPersona
  authorName?: string
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    cslabTrackChanges: {
      acceptSuggestion: (suggestionId: string) => ReturnType
      rejectSuggestion: (suggestionId: string) => ReturnType
      acceptAllSuggestions: () => ReturnType
      rejectAllSuggestions: () => ReturnType
      applyReviewSuggestions: (suggestions: CsLabReviewCommandInput[]) => ReturnType
      clearAllSuggestions: () => ReturnType
    }
  }
}

function markAttrs(
  suggestionId: string,
  persona: CsLabSuggestionPersona,
  authorName: string,
  commentText?: string,
): TrackMarkAttrs {
  return {
    suggestionId,
    authorId: authorName,
    authorName,
    personaType: persona,
    createdAt: Date.now(),
    commentText: commentText ?? null,
  }
}

export const CsLabTrackChanges = Extension.create({
  name: 'cslabTrackChanges',

  addCommands() {
    return {
      acceptSuggestion:
        (suggestionId: string) =>
        ({ tr, state, dispatch }) => {
          if (!dispatch) return true
          const insertion = state.schema.marks.insertion
          const deletion = state.schema.marks.deletion
          const comment = state.schema.marks.comment
          const deletionRanges: Array<{ from: number; to: number }> = []
          const blockDeletes: Array<{ pos: number }> = []

          state.doc.descendants((node, pos) => {
            if (node.isText) {
              for (const mark of node.marks) {
                if (String(mark.attrs.suggestionId ?? '') !== suggestionId) continue
                if (mark.type === deletion) {
                  deletionRanges.push({ from: pos, to: pos + node.nodeSize })
                } else if (mark.type === insertion && insertion) {
                  tr.removeMark(pos, pos + node.nodeSize, insertion)
                } else if (mark.type === comment && comment) {
                  tr.removeMark(pos, pos + node.nodeSize, comment)
                }
              }
              return
            }
            if (String(node.attrs?.suggestionId ?? '') === suggestionId) {
              if (node.attrs?.suggestionType === 'delete') blockDeletes.push({ pos })
              else {
                tr.setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  suggestionId: null,
                  suggestionType: null,
                  suggestionAuthor: null,
                  suggestionPersona: null,
                })
              }
            }
          })

          // 接受删除 = 真正删掉文本；文本与整块删除统一按位置逆序执行，避免坐标漂移。
          const removals: Array<{ from: number; to: number }> = [...deletionRanges]
          for (const block of blockDeletes) {
            const node = state.doc.nodeAt(block.pos)
            if (node) removals.push({ from: block.pos, to: block.pos + node.nodeSize })
          }
          for (const range of removals.sort((a, b) => b.from - a.from)) {
            tr.delete(range.from, range.to)
          }
          tr.setMeta('addToHistory', true)
          return true
        },

      rejectSuggestion:
        (suggestionId: string) =>
        ({ tr, state, dispatch }) => {
          if (!dispatch) return true
          const insertion = state.schema.marks.insertion
          const deletion = state.schema.marks.deletion
          const comment = state.schema.marks.comment
          const deletions: Array<{ from: number; to: number }> = []
          const clearBlocks: number[] = []

          state.doc.descendants((node, pos) => {
            if (node.isText) {
              for (const mark of node.marks) {
                if (String(mark.attrs.suggestionId ?? '') !== suggestionId) continue
                if (mark.type === insertion) deletions.push({ from: pos, to: pos + node.nodeSize })
                else if (mark.type === deletion || mark.type === comment) {
                  tr.removeMark(pos, pos + node.nodeSize, mark.type)
                }
              }
              return
            }
            if (String(node.attrs?.suggestionId ?? '') === suggestionId) clearBlocks.push(pos)
          })

          // 先清理块级建议（不改变文档长度），再逆序删除插入文本。
          for (const pos of clearBlocks) {
            const node = state.doc.nodeAt(pos)
            if (!node) continue
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              suggestionId: null,
              suggestionType: null,
              suggestionAuthor: null,
              suggestionPersona: null,
            })
          }
          for (const range of deletions.sort((a, b) => b.from - a.from)) {
            tr.delete(range.from, range.to)
          }
          tr.setMeta('addToHistory', true)
          return true
        },

      acceptAllSuggestions:
        () =>
        ({ tr, state, dispatch }) => {
          if (!dispatch) return true
          const insertion = state.schema.marks.insertion
          const deletion = state.schema.marks.deletion
          const comment = state.schema.marks.comment
          const deletionRanges: Array<{ from: number; to: number }> = []
          const blockDeletes: number[] = []

          state.doc.descendants((node, pos) => {
            if (node.isText) {
              for (const mark of node.marks) {
                if (mark.type === deletion) deletionRanges.push({ from: pos, to: pos + node.nodeSize })
                else if (mark.type === insertion && insertion) tr.removeMark(pos, pos + node.nodeSize, insertion)
                else if (mark.type === comment && comment) tr.removeMark(pos, pos + node.nodeSize, comment)
              }
              return
            }
            if (node.attrs?.suggestionId && node.attrs?.suggestionType === 'delete') blockDeletes.push(pos)
          })

          const removals: Array<{ from: number; to: number }> = [...deletionRanges]
          for (const pos of blockDeletes) {
            const node = state.doc.nodeAt(pos)
            if (node) removals.push({ from: pos, to: pos + node.nodeSize })
          }
          for (const range of removals.sort((a, b) => b.from - a.from)) tr.delete(range.from, range.to)
          tr.setMeta('addToHistory', true)
          return true
        },

      rejectAllSuggestions:
        () =>
        ({ tr, state, dispatch }) => {
          if (!dispatch) return true
          const insertion = state.schema.marks.insertion
          const deletion = state.schema.marks.deletion
          const comment = state.schema.marks.comment
          const insertionRanges: Array<{ from: number; to: number }> = []
          const clearBlocks: number[] = []

          state.doc.descendants((node, pos) => {
            if (node.isText) {
              for (const mark of node.marks) {
                if (mark.type === insertion) insertionRanges.push({ from: pos, to: pos + node.nodeSize })
                else if ((mark.type === deletion || mark.type === comment) && mark.type) {
                  tr.removeMark(pos, pos + node.nodeSize, mark.type)
                }
              }
              return
            }
            if (node.attrs?.suggestionId) clearBlocks.push(pos)
          })

          // 先清理块级属性（不改长度），再逆序删除插入文本。
          for (const pos of clearBlocks) {
            const node = state.doc.nodeAt(pos)
            if (!node) continue
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              suggestionId: null,
              suggestionType: null,
              suggestionAuthor: null,
              suggestionPersona: null,
            })
          }
          for (const range of insertionRanges.sort((a, b) => b.from - a.from)) tr.delete(range.from, range.to)
          tr.setMeta('addToHistory', true)
          return true
        },

      clearAllSuggestions:
        () =>
        ({ tr, state, dispatch }) => {
          if (!dispatch) return true
          const marks = state.schema.marks
          for (const name of ['insertion', 'deletion', 'comment'] as const) {
            const mark = marks[name]
            if (mark) tr.removeMark(0, state.doc.content.size, mark)
          }
          tr.setMeta('addToHistory', true)
          return true
        },

      applyReviewSuggestions:
        (suggestions: CsLabReviewCommandInput[]) =>
        ({ tr, state, dispatch }) => {
          if (!dispatch) return true
          const schemaMarks = state.schema.marks
          const insertion = schemaMarks.insertion
          const deletion = schemaMarks.deletion
          const comment = schemaMarks.comment
          if (!insertion || !deletion || !comment) return false

          const blocks = collectDocBlocks(state.doc)
          let applied = 0

          for (const [index, suggestion] of suggestions.entries()) {
            const plan = planSuggestionApplication(blocks, suggestion.quote)
            if (!plan.ok || plan.degraded) {
              continue
            }
            const suggestionId = `ai-${Date.now().toString(36)}-${index}`
            const persona = suggestion.persona
            const authorName = suggestion.authorName ?? CSLAB_PERSONA_META[persona].title

            if (suggestion.kind === 'comment') {
              for (const slice of plan.slices) {
                tr.addMark(
                  tr.mapping.map(slice.from),
                  tr.mapping.map(slice.to),
                  comment.create(markAttrs(suggestionId, persona, authorName, suggestion.comment ?? '')),
                )
              }
              applied += 1
              continue
            }

            if (suggestion.kind === 'delete') {
              for (const slice of plan.slices) {
                tr.addMark(
                  tr.mapping.map(slice.from),
                  tr.mapping.map(slice.to),
                  deletion.create(markAttrs(suggestionId, persona, authorName)),
                )
              }
              applied += 1
              continue
            }

            // replace：原文划线 + 末段末尾插入新文本（同一 suggestionId）。
            // 前面的 suggestion 可能已插入文本，所有位置必须经 tr.mapping 重映射。
            for (const slice of plan.slices) {
              tr.addMark(
                tr.mapping.map(slice.from),
                tr.mapping.map(slice.to),
                deletion.create(markAttrs(suggestionId, persona, authorName)),
              )
            }
            const replacement = suggestion.replacement?.trim()
            if (replacement) {
              const last = plan.slices[plan.slices.length - 1]
              if (last) {
                const insertAt = tr.mapping.map(last.to)
                tr.insert(
                  insertAt,
                  state.schema.text(
                    replacement,
                    [insertion.create(markAttrs(suggestionId, persona, authorName))],
                  ),
                )
              }
            }
            applied += 1
          }

          tr.setMeta('addToHistory', true)
          return applied > 0
        },
    }
  },
})

/** 「复制审稿指令」兜底路径（无模型渠道时交给外部对话窗口执行）。 */
export function buildReviewerPromptText(persona: Exclude<CsLabSuggestionPersona, 'human'>): string {
  const meta = CSLAB_PERSONA_META[persona]
  return [
    `你是${meta.title}。请审阅我随后粘贴的论文正文，只输出严格 JSON：`,
    '{"suggestions":[{"kind":"replace","quote":"原文逐字片段","replacement":"改写后的文本","comment":"修改理由"}]}',
    '规则：kind 只能是 replace/delete/comment；quote 必须逐字出现在原文且单条不超过 500 字；',
    'replace 必须给 replacement；最多 30 条；没有问题时返回 {"suggestions":[]}；禁止编造文献与数值。',
  ].join('\n')
}

/**
 * 解析外部粘贴的审稿 JSON（与主进程同构的宽松解析，但不调用模型）。
 * 非法条目直接丢弃，返回可施加的建议。
 */
export function parseReviewerJson(
  raw: string,
  persona: Exclude<CsLabSuggestionPersona, 'human'>,
): CsLabReviewCommandInput[] {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '')
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1))
      } catch {
        parsed = null
      }
    }
  }
  const list =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { suggestions?: unknown }).suggestions)
      ? ((parsed as { suggestions: unknown[] }).suggestions)
      : []

  const result: CsLabReviewCommandInput[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const kind = record.kind
    const quote = typeof record.quote === 'string' ? record.quote.trim() : ''
    if ((kind !== 'replace' && kind !== 'delete' && kind !== 'comment') || !quote) continue
    const replacement = typeof record.replacement === 'string' ? record.replacement : undefined
    if (kind === 'replace' && !replacement?.trim()) continue
    result.push({
      kind,
      quote,
      replacement,
      comment: typeof record.comment === 'string' ? record.comment : undefined,
      persona,
    })
    if (result.length >= 40) break
  }
  return result
}

/** 本地确定性规则体检（Grammar_Check 人设，不调用模型）。 */
export function buildLocalGrammarSuggestions(editor: Editor | null): CsLabReviewCommandInput[] {
  if (!editor) return []
  const text = editor.getText({ blockSeparator: '\n' })
  const suggestions: CsLabReviewCommandInput[] = []

  const repeatedChar: Array<{ char: string; reason: string }> = [
    { char: '的', reason: '重复助词「的的」' },
    { char: '了', reason: '重复助词「了了」' },
    { char: '是', reason: '重复判断词「是是」' },
  ]
  for (const item of repeatedChar) {
    const pattern = new RegExp(`${item.char}{2,}`, 'g')
    for (const match of text.matchAll(pattern)) {
      suggestions.push({
        kind: 'replace',
        quote: match[0],
        replacement: item.char,
        comment: item.reason,
        persona: 'Grammar_Check',
      })
    }
  }

  const repeatedPunctuation = ['，', '。', '；', '：', '！', '？']
  for (const punctuation of repeatedPunctuation) {
    const pattern = new RegExp(`${punctuation}{2,}`, 'g')
    for (const match of text.matchAll(pattern)) {
      suggestions.push({
        kind: 'replace',
        quote: match[0],
        replacement: punctuation,
        comment: '重复标点',
        persona: 'Grammar_Check',
      })
    }
  }

  // 超长句：只给段落批注，不擅自改写。
  for (const sentence of text.split(/[。！？\n]/)) {
    const trimmed = sentence.trim()
    if (trimmed.length <= 120) continue
    suggestions.push({
      kind: 'comment',
      quote: trimmed.slice(0, 60),
      comment: `该句约 ${trimmed.length} 字，建议拆分以提升可读性`,
      persona: 'Grammar_Check',
    })
    if (suggestions.length >= 40) break
  }

  return suggestions.slice(0, 40)
}

/** 校验并汇总一次应用结果（渲染层用于 toast）。 */
export function describeApplyResult(
  suggestions: CsLabReviewCommandInput[],
  result: ApplyReviewResult,
): string {
  if (suggestions.length === 0) return '没有可施加的建议'
  return `已施加 ${result.applied} 条，跳过 ${result.skipped} 条${result.messages.length > 0 ? `：${result.messages[0]}` : ''}`
}

export { describeSuggestionPlanFailure }
